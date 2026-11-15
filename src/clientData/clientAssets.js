"use strict";

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { clientBuild } = require("../../tools/client-extract/lib/resfiles.mjs");
const { droneTurret } = require("../../tools/client-extract/lib/droneTurrets.mjs");
const { SOF_BUILD } = require("../../tools/client-extract/lib/sof.mjs");
const { TURRET_BUILD } = require("../../tools/client-extract/lib/turret.mjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
const EXTRACTOR = path.join(REPO_ROOT, "tools", "client-extract", "extract.mjs");
const runFile = promisify(execFile);
const MIME = new Map([
  [".json", "application/json"], [".glb", "model/gltf-binary"], [".dds", "application/octet-stream"],
  [".ogg", "audio/ogg"], [".wav", "audio/wav"],
]);
const GENERATED = new Map([
  ["/shipInfoScene.json", ["--ship-info"]],
  ["/overviewPresets.json", ["--overview"]],
  ["/sofMaterials.json", ["--sof-materials"]],
  ["/ammoColors.json", ["--ammo-colors"]],
  ["/starmap.json", ["--star-map", '"starMapBuild":5']],
]);

function fileExists(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function containsVersion(file, version) {
  return fileExists(file) && (!version || fs.readFileSync(file, "utf8").includes(version));
}

function newestBuild(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number(b) - Number(a))[0];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

function configuredClientBuild(clientRoot) {
  if (!clientRoot) return undefined;
  try {
    return clientBuild(clientRoot);
  } catch {
    return undefined;
  }
}

function isWithin(root, file) {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function resStem(resPath, suffix) {
  const lower = resPath.toLowerCase();
  return lower.slice("res:/".length).replace(suffix, "");
}

function modelPaths(g) {
  const stem = resStem(g.gr2, /\.gr2$/);
  return {
    stem,
    sof: `${stem}.${String(g.faction ?? "none").toLowerCase()}.sof.json`,
  };
}

async function modelResponse(dir, info, args, ensure, requireSof = false) {
  const { stem, sof } = modelPaths(info);
  const sofFile = path.join(dir, sof);
  await ensure(stem + ".glb", args, null, () => fileExists(path.join(dir, stem + ".json")) &&
    ((!requireSof && !fileExists(sofFile)) || containsVersion(sofFile, `"sofBuild":${SOF_BUILD}`)));
  const mesh = readJson(path.join(dir, stem + ".json"));
  return {
    model: `/client-assets/${stem}.glb`,
    sof: fileExists(sofFile) ? `/client-assets/${sof}` : null,
    textures: mesh.textures,
    lods: mesh.lods.length,
  };
}

async function sceneMaps(dir, resource, ensure) {
  const stem = resStem(resource, /\.(red|black)$/);
  await ensure(stem + ".dds", ["--scene", resource]);
  return Object.fromEntries([["nebula", ""], ["reflection", "_refl"], ["blur", "_blur"]]
    .filter(([, suffix]) => fileExists(path.join(dir, stem + suffix + ".dds")))
    .map(([role, suffix]) => [role, `/client-assets/${stem}${suffix}.dds`]));
}

/** Supply the extracted resources and look up model and scene data on demand. */
async function resolveAsset(rel, dir, ensure, canExtract) {
  const generated = GENERATED.get(rel);
  if (generated) return { file: await ensure(rel.slice(1), [generated[0]], generated[1]) };

  const scene = /^\/scene\/(\d+)$/.exec(rel);
  if (scene) {
    const sys = readJson(path.join(dir, "systemScenes.json"))[scene[1]];
    const maps = sys?.nebula ? await sceneMaps(dir, sys.nebula, ensure) : null;
    return { json: { solarSystemID: Number(scene[1]), ...sys, maps } };
  }
  const universe = /^\/universe-scene\/([a-z0-9_]+)$/i.exec(rel);
  if (universe) {
    const resource = `res:/dx9/scene/universe/${universe[1].toLowerCase()}.red`;
    return { json: { scene: resource, maps: await sceneMaps(dir, resource, ensure) } };
  }
  const celestials = /^\/celestials\/(\d+)\.json$/.exec(rel);
  if (celestials) return { file: await ensure(`celestials/${celestials[1]}.json`, ["--system-celestials", celestials[1]], '"celestialBuild":2') };
  const missile = /^\/missile\/(\d+)$/.exec(rel);
  if (missile) return { file: await ensure(`missiles/${missile[1]}.json`, ["--missile", missile[1]], '"missileBuild":2') };
  const effect = /^\/effect\/(\d+)\.json$/.exec(rel);
  if (effect) return { file: await ensure(`effects/${effect[1]}.json`, ["--effect", effect[1]], '"effectBuild":4') };
  const fx = /^\/fx\/(effects\.[A-Za-z0-9_]+)\.json$/.exec(rel);
  if (fx) return { file: await ensure(`fx/${fx[1]}.json`, ["--fx", fx[1]], '"fxBuild":3') };

  const graphicsForType = (id) => readJson(path.join(dir, "typeGraphics.json"))[id];
  const celestial = /^\/celestial\/(\d+)$/.exec(rel);
  if (celestial) {
    const resource = graphicsForType(celestial[1])?.graphicFile;
    return resource
      ? { file: await ensure(resStem(resource, /\.(red|black)$/) + ".celestial.json", ["--celestial", resource]) }
      : { json: { typeID: Number(celestial[1]), celestial: null } };
  }
  const turret = /^\/turret\/(\d+)$/.exec(rel);
  if (turret) {
    const id = turret[1];
    const graphics = readJson(path.join(dir, "typeGraphics.json"));
    const type = graphics[id];
    let resource = type?.graphicFile;
    if (!/\/turret\//i.test(resource ?? "")) {
      resource = type && droneTurret(Number(id), type.groupID, type.race)?.graphicFile;
      if (!resource) {
        const fitted = readJson(await ensure("gfxTurrets.json", ["--gfx-turrets"]))[id];
        resource = graphics[fitted]?.graphicFile;
      }
    }
    return /\/turret\//i.test(resource ?? "")
      ? { file: await ensure(resStem(resource, /\.(red|black)$/) + ".turret.json", ["--turret", resource], `"turretBuild": ${TURRET_BUILD}`) }
      : { json: { typeID: Number(id), turret: null } };
  }

  const graphic = /^\/graphic\/(\d+)$/.exec(rel);
  if (graphic) {
    const id = graphic[1];
    const args = ["--graphic", id];
    const file = await ensure(`graphics/${id}.json`, args);
    let g = readJson(file);
    if (g.scene && !("postprocess" in g.scene)) {
      await ensure(`graphics/${id}.json`, args, '"postprocess"');
      g = readJson(file);
    }
    if (g.scene) return { json: g };
    const { graphicID, hull, faction, race } = g;
    return { json: { graphicID, ...await modelResponse(dir, g, args, ensure), hull, faction, race } };
  }
  const dna = /^\/dna\/([A-Za-z0-9_]+(?::[A-Za-z0-9_-]*){0,2})$/.exec(rel);
  if (dna) {
    const name = dna[1];
    const args = ["--dna", name];
    const g = readJson(await ensure(`dna/${name.toLowerCase().replace(/:/g, ".")}.json`, args));
    const { hull, faction, race } = g;
    return { json: { dna: name, ...await modelResponse(dir, g, args, ensure), hull, faction, race } };
  }
  const type = /^\/type\/(\d+)$/.exec(rel);
  if (type) {
    const typeID = Number(type[1]);
    let g = graphicsForType(type[1]);
    const args = ["--type", type[1]];
    // An older index recorded no mesh when the indexed file stem differed from
    // the hull's SOF name. Re-read the authored path once and cache the answer.
    if (g?.hull && !g.gr2) {
      const descriptor = `typeGeometry/${typeID}.json`;
      const file = path.join(dir, descriptor);
      if (fileExists(file) || canExtract()) {
        await ensure(descriptor, args);
        g = { ...g, ...readJson(file) };
      }
    }
    if (!g?.gr2) return { json: { typeID, model: null, ...g } };
    return { json: { typeID, ...await modelResponse(dir, g, args, ensure, true), ...g } };
  }
  return { file: path.join(dir, rel.slice(1)) };
}

/**
 * The BFF and Vite's standalone viewers use the same routes and cache layout.
 * The cache is extracted locally and contains both servable files and operator configuration.
 */
function createClientAssets({
  root = path.join(REPO_ROOT, "_local", "client-assets"),
  build = process.env.EVE_CLIENT_BUILD,
  clientRoot = process.env.EVEJS_CLIENT_ROOT,
  fallbackBuild,
  extract = (args) => runFile(process.execPath, [EXTRACTOR, ...args], { maxBuffer: 16 << 20 }),
  errorLogger = console.error,
} = {}) {
  const assets = express();
  assets.disable("x-powered-by");
  const installedBuild = configuredClientBuild(clientRoot);
  const chosenBuild = build || installedBuild || fallbackBuild;
  const extracting = new Map();
  const buildQueue = new Map();

  function installFor(dir, version) {
    if (installedBuild === version) return clientRoot;
    const configFile = path.join(dir, "config.json");
    const client = fileExists(configFile) ? readJson(configFile).client : null;
    return typeof client === "string" && client && configuredClientBuild(client) === version ? client : null;
  }

  function extractOnce(dir, version, args) {
    const key = JSON.stringify([dir, ...args]);
    const active = extracting.get(key);
    if (active) return active;
    const previous = buildQueue.get(dir);
    const work = Promise.resolve(previous).catch(() => {}).then(async () => {
      const client = installFor(dir, version);
      if (!client) {
        throw new Error(`No matching client install is configured for extracted build ${version}.`);
      }
      await extract(["--client", client, "--out", dir, ...args]);
    }).finally(() => {
      extracting.delete(key);
      if (buildQueue.get(dir) === work) buildQueue.delete(dir);
    });
    extracting.set(key, work);
    buildQueue.set(dir, work);
    return work;
  }

  assets.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return res.set("Allow", "GET, HEAD").status(405).end();
    let rel;
    try {
      rel = decodeURIComponent(req.url.split("?", 1)[0]);
    } catch {
      return res.status(400).end();
    }
    const segments = rel.slice(1).split("/");
    if (!rel.startsWith("/") || rel.includes("\\") ||
        segments.some(part => !part || part.startsWith(".") || /[\u0000-\u001f%]/.test(part)) ||
        /^(?:.*\/)?config\.json$/i.test(rel) ||
        (rel.includes(":") && !/^\/dna\/[A-Za-z0-9_]+(?::[A-Za-z0-9_-]*){0,2}$/.test(rel))) {
      return res.status(404).end();
    }
    try {
      const version = chosenBuild || newestBuild(root);
      if (!version || !/^\d+$/.test(version)) return res.status(404).end();
      const candidate = path.resolve(root, version);
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return res.status(404).end();
      const dir = fs.realpathSync(candidate);
      const ensure = async (name, args, marker, alsoReady = () => true) => {
        const file = path.resolve(dir, name);
        if (!isWithin(dir, file)) throw new Error("Invalid extracted resource path.");
        const inflight = extracting.get(JSON.stringify([dir, ...args]));
        if (inflight) await inflight;
        else if (!containsVersion(file, marker) || !alsoReady()) await extractOnce(dir, version, args);
        return file;
      };
      const result = await resolveAsset(rel, dir, ensure, () => installFor(dir, version) !== null);
      if ("json" in result) return res.json(result.json);
      const type = MIME.get(path.extname(result.file).toLowerCase());
      if (!type || !isWithin(dir, result.file) || !fileExists(result.file)) return res.status(404).end();
      const file = fs.realpathSync(result.file);
      if (!isWithin(dir, file) || path.basename(file).toLowerCase() === "config.json") return res.status(404).end();
      return res.type(type).sendFile(file, error => {
        if (error) next(error);
      });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return res.status(404).end();
      errorLogger(error);
      return res.status(500).json({ error: "Client asset extraction failed." });
    }
  });
  assets.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 500).end();
  });
  return assets;
}

module.exports = { createClientAssets };
