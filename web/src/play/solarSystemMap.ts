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
//   (CancelProbeMoveOrScaling) puts them back.
// - The spread and range cursors (CheckKeyState: Ctrl MODIFY_SPREAD, Alt MODIFY_RANGE; SetEditMode shows each idle
//   probe's probeSpreadCursor - two arrows turned to the formation's centre, SetFormationCenter - or its
//   probeRangeCursor - a flattened sphere on the sphere's edge, SetRange). A spread drag (MoveProbe MODIFY_SPREAD)
//   scales the places about the centre by the mouse's distance from it in the axis plane, Shift the pressed one
//   alone; let go, RegisterProbeMove. A range drag (ScaleProbe, the camera-facing plane; also a sphere's edge pressed
//   within ten pixels without a key, PickProbes(pickBorder=True)): Shift the pressed probe's range by the mouse's
//   distance from it, else every place and range about the centre; its eight steps drawn as rings (ShowScanRanges);
//   let go (RegisterProbeScale), the step nearest (GetRangeStepForType) - Shift SetProbeRangeStep for the one, else
//   ScaleAllProbes(that step's range / the range): each place about the centre and each range the step nearest.
//   In both modes a line from the centre to each probe (ShowCentroidLines, CENTROID_LINE_COLOR). Not here: the
//   modify hint, the move sounds.
// - The probes' intersections (HighlightProbeIntersections): where two active probes' spheres meet (IsIntersecting),
//   a circle (ProbesIntersection: intersectionCircle.png on a zsprite, additive, BASE_PROBE_COLOR x its opacity) at
//   ComputeHighlightCircle's point, turned to the line between them, scaled to the circle's radius x 2. Shown only with
//   showAll or out of a formation - the client is always in one (ProbeTracker starts in Pinpoint, nothing breaks it),
//   so only while a probe is moved with Shift or the formation spread (MoveProbe), gone at the next plain update. Each
//   circle changed goes to INTERSECTION_ACTIVE 0.6, and 500 ms after its last change to INTERSECTION_INACTIVE 0.05
//   over 1.5 s. (HighlightMarkersInProbeRange marks markers in range, but UpdateInRangeIndicatorState draws nothing
//   in this client: nothing to show.)
// - The probe scan's results (mapViewProbeHandlerStandalone.UpdateScanResult over scanSvc.GetResults' shown ones):
//   a deviation (a float) a sphere of that radius at the guess (CreateSphereResult, scanbubblehitsphere: red,
//   DiffuseColor 0.15, additive - our own sphere); a circle (two probes) a dashed ring at its point turned to its
//   normal (_DrawCircleResultLines, CIRCLE_COLOR_DESELECTED (0.5, 0, 0, 0.5), the dashes moving, ChangeLineAnimation);
//   two places (three probes) a marker each and a dashed line between (_DrawPointResultLines); a place a marker. Each
//   marker MarkerScanResult: GetResultTexturePath - scanResultLocation.png for a float or a circle, else the scan
//   group's bracket - in GetResultColor. The selected results (UpdateSelectedObjects, scanSvc.IsSiteSelected): rings
//   and lines CIRCLE_COLOR_SELECTED (1, 0, 0, 0.7), the others CIRCLE_COLOR_DESELECTED; a sphere's selected parts
//   (_SetSphereSelectedState: its surface area and two more shown only when selected - here brighter). A result
//   marker clicked selects its site (MarkerScanResult: SelectSite, Shift or Ctrl adding). A selected result's marker
//   (CheckShowGauge / ConstructGauge): a GaugeCircular of radius 22, line 2, from the top clockwise to the certainty,
//   from the colour at 0.8 of its brightness to the colour, on the colour at brightness 0.4, in CircularGradient.png
//   (60 x 60, opacity 0.4); the marker at 1.0, an unselected one at 0.6 (GetMarkerOpacity). A result turned perfect
//   (AnimPerfectResult): the gauge blinked in four times, two circles of radius 40 (0.4, 1, 0.4) grown to 1.4 and
//   faded from 0.3 over 0.8 s, 0.25 s and 0.65 s on. Its label (GetLabelText): the id, the display name and the
//   distance, and below a partial result's the difficulty (GetBracketLabelText: ScanningDifficulty, by
//   GetScanDifficultyText - Level in Roman or DifficultyUnknown). Its menu on the right button (GetMenu:
//   GetScanResultMenuWithIgnore - an accurate result's warp within the default distance where out of warp range's
//   minimum, Align To, then Ignore Result and Ignore Other Results). Not here: the radial menu on the left button
//   (TryExpandActionMenu), the menu's Bookmark Location and its warp-within submenu.
// Not here: the markers' distance fade, the bookmarks, the scan panels docked in it, the range indicator, the probe
// handler, the d-scan cone (directionalScanHandler), the top / side view buttons, the nebula and starfield.

import * as THREE from "three";
import { PlayWindow, clientTexture } from "./window.ts";
import { bracketIcon } from "./brackets.ts";
import { ScanHolograms } from "./scanHologram.ts";
import { ScanConeModels, scanConeLines, type ScanConeKind } from "./scanConeModels.ts";
import { MapMarkerOverlay, type MapMarker } from "./mapMarkerOverlay.ts";
import type { DScanResult } from "./dscan.ts";

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
  /** The location name used for overlap sorting (GetDisplayText). */
  markerName?(itemID: number): string;
  /** LoadSolarSystemMap's cfg.evelocations.Prime: the celestials' names asked for. */
  primeNames?(itemIDs: readonly number[]): void;
  word?(label: string): string | null;
  /** The directional scan's angle and range, where its window is, the way it looks (EVE's coordinates) and whether
   * its cone is shown; null without a scanner. */
  dscanCone?(): { angleDeg: number; rangeMetres: number; direction: { x: number; y: number; z: number }; shown: boolean; cameraMode?: boolean } | null;
  hologramTypes?(ids: readonly number[]): Promise<Record<string, number>>;
  /** AlignSpaceCameraToViewVector: the space camera turned to look along the direction (the map's / space view's axes). */
  aimSpaceCamera?(direction: THREE.Vector3): void;
  scanShortcutHeld?(): boolean;
  /** CheckDirectionalScanItem: use a marker's position even when its ball is off grid. */
  scanTowards?(position: MapCelestial["position"]): boolean;
  /** SetSelectedMarker switches the scan camera to target mode. */
  selectCelestial?(): void;
  /** The pilot's active probes (the scanner's operations): place and destination (EVE's coordinates), range in metres. */
  probes?(): readonly { readonly probeID: number; readonly pos: readonly [number, number, number]; readonly destination: readonly [number, number, number]; readonly scanRange: number; readonly state?: number; readonly rangeSteps?: readonly number[] | null }[];
  probeLabel?(probeID: number, distance: number | null): string;
  /** The probe scan's results shown (the scanner's list less the ignored and the filtered). */
  scanResults?(): readonly MapScanResult[];
  /** The probe results selected (scanSvc.selectedSites). */
  selectedSites?(): ReadonlySet<string>;
  /** SelectSite: a result marker clicked. */
  selectSite?(siteID: string, multiSelect: boolean): void;
  /** A result marker's label: GetLabelText, and the difficulty line for a partial result. */
  resultLabel?(siteID: string): string;
  /** A result marker's menu (GetScanResultMenuWithIgnore): each entry's words and what it does. */
  resultMenu?(siteID: string): readonly { label: string; run: () => void }[];
  /** RegisterProbeMove: the moved idle probes given their new destinations (EVE's coordinates). */
  moveProbes?(moves: readonly ProbeMove[]): Promise<void> | void;
}

/** A probe scan result as the map takes it. */
export interface MapScanResult {
  readonly id: string;
  readonly certainty: number;
  readonly strengthAttributeID: number | null;
  readonly data: readonly [number, number, number] | number | { readonly point: readonly [number, number, number]; readonly radius: number; readonly normal: readonly [number, number, number] } | readonly (readonly [number, number, number])[] | null;
  readonly pos: readonly [number, number, number] | null;
}
/** mapViewProbeHandlerStandalone CIRCLE_COLOR_DESELECTED (0.5, 0, 0, 0.5) and CIRCLE_COLOR_SELECTED (1, 0, 0, 0.7). */
const CIRCLE_COLOR = new THREE.Color(0.5, 0, 0);
const CIRCLE_COLOR_SELECTED = new THREE.Color(1, 0, 0);
/** mapMarkerUtil.ICONS_BY_SCANGROUP, by the strength attribute. */
const RESULT_ICONS: Readonly<Record<number, string>> = {
  211: "res:/UI/Texture/Shared/Brackets/ore_site_16.png", 209: "res:/UI/Texture/Shared/Brackets/harvestableCloud.png",
  210: "res:/UI/Texture/Shared/Brackets/relic_site_16.png", 208: "res:/UI/Texture/Shared/Brackets/data_site_16.png",
  1908: "res:/UI/Texture/Shared/Brackets/wormhole.png", 1136: "res:/UI/Texture/Shared/Brackets/combatSite_16.png",
};
/** mapMarkerUtil.GetResultColor. */
function resultColour(certainty: number): string {
  return rgbCss(resultRgb(certainty));
}
function resultRgb(certainty: number): [number, number, number] {
  if (certainty <= 0.25) return [1, 0, 0];
  if (certainty <= 0.75) return [0.9, 0.5, 0];
  if (certainty < 1) return [1, 1, 0.1];
  return [0, 0.8, 0];
}
const rgbCss = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(", ")})`;
/** Color.SetBrightness: the colour's value (HSV) set. */
const withBrightness = (c: readonly number[], value: number) => { const max = Math.max(...c); return max > 0 ? c.map((v) => (v / max) * value) : c.map(() => value); };
/** A probe as the map takes it. */
type MapProbe = ReturnType<NonNullable<SolarSystemMapHooks["probes"]>>[number];
/** A probe given a new destination, a new range step, or both. */
export type ProbeMove = { probeID: number; destination?: [number, number, number]; rangeStep?: number | undefined };
/** MODIFY_POSITION, MODIFY_SPREAD, MODIFY_RANGE. */
type CursorKind = "position" | "spread" | "range";
type Picked = { id: number; axis: Axis; kind: CursorKind };

/** GetRangeStepForType: the step (1 .. 8) whose range is nearest, and that range. */
export function nearestRangeStep(steps: readonly number[], range: number): [number, number] {
  let best: [number, number] = [1, steps[0] ?? range];
  for (let i = 0; i < steps.length; i++) if (Math.abs(steps[i]! - range) < Math.abs(best[1] - range)) best = [i + 1, steps[i]!];
  return best;
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
const AU_M = 149_597_870_700;
const INTERSECTION_ACTIVE = 0.6;
const INTERSECTION_INACTIVE = 0.05;

/** IsIntersecting: the two spheres' surfaces meet (neither apart nor one inside the other). */
export function isIntersecting(d: number, r1: number, r2: number): boolean {
  return !(d > r1 + r2 || r1 > d + r2 || r2 > d + r1);
}

/** ComputeHighlightCircle: the circle where the spheres meet - its distance along the line from the first, its radius. */
export function highlightCircle(d: number, r1: number, r2: number): { along: number; radius: number } | null {
  if (!d) return null;
  const along = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const sq = r1 * r1 - along * along;
  return sq < 0 ? null : { along, radius: Math.sqrt(sq) };
}

/**
 * EVE's coordinates to the map's (the space view's handedness: z mirrored), scaled. As in the space view the canvas
 * is shown mirrored left to right (the client draws right-handed), and screen work goes through screenCam.
 */
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
  private readonly markerOverlay: MapMarkerOverlay;
  private readonly coneGroup = new THREE.Group();
  private readonly coneModels = new ScanConeModels();
  private readonly coneLines = new THREE.Group();
  private readonly coneFallback = new THREE.Group();
  private readonly holograms: ScanHolograms;
  private readonly probeGroup = new THREE.Group();
  private probeObjects = new Map<number, { sphere: THREE.Mesh; marker: MapMarker; line: THREE.Line; range: number }>();
  private readonly cursorGroup = new THREE.Group();
  private cursors = new Map<number, THREE.Group>();
  private spreadCursors = new Map<number, THREE.Group>();
  private rangeCursors = new Map<number, THREE.Mesh>();
  private readonly centroidLines = new THREE.LineSegments(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: PROBE_COLOR.clone().multiplyScalar(0.3), depthTest: false, transparent: true }));
  private readonly rangeRings = new THREE.Group();
  private readonly intersectionGroup = new THREE.Group();
  private readonly resultGroup = new THREE.Group();
  private resultsFor = "";
  private resultMarkers: MapMarker[] = [];
  private resultDashes: THREE.LineDashedMaterial[] = [];
  /** Each result's certainty as last drawn, to see one turn perfect (OnClientEvent_PerfectScanResultReached). */
  private lastCertainty = new Map<string, number>();
  /** The results that turned perfect at the last drawing, for checks. */
  perfectReached: string[] = [];
  /** The results drawn, for checks: spheres, circles, lines, markers. */
  resultInfo = { spheres: 0, circles: 0, lines: 0, markers: 0, selected: 0 };
  private intersections = new Map<string, { mesh: THREE.Mesh; config: string; changedAt: number }>();
  private intersectionTexture: THREE.Texture | null = null;
  /** The intersections shown, for checks: the pair, the circle's radius (map units) and its opacity now. */
  intersectionInfo: { pair: string; radius: number; opacity: number }[] = [];
  private readonly ringMaterial = new THREE.LineBasicMaterial({ color: PROBE_COLOR, transparent: true, opacity: 0.5, depthTest: false });
  private shiftHeld = false;
  private ctrlHeld = false;
  private altHeld = false;
  private readonly onModifiers = (e: KeyboardEvent) => {
    this.shiftHeld = e.shiftKey;
    this.ctrlHeld = e.ctrlKey;
    this.altHeld = e.altKey;
  };
  private hover: Picked | null = null;
  /** A move or scaling under way: what was pressed, its plane, where the mouse met it at the probe and at the centre,
   * and the idle probes as they were. */
  private moving: { mode: CursorKind; id: number; axis: Axis; normal: THREE.Vector3; at: THREE.Vector3; center: THREE.Vector3;
    centerEve: [number, number, number]; mouse: THREE.Vector3; mouseC: THREE.Vector3; shift: boolean;
    base: Map<number, { dest: [number, number, number]; range: number; steps: readonly number[] }> } | null = null;
  /** The destinations and ranges a drag gives (EVE's coordinates, metres), until the scanner has them. */
  private preview = new Map<number, [number, number, number]>();
  private previewRange = new Map<number, number>();
  private readonly raycaster = new THREE.Raycaster();
  /** The cursors shown, for checks: the centre's, the probes' with theirs, and the arrows lit. */
  cursorInfo: { mode: CursorKind; center: boolean; probes: number; spread: number; range: number; centroid: number; lit: number;
    at: [number, number, number] | null; rings: number } = { mode: "position", center: false, probes: 0, spread: 0, range: 0, centroid: 0, lit: 0, at: null, rings: 0 };
  /** The probes drawn, for checks: id, map place, sphere radius, whether its line shows. */
  probeInfo: { probeID: number; at: [number, number, number]; to: [number, number, number]; radius: number; moving: boolean }[] = [];
  private coneFor = "";
  /** What the scan shape is now, for checks: "cone" / "half" / "sphere", its rings, and its size in map units. */
  coneInfo = { kind: "none", rings: 0, length: 0, radius: 0 };
  private markers: MapMarker[] = [];
  private yaw = 0.6;
  /** The camera as the mirrored canvas shows it: its screen x mirrored (spaceView's HANDEDNESS). */
  private readonly mirrorCam = new THREE.PerspectiveCamera();
  private get screenCam(): THREE.PerspectiveCamera {
    const c = this.camera, m = this.mirrorCam;
    m.matrixWorld.copy(c.matrixWorld);
    m.matrixWorldInverse.copy(c.matrixWorldInverse);
    m.projectionMatrix.copy(c.projectionMatrix);
    const e = m.projectionMatrix.elements;
    e[0] = -e[0]!; e[4] = -e[4]!; e[8] = -e[8]!; e[12] = -e[12]!;
    m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
    return m;
  }
  /** mapCamera's pitch: 0.01 from straight above .. pi / 2 level. */
  private pitch = 1.0;
  private pitchTween: { from: number; to: number; start: number; duration: number } | null = null;
  /** The camera's point of interest (the sun's, the ship's in align-with-camera mode), and its move there. */
  private readonly poi = new THREE.Vector3();
  private markerPoi: THREE.Vector3 | null = null;
  private poiTween: { from: THREE.Vector3; start: number; duration: number } | null = null;
  private wasCameraMode = false;
  private active = false;
  private distance = 100;
  private frame = 0;
  private detached = false;
  private builtFor: string | null = null;
  /** The system's radius in the map's units (its farthest celestial). */
  radius = 0;
  /** What was drawn, for checks: planets, moons, orbits. */
  counts = { planets: 0, moons: 0, orbits: 0, stargates: 0 };

  constructor(private readonly hooks: SolarSystemMapHooks, private readonly host: HTMLElement) {
    this.holograms = new ScanHolograms(hooks.hologramTypes);
    const caption = hooks.word?.("UI/Map/MapPallet/btnSolarsystemMap") ?? "Solar System Map";
    this.window = new PlayWindow({ id: "solarSystemMap", caption, icon: clientTexture("res:/ui/texture/shared/brackets/solarsystem.png"),
      left: Math.max(16, Math.round(innerWidth / 2 - 450)), top: 60, width: 900, height: 600, minWidth: 400, minHeight: 300, closable: true },
    () => { this.detached = true; this.close(); });
    this.window.body.classList.add("ssm");
    this.canvas.className = "ssm-canvas";
    this.canvas.style.transform = "scaleX(-1)";
    this.window.body.appendChild(this.canvas);
    this.markerOverlay = new MapMarkerOverlay(this.window.body);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.root);
    this.egoMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0x58a7bf, sizeAttenuation: false, depthTest: false }));
    this.egoMarker.scale.setScalar(0.022);
    this.egoMarker.renderOrder = 2;
    this.scene.add(this.egoMarker);
    this.scene.add(this.coneGroup);
    this.coneGroup.add(this.coneModels.root, this.coneLines, this.coneFallback);
    this.scene.add(this.holograms.root);
    this.scene.add(this.probeGroup);
    this.scene.add(this.cursorGroup);
    this.centroidLines.renderOrder = 2;
    this.scene.add(this.centroidLines);
    this.rangeRings.visible = false;
    this.scene.add(this.rangeRings);
    this.scene.add(this.intersectionGroup);
    this.scene.add(this.resultGroup);
    this.canvas.addEventListener("pointerdown", (e) => {
      this.markerOverlay.clearTooltip();
      if (e.button === 2 && this.moving) { this.cancelMove(); return; }
      if (e.button === 0 && this.pressCursor(e)) return;
      this.drag(e);
    });
    let pressedControl = false;
    this.markerOverlay.layer.addEventListener("pointerdown", (e) => {
      // MapMarkerPickingOverride gives a probe control's hit priority over the markers.
      pressedControl = e.button === 0 && this.pressCursor(e);
      if (pressedControl) this.markerOverlay.clearTooltip();
    });
    this.markerOverlay.layer.addEventListener("click", (e) => {
      if (pressedControl) e.stopPropagation();
      pressedControl = false;
    }, true);
    this.canvas.addEventListener("contextmenu", (e) => { if (this.moving) e.preventDefault(); });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.moving) return;
      this.hover = this.pickCursor(e);
      // HighlightProbeBorder: a sphere's edge under the mouse, moving the probes
      if (!this.hover && this.editMode() === "position") { const id = this.pickBorder(e); if (id !== null) this.hover = { id, axis: "z", kind: "range" }; }
    });
    addEventListener("keydown", this.onModifiers);
    addEventListener("keyup", this.onModifiers);
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
  setActive(active: boolean): void { this.active = active; }
  /** Whether the map is the active window (the last pressed in). */
  get isActive(): boolean { return this.active && this.isOpen; }
  /** solarSystemViewPanel.CmdZoomInOut (CmdZoomIn / CmdZoomOut): one wheel notch in or out, as the wheel zooms. */
  zoomStep(direction: -1 | 1): void {
    this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.distance * Math.pow(1.0015, direction * 100)));
  }
  toggle(): void { if (this.isOpen) this.close(); else this.open(); }
  close(): void {
    this.window.root.style.display = "none";
    this.active = false;
    this.stop();
    this.holograms.reset();
    this.markerOverlay.clearTooltip();
  }
  dispose(): void {
    this.close();
    this.coneModels.dispose();
    removeEventListener("keydown", this.onModifiers);
    removeEventListener("keyup", this.onModifiers);
    this.renderer?.dispose();
    this.window.root.remove();
  }
  open(): void {
    if (this.detached) { this.host.appendChild(this.window.root); this.detached = false; }
    this.window.root.style.display = "";
    this.active = true;
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
    this.holograms.reset();
    this.root.clear();
    this.markerPoi = null;
    this.counts = { planets: 0, moons: 0, orbits: 0, stargates: 0 };
    for (const marker of this.markers) this.markerOverlay.remove(marker);
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
    const markerIDs: number[] = [];
    for (const c of all) {
      if (c.groupID === null || !MARKER_GROUPS.has(c.groupID)) continue;
      const el = document.createElement("div");
      el.className = "ssm-marker";
      const icon = bracketIcon({ typeID: c.typeID, groupID: c.groupID, categoryID: c.categoryID });
      el.innerHTML = `<img class="ssm-frame" alt="" src="${clientTexture("res:/UI/Texture/classes/Bracket/selectionCircle.png")}">${icon ? `<img class="ssm-icon" alt="" src="${icon}">` : ""}<span class="ssm-label"></span>`;
      const at = mapPoint(c.position);
      const select = () => {
        if (this.hooks.scanTowards?.(c.position)) return;
        this.hooks.selectCelestial?.();
        this.markerPoi = at;
        this.poiTween = { from: this.poi.clone(), start: performance.now(), duration: 350 };
      };
      this.markers.push(this.markerOverlay.add({ kind: "celestial", groupID: c.groupID, at, el, select,
        displayName: () => this.hooks.markerName?.(c.itemID) ?? "",
        label: () => this.hooks.label?.(c.itemID) ?? "" }));
      markerIDs.push(c.itemID);
    }
    this.hooks.primeNames?.(markerIDs);
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
      this.yaw = yaw0 + (m.clientX - x0) * 0.005; // the mirrored canvas: the drag's sense kept on screen
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
    const cone = this.hooks.dscanCone?.() ?? null;
    const cameraMode = cone?.cameraMode === true && ego !== null;
    if (cameraMode !== this.wasCameraMode) {
      this.wasCameraMode = cameraMode;
      if (cameraMode) this.markerPoi = null;
      this.poiTween = { from: this.poi.clone(), start: performance.now(), duration: 350 };
    }
    const target = this.markerPoi ?? (cameraMode && ego ? mapPoint(ego) : new THREE.Vector3());
    if (this.poiTween) {
      const t = Math.min(1, (performance.now() - this.poiTween.start) / this.poiTween.duration);
      this.poi.lerpVectors(this.poiTween.from, target, t * t * (3 - 2 * t));
      if (t >= 1) this.poiTween = null;
    } else this.poi.copy(target);
    // In Camera mode the active map drives the space camera. While V is held or the map is inactive,
    // the space camera drives the map instead.
    let direction = cone ? mapPoint(cone.direction).normalize() : null;
    const mapDrivesCamera = cameraMode && this.active && !this.window.root.classList.contains("minimized")
      && !this.hooks.scanShortcutHeld?.();
    if (cameraMode && !mapDrivesCamera && direction?.lengthSq()) {
      this.pitchTween = null;
      const sideways = Math.hypot(direction.x, direction.z);
      if (sideways > 1e-7) this.yaw = Math.atan2(-direction.x, -direction.z);
      this.pitch = Math.atan2(sideways, -direction.y);
    }
    // the pitch from straight above: the camera's height the cosine, its reach out the sine
    const out = Math.sin(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * out * this.distance, Math.cos(this.pitch) * this.distance, Math.cos(this.yaw) * out * this.distance).add(this.poi);
    this.camera.lookAt(this.poi);
    this.camera.updateMatrixWorld();
    if (mapDrivesCamera) {
      direction = this.camera.getWorldDirection(new THREE.Vector3());
      this.hooks.aimSpaceCamera?.(direction);
    }
    this.updateCone(ego, cone, direction);
    this.updateProbes();
    const inCone = !!(ego && cone?.shown && direction);
    if (!inCone && this.holograms.root.visible) this.holograms.clear();
    this.holograms.root.visible = inCone;
    if (inCone) this.holograms.update(performance.now());
    this.renderer.render(this.scene, this.camera);
    // the markers on their map points (behind the camera: hidden)
    const v = new THREE.Vector3();
    const delta = new THREE.Vector3();
    const origin = ego ? mapPoint(ego) : null;
    const rangeSq = ((cone?.rangeMetres ?? 0) * SOLARSYSTEM_SCALE) ** 2;
    const minDotSq = Math.cos((cone?.angleDeg ?? 0) * Math.PI / 360) ** 2;
    const visible: MapMarker[] = [];
    for (const m of [...this.markers, ...this.resultMarkers, ...Array.from(this.probeObjects.values(), (probe) => probe.marker)]) {
      let highlighted = false;
      if (inCone && !m.partial) {
        delta.copy(m.at).sub(origin!);
        const lenSq = delta.lengthSq();
        const dot = delta.dot(direction!);
        const angle = cone!.angleDeg;
        highlighted = lenSq > 0 && lenSq <= rangeSq
          && (angle >= 360 || (dot >= 0 && (angle >= 180 || dot * dot >= minDotSq * lenSq)));
      }
      m.highlighted = highlighted;
      m.el.classList.toggle("dscan-shape", m.highlighted);
      v.copy(m.at).project(this.screenCam);
      const shown = v.z < 1 && v.z > -1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      m.el.style.display = shown ? "" : "none";
      if (!shown) continue;
      m.x = ((v.x + 1) / 2) * w;
      m.y = ((1 - v.y) / 2) * h;
      m.cameraDistance = m.at.distanceToSquared(this.camera.position);
      m.el.style.transform = `translate(${Math.round(m.x) - 7}px, ${Math.round(m.y) - 7}px)`;
      visible.push(m);
    }
    this.markerOverlay.update(visible, performance.now());
  }

  /** DrawDirectionalScanCone: the shape by the angle, rebuilt where the angle or range changes; placed at the ship and
   * turned to the scan's direction each frame. */
  private updateCone(ego: MapCelestial["position"] | null,
    cone: ReturnType<NonNullable<SolarSystemMapHooks["dscanCone"]>>, direction: THREE.Vector3 | null): void {
    this.coneGroup.visible = !!cone && cone.shown && ego !== null;
    if (!cone || !ego || !this.coneGroup.visible) return;
    const kind: ScanConeKind = cone.angleDeg < 180 ? "cone" : cone.angleDeg < 360 ? "half" : "sphere";
    const range = cone.rangeMetres * SOLARSYSTEM_SCALE;
    const half = cone.angleDeg * Math.PI / 360;
    const length = kind === "cone" ? range * Math.cos(half) : range;
    const radius = kind === "cone" ? range * Math.sin(half) : range;
    this.coneFallback.visible = !this.coneModels.update(kind, length, radius);
    const lineTexture = this.coneModels.lineTexture;
    const key = `${cone.angleDeg}:${Math.round(cone.rangeMetres)}:${lineTexture !== null}`;
    if (key !== this.coneFor) {
      this.coneFor = key;
      const materials = new Set<THREE.Material>();
      for (const group of [this.coneLines, this.coneFallback]) {
        for (const child of group.children as (THREE.Mesh | THREE.Line)[]) {
          child.geometry.dispose();
          for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
        }
        group.clear();
      }
      for (const material of materials) material.dispose();
      if (this.coneFallback.visible) {
        let geometry: THREE.BufferGeometry;
        if (kind === "cone") {
          geometry = new THREE.ConeGeometry(radius, length, 48, 1, true).rotateX(Math.PI).translate(0, length / 2, 0);
        } else {
          geometry = new THREE.SphereGeometry(range, 48, 32, 0, Math.PI * 2, 0, kind === "half" ? Math.PI / 2 : Math.PI);
        }
        const surface = new THREE.MeshBasicMaterial({ color: COLOR_DSCAN, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
          depthWrite: false, blending: THREE.AdditiveBlending });
        this.coneFallback.add(new THREE.Mesh(geometry, surface));
      }
      if (kind === "cone") {
        // Native LINE_WIDTH is 3500 before the line set's scale of one million and the map's scale.
        const { mesh, rings } = scanConeLines(half * 2, range, AU_M * SOLARSYSTEM_SCALE, 3500 * 1e6 * SOLARSYSTEM_SCALE, lineTexture);
        this.coneLines.add(mesh);
        this.coneInfo = { kind: "cone", rings, length, radius };
      } else {
        this.coneInfo = { kind, rings: 0, length, radius };
      }
    }
    this.coneGroup.position.copy(mapPoint(ego));
    if (direction?.lengthSq()) {
      // GetRotationQuat has zero roll. Reflect the native yaw and pitch and fold in its cone transform.
      const yaw = Math.atan2(direction.z, -direction.x) + Math.PI / 2;
      const pitch = -Math.atan2(Math.hypot(direction.x, direction.z), direction.y);
      this.coneGroup.rotation.set(pitch, yaw, 0, "YXZ");
    }
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
        const el = document.createElement("div");
        el.className = "ssm-marker ssm-probe";
        const icon = bracketIcon({ typeID: null, groupID: 479, categoryID: null });
        el.innerHTML = `${icon ? `<img class="ssm-icon" alt="" src="${icon}">` : "<span class=\"ssm-icon\"></span>"}<span class="ssm-label"></span>`;
        const at = new THREE.Vector3();
        const marker = this.markerOverlay.add({ kind: "probe", at, el, label: () => {
          const ego = this.hooks.ego();
          const distance = ego ? at.distanceTo(mapPoint(ego)) / SOLARSYSTEM_SCALE : null;
          return this.hooks.probeLabel?.(p.probeID, distance) ?? "";
        } });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: PROBE_COLOR.clone().multiplyScalar(0.3), depthWrite: false }));
        this.probeGroup.add(sphere, line);
        o = { sphere, marker, line, range: 0 };
        this.probeObjects.set(p.probeID, o);
      }
      const at = mapPoint({ x: p.pos[0], y: p.pos[1], z: p.pos[2] });
      const dest = this.preview.get(p.probeID) ?? p.destination;
      const to = mapPoint({ x: dest[0], y: dest[1], z: dest[2] });
      const radius = (this.previewRange.get(p.probeID) ?? p.scanRange) * SOLARSYSTEM_SCALE;
      const edge = this.hover?.kind === "range" && this.hover.id === p.probeID;
      ((o.sphere.children[0] as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = edge || this.moving?.id === p.probeID ? 0.6 : 0.25;
      o.sphere.position.copy(to);
      o.sphere.scale.setScalar(Math.max(radius, 1e-6));
      o.marker.at.copy(at);
      // probeStateMoving 2, probeStateWarping 3: on its way
      const moving = p.state === 2 || p.state === 3;
      o.line.visible = moving;
      if (moving) o.line.geometry.setFromPoints([at, to]);
      this.probeInfo.push({ probeID: p.probeID, at: [at.x, at.y, at.z], to: [to.x, to.y, to.z], radius, moving });
    }
    for (const [id, o] of this.probeObjects) {
      if (seen.has(id)) continue;
      this.probeGroup.remove(o.sphere, o.line);
      this.markerOverlay.remove(o.marker);
      this.probeObjects.delete(id);
    }
    this.updateCursors(probes);
    this.updateIntersections(probes);
    this.updateResults();
  }

  /** UpdateScanResult: the shown results drawn anew where they change; the dashes moved each frame. */
  private updateResults(): void {
    const results = this.hooks.scanResults?.() ?? [];
    const selected = this.hooks.selectedSites?.() ?? new Set<string>();
    const key = JSON.stringify([results.map((r) => [r.id, r.certainty, r.data, r.pos]), [...selected].sort()]);
    for (const d of this.resultDashes) (d as unknown as { dashOffset: number }).dashOffset = -((performance.now() / 1000) * 0.05) % 1;
    if (key === this.resultsFor) return;
    this.resultsFor = key;
    this.resultGroup.clear();
    for (const m of this.resultMarkers) this.markerOverlay.remove(m);
    this.resultMarkers = [];
    this.resultDashes = [];
    const info = { spheres: 0, circles: 0, lines: 0, markers: 0, selected: 0 };
    this.perfectReached = results.filter((r) => r.certainty >= 1 && (this.lastCertainty.get(r.id) ?? 1) < 1).map((r) => r.id);
    this.lastCertainty = new Map(results.map((r) => [r.id, r.certainty]));
    const at = (v: readonly number[]) => mapPoint({ x: v[0]!, y: v[1]!, z: v[2]! });
    const dashed = (length: number, isSelected: boolean) => {
      // LINE_DASH_LENGTH / length: the dashes' share of the line; UpdateSelectedObjects' colour
      const m = new THREE.LineDashedMaterial({ color: isSelected ? CIRCLE_COLOR_SELECTED : CIRCLE_COLOR, transparent: true,
        opacity: isSelected ? 0.7 : 0.5, dashSize: length / 40, gapSize: length / 40, depthWrite: false });
      this.resultDashes.push(m);
      return m;
    };
    const marker = (place: THREE.Vector3, r: MapScanResult, location: boolean) => {
      const el = document.createElement("div");
      el.className = "ssm-marker ssm-result";
      el.classList.toggle("selected", selected.has(r.id));
      const icon = location || r.strengthAttributeID === null ? undefined : RESULT_ICONS[r.strengthAttributeID];
      el.innerHTML = `<img class="ssm-frame" alt="" src="${clientTexture("res:/UI/Texture/classes/Bracket/selectionCircle.png")}"><span class="ssm-result-icon"></span><span class="ssm-label">${r.id}</span>`;
      el.style.setProperty("--result-icon", `url(${clientTexture(icon ?? "res:/UI/Texture/classes/MapView/scanResultLocation.png")})`);
      el.style.setProperty("--result-colour", resultColour(r.certainty));
      // GetMarkerOpacity: a selected site's marker whole, the others at 0.6
      el.style.opacity = selected.has(r.id) ? "1" : "0.6";
      if (selected.has(r.id)) {
        // ConstructGauge / UpdateCircularGauge
        const rgb = resultRgb(r.certainty);
        const start = withBrightness(rgb, Math.max(...rgb) * 0.8);
        const gauge = document.createElement("div");
        gauge.className = "ssm-gauge";
        gauge.innerHTML = `<img alt="" src="${clientTexture("res:/UI/Texture/Shared/CircularGradient.png")}"><span class="ssm-gauge-ring"></span>`;
        const ring = gauge.querySelector<HTMLElement>(".ssm-gauge-ring")!;
        const turn = Math.max(0, Math.min(1, r.certainty)) * 360;
        ring.style.background = `conic-gradient(from 0deg, ${rgbCss(start)} 0deg, ${rgbCss(rgb)} ${turn}deg, ${rgbCss(withBrightness(rgb, 0.4))} ${turn}deg 360deg)`;
        gauge.dataset.value = String(r.certainty);
        el.appendChild(gauge);
      }
      if (this.perfectReached.includes(r.id)) {
        // AnimPerfectResult: the gauge blinked in, and two circles grown out
        el.classList.add("perfect");
        for (const delay of [0.25, 0.65]) {
          const c = document.createElement("span");
          c.className = "ssm-perfect-ring";
          c.style.animationDelay = `${delay}s`;
          el.appendChild(c);
        }
      }
      this.resultMarkers.push(this.markerOverlay.add({ kind: "result", at: place, el, partial: r.certainty < 1,
        label: () => this.hooks.resultLabel?.(r.id) ?? r.id,
        select: (e) => this.hooks.selectSite?.(r.id, e.shiftKey || e.ctrlKey),
        contextMenu: (e) => { e.preventDefault(); e.stopPropagation(); this.openResultMenu(r.id, e.clientX, e.clientY); } }));
      info.markers += 1;
    };
    for (const r of results) {
      const data = r.data;
      const isSelected = selected.has(r.id);
      if (isSelected) info.selected += 1;
      if (typeof data === "number") {
        if (!r.pos) continue;
        // CreateSphereResult: the deviation's sphere at the guess
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(isSelected ? 0.4 : 0.15, 0, 0),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        sphere.position.copy(at(r.pos));
        sphere.scale.setScalar(Math.max(1e-6, data * SOLARSYSTEM_SCALE));
        this.resultGroup.add(sphere);
        info.spheres += 1;
        marker(at(r.pos), r, true);
      } else if (data !== null && !Array.isArray(data)) {
        // CreateCircleResult: the ring at the point, in the plane of the normal
        const c = data as { point: readonly number[]; radius: number; normal: readonly number[] };
        const radius = c.radius * SOLARSYSTEM_SCALE;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)); }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), dashed(2 * Math.PI * radius, isSelected));
        ring.computeLineDistances();
        ring.position.copy(at(c.point));
        const normal = at(c.normal).normalize();
        if (normal.lengthSq() > 0) ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        this.resultGroup.add(ring);
        info.circles += 1;
        marker(at(c.point), r, true);
      } else if (Array.isArray(data) && data.length === 3 && typeof data[0] === "number") {
        marker(at(data as readonly number[]), r, false);
      } else if (Array.isArray(data)) {
        // CreatePointResult: a marker at each place, and a line between two (_DrawPointResultLines)
        const places = (data as readonly (readonly number[])[]).map((p) => at(p));
        for (const p of places) marker(p, r, false);
        if (places.length > 1) {
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([places[0]!, places[1]!]), dashed(places[0]!.distanceTo(places[1]!), isSelected));
          line.computeLineDistances();
          this.resultGroup.add(line);
          info.lines += 1;
        }
      }
    }
    this.resultInfo = info;
  }

  /** HighlightProbeIntersections(showAll): shown while a probe is moved with Shift or the formation spread. */
  private updateIntersections(probes: readonly MapProbe[]): void {
    const mv = this.moving;
    const showAll = mv !== null && (mv.mode === "spread" || (mv.mode === "position" && (mv.shift || this.shiftHeld)));
    const now = performance.now();
    const seen = new Set<string>();
    if (showAll) {
      const active = probes.filter((p) => p.state !== 0).map((p) => p.probeID).sort((a, b) => a - b);
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = this.probeObjects.get(active[i]!), b = this.probeObjects.get(active[j]!);
          if (!a || !b) continue;
          const p1 = a.sphere.position, p2 = b.sphere.position, r1 = a.sphere.scale.x, r2 = b.sphere.scale.x;
          const d = p1.distanceTo(p2);
          const circle = isIntersecting(d, r1, r2) ? highlightCircle(d, r1, r2) : null;
          if (!circle) continue;
          const key = `${active[i]}:${active[j]}`;
          seen.add(key);
          let o = this.intersections.get(key);
          if (!o) {
            this.intersectionTexture ??= new THREE.TextureLoader().load(clientTexture("res:/UI/Texture/classes/ProbeScanner/intersectionCircle.png"));
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.intersectionTexture, color: PROBE_COLOR,
              transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
            this.intersectionGroup.add(mesh);
            o = { mesh, config: "", changedAt: now };
            this.intersections.set(key, o);
          }
          // SetIntersectionHighlight: a changed pair lit again
          const config = `${p1.x},${p1.y},${p1.z},${p2.x},${p2.y},${p2.z},${r1},${r2}`;
          if (config !== o.config) { o.config = config; o.changedAt = now; }
          const normal = p2.clone().sub(p1).normalize();
          o.mesh.position.copy(p1).addScaledVector(normal, circle.along);
          o.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
          o.mesh.scale.setScalar(circle.radius * 2);
        }
      }
    }
    this.intersectionInfo = [];
    for (const [key, o] of this.intersections) {
      if (!seen.has(key)) { this.intersectionGroup.remove(o.mesh); this.intersections.delete(key); continue; }
      // FadeOutIntersection: 500 ms after the last change, to the inactive opacity over 1.5 s
      const idle = now - o.changedAt - 500;
      const opacity = idle <= 0 ? INTERSECTION_ACTIVE : INTERSECTION_ACTIVE + (INTERSECTION_INACTIVE - INTERSECTION_ACTIVE) * Math.min(1, idle / 1500);
      (o.mesh.material as THREE.MeshBasicMaterial).color.copy(PROBE_COLOR).multiplyScalar(opacity);
      this.intersectionInfo.push({ pair: key, radius: o.mesh.scale.x / 2, opacity });
    }
  }

  /** An arrow in our own shape (probeCursor.red's cursorzshape): a shaft and a head along +y, tagged for picking. */
  private makeArrow(id: number, axis: Axis, kind: CursorKind): THREE.Group {
    const arrow = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: PROBE_COLOR, depthTest: false, transparent: true });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), material);
    shaft.position.y = 0.45;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 12), material);
    head.position.y = 0.95;
    for (const m of [shaft, head]) { m.userData = { cursor: id, axis, kind }; m.renderOrder = 3; }
    arrow.add(shaft, head);
    return arrow;
  }

  /** probeCursor.red: an arrow each way along x, y and z. */
  private makeCursor(id: number): THREE.Group {
    const group = new THREE.Group();
    for (const axis of AXES) {
      for (const sign of [1, -1]) {
        const arrow = this.makeArrow(id, axis, "position");
        arrow.userData = { axis, dir: AXIS_VECTOR[axis].clone().multiplyScalar(sign) };
        arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), arrow.userData.dir as THREE.Vector3);
        group.add(arrow);
      }
    }
    this.cursorGroup.add(group);
    return group;
  }

  /** probeSpreadCursor.red: cursorZ_1 and cursorZ_0, one toward the formation's centre and one away (SetFormationCenter). */
  private makeSpreadCursor(id: number): THREE.Group {
    const group = new THREE.Group();
    for (const sign of [1, -1]) {
      const arrow = this.makeArrow(id, "z", "spread");
      if (sign < 0) arrow.rotation.x = Math.PI;
      group.add(arrow);
    }
    this.cursorGroup.add(group);
    return group;
  }

  /** probeRangeCursor.red: a flattened sphere (400 x 400 x 50) on the range sphere's edge. */
  private makeRangeCursor(id: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 8), new THREE.MeshBasicMaterial({ color: PROBE_COLOR, depthTest: false, transparent: true }));
    mesh.scale.set(1, 1, 0.125);
    mesh.userData = { cursor: id, axis: "z", kind: "range" };
    mesh.renderOrder = 3;
    this.cursorGroup.add(mesh);
    return mesh;
  }

  /** CheckKeyState: Ctrl the spread, Alt the range, else the position. */
  private editMode(): CursorKind { return this.ctrlHeld ? "spread" : this.altHeld ? "range" : "position"; }

  /** UpdateProbeControlDisplay / HighlightCursors / UpdateArrowVisibility / ShowCentroidLines, each frame. */
  private updateCursors(probes: readonly MapProbe[]): void {
    const idle = probes.filter((p) => p.state === PROBE_IDLE);
    const mode = this.moving ? this.moving.mode : this.editMode();
    const shift = this.moving?.mode === "position" ? this.moving.shift : this.shiftHeld;
    const places = new Map<number, THREE.Vector3>();
    const radii = new Map<number, number>();
    for (const p of idle) {
      const d = this.preview.get(p.probeID) ?? p.destination;
      places.set(p.probeID, mapPoint({ x: d[0], y: d[1], z: d[2] }));
      radii.set(p.probeID, (this.previewRange.get(p.probeID) ?? p.scanRange) * SOLARSYSTEM_SCALE);
    }
    const center = new THREE.Vector3();
    if (idle.length > 0) {
      for (const v of places.values()) center.add(v);
      center.divideScalar(idle.length);
      places.set(CENTER_CURSOR, center.clone());
    }
    const away = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const active: Picked | null = this.moving ? { id: this.moving.id, axis: this.moving.axis, kind: this.moving.mode } : this.hover;
    const screen = (at: THREE.Vector3) => this.camera.position.distanceTo(at) * CURSOR_SCREEN;
    const colour = (mesh: THREE.Object3D, lit: boolean) => ((mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(lit ? CURSOR_ACTIVE_COLOR : PROBE_COLOR);
    let lit = 0;
    for (const [id, group] of this.cursors) if (!places.has(id)) { this.cursorGroup.remove(group); this.cursors.delete(id); }
    for (const [id, group] of this.spreadCursors) if (!radii.has(id)) { this.cursorGroup.remove(group); this.spreadCursors.delete(id); }
    for (const [id, mesh] of this.rangeCursors) if (!radii.has(id)) { this.cursorGroup.remove(mesh); this.rangeCursors.delete(id); }
    for (const [id, at] of places) {
      let group = this.cursors.get(id);
      if (!group) { group = this.makeCursor(id); this.cursors.set(id, group); }
      group.visible = mode === "position" && (id === CENTER_CURSOR ? !shift : shift);
      group.position.copy(at);
      group.scale.setScalar(screen(at));
      // HighlightCursors: the cursor pressed (or every one without Shift) lit on the axis
      const on = active !== null && active.kind === "position" && (active.id === id || (!shift && id === CENTER_CURSOR));
      for (const arrow of group.children) {
        const dir = arrow.userData.dir as THREE.Vector3;
        arrow.visible = Math.acos(Math.max(-1, Math.min(1, dir.dot(away)))) < 2.9;
        const lightUp = on && active!.axis === arrow.userData.axis;
        if (lightUp && group.visible && arrow.visible) lit += 1;
        for (const m of arrow.children) colour(m, lightUp);
      }
      if (id === CENTER_CURSOR) continue;
      const radius = radii.get(id)!;
      // the spread cursor turned to the formation's centre
      let spread = this.spreadCursors.get(id);
      if (!spread) { spread = this.makeSpreadCursor(id); this.spreadCursors.set(id, spread); }
      spread.visible = mode === "spread";
      spread.position.copy(at);
      spread.scale.setScalar(screen(at));
      const toCenter = center.clone().sub(at);
      if (toCenter.lengthSq() > 0) spread.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toCenter.normalize());
      const spreadLit = active !== null && active.kind === "spread" && (active.id === id || !this.shiftHeld);
      for (const arrow of spread.children) for (const m of arrow.children) colour(m, spreadLit);
      if (spreadLit && spread.visible) lit += 1;
      // the range cursor on the sphere's edge (SetRange: -range along the cursor's turned z, the map's -x)
      let range = this.rangeCursors.get(id);
      if (!range) { range = this.makeRangeCursor(id); this.rangeCursors.set(id, range); }
      range.visible = mode === "range";
      range.position.copy(at).add(new THREE.Vector3(-radius, 0, 0));
      range.scale.set(screen(range.position), screen(range.position), screen(range.position) * 0.125);
      range.quaternion.copy(this.camera.quaternion);
      const rangeLit = active !== null && active.kind === "range" && active.id === id;
      colour(range, rangeLit);
      if (rangeLit && range.visible) lit += 1;
    }
    // ShowCentroidLines: in the spread and range modes, a line from the centre to each idle probe
    const centroid: THREE.Vector3[] = [];
    if ((mode === "spread" || mode === "range") && idle.length > 0) for (const p of idle) centroid.push(center, places.get(p.probeID)!);
    this.centroidLines.geometry.setFromPoints(centroid);
    this.centroidLines.visible = centroid.length > 0;
    // ShowScanRanges: the dragged probe's eight range steps, facing the camera
    const scaling = this.moving?.mode === "range" ? this.moving : null;
    this.rangeRings.visible = scaling !== null;
    if (scaling) {
      const at = places.get(scaling.id);
      if (at) this.rangeRings.position.copy(at);
      this.rangeRings.quaternion.copy(this.camera.quaternion);
    }
    const c = places.get(CENTER_CURSOR);
    this.cursorInfo = { mode, center: !!c && mode === "position" && !shift, probes: mode === "position" && shift ? idle.length : 0,
      spread: mode === "spread" ? idle.length : 0, range: mode === "range" ? idle.length : 0, centroid: centroid.length / 2, lit,
      at: c ? [c.x, c.y, c.z] : null, rings: this.rangeRings.visible ? this.rangeRings.children.length : 0 };
  }

  /** The mouse ray in the map, from a pointer event. */
  private rayFrom(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.screenCam);
    return this.raycaster.ray.clone();
  }

  /** PickScene: the shown cursor under the mouse. */
  private pickCursor(e: { clientX: number; clientY: number }): Picked | null {
    this.rayFrom(e);
    const shown: THREE.Object3D[] = [];
    for (const group of [...this.cursors.values(), ...this.spreadCursors.values()]) {
      if (!group.visible) continue;
      for (const arrow of group.children) if (arrow.visible) shown.push(...arrow.children);
    }
    for (const mesh of this.rangeCursors.values()) if (mesh.visible) shown.push(mesh);
    const hit = this.raycaster.intersectObjects(shown, false)[0];
    return hit ? { id: hit.object.userData.cursor as number, axis: hit.object.userData.axis as Axis, kind: hit.object.userData.kind as CursorKind } : null;
  }

  /** PickProbes(pickBorder=True): the idle probe whose sphere's edge is within ten pixels of the mouse, nearest the edge. */
  private pickBorder(e: { clientX: number; clientY: number }): number | null {
    const ray = this.rayFrom(e);
    const aside = this.rayFrom({ clientX: e.clientX - 10, clientY: e.clientY });
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    let best: { id: number; off: number } | null = null;
    for (const p of this.hooks.probes?.() ?? []) {
      if (p.state !== PROBE_IDLE) continue;
      const o = this.probeObjects.get(p.probeID);
      if (!o) continue;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, o.sphere.position);
      const mouse = ray.intersectPlane(plane, new THREE.Vector3());
      const side = aside.intersectPlane(plane, new THREE.Vector3());
      if (!mouse || !side) continue;
      const rad = o.sphere.scale.x;
      const fromCenter = mouse.distanceTo(o.sphere.position);
      const pick = side.distanceTo(mouse);
      if (rad + pick > fromCenter && fromCenter > rad - pick) {
        const off = Math.abs(rad - fromCenter);
        if (!best || off < best.off) best = { id: p.probeID, off };
      }
    }
    return best?.id ?? null;
  }

  /** OnMouseDown: a cursor (or, moving the probes, a sphere's edge) pressed begins a move or a scaling. False where none was. */
  private pressCursor(e: PointerEvent): boolean {
    let picked = this.pickCursor(e);
    if (!picked && this.editMode() === "position") {
      const border = this.pickBorder(e);
      if (border !== null) picked = { id: border, axis: "z", kind: "range" };
    }
    if (!picked) return false;
    const ray = this.rayFrom(e);
    const probes = (this.hooks.probes?.() ?? []).filter((p) => p.state === PROBE_IDLE);
    if (probes.length === 0) return false;
    const base = new Map(probes.map((p) => [p.probeID, { dest: [...p.destination] as [number, number, number], range: p.scanRange, steps: p.rangeSteps ?? [] }]));
    const centerEve: [number, number, number] = [0, 0, 0];
    for (const b of base.values()) for (let i = 0; i < 3; i++) centerEve[i]! += b.dest[i]! / base.size;
    const centerMap = mapPoint({ x: centerEve[0], y: centerEve[1], z: centerEve[2] });
    const probeMap = picked.id === CENTER_CURSOR ? centerMap : (() => { const d = base.get(picked!.id)?.dest; return d ? mapPoint({ x: d[0], y: d[1], z: d[2] }) : centerMap; })();
    // the plane: along an axis for a move or a spread (GetAxisTargetPlaneNormal), facing the camera for a scaling
    const normal = picked.kind === "range" ? this.camera.getWorldDirection(new THREE.Vector3()) : axisTargetPlaneNormal(picked.axis, ray.direction);
    const meet = (at: THREE.Vector3) => ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at), new THREE.Vector3());
    const mouseP = meet(probeMap), mouseC = meet(centerMap);
    if (!mouseP || !mouseC) return false;
    this.moving = { mode: picked.kind, id: picked.id, axis: picked.axis, normal, at: probeMap, center: centerMap, centerEve, mouse: mouseP, mouseC,
      shift: picked.id !== CENTER_CURSOR, base };
    if (picked.kind === "range") {
      // ShowScanRanges: rings at the probe's eight range steps
      this.rangeRings.clear();
      for (const step of base.get(picked.id)?.steps ?? []) {
        const pts: THREE.Vector3[] = [];
        const r = step * SOLARSYSTEM_SCALE;
        for (let i = 0; i < 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
        this.rangeRings.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.ringMaterial));
      }
    }
    const move = (m: PointerEvent) => this.moveTo(m);
    const up = (u: PointerEvent) => {
      if (u.button !== 0) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      if (this.moving) this.registerMove();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    this.cancelHandlers = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    return true;
  }
  private cancelHandlers: (() => void) | null = null;

  /** MoveProbe (the position and the spread) and ScaleProbe (the range): the destinations and ranges a drag gives. */
  private moveTo(e: { clientX: number; clientY: number }): void {
    const mv = this.moving;
    if (!mv) return;
    const ray = this.rayFrom(e);
    const meet = (at: THREE.Vector3) => ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(mv.normal, at), new THREE.Vector3());
    const nowP = meet(mv.at), nowC = meet(mv.center);
    if (!nowP || !nowC) return;
    const preview = new Map<number, [number, number, number]>();
    const ranges = new Map<number, number>();
    const scaled = (d: readonly number[], scale: number): [number, number, number] =>
      [0, 1, 2].map((i) => mv.centerEve[i]! + (d[i]! - mv.centerEve[i]!) * scale) as [number, number, number];
    const centerScale = () => {
      const init = mv.mouseC.distanceTo(mv.center);
      return init > 0 ? nowC.distanceTo(mv.center) / init : 1;
    };
    if (mv.mode === "position") {
      // ClampVector: the move's part along the axis, in metres (the map's z is EVE's -z)
      const along = AXIS_VECTOR[mv.axis].clone().multiplyScalar(nowP.clone().sub(mv.mouse).dot(AXIS_VECTOR[mv.axis]));
      const diff = [along.x / SOLARSYSTEM_SCALE, along.y / SOLARSYSTEM_SCALE, -along.z / SOLARSYSTEM_SCALE];
      for (const [probeID, b] of mv.base) {
        if (mv.shift && probeID !== mv.id) continue;
        preview.set(probeID, [b.dest[0] + diff[0]!, b.dest[1] + diff[1]!, b.dest[2] + diff[2]!]);
      }
    } else if (mv.mode === "spread") {
      // the probes' places scaled about the centre by the mouse's distance from it (Shift: the pressed one alone)
      const scale = centerScale();
      for (const [probeID, b] of mv.base) {
        if (this.shiftHeld && probeID !== mv.id) continue;
        preview.set(probeID, scaled(b.dest, scale));
      }
    } else {
      // Shift: the pressed probe's range by the mouse's distance from it; else every probe's place and range about the centre
      if (this.shiftHeld) {
        const init = mv.mouse.distanceTo(mv.at);
        const b = mv.base.get(mv.id);
        if (b && init > 0) ranges.set(mv.id, b.range * (nowP.distanceTo(mv.at) / init));
      } else {
        const scale = centerScale();
        for (const [probeID, b] of mv.base) {
          preview.set(probeID, scaled(b.dest, scale));
          ranges.set(probeID, b.range * scale);
        }
      }
    }
    this.preview = preview;
    this.previewRange = ranges;
  }

  /** RegisterProbeMove (each idle probe moved given its destination) and RegisterProbeScale (the range step nearest). */
  private registerMove(): void {
    const mv = this.moving!;
    this.moving = null;
    this.cancelHandlers = null;
    let moves: ProbeMove[] = [];
    if (mv.mode === "range") {
      const b = mv.base.get(mv.id);
      const desired = this.previewRange.get(mv.id);
      if (b && desired !== undefined && b.steps.length > 0) {
        const [step, size] = nearestRangeStep(b.steps, desired);
        if (this.shiftHeld) {
          // SetProbeRangeStep for the one
          moves = [{ probeID: mv.id, rangeStep: step }];
        } else {
          // ScaleAllProbes(size / current): each place about the centre, each range the step nearest its own scaled
          const scale = size / b.range;
          moves = [...mv.base].map(([probeID, o]) => ({ probeID,
            destination: [0, 1, 2].map((i) => mv.centerEve[i]! + (o.dest[i]! - mv.centerEve[i]!) * scale) as [number, number, number],
            rangeStep: o.steps.length > 0 ? nearestRangeStep(o.steps, o.range * scale)[0] : undefined }));
        }
      }
    } else {
      moves = [...this.preview].filter(([id, d]) => {
        const b = mv.base.get(id)?.dest;
        return b !== undefined && (b[0] !== d[0] || b[1] !== d[1] || b[2] !== d[2]);
      }).map(([probeID, destination]) => ({ probeID, destination }));
    }
    this.lastMoves = moves;
    this.rangeRings.visible = false;
    if (moves.length === 0) { this.preview = new Map(); this.previewRange = new Map(); return; }
    void Promise.resolve(this.hooks.moveProbes?.(moves)).catch(() => {}).finally(() => { this.preview = new Map(); this.previewRange = new Map(); });
  }
  private resultMenuEl: HTMLDivElement | null = null;
  /** GetMenu: the result's entries at the mouse, closed by a choice or a click elsewhere. */
  openResultMenu(siteID: string, x: number, y: number): void {
    this.closeResultMenu();
    const entries = this.hooks.resultMenu?.(siteID) ?? [];
    if (entries.length === 0) return;
    const menu = document.createElement("div");
    menu.className = "ssm-menu";
    const box = this.window.body.getBoundingClientRect();
    menu.style.left = `${Math.round(x - box.left)}px`;
    menu.style.top = `${Math.round(y - box.top)}px`;
    for (const entry of entries) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = entry.label;
      b.addEventListener("click", () => { this.closeResultMenu(); entry.run(); });
      menu.appendChild(b);
    }
    this.window.body.appendChild(menu);
    this.resultMenuEl = menu;
    const away = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) { this.closeResultMenu(); removeEventListener("pointerdown", away, true); } };
    addEventListener("pointerdown", away, true);
  }
  closeResultMenu(): void { this.resultMenuEl?.remove(); this.resultMenuEl = null; }
  /** The open menu's entries, for checks. */
  get resultMenuEntries(): string[] { return [...(this.resultMenuEl?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? ""); }

  /** The last move or scaling given, for checks. */
  lastMoves: ProbeMove[] = [];

  /** CancelProbeMoveOrScaling: the probes put back. */
  private cancelMove(): void {
    this.cancelHandlers?.();
    this.cancelHandlers = null;
    this.moving = null;
    this.preview = new Map();
    this.previewRange = new Map();
    this.rangeRings.visible = false;
  }

  /** OnDirectionalScanComplete -> ScanEffect: ScanPart_01, then ScanPart_02 when it ends. */
  scanEffect(result: DScanResult): void {
    if (!this.isOpen) return;
    this.coneModels.scan(performance.now());
    const ego = this.hooks.ego();
    if (!ego || !this.hooks.dscanCone?.()?.shown) return;
    const [x, y, z] = result.direction;
    this.holograms.scanned(result.rows, mapPoint(ego), new THREE.Vector3(x, y, -z).normalize(), result.rangeMetres * SOLARSYSTEM_SCALE);
  }

  hoverScanResult(typeID: number | null): void {
    const ego = this.hooks.ego();
    const cone = this.hooks.dscanCone?.();
    if (!this.isOpen || !ego || !cone?.shown) return;
    this.holograms.hover(typeID, mapPoint(ego), mapPoint(cone.direction).normalize(), cone.rangeMetres * SOLARSYSTEM_SCALE);
  }

  /** AnimBlinkDscanHilite starts at triple brightness and fades to the ordinary highlight. */
  scanStarted(): void {
    if (!this.isOpen) return;
    for (const marker of this.markerOverlay.layer.querySelectorAll(".dscan-shape")) {
      marker.animate([{ filter: "brightness(3)" }, { filter: "brightness(1)" }],
        { duration: 1000, easing: "ease-in-out", pseudoElement: "::after" });
    }
  }

  /** The camera's point of interest, for checks. */
  get pointOfInterest(): THREE.Vector3 { return this.poi.clone(); }
  /** The camera's distance from the point of interest, in the map's units. */
  get cameraDistance(): number { return this.distance; }
}
