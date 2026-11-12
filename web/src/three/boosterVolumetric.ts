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
}
export interface BoosterItem { transform: number[] | null; atlasIndex0?: number; atlasIndex1?: number }

const VERTEX = `
attribute vec4 row0; attribute vec4 row1; attribute vec4 row2; attribute vec4 row3;
attribute float phase; attribute vec2 atlas;
uniform vec3 boosterScale; uniform float intensity;
varying vec3 vBox; varying vec3 vCamBox; varying float vPhase; varying vec2 vAtlas; varying vec4 vViewZ;
void main() {
  // a row-major transform (x row0 + y row1 + z row2 + row3): its rows are this matrix's columns
  mat4 inst = mat4(row0 * boosterScale.x, row1 * boosterScale.y, row2 * boosterScale.z * (0.5 + 0.5 * clamp(intensity, 0.0, 1.0)), row3);
  mat4 boxToWorld = modelMatrix * inst;
  vBox = position;
  vCamBox = (inverse(boxToWorld) * vec4(cameraPosition, 1.0)).xyz;
  // the box point's view z: this row of box -> view
  mat4 boxToView = viewMatrix * boxToWorld;
  vViewZ = vec4(boxToView[0][2], boxToView[1][2], boxToView[2][2], boxToView[3][2]);
  vPhase = phase;
  vAtlas = atlas;
  gl_Position = intensity <= 0.0001 ? vec4(0.0) : projectionMatrix * viewMatrix * boxToWorld * vec4(position, 1.0);
}`;

const FRAGMENT = `
precision highp sampler3D;
${SOFT_DEPTH_GLSL}
uniform sampler2D shapeMap; uniform sampler2D gradient0; uniform sampler2D gradient1; uniform sampler3D noiseMap;
uniform vec2 atlasSize; uniform vec3 boosterScale; uniform float intensity; uniform float warp; uniform float time;
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
  mesh.onBeforeRender = (_r, _s, camera) => {
    mat.uniforms.time!.value = performance.now() / 1000;
    mat.uniforms.nearZ!.value = (camera as THREE.PerspectiveCamera).near ?? 0.1;
  };
  return mesh;
}

/** The flames' intensity (EveBoosterSet2's overall intensity) and warp intensity. */
export function setBoosterIntensity(mesh: THREE.Object3D, intensity: number, warp = 0): void {
  const mat = (mesh as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
  if (!mat?.uniforms?.intensity) return;
  mat.uniforms.intensity.value = intensity;
  mat.uniforms.warp!.value = warp;
}
