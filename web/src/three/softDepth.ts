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
import { gfx } from "../play/gfxSettings.ts";
import { eveNormalMap } from "./normalMaps.ts";

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

let depthRenderer: THREE.WebGLRenderer | null = null;
let depthScene: THREE.Scene | null = null;

/** Whether the shared opaque depth belongs to the view about to draw. */
export function hasSoftDepth(renderer: THREE.WebGLRenderer, scene: THREE.Scene): boolean {
  return renderer === depthRenderer && scene === depthScene && SOFT_DEPTH.softDepthOn.value > 0;
}

/** Use the opaque-depth shader profile at High when this view has its own depth texture. */
export function useHighSoftDepth(mat: THREE.ShaderMaterial, uniformName: string): void {
  const profile = { value: false };
  Object.assign(mat.uniforms, SOFT_DEPTH, { [uniformName]: profile });
  Object.defineProperty(mat.userData, "softDepth", { enumerable: true, get: () => gfx().shaderQuality === 3 });
  const before = mat.onBeforeRender;
  mat.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    const enabled = gfx().shaderQuality === 3 && hasSoftDepth(renderer, scene as THREE.Scene);
    if (profile.value !== enabled) {
      profile.value = enabled;
      mat.uniformsNeedUpdate = true;
    }
    mat.depthTest = !enabled;
  };
}

/** Decode depth into the distance ahead of the camera, independently of its texture. */
export const SOFT_VIEW_DEPTH_GLSL = `uniform float softDepthLogFar; uniform vec2 softDepthNearFar;
float softViewDepth(float d) {
  if (softDepthLogFar > 0.0) return exp2(d * softDepthLogFar) - 1.0;
  float n = softDepthNearFar.x, f = softDepthNearFar.y;
  return (n * f) / (f - d * (f - n));
}`;

/** The depth behind an effect at this pixel or at a supplied fragment coordinate. */
export const SOFT_DEPTH_GLSL = `uniform sampler2D softDepthMap; uniform float softDepthOn; uniform vec2 softDepthSize;
${SOFT_VIEW_DEPTH_GLSL}
float softSceneDepthAt(vec2 frag) {
  return softViewDepth(texture2D(softDepthMap, frag / softDepthSize).x);
}
float softSceneDepth() { return softSceneDepthAt(gl_FragCoord.xy); }`;

const opaque = (m: THREE.Material) => !m.transparent && m.depthWrite && m.depthTest && m.blending === THREE.NormalBlending && m.visible;
interface OpaqueSurface {
  material: THREE.Material;
  prepare?: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, object: THREE.Mesh) => void;
}
const opaqueSurfaces = new WeakMap<THREE.Material, OpaqueSurface>();
const opaqueFrameTimes = new WeakMap<THREE.WebGLRenderer, number>();

/** Give animated opaque surfaces the same time in every pass of the composed view. */
export function withOpaqueFrame(renderer: THREE.WebGLRenderer, render: () => void): void {
  const previous = opaqueFrameTimes.get(renderer);
  opaqueFrameTimes.set(renderer, performance.now() / 1000);
  try {
    render();
  } finally {
    if (previous === undefined) opaqueFrameTimes.delete(renderer);
    else opaqueFrameTimes.set(renderer, previous);
  }
}

export function opaqueFrameTime(renderer: THREE.WebGLRenderer): number {
  return opaqueFrameTimes.get(renderer) ?? performance.now() / 1000;
}

export function opaqueSurfaceOf(material: THREE.Material): OpaqueSurface | undefined {
  return opaqueSurfaces.get(material);
}

/** Keep a custom opaque surface's vertex transform and alpha test in the depth and normals passes. */
export function setOpaqueSurfacePass(material: THREE.Material, surface: THREE.Material): void {
  surface.allowOverride = false;
  opaqueSurfaces.set(material, { material: surface });
  material.addEventListener("dispose", () => surface.dispose());
}

export class SoftDepthPass {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly blank = new THREE.MeshBasicMaterial({ colorWrite: false });
  private readonly normalMaterials = new WeakMap<THREE.Material, THREE.MeshNormalMaterial>();
  private readonly disposeNormals = new Set<() => void>();

  private normalsFor(material: THREE.Material): THREE.MeshNormalMaterial {
    const cached = this.normalMaterials.get(material);
    if (cached) return cached;
    const source = material as THREE.MeshStandardMaterial;
    const normal = new THREE.MeshNormalMaterial({
      side: source.side, flatShading: source.flatShading ?? false,
      normalMap: source.normalMap ?? null, normalMapType: source.normalMapType ?? THREE.TangentSpaceNormalMap,
      displacementMap: source.displacementMap ?? null, displacementScale: source.displacementScale ?? 1,
      displacementBias: source.displacementBias ?? 0,
    });
    if (source.normalScale) normal.normalScale.copy(source.normalScale);
    const flipGreen = material.userData.eveNormalFlipGreen as boolean | undefined;
    normal.onBeforeCompile = (shader) => {
      // The packed normal chunk uses saturate from common.
      if (!shader.fragmentShader.includes("#include <common>")) shader.fragmentShader = `#include <common>\n${shader.fragmentShader}`;
      if (flipGreen !== undefined) {
        shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
          eveNormalMap(THREE.ShaderChunk.normal_fragment_maps, flipGreen));
      }
    };
    normal.customProgramCacheKey = () => `space-depth-normal:${flipGreen}`;
    this.normalMaterials.set(material, normal);
    const dispose = () => {
      normal.dispose();
      this.disposeNormals.delete(dispose);
      this.normalMaterials.delete(material);
      material.removeEventListener("dispose", dispose);
    };
    this.disposeNormals.add(dispose);
    material.addEventListener("dispose", dispose);
    return normal;
  }

  /** Draws opaque depth for visible soft areas or an active depth-based postprocess. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number,
    forceOpaque = false, normals = false): THREE.Texture | null {
    const target = this.draw(renderer, scene, camera, width, height, forceOpaque || normals, undefined, normals);
    depthRenderer = target ? renderer : null;
    depthScene = target ? scene : null;
    SOFT_DEPTH.softDepthOn.value = target ? 1 : 0;
    if (!target) return null;
    const cam = camera as THREE.PerspectiveCamera;
    SOFT_DEPTH.softDepthMap.value = target.depthTexture;
    SOFT_DEPTH.softDepthSize.value.set(target.width, target.height);
    SOFT_DEPTH.softDepthLogFar.value = renderer.capabilities.logarithmicDepthBuffer ? Math.log2(cam.far + 1) : 0;
    SOFT_DEPTH.softDepthNearFar.value.set(cam.near, cam.far);
    return normals ? target.texture : null;
  }

  /** Draw a subset for an occlusion query without changing the frame's shared depth. */
  capture(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number,
    accepts: (mesh: THREE.Mesh) => boolean,
  ): THREE.DepthTexture | null {
    return this.draw(renderer, scene, camera, width, height, true, accepts)?.depthTexture ?? null;
  }

  private draw(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, forceOpaque: boolean,
    accepts?: (mesh: THREE.Mesh) => boolean, normals = false,
  ): THREE.WebGLRenderTarget | null {
    const hidden: THREE.Object3D[] = [];
    const sources = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    let wanted = forceOpaque;
    scene.traverseVisible((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      if (mats.some((m) => m.userData.softDepth)) wanted = true;
      if (!(o as THREE.Mesh).isMesh || !mats.every(opaque) || (accepts && !accepts(o as THREE.Mesh))) hidden.push(o);
      else if (normals || mats.some((m) => opaqueSurfaces.has(m))) {
        const mesh = o as THREE.Mesh;
        sources.set(mesh, mat);
        // Instance data must be ready before Three.js builds the draw list and uploads attributes.
        if (!accepts) for (const material of mats) opaqueSurfaces.get(material)?.prepare?.(renderer, scene, camera, mesh);
      }
    });
    if (!wanted) return null;
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), { depthBuffer: true });
      this.target.depthTexture = new THREE.DepthTexture(Math.max(1, width), Math.max(1, height), THREE.FloatType);
    }
    const background = scene.background, override = scene.overrideMaterial, to = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    for (const o of hidden) o.visible = false;
    scene.background = null;
    scene.overrideMaterial = normals ? null : this.blank;
    try {
      const surfaceFor = (m: THREE.Material) => opaqueSurfaces.get(m)?.material ?? (normals ? this.normalsFor(m) : this.blank);
      for (const [mesh, material] of sources) {
        mesh.material = Array.isArray(material) ? material.map(surfaceFor) : surfaceFor(material);
      }
      renderer.setRenderTarget(this.target);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      for (const [mesh, material] of sources) mesh.material = material;
      for (const o of hidden) o.visible = true;
      scene.background = background;
      scene.overrideMaterial = override;
      renderer.setRenderTarget(to, face, mip);
    }
    return this.target;
  }

  dispose(): void {
    if (SOFT_DEPTH.softDepthMap.value === this.target?.depthTexture) {
      depthRenderer = depthScene = null;
      SOFT_DEPTH.softDepthOn.value = 0;
      SOFT_DEPTH.softDepthMap.value = null;
    }
    this.target?.dispose();
    this.blank.dispose();
    for (const dispose of this.disposeNormals) dispose();
  }
}
