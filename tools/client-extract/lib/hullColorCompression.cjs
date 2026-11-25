"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { brotliVariant, publish, sourceTag } = require("./assetCompression.cjs");

const encoderRelease = "libktx-4.4.2";
const recipe = "etc1s-128-v1";
const suffix = ".ktx2";
const minimumSavings = 16 * 1024;

function encoderPath(cacheRoot) {
  const folder = path.resolve(cacheRoot, ".tools", encoderRelease);
  const entry = path.join(folder, "libktx.js");
  return fs.existsSync(entry) && fs.existsSync(path.join(folder, "libktx.wasm")) ? entry : null;
}

function hullColor(file) {
  return /\/dx9\/model\/ship\/.*_a(?:_mediumdetail)?\.dds$/i.test(file.replaceAll("\\", "/"));
}

function receiptOf(file) {
  try {
    return fs.readFileSync(file + suffix + ".meta", "utf8").trim().split("\n");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

function variantStat(file) {
  const stat = fs.lstatSync(file + suffix, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
}

function ktx2Variant(file, source, stamp = receiptOf(file)) {
  if (!source?.isFile() || stamp[0] !== recipe || stamp[1] !== sourceTag(source) || !stamp[2] || stamp[2] === "-") return null;
  const stat = variantStat(file);
  return stat && stamp[2] === sourceTag(stat) ? file + suffix : null;
}

function needsHullColor(file) {
  if (!hullColor(file)) return false;
  const source = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
  if (!source?.isFile() || source.size < BigInt(minimumSavings)) return false;
  const stamp = receiptOf(file);
  return !ktx2Variant(file, source, stamp) && !(stamp[0] === recipe && stamp[1] === sourceTag(source) && stamp[2] === "-");
}

function encode(ktx, bytes) {
  const { parseDDSHeader, decodeImage } = require("dds-ktx-parser");
  const info = parseDDSHeader(bytes, bytes.length);
  if (info?.format !== "BC7" || info.faces !== 1 || info.arraySize !== 1 || info.depth !== 1 ||
      info.layers.length !== info.levels || info.shape.width % 4 || info.shape.height % 4 ||
      Math.max(info.shape.width, info.shape.height) > 2048) return null;

  const create = new ktx.textureCreateInfo();
  const params = new ktx.basisParams();
  let texture;
  try {
    Object.assign(create, {
      vkFormat: ktx.VkFormat.R8G8B8A8_UNORM,
      baseWidth: info.shape.width, baseHeight: info.shape.height, baseDepth: 1,
      numDimensions: 2, numLevels: info.levels, numLayers: 1, numFaces: 1,
      isArray: false, generateMipmaps: false,
    });
    texture = new ktx.texture(create, ktx.TextureCreateStorageEnum.ALLOC_STORAGE);
    for (const mip of info.layers) {
      const rgba = decodeImage(bytes, info.format, mip);
      if (texture.setImageFromMemory(mip.level, 0, 0, rgba) !== ktx.error_code.SUCCESS) throw new Error("Could not copy DDS mip into KTX2.");
    }
    Object.assign(params, { qualityLevel: 128, compressionLevel: 2, threadCount: 1 });
    if (texture.compressBasis(params) !== ktx.error_code.SUCCESS) throw new Error("ETC1S encode failed.");
    return Buffer.from(texture.writeToMemory());
  } finally {
    texture?.delete();
    params.delete();
    create.delete();
  }
}

async function prepareHullColors(files, cacheRoot, onError) {
  const encoder = encoderPath(cacheRoot);
  const totals = { candidates: 0, written: 0, failed: 0, br: 0, ktx2: 0 };
  if (!encoder) return totals;
  let module;
  for (const file of new Set(files)) {
    try {
      if (!needsHullColor(file)) continue;
      totals.candidates++;
      const source = fs.statSync(file, { bigint: true });
      const key = sourceTag(source);
      const br = brotliVariant(file, source);
      const previous = br ? fs.statSync(br).size : Number(source.size);
      let selected = "-";
      if (previous >= minimumSavings) {
        module ??= await require(encoder)();
        const packed = encode(module, fs.readFileSync(file));
        if (sourceTag(fs.statSync(file, { bigint: true })) !== key) continue;
        if (packed && previous - packed.length >= minimumSavings && packed.length <= previous * 0.75) {
          await publish(file + suffix, packed);
          selected = sourceTag(variantStat(file));
          totals.written++;
          totals.br += previous;
          totals.ktx2 += packed.length;
        }
      }
      await publish(file + suffix + ".meta", `${recipe}\n${key}\n${selected}\n`);
    } catch (error) {
      totals.failed++;
      onError(file, error);
    }
  }
  return totals;
}

module.exports = { encoderPath, hullColor, ktx2Variant, needsHullColor, prepareHullColors, suffix };
