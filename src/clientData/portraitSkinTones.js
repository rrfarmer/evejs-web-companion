"use strict";

const fs = require("node:fs");

// character.py GetCharacterColorVariations filters the installed skin tones by bloodline.
const bloodlinePrefixes = new Map([
  [1, "deteis"], [2, "civire"], [3, "sebiestor"], [4, "brutor"], [5, "amarr"], [6, "nikunni"],
  [7, "gallente"], [8, "intaki"], [11, "achura"], [12, "jinmei"], [13, "khanid"], [14, "vherokior"],
]);
const shades = [
  ["light", "Light"], ["midlight", "Medium light"], ["default", "Standard"],
  ["middark", "Medium dark"], ["dark", "Dark"],
];
const colorRowType = "eve.common.script.paperDoll.paperDollDefinitions.ColorSelectionRow";

function readColors(payload) {
  const entries = payload?.type === "object" && payload.args?.type === "dict" ? payload.args.entries : null;
  const colors = entries?.find(([name]) => name === "colors")?.[1];
  return colors?.type === "list" && Array.isArray(colors.items) ? { entries, rows: colors.items } : null;
}

function colorRowValues(row) {
  const fields = row?.header?.[0];
  return row?.type === "objectex2" && fields?.[0]?.value === colorRowType ? fields : null;
}

function skinToneID(payload, locations) {
  for (const row of readColors(payload)?.rows ?? []) {
    const values = colorRowValues(row);
    if (values && locations.includes(values[1])) return values[2];
  }
  return 0;
}

function appearanceWithSkinTone(payload, locations, colorID) {
  const existing = readColors(payload);
  if (!existing && payload !== null) return null;
  const colors = (existing?.rows ?? []).filter(row => !locations.includes(colorRowValues(row)?.[1]));
  if (colorID) colors.push({ type: "objectex2", header: [[{ type: "token", value: colorRowType }, locations[0], colorID, 0, 0, 0]], list: [], dict: [] });
  const entries = existing ? existing.entries.filter(([key]) => key !== "colors") : [
    ["appearance", { type: "objectex2", header: [[{ type: "token", value: "eve.common.script.paperDoll.paperDollDefinitions.AppearanceRow" }, 0]], list: [], dict: [] }],
    ["modifiers", { type: "list", items: [] }],
    ["sculpts", { type: "list", items: [] }],
  ];
  return { type: "object", name: payload?.name ?? "util.KeyVal", args: {
    type: "dict", entries: [...entries, ["colors", { type: "list", items: colors }]],
  } };
}

function skinToneCatalog(bloodline, gender, colorNames, fileFor) {
  const prefix = bloodlinePrefixes.get(bloodline);
  if (!prefix) return [];
  const ids = new Map(Object.entries(colorNames ?? {}).map(([id, row]) => [row.colorName, Number(id)]));
  return shades.flatMap(([shade, name]) => {
    const key = `${prefix}_${shade}`;
    const id = ids.get(key);
    const file = id && fileFor(`res:/graphics/character/${gender}/paperdoll/skintone/basic/${key}.color`);
    if (!file) return [];
    let contents;
    try { contents = fs.readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const rows = Array.from(contents.split(/^pattern:/m, 1)[0].matchAll(/^- !!python\/tuple \[([^\]]+)\]/gm), match =>
      match[1].split(",").slice(0, 3).map(Number));
    return rows.length === 3 && rows.every(row => row.length === 3 && row.every(value => value >= 0 && value <= 1)) ?
      [{ id, name, colors: rows }] : [];
  });
}

module.exports = { appearanceWithSkinTone, skinToneCatalog, skinToneID };
