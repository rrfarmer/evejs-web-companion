// The space scene's distortion, as the client draws it (EveSpaceScene::RenderDistortionBatches and
// EveSpaceSceneRenderDriver::ApplyDistortion, Trinity source; the shaders' records read with fxres.py, client 3396210):
// - after the scene's opaque draws, its distortion batches are drawn into a map of their own (B8G8R8A8, cleared to
//   (0.5, 0.5, 0, 0)), tested against the scene's depth, not writing it: each surface adds its screen offset / 64
//   (MAX_DISTORTION_OFFSET) to red and green about 0.5, 1/256 to blue (a count) and its DistortionFactors.y to alpha.
//   fxdistortionv5.fx does it in two passes, the positive part added (ONE/ONE ADD) and the negative part taken away
//   (ONE/ONE REVSUBTRACT), as a unorm target holds no sign;
// - the frame is then copied and drawn again through PostProcess/Distortion.fx, before the post-process: at each
//   pixel the offset o = (map.rg - 0.5) x 2 x 64 pixels and c = 1 - map.a / (map.b x 256); red read at uv + o, green at
//   uv + o (c / 2 + 1/2), blue at uv + o c - where the map at uv + o counts a surface (blue >= 1/256), else the pixel
//   as it was.
// Here the map is a half-float target holding the signed sums (cleared to nought), clamped as the unorm map would
// hold them when read. Its objects are kept on a layer of their own, out of the scene's own draw.

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { logDepth } from "./logDepth.ts";

/** The layer a distortion surface is on (and only it): the scene's draw leaves it out, the distortion pass draws it. */
export const DISTORTION_LAYER = 5;

const clock = { get value() { return performance.now() / 1000; } };

/**
 * A hull area drawn with fx/fxdistortionv5.fx (its record 0, technique Main): n = DistortionMap at Layer1's uv
 * (uv x Layer1Transform.xy + .zw + Layer1Scroll.xy x time + .zw), x 2 - 1, its z x DistortionFactors.w, normalised,
 * through the tangent frame, normalised; its view-space x and y times Layer2Map.r at Layer2's uv, times the fresnel
 * (as ubershader.fx's, of the mesh normal), times DistortionFactors.x, over max(1, eye distance / (DistortionFactors.z
 * x the world transform's largest axis)) (1 where that is nought), times the activation (1): the offset, away from the
 * normal on screen. The batch draws both faces (no cull of its own; the additive preset's none). Defaults from the
 * file: DistortionFactors (1, 1, 10000, 1), FresnelFactors (1, 1, 0, 0), the transforms and scrolls (1, 1, 0, 0).
 */
export function distortionMaterial(params: Record<string, number[] | null | undefined>, maps: { distortion?: THREE.Texture; layer2?: THREE.Texture }): THREE.ShaderMaterial | null {
  if (!maps.distortion || !maps.layer2) return null;
  const v4 = (a: number[] | null | undefined, d: number[]) => new THREE.Vector4(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2], a?.[3] ?? d[3]);
  for (const t of [maps.distortion, maps.layer2]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      t1: { value: v4(params.Layer1Transform, [1, 1, 0, 0]) }, t2: { value: v4(params.Layer2Transform, [1, 1, 0, 0]) },
      s1: { value: v4(params.Layer1Scroll, [1, 1, 0, 0]) }, s2: { value: v4(params.Layer2Scroll, [1, 1, 0, 0]) },
      factors: { value: v4(params.DistortionFactors, [1, 1, 10000, 1]) },
      fresnel: { value: v4(params.FresnelFactors, [1, 1, 0, 0]) },
      time: clock,
      distortionMap: { value: maps.distortion }, layer2Map: { value: maps.layer2 },
    },
    vertexShader: `attribute vec4 tangent; uniform vec4 t1; uniform vec4 t2; uniform vec4 s1; uniform vec4 s2; uniform vec4 factors; uniform float time;
      varying vec4 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec3 vToEye; varying float vFade;
      void main() {
        vUv.xy = uv * t1.xy + t1.zw + s1.xy * time + s1.zw;
        vUv.zw = uv * t2.xy + t2.zw + s2.xy * time + s2.zw;
        vN = normalize( mat3( modelMatrix ) * normal );
        vT = normalize( mat3( modelMatrix ) * tangent.xyz );
        vB = normalize( cross( vN, vT ) * tangent.w );
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vec3 toEye = cameraPosition - world.xyz;
        float dist = length( toEye );
        vToEye = toEye / dist;
        float axis = max( max( length( modelMatrix[0].xyz ), length( modelMatrix[1].xyz ) ), length( modelMatrix[2].xyz ) ) * factors.z;
        vFade = axis == 0.0 ? 1.0 : max( dist / axis, 1.0 );
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `uniform vec4 factors; uniform vec4 fresnel; uniform sampler2D distortionMap; uniform sampler2D layer2Map;
      varying vec4 vUv; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec3 vToEye; varying float vFade;
      void main() {
        vec3 n = texture2D( distortionMap, vUv.xy ).xyz * 2.0 - 1.0;
        n.z *= factors.w;
        n = normalize( n );
        n = normalize( vT * n.x - vB * n.y + vN * n.z );
        vec2 nv = ( viewMatrix * vec4( n, 0.0 ) ).xy;
        float f = pow( 1.0 - clamp( dot( vToEye, vN ) - fresnel.z, 0.0, 1.0 ), fresnel.x );
        f = fresnel.y < 0.0 ? ( 1.0 - min( f, 1.0 ) ) * -fresnel.y : f * fresnel.y;
        // the offset in pixels / 2 (Distortion.fx doubles it), here in GL's uv sense (y up): the client's (-x, +y) in
        // its y-down uv is -x, -y
        vec2 offset = -nv * texture2D( layer2Map, vUv.zw ).r * f * factors.x / vFade;
        gl_FragColor = vec4( offset / 64.0, 1.0 / 256.0, factors.y );
      }`,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation,
  });
  mat.userData.distortion = true;
  logDepth(mat);
  return mat;
}

const opaque = (m: THREE.Material) => !m.transparent && m.depthWrite && m.depthTest && m.blending === THREE.NormalBlending && m.visible;

/** Draws the distortion map (where a distortion surface is in view) and warps the frame through it. */
export class DistortionPass {
  private map: THREE.WebGLRenderTarget | null = null;
  private warped: THREE.WebGLRenderTarget | null = null;
  private readonly blank = new THREE.MeshBasicMaterial({ colorWrite: false });
  private readonly layers = new THREE.Layers();
  private readonly apply = new THREE.ShaderMaterial({
    uniforms: { frame: { value: null }, map: { value: null }, size: { value: new THREE.Vector2(1, 1) } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: `uniform sampler2D frame; uniform sampler2D map; uniform vec2 size; varying vec2 vUv;
      void main() {
        vec4 d = texture2D( map, vUv );
        // as the B8G8R8A8 map holds them: red and green 0.5 + the sum, in [0, 1]; blue and alpha in [0, 1]
        vec2 o = clamp( d.xy, -0.5, 0.5 ) * 2.0 * 64.0 / size;
        float count = clamp( d.z, 0.0, 1.0 );
        float c = count > 0.0 ? 1.0 - clamp( d.w, 0.0, 1.0 ) / ( count * 256.0 ) : 1.0;
        vec4 here = texture2D( frame, vUv );
        vec3 moved = vec3( texture2D( frame, vUv + o ).r, texture2D( frame, vUv + o * ( c * 0.5 + 0.5 ) ).g, texture2D( frame, vUv + o * c ).b );
        gl_FragColor = vec4( texture2D( map, vUv + o ).z >= 1.0 / 256.0 ? moved : here.rgb, here.a );
      }`,
    depthTest: false, depthWrite: false,
  });
  private readonly quad = new FullScreenQuad(this.apply);

  constructor() { this.layers.set(DISTORTION_LAYER); }

  /**
   * The frame warped by the scene's distortion surfaces, or the frame itself where none is in view. The map is drawn
   * after the scene's opaque depth (drawn again here, depth only).
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, frame: THREE.WebGLRenderTarget): THREE.Texture {
    let wanted = false;
    const hidden: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      if (o.layers.test(this.layers)) wanted = true;
      else if (!(o as THREE.Mesh).isMesh || !mats.every(opaque)) hidden.push(o);
    });
    if (!wanted) return frame.texture;
    const w = frame.width, h = frame.height;
    if (!this.map || this.map.width !== w || this.map.height !== h) {
      this.map?.dispose(); this.warped?.dispose();
      this.map = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
      this.warped = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    }
    const background = scene.background, override = scene.overrideMaterial, to = renderer.getRenderTarget();
    const mask = camera.layers.mask, clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    try {
      scene.background = null;
      renderer.setRenderTarget(this.map);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      // the opaque depth
      for (const o of hidden) o.visible = false;
      scene.overrideMaterial = this.blank;
      renderer.render(scene, camera);
      for (const o of hidden) o.visible = true;
      scene.overrideMaterial = override;
      // the distortion surfaces
      camera.layers.mask = this.layers.mask;
      renderer.render(scene, camera);
    } finally {
      for (const o of hidden) o.visible = true;
      camera.layers.mask = mask;
      scene.background = background;
      scene.overrideMaterial = override;
      renderer.setClearColor(clearColor, clearAlpha);
    }
    this.apply.uniforms["frame"]!.value = frame.texture;
    this.apply.uniforms["map"]!.value = this.map.texture;
    this.apply.uniforms["size"]!.value.set(w, h);
    renderer.setRenderTarget(this.warped);
    this.quad.render(renderer);
    renderer.setRenderTarget(to);
    return this.warped!.texture;
  }

  dispose(): void {
    this.map?.dispose(); this.warped?.dispose();
    this.blank.dispose(); this.apply.dispose(); this.quad.dispose();
  }
}
