import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readRowField, unwrapLong, type JsonValue } from "./wire.ts";

export interface AccessGroupAuditRow {
  readonly actionID: number;
  readonly characterID: number;
  readonly ownerID: number | null;
  readonly oldMembershipType: number | null;
  readonly newMembershipType: number | null;
  readonly oldText: string | null;
  readonly newText: string | null;
  readonly dateMs: number | null;
}

export function decodeAccessGroupAudit(result: JsonValue): AccessGroupAuditRow[] {
  const items = isListValue(result) ? result.items : Array.isArray(result) ? result : [];
  return items.flatMap(row => {
    const int = (key: string) => {
      const raw = readRowField(row, key);
      const value = typeof raw === "number" ? raw : Number(unwrapLong(raw) ?? NaN);
      return Number.isSafeInteger(value) ? value : null;
    };
    const text = (key: string) => {
      const raw = readRowField(row, key);
      if (typeof raw === "string") return raw;
      if (raw && typeof raw === "object" && "value" in raw && typeof raw.value === "string") return raw.value;
      return null;
    };
    const actionID = int("actionID"), characterID = int("characterID");
    if (actionID === null || characterID === null) return [];
    const stamp = unwrapLong(readRowField(row, "logDate"));
    return [{ actionID, characterID, ownerID: int("ownerID"), oldMembershipType: int("oldMembershipType"),
      newMembershipType: int("newMembershipType"), oldText: text("oldText"), newText: text("newText"),
      dateMs: filetimeToUnixMs(stamp === null ? null : BigInt(stamp)) }];
  });
}
