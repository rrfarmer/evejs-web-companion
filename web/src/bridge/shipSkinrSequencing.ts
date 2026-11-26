import { shipSkinrCoatingID, shipSkinrRecord as object } from "./shipSkinrCoatings.ts";
import { shipSkinrPatternID } from "./shipSkinrPatterns.ts";
import { COMPONENT_SEQUENCING_GROUPS, SHIP_SKINR_TIER_LIMITS } from "./shipSkinrSequencingData.ts";
import { skillLevelsOf } from "./skillSheet.ts";
import type { JsonValue } from "./wire.ts";

const RUN_BONUSES = [
  [81375, [0, 4, 9, 19, 29, 49]],
  [81364, [0, 25, 50, 100, 150, 250]],
  [81365, [0, 200, 450, 700, 1700, 4700]],
] as const;

export interface ShipSkinrSequenceComponent {
  readonly id: number;
  readonly kind: "coating" | "pattern";
}

export interface ShipSkinrSequenceSlot extends ShipSkinrSequenceComponent {
  readonly slot: number;
  readonly binder: number;
  readonly bindersPerUse: number;
  readonly points: number;
}

export interface ShipSkinrSequenceLicense {
  readonly finite: number;
  readonly infinite: boolean;
}

const componentSettings = new Map(COMPONENT_SEQUENCING_GROUPS.flatMap(([points, binder, bindersPerUse, ids]) =>
  ids.map(id => [id, { points, binder, bindersPerUse }] as const)));

export function shipSkinrSequenceLayers(layout: Record<string, JsonValue>, group: number) {
  const limits = SHIP_SKINR_TIER_LIMITS[group];
  if (!limits?.length || !Array.isArray(layout.slots) || !layout.slots.length) return null;
  const slots: ShipSkinrSequenceSlot[] = [];
  for (const row of layout.slots) {
    const coating = shipSkinrCoatingID(row);
    const id = coating ?? shipSkinrPatternID(row);
    const slot = Number(object(object(row)?.id)?.sequential);
    const settings = id === null ? undefined : componentSettings.get(id);
    if (id === null || !settings || !slot) return null;
    slots.push({ slot, id, kind: coating === null ? "pattern" : "coating", ...settings });
  }
  const points = slots.reduce((sum, slot) => sum + slot.points, 0);
  const index = limits.findIndex(limit => points <= limit);
  return { slots, tier: index === -1 ? limits.length + 1 : index + 1 };
}

export function shipSkinrSequenceTerms(pricing: JsonValue | null, durations: JsonValue | null, skills: unknown, tier: number) {
  const prices = object(pricing)?.prices;
  const times = object(durations)?.durations;
  const forTier = (row: JsonValue) => Number(object(object(row)?.tier)?.level) === tier;
  const price = Array.isArray(prices) ? object(prices.find(forTier))?.plex : undefined;
  const duration = Array.isArray(times) ? object(times.find(forTier))?.duration : undefined;
  const cents = Number(object(price)?.total_in_cents);
  const seconds = Number(object(duration)?.seconds);
  if (!Number.isSafeInteger(cents) || cents <= 0 || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Sequencing pricing or duration is unavailable for this tier.");
  }
  const levels = skillLevelsOf(skills);
  const maximum = RUN_BONUSES.reduce((total, [id, bonuses]) => {
    const level = Math.max(0, Math.min(5, Math.trunc(levels.get(id)?.trainedSkillLevel ?? 0)));
    return total + bonuses[level]!;
  }, 1);
  return { cents, seconds, maximum };
}

export function shipSkinrSequenceIdentifier({ id, kind }: ShipSkinrSequenceComponent) {
  return { [kind]: { sequential: id } };
}
