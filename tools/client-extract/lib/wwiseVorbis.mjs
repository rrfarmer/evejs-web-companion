// Audiokinetic Wwise Vorbis (.wem, format tag 0xFFFF) to a standard Ogg Vorbis stream a browser decodes.
//
// Wwise stores Vorbis with its three headers stripped: no identification or comment packet, a setup packet whose
// codebooks are 10-bit ids into the engine's codebook library (the aoTuV 6.03 books Wwise ships; the client links
// Wwise 2023.1 into tq/bin64/_audio2.dll, where the library is a table of 599 pointers in .rdata) and whose floor,
// residue, mapping and mode records leave out the fields that never vary; and audio packets with a 2-byte size
// header each, their packet-type bit and window flags dropped. This rebuilds all of it as the Vorbis I spec lays the
// stream out: the identification header from the fmt chunk, a comment header, the setup header with every codebook
// unpacked from the library, each audio packet with its type bit and (for long blocks) its previous / next window
// flags put back, and the Ogg pages around them with granule positions counted from the block sizes.

/** LSB-first bit reader (Vorbis's packing). */
class BitReader {
  constructor(bytes, start = 0, end = bytes.length) { this.b = bytes; this.p = start * 8; this.end = end * 8; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.p >= this.end) throw new Error("read past the packet's end");
      v += ((this.b[this.p >> 3] >> (this.p & 7)) & 1) * 2 ** i;
      this.p++;
    }
    return v;
  }
}

/** LSB-first bit writer. */
class BitWriter {
  constructor() { this.bytes = []; this.bit = 0; this.cur = 0; }
  write(v, n) {
    for (let i = 0; i < n; i++) {
      const bit = Math.floor(v / 2 ** i) % 2;
      this.cur |= bit << this.bit;
      if (++this.bit === 8) { this.bytes.push(this.cur); this.bit = 0; this.cur = 0; }
    }
  }
  writeString(s) { for (const c of s) this.write(c.charCodeAt(0), 8); }
  done() { if (this.bit > 0) { this.bytes.push(this.cur); this.bit = 0; this.cur = 0; } return Uint8Array.from(this.bytes); }
}

const ilog = (v) => { let r = 0; while (v > 0) { r++; v = Math.floor(v / 2); } return r; };

/** Vorbis I 9.2.3 lookup1_values: the greatest n with n^dimensions <= entries. */
function quantvals(entries, dimensions) {
  let vals = Math.floor(Math.pow(entries, 1 / dimensions));
  while (Math.pow(vals + 1, dimensions) <= entries) vals++;
  while (vals > 0 && Math.pow(vals, dimensions) > entries) vals--;
  return vals;
}

/**
 * The codebook library: Uint8Array views of each packed codebook, by id. `table` is the DLL's bytes, `pointers` the
 * library's entries as file offsets (in order).
 */
export function codebookLibrary(dll, offsets) {
  return offsets.map((start, i) => dll.subarray(start, i + 1 < offsets.length ? offsets[i + 1] : start + 4096));
}

/** One packed library codebook written out as a full Vorbis codebook (Vorbis I 3.2.1). */
function rebuildCodebook(packed, w) {
  const r = new BitReader(packed);
  const dimensions = r.read(4), entries = r.read(14);
  w.write(0x564342, 24); w.write(dimensions, 16); w.write(entries, 24);
  const ordered = r.read(1);
  w.write(ordered, 1);
  if (ordered) {
    w.write(r.read(5), 5);
    for (let current = 0; current < entries;) {
      const bits = ilog(entries - current);
      const number = r.read(bits);
      w.write(number, bits);
      current += number;
    }
  } else {
    const lengthBits = r.read(3), sparse = r.read(1);
    if (lengthBits === 0 || lengthBits > 5) throw new Error("codebook: bad codeword length size");
    w.write(sparse, 1);
    for (let i = 0; i < entries; i++) {
      let present = 1;
      if (sparse) { present = r.read(1); w.write(present, 1); }
      if (present) w.write(r.read(lengthBits), 5);
    }
  }
  const lookup = r.read(1);
  w.write(lookup, 4);
  if (lookup === 1) {
    w.write(r.read(32), 32); w.write(r.read(32), 32);
    const valueLength = r.read(4); w.write(valueLength, 4);
    w.write(r.read(1), 1);
    const n = quantvals(entries, dimensions);
    for (let i = 0; i < n; i++) w.write(r.read(valueLength + 1), valueLength + 1);
  } else if (lookup !== 0) throw new Error("codebook: lookup type 2 is not in the library");
}

function riffChunks(wem) {
  const dv = new DataView(wem.buffer, wem.byteOffset, wem.byteLength);
  if (String.fromCharCode(...wem.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...wem.subarray(8, 12)) !== "WAVE") throw new Error("not a RIFF WAVE");
  const chunks = {};
  for (let p = 12; p + 8 <= wem.length;) {
    const tag = String.fromCharCode(...wem.subarray(p, p + 4));
    const size = dv.getUint32(p + 4, true);
    chunks[tag] = { offset: p + 8, size };
    p += 8 + size + (size & 1);
  }
  return { dv, chunks };
}

/** CRC-32 of Ogg (polynomial 0x04c11db7, unreflected, from 0). */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 255]) >>> 0;
  return crc;
}

/** Ogg pages for packets: [packet, granule, flags] - each packet starts a page (laced over more where it is long). */
function oggPages(packets, serial) {
  const out = [];
  let seq = 0;
  for (const { data, granule, bos, eos } of packets) {
    let pos = 0, first = true;
    do {
      const lacing = [];
      let take = 0;
      while (lacing.length < 255 && pos + take <= data.length) {
        const left = data.length - pos - take;
        const seg = Math.min(255, left);
        lacing.push(seg);
        take += seg;
        if (seg < 255) break;
      }
      const complete = pos + take >= data.length && lacing[lacing.length - 1] < 255;
      const header = new Uint8Array(27 + lacing.length);
      const dv = new DataView(header.buffer);
      header.set([0x4f, 0x67, 0x67, 0x53], 0);
      header[5] = (first ? 0 : 1) | (bos && first ? 2 : 0) | (eos && complete ? 4 : 0);
      const g = complete ? BigInt(granule) : -1n;
      dv.setBigInt64(6, g, true);
      dv.setUint32(14, serial, true);
      dv.setUint32(18, seq++, true);
      header[26] = lacing.length;
      header.set(lacing, 27);
      const page = new Uint8Array(header.length + take);
      page.set(header, 0);
      page.set(data.subarray(pos, pos + take), header.length);
      new DataView(page.buffer).setUint32(22, oggCrc(page), true);
      out.push(page);
      pos += take;
      first = false;
      if (complete) break;
    } while (true);
  }
  const total = out.reduce((n, p) => n + p.length, 0);
  const ogg = new Uint8Array(total);
  let o = 0;
  for (const p of out) { ogg.set(p, o); o += p.length; }
  return ogg;
}

/** A Wwise Vorbis .wem (the 0x42 fmt chunk of Wwise 2015+, its vorb data inside the fmt) as an Ogg Vorbis file. */
export function wemToOgg(wem, library, { vendor = "evejs-web-companion" } = {}) {
  const { dv, chunks } = riffChunks(wem);
  const fmt = chunks["fmt "], data = chunks.data;
  if (!fmt || !data) throw new Error("no fmt or data chunk");
  if (dv.getUint16(fmt.offset, true) !== 0xffff) throw new Error(`not Wwise Vorbis (format 0x${dv.getUint16(fmt.offset, true).toString(16)})`);
  if (fmt.size !== 0x42) throw new Error(`fmt chunk of ${fmt.size} bytes: only the 0x42 layout is handled`);
  const channels = dv.getUint16(fmt.offset + 2, true);
  const sampleRate = dv.getUint32(fmt.offset + 4, true);
  const avgBytes = dv.getUint32(fmt.offset + 8, true);
  const vorb = fmt.offset + 0x18;
  const sampleCount = dv.getUint32(vorb, true);
  const modSignal = dv.getUint32(vorb + 4, true);
  // (0x4A, 0x4B, 0x69, 0x70 mark packets left whole; anything else, the type and window bits stripped)
  const modPackets = ![0x4a, 0x4b, 0x69, 0x70].includes(modSignal);
  const setupOffset = dv.getUint32(vorb + 0x10, true);
  const audioOffset = dv.getUint32(vorb + 0x14, true);
  const block0 = wem[vorb + 0x28], block1 = wem[vorb + 0x29];

  // identification header (Vorbis I 4.2.2)
  const id = new BitWriter();
  id.write(1, 8); id.writeString("vorbis"); id.write(0, 32); id.write(channels, 8); id.write(sampleRate, 32);
  id.write(0, 32); id.write(avgBytes * 8, 32); id.write(0, 32); id.write(block0, 4); id.write(block1, 4); id.write(1, 1);
  // comment header (4.2.3)
  const comment = new BitWriter();
  comment.write(3, 8); comment.writeString("vorbis"); comment.write(vendor.length, 32); comment.writeString(vendor);
  comment.write(0, 32); comment.write(1, 1);

  // setup header (4.2.4) from Wwise's
  const setupStart = data.offset + setupOffset;
  const setupSize = dv.getUint16(setupStart, true);
  const r = new BitReader(wem, setupStart + 2, setupStart + 2 + setupSize);
  const w = new BitWriter();
  w.write(5, 8); w.writeString("vorbis");
  const codebookCount = r.read(8) + 1;
  w.write(codebookCount - 1, 8);
  for (let i = 0; i < codebookCount; i++) {
    const idx = r.read(10);
    if (idx >= library.length) throw new Error(`codebook id ${idx} beyond the library`);
    rebuildCodebook(library[idx], w);
  }
  w.write(0, 6); w.write(0, 16); // time domain transforms: one, a placeholder
  const floorCount = r.read(6) + 1;
  w.write(floorCount - 1, 6);
  for (let i = 0; i < floorCount; i++) {
    w.write(1, 16); // floor type 1 (the only one Wwise writes)
    const partitions = r.read(5); w.write(partitions, 5);
    const classList = [];
    let maxClass = -1;
    for (let j = 0; j < partitions; j++) { const c = r.read(4); w.write(c, 4); classList.push(c); maxClass = Math.max(maxClass, c); }
    const classDims = [];
    for (let c = 0; c <= maxClass; c++) {
      const dims = r.read(3) + 1; w.write(dims - 1, 3); classDims.push(dims);
      const subclasses = r.read(2); w.write(subclasses, 2);
      if (subclasses) { const master = r.read(8); w.write(master, 8); }
      for (let k = 0; k < 1 << subclasses; k++) w.write(r.read(8), 8);
    }
    w.write(r.read(2), 2);
    const rangeBits = r.read(4); w.write(rangeBits, 4);
    for (const c of classList) for (let k = 0; k < classDims[c]; k++) w.write(r.read(rangeBits), rangeBits);
  }
  const residueCount = r.read(6) + 1;
  w.write(residueCount - 1, 6);
  for (let i = 0; i < residueCount; i++) {
    const type = r.read(2); w.write(type, 16);
    w.write(r.read(24), 24); w.write(r.read(24), 24); w.write(r.read(24), 24);
    const classifications = r.read(6) + 1; w.write(classifications - 1, 6);
    w.write(r.read(8), 8);
    const cascade = [];
    for (let c = 0; c < classifications; c++) {
      const low = r.read(3); w.write(low, 3);
      const flag = r.read(1); w.write(flag, 1);
      let high = 0;
      if (flag) { high = r.read(5); w.write(high, 5); }
      cascade.push(high * 8 + low);
    }
    for (const bits of cascade) for (let k = 0; k < 8; k++) if (bits & (1 << k)) w.write(r.read(8), 8);
  }
  const mappingCount = r.read(6) + 1;
  w.write(mappingCount - 1, 6);
  for (let i = 0; i < mappingCount; i++) {
    w.write(0, 16); // mapping type 0
    const submapsFlag = r.read(1); w.write(submapsFlag, 1);
    let submaps = 1;
    if (submapsFlag) { submaps = r.read(4) + 1; w.write(submaps - 1, 4); }
    const polar = r.read(1); w.write(polar, 1);
    if (polar) {
      const steps = r.read(8) + 1; w.write(steps - 1, 8);
      const bits = ilog(channels - 1);
      for (let s = 0; s < steps; s++) { w.write(r.read(bits), bits); w.write(r.read(bits), bits); }
    }
    const reserved = r.read(2); if (reserved !== 0) throw new Error("mapping reserved bits not zero");
    w.write(0, 2);
    if (submaps > 1) for (let c = 0; c < channels; c++) w.write(r.read(4), 4);
    for (let s = 0; s < submaps; s++) { w.write(r.read(8), 8); w.write(r.read(8), 8); w.write(r.read(8), 8); }
  }
  const modeCount = r.read(6) + 1;
  w.write(modeCount - 1, 6);
  const modeBlockflag = [];
  for (let i = 0; i < modeCount; i++) {
    const flag = r.read(1); w.write(flag, 1); modeBlockflag.push(flag);
    w.write(0, 16); w.write(0, 16); w.write(r.read(8), 8);
  }
  w.write(1, 1);
  const modeBits = ilog(modeCount - 1);

  // audio packets
  const packets = [
    { data: id.done(), granule: 0, bos: true },
    { data: comment.done(), granule: 0 },
    { data: w.done(), granule: 0 },
  ];
  const offsets = [];
  for (let p = data.offset + audioOffset; p + 2 <= data.offset + data.size;) {
    const size = dv.getUint16(p, true);
    if (p + 2 + size > data.offset + data.size) break;
    offsets.push([p + 2, size]);
    p += 2 + size;
  }
  const blockSize = [1 << block0, 1 << block1];
  let granule = 0, prevBlock = null, prevFlag = 0;
  offsets.forEach(([start, size], n) => {
    let out;
    let flag;
    if (modPackets) {
      const pr = new BitReader(wem, start, start + size);
      const pw = new BitWriter();
      pw.write(0, 1);
      const mode = pr.read(modeBits);
      pw.write(mode, modeBits);
      const remainder = pr.read(8 - modeBits);
      flag = modeBlockflag[mode] ?? 0;
      if (flag) {
        let nextFlag = 0;
        const next = offsets[n + 1];
        if (next && next[1] > 0) {
          const nr = new BitReader(wem, next[0], next[0] + next[1]);
          nextFlag = modeBlockflag[nr.read(modeBits)] ?? 0;
        }
        pw.write(prevFlag, 1);
        pw.write(nextFlag, 1);
      }
      pw.write(remainder, 8 - modeBits);
      for (let i = 1; i < size; i++) pw.write(wem[start + i], 8);
      out = pw.done();
    } else {
      out = wem.slice(start, start + size);
      const pr = new BitReader(wem, start, start + size);
      pr.read(1);
      flag = modeBlockflag[pr.read(modeBits)] ?? 0;
    }
    prevFlag = flag;
    // Vorbis I 4.3.8: each packet after the first adds (previous block / 4 + this block / 4) samples
    const cur = blockSize[flag];
    if (prevBlock !== null) granule += prevBlock / 4 + cur / 4;
    prevBlock = cur;
    const last = n === offsets.length - 1;
    packets.push({ data: out, granule: last ? Math.min(granule, sampleCount) : granule, eos: last });
  });
  return { ogg: oggPages(packets, 0x45564573), channels, sampleRate, sampleCount, packets: offsets.length };
}

/** The codebook library's offsets in the client's _audio2.dll: the run of 599 pointers into .rdata. */
export function findCodebookLibrary(dll) {
  const dv = new DataView(dll.buffer, dll.byteOffset, dll.byteLength);
  const pe = dv.getUint32(0x3c, true);
  const sections = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const base = dv.getBigUint64(pe + 24 + 24, true);
  const secs = [];
  for (let i = 0; i < sections; i++) {
    const o = pe + 24 + optSize + i * 40;
    secs.push({ va: dv.getUint32(o + 12, true), vsize: dv.getUint32(o + 8, true), raw: dv.getUint32(o + 20, true), rsize: dv.getUint32(o + 16, true) });
  }
  const fileOffset = (va) => {
    const rva = Number(va - base);
    const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rsize));
    return s ? s.raw + rva - s.va : -1;
  };
  for (let i = 0; i + 8 <= dll.length; i += 8) {
    let n = 1;
    let prev = dv.getBigUint64(i, true);
    if (prev < base || prev > base + 0x10000000n) continue;
    while (i + (n + 1) * 8 <= dll.length) {
      const v = dv.getBigUint64(i + n * 8, true);
      if (v <= prev || v - prev > 4000n) break;
      prev = v; n++;
    }
    if (n >= 500) {
      const ptrs = [];
      for (let k = 0; k < n; k++) ptrs.push(fileOffset(dv.getBigUint64(i + k * 8, true)));
      return ptrs;
    }
    i += (n - 1) * 8;
  }
  throw new Error("no codebook library in the DLL");
}
