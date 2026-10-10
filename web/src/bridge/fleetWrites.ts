// Fleet top-level WRITE acknowledgements (goal R94, now used by Fleet Center and bots).
//
// The LAST Phase-3 top-level writes batch. FAST-MODE educated-guess decoders for
// the 11 confirm-gated fleet writes across three TOP-LEVEL services whose seams
// were wired earlier (fleetProxy READS R69 / fleetObjectHandler bind R72 + bound
// reads R85):
//   • fleetObjectHandler — CreateFleet (⚠ mints a fleet; returns the bound handle;
//                          NEVER fired live)
//   • fleetProxy         — ApplyToJoinFleet (returns null/ack) / AddFleetFinderAdvert /
//                          RemoveFleetFinderAdvert / UpdateAdvertInfo (each returns
//                          the advert payload, or null when there is no advert)
//   • fleetMgr           — ForceLeaveFleet / AddToWatchlist / RemoveFromWatchlist /
//                          RegisterForDamageUpdates (return null) and ⚠ OUTWARD
//                          BroadcastToBubble / BroadcastToSystem (return null; NEVER
//                          broadcast live)
//
// Each BFF route answers the uniform dispatchBridgeWrite envelope
// `{ ok, applied, result, notifications }`; these decoders read that ack. `applied`
// is the BFF's "did not throw" signal; a panel re-reads (GetMyFleetFinderAdvert /
// the fleet bound reads) to prove the mutation.
//
// Server return shapes (educated guesses — Farmer is DOCKED + fleetless; the
// outward broadcasts and CreateFleet were NEVER fired live):
//   • the management / broadcast / apply writes → null
//   • the three advert writes → the buildAdvertPayload dict (or null: "no advert")
//   • CreateFleet → a bound-object handle (an OID/Moniker substruct, not decodable
//                   rows) — surfaced as applied-only.
//
// LOCAL coercions only — this module deliberately does NOT import from market*.ts
// (a separate session owns those files).
//
// TWO OF THESE WRITES ARE MADE BY THE PAGE ITSELF (the plan's Phase 6b) since
// 2026-10-10, where each was one route of the BFF that checked `confirm` and
// made one call (POST /api/bridge/fleet/apply, POST /api/bridge/fleet/broadcast/bubble).
// A retail client has no such routes: its fleet service makes the calls.
//
//   fleetProxy.ApplyToJoinFleet(fleetID, autoAccept)
//       fleetSvc.py 1907, to the client's proxy node. From the fleet finder (fleetfinder.py 373,
//       fleetFinderEntry.py 71) and a fleet's link (1920) with autoAccept False, where the client then asks
//       the pilot about the invitation; from the Agency's join window (joinFleetConfirmation.py 25) with
//       True, the pilot having said yes there. The answer is True where the boss must approve (the client
//       says FleetApplicationReceived) and False where an invitation was made, which the client accepts.
//       In a fleet already the client refuses its own and leaves another first (1899 to 1905): what
//       applies here applies only for a pilot in none.
//
//   fleetMgr.BroadcastToBubble(name, scope, itemID, typeID)
//       fleetSvc.py 998 (SendBubbleBroadcast): the five broadcasts the client sends to its bubble (the three
//       calls for repair, Target and HealTarget: 1039 to 1055), the scope the client is set to, and the type
//       left at None by every caller. Before it the client waits (962 to 981): two seconds since its last
//       broadcast of the same name, a third of that since one of another, and sends nothing inside the
//       wait. The server answers whether it sent the broadcast; it keeps the same wait itself.
//
// Neither is in a Tranquility recording: their forms are from the client's code alone. Either transport
// carries both. THE ROUTES STILL STAND (src/server.js); nothing of the page's asks them now.

import type { Ask } from "./ask.ts";
import { readPlainJsonField, type JsonValue } from "./wire.ts";
import { type FleetAdvert } from "./fleetAds.ts";

/** The uniform ack every confirm-gated fleet write returns. */
export interface FleetWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function ackTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Read the `result` field off a BFF write-ack envelope (null when absent). */
function ackResult(response: JsonValue): JsonValue | null {
  const result = readPlainJsonField(response, "result");
  return result === undefined ? null : result;
}

/**
 * Decode a plain fleet write ack (applied-only: CreateFleet, ApplyToJoinFleet, the
 * four fleetMgr management writes, and the two ⚠ OUTWARD broadcasts — all null- or
 * handle-returning). `applied` is the BFF's "did not throw" signal.
 */
export function decodeFleetWriteAck(response: JsonValue): FleetWriteAck {
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
  };
}

/**
 * Fleet-advert write ack (AddFleetFinderAdvert / RemoveFleetFinderAdvert /
 * UpdateAdvertInfo). The handler returns the updated advert payload (a
 * buildAdvertPayload dict) or null. Surface WHETHER an advert came back — the
 * authoritative post-state is a GetMyFleetFinderAdvert re-read (decodeMyFleetFinder
 * Advert in fleetAds.ts owns the full FleetAdvert decode). Kept deliberately light
 * in fast mode: `advertPresent` is the "an advert exists after this write" signal.
 */
export interface FleetAdvertWriteAck extends FleetWriteAck {
  readonly advertPresent: boolean;
}

function isDictPayload(value: JsonValue | null): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "dict"
  );
}

export function decodeFleetAdvertWriteAck(response: JsonValue): FleetAdvertWriteAck {
  return { ...decodeFleetWriteAck(response), advertPresent: isDictPayload(ackResult(response)) };
}

/**
 * Which half of the fleet-finder round trip an apply took.
 *
 * ⚠ THIS CORRECTS AN R94 FAST-MODE GUESS. ApplyToJoinFleet was recorded as
 * "returns null/ack" because it was never fired live; it in fact returns a
 * BOOLEAN, and that boolean is the whole protocol:
 *
 *   • `true`  — the advert needs the boss's approval, so a join REQUEST was
 *               stored and no invite exists. Retail turns exactly this into
 *               FleetApplicationReceived.
 *   • `false` — an INVITE was minted and notified. The client must now accept
 *               it; nothing else will.
 *
 * "unknown" is the honest third state for a result that is neither (an older
 * server, a shape we did not expect). Callers must treat it as "probably an
 * invite" and try the accept: the common path is the invite one, and a failed
 * accept costs one swallowed call, whereas refusing to accept strands a bot that
 * had an invite waiting for it.
 */
export type FleetApplyOutcome = "needs-approval" | "invited" | "unknown";

/** Read ApplyToJoinFleet's own answer. See FleetApplyOutcome for why "unknown" tries. */
function applyOutcome(answer: JsonValue): FleetApplyOutcome {
  if (answer === true || answer === 1) {
    return "needs-approval";
  }
  if (answer === false || answer === 0) {
    return "invited";
  }
  return "unknown";
}

/**
 * The pilot applies to an advertised fleet. `autoAccept` rides the invitation an open advert answers with: true
 * where the pilot's yes has been had already, as the Agency's join window sends it. Fails as the call fails.
 */
export async function applyToJoinFleet(act: Ask, fleetID: number, autoAccept: boolean): Promise<FleetApplyOutcome> {
  return applyOutcome(await act("fleetProxy", "ApplyToJoinFleet", [fleetID, autoAccept]));
}

/** The broadcasts the client sends to its bubble, by the names it sends them with (evefleet/const.py). */
export type BubbleBroadcast = "HealArmor" | "HealShield" | "HealCapacitor" | "Target" | "HealTarget";

/** fleetSvc.py 58, MIN_BROADCAST_TIME: what the client waits between two broadcasts of one name. */
const MIN_BROADCAST_MS = 2000;

export interface FleetBroadcasts {
  /**
   * One broadcast to the fleet's members in the pilot's bubble. False where nothing reached the fleet: the
   * client's own wait was not over, and nothing was asked; or the server answered that it sent nothing.
   */
  toBubble(name: BubbleBroadcast, scope: number, itemID: number): Promise<boolean>;
}

/** A pilot's broadcasts, with the wait the client's fleet service keeps between them: one wait for them all. */
export function createFleetBroadcasts(act: Ask, now: () => number = Date.now): FleetBroadcasts {
  let last: { readonly name: BubbleBroadcast; readonly atMs: number } | null = null;
  return {
    async toBubble(name, scope, itemID) {
      const atMs = now();
      // 975 to 978: the whole wait after the same name, a third of it after another.
      if (last !== null && last.atMs + (last.name === name ? MIN_BROADCAST_MS : MIN_BROADCAST_MS / 3) > atMs) return false;
      // 967: kept before the call is made, whatever comes of it.
      last = { name, atMs };
      return (await act("fleetMgr", "BroadcastToBubble", [name, scope, itemID, null])) !== false;
    },
  };
}

// Re-export the advert type so a later panel can pair a write ack with the
// GetMyFleetFinderAdvert re-read without importing two modules.
export type { FleetAdvert };
