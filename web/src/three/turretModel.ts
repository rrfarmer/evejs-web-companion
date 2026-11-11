// Turrets on hulls, as the client fits them: turretSet.py FitTurrets takes the ship's fitted turret modules (a slim
// item's modules: itemID, typeID, flagID; slot = the flag's place in the high or medium rack, else -1), sorted by slot,
// and loads each one's EveTurretSet (its type's graphicFile); an NPC hull with no modules gets its gfxTurretID's set,
// one turret set per numbered locator group (GetTurretSetCount), slots 1, 2, ... Each set takes its ship's faction's
// material (EveSOF::SetupTurretMaterialFromFaction: the faction's materials for the generic turretAreaType, Primary),
// and EveMobile::RebuildTurretPositions puts one turret at each of "<locatorName><slot>a", "...b" and on, the hull's
// turret locators (EveSOFDataHull.locatorTurrets).
//
// Each turret is its model's first LOD hung on its skeleton (a turret's vertices are bound rigidly, one bone each: the
// mesh is split by bone, each part under its bone's node through the bone's inverse bind), with the quadv5 hull
// material, and aimed as EveTurretSet::UpdateSingleTurrets aims it (EveTurretAiming::ModifySystemBoneTransform on the
// "Sys_*" bones, the target in the turret's own space, by the tracking influence). Not yet: the Granny animations
// (Deploy, Fire, Pack: the bind pose stands in), bottomClipHeight, the special locator names' sequential fit.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";
import { HULL_TEXTURE_ROLES, sofHullMaterial, type SofArea, type SofMaterial } from "./hullModel.ts";

/** A turret module's graphic as the extractor reads it (lib/turret.mjs, turretBuild 2; GET /client-assets/turret/<typeID>). */
export interface TurretModelInfo {
  turret?: null;
  model?: string | null; locatorName?: string; effect?: string | null; maxCyclingFirePos?: number;
  textures?: Record<string, string | null>; params?: Record<string, number[]>;
  skeleton?: { bones: TurretBone[]; vertexBones: number[] | null } | null;
  aiming?: TurretAimingData | null;
}
interface TurretBone { name: string; parent: number; position: number[]; orientation: number[]; scaleShear: number[]; inverseWorld: number[] | null }
/** EveTurretAiming's numbers (degrees where angles). */
interface TurretAimingData {
  height: number; pitchFactor: number; pitchOffset: number; pitchMin: number; pitchMax: number;
  pitch01Factor: number; pitch01Offset: number; pitch02Factor: number; pitch02Offset: number; pitch03Factor: number; pitch03Offset: number;
}
/** EveTurretAiming::SystemBones, in its order, by the names the skeletons give them. */
const SYS_BONES = ["Sys_Rotation_Arm", "Sys_Rotation_Arm01", "Sys_Rotation_Arm02", "Sys_CounterRotation", "Sys_Pitch_Barrel", "Sys_Pitch_Barrel1",
  "Sys_Pitch_Barrel2", "Sys_Height", "Sys_Pitch_Arm01", "Sys_Pitch_Arm02", "Sys_Pitch_Arm03", "Sys_Pitch_Arm04", "Sys_Pitch_Arm05", "Sys_Pitch_Arm06"] as const;
const DEG = Math.PI / 180;
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * One turret: its bone nodes (rest transforms kept), aimed each frame. `root` is in the turret's locator frame (EVE's
 * space); the muzzles are the "Pos_Fire" bones in order (GetFiringBoneWorldTransform).
 */
export class TurretRig {
  readonly root = new THREE.Group();
  readonly bones: THREE.Object3D[] = [];
  private readonly rest: { p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  readonly muzzles: THREE.Object3D[] = [];
  /** EveTurretSet's tracking influence (0 .. maxTrackingTime, 1 here), faded over TRACKING_FADE_TIME (1 s). */
  influence = 0;
  /** The last target aimed at (the turret's own space), kept while the influence fades out. */
  private target: THREE.Vector3 | null = null;
  /** The module this turret's set is (aiming and firing follow it); null: every firing of its ship (an NPC's). */
  moduleID: number | null = null;

  constructor(readonly aimData: TurretAimingData | null) {}

  addBone(b: TurretBone, parent: THREE.Object3D | null): THREE.Object3D {
    const o = new THREE.Object3D();
    o.name = `bone:${b.name}`;
    const p = new THREE.Vector3(b.position[0] ?? 0, b.position[1] ?? 0, b.position[2] ?? 0);
    const q = new THREE.Quaternion(b.orientation[0] ?? 0, b.orientation[1] ?? 0, b.orientation[2] ?? 0, b.orientation[3] ?? 1);
    o.position.copy(p); o.quaternion.copy(q);
    o.scale.set(b.scaleShear[0] ?? 1, b.scaleShear[4] ?? 1, b.scaleShear[8] ?? 1);
    (parent ?? this.root).add(o);
    this.bones.push(o);
    this.rest.push({ p, q });
    if (/^Pos_Fire/i.test(b.name)) this.muzzles.push(o);
    return o;
  }

  /**
   * One frame: the influence toward 1 while `aimAt` (the world's point) is given, toward 0 without, then the system
   * bones from their rest by ModifySystemBoneTransform (no pitch pose: the turret's own origin is the pitch's).
   */
  update(aimAt: THREE.Vector3 | null, dt: number): void {
    if (aimAt) {
      this.root.updateWorldMatrix(true, false);
      this.target = aimAt.clone().applyMatrix4(this.root.matrixWorld.clone().invert());
    }
    this.influence = Math.max(0, Math.min(1, this.influence + (aimAt ? dt : -dt)));
    this.bones.forEach((o, i) => { o.position.copy(this.rest[i]!.p); o.quaternion.copy(this.rest[i]!.q); });
    const t = this.target, a = this.aimData;
    if (!t || this.influence === 0 || !a) return;
    const inf = this.influence;
    const n = t.clone().normalize();
    const pitch = (min: number, max: number, factor: number, offset: number) => {
      const r = Math.asin(Math.max(-1, Math.min(1, n.y)));
      return (factor * Math.min(max, Math.max(min, r)) + offset * DEG) * inf;
    };
    for (const name of SYS_BONES) {
      const o = this.bones.find((b) => b.name === `bone:${name}`);
      if (!o) continue;
      if (/^Sys_Rotation_Arm/.test(name) || name === "Sys_CounterRotation") {
        const alpha = (name === "Sys_CounterRotation" ? -1 : 1) * Math.atan2(t.x, t.z) * inf;
        o.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, alpha));
      } else if (/^Sys_Pitch_Barrel/.test(name)) {
        o.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, -pitch(a.pitchMin * DEG, a.pitchMax * DEG, a.pitchFactor, a.pitchOffset)));
      } else if (name === "Sys_Height") {
        o.position.y += Math.max(0, Math.min(1, n.y)) * inf * a.height;
      } else {
        const k = Number(name.slice(-2));
        const f = k === 1 ? a.pitch01Factor : k === 2 ? a.pitch02Factor : k === 3 ? a.pitch03Factor : 1;
        const off = k === 1 ? a.pitch01Offset : k === 2 ? a.pitch02Offset : k === 3 ? a.pitch03Offset : 0;
        o.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, -pitch(0, a.pitchMax * DEG, f, off)));
      }
    }
  }
}
/** The hull's turret locators and its Primary area's materials (hullModel.ts loadModel puts them in userData). */
export interface HullTurretData {
  turretLocators: { name: string; transform: number[] }[];
  primary: { materials: (SofMaterial | null)[]; glowColor: number[] | null } | null;
}
/** One module to fit: its type and slot (-1: none, the count's sets take slots 1, 2, ...), how many sets. */
export interface TurretFit { typeID: number; slot: number; count: number; moduleID?: number | null }

/**
 * A turret's rig: its bones from the skeleton (none: one node), each bone's parts under it through the bone's inverse
 * bind and the glb's mirror (the glb is in glTF's mirrored space; the rig is in EVE's).
 */
function rigOf(info: TurretModelInfo, parts: TurretParts): TurretRig {
  const rig = new TurretRig(info.aiming ?? null);
  const bones = info.skeleton?.bones ?? [];
  const nodes: THREE.Object3D[] = [];
  bones.forEach((b) => { nodes.push(rig.addBone(b, b.parent >= 0 ? nodes[b.parent] ?? null : null)); });
  for (const [bone, meshes] of parts.byBone) {
    const node = bone >= 0 ? nodes[bone] : undefined;
    const holder = new THREE.Object3D();
    holder.matrixAutoUpdate = false;
    const inv = node ? bones[bone]!.inverseWorld : null;
    if (inv) holder.matrix.fromArray(inv);
    const mirror = new THREE.Group();
    mirror.scale.set(1, 1, -1);
    for (const m of meshes) mirror.add(m.clone());
    holder.add(mirror);
    (node ?? rig.root).add(holder);
  }
  return rig;
}

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
/** A turret type's parts: for each bone, the meshes of its share of the first LOD (geometry and material shared). */
interface TurretParts { byBone: Map<number, THREE.Mesh[]> }
const meshes = new Map<string, Promise<TurretParts | null>>();
const textures = new Map<string, Promise<THREE.Texture | undefined>>();
const tex = (url: string) => {
  if (!textures.has(url)) textures.set(url, loadDds(url).then((t) => t as THREE.Texture).catch(() => undefined));
  return textures.get(url)!;
};

/**
 * The turret's model with its material, made once per turret graphic and hull faction: the glb's first LOD, quadv5 as
 * the hull's areas draw it (sofHullMaterial), its own textures, the faction's Primary materials over the file's.
 */
function turretProto(info: TurretModelInfo, hull: HullTurretData, key: string): Promise<TurretParts | null> {
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
    // each of the LOD's meshes split by its triangles' bone (the first vertex's: the binding is rigid)
    const vb = info.skeleton?.vertexBones ?? null;
    const byBone = new Map<number, THREE.Mesh[]>();
    lod0.updateWorldMatrix(true, true);
    lod0.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry.index) return;
      const index = m.geometry.index.array;
      const split = new Map<number, number[]>();
      for (let i = 0; i < index.length; i += 3) {
        const bone = vb ? vb[index[i]!] ?? 0 : -1;
        let list = split.get(bone);
        if (!list) split.set(bone, list = []);
        list.push(index[i]!, index[i + 1]!, index[i + 2]!);
      }
      for (const [bone, idx] of split) {
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(m.geometry.attributes)) g.setAttribute(name, attr);
        g.setIndex(idx);
        g.applyMatrix4(m.matrixWorld);
        const part = new THREE.Mesh(g, material);
        part.frustumCulled = false;
        if (!byBone.has(bone)) byBone.set(bone, []);
        byBone.get(bone)!.push(part);
      }
    });
    return { byBone };
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
  const rigs: TurretRig[] = [];
  group.userData.rigs = rigs;
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
      placed.push(turretProto(info, hull, `${fit.typeID}:${faction ?? ""}`).then((parts) => {
        if (!parts) return;
        for (const l of locs) {
          const rig = rigOf(info, parts);
          rig.moduleID = fit.moduleID ?? null;
          const at = rig.root;
          at.matrixAutoUpdate = false;
          at.matrix.fromArray(l.transform);
          at.name = `turret:${l.name}`;
          at.userData.rig = rig;
          group.add(at);
          rigs.push(rig);
        }
      }));
    }
  }
  await Promise.all(placed);
  return group.children.length ? group : null;
}
