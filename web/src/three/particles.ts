// The hull children's CPU particle systems (EveChildParticleSystem on Trinity's Particle/ path): each emitter
// (Tr2DynamicEmitter, Tr2StaticEmitter) fills its particle system by its generators, the system ages its particles,
// moves them by their velocity under its forces and drops the dead (Tr2ParticleSystem::UpdateSimulation), and the
// child's instanced mesh draws one quad per live particle, its per-instance data the system's GPU elements
// (Tr2ParticleSystem::RebuildDeclaration: LIFETIME as TANGENT8, POSITION as POSITION8, VELOCITY as NORMAL8, MASS as
// BITANGENT8, a custom element as TEXCOORD(8 + its usage index); index 9 the previous frame's).

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";
import { sceneReflection } from "./celestialModel.ts";

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

type Area = SofChildParticles["areas"][number];
type TextureOf = (res: string | null | undefined) => Promise<THREE.Texture | null>;
const particleClock = { get value() { return performance.now() / 1000; } };
const CLAMP_UV = "vec2 clampUv(sampler2D t, vec2 uv) { vec2 h = 0.5 / vec2(textureSize(t, 0)); return clamp(uv, h, 1.0 - h); }";
const SRGB = `vec3 decode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
      vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }`;

/**
 * The dynamic particle vertex stage motionvector.fx and 2layermask.fx share (their PARTICLE_DYNAMIC records, client
 * 3396210): the particle's view position, its quad corner x lerp(size.x, size.y, age) (TEXCOORD8; times the world
 * scale where UseWorldScale) turned by age x lifetime x spinVel + spin + SpriteFactors.y, stretched along its screen
 * velocity by VelocityStretch x sat(age / SpriteFactors2.x) x (the turned corner . the screen direction). Where
 * UseWorldScale the view velocity is divided by the world scale, and in 2layermask the stretch too. No distance
 * scaling (1layerdynv2's). Leaves age, the view position view and the varying vDepth (the view depth) set.
 */
function dynamicParticleVS(stretchByScale: boolean, decl: string, body: string): string {
  return `uniform vec4 spriteFactors; uniform float velocityStretch; uniform vec4 spriteFactors2; uniform float useWorldScale;
      attribute vec3 iPos; attribute vec2 iLife; attribute vec3 iVel; attribute vec2 iT8; attribute float iT9; attribute float iT10; attribute vec4 iT13;
      varying float vDepth;
      ${decl}
      void main() {
        float age = iLife.x;
        mat3 m3 = mat3( modelMatrix );
        float worldScale = length( vec3( m3[0][0] + m3[1][0] + m3[2][0], m3[0][1] + m3[1][1] + m3[2][1], m3[0][2] + m3[1][2] + m3[2][2] ) ) * 0.57735;
        bool byScale = useWorldScale > 0.0;
        vec4 view = viewMatrix * ( modelMatrix * vec4( iPos, 1.0 ) );
        vec3 viewVel = ( viewMatrix * vec4( m3 * iVel, 0.0 ) ).xyz;
        if ( byScale ) viewVel /= worldScale;
        vec2 sNow = ( projectionMatrix * view ).xy;
        vec2 sMove = ( projectionMatrix * ( view + vec4( viewVel, 0.0 ) ) ).xy - sNow;
        float sLen = length( sMove );
        vec2 sDir = sLen > 0.0 ? sMove / sLen : vec2( 0.0 );
        float size = mix( iT8.x, iT8.y, age );
        float stretch = velocityStretch;
        if ( byScale ) { size *= worldScale; ${stretchByScale ? "stretch /= worldScale;" : ""} }
        vec2 corner = position.xy * size;
        float a = age * iT10 * iLife.y + iT9 + spriteFactors.y;
        float s = sin( a ), c = cos( a );
        vec2 turned = vec2( c * corner.x - s * corner.y, s * corner.x + c * corner.y );
        vec4 p = view + vec4( turned, 0.0, 0.0 );
        if ( sLen > 0.0 ) p.xyz += viewVel * stretch * clamp( age / spriteFactors2.x, 0.0, 1.0 ) * dot( turned, sDir );
        gl_Position = projectionMatrix * p;
        vDepth = abs( p.z );
        ${body}
      }`;
}

/**
 * The static particle vertex stage motionvector.fx and 2layermask.fx share (their PARTICLE_STATIC records): no age, no
 * stretch - the particle's view position, its quad corner x TEXCOORD8.x (times the world scale where UseWorldScale)
 * turned by TEXCOORD9.x + SpriteFactors.y. Leaves the varying vDepth (the view depth) set.
 */
function staticParticleVS(decl: string, body: string): string {
  return `uniform vec4 spriteFactors; uniform float useWorldScale;
      attribute vec3 iPos; attribute vec2 iT8; attribute float iT9; attribute vec4 iT10; attribute vec4 iT13;
      varying float vDepth;
      ${decl}
      void main() {
        mat3 m3 = mat3( modelMatrix );
        float worldScale = length( vec3( m3[0][0] + m3[1][0] + m3[2][0], m3[0][1] + m3[1][1] + m3[2][1], m3[0][2] + m3[1][2] + m3[2][2] ) ) * 0.57735;
        float size = iT8.x;
        if ( useWorldScale > 0.0 ) size *= worldScale;
        vec2 corner = position.xy * size;
        float a = iT9 + spriteFactors.y;
        float s = sin( a ), c = cos( a );
        vec2 turned = vec2( c * corner.x - s * corner.y, s * corner.x + c * corner.y );
        vec4 p = viewMatrix * ( modelMatrix * vec4( iPos, 1.0 ) ) + vec4( turned, 0.0, 0.0 );
        gl_Position = projectionMatrix * p;
        vDepth = abs( p.z );
        ${body}
      }`;
}

/**
 * The particle effect motionvector.fx (res:/graphics/effect/managed/space/specialfx/particles/, its sm_hi records,
 * client 3396210) for PARTICLE_DYNAMIC with COLOR_RAMP_ENABLED or COLOR_RAMP_2_RAMPS and any NEAR_FADE (the
 * permutations the client's CPU particle children use but 20 static and 16 COLOR_BY_VALUE areas): a flipbook over the
 * particle's life - TextureMap an atlas of AtlasInfo.x by .y frames, frame frames x frac(age); the frame and the next
 * (past the last: the first where AtlasInfo.w, cycling, is above nought, else the last) blended by the fraction
 * between them, each first pushed along GradientMap's motion vectors (the frame's .xy x the fraction, the next's .zw x
 * 1 - it, x 2 - 1, times Colors.w, where that is above nought); its red r and alpha a (none: discarded); the colour
 * ColorRampMap at (sat((r - Colors.x) / (Colors.y - Colors.x)), age) x Colors.z, with 2 ramps plus
 * SelfIlluminationGradientMap at (sat((r - SelfIllumination.x) / (.y - .x)), age) x SelfIllumination.z; alpha a x the
 * ramp's alpha x Colors2.w; NEAR_FADE_ALPHA fades the alpha, NEAR_FADE_COLOR the colour, by sat((depth -
 * ParticleParams.x) / (.y - .x)); the colour written sRGB-encoded (the per-frame gamma 1). TextureMap and ColorRampMap
 * are read as sRGB (decoded here after filtering); every sampler clamps. The record sets no blend: its batch's
 * preset (transparent alpha, additive ONE / ONE). The fog volume map's factor is 1.
 *
 * particles/dynamic/motionvectorramp.fx (its one record) is the COLOR_RAMP_ENABLED, NEAR_FADE_DISABLED record but for
 * two things: a pixel of nought alpha is not discarded, and the alpha is a x the ramp's alpha (no Colors2).
 *
 * COLOR_BY_VALUE (dynamic): no ramp - the vertex stage's colour Color1 to Color2 over age 0 .. ColorMidpoint, Color2
 * to Color3 from it to 1 (1layerdynv2's), and the frames' alpha alone (blended, nought discarded): the colour x that,
 * its rgb x Colors.z, its alpha x Colors2.w. With NEBULA_BLEEDING (the only nebula permutation the children use is
 * this one) the scene's reflection cube (EveSpaceSceneEnvMap, sRGB) is added to the rgb before Colors.z: read along the
 * eye's ray to the particle at mip 7 (1 - log2(2 / (ParticleParams.w / 8)^4 - 1) / 28) (nought where .w is under
 * 0.004204), times the colour's alpha x ParticleParams.z.
 *
 * PARTICLE_STATIC (COLOR_RAMP_ENABLED; its static records): the static vertex stage, the flipbook's "age" time /
 * AtlasInfo.z + TEXCOORD9.x (cb1[45].x, the frame's time - so it loops where AtlasInfo.w), and the colour (the ramp's,
 * all four) times TEXCOORD10 before Colors.z and Colors2.w.
 */
export function motionVectorParticleMaterial(area: Area, textureOf: TextureOf, dynamicRamp = false): THREE.ShaderMaterial | null {
  const o = (dynamicRamp ? { PARTICLE_TYPE: "PARTICLE_DYNAMIC", COLOR_RAMP: "COLOR_RAMP_ENABLED" } : area.options) as Record<string, string>;
  const type = o.PARTICLE_TYPE ?? "PARTICLE_STATIC";
  if (type !== "PARTICLE_DYNAMIC" && type !== "PARTICLE_STATIC") return null;
  const isStatic = type === "PARTICLE_STATIC";
  const ramp = o.COLOR_RAMP ?? "COLOR_RAMP_DISABLED";
  // (its NEAR_FADE_DISABLED record read; the census has no other)
  const byValue = ramp === "COLOR_BY_VALUE" && !isStatic && !dynamicRamp && (o.NEAR_FADE ?? "NEAR_FADE_DISABLED") === "NEAR_FADE_DISABLED";
  const nebula = byValue && o.NEBULA_BLEEDING === "NEBULA_BLEEDING_ENABLED";
  if (ramp !== "COLOR_RAMP_ENABLED" && !byValue && (ramp !== "COLOR_RAMP_2_RAMPS" || isStatic)) return null;
  if ((o.NEBULA_BLEEDING ?? "NEBULA_BLEEDING_DISABLED") !== "NEBULA_BLEEDING_DISABLED" && !nebula) return null;
  if ((o.LIGHTING_MODE ?? "LIGHTING_DISABLED") !== "LIGHTING_DISABLED") return null;
  const twoRamps = ramp === "COLOR_RAMP_2_RAMPS";
  const fade = o.NEAR_FADE ?? "NEAR_FADE_DISABLED";
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    time: particleClock,
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) }, velocityStretch: { value: f1(p.VelocityStretch, 0) },
    spriteFactors2: { value: v4(p.SpriteFactors2, [0.05, 1, 1, 1]) }, useWorldScale: { value: f1(p.UseWorldScale, 0) },
    atlas: { value: v4(p.AtlasInfo, [6, 6, 10, 1]) }, colors: { value: v4(p.Colors, [0, 1, 1, 0.01]) },
    colors2: { value: v4(p.Colors2, [1, 1, 1, 1]) }, particleParams: { value: v4(p.ParticleParams, [0, 100, 0.5, 0]) },
    selfIllum: { value: v4(p.SelfIllumination, [0, 1, 1, 0]) },
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) }, color3: { value: v4(p.Color3, [0, 0, 0, 0]) },
    colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) },
    envCube: sceneReflection, hasEnv: { get value() { return sceneReflection.value ? 1 : 0; } },
    textureMap: { value: null }, rampMap: { value: null }, gradientMap: { value: null }, siMap: { value: null },
  };
  const load = (res: string | null | undefined, name: string) => void textureOf(res).then((t) => { if (t) uniforms[name]!.value = t; });
  load(area.textures.TextureMap, "textureMap");
  load(area.textures.ColorRampMap, "rampMap");
  load(area.textures.GradientMap, "gradientMap");
  if (twoRamps) load(area.textures.SelfIlluminationGradientMap, "siMap");
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: isStatic
      ? staticParticleVS("uniform float time; uniform vec4 atlas; varying vec3 vUvAge; varying vec4 vColor;", "vUvAge = vec3( uv, time / atlas.z + iT9 ); vColor = iT10;")
      : byValue
        ? dynamicParticleVS(false, "uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint; varying vec3 vUvAge; varying vec4 vColor; varying vec3 vFromEye;",
          `vUvAge = vec3( uv, age );
        vFromEye = ( modelMatrix * vec4( iPos, 1.0 ) ).xyz - cameraPosition;
        vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );`)
        : dynamicParticleVS(false, "varying vec3 vUvAge;", "vUvAge = vec3( uv, age );"),
    fragmentShader: `uniform sampler2D textureMap; uniform sampler2D rampMap; uniform sampler2D gradientMap; uniform sampler2D siMap;
      uniform vec4 atlas; uniform vec4 colors; uniform vec4 colors2; uniform vec4 particleParams; uniform vec4 selfIllum;
      varying vec3 vUvAge; varying float vDepth;${isStatic || byValue ? " varying vec4 vColor;" : ""}${byValue ? " varying vec3 vFromEye; uniform samplerCube envCube; uniform float hasEnv;" : ""}
      ${SRGB}
      ${CLAMP_UV}
      vec2 cell(float f) {
        float row = min(atlas.y - 1.0, floor(f / atlas.x));
        return vec2(min(atlas.x - 1.0, floor(f - row * atlas.x)), row);
      }
      void main() {
        float age = vUvAge.z;
        float frames = atlas.x * atlas.y;
        float t = age * atlas.z;
        float at = frames * fract(t / atlas.z);
        float f0 = floor(at);
        float last = frames - 1.0;
        float f1 = atlas.w > 0.0 ? (f0 + 1.0 >= frames ? 0.0 : f0 + 1.0) : min(f0 + 1.0, last);
        float k = fract(at);
        if (t >= atlas.z && atlas.w <= 0.0) { f0 = last; f1 = last; }
        vec2 c0 = cell(f0), c1 = cell(f1);
        vec2 uv = clamp(vUvAge.xy, 0.0, 1.0);
        vec4 mv = vec4(0.0);
        if (colors.w > 0.0) {
          mv.xy = (texture2D(gradientMap, clampUv(gradientMap, (uv + c0) / atlas.xy)).xy * 2.0 - 1.0) * k;
          mv.zw = (texture2D(gradientMap, clampUv(gradientMap, (uv + c1) / atlas.xy)).zw * 2.0 - 1.0) * (1.0 - k);
          mv *= colors.w;
        }
        vec4 a = texture2D(textureMap, clampUv(textureMap, (clamp(vUvAge.xy - mv.xy, 0.0, 1.0) + c0) / atlas.xy));
        vec4 b = texture2D(textureMap, clampUv(textureMap, (clamp(vUvAge.xy + mv.zw, 0.0, 1.0) + c1) / atlas.xy));
        vec2 v = mix(vec2(decode(a.rgb).r, a.a), vec2(decode(b.rgb).r, b.a), k);
        ${byValue ? `if (v.y <= 0.0) discard;
        vec4 byValue = v.y * vColor;
        ${nebula ? `if (hasEnv > 0.5) {
          float r4 = particleParams.w * 0.125; r4 *= r4; r4 *= r4;
          float lod = particleParams.w >= 0.004204 ? 7.0 * (1.0 - log2(2.0 / r4 - 1.0) * 0.035714) : 0.0;
          // EVE's direction (our z mirrored), as the background's cube is read
          byValue.rgb += decode(textureLod(envCube, vec3(vFromEye.x, vFromEye.y, -vFromEye.z), lod).rgb) * byValue.a * particleParams.z;
        }` : ""}
        gl_FragColor = vec4(encode(max(byValue.rgb * colors.z, 0.0)), byValue.a * colors2.w);
        return;` : ""}
        ${dynamicRamp ? "" : "if (v.y <= 0.0) discard;"}
        vec4 ramp = texture2D(rampMap, clampUv(rampMap, vec2(clamp((v.x - colors.x) / (colors.y - colors.x), 0.0, 1.0), age)));
        ${isStatic ? "ramp = vec4(decode(ramp.rgb), ramp.a) * vColor; vec3 rgb = ramp.rgb * colors.z;" : "vec3 rgb = decode(ramp.rgb) * colors.z;"}
        ${twoRamps ? "rgb += texture2D(siMap, clampUv(siMap, vec2(clamp((v.x - selfIllum.x) / (selfIllum.y - selfIllum.x), 0.0, 1.0), age))).rgb * selfIllum.z;" : ""}
        float alpha = v.y * ramp.a${dynamicRamp ? "" : " * colors2.w"};
        float fade = clamp((vDepth - particleParams.x) / (particleParams.y - particleParams.x), 0.0, 1.0);
        ${fade === "NEAR_FADE_ALPHA" ? "alpha *= fade;" : fade === "NEAR_FADE_COLOR" ? "rgb *= fade;" : ""}
        gl_FragColor = vec4(encode(max(rgb, 0.0)), alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    ...(area.kind === "additive"
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  logDepth(mat);
  return mat;
}

/**
 * The particle effect 2layermask.fx (specialfx/particles/, its sm_hi records, client 3396210) for PARTICLE_DYNAMIC
 * (its static records wait on the static emitter): TexMapLayer1 at uv x Layer1TexCoordModifier.xy + time x
 * Layer1TexCoordSpeed.xy + .zw (with TEXTURE_OFFSETS plus the particle's TEXCOORD13.xy), times TexMapLayer2 the same
 * with Layer2 and TEXCOORD13.zw, times MaskMap at the plain uv (its alpha nought: discarded); with NEAR_FADE all of it
 * x sat((depth - ParticleParams.x) / (.y - .x)); the colour Color1 to Color2 over age 0 .. ColorMidpoint, Color2 to
 * Color3 from it to 1, times SpriteColor; the pixel the texture's rgb x the colour's x (1 + SpriteFactors.x (colour
 * alpha x texture alpha - 1)), alpha the texture's x the colour's x SpriteFactors.z, all x Brightness; blended ONE /
 * INVSRCALPHA (its record's states). Its sampler wraps; nothing is read as sRGB. The fog volume map's factor is 1.
 *
 * PARTICLE_STATIC (its static records, LIGHTING_DISABLED): the static vertex stage, the colour that of age nought
 * (Color1, or Color2 to Color3 at -ColorMidpoint / (1 - ColorMidpoint) where the midpoint is below nought).
 *
 * dynamic/2layerdynmaskv2.fx (its one record, BINDLESS_RENDERING aside) is the same but for three things: the mask's
 * alpha discards nothing, there is no Brightness, and it has no options (no offsets, no near fade).
 */
export function twoLayerMaskParticleMaterial(area: Area, textureOf: TextureOf, dynMaskV2 = false): THREE.ShaderMaterial | null {
  const o = area.options as Record<string, string>;
  const type = dynMaskV2 ? "PARTICLE_DYNAMIC" : o.PARTICLE_TYPE ?? "PARTICLE_STATIC";
  if (!dynMaskV2 && ((type !== "PARTICLE_DYNAMIC" && type !== "PARTICLE_STATIC") || (o.NEBULA_BLEEDING ?? "NEBULA_BLEEDING_DISABLED") !== "NEBULA_BLEEDING_DISABLED")) return null;
  if (!dynMaskV2 && (o.LIGHTING_MODE ?? "LIGHTING_DISABLED") !== "LIGHTING_DISABLED") return null;
  const isStatic = type === "PARTICLE_STATIC";
  const offsets = !dynMaskV2 && o.TEXTURE_OFFSETS === "TEXTURE_OFFSETS_ENABLED";
  const nearFade = !dynMaskV2 && o.NEAR_FADE === "NEAR_FADE_ENABLED";
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    time: particleClock,
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) }, velocityStretch: { value: f1(p.VelocityStretch, 0) },
    spriteFactors2: { value: v4(p.SpriteFactors2, [0.05, 1, 1, 1]) }, useWorldScale: { value: f1(p.UseWorldScale, 0) },
    layer1Mod: { value: v4(p.Layer1TexCoordModifier, [1, 1, 0, 0]) }, layer2Mod: { value: v4(p.Layer2TexCoordModifier, [1, 1, 0, 0]) },
    layer1Speed: { value: v4(p.Layer1TexCoordSpeed, [0, 0, 0, 0]) }, layer2Speed: { value: v4(p.Layer2TexCoordSpeed, [0, 0, 0, 0]) },
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) }, color3: { value: v4(p.Color3, [0, 0, 0, 0]) },
    colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) },
    spriteColor: { value: v4(p.SpriteColor, [1, 1, 1, 1]) }, particleParams: { value: v4(p.ParticleParams, [0, 100, 0.5, 0]) },
    brightness: { value: dynMaskV2 ? 1 : f1(p.Brightness, 1) },
    layer1: { value: null }, layer2: { value: null }, mask: { value: null },
  };
  // the sampler wraps (EveSpaceSceneEnvMapSampler): on the texture objects (the clamping effects clamp in the shader)
  const load = (res: string | null | undefined, name: string) => void textureOf(res).then((t) => {
    if (!t) return;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
    uniforms[name]!.value = t;
  });
  load(area.textures.TexMapLayer1, "layer1");
  load(area.textures.TexMapLayer2, "layer2");
  load(area.textures.MaskMap, "mask");
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: (isStatic ? staticParticleVS : (d: string, b: string) => dynamicParticleVS(true, d, b))(`uniform float time; uniform vec4 layer1Mod; uniform vec4 layer2Mod; uniform vec4 layer1Speed; uniform vec4 layer2Speed;
      uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint;
      varying vec4 vUv12; varying vec2 vMaskUv; varying vec4 vColor;`, `
        vUv12 = vec4( layer1Mod.xy * uv + time * layer1Speed.xy + layer1Mod.zw, layer2Mod.xy * uv + time * layer2Speed.xy + layer2Mod.zw );
        ${offsets ? "vUv12 += iT13;" : ""}
        vMaskUv = uv;
        ${isStatic ? `vColor = colorMidpoint < 0.0 ? mix( color2, color3, clamp( -colorMidpoint / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) ) : color1;`
    : `vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );`}`),
    fragmentShader: `uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D mask;
      uniform vec4 spriteColor; uniform vec4 spriteFactors; uniform vec4 particleParams; uniform float brightness;
      varying vec4 vUv12; varying vec2 vMaskUv; varying vec4 vColor; varying float vDepth;
      void main() {
        vec4 m = texture2D(mask, vMaskUv);
        ${dynMaskV2 ? "" : "if (m.a <= 0.0) discard;"}
        vec4 t = texture2D(layer1, vUv12.xy) * texture2D(layer2, vUv12.zw) * m;
        ${nearFade ? "t *= clamp((vDepth - particleParams.x) / (particleParams.y - particleParams.x), 0.0, 1.0);" : ""}
        vec4 col = vColor * spriteColor;
        float k = spriteFactors.x * (col.a * t.a - 1.0) + 1.0;
        gl_FragColor = vec4(t.rgb * col.rgb * k, t.a * col.a * spriteFactors.z) * brightness;
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  return mat;
}

/** An area's particle material, by its effect file; null for an effect or permutation not drawn here. */
function particleMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial | null {
  const path = (area as { path?: string }).path ?? "";
  if (area.effect === "1layerdynv2") {
    const material = oneLayerDynMaterial(area.params, null);
    void textureOf(area.textures.TexMapLayer1).then((t) => {
      if (!t) return;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
      material.uniforms.layer1!.value = t;
    });
    return material;
  }
  if (path.endsWith("/specialfx/particles/motionvector.fx")) return motionVectorParticleMaterial(area, textureOf);
  if (path.endsWith("/specialfx/particles/dynamic/motionvectorramp.fx")) return motionVectorParticleMaterial(area, textureOf, true);
  if (path.endsWith("/specialfx/particles/2layermask.fx")) return twoLayerMaskParticleMaterial(area, textureOf);
  if (path.endsWith("/specialfx/particles/dynamic/2layerdynmaskv2.fx")) return twoLayerMaskParticleMaterial(area, textureOf, true);
  return null;
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
  areas: { kind: string; effect: string; path?: string; paramIds?: Record<string, number>; options?: Record<string, string>; params: Record<string, unknown>; textures: Record<string, string | null> }[];
  meshSystem: number;
  systems: ParticleSystemData[];
  emitters: ParticleEmitterData[];
  updated: number[];
  modifiers?: string[];
}

/** The particle materials' uniforms by the effect parameter they hold (a binding into the parameter drives them). */
const PARAM_UNIFORM: Record<string, string> = {
  SpriteFactors: "spriteFactors", SpriteFactors2: "spriteFactors2", VelocityStretch: "velocityStretch", UseWorldScale: "useWorldScale",
  Layer1TexCoordModifier: "layer1Mod", Layer2TexCoordModifier: "layer2Mod", Layer1TexCoordSpeed: "layer1Speed", Layer2TexCoordSpeed: "layer2Speed",
  Color1: "color1", Color2: "color2", Color3: "color3", ColorMidpoint: "colorMidpoint", SpriteColor: "spriteColor",
  DistanceScalingParams: "distanceScaling", ParticleParams: "particleParams", Brightness: "brightness",
  AtlasInfo: "atlas", Colors: "colors", Colors2: "colors2", SelfIllumination: "selfIllum",
};

/** The instance attributes the particle shaders read, by the element that fills them, and their sizes. */
const ATTRIBUTES: { name: string; size: number; key: (usage: Map<number, string>) => string | undefined }[] = [
  { name: "iPos", size: 3, key: () => elementKey({ elementType: ELEMENT.POSITION }) },
  { name: "iLife", size: 2, key: () => elementKey({ elementType: ELEMENT.LIFETIME }) },
  { name: "iVel", size: 3, key: () => elementKey({ elementType: ELEMENT.VELOCITY }) },
  { name: "iT8", size: 2, key: (u) => u.get(0) },
  { name: "iT9", size: 1, key: (u) => u.get(1) },
  // a vector where the static records read TEXCOORD10 whole (motionvector's colour); the dynamic ones its x
  { name: "iT10", size: 4, key: (u) => u.get(2) },
  { name: "iT11", size: 1, key: (u) => u.get(3) },
  { name: "iT13", size: 4, key: (u) => u.get(5) },
];

/**
 * A particle child's drawn object: one quad (the mesh's geometry) instanced per live particle of its mesh's system,
 * the emitters and systems stepped each frame it is drawn (a model's copies share it), the system's GPU elements
 * copied into the instance attributes (a custom element by its usage index: TEXCOORD8 + it). Drawn by its first area
 * whose effect is ported (particleMaterial: 1layerdynv2, motionvector, motionvectorramp, 2layermask, 2layerdynmaskv2);
 * null where none is.
 */
export function particleObject(node: SofChildParticles, quad: THREE.BufferGeometry, textureOf: (res: string | null | undefined) => Promise<THREE.Texture | null>,
  registerEmitter?: (id: number, get: (attr: string) => number | number[] | undefined, set: (attr: string, v: number | number[]) => void) => void,
  registerUniform?: (id: number, uniform: THREE.IUniform | undefined) => void): THREE.Object3D | null {
  let material: THREE.ShaderMaterial | null = null;
  let drawn: Area | null = null;
  for (const a of node.areas) if (!material) { material = particleMaterial(a, textureOf); drawn = a; }
  if (!material || !drawn) return null;
  for (const [name, id] of Object.entries(drawn.paramIds ?? {})) if (PARAM_UNIFORM[name] && material.uniforms[PARAM_UNIFORM[name]!]) registerUniform?.(id, material.uniforms[PARAM_UNIFORM[name]!]);
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
      (attr, v) => { const n = Array.isArray(v) ? v[0] ?? 0 : v; if (attr === "rate") e.data.rate = n; else if (attr === "maxParticles") e.data.maxParticles = n; });
    // its generators' ranges and speeds (read at each spawn): a vector range nought where the file has none
    for (const g of (e.data.generators ?? []) as Record<string, unknown>[]) {
      if (!g || typeof g.id !== "number") continue;
      registerEmitter(g.id, (attr) => {
        const v = g[attr];
        if (typeof v === "number" || Array.isArray(v)) return v as number | number[];
        if (attr === "minRange" || attr === "maxRange") return [0, 0, 0, 0];
        return /^(min|max)(Speed|Radius|Phi|Theta)$/.test(attr) ? 0 : undefined;
      }, (attr, v) => { g[attr] = v; });
    }
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
