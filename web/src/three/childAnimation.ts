// The hull children's curve sets played (trinity's TriCurveSet and TriValueBinding: carbonengine/trinity
// Curves/TriCurveSet.cpp, TriValueBinding.cpp): a set that plays on load runs from nought, its time the time since
// load x its scale, unbounded (each curve's extrapolation does the rest); each frame its curves are evaluated and its
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
  name: string | null;
  scale: number;
  curves: Curve[];
  bindings: {
    id?: number;
    source: number | null;
    sourceCurve: Curve | null;
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

/** A curve's value as a binding reads its currentValue. */
function valueOf(curve: Curve, time: number): Value {
  switch (curve.type) {
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

interface QuadTarget { kind: "quad"; index: number; color: number[]; brightness: number; display: boolean; ancestors: number[] }
interface UniformTarget { kind: "uniform"; uniform: THREE.IUniform }
interface LinesTarget { kind: "lines"; colour: THREE.IUniform; anim: THREE.IUniform; base: number[]; anim0: number[]; brightness: number; display: boolean; ancestors: number[] }
interface ObjectTarget { kind: "object"; display: boolean; ancestors: number[] }
interface ContainerTarget { kind: "container"; display: boolean }
/** An EveChildModifierSRT: its own transform, laid on its owner (a mesh or container: owner its id) each frame. */
interface SrtTarget { kind: "srt"; owner: number; translation: number[]; rotation: number[]; scaling: number[]; dirty: number }
type Target = QuadTarget | UniformTarget | LinesTarget | ObjectTarget | ContainerTarget | SrtTarget;
interface Xform { t: number[]; r: number[]; s: number[]; dirty: number }

/** One hull's curve sets and what their bindings reach; shared by the model's clones (found by their key). */
export class ChildAnimator {
  readonly key = THREE.MathUtils.generateUUID();
  private readonly targets = new Map<number, Target>();
  private readonly sets: SofCurveSet[] = [];
  private readonly xforms = new Map<number, Xform>();
  /** The curves and bindings by id, for the bindings that drive a curve's timeOffset or a binding's scale. */
  private readonly curvesById = new Map<number, { timeOffset?: number }>();
  private readonly bindingsById = new Map<number, SofCurveSet["bindings"][number]>();
  private quadColour: THREE.InstancedBufferAttribute | null = null;
  private readonly start = performance.now();
  private visibility = 1;

  quad(id: number, index: number, color: number[], brightness: number, ancestors: number[], display = true): void {
    this.targets.set(id, { kind: "quad", index, color: color.slice(0, 4), brightness, display, ancestors });
  }
  quadAttribute(a: THREE.InstancedBufferAttribute): void { this.quadColour = a; }
  uniform(id: number, uniform: THREE.IUniform | undefined): void { if (uniform) this.targets.set(id, { kind: "uniform", uniform }); }
  lines(id: number, colour: THREE.IUniform, anim: THREE.IUniform, base: number[], animColor: number[], brightness: number, ancestors: number[], display = true): void {
    this.targets.set(id, { kind: "lines", colour, anim, base: base.slice(0, 4), anim0: animColor.slice(0, 4), brightness, display, ancestors });
  }
  object(id: number, ancestors: number[], display = true): void { this.targets.set(id, { kind: "object", display, ancestors }); }
  /** A container or mesh whose translation, rotation or scaling a binding drives (its own, in its parent's space). */
  xform(id: number, t: number[], r: number[], s: number[]): void { this.xforms.set(id, { t: t.slice(0, 3), r: r.slice(0, 4), s: s.slice(0, 3), dirty: 1 }); }
  /** An SRT modifier a binding may drive: its owner's objects carry its transform in userData.srt. */
  srt(id: number, owner: number, srt: { translation: number[]; rotation: number[]; scaling: number[] }): void {
    this.targets.set(id, { kind: "srt", owner, translation: srt.translation.slice(0, 3), rotation: srt.rotation.slice(0, 4), scaling: srt.scaling.slice(0, 3), dirty: 0 });
  }
  /** A container (hidden where its file has it so: a set shows it). */
  container(id: number, display = true): void { if (!this.targets.has(id)) this.targets.set(id, { kind: "container", display }); }
  curveSets(sets: SofCurveSet[] | undefined): void {
    const index = (c: unknown): void => {
      if (!c || typeof c !== "object") return;
      if (Array.isArray(c)) { c.forEach(index); return; }
      const o = c as Record<string, unknown>;
      if (typeof o.id === "number" && typeof o.type === "string") this.curvesById.set(o.id, o as { timeOffset?: number });
      for (const [k, v] of Object.entries(o)) if (k !== "keys" && v && typeof v === "object") index(v);
    };
    for (const s of sets ?? []) {
      if (!s.bindings.length) continue;
      this.sets.push(s);
      index(s.curves);
      for (const b of s.bindings) { if (b.id !== undefined) this.bindingsById.set(b.id, b); if (b.sourceCurve) index(b.sourceCurve); }
    }
  }
  get playing(): boolean { return this.sets.length > 0; }

  /** One frame: every set's curves at its time, every binding copied; visibility to the given objects (a clone's). */
  step(objects: Map<number, THREE.Object3D[]>, seen: { visibility: number; xforms?: Map<number, number>; srts?: Map<number, number> }): void {
    const t = (performance.now() - this.start) / 1000;
    for (const set of this.sets) {
      const time = t * set.scale;
      const values = new Map<number, Value>();
      for (const b of set.bindings) {
        const [attr0] = b.destinationAttribute.split(".");
        const xf = attr0 === "translation" || attr0 === "rotation" || attr0 === "scaling" ? this.xforms.get(b.destination) : undefined;
        const target = this.targets.get(b.destination);
        const curve = attr0 === "timeOffset" ? this.curvesById.get(b.destination) : undefined;
        const binding = attr0 === "scale" && b.destinationType === "TriValueBinding" ? this.bindingsById.get(b.destination) : undefined;
        if (!target && !xf && !curve && !binding) continue;
        let src: Value;
        if (b.source !== null) {
          if (!values.has(b.source)) values.set(b.source, valueOf(set.curves[b.source]!, time));
          src = values.get(b.source)!;
        } else if (b.sourceCurve) src = valueOf(b.sourceCurve, time);
        else continue;
        const [srcAttr, srcComp] = b.sourceAttribute.split(".");
        void srcAttr;
        const [attr, comp] = b.destinationAttribute.split(".");
        const srcC = srcComp !== undefined ? COMPONENT[srcComp] ?? null : null;
        if (curve) { curve.timeOffset = copied(src, srcC, b.scale, b.offset, curve.timeOffset ?? 0, null) as number; continue; }
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
    const a = this.quadColour;
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
