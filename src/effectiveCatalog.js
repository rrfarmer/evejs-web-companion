"use strict";

// WC75's native login catalog. The login program is read as data.
const { inflateSync } = require("node:zlib");
const { createHash } = require("node:crypto");

const MAX_LOGIN_BYTES = 2 * 1024 * 1024;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 32;
const MAX_TYPES = 4096;
const REQUIREMENT_ATTRIBUTES = [
  [182, 277], [183, 278], [184, 279],
  [1285, 1286], [1289, 1287], [1290, 1288],
];

const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value && typeof value === "object" && !Array.isArray(value);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const emptyCatalog = () => ({ types: new Map(), dogma: new Map(), effects: new Map() });
let effective = emptyCatalog();
let lastHandshake = null;

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
    if (row && (!record(row.attributes) || !Array.isArray(row.effects) || !row.effects.every(positive) ||
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

/** Extract the bounded JSON catalog embedded in the server's native login program. */
function observeLogin(source, handshakeSHA256) {
  if (!Buffer.isBuffer(source) || source.length > MAX_LOGIN_BYTES) return false;
  const digest = handshakeSHA256 ?? sha256(source);
  if (digest === lastHandshake) return effective.types.size > 0;

  const next = emptyCatalog();
  const parts = [source];
  const seen = new Set();
  let remainingBytes = MAX_DECODED_BYTES - source.length;
  for (const bytes of parts) {
    const hash = bytes === source ? digest : sha256(bytes);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const text = bytes.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      try {
        const value = JSON.parse(text);
        accept(value?.catalog ?? value, next, digest);
      } catch { /* Not a readable catalog. */ }
    }

    for (const match of text.matchAll(/["']([A-Za-z0-9+/]{128,}={0,2})["']/g)) {
      if (parts.length >= MAX_PARTS || remainingBytes === 0) break;
      const decoded = Buffer.from(match[1], "base64");
      if (decoded.length > MAX_LOGIN_BYTES || decoded.length > remainingBytes) continue;
      parts.push(decoded);
      remainingBytes -= decoded.length;
      if (parts.length >= MAX_PARTS || remainingBytes === 0) break;
      try {
        const inflated = inflateSync(decoded, { maxOutputLength: Math.min(MAX_INFLATED_BYTES, remainingBytes) });
        parts.push(inflated);
        remainingBytes -= inflated.length;
      } catch { /* Some carriers are plain base64. */ }
    }
  }
  lastHandshake = digest;
  effective = next;
  return effective.types.size > 0;
}

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
    if (value !== undefined) extra[key] = value;
  }
  return Object.keys(extra).length ? extra : null;
}

function withEffectiveCatalog(base) {
  return {
    ...base,
    async table(name) {
      const original = await base.table(name);
      const extra = overrides(name);
      return extra ? { ...original, ...extra } : original;
    },
    async rows(name, ids) {
      const original = await base.rows(name, ids);
      const extra = overrides(name, ids);
      return extra ? { ...original, ...extra } : original;
    },
  };
}

module.exports = {
  observeLogin, withEffectiveCatalog,
  listTypes: () => [...effective.types.values()],
  getType: id => effective.types.get(Number(id)) ?? null,
  getDogma: id => effective.dogma.get(Number(id)) ?? null,
  getEffect: id => effective.effects.get(Number(id)) ?? null,
};
