// The Space Object Factory's data (res:/dx9/model/spaceobjectfactory/data.black), as trinity's EveSOF builds a ship
// from it: a hull's areas (shader, textures, parameters), the faction's materials for each area (areaTypes:
// material1..4, each a named EveSOFDataMaterial: DiffuseColor, DustDiffuseColor, FresnelColor, Gloss), the faction's
// colour set, and the hull's booster locators. Read with lib/black.mjs.
//
// Area types are EveSOFDataArea::AreaType (trinity/Eve/SpaceObjectFactory/EveSOFData.h). A slot an area type does not
// name is the faction's Primary material for that slot, as EveSOF falls back to TYPE_PRIMARY.

import { readBlack } from "./black.mjs";

/**
 * EveSOFDataFactionColorSet's colour types by index, as a light set item names its colour (lightColor). Inferred from
 * use, not read from trinity: the hangars' light sets name 18 to 21 (the four Light colours, with Black at 3), and the
 * rest they name (4, 6, 7) are White, Orange and Red.
 */
export const COLOR_TYPES = ["Primary", "Secondary", "Tertiary", "Black", "White", "Yellow", "Orange", "Red", "Blue", "Green", "Cyan", "Fire",
  "Hull", "Glass", "Reactor", "Darkhull", "Booster", "Killmark", "PrimaryLight", "SecondaryLight", "TertiaryLight", "WhiteLight"];

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
    races: new Map(data.race.map((r) => [r.name.toLowerCase(), r])),
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
export function buildHull(sof, hullName, factionName, raceName = null) {
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
  // The race's engines (EveSOFDataRace.booster): the flame's colours and shapes, the glow and the halo, as the
  // client's EveBoosterSet2 is set up from them.
  const rb = raceName ? sof.races.get(String(raceName).toLowerCase())?.booster ?? null : null;
  const booster = rb ? {
    glowColor: rb.glowColor ?? null, glowScale: rb.glowScale ?? null, haloColor: rb.haloColor ?? null,
    haloScaleX: rb.haloScaleX ?? null, haloScaleY: rb.haloScaleY ?? null, symHaloScale: rb.symHaloScale ?? null,
    trailColor: rb.trailColor ?? null, trailSize: rb.trailSize ?? null,
    shape0Color: rb.shape0?.color ?? null, shape1Color: rb.shape1?.color ?? null,
    warpShape0Color: rb.warpShape0?.color ?? null, warpGlowColor: rb.warpGlowColor ?? null,
  } : null;
  return {
    hull: hull.name,
    faction: faction?.name ?? null,
    race: raceName ?? null,
    booster,
    areas,
    colorSet,
    boosters: (hull.booster?.items ?? []).map((b) => ({ transform: b.transform ?? null, hasTrail: b.hasTrail ?? null })),
    boundingSphere: hull.boundingSphere ?? null,
    // The hull's "anchorpoint" locator (a hangar's: where its ship floats, DefaultHangarShipBehaviour.SetAnchorPoint).
    anchor: (hull.locatorSets ?? []).find((s) => String(s.name).trim() === "anchorpoint")?.locators?.[0]?.position ?? null,
    // Its "maxCameraDistance" locator (a hangar's: hangarView.LoadCamera takes the farthest zoom from its length).
    maxCameraDistance: (hull.locatorSets ?? []).find((s) => String(s.name).trim() === "maxCameraDistance")?.locators?.[0]?.position ?? null,
    // Its point lights (EveSOFDataHullLightSet items), each its colour from the faction's colour set.
    lights: (hull.lightSets ?? []).flatMap((set) => (set.items ?? []).map((it) => ({
      position: it.position ?? [0, 0, 0], radius: it.radius ?? null, innerRadius: it.innerRadius ?? null, brightness: it.brightness ?? 1,
      color: (colorSet && colorSet[COLOR_TYPES[it.lightColor ?? 0]]) ?? null,
    }))),
  };
}
