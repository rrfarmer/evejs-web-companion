/** A Granny track's packed controls, or keyframes from an older turret bake. */
export interface GrannyTrack {
  times: number[];
  values: number[];
  width: number;
  degree?: number;
}

function copyControl(track: GrannyTrack, index: number, out: number[]): number[] {
  for (let j = 0; j < track.width; j++) out[j] = track.values[index * track.width + j]!;
  return out;
}

function quaternionSign(values: number[], first: number, second: number): number {
  let dot = 0;
  for (let j = 0; j < 4; j++) dot += values[first * 4 + j]! * values[second * 4 + j]!;
  return dot < 0 ? -1 : 1;
}

function sampleKeys(track: GrannyTrack, t: number, out: number[]): number[] {
  const { times, values, width } = track;
  const last = times.length - 1;
  if (last === 0 || t <= times[0]!) return copyControl(track, 0, out);
  if (t >= times[last]!) return copyControl(track, last, out);
  let right = 1;
  while (right < last && times[right]! < t) right++;
  const left = right - 1;
  const t0 = times[left]!, t1 = times[right]!;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  const sign = width === 4 ? quaternionSign(values, left, right) : 1;
  for (let j = 0; j < width; j++) out[j] = values[left * width + j]! * (1 - f) + sign * values[right * width + j]! * f;
  return out;
}

function upperKnot(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const ratio = (t: number, lo: number, hi: number): number => hi > lo ? (t - lo) / (hi - lo) : 0;

/** Granny's quadratic controls end at the first knot strictly after the sample. */
export function sampleGrannyTrack(track: GrannyTrack, t: number, out: number[], loopDuration = 0): number[] {
  const { times, values, width } = track;
  const last = times.length - 1;
  if (track.degree !== 2 || last < 1) return sampleKeys(track, t, out);
  t = Math.fround(t);
  if (loopDuration > 0 && t >= loopDuration) t %= loopDuration;
  if (t < times[0]!) return copyControl(track, 0, out);
  if (t >= times[last]!) return copyControl(track, last, out);

  // Granny stitches looping spans to the preceding or following cycle,
  // using its first control in place of the duplicated terminal knot.
  const looping = loopDuration > 0;
  const count = looping ? last : last + 1;
  const upper = upperKnot(times, t);
  const indexAt = (i: number) => looping ? ((i % count) + count) % count : Math.min(last, Math.max(0, i));
  const knotAt = (i: number) => times[indexAt(i)]! + (looping ? Math.floor(i / count) * loopDuration : 0);
  const a = ratio(t, knotAt(upper - 2), knotAt(upper));
  const b = ratio(t, knotAt(upper - 1), knotAt(upper));
  const c = ratio(t, knotAt(upper - 1), knotAt(upper + 1));
  const w0 = (1 - a) * (1 - b);
  const w2 = b * c;
  const w1 = 1 - w0 - w2;
  const i0 = indexAt(upper - 2), i1 = indexAt(upper - 1), i2 = indexAt(upper);
  // The native sampler aligns quaternion controls when it builds a window
  // across an endpoint. Inside the clip it uses the stored signs.
  const acrossEdge = width === 4 && (upper < 2 || upper + 1 >= count);
  const sign1 = acrossEdge ? quaternionSign(values, i0, i1) : 1;
  const sign2 = acrossEdge ? sign1 * quaternionSign(values, i1, i2) : 1;
  for (let j = 0; j < width; j++) {
    out[j] = w0 * values[i0 * width + j]! + w1 * sign1 * values[i1 * width + j]! + w2 * sign2 * values[i2 * width + j]!;
  }
  return out;
}
