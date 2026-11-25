import { isListValue, readRowField, unwrapLong } from "./wire.ts";
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
