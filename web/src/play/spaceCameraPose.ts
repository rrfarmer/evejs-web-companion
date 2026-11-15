import { Vector3 } from "three";

// baseCamera.IsValidEyePosition and cameraUtil.IsValidSpaceCameraPosition.
const MAX_CAMERA_COORDINATE = 1e38;
export const MAX_JUMP_CAMERA_COORDINATE = 1e12;

/** cameraUtil.GetInitialLookAtDistance, using the positive root. */
export function initialOrbitDistance(radius: number, nearest: number, farthest: number): number {
  const a = 1 / farthest ** 0.95, b = 0.55 / 2, c = -Math.max(radius, nearest);
  return -2 * c / (b + Math.sqrt(b * b - 4 * a * c));
}

/** subwaySvc.OnSpecialFX starts the stargate camera from the pilot's own departure. */
export function isOwnStargateDeparture(guids: readonly string[], shipID: number, start: boolean, ownShipID: number | null): boolean {
  return start && ownShipID !== null && shipID === ownShipID && guids.includes("effects.JumpOut");
}

export function validCameraPosition(value: Vector3, limit = MAX_CAMERA_COORDINATE): boolean {
  return Math.abs(value.x) <= limit && Math.abs(value.y) <= limit && Math.abs(value.z) <= limit;
}

/** Validate both ends before assigning either, as JumpCamera.SetEyeAndAtPosition does. */
export function setCameraPose(
  eye: Vector3,
  target: Vector3,
  nextEye: Vector3,
  nextTarget: Vector3,
  limit = MAX_CAMERA_COORDINATE,
): boolean {
  if (nextEye.equals(nextTarget) || !validCameraPosition(nextEye, limit) || !validCameraPosition(nextTarget, limit)) return false;
  eye.copy(nextEye);
  target.copy(nextTarget);
  return true;
}

/** Shift the pose in the current coordinate frame, retaining its direction and distance. */
export function translateCameraPose(
  eye: Vector3,
  target: Vector3,
  delta: Vector3,
  limit = MAX_CAMERA_COORDINATE,
): boolean {
  return setCameraPose(eye, target, eye.clone().add(delta), target.clone().add(delta), limit);
}

/** A coincident or invalid direction retains the current view when aiming or changing zoom. */
export function setCameraDistance(eye: Vector3, target: Vector3, direction: Vector3, distance: number): boolean {
  if (!validCameraPosition(direction) || direction.lengthSq() === 0 || !Number.isFinite(distance) || distance <= 0) return false;
  const next = target.clone().addScaledVector(direction.clone().normalize(), distance);
  return setCameraPose(eye, target, next, target);
}
