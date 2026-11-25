// The 3698585 client export keeps graphicids in the client-data bundle, while
// its companion SDE bundle carries the map tables and English type names.
import fs from "node:fs";
import path from "node:path";

function fileExists(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

function sourceBuild(dir) {
  const manifest = path.join(dir, "_sde.jsonl");
  if (!fileExists(manifest)) return null;
  const row = fs.readFileSync(manifest, "utf8").split(/\r?\n/).find(line => line.trim());
  const metadata = row ? JSON.parse(row) : {};
  const build = String(metadata.buildNumber ?? metadata.clientBuild ?? "");
  return /^\d+$/.test(build) ? build : null;
}

function clientTable(sdeDir, filenames, required) {
  const find = dir => filenames.map(file => path.join(dir, file)).find(fileExists);
  const local = find(sdeDir);
  if (local) return local;

  const build = sourceBuild(sdeDir);
  if (build) {
    const sibling = path.resolve(sdeDir, "..", `eve-online-client-static-data-${build}-jsonl`);
    if (sibling !== path.resolve(sdeDir) && sourceBuild(sibling) === build) {
      const file = find(sibling);
      if (file) return file;
    }
  }
  if (!required) return null;
  throw new Error(`Missing ${filenames.join(" or ")} in ${sdeDir} or its matching client export`);
}

export const graphicsFile = (sdeDir, required = true) => clientTable(sdeDir, ["graphics.jsonl", "graphicids.jsonl"], required);
export const solarSystemContentFile = (sdeDir) => clientTable(sdeDir, ["solarsystemcontent.jsonl"], false);
export const graphicMaterialSetsFile = (sdeDir, required = true) => clientTable(sdeDir, ["graphicmaterialsets.jsonl", "graphicMaterialSets.jsonl"], required);

function readRows(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}

export function loadGraphicMaterialSets(sdeDir, required = true) {
  const file = graphicMaterialSetsFile(sdeDir, required);
  return new Map(file ? readRows(file).map(row => [row._key, row]) : []);
}

/** The stock recipe belongs to the graphic, which may be shared by several type IDs. */
export function buildGraphicSofDefaults(sdeDir) {
  const file = graphicsFile(sdeDir, false);
  if (!file) return {};
  const sets = loadGraphicMaterialSets(sdeDir, false);
  return Object.fromEntries(readRows(file).flatMap(graphic => {
    const set = sets.get(graphic.sofMaterialSetID);
    return graphic.sofHullName && set ? [[graphic._key, set]] : [];
  }));
}

export function mapSdeDir(sdeDir, tables) {
  const hasTables = dir => tables.every(file => fileExists(path.join(dir, file)));
  if (hasTables(sdeDir)) return sdeDir;

  const build = sourceBuild(sdeDir);
  if (build) {
    const sibling = path.resolve(sdeDir, "..", `eve-online-static-data-${build}-jsonl`);
    for (const dir of [sibling, process.env.EVEJS_SDE_DIR].filter(Boolean)) {
      if (sourceBuild(dir) === build && hasTables(dir)) return dir;
    }
  }
  throw new Error(`Missing ${tables.join(", ")} in ${sdeDir} or a matching map export`);
}
