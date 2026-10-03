"use strict";

// The industry recipe book (goal R109 slice 1): which blueprint makes what, out
// of what, as pure functions over the raw `industryBlueprints` rows.
//
// ---------------------------------------------------------------------------
// THE FILE'S OWN REVERSE INDEX IS NOT USED, ON PURPOSE.
//
// `industryBlueprints/data.json` ships `blueprintTypeIDsByProductTypeID`, and it
// looks like exactly the product -> blueprint lookup a build tree needs. It is
// missing every reaction: reaction rows carry `productTypeID: 0` at top level and
// name their product only inside `activities.reaction.products`, so all 119
// published formulas are absent from it (measured 2026-10-01). A tree built on it
// would stop at every composite and call it "buy". The index here is built from
// the ACTIVITY products instead, which is where the server's own install path
// reads the product from.
//
// ---------------------------------------------------------------------------
// PUBLISHED ONLY.
//
// 905 of the 5081 rows are unpublished (test blueprints, retired items). A
// player cannot hold or run one, so a tree that routed through one would plan
// something impossible. They are dropped here, once, rather than filtered by
// every reader.
//
// ---------------------------------------------------------------------------
// NAMES ARE NOT THIS MODULE'S JOB.
//
// The index carries ids and the blueprint's own name (which the row has). Type
// names, groups and categories are resolved by the route through static data,
// the same way every other static route here names things (R7d: never a
// stringified id).

/** The two activities that turn materials into a product a tree can use. */
const BUILD_ACTIVITIES = Object.freeze(["manufacturing", "reaction"]);

function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function cleanMaterials(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const materials = [];
  for (const entry of list) {
    const typeID = positiveInt(entry && entry.typeID);
    const quantity = positiveInt(entry && entry.quantity);
    if (typeID > 0 && quantity > 0) {
      materials.push({ typeID, quantity });
    }
  }
  return materials;
}

/** Skills an activity needs: [{ typeID, level }], level 0 allowed. */
function cleanSkills(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const skills = [];
  for (const entry of list) {
    const typeID = positiveInt(entry && entry.typeID);
    const level = Number(entry && entry.level);
    if (typeID > 0 && Number.isFinite(level) && level >= 0) {
      skills.push({ typeID, level: Math.trunc(level) });
    }
  }
  return skills;
}

function isPublished(row) {
  return Boolean(row) && row.published !== false;
}

/**
 * Index raw blueprint rows. Returns:
 * - `byProduct`: productTypeID -> recipe (manufacturing or reaction)
 * - `inventedFrom`: blueprintTypeID -> the published blueprints that invent it
 * - `searchable`: one entry per recipe, for name search
 *
 * When two published recipes make the same product (none do today), the one
 * with the LOWEST blueprintTypeID wins, so the answer is stable across reloads
 * rather than depending on row order.
 */
function buildIndustryRecipeIndex(rows) {
  const byProduct = new Map();
  const inventedFrom = new Map();
  const list = Array.isArray(rows) ? rows : [];

  for (const row of list) {
    if (!isPublished(row)) {
      continue;
    }
    const blueprintTypeID = positiveInt(row.blueprintTypeID);
    const activities = row.activities && typeof row.activities === "object" ? row.activities : {};
    if (blueprintTypeID <= 0) {
      continue;
    }

    for (const activity of BUILD_ACTIVITIES) {
      const entry = activities[activity];
      const products = cleanMaterials(entry && entry.products);
      // One product per build activity, across the whole real table. A row
      // that ever breaks that is skipped rather than guessed at.
      if (!entry || products.length !== 1) {
        continue;
      }
      const product = products[0];
      const recipe = {
        productTypeID: product.typeID,
        activity,
        blueprintTypeID,
        blueprintName: typeof row.blueprintName === "string" && row.blueprintName.length > 0
          ? row.blueprintName
          : null,
        quantityPerRun: product.quantity,
        timeSeconds: positiveInt(entry.time) || null,
        maxRunsPerBlueprint: positiveInt(row.maxProductionLimit) || null,
        materials: cleanMaterials(entry.materials),
        // The skills the activity asks for. A manufacturing one may shorten the
        // job (the server's resolveRequiredSkillTimeModifier); the closure route
        // says by how much.
        skills: cleanSkills(entry.skills),
      };
      const known = byProduct.get(product.typeID);
      if (!known || blueprintTypeID < known.blueprintTypeID) {
        byProduct.set(product.typeID, recipe);
      }
    }

    const invention = activities.invention;
    const invented = cleanMaterials(invention && invention.products);
    for (const product of invented) {
      const raw = invention.products.find((entry) => positiveInt(entry && entry.typeID) === product.typeID);
      const probability = Number(raw && raw.probability);
      const source = {
        blueprintTypeID,
        blueprintName: typeof row.blueprintName === "string" && row.blueprintName.length > 0
          ? row.blueprintName
          : null,
        runsPerCopy: product.quantity,
        probability: Number.isFinite(probability) && probability > 0 && probability <= 1
          ? probability
          : null,
        timeSeconds: positiveInt(invention.time) || null,
        materials: cleanMaterials(invention.materials),
        // Every skill here counts toward the chance (the server sums them all);
        // which ones count at the lower rate is the invention terms route's.
        skills: cleanSkills(invention.skills),
      };
      const sources = inventedFrom.get(product.typeID) || [];
      sources.push(source);
      inventedFrom.set(product.typeID, sources);
    }
  }

  for (const sources of inventedFrom.values()) {
    sources.sort((a, b) => a.blueprintTypeID - b.blueprintTypeID);
  }

  const searchable = [...byProduct.values()]
    .filter((recipe) => recipe.blueprintName !== null)
    .map((recipe) => ({
      blueprintTypeID: recipe.blueprintTypeID,
      blueprintName: recipe.blueprintName,
      productTypeID: recipe.productTypeID,
      activity: recipe.activity,
      lowerName: recipe.blueprintName.toLowerCase(),
    }));

  return { byProduct, inventedFrom, searchable };
}

/**
 * Every recipe reachable from the asked-for products, walking materials.
 *
 * `recipes` is in discovery order (breadth first from the asked products), so
 * the asked-for ones come first. `typeIDs` is every type the answer mentions,
 * products and materials and invention inputs alike, for the route to name.
 * `missing` is each asked product that no published recipe makes.
 *
 * Bounded by `maxRecipes`: the deepest real tree (a capital) is a few hundred
 * recipes, so hitting the bound means something is wrong, and the answer says
 * `capped` rather than stopping silently.
 */
function recipeClosure(index, productTypeIDs, options = {}) {
  const maxRecipes = positiveInt(options.maxRecipes) || 2000;
  const queue = [];
  const seen = new Set();
  const missing = [];
  for (const value of Array.isArray(productTypeIDs) ? productTypeIDs : []) {
    const typeID = positiveInt(value);
    if (typeID > 0 && !seen.has(typeID)) {
      seen.add(typeID);
      queue.push(typeID);
      if (!index.byProduct.has(typeID)) {
        missing.push(typeID);
      }
    }
  }

  const recipes = [];
  const typeIDs = new Set(seen);
  let capped = false;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const recipe = index.byProduct.get(queue[cursor]);
    if (!recipe) {
      continue;
    }
    if (recipes.length >= maxRecipes) {
      capped = true;
      break;
    }
    const sources = recipe.activity === "manufacturing"
      ? index.inventedFrom.get(recipe.blueprintTypeID) || []
      : [];
    recipes.push({ ...recipe, inventedFrom: sources });
    typeIDs.add(recipe.blueprintTypeID);
    for (const source of sources) {
      typeIDs.add(source.blueprintTypeID);
      for (const material of source.materials) {
        typeIDs.add(material.typeID);
      }
    }
    for (const material of recipe.materials) {
      typeIDs.add(material.typeID);
      if (!seen.has(material.typeID)) {
        seen.add(material.typeID);
        queue.push(material.typeID);
      }
    }
  }

  return { recipes, typeIDs: [...typeIDs], missing, capped, limit: maxRecipes };
}

/**
 * Published blueprints and formulas whose name contains `q`, best first:
 * a name that starts with it, then one with a word that starts with it, then
 * any other; shorter names before longer ones; then alphabetical.
 */
function searchIndustryBlueprints(index, q, limit) {
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  const cap = Math.min(Math.max(positiveInt(limit) || 25, 1), 50);
  if (needle.length < 2) {
    return { matches: [], total: 0, capped: false, limit: cap };
  }
  const scored = [];
  for (const entry of index.searchable) {
    const at = entry.lowerName.indexOf(needle);
    if (at < 0) {
      continue;
    }
    const score = at === 0 ? 0 : entry.lowerName.includes(` ${needle}`) ? 1 : 2;
    scored.push({ score, entry });
  }
  scored.sort((a, b) =>
    a.score - b.score ||
    a.entry.blueprintName.length - b.entry.blueprintName.length ||
    a.entry.blueprintName.localeCompare(b.entry.blueprintName) ||
    a.entry.blueprintTypeID - b.entry.blueprintTypeID);
  const total = scored.length;
  const matches = scored.slice(0, cap).map(({ entry }) => ({
    blueprintTypeID: entry.blueprintTypeID,
    blueprintName: entry.blueprintName,
    productTypeID: entry.productTypeID,
    activity: entry.activity,
  }));
  return { matches, total, capped: total > cap, limit: cap };
}

module.exports = {
  BUILD_ACTIVITIES,
  buildIndustryRecipeIndex,
  recipeClosure,
  searchIndustryBlueprints,
};
