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
// - nanobuilder/fxbuildv5, pass 1 (the additive batch's ONE/ONE, no culling): the fresnel f = (1 - sat(N.V -
//   FresnelFactors.z))^FresnelFactors.x x .y (with .y < 0: -.y (1 - min(that, 1))); BlueprintMap and
//   BlueprintLayerMap at uv x Transform.xy + .zw + Scroll.xy x time + .zw, x BlueprintMaskMap at uv, x BlueprintColor,
//   x BlueprintFalloffMap at (|p - c| / r, 0.5), its colour x f - inside the clip sphere only; plus, within
//   NoiseFactors.x x R of the sphere's surface, CooldownMap.x at (min(|(|p - c| - r) / that|, 1), 0.5) x
//   TransitionColor x NoiseFactors.z (alpha 1). Its pass 0 (a geometry shader: a thin strip along each triangle's cut
//   by the sphere, BuildLineMap's 3D noise) is not drawn: WebGL has no geometry stage.

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

const BUILD_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  vUv = uv;
  vP = vec3( position.x, position.y, -position.z );
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vN = normalize( mat3( modelMatrix ) * normal );
  vV = normalize( cameraPosition - world.xyz );
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const BUILD_FS = `uniform vec4 clipData; uniform float radius; uniform float time;
uniform vec4 fresnelFactors; uniform vec4 noiseFactors; uniform vec4 blueprintColor; uniform vec4 transitionColor;
uniform vec4 fgScroll; uniform vec4 fgTransform; uniform vec4 layerScroll; uniform vec4 layerTransform;
uniform sampler2D cooldownMap; uniform sampler2D blueprintMap; uniform sampler2D blueprintLayerMap; uniform sampler2D blueprintMaskMap; uniform sampler2D blueprintFalloffMap;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  float fr = pow( 1.0 - clamp( dot( vV, vN ) - fresnelFactors.z, 0.0, 1.0 ), fresnelFactors.x );
  float f = fresnelFactors.y < 0.0 ? -fresnelFactors.y * ( 1.0 - min( fr, 1.0 ) ) : fr * fresnelFactors.y;
  vec4 bp = texture( blueprintMap, vUv * fgTransform.xy + fgTransform.zw + fgScroll.xy * time + fgScroll.zw )
    * texture( blueprintLayerMap, vUv * layerTransform.xy + layerTransform.zw + layerScroll.xy * time + layerScroll.zw )
    * texture( blueprintMaskMap, vUv ) * blueprintColor;
  float d = length( vP - clipData.xyz );
  float r = sqrt( abs( clipData.w ) );
  bp *= texture( blueprintFalloffMap, vec2( d / r, 0.5 ) );
  bp.rgb *= f;
  float w = noiseFactors.x * radius;
  float e = d - r;
  float inside = r >= d ? 1.0 : 0.0;
  float band = w >= abs( e ) ? 1.0 : 0.0;
  float cool = texture( cooldownMap, vec2( min( abs( e / w ), 1.0 ), 0.5 ) ).x;
  gl_FragColor = bp * inside + vec4( cool * transitionColor.rgb * noiseFactors.z, 1.0 ) * band;
}`;

const v4 = (a: number[] | undefined, d: number[]) => new THREE.Vector4(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2], a?.[3] ?? d[3]);

/** One overlay effect's material (null for a shader not drawn here), its clip uniforms set per draw from the object's. */
function overlayMaterial(fx: SofOverlayFx, radius: number, pass: "opaque" | "transparent" | "additive"): THREE.ShaderMaterial | null {
  if (fx.shader === "fxbuildv5") return pass === "additive" ? buildMaterial(fx, radius) : null;
  if (pass === "additive") return null;
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
  followClipData(mat, clipData, clip2);
  return mat;
}

/** The material's clip uniforms set for each draw from the drawn object's space object (clipOf). */
function followClipData(mat: THREE.ShaderMaterial, clipData: { value: THREE.Vector4 }, clip2: { value: number }): void {
  mat.onBeforeRender = (_r, _s, _c, _g, object) => {
    const c = clipOf(object);
    const v = clipData.value;
    const x = c?.[0] ?? 0, y = c?.[1] ?? 0, z = c?.[2] ?? 0, w = c?.[3] ?? 0, w2 = c?.[4] ?? 0;
    if (v.x !== x || v.y !== y || v.z !== z || v.w !== w || clip2.value !== w2) { v.set(x, y, z, w); clip2.value = w2; mat.uniformsNeedUpdate = true; }
  };
}

/** fxbuildv5's blueprint pass (its pass 1), additive, both faces; its maps loaded as they come (Blueprint* wrap). */
function buildMaterial(fx: SofOverlayFx, radius: number): THREE.ShaderMaterial {
  const p = fx.params;
  const clipData = { value: new THREE.Vector4() }, clip2 = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      clipData, clipRadius2Sq: clip2, radius: { value: radius }, time: clock,
      fresnelFactors: { value: v4(p.FresnelFactors, [1, 1, 0, 0]) }, noiseFactors: { value: v4(p.NoiseFactors, [0, 0, 0, 0]) },
      blueprintColor: { value: v4(p.BlueprintColor, [1, 1, 1, 1]) }, transitionColor: { value: v4(p.TransitionColor, [1, 1, 1, 1]) },
      fgScroll: { value: v4(p.BlueprintForegroundScroll, [1, 1, 0, 0]) }, fgTransform: { value: v4(p.BlueprintForegroundTransform, [1, 1, 0, 0]) },
      layerScroll: { value: v4(p.BlueprintLayerScroll, [1, 1, 0, 0]) }, layerTransform: { value: v4(p.BlueprintLayerTransform, [1, 1, 0, 0]) },
      cooldownMap: { value: null }, blueprintMap: { value: null }, blueprintLayerMap: { value: null }, blueprintMaskMap: { value: null }, blueprintFalloffMap: { value: null },
    },
    vertexShader: BUILD_VS,
    fragmentShader: BUILD_FS,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  const maps: [string, string, boolean][] = [["CooldownMap", "cooldownMap", false], ["BlueprintMap", "blueprintMap", true], ["BlueprintLayerMap", "blueprintLayerMap", true],
    ["BlueprintMaskMap", "blueprintMaskMap", true], ["BlueprintFalloffMap", "blueprintFalloffMap", false]];
  for (const [name, uniform, wrap] of maps) {
    const url = fx.textures[name];
    if (!url) continue;
    void loadDds(url).then((t) => {
      t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      mat.uniforms[uniform]!.value = t;
      mat.uniformsNeedUpdate = true;
    }).catch(() => {});
  }
  followClipData(mat, clipData, clip2);
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
    transparent: [...overlay.transparent.map((fx) => overlayMaterial(fx, radius, "transparent")), ...overlay.additive.map((fx) => overlayMaterial(fx, radius, "additive"))]
      .filter((m): m is THREE.ShaderMaterial => !!m),
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
