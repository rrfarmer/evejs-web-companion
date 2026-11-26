import type { JsonValue } from "./wire.ts";

export interface ShipSkinrCoating {
  readonly id: number;
  readonly nameID: number;
  readonly category: number;
  readonly disallowed: readonly number[];
  readonly swatch: string;
  readonly material: string;
}

export interface ShipSkinrCoatingSlot {
  readonly id: number;
  readonly nameID: number;
  readonly categories: readonly number[];
}

export interface ShipSkinrCoatingCatalogue {
  readonly slots: readonly ShipSkinrCoatingSlot[];
  readonly configurations: readonly {
    readonly allHulls: boolean;
    readonly hulls: readonly number[];
    readonly slots: readonly number[];
  }[];
  readonly components: readonly ShipSkinrCoating[];
  readonly areas: Readonly<Record<number, readonly (number | null)[]>>;
}

export function coatingFits(slot: ShipSkinrCoatingSlot, coating: ShipSkinrCoating): boolean {
  return slot.categories.includes(coating.category) && !coating.disallowed.includes(slot.id);
}

export function shipSkinrCoatingMaterials(
  areaMap: readonly (number | null)[], fitted: ReadonlyMap<number, ShipSkinrCoating>,
): (string | null)[] {
  const materials = Array<string | null>(4).fill(null);
  for (const [slot, coating] of fitted) {
    const area = areaMap[slot - 1];
    if (area && area <= materials.length) materials[area - 1] = coating.material;
  }
  return materials;
}

const object = (value: JsonValue | undefined) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Readonly<Record<string, JsonValue>> : undefined;

export function shipSkinrSlotID(row: JsonValue): number {
  return Number(object(object(row)?.id)?.sequential);
}

export function shipSkinrCoatingID(row: JsonValue | undefined): number | null {
  const coating = object(object(object(row)?.configuration)?.coating);
  return Number(object(coating?.coating)?.sequential) || null;
}

export function shipSkinrLayoutSlots(layout: Record<string, JsonValue> | undefined): Map<number, JsonValue> {
  const rows = Array.isArray(layout?.slots) ? layout.slots : [];
  return new Map(rows.map(row => [shipSkinrSlotID(row), row]));
}

export function shipSkinrCoatingSlot(slot: number, componentID: number): JsonValue {
  // MaterialComponentInstance serializes zero vectors. The visible colors
  // come from the SOF material referenced by the component identifier.
  const zero = { x: 0, y: 0, z: 0, w: 0 };
  return {
    id: { sequential: slot },
    configuration: {
      coating: {
        coating: { sequential: componentID },
        configuration: { diffuse_color: zero, dust_diffuse_color: zero, fresnel_color: zero, gloss: zero },
      },
    },
  };
}
