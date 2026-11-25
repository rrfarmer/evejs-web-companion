import * as THREE from "three";
import { compressedSupport, loadDds } from "./ddsTexture.ts";

export async function loadPortraitBackdrop(renderer: THREE.WebGLRenderer, url: string, isDds: boolean): Promise<THREE.Texture> {
  let texture: THREE.Texture;
  if (isDds) {
    const dds = await loadDds(url);
    const support = compressedSupport(renderer);
    const s3tc = dds.format === THREE.RGB_S3TC_DXT1_Format ||
      dds.format === THREE.RGBA_S3TC_DXT1_Format || dds.format === THREE.RGBA_S3TC_DXT5_Format;
    if ((dds.format === THREE.RGBA_BPTC_Format && !support.bptc) || (s3tc && !support.s3tc)) {
      dds.dispose();
      throw new Error("Unsupported portrait backdrop format");
    }
    dds.repeat.y = -1;
    dds.offset.y = 1;
    texture = dds;
  } else {
    texture = await new THREE.TextureLoader().loadAsync(url);
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
