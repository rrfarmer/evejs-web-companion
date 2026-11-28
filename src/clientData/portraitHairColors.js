"use strict";

const fs = require("node:fs");
const { appearanceWithSkinTone, readColors, colorRowValues } = require("./portraitSkinTones");
const appearanceRowType = "eve.common.script.paperDoll.paperDollDefinitions.AppearanceRow";

function hairAppearanceRow(payload) {
  const entries = payload?.type === "object" && payload.args?.type === "dict" ? payload.args.entries : null;
  const row = Array.isArray(entries) ? entries.find(([key]) => key === "appearance")?.[1] : null;
  return row?.type === "objectex2" && row.header?.[0]?.[0]?.value === appearanceRowType ? row : null;
}

function portraitHairDarkness(payload) {
  const field = hairAppearanceRow(payload)?.header[0][1];
  const value = field?.type === "real" ? field.value : field;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function appearanceWithHairDarkness(payload, darkness) {
  const row = hairAppearanceRow(payload);
  if (!row) return null;
  const [fields, ...header] = row.header;
  const updated = [...fields];
  updated[1] = { type: "real", value: darkness };
  return { ...payload, args: { ...payload.args, entries: payload.args.entries.map(([key, value]) =>
    [key, key === "appearance" ? { ...row, header: [updated, ...header] } : value]) } };
}

function hairColorLocation(locations) {
  return Number(Object.entries(locations ?? {}).find(([, row]) => row.colorKey === "hair" && row.hasSecondary)?.[0]);
}

function readHairPalette(gender, name, fileFor) {
  const file = fileFor(`res:/graphics/character/${gender}/paperdoll/hair/colors/${name}.color`);
  if (!file) return null;
  let contents;
  try { contents = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const colors = Array.from(contents.split(/^pattern:/m, 1)[0].matchAll(/^- !!python\/tuple \[([^\]]+)\]/gm),
    match => match[1].split(",").slice(0, 3).map(Number));
  return colors.length === 3 && colors.every(rgb => rgb.length === 3 && rgb.every(value => value >= 0 && value <= 1))
    ? colors : null;
}

function hairColorCatalog(gender, names, fileFor) {
  const groups = { primary: [], secondary: [] };
  for (const [key, row] of Object.entries(names ?? {})) {
    const name = row.colorName?.toLowerCase();
    const match = /^(0[1-9]|1[0-9]|2[0-8])_(a|bc)$/.exec(name);
    if (!match || (match[2] === "a" && Number(match[1]) > 22)) continue;
    const colors = readHairPalette(gender, name, fileFor);
    if (!colors) continue;
    groups[match[2] === "a" ? "primary" : "secondary"].push({ id: Number(key), key: name, name: `Color ${match[1]}`, colors });
  }
  for (const [key, group] of Object.entries(groups)) {
    const rowIndex = key === "primary" ? 0 : 1;
    const yiq = ({ colors }) => {
      const [r, g, b] = colors[rowIndex];
      const y = 0.30 * r + 0.59 * g + 0.11 * b;
      return [y, 0.74 * (r - y) - 0.27 * (b - y), 0.48 * (r - y) + 0.41 * (b - y)];
    };
    group.sort((a, b) => {
      const [ay, ai, aq] = yiq(a), [by, bi, bq] = yiq(b);
      return ay - by || ai - bi || aq - bq || a.key.localeCompare(b.key);
    });
  }
  return groups;
}

function hairColorSelection(payload, location) {
  for (const row of readColors(payload)?.rows ?? []) {
    const fields = colorRowValues(row);
    if (fields && fields[1] === location) return { primaryID: fields[2] || 0, secondaryID: fields[3] || 0 };
  }
  return { primaryID: 0, secondaryID: 0 };
}

function portraitHairTints(appearance, gender, locations, names, fileFor) {
  const { primaryID, secondaryID } = hairColorSelection(appearance, hairColorLocation(locations));
  const primaryName = names?.[primaryID]?.colorName?.toLowerCase();
  const secondaryName = names?.[secondaryID]?.colorName?.toLowerCase();
  const primary = /^\d{2}_a$/.test(primaryName) ? readHairPalette(gender, primaryName, fileFor) : null;
  const secondary = /^\d{2}_bc$/.test(secondaryName) ? readHairPalette(gender, secondaryName, fileFor) : null;
  return primary || secondary ? { primary: primary?.[0], secondary: secondary?.slice(1) } : null;
}

function appearanceWithHairColors(payload, location, selection) {
  const source = payload ?? appearanceWithSkinTone(null, [], 0);
  const existing = readColors(source);
  if (!existing) return null;
  const previous = existing.rows.find(row => colorRowValues(row)?.[1] === location);
  const fields = colorRowValues(previous);
  const rows = existing.rows.filter(row => colorRowValues(row)?.[1] !== location);
  if (selection.primaryID || selection.secondaryID) {
    const token = fields?.[0] ?? { type: "token", value: "eve.common.script.paperDoll.paperDollDefinitions.ColorSelectionRow" };
    rows.push({ type: "objectex2", header: [[token, location, selection.primaryID, selection.secondaryID, fields?.[4] ?? 0,
      fields?.[5] ?? 0]], list: [], dict: [] });
  }
  return { ...source, args: { ...source.args, entries: existing.entries.map(([key, value]) =>
    [key, key === "colors" ? { type: "list", items: rows } : value]) } };
}

module.exports = { hairColorCatalog, hairColorLocation, hairColorSelection, appearanceWithHairColors, portraitHairTints,
  appearanceWithHairDarkness, portraitHairDarkness };
