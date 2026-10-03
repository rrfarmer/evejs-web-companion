// Where a plan's job runs, and what that does to it: the facility's material
// and time modifiers, and how long the job takes. Pure; the panel says which
// facility and whose skills.
//
// ---------------------------------------------------------------------------
// THE SERVER'S RULES, PORTED (server/src/services/industry/):
//
// A facility's modifiers come with it from facilityManager.GetFacilities, the
// same object the server prices a job with (industryStaticData.js
// getFacilityPayloadByID). Per activity they are lists of
// [value, categoryID, groupID, typeID, reference]: index 0 time, 1 material.
// An NPC station has no material entry at all, only time; an Upwell structure
// adds its hull bonus and its rigs (security-scaled) to both
// (industryFacilityModifiers.js). A modifier applies to a product when it
// names no category, group or type, or names the product's (category first,
// then group, then type: industryParityHelpers.js modifierMatchesProduct);
// the matching values multiply, each floored at 0
// (resolveFacilityActivityModifier).
//
// A job's seconds (resolveIndustryJobTimeSeconds) are
//
//     max(1, round(base x runs x (1 - TE/100) x facility x character x skills))
//
// where TE counts for manufacturing only; `character` is the pilot's
// industry time attribute, worked from skills as industryBrainProvider.js
// resolveComputedIndustryAttributes does (manufacturing: Industry -4% and
// Advanced Industry -3% a level; reactions: Reactions -4% a level; rounded to
// six places); and `skills` is, for manufacturing only, each required skill's
// own time bonus per level (dogma 1982) at the pilot's level
// (resolveRequiredSkillTimeModifier).
//
// ⚠ ONE THING THIS CANNOT SEE: a character record that stores its own
// industry attributes overrides the skill-worked ones on the server. Those
// are not readable here, so the time is the skills' estimate and says so.

import type { IndustryFacilityModifier } from "../store/types.ts";
import type { IndustryRecipe, IndustryTypeInfo } from "./industryRecipes.ts";

export const SKILL_INDUSTRY = 3380;
export const SKILL_ADVANCED_INDUSTRY = 3388;
export const SKILL_REACTIONS = 45746;

/** The server's modifierMatchesProduct. */
export function modifierApplies(modifier: IndustryFacilityModifier, product: IndustryTypeInfo | null): boolean {
  const { categoryID, groupID, typeID } = modifier;
  if (categoryID === null && groupID === null && typeID === null) {
    return true;
  }
  if (product === null) {
    return false;
  }
  if (categoryID !== null) {
    return product.categoryID === categoryID;
  }
  if (groupID !== null) {
    return product.groupID === groupID;
  }
  return product.typeID === typeID;
}

/** The product of the modifiers that apply to `product`; 1 with none. */
export function facilityMultiplier(
  modifiers: readonly IndustryFacilityModifier[] | undefined,
  product: IndustryTypeInfo | null,
): number {
  let multiplier = 1;
  for (const modifier of modifiers ?? []) {
    if (modifierApplies(modifier, product)) {
      multiplier *= Math.max(0, modifier.value);
    }
  }
  return multiplier;
}

function level(skills: ReadonlyMap<number, number>, typeID: number): number {
  return Math.min(Math.max(Math.trunc(skills.get(typeID) ?? 0), 0), 5);
}

function perLevel(base: number, percent: number, levels: number): number {
  return levels > 0 ? base * Math.max(0, 1 + (percent * levels) / 100) : base;
}

/** The pilot's industry time attribute for the work, from its skills. */
export function characterTimeMultiplier(activity: "manufacturing" | "reaction", skills: ReadonlyMap<number, number>): number {
  const value = activity === "manufacturing"
    ? perLevel(perLevel(1, -4, level(skills, SKILL_INDUSTRY)), -3, level(skills, SKILL_ADVANCED_INDUSTRY))
    : perLevel(1, -4, level(skills, SKILL_REACTIONS));
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 1;
}

/** Manufacturing only: each required skill's own time bonus at the pilot's level. */
export function requiredSkillTimeMultiplier(
  recipe: IndustryRecipe,
  skillTimePercent: ReadonlyMap<number, number>,
  skills: ReadonlyMap<number, number>,
): number {
  if (recipe.activity !== "manufacturing") {
    return 1;
  }
  let multiplier = 1;
  for (const skill of recipe.skills) {
    const percent = skillTimePercent.get(skill.typeID) ?? 0;
    if (percent < 0) {
      multiplier = perLevel(multiplier, percent, level(skills, skill.typeID));
    }
  }
  return multiplier;
}

/** Where a job runs and who runs it, as far as its numbers go. */
export interface JobPlace {
  /** The facility's modifiers for the work; empty when no facility is known. */
  readonly time: readonly IndustryFacilityModifier[];
  readonly material: readonly IndustryFacilityModifier[];
  /** The installer's trained levels; null when no pilot's skills are known. */
  readonly skills: ReadonlyMap<number, number> | null;
}

/** One job's seconds, the server's way. Null when the recipe states no time. */
export function jobSeconds(
  recipe: IndustryRecipe,
  runs: number,
  timeEfficiency: number,
  place: JobPlace,
  product: IndustryTypeInfo | null,
  skillTimePercent: ReadonlyMap<number, number>,
): number | null {
  if (recipe.timeSeconds === null || runs <= 0) {
    return null;
  }
  const blueprint = recipe.activity === "manufacturing" ? Math.max(0, 1 - Math.trunc(timeEfficiency) / 100) : 1;
  const skills = place.skills ?? new Map<number, number>();
  const total = recipe.timeSeconds * runs * blueprint
    * facilityMultiplier(place.time, product)
    * characterTimeMultiplier(recipe.activity, skills)
    * requiredSkillTimeMultiplier(recipe, skillTimePercent, skills);
  return Math.max(1, Math.round(total));
}

