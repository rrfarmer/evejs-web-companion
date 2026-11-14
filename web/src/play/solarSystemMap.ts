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
// - LoadMarkers: a MarkerSpaceObject for each celestial of the markers setting's groups (VIEWMODE_MARKERS_OPTIONS_DEFAULT:
//   planet, moon, station, asteroid belt, beacon, cynosural beacon, stargate, sun, citadel, industrial array, drilling
//   platform), the ballpark's first: a 14 x 14 marker, the type's bracket icon (16) at its middle (MarkerIconBase.Load;
//   no background for a space object), on the map point (projectBracket offsetY 0); hovered, the selection circle (30,
//   0.5) and its label (BracketShadowLabel at 26, 2: GetLabelText, the name and FmtDist of its distance).
// - The view buttons (ConstructViewButtonCont: centred at the bottom, 12 up, 46 x 46 icons topView.png at 0 and
//   sideView.png at 45; tooltips ViewFromTop / ViewFromSide with ToggleView - DoubleClickScene): the camera's pitch
//   (solarSystemMapCameraController SetTopView to kMinPitch, SetSideView to pi / 2, over max(0.1, |change| x 0.2) s;
//   ToggleCameraView on a double click: below pi / 4 to the side, else the top). mapCamera's pitch runs kMinPitch 0.01
//   (from straight above) to kMaxPitch pi / 2 (level): never under the system's plane.
//   (The range indicator is the tactical overlay's - solarSystemViewPanel - not this window's.)
// - The directional scan's shape (inflight/scannerFiles/directionalScanHandler DrawDirectionalScanCone): at the ship
//   (SetupMyPositionTracker), turned as the space camera looks; under 180 degrees a cone (scancone.red scaled to
//   range x sin(half) x 2 wide, range x cos(half) long) and rings along it every 2 AU from 1 AU (ShowCone: at
//   d x cos(half), radius tan(half) x that); under 360 a half sphere of the range; 360 a sphere; COLOR_DSCAN (0.225,
//   0.75, 0.5); hidden where directionalScannerShowCone is off. Our own geometry in those proportions (the .red
//   models are not extracted).
// - Align with camera (SCANMODE_CAMERA; OnCameraUpdate): while the map is open the cone turns with the map's camera
//   and the space camera is turned to look the same way (AlignSpaceCameraToViewVector); entering it the map's point
//   of interest goes to the ship (LookAtEgoMarker) over GetRotationDurationFromVectors' 0.2 .. 0.5 s.
// - The probes (mapViewProbeHandlerStandalone UpdateProbeSpheres; inflight/probeControl_MapView ProbeControl): each
//   active probe's range sphere at its destination (SetPosition(probe.destination), SetRange(probe.scanRange)) and
//   its marker where it is (systemMapHandler: MarkerProbe at probe.pos); from OnProbeWarpStart to OnProbeWarpEnd a
//   line from where it is to its destination (WARP_LINE_COLOR: BASE_PROBE_COLOR (0.451, 0.941, 1.0) x 0.3, here
//   while the scanner holds it moving or warping). Our own sphere (Scanbubbledoteffect is a textured ubershader
//   set); no cursors yet (probeCursor, probeRangeCursor, probeSpreadCursor: the probes are moved from the scanner).
// - The position cursors (probeControl_MapView probeCursor.red, six arrows cursorX_0 .. cursorZ_1; drawn at a size
//   kept on screen, useDistanceBasedScale): the formation centre's (BaseProbeControl at the centre of the idle probes'
//   destinations) shown without Shift and moving all of them, each idle probe's own shown with Shift and moving it
//   alone (SetEditMode / UpdateProbeControlDisplay, MODIFY_POSITION). An arrow pointing within 2.9 rad of away from
//   the camera is hidden (_IsArrowVisible). The arrow under the mouse, and the one dragged, CURSOR_ACTIVE_COLOR
//   (2, 2, 2), the others BASE_PROBE_COLOR (HighlightCursors). Pressed (mapViewScannerNavigationStandalone
//   OnMouseDown): the drag's plane by GetAxisTargetPlaneNormal (axis x: Y, Z, X; y: Z, X, Y; z: Y, X, Z - the first
//   the mouse ray meets at |dot| >= 0.15); moved (MoveProbe): the mouse's move in that plane, ClampVector'd to the
//   axis; let go (RegisterProbeMove): SetProbeDestination for each idle probe moved; the right button while dragging
//   (CancelProbeMoveOrScaling) puts them back. Not yet the range and spread cursors (Alt, Ctrl), the modify hint,
//   the move sounds, the centroid lines and intersection highlights.
// Not here: the markers' overlap stacking and distance fade, the bookmarks, the scan panels docked in it, the range indicator, the probe
// handler, the d-scan cone (directionalScanHandler), the top / side view buttons, the nebula and starfield.

import * as THREE from "three";
import { PlayWindow, clientTexture } from "./window.ts";
import { bracketIcon } from "./brackets.ts";

export const SOLARSYSTEM_SCALE = 1e-10;
const MIN_DISTANCE = 0.5;
const MAX_DISTANCE = 9000;
const FOV_RADIANS = 0.7;
const K_MIN_PITCH = 0.01;
const K_MAX_PITCH = Math.PI / 2;
const GROUP_SUN = 6;
const GROUP_PLANET = 7;
const GROUP_MOON = 8;
const GROUP_STARGATE = 10;
/** mapViewConst.VIEWMODE_MARKERS_OPTIONS_DEFAULT (inventorycommon const). */
export const MARKER_GROUPS: ReadonlySet<number> = new Set([7, 8, 15, 9, 310, 2020, 10, 6, 1657, 1404, 1406]);

export interface MapCelestial {
  readonly itemID: number; readonly typeID: number | null; readonly groupID: number | null; readonly categoryID: number | null;
  readonly position: { x: number; y: number; z: number };
}

export interface SolarSystemMapHooks {
  /** The system's celestials as the park has them (EVE's own coordinates, metres). */
  celestials(): readonly MapCelestial[];
  /** The ship's position (EVE's coordinates), or null. */
  ego(): { x: number; y: number; z: number } | null;
  /** A marker's label: its name and distance (GetLabelText). */
  label?(itemID: number): string;
  /** LoadSolarSystemMap's cfg.evelocations.Prime: the celestials' names asked for. */
  primeNames?(itemIDs: readonly number[]): void;
  word?(label: string): string | null;
  /** The directional scan's angle and range, where its window is, the way it looks (EVE's coordinates) and whether
   * its cone is shown; null without a scanner. */
  dscanCone?(): { angleDeg: number; rangeMetres: number; direction: { x: number; y: number; z: number }; shown: boolean; cameraMode?: boolean } | null;
  /** AlignSpaceCameraToViewVector: the space camera turned to look along the direction (the map's / space view's axes). */
  aimSpaceCamera?(direction: THREE.Vector3): void;
  /** The pilot's active probes (the scanner's operations): place and destination (EVE's coordinates), range in metres. */
  probes?(): readonly { readonly probeID: number; readonly pos: readonly [number, number, number]; readonly destination: readonly [number, number, number]; readonly scanRange: number; readonly state?: number }[];
  /** RegisterProbeMove: the moved idle probes given their new destinations (EVE's coordinates). */
  moveProbes?(moves: readonly { probeID: number; destination: [number, number, number] }[]): Promise<void> | void;
}

type Axis = "x" | "y" | "z";
const AXES: readonly Axis[] = ["x", "y", "z"];
const AXIS_VECTOR: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
/** probeControl_MapView CURSOR_ACTIVE_COLOR. */
const CURSOR_ACTIVE_COLOR = new THREE.Color(2, 2, 2);
/** probescanning/const probeStateIdle. */
const PROBE_IDLE = 1;
/** The formation centre's cursor's key. */
const CENTER_CURSOR = -1;
/** The cursor's size against the camera's distance (a size kept on screen). */
const CURSOR_SCREEN = 0.05;

/** GetAxisTargetPlaneNormal: the plane a drag along the axis runs in, the first the mouse ray meets steeply enough. */
export function axisTargetPlaneNormal(axis: Axis, ray: THREE.Vector3): THREE.Vector3 {
  const order: Record<Axis, Axis[]> = { x: ["y", "z", "x"], y: ["z", "x", "y"], z: ["y", "x", "z"] };
  const [first, second, last] = order[axis];
  if (Math.abs(AXIS_VECTOR[first!].dot(ray)) >= 0.15) return AXIS_VECTOR[first!].clone();
  if (Math.abs(AXIS_VECTOR[second!].dot(ray)) >= 0.15) return AXIS_VECTOR[second!].clone();
  return AXIS_VECTOR[last!].clone();
}

const COLOR_DSCAN = new THREE.Color(0.225, 0.75, 0.5);
/** probeControl_MapView BASE_PROBE_COLOR. */
const PROBE_COLOR = new THREE.Color(0.45098039215686275, 0.9411764705882353, 1.0);
// ScanEffect (OnDirectionalScanComplete): the cone model's curve sets, read from res:/dx9/model/ui/scancone.black -
// ScanPart_01 (1 s): FresnelFactors.y x 0.6 by the keys 0, 0.1 -> 1, 0.5 -> 1, 0.75 -> 0.1, 1 -> 0; then ScanPart_02 (1 s):
// FresnelFactors.y x 0.66 by 0, 0.25 -> 1, 0.7516 -> 0.1, 1 -> 0; translateUVcurve 0, 0.8866 -> 0.95, 1 -> 1 (the
// texture moved along the cone: the sweep); staticBrightness 1, 0.66 -> 1, 0.8684 -> 0.1, 1 -> 0. Linear keys.
type Keys = readonly (readonly [number, number])[];
const PART1_FRESNEL: Keys = [[0, 0], [0.1, 1], [0.5, 1], [0.75, 0.1], [1, 0]];
const PART2_FRESNEL: Keys = [[0, 0], [0.25, 1], [0.7516, 0.1], [1, 0]];
const PART2_TRANSLATE: Keys = [[0, 0], [0.8866, 0.95], [1, 1]];
const PART2_STATIC: Keys = [[0, 1], [0.66, 1], [0.8684, 0.1], [1, 0]];
export function keysAt(keys: Keys, t: number): number {
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const [t0, v0] = keys[i]!, [t1, v1] = keys[i + 1]!;
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return keys[keys.length - 1]![1];
}
const AU_M = 149_597_870_700;

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
  private readonly markersLayer = document.createElement("div");
  private readonly coneGroup = new THREE.Group();
  private readonly probeGroup = new THREE.Group();
  private probeObjects = new Map<number, { sphere: THREE.Mesh; marker: THREE.Sprite; line: THREE.Line; range: number }>();
  private readonly cursorGroup = new THREE.Group();
  private cursors = new Map<number, THREE.Group>();
  private shiftHeld = false;
  private hover: { id: number; axis: Axis } | null = null;
  /** A move under way: the cursor and axis pressed, its plane, where the mouse met it, and the destinations it gives. */
  private moving: { id: number; axis: Axis; normal: THREE.Vector3; at: THREE.Vector3; mouse: THREE.Vector3; shift: boolean } | null = null;
  /** The destinations a move gives (EVE's coordinates), until the scanner has them. */
  private preview = new Map<number, [number, number, number]>();
  private readonly raycaster = new THREE.Raycaster();
  /** The cursors shown, for checks: the centre's, the probes' with theirs, and the arrows lit. */
  cursorInfo: { center: boolean; probes: number; lit: number; at: [number, number, number] | null } = { center: false, probes: 0, lit: 0, at: null };
  /** The probes drawn, for checks: id, map place, sphere radius, whether its line shows. */
  probeInfo: { probeID: number; at: [number, number, number]; to: [number, number, number]; radius: number; moving: boolean }[] = [];
  private coneFor = "";
  private scanEffectAt = 0;
  private coneSurface: THREE.MeshBasicMaterial | null = null;
  private sweepRing: THREE.LineLoop | null = null;
  private coneLength = 0;
  private coneHalfAngle = 0;
  /** The scan effect's state now, for checks: its phase (0 none, 1, 2), the flash and the sweep's place (0 .. 1). */
  scanEffectInfo = { phase: 0, flash: 0, sweep: 0, brightness: 0 };
  /** What the scan shape is now, for checks: "cone" / "half" / "sphere", its rings, and its size in map units. */
  coneInfo = { kind: "none", rings: 0, length: 0, radius: 0 };
  private markers: { itemID: number; at: THREE.Vector3; el: HTMLDivElement }[] = [];
  private yaw = 0.6;
  /** mapCamera's pitch: 0.01 from straight above .. pi / 2 level. */
  private pitch = 1.0;
  private pitchTween: { from: number; to: number; start: number; duration: number } | null = null;
  /** The camera's point of interest (the sun's, the ship's in align-with-camera mode), and its move there. */
  private readonly poi = new THREE.Vector3();
  private poiTween: { from: THREE.Vector3; start: number; duration: number } | null = null;
  private wasCameraMode = false;
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
    this.markersLayer.className = "ssm-markers";
    this.window.body.appendChild(this.markersLayer);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.root);
    this.egoMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0x58a7bf, sizeAttenuation: false, depthTest: false }));
    this.egoMarker.scale.setScalar(0.022);
    this.egoMarker.renderOrder = 2;
    this.scene.add(this.egoMarker);
    this.scene.add(this.coneGroup);
    this.scene.add(this.probeGroup);
    this.scene.add(this.cursorGroup);
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2 && this.moving) { this.cancelMove(); return; }
      if (e.button === 0 && this.pressCursor(e)) return;
      this.drag(e);
    });
    this.canvas.addEventListener("contextmenu", (e) => { if (this.moving) e.preventDefault(); });
    this.canvas.addEventListener("pointermove", (e) => { if (!this.moving) this.hover = this.pickCursor(e); });
    const keys = (e: KeyboardEvent) => { this.shiftHeld = e.shiftKey; };
    addEventListener("keydown", keys);
    addEventListener("keyup", keys);
    this.canvas.addEventListener("dblclick", () => this.toggleView());
    const word = (label: string, own: string) => hooks.word?.(label) ?? own;
    const views = document.createElement("div");
    views.className = "ssm-views";
    const toggleHint = `${word("UI/Inflight/Scanner/ToggleView", "Toggle View")}: ${word("UI/Inflight/Scanner/DoubleClickScene", "Double Click Scene")}`;
    views.innerHTML = `<button type="button" class="ssm-view ssm-top" title="${word("UI/Inflight/Scanner/ViewFromTop", "View from Top")}\n${toggleHint}"><img alt="" src="${clientTexture("res:/UI/Texture/Classes/MapView/topView.png")}"></button>`
      + `<button type="button" class="ssm-view ssm-side" title="${word("UI/Inflight/Scanner/ViewFromSide", "View from Side")}\n${toggleHint}"><img alt="" src="${clientTexture("res:/UI/Texture/Classes/MapView/sideView.png")}"></button>`;
    views.querySelector(".ssm-top")!.addEventListener("click", () => this.setTopView());
    views.querySelector(".ssm-side")!.addEventListener("click", () => this.setSideView());
    this.window.body.appendChild(views);
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
    this.markersLayer.innerHTML = "";
    this.markers = [];
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
    // LoadMarkers: the markers setting's groups
    for (const c of all) {
      if (c.groupID === null || !MARKER_GROUPS.has(c.groupID)) continue;
      const el = document.createElement("div");
      el.className = "ssm-marker";
      const icon = bracketIcon({ typeID: c.typeID, groupID: c.groupID, categoryID: c.categoryID });
      el.innerHTML = `<img class="ssm-frame" alt="" src="${clientTexture("res:/UI/Texture/classes/Bracket/selectionCircle.png")}">${icon ? `<img class="ssm-icon" alt="" src="${icon}">` : ""}<span class="ssm-label"></span>`;
      el.addEventListener("mouseenter", () => {
        el.classList.add("hover");
        (el.querySelector(".ssm-label") as HTMLElement).textContent = this.hooks.label?.(c.itemID) ?? "";
      });
      el.addEventListener("mouseleave", () => el.classList.remove("hover"));
      this.markersLayer.appendChild(el);
      this.markers.push({ itemID: c.itemID, at: mapPoint(c.position), el });
    }
    this.hooks.primeNames?.(this.markers.map((m) => m.itemID));
    this.radius = radius;
    // FrameSolarSystem: GetTranslationFromParentWithRadius - the distance at which the radius fills the view - times 1.3
    const fit = radius / Math.sin(FOV_RADIANS / 2);
    this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, 1.3 * fit));
  }

  /** SetTopView / SetSideView: the pitch eased there over max(0.1, |change| x 0.2) seconds. */
  private tweenPitch(to: number): void {
    this.pitchTween = { from: this.pitch, to, start: performance.now(), duration: Math.max(0.1, Math.abs(this.pitch - to) * 0.2) * 1000 };
  }
  setTopView(): void { this.tweenPitch(K_MIN_PITCH); }
  setSideView(): void { this.tweenPitch(K_MAX_PITCH); }
  /** ToggleCameraView: below pi / 4 to the side, else to the top. */
  toggleView(): void { if (this.pitch < Math.PI / 4) this.setSideView(); else this.setTopView(); }
  /** The camera's pitch, for checks (0.01 above .. pi / 2 level). */
  get cameraPitch(): number { return this.pitch; }

  private drag(e: PointerEvent): void {
    const x0 = e.clientX, y0 = e.clientY, yaw0 = this.yaw, pitch0 = this.pitch;
    this.pitchTween = null;
    const move = (m: PointerEvent) => {
      this.yaw = yaw0 - (m.clientX - x0) * 0.005;
      this.pitch = Math.min(K_MAX_PITCH, Math.max(K_MIN_PITCH, pitch0 - (m.clientY - y0) * 0.005));
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
    if (this.pitchTween) {
      const t = Math.min(1, (performance.now() - this.pitchTween.start) / this.pitchTween.duration);
      const eased = t * t * (3 - 2 * t);
      this.pitch = this.pitchTween.from + (this.pitchTween.to - this.pitchTween.from) * eased;
      if (t >= 1) this.pitchTween = null;
    }
    // the point of interest: the ship's in align-with-camera mode (LookAtEgoMarker), the sun's otherwise
    const cameraMode = this.hooks.dscanCone?.()?.cameraMode === true && ego !== null;
    const target = cameraMode && ego ? mapPoint(ego) : new THREE.Vector3();
    if (cameraMode !== this.wasCameraMode) {
      this.wasCameraMode = cameraMode;
      this.poiTween = { from: this.poi.clone(), start: performance.now(), duration: 350 };
    }
    if (this.poiTween) {
      const t = Math.min(1, (performance.now() - this.poiTween.start) / this.poiTween.duration);
      this.poi.lerpVectors(this.poiTween.from, target, t * t * (3 - 2 * t));
      if (t >= 1) this.poiTween = null;
    } else this.poi.copy(target);
    // the pitch from straight above: the camera's height the cosine, its reach out the sine
    const out = Math.sin(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * out * this.distance, Math.cos(this.pitch) * this.distance, Math.cos(this.yaw) * out * this.distance).add(this.poi);
    this.camera.lookAt(this.poi);
    this.camera.updateMatrixWorld();
    this.updateCone(ego);
    this.updateProbes();
    this.renderer.render(this.scene, this.camera);
    // the markers on their map points (behind the camera: hidden)
    const v = new THREE.Vector3();
    for (const m of this.markers) {
      v.copy(m.at).project(this.camera);
      const shown = v.z < 1 && v.z > -1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      m.el.style.display = shown ? "" : "none";
      if (shown) m.el.style.transform = `translate(${Math.round(((v.x + 1) / 2) * w) - 7}px, ${Math.round(((1 - v.y) / 2) * h) - 7}px)`;
    }
  }

  /** DrawDirectionalScanCone: the shape by the angle, rebuilt where the angle or range changes; placed at the ship and
   * turned to the scan's direction each frame. */
  private updateCone(ego: { x: number; y: number; z: number } | null): void {
    const cone = this.hooks.dscanCone?.() ?? null;
    this.coneGroup.visible = !!cone && cone.shown && ego !== null;
    if (!cone || !ego) return;
    const key = `${cone.angleDeg}:${Math.round(cone.rangeMetres)}`;
    if (key !== this.coneFor) {
      this.coneFor = key;
      this.coneGroup.clear();
      const range = cone.rangeMetres * SOLARSYSTEM_SCALE;
      const surface = new THREE.MeshBasicMaterial({ color: COLOR_DSCAN, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending });
      this.coneSurface = surface;
      this.sweepRing = null;
      const line = new THREE.LineBasicMaterial({ color: COLOR_DSCAN, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
      if (cone.angleDeg < 180) {
        const half = ((cone.angleDeg * Math.PI) / 180) / 2;
        const length = range * Math.cos(half);
        const radius = range * Math.sin(half);
        // a cone with its apex at the ship and its axis along +y
        const g = new THREE.ConeGeometry(radius, length, 48, 1, true);
        g.rotateX(Math.PI);
        g.translate(0, length / 2, 0);
        this.coneGroup.add(new THREE.Mesh(g, surface));
        let rings = 0;
        for (let d = AU_M; d < cone.rangeMetres; d += 2 * AU_M) {
          const step = d * Math.cos(half) * SOLARSYSTEM_SCALE;
          const r = Math.tan(half) * step;
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, step, Math.sin(a) * r)); }
          this.coneGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), line));
          rings += 1;
        }
        this.coneInfo = { kind: "cone", rings, length, radius };
        this.coneLength = length;
        this.coneHalfAngle = half;
        // the sweep's ring, moved along the cone by ScanPart_02
        const sweepPts: THREE.Vector3[] = [];
        for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; sweepPts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
        this.sweepRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sweepPts),
          new THREE.LineBasicMaterial({ color: COLOR_DSCAN, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.sweepRing.visible = false;
        this.coneGroup.add(this.sweepRing);
      } else if (cone.angleDeg < 360) {
        this.coneGroup.add(new THREE.Mesh(new THREE.SphereGeometry(range, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), surface));
        this.coneInfo = { kind: "half", rings: 0, length: range, radius: range };
      } else {
        this.coneGroup.add(new THREE.Mesh(new THREE.SphereGeometry(range, 48, 32), surface));
        this.coneInfo = { kind: "sphere", rings: 0, length: range, radius: range };
      }
    }
    this.stepScanEffect();
    this.coneGroup.position.copy(mapPoint(ego));
    // SCANMODE_CAMERA with the map open: the map camera's look, and the space camera turned to it
    const dir = cone.cameraMode && this.isOpen ? this.camera.getWorldDirection(new THREE.Vector3()) : mapPoint(cone.direction).normalize();
    if (cone.cameraMode && this.isOpen) this.hooks.aimSpaceCamera?.(dir.clone());
    if (dir.lengthSq() > 0) this.coneGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  /** The markers drawn, for checks: how many, and how many in the view. */
  markerCounts(): { all: number; shown: number } {
    return { all: this.markers.length, shown: this.markers.filter((m) => m.el.style.display !== "none").length };
  }

  /** The probes' spheres, markers and lines kept as the scanner has them. */
  private updateProbes(): void {
    const probes = this.hooks.probes?.() ?? [];
    const seen = new Set<number>();
    this.probeInfo = [];
    for (const p of probes) {
      seen.add(p.probeID);
      let o = this.probeObjects.get(p.probeID);
      if (!o) {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: PROBE_COLOR, transparent: true,
          opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
        const wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1, 16, 8), 1),
          new THREE.LineBasicMaterial({ color: PROBE_COLOR, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending }));
        sphere.add(wire);
        const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: PROBE_COLOR, sizeAttenuation: false, depthTest: false }));
        marker.scale.setScalar(0.014);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: PROBE_COLOR.clone().multiplyScalar(0.3), depthWrite: false }));
        this.probeGroup.add(sphere, marker, line);
        o = { sphere, marker, line, range: 0 };
        this.probeObjects.set(p.probeID, o);
      }
      const at = mapPoint({ x: p.pos[0], y: p.pos[1], z: p.pos[2] });
      const dest = this.preview.get(p.probeID) ?? p.destination;
      const to = mapPoint({ x: dest[0], y: dest[1], z: dest[2] });
      const radius = p.scanRange * SOLARSYSTEM_SCALE;
      o.sphere.position.copy(to);
      o.sphere.scale.setScalar(Math.max(radius, 1e-6));
      o.marker.position.copy(at);
      // probeStateMoving 2, probeStateWarping 3: on its way
      const moving = p.state === 2 || p.state === 3;
      o.line.visible = moving;
      if (moving) o.line.geometry.setFromPoints([at, to]);
      this.probeInfo.push({ probeID: p.probeID, at: [at.x, at.y, at.z], to: [to.x, to.y, to.z], radius, moving });
    }
    for (const [id, o] of this.probeObjects) {
      if (seen.has(id)) continue;
      this.probeGroup.remove(o.sphere, o.marker, o.line);
      this.probeObjects.delete(id);
    }
    this.updateCursors(probes);
  }

  /** probeCursor.red in our own shapes: a shaft and head each way along x, y and z, named by the cursor and axis. */
  private makeCursor(id: number): THREE.Group {
    const group = new THREE.Group();
    for (const axis of AXES) {
      for (const sign of [1, -1]) {
        const arrow = new THREE.Group();
        const material = new THREE.MeshBasicMaterial({ color: PROBE_COLOR, depthTest: false, transparent: true });
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), material);
        shaft.position.y = 0.45;
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 12), material);
        head.position.y = 0.95;
        for (const m of [shaft, head]) { m.userData = { cursor: id, axis }; m.renderOrder = 3; }
        arrow.add(shaft, head);
        arrow.userData = { axis, dir: AXIS_VECTOR[axis].clone().multiplyScalar(sign) };
        arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), arrow.userData.dir as THREE.Vector3);
        group.add(arrow);
      }
    }
    this.cursorGroup.add(group);
    return group;
  }

  /** UpdateProbeControlDisplay / HighlightCursors / UpdateArrowVisibility, each frame. */
  private updateCursors(probes: readonly { readonly probeID: number; readonly destination: readonly [number, number, number]; readonly state?: number }[]): void {
    const idle = probes.filter((p) => p.state === PROBE_IDLE);
    const shift = this.moving ? this.moving.shift : this.shiftHeld;
    const places = new Map<number, THREE.Vector3>();
    for (const p of idle) {
      const d = this.preview.get(p.probeID) ?? p.destination;
      places.set(p.probeID, mapPoint({ x: d[0], y: d[1], z: d[2] }));
    }
    if (idle.length > 0) {
      const center = new THREE.Vector3();
      for (const v of places.values()) center.add(v);
      places.set(CENTER_CURSOR, center.divideScalar(idle.length));
    }
    const away = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const active = this.moving ?? this.hover;
    let lit = 0;
    for (const [id, group] of this.cursors) if (!places.has(id)) { this.cursorGroup.remove(group); this.cursors.delete(id); }
    for (const [id, at] of places) {
      let group = this.cursors.get(id);
      if (!group) { group = this.makeCursor(id); this.cursors.set(id, group); }
      group.visible = id === CENTER_CURSOR ? !shift : shift;
      group.position.copy(at);
      group.scale.setScalar(this.camera.position.distanceTo(at) * CURSOR_SCREEN);
      // HighlightCursors: the cursor pressed (or every one without Shift) lit on the axis
      const on = active !== null && (active.id === id || (!shift && id === CENTER_CURSOR));
      for (const arrow of group.children) {
        const dir = arrow.userData.dir as THREE.Vector3;
        arrow.visible = Math.acos(Math.max(-1, Math.min(1, dir.dot(away)))) < 2.9;
        const lightUp = on && active!.axis === arrow.userData.axis;
        if (lightUp && group.visible && arrow.visible) lit += 1;
        for (const m of arrow.children) ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(lightUp ? CURSOR_ACTIVE_COLOR : PROBE_COLOR);
      }
    }
    const c = places.get(CENTER_CURSOR);
    this.cursorInfo = { center: !!c && !shift, probes: shift ? idle.length : 0, lit, at: c ? [c.x, c.y, c.z] : null };
  }

  /** The mouse ray in the map, from a pointer event. */
  private rayFrom(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  /** PickScene: the shown cursor arrow under the mouse. */
  private pickCursor(e: { clientX: number; clientY: number }): { id: number; axis: Axis } | null {
    this.rayFrom(e);
    const shown: THREE.Object3D[] = [];
    for (const group of this.cursors.values()) {
      if (!group.visible) continue;
      for (const arrow of group.children) if (arrow.visible) shown.push(...arrow.children);
    }
    const hit = this.raycaster.intersectObjects(shown, false)[0];
    return hit ? { id: hit.object.userData.cursor as number, axis: hit.object.userData.axis as Axis } : null;
  }

  /** OnMouseDown on a cursor: the move begun (InitProbeMove). False where no cursor was pressed. */
  private pressCursor(e: PointerEvent): boolean {
    const picked = this.pickCursor(e);
    const group = picked ? this.cursors.get(picked.id) : undefined;
    if (!picked || !group) return false;
    const ray = this.rayFrom(e);
    const normal = axisTargetPlaneNormal(picked.axis, ray.direction);
    const at = group.position.clone();
    const mouse = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at), new THREE.Vector3());
    if (!mouse) return false;
    this.moving = { id: picked.id, axis: picked.axis, normal, at, mouse, shift: picked.id !== CENTER_CURSOR };
    const base = new Map((this.hooks.probes?.() ?? []).filter((p) => p.state === PROBE_IDLE).map((p) => [p.probeID, [...p.destination] as [number, number, number]]));
    const move = (m: PointerEvent) => this.moveTo(m, base);
    const up = (u: PointerEvent) => {
      if (u.button !== 0) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (this.moving) this.registerMove(base);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    this.cancelHandlers = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    return true;
  }
  private cancelHandlers: (() => void) | null = null;

  /** MoveProbe: the mouse's move in the plane, along the axis, given to all the idle probes or the pressed one. */
  private moveTo(e: { clientX: number; clientY: number }, base: ReadonlyMap<number, [number, number, number]>): void {
    const mv = this.moving;
    if (!mv) return;
    const ray = this.rayFrom(e);
    const now = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(mv.normal, mv.at), new THREE.Vector3());
    if (!now) return;
    // ClampVector: the move's part along the axis, in metres (the map's z is EVE's -z)
    const along = AXIS_VECTOR[mv.axis].clone().multiplyScalar(now.clone().sub(mv.mouse).dot(AXIS_VECTOR[mv.axis]));
    const diff: [number, number, number] = [along.x / SOLARSYSTEM_SCALE, along.y / SOLARSYSTEM_SCALE, -along.z / SOLARSYSTEM_SCALE];
    this.preview = new Map();
    for (const [probeID, d] of base) {
      if (mv.shift && probeID !== mv.id) continue;
      this.preview.set(probeID, [d[0] + diff[0], d[1] + diff[1], d[2] + diff[2]]);
    }
  }

  /** RegisterProbeMove: each idle probe moved given its destination. */
  private registerMove(base: ReadonlyMap<number, [number, number, number]>): void {
    this.moving = null;
    this.cancelHandlers = null;
    const moves = [...this.preview].filter(([id, d]) => {
      const b = base.get(id);
      return b !== undefined && (b[0] !== d[0] || b[1] !== d[1] || b[2] !== d[2]);
    }).map(([probeID, destination]) => ({ probeID, destination }));
    this.lastMoves = moves;
    if (moves.length === 0) { this.preview = new Map(); return; }
    void Promise.resolve(this.hooks.moveProbes?.(moves)).catch(() => {}).finally(() => { this.preview = new Map(); });
  }
  /** The last move given, for checks. */
  lastMoves: { probeID: number; destination: [number, number, number] }[] = [];

  /** CancelProbeMoveOrScaling: the probes put back. */
  private cancelMove(): void {
    this.cancelHandlers?.();
    this.cancelHandlers = null;
    this.moving = null;
    this.preview = new Map();
  }

  /** OnDirectionalScanComplete -> ScanEffect: ScanPart_01, then ScanPart_02 when it ends. */
  scanEffect(): void { this.scanEffectAt = performance.now(); }

  private stepScanEffect(): void {
    const elapsed = this.scanEffectAt ? (performance.now() - this.scanEffectAt) / 1000 : Infinity;
    let flash = 0, sweep = 0, brightness = 0, phase = 0;
    if (elapsed < 1) { phase = 1; flash = keysAt(PART1_FRESNEL, elapsed) * 0.6; }
    else if (elapsed < 2) {
      phase = 2;
      const t = elapsed - 1;
      flash = keysAt(PART2_FRESNEL, t) * 0.66;
      sweep = keysAt(PART2_TRANSLATE, t);
      brightness = keysAt(PART2_STATIC, t);
    }
    this.scanEffectInfo = { phase, flash, sweep, brightness };
    if (this.coneSurface) this.coneSurface.opacity = 0.12 + flash * 0.5;
    if (this.sweepRing) {
      this.sweepRing.visible = phase === 2 && brightness > 0;
      const along = sweep * this.coneLength;
      const r = Math.tan(this.coneHalfAngle) * along;
      this.sweepRing.position.set(0, along, 0);
      this.sweepRing.scale.set(Math.max(r, 1e-6), 1, Math.max(r, 1e-6));
      (this.sweepRing.material as THREE.LineBasicMaterial).opacity = brightness;
    }
  }

  /** The camera's point of interest, for checks. */
  get pointOfInterest(): THREE.Vector3 { return this.poi.clone(); }
  /** The camera's distance from the point of interest, in the map's units. */
  get cameraDistance(): number { return this.distance; }
}
