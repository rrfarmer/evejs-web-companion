"use strict";

const { readModifiers, modifierValues, portraitHairStyle, portraitBeardStyle } = require("./portraitHair");
const { readColors, colorRowValues } = require("./portraitSkinTones");
const { portraitHairDarkness } = require("./portraitHairColors");
const sculptingRowType = "eve.common.script.paperDoll.paperDollDefinitions.SculptingRow";
const sculptAxes = [["down", "up"], ["right", "left"], ["back", "forward"]];
const faceLayerOrder = ["eyeshadow", "eyebrows", "blush", "eyeliner", "lipstick"];

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
  let robeHood = null;
  let hairstyle = null;
  const faceStyles = {};
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
    const garment = /^(outer|topouter|topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
    if (garment && garment[1] === location.modifierKey) {
      const [, slot, style, variant] = garment;
      const root = `/client-assets/portrait-outfit/${gender}`;
      if (slot === "outer") {
        outfit = `${root}/${style}/${variant}.json`;
        if (gender === "male" && style === "robeam01") robeHood = fields[3] === 1 || fields[3] === 2 ? fields[3] : 0;
      } else apparel[slot] = `${root}/${slot}/${style}/${variant}.json`;
    } else if (location.modifierKey === "hair") {
      const style = /^hair\/(hair_[a-z0-9_]+)\/types\/\1\.type$/.exec(resourcePath)?.[1];
      if (style) faceStyles.hair = style;
      if (style && portraitHairStyle(gender, style)) hairstyle = style;
    } else if (location.modifierKey === "beard") {
      const style = portraitBeardStyle(resource);
      if (style && (!faceStyles.beard || style !== "stubble")) faceStyles.beard = style;
    } else {
      const face = /^makeup\/([a-z]+)\/(\1_[a-z0-9_]+)\/types\/\2\.type$/.exec(resourcePath);
      if (face && (face[1] === "eyes" || faceLayerOrder.includes(face[1])) && `makeup/${face[1]}` === location.modifierKey) {
        faceStyles[face[1]] = face[2];
      }
    }
  }
  return { outfit, robeHood, apparel, hairstyle, piercings: Object.values(piercings), faceStyles };
}

function unitValue(field, fallback) {
  const value = field?.type === "real" ? field.value : field;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function portraitPreviewMakeup(appearance, gender, styles, locations, names) {
  const selections = new Map();
  const saved = readColors(appearance);
  let useHairPalette = true;
  for (const row of saved?.rows ?? []) {
    const fields = colorRowValues(row);
    if (!fields) continue;
    const location = locations?.[fields[1]];
    const category = location?.colorKey === "hair" && (styles.eyebrows || styles.beard) ? "hair"
      : /^(?:paperdoll\/)?makeup\/([a-z]+)$/.exec(location?.colorKey ?? "")?.[1];
    if (!category || !styles[category]) continue;
    const color = names?.[fields[2]]?.colorName;
    const palette = typeof color === "string" && /^[a-z0-9_]+$/i.test(color) ? color.toLowerCase() : "default";
    const secondary = location.hasSecondary && fields[3] ? names?.[fields[3]]?.colorName : null;
    if (category === "hair" || category === "eyebrows") useHairPalette = category === "hair";
    selections.set(category, { palette: secondary && /^[a-z0-9_]+$/i.test(secondary) ? `${palette}~${secondary.toLowerCase()}` : palette,
      weight: location.hasWeight ? unitValue(fields[4], 1) : 1,
      gloss: location.hasGloss ? unitValue(fields[5], null) : null });
  }
  const hair = selections.get("hair");
  if (useHairPalette && styles.eyebrows && styles.hair) {
    const darkness = portraitHairDarkness(appearance) ?? 0;
    // The client takes brow B/C from hair unchanged and interpolates only A from 20% to 100%.
    selections.set("eyebrows", { palette: `hair_${hair?.palette ?? "default"}`, weight: 1, gloss: null,
      primaryScale: 0.2 + 0.8 * darkness });
  }
  const stem = `/client-assets/portrait-head/${gender}`;
  const iris = styles.eyes ? `${stem}/eyes/${styles.eyes}/${selections.get("eyes")?.palette ?? "default"}.json` : null;
  const makeup = faceLayerOrder.flatMap(category => {
    const style = styles[category];
    const { palette, ...layer } = selections.get(category) ?? { palette: "default", weight: 1, gloss: null };
    return style && layer.weight > 0 ? [{ asset: `${stem}/makeup/${category}/${style}/${palette}.json`, ...layer }] : [];
  });
  if (styles.beard) {
    const painted = styles.beard.startsWith("beard_");
    const base = painted ? "stubble" : styles.beard;
    makeup.push({ asset: `${stem}/makeup/beard/${base}/default.json`, weight: 1, gloss: null });
    if (painted) makeup.push({ asset: `${stem}/makeup/beard/${styles.beard}/hair_${hair?.palette ?? "default"}.json`,
      weight: 1, gloss: null, primaryScale: 0.2 + 0.8 * (portraitHairDarkness(appearance) ?? 0) });
  }
  return { iris, makeup };
}

module.exports = { portraitPreviewModifiers, portraitPreviewMorphs, previewSculptRows, portraitPreviewMakeup };
