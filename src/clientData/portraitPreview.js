"use strict";

const { readModifiers, modifierValues, portraitHairStyle } = require("./portraitHair");
const { readColors, colorRowValues } = require("./portraitSkinTones");
const sculptingRowType = "eve.common.script.paperDoll.paperDollDefinitions.SculptingRow";
const sculptAxes = [["down", "up"], ["right", "left"], ["back", "forward"]];

function previewSculptRows(appearance) {
  const fields = appearance?.type === "object" && appearance.args?.type === "dict" ? appearance.args.entries : null;
  const sculpts = Array.isArray(fields) ? fields.find(([key]) => (key?.value ?? key) === "sculpts")?.[1] : null;
  return sculpts?.type === "list" && Array.isArray(sculpts.items) ? sculpts.items : [];
}

function portraitPreviewMorphs(rows, locations) {
  const morphs = new Map();
  for (const row of rows) {
    const fields = row?.type === "objectex2" ? row.header?.[0] : null;
    if (fields?.[0]?.value !== sculptingRowType || !Number.isSafeInteger(fields[1])) continue;
    const location = locations?.[fields[1]];
    const prefix = location?.weightKeyPrefix?.toLowerCase();
    if (!prefix || !/^[a-z0-9_]+$/.test(prefix)) continue;
    sculptAxes.forEach(([negative, positive], index) => {
      const field = fields[index + 2];
      const weight = field?.type === "real" ? field.value : field;
      if (!Number.isFinite(weight) || !weight) return;
      const name = /^(thin|fat|muscular)$/.test(prefix) ? `${prefix}shape`
        : `${prefix}_${weight < 0 ? negative : positive}shape`;
      morphs.set(name, { name, weight: Math.min(Math.abs(weight), 1),
        ...(location.weightKeyCategory === "bodyShapes" ? { body: true } : {}) });
    });
  }
  return Array.from(morphs.values());
}

function portraitPreviewModifiers(appearance, gender, locations, resources) {
  const nativeGender = gender === "female" ? 0 : 1;
  let outfit = null;
  let hairstyle = null;
  let eyeStyle = null;
  const apparel = {};
  const piercings = {};
  for (const row of readModifiers(appearance)?.rows ?? []) {
    const fields = modifierValues(row);
    if (!fields) continue;
    const location = locations?.[fields[1]];
    const resource = resources?.[fields[2]];
    if (!location || resource?.resGender !== nativeGender || typeof resource.resPath !== "string") continue;
    const resourcePath = resource.resPath.toLowerCase()
      .replace(/^res:\/.*\/(?:modular\/(?:female|male)|(?:female|male)\/paperdoll)\//, "");
    const piercing = /^(accessories\/(?:nose|lips|brow|earslow|earshigh))\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
    if (piercing && piercing[1] === location.modifierKey) {
      const [, slot, style, variant] = piercing;
      piercings[slot] = `/client-assets/portrait-outfit/${gender}/${slot}/${style}/${variant}.json`;
    }
    const garment = /^(outer|topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
    if (garment && garment[1] === location.modifierKey) {
      const [, slot, style, variant] = garment;
      const root = `/client-assets/portrait-outfit/${gender}`;
      if (slot === "outer") outfit = `${root}/${style}/${variant}.json`;
      else apparel[slot] = `${root}/${slot}/${style}/${variant}.json`;
    } else if (location.modifierKey === "hair") {
      const style = /^hair\/(hair_[a-z0-9_]+)\/types\/\1\.type$/.exec(resourcePath)?.[1];
      if (style && portraitHairStyle(gender, style)) hairstyle = style;
    } else if (location.modifierKey === "makeup/eyes") {
      eyeStyle = /^makeup\/eyes\/(eyes_[a-z0-9_]+)\/types\/\1\.type$/.exec(resourcePath)?.[1] ?? null;
    }
  }
  return { outfit, apparel, hairstyle, piercings: Object.values(piercings), eyeStyle };
}

function portraitPreviewIris(appearance, gender, style, locations, names) {
  if (!style) return null;
  let palette = "default";
  for (const row of readColors(appearance)?.rows ?? []) {
    const fields = colorRowValues(row);
    if (!fields || !/^(?:paperdoll\/)?makeup\/eyes$/.test(locations?.[fields[1]]?.colorKey ?? "")) continue;
    const color = names?.[fields[2]]?.colorName;
    if (typeof color === "string" && /^[a-z0-9_]+$/i.test(color)) palette = color.toLowerCase();
  }
  return `/client-assets/portrait-head/${gender}/eyes/${style}/${palette}.json`;
}

module.exports = { portraitPreviewModifiers, portraitPreviewMorphs, previewSculptRows, portraitPreviewIris };
