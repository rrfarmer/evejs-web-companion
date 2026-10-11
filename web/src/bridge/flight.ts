// Flight status decoder (goal R5a, "how to add a page"). The manually-stepped
// space flow runs on the BFF (which holds the beyonce bound park handle) and
// the gateway returns the flight-status snapshot here; this module decodes it
// into a plain FlightStatus row for the store.
//
// Decoder rule (docs/bridge-wire-contract.md): numeric IDs are decoded with
// unwrapLong — never the `typeof === "number" ? … : 0` pattern, which silently
// zeroes a {type:"long"} wrapper. The gateway emits plain numbers today, but a
// forwarded OnSessionChanged carries long-encoded location IDs, so the decoder
// tolerates both. System / station / ship IDs fit in 2^53 and are kept as
// `number`.

import { unwrapLong, type JsonValue } from "./wire.ts";
import type {
  FlightStatus,
  FlightTransition,
  FlightTransitionKind,
  FlightTransitionPhase,
} from "../store/types.ts";

const TRANSITION_KINDS = new Set<FlightTransitionKind>([
  "idle",
  "undock",
  "dock",
  "stargate",
  "board",
  "clone",
  "other-session",
]);
const TRANSITION_PHASES = new Set<FlightTransitionPhase>([
  "requested",
  "accepted",
  "session-changing",
  "ready",
  "failed",
]);

/** A location/ship ID as a plain number (long-aware), or null. */
function idOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

/** A finite float (e.g. a speed fraction), or null. */
function floatOrNull(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function transitionOrUndefined(value: JsonValue | undefined): FlightTransition | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, JsonValue>;
  const kind = typeof row.kind === "string" && TRANSITION_KINDS.has(row.kind as FlightTransitionKind)
    ? (row.kind as FlightTransitionKind)
    : "idle";
  const phase = typeof row.phase === "string" && TRANSITION_PHASES.has(row.phase as FlightTransitionPhase)
    ? (row.phase as FlightTransitionPhase)
    : "ready";
  return {
    epoch: Math.max(0, Number(row.epoch) || 0),
    kind,
    phase,
    startedAtMs: floatOrNull(row.startedAtMs),
    cooldownUntilMs: floatOrNull(row.cooldownUntilMs),
    fromSolarSystemID: idOrNull(row.fromSolarSystemID),
    toSolarSystemID: idOrNull(row.toSolarSystemID),
    stationID: idOrNull(row.stationID),
    shipID: idOrNull(row.shipID),
    sessionStable: row.sessionStable === true,
    locationReady: row.locationReady === true,
    sceneReady: row.sceneReady === true,
    egoReady: row.egoReady === true,
    shipReady: row.shipReady === true,
    boundContextReady: row.boundContextReady === true,
    failure: typeof row.failure === "string" ? row.failure : null,
  };
}

export function decodeFlightStatus(raw: JsonValue | undefined): FlightStatus {
  const flight =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, JsonValue>)
      : {};
  const inSpace = flight.inSpace === true;
  const stationID = idOrNull(flight.stationID);
  const structureID = idOrNull(flight.structureID);
  return {
    inSpace,
    // Trust the gateway's explicit `docked`, but fall back to a sound
    // derivation (out of space and at a station/structure) if it is absent.
    docked:
      typeof flight.docked === "boolean"
        ? flight.docked
        : !inSpace && (stationID !== null || structureID !== null),
    solarSystemID: idOrNull(flight.solarSystemID),
    stationID,
    structureID,
    shipID: idOrNull(flight.shipID),
    shipTypeID: idOrNull(flight.shipTypeID),
    shipGroupID: idOrNull(flight.shipGroupID),
    // Tri-state on purpose: an older BFF omits the field, and "we were not told"
    // must not read as "not a capsule" — that would be a confident empty, which
    // is the failure this file avoids everywhere else.
    shipIsCapsule:
      typeof flight.shipIsCapsule === "boolean" ? flight.shipIsCapsule : null,
    shipMode: typeof flight.shipMode === "string" ? flight.shipMode : null,
    shipSpeedFraction: floatOrNull(flight.shipSpeedFraction),
    transition: transitionOrUndefined(flight.transition),
  };
}
