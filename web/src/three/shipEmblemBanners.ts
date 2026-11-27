import * as THREE from "three";
import type { ShipEmblemImages, ShipEmblemKind } from "../bridge/shipEmblems.ts";
import { loadDds } from "./ddsTexture.ts";

interface ShipBanner {
  readonly name: string;
  readonly kind: ShipEmblemKind;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scaling: readonly [number, number, number];
}

const layouts = new Map<string, Promise<readonly ShipBanner[]>>();
const plane = new THREE.PlaneGeometry(2, 2);

function layout(hull: string, faction: string): Promise<readonly ShipBanner[]> {
  const key = `${hull.toLowerCase()}.${faction.toLowerCase()}`;
  if (!layouts.has(key)) {
    const pending = fetch(`/client-assets/shipBannerLayouts/${key}.json`).then(response => {
      if (!response.ok) throw new Error("Ship banner layout unavailable");
      return response.json() as Promise<ShipBanner[]>;
    }).catch(() => { layouts.delete(key); return []; });
    layouts.set(key, pending);
  }
  return layouts.get(key)!;
}

const fallback = {
  alliance: "/client-assets/shipBannerLayouts/defaultalliance.dds",
  corporation: "/client-assets/shipBannerLayouts/defaultcorporation.dds",
};
const kindList = ["alliance", "corporation"] as const;
const imageLoader = new THREE.TextureLoader();
let interlace: Promise<THREE.Texture | null> | undefined;

async function buildShipEmblemBanners(hull: string, faction: string, images: ShipEmblemImages): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = "Ship emblems";
  const items = await layout(hull, faction);
  if (!items.some(item => Object.hasOwn(images, item.kind))) return group;
  interlace ??= loadDds("/client-assets/shipBannerLayouts/hologram_interlace_p.dds").catch(() => null);
  const mask = await interlace;
  await Promise.all(kindList.map(async kind => {
    if (!Object.hasOwn(images, kind)) return;
    const placements = items.filter(item => item.kind === kind);
    if (!placements.length) return;
    const image = images[kind];
    const texture = image ? await imageLoader.loadAsync(image).catch(() => null) : null;
    const logo = texture ?? await loadDds(fallback[kind]).catch(() => null);
    if (!logo) return;
    logo.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.ShaderMaterial({
      uniforms: { emblemMap: { value: logo }, stripeMap: { value: mask }, hasStripe: { value: mask ? 1 : 0 },
        flipImage: { value: texture ? 0 : 1 } },
      vertexShader: `varying vec2 logoUv;
        #include <logdepthbuf_pars_vertex>
        void main() {
          logoUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `uniform sampler2D emblemMap, stripeMap;
        uniform float hasStripe, flipImage;
        varying vec2 logoUv;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec4 logo = texture2D(emblemMap, vec2(logoUv.x, mix(logoUv.y, 1.0 - logoUv.y, flipImage)));
          float stripe = mix(1.0, texture2D(stripeMap, vec2(logoUv.x, 1.0 - logoUv.y)).r, hasStripe);
          gl_FragColor = vec4(logo.rgb, logo.a * mix(0.62, 0.92, stripe));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    material.addEventListener("dispose", () => texture?.dispose());
    for (const item of placements) {
      const mesh = new THREE.Mesh(plane, material);
      mesh.name = item.name;
      mesh.userData.emblemKind = kind;
      mesh.position.set(item.position[0], item.position[1], -item.position[2]);
      mesh.quaternion.set(-item.rotation[0], -item.rotation[1], item.rotation[2], item.rotation[3]);
      mesh.scale.set(...item.scaling);
      group.add(mesh);
    }
  }));
  return group;
}

function disposeShipEmblemBanners(group: THREE.Group | null): void {
  if (!group) return;
  group.removeFromParent();
  const materials = new Set<THREE.Material>();
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) materials.add(child.material as THREE.Material);
  }
  materials.forEach(material => material.dispose());
}

/** Owns the emblem overlay for one scene, including reads retired by a model or fitting change. */
export class ShipEmblemLayer {
  private model: THREE.Object3D | null = null;
  private images: ShipEmblemImages = {};
  private layer: THREE.Group | null = null;
  private revision = 0;

  setModel(model: THREE.Object3D | null): void {
    if (model === this.model) return;
    disposeShipEmblemBanners(this.layer);
    this.layer = null;
    this.model = model;
    void this.update();
  }

  setImages(images: ShipEmblemImages): void {
    if (images.alliance === this.images.alliance && images.corporation === this.images.corporation) return;
    this.images = images;
    for (const child of this.layer?.children ?? []) {
      child.visible = Object.hasOwn(images, child.userData.emblemKind);
    }
    void this.update();
  }

  private async update(): Promise<void> {
    const revision = ++this.revision;
    const model = this.model;
    const hull: unknown = model?.userData.hull;
    const faction: unknown = model?.userData.faction;
    if (!model || typeof hull !== "string" || typeof faction !== "string" || !Object.keys(this.images).length) {
      disposeShipEmblemBanners(this.layer);
      this.layer = null;
      return;
    }
    const layer = await buildShipEmblemBanners(hull, faction, this.images).catch(() => null);
    if (!layer) return;
    if (revision !== this.revision || !layer.children.length) {
      disposeShipEmblemBanners(layer);
      return;
    }
    disposeShipEmblemBanners(this.layer);
    this.layer = layer;
    model.add(layer);
  }
}
