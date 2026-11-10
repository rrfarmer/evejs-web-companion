// The scenes' post-process as the client draws it (Tr2PostProcess2), from the drawn frame to the screen:
// - the bloom (Tr2PPBloomEffect; its defaults read from the client, build 3396210, are Unreal Engine 4's bloom
//   defaults): highpassfilter.sm_hi keeps of each pixel colour * max(0, 1 - threshold / luminance) * luminanceScale
//   (0.5), the luminance being the darkest of four neighbouring taps (against flicker); the result is halved down to
//   1/64 size; then six blurs of it, each `size` percent of the screen's width (times sizeScale, 4) wide, are summed,
//   each times its tint. Every scene file sets luminanceThreshold 0: the whole frame blooms, a little;
// - the output (tonemapping.sm_hi): the scene plus the bloom * brightness (0.2) through the tone map, then times the
//   exposure (exposure.ts), through the tone map again, to sRGB.
// Ours: the blurs are separable Gaussians (sigma a third of the width) drawn at the size where they are 8-16 texels
// wide, and the halving is a four-tap box rather than the client's thirteen taps. The frame is drawn into its own
// multisampled target and read from its resolve; NaN or infinite pixels are dropped as read (a NaN anywhere would
// spread through the blurs and black the frame).

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { toneMapGlsl, type DynamicExposure, type ToneMapMethod } from "./exposure.ts";

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
/** Gaussian taps either side of the centre. */
const TAPS = 12;

export interface Bloom {
  render(): void;
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
  post: { exposure: () => DynamicExposure | null; toneMap: ToneMapMethod }): Bloom {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const drawn = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 4 });
  // levels[i] is 1 / 2^(i + 1) of the frame; blurred[s] is step s's blur, at its level; spare[i] the blur's halfway
  let levels: THREE.WebGLRenderTarget[] = [];
  let spare: THREE.WebGLRenderTarget[] = [];
  let blurred: THREE.WebGLRenderTarget[] = [];
  const stepLevel: number[] = [];
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
  const half = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, texel: { value: new THREE.Vector2() } },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D source; uniform vec2 texel; varying vec2 vUv;
      void main() {
        vec3 c = texture2D( source, vUv + texel * vec2( -0.5, -0.5 ) ).rgb + texture2D( source, vUv + texel * vec2( 0.5, -0.5 ) ).rgb
          + texture2D( source, vUv + texel * vec2( -0.5, 0.5 ) ).rgb + texture2D( source, vUv + texel * vec2( 0.5, 0.5 ) ).rgb;
        gl_FragColor = vec4( c * 0.25, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  const blur = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, step: { value: new THREE.Vector2() }, sigma: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D source; uniform vec2 step; uniform float sigma; varying vec2 vUv;
      void main() {
        vec3 sum = vec3( 0.0 ); float weights = 0.0;
        for ( int i = -${TAPS}; i <= ${TAPS}; i++ ) {
          float w = exp( -0.5 * float( i * i ) / ( sigma * sigma ) );
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
      step0: { value: null }, step1: { value: null }, step2: { value: null }, step3: { value: null }, step4: { value: null }, step5: { value: null },
      tints: { value: BLOOM.steps.map((s) => s.tint) },
    },
    vertexShader: VERTEX,
    fragmentShader: `uniform sampler2D frame, step0, step1, step2, step3, step4, step5; uniform float tints[6]; uniform float exposure, brightness; varying vec2 vUv;
      ${SAFE}
      ${toneMapGlsl(post.toneMap)}
      void main() {
        vec3 bloom = texture2D( step0, vUv ).rgb * tints[0] + texture2D( step1, vUv ).rgb * tints[1] + texture2D( step2, vUv ).rgb * tints[2]
          + texture2D( step3, vUv ).rgb * tints[3] + texture2D( step4, vUv ).rgb * tints[4] + texture2D( step5, vUv ).rgb * tints[5];
        vec3 colour = safe( texture2D( frame, vUv ).rgb ) + toneMapped( bloom * brightness );
        colour = clamp( toneMapped( colour * exposure ), 0.0, 1.0 );
        gl_FragColor = vec4( mix( colour * 12.92, 1.055 * pow( colour, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), colour ) ), 1.0 );
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
    // each step blurs at the level where its width is about 8-16 texels
    stepLevel.length = 0; stepRadius.length = 0;
    for (const s of BLOOM.steps) {
      const radius = (s.size * BLOOM.sizeScale / 100) * w;
      const level = Math.min(LEVELS - 1, Math.max(0, Math.round(Math.log2(radius / 8)) - 1));
      stepLevel.push(level);
      stepRadius.push(radius / 2 ** (level + 1));
    }
    blurred = BLOOM.steps.map((_, s) => target(levels[stepLevel[s]!]!.width, levels[stepLevel[s]!]!.height));
    blurred.forEach((t, s) => { output.uniforms[`step${s}`]!.value = t.texture; });
  };
  layout(drawn.width, drawn.height);

  const draw = (material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) => {
    quad.material = material;
    renderer.setRenderTarget(to);
    quad.render(renderer);
  };

  return {
    render: () => {
      renderer.setRenderTarget(drawn);
      renderer.render(scene, camera);
      const e = post.exposure();
      if (e) e.measure(renderer, drawn.texture);
      // the bloom
      highPass.uniforms["texel"]!.value.set(1 / drawn.width, 1 / drawn.height);
      draw(highPass, levels[0]!);
      for (let i = 1; i < LEVELS; i++) {
        half.uniforms["source"]!.value = levels[i - 1]!.texture;
        half.uniforms["texel"]!.value.set(1 / levels[i - 1]!.width, 1 / levels[i - 1]!.height);
        draw(half, levels[i]!);
      }
      BLOOM.steps.forEach((_, s) => {
        const at = stepLevel[s]!;
        const level = levels[at]!;
        const r = stepRadius[s]!;
        // the taps spread to cover the width: a texel apart up to TAPS texels, wider beyond
        const spacing = Math.max(1, r / TAPS);
        blur.uniforms["sigma"]!.value = Math.max(0.5, r / 3 / spacing);
        blur.uniforms["source"]!.value = level.texture;
        blur.uniforms["step"]!.value.set(spacing / level.width, 0);
        draw(blur, spare[at]!);
        blur.uniforms["source"]!.value = spare[at]!.texture;
        blur.uniforms["step"]!.value.set(0, spacing / level.height);
        draw(blur, blurred[s]!);
      });
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
    },
  };
}
