import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";

const VERTEX = "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }";

// 3698585 DenoiseEstimate: sixteen bilinear taps. The half-pixel Y offset is
// reversed when translating Direct3D's top-left pixel origin into WebGL.
const ESTIMATE = `
  uniform sampler2D source;
  void main() {
    vec2 pixel = gl_FragCoord.xy + vec2(0.5, -0.5);
    vec2 texel = 1.0 / vec2(textureSize(source, 0));
    float sum = 0.0;
    for (int y = -3; y <= 3; y += 2) {
      for (int x = -3; x <= 3; x += 2) {
        sum += texture(source, (pixel + vec2(x, y)) * texel).r;
      }
    }
    gl_FragColor = vec4(vec3(sum / 16.0), 1.0);
  }
`;

// Denoise1D at native Tr2Denoiser defaults. Both installed normal-input
// permutations use the same mask, estimate and depth inputs.
const FILTER = `
  ${SOFT_DEPTH_GLSL}
  uniform sampler2D source, estimate;
  uniform ivec2 axis;
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    float sceneDepth = texelFetch(softDepthMap, pixel, 0).r;
    float center = texelFetch(source, pixel, 0).r;
    float radius = 5.0 * min(1.0, 10.5 * texelFetch(estimate, pixel, 0).r);
    if (sceneDepth >= 1.0 || radius <= 0.5) {
      gl_FragColor = vec4(center, sceneDepth, 0.0, 1.0);
      return;
    }
    float depth = softViewDepth(sceneDepth);
    ivec2 size = textureSize(source, 0);
    float sum = center, weights = 1.0;
    for (int i = -5; i <= 5; i++) {
      if (i == 0) continue;
      ivec2 at = pixel + i * axis;
      if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size))) continue;
      float neighbor = texelFetch(softDepthMap, at, 0).r;
      if (neighbor >= 1.0) continue;
      neighbor = softViewDepth(neighbor);
      float dz = abs(neighbor - depth) / max(abs(neighbor), 0.01);
      float distance = float(i) / radius;
      float weight = exp(-distance * distance) * max(0.0, 1.0 - 100.0 * dz);
      sum += texelFetch(source, at, 0).r * weight;
      weights += weight;
    }
    // Preserve the denoiser's byte precision for visibility. The final target
    // carries the unmodified depth in green for receivers' surface match.
    gl_FragColor = vec4(roundEven((sum / weights) * 255.0) / 255.0, sceneDepth, 0.0, 1.0);
  }
`;

function target(filter: THREE.MagnificationTextureFilter): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, { format: THREE.RedFormat, depthBuffer: false, minFilter: filter, magFilter: filter });
}

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false });
}

/** Resolve opaque visibility once per pixel, then filter along both screen axes. */
export class OpaqueShadowMask {
  private readonly raw = target(THREE.LinearFilter);
  private readonly estimate = target(THREE.NearestFilter);
  private readonly horizontal = target(THREE.NearestFilter);
  private readonly vertical = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGFormat, type: THREE.FloatType, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly inverseProjection = { value: new THREE.Matrix4() };
  private readonly resolve: THREE.ShaderMaterial;
  private readonly noise = pass(ESTIMATE, { source: { value: this.raw.texture } });
  private readonly source = { value: this.raw.texture };
  private readonly axis = { value: new THREE.Vector2() };
  private readonly filter = pass(FILTER, { ...SOFT_DEPTH, source: this.source, estimate: { value: this.estimate.texture }, axis: this.axis });
  private readonly quad = new FullScreenQuad();

  constructor(shadowShader: string, uniforms: Record<string, THREE.IUniform>) {
    this.resolve = pass(`
      ${SOFT_DEPTH_GLSL}
      ${shadowShader}
      uniform mat4 inverseProjection;
      void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float depth = texelFetch(softDepthMap, pixel, 0).r;
        float visibility = 1.0;
        if (depth < 1.0) {
          vec2 ndc = gl_FragCoord.xy / softDepthSize * 2.0 - 1.0;
          vec4 ray = inverseProjection * vec4(ndc, -1.0, 1.0);
          visibility = opaqueSpaceShadow(ray.xyz * (-softViewDepth(depth) / ray.z));
        }
        gl_FragColor = vec4(vec3(visibility), 1.0);
      }
    `, { ...SOFT_DEPTH, ...uniforms, inverseProjection: this.inverseProjection });
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, width: number, height: number): THREE.Texture {
    for (const t of [this.raw, this.estimate, this.horizontal, this.vertical]) t.setSize(width, height);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      this.draw(renderer, this.raw, this.resolve);
      this.draw(renderer, this.estimate, this.noise);
      this.source.value = this.raw.texture;
      this.axis.value.set(1, 0);
      this.draw(renderer, this.horizontal, this.filter);
      this.source.value = this.horizontal.texture;
      this.axis.value.set(0, 1);
      this.draw(renderer, this.vertical, this.filter);
    } finally {
      renderer.setRenderTarget(previous, face, mip);
    }
    return this.vertical.texture;
  }

  private draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial): void {
    renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(renderer);
  }

  dispose(): void {
    this.quad.dispose();
    this.resolve.dispose();
    this.noise.dispose();
    this.filter.dispose();
    this.raw.dispose();
    this.estimate.dispose();
    this.horizontal.dispose();
    this.vertical.dispose();
  }
}
