// DirectDraw Surface (.dds) files from the EVE client, uploaded to the GPU still block-compressed.
//
// The client's ship textures are BC4 (one channel: roughness, masks, glow), BC5 (two channels:
// normal maps), BC7 (albedo), and a few BC1/BC3. Desktop browsers take all of them through the
// RGTC / BPTC / S3TC extensions, so nothing is decoded on the CPU. DDS stores mip 0 first, top row
// first, which is glTF's UV convention, so the textures are not flipped.

import * as THREE from "three";

const DDS_MAGIC = 0x20534444;
const DDSCAPS2_CUBEMAP = 0x200;

// DXGI_FORMAT values found in the client's DX10-header files
const DXGI: Record<number, { format: THREE.CompressedPixelFormat; block: number }> = {
  71: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 }, // BC1_UNORM
  72: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 }, // BC1_UNORM_SRGB
  77: { format: THREE.RGBA_S3TC_DXT5_Format, block: 16 }, // BC3_UNORM
  80: { format: THREE.RED_RGTC1_Format, block: 8 }, // BC4_UNORM
  95: { format: THREE.RGB_BPTC_UNSIGNED_Format, block: 16 }, // BC6H_UF16 (HDR)
  96: { format: THREE.RGB_BPTC_SIGNED_Format, block: 16 }, // BC6H_SF16 (HDR: the nebula cube maps)
  83: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 }, // BC5_UNORM
  98: { format: THREE.RGBA_BPTC_Format, block: 16 }, // BC7_UNORM
  99: { format: THREE.RGBA_BPTC_Format, block: 16 }, // BC7_UNORM_SRGB
};
const FOURCC: Record<string, { format: THREE.CompressedPixelFormat; block: number }> = {
  DXT1: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 },
  DXT3: { format: THREE.RGBA_S3TC_DXT3_Format, block: 16 },
  DXT5: { format: THREE.RGBA_S3TC_DXT5_Format, block: 16 },
  ATI1: { format: THREE.RED_RGTC1_Format, block: 8 },
  BC4U: { format: THREE.RED_RGTC1_Format, block: 8 },
  ATI2: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 },
  BC5U: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 },
};


/**
 * Pixels of an uncompressed DDS surface (DDPF_RGB with 32, 24 or 8 bits a pixel, read by its channel masks) from a
 * byte offset: RGBA8 for 32 and 24 bits (24 opaque), R8 for 8.
 */
function unpack(dv: DataView, buf: ArrayBuffer, offset: number, width: number, height: number, name: string): { data: Uint8Array; format: THREE.PixelFormat; bytes: number } {
  const bits = dv.getUint32(88, true);
  const masks = [92, 96, 100, 104].map((o) => dv.getUint32(o, true));
  const sh = masks.map((m) => (m === 0 ? -1 : Math.log2(m & -m)));
  const n = width * height;
  if (bits === 32 || bits === 24) {
    const step = bits / 8;
    const src = new Uint8Array(buf, offset, n * step);
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const p = src[i * step]! | (src[i * step + 1]! << 8) | (src[i * step + 2]! << 16) | (step === 4 ? src[i * 4 + 3]! << 24 : 0);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = sh[c]! < 0 ? 0 : (p >>> sh[c]!) & 0xff;
      out[i * 4 + 3] = step === 4 && sh[3]! >= 0 ? (p >>> sh[3]!) & 0xff : 255;
    }
    return { data: out, format: THREE.RGBAFormat, bytes: n * step };
  }
  if (bits === 8) return { data: new Uint8Array(buf, offset, n).slice(), format: THREE.RedFormat, bytes: n };
  throw new Error(`${name}: uncompressed DDS with ${bits} bits a pixel not handled`);
}

/**
 * An uncompressed 2D DDS: the top mip, the GPU making the rest. The client's planet textures are some of these (the
 * ground scattering light maps are 24-bit).
 */
function parseUncompressed(dv: DataView, buf: ArrayBuffer, width: number, height: number, name: string): THREE.DataTexture {
  const { data, format } = unpack(dv, buf, 128, width, height, name);
  const tex = new THREE.DataTexture(data, width, height, format);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * An uncompressed cube map DDS (the hangars' reflection cubes, some nebula blur cubes): six faces, +x -x +y -y +z -z,
 * each with its whole mip chain; each face's top mip, the GPU making the rest.
 */
function parseUncompressedCube(dv: DataView, buf: ArrayBuffer, width: number, height: number, mipCount: number, name: string): THREE.CubeTexture {
  const bits = dv.getUint32(88, true);
  let faceBytes = 0;
  for (let i = 0, w = width, h = height; i < mipCount; i++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) faceBytes += w * h * (bits / 8);
  const faces: THREE.DataTexture[] = [];
  for (let f = 0; f < 6; f++) {
    const { data, format } = unpack(dv, buf, 128 + f * faceBytes, width, height, name);
    const face = new THREE.DataTexture(data, width, height, format);
    face.flipY = false;
    face.needsUpdate = true;
    faces.push(face);
  }
  const cube = new THREE.CubeTexture(faces as unknown as HTMLImageElement[]);
  cube.format = faces[0]!.format;
  cube.type = THREE.UnsignedByteType;
  cube.generateMipmaps = true;
  cube.minFilter = THREE.LinearMipmapLinearFilter;
  cube.magFilter = THREE.LinearFilter;
  cube.flipY = false;
  cube.name = name;
  cube.needsUpdate = true;
  return cube;
}

/**
 * The texture quality setting (device.py: trinity.device.mipLevelSkipCount = textureQuality): how many top mips a
 * texture leaves out as it loads. UI textures are excluded (_GetAppMipLevelSkipExclusionDirectories: res:/UI/Texture).
 */
let mipLevelSkipCount = 0;
export function setMipLevelSkipCount(count: number): void {
  mipLevelSkipCount = Math.max(0, Math.floor(count));
}
/** The skip a texture of this path loads with now (Tr2Renderer.IsTextureToResize). */
export function mipSkipFor(url: string): number {
  return /\/ui\/texture\//i.test(url) ? 0 : mipLevelSkipCount;
}

/**
 * ImageIO LoadParameters::GetMipLevelRange: a texture over 8 x 8 with more mips than the skip leaves that many out;
 * one with fewer (but some) keeps its last three; one without a chain keeps it all.
 */
export function mipRange(width: number, height: number, mipCount: number, want: number): number {
  if (!(width > 8 && height > 8)) return 0;
  if (mipCount > want) return want;
  if (mipCount) return mipCount >= 3 ? mipCount - 3 : 0;
  return 0;
}

export function parseDds(buf: ArrayBuffer, name = "dds", mipSkip = 0): THREE.CompressedTexture {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== DDS_MAGIC) throw new Error(`${name}: not a DDS file`);
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const fourCC = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  const DDPF_FOURCC = 0x4;
  // D3DFMT_R32F (FourCC 114): one float a texel, its top level (a station traffic's path positions, in metres)
  if (dv.getUint32(80, true) & DDPF_FOURCC && dv.getUint32(84, true) === 114) {
    const tex = new THREE.DataTexture(new Float32Array(buf.slice(128, 128 + width * height * 4)), width, height, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.name = name;
    tex.needsUpdate = true;
    return tex as unknown as THREE.CompressedTexture;
  }
  // D3DFMT_A32B32G32R32F (116) / A16B16G16R16F (113): four floats a texel, its top level (the line sets' gradients)
  if (dv.getUint32(80, true) & DDPF_FOURCC && (dv.getUint32(84, true) === 116 || dv.getUint32(84, true) === 113)) {
    const half = dv.getUint32(84, true) === 113;
    const n = width * height * 4;
    const tex = half
      ? new THREE.DataTexture(new Uint16Array(buf.slice(128, 128 + n * 2)), width, height, THREE.RGBAFormat, THREE.HalfFloatType)
      : new THREE.DataTexture(new Float32Array(buf.slice(128, 128 + n * 4)), width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.name = name;
    tex.needsUpdate = true;
    return tex as unknown as THREE.CompressedTexture;
  }
  if (!(dv.getUint32(80, true) & DDPF_FOURCC)) {
    if (dv.getUint32(112, true) & DDSCAPS2_CUBEMAP) return parseUncompressedCube(dv, buf, width, height, mipCount, name) as unknown as THREE.CompressedTexture;
    return parseUncompressed(dv, buf, width, height, name) as unknown as THREE.CompressedTexture;
  }
  let offset = 128;
  let kind = FOURCC[fourCC];
  if (fourCC === "DX10") {
    const dxgi = dv.getUint32(128, true);
    kind = DXGI[dxgi];
    offset += 20;
    if (!kind) throw new Error(`${name}: DXGI format ${dxgi} not handled`);
  }
  if (!kind) throw new Error(`${name}: DDS format ${JSON.stringify(fourCC)} not handled`);

  const chain = (from = 0): { data: Uint8Array; width: number; height: number }[] => {
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    let w = width, h = height;
    for (let i = 0; i < mipCount; i++) {
      if (i < from) {
        // a mip left out (the texture quality): stepped over (Tr2DdsHandler DoReadHeader's skipBytes)
        offset += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * kind!.block;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        continue;
      }
      const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * kind!.block;
      if (offset + size > buf.byteLength) break;
      mipmaps.push({ data: new Uint8Array(buf, offset, size), width: w, height: h });
      offset += size;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    return mipmaps;
  };
  // A cube map is six faces, each with its whole mip chain, in the order +x -x +y -y +z -z.
  if (dv.getUint32(112, true) & DDSCAPS2_CUBEMAP) {
    const faces = Array.from({ length: 6 }, () => ({ mipmaps: chain(), width, height }));
    const cube = new THREE.CompressedCubeTexture(faces as unknown as THREE.CompressedTexture[], kind.format);
    cube.minFilter = faces[0]!.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    cube.magFilter = THREE.LinearFilter;
    cube.name = name;
    cube.needsUpdate = true;
    return cube as unknown as THREE.CompressedTexture;
  }
  // the texture quality's skip (not for cube maps: "this optimization won't work for Cube textures")
  const DDSD_MIPMAPCOUNT = 0x20000;
  const skip = mipSkip > 0 ? mipRange(width, height, dv.getUint32(8, true) & DDSD_MIPMAPCOUNT ? dv.getUint32(28, true) : 0, mipSkip) : 0;
  const mipmaps = chain(skip);
  const tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], mipmaps[0]?.width ?? width, mipmaps[0]?.height ?? height, kind.format);
  tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A DDS file fetched and parsed. A file that will not load is said once in the console before the error goes on:
 * most callers draw without the texture, which would otherwise hide the loss (the planets' 24-bit scattering maps
 * were lost so).
 */
export async function loadDds(url: string): Promise<THREE.CompressedTexture> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return parseDds(await res.arrayBuffer(), url.split("/").pop(), mipSkipFor(url));
  } catch (e) {
    if (!failed.has(url)) { failed.add(url); console.warn(`texture not loaded: ${(e as Error).message}`); }
    throw e;
  }
}
const failed = new Set<string>();

/** One BC1 colour block (8 bytes at `o`) into 16 RGBA texels, its alpha left to the caller where `withAlpha` is false. */
function bc1Block(src: Uint8Array, o: number, out: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number, base: number, punch: boolean): void {
  const c0 = src[o]! | (src[o + 1]! << 8), c1 = src[o + 2]! | (src[o + 3]! << 8);
  const rgb = (c: number) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const a = rgb(c0), b = rgb(c1);
  const p: number[][] = [a, b];
  if (c0 > c1 || !punch) {
    p.push(a.map((v, i) => (2 * v + b[i]!) / 3), a.map((v, i) => (v + 2 * b[i]!) / 3));
  } else {
    p.push(a.map((v, i) => (v + b[i]!) / 2), [0, 0, 0]);
  }
  const bits = src[o + 4]! | (src[o + 5]! << 8) | (src[o + 6]! << 16) | (src[o + 7]! << 24);
  for (let i = 0; i < 16; i++) {
    const x = x0 + (i & 3), y = y0 + (i >> 2);
    if (x >= w || y >= h) continue;
    const k = (bits >>> (2 * i)) & 3;
    const t = base + (y * stride + x) * 4;
    out[t] = p[k]![0]!; out[t + 1] = p[k]![1]!; out[t + 2] = p[k]![2]!;
    if (punch) out[t + 3] = c0 <= c1 && k === 3 ? 0 : 255;
  }
}

/** One BC3 alpha block (8 bytes at `o`) into 16 texels' alpha. */
function bc3Alpha(src: Uint8Array, o: number, out: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number, base: number): void {
  const a0 = src[o]!, a1 = src[o + 1]!;
  const p = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) p.push(((7 - i) * a0 + i * a1) / 7);
  else { for (let i = 1; i < 5; i++) p.push(((5 - i) * a0 + i * a1) / 5); p.push(0, 255); }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(src[o + 2 + i]!) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) {
    const x = x0 + (i & 3), y = y0 + (i >> 2);
    if (x >= w || y >= h) continue;
    out[base + (y * stride + x) * 4 + 3] = p[Number((bits >> BigInt(3 * i)) & 7n)]!;
  }
}

/** A block-compressed (DXT1 / DXT5) surface of `depth` slices, top level only, decoded to RGBA8. */
function decodeBcVolume(src: Uint8Array, w: number, h: number, depth: number, dxt5: boolean): Uint8Array {
  const out = new Uint8Array(w * h * depth * 4);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const blockBytes = dxt5 ? 16 : 8;
  let o = 0;
  for (let z = 0; z < depth; z++) {
    const base = z * w * h * 4;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++, o += blockBytes) {
        if (dxt5) {
          bc3Alpha(src, o, out, w, bx * 4, by * 4, w, h, base);
          bc1Block(src, o + 8, out, w, bx * 4, by * 4, w, h, base, false);
        } else {
          bc1Block(src, o, out, w, bx * 4, by * 4, w, h, base, true);
        }
      }
    }
  }
  return out;
}

/**
 * A volume DDS (DDSD_DEPTH) as a 3D texture, repeating, its top level only: uncompressed (the storm planets' 64^3
 * noise, 32-bit) or DXT1 / DXT5 (the hull effects' 3D layers, fx3dv5.fx's LayerAllMap), decoded here, a compressed 3D
 * texture being nothing WebGL 2 takes.
 */
const volumes = new Map<string, Promise<THREE.Data3DTexture>>();
export function loadDds3D(url: string): Promise<THREE.Data3DTexture> {
  if (!volumes.has(url)) {
    volumes.set(url, fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      const buf = await r.arrayBuffer();
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x20534444) throw new Error(`${url}: not a DDS`);
      const height = dv.getUint32(12, true), width = dv.getUint32(16, true), depth = Math.max(1, dv.getUint32(24, true));
      let data: Uint8Array, format: THREE.PixelFormat;
      if (dv.getUint32(80, true) & 0x4) {
        const cc = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
        if (cc !== "DXT5" && cc !== "DXT1") throw new Error(`${url}: a ${JSON.stringify(cc)} volume is not handled`);
        data = decodeBcVolume(new Uint8Array(buf, 128), width, height, depth, cc === "DXT5");
        format = THREE.RGBAFormat;
      } else {
        ({ data, format } = unpack(dv, buf, 128, width, height * depth, url));
      }
      const tex = new THREE.Data3DTexture(data, width, height, depth);
      tex.format = format;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return tex;
    }));
  }
  return volumes.get(url)!;
}

export function compressedSupport(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  return {
    rgtc: !!gl.getExtension("EXT_texture_compression_rgtc"),
    bptc: !!gl.getExtension("EXT_texture_compression_bptc"),
    s3tc: !!gl.getExtension("WEBGL_compressed_texture_s3tc"),
  };
}
