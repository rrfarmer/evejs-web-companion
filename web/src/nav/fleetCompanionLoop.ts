// The fleet companion (fleet-companion phase 0) — a pilot that flies beside you
// in your own fleet and obeys the fleet, not a script.
//
// THIS IS THE FOURTH INSTANCE OF ONE PATTERN, not a new one. `autopilotLoop.ts`,
// `miningBotLoop.ts` and `missionBotLoop.ts` are the other three, and the
// discipline is inherited wholesale: read AUTHORITATIVE state each tick, issue
// AT MOST ONE atomic call, never simulate or predict, bound every branch, and
// PAUSE WITH A REASON rather than guessing. Read `miningBotLoop.ts`'s header
// before changing anything here; the rules it states apply to this file too.
//
// ─── WHY THIS IS NOT A BOT SCRIPT ────────────────────────────────────────────
//
// The block DSL (`web/src/bots/`) exists so a player can compose behaviour as
// text. A fleet companion is bigger than that and worse suited to it: fifteen
// broadcast names, target tags, jam events, chat commands and a flee policy do
// not read as a step list, and exposing them as one asks the player to
// hand-assemble something that should simply have settings. So the companion
// takes a TYPED REQUEST — the shape `MiningBotRequest` already has — and nothing
// here touches `MacroID`, `Condition`, `InterruptResponse` or the editor.
//
// See docs/fleet-companion-plan.md, "The shape of the thing — DECIDED".
//
// ─── WHAT PHASE 0 IS ─────────────────────────────────────────────────────────
//
// The skeleton only. The ladder decides `wait` and nothing else: no broadcasts
// are read, no modules are cycled, no target is tagged. That is deliberate — it
// makes the lifecycle (start / pause / resume / stop / claim / headless resume)
// reviewable on its own, before any behaviour can obscure it. Each later phase
// adds rungs to `decideCompanionAction` without touching the plumbing below.

import type { ScriptObservation } from "./scriptConditions.ts";
import { REPAIR_CAP_FLOOR } from "./scriptDecide.ts";
// The get-safe ladder is the autopilot's, imported rather than re-derived —
// the same reuse `miningBotLoop.ts` makes of the same two functions. Note what
// is NOT imported: `scriptMacros.ts`'s `dockAtNearest` is the same shape, but
// it is a `MacroDecider` over the DSL's own step/memory types, and reaching for
// it would couple this file to the editor it exists not to be part of. These
// three names live in `autopilotLoop.ts`, which the DSL does not own.
import {
  APPROACH_SETTLE_MS,
  AUTOPILOT_WARP_STOPS_SHORT_M,
  decideCloseIn,
  measureSpace,
  MAX_STARGATE_JUMPING_DISTANCE_M,
  STATION_DOCKING_RADIUS_M,
  WARP_EXIT_VARIANCE_M,
  type SpaceMeasurement,
} from "./autopilotLoop.ts";
// The kill-order authority (rung 7, "obeying the fleet"). Imported rather than
// re-derived for the same reason the get-safe helpers above are: one answer to
// "where does this tag rank", shared with the combat priority list.
import { fleetTagRank, pickPrimary } from "./targetPriority.ts";
import { isTransitionTimeout, isTransportTransient, panelErrorWords } from "../bridge/refusals.ts";
import { isNotActivatableRefusal } from "./moduleActivation.ts";
import { FLEET_BROADCAST_TTL_MS } from "../bridge/fleetBroadcasts.ts";
// Rung 6's hurt-drone rotation: the drone-boat block's own machine, one drone at
// a time on its own shield, so the companion and the block judge a hurt drone the
// same way.
import {
  decideDroneRotation,
  emptyDroneRotationMemory,
  type DroneRotationMemory,
} from "./droneRotation.ts";
// The prop-mod policy (rung 3b), imported for the third time the same reason
// holds: the drone-boat block wants the identical answer to "light it, stop it,
// or leave the rack alone", and a scram rule that lived in two files would be
// fixed in one of them. What stays HERE is the question this loop answers for
// itself -- "am I travelling, or did a commander type `props on`?" -- and the
// words it says about the answer.
import {
  decidePropulsionModule,
  type PropulsionInputs,
  type PropulsionModule,
} from "./propulsion.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type { ChatMessage } from "../store/types.ts";
import type { BotLogSink } from "./botLog.ts";
import { createCompanionRecorder } from "./companionLog.ts";
import { isHostile } from "../space/overview.ts";
import {
  sizedLaunch,
  sizeSwitchVerdict,
  type BayStack,
  type DroneFacts,
  type ShipLimits,
  type TargetFacts,
} from "./droneSizing.ts";

/** A hostile type's full layers, for pricing what is left of a target. */
export interface CompanionHitPoints {
  readonly shield: number | null;
  readonly armor: number | null;
  readonly hull: number | null;
}
// `flight auto` (rung 8) and the range gate in rung 7 live in their own file;
// this ladder keeps only the call sites, the memory and the wrapper.
import type { RatCombatFacts } from "./combatPosition.ts";
import {
  MWD_STAYS_OFF_WHY,
  orbitingAgainstMissiles,
  propsBecause,
  propsLightWhy,
  propsOnThisGrid,
  propsStopWhy,
  propsWanted,
} from "./companionPropulsion.ts";
import type { CompanionTrace, HealthCode, HealthTrace, PropsTrace, PropsWithheld } from "./companionTrace.ts";
import {
  closingOnTheHold,
  decideCombatPosition,
  FRESH_COMBAT_POSITION,
  gunsInReach,
  gunsInReachWords,
  isCombatHoldOrder,
  MAX_COMPANION_POSITION_REFUSALS,
  settleCombatHold,
  withoutCombatHold,
  type CombatPositionLadder,
  type CombatPositionMemory,
  type WeaponReachState,
} from "./companionCombatPosition.ts";
// Rung 8a, the combat utility modules: the rule and its memory live in their own
// file; this ladder keeps the call site.
import {
  decideUtilityRung,
  FRESH_COMPANION_UTILITIES,
  utilitiesAfterWarp,
  type CompanionUtilityMemory,
} from "./companionUtilities.ts";
// Ammo by target (plan §5.2): the reload rung's ranking and the swap step live
// in their own file; this ladder keeps the two call sites and the memory.
import {
  ammoSkipTrace,
  clearGridEmptyGunPick,
  clearGridEmptyGunWords,
  clearGridRearmed,
  decideAmmoSwap,
  decideClearGridTopUp,
  emptyGunAmmo,
  reloadingGuns,
  RELOAD_STALE_READ_MS,
  withClearGridToppedUp,
  FRESH_COMPANION_AMMO,
  type AmmoLadder,
  type ClearGridRule,
  type CompanionAmmoMemory,
  type RatResonances,
  type WeaponCycleFacts,
} from "./companionAmmo.ts";
import {
  type CompanionSupplyMemory,
  FRESH_COMPANION_SUPPLY,
  superviseSupply,
} from "./companionSupply.ts";
import type { ChargeFacts } from "./ammoReach.ts";
import {
  COMPANION_FOLLOW_RANGE_M,
  isChatCommandSenderAllowed,
  parseChatCommand,
  selectsPilot,
  type ChatCommand,
} from "./chatCommands.ts";

/** The run states, mirroring the other loops exactly (`MiningBotRunState`). */
export type FleetCompanionRunState = "idle" | "running" | "paused" | "stopped" | "error";

/**
 * Which authority a decision actually came from, for the readout.
 *
 * ⚠ THIS IS AN OBSERVATION, NOT A SETTING, AND IT NEVER WAS ONE AGAIN.
 * It used to be defined as `FleetCompanionOrderSource | "own-ladder"`, where
 * that first half was the set of channels an operator could switch on and off.
 * There are no such switches any more (docs/fleet-companion-simplification.md,
 * "What it listens to"): a companion listens to every channel there is and acts
 * on whatever it can. So the union is written out here in full, and the only
 * question it answers is the one it always really answered -- who did this
 * pilot just obey.
 *
 * `own-ladder` is the member that proves it was never a settings type: "nobody
 * told it, it decided for itself" is a real answer to that question and is not
 * a channel anybody could have ticked.
 *
 * ⚠ `squad-board` IS GONE, AND IT WAS NEVER REAL. It sat in this union and in
 * the settings screen, and nothing in this file ever produced it -- the BFF's
 * squad board (`src/squadBoard.js`) is read by the SCRIPTED bots and has never
 * been read by the companion. A readout member no decision can emit is a
 * promise the readout cannot keep. The board itself is untouched.
 *
 * Named here because it had been written out inline in four places -- this
 * file, the store's types, the store's feed, and the readout words -- and phase
 * 9's wire shape would have been a fifth. Four copies of a union with nothing
 * to fail if one drifted is the same shape of bug as two copies of a bare 1;
 * see COMPANION_GRANT_SCRIPT_REV.
 */
export type CompanionOrderAuthority = "broadcast" | "tag" | "chat" | "own-ladder";

/**
 * One fitted afterburner or microwarpdrive: what to cycle, what to name when
 * stopping it, and which of the two it is.
 *
 * `kind` is `null` when the SDE effect read did not arrive. That is a third
 * state and not a default — "the group said propulsion module and the effect
 * did not answer" — and the rung that reads it fails OPEN, running the module
 * and assuming the scram-vulnerable half. See `propulsionModules` on the
 * request.
 *
 * ⚠ THIS IS AN ALIAS AND NOT A SECOND SHAPE. The prop-mod policy is shared with
 * the drone-boat block (`nav/propulsion.ts`), and a module that had to be
 * re-packed on the way into it would be a copy with nothing to fail if one side
 * grew a field. The name stays because four other files import it.
 */
export type CompanionPropulsionModule = PropulsionModule;

/**
 * What one companion run actually FLIES WITH: the operator's few settings, plus
 * the eight module lists read off the hull it is sitting in.
 *
 * ⚠ THE EIGHT LISTS ARE DERIVED, NEVER CONFIGURED, AND THAT IS THE WHOLE OF THE
 * 2026-09-11 SIMPLIFICATION. They used to be eight checkbox columns in the
 * settings panel, each one defended by a comment saying the player must pick
 * because "a wrong guess cycles the wrong module". There was never a guess to
 * make. What a module is FOR comes from the game's own SDE group name, which is
 * the only thing `resolveDefenseModuleIDs` has ever looked at; whether it can be
 * CYCLED comes from dogma attribute 73, the duration the server sends per fitted
 * module (`itemHasActivationCycle`). Group plus duration answers both questions
 * exactly, so the player was being asked to disambiguate something that was
 * never ambiguous. See docs/fleet-companion-simplification.md.
 *
 * ⚠ THEY SURVIVE AS HANDLES, WHICH IS WHY THEY ARE STILL ITEM IDS. You activate
 * one particular fitted module, not a group, so the ladder still needs the id of
 * the thing to cycle. That is all these are now: the answer to "which item", not
 * the answer to "which of these did you want".
 *
 * ⚠ FLATNESS IS LOAD-BEARING. `CompanionSetup` below -- the stored half of this
 * -- is kept as the VALUE against a pilot in a Pilot Hangar squad, and squads
 * routinely span accounts. A setup that were a REFERENCE into an account-scoped
 * library could not be shared by a mixed squad; a value can.
 */
/**
 * Which of a hull's two real tank layers it is built around.
 *
 * "hull" is deliberately not one of them: nothing is tanked in its hull, and a
 * layer nothing is built around has no vote to cast. The hull layer is still
 * COUNTED by `tankHealth` — it is beneath both of these, so it is in every
 * slice — it just never names the tank.
 */
export type CompanionTankLayer = "shield" | "armor";

export interface FleetCompanionRequest {
  /**
   * Fitted modules that DEFEND this ship -- hardeners and the like -- by item
   * id, classified off the hull's own group names at start.
   *
   * ⚠ ONLY THE ONES THAT ACTUALLY CYCLE. A passive module in a defensive group
   * is filtered out by the duration check, because activating it means nothing
   * and the call would be wasted every tick. Group 60 "Damage Control" is the
   * case that proves the rule: it holds both the passive Damage Control II and
   * the cycling Assault Damage Control II, so no test on the group NAME could
   * ever have separated them.
   */
  readonly defenseModuleIDs: readonly number[];
  /**
   * Fitted SELF-repair modules by item id, one list per tank layer. Shield
   * boosters here, armour repairers below, hull repairers under that.
   *
   * ⚠ ONE LIST PER LAYER BECAUSE A SHIELD BOOSTER CANNOT REPAIR ARMOUR. The
   * hurt layer chooses the list, exactly as the DSL's `repairersFor` chooses
   * between `shieldRepairerIDs` / `armorRepairerIDs` / `hullRepairerIDs`, and
   * reaching across families would cycle a module that does nothing for the
   * layer actually taking damage.
   *
   * ⚠ THE TWO CLASSIFIER BUGS THIS COMMENT USED TO CITE ARE BOTH FIXED, which
   * is what made deriving these safe. It argued for asking the operator because
   * the classifier "cannot tell a free Damage Control from a cap-hungry active
   * hardener" and, until 2026-09-11, "read every REMOTE repairer as a self
   * repairer". The second was fixed by excluding `/remote/i` ahead of the self
   * tests; the first by the dogma duration check, which answers the question the
   * group name genuinely could not. Neither is an argument for a checkbox any
   * more.
   *
   * Empty is a real answer: this pilot has nothing fitted for that layer, and a
   * hurt reading there simply falls through.
   */
  readonly shieldBoosterModuleIDs: readonly number[];
  /** As `shieldBoosterModuleIDs`, for armour. */
  readonly armorRepairerModuleIDs: readonly number[];
  /** As `shieldBoosterModuleIDs`, for hull. */
  readonly hullRepairerModuleIDs: readonly number[];
  /**
   * The ANCILLARY ones among the three lists above, by the game's own group
   * name ("Ancillary Shield Booster", "Ancillary Armor Repairer"): the
   * repairers that eat a charge every cycle when one is loaded.
   *
   * ⚠ ONLY THE CLEAR-GRID REPAIR READS IT (`clearGridStartable`). In a fight
   * every repairer is fair game; after one, an ancillary shield booster would
   * burn cap booster charges on a shield that comes back by itself, and the
   * operator said the rep-up is done "without caps" (2026-10-14). Absent is the
   * same as empty: nothing on this fit is ancillary.
   */
  readonly ancillaryRepairerModuleIDs?: readonly number[];
  /**
   * Fitted REMOTE shield-repair modules by item id — the ones that repair
   * SOMEBODY ELSE. Answers a `HealShield` broadcast (and, alongside the other
   * two lists below, a `HealTarget` one — see `healModuleCandidates`'s own
   * comment for why that call draws on all three). Empty means this pilot has
   * no shield remote-rep fitted, and a `HealShield` call simply falls through
   * unanswered.
   *
   * ⚠ THE `/remote/i` TEST RUNS BEFORE THE SELF TESTS, and that ordering is what
   * keeps these three lists and the three above apart. Every remote-rep group
   * name also contains "shield booster" / "armor repair" / "hull repair", so an
   * unordered classifier files a Remote Shield Booster as a SELF repairer -- and
   * the repair rung then activates it self-targeted, which repairs nothing and
   * burns capacitor on the one hull whose job is repairing someone else.
   */
  readonly remoteShieldModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for armour — a shield booster cannot repair
   *  armour, so `HealArmor` draws on this list and never the shield one. */
  readonly remoteArmorModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for capacitor transfers — `HealCapacitor`
   *  draws on this list alone, for the same reason. */
  readonly remoteCapacitorModuleIDs: readonly number[];
  /**
   * Fitted WEAPONS (turrets, launchers) by item id, high slots only.
   *
   * ⚠ A COMPANION IS NOW ARMED BY DEFAULT, AND THAT IS A DELIBERATE LOSS OF A
   * SAFETY DEFAULT. This list used to be empty unless an operator ticked a gun,
   * and empty meant "lock whatever the fleet calls, never fire it" -- so no
   * companion could shoot without somebody explicitly arming it. Deriving the
   * list from the hull ends that: a pilot with guns fitted will fire them at
   * what it is told to fire at. The operator was told this consequence and chose
   * it (docs/fleet-companion-simplification.md, "The request, after").
   *
   * ⚠ IT IS ALSO WHY `combat` IS NOW AN UNCONDITIONAL RISK CLASS. A grant is
   * built before the fit has been read, and a hull nobody has looked at may hold
   * anything, so a run that claimed no combat and then bolted on whatever the
   * ship turned out to carry would be a falsehood the BFF validates as truth.
   * See `analyzeCompanionRunPolicy`.
   *
   * Empty still happens and is still a real answer -- a hull with no guns -- it
   * is simply no longer something an operator can choose.
   */
  readonly weaponModuleIDs: readonly number[];
  /**
   * Fitted SALVAGERS by item id, high slots only, classified off the game's own
   * group name ("Salvager").
   *
   * ⚠ A SALVAGE ORDER IS NOT A DRONE ORDER, AND THIS LIST IS WHY. The first cut
   * of the `salvage` chat verb acted on salvage DRONES alone, because that is
   * how the request was first phrased. It was wrong for the same reason every
   * module picker was wrong: what a pilot can do is a property of its FIT, and a
   * hull with a salvager bolted on can salvage whether or not it carries drones.
   * Found in live testing, 2026-09-11.
   *
   * ⚠ THE TWO ARE NOT EXCLUSIVE. A ship carrying both runs both on the same
   * wreck: approach -> lock, then the drones are sent at it and the salvager
   * activated on it.
   */
  readonly salvagerModuleIDs: readonly number[];
  /**
   * Fitted modules that make the DRONES better while they fight -- the game's
   * "Drone Tracking Modules" (the Omnidirectional Tracking Link) and "Drone
   * Navigation Computer" groups -- by item id, classified off the group name
   * at start like every list here.
   *
   * ⚠ THEY DO NOTHING UNLESS SWITCHED ON, AND NOTHING SWITCHED THEM ON. A
   * companion fought with its tracking link dark until 2026-10-12 (seen live:
   * the operator noticed none of them lit it). The server builds each drone's
   * tracking and speed from the controller's ACTIVE module effects
   * (`buildActiveModuleContexts`, droneDogma.js), so a dark link is a drone
   * fighting on its base numbers.
   */
  readonly droneAssistModuleIDs: readonly number[];
  /**
   * Fitted PROPULSION modules — afterburners and microwarpdrives — classified
   * off SDE group 46 "Propulsion Module".
   *
   * ⚠ THE ONLY MODULE LIST HERE THAT IS NOT A BARE LIST OF IDS, and both extra
   * fields are forced by the game rather than chosen:
   *
   *   • `typeID`, because turning one OFF needs it. Deactivate stops a prop mod
   *     only when it names the propulsion effect — the server infers the default
   *     effect on activate and NOT on deactivate — so a bare Deactivate returns
   *     success with the burner still cycling. The BFF resolves the effect name
   *     from the typeID, so the id has to travel with the module. Every other
   *     list here names modules that stop when told to.
   *
   *   • `kind`, because group 46 holds BOTH and only one of them cares about a
   *     scram. `warpScramblerMWD` (the jam that carries `blocksMicrowarpdrive`)
   *     kills a microwarpdrive and does nothing at all to an afterburner. It
   *     comes from the SDE's own dogmaEffects (6730/6731), not from the type
   *     name, and `null` means the effect read did not arrive — see
   *     `decidePropulsion` for what that costs.
   *
   * Empty is a real answer and a common one: plenty of hulls fly without one.
   */
  readonly propulsionModules: readonly CompanionPropulsionModule[];
  /**
   * Which layer this hull is BUILT to be hit in, when nothing it can cycle says
   * so — read off the fit at start, `null` when the fit could not answer.
   *
   * ⚠ IT EXISTS FOR BUFFER FITS ALONE, AND IS CONSULTED LAST. `tankHealth`
   * asks the self-repair lists first, because a module the ship can switch on
   * is the strongest possible statement about where its tank is. A brick with
   * no active repairer makes no such statement: plates and extenders are
   * PASSIVE, so they never reach any list this loop cycles, and before this
   * field such a hull fell back to the worst-layer fold — which on a plated ship
   * means fleeing over a shield that was never its tank. The operator asked for
   * exactly this split after the armour-repairer case was fixed.
   *
   * ⚠ IT IS A VOTE OVER GROUP NAMES, NOT A SINGLE MODULE'S SAY-SO, and a tie is
   * `null` rather than a guess. Plates, coatings, membranes, extenders,
   * rechargers, power relays, the hardeners of either layer AND the armour and
   * shield RIGS all vote; a Damage Control does not, because it defends all
   * three layers equally and so says nothing about which one matters. A hull
   * carrying both kinds (a shield extender in the mids and a plate in the lows
   * is a real, if unhappy, fit) says nothing either, and gets the old fold.
   *
   * ⚠ NEVER OVERRIDES A FITTED REPAIRER. A shield-boosted hull that also
   * carries an armour plate is shield-tanked: the thing it can cycle wins.
   */
  readonly tankLayer: CompanionTankLayer | null;
  // ─── From here down: the stored setup. See `COMPANION_SETUP_KEYS`. ─────────
  //
  // ⚠ THE FIELDS BELOW ARE THE ONLY ONES AN OPERATOR EVER SETS, and the only
  // ones that are persisted against a pilot in a squad. Everything above is read
  // off the hull at start. The dividing line is exactly "can this be read off
  // the ship" -- these five cannot: three of them are thresholds nobody could
  // derive, one is a budget, and one spends money.
  //
  // ⚠ `deriveModulesFromFit` USED TO LIVE HERE AND IS GONE. It was the flag that
  // said "read the lists off the hull instead of using the picked ones", because
  // the squad path had no operator to ask. There is no longer any other path: a
  // companion ALWAYS reads its own fit, so a flag selecting between two
  // mechanisms has only one mechanism left to select.

  /** Remaining fraction (0-1) of any health layer that starts a flee. */
  readonly fleeHealthFloor: number;
  /**
   * Remaining fraction (0-1) of the tank below which a run to safety stops
   * waiting for its drones and warps at once, leaving them behind.
   *
   * ⚠ THE SECOND OF TWO FLEE THRESHOLDS, CHOSEN BY THE OPERATOR 2026-10-13.
   * Below `fleeHealthFloor` the tank is breaking: the drones are called home
   * and the warp waits for them, bounded. Below this one the tank is done: the
   * ship goes now and sends no recall. Seen live 2026-10-12: a pilot crossed its
   * floor, sat 16 s "waiting for the drones to come home", and was destroyed two
   * seconds after its warp went out.
   *
   * ⚠ OPTIONAL, AND ABSENT IS HALF THE FLEE FLOOR (`abandonDronesFloor`). A
   * setup saved before this existed decodes to exactly what it did, so the
   * hash a resumed server run is checked against does not change under it.
   */
  readonly abandonDronesHealthFloor?: number;
  /**
   * Capacitor fraction below which no repairer may be STARTED, and a running
   * one is stopped even while a layer is still hurt.
   *
   * ⚠ AN EARLIER DRAFT SAID THIS "PROTECTS THE ESCAPE". IT DOES NOT, ON THIS
   * SERVER. Retail charges capacitor to warp (`warpCapacitorNeed`, dogma
   * attribute 153), so a flattened capacitor there means a ship that cannot
   * leave. eve.js does not implement that: there is no reference to capacitor
   * anywhere under `space/destiny/` — not in `warp.js`, `warpState.js`,
   * `warpContract.js`, `warpBuilders.js` or `warpCommands.js` — so a ship here
   * warps fine at zero capacitor. Checked 2026-09-10.
   *
   * The floor that DOES earn its place is the one this codebase already
   * shipped: an empty capacitor repairs nothing, so a repairer running below it
   * is burning cycles that heal nothing and cost everything. Hence the default
   * is `REPAIR_CAP_FLOOR`, not a number invented for this file.
   */
  readonly capacitorFloor: number;
  /** Bound on flee round trips before the pilot stays home. */
  readonly maxFleeAttempts: number;
  /**
   * Whether a pilot that flees hurt pays the station to fix it.
   *
   * ⚠ THIS EXISTS BECAUSE DOCKING DOES NOT REPAIR ARMOUR, which is a fact
   * about the server and not a balance choice:
   * `topOffShipShieldAndCapacitorForDockingTransition`
   * (`space/transitions.js:242`) writes `charge: 1.0` and `shieldCharge: 1.0`
   * and leaves `damage` and `armorDamage` exactly as they were. So a shield
   * flee heals itself by arriving, and an ARMOUR flee does not: without a
   * repair the recheck can never pass, and the pilot that fled would sit in
   * the station for the rest of the run.
   *
   * ⚠ AND IT SPENDS THE OPERATOR'S ISK, which is the whole reason it is a
   * setting rather than something the flee rung just does. `repairRuntime.js`
   * debits the wallet. Off by default: a pilot that stays docked is a pilot
   * that cost nothing, and an operator who wants the round trip can say so.
   * It earns `financial` and `inventory` in the risk derivation, matching
   * what the DSL's own `repair-ship` and `dock-and-repair` already claim.
   */
  readonly repairsAtStation: boolean;
}

/**
 * The stored half of a request: exactly what an operator configures, and exactly
 * what is persisted against a pilot in a Pilot Hangar squad.
 *
 * ⚠ THIS LIST IS A FENCE, NOT A CONVENIENCE, in the same sense the old
 * `COMPANION_PRESET_KEYS` was. The codec (`bots/companionRunPolicy.ts`) decodes
 * these keys and refuses anything else, so widening the stored surface means
 * widening this constant -- a deliberate act, with the whole of
 * docs/fleet-companion-simplification.md arguing against it.
 *
 * ⚠ THE TEST FOR MEMBERSHIP IS "CAN THIS BE READ OFF THE SHIP". If it can, it is
 * derived and does not belong here. Everything that survived the 2026-09-11
 * simplification failed that test: two thresholds nobody could derive, a
 * budget and one setting that spends money. A drone-health floor and a drone
 * hold-off were here too, until rung 6 stopped needing either (2026-10-12).
 * `abandonDronesHealthFloor` came later (2026-10-13) and fails it the same way.
 */
export const COMPANION_SETUP_KEYS = [
  "fleeHealthFloor",
  "abandonDronesHealthFloor",
  "capacitorFloor",
  "maxFleeAttempts",
  "repairsAtStation",
] as const;

export type CompanionSetupKey = (typeof COMPANION_SETUP_KEYS)[number];

/**
 * What an operator saves. A `FleetCompanionRequest` is this plus the eight
 * module lists, filled in from the hull at start by `requestForFit`.
 *
 * ⚠ DERIVED FROM THE FLOWN SHAPE RATHER THAN DECLARED BESIDE IT, so the two can
 * never disagree about a field's type or drift apart when one is edited.
 */
export type CompanionSetup = Pick<FleetCompanionRequest, CompanionSetupKey>;

/** Bounds. Stated together rather than scattered, so they can be read at once. */
export const MIN_FLEE_HEALTH_FLOOR = 0.05;
export const MAX_FLEE_HEALTH_FLOOR = 0.95;
/** Zero is "never leave them": the wait always runs to its bound. */
export const MIN_ABANDON_DRONES_HEALTH_FLOOR = 0;
export const MAX_ABANDON_DRONES_HEALTH_FLOOR = MAX_FLEE_HEALTH_FLOOR;
export const MIN_CAPACITOR_FLOOR = 0.05;
export const MAX_CAPACITOR_FLOOR = 0.95;
export const MIN_FLEE_ATTEMPTS = 1;
/**
 * The widest an operator may set the budget, NOT the budget itself.
 *
 * ⚠ THIS COMMENT USED TO READ "Three, matching MAX_RECOVER_TRIPS and
 * MAX_ESCAPE_ATTEMPTS", sitting above the value 10. Both halves were true of
 * different things and the pairing was not: those two constants are 3
 * (`scriptDecide.ts:744`, `scriptMacros.ts:4793`) and so is this request's
 * DEFAULT, while this is the ceiling on what the panel will accept. The
 * reasoning moved to the default, where it applies: a wide range, a sensible
 * default inside it.
 */
export const MAX_FLEE_ATTEMPTS = 10;

/**
 * The default request. Every field is a placeholder a UI overrides EXCEPT the
 * two marked unverified, which are honest guesses awaiting a live measurement
 * (docs/fleet-companion-plan.md, "Unknowns").
 */
export const DEFAULT_COMPANION_SETUP: CompanionSetup = Object.freeze({
  fleeHealthFloor: 0.3,
  // Half the flee floor, the same answer `abandonDronesFloor` gives a setup
  // that predates the field. A guess, not a measurement: the 2026-10-12 loss
  // went from its floor to destroyed in 19 s, and the hull is still whole at
  // half an armour floor, so this should leave time to align.
  abandonDronesHealthFloor: 0.15,
  // Not a guess and not a placeholder: the constant the script runner already
  // uses to switch a repairer off, with the same reasoning ("an empty capacitor
  // repairs nothing"). Reusing it means one answer to this question, not two.
  capacitorFloor: REPAIR_CAP_FLOOR,
  // Three, matching MAX_RECOVER_TRIPS and MAX_ESCAPE_ATTEMPTS, which is where
  // this number comes from rather than being picked for this file. A fourth
  // trip into the same camp is a bot commuting, not a bot recovering.
  maxFleeAttempts: 3,
  // Off: nothing this loop does spends money unless an operator asks it to.
  repairsAtStation: false,
} satisfies CompanionSetup);

/**
 * A whole request with nothing fitted — the shipped setup plus eight empty
 * lists.
 *
 * ⚠ THIS IS NOT WHAT ANY PILOT FLIES, and it is not a default an operator ever
 * sees. `startFleetCompanion` reads the hull and replaces all eight lists before
 * the first tick, so a real run's lists are whatever that ship is carrying. This
 * constant exists for two callers: tests that want a valid request to vary one
 * field of, and the fallback for a fit that could not be read at all -- where
 * eight empty lists is the honest answer, because nothing can be cycled if
 * nothing could be classified.
 */
export const DEFAULT_FLEET_COMPANION_REQUEST: FleetCompanionRequest = Object.freeze({
  ...DEFAULT_COMPANION_SETUP,
  defenseModuleIDs: Object.freeze([]),
  shieldBoosterModuleIDs: Object.freeze([]),
  armorRepairerModuleIDs: Object.freeze([]),
  hullRepairerModuleIDs: Object.freeze([]),
  remoteShieldModuleIDs: Object.freeze([]),
  remoteArmorModuleIDs: Object.freeze([]),
  remoteCapacitorModuleIDs: Object.freeze([]),
  weaponModuleIDs: Object.freeze([]),
  salvagerModuleIDs: Object.freeze([]),
  droneAssistModuleIDs: Object.freeze([]),
  propulsionModules: Object.freeze([]),
  // Nothing fitted is nothing to vote with, which is exactly what `null` says.
  tankLayer: null,
} satisfies FleetCompanionRequest);

/**
 * The request and the observation with the given modules gone from every list
 * of modules the ladder switches on: what the run knows to be passive.
 *
 * ⚠ SEEN LIVE 2026-10-14: a Drone Navigation Computer I, picked by its group
 * name, was refused "... cannot be activated." once a fight. The lists are
 * gated at start by the server's own test (nav/moduleActivation.ts), but a type
 * whose answer was not read in time still lands in one; once the server has
 * said so, the run never asks again. Taking it out of the LIST, not refusing
 * the call, is what lets the rung move on to the next module rather than
 * choose the same dead one every tick.
 */
export function withoutModules(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  passive: ReadonlySet<number>,
): { readonly request: FleetCompanionRequest; readonly obs: FleetCompanionObservation } {
  if (passive.size === 0) {
    return { request, obs };
  }
  const keep = (ids: readonly number[]): readonly number[] => ids.filter((id) => !passive.has(id));
  const utilities = obs.combatUtilities ?? null;
  return {
    request: {
      ...request,
      defenseModuleIDs: keep(request.defenseModuleIDs),
      shieldBoosterModuleIDs: keep(request.shieldBoosterModuleIDs),
      armorRepairerModuleIDs: keep(request.armorRepairerModuleIDs),
      hullRepairerModuleIDs: keep(request.hullRepairerModuleIDs),
      ...(request.ancillaryRepairerModuleIDs === undefined
        ? {}
        : { ancillaryRepairerModuleIDs: keep(request.ancillaryRepairerModuleIDs) }),
      remoteShieldModuleIDs: keep(request.remoteShieldModuleIDs),
      remoteArmorModuleIDs: keep(request.remoteArmorModuleIDs),
      remoteCapacitorModuleIDs: keep(request.remoteCapacitorModuleIDs),
      weaponModuleIDs: keep(request.weaponModuleIDs),
      salvagerModuleIDs: keep(request.salvagerModuleIDs),
      droneAssistModuleIDs: keep(request.droneAssistModuleIDs),
      propulsionModules: request.propulsionModules.filter((module) => !passive.has(module.itemID)),
    },
    obs: utilities === null ? obs
      : { ...obs, combatUtilities: { ...utilities, modules: utilities.modules.filter((module) => !passive.has(module.itemID)) } },
  };
}

/**
 * A flee in progress — rung 5's latch, null whenever the pilot is not running
 * from anything.
 *
 * ⚠ IT SATISFIES `SafetyRun` STRUCTURALLY, and that is what lets rung 5 fly
 * the very same ladder rung 2 does instead of growing a second copy of it. The
 * three flags under the divider ARE that contract — read `SafetyLeg` before
 * renaming any of them.
 *
 * ⚠ RUN-LOCAL, NOT PERSISTED, unlike `CompanionAbandonment`. That one keeps a
 * thirty-minute clock which only means something if it outlives a BFF restart.
 * This one keeps no clock anybody waits on: a companion that comes back up
 * reads its own health on the first tick and flees again within one tick if it
 * still needs to, so persisting it would buy nothing and would have to answer
 * what a half-finished flee means to a process that has forgotten where it was.
 */
export interface CompanionFlee {
  /** When the floor was breached. For the readout, and for phase 6's budget. */
  readonly triggeredAtMs: number;
  /**
   * The health reading that started it.
   *
   * Kept because the readout is the only place an operator ever sees WHY a
   * pilot left, and "it was at 12%" is the thing that happened while "below
   * 30%" is merely the setting they can already look up.
   */
  readonly triggeredAtHealth: number;
  /**
   * The system the pilot fled FROM, so a return has somewhere to go.
   *
   * ⚠ A SYSTEM, NOT A SPOT — option A, "remember the grid", chosen on
   * simplicity grounds. And the return it feeds is BLIND by construction:
   * there is no read anywhere that says whether a grid is clear. That was
   * checked rather than assumed, and it is absent from the server, from the
   * BFF and from this repo; the nearest thing, `hostileOnGrid`, counts NPCs
   * only and is scoped to the grid the ship is already on. The attempt budget
   * is the only thing that bounds a return, which is exactly why it exists.
   *
   * Null when the flight status could not say. A return this rung cannot name
   * a destination for is one it does not attempt, never one it guesses at.
   */
  readonly fromSolarSystemID: number | null;
  /**
   * How many times the repair shop has been asked on this trip.
   *
   * Bounded for the reason the DSL's own `repair-ship` block is bounded: a shop
   * that keeps answering without fixing anything is most likely a wallet that
   * cannot pay, and asking it for ever is not a plan.
   */
  readonly repairAttempts: number;
  /**
   * Whether, at the moment the floor was breached, the ARMOUR and the HULL were
   * both already clear of the return mark — so the shield was the only layer
   * that had dropped far enough to matter.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE A STATION CANNOT ANSWER `obs.health` AT ALL, and
   * that silence used to strand pilots for ever. `health` is folded from the
   * SPACE snapshot (`lowestHealth`, miningBotLoop.ts), and a docked ship has no
   * space snapshot — so every docked tick reads `null`, `wellEnoughToReturn`
   * read `null` as "not well", and no docked pilot ever undocked itself again.
   * A shield-only flee (the common one) was the worst case of all: the ship was
   * whole the moment it arrived, and it sat in the station telling its operator
   * that its armour needed paying for. Observed live, 2026-09-13, on two pilots
   * that could not be forced out — every manual undock was answered by the
   * re-dock below.
   *
   * ⚠ IT IS STAMPED AT THE TRIGGER BECAUSE THAT IS THE LAST TICK THAT CAN READ
   * IT. Once the ship is in the station the layers are unreadable, and neither
   * armour nor hull can change in there without the shop being paid — so what
   * was true on the way out is still true on arrival. `false` whenever either
   * layer could not be read, which keeps the safe direction: an unknown layer
   * sends the pilot down the quote-and-repair path rather than back into a
   * fight.
   *
   * The server fact this rests on is the one this rung is already built around:
   * `topOffShipShieldAndCapacitorForDockingTransition` (`space/transitions.js`)
   * writes `shieldCharge: 1.0` and leaves `damage` and `armorDamage` alone.
   */
  readonly onlyTheShieldWasHurt: boolean;
  /**
   * Whether this flee has already delivered the ship to safety — docked, or
   * landed at the safe spot it warped to.
   *
   * ⚠ WHAT IT GUARDS IS THE OPERATOR'S OWN UNDOCK. Without it, a parked flee
   * read `docked === false` as "still on the way out" and docked the ship
   * again, so a human pulling a pilot out of a station was overruled within two
   * seconds, for ever. See `flyTheFlee`.
   */
  readonly arrivedSafe: boolean;
  /**
   * Set when the fleet commander started this trip with `repair`, rather than
   * the ship's health starting it. An ordered trip spends no flee round trip,
   * never goes to the sun (there is nothing to repair at a safe spot), and is
   * called off by `stop` like any other order. Always comes with `repairPaid`.
   */
  readonly ordered?: true;
  /**
   * Set when the fleet commander said `repair` to this pilot: the trip that
   * started it, or a flee already under way when it was heard.
   *
   * ⚠ THE ORDER IS THE CONSENT TO PAY. `repairsAtStation` is off by default
   * because a flee spends the operator's ISK on its own say-so; a commander who
   * types `repair` has said so out loud. So the shop is paid whatever that
   * setting says, and a shop that has refused `MAX_FLEE_REPAIR_ATTEMPTS` times
   * sends the pilot back as it is rather than keeping it docked: a commander who
   * asked for a repair still wants the ship.
   */
  readonly repairPaid?: true;
  /**
   * The best tank reading seen while waiting at a safe spot, and when it was
   * last beaten. Absent until the first such tick. See `FLEE_RECOVERY_STALL_MS`:
   * a hold whose tank has not risen in that long is a hold that would never end.
   */
  readonly recoverBest?: number;
  readonly recoverBestAtMs?: number;

  // ── the `SafetyRun` contract ────────────────────────────────────────
  readonly safeSpotWarpIssued: boolean;
  readonly safeSpotWarpSeen: boolean;
  readonly safeSpotWarpAttempts: number;
  readonly safeSpotWarpWaited: number;
  readonly droneRecallWaited: number | null;
  /**
   * Ticks left before the escape warp is tried again after it was refused
   * repeatedly, or absent. See `COMPANION_ESCAPE_RETRY_BACKOFF_TICKS`.
   */
  readonly safeSpotWarpBackoff?: number;
}

/**
 * What the companion sees each tick.
 *
 * ⚠ IT EXTENDS `ScriptObservation` ON PURPOSE, and not because the companion is
 * a script. That interface is a plain data shape — it names no `Condition`, no
 * `MacroID`, no `InterruptRow` — and the pure helpers in `scriptMacros.ts` are
 * typed over it. Extending it means those helpers accept a companion
 * observation by structural subtyping, with no adapter and no cast.
 *
 * The fields below are the ones `ScriptObservation` has no reason to carry.
 * They stay EMPTY in phase 0; each is filled by the phase that needs it.
 */
export interface FleetCompanionObservation extends ScriptObservation {
  /**
   * Each hostile TYPE's signature radius in metres (dogma 552), for the free-
   * fire kill order's "up the size chain".
   *
   * ⚠ SIGNATURE, NOT A SIZE WORD IN THE GROUP NAME. Officers, haulers, rogue
   * drones and sentry guns carry no "Frigate" or "Cruiser" in their group, but
   * every type has a signature radius, and it is the number the server's own
   * turret and drone hit formula reads. A type whose read has not landed is
   * absent, which `pickPrimary` sorts after every known size.
   */
  readonly signatureByTypeID?: Readonly<Record<number, number>> | null;
  /**
   * Each hostile TYPE's full shield, armour and hull (dogma 263, 265, 9), so
   * the drone rung can price a size switch against what is left of the target:
   * a ship nearly dead is never worth recalling drones for. A null layer is one
   * the read did not give.
   */
  readonly hitPointsByTypeID?: Readonly<Record<number, CompanionHitPoints>> | null;
  /**
   * The COMBAT stacks in the bay with their types and sizes, for drone sizing.
   * `combatDroneBayItemIDs` is the same stacks as bare ids; sizing needs to
   * know what each one is and how many it holds.
   */
  readonly combatDroneStacks?: readonly BayStack[] | null;
  /** Each combat drone TYPE aboard or out, as the sizing rule reads it. */
  readonly droneFactsByTypeID?: ReadonlyMap<number, DroneFacts> | null;
  /** The hull's drone bandwidth and the pilot's active-drone cap, or null unread. */
  readonly droneLimits?: ShipLimits | null;
  /**
   * Whether THIS pilot's tag write can land, from the fleet roster's role/job.
   *
   * ⚠ THREE STATES. `null` (roster unreadable) and `false` (not a commander)
   * both forbid a write, but only `false` is settled. Never guess "no".
   */
  readonly canTag: boolean | null;
  /**
   * Whether THIS pilot may BROADCAST in its fleet — i.e. whether it is in one
   * at all. Three states on the same terms as `canTag`: `null` is an unreadable
   * roster, `false` is a read one saying this pilot is in no fleet.
   *
   * ⚠ IT IS A SEPARATE FIELD BECAUSE `canTag === false` ANSWERS TWO QUESTIONS
   * AT ONCE AND THE FALLBACK ONLY WORKS FOR ONE OF THEM. `canTagInFleet`
   * returns `false` both for "in a fleet, not a commander" (where a broadcast
   * is exactly the right substitute) and for "in no fleet" (where there is
   * nobody to broadcast to). Deriving the second from the first is impossible;
   * asking the roster the second question directly is a `.find` away.
   */
  readonly canBroadcast?: boolean | null;
  /**
   * Character IDs the fleet roster names as COMMANDERS — fleet boss, wing
   * commander, squad commander, or the fleet's creator. The chat-order rung
   * takes orders from these and from nobody else.
   *
   * ⚠ THE SAME TEST THE SERVER USES FOR TAGGING, POINTED AT A SECOND QUESTION.
   * `canTag` above is this test applied to THIS pilot's own row; this is the
   * same test applied to every row. One definition of "commander", used twice,
   * rather than a second idea of authority invented for chat.
   *
   * ⚠ NULL IS "COULD NOT READ THE ROSTER", AND IT MEANS NO CHAT ORDERS. It must
   * never collapse to "anybody", because the roster is the entire gate: a pilot
   * that cannot tell who is in charge must not act on somebody claiming to be.
   * Local chat is readable by everyone in the system, so this list is the only
   * thing standing between a companion and a stranger typing "target".
   */
  readonly fleetCommanderCharacterIDs?: readonly number[] | null;
  /**
   * Where each commander in `fleetCommanderCharacterIDs` is, as the same roster
   * read says: its solar system, and the station it is docked in (null in space).
   * Read off the rows this tick already fetched (`fleetCommanderWhereabouts`,
   * bridge/fleetCenter.ts), so it costs no call.
   *
   * ⚠ ABSENT OR NULL IS "NOT KNOWN", NEVER "NOWHERE". The rejoin warp
   * (`decideRejoinCommander`) only stands down on a POSITIVE reading -- another
   * system, or a station -- and otherwise tries the warp and lets the server's
   * answer decide, so an older BFF that sends nothing keeps a working return leg.
   */
  readonly fleetCommanderWhereabouts?: readonly CompanionMemberWhereabouts[] | null;
  /**
   * Cans and wrecks the `loot` order is finished with -- emptied, or tried
   * enough times without emptying.
   *
   * ⚠ THE LADDER CANNOT LEARN THIS FOR ITSELF. It issues one atomic call per
   * tick and never sees what came back, so "did that can actually empty?" is a
   * fact only the layer that made the call has. Without it the rung marked a can
   * done the moment it ASKED, and a can that gave up one stack of three was
   * never opened again.
   */
  readonly lootFinishedItemIDs?: readonly number[];
  /**
   * Character IDs THIS HOST is flying with a bot — companions included, and
   * this pilot itself. The supervision gate SUBTRACTS them from the fleet
   * roster; whatever is left is a human.
   *
   * `null` means the set could not be read, which leaves the gate undecidable
   * rather than failed. Rung 2 says what it does about that.
   *
   * ⚠ SUBTRACTION, NEVER A COUNT. "Is the fleet bigger than one?" passes for
   * four companions the moment their operator logs off — which is the exact
   * situation this gate exists to catch (decision 5).
   *
   * ⚠ AN HONEST LIMIT, ACCEPTED. Only the bots THIS host knows about can be
   * subtracted, so another account's companion in the same fleet reads as a
   * human. Decision 5 accepts that; the run's deadline is what bounds it.
   */
  readonly botDrivenCharacterIDs: readonly number[] | null;
  /**
   * A fleet invite waiting to be answered, if any. The abandonment protocol's
   * ONLY way back into a fleet, and rung 2 gates it on who sent it.
   */
  readonly pendingFleetInvite: CompanionFleetInvite | null;
  /**
   * Recent chat lines, for the chat-command rung. Absent or empty means no
   * chat was read this tick, which is the same answer as "nobody said
   * anything" and is what a pilot that does not obey chat always sees.
   *
   * ⚠ ALREADY FRESHNESS-FILTERED BY THE BUILDER, exactly as `fleetBroadcast`
   * is, and against the same window. The loop deliberately carries no clock for
   * this: a stale order has to lapse so the pilot falls back to its own ladder,
   * and having ONE staleness policy for both sources is what stops "the fleet
   * called it" and "somebody typed it" ageing at different rates.
   *
   * ⚠ RAW LINES, NOT PARSED COMMANDS, AND THAT IS THE SECURITY BOUNDARY. The
   * sender allowlist lives on the REQUEST, which the builder does not hold, so
   * the gate has to run here where the request is. Handing this rung
   * pre-approved commands would move the decision about WHO MAY ORDER THIS SHIP
   * out of the layer that knows the operator's answer.
   */
  readonly chatMessages?: readonly ChatMessage[];
  /**
   * The entity ids currently TACKLING this ship — scrambled or disrupted, so
   * this ship cannot warp out. Deduplicated, and ranked no further: which one
   * to letter first is the rung's own decision.
   *
   * Absent or empty means nothing is holding this pilot, which is what a pilot
   * with no jam pushes on its wire always sees, and what a host that has not
   * wired this read up sees too.
   *
   * ⚠ ALREADY NARROWED AND ALREADY FRESHNESS-FILTERED BY THE BUILDER, the same
   * way `fleetBroadcast` and `chatMessages` are. The store keeps every jam type
   * the wire carried — webs, paints, damps, neuts — and keeps them until an
   * `OnJamEnd` arrives; deciding which of them are TACKLE and which are still
   * believed happens once, where the clock is, so the whole tick reasons off
   * one answer.
   *
   * ⚠ AN EMPTY LIST IS NOT PROOF THIS SHIP IS FREE. It is the fold of pushes
   * that were received; a dropped SSE frame reads as "nothing is holding us".
   * Nothing downstream may invert this into a positive claim — it gates a tag
   * write and nothing else, so the failure is a tag not written, never a ship
   * that wrongly believes it can warp.
   */
  readonly tackledBy?: readonly number[];
  /**
   * Whether a live WARP SCRAMBLER is on this ship — the one jam that turns a
   * microwarpdrive off.
   *
   * ⚠ NARROWER THAN `tackledBy` ABOVE, AND DELIBERATELY A SEPARATE FIELD. That
   * list counts BOTH tackle types, and the server's names for them are the wrong
   * way round from how a player says them: `warpScramblerMWD` is the scrambler
   * (it carries `blocksMicrowarpdrive`) and `warpScrambler` is the disruptor,
   * which stops a warp and leaves the prop mod running at full effect. Deriving
   * this from `tackledBy` would read a disruptor as an MWD kill.
   *
   * ⚠ THREE-STATE, AND `null` MUST NOT DISARM ANYTHING. Absent or null is "the
   * jam slice could not be read", not "clear" and not "scrammed". The rung that
   * uses it treats only an explicit `true` as a reason to stand a microwarpdrive
   * down — the same fail-open rule `itemHasActivationCycle` follows, and for the
   * same reason: a dropped SSE frame must never be what takes the speed off a
   * ship.
   *
   * ⚠ AND IT SAYS NOTHING ABOUT AN AFTERBURNER. No jam in this vocabulary stops
   * one, so a scrammed pilot with an afterburner keeps burning.
   */
  readonly scrammed?: boolean | null;
  /**
   * This ship's own drones out in space, by entity id — the ones this hull can
   * actually ORDER, which is a narrower set than the ones it owns.
   *
   * ⚠ ORDERABLE, NOT MERELY OWNED, AND THE DIFFERENCE IS A REAL BUG. An
   * ABANDONED drone still belongs to this character and still shows on grid, but
   * no hull controls it: a recall aimed at one answers 200 and the drone does
   * not move (observed live — see `canMyShipOrderDrone`). Counting it would make
   * the drone rung wait for a recall that can never land, for ever.
   *
   * Absent or empty means nothing of this ship's is out. Free — folded from the
   * space snapshot the tick already read, never a call of its own.
   */
  readonly myDroneIDs?: readonly number[];
  /**
   * The ship is in space and the scene read came back with no ship in it (or the
   * BFF said `stateValid: false`): a dead ballpark, not a quiet grid.
   *
   * ⚠ WHEN TRUE, EVERY FACT READ OFF THE SCENE IS UNKNOWN (`hostileOnGrid`,
   * `dronesOut`, `myDroneIDs` are null/absent) and the ladder decides nothing but
   * to wait -- see the blind rung in `decideCompanionStep`. Seen live 2026-10-14
   * 12:00:11 UTC: a fleet pilot's scene answered `{inSpace:true, entities:[],
   * ship:null}` with a 200 for ten minutes; "no hostile" fired the clear-grid
   * reload mid-fight and the rejoin stood by for ever.
   */
  readonly sceneBlind?: boolean | null;
  /**
   * What has this ship locked, by item id: the server's own `GetTargeters`,
   * kept from its OnTarget('otheradd' / 'otherlost') notices the way the retail
   * client keeps its "targeted by" list. `null` or absent when it could not be
   * read, which is never "nobody".
   */
  readonly lockedByIDs?: readonly number[] | null;
  // ─── The reload rung's three facts ────────────────────────────────────────
  //
  // ⚠ THESE ARE THROTTLED READS, NOT PER-TICK TRUTH. Each one costs a round
  // trip (a fit read and an inventory read), so the builder refreshes them on
  // its own interval and serves the previous answer in between — several ticks
  // may see the SAME reading. The rung is written so that costs nothing: it
  // confirms a load by watching a gun LEAVE `emptyWeaponModuleIDs` on a later
  // tick and never by a call returning cleanly, so a stale "still empty" is
  // indistinguishable from a fresh one and both are answered the same way,
  // under one bounded attempt budget. See `decideReload`.
  //
  // ⚠ AND EVERY ONE OF THEM IS THREE-STATE. `null` is "could not read", which
  // this rung treats as "cannot say" and never as "there is none" — a stumbled
  // fit read must not be reported as a ship whose guns are all loaded, nor a
  // stumbled cargo read as a ship with no ammunition aboard.

  /** Online weapon modules that take a charge and currently have none. Null when the fit could not be read this tick. */
  readonly emptyWeaponModuleIDs?: readonly number[] | null;
  /** Charge stacks in the ship's cargo. Null when cargo could not be read this tick. */
  readonly cargoCharges?: readonly CompanionCargoCharge[] | null;
  /** Weapon module itemID -> the charge groupIDs its type accepts, from the fit's own chargeFits. */
  readonly weaponChargeGroups?: Readonly<Record<number, readonly number[]>> | null;
  /**
   * What each online gun holds right now, from the same throttled fit read as
   * `emptyWeaponModuleIDs`: a gun with nothing in it is absent. Null when the
   * fit could not be read. For the `status` answer and the low-ammo warning
   * (companionSupply.ts), which count reloads against it.
   */
  readonly loadedCharges?: readonly CompanionLoadedCharge[] | null;
  /**
   * This pilot's own character id and name, so a `status` or `repair` line can
   * tell whether it names this pilot (`selectsPilot`). Null when unread, which
   * answers only to a line addressed to everyone.
   */
  readonly selfCharacterID?: number | null;
  readonly selfCharacterName?: string | null;
  /**
   * What each hostile TYPE on this grid fights with and how it moves -- missile
   * or turret, optimal, falloff, attack range, orbit range, speed -- read from
   * static type dogma (`ratCombatFromAttributes`), for the `flight auto`
   * positioning rung. Keyed by type for the reason `threatByTypeID` is.
   *
   * A type MISSING from the map has not been read, and one unread hostile makes
   * the whole grid's reach unknown -- "we do not claim to know", which is never
   * "it cannot hurt us": an unreadable grid is never kited (see
   * combatPosition.ts). `null` or absent is the same thing said about every type.
   */
  readonly ratCombatByTypeID?: Readonly<Record<number, RatCombatFacts>> | null;
  /**
   * Each hostile TYPE's shield / armour / hull resonances, for ranking ammo
   * against the layer being hit (companionAmmo.ts). Same fetch and same rule as
   * `ratCombatByTypeID`: a type missing is unread, and its ammo ranks on raw
   * damage.
   */
  readonly ratResonancesByTypeID?: Readonly<Record<number, RatResonances>> | null;
  /** Each charge TYPE aboard or loaded: damage split, range factors, size, name (ammoReach.ts). */
  readonly chargeFactsByTypeID?: Readonly<Record<number, ChargeFacts>> | null;
  /** Each weapon module TYPE's base rate of fire, damage multiplier and reload time. */
  readonly weaponCycleByTypeID?: Readonly<Record<number, WeaponCycleFacts>> | null;
}

/**
 * One stack of ammunition in this ship's cargo bay.
 *
 * ⚠ ALREADY NARROWED TO THE CHARGE CATEGORY BY THE BUILDER, which is what keeps
 * the "largest stack overall" fallback below from reaching for a hold full of
 * ore. Nothing in this file re-checks that, because nothing here can: a category
 * id is not on this shape and the ladder has ids, not a type table.
 *
 * `groupID` is three-state in its own right: a stack whose group could not be
 * decoded carries `null`, which the rung reads as "cannot say" and never as
 * "not compatible". See `pickChargeFor`.
 */
export interface CompanionCargoCharge {
  readonly itemID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  readonly quantity: number;
}

/** One gun's loaded charge. See `FleetCompanionObservation.loadedCharges`. */
export interface CompanionLoadedCharge {
  readonly moduleID: number;
  readonly typeID: number;
  readonly quantity: number;
}

/** Where one fleet member is, as the roster says. See `fleetCommanderWhereabouts`. */
export interface CompanionMemberWhereabouts {
  readonly characterID: number;
  /** Null when the roster did not say. */
  readonly solarSystemID: number | null;
  /** The station the member is docked in; null is in space. */
  readonly stationID: number | null;
}

/** A pending fleet invite, narrowed to the two ids the rejoin gate needs. */
export interface CompanionFleetInvite {
  readonly fleetID: number;
  /**
   * ⚠ `null` IS NEVER ACCEPTED. An invite whose notification carried no usable
   * inviter id cannot be matched against the remembered supervisors, and an
   * unmatchable invite is exactly the one the gate exists to refuse.
   */
  readonly inviterID: number | null;
}

/**
 * Everything the loop is allowed to do to the world. The controller is pure
 * against this — same construction as `MiningBotDeps`, and what makes the whole
 * ladder testable without a browser.
 */
export interface FleetCompanionDeps {
  observe(): Promise<FleetCompanionObservation>;
  issue(action: FleetCompanionAction): Promise<void>;
  sleep(ms: number): Promise<void>;
  /**
   * The clock, injectable ONLY so a test can drive the thirty-minute wait
   * without waiting thirty minutes. Defaults to `Date.now`.
   */
  now?(): number;
  /**
   * Push the readout after EVERY state change — including `stop()`.
   *
   * ⚠ NOT OPTIONAL, and not merely for the panel. The store's `botStatus`
   * record reads this loop's status to decide who is holding the ship. A loop
   * that stops without reporting leaves the store believing it still holds the
   * hull, so the next bot's claim looks like it stopped nothing and the readout
   * never clears.
   */
  onProgress?(progress: FleetCompanionProgress): void;
  /** The flight recorder (nav/companionLog.ts). Absent records nothing. */
  log?: BotLogSink | null;
  /**
   * Say one line in local chat as this pilot. Absent says nothing. A failure is
   * the line lost, never the run's: the loop does not wait on it to fly.
   */
  say?(text: string): Promise<void>;
}

/**
 * What one tick decided to do.
 *
 * `wait` is what most ticks decide — nothing new to do. Below it sit two
 * unrelated groups, each belonging to its own rung:
 *
 *   • the abandonment protocol (decision 5, rung 2) — warp / approach / dock /
 *     leaveFleet / acceptFleetInvite — the one thing a
 *     companion left without a human may do unsupervised.
 *   • obeying the fleet (rung 7) — lock / align / activate / travelTo —
 *     answering a fleet tag or broadcast while a human IS supervising. See
 *     `decideFleetOrders`.
 */
export type FleetCompanionAction =
  | { readonly kind: "wait" }
  /**
   * The get-safe ladder: warp in, close the last few km, dock.
   *
   * ⚠ `warp` ALSO CARRIES THE SAFE-SPOT FALLBACK NOW. When no station is on
   * grid the pilot warps to the system's STAR, which is an ordinary scene entity
   * (`kind: "sun"`) reached by the ordinary warp call — so there is no separate
   * action for it, and the `warpToBookmark` kind that used to serve that case is
   * gone. See `sunOnGrid`.
   */
  | { readonly kind: "warp"; readonly targetID: number }
  /**
   * Obeying the fleet (rung e2): warp to a FLEET MEMBER, named by character id
   * rather than by anything on this grid.
   *
   * ⚠ A SEPARATE ACTION BECAUSE IT IS A SEPARATE CALL, not because it is a
   * different idea. `warp` above is `CmdWarpToStuff("item", <objectID>)` and
   * this is `CmdWarpToStuff("char", <characterID>)`: the server resolves the
   * member's position itself, refuses a character who is not in this fleet or
   * not online, and so is the only warp that works when the destination is not
   * on the grid. Folding the two into one action would mean a caller guessing
   * which id space the number came from — the exact guess rung e2 makes with
   * the grid in front of it.
   */
  | { readonly kind: "warpToFleetMember"; readonly characterID: number }
  /**
   * Close on something. `range` is where to STOP, in metres -- null hugs it.
   *
   * ⚠ HUGGING IS WRONG FOR A JOB WITH A REACH. A salvager works to about 5 km
   * and a loot transfer to 2.5 km, so flying all the way to the object wastes
   * the whole approach and leaves the ship sitting on top of a wreck for no
   * reason. The get-safe ladder still hugs deliberately: it is closing on a
   * station to dock, where there is no working distance to stop at.
   */
  | { readonly kind: "approach"; readonly targetID: number; readonly range?: number }
  | { readonly kind: "dock"; readonly stationID: number }
  | { readonly kind: "leaveFleet" }
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number }
  /**
   * Obeying the fleet (rung 7): a tag or a `Target` broadcast, locked. Locking
   * is the whole of what this rung does with a target — there is no weapons
   * rung yet, so this is never a stand-in for shooting.
   */
  | { readonly kind: "lock"; readonly targetID: number }
  /** Obeying the fleet (rung 7): an `AlignTo` broadcast. */
  | { readonly kind: "align"; readonly targetID: number }
  /**
   * Obeying the fleet (rung 7): a Heal broadcast, answered with a fitted
   * remote-repair module aimed at the ship named. `repeat: -1` (run
   * continuously) is this codebase's own "keep cycling" — see the DSL's
   * `activate` case in flow.ts.
   */
  | { readonly kind: "activate"; readonly moduleID: number; readonly targetID: number }
  /**
   * Switch a module OFF. The companion's first: until the tank-up rung there
   * was nothing it started that it ever had to stop.
   *
   * ⚠ `typeID` IS WHAT MAKES THIS SAFE FOR PROP MODS, and it used to be absent.
   * This action's own comment read "NOT FOR PROP MODS AS IT STANDS": an
   * afterburner or MWD only actually STOPS when Deactivate names its propulsion
   * effect — the server infers a default effect on activate but NOT on
   * deactivate — so the call returned 200 with the burner still cycling. The BFF
   * resolves that effect name from the typeID, so passing it is the whole of the
   * fix, and `decidePropulsion` is the rung that needed it.
   *
   * ⚠ OPTIONAL BECAUSE EVERY OTHER CALLER IS RIGHT WITHOUT IT. Hardeners and
   * repairers stop on a bare Deactivate, and the BFF treats an absent typeID
   * exactly as it always did. Callers that have it should pass it; the tank-up
   * rung has no reason to.
   */
  | { readonly kind: "deactivate"; readonly moduleID: number; readonly typeID?: number }
  /**
   * Obeying the fleet (rung 7): a `TravelTo` broadcast — a solar system, not
   * an on-grid object, so this hands off to the SHARED autopilot
   * (flow.ts's `startRoute`) rather than warping or approaching itself.
   */
  | { readonly kind: "travelTo"; readonly systemID: number }
  /**
   * Obeying the fleet: jump through the gate this ship is sitting on.
   *
   * ⚠ ONLY THE GATE WE ARE AT, AND NO FAR SIDE. The rung used to stop at the
   * gate because `api.jump` wanted a `toGateID` it had no way to solve without
   * the autopilot's route graph. That was OUR constraint, not the game's:
   * `jumpSessionViaStargate` (transitions.js) resolves the destination itself
   * from `sourceGate.destinationID` whenever the far id is absent, and the only
   * thing insisting on one was the BFF's own INVALID_GATE check. A stargate
   * knows where it goes; we do not have to tell it.
   */
  | { readonly kind: "jumpGate"; readonly gateID: number }
  /**
   * Rung 4, "tackle → tag": letter a ship that is holding this one down, so the
   * whole fleet can call it.
   *
   * ⚠ THE ONLY WRITE THIS LOOP MAKES THAT NOBODY CAN SEE FAIL. The server
   * refuses a non-commander SILENTLY (`fleetRuntime.js:1317` returns a bare
   * `false`, and `beyonceService.js:3320` throws it away and returns null), so
   * the ack is byte-identical either way. `bridge/fleetCommand.ts` is the gate
   * that has to answer before the call, and the confirmation is seeing the
   * letter arrive in a later `fleetTargetTags` — never the write's own 200.
   */
  | { readonly kind: "setFleetTargetTag"; readonly targetID: number; readonly tag: string }
  /**
   * Rung 4's OTHER half: call the ship out by fleet broadcast instead of
   * lettering it — `Target`, bubble range, which is the retail client's own
   * `SendBroadcast_Target` down to the argument (see bridge/fleetWrites.ts).
   *
   * ⚠ THIS EXISTS BECAUSE THE TAG PATH IS SHUT TO ALMOST EVERY COMPANION, AND
   * PERMANENTLY. A companion alt joins somebody else's fleet as a plain member
   * and stays one; `setFleetTargetTag` refuses plain members
   * (fleetRuntime.js:1317). So the rung above it — "letter the ship that has
   * this one tackled so the fleet can call it" — described something that in
   * practice never fired. Broadcasting has NO commander gate on the server
   * (`sendBroadcast`, fleetRuntime.js:2521, gates on membership alone), which is
   * both EVE's own division of labour and the reason this action closes the gap
   * rather than papering over it.
   *
   * ⚠ AND ITS ACK MEANS SOMETHING, unlike the tag's. `false` back from the
   * server is a real refusal (the 2-second rate limit) rather than the tag
   * path's indistinguishable `null`. The dispatcher still does not RETRY on it
   * — see `decideTackleTag` for why one call per ship is the right budget —
   * but a dropped call is at least knowable, which is a thing this loop has
   * never been able to say about a tag.
   */
  | { readonly kind: "broadcastFleetTarget"; readonly targetID: number }
  /**
   * Rung 6: put drones out. `droneItemIDs` are BAY STACK ids, not drone entity
   * ids - a stack and a drone in space live in different id spaces, and the
   * launch route takes the former.
   */
  | {
      readonly kind: "launchDrones";
      readonly droneItemIDs: readonly number[];
      /**
       * How many of each stack, by stack id, when a sized launch chose them.
       * Absent means the whole of every stack (`wholeStackLaunch`), which is
       * what every launch meant before drone sizing.
       */
      readonly quantities?: Readonly<Record<number, number>>;
    }
  /**
   * Rung 6: bring drones home. `droneIDs` are the ENTITY ids of drones in
   * space, the other half of the pair above.
   *
   * ⚠ THIS IS THE WHOLE MOVE, NOT HALF OF IT. There is no scoop to follow: the
   * server flies them back at full speed and scoops them itself once they are
   * inside 2500 m. They stay visibly on grid for the whole trip home, so a
   * caller must not read "still on grid" as "the recall was refused".
   */
  | { readonly kind: "recallDrones"; readonly droneIDs: readonly number[] }
  /**
   * Rung 6: point drones at a ship. ENTITY ids, like `recallDrones`.
   *
   * ⚠ ONE CALL, TWO MEANINGS, AND THE SERVER DECIDES WHICH. `CmdEngage` against
   * a HOSTILE is an attack; against a FRIENDLY ship it is a repair, dispatched
   * to `assignDroneRepairTask` instead. There is no separate "repair" command to
   * make, which is why the companion's repair-drone rung issues this one.
   *
   * ⚠ AND THE FRIENDLY TEST IS NOT FLEET MEMBERSHIP. `isFriendlyRepairTarget`
   * checks character, owner, corporation and alliance ONLY, so repair drones
   * cannot rep an out-of-corp fleet-mate: the call is accepted and nothing
   * happens. That is a server fact, recorded rather than worked around.
   */
  | { readonly kind: "engageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /**
   * Rung 6: set salvage drones sweeping. ENTITY ids.
   *
   * ⚠ `targetID: 0` MEANS "THE SERVER PICKS THE WRECK" and is the normal case,
   * not a missing value -- `resolveAutomaticSalvageTarget` chooses one. It is
   * why a standing salvage order does not have to be re-aimed as each wreck is
   * consumed.
   */
  | { readonly kind: "salvageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /**
   * The `loot` chat order: empty a wreck, or a container, this ship is already
   * within range of.
   *
   * ⚠ WRECKS ARE OWNERSHIP-GATED AND CONTAINERS ARE NOT, which is why they are
   * two actions and not one. A wreck is opened only when it belongs to this
   * pilot or its corporation, and one whose owner cannot be read is never opened
   * at all -- the no-can-flipping rule, structural rather than polite. Salvaging
   * has no such gate, because salvaging anything is legal.
   */
  | { readonly kind: "lootWreck"; readonly wreckID: number }
  | { readonly kind: "lootContainer"; readonly containerID: number }
  /**
   * Rung 5: pay the station to put the armour back.
   *
   * ⚠ `itemIDs` COMES FROM THE SHOP'S OWN QUOTE, never from a guess at what is
   * damaged -- the same authority the DSL's `repair-ship` block uses. The
   * route behind it carries `confirm: true` in the body, which is how this
   * server makes a caller state intent; it is not a dialog and there is no UI
   * to raise.
   */
  | { readonly kind: "repairItems"; readonly itemIDs: readonly number[] }
  /**
   * Rung 5: leave the station a flee ended at.
   *
   * The companion's first undock, and the only call it makes that puts the
   * ship deliberately back into danger -- which is why everything above it in
   * `recoverAndReturn` is about being sure first.
   */
  | { readonly kind: "undock" }
  /**
   * The standing `follow`: hold station off the fleet commander at `range`
   * metres. `CmdFollowBall` with a non-zero range, the same call the DSL's
   * `follow-fleet-mate` block makes for a hand-picked mate.
   *
   * ⚠ A STANDING SERVER-SIDE ORDER, WHICH IS WHY THE RUNG ISSUES IT ONCE. The
   * ship goes on holding that station with nothing further sent, so a rung that
   * re-sent this every tick would be pure bridge traffic for a command already
   * in force -- and would spend this loop's one call per tick on it, starving
   * everything beneath. `followAnchorID`/`followRangeIssuedM` are the gate.
   *
   * ⚠ `range` IS METRES AND IS ALREADY CLAMPED. `chatCommands.ts` defaults and
   * clamps it as it parses (see `COMPANION_FOLLOW_RANGE_M` and the band beside
   * it), so nothing between here and the bridge re-checks the number.
   */
  | { readonly kind: "keepAtRange"; readonly targetID: number; readonly range: number }
  /**
   * `flight auto`: circle the engaged target at `range` metres. `CmdOrbit`, the
   * same call the DSL's orbit block makes.
   *
   * ⚠ A STANDING SERVER-SIDE ORDER, LIKE `keepAtRange` ABOVE, AND GATED THE SAME
   * WAY. The ship goes on orbiting with nothing further sent, so the positioning
   * rung sends it once per anchor and range (`holdNeedsReissue`, `combatPosition`)
   * and re-sends it only when the hold moves by more than the hysteresis: every
   * re-aim turns the ship and throws away the transversal the orbit was for.
   *
   * ⚠ IT MOVES THE SHIP, SO IT IS IN `changesShipMovement`, and that is what
   * makes formation come back after a fight: the wrapper clears the follow latch
   * on it, so the first quiet tick re-issues the keep-at-range on the commander.
   * An orbit left out of that list would leave the pilot circling a wreck while
   * the readout said "Holding station".
   */
  | { readonly kind: "orbit"; readonly targetID: number; readonly range: number }
  /**
   * The `stop` chat order: cut the engines where the ship is.
   *
   * ⚠ THE ONLY COMPANION ACTION THAT EXISTS TO UNDO STANDING ORDERS RATHER THAN
   * TO ISSUE ONE, and the only one that takes no argument because there is
   * nothing to name -- "where it is" is wherever that turns out to be. The
   * dispatcher pairs it with aborting the shared autopilot, because a `stop`
   * that halted the ship while the route solver was still running would be
   * undone on the autopilot's very next tick.
   *
   * ⚠ ISSUED ONCE PER `stop` HEARD, not once per tick the order is fresh. A
   * chat line stands in the backlog for its whole freshness window, and a ship
   * told to stop every two seconds for thirty seconds is a ship nothing else
   * can move in the meantime. `stopHeardAtMs`/`stopShipIssued` are the gate.
   */
  | { readonly kind: "stopShip" }
  /**
   * The reload rung: put rounds in empty guns from this ship's own cargo.
   *
   * ⚠ SEVERAL MODULES, ONE CALL, ON PURPOSE. `api.loadAmmo` takes a list, and a
   * bank of eight guns that all chose the same stack is one call rather than
   * eight ticks of them — which matters because this loop issues at most one
   * atomic call per tick, so eight separate loads would be sixteen seconds of a
   * ship shooting nothing.
   *
   * ⚠ ONE CHARGE STACK, NAMED BY ITEM ID AND NOT BY TYPE. The item id is what
   * identifies the stack sitting in this cargo bay; the type id says what kind
   * of round it is and would not tell the server which pile to draw from.
   *
   * The source is always cargo — see the dispatcher's own comment: a companion
   * that needs this is in space, where there is no station hangar to draw on.
   */
  | { readonly kind: "loadAmmo"; readonly moduleIDs: readonly number[]; readonly chargeItemID: number };

export interface FleetCompanionProgress {
  readonly status: FleetCompanionRunState;
  readonly phase: string | null;
  readonly action: string | null;
  readonly why: string | null;
  /** Whether this pilot is in a fleet at all. Null while the roster is unread. */
  readonly inFleet: boolean | null;
  /** Which authority the last decision came from, for the readout. */
  readonly followingOrderFrom: CompanionOrderAuthority | null;
  readonly lastOrderHeard: string | null;
  /** `targets called|all`: what this pilot shoots when nobody calls a target. */
  readonly targetMode: "called" | "all";
  /**
   * Whether this pilot's tag write would land. Three states, and the third is
   * the point: a pilot silently unable to tag looks exactly like one with
   * nothing to tag unless the readout can tell them apart.
   */
  readonly canTag: boolean | null;
  /**
   * Non-null while the supervision gate has failed and the abandonment
   * protocol is running (decision 5).
   *
   * ⚠ THIS IS THE CHANNEL THE PERSISTED CLOCK TRAVELS ON, not decoration. The
   * BFF's bot host reads it off this readout and writes it into the durable
   * roster row, and hands it back to `start()` after a restart. A readout that
   * dropped it would give the companion a fresh thirty minutes on every
   * restart — see `FLEET_COMPANION_ABANDONMENT_WAIT_MS`.
   */
  readonly abandonment: CompanionAbandonmentRecord | null;
  readonly failureReason: string | null;
  /**
   * The run paused itself -- a ladder `pause` or a command whose outcome it
   * could not confirm -- rather than being paused by the operator. The
   * Fleet companions window restarts the first kind and never the second.
   */
  readonly selfPaused: boolean;
  /**
   * The last decision's trace (companionTrace.ts), for the flight recorder's
   * `decide` line. Absent until a tick has decided, and on a tick whose read
   * failed: no rung ran, so there is nothing to say.
   */
  readonly trace?: CompanionTrace;
}

export interface FleetCompanionController {
  /**
   * `resuming` re-seats an abandonment that was already under way before a BFF
   * restart. Omitted for a fresh start, which is every browser start and every
   * launch a player actually presses.
   */
  start(request: FleetCompanionRequest, resuming?: CompanionAbandonmentRecord | null): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Stop new work and settle the tick already issuing an order. */
  beginGracefulStop(): Promise<void>;
  /** One decision cycle: read, decide, issue at most one atomic call. */
  tick(): Promise<FleetCompanionAction>;
  /** Drive until the loop leaves the running state (production driver). */
  run(): Promise<void>;
  snapshot(): FleetCompanionProgress;
}

/** The cadence the other loops use. Two seconds is a lower bound, never exact. */
export const FLEET_COMPANION_CADENCE_MS = 2000;

/**
 * How long a companion keeps re-reading through a dropped connection before
 * it gives up on the ship.
 *
 * ⚠ A TIME, NOT A COUNT, because the failures it rides out come in seconds,
 * not in ticks. The game server stalls for ten to fifteen seconds under load,
 * and every read inside the stall fails at once with the gateway unreachable --
 * so a count of five, at a two-second cadence, ends the run inside the very
 * stall it was meant to survive. A stopped companion stays stopped until a
 * player notices, which on a fleet alt is the rest of the fight.
 */
export const FLEET_COMPANION_READ_GRACE_MS = 60_000;

/**
 * The gap after a tick that ISSUED A CALL, rather than after one that waited.
 *
 * ⚠ THIS EXISTS BECAUSE THIS LADDER ANSWERS ONE ORDER OVER SEVERAL TICKS, AND
 * A FLAT CADENCE CHARGED FULL PRICE FOR EVERY ONE OF THEM. Obeying a single
 * `Target` call is: lock it, wait for the lock to land, put the drones on it,
 * then bring the guns up ONE MODULE PER TICK (`decideOpenFire`). At a flat two
 * seconds -- really nearer four, once the tick's own reads are counted -- a
 * five-gun pilot was half a minute from "the FC called it" to "everything this
 * hull owns is shooting it". None of those steps is waiting on the WORLD; each
 * is waiting only for this loop to come round again.
 *
 * ⚠ IT IS KEYED ON "DID THIS TICK ISSUE SOMETHING", NOT ON "IS THERE A FIGHT",
 * AND THAT IS WHAT KEEPS EVERY TICK-COUNTED BUDGET IN THIS FILE HONEST. A rung
 * that is WAITING -- counting out a drone hold-off, watching for a recall to
 * complete, sitting out a flee recovery -- returns no action, so the tick that
 * carries it is a `wait` and still sleeps the full cadence. Only a tick that
 * did something comes back early, and a loop that is doing something every
 * ~350 ms is a loop with a queue of orders to work through, which is exactly
 * the case this is for. The moment the queue empties the ladder returns `wait`
 * and the beat goes back to two seconds.
 *
 * ⚠ AND IT IS NOT A LOWER BOUND ON THE READ TRAFFIC IT COSTS. The tick's own
 * six round trips happen before this sleep, so a burst tick is ~350 ms PLUS the
 * reads, not 350 ms total. The measured tick is ~4 s at a 2 s cadence, so a
 * burst tick lands nearer 2 s -- twice as fast, not six times.
 */
export const FLEET_COMPANION_BURST_MS = 350;

/**
 * How long an abandoned companion waits before giving up and releasing the
 * hull. Decision 5's number.
 *
 * ⚠ IT IS ONLY A BOUND IF THE CLOCK SURVIVES A RESTART. The BFF's roster row
 * outlives a restart, so an `abandonedAtMs` held only in memory would hand the
 * companion a fresh thirty minutes every time the process came back — an
 * unbounded wait assembled out of bounded ones. `CompanionAbandonmentRecord`
 * is the shape that gets persisted, and `start()` takes it back.
 */
export const FLEET_COMPANION_ABANDONMENT_WAIT_MS = 30 * 60 * 1000;

/** What can be docked at. Stations and player structures both take a dock. */
const DOCKABLE_KINDS: ReadonlySet<string> = new Set(["station", "structure"]);

/**
 * The two facts about an abandonment that MUST outlive a BFF restart: when it
 * started, and who may invite this pilot back.
 *
 * Deliberately NOT the whole of `CompanionAbandonment`. The get-safe flags
 * below describe a warp that is over the moment the process dies, so carrying
 * them across a restart would claim the ship had reached safety when nothing
 * knows whether it did. They reset; the clock does not.
 */
export interface CompanionAbandonmentRecord {
  readonly abandonedAtMs: number;
  /**
   * The non-bot fleet-mates seen on the last tick that PASSED the supervision
   * check — "the human who left". The rejoin gate's whole allowlist.
   *
   * ⚠ WITHOUT THIS GATE AN IDLE DOCKED COMPANION CAN BE FLEET-INVITED BY A
   * STRANGER AND HANDED A SHIP. That is why the protocol rejoins a CHARACTER
   * rather than a fleet.
   */
  readonly supervisorCharacterIDs: readonly number[];
}

/** The live abandonment: the persisted record plus this run's get-safe state. */
export interface CompanionAbandonment extends CompanionAbandonmentRecord {
  /** Whether an escape warp is pending authoritative movement confirmation. */
  readonly safeSpotWarpIssued: boolean;
  readonly safeSpotWarpAttempts: number;
  readonly safeSpotWarpWaited: number;
  /**
   * Whether the ship has since been OBSERVED in warp.
   *
   * "Issued the warp" is not "left the
   * grid" — the POST returns before `shipMode` flips — and treating it as such
   * would drop fleet while the ship still sat where it was, which is the one
   * ordering mistake decision 5 calls out. Safety is confirmed by a READING,
   * never by elapsed time. An unconfirmed warp's wait limit sends the warp
   * again; it never authorizes leaving fleet. (Arriving at the sun is also a
   * reading -- see `atTheSun` -- for the warp a stall hid from every tick.)
   */
  readonly safeSpotWarpSeen: boolean;
  /**
   * How many ticks the get-safe step has spent waiting on a drone recall, or
   * null if it has not issued one.
   *
   * ⚠ THE SERVER ABANDONS EVERY CONTROLLED DRONE ON ANY WARP, JUMP OR DOCK, and
   * an abandoned drone can be scooped by ANYBODY on grid. `handleControllerLost`
   * (`droneRuntime.js:5735`) only attempts a bay recovery when the lifecycle
   * reason is a disconnect or a logoff; a normal departure passes neither, so
   * the recovery branch is skipped outright however close the drones are. So
   * leaving without recalling does not merely cost this pilot its drones -- it
   * hands them to whoever is still there.
   *
   * ⚠ AND IT MUST NEVER BLOCK THE ESCAPE. This is a bound, not a promise: a
   * recall that cannot complete -- a full bay, which the server refuses in
   * silence -- must not strand an unsupervised pilot in space for the whole
   * thirty-minute wait. Drones are worth a few seconds of delay and are not
   * worth the ship.
   */
  readonly droneRecallWaited: number | null;
  /**
   * Ticks left before the escape warp is tried again after it was refused
   * repeatedly, or absent. See `COMPANION_ESCAPE_RETRY_BACKOFF_TICKS`.
   */
  readonly safeSpotWarpBackoff?: number;
}

/**
 * The memory the ladder threads from tick to tick. Pure in, pure out: the
 * ladder never mutates it and the controller stores whatever comes back — the
 * same construction the script runner's deciders use.
 */
interface CompanionDroneEngagement {
  readonly targetID: number;
  readonly flightIDs: readonly number[];
  readonly requestedIDs: readonly number[];
  readonly acceptedIDs: readonly number[];
  readonly refusedIDs: readonly number[];
  readonly uncertainIDs: readonly number[];
  readonly refusals: Readonly<Record<number, number>>;
  readonly deferrals: number;
  readonly deferralWait: boolean;
  readonly pending: boolean;
  /**
   * Ticks left before this order is sent again, or absent. See
   * `COMPANION_RESEND_WAIT_TICKS` and `COMPANION_RETRY_BACKOFF_TICKS`.
   */
  readonly cooldown?: number;
}

export interface CompanionLadderMemory {
  /** Server chat timestamps plus sender/text identity disambiguate timestamp ties. */
  readonly standingChatCursor: { readonly at: number; readonly keys: readonly string[] } | null;
  /**
   * One alignment request, confirmed on dispatch success. An uncertain write is
   * resent after a short wait rather than parked: aligning to the same object
   * twice is the same order, not a second one.
   */
  readonly alignmentOrder: {
    readonly key: string;
    readonly targetID: number;
    readonly status: "pending" | "issued" | "refused" | "uncertain";
    readonly refusals: number;
    /**
     * Ticks left before this order is sent again, or absent. See
     * `COMPANION_RESEND_WAIT_TICKS` and `COMPANION_RETRY_BACKOFF_TICKS`.
     */
    readonly cooldown?: number;
  } | null;
  /** A bounded lock wait and refused or uncertain repair writes for one call. */
  readonly healOrder: {
    readonly targetID: number;
    readonly name: HealBroadcastName;
    readonly lockIssued: boolean;
    readonly lockWaited: number;
    readonly moduleRefusals: Readonly<Record<number, number>>;
    readonly uncertainModuleIDs: readonly number[];
  } | null;
  /** Refreshed on every tick the supervision check passes. */
  readonly lastSupervisorIDs: readonly number[];
  /** Non-null from the tick the check first fails until supervision returns. */
  readonly abandonment: CompanionAbandonment | null;
  /** The target of an approach this loop started, for `decideCloseIn`. */
  readonly closingOn: number | null;
  /** When `closingOn` was last stamped by an approach; `null` whenever `closingOn` is. See `APPROACH_SETTLE_MS`. */
  readonly closingOnAtMs: number | null;
  /**
   * Modules RUNG 3 (tank up) has switched on and not yet switched back off —
   * the stand-down record. Mirrors `standDownAfterFight`'s own `hardened`
   * list, generalised to every module kind rung 3 can light (hardeners AND
   * self-repairers alike, both self-targeted), because the fight-end
   * stand-down switches off everything this rung is responsible for, not
   * hardeners alone.
   *
   * ⚠ WITHOUT THIS THE STAND-DOWN COULD SWITCH OFF A MODULE SOMEBODY ELSE
   * LIT. `activeModuleIDs` says a module is cycling; it never says WHO
   * switched it on. Only a module this rung remembers lighting is ever a
   * candidate for this rung to switch back off.
   */
  readonly lastTankUpModuleIDs: readonly number[];
  /**
   * The target rung 7 last issued a `lock` call for — the fallback for
   * `isAlreadyLocked` when `obs.lockedTargetIDs` itself is unreadable. See
   * that function's own comment for why the authoritative read still wins
   * whenever it is available.
   */
  readonly lastLockIssuedFor: number | null;
  /**
   * The ship rung 7 last aimed a Heal-family `activate` at, and which fitted
   * modules it has issued for THAT ship. This is the fallback
   * `isHealModuleAlreadyRunning` uses when `activeModuleIDs` cannot say —
   * nothing in a space snapshot exposes a remote-repair module's target, so
   * the server confirming a module is cycling is not by itself proof it is
   * cycling on the ship THIS tick's call names. Reset to a fresh list the
   * moment the call names a different ship.
   */
  readonly lastHealTargetID: number | null;
  readonly lastHealModuleIDs: readonly number[];
  /**
   * The solar system rung 7 last issued a `travelTo` route to, so a standing
   * `TravelTo` broadcast does not restart the shared autopilot every tick.
   */
  /**
   * The target rung 7 last aimed a WEAPON at, and which fitted weapons it has
   * issued for THAT target. The same pair, for the same reason, as
   * `lastHealTargetID` above: a snapshot says a module is cycling and never
   * says what it is cycling AT, so a gun still chewing on the rat the commander
   * has moved off looks identical to one obeying the current call. Reset to a
   * fresh list the moment the call names a different ship; `gunAimedAt` below
   * is what remembers where the rest of the rack still is.
   */
  readonly lastFireTargetID: number | null;
  readonly lastFireModuleIDs: readonly number[];
  /**
   * The target rung 7 last ACTIVATED each weapon on, by module id, kept across
   * calls. `lastFireTargetID` above forgets every gun the moment the call moves,
   * and this is the half that does not: it is what lets a re-aim tell "running
   * on the ship we left" (stop it) from "running, and we never aimed it" (leave
   * it alone). See `decideOpenFire`. Optional: a memory written before it
   * existed reads as "no aim known".
   */
  readonly gunAimedAt?: Readonly<Record<number, number>>;
  /**
   * The modules (a bank's master for a banked gun) rung 7 has switched OFF to
   * re-aim them, and that still read as cycling. Each is stopped ONCE: a stop
   * that is still finishing its cycle is waited on, never re-sent. Dropped the
   * tick the module reads idle.
   */
  readonly gunStops?: readonly number[];
  /**
   * The newest `Target` broadcast this pilot heard, held past a LATER broadcast
   * of another kind. See `heldTargetCallID`.
   */
  readonly targetCall?: HeardTargetCall | null;
  /**
   * The newest `JumpTo` this pilot heard, held past the broadcast's freshness
   * window and past a later broadcast of another kind. See `withHeardGateCall`.
   */
  readonly gateCall?: HeardGateCall | null;
  readonly lastRoutedSystemID: number | null;
  /**
   * The ship rung 4 (tackle → tag) last issued a `setFleetTargetTag` for, and
   * how many writes it has spent on it. The pair exists because the write's own
   * ack is worthless — see the action kind's comment — so the only confirmation
   * is the letter appearing in a later `fleetTargetTags`, which takes at least
   * one more tick to arrive.
   */
  readonly lastTagIssuedFor: number | null;
  readonly lastTagAttempts: number;
  /**
   * Ships whose tag budget ran out without the letter ever showing up.
   *
   * ⚠ WITHOUT THIS THE RUNG DEADLOCKS ON ITS OWN FIRST CANDIDATE. Give-up has
   * to be remembered per SHIP, not as a single "stop tagging" flag: the ranking
   * would hand back the same unconfirmable ship every tick, and a second
   * tackler that could have been lettered would never be reached. Capped, so a
   * long fight cannot grow it without bound.
   */
  readonly taggingGaveUpOn: readonly number[];
  /**
   * Ships this pilot has already called out by BROADCAST (rung 4's fallback for
   * a non-commander). One entry per ship, one broadcast per entry, for the run.
   *
   * ⚠ A BROADCAST HAS NO STATE TO RE-READ, WHICH IS WHY THIS LIST AND NOT AN
   * ATTEMPT COUNTER. A tag can be watched for in a later `fleetTargetTags`, so
   * the tag arm knows when to try again and when to give up; a broadcast is a
   * one-shot notification that leaves nothing behind to observe. With no
   * confirmation to wait for there is nothing a second call could learn — it
   * would just be the same shout again, every two seconds, for as long as the
   * ship held this one tackled.
   *
   * ⚠ AND IT IS WHAT STOPS TWO COMPANIONS SHOUTING AT EACH OTHER. A `Target`
   * broadcast is an ORDER to the other rungs of every companion that hears it
   * (`asNamedOrderName`, and newest-wins), so without a per-ship memory two
   * pilots tackled by the same ship would re-call it in turn indefinitely. With
   * one, the exchange is bounded at one call per pilot per ship and then stops.
   *
   * Capped like `taggingGaveUpOn`, for the same reason: a long fight must not
   * grow it without bound.
   */
  readonly tackleCalledOut: readonly number[];
  /**
   * When each ship in `tackleCalledOut` was last called, for the re-send rate
   * limit in `decideTackleBroadcast`. Kept to the ids that list still holds.
   * Optional: a memory written before it existed reads as "never timed".
   */
  readonly tackleCalledAtMs?: Readonly<Record<number, number>>;
  /**
   * The target this pilot's last lock refusals were against, and how many it has
   * had in a row.
   *
   * ⚠ THE STREAK IS PER TARGET AND RESETS WHEN THE TARGET CHANGES, the same
   * shape as `lastTagIssuedFor`/`lastTagAttempts` above. A fleet that calls
   * three different ships in a row has not exhausted anything; three refusals on
   * ONE ship is what says this pilot cannot lock that ship.
   */
  readonly lockRefusedFor: number | null;
  readonly lockRefusals: number;
  /**
   * Ships this pilot has stopped trying to lock.
   *
   * ⚠ WITHOUT THIS, A CALLED TARGET IT CANNOT REACH HOLDS THE WHOLE LADDER. Rung
   * 7 re-issues a refused lock every tick by design -- the authoritative lock
   * list is consulted rather than believed, so a refusal never reads as done --
   * and that is right for a lock that will land once the ship drifts closer. It
   * is wrong for one that never will: the rung returns a real decision every
   * tick, so every rung BENEATH it (the loot order, salvage) is starved for as
   * long as the fleet keeps calling that ship. Observed as a pilot that stopped
   * looting and did nothing visible at all.
   *
   * ⚠ FOR THE RUN, BUT NOT PAST A WARP. What is out of reach is a fact about
   * where this ship is standing, and a warp moves it -- so the mid-warp tick
   * empties this. A pilot that lands on a new grid tries everything again, which
   * is the honest answer: nothing it learned on the old grid is still true.
   *
   * Capped like `taggingGaveUpOn`, so a long fight cannot grow it without bound.
   */
  readonly lockGaveUpOn: readonly number[];
  /**
   * The called target rung 7 asked to lock and has not yet seen land, and when.
   *
   * ⚠ WITHOUT THIS THE RUNG ASKED AGAIN ON EVERY TICK OF THE LOCK TIMER. A lock
   * is not instant: the server holds it pending for the retail scan-resolution
   * time (about 6.5 s for a Vexor on a 35 m frigate) and the lock list shows it
   * only once it lands. Every tick in between read "not locked" and issued
   * `lock` again, and a tick that issues something sleeps only
   * `FLEET_COMPANION_BURST_MS` -- so 2026-10-12's fights carried ten to twenty
   * AddTarget calls per pilot per kill, each with a full set of reads, and the
   * server answered every repeat with "pending". Asked again only after
   * `LOCK_LANDING_WAIT_MS`, so a lock the server dropped is not waited on for
   * ever; a refusal clears it at once (`noteRefusedLock`).
   */
  readonly lockPending: { readonly targetID: number; readonly sinceMs: number } | null;
  /**
   * The hostiles the lock-ahead has asked to lock, each asked at most once, and
   * when. See `decideLockAhead`. Capped at `MAX_PRELOCK_MEMORY`, emptied by a
   * warp like `lockGaveUpOn`.
   */
  readonly preLocked: readonly { readonly targetID: number; readonly atMs: number }[];
  /**
   * Rung 6's hurt-drone rotation: the drone being pulled and relaunched, if
   * any, and how many times each drone has been pulled IN THIS FIGHT.
   *
   * ⚠ A RECORD, BECAUSE THE TRIGGER EXTINGUISHES ITSELF. The instant the recall
   * lands the drone is not in space, so its shield cannot be read and the
   * condition that started the rotation is no longer true. `droneRotation.ts`
   * carries the rest of the reasoning.
   *
   * ⚠ THE COUNTS ARE PER FIGHT, NOT PER RUN. They are dropped when the grid is
   * seen quiet (`hostileOnGrid === false`). A per-run budget is what this
   * replaced: three pulls in the first fight and the drones were left to die
   * in every fight after it, for the rest of the session.
   */
  readonly droneRotation: DroneRotationMemory;
  /**
   * When this pilot last recalled its combat drones to swap them for a better
   * size, or null. `shouldSwitch`'s minimum interval reads it, so a commander
   * flicking between two targets does not keep the drones commuting.
   */
  readonly droneSizeSwitchAtMs: number | null;
  /**
   * The drones that swap called home, held until they are aboard. ⚠ WITHOUT
   * THIS THE SWAP UNDOES ITSELF: the engage below the switch would see its
   * flight still out and still on the target, and order the recalled drones
   * straight back onto it.
   */
  readonly droneSizeRecalledIDs: readonly number[];
  /**
   * The drone assist modules this rung has switched on (or tried to) for the
   * fight now on. Tried ONCE each: a module the server will not run is not
   * asked again every tick. Cleared as the rung switches them back off.
   */
  readonly droneAssistLit: readonly number[];
  /**
   * The job-over recall rung 6 last issued, or null when none is in flight.
   *
   * ⚠ WITHOUT THIS THE RUNG RE-ISSUES ITS RECALL EVERY TICK while the drones fly
   * home (observed live, 2026-10-12: 20-30 identical recalls per pilot, ~390 ms
   * apart, one of them a failed call). A tick that issues an action comes back
   * at `FLEET_COMPANION_BURST_MS`, and the drones are still on grid for the
   * whole flight, so the condition stays true and every burst tick spent its
   * one atomic call on an order the server had already taken.
   */
  readonly jobOverRecall: JobOverRecall | null;
  /**
   * The launch rung 6 last sent to put drones out for a job, or null.
   *
   * ⚠ WITHOUT THIS A PILOT THAT CANNOT SEE ITS DRONES DOES NOTHING ELSE. Seen
   * live 2026-10-12: five drones launched on landing never got a state in the
   * pilot's park, so it read none of that kind as out and sent a launch for the
   * five left in the bay on every tick for 5.5 minutes. The server refused each
   * one silently, since every control slot was taken by a drone the pilot could
   * not see, and each one spent the tick's one action, so the pilot never
   * followed, locked or engaged.
   */
  readonly droneLaunch: DroneLaunch | null;
  /**
   * The ship this pilot's repair drones were last sent to.
   *
   * ⚠ WITHOUT THIS THE RUNG RE-ISSUES ITS ORDER EVERY TICK. Drones already
   * repairing the right ship need telling nothing, and re-sending the same
   * engage twice a second would spend this loop's one atomic call per tick on
   * an order the server has already obeyed -- starving every rung beneath it.
   * Same shape, and the same reason, as `lastHealModuleIDs` above.
   */
  readonly lastDroneRepairTargetID: number | null;
  /** The deployed flight that received `lastDroneRepairTargetID`. */
  readonly lastDroneRepairIDs: readonly number[];
  /**
   * The target this pilot's COMBAT drones were last sent onto.
   *
   * ⚠ SAME SHAPE AND SAME REASON AS `lastDroneRepairTargetID` ABOVE: drones
   * already shooting the right ship need telling nothing, and re-issuing the
   * engage every tick would spend this loop's one call per tick on an order the
   * server has already obeyed. A NEW call from the fleet is a different id and
   * re-issues by itself. The latch also belongs to the deployed flight: drones
   * recalled and relaunched start idle even when their item ids are unchanged.
   */
  readonly lastDroneEngageTargetID: number | null;
  readonly lastDroneEngageIDs: readonly number[];
  readonly combatDroneOrder: CompanionDroneEngagement | null;
  readonly repairDroneOrder: CompanionDroneEngagement | null;
  /**
   * The locked wreck the salvage drones were last sent to, and how many drones
   * that order went to.
   *
   * ⚠ THE WRECK IS NAMED, NEVER LEFT TO THE SERVER'S AUTO-PICK. Auto-pick only
   * takes wrecks owned by the pilot or a CURRENT fleet mate, so a dropped fleet
   * or a field another pilot killed left the drones launched and idle for
   * hours. The salvage rung locks the wreck it is working and sends the drones
   * at that.
   *
   * ⚠ A COUNT AS WELL AS THE WRECK, because the set of drones out can CHANGE
   * while the order stands: one more launched is a drone that has been told
   * nothing. Neither is re-sent on a beat: a repeated order restarts the
   * drone's salvage cycle.
   */
  readonly salvageDronesWreckID: number | null;
  readonly lastSalvageOrderedFor: number | null;
  /**
   * Wrecks and containers the `loot` order has already emptied this run, and
   * the one currently being closed on.
   *
   * ⚠ A WRECK STAYS ON GRID AFTER IT IS EMPTIED, so "still there" cannot mean
   * "still has something in it" and this record is the only way the rung knows
   * to move on. A container is the opposite -- the server despawns an empty
   * jetcan -- but one list for both is simpler than two rules, and marking a
   * can that has already vanished costs nothing.
   */
  readonly lootedItemIDs: readonly number[];
  readonly lootApproaching: number | null;
  /**
   * When `lootApproaching` was last issued, so the rung can tell "just sent" from
   * "sent a while ago and not running". `null` whenever the latch is clear. See
   * `APPROACH_SETTLE_MS`.
   */
  readonly lootApproachAtMs: number | null;
  /**
   * The can or wreck this pilot has committed to opening.
   *
   * ⚠ WITHOUT THIS THE RUNG WANDERS, and it did (observed live, 2026-09-11: a
   * pilot flew to a container, did not loot it, and set off for a different
   * one). The target was re-picked from scratch on EVERY tick, and the inputs
   * move underneath it: this ship's own distances change as it closes, and the
   * fleet-mate claim flips as another pilot moves. So the nearest-unclaimed can
   * stopped being the same can halfway there, and it turned for the new one --
   * for ever, arriving at none of them.
   *
   * The salvage rung latched its wreck from the start (`salvageWreckID`) for
   * exactly this reason; looting was written without it and should not have
   * been. Choosing is a decision; a decision that is remade every two seconds is
   * not a decision.
   */
  readonly lootTargetID: number | null;
  /**
   * The wreck a fitted SALVAGER is working, and how long its lock has been
   * waited on. Null when no salvager ladder is under way.
   *
   * ⚠ A RECORD, NOT A RE-DERIVATION, for the reason the drone cycle carries one:
   * the ladder spans several ticks (approach, lock, activate) and the condition
   * that started it -- a wreck being the nearest -- can change underneath it. A
   * rung that re-picked the nearest wreck every tick would approach one, lock
   * another, and salvage neither.
   */
  readonly salvageWreckID: number | null;
  readonly salvageLockIssued: boolean;
  readonly salvageLockWaited: number;
  /**
   * Whether an approach has already been sent for `salvageWreckID`.
   *
   * ⚠ NOT DERIVABLE FROM DISTANCE. A ship that is closing is still out of
   * range, so "too far" cannot tell an approach that has not been issued from
   * one that is under way -- and re-sending it every tick would spend the
   * run's one call on a move the server is already making.
   */
  readonly salvageApproachIssued: boolean;
  /** When `salvageApproachIssued` was set; `null` whenever it is false. See `APPROACH_SETTLE_MS`. */
  readonly salvageApproachAtMs: number | null;
  /**
   * The standing area job -- `salvage`, `loot`, or none.
   *
   * ⚠ A LATCH, AND IT HAS TO BE. These verbs name a JOB ("salvage the wrecks in
   * vicinity"), not an instant. The first cut read them straight off the chat
   * backlog, which meant they inherited the BROADCAST freshness window -- right
   * for a target call, where a primary stops being one in seconds, and wrong
   * here. Observed live on 2026-09-11: a pilot salvaged exactly ONE wreck and
   * went back to standing by with two still on grid, because the order aged out
   * of its thirty-second window mid-job. An operator would have had to re-type
   * the word every half minute.
   *
   * ⚠ IT CLEARS ITSELF WHEN THE JOB IS DONE, which is what keeps a latch from
   * being a trap: no wrecks left to salvage, or nothing left to loot, and the
   * pilot goes back to its own ladder without anybody saying so. `stop` cancels
   * it early, and every rung ABOVE it still preempts it -- a flee, a fleet warp
   * or a target call interrupts a salvage job exactly as before.
   */
  readonly areaJob: "salvage" | "loot" | null;
  /**
   * The object a `WarpTo` order has already been answered for.
   *
   * ⚠ A WARP IS NOT IDEMPOTENT THE WAY A LOCK IS. Re-sending it while the ship
   * is already on its way is at best a wasted call and at worst a second warp
   * the moment the first lands, so the order is answered ONCE per destination
   * and a repeat of the same call is heard without being obeyed again.
   *
   * Finding the ship already there answers it as well: a fleet warp lands the
   * ship without this pilot warping, and the order still stands after it.
   */
  readonly lastWarpedToID: number | null;
  /**
   * The drones called home before a fleet order that leaves the grid, or null.
   * `leftAtMs` is set once the order itself has gone out. See
   * `recallBeforeLeavingOnOrder`.
   */
  readonly orderedLeaveRecall: { readonly startedMs: number; readonly leftAtMs: number | null } | null;
  /** Rung 5's flee, or null when the pilot is not running from anything. */
  readonly flee: CompanionFlee | null;
  /**
   * The capsule's run to a station, from the first tick that reads the pilot in
   * a capsule; null otherwise. See `decideShipLost`.
   */
  readonly shipLost: SafetyRun | null;
  /**
   * Round trips this run has spent, against `request.maxFleeAttempts`.
   *
   * Counted UP rather than down so the readout can say "2 of 3" without
   * needing the request to hand, and never reset by anything in this commit —
   * the return leg that earns a reset does not exist yet.
   */
  readonly fleeTripsSpent: number;
  /**
   * When this pilot last became well enough to count as recovered, against
   * `FLEE_RECOVERY_HOLD_MS`. Null whenever it is not currently recovering --
   * because it never fled, or because it has dropped back through its floor.
   * Holding out the whole span puts the budget back to full.
   *
   * ⚠ THIS IS WHAT MAKES "A RETURN THAT HOLDS" CHECKABLE. A pilot that comes
   * back and drops through its floor again before the span runs out never
   * reaches the reset, so its trips keep accumulating and it eventually stays
   * home -- which is the entire purpose of bounding them.
   *
   * ⚠ A TIMESTAMP AND NOT A TICK COUNT, for the reason
   * `DRONE_RECALL_GIVE_UP_MS` carries one. The count advanced on EVERY tick, including the ticks that
   * issue an action and now come back at `FLEET_COMPANION_BURST_MS` -- so "back
   * on station with nothing wrong for a while" would have meant a different
   * length of time for a pilot that happened to be shooting than for one
   * sitting still.
   */
  readonly fleeRecoverySinceMs: number | null;
  /**
   * The stand-off the newest `follow` order named, in metres.
   *
   * ⚠ A LATCH LIKE `areaJob`, FOR THE SAME REASON: a heard order changes it and
   * silence changes nothing. Following is this companion's STANDING behaviour --
   * nobody has to type anything for it to happen -- so this field starts at the
   * default rather than at null, and a `follow 10 km` only ever changes the
   * NUMBER. There is no "not following" value here; that is `followHeld` below.
   */
  readonly followRangeM: number;
  /**
   * Whether a `stop` has suspended the standing follow.
   *
   * ⚠ THIS FLAG EXISTS BECAUSE `stop` AND A STANDING BEHAVIOUR ARE IN DIRECT
   * TENSION, and deleting it "because nothing reads it as a real order" would
   * bring the bug straight back. The follow rung re-issues `keepAtRange`
   * whenever the anchor or range has changed -- and a `stopShip` changes
   * neither, so on the very next tick the rung would notice the ship is no
   * longer holding station and put it straight back into the formation the
   * operator just called off. The operator's words for `stop` are "it stops
   * where it is", which is a claim about the ship, not about one call. So the
   * standing behaviour is SUSPENDED rather than merely interrupted, and stays
   * suspended until somebody says `follow` (or `flight auto`) again.
   *
   * Nothing else clears it. A new anchor does not, a warp does not, a fleet
   * order does not: the operator said stop, and only the operator un-says it.
   */
  readonly followHeld: boolean;
  /**
   * The anchor and the range a `keepAtRange` has already been sent for.
   *
   * ⚠ SAME SHAPE AND SAME REASON AS `lastDroneEngageTargetID` ABOVE, plus the
   * range: the order is standing server-side, so re-sending it tells the server
   * nothing it does not already know. The PAIR is what matters -- a re-anchor
   * onto a different commander and a `follow 20 km` at the same commander are
   * both genuinely new orders, and either alone would miss one of them.
   */
  readonly followAnchorID: number | null;
  readonly followRangeIssuedM: number | null;
  readonly followOrder: {
    readonly targetID: number;
    readonly range: number;
    readonly status: "pending" | "issued" | "refused" | "deferred" | "uncertain";
    readonly refusals: number;
    readonly deferrals: number;
    readonly deferralWait: boolean;
    /**
     * Ticks left before this order is sent again, or absent. See
     * `COMPANION_RESEND_WAIT_TICKS` and `COMPANION_RETRY_BACKOFF_TICKS`.
     */
    readonly cooldown?: number;
  } | null;
  /**
   * The rejoin warp's record (`decideRejoinCommander`): which commander it went
   * to, how the server answered, and what has been spent. Null when no rejoin is
   * under way. The same shape and the same limits as `followOrder` above, plus
   * the two things a warp has and a formation order does not: whether the ship
   * was SEEN in warp after it went out, and how many warps have already landed
   * without finding the commander.
   */
  readonly rejoin: CompanionRejoin | null;
  /**
   * The solar system a `destination` order is taking this pilot to, or null.
   *
   * ⚠ A LATCH, AND A LONGER-LIVED ONE THAN `areaJob`. A multi-jump trip outlasts
   * any chat freshness window by minutes, so the order has to be remembered
   * rather than re-read; and unlike an area job it cannot clear itself by
   * looking at the grid, because "am I there yet" is a question about the SYSTEM
   * (`flightStatus.solarSystemID`), not about what is on the overview. It clears
   * on arrival, or on `stop`, and on nothing else.
   */
  readonly destinationSystemID: number | null;
  /**
   * The destination a `travelTo` has already been handed to the shared
   * autopilot for.
   *
   * ⚠ DELIBERATELY NOT `lastRoutedSystemID`, WHICH IS RUNG 7'S. Sharing the one
   * field looked tidy and had a real bug in it: `stop` clears the job but cannot
   * clear somebody else's record of a route, so a `destination` re-typed for the
   * SAME system after a `stop` would find the system already routed and issue
   * nothing at all -- a companion told twice to go somewhere, sitting still.
   * Cleared with the job, which is what makes re-typing the order work.
   */
  readonly destinationRoutedFor: number | null;
  /**
   * The `createdAtMs` of the newest `stop` this ladder has answered, and whether
   * the `stopShip` for it has gone out yet.
   *
   * ⚠ KEYED ON THE MESSAGE'S OWN TIMESTAMP, NOT ON A BARE "already stopped"
   * FLAG. A `stop` sits in the backlog for its whole freshness window, so a flag
   * would have to be cleared by something, and nothing here is entitled to
   * decide that an operator's `stop` has expired. A second `stop`, typed later
   * because the first did not look like it landed, carries a different timestamp
   * and is answered as the new order it is. Two `stop`s inside the same
   * millisecond are indistinguishable here and the second is not re-issued;
   * that is accepted, not overlooked.
   */
  readonly stopHeardAtMs: number | null;
  readonly stopShipIssued: boolean;
  /**
   * What the last `props on` / `props off` said, or `null` when nobody has said
   * either.
   *
   * ⚠ THREE STATES, AND `null` IS THE INTERESTING ONE. It does NOT mean "off";
   * it means nobody has overridden, and the pilot decides for itself — prop mod
   * on while it is travelling, off otherwise. `true` and `false` are a
   * commander's standing override in each direction, which is why `props off`
   * had to exist alongside `props on`: without it there is no way to countermand
   * a burn short of restarting the companion, the same gap `follow` closes by
   * doubling as its own resume.
   *
   * ⚠ IT LATCHES, LIKE THE TRIP AND THE FOLLOW ABOVE IT, AND UNLIKE A TARGET
   * CALL. A commander says "props on" once and means it until they say
   * otherwise; re-reading it off the chat backlog every tick would switch the
   * burner off the moment the line aged out of the freshness window. See
   * `withStandingChatOrders`, which folds all four latches in timestamp order so
   * "the last thing said wins" is answered once rather than per verb.
   *
   * ⚠ AND A `stop` DOES NOT CLEAR IT. `stop` cancels standing ORDERS — it
   * suspends the follow and drops the trip — and propulsion is not one: a
   * commander halting a pilot has said nothing about whether it may keep its
   * speed, and a ship told to stop is often the one that most needs to move
   * again in a hurry.
   */
  readonly propsHeld: boolean | null;
  /**
   * The prop mod this rung has a `deactivate` in flight for, so the off-half is
   * issued ONCE rather than every tick until the snapshot catches up.
   *
   * ⚠ THE SAME SHAPE AS `stopShipIssued`, AND FOR THE SAME REASON. Switching a
   * module off is not idempotent in cost: `activeModuleIDs` refreshes on the
   * space snapshot's own cadence, so between the call and the proof there are
   * ticks where the module still reads as cycling. Without this latch each of
   * them spends another Deactivate. Cleared the moment the module is seen
   * stopped, which is what makes a REFUSED deactivate retry rather than stick.
   */
  readonly propsStoppingID: number | null;
  /**
   * `targets called|all`: whether this pilot shoots only what the fleet calls,
   * or picks its own targets off the grid by the kill order when nobody is
   * calling one.
   *
   * ⚠ "called" IS THE DEFAULT, AND IT IS THE SAFE ONE. A commander who forgot
   * to say anything gets pilots that hold fire until a call, which is visible
   * and harmless. A free-fire default would shoot a site's wave trigger the
   * first time a fleet warped in, which cannot be taken back.
   *
   * ⚠ IT LATCHES LIKE `propsHeld`, AND A `stop` DOES NOT CLEAR IT, for the same
   * reason: `stop` cancels orders and halts the hull, and a mode is not an
   * order. See `withStandingChatOrders`.
   */
  readonly targetMode: "called" | "all";
  /**
   * `flight follow|auto`: whether the fleet commander leads the flight while
   * this pilot fights, or the pilot flies itself into reach of its target
   * (rung 8, `decideCombatPosition`).
   *
   * ⚠ "follow" IS THE DEFAULT, AND IT IS TODAY'S BEHAVIOUR. Positioning is a mode
   * the commander switches on, not the default (operator, 2026-10-13): a fleet
   * moving through gates, camping one, or whose FC wants the aggro must not have
   * its companions break formation on their own. The range gate on the guns
   * applies in both modes; only the flying differs.
   *
   * ⚠ IT LATCHES LIKE `targetMode`, AND A `stop` DOES NOT CLEAR IT, for the same
   * reason: a mode is not an order. See `withStandingChatOrders`.
   */
  readonly flightMode: "follow" | "auto";
  /**
   * Rung 8's record of the fight: its standing order, the closing budget and
   * leash on the engaged target, and whether formation is owed. See
   * `CombatPositionMemory` (companionCombatPosition.ts) for each part; the
   * wrapper drops the order on every movement rung 8 did not send.
   */
  readonly combatPosition: CombatPositionMemory;
  /**
   * Which guns the range gate last judged in and out of reach of `targetID`,
   * for `inReach`'s stickiness. A gun in neither list has no state yet.
   *
   * ⚠ THE STICKINESS IS THE POINT: a rat drifting x, x+1, x across a gun's reach
   * edge must not toggle that gun (operator: "no flicker"). A new target starts
   * with no state, so its first answer is the plain edge.
   */
  readonly weaponReach: WeaponReachState | null;
  /**
   * How many `loadAmmo` calls the reload rung has spent on each gun, keyed by
   * the module's own item id.
   *
   * ⚠ A BUDGET, FOR THE SAME REASON `lastTagAttempts` IS ONE: the call's ack is
   * worthless. The server decides what may be loaded and refuses in words this
   * layer never sees (see `api.loadAmmo`), so an accepted load and a refused one
   * are byte-identical from here and the only confirmation is the gun LEAVING
   * `emptyWeaponModuleIDs` on a later tick. Without the budget, a gun that
   * physically cannot take the only ammunition aboard would be reloaded for ever
   * and starve every rung beneath this one.
   *
   * ⚠ PER MODULE, NOT ONE COUNTER, because one call reloads a whole bank and
   * the guns in it can fail differently — a rack half missiles and half turrets
   * with only one kind of round aboard is exactly that case. Giving up has to be
   * per gun, so the rung moves on to the next one instead of stopping.
   *
   * ⚠ AND IT IS PRUNED EACH TICK TO THE GUNS THAT ARE STILL EMPTY, which is what
   * both RESETS a gun that reloaded (it may run dry again, and must be loadable
   * again when it does) and bounds this map to the size of one high-rack. An
   * unreadable `emptyWeaponModuleIDs` prunes nothing: "cannot say" is not
   * evidence a gun was loaded.
   */
  readonly reloadAttempts: Readonly<Record<number, number>>;
  /**
   * When the reload rung last SENT `loadAmmo` for each gun (ms), keyed by the
   * module's item id: a gun in here is RELOADING, not empty.
   *
   * ⚠ SEEN LIVE 2026-10-14 09:31-09:32 UTC (hybrid turrets, ~10 s reload): the
   * gun reads empty for the whole of the server's reload, so the rung re-sent
   * `loadAmmo` on three consecutive ticks and burnt `reloadAttempts` in about a
   * second, and the fire step tried to `activate` the same gun twice and was
   * refused NoCharges. A load that was SENT is waited on for the gun's own
   * reload time (`reloadingGuns`, companionAmmo.ts) before it may be judged to
   * have failed; the fire step and the ammo swap skip a gun in the window.
   *
   * ⚠ ONLY A GUN STILL READING EMPTY KEEPS ITS ENTRY: the reload rung prunes the
   * rest each tick (that is the load being confirmed), and a definitely REFUSED
   * `loadAmmo` clears its guns at once. Optional so a memory built before this
   * field existed reads as "nothing in flight".
   */
  readonly reloadInFlight?: Readonly<Record<number, number>>;
  /**
   * Rung 8a's record: the utility modules it switched on (and only those may it
   * switch off), its deactivates in flight, its activation budget and its sticky
   * reach verdicts. See `CompanionUtilityMemory` (companionUtilities.ts). A dock,
   * a flee and a resume forget it; a warp forgets the targeted half.
   */
  readonly utilities: CompanionUtilityMemory;
  /**
   * Ammo by target: the swap gate's memory per firing unit, the target rung 7
   * last stood on, and each gun's last measured loaded reach. See
   * companionAmmo.ts. Carried like the other combat memory; fresh on resume.
   */
  readonly ammo: CompanionAmmoMemory;
  /**
   * A `repair` addressed to this pilot, heard at this time and not yet taken up
   * by the flee rung, or null. A one-tick hand-off: the chat fold sets it, and
   * rung 5 turns it into an ordered trip (`CompanionFlee.ordered`) or answers
   * that there is no station to go to, and clears it either way. `stop` clears
   * it too.
   */
  readonly repairOrderedAtMs: number | null;
  /** Ammo loads seen, drones carried, the two warnings and a pending `status` (companionSupply.ts). */
  readonly supply: CompanionSupplyMemory;
}

/** See `CompanionLadderMemory.rejoin`. */
export interface CompanionRejoin {
  readonly characterID: number;
  readonly status: "pending" | "issued" | "refused" | "deferred" | "uncertain";
  /** Definite refusals, warps that never started, and landings without the commander. */
  readonly tries: number;
  readonly deferrals: number;
  readonly deferralWait: boolean;
  /** Ticks out of warp since the warp was taken, waiting to see it start. */
  readonly waited: number;
  /** A mid-warp tick has seen the ship in warp since this warp went out. */
  readonly seen: boolean;
  /** Why the last try failed, in player words, for the give-up readout. */
  readonly reason: string | null;
  /** Ticks left before the attempts start over. See `COMPANION_RETRY_BACKOFF_TICKS`. */
  readonly cooldown?: number;
  /** Where the roster put the commander when the warp went out (`commanderPlaceKey`). */
  readonly sentAt?: string;
  /** When the warp went out, in ms. */
  readonly sentAtMs?: number;
  /**
   * The server refused the warp as "the commander is not here". The rejoin then
   * waits for the commander's whereabouts to change, or for
   * `REJOIN_NOT_HERE_RECHECK_MS`, instead of spending tries.
   */
  readonly notHere?: boolean;
}

/** A job's launch in flight: which bay items it sent out, and when. */
export interface DroneLaunch {
  readonly droneItemIDs: readonly number[];
  readonly sinceMs: number;
}

/** A job-over recall in flight: which drones it named, and when. */
export interface JobOverRecall {
  /**
   * Watched individually: a drone out that is NOT in this list was launched
   * since, and the recall never named it.
   */
  readonly droneIDs: readonly number[];
  readonly sinceMs: number;
}

export function freshLadderMemory(): CompanionLadderMemory {
  return {
    standingChatCursor: null,
    alignmentOrder: null,
    healOrder: null,
    lastSupervisorIDs: [],
    abandonment: null,
    closingOn: null,
    closingOnAtMs: null,
    lastTankUpModuleIDs: [],
    lastLockIssuedFor: null,
    lastHealTargetID: null,
    lastHealModuleIDs: [],
    lastFireTargetID: null,
    lastFireModuleIDs: [],
    gunAimedAt: {},
    gunStops: [],
    targetCall: null,
    gateCall: null,
    lastRoutedSystemID: null,
    lastTagIssuedFor: null,
    lastTagAttempts: 0,
    taggingGaveUpOn: [],
    tackleCalledOut: [],
    tackleCalledAtMs: {},
    lockRefusedFor: null,
    lockRefusals: 0,
    lockGaveUpOn: [],
    lockPending: null,
    preLocked: [],
    droneRotation: emptyDroneRotationMemory(),
    droneSizeSwitchAtMs: null,
    droneSizeRecalledIDs: [],
    droneAssistLit: [],
    jobOverRecall: null,
    droneLaunch: null,
    lastDroneRepairTargetID: null,
    lastDroneRepairIDs: [],
    lastDroneEngageTargetID: null,
    lastDroneEngageIDs: [],
    combatDroneOrder: null,
    repairDroneOrder: null,
    lastSalvageOrderedFor: null,
    salvageDronesWreckID: null,
    lootedItemIDs: [],
    lootApproaching: null,
    lootApproachAtMs: null,
    lootTargetID: null,
    salvageWreckID: null,
    salvageLockIssued: false,
    salvageLockWaited: 0,
    salvageApproachIssued: false,
    salvageApproachAtMs: null,
    areaJob: null,
    lastWarpedToID: null,
    orderedLeaveRecall: null,
    flee: null,
    shipLost: null,
    fleeTripsSpent: 0,
    fleeRecoverySinceMs: null,
    // ⚠ THE DEFAULT RANGE, NOT NULL. Following is the standing behaviour, so a
    // companion nobody has typed `follow` at still has a distance to hold -- see
    // `followRangeM`. `followHeld` false for the same reason: it starts
    // following, it does not start suspended.
    followRangeM: COMPANION_FOLLOW_RANGE_M,
    followHeld: false,
    followAnchorID: null,
    followRangeIssuedM: null,
    followOrder: null,
    rejoin: null,
    destinationSystemID: null,
    destinationRoutedFor: null,
    stopHeardAtMs: null,
    stopShipIssued: false,
    // ⚠ `null`, NOT `false`. Nobody has said anything about propulsion yet, so
    // the pilot decides for itself; `false` here would ship every companion with
    // a standing order never to use its prop mod.
    propsHeld: null,
    propsStoppingID: null,
    targetMode: "called",
    // ⚠ "follow", NOT "auto": the commander leads until somebody says otherwise.
    flightMode: "follow",
    combatPosition: FRESH_COMBAT_POSITION,
    weaponReach: null,
    reloadAttempts: {},
    reloadInFlight: {},
    utilities: FRESH_COMPANION_UTILITIES,
    ammo: FRESH_COMPANION_AMMO,
    repairOrderedAtMs: null,
    supply: FRESH_COMPANION_SUPPLY,
  };
}

export interface CompanionDecision {
  readonly action: FleetCompanionAction;
  readonly phase: string;
  readonly why: string;
  /** The memory the NEXT tick carries. The caller stores it verbatim. */
  readonly memory: CompanionLadderMemory;
  /**
   * Set when the ladder has decided this run is OVER, carrying the sentence to
   * show for it. The controller stops and reports; it does not decide.
   *
   * ⚠ IT IS A STOP, NOT A PAUSE, AND THAT IS THE POINT. Both reasons that set
   * it — the wait ran out, or there is nowhere safe to go — mean nobody is
   * coming. Stopping is what RELEASES THE HULL: the BFF's bot host treats a
   * terminal status as the end of the bot and logs its session out, so the
   * pilot is flyable from a tab again. A pause would hold the ship forever.
   */
  readonly stop?: string;
  /** Retain the ship for the operator when a bounded action cannot be confirmed. */
  readonly pause?: string;
  /**
   * Which authority this decision came from, for the readout. Omitted (never
   * `null` here — `tick()` supplies the default) by every rung except rung 7;
   * the controller reads that omission as `"own-ladder"`, which is the honest
   * answer for the warp yield, the supervision gate, the abandonment protocol
   * and "Standing by" alike — none of them are obeying an external order.
   */
  readonly followingOrderFrom?: "tag" | "broadcast" | "chat";
  /** Short plain words for the panel — never the broadcast's wire name. */
  readonly lastOrderHeard?: string;
  /**
   * True when this decision is a STANDING one: the pilot is already obeying
   * this order and has nothing new to issue for it this tick.
   *
   * ⚠ THIS EXISTS TO STOP A RUNG PARKING THE TICK, and it replaces the one
   * place that did. `lockThenEngage`'s last branch used to return an ordinary
   * `wait` once the called target was locked and the guns were running, which
   * ended the ladder — so while a target call stood, every rung BELOW the
   * fleet-order rung was starved, which is exactly when they most want a turn.
   * A pilot obeying a target call would never have fled.
   *
   * The readout is why it was parked rather than dropped, and the readout is
   * kept: `decideCompanionAction` HOLDS a standing decision aside, runs every
   * rung beneath it, and falls back to it only if none of them acted. So the
   * panel still says "Obeying fleet" while the guns run, and a lower rung that
   * has real work still gets the tick.
   *
   * ⚠ A STANDING DECISION'S ACTION MUST BE `wait`. It is only ever a readout;
   * holding a real call aside and then not issuing it would silently drop it.
   *
   * ⚠ THE SECOND USER IS NOT AN ORDER AT ALL. `decideReload` marks its
   * "empty guns, and no ammunition aboard" sentence standing, because that is a
   * condition with nothing to issue for it and the flag means exactly "keep this
   * as a readout and let the rungs beneath have the tick". A standing decision
   * is therefore "something true worth saying that costs no call", which is the
   * wider reading of the same contract -- not only "already obeying".
   */
  readonly standing?: true;
  /** Lower work may continue, but must not replace this standing movement order. */
  readonly holdsNavigation?: true;
  /**
   * What the rungs that RAN this tick decided, in codes (companionTrace.ts).
   * Attached once, by `decideCompanionAction`; see `noteTrace`. A fragment is
   * absent when its rung never ran, which is how a reader sees where the tick
   * stopped.
   */
  readonly trace?: CompanionTrace;
  /**
   * The hostile a standing target decision is fighting, so the lock-ahead knows
   * which ship NOT to pre-lock and that there is a fight to lock ahead in.
   */
  readonly engagedTargetID?: number;
  /**
   * Set on the lock-ahead's own `lock`. A refusal of it is not booked against
   * the ship (`noteRefusedLock`): the pre-lock is an optimisation asked once,
   * and the ship gets its full budget the moment it becomes the target.
   */
  readonly preLock?: true;
  /**
   * Lines this pilot says in local chat this tick, in order: the `status`
   * answer, the low-ammo and low-drone warnings (companionSupply.ts), and the
   * repair trip's acknowledgements. Attached once, by `decideCompanionAction`;
   * absent when there is nothing to say. Saying costs no tick: the controller
   * sends them beside whatever the action is.
   */
  readonly say?: readonly string[];
}

/**
 * Fleet members this host is NOT flying with a bot — the humans.
 *
 * `null` when either half is unreadable, which is a genuinely different answer
 * from the empty array and must stay that way: `[]` means "looked, nobody
 * there", `null` means "could not look".
 */
export function supervisorsInFleet(obs: FleetCompanionObservation): readonly number[] | null {
  const members = obs.fleetMemberCharacterIDs ?? null;
  const driven = obs.botDrivenCharacterIDs ?? null;
  if (members === null || driven === null) {
    return null;
  }
  const ours = new Set<number>(driven);
  // This pilot is never its own supervisor. Belt and braces: a host reporting
  // its claims correctly already includes it, and a host that does not must
  // still never be told it is being watched by itself.
  if (obs.myCharacterID !== null && obs.myCharacterID !== undefined) {
    ours.add(obs.myCharacterID);
  }
  return members.filter((characterID) => !ours.has(characterID));
}

const WAIT: FleetCompanionAction = { kind: "wait" };

function waiting(phase: string, why: string, memory: CompanionLadderMemory): CompanionDecision {
  return { action: WAIT, phase, why, memory };
}

/** Nearest of a set by measured surface distance; unmeasurable sorts last. */
function nearestOf(
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    const distance = measurement?.distances.get(entity.itemID) ?? Number.POSITIVE_INFINITY;
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The ladder. Pure, synchronous, and the whole of what later phases extend.
 *
 * ⚠ RUNG 1 IS THE WARP YIELD AND IT MUST STAY FIRST. Fleet warp is
 * server-authoritative: when the fleet commander warps the fleet, this ship is
 * already moving whether or not the companion notices, and anything it issues
 * meanwhile fights the server and produces refusals. So a tick in warp decides
 * NOTHING — and that single rung satisfies the decided precedence for every
 * behaviour beneath it at once, instead of each one remembering the rule.
 *
 * `inWarp` cannot distinguish a fleet warp from a self-issued one; nothing in
 * the codebase can (`flow.ts` derives it from `shipMode` alone). That is an
 * accepted limit, not a gap this file introduces.
 *
 * ⚠ `=== true`, NEVER `!== false`. An unreadable `inWarp` must fail open, the
 * same way every other tri-state read in this codebase does — a ship that
 * cannot be read is not a ship that is known to be in warp.
 *
 * ⚠ RUNG 2 IS THE SUPERVISION GATE, AND IT SITS ABOVE EVERY ORDER SOURCE.
 * Decision 5: a companion does no unsupervised work, CONTINUOUSLY and not
 * merely at launch. It is a liveness gate rather than an order, which is why it
 * is not itself part of the precedence list it sits on top of — and rung 1
 * above it is not an order source either, it is the tick on which nothing can
 * be issued at all.
 *
 * Why the naive versions of this check fail, read out of the server on
 * 2026-09-10 (`/d/evet/server/src/services/fleets/fleetRuntime.js`):
 *
 *   • A disconnect REMOVES the character from the fleet
 *     (`handleSessionDisconnected`, :1861), so a logged-off human cannot
 *     satisfy this check and the roster read is not hollow. Good.
 *   • But the fleet SURVIVES with one member — the size test runs BEFORE the
 *     removal — and `assignBossToAnyRemainingMember` (:1838) then PROMOTES the
 *     companion to boss. So what this catches is not merely "kept flying
 *     unsupervised"; it is "was made fleet commander, and its tag writes
 *     started landing", in a fleet nobody is in.
 *
 * ⚠ THE LADDER AS IT STANDS, IN FULL. Every phase has extended this list and
 * several left the prose behind, so it is written out here once rather than
 * assembled from the rung comments below:
 *
 *     0  ship lost                  in a capsule: dock it, then stop
 *     1  yield to warp              server fleet warp wins, unconditionally
 *     2  supervision / abandonment  decision 5; getting safe lives here
 *     3  tank up                    hardeners, then each layer's repairer
 *     3b prop mod                   burn while travelling or closing (rung 8);
 *                                   `props on`/`off`
 *     4  tackle -> tag              letter what is holding this ship
 *     5  flee                       leave, get whole, come back
 *     6  drones                     launch, recall a hurt one, redeploy
 *     6a `stop` heard               one `stopShip`; everything else it does
 *                                   already happened above the gate
 *     6b `destination` trip         the ONE rung that outranks the fleet
 *     6c reload                     load empty guns from this ship's cargo
 *     7  obeying the fleet          tags, broadcasts, chat commands; guns
 *                                   start only in reach of the target
 *     7b lock-ahead                 the next kill's lock, while one stands
 *     8  combat positioning         `flight auto` only: orbit / keep at range
 *                                   on the target; holds navigation
 *     8b salvage, then loot         the area jobs; both move the ship
 *        (the standing-order readout, if rung 7 had one)
 *     9  follow                     hold station on the FC; standing, endless
 *        "Standing by"
 *
 * ⚠ RUNG 3 IS TANK UP, BELOW THE SUPERVISION GATE AND ABOVE OBEYING THE
 * FLEET. THE TANK GOES UP FIRST — the DSL's own fight-back watch lights
 * hardeners before it ever calls `fight-the-rats`, and its comment states the
 * principle this ordering rests on: a hardener is instant and self-targeted,
 * the same thing a player reaches for before they reach for the guns. It
 * costs at most a tick or two of a standing order going unobeyed, because
 * this rung has something to do only while a module is off and falls through
 * — returns null — the moment the rack is up. See `decideTankUp`'s own
 * header for the ladder inside this rung.
 *
 * ⚠ RUNG 5 IS THE FLEE, AND IT SITS ABOVE THE FLEET RUNG BECAUSE THE OPERATOR
 * PUT IT THERE. The plan doc's decision 3 originally read
 *
 *     server fleet warp > FC broadcast > chat command > own flee rule
 *
 * which makes a target call outrank a pilot's own survival. Phase 5's parking
 * fix took the worst of that away — a STANDING call is held aside and no
 * longer ends the tick — but a call with something real still to issue wins
 * outright, and `lockThenEngage` issues one lock plus one activate per weapon
 * before it goes quiet. The operator was asked and chose the flee; decision 3
 * was amended to match rather than left contradicting this file. Rung 1 still
 * outranks it, and that half was never in dispute: a fleet already leaving
 * does not need this pilot's opinion.
 *
 * Tank up and tackle-tag stay ABOVE it deliberately, which is how a ship
 * running away keeps hardening and keeps lettering whatever holds it. The
 * phase 6 spec asked for those to be "nested inside the flee continuation";
 * sitting above it is the same result with no nesting, and it only works
 * because both fall through the moment they have nothing to issue.
 *
 * ⚠ RUNG 7 IS OBEYING THE FLEET, THE LAST RUNG BEFORE "Standing by".
 * Unlike rung 2 it IS an order source (see `decideFleetOrders`'s own header
 * for the tag-over-broadcast reasoning and why an off-grid call is not an
 * order for this pilot at all).
 *
 * ⚠ THINGS DO SIT BENEATH IT NOW, AND THIS COMMENT ONCE SAID NOTHING EVER
 * WOULD. It claimed the slot `CompanionDecision.standing` was built for had no
 * consumer -- true when the flee moved above this rung and nothing was left
 * below. Four rungs have since filled it: the salvage and loot jobs, and the
 * standing follow, all of them beneath the standing-order readout because all
 * three MOVE THE SHIP and obeying the fleet outranks flying formation or
 * clearing a field of wrecks.
 *
 * So the hold-aside half of the mechanism is live in both of its roles: a pilot
 * whose guns are running goes on looting between shots, AND the readout still
 * says "Obeying fleet" rather than "Standing by". Do not delete either half.
 *
 * ⚠ AND THREE RUNGS NOW SIT ABOVE IT THAT ARE NOT FLEET ORDERS AT ALL: the
 * `stop` call, the `destination` trip and the reload. The first two come from
 * chat and are the only place in this ladder where a typed word beats a
 * broadcast; each says why in its own header. The third comes from nobody -- it
 * outranks a target call because obeying one with an empty rack is obeying
 * nothing, which `decideReload`'s header states in full.
 */
export function decideCompanionAction(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory = freshLadderMemory(),
  nowMs: number = Date.now(),
): CompanionDecision {
  const outer = collecting;
  const collector: TraceCollector = { slots: {}, notice: null, say: [] };
  collecting = collector;
  let decision: CompanionDecision;
  try {
    decision = decideAndClear(request, obs, memory, nowMs);
  } finally {
    collecting = outer;
  }
  // ⚠ AFTER THE STEP, ON THE MEMORY THE STEP KEPT, so a `status` the chat fold
  // heard this tick is answered this tick, and no rung's early return can skip
  // the warnings. It issues nothing: what it decides is only what to say.
  const supply = superviseSupply(request, obs, decision.memory, nowMs);
  const say = [...collector.say, ...supply.say];
  // A notice is said once, after whatever the rest of the ladder decided, so it
  // never takes a tick from a rung that had something to issue.
  return {
    ...decision,
    memory: supply.memory,
    ...(collector.notice === null ? {} : { why: `${decision.why} ${collector.notice}` }),
    ...(say.length === 0 ? {} : { say }),
    trace: collector.slots,
  };
}

// ─── The decision trace (companionTrace.ts) ──────────────────────────────────
//
// ⚠ ONE COLLECTOR PER `decideCompanionAction` CALL, WRITTEN BY THE RUNGS AS THEY
// RUN. The step has dozens of early returns, and threading the fragments
// gathered so far through each would touch every one of them. Instead each rung's
// call site notes its fragment here, and `decideCompanionAction` attaches the
// lot once the step returns: a rung that never ran never wrote, so the absent
// fragments say where the tick stopped. It is synchronous and saved/restored
// around the call, so the ladder is still pure from outside and a nested call
// cannot write into its caller's trace. Outside a call, noting is a no-op.

type TraceSlots = { -readonly [K in keyof CompanionTrace]: CompanionTrace[K] };

interface TraceCollector {
  readonly slots: TraceSlots;
  /** A one-tick sentence appended to the tick's readout (the utility give-up). */
  notice: string | null;
  /** Lines to say in local chat this tick (`CompanionDecision.say`), in the order the rungs said them. */
  readonly say: string[];
}

let collecting: TraceCollector | null = null;

function noteTrace<K extends keyof CompanionTrace>(slot: K, fragment: TraceSlots[K]): void {
  if (collecting !== null) {
    collecting.slots[slot] = fragment;
  }
}

/**
 * The `health` slot, FIRST WRITER WINS. Two rungs write it on one tick only when
 * the flee gives up its safe-spot hold and the rejoin beneath it then warps, and
 * the flee's reason is the one that explains the move.
 */
function noteHealth(fragment: HealthTrace): void {
  if (collecting !== null && collecting.slots.health === undefined) {
    collecting.slots.health = fragment;
  }
}

/** Say one line in local chat this tick. See `CompanionDecision.say`. */
function noteSay(line: string): void {
  if (collecting !== null && line !== "") {
    collecting.say.push(line);
  }
}

function noteNotice(sentence: string): void {
  if (collecting !== null && sentence !== "") {
    collecting.notice = collecting.notice === null ? sentence : `${collecting.notice} ${sentence}`;
  }
}

/** `decideCompanionAction` without the trace: the step, then the latches the chosen move ends. */
function decideAndClear(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision {
  const decision = withoutStaleRejoin(decideCompanionStep(request, obs,
    obs.inWarp === true || obs.docked === true
      ? {
          ...clearMovementLatches(memory, null, obs.docked === true ? "docked" : "in-warp"),
          alignmentOrder: null,
          // Docked, every module stopped; a warp took the targets (rung 8a).
          utilities: obs.docked === true ? FRESH_COMPANION_UTILITIES : utilitiesAfterWarp(memory.utilities),
        }
      : memory, nowMs));
  // These movements replace keep-at-range. Once requested, a lost response
  // cannot prove the previous formation is still in force. Keep the new
  // movement's own pending latch, but let formation resume when its job ends.
  if (decision.action.kind === "align") {
    return { ...decision, memory: clearMovementLatches(withoutStaleCloseIn(decision.action, decision.memory), decision.action) };
  }
  if (changesShipMovement(decision.action)) {
    const next = { ...withoutStaleCloseIn(decision.action, decision.memory), alignmentOrder: null };
    return { ...decision, memory: clearMovementLatches(next, decision.action) };
  }
  return decision;
}

/**
 * The standing-movement latches `action` ends: formation's (`withoutIssuedFollow`)
 * and rung 8's (`withoutCombatHold`). `null` is a warp or a dock, which ends both.
 *
 * ⚠ ONLY THE FORMATION ORDER ITSELF KEEPS THE FOLLOW LATCH. This used to exempt
 * every `keepAtRange`, because rung 9 was the only rung that sent one. Rung 8
 * sends one on a RAT: exempted, the latch would still name the commander, rung 9
 * would read "already holding station" after the fight, and the pilot would sit
 * where the fight ended for the rest of the run (plan §5.5; operator: must be
 * fixed). So the exemption is the order rung 9 stamped -- a keep-at-range on
 * `followAnchorID` -- and nothing else.
 *
 * ⚠ AND THE MIRROR IMAGE FOR RUNG 8'S OWN LATCH: every movement it did not send
 * ends its orbit, so its "in position" record goes with it.
 *
 * ⚠ AND THE SAME FOR THE LOOT AND SALVAGE APPROACH LATCHES, WHICH OUTLIVED
 * THEIR JOBS AND LIT THE BURNER FOR A WHOLE FORMATION. Each was cleared only by
 * its own rung (on arrival, or on picking the next wreck), so an approach whose
 * wreck left the grid ended the job (`withAreaJobCleared`) with the latch still
 * set. `holdsFormation` reads either latch as "the FOLLOW is an approach, not
 * the formation", so the formation order rung 9 sent next was read as travel
 * with hostiles on grid, and the afterburner burned for as long as it held. Any
 * movement other than the approach itself replaces it, exactly as `closingOn`
 * is retired by `withoutStaleCloseIn`; the rung re-sends its approach if its
 * job resumes.
 */
function clearMovementLatches(
  memory: CompanionLadderMemory,
  action: FleetCompanionAction | null,
  by: string = action?.kind ?? "in-warp",
): CompanionLadderMemory {
  const formation = action?.kind === "keepAtRange" && action.targetID === memory.followAnchorID;
  const unfollowed = formation ? memory : withoutIssuedFollow(memory);
  const kept = withoutStaleApproaches(unfollowed, action);
  const next = action !== null && isCombatHoldOrder(action, kept) ? kept : withoutCombatHold(kept);
  // The trace's `cleared`: only a latch that was SET and is now gone, and only
  // when something was. A farTicks reset on an idle record is not a dropped hold.
  const follow = unfollowed !== memory;
  const hold = memory.combatPosition.hold !== null && next.combatPosition.hold === null;
  if (follow || hold) {
    noteTrace("cleared", { by, follow, hold });
  }
  return next;
}

// `closingOn` stands for the approach that set it and nothing else. `decideCloseIn`
// reads FOLLOW plus the latch as "our approach is running", and it cannot see
// what the ship follows, so a later order (formation on the commander, say) left
// under it turns a fresh JumpTo into a wait that never ends.
function withoutStaleCloseIn(action: FleetCompanionAction, memory: CompanionLadderMemory): CompanionLadderMemory {
  return memory.closingOn === null || (action.kind === "approach" && action.targetID === memory.closingOn)
    ? memory
    : { ...memory, closingOn: null, closingOnAtMs: null };
}

// The rejoin record stands for the rejoin warp and nothing else. Any other
// movement -- a fleet order, a flee, the formation order on landing -- means
// something else is flying the ship now, so the record and its spent tries go.
function withoutStaleRejoin(decision: CompanionDecision): CompanionDecision {
  const action = decision.action;
  if (decision.memory.rejoin === null || !changesShipMovement(action) ||
    (action.kind === "warpToFleetMember" && decision.phase === REJOIN_PHASE)) {
    return decision;
  }
  return { ...decision, memory: { ...decision.memory, rejoin: null } };
}

/**
 * The loot and salvage approach latches, unless `action` is that approach
 * itself (see `clearMovementLatches`). `null` is a warp or a dock, which ends both.
 */
function withoutStaleApproaches(memory: CompanionLadderMemory, action: FleetCompanionAction | null): CompanionLadderMemory {
  const approaching = (id: number | null): boolean =>
    id !== null && action?.kind === "approach" && action.targetID === id;
  const loot = memory.lootApproaching !== null && !approaching(memory.lootApproaching);
  const salvage = memory.salvageApproachIssued && !approaching(memory.salvageWreckID);
  return !loot && !salvage
    ? memory
    : {
        ...memory,
        ...(loot ? { lootApproaching: null, lootApproachAtMs: null } : {}),
        ...(salvage ? { salvageApproachIssued: false, salvageApproachAtMs: null } : {}),
      };
}

function changesShipMovement(action: FleetCompanionAction): boolean {
  return action.kind === "approach" || action.kind === "align" || action.kind === "warp" ||
    action.kind === "warpToFleetMember" || action.kind === "travelTo" || action.kind === "jumpGate" ||
    action.kind === "dock" || action.kind === "undock" || action.kind === "stopShip" || action.kind === "keepAtRange" ||
    action.kind === "orbit";
}

function withoutIssuedFollow(memory: CompanionLadderMemory): CompanionLadderMemory {
  return memory.followAnchorID === null && memory.followRangeIssuedM === null && memory.followOrder === null
    ? memory
    : { ...memory, followAnchorID: null, followRangeIssuedM: null, followOrder: null };
}

function decideCompanionStep(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision {
  // A readable flight change retires its old order even when a higher rung
  // consumes this tick. An unreadable list says nothing about a recall.
  memory = withObservedDroneFlights(obs, memory);
  // Every tick, warp included: a call heard mid-warp is still the call on landing.
  memory = withHeardGateCall(obs, withHeardTargetCall(obs, memory, nowMs), nowMs);
  // ⚠ ABOVE THE WARP YIELD, because the capsule's run records its own warp as
  // the yield does for the flee, and above supervision, because a pod docks
  // whoever is in the fleet. `true` only: an older BFF omits the field.
  if (obs.flightStatus?.shipIsCapsule === true) {
    return decideShipLost(request, obs, memory, nowMs);
  }
  if (obs.inWarp === true) {
    // The one thing a mid-warp tick still RECORDS. Nothing may be issued here,
    // but this reading is the only confirmation the get-safe step ever gets
    // that its warp actually took — every later tick has left warp by
    // definition, so a tick that discarded it would lose the fact for good.
    // ⚠ BOTH LATCHES, NOT JUST THE ABANDONMENT'S. Rung 5's flee flies the same
    // safe-spot ladder and needs the same confirmation, and this is still the
    // only tick that can give it: every later tick has left warp by definition,
    // so a mid-warp tick that recorded one latch and not the other would leave
    // a fleeing pilot waiting for a warp it had already finished.
    const abandoning = memory.abandonment;
    const fleeing = memory.flee;
    const sawIt = (run: SafetyRun): boolean => run.safeSpotWarpIssued && !run.safeSpotWarpSeen;
    let next = memory;
    if (abandoning !== null && sawIt(abandoning)) {
      next = { ...next, abandonment: { ...abandoning, safeSpotWarpSeen: true } };
    }
    if (fleeing !== null && sawIt(fleeing)) {
      next = { ...next, flee: { ...fleeing, safeSpotWarpSeen: true } };
    }
    // And the rejoin warp's, for the same reason: the tick after this one is the
    // landing, and only this tick can say there was a warp to land from.
    const rejoining = memory.rejoin;
    if (rejoining !== null && !rejoining.seen && rejoining.status !== "refused" && rejoining.status !== "deferred") {
      next = { ...next, rejoin: { ...rejoining, seen: true } };
    }
    // ⚠ AND THE ONE THING A WARP UNLEARNS. "This ship cannot lock that ship" is
    // a fact about where this ship is STANDING, and a warp moves it somewhere
    // else -- so every give-up is dropped here rather than carried onto a grid
    // where it was never measured. See `lockGaveUpOn`. Nothing else in this
    // memory is distance-shaped, which is why nothing else is cleared.
    // The lock-ahead's record goes with it: those ships were ranked on the old
    // grid, and a pending lock is on a ship this one has left behind.
    if (next.lockGaveUpOn.length > 0 || next.lockRefusedFor !== null ||
      next.lockPending !== null || next.preLocked.length > 0) {
      next = { ...next, lockGaveUpOn: [], lockRefusedFor: null, lockRefusals: 0, lockPending: null, preLocked: [] };
    }
    return waiting(
      "In warp",
      "The fleet is warping this ship. Nothing is decided until it lands.",
      next,
    );
  }

  // ⚠ A BLIND SCENE DECIDES NOTHING (seen live 2026-10-14 12:00:11 UTC). With no
  // ship in the scene every fact below it -- hostiles, drones out, the rack, the
  // commander -- is unreadable, and a ladder that ran on it reloaded the guns
  // mid-fight, found no drones to recall, and stood by on "health could not be
  // read" for ten minutes. Below the warp yield (a warp is waiting anyway) and
  // above supervision and every rung that reads the scene. The loop owns the
  // clock: after `FLEET_COMPANION_READ_GRACE_MS` of this it stops the run.
  if (obs.sceneBlind === true) {
    return waiting(
      "Reading space",
      "Cannot see space right now: reading again.",
      memory,
    );
  }

  // ⚠ THE AREA LATCH IS UPDATED BEFORE ANY RUNG DECIDES, and before the
  // supervision gate, so that a `stop` typed while a pilot is getting safe is
  // still heard. It issues nothing; it only records what the last order said.
  //
  // The follow range, the trip and the `stop` gate ride in the same slot for the
  // same reason -- a `stop` has to land whatever the pilot is doing, and this is
  // the only point above every rung that can hear one. Note that all of this
  // sits BELOW the warp yield above: a mid-warp tick decides nothing, and that
  // includes hearing orders, which is unchanged from how an area job behaves.
  memory = withStandingChatOrders(obs, withAreaJobCleared(obs, withAreaJob(obs, memory)));

  const supervisors = supervisorsInFleet(obs);
  if (supervisors === null) {
    // FAIL OPEN, deliberately. A transient roster failure must not dock a live
    // fleet operation and disband it; the run's own deadline (maxRuntimeMinutes,
    // the only thing that ever ends an unattended run) is what bounds a read
    // that stays broken. Note it leaves an abandonment already under way
    // exactly as it is — an unreadable roster is not evidence a human returned.
    return waiting(
      "Checking supervision",
      "Cannot tell who else is in the fleet, so nothing is decided this tick.",
      memory,
    );
  }
  if (supervisors.length === 0) {
    return decideAbandonment(request, obs, memory, nowMs);
  }

  // Supervised. Remember who: the moment they leave is the moment this list
  // becomes the rejoin gate's allowlist, and there is no second chance to
  // collect it. Clear any abandonment, because a human is demonstrably here.
  const supervised: CompanionLadderMemory = {
    standingChatCursor: memory.standingChatCursor,
    alignmentOrder: memory.alignmentOrder,
    healOrder: memory.healOrder,
    lastSupervisorIDs: [...supervisors],
    abandonment: null,
    closingOn: memory.closingOn,
    closingOnAtMs: memory.closingOnAtMs,
    lastTankUpModuleIDs: memory.lastTankUpModuleIDs,
    lastLockIssuedFor: memory.lastLockIssuedFor,
    lastFireTargetID: memory.lastFireTargetID,
    lastFireModuleIDs: memory.lastFireModuleIDs,
    gunAimedAt: memory.gunAimedAt ?? {},
    gunStops: memory.gunStops ?? [],
    targetCall: memory.targetCall ?? null,
    gateCall: memory.gateCall ?? null,
    lastHealTargetID: memory.lastHealTargetID,
    lastHealModuleIDs: memory.lastHealModuleIDs,
    lastRoutedSystemID: memory.lastRoutedSystemID,
    lastTagIssuedFor: memory.lastTagIssuedFor,
    lastTagAttempts: memory.lastTagAttempts,
    taggingGaveUpOn: memory.taggingGaveUpOn,
    tackleCalledOut: memory.tackleCalledOut,
    tackleCalledAtMs: memory.tackleCalledAtMs ?? {},
    lockRefusedFor: memory.lockRefusedFor,
    lockRefusals: memory.lockRefusals,
    lockGaveUpOn: memory.lockGaveUpOn,
    lockPending: memory.lockPending,
    preLocked: memory.preLocked,
    lastDroneRepairTargetID: memory.lastDroneRepairTargetID,
    lastDroneRepairIDs: memory.lastDroneRepairIDs,
    lastDroneEngageTargetID: memory.lastDroneEngageTargetID,
    lastDroneEngageIDs: memory.lastDroneEngageIDs,
    combatDroneOrder: memory.combatDroneOrder,
    repairDroneOrder: memory.repairDroneOrder,
    lastSalvageOrderedFor: memory.lastSalvageOrderedFor,
    salvageDronesWreckID: memory.salvageDronesWreckID,
    lootedItemIDs: memory.lootedItemIDs,
    lootApproaching: memory.lootApproaching,
    lootApproachAtMs: memory.lootApproachAtMs,
    lootTargetID: memory.lootTargetID,
    salvageWreckID: memory.salvageWreckID,
    salvageLockIssued: memory.salvageLockIssued,
    salvageLockWaited: memory.salvageLockWaited,
    salvageApproachIssued: memory.salvageApproachIssued,
    salvageApproachAtMs: memory.salvageApproachAtMs,
    areaJob: memory.areaJob,
    lastWarpedToID: memory.lastWarpedToID,
    orderedLeaveRecall: memory.orderedLeaveRecall,
    droneRotation: memory.droneRotation,
    droneSizeSwitchAtMs: memory.droneSizeSwitchAtMs,
    droneSizeRecalledIDs: memory.droneSizeRecalledIDs,
    droneAssistLit: memory.droneAssistLit,
    jobOverRecall: memory.jobOverRecall,
    droneLaunch: memory.droneLaunch,
    // ⚠ CARRIED, NOT CLEARED, and the difference from `abandonment` above is
    // the whole point. That one is cleared because a human coming back is
    // exactly the thing it was waiting for. A flee is about the ship's health
    // and has nothing to do with who is in the fleet -- clearing it here would
    // mean a supervisor logging back in cancelled a flee mid-warp and left a
    // hurt pilot sitting on the grid it was leaving.
    flee: memory.flee,
    shipLost: memory.shipLost,
    fleeTripsSpent: memory.fleeTripsSpent,
    fleeRecoverySinceMs: memory.fleeRecoverySinceMs,
    // Carried, every one of them. A human turning up says nothing about where
    // this pilot was told to fly or how close to hold: an order given while the
    // fleet was unsupervised was still given, and a `stop` typed a moment before
    // a supervisor logged back in must not be un-said by their arrival.
    followRangeM: memory.followRangeM,
    followHeld: memory.followHeld,
    followAnchorID: memory.followAnchorID,
    followRangeIssuedM: memory.followRangeIssuedM,
    followOrder: memory.followOrder,
    // Carried, and dropped the moment the commander is on this grid: the rejoin
    // has done its job, so its spent tries must not count against the next one.
    rejoin: memory.rejoin === null || COMBAT_POSITION_LADDER.commanderShip(obs) === null ? memory.rejoin : null,
    destinationSystemID: memory.destinationSystemID,
    destinationRoutedFor: memory.destinationRoutedFor,
    stopHeardAtMs: memory.stopHeardAtMs,
    stopShipIssued: memory.stopShipIssued,
    propsHeld: memory.propsHeld,
    propsStoppingID: memory.propsStoppingID,
    targetMode: memory.targetMode,
    flightMode: memory.flightMode,
    // The positioning record is carried like the follow latch beside it: a human
    // arriving moves nothing, so whatever orbit was standing is still standing.
    combatPosition: memory.combatPosition,
    weaponReach: memory.weaponReach,
    // Carried for the same reason as the orders above: a supervisor logging
    // back in says nothing about which of this ship's guns are empty or how
    // many loads have already been spent on them.
    reloadAttempts: memory.reloadAttempts,
    reloadInFlight: memory.reloadInFlight,
    // Carried: a human arriving switches nothing off.
    utilities: memory.utilities,
    ammo: memory.ammo,
    // Carried: an order heard and what the ship has left are not about who is here.
    repairOrderedAtMs: memory.repairOrderedAtMs,
    supply: memory.supply,
  };

  // Rung 3: tank up. Threaded even when it has nothing to do this tick —
  // `tankedUp.memory` may have forgotten a finished stand-down record on a
  // tick that issued no action, and dropping it here would lose that the same
  // way skipping `stand.memory` would in `scriptDecide.ts`'s own equivalent.
  const tankedUp = decideTankUp(request, obs, supervised);
  if (tankedUp.decision !== null) {
    return tankedUp.decision;
  }

  // Rung 3b: the prop mod. Directly under tank-up because it is the same KIND of
  // move -- one call, self-targeted, instant, and a rung that falls through the
  // moment the rack matches what is wanted -- so it costs the rungs below it a
  // tick or two after a trip starts or ends and nothing the rest of the time.
  //
  // ⚠ ABOVE THE FLEET RUNG SO A STANDING TARGET CALL CANNOT SWALLOW `props on`.
  // A commander who types it while the fleet is holding a primary means it now;
  // below rung 7 it would land whenever the call happened to lapse.
  //
  // ⚠ BELOW THE FLEE, WHICH IS WHY THE FLEE TURNS IT OFF. Rung 5 does not fly
  // through the shared autopilot, so `obs.travel` reads as "not travelling" for
  // the whole flee and this rung stands the burner down. That is the asked-for
  // behaviour ("when they travel") and `decidePropulsion`'s header records the
  // cost and the escape hatch.
  //
  // Threaded like rung 3: the tick that merely CLEARS a spent stopping latch
  // issues no action, and a call site taking only the decision would drop it and
  // re-issue the same deactivate for ever.
  const burning = decidePropulsion(request, obs, tankedUp.memory);
  noteTrace("props", burning.trace);
  if (burning.decision !== null) {
    return burning.decision;
  }

  // Rung 4: tackle → tag. ABOVE obeying the fleet, and that placement is the
  // whole reason this rung works — see `decideTackleTag`'s own header. Threaded
  // the way rung 3 is, and for the same reason: the tick that GIVES UP on a
  // ship issues no action, so a call site that only took the decision would
  // throw the give-up away and re-pick the same ship for ever.
  const tagging = decideTackleTag(request, obs, burning.memory, nowMs);
  if (tagging.decision !== null) {
    return tagging.decision;
  }

  // Rung 5: flee. Above the drone rung and BELOW tank-up and tackle-tag, so a
  // ship running away still hardens and still letters what is holding it -- see
  // this rung's own header for why that placement does the spec's "nest tank-up
  // inside the flee continuation" without any nesting, and for the operator
  // decision that put it above the fleet rung at all.
  //
  // Threaded like rung 3: the tick that UNWINDS a flee it cannot fly issues no
  // action, and a call site that took only the decision would throw that away
  // and re-latch the same doomed flee for ever.
  const fleeing = decideFlee(request, obs, tagging.memory, nowMs);
  if (fleeing.decision !== null) {
    return fleeing.decision;
  }

  // Rung 5b: get out of the station.
  //
  // ⚠ THE LADDER COULD NOT UNDOCK A PILOT AT ALL UNLESS IT WAS MID-FLEE, AND
  // NOBODY NOTICED BECAUSE THE FLEE ALWAYS WAS. The one `undock` this loop has
  // ever issued lives in `recoverAndReturn`, which only runs while a flee latch
  // is standing — so a companion that was docked for any other reason (started
  // in a station, stopped and restarted while parked, docked by its operator)
  // sat there for the rest of the run with every rung beneath it reading an
  // empty grid and deciding nothing. The settings panel has been promising the
  // opposite in writing the whole time: "It will undock when the fleet gives it
  // something to do" (`fleetCompanionRequirements.ts`, which is why a docked
  // start is advisory rather than blocking). This rung is that sentence.
  //
  // ⚠ IT SITS BELOW THE FLEE ON PURPOSE, so every deliberate reason to STAY in
  // a station still wins: a pilot waiting on repairs, one whose operator will
  // not pay for them, one that has spent its round trips, and the abandonment
  // protocol above all of them, each hold the tick before it reaches here. What
  // is left when it does reach here is a docked ship with nothing keeping it
  // docked and a fleet somewhere else.
  const leaving = decideLeaveTheStation(obs, fleeing.memory);
  if (leaving !== null) {
    return leaving;
  }

  // Rung 6: drones. Above the fleet rung, like tank-up and tackle-tag and for
  // the same reason: it moves nothing, costs one call, and a pilot does not
  // stop obeying its commander to keep its drones alive. Threaded like rung 3
  // because most of what it does - waiting out a recall, counting down a
  // hold-off - happens on ticks that issue NO action at all.
  //
  // ⚠ STOOD DOWN WHILE A FLEET ORDER TO LEAVE IS CALLING THE DRONES HOME. This
  // rung runs before rung 7, so without this it would relaunch or re-engage the
  // very drones rung 7 is waiting to scoop. See `recallBeforeLeavingOnOrder`.
  const drones = droneRungStoodDown(fleeing.memory, nowMs)
    ? { decision: null, memory: fleeing.memory }
    : decideDrones(request, obs, fleeing.memory, nowMs);
  if (drones.decision !== null) {
    return drones.decision;
  }

  // The `stop` order's one CALL. Everything else `stop` does was done above the
  // supervision gate, where bookkeeping belongs; this is the half that has to
  // come through the ladder because it spends the tick's one atomic call.
  //
  // ⚠ ABOVE RUNG 7 SO A STANDING TARGET CALL CANNOT SWALLOW IT. "Stop" that
  // waits for the fleet to go quiet is not a stop. It stays below the flee and
  // the tank for the same reason the trip below it does: a pilot that is dying
  // leaves first and stops afterwards.
  const stopping = decideStopShip(drones.memory);
  if (stopping !== null) {
    return stopping;
  }

  // The `destination` trip -- ABOVE rung 7, and the only rung in this ladder
  // that outranks the fleet's own calls. See `decideDestinationTrip`'s header
  // for the operator's sentence this implements and for the exact reading of it.
  // Threaded like rung 3 because arriving issues nothing.
  const travelling = decideDestinationTrip(obs, drones.memory);
  if (travelling.decision !== null) {
    return travelling.decision;
  }

  // The reload rung -- ABOVE rung 7 because an empty gun makes rung 7's whole
  // fire path a no-op, and BELOW the flee and the tank because a reload is
  // worthless on a ship that is about to be wreckage. See `decideReload`'s own
  // header for the server fact that makes this rung necessary at all. Threaded
  // like rung 3 because CONFIRMING a load -- a gun leaving the empty list --
  // issues nothing.
  const reloading = decideReload(obs, travelling.memory, nowMs);
  if (reloading.decision !== null && reloading.decision.standing !== true) {
    return reloading.decision;
  }

  // Rung 7: obeying the fleet.
  //
  // ⚠ A STANDING ORDER IS HELD ASIDE, NOT RETURNED. When this rung has a real
  // call to issue it wins outright, exactly as the precedence says. But when it
  // is merely CONTINUING to obey -- target locked, guns already running, nothing
  // new this tick -- it hands back a `standing` decision, and that one is kept
  // as a READOUT while the ladder goes on. Before this, that case returned an
  // ordinary wait and ended the tick, so a standing target call starved every
  // rung beneath it for as long as it stood. See `CompanionDecision.standing`.
  let obeying = recallBeforeLeavingOnOrder(
    decideFleetOrders(request, obs, reloading.memory, nowMs),
    request,
    obs,
    reloading.memory,
    nowMs,
  );
  if (obeying !== null && obeying.standing !== true) {
    return obeying;
  }

  // Rung 7b: the lock-ahead. Only while the pilot stands on a target -- its
  // lock pending or its guns running -- and before the loot and salvage rungs,
  // because the next kill outranks a wreck. See `decideLockAhead`.
  if (obeying !== null && obeying.engagedTargetID !== undefined) {
    const ahead = decideLockAhead(obs, obeying.memory, obeying.engagedTargetID, nowMs);
    if (ahead !== null) {
      return {
        action: { kind: "lock", targetID: ahead.targetID },
        phase: obeying.phase,
        why: "Locking the next one up while this one dies.",
        memory: ahead.memory,
        ...(obeying.followingOrderFrom === undefined ? {} : { followingOrderFrom: obeying.followingOrderFrom }),
        ...(obeying.lastOrderHeard === undefined ? {} : { lastOrderHeard: obeying.lastOrderHeard }),
        preLock: true,
      };
    }
    // Rung 7c: ammo by target for the LOADED guns, here because the engaged
    // target is rung 7's answer and the reload rung sits above it. See
    // companionAmmo.ts.
    const ammo = decideAmmoSwap(request, obs, obeying.memory, obeying.engagedTargetID, nowMs, AMMO_LADDER);
    noteTrace("ammo", ammo.trace);
    if (ammo.swap !== null) {
      return {
        action: { kind: "loadAmmo", moduleIDs: ammo.swap.moduleIDs, chargeItemID: ammo.swap.chargeItemID },
        phase: obeying.phase,
        why: ammo.swap.why,
        memory: ammo.memory,
        ...(obeying.followingOrderFrom === undefined ? {} : { followingOrderFrom: obeying.followingOrderFrom }),
        ...(obeying.lastOrderHeard === undefined ? {} : { lastOrderHeard: obeying.lastOrderHeard }),
      };
    }
    obeying = { ...obeying, memory: ammo.memory };
  } else {
    // Rung 7 stands on no target, so the ammo step is not asked; the trace says so.
    noteTrace("ammo", ammoSkipTrace("not-engaged"));
  }

  // Rung 8b: the `loot` order.
  //
  // ⚠ IT SITS HERE, AT THE VERY BOTTOM, BECAUSE IT MOVES THE SHIP. Every other
  // thing this loop does is fired from where the pilot already is, or is a move
  // somebody else ordered; looting approaches each wreck in turn and will drift
  // a companion off formation. Beneath the fleet-order rung means a target call,
  // a rep call, an align or a fleet warp all interrupt it -- and being beneath
  // the flee and the supervision gate as well means a pilot that is dying stops
  // looting without anybody having to say so.
  //
  // ⚠ AND IT IS BENEATH THE *STANDING* ORDER CHECK BELOW ON PURPOSE. That is the
  // slot `CompanionDecision.standing` was built for in phase 5 and which has had
  // no consumer since the flee moved above the fleet rung: a pilot whose guns are
  // already running on a called target should go on looting between shots rather
  // than reporting "Standing by" and doing nothing.
  //
  // Rung 8 runs first, though: `flight auto` combat positioning (plan §5.4,
  // `decideCombatPosition` in companionCombatPosition.ts), after the lock-ahead
  // because the next kill's lock costs nothing, and above the loot and salvage
  // rungs because a fight outranks a wreck. A readout it returns replaces the
  // standing order and HOLDS NAVIGATION, so the two rungs below may work from
  // where the ship is but may not move it. A fight that has ended drops its
  // record, which is why its memory flows on even when it decides nothing.
  let lowerMemory = obeying?.memory ?? reloading.memory;
  const engagedID = obeying?.engagedTargetID ?? null;
  const positioned = decideCombatPosition(request, obs, obeying, lowerMemory, COMBAT_POSITION_LADDER);
  noteTrace("combat", positioned.trace);
  lowerMemory = positioned.memory;
  if (positioned.decision !== null && positioned.decision.standing !== true) {
    return positioned.decision;
  }
  obeying = positioned.decision ?? obeying;

  // Rung 8a: the combat utility modules (companionUtilities.ts). Webs and
  // painters on the engaged target, the self-buffs while a fight is on, each off
  // again when its job ends -- one call, no movement, so below the positioning
  // order (which may need to bring the target into optimal first) and above the
  // wreck work. Threaded: settling a stopped module issues nothing. The flee and
  // the abandonment protocol return above, so a pilot leaving never gets here.
  const utility = decideUtilityRung(request, obs, engagedID, lowerMemory, nowMs);
  noteTrace("util", utility.trace);
  lowerMemory = utility.memory;
  // A `why` with no call is the give-up notice ("Could not switch ... off"): said
  // once, appended to whatever the rungs below decide, so it starves none of them.
  if (utility.call === null) {
    noteNotice(utility.why);
  }
  if (utility.call !== null) {
    return {
      action: utility.call,
      phase: obeying?.phase ?? "Combat utilities",
      why: utility.why,
      memory: lowerMemory,
      ...(obeying?.followingOrderFrom === undefined ? {} : { followingOrderFrom: obeying.followingOrderFrom }),
      ...(obeying?.lastOrderHeard === undefined ? {} : { lastOrderHeard: obeying.lastOrderHeard }),
    };
  }
  obeying = obeying === null ? null : { ...obeying, memory: lowerMemory };

  // Rung 8c: a clear grid reloads every gun (operator, 2026-10-14; see "A clear
  // grid" in companionAmmo.ts). BELOW rung 7 and everything that fights or
  // positions, because a reload silences a gun for seconds and a fleet order
  // that moves the ship outranks it; ABOVE the wreck work and the follow,
  // because it moves nothing and costs one call per charge type per clear. Not
  // while rung 7 stands on a target: a called target is a fight, whatever the
  // NPC count says.
  const toppingUp = decideClearGridTopUp(request, obs, lowerMemory, gridSeenClear(obs) && engagedID === null);
  lowerMemory = toppingUp.memory;
  obeying = obeying === null ? null : { ...obeying, memory: lowerMemory };
  if (toppingUp.load !== null) {
    return {
      action: { kind: "loadAmmo", moduleIDs: toppingUp.load.moduleIDs, chargeItemID: toppingUp.load.chargeItemID },
      phase: obeying?.phase ?? "Reloading",
      why: toppingUp.load.why,
      memory: lowerMemory,
      ...(obeying?.followingOrderFrom === undefined ? {} : { followingOrderFrom: obeying.followingOrderFrom }),
      ...(obeying?.lastOrderHeard === undefined ? {} : { lastOrderHeard: obeying.lastOrderHeard }),
    };
  }

  const salvaging = decideSalvaging(request, obs, lowerMemory, nowMs);
  if (salvaging !== null && !(obeying?.holdsNavigation === true && changesShipMovement(salvaging.action))) {
    return salvaging;
  }

  const looting = decideLooting(obs, lowerMemory, nowMs);
  if (looting !== null && !(obeying?.holdsNavigation === true && changesShipMovement(looting.action))) {
    return looting;
  }

  // The standing order, if there was one and nothing beneath it acted. The
  // pilot IS obeying the fleet, so it says so rather than "Standing by".
  if (obeying !== null) {
    return obeying;
  }

  // Rung 9: the standing `follow`. The last rung before "Standing by", BENEATH
  // even the standing-order readout -- see `decideFollow`'s header for why a
  // rung that moves the ship for ever belongs at the very bottom, and for what
  // being beneath the readout costs.
  const following = decideFollow(obs, lowerMemory);
  if (following !== null) {
    return following;
  }
  // Rung 9b: the commander is in the fleet but not on this grid, and nothing
  // above had anything to do, so go to it. See `decideRejoinCommander` for the
  // live sighting this ends -- the flee's return leg stopping at the undock.
  //
  // ⚠ ITS "STANDING BY" READOUTS SIT BENEATH THE DRY-GUNS ONE. They issue
  // nothing, so they may only say why a pilot is idle when nothing truer is
  // already being said; their memory (a back-off counting down) still flows.
  const rejoining = decideRejoinCommander(request, obs, lowerMemory, nowMs);
  const rejoinIsReadout = rejoining !== null && rejoining.action.kind === "wait" && rejoining.phase === "Standing by";
  if (rejoining !== null && !rejoinIsReadout) {
    return rejoining;
  }
  // ⚠ THE DRY-GUNS READOUT COMES LAST, BENEATH EVEN THE FOLLOW, THOUGH ITS RUNG
  // SITS HIGH. It is a sentence and never a call, so anything above it here
  // would be a readout SUPPRESSING a rung that has something real to issue --
  // put ahead of `decideFollow` it would stop a companion re-anchoring for as
  // long as its guns were dry. Beneath everything it can only ever replace
  // "Standing by", which is exactly what it is for: a pilot standing there doing
  // nothing should say why.
  if (reloading.decision !== null) {
    return { ...reloading.decision, memory: rejoining?.memory ?? lowerMemory };
  }
  if (rejoining !== null) {
    return rejoining;
  }
  return waiting(
    "Standing by",
    "No fleet order to obey right now, nothing to loot, nothing hostile to put drones on, and no commander on this grid to hold station off.",
    lowerMemory,
  );
}

/**
 * The abandonment protocol (decision 5): get safe, then disband, then wait.
 *
 * ⚠ THE ORDER IS LOAD-BEARING. Safe FIRST, then leave. Leaving first gives up
 * the fleet-warp channel while the ship is still sitting in space.
 */
function decideAbandonment(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision {
  const running: CompanionAbandonment = memory.abandonment ?? {
    abandonedAtMs: nowMs,
    // The last tick that PASSED the check is where the humans were. At this
    // tick there are none by definition, so the allowlist can only ever be
    // remembered forward — it cannot be read now.
    supervisorCharacterIDs: [...memory.lastSupervisorIDs],
    safeSpotWarpIssued: false,
    safeSpotWarpAttempts: 0,
    safeSpotWarpWaited: 0,
    droneRecallWaited: null,
    safeSpotWarpSeen: false,
  };
  const mem: CompanionLadderMemory = { ...memory, abandonment: running };
  const remainingMs = FLEET_COMPANION_ABANDONMENT_WAIT_MS - (nowMs - running.abandonedAtMs);

  // 1. The bound, checked FIRST — ahead even of a waiting invite. A rejoin
  //    accepted past the deadline would be a bounded wait extended by another
  //    bounded wait, which is exactly the unbounded life the persisted clock
  //    exists to prevent. A companion out of time stops; a human who still
  //    wants it can start it again.
  if (remainingMs <= 0) {
    return {
      action: WAIT,
      phase: "Abandoned",
      why: "Nobody came back within the wait, so this pilot is releasing the ship.",
      memory: mem,
      stop: "No fleet member this host is not flying, for thirty minutes. Released the ship.",
    };
  }

  // 2. Get safe.
  if (!reachedSafety(obs, running)) {
    const safe = runToSafety(request, obs, mem, {
      run: running,
      phase: "Getting safe",
      because: "there is nobody left in the fleet to fly with",
      write: (m, run) => ({ ...m, abandonment: { ...running, ...run } }),
    }, nowMs);
    if (safe !== null) {
      return safe;
    }
    // Nowhere to go, which for THIS caller is the end of the protocol: a pilot
    // with nobody to fly with and no way off this grid has nothing further to
    // try, and decision 5 says so rather than inventing a destination.
    return {
      action: WAIT,
      phase: "Getting safe",
      why: "No station in view and no safe spot set.",
      memory: mem,
      stop: "Nobody is left in the fleet, and there is no station in view and no safe spot set for this pilot.",
    };
  }

  // 3. Drop fleet — each companion for itself. "All pilots drop fleet" is the
  //    emergent effect of every one of them running this rung, never a
  //    broadcast and never one pilot acting for another.
  if (obs.inFleet === true) {
    return {
      action: { kind: "leaveFleet" },
      phase: "Abandoned",
      why: "Safe, and nobody is left to fly with, so this pilot is leaving the fleet.",
      memory: mem,
    };
  }

  // 4. Wait, and take a way back only from someone who was actually here.
  const invite = obs.pendingFleetInvite;
  if (
    obs.inFleet === false &&
    invite !== null &&
    invite.inviterID !== null &&
    running.supervisorCharacterIDs.includes(invite.inviterID)
  ) {
    return {
      action: { kind: "acceptFleetInvite", fleetID: invite.fleetID },
      phase: "Abandoned",
      why: "A pilot who was in the fleet before is inviting this one back.",
      memory: mem,
    };
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  return waiting(
    "Abandoned",
    invite === null
      ? "Waiting " + minutes + " more minute(s) for someone to come back."
      : "Ignoring an invite from a pilot who was not in the fleet. Waiting " +
          minutes +
          " more minute(s).",
    mem,
  );
}

/**
 * Whether the ship has got where the protocol was taking it.
 *
 * Callers reach this only BELOW rung 1, so `inWarp` is already known not to be
 * true — which is what makes "the warp was seen, and it is over" a safe read of
 * having arrived rather than of having merely been issued.
 */
function reachedSafety(obs: FleetCompanionObservation, running: SafetyRun): boolean {
  if (obs.docked === true) {
    return true;
  }
  if (running.safeSpotWarpIssued && running.safeSpotWarpSeen) {
    return true;
  }
  // ⚠ THE WARP NOBODY SAW. `safeSpotWarpSeen` is set only by a tick that lands
  // mid-warp, and a server stall can swallow every tick of a short warp: the
  // ship arrives at the sun and the latch never flips. Where the ship now IS
  // is a reading too, and the one that cannot be stale in that direction.
  return running.safeSpotWarpIssued && atTheSun(obs);
}

/**
 * How far from the sun's SURFACE a ship that warped to it can be and still be
 * "there". The server lands a sun warp at its radius plus 5,000 km
 * (`getWarpStopDistanceForTarget`, warpState.js), so this is that landing
 * distance with room for drift. A ship that started anywhere it could have
 * needed rescuing from is astronomical units away, so the margin cannot be
 * mistaken for a ship that never left.
 */
const SUN_ARRIVAL_SURFACE_M = 10_000_000;

/** Is the ship sitting where a warp to this system's sun lands? */
function atTheSun(obs: FleetCompanionObservation): boolean {
  const sun = sunOnGrid(obs);
  if (sun === null) return false;
  const distance = measureSpace(obs.snapshot ?? null)?.distances.get(sun);
  return distance !== undefined && distance <= SUN_ARRIVAL_SURFACE_M;
}

/**
 * The bookkeeping a run to safety needs, wherever it happens to live on the
 * ladder memory.
 *
 * TWO RUNGS RUN THIS SAME LADDER FOR DIFFERENT REASONS — rung 2 because there
 * is nobody left to fly with, rung 5 because the ship is hurt — and they want
 * identical flying and different words. This is the seam that lets them share
 * one implementation instead of keeping two copies that drift.
 *
 * `CompanionAbandonment` and `CompanionFlee` both satisfy it structurally, so
 * neither had to be reshaped to fit.
 */
interface SafetyRun {
  readonly safeSpotWarpIssued: boolean;
  readonly safeSpotWarpSeen: boolean;
  readonly safeSpotWarpAttempts: number;
  readonly safeSpotWarpWaited: number;
  readonly droneRecallWaited: number | null;
  /**
   * Ticks left before the escape warp is tried again after it was refused
   * repeatedly, or absent. See `COMPANION_ESCAPE_RETRY_BACKOFF_TICKS`.
   */
  readonly safeSpotWarpBackoff?: number;
}

/**
 * One caller's half of the arrangement: its own state, its own readout, and
 * the way back to wherever that state is kept.
 */
interface SafetyLeg {
  readonly run: SafetyRun;
  /** The phase this leg reports while it flies. */
  readonly phase: string;
  /**
   * The tail of "Docking, because ..." — the single sentence that differs
   * between the two callers, kept as a fragment so the rest of the readout can
   * be written once.
   */
  readonly because: string;
  /** Put an updated run back where this caller keeps it. */
  readonly write: (mem: CompanionLadderMemory, run: SafetyRun) => CompanionLadderMemory;
  /**
   * A station or nothing: no warp to the sun. An ordered repair's leg, which has
   * no use for a safe spot (`CompanionFlee.ordered`). With no station in view
   * `runToSafety` answers null, "nowhere to go", exactly as for no sun.
   */
  readonly stationOnly?: true;
}

/**
 * How long a run to safety waits for its recall before leaving anyway.
 *
 * Shorter than rung 6's own wait on purpose. That one is a pilot choosing to
 * spend time on its drones during a fight it is still in; this one is a pilot
 * with nobody left to fly with, which is the situation the whole abandonment
 * protocol exists to end quickly. Drones are worth a few seconds and are not
 * worth the ship.
 */
const MAX_GET_SAFE_RECALL_WAIT_TICKS = 8;
const MAX_GET_SAFE_WARP_ATTEMPTS = 3;
// At the idle cadence this allows two minutes for a slow-aligning hull.
// Expiry sends the warp again; elapsed time is never evidence that the ship got
// safe, and it is not evidence that the ship is stuck either.
const MAX_GET_SAFE_WARP_WAIT_TICKS = 60;
/**
 * Ticks to wait after the escape warp was refused `MAX_GET_SAFE_WARP_ATTEMPTS`
 * times before the attempts start over.
 *
 * ⚠ SHORT, BECAUSE THIS IS THE ESCAPE. It used to pause "for the operator",
 * which left a hurt or abandoned ship sitting exactly where the danger was
 * until a human noticed. A warp refused for a reason that passes -- a scram
 * that drops, a session change that settles -- is worth trying again within
 * seconds; one that never passes costs one call every few seconds.
 */
export const COMPANION_ESCAPE_RETRY_BACKOFF_TICKS = 5;

/**
 * How long a fleet order to leave the grid waits for the drones it called home
 * while something hostile has this ship locked.
 *
 * ⚠ CHOSEN BY THE OPERATOR, 2026-10-10. Rung 7 used to obey a `WarpTo` the tick
 * it heard it, drones and all: three companions warped to a station within two
 * seconds of the call and left fifteen Hobgoblins on a hostile grid, where every
 * one of them was killed. The answer asked for was "recall, short wait": call
 * them home, leave when they are scooped or this has passed, whichever is first,
 * and leave at once, abandoning them, if the ship is already below its flee
 * floor.
 *
 * ⚠ AND ONLY UNDER FIRE, SINCE 2026-10-12. Eight seconds is not long enough for
 * medium or heavy drones fighting 15-20 km out to fly home, so the short wait
 * kept costing drones on grids where nothing was shooting the ship at all. The
 * operator's rule now: wait for the drones "unless ship is under fire". Under
 * fire is a hostile having this ship locked (`lockedByHostile`); then this
 * short wait stands. Otherwise the wait is `ORDERED_LEAVE_CALM_RECALL_MS`.
 */
const ORDERED_LEAVE_RECALL_MS = 8000;
/**
 * The wait for the drones when nothing hostile has this ship locked.
 *
 * ⚠ A BOUND, NOT A TARGET: the warp goes the tick the last drone is aboard. It
 * is there for the drone that never comes home -- a full bay is refused in
 * silence (see `DRONE_RECALL_GIVE_UP_MS`) -- and a fleet that has left this
 * pilot behind for a minute has waited long enough. A heavy drone at its
 * control range is home well inside it.
 */
const ORDERED_LEAVE_CALM_RECALL_MS = 60_000;
/** How long after the order has gone out the drone rung stays down, so it does not launch into the align. */
const ORDERED_LEAVE_SETTLE_MS = 5000;

/** The fleet-order actions that take the ship off this grid. */
const LEAVING_ACTIONS: ReadonlySet<FleetCompanionAction["kind"]> = new Set([
  "warp",
  "warpToFleetMember",
  "travelTo",
  "jumpGate",
]);

/** Whether rung 6 stands aside this tick for a fleet order's recall; see `recallBeforeLeavingOnOrder`. */
function droneRungStoodDown(memory: CompanionLadderMemory, nowMs: number): boolean {
  const recall = memory.orderedLeaveRecall;
  if (recall === null) {
    return false;
  }
  return recall.leftAtMs === null
    ? nowMs - recall.startedMs < ORDERED_LEAVE_CALM_RECALL_MS + ORDERED_LEAVE_SETTLE_MS
    : nowMs - recall.leftAtMs < ORDERED_LEAVE_SETTLE_MS;
}

/**
 * Whether something hostile has this ship locked, or null when nobody can say.
 *
 * Hostile is anything that is not a fleet-mate's ship: an NPC, a player outside
 * the fleet, or a ship that is not on the grid this tick to be told apart --
 * the safe direction, since the cost of reading a locker as hostile is only the
 * short wait the operator chose in the first place. A fleet-mate's lock (a
 * logistics ship repairing this one) is not fire.
 */
function lockedByHostile(obs: FleetCompanionObservation): boolean | null {
  const lockers = obs.lockedByIDs;
  if (lockers == null) {
    return null;
  }
  const fleet = new Set(obs.fleetMemberCharacterIDs ?? []);
  const entities = obs.snapshot?.entities ?? [];
  return lockers.some((id) => {
    const entity = entities.find((candidate) => candidate.itemID === id);
    if (entity === undefined || entity.isNpc) {
      return true;
    }
    return entity.characterID === null || !fleet.has(entity.characterID);
  });
}

/**
 * Rung 7's decision, held back while this ship's drones come home when it would
 * take the ship off the grid. See ORDERED_LEAVE_RECALL_MS for the rule and why.
 *
 * ⚠ THE HELD TICK KEEPS THE MEMORY RUNG 7 STARTED FROM, NOT THE ONE IT RETURNED.
 * Rung 7 stamps an order as answered when it issues it (`lastWarpedToID`,
 * `lastRoutedSystemID`); keeping that stamp on a tick that did NOT warp would
 * have the order heard as done and never obeyed.
 */
function recallBeforeLeavingOnOrder(
  decision: CompanionDecision | null,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision | null {
  if (decision === null || !LEAVING_ACTIONS.has(decision.action.kind)) {
    return decision;
  }
  const pending = memory.orderedLeaveRecall;
  // ⚠ JUST LEFT: GO AGAIN, DO NOT RECALL AGAIN. Some leaving orders are re-issued
  // every tick until the ship is seen in warp (the gate warp has no stamp), and a
  // timed-out wait leaves the drones out, so without this every re-issue would
  // start a new recall and the pilot would never leave.
  if (pending !== null && pending.leftAtMs !== null && nowMs - pending.leftAtMs < ORDERED_LEAVE_SETTLE_MS) {
    return { ...decision, memory: { ...decision.memory, orderedLeaveRecall: pending } };
  }
  const go = (): CompanionDecision => ({
    ...decision,
    memory: { ...decision.memory, orderedLeaveRecall: { startedMs: pending?.startedMs ?? nowMs, leftAtMs: nowMs } },
  });
  const out = obs.myDroneIDs ?? [];
  // Nothing out (or every one scooped): leave. An absent read is "nothing out", as in `recallBeforeLeaving`.
  if (out.length === 0) {
    return go();
  }
  // A ship already below its flee floor does not wait for its drones.
  const health = tankHealth(request, obs);
  if (health !== null && health < request.fleeHealthFloor) {
    return go();
  }
  if (pending === null || pending.leftAtMs !== null) {
    return {
      action: { kind: "recallDrones", droneIDs: out },
      phase: decision.phase,
      why: "Calling the drones home before obeying the fleet's order to leave.",
      memory: { ...memory, orderedLeaveRecall: { startedMs: nowMs, leftAtMs: null } },
      followingOrderFrom: decision.followingOrderFrom,
      lastOrderHeard: decision.lastOrderHeard,
    };
  }
  const waited = nowMs - pending.startedMs;
  // Under fire, or unable to tell: the operator's short wait. `null` keeps the
  // rule this had before the lock list was read, never a longer one on a guess.
  const underFire = lockedByHostile(obs) !== false;
  if (waited >= (underFire ? ORDERED_LEAVE_RECALL_MS : ORDERED_LEAVE_CALM_RECALL_MS)) {
    return go();
  }
  return {
    action: WAIT,
    phase: decision.phase,
    why: underFire
      ? "Waiting for the drones to come home before obeying the fleet's order to leave."
      : "Nothing has this ship locked. Waiting for every drone to come home before obeying the fleet's order to leave.",
    memory,
    followingOrderFrom: decision.followingOrderFrom,
    lastOrderHeard: decision.lastOrderHeard,
  };
}

/**
 * The recall the get-safe ladder makes before it warps, or null when there is
 * nothing to wait for and it may leave.
 *
 * Returns null in three different situations that must not be conflated:
 * nothing is out, the recall has finished, or the wait has been given up on.
 * All three mean the same thing to the caller -- go -- and none of them is an
 * error. A fourth joins them: the tank is done (`abandonDronesHealthFloor`).
 */
function recallBeforeLeaving(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  leg: SafetyLeg,
): CompanionDecision | null {
  const out = obs.myDroneIDs ?? [];
  if (out.length === 0) {
    // Nothing of this ship's is in space. ⚠ This is also the only honest answer
    // when the read is simply absent: a host that does not wire `myDroneIDs` up
    // gets the behaviour it had before this existed, rather than a pilot that
    // refuses to leave over drones nobody can see.
    return null;
  }
  // ⚠ THE TANK IS DONE: GO NOW, AND SEND NO RECALL. Asked before the recall and
  // on every tick of the wait, so a ship still losing health while it waits
  // stops waiting the tick it crosses. Unreadable health is not "done": it
  // keeps the bounded wait, as it did before this existed.
  const health = tankHealth(request, obs);
  if (health !== null && health < abandonDronesFloor(request)) {
    return null;
  }
  const waited = leg.run.droneRecallWaited;
  if (waited === null) {
    return {
      action: { kind: "recallDrones", droneIDs: out },
      phase: leg.phase,
      why: "Calling the drones in before leaving, so they are not left behind.",
      memory: leg.write(mem, { ...leg.run, droneRecallWaited: 0 }),
    };
  }
  if (waited >= MAX_GET_SAFE_RECALL_WAIT_TICKS) {
    // ⚠ GIVE UP AND GO. A recall that has not completed by now is most likely
    // one the server refused in silence for a full bay, and no amount of
    // further waiting fixes that. Leaving costs the drones; staying risks the
    // ship, and the ship is what the protocol is for.
    return null;
  }
  return waiting(
    leg.phase,
    "Waiting for the drones to come home before leaving.",
    leg.write(mem, { ...leg.run, droneRecallWaited: waited + 1 }),
  );
}

/**
 * The ladder that gets a ship out of here: recall what is in space, then the
 * nearest dock on grid, then the operator's safe spot.
 *
 * ⚠ RETURNS null FOR "NOWHERE TO GO", and that is the one thing the two
 * callers must answer differently. A pilot with nobody left to fly with and no
 * station in view has nothing else to try and stops (decision 5). A pilot that
 * is merely HURT still has a fight to be in, and stopping the run over a grid
 * with no station would take a shooting ship away from a fleet that still has
 * one. So the branch is left to the caller rather than decided here.
 */
function runToSafety(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  leg: SafetyLeg,
  nowMs: number,
): CompanionDecision | null {
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return waiting(leg.phase, "Waiting for the ship to be out in space.", mem);
  }
  // ⚠ RECALL BEFORE COMMITTING TO LEAVE. Every branch below that WARPS is a
  // point of no return for anything still in space: the server abandons every
  // controlled drone on a normal departure and does not try to recover them,
  // and an abandoned drone can be scooped by anyone on grid. See
  // `droneRecallWaited`. Docking and approaching are not departures and are
  // left alone -- a dock is the destination, and the recall happens before the
  // warp that reaches it.
  const recall = recallBeforeLeaving(request, obs, mem, leg);
  if (recall !== null) {
    return recall;
  }
  const measurement = measureSpace(snapshot);
  // ⚠ NO SHIP IN THE SNAPSHOT IS NOT "NO STATION IN VIEW". Without the ship's
  // own row nothing can be measured, so `nearestOf` finds no station however
  // many there are, and a warp to the sun could never be seen to start or land.
  // Seen 2026-10-12: the game port's park kept a destroyed ship as its own, the
  // capsule's snapshot had no ship of its own, and the pilot warped to the sun
  // from beside a station it could not see.
  if (measurement === null) {
    return waiting(leg.phase, "Cannot tell where this ship is in space, so nothing is decided this tick.", mem);
  }
  const target = nearestOf(
    snapshot.entities.filter((entity) => DOCKABLE_KINDS.has(entity.kind ?? "")),
    measurement,
  );
  if (target !== null) {
    // The companion's warp is the client's autopilot's own call, and the floor is that call's.
    const step = decideCloseIn(target.itemID, STATION_DOCKING_RADIUS_M, measurement, mem.closingOn, AUTOPILOT_WARP_STOPS_SHORT_M, mem.closingOnAtMs, nowMs);
    if (step === null || step.kind === "arrive") {
      return {
        action: { kind: "dock", stationID: target.itemID },
        phase: leg.phase,
        why: `Docking, because ${leg.because}.`,
        memory: mem,
      };
    }
    if (step.kind === "closing") {
      return waiting(leg.phase, "Closing on the station.", mem);
    }
    if (step.kind === "approach") {
      return {
        action: { kind: "approach", targetID: target.itemID },
        phase: leg.phase,
        why: "Closing on the station.",
        memory: { ...mem, closingOn: target.itemID, closingOnAtMs: nowMs },
      };
    }
    return {
      action: { kind: "warp", targetID: target.itemID },
      phase: leg.phase,
      why: "Warping to the nearest station.",
      memory: mem,
    };
  }

  // ⚠ THE SUN, AND IT IS AN ORDINARY ON-GRID ENTITY LIKE THE STATION ABOVE.
  // This used to be an operator-named bookmark, because a note here and in the
  // plan doc said eve.js has no celestial to warp to. That was wrong, and it was
  // wrong in a specific way worth remembering: it enumerated the entity kinds
  // this CLIENT's own code mentions and concluded the server emits no others.
  // Re-checked against the server on 2026-09-11 --
  //
  //   * every solar system has a star row (`groupID` 6, `kind: "sun"`) in the
  //     server's own celestial table, 8,089 of them, each at the system origin;
  //   * `space/runtime.js` adds every celestial to the scene UNCONDITIONALLY --
  //     unlike stargates, which sit behind a flag;
  //   * `canSessionSeeStaticEntityForSession` rejects only bubble-, grid- and
  //     site-scoped statics, and a star carries none of those markers, so it is
  //     visible to every session in the system;
  //   * and `warpState.js` has a dedicated `case "sun":` landing distance, so
  //     warping to one is a mechanic somebody implemented on purpose.
  //
  // The client simply never recognised it: `space/tactical.ts` tests for
  // `kind === "celestial"` and a star's kind is `"sun"`, so it has been arriving
  // in every snapshot and falling through unread. An absence in the reader was
  // read as an absence in the world.
  const sun = leg.stationOnly === true ? null : sunOnGrid(obs);
  if (sun === null) {
    // No station and no star (or a leg that wants a station or nothing). This should not happen in a normal system, so it
    // is reported rather than papered over: what SAYING so means differs per
    // caller — see this function's header.
    return null;
  }
  if (!leg.run.safeSpotWarpIssued) {
    const backoff = leg.run.safeSpotWarpBackoff;
    if (backoff !== undefined && backoff > 1) {
      return waiting(leg.phase, "The escape warp kept being refused. Trying again in a moment.",
        leg.write(mem, { ...leg.run, safeSpotWarpBackoff: backoff - 1 }));
    }
    if (backoff === undefined && leg.run.safeSpotWarpAttempts >= MAX_GET_SAFE_WARP_ATTEMPTS) {
      return waiting(leg.phase, "The escape warp kept being refused. Trying again in a moment.",
        leg.write(mem, { ...leg.run, safeSpotWarpBackoff: COMPANION_ESCAPE_RETRY_BACKOFF_TICKS }));
    }
    if (backoff !== undefined) {
      // The back-off is spent: the attempts start over.
      const { safeSpotWarpBackoff: _spent, ...rest } = leg.run;
      leg = { ...leg, run: { ...rest, safeSpotWarpAttempts: 0 } };
      mem = leg.write(mem, leg.run);
    }
    return {
      action: { kind: "warp", targetID: sun },
      phase: leg.phase,
      why: "No station in view, so this pilot is warping to the sun.",
      memory: leg.write(mem, { ...leg.run, safeSpotWarpIssued: true,
        safeSpotWarpAttempts: leg.run.safeSpotWarpAttempts + 1, safeSpotWarpWaited: 0 }),
    };
  }
  if (leg.run.safeSpotWarpWaited >= MAX_GET_SAFE_WARP_WAIT_TICKS) {
    // Not seen leaving, and (reachedSafety already asked) not at the sun: the
    // warp did not happen. Send it again; the attempt bound above still holds.
    return waiting(leg.phase, "The escape warp never started. Sending it again.",
      leg.write(mem, { ...leg.run, safeSpotWarpIssued: false, safeSpotWarpWaited: 0 }));
  }
  return waiting(leg.phase, "Waiting for the warp to the sun to start.",
    leg.write(mem, { ...leg.run, safeSpotWarpWaited: leg.run.safeSpotWarpWaited + 1 }));
}

/**
 * The system's star, by entity id, or null if this snapshot has none.
 *
 * ⚠ `kind === "sun"` IS THE SERVER'S OWN WORD, not a guess at a naming scheme.
 * `buildStaticCelestialEntity` stamps the kind straight from the celestial row,
 * and every star row carries `kind: "sun"`. Planets and moons arrive the same
 * way under their own kinds; this deliberately matches only the star, because
 * "the sun" is what a safe spot means and a planet is somewhere else entirely.
 *
 * ⚠ NOT FILTERED ON DISTANCE OR LOCK RANGE. A star is millions of kilometres
 * away and is warped to, never approached — the whole point of it is that it is
 * off this grid.
 */
function sunOnGrid(obs: FleetCompanionObservation): number | null {
  const entities = obs.snapshot?.entities ?? [];
  for (const entity of entities) {
    if (entity.kind === "sun") {
      return entity.itemID;
    }
  }
  return null;
}

// ─── The ship is gone ────────────────────────────────────────────────────────

const SHIP_LOST_PHASE = "Ship lost";
const SHIP_LOST_DOCKED = "This pilot's ship was destroyed. Its capsule is docked, and the run has stopped.";
const SHIP_LOST_AT_THE_SUN =
  "This pilot's ship was destroyed. With no station in view its capsule warped to the sun, and the run has stopped there.";
const SHIP_LOST_NOWHERE =
  "This pilot's ship was destroyed, and there is no station or sun in view for its capsule. The run has stopped.";

/**
 * The pilot is in its capsule: the ship this run was flying is gone, and with
 * it every module and drone the request names. Get the pod docked, then stop.
 *
 * ⚠ THE FLEE IS DROPPED. It was latched for a hull that no longer exists. Seen
 * 2026-10-12: a ship destroyed while aligning out kept its flee, the capsule
 * warped to the sun and landed, and the flee then asked for that same warp
 * every two seconds for ten minutes, refused each time as too close
 * (`WARP_DISTANCE_TOO_CLOSE`, warpCommands.js `warpToPoint`: under 150 km).
 *
 * ⚠ DOCKED, NOT WHERE IT FLOATS. The script runner's rule for a capsule
 * (`IN_A_CAPSULE`, scriptRunner.ts): a pod parked in space is still a target,
 * and it can dock. So the flee's own ladder flies it, nearest station else the
 * sun, and the run stops docked, at the sun, or at once with neither. A stop,
 * not a pause: nothing the operator could resume has a ship to fly.
 */
function decideShipLost(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision {
  const running: SafetyRun = memory.shipLost ?? {
    safeSpotWarpIssued: false,
    safeSpotWarpSeen: false,
    safeSpotWarpAttempts: 0,
    safeSpotWarpWaited: 0,
    // Spent from the start: a capsule has no drones to call home. Those still in
    // space were the ship's, and the server abandoned them with it.
    droneRecallWaited: MAX_GET_SAFE_RECALL_WAIT_TICKS,
  };
  const mem: CompanionLadderMemory = { ...memory, flee: null, shipLost: running };
  if (obs.docked === true) {
    return { ...waiting(SHIP_LOST_PHASE, "The capsule is docked.", mem), stop: SHIP_LOST_DOCKED };
  }
  if (obs.inWarp === true) {
    // The one tick that can see the capsule's warp to the sun, as rung 1 is for the flee.
    const seen = running.safeSpotWarpIssued ? { ...running, safeSpotWarpSeen: true } : running;
    return waiting(SHIP_LOST_PHASE, "The capsule is in warp.", { ...mem, shipLost: seen });
  }
  if (reachedSafety(obs, running)) {
    return { ...waiting(SHIP_LOST_PHASE, "The capsule is at the sun.", mem), stop: SHIP_LOST_AT_THE_SUN };
  }
  const safe = runToSafety(request, obs, mem, {
    run: running,
    phase: SHIP_LOST_PHASE,
    because: "this pilot's ship was destroyed",
    write: (m, run) => ({ ...m, shipLost: run }),
  }, nowMs);
  if (safe !== null) {
    return safe;
  }
  return { ...waiting(SHIP_LOST_PHASE, "No station or sun in view.", mem), stop: SHIP_LOST_NOWHERE };
}

// ─── Rung 3: tank up ─────────────────────────────────────────────────────────
//
// A PORT, not an invention — see docs/fleet-companion-implementation.md,
// "Phase 3 — the spec". `scriptDecide.ts`'s `repair` interrupt response, fed by
// `repairersFor`, is a per-layer self-repair thermostat with a capacitor floor
// that INVERTS below the floor; `standDownAfterFight` is the shape the
// fight-end stand-down below copies; `scriptMacros.ts`'s `hardenersOn` is the
// ON-only hardener ladder this rung's first step mirrors. None of that code
// runs here — `observe(hint)` and `InterruptRow` belong to the DSL runner this
// loop is deliberately not part of — so the SHAPE is copied and the DATA comes
// off the request the operator picked (`defenseModuleIDs`,
// `shieldBoosterModuleIDs`, `armorRepairerModuleIDs`, `hullRepairerModuleIDs`),
// never off a fit classifier. See those fields' own comments for the two DSL
// bugs that disappear by asking instead of guessing.

/**
 * Below this fraction of a layer's max, that layer counts as hurt and this
 * rung cycles its own repairer.
 *
 * ⚠ NOT `request.fleeHealthFloor`. That field is phase 6's flee trigger and is
 * deliberately a lower, more desperate number — a pilot reaches for its own
 * repairer long before it reaches for the door. 0.75 is high enough that a
 * repairer switched on here has room to land a cycle before ordinary combat
 * damage could push the layer past what one cycle restores; low enough that a
 * layer sitting at 90-99% from routine passive regen never trips a repairer
 * that has nothing useful to do.
 */
export const TANK_LAYER_HURT_THRESHOLD = 0.75;

/**
 * ⚠ A CLEAR GRID REPS THE TANK ALL THE WAY UP (operator, 2026-10-14: "when the
 * site is cleared, pilots do not rep up ... by using armor, hull reps or shield
 * boosters (without caps.)"). The 0.75 above is a FIGHT number, and it was also
 * the only number: a repairer started below it and stopped AT it, so a site
 * cleared with the armour at 80% left the armour at 80% for good -- armour and
 * hull never come back on their own. Seen live 2026-10-14: a companion sat 52
 * minutes under its return mark ("not well enough yet to go back to the
 * fight") with an armour repairer fitted and off, because the return mark
 * (`returnMark`, the flee floor plus 0.2) sat above 0.75 and nothing on the
 * grid would ever start the repairer again.
 *
 * Once the grid is seen clear, a layer below `CLEAR_GRID_REPAIR_START_BELOW`
 * starts its repairer and the repairer runs until `CLEAR_GRID_REPAIR_WHOLE_AT`.
 * The gap between the two is the hysteresis: a layer that stopped at 99% is not
 * re-lit by a reading that wobbles a hair under it. Out of a fight a layer only
 * ever rises, so the gap is about noisy reads, not damage.
 */
export const CLEAR_GRID_REPAIR_START_BELOW = 0.98;
/** See `CLEAR_GRID_REPAIR_START_BELOW`: the layer counts as whole from here. */
export const CLEAR_GRID_REPAIR_WHOLE_AT = 0.99;
/**
 * The capacitor the clear-grid rep-up never runs below (or the operator's own
 * `capacitorFloor`, if that is higher). Nothing is shooting, so there is no
 * reason to fly the capacitor down to the FIGHT floor: a quarter is left in
 * hand for the next wave. A running repairer stops under it.
 */
export const CLEAR_GRID_REPAIR_CAP_FLOOR = 0.25;
/**
 * How far above that floor the capacitor has to come back before an idle
 * repairer starts again. Without the gap a repairer would stop at 25%, start
 * at 25.1% and stop again one cycle later, every cycle.
 */
export const CLEAR_GRID_REPAIR_CAP_RESUME_GAP = 0.25;

/** One tank layer: its current reading and the operator's own repairer picks. */
interface TankLayer {
  readonly name: "shield" | "armor" | "hull";
  readonly ratio: number | null;
  readonly moduleIDs: readonly number[];
}

/**
 * Shield, then armour, then hull — the same order `repairersFor` lists them
 * in, and the order a shield-first tank actually loses layers in.
 */
function tankLayers(request: FleetCompanionRequest, obs: FleetCompanionObservation): readonly TankLayer[] {
  return [
    { name: "shield", ratio: obs.shieldRatio, moduleIDs: request.shieldBoosterModuleIDs },
    { name: "armor", ratio: obs.armorRatio, moduleIDs: request.armorRepairerModuleIDs },
    { name: "hull", ratio: obs.hullRatio, moduleIDs: request.hullRepairerModuleIDs },
  ];
}

type LayerRepairAction =
  | { readonly kind: "activate"; readonly moduleID: number; readonly layerName: TankLayer["name"] }
  | {
      readonly kind: "deactivate";
      readonly moduleID: number;
      readonly layerName: TankLayer["name"];
      /** Which off-half fired: the capacitor floor, or the layer being whole again. */
      readonly because: "cap-floor" | "recovered";
    }
  /** Hurt, a repairer idle, and the capacitor not yet back to `capStartAt`: nothing is sent. */
  | { readonly kind: "cap-wait"; readonly layerName: TankLayer["name"] };

/**
 * The numbers one layer's repair decision runs by. A fight uses one hurt line
 * for both directions and the operator's capacitor floor for both (see
 * `fightRepairBands`); a clear grid splits each pair (`clearGridRepairBands`).
 */
interface LayerRepairBands {
  /** An idle repairer starts while the layer is below this. */
  readonly startBelow: number;
  /** A running repairer stops once the layer is at or above this. */
  readonly wholeAt: number;
  /** A running repairer stops while the capacitor is below this. */
  readonly capFloor: number;
  /** An idle repairer starts only with the capacitor at or above this. */
  readonly capStartAt: number;
}

function fightRepairBands(request: FleetCompanionRequest): LayerRepairBands {
  return {
    startBelow: TANK_LAYER_HURT_THRESHOLD,
    wholeAt: TANK_LAYER_HURT_THRESHOLD,
    capFloor: request.capacitorFloor,
    capStartAt: request.capacitorFloor,
  };
}

function clearGridRepairBands(request: FleetCompanionRequest): LayerRepairBands {
  const capFloor = Math.max(request.capacitorFloor, CLEAR_GRID_REPAIR_CAP_FLOOR);
  return {
    startBelow: CLEAR_GRID_REPAIR_START_BELOW,
    wholeAt: CLEAR_GRID_REPAIR_WHOLE_AT,
    capFloor,
    capStartAt: Math.min(1, capFloor + CLEAR_GRID_REPAIR_CAP_RESUME_GAP),
  };
}

/**
 * The repairers a clear grid may START on one layer: never cap charges.
 *
 * ⚠ "WITHOUT CAPS" (operator, 2026-10-14). An ancillary shield booster burns a
 * cap booster charge every cycle it has one loaded, and this loop cannot see
 * whether it has, so out of a fight it is never started: the shield comes back
 * on its own anyway. An ancillary armour repairer burns nanite paste, not a cap
 * charge, and runs on capacitor without it; it is started only when the layer
 * has no plain repairer, because armour never comes back by itself and leaving
 * it hurt is the strand this rule exists to end. Nothing here ever starts a
 * capacitor booster: none is on these lists (`resolveDefenseModuleIDs`).
 */
function clearGridStartable(layer: TankLayer, ancillary: ReadonlySet<number>): readonly number[] {
  const plain = layer.moduleIDs.filter((id) => !ancillary.has(id));
  return layer.name === "shield" || plain.length > 0 ? plain : layer.moduleIDs;
}

/** The player's words for a layer in a readout. */
function layerWords(name: TankLayer["name"]): string {
  return name === "armor" ? "armour" : name;
}

/**
 * One layer's own repair decision — the `repair` interrupt response's body,
 * scoped to a single layer instead of a single watch row: this loop has no
 * rows, so each layer plays the part a `shield-below` / `armor-below` /
 * `hull-below` row would.
 *
 * ⚠ CANNOT-TELL NEVER STARTS A CYCLE. An unreadable layer ratio reads as "not
 * hurt" here, the same rule every tri-state read in this file follows — a
 * layer this loop cannot see is not one it can decide is hurt.
 *
 * ⚠ THE INVERSION IS THE POINT OF THE WHOLE RUNG. Below `capacitorFloor`, a
 * RUNNING repairer for this layer switches off instead of an idle one
 * starting, even though the layer is (by definition, to have reached this
 * branch) still hurt. The floor is not "can this ship still warp" — warp
 * costs no capacitor on this server, see `capacitorFloor`'s own comment for
 * the length of that answer — it is that an empty capacitor repairs nothing,
 * so a repairer cycling below the floor is spending capacity that heals
 * nobody.
 *
 * `null` covers every "nothing NEW for this layer" case: not hurt,
 * unreadable, nothing fitted for it, or every fitted candidate is already in
 * the state this layer wants it in.
 */
function decideLayerRepairer(
  layer: TankLayer,
  active: ReadonlySet<number>,
  capacitorRatio: number | null,
  bands: LayerRepairBands,
  startable: readonly number[] = layer.moduleIDs,
): LayerRepairAction | null {
  if (layer.ratio === null) {
    // Cannot tell: neither start a cycle nor stop one. Stopping blind is the
    // same mistake as standing the hardeners down blind -- an unreadable layer
    // is not a layer this rung has seen recover.
    return null;
  }
  if (layer.ratio >= bands.wholeAt) {
    // ⚠ THE THERMOSTAT'S OTHER OFF-HALF, and the rung is wrong without it. A
    // layer that heals back up mid-fight leaves its repairer cycling on a whole
    // layer, and the DSL has a whole pass for exactly this (`repairShutdown`,
    // scriptDecide.ts) whose comment gives the reason: they "stop eating
    // capacitor once the ship is whole".
    //
    // Leaving it out does not merely waste a little capacitor -- it aims the
    // ship at the capacitor floor, and the floor is the SAFETY NET, not the
    // normal off-switch. A rung that only ever stops repairing by hitting the
    // floor has arranged to spend every fight at the one capacitor level it
    // exists to keep the ship away from.
    //
    // One threshold serves both directions, exactly as a `shield-below` watch
    // and its `repairShutdown` share one. That can chatter for a layer sitting
    // right on the line; the DSL has lived with the same property, and a second
    // hysteresis number tuned by nobody would be worse than the chatter.
    const running = layer.moduleIDs.find((id) => active.has(id));
    return running === undefined
      ? null
      : { kind: "deactivate", moduleID: running, layerName: layer.name, because: "recovered" };
  }
  // Unreadable capacitor fails OPEN toward repairing, not against it — the
  // same choice the DSL's own `repair` case makes (`cap !== null && cap <
  // REPAIR_CAP_FLOOR`). The risk of an unseen empty cap is a wasted cycle; the
  // risk of refusing to repair on a guess is a layer this rung could have saved.
  if (capacitorRatio !== null && capacitorRatio < bands.capFloor) {
    const running = layer.moduleIDs.find((id) => active.has(id));
    if (running !== undefined) {
      return { kind: "deactivate", moduleID: running, layerName: layer.name, because: "cap-floor" };
    }
    // Nothing running: falls to the start checks below, where a capacitor under
    // the floor is also under `capStartAt` and answers "cap-wait".
  }
  // Between the two lines a running repairer keeps running and an idle one
  // stays idle. In a fight the lines are one line and this never fires.
  if (layer.ratio >= bands.startBelow) {
    return null;
  }
  const idle = startable.find((id) => !active.has(id));
  if (idle === undefined) {
    return null;
  }
  // The capacitor's own hysteresis, the same shape: in a fight `capStartAt` is
  // the floor itself, so the check above has already answered.
  if (capacitorRatio !== null && capacitorRatio < bands.capStartAt) {
    return { kind: "cap-wait", layerName: layer.name };
  }
  return { kind: "activate", moduleID: idle, layerName: layer.name };
}

interface TankUpStep {
  /** Non-null when this rung has something NEW to do this tick. */
  readonly decision: CompanionDecision | null;
  /**
   * The memory to carry forward regardless of `decision`. Needed because the
   * fight-end stand-down below can finish — forgetting its own record — on a
   * tick where it has nothing left to switch off, the same way
   * `standDownAfterFight` threads a forgotten record through even when its own
   * action for that tick is null.
   */
  readonly memory: CompanionLadderMemory;
}

/**
 * Rung 3: tank up. See the header above `decideCompanionAction` for why this
 * sits above obeying the fleet (rung 7) and below the supervision gate.
 *
 * ⚠ HARDENERS ARE NEVER CAP-GATED, UNLIKE THE REPAIRERS BELOW. The
 * implementation doc's earlier rung-2 table said to gate them too, because
 * the DSL's fit classifier cannot tell a free Damage Control from a
 * cap-hungry active hardener — one regex, `/hardener|damage control|
 * resistance/i`, for both. `defenseModuleIDs` is the operator's OWN pick, so
 * there is nothing left here to be unsure about, and delaying a free cycle
 * for a floor that exists to protect REPAIR throughput is a cost with no
 * matching benefit.
 *
 * The ladder, one action per tick, falling through (returning a null
 * `decision`) the moment there is nothing NEW to do — the same shape and the
 * same reason `decideHealOrder` uses:
 *
 *   1. a fitted hardener switches on while a fight is on
 *   2. a hurt layer's OWN repairer switches on — shield from the shield list,
 *      armour from the armour list, hull from the hull list, never across
 *      families. In a fight "hurt" is below `TANK_LAYER_HURT_THRESHOLD`; once
 *      the grid is seen clear it is anything short of whole, never on cap
 *      charges, with its own capacitor floor (`clearGridRepairBands`,
 *      operator 2026-10-14)
 *   3. INVERTED below `request.capacitorFloor`: a RUNNING repairer switches
 *      OFF instead of another one starting, even while that layer is still
 *      hurt — see `decideLayerRepairer`'s own comment for why
 *   4. once the fight is confirmed over, every HARDENER this rung switched on
 *      switches back off, one per tick; repairers are never stood down here,
 *      only by steps 2/3's own rule (layer whole again, or capacitor floor)
 *
 * ⚠ NEVER STAND DOWN ON A BLIND READ. Step 4 fires only on an explicit
 * `hostileOnGrid === false`, never on `null` (cannot tell) — the same rule
 * `standDownAfterFight`'s own comment states: "standing down blind is the
 * worst possible moment to drop the tank."
 *
 * ⚠ A LAYER THAT HEALS MID-FIGHT IS AN ACCEPTED GAP, NOT AN OVERSIGHT. The
 * DSL's `repairShutdown` stands a repairer down the instant ITS OWN watch
 * reads not-met, independently of whether a fight is still on at all. This
 * rung does not port that: a repairer it lit keeps cycling on a layer that has
 * since topped up until EITHER the capacitor floor inverts it OR the fight
 * ends and step 4 clears it. A cycle spent on a full layer is a wasted one,
 * not a dangerous one, and the capacitor floor already bounds how long that
 * waste can run — a third, per-layer recovery-driven off switch was not asked
 * for and would need its own bookkeeping distinct from steps 3 and 4's.
 */
function decideTankUp(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): TankUpStep {
  // ⚠ THREE STATES, NOT TWO, AND COLLAPSING THEM SPUN THIS RUNG FOREVER.
  // `activeModuleIDs` is `[]` when nothing is running and `null` when the read
  // COULD NOT ANSWER -- `store/types.ts` states that contract and the BFF
  // preserves it deliberately (`server.js`'s `readActiveModuleIDs`: "null (not
  // []) when the snapshot could not answer at all"). This read used to be
  // `?? []`, which threw the distinction away.
  //
  // What that cost: on a tick where the module map was unreadable, every
  // fitted module looked idle. Step 1's `find` tests only this set, never the
  // record of what it has already lit, so it re-picked THE SAME hardener every
  // tick -- issuing an action every tick, growing `lastTankUpModuleIDs`
  // without bound, and starving every rung below this one for as long as the
  // read stayed broken. The flee rung is one of those, and a fight is exactly
  // when both the read is most likely to be partial and the flee matters most.
  //
  // Unknown now falls back to what this rung KNOWS it lit. That is the only
  // honest answer available when nothing can say, and it CONVERGES: each tick
  // lights one module it has no record of, records it, and the rung falls
  // through once the operator's lists are accounted for. Crucially it still
  // never withholds a hardener from a module it has not lit -- lighting
  // something already lit is a wasted call, leaving something dark in a fight
  // is a lost ship, and only the second is worth avoiding at the cost of the
  // first.
  const readModules = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const active = new Set(readModules ?? memory.lastTankUpModuleIDs);

  // 1. Hardeners up while a fight is on. Both reads already exist on the
  //    observation; either one alone is enough to mean "a fight is on".
  const fightOn = obs.hostileOnGrid === true || obs.targetedByPlayer === true;
  if (fightOn) {
    const idleHardener = request.defenseModuleIDs.find((id) => !active.has(id));
    if (idleHardener !== undefined) {
      const lit: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: [...memory.lastTankUpModuleIDs, idleHardener],
      };
      return {
        decision: {
          action: { kind: "activate", moduleID: idleHardener, targetID: 0 },
          phase: "Tanking up",
          why: "Hostiles are on this grid, so a fitted hardener is switching on.",
          memory: lit,
        },
        memory: lit,
      };
    }
  }

  // 2 & 3. Each layer's own repairer — on while hurt, inverted off below the
  //        capacitor floor. See `decideLayerRepairer`'s own comment.
  //
  //        ⚠ A CLEAR GRID REPAIRS TO FULL, NOT TO THE FIGHT LINE (operator,
  //        2026-10-14). See `CLEAR_GRID_REPAIR_START_BELOW` for the strand this
  //        ends. "Clear" is the ladder's one predicate (`gridSeenClear`, the
  //        drones and the guns read the same one) and nobody locking this ship;
  //        a blind read keeps the fight numbers. The moment hostiles are back,
  //        the fight numbers own every repairer again.
  const clear = gridSeenClear(obs) && obs.targetedByPlayer !== true;
  const bands = clear ? clearGridRepairBands(request) : fightRepairBands(request);
  const ancillary = new Set(request.ancillaryRepairerModuleIDs ?? []);
  if (clear) {
    // ⚠ "WITHOUT CAPS": an ancillary shield booster still running from the
    // fight is spending a cap booster charge a cycle on a shield that comes back
    // by itself. Switched off; the fight lights it again if one starts.
    const burning = request.shieldBoosterModuleIDs.find((id) => ancillary.has(id) && active.has(id));
    if (burning !== undefined) {
      const dropped: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: memory.lastTankUpModuleIDs.filter((id) => id !== burning),
      };
      return {
        decision: {
          action: { kind: "deactivate", moduleID: burning },
          phase: "Tanking up",
          why: "The grid is clear: the ancillary shield booster is switching off so it spends no cap charges.",
          memory: dropped,
        },
        memory: dropped,
      };
    }
  }
  for (const layer of tankLayers(request, obs)) {
    const startable = clear ? clearGridStartable(layer, ancillary) : layer.moduleIDs;
    const layerAction = decideLayerRepairer(layer, active, obs.capacitorRatio ?? null, bands, startable);
    if (layerAction === null) {
      continue;
    }
    if (layerAction.kind === "cap-wait") {
      // Said, not acted on: a rung that held the tick for this would hold the
      // follow and the rejoin with it, for as long as the capacitor takes. In a
      // fight the readout is the fight's; this only speaks on a clear grid.
      if (clear) {
        noteNotice(`Capacitor low: waiting before repairing the ${layerWords(layerAction.layerName)}.`);
      }
      continue;
    }
    if (layerAction.kind === "activate") {
      const lit: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: [...memory.lastTankUpModuleIDs, layerAction.moduleID],
      };
      return {
        decision: {
          action: { kind: "activate", moduleID: layerAction.moduleID, targetID: 0 },
          phase: "Tanking up",
          why: clear
            ? `The grid is clear: repairing the ${layerWords(layerAction.layerName)}.`
            : `The ${layerWords(layerAction.layerName)} is hurt, so a fitted repairer is switching on.`,
          memory: lit,
        },
        memory: lit,
      };
    }
    // Whatever switched it off, this rung is no longer holding it on, so it
    // leaves the stand-down record. A stale entry would be harmless (the
    // stand-down only ever switches off what it can still see running) but it
    // would make the record a log of what this rung once did rather than a
    // statement of what it is holding on right now, which is what it is for.
    const dropped: CompanionLadderMemory = {
      ...memory,
      lastTankUpModuleIDs: memory.lastTankUpModuleIDs.filter((id) => id !== layerAction.moduleID),
    };
    return {
      decision: {
        action: { kind: "deactivate", moduleID: layerAction.moduleID },
        phase: "Tanking up",
        why:
          layerAction.because === "cap-floor"
            ? clear
              ? `Capacitor low: the ${layerWords(layerAction.layerName)} repairer is switching off until it recovers.`
              : "The capacitor is too low to keep repairing, so a running repairer is switching off."
            : clear
              ? `The grid is clear and the ${layerWords(layerAction.layerName)} is whole again, so its repairer is switching off.`
              : `The ${layerWords(layerAction.layerName)} is whole again, so its repairer is switching off.`,
        memory: dropped,
      },
      memory: dropped,
    };
  }

  // 4. Stand the HARDENERS down once the fight is confirmed over -- never on a
  //    blind read. Repairers are not this step's to switch off.
  //
  //    WHY: a hardener is lit by "a fight is on" (step 1), so "the fight is
  //    over" is the matching off-switch. A repairer is lit by "a layer is hurt"
  //    (step 2), and a wave that ends with armour still chewed leaves that
  //    layer hurt after the last hostile is gone -- the repairer's own off
  //    rules (layer whole again, capacitor under the floor) are the only ones
  //    that describe when it has finished its job.
  //
  //    ⚠ THIS STEP USED TO STAND DOWN EVERY MODULE IN THE RECORD, REPAIRERS
  //    INCLUDED, AND THAT LOOPED. Fight over, armour hurt: step 2 lit the
  //    repairer, next tick step 2 had nothing NEW to say (it is running, the
  //    layer is still hurt) and fell through to here, which switched it off;
  //    next tick the layer was still hurt and the repairer was off, so step 2
  //    lit it again. Seen live: on/off every ~10 s (each deactivate took ~9 s
  //    to answer), the repairer never completed a cycle, and the pilot crossed
  //    its return mark and flew to a station to repair instead.
  const repairerIDs = new Set<number>([
    ...request.shieldBoosterModuleIDs,
    ...request.armorRepairerModuleIDs,
    ...request.hullRepairerModuleIDs,
  ]);
  if (obs.hostileOnGrid === false && memory.lastTankUpModuleIDs.length > 0) {
    const stillOn = memory.lastTankUpModuleIDs.find((id) => !repairerIDs.has(id) && active.has(id));
    if (stillOn !== undefined) {
      const remaining: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: memory.lastTankUpModuleIDs.filter((id) => id !== stillOn),
      };
      return {
        decision: {
          action: { kind: "deactivate", moduleID: stillOn },
          phase: "Standing down",
          why: "The fight is over, so a module this pilot switched on is switching back off.",
          memory: remaining,
        },
        memory: remaining,
      };
    }
    // Every hardener this rung lit is already off (switched off here over the
    // last few ticks, or ended on its own) -- forget those so the next fight
    // starts clean, with no action issued this tick. A repairer that is still
    // running stays in the record: step 2/3 is holding it on and will say when
    // it stops, and dropping it here would let a later stand-down or rebuild
    // lose track of a module this rung still owns.
    const kept = memory.lastTankUpModuleIDs.filter((id) => repairerIDs.has(id) && active.has(id));
    return {
      decision: null,
      memory: kept.length === memory.lastTankUpModuleIDs.length ? memory : { ...memory, lastTankUpModuleIDs: kept },
    };
  }

  return { decision: null, memory };
}

/** An entity present on THIS grid, or null when the snapshot does not carry it. */
function entityOnGrid(itemID: number, entities: readonly SpaceEntity[]): SpaceEntity | null {
  return entities.find((entity) => entity.itemID === itemID) ?? null;
}

/**
 * The best-ranked TAGGED entity on grid, by `fleetTagRank` — nearest breaks a
 * tie between two entities carrying tags of equal rank (an unrecognised tag,
 * or two hand-typed tags that happen to collide; see `fleetTagRank`'s own
 * comment on why an unrecognised tag still gets a finite rank rather than
 * being dropped).
 */
function bestTaggedEntity(
  tags: ReadonlyMap<number, string>,
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  let bestRank = Number.POSITIVE_INFINITY;
  let candidates: SpaceEntity[] = [];
  for (const entity of entities) {
    const tag = tags.get(entity.itemID);
    if (tag === undefined) {
      continue;
    }
    const rank = fleetTagRank(tag);
    if (rank < bestRank) {
      bestRank = rank;
      candidates = [entity];
    } else if (rank === bestRank) {
      candidates.push(entity);
    }
  }
  return candidates.length === 0 ? null : nearestOf(candidates, measurement);
}

/**
 * Whether `targetID` is already locked.
 *
 * ⚠ THE AUTHORITATIVE READ WINS WHENEVER IT IS READABLE AT ALL. `obs.lockedTargetIDs`
 * comes straight off the server's own lock list, the same authority
 * `miningBotLoop.ts`'s `getLockedTargetIDs` trusts over its own memory — an
 * EMPTY array is a real "nothing locked" answer, not a failed read, so it is
 * trusted exactly like a non-empty one. Only `null`/`undefined` (unreadable,
 * or simply not wired up by this host's `observe()` yet) falls back to the
 * ladder's own memory of the last target IT issued a `lock` call for — the
 * same "compare and stamp" `closingOn` already uses, so a target whose lock is
 * merely in flight is not re-issued every tick just because this tick's
 * authoritative read did not arrive.
 */
/**
 * How many refused locks on ONE ship are enough to stop trying it.
 *
 * ⚠ THE SAME "A FEW TRIES" THE TAG RUNG AND THE LOOT ORDER ALREADY USE
 * (`MAX_COMPANION_TAG_ATTEMPTS`, `MAX_LOOT_ATTEMPTS`), and deliberately the same
 * number: a pilot that gives up after three goes at anything is one an operator
 * can predict. At a two-second cadence it is six seconds of trying, which is
 * long enough for a lock that was going to land.
 */
const MAX_REFUSED_LOCK_ATTEMPTS = 3;

/**
 * How long an asked-for lock is waited on before it is asked for again.
 *
 * ⚠ A BOUND ON THE REPEATS, NOT A GUESS AT THE LOCK TIME. The server answers a
 * repeated AddTarget on a pending lock with "pending" and changes nothing, so
 * asking early costs only the call; asking late after a lock the server dropped
 * costs the wait. Ten seconds covers a cruiser on a frigate (about 6.5 s at
 * 340 mm scan resolution) and re-asks a lock that is slower than that once
 * every ten seconds rather than every 400 ms.
 */
const LOCK_LANDING_WAIT_MS = 10_000;

/**
 * How many hostiles beyond the one being shot this pilot keeps locked.
 *
 * ⚠ THIS IS WHAT A KILL COSTS WITHOUT IT. Measured 2026-10-12: after a rat
 * died the next AddTarget went out in 0.5-2.6 s and then waited 3.5-7 s on the
 * lock timer before a drone or gun could move -- the lock was most of the
 * dead time between kills, and it was paid only because nothing asked for it
 * until the last ship was dead. A player locks the next ones while shooting
 * this one; two is the next kill and the one after, without spending the
 * slots a heal call or a salvager needs.
 */
const COMPANION_LOCK_AHEAD = 2;

/**
 * How many pre-locks the lock-ahead remembers having asked for. The cap is the
 * whole bound on that record (the drone boat's `MAX_PRELOCK_MEMORY`, same
 * number for the same reason): comfortably more than any hull locks.
 */
const MAX_PRELOCK_MEMORY = 16;

/**
 * The lock-ahead: while this pilot is fighting `engagedID`, lock the hostiles it
 * will fight next, so the next kill starts with the lock already on.
 *
 * Ranked as the next call is most likely to come: the fleet's other tagged
 * ships first by tag rank, then the free-fire kill order (`rankByKillOrder`).
 * Locking is not shooting -- nothing here activates anything, and a `targets
 * called` pilot still fires only on what it is called on.
 *
 * ⚠ UNREADABLE MEANS DO NOT. No lock count, no lock list, no grid: nothing is
 * asked, the drone boat's rule. A guessed count would spend a slot the hull
 * may not have, every kill.
 *
 * ⚠ EACH SHIP IS ASKED FOR ONCE. A pre-lock that does not land is not
 * retried; the ship gets a proper, budgeted lock the moment it becomes the
 * target. That is the whole stop condition, and why a refusal of one is not
 * booked against the ship (`CompanionDecision.preLock`).
 *
 * ⚠ ONE SLOT IS ALWAYS LEFT FREE. A heal call locks a fleet-mate and the
 * salvage order locks wrecks; a pilot whose slots were all spent on rats it
 * is not yet shooting would be refused the lock that mattered.
 */
function decideLockAhead(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  engagedID: number,
  nowMs: number,
): { readonly targetID: number; readonly memory: CompanionLadderMemory } | null {
  const maxLocks = obs.maxLockedTargets ?? null;
  const locked = obs.lockedTargetIDs ?? null;
  const snapshot = obs.snapshot ?? null;
  if (maxLocks === null || !Number.isFinite(maxLocks) || maxLocks < 1 || locked === null || snapshot === null) {
    return null;
  }
  const entities = snapshot.entities;
  const onGrid = new Set(entities.map((entity) => entity.itemID));
  const hostileIDs = new Set(entities.filter(isHostile).map((entity) => entity.itemID));
  // Asked for, still on grid, not landed, and asked recently enough to still be
  // pending on the server: each holds a slot and counts as locked ahead.
  const inFlight = memory.preLocked.filter((asked) =>
    asked.targetID !== engagedID && onGrid.has(asked.targetID) && !locked.includes(asked.targetID) &&
    nowMs - asked.atMs < LOCK_LANDING_WAIT_MS).length;
  const lockedAhead = locked.filter((id) => id !== engagedID && hostileIDs.has(id)).length;
  if (lockedAhead + inFlight >= COMPANION_LOCK_AHEAD) {
    return null;
  }
  const engagedPending = locked.includes(engagedID) ? 0 : 1;
  if (locked.length + inFlight + engagedPending + 1 >= maxLocks) {
    return null;
  }
  const measurement = measureSpace(snapshot);
  const reach = obs.maxTargetRangeM ?? null;
  const asked = new Set(memory.preLocked.map((entry) => entry.targetID));
  const candidates = entities.filter((entity) => {
    if (entity.itemID === engagedID || !isHostile(entity) || locked.includes(entity.itemID) ||
      asked.has(entity.itemID) || gaveUpOnLocking(memory, entity.itemID)) {
      return false;
    }
    const distance = measurement?.distances.get(entity.itemID) ?? null;
    return reach === null || distance === null || distance <= reach;
  });
  if (candidates.length === 0) {
    return null;
  }
  const tags = obs.fleetTargetTags ?? null;
  const next =
    (tags === null ? null : bestTaggedEntity(tags, candidates, measurement)) ??
    rankByKillOrder(obs, candidates, measurement);
  if (next === null) {
    return null;
  }
  return {
    targetID: next.itemID,
    memory: {
      ...memory,
      preLocked: [...memory.preLocked, { targetID: next.itemID, atMs: nowMs }].slice(-MAX_PRELOCK_MEMORY),
    },
  };
}

/** Record one refused lock, and give up on that ship once the budget is spent. */
function noteRefusedLock(
  memory: CompanionLadderMemory,
  targetID: number,
): CompanionLadderMemory {
  // ⚠ A DIFFERENT SHIP STARTS THE COUNT OVER. The budget is "three goes at THIS
  // ship", not "three refusals ever" -- a fleet calling three ships in a row has
  // exhausted nothing.
  const attempts = memory.lockRefusedFor === targetID ? memory.lockRefusals + 1 : 1;
  // A refused lock is not pending, so the next tick may ask again at once.
  const lockPending = memory.lockPending?.targetID === targetID ? null : memory.lockPending;
  if (attempts < MAX_REFUSED_LOCK_ATTEMPTS) {
    return { ...memory, lockRefusedFor: targetID, lockRefusals: attempts, lockPending };
  }
  return {
    ...memory,
    lockPending,
    lockRefusedFor: null,
    lockRefusals: 0,
    lockGaveUpOn: rememberGiveUp(memory.lockGaveUpOn, targetID),
  };
}

/** Has this pilot stopped trying to lock that ship? See `lockGaveUpOn`. */
function gaveUpOnLocking(memory: CompanionLadderMemory, targetID: number): boolean {
  return memory.lockGaveUpOn.includes(targetID);
}

function isAlreadyLocked(
  targetID: number,
  lockedTargetIDs: readonly number[] | null | undefined,
  memory: CompanionLadderMemory,
): boolean {
  if (lockedTargetIDs !== null && lockedTargetIDs !== undefined) {
    return lockedTargetIDs.includes(targetID);
  }
  return memory.lastLockIssuedFor === targetID;
}

/**
 * Every weapon the ship is running, counting a banked SLAVE as running whenever
 * its master is.
 *
 * ⚠ WITHOUT THE BANK PASS THIS RUNG RE-ISSUES THE SAME GUN FOREVER, and the
 * pilot does nothing else for as long as the order stands.
 * `SpaceShipStatus.weaponBanks` says it plainly: activating a slave fires the
 * whole bank THROUGH its master, and `activeModuleIDs` then names only the
 * master. So a slave never appears to be cycling on its own, and because this
 * loop issues at most one call per tick, that one slave eats the action slot
 * every rung beneath it needs.
 *
 * ⚠ THE SAME GAP IS LIVE IN THE DSL, and is deliberately not fixed from here.
 * `fightTheRats` does the naive `find` over
 * `activeModuleIDs`, and nothing under `nav/` reads `weaponBanks` at all --
 * only the manual rack does. It costs it less, because its tick has nowhere
 * else to be, so it reads there as wasted calls rather than as a stall. Worth
 * fixing; not worth a companion rung quietly changing what the ratting block
 * does.
 */
function cyclingWeapons(snapshot: SpaceSnapshot | null): ReadonlySet<number> {
  const cycling = new Set(snapshot?.ship?.activeModuleIDs ?? []);
  const banks = snapshot?.ship?.weaponBanks ?? null;
  for (const masterID of Object.keys(banks ?? {})) {
    if (!cycling.has(Number(masterID))) {
      continue;
    }
    for (const slaveID of banks?.[Number(masterID)] ?? []) {
      cycling.add(slaveID);
    }
  }
  return cycling;
}

/**
 * Which target this rung last activated each weapon on: `gunAimedAt`, with the
 * older `lastFireTargetID`/`lastFireModuleIDs` pair folded in beneath it, so a
 * memory written before the map existed still knows the guns of its own call.
 */
function gunAims(memory: CompanionLadderMemory): Readonly<Record<number, number>> {
  const aims: Record<number, number> = {};
  const legacyTarget = memory.lastFireTargetID;
  if (legacyTarget !== null) {
    for (const id of memory.lastFireModuleIDs) {
      aims[id] = legacyTarget;
    }
  }
  return { ...aims, ...(memory.gunAimedAt ?? {}) };
}

/** Each banked slave's master, from the snapshot's `weaponBanks`. */
function bankMasters(snapshot: SpaceSnapshot | null): ReadonlyMap<number, number> {
  const masters = new Map<number, number>();
  const banks = snapshot?.ship?.weaponBanks ?? null;
  for (const masterID of Object.keys(banks ?? {})) {
    for (const slaveID of banks?.[Number(masterID)] ?? []) {
      masters.set(slaveID, Number(masterID));
    }
  }
  return masters;
}

/** What `decideOpenFire` wants this tick. */
interface OpenFire {
  /** The one call, or null: nothing new to start and nothing to stop. */
  readonly action: { readonly kind: "activate" | "deactivate"; readonly moduleID: number } | null;
  readonly memory: CompanionLadderMemory;
  /** Guns still running on the ship the call moved off: being stopped, or stopped this tick. */
  readonly switching: readonly number[];
}

/**
 * The fleet called this target and the lock has landed: open fire.
 *
 * One call per tick, the same discipline `hardenersOn` uses on a rack of
 * hardeners -- the guns come up over a few ticks rather than in one burst of
 * calls, and every tick re-reads what is actually cycling before it picks the
 * next one.
 *
 * ⚠ A GUN THE SERVER SAYS IS CYCLING IS NEVER ACTIVATED, WHATEVER IT IS AIMED
 * AT. This used to re-issue every cycling gun the moment the call named another
 * ship, on the theory that a new activate re-aims it. It does not: this server
 * refuses an activate on a running module (`EffectAlreadyActive2`) and the gun
 * stays on its old target. Worse, the old memory followed the CALL, so a call
 * that went A, B, A (live 2026-10-13: free fire on A, a broadcast on B, then A)
 * forgot at B that the guns were already on A and re-sent all four at A, one
 * refusal per tick for eight seconds, while every rung beneath starved.
 *
 * ⚠ THE WIRE SAYS WHAT IS RUNNING, NEVER AT WHOM. `activeModuleIDs` is godma's
 * running effects by module (pilotDogma.js `shipReadings`); godma does hold
 * each effect's target, but no snapshot carries it. So the target half comes
 * from `gunAimedAt`, what this rung last activated each gun on, kept across
 * calls, and the rule is:
 *   - idle: activate it on the call, the first such gun per tick;
 *   - cycling on the call, or on something this rung never aimed it at: leave it;
 *   - cycling on the ship the call moved OFF, and that ship still locked: stop
 *     it ONCE (`gunStops`) and activate it on the call once it reads idle. A stop
 *     finishes its cycle first, so it is waited on, never re-sent. If the old
 *     ship is no longer locked the server ends the cycle itself, so nothing is
 *     sent. A banked gun is stopped through its master, which is the module
 *     `activeModuleIDs` names.
 * Starting an idle gun outranks stopping a busy one: damage on the call first.
 *
 * When `activeModuleIDs` is unreadable the memory is trusted ALONE, which is
 * what stops an unreadable snapshot re-firing the rack every tick, and nothing
 * is stopped: a stop on an unread rack would be a guess.
 */
function decideOpenFire(
  targetID: number,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): OpenFire {
  const aims = gunAims(memory);
  const aimAt = (id: number, base: CompanionLadderMemory): CompanionLadderMemory => ({
    ...base,
    lastFireTargetID: targetID,
    lastFireModuleIDs: base.lastFireTargetID === targetID ? [...base.lastFireModuleIDs, id] : [id],
    gunAimedAt: { ...aims, [id]: targetID },
  });
  if ((obs.snapshot?.ship?.activeModuleIDs ?? null) === null) {
    const next = request.weaponModuleIDs.find((id) => aims[id] !== targetID);
    return next === undefined
      ? { action: null, memory, switching: [] }
      : { action: { kind: "activate", moduleID: next }, memory: aimAt(next, memory), switching: [] };
  }
  const cycling = cyclingWeapons(obs.snapshot ?? null);
  const priorStops = memory.gunStops ?? [];
  // A stop that has landed reads idle: forget it.
  const stops = priorStops.filter((id) => cycling.has(id));
  const settled = stops.length === priorStops.length ? memory : { ...memory, gunStops: stops };
  const masters = bankMasters(obs.snapshot ?? null);
  const locked = obs.lockedTargetIDs ?? null;
  const switching: number[] = [];
  let stop: number | null = null;
  for (const id of request.weaponModuleIDs) {
    const was = aims[id];
    if (!cycling.has(id) || was === undefined || was === targetID) {
      continue;
    }
    if (locked !== null && !locked.includes(was)) {
      continue;
    }
    switching.push(id);
    const stopID = masters.get(id) ?? id;
    if (stop === null && !stops.includes(stopID)) {
      stop = stopID;
    }
  }
  const idle = request.weaponModuleIDs.find((id) => !cycling.has(id));
  if (idle !== undefined) {
    return { action: { kind: "activate", moduleID: idle }, memory: aimAt(idle, settled), switching };
  }
  if (stop !== null) {
    return {
      action: { kind: "deactivate", moduleID: stop },
      memory: { ...settled, gunStops: [...stops, stop] },
      switching,
    };
  }
  return { action: null, memory: settled, switching };
}

/**
 * One rung-3 decision over a called target: lock it, then shoot it.
 *
 * ⚠ THE ORDER IS LOCK, OBSERVE, THEN FIRE, and the middle step is not a
 * formality. `isAlreadyLocked` prefers the authoritative `lockedTargetIDs`
 * read precisely because a lock this loop ISSUED may have been refused, and a
 * weapon activated against an unlocked ship is a call the server throws away.
 * Firing only past that check means the guns come up on the tick the lock is
 * seen to exist, never on the tick it was asked for.
 */
function lockThenEngage(
  targetID: number,
  source: "tag" | "broadcast" | "chat" | "free-fire" | "tackled",
  heard: string,
  why: string,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
  measurement: SpaceMeasurement | null,
): CompanionDecision {
  // Free fire obeys nobody, so it says so: its own phase, and no
  // `followingOrderFrom`, which the controller reads as "own-ladder". Shooting
  // its own tackler is this pilot's own call too, above the fleet's.
  const authority =
    source === "free-fire"
      ? { phase: "Free fire" }
      : source === "tackled"
        ? { phase: "Tackled" }
        : { phase: "Obeying fleet", followingOrderFrom: source };
  if (!isAlreadyLocked(targetID, obs.lockedTargetIDs, memory)) {
    // ⚠ A LOCK ALREADY ASKED FOR IS WAITED ON, NOT ASKED FOR AGAIN. See
    // `lockPending`. The wait is STANDING, so the rungs beneath -- the
    // lock-ahead first -- get the tick while the lock timer runs.
    const pending = memory.lockPending;
    if (pending !== null && pending.targetID === targetID && nowMs - pending.sinceMs < LOCK_LANDING_WAIT_MS) {
      return {
        action: WAIT,
        standing: true,
        ...authority,
        why: why + " Waiting for the lock to land.",
        memory,
        lastOrderHeard: heard,
        engagedTargetID: targetID,
      };
    }
    return {
      action: { kind: "lock", targetID },
      ...authority,
      why: why + " Locking it.",
      memory: { ...memory, lastLockIssuedFor: targetID, lockPending: { targetID, sinceMs: nowMs } },
      lastOrderHeard: heard,
    };
  }
  if (memory.lockPending?.targetID === targetID) {
    memory = { ...memory, lockPending: null };
  }
  // ⚠ A GUN WITH A LOAD IN FLIGHT IS NOT FIRED (seen live 2026-10-14 09:32): it
  // reads empty until its reload finishes, and an `activate` on it was refused
  // NoCharges, twice. The other guns carry on; the stepped-over ones are named in
  // the readout and start on the first tick after the reload.
  const reloadingNow = reloadingGuns(obs, memory, nowMs);
  const picked = request.weaponModuleIDs;
  const reloadingCount = picked.filter((id) => reloadingNow.has(id)).length;
  request = { ...request, weaponModuleIDs: picked.filter((id) => !reloadingNow.has(id)) };
  // The range gate (companionCombatPosition.ts): only the guns that reach it start.
  const gated = gunsInReach(targetID, request, obs, memory, measurement);
  noteTrace("guns", gated.trace);
  memory = gated.memory;
  const fire = decideOpenFire(targetID, { ...request, weaponModuleIDs: gated.inReach }, obs, memory);
  if (fire.switching.length > 0) {
    noteTrace("guns", { ...gated.trace, switching: fire.switching });
  }
  memory = fire.memory;
  if (fire.action?.kind === "activate") {
    return {
      action: { kind: "activate", moduleID: fire.action.moduleID, targetID },
      ...authority,
      why: why + " Opening fire on it.",
      memory,
      lastOrderHeard: heard,
    };
  }
  if (fire.action?.kind === "deactivate") {
    return {
      action: { kind: "deactivate", moduleID: fire.action.moduleID },
      ...authority,
      why: why + " Stopping a gun still firing on the last target, to turn it onto this one.",
      memory,
      lastOrderHeard: heard,
    };
  }
  // Guns stopped for the switch and still finishing their cycle: say so, as
  // "firing on it" alone would be false for them.
  const finishing = fire.switching.length === 0
    ? ""
    : ` ${fire.switching.length} gun${fire.switching.length === 1 ? " is" : "s are"} finishing a cycle on the last target.`;
  // ⚠ STANDING, NOT PARKED -- see `CompanionDecision.standing`. Everything
  // above issues a real call; this branch has nothing left to issue, so it
  // hands back a readout the ladder uses only if no rung beneath it acts.
  return {
    action: WAIT,
    standing: true,
    ...authority,
    // ⚠ THE NO-WEAPON CASE SAYS SO, and that is the whole of its job. An empty
    // weapon list is a setting, not a fault, so it must not read as one -- but
    // a pilot that locks a called target and never shoots it is EXACTLY what
    // this rung was built to stop being, and an operator who left the list
    // empty by accident would otherwise watch the old behaviour and conclude
    // the feature is broken.
    why:
      why +
      (picked.length === 0
        ? " Locked. No weapon is picked for this pilot, so it holds the lock without firing."
        : request.weaponModuleIDs.length === 0
          ? " Locked. Every gun is reloading, so it fires when the reload finishes."
          : gunsInReachWords(gated.inReach.length - gated.assumed.length, request.weaponModuleIDs.length, gated.assumed.length) +
            (reloadingCount === 0 ? "" : ` ${reloadingCount} gun${reloadingCount === 1 ? " is" : "s are"} reloading.`) + finishing),
    memory,
    lastOrderHeard: heard,
    engagedTargetID: targetID,
  };
}

/** The four Heal broadcast names, narrowed out of `FleetBroadcastName`. */
type HealBroadcastName = "HealShield" | "HealArmor" | "HealCapacitor" | "HealTarget";

function asHealBroadcastName(name: string | undefined): HealBroadcastName | null {
  return name === "HealShield" ||
    name === "HealArmor" ||
    name === "HealCapacitor" ||
    name === "HealTarget"
    ? name
    : null;
}

/**
 * Which of this pilot's fitted REMOTE repair modules answer a given Heal
 * broadcast.
 *
 * `HealShield`/`HealArmor`/`HealCapacitor` each name their own layer, so each
 * draws from exactly one list — a shield booster cannot repair armour, and
 * reaching across families would cycle a module that does nothing for the
 * layer the call is actually about.
 *
 * `HealTarget` is different, and deliberately not treated as a fourth family
 * of its own: real fleet logi use it to say "concentrate on THIS ship"
 * without saying which layer is hurt — that judgement is left to whichever
 * logi answers, using whatever they have fitted. So it draws on all three
 * lists, shield first then armour then capacitor, and this pilot brings
 * whatever remote reps it owns to a call that does not specify one.
 */
function healModuleCandidates(
  name: HealBroadcastName,
  request: FleetCompanionRequest,
): readonly number[] {
  switch (name) {
    case "HealShield":
      return request.remoteShieldModuleIDs;
    case "HealArmor":
      return request.remoteArmorModuleIDs;
    case "HealCapacitor":
      return request.remoteCapacitorModuleIDs;
    case "HealTarget":
      return [
        ...request.remoteShieldModuleIDs,
        ...request.remoteArmorModuleIDs,
        ...request.remoteCapacitorModuleIDs,
      ];
  }
}

/** Plain words for a Heal broadcast, for the readout — never the wire name. */
function healOrderWhy(name: HealBroadcastName): string {
  switch (name) {
    case "HealShield":
      return "The fleet called for shield reps on a ship on this grid.";
    case "HealArmor":
      return "The fleet called for armour reps on a ship on this grid.";
    case "HealCapacitor":
      return "The fleet called for a capacitor transfer to a ship on this grid.";
    case "HealTarget":
      return "The fleet called to focus reps on a ship on this grid.";
  }
}

function healOrderHeard(name: HealBroadcastName): string {
  switch (name) {
    case "HealShield":
      return "the fleet's call for shield reps";
    case "HealArmor":
      return "the fleet's call for armour reps";
    case "HealCapacitor":
      return "the fleet's call for a capacitor transfer";
    case "HealTarget":
      return "the fleet's call to focus reps";
  }
}

/**
 * Whether `moduleID` is already cycling on `targetID`, so rung 7 does not
 * re-activate a running repairer every tick.
 *
 * ⚠ THE AUTHORITATIVE READ (`activeModuleIDs`, the ship snapshot's own
 * cycling set — see `SpaceShipStatus.activeModuleIDs`'s own comment) IS
 * PREFERRED, exactly as `isAlreadyLocked` prefers `obs.lockedTargetIDs`. But
 * it answers a DIFFERENT question: it says whether the module is cycling at
 * all, never AT WHOM — nothing in a space snapshot exposes a remote-repair
 * module's target. So a module the server confirms is active only counts as
 * "already answering THIS call" when this ladder's own memory also agrees it
 * was the one that aimed that module at `targetID`; otherwise it is cycling
 * on a stale target from before the broadcast changed, and must be
 * re-issued to redirect it.
 *
 * When `activeModuleIDs` cannot be read at all (`null`), there is nothing
 * authoritative to prefer, so this falls back to the memory alone — the same
 * "compare and stamp" `isAlreadyLocked` falls back to.
 */
function isHealModuleAlreadyRunning(
  moduleID: number,
  targetID: number,
  activeModuleIDs: readonly number[] | null,
  memory: CompanionLadderMemory,
): boolean {
  const issuedForThisTarget =
    memory.lastHealTargetID === targetID && memory.lastHealModuleIDs.includes(moduleID);
  if (activeModuleIDs !== null) {
    return activeModuleIDs.includes(moduleID) && issuedForThisTarget;
  }
  return issuedForThisTarget;
}

/**
 * The Heal family's own rung-3 sub-decision. `null` covers every "nothing
 * NEW to do" case at once — no matching broadcast, no matching module
 * fitted, the named ship is off this grid, or every fitted candidate for
 * this call is already cycling on it — and the caller falls through on all
 * of them alike; see `decideFleetOrders`'s header for why that fall-through,
 * rather than a parked "wait", is the point.
 */
function decideHealOrder(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  const name = asHealBroadcastName(obs.fleetBroadcast?.name);
  if (name === null) {
    return null;
  }
  // ⚠ ITEMID IS THE SHIP TO REPAIR, DIRECTLY, FOR ALL FOUR NAMES — never
  // `senderCharID` resolved to an entity. `HealShield`/`HealArmor`/
  // `HealCapacitor` name the SENDER's own ship this way; `HealTarget` names
  // a third party's. See `FLEET_BROADCAST_CLASSIFICATION` in
  // fleetBroadcasts.ts.
  const targetID = obs.fleetBroadcast?.itemID ?? null;
  if (targetID === null || entityOnGrid(targetID, entities) === null) {
    // Off this grid — not an order for this pilot right now. A logi two
    // systems away is not being asked to do anything.
    return null;
  }
  const activeModuleIDs = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const candidates = healModuleCandidates(name, request);
  if (candidates.length === 0) return null;
  const current = memory.healOrder?.targetID === targetID && memory.healOrder.name === name
    ? memory.healOrder
    : { targetID, name, lockIssued: false, lockWaited: 0, moduleRefusals: {},
        // The recipient changing cannot settle a response lost after dispatch.
        uncertainModuleIDs: memory.healOrder?.uncertainModuleIDs ?? [] };
  const mem: CompanionLadderMemory = { ...memory, healOrder: current };
  const standing = (why: string, next = mem): CompanionDecision => ({
    action: WAIT, standing: true, phase: "Obeying fleet", why,
    memory: next, followingOrderFrom: "broadcast", lastOrderHeard: healOrderHeard(name),
  });
  const moduleID = candidates.find(
    (id) => !isHealModuleAlreadyRunning(id, targetID, activeModuleIDs, memory) &&
      (current.moduleRefusals[id] ?? 0) < MAX_COMPANION_HEAL_REFUSALS &&
      !current.uncertainModuleIDs.includes(id),
  );
  if (moduleID === undefined) {
    if (candidates.some((id) => current.uncertainModuleIDs.includes(id))) {
      return standing("The remote repair's outcome could not be confirmed, so this pilot is not asking for it again.");
    }
    if (candidates.some((id) => (current.moduleRefusals[id] ?? 0) >= MAX_COMPANION_HEAL_REFUSALS &&
      !isHealModuleAlreadyRunning(id, targetID, activeModuleIDs, memory))) {
      return standing("The remote repair kept being refused, so this pilot stopped asking for it.");
    }
    // Either this pilot has nothing fitted for this call — a dps-role
    // companion is not obligated to grow a repairer it was never given, and
    // A LOGI-LESS PILOT IS STILL A WORKING PILOT: it must fall through to
    // its tag/Target lock rather than freeze on a call it cannot answer —
    // or everything fitted for this call is already cycling on this target,
    // in which case there is still nothing NEW to start.
    return null;
  }
  // A requested lock is not a completed one, even when the lock read fails.
  const locked = obs.lockedTargetIDs ?? null;
  if (locked === null) {
    return standing("Waiting to read the target locks before starting remote repairs.");
  }
  if (!locked.includes(targetID)) {
    if (gaveUpOnLocking(memory, targetID) || current.lockWaited >= MAX_COMPANION_HEAL_LOCK_WAIT_TICKS) {
      return standing("The repair recipient could not be locked, so this pilot stopped asking for it.");
    }
    if (current.lockIssued) {
      return standing("Waiting for the repair recipient's lock before starting remote repairs.", {
        ...mem, healOrder: { ...current, lockWaited: current.lockWaited + 1 },
      });
    }
    return {
      action: { kind: "lock", targetID }, phase: "Obeying fleet",
      why: healOrderWhy(name) + " Locking the repair recipient first.",
      memory: { ...mem, lastLockIssuedFor: targetID,
        healOrder: { ...current, lockIssued: true, lockWaited: 0 } },
      followingOrderFrom: "broadcast", lastOrderHeard: healOrderHeard(name),
    };
  }
  return {
    action: { kind: "activate", moduleID, targetID },
    phase: "Obeying fleet",
    why: healOrderWhy(name) + " Activating the fitted remote repairer.",
    memory: {
      ...mem,
      healOrder: { ...current, lockIssued: false, lockWaited: 0 },
      lastHealTargetID: targetID,
      lastHealModuleIDs:
        memory.lastHealTargetID === targetID ? [...memory.lastHealModuleIDs, moduleID] : [moduleID],
    },
    followingOrderFrom: "broadcast",
    lastOrderHeard: healOrderHeard(name),
  };
}

const MAX_COMPANION_HEAL_LOCK_WAIT_TICKS = 10;
const MAX_COMPANION_HEAL_REFUSALS = 3;

function isDefiniteCompanionRefusal(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "CALL_REFUSED";
}

function isSessionChangeDeferral(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "SESSION_CHANGE_IN_PROGRESS";
}

function noteEscapeWarpRefusal(memory: CompanionLadderMemory): CompanionLadderMemory {
  const refused = <T extends SafetyRun>(run: T): T => ({ ...run, safeSpotWarpIssued: false, safeSpotWarpWaited: 0 });
  return { ...memory,
    abandonment: memory.abandonment?.safeSpotWarpIssued && !memory.abandonment.safeSpotWarpSeen
      ? refused(memory.abandonment) : memory.abandonment,
    flee: memory.flee?.safeSpotWarpIssued && !memory.flee.safeSpotWarpSeen
      ? refused(memory.flee) : memory.flee };
}

function noteHealFailure(memory: CompanionLadderMemory, action: FleetCompanionAction, error: unknown): CompanionLadderMemory {
  const heal = memory.healOrder;
  if (heal === null || !(action.kind === "lock" || action.kind === "activate") || action.targetID !== heal.targetID) {
    return memory;
  }
  if (action.kind === "lock") {
    return isDefiniteCompanionRefusal(error)
      ? { ...memory, healOrder: { ...heal, lockIssued: false, lockWaited: 0 } }
      : memory;
  }
  return isDefiniteCompanionRefusal(error)
    ? { ...memory, lastHealModuleIDs: memory.lastHealModuleIDs.filter((id) => id !== action.moduleID),
        healOrder: { ...heal, moduleRefusals: { ...heal.moduleRefusals,
          [action.moduleID]: (heal.moduleRefusals[action.moduleID] ?? 0) + 1 } } }
    : { ...memory, healOrder: { ...heal, uncertainModuleIDs: [...heal.uncertainModuleIDs, action.moduleID] } };
}

/** The four broadcast names that name a thing to go to or shoot. */
type NamedOrderName = "Target" | "AlignTo" | "TravelTo" | "JumpTo" | "WarpTo";

const MAX_COMPANION_ALIGN_REFUSALS = 3;

/**
 * How near a `WarpTo` order's object counts as being there already: where this
 * pilot's own warp to it would have left the ship. That warp is the client's
 * autopilot's, which this server stops `AUTOPILOT_WARP_STOPS_SHORT_M` short,
 * and a gate's warp-in point scatters up to `WARP_EXIT_VARIANCE_M` beyond it
 * (measured 2026-10-11: 10,022 to 11,850 m off). Nearer than this, warping
 * again could bring the ship no closer, and the server refuses it anyway.
 */
const WARP_TO_ARRIVED_M = AUTOPILOT_WARP_STOPS_SHORT_M + WARP_EXIT_VARIANCE_M;

/**
 * One order this pilot is being given, with the source it came from already
 * decided. `why` is the readout sentence's opening clause and `heard` is the
 * one-line "what it is obeying" the panel shows; both name the SOURCE, because
 * "the fleet called this" and "somebody typed this" are different claims and a
 * player reading the panel is entitled to know which one they are looking at.
 */
interface NamedOrder {
  readonly name: NamedOrderName;
  readonly itemID: number;
  readonly source: "broadcast" | "chat";
  readonly key: string;
  readonly heard: string;
  readonly why: string;
}

/**
 * The chat verbs that name an OBJECT, and so have a broadcast to map onto.
 *
 * ⚠ WRITTEN AS AN EXCLUSION SO A NEW VERB BREAKS THE BUILD RATHER THAN THE RUN.
 * `CHAT_ORDER_NAMES` below is a total `Record` over this union, so the moment
 * `chatCommands.ts` learns a verb that IS a named order, this file stops
 * compiling until somebody says which broadcast it answers. Excluding the two
 * area verbs by name keeps that tripwire armed; typing the record over
 * `ChatCommand["kind"]` and adding `salvage`/`loot` entries pointing at some
 * arbitrary broadcast would have disarmed it AND been a lie about what they do.
 *
 * ⚠ EACH EXCLUSION IS A CLAIM ABOUT THAT VERB, so each is recorded rather than
 * quietly appended. Widening this list is how the tripwire gets disarmed, and
 * the only defence is that widening it costs a sentence:
 *
 *   • `salvage`, `loot` — name an AREA, not an object. There is no salvage call
 *     in the fleet's broadcast vocabulary at all, so there is nothing to map.
 *   • `stop` — cancels standing orders. It is the absence of an order, and an
 *     absence has no broadcast.
 *   • `follow` — answers no broadcast either, and is not even an event: it is
 *     this companion's STANDING behaviour with a distance attached. Nothing the
 *     fleet can broadcast means "stay near me at 10 km".
 *   • `props` — switches this ship's own afterburner/MWD on or off. It names no
 *     object, answers no broadcast, and is not even an order in the sense the
 *     others are: it is a standing OVERRIDE of a decision the pilot otherwise
 *     makes for itself from whether it is travelling. Nothing in the fleet's
 *     broadcast vocabulary means "use your prop mod".
 *   • `destination` — carries an id and so LOOKS like `travel`, which does map
 *     onto `TravelTo`. It is excluded anyway because the two differ in kind:
 *     `travel` is obeyed for as long as the call stands and lapses with it,
 *     while `destination` LATCHES and outlives every freshness window by
 *     minutes. Mapping it onto `TravelTo` would put it in rung 7, where a
 *     target call outranks it -- the exact opposite of the "without additional
 *     interruption" this order was asked for.
 */
type NamedChatCommandKind = Exclude<
  ChatCommand["kind"],
  "salvage" | "loot" | "stop" | "follow" | "destination" | "props" | "targets" | "flight" | "status" | "repair"
>;

const CHAT_ORDER_NAMES: Readonly<Record<NamedChatCommandKind, NamedOrderName>> = Object.freeze({
  target: "Target",
  align: "AlignTo",
  travel: "TravelTo",
  jump: "JumpTo",
  // ⚠ THE ONE ORDER WHOSE ID MAY NOT BE ON THIS GRID. Every other entry here
  // names something the pilot can already see; `warp` is asked for precisely
  // when it cannot. See `isOrderActionable` and rung e2 for the two answers
  // that follow from that.
  warp: "WarpTo",
});

const ORDER_HEARD: Readonly<Record<NamedOrderName, { readonly broadcast: string; readonly chat: string }>> =
  Object.freeze({
    Target: { broadcast: "the fleet's target call", chat: "a chat order to shoot a target" },
    AlignTo: { broadcast: "the fleet's align call", chat: "a chat order to align" },
    TravelTo: { broadcast: "the fleet's travel call", chat: "a chat order to travel" },
    JumpTo: { broadcast: "the fleet's jump call", chat: "a chat order to jump" },
    WarpTo: { broadcast: "the fleet's warp call", chat: "a chat order to warp" },
  });

const ORDER_WHY: Readonly<Record<NamedOrderName, { readonly broadcast: string; readonly chat: string }>> =
  Object.freeze({
    Target: {
      broadcast: "The fleet broadcast a target on this grid.",
      chat: "An allowed pilot called a target in chat.",
    },
    AlignTo: {
      broadcast: "The fleet broadcast an align point on this grid.",
      chat: "An allowed pilot called an align point in chat.",
    },
    TravelTo: {
      broadcast: "The fleet broadcast a system to travel to.",
      chat: "An allowed pilot called a system to travel to in chat.",
    },
    JumpTo: {
      broadcast: "The fleet called a gate on this grid.",
      chat: "An allowed pilot called a gate in chat.",
    },
    WarpTo: {
      broadcast: "The fleet broadcast something to warp to.",
      chat: "An allowed pilot called a warp destination in chat.",
    },
  });

function asNamedOrderName(name: string | undefined): NamedOrderName | null {
  return name === "Target" ||
    name === "AlignTo" ||
    name === "TravelTo" ||
    name === "JumpTo" ||
    name === "WarpTo"
    ? name
    : null;
}

/**
 * The newest chat line that is BOTH from a sender the operator allowed AND a
 * command this loop has a rung for.
 *
 * ⚠ THE GATE IS THE SENDER, AND IT IS CHECKED BEFORE THE TEXT MEANS ANYTHING.
 * `isChatCommandSenderAllowed` keys on `characterID`, which the chat backend
 * fills in server-side from the authenticated session and never from the
 * message body — so no amount of crafting the text changes who a line is
 * attributed to. `chatCommandSenders` comes off the request the operator
 * controls, and is NEVER populated from chat itself. An empty list allows
 * nobody, which is the shipped default: a companion nobody has explicitly
 * authorised takes orders from no one over chat.
 *
 * Newest wins, because a later order supersedes an earlier one exactly as a
 * later broadcast replaces the one before it.
 */
function newestChatCommand(
  messages: readonly ChatMessage[],
  allowedSenders: readonly number[],
  wanted: (command: ChatCommand) => boolean,
): { readonly command: ChatCommand; readonly at: number; readonly key: string } | null {
  let best: { readonly command: ChatCommand; readonly at: number; readonly key: string } | null = null;
  for (const message of messages) {
    if (!isChatCommandSenderAllowed(message, allowedSenders)) {
      continue;
    }
    const command = parseChatCommand(message);
    if (command === null || !wanted(command)) {
      continue;
    }
    if (best === null || message.createdAtMs >= best.at) {
      best = { command, at: message.createdAtMs, key: standingChatMessageKey(message) };
    }
  }
  return best;
}

/**
 * The newest chat order that names an OBJECT — `target`, `align`, `travel`,
 * `jump`.
 *
 * ⚠ SPLIT FROM THE AREA COMMANDS ON PURPOSE, AND NOT MERELY FOR TIDINESS. Every
 * command this function returns carries an `itemID` and is answered by
 * `resolveNamedOrder` mapping it onto the matching BROADCAST name. `salvage` and
 * `loot` carry no itemID and have no broadcast to map onto -- there is no
 * salvage call in the fleet vocabulary at all -- so feeding one into that path
 * would index `CHAT_ORDER_NAMES` with a kind it does not hold and hand
 * `isOrderActionable` an itemID that does not exist. They are read by their own
 * rung instead; see `newestAreaCommand`.
 */
/**
 * The newest AREA order standing in chat: `salvage` or `loot`, or null.
 *
 * ⚠ A STANDING ORDER, NOT AN EVENT, AND IT LAPSES BY ITSELF. Nothing here
 * remembers that a salvage order was ever given: the order is "live" exactly as
 * long as the message that carried it is still inside the freshness window the
 * observation builder applies to `chatMessages`. That is the same one staleness
 * policy a broadcast gets, and it is what makes "stop salvaging" require no verb
 * -- a commander simply stops saying it, and within the window the pilot goes
 * back to its own ladder.
 *
 * ⚠ WHICH ALSO MEANS A SALVAGE ORDER IS NOT A LOCK ON THE SHIP. The rungs above
 * this one -- the supervision gate, the flee, a fleet warp -- all still win. A
 * pilot told to salvage still runs when it is dying.
 */
function newestAreaCommand(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): "salvage" | "loot" | "stop" | null {
  const found = newestChatCommand(
    (obs.chatMessages ?? []).filter((message) => isNewStandingChatMessage(message, memory)),
    commandersFor(obs),
    (command) =>
      command.kind === "salvage" || command.kind === "loot" || command.kind === "stop",
  );
  if (found === null) {
    return null;
  }
  return found.command.kind as "salvage" | "loot" | "stop";
}

/**
 * The area job after this tick's chat, given the one standing before it.
 *
 * ⚠ A HEARD ORDER LATCHES; SILENCE CHANGES NOTHING. That is the whole point of
 * this function and the reason these verbs are not read straight off the
 * backlog like a target call is: `salvage` names a job that takes minutes, so a
 * pilot must go on salvaging while nobody is saying anything. The chat window
 * only has to carry the order ONCE.
 *
 * ⚠ `stop` IS THE ONLY WAY TO CANCEL ONE EARLY. What it cancels has GROWN, and
 * this comment used to say the opposite of what the code now does: it said
 * `stop` did not stop the ship. It does. `destination` and the standing `follow`
 * both leave the hull moving, so `stop` now also clears the trip, suspends the
 * follow and issues one `stopShip` -- see `withStandingChatOrders`, which owns
 * that half. This function still owns the area job and nothing else.
 *
 * What `stop` still does NOT do: stop the bot, or touch a broadcast or a target
 * call. Those have their own authority and their own freshness, and a companion
 * that went deaf to its fleet because somebody typed one word would be worse
 * than one that kept flying.
 */
function withAreaJob(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  const heard = newestAreaCommand(obs, memory);
  if (heard === null) {
    return memory;
  }
  const next = heard === "stop" ? null : heard;
  return next === memory.areaJob ? memory : { ...memory, areaJob: next };
}

/**
 * A standing area job, cleared if there is nothing left on this grid for it.
 *
 * ⚠ THIS IS WHAT KEEPS THE LATCH FROM BEING A TRAP. Without it a pilot told to
 * salvage stays "salvaging" for the rest of the run, reporting a job it
 * finished minutes ago and never falling back to its own ladder.
 *
 * ⚠ ONLY WHEN THE GRID CAN ACTUALLY BE SEEN. Docked, in warp, or with no
 * snapshot, "no wrecks" means "could not look" and must NOT cancel the job --
 * a pilot fleet-warped away mid-salvage would otherwise arrive with its order
 * silently forgotten.
 */
function withAreaJobCleared(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  const job = memory.areaJob;
  if (job === null) {
    return memory;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return memory;
  }
  const left =
    job === "salvage"
      ? snapshot.entities.some((entity) => entity.kind === "wreck")
      : lootablesOnGrid(obs, memory).length > 0;
  return left ? memory : { ...memory, areaJob: null, salvageWreckID: null };
}

/**
 * The follow range, the trip, the propulsion override and the `stop` gate after
 * this tick's chat.
 *
 * ⚠ THE SAME "A HEARD ORDER LATCHES; SILENCE CHANGES NOTHING" RULE AS
 * `withAreaJob`, applied to the three orders that outlive a chat window by even
 * more than an area job does. A `destination` is a trip of several jumps, a
 * `follow` is a standing behaviour with no end at all, and a `props` override
 * stands until it is countermanded; none could survive being read off the
 * backlog the way a target call is.
 *
 * New command identities are folded in timestamp order rather than scanned
 * per verb. The cursor prevents old backlog lines from resetting completed
 * stops, pending prop changes or a route that is already under way.
 *
 * `stop` is the one word
 * that touches two of these latches, so "which is newer, the stop or the follow"
 * has to be answered for each latch separately -- and answering it with
 * independent newest-of-this-kind scans means a different tie rule per verb and
 * one ordering bug waiting to happen. (`props` is the latch `stop` does NOT
 * touch; it rides this fold anyway, because "the last thing said wins" is the
 * same rule and there is no reason for it to have a second implementation.) Folding new orders onto the memory oldest
 * first gives the plain answer instead: the last thing said wins, per latch,
 * exactly as a reader of the chat would expect.
 *
 * ⚠ SAME SENDER GATE AS EVERY OTHER CHAT ORDER. `commandersFor` is the roster's
 * own commander list, so a stranger in local can neither start a trip nor call
 * one off.
 */
function withStandingChatOrders(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  const senders = commandersFor(obs);
  const heard: { readonly command: ChatCommand; readonly at: number; readonly key: string }[] = [];
  for (const message of obs.chatMessages ?? []) {
    if (!isChatCommandSenderAllowed(message, senders) || !isNewStandingChatMessage(message, memory)) {
      continue;
    }
    const command = parseChatCommand(message);
    if (command === null) {
      continue;
    }
    if (
      command.kind === "follow" ||
      command.kind === "destination" ||
      command.kind === "stop" ||
      command.kind === "props" ||
      command.kind === "targets" ||
      command.kind === "flight" ||
      command.kind === "salvage" ||
      command.kind === "loot" ||
      command.kind === "status" ||
      command.kind === "repair"
    ) {
      heard.push({ command, at: message.createdAtMs, key: standingChatMessageKey(message) });
    }
  }
  if (heard.length === 0) {
    return memory;
  }
  heard.sort((a, b) => a.at - b.at);

  let next = memory;
  for (const { command, at, key } of heard) {
    // Retain identities only at the newest timestamp. Older delayed lines
    // cannot undo a newer standing order; distinct messages tied in time can
    // still arrive on a later poll and take effect once.
    if (next.standingChatCursor?.at === at && next.standingChatCursor.keys.includes(key)) continue;
    next = { ...next, standingChatCursor: { at,
      keys: next.standingChatCursor?.at === at ? [...next.standingChatCursor.keys, key] : [key] } };
    if (command.kind === "salvage" || command.kind === "loot") continue;
    // ⚠ ADDRESSED TO PILOTS, SO EACH PILOT ASKS WHETHER IT IS ONE. A line naming
    // somebody else is still consumed by the cursor above: it was heard, and it
    // was not for this pilot.
    if (command.kind === "status" || command.kind === "repair") {
      if (selectsPilot(command.who, obs.selfCharacterID ?? null, obs.selfCharacterName ?? null)) {
        next = command.kind === "status"
          ? { ...next, supply: { ...next.supply, statusAsked: true } }
          : { ...next, repairOrderedAtMs: at };
      }
      continue;
    }
    if (command.kind === "follow") {
      // ⚠ A `follow` ALSO UN-SUSPENDS. That is the operator's own resume: there
      // is no separate "start following again" verb, and inventing one would
      // leave a companion that was told to stop with no way back into formation
      // short of restarting it.
      next = { ...next, followRangeM: command.rangeM, followHeld: false };
      continue;
    }
    if (command.kind === "destination") {
      next = { ...next, destinationSystemID: command.systemID };
      continue;
    }
    if (command.kind === "props") {
      // ⚠ THE STOPPING LATCH IS CLEARED WITH IT, so a commander who says "props
      // off" and then "props on" before the deactivate has been proven does not
      // find the rung still holding a stale "I am switching this off". The
      // override is the newer statement and wins outright.
      next = { ...next, propsHeld: command.on, propsStoppingID: null };
      continue;
    }
    if (command.kind === "targets") {
      next = { ...next, targetMode: command.mode };
      continue;
    }
    if (command.kind === "flight") {
      // ⚠ `flight auto` UN-SUSPENDS, LIKE `follow`: it is the commander telling
      // the pilot to move again, and a mode switched on that a `stop` still held
      // would be a pilot told to fly itself into reach that sits still.
      next = { ...next, flightMode: command.mode, followHeld: command.mode === "auto" ? false : next.followHeld };
      continue;
    }
    // This is a new stop identity, so it gets one ship stop even when another
    // command from a different sender happened to share its timestamp.
    next = {
      ...next,
      followHeld: true,
      destinationSystemID: null,
      destinationRoutedFor: null,
      stopHeardAtMs: at,
      stopShipIssued: false,
      // A repair trip is an order like a trip is, so `stop` calls it off too: an
      // ordered flee is dropped where it stands. A flee the ship's HEALTH started
      // is not an order and is left alone -- `stop` must never keep a dying ship
      // on the grid.
      repairOrderedAtMs: null,
      flee: next.flee?.ordered === true ? null : next.flee,
    };
  }
  return next;
}

function standingChatMessageKey(message: ChatMessage): string {
  return JSON.stringify([message.characterID, message.createdAtMs, message.message]);
}

function isNewStandingChatMessage(message: ChatMessage, memory: CompanionLadderMemory): boolean {
  const cursor = memory.standingChatCursor;
  return cursor === null || message.createdAtMs > cursor.at ||
    (message.createdAtMs === cursor.at && !cursor.keys.includes(standingChatMessageKey(message)));
}

/**
 * What the `loot` job still has to open here: containers, and wrecks that are
 * legally ours, minus whatever this run has already emptied.
 */
function lootablesOnGrid(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): readonly SpaceEntity[] {
  const finished = obs.lootFinishedItemIDs ?? [];
  return (obs.snapshot?.entities ?? []).filter((entity) => {
    // ⚠ TWO SOURCES, AND BOTH ARE NEEDED. `lootedItemIDs` is this ladder's own
    // record and survives nothing; `lootFinishedItemIDs` is the OUTCOME of the
    // calls actually made. A can only leaves the list when it is genuinely
    // done with, not when it was merely reached for.
    if (memory.lootedItemIDs.includes(entity.itemID) || finished.includes(entity.itemID)) {
      return false;
    }
    return companionMayOpen(entity);
  });
}

/** Whether a `salvage` job is standing right now. */
function salvageWasOrdered(memory: CompanionLadderMemory): boolean {
  return memory.areaJob === "salvage";
}

type NamedChatCommand = Extract<ChatCommand, { readonly kind: NamedChatCommandKind }>;

/**
 * ⚠ ASKED OF `CHAT_ORDER_NAMES` ITSELF, NOT OF A SECOND HAND-TYPED EXCLUSION
 * LIST. This predicate used to spell out `!== "salvage" && !== "loot" && !==
 * "stop"`, which meant the TYPE tripwire above and the RUNTIME test were two
 * copies of the same list -- and TypeScript checks neither against the other,
 * because the return type is a plain boolean whatever the body says. A verb
 * added to the type's exclusion and forgotten here would have passed the build
 * and then indexed `CHAT_ORDER_NAMES` with a kind it does not hold, handing
 * `resolveNamedOrder` an undefined broadcast name and `isOrderActionable` an
 * `itemID` that does not exist on that command at all. Membership in that record
 * IS the definition of a named order, so it is the thing to ask.
 */
function isNamedChatCommand(command: ChatCommand): command is NamedChatCommand {
  return Object.prototype.hasOwnProperty.call(CHAT_ORDER_NAMES, command.kind);
}

function newestNamedChatOrder(
  messages: readonly ChatMessage[],
  allowedSenders: readonly number[],
): { readonly command: NamedChatCommand; readonly at: number; readonly key: string } | null {
  const found = newestChatCommand(messages, allowedSenders, isNamedChatCommand);
  return found === null || !isNamedChatCommand(found.command)
    ? null
    : { command: found.command, at: found.at, key: found.key };
}

/**
 * Can this pilot actually act on that order, here, now?
 *
 * ⚠ THIS IS THE TEST THAT MAKES "FALL THROUGH TO THE NEXT SOURCE" TRUE, and it
 * has to run while choosing the source rather than inside the branch that acts.
 * The rung's header has always said that a call for something not on this grid
 * is skipped "falling through to the next source" -- back when a broadcast was
 * the only source that could not be observed, because the only thing below it
 * was "Standing by". Now that chat is a real next source, an off-grid broadcast
 * that is chosen and only THEN found unactionable does not fall through to
 * anything: it silently starves a perfectly good chat order, and the pilot
 * stands by while somebody with authority is telling it what to shoot.
 *
 * `TravelTo` is the standing exception, for the reason the header gives: its
 * itemID is a solar SYSTEM, not an object, so there is nothing on this grid to
 * check it against.
 *
 * ⚠ AND `WarpTo` IS THE SECOND EXCEPTION, FOR A DIFFERENT REASON: a warp is the
 * one order that is USEFUL at a distance. "Come to me" is the whole point of
 * asking for one, and a pilot who is already on your grid has no need of it. So
 * an id that is not on this grid is checked against the FLEET ROSTER before it
 * is thrown away: a fleet-mate's character id is warpable by the server's own
 * `CmdWarpToStuff("char", …)`, which resolves where that member is itself.
 *
 * ⚠ THE ROSTER, NOT THE COMMANDER LIST. Who may GIVE this order is already
 * settled by the sender gate; this asks only whether the thing named can be
 * warped to, and any member of this fleet can. An id belonging to nobody in the
 * fleet and nothing on the grid is still refused, which is what keeps a
 * mistyped or stale link from becoming a warp to somewhere nobody named.
 *
 * ⚠ A NULL ROSTER IS NOT AN EMPTY ONE, and it must not silently become one:
 * "the roster could not be read" is a reason to refuse a member warp, never a
 * reason to treat every id as a stranger's. Both answers refuse here; the
 * difference matters only in that the refusal is not evidence about the id.
 */
function isOrderActionable(
  name: NamedOrderName,
  itemID: number,
  entities: readonly SpaceEntity[],
  fleetMemberCharacterIDs: readonly number[] | null,
): boolean {
  if (name === "TravelTo") {
    return true;
  }
  if (entityOnGrid(itemID, entities) !== null) {
    return true;
  }
  return name === "WarpTo" && (fleetMemberCharacterIDs ?? []).includes(itemID);
}

/**
 * Which named order this pilot is obeying this tick, from whichever source is
 * entitled to give it one.
 *
 * ⚠ A BROADCAST OUTRANKS A CHAT LINE, and the decided precedence table says so:
 * server fleet warp > FC broadcast > chat command > own flee rule > own ladder.
 * The reason is that a broadcast is the game's own fleet mechanism, carried on
 * a channel only fleet members can reach, while a chat line is text on a
 * channel anybody in the system can type into — it is trustworthy here only
 * because the operator named its sender in advance. When both speak at once,
 * the in-game mechanism is the one that wins.
 *
 * ⚠ STALENESS IS NOT HANDLED HERE, ON PURPOSE. Both sources arrive already
 * freshness-filtered by the observation builder — `fleetBroadcast` against
 * `FLEET_BROADCAST_TTL_MS`, and `chatMessages` against the same window for the
 * same reason. That is what makes a lapsed order fall back to this pilot's own
 * ladder rather than standing forever, and it is deliberately ONE policy rather
 * than two: a chat order that has gone quiet is exactly as stale as a broadcast
 * that has. The one exception is a called gate, held past both until this pilot
 * has jumped: see `withHeardGateCall` and `namedOrderFor`.
 */
function resolveNamedOrder(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
): NamedOrder | null {
  // ⚠ NO CHANNEL GATE. Every source this pilot can hear, it acts on. The
  // `obeys` list that used to wrap each of these branches is gone -- see
  // docs/fleet-companion-simplification.md, "What it listens to". Precedence is
  // unchanged and is still expressed by the ORDER of these branches, which is
  // the only thing that ever decided it.
  const name = asNamedOrderName(obs.fleetBroadcast?.name);
  const itemID = obs.fleetBroadcast?.itemID ?? null;
  if (
    name !== null &&
    itemID !== null &&
    isOrderActionable(name, itemID, entities, obs.fleetMemberCharacterIDs ?? null)
  ) {
    return {
      name,
      itemID,
      source: "broadcast",
      key: broadcastOrderKey(name, itemID, obs.fleetBroadcast),
      heard: ORDER_HEARD[name].broadcast,
      why: ORDER_WHY[name].broadcast,
    };
  }
  const chat = newestNamedChatOrder(obs.chatMessages ?? [], commandersFor(obs));
  if (chat !== null) {
    const chatName = CHAT_ORDER_NAMES[chat.command.kind];
    if (
      !isOrderActionable(
        chatName,
        chat.command.itemID,
        entities,
        obs.fleetMemberCharacterIDs ?? null,
      )
    ) {
      return null;
    }
    return {
      name: chatName,
      itemID: chat.command.itemID,
      source: "chat",
      key: "chat:" + chat.key,
      heard: ORDER_HEARD[chatName].chat,
      why: ORDER_WHY[chatName].chat,
    };
  }
  return null;
}

function broadcastOrderKey(name: NamedOrderName, itemID: number, broadcast: FleetCompanionObservation["fleetBroadcast"]): string {
  return JSON.stringify(["broadcast", name, itemID, broadcast?.senderCharID, broadcast?.receivedAtMs]);
}

/**
 * Who this pilot will take a chat order from: the fleet's own commanders.
 *
 * ⚠ THIS REPLACES A HAND-TYPED LIST OF CHARACTER IDS, AND IT FIXES A BUG RATHER
 * THAN RELAXING A GATE. The settings screen told operators that "whoever the
 * fleet roster already names a commander is obeyed regardless", and that was
 * simply false: the only gate that ever existed was
 * `chatCommandSenders.includes(sender)`, and `flow.ts` did not even FETCH chat
 * unless that list was non-empty. So an FC's chat orders were silently ignored
 * by every companion nobody had typed ids into. This is the screen's own
 * promise, finally implemented.
 *
 * ⚠ AND IT IS NARROWER THAN WHAT IT REPLACED, not wider. A hand-typed list could
 * name anybody, including somebody who is not in the fleet at all. This cannot:
 * the roster is the source, so a commander who leaves stops being obeyed on the
 * next tick without anyone editing anything.
 *
 * ⚠ NULL IS NOT EMPTY. A roster that could not be read yields no commanders and
 * therefore no chat orders, which is the safe answer -- never "anyone will do".
 *
 * The sender id itself is derived server-side from the authenticated session
 * (`chatRuntime.js`) and never from message text, which is what keeps this
 * unspoofable.
 */
function commandersFor(obs: FleetCompanionObservation): readonly number[] {
  return obs.fleetCommanderCharacterIDs ?? [];
}

// ─── Rung 4: tackle → tag ────────────────────────────────────────────────────

/**
 * The letters the retail client's own tag menu offers, in its own order
 * (decompiled `menusvc.py:1946` — `for i in 'ABCDEFGHIJXYZ'`). Not the whole
 * alphabet: K through W are simply not on the menu, and inventing them would
 * hand the fleet letters no player can type back.
 *
 * ⚠ THE NUMBERS ARE DELIBERATELY LEFT ALONE. The same menu also offers 0-9
 * (`menusvc.py:1945`), and the DSL's own `fleet-tag-target` block writes "1" as
 * its "shoot this now" primary. Keeping this rung on letters means a squad
 * running both never fights over the same tag — which matters, because a tag is
 * unique FLEET-WIDE: `setFleetTargetTag` deletes any other item holding the
 * same letter before it sets one (`fleetRuntime.js:1343`).
 */
const FLEET_TACKLE_TAG_LETTERS = "ABCDEFGHIJXYZ";

/**
 * Bound on writes for ONE ship, mirroring the DSL block's own
 * `MAX_FLEET_TAG_ATTEMPTS` and its reasoning: a write whose refusal is
 * invisible must not be resent for ever.
 */
const MAX_COMPANION_TAG_ATTEMPTS = 3;

/** How many given-up ships are remembered. See `taggingGaveUpOn`. */
const MAX_TAGGING_GIVE_UPS = 32;

/**
 * The first menu letter no item currently holds, or null when every one is
 * taken.
 *
 * Compared case-insensitively because the server normalizes a tag only by
 * TRIMMING it (`normalizeFleetTag`, `fleetRuntime.js:267`). A hand-typed "a"
 * and this rung's "A" are two different keys to the server's own uniqueness
 * sweep but the same letter to every human reading the overview, so writing the
 * second one would steal the first one's ship.
 */
function firstFreeTagLetter(tags: ReadonlyMap<number, string>): string | null {
  const taken = new Set<string>();
  for (const tag of tags.values()) {
    taken.add(tag.trim().toUpperCase());
  }
  for (const letter of FLEET_TACKLE_TAG_LETTERS) {
    if (!taken.has(letter)) {
      return letter;
    }
  }
  return null;
}

/** Remember one more give-up, oldest dropped once the cap is reached. */
function rememberGiveUp(gaveUpOn: readonly number[], itemID: number): readonly number[] {
  if (gaveUpOn.includes(itemID)) {
    return gaveUpOn;
  }
  const next = [...gaveUpOn, itemID];
  return next.length <= MAX_TAGGING_GIVE_UPS
    ? next
    : next.slice(next.length - MAX_TAGGING_GIVE_UPS);
}

/**
 * Rung 4: CALL OUT the ship that is holding this one down, so the whole fleet
 * can shoot it. Hands back a decision only on a tick it actually writes — which
 * is few of them — so everything below it keeps its turn.
 *
 * ⚠ TWO WAYS TO CALL A SHIP, AND WHICH ONE THIS PILOT HAS IS NOT ITS CHOICE.
 * Lettering a target (`setFleetTargetTag`) is a COMMANDER's job — the fleet
 * boss, a wing or squad commander, or the fleet's creator, and nobody else
 * (fleetRuntime.js:1317). Broadcasting `Target` is EVERY member's
 * (fleetRuntime.js:2521 gates on membership and nothing more). A companion alt
 * joins somebody else's fleet as a plain member and will never be promoted, so
 * for the overwhelming majority of runs the first way is shut for good.
 *
 * This rung therefore does not HAVE a commander check in the sense of a thing
 * it might fail. It has a fork:
 *
 *   canTag === true   ->  letter it (stable, survives the tick, re-readable)
 *   canTag === false  ->  broadcast it, if this pilot is in a fleet at all
 *   canTag === null   ->  the roster is unreadable; say nothing this tick
 *
 * A previous version of this rung stopped dead on the middle line, and the
 * readout it fed said "cannot tag, not a fleet commander" — true about the
 * letter, and quite wrong about the pilot, which had a perfectly good way to
 * name its tackler and was not using it.
 *
 * ⚠ THE TWO ARMS ARE NOT THE SAME PROMISE AND MUST NOT BE DESCRIBED AS ONE. A
 * tag is fleet STATE: it sits on the ship, anyone reading the fleet sees it,
 * and it can be confirmed by reading it back. A broadcast is an EVENT: it
 * arrives once, in the broadcast window, and leaves nothing behind. That is
 * why the arms have different budgets (attempts-and-give-up versus called-once)
 * and different memories (`lastTagIssuedFor` versus `tackleCalledOut`).
 *
 * ⚠ IT SITS **ABOVE** OBEYING THE FLEET, AND THAT IS THE WHOLE REASON IT WORKS.
 * `decideFleetOrders` PARKS THE TICK once a target call stands and is locked
 * (see its own header). A standing FC primary is precisely the situation a
 * fleet fight is in while this pilot is being scrambled, so a tag rung placed
 * beneath it would be starved exactly when it has something to say. Above it,
 * the cost is bounded and small: at most `MAX_COMPANION_TAG_ATTEMPTS` writes
 * per tackler and then it falls through for good, so it can delay engaging a
 * called primary by a few ticks and never by more.
 *
 * ⚠ AND IT NEVER RETURNS A `wait`. Other rungs park to keep the readout honest;
 * this one has no branch that does, because a rung that parks starves the
 * ladder beneath it and this one has nothing worth starving anything for.
 * "Nothing to tag" and "cannot tag" both read as falling through.
 *
 * ⚠ IT RETURNS ITS MEMORY EVEN WHEN IT DECIDES NOTHING — the same shape
 * `decideTankUp` has, for the same reason. Giving up on a ship happens on a
 * tick that issues NO action, so a signature that dropped the memory on `null`
 * could never record the give-up, and the rung would hand back the same
 * unconfirmable ship for ever.
 *
 * The candidates are the ships the JAM PUSHES NAMED (`obs.tackledBy`), not a
 * ranking of the grid.
 *
 * ⚠ AND THEY ARE RESOLVED AGAINST `snapshot.entities`, NOT AGAINST
 * `hostileRows`. The phase spec said to rank with `hostileRows` + `pickPrimary`,
 * its point being that this pilot's own LOCK RANGE must not suppress a tag a
 * ship further out could use — which stands, and is honoured. But `hostileRows`
 * filters on `isHostile`, and `isHostile` is `entity.isNpc &&
 * npcEntityType !== "concord"`: it answers NPC-or-not, so every PLAYER tackler
 * fails it. Filtering through it would have silently dropped exactly the case
 * this feature exists for — a fleet fight against players — and would have done
 * so with no error anywhere. A ship running a scrambler on you has classified
 * itself; nothing else needs to agree.
 *
 * Ranking is `pickPrimary`'s, so a host that populates `targetGroupNames` gets
 * class priority and one that does not collapses to nearest-first — the same
 * ordering the rest of this client's combat code uses, never a second one.
 */
function decideTackleTag(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const nothing = { decision: null, memory } as const;
  // ⚠ NO OPERATOR GATE. Every companion calls out what has it tackled, and the
  // three things below are what make that safe rather than a shouting match:
  //
  //   1. THE SERVER IS THE REAL GATE ON THE LETTER. Only a fleet creator,
  //      leader, wing or squad commander may tag, and `obs.canTag` mirrors that
  //      test off the roster. In an ordinary fleet the companions are plain
  //      members and this rung never writes a letter, whatever anybody ticked —
  //      it broadcasts instead, which is the call plain members do have.
  //   2. A SHIP ALREADY CALLED IS SKIPPED, in BOTH arms: lettered ships are
  //      filtered out below (so a second tagger leaves an existing letter
  //      alone) and `tackleCalledOut`/`tackleCalledAtMs` bound the broadcast
  //      arm: a ship is called once, and again only after the fleet's call has
  //      moved off it, at most every `TACKLE_RECALL_MS` (so two pilots cannot
  //      re-call their tacklers back and forth every tick).
  //   3. THE TRIGGER IS NARROW: only ships tackling THIS pilot are candidates.
  //      A standing commander's call does NOT silence it: tacklers die first
  //      (operator, 2026-10-13), see `decideTackleBroadcast`.
  //
  // The `attemptsTagging` checkbox that used to stand here gated behaviour that
  // was already exactly what was asked for -- call out what is holding you
  // down, and only that. See docs/fleet-companion-simplification.md, "Tagging".
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return nothing;
  }
  // ⚠ THREE STATES, AND THE THIRD IS SILENCE. `null` is "could not read the
  // roster" — it is not evidence this pilot lacks command, so it must not send
  // this rung down the broadcast arm any more than it may send it down the tag
  // arm. Nothing is remembered either way: a `null` cached as an answer would
  // freeze a transient roster outage into a settled verdict for the whole run.
  const canTag = obs.canTag ?? null;
  if (canTag === null) {
    return nothing;
  }
  const tacklers = obs.tackledBy ?? [];
  if (tacklers.length === 0) {
    return nothing;
  }
  // ⚠ NULL HERE IS FATAL TO THE LETTER AND HARMLESS TO THE BROADCAST, which is
  // why it is read once and checked in the arm that cares. `null` means this
  // client has never received an `OnFleetStateChange` (or could not parse one),
  // so it cannot tell which letters are free — and a tag is unique fleet-wide,
  // so guessing "A" would silently steal the letter off whatever the FC had
  // already marked. A broadcast claims no letter and so needs no such reading;
  // it only USES the dict, when there is one, to avoid re-calling a ship the
  // commander has already marked. This is the caller `fleetBroadcasts.ts`'s
  // null-versus-empty contract was written for: an EMPTY map is a real answer.
  const tags = obs.fleetTargetTags ?? null;

  if (canTag === false) {
    return decideTackleBroadcast(obs, memory, snapshot, tacklers, tags, nowMs);
  }
  if (tags === null) {
    return nothing;
  }

  const candidates = tacklers
    .map((itemID) => entityOnGrid(itemID, snapshot.entities))
    .filter((entity): entity is SpaceEntity => entity !== null)
    // Already lettered? Leave it alone. This is the rule that keeps the fleet's
    // letters STABLE — a ship that is B stays B for as long as it lives — and it
    // is also what makes the server's uniqueness sweep harmless in practice,
    // because this rung then only ever assigns letters nothing holds.
    .filter((entity) => !tags.has(entity.itemID))
    .filter((entity) => !memory.taggingGaveUpOn.includes(entity.itemID));
  if (candidates.length === 0) {
    return nothing;
  }

  const measurement = measureSpace(snapshot);
  const groups = obs.targetGroupNames ?? null;
  const target =
    pickPrimary(
      candidates,
      (entity) => entity.typeID,
      (entity) => measurement?.distances.get(entity.itemID) ?? null,
      (typeID) => (groups === null ? null : (groups[typeID] ?? null)),
    ) ?? candidates[0]!;

  // The budget, spent per SHIP. A fresh candidate re-stamps it; the same one
  // coming back means the previous write has not shown up in `fleetTargetTags`
  // yet, which is ordinary for a tick or two and hopeless after three.
  const attempts = memory.lastTagIssuedFor === target.itemID ? memory.lastTagAttempts : 0;
  if (attempts >= MAX_COMPANION_TAG_ATTEMPTS) {
    return {
      decision: null,
      memory: {
        ...memory,
        lastTagIssuedFor: null,
        lastTagAttempts: 0,
        taggingGaveUpOn: rememberGiveUp(memory.taggingGaveUpOn, target.itemID),
      },
    };
  }

  const letter = firstFreeTagLetter(tags);
  if (letter === null) {
    // Every menu letter is in use. Writing anyway would delete somebody else's
    // tag to make room, which is the one thing this rung must never do.
    return nothing;
  }

  return {
    decision: {
      action: { kind: "setFleetTargetTag", targetID: target.itemID, tag: letter },
      phase: "Tagging",
      why:
        attempts === 0
          ? `Something has this ship scrambled. Marking it ${letter} for the fleet.`
          : `Still waiting for the ${letter} tag to show up, and marking it again.`,
      memory: {
        ...memory,
        lastTagIssuedFor: target.itemID,
        lastTagAttempts: attempts + 1,
      },
    },
    memory,
  };
}

/**
 * Rung 4's other arm: this pilot is in a fleet and is NOT a commander, so the
 * ship holding it down gets called out by `Target` broadcast instead of
 * lettered. Reached only from `decideTackleTag` with `canTag === false`.
 *
 * ⚠ THIS IS THE ARM THAT ACTUALLY RUNS, in nearly every real fleet. A companion
 * alt is a plain member; the tag arm above it is for the unusual run where the
 * companion IS the boss (it formed the fleet itself, say, or the player made it
 * a squad commander). Treat this one as the main path when reasoning about the
 * rung's cost, not as a fallback that rarely fires.
 *
 * ⚠ `canBroadcast` IS CHECKED SEPARATELY AND IS NOT IMPLIED BY `canTag ===
 * false`. That verdict covers both "in a fleet, not a commander" and "in no
 * fleet at all" (see `canTagInFleet`), and only the first of those has anybody
 * to broadcast to. `undefined` — a host that does not populate the field — is
 * treated as unknown and stays silent, deliberately: a broadcast is an outward
 * act, and an outward act on an unread gate is exactly the guess this loop's
 * three-state discipline exists to forbid.
 *
 * ⚠ LOUD, AND ABOVE ANY COMMANDER'S CALL (operator, 2026-10-13: "tackle
 * callouts should be loud and clear, as tacklers should be killed first, no
 * matter FC instructions"). The callout goes out whether or not a `Target` call
 * already stands, and it becomes the newest call every companion obeys.
 *
 * ⚠ ONCE, THEN AGAIN ONLY WHEN THE FLEET HAS BEEN CALLED OFF IT, and rate
 * limited. A broadcast leaves nothing to re-read, so re-sending it while the
 * fleet's call still names this pilot's tackler (its own echo included: the
 * server delivers a broadcast to its sender) would only be the same shout again.
 * Once the standing call (the slot, or the call held past it,
 * `standingTargetCallID`) names none of this pilot's tacklers -- the FC called
 * something else, or the call lapsed -- the tackler is called again, at most
 * once per `TACKLE_RECALL_MS` per ship and never within
 * `TACKLE_RECALL_GAP_MS` of this pilot's last callout. That bound is what keeps
 * two pilots held by two different ships from flipping the fleet every tick:
 * each re-sends at most every ten seconds, and each shoots its own tackler
 * meanwhile regardless (`ownTackler`). `tackleCalledOut` says which ships were
 * called, `tackleCalledAtMs` when.
 *
 * ⚠ AND THE SERVER WOULD DROP MOST OF THE RE-SENDS ANYWAY.
 * `isBroadcastRateLimited` (fleetRuntime.js:2473) refuses a repeat of the same
 * broadcast name inside `MIN_BROADCAST_TIME_SEC` — 2 seconds, which is exactly
 * `FLEET_COMPANION_CADENCE_MS`. Two new tacklers arriving on consecutive ticks
 * sit right on that boundary and one of the two calls may be dropped. It is
 * left to be dropped: the call is bounded, the refusal is visible in the ack
 * (unlike a tag's), and spacing sends out over ticks would mean holding a
 * queue of ships to shout about, which is a worse thing to own than a missed
 * shout about a ship this pilot is already shooting.
 */
function decideTackleBroadcast(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  snapshot: SpaceSnapshot,
  tacklers: readonly number[],
  tags: ReadonlyMap<number, string> | null,
  nowMs: number,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const nothing = { decision: null, memory } as const;
  if (obs.canBroadcast !== true) {
    return nothing;
  }

  const onGrid = tacklers
    .map((itemID) => entityOnGrid(itemID, snapshot.entities))
    .filter((entity): entity is SpaceEntity => entity !== null)
    // ⚠ ALREADY LETTERED IS ALREADY CALLED. A commander has marked this ship;
    // broadcasting it as well would put a second, louder call on a target the
    // fleet is already pointed at — and because a `Target` broadcast is the
    // NEWEST call every companion hearing it obeys, it would also shove aside
    // whatever primary the commander had standing. Nothing to gain, a real
    // fleet-wide cost. When `tags` is null this filter cannot run and does not:
    // an unreadable dict is not a reason to stay quiet about being tackled.
    .filter((entity) => tags === null || !tags.has(entity.itemID));
  const calledAt = memory.tackleCalledAtMs ?? {};
  let candidates = onGrid.filter((entity) => !memory.tackleCalledOut.includes(entity.itemID));
  let recall = false;
  if (candidates.length === 0) {
    // Every tackler has been called once. Again only when the fleet's call names
    // none of them, and only inside the rate limit -- see the header.
    const standing = standingTargetCallID(obs, memory, snapshot.entities);
    const lastAny = Math.max(-Infinity, ...Object.values(calledAt));
    if (onGrid.some((entity) => entity.itemID === standing) || nowMs - lastAny < TACKLE_RECALL_GAP_MS) {
      return nothing;
    }
    candidates = onGrid.filter((entity) => nowMs - (calledAt[entity.itemID] ?? -Infinity) >= TACKLE_RECALL_MS);
    recall = true;
    if (candidates.length === 0) {
      return nothing;
    }
  }

  // Same ranking as the tag arm, and for the same reason: one ordering for
  // combat across this whole client, never a second one invented per rung.
  const measurement = measureSpace(snapshot);
  const groups = obs.targetGroupNames ?? null;
  const target =
    pickPrimary(
      candidates,
      (entity) => entity.typeID,
      (entity) => measurement?.distances.get(entity.itemID) ?? null,
      (typeID) => (groups === null ? null : (groups[typeID] ?? null)),
    ) ?? candidates[0]!;

  return {
    decision: {
      action: { kind: "broadcastFleetTarget", targetID: target.itemID },
      phase: "Tagging",
      // ⚠ SAYS WHICH CALL IT MADE, not just that it called. The readout is the
      // only place a player can learn that this pilot broadcasts rather than
      // letters, and "marking it for the fleet" would hide exactly that.
      why: recall
        ? "Something still has this ship scrambled and the fleet has been called off it. Broadcasting it again as the target."
        : "Something has this ship scrambled. Broadcasting it to the fleet as the target.",
      memory: withTackleCalled(memory, target.itemID, nowMs),
    },
    memory,
  };
}

/** How long before this pilot calls the same tackler again. See `decideTackleBroadcast`. */
export const TACKLE_RECALL_MS = 10_000;
/**
 * The least time between two of this pilot's callouts when one is a re-send:
 * two ticks, so never on consecutive ticks, and clear of the server's own
 * two-second same-name limit (`isBroadcastRateLimited`).
 */
export const TACKLE_RECALL_GAP_MS = 2 * FLEET_COMPANION_CADENCE_MS;

/** Record a callout of `itemID` at `nowMs`, keeping the time map to the capped list. */
function withTackleCalled(memory: CompanionLadderMemory, itemID: number, nowMs: number): CompanionLadderMemory {
  // Capped the same way, and by the same helper, as the tag arm's give-up
  // list: both exist to stop one rung re-picking one ship for ever, and a
  // fight long enough to overflow one has overflowed both.
  const calledOut = rememberGiveUp(memory.tackleCalledOut, itemID);
  const calledAt: Record<number, number> = {};
  for (const id of calledOut) {
    const at = id === itemID ? nowMs : memory.tackleCalledAtMs?.[id];
    if (at !== undefined) {
      calledAt[id] = at;
    }
  }
  return { ...memory, tackleCalledOut: calledOut, tackleCalledAtMs: calledAt };
}

// ─── Rung 5: flee ────────────────────────────────────────────────────────────
//
// ⚠ ABOVE THE FLEET RUNG, AND THAT IS A DECISION THE OPERATOR MADE RATHER THAN
// A DEFAULT ANYBODY INHERITED. The plan doc's decision 3 used to read
//
//     server fleet warp > FC broadcast > chat command > own flee rule
//
// which put a standing target call above a pilot's own survival. Phase 5's
// parking fix had already removed the worst of that -- a STANDING call is held
// aside and no longer ends the tick -- but a call with something real left to
// issue still wins outright, and `lockThenEngage` issues one lock plus one
// activate per weapon before it goes quiet. On a fresh primary with six guns
// that is seven ticks, about fourteen seconds at this loop's cadence, and an FC
// that keeps re-calling extends it without limit.
//
// The operator was asked and chose the flee. Decision 3 in the plan doc was
// amended to match rather than left contradicting the code.
//
// ⚠ WHAT STAYS ABOVE IT: rung 1's warp yield (a fleet already leaving does not
// need this pilot's opinion, and that half was never in dispute), rung 2's
// supervision gate, rung 3's tank up and rung 4's tackle-tag. The last two
// matter for a reason the phase 6 spec called out: a ship running away must
// keep hardening and must keep lettering whatever is holding it, and rungs that
// sit ABOVE the flee get that for free with no nesting. Both fall through the
// moment they have nothing to issue -- which rung 3 only started reliably doing
// once its unreadable-module-map spin was fixed, in the commit before this one.

/**
 * Count a quiet tick towards putting the flee budget back.
 *
 * Runs only on ticks where the pilot is NOT fleeing and NOT below its floor,
 * which is what "a return that holds" means in practice. A pilot that never
 * fled counts too and nothing happens, because resetting a budget of zero is
 * the same as leaving it alone.
 */
function countTowardsRecovery(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionLadderMemory {
  if (memory.fleeTripsSpent === 0) {
    return memory;
  }
  // ⚠ THE HARDER THRESHOLD, not the floor. A pilot limping along just above the
  // number that would send it running has not recovered from anything, and
  // letting that count would hand the budget back to the pilot least able to
  // spend it well.
  if (!healthClearOfTheMark(request, obs)) {
    return memory.fleeRecoverySinceMs === null
      ? memory
      : { ...memory, fleeRecoverySinceMs: null };
  }
  // The first well tick STARTS the span; every later one only reads it.
  if (memory.fleeRecoverySinceMs === null) {
    return { ...memory, fleeRecoverySinceMs: nowMs };
  }
  if (nowMs - memory.fleeRecoverySinceMs < FLEE_RECOVERY_HOLD_MS) {
    return memory;
  }
  return { ...memory, fleeRecoverySinceMs: null, fleeTripsSpent: 0 };
}

/** What rung 5 hands back: a decision when it has one, and always its memory. */
interface FleeStep {
  readonly decision: CompanionDecision | null;
  readonly memory: CompanionLadderMemory;
}

/**
 * Rung 5: leave while there is still a ship to leave in.
 *
 * ⚠ THE TRIGGER IS `obs.health`, WHICH IS ALREADY THE WORST LAYER. `lowestHealth`
 * folds shield, armour and hull to their minimum and skips any layer that could
 * not be read, and `observe()` runs it every tick. That matches what the field
 * has always promised -- `fleeHealthFloor` is documented as "remaining fraction
 * of ANY health layer that starts a flee" -- so no new read and no new fold.
 */
function decideFlee(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): FleeStep {
  memory = withRepairOrder(request, obs, memory, nowMs);
  const running = memory.flee;
  if (running !== null) {
    return flyTheFlee(request, obs, memory, running, nowMs);
  }

  // ⚠ NULL IS NOT "HEALTHY", and this is the same three-state discipline the
  // tank-up rung keeps about a layer ratio and the stand-down keeps about
  // `hostileOnGrid`. A health read that could not answer is not evidence the
  // ship is whole, and it is not evidence the ship is dying either. Fleeing
  // blind would abandon a fleet on a dropped poll; the honest answer is to
  // decide nothing this tick and look again in two seconds.
  const health = tankHealth(request, obs);
  if (health === null || health >= request.fleeHealthFloor) {
    return { decision: null, memory: countTowardsRecovery(request, obs, memory, nowMs) };
  }

  // Dropped through the floor, so whatever recovery was being counted is over.
  const hurt: CompanionLadderMemory = { ...memory, fleeRecoverySinceMs: null };

  // ⚠ THE BUDGET IS CHECKED BEFORE THE LATCH, NOT INSIDE THE LEG. A pilot that
  // has spent its round trips is a pilot the operator told to stay home
  // ("Stay home after N flee round trips", in the panel's own words), and
  // staying home has to mean not starting a new trip rather than starting one
  // and stopping partway.
  if (memory.fleeTripsSpent >= request.maxFleeAttempts) {
    return { decision: null, memory: hurt };
  }

  const latched: CompanionFlee = {
    triggeredAtMs: nowMs,
    triggeredAtHealth: health,
    fromSolarSystemID: obs.flightStatus?.solarSystemID ?? null,
    repairAttempts: 0,
    onlyTheShieldWasHurt: armorAndHullClearOfTheMark(request, obs),
    arrivedSafe: false,
    safeSpotWarpIssued: false,
    safeSpotWarpAttempts: 0,
    safeSpotWarpWaited: 0,
    safeSpotWarpSeen: false,
    droneRecallWaited: null,
  };
  const started: CompanionLadderMemory = {
    ...hurt,
    flee: latched,
    fleeTripsSpent: memory.fleeTripsSpent + 1,
    // ⚠ THE DRONE ROTATION DIES HERE, and the phase 6 spec asked for exactly
    // this: "flee outranks drone redeploy -- enforce it at runtime, not by
    // authoring order". The rung already sits above the drone rung, so this is
    // the belt to that braces: a rotation left standing would have rung 6
    // trying to put a drone back out of a ship that is in the middle of
    // leaving. Nothing is lost by dropping it -- the outbound leg recalls
    // everything this ship controls before it commits to a warp, whichever rung
    // launched it.
    droneRotation: emptyDroneRotationMemory(),
    // A rejoin under way is over: the return leg after this flee starts its own.
    rejoin: null,
  };
  return flyTheFlee(request, obs, started, latched, nowMs);
}

/**
 * A `repair` heard for this pilot, taken up: an ordered trip to a station in
 * this system, or the consent to pay added to a flee already under way, or --
 * with no station to go to -- a line in chat saying so. The order is cleared in
 * every case; it is a hand-off, not a latch. See `CompanionFlee.ordered`.
 *
 * ⚠ IN THIS SYSTEM ONLY. The trip is the flee's own leg, which docks at the
 * nearest station in the scene and otherwise warps to the sun. A sun has no
 * repair shop, so an ordered trip with no station in view is refused out loud
 * rather than flown somewhere that cannot do what was asked.
 */
function withRepairOrder(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionLadderMemory {
  if (memory.repairOrderedAtMs === null) {
    return memory;
  }
  const cleared: CompanionLadderMemory = { ...memory, repairOrderedAtMs: null };
  const running = memory.flee;
  const stationInView = (obs.snapshot?.entities ?? []).some((entity) => DOCKABLE_KINDS.has(entity.kind ?? ""));
  if (running !== null) {
    if (running.repairPaid === true) {
      return cleared;
    }
    noteSay("Already leaving the fight. Will pay for the repair once docked.");
    // The shop's quote decides from here: a shield-only stamp would undock a
    // ship nobody has looked at, and the commander asked for it to be looked at.
    const paid: CompanionFlee = { ...running, repairPaid: true, onlyTheShieldWasHurt: false };
    if (obs.docked === true || !running.arrivedSafe || !stationInView) {
      return { ...cleared, flee: paid };
    }
    // Waiting at the sun, with a station in the system: fly the leg again, which
    // docks before it ever looks at the sun (`holdAtTheSafeSpot`'s own reroute).
    const { safeSpotWarpBackoff: _backoff, ...rest } = paid;
    return { ...cleared, flee: { ...rest, arrivedSafe: false, safeSpotWarpIssued: false, safeSpotWarpSeen: false,
      safeSpotWarpAttempts: 0, safeSpotWarpWaited: 0, droneRecallWaited: null } };
  }
  if (obs.docked !== true && !stationInView) {
    noteSay("Cannot repair: no station in this system.");
    return cleared;
  }
  noteSay(obs.docked === true ? "Repairing here, then coming back." : "Going to dock and repair, then coming back.");
  const ordered: CompanionFlee = {
    triggeredAtMs: nowMs,
    triggeredAtHealth: tankHealth(request, obs) ?? 1,
    fromSolarSystemID: obs.flightStatus?.solarSystemID ?? null,
    repairAttempts: 0,
    onlyTheShieldWasHurt: false,
    arrivedSafe: false,
    ordered: true,
    repairPaid: true,
    safeSpotWarpIssued: false,
    safeSpotWarpAttempts: 0,
    safeSpotWarpWaited: 0,
    safeSpotWarpSeen: false,
    droneRecallWaited: null,
  };
  // As a flee's latch does: the rotation and a rejoin under way end here, and
  // the leg recalls every drone before it warps.
  return { ...cleared, flee: ordered, droneRotation: emptyDroneRotationMemory(), rejoin: null };
}

/**
 * How far ABOVE its floor a ship has to be before it goes back.
 *
 * ⚠ WITHOUT A MARGIN A RETURN IS A COMMUTE. Coming back at exactly the floor
 * means the very next tick reads the same number and flees again, spending the
 * whole budget on one fight without ever firing a shot. The margin is capped at
 * 1 so a jumpy floor (0.8, say) asks for a whole ship rather than an impossible
 * 1.0-plus.
 *
 * It rarely binds, and that is by design rather than by luck: docking gives the
 * shield and the capacitor back in full, so a shield-triggered flee is already
 * whole on arrival, and a repaired armour flee is too. What it catches is the
 * case in between -- a pilot that cannot repair, healing slowly on its own.
 */
const FLEE_RETURN_MARGIN = 0.2;

/**
 * How long back on station with nothing wrong before a round trip counts as
 * having WORKED and the budget goes back to full.
 *
 * The spec's rule, in its words: "an attempt is spent when the same condition
 * re-fires shortly after a return; a return that holds resets the budget."
 * A span is how "holds" is made checkable -- a pilot that comes back and
 * immediately drops through its floor again never reaches this, so its trips
 * keep accumulating and it eventually stays home, which is the whole point of
 * the bound.
 *
 * Thirty seconds, which is the duration the fifteen ticks this replaces were
 * written to mean. See `fleeRecoverySinceMs` for why a count could not keep
 * meaning it.
 */
const FLEE_RECOVERY_HOLD_MS = 30_000;

/**
 * How many times the shop is asked before a hurt pilot gives up on repairing.
 *
 * The DSL's `repair-ship` block keeps the same bound for the same reason, and
 * its comment names the likeliest cause: the shop quietly not fixing things
 * because there is not enough money. A pilot that cannot pay must stop asking
 * rather than ask for ever.
 */
const MAX_FLEE_REPAIR_ATTEMPTS = 3;

/**
 * How long a flee waits at a safe spot with its tank not rising before it stops
 * waiting for the return mark.
 *
 * ⚠ A HOLD THAT WAITS FOR HEALTH MUST NEVER BE FOR EVER. Seen live 2026-10-14
 * 09:13-10:05: a companion read "not well enough yet to go back to the fight"
 * every tick for 52 minutes, its tank between its floor and its return mark, in
 * a layer nothing was repairing. That hold was the rejoin's, which no longer
 * waits for the mark at all (see `decideRejoinCommander`), but the safe-spot
 * hold below has the same shape: armour and hull do not heal on their own, so a
 * ship with no repairer cycling for the gating layer stays exactly as hurt for
 * as long as anybody cares to wait.
 *
 * Measured from the last time the tank ROSE (by more than `FLEE_RECOVERY_RISE`),
 * not from arrival, so a shield regenerating or a repairer cycling keeps the
 * wait going for as long as it is getting somewhere. Two minutes is many
 * repairer cycles and a visible slice of any passive shield regeneration; a
 * reading that has not moved in that long is not going to.
 */
const FLEE_RECOVERY_STALL_MS = 120_000;
/** The rise that counts as progress for `FLEE_RECOVERY_STALL_MS`: half a percent, above read jitter. */
const FLEE_RECOVERY_RISE = 0.005;

/**
 * The health that decides whether this ship is in trouble: the worst of the
 * layers its TANK is actually made of, and nothing above them.
 *
 * ⚠ THE WORST OF ALL THREE LAYERS IS THE WRONG NUMBER, AND ON AN ARMOUR-TANKED
 * HULL IT IS CATASTROPHICALLY WRONG. Damage on this server eats shield, then
 * armour, then hull, whatever the fit — so an armour tank's shield is not its
 * tank at all, it is the thing that empties in the first seconds of every fight
 * on the way to the layer that matters. `lowestHealth` folds all three, so a
 * cruiser with an armour repairer and a 30% floor ran for the door the moment
 * its shield dipped, before its repairer had cycled once. Reported live,
 * 2026-09-13: "they run away when shield is down instead of turning on armor
 * repair and waiting for armor going below threshold".
 *
 * ⚠ WHAT COUNTS IS READ OFF THE HULL, NEVER GUESSED AT. The self-repair lists
 * are derived from the fit at start (`requestForFit`), and the shallowest layer
 * this ship can repair is the layer it is tanked in: everything above that is
 * buffer, and everything at or below it is the tank. A shield booster means the
 * shield counts (and so, beneath it, do armour and hull); an armour repairer
 * with no booster means the shield is ignored and the armour is the trigger,
 * which is the behaviour asked for above. This is the same authority rung 3
 * already cycles the repairers from, so a ship flees on the layer it defends.
 *
 * ⚠ A HULL WITH NO SELF-REPAIRER FALLS BACK TO WHAT IT IS BUILT OF. A buffer fit
 * cycles nothing, so it makes no statement this loop can read off an activation
 * list — plates and extenders are PASSIVE and never reach one. `request.tankLayer`
 * is that hull's answer, voted at start over the game's own group names (see the
 * field), and it is consulted ONLY here, only when nothing repairable said so
 * first. A fit that voted for neither keeps the old worst-layer fold, which is
 * the honest answer for a hull that genuinely does not say.
 *
 * `null` when no counted layer could be read, which is never "well" and never
 * "dying" — the callers keep that three-state discipline themselves.
 */
function tankHealth(request: FleetCompanionRequest, obs: FleetCompanionObservation): number | null {
  return tankRead(request, obs).health;
}

/** The layer names `tankRead` reports, deepest last. */
type HealthLayer = "shield" | "armor" | "hull";

/**
 * `tankHealth`, with the layer the reading came from: the counted layer that is
 * lowest, which is the one any hold on that reading is waiting for. `layer` is
 * null when the reading is the snapshot's own fold (no layer ratio arrived).
 */
function tankRead(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
): { readonly health: number | null; readonly layer: HealthLayer | null } {
  const layers = [
    {
      name: "shield",
      ratio: obs.shieldRatio,
      repaired: request.shieldBoosterModuleIDs.length > 0,
    },
    {
      name: "armor",
      ratio: obs.armorRatio,
      repaired: request.armorRepairerModuleIDs.length > 0,
    },
    { name: "hull", ratio: obs.hullRatio, repaired: request.hullRepairerModuleIDs.length > 0 },
  ] as const;
  const repaired = layers.findIndex((layer) => layer.repaired);
  // The repairable layer outranks the vote: a hull that can switch something on
  // has said where its tank is far more plainly than its plates can.
  const tank =
    repaired !== -1
      ? repaired
      : request.tankLayer === null
        ? -1
        : layers.findIndex((layer) => layer.name === request.tankLayer);
  const counted = tank === -1 ? layers : layers.slice(tank);
  let lowest: { readonly name: HealthLayer; readonly ratio: number } | null = null;
  for (const layer of counted) {
    const ratio = layer.ratio;
    if (ratio !== null && ratio !== undefined && Number.isFinite(ratio) && (lowest === null || ratio < lowest.ratio)) {
      lowest = { name: layer.name, ratio };
    }
  }
  // ⚠ THE SNAPSHOT'S OWN FOLD IS THE FALLBACK, not a zero and not a refusal. A
  // tick whose layer ratios did not arrive but whose `health` did is a tick that
  // still knows something, and on a hull with nothing to narrow by the two
  // numbers are the same number anyway.
  return lowest === null ? { health: obs.health ?? null, layer: null } : { health: lowest.ratio, layer: lowest.name };
}

/**
 * The trace a health hold writes (companionTrace.ts `HealthTrace`): the reading,
 * the layer it came from, the two thresholds, and whether anything fitted is
 * able to raise that layer -- a hold on a layer with no repairer running is a
 * hold that only time, a station or nothing at all will end.
 */
function healthTrace(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  code: HealthCode,
  stalledMs?: number,
): HealthTrace {
  const read = tankRead(request, obs);
  const fitted = read.layer === "shield"
    ? request.shieldBoosterModuleIDs
    : read.layer === "armor"
      ? request.armorRepairerModuleIDs
      : read.layer === "hull"
        ? request.hullRepairerModuleIDs
        : [];
  const active = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const repairer = fitted.length === 0
    ? "none"
    : active === null
      ? "unread"
      : fitted.some((moduleID) => active.includes(moduleID)) ? "running" : "fitted";
  return {
    code,
    tank: read.health,
    layer: read.layer,
    floor: request.fleeHealthFloor,
    mark: returnMark(request),
    repairer,
    ...(stalledMs === undefined ? {} : { stalledMs }),
  };
}

/**
 * The health a returning pilot has to be at: its floor plus the margin, capped
 * at a whole ship. One definition, because three different questions ask it —
 * the return itself, and the two layer reads the trigger stamps.
 */
function returnMark(request: FleetCompanionRequest): number {
  return Math.min(1, request.fleeHealthFloor + FLEE_RETURN_MARGIN);
}

/**
 * The tank fraction below which a run to safety leaves its drones: the
 * operator's own number, or half the flee floor for a setup saved before there
 * was one. See `abandonDronesHealthFloor`.
 */
export function abandonDronesFloor(
  setup: Pick<CompanionSetup, "fleeHealthFloor" | "abandonDronesHealthFloor">,
): number {
  return setup.abandonDronesHealthFloor ?? setup.fleeHealthFloor / 2;
}

/**
 * Whether the armour AND the hull are both readable and both already clear of
 * the return mark — i.e. whatever is wrong with this ship is wrong with its
 * SHIELD, which a dock puts back in full.
 *
 * ⚠ NULL IS NEVER "CLEAR". A layer that did not read is a layer this pilot
 * cannot claim is whole, and claiming it would send a hurt ship back into a
 * fight on no information. False is the safe direction and costs only a quote.
 */
function armorAndHullClearOfTheMark(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
): boolean {
  const mark = returnMark(request);
  const armor = obs.armorRatio ?? null;
  const hull = obs.hullRatio ?? null;
  return armor !== null && hull !== null && armor >= mark && hull >= mark;
}

/**
 * Whether a ship is well enough to go back to the fight it left.
 *
 * ⚠ A DIFFERENT QUESTION FROM THE ONE THAT STARTED THE FLEE, and deliberately a
 * harder one to answer yes to. See `FLEE_RETURN_MARGIN`.
 *
 * ⚠ IT IS ALSO A DIFFERENT QUESTION IN A STATION THAN IT IS IN SPACE, and
 * asking the space question in a station is the bug this branch exists to end.
 * `obs.health` is folded from the SPACE snapshot, and a docked ship has none —
 * so every docked tick reads `null`, and "unreadable is not well" (true and
 * right in space) meant no pilot that fled to a station ever came back out.
 * Two things answer it in there instead, in this order:
 *
 *   1. The flee's own stamp. A flee that started with the armour and the hull
 *      already clear of the mark is whole on arrival, because docking gives the
 *      shield back in full and nothing in a station can hurt the other two.
 *      This is the common case — a shield-tanked pilot in a fight — and it
 *      needs no call at all.
 *   2. The shop's own quote, which is the authority on what a station can see:
 *      an EMPTY quote is "nothing on this hull is damaged", and that includes
 *      the armour the stamp could not vouch for. `null` is "we could not say"
 *      and stays "not well", exactly as it does everywhere else this loop reads
 *      that field — note that a pilot which does not pay for repairs never
 *      raises a quote at all, so it falls through to the message that says so.
 */
function wellEnoughToReturn(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  running: CompanionFlee,
): boolean {
  if (obs.docked === true) {
    if (running.onlyTheShieldWasHurt) {
      return true;
    }
    const damaged = obs.damagedItemIDs ?? null;
    return damaged !== null && damaged.length === 0;
  }
  return healthClearOfTheMark(request, obs);
}

/**
 * The live health read, against the return mark — the question as SPACE answers
 * it, with no station authority behind it.
 *
 * Kept separate from `wellEnoughToReturn` because the recovery budget asks it on
 * ticks where no flee is running at all, so there is no stamp and no quote to
 * consult: out here, an unreadable health is simply not a recovered ship.
 */
function healthClearOfTheMark(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
): boolean {
  // ⚠ THE SAME LAYERS THAT STARTED THE FLEE, NEVER THE WHOLE FOLD. Judging the
  // way back by a layer that did not send the pilot away is how an armour-tanked
  // ship gets stranded at a safe spot: its shield is empty by design, so the
  // worst-layer fold would never clear the mark however well the armour healed.
  const health = tankHealth(request, obs);
  if (health === null) {
    // Unreadable is not "well". A pilot that undocked on a dropped poll would
    // be flying back into a fight on no information at all.
    return false;
  }
  return health >= returnMark(request);
}

/**
 * What a pilot does once it has got clear: get whole, then go back.
 *
 * ⚠ DOCKING IS NOT A REPAIR, and that fact is what this whole branch is shaped
 * around. `topOffShipShieldAndCapacitorForDockingTransition`
 * (`space/transitions.js:242`) sets `charge` and `shieldCharge` to 1 and leaves
 * `damage` and `armorDamage` exactly as they were. So a shield flee is whole
 * the moment it arrives and an ARMOUR flee is not -- and without paying the
 * shop it never will be, which is why an operator who has not opted in gets a
 * pilot that says it is staying put rather than one that silently commutes.
 */
function recoverAndReturn(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionFlee,
  nowMs: number,
): FleeStep {
  const hurtAt = Math.round(running.triggeredAtHealth * 100);

  // Not docked: the safe-spot case. There is no shop out here, so the thing to
  // do is hold and let the layers come back -- for as long as they ARE coming
  // back. `holdAtTheSafeSpot` is null only when the hold has stalled above the
  // floor and is given up, and then the pilot goes back below, as it is.
  const atSafeSpot = obs.docked !== true && !wellEnoughToReturn(request, obs, running);
  let returningUnrepaired = false;
  if (atSafeSpot) {
    const held = holdAtTheSafeSpot(request, obs, mem, running, hurtAt, nowMs);
    if (held !== null) {
      return held;
    }
  }
  if (!atSafeSpot && !wellEnoughToReturn(request, obs, running)) {
    // ⚠ THE SHOP'S OWN QUOTE DECIDES WHAT IS DAMAGED, never a guess at the ship
    // item id -- the same authority the DSL's `repair-ship` uses. Null is "we
    // could not say", which is a tick spent waiting for the quote and never a
    // conclusion that nothing is wrong.
    //
    // ⚠ IT IS ASKED BEFORE THE WALLET IS CONSULTED, AND THE OTHER ORDER WAS A
    // LIE. A pilot that does not pay for repairs used to answer every docked
    // tick with "not set to pay for repairs", whether or not anything was
    // actually damaged -- so the sentence an operator read while a perfectly
    // whole ship sat in a station blamed a setting for a health read that had
    // never happened. The quote now comes first, for every companion (see
    // flow.ts, where it stopped being gated on `repairsAtStation`), so that
    // sentence is only ever printed over damage the shop has actually named.
    const damaged = obs.damagedItemIDs ?? null;
    if (damaged === null) {
      return { decision: waiting("Safe", "Asking the repair shop for a quote.", mem), memory: mem };
    }
    if (!request.repairsAtStation && running.repairPaid !== true) {
      return {
        decision: waiting(
          "Safe",
          `Left the fight at ${hurtAt}%. Docking gave the shield back, the shop says the armour is still damaged, and this pilot is not set to pay for repairs, so it is staying put.`,
          mem,
        ),
        memory: mem,
      };
    }
    if (running.repairAttempts < MAX_FLEE_REPAIR_ATTEMPTS) {
      // ⚠ AN EMPTY QUOTE NEVER REACHES HERE ANY MORE, AND THAT IS THE FIX RATHER
      // THAN AN OVERSIGHT. It used to land on "the shop has nothing left to fix"
      // and hold — which, for a docked pilot, was every repaired ship for ever:
      // the repair worked, the quote emptied, and the return was still gated on a
      // health read no station can produce. `wellEnoughToReturn` now reads that
      // same empty quote as the station's own "this hull is whole", so a pilot
      // whose armour has just been paid for undocks on the next tick.
      const asked: CompanionLadderMemory = {
        ...mem,
        flee: { ...running, repairAttempts: running.repairAttempts + 1 },
      };
      return {
        decision: {
          action: { kind: "repairItems", itemIDs: damaged },
          phase: "Repairing",
          why: running.ordered === true
            ? "Paying the station to repair the ship, as the fleet commander ordered."
            : "Paying the station to put the armour back, so this pilot can rejoin.",
          memory: asked,
        },
        memory: asked,
      };
    }
    if (running.repairPaid !== true) {
      return {
        decision: waiting(
          "Safe",
          "The repair shop kept leaving damage unfixed, so this pilot stopped asking and is staying docked.",
          mem,
        ),
        memory: mem,
      };
    }
    // Asked for by the commander, so the ship goes back to them as it is: the
    // undock below. Said once, because the latch is dropped with it.
    returningUnrepaired = true;
    noteSay("The station would not repair the ship. Coming back as it is.");
  }

  // Whole enough. ⚠ THE BUDGET IS CHECKED HERE TOO, not only at the trigger: a
  // pilot whose LAST trip took it over the limit must stay docked rather than
  // undock into the fight that keeps sending it home.
  if (running.ordered !== true && mem.fleeTripsSpent >= request.maxFleeAttempts) {
    return {
      decision: waiting(
        "Safe",
        `Fixed up, but this pilot has used all ${request.maxFleeAttempts} of its flee round trips, so it is staying home.`,
        mem,
      ),
      memory: mem,
    };
  }

  // ⚠ THE LATCH IS DROPPED BEFORE THE MOVE, not after it. Undocking is what
  // ends the flee; holding the latch across it would leave this rung driving a
  // pilot that is already back out, and a ship that undocks hurt would then be
  // steered by a flee that thinks it is still going the other way.
  //
  // ⚠ THE UNDOCK IS NOT THE END OF THE WAY BACK. Once out, rung 9b
  // (`decideRejoinCommander`) warps to the commander if it is not on this grid.
  const done: CompanionLadderMemory = { ...mem, flee: null, fleeRecoverySinceMs: null };

  if (obs.docked === true) {
    // What the commander asked for, answered. A flee nobody ordered says nothing.
    if (running.repairPaid === true && !returningUnrepaired) {
      noteSay(running.repairAttempts > 0 ? "Repaired. Coming back." : "Nothing to repair. Coming back.");
    }
    return {
      decision: {
        action: { kind: "undock" },
        phase: "Going back",
        why: "Fixed up, so this pilot is undocking to rejoin the fleet.",
        memory: done,
      },
      memory: done,
    };
  }

  // Out at the safe spot rather than in a station, and well again. If the fleet
  // is somewhere else, route there; otherwise there is nothing to fly and the
  // rungs below take over on the next tick.
  //
  // ⚠ THIS IS AS FAR AS "REMEMBER THE GRID" GOES, AND IT IS OPTION A ON PURPOSE.
  // A solar system is not a grid: nothing here flies the pilot back to the exact
  // spot it left, because a return point would need a bookmark written at the
  // moment of leaving and that is a whole feature rather than a step. There is
  // also no read anywhere that says whether that grid is clear, so a precise
  // return would be no safer than this one -- only more code. The attempt budget
  // is what bounds the blindness, for both.
  const here = obs.flightStatus?.solarSystemID ?? null;
  const home = running.fromSolarSystemID;
  if (home !== null && here !== null && home !== here) {
    return {
      decision: {
        action: { kind: "travelTo", systemID: home },
        phase: "Going back",
        why: "Recovered, so this pilot is heading back to the system it left.",
        memory: done,
      },
      memory: done,
    };
  }
  return { decision: null, memory: done };
}

/**
 * The safe-spot half of `recoverAndReturn`: a ship out in space, not yet clear
 * of its return mark. Null when the hold is given up and the pilot goes back.
 *
 * ⚠ BOUNDED, AND THE BOUND IS PROGRESS, NOT A CLOCK FROM ARRIVAL. Seen live
 * 2026-10-14 09:13-10:05 (on the rejoin, which had the same unbounded shape): a
 * pilot sat 52 minutes under its mark in a layer nothing was repairing. A tank
 * that keeps rising keeps the wait going however long it takes; one that has not
 * risen in `FLEE_RECOVERY_STALL_MS` takes the next step, in this order:
 *
 *   1. Still below the flee FLOOR: stay out here, and say so. Going back would
 *      re-trigger the flee on the first tick at the fight, spending a trip to
 *      learn what this tick already knows.
 *   2. Paying for repairs and a station on grid: dock there, and the docked
 *      half of `recoverAndReturn` takes it from the quote. Rare -- a flee docks
 *      first when it can, so a pilot at a safe spot is usually in a system with
 *      no station in view -- but it is the honest answer when there is one.
 *   3. Otherwise go back as it is, with a readout that says so. Above the floor
 *      it is fit to fight by the operator's own number; the mark only exists to
 *      stop a RETURN commuting, and a pilot that cannot climb any further is not
 *      going to reach it by waiting.
 *
 * An unreadable tank never counts towards the stall: "unreadable is not well"
 * holds here as everywhere, and a ship sent back on no information is the one
 * thing worse than one kept waiting.
 */
function holdAtTheSafeSpot(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionFlee,
  hurtAt: number,
  nowMs: number,
): FleeStep | null {
  const tank = tankHealth(request, obs);
  if (tank === null) {
    noteHealth(healthTrace(request, obs, "flee-unread"));
    return {
      decision: waiting("Safe", `Left the fight at ${hurtAt}% and is waiting out here to recover.`, mem),
      memory: mem,
    };
  }
  const rose = running.recoverBest === undefined || tank > running.recoverBest + FLEE_RECOVERY_RISE;
  const tracked: CompanionFlee = rose ? { ...running, recoverBest: tank, recoverBestAtMs: nowMs } : running;
  const kept: CompanionLadderMemory = rose ? { ...mem, flee: tracked } : mem;
  const stalledMs = nowMs - (tracked.recoverBestAtMs ?? nowMs);
  if (stalledMs < FLEE_RECOVERY_STALL_MS) {
    noteHealth(healthTrace(request, obs, "flee-recovering", stalledMs));
    return {
      decision: waiting("Safe", `Left the fight at ${hurtAt}% and is waiting out here to recover.`, kept),
      memory: kept,
    };
  }
  const minutes = Math.round(stalledMs / 60_000);
  if (tank < request.fleeHealthFloor) {
    noteHealth(healthTrace(request, obs, "flee-stalled-floor", stalledMs));
    return {
      decision: waiting("Safe",
        `Left the fight at ${hurtAt}%, has not healed in ${minutes} minute(s) and is still below its flee floor, so it is staying out here.`,
        kept),
      memory: kept,
    };
  }
  const snapshot = obs.snapshot ?? null;
  const measurement = snapshot === null ? null : measureSpace(snapshot);
  const station = snapshot === null || measurement === null
    ? null
    : nearestOf(snapshot.entities.filter((entity) => DOCKABLE_KINDS.has(entity.kind ?? "")), measurement);
  if (request.repairsAtStation && station !== null) {
    noteHealth(healthTrace(request, obs, "flee-stalled-dock", stalledMs));
    // The outbound leg flies again, this time to the station: `reachedSafety`
    // reads these as "not there yet", and `runToSafety` docks before it ever
    // looks at the sun.
    const { safeSpotWarpBackoff: _backoff, ...rest } = tracked;
    const rerouted: CompanionFlee = { ...rest, arrivedSafe: false, safeSpotWarpIssued: false,
      safeSpotWarpSeen: false, safeSpotWarpAttempts: 0, safeSpotWarpWaited: 0, droneRecallWaited: null };
    return flyTheFlee(request, obs, { ...mem, flee: rerouted }, rerouted, nowMs);
  }
  noteHealth(healthTrace(request, obs, "flee-stalled-return", stalledMs));
  noteNotice(`Has not healed in ${minutes} minute(s) out here, so it is going back as it is.`);
  return null;
}

/**
 * The leg itself, once a flee is latched.
 *
 * Split out so the latching tick and every tick after it fly the same code —
 * a flee that behaved differently on its first tick than its second would be a
 * flee whose first tick is untested by every test that starts from a latch.
 */
function flyTheFlee(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionFlee,
  nowMs: number,
): FleeStep {
  if (reachedSafety(obs, running)) {
    // Stamped on the first tick that sees it, and only for what the next branch
    // needs it for: telling "still on the way out" apart from "somebody took
    // this ship back out".
    if (!running.arrivedSafe) {
      const arrived: CompanionFlee = { ...running, arrivedSafe: true };
      return recoverAndReturn(request, obs, { ...mem, flee: arrived }, arrived, nowMs);
    }
    return recoverAndReturn(request, obs, mem, running, nowMs);
  }

  // ⚠ THE OPERATOR'S OWN UNDOCK WINS, AND BEFORE THIS IT COULD NOT. A flee that
  // has already delivered the ship somewhere safe and now finds it out in space
  // did not move it: this rung drops its latch before every undock it issues
  // (see `recoverAndReturn`), and nothing below this rung ever runs while it is
  // parked. So the only thing that can have undocked this ship is a human — and
  // the answer to a human was to dock it again, two seconds later, for ever.
  // Reported live on 2026-09-13: "I can not force them to undock, as soon as
  // they are undocked they dock back."
  //
  // ⚠ THE BUDGET IS SPENT, NOT JUST THE LATCH DROPPED. Dropping the latch alone
  // would let the very next tick read the same hurt ship, re-latch, and dock it
  // again — the same loop with one extra step in it. Spending the round trips is
  // how this ladder already says "stop sending yourself home" (`maxFleeAttempts`
  // is the operator's own "stay home after N trips"), so the override needs no
  // new state and reads the same way in the budget it already has. It is not
  // permanent either: `countTowardsRecovery` hands the budget back after this
  // pilot has held above its return mark for `FLEE_RECOVERY_HOLD_MS`, so a ship
  // that actually recovers may flee again later in the same run.
  if (running.arrivedSafe) {
    // An ordered trip spent no round trip, so a human taking the ship back out
    // costs none either: the order is simply over.
    return {
      decision: null,
      memory: { ...mem, flee: null, fleeTripsSpent: running.ordered === true ? mem.fleeTripsSpent : request.maxFleeAttempts },
    };
  }

  const safe = runToSafety(request, obs, mem, {
    run: running,
    phase: running.ordered === true ? "Going to repair" : "Getting clear",
    because: running.ordered === true ? "the fleet commander ordered a repair" : "this ship is hurt",
    write: (m, run) => ({ ...m, flee: { ...running, ...run } }),
    ...(running.ordered === true ? { stationOnly: true as const } : {}),
  }, nowMs);
  if (safe !== null) {
    return { decision: safe, memory: safe.memory };
  }
  if (running.ordered === true) {
    // The station `withRepairOrder` saw is gone from view. Nothing was spent, so
    // nothing is handed back; the pilot says so and stays with the fleet.
    noteSay("Cannot repair: no station in this system.");
    return { decision: null, memory: { ...mem, flee: null } };
  }

  // ⚠ NOWHERE TO GO IS NOT A STOP, AND IT IS NOT A FLEE EITHER. No station on
  // this grid and no safe spot named means this pilot cannot leave. Rung 2
  // answers that by ending the run, because a pilot with nobody to fly with has
  // nothing else to try. A pilot that is merely HURT does: it still has guns
  // and a fleet that still has a use for them, so it falls through to the rungs
  // below and fights on.
  //
  // The latch is UNWOUND rather than left standing, budget included. A trip
  // spent on a flee that never moved the ship is a trip the operator paid for
  // and got nothing from, and leaving the latch would park this rung on a
  // condition that cannot change until the ship is somewhere else.
  return { decision: null, memory: { ...mem, flee: null, fleeTripsSpent: mem.fleeTripsSpent - 1 } };
}

// ─── Rung 5b: out of the station ─────────────────────────────────────────────

/**
 * A docked companion with nothing keeping it docked leaves.
 *
 * ⚠ `null` FOR A SHIP ALREADY IN SPACE, which is every ordinary tick — this
 * rung costs a boolean and falls straight through.
 *
 * ⚠ AN UNDOCK ALREADY UNDER WAY IS NOT RE-ISSUED. The flight status carries the
 * server's own transition record, so "I have asked and it has not landed yet"
 * is a fact this loop can read rather than one it has to remember: a `kind:
 * "undock"` transition that has not reached `ready` (or `failed`) is this rung's
 * own call still in flight, and re-sending it every two seconds would spend a
 * call per tick on a session change that is already happening. An older BFF
 * that does not send the field at all falls back to issuing, which is the
 * behaviour this rung would have had without it.
 */
function decideLeaveTheStation(
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
): CompanionDecision | null {
  if (obs.docked !== true) {
    return null;
  }
  const transition = obs.flightStatus?.transition;
  if (
    transition !== undefined &&
    transition.kind === "undock" &&
    transition.phase !== "ready" &&
    transition.phase !== "failed"
  ) {
    return waiting("Undocking", "Undocking, and the station has not let go yet.", mem);
  }
  return {
    action: { kind: "undock" },
    phase: "Undocking",
    why: "A companion belongs out with its fleet, not in a station.",
    memory: mem,
  };
}

// ─── Rung 6: drones ──────────────────────────────────────────────────────────

/**
 * How long a recall is believed to be in progress before the rung stops waiting
 * on it. The same duration, for the same reason, as the DSL's own
 * `RECALL_MAX_WAIT_TICKS` (`scriptMacros.ts:60`) -- which is fifteen of that
 * loop's two-second ticks, i.e. the thirty seconds written here.
 *
 * ⚠ THE STUCK CASE IS REAL AND IT IS SILENT, so this bound is not defensive
 * padding. A drone that arrives at scoop range to find a FULL BAY is refused by
 * `recallDronesToShipBay`, and the tick-driven recall path throws that refusal
 * away (`droneRuntime.js:7570`) - nothing is sent to the client. The drone then
 * circles at 2500 m for ever, still on grid, still in `myDroneIDs`, with no
 * error anywhere. Without this bound the rung would wait on it until the run
 * ended.
 *
 * ⚠ MILLISECONDS, NOT TICKS, AND THAT CHANGED FOR A REASON. It used to be a
 * count of ticks, which was only ever a proxy for elapsed time and was a bad
 * one twice over. The measured tick was never the 2 s the cadence names -- it
 * is ~4 s once the tick's own six reads are counted -- so fifteen of them was a
 * minute, not the half-minute intended; and now that a tick which ISSUED
 * something comes back at `FLEET_COMPANION_BURST_MS`, the tick is not even a
 * fixed unit any more. This branch falls THROUGH to the rungs below it, so its
 * ticks are exactly the ones that can be bursts. A clock says what it means.
 */
const DRONE_RECALL_GIVE_UP_MS = 30_000;

/**
 * How long a job's launch that the server took is waited on before the same
 * drones are sent again, while none of that kind reads as out.
 *
 * ⚠ ONLY A LAUNCH THE SERVER SAID YES TO WAITS. One that failed is forgotten
 * by the loop and sent again on the next tick. A launch that was taken lands
 * in a tick or two; one still not seen after it is a launch the pilot cannot
 * see the result of (its drones have no state in the park), or one the server
 * refused without saying (every control slot full), and sending it again every
 * burst tick changes neither.
 */
const DRONE_LAUNCH_WAIT_MS = 30_000;


// ─── The `loot` order ────────────────────────────────────────────────────────

/**
 * How close this ship must actually be, CENTRE TO CENTRE, before it reaches
 * into a wreck or a can.
 *
 * ⚠ CENTRE TO CENTRE, BECAUSE THAT IS WHAT THE SERVER MEASURES, and measuring
 * it any other way is what had a companion fly to a can and stand there.
 * `invbroker` refuses to bind a space container whose straight-line centre
 * distance from the ship exceeds 2,500 m, and it refuses with `FakeItemNotFound`
 * -- the same answer it gives for an id it has never heard of, so nothing on the
 * wire says "not yet, keep coming".
 *
 * This rung used to ask `measureSpace`, whose distances are SURFACE distances:
 * centres minus BOTH radii. So a pilot 2,400 m from the hull of a can was
 * 2,400 + its own radius + the can's radius away from the centre the server
 * measures to, and reached in from outside the gate while still flying. By the
 * time it had closed the rest of the way, the attempt bound in
 * `companionLootFrom` had set the can aside, so the pilot parked next to a can
 * it never opened -- which is the symptom as the operator reported it.
 *
 * ⚠ WHAT THE 2026-09-11 SERVER LOG DOES AND DOES NOT SHOW, stated exactly,
 * because a first reading of it overstated the case. It shows three
 * `GetInventoryFromId` calls answered `FakeItemNotFound` over four seconds and a
 * fourth, a few hundred metres later, binding the container and listing it --
 * so the gate is real, it is a DISTANCE gate, and the refusal it hands back is
 * indistinguishable from an unknown id. But those calls arrived over a game
 * client's own socket: the web gateway invokes service handlers directly and its
 * traffic never appears in that log as a call at all (1,835 gateway requests to
 * zero logged calls over three minutes, checked). So the log is evidence about
 * the SERVER'S RULE, and the companion's own failure follows from that rule plus
 * the surface-versus-centre mismatch above -- not from a logged refusal of its
 * own. The fix was confirmed live by the operator.
 *
 * ⚠ THE MARGIN IS FREE, SO IT IS GENEROUS. The approach below hugs the object
 * (no range), so a pilot that is going to loot at all is on its way to ~50 m --
 * waiting for 2,000 m costs it a second of travel and nothing else. Distance to
 * a can this ship is closing on only ever falls between ticks, so a stale
 * snapshot can only make this rung MORE cautious, never less.
 *
 * ⚠ IT IS NO LONGER THE DSL's `LOOT_RANGE_M`, and that divergence is deliberate
 * rather than drift. `loot-wrecks` keeps the same 2,400 m surface test and gets
 * away with it because it has a refusal ledger: a refused transfer marks the
 * wreck unreachable, the block closes in and tries again. This loop has no
 * ledger to consult (see the note on the loot action below), so it has to be
 * right the first time instead of recovering afterwards.
 */
const COMPANION_LOOT_REACH_M = 2000;

/**
 * Where to STOP when closing on a wreck to SALVAGE it.
 *
 * ⚠ COMFORTABLY INSIDE THE RANGE THAT LETS THE JOB HAPPEN, AND THAT MARGIN IS
 * THE WHOLE POINT. It was first set EQUAL to the working range above, and a
 * pilot then flew to a can and sat next to it doing nothing, for ever (observed
 * live, 2026-09-11). Asking the server to stop AT the threshold parks the ship
 * on the boundary, where a metre of overshoot or of rounding leaves
 * `distance > range` true on every tick -- so the rung waits on an approach that
 * has already finished, and reports nothing at all.
 *
 * A threshold you must be INSIDE must never be the distance you aim for.
 *
 * ⚠ LOOTING HAS NO SUCH RANGE, BY THE OPERATOR'S DECISION: "for loot do not use
 * range, for salvage do". A looter flies all the way to the can and takes what
 * is in it, which sidesteps the boundary problem entirely rather than managing
 * it -- and unlike a salvager, there is nothing it gains by standing off.
 */
const SALVAGE_APPROACH_STOP_M = 3000;

/**
 * Run a salvager inside its ~5-6 km reach, with margin.
 *
 * ⚠ DUPLICATED FROM `scriptMacros.ts`, DELIBERATELY, AND RECORDED RATHER THAN
 * SILENTLY ACCEPTED. The DSL has the same constant and it is not exported.
 * Importing it would pull the whole macro table into a loop whose entire point
 * is not to be part of the DSL -- the same reason the companion builds its own
 * observation instead of reusing `observe(hint)`. If these two drift, the
 * symptom is a companion that reaches from a slightly different distance than a
 * scripted bot does, which is confusing rather than wrong. The shared-constant
 * lesson from COMPANION_GRANT_SCRIPT_REV applies to values the SERVER
 * validates; a salvager's own reach is not one of those.
 */
const COMPANION_SALVAGE_RANGE_M = 4500;

/** How many ticks to wait on a wreck's lock before giving up on that wreck. */
const MAX_SALVAGE_LOCK_WAIT_TICKS = 10;


/**
 * The ship modes in which sending ANOTHER approach is not worth the call --
 * either the move already sent is the one the server is flying, or a new one
 * would be refused outright.
 *
 * ⚠ THE VOCABULARY IS THE SERVER'S OWN, AND IT IS SIX UPPERCASE WORDS: FIELD,
 * FOLLOW, GOTO, ORBIT, STOP, WARP are the only values anything under
 * `space/destiny/` assigns to `entity.mode`, and the snapshot carries that
 * string through untouched. ⚠ "APPROACH" IS NOT ONE OF THEM. This test used to
 * be `/follow|approach|warp/i` over the free text, one third of which could
 * never match anything the server is able to say -- the same trap
 * `CLOSING_SHIP_MODES` was written to document.
 *
 * ⚠ AN APPROACH IS **FOLLOW**, NOT GOTO, WHICH IS THE FACT THIS WHOLE CONSTANT
 * TURNS ON. There is no CmdApproach on this server: retail's Approach is
 * `CmdFollowBall(targetID, 0)`, the page's approach issues exactly that
 * (`CmdSetSpeedFraction(1.0)`, then `CmdFollowBall`; bridge/movementWrites.ts), and it lands in
 * `followShipEntity`, which sets FOLLOW at any range -- so the looter's
 * range-less approach and the salvager's 3 km one both produce it. `keepAtRange`
 * is the same server method with a non-zero range, which is also why no mode can
 * tell "closing on my wreck" from "holding station on the commander". That
 * ambiguity is bounded by the caller's own `…Approaching` latch, not here.
 *
 * ⚠ GOTO IS DELIBERATELY ABSENT, THOUGH `CLOSING_SHIP_MODES` HOLDS IT. GOTO is
 * what the hull is left in when an approach was REFUSED or when the move being
 * flown is somebody else's: `followBall` bounces a pilot whose warp landing is
 * still pending, and a ship that has just landed, undocked, been aligned by the
 * fleet rung, or merely had its throttle opened from STOP is in GOTO while
 * travelling somewhere that is not the target. Every one of those is a moment
 * this rung MUST let go and re-issue, so counting GOTO would turn a one-tick
 * recovery into a wait that never ends -- precisely the failure the callers'
 * comments warn about. The two constants answer different questions ("is the
 * hull burning sub-warp" against "is the move I sent the move being flown") and
 * their overlap is a coincidence, so they stay separate lists.
 *
 * ⚠ WARP IS IN IT, AND NOT BECAUSE A WARP IS AN APPROACH. `followShipEntity`
 * refuses outright while `entity.mode === "WARP"`, so an approach sent mid-warp
 * is a call spent to be told no.
 */
const NO_REAPPROACH_SHIP_MODES: readonly string[] = ["FOLLOW", "WARP"];

/**
 * Whether this ship is still under way toward something.
 *
 * ⚠ READ OFF THE SHIP, NOT OFF OUR OWN MEMORY OF HAVING ASKED. "I sent an
 * approach" and "the ship is approaching" are different claims, and only the
 * second one is worth waiting on.
 */
function isClosing(obs: FleetCompanionObservation): boolean {
  const mode = obs.snapshot?.ship?.mode ?? null;
  // Liberal about case on purpose: the server sends uppercase today, and a drop
  // that changed that must not silently stop every rung believing its own move.
  return mode !== null && NO_REAPPROACH_SHIP_MODES.includes(mode.toUpperCase());
}

// `APPROACH_SETTLE_MS` (autopilotLoop.ts) is how long a fresh approach is believed whatever the mode says.

/** Whether an approach issued at `issuedAtMs` is still to be believed. See `APPROACH_SETTLE_MS`. */
function approachHolds(
  obs: FleetCompanionObservation,
  issuedAtMs: number | null,
  nowMs: number,
): boolean {
  return (issuedAtMs !== null && nowMs - issuedAtMs < APPROACH_SETTLE_MS) || isClosing(obs);
}

/**
 * Straight-line metres between two things that carry a position.
 *
 * ⚠ NOT `measureSpace`, WHICH ONLY MEASURES FROM THIS SHIP. The claim rule below
 * has to ask how far a FLEET-MATE is from a wreck, and that pair never involves
 * this pilot at all.
 */
function metresBetween(a: SpaceEntity, b: SpaceEntity): number {
  const ax = a.position?.x ?? 0;
  const ay = a.position?.y ?? 0;
  const az = a.position?.z ?? 0;
  const bx = b.position?.x ?? 0;
  const by = b.position?.y ?? 0;
  const bz = b.position?.z ?? 0;
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/**
 * Straight-line metres from THIS ship's centre to something else's centre.
 *
 * ⚠ THE SERVER'S OWN MEASURE, AND THE ONLY ONE WORTH TESTING A SERVER GATE
 * AGAINST. `measureSpace` answers SURFACE distances -- centres minus both radii
 * -- which is the right number to show a player and the wrong one to predict a
 * refusal with. See `COMPANION_LOOT_REACH_M` for what believing the wrong one
 * cost.
 *
 * ⚠ A MISSING POSITION IS INFINITY, NEVER ZERO. `metresBetween` above reads an
 * absent coordinate as the origin because both its arguments are grid rows that
 * always carry one; here a snapshot that cannot say where this ship is must read
 * as "too far to reach in", so the rung keeps closing instead of reaching from a
 * distance nobody measured.
 */
function centreMetresToShip(obs: FleetCompanionObservation, target: SpaceEntity): number {
  const snapshot = obs.snapshot ?? null;
  const self = snapshot?.entities.find((entity) => entity.isSelf === true) ?? null;
  const origin = snapshot?.ship?.position ?? self?.position ?? null;
  const there = target.position ?? null;
  if (origin === null || there === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(origin.x - there.x, origin.y - there.y, origin.z - there.z);
}

/**
 * The fleet's OTHER ships on this grid, by their character id.
 *
 * ⚠ FLEET MEMBERS ONLY, NEVER EVERY PLAYER ON GRID. A stranger racing us to a
 * wreck is not somebody to yield to; a fleet-mate is. And it excludes this ship,
 * because `claimedByThisPilot` compares against it separately.
 */
function fleetShipsOnGrid(obs: FleetCompanionObservation): readonly SpaceEntity[] {
  const fleet = obs.fleetMemberCharacterIDs ?? null;
  const me = obs.myCharacterID ?? null;
  if (fleet === null) {
    return [];
  }
  return (obs.snapshot?.entities ?? []).filter(
    (entity) =>
      entity.kind === "ship" &&
      entity.isSelf !== true &&
      entity.characterID !== null &&
      entity.characterID !== me &&
      fleet.includes(entity.characterID),
  );
}

/**
 * Which of `candidates` this pilot should take: the nearest one that NO
 * fleet-mate on grid is better placed for.
 *
 * ⚠ THIS IS DE-CONFLICTION WITHOUT A COORDINATION CHANNEL, and that is why it is
 * shaped as a claim rather than as a message. Every companion runs this same
 * rule over the same snapshot and reaches the same answer about who takes what,
 * so two pilots split a field of wrecks without ever telling each other
 * anything. Nothing is written, nothing is reserved, and a pilot that leaves or
 * arrives simply changes the answer on the next tick.
 *
 * ⚠ THE PROBLEM IT SOLVES IS REAL AND WAS PREDICTED BEFORE IT WAS SEEN: with
 * plain nearest-first, two pilots on one grid pick the SAME nearest wreck and
 * convoy to it, doing the work of one. It is not harmful -- the loser finds it
 * emptied, marks it and moves on -- but it wastes half the fleet.
 *
 * ⚠ TIES BREAK ON CHARACTER ID, NOT ARBITRARILY. Two pilots exactly equidistant
 * (the same wreck, ships abreast) would otherwise both claim or both yield. The
 * lower id wins, which every pilot computes identically.
 *
 * ⚠ AND A PILOT THAT CLAIMS NOTHING STILL WORKS. If a fleet-mate is better
 * placed for every candidate, this falls back to the plain nearest rather than
 * idling -- otherwise the last pilot in a big fleet would sit still while one
 * ship worked a field alone.
 */
function pickForThisPilot(
  obs: FleetCompanionObservation,
  candidates: readonly SpaceEntity[],
): SpaceEntity | null {
  const me = (obs.snapshot?.entities ?? []).find((entity) => entity.isSelf === true) ?? null;
  const myID = obs.myCharacterID ?? 0;
  const mates = me === null ? [] : fleetShipsOnGrid(obs);

  let claimed: { entity: SpaceEntity; metres: number } | null = null;
  let anyNearest: { entity: SpaceEntity; metres: number } | null = null;

  for (const candidate of candidates) {
    const mine = me === null ? Number.POSITIVE_INFINITY : metresBetween(me, candidate);
    if (anyNearest === null || mine < anyNearest.metres) {
      anyNearest = { entity: candidate, metres: mine };
    }
    const beaten = mates.some((mate) => {
      const theirs = metresBetween(mate, candidate);
      if (theirs < mine) {
        return true;
      }
      return theirs === mine && (mate.characterID ?? 0) < myID;
    });
    if (!beaten && (claimed === null || mine < claimed.metres)) {
      claimed = { entity: candidate, metres: mine };
    }
  }
  return (claimed ?? anyNearest)?.entity ?? null;
}

/**
 * Whether the `loot` order will open this entity.
 *
 * ⚠ NO OWNERSHIP CHECK, BY THE OPERATOR'S DECISION: "just loot everything. we
 * do not care about ownership. this is private server."
 *
 * ⚠ AND THE CODEBASE ALREADY SAID SO FOR CONTAINERS. `lootContainers` in the
 * DSL carries the same call in its own words -- "no ownership check: this is an
 * emulator, not a client guarding real players from can-flipping, and the
 * server enforces none either". Wrecks were the inconsistent half.
 *
 * ⚠ THE GATE THAT USED TO BE HERE WAS NOT MERELY STRICT, IT WAS BROKEN. It
 * allowed a wreck owned by this character or this CORPORATION -- but a wreck
 * carries the CHARACTER id of whoever got the kill, so the corp clause could
 * never match, and a companion (which kills nothing of its own) could never
 * attribute a single wreck to itself. Observed live on 2026-09-11: the FC
 * killed three rats and `loot` did nothing at all. Recorded so nobody
 * reinstates it believing it ever worked.
 */
function companionMayOpen(entity: SpaceEntity): boolean {
  return entity.kind === "wreck" || entity.kind === "container";
}

/**
 * The `loot` order: empty the wrecks that are ours and every can on the grid,
 * nearest first.
 *
 * ⚠ THIS IS THE ONLY THING A COMPANION DOES THAT MOVES THE SHIP OF ITS OWN
 * ACCORD. Everything else it does is fired from where it already is, or is a
 * move somebody else ordered. Looting approaches each target in turn, so a
 * companion told to loot will drift off formation -- which is why this rung sits
 * at the very bottom of the ladder, beneath the fleet orders and far beneath the
 * flee. A pilot that is dying, or being fleet-warped, stops looting instantly.
 */
function decideLooting(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision | null {
  if (memory.areaJob !== "loot") {
    return null;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return null;
  }
  const reachable = lootablesOnGrid(obs, memory);
  if (reachable.length === 0) {
    return null;
  }
  // ⚠ THE TARGET IS CHOSEN ONCE AND THEN KEPT. Re-picking every tick made this
  // rung wander -- see `lootTargetID`. A target only stops being the target when
  // it has been opened or has left the grid, and `lootablesOnGrid` already drops
  // both of those.
  let target = reachable.find((entity) => entity.itemID === memory.lootTargetID) ?? null;
  let mem = memory;
  if (target === null) {
    // ⚠ AND THE CLAIM RULE IS CONSULTED HERE, AT THE MOMENT OF CHOOSING, not on
    // every tick. Two companions would otherwise converge on the same can. See
    // `pickForThisPilot`.
    target = pickForThisPilot(obs, reachable);
    if (target === null) {
      return null;
    }
    mem = { ...memory, lootTargetID: target.itemID, lootApproaching: null, lootApproachAtMs: null };
  }
  // ⚠ CENTRE TO CENTRE, THE WAY THE SERVER MEASURES IT. See
  // `COMPANION_LOOT_REACH_M`: the surface distance this used to ask for is
  // smaller by both radii, so it read "in range" while the bind was still being
  // refused, and the refusals spent the whole attempt budget on the last few
  // hundred metres of the approach.
  const best = centreMetresToShip(obs, target);
  if (best > COMPANION_LOOT_REACH_M) {
    // ⚠ ISSUED ONCE, THEN WAITED ON. Re-sending `approach` at every tick would
    // spend the run's one call per tick re-ordering a move already under way.
    // Same rule as the salvage rung: an approach that is no longer running is
    // not an approach, however recently it was sent.
    // ⚠ THE SETTLE WINDOW, NOT THE MODE ALONE: the first snapshot after the order
    // can still read GOTO. See `APPROACH_SETTLE_MS`.
    if (mem.lootApproaching === target.itemID && approachHolds(obs, mem.lootApproachAtMs, nowMs)) {
      return waiting("Looting", "Closing on something to loot.", mem);
    }
    return {
      // No range: fly right up to it. See SALVAGE_APPROACH_STOP_M's comment.
      action: { kind: "approach", targetID: target.itemID },
      phase: "Looting",
      why: "Closing on something to loot, as asked.",
      memory: { ...mem, lootApproaching: target.itemID, lootApproachAtMs: nowMs },
    };
  }
  // ⚠ MARKED LOOTED ON THE ASKING, NOT ON THE ANSWER, AND THAT IS A KNOWN
  // WEAKER GUARANTEE THAN THE DSL'S. `loot-wrecks` waits a tick and checks the
  // refusal ledger before believing a transfer landed; this loop has no refusal
  // ledger to consult. The consequence of being wrong is one skipped wreck on a
  // pilot whose real job is flying with the fleet, which is a better trade than
  // a rung that retries a full hold forever.
  return {
    action:
      target.kind === "container"
        ? { kind: "lootContainer", containerID: target.itemID }
        : { kind: "lootWreck", wreckID: target.itemID },
    phase: "Looting",
    why: "Taking what is inside, as asked.",
    // ⚠ NOT MARKED LOOTED HERE. Whether the can actually emptied is settled by
    // `lootFinishedItemIDs` on a later tick, from what the transfer really
    // moved. Marking it on the asking is what had a pilot take one stack of
    // three and fly off. The latch is kept for the same reason: this can is
    // still the target until somebody says it is done.
    memory: { ...mem, lootApproaching: null, lootApproachAtMs: null },
  };
}

/**
 * The ship's movement modes that mean "closing on something", read off the
 * SERVER's own vocabulary rather than guessed at.
 *
 * ⚠ THE VOCABULARY IS SIX UPPERCASE WORDS AND THESE ARE THE TWO THAT MATTER.
 * Checked against the server 2026-09-13 (`space/destiny/commands/`): the only
 * values it ever assigns to `entity.mode` are `FIELD`, `FOLLOW`, `GOTO`,
 * `ORBIT`, `STOP` and `WARP`. **GOTO** is a hull flying a heading of its own --
 * an align, an undock, a landing out of warp, a throttle opened from STOP.
 * **FOLLOW** is a hull flying at another object: `followShipEntity`, which is
 * `keepAtRange`, the follow rung, and -- the one that is easy to get wrong --
 * an APPROACH, which is `CmdFollowBall(targetID, 0)` and not a goto at all.
 * Both are the burn this rung exists to help, which is why both are here --
 * except that `isUnderWay` drops FOLLOW (and only FOLLOW) while hostiles are on
 * the grid and the ship is merely holding formation on its commander.
 *
 * ⚠ THE WORD "APPROACH" NEVER APPEARS IN IT, which is the trap this constant
 * exists to avoid: `isClosing` above used to test `/follow|approach|warp/i`,
 * one third of which could never match anything the server can say. It now
 * tests `NO_REAPPROACH_SHIP_MODES` -- a DIFFERENT list, deliberately, because it
 * answers a different question. See that constant before reusing either for
 * anything that spends a call.
 *
 * ⚠ ORBIT IS DELIBERATELY NOT HERE. A ship holding an orbit has arrived; it is
 * circling, not closing, and a prop mod lit for the whole of a standing orbit
 * burns capacitor for nothing. STOP and FIELD are not movement at all, and WARP
 * is movement a prop mod cannot help with -- the server stops one on entering
 * warp, and the ladder never reaches this rung mid-warp anyway because rung 1
 * yields first.
 */
const CLOSING_SHIP_MODES: readonly string[] = ["GOTO", "FOLLOW"];

/**
 * Whether this pilot is TRAVELLING in the sense the prop-mod rung means: moving
 * sub-warp toward something, or running a multi-jump route of its own.
 *
 * ⚠ THE MODE TEST IS THE ONE THAT ACTUALLY FIRES, AND THE AUTOPILOT TEST ALONE
 * WAS THE BUG. The first cut of this rung read "travelling" as
 * `obs.travel?.status === "running"` -- the shared autopilot -- because both of
 * this loop's own travel rungs (the `destination` trip and a `TravelTo` order)
 * fly through `startRoute`. That is true and it is nearly useless: in ORDINARY
 * fleet play a companion never runs its own autopilot at all. It yields to the
 * commander's fleet warp (rung 1), holds station on them (rung 9) and jumps the
 * gate it is sitting on (rung 7) -- so the autopilot stays idle for an entire
 * trip across a dozen systems and no prop mod ever lit. Observed on a live
 * fleet, 2026-09-13.
 *
 * ⚠ BOTH TESTS ARE KEPT, NOT JUST THE NEW ONE. The mode test covers the burn
 * that matters -- landing off a gate and closing the last few km, keeping up
 * with a commander who is pulling away -- and the autopilot test keeps the rung
 * honest about the pilot's OWN trips, including the moments between legs when
 * the hull is briefly in no interesting mode at all.
 *
 * ⚠ FOLLOW IS NOT TRAVELLING WHEN IT IS THE FORMATION HELD IN A FIGHT, AND THE
 * MODE TEST ALONE LIT A MICROWARPDRIVE FOR EVERY FIGHT. A companion keeps
 * station on its fleet commander with keep-at-range, and on the server that is
 * FOLLOW for the WHOLE of the time it holds station: FOLLOW only ends when the
 * followed ship vanishes. So "FOLLOW means closing" was true for the few
 * seconds it was written for and then stayed true for as long as the fight
 * lasted -- the prop mod burned throughout, and the server blooms a
 * microwarpdrive's signature radius, which makes the ship easier for the NPCs
 * to hit.
 *
 * ⚠ BUT FOLLOW IS ALSO EVERY APPROACH, SO ONLY THE FORMATION LOSES THE BURNER.
 * The flee's run at a station, the gate approach, the loot and salvage
 * approaches are all FOLLOW too, and a pilot fleeing a fight needs its burner
 * most of all. The stand-down is therefore: hostiles on the grid (`true` only;
 * false and null keep the FOLLOW test exactly as it was) AND `holdsFormation`.
 * The autopilot is its own route, so it is not affected, and `props on` still
 * beats all of it (see `decidePropulsion`).
 *
 * ⚠ AND GOTO UNDER THE FORMATION RECORD IS THE FORMATION TOO: THE FOLLOW-ONLY
 * VETO LIT THE BURNER FOR ONE TICK EVERY TIME A FIGHT'S ORBIT ENDED. When the
 * rat rung 8 orbits dies, the pilot's own ballpark puts the interactive orbiter
 * on GOTO along its velocity ("flies on the way it was going": Ballpark::
 * StopAllFollowers, src/gamePort/destiny/ballpark.js), and through the gateway
 * the BFF opens the throttle before a follow, which is GOTO too. Rung 9 then
 * sends the formation keep-at-range, and the next snapshot can still show that
 * GOTO, a tick before FOLLOW lands. The veto asked for FOLLOW, so that tick read
 * "travelling" and lit the afterburner, and the tick after read formation and
 * stood it down again (seen live, 2026-10-13). GOTO with `followAnchorID` set
 * is never a heading of the ladder's own: every movement it sends other than
 * the formation order clears the anchor (`clearMovementLatches`), the fleet
 * rung's align and a warp landing included. So the formation is
 * `holdsFormation` with hostiles on grid in EITHER closing mode; a GOTO with no
 * anchor (an align, a heading of the pilot's own) is still a trip.
 */
function isUnderWay(obs: FleetCompanionObservation, memory: CompanionLadderMemory): boolean {
  const mode = obs.snapshot?.ship?.mode ?? null;
  if (mode !== null && CLOSING_SHIP_MODES.includes(mode.toUpperCase()) && !keepingFormation(obs, memory)) {
    return true;
  }
  return obs.travel?.status === "running";
}

/**
 * The formation rule's whole condition: hostiles on grid (`true` only) and the
 * ladder's own record says its last move was the formation order. Asked only of
 * a closing mode (`isUnderWay`, and the stop sentence in `decidePropulsion`).
 */
function keepingFormation(obs: FleetCompanionObservation, memory: CompanionLadderMemory): boolean {
  return obs.hostileOnGrid === true && holdsFormation(memory);
}

/**
 * Whether the FOLLOW (or the GOTO that precedes it; see `isUnderWay`) the ship
 * is in is the formation station on the commander.
 *
 * ⚠ THE FOLLOWED BALL CANNOT BE READ, SO THIS IS READ OFF THE LADDER'S OWN
 * RECORD. The snapshot's `ship` has the mode and no target, and
 * `SpaceEntity.targetEntityID` is filled for DRONE rows only. What the ladder
 * knows is `followAnchorID`: set when it sends `keepAtRange` at the commander
 * and cleared by `decideCompanionAction` the moment ANY other movement call goes
 * out (approach, dock, jump, warp, align, travel, stop). So a non-null anchor
 * means the last move this ladder sent was the formation order, and a FOLLOW
 * under it is that order.
 *
 * ⚠ THE APPROACH LATCHES ARE A SECOND, BELT-AND-BRACES VETO: `lootApproaching`
 * and `salvageApproachIssued`. `closingOn` (dock and gate approaches) is
 * deliberately NOT one -- nothing ever clears it, so it would veto the
 * formation for the rest of the run after the first gate; those approaches are
 * already excluded because issuing them clears `followAnchorID`.
 */
function holdsFormation(memory: CompanionLadderMemory): boolean {
  return memory.followAnchorID !== null
    && memory.lootApproaching === null
    && !memory.salvageApproachIssued;
}

/**
 * Rung 3b: the prop mod. On while this pilot is TRAVELLING, off when it is not,
 * and a commander's `props on` / `props off` beats both.
 *
 * ⚠ "TRAVELLING" IS `isUnderWay`, AND READING IT AS THE AUTOPILOT ALONE WAS THE
 * BUG THIS RUNG SHIPPED WITH. See that function's header: a companion in
 * ordinary fleet play never runs its own autopilot, so the first cut of this
 * rung was correct and never fired. What fires is the ship's own movement MODE
 * -- GOTO (flying a heading of its own) or FOLLOW (approaching something, or
 * keeping up with the commander, though not holding formation in a fight; see
 * `isUnderWay`) -- which is the burn a player actually makes:
 * landing off a gate and covering the last few km, or chasing an FC who is
 * pulling away.
 *
 * ⚠ A FLEE STILL GETS ONE, NOW, AND BY ACCIDENT RATHER THAN BY DESIGN. The
 * get-safe ladder approaches a station before docking, and an approach is
 * FOLLOW, so the burner lights for that leg -- even with hostiles on the grid,
 * because only the formation station (`holdsFormation`: the ladder's own
 * keep-at-range record, cleared by the approach it sends) loses the burner in a
 * fight, never an approach. The WARP leg of a flee gets nothing,
 * because the ladder never reaches this rung mid-warp (rung 1 yields first) and
 * a prop mod is no use in warp anyway. `props on` remains the way to say "keep
 * it lit regardless".
 *
 * ⚠ AN ORBIT IS NOT CLOSING. A ship holding station in ORBIT has arrived, so the
 * burner goes out rather than circling on full power for ever -- see
 * `CLOSING_SHIP_MODES`.
 *
 * ⚠ THE OVERRIDE IS THREE-STATE AND `null` IS NOT "OFF". `propsHeld` null means
 * nobody has said anything, so the travel test decides; `true`/`false` are a
 * standing instruction in either direction. Reading null as off would ship every
 * companion with a permanent order never to use its prop mod.
 *
 * WHY THE KIND MATTERS WITH HOSTILES ON GRID (`nav/companionPropulsion.ts`). On
 * this server a microwarpdrive blooms the ship's signature radius and an
 * afterburner does not. NPC turrets have a 50 per cent hit-chance floor, so a
 * bloom costs little against them; NPC missile damage falls with the target's
 * speed and small signature with NO floor. So, with `hostileOnGrid` true:
 *
 *   rats shoot with | afterburner                       | microwarpdrive
 *   turrets only    | lit while closing                 | never
 *   any missile rat | lit while closing AND while       | never
 *                   | holding the auto orbit            |
 *   unreadable      | lit while closing                 | never
 *   no hostiles     | the travel rule, as ever          | the travel rule, as ever
 *
 * "Closing" is `closingOnTheHold` or `isUnderWay`, as before; the orbit burn is
 * `flight auto` with the positioning rung's order standing and a KNOWN missile
 * rat on grid. A microwarpdrive already running when hostiles appear is stood
 * down, and a module whose `kind` is null (the SDE read did not arrive) is
 * treated as one. Unreadable rat facts never earn the orbit burn.
 *
 * ⚠ `props on` BEATS THE MWD BAN. `propsHeld` non-null is a commander's
 * standing word: `props on` means they chose to burn, so the whole rack is
 * handed to the shared policy and a microwarpdrive-only fit lights as it always
 * did; `props off` already stops whatever is lit. The ban applies to the
 * automatic rule only.
 *
 * ⚠ THE REST OF THE POLICY IS `nav/propulsion.ts` AND ITS HEADER IS THE
 * AUTHORITY. The scram that stands down a microwarpdrive and ONLY a
 * microwarpdrive, the unknown `kind` treated as the scram-vulnerable half, the
 * capacitor floor that gates the lighting and never the stopping, and the
 * one-call-then-fall-through shape all moved there WORD FOR WORD when the
 * drone-boat block turned out to want the identical answer. They are not
 * summarised back here: two copies of a scram rule with nothing to fail if one
 * drifted is the bug this file warns about elsewhere. What this rung still owns
 * is the question above -- travelling, or told to burn -- plus the latch that
 * keeps a deactivate from being issued twice, which is about calls already
 * spent rather than about what the rack should look like.
 */
function decidePropulsion(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory; readonly trace: PropsTrace } {
  // ⚠ `wantBurn` IS THE WHOLE OF WHAT THIS LOOP STILL DECIDES ABOUT PROPULSION.
  // The standing chat order beats the travel test and `null` is not "off"; see
  // this rung's header. Everything downstream of the question -- the scram, the
  // unknown kind, the floor, which module -- is `decidePropulsionModule`.
  //
  // ⚠ WHILE RUNG 8'S OWN ORDER STANDS, THE BURNER IS RUNG 8'S: lit only while
  // closing on its hold. A drone boat's keep-at-range on a RAT is FOLLOW mode
  // and is not formation, so `isUnderWay` alone would read it as travelling
  // and burn the whole fight -- the bug the formation rule exists to remove.
  // `propsBecause` is that precedence, as one code for the trace.
  const ownHold = memory.flightMode === "auto" && memory.combatPosition.hold !== null;
  const missileOrbit = orbitingAgainstMissiles(obs, memory);
  const because = propsBecause({
    held: memory.propsHeld,
    ownHold,
    closing: closingOnTheHold(memory),
    missileOrbit,
    travel: isUnderWay(obs, memory),
  });
  const wantBurn = propsWanted(because);
  // The inputs the formation rule turns on, as this tick read them, so a burner
  // that flickers can be explained from the log alone (companionTrace.ts).
  const shipMode = obs.snapshot?.ship?.mode ?? null;
  const read = { hostiles: obs.hostileOnGrid ?? null, formation: holdsFormation(memory), mode: shipMode };
  const done = (decision: CompanionDecision | null, next: CompanionLadderMemory, withheld: PropsWithheld | null) =>
    ({ decision, memory: next, trace: { want: wantBurn, because, withheld, ...read } });

  const fitted = request.propulsionModules;
  if (fitted.length === 0 || obs.inSpace !== true) {
    return done(null, memory, null);
  }
  // ⚠ `activeModuleIDs` IS THE AUTHORITY AND `null` MEANS "CANNOT SAY". An
  // unreadable snapshot must not be read as "nothing is running" -- that would
  // have this rung re-activate a burner that is already lit, every tick, for as
  // long as the read stayed down. The shared policy takes a Set and no null,
  // which is why this test stays on THIS side of the call: a companion that
  // cannot see its own rack has nothing to ask.
  const active = obs.snapshot?.ship?.activeModuleIDs ?? null;
  if (active === null) {
    return done(null, memory, "unreadable-rack");
  }

  const activeSet = new Set(active);
  // ⚠ A RUNNING MWD (OR UNKNOWN KIND) WITH HOSTILES ON GRID IS STOOD DOWN HERE:
  // the narrowed list below hides it from the shared policy, which cannot stop
  // what it was not shown. The latch is the same one, so it is sent once.
  const gridProps = propsOnThisGrid(fitted, activeSet, obs, memory);
  if (gridProps.standDown !== null) {
    if (memory.propsStoppingID === gridProps.standDown.itemID) {
      return done(null, memory, "stop-latched");
    }
    return done({
      action: { kind: "deactivate", moduleID: gridProps.standDown.itemID, typeID: gridProps.standDown.typeID },
      phase: "Propulsion",
      why: MWD_STAYS_OFF_WHY,
      memory: { ...memory, propsStoppingID: gridProps.standDown.itemID },
    }, memory, wantBurn ? "mwd-banned" : null);
  }
  const inputs: PropulsionInputs = {
    modules: gridProps.modules,
    activeModuleIDs: activeSet,
    capacitorRatio: obs.capacitorRatio ?? null,
    scrammed: obs.scrammed ?? null,
    wantBurn,
    capFloor: request.capacitorFloor,
  };
  const call = decidePropulsionModule(inputs);

  if (call.kind === "stop") {
    // One module per tick, and once per module until the snapshot proves it
    // stopped -- the latch is this loop's, because it is about calls already
    // spent and not about what the rack should look like.
    if (memory.propsStoppingID === call.module.itemID) {
      return done(null, memory, "stop-latched");
    }
    // The sentence names the cause: "not travelling" was once said for all four.
    // Formation in either closing mode, the same test `isUnderWay` makes.
    const mode = shipMode?.toUpperCase() ?? null;
    const stopCause = because === "held-off" ? "held-off"
      : ownHold ? "on-station"
        : mode !== null && CLOSING_SHIP_MODES.includes(mode) && keepingFormation(obs, memory) ? "formation"
          : "not-travelling";
    return done({
        // ⚠ THE typeID IS WHAT MAKES THIS WORK AT ALL. Deactivate stops a prop
        // mod only when it names the propulsion effect, and the BFF resolves
        // that name from the typeID -- without it the call returns success and
        // the burner keeps cycling. See the action's own header.
        action: { kind: "deactivate", moduleID: call.module.itemID, typeID: call.module.typeID },
        phase: "Propulsion",
        why: propsStopWhy(stopCause),
        memory: { ...memory, propsStoppingID: call.module.itemID },
        ...(memory.propsHeld === false
          ? {
              followingOrderFrom: "chat" as const,
              lastOrderHeard: "a chat order to stop the prop mod",
            }
          : {}),
    }, memory, null);
  }

  if (call.kind === "light") {
    return done({
        // ⚠ SELF-TARGETED, so no `targetID` -- `0` is this codebase's sentinel for
        // "run it on the caster", the same form the hardeners use.
        action: { kind: "activate", moduleID: call.module.itemID, targetID: 0 },
        phase: "Propulsion",
        why: propsLightWhy(because, missileOrbit),
        memory: { ...memory, propsStoppingID: null },
        ...(memory.propsHeld === true
          ? {
              followingOrderFrom: "chat" as const,
              lastOrderHeard: "a chat order to run the prop mod",
            }
          : {}),
    }, memory, null);
  }

  // Nothing to do: the rack already agrees with what is wanted. Clearing the
  // latch here is what lets a REFUSED deactivate be retried rather than stick --
  // nothing is being stopped, so nothing is outstanding.
  //
  // ⚠ EXCEPT WHEN THE FLOOR IS THE ONLY THING HOLDING THE LIGHT BACK, which is
  // not the same "nothing to do" and must not clear the latch: a burner that
  // was told to stop, is still cycling, and is being waited on across a tick or
  // two of low capacitor has a deactivate outstanding the whole time, and
  // clearing the latch would spend a second one. The policy is asked rather
  // than re-implemented -- it fails open on an unreadable capacitor, so
  // re-asking with `null` is exactly "would you have lit one but for the floor?".
  const heldBackByTheFloor =
    inputs.wantBurn &&
    inputs.capacitorRatio !== null &&
    inputs.capacitorRatio < inputs.capFloor &&
    decidePropulsionModule({ ...inputs, capacitorRatio: null }).kind === "light";
  if (heldBackByTheFloor) {
    return done(null, memory, "cap-floor");
  }
  // The trace's other reasons a wanted burn lit nothing. Only when NOTHING the
  // policy was shown is running: a lit afterburner beside an idle, banned
  // microwarpdrive is the burn that was wanted, not one withheld.
  const lit = gridProps.modules.some((module) => activeSet.has(module.itemID));
  const failOpen = { capacitorRatio: null, scrammed: null } as const;
  const withheld: PropsWithheld | null = !wantBurn || lit ? null
    : gridProps.modules.length < fitted.length &&
        decidePropulsionModule({ ...inputs, ...failOpen, modules: fitted }).kind === "light" ? "mwd-banned"
    : inputs.scrammed === true && decidePropulsionModule({ ...inputs, ...failOpen }).kind === "light" ? "scrammed"
    : null;
  return done(null, memory.propsStoppingID === null ? memory : { ...memory, propsStoppingID: null }, withheld);
}

/**
 * The `stop` order: cut the engines, once.
 *
 * ⚠ EVERYTHING ELSE `stop` DOES HAS ALREADY HAPPENED BY THE TIME THIS RUNS.
 * `withAreaJob` dropped the area job and `withStandingChatOrders` cleared the
 * trip and suspended the follow, both above the supervision gate, because those
 * are bookkeeping and must land even on a tick that can issue nothing. This rung
 * is only the half that costs a CALL, and a call has to come through the ladder
 * like any other.
 *
 * ⚠ IT DOES NOT CHECK WHETHER THE SHIP IS ACTUALLY MOVING, and that is
 * deliberate rather than lazy. Nothing this loop reads says what standing order
 * the server is holding the hull under -- `shipMode` names a mode, not an order
 * -- so "is there anything to stop" is a question with no honest answer here.
 * One call, on the tick the word is heard, is cheap and is what the operator
 * asked for; guessing it was unnecessary is how a `stop` silently does nothing.
 */
function decideStopShip(memory: CompanionLadderMemory): CompanionDecision | null {
  if (memory.stopHeardAtMs === null || memory.stopShipIssued) {
    return null;
  }
  return {
    action: { kind: "stopShip" },
    phase: "Stopping",
    why: "A commander said stop in chat. Cutting the engines where the ship is.",
    memory: { ...memory, stopShipIssued: true },
    followingOrderFrom: "chat",
    lastOrderHeard: "a chat order to stop",
  };
}

/**
 * The `destination` order: a latched multi-jump trip, flown by the shared
 * autopilot.
 *
 * ⚠ THIS RUNG SITS ABOVE RUNG 7 AND THAT IS THE WHOLE FEATURE. The operator's
 * words are "travels to it without additional interruption, unless stop is
 * written in chat", and a rung beneath the fleet-order rung would be derailed by
 * the first `Target` broadcast or chat target call to arrive mid-route -- the
 * companion would stop two jumps out to lock something it cannot reach and never
 * finish the trip. So a standing trip PARKS the tick: it returns a real decision
 * every tick it stands, which is exactly what starves rung 7 and the salvage and
 * loot rungs beneath it. That is the intended reading, not a side effect.
 *
 * ⚠ AND IT SITS BELOW THE SUPERVISION GATE, RUNG 3 (TANK UP) AND RUNG 5 (THE
 * FLEE), WHICH IS A DELIBERATE READING OF THE SAME SENTENCE. "Without additional
 * interruption" means "do not get distracted by the fleet's calls". It does not
 * mean "keep flying while the ship dies": a companion that is dying still flees,
 * a companion taking damage still runs its tank, and a companion nobody is
 * supervising still gets itself safe. Read narrowly, the operator's words would
 * put a route above survival; nobody asks for a bot that flies its corpse to the
 * destination, and this is recorded as an interpretation rather than smuggled in
 * as an obvious truth.
 *
 * ⚠ THE `travelTo` GOES OUT ONCE PER DESTINATION. It hands off to the SHARED
 * autopilot (flow.ts's `startRoute` -- see the dispatcher's own `travelTo`
 * comment: it runs the whole route), a separate decide-loop from this one, so
 * re-issuing it every tick would restart the route solver twice a second. The
 * gate is `destinationRoutedFor`, this rung's own and not rung 7's -- see that
 * field for the bug that sharing one caused.
 *
 * Threaded like rung 3 (`{ decision, memory }`) because ARRIVING issues no
 * action at all: a call site that took only the decision would throw the
 * cleared job away and go on reporting a trip that finished.
 */
function decideDestinationTrip(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const destination = memory.destinationSystemID;
  if (destination === null) {
    return { decision: null, memory };
  }
  // ⚠ THE SYSTEM, FROM FLIGHT STATUS, AND ONLY WHEN IT READS. `flightStatus` is
  // the authoritative "where is this pilot" the flee's own return leg already
  // uses (`fromSolarSystemID`); a null is "could not tell", never "not there
  // yet", so an unreadable status leaves the job standing rather than ending a
  // trip that is still running.
  const here = obs.flightStatus?.solarSystemID ?? null;
  if (here !== null && here === destination) {
    return {
      decision: null,
      memory: { ...memory, destinationSystemID: null, destinationRoutedFor: null },
    };
  }
  if (memory.destinationRoutedFor !== destination) {
    return {
      decision: {
        action: { kind: "travelTo", systemID: destination },
        phase: "Travelling",
        why: "A commander named a destination in chat. Starting the route.",
        memory: { ...memory, destinationRoutedFor: destination },
        followingOrderFrom: "chat",
        lastOrderHeard: "a chat order to travel to a system",
      },
      memory,
    };
  }
  // ⚠ A REAL DECISION, NOT A `standing` ONE. `CompanionDecision.standing` means
  // "hold this aside as a readout and let the rungs beneath have the tick",
  // which is the opposite of what this order asked for. The panel gets a phase
  // that names the trip -- a multi-jump ride must not report "Standing by" for
  // minutes -- and the ladder below it deliberately does not run.
  return {
    decision: {
      action: WAIT,
      phase: "Travelling",
      why: "On the way to the system a commander named. Nothing else until it lands or somebody says stop.",
      memory,
      followingOrderFrom: "chat",
      lastOrderHeard: "a chat order to travel to a system",
    },
    memory,
  };
}

// ─── The reload rung: put rounds back in the guns ────────────────────────────
//
// ⚠ NOTHING RELOADS A PLAYER'S GUNS ON THIS SERVER, AND THAT IS THE WHOLE
// JUSTIFICATION FOR THIS RUNG. It is the opposite of retail, so it is recorded
// here rather than left to be rediscovered. Turret ammunition is consumed per
// cycle and at zero the charge item is REMOVED outright
// (`consumeTurretAmmoCharge`, /d/evet/server/src/space/runtime.js:18473).
// `queueAutomaticLocalModuleReload` — the thing that would put it back — has
// exactly three call sites: command bursts, generic modules on cycle end, and
// NPC turrets. The only producers of the `effectState.autoReloadOnCycleEnd`
// that drives the generic one are the three PROBE LAUNCH paths in
// `dogmaService.js` (~8950/8992/9026). So a player gun that runs dry stays dry
// for the rest of the fight, and nothing in this repo has ever loaded one: the
// companion merely WARNED, once, at start (`companionFitWarnings`,
// web/src/bots/companionFitCheck.ts), and then let the guns click empty.
//
// ⚠ AND A STANDING `destination` TRIP STARVES THIS RUNG, WHICH WAS CONSIDERED
// AND KEPT. The trip rung directly above returns a real decision on every tick
// it stands, deliberately, because the operator's words for it are "travels to
// it without additional interruption" — so a companion crossing four systems
// does not reload on the way. That is the same consequence the fleet's own
// target calls already live with, and unpicking it here would mean unpicking the
// trip rung's whole reading of that sentence. A pilot that arrives, or is told
// `stop`, reloads on the very next tick.

/**
 * Bound on `loadAmmo` calls for ONE gun, mirroring `MAX_COMPANION_TAG_ATTEMPTS`
 * above and its reasoning exactly: a call whose refusal is INVISIBLE to this
 * layer must not be resent for ever.
 *
 * ⚠ IT BOUNDS CALLS PER EMPTY GUN, NOT RETRIES AGAINST FRESH READINGS, and the
 * difference is worth stating because the three facts this rung reads are
 * THROTTLED. Several consecutive ticks may see the same "still empty" list, so a
 * budget can be spent before a single refreshed reading arrives — meaning a load
 * that actually worked can still cost three calls before the refresh proves it.
 * That is accepted: what the budget has to guarantee is that a gun which cannot
 * take the only ammunition aboard stops being asked, and three calls per
 * emptiness is a cheap price for never starving the rungs beneath this one.
 */
const MAX_COMPANION_RELOAD_ATTEMPTS = 3;

/**
 * The biggest stack, ties broken on the LOWER item id.
 *
 * ⚠ THE TIE-BREAK IS NOT COSMETIC. "Use the one with the largest amount" is the
 * operator's own rule, and two identical stacks are an ordinary thing to be
 * carrying; without a second key the choice would depend on the order the cargo
 * read happened to return, which is neither stable across ticks nor assertable
 * in a test. A gun that chose differently on each tick would also break the
 * banking below, which groups guns by the stack they picked.
 */
function largestStack(charges: readonly CompanionCargoCharge[]): CompanionCargoCharge | null {
  let best: CompanionCargoCharge | null = null;
  for (const charge of charges) {
    if (
      best === null ||
      charge.quantity > best.quantity ||
      (charge.quantity === best.quantity && charge.itemID < best.itemID)
    ) {
      best = charge;
    }
  }
  return best;
}

/**
 * The stack this gun should take: the largest one its type accepts, and failing
 * that the largest one aboard.
 *
 * ⚠ THE FALLBACK IS DELIBERATE AND IS NOT SLOPPINESS. It mirrors the rule
 * `chargeLooksCompatible` (web/src/bridge/fitting.ts:444) states for itself, in
 * this codebase's own words: the compatibility table is ADVISORY, the SERVER
 * decides what loads, and "hiding a charge that would have worked is a worse
 * failure than showing one that will not". So a group list that matches nothing
 * is a reason to guess, not a reason to refuse — and the attempt budget above is
 * what keeps a wrong guess from costing more than three calls.
 *
 * ⚠ "CANNOT SAY" IS NEUTRAL, NEVER A NO — the same three-state rule that
 * function's own header states. A module with no entry in `weaponChargeGroups`,
 * an entry that is empty, and a stack whose `groupID` could not be decoded are
 * all unknowns: an unknown never suppresses a load, it only fails to RANK one.
 *
 * Nothing is imported from `fitting.ts` to do this. The ladder is a pure decider
 * and the group lists arrive on the observation already decoded; reaching into
 * the bridge for a size check it has no size for would couple this file to a
 * panel's helper for no answer it could use.
 */
function pickChargeFor(
  moduleID: number,
  charges: readonly CompanionCargoCharge[],
  groups: Readonly<Record<number, readonly number[]>> | null,
): CompanionCargoCharge | null {
  const accepted = groups?.[moduleID] ?? null;
  const compatible =
    accepted === null || accepted.length === 0
      ? []
      : charges.filter(
          (charge) => charge.groupID !== null && accepted.includes(charge.groupID),
        );
  return largestStack(compatible.length > 0 ? compatible : charges);
}

/**
 * Drop the attempt record of every gun that is no longer empty.
 *
 * This is the whole of the confirm-and-reset half of the rung: a gun that left
 * `emptyWeaponModuleIDs` took its rounds, so its budget goes back to full and it
 * can be reloaded again the next time it runs dry.
 */
function withReloadAttemptsPruned(
  memory: CompanionLadderMemory,
  empty: readonly number[],
): CompanionLadderMemory {
  const still = new Set(empty);
  const kept: Record<number, number> = {};
  let dropped = false;
  for (const [key, attempts] of Object.entries(memory.reloadAttempts)) {
    if (still.has(Number(key))) {
      kept[Number(key)] = attempts;
    } else {
      dropped = true;
    }
  }
  // A gun that left the list took its rounds: its load is no longer in flight.
  const keptInFlight: Record<number, number> = {};
  let droppedInFlight = false;
  for (const [key, atMs] of Object.entries(memory.reloadInFlight ?? {})) {
    if (still.has(Number(key))) {
      keptInFlight[Number(key)] = atMs;
    } else {
      droppedInFlight = true;
    }
  }
  return dropped || droppedInFlight
    ? { ...memory, reloadAttempts: kept, reloadInFlight: keptInFlight }
    : memory;
}

/**
 * Forget the in-flight load of every gun in `moduleIDs`: the server REFUSED the
 * `loadAmmo`, so nothing is reloading and the rung may judge those guns again.
 * The attempt it cost stays spent, so a gun that is refused every time still
 * gives up after `MAX_COMPANION_RELOAD_ATTEMPTS`.
 */
function noteRefusedReload(memory: CompanionLadderMemory, moduleIDs: readonly number[]): CompanionLadderMemory {
  const sent = memory.reloadInFlight ?? {};
  if (!moduleIDs.some((id) => sent[id] !== undefined)) {
    return memory;
  }
  const kept: Record<number, number> = {};
  for (const [key, atMs] of Object.entries(sent)) {
    if (!moduleIDs.includes(Number(key))) {
      kept[Number(key)] = atMs;
    }
  }
  return { ...memory, reloadInFlight: kept };
}

/**
 * Load ammunition into guns that have none.
 *
 * ⚠ IT SITS ABOVE RUNG 7, AND THAT IS THE POINT. An empty gun makes the whole
 * fire path of `lockThenEngage` a no-op — the `activate` goes out, the server
 * accepts it and nothing comes off the target — so reloading has to outrank
 * obeying a target call or a companion answers every call by pointing an empty
 * rack at it. The cost of being above rung 7 is bounded and small: at most
 * `MAX_COMPANION_RELOAD_ATTEMPTS` calls per empty gun and then it falls through
 * for good.
 *
 * ⚠ AND IT SITS BELOW THE FLEE AND BELOW TANK-UP, for the reason those rungs sit
 * where they do: a reload is worthless on a ship that is about to be wreckage. A
 * pilot through its health floor leaves first and reloads when it is somewhere
 * it can.
 *
 * ⚠ CONFIRMATION IS THE GUN LEAVING `emptyWeaponModuleIDs`, NEVER THE CALL
 * RETURNING CLEANLY — the idiom rung 4's tag write uses, copied deliberately and
 * for the identical reason. The server decides what may be loaded and refuses
 * with its own words that never reach this layer (see the dispatcher's own
 * comment on `api.loadAmmo`), so an accepted load and a refused one are
 * byte-identical here. Everything that follows from that is rung 4's shape too:
 * one call per tick, a per-gun budget, and a give-up that moves on to the NEXT
 * empty gun rather than ending the tick.
 *
 * ⚠ IT RETURNS ITS MEMORY EVEN WHEN IT DECIDES NOTHING, the shape `decideTankUp`
 * and `decideTackleTag` both have: the prune above happens on ticks that issue
 * no action at all, and a call site that took only the decision would throw away
 * the fact that a gun got loaded.
 *
 * ⚠ A LOAD THAT WAS SENT IS WAITED ON, NOT RE-SENT (seen live 2026-10-14
 * 09:31-09:32 UTC). The server's reload takes the gun's reload time (about 10 s
 * on a turret) and the gun reads EMPTY the whole while, so "still empty" on the
 * next tick is not evidence the load failed: three `loadAmmo` went out in about
 * a second and the attempt budget was gone before the reload finished. Sending
 * stamps `reloadInFlight`; a stamped gun is stepped over until its reload time
 * plus one stale-read window has passed (`reloadingGuns`), and only THEN is a
 * gun still reading empty a load that failed, retried under the same budget. A
 * refused call clears the stamp (`noteRefusedReload`).
 */
function decideReload(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  // A fight starting again re-arms the clear-grid top-up (companionAmmo.ts).
  // Here, above rung 7, because a fight's ticks seldom reach the top-up's rung.
  memory = clearGridRearmed(obs, memory);
  const nothing = { decision: null, memory } as const;
  // ⚠ THE WARP GATE IS BELT AND BRACES, like the follow rung's: rung 1 has
  // already returned before this is reached mid-warp. Kept so the function's
  // contract does not depend on where it is called from.
  if (obs.inWarp === true || obs.inSpace !== true) {
    return nothing;
  }
  // `null` is "the fit could not be read", which is not evidence the guns are
  // loaded. Silence, and nothing pruned.
  const empty = obs.emptyWeaponModuleIDs ?? null;
  if (empty === null) {
    return nothing;
  }
  // Ammo by target (companionAmmo.ts): records each loaded gun's reach, and
  // ranks the stack for an empty gun when the target is known.
  const ammo = emptyGunAmmo(obs, withReloadAttemptsPruned(memory, empty));
  const mem = ammo.memory;
  if (empty.length === 0) {
    return { decision: null, memory: mem };
  }
  // Guns whose load was sent and whose reload is still running are stepped over
  // everywhere below; `dry` is the rest.
  const waiting = reloadingGuns(obs, mem, nowMs, RELOAD_STALE_READ_MS);
  const dry = empty.filter((moduleID) => !waiting.has(moduleID));
  if (dry.length === 0) {
    // A READOUT, NOT SILENCE, AND NOT A REAL DECISION: `standing`, like the
    // "Out of ammunition" ones below, so the ladder beneath still gets the tick
    // and the guns that are loaded go on firing. It must come BEFORE the cargo
    // checks: a load that took the last stack aboard leaves an empty bay, and
    // "out of ammunition" would be false for a gun that is loading.
    return {
      decision: {
        action: WAIT,
        phase: "Reloading",
        why: "Waiting for the reload to finish.",
        memory: mem,
        standing: true,
      },
      memory: mem,
    };
  }
  const charges = obs.cargoCharges ?? null;
  if (charges === null) {
    // Again "could not read", and again silence: a cargo bay this tick could not
    // open is not a cargo bay with nothing in it, and saying so in the readout
    // would report a shortage nobody has measured.
    return { decision: null, memory: mem };
  }
  if (charges.length === 0) {
    // ⚠ A READOUT, NOT SILENCE, BUT ALSO NOT A REAL DECISION. Empty guns and no
    // ammunition aboard is a condition the operator wants to SEE -- it is why
    // this pilot's damage stopped -- and there is nothing whatever to issue for
    // it. So it goes out as a `standing` decision: the action is `wait`, the
    // ladder beneath still gets the tick, and `decideCompanionAction` falls back
    // to this phrase only if nothing else had anything to do. See
    // `CompanionDecision.standing`, whose contract this is the second user of.
    return {
      decision: {
        action: WAIT,
        phase: "Out of ammunition",
        why:
          dry.length === 1
            ? "A gun is empty and there is nothing in the cargo bay to load it with."
            : `${dry.length} guns are empty and there is nothing in the cargo bay to load them with.`,
        memory: mem,
        standing: true,
      },
      memory: mem,
    };
  }

  const groups = obs.weaponChargeGroups ?? null;
  // ⚠ OPERATOR RULE (2026-10-14): ON A CLEAR GRID AN EMPTY GUN TAKES ITS OWN
  // CHARGE BACK, ELSE THE OTHER GUNS' CHARGE, ELSE THE MOST VERSATILE ONE --
  // and when its charge groups are known and nothing aboard fits, nothing. See
  // `clearGridEmptyGunPick`. Only the CHOICE changes: the budget and banking
  // below are this rung's, so a load that does not take stops after three
  // calls exactly as it does mid-fight. A gun whose groups cannot be read
  // ("unknown") keeps the rule below.
  const gridClear = gridSeenClear(obs);
  type ReloadRule = "ranked" | "largest" | ClearGridRule | "nothing-fits";
  // The ranked stack when there is one, else the largest-stack rule below; the
  // rule rides along so the readout can say which one chose.
  const pickWithRule = (moduleID: number): { charge: CompanionCargoCharge | null; rule: ReloadRule } => {
    if (gridClear) {
      const onClear = clearGridEmptyGunPick(obs, mem, moduleID, charges, empty);
      if (onClear.rule !== "unknown") {
        return { charge: onClear.charge, rule: onClear.rule };
      }
    }
    const ranked = ammo.pickWithRule(moduleID, charges);
    return ranked.charge !== null ? ranked : { charge: pickChargeFor(moduleID, charges, groups), rule: "largest" };
  };
  const pick = (moduleID: number): CompanionCargoCharge | null => pickWithRule(moduleID).charge;
  const spent = (moduleID: number): boolean =>
    (mem.reloadAttempts[moduleID] ?? 0) >= MAX_COMPANION_RELOAD_ATTEMPTS;

  // The first gun with budget left, and the stack it picked. Guns whose budget
  // is spent are STEPPED OVER rather than ending the tick -- one gun nothing
  // aboard will fit must not stop the rest of the rack being loaded.
  let first: number | null = null;
  let chosen: CompanionCargoCharge | null = null;
  let rule: ReloadRule = "largest";
  let nothingFits = false;
  for (const moduleID of dry) {
    if (spent(moduleID)) {
      continue;
    }
    const picked = pickWithRule(moduleID);
    if (picked.charge === null) {
      nothingFits ||= picked.rule === "nothing-fits";
      continue;
    }
    first = moduleID;
    chosen = picked.charge;
    rule = picked.rule;
    break;
  }
  if (first === null || chosen === null) {
    if (nothingFits) {
      // A clear grid, an empty gun, and its charge groups known with nothing
      // aboard among them: nothing to issue, and a readout saying so -- the
      // `standing` shape of the "Out of ammunition" one above, so it replaces
      // "Standing by" and never a real call. Nothing is spent, so it costs no
      // call however long it stands.
      return {
        decision: {
          action: WAIT,
          phase: "Out of ammunition",
          why: "The grid is clear: a gun is empty and nothing in the cargo bay fits it.",
          memory: mem,
          standing: true,
        },
        memory: mem,
      };
    }
    // Every dry gun has spent its budget. Nothing is issued and nothing is
    // said: there IS ammunition aboard, so "out of ammunition" would be false,
    // and this pilot has done what it can. (A gun still reloading was answered
    // above: this point is only reached with a dry gun that has run out.)
    return { decision: null, memory: mem };
  }

  // ⚠ ONE CALL FOR THE WHOLE BANK. Every other still-budgeted empty gun that
  // picked the SAME stack rides along, because `api.loadAmmo` takes a list and
  // this loop issues one call per tick: eight guns loaded one per tick would be
  // sixteen seconds of a ship shooting nothing. Guns that picked a different
  // stack wait for their own tick rather than being loaded with the wrong round.
  const bank = dry.filter(
    (moduleID) =>
      !spent(moduleID) && pick(moduleID)?.itemID === chosen.itemID,
  );
  const attempts: Record<number, number> = { ...mem.reloadAttempts };
  const inFlight: Record<number, number> = { ...(mem.reloadInFlight ?? {}) };
  for (const moduleID of bank) {
    attempts[moduleID] = (attempts[moduleID] ?? 0) + 1;
    inFlight[moduleID] = nowMs;
  }
  const retrying = (mem.reloadAttempts[first] ?? 0) > 0;
  // A gun loaded on a clear grid comes up full, so the top-up need not ask it.
  const loadedMem = gridClear ? withClearGridToppedUp(mem, bank) : mem;
  if (rule === "own" || rule === "match" || rule === "versatile") {
    return {
      decision: {
        action: { kind: "loadAmmo", moduleIDs: bank, chargeItemID: chosen.itemID },
        phase: "Reloading",
        // The name only when the charge facts RESOLVED it, as rung 7c words its
        // swaps; never one invented here.
        why: clearGridEmptyGunWords(
          rule, obs.chargeFactsByTypeID?.[chosen.typeID]?.name ?? null, bank.length, retrying),
        memory: { ...loadedMem, reloadAttempts: attempts, reloadInFlight: inFlight },
      },
      memory: mem,
    };
  }
  // Which rule picked the stack: ranked for the target, or the largest stack.
  const ruleWords = rule === "ranked" ? " Best ammo for the target." : " Largest stack.";
  return {
    decision: {
      action: { kind: "loadAmmo", moduleIDs: bank, chargeItemID: chosen.itemID },
      phase: "Reloading",
      // ⚠ NO CHARGE NAME, EVER. This ladder holds ids and never a type name, and
      // inventing one ("loading Antimatter") would be the readout claiming
      // something nothing here resolved.
      why: (retrying
        ? bank.length === 1
          ? "That gun is still empty. Loading it again from the cargo bay."
          : `Those ${bank.length} guns are still empty. Loading them again from the cargo bay.`
        : bank.length === 1
          ? "A gun is empty. Loading it from the cargo bay."
          : `${bank.length} guns are empty. Loading them from the cargo bay.`) + ruleWords,
      memory: { ...loadedMem, reloadAttempts: attempts, reloadInFlight: inFlight },
    },
    memory: mem,
  };
}

/**
 * The standing `follow`: hold station off the fleet commander.
 *
 * ⚠ IT IS A STANDING BEHAVIOUR, NOT AN ORDER OBEYED ONCE. Nobody has to type
 * anything for this to happen: whenever no rung above it is doing something, a
 * companion sticks to its anchor. `follow 10 km` only changes the DISTANCE, and
 * `stop` suspends it (see `followHeld`).
 *
 * ⚠ THE ANCHOR IS THE FLEET COMMANDER, NEVER THE PILOT WHO TYPED THE ORDER.
 * `commandersFor` is the roster's own commander list -- the same one that says
 * whose chat orders are obeyed at all -- so a squad that changes FC re-anchors
 * on the next tick without anybody typing anything, and a fleet-mate who is not
 * in charge cannot make a companion escort THEM by typing `follow`.
 *
 * ⚠ IT SITS AT THE VERY BOTTOM OF THE LADDER, BENEATH EVEN THE LOOT AND SALVAGE
 * RUNGS, BECAUSE IT MOVES THE SHIP. That is the same argument the loot rung's
 * header makes -- see it -- and it applies here with more force, because looting
 * at least stops when the grid is clear while this never stops at all. A
 * formation-keeping order that could outrank a fleet order, a flee or a salvage
 * job would be a companion that answers nothing else for the rest of the run.
 *
 * ⚠ AND BENEATH THE STANDING-ORDER READOUT TOO, which means a companion whose
 * guns are already running on a called target does NOT re-anchor while it
 * shoots. Obeying the fleet outranks keeping formation; if that ever needs to
 * change, it is a precedence decision and not a tidy-up.
 */
function decideFollow(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  if (memory.followHeld) {
    return null;
  }
  // The same gates `orbitFleetMate` (`scriptMacros.ts`) puts in front of its own
  // escort, for its own reasons: nothing is decided mid-warp, there is nothing
  // to hold station off from inside a station, and a grid that cannot be read
  // cannot be anchored on.
  //
  // ⚠ THE WARP GATE HERE IS BELT AND BRACES: rung 1 returns before this rung is
  // ever reached mid-warp. It is kept because this function's contract should
  // not depend on where somebody happens to call it from, which is the same
  // reason the salvage and loot rungs each carry their own copy.
  if (obs.inWarp === true || obs.inSpace !== true || (obs.snapshot ?? null) === null) {
    return null;
  }
  // ⚠ AND SO IS THIS ONE, UNREACHABLE AS THE LADDER STANDS. `orbitFleetMate`
  // needs it live -- a DSL block runs with no supervision gate above it -- but
  // here `supervisorsInFleet` has already turned a null roster into a
  // "Checking supervision" wait several rungs up, so this can only fire if that
  // gate is ever moved or removed. It is kept rather than deleted because
  // `fleetShipsOnGrid` below answers "no fleet ships on grid" for an unread
  // roster, which is indistinguishable from "the FC is not here" and would have
  // this rung report standing by for a reason that was never measured.
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return null;
  }
  const onGrid = fleetShipsOnGrid(obs);
  let anchor: SpaceEntity | null = null;
  // ⚠ IN THE ROSTER'S ORDER, NOT THE GRID'S. A fleet can have several
  // commanders (boss, wing, squad) and more than one may be on this grid; taking
  // the first the roster names means every companion in the fleet picks the SAME
  // anchor from the same list, without any of them telling each other anything --
  // the same no-channel agreement `pickForThisPilot` relies on for wrecks.
  for (const commanderID of commandersFor(obs)) {
    const ship = onGrid.find((entity) => entity.characterID === commanderID) ?? null;
    if (ship !== null) {
      anchor = ship;
      break;
    }
  }
  if (anchor === null) {
    // No commander here -- or no commanders at all, because the roster could not
    // be read. A companion whose FC is not on this grid is not following
    // anybody; it falls through to "Standing by" rather than inventing an anchor
    // out of whichever fleet-mate happens to be nearest.
    return null;
  }
  const range = memory.followRangeM;
  let previous = memory.followOrder?.targetID === anchor.itemID && memory.followOrder.range === range
    ? memory.followOrder : null;
  if (previous !== null && previous.cooldown !== undefined) {
    if (previous.cooldown > 1) {
      return waiting("Following", "Waiting a moment before sending the formation request again.", {
        ...memory, followOrder: { ...previous, cooldown: previous.cooldown - 1 },
      });
    }
    // The wait is over: the order is sent again from scratch, counters and all.
    // `followAnchorID` goes too, or the "already holding" check below would
    // read the stale stamp as a standing order and send nothing.
    memory = { ...memory, followOrder: null, followAnchorID: null };
    previous = null;
  }
  if (previous !== null && previous.deferrals >= MAX_COMPANION_SESSION_DEFERRALS) {
    return waiting("Following", "A session change kept blocking formation movement. Trying again shortly.", {
      ...memory, followOrder: { ...previous, cooldown: COMPANION_RETRY_BACKOFF_TICKS },
    });
  }
  if (previous?.deferralWait) {
    return waiting("Following", "Waiting for the session change to clear before retrying formation movement.", {
      ...memory, followOrder: { ...previous, deferralWait: false },
    });
  }
  if (previous !== null && previous.status === "uncertain") {
    return waiting("Following", "The formation request got no answer. Sending it again in a moment.", {
      ...memory, followOrder: { ...previous, cooldown: COMPANION_RESEND_WAIT_TICKS },
    });
  }
  if (previous !== null && previous.refusals >= MAX_COMPANION_FOLLOW_REFUSALS) {
    return waiting("Following", "The formation request was refused repeatedly. Trying again shortly.", {
      ...memory, followOrder: { ...previous, cooldown: COMPANION_RETRY_BACKOFF_TICKS },
    });
  }
  if (memory.followAnchorID === anchor.itemID && memory.followRangeIssuedM === range &&
    (previous === null || previous.status === "pending" || previous.status === "issued")) {
    // Already holding this station. `keepAtRange` is standing server-side, so
    // there is nothing to send -- but the readout still says what the pilot is
    // doing, because "Standing by" would be false while it flies formation.
    return waiting("Following", "Holding station on the fleet commander.", memory);
  }
  return {
    action: { kind: "keepAtRange", targetID: anchor.itemID, range },
    phase: "Following",
    why: "Holding station on the fleet commander.",
    memory: { ...memory, followAnchorID: anchor.itemID, followRangeIssuedM: range,
      followOrder: { targetID: anchor.itemID, range, status: "pending", refusals: previous?.refusals ?? 0,
        deferrals: previous?.deferrals ?? 0, deferralWait: false },
    },
  };
}

/** The phase the rejoin warp reports, and the mark `withoutStaleRejoin` knows it by. */
const REJOIN_PHASE = "Rejoining the fleet";
/** The rejoin readout while the warp is out. */
const REJOIN_WHY = "Rejoining the fleet: warping to the commander.";
/**
 * Tries before the rejoin backs off: refusals, lost answers, warps that never
 * started and landings without the commander all count. The formation order's
 * own limit (`MAX_COMPANION_FOLLOW_REFUSALS`, declared below this), for the same
 * reason.
 */
const MAX_COMPANION_REJOIN_TRIES = 3;
/**
 * Ticks out of warp a taken warp is waited on before it counts as one that never
 * started. A warp aligns first and the align is not `inWarp`, so this has to
 * cover the slowest hull's align (about 20 s) at the measured ~2-4 s tick.
 */
const REJOIN_WARP_START_WAIT_TICKS = 15;
/**
 * The readout while a "the commander is not here" refusal is being waited out.
 * It says only what the server said and what the pilot does next, never where
 * the commander is: the same sentence covers a commander who is a few km away.
 */
const REJOIN_REFUSED_WAIT_WHY =
  "The warp to the commander was refused (too close, cloaked, or not where the roster says): waiting for the commander to show.";
/**
 * How long a "the commander is not here" refusal stands when the roster never
 * reports the commander anywhere new. The roster is the way out; this is the
 * way out when it never updates.
 */
const REJOIN_NOT_HERE_RECHECK_MS = 60_000;

/**
 * Rung 9b: a companion whose commander is in the fleet but not on its grid warps
 * to the commander, and rung 9 holds station on landing.
 *
 * ⚠ THE RETURN LEG ENDED AT THE UNDOCK. `recoverAndReturn` drops the flee latch
 * and undocks, and nothing after that moved the ship: rung 9 anchors only on a
 * commander ON THIS GRID, so a repaired pilot sat outside the station it fled to
 * reading "Standing by: no commander on this grid" for as long as the fight went
 * on. Seen live 2026-10-13 with three pilots, each the same: "Going back: Fixed
 * up ... undocking to rejoin the fleet", then minutes of standing by, with the
 * commander at the site in the same system. One of them flickered between
 * "Following" and "Standing by" as the commander passed its grid. None of them
 * went back. This rung is the rest of that leg, and it serves any companion left
 * on the wrong grid with nothing to do, not only one coming home from a flee.
 *
 * ⚠ THE SERVER'S OWN FLEET-MEMBER WARP, `CmdWarpToStuff("char", ...)`, which
 * resolves where the member is itself -- the same call a `WarpTo` order on a
 * fleet-mate sends. Nothing here needs to know the commander's grid.
 *
 * ⚠ IT SITS BENEATH RUNG 9 AND EVERYTHING ELSE, so every reason to stay wins
 * first: the flee (still below the return mark, docked for repairs, out of
 * round trips), the supervision gate, a fleet order, a `destination` trip, a
 * `stop`, a fight on this grid, and the warp yield. It then checks the flee's
 * own bounds again: a ship out of round trips, or below its flee FLOOR (one the
 * flee could not take anywhere), stays where it is and says so.
 *
 * ⚠ THE FLOOR, NOT THE RETURN MARK, AND THE MARK WAS A 52-MINUTE BUG. Seen live
 * 2026-10-14 09:13-10:05: a companion finished a fight, the commander warped to
 * the next site, and the pilot read "not well enough yet to go back to the
 * fight" every tick for 52 minutes while two others followed. It had never
 * dropped through its floor, so it never fled; it sat between the floor and the
 * mark, in a layer nothing was repairing, and this rung waited for the mark for
 * ever. The mark (`returnMark`) exists to stop a RETURN FROM A FLEE commuting
 * -- back at the floor, gone again next tick -- and that question is answered
 * inside the flee, before its latch drops (`wellEnoughToReturn`, bounded by
 * `holdAtTheSafeSpot`). By the time this rung runs no flee is latched: a pilot
 * the flee sent back has already cleared the mark or stalled short of it, and
 * any other pilot is simply idle on the wrong grid, fit to fight by the
 * operator's own number. Under the mark it goes anyway, and the trace says so
 * (`rejoin-under-mark`, with the tank, the mark and the repairer's state).
 *
 * ⚠ ONLY ON A POSITIVE READING DOES IT STAND DOWN FOR WHERE THE COMMANDER IS.
 * The roster says each member's system and station (`fleetCommanderWhereabouts`);
 * a commander docked, or in another system, is not warped to. When the roster
 * does not say, the warp is tried and the server's answer decides.
 *
 * ⚠ BOUNDED LIKE THE FORMATION ORDER. One warp per landing: a warp the server
 * took is waited on until the ship is seen in warp (or `REJOIN_WARP_START_WAIT_TICKS`
 * pass), and a landing that did not find the commander is a try spent. After
 * `MAX_COMPANION_REJOIN_TRIES` it reads "Standing by" with the reason for
 * `COMPANION_RETRY_BACKOFF_TICKS` and starts over -- back off, not give up, as
 * the formation order does. A lost answer waits `COMPANION_RESEND_WAIT_TICKS`.
 *
 * ⚠ A REFUSAL THAT MEANS "THE COMMANDER IS NOT HERE" IS NOT A TRY, IT IS AN
 * ANSWER. Seen live 2026-10-13 21:10: the commander jumped a gate and the roster
 * (its composition is cached briefly server-side) still put them in this
 * system, so the warp went out; the server refused it with "You cannot warp
 * there right now." (`CmdWarpToStuff failed ...: FLEET_MEMBER_WARP_TARGET_NOT_FOUND`).
 * Each pilot tried three times in four seconds, backed off, and started over --
 * stranded, and spamming refused warps. Asking again says nothing new, so the
 * rejoin stops AT ONCE and asks again only when the roster puts the commander
 * somewhere else (`commanderPlaceKey`) or `REJOIN_NOT_HERE_RECHECK_MS` has
 * passed (the roster may never update). The server gives that unnamed reason
 * the same words as every other it has no sentence for (`isCommanderNotHereRefusal`),
 * so a named blocker (scrambled, bubble, cloak...) keeps the three tries.
 *
 * ⚠ THAT SENTENCE DOES NOT SAY THE COMMANDER IS ELSEWHERE, AND THE READOUT MUST
 * NOT EITHER. It first read "The commander is not in this system", and was
 * false: seen live 2026-10-14 just after a gate jump, the commander sat
 * jump-cloaked at the gate, invisible to the companions, in the same system as
 * the roster said; the server log named WARP_DISTANCE_TOO_CLOSE for the very
 * refusal that readout blamed on TARGET_NOT_FOUND. The companion only ever sees
 * the generic sentence and cannot tell the two apart, so the readout says the
 * warp was refused and what the pilot waits for (`REJOIN_REFUSED_WAIT_WHY`).
 * Rung 9 follows the commander the moment it shows on grid.
 */
function decideRejoinCommander(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision | null {
  // The gates `decideFollow` keeps, for its reasons.
  if (memory.followHeld || obs.inWarp === true || obs.inSpace !== true || (obs.snapshot ?? null) === null ||
    (obs.fleetMemberCharacterIDs ?? null) === null) {
    return null;
  }
  // Drones out fighting something on this grid are work this pilot is doing.
  if (obs.hostileOnGrid === true && (obs.myDroneIDs ?? []).length > 0) {
    return null;
  }
  const target = rejoinTarget(obs);
  if (target.characterID === null) {
    return target.why === null ? null : waiting("Standing by", target.why, memory);
  }
  if (memory.fleeTripsSpent >= request.maxFleeAttempts) {
    return waiting("Standing by",
      "The commander is not on this grid, and this pilot has used all its flee round trips, so it is staying put.", memory);
  }
  // The FLOOR, never the return mark: see this function's header. Below it the
  // flee owns the pilot, unless it has nowhere to run, and then it stays.
  const tank = tankHealth(request, obs);
  if (tank === null) {
    noteHealth(healthTrace(request, obs, "rejoin-unread"));
    return waiting("Standing by",
      "The commander is not on this grid, and this ship's health could not be read, so it is not going back yet.", memory);
  }
  if (tank < request.fleeHealthFloor) {
    noteHealth(healthTrace(request, obs, "rejoin-below-floor"));
    return waiting("Standing by",
      "The commander is not on this grid, and this ship is below its flee floor, so it is not going back to the fight.", memory);
  }
  if (tank < returnMark(request)) {
    noteHealth(healthTrace(request, obs, "rejoin-under-mark"));
  }
  const characterID = target.characterID;
  let previous = memory.rejoin?.characterID === characterID ? memory.rejoin : null;
  const place = commanderPlaceKey(obs, characterID);
  const backOff = (rejoin: CompanionRejoin): CompanionDecision => waiting("Standing by",
    `Cannot warp to the commander: ${rejoin.reason ?? "the warp did not work"}. Trying again shortly.`,
    { ...memory, rejoin: { ...rejoin, cooldown: COMPANION_RETRY_BACKOFF_TICKS } });

  // The server said the commander is not here: nothing is sent until the roster
  // puts them somewhere else, or the quiet period is over. Then it starts fresh.
  if (previous !== null && previous.notHere === true) {
    const quiet = nowMs - (previous.sentAtMs ?? nowMs) < REJOIN_NOT_HERE_RECHECK_MS;
    if (previous.sentAt === place && quiet) {
      return waiting("Standing by", REJOIN_REFUSED_WAIT_WHY, { ...memory, rejoin: previous });
    }
    previous = null;
  }

  // Landed: the warp the last tick saw is over, and the commander is not here
  // (rung 9 above would have anchored, and the step drops this record when the
  // commander is on grid). That landing is a try spent; the next one may go.
  if (previous !== null && previous.seen) {
    previous = { ...previous, status: "issued", seen: false, waited: 0, cooldown: undefined,
      tries: previous.tries + 1, reason: "the warp landed where the commander was not" };
    if (previous.tries >= MAX_COMPANION_REJOIN_TRIES) {
      return backOff(previous);
    }
  } else if (previous !== null && previous.cooldown !== undefined) {
    const givenUp = previous.tries >= MAX_COMPANION_REJOIN_TRIES;
    if (previous.cooldown > 1) {
      return waiting(givenUp ? "Standing by" : REJOIN_PHASE, givenUp
        ? `Cannot warp to the commander: ${previous.reason ?? "the warp did not work"}. Trying again shortly.`
        : "The warp to the commander got no answer. Sending it again in a moment.",
      { ...memory, rejoin: { ...previous, cooldown: previous.cooldown - 1 } });
    }
    // The wait is over: a back-off starts the tries over, a resend keeps them.
    // Either way the warp goes out on this tick.
    if (givenUp) {
      previous = null;
    }
  } else if (previous !== null && previous.deferrals >= MAX_COMPANION_SESSION_DEFERRALS) {
    return backOff({ ...previous, reason: "a session change kept blocking it" });
  } else if (previous?.deferralWait) {
    return waiting(REJOIN_PHASE, "Waiting for the session change to clear before warping to the commander.", {
      ...memory, rejoin: { ...previous, deferralWait: false },
    });
  } else if (previous !== null && previous.status === "uncertain") {
    // ⚠ A LOST ANSWER IS A TRY, unlike the formation order's. A warp that took
    // is seen on the next mid-warp tick and never gets here; one that keeps
    // coming back unanswered must not be resent every few seconds for ever.
    const lost: CompanionRejoin = { ...previous, tries: previous.tries + 1, reason: "the server did not answer" };
    if (lost.tries >= MAX_COMPANION_REJOIN_TRIES) {
      return backOff(lost);
    }
    return waiting(REJOIN_PHASE, "The warp to the commander got no answer. Sending it again in a moment.", {
      ...memory, rejoin: { ...lost, cooldown: COMPANION_RESEND_WAIT_TICKS },
    });
  } else if (previous !== null && previous.status === "refused") {
    if (previous.tries >= MAX_COMPANION_REJOIN_TRIES) {
      return backOff(previous);
    }
  } else if (previous !== null && previous.status !== "deferred") {
    // Taken (or still pending), and not yet seen in warp: the ship is aligning.
    // ONE WARP PER LANDING, so nothing is sent until it is seen or the wait ends.
    if (previous.waited + 1 < REJOIN_WARP_START_WAIT_TICKS) {
      return waiting(REJOIN_PHASE, REJOIN_WHY, { ...memory, rejoin: { ...previous, waited: previous.waited + 1 } });
    }
    previous = { ...previous, tries: previous.tries + 1, reason: "the warp never started" };
    if (previous.tries >= MAX_COMPANION_REJOIN_TRIES) {
      return backOff(previous);
    }
  }
  const sent: CompanionRejoin = {
    characterID, status: "pending", tries: previous?.tries ?? 0, deferrals: previous?.deferrals ?? 0,
    deferralWait: false, waited: 0, seen: false, reason: previous?.reason ?? null,
    sentAt: place, sentAtMs: nowMs,
  };
  const warp: CompanionDecision = {
    action: { kind: "warpToFleetMember", characterID },
    phase: REJOIN_PHASE,
    why: REJOIN_WHY,
    memory: { ...memory, rejoin: sent },
  };
  // The drones come home first, on the rules a fleet order to leave keeps.
  const held = recallBeforeLeavingOnOrder(warp, request, obs, memory, nowMs);
  if (held === null || held.action.kind === "warpToFleetMember") {
    return held;
  }
  return {
    ...held,
    phase: REJOIN_PHASE,
    why: held.action.kind === "recallDrones"
      ? "Rejoining the fleet: calling the drones home before warping to the commander."
      : "Rejoining the fleet: waiting for the drones to come home before warping to the commander.",
  };
}

/**
 * The commander a rejoin warps to: the first the roster names that is not this
 * pilot and is not positively docked or in another system. `why` says, when
 * there is none, whether that is worth a readout.
 */
function rejoinTarget(obs: FleetCompanionObservation): { readonly characterID: number | null; readonly why: string | null } {
  const roster = obs.fleetMemberCharacterIDs ?? [];
  const here = obs.flightStatus?.solarSystemID ?? null;
  const where = obs.fleetCommanderWhereabouts ?? null;
  let why: string | null = null;
  for (const commanderID of commandersFor(obs)) {
    if (commanderID === obs.myCharacterID || !roster.includes(commanderID)) {
      continue;
    }
    const at = where?.find((entry) => entry.characterID === commanderID) ?? null;
    if (at !== null && at.solarSystemID !== null && here !== null && at.solarSystemID !== here) {
      why ??= "The commander is in another solar system, so there is nothing to warp to.";
      continue;
    }
    if (at !== null && at.stationID !== null) {
      why ??= "The commander is docked, so there is nothing to warp to.";
      continue;
    }
    return { characterID: commanderID, why: null };
  }
  return { characterID: null, why };
}

/**
 * Where the roster puts a commander, as one comparable string: system and
 * station, "?" where it does not say, and "unlisted" when the roster has no row.
 * Two different keys are the commander having moved.
 */
function commanderPlaceKey(obs: FleetCompanionObservation, characterID: number): string {
  const at = obs.fleetCommanderWhereabouts?.find((entry) => entry.characterID === characterID) ?? null;
  return at === null ? "unlisted" : `${at.solarSystemID ?? "?"}/${at.stationID ?? "?"}`;
}

/**
 * A refused fleet-member warp that says the member is not to be found. The
 * server's own sentence for this is "You cannot warp there right now." -- the
 * words it gives every reason it has no sentence for -- and its code
 * (FLEET_MEMBER_WARP_TARGET_NOT_FOUND) goes to its log, not the wire; the code
 * is matched too, in case a message carries it. A refusal with a sentence of its
 * own (scrambled, bubble, cloak, immobile) is not this one.
 */
function isCommanderNotHereRefusal(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /FLEET_MEMBER_WARP_TARGET_NOT_FOUND|cannot warp there right now/i.test(raw);
}

/** A refused rejoin warp's reason, as the give-up readout's tail. */
function rejoinRefusalReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return /^The server refused that: (.*)\.$/.exec(refusalWords(raw))?.[1] ?? "the server refused the warp";
}

/**
 * Salvage one wreck at a time: close, lock, then send the salvage drones at it
 * and cycle a fitted SALVAGER on it.
 *
 * ⚠ THE OTHER HALF OF THE `salvage` ORDER, AND IT WAS MISSING. The first cut of
 * the verb acted on salvage DRONES alone, because that is how the order was
 * first described. A hull with a salvager bolted on and no drone bay could be
 * told to salvage and would stand there. What a pilot can do is a property of
 * its FIT -- the same principle that deleted every module picker -- so the order
 * acts on whatever this ship actually has for the job.
 *
 * ⚠ THE DRONES ARE SENT AT THE LOCKED WRECK BY ID. The server's auto-pick
 * (`CmdSalvage` with target 0) only takes wrecks owned by the pilot or a
 * CURRENT fleet mate, and left every salvage drone idle when the fleet had
 * dropped or another pilot made the wrecks. The drone rung only launches them.
 *
 * ⚠ AND IT MOVES THE SHIP, so it sits at the bottom of the ladder beside the
 * loot rung. A salvager reaches about 5 km, so closing on a wreck can pull a
 * companion off formation exactly as looting can -- and it yields to the flee,
 * to the supervision gate and to a fleet warp for the same reason.
 */
function decideSalvaging(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision | null {
  const salvageDrones = obs.salvageDroneIDs ?? [];
  const salvagers = request.salvagerModuleIDs;
  if (!salvageWasOrdered(memory) || (salvagers.length === 0 && salvageDrones.length === 0)) {
    return null;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return null;
  }
  const wrecks = snapshot.entities.filter((entity) => entity.kind === "wreck");
  if (wrecks.length === 0) {
    return null;
  }
  const measurement = measureSpace(snapshot);

  // ⚠ THE REMEMBERED WRECK IS DROPPED THE MOMENT IT IS GONE, which is how this
  // rung knows it finished one: a salvaged wreck leaves the grid. That is the
  // opposite of looting, where an emptied wreck STAYS and the rung has to keep
  // its own record of what it has already opened.
  let wreckID = memory.salvageWreckID;
  if (wreckID !== null && !wrecks.some((wreck) => wreck.itemID === wreckID)) {
    wreckID = null;
  }
  let mem = memory;
  if (wreckID === null) {
    // ⚠ PICKING IS NOT AN ACTION, AND THIS RUNG USED TO TREAT IT AS ONE. It
    // returned an `approach` the moment it chose a wreck, so a wreck ALREADY in
    // range cost a wasted tick closing on something it was already next to.
    // Choosing falls through to the range test below instead.
    // The wreck this pilot is best placed for, so a fleet splits a field
    // instead of queueing on one hull. See `pickForThisPilot`.
    const pick = pickForThisPilot(obs, wrecks);
    if (pick === null) {
      return null;
    }
    wreckID = pick.itemID;
    mem = {
      ...memory,
      salvageWreckID: wreckID,
      salvageLockIssued: false,
      salvageLockWaited: 0,
      salvageApproachIssued: false,
      salvageApproachAtMs: null,
    };
  }

  const distance = measurement?.distances.get(wreckID) ?? Number.POSITIVE_INFINITY;
  // A salvager needs the ship beside the wreck; drones fly there themselves,
  // so a drone-only hull only has to be inside lock range. An unreadable lock
  // range is no gate: the bounded lock wait below is the backstop.
  const reach = salvagers.length > 0 ? COMPANION_SALVAGE_RANGE_M : (obs.maxTargetRangeM ?? null);
  if (reach !== null && distance > reach) {
    // ⚠ ONLY BELIEVE AN APPROACH THAT IS STILL RUNNING. A move that was
    // refused, or that the server finished early, leaves the ship out of reach
    // -- and not necessarily stopped: through the gateway the throttle is opened
    // BEFORE the follow is sent, so a refused one leaves the hull under way in
    // GOTO, flying somewhere that is not the wreck. A rung that trusted its own
    // "already issued" flag would wait on that for the rest of the run, which is
    // why GOTO is not in `NO_REAPPROACH_SHIP_MODES`.
    //
    // ⚠ BUT A FRESH ORDER IS TRUSTED FOR `APPROACH_SETTLE_MS` WHATEVER THE MODE
    // SAYS: the first snapshot after it often still reads GOTO, and re-sending
    // then is refused (ThrottleGeneric). Only after the window does the mode decide.
    if (mem.salvageApproachIssued && approachHolds(obs, mem.salvageApproachAtMs, nowMs)) {
      return waiting("Salvaging", "Flying to the wreck.", mem);
    }
    return {
      action: { kind: "approach", targetID: wreckID, range: SALVAGE_APPROACH_STOP_M },
      phase: "Salvaging",
      why: "Closing on a wreck to salvage it, as asked.",
      memory: { ...mem, salvageApproachIssued: true, salvageApproachAtMs: nowMs },
    };
  }
  if (!(obs.lockedTargetIDs ?? []).includes(wreckID)) {
    if (!mem.salvageLockIssued) {
      return {
        action: { kind: "lock", targetID: wreckID },
        phase: "Salvaging",
        why: "Locking the wreck to salvage it.",
        memory: { ...mem, salvageLockIssued: true, salvageLockWaited: 0 },
      };
    }
    // ⚠ BOUNDED, BECAUSE A WRECK THAT WILL NOT LOCK NEVER SAYS SO. Without this
    // the rung waits on one wreck for the rest of the run while a grid full of
    // others goes unsalvaged.
    if (mem.salvageLockWaited >= MAX_SALVAGE_LOCK_WAIT_TICKS) {
      return waiting("Salvaging", "That wreck would not lock - moving on.", {
        ...mem,
        salvageWreckID: null,
        salvageLockIssued: false,
        salvageLockWaited: 0,
      });
    }
    return waiting("Salvaging", "Waiting for the lock.", {
      ...mem,
      salvageLockWaited: mem.salvageLockWaited + 1,
    });
  }
  // Locked: the salvage drones onto it, once per wreck (and again if more
  // drones came out since).
  if (
    salvageDrones.length > 0 &&
    (mem.salvageDronesWreckID !== wreckID || mem.lastSalvageOrderedFor !== salvageDrones.length)
  ) {
    return {
      action: { kind: "salvageDrones", droneIDs: salvageDrones, targetID: wreckID },
      phase: "Salvaging",
      why: "Sending the salvage drones to the wreck.",
      memory: { ...mem, salvageDronesWreckID: wreckID, lastSalvageOrderedFor: salvageDrones.length },
    };
  }
  // Start the first salvager that is not already cycling.
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  const next = salvagers.find((moduleID) => !active.has(moduleID));
  if (next === undefined) {
    return waiting("Salvaging", "Salvaging the wreck.", mem);
  }
  return {
    action: { kind: "activate", moduleID: next, targetID: wreckID },
    phase: "Salvaging",
    why: "Running the salvager on the wreck.",
    memory: mem,
  };
}

/**
 * The three drone jobs a companion will actually do.
 *
 * ⚠ A SUBSET OF `DroneRole` IN `droneRoles.ts`, ON PURPOSE. That module also
 * knows `mining` and `other`, and neither belongs here: a companion does not
 * mine, and `other` is the bucket that holds the drones this server cannot
 * usefully fly at all (webifier and energy-neutralizer drones have no effect
 * implementation, and the server refuses to engage them). Naming the subset
 * here means a new role cannot silently become something a companion launches.
 */
type CompanionDroneRole = "combat" | "logistic" | "salvage";

/**
 * The ship the fleet is telling this pilot to shoot, with the words for saying
 * so — or null when nobody is calling anything.
 *
 * ⚠ ONE DEFINITION, READ BY TWO RUNGS, AND THAT IS THE POINT. Rung 7 brings the
 * guns up on this ship and rung 6 sends the drones onto it. Two copies of "a
 * TAG first, then a `Target` call" would eventually disagree, and the failure
 * that makes -- drones chewing one ship while the guns fire on another -- is
 * invisible in a readout that can only name one of them.
 *
 * ⚠ THE ORDER IS PASSED IN RATHER THAN RESOLVED HERE. `resolveNamedOrder` is
 * the source of the other four named orders too (align, travel, jump, warp), so
 * rung 7 has already resolved it for branches it alone handles; resolving it a
 * second time in here would mean two answers to "what is standing right now"
 * within one tick, which is the same class of bug this function exists to close.
 *
 * ⚠ IT DOES NOT ASK WHETHER RUNG 7 WILL ACT ON THE ANSWER. That rung answers a
 * Heal call ahead of a target call, so a pilot repping a fleet-mate locks
 * nothing -- and the LOCK TEST at the drone call site is what makes that safe,
 * because a ship nobody locked is a ship the drones are never sent onto.
 */
interface CalledTarget {
  readonly itemID: number;
  /**
   * "free-fire" = nobody called it; this pilot picked it by the kill order.
   * "tackled" = it is holding this pilot down, which outranks every call.
   */
  readonly source: "tag" | "broadcast" | "chat" | "free-fire" | "tackled";
  readonly heard: string;
  readonly why: string;
}

/**
 * ⚠ FREE FIRE LIVES HERE, BEHIND EVERY CALL, so `targets all` is the answer to
 * "nobody is calling anything" and never a second opinion against a call. A
 * tag or a `Target` still wins outright (the kill order is this client's guess;
 * a call is the commander looking at the fight), and so does any other named
 * order: a pilot told to align, travel, jump or warp is doing that, and a rat
 * it could shoot on the way is not a reason to stop.
 *
 * ⚠ ONE THING OUTRANKS A CALL: a ship tackling THIS pilot (`ownTackler`). It is
 * shot first whatever the commander called, and its callout pulls the rest of
 * the fleet onto it (`decideTackleBroadcast`).
 *
 * Because rung 6 reads this same function, the drones follow the guns onto the
 * free-fire pick too, and every companion ranks the same grid the same way, so
 * a fleet in free fire focuses one ship rather than spreading over five.
 */
function calledTarget(
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
  order: NamedOrder | null,
  memory: CompanionLadderMemory,
): CalledTarget | null {
  // ⚠ A SHIP HOLDING THIS PILOT DOWN COMES FIRST, ABOVE EVERY CALL. Operator,
  // 2026-10-13: "tacklers should be killed first, no matter FC instructions".
  // A tackled pilot cannot leave, so the ship tackling it is the one threat it
  // must end itself; its callout (rung 4) asks the fleet to help.
  const tackler = ownTackler(obs, entities, measurement, memory);
  if (tackler !== null) {
    return tackler;
  }
  const tags = obs.fleetTargetTags ?? null;
  if (tags !== null) {
    const tagged = bestTaggedEntity(tags, entities, measurement);
    if (tagged !== null) {
      return {
        itemID: tagged.itemID,
        source: "tag",
        heard: "the fleet's tagged target",
        why: "The fleet has tagged a target on this grid.",
      };
    }
  }
  if (order?.name === "Target") {
    return {
      itemID: order.itemID,
      source: order.source,
      heard: order.heard,
      why: order.why,
    };
  }
  // The `Target` call a later broadcast of another kind pushed out of the slot:
  // still the fleet's call, so it still outranks free fire. See `heldTargetCallID`.
  const held = order === null ? heldTargetCallID(obs, memory, entities) : null;
  if (held !== null) {
    return {
      itemID: held,
      source: "broadcast",
      heard: ORDER_HEARD.Target.broadcast,
      why: ORDER_WHY.Target.broadcast,
    };
  }
  if (memory.targetMode === "all" && order === null) {
    return freeFireTarget(obs, entities, measurement, memory);
  }
  return null;
}

/**
 * The ship tackling this pilot that its guns and drones take first, or null.
 *
 * The candidates are `obs.tackledBy` (the jam pushes), on this grid, inside
 * this hull's lock range and not given up on -- a tackler this pilot cannot
 * lock falls through to the fleet's call rather than stalling the rung. Several
 * are ranked by the kill order (`rankByKillOrder`, `pickPrimary`'s threat
 * ladder): the scrambler before the webber, nearest breaking ties.
 */
function ownTackler(
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
  memory: CompanionLadderMemory,
): CalledTarget | null {
  const reach = obs.maxTargetRangeM ?? null;
  const candidates = (obs.tackledBy ?? [])
    .map((itemID) => entityOnGrid(itemID, entities))
    .filter((entity): entity is SpaceEntity => entity !== null)
    .filter((entity) => {
      if (gaveUpOnLocking(memory, entity.itemID)) {
        return false;
      }
      const distance = measurement?.distances.get(entity.itemID) ?? null;
      return reach === null || distance === null || distance <= reach;
    });
  if (candidates.length === 0) {
    return null;
  }
  const target = rankByKillOrder(obs, candidates, measurement) ?? candidates[0]!;
  return {
    itemID: target.itemID,
    source: "tackled",
    heard: "being tackled",
    why: "Tackled: shooting the ship holding me first.",
  };
}

/**
 * How long a heard `JumpTo` stands when nothing answers or replaces it, from
 * the tick this pilot first heard it. Generous on purpose: it has to outlast a
 * warp to the gate plus the crawl in from where the warp lands. It exists only
 * so a gate this pilot can never reach cannot hold it for ever.
 */
export const GATE_CALL_HOLD_MS = 120_000;

/** A `JumpTo` as this pilot heard it: see `withHeardGateCall`. */
export interface HeardGateCall {
  readonly gateID: number;
  /** The order's own `NamedOrder.key`, so the call still in the slot is not heard twice. */
  readonly key: string;
  readonly source: "broadcast" | "chat";
  /** When it was said: the broadcast's `receivedAtMs`, the chat line's `createdAtMs`. */
  readonly saidAtMs: number;
  /** The tick this pilot first heard it; `GATE_CALL_HOLD_MS` runs from here. */
  readonly heardAtMs: number;
  /** The system it was heard in. Being anywhere else is the jump that answers it. */
  readonly systemID: number | null;
  /** Answered, replaced, stopped or expired. Kept, so the slot still holding it cannot re-arm it. */
  readonly over: boolean;
}

/** A `Target` broadcast as this pilot heard it: see `CompanionLadderMemory.targetCall`. */
export interface HeardTargetCall {
  readonly itemID: number;
  readonly receivedAtMs: number;
}

/**
 * Record the newest `Target` broadcast, and retire it when it lapses or a newer
 * named order replaces it. Runs at the top of every tick, before any rung reads it.
 *
 * ⚠ THE STORE KEEPS ONE BROADCAST, OF ANY KIND, AND THE NEWEST WINS THE SLOT.
 * `fleet/broadcast` overwrites `lastBroadcast` whatever its name, so an
 * `EnemySpotted` or `NeedBackup` a second after a `Target` call erased the call
 * from the observation: `resolveNamedOrder` then found no order, `calledTarget`
 * fell through to free fire, and an engaged pilot turned its guns back onto its
 * own kill-order pick while the fleet's call was still standing. That is one of
 * the two code paths to the A, B, A seen live 2026-10-13 (free fire on A, a
 * broadcast on B, then A again inside five seconds, every gun re-sent at each
 * turn); the other is a companion's tackle callout, which is a real `Target`
 * call and is meant to win (`decideTackleBroadcast`).
 *
 * ⚠ ONLY ANOTHER NAMED ORDER OR THE TTL ENDS IT, which is exactly what ends a
 * call that stays in the slot: a newer `Target` replaces it, an `AlignTo` or a
 * `WarpTo` outranks it there too, and `FLEET_BROADCAST_TTL_MS` is the same clock
 * the observation builder applies. A Heal broadcast does not end it: a logi call
 * is not a cease-fire.
 */
function withHeardTargetCall(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionLadderMemory {
  const heard = obs.fleetBroadcast ?? null;
  const prior = memory.targetCall ?? null;
  let next: HeardTargetCall | null = prior;
  if (obs.inFleet === false) {
    next = null;
  } else if (heard !== null && heard.name === "Target" && heard.itemID !== null) {
    next = prior !== null && prior.itemID === heard.itemID && prior.receivedAtMs === heard.receivedAtMs
      ? prior
      : { itemID: heard.itemID, receivedAtMs: heard.receivedAtMs };
  } else if (heard !== null && asNamedOrderName(heard.name) !== null) {
    next = null;
  } else if (prior !== null && nowMs - prior.receivedAtMs >= FLEET_BROADCAST_TTL_MS) {
    next = null;
  }
  return next === prior ? memory : { ...memory, targetCall: next };
}

/**
 * The ship a `Target` call still names when the broadcast slot has since been
 * taken by a broadcast that is NOT an order (`EnemySpotted`, a Heal call, ...),
 * and only while that ship is on this grid. See `withHeardTargetCall`.
 *
 * ⚠ AN EMPTY SLOT IS NOT AN OVERWRITTEN ONE. `null` means the call lapsed or the
 * store cleared it (fleet left or switched), and neither may be resurrected
 * from memory; only a slot holding something else hides a call that stands.
 */
function heldTargetCallID(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  entities: readonly SpaceEntity[],
): number | null {
  const heard = obs.fleetBroadcast ?? null;
  const held = memory.targetCall ?? null;
  if (heard === null || held === null || heard.name === "Target" || asNamedOrderName(heard.name) !== null) {
    return null;
  }
  return entityOnGrid(held.itemID, entities) === null ? null : held.itemID;
}

/**
 * The ship a standing `Target` call names on this grid, from the slot or held
 * past it, or null. What rung 4's broadcast arm keeps quiet for.
 */
function standingTargetCallID(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  entities: readonly SpaceEntity[],
): number | null {
  const heard = obs.fleetBroadcast ?? null;
  if (heard !== null && heard.name === "Target") {
    return heard.itemID !== null && entityOnGrid(heard.itemID, entities) !== null ? heard.itemID : null;
  }
  return heldTargetCallID(obs, memory, entities);
}

/** A named order as the slot or a chat line carries it, before the grid is asked. */
interface HeardNamedOrder {
  readonly name: NamedOrderName;
  readonly itemID: number;
  readonly source: "broadcast" | "chat";
  readonly key: string;
  readonly saidAtMs: number;
}

/** What the slot and chat are saying this tick, oldest first. */
function heardNamedOrders(obs: FleetCompanionObservation): readonly HeardNamedOrder[] {
  const heard: HeardNamedOrder[] = [];
  const slot = obs.fleetBroadcast ?? null;
  const name = asNamedOrderName(slot?.name);
  if (slot !== null && name !== null && slot.itemID !== null) {
    heard.push({
      name, itemID: slot.itemID, source: "broadcast", key: broadcastOrderKey(name, slot.itemID, slot), saidAtMs: slot.receivedAtMs,
    });
  }
  const chat = newestNamedChatOrder(obs.chatMessages ?? [], commandersFor(obs));
  if (chat !== null) {
    heard.push({
      name: CHAT_ORDER_NAMES[chat.command.kind], itemID: chat.command.itemID, source: "chat", key: "chat:" + chat.key, saidAtMs: chat.at,
    });
  }
  return heard.sort((a, b) => a.saidAtMs - b.saidAtMs);
}

/**
 * Whether a held gate call has been answered: this pilot is in another system
 * than the one it heard the call in, or a commander typed `stop` after it.
 */
function gateCallAnswered(call: HeardGateCall, obs: FleetCompanionObservation, memory: CompanionLadderMemory): boolean {
  const here = obs.flightStatus?.solarSystemID ?? null;
  return call.over ||
    (call.systemID !== null && here !== null && here !== call.systemID) ||
    (memory.stopHeardAtMs !== null && memory.stopHeardAtMs >= call.saidAtMs);
}

/**
 * Record the newest `JumpTo`, and retire it once it is answered, replaced or
 * expired. Runs at the top of every tick, mid-warp included, beside
 * `withHeardTargetCall`.
 *
 * ⚠ A CALLED GATE STANDS UNTIL THIS PILOT HAS TAKEN IT. Seen live 2026-10-13
 * 21:09, three companions identical: "The fleet called a gate on this grid.
 * Closing on it.", then three seconds later "Holding station on the fleet
 * commander.", and the commander jumped without them. The call had been read
 * straight off the broadcast slot, which the observation builder empties after
 * `FLEET_BROADCAST_TTL_MS` -- and the thirty seconds had been spent on the warp
 * to the gate, so it lapsed with the ship 8 km short. The slot also holds ONE
 * broadcast of any kind, so an `EnemySpotted`, a Heal call or a companion's
 * own tackle callout a moment later erases the call exactly as the lapse does.
 * A jump call has a natural end the TTL knows nothing about: this pilot
 * reaching the other side.
 *
 * So it ends only when this pilot is in another system, a NEWER `WarpTo`,
 * `AlignTo`, `TravelTo` or `JumpTo` replaces it, a commander types `stop`, or
 * `GATE_CALL_HOLD_MS` passes. A `Target` call does not end it: a pilot left on
 * the old side of the gate is no use to the fight on the new one.
 */
function withHeardGateCall(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionLadderMemory {
  const prior = memory.gateCall ?? null;
  if (obs.inFleet === false) {
    return prior === null ? memory : { ...memory, gateCall: null };
  }
  const here = obs.flightStatus?.solarSystemID ?? null;
  let next = prior;
  for (const order of heardNamedOrders(obs)) {
    if (next !== null && order.saidAtMs <= next.saidAtMs) {
      continue;
    }
    if (order.name === "JumpTo") {
      next = {
        gateID: order.itemID, key: order.key, source: order.source, saidAtMs: order.saidAtMs,
        heardAtMs: nowMs, systemID: here, over: false,
      };
    } else if (order.name !== "Target" && next !== null && !next.over) {
      next = { ...next, over: true };
    }
  }
  if (next !== null && !next.over) {
    if (gateCallAnswered(next, obs, memory) || nowMs - next.heardAtMs >= GATE_CALL_HOLD_MS) {
      next = { ...next, over: true };
    } else if (next.systemID === null && here !== null) {
      next = { ...next, systemID: here };
    }
  }
  return next === prior ? memory : { ...memory, gateCall: next };
}

/**
 * The named order this pilot obeys this tick: `resolveNamedOrder`, with a held
 * gate call standing in where the slot and chat no longer carry it.
 *
 * ⚠ AN ANSWERED CALL IS NOT AN ORDER, even while the slot still carries it: a
 * `stop` typed ten seconds after the broadcast must not leave twenty seconds of
 * it standing. The slot is then read as empty, so a chat order beneath it is
 * still heard.
 */
function namedOrderFor(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  entities: readonly SpaceEntity[],
): NamedOrder | null {
  const call = memory.gateCall ?? null;
  let order = resolveNamedOrder(request, obs, entities);
  if (call !== null && order?.name === "JumpTo" && (order.key !== call.key || gateCallAnswered(call, obs, memory))) {
    order = order.source === "broadcast" ? resolveNamedOrder(request, { ...obs, fleetBroadcast: null }, entities) : null;
    order = order?.name === "JumpTo" ? null : order;
  }
  if (order !== null && order.name !== "Target" && order.name !== "JumpTo") {
    return order;
  }
  if (call === null || gateCallAnswered(call, obs, memory) || entityOnGrid(call.gateID, entities) === null) {
    return order;
  }
  return {
    name: "JumpTo",
    itemID: call.gateID,
    source: call.source,
    key: call.key,
    heard: ORDER_HEARD.JumpTo[call.source],
    why: ORDER_WHY.JumpTo[call.source],
  };
}

/**
 * `targets all`: the hostile this pilot shoots when nobody is calling one.
 *
 * The kill order is `pickPrimary`'s, the same ladder the scripted bots fight
 * by: tacklers (scramblers, then webbers), then ECM, then other ewar, then the
 * rest smallest signature first, nearest breaking ties. Removing a small ship
 * removes its damage fastest, and the tacklers and jammers are what stop this
 * pilot leaving or fighting at all.
 *
 * ⚠ NPC HOSTILES ONLY, through `isHostile`. Free fire is for clearing a site,
 * and a neutral player on the grid is not part of one: shooting them is a
 * decision a human makes by calling them.
 *
 * ⚠ ONLY WHAT THIS HULL CAN LOCK, and never a ship it already gave up locking.
 * A call names one ship and the pilot answers "I cannot" when it is out of
 * reach; free fire has the whole grid to choose from, so picking a ship out of
 * range would waste the lock budget on it while a reachable one shoots back.
 * An unreadable lock range is no gate, the same reading the rest of this loop
 * gives it.
 */
function freeFireTarget(
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
  memory: CompanionLadderMemory,
): CalledTarget | null {
  const reach = obs.maxTargetRangeM ?? null;
  const distanceOf = (entity: SpaceEntity): number | null =>
    measurement?.distances.get(entity.itemID) ?? null;
  const candidates = entities.filter((entity) => {
    if (!isHostile(entity) || gaveUpOnLocking(memory, entity.itemID)) {
      return false;
    }
    const distance = distanceOf(entity);
    return reach === null || distance === null || distance <= reach;
  });
  if (candidates.length === 0) {
    return null;
  }
  const threats = obs.threatByTypeID ?? null;
  const target = rankByKillOrder(obs, candidates, measurement);
  if (target === null) {
    return null;
  }
  const threat = target.typeID === null ? null : (threats?.[target.typeID] ?? null);
  const what = threat?.scram
    ? "the warp scrambler"
    : threat?.web
      ? "the webber"
      : threat?.ecm
        ? "the jammer"
        : threat?.ewar
          ? "the ewar ship"
          : "the next ship in the kill order";
  return {
    itemID: target.itemID,
    source: "free-fire",
    heard: "free fire",
    why: `Free fire: shooting ${what}.`,
  };
}

/**
 * The first of `candidates` by the free-fire kill order (`pickPrimary`).
 *
 * ⚠ ONE RANKING FOR THE PICK AND THE PRE-LOCK. The lock-ahead ranks the same
 * grid the same way minus the ship being shot, so its first pre-lock is the
 * ship free fire turns to next and that ship's lock is already on.
 */
function rankByKillOrder(
  obs: FleetCompanionObservation,
  candidates: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  const groups = obs.targetGroupNames ?? null;
  const threats = obs.threatByTypeID ?? null;
  const signatures = obs.signatureByTypeID ?? null;
  return pickPrimary(
    candidates,
    (entity) => entity.typeID,
    (entity) => measurement?.distances.get(entity.itemID) ?? null,
    (typeID) => (groups === null ? null : (groups[typeID] ?? null)),
    undefined,
    undefined,
    (typeID) => threats?.[typeID] ?? null,
    undefined,
    undefined,
    (entity) => (entity.typeID === null || signatures === null ? null : (signatures[entity.typeID] ?? null)),
  );
}

/** The called target's id alone, for the drone rung. */
function calledCombatTargetID(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): number | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return null;
  }
  const entities = snapshot.entities;
  const called = calledTarget(
    obs,
    entities,
    measureSpace(snapshot),
    namedOrderFor(request, obs, memory, entities),
    memory,
  );
  return called === null ? null : called.itemID;
}

function withObservedDroneFlights(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  // The drone a rotation is bringing home is not part of the flight an order
  // names (see the engage in `decideDrones`), so it is not a change of flight.
  const homeward = memory.droneRotation.active?.phase === "recalling" ? memory.droneRotation.active.itemID : null;
  const sameFlight = (observed: readonly number[], ordered: readonly number[]): boolean => {
    const flying = homeward === null || ordered.includes(homeward) ? observed : observed.filter((id) => id !== homeward);
    return flying.length === ordered.length && flying.every((id) => ordered.includes(id));
  };
  if (
    memory.lastDroneEngageTargetID !== null &&
    obs.combatDroneIDs != null &&
    !sameFlight(obs.combatDroneIDs, memory.lastDroneEngageIDs)
  ) {
    memory = { ...memory, lastDroneEngageTargetID: null, lastDroneEngageIDs: [], combatDroneOrder: null };
  }
  if (
    memory.lastDroneRepairTargetID !== null &&
    obs.logisticDroneIDs != null &&
    !sameFlight(obs.logisticDroneIDs, memory.lastDroneRepairIDs)
  ) {
    memory = { ...memory, lastDroneRepairTargetID: null, lastDroneRepairIDs: [], repairDroneOrder: null };
  }
  return memory;
}

// ── drone sizing (rung 6) ────────────────────────────────────────────────────
//
// ⚠ AN IMPROVEMENT ON THE OLD LAUNCH, NEVER A NEW WAY TO SIT ON A FULL BAY.
// Every input below can be unread -- the bay, the hull's bandwidth, a drone
// type's dogma, a target's signature -- and each helper answers "cannot judge"
// for that, on which the rung launches the whole role bay exactly as it did
// before sizing existed. See nav/droneSizing.ts for the rule itself.

// ── drone assist modules (rung 6) ────────────────────────────────────────────

/**
 * Switch on one fitted drone assist module that is not running, once the
 * combat drones are out and engaged. One per tick, each tried once per fight.
 *
 * ⚠ AFTER THE ENGAGE, NEVER BEFORE IT. A module cycle is worth something only
 * to drones that are shooting; the engage is what makes them shoot, so it gets
 * the tick first and this takes the next quiet one.
 */
function droneAssistOn(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  const lit = memory.droneAssistLit ?? [];
  const running = new Set(obs.snapshot?.ship?.activeModuleIDs ?? lit);
  const next = request.droneAssistModuleIDs.find((id) => !running.has(id) && !lit.includes(id));
  if (next === undefined) {
    return null;
  }
  return {
    action: { kind: "activate", moduleID: next, targetID: 0 },
    phase: "Drones",
    why: "The drones are fighting, so the drone tracking module is switching on.",
    memory: { ...memory, droneAssistLit: [...lit, next] },
  };
}

/**
 * Switch off, one per tick, every drone assist module this rung lit, once the
 * combat drones have no job. A module the read shows already stopped is just
 * forgotten.
 */
function droneAssistOff(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const lit = memory.droneAssistLit ?? [];
  if (lit.length === 0) {
    return { decision: null, memory };
  }
  const active = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const running = active === null ? lit : lit.filter((id) => active.includes(id));
  if (running.length === 0) {
    // All already stopped: forget them, and let the rest of the rung have the tick.
    return { decision: null, memory: { ...memory, droneAssistLit: [] } };
  }
  const off = running[0]!;
  return {
    decision: {
      action: { kind: "deactivate", moduleID: off },
      phase: "Drones",
      why: "The drones have no fight, so the drone tracking module is switching off.",
      memory: { ...memory, droneAssistLit: lit.filter((id) => id !== off) },
    },
    memory,
  };
}

/** What the sizing rule needs to know about one ship on the grid. */
function sizingTargetFacts(
  entity: SpaceEntity,
  obs: FleetCompanionObservation,
  measurement: SpaceMeasurement | null,
): TargetFacts {
  const v = entity.velocity;
  const speed =
    v !== null && v !== undefined && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
      ? Math.hypot(v.x, v.y, v.z)
      : null;
  return {
    signatureRadius: entity.typeID === null ? null : (obs.signatureByTypeID?.[entity.typeID] ?? null),
    speed,
    distanceFromShipM: measurement?.distances.get(entity.itemID) ?? null,
  };
}

/**
 * What the drones are sized FOR: the called (or free-fire) target when there
 * is one on grid, otherwise every hostile NPC on it -- the launch that happens
 * before anybody calls anything is still a choice of which drones go out.
 */
function sizingTargets(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): readonly TargetFacts[] {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return [];
  }
  const measurement = measureSpace(snapshot);
  const called = calledCombatTargetID(request, obs, memory);
  const target = called === null ? null : entityOnGrid(called, snapshot.entities);
  if (target !== null) {
    return [sizingTargetFacts(target, obs, measurement)];
  }
  return snapshot.entities.filter(isHostile).map((entity) => sizingTargetFacts(entity, obs, measurement));
}

/**
 * The launch for this role: sized for combat when it can be judged, the whole
 * role bay otherwise (and always for logistic and salvage drones, which have
 * one job each and no size to choose).
 */
function roleLaunch(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  role: CompanionDroneRole,
  bay: readonly number[],
  why: string,
): { readonly action: FleetCompanionAction; readonly why: string } {
  const whole = { action: { kind: "launchDrones", droneItemIDs: bay } as const, why };
  if (role !== "combat") {
    return whole;
  }
  const plan = sizedLaunch(
    obs.combatDroneStacks ?? null,
    obs.droneFactsByTypeID ?? new Map(),
    obs.droneLimits ?? null,
    sizingTargets(request, obs, memory),
  );
  if (plan === null) {
    return whole;
  }
  const quantities: Record<number, number> = {};
  for (const stack of plan.stacks) {
    quantities[stack.itemID] = stack.quantity;
  }
  return {
    action: { kind: "launchDrones", droneItemIDs: plan.stacks.map((stack) => stack.itemID), quantities },
    why:
      calledCombatTargetID(request, obs, memory) === null
        ? "Hostiles on grid. Putting out the drones that suit them best."
        : "Putting out the drones that hit this target hardest.",
  };
}

/** What is left of a ship, in hit points across its three layers, or null. */
function remainingHitPoints(entity: SpaceEntity, obs: FleetCompanionObservation): number | null {
  const full = entity.typeID === null ? null : (obs.hitPointsByTypeID?.[entity.typeID] ?? null);
  if (full === null) {
    return null;
  }
  const layers: [number | null, number | null][] = [
    [full.shield, entity.shieldRatio],
    [full.armor, entity.armorRatio],
    [full.hull, entity.hullRatio],
  ];
  let total = 0;
  for (const [capacity, ratio] of layers) {
    if (capacity === null || ratio === null) {
      return null;
    }
    total += capacity * Math.max(0, Math.min(1, ratio));
  }
  return total;
}

/**
 * Bring the combat drones home to swap them for a better size, or null.
 *
 * ⚠ THE RECALL IS THE WHOLE OF THE SWITCH. Once they are in, the role's drones
 * are not out, and the launch branch above sizes the next flight against this
 * same target on a fresh bay read -- one atomic call per tick, and no second
 * copy of the launch rule here.
 */
function decideDroneSizeSwitch(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  targetID: number,
  flightIDs: readonly number[],
  nowMs: number,
): CompanionDecision | null {
  const snapshot = obs.snapshot ?? null;
  const target = snapshot === null ? null : entityOnGrid(targetID, snapshot.entities);
  if (snapshot === null || target === null) {
    return null;
  }
  const verdict = sizeSwitchVerdict({
    flightTypeIDs: flightIDs.map((id) => entityOnGrid(id, snapshot.entities)?.typeID ?? null),
    bay: obs.combatDroneStacks ?? null,
    facts: obs.droneFactsByTypeID ?? new Map(),
    limits: obs.droneLimits ?? null,
    target: sizingTargetFacts(target, obs, measureSpace(snapshot)),
    remainingEhp: remainingHitPoints(target, obs),
    lastSwitchAtMs: memory.droneSizeSwitchAtMs,
    nowMs,
  });
  if (verdict === null || !verdict.switch) {
    return null;
  }
  return {
    action: { kind: "recallDrones", droneIDs: flightIDs },
    phase: "Drones",
    why: verdict.why,
    memory: { ...memory, droneSizeSwitchAtMs: nowMs, droneSizeRecalledIDs: [...flightIDs] },
  };
}

/**
 * Rung 6's hurt-drone rotation: pull the one drone that is being shot, send it
 * back out when it is aboard. The machine is `decideDroneRotation`
 * (`droneRotation.ts`), the drone-boat block's own; this is the companion's
 * wiring of it.
 *
 * ⚠ THE TRIGGER IS THAT DRONE'S SHIELD BELOW FULL, NOT THE WORST LAYER OF THE
 * FLIGHT AGAINST A FLOOR, and both halves of that were costing drones. A
 * recall gives a drone its shield back and nothing else
 * (`buildDroneRecoveryItemPatch`), so a drone whose ARMOUR was below the old
 * floor came back out still below it and was recalled again at once; three of
 * those spent the run's whole budget inside a minute and every drone after
 * that was left to die. And a floor of half the worst layer fires late on a
 * drone with a small shield: a recalled drone flies home at full speed and can
 * be shot until it is 2,500 m from the ship, so the recall has to start while
 * there is still shield to fly home on.
 *
 * ⚠ ONE DRONE, NOT THE FLIGHT. Recalling everything for one hurt drone took
 * the pilot's whole damage off the field for the round trip, which only made
 * the fight, and the rats' time on the next drone, longer.
 *
 * ⚠ PER FIGHT. The counts go when the grid is seen quiet. A drone that has
 * been pulled `MAX_DRONE_ROTATIONS` times in one fight is left to fight on, and
 * the others stay eligible.
 */
function rotateHurtDrone(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  role: CompanionDroneRole | null,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const record = memory.droneRotation;
  // A fight that is over takes the rotation with it: a drone coming home now
  // is coming home for good, and the next fight starts with fresh counts.
  // Only a confident `false` ends it -- `null` is a snapshot that stumbled.
  if (obs.hostileOnGrid === false || role === null) {
    const clean = record.active === null && Object.keys(record.rotations).length === 0;
    return { decision: null, memory: clean ? memory : { ...memory, droneRotation: emptyDroneRotationMemory() } };
  }
  // A new rotation only on a grid we can see; one under way is seen through.
  if (obs.hostileOnGrid !== true && record.active === null) {
    return { decision: null, memory };
  }
  // This role's drones only: a drone of another kind is the wrong-role
  // recall's business. The drone being rotated is always included, whatever
  // the role lists say about it this tick.
  const flight = new Set(droneIDsOutFor(obs, role));
  const rotatingID = record.active?.itemID ?? null;
  const step = decideDroneRotation({
    dronesInSpace: obs.myDrones == null
      ? null
      : obs.myDrones.filter((drone) => flight.has(drone.itemID) || drone.itemID === rotatingID),
    droneIDsInBay: obs.droneBayItemIDs ?? null,
    memory: record,
  });
  const next: CompanionLadderMemory = { ...memory, droneRotation: step.memory };
  if (step.action === "recall" && step.itemID !== null) {
    return {
      decision: {
        action: { kind: "recallDrones", droneIDs: [step.itemID] },
        phase: "Drones",
        why: "A drone is being shot. Bringing that one home for its shield; the rest keep fighting.",
        memory: next,
      },
      memory,
    };
  }
  if (step.action === "relaunch" && step.itemID !== null) {
    return {
      decision: {
        action: { kind: "launchDrones", droneItemIDs: [step.itemID] },
        phase: "Drones",
        why: "The drone is aboard with its shield back. Sending it out again.",
        memory: next,
      },
      memory,
    };
  }
  return { decision: null, memory: next };
}

/**
 * "The grid is clear": the moment the drone rung brings the drones home for
 * good, and -- operator, 2026-10-14 -- the moment the guns are reloaded too
 * (companionAmmo.ts, "A clear grid"). ONE definition for both, so the drones
 * and the guns can never disagree about whether the fight is over.
 *
 * ⚠ A CONFIDENT `false` ONLY. `hostileOnGrid` is three-state and `null` is a
 * read that failed, never a quiet grid.
 */
function gridSeenClear(obs: FleetCompanionObservation): boolean {
  return obs.hostileOnGrid === false;
}

function decideDrones(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  let nothing: { readonly decision: null; readonly memory: CompanionLadderMemory } = { decision: null, memory };
  // ⚠ NO `useDrones` FLAG. A pilot uses the drones it is carrying. What it does
  // with them is decided by WHAT THEY ARE, not by a checkbox -- see
  // `wantedDroneRole`.
  if (obs.inSpace !== true || obs.snapshot == null) {
    return { decision: null, memory };
  }
  const out = obs.myDroneIDs ?? [];
  const role = wantedDroneRole(obs, memory);
  // A job-over recall is over once its drones are home, or once there is a job
  // again -- a fight that restarts mid-recall must not have its next end wait
  // out a recall the drones were since sent away from.
  if (memory.jobOverRecall !== null && (role !== null || out.length === 0)) {
    memory = { ...memory, jobOverRecall: null };
    nothing = { decision: null, memory };
  }
  // A job's launch is over once drones of that kind read as out, or once there
  // is no job: the next launch is a new one and goes at once.
  if (memory.droneLaunch !== null && (role === null || droneIDsOutFor(obs, role).length > 0)) {
    memory = { ...memory, droneLaunch: null };
    nothing = { decision: null, memory };
  }

  // --- never two kinds at once --------------------------------------------
  //
  // ⚠ THIS IS THE RUNG'S ONLY DEFENCE AGAINST A MIXED BAY IN SPACE, and it is
  // why it sits ABOVE the hurt-drone check rather than below it. The operator's
  // rule is "do not mix drones, at one time one type of the drones", and the
  // failure it prevents is concrete: a bay holding combat and salvage drones
  // launched together puts salvage drones into a fight they cannot fight and
  // fills the control slots the combat drones needed. The scripted bots have
  // always done this (`launchRoleDrones` recalls other-role drones first); the
  // companion is the one place in this app that did not.
  //
  // Wrong-role drones are brought home BEFORE anything of the right role goes
  // out, never at the same time -- one atomic call per tick is this loop's whole
  // contract, and a launch issued while the wrong drones are still on grid is
  // exactly the mixing this prevents.
  if (role !== null && out.length > 0) {
    const wrongRole = out.filter((droneID) => !droneIDsOutFor(obs, role).includes(droneID));
    if (wrongRole.length > 0) {
      return {
        decision: {
          action: { kind: "recallDrones", droneIDs: wrongRole },
          phase: "Drones",
          why: `Bringing the wrong drones home first - this pilot needs its ${DRONE_ROLE_WORDS[role]} out.`,
          memory,
        },
        memory,
      };
    }
  }

  // --- a drone being shot: pull that one home, and send it back ----------
  //
  // Above the job-over recall and the launch, so a rotation in flight is seen
  // through before anything else decides what the drones do. A tick that
  // issues nothing here falls through: the pilot keeps obeying its fleet while
  // the drone flies home.
  // ⚠ NOT WHILE A SIZE SWAP IS COMING HOME. The swap recalled the whole flight
  // and the launch branch sizes the next one once it is aboard; a rotation
  // started now would relaunch one of those drones into the middle of that.
  const swapLanding =
    memory.droneRotation.active === null &&
    (memory.droneSizeRecalledIDs ?? []).some((id) => out.includes(id)) &&
    nowMs - (memory.droneSizeSwitchAtMs ?? nowMs) < DRONE_RECALL_GIVE_UP_MS;
  const rotation = swapLanding ? { decision: null, memory } : rotateHurtDrone(obs, memory, role);
  if (rotation.decision !== null) {
    return rotation;
  }
  memory = rotation.memory;
  nothing = { decision: null, memory };
  const rotating = memory.droneRotation.active;

  // --- the job is over: bring them home -----------------------------------
  //
  // ⚠ THIS BRANCH WAS MISSING ENTIRELY, and drones stayed out for the rest of
  // the run once a grid went quiet (observed live, 2026-09-11). Nothing else
  // recalls them: the hurt-drone cycle needs a hurt drone, the wrong-role recall
  // needs another role to want the slots, and the flee only recalls on its way
  // out. A fight that simply ends left them drifting.
  //
  // ⚠ ONLY ON A GRID WE CAN SEE. `hostileOnGrid` is three-state and `null` means
  // the read failed -- recalling on that would pull drones in every time a
  // snapshot stumbled, mid-fight. Only a confident `false` ends the job.
  //
  // ⚠ ONCE, THEN WAIT FOR THEM TO LEAVE THE GRID. See `jobOverRecall`: the
  // drones stay on grid for the whole flight home, and re-sending on every
  // burst tick spent a server call and the tick's one action on an order
  // already taken. It is sent again only if a drone it did not name is out, or
  // after DRONE_RECALL_GIVE_UP_MS -- the recall itself may have failed, and
  // unlike a rotation there is no relaunch riding on this one, so
  // asking again every half-minute is the cheap way to not leave them out. A
  // full bay (refused silently, see DRONE_RECALL_GIVE_UP_MS) is not fixed by
  // asking again either, but it then costs a call a half-minute, not three a
  // second.
  if (role !== "combat") {
    const off = droneAssistOff(obs, memory);
    if (off.decision !== null) {
      return off;
    }
    memory = off.memory;
    nothing = { decision: null, memory };
  }
  if (role === null) {
    if (out.length > 0 && gridSeenClear(obs)) {
      const held = memory.jobOverRecall;
      if (
        held !== null &&
        out.every((droneID) => held.droneIDs.includes(droneID)) &&
        nowMs - held.sinceMs < DRONE_RECALL_GIVE_UP_MS
      ) {
        return nothing;
      }
      return {
        decision: {
          action: { kind: "recallDrones", droneIDs: out },
          phase: "Drones",
          why: "Nothing left to do here. Bringing the drones home.",
          memory: { ...memory, jobOverRecall: { droneIDs: [...out], sinceMs: nowMs } },
        },
        memory,
      };
    }
    return nothing;
  }

  // --- putting the right drones out, and giving them their job ------------
  const roleOut = droneIDsOutFor(obs, role);
  if (roleOut.length === 0) {
    if (rotating !== null) {
      // The one drone out is the one being rotated. It goes back out by
      // itself; launching the bay now would put a whole flight out around it.
      return nothing;
    }
    const bay = droneBayFor(obs, role);
    if (bay === null || bay.length === 0) {
      // `null` is "did not look" and `[]` is "none of that kind aboard".
      // Neither launches, and neither is an error: a pilot without the drones
      // for this job simply does the job without them, or not at all.
      return nothing;
    }
    const launch = roleLaunch(request, obs, memory, role, bay, DRONE_LAUNCH_WHY[role]);
    // ⚠ ONCE, THEN WAIT FOR THEM TO SHOW. See `droneLaunch`: a launch the
    // server took and that still reads as nothing out is not mended by sending
    // it again on every tick, and doing so starves every rung below this one.
    // Sent again at once if this launch names something the last one did not.
    const sent = launch.action.kind === "launchDrones" ? launch.action.droneItemIDs : bay;
    const held = memory.droneLaunch;
    if (
      held !== null &&
      sent.every((itemID) => held.droneItemIDs.includes(itemID)) &&
      nowMs - held.sinceMs < DRONE_LAUNCH_WAIT_MS
    ) {
      return nothing;
    }
    return {
      decision: {
        action: launch.action,
        phase: "Drones",
        why: launch.why,
        memory: { ...memory, droneLaunch: { droneItemIDs: [...sent], sinceMs: nowMs } },
      },
      memory,
    };
  }

  // They are out. All three roles can need TELLING what to do.
  //
  // ⚠ COMBAT DRONES DEFEND THEMSELVES AND ATTACK ON ORDER, AND THE DIFFERENCE
  // IS WHOSE FIGHT IT IS. The server assigns idle combat drones by itself, but
  // only onto something that shoots THEIR OWN CONTROLLER: `noteIncomingAggression`
  // (droneRuntime.js) is called with the damaged ship as the target and walks
  // that ship's own idle drones. So having them out IS the whole of "defend
  // yourself", and nothing in it ever looks at what the FLEET is shooting.
  //
  // ⚠ THAT IS WHY A CALLED TARGET NEEDS AN EXPLICIT ORDER, AND WHY ITS ABSENCE
  // WAS A BUG RATHER THAN A SETTING. Reported live 2026-09-11: "they see rats,
  // they harden and launch drones, even target, but drones do not engage". Of
  // course they did not -- the rats were shooting the commander, so the
  // companion's own controller was never hit and the server's auto-assign had
  // nothing to fire on. The pilot locked the primary and its drones watched.
  //
  // ⚠ ONLY ONCE THE TARGET IS ACTUALLY LOCKED, read off `lockedTargetIDs` and
  // not off our own memory of having asked. Drones cannot be sent onto a ship
  // this hull has not locked, and this rung sits ABOVE the one that does the
  // locking -- so on the tick the call first lands there is nothing to send
  // them onto yet, and the order belongs on the tick after it, when the lock is
  // a fact.
  // ⚠ THE DRONE FLYING HOME IS LEFT OUT OF ANY NEW ORDER, NOT THE WHOLE FLIGHT
  // HELD BACK. An engage is what cancels a recall, so naming the hurt drone
  // would turn it round and send it back to the rat. This used to hold every
  // order until it was aboard, and that cost the fight: seen 2026-10-12, a
  // called target was locked at once but the four healthy drones waited 9 s
  // for the fifth to land and relaunch. The rest take the new order now; the
  // relaunched drone changes the flight, which `withObservedDroneFlights`
  // reads as a new order to give, and it joins them.
  const homewardID = rotating?.phase === "recalling" ? rotating.itemID : null;
  const fighting = homewardID === null ? roleOut : roleOut.filter((id) => id !== homewardID);
  if (fighting.length === 0) {
    return nothing;
  }
  if (role === "combat") {
    const called = calledCombatTargetID(request, obs, memory);
    if (called === null) {
      return nothing;
    }
    if (!isAlreadyLocked(called, obs.lockedTargetIDs, memory)) {
      return nothing;
    }
    // A swap's recall still landing: nothing to order until they are aboard,
    // and the launch branch sizes the next flight once they are. Bounded by
    // the same give-up as the hurt-drone recall, so a drone that never comes
    // home (a full bay) cannot hold the engage for ever.
    const homeward = (memory.droneSizeRecalledIDs ?? []).filter((id) => roleOut.includes(id));
    if (homeward.length > 0 && nowMs - (memory.droneSizeSwitchAtMs ?? nowMs) < DRONE_RECALL_GIVE_UP_MS) {
      return nothing;
    }
    // Never in the middle of a rotation: the swap would recall the flight
    // around a drone that is about to be relaunched on its own.
    const swap = rotating === null ? decideDroneSizeSwitch(obs, memory, called, roleOut, nowMs) : null;
    if (swap !== null) {
      return { decision: swap, memory };
    }
    const engage = decideDroneEngagement(memory, "combat", fighting, called,
      "Putting the combat drones on the target the fleet called.");
    if (engage !== null) {
      return { decision: engage, memory };
    }
    return { decision: droneAssistOn(request, obs, memory), memory };
  }
  if (role === "salvage") {
    // Launched, nothing more: the salvage rung locks a wreck and sends these
    // drones at it by id. See `decideSalvaging`.
    return nothing;
  }
  // Logistic. The ship to repair is whoever the fleet is calling reps for.
  const healTarget = healCallTargetID(obs);
  if (healTarget === null) {
    return nothing;
  }
  return { decision: decideDroneEngagement(memory, "repair", fighting, healTarget,
    "Sending the repair drones to the ship calling for reps."), memory };
}

const MAX_COMPANION_DRONE_ENGAGE_REFUSALS = 3;
const MAX_COMPANION_FOLLOW_REFUSALS = 3;
// A separate, generous barrier budget; every deferral gets a read-only tick.
const MAX_COMPANION_SESSION_DEFERRALS = 30;

/**
 * Ticks to wait before RESENDING an order whose answer was lost.
 *
 * ⚠ THESE ORDERS ARE STANDING STATE, NOT EVENTS, SO REPEATING ONE IS SAFE.
 * `keepAtRange` on the same commander at the same range, drones engaged on the
 * same target, aligning to the same object: a second copy of each lands on the
 * state the first one set, and changes nothing if the first one took. That is
 * what separates them from a cargo move or a jump, which must never be
 * replayed on a guess. Pausing here used to park a companion mid-fight every
 * time a server stall swallowed an answer, until somebody pressed Carry on.
 * The wait is there so the resend lands after the stall, not inside it.
 */
export const COMPANION_RESEND_WAIT_TICKS = 2;

/**
 * Ticks to back off after an order was refused repeatedly, or a session change
 * kept blocking it, before the attempts start over.
 *
 * ⚠ BACK OFF, NOT GIVE UP. The order is still the fleet's order; a pilot that
 * stops obeying it because the server said no three times in six seconds is a
 * pilot somebody has to restart by hand. Thirty seconds is long enough not to
 * hammer a server that is refusing for a reason, and short enough that the
 * pilot is back in formation before the fight has moved on.
 */
export const COMPANION_RETRY_BACKOFF_TICKS = 15;

/**
 * What rung 8 (companionCombatPosition.ts) borrows from this ladder: rung 9
 * itself, its commander lookup, the drone bay, and the order limits above.
 *
 * ⚠ HANDED OVER, NOT IMPORTED, because that file is imported by this one and a
 * value import back would be a load-order cycle. And ⚠ DECLARED HERE, BELOW THE
 * LIMITS IT READS: a `const` above them would capture them uninitialised.
 */
const COMBAT_POSITION_LADDER: CombatPositionLadder = Object.freeze({
  follow: decideFollow,
  // The first commander the roster names whose ship is on this grid: `decideFollow`'s anchor.
  commanderShip: (obs: FleetCompanionObservation): SpaceEntity | null => {
    if ((obs.fleetMemberCharacterIDs ?? null) === null) {
      return null;
    }
    const onGrid = fleetShipsOnGrid(obs);
    for (const commanderID of commandersFor(obs)) {
      const ship = onGrid.find((entity) => entity.characterID === commanderID) ?? null;
      if (ship !== null) {
        return ship;
      }
    }
    return null;
  },
  hasCombatDrones: (obs: FleetCompanionObservation): boolean =>
    (droneBayFor(obs, "combat")?.length ?? 0) > 0 || droneIDsOutFor(obs, "combat").length > 0,
  metresBetween,
  limits: {
    maxRefusals: MAX_COMPANION_POSITION_REFUSALS,
    maxDeferrals: MAX_COMPANION_SESSION_DEFERRALS,
    backoffTicks: COMPANION_RETRY_BACKOFF_TICKS,
    resendWaitTicks: COMPANION_RESEND_WAIT_TICKS,
  },
});

/**
 * What the ammo swap step needs from this ladder. `nextTarget` is the
 * lock-ahead's own order over what it has already locked: tags first, then the
 * kill order (`decideLockAhead`), so the gun is loaded for the ship the
 * lock-ahead expects to fight next.
 */
const AMMO_LADDER: AmmoLadder = Object.freeze({
  nextTarget: (obs: FleetCompanionObservation, engagedID: number): SpaceEntity | null => {
    const locked = obs.lockedTargetIDs ?? null;
    const snapshot = obs.snapshot ?? null;
    if (locked === null || snapshot === null) {
      return null;
    }
    const candidates = snapshot.entities.filter((entity) =>
      entity.itemID !== engagedID && isHostile(entity) && locked.includes(entity.itemID));
    if (candidates.length === 0) {
      return null;
    }
    const measurement = measureSpace(snapshot);
    const tags = obs.fleetTargetTags ?? null;
    return (tags === null ? null : bestTaggedEntity(tags, candidates, measurement)) ??
      rankByKillOrder(obs, candidates, measurement);
  },
  remainingHitPoints,
});

function decideDroneEngagement(
  memory: CompanionLadderMemory, role: "combat" | "repair", flightIDs: readonly number[], targetID: number, why: string,
): CompanionDecision | null {
  const field = role === "combat" ? "combatDroneOrder" : "repairDroneOrder";
  const saved = memory[field];
  let previous = saved?.targetID === targetID ? saved : null;
  if (previous?.pending) return null;
  if (previous !== null && previous.cooldown !== undefined) {
    if (previous.cooldown > 1) {
      return waiting("Drones", "Waiting a moment before sending the drones again.", {
        ...memory, [field]: { ...previous, cooldown: previous.cooldown - 1 },
      });
    }
    // Over: every drone in flight is sent again, from a clean slate.
    memory = { ...memory, [field]: null };
    previous = null;
  }
  if (previous !== null && previous.deferrals >= MAX_COMPANION_SESSION_DEFERRALS) {
    return waiting("Drones", "A session change kept blocking the drones. Trying again shortly.", {
      ...memory, [field]: { ...previous, cooldown: COMPANION_RETRY_BACKOFF_TICKS },
    });
  }
  if (previous?.deferralWait) {
    return waiting("Drones", "Waiting for the session change to clear before retrying drone engagement.", {
      ...memory, [field]: { ...previous, deferralWait: false },
    });
  }
  const requestedIDs = previous === null ? flightIDs : previous.refusedIDs.filter(
    (id) => (previous.refusals[id] ?? 0) < MAX_COMPANION_DRONE_ENGAGE_REFUSALS,
  );
  if (requestedIDs.length === 0) {
    if (previous !== null && (previous.uncertainIDs.length > 0 || previous.refusedIDs.length > 0)) {
      const lost = previous.refusedIDs.length === 0;
      return waiting("Drones", lost
        ? "The drones' order got no answer. Sending it again in a moment."
        : "The drones' order was refused repeatedly. Trying again shortly.", {
        ...memory,
        [field]: { ...previous, cooldown: lost ? COMPANION_RESEND_WAIT_TICKS : COMPANION_RETRY_BACKOFF_TICKS },
      });
    }
    return null;
  }
  const pending: CompanionDroneEngagement = {
    targetID, flightIDs: [...flightIDs], requestedIDs: [...requestedIDs], pending: true,
    acceptedIDs: previous?.acceptedIDs ?? [], refusedIDs: previous?.refusedIDs ?? [],
    uncertainIDs: previous?.uncertainIDs ?? [], refusals: previous?.refusals ?? {},
    deferrals: previous?.deferrals ?? 0, deferralWait: false,
  };
  return { action: { kind: "engageDrones", droneIDs: requestedIDs, targetID }, phase: "Drones", why,
    memory: role === "combat"
      ? { ...memory, combatDroneOrder: pending, lastDroneEngageTargetID: targetID, lastDroneEngageIDs: [...flightIDs] }
      : { ...memory, repairDroneOrder: pending, lastDroneRepairTargetID: targetID, lastDroneRepairIDs: [...flightIDs] },
  };
}

/** What to call each role in a sentence a player reads. Plain words, no jargon. */
const DRONE_ROLE_WORDS: Readonly<Record<CompanionDroneRole, string>> = Object.freeze({
  combat: "combat drones",
  logistic: "repair drones",
  salvage: "salvage drones",
});

const DRONE_LAUNCH_WHY: Readonly<Record<CompanionDroneRole, string>> = Object.freeze({
  combat: "Something hostile is on grid. Putting the combat drones out.",
  logistic: "A fleet-mate is calling for reps. Putting the repair drones out.",
  salvage: "Putting the salvage drones out.",
});

/**
 * The ONE kind of drone this pilot should have in space right now, or null for
 * none at all.
 *
 * ⚠ ONE ROLE, NEVER A SET, AND THAT IS THE WHOLE POINT. The operator's rule is
 * "at one time one type of the drones". Returning a single role is what makes
 * that structural rather than a thing the launch branches have to remember.
 *
 * ⚠ THE ORDER BELOW IS URGENCY, AND IT MATCHES THE LADDER'S OWN. Answering a
 * rep call outranks joining a fight for exactly the reason `decideFleetOrders`
 * already puts the Heal family above a tag: somebody is dying NOW, where a
 * fight is still there next tick. Salvage comes last because it is housekeeping
 * -- and in practice it never competes, because a hull carrying salvage drones
 * is rarely carrying combat drones too.
 *
 * ⚠ EACH BRANCH REQUIRES THE DRONES AS WELL AS THE REASON. A pilot with no
 * repair drones is not "the logistic role with nothing to launch", it is simply
 * not that pilot -- so the branch falls through and it fights instead. This is
 * what makes "if pilot has repair drones use them on fleet members" true without
 * anybody selecting a role.
 *
 * ⚠ WHAT IS ABSENT IS ABSENT ON PURPOSE. Mining drones are never launched: a
 * companion does not mine. Electronic-warfare drones are not launched either --
 * they work on this server, but nothing has asked for them and launching a jam
 * nobody planned is not a default. Webifier and energy-neutralizer drones CANNOT
 * be launched usefully at all: the server implements no effect for either, and
 * refuses to engage them. `droneRoles.ts` records that; none of the three
 * reaches this function, because `splitDroneRoles` never puts them in a role.
 */
function wantedDroneRole(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDroneRole | null {
  const hasDrones = (role: CompanionDroneRole): boolean =>
    (droneBayFor(obs, role)?.length ?? 0) > 0 || droneIDsOutFor(obs, role).length > 0;

  if (healCallTargetID(obs) !== null && hasDrones("logistic")) {
    return "logistic";
  }
  // ⚠ ONLY INTO A FIGHT. `hostileOnGrid` is three-state and only `true` starts
  // a launch: `null` means the grid could not be read, and launching blind
  // would put drones out on a grid this pilot cannot see - the one place they
  // are hardest to get back.
  if (obs.hostileOnGrid === true && hasDrones("combat")) {
    return "combat";
  }
  if (salvageWasOrdered(memory) && hasDrones("salvage")) {
    return "salvage";
  }
  return null;
}

/** The bay stacks of one role. `null` is "the bay was not read", never "empty". */
function droneBayFor(
  obs: FleetCompanionObservation,
  role: CompanionDroneRole,
): readonly number[] | null {
  switch (role) {
    case "combat":
      return obs.combatDroneBayItemIDs ?? null;
    case "logistic":
      return obs.logisticDroneBayItemIDs ?? null;
    case "salvage":
      return obs.salvageDroneBayItemIDs ?? null;
  }
}

/**
 * This ship's drones of one role that are OUT, by entity id.
 *
 * ⚠ BAY IDS AND ENTITY IDS ARE DIFFERENT ID SPACES. A stack in the bay and a
 * drone in space are not the same object and never share an id; `launchDrones`
 * takes the former and `recallDrones` / `engageDrones` / `salvageDrones` take
 * the latter. Mixing them answers 200 and does nothing.
 */
function droneIDsOutFor(
  obs: FleetCompanionObservation,
  role: CompanionDroneRole,
): readonly number[] {
  switch (role) {
    case "combat":
      return obs.combatDroneIDs ?? [];
    case "logistic":
      return obs.logisticDroneIDs ?? [];
    case "salvage":
      return obs.salvageDroneIDs ?? [];
  }
}

/**
 * The ship the fleet is currently calling reps for, if that call is live and
 * that ship is on this grid.
 *
 * ⚠ THE SAME ANSWER `decideHealOrder` ACTS ON, read the same way, so a pilot's
 * repair DRONES and its remote repair MODULES cannot end up working on two
 * different ships. `itemID` is the ship to repair directly for all four Heal
 * names -- never `senderCharID` resolved to an entity.
 */
function healCallTargetID(obs: FleetCompanionObservation): number | null {
  const name = asHealBroadcastName(obs.fleetBroadcast?.name);
  if (name === null) {
    return null;
  }
  const targetID = obs.fleetBroadcast?.itemID ?? null;
  if (targetID === null) {
    return null;
  }
  return entityOnGrid(targetID, obs.snapshot?.entities ?? []) === null ? null : targetID;
}

/**
 * Rung 7: obeying the fleet. Below the supervision gate and rung 3 (tank up)
 * and above "Standing by". Returns `null` when there is nothing to obey,
 * which is how the caller falls through to standing by.
 *
 * Checked in this order — the Heal family, then a fleet tag, then a `Target`
 * broadcast, then `AlignTo`, then `TravelTo`, then `JumpTo` — for two
 * DIFFERENT reasons, not one:
 *
 * ⚠ HEAL OUTRANKS EVEN THE TAG, AND THE REASON IS NOT AUTHORITY, IT IS
 * URGENCY AND NON-EXCLUSIVITY. A tag is standing fleet state — still true
 * next tick, and the tick after that — where a rep call is time-critical:
 * someone is dying now. And unlike locking, which competes with a tag for
 * the very same action, healing does not compete with locking for the
 * SHIP'S STATE at all — a logi can run a repairer and hold a lock at once.
 * It only competes for THIS TICK'S one atomic call. That is exactly why
 * `decideHealOrder` returns `null` — falls through, rather than parking the
 * tick the way `lockThenEngage`'s "already locked" branch does — the moment
 * there is nothing NEW to start: a logi whose repairer is already cycling is
 * still free to lock the primary on the very same tick's next check, and a
 * dps pilot with nothing fitted for the call is never blocked by it at all.
 *
 * ⚠ A TAG OUTRANKS A BROADCAST, WHICH LOOKS BACKWARDS: a broadcast is the
 * FRESHER, more deliberate act, so a later reader will want to swap these.
 * Don't — the reason is AUTHORITY, and it is in the server, not in freshness.
 * `setFleetTargetTag` refuses any writer who is not a fleet commander, so a
 * tag that EXISTS is provably a commander's. `sendBroadcast` checks fleet
 * MEMBERSHIP and nothing else — any member may broadcast `Target` — and
 * receiving one says nothing at all about who sent it. When the two disagree,
 * the tag is the one that can only be the FC's. (This is a SEPARATE ranking
 * question from Heal-vs-tag above: Target/AlignTo/TravelTo/JumpTo are all
 * read off the SAME `obs.fleetBroadcast` slot as Heal, so only one of them
 * can ever match in a given tick anyway — their relative order below never
 * actually competes for anything.)
 *
 * ⚠ A CALL FOR SOMETHING NOT ON THIS GRID IS NOT AN ORDER FOR THIS PILOT. A
 * tagged or called item absent from `obs.snapshot` is skipped — falling
 * through to the next source, and ultimately to "Standing by" — rather than
 * waited on. That is what keeps a follower flying its own ladder while the FC
 * is off doing something two systems away. `TravelTo` is the one exception:
 * its itemID is a solar SYSTEM, not an object, so there is nothing on this
 * grid to check it against.
 *
 * ⚠ THIS RUNG NOW LOCKS **AND FIRES**, and the sentence that used to stand here
 * said the opposite: "there is no weapons rung yet and no weapon-module field
 * on `FleetCompanionRequest` -- shooting is a later phase. A lock is the real,
 * complete first half of answering a primary." That was honest when it was
 * written and it is dead now. `weaponModuleIDs` exists, and `lockThenEngage`
 * opens fire once the lock is OBSERVED. Locking alone is still what a pilot
 * with an empty weapon list does, and the readout says so in those words --
 * but it is now a SETTING, not the limit of the feature.
 *
 * ⚠ AND IT STILL PARKS THE TICK, which matters more now than it did. The
 * "already locked" branch returns a wait rather than falling through the way
 * `decideHealOrder` does, so while a target call stands, every rung BELOW this
 * one is starved. That was harmless when the branch meant "locked, nothing
 * more to do"; it is load-bearing now that the same branch means "locked and
 * shooting", because a standing primary is exactly the situation in which the
 * rungs below want a turn.
 *
 * It is left parked deliberately, for the readout: a pilot fighting the FC's
 * primary should say "Obeying fleet", not fall through to "Standing by" while
 * its guns are running. **But phase 6 must not put its flee beneath this rung**
 * -- a pilot that never stops obeying a target call would never flee -- and
 * phase 5's drone recall has the same problem. The planned ladder puts both
 * below; that ordering has to be revisited when they are built, not inherited.
 */
function decideFleetOrders(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return null;
  }
  const entities = snapshot.entities;
  const measurement = measureSpace(snapshot);

  // a. The Heal family — see the header above for why this is checked first.
  const healDecision = decideHealOrder(request, obs, entities, memory);
  if (healDecision !== null) {
    return healDecision;
  }

  // c-f. ONE SET OF BRANCHES, TWO SOURCES. A named order reaches this pilot
  //       either as a fleet broadcast or as a line somebody typed in chat, and
  //       from here down it is deliberately the same order. Resolving the
  //       source ONCE, above the branches, is what stops chat being a second
  //       copy of Target/AlignTo/TravelTo/JumpTo that drifts out of step with
  //       the first -- the JumpTo branch alone is thirty lines of honest
  //       partial nobody should be maintaining twice.
  // A called gate outlives the slot: see `withHeardGateCall`.
  const order = namedOrderFor(request, obs, memory, entities);

  // b + c. The target the fleet is calling: a commander's TAG first, then a
  //        `Target` broadcast or the chat line standing in for one. Both come
  //        from `calledTarget`, which rung 6 reads too so the drones and the
  //        guns can never pick different ships. See its header.
  //
  //        ⚠ UNLESS THIS PILOT HAS GIVEN UP ON LOCKING IT. Then the call is
  //        heard, and answered with "I cannot", instead of being re-issued for
  //        ever -- and crucially the rung falls THROUGH, so the orders below and
  //        the rungs beneath this one get their ticks back. See `lockGaveUpOn`.
  const called = calledTarget(obs, entities, measurement, order, memory);
  const unreachable = called !== null && gaveUpOnLocking(memory, called.itemID);
  if (called !== null && !unreachable) {
    return lockThenEngage(
      called.itemID,
      called.source,
      called.heard,
      called.why,
      request,
      obs,
      memory,
      nowMs,
      measurement,
    );
  }

  // d. An `AlignTo` order.
  if (order?.name === "AlignTo") {
    let previous = memory.alignmentOrder?.key === order.key ? memory.alignmentOrder : null;
    const base = {
      phase: "Obeying fleet",
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
    if (previous !== null && previous.cooldown !== undefined) {
      if (previous.cooldown > 1) {
        return {
          ...base,
          action: WAIT,
          why: order.why + " Waiting a moment before aligning again.",
          memory: { ...memory, alignmentOrder: { ...previous, cooldown: previous.cooldown - 1 } },
          standing: true,
          holdsNavigation: true,
        };
      }
      previous = null;
    }
    if (previous !== null && previous.status === "uncertain") {
      return {
        ...base,
        action: WAIT,
        why: order.why + " The alignment request got no answer. Sending it again in a moment.",
        memory: { ...memory, alignmentOrder: { ...previous, cooldown: COMPANION_RESEND_WAIT_TICKS } },
        standing: true,
        holdsNavigation: true,
      };
    }
    if (previous !== null && previous.status !== "refused") {
      return {
        ...base,
        action: WAIT,
        why: order.why + (previous.status === "issued"
          ? " Continuing the alignment order."
          : " Alignment was requested; its outcome is not confirmed, so it will not be sent again."),
        memory,
        standing: true,
        holdsNavigation: true,
      };
    }
    if (previous !== null && previous.refusals >= MAX_COMPANION_ALIGN_REFUSALS) {
      return {
        ...base,
        action: WAIT,
        why: order.why + " Alignment was refused repeatedly. Trying again shortly.",
        memory: { ...memory, alignmentOrder: { ...previous, cooldown: COMPANION_RETRY_BACKOFF_TICKS } },
        standing: true,
        holdsNavigation: true,
      };
    }
    return {
      ...base,
      action: { kind: "align", targetID: order.itemID },
      why: order.why + " Aligning to it.",
      memory: { ...memory, alignmentOrder: {
        key: order.key, targetID: order.itemID, status: "pending", refusals: previous?.refusals ?? 0,
      } },
    };
  }

  // e. A `TravelTo` order — a destination SOLAR SYSTEM
  //    (`FLEET_BROADCAST_CLASSIFICATION`'s "destination-system"), not an
  //    on-grid object, so there is no grid-presence check here. Routing
  //    restarts the shared autopilot, so it is issued once per DISTINCT
  //    destination and never re-issued merely because the tick repeats —
  //    `lastRoutedSystemID` is this ladder's memory of that, the same
  //    "compare and stamp" `closingOn`/`lastLockIssuedFor` already use.
  //
  //    ⚠ ONCE ISSUED, THIS RUNG DOES NOT SUPPRESS ITSELF FURTHER. The route
  //    runs on the SHARED autopilot controller (flow.ts's `startRoute`), a
  //    SEPARATE decide-loop from this one, and this ladder keeps ticking at
  //    its own cadence throughout. Rung 1's warp yield covers the actual
  //    transit (`inWarp` is true while the autopilot's own warp is in
  //    flight), but the moments between hops — approaching or sitting at a
  //    gate — are NOT covered, and a fleet order landing in one of those
  //    gaps could still issue a lock/align/heal call alongside the
  //    autopilot's own navigation. That is an accepted, un-solved gap, not a
  //    claim that this rung fully hands off control.
  if (order?.name === "TravelTo" && order.itemID !== memory.lastRoutedSystemID) {
    return {
      action: { kind: "travelTo", systemID: order.itemID },
      phase: "Obeying fleet",
      why: order.why + " Starting the route.",
      memory: { ...memory, lastRoutedSystemID: order.itemID },
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // e2. A `WarpTo` order — warp to the thing the fleet named.
  //
  //    ⚠ THIS RUNG DID NOT EXIST, ON A FALSE PREMISE. `WarpTo` was classified
  //    `act: false` with the note that "the fleet warp itself is executed
  //    server-side once the broadcast lands". It is not: `sendBroadcast`
  //    (fleetRuntime.js) only ever calls `notifySession`, and warps nobody. The
  //    server-side fleet warp is a DIFFERENT command (`CmdWarpToStuff` with
  //    `fleet=1`), which this loop yields to by seeing its own ship in warp. So
  //    a `WarpTo` broadcast was simply being ignored, and a fleet that told this
  //    pilot to warp watched it sit still.
  if (order?.name === "WarpTo") {
    // ⚠ MEASURED BEFORE IT IS WARPED TO, as every other warp this ladder makes
    // is. Only an object on this grid has a distance; a fleet-mate's character
    // id has none and goes to the member warp below unmeasured.
    const step = entityOnGrid(order.itemID, entities) === null
      ? null
      : decideCloseIn(order.itemID, WARP_TO_ARRIVED_M, measurement, memory.closingOn, AUTOPILOT_WARP_STOPS_SHORT_M, memory.closingOnAtMs, nowMs);
    // ⚠ ANSWERED ONCE PER DESTINATION. A broadcast stands for its whole
    // freshness window, so a rung that re-warped on every tick would re-issue
    // the same warp for thirty seconds -- and land, then immediately warp again.
    if (memory.lastWarpedToID === order.itemID) {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + (step?.kind === "arrive" ? " Already there." : " Already on the way."),
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
        standing: true,
      };
    }
    // ⚠ ALREADY THERE IS AN ANSWER TOO, and the latch above never sees it when
    // somebody else's warp brought the ship. The FC's fleet warp
    // (`CmdWarpToStuff` with `fleet=1`) moves every member server-side, and a
    // `WarpTo` broadcast for the same place stands for thirty seconds after it
    // lands, so this pilot heard an order it had never answered and warped to a
    // station 260 m off: `WARP_DISTANCE_TOO_CLOSE`, "You cannot warp there right
    // now." Being there stamps the latch, so the order is answered once whoever
    // flew the ship.
    //
    // ⚠ NOT STANDING, for one tick. The memory of a standing decision is dropped
    // when the follow beneath it acts, and the stamp would go with it; a plain
    // wait keeps it, and the next tick is the standing readout above.
    if (step?.kind === "arrive") {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " Already there.",
        memory: { ...memory, lastWarpedToID: order.itemID },
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    // ⚠ INSIDE THE WARP FLOOR, APPROACH, as a client's autopilot does under
    // `minWarpDistance` (autopilot.py, `AP_ApproachDestID`: `CmdFollowBall` at
    // nought). Warping there is refused by the server, not by us.
    if (step?.kind === "closing") {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " Closing on it.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step?.kind === "approach") {
      return {
        action: { kind: "approach", targetID: order.itemID },
        phase: "Obeying fleet",
        why: order.why + " It is too close to warp to, so closing on it.",
        memory: { ...memory, closingOn: order.itemID, closingOnAtMs: nowMs },
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    // ⚠ TWO WARPS, AND THE GRID DECIDES WHICH. An id this pilot can SEE is an
    // object, warped to with the ordinary item warp. An id it cannot see got
    // past `isOrderActionable` only by being a fleet-mate's character id, and
    // that is the server's own fleet-member warp — `CmdWarpToStuff("char", …)`,
    // which resolves where that member is itself. The distinction is made here,
    // where the grid is known, and never in the chat parser, which sees only a
    // link with a number in it.
    //
    // ⚠ THE GRID IS ASKED FIRST, so an id that is BOTH (a fleet-mate standing
    // right here) stays an ordinary warp to the thing on the grid rather than a
    // round trip through the fleet service for the same destination.
    if (entityOnGrid(order.itemID, entities) !== null) {
      return {
        action: { kind: "warp", targetID: order.itemID },
        phase: "Obeying fleet",
        why: order.why + " Warping to it.",
        memory: { ...memory, lastWarpedToID: order.itemID },
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    return {
      action: { kind: "warpToFleetMember", characterID: order.itemID },
      phase: "Obeying fleet",
      // ⚠ "FLEET-MATE", NOT A NAME. This ladder holds ids and never resolves a
      // character name, and inventing one here would be the readout claiming
      // something nothing in this file looked up.
      why: order.why + " Warping to that fleet-mate.",
      memory: { ...memory, lastWarpedToID: order.itemID },
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // f. A `JumpTo` order — warp to the gate, close in, and jump through it.
  //
  //    ⚠ IT USED TO STOP AT THE GATE, AND THE REASON RECORDED HERE WAS WRONG.
  //    The note said a jump "needs the gate on the FAR SIDE too", which only
  //    `toGateID` on `api.jump` ever wanted -- solved by the autopilot's route
  //    graph, which this pure ladder has no copy of. But the GAME does not want
  //    it: `jumpSessionViaStargate` (transitions.js) resolves the destination
  //    itself from `sourceGate.destinationID` when the far id is absent, and
  //    rejects only a MISMATCHED one. The requirement was our own BFF's
  //    INVALID_GATE check, now relaxed to allow it to be omitted. A stargate
  //    knows where it goes.
  //
  //    ⚠ AND THE SHIP MUST BE AT THE GATE, not merely near it. `decideCloseIn`
  //    against MAX_STARGATE_JUMPING_DISTANCE_M is what makes the jump legal;
  //    firing it from further out is refused by the server, not by us.
  if (order?.name === "JumpTo") {
    const gateID = order.itemID;
    const step = decideCloseIn(gateID, MAX_STARGATE_JUMPING_DISTANCE_M, measurement, memory.closingOn, AUTOPILOT_WARP_STOPS_SHORT_M, memory.closingOnAtMs, nowMs);
    if (step === null) {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " It is not measurable this tick.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "arrive") {
      return {
        action: { kind: "jumpGate", gateID },
        phase: "Obeying fleet",
        why: order.why + " At the gate, jumping through.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "closing") {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " Closing on it.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "approach") {
      return {
        action: { kind: "approach", targetID: gateID },
        phase: "Obeying fleet",
        why: order.why + " Starting to close on it.",
        memory: { ...memory, closingOn: gateID, closingOnAtMs: nowMs },
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    return {
      action: { kind: "warp", targetID: gateID },
      phase: "Obeying fleet",
      why: order.why + " Warping to it.",
      memory,
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // The fleet IS calling a target, and this pilot has stopped trying to lock it.
  //
  // ⚠ STANDING, NOT PARKED, AND THAT IS THE ENTIRE VALUE OF GIVING UP. A
  // `standing` decision is kept as the READOUT while the ladder carries on, so
  // the rungs beneath -- the loot order, salvage -- get the ticks this rung was
  // spending on a lock that never landed, and the panel still says what the
  // fleet asked for and why this pilot is not doing it. Parking here would swap
  // one kind of stuck pilot for another.
  // A free-fire pick never lands here: `freeFireTarget` skips every ship this
  // pilot gave up locking, so it moves on instead of announcing "I cannot".
  if (unreachable && called !== null && called.source !== "free-fire" && called.source !== "tackled") {
    return {
      action: WAIT,
      standing: true,
      phase: "Obeying fleet",
      why: `${called.why} It cannot be locked from here, so this pilot has stopped trying and is getting on with its own work.`,
      memory,
      followingOrderFrom: called.source,
      lastOrderHeard: called.heard,
    };
  }

  return null;
}

interface CompanionMemory {
  status: FleetCompanionRunState;
  phase: string | null;
  action: string | null;
  why: string | null;
  inFleet: boolean | null;
  followingOrderFrom: FleetCompanionProgress["followingOrderFrom"];
  lastOrderHeard: string | null;
  canTag: boolean | null;
  failureReason: string | null;
  /**
   * When the current streak of unanswered reads began, and which run it
   * belongs to. Null while reads are answering. See
   * `FLEET_COMPANION_READ_GRACE_MS`.
   */
  readFailing: { readonly sinceMs: number; readonly token: number } | null;
  /**
   * When the current streak of BLIND scene reads began (a 200 with no ship in it),
   * and which run it belongs to. Null while the scene is readable. Same grace as
   * `readFailing`; see `FLEET_COMPANION_READ_GRACE_MS`.
   */
  sceneBlind: { readonly sinceMs: number; readonly token: number } | null;
  /** True when the run paused ITSELF (the ladder or an unconfirmed command), never for an operator pause. */
  selfPaused: boolean;
  /** The live request. Null until `start()`; the ladder needs it every tick. */
  request: FleetCompanionRequest | null;
  /** The ladder's own threaded memory — see `CompanionLadderMemory`. */
  ladder: CompanionLadderMemory;
  /** The last decision's trace; null until one, and after a failed read. */
  trace: CompanionTrace | null;
}

function freshMemory(): CompanionMemory {
  return {
    status: "idle",
    phase: null,
    action: null,
    why: null,
    inFleet: null,
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
    failureReason: null,
    readFailing: null,
    sceneBlind: null,
    selfPaused: false,
    request: null,
    ladder: freshLadderMemory(),
    trace: null,
  };
}

/**
 * How a failed call is classed -- the same three answers the settle functions
 * act on -- for the recorder's `result` line.
 */
function companionVerdict(error: unknown): "deferred" | "refused" | "uncertain" {
  return isSessionChangeDeferral(error) ? "deferred" : isDefiniteCompanionRefusal(error) ? "refused" : "uncertain";
}

/** The persisted half of the ladder's abandonment, or null when there is none. */
function abandonmentRecord(ladder: CompanionLadderMemory): CompanionAbandonmentRecord | null {
  const running = ladder.abandonment;
  return running === null
    ? null
    : {
        abandonedAtMs: running.abandonedAtMs,
        supervisorCharacterIDs: [...running.supervisorCharacterIDs],
      };
}

/**
 * What a refused call means, in words a player reads.
 *
 * ⚠ THE INPUT IS THE SERVER'S OWN ERROR-CLASS NAME, AND IT MUST NEVER BE THE
 * OUTPUT. A refusal reaches this client as the retail class the server threw --
 * `TargetNotWithinRangeGeneric`, `DeniedTargetOtherWarping` -- which is raw
 * vocabulary of exactly the kind the panel's own tests forbid reaching a player.
 * So this matches on it and answers with a sentence; it never echoes it.
 *
 * ⚠ AND THE FALLBACK IS DELIBERATELY VAGUE RATHER THAN WRONG. A refusal this
 * does not recognise is still worth saying happened -- a pilot that looks idle
 * for a reason it will not name is the thing this whole readout exists to stop --
 * but guessing WHICH reason would put a confident falsehood on screen.
 */
function refusalWords(raw: string, refused = true): string {
  const text = String(raw ?? "");
  if (/NotWithinRange|OutOfRange|TooFar/i.test(text)) {
    return "The server refused that: it is out of reach from here.";
  }
  if (/Warping/i.test(text)) {
    return "The server refused that: something is in warp.";
  }
  // ⚠ "That target cannot be engaged by drones." IS THE SERVER SAYING THE TARGET
  // IS GONE. `commandEngage` (server/src/services/drone/droneRuntime.js, ~5250)
  // sends it only when the target entity no longer exists or has no health left.
  // Seen live 2026-10-14, many times per fight, each at the target's kill payout,
  // and the readout said "refused that call" as if the drones were being blocked.
  if (/NotPresent|NotFound|Cancelled|cannot be engaged by drones/i.test(text)) {
    return "The server refused that: it is no longer there.";
  }
  // ⚠ ONLY A DEFINITE REFUSAL IS "REFUSED". A call that came back uncertain
  // (`engageDrones`: "Could not confirm every drone engagement order.") was
  // not answered no, so saying so was false. Seen live 2026-10-14.
  return refused ? "The server refused that call." : "The server did not confirm that call.";
}

/**
 * Send a tick's chat lines one after another, never waited on by the tick.
 *
 * ⚠ NOT AWAITED, BECAUSE A CHAT LINE IS NEVER WORTH A LATE MODULE. The send is a
 * round trip of its own, and a tick that waited on it would hand the next rung
 * its call that much later. In order, because "Low on ammo" after the status
 * line it explains reads backwards. A line that fails is dropped: what the ship
 * has left is said again on the next `status`, and a warning that was lost is
 * one the ladder already counts as said.
 */
async function sayInOrder(say: (text: string) => Promise<void>, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    try {
      await say(line);
    } catch {
      // Dropped. See above.
    }
  }
}

export function createFleetCompanion(deps: FleetCompanionDeps): FleetCompanionController {
  let mem = freshMemory();
  /**
   * ⚠ THE STALE-RUN GUARD. A `run()` in flight keeps its token; `start()` mints
   * a new one. So a tick belonging to a run the player already stopped and
   * restarted cannot land its call on top of the new run — the same
   * construction the other loops use.
   */
  let runToken = 0;
  let activeTick: Promise<FleetCompanionAction> | null = null;
  let activeDriver: { token: number; promise: Promise<void> } | null = null;
  const recorder = createCompanionRecorder(deps.log, () => deps.now?.() ?? Date.now());
  /**
   * The run's tick counter, for the recorder: every tick takes the next number,
   * and the `decide`, `issue` and `result` lines it writes carry it, so a reader
   * can put a call back beside the decision that sent it. Reset by `start()`.
   */
  let seq = 0;
  /**
   * Modules the server refused as "... cannot be activated." this run, kept out
   * of every list from then on (`withoutModules`). Reset by `start()`.
   */
  let passiveModuleIDs: ReadonlySet<number> = new Set();

  function report(tickSeq?: number): void {
    const progress = snapshot();
    recorder.progress(progress, tickSeq === undefined ? undefined : { seq: tickSeq });
    deps.onProgress?.(progress);
  }

  function snapshot(): FleetCompanionProgress {
    return {
      status: mem.status,
      phase: mem.phase,
      action: mem.action,
      why: mem.why,
      inFleet: mem.inFleet,
      followingOrderFrom: mem.followingOrderFrom,
      lastOrderHeard: mem.lastOrderHeard,
      targetMode: mem.ladder.targetMode,
      canTag: mem.canTag,
      abandonment: abandonmentRecord(mem.ladder),
      failureReason: mem.failureReason,
      selfPaused: mem.status === "paused" && mem.selfPaused,
      ...(mem.trace === null ? {} : { trace: mem.trace }),
    };
  }

  function settleAlignment(decision: CompanionDecision, status: "issued" | "refused" | "uncertain"): void {
    const pending = decision.memory.alignmentOrder;
    // Pause retires the driver, not its dispatched command. Retain its result
    // only while this exact pending record survives; a new Start or movement
    // intent has a different record even when the source identity is the same.
    if (decision.action.kind !== "align" || pending?.status !== "pending" ||
      mem.ladder.alignmentOrder !== pending) return;
    mem.ladder = { ...mem.ladder, alignmentOrder: { ...pending, status,
      refusals: pending.refusals + (status === "refused" ? 1 : 0),
    } };
  }

  function settleFollow(decision: CompanionDecision, succeeded: boolean, error?: unknown): void {
    const pending = decision.memory.followOrder;
    if (decision.action.kind !== "keepAtRange" || pending?.status !== "pending" ||
      mem.ladder.followOrder !== pending) return;
    const status = succeeded ? "issued" : isSessionChangeDeferral(error) ? "deferred"
      : isDefiniteCompanionRefusal(error) ? "refused" : "uncertain";
    mem.ladder = { ...mem.ladder, followOrder: { ...pending, status,
      refusals: pending.refusals + (status === "refused" ? 1 : 0),
      deferrals: status === "deferred" ? pending.deferrals + 1 : 0, deferralWait: status === "deferred",
    } };
  }

  // The rejoin warp, settled on the `settleFollow` terms, plus the refusal's
  // reason for the give-up readout. A lost answer is counted by the ladder.
  function settleRejoin(decision: CompanionDecision, succeeded: boolean, error?: unknown): void {
    const pending = decision.memory.rejoin;
    if (decision.action.kind !== "warpToFleetMember" || decision.phase !== REJOIN_PHASE ||
      pending?.status !== "pending" || mem.ladder.rejoin !== pending) return;
    const status = succeeded ? "issued" : isSessionChangeDeferral(error) ? "deferred"
      : isDefiniteCompanionRefusal(error) ? "refused" : "uncertain";
    mem.ladder = { ...mem.ladder, rejoin: { ...pending, status,
      tries: pending.tries + (status === "refused" ? 1 : 0),
      reason: status === "refused" ? rejoinRefusalReason(error) : pending.reason,
      ...(status === "refused" && isCommanderNotHereRefusal(error) ? { notHere: true } : {}),
      deferrals: status === "deferred" ? pending.deferrals + 1 : 0, deferralWait: status === "deferred",
    } };
  }

  // Rung 8's positioning order, settled on the `settleFollow` terms (`settleCombatHold`).
  function settleCombatPosition(decision: CompanionDecision, succeeded: boolean, error?: unknown): void {
    mem.ladder = settleCombatHold(decision, mem.ladder, succeeded ? "issued" : isSessionChangeDeferral(error)
      ? "deferred" : isDefiniteCompanionRefusal(error) ? "refused" : "uncertain");
  }

  function settleDroneEngagement(decision: CompanionDecision, succeeded: boolean, error?: unknown): void {
    if (decision.action.kind !== "engageDrones") return;
    for (const field of ["combatDroneOrder", "repairDroneOrder"] as const) {
      const pending = decision.memory[field];
      if (pending?.pending !== true || mem.ladder[field] !== pending ||
        pending.targetID !== decision.action.targetID) continue;
      const requested = pending.requestedIDs;
      const detail = error !== null && typeof error === "object" ? error as Record<string, unknown> : null;
      const hasDetails = detail !== null && ("acceptedDroneIDs" in detail || "refusedDroneIDs" in detail || "uncertainDroneIDs" in detail);
      const reported = (name: string): number[] => Array.isArray(detail?.[name])
        ? requested.filter((id) => (detail[name] as unknown[]).includes(id)) : [];
      const deferred = !succeeded && isSessionChangeDeferral(error);
      const refused = succeeded ? [] : deferred ? requested : hasDetails ? reported("refusedDroneIDs")
        : isDefiniteCompanionRefusal(error) ? requested : [];
      const accepted = succeeded ? requested : hasDetails
        ? reported("acceptedDroneIDs").filter((id) => !refused.includes(id)) : [];
      const uncertain = requested.filter((id) => !accepted.includes(id) && !refused.includes(id));
      const merge = (previous: readonly number[], next: readonly number[]): number[] =>
        [...new Set([...previous.filter((id) => !requested.includes(id)), ...next])];
      const refusals: Record<number, number> = { ...pending.refusals };
      if (!deferred) for (const id of refused) refusals[id] = (refusals[id] ?? 0) + 1;
      mem.ladder = { ...mem.ladder, [field]: { ...pending, pending: false, refusals,
        deferrals: deferred ? pending.deferrals + 1 : 0, deferralWait: deferred,
        acceptedIDs: merge(pending.acceptedIDs, accepted), refusedIDs: merge(pending.refusedIDs, refused),
        uncertainIDs: merge(pending.uncertainIDs, uncertain),
      } };
      return;
    }
  }

  // A job-over recall that failed is not one to wait on. The ladder recorded it
  // when it chose the call, and this is the one place that knows the call did
  // not land (seen live 2026-10-12: a first recall refused CHARACTER_IN_USE).
  // Dropped, the next tick sends it again instead of after the half-minute.
  function forgetFailedJobOverRecall(decision: CompanionDecision): void {
    const held = decision.memory.jobOverRecall;
    if (decision.action.kind === "recallDrones" && held !== null && mem.ladder.jobOverRecall === held) {
      mem.ladder = { ...mem.ladder, jobOverRecall: null };
    }
  }

  // A job's launch that failed is not one to wait on, for the same reason.
  function forgetFailedDroneLaunch(decision: CompanionDecision): void {
    const held = decision.memory.droneLaunch;
    if (decision.action.kind === "launchDrones" && held !== null && mem.ladder.droneLaunch === held) {
      mem.ladder = { ...mem.ladder, droneLaunch: null };
    }
  }

  async function tickBody(): Promise<FleetCompanionAction> {
    if (mem.status !== "running") {
      return { kind: "wait" };
    }
    const token = runToken;
    seq += 1;
    const tickSeq = seq;
    let obs: FleetCompanionObservation;
    const observeStartedMs = deps.now?.() ?? Date.now();
    try {
      obs = await deps.observe();
      recorder.observed((deps.now?.() ?? Date.now()) - observeStartedMs);
    } catch (error) {
      if (token !== runToken || mem.status !== "running") {
        return { kind: "wait" };
      }
      // A read that fails is not a licence to act on the last one: nothing is
      // decided against stale state. But a connection that dropped says
      // nothing about the ship, so that kind waits and reads again, and only a
      // streak longer than the grace -- or a failure that is not the
      // connection -- stops the run.
      const nowMs = deps.now?.() ?? Date.now();
      if (mem.readFailing === null || mem.readFailing.token !== token) {
        mem.readFailing = { sinceMs: nowMs, token };
      }
      const transient = isTransportTransient(error) || isTransitionTimeout(error);
      // No rung ran on this tick, so no trace stands for it.
      mem.trace = null;
      if (transient && nowMs - mem.readFailing.sinceMs < FLEET_COMPANION_READ_GRACE_MS) {
        mem.phase = "Reconnecting";
        mem.action = null;
        mem.why = "The game server is not answering. Reading the ship again.";
        report(tickSeq);
        return { kind: "wait" };
      }
      // ⚠ THE SENTENCE IS THE ONE THE PANEL SHOWS, so it is player language
      // (R9a): the raw message named the gateway, which a player cannot act on.
      mem.status = "error";
      mem.failureReason = transient
        ? `The game server did not answer for a minute, so this pilot stopped: ${panelErrorWords(error)}`
        : `This pilot stopped because its ship could not be read: ${panelErrorWords(error)}`;
      mem.why = "Could not read the ship.";
      mem.action = null;
      mem.readFailing = null;
      report(tickSeq);
      return { kind: "wait" };
    }
    if (token !== runToken || mem.status !== "running") {
      return { kind: "wait" };
    }
    mem.readFailing = null;
    // ⚠ A SCENE THAT ANSWERS BUT CANNOT BE SEEN IS NOT A SCENE THAT FAILED, AND
    // ROW 13'S GRACE DID NOT COVER IT: `observe()` returned, so nothing threw. The
    // ladder waits on it (the blind rung); this is the clock that ends the wait.
    // A warp is not counted -- the ladder yields to it and the scene returns on
    // landing.
    if (obs.sceneBlind === true && obs.inWarp !== true) {
      const nowMs = deps.now?.() ?? Date.now();
      if (mem.sceneBlind === null || mem.sceneBlind.token !== token) {
        mem.sceneBlind = { sinceMs: nowMs, token };
      }
      const blindMs = nowMs - mem.sceneBlind.sinceMs;
      if (blindMs >= FLEET_COMPANION_READ_GRACE_MS) {
        // ⚠ AN ERROR, NOT A STOP, so the roster's auto-restart (row 14) is allowed
        // to try. It only starts a new loop on the SAME bridge session -- it does
        // not re-log the pilot -- so what recovers a dead park is the sentence's
        // own advice, until the BFF re-binds the session itself.
        mem.status = "error";
        mem.failureReason = `Lost sight of space for ${Math.round(blindMs / 1000)} s: reload the page or dock and undock to recover.`;
        mem.why = "Could not see space.";
        mem.action = null;
        mem.trace = null;
        mem.sceneBlind = null;
        report(tickSeq);
        return { kind: "wait" };
      }
    } else {
      mem.sceneBlind = null;
    }
    // The readout fields the observation already answers. Cheap, and it keeps
    // the badge honest without a second read.
    mem.inFleet = obs.inFleet ?? null;
    mem.canTag = obs.canTag;
    // The request is set by start() before the status can become "running", so
    // this fallback is unreachable in practice — it exists so the ladder's
    // signature needs no optional request and no cast.
    const known = withoutModules(mem.request ?? DEFAULT_FLEET_COMPANION_REQUEST, obs, passiveModuleIDs);
    const request = known.request;
    const decision = decideCompanionAction(request, known.obs, mem.ladder, deps.now?.() ?? Date.now());
    // ⚠ STORE THE MEMORY BEFORE ANYTHING ELSE CAN RETURN. The ladder is pure,
    // so a decision whose memory is dropped silently un-does whatever that tick
    // learned — the safe-spot warp it just issued, or the humans it just saw.
    mem.ladder = decision.memory;
    mem.phase = decision.phase;
    mem.why = decision.why;
    mem.action = decision.action.kind;
    // ⚠ "own-ladder" IS THE DEFAULT, NOT `null`. Every rung except rung 7
    // (obeying the fleet) leaves these two fields unset on its decision, and
    // that omission means "this pilot is not obeying an external order" —
    // the warp yield, the supervision gate, the abandonment protocol and
    // "Standing by" are all the companion's own ladder, not a fleet order.
    mem.followingOrderFrom = decision.followingOrderFrom ?? "own-ladder";
    mem.lastOrderHeard = decision.lastOrderHeard ?? null;
    mem.trace = decision.trace ?? null;
    // The decision is logged before anything it sends, so the log reads in order.
    // ⚠ A TICK THAT ISSUES ALWAYS WRITES ITS `decide` LINE, changed or not, so
    // every `issue` and `result` has the decision of the same `seq` beside it.
    recorder.progress(snapshot(), { seq: tickSeq, force: decision.action.kind !== "wait" });
    if (decision.say !== undefined && deps.say !== undefined) {
      void sayInOrder(deps.say, decision.say);
    }
    if (decision.pause !== undefined) {
      runToken += 1;
      mem.status = "paused";
      mem.selfPaused = true;
      mem.action = null;
      mem.failureReason = decision.pause;
      report(tickSeq);
      return { kind: "wait" };
    }
    if (decision.stop !== undefined) {
      // The ladder has decided the run is over. Not `stop()`: that clears the
      // readout, and the whole value of these two endings is the sentence that
      // says which one happened. Bump the token the same way stop() does, so a
      // tick already in flight cannot land after this one.
      runToken += 1;
      mem.status = "stopped";
      mem.action = null;
      mem.failureReason = decision.stop;
      report(tickSeq);
      return { kind: "wait" };
    }
    if (decision.action.kind !== "wait") {
      recorder.issue(decision.action, decision.phase, decision.why, tickSeq);
      try {
        await deps.issue(decision.action);
        recorder.result(true, undefined, { seq: tickSeq });
        settleAlignment(decision, "issued");
        settleFollow(decision, true);
        settleRejoin(decision, true);
        settleCombatPosition(decision, true);
        settleDroneEngagement(decision, true);
      } catch (error) {
        recorder.result(false, error, { seq: tickSeq, verdict: companionVerdict(error) });
        // ⚠ A REFUSED CALL IS AN ANSWER, NOT THE END OF THE RUN. This used to
        // propagate: the rejection came out of `tick`, out of `run`, and landed
        // on a `void run()` in flow.ts as an UNHANDLED PROMISE REJECTION. The
        // loop stopped dead while `mem.status` still said "running", so the
        // panel went on showing a flying pilot that had in fact stopped
        // ticking. Reported live 2026-09-11 as a script error the page raised:
        // "TargetNotWithinRangeGeneric", twice, and the page stopped updating.
        //
        // A definite refusal and a lost transport response are different: the
        // latter may follow a committed write. Each action keeps its pending
        // state and retry budget, and an unknown outcome is resent, not paused on.
        // A refused lock can still land once the ship drifts closer.
        //
        // ⚠ THE SERVER'S OWN WORDS NEVER REACH THE PLAYER. A refusal arrives as
        // its retail error-class name (`TargetNotWithinRangeGeneric`), which is
        // raw vocabulary; `refusalWords` says what it means in plain language
        // instead. The raw text is kept on `failureReason`, which is diagnostic
        // rather than prose.
        settleAlignment(decision, isDefiniteCompanionRefusal(error) ? "refused" : "uncertain");
        settleFollow(decision, false, error);
        settleRejoin(decision, false, error);
        settleCombatPosition(decision, false, error);
        settleDroneEngagement(decision, false, error);
        forgetFailedJobOverRecall(decision);
        forgetFailedDroneLaunch(decision);
        if (token !== runToken || mem.status !== "running") {
          return { kind: "wait" };
        }
        const raw = error instanceof Error ? error.message : String(error);
        mem.failureReason = raw;
        mem.why = `${decision.why} ${refusalWords(raw, isDefiniteCompanionRefusal(error))}`;
        // ⚠ NO PAUSE HERE ANY MORE FOR AN UNCONFIRMED FOLLOW, DRONE OR ALIGN
        // ORDER. The settle calls above have already recorded the outcome as
        // "uncertain"; the ladder reads that on its next tick and resends the
        // order after `COMPANION_RESEND_WAIT_TICKS`. Each of these orders is
        // standing state that a second copy lands on harmlessly -- see that
        // constant -- so parking the pilot for an operator bought nothing but a
        // stopped companion in the middle of whatever the stall interrupted.
        // ⚠ COUNTED HERE, WHERE THE REFUSAL IS, AND NOWHERE ELSE. The ladder is
        // pure and never learns what happened to a call it chose; this is the
        // one place that knows. Lock refusals have their own bound because the
        // authoritative lock list is consulted rather than believed, so a
        // refused lock never reads as done.
        // A pre-lock was asked once and is already recorded as asked; its
        // refusal is not the ship's (`CompanionDecision.preLock`).
        if (decision.action.kind === "lock" && decision.preLock !== true) {
          mem.ladder = noteRefusedLock(mem.ladder, decision.action.targetID);
        }
        // A module the server says cannot be activated at all is passive for the
        // rest of the run: never chosen again (see `withoutModules`).
        // A load the server refused is not reloading anything: see `noteRefusedReload`.
        if (decision.action.kind === "loadAmmo" && isDefiniteCompanionRefusal(error)) {
          mem.ladder = noteRefusedReload(mem.ladder, decision.action.moduleIDs);
        }
        if (decision.action.kind === "activate" && isNotActivatableRefusal(error)) {
          passiveModuleIDs = new Set([...passiveModuleIDs, decision.action.moduleID]);
        }
        if (decision.action.kind === "warp" &&
          (decision.phase === "Getting safe" || decision.phase === "Getting clear") &&
          isDefiniteCompanionRefusal(error)) {
          mem.ladder = noteEscapeWarpRefusal(mem.ladder);
        }
        if ((decision.action.kind === "activate" && request.remoteShieldModuleIDs.concat(
          request.remoteArmorModuleIDs, request.remoteCapacitorModuleIDs,
        ).includes(decision.action.moduleID)) || decision.action.kind === "lock") {
          mem.ladder = noteHealFailure(mem.ladder, decision.action, error);
        }
        report(tickSeq);
        return { kind: "wait" };
      }
    }
    if (token !== runToken || mem.status !== "running") return { kind: "wait" };
    report(tickSeq);
    return decision.action;
  }

  function tick(): Promise<FleetCompanionAction> {
    if (activeTick !== null) return activeTick;
    const pending = tickBody();
    const shared = pending.finally(() => {
      if (activeTick === shared) activeTick = null;
    });
    activeTick = shared;
    return shared;
  }

  return {
    start(next: FleetCompanionRequest, resuming: CompanionAbandonmentRecord | null = null): void {
      recorder.start();
      seq = 0;
      passiveModuleIDs = new Set();
      mem = freshMemory();
      mem.status = "running";
      mem.request = next;
      mem.phase = "Standing by";
      if (resuming !== null) {
        // A restart re-enters an abandonment already under way, keeping its
        // ORIGINAL clock. The get-safe flags start false on purpose: whatever
        // warp was in flight when the process died is not a warp this run has
        // observed, and claiming it had landed would let the next tick drop
        // fleet with the ship still sitting in space.
        mem.ladder = {
          standingChatCursor: null,
          alignmentOrder: null,
          healOrder: null,
          lastSupervisorIDs: [...resuming.supervisorCharacterIDs],
          abandonment: {
            abandonedAtMs: resuming.abandonedAtMs,
            supervisorCharacterIDs: [...resuming.supervisorCharacterIDs],
            safeSpotWarpIssued: false,
            safeSpotWarpAttempts: 0,
            safeSpotWarpWaited: 0,
            safeSpotWarpSeen: false,
            // A restart cannot know about a recall the dead process issued, and
            // the server has already abandoned whatever was out when the session
            // dropped. Starting at null means this run makes its own one attempt.
            droneRecallWaited: null,
          },
          closingOn: null,
          closingOnAtMs: null,
          // A resumed run has ordered no drones and looted nothing either: the
          // drones the dead process had out were abandoned by the server on the
          // session drop, and a wreck this run has not emptied is a wreck it
          // must be willing to try.
          lastDroneRepairTargetID: null,
          lastDroneRepairIDs: [],
          lastDroneEngageTargetID: null,
          lastDroneEngageIDs: [],
          combatDroneOrder: null,
          repairDroneOrder: null,
          lastSalvageOrderedFor: null,
          salvageDronesWreckID: null,
          lootedItemIDs: [],
          lootApproaching: null,
          lootApproachAtMs: null,
          lootTargetID: null,
          salvageWreckID: null,
          salvageLockIssued: false,
          salvageLockWaited: 0,
          salvageApproachIssued: false,
          salvageApproachAtMs: null,
          areaJob: null,
          lastWarpedToID: null,
          orderedLeaveRecall: null,
          // A resumed run has tanked up, locked, healed and routed nothing yet
          // either — same reasoning as the get-safe flags just above: this run
          // has not issued any of those calls, so it must not assume one
          // already landed. A restart mid-fight simply re-lights whatever is
          // still off on its first live tick.
          lastTankUpModuleIDs: [],
          lastLockIssuedFor: null,
          lastFireTargetID: null,
          lastFireModuleIDs: [],
          gunAimedAt: {},
          gunStops: [],
          targetCall: null,
          gateCall: null,
          lastHealTargetID: null,
          lastHealModuleIDs: [],
          lastRoutedSystemID: null,
          lastTagIssuedFor: null,
          lastTagAttempts: 0,
          taggingGaveUpOn: [],
          tackleCalledOut: [],
          tackleCalledAtMs: {},
          lockRefusedFor: null,
          lockRefusals: 0,
          lockGaveUpOn: [],
          lockPending: null,
          preLocked: [],
          // A resumed run has launched and recalled nothing either, and a
          // rotation it was mid-way through is gone with the process that held
          // it. Its drones, if any, are already abandoned in space - that is
          // the server's own doing on a session drop, not something a restart
          // can undo - so the honest state is "no rotation", not a
          // half-remembered one.
          droneRotation: emptyDroneRotationMemory(),
          droneSizeSwitchAtMs: null,
          droneSizeRecalledIDs: [],
          droneAssistLit: [],
          jobOverRecall: null,
          droneLaunch: null,
      // Run-local, both of them. See `CompanionFlee`'s header for why a flee is
      // not persisted the way an abandonment is: a companion coming back up
      // reads its own health on the first tick and leaves again within one tick
      // if it still needs to.
      flee: null,
      shipLost: null,
      fleeTripsSpent: 0,
      fleeRecoverySinceMs: null,
          // ⚠ A RESUMED RUN IS NOT FOLLOWING ANYBODY AND IS NOT ON A TRIP, and
          // that is the honest answer rather than a lossy one. Nothing about a
          // `keepAtRange` survives the process that sent it: the server may well
          // still be holding the ship at station, but this run has not observed
          // that and must not claim it -- so the anchor record starts empty and
          // the first live tick re-issues, which costs one call. The trip is a
          // harder case and goes the same way: the shared autopilot died with
          // the process, so a destination carried across would be a job with
          // nothing flying it. The range latch resets to the default for the
          // same reason -- the `follow 10 km` that set it is long out of the
          // chat window and cannot be re-heard.
          followRangeM: COMPANION_FOLLOW_RANGE_M,
          followHeld: false,
          followAnchorID: null,
          followRangeIssuedM: null,
          followOrder: null,
          // No rejoin warp went out from this run.
          rejoin: null,
          destinationSystemID: null,
          destinationRoutedFor: null,
          stopHeardAtMs: null,
          stopShipIssued: false,
          // ⚠ THE PROPULSION OVERRIDE RESETS TO `null`, NOT TO WHAT WAS HELD, for
          // the same reason the follow range just above it does: the `props on`
          // that set it is long out of the chat window and cannot be re-heard, so
          // carrying it would be a standing order nobody can see or countermand.
          // `null` hands the decision back to the travel test, which the first
          // live tick answers from the autopilot itself.
          propsHeld: null,
          propsStoppingID: null,
          // Back to "called" for the same reason: a `targets all` nobody can
          // re-hear is free fire nobody can see, and the safe mode is the one
          // a pilot may hold without anybody having asked for it.
          targetMode: "called",
          // ⚠ "follow" FOR THE REASON `followRangeM` RESETS: the `flight auto`
          // that set it is long out of the chat window and cannot be re-heard, so
          // carrying it would be a pilot breaking formation on an order nobody
          // can see. And no positioning order survives the process that sent it.
          flightMode: "follow",
          combatPosition: FRESH_COMBAT_POSITION,
          weaponReach: null,
          // A resumed run has loaded nothing either. Starting the budget empty
          // is the generous answer and the right one: the dead process's loads
          // may well have landed, and if they did, the first live tick sees
          // those guns absent from `emptyWeaponModuleIDs` and spends nothing.
          // If they did not, this run gets its own full budget rather than
          // inheriting a give-up it never measured.
          reloadAttempts: {},
          // A resumed run switched nothing on: whatever is running is not its own.
          utilities: FRESH_COMPANION_UTILITIES,
          // No swap is in flight in a run that has issued none.
          ammo: FRESH_COMPANION_AMMO,
          repairOrderedAtMs: null,
          supply: FRESH_COMPANION_SUPPLY,
        };
      }
      runToken += 1;
      report();
    },
    pause(): void {
      if (mem.status === "running") {
        // A resumed run gets a new driver. Retire a driver that is still
        // awaiting its observation or cadence timer before status changes.
        runToken += 1;
        mem.status = "paused";
        mem.selfPaused = false;
        report();
      }
    },
    resume(): void {
      if (mem.status === "paused") {
        mem.status = "running";
        mem.selfPaused = false;
        // Rung 8a owns nothing across a pause: the operator may have taken the
        // rack in hand meanwhile, and what is running now is theirs.
        mem.ladder = { ...mem.ladder, utilities: FRESH_COMPANION_UTILITIES };
        report();
      }
    },
    stop(): void {
      // Bump the token so a tick already in flight cannot land after the stop.
      runToken += 1;
      mem.status = "stopped";
      mem.phase = null;
      mem.action = null;
      mem.why = null;
      mem.trace = null;
      report();
    },
    beginGracefulStop(): Promise<void> {
      runToken += 1;
      mem.status = "paused";
      mem.selfPaused = false;
      mem.phase = "Recalling drones";
      mem.why = "Stopping after controlled drones return.";
      mem.action = null;
      report();
      return activeTick?.then(() => undefined) ?? Promise.resolve();
    },
    tick,
    /**
     * ⚠ THIS MUST NOT BE ABLE TO REJECT, and it is started with `void` at every
     * call site, which is exactly why. A rejection out of here reaches the
     * window as an unhandled promise rejection: the run is over, nothing says
     * so, and `mem.status` still reads "running" -- which is the shape of the
     * failure reported live on 2026-09-11. `tick` already swallows the two
     * things that can realistically throw (a failed read, a refused write), so
     * anything caught HERE is a defect in this file rather than an answer from
     * the server. It stops the run, because a ladder that threw cannot be
     * trusted to keep deciding -- but it stops it VISIBLY, in the readout the
     * panel is already watching, instead of in the console.
     */
    run(): Promise<void> {
      const token = runToken;
      if (activeDriver?.token === token) {
        return activeDriver.promise;
      }
      const previousTick = activeTick;
      const pending = (async (): Promise<void> => {
        try {
          // An already dispatched write cannot be cancelled by pausing.
          // Let that tick settle before a replacement driver issues anything.
          if (previousTick !== null) await previousTick;
          while (mem.status === "running" && token === runToken) {
            const action = await tick();
            if (mem.status !== "running" || token !== runToken) {
              break;
            }
            // An issued call takes the burst beat; an idle tick takes the
            // full cadence, preserving the ladder's tick-counted waits.
            await deps.sleep(
              action.kind === "wait" ? FLEET_COMPANION_CADENCE_MS : FLEET_COMPANION_BURST_MS,
            );
          }
        } catch (error) {
          if (token !== runToken) {
            return;
          }
          mem.status = "error";
          mem.failureReason = error instanceof Error ? error.message : String(error);
          mem.why = "This pilot stopped: something went wrong in its own decisions.";
          mem.action = null;
          report();
        }
      })();
      const tracked = pending.finally(() => {
        if (activeDriver?.promise === tracked) activeDriver = null;
      });
      activeDriver = { token, promise: tracked };
      return tracked;
    },
    snapshot,
  };
}
