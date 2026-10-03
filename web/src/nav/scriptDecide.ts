// A4b — the tick orchestrator: given a script, a fresh observation, and the
// running memory, decide the ONE action this tick, and hand back the next
// memory. Pure and total — it always returns exactly one action (wait included)
// with a why, so bounds can dispatch on it and no tick is ever empty of a
// decision.
//
// ─── THE SHAPE OF A TICK ─────────────────────────────────────────────────────
//
//   1. If a "dock and stop" interrupt already fired, the ship is flying home;
//      keep flying it, then pause once docked.
//   2. Otherwise, interrupts first (A4a): a met one fires; a pirate with an
//      unreadable ship pauses.
//   2.7 A STOP NEVER HAPPENS IN SPACE. Every fault the runner cannot work
//      through — a blocked macro, the livelock guard, the step-tick cap, the
//      cannot-tell streak, an unknown macro, the sealed acute pause — and the
//      player's own "just stop" watch LATCH and fly the ship home first, then
//      pause docked with the reason that sent it there. A bot parked in a belt
//      is food: the rats keep coming and nobody is flying. `stopSafely` is the
//      only way any of them stops, and the only bare pauses left in this file
//      are the two at the END of that flight home (arrived, or it cannot be
//      flown), which must be terminal or the ship would latch forever.
//   3. Otherwise, the FORWARD SCAN runs the program: consult the active step's
//      macro, and if the step is finished (its `until` met while the macro is
//      armed, or the macro reports itself done) advance to the next node and
//      consult it IN THE SAME TICK — never backwards except a loop re-entering
//      its own body, counted against its repeat.
//
// ─── WHY IT CANNOT LIVELOCK ──────────────────────────────────────────────────
//
// The scan records every position it visits this tick. Coming back to one it
// already tried means the program made a full loop emitting nothing — the exact
// "a tick can legally emit no world call" primitive the phases model died of.
// That is not silently tolerated: it pauses with a plain reason. A step that
// goes on emitting nothing (a macro-internal counter gap) trips
// MAX_SILENT_STEP_TICKS. A read that stays unreadable trips the cannot-tell
// streak. Every way of doing nothing has a bound.

import { countSteps } from "../bots/botScript.ts";
import type {
  BotScript,
  BranchBlock,
  Condition,
  LoopBlock,
  MacroID,
  MacroStep,
  SquadRoleArg,
} from "../bots/botScript.ts";
import { alertSentence, conditionSentence, stepSentence } from "../bots/scriptText.ts";
import { decideMiningDroneFlight, freshDroneMemory, type MiningDroneMemory } from "./miningDroneFlight.ts";
import { confirmedDrain } from "./miningLogistics.ts";
import { hostileRows } from "../space/overview.ts";
import { settleCombat, combatOwnership, ownCombatAction } from "./combatOwnership.ts";
import { combatCapSustain } from "./combatUtilities.ts";
import {
  SENTENCE as COND_SENTENCE,
  bumpCannotTellStreak,
  cannotTellStreakExhausted,
  evaluateCondition,
  firstArmedInterrupt,
  hostilesInReach,
  releaseSpentAlerts,
  resolveInterrupt,
  type ScriptObservation,
} from "./scriptConditions.ts";

// ─── The one action a tick emits ─────────────────────────────────────────────

export type ScriptAction =
  | { readonly kind: "maintainMiningSupport"; readonly relocating: boolean }
  | { readonly kind: "stopMiningSupportOperation" }
  | { readonly kind: "wait" }
  | { readonly kind: "undock" }
  | { readonly kind: "dock"; readonly stationID: number }
  | { readonly kind: "warp"; readonly targetID: number }
  | { readonly kind: "approach"; readonly targetID: number }
  | { readonly kind: "gotoPoint"; readonly position: import("../store/types.ts").SpaceVector; readonly shipID: number; readonly solarSystemID: number }
  /**
   * Cut the engines (api.stopShip). The one action here that UNDOES a standing
   * order rather than issuing one, and the only order eve.js does not gate on a
   * pending warp landing — see scriptMacros' `travelStall`, which emits this to
   * free a hull whose approach the server is silently refusing.
   */
  | { readonly kind: "stopShip" }
  | { readonly kind: "align"; readonly targetID: number }
  | { readonly kind: "orbit"; readonly targetID: number; readonly range: number }
  /** Hold off a target at a set distance (api.keepAtRange) — "stand off", not "circle". */
  | { readonly kind: "keepAtRange"; readonly targetID: number; readonly range: number }
  /**
   * SET a fleet target tag (api.setFleetTargetTag; server confirm-gated, but its
   * ack proves nothing for a non-commander — see the wrapper's own warning and
   * bridge/fleetCommand.ts). The decider that emits this has already checked
   * `ScriptObservation.canTag`; this action carries no gate of its own.
   */
  | { readonly kind: "setFleetTargetTag"; readonly targetID: number; readonly tag: string }
  | { readonly kind: "jump"; readonly fromGateID: number; readonly toGateID: number }
  | { readonly kind: "lock"; readonly targetID: number }
  | { readonly kind: "unlock"; readonly targetID: number }
  | { readonly kind: "activate"; readonly moduleID: number; readonly targetID: number; readonly typeID?: number; readonly utility?: true; readonly repeat?: 0; readonly capDemandFloor?: number }
  | { readonly kind: "loadCombatAmmo"; readonly moduleID: number; readonly chargeItemID: number; readonly chargeTypeID: number; readonly utility?: true }
  /**
   * Switch a fitted module OFF. No target: deactivation always names the
   * caster's own fit.
   *
   * ⚠ `typeID` IS NOT DECORATION, AND LEAVING IT OFF A PROPULSION MODULE IS A
   * CALL THAT RETURNS SUCCESS AND DOES NOTHING. The server stops an afterburner
   * or a microwarpdrive only when the Deactivate NAMES that module's propulsion
   * effect, and the BFF resolves that effect name from the typeID alone (see
   * `api.deactivateModule`'s own header, the route in src/server.js, and
   * nav/propulsion.ts's warning). Without it the burner keeps cycling, the
   * signature stays bloomed, the capacitor keeps draining, and the block that
   * issued the stop falls through happily believing the rack now agrees with it
   * — so it never tries again.
   *
   * ⚠ IT IS OPTIONAL BECAUSE AN ORDINARY MODULE STOPS WITHOUT IT. Every existing
   * emitter — the repair thermostat, the fight-back stand-down, the mine-at-belt
   * step exit — switches off a repairer or a hardener, which needs no effect
   * name and behaves identically whether the key is present or absent. Only a
   * prop mod cares, and only the rung that names one fills this in.
   */
  | { readonly kind: "deactivate"; readonly moduleID: number; readonly typeID?: number; readonly settlement?: true }
  | { readonly kind: "launchDrones"; readonly droneItemIDs: readonly number[] }
  | { readonly kind: "engageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  | { readonly kind: "mineDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  | { readonly kind: "recallDrones"; readonly droneIDs: readonly number[] }
  | { readonly kind: "bookmarkMiningSite"; readonly targetKey: string }
  /**
   * Put the freight ashore at the station the ship is docked at.
   *
   * `division` aims it at a CORPORATION hangar division instead of the pilot's
   * own hangar. It is OPTIONAL because the personal hangar is what every
   * emitter but one means, and because it is a REQUEST rather than a
   * destination: the office may not be there, the pilot may not hold the role,
   * and the bridge then lands the load in the pilot's own hangar and reports
   * which happened. A block that named a division still finishes its lap.
   */
  | { readonly kind: "unloadOre"; readonly itemIDs: readonly number[]; readonly division?: number; readonly strictCorp?: boolean }
  // ── Mission actions (the distribution blocks). Each is one proven mission-bot
  //    operation: a labeled button press in the agent conversation, a handoff to
  //    the shared autopilot, or a package move confirmed by re-read next tick.
  | { readonly kind: "agentButton"; readonly agentID: number; readonly actionID: number; readonly label: string }
  | { readonly kind: "startRoute"; readonly stationID: number }
  | { readonly kind: "loadMissionCargo"; readonly typeID: number; readonly quantity: number }
  | { readonly kind: "unloadMissionCargo"; readonly itemIDs: readonly [number]; readonly quantity: number }
  /**
   * Empty the ship's FREIGHT into the station hangar — the cargo hold and every
   * specialised bay carrying cargo — one group per source place, because a move
   * must name the place the items are actually in. `bay: null` is the cargo
   * hold. Distinct from `unloadMissionCargo`, which only ever means "the one
   * package the mission put in cargo".
   */
  | {
      readonly kind: "unloadHolds";
      readonly groups: readonly { readonly bay: string | null; readonly itemIDs: readonly number[] }[];
      /**
       * A corporation hangar division (1-7) to unload into instead of the
       * station hangar. Left OFF, not null, for an ordinary unload, so a block
       * nobody aimed at a corporation issues the action it always did.
       */
      readonly division?: number;
    }
  /**
   * Fill the ship FROM the station hangar — `unloadHolds` run backwards, one
   * group per destination because a bay is a different place from the cargo
   * hold. `bay: null` is the cargo hold.
   *
   * ⚠ `qty` IS WHY THE GROUPS CARRY ONE MORE FIELD THAN THE UNLOAD'S DO. A
   * transfer is all-or-nothing per stack, so a hangar stack of twenty command
   * centres bound for a hold with room for six has to be SPLIT — and the bridge
   * refuses a quantity when more than one item is named, so a split group is
   * always exactly one stack (`planLootTransfers` guarantees both).
   */
  | {
      readonly kind: "loadHolds";
      readonly groups: readonly {
        readonly bay: string | null;
        readonly itemIDs: readonly number[];
        readonly qty: number | null;
      }[];
    }
  /** Order salvage drones onto a wreck; targetID 0 = the runtime auto-picks. */
  | { readonly kind: "salvageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /** Take everything out of ONE wreck (an owned wreck — the decider guarantees it). */
  | { readonly kind: "lootWreck"; readonly wreckID: number }
  /** Take everything out of ONE container (any container on grid — no ownership check). */
  | { readonly kind: "lootContainer"; readonly containerID: number }
  /**
   * Empty ONE planetary launch container of the pilot's own into the ship,
   * then delete its launch record once a re-read shows the container empty.
   *
   * ⚠ THE DELETE IS WHAT MAKES THE LIST MEAN "STILL TO COLLECT". The server
   * despawns only an empty JETCAN; an emptied launch container stays in space
   * and on GetMyLaunchesDetails until it decays five days later, so without
   * the delete every later lap would fly back to it. DeleteLaunch touches the
   * record alone (owner-scoped), never an item, and is only sent once the
   * container is seen empty.
   */
  | { readonly kind: "collectLaunch"; readonly containerID: number; readonly launchID: number }
  /**
   * Empty one planetary CUSTOMS OFFICE into the ship (collect-customs).
   *
   * The office's own storage is partitioned by depositor server-side, so the
   * rows this takes are the pilot's own and no other hauler shares them - which
   * is why, unlike lootContainer, there is no claim to make. And unlike
   * collectLaunch there is no record to delete afterwards: an office is a
   * structure that stays where it is, and the next tick's read of it is what
   * says whether anything is left.
   */
  | { readonly kind: "collectCustoms"; readonly officeID: number }
  | { readonly kind: "haulTransfer"; readonly itemID: number; readonly quantity: number;
      readonly from: import("../store/types.ts").InventoryPlace;
      readonly to: import("../store/types.ts").InventoryPlace;
      readonly stationID: number; readonly locationKind?: "station" | "structure"; readonly corporationID: number; readonly division: number;
      readonly typeID: number; readonly sourceQuantity: number }
  /** Run these hangar stacks through the station refinery (verified server-side). */
  | { readonly kind: "reprocessOre"; readonly itemIDs: readonly number[] }
  /** Warp to a scanned site by its scan-signature label ("QEE-288"). */
  | { readonly kind: "warpScan"; readonly target: string }
  /** Warp to a saved bookmark (the server resolves site/point + mission scope). */
  | { readonly kind: "warpBookmark"; readonly bookmarkID: number }
  /** Board a ship in the station hangar (it becomes the active ship). */
  | { readonly kind: "boardShip"; readonly shipID: number }
  /** Apply a saved fitting to the active ship (modules from this hangar). */
  | { readonly kind: "applyFitting"; readonly fittingID: number }
  /**
   * Restart ONE expired extractor program — the same resource it was pulling,
   * over the same drill area (which is what sets how long it runs).
   */
  | {
      readonly kind: "restartExtractor";
      readonly planetID: number;
      readonly pinID: number;
      readonly resourceTypeID: number;
      readonly headRadius: number;
    }
  /**
   * Re-size ONE extractor's storage routes to its installed program: remove
   * them and create them again at the retail split (bridge/colonyRoutes.ts),
   * as one network edit.
   */
  | {
      readonly kind: "rerouteExtractor";
      readonly planetID: number;
      readonly pinID: number;
      readonly removeRouteIDs: readonly number[];
      readonly create: readonly {
        readonly path: readonly number[];
        readonly typeID: number;
        readonly quantity: number;
      }[];
    }
  /**
   * Launch what ONE colony's command centre is holding into orbit.
   *
   * ⚠ A COMMAND CENTRE, NEVER A LAUNCHPAD. The emulator refuses every other
   * pin with `CanOnlyLaunchFromCommandCenters`, and refuses the same centre
   * twice inside a minute. It charges export tax and leaves a container in
   * space, so this is costly and externally visible.
   */
  | {
    readonly kind: "launchCommodities";
    readonly planetID: number;
    readonly commandPinID: number;
    /** typeID -> quantity, as the planetMgr handler wants it. */
    readonly commodities: Readonly<Record<number, number>>;
  }
  /** Pay the station repair shop to fix these items. */
  | { readonly kind: "repairItems"; readonly itemIDs: readonly number[] }
  /**
   * Tell the BFF's SHARED belt memory that a belt in this system has no rocks
   * left (`groupID` null) or none of one ore family (`groupID` = the family's
   * type group). Keyed by NAMES: belt ids are grid-local and the memory is read
   * by other pilots running the same bot, possibly in other systems.
   */
  | { readonly kind: "rememberBeltDry"; readonly systemName: string; readonly beltName: string; readonly groupID: number | null }
  | { readonly kind: "reserveMiningTarget"; readonly candidates?: readonly import("../app/api.ts").MiningTargetCandidate[];
      readonly targetType: "BELT" | "ORE_ANOMALY" | "ICE"; readonly siteIdentity?: string;
      readonly siteID?: number; readonly instanceID?: number | null; readonly position?: import("../store/types.ts").SpaceVector;
      readonly systemID: number; readonly systemName: string; readonly targetName: string }
  | { readonly kind: "activateMiningTarget"; readonly targetKey: string }
  | { readonly kind: "depleteMiningTarget"; readonly targetKey: string;
      readonly evidence: Readonly<Record<string, string | number | boolean | null>> }
  | { readonly kind: "miningMemberReady" }
  | { readonly kind: "miningDrainComplete"; readonly targetKey: string }
  /**
   * Tell the BFF's SHARED squad board which ship this pilot is on, so the fleet
   * can concentrate its fire (`targetID` null clears the call). Like
   * `rememberBeltDry` this is not a ship command at all — it moves nothing and
   * fires nothing — but it costs a tick like every other action, which is why a
   * calling block only sends it when its primary CHANGES.
   */
  | { readonly kind: "callPrimary"; readonly targetID: number | null }
  /** Move stacks between docked places (hangar / cargo / ore hold), qty = split. */
  | {
      readonly kind: "moveItems";
      readonly itemIDs: readonly number[];
      readonly from: string;
      readonly to: string;
      readonly qty: number | null;
    }
  /** Place a market BUY order (server confirm-gated; spends ISK + broker fee). */
  | { readonly kind: "placeBuyOrder"; readonly typeID: number; readonly price: number; readonly quantity: number }
  /** Place a market SELL order for one owned stack (server confirm-gated). */
  | {
      readonly kind: "placeSellOrder";
      readonly itemID: number;
      readonly typeID: number;
      readonly price: number;
      readonly quantity: number;
    }
  /** Form a fleet (server confirm-gated). */
  | { readonly kind: "createFleet" }
  /** Invite a character into the session's own fleet (server confirm-gated). */
  | { readonly kind: "inviteToFleet"; readonly charID: number }
  /**
   * Accept a pending fleet invite (server confirm-gated). `fleetID` null means
   * "whatever invite arrived" -- the invite-waiting block, which has no other
   * way to know. A block that MINTED the invite by applying names the fleet
   * instead, so it does not have to race the notification into the store.
   */
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number | null }
  /**
   * Apply to an ADVERTISED fleet found in the fleet finder (server confirm-gated).
   * The id comes from the listing this same tick and is never saved in a script:
   * a fleet is minted fresh every time somebody forms up.
   */
  | { readonly kind: "applyToJoinFleet"; readonly fleetID: number;
      readonly supportOrder?: { readonly scope: import("./miningSupportFleet.ts").SupportFleetScope; readonly actionID: number } }
  /** Hand the SHARED autopilot a system-only route (arrives in space, no dock). */
  | { readonly kind: "startSystemRoute"; readonly systemID: number }
  /**
   * TELL THE PLAYER — a notification, a sound, a line in the readout. The one
   * action that touches nothing in the world; it is carried as an action anyway so
   * it rides the single "one thing per tick" path every other effect rides, and so
   * the flow (in a tab) and the server bot host (headless) can each deliver it the
   * way their surface allows.
   */
  | { readonly kind: "alert"; readonly message: string }
  /** ⚠ Dump these cargo items into space as a container anyone can take. */
  | { readonly kind: "jettison"; readonly itemIDs: readonly number[] }
  /** Stack everything loose in the docked station's hangar. */
  | { readonly kind: "stackHangar" }
  /**
   * Compress ONE ore stack against a support ship on grid. One stack per action:
   * the server answers every refusal with the same silence, so a batch could not
   * report which stack failed — the block re-reads its hold instead.
   */
  | { readonly kind: "compressOre"; readonly itemID: number; readonly facilityID: number }
  /** Product scanner actions carry no IDs; the BFF resolves authority afresh. */
  | { readonly kind: "scannerLaunch" }
  | { readonly kind: "scannerAnalyze" }
  | { readonly kind: "scannerRecover" };

/**
 * Does this action need to be PERFORMED (handed to `issue`)? Everything but a
 * wait. An `alert` is included even though it changes nothing in space: the
 * runner's job here is "is there something to do", and the alert has to be
 * delivered. It is not counted as world progress anywhere — the livelock proof
 * lives in the forward scan, and an alert is decided in the interrupt path above
 * it, so a program cannot satisfy the scan by alerting.
 *
 * The silence counter behind `MAX_SILENT_STEP_TICKS` asks this same question of
 * a MACRO's action, and the sentence above still holds there: no macro emits an
 * alert (both emitters are the orchestrator's own, and the skip path zeroes the
 * counter as it leaves anyway), so nothing can stay alive by alerting either.
 */
export function isWorldCall(action: ScriptAction): boolean {
  return action.kind !== "wait";
}

// ─── How long to not-decide after a world call landed ────────────────────────
//
// The runner issues at most ONE action per tick and sleeps SCRIPT_CADENCE_MS
// (2 s) between ticks. A SETTLE TICK is a tick spent not-deciding: it returns
// BEFORE observe, so it costs two seconds of wall clock and buys no fresh read
// in exchange. Flat at 2, every single action therefore cost SIX seconds. On
// grid that is 20-35 s between landing and the first point of drone damage,
// because locking, launching, engaging and switching the guns on are four
// separate actions and each one paid the full toll.
//
// ⚠ THIS IS AN ALLOWLIST OF REDUCTIONS, NOT A TABLE OF SETTLES. An action kind
// that is not named below keeps DEFAULT_SETTLE_TICKS, so today's behaviour is
// unchanged BY CONSTRUCTION and a kind added later — by somebody who never read
// this comment — inherits the safe value without having to do anything. Do not
// "complete" this into an exhaustive Record<ScriptAction["kind"], number>:
// silence has to go on meaning "unchanged". Several kinds are silent on purpose
// (the fleet-forming set, `startSystemRoute`, the scanner trio), and
// being silent is how they stay safe.
//
// ─── THE ONLY QUESTION THAT DECIDES AN ENTRY ─────────────────────────────────
//
// If the runner decided AGAIN two seconds later, on an observation that may not
// yet reflect the action it just issued, what stops it re-issuing the same
// thing? Exactly two answers count:
//
//   (a) STEP MEMORY written in the SAME tick the action is issued, and checked
//       before issuing again. This is immune to a stale read: the macro never
//       consults the world to know it already asked.
//   (b) A READ-BACK THE SERVER (or the BFF) UPDATES SYNCHRONOUSLY, so the next
//       tick's observation cannot be behind the call that was just made.
//
// ⚠ "THE SERVER WILL JUST REFUSE THE DUPLICATE" IS NOT AN ANSWER. It is the
// cheap-looking third option and it is the one that loses runs — see `activate`
// below, where the refusal is real, is booked in the ledger, and where ten of
// them on one key END THE RUN.
//
// ⚠ CUTTING SETTLE RAISES THE READ RATE, DELIBERATELY. Settle ticks skip observe
// entirely, so a block whose actions all sit at 0 now reads the world on every
// tick instead of every third. That is the trade being made on purpose: reads
// are cheap and a fight is not.

/** What an action kind costs in not-deciding unless the table below says less. */
export const DEFAULT_SETTLE_TICKS = 2;

const SETTLE_TICKS_BY_KIND: Partial<Record<ScriptAction["kind"], number>> = {
  // ═══ 0 — decide again on the very next tick ════════════════════════════════

  // SESSION CHANGES WHOSE PROMISE ALREADY CARRIES READINESS. These four were the
  // runner's only exception before this table existed (its
  // `returnsAuthoritativeSessionReadiness`), and the reasoning is kept whole:
  // the BFF route behind each of them resolves ONLY after authoritative location
  // plus ship/scene readiness can be re-read. So the successful return is itself
  // the proof, and the next tick should consume that truth rather than wait two
  // more ticks for it to become true a second time. Guard (b) in its strongest
  // form — the promise is the read-back.
  undock: 0,
  dock: 0,
  jump: 0,
  boardShip: 0,

  // GUARD (a) AT EVERY SINGLE CALL SITE — a duplicate is structurally
  // impossible, because the memory that stops it is written in the same tick the
  // action goes out and is read before the next one can be.
  //   • lock — `lockIssued` (scriptMacros mine-at-belt ~858, salvage ~1830,
  //     fight ~2278, defend-player ~3844; the remote-rep ~3119 and remote-cap
  //     ~4372 rungs park the target id in memory the same way).
  //   • engageDrones — `dronesOn` / `engaged` (~1087, ~2288, ~3928).
  //   • callPrimary — `calledTargetID` (~227/~238; the block only speaks when
  //     its primary CHANGES, which is that guard).
  //   • setFleetTargetTag — `taggedTargetID` (~3424/~3449).
  lock: 0,
  engageDrones: 0,
  callPrimary: 0,
  setFleetTargetTag: 0,

  // GUARD (a), BUT WITH A DELIBERATE RE-ISSUE BUILT IN. Salvage drones go idle
  // once their wreck is gone, so the block re-points them every
  // SALVAGE_REISSUE_TICKS (5) using `sinceIssue` (~1751-1764). Its own comment
  // says "re-point idle salvage drones every ~10 s" — which was never true under
  // a flat settle, because each of those five decide-ticks cost six seconds, not
  // two. At 0 the comment becomes true again; the guard itself is unchanged.
  salvageDrones: 0,

  // NOT GUARDED EVERYWHERE, AND SAFE ANYWAY BECAUSE A REPEAT IS A NO-OP. Three
  // of the recall sites decide purely from the observation ("the drones are out
  // and the grid is clear" — scriptMacros ~1059, ~1741, ~2209), so a stale read
  // can genuinely ask twice. It costs nothing: see the comment in app/flow.ts
  // around 6443 — no scoop follows a recall because "the server flies them home
  // at full speed and scoops them itself" inside 2500 m. A second recall of
  // drones already flying home changes nothing about what they are doing.
  recallDrones: 0,

  // NOT GUARDED ANYWHERE, AND SAFE ON A MEASUREMENT RATHER THAN AN ARGUMENT.
  // Every deactivate site picks a module out of the observation's running list
  // (~603, ~860, ~1114, ~1528 in this file), so a stale read does re-send it.
  // ⚠ THE IDEMPOTENCE IS MEASURED, NOT ASSUMED: app/flow.ts around 4920 records
  // a live test on a 1MN Civilian Afterburner — a Deactivate inside the lag
  // window is ACCEPTED again with `stopped:false`, because retail stops a module
  // at the END of its current cycle; only ~12 s later, once it had really
  // stopped, did a repeat refuse with "is not active". The window this settle
  // opens is two seconds, which is squarely in the accepted half.
  deactivate: 0,

  // STANDING SERVER-SIDE ORDERS, NOT ONE-SHOT COMMANDS. `approach` is
  // CmdSetSpeedFraction + CmdFollowBall (see scriptMacros ~3859), `keepAtRange`
  // is CmdFollowBall with a non-zero range (see fleetCompanionLoop ~1051),
  // `orbit` is CmdOrbit and `align` is CmdAlignTo. The ship goes on obeying with
  // nothing further sent, so re-issuing at an UNCHANGED target and range is
  // wasteful-but-safe: the worst case is one bridge call spent on an order
  // already in force. Every call site is memory-guarded on top of that
  // (`approached`/`approaching`/`closingOn`, `aligned`, `orbiting`,
  // `following`), so the waste is mostly theoretical too.
  //
  // ⚠ approach / orbit / keepAtRange are what a drone boat positions with, and
  // they are the three entries a forthcoming drone-boat block leans on: holding
  // range while the drones work is a sequence of these, and six seconds apiece
  // is the difference between holding station and being caught.
  approach: 0,
  align: 0,
  orbit: 0,
  keepAtRange: 0,

  // GUARD (b), AS GOOD AS IT GETS. `rideAutopilotTo` (~1171) re-issues only when
  // `travel.status` is not already "running" for this destination — and that
  // status is `autopilot.snapshot().status`, which `startRoute()` sets
  // SYNCHRONOUSLY (`autopilot.start(plan)`) before the promise the runner awaits
  // resolves. app/flow.ts around 6245 says it outright of that very read:
  // "Synchronous, no gateway call". The next tick cannot see a stale status,
  // so there is nothing for a settle to wait for.
  startRoute: 0,

  // GUARD (a) — AND THEY ARE WARPS, WHICH IS THE POINT. Both write
  // `issued: true, waited: 0` in the same tick and both deciders test `issued`
  // at the top before anything else (~2486 scan sites, ~2727 saved spot, ~2785
  // mission site). Bare `warp` below stays at 2; the entire difference between
  // it and these two is the guard, not the call.
  warpScan: 0,
  warpBookmark: 0,

  // GUARD (a): `applied: true` (~2575) and `stacked: true` (~4542), each written
  // in the issuing tick. Stacking is additionally idempotent — running it over an
  // already-stacked hangar moves nothing.
  applyFitting: 0,
  stackHangar: 0,

  // IT TOUCHES NOTHING IN THE WORLD. An alert is carried as an action only so it
  // rides the same one-thing-per-tick path every real effect rides; there is no
  // ship state that could be observed late, so there is nothing to settle FOR.
  // (What stops an alert repeating is `releaseSpentAlerts` in the interrupt
  // path, and that is unaffected by any of this.)
  alert: 0,

  // A SET ON SHARED MEMORY, KEYED BY NAME. It is honestly unguarded at its site
  // (~793) — but it is a set, not an increment: writing "this belt is dry" twice
  // leaves exactly the same value in the BFF's shared belt memory. Nothing on
  // the ship moves and nothing is waiting to become observable.
  rememberBeltDry: 0,

  // ═══ 1 — one tick, then decide ═════════════════════════════════════════════

  // ⚠ THE ENTRY THAT EXISTS TO SAY WHY "THE SERVER WILL REFUSE IT" IS NOT A
  // GUARD. Every activate site picks an IDLE module out of the observation's
  // running-module list (scriptMacros ~925, ~1842, ~2150, ~2302, ~3159, ~3904,
  // ~3918, ~3940, ~4407; this file ~1026 and ~1134) — an observation-derived
  // test, so a read that has not caught up re-fires a module already running.
  // That duplicate IS refused, with `EffectAlreadyActive2` (bridge/refusals.ts
  // :159), and a refusal is NOT free: the runner books every non-session-change
  // refusal in the run's ledger, and MAX_CONSECUTIVE_REFUSALS on ONE KEY ENDS
  // THE RUN. Leaning on the refusal would therefore spend a ship's whole run
  // budget on the runner's own impatience. One tick is enough for the module
  // list to catch up, and it still cuts the cost of putting the guns on by a
  // third.
  activate: 1,

  // THE LAUNCH HAS NO SYNCHRONOUS CONFIRMATION AT ALL. app/flow.ts around 6427
  // says it in as many words: the server's launch handler answers 200 with an
  // EMPTY DICT even when it refuses, the wrapper's return value is therefore not
  // read, and "the grid on the next tick is the only authority either way". The
  // site is counter-guarded rather than fact-guarded — `launchTries` against
  // LAUNCH_MAX_TRIES (3, scriptMacros ~296-350) — so a stale-read repeat does
  // not double-launch, it burns a THIRD of the only budget the block has. One
  // tick buys the grid read that settles it.
  launchDrones: 1,

  // ATTEMPTED IS NOT EMPTIED. Both loot sites remember only that a wreck or can
  // was attempted (~1935, ~2047); whether it actually came up empty is settled
  // by the next tick's grid read. A stale read re-loots — harmless in the world,
  // but it arrives back as a refusal, and the loot pair is the ONE thing the
  // ledger keys per target (the runner's `actionTargetID`), so the duplicate is
  // spent out of that specific can's own budget rather than a shared one.
  lootWreck: 1,
  lootContainer: 1,
  // The same answer for the same reason: the next tick's launch list is what
  // says the container was emptied (its launch record is gone), and a stale
  // read re-collecting an empty container costs one more empty open.
  collectLaunch: 1,
  // And the same again: the next tick's office read is what says it emptied,
  // and a stale read re-taking from an empty office costs one more empty open.
  collectCustoms: 1,

  // GUARD (a) IS PRESENT, AND THE ENTRY IS STILL 1 ON PURPOSE. `buy-item` writes
  // `placed: true` in the issuing tick (~2914), so by the letter of the rule
  // this could be 0. It is not, because the failure being settled against is
  // spent ISK plus a broker fee: a market write is not worth two seconds. Same
  // reasoning for a restart (~2830 — `restarted` holds the pin id, but the
  // confirmation the block walks on is the colony re-read pushing the expiry
  // into the future) and for compression (~4652 — `triedItemIDs` holds the
  // stack, but compressing CONSUMES it).
  placeBuyOrder: 1,
  restartExtractor: 1,
  // A reroute is confirmed the same way (the colony re-read shows the routes
  // re-sized), and a duplicate inside one stale read would try to remove
  // routes the first edit already removed.
  rerouteExtractor: 1,
  compressOre: 1,

  // A launch is the same shape of cost as the restart above it, twice over: the
  // server debits export tax, and what leaves the colony is GONE from it — it
  // is a container in space that somebody now has to fly out and scoop. The
  // block does hold the fired pin id, but the confirmation it walks on is the
  // colony re-read showing the centre emptied, so a duplicate inside one read
  // is exactly what this entry is here to make expensive.
  launchCommodities: 1,
};

// ═══ WHAT STAYS AT THE DEFAULT, AND WHY IT IS NOT AN OVERSIGHT ═══════════════
//
// These are named here so the next reader can see they were weighed and kept,
// rather than forgotten. Do not tidy them into the table above.
//
// ⚠ `warp` IS THE ONE WHERE THE OBVIOUS SYMMETRY IS WRONG. Every other movement
// action in the 0 bucket is a standing order the server keeps re-reading; a warp
// is not. It is not idempotent — fleetCompanionLoop around 1500, on that loop's
// own `lastWarpedToID`, puts it plainly: re-sending it while the ship is already
// on its way is "at worst a second warp the moment the first lands". And unlike
// every other movement action, SEVERAL OF THE DECIDERS THAT EMIT IT CARRY NO
// MEMORY GUARD WHATSOEVER: `travelToBelt` (scriptMacros ~577) and the pinned
// `mineNoTargetRocks` rung (~740) both warp with a next-memory of `{}`;
// `dockAtNearest` (~4327) warps with `mem` untouched; the compression block
// (~4637) likewise. The hunt rung is worse than unguarded — having excluded the
// vantage point it just used, a second decision picks a DIFFERENT one and warps
// there mid-warp (~4126). THE FLAT SETTLE IS CURRENTLY THE ONLY THING PREVENTING
// A DOUBLE WARP AT THOSE SITES, which is exactly the bug this whole table is
// trying not to ship.
//
// `agentButton` — THE ACCEPT PRESS HAS NO "PRESSED" FLAG AT ANY SITE. The three
// sites count instead: `asked` (~1291), `rounds` (~1422/~1434/~1448) and
// `attempts` (~1571). A counter bounds how many times the block may TRY; it does
// not stop the same press going out twice off a stale conversation read, and a
// duplicate Accept accepts a SECOND MISSION — a real change in the player's
// journal, not a wasted packet.
//
// `placeSellOrder` — THE ASYMMETRY WITH `placeBuyOrder` IS REAL AND WORTH
// KEEPING. `buy-item` writes a `placed` flag; `sell-item` has only an `attempts`
// counter (~2964) and re-picks `stacks[0]` out of the hangar read each tick, so
// a hangar that has not caught up lists the same stack twice.
//
// `unlock` — dropping a lock the ship still needs is not something a tick can
// undo, and nothing is waiting on it.
//
// `reprocessOre`, `repairItems`, `loadMissionCargo` — each consumes items or
// spends ISK against a hangar read, and none of them is on a hot path where two
// seconds matter.
//
// THE ASSET-MOVING GROUP — `unloadOre`, `unloadHolds`, `unloadMissionCargo`,
// `moveItems`, `jettison`. A move is confirmed ONLY by re-reading the place the
// items left and the place they arrived in, and those are exactly the reads a
// short settle outruns. `jettison` additionally puts cargo into space where
// anybody may take it; there is no version of that worth hurrying.

/**
 * Ticks of not-deciding the runner should spend after this action landed.
 *
 * Unlisted kinds get DEFAULT_SETTLE_TICKS — see the allowlist reasoning above.
 */
export function settleTicksFor(action: ScriptAction): number {
  return SETTLE_TICKS_BY_KIND[action.kind] ?? DEFAULT_SETTLE_TICKS;
}

const WAIT: ScriptAction = { kind: "wait" };

// ─── The macro contract (concrete macros land in A4c) ────────────────────────

/**
 * Per-step scratch that persists across ticks while the step is active.
 *
 * ⚠ THIS IS SCRATCH, AND IT IS WIPED EVERY TIME THE STEP IS LEFT (see the two
 * `omit(macroMem, step.id)` calls below). That is correct for what belongs here
 * — an approach target, a lock wait, an "issued" flag — because a fresh visit
 * should genuinely re-approach and re-read.
 *
 * IT IS THE WRONG PLACE FOR A BOUND. A counter kept here is per-VISIT, not
 * per-run, so on a `forever` loop every failing target is handed a fresh budget
 * on every lap. That is not hypothetical: it is why a bot produced 227
 * consecutive refusals in repeating bursts of five instead of stopping after
 * the first five. Anything of the shape "this object has been refusing me"
 * belongs in the RUN's refusal ledger (`refusalLedger.ts`), which the runner
 * owns and which no step exit can wipe.
 */
export type MacroMemory = Readonly<Record<string, unknown>>;

/**
 * What a macro reports for one tick.
 *
 *   • outcome "acting"  — it wants to issue `action` (which may be a wait).
 *   • outcome "done"    — it has finished its own job (docked, hold empty); the
 *                         orchestrator advances to the next step this tick.
 *   • outcome "blocked" — it cannot proceed; the bot pauses with the reason.
 *   • outcome "skipped" — it cannot do its job on this ship and that is not
 *                         worth stopping for (no salvager on a ratting hull):
 *                         the orchestrator says so once and advances.
 *
 * `armed` says whether the player's `until` is meaningful yet — mine-at-belt is
 * unarmed until it has arrived, which is what keeps "ore hold full" from reading
 * true against an empty hold while the ship is still in warp.
 */
export type MacroOutcome =
  | { readonly kind: "acting" }
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * The run-scoped BOARD: facts one block publishes for the blocks after it (the
 * found agent, its station, the mission's pickup/dropoff). Unlike per-step
 * memory it SURVIVES step transitions and loop laps; it dies with the run.
 */
export type ScriptBoard = Readonly<Record<string, number | string | null>>;

export interface MacroTick {
  readonly settleDrones?: boolean;
  readonly action: ScriptAction;
  readonly why: string;
  readonly phase: string;
  readonly armed: boolean;
  readonly outcome: MacroOutcome;
  readonly nextMem: MacroMemory;
  /** Facts to publish onto the run's board this tick (merged over what's there). */
  readonly boardPatch?: ScriptBoard;
  readonly containerTargetID?: number;
}

export type MacroDecider = (
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  board: ScriptBoard,
) => MacroTick;

/** A partial lookup is useful to focused pure tests (an omitted macro pauses plainly). */
export type MacroRegistry = Readonly<Partial<Record<MacroID, MacroDecider>>>;

/** The production registry must implement EVERY format-level MacroID. */
export type CompleteMacroRegistry = Readonly<Record<MacroID, MacroDecider>>;

/** Flies the ship to `home` for a latched dock-and-pause. `done` == docked home. */
export type HomeTravelDecider = (obs: ScriptObservation, mem: MacroMemory) => MacroTick;

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * How many ticks a step may stay SILENT — emitting no world call — before the
 * run is called stuck. The R39 backstop.
 *
 * ⚠ SILENT TICKS, NOT ELAPSED TICKS, and the distinction is the whole point.
 *
 * This counted elapsed ticks until 2026-09-22 — reset only when the position
 * changed — which made it a wall-clock cap on ONE VISIT to a step: 90 minutes,
 * as four stopped miners measured it to within a minute of each other. All four
 * were working perfectly. Their `mine-at-belt` visit (filtered to two ores,
 * `until` an ore hold 90% full) had been locking rocks, cycling lasers and
 * warping to a fresh anomaly as each one ran dry, and was stopped mid-cycle for
 * taking too long about it. Five more pilots on the SAME script were untouched
 * for the only reason that they mined a hold in about 25 minutes instead of 55
 * and so never had a visit cross the line. A slow job is not a stuck one, and a
 * guard that fires on the slower half of a working fleet is measuring the wrong
 * thing.
 *
 * So a world call resets it. What the guard is for is the macro that emits
 * NOTHING for ever (the "a tick can legally emit no world call" primitive in the
 * header) — and that macro is silent by definition, so it still trips. This is
 * the same shape as `STALL_TICKS` in siteProgress.ts, which counts APPLYING
 * ticks and not elapsed ones for the same reason.
 *
 * A macro that keeps ACTING without getting anywhere is somebody else's job,
 * deliberately: refusals belong to the run's refusal ledger (refusalLedger.ts),
 * an approach that never closes to `closeInStall`, drones that never launch to
 * `launchStalled`, a rat that will not die to `STALL_TICKS`. Each of those knows
 * what progress means for its own case; this one does not and must not guess.
 *
 * 1800 is left where elapsed-tick tuning put it, and it is generous on purpose.
 * The silent stretches a HEALTHY run has are real — an autopilot flying a long
 * route, a `join-fleet` waiting on a squad (JOIN_MAX_WAIT_TICKS is 150) — and
 * at the ~3s the fleet above actually ticked at, 1800 is an hour and a half of
 * a bot doing literally nothing. A tighter number would have to argue against
 * those, and the narrow stall detectors above are where tightness belongs.
 */
export const MAX_SILENT_STEP_TICKS = 1800;

const HOME_MEM_KEY = "__home__";
/** Where a repair trip's borrowed Repair-ship block keeps its own memory. */
const REPAIR_MEM_KEY = "__repair__";

type Position =
  | { readonly kind: "step"; readonly node: number }
  | { readonly kind: "loop"; readonly node: number; readonly body: number }
  // A branch not yet entered: the next tick evaluates its `when` and commits to a
  // side. Kept distinct from "branch" so the condition is read ONCE on entry, not
  // re-read (and possibly flipped) each tick while a side runs.
  | { readonly kind: "branch-enter"; readonly node: number }
  | { readonly kind: "branch"; readonly node: number; readonly side: "then" | "else"; readonly body: number }
  // The same two states for a branch sitting INSIDE a loop body: `body` is the
  // branch's index in the loop body, `inner` its index within the chosen side.
  // It is re-entered (and so re-evaluated) on every pass — which is the point: a
  // loop that forks each lap.
  | { readonly kind: "loop-branch-enter"; readonly node: number; readonly body: number }
  | {
      readonly kind: "loop-branch";
      readonly node: number;
      readonly body: number;
      readonly side: "then" | "else";
      readonly inner: number;
    }
  | { readonly kind: "done" };

/**
 * A "which solar system" reading, taken once and compared against a later one.
 * `id` is the live runner's own numeric read (`FlightStatus.solarSystemID`,
 * backed up by the space snapshot's copy of the same field); `name` is
 * `obs.systemName`, the read used elsewhere in the engine for the same
 * question (it is the shared belt memory's key). Both null means the ship
 * could not be placed in a system at all that tick — a docked session reports
 * no ship (`docs/bridge-wire-contract.md`), and `systemName` goes dark with
 * it — which is exactly the reading a station stop produces.
 */
interface SystemReading {
  readonly id: number | null;
  readonly name: string | null;
}

function readSystem(obs: ScriptObservation): SystemReading {
  return {
    id: obs.flightStatus?.solarSystemID ?? obs.snapshot?.solarSystemID ?? null,
    name: obs.systemName ?? null,
  };
}

/**
 * Did the ship land somewhere DIFFERENT from where a reading was taken
 * earlier? An id beats a name when both readings have one, matching
 * `readSystem`'s own preference; two name-only readings compare by name; and
 * anything the two readings cannot honestly compare — either side unreadable,
 * or one side id-only against the other name-only — answers "no", never
 * "yes". A mismatch this function cannot confirm is not grounds to rewind a
 * working program; see `continueRecovering`'s step 3, the only caller.
 */
function systemsDiffer(fired: SystemReading, landed: SystemReading): boolean {
  if (fired.id !== null && landed.id !== null) {
    return fired.id !== landed.id;
  }
  if (fired.name !== null && landed.name !== null) {
    return fired.name !== landed.name;
  }
  return false;
}

/**
 * A "dock at home and repair" trip in progress — the one latch that ENDS IN THE
 * PROGRAM rather than in a stop, so it has to remember how to get back.
 *
 * `undock` is the whole of "get back": true when the watch fired out in space,
 * which is the only case where carrying on means leaving the station again. A
 * watch that fired while already docked leaves the ship docked — undocking a bot
 * whose next step is a station step (unload, refine, sell) would break a program
 * that was working perfectly well.
 *
 * `firedSystem` is the system reading taken the same tick the latch was made —
 * see `continueRecovering`'s step 3 for what it is compared against, and why.
 */
interface Recovery {
  readonly undock: boolean;
  readonly firedSystem: SystemReading;
}

interface Latched {
  /**
   * The watch row that sent the ship home, or NULL when a fault did — the
   * livelock guard and the step-tick cap are the runner's own verdicts and have
   * no row to point the readout at.
   */
  readonly interruptID: string | null;
  readonly reason: string;
  /**
   * Present only on a "dock at home and repair" latch. Its absence is what makes
   * every OTHER latch a stop: `reason` is then the sentence the run pauses with,
   * and here it is only what the readout says while the trip is under way.
   */
  readonly recover?: Recovery;
}

export interface ScriptMemory {
  readonly position: Position;
  readonly loopPass: number;
  /**
   * Consecutive ticks at this position that issued NO world call. Reset by a
   * world call and by leaving the position — see `MAX_SILENT_STEP_TICKS` for why
   * it counts silence rather than elapsed time. The name is historical; it is
   * kept because it is the persisted memory's field name.
   */
  readonly stepTicks: number;
  readonly cannotTellStreak: number;
  readonly latched: Latched | null;
  readonly macroMem: Readonly<Record<string, MacroMemory>>;
  /** The run-scoped board — survives step transitions; dies with the run. */
  readonly board: ScriptBoard;
  /**
   * The ids of "alert me" rows that have already spoken for the episode their
   * condition is currently in. Optional so an older memory (or a test's) reads as
   * "nothing spent yet", which is the safe default: it alerts.
   */
  readonly spentAlerts?: readonly string[];
  /**
   * Step ids that have already been SKIPPED (outcome "skipped") this run, so the
   * warning is said once: a skipped step inside a loop comes round again every
   * pass, and a program that can do nothing but skip must trip the livelock
   * guard, not alert forever. Optional like `spentAlerts`, same default.
   */
  readonly skippedSteps?: readonly string[];
  readonly miningFlight?: MiningDroneMemory;
  /** Bounded terminal return check; a failed return pauses without clean DONE. */
  readonly terminalDroneTicks?: number;
}

/** The memory a fresh run starts from — positioned at the first node. */
export function initialMemory(script: BotScript): ScriptMemory {
  return {
    position: startOfNode(script, 0),
    loopPass: 0,
    stepTicks: 0,
    cannotTellStreak: 0,
    latched: null,
    macroMem: {},
    board: {},
    spentAlerts: [],
    skippedSteps: [],
  };
}

/**
 * The board as one R9a line for the readout — who the run is working with, by
 * NAME only (ids on the board never reach the screen, R7d). Null when the board
 * holds nothing a player would want to read.
 */
export function describeBoard(board: ScriptBoard): string | null {
  const agentName = typeof board["agentName"] === "string" ? (board["agentName"] as string) : null;
  const stationName =
    typeof board["agentStationName"] === "string" ? (board["agentStationName"] as string) : null;
  if (agentName === null) {
    return null;
  }
  return stationName !== null && stationName.length > 0
    ? `Working with ${agentName} (${stationName})`
    : `Working with ${agentName}`;
}

/**
 * Which macro the NEXT tick will consult — the runner's observe hint, so the
 * flow reads agent/journal/cargo only when a mission block is active. Null when
 * the program is done or heading home (only the ship reads are needed then).
 */
/**
 * Whether the NEXT tick's block flies with the fleet — the second half of the
 * observe hint, so the squad board is read only for a block that asked to
 * follow one. "off" for every other block, and for no block at all: a bot that
 * never mentions the fleet must not pay a board read per tick, and one that
 * only CALLS does not need to read what it is about to overwrite.
 */
export function activeSquadRole(script: BotScript, mem: ScriptMemory): SquadRoleArg {
  if (
    mem.position.kind === "done" ||
    mem.position.kind === "branch-enter" ||
    mem.position.kind === "loop-branch-enter" ||
    mem.latched !== null
  ) {
    return "off";
  }
  const arg = activeStep(script, mem.position)?.args["squad"];
  return arg !== undefined && arg.kind === "squadRole" ? arg.role : "off";
}

/**
 * How this script's WATCHES fight, if any of them does — the other half of the
 * observe hint's fleet question.
 *
 * A watch is armed on every tick, not just while some step is active, so this
 * reads the document rather than the position. The flow pairs it with "are
 * there hostiles on grid" before paying for a board read: a bot whose watch
 * follows the fleet only needs to know the call when there is something to
 * shoot. "follow" wins over "call" because only following needs the read.
 */
export function watchSquadRole(script: BotScript): SquadRoleArg {
  let found: SquadRoleArg = "off";
  for (const row of script.interrupts) {
    if (row.respond !== "fight-back" || row.squad === undefined || row.squad === "off") {
      continue;
    }
    if (row.squad === "follow") {
      return "follow";
    }
    found = row.squad;
  }
  return found;
}

export function activeMacroID(script: BotScript, mem: ScriptMemory): string | null {
  // A repair trip IS running a block — the Repair-ship one, borrowed — and the
  // observer gates the shop's quote on exactly this answer, so a latch that said
  // "no block" would leave the trip asking a question nobody was fetching.
  if (mem.latched?.recover !== undefined) {
    return "repair-ship";
  }
  if (
    mem.position.kind === "done" ||
    mem.position.kind === "branch-enter" ||
    mem.position.kind === "loop-branch-enter" ||
    mem.latched !== null
  ) {
    return null;
  }
  const step = activeStep(script, mem.position);
  return step?.macro ?? null;
}

/**
 * Is the active block a mining block set to tour ORE SITES? Asked because the
 * scanner read is priced per block, and `mine-at-belt` is not a block that
 * flies to an anomaly — except in `site` mode, where the barren-grid path is
 * the tour: it names the next site itself rather than handing control back to
 * a `warp-to-ore-anomaly` ahead of it (see `mineAtBeltSiteBarren` in
 * scriptMacros.ts).
 *
 * ⚠ WITHOUT THIS THE SITE MODE CANNOT FINISH A LAP. `observe` only fetches
 * `anomalies` for the two blocks that fly to an anomaly by name, so a mining
 * block reading the scanner got a permanent `null` — and `null` there means
 * "unread yet", which waits. A bot that mined its site out then sat on
 * "Reading the scanner for the next ore site." forever, one tick after the
 * other, with the scanner never asked.
 *
 * Asked of the STEP rather than of the macro for the same reason
 * `activeStepNeedsTypeNames` below is: `site` is an ARGUMENT, and the same
 * block pointed at the nearest belt must not pay for a read it cannot use.
 */
export function activeStepToursOreSites(script: BotScript, mem: ScriptMemory): boolean {
  if (mem.position.kind === "done" || mem.latched !== null) {
    return false;
  }
  const step = activeStep(script, mem.position);
  if (step === undefined || step === null || !["mine-at-belt", "fleet-mine", "travel-to-belt"].includes(step.macro)) {
    return false;
  }
  const belt = step.args["belt"];
  return belt !== undefined && belt.kind === "belt" && ["site", "ice-site"].includes(belt.belt.mode);
}

/**
 * Does the active block match items by NAME? The one thing type ids and group
 * ids cannot answer, and the only reason to pay for a name lookup on a tick.
 *
 * Asked of the STEP rather than of the macro, because it is an argument and not
 * a property of the block: the same load block matching on a group needs no
 * names at all (see `ScriptObservation.typeNames`).
 */
export function activeStepNeedsTypeNames(script: BotScript, mem: ScriptMemory): boolean {
  if (mem.position.kind === "done" || mem.position.kind === "branch-enter" ||
      mem.position.kind === "loop-branch-enter" || mem.latched !== null) {
    return false;
  }
  const step = activeStep(script, mem.position);
  if (step === undefined || step === null) {
    return false;
  }
  return Object.values(step.args).some(
    (arg) =>
      arg !== undefined &&
      arg.kind === "itemList" &&
      arg.items.some((item) => item.match === "name" && item.pattern.trim().length > 0),
  );
}

// ─── The decision returned each tick ─────────────────────────────────────────

export type RunStatus = "running" | "paused" | "done";

export interface ScriptTickResult {
  readonly settleDrones?: boolean;
  readonly action: ScriptAction;
  readonly why: string;
  readonly phase: string;
  readonly stepPath: string | null;
  readonly interruptID: string | null;
  readonly status: RunStatus;
  readonly pauseReason: string | null;
  readonly memory: ScriptMemory;
  readonly containerTargetID?: number;
}

// ─── Local sentences (R9a) ───────────────────────────────────────────────────

const SAY = {
  programDone: "The program finished, so the bot stopped.",
  livelock: "This program has nothing it can do right now, so the bot stopped.",
  // ⚠ "did nothing", not "took too long". A slow step is explicitly allowed (see
  // MAX_SILENT_STEP_TICKS); what this sentence reports is a step that stopped
  // doing anything at all, and it has to say so or the player goes looking for
  // the wrong fault — a hold that fills slowly rather than a macro that hung.
  stepDidNothing: "A step did nothing at all for a very long time, so the bot stopped.",
  unknownMacro: "This program uses an action the bot does not know, so it stopped.",
  headingHome: "A watched warning was hit, so the bot is heading home to stop.",
  inWarp: "The ship is in warp, so the bot is waiting until it lands.",
} as const;

function stoppedBecause(clause: string): string {
  return `Stopped because ${clause}.`;
}

/** Why a repair trip gave up: it went home and came back, and nothing changed. */
function sayRepairDidNotHold(when: Condition): string {
  return `The bot went home to repair ${MAX_RECOVER_TRIPS} times and ${conditionSentence(when)} each time, so it stopped.`;
}

// ─── The tick ────────────────────────────────────────────────────────────────

export function decideScriptAction(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  if (obs.miningOperation?.stopRequested === true) {
    return { action: WAIT, memory: mem, stepPath: null, interruptID: null,
      status: "running", pauseReason: null,
      phase: "Stopping operation", why: "Operation Stop is settling this pilot; new work is disabled." };
  }
  if (obs.miningOperation?.supportPolicy?.mode === "STOP") return { action: { kind: "stopMiningSupportOperation" }, memory: mem, stepPath: null, interruptID: null,
    status: "running", pauseReason: null, phase: "Stopping for support loss", why: obs.miningOperation.supportPolicy.reason ?? "Applying the configured support-loss policy." };
  const base = decideScriptCore(script, obs, mem, registry, travelHome);
  const operationHeld = obs.miningOperationRequired === true &&
    (obs.miningOperation == null ||
      (obs.miningOperation.role === "MINER" && obs.miningOperation.currentTarget === null));
  if (operationHeld && base.memory.latched === null) {
    // The operation-aware combat adapter settles its owned state when site
    // authority disappears. Do not replace that cleanup with a generic wait.
    if (activeMacroID(script, mem) === "fight-with-drones" &&
        Object.values(mem.macroMem).some(state => state.operationDefender === true)) return base;
    const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
    const miner = obs.miningModuleIDs?.find(id => active.has(id));
    if (miner !== undefined) return { ...base, action: { kind: "deactivate", moduleID: miner },
      status: "running", pauseReason: null, phase: "Target authority unavailable",
      why: "Settling mining equipment until the operation owns a target." };
    const controlled = obs.miningDrones?.out?.filter(drone => drone.controlled) ?? [];
    if (controlled.length > 0 && obs.hostileOnGrid !== true) return { ...base,
      action: { kind: "recallDrones", droneIDs: controlled.map(drone => drone.itemID) },
      status: "running", pauseReason: null, phase: "Target authority unavailable",
      why: "Recalling controlled drones until operation target authority is restored." };
    const macro = activeMacroID(script, mem);
    if (obs.miningOperation == null || !["undock", "mine-at-belt", "fleet-mine", "warp-to-ore-anomaly", "deliver-ore", "travel-to-station"].includes(macro ?? "")) {
      return { ...base, action: WAIT, status: "running", pauseReason: null,
        phase: "Waiting for operation target", why: obs.miningOperationReadError ?? "No owned operation target is available." };
    }
  }
  // A health-critical watch owns the escape for its entire latched trip, not
  // just the first tick. A normal blocked macro can also latch a trip home,
  // but that trip must settle its flight before ordinary travel.
  const emergency = base.memory.latched !== null &&
    script.interrupts.some((row) => row.id === base.memory.latched?.interruptID &&
      ["health-below", "shield-below", "armor-below", "hull-below", "capacitor-below"].includes(row.when.kind));
  if (emergency) return base;
  if (obs.docked === true) return { ...base, memory: { ...base.memory, miningFlight: undefined } };
  if (obs.miningDrones === undefined) return base;
  // A counted loop can reach DONE with no next movement decision. Keep the
  // runner alive until a fresh observation proves every controlled drone home.
  // This gate also covers a non-mining script ending with combat drones out.
  if (base.status === "done" || base.status === "paused") {
    const rows = obs.miningDrones?.out;
    if (rows !== null && rows !== undefined && rows.every((drone) => !drone.controlled)) return base;
    const ticks = (mem.terminalDroneTicks ?? 0) + 1;
    if (ticks > 90) return { ...base, action: WAIT, status: "paused",
      pauseReason: "Controlled drone return could not be confirmed.",
      why: "Controlled drone return could not be confirmed; automation is blocked.",
      memory: { ...base.memory, terminalDroneTicks: ticks } };
    const controlled = rows?.filter((drone) => drone.controlled) ?? [];
    const order = controlled.filter((drone) => drone.activity !== "returning");
    return { ...base, action: order.length > 0
      ? { kind: "recallDrones", droneIDs: order.map((drone) => drone.itemID) } : WAIT,
      status: "running", pauseReason: null, phase: "Returning drones",
      why: rows == null ? "Controlled drone state is unreadable; completion is blocked."
        : "Waiting for authoritative controlled-drone return.",
      memory: { ...base.memory, miningFlight: mem.miningFlight ?? freshDroneMemory(), terminalDroneTicks: ticks } };
  }
  if (obs.inWarp === true) return base;
  const activeMacro = activeMacroID(script, mem);
  // This action delegates both work and relocation settlement to the reusable
  // support controller. The outer flight lacks its target/order memory and
  // must not recall a flight the inner owner just launched. Terminal/paused
  // cleanup above, latched watches and actual travel still retain this gate.
  if (activeMacro === "mining-support" && base.action.kind === "maintainMiningSupport" && base.memory.latched === null) return base;
  const mining = ["mine-at-belt", "fleet-mine"].includes(activeMacro ?? "");
  const state = obs.miningDrones;
  const compatible = (state?.bay ?? []).some((stack) => state?.roles[stack.typeID] === "mining") ||
    (state?.out ?? []).some((drone) => drone.controlled && drone.typeID !== null && state?.roles[drone.typeID] === "mining");
  if (!mining && mem.miningFlight === undefined &&
      !(state?.out ?? []).some((drone) => drone.controlled) && state !== null) return base;
  if (!compatible && mem.miningFlight === undefined && state !== null &&
      !(state.out ?? []).some((drone) => drone.controlled)) return base;
  const step = mining && mem.position.kind !== "done" ? activeStep(script, mem.position) : null;
  const origin = obs.snapshot?.ship?.position ?? { x: 0, y: 0, z: 0 };
  // ⚠ IN REACH, THE SAME AS THE FIGHT-BACK WATCH AND ITS LADDER. With the whole
  // grid here, a rat parked beyond targeting range kept the flight in combat
  // mode with the drones on it, while the ladder — which only counts what is in
  // reach — called the grid clear and ordered them home. This wrapper swallows
  // that recall whenever the flight has no order of its own, so the watch never
  // finished and the mining step starved until the rat died (caught live
  // 2026-09-30 on nine belt miners). Now the flight stands down too: it recalls
  // the combat flight and relaunches the miners, and the ladder sees its drones
  // come home.
  const hostileID = obs.snapshot === null || obs.snapshot === undefined ? null :
    hostilesInReach(obs, obs.snapshot, origin)[0]?.itemID ?? null;
  const picked = step === null ? null : base.memory.macroMem[step.id]?.["rockID"] ??
    mem.macroMem[step.id]?.["rockID"] ?? null;
  const ice = obs.miningOperation?.currentTarget?.targetType === "ICE" ||
    (step?.args["belt"]?.kind === "belt" && step.args["belt"].belt.mode === "ice-site");
  const rockID = !ice && typeof picked === "number" && obs.lockedTargetIDs?.includes(picked) &&
    obs.snapshot?.entities.some((entity) => entity.itemID === picked && entity.miningYieldTypeID !== null)
    ? picked : null;
  const moving = base.settleDrones === true || base.memory.latched !== null ||
    (step !== null && !["mine-at-belt", "fleet-mine"].includes(activeMacroID(script, base.memory) ?? "")) ||
    ["warp", "warpScan", "warpBookmark", "approach", "orbit", "align", "dock", "undock",
      "startRoute", "startSystemRoute"].includes(base.action.kind) ||
    (step?.macro === "fleet-mine" && ["gotoPoint", "stopShip"].includes(base.action.kind));
  const leaving = moving || !mining;
  // ⚠ OFF A MINING STEP AND SITTING STILL, THE COMBAT FLIGHT IS NOT THIS
  // FLIGHT'S. `!mining` alone used to count as leaving, so every controlled
  // combat drone was recalled the tick after a fight-back watch or a
  // Fight-the-rats step launched it — launch, recall, launch, every ~7 s
  // (caught live 2026-09-30 on a loot step under a fight-back watch). Here the
  // flight still calls home the MINING drones a finished mining step left out,
  // and before any movement it still calls home everything, combat included,
  // which is what it exists to protect; in between, combat drones belong to
  // whoever launched them, and that block or watch recalls them itself.
  const flightState = state == null || state.out === null || mining || moving ? state : {
    ...state,
    out: state.out.filter((drone) => drone.typeID === null || state.roles[drone.typeID] !== "combat"),
  };
  const flight = decideMiningDroneFlight(
    obs.snapshot == null || obs.hostileOnGrid === null ? null : flightState,
    mem.miningFlight ?? freshDroneMemory(), hostileID, rockID, leaving,
  );
  if (flight.action?.kind === "wait" && flight.memory.recallTicks > 90) return {
    ...base, action: WAIT, status: "paused", pauseReason: flight.action.reason,
    why: flight.action.reason, phase: "Drone return blocked",
    memory: { ...base.memory, miningFlight: flight.memory },
  };
  if (flight.action === null) return {
    ...base,
    action: !leaving && ["launchDrones", "engageDrones", "recallDrones"].includes(base.action.kind) ? WAIT : base.action,
    memory: { ...base.memory, miningFlight: leaving ? undefined : flight.memory },
  };
  const action: ScriptAction = flight.action.kind === "launch"
    ? { kind: "launchDrones", droneItemIDs: flight.action.droneItemIDs }
    : flight.action.kind === "wait"
      ? WAIT : flight.action;
  return { ...base, action, why: flight.action.kind === "wait"
    ? flight.action.reason : "Managing the mining and defensive drone flights.",
    phase: "Managing drones", stepPath: step?.id ?? base.stepPath,
    status: "running", pauseReason: null,
    memory: { ...mem, miningFlight: flight.memory } };
}

function decideScriptCore(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  if (mem.position.kind === "done") {
    return done(mem);
  }

  // 0.5 IN WARP, NOTHING IS DECIDED. There is no grid to act on: a module, a
  // drone or a lock call issued mid-flight is either refused outright or lands
  // against the grid the ship has already left. So the whole tick is a wait.
  //
  // ⚠ THIS IS THE ONLY WARP CHECK THE INTERRUPTS HAVE EVER HAD. The macros
  // carry one each -- seventeen copies of `obs.inWarp === true` in
  // scriptMacros.ts -- but `fireInterrupt` below has none, so until this guard a
  // watch could fire in mid-warp and issue against nothing. TANK LAYER IS
  // IRRELEVANT HERE and that is the point of putting it this high: it covers
  // `armor-below` on an armour-tanked hull exactly as it covers `shield-below`
  // on a shield-tanked one, and `hull-below`, `capacitor-below` and
  // `drone-health-below` with them, because it sits above the scan rather than
  // inside any one row.
  //
  // It also states the decided precedence rule -- a server fleet warp outranks
  // everything this bot wants -- for every interrupt and every macro at once.
  // It does NOT distinguish a fleet warp from a self-issued one, because
  // nothing in this client can: `inWarp` is derived from `shipMode` alone.
  //
  // `memory` passes through UNTOUCHED, and that is what makes it safe to sit
  // above the latch: a latched trip, a released alert, a repair tally and a
  // drone-redeploy record each resume on the exact tick the warp clears, and
  // none of them spends the flight.
  //
  // `=== true`, never `!== false`: an unreadable `inWarp` fails OPEN, matching
  // every other tri-state read here. The price of that choice is that a stuck
  // `true` idles the script until `maxRuntimeMinutes` ends the run -- a bounded
  // failure, and the right side to err on against issuing into warp forever.
  //
  // Placed AFTER the `done` check and not before it, which is a deliberate
  // divergence from the spec: `done()` issues nothing, so warping cannot make
  // it unsafe, and going first would keep a finished program reporting
  // "running" for the length of an unrelated warp.
  if (obs.inWarp === true) {
    return {
      action: WAIT,
      why: SAY.inWarp,
      phase: "In warp",
      stepPath: null,
      interruptID: null,
      status: "running",
      pauseReason: null,
      memory: mem,
    };
  }

  // 1. A latched "dock and stop" is flying the ship home — or a latched "dock
  // and repair" is making its round trip, which is the same flight with an
  // ending that goes back to work instead of stopping.
  if (mem.latched !== null) {
    // A recoverable repair trip must become terminal when acute safety fires.
    const acute = mem.latched.recover !== undefined ? script.interrupts.find(row =>
      (row.respond === "dock-and-pause" || row.respond === "pause") && evaluateCondition(row.when, obs) === "met") : null;
    if (acute) return fireInterrupt(script, acute.id, obs, { ...mem, latched: null }, travelHome, registry);
    return mem.latched.recover === undefined
      ? continueHeadingHome(obs, mem, travelHome)
      : continueRecovering(script, obs, mem, registry, travelHome);
  }

  // 2. Interrupts. First release any "alert me" row whose condition has passed,
  // so a fresh episode can speak again, and the trip tally of any repair row
  // that has actually recovered; then scan, skipping rows still spent.
  const spentAlerts = releaseSpentAlerts(script.interrupts, obs, mem.spentAlerts ?? []);
  const released = releaseRecoverTrips(script, obs, mem);
  const scanMem = spentAlerts === (mem.spentAlerts ?? []) ? released : { ...released, spentAlerts };
  // Explicit escape/pause authority precedes optional work, regardless of where
  // a repair or combat watch was placed. Once fired, its latch owns later ticks.
  const escape = script.interrupts.find((row) =>
    (row.respond === "dock-and-pause" || row.respond === "pause") &&
    evaluateCondition(row.when, obs) === "met");
  if (escape) return fireInterrupt(script, escape.id, obs, scanMem, travelHome, registry);
  if (obs.hostileOnGrid === true && obs.health === null) {
    return stopSafely(COND_SENTENCE.safetyBlind, scanMem, null, obs, travelHome);
  }
  const res = resolveInterrupt(script.interrupts, obs, spentAlerts);
  if (res.kind === "safety-override") {
    // No interrupt row caused this — it is the sealed acute rule firing on its
    // own, so there is honestly no interrupt id to report. A pirate is here and
    // the ship is unreadable, which is the LAST state to sit still in: home first.
    return stopSafely(res.reason, scanMem, null, obs, travelHome);
  }

  // 2.5 The repair thermostat's OFF half: a repair watch whose condition has
  // RECOVERED (not-met — cannot-tell keeps repairing, blind is when you want the
  // reps most) switches its still-running repairers back off, one per tick, so
  // they stop eating capacitor once the ship is whole.
  const shutdown = repairShutdown(script, obs);
  if (shutdown !== null) {
    return {
      action: { kind: "deactivate", moduleID: shutdown.moduleID },
      why: "Repaired — switching the repairer back off.",
      phase: "Repairing",
      stepPath: shutdown.rowID,
      interruptID: shutdown.rowID,
      status: "running",
      pauseReason: null,
      memory: scanMem,
    };
  }

  if (res.kind === "fire") {
    return fireInterrupt(script, res.row.id, obs, scanMem, travelHome, registry);
  }

  // 2.6 The fight-back watch's OTHER half: the pirate is gone, so the drones it
  // committed come home and the hardeners IT switched on go back off.
  const stand = standDownAfterFight(script, obs, scanMem);
  if (stand.action !== null) {
    return {
      action: stand.action,
      why: stand.why,
      phase: "Standing down",
      stepPath: stand.rowID,
      interruptID: stand.rowID,
      status: "running",
      pauseReason: null,
      memory: stand.memory,
    };
  }

  // 3. The program, with the forward scan. `stand.memory` and not `scanMem`: the
  // pass above forgets a finished stand-down record without spending a tick on
  // it, and that forgetting has to reach the memory this returns.
  return runProgram(script, obs, stand.memory, registry, travelHome);
}

/**
 * Equipment the CURRENT step switched on that has to be off before the step
 * can actually finish — see the `until`-met branch above for why. Scoped to
 * mine-at-belt for now: the same gap exists for other equipment-activating
 * blocks (salvage-wrecks, hardeners-on, fight-the-rats), but mining is the one
 * that actively refills the very hold the next step tends to be draining.
 */
function equipmentToShutDownBeforeLeaving(step: MacroStep, obs: ScriptObservation): number | null {
  if (!["mine-at-belt", "fleet-mine"].includes(step.macro)) {
    return null;
  }
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  return (obs.miningModuleIDs ?? []).find((id) => active.has(id)) ?? null;
}

/**
 * The rock the CURRENT step locked that has to be released before the step
 * can actually finish — see the `until`-met branch above for why. Reads the
 * rock id back out of the step's OWN memory (already updated with this tick's
 * `nextMem` above) rather than guessing from `lockedTargetIDs` at large, so
 * this only ever releases a lock mine-at-belt itself put on — never a target
 * the player, or some other block, locked for its own reason.
 */
function targetToUnlockBeforeLeaving(
  step: MacroStep,
  obs: ScriptObservation,
  macroMem: Readonly<Record<string, MacroMemory>>,
): number | null {
  if (!["mine-at-belt", "fleet-mine"].includes(step.macro)) {
    return null;
  }
  const rockID = macroMem[step.id]?.["rockID"];
  if (typeof rockID !== "number") {
    return null;
  }
  return (obs.lockedTargetIDs ?? []).includes(rockID) ? rockID : null;
}

/** A running repairer whose repair watch has recovered, or null. */
function repairShutdown(
  script: BotScript,
  obs: ScriptObservation,
): { readonly rowID: string; readonly moduleID: number } | null {
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  if (active.size === 0) {
    return null;
  }
  for (const row of script.interrupts) {
    if (row.respond !== "repair") {
      continue;
    }
    if (evaluateCondition(row.when, obs) !== "not-met" &&
        !(obs.capacitorRatio != null && obs.capacitorRatio < REPAIR_CAP_FLOOR)) {
      continue;
    }
    const running = repairersFor(row.when.kind, obs).find((id) => active.has(id));
    if (running !== undefined) {
      return { rowID: row.id, moduleID: running };
    }
  }
  return null;
}

/**
 * Where a fight-back watch records what it will have to UNDO — the hardeners it
 * switched on, and whether it has already called the drones in.
 *
 * It cannot share the borrowed ladder's memory entry (keyed by the row id
 * itself): that ladder rewrites its memory wholesale on some rungs — picking a
 * fresh primary starts from `{}` — which would lose the record mid-fight and
 * leave the hardeners running for the rest of the run. Row ids and step ids
 * share one namespace; the suffix keeps this key out of it.
 */
function standDownKey(rowID: string): string {
  return `${rowID}:stand-down`;
}

// A type alias and not an interface on purpose: only an alias carries the
// implicit index signature that lets a record be stored back into `macroMem`,
// which is a `Record<string, unknown>` map.
type StandDownRecord = {
  /** Hardeners THIS watch switched on — so it is also the list it may switch off. */
  readonly hardened: readonly number[];
  readonly recalled: boolean;
};

function standDownRecord(mem: ScriptMemory, rowID: string): StandDownRecord {
  const raw = mem.macroMem[standDownKey(rowID)] ?? {};
  const hardened = raw["hardened"];
  return {
    hardened: Array.isArray(hardened) ? hardened.filter((id): id is number => typeof id === "number") : [],
    recalled: raw["recalled"] === true,
  };
}

// ─── The repair trip ─────────────────────────────────────────────────────────

/**
 * How many round trips a "dock at home and repair" row may make before it stops
 * instead.
 *
 * ⚠ THIS IS THE ONLY RESPONSE THAT COMES BACK, so it is the only one that can
 * commute. The trip is worth making because docking restores the shields and the
 * capacitor and the shop fixes the armor and hull — but if the reading that fired
 * the watch is still bad when the ship gets back out, the trip did not help, and
 * a bot that answers "still hurt" with "go home again" is a bot flying laps
 * between a belt and a station until the player notices. Three trips is enough
 * to ride out a bad pull and few enough that the fourth is plainly a pattern; at
 * that point it stops from the station like every other watch, saying so.
 */
export const MAX_RECOVER_TRIPS = 3;

/** Where the trip tally lives — the row's own key, kept out of the step namespace. */
function recoverKey(rowID: string): string {
  return `${rowID}:recover`;
}

/** Trips this row has already made without its condition reading not-met since. */
function recoverTrips(mem: ScriptMemory, rowID: string): number {
  const raw = mem.macroMem[recoverKey(rowID)]?.["trips"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/**
 * Forget the tally of every repair row whose condition now reads NOT-MET: the
 * trip worked, so the next bad pull starts from a full three again.
 *
 * Only not-met clears it. A cannot-tell must not — an unreadable ship is exactly
 * the state a docked bot is in (a docked session reports no ship at all), so
 * treating blind as recovered would reset the counter on every single trip and
 * hand the commuting bot an unbounded loop, which is the one thing the cap is
 * for.
 */
function releaseRecoverTrips(script: BotScript, obs: ScriptObservation, mem: ScriptMemory): ScriptMemory {
  let macroMem = mem.macroMem;
  for (const row of script.interrupts) {
    const key = recoverKey(row.id);
    if (!(key in macroMem) || evaluateCondition(row.when, obs) !== "not-met") {
      continue;
    }
    macroMem = omit(macroMem, key);
  }
  return macroMem === mem.macroMem ? mem : { ...mem, macroMem };
}

/**
 * Does the grid show hostiles, all of them beyond what the Fight-the-rats ladder
 * would reach? `hostilesInReach` is the ladder's own gate, shared so the two
 * cannot disagree about what "in reach" means.
 *
 * ⚠ ONLY A POSITIVE ANSWER STANDS THE WATCH ASIDE. No snapshot, an unreadable
 * targeting range (no gate at all, so everything counts as in reach) and a grid
 * with no hostile rows all read false and hand the tick to the ladder as before
 * — the last one on purpose: an empty grid is the ladder's call to make, with
 * its confirm reads, never this shortcut's.
 */
function outOfReachOnly(obs: ScriptObservation): boolean {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null || (obs.maxTargetRangeM ?? null) === null) {
    return false;
  }
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  return hostileRows(snapshot, origin).length > 0 && hostilesInReach(obs, snapshot, origin).length === 0;
}

/**
 * The next fitted hardener a fight-back watch should light, or null when there
 * is nothing to do.
 *
 * ⚠ ONE ATTEMPT PER HARDENER PER EPISODE, and that is the whole bound. The list
 * of what the watch switched on doubles as the list of what it has already
 * tried, so a hardener that will not come on is not retried every tick — which
 * would starve the step under the watch exactly the way an unreleased fight
 * would. The same list is why a hardener the player's own Hardeners-on block
 * already lit is never claimed here, and so is never switched off by the
 * stand-down: the watch only ever undoes its own work.
 */
function hardenerToLight(obs: ScriptObservation, mem: ScriptMemory, rowID: string): number | null {
  if (obs.inSpace !== true) {
    return null; // modules only run out in space
  }
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  const tried = new Set(standDownRecord(mem, rowID).hardened);
  return (obs.hardenerModuleIDs ?? []).find((id) => !active.has(id) && !tried.has(id)) ?? null;
}

interface StandDown {
  readonly action: ScriptAction | null;
  readonly why: string;
  readonly rowID: string | null;
  readonly memory: ScriptMemory;
}

/**
 * The fight-back watch's OFF half: once the pirate is gone, put the ship back
 * the way the watch found it — the drones it committed come home, then the
 * hardeners it switched on go off.
 *
 * ⚠ THIS CANNOT LIVE IN `fireInterrupt`. A watch is only consulted while its
 * condition is MET, so the moment the grid clears the fight-back row is never
 * reached again and the borrowed ladder's own "grid clear — call the drones
 * home" rung becomes unreachable: without this pass the drones stay in space and
 * the hardeners burn capacitor for the rest of the run. Same shape as the repair
 * thermostat above, and read the same way — only a NOT-MET condition stands the
 * ship down, because standing down blind is the worst possible moment to drop
 * the tank.
 *
 * IT NEVER WAITS. Every rung is a real action and shrinks the record, so the
 * whole stand-down is one tick per hardener plus one for the recall, and then
 * the program has the ship back. It does NOT hold the ship until the drones are
 * actually in the bay: they fly home on their own, and starving the step to
 * watch them do it is the one thing an always-armed response must not do.
 */
function standDownAfterFight(script: BotScript, obs: ScriptObservation, mem: ScriptMemory): StandDown {
  let memory = mem;
  for (const row of script.interrupts) {
    const key = standDownKey(row.id);
    if (row.respond !== "fight-back" || !(key in memory.macroMem)) {
      continue;
    }
    if (evaluateCondition(row.when, obs) !== "not-met") {
      continue;
    }
    const record = standDownRecord(memory, row.id);
    if (obs.inSpace !== true) {
      // Docked: the modules are off and the drones are in whatever the record
      // says, so there is nothing to undo — just forget it.
      memory = { ...memory, macroMem: omit(memory.macroMem, key) };
      continue;
    }
    // The drones first, while the tank is still up.
    const out = obs.combatDroneIDs ?? [];
    if (!record.recalled && out.length > 0) {
      return {
        action: { kind: "recallDrones", droneIDs: out },
        why: "The pirate is gone, so the drones come home.",
        rowID: row.id,
        memory: { ...memory, macroMem: { ...memory.macroMem, [key]: { ...record, recalled: true } } },
      };
    }
    // Then the hardeners — only the ones still running, and only ours.
    const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
    const next = record.hardened.find((id) => active.has(id));
    if (next !== undefined) {
      return {
        action: { kind: "deactivate", moduleID: next },
        why: "The pirate is gone, so the hardener goes back off.",
        rowID: row.id,
        memory: {
          ...memory,
          macroMem: {
            ...memory.macroMem,
            [key]: { hardened: record.hardened.filter((id) => id !== next), recalled: true },
          },
        },
      };
    }
    memory = { ...memory, macroMem: omit(memory.macroMem, key) };
  }
  return { action: null, why: "", rowID: null, memory };
}

// ─── Interrupts ──────────────────────────────────────────────────────────────

/**
 * THIS ROW DID NOTHING, SO IT IS TRANSPARENT: carry the scan on below it, and
 * run the program only when no lower row fires either.
 *
 * ⚠ WHY THIS EXISTS. Interrupts are first-match-wins, and several responses can
 * fire and then have no work: a repair watch whose layer has no repairer fitted
 * (or whose repairers are all already running), a launch-drones watch whose
 * drones are out, a fight-back watch with nothing in reach to shoot. Before this,
 * each of those answered by running the program — which quietly silenced every
 * row UNDER it for as long as its condition held. The shape that costs a ship:
 *
 *     shield-below 0.10 -> repair          (an armour-tanked hull: no shield booster)
 *     armor-below  0.45 -> dock-and-pause
 *
 * Shields under 10% is exactly when the second row is the one that matters, and
 * it never fired, because the first row won the scan every tick and did nothing
 * with it. The player wrote a flee rule and watched it not happen.
 *
 * It is the same rule a spent alert row already lived by (scriptConditions
 * `firstArmedInterrupt`), generalised from "said its piece" to "has nothing to
 * do": a row only holds the ship while it is actually acting on it.
 *
 * ⚠ IT CANNOT LOOP. The scan resumes strictly BELOW the row that fell through,
 * so each hop moves down a bounded list (MAX_INTERRUPTS) and the bottom is
 * `runProgram` — the very thing every one of these branches used to do
 * immediately.
 */
function fallThrough(
  script: BotScript,
  rowID: string,
  obs: ScriptObservation,
  mem: ScriptMemory,
  travelHome: HomeTravelDecider,
  registry: MacroRegistry,
): ScriptTickResult {
  const below = firstArmedInterrupt(
    script.interrupts,
    obs,
    mem.spentAlerts ?? [],
    script.interrupts.findIndex((r) => r.id === rowID) + 1,
  );
  return below === null
    ? runProgram(script, obs, mem, registry, travelHome)
    : fireInterrupt(script, below.id, obs, mem, travelHome, registry);
}

function fireInterrupt(
  script: BotScript,
  rowID: string,
  obs: ScriptObservation,
  mem: ScriptMemory,
  travelHome: HomeTravelDecider,
  registry: MacroRegistry,
): ScriptTickResult {
  const row = script.interrupts.find((r) => r.id === rowID);
  if (row === undefined) {
    return runProgram(script, obs, mem, registry, travelHome);
  }
  switch (row.respond) {
    case "pause":
      // "Just stop and wait" still stops — from a STATION. The watch fired for a
      // reason the player wanted to be told about, and leaving the ship parked in
      // space to be told about it is how a mining bot ends up dead in a belt with
      // a full hold. In space this now reads the same as "dock at home and stop";
      // docked, it stops exactly where it stands.
      return stopSafely(stoppedBecause(conditionSentence(row.when)), mem, row.id, obs, travelHome);
    case "dock-and-pause": {
      const latched: Latched = { interruptID: row.id, reason: stoppedBecause(conditionSentence(row.when)) };
      return continueHeadingHome(obs, { ...mem, latched }, travelHome);
    }
    case "dock-and-repair": {
      // THE TRIP CAP IS READ BEFORE THE TRIP IS MADE, not after it — a row that
      // has already been home three times without the reading getting better is
      // not sent home a fourth time, it stops (from the station, like everything
      // else here).
      const trips = recoverTrips(mem, row.id) + 1;
      if (trips > MAX_RECOVER_TRIPS) {
        return stopSafely(sayRepairDidNotHold(row.when), mem, row.id, obs, travelHome);
      }
      // The trip is counted on the way OUT, and written before the flight starts:
      // a trip that never comes back — a bot stopped or lost mid-flight — is
      // still a trip that was made, and the tally lives in the very memory the
      // flight home is about to keep rewriting.
      const latched: Latched = {
        interruptID: row.id,
        reason: stoppedBecause(conditionSentence(row.when)),
        // ONLY a ship KNOWN to be flying is sent back out. An unreadable one is
        // left docked: the program's next step then says what it needs (a space
        // step waits for space, a station step gets on with it), which is a
        // better answer than undocking a bot that was working in the hangar.
        recover: { undock: obs.inSpace === true, firedSystem: readSystem(obs) },
      };
      return continueRecovering(
        script,
        obs,
        {
          ...mem,
          latched,
          macroMem: { ...mem.macroMem, [recoverKey(row.id)]: { trips } },
        },
        registry,
        travelHome,
      );
    }
    case "launch-drones": {
      // The COMBAT drones, by role (nav/droneRoles.ts) — never the whole bay.
      // Satisfied once they are out. Nothing to do either when the bay holds no
      // combat drones (a bay of salvage drones defends nothing) or when OTHER
      // drones hold the slots: a launch into full slots is refused every tick
      // and would starve the step under it, so the watch stands aside.
      const combatOut = obs.combatDroneIDs ?? [];
      const combatBay = obs.combatDroneBayItemIDs ?? [];
      if (combatOut.length > 0 || combatBay.length === 0 || obs.dronesOut === true) {
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      return {
        action: { kind: "launchDrones", droneItemIDs: combatBay },
        why: "A pirate showed up, so the combat drones go out to defend the ship.",
        phase: "Defending",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: mem,
      };
    }
    case "fight-back": {
      // ⚠ BORROWED, NOT COPIED. The combat ladder (drones out → lock the nearest
      // hostile in targeting range → drones onto it → every idle gun onto it)
      // already exists as the Fight-the-rats block, and it is reached the only
      // way this file is allowed to reach a macro: through the injected registry.
      // That keeps the orchestrator's one dependency rule intact (it knows macro
      // IDs, never macro code) and means the watch and the block can never drift
      // apart — a fix to one is a fix to both.
      const fight = registry["fight-the-rats"];
      if (fight === undefined) {
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      // THE TANK GOES UP FIRST. A hardener is instant and self-targeted, so it
      // costs one tick and buys the whole fight — the same thing a player reaches
      // for before they reach for the guns. Bounded to one attempt each per
      // episode by `hardenerToLight`, and what it lights is written down so the
      // stand-down can put it back (`standDownAfterFight`).
      const hardener = hardenerToLight(obs, mem, row.id);
      if (hardener !== null) {
        const record = standDownRecord(mem, row.id);
        return {
          action: { kind: "activate", moduleID: hardener, targetID: 0 },
          why: "A pirate showed up, so the hardeners go on before the fight.",
          phase: "Hardening",
          stepPath: row.id,
          interruptID: row.id,
          status: "running",
          pauseReason: null,
          memory: {
            ...mem,
            macroMem: {
              ...mem.macroMem,
              [standDownKey(row.id)]: { ...record, hardened: [...record.hardened, hardener] },
            },
          },
        };
      }
      // ⚠ A PIRATE THE LADDER CANNOT REACH DOES NOT GET THE SHIP. The condition
      // counts the whole grid; the ladder counts only what is inside targeting
      // range. Borrowing the ladder for a rat parked out of reach made it spend
      // its three empty-grid confirm reads, report done, release for ONE tick,
      // and get borrowed again on the next — so the step under the watch ran one
      // tick in four until the rat closed or left (caught live 2026-09-30: loot,
      // salvage and travel steps crawling under a `hostile-on-grid` watch).
      //
      // Those confirm reads guard against a grid that has not ARRIVED after a
      // warp (2026-09-14), and this gate leaves them alone: it stands aside only
      // when the grid HAS arrived — it shows a hostile — and every hostile it
      // shows is beyond the range the ladder would gate them out by. A watch
      // mid-fight (ladder memory present: the last rat in reach just died) still
      // hands the tick to the ladder, so the fleet call is stood down and the
      // drones are recalled exactly as they always were before it releases.
      if (!(row.id in mem.macroMem) && outOfReachOnly(obs)) {
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      // The ladder's memory (which target is primary, whether the lock was
      // issued, which target the drones are already on) is keyed by the WATCH
      // ROW's id in the same per-step memory map the program's steps use. Row ids
      // and step ids share one namespace, so this needs no new memory slot — and
      // it keeps the watch's fight separate from any Fight-the-rats STEP the same
      // script might also run.
      // The row's own combat settings ride into the borrowed block as its args,
      // so a watch fights exactly the way a block does — calling the fleet's
      // primary, following one, ordering which hostile dies first. This is the
      // handler that actually fires in a working bot (the program is busy
      // mining or hauling when the rats arrive), so it is the one that has to
      // be able to do these things.
      const step: MacroStep = {
        id: row.id,
        kind: "macro",
        macro: "fight-the-rats",
        args: {
          ...(row.squad === undefined ? {} : { squad: { kind: "squadRole" as const, role: row.squad } }),
          ...(row.targets === undefined ? {} : { targets: { kind: "targetList" as const, classes: row.targets } }),
        },
      };
      const tick = fight(step, obs, mem.macroMem[row.id] ?? {}, mem.board);
      if (tick.outcome.kind !== "acting") {
        // Nothing left to fight — the grid is clear, nothing is inside targeting
        // range, or this hull cannot fight at all. THIS IS THE RELEASE: the watch
        // drops the ship and the step under it carries on from where it was. An
        // always-armed response that never released would starve the program.
        //
        // Only the LADDER's memory goes. The stand-down record under
        // `standDownKey` deliberately survives the release — it is the only note
        // of which hardeners this watch switched on, and it is read after the
        // condition clears, which is long after this row stops being consulted.
        const { [row.id]: _spent, ...rest } = mem.macroMem;
        return fallThrough(script, row.id, obs, { ...mem, macroMem: rest }, travelHome, registry);
      }
      // The ladder is ACTING, so this watch has now committed the ship to a
      // fight — write the stand-down record even when there was no hardener to
      // light. Without this a hull with no hardeners fitted would fight, clear
      // the grid, and leave its drones in space forever: the record is the only
      // thing the stand-down looks for. Rewriting it each tick is idempotent —
      // `standDownRecord` reads the existing one back, so a recall already
      // issued stays issued.
      return {
        action: tick.action,
        why: tick.why,
        phase: tick.phase,
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: {
          ...mem,
          macroMem: {
            ...mem.macroMem,
            [row.id]: tick.nextMem,
            [standDownKey(row.id)]: standDownRecord(mem, row.id),
          },
        },
      };
    }
    case "repair": {
      // Switch ON one idle repairer for the watched layer — unless the capacitor
      // is too low to feed it, in which case switch one OFF instead (an empty cap
      // repairs nothing and locks the ship up). One action, then the program
      // continues; the watch re-fires next tick while the condition holds.
      const reps = repairersFor(row.when.kind, obs);
      if (reps.length === 0) return fallThrough(script, row.id, obs, mem, travelHome, registry);
      // An unreadable rack/cap is not an empty rack/full capacitor. Never issue
      // another activation from these unknowns; explicit escape was checked first.
      if (obs.snapshot?.ship?.activeModuleIDs == null || obs.capacitorRatio == null) {
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
      const cap = obs.capacitorRatio ?? null;
      if (cap !== null && cap < REPAIR_CAP_FLOOR) {
        const running = reps.find((id) => active.has(id));
        if (running !== undefined) {
          return {
            action: { kind: "deactivate", moduleID: running },
            why: "The capacitor is nearly empty, so the repairer is switched off to let it recover.",
            phase: "Repairing",
            stepPath: row.id,
            interruptID: row.id,
            status: "running",
            pauseReason: null,
            memory: mem,
          };
        }
        const sustain = combatCapSustain(obs, mem.macroMem[row.id] ?? {}, REPAIR_CAP_FLOOR);
        if (sustain.action) {
          const owned = ownCombatAction(combatOwnership(sustain.memory, obs), sustain.action, obs);
          return { action: sustain.action, why: sustain.why, phase: "Sustaining repair", stepPath: row.id,
            interruptID: row.id, status: "running", pauseReason: null,
            memory: { ...mem, macroMem: { ...mem.macroMem, [row.id]: { ...sustain.memory, combatOwned: owned } } } };
        }
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      const idle = reps.find((id) => !active.has(id));
      if (idle === undefined) {
        // Nothing to switch on (all running, or none fitted) — stand aside, so a
        // flee row under this one is reached instead of being silenced by a
        // thermostat that is already doing all it can.
        return fallThrough(script, row.id, obs, mem, travelHome, registry);
      }
      return {
        action: { kind: "activate", moduleID: idle, targetID: 0 },
        why: "Running the repairers.",
        phase: "Repairing",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: mem,
      };
    }
    case "alert": {
      // Say it ONCE, mark the row spent (so it neither repeats nor blocks the
      // rows under it), and keep the program running — an alert changes nothing
      // about the ship. The next tick's scan skips this row and reaches whatever
      // sits below it, which is what makes "tell me AND dock" work as two rows.
      const spent = [...(mem.spentAlerts ?? []), row.id];
      const message = alertSentence(row);
      return {
        action: { kind: "alert", message },
        why: message,
        phase: "Letting you know",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: { ...mem, spentAlerts: spent },
      };
    }
  }
}

/** Don't run a repairer below this — an empty capacitor repairs nothing. */
export const REPAIR_CAP_FLOOR = 0.2;

/** Which fitted repairers answer a given watch: the matching layer, or ALL for a
 * whole-ship (health-below) watch. Non-health watches repair nothing. */
function repairersFor(kind: Condition["kind"], obs: ScriptObservation): readonly number[] {
  switch (kind) {
    case "shield-below":
      return obs.shieldRepairerIDs ?? [];
    case "armor-below":
      return obs.armorRepairerIDs ?? [];
    case "hull-below":
      return obs.hullRepairerIDs ?? [];
    case "health-below":
      return [
        ...(obs.shieldRepairerIDs ?? []),
        ...(obs.armorRepairerIDs ?? []),
        ...(obs.hullRepairerIDs ?? []),
      ];
    default:
      return [];
  }
}

function continueHeadingHome(
  obs: ScriptObservation,
  mem: ScriptMemory,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  const latched = mem.latched;
  if (latched === null) {
    // Should not happen; nothing to fly. Treat as a plain pause.
    return paused(SAY.headingHome, mem, null);
  }
  const homeMem = mem.macroMem[HOME_MEM_KEY] ?? {};
  const tick = travelHome(obs, homeMem);
  const macroMem = { ...mem.macroMem, [HOME_MEM_KEY]: tick.nextMem };

  if (tick.outcome.kind === "done") {
    // Docked at home — now stop with the reason that sent us here.
    return paused(latched.reason, { ...mem, macroMem, latched: null }, latched.interruptID);
  }
  if (tick.outcome.kind === "blocked") {
    return paused(tick.outcome.reason, { ...mem, macroMem, latched: null }, latched.interruptID);
  }
  return {
    action: tick.action,
    why: tick.why,
    phase: tick.phase,
    stepPath: latched.interruptID,
    interruptID: latched.interruptID,
    status: "running",
    pauseReason: null,
    memory: { ...mem, macroMem },
  };
}

/**
 * The "dock at home and repair" trip, tick by tick: home, the repair shop, back
 * out, and then the program picks up at the step it was interrupted on.
 *
 * ⚠ IT IS A LATCH AND NOT A RESPONSE PER TICK. Every other watch is consulted
 * afresh while its condition holds, which is exactly wrong for a trip that ends
 * at a station: docking makes the ship unreadable (a docked session reports no
 * ship, `docs/bridge-wire-contract.md` — no shields, no armor, no hull), so a
 * per-tick response would lose its condition the moment it arrived and abandon
 * the ship in the station with the program stalled. Latching means the trip owns
 * the ship from the moment it fires until the ship is back out and working.
 *
 * THE STATION STAY IS THE REPAIR, and that is why there is no "wait for the
 * shields" rung: docking restores the shields and the capacitor by itself, so
 * what is left to do is the two layers that do NOT come back on their own —
 * armor and hull — which is precisely what the shop sells and what the
 * Repair-ship block already knows how to buy. The trip cap
 * (`MAX_RECOVER_TRIPS`) is what catches a ship that comes back out still hurt,
 * so nothing here has to be able to read a shield through a station wall.
 */
function continueRecovering(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  const latched = mem.latched;
  if (script.home.entity === "structure" && latched?.recover !== undefined) {
    return paused("Repair watches require a verified NPC station repair path.",
      { ...mem, latched: null }, latched.interruptID);
  }
  if (latched === null || latched.recover === undefined) {
    // Not a repair trip at all — the ordinary "fly home and stop" latch.
    return continueHeadingHome(obs, mem, travelHome);
  }
  const rowID = latched.interruptID;

  // 1. HOME FIRST — the same flight every fired watch makes, drone recall and
  // fight-your-way-out included. `done` means docked (anywhere: a station in
  // reach beats a commute), which is the only place the rest of this can happen.
  const homeMem = mem.macroMem[HOME_MEM_KEY] ?? {};
  const trip = travelHome(obs, homeMem);
  const macroMem = { ...mem.macroMem, [HOME_MEM_KEY]: trip.nextMem };
  if (trip.outcome.kind === "blocked") {
    // No home to fly to, or no way to reach it. A trip that cannot start is a
    // stop, exactly as it is for dock-and-pause.
    return paused(trip.outcome.reason, { ...mem, macroMem, latched: null }, rowID);
  }
  if (trip.outcome.kind !== "done") {
    return {
      action: trip.action,
      why: trip.why,
      phase: trip.phase,
      stepPath: rowID,
      interruptID: rowID,
      status: "running",
      pauseReason: null,
      memory: { ...mem, macroMem },
    };
  }

  // 2. THE REPAIR SHOP — borrowed, not copied. The Repair-ship block already
  // quotes the shop, pays it and re-quotes until nothing is left, and it is
  // reached the one way this file is allowed to reach a macro: through the
  // injected registry (the same rule fight-back borrows the ratting ladder by).
  // A fix to the block is a fix to the trip.
  const repair = registry["repair-ship"];
  const repairMem = mem.macroMem[REPAIR_MEM_KEY] ?? {};
  if (repair !== undefined) {
    const step: MacroStep = { id: rowID ?? REPAIR_MEM_KEY, kind: "macro", macro: "repair-ship", args: {} };
    const shop = repair(step, obs, repairMem, mem.board);
    if (shop.outcome.kind === "acting") {
      return {
        action: shop.action,
        why: shop.why,
        phase: shop.phase,
        stepPath: rowID,
        interruptID: rowID,
        status: "running",
        pauseReason: null,
        memory: { ...mem, macroMem: { ...macroMem, [REPAIR_MEM_KEY]: shop.nextMem } },
      };
    }
    // ⚠ "BLOCKED" IS NOT A STOP HERE, unlike the same outcome from the block.
    // The shop refuses for one practical reason — the wallet will not cover it —
    // and stranding a working bot in a station because it cannot afford to fix a
    // scratch is a worse answer than sending it back out with the shields and
    // capacitor the dock just gave it. If the damage genuinely matters, the
    // watch fires again on the next lap and the trip cap ends the run properly.
  }

  // 3. BACK OUT, and the program carries on — from the step it was interrupted
  // on, UNLESS the trip put the ship down in a different solar system than the
  // one the interrupt fired in, in which case it carries on from the START OF
  // THE ENCLOSING LOOP instead. The latch is dropped on this same tick, which
  // re-arms every watch: the ship is whole (or as whole as the shop could make
  // it), so the row that fired should be free to fire again on the next real
  // reading.
  //
  // THE INCIDENT THIS GUARDS: a five-pilot mining run working a nullsec system
  // had its shields dip mid mine-at-belt. dock-and-repair flew the ship home,
  // patched it up — at a station in a DIFFERENT, HIGHSEC system, the bot's
  // designated home — and sent it back out, where the program resumed
  // mine-at-belt exactly where it had left off. Every runtime binding that step
  // had resolved (`belt: nearest`, chosen off the ship's grid at the moment it
  // was interrupted) belonged to the nullsec work system, not the highsec
  // system the ship now sat in. The wanted ore cannot spawn in a mission hub.
  // Every pilot mined the only belts actually in reach, marked them all dry,
  // and the run died — nobody had ever gone back to where the mining was
  // supposed to happen.
  //
  // A SYSTEM MISMATCH, SPECIFICALLY, IS THE TRIGGER. A trip that lands back in
  // the SAME system invalidates nothing — every binding the step resolved is
  // still good, so resuming it is correct and restarting the loop would only
  // repeat travel already done. Only a DIFFERENT system stales those bindings,
  // and only the loop the interrupted step sits in knows how to re-derive them
  // cleanly: its first element runs again exactly as any ordinary pass would
  // (an undock that is already undocked, a travel-to-system already AT that
  // system — both no-ops, both self-correcting), which is what walks the ship
  // back to the work system with no travel logic of its own. A step that is
  // NOT inside a loop has no body to restart, so it keeps today's behaviour —
  // see `enclosingLoopRestart`.
  const restart = systemsDiffer(latched.recover.firedSystem, readSystem(obs))
    ? enclosingLoopRestart(script, mem.position)
    : null;
  const clearedMacroMem = omit(omit(macroMem, HOME_MEM_KEY), REPAIR_MEM_KEY);
  // The abandoned step's own memory goes with it — a cached "nearest belt" (or
  // any other binding a macro cached against the wrong grid) must not survive
  // into the loop's fresh first pass, or the rewind would restart the SHAPE of
  // the step while still running on the STALE binding that caused the trouble.
  const abandonedStepID = restart !== null ? committedStepID(script, mem.position) : null;
  const rewoundMacroMem = abandonedStepID !== null ? omit(clearedMacroMem, abandonedStepID) : clearedMacroMem;
  const settled: ScriptMemory = {
    ...mem,
    latched: null,
    position: restart ?? mem.position,
    // ⚠ `loopPass` IS LEFT EXACTLY WHERE IT WAS, and that is the whole of the
    // rule. It counts passes the loop has COMPLETED (`advanceLoopBody` reads it
    // as `donePasses = loopPass + 1`), and the pass this rewind lands back at
    // the start of is the one that never finished — so nothing has completed
    // that had not completed a moment ago, and the counter has nothing to say
    // about it. Resetting it to 0 here would be a quiet gift of a whole extra
    // run to every `times`-bounded loop: a `repeat 23 times` interrupted on its
    // twentieth pass would go back to zero and fly another twenty-three, and a
    // hauling script told to make a fixed number of trips would make almost
    // twice as many because its shields once dipped in the wrong system. The
    // rewind changes WHERE the program is, never HOW MUCH of the loop it has
    // already been paid for.
    //
    // ⚠ THE REWIND CANNOT TRIP THE LIVELOCK GUARD. `wraps` in `runProgram` is a
    // per-call counter that only increments when the SCAN ITSELF walks off the
    // end of a loop body and back to its start (`advanceLoopBody`'s own
    // `wrapped` flag); it does not exist yet when this function returns, and a
    // rewind reached by ASSIGNING `position` directly — never by advancing —
    // never sets it. The very next `runProgram` call (this tick, or next tick
    // after an undock) starts `wraps` at zero exactly as it would after any
    // other kind of tick, so a rewound loop gets its usual two free wraps
    // before the guard would even consider it a runaway.
    loopPass: mem.loopPass,
    macroMem: rewoundMacroMem,
  };
  if (latched.recover.undock && obs.docked === true) {
    return {
      action: { kind: "undock" },
      why: "Patched up, so the bot leaves the station and picks up where it left off.",
      phase: "Leaving the station",
      stepPath: rowID,
      interruptID: rowID,
      status: "running",
      pauseReason: null,
      memory: settled,
    };
  }
  return runProgram(script, obs, settled, registry, travelHome);
}

// ─── The forward scan ────────────────────────────────────────────────────────

function runProgram(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  let position = mem.position;
  let loopPass = mem.loopPass;
  let macroMem = mem.macroMem;
  let board = mem.board;
  let blindThisTick = false;
  // A completed invocation can wrap straight back to the same path in this
  // scan. Its silence budget belongs to that invocation, not to the path key.
  let invocationAdvanced = false;

  // A loop RE-ENTERING its own body is the only backward edge, and a single one
  // per tick is normal (the last body step finished, so we wrap to the first). A
  // SECOND wrap in one tick means a whole pass completed issuing no world call —
  // a hollow pass, the livelock. `maxHops` is a belt-and-suspenders ceiling.
  let wraps = 0;
  const maxHops = 2 * totalSteps(script) + script.program.length + 4;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (position.kind === "done") {
      return done({ ...mem, position, loopPass, macroMem, board });
    }

    // At the top of a loop pass, a loop-level `until` can end the loop early.
    // (The first body element may itself be a branch, so both entry kinds count.)
    if ((position.kind === "loop" || position.kind === "loop-branch-enter") && position.body === 0) {
      const loop = script.program[position.node] as LoopBlock;
      if (loop.until !== undefined && evaluateCondition(loop.until, obs) === "met") {
        const paths = loop.body.flatMap(node => node.kind === "branch" ? [...node.then, ...node.else].map(step => step.id) : [node.id]);
        for (const path of paths) {
          const state = macroMem[path];
          if (!state?.combatOwned) continue;
          const settlement = settleCombat(obs, state);
          macroMem = { ...macroMem, [path]: settlement.nextMem };
          if (settlement.outcome.kind === "blocked") return stopSafely(settlement.outcome.reason,
            { ...mem, position, loopPass, macroMem, board }, path, obs, travelHome);
          if (settlement.outcome.kind !== "done") return { action: settlement.action, why: settlement.why,
            phase: settlement.phase, status: "running", pauseReason: null, stepPath: path, interruptID: null,
            memory: { ...mem, position, loopPass, macroMem, board } };
          macroMem = omit(macroMem, path);
        }
        position = startOfNode(script, position.node + 1);
        invocationAdvanced = true;
        loopPass = 0;
        continue;
      }
    }

    // Entering a branch: read its `when` ONCE and commit to a side (or skip an
    // empty side, or wait when it cannot be read — a side is never chosen blind).
    // Committing on entry is why a `when` that flips mid-side never bounces.
    // Handles a top-level branch and one inside a loop body with the same code.
    if (position.kind === "branch-enter" || position.kind === "loop-branch-enter") {
      // `loopBodyIndex` is the branch's slot in a loop body, or null at top level
      // — one value that both narrows the union and says which case we are in.
      const loopBodyIndex = position.kind === "loop-branch-enter" ? position.body : null;
      const branchNode = position.node;
      const branch =
        loopBodyIndex !== null
          ? ((script.program[branchNode] as LoopBlock).body[loopBodyIndex] as BranchBlock)
          : (script.program[branchNode] as BranchBlock);
      // A draining operation must deliver the last partial hold even when the
      // normal full-hold threshold is not met. Keep this scoped to the
      // operation's single delivery branch.
      const finalDelivery = branch.when.kind === "ore-hold-at-least" &&
        branch.then.length === 1 && branch.then[0]?.kind === "macro" &&
        branch.then[0].macro === "deliver-ore" && confirmedDrain(obs, board);
      const verdict = finalDelivery ? "met" : evaluateCondition(branch.when, obs);
      if (verdict === "cannot-tell") {
        // No `isSilent` test here: a branch whose `when` cannot be read waits,
        // full stop, so every tick counted at this position is already a silent
        // one. (The cannot-tell streak is the tighter of the two and normally
        // fires long first; this stays as the backstop it always was.)
        const samePlace = positionKey(position) === positionKey(mem.position);
        const stepTicks = (samePlace && !invocationAdvanced ? mem.stepTicks : 0) + 1;
        if (stepTicks > MAX_SILENT_STEP_TICKS) {
          return stopSafely(SAY.stepDidNothing, { ...mem, position, loopPass, macroMem, board }, branch.id, obs, travelHome);
        }
        const streak = bumpCannotTellStreak(mem.cannotTellStreak, true);
        if (cannotTellStreakExhausted(streak)) {
          return stopSafely(COND_SENTENCE.cannotTellStreak, { ...mem, position, loopPass, macroMem, board }, branch.id, obs, travelHome);
        }
        return {
          action: WAIT,
          why: `Working out whether ${conditionSentence(branch.when)}.`,
          phase: "Choosing a branch",
          stepPath: branch.id,
          interruptID: null,
          status: "running",
          pauseReason: null,
          // ⚠ SPREAD `mem` FIRST. This used to build the memory field by field, which
          // silently dropped anything the scan does not itself manage — `spentAlerts`
          // was reset every tick, so an "alert me" watch re-alerted forever.
          memory: { ...mem, position, loopPass, stepTicks, cannotTellStreak: streak, latched: null, macroMem, board },
        };
      }
      const side = verdict === "met" ? "then" : "else";
      const sideBody = side === "then" ? branch.then : branch.else;
      if (sideBody.length === 0) {
        // The chosen side is empty ("do nothing on this branch") — carry on past
        // it: out of the loop body (which may wrap the pass), or past the node.
        if (loopBodyIndex !== null) {
          const next = advanceLoopBody(script, branchNode, loopBodyIndex, loopPass);
          position = next.position;
          invocationAdvanced = true;
          loopPass = next.loopPass;
          if (next.wrapped) {
            wraps += 1;
            if (wraps >= 2) {
              return stopSafely(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null, obs, travelHome);
            }
          }
        } else {
          position = startOfNode(script, branchNode + 1);
          invocationAdvanced = true;
          loopPass = 0;
        }
        continue;
      }
      position =
        loopBodyIndex !== null
          ? { kind: "loop-branch", node: branchNode, body: loopBodyIndex, side, inner: 0 }
          : { kind: "branch", node: branchNode, side, body: 0 };
      continue;
    }

    const step = activeStep(script, position);
    const decider = registry[step.macro];
    if (decider === undefined) {
      return stopSafely(SAY.unknownMacro, { ...mem, position, loopPass, macroMem, board }, step.id, obs, travelHome);
    }

    const stepMem = macroMem[step.id] ?? {};
    const untilCombat = step.macro === "fight-with-drones" && stepMem.combatOwned &&
      (stepMem.combatSettling === true || step.until !== undefined && evaluateCondition(step.until, obs) === "met");
    const tick = untilCombat ? settleCombat(obs, { ...stepMem, combatSettling: true }) : decider(step, obs, stepMem, board);
    macroMem = { ...macroMem, [step.id]: tick.nextMem };
    if (tick.boardPatch !== undefined) {
      board = { ...board, ...tick.boardPatch };
    }

    if (tick.outcome.kind === "blocked") {
      return stopSafely(tick.outcome.reason, { ...mem, position, loopPass, macroMem, board }, step.id, obs, travelHome);
    }

    if (tick.outcome.kind === "skipped") {
      // The step cannot do its job on this ship, and that is not worth stopping
      // the whole program for. Say so ONCE — through the alert path, which is
      // held on the readout and on a server bot's record so a player who was
      // away still sees it — and move on exactly as a finished step does. The
      // SECOND time the same step is skipped (a loop brought it round again)
      // it advances silently, so a program with nothing else to do falls
      // through to the livelock guard below instead of alerting every tick.
      macroMem = omit(macroMem, step.id);
      const next = advance(script, position, loopPass);
      const skipped = mem.skippedSteps ?? [];
      if (skipped.includes(step.id)) {
        position = next.position;
        invocationAdvanced = true;
        loopPass = next.loopPass;
        if (next.wrapped) {
          wraps += 1;
          if (wraps >= 2) {
            return stopSafely(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null, obs, travelHome);
          }
        }
        continue;
      }
      const message = `Skipped "${stepSentence(step)}": ${tick.outcome.reason}`;
      return {
        action: { kind: "alert", message },
        why: message,
        phase: "Skipping a step",
        stepPath: step.id,
        interruptID: null,
        status: "running",
        pauseReason: null,
        memory: {
          ...mem,
          position: next.position,
          loopPass: next.loopPass,
          stepTicks: 0,
          macroMem,
          board,
          skippedSteps: [...skipped, step.id],
        },
      };
    }

    if (tick.outcome.kind === "done") {
      macroMem = omit(macroMem, step.id); // leaving the step — its memory resets
      const next = advance(script, position, loopPass);
      position = next.position;
      invocationAdvanced = true;
      loopPass = next.loopPass;
      if (next.wrapped) {
        wraps += 1;
        if (wraps >= 2) {
          return stopSafely(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null, obs, travelHome);
        }
      }
      continue;
    }

    // outcome "acting" — the player's `until` can finish the step, but only once
    // the macro is ARMED (so a grid-dependent until cannot read true mid-warp).
    if (step.until !== undefined) {
      const verdict = evaluateCondition(step.until, obs);
      if (verdict === "met" && tick.armed) {
        // The macro's own tick action (computed above) is about to be thrown
        // away in favour of advancing — but equipment it already switched on
        // (mine-at-belt's lasers) keeps cycling regardless of what the program
        // does next, since nothing else ever tells it to stop. Left running, it
        // goes on filling the very hold the next step (typically a jettison) is
        // trying to empty, so that hold never reads empty and the loop never
        // completes. Switch it off first, one module per tick — the same move
        // the interrupt ladder's repair thermostat makes above.
        const runningModuleID = equipmentToShutDownBeforeLeaving(step, obs);
        if (runningModuleID !== null) {
          return {
            action: { kind: "deactivate", moduleID: runningModuleID },
            why: "The until condition is met — switching the mining equipment off before moving on.",
            phase: tick.phase,
            stepPath: step.id,
            interruptID: null,
            status: "running",
            pauseReason: null,
            memory: { ...mem, position, loopPass, macroMem, board },
          };
        }
        // The lock on the rock the step was working outlives the step itself
        // exactly the same way — nothing else ever releases it, so leaving the
        // rock locked and picking a fresh one (usually a different one) next
        // cycle only ADDS a lock, never trades one out. A few of these cycles
        // and the ship is sitting at its max locked targets with old, no-longer-
        // relevant rocks still held, unable to lock the next one at all.
        const lockedTargetID = targetToUnlockBeforeLeaving(step, obs, macroMem);
        if (lockedTargetID !== null) {
          return {
            action: { kind: "unlock", targetID: lockedTargetID },
            why: "The until condition is met — releasing the lock before moving on.",
            phase: tick.phase,
            stepPath: step.id,
            interruptID: null,
            status: "running",
            pauseReason: null,
            memory: { ...mem, position, loopPass, macroMem, board },
          };
        }
        macroMem = omit(macroMem, step.id); // leaving the step — its memory resets
        const next = advance(script, position, loopPass);
        position = next.position;
        invocationAdvanced = true;
        loopPass = next.loopPass;
        if (next.wrapped) {
          wraps += 1;
          if (wraps >= 2) {
            return stopSafely(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null, obs, travelHome);
          }
        }
        continue;
      }
      if (verdict === "cannot-tell" && tick.armed) {
        blindThisTick = true;
      }
    }

    // Issue the macro's action — the single action of this tick.
    //
    // The silence counter is bumped only when that action is a wait: a macro
    // that issued a world call this tick is working, however long it has been at
    // it, and starts again from zero. Leaving the position clears it too, which
    // is what a `done` or a skip does on its way past.
    const samePlace = positionKey(position) === positionKey(mem.position);
    const stepTicks = isWorldCall(tick.action) ? 0 : (samePlace && !invocationAdvanced ? mem.stepTicks : 0) + 1;
    if (stepTicks > MAX_SILENT_STEP_TICKS) {
      return stopSafely(SAY.stepDidNothing, { ...mem, position, loopPass, macroMem, board }, step.id, obs, travelHome);
    }
    const streak = bumpCannotTellStreak(mem.cannotTellStreak, blindThisTick);
    if (cannotTellStreakExhausted(streak)) {
      return stopSafely(COND_SENTENCE.cannotTellStreak, { ...mem, position, loopPass, macroMem, board }, step.id, obs, travelHome);
    }

    return {
      action: tick.action,
      containerTargetID: tick.containerTargetID,
      settleDrones: tick.settleDrones,
      why: tick.why,
      phase: tick.phase,
      stepPath: step.id,
      interruptID: null,
      status: "running",
      pauseReason: null,
      memory: {
        // ⚠ `...mem` first, for the same reason as the branch-wait return above:
        // field-by-field construction drops whatever the scan does not manage, and
        // `spentAlerts` lives outside the scan (it belongs to the interrupt ladder).
        ...mem,
        position,
        loopPass,
        stepTicks,
        cannotTellStreak: streak,
        latched: null,
        macroMem,
        board,
      },
    };
  }

  // The scan is bounded by construction; reaching here means it could not make
  // progress, which is the livelock case under another name.
  return stopSafely(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null, obs, travelHome);
}

// ─── Position arithmetic ─────────────────────────────────────────────────────

function startOfNode(script: BotScript, node: number): Position {
  if (node >= script.program.length) {
    return { kind: "done" };
  }
  const target = script.program[node];
  if (target?.kind === "loop") {
    // The first body element may itself be a branch — enter it properly.
    return startOfLoopBody(script, node, 0);
  }
  if (target?.kind === "branch") {
    return { kind: "branch-enter", node };
  }
  return { kind: "step", node };
}

/**
 * The position at a given index of a loop body — a plain step, or the ENTRY to a
 * branch sitting there (so its `when` is read fresh on every pass).
 */
function startOfLoopBody(script: BotScript, node: number, body: number): Position {
  const loop = script.program[node] as LoopBlock;
  return loop.body[body]?.kind === "branch"
    ? { kind: "loop-branch-enter", node, body }
    : { kind: "loop", node, body };
}

interface Advance {
  readonly position: Position;
  readonly loopPass: number;
  /** True when this move was a loop re-entering its own body (the backward edge). */
  readonly wrapped: boolean;
}

/**
 * Leave one loop-body ELEMENT (a step, or a whole branch) and take the next —
 * wrapping the pass against the repeat when the body is finished. The single
 * place the loop's backward edge is produced, for both element kinds.
 */
function advanceLoopBody(script: BotScript, node: number, body: number, loopPass: number): Advance {
  const loop = script.program[node] as LoopBlock;
  if (body + 1 < loop.body.length) {
    return { position: startOfLoopBody(script, node, body + 1), loopPass, wrapped: false };
  }
  // Body finished — one pass done.
  const donePasses = loopPass + 1;
  const another = loop.repeat.kind === "forever" || donePasses < loop.repeat.count;
  if (another) {
    return { position: startOfLoopBody(script, node, 0), loopPass: donePasses, wrapped: true };
  }
  return { position: startOfNode(script, node + 1), loopPass: 0, wrapped: false };
}

/** Move forward one step, wrapping a loop body against its repeat. */
function advance(script: BotScript, position: Position, loopPass: number): Advance {
  if (position.kind === "step") {
    return { position: startOfNode(script, position.node + 1), loopPass: 0, wrapped: false };
  }
  if (position.kind === "loop") {
    return advanceLoopBody(script, position.node, position.body, loopPass);
  }
  if (position.kind === "loop-branch") {
    const loop = script.program[position.node] as LoopBlock;
    const branch = loop.body[position.body] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    if (position.inner + 1 < side.length) {
      return {
        position: { kind: "loop-branch", node: position.node, body: position.body, side: position.side, inner: position.inner + 1 },
        loopPass,
        wrapped: false,
      };
    }
    // The chosen side is finished — leave the branch, i.e. leave this loop-body
    // element (which may wrap the pass). Never a backward edge of its own.
    return advanceLoopBody(script, position.node, position.body, loopPass);
  }
  if (position.kind === "branch") {
    const branch = script.program[position.node] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    if (position.body + 1 < side.length) {
      return { position: { kind: "branch", node: position.node, side: position.side, body: position.body + 1 }, loopPass, wrapped: false };
    }
    // The chosen side is finished — leave the branch (never a backward edge).
    return { position: startOfNode(script, position.node + 1), loopPass: 0, wrapped: false };
  }
  return { position: { kind: "done" }, loopPass: 0, wrapped: false };
}

function activeStep(script: BotScript, position: Position): MacroStep {
  if (position.kind === "loop") {
    const loop = script.program[position.node] as LoopBlock;
    return loop.body[position.body] as MacroStep;
  }
  if (position.kind === "loop-branch") {
    const loop = script.program[position.node] as LoopBlock;
    const branch = loop.body[position.body] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    return side[position.inner] as MacroStep;
  }
  if (position.kind === "branch") {
    const branch = script.program[position.node] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    return side[position.body] as MacroStep;
  }
  // position.kind === "step"
  return script.program[(position as { node: number }).node] as MacroStep;
}

/**
 * Where a system-mismatch rewind sends the program: the first element of the
 * loop body `position` sits inside, or null when `position` has no enclosing
 * loop at all — a top-level step or a top-level branch, neither of which has a
 * body to restart (`continueRecovering`'s step 3, the only caller, keeps
 * `position` exactly as it was in that case). "Loop", "loop-branch" and
 * "loop-branch-enter" all carry the loop's own node index no matter how far
 * into the body they have gotten, so restarting is always the same move:
 * re-enter that node at body slot 0, exactly as a fresh pass would.
 */
function enclosingLoopRestart(script: BotScript, position: Position): Position | null {
  if (position.kind === "loop" || position.kind === "loop-branch" || position.kind === "loop-branch-enter") {
    return startOfLoopBody(script, position.node, 0);
  }
  return null;
}

/**
 * The step id whose per-step macro memory a rewind must forget — the step
 * `position` had actually reached and run a macro against, or null when it had
 * not reached one yet. A "loop-branch-enter" never ran a macro (its `when` is
 * read fresh on the very next tick, which the rewind already forces), so it
 * has nothing bound to a stale grid to clear.
 */
function committedStepID(script: BotScript, position: Position): string | null {
  return position.kind === "loop" || position.kind === "loop-branch" ? activeStep(script, position).id : null;
}

export function currentStepID(script: BotScript, memory: ScriptMemory): string | null {
  return ["step", "branch", "loop", "loop-branch"].includes(memory.position.kind) ? activeStep(script, memory.position).id : null;
}

function positionKey(position: Position): string {
  if (position.kind === "loop") {
    return `loop:${position.node}:${position.body}`;
  }
  if (position.kind === "branch") {
    return `branch:${position.node}:${position.side}:${position.body}`;
  }
  if (position.kind === "branch-enter") {
    return `branch-enter:${position.node}`;
  }
  if (position.kind === "loop-branch") {
    return `loop-branch:${position.node}:${position.body}:${position.side}:${position.inner}`;
  }
  if (position.kind === "loop-branch-enter") {
    return `loop-branch-enter:${position.node}:${position.body}`;
  }
  if (position.kind === "step") {
    return `step:${position.node}`;
  }
  return "done";
}

function omit(
  map: Readonly<Record<string, MacroMemory>>,
  key: string,
): Readonly<Record<string, MacroMemory>> {
  if (!(key in map)) {
    return map;
  }
  const next: Record<string, MacroMemory> = {};
  for (const k of Object.keys(map)) {
    if (k !== key) {
      const value = map[k];
      if (value !== undefined) {
        next[k] = value;
      }
    }
  }
  return next;
}

function totalSteps(script: BotScript): number {
  return countSteps(script.program);
}

// ─── Result builders ─────────────────────────────────────────────────────────

function done(mem: ScriptMemory): ScriptTickResult {
  return {
    action: WAIT,
    why: SAY.programDone,
    phase: "Finished",
    stepPath: null,
    interruptID: null,
    status: "done",
    pauseReason: null,
    memory: { ...mem, position: { kind: "done" }, latched: null },
  };
}

/**
 * STOP — BUT NEVER IN SPACE. Every stop the player did not personally press goes
 * through here: it latches the reason and flies the ship home, and the pause
 * itself happens on arrival (`continueHeadingHome`), carrying that same reason
 * to the readout so the player still learns why.
 *
 * The reason this exists is a bot found paused in a belt with rats on top of it.
 * A stop in space is not a safe state — it is an unattended ship with its guns
 * off, and the longer nobody looks, the worse it gets. Docked is the only place
 * a bot may come to rest.
 *
 * It costs nothing when the ship is already safe: `scriptTravelHome` reports
 * "docked anywhere is done" on its first consultation, so the flight collapses
 * to the plain pause it would have been, on the same tick.
 *
 * ⚠ THE TWO PAUSES INSIDE `continueHeadingHome` MUST STAY BARE — arriving home,
 * and a home that cannot be flown to (no home station known). Routing those
 * through here would re-latch the ship into a flight it has just finished or
 * cannot make, and it would never stop at all.
 */
function stopSafely(
  reason: string,
  mem: ScriptMemory,
  litID: string | null,
  obs: ScriptObservation,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  return continueHeadingHome(obs, { ...mem, latched: { interruptID: litID, reason } }, travelHome);
}

function paused(reason: string, mem: ScriptMemory, litID: string | null): ScriptTickResult {
  return {
    action: WAIT,
    why: reason,
    phase: "Stopped",
    stepPath: litID,
    interruptID: litID,
    status: "paused",
    pauseReason: reason,
    memory: { ...mem, latched: null },
  };
}
