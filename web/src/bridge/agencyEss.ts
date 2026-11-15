import { DISTANCE } from "./agencyAgents.ts";
import { readDictEntry, readDictPairs, unwrapBool, unwrapLong, unwrapReal } from "./wire.ts";

export const ESS_REGION = -1;

export interface AgencyEssFilters {
  readonly distance: number;
  readonly regionID: number | null;
  readonly constellationID: number | null;
  readonly outputEnabled: boolean;
  readonly minOutput: number;
  readonly maxOutput: number;
  readonly mainEnabled: boolean;
  readonly mainMinimum: number;
  readonly unlocked: boolean;
  readonly reserveEnabled: boolean;
  readonly reserveMinimum: number;
}

export const DEFAULT_ESS_FILTERS: AgencyEssFilters = Object.freeze({
  distance: DISTANCE.any, regionID: null, constellationID: null,
  outputEnabled: false, minOutput: 80, maxOutput: 100,
  mainEnabled: false, mainMinimum: 10_000_000, unlocked: false,
  reserveEnabled: false, reserveMinimum: 10_000_000,
});

export interface EssSystem {
  readonly solarSystemID: number;
  readonly output: number;
  readonly main: number;
  readonly reserve: number;
  readonly unlocked: boolean;
}

export interface EssLocation {
  readonly regionID: number;
  readonly constellationID: number;
  readonly security: number | null;
}

export interface AgencyEssSystem extends EssSystem {
  readonly jumps: number | null;
  readonly location: EssLocation | null;
}

export interface EssDetails {
  readonly autopayment: number;
  readonly links: number;
  readonly pulses: number;
  readonly payout: number;
  readonly chosenSeconds: number;
}

export interface EssSettings {
  readonly outputFloor: number;
  readonly outputCeiling: number;
  readonly earlyPayout: number;
  readonly latePayout: number;
  readonly reserveAccess: number;
  readonly bountiesCut: number | null;
  readonly autopaySeconds: number | null;
  readonly bufferSeconds: number | null;
  readonly mainPayRatio: number | null;
  readonly reserveMax: number | null;
  readonly outputIntervalSeconds: number | null;
}

function natural(value: unknown): number | null {
  const raw = unwrapLong(value);
  const n = raw === null ? null : Number(raw);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function essSystems(value: unknown): EssSystem[] {
  const pairs = readDictPairs(value);
  if (pairs.length === 0 && (value as { type?: unknown } | null)?.type !== "dict") {
    throw new Error("The ESS system list is unavailable.");
  }
  return pairs.flatMap(([key, row]) => {
    const solarSystemID = natural(key);
    const output = unwrapReal(readDictEntry(row, "currentOutput"));
    const money = (field: string) => {
      const amount = readDictEntry(row, field);
      return unwrapReal(amount) ?? natural(amount);
    };
    const main = money("mainValue");
    const reserve = money("reserveValue");
    const unlocked = unwrapBool(readDictEntry(row, "vaultOpen"));
    if (!solarSystemID || output === null || main === null || reserve === null || unlocked === null) return [];
    return [{ solarSystemID, output, main, reserve, unlocked }];
  });
}

export function essDetails(value: unknown): EssDetails | null {
  const field = (key: string) => natural(readDictEntry(value, key));
  const autopayment = field("autopaymentWindowState"), links = field("activeLinks"), pulses = field("totalPulses");
  const payout = field("reserveTimeWindowState"), chosenSeconds = field("reserveTimeChosen");
  if (autopayment === null || autopayment > 2 || payout === null || payout > 3 || links === null || pulses === null || chosenSeconds === null) return null;
  return { autopayment, links, pulses, payout, chosenSeconds };
}

export function essSettings(value: unknown): EssSettings | null {
  const field = (key: string) => unwrapReal(readDictEntry(value, key));
  const min = field("minOutput"), max = field("maxOutput");
  const earlyPayout = field("earlyPayoutThresholdFactor"), latePayout = field("latePayoutThresholdFactor");
  const reserveAccess = field("reserveBankTimeAccessFactor");
  if (min === null || max === null || min > max || earlyPayout === null || latePayout === null || reserveAccess === null) return null;
  return {
    outputFloor: Math.round(min * 100), outputCeiling: Math.round(max * 100), earlyPayout, latePayout, reserveAccess,
    bountiesCut: field("bountiesCut"), autopaySeconds: field("autopaymentIntervalSeconds"), bufferSeconds: field("bufferTimeSeconds"),
    mainPayRatio: field("mainBankPayRatio"), reserveMax: field("reserveBankMaxPayout"), outputIntervalSeconds: field("timeIntervalSeconds"),
  };
}

export function essBeacon(value: unknown): number | null {
  const beacon = natural(readDictEntry(value, "beaconID"));
  return beacon && beacon > 0 ? beacon : null;
}

/** The provider takes the first 32 matching entries in the service dictionary. */
export function filterEssSystems(systems: readonly EssSystem[], filters: AgencyEssFilters, here: number | null,
  jumpsTo: ReadonlyMap<number, number> | null, geography: ReadonlyMap<number, EssLocation>): AgencyEssSystem[] {
  if (here !== null && here >= 32000000) return [];
  const matches: AgencyEssSystem[] = [];
  for (const system of systems) {
    const { solarSystemID: id, output, main, reserve, unlocked } = system;
    const jumps = id === here ? 0 : jumpsTo?.get(id) ?? null;
    const location = geography.get(id) ?? null;
    if (filters.distance === ESS_REGION) {
      if (!location || location.regionID !== filters.regionID ||
          (filters.constellationID !== null && location.constellationID !== filters.constellationID)) continue;
    } else if (filters.distance === DISTANCE.currentSystem || (here !== null && here >= 31000000)) {
      if (id !== here) continue;
    } else if (filters.distance !== DISTANCE.any && (jumps === null || jumps > filters.distance)) continue;
    if (filters.outputEnabled && (output * 100 < filters.minOutput || output * 100 > filters.maxOutput)) continue;
    if (filters.mainEnabled && main < filters.mainMinimum) continue;
    if (filters.unlocked && !unlocked) continue;
    if (filters.reserveEnabled && reserve < filters.reserveMinimum) continue;
    matches.push({ ...system, jumps, location });
    if (matches.length === 32) break;
  }
  return matches;
}
