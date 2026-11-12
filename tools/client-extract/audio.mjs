// The client's audio as files a browser plays: a soundbank's embedded sounds (its DIDX index over its DATA chunk) and
// streamed .wem files, Wwise Vorbis rebuilt as Ogg Vorbis (lib/wwiseVorbis.mjs) with the codebook library read out of
// the client's own Wwise engine (tq/bin64/_audio2.dll). Written to _local/client-assets/<build>/audio/<bank>/<id>.ogg.
//
//   node tools/client-extract/audio.mjs --client "<EVE install>" --bank interface [--bank common ...] [--limit N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openResFiles, clientBuild, findClient } from "./lib/resfiles.mjs";
import { wemToOgg, codebookLibrary, findCodebookLibrary } from "./lib/wwiseVorbis.mjs";

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
for (const bank of all("--bank")) {
  const bnk = res.read(`res:/audio/essential_media/${bank}.bnk`);
  const { sounds } = readBank(bnk);
  const dir = path.join(root, bank);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sounds.slice(0, limit)) {
    try {
      const { ogg } = wemToOgg(s.bytes, library);
      fs.writeFileSync(path.join(dir, `${s.id}.ogg`), ogg);
      written++;
    } catch (e) {
      failed++;
      const m = e instanceof Error ? e.message : String(e);
      failures.set(m, (failures.get(m) ?? 0) + 1);
    }
  }
  console.log(`${bank}: ${sounds.length} embedded sounds`);
}
console.log(`written ${written}, failed ${failed}`, Object.fromEntries(failures));

// The events (HIRC across every bank, bank version 150): an Event (type 4: its id the FNV-1 hash of its lowercase
// name; a u8 count of action ids) whose Play action (type 3, action type 0x0403: its target id) plays a Sound (type 2:
// AkBankSourceData - plugin id, stream type, source id) whose source is one written above. events.json maps the
// event's hash to "<bank>/<source id>" for the page (play/uiAudio.ts); containers and streamed sources come later.
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
  for (const f of fs.readdirSync(path.join(root, bank.name))) if (f.endsWith(".ogg")) sourceBank.set(Number(f.slice(0, -4)), bank.name);
}
const events = {};
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
for (const [id, o] of objects) {
  if (o.type !== 4) continue;
  const n = o.body[4];
  for (let k = 0; k < n; k++) {
    const action = objects.get(u32(o.body, 5 + k * 4));
    if (!action || action.type !== 3 || (action.body[4] | (action.body[5] << 8)) !== 0x0403) continue;
    const sound = objects.get(u32(action.body, 6));
    if (!sound || sound.type !== 2) continue;
    const source = u32(sound.body, 9);
    const bank = sourceBank.get(source);
    if (bank) { events[id] = `${bank}/${source}`; break; }
  }
}
fs.writeFileSync(path.join(root, "events.json"), JSON.stringify(events));
console.log(`HIRC objects ${objects.size}; events playing a written sound: ${Object.keys(events).length}`);
