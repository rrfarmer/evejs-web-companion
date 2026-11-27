import { decodeAttributes, decodeRespecInfo, type BoundRespecInfo } from "./boundSkills.ts";
import type { JsonValue } from "./wire.ts";

export const CHARACTER_ATTRIBUTES = [
  { id: 167, name: "Perception", icon: 5 },
  { id: 166, name: "Memory", icon: 4 },
  { id: 168, name: "Willpower", icon: 2 },
  { id: 165, name: "Intelligence", icon: 3 },
  { id: 164, name: "Charisma", icon: 1 },
] as const;

export const REMAP_MIN = 17;
export const REMAP_MAX = 27;
export const REMAP_TOTAL = 99;

export interface CharacterAttributeSnapshot {
  readonly attributes: ReadonlyMap<number, number>;
  readonly remap: BoundRespecInfo | null;
}

export interface CharacterAttributeOverviewRow {
  readonly id: number;
  readonly base: number;
  readonly implantBonus: number;
}

export function characterAttributeSnapshot(attributes: JsonValue, remap: JsonValue): CharacterAttributeSnapshot {
  return {
    attributes: new Map(decodeAttributes(attributes).map(row => [row.attributeID, row.points])),
    remap: remap !== null ? decodeRespecInfo(remap) : null,
  };
}
