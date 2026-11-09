// The client's hangar camera and ship bobbing as numbers (eve/client/script/ui/camera/hangarCamera.py, baseCamera.py,
// cameraUtil.py; station/navigation.py's idle thread; hangarBehaviours/baseHangarBehaviours.py ApplyShipBobbing and
// defaultHangarBehaviours.py OnAnimShipEntryEnd). Pitch is the angle of the eye from straight above (OrbitControls'
// polar angle); yaw turns the other way from OrbitControls' azimuth in our z-mirrored world (azimuth = -yaw).

/** HangarCamera.kMaxPitch: a little below level at most. BaseCamera.kMinPitch: almost straight above. */
export const MAX_PITCH = Math.PI / 2 + Math.PI / 50;
export const MIN_PITCH = 0.05;
/** HangarCamera.hangarMinZoom (the farthest the camera goes) and hangarMaxZoom (the nearest floor). */
export const FARTHEST = 2050;
export const NEAREST_FLOOR = 10;
/** BaseCamera.kZoomPower: the zoom proportion's curve. */
const ZOOM_POWER = 9;
/** cameraUtil.FOV_MIN. */
const FOV_MIN = 0.55;
/** BaseCamera.default_fov and HangarCamera.HaAnimFov[0], in radians (vertical). */
export const FOV = 1.0;
const ENTRY_FOV = 0.7;
/** HangarCamera.__init__ and the hangars' default dockCameraSettings: the swing's yaw, pitch, zoom (times
 * GetInitialLookAtDistance) and starting fov. A hangar may give its own (hangarRegistry.pickDockSwing). */
export interface Swing { yaw: readonly [number, number]; pitch: readonly [number, number]; zoom: readonly [number, number]; fov: number }
export const DEFAULT_SWING: Swing = { yaw: [14 * Math.PI / 8, 9 * Math.PI / 8], pitch: [7 * Math.PI / 16, MAX_PITCH], zoom: [1.2, 2.0], fov: ENTRY_FOV };
/** A dockCameraSettings row [weight, yaw0, yaw1, pitch0, pitch1, zoom0, zoom1, fov] as a swing. */
export function swingOf(row: readonly number[]): Swing {
  return { yaw: [row[1]!, row[2]!], pitch: [row[3]!, row[4]!], zoom: [row[5]!, row[6]!], fov: row[7]! };
}
/** hangarView's docking animation: five seconds (AnimEnterHangar's default duration). */
export const ENTRY_SECONDS = 5;
/** navigation._IdleThread: idleTimer 1e9 blue ticks (100 s) without input starts StartIdleAnimation. */
export const IDLE_AFTER_SECONDS = 100;
/** StartIdleAnimation: a whole turn of yaw (decreasing) in 240 s, repeating; pitch and zoom settle in 16 s. */
const IDLE_TURN_SECONDS = 240;
const IDLE_SETTLE_SECONDS = 16;
const IDLE_PITCH = MAX_PITCH - Math.PI / 12;
const IDLE_ZOOM = 0.65;

/**
 * UpdateMinMaxZoom: the nearest the camera comes (maxZoom) and the farthest (minZoom), in metres; the farthest is the
 * hangar's maxCameraDistance locator's length where it has one (hangarView.LoadCamera), else 2050.
 */
export function zoomLimits(radius: number, centreDistance: number, farthest = FARTHEST): { near: number; far: number } {
  let near = Math.max(NEAREST_FLOOR, 1.5 * (radius + centreDistance));
  if (near >= farthest) near = 0.999 * farthest;
  return { near, far: farthest };
}

/** GetZoomDistanceByZoomProportion. */
export function distanceAt(p: number, near: number, far: number): number {
  return near + p ** ZOOM_POWER * (far - near);
}

/** GetZoomProportionByZoomDistance. */
export function proportionAt(d: number, near: number, far: number): number {
  if (Math.abs(far - near) < 1e-6) return 0;
  return Math.max(0, (d - near) / (far - near)) ** (1 / ZOOM_POWER);
}

/** cameraUtil.GetInitialLookAtDistance(maxZoom, minZoom): the positive root of a x^2 + b x - r. */
export function initialLookAt(near: number, far: number): number {
  const a = 1 / far ** 0.95, b = FOV_MIN / 2, c = -near;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The camera at a moment of the entry animation (t in 0..1): yaw, pitch, distance and fov. */
export function entryAt(t: number, near: number, far: number, swing: Swing = DEFAULT_SWING): { yaw: number; pitch: number; distance: number; fov: number } {
  const dist = initialLookAt(near, far);
  const p0 = proportionAt(swing.zoom[0] * dist, near, far), p1 = Math.min(proportionAt(swing.zoom[1] * dist, near, far), 1);
  // _AnimZoom: linear keys with the first key's tangent set to 0 (a Hermite from rest)
  const p = p0 + (p1 - p0) * (2 * t * t - t * t * t);
  // _AnimEnterHangarFOV: held at 0.7, then to the default over the last 45%
  const fovT = Math.max(0, (t - 0.55) / 0.45);
  return {
    yaw: lerp(swing.yaw[0], swing.yaw[1], smooth(t)),
    // SetPitch clamps to the camera's limits
    pitch: Math.min(MAX_PITCH, Math.max(MIN_PITCH, lerp(swing.pitch[0], swing.pitch[1], smooth(t)))),
    distance: distanceAt(p, near, far),
    fov: lerp(swing.fov, FOV, smooth(fovT)),
  };
}

/** The idle animation a moment on (seconds since it began), from where the camera was when it began. */
export function idleAt(s: number, from: { yaw: number; pitch: number; distance: number }, near: number, far: number): { yaw: number; pitch: number; distance: number } {
  const settle = smooth(Math.min(1, s / IDLE_SETTLE_SECONDS));
  return {
    yaw: from.yaw - (2 * Math.PI * s) / IDLE_TURN_SECONDS,
    pitch: lerp(from.pitch, IDLE_PITCH, settle),
    distance: distanceAt(lerp(proportionAt(from.distance, near, far), IDLE_ZOOM, settle), near, far),
  };
}

/**
 * OnAnimShipEntryEnd and ApplyShipBobbing: the ship rises and falls by min(100 m, 5% of its radius) over a cycle of its
 * radius in seconds (10 to 300), keyed at the rest, the bottom (a quarter), the top (three quarters) and the rest.
 */
export function bobAt(s: number, radius: number): number {
  const delta = Math.min(100, radius * 0.05);
  const cycle = Math.min(300, Math.max(10, radius));
  return -delta * Math.sin((2 * Math.PI * s) / cycle);
}
