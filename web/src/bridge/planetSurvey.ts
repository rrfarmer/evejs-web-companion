import type { PlanetResourceData } from "./boundPlanets.ts";

export const PLANET_SURVEY_SAMPLES = 80; // planetUISvc.SQRT_NUM_SAMPLES
export const PLANET_SURVEY_PROXIMITY = 4; // appConst.planetResourceProximityPlanet
export const PLANET_RESOURCE_MAXIMUM = 1.21;
export const PLANET_SURVEY_RAMP = "/client-res/dx9/model/worldobject/planet/resource_colorramp.dds";
export const PLANET_SURVEY_PATTERN = "/client-res/dx9/texture/ui/resdistpattern1.dds";

/** Colony access uses appConst.planetResourceProximityLimits[4]. */
export function planetSurveyBands(planetology: number, advancedPlanetology: number): number {
  return Math.min(30, 15 + planetology + 2 * advancedPlanetology);
}

export function planetResourceQuality(quality: number): number {
  return Math.max(0, Math.min(1, quality / (PLANET_RESOURCE_MAXIMUM * 255 * .5)));
}

/** Sample the game server's real SH basis, ordered by l²+l+m, into the installed client's 80×80 chart. */
export function chartPlanetSurvey({ data, numBands }: PlanetResourceData): Uint8Array<ArrayBuffer> {
  if (!data || !Number.isInteger(numBands) || numBands < 1 || numBands > 30 || data.length !== 4 * numBands ** 2) {
    throw new Error("The survey did not return a complete resource distribution.");
  }
  const wire = new DataView(Uint8Array.from(data).buffer);
  const weights = new Float64Array(numBands ** 2);
  for (let l = 0; l < numBands; l++) {
    const centre = l * (l + 1);
    let normalization = Math.sqrt((2 * l + 1) / (4 * Math.PI));
    weights[centre] = wire.getFloat32(4 * centre, true) * normalization;
    for (let m = 1; m <= l; m++) {
      normalization /= Math.sqrt((l - m + 1) * (l + m));
      weights[centre + m] = wire.getFloat32(4 * (centre + m), true) * normalization * Math.SQRT2;
      weights[centre - m] = wire.getFloat32(4 * (centre - m), true) * normalization * Math.SQRT2;
    }
  }
  if (!weights.every(Number.isFinite)) throw new Error("The survey returned an invalid resource distribution.");

  const size = PLANET_SURVEY_SAMPLES, last = size - 1;
  const cosine = new Float64Array(size * numBands), sine = new Float64Array(size * numBands);
  for (let x = 0; x < size; x++) {
    const azimuth = x * 2 * Math.PI / last;
    for (let m = 1; m < numBands; m++) {
      cosine[x * numBands + m] = Math.cos(azimuth * m);
      sine[x * numBands + m] = Math.sin(azimuth * m);
    }
  }

  const values = new Float64Array(size * size);
  const longitudinalCos = new Float64Array(numBands), longitudinalSin = new Float64Array(numBands);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < size; y++) {
    const polar = y * Math.PI / last;
    const z = Math.cos(polar);
    const radial = Math.sin(polar);
    let diagonal = 1;
    for (let m = 0; m < numBands; m++) {
      if (m > 0) diagonal *= -(2 * m - 1) * radial;
      let previous = 0, current = diagonal, cos = 0, sin = 0;
      for (let l = m; l < numBands; l++) {
        const centre = l * (l + 1);
        cos += current * weights[centre + m]!;
        if (m > 0) sin += current * weights[centre - m]!;
        const next = ((2 * l + 1) * z * current - (l + m) * previous) / (l - m + 1);
        previous = current;
        current = next;
      }
      longitudinalCos[m] = cos;
      longitudinalSin[m] = sin;
    }
    for (let x = 0; x < size; x++) {
      let value = longitudinalCos[0]!;
      for (let m = 1; m < numBands; m++) {
        const index = x * numBands + m;
        value += longitudinalCos[m]! * cosine[index]! + longitudinalSin[m]! * sine[index]!;
      }
      value /= PLANET_RESOURCE_MAXIMUM;
      values[y * size + x] = value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  // ChartResourceLayer removes the layer minimum before multiplying by its
  // absolute peak intensity. A constant distribution has no visible hotspots.
  const amplitude = Math.min(255, Math.max(0, max));
  const range = max - min || 1;
  return Uint8Array.from(values, value => Math.round(amplitude * (value - min) / range));
}
