"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { prepareAssets } = require("./lib/assetCompression.cjs");

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
  const totals = await prepareAssets(await buildFiles(root), (file, error) => console.warn(`${file}: ${error.message}`));
  const size = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  console.log(`Client assets: ${totals.compressed}/${totals.files} served with Brotli, ${totals.updated} prepared, ${size(totals.original)} → ${size(totals.packed)} on the wire.`);
  if (totals.failed) {
    console.error(`${totals.failed} files could not be prepared.`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
