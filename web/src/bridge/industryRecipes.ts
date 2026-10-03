// The industry recipe book, as the Industry Manager sees it (goal R109 slice 1).
//
// ---------------------------------------------------------------------------
// FROM THE PRODUCT SIDE.
//
// `industry.ts` decodes recipes keyed by BLUEPRINT, which is what the install
// flow needs: "this blueprint, what does it do". A build tree asks the other way
// round, once per node: "this product, what makes it". The BFF answers that with
// a closure (every recipe reachable from the asked products) so one read is the
// whole tree, and this file turns it into maps.
//
// ---------------------------------------------------------------------------
// FIXED FACTS ONLY.
//
// Like the PI recipes, these are static reference data and safe to multiply.
// Anything that varies by player (what a blueprint's efficiency is, what is
// held, what a facility gives) comes in from elsewhere and is the caller's to
// pass to the resolver in `industryChain.ts`.
//
// ---------------------------------------------------------------------------
// NULL, NEVER ZERO, AND NEVER A STRINGIFIED ID.
//
// A type the server could not name is `name: null`, and the UI shows the
// fallback tile (R7d). A run time the table did not state is null, not zero.

import type { JsonValue } from "./wire.ts";

/** The two activities that turn materials into something a tree can use. */
export type IndustryBuildActivity = "manufacturing" | "reaction";

export interface IndustryMaterial {
  readonly typeID: number;
  /** Always > 0. A row asking for none of something is dropped. */
  readonly quantity: number;
}

/** One way a T2 blueprint copy is invented. */
export interface IndustryInvention {
  readonly blueprintTypeID: number;
  readonly blueprintName: string | null;
  /** Runs on each copy a success yields. */
  readonly runsPerCopy: number;
  /** 0..1, the table's base chance, or null when it did not say. */
  readonly probability: number | null;
  readonly timeSeconds: number | null;
  /** Datacores and the like, per attempt. */
  readonly materials: readonly IndustryMaterial[];
  /** Every skill that counts toward the chance, with the level the recipe asks. */
  readonly skills: readonly { readonly typeID: number; readonly level: number }[];
}

/** What makes one product, out of what. */
export interface IndustryRecipe {
  readonly productTypeID: number;
  readonly activity: IndustryBuildActivity;
  readonly blueprintTypeID: number;
  readonly blueprintName: string | null;
  /** Units one run makes: 1 for a ship, 100 for ammo, thousands for a reaction. */
  readonly quantityPerRun: number;
  /** Seconds per run before any bonus, or null. SECONDS, as the name says. */
  readonly timeSeconds: number | null;
  /** The most runs one copy may carry, or null. */
  readonly maxRunsPerBlueprint: number | null;
  /** Per ONE run, before efficiency. */
  readonly materials: readonly IndustryMaterial[];
  /** Empty unless the blueprint is a T2 one reached by invention. */
  readonly inventedFrom: readonly IndustryInvention[];
  /** The skills the activity asks for; empty when the book did not say. */
  readonly skills: readonly { readonly typeID: number; readonly level: number }[];
}

export interface IndustryTypeInfo {
  readonly typeID: number;
  readonly name: string | null;
  readonly groupID: number | null;
  readonly groupName: string | null;
  readonly categoryID: number | null;
  readonly categoryName: string | null;
  /** m3 per unit, or null. */
  readonly volume: number | null;
}

export interface IndustryRecipeBook {
  /** Product type to the one recipe that makes it. */
  readonly byProduct: ReadonlyMap<number, IndustryRecipe>;
  /** Every type the closure mentions that static data could describe. */
  readonly types: ReadonlyMap<number, IndustryTypeInfo>;
  /** Asked-for products nothing published makes. */
  readonly missing: readonly number[];
  /** The BFF stopped early. A tree from a capped book is incomplete. */
  readonly capped: boolean;
  /**
   * False when the answer carried no recipe list at all.
   *
   * NOT THE SAME AS AN EMPTY ONE: "nothing was sent" and "nothing makes this"
   * are different sentences, and a planner that cannot tell them apart will
   * call a perfectly buildable item impossible.
   */
  readonly readable: boolean;
  /**
   * Per skill a manufacturing recipe asks for: its own time bonus per level
   * (dogma 1982, negative), for the job time (bridge/industryFacility.ts).
   */
  readonly skillTimePercent: ReadonlyMap<number, number>;
}

/** One search hit: a blueprint or a reaction formula. */
export interface IndustryBlueprintMatch {
  readonly blueprintTypeID: number;
  readonly blueprintName: string;
  readonly productTypeID: number;
  readonly productName: string | null;
  readonly activity: IndustryBuildActivity;
}

export interface IndustryBlueprintSearch {
  readonly matches: readonly IndustryBlueprintMatch[];
  readonly total: number;
  readonly capped: boolean;
}

/**
 * Planetary resources (42) and commodities (43).
 *
 * PORTED FROM the BFF's own `PLANETARY_CATEGORY_IDS` (src/server.js), which the
 * PI stock read classifies by. A planetary good is a leaf for industry: it is
 * planned in Planetary Industry, not here.
 */
export const PLANETARY_CATEGORY_IDS: ReadonlySet<number> = new Set([42, 43]);

export const EMPTY_INDUSTRY_BOOK: IndustryRecipeBook = Object.freeze({
  byProduct: new Map<number, IndustryRecipe>(),
  types: new Map<number, IndustryTypeInfo>(),
  missing: Object.freeze([]) as readonly number[],
  capped: false,
  readable: false,
  skillTimePercent: new Map<number, number>(),
});

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [];
}

function asIdentifier(value: JsonValue | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function asCount(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function asName(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asActivity(value: JsonValue | undefined): IndustryBuildActivity | null {
  return value === "manufacturing" || value === "reaction" ? value : null;
}

function decodeMaterials(value: JsonValue | undefined): IndustryMaterial[] {
  const materials: IndustryMaterial[] = [];
  for (const raw of asArray(value)) {
    const row = asRecord(raw);
    const typeID = asIdentifier(row.typeID);
    const quantity = asCount(row.quantity);
    if (typeID !== null && quantity !== null) {
      materials.push({ typeID, quantity });
    }
  }
  return materials;
}

function decodeInvention(value: JsonValue): IndustryInvention | null {
  const row = asRecord(value);
  const blueprintTypeID = asIdentifier(row.blueprintTypeID);
  const runsPerCopy = asCount(row.runsPerCopy);
  if (blueprintTypeID === null || runsPerCopy === null) {
    return null;
  }
  const probability = asCount(row.probability);
  return {
    blueprintTypeID,
    blueprintName: asName(row.blueprintName),
    runsPerCopy,
    probability: probability !== null && probability <= 1 ? probability : null,
    timeSeconds: asCount(row.timeSeconds),
    materials: decodeMaterials(row.materials),
    skills: decodeSkills(row.skills),
  };
}

function decodeSkills(value: JsonValue | undefined): { readonly typeID: number; readonly level: number }[] {
  return asArray(value).flatMap((raw) => {
    const skill = asRecord(raw);
    const typeID = asIdentifier(skill.typeID);
    const level = typeof skill.level === "number" && Number.isSafeInteger(skill.level) && skill.level >= 0 ? skill.level : null;
    return typeID !== null && level !== null ? [{ typeID, level }] : [];
  });
}

/** One recipe, or null when it cannot be looked up or multiplied. */
function decodeRecipe(value: JsonValue): IndustryRecipe | null {
  const row = asRecord(value);
  const productTypeID = asIdentifier(row.productTypeID);
  const blueprintTypeID = asIdentifier(row.blueprintTypeID);
  const activity = asActivity(row.activity);
  const quantityPerRun = asCount(row.quantityPerRun);
  if (productTypeID === null || blueprintTypeID === null || activity === null || quantityPerRun === null) {
    return null;
  }
  const inventedFrom: IndustryInvention[] = [];
  for (const raw of asArray(row.inventedFrom)) {
    const invention = decodeInvention(raw);
    if (invention !== null) {
      inventedFrom.push(invention);
    }
  }
  return {
    productTypeID,
    activity,
    blueprintTypeID,
    blueprintName: asName(row.blueprintName),
    quantityPerRun,
    timeSeconds: asCount(row.timeSeconds),
    maxRunsPerBlueprint: asCount(row.maxRunsPerBlueprint),
    materials: decodeMaterials(row.materials),
    inventedFrom,
    skills: decodeSkills(row.skills),
  };
}

function decodeTypeInfo(typeID: number, value: JsonValue | undefined): IndustryTypeInfo | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = asRecord(value);
  const volume = typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0
    ? row.volume
    : null;
  return {
    typeID,
    name: asName(row.name),
    groupID: asIdentifier(row.groupID),
    groupName: asName(row.groupName),
    categoryID: asIdentifier(row.categoryID),
    categoryName: asName(row.categoryName),
    volume,
  };
}

/** The answer of `POST /api/industry/recipe-closure`, as maps. */
export function decodeRecipeClosure(value: JsonValue): IndustryRecipeBook {
  const body = asRecord(value);
  if (!Array.isArray(body.recipes)) {
    return EMPTY_INDUSTRY_BOOK;
  }
  const byProduct = new Map<number, IndustryRecipe>();
  for (const raw of body.recipes) {
    const recipe = decodeRecipe(raw);
    // First one wins, as the BFF's own index already chose.
    if (recipe !== null && !byProduct.has(recipe.productTypeID)) {
      byProduct.set(recipe.productTypeID, recipe);
    }
  }
  const types = new Map<number, IndustryTypeInfo>();
  for (const [key, raw] of Object.entries(asRecord(body.types))) {
    const typeID = asIdentifier(key);
    const info = typeID === null ? null : decodeTypeInfo(typeID, raw);
    if (typeID !== null && info !== null) {
      types.set(typeID, info);
    }
  }
  const missing: number[] = [];
  for (const raw of asArray(body.missing)) {
    const typeID = asIdentifier(raw);
    if (typeID !== null) {
      missing.push(typeID);
    }
  }
  const skillTimePercent = new Map<number, number>();
  for (const [key, raw] of Object.entries(asRecord(body.skillTimePercent))) {
    const typeID = asIdentifier(key);
    if (typeID !== null && typeof raw === "number" && Number.isFinite(raw) && raw < 0) {
      skillTimePercent.set(typeID, raw);
    }
  }
  return { byProduct, types, missing, capped: body.capped === true, readable: true, skillTimePercent };
}

/** The answer of `GET /api/industry/blueprints/search`. */
export function decodeBlueprintSearch(value: JsonValue): IndustryBlueprintSearch {
  const body = asRecord(value);
  const matches: IndustryBlueprintMatch[] = [];
  for (const raw of asArray(body.matches)) {
    const row = asRecord(raw);
    const blueprintTypeID = asIdentifier(row.blueprintTypeID);
    const blueprintName = asName(row.blueprintName);
    const productTypeID = asIdentifier(row.productTypeID);
    const activity = asActivity(row.activity);
    if (blueprintTypeID !== null && blueprintName !== null && productTypeID !== null && activity !== null) {
      matches.push({ blueprintTypeID, blueprintName, productTypeID, productName: asName(row.productName), activity });
    }
  }
  const total = asCount(body.total) ?? matches.length;
  return { matches, total, capped: body.capped === true };
}

/** True for a planetary resource or commodity: a leaf here, planned in PI. */
export function isPlanetaryType(book: IndustryRecipeBook, typeID: number): boolean {
  const categoryID = book.types.get(typeID)?.categoryID ?? null;
  return categoryID !== null && PLANETARY_CATEGORY_IDS.has(categoryID);
}
