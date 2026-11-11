// Turrets on hulls, as the client fits them: turretSet.py FitTurrets takes the ship's fitted turret modules (a slim
// item's modules: itemID, typeID, flagID; slot = the flag's place in the high or medium rack, else -1), sorted by slot,
// and loads each one's EveTurretSet (its type's graphicFile); an NPC hull with no modules gets its gfxTurretID's set,
// one turret set per numbered locator group (GetTurretSetCount), slots 1, 2, ... Each set takes its ship's faction's
// material (EveSOF::SetupTurretMaterialFromFaction: the faction's materials for the generic turretAreaType, Primary),
// and EveMobile::RebuildTurretPositions puts one turret at each of "<locatorName><slot>a", "...b" and on, the hull's
// turret locators (EveSOFDataHull.locatorTurrets).
//
// Drawn here: each turret's model (its first LOD) at rest in its bind pose, with the quadv5 hull material. Not yet:
// the aiming (the yaw and pitch bones), firing animations, bottomClipHeight, the special locator names' sequential fit.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";
import { HULL_TEXTURE_ROLES, sofHullMaterial, type SofArea, type SofMaterial } from "./hullModel.ts";

/** A turret module's graphic as the extractor reads it (lib/turret.mjs, turretBuild 2; GET /client-assets/turret/<typeID>). */
export interface TurretModelInfo {
  turret?: null;
  model?: string | null; locatorName?: string; effect?: string | null;
  textures?: Record<string, string | null>; params?: Record<string, number[]>;
}
/** The hull's turret locators and its Primary area's materials (hullModel.ts loadModel puts them in userData). */
export interface HullTurretData {
  turretLocators: { name: string; transform: number[] }[];
  primary: { materials: (SofMaterial | null)[]; glowColor: number[] | null } | null;
}
/** One module to fit: its type and slot (-1: none, the count's sets take slots 1, 2, ...), how many sets. */
export interface TurretFit { typeID: number; slot: number; count: number }

const LOCATOR_TURRET = "locator_turret_";
const infos = new Map<number, Promise<TurretModelInfo | null>>();
export function turretModelInfo(typeID: number): Promise<TurretModelInfo | null> {
  if (!infos.has(typeID)) infos.set(typeID, fetch(`/client-assets/turret/${typeID}`).then((r) => r.json() as Promise<TurretModelInfo>).then((t) => (t && t.model ? t : null)).catch(() => null));
  return infos.get(typeID)!;
}

/** turretSet.py GetSlotFromModuleFlagID: flagHiSlot0 27.., flagMedSlot0 19..: 1-based; else -1. */
export function slotOfFlag(flagID: number): number {
  if (flagID >= 27 && flagID <= 34) return flagID - 27 + 1;
  if (flagID >= 19 && flagID <= 26) return flagID - 19 + 1;
  return -1;
}

/** TurretSet.Initialize's locator name: the file's, "locator_turret_" where empty, a trailing digit cut. */
function locatorNameOf(info: TurretModelInfo): string {
  const n = info.locatorName ?? "";
  if (!n) return LOCATOR_TURRET;
  return /\d$/.test(n) ? n.slice(0, -1) : n;
}

/** GetTurretSetCount: how many numbered locator groups the hull has for the set's locator name (else locator_turret_). */
export function turretSetCount(hull: HullTurretData, info: TurretModelInfo): number {
  const name = locatorNameOf(info);
  let locs = hull.turretLocators.filter((l) => l.name.startsWith(name));
  if (!locs.length) locs = hull.turretLocators.filter((l) => l.name.startsWith(LOCATOR_TURRET));
  return new Set(locs.map((l) => l.name.replace(/\D/g, ""))).size;
}

const loader = new GLTFLoader();
const meshes = new Map<string, Promise<THREE.Object3D | null>>();
const textures = new Map<string, Promise<THREE.Texture | undefined>>();
const tex = (url: string) => {
  if (!textures.has(url)) textures.set(url, loadDds(url).then((t) => t as THREE.Texture).catch(() => undefined));
  return textures.get(url)!;
};

/**
 * The turret's model with its material, made once per turret graphic and hull faction: the glb's first LOD, quadv5 as
 * the hull's areas draw it (sofHullMaterial), its own textures, the faction's Primary materials over the file's.
 */
function turretProto(info: TurretModelInfo, hull: HullTurretData, key: string): Promise<THREE.Object3D | null> {
  if (!meshes.has(key)) meshes.set(key, (async () => {
    const gltf = await loader.loadAsync(info.model!);
    const lod0 = gltf.scene.children[0]?.children[0] ?? gltf.scene;
    const maps: Record<string, THREE.Texture | undefined> = {};
    await Promise.all(Object.entries(info.textures ?? {}).map(async ([name, url]) => { const role = HULL_TEXTURE_ROLES[name]; if (role && url) maps[role] = await tex(url); }));
    if (maps.albedo) maps.albedo.colorSpace = THREE.SRGBColorSpace;
    const p = info.params ?? {};
    // the file's own Mtl1..4 (its "overridable" defaults), each replaced by the faction's where it has one
    const own = [1, 2, 3, 4].map((i): SofMaterial | null => p[`Mtl${i}DiffuseColor`] ? {
      name: `turret-mtl${i}`, diffuse: p[`Mtl${i}DiffuseColor`] ?? null, dust: p[`Mtl${i}DustDiffuseColor`] ?? null,
      fresnel: p[`Mtl${i}FresnelColor`] ?? null, gloss: p[`Mtl${i}Gloss`]?.[0] ?? null,
    } as SofMaterial : null);
    const area: SofArea = {
      kind: "opaque", name: "turret", index: 0, areaType: "Primary", shader: `quad/${info.effect ?? "quadv5"}.fx`, textures: {},
      params: { GeneralData: p.GeneralData ?? [1, 1, 0, 0] },
      materials: own.map((m, i) => hull.primary?.materials[i] ?? m),
      glowColor: hull.primary?.glowColor ?? p.GeneralGlowColor ?? null,
    };
    const material = sofHullMaterial(maps, area);
    const proto = lod0.clone(true);
    proto.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material; });
    return proto;
  })().catch((e) => { console.warn("turret model", info.model, e); return null; }));
  return meshes.get(key)!;
}

/**
 * The turrets of a hull's fit, as one group in the hull model's space (EVE's, mirrored in z as the hull's children
 * are): FitTurrets' order (by slot), each set's turrets at its locators. `faction` keys the material cache.
 */
export async function buildTurrets(hull: HullTurretData, fits: readonly TurretFit[], faction: string | null): Promise<THREE.Group | null> {
  if (!hull.turretLocators.length || !fits.length) return null;
  const group = new THREE.Group();
  group.name = "turrets";
  group.scale.set(1, 1, -1);
  const sorted = [...fits].sort((a, b) => a.slot - b.slot);
  const placed: Promise<void>[] = [];
  let counter = 1;
  for (const fit of sorted) {
    const info = await turretModelInfo(fit.typeID);
    if (!info) continue;
    const slot = fit.slot || counter;
    counter += fit.count;
    for (let i = 0; i < fit.count; i++) {
      const slotNumber = slot < 0 ? i + 1 : slot;
      // RebuildTurretPositions for a "_turret_" name: the slot's locators a, b, ... (CountLocatorsByPrefix)
      let name = locatorNameOf(info);
      if (!name.includes("_turret_") && !hull.turretLocators.some((l) => l.name.startsWith(name))) name = LOCATOR_TURRET;
      const base = `${name}${slotNumber}`;
      const locs = hull.turretLocators.filter((l) => l.name.startsWith(base) && /^[a-z]$/.test(l.name.slice(base.length)));
      placed.push(turretProto(info, hull, `${fit.typeID}:${faction ?? ""}`).then((proto) => {
        if (!proto) return;
        for (const l of locs) {
          const at = new THREE.Object3D();
          at.matrixAutoUpdate = false;
          at.matrix.fromArray(l.transform);
          // the glb is mirrored into glTF's space: mirrored back inside the locator's EVE-space frame
          const mirror = new THREE.Group();
          mirror.scale.set(1, 1, -1);
          mirror.add(proto.clone(true));
          at.add(mirror);
          at.name = `turret:${l.name}`;
          group.add(at);
        }
      }));
    }
  }
  await Promise.all(placed);
  return group.children.length ? group : null;
}
