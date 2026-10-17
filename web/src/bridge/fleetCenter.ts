// Fleet Center's small interpretation layer over the authoritative bound-fleet
// read and the existing live notification channel. It deliberately keeps the
// three player-relevant states separate:
//   • ready          — GetInitState named a real fleet;
//   • not-in-fleet   — the pilot's own session has no fleet, where the route
//                      knows the session's; or every bound read explicitly
//                      refused as fleetless;
//   • unavailable    — the read failed or was partial in any other way.
// A null fleetID alone is not enough to call somebody fleetless: the cached
// session field is allowed to be stale, and a transport failure also decodes to
// empty values.

import { decodeBoundFleet, type BoundFleet, type BoundFleetResult, type FleetCompositionEntry, type FleetMember } from "./boundFleet.ts";
import { unwrapLong, type JsonValue } from "./wire.ts";
import { argumentsOf } from "./questions.ts";
// ⚠ A VALUE IMPORT INTO A MODULE THAT IMPORTS US BACK, and it is safe because
// the edge going the other way is TYPE-ONLY (`import type { FleetCenterSnapshot }`)
// and is erased before it can become a runtime cycle. Kept this way round
// because `isFleetCommander` is the single mirrored copy of the server's own
// commander gate, and a second copy here is precisely what must not happen.
import { isFleetCommander } from "./fleetCommand.ts";

export type FleetAvailability = "ready" | "not-in-fleet" | "unavailable";

export interface FleetCenterSnapshot {
  readonly availability: FleetAvailability;
  readonly fleet: BoundFleet;
}

export interface FleetPendingInvite {
  readonly fleetID: number;
  readonly inviterID: number | null;
  readonly receivedAtMs: number;
  /** The client's dialog the invitation is asked with (its third argument: AskJoinFleet), and its parameters. */
  readonly dialog?: string;
  readonly parameters?: JsonValue | null;
  /** fleetSvc.OnFleetInvite (1177, 1192): msgDict's autoAccept, with which the client joins without asking. */
  readonly autoAccept?: boolean;
}

function readCells(fleet: BoundFleet): readonly BoundFleetResult<unknown>[] {
  return [fleet.initState, fleet.wings, fleet.motd, fleet.joinRequests, fleet.composition];
}

function positiveFleetID(value: number | string | null): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  }
  return false;
}

// The server's two "you have no fleet" refusals. FleetNotFound comes from the
// fleet runtime when the session's fleetid resolves to nothing; FleetNotInFleet
// comes from fleetObjectHandler's member gate (_resolveFleetIDForMember), which
// the bound reads pass through before the runtime is reached.
const FLEETLESS_REFUSALS: ReadonlySet<string> = new Set(["FleetNotFound", "FleetNotInFleet"]);

/**
 * What a member flies and where it is, as the page shows them. The client keeps neither in a member's record once
 * that record has changed (fleetSvc.OnFleetMemberChanged makes a new one of six fields), and its own window for
 * them asks GetFleetComposition. So the composition's word for the pilot is taken, whole: a pilot it says is in
 * space is not docked where its record last had it. The record's own, as it was when the member joined, is what
 * is left where the composition has no word for that pilot.
 */
export function memberWhereabouts(
  member: FleetMember,
  composition: readonly FleetCompositionEntry[],
): Pick<FleetMember, "shipTypeID" | "stationID" | "solarSystemID"> {
  const said = member.charID === null ? undefined : composition.find((entry) => entry.characterID === member.charID);
  const { shipTypeID, stationID, solarSystemID } = said ?? member;
  return { shipTypeID, stationID, solarSystemID };
}

/** Classify one decoded read without turning an error-shaped empty into fleetless. */
export function fleetAvailability(fleet: BoundFleet): FleetAvailability {
  if (
    fleet.initState.error === null &&
    positiveFleetID(fleet.initState.value.fleetID)
  ) {
    return "ready";
  }
  // The session's own word, where the route has it: the client's fleet service goes by the same.
  if (fleet.sessionHasNoFleet) {
    return "not-in-fleet";
  }
  if (
    !positiveFleetID(fleet.initState.value.fleetID) &&
    readCells(fleet).every(
      (read) =>
        read.error === "CALL_REFUSED" &&
        read.message !== null &&
        FLEETLESS_REFUSALS.has(read.message),
    )
  ) {
    return "not-in-fleet";
  }
  return "unavailable";
}

/** Decode and classify GET /api/bridge/bound-fleet. */
export function decodeFleetCenter(
  raw: JsonValue | null | undefined,
): FleetCenterSnapshot {
  const fleet = decodeBoundFleet(raw);
  return { availability: fleetAvailability(fleet), fleet };
}

/**
 * Character IDs that a bot may treat as fleet-mates for remote assistance.
 * `null` means the roster could not be established and callers must wait; an
 * empty array is the authoritative not-in-fleet answer. Never fall back to the
 * cached session fleet id or to "every player ship on grid".
 */
export function authoritativeFleetMemberCharacterIDs(
  snapshot: FleetCenterSnapshot,
): readonly number[] | null {
  if (snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return Object.freeze([]);
  }
  const ids = new Set<number>();
  for (const member of snapshot.fleet.initState.value.members) {
    const characterID = positiveSafeID(member.charID);
    if (characterID !== null) {
      ids.add(characterID);
    }
  }
  return Object.freeze([...ids]);
}

/**
 * The character ids the roster says are COMMANDERS — fleet creator, boss, wing
 * commander or squad commander.
 *
 * ⚠ THE SAME TEST `canTagInFleet` APPLIES TO ONE ROW, APPLIED TO ALL OF THEM.
 * `isFleetCommander` is the single definition of "commander" in this client, and
 * it is mirrored from the server's own gate. Two questions are answered from it:
 * "may I tag" (one row, this pilot) and "whose chat orders do I obey" (every
 * row). Inventing a second idea of authority for the second question is exactly
 * how the two would drift.
 *
 * ⚠ `null` IS "COULD NOT READ THE ROSTER" AND MUST NOT COLLAPSE TO EMPTY. A
 * companion takes chat orders from this list and from nobody else, so an
 * unreadable roster has to mean "obey nobody" rather than "obey anybody" — and
 * an empty array is a real, different answer: a fleet with no commander in it.
 *
 * Ids that do not decode to a safe positive integer are dropped, the same rule
 * `authoritativeFleetMemberCharacterIDs` above applies, because an id we cannot
 * represent exactly is one we cannot compare a chat sender against.
 */
export function fleetCommanderCharacterIDs(
  snapshot: FleetCenterSnapshot,
): readonly number[] | null {
  if (snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return Object.freeze([]);
  }
  const ids = new Set<number>();
  for (const member of snapshot.fleet.initState.value.members) {
    if (!isFleetCommander(member)) {
      continue;
    }
    const characterID = positiveSafeID(member.charID);
    if (characterID !== null) {
      ids.add(characterID);
    }
  }
  return Object.freeze([...ids]);
}

/** Where one commander is: its system, and its station (null in space). Null fields are ones the roster did not say. */
export interface FleetCommanderWhereabouts {
  readonly characterID: number;
  readonly solarSystemID: number | null;
  readonly stationID: number | null;
}

/**
 * Where each COMMANDER is, by the same rows `fleetCommanderCharacterIDs` reads and the same word for a member's
 * place the panel uses (`memberWhereabouts`), so a companion that has lost its commander's grid can tell a
 * commander in space in its own system from one docked or elsewhere. `null` for an unreadable roster, as there.
 */
export function fleetCommanderWhereabouts(
  snapshot: FleetCenterSnapshot,
): readonly FleetCommanderWhereabouts[] | null {
  if (snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return Object.freeze([]);
  }
  const found: FleetCommanderWhereabouts[] = [];
  for (const member of snapshot.fleet.initState.value.members) {
    const characterID = positiveSafeID(member.charID);
    if (characterID === null || !isFleetCommander(member) || found.some((entry) => entry.characterID === characterID)) {
      continue;
    }
    const where = memberWhereabouts(member, snapshot.fleet.composition.value);
    found.push({
      characterID,
      solarSystemID: positiveSafeID(where.solarSystemID),
      stationID: positiveSafeID(where.stationID),
    });
  }
  return Object.freeze(found);
}

function positiveSafeID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  if (
    unwrapped !== null &&
    unwrapped > 0n &&
    unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(unwrapped);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }
  return null;
}

/**
 * Read the existing OnFleetInvite popup payload:
 *   [fleetID, inviterCharacterID, "AskJoinFleet", inviteData]
 * as Tranquility sends it: (1198512288650L, 2119942208, 'AskJoinFleet', {'autoAccept': False, 'name': (2,
 * 2119942208)}). The two IDs, the dialog the client asks with and its parameters, and the dict's autoAccept.
 */
export function decodeFleetInviteNotification(
  method: string | null,
  args: readonly unknown[],
  receivedAtMs: number,
): FleetPendingInvite | null {
  if (method !== "OnFleetInvite") {
    return null;
  }
  const fleetID = positiveSafeID(args[0]);
  if (fleetID === null) {
    return null;
  }
  const parameters = (args[3] ?? null) as JsonValue | null;
  return {
    fleetID,
    inviterID: positiveSafeID(args[1]),
    receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : Date.now(),
    dialog: typeof args[2] === "string" && args[2] !== "" ? args[2] : "AskJoinFleet",
    parameters,
    autoAccept: argumentsOf(parameters).autoAccept === true,
  };
}

// --- The inviter told (fleetSvc.OnFleetJoinReject) ---------------------------

/** Why an invitation was turned down, as the server says where it says: one of the client's two reasons, or none. */
export type FleetInviteAnswerReason = "none" | "no-response" | "in-a-fleet";

export interface FleetInviteAnswer {
  readonly characterID: number;
  readonly reason: FleetInviteAnswerReason;
}

/**
 * Read what the inviter is told when its invitation is turned down:
 *   OnFleetJoinReject [memberID, reasonCode]
 * The client (fleetSvc.OnFleetJoinReject, 1217) says so to its pilot and asks nothing: with a reason where the
 * code is one of the two it knows (evefleet: 1, no response; 2, already in a fleet), and plainly for any other
 * code or for none. No Tranquility recording has the notice.
 */
export function decodeFleetInviteAnswerNotification(method: string | null, args: readonly unknown[]): FleetInviteAnswer | null {
  if (method !== "OnFleetJoinReject") {
    return null;
  }
  const characterID = positiveSafeID(args[0]);
  if (characterID === null) {
    return null;
  }
  const code = unwrapLong(args[1]);
  return { characterID, reason: code === 1n ? "no-response" : code === 2n ? "in-a-fleet" : "none" };
}

/**
 * The page's own words for it, put up where the install's are not to hand: the client puts up its labels
 * (fleetSvc.OnFleetJoinReject, 1217 to 1223; the flow's tellOfInviteAnswer). `name` is the pilot's, where it could
 * be had.
 */
export function fleetInviteAnswerWords(name: string | null, reason: FleetInviteAnswerReason): string {
  const who = name !== null && name.trim() !== "" ? name.trim() : "The pilot you invited";
  if (reason === "no-response") {
    return `${who} did not answer your fleet invitation.`;
  }
  if (reason === "in-a-fleet") {
    return `${who} is already in a fleet, so your invitation was turned down.`;
  }
  return `${who} turned down your fleet invitation.`;
}
