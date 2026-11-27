import { decodeSecurityStatusTransactions } from "./boundCrimewatch.ts";
import { readKeyVal, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

export interface SecurityStatusTransaction {
  readonly eventTypeID: number;
  readonly eventDate: bigint;
  readonly modification: number | null;
  readonly newValue: number;
  readonly otherOwnerID: number | null;
  readonly otherTypeID: number | null;
  readonly locationID: number | null;
}

const SECURITY_STATUS_REASONS: ReadonlyMap<number, readonly [string, string, string]> = new Map([
  [378, ["LawEnforcmentGain", "Law Enforcement - Security Status Gain", "This standing change was granted by CONCORD as an award for actions performed against {name}"]],
  [379, ["CombatAgression", "Combat - Aggression", "This penalty was incurred for attacking {ownerName}'s {[item]typeID.name} in {[location]locationID.name}"]],
  [380, ["SetBySlashCmd", "GM Intervention", "This standing was reset by a GM."]],
  [385, ["HandInTags", "Handed in tags", "This bonus was granted for handing in tags from wanted criminals to CONCORD"]],
  [386, ["SetBySlashCmd", "GM Intervention", "This standing was reset by a GM."]],
] as const);

export function securityStatusReason(eventTypeID: number): readonly [string, string, string] {
  return SECURITY_STATUS_REASONS.get(eventTypeID) ?? ["", "Security status changed", ""];
}

export function decodeSecurityStatusHistory(result: JsonValue): SecurityStatusTransaction[] {
  const id = (row: JsonValue, field: string) => {
    const value = Number(unwrapLong(readKeyVal(row, field) ?? null) ?? 0);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  return decodeSecurityStatusTransactions(result).flatMap(row => {
    const eventTypeID = id(row, "eventTypeID");
    const eventDate = unwrapLong(readKeyVal(row, "eventDate") ?? null);
    const newValue = unwrapReal(readKeyVal(row, "newValue"));
    if (eventTypeID === null || eventDate === null || eventDate <= 0n || newValue === null) return [];
    return [{
      eventTypeID, eventDate, newValue,
      modification: unwrapReal(readKeyVal(row, "modification")),
      otherOwnerID: id(row, "otherOwnerID"),
      otherTypeID: id(row, "otherTypeID"),
      locationID: id(row, "locationID"),
    }];
  });
}
