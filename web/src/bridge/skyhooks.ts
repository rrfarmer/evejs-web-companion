import { isListValue, readKeyVal, readRowField, unwrapBool, unwrapLong, unwrapReal } from "./wire.ts";
import type { JsonValue } from "./wire.ts";

export interface SkyhookEntry {
  readonly id: number;
  readonly typeID: number;
  readonly planetID: number;
  readonly systemID: number;
  readonly state: number;
}

export interface SkyhookRow extends SkyhookEntry {
  readonly regionID: number | null;
  readonly security: number | null;
  readonly jumps: number | null;
  readonly harvest: { readonly typeID: number; readonly perMinute: number } |
    { readonly kind: "power" | "workforce"; readonly amount: number; readonly difference?: number } | null;
  readonly theft: { readonly vulnerable: boolean; readonly start: number; readonly end: number } | null;
}

export interface SkyhookFilters {
  location: 1 | 2 | 5 | 10 | -1 | null;
  region: number | null;
  state: "reinforced" | "vulnerable" | null;
  theftvulnerability: "secure" | "vulnerable" | null;
}

export function skyhookFilterSetting(key: keyof SkyhookFilters): string {
  return `skyhookbrowser_filters_${key}`;
}

export function skyhookFilters(read: (key: string) => string | null): SkyhookFilters {
  const location = Number(read(skyhookFilterSetting("location")));
  const region = Number(read(skyhookFilterSetting("region")));
  const state = read(skyhookFilterSetting("state"));
  const theft = read(skyhookFilterSetting("theftvulnerability"));
  return {
    location: location === -1 || location === 1 || location === 2 || location === 5 || location === 10 ? location : null,
    region: Number.isSafeInteger(region) && region > 0 ? region : null,
    state: state === "reinforced" || state === "vulnerable" ? state : null,
    theftvulnerability: theft === "secure" || theft === "vulnerable" ? theft : null,
  };
}

export const SKYHOOK_TYPE_ID = 81080;
export const REINFORCEMENT_VARIANCE_ATTRIBUTE = 1613;
export const ORBITAL_TAX_KEYS = [
  "corporation", "alliance", "standingHorrible", "standingBad", "standingNeutral", "standingGood", "standingHigh",
] as const;
export type OrbitalTaxKey = typeof ORBITAL_TAX_KEYS[number];

export interface SkyhookSettings {
  readonly hour: number;
  readonly taxRates: Record<OrbitalTaxKey, number>;
  readonly standing: number;
  readonly allowAlliance: boolean;
  readonly allowStandings: boolean;
  readonly acl: number | null;
}

export function decodeSkyhookSettings(value: JsonValue): SkyhookSettings {
  const fields = Array.isArray(value) ? value : isListValue(value) ? value.items : [];
  const [hour, taxData, standing, alliance, standings, acl] = fields;
  const allowAlliance = unwrapBool(alliance), allowStandings = unwrapBool(standings);
  if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      typeof standing !== "number" || allowAlliance === null || allowStandings === null || fields.length !== 6) {
    throw new Error("The orbital configuration could not be read.");
  }
  const taxRates = {} as SkyhookSettings["taxRates"];
  for (const key of ORBITAL_TAX_KEYS) {
    const rate = unwrapReal(readKeyVal(taxData, key));
    if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error("An orbital tax rate could not be read.");
    taxRates[key] = rate;
  }
  const groupID = typeof acl === "number" ? acl : Number(unwrapLong(acl) ?? 0n);
  return { hour, taxRates, standing, allowAlliance, allowStandings, acl: groupID > 0 ? groupID : null };
}

export function skyhookSettingsArgs(id: number, values: SkyhookSettings): JsonValue[] {
  const rates = ORBITAL_TAX_KEYS.map(key => [key, values.taxRates[key]] as const);
  if (!Number.isInteger(values.hour) || values.hour < 0 || values.hour > 23 ||
      ![-10, -5, 0, 5, 10].includes(values.standing) ||
      rates.some(([, rate]) => !Number.isFinite(rate) || rate < 0 || rate > 1)) {
    throw new Error("Enter a reinforcement hour and tax rates from 0 to 100 percent.");
  }
  const taxRates = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: rates } };
  return [id, values.hour, taxRates, values.standing, values.allowAlliance, values.allowStandings, values.acl];
}

export function skyhookVulnerable(state: number): boolean {
  return state === 210 || state === 212 || state === 214;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
  return Number(typeof value === "string" || typeof value === "number" ? value : 0) || 0;
}

function timestamp(value: unknown): number {
  const time = record(value);
  return number(time.seconds) * 1000 + number(time.nanos) / 1_000_000;
}

export function decodeSkyhookEntries(value: JsonValue): SkyhookEntry[] {
  const list = isListValue(value) ? value.items : Array.isArray(value) ? value : [];
  return list.flatMap(row => {
    const field = (name: string): number => {
      const raw = readRowField(row, name);
      return number(typeof raw === "number" ? raw : unwrapLong(raw)?.toString());
    };
    const id = field("skyhookID"), typeID = field("typeID"), planetID = field("planetID"), systemID = field("solarSystemID");
    return id > 0 && typeID > 0 && planetID > 0 && systemID > 0 ? [{ id, typeID, planetID, systemID, state: field("state") }] : [];
  });
}

export function decodeSkyhookDetails(value: unknown): Map<number, Record<string, unknown>> {
  const rows = record(value).skyhooks;
  return new Map((Array.isArray(rows) ? rows : []).map(value => {
    const row = record(value);
    return [number(record(row.skyhook).sequential), row];
  }));
}

export function skyhookProduction(detail: Record<string, unknown> | undefined, planet: {
  power: number; workforce: number; reagent: { typeID: number; amountPerPeriod: number; periodSeconds: number } | null;
} | undefined): Pick<SkyhookRow, "harvest" | "theft"> {
  const definitions = detail?.reagent_definitions;
  const first = record(Array.isArray(definitions) ? definitions[0] : undefined);
  const definition = record(first.definition);
  const reagent = detail ? {
    typeID: number(record(first.reagent_type).sequential),
    amountPerPeriod: number(definition.amount_per_cycle),
    periodSeconds: number(record(definition.cycle_period).seconds),
  } : planet?.reagent;
  if (reagent && reagent.typeID > 0 && reagent.periodSeconds > 0) {
    const theft = record(detail?.theft_vulnerability);
    const start = timestamp(theft.start), end = timestamp(theft.end);
    return { harvest: { typeID: reagent.typeID, perMinute: reagent.amountPerPeriod * 60 / reagent.periodSeconds },
      theft: start > 0 && end > start ? { vulnerable: theft.vulnerable === true, start, end } : null };
  }
  if (planet && planet.power > 0) return { harvest: { kind: "power", amount: planet.power }, theft: null };
  if (planet && planet.workforce > 0) {
    const current = number(record(detail?.workforce).amount);
    return { harvest: { kind: "workforce", amount: current || planet.workforce,
      difference: current ? Math.round((current - planet.workforce) / planet.workforce * 100) : undefined }, theft: null };
  }
  return { harvest: null, theft: null };
}
