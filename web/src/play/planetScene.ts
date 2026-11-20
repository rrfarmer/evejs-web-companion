import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EXTRACTOR_HEAD_LIMIT } from "../bridge/extractorSurvey.ts";
import { MIN_INSTALLATION_SPACING, type SurfaceCoordinates } from "../bridge/planetConstruction.ts";
import { linkKey } from "../bridge/planetRouting.ts";
import type { Colony, ColonyLink, ColonyPin, ExtractorHead } from "../store/types.ts";
import { celestialModel, systemCelestials } from "../three/celestialModel.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { createPlanetSurveyLayer } from "./planetSurveyLayer.ts";

const NEAR_ORBIT = 1.1;
const FAR_ORBIT = 4;
const FOCUS_ZOOM = 0.15;

export interface PlanetMarkerPosition {
  readonly pinID: number;
  readonly x: number;
  readonly y: number;
}

export interface ExtractorMarkerPosition {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** SurfacePoint's polar latitude, reflected into the renderer's right-handed world. */
function surfaceVector(latitude: number, longitude: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), -Math.sin(latitude) * Math.sin(longitude));
}

function surfacePoint({ latitude, longitude }: ColonyPin): THREE.Vector3 | null {
  return latitude == null || longitude == null ? null : surfaceVector(latitude, longitude);
}

function headAt(id: number, point: THREE.Vector3): ExtractorHead {
  return [id, Math.acos(THREE.MathUtils.clamp(point.y, -1, 1)),
    THREE.MathUtils.euclideanModulo(Math.atan2(-point.z, point.x), 2 * Math.PI)];
}

function surfaceRing(centre: THREE.Vector3, angle: number, color: number, opacity: number): THREE.LineLoop {
  const normal = Math.abs(centre.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = normal.cross(centre).normalize(), north = centre.clone().cross(east);
  const points = Array.from({ length: 96 }, (_, i) => {
    const bearing = i * Math.PI / 48;
    return centre.clone().multiplyScalar(Math.cos(angle))
      .addScaledVector(east, Math.sin(angle) * Math.cos(bearing))
      .addScaledVector(north, Math.sin(angle) * Math.sin(bearing))
      .multiplyScalar(1.009);
  });
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, opacity, transparent: true, depthWrite: false }));
  ring.renderOrder = 4;
  return ring;
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

function surfaceArc(a: THREE.Vector3, b: THREE.Vector3, radius: number, color: number): THREE.Line {
  const rotation = new THREE.Quaternion().setFromUnitVectors(a, b);
  const steps = Math.max(8, Math.ceil(a.angleTo(b) * 32));
  const points = Array.from({ length: steps + 1 }, (_, index) => a.clone()
    .applyQuaternion(new THREE.Quaternion().slerp(rotation, index / steps)).multiplyScalar(radius));
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: .95 }));
}

/** Secondary scene for colony inspection and survey placement in Planet Mode. */
export class PlanetScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.015, 30);
  private readonly controls: OrbitControls;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.7);
  private readonly links = new THREE.Group();
  private readonly linkPreview = new THREE.Group();
  private readonly placement = new THREE.Group();
  private readonly linkLines = new Map<THREE.Object3D, ColonyLink>();
  private readonly route = new THREE.Group();
  private readonly extraction = new THREE.Group();
  private readonly headPoints = new Map<number, THREE.Vector3>();
  private readonly ray = new THREE.Raycaster();
  private readonly globe = new THREE.Sphere(new THREE.Vector3(), 1);
  private readonly resize: ResizeObserver;
  private readonly host: HTMLElement;
  private readonly showMarkers: (positions: readonly PlanetMarkerPosition[]) => void;
  private readonly points = new Map<number, THREE.Vector3>();
  private model: THREE.Object3D | null = null;
  private nebula: THREE.Texture | null = null;
  private surveyLayer: Awaited<ReturnType<typeof createPlanetSurveyLayer>> | null = null;
  private surveyLoading: Promise<Awaited<ReturnType<typeof createPlanetSurveyLayer>> | null> | null = null;
  private survey: Uint8Array<ArrayBuffer> | null = null;
  private surveyRange: readonly [number, number] = [0, .5];
  private disposed = false;

  constructor(host: HTMLElement, showMarkers: (positions: readonly PlanetMarkerPosition[]) => void,
    private readonly showHeads: (positions: readonly ExtractorMarkerPosition[]) => void) {
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
    this.scene.add(this.links, this.linkPreview, this.placement, this.route, this.extraction, this.sun, new THREE.AmbientLight(0x566782, 0.55));
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

  setColony(colony: Colony, changedLinks: ReadonlySet<string>): void {
    this.points.clear();
    for (const pin of colony.pins) {
      const point = surfacePoint(pin);
      if (point) this.points.set(pin.pinID, point);
    }
    releaseGeometry(this.links);
    this.linkLines.clear();
    for (const link of colony.links) {
      const a = this.points.get(link.endpoint1), b = this.points.get(link.endpoint2);
      if (!a || !b) continue;
      const pending = changedLinks.has(linkKey(link.endpoint1, link.endpoint2));
      const line = surfaceArc(a, b, 1.004, pending ? 0x9df5a4 : link.level > 0 ? 0x9bdcea : 0x62a8b9);
      line.renderOrder = 3;
      this.links.add(line);
      this.linkLines.set(line, link);
    }
    this.draw();
  }

  private pointRay(x: number, y: number): void {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((x - bounds.left) / bounds.width * 2 - 1, 1 - (y - bounds.top) / bounds.height * 2), this.camera);
  }

  surfaceAt(x: number, y: number): SurfaceCoordinates | null {
    this.pointRay(x, y);
    const point = this.ray.ray.intersectSphere(this.globe, new THREE.Vector3());
    if (!point) return null;
    const [, latitude, longitude] = headAt(0, point);
    return { latitude, longitude };
  }

  previewInstallation(point: SurfaceCoordinates | null, valid = true, influence = 0): void {
    releaseGeometry(this.placement);
    if (point) {
      const center = surfaceVector(point.latitude, point.longitude);
      const color = valid ? 0xa9ffac : 0xff7979;
      this.placement.add(surfaceRing(center, MIN_INSTALLATION_SPACING, color, 1));
      if (influence > 0) this.placement.add(surfaceRing(center, influence, color, .55));
    }
    this.draw();
  }

  linkAt(x: number, y: number): ColonyLink | undefined {
    this.pointRay(x, y);
    const surface = this.ray.ray.intersectSphere(this.globe, new THREE.Vector3());
    if (!surface) return undefined;
    const height = this.renderer.domElement.clientHeight;
    const distance = surface.distanceTo(this.camera.position);
    this.ray.params.Line = { threshold: 12 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / height };
    const hit = this.ray.intersectObjects(this.links.children, false)
      .find(candidate => candidate.point.dot(this.camera.position) > 1);
    return hit && this.linkLines.get(hit.object);
  }

  previewLink(source: number | null, x = 0, y = 0, target?: number): { latitude: number; longitude: number } | null {
    releaseGeometry(this.linkPreview);
    const a = source === null ? undefined : this.points.get(source);
    if (!a) { this.draw(); return null; }
    this.pointRay(x, y);
    const b = target === undefined ? this.ray.ray.intersectSphere(this.globe, new THREE.Vector3()) : this.points.get(target);
    if (!b || a.distanceToSquared(b) < 1e-12) { this.draw(); return null; }
    const line = surfaceArc(a, b, 1.012, 0xa9ffac);
    line.renderOrder = 6;
    this.linkPreview.add(line);
    this.draw();
    const [, latitude, longitude] = headAt(0, b);
    return { latitude, longitude };
  }

  setRoutePath(path: readonly number[], preview: boolean): void {
    releaseGeometry(this.route);
    for (let index = 1; index < path.length; index++) {
      const from = this.points.get(path[index - 1]!), to = this.points.get(path[index]!);
      if (!from || !to) continue;
      const line = surfaceArc(from, to, 1.014, preview ? 0x9df5a4 : 0xffd287);
      line.renderOrder = 5;
      this.route.add(line);
    }
    this.draw();
  }

  async showSurvey(chart: Uint8Array<ArrayBuffer> | null): Promise<void> {
    if (this.disposed) return;
    this.survey = chart;
    if (!chart) {
      this.surveyLayer?.setChart(null);
      this.draw();
      return;
    }
    this.surveyLoading ??= createPlanetSurveyLayer().then(layer => {
      if (this.disposed) { layer.dispose(); return null; }
      this.scene.add(layer.mesh);
      this.surveyLayer = layer;
      return layer;
    }).catch(error => {
      this.surveyLoading = null;
      throw error;
    });
    const layer = await this.surveyLoading;
    if (layer && !this.disposed && this.survey === chart) {
      layer.setChart(chart);
      layer.setRange(...this.surveyRange);
      this.draw();
    }
  }

  setSurveyRange(low: number, high: number): void {
    this.surveyRange = [low, high];
    if (this.surveyLayer) {
      this.surveyLayer.setRange(low, high);
      this.draw();
    }
  }

  setExtractor(unit: ColonyPin | null, heads: readonly ExtractorHead[], radius: number, area: number | null): void {
    this.headPoints.clear();
    releaseGeometry(this.extraction);
    const centre = unit && surfacePoint(unit);
    if (centre && area) this.extraction.add(surfaceRing(centre, area * .99, 0x89e6df, .75));
    for (const [id, latitude, longitude] of heads) {
      const point = surfaceVector(latitude, longitude);
      this.headPoints.set(id, point);
      this.extraction.add(surfaceRing(point, radius, 0xf0d088, .9));
    }
    this.draw();
  }

  defaultHead(unit: ColonyPin, id: number, area: number): ExtractorHead | null {
    const centre = surfacePoint(unit);
    if (!centre) return null;
    // SurveyWindow.PlaceProbeAtDefaultPosition spaces slots around the ECU.
    const offset = centre.clone().cross(new THREE.Vector3(-1, 0, 0));
    if (offset.lengthSq() < 1e-10) offset.set(0, 1, 0);
    const distance = Math.min(Math.atan(.08 * offset.length()), area * .99);
    const point = centre.clone().multiplyScalar(Math.cos(distance))
      .addScaledVector(offset.normalize().applyAxisAngle(centre, -id * Math.PI * 2 / EXTRACTOR_HEAD_LIMIT), Math.sin(distance));
    return headAt(id, point);
  }

  moveHead(unit: ColonyPin, id: number, x: number, y: number, area: number): ExtractorHead | null {
    const centre = surfacePoint(unit);
    if (!centre) return null;
    this.pointRay(x, y);
    const point = this.ray.ray.intersectSphere(this.globe, new THREE.Vector3());
    if (!point) return null;
    const limit = area * .99;
    if (centre.angleTo(point) > limit) {
      const direction = point.clone().addScaledVector(centre, -point.dot(centre)).normalize();
      point.copy(centre).multiplyScalar(Math.cos(limit)).addScaledVector(direction, Math.sin(limit));
    }
    return headAt(id, point);
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
    const heads: ExtractorMarkerPosition[] = [];
    if (this.model) {
      const projected = new THREE.Vector3();
      for (const [pinID, point] of this.points) {
        if (point.dot(this.camera.position) <= 1) continue;
        projected.copy(point).multiplyScalar(1.006).project(this.camera);
        if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1) continue;
        shown.push({ pinID, x: (projected.x + 1) * 50, y: (1 - projected.y) * 50 });
      }
      for (const [id, point] of this.headPoints) {
        if (point.dot(this.camera.position) <= 1) continue;
        projected.copy(point).multiplyScalar(1.009).project(this.camera);
        if (Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1) continue;
        heads.push({ id, x: (projected.x + 1) * 50, y: (1 - projected.y) * 50 });
      }
    }
    this.showMarkers(shown);
    this.showHeads(heads);
  };

  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    this.controls.dispose();
    this.surveyLayer?.dispose();
    releaseGeometry(this.links);
    releaseGeometry(this.linkPreview);
    releaseGeometry(this.placement);
    releaseGeometry(this.route);
    releaseGeometry(this.extraction);
    if (this.model) releaseGeometry(this.model);
    this.nebula?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
