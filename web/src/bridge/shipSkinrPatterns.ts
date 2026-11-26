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

interface ShipSkinrProjection {
  readonly position: number[];
  readonly rotation: number[];
  readonly scale: number;
}

export interface ShipSkinrProjector {
  readonly center: number[];
  readonly radius: number[];
  readonly scale: number;
}

export interface ShipSkinrPatternControls {
  offset_u_ratio: number;
  offset_v_ratio: number;
  yaw: number;
  pitch: number;
  roll: number;
  scaling: number;
}

export const DEFAULT_PATTERN_CONTROLS: Readonly<ShipSkinrPatternControls> = {
  offset_u_ratio: 0, offset_v_ratio: 0, yaw: 0.999, pitch: 0.999, roll: 0, scaling: 0.5,
};

export async function loadShipSkinrProjector(typeID: number, scales: Readonly<Record<string, number>>): Promise<ShipSkinrProjector | null> {
  const response = await fetch(`/client-assets/type/${typeID}`);
  if (!response.ok) return null;
  const info = await response.json() as TypeModelInfo;
  if (!info.sof) return null;
  const sofResponse = await fetch(info.sof);
  if (!sofResponse.ok) return null;
  const sof = await sofResponse.json() as { hull: string; shapeEllipsoid?: { center: number[]; radius: number[] } };
  const shape = sof.shapeEllipsoid, scale = scales[sof.hull];
  if (!shape || !scale || shape.radius.some(radius => radius <= 0)) return null;
  return { ...shape, scale };
}

/** patternProjectionUtil projects from the hull's ellipsoid in native model coordinates. */
export function shipSkinrProjection(shape: ShipSkinrProjector, controls: Readonly<ShipSkinrPatternControls>): ShipSkinrProjection {
  const center = new Vector3().fromArray(shape.center);
  const radii = new Vector3().fromArray(shape.radius);
  const maxRadius = Math.max(...shape.radius);
  const { yaw, pitch, roll, offset_u_ratio, offset_v_ratio, scaling } = controls;
  const horizontal = 1 - Math.abs(pitch);
  const projector = new Vector3(Math.sin(yaw * Math.PI) * radii.x * horizontal, pitch * radii.y,
    -Math.cos(yaw * Math.PI) * radii.z * horizontal).normalize().multiplyScalar(maxRadius).add(center);
  const target = projector.clone().normalize().multiply(radii).multiply(radii).multiplyScalar(0.2 / maxRadius).add(center)
    .lerp(center, Math.min(1, 1.2 * Math.abs(pitch)) ** 2);
  const direction = target.sub(projector).normalize();
  const yAxis = new Vector3(0, 1, 0);
  const arc = new Quaternion().setFromUnitVectors(yAxis, direction);
  const facing = -(Math.atan2(direction.z, direction.x) + Math.PI / 2);
  const fraction = ((facing % Math.PI + Math.PI) % Math.PI) / Math.PI;
  const mapped = (direction.x > 0 ? 1 : 0.5) - fraction / 2;
  const facingRoll = new Quaternion().setFromAxisAngle(yAxis, mapped * -2 * Math.PI + (fraction === 0 ? Math.PI : 0));
  const preTwist = arc.multiply(facingRoll).multiply(new Quaternion(0, 0, 0.7071, 0.7071));
  const offset = new Vector3(0, offset_u_ratio, -offset_v_ratio).multiplyScalar(maxRadius * 0.75).applyQuaternion(preTwist);
  const rotation = preTwist.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), roll * Math.PI));
  return { position: projector.add(offset).toArray(), rotation: rotation.toArray(), scale: shape.scale * (0.1 + scaling ** 2 * 3.6) };
}

function wireTransform(projection: ShipSkinrProjection): JsonValue {
  const [x, y, z] = projection.position, [rx, ry, rz, rw] = projection.rotation, scale = projection.scale;
  return { position: { x: x!, y: y!, z: z! }, rotation: { x: rx!, y: ry!, z: rz!, w: rw! }, scaling: { x: scale, y: scale, z: scale } };
}

export function shipSkinrPatternSlot(slot: number, pattern: ShipSkinrPattern, projector: ShipSkinrProjector): JsonValue {
  return { id: { sequential: slot }, configuration: { pattern: {
    pattern: { sequential: pattern.id },
    configuration: {
      projection: { area1: true, area2: true, area3: true, area4: true, projection_type_u: pattern.u, projection_type_v: pattern.v },
      transform: wireTransform(shipSkinrProjection(projector, DEFAULT_PATTERN_CONTROLS)),
      mirrored: false,
    },
  } } };
}

export function shipSkinrPatternSettings(row: JsonValue) {
  const configuration = record(patternData(row)?.configuration);
  const projection = record(configuration?.projection);
  return { areas: [1, 2, 3, 4].map(area => projection?.[`area${area}`] === true), mirrored: configuration?.mirrored === true };
}

export function updateShipSkinrPattern(row: JsonValue, changes: {
  readonly transform?: ShipSkinrProjection;
  readonly areas?: readonly boolean[];
  readonly mirrored?: boolean;
}): JsonValue {
  const pattern = patternData(row);
  const configuration = record(pattern?.configuration);
  if (!pattern || !configuration) return row;
  const projection = { ...record(configuration.projection) };
  changes.areas?.forEach((enabled, index) => projection[`area${index + 1}`] = enabled);
  return { ...record(row), configuration: { pattern: { ...pattern, configuration: {
    ...configuration, projection,
    transform: changes.transform ? wireTransform(changes.transform) : configuration.transform ?? null,
    mirrored: changes.mirrored ?? (configuration.mirrored === true),
  } } } };
}

export function readShipSkinrPatternControls(editor: JsonValue | undefined, row: JsonValue, projector: ShipSkinrProjector): ShipSkinrPatternControls {
  const config = record(record(editor)?.config);
  if (config && Object.values(config).some(value => Number(value) !== 0)) {
    return {
      yaw: Number(config.yaw) || 0, pitch: Number(config.pitch) || 0, roll: Number(config.roll) || 0,
      offset_u_ratio: Number(config.offset_u_ratio) || 0, offset_v_ratio: Number(config.offset_v_ratio) || 0,
      scaling: Math.max(0, Math.min(1, Number(config.scaling) || 0)),
    };
  }
  const transform = record(record(patternData(row)?.configuration)?.transform);
  const stored = Number(record(transform?.scaling)?.x);
  const ratio = Math.sqrt(Math.max(0, (stored / projector.scale - 0.1) / 3.6));
  if (config && ratio < 0.00001) {
    const zero: ShipSkinrPatternControls = { yaw: 0, pitch: 0, roll: 0, offset_u_ratio: 0, offset_v_ratio: 0, scaling: 0 };
    const { position } = shipSkinrProjection(projector, zero);
    const savedPosition = record(transform?.position);
    if (["x", "y", "z"].every((axis, index) => Math.abs(Number(savedPosition?.[axis]) - position[index]!) < 0.0001)) return zero;
  }
  return { ...DEFAULT_PATTERN_CONTROLS, scaling: Number.isFinite(ratio) ? Math.min(1, ratio) : 0.5 };
}

export interface ShipSkinrPatternPreview {
  readonly layer: SofPatternLayer;
  readonly material: string | null;
}

export function shipSkinrPatternPreview(
  rows: ReadonlyMap<number, JsonValue>, patterns: ReadonlyMap<number, ShipSkinrPattern>, coatings: ReadonlyMap<number, ShipSkinrCoating>,
  areaMap: readonly (number | null)[],
): ShipSkinrPatternPreview[] {
  const result: ShipSkinrPatternPreview[] = [];
  const values = (value: JsonValue | undefined, axes: string) => [...axes].map(axis => Number(record(value)?.[axis]) || 0);
  for (const slot of PATTERN_SLOTS) {
    const row = rows.get(slot);
    const pattern = patterns.get(shipSkinrPatternID(row) ?? 0);
    const configuration = record(patternData(row)?.configuration);
    if (!pattern || !configuration) continue;
    const transform = record(configuration.transform);
    const targets = [0, 0, 0, 0];
    shipSkinrPatternSettings(row!).areas.forEach((enabled, index) => {
      const materialSlot = areaMap[index] ?? index + 1;
      targets[materialSlot - 1] = Number(enabled);
    });
    const material = coatings.get(shipSkinrCoatingID(rows.get(slot + 1)) ?? 0)?.material ?? null;
    result.push({
      material,
      layer: {
        texture: pattern.mask, source: material ? 4 + result.length : 0,
        targets,
        position: values(transform?.position, "xyz"), rotation: values(transform?.rotation, "xyzw"),
        scaling: values(transform?.scaling, "xyz"), mirrored: configuration.mirrored === true,
        projectionU: pattern.u, projectionV: pattern.v,
      },
    });
  }
  return result;
}
