"use strict";

const { readModifiers, modifierValues, portraitHairStyle, portraitBeardStyle } = require("./portraitHair");
const { readColors, colorRowValues } = require("./portraitSkinTones");
const { portraitHairDarkness } = require("./portraitHairColors");
const sculptingRowType = "eve.common.script.paperDoll.paperDollDefinitions.SculptingRow";
const sculptAxes = [["down", "up"], ["right", "left"], ["back", "forward"]];
// The installed sculpting-limit files use these maxima for the three body sliders' morphs.
const bodySliderShapes = { thin: [0, 0.75], fat: [1, 1], muscular: [2, 0.75] };
const faceLayerOrder = ["eyeshadow", "eyebrows", "blush", "eyeliner", "lipstick"];

function previewSculptRows(appearance) {
  const fields = appearance?.type === "object" && appearance.args?.type === "dict" ? appearance.args.entries : null;
  const sculpts = Array.isArray(fields) ? fields.find(([key]) => (key?.value ?? key) === "sculpts")?.[1] : null;
  return sculpts?.type === "list" && Array.isArray(sculpts.items) ? sculpts.items : [];
}

function sculptFields(row) {
  const fields = row?.type === "objectex2" ? row.header?.[0] : null;
  return fields?.[0]?.value === sculptingRowType && Number.isSafeInteger(fields[1]) ? fields : null;
}

function sculptWeight(field) {
  const weight = field?.type === "real" ? field.value : field;
  return Number.isFinite(weight) ? Math.max(-1, Math.min(1, weight)) : 0;
}

function faceSculptControls(appearance, locations) {
  const rows = new Map(previewSculptRows(appearance).map(sculptFields).filter(Boolean).map(fields => [fields[1], fields]));
  return Object.entries(locations ?? {}).flatMap(([key, location]) => {
    const prefix = location?.weightKeyPrefix?.toLowerCase();
    if (location?.weightKeyCategory !== "faceModifiers" || !/^[a-z0-9_]+$/.test(prefix ?? "")) return [];
    const id = Number(key);
    return [{ id, prefix, axes: sculptAxes.map(([negative, positive], axis) => ({
      negative: `${prefix}_${negative}shape`, positive: `${prefix}_${positive}shape`,
      value: sculptWeight(rows.get(id)?.[axis + 2]),
    })) }];
  });
}

function appearanceWithFaceSculpts(appearance, edits, locations) {
  const controls = new Set(faceSculptControls(appearance, locations).map(control => control.id));
  return edits.every(edit => controls.has(edit.locationID)) ? appearanceWithSculptEdits(appearance, edits) : null;
}

function appearanceWithSculptEdits(appearance, edits) {
  const entries = appearance?.type === "object" && appearance.args?.type === "dict" ? appearance.args.entries : null;
  const sculptEntry = Array.isArray(entries) ? entries.find(([key]) => (key?.value ?? key) === "sculpts") : null;
  if (!Array.isArray(sculptEntry?.[1]?.items) || sculptEntry[1].type !== "list") return null;
  const originals = new Map(sculptEntry[1].items.map(sculptFields).filter(Boolean).map(fields => [fields[1], fields]));
  const byLocation = new Map();
  for (const { locationID, axis, value } of edits) {
    const fields = byLocation.get(locationID) ?? [...(originals.get(locationID)
      ?? [{ type: "token", value: sculptingRowType }, locationID, null, null, null])];
    fields[axis + 2] = value === 0 ? null : { type: "real", value };
    byLocation.set(locationID, fields);
  }
  const rows = sculptEntry[1].items.filter(row => !byLocation.has(sculptFields(row)?.[1]));
  for (const fields of byLocation.values()) {
    if (fields.slice(2, 5).some(field => sculptWeight(field) !== 0)) {
      rows.push({ type: "objectex2", header: [fields], list: [], dict: [] });
    }
  }
  return { ...appearance, args: { ...appearance.args, entries: entries.map(entry =>
    entry === sculptEntry ? [entry[0], { ...entry[1], items: rows }] : entry) } };
}

function bodySliderLocations(locations) {
  return new Map(Object.entries(locations ?? {}).flatMap(([id, row]) =>
    row?.weightKeyCategory === "bodyShapes" && Object.hasOwn(bodySliderShapes, row.weightKeyPrefix)
      ? [[row.weightKeyPrefix, Number(id)]] : []));
}

function specialBodyWeight(fields, shape) {
  const [axis] = bodySliderShapes[shape];
  // Older companion payloads can have populated another column for these one-axis shapes.
  return Math.max(0, sculptWeight(fields?.[axis + 2]) || fields?.slice(2, 5).map(sculptWeight).find(value => value > 0) || 0);
}

function portraitBodySliders(appearance, locations) {
  const ids = bodySliderLocations(locations);
  if (ids.size !== 3) return null;
  const rows = new Map(previewSculptRows(appearance).map(sculptFields).filter(Boolean).map(fields => [fields[1], fields]));
  const fraction = shape => Math.min(1, specialBodyWeight(rows.get(ids.get(shape)), shape) / bodySliderShapes[shape][1]);
  const fat = fraction("fat");
  return { weight: fat > 0 ? 0.5 + fat / 2 : (1 - fraction("thin")) / 2, muscularity: fraction("muscular"),
    limits: Object.fromEntries(Object.entries(bodySliderShapes).map(([shape, [, limit]]) => [shape, limit])) };
}

function appearanceWithBodySliders(appearance, sliders, locations) {
  const ids = bodySliderLocations(locations);
  if (ids.size !== 3) return null;
  const strengths = {};
  if (sliders.weight !== undefined) {
    strengths.thin = Math.max(0, 1 - 2 * sliders.weight);
    strengths.fat = Math.max(0, 2 * sliders.weight - 1);
  }
  if (sliders.muscularity !== undefined) strengths.muscular = sliders.muscularity;
  const edits = Object.entries(strengths).flatMap(([shape, strength]) => {
    const [bodyAxis, limit] = bodySliderShapes[shape];
    return [0, 1, 2].map(axis => ({ locationID: ids.get(shape), axis, value: axis === bodyAxis ? strength * limit : 0 }));
  });
  return appearanceWithSculptEdits(appearance, edits);
}

function portraitPreviewMorphs(rows, locations) {
  const morphs = new Map();
  for (const row of rows) {
    const fields = sculptFields(row);
    if (!fields) continue;
    const location = locations?.[fields[1]];
    const prefix = location?.weightKeyPrefix?.toLowerCase();
    if (!prefix || !/^[a-z0-9_]+$/.test(prefix)) continue;
    if (location.weightKeyCategory === "bodyShapes" && Object.hasOwn(bodySliderShapes, prefix)) {
      const weight = specialBodyWeight(fields, prefix);
      const name = `${prefix}shape`;
      if (weight) morphs.set(name, { name, weight, body: true });
      continue;
    }
    sculptAxes.forEach(([negative, positive], index) => {
      const weight = sculptWeight(fields[index + 2]);
      if (!weight) return;
      const name = `${prefix}_${weight < 0 ? negative : positive}shape`;
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

module.exports = { portraitPreviewModifiers, portraitPreviewMorphs, previewSculptRows, portraitPreviewMakeup,
  faceSculptControls, appearanceWithFaceSculpts, portraitBodySliders, appearanceWithBodySliders };
