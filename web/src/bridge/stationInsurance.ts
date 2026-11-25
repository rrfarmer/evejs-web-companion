import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readDictPairs, readRowField, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

export interface StationInsuranceShip {
  readonly itemID: number;
  readonly typeID: number;
  readonly insuredValue: number;
  readonly contract: { readonly id: number; readonly fraction: number; readonly startsAt: number | null; readonly expiresAt: number | null } | null;
}

// insuranceConst.py in build 3698585. The price returned by EveJS is the full insurance value.
export const INSURANCE_PACKAGES = ["Basic", "Standard", "Bronze", "Silver", "Gold", "Platinum"] as const;
export type InsurancePackage = typeof INSURANCE_PACKAGES[number];

export function insuranceTerms(value: number, tier: InsurancePackage) {
  const index = INSURANCE_PACKAGES.indexOf(tier);
  if (index === -1 || !Number.isFinite(value) || value <= 0) return null;
  const fraction = (index + 5) / 10;
  const valueCents = Math.round(value * 100);
  return {
    fraction,
    premium: Math.round(valueCents * ((fraction - 0.4) * 0.5)) / 100,
    payout: Math.round(valueCents * fraction) / 100,
  };
}

export function insurancePrices(answer: JsonValue): ReadonlyMap<number, number> {
  if (typeof answer !== "object" || answer === null || !("type" in answer) ||
      answer.type !== "dict" || !("entries" in answer) || !Array.isArray(answer.entries)) {
    throw new Error("Insurance prices could not be read.");
  }
  const prices = new Map<number, number>();
  for (const [key, raw] of readDictPairs(answer)) {
    const price = unwrapReal(raw);
    if (price !== null && price > 0) prices.set(Number(key), price);
  }
  return prices;
}

export function stationInsuranceContracts(answer: JsonValue): ReadonlyMap<number, NonNullable<StationInsuranceShip["contract"]>> {
  if (!isListValue(answer)) throw new Error("Insurance contracts could not be read.");
  return new Map(answer.items.map(row => {
    const shipID = Number(unwrapLong(readRowField(row, "shipID")));
    const id = Number(unwrapLong(readRowField(row, "contractID")));
    const fraction = unwrapReal(readRowField(row, "fraction"));
    if (!Number.isSafeInteger(shipID) || shipID <= 0 || !Number.isSafeInteger(id) || id <= 0 || fraction === null) {
      throw new Error("An insurance contract could not be read.");
    }
    return [shipID, {
      id, fraction,
      startsAt: filetimeToUnixMs(unwrapLong(readRowField(row, "startDate"))),
      expiresAt: filetimeToUnixMs(unwrapLong(readRowField(row, "endDate"))),
    }];
  }));
}
