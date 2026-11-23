"use strict";

// Data-only adapter for the signedFunc envelope emitted by empire-specialized-haulers.
const { inflateSync } = require("node:zlib");
const { createHash } = require("node:crypto");

const MAX_LOGIN_BYTES = 2 * 1024 * 1024;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_TYPES = 4096;
const REQUIREMENT_ATTRIBUTES = [
  [182, 277], [183, 278], [184, 279],
  [1285, 1286], [1289, 1287], [1290, 1288],
];

const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value && typeof value === "object" && !Array.isArray(value);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const emptyCatalog = () => ({ types: new Map(), dogma: new Map(), effects: new Map() });

function accept(catalog, target, handshakeSHA256) {
  const additions = catalog?.additions;
  const types = additions?.itemTypes;
  const dogma = additions?.typeDogma ?? {};
  const effects = catalog?.effects ?? {};
  if (!Array.isArray(types) || !types.length || types.length > MAX_TYPES ||
      !(record(dogma) || Array.isArray(dogma)) || !record(effects)) return;

  const dogmaByType = new Map(Object.values(dogma).map(row => [row?.typeID, row]));
  if (types.some(row => !record(row) || !positive(row.typeID) || !positive(row.groupID) ||
      !positive(row.categoryID) || typeof row.name !== "string" || !row.name.trim() ||
      typeof row.published !== "boolean") ||
      new Set(types.map(row => row.typeID)).size !== types.length) return;

  for (const { typeID } of types) {
    const row = dogmaByType.get(typeID);
    if (row && ((row.defaultEffectID != null && (!Array.isArray(row.effects) || !row.effects.includes(row.defaultEffectID))) || !record(row.attributes) || !Array.isArray(row.effects) || !row.effects.every(positive) ||
        Object.entries(row.attributes).some(([id, value]) => !positive(Number(id)) || !Number.isFinite(value)))) return;
  }

  const effectiveSource = { kind: "GAMEPORT_LOGIN_CATALOG", handshakeSHA256, catalogSHA256: sha256(JSON.stringify(catalog)) };
  for (const row of types) {
    target.types.set(row.typeID, { ...row, effectiveSource });
    const facts = dogmaByType.get(row.typeID);
    if (facts) target.dogma.set(row.typeID, { ...facts, effectiveSource });
    else target.dogma.delete(row.typeID);
  }
  for (const [key, row] of Object.entries(effects)) {
    const id = Number(key);
    if (positive(id) && record(row) && row.effectID === id && typeof row.name === "string" &&
        Number.isSafeInteger(row.effectCategoryID)) target.effects.set(id, { ...row, effectiveSource });
  }
}

// This wrapper preserves the value of its one native argument. Identify the exact
// wrapper before extracting its DATA literal or consulting the native digest allowlist.
const prefix = "(lambda _result: (eval(compile(__import__('base64').b64decode('";
const separator = "'), '<empire-hauler-login>', 'exec'), {'__builtins__': __builtins__, '_family_context': globals()}), _result)[1])(";
function requiredSkills(dogma) {
  const skills = [];
  for (const [skillAttribute, levelAttribute] of REQUIREMENT_ATTRIBUTES) {
    const skillID = dogma.attributes[skillAttribute];
    if (skillID === undefined || skillID === 0) continue;
    const level = dogma.attributes[levelAttribute];
    if (!positive(skillID) || !positive(level) || level > 5) return null;
    skills.push([skillID, level]);
  }
  return skills;
}

const builtDataFields = new Map([
  ["typeBasePrices", "basePrice"], ["typePublished", "published"], ["typePortionSizes", "portionSize"],
  ["typeDynamic", "isDynamicType"],
]);

function createEffectiveCatalog() {
  let effective = emptyCatalog();
  let lastBundle;
  function observeLogin(source, digest) {
    if (!Buffer.isBuffer(source) || source.length < 6 || source.length > MAX_LOGIN_BYTES ||
        source[0] !== 0x74 || source.readUInt32LE(1) !== source.length - 5) return;
    const expression = source.toString("latin1", 5);
    if (!expression.startsWith(prefix) || !expression.endsWith(")")) return;
    const end = expression.indexOf(separator, prefix.length);
    if (end < 0) return;
    const encoded = expression.slice(prefix.length, end);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
    const program = Buffer.from(encoded, "base64").toString("latin1");
    const bundle = /^_family_bundle = "([A-Za-z0-9+/]+={0,2})"\r?\n/.exec(program)?.[1];
    if (!bundle) return;
    if (bundle !== lastBundle) {
      try {
        const bytes = inflateSync(Buffer.from(bundle, "base64"), { maxOutputLength: MAX_INFLATED_BYTES });
        const next = emptyCatalog();
        accept(JSON.parse(bytes.toString("utf8")).catalog, next, digest ?? sha256(source));
        if (next.types.size) { effective = next; lastBundle = bundle; }
      } catch { /* Malformed metadata cannot invalidate a prior login. */ }
    }
    const native = Buffer.from(expression.slice(end + separator.length, -1), "latin1");
    const header = Buffer.alloc(5);
    header[0] = 0x74;
    header.writeUInt32LE(native.length, 1);
    return sha256(Buffer.concat([header, native]));
  }

  function overrides(name, keys) {
    let rows = effective.types;
    let project = row => row;
    switch (name) {
      case "types":
        break;
      case "typeDogma":
        rows = effective.dogma;
        project = row => ({
          dogmaAttributes: Object.entries(row.attributes).map(([attributeID, value]) => ({ attributeID: Number(attributeID), value })),
          dogmaEffects: row.effects.map(effectID => ({ effectID, isDefault: Number(effectID === row.defaultEffectID) })),
        });
        break;
      case "dogmaEffects":
        rows = effective.effects;
        project = row => ({ ...row, effectName: row.name, effectCategory: row.effectCategoryID });
        break;
      case "requiredSkillsForTypes":
        rows = effective.dogma;
        project = requiredSkills;
        break;
      default: {
        const field = builtDataFields.get(name);
        if (!field) return null;
        project = row => row[field];
      }
    }
    if (!rows.size) return null;
    const extra = {};
    for (const key of keys ?? rows.keys()) {
      const row = rows.get(Number(key));
      if (!row) continue;
      const value = project(row);
      if (value != null) extra[key] = value;
    }
    return Object.keys(extra).length ? extra : null;
  }

  function withEffectiveCatalog(base) {
    const tables = new Map();
    return {
      ...base,
      async table(name) {
        const original = await base.table(name);
        const cached = tables.get(name);
        if (cached?.catalog === effective && cached.original === original) return cached.value;
        const extra = overrides(name);
        // "additions" is additive. Installed values always take precedence.
        let value = original;
        if (extra) {
          value = { ...original };
          for (const [id, addition] of Object.entries(extra)) if (value[id] == null) value[id] = addition;
        }
        tables.set(name, { catalog: effective, original, value });
        return value;
      },
      async rows(name, ids) {
        const original = await base.rows(name, ids);
        const extra = overrides(name, ids);
        if (!extra) return original;
        const rows = { ...original };
        for (const [id, value] of Object.entries(extra)) if (rows[id] == null) rows[id] = value;
        return rows;
      },
    };
  }

  return {
    observeLogin, withEffectiveCatalog,
    listTypes: () => [...effective.types.values()],
    getType: id => effective.types.get(Number(id)) ?? null,
    getDogma: id => effective.dogma.get(Number(id)) ?? null,
    getEffect: id => effective.effects.get(Number(id)) ?? null,
  };
}
module.exports = { createEffectiveCatalog };
