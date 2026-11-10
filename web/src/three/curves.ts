// Trinity's animation curves, as the hull children's curve sets drive their objects: Tr2CurveScalar so far (its keys,
// interpolation, tangents and extrapolation), its values checked against the client's own (Tr2CurveScalar.GetValueAt
// in the client's Python, client 3396210).

/** trinity.Tr2CurveExtrapolation. */
export const EXTRAPOLATION = { CLAMP: 0, CYCLE: 1, MIRROR: 2, LINEAR: 3 } as const;
/** trinity.Tr2CurveInterpolation: the segment following a key. */
export const INTERPOLATION = { CONSTANT: 0, LINEAR: 1, HERMITE: 2 } as const;
/** trinity.Tr2CurveTangentType. */
export const TANGENT = { AUTO_CLAMP: 0, AUTO: 1, FREE_JOINED: 2, FREE_SPLIT: 3 } as const;

/** A key as the object file has it: time, value, leftTangent, rightTangent, id, interpolation, tangentType. */
export type ScalarKey = [number, number, number, number, number, number, number];

export interface ScalarCurve {
  keys: ScalarKey[];
  extrapolationBefore?: number;
  extrapolationAfter?: number;
  timeOffset?: number;
  timeScale?: number;
}

interface Key { t: number; v: number; left: number; right: number; interp: number; type: number }

/**
 * The keys sorted by time. Their tangents are used as the file has them, whatever their tangent type: the client
 * computes AUTO / AUTO_CLAMP tangents when a curve is edited and stores them; loading takes them as they are (its
 * GetTangentAt at each key returns the stored tangent, AUTO_CLAMP keys included).
 */
export function prepareScalar(curve: ScalarCurve): Key[] {
  return curve.keys.map((k) => ({ t: k[0], v: k[1], left: k[2], right: k[3], interp: k[5], type: k[6] })).sort((a, b) => a.t - b.t);
}

function segment(a: Key, b: Key, t: number): number {
  if (a.interp === INTERPOLATION.CONSTANT) return a.v;
  const d = b.t - a.t;
  if (d <= 0) return b.v;
  const s = (t - a.t) / d;
  if (a.interp === INTERPOLATION.LINEAR) return a.v + (b.v - a.v) * s;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * d * a.right + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * d * b.left;
}

/** The curve's value at a time (its timeOffset and timeScale applied first). */
export function scalarAt(curve: ScalarCurve, keys: Key[], time: number): number {
  if (!keys.length) return 0;
  // a 32-bit float, as the client's (a time a hair short of a key in double is on it in float)
  const t = Math.fround((Math.fround(time) - (curve.timeOffset ?? 0)) * (curve.timeScale ?? 1));
  const first = keys[0]!, last = keys[keys.length - 1]!;
  if (keys.length === 1) return first.v;
  const span = last.t - first.t;
  if (t < first.t) {
    const mode = curve.extrapolationBefore ?? EXTRAPOLATION.CLAMP;
    if (mode === EXTRAPOLATION.CLAMP) return first.v;
    if (mode === EXTRAPOLATION.LINEAR) return first.v - (first.t - t) * first.left;
    // brought forward by whole spans, in 32-bit floats: a whole number of spans back lands on the first key
    if (span <= 0) return first.v;
    const n = Math.ceil(Math.fround((first.t - t) / span));
    let u = Math.fround(t + Math.fround(span * n));
    if (mode === EXTRAPOLATION.MIRROR && n % 2 !== 0) u = Math.fround(first.t + last.t - u);
    return inside(keys, u, false);
  }
  if (t > last.t) {
    const mode = curve.extrapolationAfter ?? EXTRAPOLATION.CLAMP;
    if (mode === EXTRAPOLATION.CLAMP) return last.v;
    if (mode === EXTRAPOLATION.LINEAR) return last.v + (t - last.t) * last.right;
    // brought back by whole spans, in 32-bit floats: a whole number of spans on lands on (or a hair past) the end,
    // taken from inside the last segment (the client's: a constant last segment gives its own value there)
    if (span <= 0) return last.v;
    const n = Math.ceil(Math.fround((t - last.t) / span));
    let u = Math.fround(t - Math.fround(span * n));
    if (mode === EXTRAPOLATION.MIRROR && n % 2 !== 0) u = Math.fround(first.t + last.t - u);
    return inside(keys, u, true);
  }
  return inside(keys, t, false);
}

/** The value at u within the keys; at the last key itself, its value, or (fromBelow) the last segment's end. */
function inside(keys: Key[], u: number, fromBelow: boolean): number {
  const last = keys[keys.length - 1]!;
  if (u >= last.t && !fromBelow) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.t <= u) i++;
  return segment(keys[i]!, keys[i + 1]!, Math.min(u, last.t));
}

// ---------------------------------------------------------------------------------------------------------------
// Tr2CurveScalarExpression: an expression over the time and its input curves, as the client parses it (its terms
// read from Tr2CurveScalarExpression.GetExpressionTermInfo, the operators and functions probed with GetValueAt in the
// client's Python): + - * / % ^ (power), unary minus, < > <= >= == != && || and ?:; time, pi, pi2, input1..input4 (the
// object's attributes); input(n), inputAt(n, t); clamp(x, min, max); sin cos tan asin acos atan abs sqrt exp log sign
// min max; fractal(x, alpha, beta, n) and noise(x) (trinity's Perlin noise: below); randconst / randomConstant(a, b)
// (a per-curve constant in [a, b)), random(a, b) (new each time), randhash(x, a, b) (a value in [a, b) by x). A name the
// client does not know (pow, floor, frac, lerp, saturate ...) is 0 there, and so here.

/** Any curve a curve set or an expression can hold. */
export type Curve =
  | ({ type: "Tr2CurveScalar" } & ScalarCurve)
  | { type: "Tr2CurveScalarExpression"; expression?: string; inputs?: Curve[]; input1?: number; input2?: number; input3?: number; input4?: number }
  | { type: string; [k: string]: unknown };

type Node =
  | { k: "num"; v: number }
  | { k: "name"; n: string }
  | { k: "call"; n: string; a: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "if"; c: Node; a: Node; b: Node };

// the binary operators by precedence, loosest first; ^ binds tighter than a unary minus (-2^2 is -4 in the client) and
// to the left (2^3^2 is 64)
const BINARY: string[][] = [["||"], ["&&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]];
const TOKEN = /\s*(\d*\.\d+(?:[eE][-+]?\d+)?|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||==|!=|<=|>=|[-+*/%^<>?:(),!])/g;

/** The expression parsed (one the parser cannot read gives nought, as an expression the client cannot read does). */
export function parseExpression(src: string): Node {
  const tokens = (src.match(TOKEN) ?? []).map((t) => t.trim());
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => { const x = tokens[i++]; if (x === undefined || (t !== undefined && x !== t)) throw new Error("syntax"); return x; };
  const primary = (): Node => {
    const t = take();
    if (t === "(") { const e = ternary(); take(")"); return e; }
    if (t === "-" || t === "+" || t === "!") return { k: "un", op: t, a: primary() };
    if (/^[\d.]/.test(t)) return { k: "num", v: Number(t) };
    if (peek() === "(") {
      take("(");
      const a: Node[] = [];
      if (peek() !== ")") { a.push(ternary()); while (peek() === ",") { take(","); a.push(ternary()); } }
      take(")");
      return { k: "call", n: t, a };
    }
    return { k: "name", n: t };
  };
  const power = (): Node => {
    let left = primary();
    while (peek() === "^") { take("^"); left = { k: "bin", op: "^", a: left, b: primary() }; }
    return left;
  };
  const unary = (): Node => {
    const t = peek();
    if (t === "-" || t === "+" || t === "!") { take(); return { k: "un", op: t, a: unary() }; }
    return power();
  };
  const binary = (level: number): Node => {
    if (level >= BINARY.length) return unary();
    let left = binary(level + 1);
    const ops = BINARY[level]!;
    while (peek() !== undefined && ops.includes(peek()!)) {
      const op = take();
      left = { k: "bin", op, a: left, b: binary(level + 1) };
    }
    return left;
  };
  const ternary = (): Node => {
    const c = binary(0);
    if (peek() === "?") { take("?"); const a = ternary(); take(":"); const b = ternary(); return { k: "if", c, a, b }; }
    return c;
  };
  try {
    const e = ternary();
    return i === tokens.length ? e : { k: "num", v: 0 };
  } catch {
    return { k: "num", v: 0 };
  }
}

/**
 * Trinity's noise (_trinity_dx11.dll 0x180e55d20, its tables built at 0x180e55a30, decompiled): Ken Perlin's reference
 * PerlinNoise1D - n octaves of noise1(x + 4096) (each lattice point's gradient from a 256-entry table, a smooth step
 * between two), each divided by alpha^i, x multiplied by beta between them. The expression's fractal(x, a, b, n) is
 * (that + 1) x 0.5 at x plus the curve's own offset (n rounded), noise(x) the same with a = b = 1, one octave. The
 * tables are built from the C runtime's rand() the first time any noise is asked for, so their numbers depend on how
 * many rand() calls the process made before: built here as the reference builds them from the generator's first
 * state (MSVC's, seed 1). The client's per-curve offset is a random value of its own: one in [0, 256) here, the
 * table's period.
 */
const perlin = (() => {
  let state = 1;
  const rand = () => { state = (Math.imul(state, 214013) + 2531011) >>> 0; return (state >>> 16) & 0x7fff; };
  const p = new Int32Array(256), g1 = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
    g1[i] = ((rand() & 0x1ff) - 256) / 256;
    // the reference draws the 2D and 3D gradients here too (five more)
    for (let j = 0; j < 5; j++) rand();
  }
  for (let i = 255; i > 0; i--) { const k = p[i]!; const j = rand() & 0xff; p[i] = p[j]!; p[j] = k; }
  const noise1 = (x: number) => {
    const t = x + 4096, f = Math.floor(t), b0 = f & 255, b1 = (b0 + 1) & 255, r = t - f;
    const sx = r * r * (3 - 2 * r), u = r * g1[p[b0]!]!, v = (r - 1) * g1[p[b1]!]!;
    return u + sx * (v - u);
  };
  return (x: number, alpha: number, beta: number, n: number) => {
    let sum = 0, scale = 1;
    for (let i = 0; i < n; i++) { sum += noise1(x) / scale; scale *= alpha; x *= beta; }
    return sum;
  };
})();

interface ExprState { node: Node; offset: number; constants: Map<Node, number> }
const exprStates = new WeakMap<object, ExprState>();
const scalarKeys = new WeakMap<object, ReturnType<typeof prepareScalar>>();
type ExpressionCurve = { type: "Tr2CurveScalarExpression"; expression?: string; inputs?: Curve[]; input1?: number; input2?: number; input3?: number; input4?: number };

/** Any curve's value at a time: a Tr2CurveScalar or a Tr2CurveScalarExpression; any other kind nought (not ported yet). */
export function curveValue(curve: Curve | undefined | null, time: number): number {
  if (!curve) return 0;
  if (curve.type === "Tr2CurveScalar") {
    let k = scalarKeys.get(curve);
    if (!k) { k = prepareScalar(curve as unknown as ScalarCurve); scalarKeys.set(curve, k); }
    return scalarAt(curve as unknown as ScalarCurve, k, time);
  }
  if (curve.type === "Tr2CurveScalarExpression") return expressionValue(curve as ExpressionCurve, time);
  return 0;
}

function expressionValue(curve: ExpressionCurve, time: number): number {
  let st = exprStates.get(curve);
  if (!st) { st = { node: parseExpression(curve.expression ?? ""), offset: Math.random() * 256, constants: new Map() }; exprStates.set(curve, st); }
  const s = st;
  const t = Math.fround(time);
  const ev = (n: Node): number => {
    switch (n.k) {
      case "num": return n.v;
      case "name":
        switch (n.n) {
          case "time": return t;
          case "pi": return Math.fround(Math.PI);
          case "pi2": return Math.fround(Math.PI * 2);
          case "input1": return curve.input1 ?? 0;
          case "input2": return curve.input2 ?? 0;
          case "input3": return curve.input3 ?? 0;
          case "input4": return curve.input4 ?? 0;
          default: return 0;
        }
      case "un": { const a = ev(n.a); return n.op === "-" ? -a : n.op === "!" ? (a === 0 ? 1 : 0) : a; }
      case "if": return ev(n.c) !== 0 ? ev(n.a) : ev(n.b);
      case "bin": {
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b;
          case "%": return a % b; case "^": return Math.pow(a, b);
          case "<": return a < b ? 1 : 0; case ">": return a > b ? 1 : 0; case "<=": return a <= b ? 1 : 0; case ">=": return a >= b ? 1 : 0;
          case "==": return a === b ? 1 : 0; case "!=": return a !== b ? 1 : 0;
          case "&&": return a !== 0 && b !== 0 ? 1 : 0; case "||": return a !== 0 || b !== 0 ? 1 : 0;
        }
        return 0;
      }
      case "call": {
        const arg = (i: number) => (n.a[i] ? ev(n.a[i]!) : 0);
        switch (n.n) {
          case "input": return curveValue(curve.inputs?.[Math.trunc(arg(0))], t);
          case "inputAt": return curveValue(curve.inputs?.[Math.trunc(arg(0))], arg(1));
          case "clamp": return Math.min(Math.max(arg(0), arg(1)), arg(2));
          case "sin": return Math.sin(arg(0)); case "cos": return Math.cos(arg(0)); case "tan": return Math.tan(arg(0));
          case "asin": return Math.asin(arg(0)); case "acos": return Math.acos(arg(0)); case "atan": return Math.atan(arg(0));
          case "abs": return Math.abs(arg(0)); case "sqrt": return Math.sqrt(arg(0)); case "exp": return Math.exp(arg(0));
          case "log": return Math.log(arg(0)); case "sign": return Math.sign(arg(0));
          case "min": return Math.min(arg(0), arg(1)); case "max": return Math.max(arg(0), arg(1));
          case "fractal": return (perlin(arg(0) + s.offset, arg(1), arg(2), Math.trunc(arg(3) + 0.5)) + 1) * 0.5;
          case "noise": return (perlin(arg(0) + s.offset, 1, 1, 1) + 1) * 0.5;
          case "randconst": case "randomConstant": {
            let c = s.constants.get(n);
            if (c === undefined) { c = arg(0) + Math.random() * (arg(1) - arg(0)); s.constants.set(n, c); }
            return c;
          }
          case "random": return arg(0) + Math.random() * (arg(1) - arg(0));
          case "randhash": {
            // a value in [a, b) by x: the client's own hash is not read, a stand-in with the same range
            const h = Math.sin(arg(0) * 12.9898) * 43758.5453;
            return arg(1) + (h - Math.floor(h)) * (arg(2) - arg(1));
          }
        }
        return 0;
      }
    }
  };
  return Math.fround(ev(s.node));
}
