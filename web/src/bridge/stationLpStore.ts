import { isListValue, readRowField, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

type ItemAmount = { readonly typeID: number; readonly quantity: number };
export interface StationLpOffer {
  readonly id: number;
  readonly reward: ItemAmount;
  readonly isk: number;
  readonly lp: number;
  readonly ak: number;
  readonly requires: readonly ItemAmount[];
  readonly otherRewards: readonly ItemAmount[];
  readonly standing: JsonValue;
}

export interface StationLpStore {
  readonly offers: readonly StationLpOffer[];
  readonly lp: string;
  readonly concordLp: number;
  readonly isk: number | null;
}

function integer(value: unknown): number | null {
  const result = unwrapLong(value);
  const n = result === null ? NaN : Number(result);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function itemAmounts(value: JsonValue | undefined): readonly ItemAmount[] | null {
  if (!isListValue(value)) return null;
  const amounts: ItemAmount[] = [];
  for (const row of value.items) {
    const pair = isListValue(row) ? row.items : Array.isArray(row) ? row : [];
    const typeID = integer(pair[0]), quantity = integer(pair[1]);
    if (!typeID || !quantity || pair.length !== 2) return null;
    amounts.push({ typeID, quantity });
  }
  return amounts;
}

export function decodeStationLpOffers(answer: JsonValue, issuerID: number): readonly StationLpOffer[] {
  if (!isListValue(answer)) throw new Error("The Loyalty Point Store catalog could not be read.");
  return answer.items.flatMap(row => {
    const id = integer(readRowField(row, "offerID"));
    const typeID = integer(readRowField(row, "typeID")), quantity = integer(readRowField(row, "qty"));
    const lp = integer(readRowField(row, "lpCost")), ak = integer(readRowField(row, "akCost"));
    const isk = unwrapReal(readRowField(row, "iskCost"));
    const requires = itemAmounts(readRowField(row, "reqItems"));
    const otherRewards = itemAmounts(readRowField(row, "lootItems"));
    if (integer(readRowField(row, "corpID")) !== issuerID || !id || !typeID || !quantity ||
        lp === null || ak === null || isk === null || isk < 0 || !requires || !otherRewards) return [];
    return [{ id, reward: { typeID, quantity }, lp, ak, isk, requires, otherRewards, standing: readRowField(row, "requiredStandings") ?? null }];
  });
}
