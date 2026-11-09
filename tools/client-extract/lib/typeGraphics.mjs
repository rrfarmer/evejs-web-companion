// typeID -> how the client draws it, from CCP's Static Data Export (types.jsonl's graphicID,
// graphics.jsonl's sofHullName / sofFactionName / sofRaceName / graphicFile), with the hull's model found
// in the client's own index: a SOF hull's geometry file is named for the hull (<hull>.gr2).
//
// The SDE is CCP's public download (developers.eveonline.com); eve.js keeps the build it runs on in
// _local/sde/eve-online-static-data-<build>-jsonl. Its build should match the client's.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

async function* jsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

/**
 * { solarSystemID: { regionID, nebula, starID, sunTypeID } }: the space scene each system is drawn in. The client takes
 * the region's nebula (eveCfg.GetNebula: mapRegionCache[regionID].nebulaPath), a graphic whose file is an EveSpaceScene
 * (res:/dx9/scene/universe/<name>_cube.red) beside its cube maps <name>_cube.dds, _refl and _blur.
 */
export async function buildSystemScenes(sdeDir) {
  const graphics = new Map();
  for await (const g of jsonl(path.join(sdeDir, "graphics.jsonl"))) if (g.graphicFile) graphics.set(g._key, g.graphicFile);
  const regionNebula = new Map();
  for await (const r of jsonl(path.join(sdeDir, "mapRegions.jsonl"))) regionNebula.set(r._key, r.nebulaID ? graphics.get(r.nebulaID) ?? null : null);
  const stars = new Map();
  for await (const s of jsonl(path.join(sdeDir, "mapStars.jsonl"))) stars.set(s._key, s.typeID ?? null);
  const out = {};
  for await (const s of jsonl(path.join(sdeDir, "mapSolarSystems.jsonl"))) {
    out[s._key] = { name: s.name?.en ?? null, security: s.securityStatus ?? null, regionID: s.regionID, nebula: regionNebula.get(s.regionID) ?? null, starID: s.starID ?? null, sunTypeID: s.starID ? stars.get(s.starID) ?? null : null };
  }
  return out;
}

/**
 * { types: { typeID: [name, groupID, raceID] }, groups: { groupID: [name, categoryID] } }: English names, for the
 * overview; the race for what the client picks by it (hangarRegistry.GetHangarType: evetypes.GetRaceID).
 */
export async function buildTypeNames(sdeDir) {
  const types = {}, groups = {};
  for await (const t of jsonl(path.join(sdeDir, "types.jsonl"))) types[t._key] = [t.name?.en ?? null, t.groupID ?? null, t.raceID ?? null];
  for await (const g of jsonl(path.join(sdeDir, "groups.jsonl"))) groups[g._key] = [g.name?.en ?? null, g.categoryID ?? null];
  return { types, groups };
}

/** { typeID: { graphicID, hull, faction, race, gr2, graphicFile, groupID } } for every type with a graphic. */
export async function buildTypeGraphics(sdeDir, rf) {
  const graphics = new Map();
  for await (const g of jsonl(path.join(sdeDir, "graphics.jsonl"))) graphics.set(g._key, g);
  // hull name -> its geometry, from the client's index (a hull's .gr2 is named for it)
  const gr2ByName = new Map();
  for (const [key] of rf.entries) {
    const m = /^res:\/dx9\/model\/(?:.*\/)?([^/]+)\.gr2$/.exec(key);
    if (m && !gr2ByName.has(m[1])) gr2ByName.set(m[1], key);
  }
  const out = {};
  for await (const t of jsonl(path.join(sdeDir, "types.jsonl"))) {
    if (!t.graphicID) continue;
    const g = graphics.get(t.graphicID);
    if (!g) continue;
    const hull = g.sofHullName ?? null;
    out[t._key] = {
      graphicID: t.graphicID,
      groupID: t.groupID ?? null,
      hull,
      faction: g.sofFactionName ?? null,
      race: g.sofRaceName ?? null,
      gr2: hull ? gr2ByName.get(hull.toLowerCase()) ?? null : null,
      graphicFile: g.graphicFile ?? null,
    };
  }
  return out;
}

/**
 * A system's planets and moons as the client draws them (planet.py LoadPlanet / SetEffectParameters): each from its
 * shader preset's object file (planetAttributes.shaderPreset, a graphic), with the planet's own height maps
 * (heightMap1 and heightMap2, graphics too) given to its effects as NormalHeight1 and NormalHeight2. The client reads
 * the attributes from cfg.mapSolarSystemContentCache; the SDE's mapPlanets and mapMoons carry the same.
 * [{ itemID, typeID, kind, preset, heightMap1, heightMap2 }], the graphics as their files (null where none).
 */
export async function findSystemCelestials(sdeDir, solarSystemID) {
  const graphics = new Map();
  for await (const g of jsonl(path.join(sdeDir, "graphics.jsonl"))) if (g.graphicFile) graphics.set(g._key, g.graphicFile);
  const inSystem = new RegExp(`"solarSystemID": ?${Number(solarSystemID)}[,}]`);
  const out = [];
  for (const [file, kind] of [["mapPlanets.jsonl", "planet"], ["mapMoons.jsonl", "moon"]]) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(sdeDir, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!inSystem.test(line)) continue;
      const row = JSON.parse(line);
      const a = row.attributes ?? {};
      const g = (id) => (id ? graphics.get(id) ?? null : null);
      out.push({ itemID: row._key, typeID: row.typeID ?? null, kind, preset: g(a.shaderPreset), heightMap1: g(a.heightMap1), heightMap2: g(a.heightMap2) });
    }
  }
  return out;
}
