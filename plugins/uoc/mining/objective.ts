import { unwrapLong, unwrapReal, type DictEntry, type JsonValue } from "../shared/wire.ts";
import type { JournalState } from "../shared/types.ts";
import {
  miningMissionContent,
  GAS_MISSION_IDS,
  SPECIAL_MINING_MISSION_IDS,
  type MiningMissionContent,
} from "./catalog.ts";
function seqItems(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { type?: unknown; items?: unknown };
    if (
      (candidate.type === "tuple" || candidate.type === "list") &&
      Array.isArray(candidate.items)
    ) {
      return candidate.items as readonly JsonValue[];
    }
  }
  return [];
}

/** Entries of a {type:"dict"} or util.KeyVal wrapper; [] otherwise. */
function dictEntries(value: JsonValue | undefined): readonly DictEntry[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const candidate = value as {
      type?: unknown;
      name?: unknown;
      entries?: unknown;
      args?: unknown;
    };
    if (candidate.type === "dict" && Array.isArray(candidate.entries)) {
      return candidate.entries as readonly DictEntry[];
    }
    if (candidate.type === "object" && candidate.name === "util.KeyVal") {
      return dictEntries(candidate.args as JsonValue);
    }
  }
  return [];
}

/** Read one key from a dict/KeyVal wrapper; undefined when absent. */
function readDict(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const entry = dictEntries(value).find((pair) => Array.isArray(pair) && pair[0] === key);
  return entry ? entry[1] : undefined;
}

/** Decode an integer-ish numeric (plain or long); null when absent/malformed. */
function toNumber(value: JsonValue | undefined): number | null {
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** Decode a possibly-fractional numeric (e.g. cargo volume); null when absent. */
function toFloat(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** Keep an ISK amount / FILETIME as a bigint-safe decimal string; null if absent. */
function toDecimalString(value: JsonValue | undefined): string | null {
  const long = unwrapLong(value);
  return long === null ? null : long.toString();
}

function toBoolOrNull(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** The Mining fetch axis and dungeon axis must agree; courier decoding is unchanged. */
import type { MiningObjectiveRead } from "../shared/missionTypes.ts";
export type { MiningObjective, MiningObjectiveRead } from "../shared/missionTypes.ts";
/** Stock native absence is null/null. Only successful reads AND a known empty
 * strict journal may establish a Request precondition. A failed read is not absence. */
export function decodeMiningMissionRead(
  reads: {
    briefing: JsonValue;
    objective: JsonValue;
    errors: { briefing: string | null; objective: string | null };
  },
  journal: JournalState | null,
  characterID: number,
  agentID: number,
): MiningObjectiveRead {
  if (reads.errors.briefing !== null || reads.errors.objective !== null || journal === null)
    return { objective: null, reason: "MINING_AUTHORITY_UNREADABLE" };
  if (
    reads.briefing === null &&
    reads.objective === null &&
    journal.active.length === 0 &&
    journal.offered.length === 0
  )
    return { objective: null, reason: "NO_MISSION" };
  return decodeMiningObjective(reads.briefing, reads.objective, characterID, agentID);
}

export function decodeMiningObjective(
  briefing: JsonValue,
  result: JsonValue,
  characterID: number,
  agentID: number,
): MiningObjectiveRead {
  const bad = (reason: string): MiningObjectiveRead => ({ objective: null, reason });
  const positive = (n: number | null): n is number =>
    n !== null && Number.isSafeInteger(n) && n > 0;
  const contentID = toNumber(readDict(result, "contentID"));
  if (
    readDict(result, "contentID") === null &&
    readDict(result, "missionState") === null &&
    ["objectives", "dungeons"].every(
      (k) => sequenceKnown(readDict(result, k)) && seqItems(readDict(result, k)).length === 0,
    )
  )
    return bad("NO_MISSION");
  if (contentID !== null && GAS_MISSION_IDS.includes(contentID))
    return bad("GAS_UNSUPPORTED: Gas Mining Missions are not supported by this capability yet.");
  if (contentID !== null && SPECIAL_MINING_MISSION_IDS.includes(contentID))
    return bad(
      "SPECIAL_CONTENT_UNSUPPORTED: This mission belongs to special or multipart content.",
    );
  const content = contentID === null ? null : miningMissionContent(contentID);
  if (!content)
    return bad(
      "UNSUPPORTED_MISSION_CONTENT: This offer is outside the source-qualified ordinary ore missions.",
    );
  const objectives = seqItems(readDict(result, "objectives")).map(seqItems);
  const fetch =
    objectives.length === 1 && objectives[0]?.[0] === "fetch" ? seqItems(objectives[0][1]) : [];
  const dungeons = seqItems(readDict(result, "dungeons"));
  const dungeon = dungeons.length === 1 ? dungeons[0] : undefined;
  const location = readDict(dungeon, "location");
  const coords = seqItems(readDict(location, "coords")).map((v) => unwrapReal(v) ?? toFloat(v));
  const typeID = toNumber(readDict(fetch[2], "typeID"));
  const quantity = toNumber(readDict(fetch[2], "quantity"));
  const volume = toFloat(readDict(fetch[2], "volume"));
  const systemID = toNumber(readDict(location, "solarsystemID"));
  const stationID = toNumber(readDict(fetch[1], "locationID"));
  const stationSystemID = toNumber(readDict(fetch[1], "solarsystemID"));
  const state = toNumber(readDict(result, "missionState"));
  const completionStatus = toNumber(readDict(result, "completionStatus"));
  const accepted = toDecimalString(readDict(briefing, "AcceptTimestamp"));
  if (
    !positive(characterID) ||
    !positive(agentID) ||
    fetch.length !== 3 ||
    toNumber(readDict(result, "importantStandings")) !== 0 ||
    !sequenceKnown(readDict(result, "agentGift")) ||
    seqItems(readDict(result, "agentGift")).length !== 0 ||
    readDict(dungeon, "optional") !== false ||
    typeID !== content.typeID ||
    quantity !== content.quantity ||
    volume === null ||
    volume <= 0 ||
    toNumber(readDict(dungeon, "dungeonID")) !== content.dungeonID ||
    toNumber(readDict(location, "agentID")) !== agentID ||
    readDict(location, "locationType") !== "dungeon" ||
    !positive(systemID) ||
    toNumber(readDict(location, "locationID")) !== systemID ||
    !positive(stationID) ||
    !positive(stationSystemID) ||
    toNumber(readDict(location, "locationNumber")) !== 0 ||
    Math.abs(volume / content.quantity - content.unitVolume) > 1e-9 ||
    coords.length !== 3 ||
    coords.some((n) => n === null || !Number.isFinite(n)) ||
    (state !== 1 && state !== 2) ||
    (completionStatus !== 0 && completionStatus !== 1) ||
    (state === 2 && (accepted === null || !/^[1-9]\d*$/.test(accepted)))
  )
    return bad(
      "MALFORMED_MINING_OBJECTIVE: Mission identity, resource, quantity or location could not be verified.",
    );
  return {
    reason: null,
    objective: {
      kind: "mining",
      characterID,
      agentID,
      content,
      missionState: state,
      acceptTimestamp: state === 2 ? accepted : null,
      systemID,
      stationID,
      stationSystemID,
      position: { x: coords[0]!, y: coords[1]!, z: coords[2]! },
      unitVolume: volume / content.quantity,
      completionStatus,
      locationNumber: 0,
    },
  };
}

function sequenceKnown(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; items?: unknown };
  return (v.type === "tuple" || v.type === "list") && Array.isArray(v.items);
}
