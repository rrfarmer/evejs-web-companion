// A child container's controllers (Tr2Controller, Trinity source: Controllers/), run as the client runs them:
// - Tr2Controller::Start starts each state machine at its start state; Tr2StateMachine::FollowTransitions then takes
//   the first of the current state's transitions whose condition holds (and that names a destination), stops the state,
//   starts the next and looks again, every variable counted dirty, until none holds (at most a few dozen hops);
// - each update looks again. A transition whose condition calls only pure functions and reads a variable is looked
//   at only when one of its variables changed (its variable mask; Tr2ControllerExpression::CreateParser): here, no
//   one sets a variable, so only on the state's start. One that calls StateTime() (not pure), or reads no variable
//   (a mask of nought), is looked at every update;
// - StateTime() is the seconds since the state started.
// Actions: Tr2ActionChildEffect (load an object file as a child of the owner on the state's start, remove it on its
// stop: addOnStart and removeOnStop, both true unless said; a child of that name already there is taken, not loaded);
// Tr2ActionPlayCurveSet (play the owner's curve sets of that name - in a range where it names one - on start, stop
// them on stop; synced to its range, the state may leave only on the frame the range comes round). CurveSetTime()
// is the owner's sets' length (or the range's). Tr2ActionSetValue: its value expression into one of the controller's
// variables (marking them changed: the transitions that read variables are looked at again on the next update) or
// into an object's display (a path from Owner through objects["name"], resolved to the object when read). Random(min,
// max) is min + rand() % int(max - min). Tr2ActionAnimateCurveSet applies its set at its value expression's value
// each update (StateTime() there its own time; the files' are ShipSpeed()/ShipMaxSpeed() and ActivationStrength).
// ShipSpeed() and ShipMaxSpeed() read the ship's model (setShipSpeed); Tr2ControllerExpression.cpp's other functions
// (the server's time from the browser's UTC clock, IsWeekend, BoundingSphereRadius, ...) and CcpParser's standard
// functions and constants are here too. A condition that calls a function not here never holds.

import * as THREE from "three";
import { curveValue, type Curve } from "./curves.ts";

export interface SofControllerAction {
  k: string;
  /** setVar: the variable; setDisplay: the target's id; both, and animateCurveSet: the value expression. */
  variable?: string;
  /** animateCurveSet: the set's id. */
  curveSet?: number;
  target?: number;
  value?: string;
  set?: string;
  range?: string;
  sync?: boolean;
  effect?: string | null;
  name?: string | null;
  add?: boolean;
  remove?: boolean;
  other?: string | null;
  /** setExternal: its value where it has no source variable (this controller's variable read on start). */
  number?: number;
  source?: string | null;
  /** setValue / setOwner / animateOwner: the attribute; animateOwner: its curve (Curve(x) in its value). */
  attribute?: string;
  curve?: Curve | null;
  /** resetClipCenter: the behaviour (0 object centre, 1 last damage locator, 2 the locator set `set`) and index. */
  behavior?: number;
  index?: number;
  /** spawnParticles: the emitter's id and the count (x the emitter's rate). */
  emitter?: number;
  rate?: number;
}
export interface SofControllerState {
  name: string | null;
  actions: SofControllerAction[];
  transitions: { condition: string; to: number }[];
}
export interface SofController {
  name: string | null;
  variables: { name: string; value: number; id?: number }[];
  machines: { name: string | null; start: number; states: SofControllerState[] }[];
  /** Tr2ControllerEventHandler: on the event of its name, its actions started, then stopped. */
  eventHandlers?: { name: string; actions: SofControllerAction[] }[];
}

/** The owning space object's numbers a few functions read (BoundingSphereRadius, ShipBoosterIntensity, GetExternalControllerVariable). */
type ObjectInfo = { radius(): number; booster(): number; external(name: string): number | undefined };
type Scope = { vars: Map<string, number>; stateTime: number; curveSetTime: (name: string) => number; ship?: () => { speed: number; max: number }; curve?: (x: number) => number; object?: ObjectInfo };

/**
 * The server's time (Tr2ControllerExpression.cpp GetServerTimeParts: Be::Time, the frame's wall clock - EVE time, UTC -
 * through FileTimeToSystemTime) as the browser's clock has it.
 */
function serverParts(): { year: number; month: number; day: number; dow: number; hour: number; minute: number; second: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}
/** ServerTimeGreaterThan / LessThanOrEqual / Equal (ServerTimeComparisonHelper): year to second, -1 skipped. */
function serverTimeCompare(args: number[], over: (s: number, u: number) => boolean, dis: (s: number, u: number) => boolean): number {
  const p = serverParts();
  const parts = [p.year, p.month, p.day, p.hour, p.minute, p.second];
  for (let i = 0; i < 6; i++) {
    const u = args[i] ?? -1;
    if (u === -1) continue;
    if (over(parts[i]!, u)) return 1;
    if (dis(parts[i]!, u)) return 0;
  }
  return 1;
}
/** ServerTimePhase(period): the server time (Be::Time, 100 ns since 1601) modulo the period, in seconds. */
function serverTimePhase(period: number): number {
  let p = BigInt(Math.trunc(period * 1e7));
  if (p === 0n) return 0;
  if (p < 0n) p = -p;
  const now = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  return Number(now % p) / 1e7;
}
/** DaysSinceServerTime(year, month, day): days from that date (-1 parts the server's) to the server's date. */
function daysSince(year: number, month: number, day: number): number {
  const p = serverParts();
  const at = Date.UTC(year === -1 ? p.year : year, (month === -1 ? p.month : month) - 1, day === -1 ? p.day : day);
  return (Date.UTC(p.year, p.month - 1, p.day) - at) / 86400000;
}
/** CcpParser's standard functions (carbonengine/parser stdfunctions.cpp), all pure. */
const STD: Record<string, (a: number[]) => number> = {
  sin: (a) => Math.sin(a[0]!), cos: (a) => Math.cos(a[0]!), tan: (a) => Math.tan(a[0]!), asin: (a) => Math.asin(a[0]!), acos: (a) => Math.acos(a[0]!),
  atan: (a) => Math.atan(a[0]!), sinh: (a) => Math.sinh(a[0]!), cosh: (a) => Math.cosh(a[0]!), tanh: (a) => Math.tanh(a[0]!), asinh: (a) => Math.asinh(a[0]!),
  acosh: (a) => Math.acosh(a[0]!), atanh: (a) => Math.atanh(a[0]!), log2: (a) => Math.log2(a[0]!), log10: (a) => Math.log10(a[0]!), log: (a) => Math.log(a[0]!),
  ln: (a) => Math.log(a[0]!), exp: (a) => Math.exp(a[0]!), sqrt: (a) => Math.sqrt(a[0]!), sign: (a) => (a[0]! > 0 ? 1 : a[0]! < 0 ? -1 : 0),
  // rintf: to the nearest, halves to even
  rint: (a) => { const x = a[0]!, r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; },
  abs: (a) => Math.abs(a[0]!), min: (a) => Math.min(...a), max: (a) => Math.max(...a), sum: (a) => a.reduce((x, y) => x + y, 0),
  avg: (a) => a.reduce((x, y) => x + y, 0) / a.length,
};
/** masked: pure and reading a variable (looked at only when a variable changed). */
type Compiled = { run: (s: Scope) => number; masked: boolean } | null;

/**
 * A condition compiled (CcpParser's grammar as the files use it: numbers, variables, function calls, unary - + !,
 * * / %, + -, comparisons, == !=, && ||, c ? a : b, parentheses); null where it has anything else.
 */
export function compileCondition(src: string): Compiled {
  const tokens = src.match(/\s*(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_]\w*|"[^"]*"|&&|\|\||[<>!=]=|[-+*/%()<>!,?:])/g)?.map((t) => t.trim()) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== src.replace(/\s/g, "")) return null;
  let i = 0;
  let pure = true;
  let readsVar = false;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  type F = (s: Scope) => number;
  const primary = (): F | null => {
    const t = next();
    if (t === undefined) return null;
    if (t === "(") { const e = ternary(); if (!e || next() !== ")") return null; return e; }
    if (t === "-") { const e = primary(); return e ? (s) => -e(s) : null; }
    if (t === "+") return primary();
    if (t === "!") { const e = primary(); return e ? (s) => (e(s) === 0 ? 1 : 0) : null; }
    if (/^(\d|\.)/.test(t)) { const v = Number(t); return () => v; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        next();
        // the arguments: strings or expressions, comma-separated
        const args: (F | string)[] = [];
        if (peek() !== ")") {
          for (;;) {
            const a = peek();
            if (a?.startsWith('"')) { next(); args.push(a.slice(1, -1)); }
            else { const e = ternary(); if (!e) return null; args.push(e); }
            if (peek() === ",") { next(); continue; }
            break;
          }
        }
        if (next() !== ")") return null;
        // StateTime(), CurveSetTime("set" or "set/range"), Random(min, max): none of them pure
        if (t === "StateTime" && !args.length) { pure = false; return (s) => s.stateTime; }
        if (t === "CurveSetTime" && args.length === 1 && typeof args[0] === "string") {
          const name = args[0];
          pure = false;
          return (s) => s.curveSetTime(name);
        }
        // ShipSpeed(): the owning ship's speed (m/s; nought for a station); ShipMaxSpeed(): its top speed (1 where
        // it has none)
        if (t === "ShipSpeed" && !args.length) { pure = false; return (s) => s.ship?.().speed ?? 0; }
        if (t === "ShipMaxSpeed" && !args.length) { pure = false; return (s) => { const m = s.ship?.().max ?? 0; return m > 0 ? m : 1; }; }
        // IsAnimationPlaying("layer") and AnimationTime("name"): the owner's geometry animations - none play here, so
        // nought (a hull controller's transitions wait on them)
        if ((t === "IsAnimationPlaying" || t === "AnimationTime") && args.length === 1 && typeof args[0] === "string") { pure = false; return () => 0; }
        // Curve(x): an AnimateValue's curve at x (Tr2ActionAnimateValue's extra function; nought without one)
        if (t === "Curve" && args.length === 1 && typeof args[0] === "function") {
          const x = args[0];
          pure = false;
          return (s) => (s.curve ? s.curve(x(s)) : 0);
        }
        const nums = args.filter((x): x is F => typeof x === "function");
        if (nums.length === args.length) {
          // the standard functions (min / max / sum / avg take 1 to 7 numbers; the others one)
          const std = STD[t];
          if (std && (/^(min|max|sum|avg)$/.test(t) ? nums.length >= 1 && nums.length <= 7 : nums.length === 1)) return (s) => std(nums.map((f) => f(s)));
          // the server's time (the frame's wall clock): none pure
          const time: Record<string, (a: number[]) => number> = {
            ServerYear: () => serverParts().year, ServerMonth: () => serverParts().month, ServerDay: () => serverParts().day,
            ServerDayOfWeek: () => serverParts().dow, ServerHour: () => serverParts().hour, ServerMinute: () => serverParts().minute,
            ServerSecond: () => serverParts().second, IsWeekend: () => (serverParts().dow % 6 === 0 ? 1 : 0),
            ServerTimePhase: (a) => serverTimePhase(a[0]!),
            ServerTimeGreaterThan: (a) => serverTimeCompare(a, (x, y) => x > y, (x, y) => x < y),
            ServerTimeLessThanOrEqual: (a) => serverTimeCompare(a, (x, y) => x < y, (x, y) => x > y),
            ServerTimeEqual: (a) => serverTimeCompare(a, () => false, (x, y) => x !== y),
            DaysSinceServerTime: (a) => daysSince(a[0]!, a[1]!, a[2]!),
          };
          const arity: Record<string, number> = { ServerTimePhase: 1, ServerTimeGreaterThan: 6, ServerTimeLessThanOrEqual: 6, ServerTimeEqual: 6, DaysSinceServerTime: 3 };
          const fn = time[t];
          if (fn && nums.length === (arity[t] ?? 0)) { pure = false; return (s) => fn(nums.map((f) => f(s))); }
          // the owning object's: BoundingSphereRadius (its radius), ShipBoosterIntensity (its booster gain, >= 0),
          // KillCount (not kept here: nought), ShaderQuality (TR2SM_3_0_DEPTH, the highest: 2)
          if (t === "BoundingSphereRadius" && !nums.length) { pure = false; return (s) => s.object?.radius() ?? 0; }
          if (t === "ShipBoosterIntensity" && !nums.length) { pure = false; return (s) => Math.max(0, s.object?.booster() ?? 0); }
          if (t === "KillCount" && !nums.length) { pure = false; return () => 0; }
          if (t === "ShaderQuality" && !nums.length) { pure = false; return () => 2; }
        }
        // GetExternalControllerVariable("name", default): the owner's controller value of that name, else the default
        if (t === "GetExternalControllerVariable" && args.length === 2 && typeof args[0] === "string" && typeof args[1] === "function") {
          const name = args[0], d = args[1];
          pure = false;
          return (s) => s.object?.external(name) ?? d(s);
        }
        if (t === "Random" && args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function") {
          // min + rand() % int(max - min)
          const lo = args[0], hi = args[1];
          pure = false;
          return (s) => { const a = lo(s), n = Math.trunc(hi(s) - a); return n > 0 ? a + Math.floor(Math.random() * n) : a; };
        }
        return null;
      }
      // CcpParser's standard constants
      if (t === "_pi") return () => Math.fround(Math.PI);
      if (t === "_e") return () => Math.fround(Math.E);
      readsVar = true;
      return (s) => s.vars.get(t) ?? 0;
    }
    return null;
  };
  const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
  const expr = (min: number): F | null => {
    let left: F | null = primary();
    if (!left) return null;
    for (;;) {
      const op = peek();
      const p = op !== undefined ? PREC[op] : undefined;
      if (p === undefined || p < min) return left;
      next();
      const right = expr(p + 1);
      if (!right) return null;
      const l: F = left;
      const r: F = right;
      switch (op) {
        case "||": left = (s) => (l(s) !== 0 || r(s) !== 0 ? 1 : 0); break;
        case "&&": left = (s) => (l(s) !== 0 && r(s) !== 0 ? 1 : 0); break;
        case "==": left = (s) => (l(s) === r(s) ? 1 : 0); break;
        case "!=": left = (s) => (l(s) !== r(s) ? 1 : 0); break;
        case "<": left = (s) => (l(s) < r(s) ? 1 : 0); break;
        case ">": left = (s) => (l(s) > r(s) ? 1 : 0); break;
        case "<=": left = (s) => (l(s) <= r(s) ? 1 : 0); break;
        case ">=": left = (s) => (l(s) >= r(s) ? 1 : 0); break;
        case "+": left = (s) => l(s) + r(s); break;
        case "-": left = (s) => l(s) - r(s); break;
        case "*": left = (s) => l(s) * r(s); break;
        case "/": left = (s) => l(s) / r(s); break;
        case "%": left = (s) => l(s) % r(s); break;
      }
    }
  };
  // c ? a : b, below every binary operator, to the right (CcpParser's, as C's)
  const ternary = (): F | null => {
    const c = expr(0);
    if (!c || peek() !== "?") return c;
    next();
    const a = ternary();
    if (!a || next() !== ":") return null;
    const b = ternary();
    if (!b) return null;
    return (s) => (c(s) !== 0 ? a(s) : b(s));
  };
  const run = ternary();
  if (!run || i !== tokens.length) return null;
  return { run, masked: pure && readsVar };
}

const compiled = new Map<string, Compiled>();
const conditionOf = (src: string): Compiled => {
  if (!compiled.has(src)) compiled.set(src, compileCondition(src));
  return compiled.get(src)!;
};

/** What a running controller reaches: child effects (built by the caller) and its owner's curve sets. */
export interface ChildEffectHost {
  /** The object a child effect's file builds, or null (a new copy each call). */
  build(effect: string): Promise<THREE.Object3D | null>;
  /** The curve sets of that name under the owner (by its id): played (with a range or without), stopped, measured. */
  play?(owner: number, name: string, range: string): void;
  /** A curve set (by id) applied at a time (TriCurveSet::ApplyTime). */
  applyTime?(set: number, time: number): void;
  /** A curve set's speed (TriCurveSet.scale). */
  setScale?(set: number, scale: number): void;
  /** A particle emitter (by id) spawning rate x its own rate at once (Tr2ActionSpawnParticles). */
  spawn?(emitter: number, rate: number): void;
  /** Tr2ActionSetValue into a curve's input or an effect parameter (by id; "value" or "value.w" and the like). */
  setValue?(target: number, attribute: string, value: number): void;
  /** An object's display (a container, mesh, quad or line set, by id). */
  setDisplay?(target: number, on: boolean): void;
  /**
   * The object a Tr2ActionChildEffect's targetAnotherOwner names (an EveMultiEffect's parameter: "ship", "Hangar"), its
   * child effect added there; null where none is bound.
   */
  otherOwner?(name: string): THREE.Object3D | null;
  /** One of the space object's own attributes (activationStrength, display, clipSphereFactor/2). */
  setOwner?(attribute: string, value: number): void;
  /** Tr2ActionOverlay: the space object's mesh overlay (by its file) added or taken off. */
  overlay?(effect: string, on: boolean): void;
  /** Tr2ActionResetClipSphereCenter: the space object's clip sphere centre moved. */
  resetClipCenter?(behavior: number, set: string, index: number): void;
  /** An effect propagator's trigger set (by id): its copies placed. */
  trigger?(target: number): void;
  stop?(owner: number, name: string): void;
  duration?(owner: number, name: string, range: string): number;
}

type Live = { stop(): void; canTransition?(now: number): boolean; tick?(now: number): void };

/** One clone's run of one controller, its owner the container's group in that clone. */
export class ControllerRun {
  private readonly vars = new Map<string, number>();
  /** A variable set since the last update: the transitions that read variables are looked at again. */
  private dirty = false;
  /** The version of the object's kept variables last taken (setControllerVariable). */
  private varsVersion = -1;
  /** The last of the object's controller events taken (sendControllerEvent); those before the run began are not. */
  private eventSeq: number | null = null;
  private readonly machines: { current: number; stateStart: number; live: Live[]; vetoed: boolean }[] = [];

  constructor(private readonly data: SofController, private readonly owner: THREE.Object3D, private readonly host: ChildEffectHost, private readonly ownerId: number | null = null) {
    for (const v of data.variables) this.vars.set(v.name, v.value);
    this.takeObjectVariables();
    this.dirty = false;
    const now = performance.now() / 1000;
    for (const m of data.machines) {
      const run = { current: -1, stateStart: now, live: [] as Live[], vetoed: false };
      this.machines.push(run);
      if (m.start < 0 || !m.states[m.start]) continue;
      run.current = m.start;
      this.enter(m.states[m.start]!, run, now);
      this.follow(this.machines.length - 1, now, true);
    }
  }

  update(): void {
    this.takeObjectVariables();
    this.takeObjectEvents();
    const now = performance.now() / 1000;
    const dirty = this.dirty;
    this.dirty = false;
    for (let i = 0; i < this.machines.length; i++) this.follow(i, now, dirty || this.machines[i]!.vetoed);
    // the actions' own updates after the machines' (Tr2Controller::Update: the updateables last)
    for (const run of this.machines) for (const a of run.live) a.tick?.(now);
  }

  stop(): void {
    for (const run of this.machines) { for (const a of run.live) a.stop(); run.live = []; run.current = -1; }
  }

  private follow(i: number, now: number, allDirty: boolean): void {
    const m = this.data.machines[i]!;
    const run = this.machines[i]!;
    for (let hop = 0; hop < 40 && run.current >= 0; hop++) {
      const state = m.states[run.current]!;
      const scope = { vars: this.vars, stateTime: now - run.stateStart, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship(), object: this.objectInfo };
      const t = state.transitions.find((tr) => {
        if (tr.to < 0 || !m.states[tr.to]) return false;
        const c = conditionOf(tr.condition);
        if (!c || (c.masked && !allDirty)) return false;
        return c.run(scope) !== 0;
      });
      if (!t) return;
      // an action may hold the state (Tr2ActionPlayCurveSet synced to its range: until the range comes round); a
      // vetoed state looks at every transition again on the next update
      if (run.live.some((a) => a.canTransition && !a.canTransition(now))) { run.vetoed = true; return; }
      run.vetoed = false;
      for (const a of run.live) a.stop();
      run.live = [];
      run.current = t.to;
      run.stateStart = now;
      this.enter(m.states[t.to]!, run, now);
      allDirty = true;
    }
  }

  /** The space object's controller events since the last update, each handled (Tr2Controller::HandleEvent). */
  private takeObjectEvents(): void {
    for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) {
      const events = o.userData.controllerEvents as { seq: number; name: string }[] | undefined;
      if (!events) continue;
      const seq = (o.userData.controllerEventSeq as number | undefined) ?? 0;
      if (this.eventSeq === null) { this.eventSeq = seq; return; }
      for (const e of events) if (e.seq > this.eventSeq) this.handleEvent(e.name);
      this.eventSeq = seq;
      return;
    }
    this.eventSeq ??= 0;
  }

  /** An event: each handler of its name has its actions started, then stopped (Tr2ControllerEventHandler::Execute). */
  handleEvent(name: string): void {
    const now = performance.now() / 1000;
    for (const h of this.data.eventHandlers ?? []) {
      if (h.name !== name) continue;
      const run = { live: [] as Live[] };
      this.enter({ name, actions: h.actions, transitions: [] }, run, now);
      for (const a of run.live) a.stop();
    }
  }

  /** A variable set from outside (a curve set's binding into a Tr2ControllerFloatVariable): changed, it is dirty. */
  setVariable(name: string, value: number): void {
    if (this.vars.has(name) && this.vars.get(name) !== value) { this.vars.set(name, value); this.dirty = true; }
  }
  /** Its variables that have ids (a binding may set them). */
  get variableIds(): { id: number; name: string }[] { return this.data.variables.filter((v) => v.id !== undefined).map((v) => ({ id: v.id!, name: v.name })); }

  /** The space object's kept controller variables, where they changed: each one this controller has, set. */
  private takeObjectVariables(): void {
    for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) {
      const store = o.userData.controllerVars as Record<string, number> | undefined;
      if (!store) continue;
      const version = (o.userData.controllerVarsVersion as number | undefined) ?? 0;
      if (version === this.varsVersion) return;
      this.varsVersion = version;
      for (const [name, value] of Object.entries(store)) {
        if (this.vars.has(name) && this.vars.get(name) !== value) { this.vars.set(name, value); this.dirty = true; }
      }
      return;
    }
  }

  /** The owning ship's speed and top speed (setShipSpeed on its model; nought where none is set). */
  /** The owning space object's radius (its bounding sphere), booster gain and kept controller variables. */
  private readonly objectInfo: ObjectInfo = {
    radius: () => {
      for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) {
        const bs = o.userData.boundingSphere as number[] | null | undefined;
        if (bs?.[3] !== undefined) return bs[3];
      }
      return 0;
    },
    booster: () => {
      for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) if (typeof o.userData.thrust === "number") return o.userData.thrust as number;
      return 0;
    },
    external: (name) => {
      for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) {
        const store = o.userData.controllerVars as Record<string, number> | undefined;
        if (store && name in store) return store[name];
      }
      return undefined;
    },
  };

  private ship(): { speed: number; max: number } {
    for (let o: THREE.Object3D | null = this.owner; o; o = o.parent) {
      if (typeof o.userData.shipSpeed === "number") return { speed: o.userData.shipSpeed as number, max: (o.userData.shipMaxSpeed as number) ?? 0 };
    }
    return { speed: 0, max: 0 };
  }

  /** CurveSetTime("set") or ("set/range") of the owner's sets. */
  private curveSetTime(name: string): number {
    if (this.ownerId === null || !this.host.duration) return 0;
    const slash = name.indexOf("/");
    return slash >= 0 ? this.host.duration(this.ownerId, name.slice(0, slash), name.slice(slash + 1)) : this.host.duration(this.ownerId, name, "");
  }

  private enter(state: SofControllerState, run: { live: Live[] }, now: number): void {
    for (const a of state.actions) {
      // Tr2ActionSpawnParticles (Start): the emitter spawns rate x its own rate
      if (a.k === "spawnParticles" && a.emitter !== undefined) { this.host.spawn?.(a.emitter, a.rate ?? 1); continue; }
      // Tr2ActionSetExternalControllerVariable: onto the object its destinationOwner names (its controllers and its
      // children's take it: EveChildContainer::SetControllerVariable passes it down)
      if (a.k === "setExternal" && a.other && a.variable) {
        const dest = this.host.otherOwner?.(a.other);
        const v = a.source ? this.vars.get(a.source) : a.number;
        if (dest && v !== undefined) {
          // (hullModel setControllerVariable's store: the controllers under it take it, takeObjectVariables)
          const store = (dest.userData.controllerVars ??= {}) as Record<string, number>;
          if (store[a.variable] !== v) {
            store[a.variable] = v;
            dest.userData.controllerVarsVersion = ((dest.userData.controllerVarsVersion as number | undefined) ?? 0) + 1;
          }
        }
        continue;
      }
      if (a.k === "resetClipCenter") { this.host.resetClipCenter?.(a.behavior ?? 0, a.set ?? "", a.index ?? -1); continue; }
      // Tr2ActionOverlay: added on start (addOnStart), taken off on stop (removeOnStop)
      if (a.k === "overlay" && a.effect && this.host.overlay) {
        const overlay = this.host.overlay, effect = a.effect;
        if (a.add !== false) overlay(effect, true);
        run.live.push({ stop: () => { if (a.remove !== false) overlay(effect, false); } });
        continue;
      }
      // Tr2ActionSetValue: its value expression (no state machine: StateTime() nought) into a variable or a display
      if ((a.k === "setVar" || a.k === "setDisplay" || a.k === "setSetTime" || a.k === "setSetScale" || a.k === "trigger" || a.k === "setValue" || a.k === "setOwner") && a.value !== undefined) {
        const c = conditionOf(a.value);
        if (!c) continue;
        const v = c.run({ vars: this.vars, stateTime: 0, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship(), object: this.objectInfo });
        if (a.k === "setVar" && a.variable && this.vars.has(a.variable)) {
          if (this.vars.get(a.variable) !== v) { this.vars.set(a.variable, v); this.dirty = true; }
        } else if (a.k === "setDisplay" && a.target !== undefined) this.host.setDisplay?.(a.target, v !== 0);
        else if (a.k === "setSetTime" && a.curveSet !== undefined) this.host.applyTime?.(a.curveSet, v);
        else if (a.k === "setSetScale" && a.curveSet !== undefined) this.host.setScale?.(a.curveSet, v);
        // an effect propagator's trigger: set (non-nought) it places its copies; nought does nothing (m_trigger is
        // only read when set, then cleared by Play)
        else if (a.k === "trigger" && a.target !== undefined && v !== 0) this.host.trigger?.(a.target);
        else if (a.k === "setOwner" && a.attribute) this.host.setOwner?.(a.attribute, v);
        else if (a.k === "setValue" && a.target !== undefined) {
          // every candidate (one per child effect file the controller may load): only the loaded one has its target
          for (const t of (a as { targets?: number[] }).targets ?? [a.target]) this.host.setValue?.(t, (a as { attribute?: string }).attribute ?? "value", v);
        }
        continue;
      }
      // Tr2ActionAnimateCurveSet: each update (after the machines'), its set applied at its value expression's value,
      // StateTime() there the time since the action started
      if (a.k === "animateCurveSet" && a.curveSet !== undefined && this.host.applyTime) {
        const c = conditionOf(a.value || "StateTime()");
        if (!c) continue;
        const host = this.host, applyTime = this.host.applyTime, set = a.curveSet, start = now;
        run.live.push({
          stop: () => {},
          tick: (t) => applyTime(set, c.run({ vars: this.vars, stateTime: t - start, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship(), object: this.objectInfo })),
        });
        continue;
      }
      // Tr2ActionAnimateValue on the space object: each update (after the machines'), its value expression (StateTime()
      // the time since the action started, Curve(x) its curve at x) into the attribute
      if (a.k === "animateOwner" && a.attribute && this.host.setOwner) {
        const c = conditionOf(a.value || "Curve(StateTime())");
        if (!c) continue;
        const setOwner = this.host.setOwner, attribute = a.attribute, curve = a.curve ?? null, start = now;
        const at = (x: number) => curveValue(curve, x);
        run.live.push({
          stop: () => {},
          tick: (t) => setOwner(attribute, c.run({ vars: this.vars, stateTime: t - start, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship(), object: this.objectInfo, curve: at })),
        });
        continue;
      }
      if (a.k === "playCurveSet" && a.set && this.ownerId !== null && this.host.play) {
        const owner = this.ownerId, host = this.host, set = a.set, range = a.range ?? "";
        this.host.play(owner, set, range);
        // syncToRange (a named range of positive length): a transition waits for the range to come round
        const length = a.sync && range && host.duration ? host.duration(owner, set, range) : 0;
        const start = now;
        let prev = now;
        run.live.push({
          stop: () => host.stop?.(owner, set),
          canTransition: length > 0 ? (t) => t === start || Math.floor((prev - start) / length) !== Math.floor((t - start) / length) : undefined,
          tick: (t) => { prev = t; },
        });
        continue;
      }
      if (a.k !== "childEffect") continue;
      // (targetAnotherOwner: the parameter it names, where the host binds one)
      const owner = a.other ? this.host.otherOwner?.(a.other) ?? null : this.owner;
      if (!owner) continue;
      let child: THREE.Object3D | null = a.name ? owner.children.find((c) => c.name === a.name) ?? null : null;
      let stopped = false;
      if (!child && a.add !== false && a.effect) {
        void this.host.build(a.effect).then((o) => {
          if (!o || stopped) return;
          if (a.name) o.name = a.name;
          child = o;
          owner.add(o);
        });
      }
      run.live.push({ stop: () => { stopped = true; if (child && a.remove !== false) child.removeFromParent(); } });
    }
  }
}
