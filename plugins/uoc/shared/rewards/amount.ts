// Pure amount conversion from WC75 web/src/bridge/rewards.ts.
import { unwrapLong, unwrapReal, type JsonValue } from "../wire.ts";
export function toAmountString(value: JsonValue | undefined): string | null {
  // A real reads exactly like the plain number it wraps.
  const amount = unwrapReal(value) ?? value;
  const long = unwrapLong(amount);
  if (long !== null) {
    return long.toString();
  }
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return String(amount);
  }
  if (typeof amount === "string" && /^-?\d+(\.\d+)?$/.test(amount)) {
    return amount;
  }
  return null;
}

function toFloat(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? 0 : Number(long);
}

/** Decode account.GetCashBalance (a plain number, or a long wrapper); null if absent. */
export function decodeCashBalance(result: JsonValue): string | null {
  return toAmountString(result);
}
