"use strict";

const fs = require("node:fs");
const { paperDollMetadataPath, paperDollWaistTuck, readPaperDollYaml } = require("../../tools/client-extract/lib/paperDollOutfit.mjs");

const apparelFamilies = {
  female: { outer: ["jacketaf01", "jacketcf01", "jacketgf01", "jacketmf01", "spacesuit_top_01"],
    topouter: [],
    topmiddle: ["shirtaf01", "shirtcf01", "shirtgf01", "shirtmf01", "tanktopf01"],
    bottommiddle: ["tightsf01"],
    bottomouter: ["pantsaf01", "pantscf01", "pantsgf01", "pantsmf01", "pantsalf_01", "pantscorpbusinessf01",
      "pantsengf01", "pantsmilf01", "pantsprtf01", "pantsslf_01", "skirtmilf01", "skirtmilf02", "spacesuit_01"],
    feet: ["bootsaf01", "bootscf01", "bootsgf01", "bootsmf01", "bootsalf_01", "bootsmilf01", "bootsmilf02",
      "bootsmilf03", "bootsprtf01", "bootsslf_01", "shoesengf01", "spaceboots01f"],
    "accessories/glasses": ["glasses_pilot_01", "glasses_slick_01", "goggles_01", "glasses_citadel_f01", "glasses_exo_f01", "monocle_01", "monocle_f_t02", "eyeimp01"],
    "accessories/masks": ["mask_f", "mask_cyberpunk_f01"] },
  male: { outer: ["jacketam01", "jacketcm01", "jacketgm01", "jacketmm01", "robeam01"],
    topouter: ["shirtam01"],
    topmiddle: ["shirtcm01", "shirtgm01", "shirtmm01", "tanktopm01"],
    bottommiddle: [],
    bottomouter: ["pantsam01", "pantscm01", "pantsgm01", "pantsmm01", "pantsalm01", "pantsclm01",
      "pantscorpbusinessm01", "pantsengm01", "pantsmilm01", "pantsprtm01"],
    feet: ["bootsam01", "bootscm01", "shoesgm01", "bootsmm01", "bootsalm01", "bootsclm01", "bootsmilm01",
      "bootsmilm02", "bootsmilm03", "bootsprtm01", "shoescorpbusinessm01", "shoesengm01"],
    "accessories/glasses": ["glasses_pilot_01", "glasses_slick_01", "goggles_01", "glasses_citadel_m01", "glasses_exo_m01", "monocle_01", "monocle_m_t02", "eyeimp01"],
    "accessories/masks": ["mask_m", "mask_cyberpunk_m01"] },
};
const apparelSlots = Object.keys(apparelFamilies.male);
const optionalApparelSlots = ["outer", "topouter", "accessories/glasses", "bottommiddle", "accessories/masks"];
const stockApparelFactions = { a: "Amarr", c: "Caldari", g: "Gallente", m: "Minmatar" };
const eyewearNames = { glasses_pilot_01: "Pilot", glasses_slick_01: "Slick", goggles_01: "Goggles",
  glasses_citadel_f01: "Citadel", glasses_citadel_m01: "Citadel", glasses_exo_f01: "Exo", glasses_exo_m01: "Exo",
  monocle_01: "Monocle", monocle_f_t02: "Monocle Mk II", monocle_m_t02: "Monocle Mk II", eyeimp01: "Eye implant" };
const footwearNames = {
  bootsalf_01: "Alliance boots", bootsalm01: "Alliance boots", bootsclm01: "Classic boots",
  bootsmilf01: "Military boots 1", bootsmilm01: "Military boots 1", bootsmilf02: "Military boots 2", bootsmilm02: "Military boots 2",
  bootsmilf03: "Military boots 3", bootsmilm03: "Military boots 3", bootsprtf01: "Prototype boots", bootsprtm01: "Prototype boots",
  bootsslf_01: "Slim boots", shoesengf01: "Engineering shoes", shoesengm01: "Engineering shoes",
  shoescorpbusinessm01: "Business shoes", spaceboots01f: "Space boots",
};
const trouserNames = {
  pantsalf_01: "Alliance", pantsalm01: "Alliance", pantsclm01: "Classic",
  pantscorpbusinessf01: "Business", pantscorpbusinessm01: "Business", pantsengf01: "Engineering", pantsengm01: "Engineering",
  pantsmilf01: "Military", pantsmilm01: "Military", pantsprtf01: "Prototype", pantsprtm01: "Prototype", pantsslf_01: "Slim",
};
const skirtNames = { skirtmilf01: "Military skirt 1", skirtmilf02: "Military skirt 2" };

function isPortraitApparelType(path) {
  const match = /^res:\/graphics\/character\/(female|male)\/paperdoll\/(outer|topouter|topmiddle|bottommiddle|bottomouter|feet|accessories\/(?:glasses|masks))\/([a-z0-9_]+)\/types\/[a-z0-9_]+\.type$/.exec(path);
  return Boolean(match && apparelFamilies[match[1]][match[2]].includes(match[3]));
}

function isPortraitWaistTuckMetadata(path) {
  const match = /^res:\/graphics\/character\/(female|male)\/paperdoll\/bottomouter\/([a-z0-9_]+)(?:\/[a-z0-9_]+)?\/metadata\.yaml$/.exec(path);
  return Boolean(match && apparelFamilies[match[1]].bottomouter.includes(match[2])) ||
    /^res:\/graphics\/character\/(female|male)\/paperdoll\/dependants\/waisttucking\/standard\/v1\/metadata\.yaml$/.test(path);
}

function portraitApparelCanTuck(resource, model, fileFor) {
  if ((model !== "female" && model !== "male") || resource?.resGender !== (model === "female" ? 0 : 1)) return false;
  const paperDoll = `res:/graphics/character/${model}/paperdoll`;
  const typePath = typeof resource.resPath === "string" ? resource.resPath.toLowerCase().replace(/^res:\/.*\/paperdoll\//, "") : "";
  const path = /^(bottomouter\/[a-z0-9_]+)\/types\/[a-z0-9_]+\.type$/.exec(typePath);
  if (!path || !isPortraitApparelType(`${paperDoll}/${typePath}`)) return false;
  const store = {
    has(source) {
      const file = fileFor(source);
      return Boolean(file && fs.existsSync(file));
    },
    read: source => fs.readFileSync(fileFor(source)),
  };
  try {
    if (!store.has(`${paperDoll}/${typePath}`)) return false;
    const fields = readPaperDollYaml(store, `${paperDoll}/${typePath}`);
    if (!Array.isArray(fields) || typeof fields[0] !== "string" || fields[0].toLowerCase() !== path[1] ||
        typeof fields[1] !== "string" || !/^[a-z0-9_]*$/.test(fields[1])) return false;
    const metadata = paperDollMetadataPath(store, `${paperDoll}/${path[1]}`, fields[1]);
    return Boolean(metadata && paperDollWaistTuck(store, paperDoll, readPaperDollYaml(store, metadata)));
  } catch {
    return false;
  }
}

function portraitApparelChoices(resources, model, race, slot, fileFor, ownedTypeIDs) {
  const gender = model === "female" ? 0 : 1;
  const families = apparelFamilies[model][slot];
  const glasses = slot === "accessories/glasses";
  const masks = slot === "accessories/masks";
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    if (row.resGender !== gender || row.empireRestrictions?.includes(race) ||
        (row.typeID != null && !ownedTypeIDs?.has(row.typeID))) return [];
    const path = /^(outer|topouter|topmiddle|bottommiddle|bottomouter|feet|accessories\/(?:glasses|masks))\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/i.exec(row.resPath?.toLowerCase());
    if (!path || path[1] !== slot || !families.includes(path[2])) return [];
    const [, , family, variant] = path;
    const file = fileFor(`res:/graphics/character/${model}/paperdoll/${slot}/${family}/types/${variant}.type`);
    if (!file || !fs.existsSync(file)) return [];
    const footwear = slot === "feet" ? footwearNames[family] : null;
    const trousers = slot === "bottomouter" ? trouserNames[family] : null;
    const skirt = slot === "bottomouter" ? skirtNames[family] : null;
    const spacesuit = family === "spacesuit_top_01" ? "Spacesuit top" : family === "spacesuit_01" ? "Spacesuit trousers" : null;
    const variantShade = spacesuit ? variant.replace(/^spacesuit_01_(?:top_)?f_/, "")
      : glasses || masks || footwear || trousers || skirt
      ? variant.startsWith(family) ? variant.slice(family.length + 1)
        : variant.slice(variant.indexOf("_") + 1).replace(/^01_/, "")
      : variant.split("_").slice(1).join("_");
    const shade = variantShade
      .replaceAll("_", " ").replace(/^(left|right)t?(?=gold|gray|black|dark)/, "$1 ").replace(/(?<=[a-z])(\d+)/, " $1");
    const name = shade ? shade[0].toUpperCase() + shade.slice(1) : "Classic";
    const faction = slot === "outer" || slot === "bottommiddle" || masks ? null : stockApparelFactions[family.at(-4)];
    const label = glasses ? `${eyewearNames[family]} ${name}`
      : masks ? `${family.startsWith("mask_cyberpunk") ? "Cyberpunk" : "Mask"} ${name}`
      : footwear ? `${footwear} ${name}`
      : trousers ? `${trousers} trousers ${name}`
      : skirt ? `${skirt} ${name}`
      : spacesuit ? `${spacesuit} ${name}`
      : family === "robeam01" ? `Amarr robe ${name}`
      : /^tanktop[fm]01$/.test(family) ? `Tank top ${name.replace(/^Generic /, "")}`
      : faction ? `${faction} ${name}` : name;
    return [{ id: Number(key), name: label,
      ...(slot === "bottomouter" && portraitApparelCanTuck(row, model, fileFor) ? { canTuck: true } : {}),
      asset: `/client-assets/portrait-outfit/${model}/${slot === "outer" ? "" : `${slot}/`}${family}/${variant}.json` }];
  });
}

module.exports = { apparelSlots, optionalApparelSlots, isPortraitApparelType, isPortraitWaistTuckMetadata,
  portraitApparelCanTuck, portraitApparelChoices };
