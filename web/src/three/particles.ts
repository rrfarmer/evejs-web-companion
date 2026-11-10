// The hull children's CPU particle systems (EveChildParticleSystem on Trinity's Particle/ path): each emitter
// (Tr2DynamicEmitter, Tr2StaticEmitter) fills its particle system by its generators, the system ages its particles,
// moves them by their velocity under its forces and drops the dead (Tr2ParticleSystem::UpdateSimulation), and the
// child's instanced mesh draws one quad per live particle, its per-instance data the system's GPU elements
// (Tr2ParticleSystem::RebuildDeclaration: LIFETIME as TANGENT8, POSITION as POSITION8, VELOCITY as NORMAL8, MASS as
// BITANGENT8, a custom element as TEXCOORD(8 + its usage index); index 9 the previous frame's).

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";

import { ELEMENT, ParticleEmitter, ParticleSim, elementKey, type ParticleEmitterData, type ParticleSystemData } from "./particleSim.ts";

const v4 = (a: unknown, d: number[]) => {
  const x = Array.isArray(a) ? (a as number[]) : [];
  return new THREE.Vector4(x[0] ?? d[0], x[1] ?? d[1], x[2] ?? d[2], x[3] ?? d[3]);
};
const f1 = (a: unknown, d: number) => (Array.isArray(a) ? Number((a as number[])[0] ?? d) : typeof a === "number" ? a : d);

/**
 * The quad's instance-drawn material for 1layerdynv2.fx (its record 0, fxres.py; client 3396210), in the view:
 * - size = lerp(size.x, size.y, age) (TEXCOORD8), times the world transform's scale (its rows' sums' length / sqrt 3)
 *   where UseWorldScale, times the distance scaling: sat((w - D.x) / (D.y - D.x)) x (D.w - D.z) + D.z, w the clip w;
 * - the corner (the quad's x, y) times size, turned by age x lifetime x spinVel + spin + SpriteFactors.y (radians);
 * - stretched along the particle's screen velocity: its view-space velocity x VelocityStretch (over the world scale
 *   where UseWorldScale) x sat(age / SpriteFactors2.x) x (the turned corner . the screen direction) added;
 * - colour: Color1 to Color2 over age 0 .. ColorMidpoint, Color2 to Color3 from it to 1;
 * - uv: the quad's x Layer1TexCoordModifier.xy + .zw, in the atlas cell atlas (TEXCOORD11) of SpriteFactors.w x
 *   SpriteFactors.w cells (frac(uv) x 1/n + the cell's corner);
 * - pixel: TexMapLayer1 x colour x SpriteColor, its rgb times 1 + SpriteFactors.x (alpha x tex.a - 1), its alpha x
 *   SpriteFactors.z; all faded in from ParticleParams.x to .y of depth; blended ONE / INVSRCALPHA.
 */
export function oneLayerDynMaterial(params: Record<string, unknown>, texture: THREE.Texture | null): THREE.ShaderMaterial {
  if (texture) { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true; }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      spriteFactors: { value: v4(params.SpriteFactors, [0, 0, 0, 1]) },
      layer1Mod: { value: v4(params.Layer1TexCoordModifier, [1, 1, 0, 0]) },
      velocityStretch: { value: f1(params.VelocityStretch, 0) },
      spriteFactors2: { value: v4(params.SpriteFactors2, [0.05, 1, 1, 1]) },
      color1: { value: v4(params.Color1, [1, 1, 1, 0]) },
      color2: { value: v4(params.Color2, [0.5, 0.5, 0.5, 0]) },
      color3: { value: v4(params.Color3, [0, 0, 0, 0]) },
      colorMidpoint: { value: f1(params.ColorMidpoint, 0.5) },
      useWorldScale: { value: f1(params.UseWorldScale, 0) },
      distanceScaling: { value: v4(params.DistanceScalingParams, [0, 100, 1, 0.5]) },
      spriteColor: { value: v4(params.SpriteColor, [1, 1, 1, 1]) },
      particleParams: { value: new THREE.Vector2(...((Array.isArray(params.ParticleParams) ? (params.ParticleParams as number[]) : [0, 100]).slice(0, 2) as [number, number])) },
      layer1: { value: texture },
    },
    vertexShader: `uniform vec4 spriteFactors; uniform vec4 layer1Mod; uniform float velocityStretch; uniform vec4 spriteFactors2;
      uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint; uniform float useWorldScale; uniform vec4 distanceScaling;
      attribute vec3 iPos; attribute vec2 iLife; attribute vec3 iVel; attribute vec2 iT8; attribute float iT9; attribute float iT10; attribute float iT11;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas; varying float vDepth;
      void main() {
        float age = iLife.x;
        vec4 world = modelMatrix * vec4( iPos, 1.0 );
        vec4 view = viewMatrix * world;
        vec3 viewVel = ( viewMatrix * vec4( mat3( modelMatrix ) * iVel, 0.0 ) ).xyz;
        vec2 sNow = ( projectionMatrix * view ).xy;
        vec2 sMove = ( projectionMatrix * ( view + vec4( viewVel, 0.0 ) ) ).xy - sNow;
        float sLen = length( sMove );
        vec2 sDir = sLen > 0.0 ? sMove / sLen : vec2( 0.0 );
        mat3 m3 = mat3( modelMatrix );
        float worldScale = length( vec3( m3[0][0] + m3[1][0] + m3[2][0], m3[0][1] + m3[1][1] + m3[2][1], m3[0][2] + m3[1][2] + m3[2][2] ) ) * 0.57735;
        float size = mix( iT8.x, iT8.y, age );
        float stretch = velocityStretch;
        if ( useWorldScale > 0.0 ) { size *= worldScale; stretch /= worldScale; }
        float clipW = ( projectionMatrix * view ).w;
        size *= clamp( ( clipW - distanceScaling.x ) / ( distanceScaling.y - distanceScaling.x ), 0.0, 1.0 ) * ( distanceScaling.w - distanceScaling.z ) + distanceScaling.z;
        vec2 corner = position.xy * size;
        float a = age * iT10 * iLife.y + iT9 + spriteFactors.y;
        float s = sin( a ), c = cos( a );
        vec2 turned = vec2( c * corner.x - s * corner.y, s * corner.x + c * corner.y );
        vec4 p = view + vec4( turned, 0.0, 0.0 );
        if ( sLen > 0.0 ) p.xyz += viewVel * stretch * clamp( age / spriteFactors2.x, 0.0, 1.0 ) * dot( turned, sDir );
        gl_Position = projectionMatrix * p;
        vDepth = -view.z;
        vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );
        vUv = uv * layer1Mod.xy + layer1Mod.zw;
        float cell = trunc( iT11 ) / spriteFactors.w;
        vAtlas = vec3( fract( cell ), trunc( cell ) / spriteFactors.w, 1.0 / spriteFactors.w );
      }`,
    fragmentShader: `uniform vec4 spriteFactors; uniform vec4 spriteColor; uniform vec2 particleParams; uniform sampler2D layer1;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas; varying float vDepth;
      void main() {
        vec2 cellUv = fract( vUv ) * vAtlas.z + vAtlas.xy;
        vec2 grad = vUv * vAtlas.z + vAtlas.xy;
        vec4 t = textureGrad( layer1, cellUv, dFdx( grad ), dFdy( grad ) );
        vec4 col = vColor * spriteColor;
        float k = spriteFactors.x * ( col.a * t.a - 1.0 ) + 1.0;
        vec4 o = t * vec4( col.rgb * k, col.a );
        o.a *= spriteFactors.z;
        gl_FragColor = o * clamp( ( vDepth - particleParams.x ) / ( particleParams.y - particleParams.x ), 0.0, 1.0 );
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  return mat;
}

/** An EveChildParticleSystem as the extractor writes it (children.mjs readParticleSystemChild). */
export interface SofChildParticles {
  k: "particles";
  id?: number;
  display?: boolean;
  name: string | null;
  m: number[];
  geometry: string | null;
  meshIndex: number;
  minScreenSize: number;
  areas: { kind: string; effect: string; params: Record<string, unknown>; textures: Record<string, string | null> }[];
  meshSystem: number;
  systems: ParticleSystemData[];
  emitters: ParticleEmitterData[];
  updated: number[];
  modifiers?: string[];
}

/** The instance attributes the particle shaders read, by the element that fills them, and their sizes. */
const ATTRIBUTES: { name: string; size: number; key: (usage: Map<number, string>) => string | undefined }[] = [
  { name: "iPos", size: 3, key: () => elementKey({ elementType: ELEMENT.POSITION }) },
  { name: "iLife", size: 2, key: () => elementKey({ elementType: ELEMENT.LIFETIME }) },
  { name: "iVel", size: 3, key: () => elementKey({ elementType: ELEMENT.VELOCITY }) },
  { name: "iT8", size: 2, key: (u) => u.get(0) },
  { name: "iT9", size: 1, key: (u) => u.get(1) },
  { name: "iT10", size: 1, key: (u) => u.get(2) },
  { name: "iT11", size: 1, key: (u) => u.get(3) },
];

/**
 * A particle child's drawn object: one quad (the mesh's geometry) instanced per live particle of its mesh's system,
 * the emitters and systems stepped each frame it is drawn (a model's copies share it), the system's GPU elements
 * copied into the instance attributes (a custom element by its usage index: TEXCOORD8 + it). Only areas drawn with
 * 1layerdynv2.fx are drawn so far; null for any other.
 */
export function particleObject(node: SofChildParticles, quad: THREE.BufferGeometry, textureOf: (res: string | null | undefined) => Promise<THREE.Texture | null>,
  registerEmitter?: (id: number, get: (attr: string) => number | undefined, set: (attr: string, v: number) => void) => void): THREE.Object3D | null {
  const area = node.areas.find((a) => a.effect === "1layerdynv2");
  if (!area) return null;
  const sims = node.systems.map((s) => new ParticleSim(s));
  const sim = sims[node.meshSystem];
  if (!sim || sim.max === 0) return null;
  const emitters = node.emitters.map((e) => new ParticleEmitter(e, sims[e.particleSystem?.system ?? -1] ?? null)).filter((e) => e.valid);
  if (!emitters.length) return null;
  // an emitter's rate and limit a curve set's binding may drive (a ship's gas jets: its ShipStandard set)
  for (const e of emitters) {
    const id = (e.data as { id?: number }).id;
    if (id === undefined || !registerEmitter) continue;
    registerEmitter(id, (attr) => (attr === "rate" ? Number(e.data.rate ?? 0) : attr === "maxParticles" ? Number(e.data.maxParticles ?? -1) : undefined),
      (attr, v) => { if (attr === "rate") e.data.rate = v; else if (attr === "maxParticles") e.data.maxParticles = v; });
  }
  const updated = node.updated.map((i) => sims[i]).filter((s): s is ParticleSim => !!s);
  const usage = new Map<number, string>();
  for (const e of sim.data.elements ?? []) if ((e.elementType ?? ELEMENT.CUSTOM) === ELEMENT.CUSTOM && e.usedByGPU !== false) usage.set(e.usageIndex ?? 0, elementKey(e));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));
  const filled: { attr: THREE.InstancedBufferAttribute; key: string | undefined; size: number }[] = [];
  for (const a of ATTRIBUTES) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(sim.max * a.size), a.size);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(a.name, attr);
    filled.push({ attr, key: a.key(usage), size: a.size });
  }
  geometry.instanceCount = 0;
  const material = oneLayerDynMaterial(area.params, null);
  void textureOf(area.textures.TexMapLayer1).then((t) => {
    if (!t) return;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
    material.uniforms.layer1!.value = t;
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `child-particles:${node.name ?? ""}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  let stepped = 0;
  // stepped from the material's hook: a model's copies (Object3D.clone) share the material and the geometry but not
  // an object's own onBeforeRender
  material.onBeforeRender = () => {
    const now = performance.now() / 1000;
    if (now === stepped) return;
    stepped = now;
    for (const e of emitters) e.update(now);
    for (const s of updated) s.update(now);
    for (const f of filled) {
      const src = f.key ? sim.arrays.get(f.key) : undefined;
      const size = f.key ? sim.sizes.get(f.key) ?? 0 : 0;
      const dst = f.attr.array as Float32Array;
      if (src) for (let i = 0; i < sim.alive; i++) for (let d = 0; d < f.size; d++) dst[i * f.size + d] = d < size ? src[i * size + d]! : 0;
      f.attr.needsUpdate = true;
    }
    geometry.instanceCount = sim.alive;
  };
  return mesh;
}
