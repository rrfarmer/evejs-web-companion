// Granny 3D "BitKnit" decompression (section compression formats 3 and 4).
//
// Translated from the EVE client's own copy of the Granny runtime, _trinity_dx11.dll build 3396210,
// via Ghidra pseudo-C. Function names below are that binary's addresses.
//
// The scheme: LZ77 in 64 KiB chunks, each chunk either raw or coded with two interleaved rANS
// states (15-bit probabilities, 16-bit renormalisation words) and adaptive models. Four literal /
// length models and four distance models are chosen by output position & 3; literals are coded
// as a delta against the byte one "last offset" back; distances use an 8-entry recent-offset cache.
//
// How the file reader uses it (FUN_18102e810, FUN_18102e700):
//   format 4 section data, relocations and mixed-marshalling tables: one stream, decoded through the
//     streaming path FUN_181031680 / FUN_181031d20 / FUN_181031ec0 (= FUN_181065a30 init,
//     FUN_181062660 feeds, FUN_181065bb0 finish). That is the same decoder as FUN_181065930, so
//     decompressBitKnit() covers it. Tables are stored as u32 compressedSize + compressed bytes.
//   format 3 section data: FUN_181019270, three streams split at the header's first16/first8 stops.
//     Format 3 tables are read uncompressed (FUN_181031f70 gives format 3 no flags).

const MAGIC = 0x75b1; // DAT_1811c1c0c

// Adaptive frequency model (literal/length: FUN_1810613b0, distance: FUN_1810615d0,
// offset bit count: FUN_1810614c0; rescales FUN_181060b90 / FUN_181060e20 / FUN_181060ce0).
class Model {
  constructor(nsym, shift, bonus, cdfInit) {
    this.nsym = nsym;
    this.shift = shift; // lookup table index = (x & 0x7fff) >> shift
    this.bonus = bonus; // extra weight given to the symbol that triggers a rescale
    this.cdf = new Uint16Array(nsym + 1);
    for (let k = 0; k <= nsym; k++) this.cdf[k] = cdfInit(k);
    this.freq = new Uint16Array(nsym).fill(1);
    this.lookup = new Uint16Array((0x8000 >> shift) + 1);
    this.counter = 0x400;
    this.buildLookup();
  }

  // lookup[j] = first symbol whose (cdf[s+1]-1) >> shift reaches j
  buildLookup() {
    const { cdf, lookup, shift, nsym } = this;
    let pos = 0;
    for (let s = 0; s < nsym; s++) {
      const end = (cdf[s + 1] - 1) >> shift;
      while (pos <= end) lookup[pos++] = s;
    }
  }

  // FUN_181060b90 / FUN_181060e20 / FUN_181060ce0
  rescale(sym) {
    const { cdf, freq } = this;
    this.counter = 0x400;
    freq[sym] += this.bonus;
    let cum = 0;
    for (let i = 0; i < this.nsym; i++) {
      cum += freq[i];
      freq[i] = 1;
      const old = cdf[i + 1];
      cdf[i + 1] = old + ((cum - old) >> 1);
    }
    this.buildLookup();
  }

  // symbol decode inlined in FUN_181061bf0; x = state & 0x7fff
  find(x) {
    const cdf = this.cdf;
    let s = this.lookup[x >> this.shift];
    while (cdf[s + 1] <= x) s++;
    return s;
  }

  update(sym) {
    this.freq[sym] += 0x1f;
    if (--this.counter === 0) this.rescale(sym);
  }
}

// FUN_181064e30 + FUN_181064f10: 4 literal/length models, 4 distance models, 1 offset-bits model.
function makeModels() {
  const lit = [], dist = [];
  for (let i = 0; i < 4; i++) {
    // 264 symbols share 32732, the other 36 get 1 each
    lit.push(new Model(300, 6, 0x2d5, (k) => (k < 264 ? Math.floor((k * 0x7fdc) / 0x108) : k + 0x7ed4)));
  }
  for (let i = 0; i < 4; i++) dist.push(new Model(40, 9, 0x3d9, (k) => Math.floor((k * 0x8000) / 40)));
  const bits = new Model(21, 9, 0x3ec, (k) => Math.floor((k * 0x8000) / 21));
  return { lit, dist, bits };
}

// One BitKnit stream: FUN_181065930 (and FUN_181065a90), i.e. FUN_181062450 driving
// FUN_181061bf0, run over the whole input at once. Returns the number of source bytes consumed.
// Reads past srcEnd see zeros, as the finishing feed of 16 zero bytes does in FUN_181065bb0.
function decodeStream(src, srcStart, srcEnd, dst, dstStart, dstEnd) {
  if (dstEnd < dstStart) throw new Error("bitknit: negative output size");
  const rd = (p) => (p + 1 < srcEnd ? src[p] | (src[p + 1] << 8) : p < srcEnd ? src[p] : 0);
  const limit = srcEnd; // the parse limit of the final feed

  let pos = srcStart;
  if (rd(pos) !== MAGIC) throw new Error("bitknit: bad magic");
  pos += 2;

  const { lit, dist, bits } = makeModels();
  const cache = new Uint32Array(8).fill(1); // recent offsets
  let lru = 0xfac688; // eight 3-bit cache indices, most recent first: 0..7
  let last = 1; // last match offset; literals are deltas against dst[cur - last]
  let cur = dstStart;
  let chunkEnd = dstStart;

  // FUN_181061ac0: next 64 KiB chunk, or false when the output is complete
  const nextChunk = () => {
    if (chunkEnd === dstEnd || cur === dstEnd) return false;
    chunkEnd = dstStart + Math.min(((cur - dstStart) | 0xffff) + 1, dstEnd - dstStart);
    return true;
  };

  // FUN_181065bb0 fails a stream whose parse ran into the zero padding
  const finish = () => {
    if (pos > srcEnd) throw new Error("bitknit: stream overran its input");
    return pos - srcStart;
  };

  if (!nextChunk()) return finish();

  // FUN_181062450: chunk loop
  for (;;) {
    if (pos > limit) throw new Error("bitknit: source exhausted");
    const head = rd(pos);
    if (head === 0) {
      // raw chunk (states 4/5): the bytes follow, then one pad byte if the count was odd
      pos += 2;
      const n = Math.min(chunkEnd - cur, Math.max(0, limit - pos));
      dst.set(src.subarray(pos, pos + n), cur);
      cur += n;
      pos += n;
      if (cur !== chunkEnd) throw new Error("bitknit: source exhausted in raw chunk");
      if (n & 1) pos++;
    } else {
      pos = decodeChunk(pos);
    }
    if (!nextChunk()) return finish();
  }

  // FUN_181061bf0 from state 7: one rANS chunk. s0 is the state used next, s1 the other;
  // every decode uses s0 and then the two swap.
  function decodeChunk(p) {
    // header: two rANS states packed into 2..4 words
    const nb = (rd(p + 2) & 0xf) + 16;
    const t = (((rd(p) << 16) | rd(p + 2)) >>> 4) >>> 0;
    p += 4;
    let u = t;
    if (t < 0x10000) { u = ((t << 16) | rd(p)) >>> 0; p += 2; }
    let a = u >>> (nb & 0xf);
    if (a < 0x10000) { a = ((a << 16) | rd(p)) >>> 0; p += 2; }
    const b = ((((((1 << nb) >>> 0) - 1) & ((u << 16) | rd(p))) | (1 << nb)) >>> 0);
    p += 2;
    let s0 = a, s1 = b;

    if (cur === dstStart && cur !== dstEnd) {
      // the stream's first byte is the low 8 bits of the first state
      dst[cur++] = s0 & 0xff;
      let x = s0 >>> 8;
      if (x < 0x10000) { x = x * 0x10000 + rd(p); p += 2; }
      s0 = s1; s1 = x;
    }

    const decode = (m) => {
      const x = s0 & 0x7fff;
      const sym = m.find(x);
      const lo = m.cdf[sym];
      let st = (m.cdf[sym + 1] - lo) * (s0 >>> 15) + x - lo;
      if (st < 0x10000) { st = st * 0x10000 + rd(p); p += 2; }
      s0 = s1; s1 = st;
      m.update(sym);
      return sym;
    };
    // n raw bits (n <= 15) from the low end of s0
    const rawBits = (n) => {
      const v = s0 & ((1 << n) - 1);
      let st = s0 >>> n;
      if (st < 0x10000) { st = st * 0x10000 + rd(p); p += 2; }
      s0 = s1; s1 = st;
      return v;
    };

    while (cur < chunkEnd) {
      if (p > limit) throw new Error("bitknit: source exhausted");
      let sym = decode(lit[(cur - dstStart) & 3]);
      if (sym < 0x100) {
        dst[cur] = dst[cur - last] + sym;
        cur++;
        if (cur >= chunkEnd) break;
        sym = decode(lit[(cur - dstStart) & 3]);
        if (sym < 0x100) {
          dst[cur] = dst[cur - last] + sym;
          cur++;
          continue;
        }
      }

      // match at cur
      if (sym >= 0x120) {
        const n = sym - 0x11f;
        sym = (1 << n) + 0x11e + rawBits(n);
      }
      const len = sym - 0xfe;

      const dsym = decode(dist[(cur - dstStart) & 3]);
      let offset;
      if (dsym < 8) {
        const sh = dsym * 3;
        const idx = (lru >>> sh) & 7;
        const mask = -8 << sh;
        offset = cache[idx];
        lru = ((((lru << 3) + idx) & ~mask) | (lru & mask)) >>> 0;
      } else {
        const nbits = decode(bits);
        const S = s0;
        let st = S >>> (nbits & 0xf);
        if (st < 0x10000) { st = st * 0x10000 + rd(p); p += 2; }
        s0 = s1; s1 = st;
        let v = S;
        if (nbits > 15) { v = ((S << 16) | rd(p)) >>> 0; p += 2; }
        v = (v & (((1 << nbits) >>> 0) - 1)) >>> 0;
        offset = v * 32 + dsym + 32 * 2 ** nbits - 0x27;
        cache[(lru >>> 21) & 7] = cache[(lru >>> 18) & 7];
        cache[(lru >>> 18) & 7] = offset;
      }

      if (cur - dstStart < offset || dstEnd - cur < ((sym - 0xf7) & ~7)) {
        throw new Error("bitknit: match out of range");
      }
      for (let i = 0; i < len; i++) dst[cur + i] = dst[cur + i - offset];
      cur += len;
      last = offset;
    }
    return p;
  }
}

/**
 * One BitKnit stream (FUN_181019330 / FUN_181065930, and the streaming path used for format 4).
 * Use for format-4 section data, format-4 relocation tables (numRelocations*12 bytes) and
 * mixed-marshalling tables (numMixedMarshalling*16 bytes); for tables, src starts after the u32 size.
 * @param {Uint8Array} src compressed bytes
 * @param {number} expandedSize output size
 * @returns {Uint8Array}
 */
export function decompressBitKnit(src, expandedSize) {
  const dst = new Uint8Array(expandedSize);
  decodeStream(src, 0, src.length, dst, 0, expandedSize);
  return dst;
}

export const decompressBitKnitStream = decompressBitKnit;

/**
 * Format-3 section data (FUN_181019270): three streams, back to back in src, that fill
 * [0, stop0), [stop0, stop1), [stop1, expandedSize). Each stream restarts the models and may only
 * refer back within its own part. stop0/stop1 are the section header's first16 / first8 fields.
 * @param {Uint8Array} src compressed bytes (the section's dataSize bytes)
 * @param {number} expandedSize
 * @param {number} stop0
 * @param {number} stop1
 * @returns {Uint8Array}
 */
export function decompressBitKnitSection(src, expandedSize, stop0, stop1) {
  const dst = new Uint8Array(expandedSize);
  const stops = [stop0, stop1, expandedSize];
  let used = 0;
  let prev = 0;
  for (const stop of stops) {
    used += decodeStream(src, used, src.length, dst, prev, stop);
    prev = stop;
  }
  return dst;
}
