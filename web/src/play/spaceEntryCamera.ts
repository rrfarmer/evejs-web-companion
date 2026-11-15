import { MathUtils, Spherical, Vector3 } from "three";
import { initialOrbitDistance, validCameraPosition } from "./spaceCameraPose.ts";

export const ENTRY_CAMERA_DURATION_MS = 15_000;
const ENTRY_CAMERA_RANGE = 700_000; // BaseSpaceCamera.minZoom
const UP = new Vector3(0, 1, 0);

interface Planet {
  readonly position: Vector3;
  readonly radius: number;
}

export interface EntryCameraPath {
  eyeAt(elapsedMs: number): Vector3;
}

// carbonui's ANIM_SMOOTH uses a Hermite curve with zero tangents.
const progress = (elapsed: number, duration: number) => MathUtils.smoothstep(elapsed, 0, duration);

/** EnterSpaceCamera.AnimEnterFirstTimeEverInSpace, in the view's mirrored axes. */
function firstEntryPath(radius: number, ship: Vector3, planets: readonly Planet[]): EntryCameraPath | null {
  if (!validCameraPosition(ship) || ship.lengthSq() === 0) return null;
  let nearest: Planet | undefined;
  let distance = Infinity;
  for (const planet of planets) {
    if (!Number.isFinite(planet.radius) || planet.radius <= 0 || !validCameraPosition(planet.position)) continue;
    const next = ship.distanceToSquared(planet.position);
    if (next < distance) { nearest = planet; distance = next; }
  }
  if (!nearest) return null;
  const surface = nearest.position.clone().normalize().multiplyScalar(nearest.radius).applyAxisAngle(UP, Math.PI);
  const towardPlanet = nearest.position.clone().sub(surface).sub(ship);
  if (towardPlanet.lengthSq() === 0) return null;
  const start = ship.clone().normalize().multiplyScalar(5 * radius).addScaledVector(UP, radius / 2).applyAxisAngle(UP, -0.5);
  const end = towardPlanet.normalize().multiplyScalar(-5 * radius).addScaledVector(UP, radius);
  return { eyeAt: elapsed => start.clone().lerp(end, progress(elapsed, ENTRY_CAMERA_DURATION_MS)) };
}

/** The 15 s character-select camera. Void systems always use the returning-pilot path. */
export function spaceEntryCamera(
  hasEverWarped: boolean,
  systemID: number,
  radius: number,
  nearest: number,
  ship: Vector3,
  direction: Vector3,
  planets: readonly Planet[],
): EntryCameraPath | null {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(nearest) || nearest <= 0 || nearest >= ENTRY_CAMERA_RANGE) return null;
  if (!hasEverWarped && (systemID < 34_000_000 || systemID > 34_999_999)) {
    const path = firstEntryPath(radius, ship, planets);
    if (path) return path;
  }
  if (!validCameraPosition(direction) || direction.lengthSq() === 0) return null;
  const from = new Spherical().setFromVector3(direction);
  const distance = initialOrbitDistance(radius, nearest, ENTRY_CAMERA_RANGE);
  const zoom = (metres: number) => Math.max(0, (metres - nearest) / (ENTRY_CAMERA_RANGE - nearest)) ** (1 / 9);
  const start = zoom(5 * distance), end = zoom(distance);
  return {
    eyeAt(elapsed) {
      const t = progress(elapsed, ENTRY_CAMERA_DURATION_MS);
      const proportion = Math.min(1, MathUtils.lerp(start, end, progress(elapsed, ENTRY_CAMERA_DURATION_MS * 0.8)));
      const metres = nearest + proportion ** 9 * (ENTRY_CAMERA_RANGE - nearest);
      const phi = MathUtils.clamp(from.phi + t * Math.PI / 40, 0.05, Math.PI - 0.05);
      return new Vector3().setFromSphericalCoords(metres, phi, from.theta - t * Math.PI / 20);
    },
  };
}

/** BaseSpaceCamera.GetDynamicFovByDistance, converted to Three's vertical FOV. */
export function entryCameraFov(distance: number): number {
  return MathUtils.radToDeg(0.55 + MathUtils.clamp(distance / ENTRY_CAMERA_RANGE, 0, 1) ** 0.35 * (1.1 - 0.55));
}
