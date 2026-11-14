// The solar system map (shared/mapView/mapViewSolarSystem.py MapViewSolarSystem; systemMapHandler.SystemMapHandler),
// its first part: the window and its own scene over the system the pilot is in.
//
// - The scene: positions times mapViewConst.SOLARSYSTEM_SCALE 1e-10 (ScaleSolarSystemValue) around the sun at the
//   origin; the camera fov 0.7, near 0.1, far 50000, its distance kept within MIN_CAMERA_DISTANCE_SOLARSYSTEMVIEW 0.5 and
//   MAX_CAMERA_DISTANCE_SOLARSYSTEMVIEW 9000; FrameSolarSystem: 1.3 times the distance that fits the system's radius
//   (its farthest celestial) in the view.
// - LoadSolarSystemMap: each planet and moon a sprite (CreatePlanet: zsprite with spotSprite, its scale by distance -
//   here a constant size on screen); an OrbitCircle for a planet round the sun, for a moon round its nearest planet -
//   the circle drawn in the parent's plane and turned so that its -x axis meets the object (QuaternionRotationArc
//   (-1, 0, 0) -> the direction), white at 0.1; the sun its own sprite (CreateSun - its flare not drawn here).
// - ShowMyLocation: the ego marker at the ship.
// Opened by CmdToggleSolarSystemMap (F9) and the directional scanner's map button.
// Not here: the markers and their labels, the bookmarks, the scan panels docked in it, the range indicator, the probe
// handler, the d-scan cone (directionalScanHandler), the top / side view buttons, the nebula and starfield.

import * as THREE from "three";
import { PlayWindow, clientTexture } from "./window.ts";

export const SOLARSYSTEM_SCALE = 1e-10;
const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 9000;
const FOV_RADIANS = 0.7;
const GROUP_SUN = 6;
const GROUP_PLANET = 7;
const GROUP_MOON = 8;
const GROUP_STARGATE = 10;

export interface MapCelestial { readonly itemID: number; readonly groupID: number | null; readonly position: { x: number; y: number; z: number } }

export interface SolarSystemMapHooks {
  /** The system's celestials as the park has them (EVE's own coordinates, metres). */
  celestials(): readonly MapCelestial[];
  /** The ship's position (EVE's coordinates), or null. */
  ego(): { x: number; y: number; z: number } | null;
  word?(label: string): string | null;
}

/** EVE's coordinates to the map's (the space view's handedness: z mirrored), scaled. */
export function mapPoint(p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x * SOLARSYSTEM_SCALE, p.y * SOLARSYSTEM_SCALE, -p.z * SOLARSYSTEM_SCALE);
}

/** OrbitCircle's points: the circle of the object's distance round its parent, turned so that -x meets the object. */
export function orbitPoints(position: THREE.Vector3, parent: THREE.Vector3, segments = 128): THREE.Vector3[] {
  const dir = position.clone().sub(parent);
  const radius = dir.length();
  if (radius <= 0) return [];
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(-1, 0, 0), dir.normalize());
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius).applyQuaternion(rotation).add(parent));
  }
  return points;
}

/** A round dot, drawn once (our own; the client's spotSprite.dds is a soft spot). */
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SolarSystemMapWindow {
  readonly window: PlayWindow;
  private readonly canvas = document.createElement("canvas");
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera((FOV_RADIANS * 180) / Math.PI, 1, 0.1, 50000);
  private readonly root = new THREE.Group();
  private readonly egoMarker: THREE.Sprite;
  private readonly dot = dotTexture();
  private yaw = 0.6;
  private pitch = 0.5;
  private distance = 100;
  private frame = 0;
  private detached = false;
  private builtFor: string | null = null;
  /** The system's radius in the map's units (its farthest celestial). */
  radius = 0;
  /** What was drawn, for checks: planets, moons, orbits. */
  counts = { planets: 0, moons: 0, orbits: 0, stargates: 0 };

  constructor(private readonly hooks: SolarSystemMapHooks, private readonly host: HTMLElement) {
    const caption = hooks.word?.("UI/Map/MapPallet/btnSolarsystemMap") ?? "Solar System Map";
    this.window = new PlayWindow({ id: "solarSystemMap", caption, icon: clientTexture("res:/ui/texture/shared/brackets/solarsystem.png"),
      left: Math.max(16, Math.round(innerWidth / 2 - 450)), top: 60, width: 900, height: 600, minWidth: 400, minHeight: 300, closable: true },
    () => { this.detached = true; this.stop(); });
    this.window.body.classList.add("ssm");
    this.canvas.className = "ssm-canvas";
    this.window.body.appendChild(this.canvas);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.root);
    this.egoMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0x58a7bf, sizeAttenuation: false, depthTest: false }));
    this.egoMarker.scale.setScalar(0.022);
    this.egoMarker.renderOrder = 2;
    this.scene.add(this.egoMarker);
    this.canvas.addEventListener("pointerdown", (e) => this.drag(e));
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.distance * Math.pow(1.0015, e.deltaY)));
    }, { passive: false });
    this.window.root.style.display = "none";
  }

  get isOpen(): boolean { return !this.detached && this.window.root.style.display !== "none"; }
  toggle(): void { if (this.isOpen) this.close(); else this.open(); }
  close(): void { this.window.root.style.display = "none"; this.stop(); }
  open(): void {
    if (this.detached) { this.host.appendChild(this.window.root); this.detached = false; }
    this.window.root.style.display = "";
    this.renderer ??= new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.build();
    this.start();
  }

  /** LoadSolarSystemMap: the sun, planets and moons with their orbits, the gates as dots; then FrameSolarSystem. */
  build(): void {
    const all = this.hooks.celestials();
    const key = all.map((c) => c.itemID).sort((a, b) => a - b).join(",");
    if (key === this.builtFor) return;
    this.builtFor = key;
    this.root.clear();
    this.counts = { planets: 0, moons: 0, orbits: 0, stargates: 0 };
    const sun = all.find((c) => c.groupID === GROUP_SUN);
    const sunAt = sun ? mapPoint(sun.position) : new THREE.Vector3();
    const planets = all.filter((c) => c.groupID === GROUP_PLANET).map((c) => ({ id: c.itemID, at: mapPoint(c.position) }));
    const orbitMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false });
    const sprite = (at: THREE.Vector3, size: number, color: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color, sizeAttenuation: false, depthWrite: false }));
      s.position.copy(at);
      s.scale.setScalar(size);
      this.root.add(s);
    };
    const orbit = (at: THREE.Vector3, parent: THREE.Vector3) => {
      const points = orbitPoints(at, parent);
      if (!points.length) return;
      this.root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitMaterial));
      this.counts.orbits += 1;
    };
    let radius = 0;
    if (sun) sprite(sunAt, 0.03, 0xfff2cc);
    for (const c of all) {
      const at = mapPoint(c.position);
      radius = Math.max(radius, at.distanceTo(sunAt));
      if (c.groupID === GROUP_PLANET) {
        sprite(at, 0.012, 0xffffff);
        orbit(at, sunAt);
        this.counts.planets += 1;
      } else if (c.groupID === GROUP_MOON && planets.length) {
        // childrenToParentByID: a moon's parent its nearest planet
        const parent = planets.reduce((best, p) => (p.at.distanceTo(at) < best.at.distanceTo(at) ? p : best));
        sprite(at, 0.006, 0xbbbbbb);
        orbit(at, parent.at);
        this.counts.moons += 1;
      } else if (c.groupID === GROUP_STARGATE) {
        sprite(at, 0.008, 0x9fd3e8);
        this.counts.stargates += 1;
      }
    }
    this.radius = radius;
    // FrameSolarSystem: GetTranslationFromParentWithRadius - the distance at which the radius fills the view - times 1.3
    const fit = radius / Math.sin(FOV_RADIANS / 2);
    this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, 1.3 * fit));
  }

  private drag(e: PointerEvent): void {
    const x0 = e.clientX, y0 = e.clientY, yaw0 = this.yaw, pitch0 = this.pitch;
    const move = (m: PointerEvent) => {
      this.yaw = yaw0 - (m.clientX - x0) * 0.005;
      this.pitch = Math.min(1.5, Math.max(-1.5, pitch0 + (m.clientY - y0) * 0.005));
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  private start(): void {
    if (this.frame) return;
    const tick = () => { this.frame = requestAnimationFrame(tick); this.render(); };
    this.frame = requestAnimationFrame(tick);
  }
  private stop(): void { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }

  render(): void {
    if (!this.renderer) return;
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const ego = this.hooks.ego();
    this.egoMarker.visible = ego !== null;
    if (ego) this.egoMarker.position.copy(mapPoint(ego));
    const c = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * c * this.distance, Math.sin(this.pitch) * this.distance, Math.cos(this.yaw) * c * this.distance);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  /** The camera's distance from the point of interest, in the map's units. */
  get cameraDistance(): number { return this.distance; }
}
