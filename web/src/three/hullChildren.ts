// A hull's children (EveSOFDataHull.children, read by tools/client-extract/lib/children.mjs): the static part of the
// client's EveChild* graph, in EVE's model space, mirrored in z here as the model is. Drawn so far: the containers'
// transforms, the quads (EveChildQuad with flarequad.fx / flarequadsoft.fx) and a station's traffic (an EveChildMesh on
// a Tr2InstancedMesh with traffic.fx). Other meshes, line sets, particle systems, lights, curve sets and state machines
// are later stages.

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";
import { loadDds, loadDds3D } from "./ddsTexture.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export interface SofChildQuad {
  k: "quad";
  name: string | null;
  m: number[];
  color: number[];
  brightness: number;
  minScreenSize: number;
  effect: string | null;
}
export interface SofChildContainer {
  k: "container";
  name: string | null;
  m: number[] | null;
  modifiers: string[];
  srt?: SofChildSrt | null;
  objects: SofChildNode[];
  /** Its point lights (Tr2PointLight), in its own space. */
  lights?: { position: number[]; radius: number; innerRadius: number; color: number[]; brightness: number }[];
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
  kind: "opaque" | "transparent" | "additive";
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
export interface SofChildSrt { translation: number[]; rotation: number[]; scaling: number[] }
export interface SofChildLines {
  k: "lines";
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
export type SofChildNode = SofChildQuad | SofChildContainer | SofChildTraffic | SofChildMesh | SofChildLines;
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
 * pixel: (1 / (d + 0.001) - 0.999001) x 1.001 for d the distance from the middle (1 at the edge), added. The client's
 * pixel stage also takes a screen-space occlusion array by depth (its t0), not drawn here; flarequadsoft.fx is drawn
 * as flarequad.fx. A quad under minScreenSize pixels across is not drawn.
 */
function quadMesh(quads: { centre: THREE.Vector3; ax: THREE.Vector3; ay: THREE.Vector3; colour: number[]; min: number; halo: { z: THREE.Vector3; at: THREE.Vector3 } | null }[]): THREE.Mesh {
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
 * TexMap x colour, its alpha over the colour, added. The client's screen-space occlusion array is not drawn.
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
 * directional light, its colour x intensity; the ambient light's). Additive areas added (one, one), transparent ones
 * blended over. Not drawn: the soft depth fade and the screen-space occlusion array.
 */
function uberMaterial(area: SofChildMeshArea): THREE.ShaderMaterial {
  const p = area.params;
  const maps = ["DiffuseMap1", "DiffuseMap2", "DiffuseMap3"].filter((k) => area.textures[k]).length;
  const count = ({ ONE: 1, TWO: 2, THREE: 3 } as Record<string, number>)[area.options.DIFFUSE_MAP_COUNT ?? ""] ?? Math.max(1, maps);
  const uniforms: Record<string, THREE.IUniform> = {
    time: effectClock,
    colour: { value: v4(p.DiffuseColor, [1, 1, 1, 1]) }, fresnel: { value: v4(p.FresnelFactors, [0, 1, 0, 0]) },
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
    fragmentShader: `uniform sampler2D d1; uniform sampler2D d2; uniform sampler2D d3; uniform sampler2D mask;
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
        gl_FragColor = vec4(c.rgb * f, clamp(c.a, 0.0, 1.0));
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
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
 * (one, one) for an additive area. The screen-space occlusion array is not drawn.
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
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
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
 * The gradient colour is baseColor x brightness and the animation colour animColor; the speed the set's scrollSpeed
 * (the call that hands these to the curve is not read: its fields are taken by their names, ChangeLineAnimation's
 * speed being "the speed the pattern/texture crawls along the line"). No curve sets a multicolour. The screen-space
 * occlusion array is not drawn.
 */
function lineSet(node: SofChildLines): THREE.Object3D | null {
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
    colour: { value: new THREE.Vector4((bc[0] ?? 1) * k, (bc[1] ?? 1) * k, (bc[2] ?? 1) * k, bc[3] ?? 1) },
    anim: { value: new THREE.Vector4(ac[0] ?? 0, ac[1] ?? 0, ac[2] ?? 0, ac[3] ?? 1) },
  };
  void childTexture(node.textures.TexMap).then((t) => { uniforms.tex.value = t; });
  void childTexture(node.textures.OverlayTexMap).then((t) => { uniforms.overlay.value = t; });
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
async function childMesh(node: SofChildMesh): Promise<THREE.Object3D | null> {
  if (!node.geometry) return null;
  const holder = new THREE.Group();
  holder.name = `child-mesh:${node.name ?? ""}`;
  const url = node.geometry;
  if (!glbCache.has(url)) glbCache.set(url, gltfLoader.loadAsync(url).then((g) => g.scene).catch(() => null));
  const materials = new Map<SofChildMeshArea, THREE.ShaderMaterial>();
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
      const area = node.areas.find((a) => at >= a.index && at < a.index + a.count);
      if (!area) return;
      if (!materials.has(area)) materials.set(area, area.effect === "fx3dv5" ? fx3dMaterial(area) : uberMaterial(area));
      const m = new THREE.Mesh(mesh.geometry, materials.get(area)!);
      m.renderOrder = 3;
      m.frustumCulled = false;
      o.updateWorldMatrix(true, false);
      m.applyMatrix4(o.matrixWorld);
      inner.add(m);
    });
    holder.add(inner);
  }
  return holder;
}

/** The transform modifiers drawn so far (the rest leave the transform as it is). */
const MODIFIERS = new Set(["EveChildModifierHalo", "EveChildModifierCameraOrientedRotationConstrained", "EveChildModifierBillboard2D", "EveChildModifierSRT"]);

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
 * (EveChildModifierHaloInverted, a billboard in the child's own frame turned by a camera vector not yet placed, is
 * not drawn.)
 */
function applyModifiers(base: THREE.Matrix4, mods: string[], eye: THREE.Vector3, eyeAxes: THREE.Vector3[], out: THREE.Matrix4, srt: SofChildSrt | null = null): void {
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
    } else if (mod === "EveChildModifierBillboard2D") {
      const [ex, ey, ez] = eyeAxes as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      out.makeBasis(ex.clone().multiplyScalar(x.length()), ey.clone().multiplyScalar(y.length()), ez.clone().multiplyScalar(z.length()));
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
tickerMaterial.onBeforeRender = (_r, _s, camera, _g, object) => {
  const group = object.parent;
  if (!group) return;
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
    applyModifiers(base, o.userData.modifiers as string[], eye, axes, o.matrix, (o.userData.srt as SofChildSrt | undefined) ?? null);
    o.matrixWorldNeedsUpdate = true;
    o.updateMatrixWorld(true);
  }
};
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
export async function hullChildren(children: SofHullChild[] | undefined): Promise<THREE.Object3D | null> {
  const quads: Parameters<typeof quadMesh>[0] = [];
  const others: THREE.Object3D[] = [];
  const pending: Promise<void>[] = [];
  let modified = 0;
  // the containers' point lights, in the hull's EVE space (the group's userData.lights, read by the space view)
  const lights: { position: number[]; radius: number; color: number[]; brightness: number }[] = [];
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
  const walk = (node: SofChildNode, flat: THREE.Matrix4, local: THREE.Matrix4, sink: (o: THREE.Object3D) => void, halo: Halo = null) => {
    if (node.k === "container") {
      const m = node.m ? new THREE.Matrix4().fromArray(node.m) : new THREE.Matrix4();
      const flatHere = flat.clone().multiply(m);
      for (const l of node.lights ?? []) {
        const at = new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0).applyMatrix4(flatHere);
        lights.push({ position: at.toArray(), radius: l.radius * meanScale(flatHere), color: l.color, brightness: l.brightness });
      }
      if (node.modifiers.includes("EveChildModifierHalo")) {
        const z = new THREE.Vector3();
        flatHere.extractBasis(new THREE.Vector3(), new THREE.Vector3(), z);
        halo = { z: z.normalize(), at: new THREE.Vector3().setFromMatrixPosition(flatHere) };
      }
      if (node.modifiers.some((x) => MODIFIERS.has(x))) {
        const g = new THREE.Group();
        g.name = `child-container:${node.name ?? ""}`;
        place(g, local.clone().multiply(m), node.modifiers, node.srt ?? null);
        sink(g);
        for (const o of node.objects) walk(o, flatHere, new THREE.Matrix4(), (c) => g.add(c), halo);
        return;
      }
      const localHere = local.clone().multiply(m);
      for (const o of node.objects) walk(o, flatHere, localHere, sink, halo);
      return;
    }
    if (node.k === "mesh") {
      const at = local.clone().multiply(new THREE.Matrix4().fromArray(node.m));
      pending.push(childMesh(node).then((o) => {
        if (!o) return;
        place(o, at, node.modifiers, node.srt ?? null);
        sink(o);
      }));
      return;
    }
    if (node.k === "lines") {
      const l = lineSet(node);
      if (l) {
        place(l, local.clone().multiply(new THREE.Matrix4().fromArray(node.m)), undefined);
        sink(l);
      }
      return;
    }
    if (node.k === "traffic") {
      const t = trafficMeshes(node);
      if (t) {
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
    quads.push({
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
  if (!quads.length && !others.length && !lights.length) return null;
  const group = new THREE.Group();
  group.name = "hull-children";
  group.userData.lights = lights;
  group.scale.set(1, 1, -1);
  if (quads.length) group.add(quadMesh(quads));
  for (const o of others) group.add(o);
  if (modified) group.add(ticker());
  return group;
}
