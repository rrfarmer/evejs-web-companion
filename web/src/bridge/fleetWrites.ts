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

// ── The watchlist ───────────────────────────────────────────────────────────
//
// fleetSvc keeps a watchlist of members, self.favorites (a set), and tells fleetMgr of it whenever it changes:
//
//   fleetMgr.AddToWatchlist(newCharsAdded, favorites)     AddFavorite (640 to 682)
//   fleetMgr.RemoveFromWatchlist(charID, favorites)       RemoveFavorite (715 to 723)
//
// the favourites every one after the change, the client's set (the transport makes the page's list one). Neither is
// in a Tranquility recording.

/** Tells the server of pilots added to the watchlist, and of every favourite with them. Fails as the call fails. */
export async function addToWatchlist(act: Ask, added: readonly number[], favorites: readonly number[]): Promise<void> {
  await act("fleetMgr", "AddToWatchlist", [[...added], [...favorites]]);
}

/** Tells the server of a pilot taken off the watchlist, and of every favourite left. Fails as the call fails. */
export async function removeFromWatchlist(act: Ask, characterID: number, favorites: readonly number[]): Promise<void> {
  await act("fleetMgr", "RemoveFromWatchlist", [characterID, [...favorites]]);
}

/** The broadcasts the client sends to its bubble, by the names it sends them with (evefleet/const.py). */
export type BubbleBroadcast = "HealArmor" | "HealShield" | "HealCapacitor" | "Target" | "HealTarget";

/** The broadcasts the client sends to the whole fleet (fleetSvc.SendGlobalBroadcast's callers, 1010 to 1035 and 1128). */
export type GlobalBroadcast = "EnemySpotted" | "NeedBackup" | "HoldPosition" | "TravelTo" | "InPosition" | "JumpBeacon" | "Location";

/** fleetSvc.py 58, MIN_BROADCAST_TIME: what the client waits between two broadcasts of one name. */
const MIN_BROADCAST_MS = 2000;

export interface FleetBroadcasts {
  /**
   * One broadcast to the fleet's members in the pilot's bubble. False where nothing reached the fleet: the
   * client's own wait was not over, and nothing was asked; or the server answered that it sent nothing.
   */
  toBubble(name: BubbleBroadcast, scope: number, itemID: number): Promise<boolean>;
  /**
   * One broadcast to the whole fleet (fleetSvc.SendGlobalBroadcast, 983 to 990): self.fleet.SendBroadcast(name,
   * scope, itemID, typeID), on the fleet's object, after the same wait. False where nothing reached the fleet, as
   * toBubble. No recording has one: its form is from the client's code alone.
   */
  toFleet(name: GlobalBroadcast, scope: number, itemID: number, typeID?: number | null): Promise<boolean>;
}

/** A pilot's broadcasts, with the wait the client's fleet service keeps between them: one wait for them all. */
export function createFleetBroadcasts(act: Ask, now: () => number = Date.now): FleetBroadcasts {
  let last: { readonly name: BubbleBroadcast | GlobalBroadcast; readonly atMs: number } | null = null;
  /** BroadcastTimeRestriction (962 to 981), the one wait for every broadcast: true where it is not over. */
  const waiting = (name: BubbleBroadcast | GlobalBroadcast): boolean => {
    const atMs = now();
    // 975 to 978: the whole wait after the same name, a third of it after another.
    if (last !== null && last.atMs + (last.name === name ? MIN_BROADCAST_MS : MIN_BROADCAST_MS / 3) > atMs) return true;
    // 967: kept before the call is made, whatever comes of it.
    last = { name, atMs };
    return false;
  };
  return {
    async toBubble(name, scope, itemID) {
      if (waiting(name)) return false;
      return (await act("fleetMgr", "BroadcastToBubble", [name, scope, itemID, null])) !== false;
    },
    async toFleet(name, scope, itemID, typeID = null) {
      if (waiting(name)) return false;
      return (await act("fleetObjectHandler", "SendBroadcast", [name, scope, itemID, typeID])) !== false;
    },
  };
}

// Re-export the advert type so a later panel can pair a write ack with the
// GetMyFleetFinderAdvert re-read without importing two modules.
export type { FleetAdvert };

// ── A fleet's tag on a thing in space ────────────────────────────────────────
//
// Until 2026-10-10 this was one route of the BFF (POST /api/bridge/flight/fleet-tag-target), which checked
// `confirm` and that the pilot was in space and made the call on a ballpark handle of its own. A retail client's
// menu makes it (menusvc.py 2822 to 2826), on its ballpark's own object:
//
//   michelle.GetRemotePark().CmdFleetTagTarget(itemID, tag)
//       The tag is one character as text: a digit, or one of the letters A to J, X, Y and Z (1945, 1946); or
//       None, which takes the tag off (1948). Offered to a fleet's commander for a thing that is not its own
//       ship (celestialCheckers.OfferFleetTagItem). It answers nothing.
//
// In no Tranquility recording. The server acts on the session's own fleet, for its creator or a commander of it.
// Either transport carries it, asked of beyonce by its name; the game port makes it on the ballpark's object.

/**
 * Sets a fleet's tag on a thing in space, or takes it off with `null`. Fails as the call fails.
 *
 * ⚠ THE CALL COMING BACK IS NOT PROOF. The server drops the tag of a pilot who is neither the fleet's creator nor
 * a commander of it, and answers nothing either way: a tag set and a tag dropped look the same from here. A caller
 * confirms by seeing the tag in a later read of the fleet's `targetTags`.
 */
export async function tagFleetTarget(act: Ask, itemID: number, tag: string | null): Promise<void> {
  await act("beyonce", "CmdFleetTagTarget", [itemID, tag]);
}

// --- A fleet left (the plan's Phase 6b) --------------------------------------
//
// Until 2026-10-10 it was one route of the BFF (POST /api/bridge/fleet/leave).
//
// THE CALL, as the client makes it (fleetSvc.LeaveFleet, 365 to 371): self.fleet.LeaveFleet(), on the fleet's own
// object, and then the service forgets the fleet (Clear). Tranquility's recording has it on the fleet's bound
// object, with an empty tuple, and the session's fleet gone straight after. From the fleet's menu, from a kick of
// the pilot's own character, and before an application to another fleet.
//
// THE OBJECT IS THE BFF'S TO FIND. A session is in one fleet, so the call names none (it takes no `of`). The
// object is what CreateFleet answered or the Moniker that accepted an invite: the pilot's connection holds it,
// and the page does not. Where the connection holds none for a fleet the session is in, the client asks
// fleetMgr's ForceLeaveFleet by name instead (367); the BFF does the same in this call's place, since only it
// knows which the connection holds (src/server.js, leaveFleetCall). Through the web gateway, whose session cannot
// say, it is ForceLeaveFleet every time, as the route asked it there.
//
// WHAT THE SERVER TAKES FROM THE CALLER: nothing. It takes the session's own character out of the fleet, hands
// the boss on where the boss left, and refuses one who is no member (FleetNotInFleet).
//
// ⚠ THE ANSWER IS NO PROOF OF ANYTHING. As with every fleet write here, the fleet is read again after.

/** Leaves the fleet the pilot is in. Fails as the call fails. */
export async function leaveFleet(act: Ask): Promise<void> {
  await act("fleetObjectHandler", "LeaveFleet", []);
}

// --- Where the pilot is, told to its fleet ---------------------------------------------
//
// THE CALL, as fleetSvc.UpdateFleetInfoThread (1798 to 1810) makes it: self.fleet.UpdateMemberInfo(
// self.GetMyShipTypeID()), on the fleet's own object, which the BFF holds; the BFF puts the pilot's own ship's type in
// whatever is named here (gamePort/retailCalls.js withOwnShipType). The server takes the member's system, station and
// ship from the session that makes it (fleetRuntime updateMemberInfo): the fleet keeps each member where it was told.

/** Tells the pilot's fleet where the pilot is now and in what ship. Fails as the call fails. */
export async function updateFleetMemberInfo(act: Ask, shipTypeID: number | null): Promise<void> {
  await act("fleetObjectHandler", "UpdateMemberInfo", [shipTypeID]);
}

// --- A member kicked, and the boss handed on ------------------------------------------
//
// THE CALLS, as the client makes them from the fleet's menu for a member (menusvc.py FleetMenu): fleetSvc.KickMember
// (607 to 612), self.fleet.KickMember(charID), once its Confirm is chosen, LeaveFleet instead for the pilot's own;
// fleetSvc.MakeLeader (601 to 605), self.fleet.MakeLeader(charID), once ConfirmMakeFleetBoss is answered yes. Both
// on the fleet's own object, which the BFF holds.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the member. It refuses a kick from a pilot who commands nothing over that
// member, and a boss handed on by a pilot who is not the boss.
//
// ⚠ THE ANSWER IS NO PROOF OF ANYTHING. As with every fleet write here, the fleet is read again after.

/**
 * Gives a member of the pilot's fleet another place (fleetSvc.MoveMember, 513 to 520): self.fleet.MoveMember(charID,
 * wingID, squadID, role), None for what the place does not say (evefleet.client.MemberMenu). Fails as the call fails.
 */
export async function moveFleetMember(act: Ask, characterID: number, wingID: number | null, squadID: number | null, role: number): Promise<void> {
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    throw new Error("A fleet member is required.");
  }
  await act("fleetObjectHandler", "MoveMember", [characterID, wingID, squadID, role]);
}

/** Kicks a member of the pilot's fleet (not the pilot's own, which is leaving). Fails as the call fails. */
export async function kickFleetMember(act: Ask, characterID: number): Promise<void> {
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    throw new Error("A fleet member is required.");
  }
  await act("fleetObjectHandler", "KickMember", [characterID]);
}

/** Hands the boss of the pilot's fleet on to a member. Fails as the call fails. */
export async function makeFleetLeader(act: Ask, characterID: number): Promise<void> {
  if (!Number.isSafeInteger(characterID) || characterID <= 0) {
    throw new Error("A fleet member is required.");
  }
  await act("fleetObjectHandler", "MakeLeader", [characterID]);
}

// --- A fleet formed (the plan's Phase 6b) -------------------------------------
//
// Until 2026-10-11 it was one route of the BFF (POST /api/bridge/fleet/create).
//
// THE CALLS, as the client makes them (fleetSvc.CreateFleet, 331 to 342). From a session in a fleet: none, and
// its own refusal (332). Otherwise:
//
//   self.fleet = sm.RemoteSvc('fleetObjectHandler').CreateFleet()
//
// with nothing, which answers the fleet's own object; then, on that object, Init with the ship's type, a setup's
// name and an advert by keyword; the fleet's state (InitFleet: GetInitState); and GetFleetID. No Tranquility
// recording has a fleet formed: the one recording of a fleet joins one by invitation.
//
// THE OBJECT IS THE BFF'S TO HOLD, so the page asks the first call and the BFF makes it and the Init on what it
// answered, as the route did (src/server.js, createFleetCall). On the game port the BFF's own fleet service goes
// on as the client's does: Init carries the ship's type, and the state and the fleet's ID are read on the object
// (src/gamePort/pilots.js). Through the web gateway it is the bind and the Init alone.
//
// WHAT THE SERVER TAKES FROM THE CALLER: nothing. CreateFleet makes a fleet nobody is in, and Init puts the
// session's own character in it as its boss.
//
// ⚠ THE ANSWER IS NO PROOF OF ANYTHING. As with every fleet write here, the fleet is read again after.

/**
 * Forms a fleet, the pilot its boss. `inAFleet` is whether the pilot is in one already, as the caller knows it:
 * from there the client asks nothing, and nor does this. Fails as the call fails. `adInfoData`, where the Agency's
 * Fleet Up forms the fleet with its advert (fleetSvc.CreateAndRegisterFleet, 1857), goes as Init's adInfoData.
 */
export async function formFleet(act: Ask, inAFleet: boolean, adInfoData: JsonValue | null = null): Promise<void> {
  if (inAFleet) {
    throw new Error("You are already in a fleet.");
  }
  if (adInfoData === null) await act("fleetObjectHandler", "CreateFleet", []);
  else await act("fleetObjectHandler", "CreateFleet", [], { adInfoData });
}

/** A fleet advert's basic options, as the Agency's Fleet Up registration (BasicOptionsCont) takes them. */
export interface FleetAdvertBasics {
  readonly fleetName: string;
  readonly description: string;
  readonly activityValue: number | null;
  readonly newPlayerFriendly: boolean;
}

/** evefleet/const: FLEETNAME_MAXLENGTH, FLEETDESC_MAXLENGTH, INVITE_PUBLIC_OPEN, and the activities fleetActivityNames names. */
const FLEETNAME_MAXLENGTH = 32, FLEETDESC_MAXLENGTH = 250, INVITE_PUBLIC_OPEN = 16;
const FLEET_ACTIVITIES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const pythonSet = (ids: readonly number[]): JsonValue => ({ type: "objectex1", header: [{ type: "token", value: "__builtin__.set" }, [{ type: "list", items: [...ids] }]], list: [], dict: [] });

/** An advert's advanced options (evefleet/fleetAdvertObject.py GetDefaultAdvancedOptions): the scope's minimums, the entities let in and kept out, and the rest. */
export interface FleetAdvertAdvanced {
  readonly public_minStanding: number | null;
  readonly public_minSecurity: number | null;
  readonly public_allowedEntities: readonly number[];
  readonly public_disallowedEntities: readonly number[];
  readonly membergroups_minStanding: number | null;
  readonly membergroups_minSecurity: number | null;
  readonly membergroups_allowedEntities: readonly number[];
  readonly membergroups_disallowedEntities: readonly number[];
  readonly joinNeedsApproval: boolean;
  readonly hideInfo: boolean;
  readonly updateOnBossChange: boolean;
  readonly advertJoinLimit: number | null;
}

/** GetDefaultAdvancedOptions. */
export const DEFAULT_ADVERT_ADVANCED: FleetAdvertAdvanced = Object.freeze({
  public_minStanding: null, public_minSecurity: null, public_allowedEntities: [], public_disallowedEntities: [],
  membergroups_minStanding: null, membergroups_minSecurity: null, membergroups_allowedEntities: [], membergroups_disallowedEntities: [],
  joinNeedsApproval: false, hideInfo: false, updateOnBossChange: true, advertJoinLimit: null,
});

/** evefleet/fleetAdvertObject.MAX_ALLOWED_ENTITIES: a set of entities is cut to its first thousand. */
const MAX_ALLOWED_ENTITIES = 1000;
/** evefleet/const.MAX_MEMBERS_IN_FLEET: an advert's join limit is held between one and it. */
const MAX_MEMBERS_IN_FLEET = 256;

/**
 * FleetAdvertCreationObject(fleetName, description, activityValue, inviteScope=INVITE_PUBLIC_OPEN,
 * newPlayerFriendly, useAdvanceOptions=False).GetData() (evefleet/fleetAdvertObject.py 39 to 52; BasicOptionsCont.
 * RegisterFleet without the advanced options): the name to 32 letters and the description to 250, an activity the
 * client does not name None, and the advanced options' defaults (GetDefaultAdvancedOptions), the sets empty.
 */
export function basicAdvertData(basics: FleetAdvertBasics): JsonValue {
  return advertData(basics, INVITE_PUBLIC_OPEN, null);
}

/**
 * FleetAdvertCreationObject(..., inviteScope, useAdvanceOptions, **advancedOptions).GetData(): with the advanced
 * options (null: the defaults, and useAdvanceOptions False), each set cut to its first thousand and the join limit
 * held between one and MAX_MEMBERS_IN_FLEET, as the object's setters hold them.
 */
export function advertData(basics: FleetAdvertBasics, inviteScope: number, advanced: FleetAdvertAdvanced | null): JsonValue {
  const activity = basics.activityValue !== null && FLEET_ACTIVITIES.has(basics.activityValue) ? basics.activityValue : null;
  const a = advanced ?? DEFAULT_ADVERT_ADVANCED;
  const set = (ids: readonly number[]) => pythonSet(ids.slice(0, MAX_ALLOWED_ENTITIES));
  const entries: [string, JsonValue][] = [
    ["fleetName", { type: "wstring", value: basics.fleetName.slice(0, FLEETNAME_MAXLENGTH) }],
    ["description", { type: "wstring", value: basics.description.slice(0, FLEETDESC_MAXLENGTH) }],
    ["inviteScope", inviteScope],
    ["activityValue", activity],
    ["useAdvanceOptions", advanced !== null],
    ["newPlayerFriendly", basics.newPlayerFriendly],
    ["public_minStanding", a.public_minStanding],
    ["public_minSecurity", a.public_minSecurity],
    ["public_allowedEntities", set(a.public_allowedEntities)],
    ["public_disallowedEntities", set(a.public_disallowedEntities)],
    ["membergroups_minStanding", a.membergroups_minStanding],
    ["membergroups_minSecurity", a.membergroups_minSecurity],
    ["membergroups_allowedEntities", set(a.membergroups_allowedEntities)],
    ["membergroups_disallowedEntities", set(a.membergroups_disallowedEntities)],
    ["joinNeedsApproval", a.joinNeedsApproval],
    ["hideInfo", a.hideInfo],
    ["updateOnBossChange", a.updateOnBossChange],
    ["advertJoinLimit", a.advertJoinLimit === null ? null : Math.min(Math.max(a.advertJoinLimit, 1), MAX_MEMBERS_IN_FLEET)],
  ];
  return { type: "dict", entries };
}

// --- An invitation accepted (the plan's Phase 6b) ----------------------------
//
// Until 2026-10-11 it was one route of the BFF (POST /api/bridge/fleet/invite/accept).
//
// THE CALL, as the client makes it (fleetSvc.OnFleetInvite, 1168 to 1195). The invitation names its fleet, and
// the client makes a Moniker for that fleet (GetFleet(fleetID)). From a session in a fleet it turns the
// invitation down on it and asks no more. Otherwise, on the pilot's yes:
//
//   __fleetMoniker.AcceptInvite(self.GetMyShipTypeID())
//
// and the Moniker is the fleet's own object from then, on which the fleet is read. Tranquility's recording has
// the bind of that Moniker carrying the call, with the ship's type.
//
// THE FLEET IS THE PAGE'S TO NAME (`of`), as its invitation named it. THE SHIP'S TYPE IS NOT: the game port says
// the ship's as the client does, and through the web gateway the server takes the session's (src/server.js,
// acceptFleetInviteCall). So the call goes with nothing.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the fleet, by the bind, which proves nothing. It accepts only a real
// invitation for the session's own character that names that fleet, and refuses a character that is in a fleet
// (FleetError), a fleet that is full (FleetTooManyMembers), a place that is not there (FleetNoPositionFound) and
// an invitation that is not open (FleetNotFound).
//
// ⚠ THE ANSWER IS NO PROOF OF ANYTHING. As with every fleet write here, the fleet is read again after.

/**
 * Accepts the invitation of the fleet `fleetID`. `inAFleet` is whether the pilot is in a fleet already, as the
 * caller knows it: from there the client asks no acceptance, and nor does this. Fails as the call fails.
 */
export async function acceptFleetInvite(act: Ask, fleetID: number, inAFleet: boolean): Promise<void> {
  if (!Number.isSafeInteger(fleetID) || fleetID <= 0) {
    throw new Error("That invitation names no fleet.");
  }
  if (inAFleet) {
    throw new Error("You are already in a fleet.");
  }
  await act("fleetObjectHandler", "AcceptInvite", [], undefined, fleetID);
}

// --- A pilot invited (the plan's Phase 6b) ------------------------------------
//
// Until 2026-10-11 it was one route of the BFF (POST /api/bridge/fleet/invite).
//
// THE CALL, as the client makes it (fleetSvc.Invite, 351 to 363). In no fleet it forms one first. For what is no
// pilot (idCheckers: an NPC's number, or none of a character's) it says so itself and asks nothing; for the
// pilot's own character it asks nothing and says nothing. Otherwise:
//
//   CSPAChargedAction('CSPAFleetCheck', self.fleet, 'Invite', charID, wingID, squadID, role)
//
// which is self.fleet.Invite(charID, wingID, squadID, role), on the fleet's own object, asked once, and again with
// the cost by keyword where the server says the contact costs and the pilot agrees (eveMisc.py 89). From the
// menus it is the pilot and three Nones (menusvc.py 2714, fleet/entries.py 72, fleetUtil.py 68); a wing, a squad
// and a role are named from the fleet's own window alone. No Tranquility recording has an invitation sent: the
// one recording of a fleet is of the pilot invited.
//
// THE PAGE NAMES THE PILOT ALONE, so its invitation is the plain one. The BFF makes it on the session's own
// fleet's object and says None for the wing, the squad and the role whatever the call came with: the server seats
// an invitee in whatever role it is told (src/server.js, inviteToFleetCall).
//
// A FLEET EXPECTED. A caller that queued its invitation while the pilot was in one fleet says that fleet's number
// (`of`), and the BFF binds by it, so that the server's check of the inviter runs against that fleet and the
// invitation cannot follow its pilot into another. Only the bot host's recovery says one.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the invitee. The inviter is the session's own character, which must be a
// member of the fleet (FleetNotInFleet); it refuses a character that is in a fleet (FleetError) and a place that
// is not there (FleetNoPositionFound); for no pilot and for the inviter itself it answers false and does nothing.
// It asks nothing of what the contact costs.
//
// THE PAGE FORMS NO FLEET FOR IT: its Fleet window invites only from a fleet, and a bot forms its own first.
//
// ⚠ THE ANSWER IS NO PROOF OF ANYTHING. As with every fleet write here, the fleet is read again after.

/**
 * idCheckers, as fleetSvc.Invite goes by them (357): not IsNPC, and IsCharacter. By the number alone: a player's
 * character of the second or the third generation, or a number of the range the older characters share with
 * other things. (There the client asks its cache of owners, which the page has not got.)
 */
const couldBeAPilot = (characterID: number): boolean => Number.isSafeInteger(characterID)
  && ((characterID >= 90_000_000 && characterID <= 97_999_999) || (characterID >= 100_000_000 && characterID <= 2_129_999_999));

/**
 * Invites the pilot `inviteeCharID` to the pilot's own fleet. `ownCharacterID` is the pilot's own character as
 * the caller knows it (null where it does not): the client asks nothing for that one, and nor does this.
 * `expectedFleetID`, where the caller says one, is the fleet the invitation is to: the call is made on that
 * fleet's object and no other. `place` is where in the fleet (menusvc.FleetInviteMenu, MemberMenu's places: a wing,
 * a squad and a role, None for each not given); none, as the menu's first entry, a squad member with no place said.
 * Fails as the call fails.
 */
export async function inviteToFleet(act: Ask, inviteeCharID: number, ownCharacterID: number | null, expectedFleetID?: number, place?: { readonly wingID: number | null; readonly squadID: number | null; readonly role: number | null }): Promise<void> {
  if (!couldBeAPilot(inviteeCharID)) {
    throw new Error("That is no pilot to invite.");
  }
  if (inviteeCharID === ownCharacterID) {
    throw new Error("You cannot invite yourself to your own fleet.");
  }
  // (A fleet said and no fleet's number is not taken for none said: the invitation is to that fleet or to none.)
  if (expectedFleetID !== undefined && !(Number.isSafeInteger(expectedFleetID) && expectedFleetID > 0)) {
    throw new Error("That is no fleet to invite a pilot to.");
  }
  await act("fleetObjectHandler", "Invite", [inviteeCharID, place?.wingID ?? null, place?.squadID ?? null, place?.role ?? null], undefined, expectedFleetID);
}

// --- An invitation turned down (the plan's Phase 6b) --------------------------
//
// The page could not turn one down at all until 2026-10-11: nothing of it asked the BFF's route
// (POST /api/bridge/fleet/invite/reject), and its Fleet window had an acceptance and nothing beside it.
//
// THE CALL, as the client makes it (fleetSvc.OnFleetInvite, 1168 to 1199), on a Moniker for the fleet the
// invitation names:
//
//   __fleetMoniker.RejectInvite(True)    from a session that is in a fleet: at once, and its pilot asked nothing (1180)
//   __fleetMoniker.RejectInvite(False)   where the pilot's setting turns invitations away, or the window is blocked (1184, 1187)
//   __fleetMoniker.RejectInvite()        on the pilot's no (1198)
//
// and nothing is read after any of them. No Tranquility recording has one. The page has the setting (its Settings
// window's Auto-reject invitations, app/autoRejectInvitations.ts) and no blocked window, so it says True, False for
// the setting, or nothing.
//
// THE FLEET IS THE PAGE'S TO NAME (`of`), as its invitation named it, and the word is the page's to say: it is
// the page that knows whether its pilot is in a fleet (src/server.js, rejectFleetInviteCall).
//
// WHAT THE SERVER TAKES FROM THE CALLER: the fleet, by the bind, and the word. It forgets the session's own
// character's invitation where that invitation names that fleet, tells the inviter (OnFleetJoinReject, with the
// word made a reason), and answers true; with no such invitation it answers false and does nothing. The word
// decides only which reason the inviter is told.

/**
 * Turns down the invitation of the fleet `fleetID`. `inAFleet` is whether the pilot is in a fleet, as the caller
 * knows it: from there the client says True with it, and so does this. `bySetting` is the pilot's setting turning
 * it away, where the client says False. Fails as the call fails.
 */
export async function declineFleetInvite(act: Ask, fleetID: number, inAFleet: boolean, bySetting = false): Promise<void> {
  if (!Number.isSafeInteger(fleetID) || fleetID <= 0) {
    throw new Error("That invitation names no fleet.");
  }
  await act("fleetObjectHandler", "RejectInvite", inAFleet ? [true] : bySetting ? [false] : [], undefined, fleetID);
}
