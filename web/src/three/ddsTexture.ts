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

export function parseDds(buf: ArrayBuffer, name = "dds"): THREE.CompressedTexture {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== DDS_MAGIC) throw new Error(`${name}: not a DDS file`);
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const fourCC = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  const DDPF_FOURCC = 0x4;
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

  const chain = (): { data: Uint8Array; width: number; height: number }[] => {
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    let w = width, h = height;
    for (let i = 0; i < mipCount; i++) {
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
  const mipmaps = chain();
  const tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], width, height, kind.format);
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
    return parseDds(await res.arrayBuffer(), url.split("/").pop());
  } catch (e) {
    if (!failed.has(url)) { failed.add(url); console.warn(`texture not loaded: ${(e as Error).message}`); }
    throw e;
  }
}
const failed = new Set<string>();

/** What this GPU can take; a ship needs RGTC (BC4/BC5) and BPTC (BC7). */
/**
 * A volume DDS (DDSD_DEPTH: the storm planets' 64^3 noise, uncompressed 32-bit) as a 3D texture, repeating, its top
 * level only.
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
      if (dv.getUint32(80, true) & 0x4) throw new Error(`${url}: a compressed volume is not handled`);
      const { data, format } = unpack(dv, buf, 128, width, height * depth, url);
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
