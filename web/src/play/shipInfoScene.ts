import * as THREE from "three";
import { loadDds } from "../three/ddsTexture.ts";
import { effectObject, startEffect, type SofChildNode } from "../three/hullChildren.ts";
import { setControllerVariable, setDirtLevel, setThrust, typeModel } from "../three/hullModel.ts";
import { SHIP_INFO_FAR_CLIP, shipInfoZoomRange } from "./shipInfoCamera.ts";

interface PreviewEffect { root: SofChildNode; childEffects: Record<string, SofChildNode | null> }
interface ShipInfoAssets {
  reflections: string | null;
  sunDiffuseColor: number[];
  sunDirection: number[];
  ambientColor: number[];
  background: PreviewEffect;
  lightRig: PreviewEffect;
}

// shipInfoConst.FACTION_BACKGROUND_LOGOS_IDS, in controller order.
const FACTIONS = [500003, 500001, 500002, 500004, 500010, 500016, 500011, 500019, 500012, 500026, 500020,
  500014, 500018, 500027, 500009, 500007, 500029, 500006, 500008, 500017, 500013, 500005];
const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;
let assets: Promise<ShipInfoAssets | null> | null = null;
function getAssets(): Promise<ShipInfoAssets | null> {
  return assets ??= fetch("/client-assets/shipInfoScene.json").then(r => r.ok ? r.json() : null).catch(() => null);
}

/** The 24.02 ship preview's own 3D view. Its scene and effects are extracted from the installed client. */
export class ShipInfoScene {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(deg(0.8), 1, 1, SHIP_INFO_FAR_CLIP);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0);
  private readonly observer: ResizeObserver;
  private readonly ready: Promise<void>;
  private background: THREE.Object3D | null = null;
  private lightRig: THREE.Object3D | null = null;
  private reflection: THREE.WebGLRenderTarget | null = null;
  private model: THREE.Object3D | null = null;
  private serial = 0;
  private closed = false;
  private active = false;
  private expanded = true;
  private axes: [number, number, number] = [1, 1, 1];
  private yaw = 0;
  private pitch = Math.PI / 2;
  private zoom = 1;
  private near = 10;
  private far = 100;
  private radius = 1;
  private arrived = 0;
  private drag: { x: number; y: number } | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.sun, this.ambient);
    this.ready = this.loadScene();
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", event => {
      if (!this.expanded || event.button !== 0) return;
      this.drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      if (!this.drag) return;
      this.orbit((event.clientX - this.drag.x) * -0.016, (event.clientY - this.drag.y) * -0.008);
      this.drag = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("lostpointercapture", () => { this.drag = null; });
    canvas.addEventListener("wheel", event => {
      if (!this.expanded) return;
      event.preventDefault();
      this.moveZoom(Math.sign(event.deltaY) * 0.08);
    }, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
  }

  private async loadScene(): Promise<void> {
    const art = await getAssets();
    if (!art || this.closed) return;
    this.sun.color.fromArray(art.sunDiffuseColor);
    this.sun.position.fromArray(art.sunDirection).multiply(new THREE.Vector3(-1, -1, 1)).normalize();
    this.ambient.color.fromArray(art.ambientColor);
    this.ambient.intensity = 1;
    const [background, lightRig, reflection] = await Promise.all([
      effectObject(art.background.root, art.background.childEffects).catch(() => null),
      effectObject(art.lightRig.root, art.lightRig.childEffects).catch(() => null),
      art.reflections ? loadDds(art.reflections).catch(() => null) : null,
    ]);
    if (this.closed) return;
    this.background = background;
    this.lightRig = lightRig;
    if (background) this.scene.add(background);
    if (reflection) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      try {
        this.reflection = pmrem.fromCubemap(reflection as unknown as THREE.CubeTexture);
        this.scene.environment = this.reflection.texture;
        this.scene.environmentRotation.y = Math.PI;
      } finally { pmrem.dispose(); }
    }
  }

  async show(typeID: number, factionID: number | null): Promise<boolean> {
    const request = ++this.serial;
    const [model] = await Promise.all([typeModel(typeID).catch(() => null), this.ready.catch(() => {})]);
    if (this.closed || request !== this.serial) return false;
    this.removeModel();
    if (!model) return false;
    const data = model.userData as {
      boundingSphere?: number[]; shapeEllipsoid?: { center: number[]; radius: number[] };
      locatorSets?: Record<string, number[][]>;
    };
    setDirtLevel(model, -1.5);
    setThrust(model, 0.7);
    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const origin = data.locatorSets?.camera_look_at?.[0] ?? data.shapeEllipsoid?.center;
    model.position.sub(origin ? new THREE.Vector3(origin[0], origin[1], -origin[2]!) : sphere.center);
    const radius = this.radius = (data.boundingSphere?.[3] || sphere.radius) + 1;
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const axes = data.shapeEllipsoid?.radius;
    this.axes = axes?.length === 3 && axes.every(x => x > 0) ? [axes[0]!, axes[1]!, axes[2]!] : [size.x, size.y, size.z];
    [this.near, this.far] = shipInfoZoomRange(radius, this.axes);
    this.camera.near = Math.max(1, radius * 0.01);
    this.model = model;
    this.scene.add(model);
    if (this.lightRig) {
      model.add(this.lightRig);
      startEffect(this.lightRig);
    }
    if (this.background) {
      const key = factionID === null ? -1 : FACTIONS.indexOf(factionID);
      setControllerVariable(this.background, "Faction", key < 0 ? 99 : key);
      startEffect(this.background);
    }
    this.resetView();
    this.arrived = performance.now();
    return true;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.resetView();
  }

  private resetView(): void {
    // Overview: DOWN_FRONT_LEFT, or TOP_DOWN_NOSE_UP_ALT with tall/wide substitutions below 640px.
    const [x, y, z] = this.axes;
    const tall = y > x && y > z;
    this.pitch = rad(this.expanded ? 65 : tall ? 90 : 0.1);
    this.yaw = rad(this.expanded ? -225 : x >= z || tall ? 270 : 0);
    this.zoom = this.expanded ? 0.3 : 0.1;
  }

  orbit(yaw: number, pitch: number): void {
    this.yaw += yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch, 0.05, Math.PI - 0.05);
  }

  moveZoom(amount: number): void { this.zoom = THREE.MathUtils.clamp(this.zoom + amount, 0, 1); }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.renderer.setAnimationLoop(active && !this.closed ? time => this.frame(time) : null);
  }

  private resize(): void {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private frame(time: number): void {
    if (!this.model || this.closed) return;
    let distance = THREE.MathUtils.lerp(this.near, this.far, this.zoom);
    // In the stacked layout the 3D view occupies part of the short window. Keep the hull inside it.
    if (!this.expanded) {
      const halfAngle = Math.atan(Math.tan(0.4) * Math.min(1, this.camera.aspect));
      distance = Math.max(distance, this.radius / Math.sin(halfAngle * 0.9));
    }
    const fov = 0.8 + 0.3 * Math.exp(-Math.max(0, time - this.arrived) / 330);
    this.camera.fov = deg(fov);
    this.camera.updateProjectionMatrix();
    this.camera.position.setFromSphericalCoords(distance, this.pitch, -this.yaw);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  private removeModel(): void {
    this.lightRig?.removeFromParent();
    this.model?.removeFromParent();
    this.model?.traverse(object => {
      if (object instanceof THREE.Mesh && object.userData.ownMaterial && !Array.isArray(object.material)) object.material.dispose();
    });
    this.model = null;
  }

  close(): void {
    this.closed = true;
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    this.removeModel();
    this.scene.clear();
    this.reflection?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
