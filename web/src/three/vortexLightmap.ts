// basiccloud.sm_hi, GenerateLightmap. One draw writes a Z slice of the
// two transmission channels the cloud shader reads.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const MAX_EDGE = 64;
const MAX_RAY_STEPS = 512;
const SLICES_PER_FRAME = 4;
const NATIVE_SCALE = 0.5; // EveChildCloud2.lightmapSizeScale in build 3698585.

const VERTEX = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAGMENT = `
  uniform highp sampler3D densityMap;
  uniform vec3 inverseSize, nativeInverseSize, lightDirection;
  uniform int slice;
  uniform float densityScale;

  float randomOffset(uint seed, inout uint state) {
    uint key = state * 0xe336beb9u ^ seed * 0x5f356495u;
    state = key * (key ^ (key >> 15u));
    return float(state % 100u) * 0.01 - 0.5;
  }

  vec3 jitter(uint seed, inout uint state) {
    float x = randomOffset(seed, state);
    float y = randomOffset(seed, state);
    float z = randomOffset(seed, state);
    return vec3(x, y, z);
  }

  float transmittance(vec3 position, vec3 direction, float limit, float stepSize) {
    vec3 reciprocal = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), direction)) / max(abs(direction), 1e-6);
    vec3 exitAt = max((-0.5 - position) * reciprocal, (0.5 - position) * reciprocal);
    float distance = min(min(exitAt.x, exitAt.y), min(exitAt.z, limit));
    float depth = 0.0;
    for (int i = 0; i < ${MAX_RAY_STEPS}; i++) {
      if (distance <= stepSize || depth >= 0.99) break;
      depth += texture(densityMap, position + direction * distance + 0.5).r * densityScale * stepSize;
      distance -= stepSize;
    }
    return exp(-clamp(depth, 0.0, 1.0));
  }

  void main() {
    uvec3 cell = uvec3(uvec2(gl_FragCoord.xy), uint(slice));
    vec3 position = vec3(cell) * inverseSize - 0.5;
    float stepSize = 2.0 * min(nativeInverseSize.x, min(nativeInverseSize.y, nativeInverseSize.z));
    uint seed = cell.x * 100u + cell.y * 10u + cell.z;
    uint state = cell.x;
    float direct = 0.0, local = 0.0;
    for (int i = 0; i < 6; i++) {
      vec3 origin = position + jitter(seed, state) * (2.0 * nativeInverseSize);
      direct += transmittance(origin, lightDirection, 10000.0, stepSize);
    }
    for (int i = 0; i < 10; i++) {
      vec3 origin = position + jitter(seed, state) * nativeInverseSize;
      vec3 direction = jitter(seed, state);
      local += transmittance(origin, normalize(direction + vec3(1e-9)), 0.1, stepSize);
    }
    gl_FragColor = vec4(direct / 6.0, local / 10.0, direct / 6.0, direct / 6.0);
  }
`;

/** Rebuild only for a new volume or light direction. Each frame submits a bounded set of slices. */
export class VortexLightmap {
  private target: THREE.WebGL3DRenderTarget | null = null;
  private source: THREE.Data3DTexture | null = null;
  private layer = 0;
  private readonly uniforms = {
    densityMap: { value: null as THREE.Data3DTexture | null },
    inverseSize: { value: new THREE.Vector3() },
    nativeInverseSize: { value: new THREE.Vector3() },
    lightDirection: { value: new THREE.Vector3() },
    slice: { value: 0 },
    densityScale: { value: 0 },
  };
  private readonly material = new THREE.ShaderMaterial({
    uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, depthTest: false, depthWrite: false,
  });
  private readonly quad = new FullScreenQuad(this.material);

  update(renderer: THREE.WebGLRenderer, volume: THREE.Data3DTexture, direction: THREE.Vector3, density: number): THREE.Data3DTexture | null {
    if (this.source !== volume) {
      this.source = volume;
      const { width, height, depth } = volume.image;
      // WebGL draws slices independently. Bound the grid size while preserving the native voxel aspect ratio.
      const native = new THREE.Vector3(width, height, depth).multiplyScalar(NATIVE_SCALE).floor().clampScalar(1, Infinity);
      const scale = Math.min(1, MAX_EDGE / Math.max(native.x, native.y, native.z));
      const grid = native.clone().multiplyScalar(scale).floor().clampScalar(1, Infinity);
      const { x: nx, y: ny, z: nz } = grid;
      this.target?.dispose();
      this.target = new THREE.WebGL3DRenderTarget(nx, ny, nz, {
        depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGFormat, type: THREE.UnsignedByteType,
      });
      this.uniforms.densityMap.value = volume;
      this.uniforms.inverseSize.value.set(1 / nx, 1 / ny, 1 / nz);
      this.uniforms.nativeInverseSize.value.set(1 / native.x, 1 / native.y, 1 / native.z);
      this.layer = 0;
    }
    const target = this.target!;
    if (direction.dot(this.uniforms.lightDirection.value) < 0.999999 || density !== this.uniforms.densityScale.value) {
      this.uniforms.lightDirection.value.copy(direction);
      this.uniforms.densityScale.value = density;
      this.layer = 0;
    }
    if (this.layer < target.depth) {
      const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      try {
        const limit = Math.min(this.layer + SLICES_PER_FRAME, target.depth);
        for (; this.layer < limit; this.layer++) {
          this.uniforms.slice.value = this.layer;
          renderer.setRenderTarget(target, this.layer);
          this.quad.render(renderer);
        }
      } finally {
        renderer.setRenderTarget(previous, face, mip);
      }
    }
    return this.layer === target.depth ? target.texture : null;
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
