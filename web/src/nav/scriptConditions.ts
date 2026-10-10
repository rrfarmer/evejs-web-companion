// A4a — reading the world for a player script: tri-state conditions and which
// interrupt fires. Pure over an observation; the runner (slice B) builds the
// observation from fresh reads each tick and feeds it here.
//
// ⚠ CANNOT-TELL NEVER PASSES, AND THAT IS THE WHOLE POINT. Every check is
// met / not-met / cannot-tell. A read that FAILED is not a read that said "no" —
// so an `until` that cannot be read does not advance the program, and an
// interrupt that cannot be read does not fire (nor is it quietly treated as
// "fine", which is how a dead-man switch rots). Two guards live here:
//
//   • THE ACUTE RULE (sealed, from the hand-written mining bot): a hostile is on
//     the grid AND ship health cannot be read → stop safely. Explicit escape
//     authority may fire first; optional combat cannot mask unreadable health.

import type { Condition, InterruptRow } from "../bots/botScript.ts";
import type {
  AgentConversation,
  ColonyPinKind,
  CourierBriefing,
  FlightStatus,
  InventoryItemRow,
  JournalState,
  MiningHold,
  ShipBay,
  SpaceSnapshot,
  SpaceVector,
} from "../store/types.ts";
import type { CargoReading, TravelReading } from "./missionBotLoop.ts";
import type { SavedFitting } from "../bridge/fittings.ts";
import type { ScannerOperationsSnapshot } from "../scanner/scannerCenter.ts";
import type { ExplorationSiteKind } from "../scanner/siteKind.ts";
import type { RefusalRecord } from "./refusalLedger.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
import type { ExtractorReroute } from "../bridge/colonyRoutes.ts";
import type { RatThreat } from "./ratThreat.ts";
import type { PropulsionModule } from "./propulsion.ts";
import type { MiningDroneState } from "./miningDroneFlight.ts";
import { hostileRows, type OverviewRow } from "../space/overview.ts";
import type { FleetMinerInput } from "./fleetMiner.ts";
import type { MiningSupportFleetObservation } from "./miningSupportFleet.ts";

// ─── The observation ─────────────────────────────────────────────────────────

/**
 * Everything a condition can test, read FRESH each tick. `null` means UNREADABLE
 * throughout — never a value, never "no". `health` is the lowest of the three
 * ship-health ratios (the mining bot's `lowestHealth`), carried as its own field
 * because `health-below` watches the weakest layer while `shield-below` watches
 * one specific layer.
 */
/**
 * One cosmic anomaly on the scanner: the scan label a warp is issued against,
 * and WHAT KIND of site it is so a block can skip the ones it does not want.
 * `kind` is "unknown" when the row carried nothing that classifies it — never a
 * guess (see scanner/siteKind.ts).
 */
export interface ScannedAnomaly {
  readonly siteID?: number | null;
  readonly instanceID?: number | null;
  readonly label: string;
  readonly kind: ExplorationSiteKind;
  readonly archetypeID?: number | null;
  /**
   * Where the site sits in this solar system, in metres — the scanner row's own
   * `position`, not a guess. Optional, and `null` when the row carried none.
   *
   * It answers ONE question no wording can: a warp the server refused because
   * the ship is ALREADY STANDING IN THE SITE comes back in the same words as
   * half a dozen other blockers (see `warpToAnomalyOfKind`), and the ship's own
   * position beside this one separates them.
   */
  readonly position?: SpaceVector | null;
}

/** One belt the shared memory says is dry: entirely (`all`) or of these ore families (type groups). */
export interface DryBelt {
  readonly beltName: string;
  readonly all: boolean;
  readonly families: readonly number[];
}

export type MiningOperationRole = "MINER" | "HAULER" | "DEFENDER" | "COMMAND";
export interface MiningSupportOptions {
  readonly version: 1; readonly characterID: number; readonly fleetPolicy: "EXISTING_ONLY" | "MANAGED";
  readonly maintainBursts: boolean; readonly useIndustrialCore: boolean; readonly coreRequirement: "continueWithoutCore" | "requireCore";
  readonly enableCompression: boolean; readonly selfMining: boolean; readonly tractor: boolean;
  readonly collection: "TRACTOR_ONLY" | "TRACTOR_AND_COLLECT"; readonly compressCollectedOre: boolean;
  readonly supportLoss: "CONTINUE_UNSUPPORTED" | "PAUSE" | "STOP";
}
export type MiningTargetType = "BELT" | "ORE_ANOMALY" | "ICE" | "GAS";
export interface MiningOperationTarget {
  readonly siteIdentity?: string;
  readonly siteID?: number;
  readonly instanceID?: number | null;
  readonly position?: SpaceVector;
  readonly targetKey: string;
  readonly targetType: MiningTargetType;
  readonly systemID: number;
  readonly systemName: string | null;
  readonly targetName: string;
  readonly state: "AVAILABLE" | "RESERVED" | "ACTIVE" | "DRAINING" | "DEPLETED";
  readonly claimedByOperationID: string | null;
}
export interface MiningOperationAssignment {
  readonly operationRunID?: string | null;
  readonly support?: MiningSupportOptions;
  readonly supportPolicy?: { readonly mode: "NORMAL" | "FALLBACK" | "PAUSE" | "STOP"; readonly reason: string | null };
  readonly intendedFleetCharacterIDs?: readonly number[];
  readonly resourcePolicy?: import("./resourcePriority.ts").ResourcePolicy | null;
  readonly travelAssist?: "DISABLED" | "AUTO";
  readonly stopRequested?: boolean;
  readonly operationID: string;
  readonly operationName: string;
  readonly role: MiningOperationRole;
  readonly unloadPolicy: "HAULER_SERVICE" | "SELF_UNLOAD";
  readonly area: {
    readonly anchorSystemID: number;
    readonly anchorSystemName: string | null;
    readonly reach: "CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT";
    readonly targetClasses: readonly MiningTargetType[];
  };
  readonly state: string;
  readonly currentTarget: MiningOperationTarget | null;
  readonly logisticsTarget: MiningOperationTarget | null;
  /** BFF-recorded cans from this run's miner jettison at the assigned target. */
  readonly ownedContainerIDs?: readonly number[];
  readonly miningOwnerIDs?: readonly number[];
  readonly containerProvenanceUnconfirmed?: boolean;
  readonly rendezvous: {
    readonly kind: "MINER_CLEARANCE" | "SELF_UNLOAD";
    readonly required: readonly number[];
    readonly ready: readonly number[];
    readonly thisMemberReady: boolean;
  } | null;
}

/**
 * One row of the fleet finder, as a block sees it. Deliberately NOT the bridge's
 * full `FleetAdvert`: a decider needs the name to match on, the id to apply with,
 * and the size to break a tie between two fleets sharing a name - and nothing
 * else here should depend on the wire shape.
 */
export interface FleetAdRow {
  readonly fleetID: number;
  readonly fleetName: string;
  readonly numMembers: number;
}

/**
 * The answer the last fleet-finder apply gave, carried back to the block that
 * asked for it.
 *
 * An apply does not join you: on an open advert the server mints an INVITE and
 * the client must accept it, and on an approval-gated one it stores a request
 * only the boss can act on. Those two need different behaviour from the block,
 * and the server's own answer at the moment of the call is the authority on
 * which happened -- better than the advert's `joinNeedsApproval`, which was read
 * earlier and may since have changed.
 */
export interface FleetApplication {
  readonly fleetID: number;
  /** "unknown" means try the accept anyway -- see FleetApplyOutcome. */
  readonly outcome: "needs-approval" | "invited" | "unknown";
  readonly supportOrder?: { readonly scope: import("./miningSupportFleet.ts").SupportFleetScope; readonly actionID: number };
}

/**
 * The advert to apply to for a fleet the player named, or null when no listed
 * advert carries that name. `wanted` is already lowercased.
 *
 * ⚠ THE TIE-BREAK IS PART OF THE ANSWER, NOT AN IMPLEMENTATION DETAIL. Fleet
 * names are not unique, so two adverts can both match: the BIGGER fleet wins,
 * because the op with people already in it is the one the player meant, and the
 * lower id breaks a tie between equals so two pilots reading the same listing
 * never split across two fleets of the same size and name.
 *
 * ⚠ IT LIVES IN THIS LEAF MODULE, NOT IN scriptMacros.ts WHERE IT WAS WRITTEN,
 * because there are now two callers: the `join-advertised-fleet` block and the
 * Fleet companions window's own join watch (nav/fleetJoinWatch.ts). A second
 * copy of a tie-break is a second copy that drifts, and the window must not
 * import the whole macro catalogue to ask one question.
 */
export function pickAdvertisedFleet(
  ads: readonly FleetAdRow[],
  wanted: string,
): FleetAdRow | null {
  let best: FleetAdRow | null = null;
  for (const ad of ads) {
    if (ad.fleetID <= 0 || ad.fleetName.trim().toLowerCase() !== wanted) {
      continue;
    }
    if (
      best === null ||
      ad.numMembers > best.numMembers ||
      (ad.numMembers === best.numMembers && ad.fleetID < best.fleetID)
    ) {
      best = ad;
    }
  }
  return best;
}

export interface ScriptObservation {
  readonly combatWeapons?: import("./combatWeapons.ts").CombatWeapons | null;
  readonly combatUtilities?: import("./combatUtilities.ts").CombatUtilities | null;
  /** Ordinary continuous hardeners, independent of the starting macro hint. */
  readonly combatHardenerModuleIDs?: readonly number[];
  /** Fresh normal-flow reads. No saved runtime fleet identity or base-range fallback. */
  readonly fleetMining?: Pick<FleetMinerInput, "anchors" | "modules" | "sceneReceivedAtMs" | "nowMs" | "requirements"> & {
    readonly fleet: MiningSupportFleetObservation | null;
    readonly supportFleet?: MiningSupportFleetObservation | null;
  };
  readonly miningSupportWork?: { readonly readyForRelocation: boolean; readonly reason: string | null; readonly phase: string };
  /** Finite MCC Parking may perform an exact corporation deposit after target authority is released. */
  readonly strictCorpDelivery?: boolean;
  readonly miningSiteBookmarks?: Readonly<Record<string, number>>;
  readonly unavailableMiningTargetKeys?: readonly string[];
  readonly iceMiningModuleIDs?: readonly number[] | null;
  readonly oreMiningModuleIDs?: readonly number[] | null;
  readonly travelPropulsionModules?: readonly import("./propulsion.ts").PropulsionModule[];
  readonly inSpace: boolean | null;
  readonly docked: boolean | null;
  readonly inWarp: boolean | null;
  /**
   * How many warps this pilot has COMPLETED since the run's app session began —
   * monotonic, bumped on the tick a warp ends.
   *
   * ⚠ READ IT INSTEAD OF WATCHING FOR `inWarp`, because a macro cannot watch for
   * `inWarp`. The orchestrator holds every watch and every macro while the ship
   * is warping (`decideScriptAction`'s guard returns before the program), so no
   * macro is ever called on a tick where `inWarp` is true. Three blocks tried
   * anyway and each one silently lost its arrival check the day that guard
   * landed: they issued a warp, sat out the flight unasked, resumed having
   * witnessed nothing, and reported that the warp had never started while the
   * ship sat on the destination grid. A block records this count when it issues
   * its warp and compares it afterwards; a count that has gone up is an arrival,
   * and one that has not, after a generous wait, is a warp that truly never
   * began. Those two were indistinguishable before.
   *
   * Optional and nullable like every other read here: `null`/absent is "nobody
   * counted", and a block must fall back to its own wait budget rather than
   * treat it as zero.
   */
  readonly completedWarps?: number | null;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  readonly health: number | null;
  /** Own-ship capacitor, 0..1. Optional: older observations simply cannot tell. */
  readonly capacitorRatio?: number | null;
  /** Own wallet balance in ISK. Optional: read only when a wallet watch is set. */
  readonly walletBalance?: number | null;
  readonly oreHoldFraction: number | null;
  readonly holdEmpty: boolean | null;
  readonly hostileOnGrid: boolean | null;
  /**
   * The ordinary CARGO hold's fill level, 0..1 — NOT the ore hold above. Optional
   * and read only when something watches it, so a mining bot never pays for the
   * inventory read a hauler needs.
   */
  readonly cargoFraction?: number | null;
  /** The solar system the ship is in, by NAME — the key of the shared belt memory. */
  readonly systemName?: string | null;
  /**
   * Belts already found dry in THIS system, from the BFF's shared in-process
   * belt memory (every pilot running a mining bot reports into it, entries
   * expire on their own). Read only while a mine step is active. null =
   * unreadable — treated as "nothing known", never as "all dry".
   */
  readonly dryBelts?: readonly DryBelt[] | null;
  /** True when a PLAYER's ship on this grid has locked this ship. */
  readonly targetedByPlayer?: boolean | null;
  /** The lowest health, 0..1, among YOUR drones out in space; null with none out. */
  readonly lowestDroneHealth?: number | null;
  /**
   * True when this ship's own drones are out — ANY drones, whatever they are.
   * Not a player condition: the blocks that warp away read it to know there is
   * something to call home first, and the "launch drones on a pirate" interrupt
   * reads it to know the drone slots are taken (a launch into full slots is
   * refused every tick and would starve the step under it). Which drones are
   * out, by role, is the `combatDroneIDs` / `salvageDroneIDs` pair below.
   */
  readonly dronesOut: boolean | null;
  // ── Raw reads the macro adapters need (the conditions above are DERIVED from
  //    these). Optional so the pure decide/condition tests need not supply them;
  //    the live runner always does. Never trusted for tri-state — a null here is
  //    unreadable, same rule as everywhere.
  readonly flightStatus?: FlightStatus | null;
  readonly snapshot?: SpaceSnapshot | null;
  readonly lockedTargetIDs?: readonly number[] | null;
  readonly holds?: readonly MiningHold[] | null;
  readonly droneBayItemIDs?: readonly number[] | null;
  /** Fresh bay, controlled flight, limits and roles for the mining-flight policy. */
  readonly miningDrones?: MiningDroneState | null;
  readonly miningOperation?: MiningOperationAssignment | null;
  readonly miningOperationRequired?: boolean;
  readonly miningOperationReadError?: string | null;
  /**
   * The drone bay and the drones out BY ROLE, classified from the game's own
   * group name (see nav/droneRoles.ts). A block launches and orders drones for
   * the job they can do — combat drones fight, salvage drones salvage — never
   * the whole bay. `*DroneBayItemIDs` are bay stacks; `*DroneIDs` are drones in
   * space under THIS ship's control. null mirrors an unreadable bay / snapshot,
   * and a drone whose group has not resolved is in NO list: cannot tell, so it
   * is never launched for a job it may not be able to do.
   */
  readonly combatDroneBayItemIDs?: readonly number[] | null;
  readonly salvageDroneBayItemIDs?: readonly number[] | null;
  readonly combatDroneIDs?: readonly number[] | null;
  readonly salvageDroneIDs?: readonly number[] | null;
  /**
   * Logistic (remote-repair) drones, same two shapes as the pairs above.
   *
   * ⚠ FILLED FOR THE FLEET COMPANION, WHICH IS SO FAR THE ONLY THING THAT USES
   * THEM. The scripted blocks have no repair job to do, so nothing in
   * `scriptMacros.ts` reads these -- they are here rather than on the companion's
   * own observation because every other drone role already lives on this type
   * and splitting one role out would mean two places to look.
   *
   * ⚠ THE SERVER WILL NOT REPAIR AN OUT-OF-CORP FLEET-MATE. `isFriendlyRepairTarget`
   * tests character, owner, corporation and alliance, never fleet membership, so
   * an engage aimed at a fleet-mate outside the corp is accepted and does
   * nothing. Anything reading these must not promise otherwise.
   */
  readonly logisticDroneBayItemIDs?: readonly number[] | null;
  readonly logisticDroneIDs?: readonly number[] | null;
  /** Bay stacks whose type or group could not be read this tick — in no role. */
  readonly unclassifiedDroneBayItemIDs?: readonly number[] | null;
  /**
   * The game's own GROUP NAME per ship type on this grid, for the combat blocks'
   * target priority (see nav/targetPriority.ts) — the same resolve-then-judge
   * pass the drone roles above make, over hostiles and other players instead of
   * drones. Keyed by typeID, because a group belongs to a type and not to a
   * hull sitting in space.
   *
   * A type missing from the map, or carrying null, is one whose group has not
   * resolved: it is ranked with "everything else" rather than guessed into a
   * class, and it is never dropped from the fight. Absent entirely (the whole
   * field) means no read was made this tick, which is the same thing — the
   * shipped ladder simply lands on nearest-first, exactly as before.
   */
  readonly targetGroupNames?: Readonly<Record<number, string | null>> | null;
  /**
   * The ship this pilot's FLEET has called as its primary (the BFF's shared
   * squad board, src/squadBoard.js) — read only for a block set to follow one.
   *
   * null covers every way there is nothing to follow: nobody has called, the
   * call went stale, this character's fleet is unknown, or the read failed. All
   * four mean the same thing to a block — pick for yourself — so none of them
   * is an error and none of them stops a bot.
   */
  readonly squadPrimaryTargetID?: number | null;
  /** Fitted mining-module ids, refreshed when the active hull or fit changes. */
  readonly miningModuleIDs?: readonly number[];
  /** Fitted salvager ids, refreshed when the active hull or fit changes. */
  readonly salvageModuleIDs?: readonly number[];
  /** Fitted repairers by layer, refreshed when the active hull or fit changes. */
  readonly shieldRepairerIDs?: readonly number[];
  readonly armorRepairerIDs?: readonly number[];
  readonly hullRepairerIDs?: readonly number[];
  /** Fitted REMOTE repairers, refreshed when the active hull or fit changes. */
  readonly remoteShieldRepairerIDs?: readonly number[];
  readonly remoteArmorRepairerIDs?: readonly number[];
  readonly remoteHullRepairerIDs?: readonly number[];
  /** Fitted REMOTE CAPACITOR TRANSMITTERS (SDE group 67) — the cap-chain block. */
  readonly remoteCapModuleIDs?: readonly number[];
  /** Whether the character is in a fleet — read for the fleet-management blocks. true/false/null=unreadable. */
  readonly inFleet?: boolean | null;
  /**
   * The fleet-finder listing as this session may see it - one row per advert,
   * trimmed to the three fields a block can act on. `null` means the listing was
   * unreadable; `[]` means it was read and NOBODY is advertising, which is a real
   * answer the join-by-name block is allowed to act on (it finishes).
   *
   * ⚠ The server filters this listing per session (`isAdvertOpenToSession`), so a
   * fleet missing from it is one this pilot could not have joined anyway.
   */
  readonly fleetAds?: readonly FleetAdRow[] | null;
  /** What the last apply this run answered, or null if none has been made. */
  readonly fleetApplication?: FleetApplication | null;
  /**
   * Character IDs from a fresh, authoritative bound-fleet roster. `null` means
   * the roster was unavailable; `[]` means the service authoritatively says the
   * pilot is fleetless. Remote assistance must never infer membership from the
   * presence of another player ship on grid.
   */
  readonly fleetMemberCharacterIDs?: readonly number[] | null;
  /**
   * Fleet target tags, itemID -> tag, from the last `OnFleetStateChange`. Read
   * straight off the store, never a fresh call — so unlike the gated fleet
   * reads above this is never behind a macro gate.
   *
   * ⚠ `null` = never received or unreadable; an EMPTY MAP = received and
   * nothing is tagged. Those are different answers and both are real — the
   * decoder (`decodeFleetStateChangeNotification`) is careful about this and
   * an observation that collapsed them would undo that care. Moved up from
   * `FleetCompanionObservation`, which declared this field first; kept here
   * because any script (not only the fleet companion) may want to read it.
   */
  readonly fleetTargetTags?: ReadonlyMap<number, string> | null;
  /**
   * Whether THIS character may set a fleet target tag right now — three states,
   * not two (see `bridge/fleetCommand.ts`'s header, which this mirrors exactly).
   * `null` = the roster could not be read (or this character's own row was not
   * in it) — WAIT, never guess "no". `false` = read cleanly, and this pilot is
   * not the fleet boss or a wing/squad commander — a settled, safe-to-remember
   * "no". `true` = go ahead. Populated from the SAME bound-fleet read that fills
   * `fleetMemberCharacterIDs` (gated the same way, behind the tagging block
   * being the active step) — not a second roster call.
   */
  readonly canTag?: boolean | null;
  /**
   * The most recent `OnFleetBroadcast` call ("shoot that"), read off the
   * store and ALREADY freshness-filtered against `FLEET_BROADCAST_TTL_MS` at
   * observation build time — never here, and never in the store's reducer.
   * `null` covers both "never received" and "received, but the call has gone
   * stale"; a follower whose call has lapsed falls back to its own ladder,
   * which is a working bot, not a stopped one.
   */
  readonly fleetBroadcast?: FleetBroadcast | null;
  /** Fitted hardeners + damage controls, refreshed when the active hull or fit changes. */
  readonly hardenerModuleIDs?: readonly number[];
  /** Fitted WEAPONS (turrets/launchers), resolved once at start (the fight block runs these). */
  readonly weaponModuleIDs?: readonly number[];
  /**
   * How far this hull can LOCK, in metres — the ship's own `maxTargetRange`
   * after the server's dogma pass. The combat ladder engages nothing beyond it.
   *
   * ⚠ NULL IS "DO NOT GATE", NOT "NOTHING IS IN RANGE". It rides the fitting
   * read, which a bot run does not force, so it is frequently unreadable — and
   * the null rule everywhere else in this file (unreadable never decides) has to
   * hold here too: a bot whose fit was never opened must still be able to shoot
   * back. With it null the ladder falls back to its bounded lock, which gives up
   * on an unlockable target after `MAX_LOCK_WAIT_TICKS` and moves on.
   */
  readonly maxTargetRangeM?: number | null;
  /** Who "you" are — the loot block only ever touches YOUR wrecks (no can flipping). */
  readonly myCharacterID?: number | null;
  readonly myCorporationID?: number | null;
  /** The station the bot started docked at — resolves a "starting station" ref at run time. */
  readonly startingStationID?: number | null;
  /** The bot document's emergency home, resolved for THIS tick (fixed/start/board slot). */
  readonly homeStationID?: number | null;
  readonly homeDockableKind?: "station" | "structure";
  // ── Mission reads (the distribution blocks). Read ONLY when the active step is
  //    a mission block (the runner passes an observe hint), so a mining bot never
  //    pays for an agent-conversation read. Same null rule: null = unreadable.
  /** A freshly opened conversation with the run's agent, read THIS tick. */
  readonly conversation?: AgentConversation | null;
  /** The offered/accepted mission's courier briefing. */
  readonly briefing?: CourierBriefing | null;
  /** THE authority on whether a mission is accepted. */
  readonly journal?: JournalState | null;
  /** The active ship's cargo rows + capacity. */
  readonly cargo?: CargoReading | null;
  /**
   * The active hull's SPECIALISED bays, contents included — what `unload-cargo`
   * needs to empty a hauler whose freight went to the ore hold rather than to
   * cargo. Read only while a block that empties the ship is active, because the
   * BFF answers it with one capacity call per candidate flag and that is far too
   * much to pay on every tick of a mining run.
   */
  readonly shipBays?: readonly ShipBay[] | null;
  /**
   * What the RUN has been refused so far, injected by the runner (the ledger is
   * its state, not a read). A decider treats this as an ordinary fact: "this can
   * has turned me down nine times across four laps" is as much a property of the
   * world as a distance is, and unlike a per-step counter it survives the lap.
   */
  readonly refusals?: readonly RefusalRecord[] | null;
  /** Other authenticated runs' active container leases; null means authority unreadable. */
  readonly claimedContainerIDs?: readonly number[] | null;
  /** Exact docked corporation division rows, keyed by the human division 1..7. */
  readonly haulDivisions?: Readonly<Record<number, readonly InventoryItemRow[] | null>> | null;
  /** The docked station's hangar rows (the mission package is picked from here). */
  readonly stationHangar?: readonly InventoryItemRow[] | null;
  /**
   * The resolved NAME of each type in the rows above and in the ship's holds,
   * for the one thing a classification cannot answer: "everything called
   * Command Center". Only read while a block that carries a name pattern is
   * active — a decider that matches on types and groups never needs it, and a
   * missing entry makes a pattern undecidable rather than false (see
   * bridge/keepAboard.ts).
   */
  readonly typeNames?: Readonly<Record<number, string | null>> | null;
  /** What the shared autopilot is doing (mission travel rides it). */
  readonly travel?: TravelReading | null;
  /**
   * The agent the finder matched for a find-distribution-agent step (the flow
   * runs the search once the step has published its criteria on the board).
   */
  readonly foundAgent?: {
    readonly agentID: number;
    readonly stationID: number;
    readonly name: string | null;
    readonly stationName: string | null;
    readonly level?: number;
  } | null;
  /** Bounded Distribution search exhausted or its authority could not be read. */
  readonly agentSearchFailure?: string | null;
  /** Jumps from HERE to the offered mission's drop-off (the accept gate). */
  readonly jumpsToDropoff?: number | null;
  /**
   * The onboard scanner's cosmic anomalies for THIS system, read only when an
   * anomaly-flying step is active. null = unreadable.
   */
  readonly anomalies?: readonly ScannedAnomaly[] | null;
  /** Held-session probe authority, read only for exploration macros. */
  readonly scannerOperations?: ScannerOperationsSnapshot | null;
  /** The character's saved-fitting library (read when a refit step is active). */
  readonly savedFittings?: readonly SavedFitting[] | null;
  /**
   * What is fitted in the active ship's slots right now (read when a refit step
   * is active), for proving a refit landed. `shipID` is the ship the read came
   * from, so a read taken across a ship swap cannot vouch for the new hull.
   * Charges are not modules and are left out. null = unreadable.
   */
  readonly activeFitting?: {
    readonly shipID: number;
    readonly modules: readonly { readonly flagID: number; readonly typeID: number }[];
  } | null;
  /** Saved bookmarks (label + id + system), read when a bookmark-flying step is active. */
  readonly bookmarks?: readonly {
    readonly bookmarkID: number;
    readonly name: string;
    readonly solarSystemID: number | null;
    /** The folder the bookmark sits in ("Agent Missions" marks mission spots). */
    readonly folderName?: string | null;
    /** True when the bookmark carries raw coordinates (a real spot in space). */
    readonly hasSpot?: boolean;
  }[] | null;
  /** The ACTIVE ship's item id (from the docked inventory read). */
  readonly activeShipID?: number | null;
  /** Item ids the repair shop quotes as DAMAGED (read when a repair step is active). */
  readonly damagedItemIDs?: readonly number[] | null;
  /**
   * The character's PI colonies, projected to what the restart block needs:
   * each colony's extractor pins with their last program + expiry. Read only
   * when a restart-extractors step is active. null = unreadable.
   */
  readonly colonies?: readonly {
    readonly planetID: number;
    readonly planetName: string | null;
    readonly extractors: readonly {
      readonly pinID: number;
      readonly resourceTypeID: number | null;
      readonly expiresAtMs: number | null;
      /** The drill area to reinstall with (it sets the run length); null = unknown. */
      readonly headRadius?: number | null;
    }[];
    /**
     * Extractors whose storage routes reserve less than the installed
     * program's maximum cycle, each with the retail re-size that settles it
     * (bridge/colonyRoutes.ts). Absent = nobody looked.
     */
    readonly reroutes?: readonly ExtractorReroute[];
    /**
     * The types a route on this colony delivers into a factory
     * (bridge/colonyRoutes.ts factoryInputTypeIDs). A launchpad's stock of one
     * of these is a factory's input, and collect-customs leaves it on the
     * planet. Absent = nobody looked, and then nothing is held back.
     */
    readonly factoryInputTypeIDs?: readonly number[];
    /**
     * Every structure on the planet, for the blocks that act on a hold rather
     * than on a program.
     *
     * ⚠ BOTH VOLUMES MAY BE null, AND null IS NOT 0. An extractor control unit
     * has no capacity at all, and one commodity the static table cannot weigh
     * nulls a whole pin's used volume (bridge/planets.ts). A decider that
     * divides these without checking gets NaN, which compares false against
     * every threshold and silently never fires.
     */
    readonly pins: readonly {
      readonly pinID: number;
      readonly kind: ColonyPinKind;
      readonly usedM3: number | null;
      readonly capacityM3: number | null;
      readonly contents: readonly { readonly typeID: number; readonly quantity: number }[];
      /** Epoch ms, server clock. null is EveJS's "never launched". */
      readonly lastLaunchAtMs: number | null;
    }[];
  }[] | null;
  /**
   * The pilot's planetary launches (planetMgr.GetMyLaunchesDetails), for the
   * collect-launches block. Read only while that block is active.
   * null = unreadable, never "no launches".
   *
   * `itemID` is the container in space; `x/y/z` is where the server put it,
   * well off the planet's own grid (2,500 km past the surface, never under
   * 10,000 km from the centre), which is why the block warps to the container
   * and not to the planet. `launchedAtMs` is epoch ms, null when unreadable.
   */
  /**
   * Ships parked in this station hangar (the active one included) that have a
   * planetary commodities hold, by item id. Read only while
   * board-planetary-hauler runs: one capacity read per parked ship.
   * null = unreadable, never "none".
   */
  readonly planetaryHaulerShipIDs?: readonly number[] | null;
  /**
   * What each customs office in THIS system is holding for the pilot, for the
   * collect-customs block. Read only while that block is active: one container
   * read per office in the system.
   *
   * ⚠ null = NOBODY LOOKED, never "they are empty". An office is a structure
   * that neither announces itself as something to collect nor vanishes when
   * emptied, so this read is the only thing that can say it is done - and
   * reading "empty" out of an unread list would walk away from a full office.
   *
   * `units` is how many units of anything the office lists for this pilot; the
   * server partitions an office's storage by depositor, so nothing here is
   * somebody else's.
   */
  readonly customsOffices?: readonly {
    readonly officeID: number;
    readonly stacks: number;
    readonly units: number;
  }[] | null;
  readonly piLaunches?: readonly {
    readonly launchID: number;
    readonly solarSystemID: number;
    readonly planetID: number;
    readonly itemID: number;
    readonly launchedAtMs: number | null;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }[] | null;
  // ── The drone-boat block's reads (docs/drone-boat-block-spec.md §8). Every
  //    one of them is OPTIONAL, because this type is built in two places (the
  //    script runner's `observe` and the fleet companion's) and the pure tests
  //    construct partial observations by hand — an absent field is "nobody
  //    looked", which is the same answer as `null` to every decider and must
  //    never be read as a fact. Nothing in `scriptMacros.ts` reads these yet;
  //    the block that does arrives in a later parcel.
  /**
   * How far this ship's DRONES still answer, in metres — attribute 458, off the
   * fit's own `stats.bays.droneControlRange`. The stand-off band's drone leash
   * (nav/kiteBand.ts).
   *
   * ⚠ NULL IS THE COMMON CASE AND IT IS NOT A ZERO. Control range is
   * SKILL-derived and is not on a hull's own SDE row, so an unknown `Stat` has
   * to arrive here as `null` — a 0 would tell `kiteBand` the drones answer
   * nowhere and collapse the ceiling onto the hull. Null means "we could not
   * read your drone leash", which is exactly the case `kiteBand`'s fallback
   * path (the player's override, else a no-skills guess) exists to fly, and the
   * reason that reason has to reach the player's readout intact.
   *
   * ⚠ IT IS NOT A SUBSTITUTE FOR `maxTargetRangeM` AND `maxTargetRangeM` IS NOT
   * A SUBSTITUTE FOR IT. The two leashes are resolved separately and a `min`
   * over "whichever is readable" silently swaps one for the other — see the
   * warning at the top of nav/kiteBand.ts, which records what that cost.
   */
  readonly droneControlRangeM?: number | null;
  /**
   * How many targets this hull can hold at once — dogma attribute 192, off the
   * fit's own `stats.targeting.maxLockedTargets`. The drone boat's pre-lock rung
   * fills the SPARE slots so the next primary is already locked when this one
   * dies (a Tristan holds five; the gun ladder uses one and pays a fresh lock
   * after every kill).
   *
   * ⚠ NULL IS "DO NOT PRE-LOCK", NEVER A GUESSED FIVE. A hull's lock count is a
   * real limit and the server REFUSES the lock past it — and a refusal is booked
   * in the ledger, where enough of them on one key END THE RUN. Guessing five
   * because a frigate holds five would spend that refusal every tick on every
   * destroyer nobody had measured. The rung reads unreadable as "do not", which
   * costs a few seconds a kill and nothing else.
   *
   * ⚠ AND AN UNKNOWN `Stat` ARRIVES AS `null`, NEVER AS 0 — the same discipline
   * the two range fields above keep. A zero here is the claim "this ship cannot
   * lock anything", which is a different and much worse statement than "nobody
   * looked".
   */
  readonly maxLockedTargets?: number | null;
  /**
   * What each ship TYPE on this grid does to a ship it has decided to fight,
   * from the type's own dogma (nav/ratThreat.ts). Keyed by typeID because a
   * threat belongs to a type, not to a hull sitting in space — the same shape
   * and the same reasoning as `targetGroupNames` above.
   *
   * ⚠ IT EXISTS BECAUSE NO NAME AND NO GROUP CAN SEE THE DIFFERENCE. Every NPC
   * shares a group with harmless siblings; only attribute 504 separates the rat
   * that will hold the ship on the field from the one that will not.
   *
   * A type MISSING from the map is one whose dogma has not been read: the
   * caller must treat it the way `UNKNOWN_THREAT` is meant to be treated — "the
   * dogma said nothing, ask something else" — and never as "this rat is safe".
   * `null` (or absent) for the whole field means no read was made this tick,
   * which is the same thing said about every type at once.
   */
  readonly threatByTypeID?: Readonly<Record<number, RatThreat>> | null;
  /**
   * The entity ids of everything whose hostile module cycle is landing on THIS
   * ship right now — scrams, disruptors, webs, damps, neuts, paints, tracking
   * and guidance disruptors alike, already freshness-filtered at observation
   * build time (`isJamLive`), deduplicated, and NOT narrowed to tackle.
   *
   * ⚠ GROUND TRUTH, AND IT BEATS THE DOGMA. `threatByTypeID` above is a static
   * guess about a TYPE; this is the server naming the aggressor on this ship's
   * own wire. A source id in this list is a rat that is demonstrably holding us,
   * whatever its attributes said — including a type whose dogma we read wrong.
   *
   * An ARRAY and not a Set, matching `lockedTargetIDs`: the consumer builds its
   * own Set once rather than every reader inheriting one it did not ask for.
   * `[]` is a real answer ("nothing is on us") because the jam slice is a fold
   * of pushes that always exists; absent means nobody looked.
   */
  readonly jammingSourceIDs?: readonly number[];
  /**
   * THIS ship's drones out in space, one row each — the per-drone half of
   * `lowestDroneHealth` above, which stays exactly as it is for the existing
   * watch. Both are folded from the same single walk of the snapshot, so a
   * rack can never be judged two different ways in one tick.
   *
   * ⚠ ONLY DRONES THIS SHIP CAN ORDER (`canMyShipOrderDrone === true`), never
   * merely "mine". An abandoned drone answers a recall with a 200 and does not
   * move, so counting one would make a rung wait for a recall that can never
   * land — the narrower test is the right one and it is the one the existing
   * fold uses.
   *
   * Each ratio is three-state on its own: `null` is a layer that did not read,
   * never a layer at zero. A drone whose three layers are all unreadable is
   * still listed — it is out, and it can still be recalled.
   */
  readonly myDrones?: readonly {
    readonly itemID: number;
    readonly shieldRatio: number | null;
    readonly armorRatio: number | null;
    readonly hullRatio: number | null;
  }[];
  /**
   * Fitted weapons that DEMONSTRABLY take a charge and have none loaded.
   *
   * ⚠ `takesCharge` IS THREE-STATE AND A NULL IS NOT AN UNLOADED GUN.
   * `decodeChargeFits` answers `{}` both for a module that takes no charge and
   * for a fit whose charge data never arrived, so only an explicit "this has
   * somewhere to load something" plus an empty chamber lands here. Reporting a
   * gun as unloaded when it is merely unreadable would silence a working
   * weapon — and the block skips exactly these, so a false positive is a gun
   * that never fires again for the whole run.
   *
   * The point of reporting it at all: activating an empty gun is refused, and a
   * refusal is booked in the ledger where `MAX_CONSECUTIVE_REFUSALS` on one key
   * ENDS THE RUN. A drone boat whose guns are all empty should fight with its
   * drones and say so once, not stop.
   */
  readonly unloadedWeaponIDs?: readonly number[];
  /**
   * The fitted afterburners and microwarpdrives, each carrying the `typeID` a
   * deactivate has to name and the `kind` only the SDE's own dogma effects
   * (6730/6731) can supply — the input to `decidePropulsionModule`
   * (nav/propulsion.ts), which is the fleet companion's own policy shared
   * rather than re-derived.
   *
   * `kind: null` is a third state, not a default: "the group said prop mod and
   * the effect read did not answer". The policy fails open on it and treats the
   * module as the scram-vulnerable half; see that module's header for why that
   * is the cheap direction to be wrong in. An EMPTY array is a real and common
   * answer — plenty of hulls fly without one.
   */
  readonly propulsionModules?: readonly PropulsionModule[];
  /**
   * Whether a live WARP SCRAMBLER — not a disruptor — is on this ship, from the
   * same jam fold as `jammingSourceIDs` above
   * (`scrammedByWarpScrambler`). The one jam that turns a microwarpdrive off.
   *
   * ⚠ THREE-STATE, AND ONLY AN EXPLICIT `true` STANDS A MODULE DOWN. `false` is
   * "the jam fold was read and carries no live scram"; `null` is "no jam fold
   * was read at all". `decidePropulsionModule` gates on `true` alone, so an
   * observation that could not look never takes the speed off a ship — and
   * never reads a disruptor as an MWD kill, which is the mistake
   * `tacklersHolding` would make here.
   */
  readonly scrammed?: boolean | null;
}

/**
 * The hostiles this ship can actually shoot at: nearest first, and — when the
 * hull's targeting range is readable — nothing beyond it.
 *
 * ⚠ THE GATE IS WHAT STOPS THE LADDER SPINNING. Without it, one rat parked 300 km
 * out is still "the nearest hostile", so the ladder locks it, waits out
 * `MAX_LOCK_WAIT_TICKS`, gives up, picks the same rat again, and repeats forever
 * — harmless as a block a player watched start, fatal as an always-watching
 * response, which would own the ship and starve the step under it. Out of range
 * reads as an empty grid, which the callers already know how to finish on.
 *
 * Range unreadable (the usual case — see `maxTargetRangeM`) means NO gate, and
 * the bounded lock stays the only backstop. That is a weaker guarantee, not none:
 * it gives up on each target in turn rather than never.
 *
 * It lives here, beside the observation, and not in scriptMacros.ts because TWO
 * callers must agree on it: the Fight-the-rats ladder, and the fight-back watch
 * in scriptDecide.ts that decides whether to borrow that ladder at all. One
 * definition is how the two can never drift apart.
 */
export function hostilesInReach(obs: Pick<ScriptObservation, "maxTargetRangeM">, snapshot: SpaceSnapshot, origin: SpaceVector): readonly OverviewRow[] {
  const rows = hostileRows(snapshot, origin);
  const range = obs.maxTargetRangeM ?? null;
  return range === null ? rows : rows.filter((row) => row.distance <= range);
}

// ─── Tri-state condition evaluation ──────────────────────────────────────────

export type Verdict = "met" | "not-met" | "cannot-tell";

function below(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value < threshold ? "met" : "not-met";
}

function atLeast(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value >= threshold ? "met" : "not-met";
}

function above(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value > threshold ? "met" : "not-met";
}

function fromBool(value: boolean | null): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value ? "met" : "not-met";
}

/** Evaluate one condition against one observation. Exhaustive by compiler. */
export function evaluateCondition(condition: Condition, obs: ScriptObservation): Verdict {
  switch (condition.kind) {
    case "ore-hold-at-least":
      return atLeast(obs.oreHoldFraction, condition.fraction);
    case "hold-empty":
      return fromBool(obs.holdEmpty);
    case "shield-below":
      return below(obs.shieldRatio, condition.fraction);
    case "armor-below":
      return below(obs.armorRatio, condition.fraction);
    case "hull-below":
      return below(obs.hullRatio, condition.fraction);
    case "health-below":
      return below(obs.health, condition.fraction);
    case "capacitor-below":
      return below(obs.capacitorRatio ?? null, condition.fraction);
    case "wallet-below":
      return below(obs.walletBalance ?? null, condition.isk);
    case "wallet-above":
      return above(obs.walletBalance ?? null, condition.isk);
    case "hostile-on-grid":
      return fromBool(obs.hostileOnGrid);
    case "cargo-full":
      return atLeast(obs.cargoFraction ?? null, condition.fraction);
    case "targeted-by-player":
      return fromBool(obs.targetedByPlayer ?? null);
    case "drone-health-below":
      // No drones out reads as null (nothing to judge), NOT as "healthy" — the
      // same rule as everywhere: a missing reading is never a verdict.
      return below(obs.lowestDroneHealth ?? null, condition.fraction);
    case "tackled":
      // ⚠ IT READS `scrammed`, NOT `jammingSourceIDs`, AND THE CHOICE IS THE
      // WHOLE CONDITION. Both halves are on the observation and they answer two
      // different questions:
      //
      //   • `jammingSourceIDs` is EVERY hostile cycle landing on this ship —
      //     scrams, disruptors, webs, damps, neuts, paints, tracking and
      //     guidance disruptors alike (its own header says so). A watch named
      //     "cannot leave" wired to that list fires on a webbing frigate, which
      //     slows a ship and does not stop it warping off. That is a watch that
      //     cries wolf, and a player who has been woken by one twice deletes it
      //     — taking the one row that would have saved the ship with it.
      //   • `scrammed` is the fold of the server's own `OnJamStart` pushes
      //     narrowed to a live WARP SCRAMBLER (`scrammedByWarpScrambler`). It is
      //     the jam that actually pins a ship to the grid, which is the fact the
      //     2026-09-14 loss turned on.
      //
      // ⚠ SO THIS ERRS SILENT, NEVER LOUD, AND THAT IS DELIBERATE. A pure warp
      // DISRUPTOR (a "point") also stops a warp, and it is NOT in `scrammed` —
      // the server's two names are the wrong way round and only
      // `warpScramblerMWD` is the scram (see bridge/jamNotifications.ts). So a
      // ship held by a disruptor alone reads not-met here: a MISS, not a false
      // alarm. That is the cheap direction to be wrong in for a watch a player
      // has to trust, and the fix when it is wanted is to widen the OBSERVATION
      // with a disruptor-or-scram read — never to widen this to every jam.
      //
      // ⚠ AND AGAINST RATS THAT MISS CANNOT HAPPEN, which is checked rather than
      // hoped: the server maps an NPC's `entityWarpScrambleChance` (504) to its
      // "scram" family, and that family is the one that sends `warpScramblerMWD`
      // (space/npc/npcEntityEwarCatalog.js -> `warpscrambleforentity`, and the
      // `scram` definition in space/modules/hostileModuleRuntime.js). Every rat
      // that can pin a ship therefore trips this watch. The gap above is a PvP
      // one — only another player can hold you with a disruptor — so a ratting
      // bot gets the honest answer and a PvP bot gets a watch that is quiet
      // about half of what could be holding it. Worth knowing before this is
      // leaned on for the second thing.
      //
      // Three-state like every other read here: `null`/absent is "no jam fold
      // was read at all", which never fires the watch.
      return fromBool(obs.scrammed ?? null);
  }
}

// ─── Interrupt resolution ────────────────────────────────────────────────────

/** How long a load-bearing read may stay unreadable before the runner pauses. */
export const MAX_CANNOT_TELL_STREAK = 15; // ~30s at the 2s tick cadence

/** Player-facing pause reasons owned here (R9a). */
export const SENTENCE = {
  safetyBlind:
    "A pirate is here and I could not read the ship's condition, so I stopped rather than guess.",
  cannotTellStreak:
    "I could not read what I needed for about half a minute, so I stopped rather than guess.",
} as const;

/**
 * What the interrupt scan decided this tick.
 *
 *   • "fire"            — this row's condition is met; the runner runs its response.
 *   • "safety-override" — the acute rule: a pirate is here and health is
 *                         unreadable, and nothing else handled it → pause now.
 *   • "none"            — nothing fired.
 */
export type InterruptResolution =
  | { readonly kind: "fire"; readonly row: InterruptRow }
  | { readonly kind: "safety-override"; readonly reason: string }
  | { readonly kind: "none" };

/**
 * The first row at or below `fromIndex` whose condition is MET and which is not
 * a spent alert, or null when there is none.
 *
 * ⚠ A SPENT ALERT ROW IS TRANSPARENT. It has already said its piece for this
 * episode, and first-match-wins would otherwise park on it forever — so an
 * "alert me" row above a dock-and-pause row would silence the dock. Skipping it
 * lets the rest of the ladder work, which is what makes "tell me AND dock" two
 * rows that both fire.
 *
 * `fromIndex` is the OTHER half of that same transparency, and it is the
 * runner's to use: a row whose response turns out to do nothing this tick (a
 * repair watch with no repairer for its layer, a launch-drones watch whose
 * drones are already out) is just as silencing as a spent alert, and it cannot
 * be recognised here because whether a response has work is a question about
 * modules and drones, not about conditions. So the runner fires a row, finds it
 * did nothing, and asks again from the row BELOW it (nav/scriptDecide
 * `fallThrough`). Scanning from an index rather than re-scanning from the top is
 * what keeps that from re-firing the same inert row for ever.
 */
export function firstArmedInterrupt(
  interrupts: readonly InterruptRow[],
  obs: ScriptObservation,
  spentAlerts: readonly string[] = [],
  fromIndex = 0,
): InterruptRow | null {
  for (let index = Math.max(fromIndex, 0); index < interrupts.length; index += 1) {
    const row = interrupts[index]!;
    if (evaluateCondition(row.when, obs) !== "met") {
      continue;
    }
    if (row.respond === "alert" && spentAlerts.includes(row.id)) {
      continue;
    }
    return row;
  }
  return null;
}

/**
 * Decide which interrupt (if any) fires this tick.
 *
 * Order matters and is the behaviour: the FIRST row whose condition is met wins,
 * so a player's hostile response (launch drones / run) that sits above — or is —
 * the thing watching the pirate fires before the acute pause can. Only when
 * nothing fired and a pirate is present with unreadable health does the sealed
 * pause take over. A cannot-tell never fires a row.
 *
 * ⚠ A ROW THAT FIRES BUT DOES NOTHING STILL COUNTS AS FIRED HERE, so the sealed
 * pause stays exactly as narrow as it was: it is for a ladder that said nothing
 * at all about a pirate, not for one whose answer happened to be a no-op this
 * tick. The runner handles that case by carrying the scan on below the row
 * (`firstArmedInterrupt`'s `fromIndex`), which reaches every row the player
 * wrote without widening the one rule they did not write.
 */
export function resolveInterrupt(
  interrupts: readonly InterruptRow[],
  obs: ScriptObservation,
  spentAlerts: readonly string[] = [],
): InterruptResolution {
  const row = firstArmedInterrupt(interrupts, obs, spentAlerts);
  if (row !== null) {
    return { kind: "fire", row };
  }
  if (obs.hostileOnGrid === true && obs.health === null) {
    return { kind: "safety-override", reason: SENTENCE.safetyBlind };
  }
  return { kind: "none" };
}

// ─── The cannot-tell streak ──────────────────────────────────────────────────

/**
 * Which alert rows are still spent, given what the world reads THIS tick: a row
 * whose condition has gone not-met is released (its episode is over, so the next
 * time it holds it alerts again). A cannot-tell keeps a row spent — an unreadable
 * check is not evidence the trouble passed, and re-alerting on a blind read is
 * exactly the crying-wolf behaviour the once-per-episode rule exists to stop.
 */
export function releaseSpentAlerts(
  interrupts: readonly InterruptRow[],
  obs: ScriptObservation,
  spentAlerts: readonly string[],
): readonly string[] {
  if (spentAlerts.length === 0) {
    return spentAlerts;
  }
  const kept = spentAlerts.filter((id) => {
    const row = interrupts.find((r) => r.id === id);
    if (row === undefined) {
      return false; // the row was edited away — forget it
    }
    return evaluateCondition(row.when, obs) !== "not-met";
  });
  return kept.length === spentAlerts.length ? spentAlerts : kept;
}

/** Advance a streak: one longer when blind this tick, back to zero otherwise. */
export function bumpCannotTellStreak(streak: number, blindThisTick: boolean): number {
  return blindThisTick ? streak + 1 : 0;
}

/** True when the streak has run long enough that the runner should pause. */
export function cannotTellStreakExhausted(streak: number): boolean {
  return streak >= MAX_CANNOT_TELL_STREAK;
}
