"use strict";

const { readModifiers, modifierValues, portraitHairStyle } = require("./portraitHair");

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
    const garment = /^(outer|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
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

module.exports = { portraitPreviewModifiers };
