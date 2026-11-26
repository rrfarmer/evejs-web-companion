import { Quaternion, Vector3 } from "three";
import { shipSkinrRecord as record, shipSkinrCoatingID } from "./shipSkinrCoatings.ts";
import type { ShipSkinrCoating, ShipSkinrCoatingSlot } from "./shipSkinrCoatings.ts";
import type { JsonValue } from "./wire.ts";
import type { SofPatternLayer, TypeModelInfo } from "../three/hullModel.ts";

export interface ShipSkinrPattern {
  readonly id: number;
  readonly nameID: number;
  readonly disallowed: readonly number[];
  readonly mask: string;
  readonly icon: string;
  readonly u: number;
  readonly v: number;
}

export interface ShipSkinrPatterns {
  readonly slots: readonly ShipSkinrCoatingSlot[];
  readonly components: readonly ShipSkinrPattern[];
  readonly scales: Readonly<Record<string, number>>;
}

export const PATTERN_SLOTS = [5, 7] as const;
export const isPatternSlot = (id: number) => id === 5 || id === 7;
export const isPatternMaterial = (id: number) => id === 6 || id === 8;

function patternData(row: JsonValue | undefined) {
  return record(record(record(row)?.configuration)?.pattern);
}

export function shipSkinrPatternID(row: JsonValue | undefined): number | null {
  return Number(record(patternData(row)?.pattern)?.sequential) || null;
}

export interface ShipSkinrProjection {
  readonly position: number[];
  readonly rotation: number[];
  readonly scale: number;
}

/** The studio starts with yaw and pitch at .999, zero offsets and twist, and half scale. */
export async function loadShipSkinrProjection(typeID: number, scales: Readonly<Record<string, number>>): Promise<ShipSkinrProjection | null> {
  const response = await fetch(`/client-assets/type/${typeID}`);
  if (!response.ok) return null;
  const info = await response.json() as TypeModelInfo;
  if (!info.sof) return null;
  const sofResponse = await fetch(info.sof);
  if (!sofResponse.ok) return null;
  const sof = await sofResponse.json() as { hull: string; shapeEllipsoid?: { center: number[]; radius: number[] } };
  const shape = sof.shapeEllipsoid, scale = scales[sof.hull];
  if (!shape || !scale || shape.radius.some(radius => radius <= 0)) return null;

  const center = new Vector3().fromArray(shape.center);
  const radii = new Vector3().fromArray(shape.radius);
  const maxRadius = Math.max(...shape.radius);
  const yaw = 0.999, pitch = 0.999;
  const position = new Vector3(Math.sin(yaw * Math.PI) * radii.x * (1 - pitch), pitch * radii.y,
    -Math.cos(yaw * Math.PI) * radii.z * (1 - pitch)).normalize().multiplyScalar(maxRadius).add(center);
  // With the default pitch the target lerps all the way back to the ellipsoid center.
  const direction = center.clone().sub(position).normalize();
  const yAxis = new Vector3(0, 1, 0);
  const arc = new Quaternion().setFromUnitVectors(yAxis, direction);
  const roll = -(Math.atan2(direction.z, direction.x) + Math.PI / 2);
  const fraction = ((roll % Math.PI + Math.PI) % Math.PI) / Math.PI;
  const mapped = (direction.x > 0 ? 1 : 0.5) - fraction / 2;
  const twist = new Quaternion().setFromAxisAngle(yAxis, mapped * -2 * Math.PI + (fraction === 0 ? Math.PI : 0));
  const rotation = arc.multiply(twist).multiply(new Quaternion(0, 0, 0.7071, 0.7071));
  return { position: position.toArray(), rotation: rotation.toArray(), scale };
}

export function shipSkinrPatternSlot(slot: number, pattern: ShipSkinrPattern, projection: ShipSkinrProjection): JsonValue {
  const [x, y, z] = projection.position, [rx, ry, rz, rw] = projection.rotation, scale = projection.scale;
  return { id: { sequential: slot }, configuration: { pattern: {
    pattern: { sequential: pattern.id },
    configuration: {
      projection: { area1: true, area2: true, area3: true, area4: true, projection_type_u: pattern.u, projection_type_v: pattern.v },
      transform: { position: { x: x!, y: y!, z: z! }, rotation: { x: rx!, y: ry!, z: rz!, w: rw! }, scaling: { x: scale, y: scale, z: scale } },
      mirrored: false,
    },
  } } };
}

export interface ShipSkinrPatternPreview {
  readonly layer: SofPatternLayer;
  readonly material: string | null;
}

export function shipSkinrPatternPreview(
  rows: ReadonlyMap<number, JsonValue>, patterns: ReadonlyMap<number, ShipSkinrPattern>, coatings: ReadonlyMap<number, ShipSkinrCoating>,
): ShipSkinrPatternPreview[] {
  const result: ShipSkinrPatternPreview[] = [];
  const values = (value: JsonValue | undefined, axes: string) => [...axes].map(axis => Number(record(value)?.[axis]) || 0);
  for (const slot of PATTERN_SLOTS) {
    const row = rows.get(slot);
    const pattern = patterns.get(shipSkinrPatternID(row) ?? 0);
    const configuration = record(patternData(row)?.configuration);
    if (!pattern || !configuration) continue;
    const transform = record(configuration.transform);
    const projection = record(configuration.projection);
    const material = coatings.get(shipSkinrCoatingID(rows.get(slot + 1)) ?? 0)?.material ?? null;
    result.push({
      material,
      layer: {
        texture: pattern.mask, source: material ? 4 + result.length : 0,
        targets: [1, 2, 3, 4].map(area => Number(projection?.[`area${area}`] === true)),
        position: values(transform?.position, "xyz"), rotation: values(transform?.rotation, "xyzw"),
        scaling: values(transform?.scaling, "xyz"), mirrored: configuration.mirrored === true,
        projectionU: pattern.u, projectionV: pattern.v,
      },
    });
  }
  return result;
}
