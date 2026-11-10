// The client's dynamic exposure and tone map (Tr2PostProcess2's Tr2PPDynamicExposureEffect and
// Tr2PPTonemappingEffect), as its compute and pixel shaders do them (graphics/effect.dx11/managed/space/postprocess/
// createhistograms, measureexposure and tonemapping, disassembled, client 3396210):
// - createhistograms: each pixel's luminance (Rec. 709) goes into one of 64 bins spread evenly over ln(minLuminance)
//   to ln(maxLuminance), clamped at both ends;
// - measureexposure: the luminance at the minBrightness and at the maxBrightness fraction of the pixels (a bin's own
//   count interpolated within it), averaged; the exposure 0.5 / that is clamped to e^minExposure..e^maxExposure, and
//   the luminance it stands for, L, is approached in square-root space at increaseSpeed or decreaseSpeed per second
//   (1 - e^(-speed * dt) of the way each frame);
// - tonemapping (its DYNAMIC_EXPOSURE_ENABLED variants read L straight from that buffer): the colour times
//   ExposureAdjust * ExposureMiddleValue / lerp(0.5, L, ExposureInfluence), then doubled, through the filmic curve
//   (x(Ax + CB) + DE) / (x(Ax + B) + DF) - E/F, divided by the curve at WhiteScale, then to sRGB. The curve is the
//   standard one (A..F 0.15, 0.5, 0.1, 0.2, 0.02, 0.3) for the effect's method 0, its own parameters for method 1.
// The defaults are the client's own (the effects constructed in the client's Python, trinity build 3396210). A
// scene with no post-process of its own gets res:/dx9/default/postprocess.black (sceneRenderJobSpace's
// LoadSceneDefaults): the space scenes, dynamic exposure at its defaults and method 0. The hangar scenes name a
// dynamic exposure and no tone map, so theirs is the effect's defaults (method 1). ExposureAdjust is taken as
// 2^adjustment (the effect's adjustment is in stops; the shader multiplies by its constant).

import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

export interface DynamicExposureParams {
  middleValue: number; minLuminance: number; maxLuminance: number; minBrightness: number; maxBrightness: number;
  increaseSpeed: number; decreaseSpeed: number; minExposure: number; maxExposure: number; adjustment: number; influence: number;
}
export const DYNAMIC_EXPOSURE_DEFAULTS: DynamicExposureParams = {
  middleValue: 0.55, minLuminance: 0.4649, maxLuminance: 10, minBrightness: 0.9, maxBrightness: 0.98,
  increaseSpeed: 2, decreaseSpeed: 1.5, minExposure: -3.7, maxExposure: 10, adjustment: 0, influence: 1,
};

/** The filmic curve's parameters: method 0's fixed ones, and Tr2PPTonemappingEffect's defaults for method 1. */
export const TONEMAP_CURVES = {
  0: { A: 0.15, B: 0.5, C: 0.1, D: 0.2, E: 0.02, F: 0.3 },
  1: { A: 0.125, B: 0.25, C: 0.1, D: 0.15, E: 0.021, F: 0.3 },
} as const;
export type ToneMapMethod = keyof typeof TONEMAP_CURVES;
const WHITE_SCALE = 2.5;

const BINS = 64;

/** The 64-bin histogram's two brightness fractions averaged (measureexposure), from luminances. */
export function brightLuminance(lums: ArrayLike<number>, p: DynamicExposureParams): number {
  const lo = Math.log(p.minLuminance), hi = Math.log(p.maxLuminance);
  const bins = new Uint32Array(BINS);
  for (let i = 0; i < lums.length; i++) {
    const l = lums[i]!;
    const t = l > 0 ? Math.min(1, Math.max(0, (Math.log(l) - lo) / (hi - lo))) : 0;
    bins[Math.min(BINS - 1, Math.floor(t * BINS))]!++;
  }
  const at = (fraction: number) => {
    let left = Math.floor(lums.length * fraction);
    if (!left) return 0;
    for (let i = 0; i < BINS; i++) {
      const n = bins[i]!;
      if (n >= left) return Math.exp(lo + (hi - lo) * ((i + left / n) / BINS));
      left -= n;
    }
    return 0;
  };
  return (at(p.minBrightness) + at(p.maxBrightness)) * 0.5;
}

/** The measured luminance the exposure aims at, clamped as the exposure limits clamp it. */
export function targetLuminance(bright: number, p: DynamicExposureParams): number {
  const exposure = bright < 1e-4 ? 5000 : 0.5 / bright;
  return 0.5 / Math.max(Math.exp(p.minExposure), Math.min(Math.exp(p.maxExposure), exposure));
}

/** One frame's step from the luminance adapted to toward the target (square-root space). */
export function adaptLuminance(current: number, target: number, dt: number, p: DynamicExposureParams): number {
  const speed = current < target ? p.increaseSpeed : p.decreaseSpeed;
  const k = Math.max(0, 1 - Math.exp(-speed * dt));
  const s = Math.sqrt(current) + (Math.sqrt(target) - Math.sqrt(current)) * k;
  return s * s;
}

/** The tonemapping shader's exposure from the adapted luminance. */
export const exposureFor = (luminance: number, p: DynamicExposureParams) =>
  2 ** p.adjustment * p.middleValue / (0.5 + p.influence * (luminance - 0.5));

/**
 * The client's output: the frame times the exposure, through the method's filmic curve over the white, to sRGB.
 * The last pass of a composer; its `exposure` uniform is set each frame.
 */
export function clientOutputPass(method: ToneMapMethod): ShaderPass {
  const c = TONEMAP_CURVES[method];
  const f = (v: number) => v.toFixed(6);
  return new ShaderPass({
    uniforms: { tDiffuse: { value: null }, exposure: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D tDiffuse; uniform float exposure; varying vec2 vUv;
      vec3 filmic( vec3 x ) {
        return ( x * ( ${f(c.A)} * x + ${f(c.C * c.B)} ) + ${f(c.D * c.E)} ) / ( x * ( ${f(c.A)} * x + ${f(c.B)} ) + ${f(c.D * c.F)} ) - ${f(c.E / c.F)};
      }
      void main() {
        vec3 colour = texture2D( tDiffuse, vUv ).rgb * exposure;
        colour = clamp( max( filmic( 2.0 * colour ), 0.0 ) / filmic( vec3( ${f(WHITE_SCALE)} ) ), 0.0, 1.0 );
        vec3 srgb = mix( colour * 12.92, 1.055 * pow( colour, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), colour ) );
        gl_FragColor = vec4( srgb, 1.0 );
      }`,
  });
}

/**
 * A scene's dynamic exposure: measure() reads a frame's luminances a few times a second (a small copy of the frame
 * read back), step() adapts each frame and gives the exposure.
 */
export class DynamicExposure {
  private readonly params: DynamicExposureParams;
  private readonly small = new THREE.WebGLRenderTarget(128, 72, { type: THREE.HalfFloatType });
  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly pixels = new Uint16Array(128 * 72 * 4);
  private readonly lums = new Float32Array(128 * 72);
  private target: number | null = null;
  private luminance: number | null = null;
  private lastMeasure = 0;
  private lastStep = 0;

  constructor(params: Partial<DynamicExposureParams> = {}) {
    this.params = { ...DYNAMIC_EXPOSURE_DEFAULTS, ...params };
    this.material = new THREE.ShaderMaterial({
      uniforms: { frame: { value: null } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D frame; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(frame, vUv).rgb, 1.0); }",
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
  }

  /** The exposure now (the scene's at L = 0.5 until the first measure). */
  get exposure(): number { return exposureFor(this.luminance ?? 0.5, this.params); }
  /** The adapted luminance, for a look from outside. */
  get adapted(): number | null { return this.luminance; }

  /** Read the frame's luminances, at most every 200 ms. */
  measure(renderer: THREE.WebGLRenderer, frame: THREE.Texture): void {
    const now = performance.now();
    if (now - this.lastMeasure < 200) return;
    this.lastMeasure = now;
    this.material.uniforms["frame"]!.value = frame;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.small);
    renderer.render(this.quad, this.cam);
    renderer.setRenderTarget(was);
    renderer.readRenderTargetPixels(this.small, 0, 0, 128, 72, this.pixels);
    for (let i = 0; i < this.lums.length; i++) {
      const r = THREE.DataUtils.fromHalfFloat(this.pixels[i * 4]!), g = THREE.DataUtils.fromHalfFloat(this.pixels[i * 4 + 1]!), b = THREE.DataUtils.fromHalfFloat(this.pixels[i * 4 + 2]!);
      const l = 0.2125 * r + 0.7154 * g + 0.0721 * b;
      this.lums[i] = Number.isFinite(l) ? l : 0;
    }
    this.target = targetLuminance(brightLuminance(this.lums, this.params), this.params);
    if (this.luminance === null) this.luminance = this.target;
  }

  /** Adapt toward the last measure; the exposure to draw with. */
  step(): number {
    const now = performance.now();
    const dt = this.lastStep ? Math.min(1, (now - this.lastStep) / 1000) : 0;
    this.lastStep = now;
    if (this.target !== null && this.luminance !== null) this.luminance = adaptLuminance(this.luminance, this.target, dt, this.params);
    return this.exposure;
  }

  dispose(): void { this.small.dispose(); this.material.dispose(); this.quad.geometry.dispose(); }
}
