// Facility bonuses and job time, the server's way (bridge/industryFacility.ts).

import test from "node:test";
import assert from "node:assert/strict";

import {
  characterTimeMultiplier,
  facilityMultiplier,
  jobSeconds,
  modifierApplies,
  requiredSkillTimeMultiplier,
  SKILL_ADVANCED_INDUSTRY,
  SKILL_INDUSTRY,
  SKILL_REACTIONS,
} from "./industryFacility.ts";
import { decodeRecipeClosure, type IndustryRecipe, type IndustryTypeInfo } from "./industryRecipes.ts";
import type { JsonValue } from "./wire.ts";
import type { IndustryFacilityModifier } from "../store/types.ts";

const DRONE: IndustryTypeInfo = { typeID: 2456, name: "Hobgoblin II", groupID: 100, groupName: "Combat Drone", categoryID: 18, categoryName: "Drone", volume: 5 };

function mod(value: number, categoryID: number | null = null, groupID: number | null = null, typeID: number | null = null): IndustryFacilityModifier {
  return { value, categoryID, groupID, typeID };
}

function recipe(overrides: Partial<IndustryRecipe> = {}): IndustryRecipe {
  return {
    productTypeID: 2456, activity: "manufacturing", blueprintTypeID: 2457, blueprintName: "Hobgoblin II Blueprint",
    quantityPerRun: 1, timeSeconds: 1500, maxRunsPerBlueprint: 10, materials: [], inventedFrom: [],
    skills: [{ typeID: 3380, level: 5 }, { typeID: 11446, level: 1 }, { typeID: 11453, level: 1 }],
    ...overrides,
  };
}

const SCIENCE = new Map([[11446, -1], [11453, -1]]);

test("a modifier with no target applies to anything; else category, then group, then type", () => {
  assert.equal(modifierApplies(mod(0.9), null), true);
  assert.equal(modifierApplies(mod(0.9, 18), DRONE), true);
  assert.equal(modifierApplies(mod(0.9, 6), DRONE), false);
  // Category decides when it is named, whatever the group says.
  assert.equal(modifierApplies(mod(0.9, 18, 999), DRONE), true);
  assert.equal(modifierApplies(mod(0.9, null, 100), DRONE), true);
  assert.equal(modifierApplies(mod(0.9, null, 25), DRONE), false);
  assert.equal(modifierApplies(mod(0.9, null, null, 2456), DRONE), true);
  assert.equal(modifierApplies(mod(0.9, null, null, 2454), DRONE), false);
  // A targeted modifier never applies to a product nobody could look up.
  assert.equal(modifierApplies(mod(0.9, 18), null), false);
});

test("matching modifiers multiply, each floored at zero; none is 1", () => {
  // An Engineering Complex hull bonus (0.99) and a drone rig (0.976).
  assert.equal(facilityMultiplier([mod(0.99), mod(0.976, 18), mod(0.5, 6)], DRONE), 0.99 * 0.976);
  assert.equal(facilityMultiplier([], DRONE), 1);
  assert.equal(facilityMultiplier(undefined, DRONE), 1);
  assert.equal(facilityMultiplier([mod(-2)], DRONE), 0);
});

test("the pilot's time attribute: Industry and Advanced Industry for manufacturing, Reactions for reactions", () => {
  const all = new Map([[SKILL_INDUSTRY, 5], [SKILL_ADVANCED_INDUSTRY, 5], [SKILL_REACTIONS, 4]]);
  // 0.8 x 0.85, to six places.
  assert.equal(characterTimeMultiplier("manufacturing", all), 0.68);
  assert.equal(characterTimeMultiplier("reaction", all), 0.84);
  assert.equal(characterTimeMultiplier("manufacturing", new Map()), 1);
  // Rounded to six places as the server rounds the attribute: 0.96 x 0.97 is
  // 0.9311999999999999 in floating point, and the server stores 0.9312.
  assert.equal(characterTimeMultiplier("manufacturing", new Map([[SKILL_INDUSTRY, 1], [SKILL_ADVANCED_INDUSTRY, 1]])), 0.9312);
  // Levels are clamped to 0..5, as the server clamps them.
  assert.equal(characterTimeMultiplier("reaction", new Map([[SKILL_REACTIONS, 9]])), 0.8);
  assert.equal(characterTimeMultiplier("manufacturing", new Map([[SKILL_INDUSTRY, -3]])), 1);
});

test("required skills shorten manufacturing by their own bonus, and nothing else", () => {
  const skills = new Map([[11446, 4], [11453, 2], [3380, 5]]);
  assert.equal(requiredSkillTimeMultiplier(recipe(), SCIENCE, skills), 0.96 * 0.98);
  assert.equal(requiredSkillTimeMultiplier(recipe({ activity: "reaction" }), SCIENCE, skills), 1);
  // A skill with no bonus of its own (Industry) changes nothing here.
  assert.equal(requiredSkillTimeMultiplier(recipe(), new Map(), skills), 1);
});

test("a job's seconds: base x runs x TE x facility x pilot x skills, rounded, at least 1", () => {
  const skills = new Map([[SKILL_INDUSTRY, 5], [SKILL_ADVANCED_INDUSTRY, 5], [11446, 5], [11453, 5]]);
  const place = { time: [mod(0.98)], material: [], skills };
  // 1500 x 2 runs x (1 - 4/100) x 0.98 x 0.68 x 0.95 x 0.95.
  const expected = Math.round(1500 * 2 * 0.96 * 0.98 * 0.68 * 0.95 * 0.95);
  assert.equal(jobSeconds(recipe(), 2, 4, place, DRONE, SCIENCE), expected);
  // A reaction takes no TE, whatever the blueprint says.
  const reaction = recipe({ activity: "reaction", timeSeconds: 10800, skills: [] });
  assert.equal(jobSeconds(reaction, 1, 20, { time: [], material: [], skills: new Map() }, null, SCIENCE), 10800);
  // Nobody's skills known: the job as an untrained pilot would run it.
  assert.equal(jobSeconds(recipe(), 1, 0, { time: [], material: [], skills: null }, DRONE, SCIENCE), 1500);
  assert.equal(jobSeconds(recipe({ timeSeconds: null }), 1, 0, place, DRONE, SCIENCE), null);
  // Rounded to the nearest second, not down: 3 s at half time is 1.5, so 2.
  assert.equal(jobSeconds(recipe({ timeSeconds: 3, skills: [] }), 1, 0, { time: [mod(0.5)], material: [], skills: null }, DRONE, SCIENCE), 2);
  assert.equal(jobSeconds(recipe({ timeSeconds: 1 }), 1, 0, { time: [mod(0.0001)], material: [], skills: null }, DRONE, SCIENCE), 1);
});

test("the recipe book carries each recipe's skills and the skills' time bonuses", () => {
  const book = decodeRecipeClosure({
    recipes: [{
      productTypeID: 2456, activity: "manufacturing", blueprintTypeID: 2457, quantityPerRun: 1, timeSeconds: 1500,
      materials: [], inventedFrom: [], skills: [{ typeID: 3380, level: 5 }, { typeID: 11446, level: 1 }, { typeID: 0, level: 1 }],
    }],
    types: {},
    skillTimePercent: { 11446: -1, 11453: -1, 3380: 2, 999: "fast" },
  } as unknown as JsonValue);
  assert.deepEqual(book.byProduct.get(2456)?.skills, [{ typeID: 3380, level: 5 }, { typeID: 11446, level: 1 }]);
  // Only real, negative bonuses: the server counts no other kind.
  assert.deepEqual([...book.skillTimePercent], [[11446, -1], [11453, -1]]);
  // An answer from before skills were sent reads as none.
  const old = decodeRecipeClosure({ recipes: [{ productTypeID: 1, activity: "manufacturing", blueprintTypeID: 2, quantityPerRun: 1, materials: [] }], types: {} } as unknown as JsonValue);
  assert.deepEqual(old.byProduct.get(1)?.skills, []);
  assert.equal(old.skillTimePercent.size, 0);
});
