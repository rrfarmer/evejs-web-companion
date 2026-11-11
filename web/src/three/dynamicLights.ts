// The client's dynamic lights (its high shader quality: trinity/sceneRenderJobSpace.py sets eveSpaceSceneDynamicLighting
// from SHADER_QUALITY == HIGH, whose effects are the .sm_depth records): the point, spot and faction lights of the
// space objects' children (Tr2Light::AddLight: colour x brightness x the parent's activation, radius and source
// radius x the parent's scale, the spot's direction its rotation applied to (0, 0, -1), the cones' cosines), gathered
// each frame (Tr2LightManager) and read by the hull shader's light loop (quadv5.sm_depth, ps: LightIndexBuffer /
// LightBuffer, fxres.py):
// - only within the light's radius; att = sat((1 / (d + 0.001) - 1 / (R + 0.001)) / (999.99994 - 1 / (R + 0.001)))
//   x 999.99994, a window on 1/d that reaches nought at R;
// - a spot (its outer cosine above nought): x sat((D . L - cosOuter) / (cosInner - cosOuter))^2, L toward the light;
// - its colour x att x (1 - min(sourceRadius / d, 0.8)) into the hull's BRDF (the client's diffuse has no 1/pi: pi
//   x three's).
// The client tiles the screen and gives each pixel its tile's list (computelightlists.fx); here one list for the
// frame: the MAX largest on screen (publish), uploaded as view-space uniforms each frame, taken
// from what the hull children's tickers offered during the frame before. The IES light profiles
// (LightProfileArray) and the second specular layer's share are not drawn.

import * as THREE from "three";
import { activationOf } from "./activation.ts";

export const MAX_DYNAMIC_LIGHTS = 16;

/** A child light as hullChildren.ts keeps it: in its group's EVE space. */
export interface ChildLight {
  position: number[];
  radius: number;
  sourceRadius?: number;
  color: number[];
  brightness: number;
  /** A spot's direction (EVE space) and its cones' cosines. */
  direction?: number[];
  cosOuter?: number;
  cosInner?: number;
}

/** The frame's light list as the hull materials read it (one block, shared by every hull material). */
export const dynamicLightUniforms = {
  dynCount: { value: 0 },
  dynPos: { value: Array.from({ length: MAX_DYNAMIC_LIGHTS }, () => new THREE.Vector3()) },
  dynColor: { value: Array.from({ length: MAX_DYNAMIC_LIGHTS }, () => new THREE.Vector3()) },
  // radius, source radius, cos inner, unused
  dynShape: { value: Array.from({ length: MAX_DYNAMIC_LIGHTS }, () => new THREE.Vector4()) },
  // direction (view space), cos outer (nought: not a spot)
  dynSpot: { value: Array.from({ length: MAX_DYNAMIC_LIGHTS }, () => new THREE.Vector4()) },
};

interface Gathered { pos: THREE.Vector3; color: THREE.Vector3; radius: number; source: number; dir: THREE.Vector3 | null; cosOuter: number; cosInner: number }
let frame = -1;
let gathered: Gathered[] = [];
const tmp = new THREE.Vector3();

/**
 * A hull children group's lights offered for the frame (from its ticker, as it is drawn); at the first offer of a new
 * frame the last frame's lights become the uniforms, seen from this camera.
 */
export function offerLights(renderer: THREE.WebGLRenderer, camera: THREE.Camera, group: THREE.Object3D): void {
  const f = renderer.info.render.frame;
  if (f !== frame) {
    if (gathered.length) publish(renderer, camera);
    frame = f;
    gathered = [];
  }
  const lights = group.userData.lights as ChildLight[] | undefined;
  if (!lights?.length) return;
  const k = activationOf(group);
  if (k === 0) return;
  group.updateWorldMatrix(true, false);
  const m = group.matrixWorld;
  const scale = Math.cbrt(Math.abs(m.determinant())) || 1;
  for (const l of lights) {
    if (!(l.radius > 0)) continue;
    const pos = new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0).applyMatrix4(m);
    const b = l.brightness * k;
    const dir = l.direction ? new THREE.Vector3(l.direction[0] ?? 0, l.direction[1] ?? 0, l.direction[2] ?? -1).transformDirection(m) : null;
    gathered.push({
      pos, color: new THREE.Vector3((l.color[0] ?? 0) * b, (l.color[1] ?? 0) * b, (l.color[2] ?? 0) * b),
      radius: l.radius * scale, source: (l.sourceRadius ?? 0) * scale, dir, cosOuter: l.cosOuter ?? 0, cosInner: l.cosInner ?? 0,
    });
  }
}

/**
 * Tr2LightManager::AddLight per light: in the view's frustum, its size across in pixels (TriFrustum::GetPixelSizeAccross:
 * radius / depth x _11 x the viewport's half width x 2; the eye inside it: no limit) above CUTOFF_PIXEL_SIZE 7 (x the
 * LOD factor, 1), dimmed over FADE_SIZE 5 pixels past it, and - scaleBrightness, Tr2Light's default - its colour x its
 * radius. The MAX largest on screen kept.
 */
function publish(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const ahead = camera.getWorldDirection(new THREE.Vector3());
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const halfWidth = (camera.projectionMatrix.elements[0] ?? 1) * renderer.domElement.width * 0.5;
  const sphere = new THREE.Sphere();
  const list = gathered
    .map((g) => {
      if (!frustum.intersectsSphere(sphere.set(g.pos, g.radius))) return null;
      const d = tmp.copy(g.pos).sub(eye);
      const size = d.lengthSq() < g.radius * g.radius ? Infinity : (g.radius / Math.max(1e-5, d.dot(ahead))) * halfWidth * 2;
      if (!(size > 7)) return null;
      return { g, size, dim: Math.min((size - 7) / 5, 1) * g.radius };
    })
    .filter((x): x is { g: Gathered; size: number; dim: number } => !!x)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_DYNAMIC_LIGHTS);
  const view = camera.matrixWorldInverse;
  list.forEach(({ g, dim }, i) => {
    dynamicLightUniforms.dynPos.value[i]!.copy(g.pos).applyMatrix4(view);
    dynamicLightUniforms.dynColor.value[i]!.copy(g.color).multiplyScalar(dim);
    dynamicLightUniforms.dynShape.value[i]!.set(g.radius, g.source, g.cosInner, 0);
    const s = dynamicLightUniforms.dynSpot.value[i]!;
    if (g.dir) { tmp.copy(g.dir).transformDirection(view); s.set(tmp.x, tmp.y, tmp.z, g.cosOuter); } else s.set(0, 0, 0, 0);
  });
  dynamicLightUniforms.dynCount.value = list.length;
}

/** The hull material lit by the dynamic lights too (its compile changed first, before the material's own). */
export function followDynamicLights<M extends THREE.Material>(material: M): M {
  const compile = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    Object.assign(shader.uniforms, dynamicLightUniforms);
    shader.fragmentShader = `#define DYN_MAX ${MAX_DYNAMIC_LIGHTS}
#define DYN_LIGHTS
uniform int dynCount; uniform vec3 dynPos[DYN_MAX]; uniform vec3 dynColor[DYN_MAX]; uniform vec4 dynShape[DYN_MAX]; uniform vec4 dynSpot[DYN_MAX];
#define DYN_LIGHTS_LOOP ${LOOP.replace(/\s*\n\s*/g, " ")}
${shader.fragmentShader.replace("#include <lights_fragment_begin>", `#include <lights_fragment_begin>
  DYN_LIGHTS_LOOP`)}`;
    compile.call(this, shader, renderer);
  };
  return material;
}

/** The loop, one line (a macro): the material's second lighting pass (hullModel.ts's dust layer) runs it too. */
const LOOP = `
  for ( int i = 0; i < DYN_MAX; i ++ ) {
    if ( i >= dynCount ) break;
    vec3 dynL = dynPos[ i ] - geometryPosition;
    float dynD = length( dynL );
    float dynR = dynShape[ i ].x;
    if ( dynD >= dynR ) continue;
    dynL /= dynD;
    float dynRr = 1.0 / ( dynR + 0.001 );
    float dynAtt = clamp( ( 1.0 / ( dynD + 0.001 ) - dynRr ) / ( 999.999939 - dynRr ), 0.0, 1.0 ) * 999.999939;
    if ( dynSpot[ i ].w > 0.0 ) {
      float dynC = clamp( ( dot( dynSpot[ i ].xyz, dynL ) - dynSpot[ i ].w ) / ( dynShape[ i ].z - dynSpot[ i ].w ), 0.0, 1.0 );
      dynAtt *= dynC * dynC;
    }
    float dynSrc = clamp( dynShape[ i ].y / dynD, 0.0, 0.8 );
    directLight.color = dynColor[ i ] * dynAtt * ( 1.0 - dynSrc ) * PI;
    directLight.direction = dynL;
    directLight.visible = true;
    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }`;
