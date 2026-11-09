// The Space Object Factory's data (res:/dx9/model/spaceobjectfactory/data.black), as trinity's EveSOF builds a ship
// from it: a hull's areas (shader, textures, parameters), the faction's materials for each area (areaTypes:
// material1..4, each a named EveSOFDataMaterial: DiffuseColor, DustDiffuseColor, FresnelColor, Gloss), the faction's
// colour set, and the hull's booster locators. Read with lib/black.mjs.
//
// Area types are EveSOFDataArea::AreaType (trinity/Eve/SpaceObjectFactory/EveSOFData.h). A slot an area type does not
// name is the faction's Primary material for that slot, as EveSOF falls back to TYPE_PRIMARY.

import { readBlack } from "./black.mjs";

export const AREA_TYPES = ["Primary", "Glass", "Sails", "Reactor", "Darkhull", "Wreck", "Rock", "Monument", "Ornament", "SimplePrimary"];

const cache = new WeakMap();

/** data.black, read once per client. */
export function loadSof(rf) {
  if (cache.has(rf)) return cache.get(rf);
  const data = readBlack(rf.read("res:/dx9/model/spaceobjectfactory/data.black"), "data.black");
  const sof = {
    data,
    hulls: new Map(data.hull.map((h) => [h.name.toLowerCase(), h])),
    factions: new Map(data.faction.map((f) => [f.name.toLowerCase(), f])),
    materials: new Map(data.material.map((m) => [m.name.toLowerCase(), m])),
  };
  cache.set(rf, sof);
  return sof;
}

const params = (list) => Object.fromEntries((list ?? []).filter((p) => p && p.name).map((p) => [p.name, p.value ?? null]));

function material(sof, name) {
  if (!name) return null;
  const m = sof.materials.get(String(name).toLowerCase());
  if (!m) return { name, missing: true };
  const p = params(m.parameters);
  return { name: m.name, diffuse: p.DiffuseColor ?? null, dust: p.DustDiffuseColor ?? null, fresnel: p.FresnelColor ?? null, gloss: p.Gloss ? p.Gloss[0] : null };
}

/**
 * A hull as built for a faction: { areas: [{ name, index, areaType, shader, textures: { name: res }, params,
 * materials: [m1..m4] }], colorSet, boosters: [{ transform }], boundingSphere }. Textures are res: paths.
 */
export function buildHull(sof, hullName, factionName) {
  const hull = sof.hulls.get(String(hullName).toLowerCase());
  if (!hull) return null;
  const faction = factionName ? sof.factions.get(String(factionName).toLowerCase()) ?? null : null;
  const areaTypes = faction?.areaTypes ?? {};
  const areas = [];
  for (const [list, kind] of [[hull.opaqueAreas, "opaque"], [hull.transparentAreas, "transparent"], [hull.additiveAreas, "additive"]]) {
    for (const a of list ?? []) {
      const typeName = AREA_TYPES[a.areaType ?? 0] ?? "Primary";
      const ofType = areaTypes[typeName] ?? {};
      const primary = areaTypes.Primary ?? {};
      areas.push({
        kind,
        name: a.name,
        index: a.index ?? 0,
        areaType: typeName,
        shader: a.shader ?? null,
        textures: Object.fromEntries((a.textures ?? []).filter((t) => t.resFilePath).map((t) => [t.name, t.resFilePath])),
        params: params(a.parameters),
        materials: [1, 2, 3, 4].map((i) => material(sof, ofType[`material${i}`] ?? primary[`material${i}`])),
        colorType: ofType.colorType ?? null,
      });
    }
  }
  const colorSet = faction?.colorSet ? Object.fromEntries(Object.entries(faction.colorSet).filter(([k]) => k !== "type")) : null;
  return {
    hull: hull.name,
    faction: faction?.name ?? null,
    areas,
    colorSet,
    boosters: (hull.booster?.items ?? []).map((b) => ({ transform: b.transform ?? null, hasTrail: b.hasTrail ?? null })),
    boundingSphere: hull.boundingSphere ?? null,
  };
}
