"use strict";

const { readModifiers, modifierValues, portraitHairStyle } = require("./portraitHair");
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
  const apparel = {};
  for (const row of readModifiers(appearance)?.rows ?? []) {
    const fields = modifierValues(row);
    if (!fields) continue;
    const location = locations?.[fields[1]];
    const resource = resources?.[fields[2]];
    if (!location || resource?.resGender !== nativeGender || typeof resource.resPath !== "string") continue;
    const resourcePath = resource.resPath.toLowerCase()
      .replace(/^res:\/.*\/(?:modular\/(?:female|male)|(?:female|male)\/paperdoll)\//, "");
    const garment = /^(outer|topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
    if (garment && garment[1] === location.modifierKey) {
      const [, slot, style, variant] = garment;
      const root = `/client-assets/portrait-outfit/${gender}`;
      if (slot === "outer") outfit = `${root}/${style}/${variant}.json`;
      else apparel[slot] = `${root}/${slot}/${style}/${variant}.json`;
    } else if (location.modifierKey === "hair") {
      const style = /^hair\/(hair_[a-z0-9_]+)\/types\/\1\.type$/.exec(resourcePath)?.[1];
      if (style && portraitHairStyle(gender, style)) hairstyle = style;
    }
  }
  return { outfit, apparel, hairstyle };
}

module.exports = { portraitPreviewModifiers, portraitPreviewMorphs, previewSculptRows };
