import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";

export interface VolumetricClouds {
  meshes: readonly THREE.Mesh[];
  quality: number;
  scattering?: boolean;
}

// Tr2VolumetricsRenderer's Low, Medium, High and Ultra scale factors in 3698585.
const SCALE = [0.3, 0.5, 0.7, 1] as const;

// EveSpaceScene's forward view-depth boundaries for EveSceneFogVolumeMap in 3698585, in metres.
export const CLOUD_FOG = {
  cloudFogMap: { value: null as THREE.Texture | null },
  cloudFogEnabled: { value: false },
  cloudFogDepths: { value: new THREE.Vector4(1_000, 10_000, 100_000, 1_000_000) },
};

export const CLOUD_FOG_SCATTERING = {
  cloudFogScatteringMap: { value: null as THREE.Texture | null },
  cloudFogScatteringEnabled: { value: false },
};

// Four radiance and opacity slices occupy the quadrants of one sampler.
export const CLOUD_FOG_SCATTERING_GLSL = `uniform sampler2D cloudFogScatteringMap;
uniform bool cloudFogScatteringEnabled;
uniform vec4 cloudFogDepths;
uniform vec2 softDepthSize;
vec4 cloudFogSlice(vec2 uv, vec2 tile) {
  return textureLod(cloudFogScatteringMap, uv + 0.5 * tile, 0.0);
}
vec4 cloudFogScattering(float depth) {
  if (!cloudFogScatteringEnabled) return vec4(0.0);
  vec2 inset = 1.0 / vec2(textureSize(cloudFogScatteringMap, 0));
  vec2 uv = 0.5 * clamp(gl_FragCoord.xy / softDepthSize, inset, 1.0 - inset);
  vec4 cuts = cloudFogDepths;
  if (depth <= cuts.x) return cloudFogSlice(uv, vec2(0.0)) * clamp(depth / cuts.x, 0.0, 1.0);
  if (depth <= cuts.y) return mix(cloudFogSlice(uv, vec2(0.0)), cloudFogSlice(uv, vec2(1.0, 0.0)), (depth - cuts.x) / (cuts.y - cuts.x));
  if (depth <= cuts.z) return mix(cloudFogSlice(uv, vec2(1.0, 0.0)), cloudFogSlice(uv, vec2(0.0, 1.0)), (depth - cuts.y) / (cuts.z - cuts.y));
  return mix(cloudFogSlice(uv, vec2(0.0, 1.0)), cloudFogSlice(uv, vec2(1.0)), clamp((depth - cuts.z) / (cuts.w - cuts.z), 0.0, 1.0));
}`;

export const CLOUD_FOG_GLSL = `uniform sampler2D cloudFogMap;
uniform bool cloudFogEnabled;
uniform vec4 cloudFogDepths;
float cloudFogTransmission(float depth) {
  if (!cloudFogEnabled) return 1.0;
  vec4 opacity = textureLod(cloudFogMap, gl_FragCoord.xy / softDepthSize, 0.0);
  vec4 cuts = cloudFogDepths;
  if (depth <= cuts.x) return 1.0 - opacity.r * clamp(depth / cuts.x, 0.0, 1.0);
  if (depth <= cuts.y) return 1.0 - mix(opacity.r, opacity.g, (depth - cuts.x) / (cuts.y - cuts.x));
  if (depth <= cuts.z) return 1.0 - mix(opacity.g, opacity.b, (depth - cuts.y) / (cuts.z - cuts.y));
  return 1.0 - mix(opacity.b, opacity.a, clamp((depth - cuts.z) / (cuts.w - cuts.z), 0.0, 1.0));
}`;

/** Four accumulated opacity slices in RGBA. The last slice also serves foreground flares. */
export class CloudOpacityPass {
  private readonly scene = new THREE.Scene();
  private readonly opacity = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
  });
  private readonly scratch = this.opacity.clone();
  private readonly slices = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, count: 4 });
  private readonly farSlice = this.opacity.clone();
  private readonly atlas = this.opacity.clone();
  private readonly pack = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      slice0: { value: this.slices.textures[0] }, slice1: { value: this.slices.textures[1] },
      slice2: { value: this.slices.textures[2] }, slice3: { value: this.farSlice.texture },
      atlas: { value: false },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `varying vec2 vUv;
      uniform sampler2D slice0, slice1, slice2, slice3;
      uniform bool atlas;
      void main() {
        if (!atlas) {
          gl_FragColor = vec4(texture2D(slice0, vUv).a, texture2D(slice1, vUv).a,
            texture2D(slice2, vUv).a, texture2D(slice3, vUv).a);
          return;
        }
        vec2 uv = fract(vUv * 2.0);
        if (vUv.y < 0.5) gl_FragColor = vUv.x < 0.5 ? texture2D(slice0, uv) : texture2D(slice1, uv);
        else gl_FragColor = vUv.x < 0.5 ? texture2D(slice2, uv) : texture2D(slice3, uv);
      }`,
  });
  private readonly packQuad = new FullScreenQuad(this.pack);
  private readonly clearColor = new THREE.Color();
  private readonly blur = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      ...SOFT_DEPTH,
      frame: { value: this.opacity.texture },
      stepUv: { value: new THREE.Vector2() },
      blurColor: { value: false },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D frame;
      uniform vec2 stepUv;
      uniform bool blurColor;
      ${SOFT_DEPTH_GLSL}
      void main() {
        // blurvolumetric.sm_depth uses depth-relative weights for the four
        // neighboring taps. The downsampled depth is the nearest full-size texel.
        float depth = softSceneDepthAt(vUv * softDepthSize);
        vec4 center = texture2D(frame, vUv);
        vec4 sum = 90.0 * center;
        float weights = 90.0;
        for (int i = -2; i <= 2; i++) {
          if (i == 0) continue;
          vec2 at = vUv + float(i) * stepUv;
          float other = softSceneDepthAt(at * softDepthSize);
          float w = (abs(i) == 1 ? 46.0 : 18.0) * (1.0 - clamp(abs(other - depth) / (min(other, depth) + 1.0), 0.0, 1.0));
          sum += w * texture2D(frame, at);
          weights += w;
        }
        // The native blur only filters slice 3.
        vec4 filtered = sum / weights;
        gl_FragColor = blurColor ? filtered : vec4(center.rgb, filtered.a);
      }`,
  });
  private readonly quad = new FullScreenQuad(this.blur);

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, clouds: VolumetricClouds, width: number, height: number): { opacity: THREE.Texture; scattering: THREE.Texture | null } {
    const scale = SCALE[clouds.quality - 1] ?? SCALE[0];
    const limit = Math.floor(renderer.capabilities.maxTextureSize / (clouds.scattering ? 2 : 1));
    const w = Math.min(limit, Math.max(1, Math.floor(width * scale))), h = Math.min(limit, Math.max(1, Math.floor(height * scale)));
    this.opacity.setSize(w, h);
    this.scratch.setSize(w, h);
    if (clouds.scattering) {
      this.slices.setSize(w, h);
      this.farSlice.setSize(w, h);
      this.atlas.setSize(w * 2, h * 2);
    }
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    const u = this.blur.uniforms;
    this.scene.add(...clouds.meshes);
    try {
      renderer.setRenderTarget(clouds.scattering ? this.slices : this.opacity);
      renderer.setClearColor(0, 0);
      renderer.clear(true, false, false);
      renderer.render(this.scene, camera);
      u.blurColor!.value = !!clouds.scattering;
      u.frame!.value = clouds.scattering ? this.slices.textures[3] : this.opacity.texture;
      u.stepUv!.value.set(1 / w, 0);
      renderer.setRenderTarget(this.scratch);
      this.quad.render(renderer);
      u.frame!.value = this.scratch.texture;
      u.stepUv!.value.set(0, 1 / h);
      renderer.setRenderTarget(clouds.scattering ? this.farSlice : this.opacity);
      this.quad.render(renderer);
      if (clouds.scattering) {
        this.pack.uniforms.atlas!.value = false;
        renderer.setRenderTarget(this.opacity);
        this.packQuad.render(renderer);
        this.pack.uniforms.atlas!.value = true;
        renderer.setRenderTarget(this.atlas);
        this.packQuad.render(renderer);
      }
    } finally {
      this.scene.clear();
      renderer.setClearColor(this.clearColor, alpha);
      renderer.setRenderTarget(previous, face, mip);
    }
    return { opacity: this.opacity.texture, scattering: clouds.scattering ? this.atlas.texture : null };
  }

  dispose(): void {
    this.opacity.dispose();
    this.scratch.dispose();
    this.slices.dispose();
    this.farSlice.dispose();
    this.atlas.dispose();
    this.blur.dispose();
    this.quad.dispose();
    this.pack.dispose();
    this.packQuad.dispose();
  }
}
