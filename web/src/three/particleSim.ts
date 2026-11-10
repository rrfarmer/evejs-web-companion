// The CPU particle simulation as Trinity runs it (carbonengine/trinity Particle/: Tr2ParticleSystem::Update and
// UpdateSimulation, Tr2DynamicEmitter::SpawnParticles, the attribute generators and the forces):
// - an emitter spawns rate x dt particles a frame (dt at most 0.3 s; the fraction carried over; maxParticles in all
//   where it is not negative); a full system takes no more that frame; each particle's elements are set by the
//   emitter's generators in order;
// - a system's frame (dt at most 1/3 s): each particle's age (LIFETIME.x) grows by dt / its lifetime (LIFETIME.y), one
//   at 1 or more dies (the last moved into its place); then, with POSITION and VELOCITY, the forces (summed; divided by
//   MASS where there is one) change the velocity by F dt and the velocity moves the position by v dt;
// - the generators: RandomUniform (min + (max - min) rand per component), RandomInteger (that, rounded), Consecutive
//   (min + count % (max - min), counting from 1), RandomDirection (a normalised random cube point), SphereShape (a
//   direction from phi and theta in degrees, (sin phi cos theta, -cos phi, sin phi sin theta), turned by its rotation;
//   velocity that x a speed, position that x a radius (min + (max - min) rand^distributionExponent) + its position) and
//   CapsuleShape (the same along a slerp of its two rotations and a lerp of its two positions);
// - the forces: drag (-v drag), fluid drag (-v |v| drag, not past stopping), attractor and vortex (unit direction x
//   magnitude), direct (its vector), turbulence (octaves of a 4D value noise x amplitude x the octaves' weight sum) and
//   the sphere volume (its forces x (1 - d / radius)^exponent inside it).
// Constraints (plane, sphere), emission on death and during life are not run.

export interface ParticleElement { type?: string; elementType?: number; customName?: string; dimension?: number; usageIndex?: number; usedByGPU?: boolean }
export interface ParticleSystemData { type: string; elements?: ParticleElement[]; forces?: Record<string, unknown>[]; constraints?: Record<string, unknown>[]; [k: string]: unknown }
export interface ParticleEmitterData { type: string; name?: string; rate?: number; maxParticles?: number; particleSystem?: { system: number } | null; generators?: Record<string, unknown>[]; [k: string]: unknown }

/** The element types Trinity names (Tr2ParticleElementDeclarationName::Type). */
export const ELEMENT = { LIFETIME: 0, POSITION: 1, VELOCITY: 2, MASS: 3, CUSTOM: 4 } as const;
const SEMANTIC_SIZES = [2, 3, 3, 1];

/** An element's key: a semantic by its type, a custom one by its name. */
export function elementKey(e: { elementType?: number; customName?: string }): string {
  const t = e.elementType ?? ELEMENT.CUSTOM;
  return t === ELEMENT.CUSTOM ? `custom:${e.customName ?? ""}` : `type:${t}`;
}
export function elementSize(e: ParticleElement): number {
  const t = e.elementType ?? ELEMENT.CUSTOM;
  return t === ELEMENT.CUSTOM ? (e.dimension ?? 1) : SEMANTIC_SIZES[t]!;
}

type Vec3 = [number, number, number];
const rand = Math.random;
const frand = (a: number, b: number) => a + (b - a) * rand();
const arr = (a: unknown, n: number, d = 0): number[] => Array.from({ length: n }, (_, i) => (Array.isArray(a) ? Number((a as number[])[i] ?? d) : d));
const num = (a: unknown, d: number) => (typeof a === "number" ? a : d);

/** v turned by the quaternion q (x, y, z, w): q v q*. */
function rotate(v: Vec3, q: number[]): Vec3 {
  const [x, y, z, w] = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function slerp(a: number[], b: number[], t: number): number[] {
  let [bx, by, bz, bw] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 1];
  const [ax, ay, az, aw] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0 = 1 - t, k1 = t;
  if (cos < 0.9999) { const ang = Math.acos(cos), s = Math.sin(ang); k0 = Math.sin(k0 * ang) / s; k1 = Math.sin(k1 * ang) / s; }
  return [ax * k0 + bx * k1, ay * k0 + by * k1, az * k0 + bz * k1, aw * k0 + bw * k1];
}

// Tr2ParticleTurbulenceForce's Noise4D: a 256-entry random lattice (values rand - 0.5), a shuffled permutation, linear
// interpolation, the z and w lattice indices added rather than permuted
const noiseLookup: number[][] = [];
const noisePerm: number[] = [];
for (let i = 0; i < 256; i++) { noiseLookup.push([rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5]); noisePerm.push(i); }
for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * 256); const s = noisePerm[i]!; noisePerm[i] = noisePerm[j]!; noisePerm[j] = s; }
for (let i = 0; i < 512; i++) { noisePerm.push(noisePerm[i % 256]!); noiseLookup.push(noiseLookup[i % 256]!); }
function noise4(p: number[]): number[] {
  const P = p.map((x) => x + 4096);
  const a = P.map((x) => Math.trunc(x) & 255), b = P.map((x) => Math.trunc(x + 1) & 255);
  const t = p.map((x) => x - Math.floor(x));
  const L = (k: number) => noiseLookup[k]!;
  const lerp = (u: number[], v: number[], s: number) => u.map((x, i) => x + (v[i]! - x) * s);
  const i = noisePerm[a[0]!]!, j = noisePerm[b[0]!]!;
  const b00 = noisePerm[i + a[1]!]!, b10 = noisePerm[j + a[1]!]!, b01 = noisePerm[i + b[1]!]!, b11 = noisePerm[j + b[1]!]!;
  const slice = (w: number) => {
    const c00 = lerp(L(b00 + a[2]! + w), L(b10 + a[2]! + w), t[0]!), c10 = lerp(L(b01 + a[2]! + w), L(b11 + a[2]! + w), t[0]!);
    const c01 = lerp(L(b00 + b[2]! + w), L(b10 + b[2]! + w), t[0]!), c11 = lerp(L(b01 + b[2]! + w), L(b11 + b[2]! + w), t[0]!);
    return lerp(lerp(c00, c10, t[1]!), lerp(c01, c11, t[1]!), t[2]!);
  };
  return lerp(slice(a[3]!), slice(b[3]!), t[3]!);
}

interface Force { update(dt: number): void; force(p: Vec3, v: Vec3, dt: number, mass: number): Vec3 }
const unit = (d: Vec3): Vec3 => { const l = Math.hypot(d[0], d[1], d[2]); return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 0]; };
const still = { update() {} };

export function makeForce(f: Record<string, unknown>): Force | null {
  switch (f.type) {
    case "Tr2ParticleDragForce": case "EveParticleDragForce": {
      const drag = num(f.drag, 0.1);
      return { ...still, force: (_p, v) => [-v[0] * drag, -v[1] * drag, -v[2] * drag] };
    }
    case "Tr2ParticleFluidDragForce": {
      const drag = num(f.drag, 1);
      return { ...still, force: (_p, v, dt, mass) => {
        const k = Math.hypot(v[0], v[1], v[2]) * -drag;
        const F: Vec3 = [v[0] * k, v[1] * k, v[2] * k];
        const n: Vec3 = [v[0] + F[0] * dt * mass, v[1] + F[1] * dt * mass, v[2] + F[2] * dt * mass];
        if (n[0] * v[0] + n[1] * v[1] + n[2] * v[2] < 0) { const m = -1 / (dt * mass); return [v[0] * m, v[1] * m, v[2] * m]; }
        return F;
      } };
    }
    case "Tr2ParticleAttractorForce": {
      const m = num(f.magnitude, 1), at = arr(f.position, 3);
      return { ...still, force: (p) => { const d = unit([at[0]! - p[0], at[1]! - p[1], at[2]! - p[2]]); return [d[0] * m, d[1] * m, d[2] * m]; } };
    }
    case "Tr2ParticleVortexForce": {
      const m = num(f.magnitude, 1), at = arr(f.position, 3), ax = Array.isArray(f.axis) ? arr(f.axis, 3) : [0, 1, 0];
      return { ...still, force: (p) => {
        const o: Vec3 = [at[0]! - p[0], at[1]! - p[1], at[2]! - p[2]];
        const d = unit([o[1] * ax[2]! - o[2] * ax[1]!, o[2] * ax[0]! - o[0] * ax[2]!, o[0] * ax[1]! - o[1] * ax[0]!]);
        return [d[0] * m, d[1] * m, d[2] * m];
      } };
    }
    case "Tr2ParticleDirectForce": case "EveParticleDirectForce": {
      const F = Array.isArray(f.force) ? arr(f.force, 3) : [1, 1, 1];
      return { ...still, force: () => [F[0]!, F[1]!, F[2]!] };
    }
    case "Tr2ParticleTurbulenceForce": {
      const amp = Array.isArray(f.amplitude) ? arr(f.amplitude, 3) : [1, 1, 1], freq = Array.isArray(f.frequency) ? arr(f.frequency, 4) : [1, 1, 1, 1];
      const levels = num(f.noiseLevel, 3), ratio = num(f.noiseRatio, 0.5);
      let time = 0;
      return { update(dt) { time += dt; }, force: (p) => {
        if (levels === 0) return [0, 0, 0];
        let pos = [p[0] * freq[0]!, p[1] * freq[1]!, p[2] * freq[2]!, time * freq[3]!];
        const noise = [0, 0, 0, 0]; let power = 0.5, sum = 0;
        for (let i = 0; i < levels; i++) {
          const n = noise4(pos);
          for (let k = 0; k < 4; k++) noise[k] = noise[k]! + n[k]! * power;
          sum += power; pos = pos.map((x) => x / ratio); power *= ratio;
        }
        return [noise[0]! * amp[0]! * sum, noise[1]! * amp[1]! * sum, noise[2]! * amp[2]! * sum];
      } };
    }
    case "Tr2ForceSphereVolume": {
      const at = arr(f.position, 3), radius = num(f.radius, 1), exp = num(f.exponent, 1);
      const children = ((f.forces as Record<string, unknown>[] | undefined) ?? []).map(makeForce).filter((x): x is Force => !!x);
      return { ...still, force: (p, v, dt, mass) => {
        const d = Math.hypot(p[0] - at[0]!, p[1] - at[1]!, p[2] - at[2]!);
        if (d >= radius) return [0, 0, 0];
        const k = Math.pow(1 - d / radius, exp);
        const F: Vec3 = [0, 0, 0];
        for (const c of children) { const g = c.force(p, v, dt, mass); F[0] += g[0]; F[1] += g[1]; F[2] += g[2]; }
        return [F[0] * k, F[1] * k, F[2] * k];
      } };
    }
    default: return null;
  }
}

/** One particle system's live particles, each element in its own array (max x its size). */
export class ParticleSim {
  readonly max: number;
  alive = 0;
  readonly arrays = new Map<string, Float32Array>();
  readonly sizes = new Map<string, number>();
  private readonly forces: Force[];
  private readonly aging: boolean;
  private readonly simulate: boolean;
  private readonly applyForce: boolean;
  private last = 0;

  constructor(readonly data: ParticleSystemData) {
    this.max = Math.min(10000, Math.max(0, num(data.maxParticleCount, 0)));
    for (const e of data.elements ?? []) {
      const key = elementKey(e), size = elementSize(e);
      this.sizes.set(key, size);
      this.arrays.set(key, new Float32Array(Math.max(1, this.max) * size));
    }
    this.forces = (data.forces ?? []).map(makeForce).filter((x): x is Force => !!x);
    this.aging = data.applyAging !== false;
    this.simulate = data.updateSimulation !== false;
    this.applyForce = data.applyForce !== false;
  }

  /** Room for one more particle: its index, or -1 when full (InsertParticle's false). */
  insert(): number {
    if (this.alive >= this.max) return -1;
    const i = this.alive++;
    for (const [key, a] of this.arrays) { const s = this.sizes.get(key)!; a.fill(0, i * s, (i + 1) * s); }
    return i;
  }

  /** Tr2ParticleSystem::Update at a time in seconds. */
  update(now: number): void {
    if (this.last === 0) this.last = now;
    const dt = Math.min(now - this.last, 1 / 3);
    this.last = now;
    if (dt <= 0) return;
    const life = this.arrays.get(`type:${ELEMENT.LIFETIME}`);
    if (this.aging && life) {
      for (let i = 0; i < this.alive; i++) {
        life[i * 2] = life[i * 2]! + dt / life[i * 2 + 1]!;
        if (life[i * 2]! >= 1) {
          this.alive--;
          if (i < this.alive) for (const [key, a] of this.arrays) { const s = this.sizes.get(key)!; a.copyWithin(i * s, this.alive * s, (this.alive + 1) * s); }
          i--;
        }
      }
    }
    const pos = this.arrays.get(`type:${ELEMENT.POSITION}`), vel = this.arrays.get(`type:${ELEMENT.VELOCITY}`);
    if (!this.simulate || !pos || !vel) return;
    for (const f of this.forces) f.update(dt);
    const mass = this.arrays.get(`type:${ELEMENT.MASS}`);
    const useForces = this.applyForce && this.forces.length > 0;
    for (let i = 0; i < this.alive; i++) {
      const o = i * 3;
      if (useForces) {
        const m = mass ? mass[i]! : 1;
        const p: Vec3 = [pos[o]!, pos[o + 1]!, pos[o + 2]!], v: Vec3 = [vel[o]!, vel[o + 1]!, vel[o + 2]!];
        const F: Vec3 = [0, 0, 0];
        for (const f of this.forces) { const g = f.force(p, v, dt, m); F[0] += g[0]; F[1] += g[1]; F[2] += g[2]; }
        const k = mass ? 1 / m : 1;
        vel[o] = vel[o]! + F[0] * k * dt; vel[o + 1] = vel[o + 1]! + F[1] * k * dt; vel[o + 2] = vel[o + 2]! + F[2] * k * dt;
      }
      pos[o] = pos[o]! + vel[o]! * dt; pos[o + 1] = pos[o + 1]! + vel[o + 1]! * dt; pos[o + 2] = pos[o + 2]! + vel[o + 2]! * dt;
    }
  }
}

type Generator = (sim: ParticleSim, i: number) => void;
export function makeGenerator(g: Record<string, unknown>): Generator | null {
  const key = elementKey({ elementType: typeof g.elementType === "number" ? g.elementType : undefined, customName: typeof g.customName === "string" ? g.customName : undefined });
  const write = (sim: ParticleSim, i: number, k: string, values: (d: number) => number) => {
    const a = sim.arrays.get(k), s = sim.sizes.get(k);
    if (!a || !s) return;
    for (let d = 0; d < s; d++) a[i * s + d] = values(d);
  };
  switch (g.type) {
    case "Tr2RandomUniformAttributeGenerator": {
      const lo = arr(g.minRange, 4), hi = arr(g.maxRange, 4);
      return (sim, i) => write(sim, i, key, (d) => lo[d]! + (hi[d]! - lo[d]!) * rand());
    }
    case "Tr2RandomIntegerAttributeGenerator": {
      const lo = arr(g.minRange, 4), hi = arr(g.maxRange, 4);
      return (sim, i) => write(sim, i, key, (d) => Math.floor(lo[d]! + (hi[d]! - lo[d]!) * rand() + 0.5));
    }
    case "Tr2ConsecutiveIntegerAttributeGenerator": {
      const lo = arr(g.minRange, 4), hi = arr(g.maxRange, 4), cur = [0, 0, 0, 0];
      return (sim, i) => write(sim, i, key, (d) => { cur[d] = cur[d]! + 1; const r = Math.trunc(hi[d]! - lo[d]!) >>> 0; return r ? lo[d]! + (cur[d]! % r) : lo[d]!; });
    }
    case "Tr2RandomDirectionAttributeGenerator":
      return (sim, i) => {
        const s = sim.sizes.get(key) ?? 0;
        const v = Array.from({ length: s }, () => -1 + 2 * rand());
        const l = Math.hypot(...v);
        if (l === 0) v[0] = 1; else for (let d = 0; d < s; d++) v[d] = v[d]! / l;
        write(sim, i, key, (d) => v[d]!);
      };
    case "Tr2SphereShapeAttributeGenerator": case "Tr2CapsuleShapeAttributeGenerator": {
      const capsule = g.type === "Tr2CapsuleShapeAttributeGenerator";
      const phi = [num(g.minPhi, 0), num(g.maxPhi, 360)], theta = [num(g.minTheta, 0), num(g.maxTheta, 360)];
      const radius = [num(g.minRadius, 0), num(g.maxRadius, 0)], speed = [num(g.minSpeed, 0), num(g.maxSpeed, 0)];
      const exp = num(g.distributionExponent, 1);
      const controlPos = capsule || g.controlPosition !== false, controlVel = g.controlVelocity !== false;
      const at = arr(g.position, 3), rot = Array.isArray(g.rotation) ? arr(g.rotation, 4) : [0, 0, 0, 1];
      const p0 = arr(g.positionStart, 3), p1 = arr(g.positionEnd, 3);
      const r0 = Array.isArray(g.rotationStart) ? arr(g.rotationStart, 4) : [0, 0, 0, 1], r1 = Array.isArray(g.rotationEnd) ? arr(g.rotationEnd, 4) : [0, 0, 0, 1];
      const posKey = `type:${ELEMENT.POSITION}`, velKey = `type:${ELEMENT.VELOCITY}`;
      return (sim, i) => {
        const ph = frand(phi[0]!, phi[1]!) * Math.PI / 180, th = frand(theta[0]!, theta[1]!) * Math.PI / 180;
        const t = capsule ? rand() : 0;
        const dir = rotate([Math.sin(ph) * Math.cos(th), -Math.cos(ph), Math.sin(ph) * Math.sin(th)], capsule ? slerp(r0, r1, t) : rot);
        if (controlVel && sim.arrays.has(velKey)) { const s = frand(speed[0]!, speed[1]!); write(sim, i, velKey, (d) => dir[d]! * s); }
        if (controlPos && sim.arrays.has(posKey)) {
          const r = capsule ? frand(radius[0]!, radius[1]!) : radius[0]! + (radius[1]! - radius[0]!) * Math.pow(rand(), exp);
          const base = capsule ? [0, 1, 2].map((d) => p0[d]! + (p1[d]! - p0[d]!) * t) : at;
          write(sim, i, posKey, (d) => dir[d]! * r + base[d]!);
        }
      };
    }
    default: return null;
  }
}

/** A Tr2DynamicEmitter bound to its system: valid only where every generator is one ported here. */
export class ParticleEmitter {
  private readonly generators: Generator[];
  private acc = 0;
  private emitted = 0;
  private last = 0;
  readonly valid: boolean;
  constructor(readonly data: ParticleEmitterData, readonly sim: ParticleSim | null) {
    const made = (data.generators ?? []).map(makeGenerator);
    this.generators = made.filter((x): x is Generator => !!x);
    this.valid = !!sim && data.type === "Tr2DynamicEmitter" && made.every((x) => !!x);
  }
  /** Tr2DynamicEmitter::Update at a time in seconds. */
  update(now: number): void {
    if (!this.valid || !this.sim) return;
    if (this.last === 0) this.last = now;
    const dt = Math.min(now - this.last, 0.3);
    this.last = now;
    const rate = num(this.data.rate, 0);
    if (rate <= 0) return;
    this.acc += rate * dt;
    let count = Math.trunc(this.acc);
    this.acc -= Math.floor(this.acc);
    const limit = num(this.data.maxParticles, -1);
    if (limit >= 0 && this.emitted + count > limit) count = Math.max(limit - this.emitted, 0);
    this.emitted += count;
    for (let k = 0; k < count; k++) {
      const i = this.sim.insert();
      if (i < 0) return;
      for (const g of this.generators) g(this.sim, i);
    }
  }
}
