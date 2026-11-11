#!/usr/bin/env node
// Extract models and textures from YOUR installed EVE client for the three.js play page.
//
//   node tools/client-extract/extract.mjs [--client "<EVE folder>"] [--out <dir>]
//        [--sde <SDE jsonl folder>] [--type-graphics] [--hull <res path or stem> ...] [--type <typeID> ...]
//        [--scene <res path of an EveSpaceScene> ...] [--celestial <res path of a planet/sun object> ...]
//        [--system-celestials <solarSystemID> ...] [--overview] [--graphic <graphicID> ...]
//        [--turret <res path of a turret module's graphic> ...] [--gfx-turrets] [--missile <missile typeID> ...]
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
import { childEffectRoots, readEffectFile, readHullChildren, readHullControllers, readTrafficInstances, usedLocatorSets } from "./lib/children.mjs";
import { readGranny } from "./lib/granny.mjs";
import { readAnimations } from "./lib/grannyAnim.mjs";
import { meshArrays } from "./lib/mesh.mjs";
import { writeGlb, glbBuildOf, GLB_BUILD } from "./lib/glb.mjs";
import { buildTypeGraphics, buildSystemScenes, buildTypeNames, findSystemCelestials, buildGfxTurrets } from "./lib/typeGraphics.mjs";
import { readFsdStatic } from "./lib/fsdStatic.mjs";
import { loadSof, buildHull } from "./lib/sof.mjs";
import { readCelestial } from "./lib/celestial.mjs";
import { readTurret } from "./lib/turret.mjs";
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
 * A space scene's cube maps (the nebula, its reflection and blurred versions) copied beside where the scene lives,
 * from its EveSpaceScene path (res:/dx9/scene/universe/c02_cube.red -> c02_cube.dds, _refl.dds, _blur.dds).
 */
export function extractScene(rf, scenePath, outRoot) {
  const stem = scenePath.toLowerCase().replace(/.(red|black)$/, "");
  const out = {};
  for (const [role, suffix] of [["nebula", ""], ["reflection", "_refl"], ["blur", "_blur"]]) {
    const res = `${stem}${suffix}.dds`;
    if (!rf.has(res)) continue;
    const file = path.join(outRoot, ...res.slice("res:/".length).split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, rf.read(res));
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
 * textures copied. Whether any node has GPU emitters (the scene's GPU particle system's atlas is then wanted).
 */
async function copyChildGraphAssets(rf, roots, outRoot) {
  const trafficNodes = [], meshNodes = [];
  let gpu = false;
  const walkChildren = (n) => {
    if (!n) return;
    if (n.k === "gpuParticles") gpu = true;
    if (n.k === "traffic") trafficNodes.push(n);
    if (n.k === "mesh" || n.k === "particles") meshNodes.push(n);
    if (n.k === "lines") for (const [name, res] of Object.entries(n.textures)) n.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
    for (const o of n.objects ?? []) walkChildren(o);
    if (n.k === "propagator") walkChildren(n.source);
  };
  for (const r of roots) walkChildren(r);
  for (const n of trafficNodes) {
    n.instances = rf.has(n.instances) ? await readTrafficInstances(rf, n.instances) : null;
    for (const [name, res] of Object.entries(n.textures)) n.textures[name] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  }
  for (const n of meshNodes) {
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
export async function extractSof(rf, gr2, hullName, factionName, outRoot, raceName = null) {
  const built = buildHull(loadSof(rf), hullName, factionName, raceName);
  if (!built) return null;
  // the hull's children as EveSOF builds them for the faction (lib/children.mjs): their drawn graph
  const sof = loadSof(rf);
  built.children = readHullChildren(rf, sof.hulls.get(String(hullName).toLowerCase()), factionName ? sof.factions.get(String(factionName).toLowerCase()) ?? null : null);
  // the object files its controllers load as child effects (each read once, by path)
  built.childEffects = childEffectRoots();
  // the hull's own controllers (their owner the whole model)
  built.hullControllers = readHullControllers(rf, sof.hulls.get(String(hullName).toLowerCase()));
  // the hull's locator sets its children's effect propagators name: each locator [x, y, z, qx, qy, qz, qw]
  const locatorHull = sof.hulls.get(String(hullName).toLowerCase());
  built.locatorSets = Object.fromEntries(usedLocatorSets().map((name) => [name, ((locatorHull?.locatorSets ?? []).find((s) => String(s.name ?? "").trim() === name)?.locators ?? [])
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
  const file = path.join(outRoot, ...`${stem}.${(factionName ?? "none").toLowerCase()}.sof.json`.split("/"));
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

/**
 * A turret module's graphic read for its shots' impacts (lib/turret.mjs), written as <graphic stem>.turret.json (a
 * graphic that is no turret set: {turret: null}).
 */
export async function extractTurret(rf, graphicFile, outRoot) {
  const t = readTurret(rf, graphicFile) ?? { turretBuild: 4, graphicFile, turret: null };
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
        // keys (lib/grannyAnim.mjs)
        animations: readAnimations(g.root).animations,
      };
    }
  }
  for (const [k, res] of Object.entries(t.textures ?? {})) t.textures[k] = rf.has(res) ? copyRes(rf, res, outRoot) : null;
  const rel = graphicFile.toLowerCase().slice("res:/".length).replace(/.(red|black)$/, "") + ".turret.json";
  const file = path.join(outRoot, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(t, null, 1));
  return file;
}

/**
 * A system's planets and moons, each as the client builds it (lib/typeGraphics.mjs findSystemCelestials): its preset's
 * object file extracted (extractCelestial) and its height maps copied, written as celestials/<solarSystemID>.json:
 * { solarSystemID, items: { itemID: { typeID, kind, celestial, NormalHeight1, NormalHeight2, geometry } } }, each a
 * URL or null; the geometry (the preset's sphere mesh) extracted as a .glb once.
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
    items[c.itemID] = { typeID: c.typeID, kind: c.kind, celestial, NormalHeight1: tex(c.heightMap1), NormalHeight2: tex(c.heightMap2), geometry };
  }
  const file = path.join(outRoot, "celestials", `${solarSystemID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // what the dev server checks a list is current by (vite.config.ts looks for "celestialBuild":2)
  fs.writeFileSync(file, JSON.stringify({ solarSystemID, celestialBuild: 2, items }));
  return file;
}

/**
 * The overview's default presets and its first tabs (lib/defaultOverviews.mjs), each preset's name in the client's
 * English (its overviewNameID through the client's localization file, read by src/clientData/clientWords.js), written
 * as overviewPresets.json: { tabs: [{ name, preset }], presets: { shortName: { name, groups } } }.
 */
export function extractOverviewPresets(rf, clientDir, outRoot) {
  const presets = readDefaultOverviews(rf.read("res:/staticdata/defaultoverviews.fsdbinary"));
  const { createClientWords } = createRequire(import.meta.url)("../../src/clientData/clientWords.js");
  const words = createClientWords({ clientRoot: clientDir });
  const byShort = {};
  for (const p of presets) byShort[p.shortName] = { name: words.message(p.nameID) ?? p.shortName, nameID: p.nameID, groups: p.groups };
  const tabs = DEFAULT_TAB_NAMES.filter((n) => byShort[n]).map((n) => ({ name: byShort[n].name, preset: n }));
  const file = path.join(outRoot, "overviewPresets.json");
  fs.writeFileSync(file, JSON.stringify({ tabs, presets: byShort }));
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

function parseArgs(argv) {
  const out = { hulls: [], types: [], graphics: [], scenes: [], celestials: [], turrets: [], missiles: [], systemCelestials: [], typeGraphics: false, gfxTurrets: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--sde") out.sde = argv[++i];
    else if (a === "--type-graphics") out.typeGraphics = true;
    else if (a === "--overview") out.overview = true;
    else if (a === "--hull") out.hulls.push(argv[++i]);
    else if (a === "--type") out.types.push(Number(argv[++i]));
    else if (a === "--graphic") out.graphics.push(Number(argv[++i]));
    else if (a === "--scene") out.scenes.push(argv[++i]);
    else if (a === "--celestial") out.celestials.push(argv[++i]);
    else if (a === "--turret") out.turrets.push(argv[++i]);
    else if (a === "--gfx-turrets") out.gfxTurrets = true;
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
    const names = await buildTypeNames(args.sde);
    fs.writeFileSync(path.join(outRoot, "typeNames.json"), JSON.stringify(names));
    console.log(`typeNames.json: ${Object.keys(names.types).length} types, ${Object.keys(names.groups).length} groups`);
  } else if (fs.existsSync(tgFile)) typeGraphics = JSON.parse(fs.readFileSync(tgFile, "utf8"));

  const specs = [...args.hulls];
  for (const typeID of args.types) {
    const tg = typeGraphics?.[typeID];
    if (!tg?.gr2) throw new Error(`--type ${typeID}: no SOF hull model known (run --type-graphics with --sde first)`);
    const stem = tg.gr2.slice("res:/".length, -".gr2".length);
    // the model where it is missing or of an older GLB build (glb.mjs GLB_BUILD)
    const glbFile = path.join(outRoot, ...`${stem}.glb`.split("/"));
    if (!fs.existsSync(glbFile) || glbBuildOf(fs.readFileSync(glbFile)) < GLB_BUILD) specs.push(tg.gr2);
    const sofFile = await extractSof(rf, tg.gr2, tg.hull, tg.faction, outRoot, tg.race);
    console.log(`type ${typeID}: ${tg.hull} as ${tg.faction}${sofFile ? " -> " + path.relative(outRoot, sofFile) : " (no SOF hull)"}`);
  }
  // --graphic: a SOF graphic that is no type's (a station hangar: hangarRegistry's hangarModelGraphicID), its hull and
  // faction from the SDE's graphics, its model found by the hull's name in the client's index; graphics/<id>.json.
  if (args.graphics.length) {
    const sdeDir = args.sde ?? old.sde ?? null;
    if (!sdeDir) throw new Error("--graphic needs the SDE (--sde, or a config.json that names it)");
    const wanted = new Set(args.graphics);
    const found = new Map();
    for (const line of fs.readFileSync(path.join(sdeDir, "graphics.jsonl"), "utf8").split(/\r?\n/)) {
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
      let gr2 = null;
      for (const [key] of rf.entries) if (key.endsWith(`/${hull}.gr2`) && key.startsWith("res:/dx9/model/")) { gr2 = key; break; }
      if (!gr2) throw new Error(`--graphic ${graphicID}: no model ${hull}.gr2 in the client`);
      const stem = gr2.slice("res:/".length, -".gr2".length);
      if (!fs.existsSync(path.join(outRoot, ...`${stem}.glb`.split("/")))) specs.push(gr2);
      await extractSof(rf, gr2, g.sofHullName, g.sofFactionName ?? null, outRoot, g.sofRaceName ?? null);
      fs.writeFileSync(file, JSON.stringify({ graphicID, hull: g.sofHullName, faction: g.sofFactionName ?? null, race: g.sofRaceName ?? null, gr2 }));
      console.log(`graphic ${graphicID}: ${g.sofHullName} as ${g.sofFactionName ?? "none"}`);
    }
  }
  const done = [];
  for (const spec of specs) {
    const res = hullPath(rf, spec);
    const r = await extractHull(rf, res, outRoot);
    console.log(`${res}: ${r.lods} LODs, ${r.textures} texture roles -> ${path.relative(outRoot, r.glb)}`);
    done.push(r.res);
  }
  if (done.length) addToManifest(outRoot, build, client, done);
  for (const c of args.celestials) console.log(`${c} -> ${path.relative(outRoot, extractCelestial(rf, c, outRoot))}`);
  for (const t of args.turrets) console.log(`${t} -> ${path.relative(outRoot, await extractTurret(rf, t, outRoot))}`);
  for (const scene of args.scenes) console.log(`${scene}: ${Object.keys(extractScene(rf, scene, outRoot)).join(", ")}`);
  const sde = args.sde ?? old.sde ?? null;
  // gfxTurrets.json: an NPC hull's or a sentry's turret module type, by its type (the SDE's gfxTurretID)
  if (args.gfxTurrets) {
    if (!sde) throw new Error("--gfx-turrets needs the SDE (--sde, or a config.json that names it)");
    const map = await buildGfxTurrets(sde);
    fs.writeFileSync(path.join(outRoot, "gfxTurrets.json"), JSON.stringify(map));
    console.log(`gfxTurrets.json: ${Object.keys(map).length} types`);
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
    const file = extractOverviewPresets(rf, client, outRoot);
    console.log(`overview presets -> ${path.relative(outRoot, file)}`);
  }
  if (!done.length && !args.typeGraphics && !args.overview && !args.scenes.length && !args.types.length && !args.graphics.length && !args.celestials.length && !args.turrets.length && !args.missiles.length && !args.gfxTurrets && !args.systemCelestials.length) throw new Error("nothing to do: give --hull, --type, --scene or --type-graphics");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
