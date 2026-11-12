// A hull's children (EveSOFDataHull.children, read by tools/client-extract/lib/children.mjs): the static part of the
// client's EveChild* graph, in EVE's model space, mirrored in z here as the model is. Drawn so far: the containers'
// transforms, the quads (EveChildQuad with flarequad.fx / flarequadsoft.fx) and a station's traffic (an EveChildMesh on
// a Tr2InstancedMesh with traffic.fx). Other meshes, line sets, particle systems, lights, curve sets and state machines
// are later stages.

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";
import { uberDistortionMaterial, DISTORTION_LAYER } from "./distortion.ts";
import { ControllerRun, type SofController } from "./controllers.ts";
import { particleObject, type SofChildParticles } from "./particles.ts";
import { GpuEmitter, gpuSystemOf, type GpuEmitterData } from "./gpuParticles.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";
import { HULL_TEXTURE_ROLES, fxHullMaterial, sofHullMaterial, setControllerVariable, setOwnerActivation, setClipSphere, type SofArea } from "./hullModel.ts";
import { loadDds, loadDds3D } from "./ddsTexture.ts";
import { ChildAnimator, HULL_OWNER, animators, type SofCurveSet } from "./childAnimation.ts";
import { addOverlay, removeOverlay, type SofOverlay } from "./hullOverlay.ts";
import { PropagatorRun, type PropagatorData } from "./propagator.ts";
import { offerLights, type ChildLight } from "./dynamicLights.ts";
import { AgentRun, buildAgents, type SofChildAgents } from "./behaviorAgents.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export interface SofChildQuad {
  k: "quad";
  id?: number;
  /** false: hidden in its file, shown by a curve set (as display below, for each kind) */
  display?: boolean;
  name: string | null;
  m: number[];
  color: number[];
  brightness: number;
  minScreenSize: number;
  effect: string | null;
}
export interface SofChildContainer {
  k: "container";
  id?: number;
  display?: boolean;
  t?: number[];
  r?: number[];
  s?: number[];
  curveSets?: SofCurveSet[];
  name: string | null;
  m: number[] | null;
  modifiers: string[];
  srt?: SofChildSrt | null;
  objects: SofChildNode[];
  /** Its lights (Tr2PointLight, Tr2SpotLight, Tr2FactionLight: children.mjs readLight), in its own space. */
  lights?: { id?: number; position: number[]; radius: number; innerRadius: number; color: number[]; brightness: number; rotation?: number[]; innerAngle?: number; outerAngle?: number }[];
  /** Its controllers (controllers.ts), run with it as their owner. */
  controllers?: SofController[];
  /** Its fx attributes (EveCameraFxAttributes, EveSpaceObjectFxAttributes): values gathered each frame for its sets. */
  fxAttributes?: { id: number; type: string }[];
  /**
   * Placed from outside each frame (a stretch's source, stretch, move and dest objects): a group of its own (its id as
   * childId), its quads in a quad mesh of its own and its lights kept on it (userData.lights), all in its own space.
   */
  live?: boolean;
}
export interface SofChildTraffic {
  k: "traffic";
  name: string | null;
  m: number[];
  /** Eight numbers an instance: offset x, y, z, path; size, speed, colour mix, phase. */
  instances: number[] | null;
  params: Record<string, number[] | number | null>;
  textures: Record<string, string | null>;
}
export interface SofChildMeshArea {
  id?: number;
  paramIds?: Record<string, number>;
  kind: "opaque" | "transparent" | "additive" | "distortion";
  name: string | null;
  index: number;
  count: number;
  effect: string;
  options: Record<string, string>;
  params: Record<string, number[] | number | null>;
  textures: Record<string, string | null>;
}
export interface SofChildMesh {
  k: "mesh";
  id?: number;
  display?: boolean;
  t?: number[];
  r?: number[];
  s?: number[];
  name: string | null;
  m: number[];
  geometry: string | null;
  meshIndex: number;
  minScreenSize: number;
  modifiers?: string[];
  srt?: SofChildSrt | null;
  areas: SofChildMeshArea[];
}
/** An EveChildModifierSRT's own transform. */
export interface SofChildSrt { id?: number; translation: number[]; rotation: number[]; scaling: number[] }
export interface SofChildLines {
  k: "lines";
  id?: number;
  display?: boolean;
  name: string | null;
  m: number[];
  baseColor: number[];
  animColor: number[];
  brightness: number;
  additive: boolean;
  widthFactor: number;
  scrollSpeed?: number;
  effect: string | null;
  textures: Record<string, string | null>;
  curves: { m: number[]; p1: number[]; c: number[]; p2: number[]; segments: number; width: number }[];
}
/** An EveChildParticleSystem's GPU emitters (children.mjs): they emit into the scene's GPU particle system. */
export interface SofChildGpuParticles {
  k: "gpuParticles";
  id?: number;
  display?: boolean;
  name: string | null;
  m: number[];
  emitters: GpuEmitterData[];
  modifiers?: string[];
}
/** An EveChildEffectPropagator (children.mjs): its locators, trigger method and settings, and its instance container's source (propagator.ts runs it). */
export interface SofChildPropagator extends PropagatorData {
  k: "propagator";
  id?: number;
  display?: boolean;
  name: string | null;
  m: number[] | null;
  source: SofChildNode;
}
/**
 * An EveChildProceduralContainer cycling its children (EveProceduralMethodCycling, children.mjs): each a child effect
 * (its EveChildRef file, by path) shown for its duration, restarted when shown where restart is set.
 */
export interface SofChildProcedural {
  k: "procedural";
  id?: number;
  display?: boolean;
  name: string | null;
  m: number[] | null;
  modifiers: string[];
  srt?: SofChildSrt | null;
  startOffset: number;
  randomize: boolean;
  items: { effect: string; duration: number; restart: boolean }[];
}
export type SofChildNode = SofChildQuad | SofChildContainer | SofChildTraffic | SofChildMesh | SofChildLines | SofChildParticles | SofChildPropagator | SofChildGpuParticles | SofChildProcedural | SofChildAgents;
export interface SofHullChild {
  res: string;
  root: SofChildNode | null;
  skipped: Record<string, number | string>;
}

/** The average length of a matrix's three axes (flarequad's vertex stage: its world matrix's scale, a third of each). */
function meanScale(m: THREE.Matrix4): number {
  const e = m.elements;
  return (Math.hypot(e[0]!, e[1]!, e[2]!) + Math.hypot(e[4]!, e[5]!, e[6]!) + Math.hypot(e[8]!, e[9]!, e[10]!)) / 3;
}

/**
 * The quads as flarequad.fx draws them (its sm_hi vertex and pixel stages disassembled, client 3396210), one instance
 * each: the quad's middle (its translation) through its parents' transforms and the eye's; its corners (+-0.5) along
 * the quad's own x and y axes (its rotation and scaling), times the mean scale of its parents' world transform, laid
 * on in the eye's space (a billboard turned and shaped by the quad's own transform); its colour colour x brightness,
 * times (asin(c) / (pi/2))^2 for c the cosine of its angle off the eye's axis (dimmer toward the screen's edge). The
 * pixel: (1 / (d + 0.001) - 0.999001) x 1.001 for d the distance from the middle (1 at the edge), added; its t0,
 * the scene's fog volume map by depth slice (EveSceneFogVolumeMap: the colour times 1 minus it), is EveChildCloud2's
 * only, the client's empty map black where none is drawn (as here: the factor 1). flarequadsoft.fx is drawn as
 * flarequad.fx. A quad under minScreenSize pixels across is not drawn.
 */
export function quadMesh(quads: { centre: THREE.Vector3; ax: THREE.Vector3; ay: THREE.Vector3; colour: number[]; min: number; halo: { z: THREE.Vector3; at: THREE.Vector3 } | null }[]): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const n = quads.length;
  const centre = new Float32Array(n * 3), ax = new Float32Array(n * 3), ay = new Float32Array(n * 3), colour = new Float32Array(n * 4), min = new Float32Array(n);
  const haloZ = new Float32Array(n * 4), haloAt = new Float32Array(n * 3);
  quads.forEach((q, i) => {
    q.centre.toArray(centre, i * 3); q.ax.toArray(ax, i * 3); q.ay.toArray(ay, i * 3);
    colour.set(q.colour.slice(0, 4), i * 4); min[i] = q.min;
    if (q.halo) { q.halo.z.toArray(haloZ, i * 4); haloZ[i * 4 + 3] = 1; q.halo.at.toArray(haloAt, i * 3); }
  });
  geo.setAttribute("iCentre", new THREE.InstancedBufferAttribute(centre, 3));
  geo.setAttribute("iAxisX", new THREE.InstancedBufferAttribute(ax, 3));
  geo.setAttribute("iAxisY", new THREE.InstancedBufferAttribute(ay, 3));
  geo.setAttribute("iColour", new THREE.InstancedBufferAttribute(colour, 4));
  geo.setAttribute("iMin", new THREE.InstancedBufferAttribute(min, 1));
  geo.setAttribute("iHaloZ", new THREE.InstancedBufferAttribute(haloZ, 4));
  geo.setAttribute("iHaloAt", new THREE.InstancedBufferAttribute(haloAt, 3));
  geo.instanceCount = n;
  const viewHeight = { value: 1080 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { viewHeight },
    vertexShader: `attribute vec3 iCentre; attribute vec3 iAxisX; attribute vec3 iAxisY; attribute vec4 iColour; attribute float iMin;
      attribute vec4 iHaloZ; attribute vec3 iHaloAt;
      uniform float viewHeight; varying vec2 vUv; varying vec4 vColour;
      void main() {
        vUv = uv;
        float s = (length(modelMatrix[0].xyz) + length(modelMatrix[1].xyz) + length(modelMatrix[2].xyz)) / 3.0;
        vec4 mv = modelViewMatrix * vec4(iCentre, 1.0);
        // under an EveChildModifierHalo container: its axes, so the quad's size, times max(z . d, 0)^2 (z the
        // container's axis, d the way from it to the eye, in the hull's EVE space)
        if (iHaloZ.w > 0.5) {
          vec3 eye = (inverse(modelViewMatrix) * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float h = max(dot(normalize(iHaloZ.xyz), normalize(eye - iHaloAt)), 0.0);
          s *= h * h;
        }
        vec3 ax = iAxisX * s, ay = iAxisY * s;
        float c = clamp(-normalize(mv.xyz).z, 0.0, 1.0);
        float f = asin(c) * 0.63662;
        vColour = iColour * f * f;
        // the quad's size on the screen, in pixels, against its minScreenSize
        float px = min(length(ax), length(ay)) * projectionMatrix[1][1] * 0.5 * viewHeight / max(-mv.z, 1e-6);
        if (px < iMin) vColour = vec4(0.0);
        mv.xyz += ax * position.x + ay * position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying vec2 vUv; varying vec4 vColour;
      void main() {
        float d = min(length((vUv - 0.5) * 2.0), 1.0);
        float k = (1.0 / (d + 0.001) - 0.999001) * 1.001;
        gl_FragColor = k * vColour;
      }`,
    // both sides: the corners are laid on in the eye's space, which the mirror in z does not turn, while three.js
    // takes the mirrored model's front faces as clockwise (every quad was culled)
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "child-quads";
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  const size = new THREE.Vector2();
  // on the material, which a clone of the model shares (Object3D.clone does not carry an object's own onBeforeRender)
  mat.onBeforeRender = (renderer) => { viewHeight.value = renderer.getDrawingBufferSize(size).y; };
  return mesh;
}

const v4 = (v: unknown, d: number[]) => new THREE.Vector4(...([0, 1, 2, 3].map((i) => (Array.isArray(v) && typeof v[i] === "number" ? (v[i] as number) : d[i]!)) as [number, number, number, number]));

/**
 * A station's traffic as traffic.fx draws it (its sm_hi stages disassembled, client 3396210; TextureProperties c0,
 * SpriteSizes c1, SpriteProperties c2, GlowColor1 c3, GlowColor2 c4): each instance a sprite running along one of the
 * PositionMap's paths (three rows a path, x y z in metres, TextureProperties.y rows, wrapping along its width):
 * at frac(speed x TextureProperties.z x time + phase), plus TextureProperties.w x its offset; its size the unit
 * plane's corner x its size x SpriteSizes.xy, times pow(|z|, SpriteProperties.x) x SpriteProperties.y for z its depth
 * in the eye's space (laid on there); its colour GlowColor1 to GlowColor2 by its mix, times
 * saturate(SpriteProperties.z / -z). The second pass, the engines: the sprite sized by its size x SpriteSizes.zw x how
 * far the way it came points toward the eye (the path a texel back, by the speed's sign), in GlowColor1. The pixel
 * TexMap x colour, its alpha over the colour, added. The fog volume map's factor is 1 (as flarequad.fx's).
 */
function trafficMeshes(node: SofChildTraffic): THREE.Object3D | null {
  const inst = node.instances;
  if (!inst?.length || !node.textures.PositionMap) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const buf = new THREE.InstancedInterleavedBuffer(Float32Array.from(inst), 8);
  geo.setAttribute("iA", new THREE.InterleavedBufferAttribute(buf, 4, 0));
  geo.setAttribute("iB", new THREE.InterleavedBufferAttribute(buf, 4, 4));
  geo.instanceCount = inst.length / 8;
  const p = node.params;
  const uniforms = {
    // the clock read as the uniform is (a model is drawn as a clone, and a clone has no onBeforeRender of its own)
    posMap: { value: null as THREE.Texture | null }, texMap: { value: null as THREE.Texture | null }, time: { get value() { return performance.now() / 1000; } },
    texProps: { value: v4(p.TextureProperties, [256, 33, 0.025, 12]) }, sizes: { value: v4(p.SpriteSizes, [1, 1, 1, 1]) },
    spriteProps: { value: v4(p.SpriteProperties, [1, 1, 1e9, 1]) },
    glow1: { value: v4(p.GlowColor1, [1, 1, 1, 1]) }, glow2: { value: v4(p.GlowColor2, [1, 1, 1, 1]) },
  };
  void loadDds(node.textures.PositionMap).then((t) => { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; uniforms.posMap.value = t; }).catch(() => undefined);
  if (node.textures.TexMap) void loadDds(node.textures.TexMap).then((t) => { uniforms.texMap.value = t; }).catch(() => undefined);
  const head = `attribute vec4 iA; attribute vec4 iB;
      uniform sampler2D posMap; uniform float time; uniform vec4 texProps; uniform vec4 sizes; uniform vec4 spriteProps;
      uniform vec4 glow1; uniform vec4 glow2; varying vec2 vUv; varying vec4 vColour;
      vec3 pathAt(float u, float row) {
        return vec3(texture2D(posMap, vec2(u, (row + 0.5) / texProps.y)).r, texture2D(posMap, vec2(u, (row + 1.5) / texProps.y)).r,
          texture2D(posMap, vec2(u, (row + 2.5) / texProps.y)).r);
      }`;
  const body = (engines: boolean) => `
        vUv = uv;
        float row = fract(iA.w * 3.0 / texProps.y) * texProps.y;
        float u = fract(iB.y * texProps.z * time + iB.w);
        vec3 at = pathAt(u, row);
        vec4 mv = modelViewMatrix * vec4(texProps.w * iA.xyz + at, 1.0);
        float k = pow(abs(mv.z), spriteProps.x) * spriteProps.y;
        ${engines ? `vec3 back = normalize(pathAt(fract(u - sign(iB.y) / texProps.x), row) - at);
        // the eye's z axis (toward the eye) in the model's space
        vec3 eye = normalize(transpose(mat3(modelMatrix)) * vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
        mv.xy += position.xy * clamp(dot(eye, back), 0.0, 1.0) * iB.x * sizes.zw * k;
        vColour = clamp(-spriteProps.z / mv.z, 0.0, 1.0) * glow1;` : `mv.xy += position.xy * iB.x * sizes.xy * k;
        vColour = clamp(-spriteProps.z / mv.z, 0.0, 1.0) * mix(glow1, glow2, iB.z);`}
        gl_Position = projectionMatrix * mv;`;
  const group = new THREE.Group();
  group.name = "child-traffic";
  for (const engines of [false, true]) {
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `${head}
      void main() {${body(engines)}
      }`,
      fragmentShader: `uniform sampler2D texMap; varying vec2 vUv; varying vec4 vColour;
      void main() {
        vec4 t = texture2D(texMap, vUv);
        gl_FragColor = vec4(t.rgb * vColour.rgb, 1.0) * t.a;
      }`,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });
    logDepth(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = engines ? "traffic-engines" : "traffic";
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    group.add(mesh);
  }
  return group;
}

const gltfLoader = new GLTFLoader();
const glbCache = new Map<string, Promise<THREE.Object3D | null>>();
const childTextures = new Map<string, Promise<THREE.Texture | null>>();
const childTexture = (url: string | null | undefined) => {
  if (!url) return Promise.resolve(null);
  if (!childTextures.has(url)) childTextures.set(url, loadDds(url).then((t) => t as THREE.Texture).catch(() => null));
  return childTextures.get(url)!;
};
const effectClock = { get value() { return performance.now() / 1000; } };

/**
 * An area drawn with ubershader.fx as its REGULAR variation does (its sm_hi permutations disassembled, client
 * 3396210): DIFFUSE_MAP_COUNT diffuse maps (the option, else as many as the area carries; the files leave the default,
 * two, unsaid), each at uv x TextureTransformN.zw + TextureTransformN.xy + TextureScrollN.xy x time +
 * TextureScrollN.zw, and the MaskMap at the plain uv (MASK_TRANSFORM OFF) or by MaskTransform and MaskScroll (ON),
 * clamped where MASK_TEXTURE_SAMPLING is CLAMP; a read that is nought in all four channels discards the pixel; the
 * reads multiplied together and by DiffuseColor; the colour (not the alpha) times the fresnel f = (1 - sat(N.V -
 * F.z))^F.x x F.y, or (1 - min(f, 1)) x -F.y where F.y < 0 (F FresnelFactors, N the world normal unnormalised by the
 * inverse transpose, as the client's, V toward the eye); alpha saturated. The PHONG variation lights the colour first:
 * times sunColour x l + ambient, l = (N.L + 1) / 2 x (1 - (1 - sat(N.L))^2), L toward the sun (the scene's first
 * directional light, its colour x intensity; the ambient light's). UBER_DEPTH_ON fades it where it meets the scene:
 * colour and alpha times sat((D - z) / (s / 2)), D the scene's depth at the pixel (its DepthMap: softDepth.ts), z the
 * pixel's own depth from a point Depth metres (the effect's "Depth In Meters", 10 unless set) along the world's z,
 * s the length of the world transform's z axis. Additive areas added (one, one), transparent ones blended over. The
 * scene fog volume map (EveSceneFogVolumeMap, a colour times 1 minus it) is drawn by EveChildCloud2 only, none of
 * them drawn here: the client's empty map is black, the factor 1.
 */
function uberMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const maps = ["DiffuseMap1", "DiffuseMap2", "DiffuseMap3"].filter((k) => area.textures[k]).length;
  const count = ({ ONE: 1, TWO: 2, THREE: 3 } as Record<string, number>)[area.options.DIFFUSE_MAP_COUNT ?? ""] ?? Math.max(1, maps);
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock,
    // the file's defaults (its header's constant values): DiffuseColor 0.8, FresnelFactors (1, 1, 0, 0)
    colour: { value: v4(p.DiffuseColor, [0.8, 0.8, 0.8, 1]) }, fresnel: { value: v4(p.FresnelFactors, [1, 1, 0, 0]) },
    maskT: { value: v4(p.MaskTransform, [0, 0, 1, 1]) }, maskS: { value: v4(p.MaskScroll, [0, 0, 0, 0]) },
    mask: { value: null },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColour: { value: new THREE.Color(1, 1, 1) }, ambient: { value: new THREE.Color(0, 0, 0) },
  };
  for (let i = 1; i <= 3; i++) {
    uniforms[`t${i}`] = { value: v4(p[`TextureTransform${i}`], [0, 0, 1, 1]) };
    uniforms[`s${i}`] = { value: v4(p[`TextureScroll${i}`], [0, 0, 0, 0]) };
    uniforms[`d${i}`] = { value: null };
  }
  for (let i = 1; i <= count; i++) void childTexture(area.textures[`DiffuseMap${i}`]).then((t) => { uniforms[`d${i}`]!.value = t; });
  void childTexture(area.textures.MaskMap).then((t) => { uniforms.mask!.value = t; });
  const read = (i: number) => `vec4 r${i} = texture2D(d${i}, vUv * t${i}.zw + t${i}.xy + s${i}.xy * time + s${i}.zw);
        if (dot(r${i}, r${i}) == 0.0) discard;
        c *= r${i};`;
  const maskUv = area.options.MASK_TRANSFORM === "ON" ? "vUv * maskT.zw + maskT.xy + maskS.xy * time + maskS.zw" : "vUv";
  const additive = area.kind === "additive";
  const soft = area.options.UBER_DEPTH === "UBER_DEPTH_ON";
  if (soft) Object.assign(uniforms, SOFT_DEPTH, { depthOffset: { value: Number((p.Depth as number[] | undefined)?.[0] ?? 10) } });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      ${soft ? "uniform float depthOffset; varying vec2 vSoft;" : ""}
      void main() {
        vUv = uv;
        vN = mat3(modelMatrix) * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFromEye = (vec4(mv.xyz, 0.0) * viewMatrix).xyz;
        ${soft ? `// half the z axis' length, and the depth of the point Depth metres along EVE's world z (three's -z)
        vSoft = vec2(0.5 * length(modelMatrix[2].xyz), -(mv.z + (viewMatrix * vec4(0.0, 0.0, -depthOffset, 0.0)).z));` : ""}
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `${soft ? SOFT_DEPTH_GLSL + " varying vec2 vSoft;" : ""}
      uniform sampler2D d1; uniform sampler2D d2; uniform sampler2D d3; uniform sampler2D mask;
      uniform vec4 t1; uniform vec4 t2; uniform vec4 t3; uniform vec4 s1; uniform vec4 s2; uniform vec4 s3;
      uniform vec4 maskT; uniform vec4 maskS; uniform vec4 colour; uniform vec4 fresnel; uniform float time;
      uniform vec3 sunDir; uniform vec3 sunColour; uniform vec3 ambient;
      varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        vec4 c = vec4(1.0);
        ${[1, 2, 3].filter((i) => i <= count).map(read).join("\n        ")}
        vec2 mUv = ${maskUv};
        ${area.options.MASK_TEXTURE_SAMPLING === "CLAMP" ? "mUv = clamp(mUv, 0.0, 1.0);" : ""}
        vec4 m = texture2D(mask, mUv);
        if (dot(m, m) == 0.0) discard;
        c *= m * colour;
        ${area.options.VARIATION === "PHONG" ? `float nl = dot(normalize(sunDir), normalize(vN));
        float l = (nl + 1.0) * 0.5 * (1.0 - pow(1.0 - clamp(nl, 0.0, 1.0), 2.0));
        c.rgb *= sunColour * l + ambient;` : ""}
        float f = pow(1.0 - clamp(dot(normalize(-vFromEye), normalize(vN)) - fresnel.z, 0.0, 1.0), fresnel.x);
        f = fresnel.y < 0.0 ? (1.0 - min(f, 1.0)) * -fresnel.y : f * fresnel.y;
        c.rgb *= f;
        ${soft ? "if (softDepthOn > 0.5) c *= clamp((softSceneDepth() - vSoft.y) / vSoft.x, 0.0, 1.0);" : ""}
        gl_FragColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
      }`,
    side: THREE.FrontSide, transparent: true, depthWrite: false,
    ...(additive
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  if (area.options.VARIATION === "PHONG") {
    mat.onBeforeRender = (_r, scene) => {
      let sun: THREE.DirectionalLight | null = null, amb: THREE.AmbientLight | null = null;
      scene.traverse((o) => {
        if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight;
        if (!amb && (o as THREE.AmbientLight).isAmbientLight) amb = o as THREE.AmbientLight;
      });
      const s = sun as THREE.DirectionalLight | null, a = amb as THREE.AmbientLight | null;
      if (s) {
        (uniforms.sunDir!.value as THREE.Vector3).copy(s.position).sub(s.target.position).normalize();
        (uniforms.sunColour!.value as THREE.Color).copy(s.color).multiplyScalar(s.intensity);
      }
      if (a) (uniforms.ambient!.value as THREE.Color).copy(a.color).multiplyScalar(a.intensity);
    };
  }
  if (soft) mat.userData.softDepth = true;
  logDepth(mat);
  return mat;
}

/**
 * An area drawn with fx3dv5.fx (its sm_hi stages disassembled, client 3396210; its MASK_TYPE option
 * VERTEX_POSITION_MASK_TYPE, the default here, or UV_MASK_TYPE): two reads of the 3D LayerAllMap at the point in the
 * mesh's own space, p x LayerNTransform.x + LayerNTransform.yzw + frac(LayerNScroll.x x time) + LayerNScroll.yzw, its
 * red channel for the first and green for the second, multiplied; the LayerMaskMap read at the distance from
 * Layer3Center (or the uv) x Layer3Transform.xy + .zw + frac(Layer3Scroll.xy x time) + .zw; the colour
 * layers x (mask rgb, 1) x BaseColor + mask alpha x FxColor, its rgb times the fresnel (as ubershader.fx's); added
 * (one, one) for an additive area. The fog volume map's factor is 1 (as flarequad.fx's).
 */
function fx3dMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock, layers: { value: null }, mask: { value: null },
    base: { value: v4(p.BaseColor, [1, 1, 1, 1]) }, fx: { value: v4(p.FxColor, [0, 0, 0, 0]) },
    fresnel: { value: v4(p.FresnelFactors, [0, 1, 0, 0]) }, centre: { value: v4(p.Layer3Center, [0, 0, 0, 0]) },
  };
  for (let i = 1; i <= 3; i++) {
    uniforms[`t${i}`] = { value: v4(p[`Layer${i}Transform`], [1, 0, 0, 0]) };
    uniforms[`s${i}`] = { value: v4(p[`Layer${i}Scroll`], [0, 0, 0, 0]) };
  }
  if (area.textures.LayerAllMap) {
    void loadDds3D(area.textures.LayerAllMap).then((t) => { uniforms.layers!.value = t; }).catch(() => undefined);
  }
  void childTexture(area.textures.LayerMaskMap).then((t) => { uniforms.mask!.value = t; });
  const byUv = area.options.MASK_TYPE === "UV_MASK_TYPE";
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vObj; varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        vObj = position; vUv = uv;
        vN = mat3(modelMatrix) * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFromEye = (vec4(mv.xyz, 0.0) * viewMatrix).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `precision highp sampler3D;
      uniform sampler3D layers; uniform sampler2D mask; uniform float time;
      uniform vec4 t1; uniform vec4 t2; uniform vec4 t3; uniform vec4 s1; uniform vec4 s2; uniform vec4 s3;
      uniform vec4 base; uniform vec4 fx; uniform vec4 fresnel; uniform vec4 centre;
      varying vec3 vObj; varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        float f = pow(1.0 - clamp(dot(normalize(-vFromEye), normalize(vN)) - fresnel.z, 0.0, 1.0), fresnel.x);
        f = fresnel.y < 0.0 ? (1.0 - min(f, 1.0)) * -fresnel.y : f * fresnel.y;
        float a = texture(layers, vObj * t1.x + t1.yzw + fract(s1.x * time) + s1.yzw).r;
        float b = texture(layers, vObj * t2.x + t2.yzw + fract(s2.x * time) + s2.yzw).g;
        vec2 mUv = ${byUv ? "vUv * t3.xy + t3.zw" : "length(vObj - centre.xyz) * t3.xy + t3.zw"} + fract(s3.xy * time) + s3.zw;
        vec4 m = texture2D(mask, mUv);
        vec4 c = a * b * vec4(m.rgb, 1.0) * base + m.a * fx;
        gl_FragColor = vec4(c.rgb * f, c.a);
      }`,
    side: presetSide(area), transparent: true, depthWrite: false,
    ...(area.kind === "additive"
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  logDepth(mat);
  return mat;
}

/**
 * A child line set (EveChildLineSet on an EveCurveLineSet, lines3d.fx), as trinity fills its vertices
 * (_trinity_dx11.dll, Ghidra: Tr2CurveLineSet::FillVertexBuffer at 0x180c29220, its segment writer 0x180c28460, and
 * EveBezierCurve's submit 0x1802db1d0 / 0x1802d6070):
 * - each EveBezierCurve a quadratic from point1 through bezierPoint to point2 (in its own transform), cut in
 *   `segments` pieces, each piece its own straight line (AddStraightLine) whose t runs 0 to 1 along it;
 * - a line a quad lineWidth x the set's lineWidthFactor wide in pixels (lines3d.fx's vertex stage, by the viewport's
 *   size), carried past each end by its half width (where the caps fall);
 * - the pixel: colour = gradient x TexMap.rgb + OverlayTexMap.rgb x animation colour, alpha = TexMap.a x gradient.a
 *   x (1 + animation.a x (overlay.a - 1)); TexMap read across the line, OverlayTexMap across it and along at
 *   (speed x time + t) x scale (scale 1, as the curve's ChangeLineAnimation call gives it); added for an additive set.
 * The gradient colour is baseColor x brightness, the animation colour animColor x brightness and the speed the set's
 * scrollSpeed (EveChildLineSet.cpp's AddLinesToSet). No curve sets a multicolour. The fog volume
 * map's factor is 1 (as flarequad.fx's).
 */
function lineSet(node: SofChildLines, animator?: ChildAnimator, ancestors: number[] = []): THREE.Object3D | null {
  const pos: number[] = [], other: number[] = [], side: number[] = [], end: number[] = [], width: number[] = [], index: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const curve of node.curves) {
    const m = new THREE.Matrix4().fromArray(curve.m);
    const p1 = new THREE.Vector3(...(curve.p1 as [number, number, number])).applyMatrix4(m);
    const cp = new THREE.Vector3(...(curve.c as [number, number, number])).applyMatrix4(m);
    const p2 = new THREE.Vector3(...(curve.p2 as [number, number, number])).applyMatrix4(m);
    const n = Math.max(1, Math.round(curve.segments));
    const at = (t: number, out: THREE.Vector3) => out.copy(p1).multiplyScalar((1 - t) * (1 - t)).addScaledVector(cp, 2 * (1 - t) * t).addScaledVector(p2, t * t);
    const w = curve.width * node.widthFactor;
    for (let i = 0; i < n; i++) {
      at(i / n, a);
      at((i + 1) / n, b);
      // a segment's four corners: its start and its end, each on both sides; each knows the other end
      const base = pos.length / 3;
      for (const [p, q, e] of [[a, b, 0], [b, a, 1]] as [THREE.Vector3, THREE.Vector3, number][]) {
        for (const s of [-1, 1]) { pos.push(p.x, p.y, p.z); other.push(q.x, q.y, q.z); side.push(s); end.push(e); width.push(w); }
      }
      index.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }
  if (!index.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aOther", new THREE.Float32BufferAttribute(other, 3));
  geo.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
  geo.setAttribute("aEnd", new THREE.Float32BufferAttribute(end, 1));
  geo.setAttribute("aWidth", new THREE.Float32BufferAttribute(width, 1));
  geo.setIndex(index);
  const bc = node.baseColor, ac = node.animColor, k = node.brightness;
  const uniforms = {
    tex: { value: null as THREE.Texture | null }, overlay: { value: null as THREE.Texture | null },
    viewport: { value: new THREE.Vector2(1920, 1080) }, time: effectClock, speed: { value: node.scrollSpeed ?? 0 },
    // EveChildLineSet.cpp: AddLinesToSet(baseColor x brightness, animColor x brightness, scrollSpeed), a colour times a
    // number being all four of its components times it
    colour: { value: new THREE.Vector4((bc[0] ?? 1) * k, (bc[1] ?? 1) * k, (bc[2] ?? 1) * k, (bc[3] ?? 1) * k) },
    anim: { value: new THREE.Vector4((ac[0] ?? 0) * k, (ac[1] ?? 0) * k, (ac[2] ?? 0) * k, (ac[3] ?? 1) * k) },
  };
  void childTexture(node.textures.TexMap).then((t) => { uniforms.tex.value = t; });
  void childTexture(node.textures.OverlayTexMap).then((t) => { uniforms.overlay.value = t; });
  if (animator && node.id !== undefined) animator.lines(node.id, uniforms.colour, uniforms.anim, node.baseColor, node.animColor, node.brightness, ancestors, node.display !== false);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `attribute vec3 aOther; attribute float aSide; attribute float aEnd; attribute float aWidth;
      uniform vec2 viewport; varying float vAcross; varying float vAlong;
      void main() {
        vec4 c0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 c1 = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
        vec2 s0 = c0.xy / c0.w * viewport, s1 = c1.xy / c1.w * viewport;
        vec2 dir = s0 - s1;
        dir = dot(dir, dir) > 1e-12 ? normalize(dir) : vec2(1.0, 0.0);
        vec2 n = vec2(-dir.y, dir.x);
        // across by the side, and on past this end by the half width
        c0.xy += (n * aSide * (2.0 * aEnd - 1.0) + dir) * aWidth / viewport * c0.w;
        // (the offset above is the same side of the line at both ends: the side's own sign, not flipped)
        vAcross = aSide * 0.5 + 0.5;
        vAlong = aEnd;
        gl_Position = c0;
      }`,
    fragmentShader: `uniform sampler2D tex; uniform sampler2D overlay; uniform vec4 colour; uniform vec4 anim; uniform float time; uniform float speed;
      varying float vAcross; varying float vAlong;
      void main() {
        vec4 t = texture2D(tex, vec2(vAcross, 0.5));
        vec4 o = texture2D(overlay, vec2(vAcross, speed * time + vAlong));
        gl_FragColor = vec4(colour.rgb * t.rgb + o.rgb * anim.rgb, t.a * colour.a * (1.0 + anim.a * (o.a - 1.0)));
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    ...(node.additive
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  const size = new THREE.Vector2();
  mat.onBeforeRender = (renderer) => { renderer.getDrawingBufferSize(size); uniforms.viewport.value.set(size.x, size.y); };
  logDepth(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `child-lines:${node.name ?? ""}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

/**
 * A child mesh: its geometry file (extracted as a hull's, so in our mirrored space: mirrored back here, the group
 * above mirroring it again), the mesh of its meshIndex, each triangle group drawn by the area whose index range
 * holds it (Tr2MeshArea index, count); groups no area names are not drawn.
 */
/** An effect parameter's name to its material's uniform (ubershader.fx's and fx3dv5.fx's). */
/**
 * An area drawn with motionvectorramp.fx (its sm_hi records disassembled, client 3396210; the defaults and the
 * textures' sRGB reads from the file's header, as carbonengine/trinity Tr2EffectRes and Tr2EffectDescription read it),
 * in the two permutations the client's child meshes use: the default (record 0: INTERPOLATION_ENABLED, no diffuse
 * maps, COLORMAP_RAMP, no mask, no texture transform) and record 19 (INTERPOLATION_DISABLED, DIFFUSE_MAP_COUNT ONE,
 * MASK_ENABLED). A flipbook: TextureMap an atlas of AtlasInfo.x by .y frames played over AtlasInfo.z seconds of
 * CurrentTime, frame frac(time / .z) x frames;
 * - interpolated: past the end the last frame where .w, cycling, is not above nought; the frame and the next blended
 *   by the fraction between them, each first pushed along GradientMap's motion vectors (the frame's .xy x the
 *   fraction, the next's .zw x 1 - it, x 2 - 1, times Colors.w);
 * - not: the frame alone, unpushed;
 * its red read through ColorRampMap at sat((v - Colors.x) / (Colors.y - Colors.x)), times Colors.z; alpha its alpha x
 * the ramp's alpha times the fresnel (as ubershader.fx's), saturated; with the mask, times MaskMap at the uv; with a
 * diffuse map, times DiffuseMap1 at uv x TextureTransform1.zw + .xy + TextureScroll1.xy x time + .zw (a read nought
 * in all four channels discards the pixel); the colour written sRGB-encoded (the per-frame gamma 1). TextureMap and
 * ColorRampMap are read as sRGB (decoded here after filtering), the rest as they are. The fog volume map's factor
 * is 1.
 */
function motionVectorRampMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const o = area.options;
  const interpolate = (o.INTERPOLATION ?? "INTERPOLATION_ENABLED") === "INTERPOLATION_ENABLED";
  const diffuse = (o.DIFFUSE_MAP_COUNT ?? "ZERO") === "ONE";
  const masked = (o.MASK ?? "MASK_DISABLED") === "MASK_ENABLED";
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock,
    fresnel: { value: v4(p.FresnelFactors, [1, 1, 0, 0]) }, atlas: { value: v4(p.AtlasInfo, [6, 6, 10, 1]) },
    colors: { value: v4(p.Colors, [0, 1, 1, 0.01]) }, currentTime: { value: typeof p.CurrentTime === "number" ? p.CurrentTime : 0 },
    t1: { value: v4(p.TextureTransform1, [0, 0, 1, 1]) }, s1: { value: v4(p.TextureScroll1, [0, 0, 0, 0]) },
    textureMap: { value: null }, rampMap: { value: null }, gradientMap: { value: null }, d1: { value: null }, mask: { value: null },
  };
  // its TextureMap, GradientMap and ColorRampMap samplers clamp (MaskMapClampedSampler, ColorRampMapSampler): in the
  // shader; DiffuseMap1 and MaskMap wrap
  void childTexture(area.textures.TextureMap).then((t) => { uniforms.textureMap!.value = t; });
  void childTexture(area.textures.ColorRampMap).then((t) => { uniforms.rampMap!.value = t; });
  if (interpolate) void childTexture(area.textures.GradientMap).then((t) => { uniforms.gradientMap!.value = t; });
  if (diffuse) void childTexture(area.textures.DiffuseMap1).then((t) => { uniforms.d1!.value = t; });
  if (masked) void childTexture(area.textures.MaskMap).then((t) => { uniforms.mask!.value = t; });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        vUv = uv;
        vN = mat3(modelMatrix) * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFromEye = (vec4(mv.xyz, 0.0) * viewMatrix).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D textureMap; uniform sampler2D rampMap; uniform sampler2D gradientMap; uniform sampler2D d1; uniform sampler2D mask;
      uniform vec4 fresnel; uniform vec4 atlas; uniform vec4 colors; uniform float currentTime; uniform vec4 t1; uniform vec4 s1; uniform float time;
      varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      vec3 decode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
      vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
      ${CLAMP_GLSL}
      vec2 cell(float f) {
        float row = min(atlas.y - 1.0, floor(f / atlas.x));
        return vec2(min(atlas.x - 1.0, floor(f - row * atlas.x)), row);
      }
      void main() {
        ${diffuse ? `vec4 dm = texture2D(d1, vUv * t1.zw + t1.xy + s1.xy * time + s1.zw);
        if (dot(dm, dm) == 0.0) discard;` : ""}
        float frames = atlas.x * atlas.y;
        float at = frames * fract(currentTime / atlas.z);
        float f0 = floor(at);
        vec2 uv = clamp(vUv, 0.0, 1.0);
        ${interpolate ? `float last = frames - 1.0;
        float f1 = atlas.w > 0.0 ? (f0 + 1.0 >= frames ? 0.0 : f0 + 1.0) : min(f0 + 1.0, last);
        float k = fract(at);
        if (currentTime >= atlas.z && atlas.w <= 0.0) { f0 = last; f1 = last; }
        vec2 c0 = cell(f0), c1 = cell(f1);
        vec4 mv = vec4(0.0);
        if (colors.w > 0.0) {
          mv.xy = (texture2D(gradientMap, clampUv(gradientMap, (uv + c0) / atlas.xy)).xy * 2.0 - 1.0) * k;
          mv.zw = (texture2D(gradientMap, clampUv(gradientMap, (uv + c1) / atlas.xy)).zw * 2.0 - 1.0) * (1.0 - k);
          mv *= colors.w;
        }
        vec4 a = texture2D(textureMap, clampUv(textureMap, (clamp(vUv - mv.xy, 0.0, 1.0) + c0) / atlas.xy));
        vec4 b = texture2D(textureMap, clampUv(textureMap, (clamp(vUv + mv.zw, 0.0, 1.0) + c1) / atlas.xy));
        vec2 v = mix(vec2(decode(a.rgb).r, a.a), vec2(decode(b.rgb).r, b.a), k);` : `vec4 a = texture2D(textureMap, clampUv(textureMap, (uv + cell(f0)) / atlas.xy));
        vec2 v = vec2(decode(a.rgb).r, a.a);`}
        vec4 ramp = texture2D(rampMap, clampUv(rampMap, vec2(clamp((v.x - colors.x) / (colors.y - colors.x), 0.0, 1.0), 0.0)));
        float f = pow(1.0 - clamp(dot(normalize(-vFromEye), normalize(vN)) - fresnel.z, 0.0, 1.0), fresnel.x);
        f = fresnel.y < 0.0 ? (1.0 - min(f, 1.0)) * -fresnel.y : f * fresnel.y;
        vec4 c = vec4(decode(ramp.rgb) * colors.z, clamp(v.y * ramp.a * f, 0.0, 1.0));
        ${masked ? "c *= texture2D(mask, vUv);" : ""}
        ${diffuse ? "c *= dm;" : ""}
        gl_FragColor = vec4(encode(max(c.rgb, 0.0)), c.a);
      }`,
    side: presetSide(area), transparent: true, depthWrite: false,
    ...areaBlend(area),
  });
  logDepth(mat);
  return mat;
}

/**
 * An area drawn with ubershadercube.fx (its one record, .sm_depth and .sm_hi alike, disassembled, client 3396210;
 * defaults from its header): DiffuseMap1 and DiffuseMap2 at uv x TextureTransformN.zw + .xy + TextureScrollN.xy x
 * time + .zw, MaskMap at the plain uv, all three multiplied; the world normal (normalised) pushed by that product's rgb
 * x ScaleAlongNormal and normalised; the per-frame camera forward (EveSpaceSceneDataPS ViewMat's third column, cb2[6])
 * reflected about it - reflect(-forward, n) - read from MainCubeMap; the colour that x DiffuseColor.rgb, alpha the
 * product's alpha x DiffuseColor.a (the fog volume map's factor 1); written sRGB-encoded (the per-frame gamma 1). No
 * texture is read as sRGB. Defaults DiffuseColor 0.8, 0.8, 0.8, 1; TextureTransforms 0, 0, 1, 1; the rest nought.
 */
function uberCubeMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock, colour: { value: v4(p.DiffuseColor, [0.8, 0.8, 0.8, 1]) },
    t1: { value: v4(p.TextureTransform1, [0, 0, 1, 1]) }, t2: { value: v4(p.TextureTransform2, [0, 0, 1, 1]) },
    s1: { value: v4(p.TextureScroll1, [0, 0, 0, 0]) }, s2: { value: v4(p.TextureScroll2, [0, 0, 0, 0]) },
    alongNormal: { value: new THREE.Vector3(...([0, 1, 2].map((i) => (Array.isArray(p.ScaleAlongNormal) ? Number(p.ScaleAlongNormal[i]) || 0 : 0)) as [number, number, number])) },
    d1: { value: null }, d2: { value: null }, mask: { value: null }, cube: { value: null }, hasCube: { value: 0 },
  };
  void childTexture(area.textures.DiffuseMap1).then((t) => { uniforms.d1!.value = t; });
  void childTexture(area.textures.DiffuseMap2).then((t) => { uniforms.d2!.value = t; });
  void childTexture(area.textures.MaskMap).then((t) => { uniforms.mask!.value = t; });
  void childTexture(area.textures.MainCubeMap).then((t) => { if (t && (t as THREE.CubeTexture).isCubeTexture) { uniforms.cube!.value = t; uniforms.hasCube!.value = 1; } });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; varying vec3 vN;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform sampler2D d1; uniform sampler2D d2; uniform sampler2D mask; uniform samplerCube cube; uniform float hasCube;
      uniform vec4 colour; uniform vec4 t1; uniform vec4 t2; uniform vec4 s1; uniform vec4 s2; uniform vec3 alongNormal; uniform float time;
      varying vec2 vUv; varying vec3 vN;
      ${SRGB_ENCODE_GLSL}
      void main() {
        vec4 c = texture2D(d1, vUv * t1.zw + t1.xy + s1.xy * time + s1.zw) * texture2D(d2, vUv * t2.zw + t2.xy + s2.xy * time + s2.zw)
          * texture2D(mask, vUv);
        vec3 n = normalize(c.rgb * alongNormal + vN);
        // the camera's forward (its look direction) in the world: three's camera looks down its -z
        vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        vec3 r = reflect(-forward, n);
        vec3 env = hasCube > 0.5 ? textureCube(cube, vec3(r.x, r.y, -r.z)).rgb : vec3(0.0);
        gl_FragColor = vec4(encode(max(env * colour.rgb, 0.0)), c.a * colour.a);
      }`,
    side: presetSide(area), transparent: true, depthWrite: false,
    ...areaBlend(area),
  });
  logDepth(mat);
  return mat;
}

/**
 * The cull an area's batch gives an effect that sets none (carbonengine/trinity Tr2EffectStateManager.cpp's presets):
 * a transparent area's alpha preset culls CW (three's FrontSide: the hull's opaque preset culls CW too and the hulls
 * are drawn FrontSide), an additive area's culls none.
 */
const presetSide = (area: SofChildMeshArea) => (area.kind === "additive" ? THREE.DoubleSide : THREE.FrontSide);
const areaBlend = (area: SofChildMeshArea) => (area.kind === "additive"
  ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
  : { blending: THREE.NormalBlending });
/** A sampler's clamp-to-edge, in the shader (the texture objects are shared between materials). */
const CLAMP_GLSL = "vec2 clampUv(sampler2D t, vec2 uv) { vec2 h = 0.5 / vec2(textureSize(t, 0)); return clamp(uv, h, 1.0 - h); }";
const SRGB_ENCODE_GLSL = "vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }";
const PLAIN_VS = `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * An area drawn with ubershadertwosided.fx (its sm_hi disassembled, client 3396210; defaults and states from its file
 * by tools/client-extract/shaders/fxres.py): two passes of one shader, the first culling CW and the second CCW (both
 * faces, the front first); DiffuseMap1 at uv x TextureTransform1.zw + .xy + TextureScroll1.xy x time + .zw, DiffuseMap2
 * likewise, MaskMap at the plain uv (clamped), multiplied, times DiffuseColor and the fresnel of the vertex (as
 * ubershader.fx's, from its normal and the way to the eye), alpha too. Defaults DiffuseColor 0.8, FresnelFactors
 * (1, 1, 0, 0), transforms (0, 0, 1, 1). The back pass is userData.backPass (same uniforms).
 */
function twoSidedUberMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock,
    colour: { value: v4(p.DiffuseColor, [0.8, 0.8, 0.8, 1]) }, fresnel: { value: v4(p.FresnelFactors, [1, 1, 0, 0]) },
    t1: { value: v4(p.TextureTransform1, [0, 0, 1, 1]) }, t2: { value: v4(p.TextureTransform2, [0, 0, 1, 1]) },
    s1: { value: v4(p.TextureScroll1, [0, 0, 0, 0]) }, s2: { value: v4(p.TextureScroll2, [0, 0, 0, 0]) },
    d1: { value: null }, d2: { value: null }, mask: { value: null },
  };
  void childTexture(area.textures.DiffuseMap1).then((t) => { uniforms.d1!.value = t; });
  void childTexture(area.textures.DiffuseMap2).then((t) => { uniforms.d2!.value = t; });
  void childTexture(area.textures.MaskMap).then((t) => { uniforms.mask!.value = t; });
  const params = {
    uniforms,
    vertexShader: `uniform vec4 t1; uniform vec4 t2; uniform vec4 s1; uniform vec4 s2; uniform vec4 fresnel; uniform float time;
      varying vec2 vUv; varying vec4 vUv12; varying float vFresnel;
      void main() {
        vUv = uv;
        vUv12 = vec4(uv * t1.zw + t1.xy + s1.xy * time + s1.zw, uv * t2.zw + t2.xy + s2.xy * time + s2.zw);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 toEye = normalize(-(vec4(mv.xyz, 0.0) * viewMatrix).xyz);
        vec3 n = normalize(mat3(modelMatrix) * normal);
        float f = pow(1.0 - clamp(dot(toEye, n) - fresnel.z, 0.0, 1.0), fresnel.x);
        vFresnel = fresnel.y < 0.0 ? (1.0 - min(f, 1.0)) * -fresnel.y : f * fresnel.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D d1; uniform sampler2D d2; uniform sampler2D mask; uniform vec4 colour;
      varying vec2 vUv; varying vec4 vUv12; varying float vFresnel;
      ${CLAMP_GLSL}
      void main() {
        gl_FragColor = texture2D(d1, vUv12.xy) * texture2D(d2, vUv12.zw) * texture2D(mask, clampUv(mask, vUv)) * (vFresnel * colour);
      }`,
    transparent: true, depthWrite: false, ...areaBlend(area),
  };
  const mat = logDepth(new THREE.ShaderMaterial({ ...params, side: THREE.FrontSide }));
  mat.userData.backPass = logDepth(new THREE.ShaderMaterial({ ...params, side: THREE.BackSide }));
  return mat;
}

/**
 * An area drawn with texturecolor.fx: DiffuseMap at uv x TextureScaling.xy + TextureTranslation.xy, times DiffuseColor
 * and Brightness; both faces (its file culls none). Defaults DiffuseColor 0.8, Brightness 1, TextureTranslation 0,
 * TextureScaling 1. DEPTH_MAP_OCCLUSION_YES (its record 2) multiplies the alpha by the share of 21 taps of the scene's
 * depth - a 5 x 5 pixel block about the pixel, its corners left out - that the area is in front of (the scene's depth
 * here: softDepth.ts; all of it where none was drawn).
 */
function textureColorMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    colour: { value: v4(p.DiffuseColor, [0.8, 0.8, 0.8, 1]) }, brightness: { value: typeof p.Brightness === "number" ? p.Brightness : 1 },
    translation: { value: v4(p.TextureTranslation, [0, 0, 0, 0]) }, scaling: { value: v4(p.TextureScaling, [1, 1, 1, 1]) },
    map: { value: null },
  };
  void childTexture(area.textures.DiffuseMap).then((t) => { uniforms.map!.value = t; });
  const occlusion = area.options?.DEPTH_MAP_OCCLUSION === "DEPTH_MAP_OCCLUSION_YES";
  if (occlusion) Object.assign(uniforms, SOFT_DEPTH);
  const mat = logDepth(new THREE.ShaderMaterial({
    uniforms,
    vertexShader: occlusion ? `varying vec2 vUv; varying float vViewZ;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }` : PLAIN_VS,
    fragmentShader: `${occlusion ? SOFT_DEPTH_GLSL + " varying float vViewZ;" : ""}
      uniform sampler2D map; uniform vec4 colour; uniform float brightness; uniform vec4 translation; uniform vec4 scaling;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(map, vUv * scaling.xy + translation.xy) * colour * brightness;
        ${occlusion ? `if (softDepthOn > 0.5) {
          float seen = 0.0;
          for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
            if (abs(x) == 2 && abs(y) == 2) continue;
            seen += vViewZ <= softSceneDepthAt(gl_FragCoord.xy + vec2(float(x), float(y))) ? 1.0 : 0.0;
          }
          gl_FragColor.a *= seen / 21.0;
        }` : ""}
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, ...areaBlend(area),
  }));
  if (occlusion) mat.userData.softDepth = true;
  return mat;
}

/**
 * An area drawn with lensflares/flare.fx: GradientMap (clamped) at (d, d) for d the distance from the uv's middle
 * x 2, times DiffuseColor and Brightness; both faces. Defaults DiffuseColor 1, Brightness 1. The fog volume map's
 * factor is 1.
 */
function flareMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    colour: { value: v4(p.DiffuseColor, [1, 1, 1, 1]) }, brightness: { value: typeof p.Brightness === "number" ? p.Brightness : 1 },
    gradient: { value: null },
  };
  void childTexture(area.textures.GradientMap).then((t) => { uniforms.gradient!.value = t; });
  return logDepth(new THREE.ShaderMaterial({
    uniforms, vertexShader: PLAIN_VS,
    fragmentShader: `uniform sampler2D gradient; uniform vec4 colour; uniform float brightness; varying vec2 vUv;
      ${CLAMP_GLSL}
      void main() { float d = length((vUv - 0.5) * 2.0); gl_FragColor = texture2D(gradient, clampUv(gradient, vec2(d))) * colour * brightness; }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, ...areaBlend(area),
  }));
}

/**
 * An area drawn with twocolorflare.fx: the mesh's x and y only (z nought) through its transform; per vertex k =
 * (asin(c) / pi)^2 for c the cosine of its angle off the eye's axis (saturated); the pixel's d = length((uv - 0.5) x
 * 2): the colour mix(ColorInner, ColorOutter, d x sqrt 2), times ((1 / (min(d, 1) + 0.001) - 0.999001) x 1.001)^2 x k,
 * its colour written sRGB-encoded (the per-frame gamma 1); both faces. Defaults both colours 1. The fog volume map's
 * factor is 1.
 */
function twoColorFlareMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms: Record<string, THREE.IUniform> = {
    inner: { value: v4(p.ColorInner, [1, 1, 1, 1]) }, outer: { value: v4(p.ColorOutter, [1, 1, 1, 1]) },
  };
  return logDepth(new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vUvK;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position.xy, 0.0, 1.0);
        float c = clamp(-mv.z / length(mv.xyz), 0.0, 1.0);
        float a = asin(c) / 3.14159265;
        vUvK = vec3(uv, a * a);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec4 inner; uniform vec4 outer; varying vec3 vUvK;
      ${SRGB_ENCODE_GLSL}
      void main() {
        float d = length((vUvK.xy - 0.5) * 2.0);
        float fall = (1.0 / (min(d, 1.0) + 0.001) - 0.999001) * 1.001;
        vec4 c = mix(inner, outer, d * 1.414214) * (fall * fall * vUvK.z);
        gl_FragColor = vec4(encode(max(c.rgb, 0.0)), c.a);
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, ...areaBlend(area),
  }));
}

const PARAM_UNIFORM: Record<string, string> = {
  DiffuseColor: "colour", FresnelFactors: "fresnel", MaskTransform: "maskT", MaskScroll: "maskS",
  TextureTransform1: "t1", TextureTransform2: "t2", TextureTransform3: "t3", TextureScroll1: "s1", TextureScroll2: "s2", TextureScroll3: "s3",
  BaseColor: "base", FxColor: "fx", Layer3Center: "centre", CurrentTime: "currentTime", AtlasInfo: "atlas", Colors: "colors",
  Brightness: "brightness", ColorInner: "inner", ColorOutter: "outer", TextureTranslation: "translation", TextureScaling: "scaling",
  Layer1Transform: "t1", Layer2Transform: "t2", Layer3Transform: "t3", Layer1Scroll: "s1", Layer2Scroll: "s2", Layer3Scroll: "s3",
};

async function childMesh(node: SofChildMesh, animator?: ChildAnimator): Promise<THREE.Object3D | null> {
  if (!node.geometry) return null;
  const holder = new THREE.Group();
  holder.name = `child-mesh:${node.name ?? ""}`;
  const url = node.geometry;
  if (!glbCache.has(url)) glbCache.set(url, gltfLoader.loadAsync(url).then((g) => g.scene).catch(() => null));
  const materials = new Map<SofChildMeshArea, THREE.Material>();
  // an area drawn with a hull shader (quadv5.fx, quadglassv5.fx) takes the hull's material: its textures by role (read
  // first, the material taking them as made), its four materials from the effect's own Mtl1..4 DiffuseColor,
  // FresnelColor and Gloss.x, else the file's defaults (1, 1 and 0.4: quadv5.sm_hi's header; a child mesh's effect
  // inherits nothing from its ship but the colour set, which this shader does not read)
  const hullAreas = new Map<SofChildMeshArea, THREE.Material>();
  // (quaddetailv5 too: its detail layer from the effect's own Detail1..3Map and parameters; fx/fxv5.fx areas take the
  // hull's fx material, their Layer1Map, Layer2Map and LayerMaskMap and the effect's parameters)
  await Promise.all(node.areas.filter((a) => a.effect === "quadv5" || a.effect === "quadglassv5" || a.effect === "quaddetailv5" || a.effect === "fxv5").map(async (a) => {
    const maps: Record<string, THREE.Texture | undefined> = {};
    await Promise.all(Object.entries(a.textures).map(async ([name, res]) => {
      const role = HULL_TEXTURE_ROLES[name];
      if (role && res) maps[role] = (await childTexture(res)) ?? undefined;
    }));
    if (maps.albedo) maps.albedo.colorSpace = THREE.SRGBColorSpace;
    const v = (k: string) => (Array.isArray(a.params[k]) ? (a.params[k] as number[]) : null);
    const area: SofArea = {
      kind: "opaque", name: a.name ?? "", index: a.index, areaType: "Primary", shader: a.effect, textures: {},
      params: a.params as Record<string, number[] | null>,
      glowColor: v("GeneralGlowColor") ?? [1, 1, 1, 1],
      materials: [1, 2, 3, 4].map((i) => ({ name: `Mtl${i}`, diffuse: v(`Mtl${i}DiffuseColor`) ?? [1, 1, 1, 1], dust: null, fresnel: v(`Mtl${i}FresnelColor`) ?? [1, 1, 1, 1], gloss: v(`Mtl${i}Gloss`)?.[0] ?? 0.4 })),
    };
    hullAreas.set(a, a.effect === "fxv5" ? fxHullMaterial({ ...area, kind: a.kind }, maps) : sofHullMaterial(maps, area));
  }));
  // a distortion area (ubershaderdistortion.fx) draws into the distortion map, on its layer alone (distortion.ts)
  const distortionAreas = new Map<SofChildMeshArea, THREE.Material | null>();
  await Promise.all(node.areas.filter((a) => a.kind === "distortion").map(async (a) => {
    const [normal1, mask] = await Promise.all([childTexture(a.textures.NormalMap1), childTexture(a.textures.MaskMap)]);
    distortionAreas.set(a, uberDistortionMaterial(a.params, { normal1, mask }));
  }));
  {
    const scene = await glbCache.get(url)!;
    const lod = scene?.children[0]?.children[node.meshIndex] ?? null;
    if (!lod) return null;
    const inner = new THREE.Group();
    inner.scale.set(1, 1, -1);
    lod.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const index = (mesh.material as THREE.Material).userData?.index;
      const at = typeof index === "number" ? index : 0;
      // every area over this part of the mesh draws it (a plane may carry several effects, layered: each its own
      // mesh, in the areas' order)
      for (const area of node.areas.filter((a) => at >= a.index && at < a.index + a.count)) {
        if (!materials.has(area) && hullAreas.has(area)) materials.set(area, hullAreas.get(area)!);
        if (area.kind === "distortion") {
          const mat = distortionAreas.get(area);
          if (!mat) continue;
          o.updateWorldMatrix(true, false);
          const m = new THREE.Mesh(mesh.geometry, mat);
          m.frustumCulled = false;
          m.layers.set(DISTORTION_LAYER);
          if (area.id !== undefined) m.userData.childId = area.id;
          m.applyMatrix4(o.matrixWorld);
          inner.add(m);
          continue;
        }
        if (!materials.has(area)) {
          const make = ({ fx3dv5: fx3dMaterial, motionvectorramp: motionVectorRampMaterial, ubershadertwosided: twoSidedUberMaterial,
            texturecolor: textureColorMaterial, flare: flareMaterial, twocolorflare: twoColorFlareMaterial, ubershadercube: uberCubeMaterial } as Record<string, (a: SofChildMeshArea) => THREE.ShaderMaterial>)[area.effect] ?? uberMaterial;
          const mat = make(area);
          materials.set(area, mat);
          for (const [name, id] of Object.entries(area.paramIds ?? {})) if (PARAM_UNIFORM[name]) animator?.uniform(id, mat.uniforms[PARAM_UNIFORM[name]!]);
        }
        o.updateWorldMatrix(true, false);
        // an effect of two passes (ubershadertwosided's back faces) draws its second as a second mesh, after the first
        for (const mat of [materials.get(area)!, materials.get(area)!.userData.backPass as THREE.Material | undefined]) {
          if (!mat) continue;
          const m = new THREE.Mesh(mesh.geometry, mat);
          m.renderOrder = 3;
          // the area's own display (a curve set may drive it: Tr2MeshArea.display)
          if (area.id !== undefined) m.userData.childId = area.id;
          m.frustumCulled = false;
          m.applyMatrix4(o.matrixWorld);
          inner.add(m);
        }
      }
    });
    // EveChildMesh::UpdateVisibility: drawn only where its size across (its world bounding sphere's) x the inverse LOD
    // factor is at least its minScreenSize - its sphere kept (in the holder's frame) for the view to test each frame
    if (node.minScreenSize > 0) {
      const sphere = new THREE.Box3().setFromObject(inner).getBoundingSphere(new THREE.Sphere());
      inner.name = "size-gated";
      inner.userData.minScreenSize = node.minScreenSize;
      inner.userData.sphere = [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius];
    }
    holder.add(inner);
  }
  return holder;
}

/** The transform modifiers drawn so far (the rest leave the transform as it is). */
const MODIFIERS = new Set(["EveChildModifierHalo", "EveChildModifierHaloInverted", "EveChildModifierCameraOrientedRotationConstrained", "EveChildModifierBillboard2D", "EveChildModifierSRT", "EveTransformLookAtCamera", "EveTransformCameraRotationAligned"]);

/**
 * A modified child's transform from its own (base, in EVE's model space of the hull) and the eye there, as trinity's
 * modifiers make a child's world transform (_trinity_dx11.dll, their vtables' transform function, decompiled):
 * - EveChildModifierHalo: the translation kept; the axes the eye's (its view-inverse rows: right, up, forward), each
 *   the length of the child's own, times f = max(z . d, 0)^2 for z the child's z axis and d the way to the eye,
 *   both normalised: a billboard turned to the eye, gone as it is seen from the side;
 * - EveChildModifierCameraOrientedRotationConstrained: the child turned about its own y axis by atan2(d . x, d . z)
 *   (x, z its unit axes, d the way to the eye from its translation): its z axis toward the eye, its y kept;
 * - EveChildModifierBillboard2D: the halo's without its fall-off: the eye's axes, each the length of the child's own;
 * - EveChildModifierSRT: the modifier's own transform (scaling, rotation, translation) laid on in the child's space.
 * - EveTransformLookAtCamera (an EveTransform's "Look at camera" modifier, Tr2Transform.cpp: Transpose(LookAtMatrix(eye,
 *   pos, +y))): the translation kept; for v = normalize(pos - eye) the axes -normalize(+y x v), normalize(v x right)
 *   and -v, each the length of the child's own.
 * - EveTransformCameraRotationAligned (an EveTransform's modifier 100, Tr2Transform.cpp
 *   TR2TM_EVE_CAMERA_ROTATION_ALIGNED): in its parent's space, fwd the way to the eye (each component over its axis'
 *   squared length, normalised), up = normalize(fwd x the eye's right there), the basis (up x fwd, up, fwd)
 *   (TriMatrixChangeBase); the transform parent x T x that basis x R x S (its own translation, rotation, scaling).
 * - EveChildModifierHaloInverted (carbonengine/trinity EveChildModifierHaloInverted.cpp, DistanceBase in
 *   EveChildModifierTransformCommon.h): the child's frame turned to the eye in its own space - z the way to the eye
 *   in its axes (each component over its axis' squared length, normalised), y = normalize(z x the eye's right in its
 *   axes), x = y x z - and scaled by max(d . -z, 0) (d the way to the eye, z the child's own axis, both normalised):
 *   seen from behind; the child's transform x that basis x the scale.
 */
function applyModifiers(base: THREE.Matrix4, mods: string[], eye: THREE.Vector3, eyeAxes: THREE.Vector3[], out: THREE.Matrix4, srt: SofChildSrt | null = null,
  parent: THREE.Matrix4 | null = null): void {
  out.copy(base);
  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3(), t = new THREE.Vector3(), d = new THREE.Vector3();
  for (const mod of mods) {
    out.extractBasis(x, y, z);
    t.setFromMatrixPosition(out);
    d.subVectors(eye, t);
    if (mod === "EveChildModifierHalo") {
      const f = Math.max(z.clone().normalize().dot(d.clone().normalize()), 0) ** 2;
      const [ex, ey, ez] = eyeAxes as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      out.makeBasis(ex.clone().multiplyScalar(x.length() * f), ey.clone().multiplyScalar(y.length() * f), ez.clone().multiplyScalar(z.length() * f));
      out.setPosition(t);
    } else if (mod === "EveChildModifierHaloInverted") {
      const ux = x.clone(), uy = y.clone(), uz = z.clone();
      const right = (eyeAxes[0] as THREE.Vector3).clone();
      const sq = (v: THREE.Vector3) => v.lengthSq() || Infinity;
      const n = new THREE.Vector3(d.dot(ux) / sq(ux), d.dot(uy) / sq(uy), d.dot(uz) / sq(uz)).normalize();
      const r = new THREE.Vector3(right.dot(ux), right.dot(uy), right.dot(uz));
      const up = new THREE.Vector3().crossVectors(n, r).normalize();
      const across = new THREE.Vector3().crossVectors(up, n);
      const f = Math.max(d.clone().normalize().dot(uz.clone().normalize().negate()), 0);
      out.multiply(new THREE.Matrix4().makeBasis(across, up, n)).multiply(new THREE.Matrix4().makeScale(f, f, f));
    } else if (mod === "EveChildModifierBillboard2D") {
      const [ex, ey, ez] = eyeAxes as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      out.makeBasis(ex.clone().multiplyScalar(x.length()), ey.clone().multiplyScalar(y.length()), ez.clone().multiplyScalar(z.length()));
      out.setPosition(t);
    } else if (mod === "EveTransformCameraRotationAligned") {
      const p = parent ?? new THREE.Matrix4();
      const own = p.clone().invert().multiply(out);
      const ot = new THREE.Vector3(), or = new THREE.Quaternion(), os = new THREE.Vector3();
      own.decompose(ot, or, os);
      const at = ot.clone().applyMatrix4(p);
      const px = new THREE.Vector3(), py = new THREE.Vector3(), pz = new THREE.Vector3();
      p.extractBasis(px, py, pz);
      const sq = (v: THREE.Vector3) => v.lengthSq() || Infinity;
      const toEye = eye.clone().sub(at);
      const fwd = new THREE.Vector3(toEye.dot(px) / sq(px), toEye.dot(py) / sq(py), toEye.dot(pz) / sq(pz)).normalize();
      const right = eyeAxes[0] as THREE.Vector3;
      const r = new THREE.Vector3(right.dot(px), right.dot(py), right.dot(pz));
      const up = new THREE.Vector3().crossVectors(fwd, r).normalize();
      const across = new THREE.Vector3().crossVectors(up, fwd);
      out.copy(p).multiply(new THREE.Matrix4().makeTranslation(ot.x, ot.y, ot.z)).multiply(new THREE.Matrix4().makeBasis(across, up, fwd))
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(or)).multiply(new THREE.Matrix4().makeScale(os.x, os.y, os.z));
    } else if (mod === "EveTransformLookAtCamera") {
      const v = t.clone().sub(eye).normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(v).normalize();
      const up = v.clone().cross(right).normalize();
      out.makeBasis(right.negate().multiplyScalar(x.length()), up.multiplyScalar(y.length()), v.negate().multiplyScalar(z.length()));
      out.setPosition(t);
    } else if (mod === "EveChildModifierSRT" && srt) {
      const [tx, ty, tz] = srt.translation, [qx, qy, qz, qw] = srt.rotation, [sx, sy, sz] = srt.scaling;
      out.multiply(new THREE.Matrix4().compose(new THREE.Vector3(tx, ty, tz), new THREE.Quaternion(qx, qy, qz, qw), new THREE.Vector3(sx, sy, sz)));
    } else if (mod === "EveChildModifierCameraOrientedRotationConstrained") {
      const angle = Math.atan2(d.dot(x.normalize()), d.dot(z.normalize()));
      out.multiply(new THREE.Matrix4().makeRotationY(angle));
    }
  }
}

/**
 * The modified children of one hull's group, kept turned to the eye: a mesh that draws nothing, drawn first (its
 * material's onBeforeRender, which a clone of the model shares), finds them in the group it sits in (a clone's own)
 * and sets each one's transform for this frame's eye, then their world transforms.
 */
const tickerMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
const modifiedOf = new WeakMap<THREE.Object3D, THREE.Object3D[]>();
const playedOf = new WeakMap<THREE.Object3D, { objects: Map<number, THREE.Object3D[]>; seen: { visibility: number }; fx: { owner: THREE.Object3D; holder: THREE.Object3D; type: string }[] }>();
/**
 * The fx attributes' values (Trinity's Eve/SpaceObject/Utils/fxAttributes/), for the container that holds them:
 * - EveCameraFxAttributes: distanceToCamera, the container's world position's distance from the eye;
 *   lookAngleToObject, -(lookAt . (position - eye)) / distance - here the cosine of the angle between the eye's forward
 *   and the container, positive facing it (the files' own expressions want it near 1 when it is in view: a ViewAngle
 *   curve of 0 at 0 and 1 at 0.9, its stored input 0.975); cameraRotation, the view's third column - taken as toward
 *   the eye (backward), as lookAt is (and as the six-point lit particles' view z, particles.ts, where the other reading
 *   lit a front-lit sprite darkest), in EVE's space, our z mirrored; objectRotation and rotationWithChildTransform, the
 *   container's z axis in EVE's space;
 * - EveSpaceObjectFxAttributes: activationStrength the ship's (1 but for its damage flicker), activeTurretCount 0 and
 *   killCount 0 (not followed), boundingSphereRadius 0 (not given).
 * The models' copies share their curves: the last copy drawn sets their inputs.
 */
function gatherFx(list: { owner: THREE.Object3D; holder: THREE.Object3D; type: string }[], camera: THREE.Camera): void {
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const eve = (v: THREE.Vector3) => [v.x, v.y, -v.z];
  for (const f of list) {
    f.owner.updateWorldMatrix(true, false);
    if (f.type === "EveCameraFxAttributes") {
      const at = new THREE.Vector3().setFromMatrixPosition(f.owner.matrixWorld);
      const to = at.clone().sub(eye);
      const d = to.length();
      const z = new THREE.Vector3().setFromMatrixColumn(f.owner.matrixWorld, 2).normalize();
      f.holder.userData.fx = { distanceToCamera: d, lookAngleToObject: d > 0 ? forward.dot(to) / d : 0, cameraRotation: eve(forward.clone().negate()), objectRotation: eve(z), rotationWithChildTransform: eve(z) };
    } else {
      // the ship's activation strength (setActivationStrength: its damage flicker), 1 where it has none
      let activation = 1;
      for (let p: THREE.Object3D | null = f.owner; p; p = p.parent) if (typeof p.userData.activation === "number") { activation = p.userData.activation as number; break; }
      f.holder.userData.fx = { activationStrength: activation, activeTurretCount: 0, killCount: 0, boundingSphereRadius: 0 };
    }
  }
}
/**
 * A hull controller's SetValue / AnimateValue into the space object's own attribute (EveSpaceObject2), from its
 * children's group (the model's holder its parent; the space object the nearest holder marked spaceObject - the space
 * view's mark, which takes the impact overlay's activation too - else the model):
 * - activationStrength: x the impact overlay's (hullModel.ts setOwnerActivation); nought, its children are not drawn
 *   (EveChildContainer::GetBatches: activationStrength 0 draws nothing);
 * - display: nought, nothing of it is drawn (its controllers still run: the ticker stays);
 * - clipSphereFactor / clipSphereFactor2: kept (userData), handed to its controllers (ClipSphereFactor, -2), as
 *   EveSpaceObject2::OnModified does, and the hull clipped by them (hullModel.ts setClipSphere).
 */
function setOwnerAttribute(group: THREE.Object3D, attribute: string, value: number): void {
  const model = group.parent;
  if (!model) return;
  let object: THREE.Object3D = model;
  for (let p: THREE.Object3D | null = model; p; p = p.parent) if (p.userData.spaceObject) { object = p; break; }
  if (attribute === "activationStrength") setOwnerActivation(object, value);
  else if (attribute === "display") model.userData.ownerDisplay = value;
  else if (attribute === "clipSphereFactor" || attribute === "clipSphereFactor2") {
    if (object.userData[attribute] === value) return;
    object.userData[attribute] = value;
    setControllerVariable(object, attribute === "clipSphereFactor" ? "ClipSphereFactor" : "ClipSphereFactor2", value);
    setClipSphere(object, model);
    return;
  } else return;
  const shown = model.userData.ownerDisplay !== 0;
  const childrenShown = shown && object.userData.ownerActivation !== 0;
  for (const c of model.children) {
    if (c !== group) { setShown(c, shown); continue; }
    for (const g of group.children) if (g.name !== "child-modifiers") setShown(g, childrenShown);
  }
}
/**
 * Tr2ActionResetClipSphereCenter::Start: the clip sphere's centre (EVE's model space, before the bounding sphere's centre
 * is added) at minus that centre (the object's origin), or at a locator's position - of the damage set (no hit is kept
 * here: a random one) or a named set, a random one at index -1; a set the hull does not have leaves it.
 */
function resetClipCenter(group: THREE.Object3D, behavior: number, set: string, index: number): void {
  const model = group.parent;
  if (!model) return;
  let object: THREE.Object3D = model;
  for (let p: THREE.Object3D | null = model; p; p = p.parent) if (p.userData.spaceObject) { object = p; break; }
  if (behavior === 1 || behavior === 2) {
    const locators = (group.userData.locatorSets as Record<string, number[][]> | undefined)?.[behavior === 1 ? "damage" : set];
    if (!locators?.length || (index >= 0 && index >= locators.length)) return;
    const l = locators[index < 0 || behavior === 1 ? Math.floor(Math.random() * locators.length) : index]!;
    object.userData.clipSphereCenter = [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0];
  } else {
    const bs = (model.userData.boundingSphere as number[] | null | undefined) ?? [0, 0, 0, 0];
    object.userData.clipSphereCenter = [-(bs[0] ?? 0), -(bs[1] ?? 0), -(bs[2] ?? 0)];
  }
  setClipSphere(object, model);
}
/** Hidden by the space object's display or activation, and shown again as it was (kept while hidden). */
function setShown(o: THREE.Object3D, shown: boolean): void {
  if (!shown) {
    if (o.userData.ownerHidden === undefined) { o.userData.ownerHidden = o.visible; o.visible = false; }
  } else if (o.userData.ownerHidden !== undefined) {
    o.visible = o.userData.ownerHidden as boolean;
    delete o.userData.ownerHidden;
  }
}

/**
 * EveProceduralMethodCycling for one clone's procedural container: SelectParameter takes the next child (with
 * randomizeOrder and more than two, a random one other than the last: rand() % (n - 1), past the old index), its start
 * the time less startTimeOffset; UpdateAsyncronous moves on when the child's playDuration has passed. The chosen
 * child's file built (a copy of it, childEffectObject) in place of the last, started where it asks to be.
 */
class CyclingRun {
  private index = -1;
  private start = 0;
  private current: THREE.Object3D | null = null;
  private token = 0;
  constructor(private readonly node: SofChildProcedural, private readonly holder: THREE.Object3D, private readonly effects: Record<string, SofChildNode | null>) {}
  update(now: number): void {
    const item = this.index >= 0 ? this.node.items[this.index] : undefined;
    if (!item) { this.select(now); return; }
    if (now - this.start >= item.duration) this.select(now);
  }
  private select(now: number): void {
    const n = this.node.items.length;
    if (!n) return;
    if (this.node.randomize && n > 2) {
      const old = this.index;
      let i = Math.floor(Math.random() * (n - 1));
      if (i >= old) i++;
      this.index = i;
    } else this.index = (this.index + 1) % n;
    this.start = now - this.node.startOffset;
    const item = this.node.items[this.index]!;
    const token = ++this.token;
    void childEffectObject(item.effect, this.effects).then((o) => {
      if (token !== this.token) return;
      this.current?.removeFromParent();
      this.current = o;
      if (!o) return;
      this.holder.add(o);
      if (item.restart) startEffect(o);
    });
  }
}
/** The procedural containers built (by their holders' key): the node and the effects its children are. */
const proceduralNodes = new Map<string, { node: SofChildProcedural; effects: Record<string, SofChildNode | null> }>();
let proceduralKeys = 0;
/** Each clone's procedural container runs (found by its ticker). */
const cyclingRunsOf = new WeakMap<THREE.Object3D, CyclingRun[]>();
/** Each clone's behaviour-system agents (behaviorAgents.ts), placed on its first frame. */
const agentRunsOf = new WeakMap<THREE.Object3D, { holder: THREE.Object3D; run: AgentRun }[]>();

/** The effect propagators built (by their holders' key): the node, the effects its source may load, its hull locators. */
const propagatorNodes = new Map<string, { node: SofChildPropagator; effects: Record<string, SofChildNode | null>; locators: number[][] }>();
let propagatorKeys = 0;
/** Each clone's propagator runs (found by its ticker), by the propagator's id. */
const propagatorRunsOf = new WeakMap<THREE.Object3D, { id: number | null; run: PropagatorRun; last: number }[]>();

/** Each clone's controller runs (found by its ticker), started on its first frame. */
const controllerRunsOf = new WeakMap<THREE.Object3D, ControllerRun[]>();
tickerMaterial.onBeforeRender = (renderer, _s, camera, _g, object) => {
  const group = object.parent;
  if (!group) return;
  // its lights, for the dynamic lights' next list (dynamicLights.ts)
  offerLights(renderer, camera, group);
  // the curve sets (childAnimation.ts): their objects found in this clone of the model by their ids
  const animator = animators.get(group.userData.animatorKey as string);
  if (animator) {
    let played = playedOf.get(object);
    if (!played) {
      const objects = new Map<number, THREE.Object3D[]>();
      group.traverse((o) => { const id = o.userData.childId as number | undefined; if (id !== undefined) objects.set(id, [...(objects.get(id) ?? []), o]); });
      // this clone's lights (its own records: a binding into one changes what dynamicLights.ts gathers), each under its id
      for (const l of (group.userData.lights ?? []) as ChildLight[]) {
        if (l.id === undefined) continue;
        const holder = new THREE.Object3D();
        holder.userData.lightRecord = l;
        objects.set(l.id, [...(objects.get(l.id) ?? []), holder]);
      }
      // the containers' fx attributes: a holder each, its values (userData.fx) gathered below, found by the attribute's id
      const fx: { owner: THREE.Object3D; holder: THREE.Object3D; type: string }[] = [];
      group.traverse((o) => {
        for (const f of (o.userData.fxAttributes ?? []) as { id: number; type: string }[]) {
          const holder = new THREE.Object3D();
          objects.set(f.id, [holder]);
          fx.push({ owner: o, holder, type: f.type });
        }
      });
      played = { objects, seen: { visibility: 0 }, fx };
      playedOf.set(object, played);
    }
    if (played.fx.length) gatherFx(played.fx, camera);
    animator.step(played.objects, played.seen);
  }
  // the procedural containers, each clone's own
  let cycling = cyclingRunsOf.get(object);
  if (!cycling) {
    cycling = [];
    group.traverse((o) => {
      const entry = proceduralNodes.get(o.userData.proceduralKey as string);
      if (entry) cycling!.push(new CyclingRun(entry.node, o, entry.effects));
    });
    cyclingRunsOf.set(object, cycling);
  }
  if (cycling.length) { const now = performance.now() / 1000; for (const c of cycling) c.update(now); }
  // the behaviour systems' agents (after the curve sets: a grid's fullness may be bound), each clone's own
  let agentRuns = agentRunsOf.get(object);
  if (!agentRuns) {
    agentRuns = [];
    group.traverse((o) => { if (o.userData.agentsHolder) agentRuns!.push({ holder: o, run: new AgentRun(o) }); });
    agentRunsOf.set(object, agentRuns);
  }
  for (const a of agentRuns) a.run.update(renderer, camera, a.holder);
  // the effect propagators (propagator.ts), each clone's own, stepped before its controllers (which may trigger them)
  let props = propagatorRunsOf.get(object);
  if (!props) {
    props = [];
    const model = group.parent;
    const bs = model?.userData.boundingSphere as number[] | null | undefined;
    const radius = bs?.[3] ?? (model?.userData.radius as number | undefined) ?? 1;
    group.traverse((o) => {
      const entry = propagatorNodes.get(o.userData.propagatorKey as string);
      if (!entry) return;
      const { node, effects } = entry;
      // (an effect built for another object - a child effect added to a ship - takes that object's locators: the
      // nearest ancestor keeping locator sets)
      let locators = entry.locators;
      if (!locators.length && node.locatorSet) {
        for (let up: THREE.Object3D | null = o.parent; up; up = up.parent) {
          const sets = up.userData.locatorSets as Record<string, number[][]> | undefined;
          if (sets?.[node.locatorSet]?.length) { locators = sets[node.locatorSet]!; break; }
        }
      }
      const make = () => hullChildren([{ res: "", root: structuredClone(node.source), skipped: {} }], effects);
      const run = new PropagatorRun(node, o, locators, radius, make, startEffect);
      // (a curve set's binding into its trigger reaches it here: childAnimation.ts)
      o.userData.onTrigger = () => run.trigger();
      props!.push({ id: node.id ?? null, run, last: performance.now() / 1000 });
    });
    propagatorRunsOf.set(object, props);
  }
  if (props.length) {
    const now = performance.now() / 1000;
    for (const p of props) { p.run.update(Math.min(0.25, now - p.last)); p.last = now; }
  }
  // the controllers (controllers.ts), each owned by its container's group in this clone
  const controllerData = group.userData.controllers as SofController[][] | undefined;
  if (controllerData) {
    let runs = controllerRunsOf.get(object);
    if (!runs) {
      runs = [];
      const effects = (group.userData.childEffects ?? {}) as Record<string, SofChildNode | null>;
      const host = {
        // (Tr2ActionChildEffect loads the file afresh each time: a copy here shares its first's curve sets, so they
        // are played from the start - else a propagator's trigger binding, already past, never fires again)
        build: (path: string) => childEffectObject(path, effects).then((o) => { if (o) startEffect(o); return o; }),
        // an EveMultiEffect's parameters (the hangar's VFX: its "ship"): bound on the clone or above it (otherOwners)
        otherOwner: (name: string) => {
          for (let up: THREE.Object3D | null = group; up; up = up.parent) {
            const bound = (up.userData.otherOwners as Record<string, THREE.Object3D> | undefined)?.[name];
            if (bound) return bound;
          }
          return null;
        },
        play: (owner: number, name: string, range: string) => animator?.play(owner, name, range),
        stop: (owner: number, name: string) => animator?.stop(owner, name),
        setDisplay: (target: number, on: boolean) => animator?.setDisplay(target, on),
        // the owner's own target, else one in a child effect loaded under it (its own animator, by its key)
        setValue: (target: number, attribute: string, value: number) => {
          if (animator?.setValue(target, attribute, value)) return;
          // an effect propagator's frequency (by its id), in this clone
          if (attribute === "frequency") { for (const p of propagatorRunsOf.get(object) ?? []) if (p.id === target) p.run.setFrequency(value); return; }
          // a controller's variable (by its id): the run holding it, in this clone
          if (attribute === "value") {
            let found = false;
            for (const run of runs ?? []) for (const v of run.variableIds) if (v.id === target) { run.setVariable(v.name, value); found = true; }
            if (found) return;
          }
          group.traverse((o) => {
            const key = o.userData.animatorKey as string | undefined;
            if (key && key !== group.userData.animatorKey) animators.get(key)?.setValue(target, attribute, value);
          });
        },
        setOwner: (attribute: string, value: number) => setOwnerAttribute(group, attribute, value),
        resetClipCenter: (behavior: number, set: string, index: number) => resetClipCenter(group, behavior, set, index),
        overlay: (effect: string, on: boolean) => {
          const model = group.parent;
          if (!model) return;
          if (on) addOverlay(model, effect, (group.userData.overlays as Record<string, SofOverlay | null> | undefined)?.[effect]);
          else removeOverlay(model, effect);
        },
        spawn: (emitter: number, rate: number) => animator?.spawn(emitter, rate),
        trigger: (target: number) => { for (const p of propagatorRunsOf.get(object) ?? []) if (p.id === target) p.run.trigger(); },
        applyTime: (set: number, time: number) => animator?.applyTime(set, time),
        setScale: (set: number, scale: number) => animator?.setScale(set, scale),
        duration: (owner: number, name: string, range: string) => animator?.duration(owner, name, range) ?? 0,
      };
      const owners: THREE.Object3D[] = [];
      group.traverse((o) => { if (typeof o.userData.controllerOwner === "number") owners.push(o); });
      for (const owner of owners) for (const c of controllerData[owner.userData.controllerOwner as number] ?? []) runs.push(new ControllerRun(c, owner, host, (owner.userData.controllerOwnerId as number | null) ?? null));
      // their variables a curve set's binding may set: a setter each under the variable's id, for the animator
      const played = playedOf.get(object);
      if (played) for (const run of runs) for (const v of run.variableIds) {
        const sink = new THREE.Object3D();
        sink.userData.setVariable = (value: number) => run.setVariable(v.name, value);
        played.objects.set(v.id, [...(played.objects.get(v.id) ?? []), sink]);
      }
      controllerRunsOf.set(object, runs);
    }
    for (const r of runs) r.update();
  }
  let list = modifiedOf.get(object);
  if (!list) {
    list = [];
    group.traverse((o) => { if (o.userData.modifiers) list!.push(o); });
    modifiedOf.set(object, list);
  }
  group.updateWorldMatrix(true, false);
  const toEve = group.matrixWorld.clone().invert();
  const eye = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(toEve);
  const cx = new THREE.Vector3(), cy = new THREE.Vector3(), cz = new THREE.Vector3();
  camera.matrixWorld.extractBasis(cx, cy, cz);
  const rot = new THREE.Matrix3().setFromMatrix4(toEve);
  // the eye's axes in EVE's model space: right, up and forward (the view-inverse rows of a left-handed view)
  const axes = [cx.applyMatrix3(rot).normalize(), cy.applyMatrix3(rot).normalize(), cz.negate().applyMatrix3(rot).normalize()];
  for (const o of list) {
    const base = new THREE.Matrix4().fromArray(o.userData.modifierBase as number[]);
    const parent = o.userData.parentMatrix ? new THREE.Matrix4().fromArray(o.userData.parentMatrix as number[]) : null;
    applyModifiers(base, o.userData.modifiers as string[], eye, axes, o.matrix, (o.userData.srt as SofChildSrt | undefined) ?? null, parent);
    o.matrixWorldNeedsUpdate = true;
    o.updateMatrixWorld(true);
  }
};
/**
 * A child's GPU emitters, driven where the child is: each draw of this (invisible) object updates its copy's emitters
 * with its world matrix (EveChildParticleSystem::Update gives them the child's world transform; nothing is emitted while
 * it is hidden), into its scene's system (gpuParticles.ts).
 */
const gpuDriverMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
const gpuEmittersOf = new WeakMap<THREE.Object3D, GpuEmitter[]>();
/** The emitters' data by a driver's key: one object per child for a model's copies (a curve set's binding sets it). */
const gpuEmitterData = new Map<number, GpuEmitterData[]>();
let gpuEmitterKey = 0;
gpuDriverMaterial.onBeforeRender = (_r, scene, _c, _g, object) => {
  let list = gpuEmittersOf.get(object);
  if (!list) { list = (gpuEmitterData.get(object.userData.gpuEmitterKey as number) ?? []).map((d) => new GpuEmitter(d)); gpuEmittersOf.set(object, list); }
  const system = gpuSystemOf(scene);
  object.updateWorldMatrix(true, false);
  const now = performance.now() / 1000;
  for (const e of list) e.update(now, object.matrixWorld, system);
};
function gpuDriver(node: SofChildGpuParticles): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  const mesh = new THREE.Mesh(geo, gpuDriverMaterial);
  mesh.name = `child-gpu-emitters:${node.name ?? ""}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e9;
  const key = ++gpuEmitterKey;
  gpuEmitterData.set(key, node.emitters);
  mesh.userData.gpuEmitterKey = key;
  return mesh;
}

function ticker(): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  const mesh = new THREE.Mesh(geo, tickerMaterial);
  mesh.name = "child-modifiers";
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e9;
  return mesh;
}

/**
 * The hull's children as drawn so far, under one group mirrored in z (EVE's model space to ours), or null where
 * nothing of them is drawn.
 */
/** Ids for the children whose file gives them none (below every file id). */
let syntheticChildId = -1;

/** A child effect's object, built once per path; each use takes a copy (in EVE's space: the copy's mirror undone). */
const effectObjects = new Map<string, Promise<THREE.Object3D | null>>();
function childEffectObject(path: string, effects: Record<string, SofChildNode | null>): Promise<THREE.Object3D | null> {
  if (!effectObjects.has(path)) {
    const root = effects[path] ?? null;
    effectObjects.set(path, root ? hullChildren([{ res: path, root, skipped: {} }], effects).catch(() => null) : Promise.resolve(null));
  }
  return effectObjects.get(path)!.then((o) => {
    if (!o) return null;
    const copy = o.clone();
    copy.scale.set(1, 1, 1);
    return copy;
  });
}

/**
 * An effect file's root built (the hangar VFX, effects/<graphicID>.json): its controllers and curve sets run from its
 * ticker, the child effects they load built from its own list.
 */
export async function effectObject(root: SofChildNode, effects: Record<string, SofChildNode | null>): Promise<THREE.Object3D | null> {
  return hullChildren([{ res: "", root, skipped: {} }], effects);
}

/**
 * Start an effect object built by hullChildren (EveEffectRoot2::Start, as ExplosionManager.GetExplosion calls it): its
 * curve sets played from now. Its controllers begin as it is first drawn.
 */
/** An effect object's PostProcess output (its multi-effect's binding: "fade.intensity"), or null where none is set. */
export function effectOutput(object: THREE.Object3D, name: string): number | null {
  let out: number | null = null;
  object.traverse((o) => {
    const key = o.userData.animatorKey as string | undefined;
    const v = key ? animators.get(key)?.outputs.get(name) : undefined;
    if (out === null && v !== undefined) out = v;
  });
  return out;
}

/** A curve of an effect object's curve sets, by the set's name and its own (a Tr2DynamicBinding's destination). */
export function effectCurve(object: THREE.Object3D, setName: string, curveName: string): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  object.traverse((o) => {
    const key = o.userData.animatorKey as string | undefined;
    if (!out && key) out = animators.get(key)?.curveNamed(setName, curveName) ?? null;
  });
  return out;
}

/** A curve set of a name played from its start in a built object, at a speed where one is given (a ShipEffect's Start). */
export function playEffectSet(object: THREE.Object3D, name: string | null, scale?: number): void {
  object.traverse((o) => { const key = o.userData.animatorKey as string | undefined; if (key) animators.get(key)?.playNamed(name, scale); });
}
export function startEffect(object: THREE.Object3D, skip?: (setName: string | null) => boolean): void {
  object.traverse((o) => { const key = o.userData.animatorKey as string | undefined; if (key) animators.get(key)?.restart(skip); });
}

export async function hullChildren(children: SofHullChild[] | undefined, effects: Record<string, SofChildNode | null> = {}, hullControllers: SofController[] = [],
  locatorSets: Record<string, number[][]> = {}, overlays: Record<string, SofOverlay | null> = {}): Promise<THREE.Object3D | null> {
  const quads: Parameters<typeof quadMesh>[0] = [];
  // where the walk puts quads: the hull's list, or a live container's own (with the ids of the quads it holds)
  let quadList = quads;
  let quadIds: number[] | null = null;
  let lightList: ChildLight[] | null = null;
  const others: THREE.Object3D[] = [];
  const animator = new ChildAnimator();
  // the containers and meshes whose transform a played curve set drives (each its own object, recomposed each frame)
  const moved = new Set<number>();
  const scan = (n: SofChildNode) => {
    if (n.k !== "container") return;
    for (const cs of n.curveSets ?? []) for (const b of cs.bindings) if (/^(translation|rotation|scaling)/.test(b.destinationAttribute)) moved.add(b.destination);
    n.objects.forEach(scan);
  };
  for (const child of children ?? []) if (child.root) scan(child.root);
  const pending: Promise<void>[] = [];
  let modified = 0;
  // the effect propagators and procedural containers placed (each clone runs them from its ticker)
  let propagators = 0;
  let procedurals = 0;
  // the containers' controllers, by owner (an owner's group carries its index as userData.controllerOwner)
  const controllers: SofController[][] = [];
  // the containers' point lights, in the hull's EVE space (the group's userData.lights, read by the space view)
  const lights: ChildLight[] = [];
  // `flat` is the node's parents' transform from the hull (for the quads, drawn as one mesh); `local` the same from
  // the object the node is added to (`sink`): a modified container's own group, or the hull's
  const place = (o: THREE.Object3D, at: THREE.Matrix4, mods: string[] | undefined, srt: SofChildSrt | null = null) => {
    o.matrixAutoUpdate = false;
    o.matrix.copy(at);
    const kept = (mods ?? []).filter((m) => MODIFIERS.has(m));
    if (kept.length) {
      o.userData.modifiers = kept;
      o.userData.modifierBase = at.toArray();
      if (srt) o.userData.srt = srt;
      modified++;
    }
  };
  type Halo = { z: THREE.Vector3; at: THREE.Vector3 } | null;
  const walk = (node: SofChildNode, flat: THREE.Matrix4, local: THREE.Matrix4, sink: (o: THREE.Object3D) => void, halo: Halo = null, ancestors: number[] = []) => {
    if (node.k === "container") {
      if (node.id !== undefined) { animator.container(node.id, node.display !== false); ancestors = [...ancestors, node.id]; }
      animator.curveSets(node.curveSets, ancestors);
      const m = node.m ? new THREE.Matrix4().fromArray(node.m) : new THREE.Matrix4();
      const flatHere = flat.clone().multiply(m);
      for (const l of node.lights ?? []) {
        // (Tr2Light::AddLight: position by the transform, radius and source radius by its scale; a spot's direction its
        // rotation applied to (0, 0, -1), turned by the transform, its cones' cosines from the angles in degrees)
        const at = new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0).applyMatrix4(flatHere);
        const k = meanScale(flatHere);
        const spot = l.rotation ? {
          direction: new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(l.rotation[0], l.rotation[1], l.rotation[2], l.rotation[3]))
            .transformDirection(flatHere).toArray(),
          cosOuter: Math.cos((Math.PI * 2 * (l.outerAngle ?? 0)) / 360), cosInner: Math.cos((Math.PI * 2 * (l.innerAngle ?? 0)) / 360),
        } : {};
        (lightList ?? lights).push({ ...(l.id !== undefined ? { id: l.id, scale: k } : {}), position: at.toArray(), radius: l.radius * k, sourceRadius: (l.innerRadius ?? 0) * k, color: l.color, brightness: l.brightness, ...spot });
      }
      if (node.modifiers.includes("EveChildModifierHalo")) {
        const z = new THREE.Vector3();
        flatHere.extractBasis(new THREE.Vector3(), new THREE.Vector3(), z);
        halo = { z: z.normalize(), at: new THREE.Vector3().setFromMatrixPosition(flatHere) };
      }
      if (node.live) {
        // placed from outside: its own group, quads and lights, in its own space
        const g = new THREE.Group();
        g.name = `child-live:${node.name ?? ""}`;
        g.matrixAutoUpdate = false;
        if (node.id !== undefined) g.userData.childId = node.id;
        const saved = [quadList, quadIds, lightList] as const;
        quadList = [];
        quadIds = [];
        lightList = [];
        const mine = { quads: quadList, ids: quadIds, lights: lightList };
        for (const l of node.lights ?? []) {
          const at = new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0).applyMatrix4(m);
          mine.lights.push({ ...(l.id !== undefined ? { id: l.id, scale: 1 } : {}), position: at.toArray(), radius: l.radius, sourceRadius: l.innerRadius ?? 0, color: l.color, brightness: l.brightness });
        }
        for (const o of node.objects) walk(o, m.clone(), m.clone(), (c) => g.add(c), null, ancestors);
        [quadList, quadIds, lightList] = saved;
        if (mine.quads.length) {
          const qm = quadMesh(mine.quads);
          const attr = qm.geometry.getAttribute("iColour") as THREE.InstancedBufferAttribute;
          for (const id of mine.ids) animator.quadAttributeOf(id, attr);
          g.add(qm);
        }
        g.userData.lights = mine.lights;
        sink(g);
        return;
      }
      const driven = node.id !== undefined && moved.has(node.id);
      if (node.modifiers.some((x) => MODIFIERS.has(x)) || driven || node.controllers?.length || node.fxAttributes?.length) {
        const g = new THREE.Group();
        g.name = `child-container:${node.name ?? ""}`;
        // a controller's owner: the child effects its states load go here
        if (node.controllers?.length) {
          g.userData.controllerOwner = controllers.length; g.userData.controllerOwnerId = node.id ?? null; controllers.push(node.controllers);
          // the sets its AnimateCurveSet actions hold (their own, applied at a time each update, never played)
          for (const c of node.controllers) for (const m of c.machines) for (const s of m.states) for (const a of s.actions) {
            const set = (a as { ownSet?: unknown }).ownSet;
            if (a.k === "animateCurveSet" && set && typeof set === "object") animator.curveSets([set as SofCurveSet], ancestors);
          }
        }
        // (a camera-aligned transform turns in its parent's space)
        if (node.modifiers.includes("EveTransformCameraRotationAligned")) g.userData.parentMatrix = local.toArray();
        place(g, local.clone().multiply(m), node.modifiers, node.srt ?? null);
        // its fx attributes: their values gathered each frame where the group is (the ticker), found by their ids
        if (node.fxAttributes?.length) g.userData.fxAttributes = node.fxAttributes;
        // a curve set may drive its SRT modifier (found in a clone by the container's id)
        if (node.srt?.id !== undefined && node.id !== undefined) { g.userData.childId = node.id; animator.srt(node.srt.id, node.id, node.srt); }
        if (driven) {
          g.userData.childId = node.id;
          g.userData.parentMatrix = local.toArray();
          animator.xform(node.id!, node.t ?? [0, 0, 0], node.r ?? [0, 0, 0, 1], node.s ?? [1, 1, 1]);
        }
        sink(g);
        for (const o of node.objects) walk(o, flatHere, new THREE.Matrix4(), (c) => g.add(c), halo, ancestors);
        return;
      }
      const localHere = local.clone().multiply(m);
      for (const o of node.objects) walk(o, flatHere, localHere, sink, halo, ancestors);
      return;
    }
    if (node.k === "mesh") {
      const at = local.clone().multiply(new THREE.Matrix4().fromArray(node.m));
      pending.push(childMesh(node, animator).then((o) => {
        if (!o) return;
        if (node.id !== undefined) { o.userData.childId = node.id; animator.object(node.id, ancestors, node.display !== false); }
        // each area a display target of its own, under its mesh
        for (const a of node.areas) if (a.id !== undefined) animator.object(a.id, node.id !== undefined ? [...ancestors, node.id] : ancestors);
        if (node.id !== undefined && moved.has(node.id)) {
          o.userData.parentMatrix = local.toArray();
          animator.xform(node.id, node.t ?? [0, 0, 0], node.r ?? [0, 0, 0, 1], node.s ?? [1, 1, 1]);
        }
        place(o, at, node.modifiers, node.srt ?? null);
        if (node.srt?.id !== undefined && node.id !== undefined) animator.srt(node.srt.id, node.id, node.srt);
        sink(o);
      }));
      return;
    }
    if (node.k === "agents") {
      // EveChildBehaviorSystem's still groups: instanced, placed per clone (behaviorAgents.ts AgentRun, from the ticker)
      pending.push(buildAgents(node, (mesh) => childMesh(mesh, animator), (id, get, set) => animator.values(id, get, set), locatorSets).then((g) => {
        g.userData.agentsHolder = true;
        if (node.id !== undefined) { g.userData.childId = node.id; animator.object(node.id, ancestors, node.display !== false); }
        place(g, local.clone().multiply(new THREE.Matrix4().fromArray(node.m)), undefined);
        sink(g);
      }));
      return;
    }
    if (node.k === "lines") {
      const l = lineSet(node, animator, ancestors);
      if (l) {
        if (node.id !== undefined) l.userData.childId = node.id;
        place(l, local.clone().multiply(new THREE.Matrix4().fromArray(node.m)), undefined);
        sink(l);
      }
      return;
    }
    if (node.k === "gpuParticles") {
      const o = gpuDriver(node);
      // their numbers a curve set's binding may drive (rate, colours, sizes, ...: read by the emitter each update)
      for (const e of node.emitters) {
        if (e.id === undefined) continue;
        const rec = e as unknown as Record<string, unknown>;
        animator.values(e.id, (attr) => { const v = rec[attr]; return typeof v === "number" || Array.isArray(v) ? (v as number | number[]) : attr === "rate" ? 0 : undefined; }, (attr, v) => { rec[attr] = v; });
      }
      if (node.id !== undefined) { o.userData.childId = node.id; animator.object(node.id, ancestors, node.display !== false); }
      place(o, local.clone().multiply(new THREE.Matrix4().fromArray(node.m)), node.modifiers);
      sink(o);
      return;
    }
    if (node.k === "procedural") {
      // EveChildProceduralContainer: a holder in its space; each clone cycles its children (CyclingRun, from the ticker)
      const g = new THREE.Group();
      g.name = `child-procedural:${node.name ?? ""}`;
      if (node.display === false) g.visible = false;
      const key = `procedural:${++proceduralKeys}`;
      proceduralNodes.set(key, { node, effects });
      g.userData.proceduralKey = key;
      place(g, local.clone().multiply(node.m ? new THREE.Matrix4().fromArray(node.m) : new THREE.Matrix4()), node.modifiers, node.srt ?? null);
      sink(g);
      procedurals++;
      return;
    }
    if (node.k === "propagator") {
      // EveChildEffectPropagator: a holder in the propagator's space; each model clone runs it (propagator.ts, from the
      // ticker), its instances the source built anew (its own animator, controllers and particle systems: a deep copy,
      // EveChildInstanceContainer::CreateInstance) and placed by their transforms - in EVE's space already, the copy's
      // own mirror replaced by the transform
      const holder = new THREE.Group();
      holder.name = `child-propagator:${node.name ?? ""}`;
      if (node.id !== undefined) { holder.userData.childId = node.id; animator.object(node.id, ancestors, node.display !== false); }
      const key = `propagator:${++propagatorKeys}`;
      propagatorNodes.set(key, { node, effects, locators: node.locatorSet ? locatorSets[node.locatorSet] ?? [] : [] });
      holder.userData.propagatorKey = key;
      if (node.id !== undefined) holder.userData.propagatorId = node.id;
      place(holder, local.clone().multiply(node.m ? new THREE.Matrix4().fromArray(node.m) : new THREE.Matrix4()), undefined);
      sink(holder);
      propagators++;
      return;
    }
    if (node.k === "particles") {
      // a CPU particle system (particles.ts): its quad from the mesh's geometry, placed as a mesh is
      const at = local.clone().multiply(new THREE.Matrix4().fromArray(node.m));
      const url = node.geometry;
      if (!url) return;
      if (!glbCache.has(url)) glbCache.set(url, gltfLoader.loadAsync(url).then((g) => g.scene).catch(() => null));
      pending.push(glbCache.get(url)!.then((scene) => {
        const lod = scene?.children[0]?.children[node.meshIndex] ?? null;
        let quad: THREE.BufferGeometry | null = null;
        lod?.traverse((o) => { if (!quad && (o as THREE.Mesh).isMesh) quad = (o as THREE.Mesh).geometry; });
        if (!quad) return;
        const o = particleObject(node, quad, childTexture, (id, get, set, spawn) => { animator.values(id, get, set); if (spawn) animator.spawner(id, spawn); }, (id, u) => animator.uniform(id, u));
        if (!o) return;
        if (node.id !== undefined) { o.userData.childId = node.id; animator.object(node.id, ancestors, node.display !== false); }
        place(o, at, node.modifiers);
        sink(o);
      }));
      return;
    }
    if (node.k === "traffic") {
      const t = trafficMeshes(node);
      if (t) {
        // no id in its file: one of its own, so that a container a set hides hides it too
        const id = --syntheticChildId;
        t.userData.childId = id;
        animator.object(id, ancestors);
        place(t, local.clone().multiply(new THREE.Matrix4().fromArray(node.m)), undefined);
        sink(t);
      }
      return;
    }
    if (node.k !== "quad") return;
    const parent = flat;
    const local4 = new THREE.Matrix4().fromArray(node.m);
    const s = meanScale(parent);
    const e = local4.elements;
    const b = node.brightness;
    if (node.id !== undefined) { animator.quad(node.id, quadList.length, node.color, b, ancestors, node.display !== false); quadIds?.push(node.id); }
    quadList.push({
      centre: new THREE.Vector3(e[12], e[13], e[14]).applyMatrix4(parent),
      ax: new THREE.Vector3(e[0], e[1], e[2]).multiplyScalar(s),
      ay: new THREE.Vector3(e[4], e[5], e[6]).multiplyScalar(s),
      colour: [(node.color[0] ?? 1) * b, (node.color[1] ?? 1) * b, (node.color[2] ?? 1) * b, (node.color[3] ?? 1) * b],
      min: node.minScreenSize,
      halo,
    });
  };
  for (const child of children ?? []) if (child.root) walk(child.root, new THREE.Matrix4(), new THREE.Matrix4(), (o) => others.push(o));
  await Promise.all(pending);
  // (a hull with no children still runs its own controllers)
  if (!quads.length && !others.length && !lights.length && !controllers.length && !hullControllers.length) return null;
  const group = new THREE.Group();
  group.name = "hull-children";
  group.userData.lights = lights;
  group.scale.set(1, 1, -1);
  if (quads.length) {
    const qm = quadMesh(quads);
    animator.quadAttribute(qm.geometry.getAttribute("iColour") as THREE.InstancedBufferAttribute);
    group.add(qm);
  }
  for (const o of others) group.add(o);
  // the curve sets play from the ticker's frame (with the modifiers)
  if (animator.playing) { animators.set(animator.key, animator); group.userData.animatorKey = animator.key; }
  // the hull's own controllers: owned by the space object (this group, HULL_OWNER: their sets are every child's)
  if (hullControllers.length) { group.userData.controllerOwner = controllers.length; group.userData.controllerOwnerId = HULL_OWNER; controllers.push(hullControllers); group.userData.locatorSets = locatorSets; group.userData.overlays = overlays; }
  if (controllers.length) { group.userData.controllers = controllers; group.userData.childEffects = effects; }
  if (modified || animator.playing || controllers.length || propagators || procedurals || lights.length) group.add(ticker());
  return group;
}
