"use strict";

const { readModifiers, modifierValues, portraitHairStyle } = require("./portraitHair");

function portraitPreviewModifiers(appearance, gender, locations, resources) {
  const nativeGender = gender === "female" ? 0 : 1;
  let outfit = null;
  let hairstyle = null;
  for (const row of readModifiers(appearance)?.rows ?? []) {
    const fields = modifierValues(row);
    if (!fields) continue;
    const location = locations?.[fields[1]];
    const resource = resources?.[fields[2]];
    if (!location || resource?.resGender !== nativeGender || typeof resource.resPath !== "string") continue;
    const resourcePath = resource.resPath.toLowerCase()
      .replace(/^res:\/.*\/(?:modular\/(?:female|male)|(?:female|male)\/paperdoll)\//, "");
    if (location.modifierKey === "outer") {
      const match = /^outer\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/.exec(resourcePath);
      if (match) outfit = `/client-assets/portrait-outfit/${gender}/${match[1]}/${match[2]}.json`;
    } else if (location.modifierKey === "hair") {
      const style = /^hair\/(hair_[a-z0-9_]+)\/types\/\1\.type$/.exec(resourcePath)?.[1];
      if (style && portraitHairStyle(gender, style)) hairstyle = style;
    }
  }
  return { outfit, hairstyle };
}

module.exports = { portraitPreviewModifiers };
