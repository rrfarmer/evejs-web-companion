import type { DogmaTypeFacts } from "./dogma/location.ts";
import { isListValue, readRowField, unwrapLong, unwrapReal } from "./wire.ts";

interface ScanItemRow {
  readonly typeID: number;
  readonly quantity: number;
}

export interface CargoScanResult {
  readonly targetID: number;
  readonly rows: readonly ScanItemRow[];
}

export interface ShipScanResult {
  readonly targetID: number;
  readonly capacitorCharge: number;
  readonly capacitorCapacity: number;
  readonly rows: readonly ScanItemRow[];
}

const slotGroups = new Map([
  [12, "High slots"], [13, "Medium slots"], [11, "Low slots"],
  [3772, "Subsystems"], [2663, "Rig slots"], [6306, "Service slots"],
]);
const shipScanGroupOrder = [...slotGroups.values(), "Charges", "Other"];

export interface ShipScanGroup {
  readonly name: string;
  readonly rows: readonly { readonly typeID: number; readonly quantity: number | null }[];
}

const list = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? value : isListValue(value) ? value.items : null;

function safeInteger(value: unknown): number | null {
  const n = unwrapLong(value);
  const parsed = n === null ? NaN : Number(n);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** OnCargoScanComplete carries the target ball ID and a list of (typeID, quantity) tuples. */
export function decodeCargoScan(args: readonly unknown[]): CargoScanResult | null {
  const targetID = safeInteger(args[0]);
  const items = list(args[1]);
  if (targetID === null || targetID <= 0 || items === null) return null;
  const rows: ScanItemRow[] = [];
  for (const item of items) {
    const pair = list(item);
    if (pair?.length !== 2) continue;
    const typeID = safeInteger(pair[0]);
    const quantity = safeInteger(pair[1]);
    if (typeID !== null && typeID > 0 && quantity !== null) rows.push({ typeID, quantity });
  }
  return { targetID, rows };
}

/** OnShipScanCompleted carries absolute capacitor readings in GJ and fitted hardware. */
export function decodeShipScan(args: readonly unknown[]): ShipScanResult | null {
  const targetID = safeInteger(args[0]);
  const capacitorCharge = unwrapReal(args[1]) ?? safeInteger(args[1]);
  const capacitorCapacity = unwrapReal(args[2]) ?? safeInteger(args[2]);
  const items = list(args[3]);
  if (targetID === null || targetID <= 0 || capacitorCharge === null || capacitorCapacity === null || items === null) return null;

  const rows: ScanItemRow[] = [];
  for (const item of items) {
    const pair = list(item);
    if (pair !== null && pair.length !== 2) continue;
    const typeID = safeInteger(pair === null ? readRowField(item, "typeID") : pair[0]);
    const quantity = safeInteger(pair === null ? readRowField(item, "stacksize") : pair[1]);
    if (typeID !== null && typeID > 0 && quantity !== null && quantity > 0) rows.push({ typeID, quantity });
  }
  return { targetID, capacitorCharge, capacitorCapacity, rows };
}

export function groupShipScanHardware(
  rows: ShipScanResult["rows"],
  types: Readonly<Record<number, Pick<DogmaTypeFacts, "categoryID" | "effects"> | null>>,
): ShipScanGroup[] {
  const grouped = new Map<string, Map<number, number | null>>();
  for (const { typeID, quantity } of rows) {
    const facts = types[typeID];
    const isCharge = facts?.categoryID === 8;
    const slotEffect = facts?.effects.find(effectID => slotGroups.has(effectID));
    const name = isCharge ? "Charges" : slotGroups.get(slotEffect ?? 0) ?? "Other";
    let entries = grouped.get(name);
    if (!entries) {
      entries = new Map();
      grouped.set(name, entries);
    }
    entries.set(typeID, isCharge ? null : (entries.get(typeID) ?? 0) + quantity);
  }
  return shipScanGroupOrder.flatMap(name => {
    const entries = grouped.get(name);
    return entries ? [{ name, rows: Array.from(entries, ([typeID, quantity]) => ({ typeID, quantity })) }] : [];
  });
}
