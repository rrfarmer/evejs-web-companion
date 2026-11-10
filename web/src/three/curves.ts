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
