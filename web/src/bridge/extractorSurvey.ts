import type { ColonyExtractionProgram, ExtractorHead } from "../store/types.ts";
import type { ProgramYield } from "./extractorRestart.ts";

export const EXTRACTOR_HEAD_LIMIT = 10;
export const MIN_HEAD_RADIUS = .01;
export const MAX_HEAD_RADIUS = .05;
const RADIUS_SPAN = MAX_HEAD_RADIUS - MIN_HEAD_RADIUS;
const TICKS_PER_SECOND = 10_000_000;

export function radiusForSlider(value: number): number {
  return MIN_HEAD_RADIUS + value ** 2 * RADIUS_SPAN;
}

export function sliderForRadius(radius: number): number {
  return Math.sqrt((Math.max(MIN_HEAD_RADIUS, Math.min(MAX_HEAD_RADIUS, radius)) - MIN_HEAD_RADIUS) / RADIUS_SPAN);
}

export function validExtractorDraft(heads: readonly ExtractorHead[], radius: number): boolean {
  return heads.length > 0 && heads.length <= EXTRACTOR_HEAD_LIMIT
    && Number.isFinite(radius) && radius >= MIN_HEAD_RADIUS && radius <= MAX_HEAD_RADIUS
    && new Set(heads.map(([id]) => id)).size === heads.length
    && heads.every(([id, latitude, longitude]) => Number.isInteger(id) && id >= 0 && id < EXTRACTOR_HEAD_LIMIT
      && Number.isFinite(latitude) && latitude >= 0 && latitude <= Math.PI && Number.isFinite(longitude));
}

export function installedExtractorYield(program: ColonyExtractionProgram | null): ProgramYield | null {
  if (!program?.installedAtMs || !program.expiresAtMs || program.cycleTimeSeconds <= 0) return null;
  const cycles = Math.round((program.expiresAtMs - program.installedAtMs) / (program.cycleTimeSeconds * 1000));
  return cycles > 0 ? { quantity: program.quantityPerCycle, cycleTicks: program.cycleTimeSeconds * TICKS_PER_SECOND, cycles } : null;
}

/** EcuPin.GetProgramOutputPrediction, using the server's base quantity and cycle length. */
export function extractorOutput({ quantity, cycleTicks, cycles }: ProgramYield, decay: number, noise: number): number[] {
  const width = cycleTicks / (TICKS_PER_SECOND * 900);
  const phase = quantity ** .7;
  return Array.from({ length: cycles }, (_, cycle) => {
    const time = (cycle + .5) * width;
    const wave = (Math.cos(phase + time / 12) + Math.cos(phase / 2 + time / 5) + Math.cos(time / 2)) / 3;
    return Math.trunc(width * quantity / (1 + time * decay) * (1 + noise * Math.max(0, wave)));
  });
}
