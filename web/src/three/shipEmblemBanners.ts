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
const effectRoot = "/client-assets/shipBannerLayouts/";
const parameterNames = ["Layer1Transform", "Layer2Transform", "LayerScroll", "Color"] as const;
type BannerParameters = Record<typeof parameterNames[number], readonly number[]>;

async function loadEffectParameters(): Promise<BannerParameters | null> {
  try {
    const response = await fetch(`${effectRoot}effect.json`);
    if (!response.ok) return null;
    const data = await response.json() as Partial<BannerParameters> | null;
    if (data && parameterNames.every(name => data[name]?.length === 4 && data[name].every(Number.isFinite))) {
      return data as BannerParameters;
    }
  } catch { /* older asset caches can still draw the static emblem */ }
  return null;
}

function loadEffectTextures() {
  return Promise.all([
    loadDds(`${effectRoot}hologram_interlace_p.dds`).catch(() => null),
    loadDds(`${effectRoot}hologram_noise.dds`).catch(() => null),
    loadDds(`${effectRoot}hologram_pulse.dds`).catch(() => null),
    loadEffectParameters(),
  ]);
}
let effect: ReturnType<typeof loadEffectTextures> | undefined;

async function buildShipEmblemBanners(hull: string, faction: string, images: ShipEmblemImages, bannerTime: THREE.IUniform<number>): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = "Ship emblems";
  const items = await layout(hull, faction);
  if (!items.some(item => Object.hasOwn(images, item.kind))) return group;
  const [mask, noise, pulse, parameters] = await (effect ??= loadEffectTextures());
  const animated = Boolean(mask && noise && pulse && parameters);
  const effectUniforms = parameters
    ? Object.fromEntries(parameterNames.map(name => [name, { value: new THREE.Vector4().fromArray(parameters[name]) }]))
    : {};
  await Promise.all(kindList.map(async kind => {
    if (!Object.hasOwn(images, kind)) return;
    const placements = items.filter(item => item.kind === kind);
    if (!placements.length) return;
    const image = images[kind];
    const texture = image ? await imageLoader.loadAsync(image).catch(() => null) : null;
    const logo = texture ?? await loadDds(fallback[kind]).catch(() => null);
    if (!logo) return;
    logo.colorSpace = THREE.SRGBColorSpace;
    logo.wrapS = logo.wrapT = THREE.ClampToEdgeWrapping;
    const material = new THREE.ShaderMaterial({
      defines: animated ? { ANIMATED_BANNER: 1 } : {},
      uniforms: { ...effectUniforms, bannerTime, emblemMap: { value: logo }, stripeMap: { value: mask },
        noiseMap: { value: noise }, pulseMap: { value: pulse }, hasStripe: { value: mask ? 1 : 0 },
        flipImage: { value: texture ? 0 : 1 } },
      vertexShader: `varying vec2 logoUv;
        varying vec3 viewNormal, viewToEye;
        #include <logdepthbuf_pars_vertex>
        void main() {
          logoUv = uv;
          vec4 at = modelViewMatrix * vec4(position, 1.0);
          viewNormal = normalMatrix * normal;
          viewToEye = -at.xyz;
          gl_Position = projectionMatrix * at;
          #include <logdepthbuf_vertex>
        }`,
      // banner.fx Main samples both scrolling layers in the native top-left UV convention.
      fragmentShader: `uniform sampler2D emblemMap, stripeMap, noiseMap, pulseMap;
        uniform float hasStripe, flipImage;
        uniform float bannerTime;
        uniform vec4 Layer1Transform, Layer2Transform, LayerScroll, Color;
        varying vec2 logoUv;
        varying vec3 viewNormal, viewToEye;
        #include <logdepthbuf_pars_fragment>
        vec2 facingUv(vec2 at) {
          return gl_FrontFacing ? at : vec2(1.0 - at.x, at.y);
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 uv = vec2(logoUv.x, 1.0 - logoUv.y);
          vec2 imageUv = facingUv(uv);
          vec4 logo = texture2D(emblemMap, vec2(imageUv.x, mix(1.0 - imageUv.y, imageUv.y, flipImage)));
          #ifdef ANIMATED_BANNER
            vec2 noiseUv = facingUv(uv * Layer1Transform.xy + Layer1Transform.zw) + LayerScroll.xy * bannerTime;
            vec2 pulseUv = facingUv(uv * Layer2Transform.xy + Layer2Transform.zw) + LayerScroll.zw * bannerTime;
            vec4 layers = texture2D(noiseMap, noiseUv) * texture2D(pulseMap, pulseUv);
            vec3 stripe = texture2D(stripeMap, imageUv).rgb;
            float edge = 1.0 - min(abs(dot(normalize(viewNormal), normalize(viewToEye))), 1.0);
            gl_FragColor = vec4(logo.rgb * layers.rgb * stripe * Color.rgb * (layers.a * logo.a * (1.0 + edge * edge)), 0.0);
          #else
            float stripe = mix(1.0, texture2D(stripeMap, imageUv).r, hasStripe);
            gl_FragColor = vec4(logo.rgb, logo.a * mix(0.62, 0.92, stripe));
          #endif
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: animated ? THREE.DoubleSide : THREE.FrontSide,
      forceSinglePass: true,
      ...(animated ? { toneMapped: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor } : {}),
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    material.addEventListener("dispose", () => logo.dispose());
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
  private readonly bannerTime = { value: 0 };

  setTime(seconds: number): void {
    this.bannerTime.value = seconds;
  }

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
    const layer = await buildShipEmblemBanners(hull, faction, this.images, this.bannerTime).catch(() => null);
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
