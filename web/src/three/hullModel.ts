// A type's model as the play page draws it: the hull tools/client-extract pulled from the client (asked of the dev
// server by typeID, extracted on first ask), its own textures, and its LODs switched by distance. The material is a
// first approximation of the client's quadv5 ship shader; faction colours (MaterialMap / PaintMaskMap) come with the
// SOF reader.

import * as THREE from "three";
import { addDecals, type SofDecalSet } from "./hullDecals.ts";
import { hullFx,type SofSpriteSet, type SofPlaneSet, type SofSpotlightSet, type SofHazeSet } from "./hullFx.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";

export interface SofMaterial { name: string; diffuse: number[] | null; dust: number[] | null; fresnel: number[] | null; gloss: number | null }
export interface SofArea { kind: string; name: string; index: number; areaType: string; shader: string | null; textures: Record<string, string | null>; params: Record<string, number[] | null>; materials: (SofMaterial | null)[] }
export interface SofBooster { glowColor: number[] | null; glowScale: number | null; haloColor: number[] | null; haloScaleX: number | null; haloScaleY: number | null; shape0Color: number[] | null; shape1Color: number[] | null }
export interface SofHull {
  hull: string; faction: string | null; race?: string | null; booster?: SofBooster | null; areas: SofArea[]; colorSet: Record<string, number[]> | null; boosters: { transform: number[] | null }[];
  /** The hull's "anchorpoint" locator, in EVE's model space (a hangar's: where its ship floats). */
  anchor?: number[] | null;
  /** Its "maxCameraDistance" locator, in EVE's model space (a hangar's farthest camera, by its length). */
  maxCameraDistance?: number[] | null;
  /** Its point lights (EveSOFDataHullLightSet items), in EVE's model space. */
  lights?: { position: number[]; radius: number | null; innerRadius: number | null; brightness: number; color: number[] | null }[];
}

/** A soft round spot, for engine glows. */
let glowTexture: THREE.Texture | null = null;
function glowSpot(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

/**
 * The hull's engines, at the SOF booster locators (EveSOFDataHullBooster items; a row-major transform whose rows 0 and
 * 1 are the flame's width and height and row 2 its length, pointing aft, and whose last row is the nozzle), coloured
 * from the race's booster data (shape colours for the flame, glowColor * glowScale for the glow). The client's flame
 * is a noise-animated shape from an atlas (EveBoosterSet2); this is a first likeness: two crossed additive planes
 * fading along the flame, and a glow at the nozzle. Each flame's length is set by the ship's speed (setThrust).
 */
function buildBoosters(sof: SofHull): THREE.Group | null {
  const b = sof.booster;
  if (!b || !sof.boosters.length) return null;
  const hdr = (c: number[] | null | undefined, d: number[]) => { const v = c ?? d; const m = Math.max(v[0]!, v[1]!, v[2]!, 1e-6); return new THREE.Color(v[0]! / m, v[1]! / m, v[2]! / m); };
  const flameColour = hdr(b.shape0Color, [1, 0.6, 0.3]);
  const coreColour = hdr(b.shape1Color, [1, 0.8, 0.5]);
  const group = new THREE.Group();
  group.name = "boosters";
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { colour: { value: flameColour }, core: { value: coreColour } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 colour; uniform vec3 core; varying vec2 vUv;
      void main() {
        // clamped: multisampling evaluates the uv a little outside the plane, and pow() of a negative is NaN
        float across = clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0);
        float along = clamp(1.0 - vUv.y, 0.0, 1.0);
        float a = pow(across, 0.9) * pow(along, 1.4);
        vec3 c = mix(colour, core, pow(across, 6.0) * along);
        gl_FragColor = vec4(c * a * 1.4, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.translate(0, 0.5, 0); // from the nozzle (v = 0) out along the flame
  plane.rotateX(Math.PI / 2); // along +z: aft, once mirrored
  for (const item of sof.boosters) {
    const t = item.transform;
    if (!t || t.length < 16) continue;
    const w = Math.hypot(t[0]!, t[1]!, t[2]!), h = Math.hypot(t[4]!, t[5]!, t[6]!), len = Math.hypot(t[8]!, t[9]!, t[10]!);
    const nozzle = new THREE.Group();
    nozzle.position.set(t[12]!, t[13]!, -t[14]!);
    const flame = new THREE.Group();
    flame.name = "flame";
    // the flame spans -1..1 across the locator's width and height rows, and 0..1 along its length row
    for (const [sx, sy, rot] of [[2 * w, len, 0], [2 * h, len, Math.PI / 2]] as const) {
      const m = new THREE.Mesh(plane, flameMat);
      m.scale.set(sx, 1, sy);
      m.rotation.z = rot;
      flame.add(m);
    }
    nozzle.add(flame);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpot(), color: flameColour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(Math.max(w, h) * 2.4);
    nozzle.add(glow);
    group.add(nozzle);
  }
  return group;
}

/** Engines burn as the ship goes: the flames' length follows speed, as a share of the ship's top speed. */
export function setThrust(model: THREE.Object3D, share: number): void {
  const boosters = model.getObjectByName("boosters");
  if (!boosters) return;
  const k = 0.15 + 0.85 * Math.max(0, Math.min(1, share));
  for (const nozzle of boosters.children) {
    const flame = nozzle.getObjectByName("flame");
    if (flame) flame.scale.set(1, 1, k);
  }
}

export interface TypeModelInfo {
  typeID: number;
  model: string | null;
  sof?: string | null;
  textures?: Record<string, Record<string, string>>;
  hull?: string | null;
  faction?: string | null;
  race?: string | null;
  error?: string;
}

/**
 * A hull area as the client's quadv5 ship shader colours it (graphics/effect.dx11/.../v5/quad/quadv5.sm_hi, its
 * forward pass disassembled, client 3396210), on three's standard material:
 * - the MaterialMap (one channel) weighs the faction's four materials for the area (EveSOF areaTypes material1..4):
 *   w_i = saturate(1.031915 - |m - i/3| * 3.191489);
 * - the base colour is the albedo times the weighed DiffuseColor (linear, no other factor);
 * - the specular colour at normal incidence is the weighed FresnelColor itself: a specular workflow, not a metal one;
 * - the roughness is 1 - RoughnessMap.r * the weighed Gloss (the map is read as a gloss), squared for the lobe as
 *   three squares it.
 * The dirt layer (DirtMap at the area's dirt level, lerping the colour to white and the specular to 0.0384) and the
 * pattern layers are not drawn yet.
 */
export function sofHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: SofArea): THREE.MeshStandardMaterial {
  const m = eveHullMaterial(maps, area.name);
  m.metalness = 0;
  // quadsailsv5's sails weave; quadglassv5 draws both faces (its normal turned for the back one).
  const sails = /sails/i.test(area.shader ?? "") && !!maps.sailsDetail;
  if (/glass/i.test(area.shader ?? "")) m.side = THREE.DoubleSide;
  if (maps.sailsDetail) { maps.sailsDetail.wrapS = maps.sailsDetail.wrapT = THREE.RepeatWrapping; maps.sailsDetail.needsUpdate = true; }
  const mats = [0, 1, 2, 3].map((i) => area.materials[i] ?? null);
  const v3 = (a: number[] | null | undefined, d: number) => new THREE.Vector3(a?.[0] ?? d, a?.[1] ?? d, a?.[2] ?? d);
  const uniforms = {
    mtlDiffuse: { value: mats.map((x) => v3(x?.diffuse, 0.05)) },
    mtlFresnel: { value: mats.map((x) => v3(x?.fresnel, 0.04)) },
    mtlGloss: { value: mats.map((x) => x?.gloss ?? 0.4) },
    materialMap: { value: maps.materialMap ?? null },
    sailsDetailMap: { value: maps.sailsDetail ?? null },
    sailsDetailData: { value: v3(area.params.SailsDetailData, 0) },
  };
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, uniforms);
    // inserted beside the chunk names first; the base then writes the chunks out and fixes the channels in them
    shader.fragmentShader = `uniform vec3 mtlDiffuse[4]; uniform vec3 mtlFresnel[4]; uniform float mtlGloss[4]; uniform sampler2D materialMap; uniform sampler2D sailsDetailMap; uniform vec3 sailsDetailData;
${shader.fragmentShader}`
      .replace("#include <map_fragment>", `#include <map_fragment>
        float mtlSel = texture2D( materialMap, vMapUv ).r;
        ${sails ? `// quadsailsv5: where the map picks the first material, the sail's weave (SailsDetailMap, tiled by
        // SailsDetailData.x and turned by .y radians) picks among the four instead.
        float sailW = clamp( 1.031915 - abs( mtlSel * 3.191489 ), 0.0, 1.0 );
        vec2 sailUv = vMapUv * sailsDetailData.x;
        float sc = cos( sailsDetailData.y ), ss = sin( sailsDetailData.y );
        sailUv = vec2( sc * sailUv.x - ss * sailUv.y, ss * sailUv.x + sc * sailUv.y );
        mtlSel = mix( mtlSel, texture2D( sailsDetailMap, sailUv ).r, sailW );` : ""}
        vec4 mtlW = clamp( 1.031915 - abs( vec4( mtlSel ) - vec4( 0.0, 0.333333, 0.666667, 1.0 ) ) * 3.191489, 0.0, 1.0 );
        vec3 mtlTint = mtlDiffuse[0] * mtlW.x + mtlDiffuse[1] * mtlW.y + mtlDiffuse[2] * mtlW.z + mtlDiffuse[3] * mtlW.w;
        float mtlGl = mtlGloss[0] * mtlW.x + mtlGloss[1] * mtlW.y + mtlGloss[2] * mtlW.z + mtlGloss[3] * mtlW.w;
        vec3 mtlFr = mtlFresnel[0] * mtlW.x + mtlFresnel[1] * mtlW.y + mtlFresnel[2] * mtlW.z + mtlFresnel[3] * mtlW.w;
        diffuseColor.rgb *= mtlTint;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = clamp( 1.0 - roughnessFactor * mtlGl, 0.0, 1.0 );`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        material.specularColor = mtlFr;
        material.specularColorBlended = mtlFr;`);
    base.call(m, shader, renderer);
  };
  m.customProgramCacheKey = () => `sofHull5${sails ? "s" : ""}`;
  return m;
}

/** three's #include chunks written out, so the lines inside them can be changed (onBeforeCompile sees them unexpanded). */
function resolveIncludes(src: string): string {
  return src.replace(/^[ 	]*#include +<([wd.]+)>/gm, (_m, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`no shader chunk ${name}`);
    return resolveIncludes(chunk);
  });
}

/** A shader change that must find its line: one that finds nothing says so, rather than leaving the shader as it was. */
function change(src: string, from: string, to: string): string {
  if (!src.includes(from)) console.warn(`hull shader: "${from.slice(0, 60)}" not found; three's shader chunks have changed`);
  return src.replace(from, to);
}

/** The client's channel layout on three's standard material: BC5 normal (z rebuilt), BC4 roughness and glow (red). */
export function eveHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: string, flipGreen = true): THREE.MeshStandardMaterial {
  const isBooster = /exhaust|booster/i.test(area);
  const m = new THREE.MeshStandardMaterial({
    map: maps.albedo ?? null,
    color: maps.albedo ? 0xffffff : 0x8c9297,
    normalMap: maps.normal ?? null,
    roughnessMap: maps.roughness ?? null,
    roughness: maps.roughness ? 1 : 0.55,
    metalness: 0.6,
    emissiveMap: maps.glow ?? null,
    emissive: new THREE.Color(maps.glow ? (isBooster ? 0xffa060 : 0x9fd8ff) : 0x000000),
    emissiveIntensity: isBooster ? 4 : 2,
  });
  m.onBeforeCompile = (shader) => {
    let fs = resolveIncludes(shader.fragmentShader);
    if (maps.normal) {
      fs = change(fs, "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec3 mapN; mapN.xy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
         ${flipGreen ? "mapN.y = -mapN.y;" : ""}
         mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`);
    }
    if (maps.roughness) fs = change(fs, "roughnessFactor *= texelRoughness.g;", "roughnessFactor *= texelRoughness.r;");
    if (maps.glow) fs = change(fs, "totalEmissiveRadiance *= emissiveColor.rgb;", "totalEmissiveRadiance *= emissiveColor.rrr;");
    shader.fragmentShader = fs;
  };
  return m;
}

const loader = new GLTFLoader();
const byType = new Map<number, Promise<THREE.Object3D | null>>();

/** A fresh instance of a type's model (shared geometry and textures), or null when it has none. */
export async function typeModel(typeID: number): Promise<THREE.Object3D | null> {
  if (!byType.has(typeID)) byType.set(typeID, loadType(typeID));
  const proto = await byType.get(typeID)!;
  return proto ? proto.clone(true) : null;
}

/** A fresh instance of a SOF graphic's model that is no type's (a station hangar), or null when it has none. */
export async function graphicModel(graphicID: number): Promise<THREE.Object3D | null> {
  if (!byGraphic.has(graphicID)) byGraphic.set(graphicID, fetch(`/client-assets/graphic/${graphicID}`).then((r) => r.json()).then((info: TypeModelInfo) => loadModel(info, null)));
  const proto = await byGraphic.get(graphicID)!;
  return proto ? proto.clone(true) : null;
}
const byGraphic = new Map<number, Promise<THREE.Object3D | null>>();

async function loadType(typeID: number): Promise<THREE.Object3D | null> {
  const info = (await (await fetch(`/client-assets/type/${typeID}`)).json()) as TypeModelInfo;
  return loadModel(info, typeID);
}

async function loadModel(info: TypeModelInfo, typeID: number | null): Promise<THREE.Object3D | null> {
  if (!info.model) return null;
  const gltf = await loader.loadAsync(info.model);
  const dir = info.model.slice(0, info.model.lastIndexOf("/") + 1);
  const maps: Record<string, THREE.Texture | undefined> = {};
  await Promise.all(Object.entries(info.textures ?? {}).map(async ([role, variants]) => {
    const file = variants.full ?? variants.mediumdetail ?? variants.lowdetail;
    if (!file) return;
    try { maps[role] = await loadDds(dir + file); } catch { /* a texture this GPU cannot take: drawn without it */ }
  }));
  if (maps.albedo) maps.albedo.colorSpace = THREE.SRGBColorSpace;
  // The Space Object Factory's build of this hull for the type's faction, where there is one: each mesh area takes the
  // SOF area of its index (EveSOFDataHullArea.index), with that area's own textures and the faction's materials.
  const sof = info.sof ? ((await (await fetch(info.sof)).json()) as SofHull) : null;
  const ROLE: Record<string, string> = { AlbedoMap: "albedo", NormalMap: "normal", RoughnessMap: "roughness", MaterialMap: "materialMap", GlowMap: "glow", DirtMap: "dirt", PaintMaskMap: "paintMask", SailsDetailMap: "sailsDetail" };
  const areaMaps = new Map<SofArea, Record<string, THREE.Texture | undefined>>();
  const texCache = new Map<string, Promise<THREE.Texture | undefined>>();
  const tex = (url: string) => {
    if (!texCache.has(url)) texCache.set(url, loadDds(url).then((t) => t as THREE.Texture).catch(() => undefined));
    return texCache.get(url)!;
  };
  for (const area of sof?.areas ?? []) {
    const am: Record<string, THREE.Texture | undefined> = {};
    await Promise.all(Object.entries(area.textures).map(async ([name, url]) => { const role = ROLE[name]; if (role && url) am[role] = await tex(url); }));
    if (am.albedo) am.albedo.colorSpace = THREE.SRGBColorSpace;
    areaMaps.set(area, am);
  }
  const materials = new Map<string, THREE.Material>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material;
    const index = typeof mat.userData?.index === "number" ? (mat.userData.index as number) : null;
    const area = sof?.areas.find((a) => a.kind === "opaque" && a.index === index) ?? null;
    const key = area ? `sof:${area.index}` : `legacy:${mat.name}`;
    if (!materials.has(key)) materials.set(key, area ? sofHullMaterial({ ...maps, ...areaMaps.get(area) }, area) : eveHullMaterial(maps, mat.name));
    mesh.material = materials.get(key)!;
  });
  // The file's LODs, finest first, switched by distance in units of the model's size.
  const lodNodes = gltf.scene.children[0]?.children ?? [];
  const size = new THREE.Box3().setFromObject(lodNodes[0] ?? gltf.scene).getBoundingSphere(new THREE.Sphere()).radius || 50;
  const lod = new THREE.LOD();
  lodNodes.slice().forEach((node, i) => lod.addLevel(node, i === 0 ? 0 : size * 12 * 2 ** (i - 1)));
  // the hull's decals, on each LOD (hullDecals.ts)
  const decalSets = (sof as { decalSets?: SofDecalSet[] } | null)?.decalSets;
  // (the LOD's levels: lodNodes is the file's live children list, which addLevel has emptied)
  if (decalSets?.length) await addDecals(lod.levels.map((l) => l.object), decalSets).catch((e) => console.warn("hull decals", e));
  lod.userData = { typeID, radius: size, hull: info.hull ?? null, anchor: sof?.anchor ?? null, maxCameraDistance: sof?.maxCameraDistance ?? null, lights: sof?.lights ?? [], boundingSphere: (sof as { boundingSphere?: number[] | null } | null)?.boundingSphere ?? null };
  const boosters = sof ? buildBoosters(sof) : null;
  // the hull's sprite lights and plane cards (hullFx.ts)
  const fx = sof ? await hullFx(sof as { spriteSets?: SofSpriteSet[]; planeSets?: SofPlaneSet[]; spotlightSets?: SofSpotlightSet[]; hazeSets?: SofHazeSet[] }).catch(() => null) : null;
  if (!boosters && !fx) return lod;
  // The engines and lights belong to the hull, not to one LOD: a holder carries them all.
  const holder = new THREE.Group();
  holder.add(lod);
  if (boosters) holder.add(boosters);
  if (fx) holder.add(fx);
  holder.userData = lod.userData;
  return holder;
}
