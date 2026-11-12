// The client's audio as files a browser plays: a soundbank's embedded sounds (its DIDX index over its DATA chunk) and
// streamed .wem files, Wwise Vorbis rebuilt as Ogg Vorbis (lib/wwiseVorbis.mjs) with the codebook library read out of
// the client's own Wwise engine (tq/bin64/_audio2.dll); Wwise PTADPCM (0x8311: the turrets') decoded to 16-bit PCM
// with the engine's step table (lib/ptadpcm.mjs). Written to _local/client-assets/<build>/audio/<bank>/<id>.ogg / .wav.
//
//   node tools/client-extract/audio.mjs --client "<EVE install>" --bank interface [--bank common ...] [--limit N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openResFiles, clientBuild, findClient } from "./lib/resfiles.mjs";
import { wemToOgg, codebookLibrary, findCodebookLibrary } from "./lib/wwiseVorbis.mjs";
import { findPtadpcmTable, decodePtadpcm, wav } from "./lib/ptadpcm.mjs";
import { readBlack } from "./lib/black.mjs";
import { sdeGraphic } from "./lib/missile.mjs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const clients = opt("--client") ? [opt("--client")] : findClient();
if (clients.length !== 1) { console.error(`pass --client: ${clients.length} installs found`); process.exit(1); }
const client = clients[0];
const build = clientBuild(client);
const res = openResFiles(client);
const limit = Number(opt("--limit") ?? Infinity);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "_local", "client-assets", build, "audio");

const dll = fs.readFileSync(path.join(client, "tq", "bin64", "_audio2.dll"));
const offsets = findCodebookLibrary(dll);
const library = codebookLibrary(dll, offsets);
console.log(`codebook library: ${library.length} codebooks`);
const ptadpcm = findPtadpcmTable(dll).table;

/** A .wem as a file the browser plays: Vorbis rebuilt as Ogg, PTADPCM decoded to a WAV, an extensible WAV kept. */
function convert(wem) {
  const format = wem.length > 22 && String.fromCharCode(...wem.subarray(0, 4)) === "RIFF" ? wem[20] | (wem[21] << 8) : -1;
  if (format === 0x8311) return { ext: "wav", bytes: wav(decodePtadpcm(wem, ptadpcm)) };
  if (format === 0xfffe) return { ext: "wav", bytes: wem };
  return { ext: "ogg", bytes: wemToOgg(wem, library).ogg };
}
const existing = (dir, id) => ["ogg", "wav"].find((ext) => fs.existsSync(path.join(dir, `${id}.${ext}`))) ?? null;

/** A soundbank's sections and its embedded sounds (DIDX: id, offset, size over DATA). */
export function readBank(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = {};
  for (let p = 0; p + 8 <= bytes.length;) {
    const tag = String.fromCharCode(...bytes.subarray(p, p + 4));
    const size = dv.getUint32(p + 4, true);
    chunks[tag] = { offset: p + 8, size };
    p += 8 + size;
  }
  const sounds = [];
  if (chunks.DIDX && chunks.DATA) {
    for (let i = 0; i < chunks.DIDX.size / 12; i++) {
      const o = chunks.DIDX.offset + i * 12;
      const id = dv.getUint32(o, true), off = dv.getUint32(o + 4, true), size = dv.getUint32(o + 8, true);
      sounds.push({ id, bytes: bytes.subarray(chunks.DATA.offset + off, chunks.DATA.offset + off + size) });
    }
  }
  return { chunks, sounds };
}

let written = 0, failed = 0;
const failures = new Map();
const fail = (e) => { failed++; const m = e instanceof Error ? e.message : String(e); failures.set(m, (failures.get(m) ?? 0) + 1); };
// --bank all: every soundbank under essential_media
const bankNames = all("--bank").includes("all")
  ? res.list("res:/audio/essential_media/", /\.bnk$/).map((r) => r.split("/").pop().replace(/\.bnk$/, ""))
  : all("--bank");
for (const bank of bankNames) {
  const bnk = res.read(`res:/audio/essential_media/${bank}.bnk`);
  const { sounds } = readBank(bnk);
  if (!sounds.length) continue;
  const dir = path.join(root, bank);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sounds.slice(0, limit)) {
    if (existing(dir, s.id)) continue;
    try { const c = convert(s.bytes); fs.writeFileSync(path.join(dir, `${s.id}.${c.ext}`), c.bytes); written++; } catch (e) { fail(e); }
  }
  console.log(`${bank}: ${sounds.length} embedded sounds`);
}
console.log(`embedded: written ${written}, failed ${failed}`, Object.fromEntries(failures));

// The events (HIRC across every bank, bank version 150): an Event (type 4: its id the FNV-1 hash of its lowercase
// name; a u8 count of action ids) whose Play action (type 3, action type 0x0403: its target id) plays a Sound (type 2:
// AkBankSourceData - plugin id, stream type at +8: 0 in the bank's data, 1 prefetched, 2 streamed; source id at +9) or
// a random / sequence container (type 5: its CAkPlayList last - a u16 count and (child id, weight) pairs - read from the
// object's end and checked against the hierarchy). events.json maps the event's hash to the sounds it may play,
// "<bank>/<source id>" or "streamed/<source id>" (the source's own res:/audio/media or essential_media <id>.wem).
const objects = new Map();
// init.bnk's STMG game parameters: each RTPC id, its default, its ramp, and the built-in parameter it is bound to
// (eBindToBuiltInParam: 1 is Distance - the emitter's from the listener)
const stmg = (() => { const b = res.read("res:/audio/essential_media/init.bnk"); const c = readBank(b).chunks.STMG; return c ? b.subarray(c.offset, c.offset + c.size) : new Uint8Array(); })();
function boundToDistance(rtpc) {
  for (let p = 0; p + 21 <= stmg.length; p++) {
    if ((stmg[p] | (stmg[p + 1] << 8) | (stmg[p + 2] << 16) | (stmg[p + 3] << 24)) >>> 0 === rtpc) return stmg[p + 20] === 1;
  }
  return false;
}
for (const res0 of res.list("res:/audio/essential_media/", /\.bnk$/)) {
  const bytes = res.read(res0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { chunks } = readBank(bytes);
  if (!chunks.HIRC) continue;
  let q = chunks.HIRC.offset + 4;
  const count = dv.getUint32(chunks.HIRC.offset, true);
  for (let i = 0; i < count; i++) {
    const type = bytes[q], size = dv.getUint32(q + 1, true), id = dv.getUint32(q + 5, true);
    objects.set(id, { type, body: bytes.subarray(q + 5, q + 5 + size) });
    q += 5 + size;
  }
}
const sourceBank = new Map();
for (const bank of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of fs.readdirSync(path.join(root, bank.name))) if (/\.(ogg|wav)$/.test(f)) sourceBank.set(Number(f.slice(0, -4)), `${bank.name}/${f}`);
}
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
/** A random / sequence container's playlist: the ids at its end, where they make a valid list of known objects. */
function playlist(body) {
  for (let n = 1; n <= 255; n++) {
    const at = body.length - 2 - n * 8;
    if (at < 4) break;
    if (u16(body, at) !== n) continue;
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(u32(body, at + 2 + k * 8));
    if (ids.every((id) => objects.has(id))) return ids;
  }
  return [];
}
let streamedWritten = 0;
/** The sounds an object may play: a Sound's source, a container's children's. */
/**
 * A container's children (CAkParentNode's Children: a u32 count and the child ids), found as the first run in its
 * body of a count and that many ids that are all sounds or containers - the parameters before it vary in length by
 * version and are not parsed (a switch container's switch packages come after it).
 */
function childrenAt(body) {
  for (let p = 4; p + 8 <= body.length; p++) {
    const n = u32(body, p);
    if (n < 1 || n > 64 || p + 4 + 4 * n > body.length) continue;
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(u32(body, p + 4 + 4 * k));
    if (ids.every((c) => [2, 5, 6, 9].includes(objects.get(c)?.type ?? -1))) return { at: p, ids };
  }
  return null;
}
const childrenOf = (body) => childrenAt(body)?.ids ?? [];
/**
 * A switch container's children for its default switch (CAkSwitchCntr: eGroupType u8, ulGroupID, ulDefaultSwitch,
 * bIsContinuousValidation u8 just before its Children; after them the switch packages - a count, then each switch
 * id, an item count and the items). The client's SetSwitch states are not read here: the default's, or nothing.
 */
function switchChildren(body) {
  const c = childrenAt(body);
  if (!c || c.at < 10) return [];
  const fallback = u32(body, c.at - 5);
  let q = c.at + 4 + 4 * c.ids.length;
  if (q + 4 > body.length) return [];
  const groups = u32(body, q); q += 4;
  for (let g = 0; g < groups && q + 8 <= body.length; g++) {
    const sw = u32(body, q), n = u32(body, q + 4); q += 8;
    const items = [];
    for (let k = 0; k < n && q + 4 <= body.length; k++, q += 4) items.push(u32(body, q));
    if (sw === fallback) return items;
  }
  return [];
}
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
/**
 * A layer container's crossfades (CAkLayerCntr after its Children: the layer count, then each layer - its id, its RTPC
 * curves (a u16 count; each RTPC id, type, accumulation, parameter, curve id, scaling, a u16 point count and
 * {from, to, interpolation} points), its crossfade RTPC id and type, and its associated children (each child id, a
 * u32 point count and its crossfade curve's points)). Kept where the crossfade's RTPC is bound to Distance: a child's
 * points by its id.
 */
function layerFades(body) {
  const c = childrenAt(body);
  if (!c) return new Map();
  const fades = new Map();
  try {
    let q = c.at + 4 + 4 * c.ids.length;
    const layers = u32(body, q); q += 4;
    for (let l = 0; l < layers; l++) {
      q += 4;
      const curves = u16(body, q); q += 2;
      for (let k = 0; k < curves; k++) { q += 7 + 5; const n = u16(body, q); q += 2 + 12 * n; }
      const rtpc = u32(body, q); q += 5;
      const assoc = u32(body, q); q += 4;
      for (let a = 0; a < assoc; a++) {
        const child = u32(body, q), n = u32(body, q + 4); q += 8;
        const pts = [];
        for (let k = 0; k < n; k++, q += 12) pts.push([f32(body, q), f32(body, q + 4), u32(body, q + 8)]);
        if (boundToDistance(rtpc)) fades.set(child, pts);
      }
    }
  } catch { return new Map(); }
  return fades;
}
/**
 * What an object plays, as layers that sound together, each {s: alternatives, d?: its distance crossfade}: a Sound its
 * source; a random / sequence container (5) one of its playlist's; a switch container (6) its default switch's
 * children; a layer container (9) every child's layers at once, each child's with its crossfade by distance (the
 * innermost kept where they nest).
 */
function layersOf(id, depth = 0) {
  const o = objects.get(id);
  if (!o || depth > 8) return [];
  if (o.type === 9) {
    const fades = layerFades(o.body);
    return childrenOf(o.body).flatMap((child) => layersOf(child, depth + 1).map((l) => (l.d || !fades.has(child) ? l : { ...l, d: fades.get(child) })));
  }
  if (o.type === 6) return switchChildren(o.body).flatMap((child) => layersOf(child, depth + 1));
  if (o.type === 5) {
    const kids = playlist(o.body);
    const alternatives = [...new Set(kids.flatMap((child) => layersOf(child, depth + 1).flatMap((l) => l.s)))];
    return alternatives.length ? [{ s: alternatives }] : [];
  }
  const sources = sourcesOf(id, depth);
  return sources.length ? [{ s: sources }] : [];
}
function sourcesOf(id, depth = 0) {
  const o = objects.get(id);
  if (!o || depth > 8) return [];
  if (o.type === 5) return playlist(o.body).flatMap((child) => sourcesOf(child, depth + 1));
  if (o.type !== 2) return [];
  const stream = o.body[8], source = u32(o.body, 9);
  if (stream === 0) { const file = sourceBank.get(source); return file ? [file] : []; }
  // prefetched or streamed: the whole sound is its own file
  const dir = path.join(root, "streamed");
  let ext = existing(dir, source);
  if (!ext) {
    // (streamed files are under res:/audio/media, prefetched ones mostly under essential_media)
    const wem = [`res:/audio/media/${source}.wem`, `res:/audio/essential_media/${source}.wem`].find((r) => res.has(r));
    if (!wem) return [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      const c = convert(res.read(wem));
      fs.writeFileSync(path.join(dir, `${source}.${c.ext}`), c.bytes);
      ext = c.ext;
      streamedWritten++;
    } catch (e) { fail(e); return []; }
  }
  return [`streamed/${source}.${ext}`];
}
/**
 * An event's layers: each Play action's (0x0403) target's, and a Play Event action's (0x2103: its target another
 * event) that event's; other actions (stop, pause, set ...) play nothing.
 */
function eventLayers(id, depth = 0) {
  const o = objects.get(id);
  if (!o || o.type !== 4 || depth > 4) return [];
  const layers = [];
  for (let k = 0; k < o.body[4]; k++) {
    const action = objects.get(u32(o.body, 5 + k * 4));
    if (!action || action.type !== 3) continue;
    const kind = u16(action.body, 4), target = u32(action.body, 6);
    if (kind === 0x0403) layers.push(...layersOf(target));
    else if (kind === 0x2103) layers.push(...eventLayers(target, depth + 1));
  }
  return layers;
}
// events.json: an event's id to its layers - each its alternatives, or {s: alternatives, d: [[distance, gain,
// interpolation], ...]} where it fades by distance - one alternative of each layer played together
const events = {};
let layered = 0, faded = 0;
for (const [id, o] of objects) {
  if (o.type !== 4) continue;
  const layers = eventLayers(id).filter((l) => l.s.length);
  if (!layers.length) continue;
  events[id] = layers.map((l) => (l.d ? { s: l.s, d: l.d.map(([x, y, i]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, i]) } : l.s));
  if (layers.length > 1) layered++;
  if (layers.some((l) => l.d)) faded++;
}
console.log(`events whose layers fade by distance: ${faded}`);
const containers = layered;
fs.writeFileSync(path.join(root, "events.json"), JSON.stringify(events));
console.log(`HIRC objects ${objects.size}; events with sounds: ${Object.keys(events).length} (${containers} with layers); streamed written ${streamedWritten}; failures`, Object.fromEntries(failures));

// The effects' sounds (fxSounds.json, by guid): each effect's graphic (the effects table's graphicID - effects.json
// beside this folder -, the SDE's graphicFile) read for its AudEventCurves - each key an event at its time, sent from
// its curve's observer - in the curve sets played as it starts (a set named for a stop or an end left out). Where it
// sounds: its emitter's or its event's name saying source / src or dest; else the effect's own place (its
// transformFlags: 2 POSITION_TARGET the target, else the ship).
const buildDir = path.dirname(root);
const effectsFile = path.join(buildDir, "effects.json");
const config = fs.existsSync(path.join(buildDir, "config.json")) ? JSON.parse(fs.readFileSync(path.join(buildDir, "config.json"), "utf8")) : {};
if (fs.existsSync(effectsFile) && config.sde) {
  const table = JSON.parse(fs.readFileSync(effectsFile, "utf8"));
  const fxSounds = {};
  for (const [guid, e] of Object.entries(table)) {
    const file = e.graphicID ? sdeGraphic(config.sde, e.graphicID)?.graphicFile : null;
    if (!file) continue;
    const black = String(file).replace(/\\/g, "/").toLowerCase().replace(/\.red$/, ".black");
    if (!res.has(black)) continue;
    const out = [];
    const walk = (node, setName) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n, setName); return; }
      const name = node.type === "TriCurveSet" ? String(node.name ?? "") : setName;
      if (node.type === "TriCurveSet" && /stop|end/i.test(name)) return;
      if (node.type === "AudEventCurve") {
        const emitter = String(node.sourceTriObserver?.observer?.name ?? "");
        for (const k of node.keys ?? []) {
          if (typeof k?.value !== "string" || !k.value) continue;
          const said = `${emitter} ${k.value}`;
          const at = /dest/i.test(said) ? "target" : /source|src/i.test(said) ? "source" : (e.transformFlags ?? []).includes(2) ? "target" : "source";
          out.push({ event: k.value, time: Number(k.time ?? 0), at });
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "keys" && v && typeof v === "object") walk(v, name);
    };
    try { walk(readBlack(res.read(black), black), ""); } catch { continue; }
    const seen = new Set();
    const unique = out.filter((o) => { const key = `${o.event}|${o.at}|${o.time}`; if (seen.has(key)) return false; seen.add(key); return true; });
    if (unique.length) fxSounds[guid] = unique;
  }
  fs.writeFileSync(path.join(root, "fxSounds.json"), JSON.stringify(fxSounds));
  console.log(`effects with sounds: ${Object.keys(fxSounds).length} of ${Object.keys(table).length}`);
}

// The explosions' sounds (explosionSounds.json). A type's graphic names an explosion bucket (the client's graphicIDs
// table: explosionBucketID); the bucket lists explosions by race ("default" where the race has none), each with its
// chance and scales; each explosion (explosionIDs: its filePath) is a graphic whose AudEventCurves sound as it plays
// (SpaceObjectExplosionManager: the GlobalExplosionEmitter's and the child explosions' emitters, their attenuation
// scaled by the bucket's scales - not applied here). Read with the client's own loaders (scripts/client-built-data.py).
function builtData(loader, resPath) {
  const entry = res.entry(resPath);
  if (!entry) return null;
  const data = path.join(client, "ResFiles", ...entry.blob.split("/"));
  const py = spawnSync(process.env.PYTHON ?? "python", [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "client-built-data.py"), path.join(client, "tq", "bin64"), loader, data], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (py.status !== 0) { console.warn(`${loader}: ${py.stderr || py.error?.message}`); return null; }
  return JSON.parse(py.stdout);
}
const graphicIDs = builtData("graphicIDsLoader", "res:/staticdata/graphicids.fsdbinary");
const buckets = builtData("explosionBucketIDsLoader", "res:/staticdata/explosionbucketids.fsdbinary");
const explosionIDs = builtData("explosionIDsLoader", "res:/staticdata/explosionids.fsdbinary");
const typeGraphicsFile = path.join(buildDir, "typeGraphics.json");
if (graphicIDs && buckets && explosionIDs && fs.existsSync(typeGraphicsFile)) {
  const soundsOfFile = new Map();
  const explosionSounds = (explosionID) => {
    const file = explosionIDs[explosionID]?.filePath;
    if (!file) return [];
    if (soundsOfFile.has(file)) return soundsOfFile.get(file);
    const black = String(file).toLowerCase().replace(/\.red$/, ".black");
    const out = [];
    if (res.has(black)) {
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const n of node) walk(n); return; }
        if (node.type === "AudEventCurve") for (const k of node.keys ?? []) if (typeof k?.value === "string" && k.value) out.push({ event: k.value, time: Number(k.time ?? 0) });
        for (const [k, v] of Object.entries(node)) if (k !== "keys" && v && typeof v === "object") walk(v);
      };
      try { walk(readBlack(res.read(black), black)); } catch { /* none */ }
    }
    const seen = new Set();
    const unique = out.filter((o) => { const key = `${o.event}|${o.time}`; if (seen.has(key)) return false; seen.add(key); return true; });
    soundsOfFile.set(file, unique);
    return unique;
  };
  const outBuckets = {};
  for (const [bucketID, bucket] of Object.entries(buckets)) {
    const races = {};
    for (const [race, list] of Object.entries(bucket.racialExplosions ?? {})) {
      const options = (list ?? []).map((e) => ({ w: Number(e.chanceMultiplier ?? 1), s: explosionSounds(e.explosionID) })).filter((o) => o.s.length);
      if (options.length) races[race] = options;
    }
    if (Object.keys(races).length) outBuckets[bucketID] = races;
  }
  const types = {};
  for (const [typeID, tg] of Object.entries(JSON.parse(fs.readFileSync(typeGraphicsFile, "utf8")))) {
    const bucket = graphicIDs[String(tg.graphicID)]?.explosionBucketID;
    if (bucket !== undefined && outBuckets[bucket]) types[typeID] = [bucket, tg.race ?? null];
  }
  fs.writeFileSync(path.join(root, "explosionSounds.json"), JSON.stringify({ types, buckets: outBuckets }));
  console.log(`explosion buckets with sounds: ${Object.keys(outBuckets).length} of ${Object.keys(buckets).length}; types: ${Object.keys(types).length}`);
}
