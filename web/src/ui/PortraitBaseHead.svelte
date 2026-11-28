<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
  import type { PortraitFraming } from "../app/flow.ts";
  import type { PortraitApparel, PortraitFrame, PortraitHairTints, PortraitMakeup, PortraitMorph, PortraitSkinTone } from "../app/api.ts";
  import { compositePortraitColorLayer, type PortraitColorLayer } from "../three/portraitMakeup.ts";
  import { compositePortraitImplant, compositePortraitScalpFinish, type PortraitCroppedTexture, type PortraitImplantMaps,
    type PortraitSurfaceFinish } from "../three/portraitImplant.ts";
  import { applyPortraitHairFinish } from "../three/portraitHairFinish.ts";
  import { applyPortraitMorphs, loadOutfitMorphNames } from "../three/portraitMorphs.ts";
  import { compressedSupport, loadDds } from "../three/ddsTexture";
  import { loadPortraitBackdrop } from "../three/portraitBackdrop.ts";
  import { capturePointer } from "./pointerCapture.ts";

  let { model, backdropUrl, backdropIsDds = false, bloodlineID, framing, fieldOfView, hasSkinTones = false, skinColors, hairstyle, hairTints, outfit, robeHood = 0, waistTuck = 0, apparel, morphs, piercings, iris, makeup, facialHairScale, onOutfitMorphs }: {
    model: "female" | "male";
    backdropUrl?: string;
    backdropIsDds?: boolean;
    bloodlineID?: number | null;
    framing?: PortraitFraming | null;
    fieldOfView?: number;
    hasSkinTones?: boolean;
    skinColors?: PortraitSkinTone["colors"];
    hairstyle?: string;
    hairTints?: PortraitHairTints;
    outfit?: string;
    robeHood?: number;
    waistTuck?: number;
    apparel?: PortraitApparel;
    morphs?: readonly PortraitMorph[];
    piercings?: readonly string[];
    iris?: string;
    makeup?: readonly PortraitMakeup[];
    facialHairScale?: number;
    onOutfitMorphs?: (names: ReadonlySet<string>) => void;
  } = $props();
  const visibleHairstyle = $derived(outfit && robeHood > 0 ? undefined : hairstyle);
  const hasEyewearHairFit = $derived(/\/(?:glasses_(?:pilot|slick)_01|goggles_01)\//.test(apparel?.["accessories/glasses"] ?? ""));
  let outfitHairFit = $state.raw<{ source: string; weight: number } | null>(null);
  const hairLift = $derived(outfitHairFit && outfitHairFit.source === outfit ? outfitHairFit.weight : 0);
  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<THREE.WebGLRenderer | null>(null);
  let display = $state<"loading" | "ready" | "unavailable">("loading");
  let backdropDisplay = $state<"loading" | "ready" | "unavailable">("loading");
  type LoadState = "loading" | "ready" | "unavailable";
  type ColorLayerAsset = {
    diffuse: string;
    zones?: string;
    colors: [number, number, number][];
    diffuseRect: number[];
    zonesRect?: number[];
  };
  type CroppedMapAsset = { url: string; rect: number[] };
  type FinishAsset = { normal?: CroppedMapAsset; specular?: CroppedMapAsset };
  type ColorizedScalpAsset = ColorLayerAsset & { finish?: FinishAsset };
  type ImplantAsset = { implant: true; diffuse: CroppedMapAsset; normal: CroppedMapAsset; specular: CroppedMapAsset };
  let meshHairDisplay = $state<LoadState>("loading");
  let scalpDisplay = $state<LoadState>("ready");
  let scalpAsset = $state.raw<ColorizedScalpAsset | ImplantAsset | null>(null);
  const hairDisplay = $derived(meshHairDisplay === "unavailable" || scalpDisplay === "unavailable" ? "unavailable"
    : meshHairDisplay === "loading" || scalpDisplay === "loading" ? "loading" : "ready");
  let outfitDisplay = $state<"loading" | "ready" | "unavailable">("loading");
  let headBounds = $state.raw<THREE.Box3 | null>(null);
  let outfitBounds = $state.raw<THREE.Box3 | null>(null);
  let hairBounds = $state.raw<THREE.Box3 | null>(null);
  let viewportAspect = $state(1);
  let yaw = $state(0), pitch = $state(0), zoom = $state(1), pan = $state(0);
  let drag: { id: number; x: number; y: number; pan: boolean } | null = null;
  type SkinUniforms = {
    portraitSkinDetail: { value: THREE.Texture };
    portraitSkinZone: { value: THREE.Texture };
    portraitSkinColors: { value: THREE.Color[] };
    portraitSkinStrength: { value: number };
  };
  let skinUniforms = $state.raw<SkinUniforms | null>(null);
  let facialHairTints = $state.raw<{ color: THREE.Color; baseline: THREE.Color }[]>([]);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
  const cameraTarget = new THREE.Vector3();
  const key = new THREE.DirectionalLight(0xffede3, 2.2);
  key.position.set(-2, 2, -3);
  const fill = new THREE.DirectionalLight(0xd6ecff, 1);
  fill.position.set(2, 0.6, -2);
  scene.add(key, fill, new THREE.HemisphereLight(0xe2eefa, 0x544447, 1.1));
  const loader = new GLTFLoader();

  export function readPortraitFrame(): PortraitFrame | null {
    if (display !== "ready" || backdropDisplay !== "ready" || (visibleHairstyle && hairDisplay !== "ready")) return null;
    const native = ({ x, y, z }: THREE.Vector3): PortraitFrame["position"] => [x, y, -z];
    return { position: native(camera.position), target: native(cameraTarget) };
  }

  export function capturePortrait(): string {
    const active = renderer;
    if (!active || !readPortraitFrame()) throw new Error("Wait for the portrait preview to finish loading.");
    const jpegPrefix = "data:image/jpeg;base64,";
    // portraitMaker writes a 512px square snapshot. The live preview uses a smaller drawing buffer.
    active.setSize(512, 512, false);
    try {
      active.render(scene, camera);
      for (const quality of [0.9, 0.75, 0.6]) {
        const image = canvas.toDataURL("image/jpeg", quality);
        if (image.startsWith(jpegPrefix) && image.length <= 60_000 + jpegPrefix.length) return image.slice(jpegPrefix.length);
      }
      throw new Error("The portrait could not be encoded as a JPEG.");
    } finally {
      active.setSize(384, 384, false);
      active.render(scene, camera);
    }
  }

  function applySurface(object: THREE.Object3D, surface: THREE.Material, transparent: ReadonlySet<string>,
    eyelashMeshes: ReadonlySet<string>, eyelashes: THREE.Material | null, skin: THREE.Material): void {
    const materials = new Set<THREE.Material>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material);
        }
        const overlay = eyelashMeshes.has(node.name) ? eyelashes : null;
        node.material = overlay ?? (node.name === "meshShape" ? skin : surface);
        node.visible = overlay !== null || !transparent.has(node.name);
      }
    });
    for (const material of materials) material.dispose();
  }

  function applyOutfitPalette(material: THREE.MeshStandardMaterial, zones: THREE.Texture, colors: THREE.Color[]): void {
    material.onBeforeCompile = shader => {
      shader.uniforms.outfitZones = { value: zones };
      shader.uniforms.outfitColors = { value: colors };
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
        #include <map_pars_fragment>
        uniform sampler2D outfitZones;
        uniform vec3 outfitColors[3];
      `).replace("#include <map_fragment>", `
        #include <map_fragment>
        vec3 zones = texture2D(outfitZones, vMapUv).rgb;
        float coverage = dot(zones, vec3(1.0));
        vec3 tint = zones.r * outfitColors[0] + zones.g * outfitColors[1] + zones.b * outfitColors[2];
        diffuseColor.rgb *= mix(vec3(1.0), tint / max(coverage, 0.001), clamp(coverage, 0.0, 1.0));
      `);
    };
    material.customProgramCacheKey = () => "portrait-outfit-palette";
  }

  function release(object: THREE.Object3D): void {
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Skeleton>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        resources.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) resources.add(material);
      }
      if (node instanceof THREE.SkinnedMesh) resources.add(node.skeleton);
    });
    for (const resource of resources) resource.dispose();
  }

  async function loadMap(path: string, color: boolean): Promise<{ bitmap: ImageBitmap; texture: THREE.Texture }> {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      premultiplyAlpha: "none", colorSpaceConversion: "none",
    });
    const texture = new THREE.Texture(bitmap);
    // Granny's UVs address the top row at v=0. The native atlas transform
    // places this same local head map in the upper-right region of the atlas.
    texture.flipY = false;
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
    return { bitmap, texture };
  }

  async function loadCroppedTexture(asset: CroppedMapAsset, maps: Awaited<ReturnType<typeof loadMap>>[],
    retired: () => boolean, color = false): Promise<PortraitCroppedTexture> {
    if (retired()) throw new Error("Portrait load retired");
    const map = await loadMap(asset.url, color);
    if (retired()) {
      map.texture.dispose();
      map.bitmap.close();
      throw new Error("Portrait load retired");
    }
    maps.push(map);
    return { texture: map.texture, rect: new THREE.Vector4().fromArray(asset.rect) };
  }

  async function loadFinish(assets: FinishAsset | undefined, maps: Awaited<ReturnType<typeof loadMap>>[],
    retired: () => boolean): Promise<PortraitSurfaceFinish> {
    const finish: PortraitSurfaceFinish = {};
    for (const [role, asset] of [["Normal", assets?.normal], ["Specular", assets?.specular]] as const) {
      const map = asset && await loadCroppedTexture(asset, maps, retired).catch(() => null);
      if (map) finish[role] = map;
    }
    return finish;
  }

  onMount(() => {
    let viewport: ResizeObserver | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(384, 384, false);
      renderer.setClearColor(0x171e1e);
      if (outfit) {
        canvas.addEventListener("wheel", wheel, { passive: false });
        viewport = new ResizeObserver(([entry]) => {
          if (!entry || !renderer) return;
          const { width, height } = entry.contentRect;
          if (width < 1 || height < 1) return;
          const scale = Math.min(1, 768 / Math.max(width, height));
          renderer.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), false);
          viewportAspect = width / height;
          if (outfitDisplay === "ready" && display === "ready") renderer.render(scene, camera);
        });
        viewport.observe(canvas);
      }
    } catch {
      display = "unavailable";
    }
    return () => {
      viewport?.disconnect();
      canvas.removeEventListener("wheel", wheel);
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  });

  $effect(() => {
    const active = renderer;
    const gender = model;
    const style = visibleHairstyle;
    const tints = hairTints;
    const fullBody = Boolean(outfit);
    const fitEyewear = hasEyewearHairFit;
    const lift = hairLift;
    if (!active) return;
    if (!style) {
      active.render(scene, camera);
      return;
    }
    let retired = false;
    let hair: THREE.Group | null = null;
    let texture: THREE.Texture | null = null;
    let bitmap: ImageBitmap | null = null;
    const finishMaps: Awaited<ReturnType<typeof loadMap>>[] = [];
    meshHairDisplay = "loading";
    void (async () => {
      const stem = `/client-assets/portrait-hair/${gender}/${style}`;
      const response = await fetch(stem + ".json");
      if (!response.ok) throw new Error("Portrait hairstyle unavailable");
      const { diffuse, rgb, scalp, meshFinish, meshZones } = await response.json() as {
        diffuse?: string;
        rgb: [number, number, number];
        scalp?: Omit<ColorizedScalpAsset, "colors"> | ImplantAsset;
        meshFinish?: FinishAsset;
        meshZones?: CroppedMapAsset;
      };
      if (retired) return;
      const colors = [tints?.primary ?? rgb, tints?.secondary?.[0] ?? rgb, tints?.secondary?.[1] ?? rgb];
      if (scalp) {
        scalpDisplay = "loading";
        scalpAsset = "implant" in scalp ? scalp : { ...scalp, colors };
      }
      if (!diffuse) {
        if (!scalp) throw new Error("Portrait hairstyle has no materials");
        meshHairDisplay = "ready";
        return;
      }
      const dds = diffuse.endsWith(".dds");
      if (dds && !compressedSupport(active).s3tc) throw new Error("Unsupported hair detail format");
      const loaded = dds ? { texture: await loadDds(diffuse), bitmap: null } : await loadMap(diffuse, true);
      const detail = loaded.texture;
      if (retired) { detail.dispose(); loaded.bitmap?.close(); return; }
      texture = detail;
      bitmap = loaded.bitmap;
      detail.colorSpace = THREE.SRGBColorSpace;
      detail.wrapS = detail.wrapT = THREE.ClampToEdgeWrapping;
      const finish = await loadFinish(meshFinish, finishMaps, () => retired);
      const zones = tints && meshZones ? await loadCroppedTexture(meshZones, finishMaps, () => retired).catch(() => null) : null;
      if (retired) return;
      const { scene: object } = await loader.loadAsync(stem + ".glb");
      const fit: PortraitMorph[] = [];
      if (fitEyewear) fit.push({ name: "pushhairglassesshape", weight: 1 });
      if (lift) fit.push({ name: "pushhairupshape", weight: lift });
      if (!retired) await applyPortraitMorphs(object, stem, fit, () => retired);
      if (retired) { release(object); return; }
      hair = object;
      const surface = new THREE.MeshStandardMaterial({
        map: detail, color: zones ? 0xffffff : new THREE.Color().setRGB(...colors[0]!, THREE.SRGBColorSpace),
        side: THREE.DoubleSide, roughness: 0.8, alphaTest: 0.20, alphaToCoverage: true,
      });
      if (finish.Normal || finish.Specular || zones) applyPortraitHairFinish(surface, finish, zones,
        colors.map(color => new THREE.Color().setRGB(...color, THREE.SRGBColorSpace)));
      applySurface(hair, surface, new Set(), new Set(), null, surface);
      scene.add(hair);
      if (fullBody) {
        hair.updateMatrixWorld(true);
        hairBounds = new THREE.Box3().setFromObject(hair, true);
      }
      active.render(scene, camera);
      meshHairDisplay = "ready";
    })().catch(() => { if (!retired) meshHairDisplay = "unavailable"; });
    return () => {
      retired = true;
      if (hair) {
        scene.remove(hair);
        release(hair);
      }
      hairBounds = null;
      scalpAsset = null;
      scalpDisplay = "ready";
      texture?.dispose();
      bitmap?.close();
      for (const map of finishMaps) {
        map.texture.dispose();
        map.bitmap.close();
      }
    };
  });

  $effect(() => {
    const active = renderer;
    const source = outfit;
    const hood = robeHood;
    const tucked = waistTuck === 1;
    const extra = apparel;
    const gender = model;
    const bodyMorphs = morphs?.filter(morph => morph.body) ?? [];
    const publishMorphs = onOutfitMorphs;
    if (!active || !source) return;
    let retired = false;
    let body: THREE.Group | null = null;
    const bodyModels = new Set<string>();
    const maps: { texture: THREE.Texture; bitmap?: ImageBitmap }[] = [];
    const texture = async (url: string | null, color: boolean): Promise<THREE.Texture | null> => {
      if (!url) return null;
      const map = url.endsWith(".dds") ? { texture: await loadDds(url), bitmap: undefined } : await loadMap(url, color);
      if (color) map.texture.colorSpace = THREE.SRGBColorSpace;
      if (retired) {
        map.bitmap?.close();
        map.texture.dispose();
        return null;
      }
      maps.push(map);
      return map.texture;
    };
    outfitDisplay = "loading";
    outfitBounds = null;
    type WaistTuck = { source: string; occludes: string[]; model?: string; mask?: CroppedMapAsset };
    type Garment = {
      model: string; diffuse: string | null; zones: string | null; normal: string | null;
      colors: [number, number, number, number][]; occludes: string[]; skinMeshes: string[];
      skinBase?: string; bodyParts?: string[]; bodyPartWeights?: Record<string, number>; hoods?: string[];
      trouserFit?: readonly PortraitMorph[]; outfitFit?: readonly PortraitMorph[];
      fitOcclusions?: Record<string, readonly PortraitMorph[]>;
      waistTuck?: WaistTuck;
      bootMask?: CroppedMapAsset; bodyCutout?: CroppedMapAsset; innerSleeve?: string;
      diffuseRect?: number[]; zonesRect?: number[]; normalRect?: number[];
    };
    const manifest = async (url: string): Promise<Garment> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Outfit unavailable");
      return await response.json() as Garment;
    };
    let skin: THREE.MeshStandardMaterial | undefined;
    let garmentFit: readonly PortraitMorph[] = [];
    const bodyPartOcclusions = new Map<string, number>();
    const loadBodyModel = async (path: string): Promise<THREE.Group | null> => {
      const { scene: mesh } = await loader.loadAsync(path);
      bodyModels.add(path);
      if (!retired) {
        const catalog = garmentFit.length ? await loadOutfitMorphNames(path) : [];
        const supportedFit = garmentFit.filter(morph => catalog.includes(morph.name));
        if (!retired) await applyPortraitMorphs(mesh, path.replace(/\.glb$/, ""), [...bodyMorphs, ...supportedFit], () => retired);
      }
      if (!retired) return mesh;
      release(mesh);
      return null;
    };
    const applyGarmentCutout = (shader: Parameters<THREE.MeshStandardMaterial["onBeforeCompile"]>[0], mask: PortraitCroppedTexture,
      uv: "vMapUv" | "vUv" = "vMapUv", name: "outfitBootMask" | "outfitWaistMask" = "outfitBootMask") => {
      shader.uniforms[name] = { value: mask.texture };
      shader.uniforms[`${name}Rect`] = { value: mask.rect };
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
        #include <map_pars_fragment>
        uniform sampler2D ${name};
        uniform vec4 ${name}Rect;
      `).replace("#include <alphatest_fragment>", `
        #include <alphatest_fragment>
        vec2 ${name}UV = (${uv} - ${name}Rect.xy) / ${name}Rect.zw;
        if (all(greaterThanEqual(${name}UV, vec2(0.0))) && all(lessThanEqual(${name}UV, vec2(1.0))) &&
            texture2D(${name}, ${name}UV).a >= 0.5) discard;
      `);
    };
    const loadGarmentMaterial = async (data: Garment, cutout: PortraitCroppedTexture | null, waistMask?: PortraitCroppedTexture) => {
      const diffuse = await texture(data.diffuse, true);
      const zones = data.colors.length === 3 ? await texture(data.zones, false) : null;
      const normal = await texture(data.normal, false);
      const skinBase = data.skinBase ? await texture(data.skinBase, true) : null;
      if (retired) return null;
      const cropped = Boolean(diffuse && (skinBase || data.diffuseRect));
      const garment = new THREE.MeshStandardMaterial({ map: diffuse, normalMap: normal, roughness: 0.68, side: THREE.DoubleSide });
      garment.onBeforeCompile = shader => {
        if (cropped) {
          const rect = (rect?: number[]) => new THREE.Vector4().fromArray(rect ?? [0, 0, 1, 1]);
          if (skinBase) shader.uniforms.shirtSkin = { value: skinBase };
          shader.uniforms.shirtDiffuseRect = { value: rect(data.diffuseRect) };
          shader.uniforms.shirtZonesRect = { value: rect(data.zonesRect) };
          shader.uniforms.shirtNormalRect = { value: rect(data.normalRect) };
          if (zones) {
            shader.uniforms.outfitZones = { value: zones };
            shader.uniforms.outfitColors = { value: data.colors.map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)) };
          }
          shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
            #include <map_pars_fragment>
            ${skinBase ? "uniform sampler2D shirtSkin;" : ""}
            uniform vec4 shirtDiffuseRect;
            uniform vec4 shirtZonesRect;
            uniform vec4 shirtNormalRect;
            ${zones ? "uniform sampler2D outfitZones; uniform vec3 outfitColors[3];" : ""}
            vec2 shirtUV(vec2 uv, vec4 bounds) { return (uv - bounds.xy) / bounds.zw; }
            float shirtClip(vec2 uv) { return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0); }
          `).replace("#include <map_fragment>", `
            vec2 shirtSampleUV = shirtUV(vMapUv, shirtDiffuseRect);
            vec4 shirtFabric = texture2D(map, shirtSampleUV);
            float shirtAlpha = shirtFabric.a * shirtClip(shirtSampleUV);
            ${zones ? `
              vec2 zoneUV = shirtUV(vMapUv, shirtZonesRect);
              vec3 zones = texture2D(outfitZones, zoneUV).rgb * shirtClip(zoneUV);
              float coverage = dot(zones, vec3(1.0));
              vec3 tint = zones.r * outfitColors[0] + zones.g * outfitColors[1] + zones.b * outfitColors[2];
              shirtFabric.rgb *= mix(${skinBase ? "outfitColors[0]" : "vec3(1.0)"}, tint / max(coverage, 0.001), clamp(coverage, 0.0, 1.0));
            ` : ""}
            diffuseColor.rgb *= ${skinBase ? "mix(texture2D(shirtSkin, vMapUv).rgb, shirtFabric.rgb, shirtAlpha)" : "shirtFabric.rgb"};
          `);
        } else if (zones && diffuse) {
          shader.uniforms.outfitZones = { value: zones };
          shader.uniforms.outfitColors = { value: data.colors.map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)) };
          shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
            #include <map_pars_fragment>
            uniform sampler2D outfitZones;
            uniform vec3 outfitColors[3];
          `).replace("#include <map_fragment>", `
            #include <map_fragment>
            vec3 zones = texture2D(outfitZones, vMapUv).rgb;
            float coverage = dot(zones, vec3(1.0));
            vec3 tint = zones.r * outfitColors[0] + zones.g * outfitColors[1] + zones.b * outfitColors[2];
            diffuseColor.rgb *= mix(vec3(1.0), tint / max(coverage, 0.001), clamp(coverage, 0.0, 1.0));
          `);
        }
        if (cutout && diffuse) applyGarmentCutout(shader, cutout);
        if (waistMask && diffuse) applyGarmentCutout(shader, waistMask, "vMapUv", "outfitWaistMask");
        if (normal) shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
          THREE.ShaderChunk.normal_fragment_maps.replace(
            "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
            `${cropped ? `
              vec2 normalUV = shirtUV(vNormalMapUv, shirtNormalRect);
              vec2 xy = (texture2D(normalMap, normalUV).ag * 2.0 - 1.0) * ${skinBase ? "shirtAlpha * " : ""}shirtClip(normalUV);
            ` : "vec2 xy = texture2D(normalMap, vNormalMapUv).ag * 2.0 - 1.0;"}
            vec3 mapN = vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));`));
      };
      garment.customProgramCacheKey = () => `outfit:${Boolean(zones && diffuse)}:${Boolean(normal)}:${Boolean(skinBase)}:${cropped}:${Boolean(cutout)}:${Boolean(waistMask)}`;
      return garment;
    };
    const loadGarment = async (data: Garment, group: THREE.Group, mask?: CroppedMapAsset, tights?: Garment, innerSleeve?: string,
      waist?: WaistTuck) => {
      const embeddedLegs = data.skinMeshes?.includes("LegsShape");
      const cutout = mask ? await loadCroppedTexture(mask, maps, () => retired) : null;
      const waistMask = waist?.mask ? await loadCroppedTexture(waist.mask, maps, () => retired) : undefined;
      const object = await loadBodyModel(data.model);
      if (!object) return;
      group.add(object);
      const hoodMesh = data.hoods?.[hood];
      const parts = new Set([...(data.bodyParts ?? []), ...(hoodMesh ? [hoodMesh] : [])].filter(path => {
        const [part, file] = path.split("/").slice(-2);
        const group = `dependants/${part}`;
        const groupWeight = bodyPartOcclusions.get(group) ?? 0;
        const weight = data.bodyPartWeights?.[path];
        if (weight === undefined) return groupWeight < 1;
        const partWeight = bodyPartOcclusions.get(`${group}/${file.replace(/\.glb$/, "")}`) ?? 0;
        return weight > groupWeight + partWeight;
      }));
      if (innerSleeve && !data.bodyPartWeights) parts.add(innerSleeve);
      for (const path of parts) {
        const part = await loadBodyModel(path);
        if (!part) return;
        object.add(part);
      }
      const garment = await loadGarmentMaterial(data, embeddedLegs ? null : cutout, waistMask);
      if (!garment) return;
      const legSurface = embeddedLegs && tights ? await loadGarmentMaterial(tights, cutout).catch(error => {
        garment.dispose();
        throw error;
      }) : null;
      if (retired) {
        garment.dispose();
        legSurface?.dispose();
        return;
      }
      const original = new Set<THREE.Material>();
      object.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) original.add(material);
        const name = node.name.replace(/_\d+$/, "");
        const bareSkin = data.skinMeshes?.includes(name) || /^skin/i.test(name);
        if (name === "LegsShape" && legSurface) node.material = legSurface;
        else if (bareSkin && skin) {
          const surface = skin.clone();
          if (cutout && (!embeddedLegs || name === "LegsShape")) {
            surface.defines = { ...surface.defines, USE_UV: "" };
            surface.onBeforeCompile = shader => applyGarmentCutout(shader, cutout, "vUv");
            surface.customProgramCacheKey = () => "outfit:skin:cutout";
          }
          node.material = surface;
        } else node.material = garment;
      });
      original.forEach(material => material.dispose());
      if (waist?.model) {
        const piece = await loadBodyModel(waist.model);
        if (!piece) return;
        group.add(piece);
        const underlay = await loadGarmentMaterial(data, null);
        if (underlay) applySurface(piece, underlay, new Set(), new Set(), null, underlay);
      }
    };
    void (async () => {
      const outer = await manifest(source);
      const worn = [outer];
      const occludes = new Set(outer.occludes);
      if (!outer.skinBase) {
        for (const slot of ["topouter", "topmiddle"] as const) {
          const url = extra?.[slot];
          if (occludes.has(slot) || source === url) continue;
          if (!url) {
            if (slot === "topmiddle") throw new Error("This outfit requires an additional top layer");
            continue;
          }
          const layer = await manifest(url);
          worn.unshift(layer);
          for (const name of layer.occludes) occludes.add(name);
        }
      }
      const upperUnderlayers = outer.bodyCutout ? new Set(worn.filter(layer => layer !== outer)) : null;
      let legwear: Garment | undefined;
      let footwear: Garment | undefined;
      for (const slot of ["bottomouter", "feet"] as const) {
        if (occludes.has(slot)) continue;
        const url = extra?.[slot] ?? (slot === "bottomouter" && !occludes.has("bottommiddle") ? extra?.bottommiddle : undefined);
        if (!url) throw new Error("This outfit requires additional apparel layers");
        const layer = await manifest(url);
        if (slot === "bottomouter") legwear = layer;
        if (slot === "feet") footwear = layer;
        worn.push(layer);
        for (const name of layer.occludes) occludes.add(name);
      }
      const skinDetail = await texture(`/client-assets/graphics/character/${gender}/paperdoll/skintone/basic/colorize_body_l_512.png`, true).catch(() => null);
      if (retired) return;
      const fitWeights = new Map<string, number>();
      for (const layer of worn) for (const { name, weight } of layer.outfitFit ?? layer.trouserFit ?? []) {
        fitWeights.set(name, Math.max(weight, fitWeights.get(name) ?? weight));
      }
      const occlusionRules: Record<string, readonly PortraitMorph[]> = Object.assign({}, ...worn.map(layer => layer.fitOcclusions));
      const tuck = tucked ? legwear?.waistTuck : undefined;
      if (tuck) delete occlusionRules[tuck.source];
      const occludedFit = new Map<string, number>();
      for (const rules of Object.values(occlusionRules)) for (const { name, weight } of rules) {
        occludedFit.set(name, (occludedFit.get(name) ?? 0) + weight);
      }
      const legacyRules = [...worn.filter(layer => !layer.fitOcclusions).flatMap(layer => layer.occludes), ...(tuck?.occludes ?? [])];
      for (const rule of legacyRules) {
        const match = /^utilityshapes\/([a-z0-9_]+shape)(?:#(-?\d+(?:\.\d+)?))?$/i.exec(rule);
        if (!match) continue;
        const name = match[1].toLowerCase();
        occludedFit.set(name, (occludedFit.get(name) ?? 0) + Number(match[2] ?? 1));
      }
      const resolvedFit = [...fitWeights].map(([name, weight]) => ({ name, weight: Math.min(1, weight - (occludedFit.get(name) ?? 0)) }));
      outfitHairFit = { source, weight: resolvedFit.find(morph => morph.name === "pushhairupshape")?.weight ?? 0 };
      garmentFit = resolvedFit.filter(morph => morph.name !== "pushhairupshape" && morph.weight !== 0);
      for (const rule of [...worn.flatMap(layer => layer.occludes), ...(tuck?.occludes ?? [])]) {
        const [path, rawWeight = "1"] = rule.toLowerCase().split("#");
        const weight = Number(rawWeight);
        if (path.startsWith("dependants/") && Number.isFinite(weight)) {
          bodyPartOcclusions.set(path, (bodyPartOcclusions.get(path) ?? 0) + weight);
        }
      }
      skin = new THREE.MeshStandardMaterial({ map: skinDetail, color: skinDetail ? 0xffffff : 0xb59280, roughness: 0.78 });
      body = new THREE.Group();
      const tights = legwear?.skinMeshes?.includes("LegsShape") && !occludes.has("bottommiddle") && extra?.bottommiddle
        ? await manifest(extra.bottommiddle) : undefined;
      for (const layer of worn) {
        const isLegwear = layer === legwear;
        const isUnderlayer = upperUnderlayers?.has(layer);
        const cutout = isLegwear ? footwear?.bootMask : isUnderlayer ? outer.bodyCutout : undefined;
        await loadGarment(layer, body, cutout, isLegwear ? tights : undefined, isUnderlayer && layer.skinBase ? outer.innerSleeve : undefined,
          layer.skinBase && layer.model.endsWith("/torso.glb") ? tuck : undefined);
      }
      if (retired) return;
      if (!occludes.has("hands") && !occludes.has("hand")) {
        const hands = await loadBodyModel(`/client-assets/portrait-outfit/${gender}/hands.glb`);
        if (!hands) return;
        hands.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
          node.material = skin!.clone();
        });
        body.add(hands);
      }
      body.updateMatrixWorld(true);
      outfitBounds = new THREE.Box3().setFromObject(body, true);
      scene.add(body);
      outfitDisplay = "ready";
      if (publishMorphs) {
        const catalogs = await Promise.all([...bodyModels].map(loadOutfitMorphNames));
        if (!retired) publishMorphs(new Set(catalogs.flat()));
      }
    })().catch(() => { if (!retired) outfitDisplay = "unavailable"; });
    return () => {
      retired = true;
      if (body) { scene.remove(body); release(body); }
      skin?.dispose();
      for (const map of maps) { map.texture.dispose(); map.bitmap?.close(); }
    };
  });

  function startDrag(event: PointerEvent): void {
    if (!outfit || (event.button !== 0 && event.button !== 2)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 2 };
    capturePointer(canvas, event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.pan) pan = THREE.MathUtils.clamp(pan + dy / Math.max(1, canvas.clientHeight), -0.5, 0.5);
    else {
      yaw = (yaw - dx * 0.012) % (2 * Math.PI);
      pitch = THREE.MathUtils.clamp(pitch + dy * 0.009, 0, Math.PI / 2 - 0.02);
    }
  }

  function endDrag(event: PointerEvent): void {
    if (drag?.id === event.pointerId) drag = null;
  }

  function wheel(event: WheelEvent): void {
    if (!outfit) return;
    event.preventDefault();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom = THREE.MathUtils.clamp(zoom * Math.exp(Math.sign(amount) * Math.min(Math.abs(amount), 250) * 0.0015), 0.42, 2.5);
  }

  $effect(() => {
    const active = renderer;
    const bounds = headBounds;
    const saved = framing;
    const fov = fieldOfView;
    const tint = skinUniforms;
    const colors = skinColors;
    if (!active || !bounds) return;
    if (facialHairScale !== undefined) {
      for (const { color, baseline } of facialHairTints) color.copy(baseline).convertLinearToSRGB()
        .multiplyScalar(facialHairScale).convertSRGBToLinear();
    }
    if (tint) {
      tint.portraitSkinStrength.value = colors ? 1 : 0;
      colors?.forEach((rgb, index) => tint.portraitSkinColors.value[index]!.setRGB(...rgb, THREE.SRGBColorSpace));
    }
    const center = bounds.getCenter(new THREE.Vector3());
    if (outfit) {
      if (!outfitBounds) {
        display = "ready";
        return;
      }
      const whole = bounds.clone().union(outfitBounds);
      if (hairBounds) whole.union(hairBounds);
      const size = whole.getSize(new THREE.Vector3());
      whole.getCenter(cameraTarget);
      cameraTarget.y += size.y * pan;
      camera.fov = 32;
      camera.aspect = viewportAspect;
      const distance = Math.max(size.y, Math.max(size.x, size.z) / camera.aspect) /
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.17 * zoom + size.z * 0.5;
      camera.position.set(cameraTarget.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        cameraTarget.y + Math.sin(pitch) * distance, cameraTarget.z - Math.cos(yaw) * Math.cos(pitch) * distance);
      camera.lookAt(cameraTarget);
      camera.updateProjectionMatrix();
      active.render(scene, camera);
      display = "ready";
      return;
    }
    let usable = false;
    if (saved) {
      // The extracted model mirrors the native Z axis. Apply the same transform to the saved camera.
      camera.position.set(saved.position[0], saved.position[1], -saved.position[2]);
      cameraTarget.set(saved.target[0], saved.target[1], -saved.target[2]);
      camera.lookAt(cameraTarget);
      camera.fov = THREE.MathUtils.radToDeg(0.3);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const projected = center.clone().project(camera);
      // Some saved defaults frame the full avatar below the generic head's bounds.
      usable = Math.abs(projected.x) <= 0.6 && Math.abs(projected.y) <= 0.6 && Math.abs(projected.z) < 1;
    }
    if (!usable) {
      const size = bounds.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y) * 2.15 + size.z * 0.5;
      const lensScale = fov === undefined ? 1 : Math.tan(THREE.MathUtils.degToRad(16)) / Math.tan(0.15);
      camera.position.set(center.x, center.y, center.z - distance * lensScale);
      cameraTarget.copy(center);
      camera.lookAt(cameraTarget);
    }
    camera.fov = fov === undefined ? 32 : THREE.MathUtils.radToDeg(fov);
    camera.updateProjectionMatrix();
    active.render(scene, camera);
    display = "ready";
  });

  $effect(() => {
    const active = renderer;
    const url = backdropUrl;
    const isDds = backdropIsDds;
    if (!active || !url) return;
    let retired = false;
    let texture: THREE.Texture | null = null;
    backdropDisplay = "loading";
    void loadPortraitBackdrop(active, url, isDds).then(loaded => {
      if (retired) { loaded.dispose(); return; }
      texture = loaded;
      scene.background = loaded;
      active.render(scene, camera);
      backdropDisplay = "ready";
    }).catch(() => {
      if (!retired) {
        active.render(scene, camera);
        backdropDisplay = "unavailable";
      }
    });
    return () => {
      retired = true;
      scene.background = null;
      texture?.dispose();
    };
  });

  $effect(() => {
    const active = renderer;
    const name = model;
    const bloodline = bloodlineID;
    const withSkin = hasSkinTones;
    const sculpts = morphs;
    const jewelry = piercings;
    const glasses = apparel?.["accessories/glasses"];
    const mask = apparel?.["accessories/masks"];
    const irisAsset = iris;
    const makeupAssets = makeup;
    const scalp = scalpAsset;
    if (!active) return;
    let retired = false;
    let head: THREE.Group | null = null;
    const headwear = new THREE.Group();
    let eyelashTexture: THREE.Texture | null = null;
    let eyelashes: THREE.MeshBasicMaterial | null = null;
    const maps: Awaited<ReturnType<typeof loadMap>>[] = [];
    headBounds = null;
    skinUniforms = null;
    facialHairTints = [];
    display = "loading";
    const stem = `/client-assets/portrait-head/${name}`;
    void (async () => {
      const response = await fetch(stem + ".materials.json");
      if (!response.ok) throw new Error("Portrait materials unavailable");
      const { diffuse, normal, transparent, eyelashMask, eyelashMeshes, skinDetail, skinZone } = await response.json() as {
        diffuse: string; normal: string; transparent: string[]; eyelashMask: string; eyelashMeshes: string[];
        skinDetail: string; skinZone: string;
      };
      for (const [url, color] of [[diffuse, true], [normal, false]] as const) {
        const map = await loadMap(url, color);
        if (retired) { map.texture.dispose(); map.bitmap.close(); return; }
        maps.push(map);
      }
      let archetype: { diffuse: THREE.Texture; normal: THREE.Texture; weight: number } | null = null;
      if (bloodline != null && ((bloodline >= 1 && bloodline <= 8) || (bloodline >= 11 && bloodline <= 14))) {
        try {
          const source = await fetch(`${stem}-${bloodline}.archetype.json`);
          if (!source.ok) throw new Error("Portrait archetype unavailable");
          const layer = await source.json() as { diffuse: string; normal: string; weight: number };
          for (const [url, color] of [[layer.diffuse, true], [layer.normal, false]] as const) {
            const map = await loadMap(url, color);
            if (retired) { map.texture.dispose(); map.bitmap.close(); return; }
            maps.push(map);
          }
          archetype = { diffuse: maps[2]!.texture, normal: maps[3]!.texture, weight: layer.weight };
        } catch {
          // The generic maps can still render if the installation lacks the archetype layer.
        }
      }
      if (retired) return;
      if (withSkin) {
        try {
          const detail = await loadMap(skinDetail, true);
          if (retired) { detail.texture.dispose(); detail.bitmap.close(); return; }
          maps.push(detail);
          const zone = await loadMap(skinZone, false);
          if (retired) { zone.texture.dispose(); zone.bitmap.close(); return; }
          maps.push(zone);
          skinUniforms = {
            portraitSkinDetail: { value: detail.texture }, portraitSkinZone: { value: zone.texture },
            portraitSkinColors: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
            portraitSkinStrength: { value: 0 },
          };
        } catch {
          // The face remains visible when its colorizing layers are unavailable.
        }
      }
      if (eyelashMeshes.length && compressedSupport(active).s3tc) {
        const mask = await loadDds(eyelashMask).catch(() => null);
        if (retired) { mask?.dispose(); return; }
        if (mask) {
          eyelashTexture = mask;
          mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
          eyelashes = new THREE.MeshBasicMaterial({
            color: 0x211817, map: mask, transparent: true, side: THREE.DoubleSide, depthWrite: false,
          });
          eyelashes.forceSinglePass = true;
          eyelashes.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
              "diffuseColor.a *= texture2D( map, vMapUv ).a;");
          };
        }
      }
      const loadColorLayer = async (layer: ColorLayerAsset, weight: number, gloss: number | null,
        primaryScale = 1): Promise<PortraitColorLayer | null> => {
        const detail = await loadCroppedTexture({ url: layer.diffuse, rect: layer.diffuseRect }, maps, () => retired, true);
        const zones = layer.zones && layer.zonesRect
          ? await loadCroppedTexture({ url: layer.zones, rect: layer.zonesRect }, maps, () => retired) : null;
        return { diffuse: detail.texture, zones,
          colors: layer.colors.map(([r, g, b], index) => {
            const scale = index === 0 ? primaryScale : 1;
            return new THREE.Color().setRGB(r * scale, g * scale, b * scale, THREE.SRGBColorSpace);
          }),
          diffuseRect: detail.rect,
          weight, gloss };
      };
      const readColorLayer = async (selection: PortraitMakeup): Promise<PortraitColorLayer | null> => {
        try {
          const response = await fetch(selection.asset);
          if (!response.ok) return null;
          return await loadColorLayer(await response.json() as ColorLayerAsset, selection.weight, selection.gloss,
            selection.primaryScale);
        } catch {
          return null;
        }
      };
      const irisLayer = irisAsset ? await readColorLayer({ asset: irisAsset, weight: 1, gloss: null }) : null;
      const faceLayers: [string, PortraitColorLayer][] = [];
      let implant: PortraitImplantMaps | null = null;
      let scalpFinish: PortraitSurfaceFinish = {};
      if (scalp && "implant" in scalp && !retired) {
        try {
          implant = {
            Diffuse: await loadCroppedTexture(scalp.diffuse, maps, () => retired, true),
            Normal: await loadCroppedTexture(scalp.normal, maps, () => retired),
            Specular: await loadCroppedTexture(scalp.specular, maps, () => retired),
          };
        } catch {
          if (retired) return;
        }
        scalpDisplay = implant ? "ready" : "unavailable";
      } else if (scalp && !retired) {
        const layer = await loadColorLayer(scalp, 1, null).catch(() => null);
        if (retired) return;
        if (layer) {
          faceLayers.push(["portraitScalpHair", layer]);
          scalpFinish = await loadFinish(scalp.finish, maps, () => retired);
          if (retired) return;
        }
        scalpDisplay = layer ? "ready" : "unavailable";
      }
      let brows: [string, PortraitColorLayer] | null = null;
      const beardTints: { color: THREE.Color; baseline: THREE.Color }[] = [];
      for (const [index, selection] of (makeupAssets ?? []).entries()) {
        if (retired) return;
        const layer = await readColorLayer(selection);
        if (layer) {
          const name = "portraitMakeup" + index;
          if (selection.asset.includes("/makeup/eyebrows/")) brows = [name, layer];
          else {
            faceLayers.push([name, layer]);
            const primary = layer.colors[0];
            if (primary && layer.zones && selection.asset.includes("/makeup/beard/")) {
              beardTints.push({ color: primary, baseline: primary.clone() });
            }
          }
        }
      }
      if (retired) return;
      const { scene: avatar } = await loader.loadAsync(stem + ".glb");
      if (retired) { release(avatar); return; }
      head = avatar;
      let skinCutout: PortraitCroppedTexture | null = null;
      let eyewearNormal: (PortraitCroppedTexture & { masked: boolean }) | null = null;
      let eyeImplant: THREE.Group | null = null;
      const headMorphs = [...(sculpts ?? [])];
      for (const url of [glasses, mask]) {
        if (!url || retired) continue;
        let piece: THREE.Group | undefined;
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const data = await response.json() as { model: string; diffuse: string | null; zones: string | null;
            colors: [number, number, number, number][]; lensAreas?: number[]; opaqueLensAreas?: number[];
            skinCutout?: CroppedMapAsset; headDiffuse?: CroppedMapAsset; headZones?: CroppedMapAsset;
            headNormal?: CroppedMapAsset & { masked: boolean }; headMorphs?: string[]; headSurface?: boolean };
          const texture = async (url: string | null, color: boolean) => {
            if (!url || retired) return null;
            const map = await loadMap(url, color);
            if (retired) { map.texture.dispose(); map.bitmap.close(); return null; }
            maps.push(map);
            return map.texture;
          };
          const diffuse = await texture(data.diffuse, true);
          const zones = await texture(data.zones, false);
          if (retired) return;
          piece = (await loader.loadAsync(data.model)).scene;
          if (!retired && sculpts?.length) await applyPortraitMorphs(piece, data.model.replace(/\.glb$/, ""), sculpts, () => retired);
          if (retired) { release(piece); return; }
          if (data.headSurface) eyeImplant = piece;
          else {
            const colors = data.colors.map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace));
            const dyed = diffuse && zones && colors.length === 3;
            const frame = new THREE.MeshStandardMaterial({ map: diffuse, color: dyed ? 0xffffff : colors[0] ?? (diffuse ? 0xffffff : 0x343434),
              metalness: 0.35, roughness: 0.36 });
            if (dyed) applyOutfitPalette(frame, zones, colors);
            const color = colors[2] ?? new THREE.Color(0x2b3037);
            const opaqueLens = Boolean(data.opaqueLensAreas?.length);
            const lensAreas = data.opaqueLensAreas ?? data.lensAreas;
            const lens = lensAreas?.length ? new THREE.MeshStandardMaterial({ color, transparent: !opaqueLens, side: THREE.DoubleSide,
              depthWrite: opaqueLens, opacity: opaqueLens ? 1 : 0.83 - 0.45 * Math.max(color.r, color.g, color.b), roughness: 0.22 }) : null;
            if (lens) lens.forceSinglePass = true;
            const originals = new Set<THREE.Material>();
            piece.traverse(node => {
              if (!(node instanceof THREE.Mesh) || Array.isArray(node.material)) return;
              originals.add(node.material);
              node.material = lens && lensAreas?.includes(node.material.userData.index) ? lens : frame;
            });
            for (const material of originals) material.dispose();
          }
          headwear.add(piece);
          if (data.skinCutout) skinCutout = await loadCroppedTexture(data.skinCutout, maps, () => retired).catch(() => null);
          for (const name of data.headMorphs ?? []) headMorphs.push({ name, weight: 1 });
          if (data.headDiffuse) {
            const layer = await loadColorLayer({ diffuse: data.headDiffuse.url, diffuseRect: data.headDiffuse.rect,
              ...(data.headZones && data.colors.length === 3 ? { zones: data.headZones.url, zonesRect: data.headZones.rect } : {}),
              colors: data.colors.map(([r, g, b]) => [r, g, b]) }, 1, null)
              .catch(() => null);
            if (layer) {
              faceLayers.push(["portraitEyewear", layer]);
              if (data.headNormal) {
                const normal = await loadCroppedTexture(data.headNormal, maps, () => retired).catch(() => null);
                if (normal) eyewearNormal = { ...normal, masked: data.headNormal.masked };
              }
            }
          }
        } catch {
          if (piece) release(piece);
        }
      }
      if (!retired && headMorphs.length) await applyPortraitMorphs(avatar, stem, headMorphs, () => retired);
      if (retired) return;
      const surface = new THREE.MeshStandardMaterial({ map: maps[0]!.texture, normalMap: maps[1]!.texture, roughness: 0.76 });
      const tint = skinUniforms;
      const skin = tint || faceLayers.length || implant || skinCutout ? surface.clone() : surface;
      // The authored head normal packs tangent X in alpha and Y in green.
      // Read the two linear channels without premultiplying the PNG.
      const configure = (material: THREE.MeshStandardMaterial, skinLayer: SkinUniforms | null,
        layers: readonly [string, PortraitColorLayer][] = [], implantMaps: PortraitImplantMaps | null = null,
        finish: PortraitSurfaceFinish = {}, cutout: PortraitCroppedTexture | null = null) => {
        const eyeNormal = material === skin ? eyewearNormal : null;
        material.onBeforeCompile = shader => {
          const layeredNormal = archetype ? `headNormal = mix(headNormal,
            texture2D( archetypeNormal, vNormalMapUv ).ag * 2.0 - 1.0, archetypeCoverage);` : "";
          if (archetype) {
            shader.uniforms.archetypeDiffuse = { value: archetype.diffuse };
            shader.uniforms.archetypeNormal = { value: archetype.normal };
            shader.uniforms.archetypeWeight = { value: archetype.weight };
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D archetypeDiffuse;
              uniform sampler2D archetypeNormal;
              uniform float archetypeWeight;
            `).replace("#include <map_fragment>", `
              #include <map_fragment>
              vec4 archetypeColor = texture2D( archetypeDiffuse, vMapUv );
              float archetypeCoverage = clamp(archetypeColor.a * archetypeWeight, 0.0, 1.0);
              diffuseColor.rgb = mix(diffuseColor.rgb, archetypeColor.rgb, archetypeCoverage);
            `);
          }
          if (skinLayer) {
            Object.assign(shader.uniforms, skinLayer);
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D portraitSkinDetail;
              uniform sampler2D portraitSkinZone;
              uniform vec3 portraitSkinColors[3];
              uniform float portraitSkinStrength;
            `).replace("#include <color_fragment>", `
              vec4 skinDetail = texture2D( portraitSkinDetail, vMapUv );
              vec3 skinZone = texture2D( portraitSkinZone, vMapUv ).rgb;
              vec3 skinTint = (skinZone.r * portraitSkinColors[0] + skinZone.g * portraitSkinColors[1] +
                skinZone.b * portraitSkinColors[2]) / max(dot(skinZone, vec3(1.0)), 0.001);
              diffuseColor.rgb = mix(diffuseColor.rgb, skinDetail.rgb * skinTint,
                portraitSkinStrength * clamp(4.0 * skinDetail.a, 0.0, 0.85));
              #include <color_fragment>
            `);
          }
          if (implantMaps) compositePortraitImplant(shader, implantMaps);
          for (const [name, layer] of layers) compositePortraitColorLayer(shader, name, layer);
          compositePortraitScalpFinish(shader, finish);
          if (eyeNormal) {
            shader.uniforms.portraitEyewearNormal = { value: eyeNormal.texture };
            shader.uniforms.portraitEyewearNormalRect = { value: eyeNormal.rect };
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D portraitEyewearNormal;
              uniform vec4 portraitEyewearNormalRect;
            `);
          }
          if (cutout) {
            shader.uniforms.portraitSkinCutout = { value: cutout.texture };
            shader.uniforms.portraitSkinCutoutRect = { value: cutout.rect };
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D portraitSkinCutout;
              uniform vec4 portraitSkinCutoutRect;
            `).replace("#include <alphatest_fragment>", `
              #include <alphatest_fragment>
              vec2 cutoutUV = (vMapUv - portraitSkinCutoutRect.xy) / portraitSkinCutoutRect.zw;
              if (all(greaterThanEqual(cutoutUV, vec2(0.0))) && all(lessThanEqual(cutoutUV, vec2(1.0))) &&
                  texture2D(portraitSkinCutout, cutoutUV).a >= 0.5) discard;
            `);
          }
          shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
            THREE.ShaderChunk.normal_fragment_maps.replace(
              "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
              `vec2 headNormal = texture2D( normalMap, vNormalMapUv ).ag * 2.0 - 1.0;
               ${layeredNormal}
               ${implantMaps ? `vec3 implantNormal = samplePortraitImplant(portraitImplantNormal, portraitImplantNormalRect, vNormalMapUv).rgb;
               headNormal = mix(headNormal, implantNormal.rg * 2.0 - 1.0, implantNormal.b);` : ""}
               ${finish.Normal ? `vec2 scalpNormalUv = (vNormalMapUv - portraitScalpNormalRect.xy) / portraitScalpNormalRect.zw;
               vec2 scalpNormalInside = step(vec2(0.0), scalpNormalUv) * step(scalpNormalUv, vec2(1.0));
               vec2 scalpNormal = texture2D(portraitScalpNormal, scalpNormalUv).ag * 2.0 - 1.0;
               headNormal = mix(headNormal, scalpNormal, portraitScalpHairMask * scalpNormalInside.x * scalpNormalInside.y);` : ""}
               ${eyeNormal ? `vec2 eyeNormalUv = (vNormalMapUv - portraitEyewearNormalRect.xy) / portraitEyewearNormalRect.zw;
               vec2 eyeNormalInside = step(vec2(0.0), eyeNormalUv) * step(eyeNormalUv, vec2(1.0));
               vec4 eyeNormalSample = texture2D(portraitEyewearNormal, eyeNormalUv);
               headNormal = mix(headNormal, eyeNormalSample.${eyeNormal.masked ? "rg" : "ag"} * 2.0 - 1.0,
                 ${eyeNormal.masked ? "eyeNormalSample.b" : "portraitEyewearMask"} * eyeNormalInside.x * eyeNormalInside.y);` : ""}
               vec3 mapN = vec3( headNormal, sqrt( max( 0.0, 1.0 - dot( headNormal, headNormal ) ) ) );`,
            ));
        };
        material.customProgramCacheKey = () => `portrait:${Boolean(archetype)}:${Boolean(skinLayer)}:${Boolean(implantMaps)}:${Boolean(finish.Normal)}:${Boolean(finish.Specular)}:${Boolean(cutout)}:${eyeNormal ? (eyeNormal.masked ? "masked" : "normal") : ""}:${layers.map(([name, layer]) => `${name}/${Boolean(layer.zones)}/${layer.gloss !== null}`).join(",")}`;
      };
      configure(surface, null);
      if (skin !== surface) configure(skin, tint, faceLayers, implant, scalpFinish, skinCutout);
      applySurface(avatar, surface, new Set(transparent), new Set(eyelashMeshes), eyelashes, skin);
      if (eyeImplant) applySurface(eyeImplant, skin, new Set(), new Set(), null, skin);
      if (skinCutout) {
        const tearducts = surface.clone();
        configure(tearducts, null, [], null, {}, skinCutout);
        let attached = false;
        avatar.traverse(node => {
          if (node instanceof THREE.Mesh && /^Tearducts_GeoShape(?:_\d+)?$/i.test(node.name)) {
            node.material = tearducts;
            attached = true;
          }
        });
        if (!attached) tearducts.dispose();
      }
      if (irisLayer) {
        const eyes = surface.clone();
        configure(eyes, null, [["portraitIris", irisLayer]]);
        let attached = false;
        avatar.traverse(node => {
          if (node instanceof THREE.Mesh && /^eyeball/i.test(node.name)) { node.material = eyes; attached = true; }
        });
        if (!attached) eyes.dispose();
      }
      if (brows && bloodline) {
        const [name, layer] = brows;
        const browStem = `${stem}-${bloodline}.brows`;
        try {
          const { scene: overlay } = await loader.loadAsync(browStem + ".glb");
          if (!retired && headMorphs.length) await applyPortraitMorphs(overlay, browStem, headMorphs, () => retired);
          if (retired) { release(overlay); return; }
          const finish = new THREE.MeshStandardMaterial({ map: layer.diffuse, transparent: true, side: THREE.DoubleSide, depthWrite: false });
          finish.forceSinglePass = true;
          finish.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "");
            compositePortraitColorLayer(shader, name, layer, true);
          };
          finish.customProgramCacheKey = () => `portrait-brows:${name}`;
          applySurface(overlay, finish, new Set(), new Set(), null, finish);
          avatar.add(overlay);
          const primary = layer.colors[0];
          if (primary) beardTints.push({ color: primary, baseline: primary.clone() });
        } catch {
          // Some bloodlines may not have a brow overlay in the client installation.
        }
      }
      for (const url of jewelry ?? []) {
        if (retired) return;
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          const data = await response.json() as { model: string; surface?: [number, number, number] };
          const { scene: piece } = await loader.loadAsync(data.model);
          if (!retired && sculpts?.length) await applyPortraitMorphs(piece, data.model.replace(/\.glb$/, ""), sculpts, () => retired);
          if (retired) { release(piece); return; }
          const color = data.surface ? new THREE.Color().setRGB(...data.surface) : 0xc6c4bd;
          const finish = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.28 });
          applySurface(piece, finish, new Set(), new Set(), null, finish);
          avatar.add(piece);
        } catch {
          // A saved piece may have no single skinned model in this installation.
        }
      }
      avatar.add(headwear);
      scene.add(avatar);
      avatar.updateMatrixWorld(true);
      facialHairTints = beardTints;
      headBounds = new THREE.Box3().setFromObject(avatar, true);
    })().catch(() => {
      if (!retired) display = "unavailable";
    });
    return () => {
      retired = true;
      if (head) {
        scene.remove(head);
        release(head);
      } else eyelashes?.dispose();
      if (!headwear.parent) release(headwear);
      eyelashTexture?.dispose();
      for (const map of maps) {
        map.texture.dispose();
        map.bitmap.close();
      }
    };
  });
</script>

<canvas bind:this={canvas} class:full-body={Boolean(outfit)} data-portrait-head={display} data-backdrop-state={backdropUrl ? backdropDisplay : undefined}
  data-portrait-hair={visibleHairstyle ? hairDisplay : undefined}
  data-portrait-outfit={outfit ? outfitDisplay : undefined}
  onpointerdown={startDrag} onpointermove={moveDrag} onpointerup={endDrag} onlostpointercapture={endDrag}
  oncontextmenu={event => { if (outfit) event.preventDefault(); }}
  hidden={display !== "ready" || (Boolean(outfit) && outfitDisplay !== "ready") || (Boolean(backdropUrl) && backdropDisplay === "loading")} role="img"
  aria-label={outfit ? "Full-body character preview" : (model === "female" ? "Female base head" : "Male base head") + (backdropUrl ? " with selected backdrop" : "")}></canvas>
{#if outfit && (display !== "ready" || outfitDisplay !== "ready")}
  <p role="status">{display === "unavailable" || outfitDisplay === "unavailable" ? "This character preview could not be displayed." : "Loading character preview…"}</p>
{:else if display !== "ready"}
  <p role="status">{display === "loading" ? "Loading base head…" : "This base head could not be displayed."}</p>
{:else if backdropUrl && backdropDisplay !== "ready"}
  <p role="status">{backdropDisplay === "loading" ? "Loading backdrop…" : "This backdrop could not be displayed."}</p>
{:else if visibleHairstyle && hairDisplay !== "ready"}
  <p role="status">{hairDisplay === "loading" ? "Loading hairstyle…" : "This hairstyle could not be displayed."}</p>
{/if}

<style>
  canvas { width: 100%; aspect-ratio: 1; object-fit: contain; }
  canvas.full-body { height: 100%; aspect-ratio: auto; cursor: grab; touch-action: none; }
  canvas.full-body:active { cursor: grabbing; }
  p { margin: auto; color: #a8bbb6; }
</style>
