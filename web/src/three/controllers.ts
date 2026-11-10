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
// ShipSpeed() and ShipMaxSpeed() read the ship's model (setShipSpeed). The other actions, the ship functions and the controller's event handlers
// are not run yet: a condition that calls a function not here never holds.

import * as THREE from "three";

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
}
export interface SofControllerState {
  name: string | null;
  actions: SofControllerAction[];
  transitions: { condition: string; to: number }[];
}
export interface SofController {
  name: string | null;
  variables: { name: string; value: number }[];
  machines: { name: string | null; start: number; states: SofControllerState[] }[];
  /** Tr2ControllerEventHandler: on the event of its name, its actions started, then stopped. */
  eventHandlers?: { name: string; actions: SofControllerAction[] }[];
}

type Scope = { vars: Map<string, number>; stateTime: number; curveSetTime: (name: string) => number; ship?: () => { speed: number; max: number } };
/** masked: pure and reading a variable (looked at only when a variable changed). */
type Compiled = { run: (s: Scope) => number; masked: boolean } | null;

/**
 * A condition compiled (CcpParser's grammar as the files use it: numbers, variables, StateTime(), unary - and !,
 * * / %, + -, comparisons, == !=, && ||, parentheses); null where it has anything else.
 */
export function compileCondition(src: string): Compiled {
  const tokens = src.match(/\s*(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_]\w*|"[^"]*"|&&|\|\||[<>!=]=|[-+*/%()<>!,])/g)?.map((t) => t.trim()) ?? [];
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
    if (t === "(") { const e = expr(0); if (!e || next() !== ")") return null; return e; }
    if (t === "-") { const e = primary(); return e ? (s) => -e(s) : null; }
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
            else { const e = expr(0); if (!e) return null; args.push(e); }
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
        if (t === "Random" && args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function") {
          // min + rand() % int(max - min)
          const lo = args[0], hi = args[1];
          pure = false;
          return (s) => { const a = lo(s), n = Math.trunc(hi(s) - a); return n > 0 ? a + Math.floor(Math.random() * n) : a; };
        }
        return null;
      }
      readsVar = true;
      return (s) => s.vars.get(t) ?? 0;
    }
    return null;
  };
  const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
  const expr = (min: number): F | null => {
    let left = primary();
    if (!left) return null;
    for (;;) {
      const op = peek();
      const p = op !== undefined ? PREC[op] : undefined;
      if (p === undefined || p < min) return left;
      next();
      const right = expr(p + 1);
      if (!right) return null;
      const l = left;
      const r = right;
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
  const run = expr(0);
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
  /** An object's display (a container, mesh, quad or line set, by id). */
  setDisplay?(target: number, on: boolean): void;
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
      const scope = { vars: this.vars, stateTime: now - run.stateStart, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship() };
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
      // Tr2ActionSetValue: its value expression (no state machine: StateTime() nought) into a variable or a display
      if ((a.k === "setVar" || a.k === "setDisplay" || a.k === "setSetTime" || a.k === "setSetScale") && a.value !== undefined) {
        const c = conditionOf(a.value);
        if (!c) continue;
        const v = c.run({ vars: this.vars, stateTime: 0, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship() });
        if (a.k === "setVar" && a.variable && this.vars.has(a.variable)) {
          if (this.vars.get(a.variable) !== v) { this.vars.set(a.variable, v); this.dirty = true; }
        } else if (a.k === "setDisplay" && a.target !== undefined) this.host.setDisplay?.(a.target, v !== 0);
        else if (a.k === "setSetTime" && a.curveSet !== undefined) this.host.applyTime?.(a.curveSet, v);
        else if (a.k === "setSetScale" && a.curveSet !== undefined) this.host.setScale?.(a.curveSet, v);
        continue;
      }
      // Tr2ActionAnimateCurveSet: each update (after the machines'), its set applied at its value expression's value,
      // StateTime() there the time since the action started
      if (a.k === "animateCurveSet" && a.curveSet !== undefined && this.host.applyTime) {
        const c = conditionOf(a.value || "StateTime()");
        if (!c) continue;
        const host = this.host, set = a.curveSet, start = now;
        run.live.push({
          stop: () => {},
          tick: (t) => host.applyTime!(set, c.run({ vars: this.vars, stateTime: t - start, curveSetTime: (name: string) => this.curveSetTime(name), ship: () => this.ship() })),
        });
        continue;
      }
      if (a.k === "playCurveSet" && a.set && this.ownerId !== null && this.host.play) {
        const owner = this.ownerId, host = this.host, set = a.set, range = a.range ?? "";
        host.play(owner, set, range);
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
      if (a.k !== "childEffect" || a.other) continue;
      let child: THREE.Object3D | null = a.name ? this.owner.children.find((c) => c.name === a.name) ?? null : null;
      let stopped = false;
      if (!child && a.add !== false && a.effect) {
        void this.host.build(a.effect).then((o) => {
          if (!o || stopped) return;
          if (a.name) o.name = a.name;
          child = o;
          this.owner.add(o);
        });
      }
      run.live.push({ stop: () => { stopped = true; if (child && a.remove !== false) child.removeFromParent(); } });
    }
  }
}
