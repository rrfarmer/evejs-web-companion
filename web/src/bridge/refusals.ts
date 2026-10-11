// R31 — the server's refusal, in the player's language.
//
// ⚠ THIS IS THE ONLY PLACE A REFUSAL BECOMES WORDS. Every verb that can be
// turned down routes through `refusalWords`/`describeRefusal`; nothing else in
// the app is allowed to interpolate a raw server string into a sentence a
// player reads. R9a — plain player language, never codes or jargon — was being
// violated in the one place a player is most likely to look, and the fix has to
// be a seam rather than a patch at each of the fifteen call sites.
//
// ── WHERE THIS VOCABULARY CAME FROM (measured, not invented) ────────────────
//
// R28 set the precedent: its skill-queue table is EXACTLY the gateway's own
// eleven-code allowlist, pinned by a test. Movement has no such allowlist —
// there are only two code tables in `evejsWebGatewayRuntime.js`
// (PUBLIC_SKILL_QUEUE_ERROR_CODES and PUBLIC_PI_RESTART_ERROR_CODES) and BOTH
// gate the offline character-command path, not `/call`. So the bound had to be
// derived a different way, and it was derived like this:
//
//   1. WEB_CALL_ALLOWLIST (evejsWebGatewayRuntime.js:88) says which
//      (service, method) pairs a browser can dispatch at all. For the verbs
//      that can be refused in flight that is beyonce.Cmd* , dogmaIM.*,
//      ship.Board/Undock/LaunchDrones/ScoopDrone and invbroker.*.
//   2. Every `throwWrappedUserError("<Name>", …)` site inside the handlers
//      those pairs reach was enumerated (beyonceService.js, dogmaService.js,
//      shipService.js, structureDockingService.js) and attributed to its
//      enclosing handler, so unreachable names were excluded rather than
//      guessed at — Handle_InitiateModuleRepair, the
//      overload / probe-launch / bookmark / fleet-bridge helpers and
//      Handle_Scoop are all real UserError sites that this client CANNOT
//      provoke, and none of them is in the table below.
//      (Handle_CreateNewbieShip was listed with them and was never one: the
//      Station panel's "Board corvette" has always reached it. Its three are
//      in the table since 2026-10-10.)
//      (officeManager's RentOffice is the page's own call since the same day,
//      and its NotEnoughMoney is in the table with them. So is a fleet's
//      leaving, on the fleet's object, and its FleetNotInFleet.)
//   3. That leaves the 32 bare codes and 2 localization labels in
//      SERVER_REFUSALS. The list is asserted in refusals.test.ts.
//
// ── HOW A REFUSAL ARRIVES ──────────────────────────────────────────────────
//
// `readWrappedUserErrorRefusal` (evejsWebGatewayRuntime.js:1232) reads ONLY the
// `info` and `notify` keys of the UserError dict and otherwise falls through to
// the bare code. That produces exactly three shapes on the wire, and the table
// is built around those three and nothing else:
//
//   a. PROSE — the handler's own sentence, e.g. "Your ship cannot warp while an
//      active module is preventing movement." This is ALREADY plain player
//      language and is passed through untouched. Translating it would be us
//      talking over the server.
//   b. A BARE CODE — e.g. `DockingApproach`, `TargetTooFar`. The dicts these
//      carry (`distance`, `reason`, `remainingTime`) are dropped by the gateway,
//      so the code is genuinely all we get.
//   c. A LOCALIZATION TUPLE — `101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist`.
//      The `101,` prefix is NOT a protocol field: the handler throws
//      `CustomInfo {info: [101, "UI/..."]}` and the gateway does
//      `String(proseEntry[1])`, so a JS array is comma-joined on its way out.
//      101 is `carbon.common.lib.const.UE_LOC`, retail's "this is a
//      localization key" marker; the real client substitutes localized text for
//      it and we have no such table, which is why the raw key reached the
//      player. `Withing` is CCP's own typo and is reproduced faithfully here
//      because matching the server's string is the whole job.
//
// Only TWO of these tuples can reach us — both from `_throwStargateJumpUserError`
// (beyonceService.js:1701, :1706). The two other `[101, path]` tuples in eve.js
// (ShipTooLarge, InsufficientRoles) sit under a `reason` key the gateway never
// reads, so they arrive as a bare code with the label discarded.
//
// ── THE RULES THIS FILE OBEYS ──────────────────────────────────────────────
//
// • A refusal is NEVER swallowed. This changes the wording, never the fact that
//   the action did not happen — every caller still renders a failure.
// • Nothing is translated in the BFF. The raw server text keeps flowing over
//   the wire unchanged (`src/server.js` passes CALL_REFUSED through untouched);
//   this is a browser-side presentation concern, and putting it here is what
//   keeps the wording inside reach of the tests that pin it.
// • A reason is NEVER invented. Where the server's own meaning is a bare
//   "it failed and here is no cause" — `DeniedTargetingAttemptFailed` is
//   literally the `default:` arm of the targeting switch — the sentence says
//   something true and non-specific instead of a confident guess.
// • An UNRECOGNISED refusal still reads as a sentence. It is not dumped raw at
//   the player; the raw text stays recoverable as `Refusal.detail`.

/** A server refusal, split into what the player reads and what a diagnostician needs. */
export interface Refusal {
  /**
   * The sentence to show. Never a code, a resource path or an identifier —
   * `isPlainPlayerLanguage(text)` is true for every value this can produce.
   */
  readonly text: string;
  /**
   * The server's own words, verbatim, when `text` is NOT them — i.e. when we
   * translated a code or fell back. Null when the server already spoke plainly
   * and `text` IS its sentence, because there is then nothing extra to recover.
   */
  readonly detail: string | null;
}

// --- The vocabulary ---------------------------------------------------------

/**
 * eve.js's own refusal vocabulary, keyed by the exact string that arrives as the
 * CALL_REFUSED message. Two localization tuples, then the bare UserError codes
 * in alphabetical order. Each comment names the server-side condition the
 * wording is derived from, so a reader can check the sentence against the cause
 * rather than trusting it.
 */
const SERVER_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  // beyonceService `_throwStargateJumpUserError` — TOO_FAR_FROM_STARGATE.
  "101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist":
    "That gate is too far away to jump through. Get closer to it first.",
  // beyonceService `_throwStargateJumpUserError` — STARGATE_NOT_ACTIVE.
  "101,UI/GateIcons/GateClosed":
    "That gate is closed. Nothing can jump through it right now.",

  // dogma Handle_CreateNewbieShip — the pilot is in a corvette already. The page
  // refuses this itself where the pilot's flight says the hull's group, as the
  // client does; where it does not say, the server's refusal is what is left.
  AlreadyInNewbieShip:
    "You are already aboard a corvette.",
  // beyonce Handle_CmdWarpToStuff — the bookmark is gone or not yours.
  BookmarkNotAvailable:
    "That bookmark is not available to you, so the ship cannot warp to it.",
  // dogma `_throwModuleOnlineUserError` — MAX_GROUP_ONLINE.
  CannotOnlineReachedMaxGroupOnline:
    "Your ship already has as many modules of that kind online as it is allowed.",
  // dogma `_throwModuleActivationUserError` — MODULE_DISALLOWED_IN_HIGHSEC.
  CantInHighSecSpace:
    "That module cannot be used in high-security space.",
  // dogma `_throwModuleOnlineUserError` — CRP_ACCESS_DENIED.
  CrpAccessDenied:
    "Your corporation roles do not let you do that.",
  // dogma `_throwModuleActivationUserError` — CANNOT_ACTIVATE_IN_WARP.
  DeniedActivateInWarp:
    "That module cannot be used while the ship is in warp. Wait until it lands.",
  // dogma `_throwModuleActivationUserError` — TARGET_NOT_FOUND.
  DeniedActivateTargetNotPresent:
    "The target is no longer there, so the module was not activated.",
  // beyonce / dogma / structure docking — NOT_IN_SPACE, SHIP_NOT_FOUND,
  // SHIP_ID_MISMATCH, WRONG_SOLAR_SYSTEM, MODULE_NOT_FOUND. The command was
  // aimed at a ship or a place that is no longer the one you are in.
  DeniedShipChanged:
    "Your ship is no longer where that command expected it. Check where you are and try again.",
  // dogma targeting / activation — TARGET_WARPING.
  DeniedTargetOtherWarping:
    "That target is warping away, so it cannot be locked or shot.",
  // dogma targeting / activation — TARGET_SELF.
  DeniedTargetSelf:
    "You cannot do that to your own ship.",
  // dogma targeting / activation — SOURCE_WARPING.
  DeniedTargetSelfWarping:
    "Your ship is in warp, so it cannot lock or shoot anything. Wait until it lands.",
  // dogma `_throwTargetingUserError` DEFAULT arm — the lock failed and the
  // server named no cause. Saying anything specific here would be a guess.
  DeniedTargetingAttemptFailed:
    "The lock did not take, and the server did not say why.",
  // beyonce Handle_CmdDock / structure docking — out of docking range. The
  // server has ALREADY started closing the distance itself (it converts the
  // dock into a followBall to 2,500 m), which is why this says "closing in"
  // rather than telling the player to fly there.
  DockingApproach:
    "You are too far from the station to dock. Your ship is closing in — try docking again once it arrives.",
  // beyonce / structure docking — module blocks docking, ship excluded, ship
  // too large, structure access denied. Six distinct server reasons collapse to
  // this one code on the wire (their prose sits under a `reason` key the
  // gateway does not read), so the sentence must NOT name one of them.
  DockingRequestDenied:
    "Docking was refused. Something about your ship or that station is not allowing it right now.",
  // dogma `_throwModuleActivationUserError` — MODULE_ALREADY_ACTIVE.
  EffectAlreadyActive2:
    "That module is already running.",
  // dogma `_throwModuleActivationUserError` — MAX_GROUP_ACTIVE.
  EffectCrowdedOut:
    "Your ship already has as many modules of that kind running as it is allowed.",
  // dogma Handle_CreateNewbieShip — every failure that is neither of its other
  // two. The server names no cause, so none is given.
  ErrorCreatingNewbieShip:
    "A corvette could not be made ready for you, and the server did not say why.",
  // invbroker Handle_GetInventoryFromId — the itemID bound no inventory target.
  // It covers TWO server conditions that arrive as one code: the item does not
  // exist, and the item exists but failed the handler's own scene/range check.
  // The sentence must therefore name neither, because the wire cannot tell them
  // apart (`refusalLedger.ts` separates them for the bot with the grid snapshot,
  // which a bare panel read does not hold).
  FakeItemNotFound:
    "That ship or container is no longer there, or is too far away to reach.",
  // fleetObjectHandler Handle_LeaveFleet (ensureFleetMembership) — the pilot is
  // no member of the fleet the object is for: it was left, or the pilot was
  // put out of it, since the page last read it.
  FleetNotInFleet:
    "You are not in that fleet.",
  // dogma `_throwModuleActivationUserError` — MODULE_REACTIVATING.
  ModuleReactivationDelayed2:
    "That module is still cooling down from its last cycle. Give it a moment.",
  // dogma Handle_CreateNewbieShip — the session is not docked. Thrown by no
  // other handler, so the sentence can name what was asked for.
  MustBeDocked:
    "You must be docked to board a corvette.",
  // dogma `_throwModuleActivationUserError` — NO_AMMO.
  NoCharges:
    "That module has no ammunition loaded. Load some before using it.",
  // dogma `_throwModuleOnlineUserError` — NOT_ENOUGH_CPU / POWER / CAPACITOR.
  // The code names capacitor but the arm covers all three fittings resources,
  // so the sentence covers what the arm covers rather than what the code says.
  NotEnoughCapacitorForOnline:
    "Your ship does not have enough power, CPU or capacitor to bring that module online.",
  // invbroker Add / MultiAdd — the destination hold has no room for the stack.
  // Reachable via the docked hangar→ship-hold move. The client moves only what
  // fits, so this is the backstop for a hold that is already full (or a capacity
  // read that went stale between the fit calc and the move).
  NotEnoughCargoSpace:
    "There isn't enough room in that hold.",
  // officeManager Handle_RentOffice — the corporation's wallet holds less than
  // the rent. The server names the amount and the balance beside the key; what
  // reaches the page is the key alone (measured 2026-10-10), so the sentence
  // names neither, and says "the wallet that pays" because other handlers
  // throw the same key for a pilot's own.
  NotEnoughMoney:
    "There is not enough ISK in the wallet that pays for that.",
  // dogma `_throwModuleActivationUserError` — TARGET_OUT_OF_RANGE for anything
  // that is not a mining laser — and `_throwTargetingUserError` for a lock on
  // something beyond the ship's own targeting range. The sentence is true of
  // both: seen live as "Lock refused: … out of the module's range" for a rock
  // 22 km from a ship that locks to 16.5 km, with no module in it.
  TargetNotWithinRangeGeneric:
    "That target is out of range. Get closer and try again.",
  // dogma targeting / mining lasers / invbroker — TARGET_OUT_OF_RANGE.
  TargetTooFar:
    "That is too far away. Get closer and try again.",
  // beyonce jump (STARGATE_NOT_FOUND / DESTINATION_MISMATCH), dogma targeting
  // (TARGET_NOT_FOUND), structure docking (STRUCTURE / STATION_NOT_FOUND).
  TargetingAttemptCancelled:
    "What that command was aimed at is not there any more, so it was cancelled.",
  // dogma `_throwTargetingUserError` — TARGET_LOCK_LIMIT_REACHED.
  TargetingSystemsAlreadyFullyUtilized:
    "Your ship is already locking as many targets as it can hold. Release one first.",
  // beyonce `_enforceMovementCommandThrottle` — the same movement command
  // inside 1,000 ms. The remainingTime the server sends is dropped by the
  // gateway, so we cannot tell the player how long, and do not pretend to.
  ThrottleGeneric:
    "That command came too soon after the last one. Wait a moment and try again.",
  // beyonce `_throwWarpFailureUserError` — WARP_DISRUPTED_BY_BUBBLE.
  WarpDisrupted:
    "Something is holding your ship in place, so it cannot warp.",
});

/**
 * The transport and request-shape failures the BFF and this client raise, keyed
 * by the wire `error` code (docs/bridge-wire-contract.md, `BridgeErrorCode` in
 * wire.ts, and the codes `src/server.js` returns from the flight-family routes).
 *
 * These are not the game refusing — they are the pipe. A player still has to
 * learn the action did not happen, and SCREAMING_SNAKE is no more player
 * language than camelCase is.
 *
 * ⚠ CALL_REFUSED IS DELIBERATELY ABSENT. It is the envelope that CARRIES a
 * server refusal, never a reason in itself; if it were here it would shadow the
 * real reason in the message (see the candidate ordering in `describeRefusal`).
 */
const BRIDGE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE: "Offline provisioning is unavailable on this server. Select the pilot and use Ready Fit or Replenish.",
  SKILL_ACQUISITION_UNAVAILABLE: "Direct skill purchase is unavailable through this server's web interface. Inject skillbooks in the game client, then refresh Training.",
  STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE: "Structure service permissions cannot be verified through this server's web interface. Station actions remain available.",
  PROVISIONING_RECOVERY_AUTHORITY_UNAVAILABLE: "Custody recovery cannot safely acquire an offline pilot through this server. Existing custody evidence remains reserved for recovery.",
  // --- eve.js gateway (evejsWebGatewayRuntime.js) ---
  CALL_FAILED: "The game server hit an error carrying that out.",
  CALL_NOT_ALLOWED: "This client is not allowed to ask the game server for that.",
  CALL_INVALID: "The game server could not make sense of that request.",
  CALL_SERVICE_UNAVAILABLE: "That part of the game server is not available right now.",
  GATEWAY_RUNTIME_NOT_READY: "The game server is still starting up. Try again shortly.",
  UNAUTHORIZED: "The game server did not accept this session.",

  // --- BFF transport (src/server.js) ---
  EVE_GATEWAY_UNREACHABLE: "The game server could not be reached.",
  EVE_GATEWAY_TIMEOUT: "The game server did not answer in time.",

  // --- eve.js gateway edge->owner verdicts (edgeProcessHost.js) ---
  EDGE_OWNER_REQUEST_TIMEOUT: "The game server did not answer in time.",
  EDGE_OWNER_OVERLOADED: "The game server is busy right now. Try again in a moment.",
  AUTH_REQUIRED: "You are signed out. Sign in again to carry on.",
  NO_LIVE_SESSION: "No character is online. Pick a character first.",
  SESSION_NOT_FOUND: "The live session ended. Pick your character again.",

  // --- BFF session-change barrier (src/transitionBarrier.js) ---
  SESSION_CHANGE_IN_PROGRESS: "The last session change is still settling. Give it a moment.",
  TRANSITION_TIMEOUT:
    "The session change did not finish in time. Check where your ship ended up before trying again.",

  // --- BFF request checks on the flight-family routes ---
  ALREADY_IN_SPACE: "Your ship is already in space.",
  NOT_IN_SPACE: "Your ship is docked. Undock before doing that.",
  NOT_DOCKED: "Your ship is in space. That can only be done while docked.",
  NO_ACTIVE_SHIP: "You are not in a ship right now.",
  NO_DRONES: "There are no drones in the bay to launch.",
  NOTHING_SELECTED: "Nothing was selected to act on.",
  INVALID_GATE: "That gate could not be identified.",
  INVALID_STATION: "That station could not be identified.",
  INVALID_MODULE: "That module could not be identified.",
  INVALID_SHIP: "That ship could not be identified.",
  INVALID_TARGET: "That target could not be identified.",
  INVALID_RANGE: "That distance is not one the ship can be told to hold.",
  CHARACTER_NOT_FOUND: "Your character could not be read.",
  STATION_NOT_FOUND: "That station could not be found.",

  // --- client-side, never reaches the server (callMethod.ts) ---
  BRIDGE_NETWORK_ERROR: "The connection to the server dropped. Check it and try again.",
  BRIDGE_BAD_RESPONSE: "The server's answer could not be read.",
});

// --- Transport-transient errors ----------------------------------------------
//
// These three codes mean the PIPE did not answer — they say nothing about what
// the game decided, and the command may well have landed (a 10 s abort races a
// call the gateway finishes an instant later). A decide-loop must therefore
// never read one as a refusal: the honest response is to re-read authoritative
// state next tick and let a BOUNDED retry settle it, exactly as both bot loops
// already do for a failed status read. Kept here because this file is the one
// place the vocabulary of arriving errors is pinned.
const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "EVE_GATEWAY_TIMEOUT",
  "EVE_GATEWAY_UNREACHABLE",
  "BRIDGE_NETWORK_ERROR",
  // The gateway edge's own verdicts: a request that queued past the owner
  // deadline (outcome unknown — same semantics as a gateway timeout) and a
  // full owner queue (definitely not executed — retry is safe).
  "EDGE_OWNER_REQUEST_TIMEOUT",
  "EDGE_OWNER_OVERLOADED",
]);

/**
 * Is this thrown error a transport failure whose outcome is UNKNOWN (retry
 * after re-observing), as opposed to the game refusing (classify) or the
 * session being gone (stop)? Duck-typed on `.code` so the nav loops need no
 * dependency on the app layer's error class.
 */
export function isTransportTransient(error: unknown): boolean {
  return errorCode(error) !== "" && TRANSIENT_TRANSPORT_CODES.has(errorCode(error));
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

/**
 * The BFF turned the command back because a previous session change is still
 * settling (409 SESSION_CHANGE_IN_PROGRESS). Transient BY DESIGN: the barrier
 * either becomes ready within its own deadline or its latch heals on the next
 * status poll — both of which the decide-loops perform every tick. A loop must
 * wait this out generously (a dock barrier plus the next-mutation cooldown is
 * legitimately close to a minute), never pause on the first one.
 */
export function isSessionChangeSettling(error: unknown): boolean {
  return errorCode(error) === "SESSION_CHANGE_IN_PROGRESS";
}

/**
 * The session-change barrier gave up waiting (504 TRANSITION_TIMEOUT): the
 * command was issued once and its outcome is UNKNOWN — the same "re-read the
 * authority before believing anything" semantics as a transport failure, which
 * is exactly how the loops treat it. The BFF's latch self-heals on the next
 * flight-status read, so retrying after re-observing is legal.
 */
export function isTransitionTimeout(error: unknown): boolean {
  return errorCode(error) === "TRANSITION_TIMEOUT";
}

// --- R33: the refusals we can see coming ------------------------------------
//
// ⚠ THESE ARE NOT WIRE STRINGS, and they are deliberately NOT in
// SERVER_REFUSALS. That table is the vocabulary of refusals that ARRIVE, pinned
// key-for-key against the codes a browser call can provoke; putting a sentence
// there that no wire message maps to would corrupt the one table whose value is
// that it matches the server exactly.
//
// This is the other half of the same job. A PREDICTED refusal is one the client
// can source from a field it already holds, BEFORE the player presses anything
// — so the control renders disabled wearing the reason instead of inviting a
// press that goes nowhere. The wording lives here for the same reason every
// other refusal's does: refusals.ts is the only place in this app where "the
// action will not happen" becomes words a player reads, and a sentence kept
// anywhere else drifts out of reach of the R9a sweep that pins it.
//
// ⚠ THE BAR FOR ADDING ONE IS A SERVER GATE YOU CAN POINT AT, not a hunch. If
// the client cannot tell, the control STAYS ENABLED and the server's own
// refusal answers — a disabled button asserting a reason we cannot source is a
// worse failure than an enabled one that gets a true answer.

/**
 * A drone your ship is not flying (goal R33).
 *
 * SOURCED FROM: `droneRuntime.js` refuses every drone order — recall, engage,
 * mine, salvage, abandon; five call sites, one condition — unless
 * `droneEntity.controllerID === shipRecord.itemID`. The server's own words for
 * it are "That drone is not currently under this ship's control."; this says
 * the same thing in the second person, because we are saying it BEFORE the
 * press rather than relaying an answer.
 *
 * ⚠ IT NAMES NO REMEDY, on purpose. Regaining control is
 * `entity.CmdReconnectToDrones`, which is NOT in the gateway's
 * WEB_CALL_ALLOWLIST — this client cannot dispatch it. Telling a player to
 * reconnect would be sending them after a button that does not exist here, and
 * an invented remedy is the same failure as an invented reason.
 */
export const DRONE_NOT_UNDER_YOUR_CONTROL = "Your ship is not flying this drone";

/** The same fact about a whole flight, for the group order (goal R33). */
export const NO_DRONE_UNDER_YOUR_CONTROL = "Your ship is not flying any of these drones";

// --- R43: what a bot needs before it will start -----------------------------
//
// The same mechanism as the drone sentences above, pointed at a different kind
// of gate. A bot's requirement IS a predicted refusal by the definition this
// section already uses — the client sources it from a field it holds, before
// the player presses anything, and says it on the control instead of letting a
// press go nowhere. It is a THIRD table only if you write it somewhere else, so
// it is not written somewhere else.
//
// ⚠ THE "SERVER GATE YOU CAN POINT AT" BAR STILL APPLIES; the gate is simply
// the bot's own ladder rather than a handler. Each sentence below names the
// condition under which `nav/miningBotLoop.ts` or `nav/missionBotLoop.ts` would
// refuse to make progress, so nothing here is a hunch about what MIGHT go
// wrong — it is the loop's own bound, said before the run instead of after it.
//
// ⚠ AND THERE ARE TWO SENTENCES PER UNREADABLE CHECK, not one. "You are docked"
// and "we could not tell where you are" send a player to different places, and
// collapsing them would hide a failed read behind a confident answer — which is
// exactly the thing the cannot-tell verdict exists to stop.

/**
 * SOURCED FROM: the ladder's mine step activates the modules in the plan, so a
 * hull carrying no mining equipment cannot leave the "waiting to mine" arm.
 *
 * ⚠ TWO SENTENCES, NOT ONE, because they are two different problems with two
 * different fixes. "You have not got one" sends a player to the Fitting tab;
 * "you have one and it is switched off" is one click on a row they are already
 * looking at. Collapsing them would send half of those players to the wrong
 * place.
 *
 * ⚠ AND NEITHER NAMES A SLOT. Mining equipment being high-slot-only is how the
 * CHECK works, not something a player needs told — "fit it in a high slot" is
 * the kind of jargon R9a exists to keep off the screen.
 */
export const MINING_BOT_NEEDS_A_MINER =
  "This ship has no mining equipment fitted. Fit a mining laser under Fitting and come back.";

/**
 * SOURCED FROM: the same step — a module that is not online cannot be activated.
 *
 * ⚠ IT NAMES THE REMEDY THIS CLIENT CAN ACTUALLY OFFER. Powering a module up is
 * a control on the row under Around Your Ship (R30 slice E), not a trip to the
 * Fitting tab, so that is where it points.
 */
export const MINING_BOT_NEEDS_THE_MINER_ON =
  "Your mining equipment is fitted but not switched on. Power it up under Around Your Ship.";

/** SOURCED FROM: the plan's beltID is what the ladder warps to; without one there is nowhere to go. */
export const MINING_BOT_NEEDS_A_BELT = "Pick the asteroid belt you want the bot to work.";

/** SOURCED FROM: the plan's stationID is where a full hold is hauled; without one the haul step has no destination. */
export const MINING_BOT_NEEDS_A_STATION =
  "Pick the station you want the bot to take the ore to.";

/** SOURCED FROM: the plan's agentID is who the ladder asks for work. */
export const MISSION_BOT_NEEDS_AN_AGENT = "Pick the agent you want the bot to work for.";

/** SOURCED FROM: the ladder flies to the agent's OWN station before asking, so that station has to be known. */
export const MISSION_BOT_NEEDS_AGENT_STATION =
  "The station that agent works from is not known, so the bot has nowhere to fly to.";

/**
 * The cannot-tell sentences.
 *
 * Each says the same two true things: we could not make the check, and the bot
 * has therefore not started. None of them guesses at a cause, and none of them
 * tells the player the thing is wrong — only that it is unread.
 */
export const UNCHECKABLE_WHERE_YOU_ARE =
  "Could not read where your ship is, so the bot has not started. Try again in a moment.";

export const UNCHECKABLE_MINERS =
  "Could not read what is fitted to your ship, so the bot has not started. Try again in a moment.";

export const UNCHECKABLE_HOLD =
  "Could not read how much room is in your hold, so the bot has not started. Try again in a moment.";

/** Every predicted refusal this client can put on a control. Exported for the tests. */
export const PREDICTED_REFUSAL_TEXTS: readonly string[] = Object.freeze([
  DRONE_NOT_UNDER_YOUR_CONTROL,
  NO_DRONE_UNDER_YOUR_CONTROL,
  MINING_BOT_NEEDS_A_MINER,
  MINING_BOT_NEEDS_THE_MINER_ON,
  MINING_BOT_NEEDS_A_BELT,
  MINING_BOT_NEEDS_A_STATION,
  MISSION_BOT_NEEDS_AN_AGENT,
  MISSION_BOT_NEEDS_AGENT_STATION,
  UNCHECKABLE_WHERE_YOU_ARE,
  UNCHECKABLE_MINERS,
  UNCHECKABLE_HOLD,
]);

// --- R43: what a bot will DO about a box the checklist has not ticked -------
//
// ⚠ THESE ARE NOT REFUSALS AND MUST NOT BE FILED AS ONES. A refusal says the
// thing will not happen; each sentence below says the opposite — the bot has
// seen the state and will resolve it itself on its first rungs.
//
// They exist because the obvious version of this checklist was WRONG, and
// wrong in the exact way MissionBot.svelte's own comment already records
// having been fixed once: both loops handle their "wrong" starting state.
// `missionBotLoop.ts:552` reads "in space with no flight of ours running" and
// flies to the station it needs; `miningBotLoop.ts:422` reads a docked ship and
// unloads, then undocks. Gating a start on "you must be docked" or "you must be
// in space" would have made the LAUNCHER NARROWER THAN THE BOT — refusing a
// start the ladder underneath handles perfectly well, and breaking the
// live-proven restart-while-docked path in the process.
//
// So the state is still declared, still checked and still shown — it just does
// not block, and it reads as what will happen rather than as a complaint.

/** SOURCED FROM: miningBotLoop's docked branch — unload, confirm the hold is empty, then undock. */
export const MINING_BOT_WILL_UNDOCK =
  "Your ship is docked. The bot will unload anything aboard and undock before it starts mining.";

/** SOURCED FROM: the same branch — a full hold is taken in before anything new is mined. */
export const MINING_BOT_WILL_UNLOAD_FIRST =
  "Your hold is nearly full. The bot will take this load in before it mines anything new.";

/** SOURCED FROM: missionBotLoop's in-space branch — it flies to where the ladder needs the ship. */
export const MISSION_BOT_WILL_FLY_TO_AGENT =
  "Your ship is out in space. The bot will fly to the station and dock before it asks for work.";

/** Every "the bot will handle it" sentence. Exported for the tests. */
export const BOT_ADVISORY_TEXTS: readonly string[] = Object.freeze([
  MINING_BOT_WILL_UNDOCK,
  MINING_BOT_WILL_UNLOAD_FIRST,
  MISSION_BOT_WILL_FLY_TO_AGENT,
]);

/** Every server refusal string this client explains in words. Exported for the tests. */
export const SERVER_REFUSAL_KEYS: readonly string[] = Object.freeze(
  Object.keys(SERVER_REFUSALS),
);

/** Every bridge/transport code this client explains in words. Exported for the tests. */
export const BRIDGE_REFUSAL_CODES: readonly string[] = Object.freeze(
  Object.keys(BRIDGE_REFUSALS),
);

/**
 * What the player is told when the refusal is one we have never seen.
 *
 * It says two true things — it was refused, and we cannot put the reason into
 * words — and it invents nothing. The raw text rides along as `Refusal.detail`
 * so a bug report can still carry it.
 */
export const UNKNOWN_REFUSAL_TEXT =
  "The server turned that down without a reason this client can put into words.";

/** What the player is told when the refusal carries no text at all. */
export const SILENT_REFUSAL_TEXT = "The server turned that down without saying why.";

// --- Is this a sentence, or is it jargon? -----------------------------------

/**
 * True when `text` is something a player can read — the R9a predicate.
 *
 * ⚠ THIS IS LOAD-BEARING TWICE, on purpose. At runtime it decides whether an
 * UNRECOGNISED refusal is the server speaking plainly (pass it through — over
 * 130 handlers refuse with a real sentence via CustomNotify, and rewording
 * those would be us talking over the server) or jargon (fall back, keep the raw
 * as detail). In the tests it is the sweep that proves no rendered refusal can
 * regress into a code. One predicate means the two can never disagree.
 *
 * It is deliberately conservative: anything it cannot vouch for is treated as
 * jargon, because showing a clean fallback for a real sentence is a much
 * smaller failure than showing a resource key to a player.
 */
export function isPlainPlayerLanguage(text: string): boolean {
  const value = text.trim();
  if (value === "") {
    return false;
  }
  // A single token is a name, not a sentence — no player writes `DockingApproach`.
  if (!/\s/.test(value)) {
    return false;
  }
  // A resource path: `UI/Menusvc/MenuHints/...`, `/Carbon/MachoNet/...`.
  if (/[A-Za-z]\/[A-Za-z]/.test(value)) {
    return false;
  }
  // The retail localization tuple leaking through as `101,UI/...`.
  if (/^\d+\s*,/.test(value)) {
    return false;
  }
  // SCREAMING_SNAKE — CALL_REFUSED, MISSING_MATERIAL, NOT_IN_SPACE.
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(value)) {
    return false;
  }
  // An identifier with an internal lower-to-upper hinge: `NotWithingMaxJumpDist`,
  // `destinationID`, `solarSystemID`. The two characters must be ADJACENT, so
  // this only ever fires inside a single word — which is why prose survives it:
  // "Heavy Interdictor" and "…try again. Get closer" both have a space or a
  // full stop at the hinge, and a proper noun has no hinge inside itself.
  if (/[a-z][A-Z]/.test(value)) {
    return false;
  }
  return true;
}

// --- The seam ---------------------------------------------------------------

/**
 * Split a raw refusal into the strings we might recognise.
 *
 * `flightErrorReason` and friends hand us either the bare wire message
 * (`DockingApproach`), the bare code (`NOT_IN_SPACE`), or the two joined
 * (`CALL_REFUSED: DockingApproach`). The whole string is tried first so a
 * genuine sentence containing a colon is not chopped up; then the part AFTER
 * the colon, so the server's specific reason beats the envelope; then the part
 * before it.
 */
function refusalCandidates(raw: string): string[] {
  const value = raw.trim();
  const separator = value.indexOf(":");
  if (separator < 0) {
    return [value];
  }
  return [
    value,
    value.slice(separator + 1).trim(),
    value.slice(0, separator).trim(),
  ];
}

/**
 * A server refusal, as a sentence plus the raw text behind it.
 *
 * `raw` is whatever the wire produced — the CALL_REFUSED message, a bridge
 * code, or the two joined with a colon. Nothing here throws and nothing here
 * returns an empty string: every input produces a sentence, because the caller
 * is going to show it to somebody.
 */
export function describeRefusal(raw: string): Refusal {
  const value = String(raw ?? "").trim();
  if (value === "") {
    return { text: SILENT_REFUSAL_TEXT, detail: null };
  }
  const candidates = refusalCandidates(value);
  for (const candidate of candidates) {
    const known = SERVER_REFUSALS[candidate] ?? BRIDGE_REFUSALS[candidate];
    if (known !== undefined) {
      return { text: known, detail: value };
    }
  }
  // Not in the table. If the server spoke plainly, those are its words and they
  // stand — we are not in the business of rewording a handler that already said
  // something a player can act on.
  //
  // ⚠ THE CANDIDATES ARE CHECKED, NOT JUST THE WHOLE STRING, and that is not a
  // nicety: the prose case almost always arrives with the wire envelope glued
  // to the front — `CALL_REFUSED: You do not have the required roles.` — and
  // testing only the whole string would see the SCREAMING_SNAKE prefix, call
  // the entire thing jargon, and throw away a perfectly good sentence the
  // server had already written for the player.
  for (const candidate of candidates) {
    if (isPlainPlayerLanguage(candidate)) {
      // No detail: the envelope is all that was dropped, and nothing a
      // diagnostician needs was lost.
      return { text: candidate, detail: null };
    }
  }
  // Jargon we do not recognise. The player gets a sentence; the raw text stays
  // recoverable rather than being thrown away OR shoved in their face.
  return { text: UNKNOWN_REFUSAL_TEXT, detail: value };
}

/**
 * The player-facing half of `describeRefusal`, with the raw text put where a
 * diagnostician can still find it.
 *
 * ⚠ THE CONSOLE LINE IS THE "RECOVERABLE" HALF OF R31, not a debug leftover.
 * The player reads prose; anyone chasing a refusal this table has never seen
 * reads exactly what the server said. It fires ONLY when the wording is not
 * already the server's own — `describeRefusal` returns a null detail when the
 * handler spoke plainly, and echoing a sentence we did not change is noise.
 *
 * This is the one impure function in this module on purpose: keeping the log
 * beside the translation is what stops the raw text being silently dropped at
 * one of the fifteen call sites. `describeRefusal` stays pure for the tests.
 */
export function refusalWords(raw: string): string {
  const refusal = describeRefusal(raw);
  if (refusal.detail !== null) {
    console.info(`[refusal] ${refusal.detail}`);
  }
  return refusal.text;
}

/**
 * How a PANEL should word a caught error (goal R92).
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE PATTERN THIS REPLACES SHIPPED THE ROUTE NAME TO THE PLAYER.
 *
 * Twenty-three panels caught a failure and rendered `${cause.code}: ${cause.message}`,
 * which is how a player came to report, verbatim:
 *
 *   BRIDGE_NETWORK_ERROR: /api/bridge/journal could not reach the BFF: signal timed out
 *
 * Three things are wrong with that sentence and only one of them is cosmetic.
 * It is jargon in a player's face (R9a). It names an internal route, which is
 * not a thing a player can act on or should have to read. And — the expensive
 * one — it points at the WRONG SUBJECT: that read was a bystander to a stalled
 * connection, so everyone who saw the report went and looked at the journal
 * route, where there was never anything to find.
 *
 * So: the plain sentence for the code, then the lane's own verdict when the
 * failure was transport. The verdict is written to be read by whoever files the
 * next report — it is the half that says whether the server ignored the request
 * or the request never got a connection to be sent on, and the second of those
 * leaves nothing in any server log.
 *
 * The technical string stays on `error.message` for the console. It is not lost;
 * it is just no longer the thing a player is shown.
 */
export function panelErrorWords(cause: unknown): string {
  if (cause === null || cause === undefined) {
    return SILENT_REFUSAL_TEXT;
  }
  const code = errorCode(cause);
  const diagnosis =
    typeof (cause as { diagnosis?: unknown }).diagnosis === "string"
      ? String((cause as { diagnosis?: unknown }).diagnosis)
      : "";
  if (code !== "") {
    // CALL_REFUSED is the envelope a server's refusal comes in and never a reason itself (it has no sentence, by
    // design): the reason is its message, a key the table words or the server's own sentence. Every other code
    // is its own reason, and its message is for a console.
    const raw = code === "CALL_REFUSED" && cause instanceof Error ? `${code}: ${cause.message}` : code;
    const words = describeRefusal(raw).text;
    return diagnosis === "" ? words : `${words} ${diagnosis}`;
  }
  // Not one of ours — a decode blowing up, say. Its own message is all there is,
  // and saying nothing would be worse than saying something technical.
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.trim() === "" ? SILENT_REFUSAL_TEXT : message;
}
