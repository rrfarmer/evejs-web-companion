import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Colony, ColonyPin } from "../store/types.ts";
import { celestialModel, systemCelestials } from "../three/celestialModel.ts";
import { loadDds } from "../three/ddsTexture.ts";

const NEAR_ORBIT = 1.1;
const FAR_ORBIT = 4;
const FOCUS_ZOOM = 0.15;

export interface PlanetMarkerPosition {
  readonly pinID: number;
  readonly x: number;
  readonly y: number;
}

/** SurfacePoint's polar latitude, reflected into the renderer's right-handed world. */
function surfacePoint(pin: ColonyPin): THREE.Vector3 | null {
  const { latitude, longitude } = pin;
  if (latitude == null || longitude == null) return null;
  return new THREE.Vector3(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), -Math.sin(latitude) * Math.sin(longitude));
}

function releaseGeometry(group: THREE.Object3D): void {
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
  group.clear();
}

/** The secondary, read-only scene used by View in Planet Mode. */
export class PlanetScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.015, 30);
  private readonly controls: OrbitControls;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.7);
  private readonly links = new THREE.Group();
  private readonly resize: ResizeObserver;
  private readonly host: HTMLElement;
  private readonly showMarkers: (positions: readonly PlanetMarkerPosition[]) => void;
  private readonly points = new Map<number, THREE.Vector3>();
  private model: THREE.Object3D | null = null;
  private nebula: THREE.Texture | null = null;
  private disposed = false;

  constructor(host: HTMLElement, showMarkers: (positions: readonly PlanetMarkerPosition[]) => void) {
    this.host = host;
    this.showMarkers = showMarkers;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-label", "Planetary surface");
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.minDistance = NEAR_ORBIT;
    this.controls.maxDistance = FAR_ORBIT;
    this.controls.minPolarAngle = 0.1;
    this.controls.maxPolarAngle = Math.PI - 0.1;
    this.controls.rotateSpeed = 0.5;
    this.camera.position.set(1, .4, 3.75);
    this.controls.update();
    this.controls.addEventListener("change", this.draw);
    this.scene.background = new THREE.Color(0x071018);
    this.scene.add(this.links, this.sun, new THREE.AmbientLight(0x566782, 0.55));
    this.host.appendChild(this.renderer.domElement);
    this.resize = new ResizeObserver(this.size);
    this.resize.observe(this.host);
    this.size();
  }

  async load(colony: Colony): Promise<void> {
    void this.loadNebula(colony.solarSystemID);
    const item = (await systemCelestials(colony.solarSystemID))[String(colony.planetID)] ?? null;
    if (this.disposed) return;
    const model = await celestialModel(colony.planetTypeID, "planet", 1, item, colony.planetID);
    if (!model) throw new Error("The planet's surface could not be loaded.");
    if (this.disposed) { releaseGeometry(model); return; }
    this.model = model;
    this.scene.add(model);
    this.draw();
  }

  private async loadNebula(systemID: number): Promise<void> {
    try {
      const response = await fetch(`/client-assets/scene/${systemID}`);
      if (!response.ok || this.disposed) return;
      const scene = await response.json() as { maps?: { nebula?: string | null } };
      if (!scene.maps?.nebula) return;
      const texture = await loadDds(scene.maps.nebula);
      if (this.disposed) { texture.dispose(); return; }
      this.nebula = texture;
      this.scene.background = texture;
      this.scene.backgroundRotation.y = Math.PI;
      this.draw();
    } catch {
      // The ambient background is cosmetic and can arrive separately from the globe.
    }
  }

  setColony(colony: Colony): void {
    this.points.clear();
    for (const pin of colony.pins) {
      const point = surfacePoint(pin);
      if (point) this.points.set(pin.pinID, point);
    }
    releaseGeometry(this.links);
    for (const link of colony.links) {
      const a = this.points.get(link.endpoint1), b = this.points.get(link.endpoint2);
      if (!a || !b) continue;
      const rotation = new THREE.Quaternion().setFromUnitVectors(a, b);
      const steps = Math.max(8, Math.ceil(a.angleTo(b) * 32));
      const points = [];
      for (let i = 0; i <= steps; i++) {
        points.push(a.clone().applyQuaternion(new THREE.Quaternion().slerp(rotation, i / steps)).multiplyScalar(1.004));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: link.level > 0 ? 0x9bdcea : 0x62a8b9, transparent: true, opacity: 0.95 }),
      );
      this.links.add(line);
    }
    this.draw();
  }

  focus(pin: ColonyPin | undefined): boolean {
    const point = pin && surfacePoint(pin);
    if (!point) return false;
    // PlanetCamera._GetPitch adds a small equator-dependent offset when focusing.
    const orbit = new THREE.Spherical().setFromVector3(point);
    orbit.phi += .12 * (1 - orbit.phi / (Math.PI / 2));
    orbit.radius = THREE.MathUtils.lerp(NEAR_ORBIT, FAR_ORBIT, FOCUS_ZOOM);
    this.camera.position.setFromSpherical(orbit);
    this.controls.update();
    this.draw();
    return true;
  }

  private size = (): void => {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (this.disposed || width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.renderer.setSize(width, height);
    this.draw();
  };

  private draw = (): void => {
    if (this.disposed) return;
    const zoom = THREE.MathUtils.inverseLerp(NEAR_ORBIT, FAR_ORBIT, this.camera.position.length());
    // PlanetCamera.Update opens the field of view at close zoom.
    this.camera.fov = THREE.MathUtils.radToDeg(.9 + .25 * (1 - zoom));
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    // PlanetLayer.UpdateSunDirection keeps the surface lit as the camera orbits.
    this.camera.getWorldDirection(this.sun.position).applyAxisAngle(right, -5 * Math.PI / 4).applyAxisAngle(up, -Math.PI / 4);
    this.renderer.render(this.scene, this.camera);
    const shown: PlanetMarkerPosition[] = [];
    if (this.model) {
      const projected = new THREE.Vector3();
      for (const [pinID, point] of this.points) {
        if (point.dot(this.camera.position) <= 1) continue;
        projected.copy(point).multiplyScalar(1.006).project(this.camera);
        if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1) continue;
        shown.push({ pinID, x: (projected.x + 1) * 50, y: (1 - projected.y) * 50 });
      }
    }
    this.showMarkers(shown);
  };

  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    this.controls.dispose();
    releaseGeometry(this.links);
    if (this.model) releaseGeometry(this.model);
    this.nebula?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
