import { Quaternion, Vector3 } from "three";

export interface SmartLightPlane {
  rotation: number[];
  duration: number;
  delay: number;
  reverse: boolean;
  playtime: number;
  offsets?: { near: number; far: number; cascade: number; normalize: boolean };
}

export interface SmartLightSpawn {
  time: number;
  offset: number;
}

const float = Math.fround;
const modulus = 2_147_483_647;

/** A deterministic native spawn offset takes one minstd_rand sample per initial locator ID. */
function offsetRandom(index: number): number {
  const next = ((index % modulus || 1) * 48271) % modulus;
  return float(float(float(next) - 1) / (modulus + 1));
}

/** The schedule is indexed by the original locator order, even for a reverse sweep. */
export function smartLightPlaneSpawns(plane: SmartLightPlane, positions: readonly number[][]): SmartLightSpawn[] {
  if (!positions.length) return [];
  const axis = new Vector3(0, 1, 0).applyQuaternion(new Quaternion().fromArray(plane.rotation));
  const point = new Vector3();
  const projections = positions.map((p, index) => ({ index, projection: float(point.fromArray(p).dot(axis)) }));
  projections.sort((a, b) => a.projection - b.projection);
  const min = projections[0]!.projection;
  const span = projections[projections.length - 1]!.projection - min;
  if (plane.reverse) projections.reverse();
  const spawns: SmartLightSpawn[] = [];
  const duration = Math.max(0.01, plane.duration);
  const offsets = plane.offsets;
  const offsetSpan = offsets ? float(offsets.far - offsets.near) : 0;
  let normalized = 0;
  projections.forEach(({ index, projection }, rank) => {
    const fraction = span > 0 ? (projection - min) / span : 0;
    const time = plane.delay + duration * (plane.reverse ? 1 - fraction : fraction);
    let offset = 0;
    if (offsets?.normalize) {
      // The native accumulator adds one step before taking the remainder.
      normalized = float(normalized + float(offsetSpan / positions.length));
      offset = float(offsets.near + (offsetSpan ? normalized % offsetSpan : 0));
    } else if (offsets) {
      offset = float(float(offsets.near + float(offsetSpan * offsetRandom(index))) + float(rank * offsets.cascade));
    }
    spawns[index] = { time, offset };
  });
  return spawns;
}
