// The 24.02 DX11 light modifier uses a Mersenne Twister seeded with zero
// to initialize one period of its gradient lattice. Build it lazily.
let gradients: Float64Array | undefined;

function makeGradients(): Float64Array {
  const state = new Uint32Array(624);
  for (let i = 1; i < state.length; i++) {
    const previous = state[i - 1]!;
    state[i] = Math.imul(previous ^ (previous >>> 30), 1812433253) + i;
  }
  for (let i = 0; i < state.length; i++) {
    const bits = (state[i]! & 0x80000000) | (state[(i + 1) % state.length]! & 0x7fffffff);
    state[i] = state[(i + 397) % state.length]! ^ (bits >>> 1) ^ (bits & 1 ? 0x9908b0df : 0);
  }
  return Float64Array.from(state.subarray(0, 256), initial => {
    let value = initial ^ (initial >>> 11);
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return ((value & 511) - 256) / 256;
  });
}

/** The installed modifier's Perlin kernel, with lacunarity and falloff both 2. */
export function smartLightPerlin(x: number, octaves: number): number {
  const lattice = gradients ??= makeGradients();
  let sum = 0, scale = 1;
  for (let octave = 0; octave < octaves; octave++) {
    const floor = Math.floor(x);
    const t = x - floor;
    // CVTTSD2SI selects index zero on signed 32-bit overflow. The
    // fractional part still comes from the 64-bit floor.
    const i = floor >= -0x80000000 && floor <= 0x7fffffff ? floor & 255 : 0;
    const left = t * lattice[i]!;
    const right = (t - 1) * lattice[(i + 1) & 255]!;
    sum += (left + t * t * (3 - 2 * t) * (right - left)) * scale;
    x *= 2;
    scale *= 0.5;
  }
  return sum;
}

// Blue's GetSimTime is an epoch-based FILETIME. The browser sim clock and
// preview clock use Unix milliseconds.
const FILETIME_UNIX_OFFSET_SECONDS = 11_644_473_600;

export function smartLightNoiseGain(simTimeMs: number, frequency: number, octaves: number, amplitude: number, weight: number): number {
  const effectiveAmplitude = amplitude * weight;
  if (effectiveAmplitude <= 0) return 1;
  const seconds = simTimeMs / 1000 + FILETIME_UNIX_OFFSET_SECONDS;
  const noise = (1 + smartLightPerlin(seconds * frequency, octaves)) * 0.5;
  return 1 + (noise * effectiveAmplitude - 1) * weight;
}
