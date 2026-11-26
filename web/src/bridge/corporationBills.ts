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
  readonly paid: boolean;
}

export interface AutomaticBillSettings {
  readonly ownerID: number;
  readonly division: number;
  readonly flags: ReadonlyMap<number, boolean>;
}

const integer = (value: JsonValue | undefined) => Number(unwrapLong(value) ?? 0n);
const enabled = (value: JsonValue | undefined) => value === true || integer(value) === 1;

export function canPayCorporationBills(role: string | null | undefined): boolean {
  try { return (BigInt(role ?? "0") & 256n) !== 0n; }
  catch { return false; }
}

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
      paid: enabled(get("paid")),
    }];
  });
}

function automaticBills(value: JsonValue): readonly AutomaticBillSettings[] {
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "dict") {
    throw new Error("Automatic bill payment settings could not be read.");
  }
  return readDictPairs(value).map(([owner, flags]) => {
    const entries = readDictPairs(flags);
    return { ownerID: integer(owner), division: integer(entries.find(([key]) => key === "divisionID")?.[1]) || 1000,
      flags: new Map(entries.filter(([key]) => integer(key) > 0).map(([key, value]) => [integer(key), enabled(value)])) };
  });
}

export async function readAutomaticBillSettings(ask: Ask): Promise<readonly AutomaticBillSettings[]> {
  return automaticBills(await ask("billMgr", "GetAutomaticPaySettings", []));
}

export function automaticBillSettingsWire(settings: readonly AutomaticBillSettings[]): JsonValue {
  return { type: "dict", entries: settings.map(row => [row.ownerID,
    { type: "dict", entries: [["divisionID", row.division], ...row.flags] }]) };
}

export async function readCorporationBills(ask: Ask, view: CorporationBillsView, allianceID: number | null | undefined): Promise<readonly CorporationBill[]> {
  const receivable = view === "receivable";
  const [corporation, alliance, settings] = await Promise.all([
    ask("billMgr", receivable ? "GetCorporationBillsReceivable" : "GetCorporationBills", []),
    allianceID == null ? null : ask("allianceRegistry", receivable ? "GetBillsReceivable" : "GetBills", []),
    receivable ? [] : readAutomaticBillSettings(ask),
  ]);
  const rows = [...decodeBills(alliance), ...decodeBills(corporation)];
  if (receivable) return rows;
  const automatic = new Map(settings.map(row => [row.ownerID, row.flags]));
  return rows.filter(row => (automatic.get(row.debtorID)?.get(row.typeID) ?? false) === (view === "automatic"));
}
