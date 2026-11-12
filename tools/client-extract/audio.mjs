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
function sourcesOf(id, depth = 0) {
  const o = objects.get(id);
  if (!o || depth > 6) return [];
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
const events = {};
let containers = 0;
for (const [id, o] of objects) {
  if (o.type !== 4) continue;
  const n = o.body[4];
  for (let k = 0; k < n; k++) {
    const action = objects.get(u32(o.body, 5 + k * 4));
    if (!action || action.type !== 3 || u16(action.body, 4) !== 0x0403) continue;
    const target = u32(action.body, 6);
    const sounds = [...new Set(sourcesOf(target))];
    if (sounds.length) { events[id] = sounds; if (objects.get(target)?.type === 5) containers++; break; }
  }
}
fs.writeFileSync(path.join(root, "events.json"), JSON.stringify(events));
console.log(`HIRC objects ${objects.size}; events with sounds: ${Object.keys(events).length} (${containers} through a container); streamed written ${streamedWritten}; failures`, Object.fromEntries(failures));
