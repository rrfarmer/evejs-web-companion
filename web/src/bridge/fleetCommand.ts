// Client-side gates: "may THIS pilot set a fleet target tag?" and, when the
// answer is no, "may it call the ship out the other way?" (`canBroadcastInFleet`
// at the foot of this file — every member may, and that asymmetry is the reason
// a bot is never actually mute about what has it tackled).
//
// WHY THIS HAS TO LIVE HERE: the server's own gate
// (fleetRuntime.js:setFleetTargetTag, read at fleetRuntime.js:1310-1326) DOES
// check commander-ness and returns a plain `false` when the writer is not
// allowed. But its only caller, beyonceService.js's
// Handle_CmdFleetTagTarget (beyonceService.js:3314-3322), throws that boolean
// away and unconditionally `return null`s. The HTTP/RPC response a client
// sees is therefore byte-identical whether the tag landed or was silently
// dropped — nothing downstream of the call can ever tell the two apart. The
// only place left to ask "will this write actually do anything" is before
// the call, off the roster the client already has. That is this module.
//
// The constants below are mirrored from fleetConstants.js (verified there,
// not taken on trust — see the ⚠ on FLEET_JOB_CREATOR) and the gate itself
// mirrors fleetRuntime.js's `setFleetTargetTag`, De Morgan'd from its
// early-return-false form into an early-return-allow form. Kept in its own
// module, pure, no `flow.ts`/store/I-O — same shape as fleetBroadcasts.ts.

import type { FleetCenterSnapshot } from "./fleetCenter.ts";
import type { FleetMember } from "./boundFleet.ts";

// --- constants, mirrored from the server --------------------------------

/**
 * fleetConstants.js:4 — `FLEET_JOB_CREATOR: 2`.
 *
 * ⚠ THE TRAP: `FLEET_JOB_SCOUT` is ALSO 1 (fleetConstants.js:3), and
 * `FLEET_ROLE_LEADER` is ALSO 1 (fleetConstants.js:5) — two different enums
 * that both happen to start at 1. `job` and `role` are unrelated fields on a
 * member record (see FleetMember in boundFleet.ts): `job` is a bitmask of
 * fleet-administrative capabilities (none/scout/creator), `role` is the
 * fleet-hierarchy seat (leader/wing-cmdr/squad-cmdr/member). If
 * FLEET_JOB_CREATOR were ever "simplified" to 1, scouts (job=1) would gain
 * tagging and the actual fleet creator (job=2) would lose it. A previous
 * draft of this module got exactly this wrong, twice. Do not touch this
 * value without re-reading fleetConstants.js:1-9.
 */
export const FLEET_JOB_CREATOR = 2;

/**
 * fleetConstants.js:9 — `FLEET_CMDR_ROLES: Object.freeze([1, 2, 3])`, i.e.
 * FLEET_ROLE_LEADER, FLEET_ROLE_WING_COMMANDER, FLEET_ROLE_SQUAD_COMMANDER
 * (fleetConstants.js:5-7). FLEET_ROLE_MEMBER (4, fleetConstants.js:8) is
 * deliberately absent — a plain member is not a commander.
 */
export const FLEET_CMDR_ROLES: readonly number[] = [1, 2, 3];

// --- the gate itself, mirrored from the server ---------------------------

/**
 * Whether one fleet member row is allowed to set a fleet target tag, per
 * the server's own gate (fleetRuntime.js:1317-1326):
 *
 *   const member = getMemberRecord(fleet, characterID);
 *   if (
 *     !member ||
 *     (
 *       (member.job & FLEET.FLEET_JOB_CREATOR) === 0 &&
 *       !FLEET.FLEET_CMDR_ROLES.includes(toInteger(member.role, 0))
 *     )
 *   ) {
 *     return false;
 *   }
 *
 * De Morgan'd into an ALLOW condition (the member-exists check is handled
 * by the caller, which has a whole snapshot to reason about — see
 * `canTagInFleet` below):
 *
 *   (member.job & FLEET_JOB_CREATOR) !== 0 || FLEET_CMDR_ROLES.includes(member.role)
 *
 * ⚠ `job` is a BITMASK, tested with `&`, never with `===`. A member can
 * hold multiple job bits at once (FLEET_JOB_NONE=0, FLEET_JOB_SCOUT=1,
 * FLEET_JOB_CREATOR=2 — bit 0 and bit 1), so `member.job === FLEET_JOB_CREATOR`
 * would silently miss a creator who also carries the scout bit.
 */
export function isFleetCommander(member: FleetMember): boolean {
  return (member.job & FLEET_JOB_CREATOR) !== 0 || FLEET_CMDR_ROLES.includes(member.role);
}

// --- the three-state snapshot-level answer --------------------------------

/**
 * Whether THIS character may set a fleet target tag right now — three
 * states, not two, because "do not write" is answered for two entirely
 * different reasons that a caller must not conflate:
 *
 *   - roster UNREADABLE (`availability === "unavailable"`, or no snapshot
 *     at all) -> `null`. The client could not look. This is not evidence of
 *     anything; guessing "no" here would be exactly the kind of silent,
 *     unaccountable failure this module exists to prevent (see the header).
 *   - `availability === "not-in-fleet"` -> `false`. A looked-at, settled
 *     answer: you cannot tag a fleet you are not in, full stop.
 *   - in a fleet, but this character's own row is NOT in the roster ->
 *     `null`. That is an inconsistent read (a member should always see
 *     itself in its own fleet's roster), not evidence of non-command —
 *     treating it as `false` would be guessing again.
 *   - own row found -> `isFleetCommander(row)`, i.e. `true`/`false`.
 *
 * ⚠ `null` and `false` both mean "do not write" to an immediate caller, but
 * only `false` is a PERMANENT, safe-to-remember answer — `null` means "ask
 * again once the roster is readable". A caller that collapses the two (for
 * example caching `!!canTagInFleet(...)` across reads) would freeze a
 * transient outage into a standing "not a commander". That collapse is
 * exactly the bug class this module's three-state return exists to rule
 * out.
 */
export function canTagInFleet(
  snapshot: FleetCenterSnapshot | null | undefined,
  characterID: number,
): boolean | null {
  if (!snapshot || snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return false;
  }
  const member = snapshot.fleet.initState.value.members.find((row) =>
    charIDMatches(row.charID, characterID),
  );
  if (!member) {
    return null;
  }
  return isFleetCommander(member);
}

/**
 * Compares a roster row's `charID` (boundFleet.ts's `idData`: a Number when
 * safe, else an exact decimal string — R7d, ids are data and are never
 * silently truncated) against a plain `characterID` Number, the shape the
 * rest of this codebase already passes an own/target character id in (see
 * `flow.ts`'s `inviteFleetMember(characterID: number)` and
 * `fleetCenter.ts`'s `BoundFleet.characterID: number | null`). Compared as
 * decimal strings rather than with `===` so a `charID` that decoded to its
 * string form (only possible above Number.MAX_SAFE_INTEGER, never observed
 * for a real character id, but boundFleet.ts does not rule it out) still
 * matches instead of silently failing to find the caller's own row.
 */
function charIDMatches(charID: number | string | null, characterID: number): boolean {
  return charID !== null && String(charID) === String(characterID);
}

// --- the OTHER way to call a ship, the one every member has ----------------

/**
 * Whether THIS character may BROADCAST in its fleet right now — the same three
 * states as `canTagInFleet`, asked of the call a plain member actually has.
 *
 * ⚠ THERE IS NO COMMANDER TEST HERE BECAUSE THE SERVER HAS NONE. Read
 * `fleetRuntime.js:sendBroadcast` (fleetRuntime.js:2521-2551) beside
 * `setFleetTargetTag` (fleetRuntime.js:1309-1326) and the asymmetry is the
 * whole point of this function existing: the tag path fetches the member
 * record and refuses anyone outside `FLEET_CMDR_ROLES`, and the broadcast path
 * fetches the member record only to decide who RECEIVES the thing. Membership
 * (`ensureFleetMembership`) is the entire gate on sending. A wing of plain
 * members can all broadcast; not one of them can write a letter.
 *
 * That is not a quirk of this server, it is EVE: lettering targets is a
 * commander's job and calling one out is everybody's. It is why a bot
 * that will never be made a commander is not mute: a caller falls back to
 * this function every time `canTagInFleet` says `false`.
 *
 * ⚠ TWO THINGS THIS DELIBERATELY DOES NOT ANSWER, because a roster cannot:
 *
 *   - THE RATE LIMIT. `isBroadcastRateLimited` (fleetRuntime.js:2473) drops a
 *     repeat of the SAME broadcast name inside `MIN_BROADCAST_TIME_SEC` (2s,
 *     fleetConstants.js:36), and a different name inside a third of that. It is
 *     per character and per fleet, held in server memory, and nothing a client
 *     reads reflects it. A caller must bound its own sending.
 *   - BEING IN SPACE. The retail client checks `CheckIsInFleet(inSpace=True)`
 *     before every send (fleetSvc.py:984); the server does not. Docked, the
 *     broadcast goes out and names an itemID nobody can act on. Callers already
 *     gate on `inSpace`, so this is a note, not a second check.
 *
 * ⚠ AND UNLIKE THE TAG, THE ANSWER COMES BACK. `sendBroadcast` returns a
 * boolean and BOTH its callers return it rather than discarding it
 * (`fleetObjectHandlerService.js:365` Handle_SendBroadcast,
 * `fleetMgrService.js:38` Handle_BroadcastToBubble) — the exact opposite of
 * `Handle_CmdFleetTagTarget`, whose discard is why this module exists at all.
 * A refused broadcast is VISIBLE to the sender. That does not make this
 * pre-flight gate redundant (a call not worth sending is still not worth
 * sending), but it does mean a caller never has to infer a broadcast's fate
 * from later state the way a tag's has to be inferred from `fleetTargetTags`.
 */
export function canBroadcastInFleet(
  snapshot: FleetCenterSnapshot | null | undefined,
  characterID: number,
): boolean | null {
  if (!snapshot || snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return false;
  }
  // Same inconsistent-read reasoning as `canTagInFleet`: a member that cannot
  // find its own row has not learned it is not a member, it has learned the
  // read is untrustworthy. `null`, never `false`.
  const member = snapshot.fleet.initState.value.members.find((row) =>
    charIDMatches(row.charID, characterID),
  );
  return member ? true : null;
}
