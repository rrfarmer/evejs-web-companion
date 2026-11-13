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
  readonly retracted: bigint | null;
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
      timeDeclared: long(memberField(row, "timeDeclared")), timeStarted: long(memberField(row, "timeStarted")), timeFinished: long(memberField(row, "timeFinished")), retracted: long(memberField(row, "retracted")),
      mutual: flag(memberField(row, "mutual")), openForAllies: flag(memberField(row, "openForAllies")),
      allyIDs: allies === undefined || allies === null ? [] : readDictPairs(allies).map(([k]) => Number(typeof k === "number" ? k : long(k as JsonValue) ?? 0)).filter((id) => id > 0),
    }];
  });
}

/** evewar/warText.GetWarTextList: the war's date line, as label + values; a date as [FILETIME, FmtDate format]. */
export type WarTextPart = readonly [label: string, values: Readonly<Record<string, readonly [bigint, string] | string>>];
export function warTextList(war: CorpWar, now: bigint, dayOf: (t: bigint) => string): WarTextPart[] {
  const { timeFinished, retracted } = war, timeStarted = war.timeStarted ?? 0n;
  const declareDate: readonly [bigint, string] | string = war.timeDeclared ? [war.timeDeclared, "sn"] : "UI/Common/Unknown";
  let fightDate: readonly [bigint, string] | string = timeStarted ? [timeStarted, "sn"] : "UI/Common/Unknown";
  const out: WarTextPart[] = [];
  if (now <= timeStarted && (timeFinished === null || now < timeFinished)) {
    // a war not yet fighting: today's start as a time, another day's with its date
    fightDate = [timeStarted, dayOf(timeStarted) === dayOf(now) ? "ns" : "ss"];
    out.push(["UI/Corporations/Wars/WarStartedCanFight", { date: declareDate, time: fightDate }]);
    if (timeFinished) out.push(["UI/Corporations/Wars/WarEndsAt", { timeFinished: [timeFinished, "ss"] }]);
  } else if (timeFinished) {
    if (now < timeFinished) out.push(["UI/Corporations/Wars/WarStartedEndsAt", { date: fightDate, time: [timeFinished, dayOf(timeFinished) === dayOf(now) ? "ns" : "ss"] }]);
    else if (timeFinished > timeStarted) out.push(["UI/Corporations/Wars/WarStartedAndFinished", { startDate: fightDate, finishDate: [timeFinished, "sn"] }]);
    else out.push(["UI/Corporations/Wars/WarStartedAndRetracted", { startDate: declareDate, retractDate: [timeFinished, "sn"] }]);
  } else if (retracted !== null) {
    out.push(["UI/Corporations/Wars/WarStartedAndRetracted", { startDate: fightDate, retractDate: [retracted, "sn"] }]);
  } else if (timeStarted) {
    out.push(["UI/Corporations/Wars/WarStarted", { date: fightDate }]);
  }
  return out;
}
