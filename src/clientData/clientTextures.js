"use strict";

// ── The client's own pictures, from the install ───────────────────────────────
//
// The retail client draws much of its UI with textures of its own, named by
// res: paths (res:/UI/Texture/Classes/Skills/doNotHave.png, a skill group's
// icon in skills/skillConst.py ICON_BY_GROUPID). The install keeps each one in
// ResFiles under a hashed name, and tq/resfileindex.txt says which: the path,
// lowercased, then the file under ResFiles. The PNGs are stored as they are.
//
// PNGs and the medal atlases' uncompressed BGRA32 DDS format can be read here.
// The index is the whole of what may be read, and nothing else under the install.

const fs = require("node:fs");
const path = require("node:path");
const { readResourceIndex } = require("./clientWords");
const { dds32Png } = require("./dds32Png");

const TEXTURE_PATH = /^res:\/ui\/texture\/[a-z0-9_./-]+\.png$/;
// A graphic's pictures the client renders ahead (eveGraphicIDs iconFolder: res:/dx9/model/.../icons/<graphicID>_64.png),
// which evePhotosvc.GetRenderPath loads for a renderable type: a drone's, a ship's, a structure's.
const RENDER_PATH = /^res:\/dx9\/model\/[a-z0-9_./-]+\/icons\/[0-9]+_(?:64|128)\.png$/;

/**
 * The client's textures, read from `clientRoot` (the folder holding `tq` and
 * `ResFiles`), the index read once when first asked.
 *
 *   available()       whether there is a client to read at all
 *   fileFor(resPath)  the file under ResFiles that holds the texture, or null
 *   videoFor(resPath) the file under ResFiles that holds a res:/video/....webm, or null
 *   pngFor(resPath)   a supported DDS converted to PNG bytes, or null
 */
function createClientTextures({ clientRoot = null, readFile = fs.readFileSync } = {}) {
  let index = null;
  const converted = new Map();
  function fileFor(resPath) {
    if (!clientRoot) return null;
    const asked = String(resPath || "").toLowerCase();
    if (!(TEXTURE_PATH.test(asked) || RENDER_PATH.test(asked)) || asked.includes("..")) return null;
    if (index === null) index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
    const relative = index.get(asked);
    return relative ? path.join(clientRoot, "ResFiles", relative) : null;
  }
  function pngFor(resPath) {
    const asked = String(resPath || "").toLowerCase();
    if (!clientRoot || !/^res:\/ui\/texture\/[a-z0-9_./-]+\.dds$/.test(asked) || asked.includes("..")) return null;
    if (converted.has(asked)) return converted.get(asked);
    if (index === null) index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
    const relative = index.get(asked);
    if (!relative) return null;
    let data;
    try { data = readFile(path.join(clientRoot, "ResFiles", relative)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const png = dds32Png(data);
    if (png !== null) converted.set(asked, png);
    return png;
  }
  // A video of the client's by its res: path (res:/video/....webm), the file under ResFiles, or null.
  function videoFor(resPath) {
    if (!clientRoot) return null;
    const asked = String(resPath || "").toLowerCase();
    if (!/^res:\/video\/[a-z0-9_./-]+\.webm$/.test(asked) || asked.includes("..")) return null;
    if (index === null) index = readResourceIndex(readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"));
    const relative = index.get(asked);
    return relative ? path.join(clientRoot, "ResFiles", relative) : null;
  }
  return { available: () => Boolean(clientRoot), fileFor, pngFor, videoFor };
}

module.exports = { createClientTextures };
