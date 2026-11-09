// Reader for CCP Blue's binary object files (.black), as the EVE client (build 3396210)
// ships them. Follows blue.dll's BlackReader (src/BlackReader.cpp) and IRootReaderBase.
//
// Layout (little-endian):
//   u32 magic 0xB1ACF11E, u32 version 1
//   string table:      u32 byte length (counting the u16), u16 count, count NUL-terminated strings
//   wide string table: the same with UTF-16 strings
//   data: one object (ReadIRootClass)
// An object is i32 id (0 = none; an id seen before = the same object again), u32 body size,
// then the body: u16 class name, then members up to the end of the body. A member is a u16
// attribute name and a value. The file does not tag values: the value's encoding follows the
// attribute's declared type in the class, so the class tables in blackSchema.mjs are needed.
// Strings are u16 indices into the string tables.
//
// readBlack(buffer, name?) returns plain objects shaped like the client's YAML (.red) form:
// { type: "ClassName", attr: value, ... }. Lists are arrays, dicts are objects, float arrays
// are arrays of numbers, bools are booleans, binary blocks are Uint8Arrays, and a structure
// list is { structure: [[field, code, offset], ...], items: [[value, ...], ...] }.
// An object referenced twice is the same JS object both times. An attribute named "type"
// (EveConnector, TriTextureRes) is returned as "attr:type".

import { CLASSES, STRUCTS } from "./blackSchema.mjs";

const MAGIC = 0xb1acf11e;
const VERSION = 1;

class BlackError extends Error {}

// Per-class attribute decoders, parsed from the schema on first use.
const classCache = new Map();
function classInfo(name) {
  let info = classCache.get(name);
  if (info) return info;
  const spec = CLASSES[name];
  if (spec === undefined) return null;
  info = new Map();
  const parts = spec ? spec.split(" ") : [];
  for (let k = 0; k < parts.length; k += 2) {
    const attr = parts[k];
    const code = parts[k + 1];
    // "type" holds the class name, so an attribute named "type" goes to "attr:type"
    const a = { key: attr === "type" ? "attr:type" : attr, kind: code[0], count: 0, struct: null };
    if (a.kind === "F") a.count = code === "F?" ? -1 : Number(code.slice(1));
    if (a.kind === "T") a.struct = code === "T?" ? null : STRUCTS[`${name}.${attr}`];
    info.set(attr, a);
  }
  classCache.set(name, info);
  return info;
}

export function readBlack(buffer, name = "<buffer>") {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  let pos = 0;

  const fail = (msg) => {
    throw new BlackError(`${name}: ${msg} (at byte ${pos})`);
  };
  const need = (n) => {
    if (pos + n > end) fail("reading out of bounds");
  };

  // FUN_1801537e0: magic and version
  need(8);
  if (view.getUint32(0, true) !== MAGIC) fail("not a .black file (bad magic)");
  if (view.getUint32(4, true) !== VERSION) fail(`unsupported version ${view.getUint32(4, true)}`);
  pos = 8;

  // FUN_1801558d0 / FUN_180155ab0: string tables; strings must end exactly at the table's end
  function readTable(wide) {
    need(4);
    const len = view.getUint32(pos, true);
    if (len < 2 || pos + 4 + len > end) fail(`${wide ? "wide " : ""}string table is invalid`);
    const count = view.getUint16(pos + 4, true);
    let p = pos + 6;
    const stop = pos + 4 + len;
    const out = new Array(count);
    const dec = new TextDecoder(wide ? "utf-16le" : "utf-8");
    for (let k = 0; k < count; k++) {
      let q = p;
      if (wide) while (q + 1 < stop && view.getUint16(q, true) !== 0) q += 2;
      else while (q < stop && bytes[q] !== 0) q++;
      if (q >= stop) fail(`${wide ? "wide " : ""}string table is invalid`);
      out[k] = dec.decode(bytes.subarray(p, q));
      p = q + (wide ? 2 : 1);
    }
    if (p !== stop) fail(`${wide ? "wide " : ""}string table is invalid`);
    pos = stop;
    return out;
  }
  const strings = readTable(false);
  const wstrings = readTable(true);

  // FUN_180153d60 / FUN_180153de0 etc.: primitive reads with bounds checks
  const u8 = () => {
    need(1);
    return bytes[pos++];
  };
  const i16 = () => {
    need(2);
    const v = view.getInt16(pos, true);
    pos += 2;
    return v;
  };
  const i32 = () => {
    need(4);
    const v = view.getInt32(pos, true);
    pos += 4;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const f32 = () => {
    need(4);
    const v = view.getFloat32(pos, true);
    pos += 4;
    return v;
  };
  const f64 = () => {
    need(8);
    const v = view.getFloat64(pos, true);
    pos += 8;
    return v;
  };
  const i64 = () => {
    need(8);
    const v = view.getBigInt64(pos, true);
    pos += 8;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  // FUN_180154cb0 / FUN_180154d30: u16 string index
  const str = () => {
    need(2);
    const k = view.getUint16(pos, true);
    pos += 2;
    if (k >= strings.length) fail("invalid string index");
    return strings[k];
  };
  const wstr = () => {
    need(2);
    const k = view.getUint16(pos, true);
    pos += 2;
    if (k >= wstrings.length) fail("invalid wide string index");
    return wstrings[k];
  };

  const objects = new Map();

  // FUN_1801543a0 ReadIRootClass
  function readObject() {
    const id = i32();
    if (id === 0) return null;
    const known = objects.get(id);
    if (known) return known;
    const size = u32();
    const bodyEnd = pos + size;
    if (bodyEnd > end) fail(`object ${id} runs past the end of the file`);
    const cls = str();
    const obj = { type: cls };
    readMembers(obj, cls, bodyEnd);
    objects.set(id, obj);
    return obj;
  }

  // FUN_1801549b0 ReadMembers; each member through FUN_1802d4790 and the type table at 0x180b03b60
  function readMembers(obj, cls, bodyEnd) {
    const info = classInfo(cls);
    if (!info) fail(`unknown class ${cls}`);
    while (pos < bodyEnd) {
      const attr = str();
      const a = info.get(attr);
      if (!a) fail(`unknown attribute ${cls}.${attr}`);
      obj[a.key] = readValue(a, cls, attr);
    }
    if (pos !== bodyEnd) fail(`${cls} body overran its size by ${pos - bodyEnd} bytes`);
  }

  function readValue(a, cls, attr) {
    switch (a.kind) {
      case "i": return i32();
      case "h": return i16();
      case "c": return u8();
      case "b": return u8() !== 0;
      case "f": return f32();
      case "d": return f64();
      case "q": return i64();
      case "s": return str();
      case "w": return wstr();
      case "F": {
        // FUN_180154c70: count = attribute byte size / 4
        if (a.count < 0) fail(`float-array length of ${cls}.${attr} is not known`);
        const out = new Array(a.count);
        for (let k = 0; k < a.count; k++) out[k] = f32();
        return out;
      }
      case "p": return readObject();
      case "L": return readList();
      case "D": return readDict();
      case "O": return readInline();
      case "T": return readStructureList(a.struct, cls, attr);
      case "X": {
        // FUN_1801554c0 ReadBinaryBlock: i32 length, bytes
        const n = i32();
        if (n < 0) fail(`negative binary block length in ${cls}.${attr}`);
        need(n);
        const out = new Uint8Array(bytes.subarray(pos, pos + n));
        pos += n;
        return out;
      }
    }
    return fail(`unsupported attribute code ${a.kind} for ${cls}.${attr}`);
  }

  // FUN_180154db0 ReadList: i32 count, objects; null entries are dropped
  function readList() {
    const n = i32();
    const out = [];
    for (let k = 0; k < n; k++) {
      const o = readObject();
      if (o !== null) out.push(o);
    }
    return out;
  }

  // FUN_180154f70 ReadDict: i32 count, (string key, object) pairs; null values are dropped
  function readDict() {
    const n = i32();
    const out = {};
    for (let k = 0; k < n; k++) {
      const key = str();
      const o = readObject();
      if (o !== null) Object.defineProperty(out, key, { value: o, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  // FUN_180155630 ReadIRoot: an object held in place (no id), u32 size, class name, members
  function readInline() {
    const size = u32();
    const bodyEnd = pos + size;
    if (bodyEnd > end) fail("inline object runs past the end of the file");
    const cls = str();
    const obj = { type: cls };
    readMembers(obj, cls, bodyEnd);
    return obj;
  }

  // FUN_180155330 ReadStructureList: i32 count, u16 stride, raw rows; string fields hold a
  // u16 string index in an 8-byte slot (FUN_1801550e0 PatchStringsInStructureList)
  function readStructureList(st, cls, attr) {
    if (!st) fail(`structure layout of ${cls}.${attr} is not known`);
    const count = i32();
    need(2);
    const stride = view.getUint16(pos, true);
    pos += 2;
    if (stride !== st.stride) fail(`${cls}.${attr}: structure stride ${stride} in file, expected ${st.stride}`);
    need(count * stride);
    const items = new Array(count);
    for (let r = 0; r < count; r++) {
      const base = pos + r * stride;
      const row = new Array(st.fields.length);
      for (let f = 0; f < st.fields.length; f++) {
        const [, code, off] = st.fields[f];
        const n = ((code >> 5) & 15) + 1;
        if (n === 1) row[f] = structField(code, base + off, cls, attr);
        else {
          const kind = code & 7;
          const w = kind === 5 ? 8 : kind === 0 ? 1 : kind === 1 ? 2 : 4;
          const vals = new Array(n);
          for (let e = 0; e < n; e++) vals[e] = structField(code, base + off + e * w, cls, attr);
          row[f] = vals;
        }
      }
      items[r] = row;
    }
    pos += count * stride;
    return { structure: st.fields.map((f) => f.slice()), items };
  }

  function structField(code, at, cls, attr) {
    const unsigned = (code & 8) !== 0;
    switch (code & 7) {
      case 0: return unsigned ? view.getUint8(at) : view.getInt8(at);
      case 1: return unsigned ? view.getUint16(at, true) : view.getInt16(at, true);
      case 2: return unsigned ? view.getUint32(at, true) : view.getInt32(at, true);
      case 4: return view.getFloat32(at, true);
      case 5: {
        const k = view.getUint16(at, true);
        if (k >= strings.length) fail(`invalid string index in ${cls}.${attr}`);
        return strings[k];
      }
    }
    return fail(`unsupported structure field code ${code} in ${cls}.${attr}`);
  }

  // CreateObjectHelper reads the root object; the data must be used up exactly
  const root = readObject();
  if (pos !== end) fail(`${end - pos} bytes left after the root object`);
  return root;
}

export { BlackError };
