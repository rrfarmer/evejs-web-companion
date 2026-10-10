import { confirmedDrain, freightReadable, OPERATION_DRAIN_CLEAR_BOARD_KEY } from "./miningLogistics.ts";
import { decideFleetMinerGeometry } from "./fleetMiner.ts";
import { evaluateSupportEnvelope, resolveSupportAnchor } from "./miningSupportAnchor.ts";
import { decideMiningSupportFleetMember, freshMiningSupportFleetMemory, type MiningSupportFleetMemory } from "./miningSupportFleet.ts";
import { atMiningSite, miningSiteFamily, siteIdentity, siteRockMatches, type SiteFamily } from "./miningSite.ts";
// B1 — the macro adapters. Each block is an independent "task": it decides ONE
// action per tick and confirms by re-reading next tick, composing the SAME
// proven calls the mining/mission bots fire (undock, warp, orbit, lock,
// activate, unload, launch/engage drones). No new ship control — the block model
// over the existing engine, driven by the player's blocks.
//
// Stoppers (ore hold full, low health, a pirate) are NOT the block's job: the
// player's `until` and the "always watching" interrupts handle them in the
// orchestrator. A block just does its task and reports done / blocked.

import type {
  CompleteMacroRegistry,
  HomeTravelDecider,
  MacroDecider,
  MacroMemory,
  MacroTick,
  ScriptBoard,
} from "./scriptDecide.ts";
import type { DryBelt, ScriptObservation } from "./scriptConditions.ts";
import { createCorporateHauler } from "./corporateHauling.ts";
import type { RatThreat } from "./ratThreat.ts";
import { hostilesInReach, pickAdvertisedFleet } from "./scriptConditions.ts";
import { BOARD_SLOT_KEY } from "../bots/botScript.ts";
import { refitLanded } from "../bots/startup.ts";
import { planFittingApply } from "../bridge/fitting.ts";
import type { MacroStep, OreFamilyArg, SquadRoleArg, WorldRef } from "../bots/botScript.ts";
import { dockedAt, type DockableKind } from "./dockableLocation.ts";
import { launchFullPercent } from "../bots/macroSpecs.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import { beltTravelStep, freightHoldItemIDs, holdsFreeM3, isMineableRock } from "./miningBotLoop.ts";
import { nearestUnworkedBelt, type BeltOption } from "./beltRotation.ts";
import {
  agentActionID,
  cargoRoom,
  completeActionID,
  completed,
  findPackageStack,
  gateOffer,
  missionAccepted,
  packageAboard,
} from "./missionBotLoop.ts";
import { decideCloseIn, measureSpace, type SpaceMeasurement } from "./autopilotLoop.ts";
import {
  clearCloseInStall,
  closeInStall,
  hullMode,
  STALL_REORDER_WHY,
  STALL_STUCK_REASON,
  STALL_STUCK_WHY,
  STALL_UNSTICK_WHY,
} from "./closeInStall.ts";
import { DEFAULT_TARGET_PRIORITY, fleetTagRank, pickPrimary, type TargetClass } from "./targetPriority.ts";
import { canMyShipOrderDrone, distanceMeters, hostileRows, type OverviewRow } from "../space/overview.ts";
import { compressionFacilities } from "../space/compression.ts";
import { AGENT_BUTTON } from "../bridge/agents.ts";
import { FREIGHT_BAYS, planLootTransfers, preferredBays } from "../bridge/bayRouting.ts";
import { preferredResources } from "./resourcePriority.ts";
import { holdFreeM3 } from "../bridge/holdFit.ts";
import { isUnreachable, NO_STEP_ID, refusalFor, refusalTargets, shipHasNoRoom, shouldSetAside } from "./refusalLedger.ts";
import { movableRows, pickedRows, type KeepRule } from "../bridge/keepAboard.ts";
import { FALLBACK_CONTROL_RANGE_M } from "./kiteBand.ts";
import {
  LAUNCH_MAX_TRIES,
  RECALL_MAX_WAIT_TICKS,
  droneRoster,
  launchRoleDrones,
  launchStalled,
  type DroneRoster,
} from "./droneLaunch.ts";
import { decideDroneBoat, type LockRefusals } from "./droneBoatLadder.ts";
import { settleCombat } from "./combatOwnership.ts";
import { defenderSiteIdentity } from "./operationDefender.ts";
import { decideDroneRotation, readRotationMemory } from "./droneRotation.ts";
import {
  decodeLedger,
  describeVerdict,
  encodeLedger,
  enterSite,
  forgetSite,
  isAbandoned,
  observeTick,
  type SiteLedger,
  type SiteVerdict,
} from "./siteProgress.ts";

const WAIT = { kind: "wait" } as const;
const ACTING = { kind: "acting" } as const;

const ORBIT_RANGE_M = 5000; // the operator's "orbit of 5km" — inside mining range
// The "close enough to activate" check, kept DELIBERATELY BELOW even a basic
// mining laser or strip miner's ~10-15km optimal range (same margin style as
// SALVAGE_RANGE_M and ORBIT_BOOST_RANGE_M/REMOTE_ASSIST_RANGE_M below) — the
// orbit command targets 5km, but an orbit holds APPROXIMATELY that radius, not
// exactly it, so gating "in range" on the same 5km the orbit aims for meant a
// ship settling at 6-7km could circle forever without ever reading as close
// enough to try. Checking against this wider, still-safe floor instead lets
// the orbit's normal wobble stay inside the range that matters.
const MINING_RANGE_M = 10_000;
const DOCK_RANGE_M = 2500; // dock once this close (retail's docking radius)
/**
 * Has the warp this step issued actually LANDED?
 *
 * ⚠ A MACRO CANNOT WATCH FOR `inWarp` AND MUST NOT TRY. `decideScriptAction`
 * holds every watch and every macro while the ship is warping — its guard
 * returns before the program is reached — so a macro is never called on a tick
 * where `inWarp` is true. The three blocks that warp somewhere and then have to
 * know they got there all used to watch for exactly that state, and from the day
 * that guard landed (2026-09-11) none of them ever saw it again: each issued its
 * warp, sat out the flight unasked, resumed on the far side having witnessed
 * nothing, counted out its patience and reported that the warp had never started
 * — while the ship sat on the destination grid taking fire, because the step
 * never finished and the block after it never ran.
 *
 * So arrival is read from `obs.completedWarps`, a count the OBSERVATION keeps
 * because the observation is the only layer read on every tick. The step records
 * it when it issues; a higher count afterwards is a warp that finished.
 *
 * `sawWarp` is still honoured first, and is not dead code: it is what a macro
 * sees if it is ever driven WITHOUT that guard (every pure test does exactly
 * that), and it costs one flag to keep both paths true.
 *
 * ⚠ AN UNREADABLE COUNT IS NOT AN ARRIVAL. Null on either side answers false and
 * the caller falls back to its own wait budget, which is the honest failure:
 * waiting too long for a warp that did land costs a few seconds, while declaring
 * an arrival that did not happen finishes a travel step onto the wrong grid.
 */
function warpLanded(obs: ScriptObservation, mem: MacroMemory): boolean {
  if (flag(mem, "sawWarp")) {
    return true;
  }
  const now = obs.completedWarps ?? null;
  const atIssue = num(mem, "warpsAtIssue");
  return now !== null && atIssue !== null && now > atIssue;
}

/** The memory a step writes when it ISSUES a warp, so `warpLanded` can answer later. */
function warpIssuedMem(obs: ScriptObservation, target: string | null = null): MacroMemory {
  // `target` is the scan label the warp went out against, remembered because a
  // refusal arrives with no clue which destination it is about, and telling
  // "already standing in it" from "told no" needs that site's position.
  return { issued: true, waited: 0, warpsAtIssue: obs.completedWarps ?? null, target };
}

const MAX_LOCK_WAIT_TICKS = 8; // ~16s acquiring one rock before moving on
// A lock refused for range is pressed again only once the rock is this fraction of the
// refused distance: each re-press must come with real progress, or the runner's ten-refusal
// cap is spent standing still (150 km to a 40 km lock range is about six presses).
const LOCK_REPRESS_PROGRESS = 0.8;

function tick(
  action: MacroTick["action"],
  why: string,
  phase: string,
  outcome: MacroTick["outcome"],
  armed = true,
  nextMem: MacroMemory = {},
): MacroTick {
  return { action, why, phase, armed, outcome, nextMem };
}

function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" ? value : null;
}
function flag(mem: MacroMemory, key: string): boolean {
  return mem[key] === true;
}
/** A remembered comma-joined list of labels; empty when there is none. */
function listOf(mem: MacroMemory, key: string): string[] {
  const value = mem[key];
  return typeof value === "string" ? value.split(",").filter((item) => item.length > 0) : [];
}
/** A remembered label, or null — an empty string is "nothing", never a name. */
function label(mem: MacroMemory, key: string): string | null {
  const value = mem[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The target ladder this step fights by: the player's ordering when they set
 * one, otherwise the shipped one. An EMPTY list is the default too — a player
 * who cleared the picker asked for the default back, not for a step with no
 * ordering at all.
 */
function targetPriorityOf(step: MacroStep): readonly TargetClass[] {
  const arg = step.args["targets"];
  return arg !== undefined && arg.kind === "targetList" && arg.classes.length > 0
    ? arg.classes
    : DEFAULT_TARGET_PRIORITY;
}

/**
 * How a hull's group name is looked up this tick. An observation with no
 * resolved groups answers null for everything, which ranks every hull with
 * "everything else" — nearest-first, exactly the behaviour that shipped before
 * the ladder existed.
 */
function targetGroupOf(obs: ScriptObservation): (typeID: number) => string | null {
  const groups = obs.targetGroupNames ?? null;
  return (typeID: number): string | null => (groups === null ? null : (groups[typeID] ?? null));
}

/**
 * What a rat's OWN dogma says it does — the NPC half of the classifier whose
 * player half is `targetGroupOf` above. `nav/ratThreat.ts` reads the attributes;
 * this only hands the decoded answer to the pick.
 *
 * ⚠ WITHOUT THIS THE PLAYER'S TARGET LADDER IS INERT AGAINST RATS, and that is
 * not a theory about the code — it is what every ratting bot in this tree has
 * been doing. Every NPC in the static data is an "Asteroid Serpentis Frigate" or
 * a "Deadspace Angel Cartel Cruiser", and not one of those names is a group
 * `targetClassForGroup` knows, so the whole grid classified as "other", every
 * row tied, and the pick fell through to nearest-first no matter which classes
 * the player dragged to the top of the picker. The picker was decoration.
 *
 * A type MISSING from the map answers null, which is "the dogma said nothing,
 * ask the group name" and never "this rat is harmless" — the distinction
 * `targetClassForThreat` exists to preserve. A null map says that about every
 * type at once, which collapses the ordering back to exactly the group-only
 * behaviour that shipped before.
 */
function targetThreatOf(obs: ScriptObservation): (typeID: number) => RatThreat | null {
  const threats = obs.threatByTypeID ?? null;
  return (typeID: number): RatThreat | null => (threats === null ? null : (threats[typeID] ?? null));
}

/**
 * The ids the server says are scrambling, webbing or jamming THIS ship right
 * now, or `undefined` when no jam fold was read at all.
 *
 * ⚠ THIS IS THE READ A HULL WAS LOST FOR. Live run, 2026-09-14: the armour
 * watch fired at its threshold and did everything right — drones home, aligned
 * out, course set — and the warp came back REFUSED, because the ship was
 * scrammed. `fightTheWayOut` then borrowed this block to shoot its way free,
 * which is the correct answer in principle, and the block shot the NEAREST rat,
 * because the nearest rat was all the pick could see. The frigate with the point
 * on it was never touched, and the ship spent its last forty seconds killing
 * something whose death freed nothing. The server had been naming that frigate
 * on the victim's own wire the entire time (its `OnJamStart` push, folded here)
 * and this block never asked.
 *
 * ⚠ THE UNDEFINED MATTERS, AND AN EMPTY ARRAY IS A DIFFERENT ANSWER.
 * `pickPrimary` skips the promotion entirely when the set is absent; handing it
 * an empty Set instead would be the claim "we looked and nothing is on us",
 * which is stronger than "nobody looked". An empty ARRAY on the observation is
 * the first of those — the jam slice is a fold of pushes that always exists —
 * and it is passed straight through as an empty Set.
 */
function jammingSourcesOf(obs: ScriptObservation): ReadonlySet<number> | undefined {
  const ids = obs.jammingSourceIDs;
  return ids === undefined ? undefined : new Set(ids);
}

// ── Flying with the fleet (the shared squad board) ───────────────────────────
//
// Three small helpers, shared by every combat block so calling and following
// behave identically wherever a fight happens.
//
// ⚠ A CALL COSTS A TICK, SO IT IS SENT ONLY WHEN THE PRIMARY CHANGES. One
// action per tick is the whole engine: a block that re-called every tick would
// never fire a gun. `calledTargetID` in the step's memory is what makes it once
// per target, and it is dropped with the rest of that memory whenever the
// primary is re-picked — a re-call then just refreshes the standing one, which
// is exactly what a still-shooting caller wants.

/** What this step does about the fleet's call: call one, follow one, or neither. */
function squadRoleOf(step: MacroStep): SquadRoleArg {
  const arg = step.args["squad"];
  return arg !== undefined && arg.kind === "squadRole" ? arg.role : "off";
}

/**
 * The called ship, IF it is one of the rows this block could shoot right now.
 *
 * Three sources, in precedence order — tag, then broadcast, then board:
 *   1. `obs.fleetTargetTags` — the fleet's in-game target tags.
 *   2. `obs.fleetBroadcast` — a `Target` fleet broadcast.
 *   3. `obs.squadPrimaryTargetID` — the shared squad board.
 *
 * ⚠ A SOURCE WHOSE SHIP IS NOT AMONG `rows` FALLS THROUGH TO THE NEXT SOURCE,
 * NOT TO NULL. The rows are already filtered to this grid and to targeting
 * reach, so "the FC tagged something two systems away" must not blind the
 * pilot to a broadcast or a board call it CAN act on — only when none of the
 * three names a ship this pilot can act on does this answer null and the
 * block picks for itself. That is what keeps a follower flying while the FC
 * is two systems away.
 *
 * ⚠ TAG OUTRANKS BROADCAST, WHICH LOOKS BACKWARDS — a broadcast is the
 * fresher, more deliberate act, so someone will want to swap this order.
 * Don't: the reason is AUTHORITY, and it lives in the server, not in
 * freshness. `setFleetTargetTag` refuses any writer who is not a fleet
 * commander, so a tag that exists is PROVABLY a commander's. `sendBroadcast`
 * checks fleet membership and nothing else, so any fleet member may
 * broadcast `Target` — receiving one tells you nothing about who sent it. A
 * tag is the one signal here guaranteed to come from command; a broadcast is
 * not, so it ranks below.
 */
function calledOnGrid<T>(
  obs: ScriptObservation,
  rows: readonly T[],
  itemIDOf: (row: T) => number,
): T | null {
  const byTag = calledByTag(obs, rows, itemIDOf);
  if (byTag !== null) {
    return byTag;
  }
  const byBroadcast = calledByBroadcast(obs, rows, itemIDOf);
  if (byBroadcast !== null) {
    return byBroadcast;
  }
  const called = obs.squadPrimaryTargetID ?? null;
  if (called === null) {
    return null;
  }
  return rows.find((row) => itemIDOf(row) === called) ?? null;
}

/**
 * Source 1: the fleet's in-game target tags, ranked by `fleetTagRank` (lower
 * ranks first; an unrecognised tag string still gets a finite rank there, so
 * it is still obeyed here). Only rows the tag map actually names are
 * candidates — an untagged row is not "ranked worst", it is simply not this
 * source's business.
 *
 * ⚠ TAGS ARE RESOLVED HERE, ONE RUNG ABOVE `pickPrimary`, AND NEVER PASSED
 * INTO IT. `pickPrimary` already accepts an optional `tagOf` for this exact
 * ranking, but every call site in this file still passes none — wiring tags
 * through there too would be a second mechanism deciding the one thing this
 * function already decided. Keep the tag read confined to this rung.
 */
function calledByTag<T>(obs: ScriptObservation, rows: readonly T[], itemIDOf: (row: T) => number): T | null {
  const tags = obs.fleetTargetTags ?? null;
  if (tags === null || tags.size === 0) {
    return null;
  }
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const tag = tags.get(itemIDOf(row));
    if (tag === undefined) {
      continue; // not named in the tag map — not this source's candidate
    }
    const rank = fleetTagRank(tag);
    if (rank < bestRank) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Source 2: a `Target` fleet broadcast. `obs.fleetBroadcast` is already
 * freshness-filtered upstream against the broadcast TTL (null once a call has
 * lapsed) — no TTL check here. Only the name "Target" is a primary call;
 * every other broadcast name (AlignTo, WarpTo, ...) means something else
 * entirely and must never be read as one.
 */
function calledByBroadcast<T>(obs: ScriptObservation, rows: readonly T[], itemIDOf: (row: T) => number): T | null {
  const broadcast = obs.fleetBroadcast ?? null;
  if (broadcast === null || broadcast.name !== "Target" || broadcast.itemID === null) {
    return null;
  }
  return rows.find((row) => itemIDOf(row) === broadcast.itemID) ?? null;
}

/** Tell the fleet what this pilot is on — once per primary. Null when there is nothing to say. */
function callPrimary(
  role: SquadRoleArg,
  mem: MacroMemory,
  targetID: number,
  why: string,
  phase: string,
): MacroTick | null {
  if (role !== "call" || num(mem, "calledTargetID") === targetID) {
    return null;
  }
  return tick({ kind: "callPrimary", targetID }, why, phase, ACTING, true, { ...mem, calledTargetID: targetID });
}

/** Drop the standing call when there is nothing left to shoot. Null when none stands. */
function standCallDown(role: SquadRoleArg, mem: MacroMemory, why: string, phase: string): MacroTick | null {
  if (role !== "call" || num(mem, "calledTargetID") === null) {
    return null;
  }
  return tick({ kind: "callPrimary", targetID: null }, why, phase, ACTING, true, { ...mem, calledTargetID: null });
}

/** Nearest entity in a set, by measured surface distance (unknown sorts last). */
function nearest(entities: readonly SpaceEntity[], measurement: SpaceMeasurement | null): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    const dist = measurement?.distances.get(entity.itemID) ?? Number.POSITIVE_INFINITY;
    if (dist < bestDist) {
      best = entity;
      bestDist = dist;
    }
  }
  return best;
}

/** The drones out in space that THIS ship can order home (controlled by this hull). */
function myDroneIDs(snapshot: SpaceSnapshot | null): readonly number[] {
  if (snapshot === null) {
    return [];
  }
  const shipID = snapshot.ship?.itemID ?? null;
  return snapshot.entities.filter((e) => canMyShipOrderDrone(e, shipID) === true).map((e) => e.itemID);
}

// ── Drones by ROLE ───────────────────────────────────────────────────────────
// The roster and the launch both live in `nav/droneLaunch.ts` now, a leaf this
// file and `nav/droneBoatLadder.ts` both import. They used to be a copy each,
// because this file imports `decideDroneBoat` FROM that one and the dependency
// cannot run the other way round; see that module's header for what the drift
// would have cost. The role-BLIND half stays here: `myDroneIDs` above is every
// drone this hull can order, which is what a recall takes, and what
// `recallBeforeLeaving` below is written against.

/**
 * Before a block warps AWAY from the grid, don't abandon the drones. The standard
 * move: call them home ONCE, align toward the exit so the ship is ready to warp,
 * and hold there until 0 drones are left in space — then return null so the caller
 * warps out already aligned. Bounded by `recallWaited`: if they never make it home
 * we leave anyway rather than sit forever. `target` is where we're headed (what to
 * align to); null skips the align and just waits.
 */
function recallBeforeLeaving(
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  target: number | null,
): MacroTick | null {
  // 0 drones still in space → nothing to wait for; the caller may warp out.
  if (obs.dronesOut !== true) {
    return null;
  }
  const ids = myDroneIDs(obs.snapshot ?? null);
  if (ids.length === 0) {
    return null;
  }
  const waited = num(mem, "recallWaited") ?? 0;
  if (waited > RECALL_MAX_WAIT_TICKS) {
    return null; // waited long enough; leaving now beats never leaving
  }
  if (!flag(mem, "recalled")) {
    return tick(
      { kind: "recallDrones", droneIDs: ids },
      "Calling the drones home before we leave.",
      phase,
      ACTING,
      false,
      { ...mem, recalled: true, recallWaited: 0 },
    );
  }
  if (target !== null && !flag(mem, "aligned")) {
    return tick(
      { kind: "align", targetID: target },
      "Aligning out while the drones come home.",
      phase,
      ACTING,
      false,
      { ...mem, aligned: true, recallWaited: waited + 1 },
    );
  }
  return tick(
    WAIT,
    "Holding aligned until every drone is back in.",
    phase,
    ACTING,
    false,
    { ...mem, recallWaited: waited + 1 },
  );
}

/**
 * The station id a station-arg points at. Three ways to say it: a chosen id, the
 * STARTING station, or a NAMED BOARD SLOT filled in by an earlier block ("the
 * agent's station", "the mission's drop-off"). The slot reads the run board, so
 * a bot follows whatever agent/mission it actually picked up; an unfilled slot
 * reads null, which the callers treat as "not set yet" rather than guessing.
 */
export function resolveStationRef(
  ref: WorldRef,
  startingStationID: number | null,
  board: ScriptBoard = {},
): number | null {
  if (ref.slot !== undefined) {
    return boardNum(board, BOARD_SLOT_KEY[ref.slot]);
  }
  if (ref.starting === true) {
    return startingStationID;
  }
  return ref.id;
}

function stationTarget(step: MacroStep, obs: ScriptObservation, board: ScriptBoard = {}): number | null {
  const arg = step.args["station"];
  if (arg === undefined || arg.kind !== "station") {
    return null;
  }
  return resolveStationRef(arg.ref, obs.startingStationID ?? null, board);
}

function rockLabel(rock: SpaceEntity, oneNoun = "a rock"): string {
  return rock.name ?? oneNoun;
}

/** True when a step pins a specific belt rather than "nearest". */
function isChosenBelt(step: MacroStep): boolean {
  const arg = step.args["belt"];
  return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen";
}

/**
 * True when a step is the ANOMALY MINER'S mode — tour the scanner's ore sites,
 * never a belt. See the `BeltArg` header (botScript.ts) for the incident this
 * mode exists to close: NEAREST-mode's belt rotation is the right fallback for
 * a belt-mining bot and the wrong one for an anomaly-mining bot, because it
 * hands the ship a destination ("the nearest belt") that a wanted anomaly ore
 * can never spawn at. `mineAtBelt` checks this FIRST, before either the belt
 * regex or the tier ladder, so a "site" step never reaches code written for
 * the other two modes.
 */
function isSiteMode(step: MacroStep): boolean {
  const arg = step.args["belt"];
  return arg !== undefined && arg.kind === "belt" && ["site", "ice-site"].includes(arg.belt.mode);
}

function operationSiteFamily(step: MacroStep): SiteFamily {
  const arg = step.args["belt"];
  return arg?.kind === "belt" && arg.belt.mode === "ice-site" ? "ICE" : "ORE_ANOMALY";
}

/**
 * The belt a mine-at-belt step should head for when no rocks are in range.
 * "chosen" pins one belt by NAME (never id — unlike a station, a belt's id is
 * grid-local, not globally stable, so it can only be re-resolved against what
 * is actually on THIS grid, the same way "nearest" already is). No match on
 * this grid comes back null so the caller can block rather than silently
 * drifting to the wrong belt.
 */
function beltTarget(
  step: MacroStep,
  belts: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  const arg = step.args["belt"];
  if (arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen") {
    const ref = arg.belt.ref;
    return ref.name !== null ? (belts.find((b) => b.name === ref.name) ?? null) : null;
  }
  return nearest(belts, measurement);
}

/**
 * Which rock to work next.
 *
 *   • "nearest" (the default, and the shipped behaviour) — least flying.
 *   • "biggest" — the most ore left, so fewer rock changes per hold.
 *   • "valuable" — the richest ore per cubic metre, because the hold that ends
 *     the block is a VOLUME: between two rocks in reach, the one worth more per
 *     m³ is worth more per trip.
 *
 * ⚠ THE READING IS NULL FOR UNKNOWN, NEVER ZERO — `remainingQuantity` because a
 * zero reads as a mined-out rock, `oreValuePerM3` because a zero reads as
 * worthless ore. So a rock nobody could measure or price is not treated as the
 * worst one: it sorts after every known rock, and when NOTHING is known the pick
 * falls back to nearest rather than choosing arbitrarily.
 *
 * ⚠ TIES BREAK BY DISTANCE, and that is what makes "valuable" usable at all: a
 * belt's rocks of one ore all carry the SAME value per m³, so without this the
 * pick would be "whichever rock the snapshot happened to list first" — a bot
 * flying past three Veldspar rocks to reach a fourth.
 */
function pickRock(
  step: MacroStep,
  rocks: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  const arg = step.args["pick"];
  const pick = arg !== undefined && arg.kind === "rockPick" ? arg.pick : "nearest";
  if (pick === "nearest") {
    return nearest(rocks, measurement);
  }
  const reading =
    pick === "biggest"
      ? (rock: SpaceEntity) => rock.remainingQuantity
      : (rock: SpaceEntity) => rock.oreValuePerM3;
  let bestReading: number | null = null;
  for (const rock of rocks) {
    const value = reading(rock);
    if (value !== null && (bestReading === null || value > bestReading)) {
      bestReading = value;
    }
  }
  if (bestReading === null) {
    return nearest(rocks, measurement);
  }
  return nearest(
    rocks.filter((rock) => reading(rock) === bestReading),
    measurement,
  );
}

/**
 * Restrict to the richest grade present — an ore-priority tier reaches for the
 * highest `oreGrade` before anything else, and `pickRock`'s nearest/biggest
 * choice only breaks the tie among those. An unknown grade sorts AFTER every
 * known one (same null-is-not-worst rule as `remainingQuantity`): if nothing
 * in the set has a known grade, every rock stays a candidate.
 */
function highestGradeRocks(rocks: readonly SpaceEntity[]): readonly SpaceEntity[] {
  let bestGrade = -1;
  for (const rock of rocks) {
    if (rock.oreGrade !== null && rock.oreGrade > bestGrade) {
      bestGrade = rock.oreGrade;
    }
  }
  if (bestGrade < 0) {
    return rocks;
  }
  return rocks.filter((rock) => rock.oreGrade === bestGrade);
}

const OPERATION_EMPTY_CONFIRM_READS = 3;
const OPERATION_DUMP_MAX_ATTEMPTS = 5;

function miningOperationTargetKey(
  targetType: "BELT" | "ORE_ANOMALY" | "ICE",
  systemID: number,
  targetName: string,
): string {
  return `${targetType}:${systemID}:${targetName}`;
}

/** One current-system scanner observation, one owned assignment, no independent
 * selector. Used on every mining re-entry as well as on hauler travel. */
function operationSiteTravel(obs: ScriptObservation, inputMem: MacroMemory, family: SiteFamily): MacroTick {
  const operation = obs.miningOperation;
  const held = (result: MacroTick): MacroTick => ({ ...result, settleDrones: true });
  if (!operation || !operation.area.targetClasses.includes(family)) {
    return held(tick(WAIT, "A matching operation assignment is required.", "Unsupported target", { kind: "blocked", reason: "Site travel requires matching operation target authority." }));
  }
  const target = operation.role === "HAULER" ? operation.logisticsTarget ?? operation.currentTarget : operation.currentTarget;
  const mem = target?.targetKey === inputMem.siteTargetKey ? inputMem : { siteTargetKey: target?.targetKey };
  const ride = rideAutopilotToSystem(obs, target?.systemID ?? operation.area.anchorSystemID, "Following operation target");
  if (ride) return held(ride);
  if (obs.inSpace !== true || obs.inWarp === true || !obs.snapshot?.ship) return held(tick(WAIT, "Waiting for a stable space observation.", "Following operation target", ACTING, false, mem));
  if (target === null) {
    if (operation.role !== "MINER") return held(tick(WAIT, "Waiting for the mining body to reserve a target.", "Waiting for target", ACTING, false, mem));
    const sites = (obs.anomalies ?? []).filter(site => miningSiteFamily(site) === family && siteIdentity(site) && site.position)
      .sort((a, b) => a.label.localeCompare(b.label))
      .filter(site => !(obs.unavailableMiningTargetKeys ?? []).includes(miningOperationTargetKey(family, operation.area.anchorSystemID, siteIdentity(site)!)));
    const candidate = sites[0];
    if (!candidate) return held(tick(WAIT, obs.anomalies == null ? "Current-system scanner unavailable." : `No available ${family} target in this system.`, "Waiting for target", ACTING, false, mem));
    return held(tick({ kind: "reserveMiningTarget", targetType: family, systemID: operation.area.anchorSystemID,
      systemName: obs.systemName ?? operation.area.anchorSystemName ?? "", targetName: candidate.label,
      siteIdentity: siteIdentity(candidate)!, siteID: candidate.siteID!, instanceID: candidate.instanceID ?? null, position: candidate.position!,
      candidates: sites.map(site => ({ targetType: family, systemID: operation.area.anchorSystemID,
        systemName: obs.systemName ?? operation.area.anchorSystemName ?? "", targetName: site.label,
        siteIdentity: siteIdentity(site)!, siteID: site.siteID!, instanceID: site.instanceID ?? null, position: site.position! })),
    }, `Reserving ${family} ${candidate.label}.`, "Selecting target", ACTING, false, mem));
  }
  if (target.targetType !== family || target.claimedByOperationID !== operation.operationID) {
    return held(tick(WAIT, "The assigned site is not owned by this operation/family.", "Target authority unavailable", ACTING, false, mem));
  }
  if (!target.position || !target.siteIdentity) return held(tick(WAIT, "Site identity or position is unavailable.", "Target unavailable", ACTING, false, mem));
  const draining = operation.role === "HAULER" && operation.logisticsTarget?.targetKey === target.targetKey;
  const exact = (obs.anomalies ?? []).find(site => miningSiteFamily(site) === family && siteIdentity(site) === target.siteIdentity);
  if (!draining && !exact) {
    const missing = obs.anomalies == null ? 0 : (num(mem, "siteMissingReads") ?? 0) + 1;
    if (operation.role === "MINER" && missing >= OPERATION_EMPTY_CONFIRM_READS) {
      return held(tick({ kind: "depleteMiningTarget", targetKey: target.targetKey, evidence: { scannerDisappeared: true, scannerMissingReads: missing } },
        "Repeated current-system scans confirm the assigned site disappeared.", "Target depleted", ACTING, false, { ...mem, siteMissingReads: missing }));
    }
    return held(tick(WAIT, "Confirming assigned site visibility; no work on a missing site.", "Confirming site disappearance", ACTING, false, { ...mem, siteMissingReads: missing }));
  }
  const nextMem = { ...mem, siteMissingReads: 0 };
  if (atMiningSite(obs.snapshot.ship.position, target)) {
    if (operation.role === "HAULER" && !obs.miningSiteBookmarks?.[target.targetKey]) {
      return held(tick({ kind: "bookmarkMiningSite", targetKey: target.targetKey }, "Saving an authoritative return point before servicing this site.", "Preparing logistics tail", ACTING, false, nextMem));
    }
    return tick(WAIT, "At the exact owned site.", "Arrived", { kind: "done" }, true, nextMem);
  }
  const bookmarkID = obs.miningSiteBookmarks?.[target.targetKey];
  if (draining && !exact && !bookmarkID) return held(tick(WAIT, "The disappeared site has no confirmed logistics return bookmark.", "Logistics return blocked", { kind: "blocked", reason: "SITE_RETURN_POINT_UNAVAILABLE: hauler never reached this site before it disappeared; manual recovery required." }, false, nextMem));
  const waited = num(mem, "siteWarpWait") ?? 0;
  const attempts = num(mem, "siteWarpAttempts") ?? 0;
  if (waited > 0) return held(tick(WAIT, "Waiting for the issued site warp to arrive.", "Following operation target", ACTING, false, { ...nextMem, siteWarpWait: waited - 1 }));
  if (attempts >= 3) return held(tick(WAIT, "Site arrival was not confirmed after three warp attempts.", "Site travel blocked", { kind: "blocked", reason: "SITE_TRAVEL_UNCONFIRMED: no fallback destination was selected." }, false, nextMem));
  const recall = recallBeforeLeaving(obs, nextMem, "Following operation target", null);
  if (recall) return held(recall);
  return held(tick(draining && bookmarkID ? { kind: "warpBookmark", bookmarkID } : { kind: "warpScan", target: exact?.label ?? target.targetName },
    `Travelling to ${target.targetName}.`, "Following operation target", ACTING, false, { ...nextMem, siteWarpAttempts: attempts + 1, siteWarpWait: 10 }));
}

/**
 * Operation-only belt travel. Null means this is an ordinary saved script and
 * the original macro below remains the sole authority. A hauler always prefers
 * its logistics tail over the new fleet target, which is what permits the main
 * body to relocate while the old grid is still being drained.
 */
function operationTravelToBelt(obs: ScriptObservation, mem: MacroMemory): MacroTick | null {
  const operation = obs.miningOperation ?? null;
  if (operation === null || !["HAULER", "COMMAND", "DEFENDER"].includes(operation.role)) return null;
  const target = operation.role === "HAULER" ? operation.logisticsTarget ?? operation.currentTarget : operation.currentTarget;
  if (target === null) {
    return tick(WAIT, "Waiting for the operation to choose its next target.", "Waiting for target", ACTING, false, mem);
  }
  if (target.targetType !== "BELT") {
    return tick(WAIT, "This hauler automation can only rendezvous at asteroid belts.", "Unsupported target", {
      kind: "blocked",
      reason: "Ore-anomaly hauling needs an operation-aware scanner travel block; v0.1 only launches HAULER_SERVICE on belts.",
    });
  }
  // Arrival is not a departure. In particular, a support ship's productive
  // flight must not make this helper request relocation on the next tick.
  // Only a positive same-system exact-belt observation bypasses settlement.
  const current = obs.snapshot;
  if (obs.inSpace === true && obs.inWarp === false && obs.flightStatus?.solarSystemID === target.systemID &&
      current?.solarSystemID === target.systemID && current.ship?.geometryAvailable === true &&
      current.shipID === current.ship.itemID && obs.flightStatus.shipID === current.shipID) {
    const arrivedBelt = current.entities.find(entity => /belt/i.test(entity.name ?? "") && entity.name === target.targetName);
    if (arrivedBelt?.geometryAvailable === true && beltTravelStep(arrivedBelt, measureSpace(current)) === "arrive")
      return tick(WAIT, operation.logisticsTarget === null ? "Caught up with the fleet." : "At the draining target.", "Arrived", { kind: "done" });
  }
  const recall = recallBeforeLeaving(obs, mem, "Following the mining operation", null);
  if (recall !== null) return recall;
  const ride = rideAutopilotToSystem(obs, target.systemID, "Following the mining operation");
  if (ride !== null) return ride;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Flying to the belt", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, mem);
  }
  const measurement = measureSpace(snapshot);
  const belt = snapshot.entities.find((entity) => /belt/i.test(entity.name ?? "") && entity.name === target.targetName) ?? null;
  if (belt === null) {
    return tick(WAIT, `The operation target ${target.targetName} is not visible in this system.`, "Target unavailable", {
      kind: "blocked",
      reason: "The operation's exact belt cannot be resolved from the current system data.",
    });
  }
  if (beltTravelStep(belt, measurement) === "arrive") {
    return tick(WAIT, operation.logisticsTarget === null ? "Caught up with the fleet." : "At the draining target.", "Arrived", { kind: "done" });
  }
  const move = beltTravelStep(belt, measurement);
  return tick(move === "approach" ? { kind: "approach", targetID: belt.itemID } : { kind: "warp", targetID: belt.itemID },
    `Travelling to ${target.targetName}.`, "Following the mining operation", ACTING, false, mem);
}

// ── undock ───────────────────────────────────────────────────────────────────
const undock: MacroDecider = (_step, obs) => {
  const docked = obs.flightStatus?.docked ?? null;
  if (docked === false) {
    return tick(WAIT, "Already out in space.", "Leaving the station", { kind: "done" });
  }
  if (docked === true) {
    return tick({ kind: "undock" }, "Leaving the station.", "Leaving the station", ACTING, false);
  }
  return tick(WAIT, "Waiting for the ship to say where it is.", "Leaving the station", ACTING, false);
};

// ── travel-to-belt ───────────────────────────────────────────────────────────
// Warp to a belt — a pinned one, or the nearest — and stop once on grid with
// it. No rocks, no locking: just the trip, for a hauler heading out to pick up
// a jetcan without ever sitting down to mine. Reuses mine-at-belt's own
// beltTarget/isChosenBelt (below) so "pin a belt" behaves identically in both.
const travelToBelt: MacroDecider = (step, obs, mem, board) => {
  // With no operation behind it, "the scanner's ore/ice sites" is the same
  // scanner tour Warp-to-the-next-ore-site runs, kept apart by family.
  if (isSiteMode(step) && obs.miningOperation == null) {
    return (siteTour(step).flavour === ICE_FLAVOUR ? warpToIceAnomaly : warpToOreAnomalyBase)(step, obs, mem, board);
  }
  if (isSiteMode(step)) return operationSiteTravel(obs, mem, operationSiteFamily(step));
  const operationTick = operationTravelToBelt(obs, mem);
  if (operationTick !== null) return operationTick;
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Flying to the belt", ACTING, false, {});
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, {});
  }
  const measurement = measureSpace(snapshot);
  const belts = snapshot.entities.filter((e) => /belt/i.test(e.name ?? ""));
  const belt = beltTarget(step, belts, measurement);
  if (belt === null) {
    const reason = isChosenBelt(step)
      ? "The belt this step is pinned to is not on this grid."
      : "There is no asteroid belt here to fly to.";
    return tick(WAIT, "No asteroid belt in view.", "Nothing to fly to", { kind: "blocked", reason });
  }
  const travel = beltTravelStep(belt, measurement);
  if (travel === "arrive") {
    return tick(WAIT, "At the belt.", "Arrived", { kind: "done" });
  }
  if (travel === "approach") {
    return tick({ kind: "approach", targetID: belt.itemID }, `Closing on ${rockLabel(belt)} without a short warp.`, "Flying to the belt", ACTING, false, {});
  }
  return tick({ kind: "warp", targetID: belt.itemID }, `Warping to ${rockLabel(belt)}.`, "Flying to the belt", ACTING, false, {});
};

// ── mine-at-belt ───────────────────────────────────────────────────────────
// Find the nearest rock, orbit it at 5km, lock it, run the miners, and when it
// is gone pick the next — warping to the step's belt (a pinned one, or else
// the nearest) first if no rock is in range. The player's `until` (ore hold
// full) is what ends the block.
//
// Two things layer on top of that core loop:
//   • NEAREST-mode rotation (decision 2, docs/bot-builder-brainstorm.md §op-2):
//     a belt found dry after arrival is not a stop, it is a cue to rotate to
//     the nearest belt not yet reported dry — pausing only once every belt has
//     been visited and found empty. That "found dry" memory is SHARED across
//     every pilot running a mining bot: it lives on the BFF, in-process, keyed
//     by solar system NAME then belt NAME (never a grid-local id, which means
//     nothing to a pilot in a different instance of the same system), and it
//     expires on its own so a later tour finds rock that respawned. This block
//     only reads it (`obs.dryBelts`) and reports into it (the `rememberBeltDry`
//     action) — it holds none of that state itself. A CHOSEN (pinned) belt
//     never rotates: it keeps the original "pause when dry" behaviour, pinned
//     to the one belt.
//   • VALUE PRIORITY, when the player wrote NO ore list: the block works the
//     richest ore on the grid first — the rocks whose `oreValuePerM3` is the
//     highest one present — and only falls through to the next ore once those
//     are gone. A hand-written list is left exactly as written, because a player
//     who typed one is saying "I need THIS ore", which is a different question
//     from "what is this belt worth". Nothing is priced → no restriction, which
//     is the behaviour this block always had.
//
//     ⚠ IT RESTRICTS, IT DOES NOT ROTATE. The candidate set only ever shrinks
//     within the rocks already on this grid, so "the belt is dry" still means
//     what it always meant — no rocks at all — and a bot cannot start touring
//     belts because the Veldspar here is not the Kernite it saw somewhere else.
//     The rock currently being WORKED also stays a candidate: a richer rock
//     drifting into view must not make a half-mined one get dropped.
//   • ORE PRIORITY (the step's optional `ores` tier list): only rocks whose
//     groupID matches the CURRENT tier's family are mineable. A belt with none
//     of that ore counts as dry for the tier exactly like an all-out belt does
//     for the plain case; once every belt is dry for the tier, the next tier
//     starts a fresh tour. The current tier is per-pilot (kept on this pilot's
//     own run board, `mineOreTier`) — two pilots working the same system can be
//     on different tiers. Tiers run out → blocked. Deliberately NOT handled: a
//     higher-priority family reappearing on a belt already dry for a lower
//     tier (e.g. Veldspar respawning while working Kernite) is simply not
//     noticed — the tour already moved on, and chasing respawns mid-tier is
//     not worth the extra state for how rarely a rock resource turnover
//     matters here.
//   • SITE mode (the `BeltArg` variant the anomaly miner uses) REPLACES all of
//     the above rather than layering on it. It is a hard fork at the top of
//     `mineAtBelt`, dispatched to `mineAtBeltSite` below, and it never falls
//     through to the belt regex, `beltTarget`, `nearestUnworkedBelt` or
//     `MINE_ORE_TIER_KEY` — see the `isSiteMode` and `BeltArg` (botScript.ts)
//     comments for the incident a belt-rotation fallback silently caused. Two
//     things differ from NEAREST/CHOSEN because a scanner site is a different
//     kind of place than a belt:
//       - "dry" is per-SITE, not per-belt, and is tracked on THIS pilot's own
//         run board (`oreSitesBarren`) rather than the belts' shared,
//         name-keyed BFF memory — a scanner site's label is already unique to
//         this run (`warp-to-ore-anomaly` mints it), so there is no cross-
//         pilot belt-name collision to solve here the way there is for belts.
//       - ore priority is evaluated FRESH ON EVERY GRID rather than climbing a
//         ladder that never comes back down. A belt system has one shared pool
//         of rock that a tier ladder drains in order; an anomaly system hands
//         out a NEW rock field every site, so a ladder would retire Arkonor
//         forever the first time one site happened to lack it. See
//         `mineAtBeltSite`.
function operationMineAtTarget(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
): MacroTick | null {
  const operation = obs.miningOperation ?? null;
  if (operation === null || operation.role !== "MINER") return null;
  // The operation can deplete/relocate without leaving the mine-at-belt step.
  // Tell the flight wrapper explicitly: its generic combat-watch suppression
  // must not swallow this recall, or relaunch from a cached rock while draining.
  const settle = (result: MacroTick): MacroTick => ({ ...result, settleDrones: true });

  const target = operation.currentTarget;
  if (isSiteMode(step) && operationSiteFamily(step) === "ORE_ANOMALY" && (obs.oreMiningModuleIDs?.length ?? 0) === 0) {
    return settle(tick(WAIT, "No online ore mining module is confirmed.", "Ore fit unavailable", { kind: "blocked", reason: "ORE_MINING_CAPABILITY_REQUIRED: Ice Harvesters and gas harvesters cannot mine ore anomalies." }));
  }
  if (isSiteMode(step) && operationSiteFamily(step) === "ICE" && (obs.iceMiningModuleIDs?.length ?? 0) === 0) {
    return settle(tick(WAIT, "No online Ice Harvester is confirmed in the fitted high slots.", "Ice fit unavailable", { kind: "blocked", reason: "ICE_MINING_CAPABILITY_REQUIRED: fit an online Ice Harvester (Ice Harvesting skill dogma); ore miners are not a fallback." }));
  }
  if (target === null) {
    if (isSiteMode(step)) {
      return operationSiteTravel(obs, mem, operationSiteFamily(step));
    }
    const ride = rideAutopilotToSystem(obs, operation.area.anchorSystemID, "Assembling in the anchor system");
    if (ride !== null) return ride;
    const snapshot = obs.snapshot ?? null;
    if (obs.inSpace !== true || snapshot === null) {
      return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, mem);
    }
    const dry = new Set((obs.dryBelts ?? []).filter((row) => row.all).map((row) => row.beltName));
    const unavailable = new Set(obs.unavailableMiningTargetKeys ?? []);
    const systemID = obs.flightStatus?.solarSystemID ?? operation.area.anchorSystemID;
    const systemName = obs.systemName ?? operation.area.anchorSystemName;
    const candidates = snapshot.entities
      .filter((entity) => /belt/i.test(entity.name ?? "") && entity.name !== null)
      .filter((entity) => !dry.has(entity.name!))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .filter((entity) => !unavailable.has(miningOperationTargetKey("BELT", systemID, entity.name!)));
    const candidate = candidates[0];
    if (candidate === undefined || candidate.name === null || systemName === null) {
      return tick(WAIT, "No unclaimed, non-depleted belt is currently available.", "Waiting for target", ACTING, false, mem);
    }
    return tick({
      kind: "reserveMiningTarget",
      targetType: "BELT",
      systemID,
      systemName,
      targetName: candidate.name,
      candidates: candidates.map(entity => ({ targetType: "BELT", systemID, systemName, targetName: entity.name!, position: entity.position })),
    }, `Reserving ${candidate.name} for the operation.`, "Selecting target", ACTING, false, mem);
  }

  const wantedType = isSiteMode(step) ? operationSiteFamily(step) : "BELT";
  if (target.targetType !== wantedType) {
    return settle(tick(WAIT, `The operation is working ${target.targetName}; this block is for ${wantedType}.`, "Waiting for matching target", ACTING, false, mem));
  }

  if (target.state === "DEPLETED" || target.state === "DRAINING") {
    {
      const active = obs.snapshot?.ship?.activeModuleIDs;
      if (active == null) return settle(tick(WAIT, "Mining module settlement cannot be confirmed from an unreadable ship state.", "Clearing depleted target", ACTING, false, mem));
      const moduleID = obs.miningModuleIDs?.find(id => active.includes(id));
      if (moduleID !== undefined) return settle(tick({ kind: "deactivate", moduleID }, "Settling mining modules before site clearance.", "Clearing depleted target", ACTING, false, mem));
      if (!freightReadable(obs.holds)) return settle(tick(WAIT, "Cannot confirm mining freight custody from unreadable holds.", "Clearing depleted target", ACTING, false, mem));
    }
    if (operation.unloadPolicy === "SELF_UNLOAD") {
      const recall = recallBeforeLeaving(obs, mem, "Returning to unload", null);
      if (recall !== null) return settle(recall);
      return tick(WAIT, "The target is depleted; unloading through the saved automation.", "Returning to unload", { kind: "done" });
    }
    if (operation.rendezvous?.thisMemberReady === true) {
      return settle(tick(WAIT, "Partial hold is clear; waiting for the other miners.", "Ready to relocate", ACTING, false, mem));
    }
    const recall = recallBeforeLeaving(obs, mem, "Clearing depleted target", null);
    if (recall !== null) return settle(recall);
    const items = freightHoldItemIDs(obs.holds ?? null);
    if (items.length > 0) {
      const attempts = num(mem, "operationDumpAttempts") ?? 0;
      if (attempts >= OPERATION_DUMP_MAX_ATTEMPTS) {
        return tick(WAIT, "The partial ore dump could not be confirmed.", "Dump blocked", {
          kind: "blocked",
          reason: "The miner still has ore after five confirmed jettison attempts, so it will not silently leave custody behind.",
        });
      }
      return settle(tick(
        { kind: "jettison", itemIDs: items },
        "Dumping every remaining ore stack for the logistics tail.",
        "Clearing depleted target",
        ACTING,
        false,
        { ...mem, operationDumpAttempts: attempts + 1 },
      ));
    }
    return settle(tick(
      { kind: "depleteMiningTarget", targetKey: target.targetKey, evidence: { emptyGridReads: OPERATION_EMPTY_CONFIRM_READS, partialDumpConfirmed: true } },
      "This miner is clear of the depleted target.",
      "Ready to relocate",
      ACTING,
      false,
      mem,
    ));
  }

  const ride = rideAutopilotToSystem(obs, target.systemID, "Following the operation target");
  if (ride !== null) return ride;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Following the operation target", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, mem);
  }
  const measurement = measureSpace(snapshot);
  let rocks = snapshot.entities.filter(isMineableRock);
  if (wantedType !== "BELT") {
    const arrival = operationSiteTravel(obs, mem, wantedType);
    if (arrival.outcome.kind !== "done") return arrival;
    mem = arrival.nextMem;
    if (rocks.some(rock => rock.miningResourceFamily == null)) return settle(tick(WAIT, "A site's resource classification is unreadable.", "Resource authority unavailable", ACTING, false, mem));
    rocks = rocks.filter(rock => siteRockMatches(rock, wantedType));
    obs = { ...obs, miningModuleIDs: wantedType === "ICE" ? obs.iceMiningModuleIDs! : obs.oreMiningModuleIDs! };
  }
  rocks = [...preferredResources(rocks, operation.resourcePolicy)];
  if (wantedType === "BELT") {
    const belt = snapshot.entities.find((entity) => /belt/i.test(entity.name ?? "") && entity.name === target.targetName) ?? null;
    if (belt === null) {
      return tick(WAIT, `The reserved belt ${target.targetName} is not visible here.`, "Target unavailable", {
        kind: "blocked",
        reason: "The operation's exact belt cannot be resolved from current-system data.",
      });
    }
    if (beltTravelStep(belt, measurement) !== "arrive") {
      const recall = recallBeforeLeaving(obs, mem, "Following the operation target", belt.itemID);
      if (recall !== null) return settle(recall);
      const move = beltTravelStep(belt, measurement);
      return tick(move === "approach" ? { kind: "approach", targetID: belt.itemID } : { kind: "warp", targetID: belt.itemID },
        `Travelling to ${target.targetName}.`, "Following the operation target", ACTING, false, mem);
    }
  }
  if (target.state === "RESERVED") {
    return tick({ kind: "activateMiningTarget", targetKey: target.targetKey }, "The fleet has arrived at its reserved target.", "Starting mining", ACTING, false, mem);
  }
  if (rocks.length > 0) {
    const result = step.macro === "fleet-mine" ? fleetMineWithResources(step, obs, mem, snapshot, rocks, measurement)
      : mineWithRocks(step, obs, mem, snapshot, rocks, measurement);
    return wantedType === "BELT" ? result : { ...result, nextMem: { ...result.nextMem, siteTargetKey: target.targetKey, siteMissingReads: 0, operationEmptyReads: 0 } };
  }

  // Belt arrival uses the belt's large surface radius. A recipient can be
  // covered there while the resource field is outside its local scene.
  // Only an observer near the belt centre may supply empty-field evidence.
  if (step.macro === "fleet-mine" && operation.supportPolicy?.mode !== "FALLBACK") {
    const authority = obs.fleetMining, selected = step.args["support"];
    const characterID = selected?.kind === "character" ? selected.charID : null;
    const anchors = authority?.anchors;
    const publications = anchors?.availability === "available" ? anchors.anchors.filter(row => row.characterID === characterID) : [];
    const resolution = authority && publications.length === 1 ? resolveSupportAnchor(publications[0]!,
      { snapshot, receivedAtMs: authority.sceneReceivedAtMs }, anchors!.fleet, authority.nowMs) : null;
    const policy = operation.supportPolicy?.mode;
    const covered = resolution && evaluateSupportEnvelope(resolution, authority!.requirements).status === "inside";
    if (policy === "PAUSE" || policy === "STOP" || characterID !== operation.support?.characterID ||
        supportMemberFleet(step, obs, mem).state !== "ready" || !covered) {
      return fleetMineWithResources(step, obs, { ...mem, operationEmptyReads: 0 }, snapshot, rocks, measurement);
    }
    const belt = snapshot.entities.find(entity => entity.name === target.targetName && /belt/i.test(entity.name ?? ""));
    const ship = snapshot.ship;
    if (!belt?.geometryAvailable || !ship?.geometryAvailable ||
        Math.hypot(ship.position.x - belt.position.x, ship.position.y - belt.position.y, ship.position.z - belt.position.z) > 20000) {
      return settle(tick(WAIT, "The locally empty scene does not observe the belt's resource field.",
        "Fleet Miner — field unobserved", ACTING, false, { ...mem, operationEmptyReads: 0 }));
    }
  }
  const emptyReads = (num(mem, "operationEmptyReads") ?? 0) + 1;
  if (emptyReads < OPERATION_EMPTY_CONFIRM_READS) {
    return tick(WAIT, "No rock is visible yet — confirming before declaring the shared target depleted.", "Confirming depletion", ACTING, false, {
      ...mem,
      operationEmptyReads: emptyReads,
    });
  }
  if (wantedType !== "BELT") {
    // Depletion evidence is not clearance. The shared DRAINING branch above
    // settles module cycles and confirms readable, empty holds before READY.
    return settle(tick(
      { kind: "depleteMiningTarget", targetKey: target.targetKey, evidence: { emptyGridReads: emptyReads } },
      "Site resources are depleted; settling the miner before relocation.",
      "Clearing depleted target", ACTING, false, { ...mem, operationEmptyReads: emptyReads },
    ));
  }
  const recall = recallBeforeLeaving(obs, mem, "Clearing depleted target", null);
  if (recall !== null) return settle(recall);
  if (operation.unloadPolicy === "HAULER_SERVICE") {
    const active = obs.snapshot?.ship?.activeModuleIDs;
    if (active == null) return settle(tick(WAIT, "Mining module settlement cannot be confirmed from an unreadable ship state.", "Clearing depleted target", ACTING, false, mem));
    const moduleID = obs.miningModuleIDs?.find(id => active.includes(id));
    if (moduleID !== undefined) return settle(tick({ kind: "deactivate", moduleID }, "Settling mining modules before the partial ore dump.", "Clearing depleted target", ACTING, false, mem));
    if (!freightReadable(obs.holds)) return settle(tick(WAIT, "Cannot confirm mining freight custody from unreadable holds.", "Clearing depleted target", ACTING, false, mem));
    const items = freightHoldItemIDs(obs.holds ?? null);
    if (items.length > 0) {
      const attempts = num(mem, "operationDumpAttempts") ?? 0;
      if (attempts >= OPERATION_DUMP_MAX_ATTEMPTS) {
        return tick(WAIT, "The partial ore dump could not be confirmed.", "Dump blocked", {
          kind: "blocked",
          reason: "The miner still has ore after five confirmed jettison attempts, so it will not silently leave custody behind.",
        });
      }
      return settle(tick(
        { kind: "jettison", itemIDs: items },
        "The target is depleted; dumping every remaining ore stack before relocation.",
        "Clearing depleted target",
        ACTING,
        false,
        { ...mem, operationEmptyReads: emptyReads, operationDumpAttempts: attempts + 1 },
      ));
    }
  }
  return settle(tick(
    { kind: "depleteMiningTarget", targetKey: target.targetKey, evidence: { emptyGridReads: emptyReads, partialDumpConfirmed: operation.unloadPolicy === "HAULER_SERVICE" } },
    "The operation target is confirmed depleted.",
    operation.unloadPolicy === "SELF_UNLOAD" ? "Returning to unload" : "Ready to relocate",
    ACTING,
    false,
    mem,
  ));
}

/** Separate normal behaviour: current grid outside an operation; shared exact
 * target/travel/depletion custody inside MCC. Classic belt touring stays intact. */
const fleetMine: MacroDecider = (step, obs, mem) => {
  const operationTick = operationMineAtTarget(step, obs, mem);
  if (operationTick !== null) return operationTick;
  const snapshot = obs.snapshot;
  if (!snapshot?.inSpace || obs.inWarp !== false) return { ...tick(WAIT, "Waiting for a fresh in-space observation.", "Fleet Miner — waiting", ACTING, false, mem), settleDrones: true };
  const ores = step.args["ores"];
  const rocks = snapshot.entities.filter(isMineableRock).filter(row => ores?.kind !== "oreList" || ores.ores.length === 0 || ores.ores.some(ore => ore.groupID === row.groupID));
  return fleetMineWithResources(step, obs, mem, snapshot, rocks, measureSpace(snapshot));
};

function supportMemberFleet(step: MacroStep, obs: ScriptObservation, mem: MacroMemory) {
  const authority = obs.fleetMining, supportArg = step.args["support"];
  const supportCharacterID = supportArg?.kind === "character" ? supportArg.charID : null;
  const previous = (mem["fleetMemory"] as MiningSupportFleetMemory | undefined) ?? freshMiningSupportFleetMemory();
  const application = obs.fleetApplication, order = previous.order;
  const proof = application?.supportOrder;
  const feedback = order?.action.kind === "applyToJoinFleet" && application?.fleetID === order.action.fleetID &&
    proof?.actionID === order.actionID && proof?.scope.characterID === previous.scope?.characterID &&
    proof?.scope.sessionEpoch === previous.scope?.sessionEpoch
    ? { ...proof, outcome: "acknowledged" as const, applicationOutcome: application.outcome } : undefined;
  const result = decideMiningSupportFleetMember({ own: authority?.fleet ?? null, supportCharacterID: supportCharacterID ?? 0,
    support: authority?.supportFleet ?? null, supportRoster: authority?.anchors?.fleet,
    policy: { mode: obs.miningOperation?.support?.fleetPolicy ?? "EXISTING_ONLY" }, nowMs: authority?.nowMs ?? NaN, feedback },
    previous);
  return result.action?.kind === "applyToJoinFleet" && result.memory.scope && result.actionID !== null
    ? { ...result, action: { ...result.action, supportOrder: { scope: result.memory.scope, actionID: result.actionID } } } : result;
}

const joinSupportFleet: MacroDecider = (step, obs, mem) => {
  const selected = step.args["support"];
  if (selected?.kind !== "character" || selected.charID === null ||
      obs.miningOperation?.support && obs.miningOperation.support.characterID !== selected.charID) {
    return tick(WAIT, "The selected support pilot does not match the operation.", "Support fleet unavailable",
      { kind: "blocked", reason: "Support pilot identity is unavailable or changed." });
  }
  const membership = supportMemberFleet(step, obs, mem);
  const next = { ...mem, fleetMemory: membership.memory };
  if (membership.state === "ready") return tick(WAIT, "The support fleet membership is confirmed.", "Support fleet ready", { kind: "done" }, true, next);
  const reason = membership.issues[0]?.reason ?? "fleet-state-unknown";
  return tick(membership.action ?? WAIT, reason, "Joining the support fleet",
    membership.state === "blocked" ? { kind: "blocked", reason } : ACTING, false, next);
};

function fleetMineWithResources(step: MacroStep, obs: ScriptObservation, mem: MacroMemory, snapshot: SpaceSnapshot,
  rocks: readonly SpaceEntity[], measurement: SpaceMeasurement | null): MacroTick {
  const authority = obs.fleetMining, supportArg = step.args["support"];
  const supportCharacterID = supportArg?.kind === "character" ? supportArg.charID : null;
  const membership = supportMemberFleet(step, obs, mem);
  const geometry = decideFleetMinerGeometry({ scene: snapshot, sceneReceivedAtMs: authority?.sceneReceivedAtMs ?? NaN,
    nowMs: authority?.nowMs ?? NaN, anchors: authority?.anchors ?? null, supportCharacterID: supportCharacterID ?? 0,
    requirements: authority?.requirements ?? { requireMiningBurst: true }, modules: authority?.modules ?? null,
    resourceCandidates: rocks, preferredTargetID: num(mem, "rockID") });
  const policy = obs.miningOperation?.supportPolicy;
  const paused = policy?.mode === "PAUSE" || policy?.mode === "STOP";
  const state = paused ? "SUPPORT_UNAVAILABLE" : membership.state === "ready" ? geometry.state : "SUPPORT_UNAVAILABLE";
  const reason = paused ? policy.reason : membership.state === "ready" ? geometry.reason : membership.issues[0]?.reason ?? "fleet-state-unknown";
  const next = { ...mem, fleetMemory: membership.memory, fleetMinerState: state, fleetMinerReason: reason,
    fleetMinerTargetID: geometry.targetID, fleetMinerPosition: geometry.position, effectiveMiningRange: geometry.rangeMeters };
  const waiting = (why: string, action: MacroTick["action"] = WAIT, memory: MacroMemory = next): MacroTick =>
    ({ ...tick(action, why, `Fleet Miner — ${state.toLowerCase().replaceAll("_", " ")}`, ACTING, false, memory), settleDrones: true });
  const miningIDs = authority?.modules?.filter(row => row.online).map(row => row.itemID) ?? obs.miningModuleIDs ?? [];
  if (snapshot.ship?.activeModuleIDs == null) return waiting("Active mining equipment state is unreadable.");
  const active = (authority?.modules?.map(row => row.itemID) ?? obs.miningModuleIDs ?? []).find(id => snapshot.ship!.activeModuleIDs!.includes(id));
  const settledDrones = obs.miningDrones?.out?.every(drone => !drone.controlled) === true;
  if (membership.action) return waiting("Reconciling the configured support fleet.", membership.action);
  if (policy?.mode === "STOP") return waiting("Applying the operation's support-loss Stop policy.", { kind: "stopMiningSupportOperation" });
  if (policy?.mode === "FALLBACK") {
    if (active !== undefined && mem["supportFallback"] !== true) return waiting("Settling supported mining before fallback.", { kind: "deactivate", moduleID: active });
    if (mem["supportFallback"] !== true && !settledDrones) return waiting("Returning controlled drones before fallback.");
    if (mem["supportFallback"] !== true && snapshot.ship?.mode !== "STOP") return waiting("Braking supported movement before fallback.", { kind: "stopShip" });
    // Explicit operation policy selects the accepted ordinary mining engine.
    const fallback = mineWithRocks({ ...step, macro: "mine-at-belt" }, obs, mem, snapshot, rocks, measurement);
    return { ...fallback, nextMem: { ...mem, ...fallback.nextMem, supportFallback: true } };
  }
  if (mem["supportFallback"] === true) {
    if (active !== undefined) return waiting("Settling fallback before supported mining resumes.", { kind: "deactivate", moduleID: active });
    if (!settledDrones) return waiting("Returning fallback drones before supported mining resumes.");
    return waiting("Restoring supported mining.", WAIT, { ...next, rockID: null, supportFallback: false });
  }
  const changing = num(mem, "rockID") !== null && num(mem, "rockID") !== geometry.targetID;
  const adopting = num(mem, "rockID") === null && (active !== undefined || !settledDrones);
  if (state !== "MINE" || changing || adopting) {
    if (active !== undefined) return waiting("Settling mining equipment before changing work.", { kind: "deactivate", moduleID: active });
    if (!settledDrones) return waiting("Waiting for authoritative controlled-drone return.");
    if (state !== "REPOSITION" && state !== "MINE") {
      const own = snapshot.ship;
      const fresh = authority && authority.sceneReceivedAtMs <= authority.nowMs && authority.nowMs - authority.sceneReceivedAtMs < 10000;
      if (fresh && own?.motionAvailable === true && [own.velocity.x, own.velocity.y, own.velocity.z].every(Number.isFinite) &&
        (own.mode !== "STOP" || Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) > 0.5))
        return waiting("Braking the previous movement while supported mining is unavailable.", { kind: "stopShip" });
      return waiting(reason ?? "No resource can be mined within current support coverage.");
    }
    if (changing) return waiting("Previous target is settled; choosing the next supported resource.", WAIT,
      { ...next, rockID: null, lockIssued: false, waited: 0, fleetMoveTargetID: null });
  }
  const own = snapshot.ship;
  if (!own || own.motionAvailable !== true || ![own.velocity.x, own.velocity.y, own.velocity.z].every(Number.isFinite)) return waiting("Own movement is unreadable.");
  const moving = own.mode !== "STOP" || Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) > 0.5;
  if (state === "REPOSITION") {
    const mobility = own.coreMobilityFuel?.mobility;
    if (mobility?.movement.verdict !== "unrestricted") return waiting("Waiting for authoritative movement permission.");
    if (!geometry.position || snapshot.shipID === null || snapshot.solarSystemID === null) return waiting("Movement scope is unavailable.");
    if (moving) return waiting(num(mem, "fleetMoveTargetID") === geometry.targetID ? "Observing the issued supported mining movement." : "Stopping the previous movement before taking mining movement ownership.",
      num(mem, "fleetMoveTargetID") === geometry.targetID ? WAIT : { kind: "stopShip" });
    const sameTarget = num(mem, "fleetMoveTargetID") === geometry.targetID;
    const issuedAt = sameTarget ? num(mem, "fleetMoveIssuedAtMs") : null;
    if (issuedAt !== null && authority!.nowMs - issuedAt < 10000) return waiting("Waiting for the previous movement to be observed.");
    const attempts = sameTarget ? num(mem, "fleetMoveAttempts") ?? 0 : 0;
    if (attempts >= 3) return waiting("Supported mining movement could not be confirmed.");
    return waiting("Moving to a point within mining reach and support coverage.",
      { kind: "gotoPoint", position: geometry.position, shipID: snapshot.shipID, solarSystemID: snapshot.solarSystemID },
      { ...next, fleetMoveTargetID: geometry.targetID, fleetMoveIssuedAtMs: authority!.nowMs, fleetMoveAttempts: attempts + 1 });
  }
  if (moving) {
    if (active !== undefined) return waiting("Settling mining before braking.", { kind: "deactivate", moduleID: active });
    if (!settledDrones) return waiting("Returning controlled drones before braking.");
    return waiting("Braking inside support and mining reach.", { kind: "stopShip" });
  }
  const target = rocks.find(row => row.itemID === geometry.targetID);
  if (!target || geometry.rangeMeters === null) return waiting("Resource authority changed.");
  const result = mineWithRocks(step, { ...obs, miningModuleIDs: miningIDs }, next, snapshot, [target], measurement, geometry.rangeMeters);
  return { ...result, nextMem: { ...next, ...result.nextMem, fleetMoveTargetID: null, fleetMoveAttempts: 0 } };
}

const miningSupport: MacroDecider = (_step, obs, mem) => {
  const operation = obs.miningOperation;
  if (operation?.role !== "COMMAND" || !operation.support) return tick(WAIT, "A Standard COMMAND support assignment is required.", "Support unavailable", { kind: "blocked", reason: "COMMAND_SUPPORT_ASSIGNMENT_REQUIRED" });
  const target = operation.currentTarget;
  if (!target) return tick({ kind: "maintainMiningSupport", relocating: true }, "Assembling the support fleet while miners select the shared target.", "Support assembly", ACTING, false, mem);
  const arrival = target.targetType === "BELT" ? operationTravelToBelt(obs, mem) : operationSiteTravel(obs, mem, target.targetType as SiteFamily);
  if (arrival?.outcome.kind === "done") return tick({ kind: "maintainMiningSupport", relocating: false }, "Maintaining support at the operation's owned target.", "Mining support", ACTING, false, {});
  const mobility = obs.snapshot?.ship?.coreMobilityFuel?.mobility;
  if (obs.miningSupportWork?.readyForRelocation !== true || mobility?.movement.verdict !== "unrestricted" || mobility.warp.verdict !== "unrestricted")
    return tick({ kind: "maintainMiningSupport", relocating: true }, "Settling support before following the owned target.", "Support relocation settlement", ACTING, false, mem);
  // Positive support cleanup precedes the existing exact-target travel path.
  return arrival ?? tick(WAIT, "The owned target cannot be resolved.", "Support target unavailable", ACTING, false, mem);
};

const mineAtBelt: MacroDecider = (step, obs, mem, board) => {
  const operationTick = operationMineAtTarget(step, obs, mem);
  if (operationTick !== null) return operationTick;
  if (isSiteMode(step) && operationSiteFamily(step) === "ICE" && obs.miningOperation != null) return operationSiteTravel(obs, mem, "ICE");
  if (isSiteMode(step)) {
    // The dock-and-retry trip (see SITE_GONE_CONFIRM_READS), before the
    // "out in space" wait that would hold a docked ship forever. Back out, the
    // doubted site is committed as the next warp.
    const trip = rejoinTrip(obs, mem, siteTour(step).flavour.noun);
    if (trip === "out") {
      const doubted = label(mem, "doubted");
      mem = {
        ...REJOINED,
        ...(doubted !== null
          ? { siteTarget: doubted, siteRefusalsSeen: refusalFor(obs.refusals, step.id, "warpScan", null)?.count ?? 0 }
          : {}),
      };
    } else if (trip !== null) {
      return trip;
    }
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Flying to the belt", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, mem);
  }

  const measurement = measureSpace(snapshot);
  const allRocks = snapshot.entities.filter(isMineableRock);

  const oresArg = step.args["ores"];
  const ores = oresArg !== undefined && oresArg.kind === "oreList" ? oresArg.ores : [];

  // ⚠ THIS CHECK COMES BEFORE `pinned`, THE BELT REGEX AND THE TIER LADDER,
  // AND MUST GO ON COMING FIRST. Every line below this branch was written for
  // a grid that might have an asteroid belt on it; a site step's grid never
  // does, and letting it reach `mineNoTargetRocks` (nearest/chosen's own
  // barren handling) would re-introduce the exact belt-tour bug this mode
  // exists to close.
  if (isSiteMode(step)) {
    return mineAtBeltSite(step, obs, mem, board, snapshot, allRocks, ores, measurement);
  }

  const pinned = isChosenBelt(step);

  if (ores.length > 0) {
    const tier = boardNum(board, MINE_ORE_TIER_KEY) ?? 0;
    if (tier >= ores.length) {
      return tick(WAIT, "None of the ores on your list are left in this system.", "Nothing left to mine", {
        kind: "blocked",
        reason: "None of the ores on your list are left in this system.",
      });
    }
    const family = ores[tier]!;
    const tierRocks = allRocks.filter((r) => r.groupID === family.groupID);
    if (tierRocks.length === 0) {
      return mineNoTargetRocks(step, obs, snapshot, measurement, board, pinned, family, ores, tier);
    }
    return mineWithRocks(step, obs, mem, snapshot, highestGradeRocks(tierRocks), measurement);
  }

  if (allRocks.length === 0) {
    return mineNoTargetRocks(step, obs, snapshot, measurement, board, pinned, null, [], 0);
  }
  return mineWithRocks(
    step,
    obs,
    mem,
    snapshot,
    richestRocks(allRocks, num(mem, "rockID")),
    measurement,
  );
};

/**
 * The ore priority NOBODY TYPED: the rocks on this grid worth the most per cubic
 * metre, which is the same ordering a player would write by hand if they were
 * ranking ore by what a hold of it is worth.
 *
 * It is a RESTRICTION on this grid's rocks and never a reason to fly anywhere:
 * the set is non-empty whenever `rocks` is, so "this belt is dry" keeps meaning
 * what it always meant. `workingRockID` — the rock the block is part-way through
 * — is kept in the set whatever it is worth, because a richer rock drifting into
 * view is not a reason to abandon a rock the lasers are already cycling on.
 *
 * ⚠ UNPRICED ORE IS NOT CHEAP ORE. When nothing on the grid has a value, every
 * rock stays a candidate (the behaviour before there was a price at all); when
 * only some do, the unpriced ones simply sort behind, the same rule the pick and
 * the survey both hold for a null.
 */
function richestRocks(
  rocks: readonly SpaceEntity[],
  workingRockID: number | null,
): readonly SpaceEntity[] {
  let best: number | null = null;
  for (const rock of rocks) {
    const value = rock.oreValuePerM3;
    if (value !== null && (best === null || value > best)) {
      best = value;
    }
  }
  if (best === null) {
    return rocks;
  }
  return rocks.filter(
    (rock) => rock.oreValuePerM3 === best || rock.itemID === workingRockID,
  );
}

/**
 * No mineable (or no tier-matching) rocks on grid. If we are already sitting
 * on the right belt it is dry — a pinned belt pauses (today's behaviour);
 * nearest mode marks it emptied and rotates to the next unworked belt, only
 * pausing once every belt in the system has come up dry. `family` (when the
 * step carries an ore-priority list) both restricts what counts as "dry" —
 * plenty of rock can still be sitting there, just not the wanted ore — and
 * names the ore in the reported reason instead of a bare id.
 */
function mineNoTargetRocks(
  step: MacroStep,
  obs: ScriptObservation,
  snapshot: SpaceSnapshot,
  measurement: SpaceMeasurement | null,
  board: ScriptBoard,
  pinned: boolean,
  family: OreFamilyArg | null,
  ores: readonly OreFamilyArg[],
  tier: number,
): MacroTick {
  const belts = snapshot.entities.filter((e) => /belt/i.test(e.name ?? ""));

  if (pinned) {
    const belt = beltTarget(step, belts, measurement);
    if (belt === null) {
      return tick(WAIT, "No asteroid belt in view to mine at.", "Nothing to mine", {
        kind: "blocked",
        reason: "The belt this step is pinned to is not on this grid.",
      });
    }
    const travel = beltTravelStep(belt, measurement);
    if (travel === "arrive") {
      const reason = family !== null ? `No ${family.name} left here.` : "This belt has no rocks left to mine.";
      return tick(WAIT, "At the belt, but there is nothing to mine.", "Belt empty", { kind: "blocked", reason });
    }
    if (travel === "approach") {
      return tick({ kind: "approach", targetID: belt.itemID }, `Closing on ${rockLabel(belt)} without a short warp.`, "Flying to the belt", ACTING, false, {});
    }
    return tick({ kind: "warp", targetID: belt.itemID }, `Warping to ${rockLabel(belt)}.`, "Flying to the belt", ACTING, false, {});
  }

  // Nearest mode — rotate. Belts not on this grid at all can't be flown to
  // either, so that is the same "nothing to mine here" block as before.
  if (belts.length === 0) {
    return tick(WAIT, "No asteroid belt in view to mine at.", "Nothing to mine", {
      kind: "blocked",
      reason: "There is no asteroid belt here to mine at.",
    });
  }

  const dryNames = dryBeltNames(obs.dryBelts ?? null, family);
  const options: readonly BeltOption[] = belts.map((b) => ({
    id: b.itemID,
    name: b.name,
    distance: measurement?.distances.get(b.itemID) ?? null,
  }));
  const emptied = belts.filter((b) => b.name !== null && dryNames.has(b.name)).map((b) => b.itemID);
  const target = nearestUnworkedBelt(options, new Set(emptied));

  if (target === null) {
    // Every belt on this grid is reported dry by the shared memory. There is
    // no "emptied this tour" set of our own to clear here — the BFF's memory
    // ages entries out on its own, and THAT is what lets a later tour (of this
    // tier, or any pilot's) find rock that has respawned since.
    if (family !== null && tier + 1 < ores.length) {
      return withBoardPatch(
        tick(WAIT, `No ${family.name} left in this system, moving to the next ore.`, "Switching ore", ACTING, false, {}),
        { [MINE_ORE_TIER_KEY]: tier + 1 },
      );
    }
    const reason = family !== null
      ? "None of the ores on your list are left in this system."
      : "Every asteroid belt in this system is mined out.";
    return tick(WAIT, reason, "Nothing left to mine", { kind: "blocked", reason });
  }

  const targetBelt = belts.find((belt) => belt.itemID === target.id);
  const travel = targetBelt ? beltTravelStep(targetBelt, measurement) : "warp";
  if (travel === "arrive") {
    // On grid with it, and it has none of what we want — tell the BFF's
    // shared memory (name-keyed) instead of writing a board patch of our own,
    // so every pilot's rotation, not just this one, steers away from it.
    const systemName = obs.systemName ?? null;
    const beltName = target.name ?? null;
    if (systemName === null || beltName === null) {
      const reason = "The bot cannot tell which solar system this is.";
      return tick(WAIT, reason, "Belt empty", { kind: "blocked", reason });
    }
    const why = family !== null
      ? `No ${family.name} left here, moving to the next belt.`
      : "This belt is mined out, moving to the next belt.";
    return tick(
      { kind: "rememberBeltDry", systemName, beltName, groupID: family?.groupID ?? null },
      why,
      "Belt empty",
      ACTING,
    );
  }
  if (travel === "approach") {
    return tick({ kind: "approach", targetID: target.id }, `Closing on ${target.name ?? "the belt"} without a short warp.`, "Flying to the belt", ACTING, false, {});
  }
  return tick(
    { kind: "warp", targetID: target.id },
    `Warping to ${target.name ?? "the belt"}.`,
    "Flying to the belt",
    ACTING,
    false,
    {},
  );
}

/** Belt names the shared memory reports dry — for `family`'s tier, or entirely. */
function dryBeltNames(dryBelts: readonly DryBelt[] | null, family: OreFamilyArg | null): ReadonlySet<string> {
  const names = new Set<string>();
  if (dryBelts === null) {
    return names;
  }
  for (const dry of dryBelts) {
    if (dry.all || (family !== null && dry.families.includes(family.groupID))) {
      names.add(dry.beltName);
    }
  }
  return names;
}

// ── mine-at-belt, SITE mode ─────────────────────────────────────────────────
// See the `mineAtBelt` header and `isSiteMode` for why this is a hard fork
// rather than a third branch woven through the belt logic above: a scanner
// site has no belt regex to match, no shared cross-pilot memory to consult
// (its label is already unique to this run — `warp-to-ore-anomaly` mints it),
// and — the whole reason this mode exists — no rotation destination that
// could ever be wrong the way "the nearest belt" was.

/** Where SITE mode keeps ITS OWN barren-site memory. Deliberately not the
 *  belts' `obs.dryBelts` (BFF-shared, belt-name-keyed) and deliberately not
 *  `MINE_ORE_TIER_KEY` (system-wide, one-way) — see the `mineAtBelt` header. */
const ORE_SITES_BARREN_KEY = "oreSitesBarren";
const ICE_SITES_BARREN_KEY = "iceSitesBarren";

/**
 * The two site tours SITE mode can follow: the scanner's ore sites or its ice
 * sites. Each has its own visited and barren lists, so an ice field the bot
 * walked away from is never read as an ore site that went barren, and the
 * other way round.
 */
interface SiteTour {
  readonly flavour: AnomalyFlavour;
  readonly barrenKey: string;
}

function siteTour(step: MacroStep): SiteTour {
  return operationSiteFamily(step) === "ICE"
    ? { flavour: ICE_FLAVOUR, barrenKey: ICE_SITES_BARREN_KEY }
    : { flavour: ORE_FLAVOUR, barrenKey: ORE_SITES_BARREN_KEY };
}

/**
 * Which ore site the ship is standing on, read off `warp-to-ore-anomaly`'s own
 * board key rather than kept by this block. That step already publishes every
 * label it has warped to, as a CSV, oldest first (`ORE_FLAVOUR.boardKey`,
 * encoded in `warpToAnomalyOfKind` below) — the LAST one is wherever the ship
 * last warped to, which is this grid, because nothing else in an anomaly
 * script issues a scan warp. Reusing that key instead of a label of our own
 * is also what keeps the two blocks from ever disagreeing about which site
 * this is.
 *
 * Null when the key is unset or empty — a site block run with no
 * `warp-to-ore-anomaly` in front of it, which `mineAtBeltSiteBarren` turns
 * into "ask for a tour block" rather than a guessed label.
 */
function currentOreSiteLabel(board: ScriptBoard, tour: SiteTour): string | null {
  const visited = String(board[tour.flavour.boardKey] ?? "")
    .split(",")
    .filter((label) => label.length > 0);
  return visited.length > 0 ? visited[visited.length - 1]! : null;
}

/** The labels THIS pilot's site tour has already found barren — same CSV encoding as every other board list in this file. */
function barrenOreSiteLabels(board: ScriptBoard, tour: SiteTour): ReadonlySet<string> {
  return new Set(
    String(board[tour.barrenKey] ?? "")
      .split(",")
      .filter((label) => label.length > 0),
  );
}

/** Append one label to `warp-to-ore-anomaly`'s own visited CSV — see requirement 3 on why this block writes into a key it does not own: without it, that step's next tick would warp the ship right back to the site this one just walked away from. */
function appendOreVisited(board: ScriptBoard, tour: SiteTour, label: string): string {
  const visited = String(board[tour.flavour.boardKey] ?? "")
    .split(",")
    .filter((existing) => existing.length > 0);
  return [...visited, label].join(",");
}

/**
 * SITE mode's rock pick: the highest-priority family from the step's `ores`
 * list that is actually present ON THIS GRID, evaluated fresh every time —
 * never a ladder that only advances. A belt system has one pool of rock a
 * tier ladder drains in visiting order; an anomaly system hands the ship a
 * BRAND NEW rock field at every site, so a ladder that only ever climbs would
 * retire Arkonor for the rest of the run the first time one site's field
 * happened not to have any, even though the very next site might be full of
 * it. `ores.find` keeps the player's ordering (first = most wanted, same as
 * every other ore-priority read in this file) and answers null when nothing
 * on the list is here — which is this grid's barren, not the whole system's.
 *
 * An empty `ores` list (player wrote no priority) mines whatever is richest
 * here, via `richestRocks` — identical to NEAREST/CHOSEN's own no-list
 * behaviour, because "no preference" means the same thing in every mode.
 */
function mineAtBeltSite(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  board: ScriptBoard,
  snapshot: SpaceSnapshot,
  allRocks: readonly SpaceEntity[],
  ores: readonly OreFamilyArg[],
  measurement: SpaceMeasurement | null,
): MacroTick {
  const tour = siteTour(step);
  if (tour.flavour === ICE_FLAVOUR) {
    // Ice takes the harvesters and only the harvesters: an ore laser cycled on
    // an ice chunk mines nothing, and a harvester on a rock is refused.
    const harvesters = obs.iceMiningModuleIDs ?? [];
    if (harvesters.length === 0) {
      return tick(WAIT, "No online Ice Harvester is confirmed in the fitted high slots.", "Ice fit unavailable", {
        kind: "blocked",
        reason: "ICE_MINING_CAPABILITY_REQUIRED: fit an online Ice Harvester; ore miners are not a fallback.",
      });
    }
    if (allRocks.some((rock) => rock.miningResourceFamily == null)) {
      return tick(WAIT, "A site's resource classification is unreadable.", "Resource authority unavailable",
        ACTING, false, { ...mem, oreGridEmptyReads: 0 });
    }
    obs = { ...obs, miningModuleIDs: harvesters };
    allRocks = allRocks.filter((rock) => siteRockMatches(rock, "ICE"));
  }
  if (ores.length === 0) {
    if (allRocks.length === 0) {
      return mineAtBeltSiteBarren(step, obs, mem, board, ores, tour);
    }
    return mineWithRocks(step, obs, mem, snapshot, richestRocks(allRocks, num(mem, "rockID")), measurement);
  }

  const family = ores.find((candidate) => allRocks.some((rock) => rock.groupID === candidate.groupID)) ?? null;
  if (family === null) {
    return mineAtBeltSiteBarren(step, obs, mem, board, ores, tour);
  }
  const familyRocks = allRocks.filter((rock) => rock.groupID === family.groupID);
  return mineWithRocks(step, obs, mem, snapshot, highestGradeRocks(familyRocks), measurement);
}

/**
 * This grid has none of the wanted ore. Mark the site barren, and either move
 * on to the next one or, once every site the scanner knows about is barren,
 * report `blocked` and let `stopSafely` fly the ship home — the same end
 * state the belt modes reach when every belt is dry, reached over sites
 * instead of belts.
 *
 * ⚠ AN EMPTY GRID RIGHT AFTER A WARP HAS NOT ARRIVED YET, and this block used
 * to believe it on the very first read. `fightRatsLadder` above already tells
 * the live incident this is the mining side of: a snapshot that has not
 * caught up reads byte-identical to a grid with nothing on it, and a ship
 * that lands on a full ore anomaly can see zero rocks for a tick or two
 * before the entity list fills in. For the combat side that costs one wasted
 * "grid clear" read; here it is far worse, because the very next thing this
 * function does with "no rock here" is write a label into `oreSitesBarren`
 * FOR THE REST OF THE RUN. Without the same confirmation `fightRatsLadder`
 * already earns with `EMPTY_GRID_CONFIRM_TICKS`, a bot warping into a site
 * full of ore strikes it off the list before the snapshot ever showed it the
 * rock — and with several pilots landing on sites within the same few
 * seconds of each other, a whole system can read "mined out" while every
 * site in it is still full. So the SAME constant, reused rather than
 * reinvented, gates every path below: no barren mark, no `warpScan`, and no
 * "every site is barren" verdict until the grid has read empty on
 * `EMPTY_GRID_CONFIRM_TICKS` CONSECUTIVE ticks. The count lives in this
 * step's own macro memory (`oreGridEmptyReads`) and needs no explicit reset
 * on the rock-found path: `mineWithRocks` REBUILDS its memory on every return
 * rather than spreading it (see its own "COUNTERS ARE CARRIED BY HAND"
 * comment), so the moment a rock is seen and mining resumes, this key is
 * simply not among the ones it carries forward.
 *
 * `obs.anomalies` (the onboard scanner) is read again here rather than
 * carried from an earlier block, because it is the only source that can name
 * "the next ore site" at all — `warp-to-ore-anomaly` does not hand this block
 * a list, only a label per warp. Unread yet (`null`) waits rather than
 * guessing; `warpToAnomalyOfKind` above earns that same patience with its own
 * `EMPTY_SCAN_CONFIRM_READS`, but this read only ever feeds a WARP THIS BLOCK
 * IS ABOUT TO ISSUE, never a "give up" verdict, so one null tick is enough —
 * there is no stale board state written before it that a slow scanner could
 * strand.
 */
function mineAtBeltSiteBarren(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  board: ScriptBoard,
  ores: readonly OreFamilyArg[],
  tour: SiteTour,
): MacroTick {
  // Consecutive: any tick this function is even reached means the current
  // read found no wanted rock, so there is no separate "saw a rock, reset
  // the count" branch to write here — that reset already happened for free,
  // on the mineWithRocks path, before this function was ever called.
  const emptyReads = (num(mem, "oreGridEmptyReads") ?? 0) + 1;
  if (emptyReads < EMPTY_GRID_CONFIRM_TICKS) {
    // ⚠ THIS IS NOT THE TOUR'S "The scanner came back empty — reading it
    // again." sentence, and must never borrow it. That one means the SCANNER
    // found no anomalies at all; this one means the GRID (rocks in local
    // space) has not shown the wanted ore yet. Telling the player the wrong
    // one of those two would send them looking at the wrong panel — the same
    // reason `noSiteReason` above keeps the scanner and the overview apart.
    return tick(
      WAIT,
      "Nothing of the wanted ore on the grid yet — reading it again before calling this site barren.",
      "Scanning",
      ACTING,
      false,
      { ...mem, oreGridEmptyReads: emptyReads },
    );
  }

  const anomalies = obs.anomalies ?? null;
  if (anomalies === null) {
    return tick(WAIT, `Reading the scanner for the next ${tour.flavour.noun}.`, "Scanning", ACTING, false, { ...mem, oreGridEmptyReads: emptyReads });
  }

  const currentLabel = currentOreSiteLabel(board, tour);
  if (currentLabel === null) {
    // No `warp-to-ore-anomaly` ahead of this block ever wrote a label, so
    // there is nothing to mark barren and nothing safe to guess. Reported as
    // `blocked` rather than an endless wait: a grid that never gets more rock
    // is exactly as stuck as a system with none left, and the player needs
    // to know WHY, not just that nothing is moving.
    const reason = `This block needs a Fly-to-${tour.flavour.oneNoun.replace(/ /g, "-")} block ahead of it, so it knows which site just went barren.`;
    return tick(WAIT, "This grid has no rock of the wanted ore, and no tour block named which site this is.", "Nothing to mine", {
      kind: "blocked",
      reason,
    });
  }

  const oreNames = ores.length > 0 ? ores.map((family) => family.name).join(" and ") : null;
  const barren = new Set(barrenOreSiteLabels(board, tour));
  // ⚠ ONLY WHEN THE SHIP IS AT IT. An empty grid says nothing about a site the
  // ship is nowhere near: back from the dock-and-retry trip it is the
  // station's grid, and a pilot a server restart caught mid-warp wakes in open
  // space with the board still naming the site. Unknown positions keep the old
  // reading.
  if (shipStandsInSite(obs, currentLabel) !== false) {
    barren.add(currentLabel);
  }

  // ⚠ A SITE THE SERVER REFUSES IS A SITE THAT IS GONE, AND IT IS STRUCK OFF
  // LIKE A BARREN ONE. A site the fleet just emptied stays on the scanner for a
  // moment after the server has torn it down, and a warp at it comes back
  // "You have not scanned that site down" (DUNGEON_INSTANCE_NOT_AUTHORIZED).
  // This branch used to issue the warp straight off the pick, and a refused
  // issue commits nothing — not the memory, not the board — so every tick
  // re-picked the same dead site and the runner stopped the bot after ten
  // refusals in a row, in space, with other sites still listed.
  //
  // So the same two-phase shape `warpToAnomalyOfKind` uses: a WAIT tick commits
  // the pick (and the barren mark) BEFORE the press, which leaves a refused
  // warp something to read. A refusal newer than the committed baseline sets
  // that site aside and the next tick re-reads the scanner and picks again;
  // when nothing is left the run ends `blocked`, which flies the ship home
  // before it stops (`stopSafely`).
  //
  // ⚠ ...EXCEPT THAT A REFUSAL IS NOT PROOF, and striking a refused site off
  // for the run is how a full field got called mined out. The server words a
  // torn-down site and a ship it still files under some site's pocket the same
  // way (see SITE_GONE_CONFIRM_READS). So a refused site is only set aside for
  // this step; when it was the last one, the scanner is read again before the
  // verdict, and a site it still lists gets the dock-and-retry trip instead.
  const listed = (name: string) => anomalies.some((site) => site.label === name && tour.flavour.matches(site));
  const refused = listOf(mem, "siteRefused");
  let target = label(mem, "siteTarget");
  let refusalWords: string | null = null;
  if (target !== null) {
    const refusal = refusalFor(obs.refusals, step.id, "warpScan", null);
    if (refusal !== null && refusal.count > (num(mem, "siteRefusalsSeen") ?? 0)) {
      refused.push(target);
      refusalWords = refusal.words;
      target = null;
    } else if (!listed(target)) {
      // Gone from the scanner between the pick and the press: pick again.
      target = null;
    }
  }
  const doubted = label(mem, "doubted");
  if (doubted !== null) {
    const read = readDoubtedSite(obs, mem, tour.flavour.noun, doubted, listed(doubted));
    if (read !== "gone") {
      return withBoardPatch(read, { [tour.barrenKey]: [...barren].join(",") });
    }
    barren.add(doubted); // gone from the scanner: torn down, and barren for the run
  }
  const barrenPatch = { [tour.barrenKey]: [...barren].join(",") };

  if (target !== null) {
    const why = oreNames !== null
      ? `No ${oreNames} left here, moving to the next ${tour.flavour.noun}.`
      : `This ${tour.flavour.noun} is mined out, moving to the next one.`;
    return withBoardPatch(
      tick({ kind: "warpScan", target }, why, tour.flavour.flying, ACTING, false, {}),
      { ...barrenPatch, [tour.flavour.boardKey]: appendOreVisited(board, tour, target) },
    );
  }

  const next = anomalies.find((site) => tour.flavour.matches(site) && !barren.has(site.label) && !refused.includes(site.label));
  const lastRefused = refused.at(-1);
  if (next === undefined && doubted === null && lastRefused !== undefined && listed(lastRefused)) {
    return withBoardPatch(
      tick(WAIT, `The ${tour.flavour.noun} refused the ship. Checking the scanner still lists it.`, "Scanning", ACTING, false, {
        ...without(mem, "siteTarget", "siteRefusalsSeen"),
        oreGridEmptyReads: emptyReads,
        siteRefused: refused.join(","),
        doubtReads: 0,
        ...doubtMem(lastRefused, refusalWords),
      }),
      barrenPatch,
    );
  }
  if (next === undefined) {
    const reason = oreNames !== null
      ? `Every ${tour.flavour.noun} in this system is out of ${oreNames}.`
      : `Every ${tour.flavour.noun} in this system is mined out.`;
    return withBoardPatch(
      tick(WAIT, reason, "Nothing left to mine", { kind: "blocked", reason }),
      barrenPatch,
    );
  }

  // PHASE 1: commit the pick with a wait tick. The baseline is the ledger count
  // RIGHT NOW, so a refusal already on record is never read as one of this warp.
  return withBoardPatch(
    tick(WAIT, `Choosing the next ${tour.flavour.noun} to warp to.`, "Scanning", ACTING, false, {
      ...without(mem, "doubted", "doubtReads", "doubtWords"),
      oreGridEmptyReads: emptyReads,
      siteTarget: next.label,
      siteRefusalsSeen: refusalFor(obs.refusals, step.id, "warpScan", null)?.count ?? 0,
      ...(refused.length > 0 ? { siteRefused: refused.join(",") } : {}),
    }),
    barrenPatch,
  );
}

/** We have rocks (of the current tier, when there is one) — the core lock-and-mine loop. */
function mineWithRocks(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  snapshot: SpaceSnapshot,
  rocks: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
  effectiveRangeMeters?: number,
): MacroTick {
  // We have rocks. Track the one we are working. On an ice field they are
  // ice chunks, and the pilot reads them as that.
  const noun = rocks.some((r) => r.miningResourceFamily === "ice") ? "ice chunk" : "rock";
  const oneNoun = noun === "rock" ? "a rock" : "an ice chunk";
  let rockID = num(mem, "rockID");
  const present = rockID !== null && rocks.some((r) => r.itemID === rockID);
  if (!present) {
    rockID = null;
  }

  if (rockID === null) {
    const pick = pickRock(step, rocks, measurement);
    if (pick === null) {
      return tick(WAIT, "Nothing pickable to mine.", "Picking a rock", ACTING, true, {});
    }
    if (step.macro === "fleet-mine") return tick(WAIT, "Choosing the supported resource.", "Fleet Miner — choosing", ACTING, true,
      { rockID: pick.itemID, lockIssued: false, waited: 0, approachedRockID: pick.itemID,
        lockRefusalsSeen: refusalFor(obs.refusals, step.id, "lock", null)?.count ?? 0 });
    // Orbit the new rock at 5km to get into mining range; lock next tick.
    return tick(
      { kind: "orbit", targetID: pick.itemID, range: ORBIT_RANGE_M },
      `Closing in on ${rockLabel(pick, oneNoun)}.`,
      `Approaching ${oneNoun}`,
      ACTING,
      true,
      clearCloseInStall({
        rockID: pick.itemID,
        lockIssued: false,
        waited: 0,
        approachedRockID: pick.itemID,
        // ⚠ THE BASELINE FOR "A REFUSAL NEWER THAN THIS PICK". A record lives until a
        // SUCCESS on the same key clears it, so one left over from a rock dropped and
        // picked again would otherwise be read as a fresh refusal for ever.
        lockRefusalsSeen: refusalFor(obs.refusals, step.id, "lock", null)?.count ?? 0,
      }),
    );
  }

  const locked = (obs.lockedTargetIDs ?? []).includes(rockID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      // ⚠ A REFUSED LOCK COMMITS NOTHING (2fd4a77), so `lockIssued` below is never
      // set by a press that failed and this block would press again on every tick
      // until the runner's ten-refusal cap sent the ship home. Live: a rock beyond
      // lock range, a ship closing at 144 m/s, TargetNotWithinRangeGeneric ten
      // times in four minutes. What it can read instead is the ledger, against
      // the baseline committed when the rock was picked.
      const rockDist = measurement?.distances.get(rockID) ?? null;
      const lockRange = obs.maxTargetRangeM ?? null;
      const seen = num(mem, "lockRefusalsSeen") ?? 0;
      const refusedAt = num(mem, "lockRefusedAtM");
      const refusal = refusalFor(obs.refusals, step.id, "lock", null);
      const fresh = refusal !== null && refusal.count > seen && refusalTargets(refusal, rockID);
      // ⚠ THE COUNTERS ARE CARRIED BY HAND, as in the mining-range wait below: this
      // block REBUILDS its memory on every return.
      const closingIn = (seenCount: number, atM: number | null): MacroTick => {
        const stall = closeInStall(measurement?.shipMode ?? null, mem);
        const closing: MacroMemory = {
          rockID,
          lockIssued: false,
          waited: 0,
          approachedRockID: num(mem, "approachedRockID"),
          lockRefusalsSeen: seenCount,
          ...(atM !== null ? { lockRefusedAtM: atM } : {}),
          stallTicks: num(stall.mem, "stallTicks") ?? 0,
          stallStage: num(stall.mem, "stallStage") ?? 0,
        };
        if (stall.step === "reorder") {
          return tick({ kind: "orbit", targetID: rockID, range: ORBIT_RANGE_M }, STALL_REORDER_WHY, `Approaching ${oneNoun}`, ACTING, true, closing);
        }
        if (stall.step === "unstick") {
          return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, `Approaching ${oneNoun}`, ACTING, true, closing);
        }
        if (stall.step === "stuck") {
          return tick(WAIT, STALL_STUCK_WHY, `Approaching ${oneNoun}`, { kind: "blocked", reason: STALL_STUCK_REASON });
        }
        return tick(WAIT, "Closing in — too far out to lock yet.", `Approaching ${oneNoun}`, ACTING, true, closing);
      };
      // A refusal that arrives while the pre-gate holds the press is absorbed, not left
      // to be read as "new" once the rock is in range.
      const seenNow = refusal !== null ? Math.max(seen, refusal.count) : seen;
      // ⚠ NOT FOR FLEET-MINE. That block owns its own movement and only gets here
      // once it has braked to a stop inside support coverage, so the stall ladder
      // in `closingIn` would read the stop as a stall and order an orbit it must
      // never fly. A refused lock there takes the timed path, as it always did.
      const closes = step.macro !== "fleet-mine";
      if (closes && rockDist !== null && lockRange !== null && rockDist > lockRange) {
        return closingIn(seenNow, refusedAt);
      }
      // The timed path: exactly what a refused lock did before 2fd4a77.
      const timed = (seenCount: number): MacroTick => tick(WAIT, "Waiting for the lock.", "Locking on", ACTING, true, {
        rockID,
        lockIssued: true,
        waited: 0,
        approachedRockID: num(mem, "approachedRockID"),
        lockRefusalsSeen: seenCount,
      });
      if (fresh) {
        // Far enough that it is a range problem: close in, and press again only after
        // real progress. Close, or unreadable: not a range problem this block can
        // measure, so let it time out and move on.
        return closes && rockDist !== null && rockDist > MINING_RANGE_M ? closingIn(refusal.count, rockDist) : timed(refusal.count);
      }
      if (refusedAt !== null) {
        if (rockDist === null) return timed(seen);
        if (rockDist > LOCK_REPRESS_PROGRESS * refusedAt) return closingIn(seen, refusedAt);
      }
      return tick({ kind: "lock", targetID: rockID }, `Locking the ${noun}.`, "Locking on", ACTING, true, {
        rockID,
        lockIssued: true,
        waited: 0,
        approachedRockID: num(mem, "approachedRockID"),
      });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      // It will not lock — let it go and pick another next tick.
      return tick(WAIT, "That rock would not lock, so moving on.", "Picking another rock", ACTING, true, {});
    }
    return tick(WAIT, "Waiting for the lock.", "Locking on", ACTING, true, {
      rockID,
      lockIssued: true,
      waited,
      approachedRockID: num(mem, "approachedRockID"),
    });
  }

  // Locked, but a lock reaches much further than the mining equipment does — a
  // rock picked far across the belt can land its lock well before the orbit
  // issued above has actually closed the distance. Same check repHurtMate and
  // the combat engage do: measure, and if still out of range, close in before
  // ever trying to switch the equipment on rather than silently doing nothing.
  const rockDist = measurement?.distances.get(rockID) ?? null;
  const outOfRange = rockDist !== null && rockDist > (step.macro === "fleet-mine" ? effectiveRangeMeters ?? 0 : MINING_RANGE_M);
  if (outOfRange && step.macro === "fleet-mine") return { ...tick(WAIT, "Resource moved outside effective mining reach.", "Fleet Miner — reposition needed", ACTING, false, mem), settleDrones: true };
  if (outOfRange) {
    if (num(mem, "approachedRockID") !== rockID) {
      return tick(
        { kind: "orbit", targetID: rockID, range: ORBIT_RANGE_M },
        "Closing in — too far out to mine yet.",
        `Approaching ${oneNoun}`,
        ACTING,
        true,
        clearCloseInStall({ rockID, lockIssued: true, waited: 0, approachedRockID: rockID }),
      );
    }
    // ⚠ AN ORBIT IS REFUSED THE SAME SILENT WAY AN APPROACH IS, and a belt is
    // where it bites hardest: this ladder's FIRST order after the warp to the
    // belt is the orbit above, which is exactly the tick eve.js still has the
    // hull `landingPending`. See `closeInStall.ts` for the deadlock and why a stop
    // is what breaks it. Without this rung the miner says "closing in" while
    // flying a straight line away from the belt for the rest of the night.
    //
    // ⚠ THE COUNTERS ARE CARRIED BY HAND because this block REBUILDS its memory
    // on every return rather than spreading it — spreading here would quietly
    // resurrect keys the rebuild exists to drop.
    const stall = closeInStall(measurement?.shipMode ?? null, mem);
    const closing: MacroMemory = {
      rockID,
      lockIssued: true,
      waited: 0,
      approachedRockID: rockID,
      stallTicks: num(stall.mem, "stallTicks") ?? 0,
      stallStage: num(stall.mem, "stallStage") ?? 0,
    };
    if (stall.step === "reorder") {
      return tick({ kind: "orbit", targetID: rockID, range: ORBIT_RANGE_M }, STALL_REORDER_WHY, `Approaching ${oneNoun}`, ACTING, true, closing);
    }
    if (stall.step === "unstick") {
      return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, `Approaching ${oneNoun}`, ACTING, true, closing);
    }
    if (stall.step === "stuck") {
      return tick(WAIT, STALL_STUCK_WHY, `Approaching ${oneNoun}`, { kind: "blocked", reason: STALL_STUCK_REASON });
    }
    return tick(WAIT, "Closing in — too far out to mine yet.", `Approaching ${oneNoun}`, ACTING, true, closing);
  }

  // Locked and in range — switch on any mining module that is not already cycling.
  //
  // ⚠ AN EMPTY LIST IS NOT "NOTHING LEFT TO SWITCH ON". `miningModuleIDs` is
  // auto-detected from the ship's fit (flow.ts's `resolveMiningModuleIDs`, by
  // high-slot + the game's own mining group names) — if that comes back empty
  // (a fit that failed to load, or a module whose group never resolved), the
  // `.find()` below would ALSO report "nothing left to activate" and this
  // block would silently declare "Mining the rock" having never issued an
  // activate at all. Reported as blocked instead, so a genuinely fitted-but-
  // undetected miner is not indistinguishable from a fully spun-up one.
  const miners = obs.miningModuleIDs ?? [];
  if (miners.length === 0) {
    return tick(WAIT, "No mining equipment was found fitted to this ship.", "No miners fitted", {
      kind: "blocked",
      reason: "No mining equipment was found fitted to this ship.",
    });
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const nextMiner = miners.find((id) => !active.has(id));
  if (nextMiner !== undefined) {
    return tick(
      { kind: "activate", moduleID: nextMiner, targetID: rockID },
      "Switching the mining equipment on.",
      "Mining",
      ACTING,
      true,
      { rockID, lockIssued: true, waited: 0, approachedRockID: rockID },
    );
  }
  return tick(WAIT, `Mining the ${noun}.`, "Mining", ACTING, true, { rockID, lockIssued: true, waited: 0, approachedRockID: rockID });
}

// ── deliver-ore ──────────────────────────────────────────────────────────────
// Fly to the station — same system or across the map, on the SHARED autopilot —
// and unload; done once the hold is empty AT THE TARGET (an unload anywhere
// else would scatter the ore across stations).
//
// The optional `into` argument aims the load at a CORPORATION hangar division.
// It changes nothing about when this block is done: the block's contract is
// that the freight holds end up empty at the target, and they do whether the
// corporation took the load or the pilot's own hangar did. The bridge decides
// which — an office that is not rented here any more, or a division this pilot
// has no role for, lands the ore in their own hangar rather than stranding it
// aboard — and says which in its answer, so the run's own log can tell the
// player the corporation refused without the block having to stop the bot over
// it. Asking HERE instead (read the offices, check a role, then unload) would
// be two more round trips per lap to arrive at an answer the deposit itself
// gives away for free, and it would still be a guess: the role is checked at
// the office, at the moment of the move.
const deliverOre: MacroDecider = (step, obs, mem, board) => {
  const target = stationTarget(step, obs, board);
  const targetKind: DockableKind = step.args["station"]?.kind === "station" &&
    step.args["station"].ref.entity === "structure" ? "structure" : "station";
  if (target === null) {
    return tick(WAIT, "No station picked to unload at.", "Hauling", {
      kind: "blocked",
      reason: "This step needs a station to unload at.",
    });
  }
  if (targetKind === "structure" && step.args["into"]?.kind === "corpDivision" && !obs.miningOperation && !obs.strictCorpDelivery) {
    return tick(WAIT, "Use the strict corporate route for structure division delivery.", "Hauling", {
      kind: "blocked", reason: "Generic ore delivery cannot prove an exact structure corporation division deposit.",
    });
  }
  const operation = obs.miningOperation ?? null;
  const drainTarget = operation?.role === "HAULER" ? operation.logisticsTarget : null;
  const drainGridClear = confirmedDrain(obs, board);
  if ((drainTarget !== null || operation?.unloadPolicy === "SELF_UNLOAD") && !freightReadable(obs.holds)) {
    return tick(WAIT, "Freight holds are unreadable; delivery cannot be confirmed.", "Delivery — hold unavailable", ACTING, false, mem);
  }
  if (drainTarget !== null && drainGridClear && freightHoldItemIDs(obs.holds ?? null).length === 0 && obs.flightStatus?.docked !== true) {
    return tick({ kind: "miningDrainComplete", targetKey: drainTarget.targetKey },
      "The old grid and freight are clear; catching up to the fleet.", "Logistics tail complete", ACTING, false, mem);
  }
  if (dockedAt(obs.flightStatus, { kind: targetKind, id: target })) {
    if (!freightReadable(obs.holds)) {
      return tick(WAIT, "Freight holds are unreadable; delivery cannot be confirmed.", "Delivery — hold unavailable", ACTING, false, mem);
    }
    // The FREIGHT holds, not every hold. On a hull with an ore hold the cargo
    // hold is not where the ore is, and emptying it here put the ship's spare
    // crystals and ammunition ashore every lap — see freightHoldItemIDs.
    const items = freightHoldItemIDs(obs.holds ?? null);
    if (items.length > 0) {
      const into = step.args["into"];
      const division = into !== undefined && into.kind === "corpDivision" ? into.division : null;
      // The key is left OFF for an ordinary hangar unload rather than sent as
      // null, so a block nobody aimed at a corporation issues byte-for-byte the
      // action it always did.
      return tick(
        division === null
          ? { kind: "unloadOre", itemIDs: items }
          : { kind: "unloadOre", itemIDs: items, division,
              ...(obs.miningOperation || obs.strictCorpDelivery ? { strictCorp: true } : {}) },
        division === null
          ? "Unloading the ore into the hangar."
          : "Unloading the ore into the corporation hangar.",
        "Unloading",
        ACTING,
      );
    }
    if (drainTarget !== null && drainGridClear) {
      return tick({ kind: "miningDrainComplete", targetKey: drainTarget.targetKey },
        "The old target's freight is ashore.", "Logistics tail complete", ACTING, false, mem);
    }
    if (drainTarget !== null) return tick(WAIT, "Returning to finish the old target.", "Continuing logistics tail", { kind: "done" });
    if (operation?.role === "MINER" && operation.unloadPolicy === "SELF_UNLOAD" &&
        operation.rendezvous?.kind === "SELF_UNLOAD") {
      if (!operation.rendezvous.thisMemberReady) return tick({ kind: "miningMemberReady" },
        "The hold is empty; this miner is ready for fleet rendezvous.", "Ready for rendezvous", ACTING, false, mem);
      return tick(WAIT, "Waiting for other miners before the next target.", "Rendezvous", ACTING, false, mem);
    }
    return tick(WAIT, "The ore is unloaded.", "Done hauling", { kind: "done" });
  }
  // Heading out to haul — never warp off with drones still out. Align only to a
  // target actually on this grid; off-grid, the recall just holds.
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Hauling", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, target, drainGridClear ? "Final partial delivery" : "Flying to the destination", targetKind);
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Arrived to unload.", "Docking", ACTING, false);
};

// ── travel-to-station ────────────────────────────────────────────────────────
// Fly to ANY station and dock — same system or across the map. The trip rides
// the SHARED autopilot (route solver, gate jumps, the R24 dock ladder), so this
// block is a destination plus the never-abandon-drones send-off.
const travelToStation: MacroDecider = (step, obs, mem, board) => {
  const target = stationTarget(step, obs, board);
  const stationArg = step.args["station"];
  const targetKind: DockableKind = stationArg?.kind === "station" && stationArg.ref.entity === "structure" ? "structure" : "station";
  if (target === null) {
    return tick(WAIT, "No station picked.", "Travelling", { kind: "blocked", reason: "This step needs a station to go to." });
  }
  if (dockedAt(obs.flightStatus, { kind: targetKind, id: target })) {
    return tick(WAIT, "Docked.", "Arrived", { kind: "done" });
  }
  // Align only to something actually on this grid; off-grid, recall just holds.
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Travelling", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, target, "Travelling", targetKind);
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Docked.", "Arrived", { kind: "done" });
};

// ── travel-to-system ─────────────────────────────────────────────────────────
// Fly to a SOLAR SYSTEM and stop there — the arrival-waiting twin of
// set-destination. Same shared autopilot, same route solver; the only
// difference, and the whole reason the block exists, is WHEN it finishes.
//
// ⚠ set-destination is done the moment the trip is under way, on purpose, so a
// player can put their own checks after it. That makes it the wrong block to
// put in front of one that works on something in ANOTHER system: the next block
// becomes the active step while the ship is still two gates out, reads the grid
// it happens to be on, and stops the run for want of a belt/station/anomaly that
// was never going to be there yet. Caught live, 2026-09-08: a mining bot pinned
// to a belt in the next system over mined one lap (started in-system), then
// stopped every lap after with "the belt this step is pinned to is not on this
// grid" the moment it undocked at home.
//
// Arrival is measured on the SYSTEM ID and nothing else — docked or in space,
// being there is being there. The autopilot's own system plan lands in space and
// counts a dock in the destination system as arrived (`isAtDestination`), so a
// stricter "in space too" rule would hang forever on a pilot who started the
// block docked in the target system. A program that needs to be undocked says so
// with an `undock` block, exactly as it does after travel-to-station.
const travelToSystem: MacroDecider = (step, obs, mem) => {
  const arg = step.args["system"];
  if (arg === undefined || arg.kind !== "system" || arg.ref.id === null) {
    return tick(WAIT, "No system picked.", "Travelling", {
      kind: "blocked",
      reason: "This step needs a solar system to go to.",
    });
  }
  const target = arg.ref.id;
  if (obs.flightStatus?.solarSystemID === target) {
    return tick(WAIT, "Arrived.", "Arrived", { kind: "done" });
  }
  // Never warp off with drones still out. There is no grid target to align to
  // — the destination is a whole system — so the recall just holds.
  const recall = recallBeforeLeaving(obs, mem, "Travelling", null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotToSystem(obs, target, "Travelling");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Arrived.", "Arrived", { kind: "done" });
};

// ── defend-with-drones ───────────────────────────────────────────────────────
// Launch combat drones, set them on the nearest pirate, and finish once the
// pirates are gone.
const defendWithDrones: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Not in space, so nothing to defend against.", "Defending", { kind: "done" });
  }
  const roster = droneRoster(obs, "combat");
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const target = hostileRows(snapshot, origin)[0]?.itemID ?? null;
  if (target === null) {
    // The pirates are gone. Bring the drones home BEFORE finishing — ALL of
    // them, whatever they are — the block is done only once they are actually
    // back, so the loop never warps off to the next task and abandons them.
    if (roster.out.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: roster.out }, "The pirates are gone — calling the drones back in.", "Recalling drones", ACTING);
    }
    return tick(WAIT, "The drones are back; nothing left to fight.", "Defending", { kind: "done" });
  }
  // The COMBAT drones out — never the whole bay (see launchRoleDrones).
  const launch = launchRoleDrones(obs, mem, "Launching drones", "combat", "Launching the combat drones.");
  if (launch.tick !== null) {
    return launch.tick;
  }
  mem = launch.mem;
  if (roster.roleOut.length === 0) {
    if (roster.roleBay.length === 0) {
      return tick(WAIT, "No combat drones in the bay.", "Defending", {
        kind: "blocked",
        reason:
          roster.othersOut.length > 0
            ? "The drones out cannot fight, and there are no combat drones in the bay to launch."
            : "There are no combat drones in the bay to launch.",
      });
    }
    if (launchStalled(mem)) {
      return tick(WAIT, "The combat drones would not launch.", "Defending", {
        kind: "blocked",
        reason: "The combat drones could not be launched.",
      });
    }
    return tick(WAIT, "Waiting for the other drones to come home so the combat drones can go out.", "Launching drones", ACTING, true, mem);
  }
  if (num(mem, "engaged") === target) {
    return tick(WAIT, "The drones are on the pirate.", "Fighting", ACTING, true, mem);
  }
  return tick(
    { kind: "engageDrones", droneIDs: roster.roleOut, targetID: target },
    "Sending the drones onto the pirate.",
    "Fighting",
    ACTING,
    true,
    { ...mem, engaged: target },
  );
};

// ═══ The distribution-mission set ═══════════════════════════════════════════
// Each block is one operation of the PROVEN mission-bot loop, reusing its
// helpers verbatim (agentActionID / missionAccepted / findPackageStack /
// packageAboard / gateOffer). Cross-block facts (the agent, the mission) ride
// the run BOARD; each block confirms by re-read, one action per tick.

/**
 * The item rules in one `itemList` argument — the saved form (which carries the
 * player's display names) stripped down to what the matcher tests on.
 */
function itemRules(step: MacroStep, key: string): readonly KeepRule[] {
  const arg = step.args[key];
  if (arg === undefined || arg.kind !== "itemList") {
    return [];
  }
  const rules: KeepRule[] = [];
  for (const item of arg.items) {
    switch (item.match) {
      case "type":
        rules.push({ match: "type", typeID: item.typeID });
        break;
      case "group":
        rules.push({ match: "group", groupID: item.groupID });
        break;
      case "name":
        // A pattern that is only whitespace matches nothing rather than
        // everything; the matcher enforces that too, but dropping it here keeps
        // "has this step been given any rules at all" honest.
        if (item.pattern.trim().length > 0) {
          rules.push({ match: "name", pattern: item.pattern });
        }
        break;
    }
  }
  return rules;
}

/** The "leave this aboard" rules on a step, or none. */
function keepRules(step: MacroStep): readonly KeepRule[] {
  return itemRules(step, "keepItems");
}

/** The bay keys one `bayList` argument names, or none. */
function bayListArg(step: MacroStep, key: string): readonly string[] {
  const arg = step.args[key];
  return arg !== undefined && arg.kind === "bayList" ? arg.bays : [];
}

const MAX_BLOCK_ATTEMPTS = 5; // presses/moves per block before it says so and stops

function boardNum(board: ScriptBoard, key: string): number | null {
  const value = board[key];
  return typeof value === "number" ? value : null;
}

/** Attach a board patch to an already-built tick (`tick()` itself has no slot for one). */
function withBoardPatch(t: MacroTick, patch: ScriptBoard): MacroTick {
  return { ...t, boardPatch: patch };
}

// ── belt rotation bookkeeping (mine-at-belt, nearest mode) ─────────────────
// Which belts have been found dry lives OFF this board entirely now — it is
// the BFF's shared, name-keyed memory (see the `mineAtBelt` header comment
// and `dryBeltNames` above), so every pilot's rotation sees the same picture
// and a later tour finds rock that respawned once the BFF's entry ages out.
// The current ORE TIER stays per-pilot on this run board: two pilots working
// the same system can legitimately be working different tiers.
const MINE_ORE_TIER_KEY = "mineOreTier";

/** The agent this mission step works with: its own pick, or the board's. */
function stepAgentID(step: MacroStep, board: ScriptBoard): number | null {
  const arg = step.args["agent"];
  if (arg !== undefined && arg.kind === "agent" && arg.ref.id !== null) {
    return arg.ref.id;
  }
  return boardNum(board, "agentID");
}

function countArg(step: MacroStep, key: string): number | null {
  const arg = step.args[key];
  return arg !== undefined && arg.kind === "count" ? arg.value : null;
}

/** Riding the shared autopilot to a station, multi-system. Null once docked there. */
function rideAutopilotTo(obs: ScriptObservation, stationID: number, phase: string, kind: DockableKind = "station"): MacroTick | null {
  if (dockedAt(obs.flightStatus, { kind, id: stationID })) {
    return null; // arrived
  }
  const travel = obs.travel ?? null;
  // Only a failure on THIS destination blocks — a stale reason left over from an
  // earlier route (or an abort the bot itself issued at start) must not.
  if (travel !== null && travel.failureReason !== null && travel.destinationStationID === stationID) {
    return tick(WAIT, travel.failureReason, phase, {
      kind: "blocked",
      reason: `The trip could not be finished: ${travel.failureReason}`,
    });
  }
  if (travel !== null && travel.status === "running" && travel.destinationStationID === stationID) {
    return tick(WAIT, "Flying there — the autopilot has the ship.", phase, ACTING, false);
  }
  return tick({ kind: "startRoute", stationID }, "Setting the destination and heading out.", phase, ACTING, false);
}

/**
 * Riding the shared autopilot to a SYSTEM, multi-system. Null once the ship is
 * in it. The station twin above keyed on `destinationStationID`; a system route
 * carries no station, so this one keys on `destinationSystemID` — reading the
 * wrong field would make every tick re-issue the route.
 */
function rideAutopilotToSystem(obs: ScriptObservation, systemID: number, phase: string): MacroTick | null {
  if (obs.flightStatus?.solarSystemID === systemID) {
    return null; // arrived
  }
  const travel = obs.travel ?? null;
  // Only a failure on THIS destination blocks — a stale reason left over from an
  // earlier route (or an abort the bot itself issued at start) must not.
  if (travel !== null && travel.failureReason !== null && travel.destinationSystemID === systemID) {
    return tick(WAIT, travel.failureReason, phase, {
      kind: "blocked",
      reason: `The trip could not be finished: ${travel.failureReason}`,
    });
  }
  if (travel !== null && travel.status === "running" && travel.destinationSystemID === systemID) {
    return tick(WAIT, "Flying there — the autopilot has the ship.", phase, ACTING, false);
  }
  return tick({ kind: "startSystemRoute", systemID }, "Setting the destination and heading out.", phase, ACTING, false);
}

// ── find-*-agent ─────────────────────────────────────────────────────────────
// Publish the search criteria (incl. the agent KIND) on the board; the flow runs
// the search and hands back the best match as obs.foundAgent; remember it for
// the blocks after. One factory, two blocks: delivery and combat agents.
function makeFindAgent(kindWord: string, finderKind: string): MacroDecider {
  return (step, obs, _mem, board) => {
    if (boardNum(board, "agentID") !== null) {
      return tick(WAIT, "An agent is already picked for this run.", "Finding an agent", { kind: "done" });
    }
    const found = obs.foundAgent ?? null;
    if (found !== null) {
      return {
        ...tick(WAIT, `Found a ${kindWord} agent to work with.`, "Finding an agent", { kind: "done" }),
        boardPatch: {
          agentID: found.agentID,
          agentStationID: found.stationID,
          agentName: found.name,
          agentStationName: found.stationName,
          ...(found.level === undefined ? {} : { agentLevel: found.level }),
        },
      };
    }
    if (finderKind === "courier" && obs.agentSearchFailure) {
      return tick(WAIT, obs.agentSearchFailure, "Finding an agent", {
        kind: "blocked", reason: obs.agentSearchFailure,
      });
    }
    // Publish the criteria (once) so the flow's next read can run the search.
    return {
      ...tick(WAIT, `Searching for a ${kindWord} agent.`, "Finding an agent", ACTING, false),
      boardPatch: {
        findKind: finderKind,
        findLevel: countArg(step, "level") ?? 1,
        ...(finderKind === "courier" ? { findFallback: step.args["fallback"]?.kind === "toggle" && step.args["fallback"].enabled ? 1 : 0 } : {}),
        findMaxJumps: countArg(step, "maxJumps"),
        findCorpID: (() => {
          const corp = step.args["corporation"];
          return corp !== undefined && corp.kind === "corp" ? corp.id : null;
        })(),
      },
    };
  };
}
const distributionFinder = makeFindAgent("delivery", "courier");
const findDistributionAgent: MacroDecider = (step, obs, mem, board) => {
  const level = step.args["level"];
  const fallback = step.args["fallback"];
  const corp = step.args["corporation"];
  if ((level && (level.kind !== "count" || !Number.isSafeInteger(level.value) || level.value < 1 || level.value > 4)) ||
      (fallback && (fallback.kind !== "toggle" || typeof fallback.enabled !== "boolean")) ||
      (corp && (corp.kind !== "corp" || !Number.isSafeInteger(corp.id) || corp.id === null || corp.id <= 0))) {
    return tick(WAIT, "Distribution agent configuration is invalid.", "Finding an agent", {
      kind: "blocked", reason: "Choose a level from 1 to 4 and resolve the fallback and corporation settings.",
    });
  }
  return distributionFinder(step, obs, mem, board);
};
const findCombatAgent: MacroDecider = makeFindAgent("combat", "encounter");

// ── request-mission ──────────────────────────────────────────────────────────
// Fly to the agent's station, dock, and press Request. Done when an offer (or an
// already-accepted mission) is on the table.
const requestMission: MacroDecider = (step, obs, mem, board) => {
  const agentID = stepAgentID(step, board);
  if (agentID === null) {
    return tick(WAIT, "No agent picked or found.", "Asking for work", {
      kind: "blocked",
      reason: "Put a Find-an-agent block before this one, or pick an agent on this step.",
    });
  }
  // An override pick lands on the board so the later blocks use the same agent.
  const patch: Record<string, number | string | null> =
    boardNum(board, "agentID") === agentID ? {} : { agentID };
  if (missionAccepted(obs.journal ?? null, agentID) === true) {
    return { ...tick(WAIT, "A mission is already accepted.", "Asking for work", { kind: "done" }), boardPatch: patch };
  }
  const agentStationID = boardNum(board, "agentStationID");
  if (agentStationID !== null) {
    const ride = rideAutopilotTo(obs, agentStationID, "Flying to the agent");
    if (ride !== null) {
      return { ...ride, boardPatch: patch };
    }
  } else if (obs.flightStatus?.docked === true && obs.flightStatus.stationID !== null) {
    // No station known for a hand-picked agent: assume they are at THIS station
    // (the practical case), and remember it as the return point.
    patch["agentStationID"] = obs.flightStatus.stationID;
  } else {
    return tick(WAIT, "This step needs to start docked with its agent when the agent was picked by hand.", "Asking for work", {
      kind: "blocked",
      reason: "Dock at the picked agent's station first, or use a Find-an-agent block.",
    });
  }
  if (obs.briefing !== undefined && obs.briefing !== null) {
    return { ...tick(WAIT, "The agent has an offer on the table.", "Asking for work", { kind: "done" }), boardPatch: patch };
  }
  const conversation = obs.conversation ?? null;
  if (conversation === null) {
    return { ...tick(WAIT, "Talking to the agent.", "Asking for work", ACTING, false), boardPatch: patch };
  }
  const requestID = agentActionID(conversation, AGENT_BUTTON.REQUEST_MISSION);
  if (requestID === null) {
    return { ...tick(WAIT, "Waiting for the agent to offer work.", "Asking for work", ACTING, false), boardPatch: patch };
  }
  const asked = (num(mem, "asked") ?? 0) + 1;
  if (asked > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The agent kept not offering a mission.", "Asking for work", {
      kind: "blocked",
      reason: "The agent would not offer a mission after several asks.",
    });
  }
  return {
    ...tick(
      { kind: "agentButton", agentID, actionID: requestID, label: "Request Mission" },
      "Asking the agent for a mission.",
      "Asking for work",
      ACTING,
      false,
      { asked },
    ),
    boardPatch: patch,
  };
};

// ── accept-mission ───────────────────────────────────────────────────────────
// Gate the offer (cargo fits, trip length), then Accept — or Decline and ask
// again, bounded. Done once the journal says the mission is accepted.
/**
 * Why this offer cannot be JUDGED yet, or null when every reading it needs is in.
 *
 * Only the blind cases live here. "The cargo will not fit" and "that is further
 * than your limit" are real verdicts and stay in `gateOffer`; these are the ones
 * where the bot has simply not been told yet, and the honest answer is to wait a
 * tick rather than throw the job away.
 */
function unreadableOffer(
  briefing: ScriptObservation["briefing"] | null,
  obs: ScriptObservation,
  maxJumps: number | null,
): string | null {
  if (briefing === null || briefing === undefined) {
    return null; // no offer on the table at all — the caller asks for one
  }
  const isCourier = briefing.cargoTypeID !== null;
  if (isCourier) {
    if (briefing.cargoVolume === null) {
      return "Waiting for the offer to say how big the cargo is.";
    }
    if (cargoRoom(obs.cargo ?? null) === null) {
      return "Waiting for the ship to report its cargo hold.";
    }
  }
  // The jump gate is only owed a reading when the player actually set a ceiling.
  if (maxJumps !== null && briefing.destinationSystemID !== null && (obs.jumpsToDropoff ?? null) === null) {
    return "Waiting for a route to the delivery point.";
  }
  return null;
}

const acceptMission: MacroDecider = (step, obs, mem, board) => {
  const agentID = stepAgentID(step, board);
  if (agentID === null) {
    return tick(WAIT, "No agent picked or found.", "Accepting", {
      kind: "blocked",
      reason: "Put a Find-an-agent block before this one, or pick an agent on this step.",
    });
  }
  if (missionAccepted(obs.journal ?? null, agentID) === true) {
    const briefing = obs.briefing ?? null;
    return {
      ...tick(WAIT, "The mission is accepted.", "Accepting", { kind: "done" }),
      boardPatch: {
        cargoTypeID: briefing?.cargoTypeID ?? null,
        cargoQuantity: briefing?.cargoQuantity ?? null,
        pickupStationID: briefing?.pickupLocationID ?? null,
        dropoffStationID: briefing?.destinationLocationID ?? null,
      },
    };
  }
  const conversation = obs.conversation ?? null;
  const briefing = obs.briefing ?? null;
  if (conversation === null) {
    return tick(WAIT, "Talking to the agent.", "Accepting", ACTING, false, mem);
  }
  const rounds = num(mem, "rounds") ?? 0;
  if (rounds > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "No acceptable offer after several tries.", "Accepting", {
      kind: "blocked",
      reason: "The agent kept offering jobs outside your limits, so the bot stopped.",
    });
  }
  const maxJumps = countArg(step, "maxJumps");
  // ⚠ A READING WE DO NOT HAVE IS NOT A REASON TO TURN A JOB DOWN. Declining is
  // an irreversible act against the agent — it burns the offer and starts a
  // decline timer — so it must never be the answer to "I could not see".
  //
  // Watched live 2026-07-26: the first tick after docking gated on a cargo hold
  // that had not been read yet and the bot DECLINED a perfectly good courier
  // job, reason "Your ship did not report how much room its cargo hold has".
  // `gateOffer` folds cannot-tell and fails-the-gate into one string, which is
  // fine for a readout and wrong for a decision, so the unreadable cases are
  // pulled out here and answered with a WAIT instead.
  //
  // Bounded like everything else: the wait spends a round, so a reading that
  // never arrives ends as a blocked step with its own reason rather than a
  // silent forever-wait.
  const blind = unreadableOffer(briefing, obs, maxJumps);
  if (blind !== null) {
    if (rounds >= MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, blind, "Accepting", {
        kind: "blocked",
        reason: `The bot could not read enough to judge the offer: ${blind}`,
      });
    }
    return tick(WAIT, blind, "Accepting", ACTING, false, { ...mem, rounds: rounds + 1 });
  }
  if (briefing !== null) {
    // A COURIER offer names cargo and gets the full volume + jumps gate; an
    // ENCOUNTER offer names none, so only the player's jump ceiling applies.
    const hasCargo = briefing.cargoTypeID !== null && briefing.cargoVolume !== null;
    // ⚠ NO CEILING MEANS THE ROUTE DOES NOT MATTER. `gateOffer` turns a job down
    // when it has no jump count at all — right when a limit is in play, wrong
    // when there is none, because then the number was never going to be used.
    // A stand-in 0 against an unbounded ceiling keeps that gate out of the way
    // instead of declining a job over a number nobody asked about.
    const jumpsForGate = maxJumps === null ? 0 : (obs.jumpsToDropoff ?? null);
    const reason = hasCargo
      ? gateOffer(briefing, obs.cargo ?? null, jumpsForGate, {
          agentID,
          agentName: null,
          agentStationID: 0,
          agentStationName: null,
          maxJumps: maxJumps ?? Number.MAX_SAFE_INTEGER,
          maxMissions: 0,
        })
      : (maxJumps !== null && obs.jumpsToDropoff !== undefined && obs.jumpsToDropoff !== null && obs.jumpsToDropoff > maxJumps
          ? `The job is ${obs.jumpsToDropoff} jumps away and you set a limit of ${maxJumps}, so the bot turned it down.`
          : null);
    if (reason === null) {
      const acceptID = agentActionID(conversation, AGENT_BUTTON.ACCEPT) ?? agentActionID(conversation, AGENT_BUTTON.ACCEPT_REMOTELY);
      if (acceptID === null) {
        return tick(WAIT, "The offer has no way to accept it yet.", "Accepting", ACTING, false, mem);
      }
      return tick(
        { kind: "agentButton", agentID, actionID: acceptID, label: "Accept" },
        "Taking the job.",
        "Accepting",
        ACTING,
        false,
        { rounds: rounds + 1 },
      );
    }
    // The offer fails a gate: turn it down, then ask for another.
    const declineID = agentActionID(conversation, AGENT_BUTTON.DECLINE);
    if (declineID !== null) {
      return tick(
        { kind: "agentButton", agentID, actionID: declineID, label: "Decline" },
        reason,
        "Accepting",
        ACTING,
        false,
        { rounds: rounds + 1 },
      );
    }
    return tick(WAIT, reason, "Accepting", ACTING, false, { rounds: rounds + 1 });
  }
  // No offer on the table — ask for one (covers the after-a-decline case).
  const requestID = agentActionID(conversation, AGENT_BUTTON.REQUEST_MISSION);
  if (requestID !== null) {
    return tick(
      { kind: "agentButton", agentID, actionID: requestID, label: "Request Mission" },
      "Asking for another offer.",
      "Accepting",
      ACTING,
      false,
      { rounds: rounds + 1 },
    );
  }
  return tick(WAIT, "Waiting for the agent's offer.", "Accepting", ACTING, false, mem);
};

// ── load-mission-cargo ───────────────────────────────────────────────────────
// Move the package from the pickup hangar into the ship, and confirm it is
// really aboard before calling itself done — never trusting the 200.
const loadMissionCargo: MacroDecider = (_step, obs, mem, board) => {
  const briefing = obs.briefing ?? null;
  const typeID = briefing?.cargoTypeID ?? boardNum(board, "cargoTypeID");
  const quantity = briefing?.cargoQuantity ?? boardNum(board, "cargoQuantity");
  if (typeID === null || quantity === null) {
    return tick(WAIT, "No mission cargo to load.", "Loading cargo", {
      kind: "blocked",
      reason: "There is no accepted mission naming cargo to load — accept one first.",
    });
  }
  if (packageAboard(obs.cargo ?? null, briefing) === true) {
    return tick(WAIT, "The mission cargo is aboard.", "Loading cargo", { kind: "done" });
  }
  const pickup = briefing?.pickupLocationID ?? boardNum(board, "pickupStationID");
  if (pickup !== null) {
    const ride = rideAutopilotTo(obs, pickup, "Flying to the pickup");
    if (ride !== null) {
      return ride;
    }
  }
  const attempts = num(mem, "attempts") ?? 0;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not load.", "Loading cargo", {
      kind: "blocked",
      reason: "The mission cargo could not be moved aboard after several tries.",
    });
  }
  const stack = findPackageStack(obs.stationHangar ?? null, typeID, quantity);
  if (stack.item === null) {
    return tick(WAIT, "Looking for the mission package in the hangar.", "Loading cargo", ACTING, false, {
      attempts: attempts + 1,
    });
  }
  return tick(
    { kind: "loadMissionCargo", typeID, quantity },
    stack.sure ? "Moving the package into the ship." : "Moving what looks like the package into the ship.",
    "Loading cargo",
    ACTING,
    false,
    { attempts: attempts + 1 },
  );
};

// ── travel-to-dropoff ────────────────────────────────────────────────────────
const travelToDropoff: MacroDecider = (_step, obs, _mem, board) => {
  const dropoff = (obs.briefing ?? null)?.destinationLocationID ?? boardNum(board, "dropoffStationID");
  if (dropoff === null) {
    return tick(WAIT, "No delivery destination.", "Flying the delivery", {
      kind: "blocked",
      reason: "There is no accepted mission naming a drop-off station.",
    });
  }
  const ride = rideAutopilotTo(obs, dropoff, "Flying the delivery");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Docked at the drop-off.", "Flying the delivery", { kind: "done" });
};

// ── turn-in-mission ──────────────────────────────────────────────────────────
// At the drop-off: put the package in the hangar, then tell the agent. Done only
// when the agent's own answer says the mission completed.
function missionCargoQuantity(rows: readonly { typeID: number; quantity: number }[], typeID: number): number | null {
  let total = 0;
  for (const row of rows.filter(row => row.typeID === typeID)) {
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0) return null;
    total += row.quantity;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

const turnInMission: MacroDecider = (_step, obs, mem, board) => {
  const agentID = boardNum(board, "agentID");
  if (agentID === null) {
    return tick(WAIT, "No agent for this run.", "Turning in", {
      kind: "blocked",
      reason: "This run has no agent to turn the mission in to.",
    });
  }
  const accepted = missionAccepted(obs.journal ?? null, agentID);
  if (accepted === false) {
    return tick(WAIT, "The mission is turned in.", "Turning in", { kind: "done" });
  }
  if (completed(obs.conversation ?? null)) {
    return tick(WAIT, "The agent confirmed the job is done.", "Turning in", { kind: "done" });
  }
  const attempts = num(mem, "attempts") ?? 0;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The mission would not complete.", "Turning in", {
      kind: "blocked",
      reason: "The agent kept not completing the mission, so the bot stopped.",
    });
  }
  if (accepted === null) return tick(WAIT, "Reading the accepted mission.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
  // Move only the remaining requirement, including goods already ashore. Each
  // split is one stack and must appear in BOTH authoritative inventory views
  // before another split is offered; an acknowledged call can settle late.
  const typeID = boardNum(board, "cargoTypeID");
  if (board["cargoTypeID"] !== null) {
    const quantity = boardNum(board, "cargoQuantity");
    const dropoff = boardNum(board, "dropoffStationID");
    if (typeID === null || !Number.isSafeInteger(typeID) || typeID <= 0 ||
        quantity === null || !Number.isSafeInteger(quantity) || quantity <= 0 ||
        dropoff === null || !Number.isSafeInteger(dropoff) || dropoff <= 0) {
      return tick(WAIT, "The courier requirement is unreadable or invalid.", "Turning in", {
        kind: "blocked", reason: "The bot needs a confirmed cargo type, positive whole quantity, and drop-off station before delivering mission cargo.",
      }, false, mem);
    }
    if (!dockedAt(obs.flightStatus, { kind: "station", id: dropoff })) {
      return tick(WAIT, "Waiting to dock at the mission drop-off.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
    }
    if (obs.cargo == null || obs.stationHangar == null) {
      return tick(WAIT, "Reading the cargo and destination hangar.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
    }
    const aboard = missionCargoQuantity(obs.cargo.rows, typeID);
    const ashore = missionCargoQuantity(obs.stationHangar, typeID);
    if (aboard === null || ashore === null) {
      return tick(WAIT, "The mission inventory quantities are unreadable.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
    }
    const pending = num(mem, "deliveryPendingQuantity");
    if (pending !== null) {
      if (aboard !== (num(mem, "deliveryCargoBefore") ?? NaN) - pending ||
          ashore !== (num(mem, "deliveryHangarBefore") ?? NaN) + pending) {
        const waited = (num(mem, "deliveryWaited") ?? 0) + 1;
        if (waited > MAX_BLOCK_ATTEMPTS * 2) return tick(WAIT, "The cargo handoff could not be confirmed.", "Turning in", {
          kind: "blocked", reason: "The cargo and hangar did not confirm the requested mission delivery, so the bot stopped without moving surplus cargo.",
        }, false, mem);
        return tick(WAIT, "Waiting for the mission cargo handoff to settle.", "Turning in", ACTING, false, { ...mem, deliveryWaited: waited });
      }
      mem = { ...mem, deliveryPendingQuantity: null, deliveryWaited: 0 };
    }
    const remaining = Math.max(0, quantity - ashore);
    if (remaining > aboard) {
      return tick(WAIT, "There is not enough mission cargo aboard to finish the delivery.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
    }
    if (remaining > 0) {
      const stacks = obs.cargo.rows.filter(row => row.typeID === typeID && row.quantity > 0);
      const stack = stacks.find(row => row.quantity === remaining) ?? stacks.find(row => row.quantity > remaining) ??
        [...stacks].sort((a, b) => b.quantity - a.quantity)[0]!;
      const moved = Math.min(remaining, stack.quantity);
      return tick(
        { kind: "unloadMissionCargo", itemIDs: [stack.itemID], quantity: moved },
        "Handing the cargo over.",
        "Turning in",
        ACTING,
        false,
        { ...mem, attempts: attempts + 1, deliveryPendingQuantity: moved, deliveryCargoBefore: aboard,
          deliveryHangarBefore: ashore, deliveryWaited: 0 },
      );
    }
  }
  const conversation = obs.conversation ?? null;
  if (conversation === null) {
    return tick(WAIT, "Telling the agent.", "Turning in", ACTING, false, { ...mem, attempts: attempts + 1 });
  }
  const completeID = completeActionID(conversation);
  if (completeID === null) {
    return tick(WAIT, "The agent is not offering to complete the job yet.", "Turning in", ACTING, false, {
      ...mem, attempts: attempts + 1,
    });
  }
  return tick(
    { kind: "agentButton", agentID, actionID: completeID, label: "Complete Mission" },
    "Turning the mission in.",
    "Turning in",
    ACTING,
    false,
    { ...mem, attempts: attempts + 1 },
  );
};

// ── wait ─────────────────────────────────────────────────────────────────────
// A plain delay: do nothing for N seconds (default 10), counted in ticks off the
// runner's own cadence — no clock reads, so it is pure and testable. ARMED from
// tick one, so a player's `until` ("stop when shields are back over 80%") can end
// it early — which turns the same block into "wait for X".
const SCRIPT_TICK_SECONDS = 2; // must match scriptRunner's SCRIPT_CADENCE_MS
const waitBlock: MacroDecider = (step, _obs, mem) => {
  const seconds = countArg(step, "seconds") ?? 10;
  const needed = Math.max(1, Math.ceil(seconds / SCRIPT_TICK_SECONDS));
  const ticked = (num(mem, "ticked") ?? 0) + 1;
  if (ticked >= needed) {
    return tick(WAIT, "Done waiting.", "Waiting", { kind: "done" });
  }
  const remaining = Math.max(0, seconds - ticked * SCRIPT_TICK_SECONDS);
  return tick(WAIT, `Waiting — about ${remaining} seconds left.`, "Waiting", ACTING, true, { ticked });
};

// ── unload-cargo ─────────────────────────────────────────────────────────────
// Docked: move everything the ship is CARRYING into the station hangar — the
// cargo hold and every specialised freight bay, each from its own place.
//
// ⚠ IT IS NOT ONLY THE CARGO HOLD, AND THAT IS THE WHOLE FIX. This block used
// to read `obs.cargo` alone, which was fine while loot went nowhere else. Once
// `transferLootedRows` started routing ore into the ore hold, a hauler's freight
// stopped being reachable by the one block meant to unload it: the ore hold
// filled, `cargo-full` (which measures the CARGO hold) never tripped, the loop
// never ended, and every further scoop was refused for want of room. Whatever
// `FREIGHT_BAYS` lets a bot fill, this block has to be able to empty, or the
// same trap just moves one bay over.
//
// ⚠ WHAT IT WILL NOT TOUCH: the ship's KIT. Drones, fuel, ammo, fighters,
// subsystems and the hulls in a maintenance bay are not freight, and a block
// that stripped them would turn a drop-off into a stranding. `FREIGHT_BAYS`
// draws that line; this block never widens it.
//
// Done only when a fresh read shows nothing left — and a hold that could not be
// READ never counts as an empty one, so an unreadable ship reports blocked
// rather than quietly passing for unloaded.
const unloadCargo: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked, so there is no hangar to unload into.", "Emptying the hold", {
      kind: "blocked",
      reason: "Dock at a station first — this block empties your cargo into its hangar.",
    });
  }
  const cargo = obs.cargo ?? null;
  const bays = obs.shipBays ?? null;
  // Bays this step must leave alone. The ammo hold on a combat hull and the fuel
  // bay on a jump-capable one are freight to a hauler and the ship's own kit to
  // everything else, and nothing about the bay itself says which.
  const exceptArg = step.args["exceptBays"];
  const except = new Set<string>(
    exceptArg !== undefined && exceptArg.kind === "bayList" ? exceptArg.bays : [],
  );
  // Items to leave aboard, whichever bay they are in. "move" on an unreadable
  // row: it lands in the station hangar, which is one drag from undone, and
  // holding back what cannot be classified would stall the empty check for ever.
  const keep = keepRules(step);
  const groups: { readonly bay: string | null; readonly itemIDs: readonly number[] }[] = [];
  const cargoRows = cargo === null ? [] : movableRows(cargo.rows, keep, "move");
  if (cargoRows.length > 0) {
    groups.push({ bay: null, itemIDs: cargoRows.map((row) => row.itemID) });
  }
  for (const bay of bays ?? []) {
    if (bay.present !== true || !FREIGHT_BAYS.has(bay.key) || except.has(bay.key)) {
      continue;
    }
    const items = movableRows(bay.items ?? [], keep, "move");
    if (items.length > 0) {
      groups.push({ bay: bay.key, itemIDs: items.map((row) => row.itemID) });
    }
  }
  if (groups.length > 0) {
    const attempts = (num(mem, "attempts") ?? 0) + 1;
    if (attempts > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "The cargo would not move.", "Emptying the hold", {
        kind: "blocked",
        reason: "The station kept refusing the cargo, so the bot stopped.",
      });
    }
    const into = step.args["into"];
    const division = into !== undefined && into.kind === "corpDivision" ? into.division : null;
    return tick(
      division === null ? { kind: "unloadHolds", groups } : { kind: "unloadHolds", groups, division },
      division === null
        ? "Moving what the ship is carrying into the hangar."
        : "Moving what the ship is carrying into the corporation hangar.",
      "Emptying the hold",
      ACTING,
      false,
      { ...mem, attempts },
    );
  }
  // Nothing to move that we can SEE. Only a ship we actually managed to read
  // end to end is an empty one — a failed cargo or bay read is "cannot tell",
  // and passing that off as "done" is the exact conflation that let a full ore
  // hold sail through this block in the first place.
  if (cargo === null || bays === null) {
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "The ship's holds could not be read.", "Emptying the hold", {
        kind: "blocked",
        reason: "The ship's holds could not be read, so the bot cannot tell whether it is empty.",
      });
    }
    return tick(WAIT, "Checking the ship's holds.", "Emptying the hold", ACTING, false, {
      ...mem,
      blindChecks,
    });
  }
  return tick(WAIT, "The ship is empty.", "Emptying the hold", { kind: "done" });
};

// ── load-cargo ───────────────────────────────────────────────────────────────
// Docked: unload-cargo run backwards. Take the named items out of the station
// hangar and put each stack where THIS hull wants it — the command centre hold,
// the planetary hold, the mining hold — with the cargo hold as the fallback for
// a stack no bay claims.
//
// ⚠ IT LOADS WHAT FITS AND THEN IT IS DONE. That is the whole block, and it is
// what makes a ten-trip haul a four-block loop instead of ten hand-written
// programs: an Epithal whose command centre hold takes six of the twenty in the
// hangar loads six, says so, and finishes. The fourteen left are not a failure
// and must never read as one — the next lap comes back for them.
//
// ⚠ IT SHARES THE LOOT SIDE'S PLANNER ON PURPOSE (`planLootTransfers`). The
// question "what of these rows can this hull take, and into which bay" is the
// same question whether the rows are in a jetcan or in a station hangar, and it
// is the question with all the sharp edges: the per-stack all-or-nothing rule
// that needs a SPLIT, the operator's "a full specialised bay does not fall
// through to cargo" rule, and the room-tracking that stops two stacks being
// promised the same cubic metre. A second copy would get one of those wrong.
//
// ⚠ A BAY NAMED IN `exceptBays` IS NOT A DESTINATION, AND ITS CARGO STAYS HOME.
// Treating it as merely absent would send the ammo a Hoarder was told to leave
// alone into the cargo hold instead, which is the fall-through the operator's
// rule forbids — so a row whose bays are ALL excluded is skipped entirely. A row
// that never had a specialised bay still goes to cargo, as it always did.
const loadCargo: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - there is no hangar to load from.", "Loading the ship", {
      kind: "blocked",
      reason: "Dock at a station first - this block loads your ship from its hangar.",
    });
  }
  const rules = itemRules(step, "items");
  if (rules.length === 0) {
    return tick(WAIT, "This step has nothing to load.", "Loading the ship", {
      kind: "blocked",
      reason: "Pick what this step loads - an item, everything of its kind, or a name to match.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  const bays = obs.shipBays ?? null;
  const names = obs.typeNames ?? null;
  // ⚠ A NAME RULE WITH NO NAMES READ IS "COULD NOT TELL", NOT "NOTHING MATCHED".
  // Without this the lookup failing would hand the block an empty selection, and
  // an empty selection is indistinguishable from a hangar that genuinely has
  // none of what was asked for — so the ship would fly the lap empty and the
  // player would be told the load was finished.
  const needsNames = rules.some((rule) => rule.match === "name");
  // "Could not read" is never "nothing to load". A hangar or a bay list that
  // failed to read leaves the ship sailing empty and the player none the wiser,
  // so it waits and then says so, exactly as the unload side does.
  if (hangar === null || bays === null || (needsNames && names === null)) {
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "The hangar or the holds could not be read.", "Loading the ship", {
        kind: "blocked",
        reason:
          needsNames && names === null
            ? "The names of what is in the hangar could not be read, so the bot cannot tell what matches."
            : "The hangar or the ship's holds could not be read, so the bot cannot tell what to load.",
      });
    }
    return tick(WAIT, "Reading what is in the hangar.", "Loading the ship", ACTING, false, {
      ...mem,
      blindChecks,
    });
  }
  const named = hangar.map((row) => ({ ...row, name: names?.[row.typeID] ?? null }));
  // "skip": a row nobody could classify stays in the hangar, where it already
  // safely is. The opposite of the unload side's "move", and for the same
  // reason — which way a shrug is safe depends on where the stack ends up.
  const wanted = pickedRows(named, rules, "skip");
  const except = new Set<string>(bayListArg(step, "exceptBays"));
  // An excluded bay is no longer a destination, so the planner must not see it
  // as present; a row whose whole chain is excluded is dropped here rather than
  // being allowed to fall through to cargo.
  const usableBays = bays.map((bay) =>
    except.has(bay.key) ? { ...bay, present: false as boolean | null } : bay,
  );
  const rows = wanted.filter((row) => {
    const preferred = preferredBays(row);
    return preferred.length === 0 || preferred.some((key) => !except.has(key));
  });
  const cargoFree = holdFreeM3(obs.cargo?.capacity ?? null);
  const freeFor = (key: string | null): number | null => {
    if (key === null) {
      return cargoFree;
    }
    const bay = usableBays.find((entry) => entry.key === key) ?? null;
    return bay === null ? null : holdFreeM3(bay.capacity);
  };
  const groups = planLootTransfers(rows, usableBays, freeFor);
  if (groups.length === 0) {
    // Three different worlds end here and the words have to tell them apart, or
    // a player watching a bot fly off empty cannot tell a finished load from a
    // selection that matched nothing.
    const said =
      wanted.length === 0
        ? "None of that is in the hangar."
        : rows.length === 0
          ? "What is here only belongs in a hold this step was told to leave alone."
          : "The ship is as full as it can get.";
    return tick(WAIT, said, "Loading the ship", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not load.", "Loading the ship", {
      kind: "blocked",
      reason: "The station kept refusing to load that cargo, so the bot stopped.",
    });
  }
  return tick(
    { kind: "loadHolds", groups },
    "Loading the ship from the hangar.",
    "Loading the ship",
    ACTING,
    false,
    { ...mem, attempts },
  );
};

// ── return-to-agent ──────────────────────────────────────────────────────────
const returnToAgent: MacroDecider = (_step, obs, _mem, board) => {
  const station = boardNum(board, "agentStationID");
  if (station === null) {
    return tick(WAIT, "No agent station to return to.", "Heading back", {
      kind: "blocked",
      reason: "This run has no remembered agent station to go back to.",
    });
  }
  const ride = rideAutopilotTo(obs, station, "Heading back to the agent");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Back at the agent's station.", "Heading back", { kind: "done" });
};

// ── salvage-wrecks / loot-wrecks ─────────────────────────────────────────────

const LOOT_RANGE_M = 2400; // open a wreck inside retail's 2,500 m, with margin
const SALVAGE_RANGE_M = 4500; // run a salvager inside its ~5-6 km range

function wrecksOnGrid(snapshot: SpaceSnapshot | null): readonly SpaceEntity[] {
  return (snapshot?.entities ?? []).filter((e) => e.kind === "wreck");
}

/** A wreck that is YOURS to open — owned by you or your corp. Unknown owner = NO. */
function isOwnWreck(wreck: SpaceEntity, obs: ScriptObservation): boolean {
  const me = obs.myCharacterID ?? null;
  const corp = obs.myCorporationID ?? null;
  if (wreck.ownerID === null) {
    return false; // cannot tell whose it is — never open it
  }
  return (me !== null && wreck.ownerID === me) || (corp !== null && wreck.ownerID === corp);
}

/**
 * What the ledger says about this step's lock presses, against the count the
 * block last committed (`lockRefusalsSeen`).
 *
 * ⚠ A REFUSED LOCK COMMITS NOTHING (2fd4a77), so a `lockIssued` written by the
 * pressing tick is not there to read after a refusal: a block that waits on
 * that flag to give up presses again on every backoff instead, until the
 * runner's ten-refusal cap sends the ship home. The ledger is what it can read.
 *
 * The record is keyed by step and action with NO target and lives until a lock
 * in the same step succeeds, so the count a block carries is "the count as of
 * the last tick that was committed": a press carries 0 (it is committed only
 * when it succeeded, which is also what clears the record) and a wait tick that
 * has read a refusal carries the count it read.
 *
 * ⚠ NO COUNT CARRIED AND A RECORD ON THE LEDGER IS AMBIGUOUS, AND IT IS READ AS
 * OLD. It is either left over from an earlier visit (step memory is dropped
 * when a step is left, the ledger is not) or this visit's very first press,
 * refused. Reading a leftover as fresh would hold the block off a lock it never
 * asked for — in a fight, sixteen seconds of not shooting — so `unread` has the
 * block commit the count with one wait tick and press. A first press that
 * really was refused costs one more before it is believed; every later one is
 * believed at once.
 */
function readLockRefusals(step: MacroStep, obs: ScriptObservation, mem: MacroMemory): LockRefusals {
  const record = refusalFor(obs.refusals, step.id, "lock", null);
  const count = record?.count ?? 0;
  const seen = num(mem, "lockRefusalsSeen");
  return { count, unread: seen === null && count > 0, fresh: seen !== null && count > seen,
    ...(record?.targetID === undefined ? {} : { targetID: record.targetID }) };
}

// Salvage the grid, nearest wreck first: lock it, send the salvage drones at it,
// run any fitted salvagers on it. Done (drones home) when no wrecks remain.
// Salvaging any wreck is legal — only LOOTING is gated.
const salvageWrecks: MacroDecider = (step, obs, mem) => {
  const lockRefusals = readLockRefusals(step, obs, mem);
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Salvaging", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Salvaging", ACTING, false, mem);
  }
  const wrecks = wrecksOnGrid(snapshot);
  const roster = droneRoster(obs, "salvage");
  if (wrecks.length === 0) {
    // Swept clean — bring the drones home before finishing (never abandon them).
    if (roster.out.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: roster.out }, "All salvaged — calling the drones home.", "Salvaging", ACTING);
    }
    return tick(WAIT, "Nothing left to salvage.", "Salvaging", { kind: "done" });
  }

  if (roster.roleOut.length === 0) {
    // None out: get the salvage drones (and ONLY them) out of the bay. Combat
    // drones still out from the fight before hold the slots, so they are called
    // in first — see launchRoleDrones.
    const launch = launchRoleDrones(obs, mem, "Salvaging", "salvage", "Launching the salvage drones.");
    if (launch.tick !== null) {
      return launch.tick;
    }
    mem = launch.mem;
  }

  const salvagers = obs.salvageModuleIDs ?? [];
  const dronesOut = roster.roleOut.length > 0;
  if (salvagers.length === 0 && !dronesOut) {
    if (roster.roleBay.length > 0 && !launchStalled(mem)) {
      return tick(WAIT, "Waiting for the other drones to come home so the salvage drones can go out.", "Salvaging", ACTING, true, mem);
    }
    // No way to salvage is not a reason to stop the whole program — a ratting
    // hull with no salvager still has looting and the next den to get on with.
    // SKIPPED, not blocked: the orchestrator warns once and moves on. The
    // reason names an unreadable bay stack rather than calling the bay empty,
    // so a failed group lookup is visible instead of masquerading as "no drones".
    const unread = (obs.unclassifiedDroneBayItemIDs ?? []).length;
    return tick(WAIT, "No way to salvage — moving on.", "Salvaging", {
      kind: "skipped",
      reason:
        roster.roleBay.length > 0
          ? "The salvage drones could not be launched."
          : roster.othersOut.length > 0
            ? "The drones out cannot salvage, and this ship has no salvage drones in the bay and no salvager fitted."
            : unread > 0
              ? `This ship has no salvager fitted, and ${unread === 1 ? "a drone" : `${unread} drones`} in the bay could not be identified, so none were launched.`
              : "This ship has no salvage drones in the bay and no salvager fitted.",
    });
  }

  // One wreck at a time, the way a pilot does it: pick it, lock it, send the
  // salvage drones at it and run the salvagers on it. The mine block's shape on
  // a wreck.
  //
  // ⚠ THE DRONES ARE SENT AT THE LOCKED WRECK BY ID, NEVER ON AUTO-PICK. The
  // server's auto-pick (`CmdSalvage` with target 0) only takes wrecks owned by
  // the pilot or a CURRENT fleet mate, so a fleet that had dropped, or a field
  // another pilot killed, left every salvage drone launched and idle for hours
  // while this block said they were working. A named wreck may be anyone's.
  const measurement = measureSpace(snapshot);
  const passedRaw = mem["passedWrecks"];
  const passed = new Set<number>(Array.isArray(passedRaw) ? (passedRaw as number[]) : []);
  const candidates = wrecks.filter((w) => !passed.has(w.itemID));
  let wreckID = num(mem, "wreckID");
  if (wreckID !== null && !candidates.some((w) => w.itemID === wreckID)) {
    wreckID = null; // it salvaged away — pick the next
  }
  if (wreckID === null) {
    if (candidates.length === 0) {
      // Every wreck left would not lock. Finish rather than re-lock the same
      // wrecks forever; the drones come home first, as on a clean grid.
      if (roster.out.length > 0) {
        return tick({ kind: "recallDrones", droneIDs: roster.out }, "The wrecks left would not lock — calling the drones home.", "Salvaging", ACTING);
      }
      return tick(WAIT, "The wrecks left would not lock.", "Salvaging", { kind: "done" });
    }
    const pick = nearest(candidates, measurement);
    if (pick === null) {
      return tick(WAIT, "Nothing pickable to salvage.", "Salvaging", ACTING, true, { ...mem, wreckID: null });
    }
    const picked = clearCloseInStall({ ...mem, wreckID: pick.itemID, lockIssued: false, waited: 0, dronesOn: null });
    if (salvagers.length > 0) {
      return tick({ kind: "approach", targetID: pick.itemID }, "Closing in on a wreck.", "Salvaging", ACTING, true, picked);
    }
    // Drones only: the drones fly to the wreck, the ship only needs to lock it.
    wreckID = pick.itemID;
    mem = picked;
  }
  const dist = measurement?.distances.get(wreckID) ?? Number.POSITIVE_INFINITY;
  // Salvagers need the ship inside their range; drones only need the lock.
  // An unreadable lock range is no gate: the bounded lock wait is the backstop.
  const lockRange = obs.maxTargetRangeM ?? null;
  const reach = salvagers.length > 0 ? SALVAGE_RANGE_M : lockRange;
  if (reach !== null && dist > reach && salvagers.length === 0 && num(mem, "approachedWreckID") !== wreckID) {
    return tick(
      { kind: "approach", targetID: wreckID },
      "Closing in on the wreck to lock it.",
      "Salvaging",
      ACTING,
      true,
      clearCloseInStall({ ...mem, approachedWreckID: wreckID }),
    );
  }
  if (reach !== null && dist > reach) {
    // ⚠ NEVER A BARE WAIT HERE. Until this rung existed, an approach the server
    // accepted and ignored left this block saying "flying to the wreck" for as
    // long as the wreck was on grid — the hull motionless (or flying a straight
    // line away from the site), the salvager never in range, and the operator
    // reading a flight that was not happening. See `closeInStall.ts`.
    const stall = closeInStall(measurement?.shipMode ?? null, mem);
    mem = stall.mem;
    if (stall.step === "reorder") {
      return tick({ kind: "approach", targetID: wreckID }, STALL_REORDER_WHY, "Salvaging", ACTING, true, mem);
    }
    if (stall.step === "unstick") {
      return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, "Salvaging", ACTING, true, mem);
    }
    if (stall.step === "stuck") {
      return tick(WAIT, STALL_STUCK_WHY, "Salvaging", { kind: "blocked", reason: STALL_STUCK_REASON });
    }
    return tick(WAIT, "Flying to the wreck.", "Salvaging", ACTING, true, mem);
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(wreckID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      // See `readLockRefusals`: the flag below is never set by a press that was
      // refused, so the refusal is read here, before pressing again.
      if (lockRefusals.unread) {
        return tick(WAIT, "Checking the last lock.", "Salvaging", ACTING, true, { ...mem, lockRefusalsSeen: lockRefusals.count });
      }
      if (lockRefusals.fresh && refusalTargets(lockRefusals, wreckID)) {
        // The timed wait below, exactly what a refused lock got before 2fd4a77.
        return tick(WAIT, "Waiting for the lock.", "Salvaging", ACTING, true, {
          ...mem,
          lockIssued: true,
          waited: 0,
          lockRefusalsSeen: lockRefusals.count,
        });
      }
      return tick({ kind: "lock", targetID: wreckID }, "Locking the wreck.", "Salvaging", ACTING, true, {
        ...mem,
        lockIssued: true,
        waited: 0,
        lockRefusalsSeen: 0,
      });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That wreck would not lock — moving on.", "Salvaging", ACTING, true, {
        ...mem,
        wreckID: null,
        passedWrecks: [...passed, wreckID],
      });
    }
    return tick(WAIT, "Waiting for the lock.", "Salvaging", ACTING, true, { ...mem, waited });
  }
  // Locked: the salvage drones onto it, once per wreck. Re-sending the order
  // restarts the drone's salvage cycle, so it is never repeated on a beat.
  if (dronesOut && num(mem, "dronesOn") !== wreckID) {
    return tick(
      { kind: "salvageDrones", droneIDs: roster.roleOut, targetID: wreckID },
      "Sending the salvage drones to the wreck.",
      "Salvaging",
      ACTING,
      true,
      { ...mem, dronesOn: wreckID },
    );
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const nextSalvager = salvagers.find((id) => !active.has(id));
  if (nextSalvager !== undefined) {
    return tick(
      { kind: "activate", moduleID: nextSalvager, targetID: wreckID },
      "Running the salvager on the wreck.",
      "Salvaging",
      ACTING,
      true,
      mem,
    );
  }
  return tick(WAIT, "Salvaging the wreck.", "Salvaging", ACTING, true, mem);
};

// Loot YOUR OWN wrecks, nearest first: fly inside loot range, empty it, mark it,
// next. A wreck whose owner cannot be read is NEVER opened — that is the whole
// "no can flipping" rule, structural rather than polite.
const lootWrecks: MacroDecider = (step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Looting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Looting", ACTING, false, mem);
  }
  // ⚠ A FULL SHIP IS A FINISHED TRIP, NOT A FAILURE. With no room anywhere there
  // is nothing to attempt: reaching into a can regardless is the refusal loop
  // this block used to run, and stopping the whole bot over it (which the
  // refusal ledger rightly did) is not much better. `null` is "we could not
  // read the holds", which is never a verdict — the block carries on and lets
  // the transfer decide, as it always did.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return tick(WAIT, "The ship is full, so it is time to unload.", "Looting", { kind: "done" });
  }
  // ⚠ ONCE IS ENOUGH. "Nothing aboard will take this" is a fact about the SHIP,
  // not about the wreck in front of it: the hold with no room for this one has
  // no room for the next either. Proving it again on every target costs five
  // attempts and a growing backoff EACH, which is minutes of a bot doing
  // nothing and looking hung. The trip is over; go and unload.
  if (shipHasNoRoom(obs.refusals, step.id, "lootWreck")) {
    return tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", "Looting", { kind: "done" });
  }
  const lootedRaw = mem["looted"];
  const lootedBefore = new Set<number>(Array.isArray(lootedRaw) ? (lootedRaw as number[]) : []);

  // ⚠ MARK IT ON THE ANSWER, NOT ON THE ASKING. This block used to add a wreck
  // to `looted` the instant it issued the action, which believed a refused
  // transfer exactly as readily as a real one and moved on leaving the loot
  // sitting there. `lootContainers` was deliberately built to avoid that and
  // said so in its own comment; this block was never brought along.
  //
  // A wreck cannot use the container trick of reading "still on grid" as "still
  // has something in it" — an emptied wreck stays put — so the block does need
  // its own record. What it can do is write that record one tick LATER, once the
  // ledger has had a chance to say whether the attempt was refused.
  const attempted = num(mem, "attempted");
  const attemptWasRefused =
    attempted !== null && refusalFor(obs.refusals, step.id, "lootWreck", attempted) !== null;
  const looted =
    attempted !== null && !attemptWasRefused ? new Set([...lootedBefore, attempted]) : lootedBefore;
  const memBase: MacroMemory = { ...mem, looted: [...looted], attempted: null };

  const mine = wrecksOnGrid(snapshot).filter(
    (w) =>
      isOwnWreck(w, obs) &&
      !looted.has(w.itemID) &&
      !shouldSetAside(obs.refusals, step.id, "lootWreck", w.itemID, MAX_BLOCK_ATTEMPTS),
  );
  if (mine.length === 0) {
    return tick(WAIT, "Every wreck of yours here is emptied.", "Looting", { kind: "done" });
  }
  const measurement = measureSpace(snapshot);
  const target = nearest(mine, measurement);
  if (target === null) {
    return tick(WAIT, "Nothing reachable to loot.", "Looting", ACTING, true, memBase);
  }
  const dist = measurement?.distances.get(target.itemID) ?? Number.POSITIVE_INFINITY;
  // The gateway's own range check beats our arithmetic — see lootContainers.
  const unreachable = isUnreachable(obs.refusals, step.id, "lootWreck", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(memBase, "approaching") === target.itemID) {
      // The same stall ladder the salvage block runs, for the same reason: an
      // approach the bridge reported `ok` for is not evidence the hull moved.
      const stall = closeInStall(measurement?.shipMode ?? null, memBase);
      if (stall.step === "reorder") {
        return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, "Looting", ACTING, true, stall.mem);
      }
      if (stall.step === "unstick") {
        return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, "Looting", ACTING, true, stall.mem);
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, "Looting", { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return tick(WAIT, "Flying to your wreck.", "Looting", ACTING, true, stall.mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for your wreck.",
      "Looting",
      ACTING,
      true,
      clearCloseInStall({ ...memBase, approaching: target.itemID }),
    );
  }
  // In range: empty it, and remember only that it was ATTEMPTED. Whether it is
  // actually emptied is settled on the next tick, above.
  return tick(
    { kind: "lootWreck", wreckID: target.itemID },
    "Taking what's inside.",
    "Looting",
    ACTING,
    true,
    { ...memBase, approaching: null, attempted: target.itemID },
  );
};

// ── loot-containers ───────────────────────────────────────────────────────────

function containersOnGrid(snapshot: SpaceSnapshot | null): readonly SpaceEntity[] {
  return (snapshot?.entities ?? []).filter((e) => e.kind === "container");
}

// How long to keep checking an apparently-empty grid before believing it —
// generous on purpose. This block has nothing better to do than wait for a
// can that has not shown up yet, so there is no cost to giving the snapshot
// plenty of room to catch up rather than racing it.
const CONTAINER_SETTLE_TICKS = 30; // ~2s/tick elsewhere in this file -> roughly a minute

// Ordinary saved bots may choose all visible cans. An MCC hauler is narrower:
// only cans recorded from this operation's own miner jettison are eligible.
//
// ⚠ NOT MARKED DONE THE INSTANT IT IS ISSUED. flow.ts's lootContainer dispatch
// re-reads the transfer's own result, but nothing here ever saw it — so
// marking a can "looted" the moment the action went out (the old behaviour)
// believed a silently-declined transfer exactly as readily as a real one, and
// moved on leaving the ore sitting in an untouched can. A jetcan despawns the
// instant the SERVER sees it truly empty (any looter, not just this one — see
// jettisonRuntime.js's maybeExpireEmptySpaceContainer) — so "still on grid" IS
// "still has something in it", and re-targeting the same can next tick is
// exactly the retry a decline needs. Only a can that keeps refusing for
// MAX_BLOCK_ATTEMPTS running gets set aside, so a genuinely stuck one does not
// loop the block forever.
const lootContainers: MacroDecider = (step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  const operation = obs.miningOperation?.role === "HAULER" ? obs.miningOperation : null;
  const logisticsTarget = operation?.logisticsTarget ?? null;
  const assigned = logisticsTarget ?? operation?.currentTarget ?? null;
  if (operation && !assigned) return tick(WAIT, "Waiting for an owned hauling target.", "Waiting for target", ACTING, false, mem);
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Looting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Looting", ACTING, false, mem);
  }
  if (assigned) {
    if (assigned.claimedByOperationID !== operation?.operationID) {
      return tick(WAIT, "The operation no longer owns this hauling target.", "Target authority unavailable", ACTING, false, mem);
    }
    const atTarget = assigned.targetType === "BELT"
      ? (() => { const belt = snapshot.entities.find(row => row.name === assigned.targetName && /belt/i.test(row.name ?? ""));
          return belt !== undefined && beltTravelStep(belt, measureSpace(snapshot)) === "arrive"; })()
      : atMiningSite(snapshot.ship?.position, assigned);
    if (snapshot.solarSystemID !== assigned.systemID || !atTarget) {
      return tick(WAIT, "Returning to the operation's target travel block.", "Following operation target", { kind: "done" });
    }
  }
  // ⚠ A FULL SHIP IS A FINISHED TRIP, NOT A FAILURE. With no room anywhere there
  // is nothing to attempt: reaching into a can regardless is the refusal loop
  // this block used to run, and stopping the whole bot over it (which the
  // refusal ledger rightly did) is not much better. `null` is "we could not
  // read the holds", which is never a verdict — the block carries on and lets
  // the transfer decide, as it always did.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return withBoardPatch(tick(WAIT, "The ship is full, so it is time to unload.", "Looting", { kind: "done" }), { [OPERATION_DRAIN_CLEAR_BOARD_KEY]: "" });
  }
  // Once is enough: see the note in loot-wrecks. Nothing about the next can will
  // be different while the hold that turned this one down is still full.
  if (shipHasNoRoom(obs.refusals, step.id, "lootContainer")) {
    return withBoardPatch(tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", "Looting", { kind: "done" }), { [OPERATION_DRAIN_CLEAR_BOARD_KEY]: "" });
  }
  // Set-aside now comes from the RUN's refusal ledger rather than a `skipped`
  // list in step memory. The list was dropped every time the block was left, so
  // on a `forever` loop each stubborn can was reconsidered from scratch on every
  // lap — five fresh attempts, for ever. See `shouldSetAside`.
  if (obs.claimedContainerIDs === null) {
    return tick(WAIT, "Container claim authority is unreadable; waiting safely.", "Looting", ACTING, false, mem);
  }
  if (operation && (operation.containerProvenanceUnconfirmed || operation.ownedContainerIDs == null ||
      operation.miningOwnerIDs == null)) {
    return tick(WAIT, "Operation can provenance is unreadable.", "Draining blocked", {
      kind: "blocked", reason: "The operation cannot prove which containers its miners created; automatic collection is blocked.",
    });
  }
  const ownedIDs = new Set(operation?.ownedContainerIDs ?? []);
  const minerIDs = new Set(operation?.miningOwnerIDs ?? []);
  if (operation && containersOnGrid(snapshot).some(c => ownedIDs.has(c.itemID) &&
      (c.ownerID === null || !minerIDs.has(c.ownerID)))) {
    return tick(WAIT, "An operation container has unexpected ownership.", "Draining blocked", {
      kind: "blocked", reason: "Container identity or owner changed; collection requires reconciliation.",
    });
  }
  const rawCans = containersOnGrid(snapshot).filter(c => !operation ||
    (ownedIDs.has(c.itemID) && c.ownerID !== null && minerIDs.has(c.ownerID)));
  const allCans = rawCans.filter(
    (c) => !shouldSetAside(obs.refusals, step.id, "lootContainer", c.itemID, MAX_BLOCK_ATTEMPTS),
  );
  const claimed = new Set(obs.claimedContainerIDs ?? []);
  const cans = allCans.filter((c) => !claimed.has(c.itemID));
  if (cans.length === 0) {
    if (logisticsTarget && rawCans.length > 0 && allCans.length === 0) {
      return tick(WAIT, "Old-target containers repeatedly refused collection.", "Draining blocked",
        { kind: "blocked", reason: "Containers still require collection; the logistics tail cannot be declared clear." });
    }
    if (allCans.length > 0) {
      return withBoardPatch(tick(WAIT, "Other haulers are servicing the remaining containers.", "Looting", ACTING, false,
        { ...mem, emptyChecks: 0 }), { [OPERATION_DRAIN_CLEAR_BOARD_KEY]: "" });
    }
    if (logisticsTarget && operation?.currentTarget?.targetKey === logisticsTarget.targetKey &&
        operation.rendezvous?.kind === "MINER_CLEARANCE") {
      return tick(WAIT, "Miners are still clearing partial freight from this grid.", "Draining", ACTING, false, { ...mem, emptyChecks: 0 });
    }
    // A can that has not shown up in THIS tick's snapshot is not proof the
    // grid never had one — landing on a belt and checking for containers on
    // the very next tick (no natural pause the way a player starting the bot
    // by hand gets) can read one tick ahead of a not-yet-caught-up snapshot.
    // Wait out a short settle window of consecutive empty reads before
    // believing "nothing here" for real, so one stale tick right after
    // arrival does not turn the bot straight back around.
    const emptyChecks = (num(mem, "emptyChecks") ?? 0) + 1;
    if (emptyChecks <= CONTAINER_SETTLE_TICKS) {
      return tick(WAIT, "Checking the grid for containers.", "Looting", ACTING, true, { ...mem, emptyChecks });
    }
    if (logisticsTarget && !freightReadable(obs.holds)) {
      return tick(WAIT, "Freight holds are unreadable; the tail cannot complete.", "Draining", ACTING, false, mem);
    }
    if (logisticsTarget && freightHoldItemIDs(obs.holds ?? null).length === 0) {
      return tick({ kind: "miningDrainComplete", targetKey: logisticsTarget.targetKey },
        "The old grid and freight holds are confirmed clear.", "Logistics tail complete", ACTING, false, mem);
    }
    const result = tick(WAIT, logisticsTarget ? "Final partial delivery is required." : "Every container here is emptied.",
      logisticsTarget ? "Final partial delivery" : "Looting", { kind: "done" });
    return logisticsTarget ? withBoardPatch(result, { [OPERATION_DRAIN_CLEAR_BOARD_KEY]: logisticsTarget.targetKey }) : result;
  }
  // A can IS present this tick — the settle window above was for nothing, and
  // any leftover count from an earlier blip must not linger and delay the
  // eventual "done" once every can here really is emptied.
  const memClean: MacroMemory = { ...mem, emptyChecks: 0 };
  const measurement = measureSpace(snapshot);
  const target = nearest(cans, measurement);
  if (target === null) {
    return tick(WAIT, "Nothing reachable to loot.", "Looting", ACTING, true, memClean);
  }
  const servicing = (result: MacroTick): MacroTick => ({ ...result,
    containerTargetID: target.itemID,
    ...(logisticsTarget ? { boardPatch: { ...result.boardPatch, [OPERATION_DRAIN_CLEAR_BOARD_KEY]: "" } } : {}),
  });
  const dist = measurement?.distances.get(target.itemID) ?? Number.POSITIVE_INFINITY;
  // ⚠ THE SERVER'S RANGE CHECK BEATS OUR MEASUREMENT. A bind that came back
  // "cannot reach" means the gateway's own scene/range test said no, whatever
  // the snapshot's arithmetic made of the distance — a stale position, or a
  // scene boundary this client cannot see. Closing in is the answer; retrying
  // the loot from here would just collect the same refusal.
  const unreachable = isUnreachable(obs.refusals, step.id, "lootContainer", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(memClean, "approaching") === target.itemID) {
      const stall = closeInStall(measurement?.shipMode ?? null, memClean);
      if (stall.step === "reorder") {
        return servicing(tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, "Looting", ACTING, true, stall.mem));
      }
      if (stall.step === "unstick") {
        return servicing(tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, "Looting", ACTING, true, stall.mem));
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, "Looting", { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return servicing(tick(WAIT, "Flying to the container.", "Looting", ACTING, true, stall.mem));
    }
    return servicing(tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for the container.",
      "Looting",
      ACTING,
      true,
      clearCloseInStall({ ...memClean, approaching: target.itemID }),
    ));
  }
  // No `tries` counter here any more: the ledger counts, across laps, and
  // `shouldSetAside` above is what takes a hopeless can out of the list.
  return servicing(tick(
    { kind: "lootContainer", containerID: target.itemID },
    "Taking what's inside.",
    "Looting",
    ACTING,
    true,
    { ...memClean, approaching: null },
  ));
};

// ── refine-ore ───────────────────────────────────────────────────────────────
// Docked: refine every ore stack in the station hangar. Ore is the game's own
// Asteroid category (25) on the row — a row whose category CANNOT be read is
// left alone, because refining is destructive (the station taxes it) and
// "cannot tell" never passes. Done when a fresh hangar read shows no ore left.
const CATEGORY_ORE = 25; // retail's Asteroid category — every ore type lives in it

const refineOre: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked, so there is no refinery to use.", "Refining", {
      kind: "blocked",
      reason: "Dock at a station first — this block refines the ore in its hangar.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  if (hangar === null) {
    return tick(WAIT, "Reading the hangar.", "Refining", ACTING, false, mem);
  }
  const ore = hangar.filter((row) => row.categoryID === CATEGORY_ORE && !row.singleton);
  if (ore.length === 0) {
    return tick(WAIT, "No ore left in the hangar.", "Refining", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The refinery kept leaving ore behind.", "Refining", {
      kind: "blocked",
      reason: "The station kept refusing to refine the ore, so the bot stopped.",
    });
  }
  return tick(
    { kind: "reprocessOre", itemIDs: ore.map((row) => row.itemID) },
    `Refining ${ore.length === 1 ? "the ore stack" : `${ore.length} ore stacks`}.`,
    "Refining",
    ACTING,
    false,
    { attempts },
  );
};

// ── hardeners-on ─────────────────────────────────────────────────────────────
// One press at the top of a fight or a trip: switch every fitted hardener on,
// one per tick, and finish once they are all running.
//
// ⚠ THE LIST IT IS HANDED HOLDS ONLY MODULES THAT CYCLE, and that is the
// caller's work, not this block's (flow.ts `resolveDefenseModuleIDs`, which
// drops anything with no dogma cycle). What arrives here is therefore hardeners
// and the damage controls that really do burst — never the ordinary damage
// control, which is already working the moment it is online. Every message
// below is worded for that: a ship can carry a damage control and still have
// nothing this block can switch.
//
// ⚠ NOTHING TO HARDEN WITH IS `skipped`, NOT `blocked`. It used to STOP THE
// BOT, and that was the wrong shape of answer twice over. A hardener is
// something a hull HAS or has not: no amount of waiting, retrying or player
// attention turns a bare rack into a full one, so there is nothing a stop could
// achieve. And hardening is done ON THE WAY to the work — a mining trip, a den
// — never the work itself, so a ship without one still has everything under
// this block to get on with. Exactly the salvager-on-a-ratting-hull case two
// thousand lines up, and it takes the same answer: the orchestrator says so
// ONCE (through the alert path, so a player who was away still sees it) and
// moves on, silently on every later lap.
//
// ⚠ AN UNREADABLE FIT FALLS DOWN THIS SAME BRANCH, and skipping is right for it
// too. `resolveDefenseModuleIDs` hands back empty lists when the fit could not
// be read, which is indistinguishable here from a bare rack — and a bot that
// stops because one read stumbled is worse than a bot that goes without one
// optimisation and keeps flying.
const hardenersOn: MacroDecider = (_step, obs, mem) => {
  const hardeners = obs.hardenerModuleIDs ?? [];
  if (hardeners.length === 0) {
    return tick(WAIT, "Nothing to harden with — moving on.", "Hardening", {
      kind: "skipped",
      // Read after the orchestrator's own `Skipped "<the step>": ` prefix, so
      // it says what is missing and nothing about being skipped.
      reason:
        "This ship has no hardener that can be switched on. A damage control needs no switching on - it works the moment it is online.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting to be in space (hardeners only run out there).", "Hardening", ACTING, false, mem);
  }
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  const idle = hardeners.find((id) => !active.has(id));
  if (idle === undefined) {
    return tick(WAIT, "Everything is hardened.", "Hardening", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "A hardener would not switch on.", "Hardening", {
      kind: "blocked",
      reason: "A hardener kept refusing to switch on, so the bot stopped.",
    });
  }
  return tick(
    { kind: "activate", moduleID: idle, targetID: 0 },
    "Switching a hardener on.",
    "Hardening",
    ACTING,
    false,
    { attempts },
  );
};

// ── the site ledger, on the board (docs/drone-boat-block-spec.md §13) ────────
//
// The loop these two helpers close: the bot warps into a den it cannot beat,
// fights until a watch pulls it home, repairs PERFECTLY, comes back to the same
// den, and does it again until somebody notices. `MAX_RECOVER_TRIPS` cannot see
// it — `releaseRecoverTrips` drops the whole tally the moment the watched
// condition reads not-met, so a repair that WORKS resets the cap, and every one
// of these repairs works. The ship is fine every time. The site is the problem.
//
// The arithmetic all lives in nav/siteProgress.ts and none of it is repeated
// here: this file only FEEDS it (what the fight block saw this tick) and OBEYS
// it (leave, and stop touring the label). Two blocks talk to it — `fight-the-
// rats` writes the verdict, `warp-to-anomaly` acts on it — and they talk over
// the RUN BOARD, which is the channel they already share for `anomsVisited`.
//
// ⚠ NONE OF IT MAY LIVE IN STEP MEMORY. Step memory is wiped every time a step
// is left, so a per-visit budget hands every failing site a fresh allowance on
// every lap; this codebase has already paid for that lesson once (the note above
// `MacroMemory`: 227 consecutive refusals in bursts of five). "This site has been
// beating me" is the same shape as "this object has been refusing me" and belongs
// in the same place.

/**
 * The board patch that carries a changed ledger, or null when nothing moved.
 *
 * `encodeLedger` is documented as an ALL-KEYS patch, so this is a whole-ledger
 * write or nothing at all — never a partial one, which would leave last site's
 * primary id on the board next to this site's baseline. The null case exists so
 * a block that decided nothing this tick (in warp, waiting on a lock) does not
 * publish a board write per tick for the readout to churn through.
 */

function ledgerPatch(before: SiteLedger, after: SiteLedger): ScriptBoard | null {
  const next = encodeLedger(after);
  const prev = encodeLedger(before);
  for (const key of Object.keys(next)) {
    if (prev[key] !== next[key]) {
      return next;
    }
  }
  return null;
}

// ── fight-the-rats ───────────────────────────────────────────────────────────
// `hostilesInReach` (the targeting-range gate every rung below reads) lives in
// scriptConditions.ts, shared with the fight-back watch that borrows this ladder.

// The full combat loop: nearest pirate first — lock it (bounded), set the drones
// on it, run every idle gun on it; when it dies the list shrinks and the next
// one is picked. Done when the grid is clear AND the drones are back aboard.
// Players on grid are FRIENDLY in this world (operator decision) — only NPC
// hostiles (hostileRows) are ever engaged.
const fightTheRats: MacroDecider = (step, obs, mem, board) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Fighting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Fighting", ACTING, false, mem);
  }
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const hostiles = hostilesInReach(obs, snapshot, origin);
  const roster = droneRoster(obs, "combat");

  const role = squadRoleOf(step);

  // ── §13: is this site worth another minute? ────────────────────────────────
  //
  // Read the ledger off the board, hand it what this tick saw, publish it back
  // if anything moved. The verdict is computed BEFORE the ladder runs and from
  // the state the ladder is standing in at the top of the tick (the primary the
  // LAST tick's orders were aimed at), so every rung below is judged by what it
  // actually achieved rather than by what it is about to order.
  //
  // WHICH SITE THIS IS comes off the board too, and this block never guesses it:
  // `warp-to-anomaly` publishes the label on the tick it commits to a site (it
  // is the only block that KNOWS an arrival happened, having issued the warp),
  // and the ledger carries it here. A fight that is not at a scanned site at all
  // — a belt spawn, a gate camp, a mission pocket — has a null label, which is
  // a case siteProgress.ts already handles: the stall counter still runs, there
  // is simply no per-site count to keep and nothing for the tour to skip.
  //
  // ⚠ THE LABEL IS ONLY EVER REPLACED BY `warp-to-anomaly`, so a script that
  // flies to a den, fights, and then fights somewhere else WITHOUT an anomaly
  // block in between carries the den's label to the second fight. The cost is
  // bounded and lands in the safe direction — at worst one stall is booked
  // against a label the ship has genuinely been beaten at before — and the
  // alternative (this block inventing a label from the grid) is the guess §13
  // spends its length arguing against.
  const ledger = decodeLedger(board);
  const verdict = observeTick(ledger, fightEvidence(obs, mem, hostiles, roster, ledger.siteLabel));

  // ⚠ A CLEARED GRID IS A SUCCESS AND WIPES THIS LABEL'S TALLY. `hostiles` being
  // empty is the ladder's own definition of having finished a site (its very
  // first rung, below), and an empty grid is the strongest evidence obtainable
  // that the den was winnable after all — so it outranks anything the ledger was
  // about to say, including a stall whose budget ran out on this very tick.
  //
  // It wins twice over, deliberately, because either alone would be enough:
  // siteProgress reads the hostile count going down as PROGRESS and clears the
  // stall itself, and the ladder checks "grid clear" before it checks the
  // verdict, so the block finishes with "The grid is clear." and never with a
  // leaving sentence. The give-up path is not this path and never resets
  // anything — that is the difference between "I won" and "I left".
  //
  // The one soft edge, noted rather than papered over: `hostilesInReach` drops
  // rows past the hull's targeting range, so a grid whose rats are all parked at
  // 300 km reads as clear here. That is already how this block FINISHES today —
  // out of range reads as an empty grid — and a visit that ends without a shot
  // fired is not a visit that should count against the den either.
  const after = hostiles.length === 0 ? forgetSite(verdict.ledger, verdict.ledger.siteLabel) : verdict.ledger;
  const patch = ledgerPatch(ledger, after);
  const decided = fightRatsLadder(step, obs, mem, snapshot, hostiles, roster, role, verdict);
  return patch === null ? decided : withBoardPatch(decided, patch);
};

/**
 * ⚠ IS `fight-the-rats` ACTUALLY APPLYING DAMAGE RIGHT NOW? — the one input
 * nav/siteProgress.ts refuses to compute for itself, and the single thing in
 * this parcel most likely to be got wrong.
 *
 * The dangerous version of this feature blames the SITE for faults at OUR end:
 * drones sitting in the bay, drones ordered on nothing, a lock that never
 * landed, a rat parked outside the drone leash, guns chattering with an empty
 * bay. Every one of those reads as "nothing is dying" and NOT ONE of them means
 * the den is unwinnable — the honest answer to each is to fix the fit or the
 * position. A stall counter that ticked through them would throw away good
 * anomalies AND hide the real bug behind a plausible verdict, because a pilot
 * told "this den is too hard" never goes looking for the drones that were 40 km
 * out doing nothing.
 *
 * So every rung below is a rung this block can positively SEE, and every one of
 * them must hold:
 *
 *   1. There is a primary we have been holding (step memory's `targetID`) and it
 *      is STILL on the reachable grid — `hostiles` is already gated by the
 *      hull's targeting range where that reads, so a row that survives it is a
 *      row the ship can lock. A target that died or drifted out leaves here.
 *   2. This block's own COMBAT drones are out. `roleOut` and not `out`: a flight
 *      of salvage drones is not damage.
 *   3. They were ordered onto THIS primary (`dronesOn`), not onto the last one.
 *      The tick that issues `engageDrones` therefore does NOT count — it has
 *      ordered damage, not applied any — and nor does the tick after a target
 *      switch, which clears `dronesOn` on its way past.
 *   4. The primary is LOCKED. Waiting on a lock is our problem and not the
 *      site's, and §13 names it explicitly.
 *   5. The primary is inside the DRONE leash, which is a different and usually
 *      shorter leash than the lock range in rung 1 (see nav/kiteBand.ts, which
 *      records what substituting one for the other cost). `fight-the-rats` has
 *      NO range control at all — it never repositions — so a rat that lands at
 *      the far edge of lock range simply sits there out of reach of the drones,
 *      which is exactly the "no damage that is our own fault" case.
 *
 * ⚠ AN UNREADABLE DRONE LEASH FALLS BACK TO THE 20 km NO-SKILLS BASE, NOT TO
 * INFINITY. Control range is skill-derived and rides a fitting read a bot run
 * does not force, so null is the COMMON case and reading it as "no limit" would
 * count every long-range tick as damage going in. Guessing LOW is the cheap half
 * of being wrong here in the same way it is in `kiteBand`: an assumed-short leash
 * only ever refuses to count ticks, so the stall fires late or not at all, which
 * costs the player minutes. Guessing high costs them the anomaly AND the
 * diagnosis. When in doubt, false.
 *
 * Guns are deliberately not a rung of their own: a gun boat with no drones
 * reports `false` on every tick and never accrues a stall. That is the
 * conservative reading and it is on purpose — this block cannot see a turret's
 * optimal, its falloff, its tracking or whether the charge bay is empty, so the
 * only honest thing it could say about a gun is "I pressed the button".
 */
function fightEvidence(
  obs: ScriptObservation,
  mem: MacroMemory,
  hostiles: readonly OverviewRow[],
  roster: DroneRoster,
  siteLabel: string | null,
) {
  const held = num(mem, "targetID");
  const primary = held === null ? undefined : hostiles.find((row) => row.itemID === held);
  const leashM = obs.droneControlRangeM ?? FALLBACK_CONTROL_RANGE_M;
  const applying =
    held !== null &&
    primary !== undefined &&
    roster.roleOut.length > 0 &&
    num(mem, "dronesOn") === held &&
    (obs.lockedTargetIDs ?? []).includes(held) &&
    primary.distance <= leashM;
  return {
    applying,
    // The health rows are facts about the RAT and are handed over whether or not
    // we are applying — the ledger keeps the lowest reading ever seen, and a
    // reading taken while the drones were flying home is still a reading.
    primaryID: primary?.itemID ?? null,
    primaryShieldRatio: primary?.shieldRatio ?? null,
    primaryArmorRatio: primary?.armorRatio ?? null,
    primaryHullRatio: primary?.hullRatio ?? null,
    // ⚠ THE COUNT IS THE IN-REACH COUNT, and that is safe in exactly one
    // direction. `hostilesInReach` drops rows beyond the hull's targeting range,
    // so this can UNDERSTATE the grid — and an understatement can only ever look
    // like a hostile LEAVING, which the ledger reads as progress and which
    // RESETS the stall counter. It can never manufacture a stall. The reverse
    // (a fresh wave landing) only moves the baseline, which is the same thing
    // the true count would have done.
    hostileCount: hostiles.length,
    siteLabel,
  };
}

/**
 * The ladder itself — unchanged from the day it shipped, save for the one new
 * rung that leaves a site the ledger has given up on.
 *
 * It is a separate function only so the caller can wrap whatever it decides in
 * the ledger's board patch without every rung below having to know the ledger
 * exists.
 */
function fightRatsLadder(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  snapshot: SpaceSnapshot,
  hostiles: readonly OverviewRow[],
  roster: DroneRoster,
  role: SquadRoleArg,
  verdict: SiteVerdict,
): MacroTick {
  const lockRefusals = readLockRefusals(step, obs, mem);
  if (hostiles.length === 0) {
    // ⚠ AN EMPTY GRID IS READ THREE TIMES BEFORE IT IS BELIEVED, and the tick
    // this protects is the one right after a warp lands. Caught live on
    // 2026-09-14 in the drone-boat block, which shares the trap: the ship
    // arrived in a den, read a grid that had not populated yet, called it clear,
    // and the loop warped on to the next site while the rats it had just decided
    // were not there shot its shields off. A grid that has not ARRIVED is
    // byte-identical to a grid with nothing on it — the same lie the scanner
    // tells, and it gets the same three reads (EMPTY_SCAN_CONFIRM_READS above).
    //
    // Consecutive: one hostile row puts the count straight back, so a fight that
    // is still going can never creep toward finishing during a lull.
    const emptyReads = (num(mem, "emptyGridReads") ?? 0) + 1;
    if (emptyReads < EMPTY_GRID_CONFIRM_TICKS) {
      return tick(
        WAIT,
        "Nothing on the grid yet — reading it again before calling this done.",
        "Fighting",
        ACTING,
        false,
        { ...mem, emptyGridReads: emptyReads },
      );
    }
    // Stand the fleet's call down BEFORE leaving: a call outlives the ship it
    // named for as long as its ttl, and a follower obeying one is a follower
    // holding its guns on a wreck.
    const standDown = standCallDown(role, mem, "Grid clear — standing the fleet's call down.", "Fighting");
    if (standDown !== null) {
      return standDown;
    }
    if (roster.out.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: roster.out }, "Grid clear — calling the drones home.", "Fighting", ACTING);
    }
    return tick(WAIT, "The grid is clear.", "Fighting", { kind: "done" });
  }

  mem = num(mem, "emptyGridReads") === null ? mem : { ...mem, emptyGridReads: 0 };

  const weapons = obs.weaponModuleIDs ?? [];
  if (weapons.length === 0 && roster.roleOut.length === 0 && roster.roleBay.length === 0) {
    return tick(WAIT, "No way to fight.", "Fighting", {
      kind: "blocked",
      reason: "This ship has no guns fitted and no combat drones in the bay.",
    });
  }

  // ── §13: the site has been given up on ─────────────────────────────────────
  //
  // Nothing here was dying while the drones were on it, or this label has sent
  // the bot home its allowance of times. Either way the fight is over: leave the
  // way a CLEARED grid leaves — call down, drones home, `done`.
  //
  // ⚠ `done`, NEVER `blocked`. This is a verdict about ONE site and not about
  // the run: pausing here would strand a bot that has another five perfectly
  // good dens on the scanner, and `warp-to-anomaly` is the block that decides
  // when the whole SYSTEM has run out (it reads the same ledger and says so in
  // words a player can act on).
  //
  // ⚠ AND IT COMES AFTER "no way to fight", DELIBERATELY. A hull with no guns
  // and no combat drones is a FIT fault at our end, and §13's whole argument is
  // that our own faults must never be reported as the site's. The player needs
  // that sentence, not a tour of dens being "given up on" by a ship that could
  // never have cleared any of them.
  if (verdict.abandon) {
    const leaving = describeVerdict(verdict) ?? "I am leaving this site.";
    const standDown = standCallDown(role, mem, `${leaving} Standing the fleet's call down.`, "Fighting");
    if (standDown !== null) {
      return standDown;
    }
    if (roster.out.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: roster.out }, `${leaving} Calling the drones home.`, "Fighting", ACTING);
    }
    return tick(WAIT, leaving, "Fighting", { kind: "done" });
  }

  // The COMBAT drones out first — they defend on their own the moment they
  // undock. Never the whole bay: the salvage drones stay in it (launchRoleDrones).
  const launch = launchRoleDrones(obs, mem, "Fighting", "combat", "Launching the combat drones.");
  if (launch.tick !== null) {
    return launch.tick;
  }
  mem = launch.mem;
  if (weapons.length === 0 && roster.roleOut.length === 0 && launchStalled(mem)) {
    return tick(WAIT, "No way to fight.", "Fighting", {
      kind: "blocked",
      reason: "The combat drones could not be launched, and there are no guns to fall back on.",
    });
  }

  // The primary: what the FLEET called when this block follows one and that ship
  // is here, otherwise the hostile the ladder ranks first (nearest inside a
  // class — hostileRows is nearest-first, and the pick keeps that order on a
  // tie). Remembered either way so fire is CONCENTRATED — spread damage kills
  // nothing, which is the whole reason both halves of this exist.
  const called = role === "follow" ? calledOnGrid(obs, hostiles, (row) => row.itemID) : null;
  let targetID = num(mem, "targetID");
  if (targetID !== null && !hostiles.some((h) => h.itemID === targetID)) {
    targetID = null; // it died — next
  }
  if (called !== null && targetID !== called.itemID) {
    // The fleet called something else. Switching mid-fight is the POINT of
    // following: an FC re-calls when the first primary stops being the problem.
    targetID = null;
  }
  if (targetID === null) {
    const primary =
      called ??
      pickPrimary(
        hostiles,
        (row) => row.typeID,
        (row) => row.distance,
        targetGroupOf(obs),
        targetPriorityOf(step),
        // No `tagOf`: tags are resolved one rung up by `calledOnGrid`, and
        // wiring them through here as well is how one of the two mechanisms
        // silently stops mattering (see that function's own note).
        //
        // ⚠ AND THAT IS ALSO WHAT KEEPS THE FC'S TAG ABOVE THE JAM FEED. A tag
        // makes `called` non-null, and `called` short-circuits this pick
        // entirely — so a tagged ship is locked whatever the jam fold says. That
        // precedence is deliberate and documented in targetPriority.ts: a tag is
        // a human looking at the fight and saying "this one, now"; a jam is a
        // fact about the grid. The human wins.
        undefined,
        // ⚠ THE TWO READS THAT MAKE THIS A PICK AND NOT A COIN TOSS, and the
        // pair a hull was lost for on 2026-09-14 (see `jammingSourcesOf`). The
        // dogma gives the player's ladder something to rank RATS by, which it
        // has never had; the live jam feed puts whatever is actually holding
        // this ship at the top of that ladder. Both matter most in the escape
        // this block gets borrowed for — `fightTheWayOut` runs this exact pick,
        // and the one target whose death frees a scrammed ship is the one the
        // server already named.
        targetThreatOf(obs),
        jammingSourcesOf(obs),
      ) ??
      hostiles[0]!;
    // ⚠ THE PICK AND THE PRESS ARE ONE TICK, so a refused press leaves no target
    // in memory either and this branch runs again. See `readLockRefusals`: the
    // refusal is read here, before pressing again.
    if (lockRefusals.unread) {
      return tick(WAIT, "Checking the last lock.", "Fighting", ACTING, true, { ...mem, lockRefusalsSeen: lockRefusals.count });
    }
    if (lockRefusals.fresh && refusalTargets(lockRefusals, primary.itemID)) {
      // The timed wait below, exactly what a refused lock got before 2fd4a77.
      return tick(WAIT, "Waiting for the lock.", "Fighting", ACTING, true, {
        ...mem,
        targetID: primary.itemID,
        lockIssued: true,
        waited: 0,
        dronesOn: null,
        lockRefusalsSeen: lockRefusals.count,
      });
    }
    return tick(
      { kind: "lock", targetID: primary.itemID },
      called !== null ? "Locking what the fleet called." : "Locking the pirate at the top of the list.",
      "Fighting",
      ACTING,
      true,
      { ...mem, targetID: primary.itemID, lockIssued: true, waited: 0, dronesOn: null, lockRefusalsSeen: 0 },
    );
  }
  const call = callPrimary(role, mem, targetID, "Calling it for the fleet.", "Fighting");
  if (call !== null) {
    return call;
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(targetID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      if (lockRefusals.unread) {
        return tick(WAIT, "Checking the last lock.", "Fighting", ACTING, true, { ...mem, lockRefusalsSeen: lockRefusals.count });
      }
      if (lockRefusals.fresh && refusalTargets(lockRefusals, targetID)) {
        return tick(WAIT, "Waiting for the lock.", "Fighting", ACTING, true, {
          ...mem,
          lockIssued: true,
          waited: 0,
          lockRefusalsSeen: lockRefusals.count,
        });
      }
      return tick({ kind: "lock", targetID }, "Locking the pirate.", "Fighting", ACTING, true, {
        ...mem,
        lockIssued: true,
        waited: 0,
        lockRefusalsSeen: 0,
      });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      // The count outlives the reset: without it the next pick would find a record
      // and no count, and spend a tick deciding the refusal it just sat out is old.
      const seen = num(mem, "lockRefusalsSeen");
      return tick(WAIT, "That one would not lock — picking another.", "Fighting", ACTING, true,
        seen === null ? {} : { lockRefusalsSeen: seen });
    }
    return tick(WAIT, "Waiting for the lock.", "Fighting", ACTING, true, { ...mem, waited });
  }

  // Locked: the combat drones onto it once, then every idle gun onto it.
  if (roster.roleOut.length > 0 && num(mem, "dronesOn") !== targetID) {
    return tick(
      { kind: "engageDrones", droneIDs: roster.roleOut, targetID },
      "Setting the drones on it.",
      "Fighting",
      ACTING,
      true,
      { ...mem, dronesOn: targetID },
    );
  }
  // Rotate a hurt drone: the same rung, and the same rule, as the drone boat's
  // (nav/droneBoatLadder.ts rung 6) — a drone whose shield has started to go is
  // pulled before the rats finish it, then sent straight back out.
  //
  // ⚠ THIS BLOCK IS WHAT THE `fight-back` WATCH BORROWS, which is why it lives
  // here and not only in `fight-with-drones`. A working bot is mining when the
  // rats arrive, so the watch fights nearly every real fight; a rotation only
  // the drone-boat BLOCK could run was a rotation no miner ever got.
  //
  // Below the engage rung, so the primary is locked and the flight is on it
  // before anything is pulled; never STARTED with a single drone out, because
  // pulling a flight of one leaves the primary unattended — but one already in
  // flight is always allowed to finish.
  const rotationMemory = readRotationMemory(mem["rotation"]);
  if (rotationMemory.active !== null || roster.roleOut.length > 1) {
    const rotation = decideDroneRotation({
      dronesInSpace: roster.roleRows,
      droneIDsInBay: obs.combatDroneBayItemIDs ?? null,
      memory: mem["rotation"],
    });
    // A drone that is back out has no orders: clearing `dronesOn` makes the
    // engage rung above set the whole flight on the primary again.
    mem = {
      ...mem,
      rotation: rotation.memory,
      ...(rotation.reason === "complete" ? { dronesOn: null } : {}),
    };
    if (rotation.action === "recall" && rotation.itemID !== null) {
      return tick(
        { kind: "recallDrones", droneIDs: [rotation.itemID] },
        "That drone has started losing shield — pulling it before the rats finish it.",
        "Fighting",
        ACTING,
        true,
        mem,
      );
    }
    if (rotation.action === "relaunch" && rotation.itemID !== null) {
      return tick(
        { kind: "launchDrones", droneItemIDs: [rotation.itemID] },
        "Sending the drone back out.",
        "Fighting",
        ACTING,
        true,
        mem,
      );
    }
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const idleGun = weapons.find((id) => !active.has(id));
  if (idleGun !== undefined) {
    return tick(
      { kind: "activate", moduleID: idleGun, targetID },
      "Guns on the pirate.",
      "Fighting",
      ACTING,
      true,
      mem,
    );
  }
  return tick(WAIT, "Fighting it.", "Fighting", ACTING, true, mem);
}

// ── fight-with-drones ────────────────────────────────────────────────────────
//
// The drone boat's block. Everything it decides lives in `nav/droneBoatLadder.ts`
// — pure, tested, and composed out of six leaf modules that each own one hard
// question (the stand-off band, what a rat type does, which one to shoot, when a
// prop mod comes off, when to rotate a hurt drone, when to give a site up). What
// is left HERE is the adapter, and it owns exactly three things the ladder
// deliberately refused to own from where it sits:
//
//   1. THE PLAYER'S ARGUMENTS, read off the step.
//   2. THE FLEET'S CALL, resolved through the existing three-source precedence
//      rather than a second copy of it.
//   3. THE PROPULSION EFFECT NAME on a stop, which needs the fit and not the
//      grid.
//
// ⚠ AND ONE UNIT CONVERSION, WHICH IS THE THING MOST LIKELY TO BE GOT WRONG
// HERE. The player types KILOMETRES; every range under this line is METRES.

/**
 * The player's hold override, IN METRES, or null when they left it computed.
 *
 * ⚠ THIS MULTIPLICATION IS THE ONLY ONE, AND SKIPPING IT IS A THOUSANDFOLD
 * ERROR IN THE DIRECTION THAT LOOKS LIKE NOTHING. `distanceKm` stores what the
 * player typed, because that is the number their overview shows them; `kiteBand`
 * and every leash in `droneBoatLadder` are metres. Hand 25 straight through and
 * the band resolves a 25-METRE hold — the ship flies into the middle of the rats
 * — and hand 25000 to a box bounded 1..300 and the codec clamps it to 300 km,
 * which parks the boat outside its own drone leash where nothing dies and the
 * give-up ledger blames the SITE for it. Neither failure announces itself.
 */
function holdRangeMOf(step: MacroStep): number | null {
  const arg = step.args["holdRangeKm"];
  return arg !== undefined && arg.kind === "distanceKm" ? arg.value * 1000 : null;
}

/** Whether this step may light a prop mod. Absent = "auto", the shipped answer. */
function propModeOf(step: MacroStep): "auto" | "off" {
  const arg = step.args["propulsion"];
  return arg !== undefined && arg.kind === "propMode" ? arg.mode : "auto";
}

/**
 * Fill in the propulsion effect on a `deactivate` the ladder emitted, from the
 * fit.
 *
 * ⚠ WITHOUT THIS THE STOP RETURNS SUCCESS AND THE BURNER KEEPS CYCLING. The
 * server stops a prop mod only when the Deactivate NAMES its propulsion effect,
 * and the BFF resolves that name from the module's typeID (nav/propulsion.ts,
 * `api.deactivateModule`, and the route in src/server.js all say so). The ladder
 * cannot supply it: it is a FIT fact, and a pure decision core that reached into
 * the fit for it would be re-deriving what `obs.propulsionModules` already
 * carries. So the ladder names the module and this names the effect.
 *
 * ⚠ IT IS A LOOKUP AND NEVER A GUESS. A `deactivate` whose module is not in the
 * propulsion list is some other module — a repairer, a hardener — and those stop
 * without an effect name, so it passes through untouched. Attaching a typeID
 * from the wrong module would ask the server to end a cycle that module is not
 * running.
 */
function nameThePropulsionEffect(decided: MacroTick, obs: ScriptObservation): MacroTick {
  const action = decided.action;
  if (action.kind !== "deactivate") {
    return decided;
  }
  const module = (obs.propulsionModules ?? []).find((row) => row.itemID === action.moduleID);
  if (module === undefined) {
    return decided;
  }
  return { ...decided, action: { ...action, typeID: module.typeID } };
}

/**
 * Fight from a distance with drones — the registration of `decideDroneBoat`.
 *
 * ⚠ THE CALLED SHIP IS RESOLVED OVER THE IN-REACH ROWS, NOT THE WHOLE GRID, and
 * that is the same rule `fight-the-rats` follows. `calledOnGrid`'s precedence is
 * "tag, then broadcast, then board, and a source naming a ship this pilot cannot
 * act on falls through to the NEXT source rather than to null" — which only
 * works if the rows handed in are the ones this pilot can actually shoot. Hand
 * it the raw grid and an FC's tag on a rat 80 km out would blind a follower to a
 * broadcast it could have obeyed. `hostilesInReach` is exactly the filter the
 * ladder's own `inReach` applies, so the two agree by construction.
 */
const fightWithDrones: MacroDecider = (step, obs, mem, board) => {
  const operation = obs.miningOperation;
  if (operation?.role === "DEFENDER" || mem.operationDefender === true || obs.miningOperationRequired && operation == null) {
    const identity = defenderSiteIdentity(operation);
    const previous = mem.defenderSiteIdentity;
    if (identity === null || previous !== undefined && previous !== identity) {
      if (mem.combatOwned) {
        const settlement = settleCombat(obs, { ...mem, combatSettling: true });
        if (settlement.outcome.kind !== "done") return nameThePropulsionEffect(settlement, obs);
      }
      return tick(WAIT, "Waiting for authoritative operation target after owned combat settlement.",
        "Waiting for operation target", ACTING, false, { operationDefender: true });
    }
    if (previous !== identity) {
      const family = operation!.currentTarget!.targetType;
      const travel = family === "BELT" ? operationTravelToBelt(obs, mem) :
        family === "ORE_ANOMALY" || family === "ICE" ? operationSiteTravel(obs, mem, family) : null;
      if (travel === null) return tick(WAIT, "Operation target family is unsupported.", "Target unavailable",
        { kind: "blocked", reason: "Standard Defender requires an executable operation target." });
      if (travel.outcome.kind !== "done") return { ...travel, nextMem: { ...travel.nextMem, operationDefender: true } };
      // Travel observations do not become combat state; the same shared ladder
      // below is the only combat authority after exact operation-site arrival.
      mem = { operationDefender: true, defenderSiteIdentity: identity };
    }
  }
  const snapshot = obs.snapshot ?? null;
  const role = squadRoleOf(step);
  // A called ship can only be resolved off a grid, and the ladder's own guards
  // are what answer "there is no grid" — so with no snapshot this is simply
  // null, which is what every `squad: "off"` caller passes anyway.
  const called =
    snapshot === null || role !== "follow"
      ? null
      : calledOnGrid(
          obs,
          hostilesInReach(obs, snapshot, snapshot.ship?.position ?? { x: 0, y: 0, z: 0 }),
          (row) => row.itemID,
        );
  const decided = decideDroneBoat({
    obs,
    mem,
    board,
    targets: targetPriorityOf(step),
    holdRangeM: holdRangeMOf(step),
    propMode: propModeOf(step),
    squad: role,
    calledTargetID: called?.itemID ?? null,
    lockRefusals: readLockRefusals(step, obs, mem),
  });
  return nameThePropulsionEffect(decided, obs);
};

// ── warp-to-anomaly / warp-to-ore-anomaly ────────────────────────────────────
// Read the onboard scanner, warp to the next anomaly OF THE WANTED KIND this run
// has not visited (visited labels live on the BOARD so a repeat loop walks the
// system's sites one by one), and finish once the warp lands. With Fight-the-rats
// after it in a loop the combat one is the ratting bot; with Mine-at-a-belt after
// it the ore one is the anomaly mining bot.
//
// ⚠ THE KIND FILTER IS THE POINT, AND IT IS NOT A NAME MATCH. Ore and combat
// anomalies arrive in the SAME scanner slot, and the label a warp is issued
// against ("QEE-288") says nothing about what is there. They are told apart by
// the row's own scan-strength attribute — the same field the client's Probe
// Scanner groups by (scanner/siteKind.ts). Before this filter existed, a ratting
// loop would happily drop into an asteroid cluster and sit there with nothing to
// shoot, which is what the two blocks now make impossible.
//
// A site whose kind could not be read is skipped by BOTH blocks rather than
// being flown to on the chance it is the right one: an unreadable row is not a
// den, and warping a mining barge into one on a guess is how a hull is lost.
const WARP_START_WAIT_TICKS = 10; // ~20s for a warp to actually begin
// ⚠ AN EMPTY SCANNER IS READ THREE TIMES BEFORE IT IS BELIEVED. The server does
// not answer an unresolvable session with an error — it answers with an EMPTY
// full state (scanMgrService.js, `systemID <= 0` -> buildEmptySignalTrackerFullState),
// which is indistinguishable on the wire from a system that genuinely holds
// nothing. Believing the first one ends the run over a moment the next tick
// would have contradicted, and a re-read costs one call on a block that is
// paying for the scanner every tick anyway. A read that FAILS is already
// handled elsewhere (null -> keep waiting); this is the read that succeeds and
// lies.
const EMPTY_SCAN_CONFIRM_READS = 3; // ~6s of agreeing before "this system is empty"

// ⚠ A REFUSED MINING SITE IS NOT PROOF THE SITE IS GONE. The server words a
// torn-down site (SCAN_TARGET_NOT_FOUND) and a ship it still files under that
// site's pocket (DunCannotWarpWithinComplex) identically: "You cannot warp
// there right now." It happened for real: a server restart caught a pilot
// mid-warp, restored her off the ice field's grid with the pocket tracker still
// set, and every warp at the field came back refused while four pilots mined
// in it. The block called the system mined out and flew her home. A site that
// is really gone drops off the scanner, so the scanner is read again before
// that verdict; one still listed after this many reads is not gone.
const SITE_GONE_CONFIRM_READS = 10; // ~20s of the scanner still listing it

/** The same rule for the GRID: an empty one right after a warp has not arrived yet. */
const EMPTY_GRID_CONFIRM_TICKS = 3;

/** The words each variant uses about its own sites — the only thing that differs. */
interface AnomalyFlavour {
  /** Which scanner rows this tour flies to. Never a name match — see the kind filter note above. */
  readonly matches: (site: ScannerSite) => boolean;
  /** The board slot holding this run's visited labels. Separate per kind so
   *  one block's tour never marks the other block's sites as seen. */
  readonly boardKey: string;
  /** "den" / "ore site" — reads inside a sentence. */
  readonly noun: string;
  /** The same noun carrying its article ("a den" / "an ore site"). */
  readonly oneNoun: string;
  /** The step label the pilot sees while flying. */
  readonly flying: string;
  /** Appended when the scanner listed NOTHING AT ALL — the thing a player of
   *  THIS block reliably mistakes for one of its sites. See the note below. */
  readonly emptyScannerHint: string;
  /**
   * Does this tour keep the §13 site ledger?
   *
   * ⚠ ONLY THE COMBAT TOUR DOES, AND THIS IS NOT A TIDINESS FLAG. This block
   * only ever ADDS to the tally; the thing that takes it back down to zero is a
   * cleared grid, reported by `fight-the-rats` (see `forgetSite`). A tour with no
   * combat block behind it therefore feeds a counter nothing can ever reset, and
   * would retire perfectly good sites on their third lap.
   *
   * That is exactly the ore tour: `warp-to-ore-anomaly` hands its sites to
   * Mine-at-a-belt, which never fights, never clears a grid and never feeds the
   * ledger, and whose whole documented behaviour is that a completed lap starts
   * another one ("one miner does not empty an asteroid cluster in one hold").
   * Retiring ore sites after three laps would stop a mining bot that was working
   * perfectly.
   *
   * §13 is about the two COMBAT blocks and this flag keeps it there.
   */
  readonly givesUpOnSites: boolean;
  /**
   * Is the ship ALREADY standing in a site of this kind? TRI-STATE, and `null`
   * — cannot tell — is the answer this must give whenever the reading is not
   * one the block genuinely holds.
   *
   * It is consulted only after the server has refused the warp, to separate the
   * two refusals that arrive in identical words (see `warpRefusedHere`).
   *
   * `target` is the scan label the refused warp was issued against, or null
   * when the block no longer holds it — a reading that needs the label and
   * does not have it answers `null` rather than falling back to "some site of
   * this kind is near", which is a different question.
   */
  readonly alreadyHere: (obs: ScriptObservation, target: string | null) => boolean | null;
}

/**
 * The server's own floor for a warp: `MIN_WARP_DISTANCE_METERS` in
 * space/runtime.js, checked as `pendingWarp.totalDistance < 150_000` before
 * `WARP_DISTANCE_TOO_CLOSE` goes back. Mirrored rather than invented, because
 * the whole point of the reading below is to name the state the SERVER refused
 * on, and a threshold of our own would answer a question nobody asked.
 */
const MIN_WARP_DISTANCE_M = 150_000;

/**
 * Was the refused warp a warp to where the ship already is?
 *
 * The one reading that separates the two identical-sounding refusals without
 * guessing from what is on the grid: the scanner gives the SITE's position and
 * the snapshot gives the SHIP's, and a gap under the server's own warp floor is
 * the exact condition it refused on. Either position missing is `null` — cannot
 * tell — never `false`, because "no reading" and "the ship is elsewhere" send
 * the player to completely different places.
 */
function shipStandsInSite(obs: ScriptObservation, target: string | null): boolean | null {
  if (target === null) {
    return null;
  }
  const here = obs.snapshot?.ship?.position ?? null;
  const site = (obs.anomalies ?? []).find((row) => row.label === target)?.position ?? null;
  if (here === null || site === null || site === undefined) {
    return null;
  }
  return distanceMeters(here, site) < MIN_WARP_DISTANCE_M;
}

type ScannerSite = NonNullable<ScriptObservation["anomalies"]>[number];

/**
 * An ice field is an ORE row to the scanner: it is scanned gravimetric (211),
 * so `siteKind` groups it with the asteroid clusters exactly as the client's
 * Probe Scanner does. Only the dungeon archetype tells the two apart, and the
 * difference is the fit: ore lasers cannot touch ice and an Ice Harvester
 * cannot touch ore, so a tour that mixed them parked every miner in a field
 * half its modules could not work.
 */
function isIceSite(site: ScannerSite): boolean {
  return site.kind === "ore" && miningSiteFamily(site) === "ICE";
}

const COMBAT_FLAVOUR: AnomalyFlavour = {
  matches: (site) => site.kind === "combat",
  boardKey: "anomsVisited",
  noun: "den",
  oneNoun: "a den",
  flying: "Flying to the den",
  emptyScannerHint:
    "Rats on a belt or a gate are not a den: a den is a site the scanner lists.",
  givesUpOnSites: true,
  // Rats on this grid ARE the den's content: a refused warp with them already
  // in front of the ship means it is standing in the thing it tried to fly to.
  alreadyHere: (obs) => obs.hostileOnGrid,
};

const ORE_FLAVOUR: AnomalyFlavour = {
  matches: (site) => site.kind === "ore" && !isIceSite(site),
  boardKey: "oreAnomsVisited",
  noun: "ore site",
  oneNoun: "an ore site",
  flying: "Flying to the ore site",
  emptyScannerHint:
    "Rocks on the overview are not an ore site: an asteroid belt is not a scanner site, and Mine-at-a-belt is the block that works one.",
  givesUpOnSites: false,
  // ⚠ NOT FROM THE ROCK ON THE GRID, WHICH IS THE READING THIS MUST NEVER
  // MAKE: a plain asteroid belt looks identical from there, and the whole point
  // of `emptyScannerHint` is that the two get confused. The positions do not
  // have that problem — the scanner names where the SITE is and the snapshot
  // names where the SHIP is, and a belt is somewhere else entirely.
  //
  // It went from "cannot tell" to a real answer because "cannot tell" stopped
  // the bot every time: a pilot parked in the ore site from an earlier run had
  // that same site picked first on the next one, the server refused the warp
  // for standing in it, and the run ended on "The ship would not warp to the
  // ore site" with the rock in front of the ship.
  alreadyHere: shipStandsInSite,
};

const ICE_FLAVOUR: AnomalyFlavour = {
  matches: isIceSite,
  boardKey: "iceAnomsVisited",
  noun: "ice site",
  oneNoun: "an ice site",
  flying: "Flying to the ice site",
  emptyScannerHint:
    "Ice on the overview is not an ice site: an ice field is a cosmic anomaly, and only the scanner lists it.",
  givesUpOnSites: false,
  alreadyHere: shipStandsInSite,
};

// ── Why the dead end is THREE sentences and not one ──────────────────────────
// The block used to answer every dead end with "The scanner shows no <site>
// left to visit in this system", and that sentence is wrong in two of the three
// states it was used for — wrong enough that a pilot parked in a field of rock
// reads it as the bot failing to see what is plainly on the screen. The three:
//
//   • THE SCANNER LISTED NOTHING. The likeliest reason the pilot disagrees is
//     that they are reading the OVERVIEW, which lists what is on THIS GRID —
//     belt asteroids, rats, wrecks — and never lists a scanner site at all. So
//     the sentence says which of the two panels the block reads.
//   • IT LISTED SITES, NONE OF THIS KIND. Then the count is the useful fact and
//     the number of UNREADABLE rows is the most useful of all: a site whose
//     kind the server did not report is deliberately skipped (siteKind.ts), so
//     "three sites here and none of them says what it is" is a different
//     problem from "this system has no ore in it" and must not wear the same
//     words — the first is a server that is not filling the field in, and no
//     amount of flying around will fix it.
//   • EVERY SITE OF THIS KIND IS VISITED. Which is no longer a dead end at all
//     — see the lap note on `warpToAnomalyOfKind`.
function noSiteReason(flavour: AnomalyFlavour, total: number, unreadable: number): string {
  if (total === 0) {
    return `The scanner lists no cosmic anomaly in this system, so there is no ${flavour.noun} to fly to. ${flavour.emptyScannerHint}`;
  }
  const listed = total === 1 ? "1 cosmic anomaly" : `${total} cosmic anomalies`;
  const head = `The scanner lists ${listed} in this system, and not one of them is ${flavour.oneNoun}.`;
  if (unreadable === 0) {
    return head;
  }
  const which =
    unreadable === total
      ? total === 1
        ? "It did not say"
        : "None of them said"
      : unreadable === 1
        ? "One of them did not say"
        : `${unreadable} of them did not say`;
  return `${head} ${which} what kind of site it is, and this block will not warp on a guess.`;
}

/**
 * The FOURTH dead end, and the one §13 added: every site of this kind is one the
 * run has already given up on.
 *
 * It wears its own sentence for the same reason the other three do — it is a
 * different problem with a different fix. "There is no den here" is answered by
 * moving the bot; "every den here has beaten me" is answered by moving the bot
 * OR by flying something that can clear them, and the player cannot choose
 * between those if the block says the same words for both. §13's rule for the
 * whole feature: name which evidence fired, because a generic "site too hard"
 * teaches the player nothing.
 *
 * It is deliberately not silent. The alternative to stopping here is touring the
 * same three dens all night, which is the loop the feature exists to close.
 */
function allGivenUpReason(flavour: AnomalyFlavour, total: number): string {
  const listed =
    total === 1
      ? `The only ${flavour.noun} the scanner lists in this system is one I have given up on`
      : `All ${total} ${flavour.noun}s the scanner lists in this system are ones I have given up on`;
  return `${listed} — nothing was dying in there, or it kept sending the ship home. Move the bot to another system, or fly something that can clear them.`;
}

/** A mining tour whose every listed site refused the warp: the server had torn them down, emptied. */
function minedOutReason(flavour: AnomalyFlavour, words?: string): string {
  const said = words === undefined ? "" : ` It said: ${words}`;
  return `Every ${flavour.noun} in this system is mined out: the server would not take the ship to any site the scanner still listed.${said}`;
}

/** A mining site the server keeps refusing while the scanner keeps listing it: not mined out, and said so. */
function siteStillListedReason(noun: string, site: string, words: string | null, rejoined: boolean): string {
  const said = words === null ? "" : ` It said: ${words}`;
  return rejoined
    ? `The server still would not let the ship warp to the ${noun} ${site} after docking and undocking, though the scanner still lists it.${said}`
    : `The server would not let the ship warp to the ${noun} ${site}, though the scanner still lists it and the ship is not in it.${said} ` +
      "This bot does not know which station is home, so it cannot dock to clear that and try again.";
}

/**
 * The run's one way out of a pocket the server will not let the ship leave by
 * warping back in: dock, undock, try again. Docking clears the ship's site
 * tracker (observed live: the pilot refused at the field warped straight in
 * after a dock). `rejoined` survives the trip so a second refusal stops the
 * bot instead of commuting forever.
 */
const REJOINED: MacroMemory = { rejoined: true };
function rejoinedCarry(mem: MacroMemory): MacroMemory {
  return flag(mem, "rejoined") ? REJOINED : {};
}

/** `mem` with `keys` dropped. */
function without(mem: MacroMemory, ...keys: readonly string[]): MacroMemory {
  return Object.fromEntries(Object.entries(mem).filter(([key]) => !keys.includes(key)));
}

/** The doubted site and what the server said about it, carried through the trip. */
function doubtMem(doubted: string | null, words: string | null): MacroMemory {
  return { ...(doubted !== null ? { doubted } : {}), ...(words !== null ? { doubtWords: words } : {}) };
}

/**
 * One tick of the dock-and-retry trip: its tick, `"out"` on the first tick
 * back in space (the caller resumes from `doubted`), or null when no trip is
 * under way. `rejoin` is "home" while flying to dock and "undock" once the
 * undock is issued: the undock commits before the ship is in space, so the
 * next ticks still read docked and must press it again.
 */
function rejoinTrip(obs: ScriptObservation, mem: MacroMemory, noun: string): MacroTick | "out" | null {
  const rejoin = label(mem, "rejoin");
  if (rejoin === null) {
    return null;
  }
  const doubted = label(mem, "doubted");
  const words = label(mem, "doubtWords");
  if (obs.flightStatus?.docked === true) {
    return tick({ kind: "undock" }, `Docked. Undocking to try the ${noun} again.`, "Rejoining", ACTING, false, {
      rejoin: "undock",
      ...REJOINED,
      ...doubtMem(doubted, words),
    });
  }
  if (rejoin === "undock") {
    return "out";
  }
  const home = obs.homeStationID ?? null;
  if (home === null) {
    return tick(WAIT, "Home is not known.", "Rejoining", {
      kind: "blocked",
      reason: siteStillListedReason(noun, doubted ?? `the ${noun}`, words, false),
    });
  }
  const recall = recallBeforeLeaving(obs, mem, "Rejoining", null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, home, "Rejoining", obs.homeDockableKind ?? "station");
  if (ride === null || ride.outcome.kind === "blocked") {
    return ride ?? tick(WAIT, "Docking.", "Rejoining", ACTING, false, mem);
  }
  return { ...ride, nextMem: mem };
}

/**
 * One read of the scanner about `doubted`, the last site of its kind left and
 * refused: `"gone"` once the scanner stops listing it (the caller's verdict),
 * otherwise the tick to return — another read, the trip, or an honest stop.
 */
function readDoubtedSite(obs: ScriptObservation, mem: MacroMemory, noun: string, doubted: string, listed: boolean): MacroTick | "gone" {
  if (!listed) {
    return "gone";
  }
  const reads = (num(mem, "doubtReads") ?? 0) + 1;
  if (reads < SITE_GONE_CONFIRM_READS) {
    return tick(WAIT, `The ${noun} refused the ship. Checking the scanner still lists it.`, "Scanning", ACTING, false, {
      ...mem,
      doubtReads: reads,
    });
  }
  const words = label(mem, "doubtWords");
  if (flag(mem, "rejoined") || (obs.homeStationID ?? null) === null) {
    return tick(WAIT, `The ${noun} is still listed and still refuses the ship.`, "Scanning", {
      kind: "blocked",
      reason: siteStillListedReason(noun, doubted, words, flag(mem, "rejoined")),
    });
  }
  return tick(
    WAIT,
    `The ${noun} is still listed, so it is not mined out: the server is holding the ship. Docking to clear that, then coming back.`,
    "Rejoining",
    ACTING,
    false,
    { rejoin: "home", ...doubtMem(doubted, words) },
  );
}

function warpToAnomalyOfKind(
  flavour: AnomalyFlavour,
): MacroDecider {
  return (step, obs, mem, board) => {
    // The dock-and-retry trip (see SITE_GONE_CONFIRM_READS) comes before
    // "Undock first": it is the one thing this block does while docked. Back
    // out, the tour simply picks again.
    const trip = rejoinTrip(obs, mem, flavour.noun);
    if (trip === "out") {
      mem = REJOINED;
    } else if (trip !== null) {
      return trip;
    }
    if (obs.flightStatus?.docked === true) {
      return tick(WAIT, "Docked — there is no scanner to fly on from here.", "Scanning", {
        kind: "blocked",
        reason: "Undock first — put a Leave-the-station block before this one.",
      });
    }
    if (flag(mem, "issued")) {
      if (obs.inWarp === true) {
        return tick(WAIT, `In warp to the ${flavour.noun}.`, flavour.flying, ACTING, false, { ...mem, sawWarp: true });
      }
      if (warpLanded(obs, mem)) {
        return tick(WAIT, `Arrived at the ${flavour.noun}.`, "Arrived", { kind: "done" });
      }
      // A refused warp is read BEFORE the press, from the target committed by the
      // phase-1 tick below, so there is nothing to read for it on this path: a
      // refused issue commits nothing, and `issued` therefore never gets set.
      const waited = (num(mem, "waited") ?? 0) + 1;
      if (waited > WARP_START_WAIT_TICKS) {
        return tick(WAIT, "The warp never started.", "Scanning", {
          kind: "blocked",
          reason: `The ship would not warp to the ${flavour.noun}, so the bot stopped.`,
        });
      }
      return tick(WAIT, "Waiting for the warp to start.", flavour.flying, ACTING, false, { ...mem, waited });
    }
    const anomalies = obs.anomalies ?? null;
    if (anomalies === null) {
      return tick(WAIT, "Reading the scanner.", "Scanning", ACTING, false, mem);
    }
    if (anomalies.length === 0) {
      const emptyReads = (num(mem, "emptyReads") ?? 0) + 1;
      if (emptyReads < EMPTY_SCAN_CONFIRM_READS) {
        return tick(WAIT, "The scanner came back empty — reading it again.", "Scanning", ACTING, false, {
          ...mem,
          emptyReads,
        });
      }
      return tick(WAIT, "The scanner lists nothing in this system.", "Scanning", {
        kind: "blocked",
        reason: noSiteReason(flavour, 0, 0),
      });
    }
    const ofKind = anomalies.filter(flavour.matches);
    // ── The last mining site refused: is it gone, or is it the server? ──────
    const doubted = label(mem, "doubted");
    if (doubted !== null) {
      const read = readDoubtedSite(obs, mem, flavour.noun, doubted, ofKind.some((site) => site.label === doubted));
      if (read !== "gone") {
        return read;
      }
      // Gone from the scanner: it really was torn down.
      const setAside = [...listOf(mem, "refused"), doubted];
      if (pickSite(anomalies, board, setAside) === null) {
        return tick(WAIT, `The ${flavour.noun} left the scanner.`, "Scanning", {
          kind: "blocked",
          reason: minedOutReason(flavour, label(mem, "doubtWords") ?? undefined),
        });
      }
      return tick(WAIT, `The ${flavour.noun} left the scanner. Choosing another.`, "Scanning", ACTING, false, {
        refused: setAside.join(","),
        ...rejoinedCarry(mem),
      });
    }
    // ── PHASE 2: a site is committed — read what became of the last warp, or press ──
    //
    // ⚠ THE TARGET IS COMMITTED BY A WAIT TICK BEFORE THE WARP IS ISSUED, AND THAT
    // IS THE WHOLE DESIGN. The runner commits a block's memory only when its
    // action succeeds (2fd4a77), so a refused warp leaves the memory exactly as
    // the issuing tick found it: anything the block must know AFTER a refusal —
    // which site it asked for, what the ledger said before — has to be written
    // by an earlier tick, before the press. Writing it on the issuing tick
    // (the old `issued` + `target`) is unreachable under the real runner.
    const target = label(mem, "target");
    if (target !== null) {
      const refused = listOf(mem, "refused");
      // ⚠ A REFUSED WARP IS NOT A SLOW ONE, AND THIS BLOCK USED TO CALL IT ONE.
      // It issued the warp, never looked at what came back, and waited out
      // WARP_START_WAIT_TICKS before stopping the bot with "the warp never
      // started" — a sentence that sends the reader looking at the ship when the
      // server had already said no, in the log, on the first tick.
      //
      // It happened for real: four pilots were parked INSIDE the den they had
      // been stranded in, so "warp to the den" came back WARP_DISTANCE_TOO_CLOSE
      // — already there — and all four stopped rather than fighting the rats in
      // front of them.
      // ⚠ ONLY A REFUSAL NEWER THAN THE BASELINE PHASE 1 COMMITTED. The ledger keys
      // on step and action with no target, and a record lives until a SUCCESS
      // clears it — so a record left from an earlier visit to this step, or from
      // a site already set aside, would otherwise be read as a refusal of a warp
      // that was never issued.
      const refusal = refusalFor(obs.refusals, step.id, "warpScan", null);
      if (refusal !== null && refusal.count > (num(mem, "refusalsSeen") ?? 0)) {
        // ⚠ AND THE REFUSAL CANNOT SAY WHICH ONE IT IS. `_throwWarpFailureUserError`
        // names six blockers and drops the rest — WARP_DISTANCE_TOO_CLOSE and
        // SCAN_TARGET_NOT_FOUND both among them — into one "You cannot warp there
        // right now." Standing in the site and the site having gone arrive in the
        // SAME WORDS, so the wording is no help and the grid has to answer.
        if (flavour.alreadyHere(obs, target) === true) {
          // The patch rides the done tick: `currentOreSiteLabel` reads the last
          // visited label, and the block after this one needs it. A refused issue
          // commits no patch of its own any more.
          return {
            ...tick(WAIT, `Already in the ${flavour.noun} — working it from here.`, "Arrived", { kind: "done" }),
            boardPatch: arrivalPatch(target, board).patch,
          };
        }
        // ⚠ A SITE THAT WAS JUST MINED OUT IS STILL ON THE SCANNER FOR A MOMENT.
        // It happened for real: a pilot came back from unloading, read the
        // scanner while the site the rest of the fleet had just emptied was
        // still listed, and warped at it. The server had already torn it down
        // and refused (DUNGEON_INSTANCE_NOT_AUTHORIZED, which it words as "not
        // scanned down"), and the pilot stopped while the others flew on to the
        // next site. A refused site is set aside for this step and the pick runs
        // again. The bot only stops when no site of this kind is left to try.
        const setAside = [...refused, target];
        if (pickSite(anomalies, board, setAside) !== null) {
          return tick(WAIT, `The ${flavour.noun} could not be warped to — trying another.`, "Scanning", ACTING, false, {
            refused: setAside.join(","),
            refusalsSeen: refusal.count,
            ...rejoinedCarry(mem),
          });
        }
        if (!flavour.givesUpOnSites) {
          // The last one left: see SITE_GONE_CONFIRM_READS before calling it mined out.
          return tick(WAIT, `The ${flavour.noun} refused the ship. Checking the scanner still lists it.`, "Scanning", ACTING, false, {
            doubted: target,
            doubtReads: 0,
            doubtWords: refusal.words,
            ...(refused.length > 0 ? { refused: refused.join(",") } : {}),
            ...rejoinedCarry(mem),
          });
        }
        // Cannot tell, or told no, and nowhere else to go. Stop — but with what
        // the SERVER said, not with a guess about the warp never starting.
        // (A mining tour never reaches here: it re-reads the scanner above.)
        // `blocked` flies the ship home before it stops.
        return tick(WAIT, `The ${flavour.noun} could not be warped to.`, "Scanning", {
          kind: "blocked",
          reason: `The ship would not warp to the ${flavour.noun}: ${refusal.words} ` +
            "If the ship is already sitting in it, there was nothing left to fly to.",
        });
      }
      const carried: MacroMemory = {
        ...(refused.length > 0 ? { refused: refused.join(",") } : {}),
        ...(num(mem, "refusalsSeen") !== null ? { refusalsSeen: num(mem, "refusalsSeen") } : {}),
        ...rejoinedCarry(mem),
      };
      // The scanner moved on under the committed target (a site mined out and
      // torn down in the meantime): drop it and let phase 1 pick again.
      if (!ofKind.some((site) => site.label === target)) {
        return tick(WAIT, `The ${flavour.noun} left the scanner — choosing another.`, "Scanning", ACTING, false, carried);
      }
      const { patch, lapRestart } = arrivalPatch(target, board);
      return {
        ...tick(
          { kind: "warpScan", target },
          lapRestart
            ? `Every ${flavour.noun} here has been worked once, so starting another lap.`
            : `Warping to the next ${flavour.noun}.`,
          flavour.flying,
          ACTING,
          false,
          { ...warpIssuedMem(obs, target), ...carried },
        ),
        boardPatch: patch,
      };
    }
    // ── §13: the sites this run has given up on ────────────────────────────
    //
    // ⚠ THIS IS WHERE THE ARRIVAL COUNT BELONGS, AND IT IS NOT A STYLE CHOICE.
    // The obvious home for "have I already counted this visit?" is the combat
    // block's own step memory — and it is WRONG, provably so: after a
    // dock-and-repair the runner resumes at the very step it was interrupted on
    // and carries `macroMem` across (scriptDecide.ts keeps every key but the
    // home/repair ones), so the flag SURVIVES the round trip and the return is
    // never counted. Zero returns recorded, for precisely the loop the feature
    // exists to catch. This block has no such problem: it is the thing that
    // issued the warp, so an arrival is simply the tick it commits to a label —
    // the same tick it already writes that label into `anomsVisited`.
    const refused = listOf(mem, "refused");
    const pick = pickSite(anomalies, board, refused);
    if (pick === null) {
      // Two different dead ends now share this branch, and they must not share a
      // sentence: "there is no site of this kind here" (the scanner's fault, or
      // the system's) and "there are, and the run has given up on every one of
      // them" (§13's stop). A third joins them when the scanner changed after a
      // refusal and only refused sites are left.
      if (ofKind.length > 0 && ofKind.every((site) => refused.includes(site.label))) {
        return tick(WAIT, `No ${flavour.noun} here would take the ship.`, "Scanning", {
          kind: "blocked",
          reason: flavour.givesUpOnSites
            ? `The ship would not warp to any ${flavour.noun} the scanner lists here, so the bot stopped.`
            : minedOutReason(flavour),
        });
      }
      if (ofKind.length > 0) {
        return tick(WAIT, `Every ${flavour.noun} here is one I have given up on.`, "Scanning", {
          kind: "blocked",
          reason: allGivenUpReason(flavour, ofKind.length),
        });
      }
      const unreadable = anomalies.filter((site) => site.kind === "unknown").length;
      return tick(WAIT, `Nothing on the scanner is ${flavour.oneNoun}.`, "Scanning", {
        kind: "blocked",
        reason: noSiteReason(flavour, anomalies.length, unreadable),
      });
    }
    // PHASE 1: commit the pick with a wait tick (no press, no board patch). The
    // baseline is the ledger count RIGHT NOW, so whatever record is already there
    // is never read as a refusal of the warp phase 2 is about to issue.
    const stale = refusalFor(obs.refusals, step.id, "warpScan", null)?.count ?? 0;
    return tick(WAIT, `Choosing the next ${flavour.noun} to warp to.`, "Scanning", ACTING, false, {
      target: pick.next.label,
      refusalsSeen: stale,
      ...(refused.length > 0 ? { refused: refused.join(",") } : {}),
      ...rejoinedCarry(mem),
    });
  };

  /**
   * The board patch the warp to `target` writes — on the issuing tick, and on the
   * done tick of a refused warp the ship turned out to be standing in.
   */
  function arrivalPatch(target: string, board: ScriptBoard) {
    const visited = visitedLabels(board);
    const lapRestart = visited.includes(target);
    const ledger = flavour.givesUpOnSites ? decodeLedger(board) : null;
    return {
      lapRestart,
      patch: {
        // ⚠ THE LAP RESTART WIPES `visited` AND MUST NEVER WIPE THE GIVEN-UP
        // LIST. The two lists answer two different questions — "have I worked
        // this site on THIS lap?" (which is meant to be forgotten, because one
        // pass does not finish a site) and "has this site beaten me?" (which is
        // meant to be remembered for the whole run). §13 calls a lap restart
        // that forgets the second one "the same loop closing again with extra
        // steps", and it is right: the tour would fly straight back into the den
        // it walked out of an hour ago.
        //
        // They are kept apart by LIVING APART: the lap list is this line, the
        // given-up list is inside the ledger's own `sites` key, and
        // `encodeLedger` below rewrites that key in full on every arrival —
        // counts and all — whether or not the lap restarted.
        [flavour.boardKey]: (lapRestart ? [target] : [...visited, target]).join(","),
        // Count the arrival, and publish WHICH SITE THIS IS: the combat block
        // has no other way to know. It reads this same ledger off the board at
        // the top of every tick and takes `siteLabel` from it, which is how a
        // verdict earned on this grid ends up attached to a scanner label
        // rather than to nobody.
        ...(ledger === null ? {} : encodeLedger(enterSite(ledger, target))),
      } as ScriptBoard,
    };
  }

  function visitedLabels(board: ScriptBoard): string[] {
    return String(board[flavour.boardKey] ?? "")
      .split(",")
      .filter((label) => label.length > 0);
  }

  /**
   * The next site to fly to, or null when there is none — skipping any site this
   * step has already been refused a warp to.
   */
  function pickSite(
    anomalies: NonNullable<ScriptObservation["anomalies"]>,
    board: ScriptBoard,
    refused: readonly string[],
  ) {
    const visited = visitedLabels(board);
    const ofKind = anomalies.filter((site) => flavour.matches(site) && !refused.includes(site.label));
    const ledger = flavour.givesUpOnSites ? decodeLedger(board) : null;
    const workable =
      ledger === null ? ofKind : ofKind.filter((site) => !isAbandoned(ledger, site.label));
    // A LAP, NOT A ONE-SHOT. `fresh` is undefined in two completely different
    // situations and the old code answered both by stopping: there is no site of
    // this kind here (a real dead end), or every one of them has been flown to
    // once (not a dead end at all). A site is not finished because the ship has
    // BEEN there — one miner does not empty an asteroid cluster in one hold, and
    // in a system holding a single ore site the visited list retired it after one
    // trip and stopped a bot that had barely scratched it. So a completed lap
    // wipes the list and starts the next one, and the run now ends where it
    // should: at Mine-at-a-belt, which is the block that can actually see there
    // is no rock left and says so.
    const fresh = workable.find((site) => !visited.includes(site.label));
    const next = fresh ?? workable[0];
    if (next === undefined) {
      return null;
    }
    return { next, lapRestart: fresh === undefined, visited, ledger };
  }
}

const warpToAnomaly: MacroDecider = warpToAnomalyOfKind(COMBAT_FLAVOUR);
const warpToOreAnomalyBase: MacroDecider = warpToAnomalyOfKind(ORE_FLAVOUR);
const warpToIceAnomaly: MacroDecider = warpToAnomalyOfKind(ICE_FLAVOUR);
const warpToOreAnomaly: MacroDecider = (step, obs, mem, board) => {
  if (obs.miningOperation == null) return warpToOreAnomalyBase(step, obs, mem, board);
  const target = obs.miningOperation.currentTarget;
  if (target && ["DEPLETED", "DRAINING"].includes(target.state)) {
    return tick(WAIT, "Completing the miner clearance barrier.", "Relocating", { kind: "done" });
  }
  return operationSiteTravel(obs, mem, "ORE_ANOMALY");
};


// ── refit-ship ───────────────────────────────────────────────────────────────
// The "reship and go" block, docked only: find the saved fitting BY NAME (the id
// is only a same-world hint), board a hull of its ship type from the hangar if
// the active ship is something else, then apply the fitting. Confirmed by
// re-read at each stage: boarding by the active ship's type changing, and the
// apply is issued once (the server pulls modules from this hangar). The library
// is the pilot's own fits followed by the session corp's (flow.ts
// loadRefitLibrary), so a name both use resolves to the pilot's own.
const CATEGORY_SHIP_ROW = 6;
// The hull refit-ship boarded AWAY from, for board-previous-ship to go back to.
// Written only when refit-ship actually swaps hulls, and never over a value
// already there: a run that refits twice goes back to the ship it started in.
const PREVIOUS_SHIP_BOARD_KEY = "shipBeforeRefit";

const refitShip: MacroDecider = (step, obs, mem, board) => {
  if (obs.flightStatus?.docked !== true) {
    // In space: a ship already in the fit has nothing to do. Otherwise fly home
    // and dock, and refit from the home hangar on arrival. (Blocking here sent
    // the run on a safety trip that docked and then stopped, never refitting.)
    if (refitLanded(step, obs) === true) {
      return tick(WAIT, "The fitting is in place.", "Refitting", { kind: "done" });
    }
    const home = obs.homeStationID ?? null;
    if (home === null) {
      return tick(WAIT, "Home is not known.", "Refitting", {
        kind: "blocked",
        reason: "This bot does not know which station is home, so it cannot fly there to refit.",
      });
    }
    const recall = recallBeforeLeaving(obs, mem, "Refitting", null);
    if (recall !== null) {
      return recall;
    }
    return rideAutopilotTo(obs, home, "Refitting", obs.homeDockableKind ?? "station") ??
      tick(WAIT, "Docking at home to refit.", "Refitting", ACTING, false, mem);
  }
  const arg = step.args["fitting"];
  if (arg === undefined || arg.kind !== "fitting" || (arg.fittingID === null && (arg.name === null || arg.name === ""))) {
    return tick(WAIT, "No fitting picked.", "Refitting", {
      kind: "blocked",
      reason: "Pick the saved fitting this step should apply.",
    });
  }
  const library = obs.savedFittings ?? null;
  if (library === null) {
    return tick(WAIT, "Reading your and your corporation's saved fittings.", "Refitting", ACTING, false, mem);
  }
  const fitting =
    library.find((f) => arg.name !== null && f.name === arg.name) ??
    library.find((f) => arg.fittingID !== null && f.fittingID === arg.fittingID) ??
    null;
  if (fitting === null) {
    return tick(WAIT, "That fitting is not in your or your corporation's library.", "Refitting", {
      kind: "blocked",
      reason: `There is no saved fitting called ${arg.name ?? "that"} in your fittings or your corporation's.`,
    });
  }
  const hangar = obs.stationHangar ?? null;
  const activeShipID = obs.activeShipID ?? null;
  if (hangar === null || activeShipID === null) {
    return tick(WAIT, "Reading the hangar.", "Refitting", ACTING, false, mem);
  }
  const activeRow = hangar.find((row) => row.itemID === activeShipID) ?? null;
  const activeTypeID = activeRow?.typeID ?? null;
  if (activeTypeID !== fitting.shipTypeID) {
    // Wrong hull (or the active ship's row is unreadable): board the right one.
    const candidate = hangar.find(
      (row) => row.categoryID === CATEGORY_SHIP_ROW && row.typeID === fitting.shipTypeID && row.itemID !== activeShipID && row.singleton,
    );
    if (candidate === undefined) {
      return tick(WAIT, "No hull of the fitting's ship type here.", "Refitting", {
        kind: "blocked",
        reason: "There is no ship of that fitting's type in this hangar to board.",
      });
    }
    const boards = (num(mem, "boards") ?? 0) + 1;
    if (boards > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "Boarding kept not landing.", "Refitting", {
        kind: "blocked",
        reason: "The ship swap kept not taking, so the bot stopped.",
      });
    }
    const boarding = tick({ kind: "boardShip", shipID: candidate.itemID }, "Boarding the right hull.", "Refitting", ACTING, false, {
      ...mem,
      boards,
    });
    const recorded = board[PREVIOUS_SHIP_BOARD_KEY];
    return typeof recorded === "number" && recorded > 0
      ? boarding
      : withBoardPatch(boarding, { [PREVIOUS_SHIP_BOARD_KEY]: activeShipID });
  }
  // ⚠ DONE MEANS SEEN FITTED, NOT "THE APPLY WAS SENT". A sent apply that
  // fitted nothing used to read as done, and the ship undocked with its old
  // modules. The fitted slots are re-read; rigs are never part of the check.
  const landed = refitLanded(step, obs);
  if (landed === true) {
    return tick(WAIT, "The fitting is in place.", "Refitting", { kind: "done" });
  }
  if (flag(mem, "applied")) {
    const checks = (num(mem, "checks") ?? 0) + 1;
    if (checks > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "The fitting did not land.", "Refitting", {
        kind: "blocked",
        reason: `The ship is still not fitted as ${fitting.name} after applying it, so the bot stopped before leaving.`,
      });
    }
    return tick(WAIT, "Checking the fitting landed.", "Refitting", ACTING, false, { ...mem, checks });
  }
  const fitted = obs.activeFitting ?? null;
  if (landed === null || fitted === null) {
    return tick(WAIT, "Reading what the ship has fitted.", "Refitting", ACTING, false, mem);
  }
  // Refuse up front, before anything moves, when this hangar cannot supply the fit.
  const short = planFittingApply(fitting, hangar, fitted.modules).missing.reduce((sum, m) => sum + m.count, 0);
  if (short > 0) {
    return tick(WAIT, "Modules missing from the hangar.", "Refitting", {
      kind: "blocked",
      reason: `This hangar is ${short} module${short === 1 ? "" : "s"} short of ${fitting.name}, so the ship was not refitted.`,
    });
  }
  return tick(
    { kind: "applyFitting", fittingID: fitting.fittingID },
    `Applying ${fitting.name}.`,
    "Refitting",
    ACTING,
    false,
    { ...mem, applied: true },
  );
};

// ── move-items ───────────────────────────────────────────────────────────────
// The generic logistics block, docked only: move a picked ITEM between the
// hangar, the cargo hold and the ore hold — a set amount (split off one stack
// per tick) or every stack of it. Confirmed by re-read: done only when the FROM
// place shows the job finished. Unknown rows never count as the item.
const movePlaceRows = (obs: ScriptObservation, place: string): readonly { itemID: number; typeID: number; quantity: number }[] | null => {
  if (place === "hangar") {
    return obs.stationHangar ?? null;
  }
  if (place === "cargo") {
    return obs.cargo?.rows ?? null;
  }
  // ore-hold: the mining-holds read, its "ore" (first specialty) hold.
  const holds = obs.holds ?? null;
  if (!freightReadable(holds)) {
    return null;
  }
  const ore = holds.find((hold) => hold.key !== "cargo" && hold.present) ?? null;
  return ore === null ? [] : ore.items;
};

const moveItems: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - moving cargo happens in a station.", "Moving items", {
      kind: "blocked",
      reason: "Dock at a station first - this block moves items between your hangar and holds.",
    });
  }
  const item = step.args["item"];
  const from = step.args["from"];
  const to = step.args["to"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    from === undefined || from.kind !== "place" ||
    to === undefined || to.kind !== "place" || from.place === to.place
  ) {
    return tick(WAIT, "This step is not fully set up.", "Moving items", {
      kind: "blocked",
      reason: "Pick the item, where it is, and where it goes (two different places).",
    });
  }
  const rows = movePlaceRows(obs, from.place);
  if (rows === null) {
    return tick(WAIT, "Reading what is where.", "Moving items", ACTING, false, mem);
  }
  const stacks = rows.filter((row) => row.typeID === item.typeID);
  const wanted = countArg(step, "amount");
  const movedSoFar = num(mem, "moved") ?? 0;
  const remaining = wanted === null ? null : Math.max(0, wanted - movedSoFar);
  if (stacks.length === 0 || remaining === 0) {
    if (movedSoFar > 0 || stacks.length === 0) {
      return tick(WAIT, "The move is finished.", "Moving items", { kind: "done" });
    }
  }
  if (stacks.length === 0) {
    return tick(WAIT, "None of that item is there.", "Moving items", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The items would not move.", "Moving items", {
      kind: "blocked",
      reason: "The station kept refusing to move those items, so the bot stopped.",
    });
  }
  if (remaining === null) {
    // Move EVERY stack of it in one go; confirm next tick by the FROM re-read.
    return tick(
      { kind: "moveItems", itemIDs: stacks.map((row) => row.itemID), from: from.place, to: to.place, qty: null },
      "Moving it all over.",
      "Moving items",
      ACTING,
      false,
      { ...mem, attempts, moved: movedSoFar },
    );
  }
  // A set amount: one stack per tick, splitting when the stack is bigger.
  const stack = stacks[0]!;
  const take = Math.min(stack.quantity, remaining);
  return tick(
    { kind: "moveItems", itemIDs: [stack.itemID], from: from.place, to: to.place, qty: take < stack.quantity ? take : null },
    `Moving ${take.toLocaleString()} over.`,
    "Moving items",
    ACTING,
    false,
    { ...mem, attempts, moved: movedSoFar + take },
  );
};

// ── warp-to-bookmark ─────────────────────────────────────────────────────────
// Warp to a saved spot, matched BY NAME from the live bookmark list (the id is a
// same-world hint). In-space only, and only in the spot's own system — a saved
// spot two systems over needs a travel block first, and the block says so.
const warpToBookmark: MacroDecider = (step, obs, mem) => {
  const arg = step.args["bookmark"];
  if (arg === undefined || arg.kind !== "bookmark" || (arg.bookmarkID === null && (arg.name === null || arg.name === ""))) {
    return tick(WAIT, "No saved spot picked.", "Warping", {
      kind: "blocked",
      reason: "Pick the saved spot this step warps to.",
    });
  }
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - warping happens in space.", "Warping", {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  if (flag(mem, "issued")) {
    if (obs.inWarp === true) {
      return tick(WAIT, "In warp to the spot.", "Warping", ACTING, false, { ...mem, sawWarp: true });
    }
    if (warpLanded(obs, mem)) {
      return tick(WAIT, "Arrived at the spot.", "Arrived", { kind: "done" });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > 10) {
      return tick(WAIT, "The warp never started.", "Warping", {
        kind: "blocked",
        reason: "The ship would not warp to that spot, so the bot stopped.",
      });
    }
    return tick(WAIT, "Waiting for the warp to start.", "Warping", ACTING, false, { ...mem, waited });
  }
  const list = obs.bookmarks ?? null;
  if (list === null) {
    return tick(WAIT, "Reading your saved spots.", "Warping", ACTING, false, mem);
  }
  const match =
    list.find((bm) => arg.name !== null && bm.name === arg.name) ??
    list.find((bm) => arg.bookmarkID !== null && bm.bookmarkID === arg.bookmarkID) ??
    null;
  if (match === null) {
    return tick(WAIT, "That saved spot is not in your list.", "Warping", {
      kind: "blocked",
      reason: `There is no saved spot called ${arg.name ?? "that"} in your bookmarks.`,
    });
  }
  const here = obs.flightStatus?.solarSystemID ?? null;
  if (match.solarSystemID !== null && here !== null && match.solarSystemID !== here) {
    return tick(WAIT, "That spot is in another system.", "Warping", {
      kind: "blocked",
      reason: "That saved spot is in another system - put a travel block before this one.",
    });
  }
  return tick({ kind: "warpBookmark", bookmarkID: match.bookmarkID }, "Warping to the spot.", "Warping", ACTING, false, warpIssuedMem(obs));
};

// ── fly-to-mission-site ──────────────────────────────────────────────────────
// Warp to the accepted mission's own marked spot: the bookmark the agent filed
// under "Agent Missions". Prefers a bookmark with real coordinates (the site
// itself) over an agent-base marker; in-system only, with a plain travel hint
// otherwise. Done when the warp lands.
const MISSION_FOLDER = "agent missions";

const flyToMissionSite: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - warping happens in space.", "Flying to the site", {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  if (flag(mem, "issued")) {
    if (obs.inWarp === true) {
      return tick(WAIT, "In warp to the mission site.", "Flying to the site", ACTING, false, { ...mem, sawWarp: true });
    }
    if (warpLanded(obs, mem)) {
      return tick(WAIT, "Arrived at the mission site.", "Arrived", { kind: "done" });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > 10) {
      return tick(WAIT, "The warp never started.", "Flying to the site", {
        kind: "blocked",
        reason: "The ship would not warp to the mission site, so the bot stopped.",
      });
    }
    return tick(WAIT, "Waiting for the warp to start.", "Flying to the site", ACTING, false, { ...mem, waited });
  }
  const list = obs.bookmarks ?? null;
  if (list === null) {
    return tick(WAIT, "Reading the mission's marked spots.", "Flying to the site", ACTING, false, mem);
  }
  const missionMarks = list.filter(
    (bm) => (bm.folderName ?? "").trim().toLowerCase() === MISSION_FOLDER,
  );
  if (missionMarks.length === 0) {
    return tick(WAIT, "The agent has marked no spot.", "Flying to the site", {
      kind: "blocked",
      reason: "There is no mission spot marked - accept a mission first.",
    });
  }
  const here = obs.flightStatus?.solarSystemID ?? null;
  const inSystem = missionMarks.filter((bm) => bm.solarSystemID === null || here === null || bm.solarSystemID === here);
  if (inSystem.length === 0) {
    return tick(WAIT, "The mission site is in another system.", "Flying to the site", {
      kind: "blocked",
      reason: "The mission site is in another system - put a travel block before this one.",
    });
  }
  const pick = inSystem.find((bm) => bm.hasSpot === true) ?? inSystem[0]!;
  return tick({ kind: "warpBookmark", bookmarkID: pick.bookmarkID }, "Warping to the mission site.", "Flying to the site", ACTING, false, warpIssuedMem(obs));
};

// ── restart-extractors ───────────────────────────────────────────────────────
// Walk every colony and restart each extractor whose program has EXPIRED — on
// the SAME resource it was already pulling, over the SAME drill area (never a
// guess — the area is what sets how long the program runs). One restart per
// tick, confirmed by the next colonies re-read (the expiry moves into the
// future); a pin with no known last resource or area is left alone and said so.
//
// ⚠ A RESTART THAT DID NOT TAKE ENDS THE RUN BLOCKED, NOT DONE. Each pin is
// tried once per run, so after the walk every tried pin must read as running
// again. One still expired was refused — and a run that tried four extractors,
// had all four refused and then said "Every extractor is running." is exactly
// what this used to do.
const restartExtractors: MacroDecider = (_step, obs, mem) => {
  const colonies = obs.colonies ?? null;
  if (colonies === null) {
    return tick(WAIT, "Reading your planet colonies.", "Restarting extractors", ACTING, false, mem);
  }
  if (colonies.length === 0) {
    return tick(WAIT, "You have no planet colonies.", "Restarting extractors", { kind: "done" });
  }
  const now = Date.now();
  // ⚠ THE CAP IS SIZED TO THE ROSTER. Restarts and reroutes share one count of
  // actions, and each extractor can take at most one of each per run (both
  // are tried once per pin). A fixed cap stopped a roster of twelve expired
  // extractors on its 21st action with every edit having landed; this one
  // only ever stops a run that is somehow repeating itself.
  const budget = 2 * colonies.reduce((total, colony) => total + colony.extractors.length, 0) + MAX_BLOCK_ATTEMPTS;
  const doneRaw = mem["restarted"];
  const restarted = new Set<number>(Array.isArray(doneRaw) ? (doneRaw as number[]) : []);
  let skippedUnknown = 0;
  for (const colony of colonies) {
    for (const pin of colony.extractors) {
      if (restarted.has(pin.pinID)) {
        continue;
      }
      const expired = pin.expiresAtMs !== null && pin.expiresAtMs <= now;
      const neverRan = pin.expiresAtMs === null;
      if (!expired && !neverRan) {
        continue; // still running — leave it be
      }
      if (pin.resourceTypeID === null) {
        skippedUnknown += 1;
        continue; // no last resource to reuse — never guess what to pull
      }
      const headRadius = pin.headRadius ?? null;
      if (headRadius === null) {
        skippedUnknown += 1;
        continue; // no last drill area — never guess how long it should run
      }
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > budget) {
        return tick(WAIT, "The restarts kept not landing.", "Restarting extractors", {
          kind: "blocked",
          reason: "The extractor restarts kept not taking, so the bot stopped.",
        });
      }
      return tick(
        {
          kind: "restartExtractor",
          planetID: colony.planetID,
          pinID: pin.pinID,
          resourceTypeID: pin.resourceTypeID,
          headRadius,
        },
        colony.planetName !== null ? `Restarting an extractor at ${colony.planetName}.` : "Restarting an extractor.",
        "Restarting extractors",
        ACTING,
        false,
        { ...mem, attempts, restarted: [...restarted, pin.pinID] },
      );
    }
  }
  // Every tried pin must now read as running. This read is the one taken
  // AFTER the last restart, so a pin still expired here was refused.
  let notTaken = 0;
  for (const colony of colonies) {
    for (const pin of colony.extractors) {
      if (restarted.has(pin.pinID) && (pin.expiresAtMs === null || pin.expiresAtMs <= now)) {
        notTaken += 1;
      }
    }
  }
  if (notTaken > 0) {
    const noun = notTaken === 1 ? "restart" : "restarts";
    return tick(WAIT, `${notTaken} extractor ${noun} did not take.`, "Restarting extractors", {
      kind: "blocked",
      reason: `${notTaken} of ${restarted.size} extractor ${restarted.size === 1 ? "restart" : "restarts"} did not take - the server refused ${notTaken === 1 ? "it" : "them"}. The bot log names the reason.`,
    });
  }
  // ── Then the routes. A new program yields a different maximum cycle, and the
  // server never grows routes to fit it; the retail client re-sizes them in the
  // same edit as the install. So, once the restarts have landed and the new
  // maxima are stated, every extractor whose storage routes reserve less gets
  // them removed and recreated at the retail split - restarted this run or an
  // earlier one, since both leave the colony flagged in the game. Same rules
  // as the restarts: one per tick, each pin tried once, and one still short
  // after its edit was refused.
  const reroutedRaw = mem["rerouted"];
  const rerouted = new Set<number>(Array.isArray(reroutedRaw) ? (reroutedRaw as number[]) : []);
  for (const colony of colonies) {
    for (const plan of colony.reroutes ?? []) {
      if (rerouted.has(plan.pinID)) continue;
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > budget) {
        return tick(WAIT, "The reroutes kept not landing.", "Rerouting extractors", {
          kind: "blocked",
          reason: "The extractor reroutes kept not taking, so the bot stopped.",
        });
      }
      return tick(
        {
          kind: "rerouteExtractor",
          planetID: plan.planetID,
          pinID: plan.pinID,
          removeRouteIDs: plan.removeRouteIDs,
          create: plan.create,
        },
        colony.planetName !== null
          ? `Re-sizing an extractor's routes at ${colony.planetName}.`
          : "Re-sizing an extractor's routes.",
        "Rerouting extractors",
        ACTING,
        false,
        { ...mem, attempts, rerouted: [...rerouted, plan.pinID] },
      );
    }
  }
  let rerouteNotTaken = 0;
  for (const colony of colonies) {
    for (const plan of colony.reroutes ?? []) {
      if (rerouted.has(plan.pinID)) rerouteNotTaken += 1;
    }
  }
  if (rerouteNotTaken > 0) {
    const noun = rerouteNotTaken === 1 ? "reroute" : "reroutes";
    return tick(WAIT, `${rerouteNotTaken} extractor ${noun} did not take.`, "Rerouting extractors", {
      kind: "blocked",
      reason: `${rerouteNotTaken} extractor ${noun} did not take - the server refused ${rerouteNotTaken === 1 ? "it" : "them"}, so those routes still carry less than the program yields. The bot log names the reason.`,
    });
  }
  if (skippedUnknown > 0) {
    return tick(
      WAIT,
      `Done - ${skippedUnknown} extractor${skippedUnknown === 1 ? "" : "s"} had no previous programme to reuse and ${skippedUnknown === 1 ? "was" : "were"} left alone.`,
      "Restarting extractors",
      { kind: "done" },
    );
  }
  return tick(WAIT, "Every extractor is running.", "Restarting extractors", { kind: "done" });
};

// ── launch-commodities ───────────────────────────────────────────────────────
// Walk every colony and launch what its command centre is holding into orbit,
// one launch per tick. ONLY a "command" pin is ever targeted - the emulator
// refuses every other pin with CanOnlyLaunchFromCommandCenters, so a
// launchpad or storage pin sitting full of goods is left alone by design, no
// matter how full it reads. A centre inside 60s of its own last launch is
// refused with CannotLaunchCommandPinNotReady; that is not a block failure,
// just a "not yet" for this tick, so it is skipped without stopping the run.
// Fired centres are remembered in mem so the same one is not fired again
// before a fresh colonies re-read shows it emptied - exactly the guard
// restartExtractors keeps for restarted pins.
const launchCommodities: MacroDecider = (step, obs, mem) => {
  const colonies = obs.colonies ?? null;
  if (colonies === null) {
    return tick(WAIT, "Reading your planet colonies.", "Launching commodities", ACTING, false, mem);
  }
  if (colonies.length === 0) {
    return tick(WAIT, "You have no planet colonies.", "Launching commodities", { kind: "done" });
  }
  const now = Date.now();
  // ⚠ THE EDITOR'S OWN SENTENCE READS THIS SAME FUNCTION. The block's
  // description says "once it is N% full", and nothing bounds a count arg, so
  // a second clamp here would eventually drift from the one on screen - and a
  // bot doing something its own description denied is the defect that matters.
  const fullPercent = launchFullPercent(step.args["fullPercent"], step.args["anyAmount"]);
  const doneRaw = mem["launched"];
  const launched = new Set<number>(Array.isArray(doneRaw) ? (doneRaw as number[]) : []);
  // Limited to the colonies the step names, when it names any (the PI
  // window's Haul button does); absent, every colony, as it always was.
  const planetsArg = step.args["planets"];
  const only = planetsArg !== undefined && planetsArg.kind === "planetList" && planetsArg.planets.length > 0
    ? new Set(planetsArg.planets.map((planet) => planet.planetID))
    : null;
  let waitingOnCooldown = 0;
  for (const colony of colonies) {
    if (only !== null && !only.has(colony.planetID)) {
      continue;
    }
    for (const pin of colony.pins) {
      if (pin.kind !== "command") {
        continue; // goods reach orbit ONLY from the command centre - never a launchpad or storage pin
      }
      if (launched.has(pin.pinID)) {
        continue;
      }
      if (pin.contents.length === 0) {
        continue; // nothing aboard to launch
      }
      // ⚠ Both volumes may be null (bridge/planets.ts) - never divide then.
      // The contents check above already established "holding something",
      // which is the fallback answer when the fill fraction can't be stated.
      const ready =
        pin.capacityM3 !== null && pin.capacityM3 > 0 && pin.usedM3 !== null
          ? pin.usedM3 / pin.capacityM3 >= fullPercent / 100
          : true;
      if (!ready) {
        continue;
      }
      if (pin.lastLaunchAtMs !== null && now - pin.lastLaunchAtMs < 60_000) {
        waitingOnCooldown += 1;
        continue; // CannotLaunchCommandPinNotReady - not yet, not a block
      }
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > MAX_BLOCK_ATTEMPTS * 4) {
        return tick(WAIT, "The launches kept not landing.", "Launching commodities", {
          kind: "blocked",
          reason: "The commodity launches kept not taking, so the bot stopped.",
        });
      }
      const commodities: Record<number, number> = {};
      for (const item of pin.contents) {
        commodities[item.typeID] = item.quantity;
      }
      return tick(
        { kind: "launchCommodities", planetID: colony.planetID, commandPinID: pin.pinID, commodities },
        colony.planetName !== null ? `Launching commodities from ${colony.planetName}.` : "Launching commodities.",
        "Launching commodities",
        ACTING,
        false,
        { ...mem, attempts, launched: [...launched, pin.pinID] },
      );
    }
  }
  if (waitingOnCooldown > 0) {
    return tick(
      WAIT,
      `Waiting on ${waitingOnCooldown} command centre${waitingOnCooldown === 1 ? "" : "s"} to clear ${waitingOnCooldown === 1 ? "its" : "their"} launch cooldown.`,
      "Launching commodities",
      ACTING,
      false,
      mem,
    );
  }
  return tick(WAIT, "Every command centre is empty or below the launch threshold.", "Launching commodities", { kind: "done" });
};

// ── collect-launches ─────────────────────────────────────────────────────────
// The hauler's half of launch-commodities. A launch leaves a Planetary Launch
// Container (type 2263) in space, owned by the launching pilot, for five days.
// This block takes the pilot's own launch list, keeps the ones in THIS system,
// and for each one: warps to the container, closes inside loot range, and
// empties it into the ship (bay routing puts planetary goods in an Epithal's
// planetary hold). The dispatch then deletes the launch record once a re-read
// shows the container empty, so the next tick's list no longer carries it.
//
// ⚠ THE CONTAINER IS NOT ON THE PLANET'S GRID. The server puts it 2,500 km
// past the planet's surface (never under 10,000 km from its centre), in a
// direction hashed from the launch, so "warp to the planet" lands nowhere
// near it. The block warps to the container ITSELF: the server resolves a
// warp target system-wide (warpCommands.js warpToEntity), no grid needed.
//
// ⚠ A LAUNCH NOT FOUND WHERE IT SHOULD BE IS SET ASIDE, NOT A STOP. A launch
// that burned up, or a container the server never spawned, must not keep the
// rest of the system's launches from being collected.
const PI_LAUNCH_DECAY_MS = 5 * 24 * 60 * 60 * 1000;
// Retail will not warp to something this close; inside it, fly there.
const LAUNCH_WARP_MIN_M = 150_000;
// Ticks to keep looking for a container after landing on it before believing
// it is not there. Snapshots can trail a landing by a tick or two.
const LAUNCH_LANDED_SETTLE_TICKS = 10;

const collectLaunches: MacroDecider = (step, obs, mem) => {
  const phase = "Collecting launches";
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - launches are collected in space.", phase, {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp to a launch.", phase, ACTING, false, { ...mem, sawWarp: true });
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", phase, ACTING, false, mem);
  }
  // A full ship is a finished trip, exactly as on the loot blocks: go unload.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return tick(WAIT, "The ship is full, so it is time to unload.", phase, { kind: "done" });
  }
  if (shipHasNoRoom(obs.refusals, step.id, "collectLaunch")) {
    return tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", phase, { kind: "done" });
  }
  const launches = obs.piLaunches ?? null;
  if (launches === null) {
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS * 2) {
      return tick(WAIT, "Your planet launches could not be read.", phase, {
        kind: "blocked",
        reason: "Your planet launches could not be read, so the bot cannot tell what there is to collect.",
      });
    }
    return tick(WAIT, "Reading your planet launches.", phase, ACTING, false, { ...mem, blindChecks });
  }
  const here = snapshot.solarSystemID;
  const now = Date.now();
  const missingRaw = mem["missing"];
  const missing = new Set<number>(Array.isArray(missingRaw) ? (missingRaw as number[]) : []);
  const candidates = launches.filter(
    (launch) =>
      launch.solarSystemID === here &&
      launch.itemID > 0 &&
      !missing.has(launch.itemID) &&
      (launch.launchedAtMs === null || now - launch.launchedAtMs < PI_LAUNCH_DECAY_MS) &&
      !shouldSetAside(obs.refusals, step.id, "collectLaunch", launch.itemID, MAX_BLOCK_ATTEMPTS),
  );
  if (candidates.length === 0) {
    const elsewhere = launches.filter((launch) => launch.solarSystemID !== here).length;
    return tick(
      WAIT,
      elsewhere > 0
        ? `Every launch in this system is collected (${elsewhere} more in other systems).`
        : "Every launch in this system is collected.",
      phase,
      { kind: "done" },
    );
  }
  // Nearest first, by the server's own coordinates for each container.
  const origin = snapshot.ship?.position ?? null;
  const away = (launch: (typeof candidates)[number]): number =>
    origin === null ? 0 : distanceMeters(origin, { x: launch.x, y: launch.y, z: launch.z });
  const target = [...candidates].sort((a, b) => away(a) - away(b))[0]!;
  const measurement = measureSpace(snapshot);
  const onGrid = snapshot.entities.some((entity) => entity.itemID === target.itemID);
  const dist = onGrid
    ? (measurement?.distances.get(target.itemID) ?? away(target))
    : away(target);

  if (!onGrid || dist > LAUNCH_WARP_MIN_M) {
    if (num(mem, "warpingTo") === target.itemID && flag(mem, "issued")) {
      if (warpLanded(obs, mem)) {
        // Landed on it and still cannot see it: give the snapshot a moment,
        // then set this launch aside and go on to the next.
        const landedChecks = (num(mem, "landedChecks") ?? 0) + 1;
        if (landedChecks > LAUNCH_LANDED_SETTLE_TICKS) {
          return tick(WAIT, "That launch container is not where the list says - skipping it.", phase, ACTING, false, {
            missing: [...missing, target.itemID],
          });
        }
        return tick(WAIT, "Looking for the launch container.", phase, ACTING, false, { ...mem, landedChecks });
      }
      const waited = (num(mem, "waited") ?? 0) + 1;
      if (waited > 10) {
        return tick(WAIT, "The warp to that launch never started - skipping it.", phase, ACTING, false, {
          missing: [...missing, target.itemID],
        });
      }
      return tick(WAIT, "Waiting for the warp to start.", phase, ACTING, false, { ...mem, waited });
    }
    // Never warp off with drones still out.
    const recall = recallBeforeLeaving(obs, mem, phase, null);
    if (recall !== null) {
      return recall;
    }
    // As the client's journal warps to a launch: by the launch's own ID. A row
    // with no launch ID has only its container to name.
    return tick(
      target.launchID > 0 ? { kind: "warpLaunch", launchID: target.launchID } : { kind: "warp", targetID: target.itemID },
      "Warping to a launch container.",
      phase,
      ACTING,
      false,
      { missing: [...missing], warpingTo: target.itemID, ...warpIssuedMem(obs) },
    );
  }
  const memBase: MacroMemory = { missing: [...missing], approaching: num(mem, "approaching") };
  // The server's range check beats our arithmetic, as on loot-containers.
  const unreachable = isUnreachable(obs.refusals, step.id, "collectLaunch", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(mem, "approaching") === target.itemID) {
      const stall = closeInStall(measurement?.shipMode ?? null, { ...mem, ...memBase });
      if (stall.step === "reorder") {
        return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "unstick") {
        return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, phase, { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return tick(WAIT, "Flying to the launch container.", phase, ACTING, true, stall.mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for the launch container.",
      phase,
      ACTING,
      true,
      clearCloseInStall({ ...memBase, approaching: target.itemID }),
    );
  }
  return tick(
    { kind: "collectLaunch", containerID: target.itemID, launchID: target.launchID },
    "Taking the goods out of the launch container.",
    phase,
    ACTING,
    true,
    { ...memBase, approaching: null },
  );
};


// ── collect-customs ──────────────────────────────────────────────────────────
// The hauler's half of the customs-office export. A colony's launchpad goods go
// up into the planet's own customs office (the PI window's Haul button does that
// hop before the run starts, over the game port - see src/piCustomsExport.js),
// and this block empties every office in THIS system that holds goods of the
// pilot's into the ship.
//
// ⚠ AN OFFICE IS NOT A LAUNCH CONTAINER, which is why this is its own block.
// A launch container is spawned per launch, is listed by the server
// (GetMyLaunchesDetails), despawns when its record is deleted and decays in five
// days. An office is a STRUCTURE: there is one per planet, it is never listed as
// "something to collect", it does not vanish when emptied, and nothing says
// whether it holds anything without reading it. So "done" here is a READ saying
// every office in this system is empty, not a list running out.
//
// ⚠ EVERY OFFICE IN THE SYSTEM, NOT THE TICKED ONES. The block takes no args on
// purpose. The offices that hold anything are the ones something was exported
// into, and an office still holding goods from a lap that was interrupted is
// exactly what a hauler arriving here should pick up - naming colonies would
// walk past it. The office's own storage is partitioned by depositor server-side,
// so what it lists is this pilot's and nobody else's.
//
// ⚠ THE OFFICE IS FOUND BY GROUP, NEVER BY NAME OR POSITION. Group 1025 is
// Planetary Customs Offices, both the synthesized InterBus office every
// uncolonised planet carries and an anchored POCO; a gantry or a construction
// platform is a different group and holds nothing.
const GROUP_PLANETARY_CUSTOMS_OFFICES = 1025;
/**
 * Ticks to keep looking for an office before believing a system has none.
 *
 * ⚠ AN EMPTY GRID READ IS NOT AN EMPTY SYSTEM. A customs office is a static
 * entity and arrives in every snapshot of its system, but the tick that lands
 * after a gate jump can still see a sparse one - and "there is no office here"
 * finishes the block, which would walk the hauler straight past a full office.
 * Generous on purpose: the block has nothing better to do than wait.
 */
const CUSTOMS_SETTLE_TICKS = 15;

/** Every customs office in this snapshot, nearest first. */
function customsOfficesOnGrid(snapshot: SpaceSnapshot): readonly SpaceEntity[] {
  const origin = snapshot.ship?.position ?? null;
  const away = (entity: SpaceEntity): number =>
    origin === null ? 0 : distanceMeters(origin, entity.position);
  return snapshot.entities
    .filter((entity) => entity.groupID === GROUP_PLANETARY_CUSTOMS_OFFICES && entity.itemID > 0)
    .sort((left, right) => away(left) - away(right));
}

/**
 * The launchpads of the colony on an office's planet that hold goods and have
 * not been given up on: what the retail client's customs window would send up
 * from that office. None where the office does not say its planet (the web
 * gateway's snapshot), or where the colonies were not read.
 */
function launchpadsToSendUp(
  office: SpaceEntity,
  obs: ScriptObservation,
  stepID: string,
): readonly { readonly pinID: number; readonly commodities: Readonly<Record<number, number>>; readonly leftAlone: boolean }[] {
  // An office that does not say its planet is no colony's: null matches none.
  const planetID = office.planetID ?? null;
  const pads: { pinID: number; commodities: Record<number, number>; leftAlone: boolean }[] = [];
  for (const colony of obs.colonies ?? []) {
    if (colony.planetID !== planetID) {
      continue;
    }
    for (const pin of colony.pins) {
      if (pin.kind !== "launchpad" || pin.contents.length === 0) {
        continue; // only a spaceport's goods go up through an office
      }
      const commodities: Record<number, number> = {};
      for (const item of pin.contents) {
        commodities[item.typeID] = item.quantity;
      }
      pads.push({
        pinID: pin.pinID,
        commodities,
        leftAlone: shouldSetAside(obs.refusals, stepID, "exportCustoms", pin.pinID, MAX_BLOCK_ATTEMPTS),
      });
    }
  }
  return pads;
}

const collectCustoms: MacroDecider = (step, obs, mem) => {
  const phase = "Collecting from the customs offices";
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - an office is emptied from space.", phase, {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp to a customs office.", phase, ACTING, false, { ...mem, sawWarp: true });
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", phase, ACTING, false, mem);
  }
  // A full ship is a finished trip, exactly as on the loot blocks: go unload.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return tick(WAIT, "The ship is full, so it is time to unload.", phase, { kind: "done" });
  }
  if (shipHasNoRoom(obs.refusals, step.id, "collectCustoms")) {
    return tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", phase, { kind: "done" });
  }
  const offices = customsOfficesOnGrid(snapshot);
  if (offices.length === 0) {
    const looked = (num(mem, "looked") ?? 0) + 1;
    if (looked <= CUSTOMS_SETTLE_TICKS) {
      return tick(WAIT, "Looking for this system's customs offices.", phase, ACTING, false, { ...mem, looked });
    }
    return tick(WAIT, "There is no customs office in this system.", phase, { kind: "done" });
  }
  // ⚠ NULL IS "NOBODY HAS READ THEM YET", NEVER "THEY ARE EMPTY". The read is
  // paid for only while this block is active (flow.ts), so the first tick in a
  // system always lands here.
  const contents = obs.customsOffices ?? null;
  if (contents === null) {
    return tick(WAIT, "Reading the customs offices.", phase, ACTING, false, mem);
  }
  const unitsIn = new Map(contents.map((office) => [office.officeID, office.units]));
  // What each office's planet still has on its launchpads: sent up at the
  // office, as the retail client's customs window does, before anything is taken.
  const padsAt = new Map(offices.map((office) => [office.itemID, launchpadsToSendUp(office, obs, step.id)]));
  const toSendUp = (office: SpaceEntity) => (padsAt.get(office.itemID) ?? []).filter((pad) => !pad.leftAlone);
  const holding = offices.filter(
    (office) =>
      toSendUp(office).length > 0 ||
      ((unitsIn.get(office.itemID) ?? 0) > 0 &&
        !shouldSetAside(obs.refusals, step.id, "collectCustoms", office.itemID, MAX_BLOCK_ATTEMPTS)),
  );
  if (holding.length === 0) {
    const stubborn = offices.filter((office) => (unitsIn.get(office.itemID) ?? 0) > 0).length;
    const leftAlone = [...padsAt.values()].flat().filter((pad) => pad.leftAlone).length;
    const ended = stubborn > 0
      ? `${stubborn} customs office${stubborn === 1 ? "" : "s"} would not give up ${stubborn === 1 ? "its" : "their"} goods.`
      : "Every customs office in this system is emptied.";
    return tick(
      WAIT,
      leftAlone > 0
        ? `${ended} ${leftAlone} launchpad${leftAlone === 1 ? "" : "s"} would not send ${leftAlone === 1 ? "its" : "their"} goods up.`
        : ended,
      phase,
      { kind: "done" },
    );
  }
  const target = holding[0]!;
  const measurement = measureSpace(snapshot);
  const dist = measurement?.distances.get(target.itemID) ?? null;
  if (dist === null) {
    // On the overview but not measurable: the ship's own geometry has not
    // arrived yet. Wait rather than warp blind.
    return tick(WAIT, "Waiting for the office's range to be readable.", phase, ACTING, false, mem);
  }
  if (dist > LAUNCH_WARP_MIN_M) {
    if (num(mem, "warpingTo") === target.itemID && flag(mem, "issued")) {
      if (warpLanded(obs, mem)) {
        // Landed: fall through to the close-in below on the next tick, which is
        // what a landing inside warp range means.
        return tick(WAIT, "Landed at the customs office.", phase, ACTING, false, { ...mem, warpingTo: null, issued: false });
      }
      const waited = (num(mem, "waited") ?? 0) + 1;
      if (waited > 10) {
        return tick(WAIT, "The warp to that office never started - trying it again.", phase, ACTING, false, {});
      }
      return tick(WAIT, "Waiting for the warp to start.", phase, ACTING, false, { ...mem, waited });
    }
    // Never warp off with drones still out.
    const recall = recallBeforeLeaving(obs, mem, phase, null);
    if (recall !== null) {
      return recall;
    }
    return tick(
      { kind: "warp", targetID: target.itemID },
      "Warping to a customs office.",
      phase,
      ACTING,
      false,
      { warpingTo: target.itemID, ...warpIssuedMem(obs) },
    );
  }
  // The server's range check beats our arithmetic, as on the loot blocks.
  const unreachable = isUnreachable(obs.refusals, step.id, "collectCustoms", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(mem, "approaching") === target.itemID) {
      const stall = closeInStall(measurement?.shipMode ?? null, mem);
      if (stall.step === "reorder") {
        return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "unstick") {
        return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, phase, { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return tick(WAIT, "Flying to the customs office.", phase, ACTING, true, stall.mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for the customs office.",
      phase,
      ACTING,
      true,
      clearCloseInStall({ approaching: target.itemID }),
    );
  }
  const [pad] = toSendUp(target);
  if (pad !== undefined) {
    return tick(
      { kind: "exportCustoms", officeID: target.itemID, pinID: pad.pinID, commodities: pad.commodities },
      "Sending a launchpad's goods up into the customs office.",
      phase,
      ACTING,
      true,
      { approaching: null },
    );
  }
  return tick(
    { kind: "collectCustoms", officeID: target.itemID },
    "Taking the goods out of the customs office.",
    phase,
    ACTING,
    true,
    { approaching: null },
  );
};

// ── board-planetary-hauler ───────────────────────────────────────────────────
// Docked: get into a hull parked here that has a planetary commodities hold.
// The hold is READ off each hull (obs.planetaryHaulerShipIDs, one capacity
// read per parked ship while this block runs), never picked by the player -
// the hull's own bays say what it is for. The hull it leaves is noted on the
// run's board exactly as refit-ship notes it, so board-previous-ship goes back.
const boardPlanetaryHauler: MacroDecider = (_step, obs, mem, board) => {
  const phase = "Changing ships";
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - ships are changed in a station.", phase, {
      kind: "blocked",
      reason: "Dock where your planetary hauler is parked first.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  const activeShipID = obs.activeShipID ?? null;
  const haulers = obs.planetaryHaulerShipIDs ?? null;
  if (hangar === null || activeShipID === null || haulers === null) {
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS * 2) {
      return tick(WAIT, "The parked ships could not be read.", phase, {
        kind: "blocked",
        reason: "The ships parked here could not be read, so the bot cannot tell which one has a planetary hold.",
      });
    }
    return tick(WAIT, "Reading the ships parked here.", phase, ACTING, false, { ...mem, blindChecks });
  }
  if (haulers.includes(activeShipID)) {
    return tick(WAIT, "This ship has a planetary hold.", phase, { kind: "done" });
  }
  const candidate = hangar.find(
    (row) => row.categoryID === CATEGORY_SHIP_ROW && row.singleton && row.itemID !== activeShipID && haulers.includes(row.itemID),
  );
  if (candidate === undefined) {
    return tick(WAIT, "No ship with a planetary hold is parked here.", phase, {
      kind: "blocked",
      reason: "No ship with a planetary commodities hold (an Epithal) is parked at this station.",
    });
  }
  const boards = (num(mem, "boards") ?? 0) + 1;
  if (boards > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "Boarding kept not landing.", phase, {
      kind: "blocked",
      reason: "The ship swap kept not taking, so the bot stopped.",
    });
  }
  const boarding = tick({ kind: "boardShip", shipID: candidate.itemID }, "Boarding the planetary hauler.", phase, ACTING, false, {
    ...mem,
    boards,
  });
  const recorded = board[PREVIOUS_SHIP_BOARD_KEY];
  return typeof recorded === "number" && recorded > 0
    ? boarding
    : withBoardPatch(boarding, { [PREVIOUS_SHIP_BOARD_KEY]: activeShipID });
};

// ── board-previous-ship ──────────────────────────────────────────────────────
// The other half of refit-ship's "reship and go". refit-ship writes the hull
// it boarded away from onto the run's board (PREVIOUS_SHIP_BOARD_KEY); this
// block, docked, boards that hull again and clears the key. A run in which no
// refit changed ships has nothing to go back to, and that is a plain done.
const boardPreviousShip: MacroDecider = (_step, obs, mem, board) => {
  const phase = "Changing ships";
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - ships are changed in a station.", phase, {
      kind: "blocked",
      reason: "Dock at the station where the earlier ship is parked first.",
    });
  }
  const previous = board[PREVIOUS_SHIP_BOARD_KEY];
  if (typeof previous !== "number" || previous <= 0) {
    return tick(WAIT, "No refit in this run changed ships, so there is nothing to go back to.", phase, { kind: "done" });
  }
  const hangar = obs.stationHangar ?? null;
  const activeShipID = obs.activeShipID ?? null;
  if (hangar === null || activeShipID === null) {
    return tick(WAIT, "Reading the hangar.", phase, ACTING, false, mem);
  }
  if (activeShipID === previous) {
    return withBoardPatch(
      tick(WAIT, "Back in the earlier ship.", phase, { kind: "done" }),
      { [PREVIOUS_SHIP_BOARD_KEY]: null },
    );
  }
  if (!hangar.some((row) => row.itemID === previous && row.categoryID === CATEGORY_SHIP_ROW)) {
    return tick(WAIT, "The earlier ship is not in this hangar.", phase, {
      kind: "blocked",
      reason: "The ship this run was flying before the refit is not parked here - dock where you reshipped.",
    });
  }
  const boards = (num(mem, "boards") ?? 0) + 1;
  if (boards > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "Boarding kept not landing.", phase, {
      kind: "blocked",
      reason: "The ship swap kept not taking, so the bot stopped.",
    });
  }
  return tick({ kind: "boardShip", shipID: previous }, "Boarding the earlier ship.", phase, ACTING, false, { ...mem, boards });
};

// ── repair-ship ──────────────────────────────────────────────────────────────
// Docked: the shop's own quote decides what is damaged; repair it; done only
// when a FRESH quote says nothing is left. The wallet charge is the server's.
const repairShip: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - repairs happen at a station.", "Repairing", {
      kind: "blocked",
      reason: "Dock at a station first - this block uses its repair shop.",
    });
  }
  const damaged = obs.damagedItemIDs ?? null;
  if (damaged === null) {
    return tick(WAIT, "Asking the repair shop for a quote.", "Repairing", ACTING, false, mem);
  }
  if (damaged.length === 0) {
    return tick(WAIT, "Nothing needs repairing.", "Repairing", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The shop kept leaving damage unfixed.", "Repairing", {
      kind: "blocked",
      reason: "The repair shop kept not fixing the damage (not enough money?), so the bot stopped.",
    });
  }
  return tick(
    { kind: "repairItems", itemIDs: damaged },
    `Repairing ${damaged.length === 1 ? "the damage" : `${damaged.length} damaged things`}.`,
    "Repairing",
    ACTING,
    false,
    { attempts },
  );
};

// ── buy-item ─────────────────────────────────────────────────────────────────
// Docked: place ONE buy order at this station's market for the picked item, at
// the player's price ceiling, for the quantity they set. One-shot — it places the
// order (the server confirm-gates it and charges the broker fee) and is done; it
// does not wait for the order to fill (a resting order may take time, an
// aggressive price fills at once). Inside a loop it re-orders each lap, by design.
const buyItem: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - orders are placed at a station's market.", "Buying", {
      kind: "blocked",
      reason: "Dock at a station first - this block places a buy order at its market.",
    });
  }
  const item = step.args["item"];
  const qty = step.args["quantity"];
  const price = step.args["price"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    qty === undefined || qty.kind !== "qty" ||
    price === undefined || price.kind !== "isk"
  ) {
    return tick(WAIT, "This step is not fully set up.", "Buying", {
      kind: "blocked",
      reason: "Pick the item, how many to buy, and the most to pay for each.",
    });
  }
  if (flag(mem, "placed")) {
    return tick(WAIT, "The buy order is placed.", "Buying", { kind: "done" });
  }
  return tick(
    { kind: "placeBuyOrder", typeID: item.typeID, price: price.value, quantity: qty.value },
    `Placing a buy order for ${qty.value.toLocaleString()} at up to ${price.value.toLocaleString()} ISK each.`,
    "Buying",
    ACTING,
    false,
    { ...mem, placed: true },
  );
};

// ── sell-item ────────────────────────────────────────────────────────────────
// Docked: list EVERY stack of the picked item from the hangar onto the market at
// the player's price floor, one order per tick. A listed stack LEAVES the hangar
// (into the order), so the next hangar re-read shows it gone - that is the
// confirmation, no 200 trusted. Done when no stack of the item is left. Only
// plain (non-singleton) stacks are sold, never an assembled ship or module.
const sellItem: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - selling happens at a station's market.", "Selling", {
      kind: "blocked",
      reason: "Dock at a station first - this block lists your items on its market.",
    });
  }
  const item = step.args["item"];
  const price = step.args["price"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    price === undefined || price.kind !== "isk"
  ) {
    return tick(WAIT, "This step is not fully set up.", "Selling", {
      kind: "blocked",
      reason: "Pick the item to sell and the least to take for each.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  if (hangar === null) {
    return tick(WAIT, "Reading the hangar.", "Selling", ACTING, false, mem);
  }
  const stacks = hangar.filter((row) => row.typeID === item.typeID && !row.singleton && row.quantity > 0);
  if (stacks.length === 0) {
    return tick(WAIT, "Every stack of that item is listed.", "Selling", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The market kept refusing the sell.", "Selling", {
      kind: "blocked",
      reason: "The market kept not listing the item, so the bot stopped.",
    });
  }
  const stack = stacks[0]!;
  return tick(
    { kind: "placeSellOrder", itemID: stack.itemID, typeID: item.typeID, price: price.value, quantity: stack.quantity },
    `Listing ${stack.quantity.toLocaleString()} at ${price.value.toLocaleString()} ISK each.`,
    "Selling",
    ACTING,
    false,
    { ...mem, attempts },
  );
};

// ═══ The fleet-support set ══════════════════════════════════════════════════
// Remote-repair friendly ships on grid. Players are FRIENDLY in this world
// (operator decision), so a "fleet-mate" is any non-NPC ship on the grid that is
// not your own. Both blocks ride the SAME lock + activate the engine already
// proves; only picking the target (the most-hurt friendly) is new. No new gateway
// read: the space snapshot already carries every ship's health and owner.

const REMOTE_REP_HURT = 0.95; // anyone not essentially full is worth a rep
const ORBIT_BOOST_RANGE_M = 2000; // stay close so remote reps reach

/**
 * How far remote assistance reaches — remote reps and cap transmitters alike.
 *
 * ⚠ DELIBERATELY THE SMALL END, with margin, in the style of `SALVAGE_RANGE_M`.
 * The small modules sit around 5-6 km and the larger ones reach further, so a
 * ship fitted with a big one closes a little more than it strictly had to; that
 * costs seconds. Being generous costs correctness: a limit above what the module
 * can do turns the range check into a machine for spending the attempt budget on
 * refusals.
 *
 * Measured live: a Small Remote Capacitor Transmitter I refused
 * `TargetNotWithinRangeGeneric` at 17.9 km and ran fine at 2.2 km.
 * `ORBIT_BOOST_RANGE_M` (2 km) sits comfortably inside this, so orbit-and-boost's
 * hold always satisfies it.
 */
const REMOTE_ASSIST_RANGE_M = 5000;

/**
 * How many times one target may be offered a remote module that will not come on.
 *
 * ⚠ THIS BOUND WAS MISSING ENTIRELY. Both remote blocks used to return `mem`
 * UNCHANGED after issuing an activate, so a refused module was re-found idle on
 * the next tick and re-fired — forever, with no counter, no progress and no
 * reason surfaced. remote-rep only reports `done` when everyone on grid is full
 * and remote-cap when everyone has cap to spare, so neither could ever finish
 * either: a mate parked out of reach was an infinite loop, which is the exact
 * failure mode the house rule about bounding every branch exists to prevent.
 */
const MAX_REMOTE_ASSIST_ATTEMPTS = 3;
const MAX_REMOTE_ASSIST_STOP_WAIT_TICKS = 15;

/**
 * The snapshot names active modules, not their recipients. Only an activation
 * accepted from observed inactivity establishes a recipient for this run.
 * Settle an old or unknown recipient before reusing that module; a successful
 * Deactivate response alone is not proof it has stopped.
 */
function settleRemoteAssistance(
  obs: ScriptObservation,
  mem: MacroMemory,
  moduleIDs: readonly number[],
  targetID: number | null,
  prefix: "rep" | "cap",
  phase: string,
): MacroTick | null {
  const active = obs.snapshot?.ship?.activeModuleIDs ?? null;
  if (active === null) {
    return tick(WAIT, "Reading the remote modules before changing assistance.", phase, ACTING, false, mem);
  }
  const stoppingKey = `${prefix}Stopping`;
  const waitedKey = `${prefix}StopWaited`;
  const stopping = num(mem, stoppingKey);
  if (stopping !== null) {
    if (active.includes(stopping)) {
      const waited = (num(mem, waitedKey) ?? 0) + 1;
      if (waited > MAX_REMOTE_ASSIST_STOP_WAIT_TICKS) {
        return tick(WAIT, "The remote module did not stop.", phase, {
          kind: "blocked", reason: "Remote assistance could not be stopped, so the bot will not activate it on another fleet-mate.",
        }, false, mem);
      }
      return tick(WAIT, "Waiting for the previous assistance cycle to stop.", phase, ACTING, true, { ...mem, [waitedKey]: waited });
    }
    return tick(WAIT, "The remote module has stopped.", phase, ACTING, true,
      { ...mem, [stoppingKey]: null, [waitedKey]: 0, [`${prefix}Target:${stopping}`]: null });
  }
  const stale = moduleIDs.find(id => active.includes(id) &&
    (targetID === null || num(mem, `${prefix}Target:${id}`) !== targetID));
  if (stale === undefined) return null;
  return tick({ kind: "deactivate", moduleID: stale },
    "Stopping assistance on the previous or unconfirmed recipient.", phase, ACTING, true,
    { ...mem, [stoppingKey]: stale, [waitedKey]: 0 });
}

/**
 * Authoritative fleet-mates on grid. Presence, corporation, and alliance are
 * not membership: if the bound-fleet roster is unreadable, callers wait.
 */
function fleetMatesOnGrid(obs: ScriptObservation): readonly SpaceEntity[] | null {
  const snapshot = obs.snapshot ?? null;
  const roster = obs.fleetMemberCharacterIDs ?? null;
  if (snapshot === null || roster === null) {
    return null;
  }
  const memberIDs = new Set(roster);
  const selfID = snapshot.ship?.itemID ?? null;
  if (memberIDs.size === 0) {
    return [];
  }
  return snapshot.entities.filter(
    (e) =>
      e.kind === "ship" &&
      e.isNpc === false &&
      e.isSelf === false &&
      e.itemID !== selfID &&
      e.characterID !== null &&
      memberIDs.has(e.characterID),
  );
}

/** The lowest readable health layer of a ship (shield/armor/hull), or null. */
function lowestShipRatio(e: SpaceEntity): number | null {
  const ratios = [e.shieldRatio, e.armorRatio, e.hullRatio].filter((r): r is number => r !== null);
  return ratios.length === 0 ? null : Math.min(...ratios);
}

/** The most-hurt friendly below the rep threshold, or null when all are full. */
function mostHurtFriendly(friendlies: readonly SpaceEntity[]): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestRatio = REMOTE_REP_HURT;
  for (const e of friendlies) {
    const r = lowestShipRatio(e);
    if (r !== null && r < bestRatio) {
      best = e;
      bestRatio = r;
    }
  }
  return best;
}

function remoteRepIDs(obs: ScriptObservation): readonly number[] {
  return [
    ...(obs.remoteShieldRepairerIDs ?? []),
    ...(obs.remoteArmorRepairerIDs ?? []),
    ...(obs.remoteHullRepairerIDs ?? []),
  ];
}

/**
 * The shared logistics action: lock the hurt fleet-mate (bounded), close on them
 * if the reps cannot reach (bounded), then switch on any idle remote rep onto it.
 * Returns the tick to emit, or null when there is nobody to rep right now — the
 * caller decides what "nothing to rep" means.
 *
 * `mayApproach` is false for orbit-and-boost: that block is ALREADY closing, by
 * orbiting the anchor at `ORBIT_BOOST_RANGE_M`. Issuing an approach from in here
 * as well would fight its own orbit command every tick.
 */
function repHurtMate(
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  mayApproach = true,
): MacroTick | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return null;
  }
  const friendlies = fleetMatesOnGrid(obs);
  if (friendlies === null) {
    return null;
  }
  const target = mostHurtFriendly(friendlies);
  const settlement = settleRemoteAssistance(obs, mem, remoteRepIDs(obs), target?.itemID ?? null, "rep", phase);
  if (settlement !== null) return settlement;
  if (target === null) {
    return null;
  }
  const changed = num(mem, "repLockOn") !== target.itemID;
  if (changed) mem = { ...mem, repLockOn: target.itemID, repWaited: 0, repTries: 0, repApproached: null };
  const locked = (obs.lockedTargetIDs ?? []).includes(target.itemID);
  if (!locked) {
    if (changed) {
      // A NEW mate resets everything counted per-target, or the last one's spent
      // budget silently disarms the reps for this one (the bug the PvP ladder
      // had, where a shared counter outlived the target it was counting for).
      //
      // ⚠ `changed` IS READ FROM WHAT THE PRESS WRITES, and a refused press
      // commits nothing (see `readLockRefusals`): every tick after a refusal was a
      // "new" mate and a new press, and the timed wait below was never reached.
      // So the refusal is read here, before pressing again.
      const lockRefusals = readLockRefusals(step, obs, mem);
      if (lockRefusals.unread) {
        // Counted, and the mate left unadopted so the next tick still presses.
        return tick(WAIT, "Checking the last lock.", phase, ACTING, true, {
          ...mem,
          repLockOn: null,
          lockRefusalsSeen: lockRefusals.count,
        });
      }
      if (lockRefusals.fresh && refusalTargets(lockRefusals, target.itemID)) {
        // The timed wait below, exactly what a refused lock got before 2fd4a77.
        return tick(WAIT, "Waiting for the lock.", phase, ACTING, true, { ...mem, lockRefusalsSeen: lockRefusals.count });
      }
      return tick({ kind: "lock", targetID: target.itemID }, "Locking the hurt fleet-mate.", phase, ACTING, true, {
        ...mem,
        repLockOn: target.itemID,
        repWaited: 0,
        repTries: 0,
        repApproached: null,
        lockRefusalsSeen: 0,
      });
    }
    const waited = (num(mem, "repWaited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That fleet-mate would not lock - watching for another.", phase, ACTING, true, { ...mem, repLockOn: null });
    }
    return tick(WAIT, "Waiting for the lock.", phase, ACTING, true, { ...mem, repWaited: waited });
  }
  // Reps have a range, and a lock reaches much further than they do. Close first
  // (once per target — `approach` is a standing follow order, not a nudge), and
  // do not spend an attempt on a module we can see cannot reach.
  const rangeToMate = measureSpace(snapshot)?.distances.get(target.itemID) ?? null;
  const outOfReach = rangeToMate !== null && rangeToMate > REMOTE_ASSIST_RANGE_M;
  if (outOfReach && mayApproach) {
    if (num(mem, "repApproached") !== target.itemID) {
      return tick(
        { kind: "approach", targetID: target.itemID },
        "Closing in — too far out for the reps to reach.",
        phase,
        ACTING,
        true,
        clearCloseInStall({ ...mem, repApproached: target.itemID }),
      );
    }
    // The same silent-refusal rung the engage runs, for the same reason and with
    // the same restraint: re-order, then stop to free a stuck landing, and never
    // block — a logi ship that cannot close is still locked and still watching.
    const stall = closeInStall(hullMode(snapshot), mem);
    if (stall.step === "reorder") {
      return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, phase, ACTING, true, stall.mem);
    }
    if (stall.step === "unstick") {
      return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, phase, ACTING, true, stall.mem);
    }
    mem = stall.step === "stuck" ? clearCloseInStall(stall.mem) : stall.mem;
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  // ⚠ CONSECUTIVE failures only. A rep that HAS come on refills the budget, so
  // the bound can only ever stop a module that is not landing — never one that is
  // cycling normally and simply needs switching on again. Get this wrong and the
  // "fix" becomes a bot that stops repping mid-fight after three cycles.
  const landed = remoteRepIDs(obs).some((id) => active.has(id));
  const repTries = landed ? 0 : num(mem, "repTries") ?? 0;
  if (!outOfReach && repTries < MAX_REMOTE_ASSIST_ATTEMPTS) {
    const idle = remoteRepIDs(obs).find((id) => !active.has(id));
    if (idle !== undefined) {
      return tick(
        { kind: "activate", moduleID: idle, targetID: target.itemID },
        "Running the remote reps on the fleet-mate.",
        phase,
        ACTING,
        true,
        { ...mem, repTries: repTries + 1, [`repTarget:${idle}`]: target.itemID },
      );
    }
  }
  return tick(WAIT, "Repping the fleet-mate.", phase, ACTING, true, mem);
}

// ── remote-rep ───────────────────────────────────────────────────────────────
// Reactive: rep the most-hurt fleet-mate; done once everyone on grid is full.
const remoteRep: MacroDecider = (step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Supporting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Supporting", ACTING, false, mem);
  }
  if (remoteRepIDs(obs).length === 0) {
    return tick(WAIT, "No remote reps fitted.", "Supporting", {
      kind: "blocked",
      reason: "This ship has no remote shield or armor repairer fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Supporting", ACTING, false, mem);
  }
  const rep = repHurtMate(step, obs, mem, "Supporting");
  if (rep === null) {
    return tick(WAIT, "Everyone on grid is at full health.", "Supporting", { kind: "done" });
  }
  return rep;
};

// ── orbit-and-boost ──────────────────────────────────────────────────────────
// Sustained: orbit the nearest fleet-mate up close and keep repping whoever is
// hurt. Never finishes on its own - a watch or the player stops it. Orbits ONCE
// (re-issued only when the anchor changes), so it does not spam orbit commands.
const orbitAndBoost: MacroDecider = (step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Boosting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Boosting", ACTING, false, mem);
  }
  if (remoteRepIDs(obs).length === 0) {
    return tick(WAIT, "No remote reps fitted.", "Boosting", {
      kind: "blocked",
      reason: "This ship has no remote shield or armor repairer fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Boosting", ACTING, false, mem);
  }
  const snapshot = obs.snapshot;
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  if (friendlies.length === 0) {
    const settlement = repHurtMate(step, obs, mem, "Boosting", false);
    if (settlement !== null) return settlement;
    return tick(WAIT, "No fleet-mate on grid to support yet.", "Boosting", ACTING, false, mem);
  }
  const anchor = nearest(friendlies, measureSpace(snapshot));
  if (anchor !== null && num(mem, "orbiting") !== anchor.itemID) {
    return tick(
      { kind: "orbit", targetID: anchor.itemID, range: ORBIT_BOOST_RANGE_M },
      "Orbiting the fleet-mate to stay in rep range.",
      "Boosting",
      ACTING,
      false,
      { ...mem, orbiting: anchor.itemID },
    );
  }
  // No approach from in here — the orbit above is this block's way of closing.
  const rep = repHurtMate(step, obs, mem, "Boosting", false);
  if (rep !== null) {
    return rep;
  }
  return tick(WAIT, "Boosting - everyone's healthy for now.", "Boosting", ACTING, false, mem);
};

/**
 * A plain formation-orbit distance for the NAMED-mate variants (orbit-fleet-mate,
 * and follow-fleet-mate later). Deliberately NOT `ORBIT_BOOST_RANGE_M` — that
 * constant's value is pinned to remote-module reach, and this pilot may carry no
 * remote module at all (the whole point of these two blocks is that they do not
 * require one). Same numeric value, different reason: close enough to stay on
 * the mate's grid interaction — inside a web or scram's own reach, should either
 * carry one — without literally sitting on top of them.
 */
const FLEET_MATE_ESCORT_RANGE_M = 2000;

// ── orbit-fleet-mate ──────────────────────────────────────────────────────────
// orbit-and-boost's named-target twin: same standing orbit, no rep ladder of its
// own (see FLEET_MATE_ESCORT_RANGE_M above) — a plain "stick to this one pilot"
// escort a player can pair with whatever else the ship is doing (its own
// hardeners-on, its own combat block). Orbits ONCE per anchor (memory-gated,
// same idiom as orbit-and-boost), never finishes on its own.
const orbitFleetMate: MacroDecider = (step, obs, mem) => {
  const who = step.args["who"];
  if (who === undefined || who.kind !== "character" || who.charID === null) {
    return tick(WAIT, "No fleet-mate picked to orbit.", "Orbiting", {
      kind: "blocked",
      reason: "Pick the fleet-mate this block orbits.",
    });
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Orbiting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Orbiting", ACTING, false, mem);
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Orbiting", ACTING, false, mem);
  }
  const mateName = who.name !== null && who.name.length > 0 ? who.name : null;
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  const anchor = friendlies.find((e) => e.characterID === who.charID) ?? null;
  if (anchor === null) {
    return tick(
      WAIT,
      mateName !== null ? `${mateName} is not on this grid yet.` : "That fleet-mate is not on this grid yet.",
      "Orbiting",
      ACTING,
      false,
      mem,
    );
  }
  if (num(mem, "orbiting") === anchor.itemID) {
    return tick(WAIT, mateName !== null ? `Orbiting ${mateName}.` : "Orbiting the fleet-mate.", "Orbiting", ACTING, false, mem);
  }
  return tick(
    { kind: "orbit", targetID: anchor.itemID, range: FLEET_MATE_ESCORT_RANGE_M },
    mateName !== null ? `Orbiting ${mateName}.` : "Orbiting the fleet-mate.",
    "Orbiting",
    ACTING,
    false,
    { ...mem, orbiting: anchor.itemID },
  );
};

// ── follow-fleet-mate ─────────────────────────────────────────────────────────
// orbit-fleet-mate's stand-off twin: `api.keepAtRange` (CmdFollowBall with a
// non-zero range) instead of `orbit` (CmdOrbit) — holds station off the named
// mate rather than circling them. The difference matters to a ship that should
// not be turning through the mate's own firing arc (a hauler staying with a
// gate camp's anchor, say) where a circling escort would be actively wrong.
// Same memory-gated re-issue as orbit-fleet-mate; shares its escort range.
const followFleetMate: MacroDecider = (step, obs, mem) => {
  const who = step.args["who"];
  if (who === undefined || who.kind !== "character" || who.charID === null) {
    return tick(WAIT, "No fleet-mate picked to follow.", "Following", {
      kind: "blocked",
      reason: "Pick the fleet-mate this block follows.",
    });
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Following", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Following", ACTING, false, mem);
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Following", ACTING, false, mem);
  }
  const mateName = who.name !== null && who.name.length > 0 ? who.name : null;
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  const anchor = friendlies.find((e) => e.characterID === who.charID) ?? null;
  if (anchor === null) {
    return tick(
      WAIT,
      mateName !== null ? `${mateName} is not on this grid yet.` : "That fleet-mate is not on this grid yet.",
      "Following",
      ACTING,
      false,
      mem,
    );
  }
  if (num(mem, "following") === anchor.itemID) {
    return tick(WAIT, mateName !== null ? `Holding range off ${mateName}.` : "Holding range off the fleet-mate.", "Following", ACTING, false, mem);
  }
  return tick(
    { kind: "keepAtRange", targetID: anchor.itemID, range: FLEET_MATE_ESCORT_RANGE_M },
    mateName !== null ? `Holding range off ${mateName}.` : "Holding range off the fleet-mate.",
    "Following",
    ACTING,
    false,
    { ...mem, following: anchor.itemID },
  );
};

// ═══ Fleet tagging ══════════════════════════════════════════════════════════
// Set a fleet target tag on the top-priority hostile, so a tagged squad can see
// the primary without a broadcast — reusing the same DEFAULT_TARGET_PRIORITY /
// pickPrimary ladder the combat blocks already rank hostiles with.
//
// ⚠ THE GATE IS THREE-STATE AND CLIENT-SIDE, AND THAT IS NOT OPTIONAL. The
// server's own gate (fleetRuntime.js) checks commander-ness and returns a bare
// `false` for a non-commander, but its only caller throws that boolean away —
// the HTTP ack this block would see is identical whether the tag landed or was
// silently dropped (see bridge/fleetCommand.ts's header, in full). `obs.canTag`
// is populated from the SAME bound-fleet read this pilot's own row lives in, so
// this decider never re-derives commander-ness itself — it only reacts to the
// three answers: null (cannot tell — wait), false (not a commander — skip and
// keep fighting), true (go ahead).
//
// ⚠ WHAT THIS HONESTLY IS: a SINGLE-LETTER, SINGLE-PILOT capability, not smart
// fleet-wide tagging. Nothing in a snapshot or a roster read says whether the
// FC, or another companion running this SAME block on another hull, already
// lettered a ship — there is no such list to read. The only thing stopping a
// re-tag is THIS block's own memory of what IT last wrote (`taggedTargetID`
// below). Two pilots running this block in the same fleet would fight each
// other's tags every time their own picks disagree. It is safe only when
// exactly one pilot in the squad runs it — say so if this ever grows a
// player-facing description, never "smart tagging".
const FLEET_TAG_PRIMARY = "1"; // the stock menu's clearest "shoot this now"

/** Same reasoning as MAX_REMOTE_ASSIST_ATTEMPTS: bound a write that may never confirm. */
const MAX_FLEET_TAG_ATTEMPTS = 3;

const fleetTagTarget: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - tagging happens out in space.", "Tagging", {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Tagging", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Tagging", ACTING, false, mem);
  }

  // THREE STATES. `null` is "could not look" — WAIT, never guess "no" (that
  // would silently skip a real commander for as long as the read stays flaky).
  const canTag = obs.canTag ?? null;
  if (canTag === null) {
    return tick(WAIT, "Checking whether this pilot can set fleet tags.", "Tagging", ACTING, false, mem);
  }
  if (canTag === false) {
    // SKIP, NOT BLOCKED — this pilot simply cannot do this one job; the rest of
    // its bot (fighting, looting, whatever runs after this block) keeps going.
    return tick(WAIT, "Not the fleet commander.", "Tagging", {
      kind: "skipped",
      reason:
        "This pilot is not the fleet boss or a wing or squad commander, so it cannot set fleet target tags. It keeps working without tagging.",
    });
  }

  const snapshot = obs.snapshot;
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const hostiles = hostileRows(snapshot, origin);
  if (hostiles.length === 0) {
    return tick(WAIT, "No hostile here to tag.", "Tagging", ACTING, false, mem);
  }
  //
  // ⚠ THE SAME LADDER AS THE FIGHT BLOCK, DOGMA AND JAM FEED INCLUDED, AND IT
  // HAS TO BE. What this writes is read straight back by every follower's
  // `calledByTag`, where a tag outranks everything — including the jam fold. So
  // a tag block still picking nearest-first would not merely mis-tag: it would
  // hand the squad a human-authority instruction to shoot the wrong rat and
  // overrule the very feed that names the one holding them. Two ladders in one
  // squad is one ladder too many.
  const primary =
    pickPrimary(
      hostiles,
      (row) => row.typeID,
      (row) => row.distance,
      targetGroupOf(obs),
      targetPriorityOf(step),
      undefined,
      targetThreatOf(obs),
      jammingSourcesOf(obs),
    ) ?? hostiles[0]!;

  // Confirmed by SEEING the tag in a later `fleetTargetTags` read — never by the
  // write's own ack, which reads `{ok: true}` whether the server kept the tag or
  // dropped it (see api.ts's setFleetTargetTag and fleetCommand.ts's header).
  const tags = obs.fleetTargetTags ?? null;
  const landed = tags !== null && tags.get(primary.itemID) === FLEET_TAG_PRIMARY;
  const taggedID = num(mem, "taggedTargetID");

  if (taggedID !== primary.itemID) {
    // A NEW primary — fresh target, fresh attempt budget, issue right away
    // (the memory-gating idiom: re-stamp once per target, same as orbit-and-boost).
    return tick(
      { kind: "setFleetTargetTag", targetID: primary.itemID, tag: FLEET_TAG_PRIMARY },
      "Marking the top target for the fleet.",
      "Tagging",
      ACTING,
      false,
      { ...mem, taggedTargetID: primary.itemID, tagTries: 1 },
    );
  }
  if (landed) {
    return tick(WAIT, "The top target is tagged for the fleet.", "Tagging", ACTING, false, mem);
  }
  const tries = num(mem, "tagTries") ?? 0;
  if (tries >= MAX_FLEET_TAG_ATTEMPTS) {
    // Stop resending — a write that never confirms must not spend the tick
    // budget on refusals it cannot see the reason for (MAX_REMOTE_ASSIST_ATTEMPTS's
    // own reasoning). The block keeps watching in case a later read confirms it.
    return tick(WAIT, "The tag has not shown up yet - watching without resending.", "Tagging", ACTING, false, mem);
  }
  return tick(
    { kind: "setFleetTargetTag", targetID: primary.itemID, tag: FLEET_TAG_PRIMARY },
    "Marking the top target for the fleet.",
    "Tagging",
    ACTING,
    false,
    { ...mem, tagTries: tries + 1 },
  );
};

// ═══ The fleet-management set ═══════════════════════════════════════════════
// Form up / invite / join — the multibox alt-fleeting loop. All confirm-gated
// server-side; each confirms by re-reading the bound-fleet state (`obs.inFleet`,
// which is authoritative: a char with no fleet reads a real "not in a fleet",
// never a blank). ⚠ the WRITES were never fired live — flagged for QA.

// ── create-fleet ─────────────────────────────────────────────────────────────
const createFleet: MacroDecider = (_step, obs, mem) => {
  const inFleet = obs.inFleet ?? null;
  if (inFleet === true) {
    return tick(WAIT, "You are already in a fleet.", "Forming a fleet", { kind: "done" });
  }
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Forming a fleet", ACTING, false, mem);
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The fleet would not form.", "Forming a fleet", {
      kind: "blocked",
      reason: "The fleet would not form after several tries, so the bot stopped.",
    });
  }
  return tick({ kind: "createFleet" }, "Forming a fleet.", "Forming a fleet", ACTING, false, { ...mem, tries });
};

// ── invite-to-fleet ──────────────────────────────────────────────────────────
const inviteToFleet: MacroDecider = (step, obs, mem) => {
  const who = step.args["who"];
  if (who === undefined || who.kind !== "character" || who.charID === null) {
    return tick(WAIT, "No pilot picked to invite.", "Inviting", {
      kind: "blocked",
      reason: "Pick the pilot this block invites.",
    });
  }
  const inFleet = obs.inFleet ?? null;
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Inviting", ACTING, false, mem);
  }
  if (inFleet === false) {
    return tick(WAIT, "You are not in a fleet to invite into.", "Inviting", {
      kind: "blocked",
      reason: "Form or join a fleet first - put a Form-a-fleet block before this one.",
    });
  }
  if (flag(mem, "invited")) {
    return tick(WAIT, "The invite is sent.", "Inviting", { kind: "done" });
  }
  return tick(
    { kind: "inviteToFleet", charID: who.charID },
    who.name !== null && who.name.length > 0 ? `Inviting ${who.name} to the fleet.` : "Inviting a pilot to the fleet.",
    "Inviting",
    ACTING,
    false,
    { ...mem, invited: true },
  );
};

// ── join-fleet ───────────────────────────────────────────────────────────────
// Reactive: keep accepting a pending invite until this character is in a fleet.
// Bounded so a bot that is never invited stops rather than trying forever.
const JOIN_MAX_WAIT_TICKS = 150; // a few minutes at the settle-paced cadence
const joinFleet: MacroDecider = (_step, obs, mem) => {
  const inFleet = obs.inFleet ?? null;
  if (inFleet === true) {
    return tick(WAIT, "You are in a fleet now.", "Joining a fleet", { kind: "done" });
  }
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Joining a fleet", ACTING, false, mem);
  }
  const waited = (num(mem, "waited") ?? 0) + 1;
  if (waited > JOIN_MAX_WAIT_TICKS) {
    return tick(WAIT, "No fleet invitation arrived.", "Joining a fleet", {
      kind: "blocked",
      reason: "No fleet invitation arrived in time, so the bot stopped.",
    });
  }
  return tick({ kind: "acceptFleetInvite", fleetID: null }, "Waiting for a fleet invite to accept.", "Joining a fleet", ACTING, false, { ...mem, waited });
};


// -- join-advertised-fleet ----------------------------------------------------
// The fleet-finder twin of join-fleet. join-fleet waits to be INVITED and stops
// the run if nobody ever invites it; this one goes looking, by name, in the
// advert listing -- and is OPPORTUNISTIC where the other is a requirement:
//
//   * already in a fleet  -> done, immediately. "if not in fleet" is the block.
//   * no fleet by that name advertised -> done, immediately, NOT blocked. This is
//     the point of the block. It is meant to sit at the top of a loop an alt runs
//     all day: the moment the boss advertises "Mining Op" the alt joins it, and
//     every other lap it finds nothing, finishes, and carries on mining alone. A
//     block that stopped the run here would make that loop unusable.
//   * advertised -> apply, ACCEPT the invite that produces, then confirm.
//
// That last line is the whole round trip and all three steps are ours. An apply
// does NOT join you: the server mints a fleet invite addressed to this pilot and
// notifies it, and membership happens only when the client accepts. This block
// is the client. The first version stopped after applying and waited for
// membership to arrive on its own, and hung forever on a perfectly healthy
// fleet -- fixed 2026-09-09.
//
// An approval-gated advert is the other half: it stores a request only the boss
// can act on, so there is no invite to accept and no amount of waiting helps.
// The block says so and stops, rather than timing out and blaming the fleet.
//
// The BOUNDED wait is not the same judgement as the absent-fleet one. A join
// that was applied for AND accepted and still did not land is a real failure the
// player wants told about, and silence there is the silently-refused-forever
// trap this file keeps guarding against. So: absent fleet finishes quietly, a
// join that will not complete stops with a reason.
//
// Matching is trimmed and case-insensitive but otherwise EXACT. Not a substring:
// an unattended ship must not end up in a stranger's fleet because their name
// happened to contain the player's word. Where two adverts share a name the
// bigger fleet wins (ties broken by the lower id, so the choice is stable across
// ticks rather than flapping between two equal fleets).
const JOIN_ADVERTISED_MAX_WAIT_TICKS = 150; // a few minutes at the settle-paced cadence

/** The fleet name the player typed, trimmed. "" when the step is unset. */
function typedFleetName(step: MacroStep): string {
  const arg = step.args["fleetName"];
  return arg !== undefined && arg.kind === "text" ? arg.text.trim() : "";
}

// ⚠ `pickAdvertisedFleet` MOVED to ./scriptConditions.ts and is imported above.
// The Fleet companions window joins by name too (nav/fleetJoinWatch.ts), and a
// second copy of the tie-break is a second copy that drifts.

const joinAdvertisedFleet: MacroDecider = (step, obs, mem) => {
  const typed = typedFleetName(step);
  const wanted = typed.toLowerCase();
  if (wanted.length === 0) {
    return tick(WAIT, "This step is not fully set up.", "Joining a fleet", {
      kind: "blocked",
      reason: "Type the name of the fleet to look for in the fleet finder.",
    });
  }
  const inFleet = obs.inFleet ?? null;
  if (inFleet === true) {
    // Covers both halves of "if not in fleet": the pilot who was already fleeted
    // when the block started, and the one this block has just got in.
    return tick(WAIT, "You are in a fleet.", "Joining a fleet", { kind: "done" });
  }
  const waited = (num(mem, "waited") ?? 0) + 1;
  const overdue = waited > JOIN_ADVERTISED_MAX_WAIT_TICKS;
  const appliedTo = num(mem, "appliedTo");
  if (appliedTo !== null) {
    // ⚠ APPLYING IS NOT JOINING. The apply minted an INVITE addressed to this
    // pilot and told nobody else to do anything; accepting it is the client's
    // half of the round trip, and this block is the client. Waiting here for
    // membership to appear on its own is what the first version of this block
    // did, and it hung forever.
    //
    // The application is read from the OBSERVATION rather than remembered as a
    // flag, because only the runner sees what the server answered. It is trusted
    // only when it names the fleet THIS activation applied to: the observation
    // outlives a lap, step memory does not, so the fleet id is what keeps a
    // stale answer from a previous lap out of this one.
    const application = obs.fleetApplication ?? null;
    const answered = application !== null && application.fleetID === appliedTo ? application : null;
    if (answered !== null && answered.outcome === "needs-approval") {
      // No invite exists and none is coming: only the boss can act now. Say so
      // plainly rather than sitting out the bound and blaming a timeout.
      return tick(WAIT, `"${typed}" has to approve the application.`, "Joining a fleet", {
        kind: "blocked",
        reason: `Applied to join "${typed}", but that fleet approves its own members, so the bot cannot join it by itself.`,
      });
    }
    if (overdue) {
      return tick(WAIT, "Never got into the fleet.", "Joining a fleet", {
        kind: "blocked",
        reason: `Applied to join "${typed}" and accepted the invitation, but never got into the fleet, so the bot stopped. It may be full.`,
      });
    }
    if (answered === null) {
      // The apply is still in flight, or it threw and the runner swallowed it.
      return tick(WAIT, `Applying to "${typed}".`, "Joining a fleet", ACTING, false, { ...mem, waited });
    }
    // "invited", and "unknown" too: an unexpected answer is treated as an invite
    // because that is the common half, and a wasted accept costs one swallowed
    // call where a refused one would strand a bot with an invite waiting.
    return tick(
      { kind: "acceptFleetInvite", fleetID: appliedTo },
      `Accepting the invitation to "${typed}".`,
      "Joining a fleet",
      ACTING,
      false,
      { ...mem, waited },
    );
  }
  if (inFleet === null) {
    // Unreadable is never an answer: neither "join" nor "carry on" is safe to
    // guess, so wait for a clean read within the same bound.
    if (overdue) {
      return tick(WAIT, "Could not tell whether you are in a fleet.", "Joining a fleet", {
        kind: "blocked",
        reason: "Could not read your fleet status, so the bot stopped.",
      });
    }
    return tick(WAIT, "Checking your fleet status.", "Joining a fleet", ACTING, false, { ...mem, waited });
  }
  const ads = obs.fleetAds ?? null;
  if (ads === null) {
    if (overdue) {
      return tick(WAIT, "Could not read the fleet finder.", "Joining a fleet", {
        kind: "blocked",
        reason: "Could not read the fleet finder, so the bot stopped.",
      });
    }
    return tick(WAIT, "Reading the fleet finder.", "Joining a fleet", ACTING, false, { ...mem, waited });
  }
  const match = pickAdvertisedFleet(ads, wanted);
  if (match === null) {
    // The whole opportunistic half of the block. An EMPTY listing is a real
    // answer, not a failure, so this finishes on the first clean read.
    return tick(WAIT, `No fleet called "${typed}" is in the fleet finder.`, "Joining a fleet", {
      kind: "done",
    });
  }
  return tick(
    { kind: "applyToJoinFleet", fleetID: match.fleetID },
    `Applying to join "${match.fleetName}".`,
    "Joining a fleet",
    ACTING,
    false,
    { ...mem, waited, appliedTo: match.fleetID },
  );
};

// ═══ Movement extras ════════════════════════════════════════════════════════

// ── set-destination ──────────────────────────────────────────────────────────
// Point the SHARED autopilot at a station or a whole system and hand the ship
// over. Unlike travel-to-station this does NOT wait for the arrival: it is done
// once the trip is under way, so a player can put their own checks after it.
// A system destination lands in space (no dock) — the autopilot's own
// system-only plan, which the roam already rides.
const setDestination: MacroDecider = (step, obs, mem) => {
  const arg = step.args["destination"];
  if (arg === undefined || arg.kind !== "destination" || arg.ref.id === null) {
    return tick(WAIT, "No destination picked.", "Setting a course", {
      kind: "blocked",
      reason: "Pick where this step should send you.",
    });
  }
  const id = arg.ref.id;
  const toSystem = arg.ref.entity === "system";
  const travel = obs.travel ?? null;
  const targetKey = toSystem ? (travel?.destinationSystemID ?? null) : (travel?.destinationStationID ?? null);
  if (travel !== null && travel.failureReason !== null && targetKey === id) {
    return tick(WAIT, travel.failureReason, "Setting a course", {
      kind: "blocked",
      reason: `The course could not be set: ${travel.failureReason}`,
    });
  }
  // Under way (or already arrived) on THIS destination — the block's job is done.
  if (targetKey === id && travel !== null && travel.status !== "idle") {
    return tick(WAIT, "The autopilot has the ship.", "On course", { kind: "done" });
  }
  if (flag(mem, "issued")) {
    // Give the route a tick or two to appear in the travel reading before we
    // decide it never took (starting a route does a couple of reads first).
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > WARP_START_WAIT_TICKS) {
      return tick(WAIT, "The autopilot never started.", "Setting a course", {
        kind: "blocked",
        reason: "The trip would not start, so the bot stopped.",
      });
    }
    return tick(WAIT, "Setting the course.", "Setting a course", ACTING, false, { ...mem, waited });
  }
  return tick(
    toSystem ? { kind: "startSystemRoute", systemID: id } : { kind: "startRoute", stationID: id },
    "Setting the destination and starting the autopilot.",
    "Setting a course",
    ACTING,
    false,
    { issued: true, waited: 0 },
  );
};

// ── dock-at-nearest ──────────────────────────────────────────────────────────
// The get-inside-now block: the closest station or structure ON THE GRID, right
// now. The same "nearest dockable" pick the panic override makes, promoted to a
// block — and deliberately grid-local, because a station chosen when the script
// was written would not be the nearest one later. Drones come home first (a warp
// with drones out abandons them), then the shared close-in ladder docks it.
const DOCKABLE = new Set(["station", "structure"]);

const dockAtNearest: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked.", "Docking", { kind: "done" });
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Docking", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Docking", ACTING, false, mem);
  }
  const measurement = measureSpace(snapshot);
  const docks = snapshot.entities.filter((e) => DOCKABLE.has(e.kind ?? ""));
  const target = nearest(docks, measurement);
  if (target === null) {
    return tick(WAIT, "No station in view.", "Docking", {
      kind: "blocked",
      reason: "There is no station in view here to dock at.",
    });
  }
  const recall = recallBeforeLeaving(obs, mem, "Docking", target.itemID);
  if (recall !== null) {
    return recall;
  }
  const step = decideCloseIn(target.itemID, DOCK_RANGE_M, measurement, num(mem, "closingOn"));
  if (step === null || step.kind === "arrive") {
    return tick({ kind: "dock", stationID: target.itemID }, "Docking at the nearest station.", "Docking", ACTING, false, mem);
  }
  if (step.kind === "closing") {
    return tick(WAIT, "Closing on the station.", "Docking", ACTING, false, mem);
  }
  if (step.kind === "approach") {
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Closing on the station.",
      "Docking",
      ACTING,
      false,
      { ...mem, closingOn: target.itemID },
    );
  }
  return tick({ kind: "warp", targetID: target.itemID }, "Warping to the nearest station.", "Docking", ACTING, false, mem);
};

// ── remote-cap ───────────────────────────────────────────────────────────────
// The cap-chain twin of remote-rep: find the fleet-mate whose capacitor is
// emptiest, lock them, and run the fitted remote capacitor transmitters into
// them. Same shape, same verified calls, a different module family and a
// different reading (the snapshot already carries every ship's capacitorRatio).
const CAP_HUNGRY = 0.9; // below this is worth a cycle

const remoteCap: MacroDecider = (step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Feeding cap", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Feeding cap", ACTING, false, mem);
  }
  const transmitters = obs.remoteCapModuleIDs ?? [];
  if (transmitters.length === 0) {
    return tick(WAIT, "No remote capacitor transmitter fitted.", "Feeding cap", {
      kind: "blocked",
      reason: "This ship has no remote capacitor transmitter fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Feeding cap", ACTING, false, mem);
  }
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  let target: SpaceEntity | null = null;
  let worst = CAP_HUNGRY;
  for (const mate of friendlies) {
    const cap = mate.capacitorRatio;
    if (cap !== null && cap < worst) {
      target = mate;
      worst = cap;
    }
  }
  const settlement = settleRemoteAssistance(obs, mem, transmitters, target?.itemID ?? null, "cap", "Feeding cap");
  if (settlement !== null) return settlement;
  if (target === null) {
    return tick(WAIT, "Everyone on grid has capacitor to spare.", "Feeding cap", { kind: "done" });
  }
  const changed = num(mem, "capLockOn") !== target.itemID;
  if (changed) mem = { ...mem, capLockOn: target.itemID, capWaited: 0, capTries: 0, capApproached: null };
  const locked = (obs.lockedTargetIDs ?? []).includes(target.itemID);
  if (!locked) {
    if (changed) {
      // A new mate resets what is counted per-target (see repHurtMate), and a
      // refused press is read off the ledger before pressing again (same place).
      const lockRefusals = readLockRefusals(step, obs, mem);
      if (lockRefusals.unread) {
        return tick(WAIT, "Checking the last lock.", "Feeding cap", ACTING, true, {
          ...mem,
          capLockOn: null,
          lockRefusalsSeen: lockRefusals.count,
        });
      }
      if (lockRefusals.fresh && refusalTargets(lockRefusals, target.itemID)) {
        return tick(WAIT, "Waiting for the lock.", "Feeding cap", ACTING, true, { ...mem, lockRefusalsSeen: lockRefusals.count });
      }
      return tick({ kind: "lock", targetID: target.itemID }, "Locking the fleet-mate who needs cap.", "Feeding cap", ACTING, true, {
        ...mem,
        capLockOn: target.itemID,
        capWaited: 0,
        capTries: 0,
        capApproached: null,
        lockRefusalsSeen: 0,
      });
    }
    const waited = (num(mem, "capWaited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That fleet-mate would not lock — watching for another.", "Feeding cap", ACTING, true, { ...mem, capLockOn: null });
    }
    return tick(WAIT, "Waiting for the lock.", "Feeding cap", ACTING, true, { ...mem, capWaited: waited });
  }
  // Same two rules as repHurtMate: a transmitter has a range the lock does not,
  // and an activation that will not land has to be bounded.
  const rangeToMate = measureSpace(snapshot)?.distances.get(target.itemID) ?? null;
  const outOfReach = rangeToMate !== null && rangeToMate > REMOTE_ASSIST_RANGE_M;
  if (outOfReach) {
    if (num(mem, "capApproached") !== target.itemID) {
      return tick(
        { kind: "approach", targetID: target.itemID },
        "Closing in — too far out to pass them cap.",
        "Feeding cap",
        ACTING,
        true,
        clearCloseInStall({ ...mem, capApproached: target.itemID }),
      );
    }
    // The silent-refusal rung again — see repHurtMate's note.
    const stall = closeInStall(hullMode(snapshot), mem);
    if (stall.step === "reorder") {
      return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, "Feeding cap", ACTING, true, stall.mem);
    }
    if (stall.step === "unstick") {
      return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, "Feeding cap", ACTING, true, stall.mem);
    }
    mem = stall.step === "stuck" ? clearCloseInStall(stall.mem) : stall.mem;
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  // Consecutive failures only — see the note in repHurtMate.
  const capTries = transmitters.some((id) => active.has(id)) ? 0 : num(mem, "capTries") ?? 0;
  if (!outOfReach && capTries < MAX_REMOTE_ASSIST_ATTEMPTS) {
    const idle = transmitters.find((id) => !active.has(id));
    if (idle !== undefined) {
      return tick(
        { kind: "activate", moduleID: idle, targetID: target.itemID },
        "Feeding them capacitor.",
        "Feeding cap",
        ACTING,
        true,
        { ...mem, capTries: capTries + 1, [`capTarget:${idle}`]: target.itemID },
      );
    }
  }
  return tick(WAIT, "Feeding the fleet-mate cap.", "Feeding cap", ACTING, true, mem);
};

// ═══ Cargo extras ═══════════════════════════════════════════════════════════

// ── jettison-cargo ───────────────────────────────────────────────────────────
// Dump the cargo hold into space as a can — the jetcan a miner fills instead of
// flying home. One item type if the player picked one, otherwise the whole hold.
// Confirmed by re-reading the hold: what was jettisoned has LEFT it, so the
// block is done when nothing matching is aboard. That means a silently refused
// jettison retries within its bound rather than being believed.
const jettisonCargo: MacroDecider = (step, obs, mem) => {
  // Docked is a verdict; unreadable is not (see compress-ore's note).
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — a can has to go somewhere.", "Jettisoning", {
      kind: "blocked",
      reason: "Undock first — jettisoning drops a container into space.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Jettisoning", ACTING, false, mem);
  }
  const cargo = obs.cargo ?? null;
  if (cargo === null) {
    return tick(WAIT, "Reading the cargo hold.", "Jettisoning", ACTING, false, mem);
  }
  const item = step.args["item"];
  const wanted =
    item !== undefined && item.kind === "itemType" && item.typeID !== null ? item.typeID : null;
  // ⚠ "keep" ON AN UNREADABLE ROW, and this is the block where that matters.
  // A jettisoned stack goes into a can that despawns: there is no undo, so
  // "I could not tell what this is" must never be enough to throw it into space.
  const rows = movableRows(
    cargo.rows.filter((row) => wanted === null || row.typeID === wanted),
    keepRules(step),
    "keep",
  );
  if (rows.length === 0) {
    return tick(WAIT, "Nothing left in the hold to jettison.", "Jettisoning", { kind: "done" });
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not go out.", "Jettisoning", {
      kind: "blocked",
      reason: "The cargo would not jettison after several tries, so the bot stopped.",
    });
  }
  return tick(
    { kind: "jettison", itemIDs: rows.map((row) => row.itemID) },
    "Jettisoning the cargo into space.",
    "Jettisoning",
    ACTING,
    false,
    { ...mem, tries },
  );
};

// ── jettison-ore ─────────────────────────────────────────────────────────────
// The same jetcan-drop as jettison-cargo, but empties the ORE hold (or
// whichever specialty hold — ice, gas — the ship carries) instead: a mining
// ship's own cargo hold sits empty the whole run, so a hauling loop built
// around jettison-cargo has nothing to work with. Same one-item-or-everything
// filter, same retry-then-block on a refused jettison; the only difference is
// which hold it reads.
const jettisonOre: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — a can has to go somewhere.", "Jettisoning", {
      kind: "blocked",
      reason: "Undock first — jettisoning drops a container into space.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Jettisoning", ACTING, false, mem);
  }
  const holds = obs.holds ?? null;
  if (!freightReadable(holds)) {
    return tick(WAIT, "Reading the ore hold.", "Jettisoning", ACTING, false, mem);
  }
  // The specialty hold — ore, ice, gas, whichever this hull has — never cargo,
  // same selection move-items already makes for its own "ore-hold" place.
  const oreHold = holds.find((hold) => hold.key !== "cargo" && hold.present) ?? null;
  if (oreHold === null) {
    return tick(WAIT, "This ship has no ore hold.", "Jettisoning", {
      kind: "blocked",
      reason: "This ship has no ore hold to jettison from.",
    });
  }
  const item = step.args["item"];
  const wanted =
    item !== undefined && item.kind === "itemType" && item.typeID !== null ? item.typeID : null;
  const rows = oreHold.items.filter((row) => wanted === null || row.typeID === wanted);
  if (rows.length === 0) {
    return tick(WAIT, "Nothing left in the ore hold to jettison.", "Jettisoning", { kind: "done" });
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The ore would not go out.", "Jettisoning", {
      kind: "blocked",
      reason: "The ore would not jettison after several tries, so the bot stopped.",
    });
  }
  return tick(
    { kind: "jettison", itemIDs: rows.map((row) => row.itemID) },
    "Jettisoning the ore into space.",
    "Jettisoning",
    ACTING,
    false,
    { ...mem, tries },
  );
};

// ── tidy-hangar ──────────────────────────────────────────────────────────────
// Stack everything loose in the station hangar. One shot: the server merges what
// it can, and a second pass would find nothing to do — so this issues once and is
// done, rather than trying to prove a stack count went down (which a concurrent
// change would make a lie).
const tidyHangar: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked — the hangar is at a station.", "Tidying", {
      kind: "blocked",
      reason: "Dock at a station first — this block tidies its hangar.",
    });
  }
  if (flag(mem, "stacked")) {
    return tick(WAIT, "The hangar is stacked.", "Tidying", { kind: "done" });
  }
  return tick({ kind: "stackHangar" }, "Stacking the hangar.", "Tidying", ACTING, false, { ...mem, stacked: true });
};

// ── compress-ore ─────────────────────────────────────────────────────────────
// The fleet mechanic: a mining support ship on grid — your own hull or a
// fleet-mate's — running an industrial core plus compression gear is a FACILITY,
// and ore in your own hold can be squeezed to a fraction of its volume while you
// sit inside its range.
//
// ⚠ THE FACILITY IS FOUND FROM A READING, NOT GUESSED. `compressionFacility` is
// projected onto a ship row only while the modules really are running, so the
// block can say "there is no support ship compressing here" instead of firing
// hopefully into the dark — which matters because the server answers "not a
// facility", "out of range" and "this ore has no compressed form" with the SAME
// silence. A ship whose facility reading is absent is simply not a candidate.
//
// ⚠ AND EACH STACK IS JUDGED BY THE HOLD, NOT BY THE ANSWER. A compressed stack
// becomes a different TYPE at the same quantity, so the next hold read shows it
// gone from the ore's type. `triedItemIDs` remembers which stacks have had their
// one attempt, so an ore with no compressed form is skipped after one try rather
// than retried forever — that is what keeps this bounded without pretending the
// refusal told us why.
const COMPRESS_MAX_TRIES_PER_STACK = 1;

// ⚠ THE FACILITY RULE MOVED TO `space/compression.ts`, and this now imports it.
// The Mining panel needs the same answer, and the branch two copies get wrong
// is the `?? null` one — an ABSENT reading has to mean "not a facility", never
// "an unknown worth firing at". One implementation, one place to get it right.

function parseTried(mem: MacroMemory): readonly string[] {
  const raw = mem["triedItemIDs"];
  return typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
}

const compressOre: MacroDecider = (_step, obs, mem) => {
  // ⚠ DOCKED is a verdict; UNREADABLE is not. `inSpace !== true` would lump the
  // two together and tell a player to undock a ship whose location simply had not
  // been read yet — the "null is never a verdict" rule, in the one place it is
  // easiest to get wrong.
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — compression happens at a ship on grid.", "Compressing", {
      kind: "blocked",
      reason: "Undock first — this block uses a support ship out on the grid.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Compressing", ACTING, false, mem);
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Compressing", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  const holds = obs.holds ?? null;
  if (snapshot === null || holds === null) {
    return tick(WAIT, "Reading the hold.", "Compressing", ACTING, false, mem);
  }

  const tried = parseTried(mem);
  // ⚠ A hold whose read FAILED carries items:null, which is "we could not look",
  // not "it is empty" — so a failed read must not finish the block. Wait for a
  // hold we can actually see rather than declaring the job done.
  if (!freightReadable(holds)) {
    return tick(WAIT, "Could not read a hold just now.", "Compressing", ACTING, false, mem);
  }
  // Ore still worth trying: in a hold, and not already given its one attempt.
  const pending = holds
    .flatMap((hold) => hold.items ?? [])
    .filter((item) => !tried.includes(String(item.itemID)));
  if (pending.length === 0) {
    return tick(WAIT, "Nothing left in the hold to compress.", "Compressing", { kind: "done" });
  }

  const facility = compressionFacilities(snapshot)[0] ?? null;
  if (facility === null) {
    return tick(WAIT, "No support ship is compressing here.", "Compressing", {
      kind: "blocked",
      reason:
        "No mining support ship on this grid is running its compression gear — bring one, or switch it on, and try again.",
    });
  }

  // In range? The facility's own reach, which is the number the server checks.
  const measurement = measureSpace(snapshot);
  const isOwnShip = facility.itemID === (snapshot.ship?.itemID ?? null);
  if (!isOwnShip) {
    const distance = measurement?.distances.get(facility.itemID) ?? null;
    const reach = facility.compressionFacility?.rangeMeters ?? 0;
    if (distance !== null && distance > reach) {
      // Close in on it — the same shared ladder every other block uses. Its own
      // range is the arrival radius, so we stop when the server would accept us.
      const step = decideCloseIn(facility.itemID, reach, measurement, num(mem, "closingOn"));
      if (step !== null && step.kind === "closing") {
        return tick(WAIT, "Closing on the support ship.", "Compressing", ACTING, false, mem);
      }
      if (step !== null && step.kind === "warp") {
        return tick({ kind: "warp", targetID: facility.itemID }, "Warping to the support ship.", "Compressing", ACTING, false, mem);
      }
      return tick(
        { kind: "approach", targetID: facility.itemID },
        "Closing on the support ship.",
        "Compressing",
        ACTING,
        false,
        { ...mem, closingOn: facility.itemID },
      );
    }
  }

  const target = pending[0]!;
  return tick(
    { kind: "compressOre", itemID: target.itemID, facilityID: facility.itemID },
    "Compressing a stack of ore.",
    "Compressing",
    ACTING,
    false,
    {
      ...mem,
      closingOn: null,
      triedItemIDs: [...tried, String(target.itemID)].slice(-MAX_TRIED_STACKS).join(","),
    },
  );
};

/** How many attempted stacks to remember — a hold cannot hold more than this. */
const MAX_TRIED_STACKS = 200;

const launchScanProbes: MacroDecider = (_step, obs) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the probe launcher just now.", "Launching probes", ACTING, false);
  }
  if (!scanner.inSpace) {
    return tick(WAIT, "The ship must be in space to launch probes.", "Launching probes", {
      kind: "blocked",
      reason: "Launch scan probes needs the ship to be in space.",
    });
  }
  if (scanner.probes.length > 0) {
    return tick(WAIT, "The scan probes are out.", "Launching probes", { kind: "done" });
  }
  if (scanner.launcher === null || scanner.launcher.launchCount <= 0) {
    return tick(WAIT, "No probes are ready in an online launcher.", "Launching probes", {
      kind: "blocked",
      reason: "Fit an online probe launcher with scanner probes and leave room for active probes.",
    });
  }
  return tick(
    { kind: "scannerLaunch" },
    `Launching ${scanner.launcher.launchCount} scan probe${scanner.launcher.launchCount === 1 ? "" : "s"}.`,
    "Launching probes",
    ACTING,
    false,
  );
};

const analyzeSignatures: MacroDecider = (_step, obs, mem) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the probe formation just now.", "Analyzing signatures", ACTING, false, mem);
  }
  if (scanner.probes.length === 0) {
    return tick(WAIT, "No active probes can analyze signatures.", "Analyzing signatures", {
      kind: "blocked",
      reason: "Launch scan probes before analyzing signatures.",
    });
  }
  if (flag(mem, "issued")) {
    return tick(WAIT, "The signature analysis was requested.", "Analyzing signatures", { kind: "done" });
  }
  return tick(
    { kind: "scannerAnalyze" },
    "Analyzing signatures with the current probe formation.",
    "Analyzing signatures",
    ACTING,
    false,
    { ...mem, issued: true },
  );
};

const recoverScanProbes: MacroDecider = (_step, obs) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the active probes just now.", "Recovering probes", ACTING, false);
  }
  if (scanner.probes.length === 0) {
    return tick(WAIT, "All scan probes are aboard.", "Recovering probes", { kind: "done" });
  }
  return tick(
    { kind: "scannerRecover" },
    `Recovering ${scanner.probes.length} scan probe${scanner.probes.length === 1 ? "" : "s"}.`,
    "Recovering probes",
    ACTING,
    false,
  );
};

/** The registry the runner dispatches on, keyed by MacroID. */
export const SCRIPT_MACROS: CompleteMacroRegistry = {
  undock,
  "travel-to-belt": travelToBelt,
  "travel-to-system": travelToSystem,
  "mine-at-belt": mineAtBelt,
  "fleet-mine": fleetMine,
  "join-support-fleet": joinSupportFleet,
  "mining-support": miningSupport,
  "deliver-ore": deliverOre,
  "travel-to-station": travelToStation,
  "defend-with-drones": defendWithDrones,
  "find-distribution-agent": findDistributionAgent,
  "request-mission": requestMission,
  "accept-mission": acceptMission,
  "load-mission-cargo": loadMissionCargo,
  "travel-to-dropoff": travelToDropoff,
  "turn-in-mission": turnInMission,
  "return-to-agent": returnToAgent,
  wait: waitBlock,
  "unload-cargo": unloadCargo,
  "load-cargo": loadCargo,
  "haul-all": createCorporateHauler(rideAutopilotTo),
  "route-hauler": createCorporateHauler(rideAutopilotTo),
  "salvage-wrecks": salvageWrecks,
  "loot-wrecks": lootWrecks,
  "loot-containers": lootContainers,
  "refine-ore": refineOre,
  "hardeners-on": hardenersOn,
  "fight-the-rats": fightTheRats,
  "fight-with-drones": fightWithDrones,
  "warp-to-anomaly": warpToAnomaly,
  "warp-to-ore-anomaly": warpToOreAnomaly,
  "refit-ship": refitShip,
  "board-previous-ship": boardPreviousShip,
  "board-planetary-hauler": boardPlanetaryHauler,
  "move-items": moveItems,
  "warp-to-bookmark": warpToBookmark,
  "find-combat-agent": findCombatAgent,
  "fly-to-mission-site": flyToMissionSite,
  "restart-extractors": restartExtractors,
  "launch-commodities": launchCommodities,
  "collect-launches": collectLaunches,
  "collect-customs": collectCustoms,
  "repair-ship": repairShip,
  "buy-item": buyItem,
  "sell-item": sellItem,
  "remote-rep": remoteRep,
  "orbit-and-boost": orbitAndBoost,
  "orbit-fleet-mate": orbitFleetMate,
  "follow-fleet-mate": followFleetMate,
  "fleet-tag-target": fleetTagTarget,
  "create-fleet": createFleet,
  "invite-to-fleet": inviteToFleet,
  "join-fleet": joinFleet,
  "join-advertised-fleet": joinAdvertisedFleet,
  "set-destination": setDestination,
  "dock-at-nearest": dockAtNearest,
  "remote-cap": remoteCap,
  "jettison-cargo": jettisonCargo,
  "jettison-ore": jettisonOre,
  "tidy-hangar": tidyHangar,
  "compress-ore": compressOre,
  "launch-scan-probes": launchScanProbes,
  "analyze-signatures": analyzeSignatures,
  "recover-scan-probes": recoverScanProbes,
};

/**
 * Home-travel for a latched "dock and stop" response. `flow.ts` resolves the
 * document's configured home every tick — fixed id, starting station, or a
 * station published onto the run board — and puts the result on the observation.
 * The shared autopilot makes that station reachable from any system.
 */
/**
 * How many times the way home may be FOUGHT clear before the bot accepts that it
 * is not getting out. Each attempt is a whole grid cleared, so three is already
 * a long fight; past that, something other than a rat is wrong.
 */
const MAX_ESCAPE_ATTEMPTS = 3;

/**
 * The synthetic step the escape borrows the combat blocks under.
 *
 * ⚠ ITS ID IS THE ONE THE RUNNER BOOKS THE TRIP UNDER, NOT A NAME OF ITS OWN. The
 * borrowed ladder reads the refusal ledger by the id of the step it is handed
 * (`readLockRefusals`), and the runner keys the trip's presses by the latch: the
 * watch row that fired, or no step at all. Under a made-up id the ladder never
 * saw its own refused lock, pressed it ten times, and the run then STOPPED in
 * space — a second fault under a latch is a stop — with the ship still held.
 */
function escapeStep(bookedUnder: string | null): MacroStep {
  return { id: bookedUnder ?? NO_STEP_ID, kind: "macro", macro: "fight-the-rats", args: {} };
}

/** The synthetic step the last-resort dock borrows `dock-at-nearest` under. */
const HARBOUR_STEP: MacroStep = { id: "__harbour__", kind: "macro", macro: "dock-at-nearest", args: {} };

/** Nested memory slot for that dock, so its close-in and recall bookkeeping
 *  cannot collide with the trip's own in the shared home-memory slot. */
const HARBOUR_MEM_KEY = "harbourDock";

/**
 * THE TRIP HOME CANNOT FLY — SO TAKE ANY DOOR, NOT NO DOOR.
 *
 * ⚠ THIS IS THE LINE BETWEEN "STOPPED" AND "STRANDED". `stopSafely` in
 * scriptDecide.ts is explicit that docked is the only place a bot may come to
 * rest, and it flies the ship home to get there — but when that flight is itself
 * blocked, `continueHeadingHome` simply paused, and the ship came to rest in
 * space anyway: guns off, drones in, exactly the unattended wreck-in-waiting the
 * doctrine exists to prevent.
 *
 * Home being unreachable says nothing about the station on this grid. A route
 * that cannot be plotted, a destination that no longer resolves, a warp the
 * server will not take to THERE — none of them stop a ship docking HERE, and
 * `dock-at-nearest` is grid-local by construction.
 *
 * ⚠ IT IS NOT A CURE FOR A SHIP THAT CANNOT MOVE AT ALL, and must not pretend to
 * be. A hold that blocks warping usually blocks docking too (the server checks
 * the same pilot-warp landing handoff in `acceptDocking` as in `warpToEntity`),
 * so this genuinely rescues the "home specifically is unreachable" half and
 * reports the other half honestly instead of dressing it up as a plan.
 */
function dockLastResort(obs: ScriptObservation, mem: MacroMemory, blockedReason: string): MacroTick {
  const harbourMem = (mem[HARBOUR_MEM_KEY] as MacroMemory | undefined) ?? {};
  const dock = dockAtNearest(HARBOUR_STEP, obs, harbourMem, {});
  const carried = { ...mem, [HARBOUR_MEM_KEY]: dock.nextMem };

  if (dock.outcome.kind === "done") {
    // Inside something. That is the whole goal of a safe stop.
    return tick(WAIT, "Home could not be reached, so the ship docked here instead.", "Heading home", {
      kind: "done",
    });
  }
  if (dock.outcome.kind === "blocked") {
    // Nowhere to go and no way to get there: stop, and say BOTH halves, because
    // "the trip home failed" alone sends a reader looking at the route when the
    // ship could not have docked ten metres away either.
    return tick(WAIT, dock.why, "Heading home", {
      kind: "blocked",
      reason: `${blockedReason} The ship could not dock here either: ${dock.outcome.reason}`,
    });
  }
  return { ...dock, phase: "Heading home", nextMem: carried };
}

/**
 * ⚠ THE TRIP HOME FAILED, WHICH USUALLY MEANS SOMETHING IS HOLDING THE SHIP.
 * A scrambled warp comes back as a plain refusal, the autopilot pauses with it,
 * and `rideAutopilotTo` reports the trip BLOCKED. Treating that as "stop here"
 * is how a bot ends up sitting still in a belt, tackled, guns off, until it dies
 * — the ship is told to run, cannot run, and so does nothing at all.
 *
 * A pilot in that spot does not sit there: they harden up and kill the thing
 * holding them, then leave. So does this. Both halves are BORROWED from the
 * blocks that already do them, under their own nested memory so their counters
 * (hardener attempts, which rat is primary) cannot collide with the trip's own
 * bookkeeping in the shared home-memory slot.
 *
 * Returns null when there is nothing to do about it — nothing in reach to shoot,
 * no way to shoot it, or the escape budget is spent — and the blocked trip then
 * stands and stops the bot, which is the honest end.
 */
function fightTheWayOut(
  obs: ScriptObservation,
  mem: MacroMemory,
  stationID: number,
  bookedUnder: string | null,
): MacroTick | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null || obs.inSpace !== true || obs.inWarp === true) {
    return null; // cannot judge the grid, or already leaving
  }
  const tries = num(mem, "escapeTries") ?? 0;
  if (tries >= MAX_ESCAPE_ATTEMPTS) {
    return null;
  }
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  if (hostilesInReach(obs, snapshot, origin).length === 0) {
    // Nothing left in reach. If we fought for this, ask for the route AGAIN:
    // the autopilot's failure is sticky, so without a fresh start the trip stays
    // blocked forever on a grid that is now clear. Counted, so a route that
    // keeps failing for some OTHER reason cannot loop here.
    if (!flag(mem, "escaping")) {
      return null;
    }
    return tick(
      { kind: "startRoute", stationID },
      "The grid is clear — trying the trip home again.",
      "Heading home",
      ACTING,
      false,
      // The recall bookkeeping is cleared with it: `recallBeforeLeaving` marks
      // the drones called in ONCE per trip, and the fight has just put them back
      // out. Without this reset the retry would warp off and leave them behind.
      {
        ...mem,
        escaping: false,
        escapeTries: tries + 1,
        escapeFight: {},
        escapeHarden: {},
        recalled: false,
        recallWaited: 0,
        aligned: false,
      },
    );
  }
  // Held. The tank goes up first, then the guns — the same order the pirate
  // watch uses, and the same blocks.
  const step = escapeStep(bookedUnder);
  const hardenMem = (mem["escapeHarden"] as MacroMemory | undefined) ?? {};
  const harden = hardenersOn(step, obs, hardenMem, {});
  if (harden.outcome.kind === "acting") {
    return { ...harden, phase: "Fighting free", nextMem: { ...mem, escaping: true, escapeHarden: harden.nextMem } };
  }
  const fightMem = (mem["escapeFight"] as MacroMemory | undefined) ?? {};
  const fight = fightTheRats(step, obs, fightMem, {});
  if (fight.outcome.kind !== "acting") {
    return null; // no way to fight — the blocked trip stands
  }
  return { ...fight, phase: "Fighting free", nextMem: { ...mem, escaping: true, escapeFight: fight.nextMem } };
}

export const scriptTravelHome: HomeTravelDecider = (obs, mem, bookedUnder = null) => {
  if (obs.flightStatus?.docked === true) {
    // Docked ANYWHERE is safe — the point of a fired watch is to be in a
    // station, not to commute. Stop here.
    return tick(WAIT, "Stopped.", "Heading home", { kind: "done" });
  }
  const target = obs.homeStationID ?? null;
  if (target === null) {
    // Starting in space cannot resolve "where I started" to a station, and a
    // board-slot home may not have been published when an early watch fires.
    // Pausing IN SPACE is not the desired safety outcome, but it is honest and
    // bounded; reporting `done` here used to claim the ship was safe while it
    // was still exposed. Never invent a destination.
    return tick(WAIT, "Home is not known, so the ship stopped instead of guessing.", "Heading home", {
      kind: "blocked",
      reason: "This bot does not know which station is home, so it stopped instead of flying to a guess.",
    });
  }
  // The trip is judged BEFORE the drones are called in: a ship that cannot leave
  // needs its drones out to shoot its way free, and pulling them in first would
  // disarm it in the one moment it needs them.
  const ride = rideAutopilotTo(obs, target, "Heading home", obs.homeDockableKind ?? "station");
  if (ride !== null && ride.outcome.kind === "blocked") {
    const escape = fightTheWayOut(obs, mem, target, bookedUnder);
    if (escape !== null) {
      return escape;
    }
    // Nothing holding the ship that shooting would fix, and the trip still will
    // not fly. Before giving up in space, try the door on this grid.
    return dockLastResort(obs, mem, ride.outcome.reason);
  }
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Heading home", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Stopped.", "Heading home", { kind: "done" });
};
