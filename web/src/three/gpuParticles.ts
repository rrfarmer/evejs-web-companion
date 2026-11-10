// The scene's GPU particle system (Trinity's Particle/Tr2GpuParticleSystem, Tr2GpuSharedEmitter, Tr2GpuUniqueEmitter;
// the kernels Particles/Gpu/Emit.fx and Update.fx; the draw the client's quads.sm_hi), run here on the CPU: one system
// per scene; the hull children's GPU emitters (EveChildParticleSystem.particleEmitters) push emit requests where the
// child is; the system emits them, ages and moves its particles in the world (they do not follow their emitter after
// birth), and draws each as a camera-facing card, back to front, after the scene's transparent things. Each particle
// keeps its emitter's params (a unique emitter's live ones: its particles see a change at once).
//
// Left out: the scene's fog volumes (their factor 1), the GPU budget of 1 048 576 (here 65 536), emit-during-life and
// collision GPU emitters, Tr2GpuSharedEmitter's params by value (here its own object, which never changes), minScreenSize.

import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";
import { logDepth } from "./logDepth.ts";

/** A GPU emitter as the extractor writes it (children.mjs: plainOf of the Tr2Gpu*Emitter). */
export interface GpuEmitterData {
  id?: number;
  type: string;
  continuousEmitter?: boolean; rate?: number; emissionDensity?: number; maxEmissionDensity?: number; maxDisplacement?: number;
  position?: number[]; direction?: number[]; angle?: number; innerAngle?: number; radius?: number; inheritVelocity?: number;
  minSpeed?: number; maxSpeed?: number; minLifeTime?: number; maxLifeTime?: number; sizes?: number[]; sizeVariance?: number;
  color0?: number[]; color1?: number[]; color2?: number[]; color3?: number[]; textureIndex?: number; colorMidpoint?: number;
  velocityStretchRotation?: number; drag?: number; turbulenceAmplitude?: number; turbulenceFrequency?: number; gravity?: number;
  scaledByParent?: boolean; attractorPosition?: number[]; attractorStrength?: number;
}

/** GpuParticleEmitterParams as a particle reads them (the colour curve's exponent from colorMidpoint, Tr2GpuParticleSystem.cpp:63). */
interface Params {
  minLife: number; maxLife: number; tex: number; expo: number; colors: number[][]; sizes: number[]; sizeVariance: number;
  drag: number; turbAmp: number; turbFreq: number; gravity: number; attractor: number[]; attractorStrength: number; vsr: number;
}
const n0 = (v: unknown, d: number) => (typeof v === "number" ? v : d);
const v3 = (v: unknown, d: number[]) => [0, 1, 2].map((i) => (Array.isArray(v) && typeof v[i] === "number" ? (v[i] as number) : d[i]!));
const v4 = (v: unknown) => [0, 1, 2, 3].map((i) => (Array.isArray(v) && typeof v[i] === "number" ? (v[i] as number) : 0));
function paramsOf(d: GpuEmitterData, out?: Params): Params {
  const m = n0(d.colorMidpoint, 0.5);
  const p = out ?? ({} as Params);
  p.minLife = n0(d.minLifeTime, 0); p.maxLife = n0(d.maxLifeTime, 0);
  p.tex = Math.trunc(n0(d.textureIndex, 0));
  p.expo = Math.min(0.99, Math.max(0.001, 1 - (m - Math.floor(m))));
  p.colors = [v4(d.color0), v4(d.color1), v4(d.color2), v4(d.color3)];
  p.sizes = v3(d.sizes, [0, 0, 0]); p.sizeVariance = n0(d.sizeVariance, 0);
  p.drag = n0(d.drag, 0); p.turbAmp = n0(d.turbulenceAmplitude, 0); p.turbFreq = Math.trunc(n0(d.turbulenceFrequency, 1)) / 4096;
  p.gravity = n0(d.gravity, 0); p.attractor ??= [0, 0, 0]; p.attractorStrength = n0(d.attractorStrength, 0);
  p.vsr = n0(d.velocityStretchRotation, 0);
  return p;
}

/** RandomXOrShift.fxh: the emit kernel's generator, per thread. */
function randInit(seed: number): number {
  seed = ((seed ^ 61) ^ (seed >>> 16)) >>> 0; seed = Math.imul(seed, 9) >>> 0; seed = (seed ^ (seed >>> 4)) >>> 0;
  seed = Math.imul(seed, 0x27d4eb2d) >>> 0; return (seed ^ (seed >>> 15)) >>> 0;
}
function xorshift(s: { v: number }): number { let x = s.v; x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; s.v = x; return x; }
const randFloat = (s: { v: number }) => xorshift(s) * (1 / 4294967296);

/** Emit.fx GetRandomDirection: a direction in the cone [innerAngle, angle] about dir (angle >= pi/2: the whole sphere). */
function randomDirection(dir: THREE.Vector3, angle: number, inner: number, r1: number, r2: number, out: THREE.Vector3): THREE.Vector3 {
  if (angle >= Math.PI / 2) angle = Math.PI;
  const phi = inner + (angle - inner) * r1, theta = r2 * 4 * Math.PI;
  const vx = Math.sin(phi) * Math.sin(theta), vy = Math.sin(phi) * Math.cos(theta), vz = Math.cos(phi);
  const D = dir;
  let X = Math.abs(D.x) > Math.abs(D.y) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3().crossVectors(D, X).normalize();
  X = new THREE.Vector3().crossVectors(D, Y);
  return out.copy(D).multiplyScalar(vz).addScaledVector(X, vx).addScaledVector(Y, vy);
}

interface Request { count: number; seed: number; pos: THREE.Vector3; posPrev: THREE.Vector3; dir: THREE.Vector3; dirPrev: THREE.Vector3; vel: THREE.Vector3; velPrev: THREE.Vector3; radius: number; angle: number; inner: number; minSpeed: number; maxSpeed: number; params: Params }

/** The 32^3 turbulence volume (noise32cube_volume.dds: 24-bit B, G, R, x fastest), sampled trilinear and wrapped. */
class Noise {
  constructor(private readonly t: Uint8Array | null) {}
  sample(x: number, y: number, z: number, out: number[]): void {
    const t = this.t;
    if (!t) { out[0] = out[1] = out[2] = 0.5; return; }
    const fx = x * 32 - 0.5, fy = y * 32 - 0.5, fz = z * 32 - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz), ax = fx - ix, ay = fy - iy, az = fz - iz;
    out[0] = out[1] = out[2] = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const w = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
      const o = ((((iz + dz) & 31) * 32 + ((iy + dy) & 31)) * 32 + ((ix + dx) & 31)) * 3;
      out[0] += (t[o + 2]! / 255) * w; out[1] += (t[o + 1]! / 255) * w; out[2] += (t[o]! / 255) * w;
    }
  }
}

const CAPACITY = 65536;

/** One scene's system: the pool, the requests, the simulation and the draw. */
export class GpuParticleSystem {
  readonly mesh: THREE.Mesh;
  private readonly pos = new Float32Array(CAPACITY * 3);
  private readonly vel = new Float32Array(CAPACITY * 3);
  private readonly age = new Float32Array(CAPACITY).fill(-1);
  private readonly seed = new Float32Array(CAPACITY);
  private readonly params: (Params | null)[] = new Array(CAPACITY).fill(null);
  private free: number[] = Array.from({ length: CAPACITY }, (_, i) => CAPACITY - 1 - i);
  private alive = 0;
  private requests: Request[] = [];
  private prev = -1;
  private animZ = 0;
  /** The world's shift since the last step (the space view's origin follows the ship): particles and emitters move by it. */
  pending = new THREE.Vector3();
  private noise = new Noise(null);
  private readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private stepped = -1;

  constructor(urls: { atlas?: string | null; noise?: string | null }) {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute("position", new THREE.Float32BufferAttribute([1, -1, 0, -1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 3, 0, 2]);
    for (const [name, size] of [["iPos", 3], ["iVel", 3], ["iCol", 4], ["iMisc", 4], ["iTex", 1]] as const) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      quad.setAttribute(name, a);
      this.attrs[name] = a;
    }
    quad.instanceCount = 0;
    const uniforms: Record<string, THREE.IUniform> = { atlas: { value: null }, frames: { value: 8 }, resolution: { value: new THREE.Vector2(1, 1) } };
    if (urls.atlas) void loadDds(urls.atlas).then((t) => { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; uniforms.atlas!.value = t; }).catch(() => undefined);
    if (urls.noise) void fetch(urls.noise).then((r) => r.arrayBuffer()).then((b) => { this.noise = new Noise(new Uint8Array(b, 128, 32 * 32 * 32 * 3)); }).catch(() => undefined);
    // Quads.fx (the client's quads.sm_hi): a card half size/4 across in the eye's plane; velocityStretchRotation below
    // nought stretches it back along the particle's screen motion and dims it, else it turns; the atlas frame of 8; the
    // colour premultiplied; small cards faded; blended ONE / INVSRCALPHA, depth tested, not written
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `uniform float frames; uniform vec2 resolution;
        attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec4 iMisc; attribute float iTex;
        varying vec2 vUv; varying vec4 vColor;
        void main() {
          float size = iMisc.x, vsr = iMisc.y, seedf = iMisc.z, age = iMisc.w;
          float s = size * 0.25;
          vec2 c = position.xy;
          vec4 viewPos = viewMatrix * vec4( iPos, 1.0 );
          vec2 off; float alphaK = 1.0;
          if ( vsr < 0.0 ) {
            vec2 tail = ( viewMatrix * vec4( iPos + iVel * vsr, 1.0 ) ).xy;
            vec2 S2 = viewPos.xy - tail; float L = length( S2 );
            vec2 d = L > 0.0 ? S2 / L : vec2( 1.0, 0.0 );
            off = s * vec2( c.x * d.x - c.y * d.y, c.y * d.x + c.x * d.y );
            if ( c.x < 0.0 ) off -= S2;
            alphaK = ( size * 0.5 ) / ( size * 0.5 + L );
          } else {
            float sgn = fract( seedf * 10.0 ) > 0.5 ? 1.0 : -1.0;
            float a = vsr * age * sgn + seedf * 6.28318530;
            float cs = cos( a ), sn = sin( a );
            off = vec2( s * c.x * cs + s * c.y * sn, s * c.x * sn - s * c.y * cs );
          }
          gl_Position = projectionMatrix * vec4( viewPos.xyz + vec3( off, 0.0 ), 1.0 );
          float fade = clamp( 0.5 * min( s / gl_Position.w * resolution.x, s / gl_Position.w * resolution.y ), 0.0, 1.0 );
          // D3D's v (0 at the image's first row): our DDS uploads keep that row at t = 0
          vUv = vec2( ( c.x * 0.5 + 0.5 + iTex ) / frames, c.y * 0.5 + 0.5 );
          vColor = iCol * ( alphaK * fade );
        }`,
      fragmentShader: `uniform sampler2D atlas;
        varying vec2 vUv; varying vec4 vColor;
        vec4 decode(vec4 c) { return vec4(mix(c.rgb / 12.92, pow((c.rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c.rgb)), c.a); }
        void main() { gl_FragColor = decode( texture2D( atlas, vUv ) ) * vColor; }`,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    logDepth(material);
    this.mesh = new THREE.Mesh(quad, material);
    this.mesh.name = "gpu-particles";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6;
    material.onBeforeRender = (renderer, _s, camera) => {
      renderer.getDrawingBufferSize(uniforms.resolution!.value as THREE.Vector2);
      this.step(performance.now() / 1000, camera);
    };
  }

  emit(r: Request): void { if (r.count > 0) this.requests.push(r); }
  get liveCount(): number { return this.alive; }

  /** Tr2GpuParticleSystem's frame: dt (at most 1/15 s), the origin shift, emit, simulate, cull and sort, fill. */
  private step(now: number, camera: THREE.Camera): void {
    if (now === this.stepped) return;
    this.stepped = now;
    const dt = this.prev < 0 ? 0 : Math.min(now - this.prev, 1 / 15);
    this.prev = now;
    const shift = this.pending.clone();
    this.pending.set(0, 0, 0);
    this.animZ += dt * 0.05;
    for (const r of this.requests) this.emitRequest(r);
    this.requests = [];
    this.simulate(dt, shift);
    this.fill(camera);
  }

  private emitRequest(r: Request): void {
    const pos = this.pos, vel = this.vel;
    const d = new THREE.Vector3(), dir = new THREE.Vector3(), tmp = new THREE.Vector3();
    const count = Math.min(r.count, CAPACITY);
    for (let t = 0; t < 256 && t < count; t++) {
      const s = { v: randInit((t + (r.seed >>> 16)) >>> 0) };
      for (let k = t; k < count; k += 256) {
        const i = this.free.pop();
        if (i === undefined) return;
        const b = randFloat(s);
        const r1 = randFloat(s), r2 = randFloat(s); randFloat(s);
        dir.copy(r.dirPrev).lerp(r.dir, b);
        if (dir.lengthSq() === 0) dir.copy(r.dir);
        dir.normalize();
        randomDirection(dir, r.angle, r.inner, r1, r2, d);
        tmp.copy(r.posPrev).lerp(r.pos, b).addScaledVector(d, r.radius);
        pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
        const speed = r.minSpeed + (r.maxSpeed - r.minSpeed) * randFloat(s);
        tmp.copy(r.velPrev).lerp(r.vel, b).addScaledVector(d, speed);
        vel[i * 3] = tmp.x; vel[i * 3 + 1] = tmp.y; vel[i * 3 + 2] = tmp.z;
        this.age[i] = 0;
        this.seed[i] = (xorshift(s) & 0xffff) / 65535;
        this.params[i] = r.params;
        this.alive++;
      }
    }
  }

  /** Update.fx: age, death, gravity (world +y), turbulence (3 octaves of the volume, EVE's space), attractor, drag, move. */
  private simulate(dt: number, shift: THREE.Vector3): void {
    const pos = this.pos, vel = this.vel, age = this.age;
    const n0v = [0, 0, 0], nv = [0, 0, 0];
    this.noise.sample(0, 0, this.animZ / 32, n0v);
    for (let i = 0; i < CAPACITY; i++) {
      if (age[i]! < 0) continue;
      const P = this.params[i]!;
      age[i] = age[i]! + dt;
      const life = P.minLife + (P.maxLife - P.minLife) * this.seed[i]!;
      if (age[i]! >= life) { age[i] = -1; this.params[i] = null; this.free.push(i); this.alive--; continue; }
      const o = i * 3;
      vel[o + 1] = vel[o + 1]! + P.gravity * dt;
      if (P.turbAmp !== 0) {
        // in EVE's space (our z mirrored): the field's sample and its push
        let x = pos[o]! * P.turbFreq + n0v[0]!, y = pos[o + 1]! * P.turbFreq + n0v[1]!, z = -pos[o + 2]! * P.turbFreq + n0v[2]!;
        let rx = 0, ry = 0, rz = 0, amp = 1;
        for (let k = 0; k < 3; k++) {
          this.noise.sample(x, y, z, nv);
          rx += (nv[0]! - 0.5) * amp; ry += (nv[1]! - 0.5) * amp; rz += (nv[2]! - 0.5) * amp;
          amp *= 0.5;
          const zx = z; z = 2 * x; x = 2 * zx; y = 2 * y;
        }
        const k = P.turbAmp * dt;
        vel[o] = vel[o]! + rx * k; vel[o + 1] = vel[o + 1]! + ry * k; vel[o + 2] = vel[o + 2]! - rz * k;
      }
      if (P.attractorStrength !== 0) {
        const ax = P.attractor[0]! - pos[o]!, ay = P.attractor[1]! - pos[o + 1]!, az = P.attractor[2]! - pos[o + 2]!;
        const l = Math.hypot(ax, ay, az);
        if (l > 0) { const k = (P.attractorStrength * dt) / l; vel[o] = vel[o]! + ax * k; vel[o + 1] = vel[o + 1]! + ay * k; vel[o + 2] = vel[o + 2]! + az * k; }
      }
      if (P.drag < 0) {
        const sp = Math.hypot(vel[o]!, vel[o + 1]!, vel[o + 2]!);
        if (sp > 0) { const k = sp * P.drag * dt; vel[o] = vel[o]! + vel[o]! * k; vel[o + 1] = vel[o + 1]! + vel[o + 1]! * k; vel[o + 2] = vel[o + 2]! + vel[o + 2]! * k; }
      } else if (P.drag !== 0) {
        const k = 1 - P.drag * dt;
        vel[o] = vel[o]! * k; vel[o + 1] = vel[o + 1]! * k; vel[o + 2] = vel[o + 2]! * k;
      }
      pos[o] = pos[o]! + vel[o]! * dt + shift.x; pos[o + 1] = pos[o + 1]! + vel[o + 1]! * dt + shift.y; pos[o + 2] = pos[o + 2]! + vel[o + 2]! * dt + shift.z;
      if (!Number.isFinite(pos[o]! + pos[o + 1]! + pos[o + 2]!)) { age[i] = -1; this.params[i] = null; this.free.push(i); this.alive--; }
    }
  }

  /** The visible ones (in the eye's frustum, over 2 px), farthest first, into the instance data. */
  private fill(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    const proj = (camera as THREE.PerspectiveCamera).projectionMatrix;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(proj, view));
    const res = (this.mesh.material as THREE.ShaderMaterial).uniforms.resolution!.value as THREE.Vector2;
    const e = view.elements;
    const list: [number, number][] = [];
    const sphere = new THREE.Sphere();
    for (let i = 0; i < CAPACITY; i++) {
      if (this.age[i]! < 0) continue;
      const P = this.params[i]!;
      const o = i * 3, x = this.pos[o]!, y = this.pos[o + 1]!, z = this.pos[o + 2]!;
      const maxSize = Math.max(P.sizes[0]!, P.sizes[1]!, P.sizes[2]!) * (1 + Math.abs(P.sizeVariance));
      sphere.center.set(x, y, z); sphere.radius = maxSize;
      if (!frustum.intersectsSphere(sphere)) continue;
      const vz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
      if ((maxSize / Math.max(1, -vz)) * proj.elements[0]! * res.x <= 2) continue;
      list.push([vz, i]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const P3 = this.attrs.iPos!.array as Float32Array, V3 = this.attrs.iVel!.array as Float32Array, C4 = this.attrs.iCol!.array as Float32Array;
    const M4 = this.attrs.iMisc!.array as Float32Array, T1 = this.attrs.iTex!.array as Float32Array;
    for (let n = 0; n < list.length; n++) {
      const i = list[n]![1], P = this.params[i]!, seedf = this.seed[i]!, a = this.age[i]!;
      const life = P.minLife + (P.maxLife - P.minLife) * seedf;
      const t = Math.min(1, Math.max(0, life > 0 ? a / life : 1)), v = 1 - t;
      const size = (P.sizes[0]! * v * v + P.sizes[1]! * 2 * t * v + P.sizes[2]! * t * t) * (1 + P.sizeVariance * seedf);
      // GpuParticles.fxh GetGpuParticleColor: the age warped by the exponent, four keys at 0, .333, .666, 1; premultiplied
      const tp = Math.pow(t, -Math.log2(P.expo));
      const [c0, c1, c2, c3] = P.colors as [number[], number[], number[], number[]];
      const [A, B, k] = tp <= 0.333 ? [c0, c1, tp / 0.333] : tp <= 0.666 ? [c1, c2, tp / 0.333 - 1] : [c2, c3, tp / (1 - 0.666) - 0.666 / (1 - 0.666)];
      const col = [0, 1, 2, 3].map((j) => A[j]! + (B[j]! - A[j]!) * k);
      for (let j = 0; j < 3; j++) { P3[n * 3 + j] = this.pos[i * 3 + j]!; V3[n * 3 + j] = this.vel[i * 3 + j]!; }
      C4[n * 4] = col[0]! * col[3]!; C4[n * 4 + 1] = col[1]! * col[3]!; C4[n * 4 + 2] = col[2]! * col[3]!; C4[n * 4 + 3] = col[3]!;
      M4[n * 4] = size; M4[n * 4 + 1] = P.vsr; M4[n * 4 + 2] = seedf; M4[n * 4 + 3] = a;
      T1[n] = P.tex;
    }
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = list.length;
  }
}

const systems = new WeakMap<THREE.Object3D, GpuParticleSystem>();
let assetUrls: { atlas?: string | null; noise?: string | null } = {};
/** The atlas and turbulence volume a SOF build names (any hull's: they are the client's one system's). */
export function setGpuParticleAssets(urls: { atlas?: string | null; noise?: string | null } | undefined): void { if (urls?.atlas) assetUrls = urls; }
/** A scene's system, made and added to it on first use. */
export function gpuSystemOf(scene: THREE.Object3D): GpuParticleSystem {
  let s = systems.get(scene);
  if (!s) { s = new GpuParticleSystem(assetUrls); systems.set(scene, s); scene.add(s.mesh); }
  return s;
}
/** The world moved under the particles (the space view's origin following the ship): by this, in our space. */
export function shiftGpuParticles(scene: THREE.Object3D, by: THREE.Vector3): void { systems.get(scene)?.pending.add(by); }

/** One emitter in one model copy: Tr2GpuSharedEmitter::Update / Spawn (continuous emission), and the unique's params. */
export class GpuEmitter {
  private prevTime = -1;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private carry = 0;
  private readonly dir = new THREE.Vector3();
  private emittedOnce = false;
  private readonly params: Params;
  private readonly unique: boolean;
  constructor(private readonly data: GpuEmitterData) {
    this.unique = data.type === "Tr2GpuUniqueEmitter";
    this.params = paramsOf(data);
  }
  update(now: number, world: THREE.Matrix4, system: GpuParticleSystem, emitCountFactor = 1): void {
    const d = this.data;
    const first = this.prevTime < 0;
    const dt = first ? 0 : now - this.prevTime;
    this.prevTime = now;
    if (dt <= 0 && !first) return;
    const shift = system.pending;
    const P = new THREE.Vector3(...(v3(d.position, [0, 0, 0]) as [number, number, number])).applyMatrix4(world);
    const V = first ? new THREE.Vector3() : P.clone().sub(this.prevPos).sub(shift).divideScalar(dt);
    if (first) this.prevPos.copy(P).sub(shift);
    // the unique emitter's params, refreshed (its living particles see them): the attractor in the world; scaled by
    // the parent's mean scale where scaledByParent
    if (this.unique) paramsOf(d, this.params);
    let scale = 1;
    if (this.unique && d.scaledByParent) {
      const s = new THREE.Vector3(); world.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
      scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
      const p = this.params;
      p.sizes = p.sizes.map((x) => x * scale); p.gravity *= scale; p.turbAmp *= scale; p.attractorStrength *= scale;
    }
    if (this.unique && this.params.attractorStrength !== 0) {
      const a = new THREE.Vector3(...(v3(d.attractorPosition, [0, 0, 0]) as [number, number, number])).applyMatrix4(world);
      this.params.attractor = [a.x, a.y, a.z];
    }
    if (d.continuousEmitter !== false) {
      const start = this.prevPos.clone().add(shift);
      const total0 = this.carry + Math.min(dt, 1 / 15) * n0(d.rate, 0) * emitCountFactor;
      const move = start.distanceTo(P);
      if (move > n0(d.maxDisplacement, 1000)) this.carry = 0;
      else {
        let total = total0;
        const density = n0(d.emissionDensity, 0);
        if (density > 0) total += Math.min(n0(d.maxEmissionDensity, 10000), move * density);
        this.carry = total - Math.floor(total);
        const count = Math.max(Math.trunc(total), 0);
        if (count) {
          const inherit = n0(d.inheritVelocity, 1);
          const dirPrev = this.emittedOnce ? this.dir.clone() : new THREE.Vector3();
          this.dir.set(...(v3(d.direction, [0, 1, 0]) as [number, number, number])).transformDirection(world).multiplyScalar(1);
          this.emittedOnce = true;
          system.emit({
            count, seed: (Math.floor(Math.random() * 32768) << 16) >>> 0,
            pos: P.clone(), posPrev: start, dir: this.dir.clone(), dirPrev,
            vel: V.clone().multiplyScalar(inherit), velPrev: this.prevVel.clone().multiplyScalar(inherit),
            radius: n0(d.radius, 0) * scale, angle: n0(d.angle, 0), inner: n0(d.innerAngle, 0),
            minSpeed: n0(d.minSpeed, 0) * scale, maxSpeed: n0(d.maxSpeed, 0) * scale,
            params: this.unique ? this.params : this.params,
          });
        }
      }
    }
    this.prevPos.copy(P);
    this.prevVel.copy(V);
  }
}
