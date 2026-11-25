import { LinearFilter, RepeatWrapping, SRGBColorSpace, type CompressedTexture, type Texture, type WebGLRenderer } from "three";
import type { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { loadDds, mipRange, mipSkipFor } from "./ddsTexture";

let capableRenderer: WeakRef<WebGLRenderer> | undefined;
let loader: Promise<KTX2Loader> | undefined;

export function useHullTextureRenderer(renderer: WebGLRenderer): void {
  if (renderer.extensions.has("EXT_texture_compression_bptc")) capableRenderer = new WeakRef(renderer);
}

export async function loadHullAlbedo(url: string): Promise<Texture> {
  const renderer = capableRenderer?.deref();
  if (renderer) {
    try {
      const ready = loader ??= import("three/addons/loaders/KTX2Loader.js")
        .then(({ KTX2Loader }) => new KTX2Loader().detectSupport(renderer).setWorkerLimit(2));
      const candidate = await (await ready).loadAsync(url + ".ktx2") as CompressedTexture;
      const { width, height } = candidate.image;
      const skip = mipRange(width, height, candidate.mipmaps.length, mipSkipFor(url));
      if (skip) {
        candidate.mipmaps = candidate.mipmaps.slice(skip);
        const first = candidate.mipmaps[0]!;
        candidate.image = { width: first.width, height: first.height };
      }
      if (candidate.mipmaps.length === 1) candidate.minFilter = LinearFilter;
      candidate.wrapS = candidate.wrapT = RepeatWrapping;
      candidate.colorSpace = SRGBColorSpace;
      candidate.name = url.slice(url.lastIndexOf("/") + 1);
      candidate.needsUpdate = true;
      return candidate;
    } catch {
      // The DDS is still served if the converted texture or worker is unavailable.
    }
  }
  return loadDds(url);
}
