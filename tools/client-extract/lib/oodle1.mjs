// Granny 3D "Oodle1" decompression (section compression format 2).
//
// Translated from the EVE client's own copy of the Granny runtime, _trinity_dx11.dll build 3396210
// (granny_oodle1_compression.cpp), via Ghidra pseudo-C and a check of the machine code where the
// decompiler dropped call arguments. Function names below are that binary's addresses.
//
// The scheme: an LZ77 coder whose tokens are coded with an arithmetic coder and adaptive frequency
// models. A token is a match-length symbol (0 = one literal byte), coded in a model chosen by the
// previous token; a literal byte is coded in one of four models chosen by output position & 3; a
// match distance is coded as (low 2 bits, high part >> 10, middle part >> 2) in three models.
// Each model escapes to a uniform code for symbols it has not seen.
//
// A compressed section is three 12-byte parameter blocks (one per "stop") followed by the coded
// stream. The stops are the section header's first16 / first8 / expanded sizes; the models are
// reset at each stop, the coder's state is not.

// DAT_1817c5964: match lengths for the four longest symbols; below 61 the length is symbol + 1.
const LONG_LENGTHS = { 61: 128, 62: 192, 63: 256, 64: 512 };

// ---- the arithmetic decoder (state at FUN_18106d6a0) ----
class Decoder {
  // FUN_18106d6a0
  constructor(src, pos) {
    this.src = src;
    const b = src[pos];
    this.value = b >>> 1;
    this.range = 0x80;
    this.pos = pos + 1;
    this.bit = b & 1;
    this.step = 0; // the range share remembered between peek and commit (param_1[4])
  }

  normalize() {
    while (this.range <= 0x800000) {
      const b = this.src[this.pos++] ?? 0;
      this.value = (((this.value * 2 + this.bit) << 7) | (b >>> 1)) >>> 0;
      this.bit = b & 1;
      this.range = (this.range * 256) >>> 0;
    }
  }

  // FUN_18106d6d0: a uniformly coded symbol in [0, n)
  uniform(n) {
    this.normalize();
    const r = Math.floor(this.range / n);
    let s = Math.floor(this.value / r);
    if (s >= n) s = n - 1;
    const low = (s * r) >>> 0;
    this.value = (this.value - low) >>> 0;
    if (s + 1 < n) this.range = r;
    else this.range = (this.range - low) >>> 0;
    return s;
  }

  // FUN_18106d490: peek a cumulative frequency out of 2^shift (clamped to max - 1)
  peek(shift, max) {
    this.normalize();
    this.step = this.range >>> shift;
    const q = Math.floor(this.value / this.step);
    return q < max ? q : max - 1;
  }

  // FUN_18106d9e0: consume the interval [low, low + freq) of a total `total`
  commit(low, freq, total) {
    const sub = Math.imul(this.step, low) >>> 0;
    this.value = (this.value - sub) >>> 0;
    if (low + freq < total) this.range = Math.imul(this.step, freq) >>> 0;
    else this.range = (this.range - sub) >>> 0;
  }

  // FUN_18106d530: an equiprobable choice among `n` (called with shift 1, n 2)
  bitChoice(shift, n) {
    this.normalize();
    const r = this.range >>> shift;
    let s = Math.floor(this.value / r);
    if (s >= n) s = n - 1;
    const sub = Math.imul(s, r) >>> 0;
    this.value = (this.value - sub) >>> 0;
    if (s + 1 < n) this.range = r;
    else this.range = (this.range - sub) >>> 0;
    return s;
  }
}

// ---- an adaptive model, laid out word for word as in the binary so that the search's reads
// ---- past the ends of the cumulative table see what the original sees.
//
// words: 0 total, 1 rebuild threshold, 2 increment cap, 3 increment, 4 halving limit,
//        5 symbols in use, 6 symbols in the cumulative table, 7 alphabet size,
//        0x10.. search-step table as u32 pairs, 0x2c.. cumulative table (0x8000-based, 14 bits),
//        then the counts (R words) and the symbol values (R words), R = (n + 5) & ~3.
class Model {
  // FUN_181079850 (no external value array; `maxSymbol` is its third argument)
  constructor(maxSymbol, n) {
    const R = (n + 5) & ~3;
    this.w = new Uint16Array(0x34 + R * 3);
    this.counts = 0x34 + R;
    this.values = 0x34 + R * 2;
    const w = this.w;
    w[0] = 4;
    w[7] = n;
    w[0x2c] = 0x8000; w[0x2d] = 0xc000;
    w[0x2e] = 0xc000; w[0x2f] = 0xc000; w[0x30] = 0xc000; w[0x31] = 0xc000;
    w[this.counts] = 4;
    w[3] = 4;
    w[1] = 8;
    let lim = 0x100;
    const s5 = (maxSymbol << 5) >>> 0;
    if (s5 > 0xff) lim = s5 > 0x3b38 ? 0x3b38 : s5;
    w[4] = lim;
    const s2 = (maxSymbol * 2) >>> 0;
    let cap = 0x80;
    if (s2 > 0x7f) {
      const alt = ((lim & 0xffff) >>> 1) - 0x20;
      cap = alt <= s2 ? alt : s2;
    }
    w[2] = cap;
  }

  u32(word) { return this.w[word] | (this.w[word + 1] << 16); }
  setU32(word, v) { this.w[word] = v & 0xffff; this.w[word + 1] = (v >>> 16) & 0xffff; }

  // FUN_181079c00: halve every count, dropping symbols whose count falls to nothing
  halve() {
    const w = this.w, C = this.counts, V = this.values;
    let bestIdx = 0xffffffff, best = 0;
    w[C] = w[C] >>> 1;
    w[0] = w[C];
    if (w[5] !== 0) {
      let u = 1;
      done: do {
        while (w[C + u] < 2) {
          if (w[5] <= u) { w[C + u] = 0; w[5] = w[5] - 1; break done; }
          w[C + u] = w[C + w[5]];
          w[C + w[5]] = 0;
          w[V + u] = w[V + w[5]];
          w[5] = w[5] - 1;
        }
        w[C + u] = w[C + u] >>> 1;
        w[0] = w[0] + w[C + u];
        if (best < w[C + u]) { bestIdx = u; best = w[C + u]; }
        u++;
      } while (u <= w[5]);
      if (best !== 0 && w[5] !== 0 && bestIdx !== w[5]) {
        const a = w[5], b = bestIdx;
        let t = w[C + a]; w[C + a] = w[C + b]; w[C + b] = t;
        t = w[V + a]; w[V + a] = w[V + b]; w[V + b] = t;
      }
    }
    if (w[5] !== w[7] && w[C] === 0) { w[C] = 1; w[0] = w[0] + 1; }
  }

  // FUN_181079d60: rebuild the cumulative table from the counts
  rebuild() {
    const w = this.w, C = this.counts;
    const total = w[0];
    const scale = Math.floor(0x20000 / total);
    w[0x2c] = 0x8000;
    let acc = ((w[C] * scale) >>> 3) + 0x8000;
    w[0x2d] = acc;
    if (w[5] !== 0) {
      let u = 1;
      let next;
      do {
        next = u + 1;
        acc += (w[C + u] * scale) >>> 3;
        w[0x2c + next] = acc;
        u = next;
      } while (next <= w[5]);
    }
    if (w[2] < w[3] * 2) w[1] = (w[2] + w[0]) & 0xffff;
    else { const inc = (w[3] * 2) & 0xffff; w[1] = (w[0] + inc) & 0xffff; w[3] = inc; }
    w[6] = w[5];
    w[0x2d + w[5]] = 0xc000;
  }

  // FUN_181079470. Returns the symbol, or decodes a new one with `escapeRange` (the caller's
  // FUN_18106d6d0 after a slot pointer comes back) and stores it in the model.
  decode(d, escapeRange) {
    const w = this.w, C = this.counts, V = this.values;
    if (w[1] <= w[0]) {
      if (w[4] <= w[1]) this.halve();
      this.rebuild();
      const n6 = w[6];
      for (let k = 2; k <= 6; k++) w[0x2c + n6 + k] = 0xc000;
      let s = n6 + 1, k = 0, last;
      do { last = k; s = (s + 1) >>> 1; this.setU32(0x10 + 2 * k, s); k++; } while (s > 4);
      if (last !== 0) w.copyWithin(0x2c - 2 * last, 0x12, 0x12 + 2 * last);
      this.setU32(0x12, this.u32(0x10));
      this.setU32(0x10, last);
    }
    const v = (d.peek(14, 0x4000) + 0x8000) & 0xffff;
    let i = this.u32(0x12) | 0;
    const steps = this.u32(0x10);
    for (let c = steps; c >= 1; c--) {
      const step = this.u32(0x2c - 2 * c) | 0;
      i = v < w[0x2c + i] ? i - step : i + step;
    }
    let i2 = v < w[0x2c + i] ? i - 2 : i + 2;
    if (v < w[0x2c + i2]) { i = i2 - 1; if (v < w[0x2c + i]) i = i2 - 2; }
    else { i = i2; if (w[0x2c + i2 + 1] <= v) i = i2 + 1; }
    d.commit(w[0x2c + i] - 0x8000, w[0x2c + i + 1] - w[0x2c + i], 0x4000);
    w[C + i] = w[C + i] + 1;
    w[0] = w[0] + 1;
    if (i < 1) {
      if (w[5] === w[6] || d.bitChoice(1, 2) === 0) {
        w[5] = w[5] + 1;
        const slot = w[5];
        w[C + slot] = w[C + slot] + 2;
        w[0] = w[0] + 2;
        if (w[5] === w[7]) { w[0] = w[0] - w[C]; w[C] = 0; }
        const sym = d.uniform(escapeRange);
        w[V + slot] = sym;
        return sym;
      }
      const j = d.uniform(w[5] - w[6]) + w[6] + 1;
      w[C + j] = w[C + j] + 2;
      w[0] = w[0] + 2;
      return w[V + j];
    }
    return w[V + i];
  }
}

// ---- the token decoder's state (FUN_18106eae0 builds it from one 12-byte parameter block) ----
class Stage {
  constructor(p0, p1, p2) {
    this.literalRange = p0 & 0x1ff;               // 0xa38
    this.window = p0 >>> 9;                         // 0xa3c
    this.lowRange = this.window < 4 ? this.window + 1 : 4;                       // 0xa40
    this.midRange = (p0 >>> 11) < 0x100 ? (p0 >>> 11) + 1 : 0x100;               // 0xa44
    this.highCount = (p0 >>> 19) + 1;               // 0xa48
    this.written = 0;                               // 0xa4c
    this.prev = 0;                                  // 0xa50
    this.literal = [];
    for (let k = 0; k < 4; k++) this.literal.push(new Model(this.literalRange - 1, p1 & 0x1ff));
    this.length = [];
    let n = 0;
    for (let shift = 24; shift >= 0; shift -= 8) {
      n = (p2 >>> shift) & 0xff;
      for (let k = 0; k < 16; k++) this.length.push(new Model(0x40, n));
    }
    this.length.push(new Model(0x40, n));        // the 65th, after a length-64 symbol
    this.mid = [];
    for (let k = 0; k < this.highCount; k++) this.mid.push(new Model(this.midRange - 1, this.midRange));
    this.low = new Model(this.lowRange - 1, this.lowRange);
    this.high = new Model(this.highCount - 1, (p1 >>> 19) + 1);
  }

  // FUN_18106e5a0: decode one token into out at pos; returns the bytes written
  token(d, out, pos) {
    const sym = this.length[this.prev].decode(d, 0x41);
    this.prev = sym;
    if (sym === 0) {
      out[pos] = this.literal[pos & 3].decode(d, this.literalRange);
      this.written++;
      return 1;
    }
    const reach = this.written < this.window ? this.written : this.window;
    const len = sym < 0x3d ? sym + 1 : LONG_LENGTHS[sym];
    const low = this.low.decode(d, this.lowRange);
    const high = this.high.decode(d, (reach >>> 10) + 1);
    const mid = this.mid[high].decode(d, reach < 0x400 ? (reach >>> 2) + 1 : 0x100);
    this.written += len;
    const dist = (high << 10) + low + 1 + mid * 4;
    let from = pos - dist;
    if (from < 0) throw new Error(`Oodle1: match reaches ${-from} bytes before the start`);
    for (let k = 0; k < len; k++) out[pos + k] = out[from + k];
    return len;
  }
}

function params(src, at) {
  const dv = new DataView(src.buffer, src.byteOffset + at, 12);
  return [dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true)];
}

/** FUN_181041f40: a section's data, decoded up to the three stops (stops[2] is the full size). */
export function oodle1DecompressSection(compressed, stops) {
  const expanded = stops[2];
  // the original zero-pads its input to a multiple of 4; a little more costs nothing
  const src = new Uint8Array(compressed.length + 16);
  src.set(compressed);
  const out = new Uint8Array(expanded + 512);
  const d = new Decoder(src, 36);
  let pos = 0;
  for (let k = 0; k < 3; k++) {
    const stage = new Stage(...params(src, 12 * k));
    stage.written = 0;
    while (pos < stops[k]) pos += stage.token(d, out, pos);
  }
  if (pos < expanded) throw new Error(`Oodle1: stopped at ${pos} of ${expanded}`);
  return out.subarray(0, expanded);
}

/** FUN_181042120: one stream with a single parameter block (unused by EVE files so far). */
export function oodle1DecompressStream(compressed, expanded) {
  const src = new Uint8Array(compressed.length + 16);
  src.set(compressed);
  const out = new Uint8Array(expanded + 512);
  const d = new Decoder(src, 12);
  const stage = new Stage(...params(src, 0));
  let pos = 0;
  while (pos < expanded) pos += stage.token(d, out, pos);
  return out.subarray(0, expanded);
}
