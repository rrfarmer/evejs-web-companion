// The hull children's curve sets played (trinity's TriCurveSet and TriValueBinding: carbonengine/trinity
// Curves/TriCurveSet.cpp, TriValueBinding.cpp): a set that plays on load runs from nought; a set plays (PlayFrom(0)),
// its time advancing by its scale x the time passed, within its time range where it has one (held at the range's
// start below it; wrapped where the range loops, else held at its end), unbounded otherwise (each curve's
// extrapolation does the rest); a stopped set is left as it was. A controller plays and stops sets by name under its
// container (EveChildContainer::PlayCurveSet: its own sets of that name and its objects'), with a range or without
// (ResetTimeRange). Each frame a playing set's curves are evaluated and its
// bindings copy them to their objects: a scalar to a scalar as value x scale + offset.x, to a vector as value x scale
// + the offset's own component on each, a vector or colour to a vector component by component; a ".x" .. ".w" on the
// attribute names one component (on either side).
//
// What the bindings drive so far: a quad's brightness and colour (its instance in the quads' mesh), an effect's
// parameter (Tr2Vector4Parameter: the material's uniform of that name), a line set's baseColor and animColor, the
// display of quads, meshes, line sets and containers (a container's hides what it holds), and the translation,
// rotation and scaling of a container or a mesh (its object's transform recomposed under its parents'), a curve's
// timeOffset (a scalar's or a colour's: the time it reads at is the less by it) and another binding's scale. A
// randconst behind a timeOffset is one per hull model here, its clones sharing the animator (the client's copies each
// have their own). Not yet: quads under a moving container, lights, modifiers' values.

import * as THREE from "three";
import { colorValue, curveValue, rotationValue, vector3Value, type Curve } from "./curves.ts";

export interface SofCurveSet {
  /** Its id (a controller's AnimateCurveSet names it). */
  id?: number;
  name: string | null;
  /** false: waits for a controller to play it (absent: plays on load). */
  playOnLoad?: boolean;
  scale: number;
  ranges?: { name: string; start: number; end: number; looped: boolean }[];
  curves: Curve[];
  bindings: {
    id?: number;
    source: number | null;
    sourceCurve: Curve | null;
    /** A container's fx attributes as the source (its id): the ticker's values for them, by attribute name. */
    sourceFx?: number;
    /** The container's inherited properties as the source (EveChildInheritProperties): the faction's colour, fixed. */
    sourceConst?: number[];
    sourceAttribute: string;
    destination: number;
    destinationType: string | null;
    destinationAttribute: string;
    scale: number;
    offset: number[];
  }[];
}

type Value = number | number[];

const COMPONENT: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

/**
 * Tr2CurveColorMixer's value (Curves/Tr2CurveColorMixer.cpp GetValue): lerp(color1, color2, lerpValue), drawn toward
 * its own intensity (0.299 r + 0.587 g + 0.114 b, all four) where saturation is not 1, times brightness, its alpha
 * alphaOverride (saturated) where that is not -1. Defaults: colours (0, 0, 0, 1), lerpValue 0, saturation and
 * brightness 1, alphaOverride -1. Its convertedLinearValue is that with r, g and b sRGB-decoded.
 */
function mixerValue(c: Record<string, unknown>, linear: boolean): number[] {
  const a = Array.isArray(c.color1) ? (c.color1 as number[]) : [0, 0, 0, 1], b = Array.isArray(c.color2) ? (c.color2 as number[]) : [0, 0, 0, 1];
  const t = typeof c.lerpValue === "number" ? c.lerpValue : 0;
  let out = [0, 1, 2, 3].map((i) => (a[i] ?? (i === 3 ? 1 : 0)) + ((b[i] ?? (i === 3 ? 1 : 0)) - (a[i] ?? (i === 3 ? 1 : 0))) * t);
  const sat = typeof c.saturation === "number" ? c.saturation : 1;
  if (sat !== 1) { const i = out[0]! * 0.299 + out[1]! * 0.587 + out[2]! * 0.114; out = out.map((v) => i + (v - i) * Math.max(0, sat)); }
  const k = typeof c.brightness === "number" ? c.brightness : 1;
  out = out.map((v) => v * k);
  if (typeof c.alphaOverride === "number" && c.alphaOverride !== -1) out[3] = Math.min(1, Math.max(0, c.alphaOverride));
  if (linear) for (let i = 0; i < 3; i++) { const x = out[i]!; out[i] = x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
  return out;
}

/** A curve's value as a binding reads its currentValue. */
function valueOf(curve: Curve, time: number): Value {
  switch (curve.type) {
    case "Tr2CurveColorMixer": return mixerValue(curve as unknown as Record<string, unknown>, false);
    case "Tr2CurveColor": return colorValue(curve as never, time);
    case "Tr2CurveVector3": case "Tr2CurveVector3Expression": return vector3Value(curve as never, time);
    case "Tr2CurveEulerRotation": case "Tr2CurveEulerRotationExpression": return rotationValue(curve as never, time);
    default: return curveValue(curve, time);
  }
}

/** The binding's copy (TriValueBinding's copy functions): the value at the destination, given its present one. */
function copied(src: Value, srcComponent: number | null, scale: number, offset: number[], dest: Value, destComponent: number | null): Value {
  const s = Array.isArray(src) ? (srcComponent !== null ? src[srcComponent] ?? 0 : src) : src;
  if (destComponent !== null) {
    const v = Array.isArray(s) ? (s[0] ?? 0) : s;
    const out = Array.isArray(dest) ? dest.slice() : [dest];
    out[destComponent] = v * scale + (offset[0] ?? 0);
    return out;
  }
  if (Array.isArray(dest)) {
    return dest.map((_, i) => (Array.isArray(s) ? (s[i] ?? 0) * scale + (offset[i] ?? 0) : s * scale + (offset[i] ?? 0)));
  }
  return (Array.isArray(s) ? (s[0] ?? 0) : s) * scale + (offset[0] ?? 0);
}

/** A float to a bool (display): TriValueBinding's Copy<float, bool>, neither scaled nor offset - on where not nought. */
function onOf(src: Value, srcComponent: number | null): boolean {
  const v = Array.isArray(src) ? (src[srcComponent ?? 0] ?? 0) : src;
  return v !== 0;
}

interface QuadTarget { kind: "quad"; index: number; color: number[]; brightness: number; display: boolean; ancestors: number[]; attr?: THREE.InstancedBufferAttribute }
interface UniformTarget { kind: "uniform"; uniform: THREE.IUniform }
interface LinesTarget { kind: "lines"; colour: THREE.IUniform; anim: THREE.IUniform; base: number[]; anim0: number[]; brightness: number; display: boolean; ancestors: number[] }
interface ObjectTarget { kind: "object"; display: boolean; ancestors: number[] }
interface ContainerTarget { kind: "container"; display: boolean }
/** An EveChildModifierSRT: its own transform, laid on its owner (a mesh or container: owner its id) each frame. */
interface SrtTarget { kind: "srt"; owner: number; translation: number[]; rotation: number[]; scaling: number[]; dirty: number }
/** An object's attributes a binding may set (an emitter's rate, a generator's ranges), read and written by name. */
interface ValueTarget { kind: "value"; get(attr: string): Value | undefined; set(attr: string, v: Value): void }
type Target = QuadTarget | UniformTarget | LinesTarget | ObjectTarget | ContainerTarget | SrtTarget | ValueTarget;
interface Xform { t: number[]; r: number[]; s: number[]; dirty: number }
/** A set's play state: its owners (the containers it is under, its own first-to-last), time and range. */
interface SetRun { set: SofCurveSet; owners: number[]; playing: boolean; last: number; time: number; range: { min: number; max: number; looped: boolean } | null; applyAt: number | null; scale: number }

/** A curve's length (Tr2CurveScalar::Length: its last key's time; a composite's, its parts' longest). */
function curveLength(c: unknown): number {
  if (!c || typeof c !== "object") return 0;
  const o = c as Record<string, unknown>;
  if (Array.isArray(o.keys)) return Math.max(0, ...(o.keys as number[][]).map((k) => k[0] ?? 0));
  let l = 0;
  for (const [k, v] of Object.entries(o)) if (k !== "keys" && v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") l = Math.max(l, curveLength(v));
  return l;
}

/** The owner id of a hull-level controller: the space object itself (EveSpaceObject2::PlayCurveSet reaches every child). */
export const HULL_OWNER = 0;

/** One hull's curve sets and what their bindings reach; shared by the model's clones (found by their key). */
export class ChildAnimator {
  readonly key = THREE.MathUtils.generateUUID();
  private readonly targets = new Map<number, Target>();
  private readonly sets: SetRun[] = [];
  private readonly xforms = new Map<number, Xform>();
  /** The curves and bindings by id, for the bindings that drive a curve's timeOffset or a binding's scale. */
  private readonly curvesById = new Map<number, Record<string, unknown>>();
  private readonly bindingsById = new Map<number, SofCurveSet["bindings"][number]>();
  private quadColour: THREE.InstancedBufferAttribute | null = null;
  private readonly start = performance.now();
  private visibility = 1;

  quad(id: number, index: number, color: number[], brightness: number, ancestors: number[], display = true): void {
    this.targets.set(id, { kind: "quad", index, color: color.slice(0, 4), brightness, display, ancestors });
  }
  quadAttribute(a: THREE.InstancedBufferAttribute): void { this.quadColour = a; }
  /** A quad drawn by a live container's own quad mesh (hullChildren.ts): its colour in that mesh's attribute. */
  quadAttributeOf(id: number, a: THREE.InstancedBufferAttribute): void {
    const t = this.targets.get(id);
    if (t?.kind === "quad") { t.attr = a; this.writeQuad(t); }
  }
  uniform(id: number, uniform: THREE.IUniform | undefined): void { if (uniform) this.targets.set(id, { kind: "uniform", uniform }); }
  lines(id: number, colour: THREE.IUniform, anim: THREE.IUniform, base: number[], animColor: number[], brightness: number, ancestors: number[], display = true): void {
    this.targets.set(id, { kind: "lines", colour, anim, base: base.slice(0, 4), anim0: animColor.slice(0, 4), brightness, display, ancestors });
  }
  /** An object whose attributes bindings set (a particle emitter: its rate; a generator: its ranges, its speeds). */
  values(id: number, get: (attr: string) => Value | undefined, set: (attr: string, v: Value) => void): void { this.targets.set(id, { kind: "value", get, set }); }
  object(id: number, ancestors: number[], display = true): void { this.targets.set(id, { kind: "object", display, ancestors }); }
  /** A container or mesh whose translation, rotation or scaling a binding drives (its own, in its parent's space). */
  xform(id: number, t: number[], r: number[], s: number[]): void { this.xforms.set(id, { t: t.slice(0, 3), r: r.slice(0, 4), s: s.slice(0, 3), dirty: 1 }); }
  /** An SRT modifier a binding may drive: its owner's objects carry its transform in userData.srt. */
  srt(id: number, owner: number, srt: { translation: number[]; rotation: number[]; scaling: number[] }): void {
    this.targets.set(id, { kind: "srt", owner, translation: srt.translation.slice(0, 3), rotation: srt.rotation.slice(0, 4), scaling: srt.scaling.slice(0, 3), dirty: 0 });
  }
  /** A container (hidden where its file has it so: a set shows it). */
  container(id: number, display = true): void { if (!this.targets.has(id)) this.targets.set(id, { kind: "container", display }); }
  /** A container's curve sets; owners: the containers they are under (ids), down to their own. */
  curveSets(sets: SofCurveSet[] | undefined, owners: number[] = []): void {
    const index = (c: unknown): void => {
      if (!c || typeof c !== "object") return;
      if (Array.isArray(c)) { c.forEach(index); return; }
      const o = c as Record<string, unknown>;
      if (typeof o.id === "number" && typeof o.type === "string") this.curvesById.set(o.id, o);
      for (const [k, v] of Object.entries(o)) if (k !== "keys" && v && typeof v === "object") index(v);
    };
    for (const s of sets ?? []) {
      const onLoad = s.playOnLoad !== false;
      this.sets.push({ set: s, owners, playing: onLoad, last: performance.now(), time: 0, range: null, applyAt: null, scale: s.scale });
      index(s.curves);
      for (const b of s.bindings) { if (b.id !== undefined) this.bindingsById.set(b.id, b); if (b.sourceCurve) index(b.sourceCurve); }
    }
  }
  get playing(): boolean { return this.sets.length > 0; }

  /** The sets of a name under an owner: a container (by id), or HULL_OWNER - the space object, every set. */
  private under(owner: number, name: string): SetRun[] {
    return this.sets.filter((r) => r.set.name === name && (owner === HULL_OWNER || r.owners.includes(owner)));
  }
  /** TriCurveSet::Play (no range: ResetTimeRange) or PlayTimeRange (a range it lacks: left as it is). */
  play(owner: number, name: string, range = ""): void {
    for (const r of this.under(owner, name)) {
      if (range) {
        const found = r.set.ranges?.find((x) => x.name === range);
        if (!found) continue;
        r.range = { min: Math.min(found.start, found.end), max: Math.max(found.start, found.end), looped: found.looped };
      } else r.range = null;
      r.playing = true;
      r.time = 0;
      r.last = performance.now();
    }
  }
  stop(owner: number, name: string): void { for (const r of this.under(owner, name)) r.playing = false; }
  /**
   * Tr2ActionSetValue on a curve's input (input1..4) or an effect parameter (its uniform: "value" sets every component,
   * "value.x".."value.w" one). False where this animator has no such target.
   */
  setValue(id: number, attribute: string, value: number): boolean {
    const curve = this.curvesById.get(id);
    if (curve && /^input[1-4]$/.test(attribute)) { curve[attribute] = value; return true; }
    const t = this.targets.get(id);
    if (t?.kind !== "uniform") return false;
    const u = t.uniform.value as THREE.Vector4 | number;
    const comp = attribute.split(".")[1];
    if (typeof u === "number") t.uniform.value = value;
    else if (comp && comp in u) (u as unknown as Record<string, number>)[comp] = value;
    else u.set(value, value, value, value);
    return true;
  }
  /**
   * EveEffectRoot2::Start (EveEffectRoot2.cpp:580-596): every curve set played from its start (the root's own and its
   * children's, PlayAllCurveSets), at its own speed - an effect copy made beforehand begins now.
   */
  restart(): void {
    const now = performance.now();
    for (const r of this.sets) { r.playing = true; r.time = 0; r.last = now; r.range = null; r.applyAt = null; r.scale = r.set.scale; }
  }
  /** TriCurveSet::ApplyTime: the set's curves and bindings at that time, next step (a playing set goes on from it). */
  applyTime(id: number, time: number): void {
    for (const r of this.sets) if (r.set.id === id) r.applyAt = time;
  }
  /** The particle emitters a controller's Tr2ActionSpawnParticles may fire, by id. */
  private readonly spawners = new Map<number, (rate: number) => void>();
  spawner(id: number, spawn: (rate: number) => void): void { this.spawners.set(id, spawn); }
  spawn(id: number, rate: number): void { this.spawners.get(id)?.(rate); }
  /** A controller's SetValue on a set's scale: its time advances by this x the time passed. */
  setScale(id: number, scale: number): void {
    for (const r of this.sets) if (r.set.id === id) r.scale = scale;
  }
  /** A controller's SetValue on an object's display (a container, mesh, quad or line set). */
  setDisplay(id: number, on: boolean): void {
    const t = this.targets.get(id);
    if (!t || !("display" in t) || t.display === on) return;
    t.display = on;
    this.visibility++;
    if (t.kind === "quad") this.writeQuad(t);
  }
  /** CurveSetTime(): the longest curve of the sets of that name under the owner, or the range's length. */
  duration(owner: number, name: string, range = ""): number {
    let d = 0;
    for (const r of this.under(owner, name)) {
      if (range) { const x = r.set.ranges?.find((y) => y.name === range); d = Math.max(d, x ? x.end - x.start : 0); }
      else d = Math.max(d, ...r.set.curves.map(curveLength), 0);
    }
    return d;
  }

  /** One frame: every set's curves at its time, every binding copied; visibility to the given objects (a clone's). */
  step(objects: Map<number, THREE.Object3D[]>, seen: { visibility: number; xforms?: Map<number, number>; srts?: Map<number, number> }): void {
    const now = performance.now();
    for (const run of this.sets) {
      if (!run.playing && run.applyAt === null) continue;
      const set = run.set;
      if (run.applyAt !== null) { run.time = run.applyAt; run.applyAt = null; run.last = now; }
      else run.time += run.scale * Math.max(0, now - run.last) / 1000;
      run.last = now;
      if (run.range && run.playing) {
        const { min, max, looped } = run.range;
        if (run.time < min) run.time = min;
        run.time = looped && max > min ? ((run.time - min) % (max - min)) + min : Math.min(run.time, max);
      }
      const time = run.time;
      const values = new Map<number, Value>();
      for (const b of set.bindings) {
        const [attr0] = b.destinationAttribute.split(".");
        const xf = attr0 === "translation" || attr0 === "rotation" || attr0 === "scaling" ? this.xforms.get(b.destination) : undefined;
        const target = this.targets.get(b.destination);
        // a curve's own number: a scalar's timeOffset, a TriPerlinCurve's speed, scale, offset and the like (its value is
        // its output: set, then read over)
        // (and an expression's inputs: input1 .. input4, which its terms read)
        const curve = this.curvesById.get(b.destination) && (attr0 === "timeOffset" || b.destinationType === "TriPerlinCurve" || b.destinationType === "Tr2CurveColorMixer"
          || (/Expression$/.test(b.destinationType ?? "") && /^input[1-4]$/.test(attr0 ?? ""))) ? this.curvesById.get(b.destination) : undefined;
        const binding = attr0 === "scale" && b.destinationType === "TriValueBinding" ? this.bindingsById.get(b.destination) : undefined;
        // a controller's float variable (this clone's controller runs put a setter under its id)
        const sinks = !target && !xf && !curve && !binding && b.destinationType === "Tr2ControllerFloatVariable"
          ? (objects.get(b.destination) ?? []).filter((o) => typeof o.userData.setVariable === "function") : [];
        // another curve set's speed (TriCurveSet.scale: a set that waits at scale nought until one of its own sets it)
        const setScale = !target && !xf && !curve && !binding && b.destinationType === "TriCurveSet" && attr0 === "scale";
        // an effect propagator's trigger (a bool: each update the value is not nought it is set, and the propagator
        // reads its locators and plays again - this clone's run, put on its holder)
        // a child's light (Tr2PointLight / Tr2SpotLight / Tr2FactionLight: this clone's record, dynamicLights.ts): its
        // brightness, colour (r, g, b, a) or radius (x the scale it is drawn at), as Tr2Light's attributes take them
        const lightRecords = /^Tr2(Point|Spot|Faction)Light$/.test(b.destinationType ?? "") && /^(brightness|color|radius)$/.test(attr0 ?? "")
          ? (objects.get(b.destination) ?? []).map((o) => o.userData.lightRecord as { brightness: number; color: number[]; radius: number; scale?: number } | undefined).filter((x) => !!x) : [];
        // (its holder is also a display target: the trigger is looked at first)
        const triggers = b.destinationType === "EveChildEffectPropagator" && attr0 === "trigger"
          ? (objects.get(b.destination) ?? []).filter((o) => typeof o.userData.onTrigger === "function") : [];
        if (!triggers.length && !lightRecords.length && !target && !xf && !curve && !binding && !sinks.length && !setScale) continue;
        let src: Value;
        const srcCurve = b.source !== null ? set.curves[b.source] : b.sourceCurve;
        if (b.sourceConst) src = b.sourceConst;
        else if (b.sourceFx !== undefined) {
          const fx = objects.get(b.sourceFx)?.[0]?.userData.fx as Record<string, Value> | undefined;
          const v = fx?.[b.sourceAttribute.split(".")[0] ?? ""];
          if (v === undefined) continue;
          src = v;
        } else if (!srcCurve) continue;
        else if (srcCurve.type === "Tr2CurveColorMixer") src = mixerValue(srcCurve as unknown as Record<string, unknown>, b.sourceAttribute === "convertedLinearValue");
        else if (b.source !== null) {
          if (!values.has(b.source)) values.set(b.source, valueOf(srcCurve, time));
          src = values.get(b.source)!;
        } else src = valueOf(srcCurve, time);
        const [srcAttr, srcComp] = b.sourceAttribute.split(".");
        void srcAttr;
        const [attr, comp] = b.destinationAttribute.split(".");
        const srcC = srcComp !== undefined ? COMPONENT[srcComp] ?? null : null;
        if (sinks.length) { const v = copied(src, srcC, b.scale, b.offset, 0, null) as number; for (const o of sinks) (o.userData.setVariable as (v: number) => void)(v); continue; }
        if (setScale) { this.setScale(b.destination, copied(src, srcC, b.scale, b.offset, 0, null) as number); continue; }
        if (triggers.length) { if ((copied(src, srcC, b.scale, b.offset, 0, null) as number) !== 0) for (const o of triggers) (o.userData.onTrigger as () => void)(); continue; }
        if (lightRecords.length) {
          for (const r of lightRecords) {
            if (attr === "brightness") r.brightness = copied(src, srcC, b.scale, b.offset, 0, null) as number;
            else if (attr === "radius") r.radius = (copied(src, srcC, b.scale, b.offset, 0, null) as number) * (r.scale ?? 1);
            else if (attr === "color") {
              const c = comp !== undefined ? COMPONENT[comp] ?? null : null;
              r.color = copied(src, srcC, b.scale, b.offset, r.color.slice(), c) as number[];
            }
          }
          continue;
        }
        if (curve) {
          // (a colour mixer's color1 / color2: four components, one where the attribute names it)
          const now = curve[attr ?? ""] ?? (b.destinationType === "Tr2CurveColorMixer" && /^color[12]$/.test(attr ?? "") ? [0, 0, 0, 1] : undefined);
          curve[attr ?? "timeOffset"] = Array.isArray(now)
            ? copied(src, srcC, b.scale, b.offset, (now as number[]).slice(), comp !== undefined ? COMPONENT[comp] ?? null : null)
            : copied(src, srcC, b.scale, b.offset, typeof now === "number" ? now : 0, null);
          continue;
        }
        if (binding) { binding.scale = copied(src, srcC, b.scale, b.offset, binding.scale, null) as number; continue; }
        if (xf) {
          const key = attr === "translation" ? "t" : attr === "rotation" ? "r" : "s";
          xf[key] = copied(src, srcComp !== undefined ? COMPONENT[srcComp] ?? null : null, b.scale, b.offset, xf[key], comp !== undefined ? COMPONENT[comp] ?? null : null) as number[];
          xf.dirty++;
          continue;
        }
        if (!target) continue;
        this.apply(target, attr ?? "", src, srcComp !== undefined ? COMPONENT[srcComp] ?? null : null, comp !== undefined ? COMPONENT[comp] ?? null : null, b.scale, b.offset);
      }
    }
    if (seen.visibility !== this.visibility) { seen.visibility = this.visibility; this.applyVisibility(objects); }
    // the driven SRT modifiers, onto their owners in this clone (the modifier pass reads userData.srt each frame)
    seen.srts ??= new Map();
    for (const [id, t] of this.targets) {
      if (t.kind !== "srt" || seen.srts.get(id) === t.dirty) continue;
      seen.srts.set(id, t.dirty);
      for (const o of objects.get(t.owner) ?? []) if (o.userData.srt) o.userData.srt = { id, translation: t.translation, rotation: t.rotation, scaling: t.scaling };
    }
    // the driven transforms, recomposed under their parents' (a modified object's base, which its modifier turns)
    seen.xforms ??= new Map();
    for (const [id, xf] of this.xforms) {
      if (seen.xforms.get(id) === xf.dirty) continue;
      seen.xforms.set(id, xf.dirty);
      const own = new THREE.Matrix4().compose(new THREE.Vector3(...(xf.t as [number, number, number])), new THREE.Quaternion(...(xf.r as [number, number, number, number])), new THREE.Vector3(...(xf.s as [number, number, number])));
      for (const o of objects.get(id) ?? []) {
        const at = new THREE.Matrix4().fromArray(o.userData.parentMatrix as number[]).multiply(own);
        if (o.userData.modifierBase) o.userData.modifierBase = at.toArray();
        o.matrix.copy(at);
        o.matrixWorldNeedsUpdate = true;
        o.updateMatrixWorld(true);
      }
    }
  }

  private apply(target: Target, attr: string, src: Value, srcComp: number | null, comp: number | null, scale: number, offset: number[]): void {
    switch (target.kind) {
      case "quad":
        if (attr === "brightness") target.brightness = copied(src, srcComp, scale, offset, target.brightness, null) as number;
        else if (attr === "color") target.color = copied(src, srcComp, scale, offset, target.color, comp) as number[];
        else if (attr === "display") { const d = onOf(src, srcComp); if (d !== target.display) { target.display = d; this.visibility++; } return; }
        else return;
        this.writeQuad(target);
        return;
      case "value": {
        const now = target.get(attr);
        if (now !== undefined) target.set(attr, copied(src, srcComp, scale, offset, now, comp));
        return;
      }
      case "uniform": {
        const u = target.uniform.value as THREE.Vector4 | number;
        if (typeof u === "number") target.uniform.value = copied(src, srcComp, scale, offset, u, null);
        else if (attr === "value") u.fromArray(copied(src, srcComp, scale, offset, u.toArray(), comp) as number[]);
        return;
      }
      case "lines":
        // both colours reach the line set times the brightness, all four components (EveChildLineSet.cpp)
        if (attr === "baseColor") { target.base = copied(src, srcComp, scale, offset, target.base, comp) as number[]; (target.colour.value as THREE.Vector4).fromArray(target.base.map((c) => c * target.brightness)); }
        else if (attr === "animColor") { target.anim0 = copied(src, srcComp, scale, offset, target.anim0, comp) as number[]; (target.anim.value as THREE.Vector4).fromArray(target.anim0.map((c) => c * target.brightness)); }
        else if (attr === "display") { const d = onOf(src, srcComp); if (d !== target.display) { target.display = d; this.visibility++; } }
        return;
      case "srt":
        if (attr === "rotation" || attr === "translation" || attr === "scaling") { target[attr] = copied(src, srcComp, scale, offset, target[attr], comp) as number[]; target.dirty++; }
        return;
      case "object": case "container":
        if (attr === "display") { const d = onOf(src, srcComp); if (d !== target.display) { target.display = d; this.visibility++; } }
        return;
    }
  }

  private shown(t: { display: boolean; ancestors: number[] }): boolean {
    if (!t.display) return false;
    // a hidden container hides what it holds, a hidden mesh its areas
    for (const a of t.ancestors) { const c = this.targets.get(a); if (c && (c.kind === "container" || c.kind === "object") && !c.display) return false; }
    return true;
  }

  private writeQuad(q: QuadTarget): void {
    const a = q.attr ?? this.quadColour;
    if (!a) return;
    const k = this.shown(q) ? q.brightness : 0;
    a.setXYZW(q.index, (q.color[0] ?? 1) * k, (q.color[1] ?? 1) * k, (q.color[2] ?? 1) * k, (q.color[3] ?? 1) * k);
    a.needsUpdate = true;
  }

  private applyVisibility(objects: Map<number, THREE.Object3D[]>): void {
    for (const [id, t] of this.targets) {
      if (t.kind === "quad") this.writeQuad(t);
      else if (t.kind === "object" || t.kind === "lines") for (const o of objects.get(id) ?? []) o.visible = this.shown(t);
    }
  }

}

/** The animators by key (a model's clones carry the key in their userData, which a clone copies). */
export const animators = new Map<string, ChildAnimator>();
