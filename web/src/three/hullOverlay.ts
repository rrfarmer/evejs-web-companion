// A space object's mesh overlays (Trinity EveMeshOverlayEffect, added by a controller's Tr2ActionOverlay: a structure's
// construction and teardown, res:/fisfx/generic/overlays/*.red): extra draws of the hull's own mesh with the overlay's
// effects - its opaque effects over the opaque areas, its transparent (and additive) ones over the opaque, transparent
// and decal areas (EveMeshOverlayEffect.cpp CollectOverlayAreaBlocks / EmitOverlayBatches) - each draw with its space
// object's per-object data (the clip spheres, hullModel.ts setClipSphere; the bounding sphere's radius, shipData.w).
//
// The shaders, from their records (fxres.py; dx11 .sm_hi):
// - nanobuilder/fxholecapperv5 (CULLMODE ccw: the back faces, three's BackSide - the hull's inside, seen through the
//   hole the clip cuts): the hull's clip discards; then the view ray from the pixel (model space, away from the eye)
//   meets the clip sphere, sign(r^2) sqrt(disc) - 2b over 2a; that point x 2500 / (NoiseFactors.y x R) is the noise
//   coordinate: s(n(q 0.5113)) 0.5 + s(n(q 1.1113)) 0.3 + s(n(q 2.1113)) 0.2 + 0.5, s(x) = x^2 (3 - 2x) of the
//   saturated NoiseMap.x, times FxColor - the hole capped with a noisy surface on the sphere;
// - cloak/fxtransitionv5 (CULLMODE none; the transparent batch's alpha blend): no discard; the same three octaves at
//   (p k + NoiseFactors.w x time) / (NoiseFactors.y x R) for the model-space position p, plus (|p - c| - r) /
//   (NoiseFactors.x x R x 0.1), saturated, reads GradientMap.x at (x, 0): the alpha (nought where r < 0.001) of a flat
//   FxColor - a band of colour at the dissolve's front.
// fxbuildv5 (the additive blueprint layer) is not drawn yet.

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";
import { clipOf } from "./activation.ts";
import { loadDds, loadDds3D } from "./ddsTexture.ts";

export interface SofOverlayFx { name: string | null; shader: string; params: Record<string, number[]>; textures: Record<string, string | null> }
export interface SofOverlay { name: string | null; opaque: SofOverlayFx[]; transparent: SofOverlayFx[]; additive: SofOverlayFx[]; decal: SofOverlayFx[]; distortion: SofOverlayFx[] }

const clock = { get value() { return performance.now() / 1000; } };

const NOISE = `float ovS( float x ) { x = clamp( x, 0.0, 1.0 ); return x * x * ( 3.0 - 2.0 * x ); }`;

const VS = `varying vec3 vP; varying vec3 vV;
void main() {
  vP = vec3( position.x, position.y, -position.z );
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vec3 toEye = normalize( cameraPosition - world.xyz );
  vec3 l = transpose( mat3( modelMatrix ) ) * toEye;
  vV = vec3( l.x, l.y, -l.z );
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const CAPPER_FS = `uniform vec4 clipData; uniform float clipRadius2Sq; uniform vec4 noiseFactors; uniform vec4 fxColor; uniform float radius;
uniform highp sampler3D noiseMap; varying vec3 vP; varying vec3 vV;
${NOISE}
void main() {
  float sg = sign( clipData.w );
  vec3 pc = vP - clipData.xyz;
  float d2 = dot( pc, pc );
  if ( sg * d2 - clipData.w < 0.0 ) discard;
  if ( sign( clipRadius2Sq ) * d2 - clipRadius2Sq < 0.0 ) discard;
  float b2 = 2.0 * dot( -vV, pc );
  float a2 = 2.0 * dot( vV, vV );
  float disc = b2 * b2 - 2.0 * a2 * ( d2 - sg * clipData.w );
  float t = ( sg * sqrt( disc ) - b2 ) / a2;
  vec3 q = ( vP - vV * t ) * ( 2500.0 / ( noiseFactors.y * radius ) );
  float n = ovS( texture( noiseMap, q * 0.5113 ).x ) * 0.5 + ovS( texture( noiseMap, q * 1.1113 ).x ) * 0.3
    + ovS( texture( noiseMap, q * 2.1113 ).x ) * 0.2 + 0.5;
  gl_FragColor = n * fxColor;
}`;

const TRANSITION_FS = `uniform vec4 clipData; uniform vec4 noiseFactors; uniform vec4 fxColor; uniform float radius; uniform float time;
uniform highp sampler3D noiseMap; uniform sampler2D gradientMap; varying vec3 vP; varying vec3 vV;
${NOISE}
void main() {
  float t0 = noiseFactors.w * time;
  float sc = noiseFactors.y * radius;
  float n = ovS( texture( noiseMap, ( vP * 0.5113 + t0 ) / sc ).x ) * 0.5 + ovS( texture( noiseMap, ( vP * 1.1113 + t0 ) / sc ).x ) * 0.3
    + ovS( texture( noiseMap, ( vP * 2.1113 + t0 ) / sc ).x ) * 0.2;
  vec3 pc = vP - clipData.xyz;
  float r = sqrt( sign( clipData.w ) * clipData.w );
  float x = clamp( n + ( length( pc ) - r ) / ( noiseFactors.x * radius * 0.1 ), 0.0, 1.0 );
  float a = texture( gradientMap, vec2( x, 0.0 ) ).x * ( r >= 0.001 ? 1.0 : 0.0 );
  gl_FragColor = vec4( fxColor.rgb, a );
}`;

const v4 = (a: number[] | undefined, d: number[]) => new THREE.Vector4(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2], a?.[3] ?? d[3]);

/** One overlay effect's material (null for a shader not drawn here), its clip uniforms set per draw from the object's. */
function overlayMaterial(fx: SofOverlayFx, radius: number, pass: "opaque" | "transparent"): THREE.ShaderMaterial | null {
  const capper = fx.shader === "fxholecapperv5";
  if (!capper && fx.shader !== "fxtransitionv5") return null;
  if (capper !== (pass === "opaque")) return null;
  const clipData = { value: new THREE.Vector4() }, clip2 = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      clipData, clipRadius2Sq: clip2, radius: { value: radius }, time: clock,
      noiseFactors: { value: v4(fx.params.NoiseFactors, [0, 0, 0, 0]) }, fxColor: { value: v4(fx.params.FxColor, [0.6, 0.7, 1, 1]) },
      noiseMap: { value: null }, gradientMap: { value: null },
    },
    vertexShader: VS,
    fragmentShader: capper ? CAPPER_FS : TRANSITION_FS,
    ...(capper ? { side: THREE.BackSide } : { side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.NormalBlending }),
  });
  logDepth(mat);
  const noise = fx.textures.NoiseMap, gradient = fx.textures.GradientMap;
  if (noise) void loadDds3D(noise).then((t) => { mat.uniforms.noiseMap!.value = t; mat.uniformsNeedUpdate = true; }).catch(() => {});
  if (gradient) void loadDds(gradient).then((t) => { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; mat.uniforms.gradientMap!.value = t; mat.uniformsNeedUpdate = true; }).catch(() => {});
  mat.onBeforeRender = (_r, _s, _c, _g, object) => {
    const c = clipOf(object);
    const v = clipData.value;
    const x = c?.[0] ?? 0, y = c?.[1] ?? 0, z = c?.[2] ?? 0, w = c?.[3] ?? 0, w2 = c?.[4] ?? 0;
    if (v.x !== x || v.y !== y || v.z !== z || v.w !== w || clip2.value !== w2) { v.set(x, y, z, w); clip2.value = w2; mat.uniformsNeedUpdate = true; }
  };
  return mat;
}

/**
 * The overlay (by its file) added to the model's hull: each hull mesh (one that has userData.areaKinds, hullModel.ts)
 * given a draw per effect of the passes over its areas. Added once; removeOverlay takes it off.
 */
export function addOverlay(model: THREE.Object3D, key: string, overlay: SofOverlay | null | undefined): void {
  if (!overlay) return;
  const on = (model.userData.overlaysOn ??= {}) as Record<string, boolean>;
  if (on[key]) return;
  on[key] = true;
  const bs = model.userData.boundingSphere as number[] | null | undefined;
  const radius = bs?.[3] ?? (model.userData.radius as number | undefined) ?? 1;
  const materials = {
    opaque: overlay.opaque.map((fx) => overlayMaterial(fx, radius, "opaque")).filter((m): m is THREE.ShaderMaterial => !!m),
    transparent: overlay.transparent.map((fx) => overlayMaterial(fx, radius, "transparent")).filter((m): m is THREE.ShaderMaterial => !!m),
  };
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => { if ((o as THREE.Mesh).isMesh && Array.isArray(o.userData.areaKinds)) meshes.push(o as THREE.Mesh); });
  for (const mesh of meshes) {
    const kinds = mesh.userData.areaKinds as string[];
    const list = [
      ...(kinds.includes("opaque") ? materials.opaque : []),
      ...(kinds.some((k) => k === "opaque" || k === "transparent" || k === "decal") ? materials.transparent : []),
    ];
    for (const m of list) {
      const draw = new THREE.Mesh(mesh.geometry, m);
      draw.name = `overlay:${key}`;
      draw.userData.overlay = key;
      draw.frustumCulled = mesh.frustumCulled;
      mesh.add(draw);
    }
  }
}

/** The overlay's draws taken off the model (their materials disposed: each add makes its own). */
export function removeOverlay(model: THREE.Object3D, key: string): void {
  const on = model.userData.overlaysOn as Record<string, boolean> | undefined;
  if (!on?.[key]) return;
  delete on[key];
  const draws: THREE.Mesh[] = [];
  model.traverse((o) => { if (o.userData.overlay === key) draws.push(o as THREE.Mesh); });
  const mats = new Set<THREE.Material>();
  for (const d of draws) { d.removeFromParent(); mats.add(d.material as THREE.Material); }
  for (const m of mats) m.dispose();
}
