// EveStretch2 (Trinity's Eve/Renderable/Stretch/EveStretch2.cpp): the stretch a turret's firing effect draws from a
// muzzle to its target - a strip of quads drawn additive by one effect, with lights at its two ends. Its effect gets
// the source and the target (each with the destination's scale), the start, loop and end curve sets' scaled times and a
// random number drawn at each StartFiring, and its intensity (EveStretch2PerObjectData). Its curve sets (start, loop,
// end) drive the effect's parameters and the lights through their bindings: StartFiring plays start and loop from the
// delay given, stops end; StopFiring stops start and loop and plays end.
//
// The effect ported: laser.fx (res:/graphics/effect/managed/space/specialfx/stretch/laser.fx, its sm_depth vertex and
// pixel stages disassembled, client 3396210). Quad 0 is the beam: a strip from source to target turned to face the
// camera, at least about two pixels wide, its profile the FalloffMap across it, two CloudMap scrolls along it; quads 1
// and 2 the flares at the source and the target; the rest the splash at the target (a disc facing back along the
// beam, two CloudMap swirls). Not as the client: no fog volume (no scene sets one); the output stays linear (the client
// writes sRGB into an sRGB target); the scene's depth only where softDepth.ts has drawn it.

import * as THREE from "three";
import { colorValue, curveValue, vector3Value, type Curve } from "./curves.ts";
import { loadDds } from "./ddsTexture.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";
import { offerLights, type ChildLight } from "./dynamicLights.ts";

/** A stretch's curve set as the extractor reads it (lib/turret.mjs stretchCurveSet). */
export interface StretchSet {
  scale: number;
  curves: Curve[];
  bindings: {
    name: string | null; source: number | null; sourceCurve: Curve | null; sourceAttribute: string;
    /** "param:<name>", "sourceLight" or "destinationLight" */
    target: string; destinationAttribute: string; scale: number; offset: number[];
  }[];
}
export interface StretchLight { position: number[]; radius: number; color: number[]; brightness: number; noiseAmplitude: number; noiseFrequency: number; noiseOctaves: number }
/** An EveStretch2 as the extractor reads it (lib/turret.mjs readStretch). */
export interface SofStretch2 {
  type: "EveStretch2"; name: string | null; quadCount: number; effect: string | null;
  params: Record<string, number | number[]>; textures: Record<string, string | null>;
  start: StretchSet | null; loop: StretchSet | null; end: StretchSet | null;
  sourceLight: StretchLight | null; destinationLight: StretchLight | null;
}

/** The effects this file draws. */
export const STRETCH2_EFFECTS = new Set(["laser"]);

// laser.fx's constants, its defaults where the stretch's effect has none (the sm_depth record's constant table)
const LASER_DEFAULTS: Record<string, number | number[]> = {
  Intensity: 1, FlareIntensity: [4, 4, 4, 4], Clouds: [0, 1, 0, -0.91], SplashIntensity: [1, 1, 0.1, 1],
  Flicker: [0, 1, 0, 1], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5],
};

const VERTEX = `
uniform vec4 srcPos; uniform vec4 dstPos; uniform vec4 timing;
uniform float Intensity; uniform vec4 FlareIntensity; uniform vec4 Clouds; uniform vec4 SplashIntensity;
uniform vec2 viewport;
varying vec4 v1; varying vec4 v2;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
varying float vFragDepth; varying float vIsPerspective;
#endif
const vec2 CORNER[4] = vec2[4](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
// a view z drawn nearer by a bias (never past the eye), as the effect's depth: its clip z over the true w
float biasedDepth(float viewZ, float w) {
  float z = min(viewZ, 0.0);
  vec4 c = projectionMatrix * vec4(0.0, 0.0, z, 1.0);
  return min(c.z / c.w, 1.0) * w;
}
void main() {
  float fragW = 1.0;
  if (!(Intensity > 0.0)) {
    gl_Position = vec4(0.0); v1 = vec4(0.0); v2 = vec4(0.0);
  } else {
    vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
    float q = position.x;
    vec2 c = CORNER[int(position.y + 0.5)];
    mat4 VP = projectionMatrix * viewMatrix;
    float r2z = 1.0;
    if (q == 0.0) {
      // the beam: from source to target, turned to face the camera on screen
      vec4 P0 = VP * vec4(S, 1.0), P1 = VP * vec4(D, 1.0);
      vec2 dir = normalize(P1.xy / P1.w - P0.xy / P0.w);
      float u = c.x + 0.5, v = c.y + 0.5;
      vec4 clip = mix(P0, P1, u);
      vec3 world = mix(S, D, u);
      float depth = (VP * vec4(world, 1.0)).w;
      // two pixels' worth at its depth (tan(fov / 2) / height x 4), or 16 x Intensity, whichever is wider
      float pix = depth / projectionMatrix[1][1] / viewport.y * 4.0;
      float halfW = max(pix, Intensity * 16.0);
      gl_Position = vec4(clip.xy + vec2(dir.y, -dir.x) * halfW * c.y, clip.zw);
      fragW = clip.w;
      r2z = pix / (Intensity * 16.0);
      float len = length(S - D);
      float t = timing.w + timing.y;
      vec2 uv = vec2(u * len, v * halfW) / Clouds.y;
      float a = -t * Clouds.z;
      v2.y = uv.x * SplashIntensity.w + a * SplashIntensity.w;
      v2.z = uv.y;
      v2.w = a * Clouds.w * SplashIntensity.w + uv.x * SplashIntensity.w;
      v2.x = len / (sqrt(Intensity) * 30.0) * 0.5;
      v1.xy = c + 0.5;
    } else if (q < 3.0) {
      // the flares: at the source (1) and the target (2), larger seen down the beam's way
      bool atDest = q == 2.0;
      vec3 at = atDest ? D : S;
      vec3 way = normalize(D - S);
      vec2 k = atDest ? FlareIntensity.zw * srcPos.w : FlareIntensity.xy;
      if (atDest) way = -way;
      vec3 back = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
      float lo = k.y * Intensity;
      float size = (dot(way, back) * 0.5 + 0.5) * (Intensity * k.x - lo) + lo;
      vec4 view = viewMatrix * vec4(at, 1.0);
      view.xy += c * size * 16.0;
      vec4 clip = projectionMatrix * vec4(view.xyz, 1.0);
      gl_Position = vec4(clip.xy, biasedDepth(size * 16.0 + view.z, clip.w), clip.w);
      fragW = max(-min(size * 16.0 + view.z, 0.0), 1e-3);
      v1.xy = (c + 0.5) * 2.0 - 1.0;
      v2 = vec4(size, view.z, 0.0, 0.0);
    } else {
      // the splash: a disc at the target across the beam
      vec3 way = normalize(D - S);
      float s = SplashIntensity.x * srcPos.w;
      vec3 up = abs(way.x) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 X = normalize(cross(way, up));
      vec3 Y = cross(way, X);
      vec3 world = (X * c.y + Y * c.x) * s * 16.0 + D;
      vec4 view = viewMatrix * vec4(world, 1.0);
      vec4 clip = projectionMatrix * vec4(view.xyz, 1.0);
      float z = s * SplashIntensity.z + view.z;
      gl_Position = vec4(clip.xy, biasedDepth(z, clip.w), clip.w);
      fragW = max(-min(z, 0.0), 1e-3);
      v1.xy = c + 0.5;
      vec3 toEye = normalize(cameraPosition - D);
      float f = min(abs(dot(-way, toEye)), 1.0) * Intensity;
      v2 = vec4(f * f, s * SplashIntensity.z, -min(z, 0.0), 1.0);
    }
    v1.z = q;
    v1.w = r2z;
  }
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + fragW; vIsPerspective = 1.0;
#endif
}`;

const FRAGMENT = `
#include <logdepthbuf_pars_fragment>
${SOFT_DEPTH_GLSL}
uniform sampler2D NoiseMap; uniform sampler2D FalloffMap; uniform sampler2D CloudMap;
uniform float Intensity; uniform vec4 Flicker; uniform vec4 Clouds; uniform vec4 Color; uniform vec4 SplashAnimation; uniform vec4 SplashIntensity;
uniform vec4 timing; uniform vec4 misc;
varying vec4 v1; varying vec4 v2;
float sceneDistance() { return softDepthOn > 0.5 ? softSceneDepth() : 1e12; }
void main() {
#include <logdepthbuf_fragment>
  vec4 colour;
  vec2 flick;
  if (v1.z == 0.0) {
    // the beam: its profile across, faded where it is thinner than the pixels, and at its two ends
    float a = texture2D(FalloffMap, vec2(v1.y, 0.0)).x * clamp(1.0 / v1.w, 0.0, 1.0);
    float ends = clamp(min(1.0 - v1.x, v1.x) * v2.x, 0.0, 1.0);
    float base = clamp(1.0 - Clouds.x, 0.0, 1.0);
    float n = texture2D(CloudMap, v2.yz).x * texture2D(CloudMap, v2.wz).x;
    float cloud = texture2D(CloudMap, vec2(v1.x, timing.w)).z * n;
    cloud = cloud * (1.0 - base) + base;
    colour = ends * (cloud * a * Color * Intensity);
    flick = Flicker.xy;
  } else if (v1.z < 2.5) {
    // a flare: the falloff over its radius, cut where it goes behind the scene (soft over 30 sqrt(size))
    float sz = sqrt(v2.x);
    float d = length(v1.xy);
    float g = d * 0.5 + 0.5;
    float soft = clamp((sceneDistance() - (-v2.y - sz * 30.0)) / (sz * 30.0), 0.0, 1.0);
    float r = 1.0 - max(1.0 - d, 0.0) * soft;
    float f = textureGrad(FalloffMap, vec2(r * 0.5 + 0.5, 0.0), vec2(dFdx(g), 0.0), vec2(dFdy(g), 0.0)).x;
    colour = f * v2.x * Color;
    flick = Flicker.xy;
  } else {
    // the splash: two swirls of the cloud map by angle and radius, sharpened toward the rim, faded into the scene
    vec2 p = v1.xy - 0.5;
    float ang = atan(p.y, p.x) * 0.159155 + 0.5;
    float rad = length(p);
    float rr = 1.0 - 2.0 * rad;
    float t = timing.w + timing.y;
    vec2 g = vec2(dFdx(rr)), h = vec2(dFdy(rr));
    float s1 = textureGrad(CloudMap, vec2(ang, rr) * SplashAnimation.xy + t * SplashAnimation.zw, g, h).y;
    float s2 = textureGrad(CloudMap, vec2(ang, rr) * SplashAnimation.xy + t * SplashAnimation.zw * vec2(-0.97, 1.03), g, h).y;
    float m = max(rr, 0.0);
    float n = pow(abs(s1 * s2), (1.0 - m) * 10.0);
    float m4 = m * m * m * m;
    float soft = clamp((sceneDistance() - v2.z) / v2.y, 0.0, 1.0);
    soft *= soft; soft *= soft;
    colour = m4 * soft * n * v2.x * (Color * SplashIntensity.y);
    flick = Flicker.zw;
  }
  float noise = texture2D(NoiseMap, vec2(flick.y * timing.y, 0.0)).x;
  colour *= 1.0 - noise * flick.x;
  colour *= misc.x;
  gl_FragColor = vec4(max(colour.rgb, 0.0), colour.a);
}`;

/** The quads' vertices: (quad index, corner index), two triangles a quad. */
function quadGeometry(count: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 4 * 3);
  const index: number[] = [];
  for (let q = 0; q < count; q++) {
    for (let c = 0; c < 4; c++) { pos[(q * 4 + c) * 3] = q; pos[(q * 4 + c) * 3 + 1] = c; }
    index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

const v4 = (v: number | number[] | undefined, d: number[]) => { const a = Array.isArray(v) ? v : d; return new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0); };

/** A stretch's textures, loaded once per file (FalloffMap clamped, as its sampler; the others wrapped). */
const maps = new Map<string, Promise<THREE.Texture | null>>();
function mapOf(url: string | null | undefined, clamp: boolean): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const key = `${url}|${clamp}`;
  let p = maps.get(key);
  if (!p) {
    p = loadDds(url).then((t) => {
      const tex = clamp ? t.clone() : t;
      tex.wrapS = tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      tex.needsUpdate = true;
      return tex as THREE.Texture;
    }).catch(() => null);
    maps.set(key, p);
  }
  return p;
}

/** What a stretch needs before it can be drawn: its textures. */
export interface Stretch2Kit { spec: SofStretch2; noise: THREE.Texture | null; falloff: THREE.Texture | null; cloud: THREE.Texture | null }
export async function stretch2Kit(spec: SofStretch2): Promise<Stretch2Kit | null> {
  if (!spec.effect || !STRETCH2_EFFECTS.has(spec.effect) || spec.quadCount <= 0) return null;
  const [noise, falloff, cloud] = await Promise.all([mapOf(spec.textures.NoiseMap, false), mapOf(spec.textures.FalloffMap, true), mapOf(spec.textures.CloudMap, false)]);
  return { spec, noise, falloff, cloud };
}

/** A curve set's play state (TriCurveSet: PlayFrom, Stop; its scaled time). */
class SetRun {
  playing = false;
  private from = 0;
  private at = 0;
  time = 0;
  constructor(readonly set: StretchSet) {}
  playFrom(t: number, now: number): void { this.playing = true; this.from = t; this.at = now; this.time = t * this.set.scale; }
  stop(): void { this.playing = false; }
  update(now: number): void { if (this.playing) this.time = (this.from + (now - this.at) / 1000) * this.set.scale; }
}

/** A curve's value as a binding reads it (a constant's value, a colour's or vector's parts, a scalar's number). */
function valueOf(c: Curve, time: number): number | number[] {
  switch (c.type) {
    case "Tr2CurveConstant": return ((c as { value?: number[] }).value ?? [0, 0, 0, 0]).slice();
    case "Tr2CurveColor": return colorValue(c as never, time);
    case "Tr2CurveVector3": return vector3Value(c as never, time);
    default: return curveValue(c, time);
  }
}

/** One stretch drawn: its mesh (in its owner's space), its curve sets and lights. */
export class Stretch2Effect {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly sets: { start: SetRun | null; loop: SetRun | null; end: SetRun | null };
  private readonly source = new THREE.Vector3();
  private readonly dest = new THREE.Vector3();
  private destScale = 1;
  private sourceLight: ChildLight | null;
  private destLight: ChildLight | null;

  constructor(private readonly kit: Stretch2Kit) {
    const spec = kit.spec;
    const p = (n: string) => spec.params[n] ?? LASER_DEFAULTS[n];
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: {
        srcPos: { value: new THREE.Vector4(0, 0, 0, 1) }, dstPos: { value: new THREE.Vector4(0, 0, 0, 1) },
        timing: { value: new THREE.Vector4(0, 0, 0, Math.random()) }, misc: { value: new THREE.Vector4(1, 0, 0, 0) },
        viewport: { value: new THREE.Vector2(1, 1) },
        Intensity: { value: Number(p("Intensity") ?? 1) }, FlareIntensity: { value: v4(p("FlareIntensity"), [4, 4, 4, 4]) },
        Clouds: { value: v4(p("Clouds"), [0, 1, 0, -0.91]) }, SplashIntensity: { value: v4(p("SplashIntensity"), [1, 1, 0.1, 1]) },
        Flicker: { value: v4(p("Flicker"), [0, 1, 0, 1]) }, Color: { value: v4(p("Color"), [1, 1, 1, 1]) },
        SplashAnimation: { value: v4(p("SplashAnimation"), [1, 0.1, 0.1, 0.5]) },
        NoiseMap: { value: kit.noise }, FalloffMap: { value: kit.falloff }, CloudMap: { value: kit.cloud },
        ...SOFT_DEPTH,
      },
      // TRIBATCHTYPE_ADDITIVE: added, tested against the scene's depth, not written
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });
    this.material.userData.softDepth = true;
    this.mesh = new THREE.Mesh(quadGeometry(spec.quadCount), this.material);
    this.mesh.name = `stretch2:${spec.name ?? ""}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // each set a copy of its curves (the Ammo constant is set per firing)
    const run = (s: StretchSet | null) => (s ? new SetRun({ ...s, curves: s.curves.map((c) => structuredClone(c)) }) : null);
    this.sets = { start: run(spec.start), loop: run(spec.loop), end: run(spec.end) };
    const light = (l: StretchLight | null): ChildLight | null => (l ? { position: [0, 0, 0], radius: l.radius, color: l.color.slice(), brightness: l.brightness } : null);
    this.sourceLight = light(spec.sourceLight);
    this.destLight = light(spec.destinationLight);
    this.mesh.userData.lights = [];
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const size = renderer.getSize(new THREE.Vector2());
      (this.material.uniforms.viewport!.value as THREE.Vector2).copy(size);
      offerLights(renderer, camera, this.mesh);
    };
  }

  /** turretSet.py SetAmmoColor: every "Ammo" constant curve takes the charge's colour. */
  setAmmoColor(color: number[]): void {
    for (const r of [this.sets.start, this.sets.loop, this.sets.end]) {
      for (const c of r?.set.curves ?? []) if (c.type === "Tr2CurveConstant" && (c as { name?: string }).name === "Ammo") (c as { value?: number[] }).value = color.slice();
    }
  }

  /** EveStretch2::StartFiring: a new random; start and loop played from the delay (nought or past it), end stopped. */
  startFiring(delay: number, now = performance.now()): void {
    (this.material.uniforms.timing!.value as THREE.Vector4).w = Math.random();
    this.sets.start?.playFrom(-delay, now);
    this.sets.loop?.playFrom(-delay, now);
    this.sets.end?.stop();
  }
  /** EveStretch2::StopFiring. */
  stopFiring(now = performance.now()): void {
    this.sets.start?.stop();
    this.sets.loop?.stop();
    this.sets.end?.playFrom(0, now);
  }

  /** SetFiringTransform (the muzzle's place and the target's), SetDestObjectScale / DisplayEndPoints, SetIntensity. */
  place(source: THREE.Vector3, dest: THREE.Vector3, destScale: number, intensity: number): void {
    this.source.copy(source);
    this.dest.copy(dest);
    this.destScale = destScale;
    (this.material.uniforms.misc!.value as THREE.Vector4).x = intensity;
  }

  /** EveStretch2::Update: the sets' times and bindings, the end frames and the lights in them. */
  update(now = performance.now()): void {
    const u = this.material.uniforms;
    const timing = u.timing!.value as THREE.Vector4;
    timing.x = timing.y = timing.z = 0;
    const order: [keyof Stretch2Effect["sets"], "x" | "y" | "z"][] = [["start", "x"], ["loop", "y"], ["end", "z"]];
    for (const [k, c] of order) {
      const r = this.sets[k];
      if (!r) continue;
      r.update(now);
      timing[c] = r.time;
      if (r.playing) this.bind(r);
    }
    (u.srcPos!.value as THREE.Vector4).set(this.source.x, this.source.y, this.source.z, this.destScale);
    (u.dstPos!.value as THREE.Vector4).set(this.dest.x, this.dest.y, this.dest.z, this.destScale);
    // GetEndPointTransforms: z along the beam, x from the axis least along it; the target's frame turned about y
    const z = this.dest.clone().sub(this.source);
    const ax = Math.abs(z.x), ay = Math.abs(z.y), az = Math.abs(z.z);
    const up = ax < ay && ax < az ? new THREE.Vector3(1, 0, 0) : ay < ax && ay < az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    z.normalize();
    const x = up.clone().cross(z).normalize(), y = x.clone().cross(z);
    const lights: ChildLight[] = [];
    const at = (l: ChildLight | null, spec: StretchLight | null, origin: THREE.Vector3, sign: number, scale: number) => {
      if (!l || !spec || !(l.brightness > 0)) return;
      const p = spec.position;
      const pos = origin.clone().addScaledVector(x, sign * (p[0] ?? 0)).addScaledVector(y, p[1] ?? 0).addScaledVector(z, sign * (p[2] ?? 0));
      lights.push({ position: pos.toArray(), radius: spec.radius * scale, color: l.color, brightness: l.brightness });
    };
    at(this.sourceLight, this.kit.spec.sourceLight, this.source, 1, 1);
    at(this.destLight, this.kit.spec.destinationLight, this.dest, -1, this.destScale);
    this.mesh.userData.lights = lights;
  }

  /** A playing set's bindings copied (TriValueBinding: a scalar x scale + offset.x, a vector part by part). */
  private bind(r: SetRun): void {
    const u = this.material.uniforms;
    for (const b of r.set.bindings) {
      const curve = b.source !== null ? r.set.curves[b.source] : b.sourceCurve;
      if (!curve) continue;
      const src = valueOf(curve, r.time);
      const scalar = (v: number | number[]) => (Array.isArray(v) ? (v[0] ?? 0) : v) * b.scale + (b.offset[0] ?? 0);
      const vector = (v: number | number[]) => [0, 1, 2, 3].map((i) => (Array.isArray(v) ? (v[i] ?? 0) : v) * b.scale + (b.offset[i] ?? 0));
      if (b.target.startsWith("param:")) {
        const uni = u[b.target.slice(6)];
        if (!uni) continue;
        if (uni.value instanceof THREE.Vector4) uni.value.fromArray(vector(src));
        else uni.value = scalar(src);
        continue;
      }
      const light = b.target === "sourceLight" ? this.sourceLight : b.target === "destinationLight" ? this.destLight : null;
      if (!light) continue;
      if (b.destinationAttribute === "brightness") light.brightness = scalar(src);
      else if (b.destinationAttribute === "color") light.color = vector(src);
      else if (b.destinationAttribute === "radius") light.radius = scalar(src);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
