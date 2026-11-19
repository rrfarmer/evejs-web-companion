import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { getGpuParticleSystem } from "./gpuParticles.ts";

function target(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
}

/**
 * In build 3698585 the particle cards blend their encoded RGB over the encoded
 * scene before postprocessing. Accumulate their premultiplied color and alpha
 * separately so the browser can perform that blend and return a linear frame.
 */
export class GpuParticlePass {
  private readonly scene = new THREE.Scene();
  private readonly particles = target();
  private readonly composed = target();
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, particles: { value: this.particles.texture } },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D source, particles;
      varying vec2 vUv;
      void main() {
        vec4 base = texture2D(source, vUv), overlay = texture2D(particles, vUv);
        vec3 encoded = sRGBTransferOETF(vec4(max(base.rgb, 0.0), 1.0)).rgb;
        vec3 color = sRGBTransferEOTF(vec4(overlay.rgb + encoded * (1.0 - overlay.a), 1.0)).rgb;
        gl_FragColor = vec4(any(notEqual(overlay, vec4(0.0))) ? color : base.rgb, base.a);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  private readonly quad = new FullScreenQuad(this.material);
  private readonly clearColor = new THREE.Color();

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, frame: THREE.WebGLRenderTarget): THREE.Texture {
    const system = getGpuParticleSystem(scene);
    if (!system?.mesh.visible) return frame.texture;
    const { mesh } = system;
    const { width, height, depthTexture } = frame;
    system.prepareDraw(camera, width, height);
    if (!mesh.geometry.instanceCount) return frame.texture;

    this.particles.setSize(width, height);
    this.composed.setSize(width, height);
    const parent = mesh.parent;
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    const uniforms = mesh.material.uniforms;
    try {
      this.scene.add(mesh);
      uniforms.sceneDepth!.value = depthTexture;
      uniforms.encodedBlend!.value = true;
      renderer.setRenderTarget(this.particles);
      renderer.setClearColor(0, 0);
      renderer.clear(true, false, false);
      renderer.render(this.scene, camera);
      this.material.uniforms.source!.value = frame.texture;
      renderer.setRenderTarget(this.composed);
      this.quad.render(renderer);
    } finally {
      this.scene.remove(mesh);
      parent?.add(mesh);
      uniforms.encodedBlend!.value = false;
      uniforms.sceneDepth!.value = null;
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.setRenderTarget(previous, face, mip);
    }
    return this.composed.texture;
  }

  dispose(): void {
    this.particles.dispose();
    this.composed.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
