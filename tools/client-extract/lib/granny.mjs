// Reader for RAD Granny 3D files (.gr2), file format version 7, as the EVE client ships them.
//
// A Granny file is a header, a table of sections, and per section: its data (stored plain or
// compressed), a table of pointer fixups (where in the section a pointer lives, and which
// section/offset it points at) and a mixed-marshalling table (endian-swap info, unused here:
// EVE's files are little-endian). The root is a type definition plus an object; type definitions
// are themselves data in the file, so the whole tree is read generically by walking them.
//
// Section compression: 0 plain, 2 Oodle1 (oodle1.mjs), 4 BitKnit (bitknit.mjs). Format 4 also
// compresses the fixup and marshalling tables (u32 compressed size, then the data).
// Both pointer layouts occur: 32-bit (magic 29 de 6c c0 ...) and 64-bit (magic e5 9b 49 5e ...).

import { oodle1DecompressSection } from "./oodle1.mjs";

const MAGIC32 = "29de6cc0baa4532b25f5b7a5f666e2ee";
const MAGIC64 = "e59b495e6f631f141e13eba990beedc4";

// granny_member_type
export const MEMBER = {
  End: 0, Inline: 1, Reference: 2, ReferenceToArray: 3, ArrayOfReferences: 4, VariantReference: 5,
  Unsupported: 6, ReferenceToVariantArray: 7, String: 8, Transform: 9, Real32: 10, Int8: 11, UInt8: 12,
  BinormalInt8: 13, NormalUInt8: 14, Int16: 15, UInt16: 16, BinormalInt16: 17, NormalUInt16: 18,
  Int32: 19, UInt32: 20, Real16: 21, EmptyReference: 22,
};
const PRIMITIVE_SIZE = { 10: 4, 11: 1, 12: 1, 13: 1, 14: 1, 15: 2, 16: 2, 17: 2, 18: 2, 19: 4, 20: 4, 21: 2 };

let bitknit = null;
async function bitknitDecoder() {
  if (!bitknit) bitknit = await import("./bitknit.mjs");
  return bitknit;
}

function half(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

export async function readGranny(buf, name = "gr2") {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = Buffer.from(u8.subarray(0, 16)).toString("hex");
  const P = magic === MAGIC64 ? 8 : magic === MAGIC32 ? 4 : 0;
  if (!P) throw new Error(`${name}: not a Granny file this reader knows (magic ${magic})`);
  const version = dv.getUint32(0x20, true);
  if (version !== 7) throw new Error(`${name}: Granny file version ${version}, this reader knows 7`);
  const sectionTable = 0x20 + dv.getUint32(0x2c, true);
  const numSections = dv.getUint32(0x30, true);
  const rootType = [dv.getUint32(0x34, true), dv.getUint32(0x38, true)];
  const rootObject = [dv.getUint32(0x3c, true), dv.getUint32(0x40, true)];
  const typeTag = dv.getUint32(0x44, true);

  const headers = [];
  for (let i = 0; i < numSections; i++) {
    const o = sectionTable + i * 44;
    const f = (k) => dv.getUint32(o + 4 * k, true);
    headers.push({ format: f(0), offset: f(1), size: f(2), expanded: f(3), alignment: f(4), stop0: f(5), stop1: f(6), relocOffset: f(7), relocCount: f(8), marshalOffset: f(9), marshalCount: f(10) });
  }

  const sections = [];
  const fixups = []; // per section: Map(offset -> [targetSection, targetOffset])
  for (const [i, h] of headers.entries()) {
    let data;
    if (!h.size || !h.expanded) data = new Uint8Array(h.expanded);
    else if (h.format === 0) data = u8.slice(h.offset, h.offset + h.expanded);
    else if (h.format === 2) data = oodle1DecompressSection(u8.subarray(h.offset, h.offset + h.size), [h.stop0, h.stop1, h.expanded]);
    else if (h.format === 4) data = (await bitknitDecoder()).decompressBitKnit(u8.subarray(h.offset, h.offset + h.size), h.expanded);
    else throw new Error(`${name}: section ${i} uses compression ${h.format}, which this reader does not decode`);
    if (data.length !== h.expanded) throw new Error(`${name}: section ${i} decoded to ${data.length} bytes, header says ${h.expanded}`);
    sections.push(data);

    let rel = null;
    if (h.relocCount) {
      if (h.format === 4) {
        const csize = dv.getUint32(h.relocOffset, true);
        rel = (await bitknitDecoder()).decompressBitKnit(u8.subarray(h.relocOffset + 4, h.relocOffset + 4 + csize), h.relocCount * 12);
      } else rel = u8.subarray(h.relocOffset, h.relocOffset + h.relocCount * 12);
    }
    const map = new Map();
    if (rel) {
      const rv = new DataView(rel.buffer, rel.byteOffset, rel.byteLength);
      for (let r = 0; r < h.relocCount; r++) {
        const at = rv.getUint32(r * 12, true), ts = rv.getUint32(r * 12 + 4, true), to = rv.getUint32(r * 12 + 8, true);
        if (ts >= numSections) throw new Error(`${name}: fixup in section ${i} points at section ${ts} of ${numSections}`);
        map.set(at, [ts, to]);
      }
    }
    fixups.push(map);
  }
  const views = sections.map((s) => new DataView(s.buffer, s.byteOffset, s.byteLength));

  const ptr = (sec, off) => fixups[sec].get(off) ?? null; // [section, offset] or null
  const u32 = (sec, off) => views[sec].getUint32(off, true);
  const i32 = (sec, off) => views[sec].getInt32(off, true);
  function cstring(at) {
    if (!at) return null;
    const s = sections[at[0]];
    let e = at[1];
    while (e < s.length && s[e] !== 0) e++;
    return Buffer.from(s.subarray(at[1], e)).toString("utf8");
  }

  // ---- type definitions ----
  const MEMBER_SIZE = 4 + P + P + 4 + 12 + P;
  const typeCache = new Map();
  function readType(at) {
    const key = at[0] * 2 ** 32 + at[1];
    if (typeCache.has(key)) return typeCache.get(key);
    const members = [];
    typeCache.set(key, members);
    let off = at[1];
    for (let guard = 0; guard < 10000; guard++, off += MEMBER_SIZE) {
      const type = u32(at[0], off);
      if (type === MEMBER.End) break;
      if (type > 22) throw new Error(`${name}: member type ${type} at section ${at[0]} offset ${off}`);
      const nameAt = ptr(at[0], off + 4);
      const defAt = ptr(at[0], off + 4 + P);
      const arraySize = i32(at[0], off + 4 + 2 * P);
      members.push({ type, name: cstring(nameAt), def: defAt ? readType(defAt) : null, arraySize });
    }
    return members;
  }
  function sizeOf(members) {
    let n = 0;
    for (const m of members) n += memberSize(m);
    return n;
  }
  function memberSize(m) {
    const count = Math.max(m.arraySize, 1);
    switch (m.type) {
      case MEMBER.Inline: return sizeOf(m.def) * count;
      case MEMBER.Reference: case MEMBER.String: case MEMBER.EmptyReference: return P * count;
      case MEMBER.ReferenceToArray: case MEMBER.ArrayOfReferences: return (4 + P) * count;
      case MEMBER.VariantReference: return 2 * P * count;
      case MEMBER.ReferenceToVariantArray: return (P + 4 + P) * count;
      case MEMBER.Transform: return 68 * count;
      default: {
        const s = PRIMITIVE_SIZE[m.type];
        if (!s) throw new Error(`${name}: no size for member type ${m.type}`);
        return s * count;
      }
    }
  }
  const isFlat = (members) => members.every((m) => PRIMITIVE_SIZE[m.type]);

  // ---- objects ----
  function primitive(type, sec, off) {
    const v = views[sec];
    switch (type) {
      case MEMBER.Real32: return v.getFloat32(off, true);
      case MEMBER.Int8: case MEMBER.BinormalInt8: return v.getInt8(off);
      case MEMBER.UInt8: case MEMBER.NormalUInt8: return v.getUint8(off);
      case MEMBER.Int16: case MEMBER.BinormalInt16: return v.getInt16(off, true);
      case MEMBER.UInt16: case MEMBER.NormalUInt16: return v.getUint16(off, true);
      case MEMBER.Int32: return v.getInt32(off, true);
      case MEMBER.UInt32: return v.getUint32(off, true);
      case MEMBER.Real16: return half(v.getUint16(off, true));
    }
  }

  // An array of structs made only of numbers comes back as columns of typed arrays.
  function readColumns(members, at, count) {
    const stride = sizeOf(members);
    const columns = {};
    let rel = 0;
    for (const m of members) {
      const n = Math.max(m.arraySize, 1);
      const out = new Float64Array(count * n);
      const s = PRIMITIVE_SIZE[m.type];
      for (let i = 0; i < count; i++) {
        const base = at[1] + i * stride + rel;
        for (let k = 0; k < n; k++) out[i * n + k] = primitive(m.type, at[0], base + k * s);
      }
      columns[m.name] = { type: m.type, width: n, data: out };
      rel += s * n;
    }
    return { count, stride, columns };
  }

  const objectCache = new Map(); // type (members array) -> Map(address -> object); keeps shared objects shared
  function readObject(members, at) {
    if (!at) return null;
    const key = at[0] * 2 ** 32 + at[1];
    let byType = objectCache.get(members);
    if (!byType) objectCache.set(members, (byType = new Map()));
    if (byType.has(key)) return byType.get(key);
    const obj = {};
    byType.set(key, obj);
    let off = at[1];
    const sec = at[0];
    for (const m of members) {
      const count = Math.max(m.arraySize, 1);
      const one = (o) => readMember(m, sec, o);
      if (m.arraySize > 1) {
        const step = memberSize(m) / count;
        obj[m.name] = Array.from({ length: count }, (_, k) => one(off + k * step));
      } else obj[m.name] = one(off);
      off += memberSize(m);
    }
    return obj;
  }

  function readArrayOf(members, at, count) {
    if (!at || !count) return [];
    if (isFlat(members)) return readColumns(members, at, count);
    const stride = sizeOf(members);
    return Array.from({ length: count }, (_, i) => readObject(members, [at[0], at[1] + i * stride]));
  }

  function readMember(m, sec, off) {
    switch (m.type) {
      case MEMBER.Inline: return readObject(m.def, [sec, off]);
      case MEMBER.Reference: return readObject(m.def, ptr(sec, off));
      case MEMBER.ReferenceToArray: return readArrayOf(m.def, ptr(sec, off + 4), i32(sec, off));
      case MEMBER.ArrayOfReferences: {
        const count = i32(sec, off), at = ptr(sec, off + 4);
        if (!at || !count) return [];
        return Array.from({ length: count }, (_, i) => readObject(m.def, ptr(at[0], at[1] + i * P)));
      }
      case MEMBER.VariantReference: {
        const t = ptr(sec, off), o = ptr(sec, off + P);
        return t && o ? readObject(readType(t), o) : null;
      }
      case MEMBER.ReferenceToVariantArray: {
        const t = ptr(sec, off), count = i32(sec, off + P), at = ptr(sec, off + P + 4);
        return t ? readArrayOf(readType(t), at, count) : [];
      }
      case MEMBER.String: return cstring(ptr(sec, off));
      case MEMBER.Transform: {
        const v = views[sec];
        const f = (k) => v.getFloat32(off + 4 + 4 * k, true);
        return { flags: v.getUint32(off, true), position: [f(0), f(1), f(2)], orientation: [f(3), f(4), f(5), f(6)], scaleShear: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => f(7 + k)) };
      }
      case MEMBER.EmptyReference: return null;
      case MEMBER.Unsupported: return undefined;
      default: return primitive(m.type, sec, off);
    }
  }

  const root = readObject(readType(rootType), rootObject);
  return { pointerSize: P, typeTag, headers, root };
}
