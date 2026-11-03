// The PI Manager's read, decoded (R108 slice 3): GET /api/roster/planets.
//
// Several pilots' colonies in one answer, NONE of them selected — the route
// reads each through the gateway's ownership check alone. Each pilot is decoded
// exactly as the single-pilot colony read is (planets.ts), so the board and the
// Planets panel can never disagree about what a colony says.
//
// ---------------------------------------------------------------------------
// A MERGED VIEW IS NOT ONE MOMENT.
//
// Every pilot carries `readAtMs`, the server's instant when THAT pilot was
// read. It is kept per pilot from the first slice on purpose: nothing else in
// the app has a read-at, and a board that lost it here could only ever present
// several readings as if they were one.
//
// The CLOCK correction is a different thing and comes from the envelope's
// `serverNowMs`, sampled as the answer left, so it is the same for every pilot.
//
// ---------------------------------------------------------------------------
// NOT ANSWERED IS NOT EMPTY.
//
// The route leaves out a pilot it could not read (not this account's, not
// there, or the gateway stumbled). `unansweredPilots` names them, so the board
// can say "could not be read just now" for that pilot while keeping whatever it
// read before — never "has not built".

import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import type { ColonyReport } from "../../../web/src/plugin-api/index.ts";
import { decodeColonyReport } from "../../../web/src/plugin-api/index.ts";
import { decodeStockStack, type PilotStockStack } from "../../../web/src/plugin-api/index.ts";

export interface PilotColonyReading {
  readonly characterID: number;
  /** When this pilot's colonies were read, on the server's clock. Null if unstated. */
  readonly readAtMs: number | null;
  readonly report: ColonyReport;
  /**
   * The pilot's planetary goods outside its colonies (R108 slice 5), read in the
   * same snapshot. Absent or null when the entry carried no stock at all — a reading
   * stored before the route sent it — which is "not read", never "holds none".
   */
  readonly stock?: readonly PilotStockStack[] | null;
  /** The pilot's corporation, whose hangars it could read online. Absent or null: unknown. */
  readonly corporationID?: number | null;
  /**
   * The two skills that bound its colonies, trained levels. Absent or null
   * when the skill sheet was not read: unknown, never "untrained".
   */
  readonly planetSkills?: PlanetSkills | null;
}

export interface PlanetSkills {
  /** Interplanetary Consolidation: one colony, plus one a level. */
  readonly consolidation: number;
  /** Command Center Upgrades: the highest level its command centres reach. */
  readonly commandCenterUpgrades: number;
}

function decodePlanetSkills(value: JsonValue | undefined): PlanetSkills | null {
  const record = asRecord(value);
  const level = (raw: JsonValue | undefined): number | null => {
    const numeric = Number(raw);
    return raw !== null && raw !== undefined && Number.isInteger(numeric) && numeric >= 0 && numeric <= 5 ? numeric : null;
  };
  const consolidation = level(record.consolidation);
  const commandCenterUpgrades = level(record.commandCenterUpgrades);
  return consolidation === null || commandCenterUpgrades === null ? null : { consolidation, commandCenterUpgrades };
}

/** Null when the entry carried no stock list at all; see PilotColonyReading. */
function decodeStock(value: JsonValue | undefined): readonly PilotStockStack[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map(decodeStockStack).filter((stack): stack is PilotStockStack => stack !== null);
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/** An instant, or null. Never coerced to 0 (the epoch is not a reading). */
function asInstant(value: JsonValue | undefined): number | null {
  const numeric = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numeric) && numeric > 0
    ? numeric
    : null;
}

/**
 * Decode GET /api/roster/planets.
 *
 * `browserNowMs` is the browser's clock as the answer landed; every pilot's
 * report is corrected against the envelope's one server sample.
 */
export function decodeRosterColonies(
  value: JsonValue,
  browserNowMs: number,
): readonly PilotColonyReading[] {
  const record = asRecord(value);
  const serverNowMs = record.serverNowMs ?? null;
  const pilots = Array.isArray(record.pilots) ? record.pilots : [];
  const seen = new Set<number>();
  const readings: PilotColonyReading[] = [];
  for (const entry of pilots) {
    const pilot = asRecord(entry);
    const characterID = Number(pilot.characterID);
    if (!Number.isSafeInteger(characterID) || characterID <= 0 || seen.has(characterID)) {
      continue;
    }
    seen.add(characterID);
    readings.push({
      characterID,
      readAtMs: asInstant(pilot.readAtMs),
      report: decodeColonyReport({ ...pilot, serverNowMs }, browserNowMs),
      stock: decodeStock(pilot.stock),
      corporationID: Number.isSafeInteger(Number(pilot.corporationID)) && Number(pilot.corporationID) > 0
        ? Number(pilot.corporationID)
        : null,
      planetSkills: decodePlanetSkills(pilot.planetSkills),
    });
  }
  return readings;
}

/** The pilots asked about that the answer left out, in the order asked. */
export function unansweredPilots(
  askedCharacterIDs: readonly number[],
  readings: readonly PilotColonyReading[],
): readonly number[] {
  const answered = new Set(readings.map((reading) => reading.characterID));
  return askedCharacterIDs.filter((characterID) => !answered.has(characterID));
}
