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
// is the owner's sets' length (or the range's). The other actions, the ship functions and the controller's event
// handlers are not run yet: a condition that calls a function not here never holds.

import * as THREE from "three";

export interface SofControllerAction {
  k: string;
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
}

type Scope = { vars: Map<string, number>; stateTime: number; curveSetTime: (name: string) => number };
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
        if (t === "StateTime" && next() === ")") { pure = false; return (s) => s.stateTime; }
        // CurveSetTime("set") or ("set/range"): not pure either
        if (t === "CurveSetTime" && i < tokens.length && tokens[i - 1] === "(") {
          const arg = next();
          if (!arg || !arg.startsWith('"') || next() !== ")") return null;
          const name = arg.slice(1, -1);
          pure = false;
          return (s) => s.curveSetTime(name);
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
  stop?(owner: number, name: string): void;
  duration?(owner: number, name: string, range: string): number;
}

type Live = { stop(): void; canTransition?(now: number): boolean; tick?(now: number): void };

/** One clone's run of one controller, its owner the container's group in that clone. */
export class ControllerRun {
  private readonly vars = new Map<string, number>();
  private readonly machines: { current: number; stateStart: number; live: Live[]; vetoed: boolean }[] = [];

  constructor(private readonly data: SofController, private readonly owner: THREE.Object3D, private readonly host: ChildEffectHost, private readonly ownerId: number | null = null) {
    for (const v of data.variables) this.vars.set(v.name, v.value);
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
    const now = performance.now() / 1000;
    for (let i = 0; i < this.machines.length; i++) this.follow(i, now, this.machines[i]!.vetoed);
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
      const scope = { vars: this.vars, stateTime: now - run.stateStart, curveSetTime: (name: string) => this.curveSetTime(name) };
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

  /** CurveSetTime("set") or ("set/range") of the owner's sets. */
  private curveSetTime(name: string): number {
    if (this.ownerId === null || !this.host.duration) return 0;
    const slash = name.indexOf("/");
    return slash >= 0 ? this.host.duration(this.ownerId, name.slice(0, slash), name.slice(slash + 1)) : this.host.duration(this.ownerId, name, "");
  }

  private enter(state: SofControllerState, run: { live: Live[] }, now: number): void {
    for (const a of state.actions) {
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
