"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { prepareAssets } = require("./lib/assetCompression.cjs");
const { encoderPath, prepareHullColors } = require("./lib/hullColorCompression.cjs");

async function buildFiles(root) {
  const builds = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const build of builds) {
    if (build.isDirectory() && /^\d+$/.test(build.name)) await collect(path.join(root, build.name));
  }
  return files;
}

async function main() {
  const root = process.argv[2] ?? path.resolve(__dirname, "../../_local/client-assets");
  const files = await buildFiles(root);
  const report = (file, error) => console.warn(`${file}: ${error.message}`);
  const totals = await prepareAssets(files, report);
  const size = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  console.log(`Client assets: ${totals.compressed}/${totals.files} served with Brotli, ${totals.updated} prepared, ${size(totals.original)} → ${size(totals.packed)} on the wire.`);
  const color = await prepareHullColors(files, root, report);
  if (encoderPath(root)) {
    console.log(`Hull albedo ETC1S: ${color.written}/${color.candidates} new variants, ${size(color.br)} → ${size(color.ktx2)} for those textures.`);
  }
  const failed = totals.failed + color.failed;
  if (failed) {
    console.error(`${failed} files could not be prepared.`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
