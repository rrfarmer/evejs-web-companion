// The client's dynamic exposure and tone map (Tr2PostProcess2's Tr2PPDynamicExposureEffect and
// Tr2PPTonemappingEffect), as its compute and pixel shaders do them (graphics/effect.dx11/managed/space/postprocess/
// createhistograms, measureexposure, exposuretotexture and tonemapping, disassembled, client 3396210):
// - createhistograms: each pixel's luminance (Rec. 709) goes into one of 64 bins spread evenly over ln(minLuminance)
//   to ln(maxLuminance), clamped at both ends;
// - measureexposure: the luminance at the minBrightness and at the maxBrightness fraction of the pixels (a bin's own
//   count interpolated within it), averaged; the exposure 0.5 / that is clamped to e^minExposure..e^maxExposure, and
//   the luminance it stands for is approached in square-root space at increaseSpeed or decreaseSpeed per second
//   (1 - e^(-speed * dt) of the way each frame);
// - exposuretotexture: the exposure is middleValue / ((1 - middleValue) * that luminance);
// - tonemapping (method 1): the exposed colour, doubled, through the parametric filmic curve
//   (x(Ax + CB) + DE) / (x(Ax + B) + DF) - E/F, divided by the curve at whiteScale.
// The defaults are the client's own (the effects constructed in the client's Python, trinity build 3396210); a scene
// overrides some (the hangar scenes give middleValue 0.45). The effect's adjustment is not applied yet: where it
// enters is not in these shaders.

import * as THREE from "three";

export interface DynamicExposureParams {
  middleValue: number; minLuminance: number; maxLuminance: number; minBrightness: number; maxBrightness: number;
  increaseSpeed: number; decreaseSpeed: number; minExposure: number; maxExposure: number; adjustment: number;
}
export const DYNAMIC_EXPOSURE_DEFAULTS: DynamicExposureParams = {
  middleValue: 0.55, minLuminance: 0.4649, maxLuminance: 10, minBrightness: 0.9, maxBrightness: 0.98,
  increaseSpeed: 2, decreaseSpeed: 1.5, minExposure: -3.7, maxExposure: 10, adjustment: 0,
};
/** Tr2PPTonemappingEffect's defaults: the curve's shoulder, linear part, toe, and the white it is scaled to. */
const TONEMAP = { shoulderStrength: 0.125, linearStrength: 0.25, linearAngle: 0.1, toeStrength: 0.15, toeNumerator: 0.021, toeDenominator: 0.3, whiteScale: 2.5 };

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

export const exposureFor = (luminance: number, p: DynamicExposureParams) => p.middleValue / ((1 - p.middleValue) * luminance);

let toneMapInstalled = false;
/** three's custom tone mapping made the client's curve (renderer.toneMapping = CustomToneMapping to use it). */
export function installClientToneMapping(): void {
  if (toneMapInstalled) return;
  toneMapInstalled = true;
  const t = TONEMAP;
  const f = (v: number) => v.toFixed(6);
  const curve = `vec3 eveFilmic( vec3 x ) {
    return ( x * ( ${f(t.shoulderStrength)} * x + ${f(t.linearAngle * t.linearStrength)} ) + ${f(t.toeStrength * t.toeNumerator)} )
      / ( x * ( ${f(t.shoulderStrength)} * x + ${f(t.linearStrength)} ) + ${f(t.toeStrength * t.toeDenominator)} ) - ${f(t.toeNumerator / t.toeDenominator)};
  }
  vec3 CustomToneMapping( vec3 color ) {
    return max( eveFilmic( 2.0 * toneMappingExposure * color ), 0.0 ) / eveFilmic( vec3( ${f(t.whiteScale)} ) );
  }`;
  const stub = "vec3 CustomToneMapping( vec3 color ) { return color; }";
  const chunks = THREE.ShaderChunk as Record<string, string>;
  if (!chunks["tonemapping_pars_fragment"]!.includes(stub)) { console.warn("exposure: three's CustomToneMapping stub not found"); return; }
  chunks["tonemapping_pars_fragment"] = chunks["tonemapping_pars_fragment"]!.replace(stub, curve);
}

/**
 * A scene's dynamic exposure: measure() reads a frame's luminances a few times a second (a small copy of the frame
 * read back), step() adapts each frame and sets the renderer's exposure.
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

  /** The exposure now (1 until the first measure). */
  get exposure(): number { return this.luminance === null ? 1 : exposureFor(this.luminance, this.params); }

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

  /** Adapt toward the last measure and set the renderer's exposure. */
  step(renderer: THREE.WebGLRenderer): void {
    const now = performance.now();
    const dt = this.lastStep ? Math.min(1, (now - this.lastStep) / 1000) : 0;
    this.lastStep = now;
    if (this.target !== null && this.luminance !== null) this.luminance = adaptLuminance(this.luminance, this.target, dt, this.params);
    renderer.toneMappingExposure = this.exposure;
  }

  dispose(): void { this.small.dispose(); this.material.dispose(); this.quad.geometry.dispose(); }
}
