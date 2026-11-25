"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const { brotliCompress, constants } = require("node:zlib");

const fsp = fs.promises;
const compress = promisify(brotliCompress);
const OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } };
const MIN_JSON_BYTES = 8 * 1024;

function compressibleAsset(file) {
  if (path.basename(file).toLowerCase() === "config.json") return false;
  return /\.(dds|png|jpe?g|glb|json)$/i.test(file);
}

function sourceTag(stat) {
  return [stat.size, stat.mtimeNs, stat.ctimeNs].map((value) => value.toString(36)).join("-");
}

function stampOf(file) {
  try {
    return fs.readFileSync(file + ".br.meta", "utf8").trim().split("\n");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

function variantStat(file) {
  const stat = fs.lstatSync(file + ".br", { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
}

function brotliVariant(file, source, stamp = stampOf(file)) {
  if (stamp[0] !== sourceTag(source) || !stamp[1] || stamp[1] === "-") return null;
  const stat = variantStat(file);
  return stat && stat.size < source.size && stamp[1] === sourceTag(stat) ? file + ".br" : null;
}

async function publish(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, bytes, { flag: "wx" });
    await fsp.rename(temp, file);
  } finally {
    await fsp.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function prepare(file) {
  const source = await fsp.stat(file, { bigint: true });
  if (!source.isFile() || (file.toLowerCase().endsWith(".json") && source.size < MIN_JSON_BYTES)) return null;
  const key = sourceTag(source);
  const stamp = stampOf(file);
  const sidecar = brotliVariant(file, source, stamp);
  if (sidecar || (stamp[0] === key && stamp[1] === "-")) {
    return { original: Number(source.size), packed: sidecar ? Number(variantStat(file).size) : Number(source.size), updated: false, sidecar: !!sidecar };
  }

  const original = await fsp.readFile(file);
  const data = await compress(original, OPTIONS);
  // A concurrent extraction may have replaced the input. Its own compression
  // job will publish the new representation. Identity stays usable meanwhile.
  if (sourceTag(await fsp.stat(file, { bigint: true })) !== key) return null;
  let saved = "-";
  if (data.length < original.length) {
    await publish(file + ".br", data);
    saved = sourceTag(variantStat(file));
  }
  await publish(file + ".br.meta", `${key}\n${saved}\n`);
  return { original: original.length, packed: saved === "-" ? original.length : data.length, updated: true, sidecar: saved !== "-" };
}

/** Bound the amount of input and encoder work in memory at the same time. */
async function prepareAssets(files, onError) {
  const pending = [...new Set(files)].filter(compressibleAsset).values();
  const totals = { files: 0, compressed: 0, updated: 0, original: 0, packed: 0, failed: 0 };
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (const file of pending) {
      try {
        const result = await prepare(file);
        if (!result) continue;
        totals.files++;
        if (result.sidecar) totals.compressed++;
        if (result.updated) totals.updated++;
        totals.original += result.original;
        totals.packed += result.packed;
      } catch (error) {
        totals.failed++;
        onError(file, error);
      }
    }
  }));
  return totals;
}

module.exports = { brotliVariant, compressibleAsset, prepareAssets, publish, sourceTag };
