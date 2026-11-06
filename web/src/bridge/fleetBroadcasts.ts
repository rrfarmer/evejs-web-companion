// Fleet broadcasts and fleet state tags: the two pushed-notification shapes a
// following pilot's bot reads to decide what to do next. Kept in one module
// because they answer the same question from two angles — a broadcast is a
// one-shot CALL ("do this now"), a state-change tag is standing FLEET STATE
// ("this is what X currently is") — and a decoder for one is easy to mistake
// for the other if they are not read side by side.
//
// Wire contract (fleetRuntime.js:2538, cross-checked against the decompiled
// client's own `def OnFleetBroadcast(self, name, scope, charID,
// solarSystemID, itemID, typeID)`):
//   OnFleetBroadcast args = [name, scope, senderCharID, senderSolarSystemID,
//   itemID, typeID], six positional elements, always in that order. `name`
//   is one of the 15 FLEET_BROADCAST_NAMES below; the server refuses
//   ("Illegal broadcast") anything else before it is ever sent
//   (fleetConstants.js:58), so an unrecognised name here means we are
//   decoding garbage, not a legal 16th kind.
//
// OnFleetStateChange has ONE argument, a util.KeyVal whose `targetTags`
// field holds the itemID -> tag dict (fleetPayloads.js:207-211; both server
// call sites share the identical builder).
//
// ⚠ `itemID` and `typeID` skip server-side normalization entirely — they are
// passed through from the sending client untouched (unlike senderCharID and
// senderSolarSystemID, which the server does normalize). Our web client
// receives notifications through the web gateway's `encodeJsonSafeCallValue`,
// which turns any `bigint` into `.toString()` — a BARE DECIMAL STRING, not a
// `{type:"long"}` wrapper. A previous investigation concluded a bare numeric
// string could not happen here and was wrong: it traced the binary marshal
// path used by the retail client, not the JSON path our gateway actually
// serves. So itemID/typeID must tolerate a number, null, OR a bare numeric
// string — see positiveSafeID below, and its dedicated test.

import { readDictPairs, readKeyVal, unwrapLong, type DictEntry, type JsonValue } from "./wire.ts";

// --- broadcast names ---------------------------------------------------

export const FLEET_BROADCAST_NAMES = [
  "EnemySpotted",
  "NeedBackup",
  "HoldPosition",
  "InPosition",
  "TravelTo",
  "JumpBeacon",
  "Location",
  "Target",
  "HealTarget",
  "HealArmor",
  "HealShield",
  "HealCapacitor",
  "WarpTo",
  "AlignTo",
  "JumpTo",
] as const;

export type FleetBroadcastName = (typeof FLEET_BROADCAST_NAMES)[number];

/**
 * `BROADCAST_ALL` (fleetConstants.js:10) — the `scope` a broadcast we SEND
 * carries, and the only one this client ever sends.
 *
 * ⚠ THIS IS A SCOPE, NOT A RANGE, AND THE TWO ARE INDEPENDENT ARGUMENTS. Range
 * (bubble/system/universe) is chosen by WHICH server method is called and
 * decides whose sessions are collected; scope is a separate argument tested per
 * recipient by `shouldReceiveBroadcast` (fleetRuntime.js:2430) and decides which
 * of those collected may hear it. `ALL` short-circuits that test to true; `UP`
 * and `DOWN` walk the wing/squad hierarchy, so a plain member sending `UP`
 * reaches only its squad commander and above — nobody on grid.
 *
 * The retail client's own setting (`fleetBroadcastScopeSetting`,
 * fleetbroadcastexports.py:332) offers all three and defaults to `ALL`. We do
 * not expose the choice: a bot's only reason to broadcast is to be heard
 * by whoever can shoot the thing.
 *
 * ⚠ NOT RE-EXPORTED FROM THE DECODER SIDE OF THIS MODULE BY ACCIDENT. Received
 * broadcasts carry a scope too, and this client ignores it on the way in —
 * the server has already decided we were entitled to hear it.
 */
export const FLEET_BROADCAST_SCOPE_ALL = 3;

function isFleetBroadcastName(value: unknown): value is FleetBroadcastName {
  return (
    typeof value === "string" &&
    (FLEET_BROADCAST_NAMES as readonly string[]).includes(value)
  );
}

// --- what itemID actually IS, and whether a follower should act on it -----
//
// The server passes itemID through opaquely (see the ⚠ above), so the client
// source is the only authority on what it means per broadcast name
// (decompiled fleetSvc.py:1010-1130). Expressed as one lookup table rather
// than scattered `if (name === ...)` checks, so a caller asking "should I act
// on this" or "what is itemID here" never has to re-derive the client logic.

export type FleetBroadcastItemMeaning =
  | "primary-target" // Target: the tactical target's ship
  | "align-object" // AlignTo: an object to align to
  | "stargate" // JumpTo: a stargate (client further gates this to groupStargate)
  | "destination-system" // TravelTo: ⚠ NOT an item — a solar system id in the itemID slot
  | "sender-own-ship" // HealShield/HealArmor/HealCapacitor: rep the sender, not itemID's owner
  | "third-party-ship" // HealTarget: a third party's ship, distinct from the sender
  | "warp-object" // WarpTo: the object the fleet is told to warp to
  | "sender-beacon" // JumpBeacon: a beacon the sender holds
  | "nearest-ball"; // EnemySpotted/NeedBackup/HoldPosition/InPosition/Location: whatever was nearest the sender

export interface FleetBroadcastClassification {
  readonly itemMeaning: FleetBroadcastItemMeaning;
  readonly act: boolean;
}

/**
 * ⚠ The `act: false, itemMeaning: "nearest-ball"` group is the one worth
 * reading twice: those five names carry an itemID too (GetNearestBall on the
 * sender's client), but it is whatever ball happened to be nearest the
 * SENDER, not an order about it. Treating it as a target would have a
 * follower warp to a random nearby object every time somebody typed
 * "enemy spotted" in local. That is exactly why these are announcements —
 * log them, never act on the itemID.
 *
 * ⚠ `WarpTo` USED TO BE acts=false ON A CLAIM THAT IS FALSE. The note here read
 * "the fleet warp itself is executed server-side once the broadcast lands", and
 * it conflated two different things. `sendBroadcast` (fleetRuntime.js) does
 * exactly one thing -- `notifySession(..., "OnFleetBroadcast", ...)` -- and
 * warps nobody. The server-side fleet warp is a SEPARATE command, michelle's
 * `CmdWarpToStuff` with `fleet=1`, which a follower yields to by seeing its own
 * ship enter warp. A `WarpTo` BROADCAST is an instruction to the fleet, and a
 * follower that ignored it simply did not go. Checked against the server
 * 2026-09-11.
 *
 * `JumpBeacon` also acts=false: the itemID is a beacon the SENDER holds, not
 * one the follower can use directly; the client's own handling prefers
 * OnBridgeModeChange for actually jumping through a bridge.
 */
export const FLEET_BROADCAST_CLASSIFICATION: Readonly<
  Record<FleetBroadcastName, FleetBroadcastClassification>
> = {
  Target: { itemMeaning: "primary-target", act: true },
  AlignTo: { itemMeaning: "align-object", act: true },
  JumpTo: { itemMeaning: "stargate", act: true },
  TravelTo: { itemMeaning: "destination-system", act: true },
  HealShield: { itemMeaning: "sender-own-ship", act: true },
  HealArmor: { itemMeaning: "sender-own-ship", act: true },
  HealCapacitor: { itemMeaning: "sender-own-ship", act: true },
  HealTarget: { itemMeaning: "third-party-ship", act: true },
  WarpTo: { itemMeaning: "warp-object", act: true },
  JumpBeacon: { itemMeaning: "sender-beacon", act: false },
  EnemySpotted: { itemMeaning: "nearest-ball", act: false },
  NeedBackup: { itemMeaning: "nearest-ball", act: false },
  HoldPosition: { itemMeaning: "nearest-ball", act: false },
  InPosition: { itemMeaning: "nearest-ball", act: false },
  Location: { itemMeaning: "nearest-ball", act: false },
};

// --- decoding ---------------------------------------------------------

export interface FleetBroadcast {
  readonly name: FleetBroadcastName;
  readonly scope: number;
  readonly senderCharID: number | null;
  readonly senderSolarSystemID: number | null;
  readonly itemID: number | null;
  readonly typeID: number | null;
  readonly receivedAtMs: number;
}

/** fleetSvc.py 61, MAX_NUM_BROADCASTS: the most broadcasts the client's history keeps. */
export const MAX_BROADCAST_HISTORY = 500;

/**
 * The client's label for a broadcast in its history (fleetSvc.AddBroadcast, 1430 to 1490), and the label's
 * arguments as AddBroadcast gives them. The heals' labels have the healed thing's type after them where the ship is
 * in the ballpark, and Target's and HealTarget's are the WithType ones where the target is there: those the caller
 * makes (it has the ballpark). spaceAndOptionalGroupName is ' ', and ' <group> ' only for a stargate or a skyhook,
 * whose group the page does not tell here: TravelTo, the one the page's menu sends, gives no type.
 */
export function broadcastHistoryLabel(broadcast: FleetBroadcast): { readonly label: string; readonly args: Readonly<Record<string, JsonValue>> } {
  const charID = broadcast.senderCharID;
  const place = { charID, locationID: broadcast.itemID, spaceAndOptionalGroupName: " " };
  switch (broadcast.name) {
    case "EnemySpotted": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventEnemySpotted", args: { charID } };
    case "NeedBackup": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventNeedBackup", args: { charID } };
    case "HealArmor": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventHealArmor", args: { charID } };
    case "HealShield": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventHealShield", args: { charID } };
    case "HealCapacitor": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventHealCapacitor", args: { charID } };
    case "InPosition": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventInPosition2", args: place };
    case "HoldPosition": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventHoldPosition", args: { charID } };
    case "JumpBeacon": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventJumpToBeacon", args: { charID } };
    case "Location": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventLocation", args: { charID, solarsystemID: broadcast.senderSolarSystemID } };
    case "WarpTo": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventWarpTo2", args: place };
    case "AlignTo": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventAlignTo2", args: place };
    case "JumpTo": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventJumpTo2", args: place };
    case "TravelTo": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventTravelTo2", args: place };
    case "Target": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventTarget", args: {} };
    case "HealTarget": return { label: "UI/Fleet/FleetBroadcast/BroadcastEventHealTarget", args: {} };
  }
}

/**
 * A positive game id as a Number. Accepts the `{type:"long"}` wrapper, a
 * bare integer, or a bare decimal string — see the ⚠ at the top of this
 * file for why the string case is not hypothetical. Deliberately NOT a bare
 * `unwrapLong`: that returns null for the string case and would silently
 * drop an itemID/typeID that arrived exactly as our own gateway sends it.
 * Mirrors fleetCenter.ts's positiveSafeID (kept local here rather than
 * imported — every bridge decoder module keeps this coercer to itself).
 */
function positiveSafeID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  if (unwrapped !== null && unwrapped > 0n && unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(unwrapped);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }
  return null;
}

/** The broadcast scope (1=DOWN, 2=UP, 3=ALL); 0 when unreadable, never fabricated. */
function broadcastScope(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

/**
 * Decode one `OnFleetBroadcast` push into a `FleetBroadcast`, or null when
 * this is a different method or the name is not one of the 15 legal ones
 * (server-enforced, fleetConstants.js:58 — anything else is decode garbage,
 * not a legal kind we failed to list).
 */
export function decodeFleetBroadcastNotification(
  method: string | null,
  args: readonly unknown[],
  receivedAtMs: number,
): FleetBroadcast | null {
  if (method !== "OnFleetBroadcast") {
    return null;
  }
  const name = args[0];
  if (!isFleetBroadcastName(name)) {
    return null;
  }
  return {
    name,
    scope: broadcastScope(args[1]),
    senderCharID: positiveSafeID(args[2]),
    senderSolarSystemID: positiveSafeID(args[3]),
    itemID: positiveSafeID(args[4]),
    typeID: positiveSafeID(args[5]),
    receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : Date.now(),
  };
}

/** One itemID -> tag entry, decoded defensively; null when either half fails. */
function decodeTagEntry(entry: DictEntry): readonly [number, string] | null {
  const itemID = positiveSafeID(entry[0]);
  const tag = entry[1];
  if (itemID === null || typeof tag !== "string") {
    return null;
  }
  return [itemID, tag];
}

/**
 * Decode one `OnFleetStateChange` push into its itemID -> tag map.
 *
 * `null` means "not this method" — could not read at all. An empty map means
 * the method fired and no items are currently tagged, an authoritative
 * answer in its own right. The two must stay distinguishable: a caller that
 * collapses them into one falsy value cannot tell "nothing is tagged" from
 * "we never got a state change and are still showing yesterday's tags".
 *
 * Reads `args[0].targetTags` first (both server call sites in
 * fleetPayloads.js:207-211 share the identical util.KeyVal builder), and
 * falls back to treating `args[0]` itself as the dict when that field is
 * absent — cheap insurance against a shape where the wrapper was skipped.
 * Tag-dict keys ARE normalized server-side (`toInteger`), so in practice
 * they arrive as plain JSON numbers, but they are still run through the same
 * positiveSafeID coercer as everything else here rather than trusted blind.
 */
export function decodeFleetStateChangeNotification(
  method: string | null,
  args: readonly unknown[],
): ReadonlyMap<number, string> | null {
  if (method !== "OnFleetStateChange") {
    return null;
  }
  const outer = args[0] as JsonValue | undefined;
  const wrapped = readKeyVal(outer, "targetTags");
  const dictSource = wrapped !== undefined ? wrapped : outer;
  // ⚠ A PAYLOAD THIS CANNOT READ IS `null`, NOT AN EMPTY MAP, and the
  // difference is the whole reason both answers exist.
  //
  // `readDictPairs` answers `[]` for a dict with no entries AND for a value
  // that is not a dict at all, which is right for its own callers and wrong
  // here: returning an empty map for an unreadable payload would claim
  // "received, and the fleet has tagged nothing". A bot that may write
  // tags reads exactly that claim as permission to assign a letter — so an
  // unparseable payload would let it stamp "A" on a ship while the fleet
  // already had an A this code merely failed to parse, which is the tag
  // collision the whole null-versus-empty convention exists to prevent.
  //
  // So: shape-check FIRST, and only then count entries. `null` keeps meaning
  // "never received or could not be read", `new Map()` keeps meaning
  // "received, and nothing is tagged" — the same split
  // `authoritativeFleetMemberCharacterIDs` makes in `fleetCenter.ts`.
  if (!isTagDict(dictSource)) {
    return null;
  }
  const tags = new Map<number, string>();
  for (const entry of readDictPairs(dictSource)) {
    const decoded = decodeTagEntry(entry);
    if (decoded !== null) {
      tags.set(decoded[0], decoded[1]);
    }
  }
  return tags;
}

/**
 * Whether a value is a dict at all, as distinct from a dict that is empty.
 * `readDictPairs` deliberately conflates the two; this is the one caller that
 * must not.
 */
function isTagDict(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; entries?: unknown };
  return candidate.type === "dict" && Array.isArray(candidate.entries);
}

// --- freshness ----------------------------------------------------------

/**
 * How long a broadcast stands before a reader should treat it as stale.
 * Mirrors `src/squadBoard.js`'s `DEFAULT_TTL_MS` (repo root `src/`, the BFF)
 * and its reasoning: two ticks of the bot runner's ~2s cadence is too tight
 * (one slow read and a follower loses the call mid-fight), a minute is far
 * too long (the engagement is usually over). Thirty seconds is "this fight".
 * Defined ONCE here so nothing downstream re-derives a different "stale".
 *
 * ⚠ Checked at READ time, never on a timer — same discipline as
 * `squadBoard.js`'s `primary()`, which drops a lapsed call when asked rather
 * than expiring it on a schedule. A broadcast is a CALL, and a call goes
 * stale in seconds. A fleet-state TAG, by contrast, does not expire here at
 * all: it is fleet STATE, authoritative until the next OnFleetStateChange,
 * not a call with a shelf life. That is why only FleetBroadcast gets a TTL.
 */
export const FLEET_BROADCAST_TTL_MS = 30_000;

/** Pure freshness check — no clock read inside, `nowMs` always passed in. */
export function isFleetBroadcastFresh(broadcast: FleetBroadcast, nowMs: number): boolean {
  return nowMs - broadcast.receivedAtMs < FLEET_BROADCAST_TTL_MS;
}
