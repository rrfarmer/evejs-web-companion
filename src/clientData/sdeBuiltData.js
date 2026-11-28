"use strict";

// ── The client's built tables that CCP's SDE also has, for a BFF with no install ──
//
// The page's own dogma and its Show Info windows go by the client's static data
// (GET /api/client-data/dogma-types), which clientBuiltData.js reads from the
// install's fsdbinary files with the client's own loaders. CCP's SDE has the
// same rows for those tables, of the same build (config.js SDE_BUILD, 3396210),
// in its JSONL. A BFF with no install answers them from it here, in the shapes
// the client's loaders give them, so the route answers as it does with one
// (docs/native-layer-optional-plan.md, phase 2). With an install the client's
// own tables are read and this is not used.
//
// Only the tables the dogma-types route reads, and of a row only what it reads;
// any other table is null, as clientBuiltData answers one it cannot read. Where
// the SDE leaves a field out, the client's loader gives 0 (a type's radius 1);
// the SDE's true and false are the loaders' 1 and 0; an attribute's default is
// a float32 in the client's file, so the SDE's decimal is taken as one.
//
// requiredSkillsForTypes is the client's own table, made here from the types'
// dogma: each required skill attribute with a skill, and its level attribute,
// in the order of the six attribute pairs.
//
// Checked 2026-10-28 against the install of the same build, every row of every
// table here on what the route reads (52,590 types, 3,411 effects, 2,855
// attributes). The same, but for:
//   - the order of a type's required skills, for 1,379 types: the client's
//     table has its own order, which no rule from the SDE gives. The page's
//     dogma picks up required-skill modifiers in this order, so a figure can
//     differ from the install's in its last binary digit;
//   - a radius of 0, not 1, for three environment types (40550, 70826, 76359);
//   - a type with no dogma or no materials, which the client's table has as an
//     empty row and this as none: the route reads the two alike.

const REQUIREMENT_ATTRIBUTES = Object.freeze([
  [182, 277], [183, 278], [184, 279],
  [1285, 1286], [1289, 1287], [1290, 1288],
]);

/** A whole number or a number as the SDE has it, else the loader's default. */
const or = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
/** The SDE's true or false as the loaders' 1 or 0. */
const flag = (value) => (value ? 1 : 0);
/** An id the record may have none of: null where it has none. */
const idOrNull = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

function typeRow(row) {
  return {
    typeID: row._key,
    groupID: or(row.groupID, 0),
    mass: or(row.mass, 0),
    capacity: or(row.capacity, 0),
    volume: or(row.volume, 0),
    radius: or(row.radius, 1),
    portionSize: or(row.portionSize, 0),
    published: flag(row.published),
    basePrice: or(row.basePrice, 0),
  };
}

function typeDogmaRow(row) {
  return {
    dogmaAttributes: (Array.isArray(row.dogmaAttributes) ? row.dogmaAttributes : []).map((entry) => ({ attributeID: entry.attributeID, value: entry.value })),
    dogmaEffects: (Array.isArray(row.dogmaEffects) ? row.dogmaEffects : []).map((entry) => ({ effectID: entry.effectID, isDefault: flag(entry.isDefault) })),
  };
}

function effectRow(row) {
  const out = { effectID: row._key, effectName: typeof row.name === "string" ? row.name : null, effectCategory: or(row.effectCategoryID, 0) };
  for (const field of ["durationAttributeID", "dischargeAttributeID", "rangeAttributeID", "falloffAttributeID", "trackingSpeedAttributeID", "fittingUsageChanceAttributeID"]) {
    if (idOrNull(row[field]) !== null) out[field] = row[field];
  }
  if (Array.isArray(row.modifierInfo) && row.modifierInfo.length > 0) out.modifierInfo = row.modifierInfo.map((info) => ({ ...info }));
  return out;
}

function attributeRow(row) {
  return {
    attributeID: row._key,
    name: typeof row.name === "string" ? row.name : null,
    dataType: or(row.dataType, 0),
    defaultValue: Math.fround(or(row.defaultValue, 0)),
    stackable: flag(row.stackable),
    highIsGood: flag(row.highIsGood),
    maxAttributeID: idOrNull(row.maxAttributeID),
    minAttributeID: idOrNull(row.minAttributeID),
    chargeRechargeTimeID: idOrNull(row.chargeRechargeTimeID),
  };
}

/**
 * The SDE's answer for some of the client's built tables, with clientBuiltData's own table and rows:
 *
 *   table(name)         Promise of the whole table, an object by key; null for a table not here
 *   rows(name, keys)    Promise of those rows, an object by key (a key it has not: null); null for a table not here
 *
 * `jsonl(fileName)` is staticData.buildJsonlIndex: the SDE file's rows by their key, read once.
 */
function createSdeBuiltData({ jsonl }) {
  const ROWS = Object.freeze({
    types: ["types.jsonl", typeRow],
    typeDogma: ["typeDogma.jsonl", typeDogmaRow],
    typeMaterials: ["typeMaterials.jsonl", (row) => ({ materials: (row.materials || []).map((m) => ({ materialTypeID: m.materialTypeID, quantity: m.quantity })) })],
    dogmaEffects: ["dogmaEffects.jsonl", effectRow],
  });
  const kept = new Map();
  function whole(name, make) {
    if (!kept.has(name)) kept.set(name, make());
    return kept.get(name);
  }
  const TABLES = Object.freeze({
    dogmaAttributes: () => Object.fromEntries([...jsonl("dogmaAttributes.jsonl").values()].map((row) => [String(row._key), attributeRow(row)])),
    groupCategories: () => Object.fromEntries([...jsonl("groups.jsonl").values()].map((row) => [String(row._key), or(row.categoryID, 0)])),
    typeBasePrices: () => Object.fromEntries([...jsonl("types.jsonl").values()].map((row) => [String(row._key), or(row.basePrice, 0)])),
    typePortionSizes: () => Object.fromEntries([...jsonl("types.jsonl").values()].map((row) => [String(row._key), or(row.portionSize, 0)])),
    requiredSkillsForTypes: () => {
      const out = {};
      for (const row of jsonl("typeDogma.jsonl").values()) {
        const values = new Map((row.dogmaAttributes || []).map((entry) => [entry.attributeID, entry.value]));
        const required = [];
        for (const [skillAttribute, levelAttribute] of REQUIREMENT_ATTRIBUTES) {
          const skill = values.get(skillAttribute);
          if (Number.isSafeInteger(skill) && skill > 0) required.push([skill, or(values.get(levelAttribute), 0)]);
        }
        if (required.length > 0) out[String(row._key)] = required;
      }
      return out;
    },
  });
  return {
    table(name) {
      return Promise.resolve(Object.hasOwn(TABLES, name) ? whole(name, TABLES[name]) : null);
    },
    rows(name, keys) {
      if (!Object.hasOwn(ROWS, name)) return Promise.resolve(null);
      const [fileName, make] = ROWS[name];
      const index = jsonl(fileName);
      const out = {};
      for (const key of keys) {
        const id = Number(key);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const row = index.get(id);
        out[String(id)] = row ? make(row) : null;
      }
      return Promise.resolve(out);
    },
  };
}

module.exports = { createSdeBuiltData };
