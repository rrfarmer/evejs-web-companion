// The paint tool's live preview (cosmetics/structure/components/previewScene.py PreviewPanel /
// PaintPreviewSceneContainer):
//
//   the scene      res:/dx9/scene/universe/c05_cube.red (its nebula behind, its reflection cube reflected; nebulaIntensity
//                  1.25, reflectionIntensity 1.55), the sun along (0.6198, -0.1016, -0.7781), coloured (1, 205/255,
//                  170/255)
//   the model      BuildSOFDNAFromTypeID(type) with modify_dna(mat1 primary, mat2 secondary, mat3 detailing,
//                  isStructure=True): the DNA's materials [None, primary, detailing, secondary] - each area's material 1
//                  the faction's, 2 the primary paint, 3 the detailing, 4 the secondary (hullModel.paintedTypeModel; a
//                  paint's material its paints.fsdbinary materialName, a SOF material - /client-assets/sofMaterials.json)
//   the camera     _fit_model_in_view on a new structure (not on a paint change): the zoom between 1.6 and 10 x the
//                  bounding radius, at 0.3 of the way; SceneContainerBaseNavigation - a drag orbits (0.02 x fov a pixel),
//                  the wheel zooms
//
// Not here: the structure's animation state object (GetAnimationStateObjects' STATE_VULNERABLE_ACTIVE).

import * as THREE from "three";
import { loadDds } from "../three/ddsTexture";
import { paintedTypeModel, type SofMaterial } from "../three/hullModel";

const FOV = 1.0, NEAR = 1, FAR = 400000;
const ZOOM_RANGE = [1.6, 10.0] as const, TRANSITION_ZOOM_DEFAULT = 0.3;
let materialsHeld: Promise<Record<string, SofMaterial> | null> | null = null;
const sofMaterials = () => (materialsHeld ??= fetch("/client-assets/sofMaterials.json").then((r) => (r.ok ? r.json() : null)).catch(() => null));

export class PaintPreviewScene {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera((FOV * 180) / Math.PI, 1, NEAR, FAR);
  private readonly holder = new THREE.Group();
  private readonly resize: ResizeObserver;
  private closed = false;
  private yaw = 1.2 * Math.PI;
  private pitch = Math.PI / 2 - 0.4;
  private distance = 1000;
  private nearest = 10;
  private farthest = 3000;
  private drag: { x: number; y: number } | null = null;
  private wanted = "";
  private shownType: number | null = null;

  private readonly host: HTMLElement;

  // (no parameter property: the page's tests load this through node's type stripping, which has none)
  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x000000);
    // sunDirection is where the light goes: the light stands against it (EVE's z mirrored, as the hangar's sun)
    const sun = new THREE.DirectionalLight(new THREE.Color(1, 205 / 255, 170 / 255), 3);
    sun.position.set(-0.6198, 0.1016, -0.7781).normalize();
    this.scene.add(sun, this.holder);
    void this.loadScene();
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => { this.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      const dx = (e.clientX - this.drag.x) * FOV * 0.02, dy = (e.clientY - this.drag.y) * FOV * 0.02;
      this.drag = { x: e.clientX, y: e.clientY };
      this.yaw -= dx;
      this.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.pitch - dy / 2));
    });
    canvas.addEventListener("pointerup", () => { this.drag = null; });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.distance = Math.max(this.nearest, Math.min(this.farthest, this.distance * Math.pow(1.001, e.deltaY)));
    }, { passive: false });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());
    // a handle for live checks, as the play view's window.__play
    (window as unknown as { __paintPreview?: PaintPreviewScene }).__paintPreview = this;
  }

  private async loadScene(): Promise<void> {
    const info = await fetch("/client-assets/universe-scene/c05_cube").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { maps?: Record<string, string> } | null;
    if (!info?.maps || this.closed) return;
    const halfTurn = new THREE.Euler(0, Math.PI, 0);
    try {
      if (info.maps.nebula) {
        this.scene.background = await loadDds(info.maps.nebula);
        this.scene.backgroundRotation.copy(halfTurn);
        this.scene.backgroundIntensity = 1.25;
      }
      if (info.maps.reflection) {
        const refl = await loadDds(info.maps.reflection);
        if (this.closed) return;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromCubemap(refl as unknown as THREE.CubeTexture).texture;
        pmrem.dispose();
        this.scene.environmentRotation.copy(halfTurn);
        this.scene.environmentIntensity = 1.55;
      }
    } catch { /* a cube this GPU cannot take: the plain black stays */ }
  }

  /** PreviewPanel.update: the type with its paints' materials (primary, secondary, detailing; null for none), the
   * view fitted only for a new type. */
  async show(typeID: number, paints: { primary: string | null; secondary: string | null; detailing: string | null }): Promise<void> {
    const key = `${typeID}:${paints.primary}:${paints.secondary}:${paints.detailing}`;
    if (key === this.wanted) return;
    this.wanted = key;
    const mats = await sofMaterials();
    const m = (name: string | null) => (name ? mats?.[name] ?? null : null);
    // modify_dna(isStructure=True): [None, mat1 (primary), mat3 (detailing), mat2 (secondary)]
    const model = await paintedTypeModel(typeID, [null, m(paints.primary), m(paints.detailing), m(paints.secondary)]).catch(() => null);
    if (!model || this.closed || this.wanted !== key) return;
    const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
    model.position.sub(sphere.center);
    this.holder.clear();
    this.holder.add(model);
    if (this.shownType !== typeID) {
      this.shownType = typeID;
      const rad = sphere.radius;
      this.nearest = ZOOM_RANGE[0] * rad;
      this.farthest = Math.min(ZOOM_RANGE[1] * rad, FAR - 2 * rad);
      this.distance = this.nearest + TRANSITION_ZOOM_DEFAULT * (this.farthest - this.nearest);
      this.camera.near = Math.max(NEAR, rad * 0.01);
      this.camera.far = Math.max(FAR, rad * 20);
      this.camera.updateProjectionMatrix();
    }
  }

  private fit(): void {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    if (this.closed) return;
    this.camera.position.setFromSpherical(new THREE.Spherical(this.distance, this.pitch, -this.yaw));
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  close(): void {
    this.closed = true;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.holder.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
