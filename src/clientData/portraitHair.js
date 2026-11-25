"use strict";

const { appearanceWithSkinTone } = require("./portraitSkinTones");

// Free styles with an installed skinned mesh and a full, uncropped hair atlas.
const portraitHairStyles = Object.freeze({
  female: Object.freeze({ hair_bob_02: "Bob", hair_bun_02: "Bun" }),
  male: Object.freeze({ hair_armycut_03: "Buzz cut", hair_backcombed_01: "Brushed back" }),
});
const modifierRowType = "eve.common.script.paperDoll.paperDollDefinitions.ModifierRow";

function portraitHairStyle(gender, style) {
  return Object.hasOwn(portraitHairStyles, gender) && Object.hasOwn(portraitHairStyles[gender], style)
    ? portraitHairStyles[gender][style] : null;
}

function portraitHairChoices(resources, gender, raceID) {
  const nativeGender = gender === "female" ? 0 : 1;
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    const style = /^hair\/(hair_[a-z0-9_]+)\/types\/\1\.type$/i.exec(row.resPath)?.[1]?.toLowerCase();
    const name = style && portraitHairStyle(gender, style);
    const id = Number(key);
    return name && row.resGender === nativeGender && row.typeID == null &&
      (!row.empireRestrictions?.length || row.empireRestrictions.includes(raceID)) ? [{ id, name, style }] : [];
  });
}

function readModifiers(payload) {
  const entries = payload?.type === "object" && payload.args?.type === "dict" ? payload.args.entries : null;
  const modifiers = entries?.find(([key]) => key === "modifiers")?.[1];
  return modifiers?.type === "list" && Array.isArray(modifiers.items) ? { entries, rows: modifiers.items } : null;
}

function modifierValues(row) {
  const fields = row?.header?.[0];
  return row?.type === "objectex2" && fields?.[0]?.value === modifierRowType ? fields : null;
}

function portraitHairID(payload, location) {
  for (const row of readModifiers(payload)?.rows ?? []) {
    const values = modifierValues(row);
    if (values?.[1] === location) return values[2];
  }
  return 0;
}

function appearanceWithHair(payload, location, id) {
  const source = payload ?? appearanceWithSkinTone(null, [], 0);
  const existing = readModifiers(source);
  if (!existing) return null;
  const rows = existing.rows.filter(row => modifierValues(row)?.[1] !== location);
  if (id) rows.push({ type: "objectex2", header: [[{ type: "token", value: modifierRowType }, location, id, null]], list: [], dict: [] });
  return { ...source, args: { ...source.args, entries: existing.entries.map(([key, value]) =>
    [key, key === "modifiers" ? { type: "list", items: rows } : value]) } };
}

module.exports = { appearanceWithHair, portraitHairChoices, portraitHairID, portraitHairStyle };
