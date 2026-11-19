import { isListValue, unwrapLong } from "./wire.ts";

export interface CargoScanRow {
  readonly typeID: number;
  readonly quantity: number;
}

export interface CargoScanResult {
  readonly targetID: number;
  readonly rows: readonly CargoScanRow[];
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
  const rows: CargoScanRow[] = [];
  for (const item of items) {
    const pair = list(item);
    if (pair?.length !== 2) continue;
    const typeID = safeInteger(pair[0]);
    const quantity = safeInteger(pair[1]);
    if (typeID !== null && typeID > 0 && quantity !== null) rows.push({ typeID, quantity });
  }
  return { targetID, rows };
}
