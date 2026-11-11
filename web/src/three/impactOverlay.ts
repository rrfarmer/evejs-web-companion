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
// The holes are drawn as the client draws them, a re-draw of the hull's meshes with fxarmorimpactv5 (its compiled record
// read): about each hole a ragged edge (CutOffsetMap, a 3D noise in the hull's space over its armor size), a scorch
// (ArmorImpactColor) out to the edge and inside it the hole - InsideMap's metal, lit by the sun, with its glow - put
// over the hull premultiplied.
//
// The defensive modules play on it too (SetImpactAnimation, from the client's ImpactEffect: effects.ShieldBoosting,
// ModifyShieldResonance, ArmorRepair, TetheringRepair, ArmorHardening, StructureRepair): each starts a fader over a
// quarter of its cycle (Tr2ScalarFader) - the shield's boosting and hardening kick-ins pulse its 3D layers over the
// ellipsoid, the armor's hardening shimmers over the hull, its repairing and the hull's light the holes' edges.
//
// Left out: the froxel fog (1), the holes' inside lit by the environment and shadowed (the sun only),
// gammaBrightness (1), the ripple's way to the shooter followed each frame (the turret's UpdateImpact: here the one at
// the hit), the hull flicker (the activation strength), the holes made at assembly from the model's seed, part
// overlays, the occluded-locator filter, skinned hulls' variant.
//
// Below 90 % hull the ship's lights flicker (EveDamageOverlay::GetActivationStrength): its activation strength - the
// glow's and its children's - follows the generic damage's Perlin curve, clamped to [0.3, 1], over e^(the hull damage
// factor) (activationStrength; hullModel.ts setActivationStrength takes it to the model).

import * as THREE from "three";
import { GpuEmitter, gpuSystemOf, type GpuEmitterData } from "./gpuParticles.ts";
import { loadDds, loadDds3D } from "./ddsTexture.ts";
import { logDepth } from "./logDepth.ts";
import { curveValue, type Curve } from "./curves.ts";

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
  /** The race's armor holes' effect: its parameters and textures (served URLs). */
  armor?: { params: Record<string, number[] | null>; textures: Record<string, string | null> } | null;
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
 * Tr2ScalarFader: a value faded to 1 or 0 over a length, and on a fade in a kick-in sin(pi x^0.66)^3 over that length
 * (x the time into it over the length), nought after.
 */
class ScalarFader {
  value = 0;
  private fading = 0;
  private fadeTime = -1;
  private kickInLength = 1;
  update(dt: number): void {
    if (this.fading !== 0) {
      this.value += this.fading * dt;
      if (this.value < 0) { this.value = 0; this.fading = 0; } else if (this.value > 1) { this.value = 1; this.fading = 0; }
    }
    if (this.fadeTime >= 0) { this.fadeTime += dt; if (this.fadeTime > this.kickInLength) this.fadeTime = -1; }
  }
  start(fadeIn: boolean, length: number): void {
    this.kickInLength = Math.max(length, 1e-6);
    this.fading = (fadeIn ? 1 : -1) / this.kickInLength;
    if (fadeIn) this.fadeTime = 0;
  }
  get kickIn(): number {
    if (this.fadeTime < 0) return 0;
    const x = Math.min(1, Math.max(0, this.fadeTime / this.kickInLength));
    return Math.sin(Math.PI * x ** 0.66) ** 3;
  }
  get isZero(): boolean { return this.value === 0 && this.fading === 0; }
  get isKickInZero(): boolean { return this.fadeTime <= 0; }
}

/**
 * effects.* to its SetImpactAnimation name (the client's effects table, res:/staticdata/effects.fsdbinary read with its
 * own loader: each an ImpactEffect of 10 s unless the trigger gives a duration).
 */
export const IMPACT_ANIMATIONS: Record<string, string> = {
  "effects.ShieldBoosting": "shieldboost",
  "effects.ModifyShieldResonance": "shieldhardening",
  "effects.ArmorRepair": "armorrepair",
  "effects.TetheringRepair": "armorrepair",
  "effects.ArmorHardening": "armorhardening",
  "effects.StructureRepair": "hullrepair",
};

/** A layer texture: wrapping (the records' samplers), a volume where asked. */
const layerTextures = new Map<string, Promise<THREE.Texture | null>>();
function layerTexture(url: string | null | undefined, volume: boolean, clamp = false): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const key = `${url}|${clamp}`;
  if (!layerTextures.has(key)) layerTextures.set(key, (volume ? loadDds3D(url) : loadDds(url)).then((t) => {
    const w = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.wrapS = t.wrapT = w;
    if ((t as THREE.Data3DTexture).isData3DTexture) (t as THREE.Data3DTexture).wrapR = w;
    t.needsUpdate = true;
    return t as THREE.Texture;
  }).catch(() => null));
  return layerTextures.get(key)!;
}

/** EveDamageOverlay's most holes a ship shows (the goal count's ceiling). */
const MAX_ARMOR_IMPACTS = 16;

const suns = new WeakMap<THREE.Object3D, THREE.DirectionalLight | null>();
/** The scene's sun: its first directional light. */
function sunOf(scene: THREE.Object3D): THREE.DirectionalLight | null {
  if (!suns.has(scene)) {
    let sun: THREE.DirectionalLight | null = null;
    scene.traverse((o) => { if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight; });
    suns.set(scene, sun);
  }
  return suns.get(scene) ?? null;
}

/**
 * fxarmorimpactv5 (its compiled record 0), drawn over the hull: pA = the hull-space position / the armor size;
 * n = CutOffsetMap(pA x ArmorImpactData.z).y x CutOffsetMap(pA x ArmorImpactData.w).y + 0.25; per hole d = distance /
 * its radius, the scorch A += 1 - sat((d - ArmorImpactData.x) / (n ArmorImpactData.y)), the hole B += 1 - sat(d -
 * (n ArmorImpactHole.y + ArmorImpactHole.x)); the inside InsideMap at uv (2, 1) x ArmorImpactInside.x - albedo .x x
 * ArmorInsideAlbedoColor, roughness 1 - .z, its normal InsideNormalMap - lit by the sun (GGX, Schlick's Fresnel from
 * ArmorInsideFresnelColor, the record's visibility term and horizon fade); the glow ((ArmorImpactInside.w x InsideMap(uv
 * (2, 1) x ArmorImpactInside.z + time x ArmorImpactInside.y).w + 1) x .w)^2 x ArmorInsideGlowColor; out mix((
 * ArmorImpactColor, A x its alpha), (inside, A), B) plus the glow, premultiplied, encoded to sRGB; blended ONE /
 * INVSRCALPHA, depth tested equal, not written.
 */
function armorMaterial(params: Record<string, number[] | null>): THREE.ShaderMaterial {
  const p = (name: string, d: number[]) => new THREE.Vector4(...([0, 1, 2, 3].map((i) => params[name]?.[i] ?? d[i]!) as [number, number, number, number]));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      holes: { value: Array.from({ length: MAX_ARMOR_IMPACTS }, () => new THREE.Vector4()) },
      count: { value: 0 }, parentSize: { value: 1 }, time: { value: 0 },
      worldToEve: { value: new THREE.Matrix4() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColour: { value: new THREE.Color(1, 1, 1) },
      ArmorImpactData: { value: p("ArmorImpactData", [3, 32, 3.1427, 1.2278]) },
      ArmorImpactHole: { value: p("ArmorImpactHole", [1.3, 11.75, 0, 0]) },
      ArmorImpactInside: { value: p("ArmorImpactInside", [10.5, 0, 1, 0]) },
      ArmorInsideFresnelColor: { value: p("ArmorInsideFresnelColor", [0.04, 0.04, 0.04, 1]) },
      ArmorInsideAlbedoColor: { value: p("ArmorInsideAlbedoColor", [0.05, 0.05, 0.05, 1]) },
      ArmorInsideGlowColor: { value: p("ArmorInsideGlowColor", [1, 0.1, 0, 1]) },
      ArmorImpactColor: { value: p("ArmorImpactColor", [0, 0, 0, 1]) },
      FresnelFactors: { value: p("FresnelFactors", [1, 1, 0, 0]) },
      ArmorRepairTransform: { value: p("ArmorRepairTransform", [1, 1, 1, 1]) }, ArmorRepairData: { value: p("ArmorRepairData", [10, 1, 1, 0]) },
      ArmorRepairColor: { value: p("ArmorRepairColor", [1, 1, 1, 1]) },
      HullRepairTransform: { value: p("HullRepairTransform", [1, 1, 1, 1]) }, HullRepairData: { value: p("HullRepairData", [10, 1, 1, 0]) },
      HullRepairColor: { value: p("HullRepairColor", [1, 1, 1, 1]) },
      ArmorHardenerTransform: { value: p("ArmorHardenerTransform", [1, 1, 1, 1]) },
      ArmorHardenerGradientTransform: { value: p("ArmorHardenerGradientTransform", [1, 1, 1, 1]) },
      ArmorHardenerColor: { value: p("ArmorHardenerColor", [1, 1, 1, 1]) },
      // the faders (EveDamageOverlay's header: armor repair, armor hardening, hull repair) and the bounding radius
      faders: { value: new THREE.Vector3() }, boundRadius: { value: 1 },
      CutOffsetMap: { value: null }, InsideMap: { value: null }, InsideNormalMap: { value: null },
      LayerAllMap: { value: null }, GradientMap: { value: null }, HullRepairLayerAllMap: { value: null },
      HullRepairGradientMap: { value: null }, ArmorHardeningGradientMap: { value: null },
    },
    vertexShader: `uniform mat4 worldToEve;
      varying vec3 vOS; varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormalW;
      void main() {
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vWorld = world.xyz;
        vOS = ( worldToEve * world ).xyz;
        vUv = uv;
        vNormalW = normalize( mat3( modelMatrix ) * normal );
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `precision highp sampler3D;
      uniform vec4 holes[${MAX_ARMOR_IMPACTS}]; uniform int count; uniform float parentSize; uniform float time;
      uniform vec3 sunDir; uniform vec3 sunColour;
      uniform vec4 ArmorImpactData; uniform vec4 ArmorImpactHole; uniform vec4 ArmorImpactInside; uniform vec4 ArmorInsideFresnelColor;
      uniform vec4 ArmorInsideAlbedoColor; uniform vec4 ArmorInsideGlowColor; uniform vec4 ArmorImpactColor;
      uniform sampler3D CutOffsetMap; uniform sampler2D InsideMap; uniform sampler2D InsideNormalMap;
      uniform vec4 FresnelFactors; uniform vec4 ArmorRepairTransform; uniform vec4 ArmorRepairData; uniform vec4 ArmorRepairColor;
      uniform vec4 HullRepairTransform; uniform vec4 HullRepairData; uniform vec4 HullRepairColor;
      uniform vec4 ArmorHardenerTransform; uniform vec4 ArmorHardenerGradientTransform; uniform vec4 ArmorHardenerColor;
      uniform vec3 faders; uniform float boundRadius;
      uniform sampler3D LayerAllMap; uniform sampler2D GradientMap; uniform sampler3D HullRepairLayerAllMap;
      uniform sampler2D HullRepairGradientMap; uniform sampler2D ArmorHardeningGradientMap;
      varying vec3 vOS; varying vec2 vUv; varying vec3 vWorld; varying vec3 vNormalW;
      vec3 encode( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) ); }
      void main() {
        vec3 pA = vOS / parentSize;
        float n = texture( CutOffsetMap, pA * ArmorImpactData.z ).y * texture( CutOffsetMap, pA * ArmorImpactData.w ).y + 0.25;
        float edgeW = n * ArmorImpactData.y;
        float holeR = n * ArmorImpactHole.y + ArmorImpactHole.x;
        float outerR = edgeW + ArmorImpactData.x;
        float A = 0.0, B = 0.0, C = 0.0, Dm = 0.0, E = 0.0;
        for ( int i = 0; i < ${MAX_ARMOR_IMPACTS}; i++ ) {
          if ( i >= count ) break;
          float d = length( holes[ i ].xyz - vOS ) / holes[ i ].w;
          A += 1.0 - clamp( ( d - ArmorImpactData.x ) / edgeW, 0.0, 1.0 );
          B += 1.0 - clamp( d - holeR, 0.0, 1.0 );
          C += 1.0 - clamp( d / ArmorRepairData.x, 0.0, 1.0 );
          Dm += 1.0 - clamp( ( d - outerR ) / ( 0.5 * outerR ), 0.0, 1.0 );
          E += 1.0 - clamp( d / HullRepairData.x, 0.0, 1.0 );
        }
        A = clamp( A, 0.0, 1.0 ); B = clamp( B, 0.0, 1.0 ); C = clamp( C, 0.0, 1.0 ); Dm = clamp( Dm, 0.0, 1.0 );
        // (nothing to draw: no scorch and no hardener)
        if ( A <= 0.0 && faders.y <= 0.0 ) discard;
        vec2 uvI = vUv * vec2( 2.0, 1.0 ) * ArmorImpactInside.x;
        vec4 I = texture( InsideMap, uvI );
        vec3 NI = texture( InsideNormalMap, uvI ).xyz * 2.0 - 1.0;
        float anim = texture( InsideMap, vUv * vec2( 2.0, 1.0 ) * ArmorImpactInside.z + time * ArmorImpactInside.y ).w;
        float g = ( ArmorImpactInside.w * anim + 1.0 ) * I.w;
        float glow = g * g;
        // the inside's normal: the map in the surface's frame (from the screen derivatives: the hull's own tangents)
        vec3 Ng = normalize( vNormalW ) * ( gl_FrontFacing ? 1.0 : -1.0 );
        vec3 dp1 = dFdx( vWorld ), dp2 = dFdy( vWorld ); vec2 du1 = dFdx( vUv ), du2 = dFdy( vUv );
        vec3 dp2perp = cross( dp2, Ng ), dp1perp = cross( Ng, dp1 );
        vec3 T = dp2perp * du1.x + dp1perp * du2.x, Bt = dp2perp * du1.y + dp1perp * du2.y;
        float invmax = inversesqrt( max( dot( T, T ), dot( Bt, Bt ) ) + 1e-20 );
        vec3 N = normalize( T * invmax * NI.x + Bt * invmax * NI.y + Ng * NI.z );
        // the sun on it (the record's GGX)
        vec3 V = normalize( cameraPosition - vWorld ), L = normalize( sunDir ), H = normalize( V + L );
        float rough = clamp( 1.0 - I.z, 0.0, 1.0 ), a = rough * rough, a2 = a * a, k = 1.0 - a;
        vec3 albedo = I.x * ArmorInsideAlbedoColor.rgb, F0 = ArmorInsideFresnelColor.rgb;
        vec3 F = F0 + ( 1.0 - F0 ) * pow( 1.0 - clamp( dot( L, H ), 0.0, 1.0 ), 5.0 );
        float nh = clamp( dot( N, H ), 0.0, 1.0 ), dd = nh * nh * ( a2 - 1.0 ) + 1.0;
        float D = a2 / max( 3.14159265 * dd * dd, 1e-8 );
        float nv = abs( dot( N, V ) ) + 1e-5, nl = clamp( dot( N, L ), 0.0, 1.0 );
        float vis = 0.5 / max( nl * ( nv * k + a ) + nv * ( nl * k + a ), 1e-8 );
        float horizon = clamp( ( 1.0 - a ) * 10.0 * dot( Ng, L ) + 1.0, 0.0, 1.0 );
        vec3 inside = max( ( vis * D * F * 3.14159265 + albedo * ( 1.0 - F ) ) * nl * sunColour * horizon, 0.0 );
        vec4 col = mix( vec4( ArmorImpactColor.rgb, A * ArmorImpactColor.w ), vec4( inside, A ), B );
        col.rgb += ArmorInsideGlowColor.rgb * glow;
        // the armor repairing (its fader): LayerAllMap's x and y at the armor-size space, the repair zone's gradient
        float rep = texture( LayerAllMap, pA * ArmorRepairTransform.x + fract( ArmorRepairTransform.z * time ) ).x
          * texture( LayerAllMap, pA * ArmorRepairTransform.y + fract( ArmorRepairTransform.w * time ) ).y
          * texture( GradientMap, vec2( fract( ( C - ArmorRepairData.z * time ) * ArmorRepairData.y ) ) ).x * C * faders.x;
        col.rgb += rep * ArmorRepairColor.rgb;
        // the hull repairing (its fader): the hull repair layers' x and y, its gradient along the unsaturated zone
        float hrep = texture( HullRepairLayerAllMap, pA * HullRepairTransform.x + fract( HullRepairTransform.z * time ) ).x
          * texture( HullRepairLayerAllMap, pA * HullRepairTransform.y + fract( HullRepairTransform.w * time ) ).y
          * texture( HullRepairGradientMap, vec2( ( E - HullRepairData.z * time ) * HullRepairData.y ) ).x * E * faders.z;
        vec3 rgb = ( col.rgb + hrep * HullRepairColor.rgb ) * col.a;
        // the armor hardening (its fader), added outside the holes: LayerAllMap's w twice at the bounding-radius space,
        // the gradient map's colour twice, a fresnel
        vec3 pB = vOS / boundRadius;
        float fr = pow( 1.0 - clamp( dot( V, Ng ) - FresnelFactors.z, 0.0, 1.0 ), FresnelFactors.x );
        fr = FresnelFactors.y < 0.0 ? ( 1.0 - min( fr, 1.0 ) ) * -FresnelFactors.y : fr * FresnelFactors.y;
        rgb += texture( LayerAllMap, pB * ArmorHardenerTransform.x + fract( ArmorHardenerTransform.z * time ) ).w
          * texture( LayerAllMap, pB * ArmorHardenerTransform.y + fract( ArmorHardenerTransform.w * time ) ).w * faders.y
          * ArmorHardenerColor.rgb
          * texture( ArmorHardeningGradientMap, vUv * ArmorHardenerGradientTransform.x + fract( ArmorHardenerGradientTransform.z * time ) ).rgb
          * texture( ArmorHardeningGradientMap, vUv * ArmorHardenerGradientTransform.y + fract( ArmorHardenerGradientTransform.w * time ) ).rgb
          * fr * ( 1.0 - Dm );
        gl_FragColor = vec4( encode( max( rgb, 0.0 ) ), col.a );
      }`,
    transparent: true, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  material.onBeforeRender = (_r, scene) => {
    const sun = sunOf(scene);
    if (!sun) return;
    (material.uniforms.sunDir!.value as THREE.Vector3).copy(sun.position).sub(sun.target.position).normalize();
    (material.uniforms.sunColour!.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
  };
  return logDepth(material);
}

const armorTextures = new Map<string, Promise<THREE.Texture | null>>();
function armorTexture(url: string | null | undefined, volume: boolean): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  if (!armorTextures.has(url)) armorTextures.set(url, (volume ? loadDds3D(url) : loadDds(url)).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if ((t as THREE.Data3DTexture).isData3DTexture) (t as THREE.Data3DTexture).wrapR = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t as THREE.Texture;
  }).catch(() => null));
  return armorTextures.get(url)!;
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
      ShieldLayer1Transform3D: { value: p("ShieldLayer1Transform3D", [1, 1, 1, 1]) },
      ShieldLayer2Transform3D: { value: p("ShieldLayer2Transform3D", [1, 1, 1, 1]) },
      ShieldLayer3Transform3D: { value: p("ShieldLayer3Transform3D", [1, 1, 1, 1]) },
      ShieldHardeningCenter: { value: p("ShieldHardeningCenter", [0, 0, 0, 0]) },
      ShieldHardeningTransform: { value: p("ShieldHardeningTransform", [1, 1, 0, 0]) },
      ShieldBoostingCenter: { value: p("ShieldBoostingCenter", [0, 0, 0, 0]) },
      ShieldBoostingTransform: { value: p("ShieldBoostingTransform", [1, 1, 0, 0]) },
      // the boosting and hardening kick-ins (the header's v[1].w and .z), the bounding radius (the layers' space), the time
      kicks: { value: new THREE.Vector2() }, boundRadius: { value: 1 }, time: { value: 0 },
      RadialIntensityMap: { value: null }, TemporalFadeoutMap: { value: null }, Layer3DMap: { value: null }, LayerRadMap: { value: null },
    },
    vertexShader: `uniform vec3 ellipsoidCenter; uniform vec3 ellipsoidRadii; uniform float boundRadius;
      varying vec3 vOS; varying vec3 vN; varying vec3 vV; varying vec3 vLayer;
      void main() {
        vec3 n = normalize( position );
        vec3 pOS = ellipsoidRadii * n + ellipsoidCenter;
        vOS = pOS;
        vLayer = pOS / boundRadius;
        vec4 world = modelMatrix * vec4( pOS, 1.0 );
        vN = mat3( modelMatrix ) * normalize( pOS / ( ellipsoidRadii * ellipsoidRadii ) );
        vV = cameraPosition - world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `precision highp sampler3D;
      uniform vec4 imp0[${MAX_SHIELD_IMPACTS}]; uniform vec4 imp1[${MAX_SHIELD_IMPACTS}]; uniform int count;
      uniform float colorFade; uniform float parentSize;
      uniform vec4 ShieldImpactData; uniform vec4 ShieldColorIntensity; uniform vec4 FullShieldColor; uniform vec4 EmptyShieldColor; uniform vec4 ShieldFresnel;
      uniform sampler2D RadialIntensityMap; uniform sampler2D TemporalFadeoutMap;
      uniform vec4 ShieldLayer1Transform3D; uniform vec4 ShieldLayer2Transform3D; uniform vec4 ShieldLayer3Transform3D;
      uniform vec4 ShieldHardeningCenter; uniform vec4 ShieldHardeningTransform; uniform vec4 ShieldBoostingCenter; uniform vec4 ShieldBoostingTransform;
      uniform vec2 kicks; uniform float time;
      uniform sampler3D Layer3DMap; uniform sampler2D LayerRadMap;
      varying vec3 vOS; varying vec3 vN; varying vec3 vV; varying vec3 vLayer;
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
        // the boosting and hardening pulses (their kick-ins): three 3D layers, a radial band about each centre
        vec3 ext = vec3( 0.0 );
        if ( kicks.x > 0.0 || kicks.y > 0.0 ) {
          float L1 = texture( Layer3DMap, fract( ShieldLayer1Transform3D.xyz * time ) + vLayer * ShieldLayer1Transform3D.w ).x;
          float L2 = texture( Layer3DMap, fract( ShieldLayer2Transform3D.xyz * time ) + vLayer * ShieldLayer2Transform3D.w ).y;
          float L3 = texture( Layer3DMap, fract( ShieldLayer3Transform3D.xyz * time ) + vLayer * ShieldLayer3Transform3D.w ).w;
          float boostRad = texture( LayerRadMap, length( vLayer - ShieldBoostingCenter.xyz ) * ShieldBoostingTransform.xy + fract( ShieldBoostingTransform.zw * time ) ).x;
          float hardRad = texture( LayerRadMap, length( vLayer - ShieldHardeningCenter.xyz ) * ShieldHardeningTransform.xy + fract( ShieldHardeningTransform.zw * time ) ).y;
          ext = 0.1 * ( color * ShieldColorIntensity.w * kicks.x * ( L1 * L2 * boostRad ) + color * ShieldColorIntensity.z * kicks.y * ( L3 * hardRad ) );
        }
        gl_FragColor = vec4( fres * ( sum * ShieldColorIntensity.x * color + ext ), 1.0 );
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
    const f = sof.flicker;
    this.flicker = f ? { type: "TriPerlinCurve", speed: f.speed, alpha: f.alpha, beta: f.beta, N: f.n, scale: 0, offset: 1 } : null;
    const r = sof.ellipsoid?.radius, c = sof.ellipsoid?.center;
    if (r && (r[0] ?? 0) > 0) { this.radii.set(r[0]!, r[1] ?? 0, r[2] ?? 0); this.center.set(c?.[0] ?? 0, c?.[1] ?? 0, c?.[2] ?? 0); }
    else if (box && !box.isEmpty()) { box.getSize(this.radii).multiplyScalar(0.5 * Math.sqrt(3)); box.getCenter(this.center); }
    if (sof.armor) {
      const material = armorMaterial(sof.armor.params);
      void armorTexture(sof.armor.textures.CutOffsetMap, true).then((t) => { material.uniforms.CutOffsetMap!.value = t; });
      void armorTexture(sof.armor.textures.InsideMap, false).then((t) => { material.uniforms.InsideMap!.value = t; });
      void armorTexture(sof.armor.textures.InsideNormalMap, false).then((t) => { material.uniforms.InsideNormalMap!.value = t; });
      void layerTexture(sof.armor.textures.LayerAllMap, true).then((t) => { material.uniforms.LayerAllMap!.value = t; });
      void layerTexture(sof.armor.textures.GradientMap, false, true).then((t) => { material.uniforms.GradientMap!.value = t; });
      void layerTexture(sof.armor.textures.HullRepairLayerAllMap, true).then((t) => { material.uniforms.HullRepairLayerAllMap!.value = t; });
      void layerTexture(sof.armor.textures.HullRepairGradientMap, false).then((t) => { material.uniforms.HullRepairGradientMap!.value = t; });
      void layerTexture(sof.armor.textures.ArmorHardeningGradientMap, false).then((t) => { material.uniforms.ArmorHardeningGradientMap!.value = t; });
      material.uniforms.boundRadius!.value = Math.max(1e-3, boundingRadius);
      material.uniforms.parentSize!.value = Math.max(1e-3, Math.min(boundingRadius, ARMOR_PARENT_MAX));
      (this as { armorMaterial: THREE.ShaderMaterial | null }).armorMaterial = material;
    }
    if (sof.type === 1 && sof.shield && this.radii.x > 0) {
      const material = shieldMaterial(sof.shield.params, this.center, this.radii);
      void shieldTexture(sof.shield.textures.RadialIntensityMap).then((t) => { material.uniforms.RadialIntensityMap!.value = t; });
      void shieldTexture(sof.shield.textures.TemporalFadeoutMap).then((t) => { material.uniforms.TemporalFadeoutMap!.value = t; });
      void layerTexture(sof.shield.textures.Layer3DMap, true).then((t) => { material.uniforms.Layer3DMap!.value = t; });
      void layerTexture(sof.shield.textures.LayerRadMap, false).then((t) => { material.uniforms.LayerRadMap!.value = t; });
      material.uniforms.boundRadius!.value = Math.max(1e-3, boundingRadius);
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
  /** The flicker's curve (EveSOF.cpp:2768-2780: a TriPerlinCurve of the generic damage's numbers), its scale and offset the damage's. */
  private readonly flicker: { type: "TriPerlinCurve"; speed: number; alpha: number; beta: number; N: number; scale: number; offset: number } | null;
  /** TriLinearize(0.9, 0.1, hull): nought at 90 % hull and above, 1 at 10 % and below. */
  private hullDamageFactor = 0;

  /**
   * EveDamageOverlay::GetActivationStrength (:403-423): with hull damage the flicker curve at the time (seconds),
   * clamped to [0.3, 1], over e^(the hull damage factor); else 1.
   */
  activationStrength(time: number): number {
    if (!(this.hullDamageFactor > 0) || !this.flicker) return 1;
    return Math.min(1, Math.max(0.3, curveValue(this.flicker as unknown as Curve, time))) / Math.exp(this.hullDamageFactor);
  }
  /** The holes' draw, over each of the hull's meshes (attachArmor); null for a race with no armor effect. */
  readonly armorMaterial: THREE.ShaderMaterial | null = null;
  private readonly armorMeshes: THREE.Mesh[] = [];
  /** EveImpactOverlay's shield boosting and hardening faders; EveDamageOverlay's armor hardening, armor and hull repairing. */
  private readonly faders = { shieldboost: new ScalarFader(), shieldhardening: new ScalarFader(), armorhardening: new ScalarFader(), armorrepair: new ScalarFader(), hullrepair: new ScalarFader() };

  /**
   * SetImpactAnimation (EveImpactOverlay::ToggleEffect, EveDamageOverlay::ToggleEffect): the named fader faded in or
   * out over a quarter of the duration (seconds).
   */
  setImpactAnimation(name: string, on: boolean, duration: number): void {
    const f = (this.faders as Record<string, ScalarFader>)[name];
    if (f) f.start(on, duration / 4);
  }
  /** The faders' values and kick-ins (for checks). */
  get animationState(): Record<string, [number, number]> {
    return Object.fromEntries(Object.entries(this.faders).map(([k, f]) => [k, [f.value, f.kickIn]]));
  }

  /**
   * The holes' draw put over the hull: a copy of each of its meshes (each geometry once in each LOD; not its decals nor
   * those drawn in the distortion layer) drawn with the armor effect, hidden while no hole shows (EveDamageOverlay::GetBatches).
   */
  attachArmor(levels: THREE.Object3D[]): void {
    const material = this.armorMaterial;
    if (!material) return;
    for (const level of levels) {
      const seen = new Set<THREE.BufferGeometry>();
      const meshes: THREE.Mesh[] = [];
      level.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && m.layers.mask === 1 && !m.name.startsWith("decal:") && m.geometry.getAttribute("uv") && !seen.has(m.geometry)) { seen.add(m.geometry); meshes.push(m); } });
      for (const m of meshes) {
        const over = new THREE.Mesh(m.geometry, material);
        over.name = "armor-impacts";
        over.visible = false;
        over.frustumCulled = m.frustumCulled;
        over.renderOrder = 1;
        m.add(over);
        this.armorMeshes.push(over);
      }
    }
  }

  /** min(bounding radius, 775.19): the holes' and the debris' size (armorImpactParentSize). */
  get armorParentSize(): number { return Math.min(this.boundingRadius, ARMOR_PARENT_MAX); }
  /** The holes kept (index rank below it), the rest shrinking: int(12 (1 - armor) + 4 (1 - hull)). */
  get goalCount(): number { return Math.trunc(12 * clamp01(1 - this.armor) + 4 * clamp01(1 - this.hull)); }
  get holeCount(): number { return this.holes.size; }

  /** EveDamageOverlay::SetDamageState (:450-495): the fractions left; the configuration from them. */
  setDamageState(shield: number, armor: number, hull: number): void {
    this.shield = clamp01(shield); this.armor = clamp01(armor); this.hull = clamp01(hull);
    // EveDamageOverlay::SetDamageState (:470-477): the hull damage factor; the flicker scaled by the damage (scale
    // TriLinearize(1, 0, hull) = 1 - hull, offset 1 less that)
    this.hullDamageFactor = Math.min(1, Math.max(0, (0.9 - this.hull) / 0.8));
    if (this.flicker) { this.flicker.scale = 1 - this.hull; this.flicker.offset = this.hull; }
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
   * EveSpaceObject2::GetGoodLocatorIndex for the damage set (EveSpaceObject2.cpp:2716-2783; a missile warhead's choice of
   * where to go, EveMissileWarhead::UpdateState): of the locators facing the point (IsLocatorFacingPosition: the point
   * moved by the locator's way is nearer the object's origin), the one whose distance fit times direction fit is nearest
   * a random wanted fit (rand x (0.25 - (1 - best direction fit)) + 0.75); none facing: the nearest facing
   * (GetClosestLocatorIndex), else -1. The point in the world.
   */
  goodLocatorIndex(worldPoint: THREE.Vector3): number {
    const locs = this.sof.damageLocators;
    if (!locs.length) return 0;
    this.anchor.updateWorldMatrix(true, false);
    const pos = this.anchor.worldToLocal(worldPoint.clone());
    const posLen = pos.lengthSq();
    const facing: { i: number; v: THREE.Vector3; dir: THREE.Vector3 }[] = [];
    locs.forEach((l, i) => {
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(l[3]!, l[4]!, l[5]!, l[6]!));
      if (pos.clone().sub(dir).lengthSq() < posLen) facing.push({ i, v: new THREE.Vector3(l[0]!, l[1]!, l[2]!).sub(pos), dir });
    });
    const directionFit = (a: THREE.Vector3, b: THREE.Vector3) => { const d = -a.dot(b); return d < 0 ? (1 - Math.sqrt(Math.abs(d))) * 0.5 : (Math.sqrt(Math.abs(d)) + 1) * 0.5; };
    let minDistance = Number.MAX_VALUE, maxDistance = 1.17549435e-38, bestDirectionFit = 0;
    for (const f of facing) {
      const length = f.v.length();
      minDistance = Math.min(minDistance, length); maxDistance = Math.max(maxDistance, length);
      bestDirectionFit = Math.max(bestDirectionFit, directionFit(f.dir, f.v.clone().normalize()));
    }
    const desiredFit = Math.random() * (0.25 - (1 - bestDirectionFit)) + 0.75;
    let bestFit = 1, best = -1;
    for (const f of facing) {
      // GetDistanceFit
      let val = 2 * (1 - (f.v.length() - minDistance) / (maxDistance - minDistance)) - 1;
      val = (val < 0 ? 1 - Math.sqrt(Math.abs(val)) : Math.sqrt(Math.abs(val)) + 1) * 0.5;
      const fit = val * directionFit(f.dir, f.v.clone().normalize());
      if (Math.abs(fit - desiredFit) < bestFit) { bestFit = Math.abs(fit - desiredFit); best = f.i; }
    }
    if (best < 0) {
      let closest = Number.MAX_VALUE;
      for (const f of facing) if (f.v.lengthSq() < closest) { closest = f.v.lengthSq(); best = f.i; }
    }
    return best;
  }

  /**
   * EveSpaceObject2::GetImpactPosition (:2930-2960): in shield, where the move from prev to now (the world) crosses the
   * shape ellipsoid (within one move either way), or now where it is inside it; else the locator's place where now is
   * within epsilon (a squared distance) of it. Null where there is no impact yet.
   */
  impactPosition(locator: number, prev: THREE.Vector3, now: THREE.Vector3, epsilon: number): THREE.Vector3 | null {
    this.anchor.updateWorldMatrix(true, false);
    if (this.configuration === "shield") {
      const c = this.sof.ellipsoid.center, r = this.sof.ellipsoid.radius;
      if (!c || !r) return null;
      const center = new THREE.Vector3(c[0]!, c[1]!, c[2]!), radii = new THREE.Vector3(r[0]!, r[1]!, r[2]!);
      const p0 = this.anchor.worldToLocal(prev.clone()), p1 = this.anchor.worldToLocal(now.clone());
      const dir = p1.clone().sub(p0);
      if (dir.lengthSq() > 0) {
        const hit = intersectEllipsoidRay(center, radii, p0, dir);
        if (hit) {
          const t = dir.dot(hit.clone().sub(p0)) / dir.lengthSq();
          if (t <= 1 && t >= -1) return hit.applyMatrix4(this.anchor.matrixWorld);
        }
      }
      return p1.sub(center).divide(radii).lengthSq() <= 1 ? now.clone() : null;
    }
    const at = this.locatorPosition(locator) ?? new THREE.Vector3().setFromMatrixPosition(this.anchor.matrixWorld);
    return now.distanceToSquared(at) < epsilon ? at : null;
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

  /**
   * The holes given to their draw (EveDamageOverlay.cpp:311-316): each its locator's place in the hull's space and
   * size x 0.0129 x the armor size; the hull's space from the world now; the draw shown while one is.
   */
  private stepHoles(): void {
    const m = this.armorMaterial;
    if (!m) return;
    const u = m.uniforms;
    const holes = u.holes!.value as THREE.Vector4[];
    let i = 0;
    for (const h of this.holes.values()) {
      if (i >= MAX_ARMOR_IMPACTS) break;
      const l = this.sof.damageLocators[h.locator]!;
      holes[i++]!.set(l[0]!, l[1]!, l[2]!, Math.max(1e-6, h.size * IMPACT_ARMOR_SIZE_FACTOR * this.armorParentSize));
    }
    u.count!.value = i;
    u.time!.value = performance.now() / 1000;
    this.anchor.updateWorldMatrix(true, false);
    (u.worldToEve!.value as THREE.Matrix4).copy(this.anchor.matrixWorld).invert();
    const F = this.faders;
    (u.faders!.value as THREE.Vector3).set(F.armorrepair.value, F.armorhardening.value, F.hullrepair.value);
    // EveDamageOverlay::HasArmorActivity: holes, or the armor hardening or repairing fader not at rest
    const active = i > 0 || !F.armorhardening.isZero || !F.armorrepair.isZero;
    for (const o of this.armorMeshes) o.visible = active;
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
    const F = this.faders;
    (u.kicks!.value as THREE.Vector2).set(F.shieldboost.kickIn, F.shieldhardening.kickIn);
    u.time!.value = performance.now() / 1000;
    // EveImpactOverlay::HasShieldActivity: ripples, or a boosting or hardening kick-in under way
    mesh.visible = i > 0 || !F.shieldboost.isKickInZero || !F.shieldhardening.isKickInZero;
  }

  /**
   * One frame: the ripples aged; the holes past the goal count shrink (EveDamageOverlay.cpp:241-259), then each new or refreshed hole
   * sprays (EveImpactOverlay::SpawnImpactDebris, :116-180) - the armor debris, in hull the smoke too - from its
   * locator's place along its normal (+y turned by its rotation), with the ship's velocity (the world's), scaled by
   * size x min(R, 775.19) / 775.19, the count by clamp(pixel diameter / 400).
   */
  update(dt: number, scene: THREE.Object3D, velocity: THREE.Vector3, pixelDiameter: number): void {
    this.lastSpawned = 0;
    for (const f of Object.values(this.faders)) f.update(dt);
    this.stepRipples(dt);
    this.stepHoles();
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
    // the holes' draw over each LOD's meshes
    const levels = (lod as THREE.LOD | null)?.levels.map((l) => l.object) ?? [];
    overlay.attachArmor(levels);
    overlays.set(a, overlay);
  }
  return overlay;
}
