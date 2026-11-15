import {
  OP_MOD_ADD, OP_MOD_SUB, OP_POST_DIV, OP_POST_MUL, OP_POST_PERCENT, OP_PRE_DIV, OP_PRE_MUL,
} from "./attribute.ts";
import type { DogmaItem, DogmaLocation } from "./location.ts";

export type ModifierDirection = "up" | "down";
export type AttributeModifierSource =
  | { readonly direction: ModifierDirection; readonly typeID: number; readonly count: number; readonly overloaded: boolean }
  | { readonly direction: ModifierDirection; readonly typeID: null };

export interface AttributeModification {
  readonly baseValue: number | null;
  readonly sources: readonly AttributeModifierSource[];
}

/** info/attribute.py FloatCloseEnough uses an absolute tolerance. */
export function attributeChanged(base: number, value: number): boolean {
  return Math.abs(base - value) >= 1e-6;
}

function directionFor(operation: number, value: number): ModifierDirection | null {
  let change: number;
  switch (operation) {
    case OP_PRE_MUL:
    case OP_POST_MUL: change = value - 1; break;
    case OP_PRE_DIV:
    case OP_POST_DIV: change = 1 - value; break;
    case OP_MOD_ADD:
    case OP_POST_PERCENT: change = value; break;
    case OP_MOD_SUB: change = -value; break;
    default: return null;
  }
  return change > 0 ? "up" : change < 0 ? "down" : null;
}

/** infoUtil.HarvestModifiers groups by source attribute class and deduplicates concrete item instances. */
export function affectedBy(
  location: DogmaLocation,
  item: DogmaItem,
  attributeID: number,
  serverValue: number | undefined,
): readonly AttributeModifierSource[] {
  if (!item.attributes.has(attributeID)) return [];
  const found = {
    up: new Map<string, { typeID: number; count: number; overloaded: boolean }>(),
    down: new Map<string, { typeID: number; count: number; overloaded: boolean }>(),
  };
  const path = new Set<string>();
  const seen = new Set<string>();
  function add(direction: ModifierDirection, sourceClass: string, typeID: number, itemKey: string | null): void {
    const key = `${sourceClass}|${typeID}`;
    if (itemKey !== null) {
      const identity = `${direction}|${key}|${itemKey}`;
      if (seen.has(identity)) return;
      seen.add(identity);
    }
    const group = found[direction].get(key) ?? { typeID, count: 0, overloaded: sourceClass === "overload" };
    group.count++;
    found[direction].set(key, group);
  }
  function walk(target: DogmaItem, targetAttribute: number): void {
    const key = `${target.key}|${targetAttribute}`;
    if (path.has(key)) return;
    path.add(key);
    for (const { op, source } of target.incoming.get(targetAttribute)?.values() ?? []) {
      const origin = source.itemKey === undefined ? null : location.item(source.itemKey);
      const value = source.kind === "literal" ? source.value : origin ? location.value(origin, source.attributeID) : NaN;
      const direction = directionFor(op, value);
      if (!direction) continue;
      if (source.kind === "literal") {
        for (const typeID of source.skills ?? []) add(direction, "brain", typeID, null);
        if (origin) add(direction, "attribute", origin.typeID, origin.key);
      } else if (origin) {
        const overloaded = location.static.types[origin.typeID]?.effects.some(id => {
          const effect = location.static.effects[id];
          return effect?.category === 5 && effect.modifiers?.some(mod => mod.modifyingAttributeID === source.attributeID);
        });
        const sourceClass = overloaded ? "overload" : location.static.attributes[source.attributeID]?.stackable === false ? "stacking" : "attribute";
        add(direction, sourceClass, origin.typeID, origin.key);
        walk(origin, source.attributeID);
      }
    }
    path.delete(key);
  }
  walk(item, attributeID);
  const local = serverValue === undefined ? undefined : location.value(item, attributeID);
  const external = local !== undefined && serverValue !== undefined && attributeChanged(local, serverValue)
    ? serverValue > local ? "up" : "down"
    : null;
  const rows: AttributeModifierSource[] = [];
  for (const direction of ["up", "down"] as const) {
    for (const group of found[direction].values()) rows.push({ direction, ...group });
    if (external === direction) rows.push({ direction, typeID: null });
  }
  return rows;
}
