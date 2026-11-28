"use strict";

const fs = require("node:fs");

const apparelFamilies = {
  female: { topmiddle: "shirtgf01", bottomouter: "pantsgf01", feet: "bootsgf01" },
  male: { topmiddle: "shirtgm01", bottomouter: "pantsmm01", feet: "bootsmm01" },
};
const apparelSlots = Object.keys(apparelFamilies.male);

function isPortraitApparelType(path) {
  const match = /^res:\/graphics\/character\/(female|male)\/paperdoll\/(topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/[a-z0-9_]+\.type$/.exec(path);
  return Boolean(match && apparelFamilies[match[1]][match[2]] === match[3]);
}

function portraitApparelChoices(resources, model, race, slot, fileFor) {
  const gender = model === "female" ? 0 : 1;
  const family = apparelFamilies[model][slot];
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    if (row.resGender !== gender || row.typeID != null ||
      (row.empireRestrictions?.length && !row.empireRestrictions.includes(race))) return [];
    const path = /^(topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/i.exec(row.resPath?.toLowerCase());
    if (!path || path[1] !== slot || path[2] !== family) return [];
    const variant = path[3];
    const file = fileFor(`res:/graphics/character/${model}/paperdoll/${slot}/${family}/types/${variant}.type`);
    if (!file || !fs.existsSync(file)) return [];
    const shade = variant.split("_").slice(1).join(" ").replace(/(?<=[a-z])(\d+)/, " $1");
    return [{ id: Number(key), name: shade ? shade[0].toUpperCase() + shade.slice(1) : "Classic",
      asset: `/client-assets/portrait-outfit/${model}/${slot}/${family}/${variant}.json` }];
  });
}

module.exports = { apparelSlots, isPortraitApparelType, portraitApparelChoices };
