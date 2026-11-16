import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";

export interface FlareClouds {
  meshes: readonly THREE.Mesh[];
  quality: number;
}

// Tr2VolumetricsRenderer's Low, Medium, High and Ultra scale factors in 3698585.
const SCALE = [0.3, 0.5, 0.7, 1] as const;

/** The opacity in slice 3 of EveSceneFogVolumeMap, used by foreground flare queries. */
export class CloudOpacityPass {
  private readonly scene = new THREE.Scene();
  private readonly opacity = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
  });
  private readonly scratch = this.opacity.clone();
  private readonly clearColor = new THREE.Color();
  private readonly blur = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      ...SOFT_DEPTH,
      frame: { value: this.opacity.texture },
      stepUv: { value: new THREE.Vector2() },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D frame;
      uniform vec2 stepUv;
      ${SOFT_DEPTH_GLSL}
      void main() {
        // blurvolumetric.sm_depth uses depth-relative weights for the four
        // neighboring taps. The downsampled depth is the nearest full-size texel.
        float depth = softSceneDepthAt(vUv * softDepthSize);
        float sum = 90.0 * texture2D(frame, vUv).a;
        float weights = 90.0;
        for (int i = -2; i <= 2; i++) {
          if (i == 0) continue;
          vec2 at = vUv + float(i) * stepUv;
          float other = softSceneDepthAt(at * softDepthSize);
          float w = (abs(i) == 1 ? 46.0 : 18.0) * (1.0 - clamp(abs(other - depth) / (min(other, depth) + 1.0), 0.0, 1.0));
          sum += w * texture2D(frame, at).a;
          weights += w;
        }
        gl_FragColor = vec4(0.0, 0.0, 0.0, sum / weights);
      }`,
  });
  private readonly quad = new FullScreenQuad(this.blur);

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, clouds: FlareClouds, width: number, height: number): THREE.Texture {
    const scale = SCALE[clouds.quality - 1] ?? SCALE[0];
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    this.opacity.setSize(w, h);
    this.scratch.setSize(w, h);
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    const u = this.blur.uniforms;
    this.scene.add(...clouds.meshes);
    try {
      renderer.setRenderTarget(this.opacity);
      renderer.setClearColor(0, 0);
      renderer.clear(true, false, false);
      renderer.render(this.scene, camera);
      u.frame!.value = this.opacity.texture;
      u.stepUv!.value.set(1 / w, 0);
      renderer.setRenderTarget(this.scratch);
      this.quad.render(renderer);
      u.frame!.value = this.scratch.texture;
      u.stepUv!.value.set(0, 1 / h);
      renderer.setRenderTarget(this.opacity);
      this.quad.render(renderer);
    } finally {
      this.scene.clear();
      renderer.setClearColor(this.clearColor, alpha);
      renderer.setRenderTarget(previous, face, mip);
    }
    return this.opacity.texture;
  }

  dispose(): void {
    this.opacity.dispose();
    this.scratch.dispose();
    this.blur.dispose();
    this.quad.dispose();
  }
}
