// The Space Object Factory's data (res:/dx9/model/spaceobjectfactory/data.black), as trinity's EveSOF builds a ship
// from it: a hull's areas (shader, textures, parameters), the faction's materials for each area (areaTypes:
// material1..4, each a named EveSOFDataMaterial: DiffuseColor, DustDiffuseColor, FresnelColor, Gloss), the faction's
// colour set, and the hull's booster locators. Read with lib/black.mjs.
//
// Area types are EveSOFDataArea::AreaType (trinity/Eve/SpaceObjectFactory/EveSOFData.h). A slot an area type does not
// name is the faction's Primary material for that slot, as EveSOF falls back to TYPE_PRIMARY.

import { readBlack } from "./black.mjs";

/**
 * EveSOFDataFactionColorSet's colour types by index, as an item names its colour (colorType, lightColor,
 * glowColorType): the client's own enum, trinity.EveSOFDataFactionColorSetType (read in the client's Python, build
 * 3396210).
 */
export const COLOR_TYPES = ["Primary", "Secondary", "Tertiary", "Black", "White", "Yellow", "Orange", "Red", "Blue", "Green", "Cyan", "Fire",
  "Hull", "Glass", "Reactor", "Darkhull", "Booster", "Killmark", "PrimaryLight", "SecondaryLight", "TertiaryLight", "WhiteLight",
  "PrimaryHologram", "SecondaryHologram", "TertiaryHologram", "State0", "State1", "State2", "State3", "StateVulnerable",
  "StateInvulnerable", "PrimaryForcefield", "SecondaryForcefield", "PrimaryBanner", "PrimaryFx", "SecondaryFx",
  "PrimarySpotlight", "SecondarySpotlight", "TertiarySpotlight", "PrimaryBillboard", "PrimaryWarpFx", "PrimaryAttackFX",
  "PrimarySiegeFX", "PrimaryDockedFX"];

/** EveSOFDataFactionLogoSet's logos by a logo decal's logoType (trinity.EveSOFDataLogoSetType, read in the client). */
export const LOGO_TYPES = ["Primary", "Secondary", "Tertiary", "Marking_01", "Marking_02"];

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
  // A set in a visibility group is built only where the faction's visibility group set names that group (the police
  // lights of a hull, say, for a police faction); a set in none always is.
  const groups = new Set((faction?.visibilityGroupSet?.visibilityGroups ?? []).map((g) => String(g.str ?? "").toLowerCase()));
  const visible = (set) => !set.visibilityGroup || groups.has(String(set.visibilityGroup).toLowerCase());
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
    // what the dev server checks a SOF file is current by (vite.config.ts looks for "sofBuild":11)
    sofBuild: 11,
    booster,
    areas,
    colorSet,
    boosters: (hull.booster?.items ?? []).map((b) => ({ transform: b.transform ?? null, hasTrail: b.hasTrail ?? null })),
    boundingSphere: hull.boundingSphere ?? null,
    // The hull's "anchorpoint" locator (a hangar's: where its ship floats, DefaultHangarShipBehaviour.SetAnchorPoint).
    anchor: (hull.locatorSets ?? []).find((s) => String(s.name).trim() === "anchorpoint")?.locators?.[0]?.position ?? null,
    // Its "maxCameraDistance" locator (a hangar's: hangarView.LoadCamera takes the farthest zoom from its length).
    maxCameraDistance: (hull.locatorSets ?? []).find((s) => String(s.name).trim() === "maxCameraDistance")?.locators?.[0]?.position ?? null,
    // Its sprite sets (EveSOFDataHullSpriteSet: the blinking lights), each light's colour from the faction's colour set
    // by its colorType (Primary where it names none).
    spriteSets: (hull.spriteSets ?? []).filter(visible).map((set) => ({
      name: set.name ?? null,
      items: (set.items ?? []).map((it) => ({
        position: it.position ?? [0, 0, 0], blinkRate: it.blinkRate ?? 0, blinkPhase: it.blinkPhase ?? 0,
        minScale: it.minScale ?? 1, maxScale: it.maxScale ?? it.minScale ?? 1, intensity: it.intensity ?? 1, falloff: it.falloff ?? 0,
        color: (colorSet && colorSet[COLOR_TYPES[it.colorType ?? 0]]) ?? null,
      })),
    })),
    // Its plane sets (EveSOFDataHullPlaneSet: force fields, holograms, haze cards): each plane placed, its two scrolling
    // layers and mask, its own colour and its group's colour from the faction (EveSOFDataFactionPlaneSet by groupIndex).
    planeSets: (hull.planeSets ?? []).filter(visible).map((set) => ({
      name: set.name ?? null, layer1: set.layer1MapResPath ?? null, layer2: set.layer2MapResPath ?? null, mask: set.maskMapResPath ?? null,
      items: (set.items ?? []).map((it) => ({
        position: it.position ?? [0, 0, 0], rotation: it.rotation ?? [0, 0, 0, 1], scaling: it.scaling ?? [1, 1, 1],
        color: it.color ?? null, intensity: it.intensity ?? 1,
        groupColor: (faction?.planeSets ?? []).find((g) => g.groupIndex === (it.groupIndex ?? 0))?.color ?? null,
        layer1Transform: it.layer1Transform ?? [1, 1, 0, 0], layer1Scroll: it.layer1Scroll ?? [0, 0, 0, 0],
        layer2Transform: it.layer2Transform ?? [1, 1, 0, 0], layer2Scroll: it.layer2Scroll ?? [0, 0, 0, 0],
        blinkMode: it.blinkMode ?? 0, blinkRate: it.blinkRate ?? 0, blinkPhase: it.blinkPhase ?? 0,
      })),
    })),
    // Its spotlight sets (EveSOFDataHullSpotlightSet: light cones, their glows and flares): each item's transform (a
    // column-major 4x4 in EVE's space) and intensities, its colours from the faction's spotlight set of its groupIndex.
    spotlightSets: (hull.spotlightSets ?? []).filter(visible).map((set) => ({
      name: set.name ?? null, cone: set.coneTextureResPath ?? null, glow: set.glowTextureResPath ?? null, zOffset: set.zOffset ?? 0,
      items: (set.items ?? []).map((it) => {
        const g = (faction?.spotlightSets ?? []).find((f) => f.groupIndex === (it.groupIndex ?? -1)) ?? null;
        return {
          transform: it.transform ?? null, coneIntensity: it.coneIntensity ?? 0, spriteIntensity: it.spriteIntensity ?? 0,
          flareIntensity: it.flareIntensity ?? 0, spriteScale: it.spriteScale ?? [1, 1, 1],
          coneColor: g?.coneColor ?? null, spriteColor: g?.spriteColor ?? null, flareColor: g?.flareColor ?? null,
        };
      }),
    })),
    // Its haze sets (EveSOFDataHullHazeSet: glowing volumes), each item an ellipsoid (position, rotation, scaling), its
    // colour the faction's colour of its colorType; the item defaults are the class's own (read in the client's Python:
    // hazeBrightness 1, hazeFalloff 6, sourceBrightness 2, sourceSize 0.2, saturation 1).
    hazeSets: (hull.hazeSets ?? []).filter(visible).map((set) => ({
      name: set.name ?? null, hazeType: set.hazeType ?? 0,
      items: (set.items ?? []).map((it) => ({
        position: it.position ?? [0, 0, 0], rotation: it.rotation ?? [0, 0, 0, 1], scaling: it.scaling ?? [1, 1, 1],
        color: (colorSet && colorSet[COLOR_TYPES[it.colorType ?? 0]]) ?? null, colorType: it.colorType ?? 0,
        hazeBrightness: it.hazeBrightness ?? 1, hazeFalloff: it.hazeFalloff ?? 6, sourceBrightness: it.sourceBrightness ?? 2,
        sourceSize: it.sourceSize ?? 0.2, saturation: it.saturation ?? 1, boosterGainInfluence: !!it.boosterGainInfluence,
      })),
    })),
    // Its decals (EveSOFDataHullDecalSet items): each a box (position, rotation, scaling) the hull's own triangles
    // are projected through, those triangles one index list per LOD (uint32, the hull mesh's vertex order), its
    // textures and parameters, and its usage (0 standard, 1 kill counter, 2 hole, 3 cylindrical, 4 glow cylindrical,
    // 5 glow, 6 logo). EveSOF::SetupDecalSets (_trinity_dx11.dll, decompiled): for every usage but 0 and 6 it sets
    // DecalGlowColor to the faction's colour of the item's glowColorType (0, Primary, where it names none) before the
    // item's own parameters, which are each added only where the effect has none yet - so the faction's colour wins
    // over an item's DecalGlowColor, which stands only where the faction's colour set has no such colour.
    // A logo decal (usage 6) takes its textures from the faction's logo set, by its logoType; SetupDecalSets makes
    // none where the faction has no such logo.
    decalSets: (hull.decalSets ?? []).filter(visible).map((set) => ({
      name: set.name ?? null,
      items: (set.items ?? []).filter((it) => (it.usage ?? 0) !== 6 || faction?.logoSet?.[LOGO_TYPES[it.logoType ?? 0]]).map((it) => {
        const p = params(it.parameters);
        const logo = (it.usage ?? 0) === 6 ? faction.logoSet[LOGO_TYPES[it.logoType ?? 0]] : null;
        return {
          name: it.name ?? null, usage: it.usage ?? 0, meshIndex: it.meshIndex ?? 0, logoType: it.logoType ?? null,
          position: it.position ?? [0, 0, 0], rotation: it.rotation ?? [0, 0, 0, 1], scaling: it.scaling ?? [1, 1, 1],
          textures: Object.fromEntries((logo?.textures ?? it.textures ?? []).filter((t) => t?.name && t.resFilePath).map((t) => [t.name, String(t.resFilePath).toLowerCase()])),
          parameters: p,
          glowColor: ((it.usage ?? 0) !== 0 && (it.usage ?? 0) !== 6 && colorSet && colorSet[COLOR_TYPES[it.glowColorType ?? 0]]) || p.DecalGlowColor || null,
          indexBuffers: (it.indexBuffers ?? []).map((b) => {
            const bytes = b?.indexBuffer;
            if (!bytes || !bytes.length) return [];
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return Array.from({ length: bytes.byteLength >> 2 }, (_, i) => view.getUint32(i * 4, true));
          }),
        };
      }),
    })),
    // Its point lights (EveSOFDataHullLightSet items, of the sets in no or a shown visibility group), each its colour
    // from the faction's colour set.
    lights: (hull.lightSets ?? []).filter(visible).flatMap((set) => (set.items ?? []).map((it) => ({
      position: it.position ?? [0, 0, 0], radius: it.radius ?? null, innerRadius: it.innerRadius ?? null, brightness: it.brightness ?? 1,
      color: (colorSet && colorSet[COLOR_TYPES[it.lightColor ?? 0]]) ?? null,
    }))),
  };
}
