"use strict";

const fs = require("node:fs");

const apparelFamilies = {
  female: { outer: ["jacketaf01", "jacketcf01", "jacketgf01", "jacketmf01"],
    topmiddle: ["shirtgf01"], bottomouter: ["pantsaf01", "pantscf01", "pantsgf01", "pantsmf01"],
    feet: ["bootsaf01", "bootscf01", "bootsgf01", "bootsmf01"] },
  male: { outer: ["jacketam01", "jacketcm01", "jacketgm01", "jacketmm01"],
    topmiddle: ["shirtgm01"], bottomouter: ["pantsam01", "pantscm01", "pantsgm01", "pantsmm01"],
    feet: ["bootsam01", "bootscm01", "shoesgm01", "bootsmm01"] },
};
const apparelSlots = Object.keys(apparelFamilies.male);
const stockApparelFactions = { a: "Amarr", c: "Caldari", g: "Gallente", m: "Minmatar" };

function isPortraitApparelType(path) {
  const match = /^res:\/graphics\/character\/(female|male)\/paperdoll\/(outer|topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/[a-z0-9_]+\.type$/.exec(path);
  return Boolean(match && apparelFamilies[match[1]][match[2]].includes(match[3]));
}

function portraitApparelChoices(resources, model, race, slot, fileFor) {
  const gender = model === "female" ? 0 : 1;
  const families = apparelFamilies[model][slot];
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    if (row.resGender !== gender || row.typeID != null ||
      (row.empireRestrictions?.length && !row.empireRestrictions.includes(race))) return [];
    const path = /^(outer|topmiddle|bottomouter|feet)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/i.exec(row.resPath?.toLowerCase());
    if (!path || path[1] !== slot || !families.includes(path[2])) return [];
    const [, , family, variant] = path;
    const file = fileFor(`res:/graphics/character/${model}/paperdoll/${slot}/${family}/types/${variant}.type`);
    if (!file || !fs.existsSync(file)) return [];
    const shade = variant.split("_").slice(1).join(" ").replace(/(?<=[a-z])(\d+)/, " $1");
    const name = shade ? shade[0].toUpperCase() + shade.slice(1) : "Classic";
    const faction = slot === "bottomouter" || slot === "feet" ? stockApparelFactions[family.at(-4)] : null;
    return [{ id: Number(key), name: faction ? `${faction} ${name}` : name,
      asset: `/client-assets/portrait-outfit/${model}/${slot === "outer" ? "" : `${slot}/`}${family}/${variant}.json` }];
  });
}

module.exports = { apparelSlots, isPortraitApparelType, portraitApparelChoices };
