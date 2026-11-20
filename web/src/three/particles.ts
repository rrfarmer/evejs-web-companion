// The hull children's CPU particle systems (EveChildParticleSystem on Trinity's Particle/ path): each emitter
// (Tr2DynamicEmitter, Tr2StaticEmitter) fills its particle system by its generators, the system ages its particles,
// moves them by their velocity under its forces and drops the dead (Tr2ParticleSystem::UpdateSimulation), and the
// child's instanced mesh draws one quad per live particle, its per-instance data the system's GPU elements
// (Tr2ParticleSystem::RebuildDeclaration: LIFETIME as TANGENT8, POSITION as POSITION8, VELOCITY as NORMAL8, MASS as
// BITANGENT8, a custom element as TEXCOORD(8 + its usage index); index 9 the previous frame's).

import * as THREE from "three";
import { CLOUD_FOG, CLOUD_FOG_GLSL, CLOUD_FOG_SCATTERING, CLOUD_FOG_SCATTERING_GLSL } from "./cloudOpacity.ts";
import { gfx } from "../play/gfxSettings.ts";
import { logDepth } from "./logDepth.ts";
import { DISTORTION_LAYER } from "./distortion.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL, setOpaqueSurfacePass } from "./softDepth.ts";
import { sceneReflection } from "./celestialModel.ts";
import { loadDds3D } from "./ddsTexture.ts";
import { GpuEmitter, gpuSystemOf, type GpuEmitterData } from "./gpuParticles.ts";
import { dynamicLightUniforms, prepareLights, TILED_LIGHT_GLSL, tiledLightLoop } from "./dynamicLights.ts";

import { ELEMENT, ParticleEmitter, ParticleSim, elementKey, type ParticleEmitterData, type ParticleSystemData } from "./particleSim.ts";

const v4 = (a: unknown, d: number[]) => {
  const x = Array.isArray(a) ? (a as number[]) : [];
  return new THREE.Vector4(x[0] ?? d[0], x[1] ?? d[1], x[2] ?? d[2], x[3] ?? d[3]);
};
const f1 = (a: unknown, d: number) => (Array.isArray(a) ? Number((a as number[])[0] ?? d) : typeof a === "number" ? a : d);

// Depth versions of the CPU particle stages fade over a multiple of the scaled sprite size.
const PARTICLE_DEPTH_VERTEX = `
  varying vec3 vSoft;
  vec3 particleDepth(vec4 viewPosition, float size, float depthScale) {
    float nearPlane = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
    float thickness = max(abs(size), 0.000001);
    return vec3(-viewPosition.z, max(depthScale * thickness - 0.000001, 0.000001),
      1.0 - clamp((nearPlane + viewPosition.z) / thickness, 0.0, 1.0));
  }`;

const PARTICLE_DEPTH_FRAGMENT = `
  uniform float depthShader;
  varying vec3 vSoft;
  ${SOFT_DEPTH_GLSL}
  float particleDepthFade() {
    if (depthShader > 0.5 && softDepthOn > 0.5) {
      return clamp((softSceneDepth() - vSoft.x) / vSoft.y, 0.0, 1.0) * vSoft.z;
    }
    return 1.0;
  }`;

/**
 * The quad's instance-drawn material for 1layerdynv2.fx (record 0, build 3698585), in the view:
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
 * - sm_depth also fades the output over 0.333 times the scaled sprite size against opaque depth. sm_hi and sm_lo
 *   keep the distance fade alone.
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
      depthShader: { get value() { return gfx().shaderQuality === 3; } },
      ...SOFT_DEPTH,
    },
    vertexShader: `uniform vec4 spriteFactors; uniform vec4 layer1Mod; uniform float velocityStretch; uniform vec4 spriteFactors2;
      uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint; uniform float useWorldScale; uniform vec4 distanceScaling;
      attribute vec3 iPos; attribute vec2 iLife; attribute vec3 iVel; attribute vec2 iT8; attribute float iT9; attribute float iT10; attribute float iT11;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas;
      ${PARTICLE_DEPTH_VERTEX}
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
        vSoft = particleDepth(p, size, 0.333);
        vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );
        vUv = uv * layer1Mod.xy + layer1Mod.zw;
        float cell = trunc( iT11 ) / spriteFactors.w;
        vAtlas = vec3( fract( cell ), trunc( cell ) / spriteFactors.w, 1.0 / spriteFactors.w );
      }`,
    fragmentShader: `uniform vec4 spriteFactors; uniform vec4 spriteColor; uniform vec2 particleParams; uniform sampler2D layer1;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas;
      ${PARTICLE_DEPTH_FRAGMENT}
      void main() {
        vec2 cellUv = fract( vUv ) * vAtlas.z + vAtlas.xy;
        vec2 grad = vUv * vAtlas.z + vAtlas.xy;
        vec4 t = textureGrad( layer1, cellUv, dFdx( grad ), dFdy( grad ) );
        vec4 col = vColor * spriteColor;
        float alpha = col.a * t.a;
        float k = mix(1.0, alpha, spriteFactors.x);
        float distanceFade = clamp((1.0 / gl_FragCoord.w - particleParams.x) / (particleParams.y - particleParams.x), 0.0, 1.0);
        gl_FragColor = vec4(t.rgb * col.rgb * k, alpha * spriteFactors.z) * (particleDepthFade() * distanceFade);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  mat.userData.softDepth = true;
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
function dynamicParticleVS(stretchByScale: boolean, decl: string, body: string, scaleByDistance = false): string {
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
        ${scaleByDistance ? `float clipW = (projectionMatrix * view).w;
        size *= mix(distanceScaling.z, distanceScaling.w,
          clamp((clipW - distanceScaling.x) / (distanceScaling.y - distanceScaling.x), 0.0, 1.0));` : ""}
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

/** The fixed billboards in wreck clouds, with premultiplied blending and the installed fog encodings. */
function staticNoAtlasParticleMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const params = area.params;
  const material = new THREE.ShaderMaterial({
    name: "1layernoatlasv2",
    visible: false,
    uniforms: {
      ...SOFT_DEPTH, ...CLOUD_FOG_SCATTERING, cloudFogDepths: CLOUD_FOG.cloudFogDepths,
      spriteFactors: { value: v4(params.SpriteFactors, [0, 0, 0, 1]) },
      spriteColor: { value: v4(params.SpriteColor, [1, 1, 1, 1]) },
      layer1Mod: { value: v4(params.Layer1TexCoordModifier, [1, 1, 0, 0]) },
      useWorldScale: { value: f1(params.UseWorldScale, 0) },
      layer1: { value: null },
      depthShader: { get value() { return gfx().shaderQuality === 3; } },
      lowFogEncoding: { get value() { return gfx().shaderQuality === 1; } },
    },
    vertexShader: staticParticleVS(`uniform vec4 layer1Mod;
      varying vec2 vUv; varying vec4 vColor;
      ${PARTICLE_DEPTH_VERTEX}`, `
        vUv = uv * layer1Mod.xy + layer1Mod.zw;
        vColor = iT10;
        vSoft = particleDepth(p, size, 0.333);`),
    fragmentShader: `uniform vec4 spriteColor; uniform vec4 spriteFactors; uniform sampler2D layer1;
      uniform bool lowFogEncoding;
      varying vec2 vUv; varying vec4 vColor;
      ${PARTICLE_DEPTH_FRAGMENT}
      ${CLOUD_FOG_SCATTERING_GLSL}
      ${SRGB}
      void main() {
        vec4 texel = texture2D(layer1, vUv);
        vec4 tint = vColor * spriteColor;
        float opacity = texel.a * tint.a;
        float fade = particleDepthFade();
        float alpha = opacity * spriteFactors.z * fade;
        vec3 rgb = texel.rgb * tint.rgb * mix(1.0, opacity, spriteFactors.x) * fade;
        vec4 fog = cloudFogScattering(1.0 / gl_FragCoord.w, softDepthSize);
        vec3 fogRgb = lowFogEncoding ? sqrt(max(fog.rgb, 0.0)) : encode(max(fog.rgb, 0.0));
        gl_FragColor = vec4(mix(rgb, fogRgb * fog.a * alpha, fog.a), alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  Object.defineProperty(material.userData, "softDepth", { enumerable: true, get: () => gfx().shaderQuality === 3 });
  material.userData.cloudFogScattering = material.userData.cloudFogScatteringLow = true;
  void textureOf(area.textures.TexMapLayer1).then((texture) => {
    if (!texture) return;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
    material.uniforms.layer1!.value = texture;
    material.visible = true;
  });
  return logDepth(material);
}

/** Opaque wreck debris. The diffuse alpha is cut out identically in the color and depth passes. */
function staticDecalParticleMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms = {
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) },
    spriteColor: { value: v4(p.SpriteColor, [1, 1, 1, 1]) },
    layer1Mod: { value: v4(p.Layer1TexCoordModifier, [1, 1, 0, 0]) },
    useWorldScale: { value: f1(p.UseWorldScale, 0) },
    layer1: { value: null as THREE.Texture | null },
    glow: { value: null as THREE.Texture | null },
    hasGlow: { value: false },
  };
  const vertexShader = staticParticleVS(`uniform vec4 layer1Mod;
    attribute float iT11; attribute vec4 iT12;
    varying vec4 vTint; varying vec3 vGlow; varying vec2 vUv; varying vec3 vAtlas;`, `
      vTint = iT10;
      vGlow = iT12.rgb;
      vUv = (1.0 - uv) * layer1Mod.xy + layer1Mod.zw;
      float cell = trunc(iT11) / spriteFactors.w;
      float row = trunc(cell);
      vAtlas = vec3(cell - row, row / spriteFactors.w, 1.0 / spriteFactors.w);`);
  const fragment = `uniform sampler2D layer1; uniform sampler2D glow;
    uniform bool hasGlow; uniform vec4 spriteColor;
    varying vec4 vTint; varying vec3 vGlow; varying vec2 vUv; varying vec3 vAtlas;
    void main() {
      vec2 cellUv = fract(vUv) * vAtlas.z + vAtlas.xy;
      vec2 sampleUv = vUv * vAtlas.z + vAtlas.xy;
      vec2 dx = dFdx(sampleUv), dy = dFdy(sampleUv);
      vec4 tint = textureGrad(layer1, cellUv, dx, dy) * (vTint * spriteColor);
      if (tint.a < 0.5) discard;`;
  const material = logDepth(new THREE.ShaderMaterial({
    name: "1layerdecalv2", uniforms, vertexShader, visible: false, side: THREE.DoubleSide,
    fragmentShader: `${fragment}
      float glowAmount = hasGlow ? textureGrad(glow, cellUv, dx, dy).r : 0.0;
      gl_FragColor = vec4(tint.rgb + glowAmount * vGlow, tint.a);
    }`,
  }));
  setOpaqueSurfacePass(material, logDepth(new THREE.ShaderMaterial({
    name: "1layerdecalv2-depth", uniforms, vertexShader, side: material.side,
    fragmentShader: `${fragment}
      gl_FragColor = vec4(0.5, 0.5, 1.0, 1.0);
    }`,
  })));
  const load = async (res: string | null | undefined) => {
    const texture = await textureOf(res);
    if (texture) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
    }
    return texture;
  };
  void load(area.textures.TexMapLayer1).then((texture) => {
    uniforms.layer1.value = texture;
    material.visible = !!texture;
  });
  void load(area.textures.GlowMapLayer1).then((texture) => {
    uniforms.glow.value = texture;
    uniforms.hasGlow.value = !!texture;
  });
  return material;
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
 * preset (transparent alpha, additive ONE / ONE). Build 3698585 attenuates linear RGBA by squared cloud
 * transmission. The depth profile also fades alpha against opaque depth over the authored Depth distance.
 *
 * The standalone motionvectorramp.fx uses alpha from the texture and ramp. Its depth profile fades alpha over
 * 100 metres.
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
    ...SOFT_DEPTH,
    ...(!dynamicRamp ? CLOUD_FOG : {}),
    depthShader: { get value() { return gfx().shaderQuality === 3; } },
    depthFadeDistance: { value: dynamicRamp ? 100 : f1(p.Depth, 100) },
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
      uniform bool depthShader; uniform float depthFadeDistance;
      varying vec3 vUvAge; varying float vDepth;${isStatic || byValue ? " varying vec4 vColor;" : ""}${byValue ? " varying vec3 vFromEye; uniform samplerCube envCube; uniform float hasEnv;" : ""}
      ${SOFT_DEPTH_GLSL}
      ${dynamicRamp ? "" : CLOUD_FOG_GLSL}
      ${SRGB}
      ${CLAMP_UV}
      vec4 finishParticle(vec3 rgb, float alpha) {
        if (depthShader && softDepthOn > 0.5 && depthFadeDistance > 0.0) {
          alpha *= clamp((softSceneDepth() - vDepth) / depthFadeDistance, 0.0, 1.0);
        }
        ${dynamicRamp ? "" : `float transmission = cloudFogTransmission(1.0 / gl_FragCoord.w);
        float fog = transmission * transmission;
        rgb *= fog;
        alpha *= fog;`}
        return vec4(encode(max(rgb, 0.0)), alpha);
      }
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
        gl_FragColor = finishParticle(byValue.rgb * colors.z, byValue.a * colors2.w);
        return;` : ""}
        ${dynamicRamp ? "" : "if (v.y <= 0.0) discard;"}
        vec4 ramp = texture2D(rampMap, clampUv(rampMap, vec2(clamp((v.x - colors.x) / (colors.y - colors.x), 0.0, 1.0), age)));
        ${isStatic ? "ramp = vec4(decode(ramp.rgb), ramp.a) * vColor; vec3 rgb = ramp.rgb * colors.z;" : "vec3 rgb = decode(ramp.rgb) * colors.z;"}
        ${twoRamps ? "rgb += texture2D(siMap, clampUv(siMap, vec2(clamp((v.x - selfIllum.x) / (selfIllum.y - selfIllum.x), 0.0, 1.0), age))).rgb * selfIllum.z;" : ""}
        float alpha = v.y * ramp.a${dynamicRamp ? "" : " * colors2.w"};
        float fade = clamp((vDepth - particleParams.x) / (particleParams.y - particleParams.x), 0.0, 1.0);
        ${fade === "NEAR_FADE_ALPHA" ? "alpha *= fade;" : fade === "NEAR_FADE_COLOR" ? "rgb *= fade;" : ""}
        gl_FragColor = finishParticle(rgb, alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    ...(area.kind === "additive"
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  mat.userData.softDepth = true;
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
 * INVSRCALPHA (its record's states). Its sampler wraps and reads linear textures.
 * The 3698585 depth-profile records also fade the output near the camera and opaque geometry. Cloud
 * transmission attenuates both RGB and alpha.
 *
 * PARTICLE_STATIC (its static records, LIGHTING_DISABLED): the static vertex stage, the colour that of age nought
 * (Color1, or Color2 to Color3 at -ColorMidpoint / (1 - ColorMidpoint) where the midpoint is below nought).
 * LIGHTING_ALL_LIGHT uses six-point lighting: the sun's
 * direction (toward it, EveSpaceScene's PerFramePS Sun.DirWorld) on the sprite's turned right axis, the cross product
 * of the view's z row and it (in EVE's left-handed space: the turned down, the texture's v) and the view's z row - here
 * taken as toward the eye (as lookAngleToObject's lookAt in hullChildren's fx attributes; front-lit sprites lit), each lobe's positive part squared weighting SixPointPosLightMap's rgb and its negative part squared
 * SixPointNegLightMap's (both at the mask's uv), their sum times the sun's colour plus AmbientLight, multiplying the
 * mask before the layers. The dynamic 3698585 variant also accumulates tile lights flagged for particles, using the
 * light direction at the billboard fragment and the same signed, squared lobes.
 *
 * dynamic/2layerdynmaskv2.fx keeps zero-alpha mask samples, uses unit brightness and has no offsets or near
 * distance fade. Its depth-profile width is fixed at one third of the particle size. Fog attenuates alpha.
 */
export function twoLayerMaskParticleMaterial(area: Area, textureOf: TextureOf, dynMaskV2 = false): THREE.ShaderMaterial | null {
  const o = area.options as Record<string, string>;
  const type = dynMaskV2 ? "PARTICLE_DYNAMIC" : o.PARTICLE_TYPE ?? "PARTICLE_STATIC";
  if (!dynMaskV2 && ((type !== "PARTICLE_DYNAMIC" && type !== "PARTICLE_STATIC") || (o.NEBULA_BLEEDING ?? "NEBULA_BLEEDING_DISABLED") !== "NEBULA_BLEEDING_DISABLED")) return null;
  const isStatic = type === "PARTICLE_STATIC";
  const lit = !dynMaskV2 && o.LIGHTING_MODE === "LIGHTING_ALL_LIGHT";
  const litByTiles = lit && !isStatic;
  if (!dynMaskV2 && !lit && (o.LIGHTING_MODE ?? "LIGHTING_DISABLED") !== "LIGHTING_DISABLED") return null;
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
    ambientLight: { value: v4(p.AmbientLight, [0, 0, 0, 1]) }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColour: { value: new THREE.Color(1, 1, 1) },
    posLight: { value: null }, negLight: { value: null },
    layer1: { value: null }, layer2: { value: null }, mask: { value: null },
    ...SOFT_DEPTH, ...CLOUD_FOG,
    depthShader: { get value() { return gfx().shaderQuality === 3; } },
    depthFadeScale: { value: dynMaskV2 ? 0.333 : v4(p.DepthFadeControl, [0.333, 0, 0, 0]).x },
  };
  if (litByTiles) Object.assign(uniforms, dynamicLightUniforms);
  // the sampler wraps (EveSpaceSceneEnvMapSampler): on the texture objects (the clamping effects clamp in the shader)
  const load = (res: string | null | undefined, name: string) => void textureOf(res).then((t) => {
    if (!t) return;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
    uniforms[name]!.value = t;
  });
  load(area.textures.TexMapLayer1, "layer1");
  load(area.textures.TexMapLayer2, "layer2");
  load(area.textures.MaskMap, "mask");
  if (lit) { load(area.textures.SixPointPosLightMap, "posLight"); load(area.textures.SixPointNegLightMap, "negLight"); }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: (isStatic ? staticParticleVS : (d: string, b: string) => dynamicParticleVS(true, d, b))(`uniform float time; uniform vec4 layer1Mod; uniform vec4 layer2Mod; uniform vec4 layer1Speed; uniform vec4 layer2Speed;
      uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint;
      varying vec4 vUv12; varying vec2 vMaskUv; varying vec4 vColor;${lit ? " varying vec3 vRight; varying vec3 vUp;" : ""}
      ${litByTiles ? "varying vec3 vLightPosition;" : ""}
      uniform float depthFadeScale; ${PARTICLE_DEPTH_VERTEX}`, `
        vSoft = particleDepth(p, size, depthFadeScale);
        vUv12 = vec4( layer1Mod.xy * uv + time * layer1Speed.xy + layer1Mod.zw, layer2Mod.xy * uv + time * layer2Speed.xy + layer2Mod.zw );
        ${lit ? `// the sprite's turned axes in the world (the eye's right and up, turned as the corner is)
        vec3 camRight = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] ), camUp = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
        vRight = c * camRight + s * camUp; vUp = -s * camRight + c * camUp;` : ""}
        ${litByTiles ? "vLightPosition = p.xyz;" : ""}
        ${offsets ? "vUv12 += iT13;" : ""}
        vMaskUv = uv;
        ${isStatic ? `vColor = colorMidpoint < 0.0 ? mix( color2, color3, clamp( -colorMidpoint / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) ) : color1;`
    : `vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );`}`),
    fragmentShader: `uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D mask;
      uniform vec4 spriteColor; uniform vec4 spriteFactors; uniform vec4 particleParams; uniform float brightness;
      varying vec4 vUv12; varying vec2 vMaskUv; varying vec4 vColor; varying float vDepth;
      ${PARTICLE_DEPTH_FRAGMENT}
      ${CLOUD_FOG_GLSL}
      ${lit ? "uniform sampler2D posLight; uniform sampler2D negLight; uniform vec4 ambientLight; uniform vec3 sunDir; uniform vec3 sunColour; varying vec3 vRight; varying vec3 vUp;" : ""}
      ${litByTiles ? `varying vec3 vLightPosition; ${TILED_LIGHT_GLSL}` : ""}
      ${lit ? `float sixPoint(vec3 direction, vec3 positive, vec3 negative) {
        vec3 lp = clamp(direction, 0.0, 1.0);
        vec3 ln = clamp(-direction, 0.0, 1.0);
        return dot(lp * lp, positive) + dot(ln * ln, negative);
      }` : ""}
      void main() {
        vec4 m = texture2D(mask, vMaskUv);
        ${dynMaskV2 ? "" : "if (m.a <= 0.0) discard;"}
        ${lit ? `// the frame (EVE's): the view's z row (toward the eye), the turned right, and their cross product in EVE's
        // left-handed space - the turned down (the texture's v)
        vec3 back = vec3( viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2] );
        mat3 axes = mat3(normalize(vRight), -normalize(vUp), normalize(back));
        vec3 positive = texture2D(posLight, vMaskUv).rgb;
        vec3 negative = texture2D(negLight, vMaskUv).rgb;
        vec3 irradiance = sunColour * sixPoint(sunDir * axes, positive, negative) + ambientLight.rgb;
        ${litByTiles ? `mat3 viewAxes = mat3(viewMatrix) * axes;
        ${tiledLightLoop("vLightPosition", "irradiance += dynColor * sixPoint(dynL * viewAxes, positive, negative);", true)}` : ""}
        m.rgb *= irradiance;` : ""}
        vec4 t = texture2D(layer1, vUv12.xy) * texture2D(layer2, vUv12.zw) * m;
        ${nearFade ? "t *= clamp((vDepth - particleParams.x) / (particleParams.y - particleParams.x), 0.0, 1.0);" : ""}
        vec4 col = vColor * spriteColor;
        float k = spriteFactors.x * (col.a * t.a - 1.0) + 1.0;
        float transmission = cloudFogTransmission(1.0 / gl_FragCoord.w);
        vec4 color = vec4(t.rgb * col.rgb * k, t.a * col.a * spriteFactors.z) * (brightness * particleDepthFade());
        ${dynMaskV2 ? "color.a *= transmission;" : "color *= transmission;"}
        gl_FragColor = color;
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  mat.userData.softDepth = true;
  // the sun: the scene's directional light (the first), found once per scene, read each frame (particleObject's step)
  if (lit) mat.userData.beforeDraw = (scene: THREE.Object3D, renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
    if (litByTiles) {
      prepareLights(renderer, camera);
      mat.uniformsNeedUpdate = true;
    }
    const sun = sunOf(scene);
    if (!sun) return;
    (uniforms.sunDir!.value as THREE.Vector3).copy(sun.position).sub(sun.target.position).normalize();
    (uniforms.sunColour!.value as THREE.Color).copy(sun.color).multiplyScalar(sun.intensity);
  };
  logDepth(mat);
  return mat;
}
const suns = new WeakMap<THREE.Object3D, THREE.DirectionalLight | null>();
function sunOf(scene: THREE.Object3D): THREE.DirectionalLight | null {
  if (!suns.has(scene)) {
    let sun: THREE.DirectionalLight | null = null;
    scene.traverse((o) => { if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight; });
    suns.set(scene, sun);
  }
  return suns.get(scene) ?? null;
}

/**
 * The particle effect particles/dynamic/motionvector.fx (its record 0, client 3396210): a flipbook in a volume -
 * TextureMap a 3D texture of Frames slices, played over t = sat(age)^TimeCurve: slices f = floor(t x Frames) and f + 1
 * (at z (f + 0.5) / Frames and (f + 1.5) / Frames), blended by the fraction. Each is first moved along a flow made
 * from the red and green channels: their gradients (central differences SampleDistance apart, summed over both
 * slices, normalised with SampleOffset added to the length) times the channel's change between the slices, the two
 * channels' summed, x DistortionStrength; the frame back along it by the fraction, the next forward by its rest. The
 * result's red read through GradientMap at (1 - r, t), its rgb times that, times its alpha and the vertex colour
 * (Color1 to Color2 over age 0 .. ColorMidpoint, Color2 to Color3 to 1); alpha x SpriteFactors.z; ONE / INVSRCALPHA
 * (its record's states). The flow's reads are at mip VelocitySmoothness: here the volume has its top level only (a
 * compressed 3D texture is nothing WebGL takes; ddsTexture.ts decodes it), so they are not smoothed. Samplers clamp.
 */
export function dynamicMotionVectorMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) }, velocityStretch: { value: f1(p.VelocityStretch, 0) },
    spriteFactors2: { value: v4(p.SpriteFactors2, [0.05, 1, 1, 1]) }, useWorldScale: { value: f1(p.UseWorldScale, 0) },
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) }, color3: { value: v4(p.Color3, [0, 0, 0, 0]) },
    colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) },
    frames: { value: f1(p.Frames, 64) }, sampleDistance: { value: f1(p.SampleDistance, 0.01) }, sampleOffset: { value: f1(p.SampleOffset, 0) },
    distortionStrength: { value: f1(p.DistortionStrength, 0.01) }, timeCurve: { value: f1(p.TimeCurve, 1) },
    volume: { value: null }, gradientMap: { value: null }, ready: { value: 0 },
  };
  const res = area.textures.TextureMap;
  if (res) void loadDds3D(res).then((t) => { uniforms.volume!.value = t; uniforms.ready!.value = 1; }).catch(() => undefined);
  void textureOf(area.textures.GradientMap).then((t) => { if (t) uniforms.gradientMap!.value = t; });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: dynamicParticleVS(false, "uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint; varying vec3 vUvAge; varying vec4 vColor;",
      `vUvAge = vec3( uv, age );
        vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );`),
    fragmentShader: `precision highp sampler3D;
      uniform sampler3D volume; uniform sampler2D gradientMap; uniform float ready; uniform vec4 spriteFactors;
      uniform float frames; uniform float sampleDistance; uniform float sampleOffset; uniform float distortionStrength; uniform float timeCurve;
      varying vec3 vUvAge; varying vec4 vColor; varying float vDepth;
      ${CLAMP_UV}
      vec4 vol(vec3 p) { vec3 h = 0.5 / vec3(textureSize(volume, 0)); return texture(volume, clamp(p, h, 1.0 - h)); }
      void main() {
        if (ready < 0.5) discard;
        float t = pow(clamp(vUvAge.z, 0.0, 1.0), timeCurve);
        float ft = t * frames;
        float f = floor(ft) + 0.5, k = fract(ft);
        vec3 p0 = vec3(vUvAge.xy, f / frames), p1 = vec3(vUvAge.xy, f / frames + 1.0 / frames);
        vec3 dy = vec3(0.0, sampleDistance, 0.0), dx = vec3(sampleDistance, 0.0, 0.0);
        vec2 gy = vol(p0 + dy).xy - vol(p0 - dy).xy + vol(p1 + dy).xy - vol(p1 - dy).xy;
        vec2 gx = vol(p0 + dx).xy - vol(p0 - dx).xy + vol(p1 + dx).xy - vol(p1 - dx).xy;
        vec2 len = sqrt(gx * gx + gy * gy) + sampleOffset;
        vec2 change = vol(p0).xy - vol(p1).xy;
        vec2 wx = change / len;
        vec3 flow = vec3(dot(gx, wx), dot(gy, wx), 0.0) * distortionStrength;
        vec4 c = mix(vol(p0 - flow * k), vol(p1 + flow * (1.0 - k)), k);
        vec3 g = texture2D(gradientMap, clampUv(gradientMap, vec2(clamp(1.0 - c.x, 0.0, 1.0), t))).rgb;
        vec4 col = c.a * vColor;
        gl_FragColor = vec4(c.rgb * g * col.rgb, col.a * spriteFactors.z);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  return mat;
}

/**
 * The particle effect particles/dynamic/3ddyndecalv2.fx (record 0, client 3396210; debris, rocks, corpses): each
 * particle draws the mesh itself in the world, not a camera-facing card - the mesh's vertex x lerp(size.x, size.y, age)
 * (TEXCOORD8), turned about the particle's axis (TEXCOORD11.xyz, normalised) by age x lifetime x spinVel (TEXCOORD10) +
 * spin (TEXCOORD9) + SpriteFactors.y (the axis-angle matrix), at the particle's position; TexMapLayer1 read at the atlas
 * cell TEXCOORD11.w of SpriteFactors.w x .w (as 1layerdynv2's), times the vertex colour (Color1 to Color2 over age 0 ..
 * ColorMidpoint, Color2 to Color3 to 1), alpha under 0.5 discarded; rgb plus GlowMapLayer1 at the same uv x
 * SpriteColor.rgb. Opaque, both faces (CULLMODE none), depth written. Its second target (the motion vectors, from the
 * previous frame's POSITION9 / TANGENT9) has nothing to go to here. Its sampler wraps; nothing is sRGB.
 */
export function dynDecalMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) }, spriteColor: { value: v4(p.SpriteColor, [1, 1, 1, 1]) },
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) }, color3: { value: v4(p.Color3, [0, 0, 0, 0]) },
    colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) },
    layer1: { value: null }, glow: { value: null },
  };
  const load = (res: string | null | undefined, name: string) => void textureOf(res).then((t) => {
    if (!t) return;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
    uniforms[name]!.value = t;
  });
  load(area.textures.TexMapLayer1, "layer1");
  load(area.textures.GlowMapLayer1, "glow");
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `uniform vec4 spriteFactors; uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint;
      attribute vec3 iPos; attribute vec2 iLife; attribute vec2 iT8; attribute float iT9; attribute float iT10; attribute vec4 iT11;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas;
      void main() {
        float age = iLife.x;
        float a = age * iT10 * iLife.y + iT9 + spriteFactors.y;
        vec3 n = normalize( iT11.xyz );
        vec3 v = position * mix( iT8.x, iT8.y, age );
        float s = sin( a ), c = cos( a );
        vec3 turned = v * c + cross( n, v ) * s + n * dot( n, v ) * ( 1.0 - c );
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( turned + iPos, 1.0 );
        vColor = age > colorMidpoint ? mix( color2, color3, clamp( ( age - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( age / colorMidpoint, 0.0, 1.0 ) );
        vUv = uv;
        float cell = trunc( iT11.w ) / spriteFactors.w;
        vAtlas = vec3( fract( cell ), trunc( cell ) / spriteFactors.w, 1.0 / spriteFactors.w );
      }`,
    fragmentShader: `uniform sampler2D layer1; uniform sampler2D glow; uniform vec4 spriteColor;
      varying vec4 vColor; varying vec2 vUv; varying vec3 vAtlas;
      void main() {
        vec2 cellUv = fract( vUv ) * vAtlas.z + vAtlas.xy;
        vec2 grad = vUv * vAtlas.z + vAtlas.xy;
        vec4 t = textureGrad( layer1, cellUv, dFdx( grad ), dFdy( grad ) ) * vColor;
        if ( t.a < 0.5 ) discard;
        vec3 g = textureGrad( glow, cellUv, dFdx( grad ), dFdy( grad ) ).rgb;
        gl_FragColor = vec4( spriteColor.rgb * g + t.rgb, t.a );
      }`,
    side: THREE.DoubleSide,
  });
  logDepth(mat);
  return mat;
}

/**
 * The particle effect particles/gateparticles.fx (a stargate's arrival and departure flash: its EFFECT_TYPE records
 * PARTICLE_DEPARTURE and PARTICLE_ARRIVAL, four passes each; client 3396210). ParticleDynamics x, y, z (distance,
 * start share, stretch), a the particle's age:
 * - the climb along the object's y axis: departing x (y a + (1 - y) a^2) from the particle, its speed x (y + (1 - y) a);
 *   arriving x - x (y b + (1 - y) b^2), b = sat(1.3 a), from the particle up x, the same speed;
 * - pass 0: the particle there, a card of lerp(size.x, size.y, a) stretched along its screen speed x z; colour Color1 to
 *   Color2 over age 0 .. ColorMidpoint, Color2 to Color3 to 1;
 * - pass 1: a ribbon from there back to where it began (the particle, or up x arriving), across it the eye's view of the
 *   y axis (normalize(y axis x (point - eye))) x the size; TexMap's column u 0.5 at v, its mip bias 4 (1 -
 *   sat((1 - u) colour.r)), x the colour x SpriteColor x (1 - u) x 0.3;
 * - pass 2: the start flash, a card at the particle's x, z on the y = 0 plane (y = x arriving) of 2 x lerp(size.x,
 *   size.y, f) x StartFlash.y, f = sqrt(a / StartFlash.x), coloured by f x StartFlash.z;
 * - pass 3: the end flash at the climb's end (y = x departing, 0 arriving), f = sat(a - 1 + StartFlash.x) / .x, its
 *   colour by f x f x StartFlash.z;
 * - every pass: TexMap (sRGB, decoded here after filtering) x colour x SpriteColor, alpha 1; the records set no blend
 *   (the area's preset).
 */
export function gateParticlesMaterials(area: Area, textureOf: TextureOf): THREE.ShaderMaterial[] {
  const p = area.params;
  const arrival = (area.options as Record<string, string> | undefined)?.EFFECT_TYPE === "PARTICLE_ARRIVAL";
  const uniforms: Record<string, THREE.IUniform> = {
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) }, color3: { value: v4(p.Color3, [0, 0, 0, 0]) },
    colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) }, particleDynamics: { value: v4(p.ParticleDynamics, [100, 0.01, 0, 0]) },
    startFlash: { value: v4(p.StartFlash, [0.1, 1, 1, 0]) }, spriteColor: { value: v4(p.SpriteColor, [1, 1, 1, 1]) }, texMap: { value: null },
  };
  void textureOf(area.textures.TexMap).then((t) => { if (!t) return; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; uniforms.texMap!.value = t; });
  const head = `uniform vec4 color1; uniform vec4 color2; uniform vec4 color3; uniform float colorMidpoint; uniform vec4 particleDynamics; uniform vec4 startFlash;
      attribute vec3 iPos; attribute vec2 iLife; attribute vec2 iT8;
      varying vec2 vUv; varying vec4 vColor;
      vec4 byAge( float t ) {
        return t > colorMidpoint ? mix( color2, color3, clamp( ( t - colorMidpoint ) / ( 1.0 - colorMidpoint ), 0.0, 1.0 ) )
          : mix( color1, color2, clamp( t / colorMidpoint, 0.0, 1.0 ) );
      }
      float climb( float a ) {
        float x = particleDynamics.x, y = particleDynamics.y;
        ${arrival ? "float b = clamp( a * 1.3, 0.0, 1.0 ); return x - ( x * y * b + ( 1.0 - y ) * x * b * b );" : "return x * y * a + ( 1.0 - y ) * x * a * a;"}
      }
      float speed( float a ) { return particleDynamics.x * particleDynamics.y + ( 1.0 - particleDynamics.y ) * particleDynamics.x * a; }`;
  const ps = (body: string) => `uniform sampler2D texMap; uniform vec4 spriteColor;
      varying vec2 vUv; varying vec4 vColor;
      vec3 decode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
      void main() { ${body} }`;
  const plain = ps("gl_FragColor = vec4(decode(texture2D(texMap, vUv).rgb) * vColor.rgb * spriteColor.rgb, 1.0);");
  const passes: [string, string][] = [
    [`${head}
      void main() {
        float a = iLife.x;
        vec4 view = viewMatrix * modelMatrix * vec4( iPos + vec3( 0.0, climb( a ), 0.0 ), 1.0 );
        vec3 viewVel = ( viewMatrix * vec4( modelMatrix[1].xyz * speed( a ), 0.0 ) ).xyz;
        vec2 sNow = ( projectionMatrix * view ).xy;
        vec2 sMove = ( projectionMatrix * ( view + vec4( viewVel, 0.0 ) ) ).xy - sNow;
        float sLen = length( sMove );
        vec2 sDir = sLen > 0.0 ? sMove / sLen : vec2( 0.0 );
        vec2 corner = position.xy * mix( iT8.x, iT8.y, a );
        vec4 p = view + vec4( corner, 0.0, 0.0 );
        if ( sLen > 0.0 ) p.xyz += viewVel * particleDynamics.z * dot( corner, sDir );
        gl_Position = projectionMatrix * p;
        vUv = uv; vColor = byAge( a );
      }`, plain],
    [`${head}
      void main() {
        float a = iLife.x;
        vec4 now = modelMatrix * vec4( iPos + vec3( 0.0, climb( a ), 0.0 ), 1.0 );
        vec4 from = modelMatrix * vec4( iPos + vec3( 0.0, ${arrival ? "particleDynamics.x" : "0.0"}, 0.0 ), 1.0 );
        vec4 w = mix( now, from, position.x + 0.5 );
        vec3 across = normalize( cross( normalize( modelMatrix[1].xyz ), w.xyz - cameraPosition ) );
        w.xyz += across * mix( iT8.x, iT8.y, a ) * position.y;
        gl_Position = projectionMatrix * viewMatrix * w;
        vUv = uv; vColor = byAge( a );
      }`, ps(`float u = vUv.x;
        float bias = 4.0 * ( 1.0 - clamp( ( 1.0 - u ) * vColor.r, 0.0, 1.0 ) );
        vec3 t = decode( texture2D( texMap, vec2( 0.5, vUv.y ), bias ).rgb );
        gl_FragColor = vec4( t * vColor.rgb * spriteColor.rgb * ( 1.0 - u ) * 0.3, 1.0 );`)],
    [`${head}
      void main() {
        float f = sqrt( iLife.x / startFlash.x );
        float size = 2.0 * ( iT8.x * startFlash.y + ( iT8.y * startFlash.y - iT8.x * startFlash.y ) * f );
        vec4 view = viewMatrix * modelMatrix * vec4( iPos.x, ${arrival ? "particleDynamics.x" : "0.0"}, iPos.z, 1.0 );
        gl_Position = projectionMatrix * ( view + vec4( position.xy * size, 0.0, 0.0 ) );
        vUv = uv; vColor = byAge( f ) * startFlash.z;
      }`, plain],
    [`${head}
      void main() {
        float f = clamp( iLife.x - ( 1.0 - startFlash.x ), 0.0, 1.0 ) / startFlash.x;
        float size = 2.0 * ( iT8.x * startFlash.y + ( iT8.y * startFlash.y - iT8.x * startFlash.y ) * f );
        vec4 view = viewMatrix * modelMatrix * vec4( iPos.x, ${arrival ? "0.0" : "particleDynamics.x"}, iPos.z, 1.0 );
        gl_Position = projectionMatrix * ( view + vec4( position.xy * size, 0.0, 0.0 ) );
        vUv = uv; vColor = byAge( f ) * ( f * startFlash.z );
      }`, plain],
  ];
  return passes.map(([vertexShader, fragmentShader]) => {
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      ...(area.kind === "additive"
        ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
        : { blending: THREE.NormalBlending }),
    });
    logDepth(mat);
    return mat;
  });
}

/** The 3698585 1layerdyndistortionv2.sm_depth stages, accumulated in the signed distortion map. */
function dynamicDistortionMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms = {
    spriteFactors: { value: v4(p.SpriteFactors, [0, 0, 0, 1]) },
    spriteFactors2: { value: v4(p.SpriteFactors2, [0.05, 1, 1, 1]) },
    layer1Mod: { value: v4(p.Layer1TexCoordModifier, [1, 1, 0, 0]) },
    velocityStretch: { value: f1(p.VelocityStretch, 0) }, useWorldScale: { value: f1(p.UseWorldScale, 0) },
    color1: { value: v4(p.Color1, [1, 1, 1, 0]) }, color2: { value: v4(p.Color2, [0.5, 0.5, 0.5, 0]) },
    color3: { value: v4(p.Color3, [0, 0, 0, 0]) }, colorMidpoint: { value: f1(p.ColorMidpoint, 0.5) },
    distanceScaling: { value: v4(p.DistanceScalingParams, [0, 100, 1, 0.5]) },
    distortionFactors: { value: v4(p.DistortionFactors, [1, 1, 10000, 1]) },
    normalMap1: { value: null as THREE.Texture | null },
    ...SOFT_DEPTH,
    ...CLOUD_FOG,
  };
  const uvFields = "varying vec2 normalUv; varying vec3 atlasCell; varying vec4 distortionFade;";
  const mat = logDepth(new THREE.ShaderMaterial({
    uniforms,
    vertexShader: dynamicParticleVS(false, `
      uniform vec4 layer1Mod, color1, color2, color3, distortionFactors, distanceScaling;
      uniform float colorMidpoint; attribute float iT11;
      ${uvFields}`, `
        normalUv = uv * layer1Mod.xy + layer1Mod.zw;
        float cell = trunc(iT11) / spriteFactors.w;
        atlasCell = vec3(fract(cell), trunc(cell) / spriteFactors.w, 1.0 / spriteFactors.w);
        float nearPlane = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
        float thickness = max(abs(size), 0.000001);
        float limit = length(modelMatrix[0].xyz) * distortionFactors.z;
        float falloff = limit > 0.0 ? max(length(view) / limit, 1.0) : 1.0;
        float opacity = age > colorMidpoint
          ? mix(color2.a, color3.a, clamp((age - colorMidpoint) / (1.0 - colorMidpoint), 0.0, 1.0))
          : mix(color1.a, color2.a, clamp(age / colorMidpoint, 0.0, 1.0));
        distortionFade = vec4(-p.z, thickness * 0.333, opacity / falloff,
          1.0 - clamp((nearPlane + p.z) / thickness, 0.0, 1.0));`, true),
    fragmentShader: `uniform vec4 distortionFactors; uniform sampler2D normalMap1;
      ${uvFields}
      ${SOFT_DEPTH_GLSL}
      ${CLOUD_FOG_GLSL}
      void main() {
        vec2 coord = fract(normalUv) * atlasCell.z + atlasCell.xy;
        vec2 original = normalUv * atlasCell.z;
        vec3 normal = textureGrad(normalMap1, coord, dFdx(original), dFdy(original)).xyz * 2.0 - 1.0;
        normal.z /= distortionFactors.w;
        float soft = softDepthOn > 0.5 ? clamp((softSceneDepth() - distortionFade.x) / distortionFade.y, 0.0, 1.0) : 1.0;
        vec2 offset = -normalize(normal).xy * distortionFactors.x * distortionFade.z * distortionFade.w * soft;
        gl_FragColor = vec4(offset * (cloudFogTransmission(1.0 / gl_FragCoord.w) / 64.0), 1.0 / 256.0, distortionFactors.y);
      }`,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
  }));
  mat.userData.distortion = true;
  mat.userData.softDepth = true;
  // The map's blue channel counts the particle even at zero offset, so wait for its own normal texture.
  mat.visible = false;
  void textureOf(area.textures.NormalMap1).then((normal) => {
    if (!normal) return;
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.needsUpdate = true;
    uniforms.normalMap1.value = normal;
    mat.visible = true;
  });
  return mat;
}

/** The 3698585 solarflare depth record used by the wormhole's low-frequency halo. */
function solarFlareMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms = {
    ...SOFT_DEPTH,
    depthShader: { get value() { return gfx().shaderQuality === 3; } },
    useWorldScale: { value: 1 },
    spriteFactors: { value: new THREE.Vector4() },
    spriteFactors2: { value: new THREE.Vector4(f1(p.VelocityStretchSupress, 0.0001), 0, 0, 0) },
    velocityStretch: { value: f1(p.VelocityStretch, 0) },
    velocityOriented: { value: f1(p.VelocityOriented, 0) },
    temperature: { value: v4(p.Temperature, [1, 0, 0.5, 0]) },
    brightness: { value: f1(p.Brightness, 1) },
    alphaScale: { value: f1(p.AlphaScale, 1) },
    layer1Mod: { value: v4(p.Layer1TexCoordModifier, [1, 1, 0, 0]) },
    layer2Mod: { value: v4(p.Layer2TexCoordModifier, [1, 1, 0, 0]) },
    layer1Speed: { value: v4(p.Layer1TexCoordSpeed, [0, 0, 0, 0]) },
    layer2Speed: { value: v4(p.Layer2TexCoordSpeed, [0, 0, 0, 0]) },
    time: particleClock,
    ramp: { value: null as THREE.Texture | null },
    gradient: { value: null as THREE.Texture | null },
    mask: { value: null as THREE.Texture | null },
    layer1: { value: null as THREE.Texture | null },
    layer2: { value: null as THREE.Texture | null },
  };
  const material = logDepth(new THREE.ShaderMaterial({
    uniforms,
    vertexShader: dynamicParticleVS(false, `
      uniform bool depthShader;
      uniform float velocityOriented;
      varying vec2 vUv;
      varying float vAge, vHalfSize;
    `, `
        // The HI and LO records output a degenerate primitive.
        if (!depthShader) gl_Position = vec4(0.0);
        else if (velocityOriented != 0.0) {
          vec4 center = projectionMatrix * view;
          vec4 moved = projectionMatrix * (view + vec4(viewVel * worldScale, 0.0));
          vec2 offset = moved.xy / moved.w - center.xy / center.w;
          float screenLength = length(offset);
          vec2 axis = screenLength > 0.0 ? offset / screenLength : vec2(0.0);
          float elongation = 2.0 * clamp(age / spriteFactors2.x, 0.0, 1.0) * velocityStretch * length(iVel);
          gl_Position = center;
          gl_Position.xy += size * (position.x * vec2(axis.y, -axis.x) + position.y * elongation * axis);
          vDepth = abs(view.z);
        }
        vUv = uv;
        vAge = age;
        vHalfSize = 0.5 * size;
    `),
    fragmentShader: `
      uniform sampler2D ramp, gradient, mask, layer1, layer2;
      uniform vec4 temperature, layer1Mod, layer2Mod, layer1Speed, layer2Speed;
      uniform float brightness, alphaScale, time;
      varying vec2 vUv;
      varying float vAge, vHalfSize, vDepth;
      ${SOFT_DEPTH_GLSL}
      ${CLAMP_UV}
      ${SRGB}
      void main() {
        vec4 a = texture2D(layer1, vUv * layer1Mod.xy + layer1Mod.zw + time * layer1Speed.xy);
        vec4 b = texture2D(layer2, vUv * layer2Mod.xy + layer2Mod.zw + time * layer2Speed.xy);
        vec4 m = texture2D(mask, vUv);
        float lookup = (a.r * b.r * m.r + temperature.y) * temperature.x;
        vec3 color = texture2D(ramp, clampUv(ramp, vec2(lookup, 0.0))).rgb * brightness;
        float age = texture2D(gradient, clampUv(gradient, vec2(vAge, 0.0))).r;
        float fade = softDepthOn > 0.0 ? clamp((softSceneDepth() - vDepth) / max(vHalfSize, 1e-6), 0.0, 1.0) : 1.0;
        float opacity = a.a * b.a * m.a * fade * (age * age) * (age * age);
        gl_FragColor = vec4(encode(max(color * opacity, 0.0)), clamp(opacity * alphaScale, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  material.userData.softDepth = true;
  material.visible = false;
  let disposed = false;
  material.addEventListener("dispose", () => { disposed = true; uniforms.ramp.value?.dispose(); });
  void Promise.all([
    textureOf(area.textures.ColorRampMap), textureOf(area.textures.GradientMap), textureOf(area.textures.MaskMap),
    textureOf(area.textures.TexMapLayer1), textureOf(area.textures.TexMapLayer2),
  ]).then(([ramp, gradient, mask, layer1, layer2]) => {
    if (disposed || !ramp || !gradient || !mask || !layer1 || !layer2) return;
    const colorRamp = ramp.clone();
    colorRamp.colorSpace = THREE.SRGBColorSpace;
    colorRamp.wrapS = colorRamp.wrapT = THREE.ClampToEdgeWrapping;
    colorRamp.minFilter = colorRamp.mipmaps && colorRamp.mipmaps.length > 1 ? THREE.LinearMipmapNearestFilter : THREE.LinearFilter;
    colorRamp.needsUpdate = true;
    uniforms.ramp.value = colorRamp;
    uniforms.gradient.value = gradient;
    uniforms.mask.value = mask;
    uniforms.layer1.value = layer1;
    uniforms.layer2.value = layer2;
    material.visible = true;
  });
  return material;
}

/** An area's particle material, by its effect file; null for an effect or permutation not drawn here. */
function particleMaterial(area: Area, textureOf: TextureOf): THREE.ShaderMaterial | THREE.ShaderMaterial[] | null {
  const path = (area as { path?: string }).path ?? "";
  if (area.kind === "distortion") return area.effect === "1layerdyndistortionv2" ? dynamicDistortionMaterial(area, textureOf) : null;
  if (area.effect === "1layernoatlasv2") return staticNoAtlasParticleMaterial(area, textureOf);
  if (area.effect === "1layerdecalv2") return staticDecalParticleMaterial(area, textureOf);
  if (area.effect === "1layerdynv2") {
    const material = oneLayerDynMaterial(area.params, null);
    void textureOf(area.textures.TexMapLayer1).then((t) => {
      if (!t) return;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
      material.uniforms.layer1!.value = t;
    });
    return material;
  }
  if (path.endsWith("/planet/solarflare.fx")) return solarFlareMaterial(area, textureOf);
  if (path.endsWith("/specialfx/particles/motionvector.fx")) return motionVectorParticleMaterial(area, textureOf);
  if (path.endsWith("/specialfx/particles/dynamic/motionvectorramp.fx")) return motionVectorParticleMaterial(area, textureOf, true);
  if (path.endsWith("/specialfx/particles/dynamic/motionvector.fx")) return dynamicMotionVectorMaterial(area, textureOf);
  if (path.endsWith("/specialfx/particles/gateparticles.fx")) return gateParticlesMaterials(area, textureOf);
  if (path.endsWith("/specialfx/particles/dynamic/3ddyndecalv2.fx")) return dynDecalMaterial(area, textureOf);
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
  /** Fixed instance rows containing xyz, size, rotation, and RGBA. */
  staticInstances?: number[];
  /** Debris appends the atlas cell and glow vector to each row. */
  staticInstanceStride?: number;
  staticShaderQualityMask?: number;
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
  DistortionFactors: "distortionFactors", DepthFadeControl: "depthFadeControl",
  ParticleDynamics: "particleDynamics", StartFlash: "startFlash",
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
  // a vector where 3ddyndecalv2 reads TEXCOORD11 whole (the axis and the atlas cell); the others its x
  { name: "iT11", size: 4, key: (u) => u.get(3) },
  { name: "iT13", size: 4, key: (u) => u.get(5) },
];

/**
 * A particle child's drawn object: one quad (the mesh's geometry) instanced per live particle of its mesh's system,
 * the emitters and systems stepped each frame it is drawn (a model's copies share it), the system's GPU elements
 * copied into the instance attributes (a custom element by its usage index: TEXCOORD8 + it).
 * The first supported colour area and the first supported distortion area share the same particle positions.
 */
export function particleObject(node: SofChildParticles, quad: THREE.BufferGeometry, textureOf: (res: string | null | undefined) => Promise<THREE.Texture | null>,
  registerEmitter?: (id: number, get: (attr: string) => number | number[] | undefined, set: (attr: string, v: number | number[]) => void, spawn?: (rate: number) => void) => void,
  registerUniform?: (id: number, uniform: THREE.IUniform | undefined) => void,
  linkedSystems = new Map<number, ParticleSim>()): THREE.Object3D | null {
  const materials: THREE.ShaderMaterial[] = [];
  for (const distortion of [false, true]) {
    for (const area of node.areas) {
      if ((area.kind === "distortion") !== distortion) continue;
      const made = particleMaterial(area, textureOf);
      if (!made) continue;
      for (const mat of Array.isArray(made) ? made : [made]) {
        for (const [name, id] of Object.entries(area.paramIds ?? {})) {
          const key = PARAM_UNIFORM[name];
          const uniform = key ? mat.uniforms[key] : undefined;
          if (uniform) registerUniform?.(id, uniform);
        }
        materials.push(mat);
      }
      break;
    }
  }
  const material = materials[0];
  if (!material) return null;
  if (node.staticInstances) {
    if (!node.staticInstances.length) return null;
    if (node.staticShaderQualityMask !== undefined) {
      const mask = node.staticShaderQualityMask;
      let textureReady = material.visible;
      Object.defineProperty(material, "visible", {
        enumerable: true,
        get: () => textureReady && !!(mask & (1 << (gfx().shaderQuality - 1))),
        set: (value: boolean) => { textureReady = value; },
      });
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.getAttribute("position"));
    geometry.setAttribute("uv", quad.getAttribute("uv"));
    const stride = node.staticInstanceStride ?? 9;
    const instances = new THREE.InstancedInterleavedBuffer(new Float32Array(node.staticInstances), stride);
    geometry.instanceCount = instances.count;
    geometry.setAttribute("iPos", new THREE.InterleavedBufferAttribute(instances, 3, 0));
    geometry.setAttribute("iT8", new THREE.InterleavedBufferAttribute(instances, 1, 3));
    geometry.setAttribute("iT9", new THREE.InterleavedBufferAttribute(instances, 1, 4));
    geometry.setAttribute("iT10", new THREE.InterleavedBufferAttribute(instances, 4, 5));
    if (stride === 14) {
      geometry.setAttribute("iT11", new THREE.InterleavedBufferAttribute(instances, 1, 9));
      geometry.setAttribute("iT12", new THREE.InterleavedBufferAttribute(instances, 4, 10));
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `child-static-particles:${node.name ?? ""}`;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    if (node.minScreenSize > 0) {
      quad.computeBoundingBox();
      const quadBounds = quad.boundingBox!;
      const corner = Math.hypot(Math.max(Math.abs(quadBounds.min.x), Math.abs(quadBounds.max.x)),
        Math.max(Math.abs(quadBounds.min.y), Math.abs(quadBounds.max.y)));
      const bounds = new THREE.Box3();
      const point = new THREE.Vector3();
      for (let i = 0; i < instances.array.length; i += stride) {
        point.fromArray(instances.array, i);
        const radius = corner * Math.abs(instances.array[i + 3]!);
        bounds.expandByPoint(point.addScalar(radius));
        bounds.expandByPoint(point.addScalar(-2 * radius));
      }
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      mesh.name = "size-gated";
      mesh.userData.minScreenSize = node.minScreenSize;
      mesh.userData.sphere = [...sphere.center.toArray(), sphere.radius];
    }
    return mesh;
  }
  const sims = node.systems.map((s) => {
    if (s.linkID === undefined) return new ParticleSim(s);
    const linked = linkedSystems.get(s.linkID);
    if (linked) return linked;
    const created = new ParticleSim(s);
    linkedSystems.set(s.linkID, created);
    return created;
  });
  const sim = sims[node.meshSystem];
  if (!sim || sim.max === 0) return null;
  const emitters = node.emitters.map((e) => new ParticleEmitter(structuredClone(e), sims[e.particleSystem?.system ?? -1] ?? null)).filter((e) => e.valid);
  if (!emitters.length && sim.data.linkID === undefined) return null;
  // an emitter's rate and limit a curve set's binding may drive (a ship's gas jets: its ShipStandard set)
  for (const e of emitters) {
    const id = (e.data as { id?: number }).id;
    if (id === undefined || !registerEmitter) continue;
    registerEmitter(id, (attr) => (attr === "rate" ? Number(e.data.rate ?? 0) : attr === "maxParticles" ? Number(e.data.maxParticles ?? -1) : undefined),
      (attr, v) => { const n = Array.isArray(v) ? v[0] ?? 0 : v; if (attr === "rate") e.data.rate = n; else if (attr === "maxParticles") e.data.maxParticles = n; },
      (rate) => e.spawn(rate));
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
  const updated: ParticleSim[] = [];
  // Each child owns the updates and callbacks for its own systems. Emitters may write to a sibling's shared system.
  let drawnBy: { scene: THREE.Object3D; world: THREE.Matrix4 } | null = null;
  for (const index of node.updated) {
    const s = sims[index], data = node.systems[index];
    if (!s || !data) continue;
    updated.push(s);
    const hook = (k: string) => { const e = data[k] as GpuEmitterData | undefined; return e && /^Tr2Gpu(Unique|Shared)Emitter$/.test(e.type ?? "") ? new GpuEmitter(e) : null; };
    const death = hook("emitParticleOnDeathEmitter"), life = hook("emitParticleDuringLifeEmitter");
    if (death) s.onDeath = (p, v) => { if (drawnBy) death.spawnAt(drawnBy.world, gpuSystemOf(drawnBy.scene), p, v, 1); };
    // its constraints' collision emitters (a GPU emitter each, made on its first collision)
    const onHit = new Map<Record<string, unknown>, GpuEmitter | null>();
    s.onCollision = (data, p, v) => {
      if (!drawnBy) return;
      if (!onHit.has(data)) onHit.set(data, /^Tr2Gpu(Unique|Shared)Emitter$/.test(String(data.type ?? "")) ? new GpuEmitter(data as unknown as GpuEmitterData) : null);
      onHit.get(data)?.spawnAt(drawnBy.world, gpuSystemOf(drawnBy.scene), p, v, 1);
    };
    const lifeData = data.emitParticleDuringLifeEmitter as ParticleEmitterData | undefined;
    if (lifeData?.type === "Tr2DynamicEmitter") {
      const emitter = new ParticleEmitter(lifeData, sims[lifeData.particleSystem?.system ?? -1] ?? null);
      if (emitter.valid) s.duringLife = (_p0, position, _v0, velocity, dt) => { emitter.spawn(dt, position, velocity); };
    } else if (life) {
      s.duringLife = (p0, p1, v0, v1, dt) => { if (drawnBy) life.spawnAlong(drawnBy.world, gpuSystemOf(drawnBy.scene), p0, p1, v0, v1, dt); };
    }
  }
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
  const meshes = materials.map((m) => {
    const mesh = new THREE.Mesh(geometry, m);
    mesh.name = `child-particles:${node.name ?? ""}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    if (m.userData.distortion) mesh.layers.set(DISTORTION_LAYER);
    return mesh;
  });
  let mesh: THREE.Object3D = meshes[0]!;
  if (meshes.length > 1) { mesh = new THREE.Group(); mesh.name = `child-particle-passes:${node.name ?? ""}`; for (const m of meshes) mesh.add(m); }
  let stepped = 0;
  const sortPositions = sim.data.linkID !== undefined && sim.data.requiresSorting
    ? sim.arrays.get(elementKey({ elementType: ELEMENT.POSITION })) : undefined;
  const eye = new THREE.Vector3();
  // stepped from the material's hook: a model's copies (Object3D.clone) share the material and the geometry but not
  // an object's own onBeforeRender
  material.onBeforeRender = (renderer, scene, camera, _g, object) => {
    (material.userData.beforeDraw as ((s: THREE.Object3D, r: THREE.WebGLRenderer, c: THREE.Camera) => void) | undefined)?.(scene, renderer, camera);
    object.updateWorldMatrix(true, false);
    drawnBy = { scene, world: object.matrixWorld };
    const now = performance.now() / 1000;
    if (now === stepped) return;
    stepped = now;
    // (an emitter only an action fires is not updated: Tr2ActionSpawnParticles' own)
    for (const e of emitters) if (!(e.data as { actionOnly?: boolean }).actionOnly) e.update(now);
    for (const s of updated) s.update(now);
    let sorted: number[] | undefined;
    if (sortPositions && sim.alive > 1) {
      object.worldToLocal(camera.getWorldPosition(eye));
      const distance = Array.from({ length: sim.alive }, (_, i) => {
        const x = sortPositions[i * 3]! - eye.x, y = sortPositions[i * 3 + 1]! - eye.y, z = sortPositions[i * 3 + 2]! - eye.z;
        return x * x + y * y + z * z;
      });
      sorted = distance.map((_dist, i) => i).sort((i, j) => distance[j]! - distance[i]!);
    }
    for (const f of filled) {
      const src = f.key ? sim.arrays.get(f.key) : undefined;
      const size = f.key ? sim.sizes.get(f.key) ?? 0 : 0;
      const dst = f.attr.array as Float32Array;
      if (src) for (let i = 0; i < sim.alive; i++) {
        const at = (sorted?.[i] ?? i) * size;
        for (let d = 0; d < f.size; d++) dst[i * f.size + d] = d < size ? src[at + d]! : 0;
      }
      f.attr.needsUpdate = true;
    }
    geometry.instanceCount = sim.alive;
  };
  return mesh;
}
