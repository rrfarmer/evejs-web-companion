import { MathUtils, Vector3 } from "three";
import { validCameraPosition } from "./spaceCameraPose.ts";

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const BOUNDS_RADIUS_MULTIPLIER = 20;

export interface ExplosionCameraPath {
  readonly motionMs: number;
  readonly returnMs: number;
  eyeAt(elapsedMs: number): Vector3;
  targetAt(pilot: Vector3, returnElapsedMs: number): Vector3;
}

/** CalculatePoints in build 3698585, relative to the exploding ball in mirrored space. */
export function spaceExplosionCamera(
  eye: Vector3, target: Vector3, pilot: Vector3, interestRadius: number, pilotRadius: number,
  fov: number, untilGlobalMs: number, random = Math.random(),
): ExplosionCameraPath | null {
  if (![eye, target, pilot].every(position => validCameraPosition(position))) return null;
  const distance = eye.distanceTo(target);
  if (!distance || !Number.isFinite(interestRadius) || !Number.isFinite(pilotRadius) ||
      !Number.isFinite(fov) || !Number.isFinite(untilGlobalMs)) return null;

  const p0 = eye.clone();
  if (distance > pilot.length() || pilot.lengthSq() === 0) {
    const returnMs = 3_000;
    return {
      motionMs: 0, returnMs,
      eyeAt: () => p0.clone(),
      targetAt: (destination, elapsed) => target.clone().lerp(destination, MathUtils.smoothstep(elapsed, 0, returnMs)),
    };
  }

  // The native X and Y rotations run in the unmirrored axes.
  const angle = -fov * 0.65;
  const split = random * 0.5;
  const direction = new Vector3(pilot.x, pilot.y, -pilot.z).normalize()
    .applyAxisAngle(X, angle * split).applyAxisAngle(Y, angle * (0.5 - split));
  direction.z *= -1;
  const p3 = pilot.clone().addScaledVector(direction, Math.max(distance, pilotRadius * 5));
  const orbit = pilot.lengthSq() < pilot.distanceToSquared(p0);
  const bounds = interestRadius * BOUNDS_RADIUS_MULTIPLIER;
  let p1: Vector3, p2: Vector3;
  if (distance >= bounds && !orbit) {
    p1 = p0.clone().lerp(p3, 0.1);
    p2 = p0.clone().lerp(p3, 0.2);
  } else {
    const eyeToAt = target.clone().sub(p0);
    const closest = p0.clone().addScaledVector(eyeToAt, p3.clone().sub(p0).dot(eyeToAt) / eyeToAt.lengthSq());
    const perpendicular = p3.clone().sub(closest).normalize();
    const turn = target.clone().addScaledVector(perpendicular, distance);
    if (distance >= bounds) {
      p2 = turn;
    } else {
      const lengthToBounds = Math.sqrt(bounds ** 2 - distance ** 2);
      const toP3 = p3.clone().sub(turn);
      p2 = toP3.length() < lengthToBounds ? p3 : (orbit ? turn : target).clone().addScaledVector(toP3.normalize(), lengthToBounds);
    }
    p1 = orbit && distance < bounds ? turn : p0.clone().lerp(p2, 0.5);
  }

  const splineMs = Math.max(0, untilGlobalMs * 1.2);
  const velocity = p0.distanceTo(p2) / Math.max(splineMs, 100);
  const retreatDistance = p2.distanceTo(p3);
  const retreatMs = retreatDistance ? Math.min(retreatDistance / velocity, 5_000) : 0;
  const motionMs = splineMs + retreatMs;
  const returnMs = 5_000;
  return {
    motionMs, returnMs,
    eyeAt(elapsed) {
      if (elapsed < splineMs) {
        const t = Math.max(0, elapsed / splineMs);
        return p0.clone().multiplyScalar((1 - t) ** 2)
          .addScaledVector(p1, 2 * t * (1 - t)).addScaledVector(p2, t ** 2);
      }
      const t = retreatMs ? MathUtils.clamp((elapsed - splineMs) / retreatMs, 0, 1) : 1;
      return p2.clone().lerp(p3, t);
    },
    targetAt: (destination, elapsed) => destination.clone().multiplyScalar(MathUtils.smoothstep(elapsed, 0, returnMs)),
  };
}

/** BaseCamera.FovUpdateThread with the default camera inertia. */
export function explosionCameraFov(fov: number, dt: number): number {
  const target = MathUtils.radToDeg(1);
  const delta = target - fov;
  const step = Math.min(Math.abs(delta), Math.max(Math.abs(delta), MathUtils.radToDeg(0.001)) * 10 * dt);
  return fov + Math.sign(delta) * step;
}
