// DirectDraw Surface (.dds) files from the EVE client, uploaded to the GPU still block-compressed.
//
// The client's ship textures are BC4 (one channel: roughness, masks, glow), BC5 (two channels:
// normal maps), BC7 (albedo), and a few BC1/BC3. Desktop browsers take all of them through the
// RGTC / BPTC / S3TC extensions, so nothing is decoded on the CPU. DDS stores mip 0 first, top row
// first, which is glTF's UV convention, so the textures are not flipped.

import * as THREE from "three";

const DDS_MAGIC = 0x20534444;

// DXGI_FORMAT values found in the client's DX10-header files
const DXGI: Record<number, { format: THREE.CompressedPixelFormat; block: number }> = {
  71: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 }, // BC1_UNORM
  72: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 }, // BC1_UNORM_SRGB
  77: { format: THREE.RGBA_S3TC_DXT5_Format, block: 16 }, // BC3_UNORM
  80: { format: THREE.RED_RGTC1_Format, block: 8 }, // BC4_UNORM
  83: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 }, // BC5_UNORM
  98: { format: THREE.RGBA_BPTC_Format, block: 16 }, // BC7_UNORM
  99: { format: THREE.RGBA_BPTC_Format, block: 16 }, // BC7_UNORM_SRGB
};
const FOURCC: Record<string, { format: THREE.CompressedPixelFormat; block: number }> = {
  DXT1: { format: THREE.RGBA_S3TC_DXT1_Format, block: 8 },
  DXT5: { format: THREE.RGBA_S3TC_DXT5_Format, block: 16 },
  ATI1: { format: THREE.RED_RGTC1_Format, block: 8 },
  BC4U: { format: THREE.RED_RGTC1_Format, block: 8 },
  ATI2: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 },
  BC5U: { format: THREE.RED_GREEN_RGTC2_Format, block: 16 },
};

export function parseDds(buf: ArrayBuffer, name = "dds"): THREE.CompressedTexture {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== DDS_MAGIC) throw new Error(`${name}: not a DDS file`);
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const fourCC = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  let offset = 128;
  let kind = FOURCC[fourCC];
  if (fourCC === "DX10") {
    const dxgi = dv.getUint32(128, true);
    kind = DXGI[dxgi];
    offset += 20;
    if (!kind) throw new Error(`${name}: DXGI format ${dxgi} not handled`);
  }
  if (!kind) throw new Error(`${name}: DDS format ${JSON.stringify(fourCC)} not handled`);

  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
  let w = width, h = height;
  for (let i = 0; i < mipCount; i++) {
    const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * kind.block;
    if (offset + size > buf.byteLength) break;
    mipmaps.push({ data: new Uint8Array(buf, offset, size), width: w, height: h });
    offset += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  const tex = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], width, height, kind.format);
  tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

export async function loadDds(url: string): Promise<THREE.CompressedTexture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseDds(await res.arrayBuffer(), url.split("/").pop());
}

/** What this GPU can take; a ship needs RGTC (BC4/BC5) and BPTC (BC7). */
export function compressedSupport(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  return {
    rgtc: !!gl.getExtension("EXT_texture_compression_rgtc"),
    bptc: !!gl.getExtension("EXT_texture_compression_bptc"),
    s3tc: !!gl.getExtension("WEBGL_compressed_texture_s3tc"),
  };
}
