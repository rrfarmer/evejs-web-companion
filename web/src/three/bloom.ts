// The scenes' post-process as the client draws it (Tr2PostProcess2), from the drawn frame to the screen:
// - the bloom (Tr2PPBloomEffect; its defaults read from the client, build 3396210, are Unreal Engine 4's bloom
//   defaults): highpassfilter.sm_hi keeps of each pixel colour * max(0, 1 - threshold / luminance) * luminanceScale
//   (0.5), the luminance being the darkest of four neighbouring taps (against flicker), at half size; that is halved
//   down to 1/64 by downsample.sm_hi (thirteen taps: the inner four at 1/8 each, four corner boxes of four at 1/32);
//   step i blurs level i (1/2^(i+1)) with upsample.sm_hi, Unreal's weighted sample sum: a separable kernel of radius
//   2 * size * sizeScale percent of the level's width, weights e^(-16 (x / radius)^2), at most 127 texels, and adds
//   it times its tint to the steps below. Every scene file sets luminanceThreshold 0: the whole frame blooms, a little;
// - the output (tonemapping.sm_hi): the scene plus the bloom * brightness (0.2) through the tone map, then times the
//   exposure (exposure.ts), through the tone map again, to sRGB.
// The kernel's weights are Unreal's (Compute1DGaussianFilterKernel); the client builds them on the CPU, so they are
// not in its shaders. The steps are summed in the output pass rather than chained level to level (the same sum,
// upsampled once rather than step by step). The client's luminance-weighted downsample variants are not used: which
// one a scene with threshold 0 gets is not in the shaders. The frame is drawn into its own
// multisampled target and read from its resolve; NaN or infinite pixels are dropped as read (a NaN anywhere would
// spread through the blurs and black the frame).

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { toneMapGlsl, type DynamicExposure, type ToneMapMethod } from "./exposure.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL, SoftDepthPass } from "./softDepth.ts";
import { ENVIRONMENT_FOG_GLSL, type EnvironmentFog } from "./environmentFog.ts";
import { GodRaysPass, type GodRays, type GodRaySun } from "./godRays.ts";
import type { FlareClouds } from "./cloudOpacity.ts";
import { sceneReflection } from "./celestialModel.ts";
import { DistortionPass } from "./distortion.ts";
import type { SpaceShadowAtlas } from "./spaceShadowAtlas.ts";

/** Tr2PPBloomEffect's values (the client's defaults; the scenes set luminanceThreshold 0). */
export const BLOOM = {
  luminanceThreshold: 0, luminanceScale: 0.5, brightness: 0.2, sizeScale: 4,
  steps: [
    { size: 0.3, tint: 0.3465 }, { size: 1, tint: 0.138 }, { size: 2, tint: 0.1176 },
    { size: 10, tint: 0.066 }, { size: 30, tint: 0.066 }, { size: 64, tint: 0.061 },
  ],
} as const;

/** How many halvings below the frame the bloom's levels go (level 0 is the high-pass, at half size). */
const LEVELS = 6;
/** The widest kernel, in texels either side (upsample.sm_hi takes 64 pairs of taps). */
const MAX_RADIUS = 127;

export interface EnvironmentBloom {
  luminanceThreshold: number;
  luminanceScale: number;
  brightness: number;
  grime: THREE.Texture;
  grimeWeight: number;
  lut: THREE.Data3DTexture;
  lutInfluence: number;
  fog: EnvironmentFog;
  godRays?: GodRays;
}

export interface Bloom {
  render(environment?: EnvironmentBloom | null, sun?: GodRaySun | null, clouds?: FlareClouds): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

const VERTEX = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SAFE = "vec3 safe( vec3 c ) { return ( any( isnan( c ) ) || any( isinf( c ) ) ) ? vec3( 0.0 ) : min( c, vec3( 256.0 ) ); }";

function target(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
}

/** A scene drawn, bloomed, exposed and tone-mapped as the client does it. */
export function bloomFor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
  post: {
    exposure: () => DynamicExposure | null;
    toneMap: ToneMapMethod;
    quality?: () => { postProcess: boolean; distortion: boolean };
    depthEffects?: () => boolean;
    shadows?: SpaceShadowAtlas;
  }): Bloom {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const drawn = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 4 });
  // levels[i] is 1 / 2^(i + 1) of the frame; blurred[s] is step s's blur, at its level; spare[i] the blur's halfway
  let levels: THREE.WebGLRenderTarget[] = [];
  let spare: THREE.WebGLRenderTarget[] = [];
  let blurred: THREE.WebGLRenderTarget[] = [];
  const stepRadius: number[] = [];

  const highPass = new THREE.ShaderMaterial({
    uniforms: { frame: { value: drawn.texture }, texel: { value: new THREE.Vector2() }, threshold: { value: BLOOM.luminanceThreshold }, scale: { value: BLOOM.luminanceScale } },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D frame; uniform vec2 texel; uniform float threshold, scale; varying vec2 vUv;
      ${SAFE}
      vec3 encoded( vec3 c ) { return mix( c * 12.92, 1.055 * pow( max( c, 0.0 ), vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) ); }
      void main() {
        // the darkest of four taps (the client measures luminance on its gamma-encoded frame)
        vec3 best = vec3( 0.0 ); float lum = 1e9;
        for ( int i = 0; i < 4; i++ ) {
          vec2 o = vec2( float( i - ( i / 2 ) * 2 ), float( i / 2 ) ) * texel;
          vec3 c = safe( texture2D( frame, vUv + o ).rgb );
          float l = dot( vec3( 0.299, 0.587, 0.114 ), encoded( c ) );
          if ( l < lum ) { lum = l; best = c; }
        }
        gl_FragColor = vec4( lum < threshold || lum <= 0.0 ? vec3( 0.0 ) : best * max( 1.0 - threshold / lum, 0.0 ) * scale, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  // downsample.sm_hi: thirteen taps, in texels of the level above
  const half = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, texel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D source; uniform vec2 texel; varying vec2 vUv;
      vec3 at( float x, float y ) { return texture2D( source, vUv + texel * vec2( x, y ) ).rgb; }
      void main() {
        vec3 inner = at( -1.0, -1.0 ) + at( 1.0, -1.0 ) + at( -1.0, 1.0 ) + at( 1.0, 1.0 );
        vec3 c = at( 0.0, 0.0 ), n = at( 0.0, -2.0 ), s = at( 0.0, 2.0 ), w = at( -2.0, 0.0 ), e = at( 2.0, 0.0 );
        vec3 boxes = ( at( -2.0, -2.0 ) + n + w + c ) + ( at( 2.0, -2.0 ) + n + e + c ) + ( at( -2.0, 2.0 ) + s + w + c ) + ( at( 2.0, 2.0 ) + s + e + c );
        gl_FragColor = vec4( inner * 0.125 + boxes * 0.03125, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  // upsample.sm_hi's kernel: every texel within the radius, weighed e^(-16 (x / radius)^2)
  const blur = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, step: { value: new THREE.Vector2() }, radius: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D source; uniform vec2 step; uniform float radius; varying vec2 vUv;
      void main() {
        int reach = int( min( ceil( radius ), ${MAX_RADIUS}.0 ) );
        vec3 sum = vec3( 0.0 ); float weights = 0.0;
        for ( int i = -${MAX_RADIUS}; i <= ${MAX_RADIUS}; i++ ) {
          if ( i < -reach || i > reach ) continue;
          float x = float( i ) / radius;
          float w = exp( -16.0 * x * x );
          sum += texture2D( source, vUv + step * float( i ) ).rgb * w;
          weights += w;
        }
        gl_FragColor = vec4( sum / weights, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  const output = new THREE.ShaderMaterial({
    uniforms: {
      frame: { value: drawn.texture }, exposure: { value: 1 }, brightness: { value: BLOOM.brightness },
      grime: { value: null }, grimeWeight: { value: 0 }, colorLut: { value: null }, lutInfluence: { value: 0 },
      step0: { value: null }, step1: { value: null }, step2: { value: null }, step3: { value: null }, step4: { value: null }, step5: { value: null },
      tints: { value: BLOOM.steps.map((s) => s.tint) },
      ...SOFT_DEPTH,
      fogEnabled: { value: false }, fogHasNebula: { value: false }, fogNebula: { value: null },
      fogInverseProjection: { value: camera.projectionMatrixInverse }, fogWorldFromView: { value: camera.matrixWorld },
      fogColorParams: { value: new THREE.Vector4() }, fogCompositeParams: { value: new THREE.Vector3() },
      fogAreaSize: { value: new THREE.Vector3() }, fogEyeFromCenter: { value: new THREE.Vector3() },
      fogColor: { value: new THREE.Vector3() }, fogBrightness: { value: new THREE.Vector3() },
      fogBlend0: { value: new THREE.Vector4() }, fogBlend1: { value: new THREE.Vector4() }, fogBlend2: { value: new THREE.Vector4() },
    },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D frame, step0, step1, step2, step3, step4, step5, grime;
      uniform highp sampler3D colorLut;
      uniform float tints[6];
      uniform float exposure, brightness, grimeWeight, lutInfluence;
      varying vec2 vUv;
      ${SAFE}
      ${toneMapGlsl(post.toneMap)}
      ${SOFT_DEPTH_GLSL}
      ${ENVIRONMENT_FOG_GLSL}
      void main() {
        vec3 bloom = texture2D( step0, vUv ).rgb * tints[0] + texture2D( step1, vUv ).rgb * tints[1] + texture2D( step2, vUv ).rgb * tints[2]
          + texture2D( step3, vUv ).rgb * tints[3] + texture2D( step4, vUv ).rgb * tints[4] + texture2D( step5, vUv ).rgb * tints[5];
        // tonemapping.sm_hi modulates the bloom by 1 + the linear grime sample times its weight.
        if ( grimeWeight > 0.0 ) bloom *= 1.0 + texture2D( grime, vec2( vUv.x, 1.0 - vUv.y ) ).rgb * grimeWeight;
        vec3 colour = safe( texture2D( frame, vUv ).rgb ) + toneMapped( bloom * brightness );
        colour = clamp( toneMapped( colour * exposure ), 0.0, 1.0 );
        colour = toSrgb( colour );
        if ( fogEnabled ) colour = environmentFog( colour, vUv );
        // The volume indexes the encoded RGB directly and returns encoded RGB.
        if ( lutInfluence > 0.0 ) colour = mix( colour, texture( colorLut, colour ).rgb, lutInfluence );
        gl_FragColor = vec4( colour, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new FullScreenQuad();

  const layout = (w: number, h: number) => {
    for (const t of [...levels, ...spare, ...blurred]) t.dispose();
    levels = []; spare = [];
    for (let i = 0; i < LEVELS; i++) {
      const lw = Math.ceil(w / 2 ** (i + 1)), lh = Math.ceil(h / 2 ** (i + 1));
      levels.push(target(lw, lh));
      spare.push(target(lw, lh));
    }
    // step i on level i, its radius in that level's texels ("*2 as we use the diameter", Unreal's weighted sum)
    stepRadius.length = 0;
    BLOOM.steps.forEach((s, i) => stepRadius.push(Math.min(MAX_RADIUS, Math.max(0.01, (s.size * BLOOM.sizeScale * 2 / 100) * levels[i]!.width))));
    blurred = BLOOM.steps.map((_, i) => target(levels[i]!.width, levels[i]!.height));
    blurred.forEach((t, s) => { output.uniforms[`step${s}`]!.value = t.texture; });
  };
  layout(drawn.width, drawn.height);

  const draw = (material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(to);
    quad.render(renderer);
  };

  // the opaque depth behind the soft areas (softDepth.ts), where one is in view
  const softDepth = new SoftDepthPass();
  // the distortion surfaces' warp of the frame (distortion.ts), before the post-process reads it
  const distortion = new DistortionPass();
  let rayPass: GodRaysPass | null = null;

  return {
    render: (environment, sun, clouds) => {
      // The graphics settings (gfxSettings.ts) select postprocessing and the
      // shader model independently. The depth model composites environment fog.
      const quality = post.quality?.() ?? { postProcess: true, distortion: true };
      const active = quality.postProcess ? environment : null;
      const depthEffects = post.depthEffects?.();
      const fog = depthEffects ? active?.fog : undefined;
      const godRays = depthEffects ? active?.godRays : undefined;
      const needsDepth = !!fog || (!!godRays && !!sun) || !!post.shadows?.needsOpaqueDepth;
      softDepth.render(renderer, scene, camera, drawn.width, drawn.height, needsDepth);
      post.shadows?.resolveOpaque(camera, drawn.width, drawn.height);
      renderer.setRenderTarget(drawn);
      renderer.render(scene, camera);
      let frame = quality.distortion ? distortion.render(renderer, scene, camera, drawn) : drawn.texture;
      if (sun && godRays && godRays.intensity > 0) {
        rayPass ??= new GodRaysPass();
        frame = rayPass.render(renderer, scene, camera, sun, godRays, frame, drawn.width, drawn.height, clouds);
      }
      highPass.uniforms["frame"]!.value = frame;
      output.uniforms["frame"]!.value = frame;
      const e = post.exposure();
      if (e) e.measure(renderer, frame);
      output.uniforms["fogEnabled"]!.value = !!fog;
      if (fog) {
        const f = fog.settings;
        const u = output.uniforms;
        const cube = sceneReflection.value;
        u["fogNebula"]!.value = cube;
        u["fogHasNebula"]!.value = (cube as THREE.CubeTexture | null)?.isCubeTexture === true;
        // Defaults from Tr2PPFogEffect and the four properties the native factory interpolates.
        const influence = fog.influence;
        u["fogColorParams"]!.value.set(THREE.MathUtils.lerp(0.5, f.nebulaInfluence, influence), f.nebulaBlur ?? 7,
          f.originalBrightenOnly ?? 0.5, THREE.MathUtils.lerp(0.125, f.colorInfluence, influence));
        u["fogCompositeParams"]!.value.set(fog.amount, THREE.MathUtils.lerp(1, f.backgroundOcclusion, influence), fog.intensity);
        u["fogAreaSize"]!.value.set(fog.dimensions[0] * f.areaScale[0], fog.dimensions[1] * f.areaScale[1], fog.dimensions[2] * f.areaScale[0]);
        u["fogEyeFromCenter"]!.value.setFromMatrixPosition(camera.matrixWorld).sub(fog.center);
        u["fogColor"]!.value.set(f.color[0], f.color[1], f.color[2]);
        u["fogBrightness"]!.value.set(f.brightnessThreshold0 ?? 0, f.brightnessThreshold1 ?? 0.5,
          THREE.MathUtils.lerp(1, f.brightnessAdjustmentAmount, influence));
        u["fogBlend0"]!.value.set(f.blendDistance0, f.blendBias0, f.blendAmount0, f.blendPower0 ?? 2);
        u["fogBlend1"]!.value.set(f.blendDistance1, f.blendBias1, f.blendAmount1, f.blendPower1 ?? 1);
        u["fogBlend2"]!.value.set(f.blendDistance2, f.blendBias2, f.blendAmount2, f.blendPower2);
      }
      output.uniforms["brightness"]!.value = quality.postProcess ? active?.brightness ?? BLOOM.brightness : 0;
      output.uniforms["grime"]!.value = active?.grime ?? null;
      output.uniforms["grimeWeight"]!.value = active?.grimeWeight ?? 0;
      output.uniforms["colorLut"]!.value = active?.lut ?? null;
      output.uniforms["lutInfluence"]!.value = active?.lutInfluence ?? 0;
      if (quality.postProcess) {
        highPass.uniforms["threshold"]!.value = active?.luminanceThreshold ?? BLOOM.luminanceThreshold;
        highPass.uniforms["scale"]!.value = active?.luminanceScale ?? BLOOM.luminanceScale;
        // the bloom
        highPass.uniforms["texel"]!.value.set(1 / drawn.width, 1 / drawn.height);
        draw(highPass, levels[0]!);
        for (let i = 1; i < LEVELS; i++) {
          half.uniforms["source"]!.value = levels[i - 1]!.texture;
          half.uniforms["texel"]!.value.set(1 / levels[i - 1]!.width, 1 / levels[i - 1]!.height);
          draw(half, levels[i]!);
        }
        BLOOM.steps.forEach((_, i) => {
          const level = levels[i]!;
          blur.uniforms["radius"]!.value = stepRadius[i]!;
          blur.uniforms["source"]!.value = level.texture;
          blur.uniforms["step"]!.value.set(1 / level.width, 0);
          draw(blur, spare[i]!);
          blur.uniforms["source"]!.value = spare[i]!.texture;
          blur.uniforms["step"]!.value.set(0, 1 / level.height);
          draw(blur, blurred[i]!);
        });
      }
      // the output
      output.uniforms["exposure"]!.value = e ? e.step() : 1;
      draw(output, null);
    },
    setSize: (cw, ch) => {
      const r = renderer.getPixelRatio();
      const w = Math.max(1, Math.floor(cw * r)), h = Math.max(1, Math.floor(ch * r));
      drawn.setSize(w, h);
      layout(w, h);
    },
    dispose: () => {
      for (const t of [drawn, ...levels, ...spare, ...blurred]) t.dispose();
      for (const m of [highPass, half, blur, output]) m.dispose();
      quad.dispose();
      softDepth.dispose();
      distortion.dispose();
      rayPass?.dispose();
    },
  };
}
