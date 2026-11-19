// The client's dynamic lights (its high shader quality: trinity/sceneRenderJobSpace.py sets eveSpaceSceneDynamicLighting
// from SHADER_QUALITY == HIGH, whose effects are the .sm_depth records): the point, spot and faction lights of the
// space objects' children (Tr2Light::AddLight: colour x brightness x the parent's activation, radius and source
// radius x the parent's scale, the spot's direction its rotation applied to (0, 0, -1), the cones' cosines), gathered
// each frame (Tr2LightManager) and read by the hull shader's light loop (quadv5.sm_depth, ps: LightIndexBuffer /
// LightBuffer, fxres.py):
// - only within the light's radius; att = sat((1 / (d + 0.001) - 1 / (R + 0.001)) / (999.99994 - 1 / (R + 0.001)))
//   x 999.99994, a window on 1/d that reaches nought at R;
// - a spot (its outer cosine above nought): x sat((D . L - cosOuter) / (cosInner - cosOuter))^2, L toward the light;
// - an IES profile: x the red channel of mip 0 at 0.5 - 0.5 * dot(D, L);
// - its colour x att x (1 - min(sourceRadius / d, 0.8)) into the hull's BRDF (the client's diffuse has no 1/pi: pi
//   x three's).
// Build 16 x 16 pixel lists as computelightlists does. The forward renderer bins the
// visible light spheres conservatively in screen space. The hull's radius test rejects
// fragments outside the sphere, including across depth discontinuities. The second specular layer's share is omitted.

import { gfx, lodSettings } from "../play/gfxSettings.ts";
import * as THREE from "three";
import { activationOf } from "./activation.ts";
import { LIGHT_PROFILE_WIDTH, readLightProfileDDS } from "./ddsTexture.ts";

const TILE_SIZE = 16;
const ATLAS_WIDTH = 1024;
const LIGHT_TEXELS = 4;

/** A child light as hullChildren.ts keeps it: in its group's EVE space. */
export interface ChildLight {
  /** Its id (a curve set's binding into it, childAnimation.ts) and the scale its radius is drawn at. */
  id?: number;
  scale?: number;
  position: number[];
  radius: number;
  sourceRadius?: number;
  color: number[];
  brightness: number;
  /** A spot or IES profile's axis (EVE space), and a spot's cone cosines. */
  direction?: number[];
  cosOuter?: number;
  cosInner?: number;
  profile?: string;
}

/** Tile headers, packed indices, light records and IES values share one fragment sampler. */
export const dynamicLightUniforms = {
  dynCount: { value: 0 },
  dynGrid: { value: new THREE.Vector4() },
  dynLightBase: { value: 0 },
  dynLights: { value: null as THREE.DataTexture | null },
};

interface Gathered {
  pos: THREE.Vector3; color: THREE.Vector3; radius: number; source: number;
  dir: THREE.Vector3 | null; cosOuter: number; cosInner: number; profile?: string;
}
interface Atlas { texture: THREE.DataTexture; pixels: Float32Array }
interface LightFrame {
  frame: number; camera: THREE.Camera | null;
  pending: WeakMap<THREE.Camera, Map<THREE.Object3D, Gathered[]>>;
  atlas?: Atlas; offsets: Uint32Array; grid: THREE.Vector4; lightBase: number; count: number;
}
const lightFrames = new WeakMap<THREE.WebGLRenderer, LightFrame>();
const profilePixels = new Map<string, Float32Array | null>();
let lastPublished: LightFrame | null = null;

function frameFor(renderer: THREE.WebGLRenderer): LightFrame {
  let state = lightFrames.get(renderer);
  if (!state) {
    state = { frame: -1, camera: null, pending: new WeakMap(), offsets: new Uint32Array(), grid: new THREE.Vector4(), lightBase: 0, count: 0 };
    lightFrames.set(renderer, state);
  }
  return state;
}

function loadedProfile(url: string): Float32Array | null {
  if (!profilePixels.has(url)) {
    profilePixels.set(url, null);
    void fetch(url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    }).then((bytes) => profilePixels.set(url, Float32Array.from(readLightProfileDDS(bytes), THREE.DataUtils.fromHalfFloat))).catch(() => {});
  }
  return profilePixels.get(url) ?? null;
}

function atlasFor(state: LightFrame, texels: number, maxSize: number): Atlas {
  if (state.atlas && state.atlas.pixels.length >= texels * 4) return state.atlas;
  const width = Math.min(maxSize, Math.max(ATLAS_WIDTH, Math.ceil(texels / maxSize)));
  const rows = Math.ceil(texels / width);
  const height = Math.min(maxSize, THREE.MathUtils.ceilPowerOfTwo(rows));
  const pixels = new Float32Array(width * height * 4);
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.name = "Tiled dynamic lights";
  state.atlas?.texture.dispose();
  return state.atlas = { texture, pixels };
}

/**
 * A hull child's ticker runs before the opaque hulls. Offers made outside the
 * draw, such as muzzle effects, go to the same camera's next lit pass.
 */
export function offerLights(renderer: THREE.WebGLRenderer, camera: THREE.Camera, group: THREE.Object3D): void {
  const state = frameFor(renderer);
  let pending = state.pending.get(camera);
  const lights = group.userData.lights as ChildLight[] | undefined;
  const k = activationOf(group);
  if (!lights?.length || k === 0) { pending?.delete(group); return; }
  if (!pending) { pending = new Map(); state.pending.set(camera, pending); }
  group.updateWorldMatrix(true, false);
  const m = group.matrixWorld;
  const scale = Math.cbrt(Math.abs(m.determinant())) || 1;
  const gathered: Gathered[] = [];
  for (const l of lights) {
    if (!(l.radius > 0) || l.brightness === 0 || !(l.color[0] || l.color[1] || l.color[2])) continue;
    const pos = new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0).applyMatrix4(m);
    const b = l.brightness * k;
    const dir = l.direction ? new THREE.Vector3(l.direction[0] ?? 0, l.direction[1] ?? 0, l.direction[2] ?? -1).transformDirection(m) : null;
    gathered.push({
      pos, color: new THREE.Vector3((l.color[0] ?? 0) * b, (l.color[1] ?? 0) * b, (l.color[2] ?? 0) * b),
      radius: l.radius * scale, source: (l.sourceRadius ?? 0) * scale, dir, cosOuter: l.cosOuter ?? 0, cosInner: l.cosInner ?? 0, profile: l.profile,
    });
  }
  pending.set(group, gathered);
}

/** The projected tangent lines of a view-space sphere give a conservative tile rectangle. */
function tileBounds(pos: THREE.Vector3, r: number, matrix: THREE.Matrix4, width: number, height: number): [number, number, number, number] {
  const p = matrix.elements, depth = -pos.z;
  const perspective = p[15] === 0;
  const dimension = (center: number, scale: number, shift: number, pixels: number) => {
    let middle = center, radius = r;
    if (perspective) {
      if (depth <= r) return [0, Math.ceil(pixels / TILE_SIZE) - 1] as const;
      const denom = depth * depth - r * r;
      middle = center * depth / denom;
      radius = r * Math.sqrt(denom + center * center) / denom;
    }
    const middleNdc = middle * scale + shift;
    const radiusNdc = radius * Math.abs(scale);
    const tile = (ndc: number) => Math.min(Math.ceil(pixels / TILE_SIZE) - 1,
      Math.max(0, Math.floor((ndc + 1) * pixels / (TILE_SIZE * 2))));
    return [tile(middleNdc - radiusNdc), tile(middleNdc + radiusNdc)] as const;
  };
  const [left, right] = dimension(pos.x, p[0]!, perspective ? -p[8]! : p[12]!, width);
  const [bottom, top] = dimension(pos.y, p[5]!, perspective ? -p[9]! : p[13]!, height);
  return [left, right, bottom, top];
}

/**
 * Tr2LightManager::AddLight per light: in the view's frustum, its size across in pixels (TriFrustum::GetPixelSizeAccross:
 * radius / depth x _11 x the viewport's half width x 2; the eye inside it: no limit) above CUTOFF_PIXEL_SIZE 7 (x the
 * LOD factor: the LOD quality's, AdjustLightCutoff), dimmed over FADE_SIZE 5 pixels past it, and - scaleBrightness, Tr2Light's default - its colour x its
 * radius. Every eligible source goes into the tiles its sphere covers.
 */
function buildTiles(renderer: THREE.WebGLRenderer, camera: THREE.Camera, state: LightFrame): void {
  const pending = state.pending.get(camera);
  state.count = 0;
  if (!pending?.size) return;
  state.pending.delete(camera);
  if (gfx().shaderQuality !== 3) return;
  const { x, y, z: width, w: height } = renderer.getCurrentViewport(new THREE.Vector4());
  if (!(width > 0 && height > 0)) return;
  const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE), tiles = columns * rows;
  const projection = camera.projectionMatrix, view = camera.matrixWorldInverse;
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(projection, view));
  const across = Math.abs(projection.elements[0]!) * width;
  const cutoff = 7 * lodSettings().lodFactor;
  const sphere = new THREE.Sphere();
  const list: { light: Gathered; pos: THREE.Vector3; dim: number; bounds: ReturnType<typeof tileBounds>; profile: Float32Array | null }[] = [];
  const profiles = new Map<Float32Array, number>();
  for (const group of pending.values()) for (const light of group) {
    if (!frustum.intersectsSphere(sphere.set(light.pos, light.radius))) continue;
    const pos = light.pos.clone().applyMatrix4(view);
    const size = projection.elements[15] !== 0 ? light.radius * across
      : pos.lengthSq() < light.radius * light.radius ? Infinity : light.radius * across / Math.max(1e-5, -pos.z);
    if (!(size > cutoff)) continue;
    const profile = light.profile && light.dir ? loadedProfile(light.profile) : null;
    if (profile && !profiles.has(profile)) profiles.set(profile, profiles.size);
    list.push({ light, pos, dim: Math.min((size - cutoff) / 5, 1) * light.radius,
      bounds: tileBounds(pos, light.radius, projection, width, height), profile });
  }
  if (!list.length) return;
  if (state.offsets.length < tiles) state.offsets = new Uint32Array(tiles);
  else state.offsets.fill(0, 0, tiles);
  const offsets = state.offsets;
  let references = 0;
  for (const { bounds: [left, right, bottom, top] } of list) {
    references += (right - left + 1) * (top - bottom + 1);
    for (let row = bottom; row <= top; row++) for (let col = left; col <= right; col++) {
      const tile = row * columns + col;
      offsets[tile] = offsets[tile]! + 1;
    }
  }
  const lightBase = tiles + Math.ceil(references / 4);
  const profileBase = lightBase + list.length * LIGHT_TEXELS;
  const texels = profileBase + profiles.size * LIGHT_PROFILE_WIDTH / 4;
  const maxSize = renderer.capabilities.maxTextureSize;
  if (texels > Math.min(maxSize * maxSize, 2 ** 22)) return;
  const atlas = atlasFor(state, texels, maxSize);
  const { pixels } = atlas;
  let next = tiles * 4;
  for (let tile = 0; tile < tiles; tile++) {
    const count = offsets[tile]!;
    pixels[tile * 4] = offsets[tile] = next;
    pixels[tile * 4 + 1] = count;
    next += count;
  }
  list.forEach(({ light, pos, dim, bounds: [left, right, bottom, top], profile }, index) => {
    for (let row = bottom; row <= top; row++) for (let col = left; col <= right; col++) {
      const tile = row * columns + col;
      const offset = offsets[tile]!;
      pixels[offset] = index;
      offsets[tile] = offset + 1;
    }
    const offset = (lightBase + index * LIGHT_TEXELS) * 4;
    const axis = light.dir?.clone().transformDirection(view);
    const profileOffset = profile ? profileBase * 4 + profiles.get(profile)! * LIGHT_PROFILE_WIDTH : 0;
    pixels.set([pos.x, pos.y, pos.z, light.radius,
      light.color.x * dim, light.color.y * dim, light.color.z * dim, light.source,
      axis?.x ?? 0, axis?.y ?? 0, axis?.z ?? 0, light.cosOuter,
      light.cosInner, profileOffset, 0, 0], offset);
  });
  for (const [profile, slot] of profiles) pixels.set(profile, profileBase * 4 + slot * LIGHT_PROFILE_WIDTH);
  atlas.texture.needsUpdate = true;
  state.grid.set(x, y, columns, rows);
  state.lightBase = lightBase;
  state.count = list.length;
}

function prepareLights(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
  const state = frameFor(renderer), frame = renderer.info.render.frame;
  if (state.frame !== frame || state.camera !== camera) {
    state.frame = frame;
    state.camera = camera;
    buildTiles(renderer, camera, state);
  } else if (state === lastPublished) return;
  lastPublished = state;
  dynamicLightUniforms.dynCount.value = state.count;
  dynamicLightUniforms.dynGrid.value.copy(state.grid);
  dynamicLightUniforms.dynLightBase.value = state.lightBase;
  dynamicLightUniforms.dynLights.value = state.count ? state.atlas!.texture : null;
}

/** The hull material lit by the dynamic lights too (its compile changed first, before the material's own). */
export function followDynamicLights<M extends THREE.Material>(material: M): M {
  const compile = material.onBeforeCompile;
  const before = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    prepareLights(renderer, camera);
  };
  material.onBeforeCompile = function (shader, renderer) {
    Object.assign(shader.uniforms, dynamicLightUniforms);
    shader.fragmentShader = `#define DYN_LIGHTS
uniform int dynCount;
uniform vec4 dynGrid;
uniform int dynLightBase;
uniform highp sampler2D dynLights;
vec4 dynRead( int offset ) {
  int width = textureSize( dynLights, 0 ).x;
  return texelFetch( dynLights, ivec2( offset % width, offset / width ), 0 );
}
float dynScalar( int offset ) {
  return dynRead( offset / 4 )[ offset % 4 ];
}
float dynProfile( int offset, float u ) {
  float x = clamp( u * ${LIGHT_PROFILE_WIDTH}.0 - 0.5, 0.0, ${LIGHT_PROFILE_WIDTH - 1}.0 );
  int i = int( x );
  return mix( dynScalar( offset + i ), dynScalar( offset + min( i + 1, ${LIGHT_PROFILE_WIDTH - 1} ) ), fract( x ) );
}
#define DYN_LIGHTS_LOOP ${LOOP.replace(/\s*\n\s*/g, " ")}
${shader.fragmentShader.replace("#include <lights_fragment_begin>", `#include <lights_fragment_begin>
  DYN_LIGHTS_LOOP`)}`;
    compile.call(this, shader, renderer);
  };
  return material;
}

/** The loop, one line (a macro): the material's second lighting pass (hullModel.ts's dust layer) runs it too. */
const LOOP = `
  if ( dynCount > 0 ) {
  ivec2 tile = ivec2( ( gl_FragCoord.xy - dynGrid.xy ) / ${TILE_SIZE}.0 );
  vec2 tileList = dynRead( tile.y * int( dynGrid.z ) + tile.x ).xy;
  for ( int i = 0; i < int( tileList.y ); i ++ ) {
    int index = int( dynScalar( int( tileList.x ) + i ) );
    int address = dynLightBase + index * ${LIGHT_TEXELS};
    vec4 dynPosition = dynRead( address );
    vec3 dynL = dynPosition.xyz - geometryPosition;
    float dynD = length( dynL );
    float dynR = dynPosition.w;
    if ( dynD >= dynR ) continue;
    dynL /= dynD;
    float dynRr = 1.0 / ( dynR + 0.001 );
    float dynAtt = clamp( ( 1.0 / ( dynD + 0.001 ) - dynRr ) / ( 999.999939 - dynRr ), 0.0, 1.0 ) * 999.999939;
    vec4 dynColorSource = dynRead( address + 1 );
    vec4 dynSpot = dynRead( address + 2 );
    vec2 dynShape = dynRead( address + 3 ).xy;
    float dynAxis = dot( dynSpot.xyz, dynL );
    if ( dynSpot.w > 0.0 ) {
      float dynC = clamp( ( dynAxis - dynSpot.w ) / ( dynShape.x - dynSpot.w ), 0.0, 1.0 );
      dynAtt *= dynC * dynC;
    }
    if ( dynShape.y > 0.0 ) {
      dynAtt *= dynProfile( int( dynShape.y ), 0.5 - 0.5 * dynAxis );
    }
    float dynSrc = clamp( dynColorSource.w / dynD, 0.0, 0.8 );
    directLight.color = dynColorSource.xyz * dynAtt * ( 1.0 - dynSrc ) * PI;
    directLight.direction = dynL;
    directLight.visible = true;
    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
  }`;
