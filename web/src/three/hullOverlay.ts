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
//   TransitionColor x NoiseFactors.z (alpha 1);
// - fxbuildv5, pass 0 (the build lines; additive, no culling): a geometry shader takes each triangle (model space) the
//   clip sphere cuts - one vertex on the other side of the surface from the other two - and emits one triangle: the
//   two points where its edges cross the sphere and the sphere's centre, each carrying its offset from the centre and
//   r / R (shipData.w); the pixel stage reads BuildLineMap (3D) at normalize(offset) x r / R x BuildLineTransform.xyz +
//   BuildLineScroll.xyz x time: (.x, .x, .x, .w) x BaseColor - radial streaks over the cut's cross-section. WebGL has
//   no geometry stage: the same triangles are found here on the CPU (buildLines) whenever the clip sphere moves.

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

const LINES_VS = `attribute vec4 offset; varying vec4 vO;
void main() {
  vO = offset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const LINES_FS = `uniform vec4 baseColor; uniform vec4 lineScroll; uniform vec4 lineTransform; uniform float time;
uniform highp sampler3D buildLineMap; varying vec4 vO;
void main() {
  vec3 q = normalize( vO.xyz ) * vO.w * lineTransform.xyz + lineScroll.xyz * time;
  vec4 n = texture( buildLineMap, q );
  gl_FragColor = vec4( n.x, n.x, n.x, n.w ) * baseColor;
}`;

/** A geometry's positions in EVE's model space (x, y, -z), and its triangles' indices, read once. */
const evePositions = new WeakMap<THREE.BufferGeometry, { p: Float32Array; index: ArrayLike<number> | null; count: number }>();
function eveGeometry(g: THREE.BufferGeometry): { p: Float32Array; index: ArrayLike<number> | null; count: number } {
  let e = evePositions.get(g);
  if (!e) {
    const pos = g.getAttribute("position");
    const p = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { p[i * 3] = pos.getX(i); p[i * 3 + 1] = pos.getY(i); p[i * 3 + 2] = -pos.getZ(i); }
    const index = g.getIndex()?.array ?? null;
    e = { p, index, count: index ? index.length : pos.count };
    evePositions.set(g, e);
  }
  return e;
}

/**
 * fxbuildv5's build lines for one hull mesh: a mesh rebuilt as the clip sphere moves (its onBeforeRender, so only for
 * a level being drawn), each cut triangle's fan (cut, cut, centre) in three's space with its offset and r / R.
 */
function buildLines(source: THREE.Mesh, fx: SofOverlayFx, radius: number): THREE.Mesh {
  const p = fx.params;
  const geo = new THREE.BufferGeometry();
  let capacity = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      baseColor: { value: v4(p.BaseColor, [1, 1, 1, 1]) }, lineScroll: { value: v4(p.BuildLineScroll, [1, 1, 0, 0]) },
      lineTransform: { value: v4(p.BuildLineTransform, [1, 1, 0, 0]) }, time: clock, buildLineMap: { value: null },
    },
    vertexShader: LINES_VS,
    fragmentShader: LINES_FS,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  const url = fx.textures.BuildLineMap;
  if (url) void loadDds3D(url).then((t) => { mat.uniforms.buildLineMap!.value = t; mat.uniformsNeedUpdate = true; }).catch(() => {});
  const lines = new THREE.Mesh(geo, mat);
  lines.frustumCulled = false;
  geo.setDrawRange(0, 0);
  let last = "";
  lines.onBeforeRender = () => {
    const c = clipOf(lines);
    const key = c ? `${c[0]},${c[1]},${c[2]},${c[3]}` : "";
    if (key === last) return;
    last = key;
    const rSq = c?.[3] ?? 0;
    if (!c || rSq <= 0) { geo.setDrawRange(0, 0); return; }
    const r = Math.sqrt(rSq), cx = c[0]!, cy = c[1]!, cz = c[2]!, w = r / radius;
    const { p: pos, index, count } = eveGeometry(source.geometry);
    const out: number[] = [], off: number[] = [];
    const at = (i: number) => (index ? index[i]! : i);
    const v = [0, 0, 0].map(() => new Float32Array(3));
    const inside = [false, false, false];
    // the point where the segment from inside point a to outside point b crosses the sphere (relative to the centre)
    const cross = (a: Float32Array, b: Float32Array): [number, number, number] => {
      const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, dz = b[2]! - a[2]!;
      const qa = dx * dx + dy * dy + dz * dz, qb = 2 * (a[0]! * dx + a[1]! * dy + a[2]! * dz), qc = a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]! - rSq;
      const t = qa > 0 ? (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa) : 0;
      return [a[0]! + dx * t, a[1]! + dy * t, a[2]! + dz * t];
    };
    const emit = (q: [number, number, number]) => { out.push(q[0] + cx, q[1] + cy, -(q[2] + cz)); off.push(q[0], q[1], q[2], w); };
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = at(t + k) * 3;
        const a = v[k]!;
        a[0] = pos[i]! - cx; a[1] = pos[i + 1]! - cy; a[2] = pos[i + 2]! - cz;
        inside[k] = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] <= rSq;
      }
      if (inside[0] === inside[1] && inside[1] === inside[2]) continue;
      // the lone vertex (the one on its own side) and the other two
      const lone = inside[1] === inside[2] ? 0 : inside[0] === inside[2] ? 1 : 2;
      const a = v[lone]!, b = v[(lone + 1) % 3]!, d = v[(lone + 2) % 3]!;
      const p1 = inside[lone] ? cross(a, b) : cross(b, a);
      const p2 = inside[lone] ? cross(a, d) : cross(d, a);
      emit(p1); emit(p2);
      out.push(cx, cy, -cz); off.push(0, 0, 0, w);
    }
    const n = out.length / 3;
    if (n > capacity) {
      capacity = Math.max(n, capacity * 2, 384);
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("offset", new THREE.BufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    }
    if (n) {
      const pa = geo.getAttribute("position") as THREE.BufferAttribute, oa = geo.getAttribute("offset") as THREE.BufferAttribute;
      (pa.array as Float32Array).set(out); (oa.array as Float32Array).set(off);
      pa.needsUpdate = true; oa.needsUpdate = true;
    }
    geo.setDrawRange(0, n);
  };
  return lines;
}

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
    // fxbuildv5's build lines, over the same areas as its blueprint pass
    if (kinds.some((k) => k === "opaque" || k === "transparent" || k === "decal")) {
      for (const fx of overlay.additive) {
        if (fx.shader !== "fxbuildv5") continue;
        const lines = buildLines(mesh, fx, radius);
        lines.name = `overlay:${key}:lines`;
        lines.userData.overlay = key;
        mesh.add(lines);
      }
    }
  }
}

/** The overlay's draws taken off the model (their materials, and the build lines' geometry, disposed: each add makes its own). */
export function removeOverlay(model: THREE.Object3D, key: string): void {
  const on = model.userData.overlaysOn as Record<string, boolean> | undefined;
  if (!on?.[key]) return;
  delete on[key];
  const draws: THREE.Mesh[] = [];
  model.traverse((o) => { if (o.userData.overlay === key) draws.push(o as THREE.Mesh); });
  const mats = new Set<THREE.Material>();
  for (const d of draws) { d.removeFromParent(); mats.add(d.material as THREE.Material); if (d.name.endsWith(":lines")) d.geometry.dispose(); }
  for (const m of mats) m.dispose();
}
