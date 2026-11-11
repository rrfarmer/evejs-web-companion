// An effect propagator's run (Trinity Eve/SpaceObject/Children/EveChildEffectPropagator.cpp), one per model clone:
// set going by its trigger (a controller's SetValue "trigger"), it reads its locators - its own (LOCAL_LOCATORS), a
// hull locator set (LOCATOR_SET_BY_REF; "damage" when unnamed) or a random spread (RANDOM_SPREAD) - each kept with
// probability completeness, scaled effectScaling x randScaleMin..Max, sorted by distance from the trigger sphere's
// centre (triggerSphereOffset x the sphere multiplier); then, by its trigger method:
// - TRIGGER_SPHERE_CURVE: an instance at each locator as the sphere's radius (triggerSphereRadiusCurve at the play
//   time x the multiplier) passes it; when the curve ends, idle (skipCleanup), replay after stopToClearDelay
//   (replayAfterDelay, sizes drawn again) or stop (instances cleared);
// - INTERVAL_TRIGGERS: an instance every 1 / frequency s at a random locator not among the last frequency x
//   durationPerEffect (GetSmartRandomLocatorIndex), each removed durationPerEffect s after (PopFront), stopping after
//   stopAfterNumTriggers; frequency nought stops it;
// - INSTANT_PERMANENT: every instance at once, kept.
// An instance is the instance container's source copied (EveChildInstanceContainer::CreateInstance: its own curve sets
// played from the start): here a copy from a pool, built as needed (a creation waits for its copy while one builds).

import * as THREE from "three";
import { curveValue, type Curve } from "./curves.ts";

export interface PropagatorData {
  type: number;
  trigger: number;
  locatorSet: string | null;
  /** LOCAL_LOCATORS: each [x, y, z, qx, qy, qz, qw]. */
  local: number[][] | null;
  numTriggers: number;
  range: number;
  closeness: number;
  minRange: number;
  completeness: number;
  scaling: number[];
  randScale: number[];
  sphereOffset: number[];
  sphereCurve: Curve | null;
  skipCleanup: boolean;
  stopToClearDelay: number;
  replayAfterDelay: boolean;
  frequency: number;
  duration: number;
  stopAfter: number;
}

interface Transform { pos: THREE.Vector3; rot: THREE.Quaternion; scale: THREE.Vector3; d2: number }
interface Instance { obj: THREE.Object3D | null; at: THREE.Matrix4 }

/** The most copies one propagator keeps (each a whole child graph). */
const CAP = 96;
const Z = new THREE.Vector3(0, 0, 1);

/** A curve's length (Tr2CurveScalar::Length: its last key's time; nought for one without keys). */
function curveLength(c: Curve | null): number {
  const keys = (c as { keys?: number[][] } | null)?.keys;
  return Array.isArray(keys) && keys.length ? Number(keys[keys.length - 1]![0] ?? 0) : 0;
}

export class PropagatorRun {
  private transforms: Transform[] = [];
  private playing = false;
  private playTime = 0;
  private index = 0;
  private deleted = 0;
  private delay = 0;
  private triggered = false;
  private sphereMulti = 1;
  private lastTriggered: number[] = [];
  private readonly free: THREE.Object3D[] = [];
  private readonly live: Instance[] = [];
  private building = 0;
  private built = 0;
  private frequency: number;

  constructor(private readonly data: PropagatorData, private readonly holder: THREE.Object3D, private readonly hullLocators: number[][],
    private readonly boundsRadius: number, private readonly make: () => Promise<THREE.Object3D | null>, private readonly restart: (o: THREE.Object3D) => void) {
    this.frequency = data.frequency;
  }

  /** The trigger set: the locators read and play started on the next update. */
  trigger(): void { this.triggered = true; }

  /** frequency set (OnModified: the play time put where the triggers so far would have been). */
  setFrequency(f: number): void {
    this.frequency = f;
    if (f !== 0) this.playTime = this.index / f;
  }

  update(dt: number): void {
    if (this.triggered) {
      this.processLocators();
      this.play();
      if (this.data.trigger === 1) this.lastTriggered = new Array(Math.max(Math.floor(this.data.duration * this.frequency), 0)).fill(-1);
    }
    if (!this.playing) return;
    if (this.data.trigger === 0) this.updateCurve(dt);
    else if (this.data.trigger === 1) { if (this.frequency !== 0) this.updateInterval(dt); else this.stop(); }
    else if (this.data.trigger === 2) {
      this.playTime += dt;
      if (this.index === 0) { for (const t of this.transforms) this.create(t); this.index++; }
    }
  }

  private play(): void {
    this.stop();
    this.triggered = false;
    this.playing = true;
    this.delay = this.data.stopToClearDelay;
  }

  private stop(): void {
    this.playing = false;
    this.playTime = 0;
    this.index = 0;
    this.deleted = 0;
    while (this.live.length) this.popFront();
  }

  private updateCurve(dt: number): void {
    this.playTime += dt;
    const curve = this.data.sphereCurve;
    if (curve) {
      const r = curveValue(curve, this.playTime) * this.sphereMulti;
      while (this.index < this.transforms.length && this.transforms[this.index]!.d2 < r * r) { this.create(this.transforms[this.index]!); this.index++; }
    } else { this.stop(); return; }
    if (this.playTime > curveLength(curve)) {
      if (this.data.skipCleanup) return;
      if (this.data.replayAfterDelay) {
        if (this.delay > 0) this.delay -= dt;
        else { for (const t of this.transforms) t.scale.copy(this.scaleOf()); this.play(); }
      } else this.stop();
    }
  }

  private updateInterval(dt: number): void {
    this.playTime += dt;
    if (!this.transforms.length) return;
    const f = this.frequency, d = this.data.duration, stopAfter = this.data.stopAfter;
    if (stopAfter > 0 && d !== -1 && this.playTime > stopAfter / f + d) { this.stop(); return; }
    if (this.playTime > this.index / f && (this.index < stopAfter || stopAfter < 0)) {
      const i = this.smartRandomIndex();
      if (this.lastTriggered.length) this.lastTriggered.shift();
      this.lastTriggered.push(i);
      this.create(this.transforms[i]!);
      this.index++;
    }
    if (d !== -1 && this.playTime > this.deleted / f + d) {
      this.popFront();
      this.deleted++;
      if (this.deleted === this.index) { this.index = 0; this.lastTriggered = []; }
    }
  }

  private smartRandomIndex(): number {
    const n = this.transforms.length, recent = this.lastTriggered;
    if (recent.length >= n || this.frequency * this.data.duration > 0.75 * n) return Math.floor(Math.random() * n);
    for (;;) {
      const i = Math.floor(Math.random() * n);
      if (!recent.includes(i)) return i;
    }
  }

  private scaleOf(): THREE.Vector3 {
    const [lo = 1, hi = 1] = this.data.randScale;
    const k = lo + Math.random() * (hi - lo);
    return new THREE.Vector3((this.data.scaling[0] ?? 1) * k, (this.data.scaling[1] ?? 1) * k, (this.data.scaling[2] ?? 1) * k);
  }

  private processLocators(): void {
    const d = this.data;
    const out: Transform[] = [];
    const keep = () => !(Math.random() > d.completeness);
    if (d.type === 0) {
      let far = 0;
      for (const l of d.local ?? []) {
        if (!keep()) continue;
        const pos = new THREE.Vector3(l[0], l[1], l[2]);
        far = Math.max(far, pos.lengthSq());
        out.push({ pos, rot: new THREE.Quaternion(l[3], l[4], l[5], l[6]), scale: this.scaleOf(), d2: 0 });
      }
      this.sphereMulti = Math.sqrt(far) * 2;
    } else if (d.type === 1) {
      this.sphereMulti = this.boundsRadius;
      for (const l of this.hullLocators) {
        if (!keep()) continue;
        out.push({ pos: new THREE.Vector3(l[0], l[1], l[2]), rot: new THREE.Quaternion(l[3] ?? 0, l[4] ?? 0, l[5] ?? 0, l[6] ?? 1), scale: this.scaleOf(), d2: 0 });
      }
    } else if (d.type === 2) {
      for (let i = 0; i < d.numTriggers; i++) {
        if (!keep()) continue;
        let dist = Math.random();
        dist += (d.closeness - dist) * Math.random();
        dist = d.minRange + (d.range - d.minRange) * dist;
        const a = Math.PI * 2 * Math.random(), z = Math.random() * 2 - 1, s = Math.sqrt(1 - z * z);
        const dir = new THREE.Vector3(s * Math.cos(a), s * Math.sin(a), z);
        out.push({ pos: dir.clone().multiplyScalar(dist), rot: new THREE.Quaternion().setFromUnitVectors(Z, dir), scale: this.scaleOf(), d2: 0 });
      }
      this.sphereMulti = d.range;
    }
    this.transforms = out;
    if (!out.length) { this.stop(); return; }
    const centre = new THREE.Vector3(d.sphereOffset[0] ?? 0, d.sphereOffset[1] ?? 0, d.sphereOffset[2] ?? 0).multiplyScalar(this.sphereMulti);
    for (const t of out) t.d2 = t.pos.distanceToSquared(centre);
    out.sort((x, y) => x.d2 - y.d2);
  }

  /** CreateInstance: a copy at the transform (one from the pool, or the next one built). */
  private create(t: Transform): void {
    const inst: Instance = { obj: null, at: new THREE.Matrix4().compose(t.pos, t.rot, t.scale) };
    this.live.push(inst);
    const obj = this.free.pop();
    if (obj) { this.show(inst, obj); return; }
    if (this.built + this.building >= CAP) return;
    this.building++;
    void this.make().then((o) => {
      this.building--;
      if (!o) return;
      this.built++;
      o.matrixAutoUpdate = false;
      o.visible = false;
      this.holder.add(o);
      const waiting = this.live.find((x) => !x.obj);
      if (waiting) this.show(waiting, o); else this.free.push(o);
    }).catch(() => { this.building--; });
  }

  private show(inst: Instance, obj: THREE.Object3D): void {
    inst.obj = obj;
    obj.matrix.copy(inst.at);
    obj.matrixWorldNeedsUpdate = true;
    obj.visible = true;
    this.restart(obj);
  }

  /** PopFront: the oldest instance taken away (its copy back to the pool). */
  private popFront(): void {
    const inst = this.live.shift();
    if (!inst?.obj) return;
    inst.obj.visible = false;
    const waiting = this.live.find((x) => !x.obj);
    if (waiting) this.show(waiting, inst.obj); else this.free.push(inst.obj);
  }
}
