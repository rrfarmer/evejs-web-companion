// A type's model as the play page draws it: the hull tools/client-extract pulled from the client (asked of the dev
// server by typeID, extracted on first ask), its own textures, and its LODs switched by distance. The material is a
// first approximation of the client's quadv5 ship shader; faction colours (MaterialMap / PaintMaskMap) come with the
// SOF reader.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";

export interface TypeModelInfo {
  typeID: number;
  model: string | null;
  textures?: Record<string, Record<string, string>>;
  hull?: string | null;
  faction?: string | null;
  race?: string | null;
  error?: string;
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
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec3 mapN; mapN.xy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
         ${flipGreen ? "mapN.y = -mapN.y;" : ""}
         mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`,
      )
      .replace("roughnessFactor *= texelRoughness.g;", "roughnessFactor *= texelRoughness.r;")
      .replace("totalEmissiveRadiance *= emissiveColor.rgb;", "totalEmissiveRadiance *= emissiveColor.rrr;");
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
  const materials = new Map<string, THREE.Material>();
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const area = (mesh.material as THREE.Material).name;
    if (!materials.has(area)) materials.set(area, eveHullMaterial(maps, area));
    mesh.material = materials.get(area)!;
  });
  // The file's LODs, finest first, switched by distance in units of the model's size.
  const lodNodes = gltf.scene.children[0]?.children ?? [];
  const size = new THREE.Box3().setFromObject(lodNodes[0] ?? gltf.scene).getBoundingSphere(new THREE.Sphere()).radius || 50;
  const lod = new THREE.LOD();
  lodNodes.slice().forEach((node, i) => lod.addLevel(node, i === 0 ? 0 : size * 12 * 2 ** (i - 1)));
  lod.userData = { typeID, radius: size, hull: info.hull ?? null };
  return lod;
}
