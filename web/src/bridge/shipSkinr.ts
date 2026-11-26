import type { JsonValue } from "./wire.ts";
import { skillLevelsOf } from "./skillSheet.ts";

export const SHIP_SKINR_GATEWAY = "eve_public.cosmetic.ship.skin.thirdparty.";
export const SHIP_SKINR_NAME_MAX = 20;
export const SHIP_SKINR_LINE_NAME_MAX = 50;

// sequencing_const.max_concurrent_jobs_added_by_skill_and_level, accumulated from level 0.
const SEQUENCING_JOB_BONUSES = [
  { typeID: 81366, name: "Parallel Sequencing", bonus: [0, 1, 3, 5, 7, 9] },
  { typeID: 81367, name: "Multi-thread Sequencing", bonus: [0, 2, 4, 6, 8, 10] },
] as const;

export function shipSkinrSequencingCapacity(answer: unknown) {
  const levels = skillLevelsOf(answer);
  const skills = SEQUENCING_JOB_BONUSES.map(({ typeID, name, bonus }) => {
    const level = Math.max(0, Math.min(5, Math.trunc(levels.get(typeID)?.trainedSkillLevel ?? 0)));
    return { typeID, name, level, bonus: bonus[level]! };
  });
  return { maximum: skills.reduce((total, skill) => total + skill.bonus, 1), skills };
}

export function validShipSkinrName(name: string, lineName: string): boolean {
  return name.trim() !== "" && [...name].length <= SHIP_SKINR_NAME_MAX && [...lineName].length <= SHIP_SKINR_LINE_NAME_MAX &&
    !/[\p{Cc}\p{Cs}]/u.test(name + lineName);
}

export interface ShipSkinrEntry {
  readonly id: string;
  readonly skin: string;
  readonly quantity: number;
  readonly finishesAt: number;
  readonly editorConfigurations: JsonValue[];
}

export interface ShipSkinrStudio {
  readonly designs: readonly ShipSkinrEntry[];
  readonly capacity: number;
  readonly jobs: readonly ShipSkinrEntry[];
}

export interface ShipSkinrDesign {
  readonly name: string;
  readonly lineName: string;
  readonly shipTypeID: number;
  readonly tier: number;
  readonly layout: Record<string, JsonValue>;
}

function record(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function integer(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function decodeShipSkinrEntries(payload: unknown, field: "drafts" | "jobs"): ShipSkinrEntry[] {
  const rows = record(payload)[field];
  if (!Array.isArray(rows)) return [];
  return rows.map(decodeShipSkinrEntry).filter(entry => entry !== null);
}

export function decodeShipSkinrEntry(payload: unknown): ShipSkinrEntry | null {
  const row = record(payload);
  const id = record(row.id).uuid;
  const attributes = record(row.attributes);
  const skin = record(attributes.skin).hex;
  const configurations = attributes.editor_configurations;
  if (typeof id !== "string" || !id || typeof skin !== "string" || !skin) return null;
  return {
    id, skin, quantity: integer(attributes.quantity),
    finishesAt: integer(record(attributes.planned_completion).seconds) * 1000,
    editorConfigurations: Array.isArray(configurations) ? configurations : [],
  };
}

export function decodeShipSkinrCapacity(payload: unknown): number {
  return integer(record(payload).capacity);
}

export function decodeShipSkinrDesign(payload: unknown): ShipSkinrDesign | null {
  const skin = record(record(payload).skin);
  const layout = record(skin.layout);
  const shipTypeID = integer(record(layout.ship_type).sequential);
  return shipTypeID ? {
    shipTypeID,
    name: typeof skin.name === "string" ? skin.name : "",
    lineName: typeof skin.line_name === "string" ? skin.line_name : "",
    tier: integer(record(skin.tier).level),
    layout,
  } : null;
}
