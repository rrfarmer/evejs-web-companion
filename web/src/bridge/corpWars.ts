// A corporation's or alliance's wars, as the war service and warsInfoMgr answer them: warRegistry.GetWars(ownerID)
// a dict of warID -> war (KeyVal / row), warsInfoMgr.GetTop50(maxWarID) and GetWarsRequiringAssistance a CRowset of
// rows (warID, declaredByID, againstID, timeDeclared, timeFinished, retracted, retractedBy, timeStarted, billID,
// mutual, createdFromWarID, openForAllies, canBeRetracted, reasonEnded, warHQ, noOfAllies, reasonStarted).
import { isListValue, readDictPairs, unwrapLong, type JsonValue } from "./wire.ts";
import { memberField } from "./corporationMemberDetails.ts";

export interface CorpWar {
  readonly warID: number;
  readonly declaredByID: number;
  readonly againstID: number;
  readonly timeDeclared: bigint | null;
  readonly timeStarted: bigint | null;
  readonly timeFinished: bigint | null;
  readonly mutual: boolean;
  readonly openForAllies: boolean;
  /** The allies' owners (a GetWars war's allies dict); none for a warsInfoMgr row. */
  readonly allyIDs: readonly number[];
}

const long = (v: JsonValue | undefined): bigint | null => (typeof v === "number" ? BigInt(Math.trunc(v)) : unwrapLong(v));
const flag = (v: JsonValue | undefined) => v === true || (typeof v === "number" && v !== 0) || (long(v) ?? 0n) !== 0n;

function rowsOf(answer: JsonValue | null | undefined): readonly JsonValue[] {
  if (answer === null || answer === undefined) return [];
  if (isListValue(answer)) return answer.items;
  if (Array.isArray(answer)) return answer;
  const record = answer as { type?: unknown; list?: unknown };
  // a CRowset (objectex2): its rows in list
  if (record && typeof record === "object" && Array.isArray(record.list)) return record.list as JsonValue[];
  return readDictPairs(answer).map(([, war]) => war);
}

export function decodeWars(answer: JsonValue | null | undefined): CorpWar[] {
  return rowsOf(answer).flatMap((row) => {
    const warID = Number(long(memberField(row, "warID")) ?? 0);
    if (!warID) return [];
    const allies = memberField(row, "allies");
    return [{
      warID, declaredByID: Number(long(memberField(row, "declaredByID")) ?? 0), againstID: Number(long(memberField(row, "againstID")) ?? 0),
      timeDeclared: long(memberField(row, "timeDeclared")), timeStarted: long(memberField(row, "timeStarted")), timeFinished: long(memberField(row, "timeFinished")),
      mutual: flag(memberField(row, "mutual")), openForAllies: flag(memberField(row, "openForAllies")),
      allyIDs: allies === undefined || allies === null ? [] : readDictPairs(allies).map(([k]) => Number(typeof k === "number" ? k : long(k as JsonValue) ?? 0)).filter((id) => id > 0),
    }];
  });
}
