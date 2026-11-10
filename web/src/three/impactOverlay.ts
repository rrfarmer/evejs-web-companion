// A ship's damage impacts (Trinity's EveImpactOverlay and its EveDamageOverlay, as EveSOF::SetupImpactEffects sets them
// up): its damage state picks the configuration - shield while the shield is above 5 %, then armor while the armor is,
// then hull - and each weapon hit (CreateImpact: a damage locator, the way to the shooter, a life and a size) lands by
// it. In armor and hull it makes or grows a hole at the locator and sprays the generic armor debris from there (in hull
// the hull smoke too): Tr2GpuSharedEmitter::SpawnOnce into the scene's GPU particle system (gpuParticles.ts), scaled by
// the hole's size and the ship's, the count by how big the ship is on the screen.
//
// In shield (a hull of impact type 1: an ellipsoid shield) a hit is a ripple on the shield's ellipsoid where the way
// from the locator to the shooter leaves it (fxshieldimpactv5, its compiled record read: the ripple's brightness and
// radius over its life from TemporalFadeoutMap, its fall-off from RadialIntensityMap, the race's colours, a fresnel),
// drawn added on a sphere stretched to the ellipsoid while a ripple lives.
//
// Drawn so far: the debris, the smoke and the ripples. Kept but not drawn: the holes (fxarmorimpactv5, a re-draw of
// the hull). Left out: the shield's booster and hardener layers (their kick-ins nought without SetImpactAnimation), its
// froxel fog (1), the ripple's way to the shooter followed each frame (the turret's UpdateImpact: here the one at the
// hit), the hull flicker (the activation strength), the holes made at assembly from the model's seed, part overlays,
// the occluded-locator filter.

import * as THREE from "three";
import { GpuEmitter, gpuSystemOf, type GpuEmitterData } from "./gpuParticles.ts";
import { loadDds } from "./ddsTexture.ts";
import { logDepth } from "./logDepth.ts";

/** The hull's impact setup as the extractor writes it (extract.mjs: built.impact). */
export interface SofImpact {
  type: number;
  ellipsoid: { center: number[] | null; radius: number[] | null };
  /** The "damage" locator set: [x, y, z, qx, qy, qz, qw] each, in the hull's space. */
  damageLocators: number[][];
  armorEmitter: GpuEmitterData | null;
  hullEmitter: GpuEmitterData | null;
  flicker: { speed: number; alpha: number; beta: number; n: number } | null;
  /** The race's shield effect (type 1): its parameters and textures (served URLs). */
  shield?: { params: Record<string, number[] | null>; textures: Record<string, string | null> } | null;
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
/** A shield ripple (EveImpactOverlay's ShieldImpact): its way to the shooter (world), its life left and whole, where it is. */
interface Ripple { locator: number; direction: THREE.Vector3; timeLeft: number; lifeTime: number; size: number; intensity: number; at: THREE.Vector3 }
/** m_maxShieldImpacts; IMPACT_SHIELD_FADEOUT (a ripple lives 1.5 x the hit's life). */
const MAX_SHIELD_IMPACTS = 8, IMPACT_SHIELD_FADEOUT = 1.5;

/**
 * BoundingSphere.cpp IntersectEllipsoidRay (:127-149): where a ray from inside leaves the ellipsoid (or where one from
 * outside meets it); none (null) where it misses.
 */
function intersectEllipsoidRay(center: THREE.Vector3, radii: THREE.Vector3, origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
  const v = dir.clone().divide(radii), s = origin.clone().sub(center).divide(radii);
  const vv = v.dot(v), vs = v.dot(s), ss = s.dot(s);
  const pq = (vs / vv) ** 2 - ss / vv + 1 / vv;
  if (!(pq >= 0)) return null;
  let t = -Math.sqrt(pq) - vs / vv;
  if (t < 0) t = Math.sqrt(pq) - vs / vv;
  return origin.clone().addScaledVector(dir, t);
}

const shieldTextures = new Map<string, Promise<THREE.Texture | null>>();
function shieldTexture(url: string | null | undefined): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  if (!shieldTextures.has(url)) shieldTextures.set(url, loadDds(url).then((t) => {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t as THREE.Texture;
  }).catch(() => null));
  return shieldTextures.get(url)!;
}

/**
 * fxshieldimpactv5 (its compiled record 0): the vertex a unit sphere's, on the ellipsoid (EllipsoidRadii x n +
 * EllipsoidCenter, the object's space), the ellipsoid's normal; per ripple the age 1 - sat(timeLeft / lifeTime),
 * F = TemporalFadeoutMap(age, age), brightness intensity x ShieldImpactData.z x F.x, radius F.z x ShieldImpactData.x x
 * parent size x size, summed RadialIntensityMap(sat(distance / radius)).x x brightness; out (the sum, saturated, x
 * ShieldColorIntensity.x x mix(Full, Empty, colour fade)) x |dot(eye, normal)|^ShieldFresnel.x, alpha 1, added.
 */
function shieldMaterial(params: Record<string, number[] | null>, center: THREE.Vector3, radii: THREE.Vector3): THREE.ShaderMaterial {
  const p = (name: string, d: number[]) => new THREE.Vector4(...([0, 1, 2, 3].map((i) => params[name]?.[i] ?? d[i]!) as [number, number, number, number]));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      imp0: { value: Array.from({ length: MAX_SHIELD_IMPACTS }, () => new THREE.Vector4()) },
      imp1: { value: Array.from({ length: MAX_SHIELD_IMPACTS }, () => new THREE.Vector4()) },
      count: { value: 0 }, colorFade: { value: 0 }, parentSize: { value: 70 },
      ellipsoidCenter: { value: center }, ellipsoidRadii: { value: radii },
      ShieldImpactData: { value: p("ShieldImpactData", [1, 1, 1, 1]) },
      ShieldColorIntensity: { value: p("ShieldColorIntensity", [1, 1, 1, 1]) },
      FullShieldColor: { value: p("FullShieldColor", [1, 1, 1, 1]) },
      EmptyShieldColor: { value: p("EmptyShieldColor", [1, 1, 1, 1]) },
      ShieldFresnel: { value: p("ShieldFresnel", [1, 0, 0, 0]) },
      RadialIntensityMap: { value: null }, TemporalFadeoutMap: { value: null },
    },
    vertexShader: `uniform vec3 ellipsoidCenter; uniform vec3 ellipsoidRadii;
      varying vec3 vOS; varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize( position );
        vec3 pOS = ellipsoidRadii * n + ellipsoidCenter;
        vOS = pOS;
        vec4 world = modelMatrix * vec4( pOS, 1.0 );
        vN = mat3( modelMatrix ) * normalize( pOS / ( ellipsoidRadii * ellipsoidRadii ) );
        vV = cameraPosition - world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `uniform vec4 imp0[${MAX_SHIELD_IMPACTS}]; uniform vec4 imp1[${MAX_SHIELD_IMPACTS}]; uniform int count;
      uniform float colorFade; uniform float parentSize;
      uniform vec4 ShieldImpactData; uniform vec4 ShieldColorIntensity; uniform vec4 FullShieldColor; uniform vec4 EmptyShieldColor; uniform vec4 ShieldFresnel;
      uniform sampler2D RadialIntensityMap; uniform sampler2D TemporalFadeoutMap;
      varying vec3 vOS; varying vec3 vN; varying vec3 vV;
      void main() {
        float sum = 0.0;
        for ( int i = 0; i < ${MAX_SHIELD_IMPACTS}; i++ ) {
          if ( i >= count ) break;
          vec4 A = imp0[ i ], B = imp1[ i ];
          float age = 1.0 - clamp( A.w / B.w, 0.0, 1.0 );
          vec4 F = textureLod( TemporalFadeoutMap, vec2( age, age ), 0.0 );
          float bri = B.y * ShieldImpactData.z * F.x;
          float rad = F.z * ShieldImpactData.x * parentSize * B.x;
          float d = clamp( length( A.xyz - vOS ) / rad, 0.0, 1.0 );
          sum += bri * textureLod( RadialIntensityMap, vec2( d, d ), 0.0 ).x;
        }
        sum = clamp( sum, 0.0, 1.0 );
        vec3 color = mix( FullShieldColor.rgb, EmptyShieldColor.rgb, colorFade );
        float fres = pow( abs( dot( normalize( vV ), normalize( vN ) ) ), ShieldFresnel.x );
        gl_FragColor = vec4( fres * sum * ShieldColorIntensity.x * color, 1.0 );
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  return logDepth(material);
}

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
  private readonly ripples = new Map<number, Ripple>();
  /** The shield's draw (type 1 hulls with their race's effect), under the anchor; hidden while no ripple lives. */
  readonly shieldMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> | null = null;
  private readonly center = new THREE.Vector3();
  private readonly radii = new THREE.Vector3();

  /**
   * anchor: the model's impact anchor (impactAnchor), in EVE's model space; box: the model's bounds there, for a hull
   * with no shape ellipsoid (EveSpaceObject2::GetShapeEllipsoid: radius 0.5 sqrt 3 x the box's size, about its middle).
   */
  constructor(readonly anchor: THREE.Object3D, readonly sof: SofImpact, private readonly boundingRadius: number, box: THREE.Box3 | null = null) {
    this.armorEmitter = sof.armorEmitter ? new GpuEmitter(sof.armorEmitter) : null;
    this.hullEmitter = sof.hullEmitter ? new GpuEmitter(sof.hullEmitter) : null;
    const r = sof.ellipsoid?.radius, c = sof.ellipsoid?.center;
    if (r && (r[0] ?? 0) > 0) { this.radii.set(r[0]!, r[1] ?? 0, r[2] ?? 0); this.center.set(c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0); }
    else if (box && !box.isEmpty()) { box.getSize(this.radii).multiplyScalar(0.5 * Math.sqrt(3)); box.getCenter(this.center); }
    if (sof.type === 1 && sof.shield && this.radii.x > 0) {
      const material = shieldMaterial(sof.shield.params, this.center, this.radii);
      void shieldTexture(sof.shield.textures.RadialIntensityMap).then((t) => { material.uniforms.RadialIntensityMap!.value = t; });
      void shieldTexture(sof.shield.textures.TemporalFadeoutMap).then((t) => { material.uniforms.TemporalFadeoutMap!.value = t; });
      material.uniforms.parentSize!.value = Math.min(2000, Math.max(70, boundingRadius));
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
      mesh.name = "shield-impacts";
      mesh.visible = false;
      mesh.frustumCulled = false;
      anchor.add(mesh);
      this.shieldMesh = mesh;
    }
  }
  get rippleCount(): number { return this.ripples.size; }

  /** min(bounding radius, 775.19): the holes' and the debris' size (armorImpactParentSize). */
  get armorParentSize(): number { return Math.min(this.boundingRadius, ARMOR_PARENT_MAX); }
  /** The holes kept (index rank below it), the rest shrinking: int(12 (1 - armor) + 4 (1 - hull)). */
  get goalCount(): number { return Math.trunc(12 * clamp01(1 - this.armor) + 4 * clamp01(1 - this.hull)); }
  get holeCount(): number { return this.holes.size; }

  /** EveDamageOverlay::SetDamageState (:450-495): the fractions left; the configuration from them. */
  setDamageState(shield: number, armor: number, hull: number): void {
    this.shield = clamp01(shield); this.armor = clamp01(armor); this.hull = clamp01(hull);
    // EveImpactOverlay::SetDamageState (:534-540): the shield's colour toward the empty one as it goes
    if (this.shieldMesh) this.shieldMesh.material.uniforms.colorFade!.value = clamp01((1 - this.shield) ** 2);
    this.configuration = this.shield > 0.05 ? "shield" : this.armor > 0.05 ? "armor" : this.hull > 0 ? "hull" : "invalid";
  }

  /** A damage locator's place in the world (GetDamageLocatorPosition), or null for none. */
  locatorPosition(locator: number): THREE.Vector3 | null {
    const l = this.sof.damageLocators[locator];
    if (!l) return null;
    this.anchor.updateWorldMatrix(true, false);
    return new THREE.Vector3(l[0]!, l[1]!, l[2]!).applyMatrix4(this.anchor.matrixWorld);
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
   * EveImpactOverlay::CreateImpact (:558-579): in shield a ripple (CreateShieldImpact, a hull with a shield mesh); in
   * armor or hull EveDamageOverlay::CreateImpact (:511-533) - the hole at the locator grown to the size and sprayed
   * again, or a new one. direction: toward the shooter, in the world; lifeTime in seconds. Its index, -1 for none.
   */
  createImpact(locator: number, size: number, direction?: THREE.Vector3, lifeTime = 1): number {
    if (locator < 0 || locator >= this.sof.damageLocators.length) return -1;
    if (this.configuration === "shield") return this.shieldMesh && direction ? this.createShieldImpact(locator, direction, lifeTime, size) : -1;
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
   * EveImpactOverlay::CreateShieldImpact (:619-695): a hit near one of the locator's own ripples (their ways' dot above
   * 0.95) refreshes it - the new way, its life left 1.5 x lifeTime, the bigger size; with eight living the nearest of any
   * locator is taken so (its whole life kept); else a new one.
   */
  private createShieldImpact(locator: number, direction: THREE.Vector3, lifeTime: number, size: number): number {
    const n = direction.clone().normalize();
    let same = -1, sameDot = -Infinity, any = -1, anyDot = -Infinity;
    for (const [index, r] of this.ripples) {
      const d = n.dot(r.direction);
      if (r.locator === locator && d > sameDot) { sameDot = d; same = index; }
      if (d > anyDot) { anyDot = d; any = index; }
    }
    const refresh = (index: number) => {
      const r = this.ripples.get(index)!;
      r.direction.copy(n); r.timeLeft = IMPACT_SHIELD_FADEOUT * lifeTime; r.size = Math.max(size, r.size);
      return index;
    };
    if (same >= 0 && sameDot > 0.95) return refresh(same);
    if (this.ripples.size >= MAX_SHIELD_IMPACTS) return refresh(any);
    const index = this.nextIndex++;
    const life = IMPACT_SHIELD_FADEOUT * lifeTime;
    const ripple: Ripple = { locator, direction: n, timeLeft: life, lifeTime: life, size, intensity: 1, at: new THREE.Vector3() };
    this.ripples.set(index, ripple);
    this.placeRipple(ripple);
    return index;
  }

  /** GetShieldImpactPosition (:270-289): the way from the locator to the shooter, out through the ellipsoid (object space). */
  private placeRipple(r: Ripple): void {
    this.anchor.updateWorldMatrix(true, false);
    const l = this.sof.damageLocators[r.locator]!;
    const origin = new THREE.Vector3(l[0]!, l[1]!, l[2]!);
    const dir = r.direction.clone().transformDirection(this.anchor.matrixWorld.clone().invert());
    r.at.copy(intersectEllipsoidRay(this.center, this.radii, origin, dir) ?? new THREE.Vector3());
  }

  /** The ripples aged (erased at no life left: :189-200), placed again, and given to the shield's draw. */
  private stepRipples(dt: number): void {
    const mesh = this.shieldMesh;
    if (!mesh) return;
    for (const [index, r] of this.ripples) {
      r.timeLeft -= dt;
      if (r.timeLeft <= 0) this.ripples.delete(index);
      else this.placeRipple(r);
    }
    const u = mesh.material.uniforms;
    const imp0 = u.imp0!.value as THREE.Vector4[], imp1 = u.imp1!.value as THREE.Vector4[];
    let i = 0;
    for (const r of this.ripples.values()) {
      imp0[i]!.set(r.at.x, r.at.y, r.at.z, r.timeLeft);
      imp1[i]!.set(r.size, r.intensity, 0, r.lifeTime);
      i++;
    }
    u.count!.value = i;
    mesh.visible = i > 0;
  }

  /**
   * One frame: the ripples aged; the holes past the goal count shrink (EveDamageOverlay.cpp:241-259), then each new or refreshed hole
   * sprays (EveImpactOverlay::SpawnImpactDebris, :116-180) - the armor debris, in hull the smoke too - from its
   * locator's place along its normal (+y turned by its rotation), with the ship's velocity (the world's), scaled by
   * size x min(R, 775.19) / 775.19, the count by clamp(pixel diameter / 400).
   */
  update(dt: number, scene: THREE.Object3D, velocity: THREE.Vector3, pixelDiameter: number): void {
    this.lastSpawned = 0;
    this.stepRipples(dt);
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
  let anchor: THREE.Object3D | null = null, lod: THREE.LOD | null = null;
  model.traverse((o) => {
    if (!anchor && o.name === "impact-overlay" && o.userData.impact) anchor = o;
    if (!lod && (o as THREE.LOD).isLOD) lod = o as THREE.LOD;
  });
  if (!anchor) return null;
  const a = anchor as THREE.Object3D;
  let overlay = overlays.get(a);
  if (!overlay) {
    const { sof, boundingRadius } = a.userData.impact as { sof: SofImpact; boundingRadius: number };
    // the finest LOD's bounds in the anchor's space, for a hull with no shape ellipsoid
    let box: THREE.Box3 | null = null;
    const finest = (lod as THREE.LOD | null)?.levels[0]?.object;
    if (finest && !((sof.ellipsoid?.radius?.[0] ?? 0) > 0)) {
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(finest).applyMatrix4(a.matrixWorld.clone().invert());
    }
    overlay = new ImpactOverlay(a, sof, boundingRadius, box);
    overlays.set(a, overlay);
  }
  return overlay;
}
