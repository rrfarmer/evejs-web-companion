import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readRowField, unwrapLong } from "./wire.ts";

export interface MiningLedgerEntry {
  readonly atMs: number;
  readonly typeID: number;
  readonly systemID: number;
  readonly quantity: number;
  readonly wasted: number;
}

export interface MiningLedgerFacts {
  readonly volume: number | null;
  readonly price: number | null;
  readonly basePrice?: number | null;
  readonly groupID: number | null;
  readonly baseTypeID: number | null;
  readonly metaLevel: number;
}

const DAY_MS = 86_400_000;
export const LEDGER_DAYS = 90;
const MOON_ORE_GROUPS = new Set([1884, 1920, 1921, 1922, 1923]);

export function decodeMiningLedger(raw: unknown): MiningLedgerEntry[] {
  const rows = isListValue(raw) ? raw.items : Array.isArray(raw) ? raw : null;
  if (!rows) throw new Error("The mining ledger returned an unexpected list.");
  return rows.map(row => {
    const value = (field: string) => Number(unwrapLong(readRowField(row, field)) ?? NaN);
    const atMs = filetimeToUnixMs(unwrapLong(readRowField(row, "eventDate")));
    const typeID = value("typeID");
    const systemID = value("solarsystemID") || value("solarSystemID");
    const quantity = value("quantity");
    const wasted = value("quantityWasted");
    if (atMs === null || ![typeID, systemID, quantity, wasted].every(Number.isSafeInteger) ||
        typeID <= 0 || systemID <= 0 || quantity < 0 || wasted < 0) {
      throw new Error("The mining ledger returned an incomplete entry.");
    }
    return { atMs, typeID, systemID, quantity, wasted };
  });
}

export function ledgerDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function ledgerDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function ledgerDateRange(nowMs: number) {
  const today = ledgerDay(nowMs);
  return { first: ledgerDate(today - LEDGER_DAYS * DAY_MS), from: ledgerDate(today - 30 * DAY_MS), to: ledgerDate(today) };
}

export function ledgerFilterOf(typeID: number, facts: MiningLedgerFacts | undefined): string {
  if (facts?.groupID == null) return `type:${typeID}`;
  if (MOON_ORE_GROUPS.has(facts.groupID)) return `type:${facts.baseTypeID ?? typeID}`;
  return `group:${facts.groupID}`;
}

export function filterMiningLedger(
  rows: readonly MiningLedgerEntry[], facts: ReadonlyMap<number, MiningLedgerFacts>, from: string, to: string,
  resources: ReadonlySet<string>,
) {
  const first = Date.parse(from);
  const end = Date.parse(to) + DAY_MS;
  return rows.filter(row => row.atMs >= first && row.atMs < end &&
    (resources.size === 0 || resources.has(ledgerFilterOf(row.typeID, facts.get(row.typeID)))));
}

export type LedgerMetric = "quantity" | "volume" | "value";

function measure(row: MiningLedgerEntry, metric: LedgerMetric, facts: MiningLedgerFacts | undefined): number {
  const factor = metric === "quantity" ? 1 : metric === "volume" ? facts?.volume : facts?.price || facts?.basePrice;
  return row.quantity * (factor ?? 0);
}

export function miningLedgerDaily(
  rows: readonly MiningLedgerEntry[], facts: ReadonlyMap<number, MiningLedgerFacts>, from: string, to: string, metric: LedgerMetric,
  types?: ReadonlySet<number>,
) {
  const counts = new Map<number, { quantity: number; parts: Map<number, number> }>();
  for (const row of rows) {
    if (types && !types.has(row.typeID)) continue;
    const day = ledgerDay(row.atMs);
    let count = counts.get(day);
    if (!count) {
      count = { quantity: 0, parts: new Map() };
      counts.set(day, count);
    }
    const quantity = measure(row, metric, facts.get(row.typeID));
    count.quantity += quantity;
    if (types && quantity > 0) count.parts.set(row.typeID, (count.parts.get(row.typeID) ?? 0) + quantity);
  }
  const days: { date: string; quantity: number; parts: [number, number][] }[] = [];
  const end = Date.parse(to);
  for (let day = Math.max(Date.parse(from), end - LEDGER_DAYS * DAY_MS); day <= end; day += DAY_MS) {
    const count = counts.get(day);
    days.push({ date: ledgerDate(day), quantity: count?.quantity ?? 0, parts: count ? [...count.parts].sort((a, b) => a[0] - b[0]) : [] });
  }
  return days;
}

export function miningLedgerTotals(rows: readonly MiningLedgerEntry[], facts: ReadonlyMap<number, MiningLedgerFacts>, metric: LedgerMetric) {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.typeID, (counts.get(row.typeID) ?? 0) + measure(row, metric, facts.get(row.typeID)));
  const sorted = [...counts].map(([typeID, quantity]) => ({ typeID, quantity })).sort((a, b) =>
    b.quantity - a.quantity || (facts.get(a.typeID)?.metaLevel ?? 1) - (facts.get(b.typeID)?.metaLevel ?? 1) || a.typeID - b.typeID);
  const top: { typeID: number | null; quantity: number }[] = sorted.slice(0, 15);
  const rest = sorted.slice(15).reduce((total, row) => total + row.quantity, 0);
  if (rest > 0) top.push({ typeID: null, quantity: rest });
  return top;
}
