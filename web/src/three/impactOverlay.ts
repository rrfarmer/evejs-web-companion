// A ship's damage impacts (Trinity's EveImpactOverlay and its EveDamageOverlay, as EveSOF::SetupImpactEffects sets them
// up): its damage state picks the configuration - shield while the shield is above 5 %, then armor while the armor is,
// then hull - and each weapon hit (CreateImpact: a damage locator, the way to the shooter, a life and a size) lands by
// it. In armor and hull it makes or grows a hole at the locator and sprays the generic armor debris from there (in hull
// the hull smoke too): Tr2GpuSharedEmitter::SpawnOnce into the scene's GPU particle system (gpuParticles.ts), scaled by
// the hole's size and the ship's, the count by how big the ship is on the screen.
//
// Drawn so far: the debris and smoke. Kept but not drawn: the holes (fxarmorimpactv5, a re-draw of the hull) and the
// shield's ripples (fxshieldimpactv5 on the ellipsoid). Left out: the hull flicker (the activation strength), the
// holes made at assembly from the model's seed, part overlays, the occluded-locator filter.

import * as THREE from "three";
import { GpuEmitter, gpuSystemOf, type GpuEmitterData } from "./gpuParticles.ts";

/** The hull's impact setup as the extractor writes it (extract.mjs: built.impact). */
export interface SofImpact {
  type: number;
  ellipsoid: { center: number[] | null; radius: number[] | null };
  /** The "damage" locator set: [x, y, z, qx, qy, qz, qw] each, in the hull's space. */
  damageLocators: number[][];
  armorEmitter: GpuEmitterData | null;
  hullEmitter: GpuEmitterData | null;
  flicker: { speed: number; alpha: number; beta: number; n: number } | null;
}

export type ImpactConfiguration = "invalid" | "shield" | "armor" | "hull";

/** EveDamageOverlay.h:20-21: a hole's radius is size x 0.0129 x the parent's size, that at most 10 / 0.0129. */
const IMPACT_ARMOR_SIZE_FACTOR = 0.0129, IMPACT_ARMOR_SIZE_MAX = 10;
const ARMOR_PARENT_MAX = IMPACT_ARMOR_SIZE_MAX / IMPACT_ARMOR_SIZE_FACTOR;
/** A hole past the goal count shrinks by dt / this (EveDamageOverlay's armorImpactLifeTime). */
const ARMOR_IMPACT_LIFETIME = 10;
/** The debris count's screen size, in pixels, for the whole rate (IMPACT_ARMOR_PARTICLE_LOD_FACTOR). */
const PARTICLE_LOD_PIXELS = 400;

interface Hole { locator: number; size: number; spray: boolean }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class ImpactOverlay {
  configuration: ImpactConfiguration = "invalid";
  private shield = 1; private armor = 1; private hull = 1;
  /** By index, oldest first (the map's order). */
  private readonly holes = new Map<number, Hole>();
  private nextIndex = 1;
  private readonly armorEmitter: GpuEmitter | null;
  private readonly hullEmitter: GpuEmitter | null;
  /** How many particles the last update sent (for checks). */
  lastSpawned = 0;

  /** anchor: the model's impact anchor (impactAnchor), in EVE's model space. */
  constructor(readonly anchor: THREE.Object3D, readonly sof: SofImpact, private readonly boundingRadius: number) {
    this.armorEmitter = sof.armorEmitter ? new GpuEmitter(sof.armorEmitter) : null;
    this.hullEmitter = sof.hullEmitter ? new GpuEmitter(sof.hullEmitter) : null;
  }

  /** min(bounding radius, 775.19): the holes' and the debris' size (armorImpactParentSize). */
  get armorParentSize(): number { return Math.min(this.boundingRadius, ARMOR_PARENT_MAX); }
  /** The holes kept (index rank below it), the rest shrinking: int(12 (1 - armor) + 4 (1 - hull)). */
  get goalCount(): number { return Math.trunc(12 * clamp01(1 - this.armor) + 4 * clamp01(1 - this.hull)); }
  get holeCount(): number { return this.holes.size; }

  /** EveDamageOverlay::SetDamageState (:450-495): the fractions left; the configuration from them. */
  setDamageState(shield: number, armor: number, hull: number): void {
    this.shield = clamp01(shield); this.armor = clamp01(armor); this.hull = clamp01(hull);
    this.configuration = this.shield > 0.05 ? "shield" : this.armor > 0.05 ? "armor" : this.hull > 0 ? "hull" : "invalid";
  }

  /** The locator facing a point best (in the world): the turret's choice of where its shot lands, roughly. */
  locatorFacing(worldPoint: THREE.Vector3): number {
    const locs = this.sof.damageLocators;
    if (!locs.length) return -1;
    this.anchor.updateWorldMatrix(true, false);
    const local = this.anchor.worldToLocal(worldPoint.clone());
    let best = 0, bestFit = -Infinity;
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    locs.forEach((l, i) => {
      p.set(l[0]!, l[1]!, l[2]!);
      n.set(0, 1, 0).applyQuaternion(new THREE.Quaternion(l[3]!, l[4]!, l[5]!, l[6]!));
      const fit = n.dot(local.clone().sub(p).normalize());
      if (fit > bestFit) { bestFit = fit; best = i; }
    });
    return best;
  }

  /**
   * EveImpactOverlay::CreateImpact (:558-579): in shield (a hull with a shield mesh) a ripple, not drawn here (-1); in
   * armor or hull EveDamageOverlay::CreateImpact (:511-533) - the hole at the locator grown to the size and sprayed
   * again, or a new one. Its index, -1 for none.
   */
  createImpact(locator: number, size: number): number {
    if (locator < 0 || locator >= this.sof.damageLocators.length) return -1;
    if (this.configuration !== "armor" && this.configuration !== "hull") return -1;
    for (const [index, h] of this.holes) {
      if (h.locator !== locator) continue;
      h.size = Math.max(size, h.size);
      h.spray = true;
      return index;
    }
    const index = this.nextIndex++;
    this.holes.set(index, { locator, size, spray: true });
    return index;
  }

  /**
   * One frame: the holes past the goal count shrink (EveDamageOverlay.cpp:241-259), then each new or refreshed hole
   * sprays (EveImpactOverlay::SpawnImpactDebris, :116-180) - the armor debris, in hull the smoke too - from its
   * locator's place along its normal (+y turned by its rotation), with the ship's velocity (the world's), scaled by
   * size x min(R, 775.19) / 775.19, the count by clamp(pixel diameter / 400).
   */
  update(dt: number, scene: THREE.Object3D, velocity: THREE.Vector3, pixelDiameter: number): void {
    this.lastSpawned = 0;
    let rank = 0;
    const goal = this.goalCount;
    for (const [index, h] of this.holes) {
      if (rank++ < goal) continue;
      h.size -= dt / ARMOR_IMPACT_LIFETIME;
      if (h.size <= 0) this.holes.delete(index);
    }
    if (!this.armorEmitter) return;
    const parentSize = this.armorParentSize;
    if (parentSize <= 0) return;
    let system: ReturnType<typeof gpuSystemOf> | null = null;
    this.anchor.updateWorldMatrix(true, false);
    const world = this.anchor.matrixWorld;
    for (const h of this.holes.values()) {
      if (!h.spray) continue;
      h.spray = false;
      const l = this.sof.damageLocators[h.locator]!;
      const pos = new THREE.Vector3(l[0]!, l[1]!, l[2]!).applyMatrix4(world);
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(l[3]!, l[4]!, l[5]!, l[6]!)).transformDirection(world);
      const scale = h.size * parentSize / ARMOR_PARENT_MAX;
      const rateModifier = clamp01(pixelDiameter / PARTICLE_LOD_PIXELS);
      system ??= gpuSystemOf(scene);
      this.lastSpawned += this.armorEmitter.spawnOnce(system, pos, dir, velocity, scale, rateModifier);
      if (this.hullEmitter && this.configuration === "hull") this.lastSpawned += this.hullEmitter.spawnOnce(system, pos, dir, velocity, scale, rateModifier);
    }
  }
}

/**
 * A hull model's impact anchor: EVE's model space (mirrored in z as the model is), its setup as data on it (a model is
 * cloned for each ball, its userData copied: each clone's overlay is made from its own anchor, impactOverlayOf).
 */
export function impactAnchor(sof: SofImpact, boundingRadius: number): THREE.Object3D {
  const anchor = new THREE.Group();
  anchor.name = "impact-overlay";
  anchor.scale.set(1, 1, -1);
  anchor.userData.impact = { sof, boundingRadius };
  return anchor;
}
const overlays = new WeakMap<THREE.Object3D, ImpactOverlay>();
/** The impact overlay of a model (a clone's own, made on first ask), or null where its hull has none. */
export function impactOverlayOf(model: THREE.Object3D): ImpactOverlay | null {
  let anchor: THREE.Object3D | null = null;
  model.traverse((o) => { if (!anchor && o.name === "impact-overlay" && o.userData.impact) anchor = o; });
  if (!anchor) return null;
  const a = anchor as THREE.Object3D;
  let overlay = overlays.get(a);
  if (!overlay) {
    const { sof, boundingRadius } = a.userData.impact as { sof: SofImpact; boundingRadius: number };
    overlay = new ImpactOverlay(a, sof, boundingRadius);
    overlays.set(a, overlay);
  }
  return overlay;
}
