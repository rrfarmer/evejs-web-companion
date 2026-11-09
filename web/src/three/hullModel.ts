// A type's model as the play page draws it: the hull tools/client-extract pulled from the client (asked of the dev
// server by typeID, extracted on first ask), its own textures, and its LODs switched by distance. The material is a
// first approximation of the client's quadv5 ship shader; faction colours (MaterialMap / PaintMaskMap) come with the
// SOF reader.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";

export interface SofMaterial { name: string; diffuse: number[] | null; dust: number[] | null; fresnel: number[] | null; gloss: number | null }
export interface SofArea { kind: string; name: string; index: number; areaType: string; shader: string | null; textures: Record<string, string | null>; params: Record<string, number[] | null>; materials: (SofMaterial | null)[] }
export interface SofHull { hull: string; faction: string | null; areas: SofArea[]; colorSet: Record<string, number[]> | null; boosters: { transform: number[] | null }[] }

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
 * A hull area as the client's quadv5 ship shader colours it, approximated on three's standard material: the area's
 * MaterialMap (one channel, at 0, 1/3, 2/3 and 1) chooses among the faction's four materials for that area (EveSOF,
 * areaTypes material1..4), each an EveSOFDataMaterial's DiffuseColor (multiplying the albedo), Gloss (roughness) and
 * FresnelColor (here, how metallic). The blend between the four levels is the shader's own and is not known; a
 * linear blend between neighbouring levels is used. TINT_SCALE brings DiffuseColor's linear values to a base colour.
 */
const TINT_SCALE = 6.0;
export function sofHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: SofArea): THREE.MeshStandardMaterial {
  const m = eveHullMaterial(maps, area.name);
  const mats = [0, 1, 2, 3].map((i) => area.materials[i] ?? null);
  const v3 = (a: number[] | null | undefined, d: number) => new THREE.Vector3(a?.[0] ?? d, a?.[1] ?? d, a?.[2] ?? d);
  const uniforms = {
    mtlDiffuse: { value: mats.map((x) => v3(x?.diffuse, 0.05)) },
    mtlFresnel: { value: mats.map((x) => v3(x?.fresnel, 0.04)) },
    mtlGloss: { value: mats.map((x) => x?.gloss ?? 0.4) },
    materialMap: { value: maps.materialMap ?? null },
    tintScale: { value: TINT_SCALE },
  };
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, uniforms);
    // inserted beside the chunk names first; the base then writes the chunks out and fixes the channels in them
    shader.fragmentShader = `uniform vec3 mtlDiffuse[4]; uniform vec3 mtlFresnel[4]; uniform float mtlGloss[4]; uniform sampler2D materialMap; uniform float tintScale;
${shader.fragmentShader}`
      .replace("#include <map_fragment>", `#include <map_fragment>
        float mtlSel = texture2D( materialMap, vMapUv ).r * 3.0;
        vec4 mtlW = clamp( 1.0 - abs( vec4( mtlSel ) - vec4( 0.0, 1.0, 2.0, 3.0 ) ), 0.0, 1.0 );
        vec3 mtlTint = mtlDiffuse[0] * mtlW.x + mtlDiffuse[1] * mtlW.y + mtlDiffuse[2] * mtlW.z + mtlDiffuse[3] * mtlW.w;
        float mtlGl = mtlGloss[0] * mtlW.x + mtlGloss[1] * mtlW.y + mtlGloss[2] * mtlW.z + mtlGloss[3] * mtlW.w;
        vec3 mtlFr = mtlFresnel[0] * mtlW.x + mtlFresnel[1] * mtlW.y + mtlFresnel[2] * mtlW.z + mtlFresnel[3] * mtlW.w;
        diffuseColor.rgb *= mtlTint * tintScale;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = clamp( ( 1.0 - mtlGl ) * ( 0.5 + roughnessFactor ), 0.04, 1.0 );`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
        metalnessFactor = clamp( dot( mtlFr, vec3( 0.333 ) ) * 1.6, 0.0, 1.0 );`);
    base.call(m, shader, renderer);
  };
  m.customProgramCacheKey = () => "sofHull";
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

async function loadType(typeID: number): Promise<THREE.Object3D | null> {
  const info = (await (await fetch(`/client-assets/type/${typeID}`)).json()) as TypeModelInfo;
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
  const ROLE: Record<string, string> = { AlbedoMap: "albedo", NormalMap: "normal", RoughnessMap: "roughness", MaterialMap: "materialMap", GlowMap: "glow", DirtMap: "dirt", PaintMaskMap: "paintMask" };
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
  lod.userData = { typeID, radius: size, hull: info.hull ?? null };
  return lod;
}
