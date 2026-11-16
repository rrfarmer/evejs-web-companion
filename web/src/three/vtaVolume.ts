/** A VTAv1 R8 volume stores one zlib stream of quantized texels. Bit 0 marks a repeat count minus one. */
export function decodeVtaRuns(encoded: Uint8Array, texelCount: number): Uint8Array {
  const data = new Uint8Array(texelCount);
  let offset = 0;
  for (let i = 0; i < encoded.length;) {
    const token = encoded[i++]!;
    if (token & 2) throw new Error("Unsupported VTA run flags");
    const repeats = (token & 1) !== 0;
    if (repeats && i === encoded.length) throw new Error("Truncated VTA repeat");
    const count = repeats ? 1 + encoded[i++]! : 1;
    if (offset + count > data.length) throw new Error("VTA run exceeds texture dimensions");
    const texel = token & 0xfc;
    if (texel !== 0) {
      if (repeats) data.fill(texel, offset, offset + count);
      else data[offset] = texel;
    }
    offset += count;
  }
  if (offset !== data.length) throw new Error("Incomplete VTA texture");
  return data;
}

export async function decodeVta(buffer: ArrayBuffer): Promise<{ width: number; height: number; depth: number; data: Uint8Array }> {
  const header = new DataView(buffer);
  const headerSize = 92;
  if (buffer.byteLength < headerSize || header.getUint32(0, true) !== 0x415456 ||
      header.getUint32(4, true) !== 1 || header.getUint32(12, true) !== 1 ||
      header.getUint32(24, true) !== buffer.byteLength || header.getUint32(32, true) !== 61 ||
      header.getUint32(36, true) !== 3 || header.getUint32(84, true) !== headerSize) {
    throw new Error("Unsupported VTA volume header");
  }
  const width = header.getUint32(40, true);
  const height = header.getUint32(44, true);
  const depth = header.getUint32(48, true);
  const count = width * height * depth;
  if (!Number.isSafeInteger(count) || count === 0 || count > 256 * 1024 * 1024) throw new Error("Unsupported VTA volume size");
  const stream = new Blob([new Uint8Array(buffer, headerSize)]).stream().pipeThrough(new DecompressionStream("deflate"));
  const encoded = new Uint8Array(await new Response(stream).arrayBuffer());
  return { width, height, depth, data: decodeVtaRuns(encoded, count) };
}
