// The client's engine flame (EveBoosterSet2 with boostervolumetric.fx, BOOSTER_LOD_HIGH; graphics/effect.dx11/managed/
// space/booster/boostervolumetric.sm_depth disassembled, client 3396210): per booster an instanced box, x and y -1..1
// and z -1..0 (EveBoosterUtilities GetBoxVB), placed by the SOF booster's row-major transform with BoosterScale
// (its length also x (0.5 + 0.5 intensity)); its back faces drawn, each ray through the box marched in 2..16 steps.
//
// At each step two layers: the point (x BoosterScale x the noise frequency, its z also x z^2 plus noise speed x time
// + the booster's wave phase) reads the 3D noise volume, which displaces the point by the noise amplitude lerped from
// start to end along -z; the layer's gradient at (-z, a row by intensity and warp) gives colour and radius; the shape
// atlas (the booster's atlas index) at xy / radius, inside 0..1, times the gradient and the layer's colour adds up.
// Numbers and colours lerp toward their warp forms by the warp intensity. The sum x |segment| x 0.667 / steps x
// smoothstep((intensity - 0.01) x 50); drawn added.
//
// The march is clipped, as the client's, to what lies in front of the near plane and of the scene's opaque depth at the
// pixel (softDepth.ts: the scene depth pass this material asks for; no depth test). Not as the client: no fog volume
// (no scene sets one), and the output stays linear (the client writes sRGB into an sRGB target).
import * as THREE from "three";
import { loadDds, loadDds3D } from "./ddsTexture.ts";
import { logDepth } from "./logDepth.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";
import { offerLights, type ChildLight } from "./dynamicLights.ts";

export interface BoosterShape { noiseSpeed: number; start: number[]; end: number[]; frequency: number[]; color: number[] }
export interface BoosterVolumetricData {
  /** shape0, shape1, warpShape0, warpShape1 */
  shapes: BoosterShape[];
  scale: number[];
  atlasHeight: number;
  atlasCount: number;
  shapeMap: string | null;
  gradient0: string | null;
  gradient1: string | null;
  noise: string | null;
  glowMap?: string | null;
  glowNoise?: string | null;
  light?: BoosterLightData | null;
}
/** The race's engine light (EveSOFDataBooster: lightRadius, lightWarpRadius, colours, flicker, lightOffset). */
export interface BoosterLightData { radius: number; warpRadius: number; color: number[]; warpColor: number[]; flickerAmplitude: number; flickerFrequency: number; offset: number }
export interface BoosterItem { transform: number[] | null; atlasIndex0?: number; atlasIndex1?: number; lightScale?: number }

// ComputeBoosterLightFlicker's noise: 128 random values, read at (phase + time) x frequency, lerped
const LIGHT_NOISE = Array.from({ length: 128 }, () => Math.random());
function lightFlicker(phase: number, amplitude: number, frequency: number, time: number): number {
  const p = (phase + time) * frequency;
  const i = Math.floor(p);
  const t = p - i;
  const a = LIGHT_NOISE[((i % 128) + 128) % 128]!, b = LIGHT_NOISE[(((i + 1) % 128) + 128) % 128]!;
  return 1 + amplitude * 2 * (a * (1 - t) + b * t) - amplitude;
}

/**
 * The engines' lights (EveBoosterSet2::GetLights / AddBoosterLights): per booster a point light at (0, 0, -lightOffset)
 * through its transform, radius = its width x lightScale x lerp(lightRadius, lightWarpRadius, warp) x intensity, colour
 * lerp(lightColor, lightWarpColor, warp) x its flicker; none at intensity nought. Offered each draw to the dynamic lights
 * (dynamicLights.ts) from the drawn flames (EVE space).
 */
function offerBoosterLights(renderer: THREE.WebGLRenderer, camera: THREE.Camera, object: THREE.Object3D, items: { at: number[]; radius: number; phase: number }[], light: BoosterLightData): void {
  const intensity = (object.userData.boosterIntensity as number | undefined) ?? 0;
  const warp = Math.min(1, Math.max(0, (object.userData.boosterWarp as number | undefined) ?? 0));
  if (intensity <= 0 || (light.radius <= 0 && light.warpRadius <= 0)) { object.userData.lights = []; offerLights(renderer, camera, object); return; }
  const factor = (light.radius * (1 - warp) + light.warpRadius * warp) * intensity;
  const color = [0, 1, 2].map((i) => (light.color[i] ?? 0) * (1 - warp) + (light.warpColor[i] ?? 0) * warp);
  const time = performance.now() / 1000;
  const records: ChildLight[] = (object.userData.lights ??= []) as ChildLight[];
  records.length = 0;
  for (const it of items) {
    const f = lightFlicker(it.phase, light.flickerAmplitude, light.flickerFrequency, time);
    records.push({ position: it.at, radius: it.radius * factor, color: color.map((c) => c * f), brightness: 1 });
  }
  offerLights(renderer, camera, object);
}

const VERTEX = `
attribute vec4 row0; attribute vec4 row1; attribute vec4 row2; attribute vec4 row3;
attribute float phase; attribute vec2 atlas;
uniform vec3 boosterScale; uniform float intensity;
varying vec3 vBox; varying vec3 vCamBox; varying float vPhase; varying vec2 vAtlas; varying vec4 vViewZ; varying float vIntensity;
#ifdef PER_AGENT
attribute float agentIntensity;
#endif
void main() {
#ifdef PER_AGENT
  // droneboostervolumetric: each agent's own intensity; its rows (the agent's rotation x its scale x BoosterScale, the
  // length also x (0.5 + 0.5 intensity), at its place) made on the CPU
  float I = agentIntensity;
  mat4 inst = mat4(row0, row1, row2, row3);
#else
  float I = intensity;
  // a row-major transform (x row0 + y row1 + z row2 + row3): its rows are this matrix's columns
  mat4 inst = mat4(row0 * boosterScale.x, row1 * boosterScale.y, row2 * boosterScale.z * (0.5 + 0.5 * clamp(I, 0.0, 1.0)), row3);
#endif
  vIntensity = I;
  mat4 boxToWorld = modelMatrix * inst;
  vBox = position;
  vCamBox = (inverse(boxToWorld) * vec4(cameraPosition, 1.0)).xyz;
  // the box point's view z: this row of box -> view
  mat4 boxToView = viewMatrix * boxToWorld;
  vViewZ = vec4(boxToView[0][2], boxToView[1][2], boxToView[2][2], boxToView[3][2]);
  vPhase = phase;
  vAtlas = atlas;
  gl_Position = I <= 0.0001 ? vec4(0.0) : projectionMatrix * viewMatrix * boxToWorld * vec4(position, 1.0);
}`;

const FRAGMENT = `
precision highp sampler3D;
${SOFT_DEPTH_GLSL}
uniform sampler2D shapeMap; uniform sampler2D gradient0; uniform sampler2D gradient1; uniform sampler3D noiseMap;
uniform vec2 atlasSize; uniform vec3 boosterScale; uniform float warp; uniform float time; varying float vIntensity;
uniform float nearZ;
uniform vec4 color0; uniform vec4 color1; uniform vec4 warpColor0; uniform vec4 warpColor1;
uniform vec4 start0; uniform vec4 end0; uniform vec4 freq0; uniform vec4 start1; uniform vec4 end1;
uniform vec4 wStart0; uniform vec4 wEnd0; uniform vec4 wFreq0; uniform vec4 wStart1; uniform vec4 wEnd1;
varying vec3 vBox; varying vec3 vCamBox; varying float vPhase; varying vec2 vAtlas; varying vec4 vViewZ;

float viewZ(vec3 p) { return dot(vViewZ, vec4(p, 1.0)); }

void main() {
  vec3 exitP = vBox;
  vec3 d = exitP - vCamBox;
  // the ray's entry: the latest of its crossings into the slabs x, y (-1..1) and z (-1..0)
  vec2 txy = vec2(d.x >= 0.0 ? (-1.0 - vCamBox.x) / d.x : (1.0 - vCamBox.x) / d.x, d.y >= 0.0 ? (-1.0 - vCamBox.y) / d.y : (1.0 - vCamBox.y) / d.y);
  float tz = d.z >= 0.0 ? (-1.0 - vCamBox.z) / d.z : -vCamBox.z / d.z;
  vec3 entry = vCamBox + d * max(max(txy.x, txy.y), tz);
  // clipped to what lies in front of the near plane (view z below -near)
  float ze = viewZ(entry), zx = viewZ(exitP);
  if (ze > -nearZ && zx > -nearZ) discard;
  if (ze > -nearZ) entry = mix(entry, exitP, (ze + nearZ) / (ze - zx));
  if (zx > -nearZ) exitP = mix(exitP, entry, (zx + nearZ) / (zx - ze));
  // and to what lies before the scene's surface at this pixel (its view distance)
  if (softDepthOn > 0.5) {
    float far = -softSceneDepth();
    ze = viewZ(entry); zx = viewZ(exitP);
    if (ze < far && zx < far) discard;
    if (ze < far) entry = mix(entry, exitP, (ze - far) / (ze - zx));
    if (zx < far) exitP = mix(exitP, entry, (zx - far) / (zx - ze));
  }
  vec3 seg = exitP - entry;
  if (dot(seg, seg) < 0.00001) discard;

  vec4 c0 = mix(color0, warpColor0, warp), c1 = mix(color1, warpColor1, warp);
  vec3 s0 = mix(start0.xyz, wStart0.xyz, warp), e0 = mix(end0.xyz, wEnd0.xyz, warp);
  vec4 f0 = mix(freq0, wFreq0, warp);
  vec3 s1 = mix(start1.xyz, wStart1.xyz, warp);
  vec4 e1 = mix(end1, wEnd1, warp);
  float phase0 = f0.w * time + vPhase, phase1 = e1.w * time + vPhase;
  // the atlas rows: count shapes of height / count texels each, half a texel in
  float rowSpan = (atlasSize.x / atlasSize.y - 1.0) / atlasSize.x;
  vec2 rowStart = vAtlas / atlasSize.y + 0.5 / atlasSize.x;
  float intensity = vIntensity;
  float s = clamp(intensity * 0.5, 0.0, 1.0);
  float gradV = warp > 0.0 ? 0.5625 + 0.375 * s : 0.0625 + 0.375 * s;

  int n = max(int(min(length(vec3(seg.xy, seg.z * 2.0)), 1.0) * 16.0), 2);
  vec3 step = seg / float(n - 1);
  vec4 sum = vec4(0.0);
  vec3 p = entry;
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    vec3 q = p * boosterScale * f0.xyz;
    float zz = p.z * p.z;
    // layer 0
    vec3 n0 = texture(noiseMap, vec3(q.xy, q.z * zz + phase0)).xyz - 0.5;
    vec3 p0 = n0 * (s0 + (-p.z) * (e0 - s0)) + p;
    vec4 g0 = textureLod(gradient0, vec2(-p0.z, gradV), 0.0);
    if (g0.w > 0.0 && (g0.x > 0.0 || g0.y > 0.0 || g0.z > 0.0)) {
      vec2 uv = p0.xy / g0.w * 0.5 + 0.5;
      vec4 shape = vec4(0.0);
      if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) shape = textureLod(shapeMap, vec2(uv.x, uv.y * rowSpan + rowStart.x), 0.1 / g0.w / g0.w);
      sum += g0 * shape * c0;
    }
    // layer 1
    vec3 n1 = texture(noiseMap, vec3(q.xy, q.z * zz + phase1)).xyz - 0.5;
    vec3 p1 = n1 * (s1 + (-p.z) * (e1.xyz - s1)) + p;
    vec4 g1 = textureLod(gradient1, vec2(-p1.z, gradV), 0.0);
    if (g1.w > 0.0 && (g1.x > 0.0 || g1.y > 0.0 || g1.z > 0.0)) {
      vec2 uv = p1.xy / g1.w * 0.5 + 0.5;
      vec4 shape = vec4(0.0);
      if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) shape = textureLod(shapeMap, vec2(uv.x, uv.y * rowSpan + rowStart.y), 0.1 / g1.w / g1.w);
      sum += g1 * shape * c1;
    }
    p += step;
  }
  sum *= length(seg * boosterScale) * 0.666667 / float(n);
  float k = clamp((intensity - 0.01) * 50.0, 0.0, 1.0);
  sum *= k * k * (3.0 - 2.0 * k);
  gl_FragColor = vec4(max(sum.xyz, vec3(0.0)), sum.w);
}`;

const v4 = (a: number[] | undefined) => new THREE.Vector4(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0, a?.[3] ?? 0);

/**
 * The hull's flames, one instanced mesh (in EVE's space: put it under a z mirror), or null where the race has no
 * volumetric booster data or its textures are missing. Its intensity and warp set through setBoosterIntensity.
 */
export async function volumetricBoosters(items: BoosterItem[], vol: BoosterVolumetricData | null | undefined): Promise<THREE.Mesh | null> {
  if (!vol?.shapeMap || !vol.gradient0 || !vol.gradient1 || !vol.noise) return null;
  const placed = items.filter((b) => b.transform && b.transform.length >= 16);
  if (!placed.length) return null;
  const [shapeMap, gradient0, gradient1, noise] = await Promise.all([loadDds(vol.shapeMap), loadDds(vol.gradient0), loadDds(vol.gradient1), loadDds3D(vol.noise)]).catch(() => [null, null, null, null]);
  if (!shapeMap || !gradient0 || !gradient1 || !noise) return null;
  // sRGB reads: ShapeMap and GradientMap0 (their resources' flags), GradientMap1 linear
  shapeMap.colorSpace = THREE.SRGBColorSpace;
  gradient0.colorSpace = THREE.SRGBColorSpace;
  for (const t of [gradient0, gradient1]) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; }
  shapeMap.wrapS = shapeMap.wrapT = THREE.ClampToEdgeWrapping;
  shapeMap.needsUpdate = true;
  noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
  noise.minFilter = noise.magFilter = THREE.LinearFilter;
  noise.needsUpdate = true;

  // the box: six quads, as GetBoxVB lists them
  const corners = [
    [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0],
    [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1],
    [-1, -1, 0], [-1, 1, 0], [-1, 1, -1], [-1, -1, -1],
    [1, -1, 0], [1, -1, -1], [1, 1, -1], [1, 1, 0],
    [-1, -1, 0], [-1, -1, -1], [1, -1, -1], [1, -1, 0],
    [-1, 1, 0], [1, 1, 0], [1, 1, -1], [-1, 1, -1],
  ];
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
  const index: number[] = [];
  for (let q = 0; q < 6; q++) index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  geo.setIndex(index);
  const rows = [0, 1, 2, 3].map(() => new Float32Array(placed.length * 4));
  const phase = new Float32Array(placed.length), atlas = new Float32Array(placed.length * 2);
  placed.forEach((b, i) => {
    const t = b.transform!;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) rows[r]![i * 4 + c] = t[r * 4 + c]!;
    // RebuildInstanceData: a random wave phase each
    phase[i] = Math.random();
    atlas[i * 2] = b.atlasIndex0 ?? 0;
    atlas[i * 2 + 1] = b.atlasIndex1 ?? 0;
  });
  rows.forEach((r, i) => geo.setAttribute(`row${i}`, new THREE.InstancedBufferAttribute(r, 4)));
  geo.setAttribute("phase", new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute("atlas", new THREE.InstancedBufferAttribute(atlas, 2));
  geo.instanceCount = placed.length;

  const [sh0, sh1, w0, w1] = vol.shapes;
  const scale = new THREE.Vector3(vol.scale[0] ?? 1, vol.scale[1] ?? 1, vol.scale[2] ?? 1);
  const mat = logDepth(new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT,
    uniforms: {
      shapeMap: { value: shapeMap }, gradient0: { value: gradient0 }, gradient1: { value: gradient1 }, noiseMap: { value: noise },
      atlasSize: { value: new THREE.Vector2(vol.atlasHeight || 64, vol.atlasCount || 2) }, boosterScale: { value: scale },
      intensity: { value: 0 }, warp: { value: 0 }, time: { value: 0 }, nearZ: { value: 0.1 }, ...SOFT_DEPTH,
      // ShapeN's colour; NoiseAmplitudeStart/End, NoiseFrequency with NoiseSpeed in .w (the effect's packing: speed 0
      // after the frequency, speed 1 after the end amplitude)
      color0: { value: v4(sh0?.color) }, color1: { value: v4(sh1?.color) }, warpColor0: { value: v4(w0?.color) }, warpColor1: { value: v4(w1?.color) },
      start0: { value: v4(sh0?.start) }, end0: { value: v4(sh0?.end) }, freq0: { value: v4([...(sh0?.frequency ?? [0, 0, 0]).slice(0, 3), sh0?.noiseSpeed ?? 0]) },
      start1: { value: v4(sh1?.start) }, end1: { value: v4([...(sh1?.end ?? [0, 0, 0]).slice(0, 3), sh1?.noiseSpeed ?? 0]) },
      wStart0: { value: v4(w0?.start) }, wEnd0: { value: v4(w0?.end) }, wFreq0: { value: v4([...(w0?.frequency ?? [0, 0, 0]).slice(0, 3), w0?.noiseSpeed ?? 0]) },
      wStart1: { value: v4(w1?.start) }, wEnd1: { value: v4([...(w1?.end ?? [0, 0, 0]).slice(0, 3), w1?.noiseSpeed ?? 0]) },
    },
    // CULLMODE cw: the box's back faces; ZENABLE off (the march clips to the scene depth instead); added
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  }));
  // the scene's opaque depth drawn for it (softDepth.ts)
  mat.userData.softDepth = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "booster-volumetric";
  mesh.frustumCulled = false;
  // the lights' places, sizes and phases (EveBoosterSet2::Add)
  const lightItems = placed.map((b) => {
    const t = b.transform!;
    const off = -(vol.light?.offset ?? 0);
    return {
      at: [t[8]! * off + t[12]!, t[9]! * off + t[13]!, t[10]! * off + t[14]!],
      radius: Math.max(Math.hypot(t[0]!, t[1]!, t[2]!), Math.hypot(t[4]!, t[5]!, t[6]!)) * (b.lightScale ?? 1),
      phase: 128 * Math.random(),
    };
  });
  // (on the material: a model clone keeps its materials, not its meshes' callbacks)
  mat.onBeforeRender = (renderer, _s, camera, _g, object) => {
    if (vol.light) offerBoosterLights(renderer, camera, object, lightItems, vol.light);
    mat.uniforms.time!.value = performance.now() / 1000;
    mat.uniforms.nearZ!.value = (camera as THREE.PerspectiveCamera).near ?? 0.1;
    // this ship's (the material is every clone's)
    mat.uniforms.intensity!.value = (object.userData.boosterIntensity as number | undefined) ?? 0;
    mat.uniforms.warp!.value = (object.userData.boosterWarp as number | undefined) ?? 0;
  };
  return mesh;
}

/** The flames' intensity (EveBoosterSet2's overall intensity) and warp intensity. */
export function setBoosterIntensity(mesh: THREE.Object3D, intensity: number, warp = 0): void {
  // (kept on the mesh, read as it is drawn)
  mesh.userData.boosterIntensity = intensity;
  mesh.userData.boosterWarp = warp;
}

/** The race's glow numbers (EveSOFDataBooster: the glow and the two halos, their warp colours). */
export interface BoosterGlowData {
  glowColor: number[] | null; warpGlowColor?: number[] | null; glowScale: number | null;
  haloColor: number[] | null; warpHaloColor?: number[] | null; symHaloScale?: number | null; haloScaleX: number | null; haloScaleY: number | null;
}

const GLOW_VERTEX = `
attribute vec2 corner; attribute vec3 offset; attribute vec2 size; attribute float blinkPhase;
attribute vec3 color; attribute vec3 warpColor;
uniform float gain; uniform float warp; uniform float time; uniform float haloFacing; uniform sampler2D glowNoise;
uniform vec2 viewport;
varying vec2 vUv; varying vec4 vColor; varying vec2 vCenterPx; varying float vDist;
void main() {
  vec4 view = modelViewMatrix * vec4(offset, 1.0);
  vec4 centre = projectionMatrix * view;
  vCenterPx = (centre.xy / centre.w * 0.5 + 0.5) * viewport;
  vDist = -view.z;
  // a quad facing the view, width x height, x the gain (at most 1)
  view.xy += corner * size * min(gain, 1.0);
  gl_Position = projectionMatrix * view;
  vUv = corner + 0.5;
  // the halos (blink phase 1 + seed) fade as the ship's z turns from the view: (-zDir . view forward)^2
  float facing = blinkPhase < 1.0 ? 1.0 : haloFacing;
  float flicker = textureLod(glowNoise, vec2(time * 0.5 + blinkPhase, 0.0), 0.0).x * 0.2 + 0.8;
  vColor = vec4(mix(color, warpColor, warp), 1.0) * facing * facing * gain * flicker;
}`;

const GLOW_FRAGMENT = `
${SOFT_DEPTH_GLSL}
uniform sampler2D glowMap;
varying vec2 vUv; varying vec4 vColor; varying vec2 vCenterPx; varying float vDist;
float hidden(vec2 at) { return softSceneDepthAt(at) <= vDist ? 1.0 : 0.0; }
void main() {
  vec4 tex = texture2D(glowMap, vUv);
  // how much of the sprite's centre the scene hides: the centre (x3) and four points 2 pixels off it, of 7
  float seen = 1.0;
  if (softDepthOn > 0.5) {
    float n = 3.0 * hidden(vCenterPx) + hidden(vCenterPx + vec2(-2.0, -2.0)) + hidden(vCenterPx + vec2(2.0, -2.0))
      + hidden(vCenterPx + vec2(-2.0, 2.0)) + hidden(vCenterPx + vec2(2.0, 2.0));
    seen = 1.0 - n / 7.0;
  }
  vec4 c = tex * seen * vColor * 4.0;
  gl_FragColor = vec4(max(c.xyz, vec3(0.0)), c.w);
}`;

/**
 * The engines' glow sprites (EveSOF CreateGlow and CreateBoosterFlares, EveSpriteSet::AddBoosterGlowToQuadRenderer,
 * BoosterGlowAnimated.fx disassembled): per booster, from its transform's position and z row (its length; shortened
 * where its width is under 3), a glow at - 2.5 z of glowScale x width and two halos at - 3 z - one symHaloScale square,
 * one haloScaleX by haloScaleY - each a view-facing quad of whitesharp.dds, its colour (RGBA8: 0..1) lerped to the warp
 * colour, x the booster gain, x 0.8..1 noise flicker, x 4, the halos x (-ship z . view forward)^2, hidden as the scene
 * depth covers its centre; added, no depth test. In EVE's space, as the flames.
 */
export async function boosterGlows(items: BoosterItem[], data: BoosterGlowData | null | undefined, maps: { glowMap?: string | null; glowNoise?: string | null } | null | undefined): Promise<THREE.Mesh | null> {
  if (!data || !maps?.glowMap || !maps.glowNoise) return null;
  const placed = items.filter((b) => b.transform && b.transform.length >= 16);
  if (!placed.length) return null;
  const [glowMap, glowNoise] = await Promise.all([loadDds(maps.glowMap), loadDds(maps.glowNoise)]).catch(() => [null, null]);
  if (!glowMap || !glowNoise) return null;
  glowMap.colorSpace = THREE.SRGBColorSpace;
  glowMap.needsUpdate = true;
  glowNoise.wrapS = glowNoise.wrapT = THREE.RepeatWrapping;
  glowNoise.needsUpdate = true;
  const c01 = (c: number[] | null | undefined) => [0, 1, 2].map((i) => Math.min(1, Math.max(0, c?.[i] ?? 0)));
  const sprites: { at: number[]; size: number[]; phase: number; color: number[]; warp: number[] }[] = [];
  for (const b of placed) {
    const t = b.transform!;
    const pos = [t[12]!, t[13]!, t[14]!];
    let dir = [t[8]!, t[9]!, t[10]!];
    const len = Math.hypot(...dir) || 1;
    dir = dir.map((x) => x / len);
    const scale = Math.max(Math.hypot(t[0]!, t[1]!, t[2]!), Math.hypot(t[4]!, t[5]!, t[6]!));
    if (scale < 3) dir = dir.map((x) => x * scale / 3);
    const seed = Math.random() * 0.7;
    const along = (k: number) => pos.map((p, i) => p - k * dir[i]!);
    sprites.push({ at: along(2.5), size: [scale * (data.glowScale ?? 1), scale * (data.glowScale ?? 1)], phase: seed, color: c01(data.glowColor), warp: c01(data.warpGlowColor) });
    sprites.push({ at: along(3.0), size: [scale * (data.symHaloScale ?? 1), scale * (data.symHaloScale ?? 1)], phase: 1 + seed, color: c01(data.haloColor), warp: c01(data.warpHaloColor) });
    sprites.push({ at: along(3.01), size: [scale * (data.haloScaleX ?? 1), scale * (data.haloScaleY ?? 1)], phase: 1 + seed, color: c01(data.haloColor), warp: c01(data.warpHaloColor) });
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("corner", new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
  const inst = (key: keyof (typeof sprites)[number], n: number) => new THREE.InstancedBufferAttribute(new Float32Array(sprites.flatMap((s) => { const v = s[key]; return Array.isArray(v) ? v : [v]; })), n);
  geo.setAttribute("offset", inst("at", 3));
  geo.setAttribute("size", inst("size", 2));
  geo.setAttribute("blinkPhase", inst("phase", 1));
  geo.setAttribute("color", inst("color", 3));
  geo.setAttribute("warpColor", inst("warp", 3));
  geo.instanceCount = sprites.length;
  const mat = logDepth(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT,
    uniforms: {
      glowMap: { value: glowMap }, glowNoise: { value: glowNoise }, gain: { value: 0 }, warp: { value: 0 }, time: { value: 0 },
      haloFacing: { value: 0 }, viewport: { value: new THREE.Vector2(1, 1) }, ...SOFT_DEPTH,
    },
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  }));
  mat.userData.softDepth = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "booster-glows";
  mesh.frustumCulled = false;
  const shipZ = new THREE.Vector3(), forward = new THREE.Vector3(), size = new THREE.Vector2();
  // (on the material: a model clone keeps its materials, not its meshes' callbacks; the drawn clone is the object)
  mat.onBeforeRender = (renderer, _s, camera, _g, object) => {
    mat.uniforms.time!.value = performance.now() / 1000;
    mat.uniforms.viewport!.value.copy(renderer.getDrawingBufferSize(size));
    // the ship's z (its EVE axis, through the mirror) against the view's forward
    shipZ.set(0, 0, 1).transformDirection(object.matrixWorld);
    mat.uniforms.gain!.value = (object.userData.glowGain as number | undefined) ?? 0;
    mat.uniforms.warp!.value = (object.userData.glowWarp as number | undefined) ?? 0;
    camera.getWorldDirection(forward);
    mat.uniforms.haloFacing!.value = -shipZ.dot(forward);
  };
  return mesh;
}

/** The glows' gain (the booster intensity, at most 1: an 8-bit alpha) and warp. */
export function setGlowGain(mesh: THREE.Object3D, gain: number, warp = 0): void {
  // (kept on the mesh, read as it is drawn)
  mesh.userData.glowGain = Math.min(1, Math.max(0, gain));
  mesh.userData.glowWarp = Math.min(1, Math.max(0, warp));
}

/** A behaviour group's booster (BehaviorGroupBooster): its offset, atlas rows, its effect's textures and numbers. */
export interface AgentBoosterData {
  offset: number[];
  atlas: number[];
  textures: Record<string, string | null>;
  params: Record<string, unknown>;
}

/**
 * A behaviour group's flames (droneboostervolumetric.fx, BehaviorGroup::GetBoosterInfoForBuffer): an instanced box per
 * agent, its rows written each frame by the group's run (setAgentBoosters); the effect's numbers its file's, else the
 * shader's defaults (the groups' files give none: ShapeAtlasSize (64, 2), colours 1, no noise amplitude). No warp.
 */
export async function agentBoosters(data: AgentBoosterData, capacity: number): Promise<THREE.Mesh | null> {
  const t = data.textures;
  const shape = t.ShapeMap ?? null, g0 = t.GradientMap0 ?? null, g1 = t.GradientMap1 ?? null, noiseUrl = t.NoiseMap ?? null;
  if (!shape || !g0 || !g1 || !noiseUrl) return null;
  const [shapeMap, gradient0, gradient1, noise] = await Promise.all([loadDds(shape), loadDds(g0), loadDds(g1), loadDds3D(noiseUrl)]).catch(() => [null, null, null, null]);
  if (!shapeMap || !gradient0 || !gradient1 || !noise) return null;
  shapeMap.colorSpace = THREE.SRGBColorSpace;
  gradient0.colorSpace = THREE.SRGBColorSpace;
  for (const x of [shapeMap, gradient0, gradient1]) { x.wrapS = x.wrapT = THREE.ClampToEdgeWrapping; x.needsUpdate = true; }
  noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
  noise.minFilter = noise.magFilter = THREE.LinearFilter;
  noise.needsUpdate = true;
  const p = data.params;
  const v = (name: string, def: number[]) => { const x = p[name]; return new THREE.Vector4(...((Array.isArray(x) ? (x as number[]) : def).concat([0, 0, 0, 0]).slice(0, 4) as [number, number, number, number])); };
  const f = (name: string, def: number) => (typeof p[name] === "number" ? (p[name] as number) : def);
  // the shader's defaults (droneboostervolumetric.sm_depth's constants)
  const freq = v("NoiseFrequency0", [0.2, 0.2, 0.1]);
  freq.w = f("NoiseSpeed0", 1);
  const end1 = v("NoiseAmplitudeEnd1", [0, 0, 0]);
  end1.w = f("NoiseSpeed1", 1);
  const atlas = (Array.isArray(p.ShapeAtlasSize) ? (p.ShapeAtlasSize as number[]) : [64, 2]);
  const bs = (Array.isArray(p.BoosterScale) ? (p.BoosterScale as number[]) : [1, 1, 1]);
  const mat = logDepth(new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, defines: { PER_AGENT: "" },
    uniforms: {
      shapeMap: { value: shapeMap }, gradient0: { value: gradient0 }, gradient1: { value: gradient1 }, noiseMap: { value: noise },
      atlasSize: { value: new THREE.Vector2(atlas[0] ?? 64, atlas[1] ?? 2) }, boosterScale: { value: new THREE.Vector3(bs[0] ?? 1, bs[1] ?? 1, bs[2] ?? 1) },
      intensity: { value: 0 }, warp: { value: 0 }, time: { value: 0 }, nearZ: { value: 0.1 }, ...SOFT_DEPTH,
      color0: { value: v("Color0", [1, 1, 1, 1]) }, color1: { value: v("Color1", [1, 1, 1, 1]) }, warpColor0: { value: new THREE.Vector4() }, warpColor1: { value: new THREE.Vector4() },
      start0: { value: v("NoiseAmplitudeStart0", [0, 0, 0]) }, end0: { value: v("NoiseAmplitudeEnd0", [0, 0, 0]) }, freq0: { value: freq },
      start1: { value: v("NoiseAmplitudeStart1", [0, 0, 0]) }, end1: { value: end1 },
      wStart0: { value: new THREE.Vector4() }, wEnd0: { value: new THREE.Vector4() }, wFreq0: { value: new THREE.Vector4() },
      wStart1: { value: new THREE.Vector4() }, wEnd1: { value: new THREE.Vector4() },
    },
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  }));
  mat.userData.softDepth = true;
  mat.onBeforeRender = (_r, _s, camera) => {
    mat.uniforms.time!.value = performance.now() / 1000;
    mat.uniforms.nearZ!.value = (camera as THREE.PerspectiveCamera).near ?? 0.1;
  };
  const mesh = new THREE.Mesh(agentBoxGeometry(capacity), mat);
  mesh.name = "agent-boosters";
  mesh.frustumCulled = false;
  mesh.userData.boosterOffset = data.offset;
  mesh.userData.boosterAtlas = data.atlas;
  return mesh;
}

/** The box geometry with room for `capacity` agents' instance data (none drawn yet). */
export function agentBoxGeometry(capacity: number): THREE.InstancedBufferGeometry {
  const corners = [
    [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1],
    [-1, -1, 0], [-1, 1, 0], [-1, 1, -1], [-1, -1, -1], [1, -1, 0], [1, -1, -1], [1, 1, -1], [1, 1, 0],
    [-1, -1, 0], [-1, -1, -1], [1, -1, -1], [1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, 1, -1], [-1, 1, -1],
  ];
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
  const index: number[] = [];
  for (let q = 0; q < 6; q++) index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  geo.setIndex(index);
  const n = Math.max(1, capacity);
  for (let r = 0; r < 4; r++) geo.setAttribute(`row${r}`, new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
  geo.setAttribute("phase", new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  geo.setAttribute("atlas", new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
  geo.setAttribute("agentIntensity", new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  geo.instanceCount = 0;
  return geo;
}

/**
 * One agent's flame into slot k (GetBoosterInfoForBuffer, LOD under 0.3): its booster at the group's offset x scale
 * through the agent, the agent's rotation, scale x BoosterScale, the length also x (0.5 + 0.5 intensity); intensity
 * |velocity| / max(1, maxVelocity); a random phase by the agent's id.
 */
export function setAgentBooster(geo: THREE.InstancedBufferGeometry, k: number, at: THREE.Vector3, rotation: THREE.Quaternion, scale: number, boosterScale: THREE.Vector3, intensity: number, phase: number, atlas: number[]): void {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
  const e = m.elements;
  // the rotation's rows as D3D has them (a row vector times the matrix: three's columns)
  const len = 0.5 + 0.5 * intensity;
  const rows = [
    [e[0]! * scale * boosterScale.x, e[1]! * scale * boosterScale.x, e[2]! * scale * boosterScale.x, 0],
    [e[4]! * scale * boosterScale.y, e[5]! * scale * boosterScale.y, e[6]! * scale * boosterScale.y, 0],
    [e[8]! * scale * boosterScale.z * len, e[9]! * scale * boosterScale.z * len, e[10]! * scale * boosterScale.z * len, 0],
    [at.x, at.y, at.z, 1],
  ];
  for (let r = 0; r < 4; r++) (geo.getAttribute(`row${r}`) as THREE.InstancedBufferAttribute).set(rows[r]!, k * 4);
  (geo.getAttribute("phase") as THREE.InstancedBufferAttribute).setX(k, phase);
  (geo.getAttribute("atlas") as THREE.InstancedBufferAttribute).setXY(k, atlas[0] ?? 0, atlas[1] ?? 0);
  (geo.getAttribute("agentIntensity") as THREE.InstancedBufferAttribute).setX(k, intensity);
}
