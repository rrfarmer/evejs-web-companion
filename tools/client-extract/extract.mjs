#!/usr/bin/env node
// Extract models and textures from YOUR installed EVE client for the three.js play page.
//
//   node tools/client-extract/extract.mjs [--client "<EVE folder>"] [--out <dir>]
//        [--sde <SDE jsonl folder>] [--type-graphics] [--hull <res path or stem> ...] [--type <typeID> ...]
//        [--scene <res path of an EveSpaceScene> ...] [--celestial <res path of a planet/sun object> ...]
//        [--system-celestials <solarSystemID> ...] [--overview] [--graphic <graphicID> ...]
//        [--turret <res path of a turret module's graphic> ...] [--gfx-turrets] [--ammo-colors] [--sof-materials] [--missile <missile typeID> ...]
//        [--ship-info] (the Ship Info scene, faction backgrounds and light rig, needs --sde)
//        [--observatory-environment] (the anchor template and its postprocessing textures)
//        [--observatory-vortex] (the vault volume and its authored lighting inputs)
//
// Nothing here ships client data: the script reads the client on this machine and writes to
// _local/client-assets/<build>/ (git-ignored). Output mirrors res: paths, lower case:
//   <hull>.glb          every LOD of the model, mirrored into glTF's right-handed space
//   <hull>_<x>.dds      the hull's textures, copied unchanged (block-compressed, uploaded as is)
//   <hull>.json         what was extracted from where: LODs, areas, textures, vertex components
//   <hull>.<faction>.sof.json  (--type) the hull as the SOF builds it for the type's faction: areas, shaders,
//                       textures (copied), faction materials, colour set, boosters
//   typeGraphics.json   (--type-graphics, needs --sde) typeID -> hull, faction, race, model
//   systemScenes.json   (--type-graphics too) solarSystemID -> region nebula, star
//   typeNames.json      (--type-graphics too) typeID -> [name, groupID, raceID]; groupID -> [name, categoryID]
//   graphics/<id>.json  (--graphic) a graphic that is no type's: a SOF hull (a station hangar's model, extracted as
//                       --type extracts one, its .sof.json with its anchor point and point lights) or a hangar's
//                       EveSpaceScene (its environment cube maps copied, its sun and ambient)
//   brackets.json       (--type-graphics too) the client's bracket tables, from its own .static files
//   config.json         the client and SDE folders used, so the dev server can extract on demand
// and manifest.json at the build root.

import fs from "node:fs";
import path from "node:path";
import { openResFiles, clientBuild, findClient } from "./lib/resfiles.mjs";
import { childEffectRoots, hullOverlays, readEffectFile, readHullChildren, readHullControllers, readSpriteInstances, readTrafficInstances, readTurretStretch3, usedLocatorSets } from "./lib/children.mjs";
import { readGranny } from "./lib/granny.mjs";
import { readAnimations } from "./lib/grannyAnim.mjs";
import { meshArrays } from "./lib/mesh.mjs";
import { writeGlb, glbBuildOf, GLB_BUILD } from "./lib/glb.mjs";
import { buildTypeGraphics, buildSystemScenes, buildTypeNames, findSystemCelestials, buildGfxTurrets, indexedHullGeometry, CELESTIAL_BUILD } from "./lib/typeGraphics.mjs";
import { readFsdStatic } from "./lib/fsdStatic.mjs";
import { buildGraphicSofDefaults, loadGraphicMaterialSets, graphicsFile, mapSdeDir } from "./lib/assetSde.mjs";
import { SOF_BUILD, GRAPHIC_SOF_DEFAULTS, sofVariant, loadSof, buildHull, allMaterials } from "./lib/sof.mjs";
import { readCelestial } from "./lib/celestial.mjs";
import { readTurret, ammoColors, TURRET_BUILD } from "./lib/turret.mjs";
import { spawnSync } from "node:child_process";
import { readMissileModel, groupGraphics, graphicIdsOfType, sdeGraphic } from "./lib/missile.mjs";
import { readBlack } from "./lib/black.mjs";
import { readDefaultOverviews, DEFAULT_TAB_NAMES } from "./lib/defaultOverviews.mjs";
import { createRequire } from "node:module";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
export const REPO = path.resolve(HERE, "..", "..");

// Texture suffixes of a ship hull's own texture set (beside its .gr2)
const TEXTURE_ROLES = { a: "albedo", ar: "albedoRoughness", d: "dirt", g: "glow", m: "materialMask", n: "normal", o: "occlusion", p3: "paintMask", pmdg: "paintMaskDirtGlow", r: "roughness" };

export function resolveClient(given) {
  let client = given ?? process.env.EVE_CLIENT_DIR;
  if (!client) {
    const found = findClient();
    if (found.length !== 1) throw new Error(found.length ? `several EVE installs found, pick one with --client: ${found.join(" | ")}` : "no EVE install found, give --client");
    client = found[0];
  }
  return client;
}

export function hullPath(rf, spec) {
  if (spec.startsWith("res:/")) return spec.toLowerCase();
  const hits = rf.list("res:/dx9/model/", new RegExp(`/${spec.toLowerCase()}\\.gr2$`));
  if (hits.length !== 1) throw new Error(`--hull ${spec}: ${hits.length} matches (${hits.slice(0, 5).join(", ")})`);
  return hits[0].toLowerCase();
}

/**
 * Copy the scene's authored cube maps under the stable names used by the asset route.
 * Wormhole scene files reference a separate *_cube resource stem.
 */
export function extractScene(rf, scenePath, outRoot) {
  const stem = scenePath.toLowerCase().replace(/\.(red|black)$/, "");
  const black = stem + ".black";
  let scene = null;
  if (rf.has(black)) {
    try { scene = readBlack(rf.read(black), black); }
    catch { /* Existing scene assets also follow the filename convention. */ }
  }
  const maps = {
    nebula: scene?.backgroundEffect?.resources?.find(({ name }) => name === "NebulaMap")?.resourcePath,
    reflection: scene?.envMap1ResPath,
    blur: scene?.envMap2ResPath,
  };
  const out = {};
  for (const [role, suffix] of [["nebula", ""], ["reflection", "_refl"], ["blur", "_blur"]]) {
    const res = `${stem}${suffix}.dds`;
    const authored = maps[role]?.toLowerCase();
    const source = authored && rf.has(authored) ? authored : res;
    if (!rf.has(source)) continue;
    const file = path.join(outRoot, ...res.slice("res:/".length).split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, rf.read(source));
    out[role] = "/client-assets/" + res.slice("res:/".length);
  }
  return out;
}

/**
 * The client's bracket tables (bracketMgr.CreateBracketIndexes): bracket by type, else by group, else by category
 * (GetBracketDataByTypeID), and each bracket's icon. Read from the client's own res:/staticdata/*.static.
 */
export function extractBrackets(rf, outRoot) {
  const read = (name) => readFsdStatic(rf.read(`res:/staticdata/${name}.static`), `res:/staticdata/${name}.static`);
  const brackets = read("brackets");
  const out = {
    byType: read("bracketsbytype"),
    byGroup: read("bracketsbygroup"),
    byCategory: read("bracketsbycategory"),
    brackets: Object.fromEntries(Object.entries(brackets).map(([id, b]) => [id, { name: b.name ?? null, texturePath: b.texturePath ?? null, texturePathEmpty: b.texturePathEmpty ?? null }])),
  };
  fs.writeFileSync(path.join(outRoot, "brackets.json"), JSON.stringify(out));
  return out;
}

/** Where a res: file is copied to, and the URL the dev server serves it at. */
function copyRes(rf, res, outRoot) {
  const rel = res.toLowerCase().slice("res:/".length);
  const file = path.join(outRoot, ...rel.split("/"));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rf.read(res));
  }
  return `/client-assets/${rel}`;
}

/**
 * A child graph's assets (children.mjs nodes, rewritten in place to URLs): a traffic mesh's instances read, its textures
 * copied; a mesh's or particle system's geometry extracted (as a hull's, once), its areas' textures copied; a line set's
 * textures copied; a behaviour system's group meshes as a mesh's. Whether any node has GPU emitters (the scene's GPU particle system's atlas is then wanted).
 */
async function copyChildGraphAssets(rf, roots, outRoot) {
  const trafficNodes = [], meshNodes = [];
  let gpu = false;
  const walkChildren = (n) => {
    if (!n) return;
    for (const light of n.lights ?? []) {
      if (light.profile) light.profile = rf.has(light.profile) ? copyRes(rf, light.profile, outRoot) : null;
    }
    if (n.k === "gpuParticles") gpu = true;
    if (n.k === "traffic") trafficNodes.push(n);
    if (n.k === "mesh" || n.k === "particles") meshNodes.push(n);
    if (n.k === "smartLights") meshNodes.push(...n.meshes);
    if (n.k === "lines") for (const [name, res] of Object.entries(n.textures)) n.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    for (const o of n.objects ?? []) walkChildren(o);
    if (n.k === "propagator") walkChildren(n.source);
    // a behaviour system's groups: each drawn as its mesh
    if (n.k === "agents") for (const g of n.groups ?? []) {
      walkChildren(g.mesh);
      // a PlayFX's stretch (its children's assets)
      for (const b of g.behaviors ?? []) if (b.stretch?.root) walkChildren(b.stretch.root);
      if (g.booster) for (const [name, res] of Object.entries(g.booster.textures)) g.booster.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  };
  for (const r of roots) walkChildren(r);
  for (const n of trafficNodes) {
    n.instances = rf.has(n.instances) ? await readTrafficInstances(rf, n.instances) : null;
    for (const [name, res] of Object.entries(n.textures)) n.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  }
  for (const n of meshNodes) {
    if (n.instanceSource) {
      const decal = n.areas.some((area) => area.effect === "1layerdecalv2");
      n.staticInstances = rf.has(n.instanceSource)
        ? await readSpriteInstances(rf, n.instanceSource, n.instanceMeshIndex, decal).catch((e) => {
          console.warn(`child sprite instances ${n.instanceSource}: ${e.message}`);
          return [];
        })
        : [];
      if (decal) n.staticInstanceStride = 14;
      delete n.instanceSource;
      delete n.instanceMeshIndex;
    }
    const res = n.geometry;
    const glb = path.join(outRoot, ...`${res.slice("res:/".length, -".gr2".length)}.glb`.split("/"));
    if (!rf.has(res)) n.geometry = null;
    else {
      if (!fs.existsSync(glb)) await extractHull(rf, res, outRoot).catch((e) => console.warn(`child mesh ${res}: ${e.message}`));
      n.geometry = fs.existsSync(glb) ? `/client-assets/${res.slice("res:/".length, -".gr2".length)}.glb` : null;
    }
    for (const a of n.areas) for (const [name, t] of Object.entries(a.textures)) a.textures[name] = rf.has(t) ? copyRes(rf, t, outRoot) : null;
  }
  return gpu;
}

/**
 * A hull as the Space Object Factory builds it for a faction (lib/sof.mjs), written beside the model as
 * <hull stem>.<faction>.sof.json, every texture it names copied (a station's come from shared texture sets).
 */
export async function extractSof(rf, gr2, hullName, factionName, outRoot, raceName = null, recipe = null) {
  const { materialSet, typeID } = recipe ?? {};
  const built = buildHull(loadSof(rf), hullName, factionName, raceName, materialSet);
  if (!built) return null;
  // the hull's children as EveSOF builds them for the faction (lib/children.mjs): their drawn graph
  const sof = loadSof(rf);
  built.children = readHullChildren(rf, sof.hulls.get(String(hullName).toLowerCase()), factionName ? sof.factions.get(String(factionName).toLowerCase()) ?? null : null);
  // the object files its controllers load as child effects (each read once, by path)
  built.childEffects = childEffectRoots();
  // the hull's own controllers (their owner the whole model)
  built.hullControllers = readHullControllers(rf, sof.hulls.get(String(hullName).toLowerCase()), factionName ? sof.factions.get(String(factionName).toLowerCase()) ?? null : null);
  // the overlays those controllers add (Tr2ActionOverlay: construction, teardown, cloaks), their textures copied
  built.overlays = hullOverlays(rf);
  for (const ov of Object.values(built.overlays)) {
    for (const fx of ov ? [...ov.opaque, ...ov.transparent, ...ov.additive, ...ov.decal, ...ov.distortion] : []) {
      for (const [name, res] of Object.entries(fx.textures)) fx.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  }
  // the hull's locator sets its children's effect propagators name: each locator [x, y, z, qx, qy, qz, qw]
  const locatorHull = sof.hulls.get(String(hullName).toLowerCase());
  // (and its hangar_drones: the hangar VFX's drone propagators, added to the ship, take them - entry 212)
  const beamLocator = locatorHull?.locatorSets?.some((set) => set.name === "beam_source") ? ["beam_source"] : [];
  built.locatorSets = Object.fromEntries([...new Set([...usedLocatorSets(), "hangar_drones", "camera_look_at", ...beamLocator])].map((name) => [name, ((locatorHull?.locatorSets ?? []).find((s) => String(s.name ?? "").trim() === name)?.locators ?? [])
    .map((l) => [...(l.position ?? [0, 0, 0]), ...(l.rotation ?? [0, 0, 0, 1])])]));
  // the hull's impact effects as EveSOF::SetupImpactEffects (EveSOF.cpp:2652-2785) sets them up where its
  // impactEffectType is not nought (1 an ellipsoid shield, 2 none drawn): its "damage" locators [x, y, z, qx, qy, qz, qw],
  // its shape ellipsoid, and the generic armor debris and hull smoke GPU emitters (generic.damage, generic.hullDamage;
  // the emitters' other fields nought, as the SOF's memset; absent fields the SOF data's class defaults)
  const impactType = Number(locatorHull?.impactEffectType ?? 0);
  if (impactType) {
    const dmg = sof.data.generic?.damage ?? null, hd = sof.data.generic?.hullDamage ?? null;
    const pair = (v) => (Array.isArray(v) ? [Number(v[0] ?? 0), Number(v[1] ?? 0)] : [0, 0]);
    const vec4 = (v) => (Array.isArray(v) ? [0, 1, 2, 3].map((i) => Number(v[i] ?? 0)) : [0, 0, 0, 0]);
    const emitter = (src, p, defaults) => {
      if (!src) return null;
      const get = (k) => src[`${p}${k}`] ?? defaults[k];
      const speed = pair(get("MinMaxSpeed")), life = pair(get("MinMaxLifeTime")), sizes = vec4(get("Sizes"));
      return {
        type: "Tr2GpuUniqueEmitter", continuousEmitter: false, rate: get("Rate"), angle: get("Angle"), innerAngle: get("InnerAngle"),
        radius: 0, minSpeed: speed[0], maxSpeed: speed[1], minLifeTime: life[0], maxLifeTime: life[1],
        sizes: sizes.slice(0, 3), sizeVariance: sizes[3], color0: vec4(get("Color0")), color1: vec4(get("Color1")),
        color2: vec4(get("Color2")), color3: vec4(get("Color3")), textureIndex: get("TextureIndex"),
        velocityStretchRotation: get("VelocityStretchRotation"), drag: get("Drag"), turbulenceAmplitude: get("TurbulenceAmplitude"),
        turbulenceFrequency: get("TurbulenceFrequency"), colorMidpoint: get("ColorMidpoint"), gravity: 0, attractorStrength: 0,
      };
    };
    const zero = { Rate: 0, Angle: 0, InnerAngle: 0, TextureIndex: 0, VelocityStretchRotation: 0, Drag: 0, TurbulenceAmplitude: 0, TurbulenceFrequency: 1, ColorMidpoint: 0.5 };
    built.impact = {
      type: impactType,
      ellipsoid: { center: locatorHull?.shapeEllipsoidCenter ?? null, radius: locatorHull?.shapeEllipsoidRadius ?? null },
      damageLocators: ((locatorHull?.locatorSets ?? []).find((s) => String(s.name ?? "").trim() === "damage")?.locators ?? [])
        .map((l) => [...(l.position ?? [0, 0, 0]), ...(l.rotation ?? [0, 0, 0, 1])]),
      // (the armor colour midpoint is armorParticleColorMidPoint, absent from the data: its default)
      armorEmitter: emitter(dmg ? { ...dmg, armorParticleColorMidpoint: dmg.armorParticleColorMidPoint } : null, "armorParticle", zero),
      hullEmitter: emitter(hd, "hullParticle", zero),
      flicker: dmg ? { speed: dmg.flickerPerlinSpeed ?? 1, alpha: dmg.flickerPerlinAlpha ?? 1.1, beta: dmg.flickerPerlinBeta ?? 2, n: dmg.flickerPerlinN ?? 3 } : null,
      // the shield's effect (fxshieldimpactv5 on the ellipsoid; type 1 only): the hull's race's shieldImpactParameters and
      // shieldImpactTextures (EveSOF.cpp:2673-2716), the textures copied
      shield: null,
    };
    const raceDamage = raceName ? sof.races.get(String(raceName).toLowerCase())?.damage ?? null : null;
    // the holes' effect (fxarmorimpactv5, a re-draw of the hull: EveSOF::CreateArmorDamageEffect, :2601-2625): the race's
    // armorImpactParameters and armorImpactTextures, the textures copied
    if (raceDamage) {
      built.impact.armor = {
        params: Object.fromEntries((raceDamage.armorImpactParameters ?? []).filter((p) => p?.name).map((p) => [p.name, p.value ?? null])),
        textures: Object.fromEntries((raceDamage.armorImpactTextures ?? []).filter((t) => t?.name && t.resFilePath)
          .map((t) => [t.name, rf.has(String(t.resFilePath).toLowerCase()) ? copyRes(rf, String(t.resFilePath).toLowerCase(), outRoot) : null])),
      };
    }
    if (impactType === 1 && raceDamage) {
      built.impact.shield = {
        params: Object.fromEntries((raceDamage.shieldImpactParameters ?? []).filter((p) => p?.name).map((p) => [p.name, p.value ?? null])),
        textures: Object.fromEntries((raceDamage.shieldImpactTextures ?? []).filter((t) => t?.name && t.resFilePath)
          .map((t) => [t.name, rf.has(String(t.resFilePath).toLowerCase()) ? copyRes(rf, String(t.resFilePath).toLowerCase(), outRoot) : null])),
      };
    }
  }
  const gpu = await copyChildGraphAssets(rf, [...built.children.map((c) => c.root), ...Object.values(built.childEffects)], outRoot);
  // the scene GPU particle system's atlas and turbulence volume (res:/fisfx/gpuparticles/system.black's), where a child
  // has GPU emitters or the hull has impact debris
  if (gpu || built.impact) built.gpuParticles = Object.fromEntries([["atlas", "res:/fisfx/gpuparticles/systematlas.dds"], ["noise", "res:/texture/global/noise32cube_volume.dds"]]
    .map(([k, res]) => [k, rf.has(res) ? copyRes(rf, res, outRoot) : null]));
  for (const area of built.areas) {
    for (const [name, res] of Object.entries(area.textures)) {
      area.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  }
  for (const layer of built.pattern?.layers ?? []) layer.texture = rf.has(layer.texture) ? copyRes(rf, layer.texture, outRoot) : null;
  // the flame's textures (boostervolumetric.fx: the shape atlas, the two gradients, the noise volume)
  const vol = built.booster?.volumetric;
  if (vol) for (const key of ["shapeMap", "gradient0", "gradient1", "noise", "glowMap", "glowNoise"]) vol[key] = vol[key] && rf.has(vol[key]) ? copyRes(rf, vol[key], outRoot) : null;
  for (const set of built.spotlightSets ?? []) {
    for (const key of ["cone", "glow"]) {
      const res = set[key] ? String(set[key]).toLowerCase() : null;
      set[key] = res && rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  }
  for (const set of built.decalSets ?? []) {
    for (const item of set.items) {
      for (const [name, res] of Object.entries(item.textures)) item.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  }
  for (const set of built.planeSets ?? []) {
    for (const key of ["layer1", "layer2", "mask"]) {
      const res = set[key] ? String(set[key]).toLowerCase() : null;
      set[key] = res && rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
  }
  const stem = gr2.toLowerCase().slice("res:/".length, -".gr2".length);
  const variant = sofVariant(factionName, materialSet?._key, typeID);
  const file = path.join(outRoot, ...`${stem}.${variant}.sof.json`.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(built));
  return file;
}

/**
 * A missile type's graphics (lib/missile.mjs): its model from the type's group graphic (groupGraphics), its impact from
 * the type's own graphicFile; the warhead's textures copied, and the scene GPU particle system's atlas and turbulence
 * volume (the trail's emitters draw into it). Written as missiles/<typeID>.json.
 */
export async function extractMissile(rf, clientDir, sdeDir, typeID, outRoot) {
  const names = JSON.parse(fs.readFileSync(path.join(outRoot, "typeNames.json"), "utf8"));
  const tg = JSON.parse(fs.readFileSync(path.join(outRoot, "typeGraphics.json"), "utf8"))[String(typeID)] ?? null;
  const groupID = names.types?.[String(typeID)]?.[1] ?? tg?.groupID ?? null;
  const ids = groupID === null ? null : graphicIdsOfType(groupGraphics(rf, clientDir, outRoot, REPO), typeID, groupID);
  const missileFile = ids?.length ? sdeGraphic(sdeDir, ids[0])?.graphicFile ?? null : null;
  const model = missileFile ? readMissileModel(rf, missileFile) : null;
  const copy = (res) => (res && rf.has(res) ? copyRes(rf, res, outRoot) : null);
  for (const w of model?.warheads ?? []) {
    for (const k of Object.keys(w.spriteTextures)) w.spriteTextures[k] = copy(w.spriteTextures[k]);
    if (w.mesh) for (const k of Object.keys(w.mesh.textures)) w.mesh.textures[k] = copy(w.mesh.textures[k]);
  }
  // the impact (ExplosionManager's explosion: an EveEffectRoot2 read as a hull child's graph, its assets copied)
  const impact = tg?.graphicFile ? readEffectFile(rf, tg.graphicFile) : null;
  if (impact) await copyChildGraphAssets(rf, [impact.root, ...Object.values(impact.childEffects)], outRoot);
  const out = {
    missileBuild: 2, typeID, groupID, graphicID: ids?.[0] ?? null, missileFile, impactFile: tg?.graphicFile ?? null, model, impact,
    gpuParticles: { atlas: copy("res:/fisfx/gpuparticles/systematlas.dds"), noise: copy("res:/texture/global/noise32cube_volume.dds") },
  };
  const file = path.join(outRoot, "missiles", `${typeID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return file;
}

/**
 * A planet, moon or sun's object file read for its textures and shader parameters (lib/celestial.mjs), the
 * textures copied, written as <graphic file>.celestial.json.
 */
export function extractCelestial(rf, graphicFile, outRoot) {
  const c = readCelestial(rf, graphicFile);
  for (const [name, res] of Object.entries(c.textures)) c.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  for (const ring of c.rings ?? []) for (const [name, res] of Object.entries(ring.textures)) ring.textures[name] = rf.has(res.toLowerCase()) ? copyRes(rf, res.toLowerCase(), outRoot) : null;
  const rel = graphicFile.toLowerCase().slice("res:/".length).replace(/.(red|black)$/, "") + ".celestial.json";
  const file = path.join(outRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 1));
  return file;
}

/** Read just the requested rows with the installed client's cFSD loader. */
function readClientTable(rf, clientDir, name, keys) {
  const entry = rf.entry(`res:/staticdata/${name}.fsdbinary`);
  if (!entry) throw new Error(`The client has no res:/staticdata/${name}.fsdbinary`);
  const data = path.join(clientDir, "ResFiles", ...entry.blob.split("/"));
  const args = [path.join(REPO, "scripts", "client-built-data.py"), path.join(clientDir, "tq", "bin64"), name + "Loader", data];
  if (keys) args.push(`keys=${keys.join(",")}`);
  const py = spawnSync(process.env.PYTHON ?? "python", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (py.status !== 0) throw new Error(`${name}: client-built-data.py failed: ${py.stderr || py.error?.message}`);
  return py.stdout;
}

/** The client's effects table, cached by effect GUID. */
function effectsTable(rf, clientDir, outRoot) {
  const file = path.join(outRoot, "effects.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const json = readClientTable(rf, clientDir, "effects");
  fs.writeFileSync(file, json);
  return JSON.parse(json);
}

/**
 * A graphic that is an effect file (an EveMultiEffect - the hangar's VFX, graphic 28022 - or an EveEffectRoot2), read
 * whole (children.mjs readEffectFile: its root's controllers and curve sets, the child effects they load), its assets
 * copied, written as effects/<graphicID>.json.
 */
async function extractEffectGraphic(rf, sde, graphicID, outRoot) {
  const graphic = sdeGraphic(sde, Number(graphicID));
  const graphicFile = String(graphic?.graphicFile ?? "").replace(/\\/g, "/").toLowerCase() || null;
  const bindExternalTextures = [3715, 21050].includes(Number(graphicID));
  const allShaderQualities = bindExternalTextures || [20956, 28102].includes(Number(graphicID));
  const read = graphicFile ? readEffectFile(rf, graphicFile, undefined, { allShaderQualities, bindExternalTextures }) : null;
  if (read?.root) await copyChildGraphAssets(rf, [read.root, ...Object.values(read.childEffects ?? {})], outRoot);
  const out = {
    effectBuild: bindExternalTextures ? 7 : allShaderQualities ? 6 : 4,
    graphicID: Number(graphicID), graphicFile,
    root: read?.root ?? null, external: read?.external ?? [], childEffects: read?.childEffects ?? {}, skipped: read?.skipped ?? {},
    ...(allShaderQualities ? { controllerVariableOverrides: graphic?.controllerVariableOverrides ?? {} } : {}),
  };
  const file = path.join(outRoot, "effects", `${graphicID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return file;
}

/** A wormhole's remote side reads the destination scene's three authored nebula textures. */
function extractWormholeNebula(rf, sde, graphicID, outRoot) {
  const resource = sdeGraphic(sde, graphicID)?.graphicFile?.toLowerCase().replace(/\.red$/, ".black");
  const scene = resource && rf.has(resource) ? readBlack(rf.read(resource), resource) : null;
  if (scene?.type !== "EveSpaceScene") throw new Error(`--wormhole-nebula ${graphicID}: no destination scene`);
  const slots = {
    destinationReflectionCube: scene.envMap1ResPath,
    LQ_NebulaClass: scene.lowQualityNebulaResPath,
    LQ_NebulaMix1: scene.lowQualityNebulaMixResPath,
    LQ_NebulaMix2: scene.lowQualityNebulaMixResPath,
  };
  const textures = Object.fromEntries(Object.entries(slots)
    .filter(([, res]) => res && rf.has(res))
    .map(([name, res]) => [name, copyRes(rf, res, outRoot)]));
  const file = path.join(outRoot, "wormholeNebula", `${graphicID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(textures));
  return file;
}

async function extractWormholeTransit(rf, outRoot) {
  const resource = "res:/fisfx/jump/wormholes/transition.black";
  const effect = readEffectFile(rf, resource);
  if (!effect?.root) throw new Error(`Cannot read ${resource}`);
  await copyChildGraphAssets(rf, [effect.root], outRoot);
  fs.writeFileSync(path.join(outRoot, "wormholeTransit.json"), JSON.stringify({ root: effect.root, skipped: effect.skipped }));
}

async function extractWarpTunnel(rf, outRoot) {
  const resource = "res:/model/effect3/warptunnel.black";
  const tunnel = readBlack(rf.read(resource), resource);
  const geometry = tunnel.mesh.geometryResPath.toLowerCase();
  const { glb } = await extractHull(rf, geometry, outRoot);
  const curve = tunnel.curveSets.find((set) => set.name === "SpeedModifier").curves[0];
  const pass = (area) => ({
    parameters: Object.fromEntries(area.effect.parameters.map(({ name, value }) => [name, value])),
    textures: Object.fromEntries(area.effect.resources.map(({ name, resourcePath }) => [name, copyRes(rf, resourcePath, outRoot)])),
  });
  fs.writeFileSync(path.join(outRoot, "warpTunnel.json"), JSON.stringify({
    model: "/client-assets/" + path.relative(outRoot, glb).split(path.sep).join("/"),
    scale: tunnel.scaling,
    rotation: tunnel.rotation,
    intensity: { ...curve, keys: curve.keys.items },
    transparent: pass(tunnel.mesh.transparentAreas[0]),
    additive: pass(tunnel.mesh.additiveAreas[0]),
  }));
}

/**
 * An effect guid's own graphic (the effects table's graphicID, the SDE's graphicFile for it), written as fx/<guid>.json:
 * the effect's class, duration and damage timings, and - where the graphic is EveStretch3s (the Vorton projectors'
 * chain) - the stretches read as a turret's are (children.mjs readTurretStretch3), their assets copied.
 */
async function extractFxGraphic(rf, clientDir, sde, guid, outRoot) {
  const fx = effectsTable(rf, clientDir, outRoot)[guid] ?? null;
  const graphicFile = fx?.graphicID ? sdeGraphic(sde, fx.graphicID)?.graphicFile ?? null : null;
  const read = graphicFile ? readTurretStretch3(rf, graphicFile) : null;
  const stretches = (read?.stretches ?? []).filter(Boolean);
  if (stretches.length) await copyChildGraphAssets(rf, [...stretches.map((s) => s.root), ...Object.values(read.childEffects ?? {})], outRoot);
  // a ShipEffect's graphic (GenericEffect.py ShipEffect: an EveTransform, an EveChildContainer or an effect root) read
  // whole, with the table's transformFlags (effectConsts FX_TF_*) and timeScale
  const ship = fx?.type === "ShipEffect" && graphicFile ? readEffectFile(rf, graphicFile) : null;
  if (ship?.root) await copyChildGraphAssets(rf, [ship.root, ...Object.values(ship.childEffects ?? {})], outRoot);
  const out = {
    fxBuild: 4, guid, type: fx?.type ?? null, graphicID: fx?.graphicID ?? null, graphicFile, duration: fx?.duration ?? null,
    sourceDamage: fx?.sourceDamage ?? null, targetDamage: fx?.targetDamage ?? null,
    stretches: stretches.map((s) => ({ type: "EveStretch3", ...s })),
    shipEffect: ship?.root ? { root: ship.root, childEffects: ship.childEffects ?? {}, skipped: ship.skipped ?? {}, transformFlags: fx.transformFlags ?? [], timeScale: !!fx.timeScale, firstSet: ship.firstSet ?? null } : null,
  };
  const file = path.join(outRoot, "fx", `${guid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return file;
}

/**
 * A turret module's graphic read for its shots' impacts (lib/turret.mjs), written as <graphic stem>.turret.json (a
 * graphic that is no turret set: {turret: null}).
 */
export async function extractTurret(rf, graphicFile, outRoot) {
  const t = readTurret(rf, graphicFile) ?? { turretBuild: TURRET_BUILD, graphicFile, turret: null };
  // its model extracted as a hull's (once) and its textures copied
  if (t.geometry) {
    const stem = t.geometry.slice("res:/".length, -".gr2".length);
    const glb = path.join(outRoot, ...`${stem}.glb`.split("/"));
    if (rf.has(t.geometry) && !fs.existsSync(glb)) await extractHull(rf, t.geometry, outRoot).catch((e) => console.warn(`turret model ${t.geometry}: ${e.message}`));
    t.model = fs.existsSync(glb) ? `/client-assets/${stem}.glb` : null;
    // its skeleton (the aiming's system bones, the firing bones): each bone's name, parent, local transform and
    // inverse bind (EVE's space, row-major), and the first LOD's vertices' bones (a turret's vertices are bound rigidly:
    // BoneIndices with no weights, the first index into the mesh's bone bindings)
    if (rf.has(t.geometry)) {
      const g = await readGranny(rf.read(t.geometry), t.geometry);
      const bones = g.root.Skeletons?.[0]?.Bones ?? [];
      const byName = new Map(bones.map((b, i) => [b.Name, i]));
      const mesh = g.root.Meshes?.[0];
      const col = mesh?.PrimaryVertexData?.Vertices?.columns?.BoneIndices ?? null;
      const binding = (mesh?.BoneBindings ?? []).map((b) => byName.get(b.BoneName) ?? 0);
      t.skeleton = {
        bones: bones.map((b) => ({
          name: b.Name, parent: b.ParentIndex, position: b.Transform?.position ?? [0, 0, 0], orientation: b.Transform?.orientation ?? [0, 0, 0, 1],
          scaleShear: b.Transform?.scaleShear ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], inverseWorld: b.InverseWorldTransform ?? null,
        })),
        vertexBones: col ? Array.from({ length: mesh.PrimaryVertexData.Vertices.count }, (_, i) => binding[col.data[i * col.width]] ?? 0) : null,
        // its animations (Deploy, Active, Fire, Pack, Inactive, Reload...): per bone, position / orientation / scale-shear
        // controls and knots (lib/grannyAnim.mjs)
        animations: readAnimations(g.root).animations,
      };
    }
  }
  for (const [k, res] of Object.entries(t.textures ?? {})) t.textures[k] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  // its firing effect's EveStretch3s' assets (their parts are hull-child graphs)
  const s3 = (t.firing?.stretches ?? []).filter((s) => (s.type === "EveStretch3" || s.type === "EveStretch") && s.root);
  if (s3.length) await copyChildGraphAssets(rf, [...s3.map((s) => s.root), ...s3.flatMap((s) => Object.values(s.childEffects ?? {}))], outRoot);
  // its firing effect's stretches' textures
  for (const s of t.firing?.stretches ?? []) for (const [k, res] of Object.entries(s.textures ?? {})) s.textures[k] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  const rel = graphicFile.toLowerCase().slice("res:/".length).replace(/.(red|black)$/, "") + ".turret.json";
  const file = path.join(outRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(t, null, 1));
  return file;
}

/**
 * A system's planets and moons, each as the client builds it (lib/typeGraphics.mjs findSystemCelestials): its preset's
 * object file extracted (extractCelestial) and its height maps copied, written as celestials/<solarSystemID>.json:
 * { solarSystemID, items: { itemID: { typeID, kind, population, celestial, NormalHeight1, NormalHeight2, geometry } } }.
 * The asset paths are URLs or null. The preset's sphere mesh is extracted as a .glb once.
 */
export async function extractSystemCelestials(rf, sdeDir, solarSystemID, outRoot) {
  const items = {};
  const done = new Map();
  const meshes = new Map();
  const meshOf = async (res) => {
    if (!res || !rf.has(res)) return null;
    if (!meshes.has(res)) {
      const glb = path.join(outRoot, ...`${res.slice("res:/".length, -".gr2".length)}.glb`.split("/"));
      if (!fs.existsSync(glb)) await extractHull(rf, res, outRoot);
      meshes.set(res, `/client-assets/${res.slice("res:/".length, -".gr2".length)}.glb`);
    }
    return meshes.get(res);
  };
  for (const c of await findSystemCelestials(sdeDir, solarSystemID)) {
    let celestial = null;
    if (c.preset && rf.has(c.preset.replace(/\.red$/i, ".black").toLowerCase())) {
      if (!done.has(c.preset)) done.set(c.preset, extractCelestial(rf, c.preset, outRoot));
      celestial = `/client-assets/${path.relative(outRoot, done.get(c.preset)).split(path.sep).join("/")}`;
    }
    const tex = (res) => (res && rf.has(res.toLowerCase()) ? copyRes(rf, res, outRoot) : null);
    const geometry = celestial ? await meshOf(JSON.parse(fs.readFileSync(done.get(c.preset), "utf8")).geometry ?? null) : null;
    items[c.itemID] = { typeID: c.typeID, kind: c.kind, population: c.population, celestial, NormalHeight1: tex(c.heightMap1), NormalHeight2: tex(c.heightMap2), geometry };
  }
  const file = path.join(outRoot, "celestials", `${solarSystemID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ solarSystemID, celestialBuild: CELESTIAL_BUILD, items }));
  return file;
}

/**
 * The overview's default presets and its first tabs, each name in the client's English (its message through the
 * client's localization file, read by src/clientData/clientWords.js), written as overviewPresets.json:
 * { source, tabs: [{ name, preset }], presets: { shortName: { name, groups, ... } } }.
 *
 * The client's default profile is 'jotunn_default' (overview/default/const.py DEFAULT), a YAML overview in its code
 * (data/jotunn_default.py), read by overviewdefaults.py from the decompiled tree for the installed build
 * (EVEJS_CLIENT_CODE or the output directory's config.json): 36 presets named by "DefaultPreset_<message>",
 * each with a category (categories.py
 * CATEGORY_NAME_LABELS; CATEGORY_ORDER 0 - 5), its groups and states; five tabs named by YAML_OVERVIEWS' tab_name_ids.
 * Where that tree is not had: the FSD defaultoverviews.fsdbinary ('old_default', lib/defaultOverviews.mjs).
 */
export function extractOverviewPresets(rf, clientDir, outRoot, clientCode = process.env.EVEJS_CLIENT_CODE) {
  const { createClientWords } = createRequire(import.meta.url)("../../src/clientData/clientWords.js");
  const words = createClientWords({ clientRoot: clientDir });
  const file = path.join(outRoot, "overviewPresets.json");
  const build = clientBuild(clientDir);
  if (clientCode) {
    const manifest = path.join(clientCode, "MANIFEST.json");
    if (fs.existsSync(manifest)) {
      const codeBuild = String(JSON.parse(fs.readFileSync(manifest, "utf8")).build);
      if (codeBuild !== build) throw new Error(`Overview presets need build ${build} client code, got ${codeBuild} in ${manifest}`);
    }
  }
  // The historical default in overviewdefaults.py is a 3396210 tree.
  const py = clientCode || build === "3396210"
    ? spawnSync(process.env.PYTHON ?? "python", ["-I", path.join(REPO, "tools", "client-extract", "overviewdefaults.py"),
      ...(clientCode ? [clientCode] : [])], { encoding: "utf8", maxBuffer: 16 << 20, input: "" })
    : null;
  if (clientCode && (py?.status !== 0 || !py.stdout?.trim())) {
    throw new Error(`Could not read build ${build} Jotunn overview presets from ${clientCode}: ${py?.stderr?.trim() || py?.error?.message || "no data"}`);
  }
  if (py?.status === 0 && py.stdout.trim()) {
    const jotunn = JSON.parse(py.stdout);
    const CATEGORY_NAME_LABELS = { 1: "Overview/Default/CategoryNames/General", 2: "Overview/Default/CategoryNames/WarpTo",
      3: "Overview/Default/CategoryNames/TargetCapsuleer", 4: "Overview/Default/CategoryNames/Friendly", 5: "Overview/Default/CategoryNames/Mining" };
    const presets = {};
    for (const [shortName, p] of Object.entries(jotunn.presets)) {
      presets[shortName] = { name: (p.nameID && words.message(p.nameID)) || shortName, nameID: p.nameID, categoryID: p.categoryID,
        categoryName: CATEGORY_NAME_LABELS[p.categoryID] ? words.template(CATEGORY_NAME_LABELS[p.categoryID]) : null,
        descriptionID: p.descriptionID, groups: p.groups, alwaysShownStates: p.alwaysShownStates, filteredStates: p.filteredStates };
    }
    const tabs = jotunn.tabs.filter((t) => t.overview && presets[t.overview])
      .map((t) => ({ name: (t.nameID && words.message(t.nameID)) || t.yamlName, preset: t.overview, bracket: t.bracket }));
    fs.writeFileSync(file, JSON.stringify({ source: "jotunn_default", defaultPreset: jotunn.defaultPreset, categoryOrder: [0, 1, 2, 3, 4, 5], tabs, presets }));
    return file;
  }
  const presets = readDefaultOverviews(rf.read("res:/staticdata/defaultoverviews.fsdbinary"));
  const byShort = {};
  for (const p of presets) byShort[p.shortName] = { name: words.message(p.nameID) ?? p.shortName, nameID: p.nameID, groups: p.groups };
  const tabs = DEFAULT_TAB_NAMES.filter((n) => byShort[n]).map((n) => ({ name: byShort[n].name, preset: n }));
  fs.writeFileSync(file, JSON.stringify({ source: "old_default", tabs, presets: byShort }));
  return file;
}

/** One model: every LOD to .glb, its own texture set copied beside it, and what was done in .json. */
export async function extractHull(rf, res, outRoot) {
  const g = await readGranny(rf.read(res), res);
  const lods = g.root.Meshes.map(meshArrays);
  const stem = res.slice(0, -".gr2".length);
  const base = path.join(outRoot, ...stem.slice("res:/".length).split("/"));
  fs.mkdirSync(path.dirname(base), { recursive: true });

  const textures = {};
  for (const [suffix, role] of Object.entries(TEXTURE_ROLES)) {
    for (const variant of ["", "_lowdetail", "_mediumdetail"]) {
      const tres = `${stem}_${suffix}${variant}.dds`;
      if (!rf.has(tres)) continue;
      fs.writeFileSync(`${base}_${suffix}${variant}.dds`, rf.read(tres));
      (textures[role] ??= {})[variant.slice(1) || "full"] = `${path.basename(stem)}_${suffix}${variant}.dds`;
    }
  }

  const name = path.basename(stem);
  fs.writeFileSync(`${base}.glb`, writeGlb({ name, lods, extras: { source: res, textures } }));
  const info = {
    source: res,
    lods: lods.map((m) => ({ name: m.name, vertices: m.vertexCount, triangles: m.indices.length / 3, maxScreenSize: m.extended?.maxScreenSize ?? null, areas: m.groups.map((x) => ({ name: m.materials[x.material] ?? null, triangles: x.count })), components: m.components })),
    textures,
    artTool: g.root.ArtToolInfo?.FromArtToolName ?? null,
    exportedFrom: g.root.FromFileName ?? null,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(info, null, 2));
  return { res, glb: `${base}.glb`, lods: lods.length, textures: Object.keys(textures).length };
}

function addToManifest(outRoot, build, client, done) {
  const manifestFile = path.join(outRoot, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { build, client: path.basename(client), hulls: [] };
  manifest.hulls = [...new Set([...manifest.hulls, ...done])].sort();
  manifest.updated = new Date().toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
}

// Build 3698585: type 85231 uses graphic 28011 and bucket 36. Hull jhs1 has
// no explosion or damage locators, so only the global graph is placed.
async function extractDrifterCollectionExplosion(rf, outRoot) {
  const resource = "res:/fisfx/explosion/ecx_drifter_explosive_01a.red";
  let explosion;
  const effect = readEffectFile(rf, resource, (root) => {
    explosion = root.effectChildren?.find((child) => child.type === "EveChildExplosion");
    return explosion?.globalExplosion;
  }, { allShaderQualities: true });
  if (!effect?.root) throw new Error(`Drifter Collection global effect missing from ${resource}`);
  const { root, childEffects, skipped } = effect;
  const hasGpu = await copyChildGraphAssets(rf, [root, ...Object.values(childEffects)], outRoot);
  const gpuParticles = hasGpu ? Object.fromEntries([
    ["atlas", "res:/fisfx/gpuparticles/systematlas.dds"],
    ["noise", "res:/texture/global/noise32cube_volume.dds"],
  ].map(([name, res]) => [name, rf.has(res) ? copyRes(rf, res, outRoot) : null])) : undefined;
  fs.writeFileSync(path.join(outRoot, "drifterCollectionExplosion.json"), JSON.stringify({
    explosionBuild: 2,
    root,
    childEffects,
    skipped,
    gpuParticles,
    delayMs: explosion.globalExplosionDelay * 1000,
    durationMs: explosion.globalDuration * 1000,
    modelSwitchDelayMs: 504,
    scale: 0.75,
  }));
}

function extractObservatoryEnvironment(rf, clientDir, outRoot) {
  // ENV_Ancient_Jove_01a's ball, not a room template (dungeon 12260 has no row in dungeonEnvironmentTemplates).
  const anchor = 49106;
  const mapping = JSON.parse(readClientTable(rf, clientDir, "environmentTemplateAnchorTypeIDs", [anchor]))[anchor];
  const templateID = mapping?.baseEnvironment;
  if (!templateID) throw new Error(`No environment for Observatory anchor ${anchor}`);
  const template = JSON.parse(readClientTable(rf, clientDir, "environmentTemplates", [templateID]))[templateID];
  const resource = template.postProcess.path.toLowerCase().replace(/\.red$/, ".black");
  const post = readBlack(rf.read(resource), resource);
  const bloom = post.bloom && {
    ...post.bloom,
    grimePath: copyRes(rf, post.bloom.grimePath, outRoot),
  };
  const lut = post.lut && { ...post.lut, path: copyRes(rf, post.lut.path, outRoot) };
  if (!bloom || !lut || !post.godRays) throw new Error(`Observatory environment is missing postprocessing in ${resource}`);
  const godRays = {
    ...post.godRays,
    noise: copyRes(rf, post.godRays.noiseTexturePath ?? "res:/texture/global/noise.dds", outRoot),
  };
  // Sun.Reload and PostProcess use cfg.mapSystemCache's flare graphic, whose
  // albedo has its own color separate from the system star's graphic.
  const systemsPath = "res:/staticdata/systems.static";
  const systems = readFsdStatic(rf.read(systemsPath), systemsPath, { schema: rf.read("res:/staticdata/systems.schema") });
  const sunFlareBySystem = Object.fromEntries(Object.entries(systems)
    .filter(([, row]) => row.sunFlareGraphicID > 0).map(([id, row]) => [id, row.sunFlareGraphicID]));
  const flareIDs = [...new Set(Object.values(sunFlareBySystem))];
  const graphics = JSON.parse(readClientTable(rf, clientDir, "graphicIDs", flareIDs));
  const sunFlares = Object.fromEntries(flareIDs.flatMap((id) => {
    const graphic = graphics[id];
    const file = graphic?.graphicFile?.toLowerCase().replace(/\.red$/, ".black");
    if (!file || !rf.has(file)) return [];
    const flare = readBlack(rf.read(file), file);
    // OccluderManagement has two foreground and two planet query slots.
    const masks = [flare.occluders, flare.backgroundOccluders].flatMap((groups, layer) => (groups ?? []).flatMap((group) => {
      const sprite = group.sprites?.[0];
      const mask = sprite?.mesh?.opaqueAreas?.[0]?.effect?.resources?.find((r) => r.name === "TexMap")?.resourcePath;
      const depth = -sprite?.translation?.[2];
      if (group.display === false || sprite?.display === false || group.sprites?.length !== 1 || !(depth > 0) || !mask
        || sprite.translation[0] !== 0 || sprite.translation[1] !== 0
        || sprite.mesh.geometryResPath.toLowerCase() !== "res:/model/global/zsprite.gr2") return [];
      return [{ background: layer === 1, mask: copyRes(rf, mask, outRoot),
        halfSize: sprite.scaling.slice(0, 2).map((size) => size * 0.5 / depth) }];
    }));
    return masks.length ? [[id, { color: graphic.albedoColor, masks }]] : [];
  }));
  fs.writeFileSync(path.join(outRoot, "observatoryEnvironment.json"), JSON.stringify({
    environmentBuild: 3,
    anchor,
    templateID,
    ...template,
    postProcess: { ...template.postProcess, ...post, bloom, godRays, lut },
    sunFlareBySystem,
    sunFlares,
  }));
}

function extractObservatoryVortex(rf, outRoot) {
  const resource = "res:/fisfx/vdb/vortex_06i.black";
  const root = readBlack(rf.read(resource), resource);
  const cloud = root.effectChildren?.flatMap((child) => child.objects ?? []).find((child) => child.type === "EveChildCloud2");
  if (!cloud || !/\/basiccloud\.fx$/i.test(cloud.effect?.effectFilePath)) throw new Error(`No basiccloud child in ${resource}`);
  const textures = Object.fromEntries(cloud.effect.resources.map(({ name, resourcePath }) => [name, resourcePath]));
  const density = textures.DensityMap;
  const low = density.replace(/\.vta$/i, "_lowdetail.vta");
  if (textures.TemperatureMap !== density) throw new Error(`Unexpected separate temperature map in ${resource}`);
  const constants = Object.fromEntries(cloud.effect.constParameters.items);
  const variables = Object.fromEntries(root.controllers.flatMap((controller) => controller.variables).map(({ name, defaultValue }) => [name, defaultValue]));
  const start = root.curveSets.find((set) => set.name === "play_start");
  const curve = (name) => start.curves.find((entry) => entry.name === name);
  const binding = (name) => start.bindings.find((entry) => entry.name === name);
  const color = curve("CloudColor").color1;
  const reflectionNoise = cloud.reflectionEffect?.resources.find(({ name }) => name === "NoiseMap")?.resourcePath;
  if (cloud.reflectionMode !== 0 || !reflectionNoise || !/\/basiccloudreflectionproxy\.fx$/i.test(cloud.reflectionEffect.effectFilePath)) {
    throw new Error(`No High reflection proxy in ${resource}`);
  }
  // CTRL_VDB starts with density and brightness at High. The density binding feeds the normalized color alpha.
  const reflectionDensity = variables._densityMax * binding("sendOverDensity").scale / curve("DensityNormalized").input2
    * 0.42 * Math.min(1, Math.max(0.175, variables._brightnessMax));
  const reflectionColors = [1, 2].map((i) => {
    const name = `reflectionColor${i}`;
    const rgb = curve(name).color1.slice(0, 3).map((value, channel) =>
      value * (binding(`${name}.${"xyz"[channel]}_UpdateDest`).scale ?? 1));
    return [...rgb, reflectionDensity * (binding(`reflectionDensity${i}.w_UpdateDest`).scale ?? 1)];
  });
  fs.writeFileSync(path.join(outRoot, "observatoryVortex.json"), JSON.stringify({
    vortexBuild: 2,
    scaling: cloud.scaling,
    density: variables._densityMax,
    albedo: color.slice(0, 3).map((value) => value * variables._brightnessMax),
    steps: constants.IntegrationSteps[0],
    noiseFactor: constants.NoiseFactor[0],
    temperatureControl: constants.TemperatureControl,
    absorptionPhase: constants.AbsorptionPhase[0],
    lights: cloud.lights.map(({ position, radius, innerRadius, color, brightness }) => ({ position, radius, innerRadius, color, brightness })),
    volume: copyRes(rf, density, outRoot),
    volumeLow: copyRes(rf, low, outRoot),
    noise: copyRes(rf, textures.NoiseMap, outRoot),
    gradient: copyRes(rf, textures.TemperatureGradientMap, outRoot),
    reflection: { colors: reflectionColors, noise: copyRes(rf, reflectionNoise, outRoot) },
  }));
}

function parseArgs(argv) {
  const out = { hulls: [], types: [], typeSkins: [], graphics: [], dnas: [], scenes: [], wormholeNebulas: [], celestials: [], turrets: [], missiles: [], systemCelestials: [], typeGraphics: false, gfxTurrets: false, ammoColors: false, sofMaterials: false, fx: [], effects: [], starMap: false, fittingScene: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--sde") out.sde = argv[++i];
    else if (a === "--type-graphics") out.typeGraphics = true;
    else if (a === "--sof-defaults") out.sofDefaults = true;
    else if (a === "--overview") out.overview = true;
    else if (a === "--hull") out.hulls.push(argv[++i]);
    else if (a === "--type") out.types.push(Number(argv[++i]));
    else if (a === "--type-skin") {
      const typeID = Number(argv[++i]), materialSetID = Number(argv[++i]);
      if (![typeID, materialSetID].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error("--type-skin needs a type ID and material set ID");
      out.typeSkins.push({ typeID, materialSetID });
    }
    else if (a === "--graphic") out.graphics.push(Number(argv[++i]));
    else if (a === "--dna") out.dnas.push(String(argv[++i]));
    else if (a === "--scene") out.scenes.push(argv[++i]);
    else if (a === "--wormhole-nebula") {
      const id = Number(argv[++i]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("--wormhole-nebula needs a scene graphic ID");
      out.wormholeNebulas.push(id);
    }
    else if (a === "--celestial") out.celestials.push(argv[++i]);
    else if (a === "--turret") out.turrets.push(argv[++i]);
    else if (a === "--gfx-turrets") out.gfxTurrets = true;
    else if (a === "--ammo-colors") out.ammoColors = true;
    else if (a === "--asteroid-rules") out.asteroidRules = true;
    else if (a === "--sof-materials") out.sofMaterials = true;
    else if (a === "--fx") out.fx.push(argv[++i]);
    else if (a === "--star-map") out.starMap = true;
    else if (a === "--fitting-scene") out.fittingScene = true;
    else if (a === "--dscan-hologram") out.dscanHologram = true;
    else if (a === "--dscan-cones") out.dscanCones = true;
    else if (a === "--wormhole-transit") out.wormholeTransit = true;
    else if (a === "--warp-tunnel") out.warpTunnel = true;
    else if (a === "--ship-info") out.shipInfo = true;
    else if (a === "--drifter-collection-explosion") out.drifterCollectionExplosion = true;
    else if (a === "--observatory-environment") out.observatoryEnvironment = true;
    else if (a === "--observatory-vortex") out.observatoryVortex = true;
    else if (a === "--effect") out.effects.push(argv[++i]);
    else if (a === "--missile") out.missiles.push(Number(argv[++i]));
    else if (a === "--system-celestials") out.systemCelestials.push(Number(argv[++i]));
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = resolveClient(args.client);
  const build = clientBuild(client);
  const outRoot = path.resolve(args.out ?? path.join(REPO, "_local", "client-assets", build));
  const rf = openResFiles(client);
  fs.mkdirSync(outRoot, { recursive: true });
  console.log(`client ${client} (build ${build}) -> ${outRoot}`);
  const config = { client: path.resolve(client), sde: args.sde ? path.resolve(args.sde) : null, build };
  const configFile = path.join(outRoot, "config.json");
  const old = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  fs.writeFileSync(configFile, JSON.stringify({ ...old, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null)) }, null, 2));

  const sde = args.sde ?? old.sde ?? null;
  if (args.sofDefaults && !sde) throw new Error("--sof-defaults needs the matching export (--sde or a configured export folder)");
  let stockDefaults = {};
  if (args.sofDefaults || args.typeGraphics || args.types.length || args.graphics.length) {
    const file = path.join(outRoot, GRAPHIC_SOF_DEFAULTS);
    if (sde && (args.sofDefaults || args.sde || !fs.existsSync(file))) {
      stockDefaults = buildGraphicSofDefaults(sde);
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(stockDefaults));
      fs.renameSync(temporary, file);
    } else if (fs.existsSync(file)) stockDefaults = JSON.parse(fs.readFileSync(file, "utf8"));
  }

  let typeGraphics = null;
  const tgFile = path.join(outRoot, "typeGraphics.json");
  if (args.typeGraphics) {
    if (!args.sde) throw new Error("--type-graphics needs --sde <SDE jsonl folder>");
    typeGraphics = await buildTypeGraphics(args.sde, rf);
    fs.writeFileSync(tgFile, JSON.stringify(typeGraphics));
    const all = Object.values(typeGraphics);
    console.log(`typeGraphics.json: ${all.length} types, ${all.filter((t) => t.gr2).length} with a SOF hull model, ${all.filter((t) => t.hull && !t.gr2).length} hulls without one found`);
    const scenes = await buildSystemScenes(args.sde);
    fs.writeFileSync(path.join(outRoot, "systemScenes.json"), JSON.stringify(scenes));
    console.log(`systemScenes.json: ${Object.keys(scenes).length} systems`);
    const br = extractBrackets(rf, outRoot);
    console.log(`brackets.json: ${Object.keys(br.brackets).length} brackets, ${Object.keys(br.byType).length} by type, ${Object.keys(br.byGroup).length} by group`);
    const names = await buildTypeNames(mapSdeDir(args.sde, ["types.jsonl", "groups.jsonl", "mapSolarSystems.jsonl"]));
    fs.writeFileSync(path.join(outRoot, "typeNames.json"), JSON.stringify(names));
    console.log(`typeNames.json: ${Object.keys(names.types).length} types, ${Object.keys(names.groups).length} groups`);
  } else if (fs.existsSync(tgFile)) typeGraphics = JSON.parse(fs.readFileSync(tgFile, "utf8"));

  if (args.asteroidRules) {
    const groups = groupGraphics(rf, client, outRoot, REPO);
    const typeGraphicIDs = Object.fromEntries(Object.entries(typeGraphics ?? {}).map(([id, row]) => [id, row.graphicID]));
    const destination = path.join(outRoot, "asteroidRules.json");
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ groups, typeGraphicIDs }));
    fs.renameSync(temporary, destination);
  }

  const specs = [...args.hulls];
  const meshMissing = (gr2) => {
    const stem = path.join(outRoot, ...gr2.slice("res:/".length, -".gr2".length).split("/"));
    const glb = stem + ".glb";
    return !fs.existsSync(stem + ".json") || !fs.existsSync(glb) || glbBuildOf(fs.readFileSync(glb)) < GLB_BUILD;
  };
  const resolvedGeometry = new Map();
  for (const typeID of args.types) {
    const tg = typeGraphics?.[typeID];
    if (!tg?.gr2 && !tg?.hull) throw new Error(`--type ${typeID}: no SOF hull model known (run --type-graphics with --sde first)`);
    const gr2 = tg.gr2 ?? indexedHullGeometry(rf, loadSof(rf).hulls.get(tg.hull.toLowerCase()));
    if (!tg.gr2) resolvedGeometry.set(typeID, gr2);
    if (!gr2) continue;
    if (meshMissing(gr2)) specs.push(gr2);
    const materialSet = stockDefaults[tg.graphicID];
    const faction = materialSet?.sofFactionName || tg.faction;
    const sofFile = await extractSof(rf, gr2, tg.hull, faction, outRoot, tg.race, { materialSet });
    console.log(`type ${typeID}: ${tg.hull} as ${faction}${sofFile ? " -> " + path.relative(outRoot, sofFile) : " (no SOF hull)"}`);
  }
  if (args.typeSkins.length) {
    if (!sde) throw new Error("--type-skin needs the matching client export (--sde or a configured export folder)");
    const materialSets = loadGraphicMaterialSets(sde);
    const sof = loadSof(rf);
    for (const { typeID, materialSetID } of args.typeSkins) {
      const g = typeGraphics?.[typeID];
      const materialSet = materialSets.get(materialSetID);
      const hull = g?.hull ? sof.hulls.get(g.hull.toLowerCase()) : null;
      const gr2 = hull && (g.gr2 ?? indexedHullGeometry(rf, hull));
      let descriptor = { sofBuild: SOF_BUILD, gr2: null };
      if (materialSet && gr2) {
        const faction = materialSet.sofFactionName || g.faction;
        const file = await extractSof(rf, gr2, g.hull, faction, outRoot, g.race, { typeID, materialSet });
        if (file) {
          if (meshMissing(gr2) && !specs.includes(gr2)) specs.push(gr2);
          descriptor = { sofBuild: SOF_BUILD, ...g, typeID, gr2, faction, skinMaterialSetID: materialSetID };
        }
      }
      const file = path.join(outRoot, "typeSkins", `${typeID}.${materialSetID}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(descriptor));
    }
  }
  // --graphic: a SOF graphic that is no type's (a station hangar: hangarRegistry's hangarModelGraphicID), its hull and
  // faction from the SDE's graphics, its model found by the hull's name in the client's index; graphics/<id>.json.
  if (args.graphics.length) {
    const sdeDir = args.sde ?? old.sde ?? null;
    if (!sdeDir) throw new Error("--graphic needs the SDE (--sde, or a config.json that names it)");
    const wanted = new Set(args.graphics);
    const found = new Map();
    for (const line of fs.readFileSync(graphicsFile(sdeDir), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const g = JSON.parse(line);
      if (wanted.has(g._key)) found.set(g._key, g);
    }
    for (const graphicID of args.graphics) {
      const g = found.get(graphicID);
      const file = path.join(outRoot, "graphics", `${graphicID}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A scene graphic (a hangar's: hangarRegistry's sceneGraphicID): its EveSpaceScene's environment cube maps, sun
      // and ambient, as the hangar is lit by them.
      if (g?.graphicFile && /_scene\.(red|black)$/i.test(g.graphicFile)) {
        const black = g.graphicFile.toLowerCase().replace(/\.red$/, ".black");
        const s = readBlack(rf.read(black), black);
        const copy = (res) => {
          if (!res) return null;
          const key = res.toLowerCase();
          if (!rf.has(key)) return null;
          const out = path.join(outRoot, ...key.slice("res:/".length).split("/"));
          fs.mkdirSync(path.dirname(out), { recursive: true });
          if (!fs.existsSync(out)) fs.writeFileSync(out, rf.read(key));
          return "/client-assets/" + key.slice("res:/".length);
        };
        fs.writeFileSync(file, JSON.stringify({ graphicID, scene: {
          reflection: copy(s.envMapResPath), envMap1: copy(s.envMap1ResPath), blur: copy(s.envMap2ResPath),
          sunDiffuseColor: s.sunDiffuseColor ?? null, sunDirection: s.sunDirection ?? null, ambientColor: s.ambientColor ?? null,
          // the post-process effects drawn so far: the dynamic exposure's values the scene sets (the rest are defaults)
          postprocess: { dynamicExposure: s.postprocess?.dynamicExposure ? Object.fromEntries(Object.entries(s.postprocess.dynamicExposure).filter(([k, v]) => k !== "type" && typeof v === "number")) : null },
        } }));
        console.log(`graphic ${graphicID}: scene ${g.graphicFile}`);
        continue;
      }
      if (!g?.sofHullName) throw new Error(`--graphic ${graphicID}: not a SOF hull or scene graphic`);
      const hull = g.sofHullName.toLowerCase();
      const authoredGeometry = loadSof(rf).hulls.get(hull)?.geometryResFilePath;
      let gr2 = typeof authoredGeometry === "string" ? authoredGeometry.replace(/\\/g, "/").toLowerCase() : null;
      if (!gr2 || !rf.has(gr2)) {
        gr2 = null;
        for (const [key] of rf.entries) if (key.endsWith(`/${hull}.gr2`) && key.startsWith("res:/dx9/model/")) { gr2 = key; break; }
      }
      if (!gr2) throw new Error(`--graphic ${graphicID}: no model ${hull}.gr2 in the client`);
      if (meshMissing(gr2)) specs.push(gr2);
      const materialSet = stockDefaults[graphicID];
      const faction = (materialSet?.sofFactionName || g.sofFactionName) ?? null;
      await extractSof(rf, gr2, g.sofHullName, faction, outRoot, g.sofRaceName ?? null, { materialSet });
      fs.writeFileSync(file, JSON.stringify({ graphicID, hull: g.sofHullName, faction, race: g.sofRaceName ?? null, gr2,
        ...(materialSet && { sofMaterialSetID: materialSet._key }) }));
      console.log(`graphic ${graphicID}: ${g.sofHullName} as ${faction ?? "none"}`);
    }
  }
  // --dna <hull:faction:race>: a SOF DNA that is no graphic's (a structure's animation state object -
  // graphicIDs.animationStateObjects, BuildFromDNA), its hull's model found as --graphic finds it; dna/<hull.faction.race>.json.
  for (const dna of args.dnas) {
    const [hullName, factionName = null, raceName = null] = dna.split(":");
    const hull = String(hullName || "").toLowerCase();
    if (!/^[a-z0-9_]+$/.test(hull)) throw new Error(`--dna ${dna}: not a hull name`);
    // the hull's own geometry (EveSOFDataHull.geometryResFilePath), else a model of the hull's name
    const sofHull = loadSof(rf).hulls.get(hull) ?? null;
    if (!sofHull) throw new Error(`--dna ${dna}: no SOF hull ${hull}`);
    let gr2 = String(sofHull.geometryResFilePath ?? "").replace(/\\/g, "/").toLowerCase() || null;
    if (gr2 && !rf.has(gr2)) gr2 = null;
    if (!gr2) for (const [key] of rf.entries) if (key.endsWith(`/${hull}.gr2`) && key.startsWith("res:/dx9/model/")) { gr2 = key; break; }
    if (!gr2) throw new Error(`--dna ${dna}: the hull has no geometry (${String(sofHull.geometryResFilePath ?? "none")})`);
    if (meshMissing(gr2)) specs.push(gr2);
    await extractSof(rf, gr2, hullName, factionName, outRoot, raceName);
    const file = path.join(outRoot, "dna", `${dna.toLowerCase().replace(/:/g, ".")}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ dna, hull: hullName, faction: factionName, race: raceName, gr2 }));
    console.log(`dna ${dna}: ${gr2}`);
  }
  const done = [];
  for (const spec of specs) {
    const res = hullPath(rf, spec);
    const r = await extractHull(rf, res, outRoot);
    console.log(`${res}: ${r.lods} LODs, ${r.textures} texture roles -> ${path.relative(outRoot, r.glb)}`);
    done.push(r.res);
  }
  if (done.length) addToManifest(outRoot, build, client, done);
  for (const [id, gr2] of resolvedGeometry) {
    const file = path.join(outRoot, "typeGeometry", `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ gr2 }));
  }
  for (const c of args.celestials) console.log(`${c} -> ${path.relative(outRoot, extractCelestial(rf, c, outRoot))}`);
  for (const t of args.turrets) console.log(`${t} -> ${path.relative(outRoot, await extractTurret(rf, t, outRoot))}`);
  for (const scene of args.scenes) console.log(`${scene}: ${Object.keys(extractScene(rf, scene, outRoot)).join(", ")}`);
  for (const id of args.wormholeNebulas) {
    if (!sde) throw new Error("--wormhole-nebula needs matching graphic records");
    console.log(`wormhole nebula ${id}: ${extractWormholeNebula(rf, sde, id, outRoot)}`);
  }
  if (args.wormholeTransit) await extractWormholeTransit(rf, outRoot);
  if (args.warpTunnel) await extractWarpTunnel(rf, outRoot);
  // gfxTurrets.json: an NPC hull's or a sentry's turret module type, by its type (the SDE's gfxTurretID)
  if (args.gfxTurrets) {
    if (!sde) throw new Error("--gfx-turrets needs the SDE (--sde, or a config.json that names it)");
    const map = await buildGfxTurrets(sde);
    fs.writeFileSync(path.join(outRoot, "gfxTurrets.json"), JSON.stringify(map));
    console.log(`gfxTurrets.json: ${Object.keys(map).length} types`);
  }
  // ammoColors.json: the beam colour a charge gives its turret's firing effect, by the charge's typeID
  for (const id of args.effects) {
    if (!sde) throw new Error("--effect needs the SDE (--sde, or a config.json that names it)");
    console.log(`effect ${id} -> ${path.relative(outRoot, await extractEffectGraphic(rf, sde, id, outRoot))}`);
  }
  // starmap.json: the star map's textures (mapView.py: the star particles' TexMap, mapFilterConst's
  // PARTICLE_SPRITE_TEXTURE; mapViewUtil.CreateLineSet's line textures), copied
  // fittingScene.json: the fitting window's ship scene (shipSceneContainer.PrepareSpaceScene's
  // res:/dx9/scene/fitting/fitting.red): its background cube, reflection cubes, sun and ambient
  if (args.fittingScene) {
    const res = "res:/dx9/scene/fitting/fitting.black";
    const s = readBlack(rf.read(res), res);
    const nebula = (s.backgroundEffect?.resources ?? []).find((r) => r.name === "NebulaMap")?.resourcePath ?? null;
    const scene = {
      nebula: nebula && rf.has(nebula.toLowerCase()) ? copyRes(rf, nebula, outRoot) : null,
      reflection: s.envMapResPath ? copyRes(rf, s.envMapResPath, outRoot) : null,
      blur: s.envMap2ResPath ? copyRes(rf, s.envMap2ResPath, outRoot) : null,
      sunDiffuseColor: s.sunDiffuseColor ?? null, sunDirection: s.sunDirection ?? null, ambientColor: s.ambientColor ?? null,
      background: Object.fromEntries(s.backgroundEffect?.constParameters?.items ?? []),
    };
    fs.writeFileSync(path.join(outRoot, "fittingScene.json"), JSON.stringify(scene));
    console.log(`fittingScene.json: ${Object.keys(scene).filter((k) => scene[k]).join(", ")}`);
  }
  if (args.drifterCollectionExplosion) await extractDrifterCollectionExplosion(rf, outRoot);
  if (args.observatoryEnvironment) extractObservatoryEnvironment(rf, client, outRoot);
  if (args.observatoryVortex) extractObservatoryVortex(rf, outRoot);
  if (args.shipInfo) {
    if (!sde) throw new Error("--ship-info needs the SDE");
    const graphic = (id) => sdeGraphic(sde, id)?.graphicFile;
    const res = graphic(26811)?.toLowerCase().replace(/\.red$/, ".black");
    if (!res) throw new Error("No Ship Info scene in the SDE");
    const scene = readBlack(rf.read(res), res);
    const reflections = scene.envMapResPath ? copyRes(rf, scene.envMapResPath, outRoot) : null;
    const background = readEffectFile(rf, "res:/dx9/scene/showinfo/showinfo_logo_background_01a.red");
    const lightRig = readEffectFile(rf, graphic(27949));
    if (!background?.root || !lightRig?.root) throw new Error("Ship Info effect data is missing");
    // set_faction_background repositions the first container after each controller transition.
    for (const effect of Object.values(background.childEffects)) {
      if (effect?.objects?.[0]?.srt) effect.objects[0].srt.translation = [28000, -12000, -99000];
    }
    for (const effect of [background, lightRig]) await copyChildGraphAssets(rf, [effect.root, ...Object.values(effect.childEffects)], outRoot);
    fs.writeFileSync(path.join(outRoot, "shipInfoScene.json"), JSON.stringify({ reflections,
      sunDiffuseColor: scene.sunDiffuseColor, sunDirection: scene.sunDirection, ambientColor: scene.ambientColor,
      background, lightRig }));
    console.log(`shipInfoScene.json: ${Object.keys(background.childEffects).length} faction effects and light rig`);
  }
  if (args.starMap) {
    const textures = {};
    for (const [name, res] of Object.entries({ star: "res:/Texture/Particle/mapStarNew5.dds", heat: "res:/Texture/Particle/mapStarNewHeat.dds", iconAtlas: "res:/Texture/Particle/MapStaticDataCircles_01h.dds",
      line: "res:/UI/Texture/classes/LineSet/lineSegment.dds", lineOverlay: "res:/UI/Texture/classes/MapView/lineSegmentConstellation.dds",
      tube: "res:/Texture/Particle/disk.dds", extra: "res:/Texture/Particle/circleScalingOpacity25.dds",
      convoys: "res:/Texture/Particle/mapStatData_Circle_vanguard_nemesis.dds" })) {
      textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    }
    // the abstract layout's positions (evemap/map2d/overriddenCoordinates.py: the packaged
    // bin:/packages/evemap/overriddenCoordinates.json, each system's 2D 'pos' in metres), as {systemID: [x, z]}
    let abstract = null;
    const coords = path.join(client, "tq", "bin64", "packages", "evemap", "overriddenCoordinates.json");
    if (fs.existsSync(coords)) {
      const raw = JSON.parse(fs.readFileSync(coords, "utf8"));
      const out = {};
      for (const [id, v] of Object.entries(raw)) if (Array.isArray(v?.pos)) out[id] = [v.pos[0], v.pos[1]];
      fs.writeFileSync(path.join(outRoot, "starmap-abstract.json"), JSON.stringify(out));
      abstract = "/client-assets/starmap-abstract.json";
    }
    fs.writeFileSync(path.join(outRoot, "starmap.json"), JSON.stringify({ starMapBuild: 5, textures, abstract }));
    console.log("starmap.json");
  }
  for (const guid of args.fx) {
    if (!sde) throw new Error("--fx needs the SDE (--sde, or a config.json that names it)");
    console.log(`${guid} -> ${path.relative(outRoot, await extractFxGraphic(rf, client, sde, guid, outRoot))}`);
  }
  // sofMaterials.json: every SOF material by name (the paint tool's preview swaps its paints' in, modify_dna)
  if (args.sofMaterials) {
    const map = allMaterials(loadSof(rf));
    fs.writeFileSync(path.join(outRoot, "sofMaterials.json"), JSON.stringify(map));
    console.log(`sofMaterials.json: ${Object.keys(map).length} materials`);
  }
  if (args.dscanHologram) {
    const area = loadSof(rf).data.generic?.variants?.find((variant) => variant.name === "dscan_hologram")?.hullArea;
    if (!area || area.shader !== "fx/fx3dv5.fx") throw new Error("The client's dscan_hologram area is unavailable");
    const textures = Object.fromEntries(area.textures.map(({ name, resFilePath }) => [name, copyRes(rf, resFilePath, outRoot)]));
    const parameters = Object.fromEntries(area.parameters.map(({ name, value }) => [name, value]));
    fs.writeFileSync(path.join(outRoot, "dscanHologram.json"), JSON.stringify({ textures, parameters }));
  }
  if (args.dscanCones) {
    const shapes = {};
    for (const [kind, name] of [["cone", "scancone"], ["half", "scanconehalfsphere"], ["sphere", "scanconesphere"]]) {
      const effect = readEffectFile(rf, `res:/dx9/model/ui/${name}.black`);
      if (!effect?.root || effect.root.k !== "container") throw new Error(`The client's ${name} effect is unavailable`);
      await copyChildGraphAssets(rf, [effect.root, ...Object.values(effect.childEffects)], outRoot);
      shapes[kind] = { root: effect.root, childEffects: effect.childEffects };
    }
    const lineTexture = copyRes(rf, "res:/dx9/texture/ui/lineplanarsmoothadditive.dds", outRoot);
    fs.writeFileSync(path.join(outRoot, "dscanCones.json"), JSON.stringify({ lineTexture, shapes }));
  }
  if (args.ammoColors) {
    if (!sde) throw new Error("--ammo-colors needs the SDE (--sde, or a config.json that names it)");
    const map = ammoColors(rf, client, sde, REPO);
    fs.writeFileSync(path.join(outRoot, "ammoColors.json"), JSON.stringify(map));
    console.log(`ammoColors.json: ${Object.keys(map).length} types`);
  }
  for (const typeID of args.missiles) {
    if (!sde) throw new Error("--missile needs the SDE (--sde, or a config.json that names it)");
    console.log(`missile ${typeID} -> ${path.relative(outRoot, await extractMissile(rf, client, sde, typeID, outRoot))}`);
  }
  for (const systemID of args.systemCelestials) {
    if (!sde) throw new Error("--system-celestials needs the SDE (--sde, or a config.json that names it)");
    const file = await extractSystemCelestials(rf, sde, systemID, outRoot);
    console.log(`system ${systemID} -> ${path.relative(outRoot, file)}`);
  }
  if (args.overview) {
    const configuredCode = process.env.EVEJS_CLIENT_CODE || old.clientCode;
    const clientCode = configuredCode ? path.resolve(configuredCode) : undefined;
    const file = extractOverviewPresets(rf, client, outRoot, clientCode);
    if (clientCode && clientCode !== old.clientCode) {
      const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
      fs.writeFileSync(configFile, JSON.stringify({ ...saved, clientCode }, null, 2));
    }
    console.log(`overview presets -> ${path.relative(outRoot, file)}`);
  }
  if (!done.length && !args.typeGraphics && !args.sofDefaults && !args.overview && !args.scenes.length && !args.wormholeNebulas.length && !args.wormholeTransit && !args.warpTunnel && !args.types.length && !args.typeSkins.length && !args.graphics.length && !args.dnas.length && !args.celestials.length && !args.turrets.length && !args.missiles.length && !args.gfxTurrets && !args.ammoColors && !args.asteroidRules && !args.fx.length && !args.effects.length && !args.starMap && !args.fittingScene && !args.shipInfo && !args.drifterCollectionExplosion && !args.observatoryEnvironment && !args.observatoryVortex && !args.dscanHologram && !args.dscanCones && !args.systemCelestials.length) throw new Error("nothing to do: give --hull, --type, --type-skin, --scene or --type-graphics");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
