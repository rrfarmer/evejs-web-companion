// Audiokinetic Wwise PTADPCM (.wem, format tag 0x8311) to 16-bit PCM in a WAV file, as the client's own Wwise engine
// (tq/bin64/_audio2.dll, SDK 2023.1) decodes it - read out of its decoder (the frame loop and the nibble step):
// - a channel's frame is blockAlign / channels bytes: sample 0 and sample 1 as int16, a step index (u8), then the
//   nibbles, low then high, of the frame's other samples (a 36-byte frame: 2 + 62 = 64 samples);
// - each nibble n, with the index i, takes the table's entry [i * 16 + n] - {delta, next index} (int32 pairs, 12 rows
//   of 16 in the DLL's .rdata) - and makes the sample clamp16(2 x previous - the one before + delta).

/**
 * The decoder's table in the client's _audio2.dll: 12 rows (step indices 0..11) of 16 {delta, next index} int32
 * pairs, found by their shape - each row's deltas non-decreasing and symmetric about nought (d[k] = -d[15 - k]),
 * within 16 bits, the next indices 0..11 (2023.1: row 0 -14 .. 14, row 11 -28672 .. 28672).
 */
export function findPtadpcmTable(dll) {
  const dv = new DataView(dll.buffer, dll.byteOffset, dll.byteLength);
  const ROWS = 12;
  for (let off = 0; off + ROWS * 16 * 8 <= dll.length; off += 4) {
    let ok = true;
    for (let row = 0; row < ROWS && ok; row++) {
      for (let n = 0; n < 16 && ok; n++) {
        const at = off + (row * 16 + n) * 8;
        const d = dv.getInt32(at, true), next = dv.getInt32(at + 4, true);
        if (next < 0 || next >= ROWS || Math.abs(d) > 32768) ok = false;
        else if (n > 0 && d < dv.getInt32(at - 8, true)) ok = false;
        else if (d !== -dv.getInt32(off + (row * 16 + 15 - n) * 8, true)) ok = false;
      }
      if (ok && dv.getInt32(off + row * 16 * 8, true) >= 0) ok = false;
    }
    if (!ok) continue;
    const table = new Int32Array(ROWS * 16 * 2);
    for (let k = 0; k < table.length; k++) table[k] = dv.getInt32(off + k * 4, true);
    return { table, offset: off };
  }
  throw new Error("no PTADPCM table in the DLL");
}

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/** A PTADPCM .wem's samples, interleaved, and its channels and rate. */
export function decodePtadpcm(wem, table) {
  const dv = new DataView(wem.buffer, wem.byteOffset, wem.byteLength);
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= wem.length;) {
    const tag = String.fromCharCode(...wem.subarray(p, p + 4));
    const size = dv.getUint32(p + 4, true);
    if (tag === "fmt ") fmt = { offset: p + 8, size };
    if (tag === "data") data = { offset: p + 8, size };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("no fmt or data chunk");
  if (dv.getUint16(fmt.offset, true) !== 0x8311) throw new Error("not PTADPCM");
  const channels = dv.getUint16(fmt.offset + 2, true);
  const rate = dv.getUint32(fmt.offset + 4, true);
  const blockAlign = dv.getUint16(fmt.offset + 12, true);
  const frame = blockAlign / channels;
  const perFrame = 2 + (frame - 5) * 2;
  const end = Math.min(wem.length, data.offset + data.size);
  const blocks = Math.floor((end - data.offset) / blockAlign);
  const out = new Int16Array(blocks * perFrame * channels);
  for (let b = 0; b < blocks; b++) {
    for (let c = 0; c < channels; c++) {
      const base = data.offset + b * blockAlign + c * frame;
      let h2 = dv.getInt16(base, true), h1 = dv.getInt16(base + 2, true), index = wem[base + 4];
      let o = (b * perFrame) * channels + c;
      out[o] = h2; o += channels;
      out[o] = h1; o += channels;
      for (let k = 0; k < (frame - 5) * 2; k++) {
        const byte = wem[base + 5 + (k >> 1)];
        const nibble = k & 1 ? byte >> 4 : byte & 15;
        const e = (index * 16 + nibble) * 2;
        const s = clamp16(2 * h1 - h2 + table[e]);
        index = table[e + 1];
        h2 = h1; h1 = s;
        out[o] = s; o += channels;
      }
    }
  }
  return { samples: out, channels, rate };
}

/** A canonical 16-bit PCM WAV. */
export function wav({ samples, channels, rate }) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * 2, true); dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, samples.length * 2, true);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return bytes;
}
