// The scene's depth behind its transparent and additive draws, for the effects that fade where they meet it: an
// ubershader.fx area with UBER_DEPTH_ON (its sm_hi permutations disassembled, client 3396210) reads the scene's
// DepthMap at its pixel and fades out over half its z scale in front of what is there.
//
// The client has that depth from its opaque pass. Here it is drawn first, depth only, into a texture: what three.js
// draws as opaque (a mesh of material neither transparent, nor blended, nor without depth writes or tests) with
// every other object left out; and only in a frame that holds such an area (any material whose userData.softDepth
// is set, visible). Its depth is the renderer's: logarithmic in space (log2(1 + w) / log2(far + 1), three.js's
// log-depth buffer), plain in the hangar.

import * as THREE from "three";

/** The uniforms a soft area reads (shared by every such material). */
export const SOFT_DEPTH = {
  softDepthMap: { value: null as THREE.Texture | null },
  /** 1 in a frame whose scene depth was drawn, else 0 (the area is then not faded). */
  softDepthOn: { value: 0 },
  softDepthSize: { value: new THREE.Vector2(1, 1) },
  /** log2(far + 1) under a log-depth buffer, else 0. */
  softDepthLogFar: { value: 0 },
  softDepthNearFar: { value: new THREE.Vector2(1, 1e6) },
};

/**
 * The GLSL that turns the scene depth at this pixel (softSceneDepth), or at a pixel position (softSceneDepthAt), into a
 * view distance (in metres, ahead of the eye).
 */
export const SOFT_DEPTH_GLSL = `uniform sampler2D softDepthMap; uniform float softDepthOn; uniform vec2 softDepthSize;
uniform float softDepthLogFar; uniform vec2 softDepthNearFar;
float softSceneDepthAt(vec2 frag) {
  float d = texture2D(softDepthMap, frag / softDepthSize).x;
  if (softDepthLogFar > 0.0) return exp2(d * softDepthLogFar) - 1.0;
  float n = softDepthNearFar.x, f = softDepthNearFar.y;
  return (n * f) / (f - d * (f - n));
}
float softSceneDepth() { return softSceneDepthAt(gl_FragCoord.xy); }`;

const opaque = (m: THREE.Material) => !m.transparent && m.depthWrite && m.depthTest && m.blending === THREE.NormalBlending && m.visible;

export class SoftDepthPass {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly blank = new THREE.MeshBasicMaterial({ colorWrite: false });

  /** Draws the scene's opaque depth (where a soft area is in view) and points the shared uniforms at it. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    const hidden: THREE.Object3D[] = [];
    let wanted = false;
    scene.traverseVisible((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      if (mats.some((m) => m.userData.softDepth)) wanted = true;
      if (!(o as THREE.Mesh).isMesh || !mats.every(opaque)) hidden.push(o);
    });
    SOFT_DEPTH.softDepthOn.value = 0;
    if (!wanted) return;
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), { depthBuffer: true });
      this.target.depthTexture = new THREE.DepthTexture(Math.max(1, width), Math.max(1, height), THREE.FloatType);
    }
    const background = scene.background, override = scene.overrideMaterial, to = renderer.getRenderTarget();
    for (const o of hidden) o.visible = false;
    scene.background = null;
    scene.overrideMaterial = this.blank;
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      for (const o of hidden) o.visible = true;
      scene.background = background;
      scene.overrideMaterial = override;
      renderer.setRenderTarget(to);
    }
    const cam = camera as THREE.PerspectiveCamera;
    SOFT_DEPTH.softDepthMap.value = this.target.depthTexture;
    SOFT_DEPTH.softDepthSize.value.set(this.target.width, this.target.height);
    SOFT_DEPTH.softDepthLogFar.value = renderer.capabilities.logarithmicDepthBuffer ? Math.log2(cam.far + 1) : 0;
    SOFT_DEPTH.softDepthNearFar.value.set(cam.near, cam.far);
    SOFT_DEPTH.softDepthOn.value = 1;
  }

  dispose(): void {
    this.target?.dispose();
    this.blank.dispose();
  }
}
