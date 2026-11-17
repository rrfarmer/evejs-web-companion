import { compileCondition } from "./controllers.ts";

export type SmartLightModifier =
  | { kind: "listener"; variable: string; initial: number; invert: boolean; duration: number; factor: number; children: SmartLightModifier[] }
  | { kind: "expression"; source: string; factor: number; children: SmartLightModifier[] }
  | { kind: "color"; color: number[]; blend: number; brightness: number; saturation: number; factor: number;
      active: boolean; startsActive: boolean; variable: string; duration: number; curve: number; delayIn: number; delayOut: number };

interface Inputs {
  variable(name: string): number | undefined;
  speed: number;
  maxSpeed: number;
}
interface Gate { ready: boolean; weight: number }
interface Frame { dt: number; rgb: number[]; input: Inputs }
type Modifier = (frame: Frame, gate: Gate) => void;

function crossFade(initial: boolean) {
  let value = initial ? 1 : 0;
  let active = initial;
  let delay = 0;
  return (target: boolean, dt: number, duration: number, inDelay = 0, outDelay = 0, inputChanged = false) => {
    if (target !== active) {
      active = target;
      delay = target ? inDelay : outDelay;
      if (inputChanged) dt = 0;
    }
    const elapsed = Math.max(0, dt - delay);
    delay = Math.max(0, delay - dt);
    if (delay === 0) value = duration > 0 ? Math.max(0, Math.min(1, value + (active ? elapsed : -elapsed) / duration)) : Number(active);
    return { value, dt };
  };
}

const apply = (children: Modifier[], frame: Frame, gate: Gate) => {
  for (const child of children) child(frame, gate);
};

function compile(item: SmartLightModifier, initialGate: boolean, insideBucket = false): Modifier {
  if (item.kind === "listener") {
    const initial = item.initial > 0 && initialGate;
    const fade = crossFade(initial);
    const children = item.children.map((child) => compile(child, initial, true));
    return (frame, gate) => {
      const v = frame.input.variable(item.variable);
      const active = gate.ready && (v === undefined ? item.initial > 0 : item.invert ? v < 1 : v > 0);
      const { value, dt } = fade(active, frame.dt, item.duration, 0, 0, !insideBucket);
      apply(children, dt === frame.dt ? frame : { ...frame, dt }, { ready: active && value === 1, weight: gate.weight * value * item.factor });
    };
  }
  if (item.kind === "expression") {
    const expr = compileCondition(item.source);
    const children = item.children.map((child) => compile(child, initialGate, true));
    const vars = new Map<string, number>();
    return (frame, gate) => {
      vars.set("shipSpeed", frame.input.speed);
      vars.set("shipMaxSpeed", frame.input.maxSpeed);
      const value = expr?.run({ vars, stateTime: 0, curveSetTime: () => 0 }) ?? 0;
      apply(children, frame, { ready: gate.ready, weight: gate.weight * item.factor * (Number.isFinite(value) ? value : 0) });
    };
  }
  const fade = crossFade(initialGate && item.active && item.startsActive);
  return (frame, gate) => {
    const v = item.variable ? frame.input.variable(item.variable) : undefined;
    const active = gate.ready && (v === undefined ? (insideBucket || item.active) : v > 0);
    const { value: progress } = fade(active, frame.dt, item.duration, item.delayIn, item.delayOut, !insideBucket);
    const value = item.curve === 5 && progress > 0 ? 2 ** (10 * (progress - 1)) : progress;
    const weight = gate.weight * value * item.factor;
    if (weight === 0) return;
    const blend = item.blend * weight;
    const rgb = frame.rgb;
    for (let i = 0; i < 3; i++) rgb[i] = rgb[i]! + ((item.color[i] ?? 0) - rgb[i]!) * blend;
    const luminance = rgb[0]! * 0.299 + rgb[1]! * 0.587 + rgb[2]! * 0.114;
    const saturation = 1 + (item.saturation - 1) * weight;
    const brightness = 1 + (item.brightness - 1) * weight;
    for (let i = 0; i < 3; i++) rgb[i] = (luminance + (rgb[i]! - luminance) * saturation) * brightness;
  };
}

/** An instance's state, independent of the other copies of the same hull. */
export function smartLightColor(color: number[], modifiers: readonly SmartLightModifier[]) {
  const run = modifiers.map((modifier) => compile(modifier, true));
  let last: number | undefined;
  return (now: number, input: Inputs): number[] => {
    const dt = last === undefined ? 0 : Math.max(0, now - last);
    last = now;
    const rgb = color.slice();
    apply(run, { dt, rgb, input }, { ready: true, weight: 1 });
    return rgb;
  };
}
