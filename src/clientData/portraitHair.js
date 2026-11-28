"use strict";

const { appearanceWithSkinTone } = require("./portraitSkinTones");

// Free styles with installed hair geometry or scalp textures.
const portraitHairStyles = Object.freeze({
  female: Object.freeze({
    hair_bob_02: "Bob",
    hair_braidedbun_01: "Braided bun",
    hair_braidedbun_02: "High braided bun",
    hair_bun_01: "Small bun",
    hair_bun_02: "Bun",
    hair_cornrowspigtails_01: "Cornrow pigtails",
    hair_dreadlocks_01: "Dreadlocks",
    hair_dreadlocksponytail_02: "Dreadlock ponytail",
    hair_frontcombed_02: "Brushed forward",
    hair_long_01: "Long straight",
    hair_long_02: "Long layered",
    hair_mediumparted_01: "Medium part",
    hair_mediumparted_04: "Medium swept part",
    hair_mediumstyled_01: "Medium styled",
    hair_mohawkunruly_01: "Tousled mohawk",
    hair_ponytailshort_01: "Short ponytail",
    hair_ponytail_01: "Ponytail",
    hair_ponytail_02: "Long ponytail",
    hair_short_01: "Short straight",
    hair_short_02: "Short layered",
    hair_shortpixietop_01: "Pixie cut",
    hair_shortstyled_01: "Short styled",
    hair_shortcut_03: "Close crop",
    hair_shorttop_01: "Short top",
    hair_sideparted_01: "Side part",
    hair_stubble_01: "Shaved stubble",
  }),
  male: Object.freeze({
    hair_armycut_03: "Buzz cut",
    hair_backcombed_01: "Brushed back",
    hair_backcombed_03: "Short brushed back",
    hair_cornrows_01: "Cornrows",
    hair_dreadlong_01: "Long dreadlocks",
    hair_implant_01: "Scalp implants I",
    hair_implant_02: "Scalp implants II",
    hair_implant_03: "Scalp implants III",
    hair_medium_01: "Medium length",
    hair_mediumcombed_01: "Medium combed",
    hair_mediumparted_02: "Medium part",
    hair_mediumparted_03: "Medium swept part",
    hair_mohawkshort_01: "Short mohawk",
    hair_mohawkcut_01: "Shaved mohawk",
    hair_receding_01: "Receding crop",
    hair_receding_02: "Receding hairline",
    hair_shortafro_03: "Close afro",
    hair_shortcut_01: "Close crop",
    hair_shortcut_02: "Short crop",
    hair_shortunruly_01: "Short tousled",
    hair_slick_01: "Slicked back",
    hair_slick_02: "Short slicked back",
    hair_stylecombed_01: "Combed and styled",
    hair_stubble_02: "Shaved stubble",
  }),
});
const scalpOnly = new Set([
  "hair_mohawkcut_01", "hair_receding_01", "hair_receding_02", "hair_shortafro_03", "hair_shortcut_01",
  "hair_shortcut_02", "hair_shortcut_03", "hair_stubble_01", "hair_stubble_02",
]);
const scalpAndMesh = new Set(["hair_bun_01", "hair_ponytail_02", "hair_ponytailshort_01"]);
const implantScalp = new Set(["hair_implant_01", "hair_implant_02", "hair_implant_03"]);
const modifierRowType = "eve.common.script.paperDoll.paperDollDefinitions.ModifierRow";

function portraitScalpMode(style) {
  if (implantScalp.has(style)) return "implant";
  if (scalpOnly.has(style)) return "only";
  return scalpAndMesh.has(style) ? "withMesh" : null;
}

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

module.exports = { appearanceWithHair, readModifiers, modifierValues, portraitHairChoices, portraitHairID, portraitHairStyle, portraitScalpMode };
