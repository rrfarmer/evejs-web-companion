"use strict";

const fs = require("node:fs");

function portraitShirtChoices(resources, model, race, fileFor) {
  const gender = model === "female" ? 0 : 1;
  const family = model === "female" ? "shirtgf01" : "shirtgm01";
  return Object.entries(resources ?? {}).flatMap(([key, row]) => {
    if (row.resGender !== gender || row.typeID != null ||
      (row.empireRestrictions?.length && !row.empireRestrictions.includes(race))) return [];
    const path = /^topmiddle\/([a-z0-9_]+)\/types\/([a-z0-9_]+)\.type$/i.exec(row.resPath);
    if (path?.[1].toLowerCase() !== family) return [];
    const variant = path[2].toLowerCase();
    const file = fileFor(`res:/graphics/character/${model}/paperdoll/topmiddle/${family}/types/${variant}.type`);
    if (!file || !fs.existsSync(file)) return [];
    const shade = variant.slice(family.length + 1).replace(/_/g, " ").replace(/(?<=[a-z])(\d+)/, " $1");
    return [{ id: Number(key), name: shade ? shade[0].toUpperCase() + shade.slice(1) : "Classic",
      asset: `/client-assets/portrait-outfit/${model}/topmiddle/${family}/${variant}.json` }];
  });
}

module.exports = { portraitShirtChoices };
