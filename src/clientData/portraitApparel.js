"use strict";

const fs = require("node:fs");

const apparelFamilies = {
  female: { outer: ["jacketaf01", "jacketcf01", "jacketgf01", "jacketmf01"],
    topouter: [],
    topmiddle: ["shirtaf01", "shirtcf01", "shirtgf01", "shirtmf01", "tanktopf01"],
    bottomouter: ["pantsaf01", "pantscf01", "pantsgf01", "pantsmf01"],
    feet: ["bootsaf01", "bootscf01", "bootsgf01", "bootsmf01"],
    "accessories/glasses": ["glasses_pilot_01", "glasses_slick_01"] },
  male: { outer: ["jacketam01", "jacketcm01", "jacketgm01", "jacketmm01", "robeam01"],
    topouter: ["shirtam01"],
    topmiddle: ["shirtcm01", "shirtgm01", "shirtmm01", "tanktopm01"],
    bottomouter: ["pantsam01", "pantscm01", "pantsgm01", "pantsmm01"],
    feet: ["bootsam01", "bootscm01", "shoesgm01", "bootsmm01"],
    "accessories/glasses": ["glasses_pilot_01", "glasses_slick_01"] },
};
const apparelSlots = Object.keys(apparelFamilies.male);
const optionalApparelSlots = ["outer", "topouter", "accessories/glasses"];
const stockApparelFactions = { a: "Amarr", c: "Caldari", g: "Gallente", m: "Minmatar" };

function isPortraitApparelType(path) {
  const match = /^res:\/graphics\/character\/(female|male)\/paperdoll\/(outer|topouter|topmiddle|bottomouter|feet|accessories\/glasses)\/([a-z0-9_]+)\/types\/[a-z0-9_]+\.type$/.exec(path);
  return Boolean(match && apparelFamilies[match[1]][match[2]].includes(match[3]));
}

function portraitApparelChoices(resources, model, race, slot, fileFor) {
  const gender = model === "female" ? 0 : 1;
  const families = apparelFamilies[model][slot];
  const glasses = slot === "accessories/glasses";
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    if (row.resGender !== gender || row.typeID != null || row.empireRestrictions?.includes(race)) return [];
    const path = /^(outer|topouter|topmiddle|bottomouter|feet|accessories\/glasses)\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/i.exec(row.resPath?.toLowerCase());
    if (!path || path[1] !== slot || !families.includes(path[2])) return [];
    const [, , family, variant] = path;
    const file = fileFor(`res:/graphics/character/${model}/paperdoll/${slot}/${family}/types/${variant}.type`);
    if (!file || !fs.existsSync(file)) return [];
    const pilotGlasses = family === "glasses_pilot_01";
    const shade = variant.split("_").slice(glasses ? (pilotGlasses ? 2 : 3) : 1).join(" ").replace(/(?<=[a-z])(\d+)/, " $1");
    const name = shade ? shade[0].toUpperCase() + shade.slice(1) : "Classic";
    const faction = slot === "outer" ? null : stockApparelFactions[family.at(-4)];
    const label = glasses ? `${pilotGlasses ? "Pilot" : "Slick"} ${name}`
      : family === "robeam01" ? `Amarr robe ${name}`
      : /^tanktop[fm]01$/.test(family) ? `Tank top ${name.replace(/^Generic /, "")}`
      : faction ? `${faction} ${name}` : name;
    return [{ id: Number(key), name: label,
      asset: `/client-assets/portrait-outfit/${model}/${slot === "outer" ? "" : `${slot}/`}${family}/${variant}.json` }];
  });
}

module.exports = { apparelSlots, optionalApparelSlots, isPortraitApparelType, portraitApparelChoices };
