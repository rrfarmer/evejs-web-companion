import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readRowField, unwrapLong } from "./wire.ts";

export interface MiningLedgerYield {
  readonly atMs: number;
  readonly typeID: number;
  readonly systemID: number;
  readonly quantity: number;
}

export interface MiningLedgerEntry extends MiningLedgerYield {
  readonly wasted: number;
}

export interface CorporationMiningLedgerEntry extends MiningLedgerYield {
  readonly characterID: number;
  readonly corporationID: number;
}

export interface MiningLedgerObserver {
  readonly itemID: number;
  readonly systemID: number;
  readonly name: string;
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

function ledgerList(raw: unknown): readonly unknown[] {
  const rows = isListValue(raw) ? raw.items : Array.isArray(raw) ? raw : null;
  if (!rows) throw new Error("The mining ledger returned an unexpected list.");
  return rows;
}

const ledgerNumber = (row: unknown, field: string) => Number(unwrapLong(readRowField(row, field)) ?? NaN);
const ledgerSystem = (row: unknown) => ledgerNumber(row, "solarsystemID") || ledgerNumber(row, "solarSystemID");
const positiveID = (value: number) => Number.isSafeInteger(value) && value > 0;

function decodeYield(row: unknown): MiningLedgerYield {
  const atMs = filetimeToUnixMs(unwrapLong(readRowField(row, "eventDate")));
  const typeID = ledgerNumber(row, "typeID");
  const systemID = ledgerSystem(row);
  const quantity = ledgerNumber(row, "quantity");
  if (atMs === null || !positiveID(typeID) || !positiveID(systemID) || !Number.isSafeInteger(quantity) || quantity < 0)
    throw new Error("The mining ledger returned an incomplete entry.");
  return { atMs, typeID, systemID, quantity };
}

export function decodeMiningLedger(raw: unknown): MiningLedgerEntry[] {
  return ledgerList(raw).map(row => {
    const entry = decodeYield(row);
    const wasted = ledgerNumber(row, "quantityWasted");
    if (!Number.isSafeInteger(wasted) || wasted < 0) throw new Error("The mining ledger returned an incomplete entry.");
    return { ...entry, wasted };
  });
}

export function decodeCorporationMiningLedger(raw: unknown): CorporationMiningLedgerEntry[] {
  return ledgerList(raw).map(row => {
    const entry = decodeYield(row);
    const characterID = ledgerNumber(row, "characterID");
    const corporationID = ledgerNumber(row, "corporationID");
    if (!positiveID(characterID) || !positiveID(corporationID)) throw new Error("The corporation mining ledger returned an incomplete entry.");
    return { ...entry, characterID, corporationID };
  });
}

export function decodeMiningObservers(raw: unknown): MiningLedgerObserver[] {
  const observers = new Map<number, MiningLedgerObserver>();
  for (const row of ledgerList(raw)) {
    const itemID = ledgerNumber(row, "itemID");
    const systemID = ledgerSystem(row);
    const text = readRowField(row, "itemName");
    const name = text && typeof text === "object" && "type" in text && text.type === "wstring" && "value" in text ? text.value : text;
    if (!positiveID(itemID) || !positiveID(systemID) || typeof name !== "string")
      throw new Error("The mining ledger returned an incomplete observer.");
    observers.set(itemID, { itemID, systemID, name });
  }
  return [...observers.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.itemID - b.itemID);
}

export function canViewCorporationMiningLedger(corpRole: string | null | undefined): boolean {
  return typeof corpRole === "string" && /^\d+$/.test(corpRole) && (BigInt(corpRole) & 256n) !== 0n;
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

export function filterMiningLedger<T extends MiningLedgerYield>(
  rows: readonly T[], facts: ReadonlyMap<number, MiningLedgerFacts>, from: string, to: string,
  resources: ReadonlySet<string>,
) {
  const first = Date.parse(from);
  const end = Date.parse(to) + DAY_MS;
  return rows.filter(row => row.atMs >= first && row.atMs < end &&
    (resources.size === 0 || resources.has(ledgerFilterOf(row.typeID, facts.get(row.typeID)))));
}

export type LedgerMetric = "quantity" | "volume" | "value";

function measure(row: MiningLedgerYield, metric: LedgerMetric, facts: MiningLedgerFacts | undefined): number {
  const factor = metric === "quantity" ? 1 : metric === "volume" ? facts?.volume : facts?.price || facts?.basePrice;
  return row.quantity * (factor ?? 0);
}

export function miningLedgerDaily(
  rows: readonly MiningLedgerYield[], facts: ReadonlyMap<number, MiningLedgerFacts>, from: string, to: string, metric: LedgerMetric,
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

export function miningLedgerTotals(rows: readonly MiningLedgerYield[], facts: ReadonlyMap<number, MiningLedgerFacts>, metric: LedgerMetric) {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.typeID, (counts.get(row.typeID) ?? 0) + measure(row, metric, facts.get(row.typeID)));
  const sorted = [...counts].map(([typeID, quantity]) => ({ typeID, quantity })).sort((a, b) =>
    b.quantity - a.quantity || (facts.get(a.typeID)?.metaLevel ?? 1) - (facts.get(b.typeID)?.metaLevel ?? 1) || a.typeID - b.typeID);
  const top: { typeID: number | null; quantity: number }[] = sorted.slice(0, 15);
  const rest = sorted.slice(15).reduce((total, row) => total + row.quantity, 0);
  if (rest > 0) top.push({ typeID: null, quantity: rest });
  return top;
}
