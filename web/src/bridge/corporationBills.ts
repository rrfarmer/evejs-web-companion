import type { Ask } from "./ask.ts";
import { isListValue, readDictPairs, readKeyVal, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

/** 3698585 billtypes.data names from the installed billTypes resource. */
export const billTypeNameIDs: Readonly<Record<number, number>> = {
  1: 77950, 2: 77951, 3: 77952, 4: 77953, 5: 77954, 6: 77955, 7: 309671,
};

export type CorporationBillsView = "payable" | "receivable" | "automatic";

export interface CorporationBill {
  readonly id: number;
  readonly typeID: number;
  readonly amount: number;
  readonly interest: number;
  readonly debtorID: number;
  readonly creditorID: number;
  readonly due: bigint;
  readonly externalID: number;
  readonly locationID: number;
}

const integer = (value: JsonValue | undefined) => Number(unwrapLong(value) ?? 0n);

function decodeBills(value: JsonValue): readonly CorporationBill[] {
  if (value === null) return [];
  if (!isListValue(value)) throw new Error("The corporation bill list could not be read.");
  return value.items.flatMap(row => {
    const get = (key: string) => readKeyVal(row, key);
    const id = integer(get("billID"));
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [{
      id, typeID: integer(get("billTypeID")), amount: unwrapReal(get("amount")) ?? integer(get("amount")),
      interest: unwrapReal(get("interest")) ?? integer(get("interest")), debtorID: integer(get("debtorID")),
      creditorID: integer(get("creditorID")), due: unwrapLong(get("dueDateTime")) ?? 0n,
      externalID: integer(get("externalID")), locationID: integer(get("externalID2")),
    }];
  });
}

function automaticBills(value: JsonValue): ReadonlyMap<number, ReadonlySet<number>> {
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "dict") {
    throw new Error("Automatic bill payment settings could not be read.");
  }
  return new Map(readDictPairs(value).map(([owner, flags]) => [
    integer(owner), new Set(readDictPairs(flags)
      .filter(([key, flag]) => integer(key) > 0 && (flag === true || integer(flag) === 1))
      .map(([key]) => integer(key))),
  ]));
}

export async function readCorporationBills(ask: Ask, view: CorporationBillsView, allianceID: number | null | undefined): Promise<readonly CorporationBill[]> {
  const receivable = view === "receivable";
  const [corporation, alliance, settings] = await Promise.all([
    ask("billMgr", receivable ? "GetCorporationBillsReceivable" : "GetCorporationBills", []),
    allianceID == null ? null : ask("allianceRegistry", receivable ? "GetBillsReceivable" : "GetBills", []),
    receivable ? null : ask("billMgr", "GetAutomaticPaySettings", []),
  ]);
  const rows = [...decodeBills(alliance), ...decodeBills(corporation)];
  if (receivable) return rows;
  const automatic = automaticBills(settings);
  return rows.filter(row => (automatic.get(row.debtorID)?.has(row.typeID) ?? false) === (view === "automatic"));
}
