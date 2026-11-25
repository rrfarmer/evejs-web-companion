// The space camera's shake, as the client's: camera.ShakeCamera(magnitude, position) (spaceCamera.py) makes a behaviour
// from the magnitude and the eye's distance to the place (evecamera/utils.py CreateBehaviorFromMagnitudeAndPosition: a
// noise scale curve and a damping curve, Hermite keys with flat tangents, over 2 x (magnitude / 400)^0.7 seconds; one
// weaker than the shake under way is left out), and each frame the camera's noise offset (baseSpaceCamera.py
// _UpdateCameraNoiseOffset) walks at random in x and y, damped, at most 160 each way, and moves the point looked at
// that much across the view (scaled by the zoom distance / 100 and the curve's scale).

import * as THREE from "three";

/** MAX_NOISE (baseSpaceCamera.py). */
const MAX_NOISE = 160;
// Ballpark::mWarpSpeed, the park-wide reference used by Warp.ShakeCamera in 3698585.
const WARP_SHAKE_SPEED = 2 * 149_597_870_700;
const DEFAULT_NOISE_DAMP = 1.1;
type Key = [time: number, value: number];

/** Tr2CurveScalar with Hermite keys and zero tangents: a smooth step between keys, held at the ends. */
export function hermiteFlat(keys: readonly Key[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!;
    if (t > t1) continue;
    const [t0, v0] = keys[i - 1]!;
    const s = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    return v0 + (v1 - v0) * s * s * (3 - 2 * s);
  }
  return keys[keys.length - 1]![1];
}

export class CameraShake {
  private scaleKeys: Key[] | null = null;
  private dampKeys: Key[] | null = null;
  private start = 0;
  private noiseScale = 0;
  private noiseDamp = DEFAULT_NOISE_DAMP;
  private x = 0;
  private y = 0;
  private warp: { start: number; from: number; peak: number } | null = null;
  private nextWarpRefresh = -Infinity;

  /** WarpLoop renews a linear envelope once per simulation second in the legacy tunnel. */
  updateWarp(active: boolean, speed: number, maxVelocity: number, sim: number): void {
    if (!active) {
      if (this.warp) {
        this.warp = null;
        this.noiseScale = 0;
      }
      this.nextWarpRefresh = -Infinity;
      return;
    }
    if (sim < this.nextWarpRefresh) return;
    const meanSpeed = Math.max(0, (speed - maxVelocity) / (WARP_SHAKE_SPEED - maxVelocity));
    const rumble = (0.3 - 0.5 * Math.cos(6.28 * meanSpeed ** 0.1)) / 0.8;
    this.warp = { start: sim, from: this.noiseScale, peak: 1.4 * Math.max(0, rumble) ** 0.8 };
    this.nextWarpRefresh = sim + 1000;
    this.scaleKeys = this.dampKeys = null;
    this.noiseDamp = DEFAULT_NOISE_DAMP;
  }

  /** CreateBehaviorFromMagnitudeAndPosition and ShakeController.DoCameraShake: `eye` and `at` in the same space. */
  shake(magnitude: number, at: THREE.Vector3, eye: THREE.Vector3, now = performance.now()): boolean {
    const timeFactor = Math.pow(magnitude / 400, 0.7);
    let distance = at.distanceTo(eye);
    if (Number.isNaN(distance)) return false;
    distance = Math.min(2_000_000_000, Math.max(700, distance));
    const m = (0.7 * magnitude) / Math.pow(distance, 0.7);
    const scale: Key[] = [[0, 1.2 * m], [0.1, 0.1 * m], [1.5 * timeFactor, 0.13 * m], [2 * timeFactor, 0]];
    // a shake under way that is stronger than this one's second key stays
    const current = this.warp ? this.noiseScale : this.scaleKeys ? hermiteFlat(this.scaleKeys, (now - this.start) / 1000) : 0;
    if (current > scale[1]![1]) return false;
    this.warp = null;
    this.scaleKeys = scale;
    this.dampKeys = [[0, 80 * m], [0.1, 20 * m], [1.5 * timeFactor, 0], [2 * timeFactor, 0]];
    this.start = now;
    return true;
  }

  /**
   * _UpdateCameraNoiseOffset: this frame's offset of the point looked at (null for none), from the eye, the point and
   * the frame's length in seconds.
   */
  offset(eye: THREE.Vector3, target: THREE.Vector3, dt: number, now = performance.now(), sim = now): THREE.Vector3 | null {
    if (this.warp) {
      const { start, from, peak } = this.warp;
      const t = Math.max(0, (sim - start) / 1000);
      this.noiseScale = t <= 0.5 ? THREE.MathUtils.lerp(from, peak, 2 * t) : peak * Math.max(0, (5 - t) / 4.5);
    } else if (this.scaleKeys) {
      const t = (now - this.start) / 1000;
      this.noiseScale = hermiteFlat(this.scaleKeys, t);
      if (this.dampKeys) this.noiseDamp = hermiteFlat(this.dampKeys, t);
      if (t >= this.scaleKeys[this.scaleKeys.length - 1]![0]) this.scaleKeys = null;
    } else return null;
    if (this.noiseScale === 0) return null;
    const d = Math.max(dt, 1e-3);
    this.x = Math.max(-MAX_NOISE, Math.min(MAX_NOISE, (this.x + this.noiseDamp * (Math.random() - 0.5)) / (1 + this.noiseDamp * d)));
    this.y = Math.max(-MAX_NOISE, Math.min(MAX_NOISE, (this.y + this.noiseDamp * (Math.random() - 0.5)) / (1 + this.noiseDamp * d)));
    const scale = (eye.distanceTo(target) / 100) * this.noiseScale;
    const dir = target.clone().sub(eye).normalize();
    const vx = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    const vy = new THREE.Vector3().crossVectors(dir, vx);
    return vx.multiplyScalar(this.x * scale).addScaledVector(vy, this.y * scale);
  }
}
