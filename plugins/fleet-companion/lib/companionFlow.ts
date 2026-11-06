// A pilot's fleet companion, on any pilot's session: the tick's reads and writes around the
// loop (fleetCompanionLoop.ts). The same code flies in a browser tab and in this plugin's
// backend (runs.ts).

import { type SpaceSnapshot } from "../../../web/src/plugin-api/blocks.ts";
import { AUTOMATIC_UTILITY_FAMILIES, FLEET_BROADCAST_SCOPE_ALL, FLEET_BROADCAST_TTL_MS, acceptFleetInvite as acceptFleetInviteCall, applyFitting, authoritativeFleetMemberCharacterIDs, buildSlots, canBroadcastInFleet, canMyShipOrderDrone, canTagInFleet, combatFit, combatUtilityFit, decodeChargeFits, decodeChatChannel, decodeContainer, decodeDroneBay, decodeDroneLimits, decodeFleetCenter, decodeFlightStatus, decodeInventoryRows, decodeShipBays, decodeSpaceSnapshot, decodeTargetIDs, defense, droneStackSizes, evaluateRequirements, fleetCommanderCharacterIDs, fleetCommanderWhereabouts, hostileRows, isFleetBroadcastFresh, isSceneBlind, isTargetedByPlayer, known, leaveFleet as leaveFleetCall, lockTarget as lockTargetCall, lowestHealth, moveItems as moveItemsCall, nameKey, officeAt, repairItemsAtShop, repairTargets, returnDronesToBay, salvageWithDrones, scrammedByWarpScrambler, slotFlagOf, splitDroneRoles, tacklersHolding, tagFleetTarget, type CombatUtilities, type CombatWeapons, type DroneRoleIDs, type FleetCenterSnapshot, undock as undockCall, warpToFleetMember as warpToFleetMemberCall, wholeStackLaunch } from "../../../web/src/plugin-api/flying.ts";
import type { ShipBay } from "../../../web/src/plugin-api/flying.ts";
import { CHARGE_ATTRIBUTE_IDS, chargeFactsFromAttributes, type ChargeFacts } from "./ammoReach.ts";
import { WEAPON_CYCLE_ATTRIBUTE_IDS, type WeaponCycleFacts, weaponCycleFromAttributes } from "./companionAmmo.ts";
import { companionFitWarnings, requestForFit, type CompanionFitFacts } from "./companionFitCheck.ts";
import { pickRearmFitting, planCorpFetch, rearmFitParts, rearmNeeds, rearmReport, sumOfType, type RearmCorpMove } from "./companionRearm.ts";
import { DRONE_SIZING_ATTRIBUTE_IDS, droneFactsFromAttributes, type DroneFacts } from "./droneSizing.ts";
import { createFleetCompanion, type CompanionAbandonmentRecord, type CompanionCargoCharge, type CompanionLoadedCharge, type CompanionSetup, type CompanionTankLayer, type FleetCompanionController, type FleetCompanionDeps, type FleetCompanionObservation, type FleetCompanionRequest } from "./fleetCompanionLoop.ts";
import { FLEET_COMPANION_REQUIREMENTS, type FleetCompanionReads } from "./fleetCompanionRequirements.ts";
import { voteTankLayer } from "./tankLayer.ts";
import type { AppFlow } from "../../../web/src/plugin-api/index.ts";
import type { ShipHold } from "../../../web/src/plugin-api/flying.ts";
import { COMPANION_OWNER, applyCompanionEvent } from "./companionState.ts";
import type { CompanionStandingOrders } from "./fleetCompanionLoop.ts";
import * as api from "../../../web/src/plugin-api/flying.ts";
import { errorWords, isSessionLost, type ClientStore } from "../../../web/src/plugin-api/flying.ts";

const callOptionsOf = (flow: AppFlow) => flow.requestOptions();
const droneFactsByTypeID = new Map<number, DroneFacts | null>();
// Charges are this category of the static data.
const CHARGE_CATEGORY_ID = 8;

export function createCompanionFlow(store: ClientStore, flow: AppFlow) {
  const callOptions = callOptionsOf(flow);
  let shipHold: ShipHold | null = null;
  /** A fleet member warped to by the page's own call (bridge/movementWrites.ts), by the pilot's number, for the fleet companion. */
  async function warpToMember(characterID: number): Promise<void> {
    await warpToFleetMemberCall(flow.flying.bridgeDo, flow.flying.readFlightNow, characterID);
  }
  /**
   * The companion's own per-tick world read.
   *
   * ⚠ THIS IS NOT THE SCRIPT RUNNER'S `observe(hint)`, AND IT CANNOT BE. That
   * builder gates almost every read on which MACRO is active — surveys on
   * `SURVEY_MACROS`, scanner ops on `SCANNER_MACROS`, the squad primary on
   * `hint.squadRole`, the fleet roster on `FLEET_SUPPORT_MACROS`. The companion
   * has no active macro, so every one of those gates would read nothing, and
   * threading a fake macro id through to trip them would couple the companion to
   * the DSL it is deliberately not part of.
   *
   * So the reads are UNCONDITIONAL here, and what is reused is the layer that
   * actually generalises: the decoders. Same `decodeFlightStatus`,
   * `decodeSpaceSnapshot`, `decodeFleetCenter`, `hostileRows`, `lowestHealth`
   * the script runner uses — just called without a macro deciding whether to.
   */
  /**
   * The companion's own hull-bay cache, for the `loot` chat order.
   *
   * ⚠ A SECOND CACHE, NOT A SECOND ROUTING RULE, AND THE DIFFERENCE MATTERS.
   * The actual work is `flow.flying.lootIntoShip` -- the one implementation the Overview's
   * "Take everything" and every scripted bot also go through -- so a companion
   * cannot fill a different hold than a player would. What is duplicated here is
   * only the question "which bays does this hull have", because the script
   * runner answers it off its own `capabilityCache`, which is DSL machinery this
   * loop deliberately does not have (the same reason it builds its own
   * observation instead of reusing `observe(hint)`).
   *
   * ⚠ AND THE ROUTING IS THE WHOLE POINT OF GOING THROUGH IT. Every bay this
   * hull has is offered the loot first; only what nothing will take falls to
   * ship cargo. Looting straight into cargo would be wrong on any hull with a
   * specialised bay.
   *
   * Keyed on the hull, because what bays a ship has is a property of the ship
   * and not of the moment. Fill level is deliberately never cached: the server
   * rules on room, and a refused bay spills into cargo.
   */
  let companionBayCache: { readonly shipID: number; readonly bays: readonly ShipBay[] } | null =
    null;
  /**
   * What the `loot` order has finished with: cans it emptied, and cans it tried
   * enough times without emptying.
   *
   * ⚠ THE RUNG USED TO MARK A CAN DONE THE MOMENT IT ASKED, and throw the
   * outcome away. `flow.flying.lootIntoShip` returns how many stacks it found and how many
   * it actually moved, and those differ constantly: each stack is routed to the
   * bay that will take it, and what fits nowhere STAYS IN THE CAN. So a pilot
   * took one stack of three, recorded the can as looted, and flew off -- seen
   * live twice ("flew to can, and nothing or 1 item only looted").
   *
   * ⚠ AND IT IS BOUNDED, because "it did not all fit" can be permanent. A hold
   * with no room for what is left would otherwise have the pilot re-open the
   * same can for the rest of the run. After MAX_LOOT_ATTEMPTS it is set aside --
   * not emptied, but finished with.
   */
  /**
   * This companion's own ship, from the snapshot it reads every tick.
   *
   * ⚠ `store.inventory.activeShipID` IS NOT AVAILABLE TO THIS LOOP. The
   * inventory slice is filled by the Inventory panel's own reads, which a
   * companion never makes -- so it is null for the whole run. `companionLootFrom`
   * asked it for the ship id, got null, and returned without doing ANYTHING:
   * no loot call, no error, no attempt counted. The rung re-issued the same
   * `lootContainer` every two seconds and the pilot sat next to a can for ever
   * (observed live, 2026-09-11). The snapshot has the ship in it; ask that.
   */
  let companionShipID: number | null = null;
  const companionLootAttempts = new Map<number, number>();
  const companionLootFinished = new Set<number>();
  const MAX_LOOT_ATTEMPTS = 3;
  /**
   * What OTHER pilots have already emptied, from the BFF's shared loot memory
   * (src/lootMemory.js), refreshed on a slow beat while there is anything
   * lootable on the grid.
   *
   * ⚠ THIS IS THE HALF `companionLootFinished` CANNOT COVER. That set is this
   * pilot's own record, and every companion keeps its own -- so a fleet of four
   * sends four ships to the same wreck, three of them arriving at a hold that
   * the first one already emptied. Nothing in the snapshot says a wreck is empty
   * (the slim item's `isEmpty` never reaches a web session), so the only pilot
   * who can answer is one that flew there, and this is where the answer is
   * shared.
   *
   * ⚠ IT IS ONLY EVER ADDED TO, NEVER TRUSTED TO BE COMPLETE. A wreck missing
   * from it is "nobody has said", never "it has loot" -- which is exactly how
   * the ladder already treats an unknown can, so a failed read costs a wasted
   * approach and never a skipped one.
   */
  const companionSharedEmpty = new Set<number>();
  let companionSharedEmptyReadAtMs = 0;
  // Slower than the tick, because a shared mark is worth having within a few
  // seconds and never within one: at worst a pilot sets off for a can that was
  // emptied while it was reading, notices on arrival, and marks it itself.
  const COMPANION_LOOT_MEMORY_READ_MS = 6_000;

  async function refreshCompanionSharedEmpty(
    snapshot: SpaceSnapshot | null,
    nowMs: number,
  ): Promise<void> {
    const solarSystemID = snapshot?.solarSystemID ?? null;
    if (
      solarSystemID === null ||
      nowMs - companionSharedEmptyReadAtMs < COMPANION_LOOT_MEMORY_READ_MS ||
      // No wreck and no can on this grid: nothing this answer could be used on,
      // so the read is not made at all. Same rule as the gated drone-bay read.
      !(snapshot?.entities ?? []).some(
        (entity) => entity.kind === "wreck" || entity.kind === "container",
      )
    ) {
      return;
    }
    companionSharedEmptyReadAtMs = nowMs;
    try {
      for (const itemID of await api.readEmptiedContainers(solarSystemID, callOptions)) {
        companionSharedEmpty.add(itemID);
      }
    } catch {
      // Unreadable is "nobody has said", which is what an empty set already
      // means here. A companion never stops looting because the board is down.
    }
  }

  async function companionLootFrom(containerID: number): Promise<void> {
    // ⚠ COUNTED BEFORE ANYTHING CAN RETURN EARLY. Every path out of this
    // function has to count as an attempt, or a path that does nothing becomes
    // a rung that asks for ever -- which is exactly what the `activeShipID`
    // early return did.
    const attempts = (companionLootAttempts.get(containerID) ?? 0) + 1;
    companionLootAttempts.set(containerID, attempts);
    if (attempts >= MAX_LOOT_ATTEMPTS) {
      companionLootFinished.add(containerID);
    }
    const shipID = companionShipID ?? store.inventory.get().activeShipID;
    if (shipID === null) {
      return;
    }
    if (companionBayCache === null || companionBayCache.shipID !== shipID) {
      try {
        companionBayCache = {
          shipID,
          bays: decodeShipBays((await api.getShipBays(shipID, callOptions)).bays),
        };
      } catch {
        // Unreadable is not "no bays", but for ROUTING it has to behave like it:
        // the only safe destination for a hull we cannot describe is cargo.
        companionBayCache = { shipID, bays: [] };
      }
    }
    try {
      const outcome = await flow.flying.lootIntoShip(containerID, companionBayCache.bays, shipID);
      // Emptied is the only clean finish: every stack it found, it moved.
      if (outcome.moved >= outcome.stacks) {
        companionLootFinished.add(containerID);
      }
    } catch {
      // ⚠ SOME CONTAINERS SIMPLY CANNOT BE OPENED. A can 316 m away answered
      // `FakeItemNotFound` on every try (observed live) -- the id is on the grid
      // but the inventory service does not recognise it. Nothing here can fix
      // that, so the attempt bound above is what stops it mattering: the can is
      // set aside and the pilot gets on with the next one.
    }
  }

  /**
   * How many drones each bay STACK holds, from the last bay read.
   *
   * ⚠ THE LADDER DEALS IN STACK IDS AND KNOWS NOTHING OF QUANTITY, deliberately
   * -- it decides WHICH stacks fly, which is a judgement; how many are in one is
   * a fact about the bay that belongs to the layer that read it. Without this
   * the dispatcher fell back to `quantity: 1` and launched ONE drone per stack,
   * so a pilot carrying five identical drones (one stack) put out one. Observed
   * live 2026-09-11: a bay of three launched one.
   *
   * ⚠ THE SHIP'S CONTROL LIMIT IS THE SERVER'S JOB, NOT OURS.
   * `launchDronesForSession` stops at `maxActiveDrones` by itself, so asking for
   * the whole stack is safe: it launches what it can and ignores the rest.
   */
  let companionDroneStackSizes: ReadonlyMap<number, number> = new Map();

  /** What the last `rearmShip` came to, handed to the next tick's observation. */
  let companionRearmOutcome: { readonly orderedAtMs: number; readonly lines: readonly string[] } | null = null;

  /**
   * The `rearm` order's docked work, as a pilot does it at the fitting window:
   * the saved fitting the ship was built to (companionRearm.ts picks it), what
   * the hold and the drone bay lack of its charges and drones, the corporation's
   * stock of it moved into the hangar where the pilot's own falls short, and
   * then Fit Ship -- the client's `FitFitting`, which loads only the difference.
   * Answers the lines the pilot says, and never throws: a refusal is a line too.
   */
  async function rearmDockedShip(stationID: number): Promise<string[]> {
    const flight = decodeFlightStatus((await api.getFlightStatus(callOptions)).flight);
    const shipID = flight.shipID;
    if (!flight.docked || flight.stationID !== stationID || !shipID || flight.shipTypeID == null) {
      return ["Could not rearm: not docked at that station."];
    }
    const [library, fitReads] = await Promise.all([flow.flying.loadRefitLibrary(), api.loadFitting(callOptions)]);
    const fitted = buildSlots(fitReads.slots, fitReads.shipInfo, fitReads.online).flatMap((slot) => {
      const flagID = slotFlagOf(slot.family, slot.index);
      return slot.module !== null && flagID !== null ? [{ flagID, typeID: slot.module.typeID }] : [];
    });
    const choice = pickRearmFitting(library, flight.shipTypeID, fitted);
    if (choice.fitting === null) return [`Cannot rearm: ${choice.reason}`];
    const fitting = choice.fitting;
    const readAboard = async () => {
      const [panel, drones] = await Promise.all([api.loadInventory(callOptions), api.getDrones(callOptions)]);
      return {
        hangar: decodeInventoryRows(panel.hangar.list, panel.volumes).filter((row) => row.flagID === null || row.flagID === 4),
        cargo: decodeInventoryRows(panel.cargo.list, panel.volumes),
        // Unreadable reads as empty: the server subtracts what the bay holds itself.
        bay: decodeDroneBay(drones.bay) ?? [],
      };
    };
    const before = await readAboard();
    const needs = rearmNeeds(fitting, before.cargo, before.bay);
    // The corporation's stock, read only when the pilot's own hangar falls short.
    let divisions: { division: number; rows: ReturnType<typeof decodeInventoryRows> }[] = [];
    const short = needs.some((need) => need.missing > sumOfType(before.hangar, need.typeID));
    if (short) {
      try {
        const corp = await api.loadCorpHangar(callOptions);
        divisions = corp.available
          ? corp.divisions.map((division) => ({ division: division.division, rows: division.list === null ? [] : decodeInventoryRows(division.list) }))
          : [];
      } catch (error) {
        if (isSessionLost(error)) throw error;
      }
    }
    const stocked = (typeID: number): number =>
      sumOfType(before.hangar, typeID) + divisions.reduce((sum, division) => sum + sumOfType(division.rows, typeID), 0);
    const moved: RearmCorpMove[] = [];
    const fetch = planCorpFetch(needs, before.hangar, divisions);
    if (fetch.length > 0) {
      const officeID = await officeAt(flow.flying.bridgeAsk, stationID);
      for (const move of officeID === null ? [] : fetch) {
        const row = divisions.find((division) => division.division === move.division)?.rows.find((r) => r.itemID === move.itemID);
        if (row === undefined) continue;
        try {
          await moveItemsCall(flow.flying.bridgeDo, "hangar", { kind: "hangar" }, officeID!, [row], move.wholeStack ? null : move.quantity);
          moved.push(move);
        } catch (error) {
          if (isSessionLost(error)) throw error;
          // A division this pilot may not take from: what it held is short below.
        }
      }
    }
    const stocking = moved.length > 0 ? await readAboard() : before;
    const parts = rearmFitParts(fitting, needs, stocking.hangar);
    if (parts !== null) {
      await applyFitting(flow.flying.bridgeDo, { shipID, typeID: flight.shipTypeID }, stationID, {}, parts.itemsByType, parts);
    }
    const after = parts === null ? stocking : await readAboard();
    const typeIDs = needs.map((need) => need.typeID);
    try {
      await flow.flying.resolveNamesNow(typeIDs.map((id) => ({ kind: "type" as const, id })));
    } catch {
      // Unresolved names are said as unnamed items; the rearm itself stands.
    }
    const resolved = store.names.get().resolved;
    return rearmReport(
      fitting,
      needs,
      rearmNeeds(fitting, after.cargo, after.bay),
      moved,
      (typeID) => resolved[nameKey("type", typeID)] ?? null,
      stocked,
    );
  }

  /**
   * The reload rung's three facts, and the clock that rations them.
   *
   * ⚠ THROTTLED, BECAUSE EACH IS A ROUND TRIP AND NEITHER CHANGES ON A TICK'S
   * TIMESCALE. `readCompanionFitFacts` reads the fit ONCE at start, so nothing
   * the ladder sees per tick knows whether a gun still has rounds in it; that
   * is the gap this fills. Doing it every two seconds would add two calls per
   * companion per tick on the bot host for an answer that changes when a
   * magazine empties -- minutes apart, not seconds. The rung is written to
   * cost nothing on a stale answer (it confirms a load by watching the gun
   * leave this list on a LATER tick, never by the call returning), so the
   * cadence below is a cost decision and not a correctness one.
   */
  const COMPANION_AMMO_READ_INTERVAL_MS = 10_000;
  let companionAmmoReadAtMs = 0;
  let companionAmmoFacts: {
    emptyWeaponModuleIDs: readonly number[] | null;
    cargoCharges: readonly CompanionCargoCharge[] | null;
    weaponChargeGroups: Readonly<Record<number, readonly number[]>> | null;
    loadedCharges: readonly CompanionLoadedCharge[] | null;
  } = { emptyWeaponModuleIDs: null, cargoCharges: null, weaponChargeGroups: null, loadedCharges: null };
  /**
   * The hull's lock count and lock range, off the fit `readCompanionFitFacts`
   * reads at start. The lock-ahead needs the count (unreadable means it never
   * pre-locks) and free fire and the lock-ahead both need the range; neither
   * was reaching the companion's observation before, so free fire's range gate
   * was always open. `null` until a fit is read, and for a fit that said
   * nothing -- never a guess.
   */
  let companionTargeting: { maxLockedTargets: number | null; maxTargetRangeM: number | null } = {
    maxLockedTargets: null,
    maxTargetRangeM: null,
  };
  /**
   * The drone boat's leash for `flight auto`. Same read as `companionTargeting`
   * and the same rule: once, at start, off the hull and the pilot's skills;
   * `null` is "cannot say".
   */
  let companionDroneControlRangeM: number | null = null;
  /**
   * The fitted weapons with the reach of their LOADED charge (`combatFit`), for
   * the range gate and the `flight auto` rung. `null` until read, and whenever
   * the read fails -- the gate fails open on it.
   *
   * ⚠ BUILT FROM THE AMMO READ'S OWN FIT AND CARGO, AND THE DOGMA ONLY WHEN A
   * CHARGE CHANGED. Reach needs the bound dogma (`boundDogma`), which fans out
   * to about eleven gateway reads; reading it on every ammo interval tripled a
   * pilot's gateway calls, the saturation that has caused gateway timeouts
   * before. Reach moves only when a gun's loaded charge or the fit moves, so the
   * dogma is re-read only when `companionCombatChargeKey` changes.
   */
  let companionCombatWeapons: CombatWeapons | null = null;
  let companionCombatChargeKey: string | null = null;
  /**
   * The fitted combat utilities (`combatUtilityFit`) for rung 8a, built from the
   * SAME fit and the SAME bound dogma read as `companionCombatWeapons`, under the
   * same key (widened with each utility module's item, online and charge state).
   * Their `active` flags are stale by design: the rung reads what is running off
   * the snapshot every tick. `null` until read and whenever the read fails.
   */
  let companionCombatUtilities: CombatUtilities | null = null;
  /**
   * Ammo by target: each charge type aboard or loaded, and each gun type's
   * cycle, from static type dogma via `flow.flying.attributesOfTypes` (kept per type, so a
   * type costs one read ever). `null` is unread, which ranks on nothing.
   */
  let companionChargeFacts: {
    chargeFactsByTypeID: Readonly<Record<number, ChargeFacts>> | null;
    weaponCycleByTypeID: Readonly<Record<number, WeaponCycleFacts>> | null;
  } = { chargeFactsByTypeID: null, weaponCycleByTypeID: null };
  /**
   * The companion's sleep: at most `ms`, at least `COMPANION_WAKE_FLOOR_MS`,
   * ended early by a push that the ladder has something to do about.
   *
   * ⚠ THE LATCH IS CLEARED BEFORE THE PROMISE RESOLVES, not after, so a second
   * push landing in the same turn cannot resolve an already-settled promise or
   * — worse — resolve the NEXT sleep before it has begun.
   */
  function companionSleep(ms: number): Promise<void> {
    return flow.flying.sleepUntilPush(ms, (asleep) => void watchDronesWhileAsleep(asleep));
  }
  // --- waking the companion when one of its drones is hit ------------------
  //
  // ⚠ A POLL, BECAUSE THE PUSH DOES NOT REACH THE PILOTS THAT NEED IT. A drone's
  // damage arrives inside the ballpark's DoDestinyUpdate, which the BFF applies
  // to its own park and never forwards (pilots.js, SUPPRESSED_NOTIFICATIONS);
  // and only the pilot on screen holds a live stream at all (sessions.ts:
  // `livePush` is off for the rest, which share the browser's connection pool).
  // A companion is almost always one of the rest. So while it sleeps through a
  // fight it reads its own space snapshot -- the read the overview already
  // makes every second for the pilot on screen -- and wakes the moment a drone
  // that was whole on its last tick is not.
  //
  // ⚠ WHY IT MATTERS: the ladder recalls a drone on the first point of shield it
  // loses, but only when it looks. The recorder put every recall 2-4 s after the
  // tick before it (2026-10-16, 2026-10-19): the idle sleep, with the drone being
  // shot all the way through it.
  //
  // ⚠ BOUNDED THREE WAYS. Armed only on a tick that saw hostiles AND had whole
  // drones out (`companionDroneWatch`); one read in flight at a time, every
  // `DRONE_WATCH_POLL_MS`; and gone the moment the sleep ends, which a burst
  // sleep does before the first read is due. A failed read ends the watch: the
  // tick reads again anyway. Once a second: a drone's damage arrives in the
  // Destiny tick's one batch a second, so the snapshot cannot show it sooner.
  const DRONE_WATCH_POLL_MS = 1_000;
  /** This companion's own drones that were at full shield on the last tick of a fight. Empty: no watch. */
  let companionDroneWatch: readonly number[] = [];
  async function watchDronesWhileAsleep(asleep: () => boolean): Promise<void> {
    const watched = companionDroneWatch;
    const shipID = companionShipID;
    if (watched.length === 0 || shipID === null) {
      return;
    }
    while (asleep()) {
      await new Promise<void>((resolve) => setTimeout(resolve, DRONE_WATCH_POLL_MS));
      if (!asleep()) {
        return;
      }
      let hit = false;
      try {
        const snapshot = decodeSpaceSnapshot((await api.getSpaceSnapshot(callOptions)).space);
        hit = (snapshot?.entities ?? []).some((entity) =>
          watched.includes(entity.itemID) &&
          canMyShipOrderDrone(entity, shipID) === true &&
          entity.shieldRatio !== null &&
          entity.shieldRatio < 1);
      } catch {
        return;
      }
      if (hit) {
        flow.flying.announcePush();
        return;
      }
    }
  }
  function makeFleetCompanionDeps(): FleetCompanionDeps {
    return {
      observe: async (): Promise<FleetCompanionObservation> => {
        // The supervision read rides along with the other two rather than
        // queueing behind them: it is independent of both, and a companion
        // decides on a two-second cadence.
        // ⚠ THE CHAT READ IS PAID FOR ONLY BY A PILOT THAT OBEYS CHAT. It is a
        // fifth round trip on a two-second tick, and on the bot host that cost
        // is per companion per tick.
        //
        // ⚠ IT IS NO LONGER GATED, AND THE OLD GATE WAS A BUG RATHER THAN A
        // SAVING. It read chat only when the operator had ticked a channel AND
        // hand-typed at least one character id -- so the settings screen's own
        // promise that "whoever the fleet roster names a commander is obeyed
        // regardless" was false twice over: nothing consulted the roster, and
        // with an empty list the read never happened at all. A companion now
        // always listens, and the roster decides who it hears.
        const chatWanted = liveCompanionRequest !== null;
        // The drone BAY is the one thing rung 6 needs that the space snapshot
        // does not already carry, and it is a whole extra round trip per tick.
        //
        // ⚠ NO LONGER GATED ON A SETTING, BECAUSE THERE IS NO SETTING. A pilot
        // flies the drones it is carrying, so "is it carrying any" is precisely
        // what this read answers and cannot be skipped on the strength of an
        // answer nobody gave. What the snapshot gives free -- which drones are
        // out and how hurt they are -- is still built below without a call.
        const droneBayWanted = liveCompanionRequest !== null;
        const [statusStep, spaceResult, targetsResult, botDriven, chatRaw, droneRaw, fleetRaw] =
          await Promise.all([
          api.getFlightStatus(callOptions),
          api.getSpaceSnapshot(callOptions),
          // ⚠ THE LOCK LIST IS AUTHORITATIVE AND THE LADDER NEEDS IT, rather
          // than its own memory of what it last asked for. A lock the server
          // REFUSED still looks issued from in here, so a rung that stamped
          // "I locked that" and trusted the stamp would never retry —
          // permanently and silently, for the rest of the run. Reading the real
          // list every tick is what makes the fleet-order rung's already-locked
          // check honest rather than hopeful. It also says what has this ship
          // locked, which a fleet order to leave reads to know whether to wait
          // for the drones.
          api.getTargets(callOptions),
          botDrivenCharacterIDs(),
          // LOCAL, deliberately. Fleet chat is not reachable: the gateway's chat
          // service hardcodes CHAT_CHANNELS to local and corp, and its push side
          // only ever computes a local and a corp room name, so a fleet room
          // never matches and is never delivered. Local needs no gateway patch
          // and every fleet-mate in the system can see it. What makes an order
          // on a PUBLIC channel safe is the sender allowlist, not the channel.
          // ⚠ BOTH OF THESE SWALLOW THEIR OWN FAILURE, and they did not have to
          // before. While each was gated on a setting, a companion whose
          // operator had not enabled it never made the call at all -- so a
          // route that answers badly could not reach this `Promise.all`. Now
          // that every companion reads chat and its own drone bay, an
          // unavailable route would reject the whole tick and stop a pilot that
          // is otherwise flying perfectly well. Neither read is load-bearing:
          // `null` already means "did not look" to every rung beneath, and a
          // pilot that cannot read chat simply obeys broadcasts and tags.
          chatWanted
            ? api.readChat("local", callOptions).catch(() => null)
            : Promise.resolve(null),
          droneBayWanted ? api.getDrones(callOptions).catch(() => null) : Promise.resolve(null),
          // ⚠ THE ROSTER RIDES IN THE BATCH, AND IT USED TO QUEUE BEHIND IT.
          // It is this loop's most load-bearing read (supervision, `inFleet`,
          // the tagging verdict -- see where it is decoded below) and it is
          // made on EVERY tick, so it was also this loop's most expensive
          // mistake: awaited on its own after the batch had already resolved,
          // it added a whole serial round trip to every tick a companion has
          // ever run. It depends on nothing the batch produces, so there was
          // never a reason for it to wait -- the awaits it sat behind were
          // simply written in the order the facts were needed rather than in
          // the order they could be fetched.
          //
          // ⚠ IT SWALLOWS ITS OWN FAILURE HERE FOR THE REASON THE TWO READS
          // ABOVE DO: inside a `Promise.all` a rejection takes the whole tick
          // down with it. The `catch` below used to be the thing that turned an
          // unreadable roster into `inFleet: null`, and that contract is
          // preserved exactly -- `null` here means the same thing and is
          // decoded the same way.
          api.loadBoundFleet(callOptions).catch(() => null),
        ]);
        // api.ts delivers trusted response drains through the current flow/session sink.
        // The same authority the Targeting panel reads, kept live while the
        // companion flies so the panel never shows a stale lock list.
        const lockedTargetIDs = decodeTargetIDs(targetsResult.targetIDs);
        store.apply({ type: "targeting/targets", targetIDs: lockedTargetIDs });
        // Absent stays absent: `null` is "could not say who has us locked", and
        // the fleet-order recall falls back to its short wait on it.
        const lockedByIDs = targetsResult.targeterIDs == null ? null : decodeTargetIDs(targetsResult.targeterIDs);
        const status = decodeFlightStatus(statusStep.flight);
        void flow.flying.observeFlightStatus(status);
        // ⚠ THE REPAIR QUOTE IS GATED ON BEING DOCKED, AND ON NOTHING ELSE ANY
        // MORE. It is a sixth round trip on a two-second tick, so it is gated on
        // the shop being answerable at all -- the ship has to be in the station
        // -- which also makes it free in every tick a companion spends flying.
        //
        // ⚠ IT USED TO BE GATED ON `repairsAtStation` AS WELL, AND THAT SECOND
        // GATE WAS A BUG RATHER THAN A SAVING. The quote is not a purchase: it
        // is the ONLY thing that can tell a docked pilot whether its hull is
        // whole, because `obs.health` is folded from the space snapshot and a
        // station has none. So a pilot that does not pay for repairs was a pilot
        // that could never learn it was fixed -- including when its operator had
        // just repaired it BY HAND, which is how this was found (2026-09-13: "I
        // repaired the one ship which had damaged armor and it still refuses to
        // undock"). Asking the shop what is damaged costs ISK nowhere; the
        // setting still decides whether anything is ever PAID for, which is the
        // thing an operator was actually consenting to.
        //
        // It runs AFTER the Promise.all rather than inside it because `docked`
        // is not known until the flight status resolves. That costs a serial
        // round trip on the ticks it fires, which are only ever ticks spent
        // sitting in a station with nothing else to do.
        //
        // ⚠ NULL IS "COULD NOT SAY", NEVER "NOTHING IS DAMAGED" -- the same
        // contract the DSL's repair-ship read keeps, and the flee rung treats
        // it as a tick spent waiting rather than as permission to undock.
        let damagedItemIDs: FleetCompanionObservation["damagedItemIDs"] = null;
        if (liveCompanionRequest !== null && status.docked) {
          try {
            const quotes = await flow.quoteShipRepair();
            damagedItemIDs = quotes === null ? null : repairTargets(quotes);
          } catch {
            damagedItemIDs = null;
          }
        }
        const snapshot = decodeSpaceSnapshot(spaceResult.space);
        // Keep the Overview live while the companion flies, exactly as the
        // mining bot does — the panel's own poll may not be running.
        store.apply({
          type: "space/snapshot",
          snapshot,
          gateLinks: flow.flying.gateLinksForSnapshot(snapshot),
        });

        // ⚠ FILTERED HERE, ON THE BROADCAST'S OWN TTL, because the ladder is pure
        // and carries no clock of its own. One staleness policy for both order
        // sources is the point: a chat order that has gone quiet is exactly as
        // stale as a broadcast that has, and a lapsed order must stop standing so
        // the pilot falls back to its own ladder. Without this the backlog the
        // channel read returns would replay as live orders every tick, and a
        // restart would obey a line somebody typed ten minutes ago.
        const chatNowMs = Date.now();
        const chatMessages =
          chatRaw === null
            ? []
            : decodeChatChannel(chatRaw).messages.filter(
                (entry) => chatNowMs - entry.createdAtMs < FLEET_BROADCAST_TTL_MS,
              );

        const ship = snapshot?.ship ?? null;
        const origin = ship?.position ?? { x: 0, y: 0, z: 0 };
        // ⚠ A BLIND SCENE IS UNKNOWN, NOT EMPTY (seen live 2026-10-14 12:00:11 UTC: a
        // dead ballpark answered `{inSpace:true, entities:[], ship:null}` with a 200
        // for ten minutes). `decodeSpaceSnapshot` never returns null, so the
        // `snapshot === null ? null : ...` guards below were dead and every fact read
        // off the empty list came out a confident "none": no hostile, no drones out,
        // grid clear. Those facts are null here instead, and `sceneBlind` lets the
        // ladder say so and wait.
        const sceneBlind = isSceneBlind(status.inSpace, snapshot);

        // What the OTHER pilots have already emptied. Gated on there being
        // something lootable on this grid and rationed to a slow beat, so a
        // companion that is not looting pays nothing for it. BFF-local: no
        // gateway call, and a failure leaves the set as it was.
        await refreshCompanionSharedEmpty(snapshot, Date.now());

        // ── The two grid reads the ladder shares with the DSL's own bots.
        //
        // ⚠ `targetedByPlayer` IS FREE AND SO IT IS NEVER GATED. It is a pass
        // over the snapshot already decoded above and makes no call at all, so
        // there is no cost to weigh against it the way there is for the chat
        // read or the drone bay.
        //
        // It is also the only evidence this client has of a PURE PLAYER
        // engagement. `hostileOnGrid` below is `hostileRows`, and `hostileRows`
        // filters on `isHostile`, which is NPC-or-not — so a fleet being shot
        // by another fleet lights up neither half of the tank rung's `fightOn`
        // test unless this field is set — which is how this shipped: the field
        // was declared, never filled, and a companion in a player gatecamp had
        // no reason to switch a hardener on.
        const targetedByPlayer = sceneBlind ? null : isTargetedByPlayer(snapshot, ship?.itemID ?? null);
        // ⚠ THIS ONE IS GATED, because unlike the line above it can cost a
        // round trip. `flow.flying.classifyTargetGroups` resolves a GROUP NAME per ship
        // type on grid: nothing on an empty grid, nothing on a repeat tick
        // (`requestNames` skips ids already cached or in flight), but one
        // batched lookup each time a NEW hull type shows up — and on a busy
        // grid that is a real, if bounded, cost on a two-second tick.
        //
        // The gate is `attemptsTagging` because `decideTackleTag` is the whole
        // readership: it is the one rung that ranks ships, and with tagging off
        // it returns before it ever looks. Same rule the chat read and the
        // drone bay are under — a companion must not pay for an answer no rung
        // will read.
        //
        // Player hulls ARE asked for (the `true`), which is the opposite of
        // what a script bot gets by default. The ships this rung ranks are its
        // TACKLERS, and a ship running a scrambler on a fleet-mate is almost
        // always a player — resolving only the NPC rows would hand `pickPrimary`
        // a null class for exactly the targets that matter and collapse it to
        // nearest-first, which is the degradation this field exists to avoid.
        // ⚠ RESOLVED FOR EVERY COMPANION NOW. This used to be gated on the
        // `attemptsTagging` tick; every pilot tags what tackles it, so every
        // pilot needs the class ranking that decides WHICH tackler gets the
        // letter first. The cost is one /api/names round trip per NEW ship type
        // seen, not one per tick -- group names are cached after first look.
        const targetGroupNames = await flow.flying.classifyTargetGroups(
          snapshot,
          origin,
          true,
          ship?.itemID ?? null,
        );
        // ⚠ PAID FOR HERE TOO, UNDER THE SAME GATE, because `pickPrimary` is the
        // second reader of it: the companion ranks the ships shooting at its
        // fleet with the same ladder a script bot does, and a group name cannot
        // tell a tackle frigate from its harmless sibling for either of them.
        // The cost is the same as the line above and smaller: one round trip per
        // NEW rat type EVER SEEN on this tab (the cache is permanent, since type
        // dogma is static), nothing per tick, and nothing at all on a grid with
        // no NPCs on it -- so a companion escorting a miner does not start
        // paying for reads its ladder will not use.
        const threatByTypeID = await flow.flying.classifyRatThreats(snapshot, origin);

        // ── The drone reads (rung 6). Two of the three are free: they come off
        // the snapshot already in hand. Only the bay costs a call, and it is
        // gated above.
        //
        // ⚠ `canMyShipOrderDrone === true`, NEVER `isMyDrone`. The narrower test
        // is the right one for both of these: a drone this hull cannot ORDER is
        // one it cannot recall either, so counting it would make the rung wait
        // for a recall that can never land. That case is real and was observed
        // live -- an abandoned drone answers a recall with a 200 and does not
        // move (see `canMyShipOrderDrone`'s own comment).
        const myShipID = ship?.itemID ?? null;
        companionShipID = myShipID;
        const myDroneIDs: number[] = [];
        // Per drone, for the rotation in rung 6: it pulls the ONE drone that is
        // being shot, so it needs that drone's own shield and not the fold.
        const myDrones: { itemID: number; shieldRatio: number | null; armorRatio: number | null; hullRatio: number | null }[] = [];
        let lowestDroneHealth: number | null = null;
        for (const entity of snapshot?.entities ?? []) {
          if (canMyShipOrderDrone(entity, myShipID) !== true) {
            continue;
          }
          myDroneIDs.push(entity.itemID);
          myDrones.push({
            itemID: entity.itemID,
            shieldRatio: entity.shieldRatio,
            armorRatio: entity.armorRatio,
            hullRatio: entity.hullRatio,
          });
          // The worst of the three layers, per drone, then the worst across
          // them -- the same fold `makeScriptRunnerDeps` makes, so a companion
          // and a script bot judge an identical rack identically. A layer that
          // did not read is skipped rather than counted as zero.
          const ratios = [entity.shieldRatio, entity.armorRatio, entity.hullRatio].filter(
            (ratio): ratio is number => ratio !== null,
          );
          if (ratios.length === 0) {
            continue;
          }
          const worst = Math.min(...ratios);
          lowestDroneHealth =
            lowestDroneHealth === null ? worst : Math.min(lowestDroneHealth, worst);
        }
        // ⚠ `null` HERE IS "DID NOT LOOK", AND THE RUNG TREATS IT AS SUCH. An
        // empty array is a real "the bay is empty" and a launch that finds one
        // issues nothing; `null` means the read was never made or failed, and
        // the rung must not read that as an empty bay.
        const companionBay = droneRaw === null ? null : decodeDroneBay(droneRaw.bay);
        const droneBayItemIDs = companionBay?.map((stack) => stack.itemID) ?? null;
        if (companionBay !== null) {
          companionDroneStackSizes = droneStackSizes(companionBay);
        }
        // ⚠ SPLIT BY ROLE, AND THIS IS THE FIX FOR THE ONE PLACE IN THIS APP
        // THAT MIXED DRONE TYPES. Rung 6 used to launch `droneBayItemIDs` whole,
        // so a bay holding combat and salvage drones sent both into the same
        // fight -- the salvage drones unable to fight it, and occupying the
        // control slots the combat drones needed. The scripted blocks have always
        // used this same split (`launchRoleDrones`); the companion never did.
        // Reusing `flow.flying.classifyDroneRoles` rather than growing a second classifier
        // means one answer to "what is this drone for", not two.
        const companionDroneRoles = await flow.flying.classifyDroneRoles(
          companionBay,
          sceneBlind ? null : snapshot,
          ship?.itemID ?? null,
        );
        // ── Drone sizing's inputs. The combat stacks WITH their types (the
        // role split above keeps only ids), the hull's limits off the same
        // drones read, and each combat type's dogma -- bay types and the types
        // already out, since a size switch compares the two.
        const combatBayIDs = new Set(companionDroneRoles.bay?.combat ?? []);
        const combatDroneStacks =
          companionBay === null || companionDroneRoles.bay === null
            ? null
            : companionBay.filter((stack) => combatBayIDs.has(stack.itemID));
        const limits = droneRaw === null ? null : flow.flying.withPilotDroneCap(decodeDroneLimits(droneRaw.shipInfo));
        const companionDroneLimits =
          limits === null || limits.droneBandwidth === null || limits.maxActiveDrones === null
            ? null
            : { bandwidthMbit: limits.droneBandwidth, maxActive: limits.maxActiveDrones };
        const combatOutIDs = new Set(companionDroneRoles.out?.combat ?? []);
        const companionDroneFacts = await combatDroneFacts([
          ...(combatDroneStacks ?? []).map((stack) => stack.typeID),
          ...(snapshot?.entities ?? [])
            .filter((entity) => combatOutIDs.has(entity.itemID) && entity.typeID !== null)
            .map((entity) => entity.typeID as number),
        ]);

        // The roster is read EVERY tick and not gated, because a companion with
        // no fleet has nothing to obey — this is its most load-bearing read, not
        // an optional extra. A failure lands as null (unreadable), never as
        // "not in a fleet".
        //
        // ⚠ THE CALL ITSELF IS UP IN THE BATCH NOW; only the DECODE is here.
        // See `api.loadBoundFleet` in the `Promise.all` above for why it moved.
        // `fleetRaw === null` is the batch's own `catch`, and `decodeFleetCenter`
        // throwing is the second way this read can fail -- both land in exactly
        // the same place they always did.
        let inFleet: boolean | null = null;
        let fleetMemberCharacterIDs: readonly number[] | null = null;
        // Held past the try so the tagging verdict below can be answered from
        // the read that ALREADY happened. A second roster read to ask "am I a
        // commander" would double this loop's most frequent HTTP call to learn
        // something the first read's own rows already say.
        let fleetSnapshot: FleetCenterSnapshot | null = null;
        try {
          fleetSnapshot = fleetRaw === null ? null : decodeFleetCenter(fleetRaw);
          inFleet = fleetSnapshot === null ? null : fleetSnapshot.availability === "ready";
          fleetMemberCharacterIDs =
            fleetSnapshot === null ? null : authoritativeFleetMemberCharacterIDs(fleetSnapshot);
        } catch {
          inFleet = null;
          fleetMemberCharacterIDs = null;
          fleetSnapshot = null;
        }
        const ownCharacterID = store.station.get().online?.characterID ?? null;
        // Plain-name chat selectors need the complete roster to distinguish
        // "Test" from "Test Two". A partial name read stays unknown, so the
        // selector can use its conservative complete-segment fallback.
        let fleetMemberNames: readonly string[] | null = null;
        if (fleetMemberCharacterIDs !== null) {
          await flow.flying.resolveNamesNow(fleetMemberCharacterIDs.map((id) => ({ kind: "character" as const, id }))).catch(() => {});
          const resolved = store.names.get().resolved;
          const names = fleetMemberCharacterIDs.map((id) => resolved[nameKey("character", id)]);
          if (names.every((name): name is string => typeof name === "string" && name.trim() !== "")) fleetMemberNames = names;
        }
        // ⚠ FREE, NEVER GATED — unlike the roster read just above (an HTTP
        // call, gated elsewhere behind FLEET_SUPPORT_MACROS), these two ride
        // the fleet slice the notification drain already fills. Gating them
        // too would mean a companion that could have obeyed its fleet simply
        // never looked.
        const fleetSlice = store.fleet.get();
        const fleetTargetTags = fleetSlice.targetTags;
        // ⚠ TTL APPLIED HERE, AT OBSERVATION BUILD — never in the store's
        // reducer. The store keeps the raw broadcast until the next one
        // replaces it; asking "is it still fresh" is this reader's job, same
        // discipline as `src/squadBoard.js` dropping a lapsed call when ASKED
        // rather than on a timer. A follower whose call has lapsed falls back
        // to its own ladder, which is a working bot, not a stopped one.
        const fleetBroadcast =
          fleetSlice.lastBroadcast !== null &&
          isFleetBroadcastFresh(fleetSlice.lastBroadcast, Date.now())
            ? fleetSlice.lastBroadcast
            : null;
        // What the sleep after this tick watches (`watchDronesWhileAsleep`):
        // the whole drones, and only in a fight. A drone already below full is
        // the ladder's to decide on this tick, not the watch's to wake for.
        companionDroneWatch =
          snapshot !== null && !sceneBlind && hostileRows(snapshot, origin).length > 0
            ? myDrones.filter((drone) => drone.shieldRatio !== null && drone.shieldRatio >= 1).map((drone) => drone.itemID)
            : [];
        const autopilotNow = flow.flying.autopilotProgress();
        return {
          inSpace: status.inSpace,
          docked: status.docked,
          inWarp: status.shipMode === null ? null : /warp/i.test(status.shipMode),
          shieldRatio: ship?.shieldRatio ?? null,
          armorRatio: ship?.armorRatio ?? null,
          hullRatio: ship?.hullRatio ?? null,
          health: lowestHealth(snapshot),
          capacitorRatio: ship?.capacitorRatio ?? null,
          // The companion does not mine. `null` is the honest answer for a hold
          // nobody read, and it is what every threshold treats as cannot-tell.
          oreHoldFraction: null,
          holdEmpty: null,
          hostileOnGrid: snapshot === null || sceneBlind ? null : hostileRows(snapshot, origin).length > 0,
          sceneBlind,
          targetedByPlayer,
          targetGroupNames,
          threatByTypeID,
          signatureByTypeID: flow.flying.ratSignaturesOnGrid(snapshot, origin),
          hitPointsByTypeID: flow.flying.ratHitPointsOnGrid(snapshot, origin),
          ratCombatByTypeID: flow.flying.ratCombatOnGrid(snapshot, origin),
          ratResonancesByTypeID: flow.flying.ratResonancesOnGrid(snapshot, origin),
          droneControlRangeM: companionDroneControlRangeM,
          combatDroneStacks,
          droneFactsByTypeID: companionDroneFacts,
          droneLimits: companionDroneLimits,
          dronesOut:
            snapshot === null || sceneBlind
              ? null
              : snapshot.entities.some((entity) =>
                  canMyShipOrderDrone(entity, ship?.itemID ?? null),
                ),
          flightStatus: status,
          damagedItemIDs,
          snapshot,
          inFleet,
          fleetMemberCharacterIDs,
          fleetMemberNames,
          myCharacterID: ownCharacterID,
          // Needed by the `loot` rung's ownership gate. Absent until now,
          // which is why its corp clause was silently dead.
          myCorporationID: store.station.get().online?.corporationID ?? null,
          fleetTargetTags,
          fleetBroadcast,
          lockedTargetIDs,
          lockedByIDs,
          maxLockedTargets: companionTargeting.maxLockedTargets,
          maxTargetRangeM: companionTargeting.maxTargetRangeM,
          // ⚠ THE GATE IS CLIENT-SIDE BECAUSE THE SERVER REFUSES SILENTLY.
          // `setFleetTargetTag` returns a bare `false` for a non-commander and
          // its only caller discards that boolean, so the write's own ack says
          // `ok` either way -- there is no answer to read back. The roster this
          // tick already fetched is the only place the truth exists. See
          // `bridge/fleetCommand.ts`.
          //
          // Three-state, and the middle state matters: `null` is "could not
          // look" and `false` is "looked, and no". Both mean do not write; only
          // `false` may be remembered. An unknown own-character id is `null` for
          // the same reason -- without it there is no row to find, which is not
          // evidence of anything.
          canTag: ownCharacterID === null ? null : canTagInFleet(fleetSnapshot, ownCharacterID),
          // The other half of rung 4's fork, off the SAME roster read — so the
          // two verdicts can never disagree about which fleet they describe.
          // `canTag === false` alone cannot be used here: it is also what a
          // pilot in NO fleet gets, and that pilot has nobody to broadcast to.
          canBroadcast:
            ownCharacterID === null ? null : canBroadcastInFleet(fleetSnapshot, ownCharacterID),
          botDrivenCharacterIDs: botDriven,
          // The invite the notification drain already parked in the fleet slice.
          // Read rather than re-fetched: every bridge response on this tick
          // carried its own drain, so the slice is as fresh as anything else
          // here, and a companion polls no extra route for it.
          pendingFleetInvite: companionPendingInvite(),
          chatMessages,
          // Who this pilot is, so a `status` or `repair` line naming pilots can
          // be told apart from one naming somebody else.
          selfCharacterID: ownCharacterID,
          selfCharacterName: store.station.get().online?.characterName ?? null,
          // Rung 4, "tackle → tag". Narrowed to the two tackle jam types and
          // freshness-filtered HERE, at observation build, for the same reason
          // `fleetBroadcast` is: the slice keeps every jam the wire carried
          // until its `OnJamEnd` lands, and one clock read per tick gives the
          // whole ladder one consistent answer. Free — it rides the same
          // notification drain the fleet slice does and polls nothing.
          tackledBy: tacklersHolding(store.space.get().jams, Date.now()),
          // The narrower half of the same jam slice: is a warp SCRAMBLER on us,
          // as opposed to the disruptor `tackledBy` also counts. Only the
          // scrambler carries `blocksMicrowarpdrive`, so only it means anything
          // to `decidePropulsion` — and reading it off the same one clock read
          // keeps the two answers about this tick consistent.
          scrammed: scrammedByWarpScrambler(store.space.get().jams, Date.now()),
          // ⚠ WHAT "TRAVELLING" MEANS FOR A COMPANION, and the only place it can
          // be seen. Both of the companion's own travel rungs — the `destination`
          // trip and a `TravelTo` order — hand the flying to the SHARED autopilot
          // (`startRoute`), so the autopilot's own status IS the answer to "is
          // this pilot on a trip". Synchronous, no gateway call, exactly as the
          // DSL observation's identical read is; null when no autopilot exists
          // yet, which reads as "not travelling" and never as "travelling".
          travel: autopilotNow !== null
            ? {
                status: autopilotNow.status,
                destinationStationID: store.travel.get().destinationStationID,
                destinationSystemID: store.travel.get().destinationSystemID,
                remainingJumps: autopilotNow.remainingJumps,
                failureReason: autopilotNow.failureReason,
              }
            : null,
          // The last docked rearm's answer; the rung matches it to its own order.
          rearmOutcome: companionRearmOutcome,
          lowestDroneHealth,
          // Absent, not empty, on a blind scene: "did not look" (see `sceneBlind`).
          myDroneIDs: sceneBlind ? undefined : myDroneIDs,
          // Absent, not empty, when there was no snapshot: "did not look".
          myDrones: snapshot == null || sceneBlind ? undefined : myDrones,
          droneBayItemIDs,
          // ⚠ WHAT THE LOOT CALLS ACTUALLY ACHIEVED, which the ladder cannot see
          // for itself: it issues one atomic call and never learns what came
          // back. A can is finished when it was emptied, or when it has been
          // tried enough times not to be worth another.
          // ⚠ TWO SOURCES, AND THE SECOND IS WHAT KEEPS A FLEET FROM DOING ONE
          // PILOT'S WORK FOUR TIMES. `companionLootFinished` is what THIS pilot
          // settled; `companionSharedEmpty` is what any other pilot on this BFF
          // (or the hand-flown client, which loots through the same path) found
          // empty and said so. Merged here rather than in the ladder because
          // the ladder must stay a pure decider with no reads of its own.
          lootFinishedItemIDs: [...companionLootFinished, ...companionSharedEmpty],
          combatDroneBayItemIDs: companionDroneRoles.bay?.combat ?? null,
          salvageDroneBayItemIDs: companionDroneRoles.bay?.salvage ?? null,
          logisticDroneBayItemIDs: companionDroneRoles.bay?.logistic ?? null,
          combatDroneIDs: companionDroneRoles.out?.combat ?? null,
          salvageDroneIDs: companionDroneRoles.out?.salvage ?? null,
          logisticDroneIDs: companionDroneRoles.out?.logistic ?? null,
          // ⚠ THE CHAT-ORDER GATE, AND THE ONLY THING BETWEEN A COMPANION AND A
          // STRANGER TYPING "target" IN LOCAL. Derived from the roster read this
          // tick already made -- the same rows `canTag` above is decided from, so
          // there is one definition of "commander" and not two. A roster that
          // could not be read yields null, which the ladder treats as "no chat
          // orders", never as "anybody will do".
          fleetCommanderCharacterIDs:
            fleetSnapshot === null ? null : fleetCommanderCharacterIDs(fleetSnapshot),
          // Where those commanders are, off the same rows: the rejoin warp
          // (rung 9b) does not warp to one that is docked or in another system.
          fleetCommanderWhereabouts:
            fleetSnapshot === null ? null : fleetCommanderWhereabouts(fleetSnapshot),
          // The reload rung's three facts. ⚠ THE REQUEST IS WHAT SAYS WHICH
          // MODULES ARE GUNS — `weaponModuleIDs` is derived from the hull at
          // start (`requestForFit`), and without it this read cannot tell a
          // turret from any other module that happens to take a charge. A run
          // with no live request yet reads nothing and reports "cannot say".
          ...(liveCompanionRequest === null
            ? {
                emptyWeaponModuleIDs: null,
                cargoCharges: null,
                weaponChargeGroups: null,
                loadedCharges: null,
              }
            : await readCompanionAmmoFacts(
                liveCompanionRequest,
                status.inSpace === true,
                Date.now(),
              )),
          // The guns' reach with what is LOADED, for the range gate and the
          // `flight auto` rung. ⚠ AFTER THE AMMO READ, WHICH FILLS IT: a literal
          // evaluates in order, so above it this was always one read stale and
          // `null` on the first tick in space.
          combatWeapons: companionCombatWeapons,
          // Rung 8a's fit facts, filled by the same read (and the same order rule).
          combatUtilities: companionCombatUtilities,
          // Ammo by target's static facts, filled by the same ammo read.
          chargeFactsByTypeID: companionChargeFacts.chargeFactsByTypeID,
          weaponCycleByTypeID: companionChargeFacts.weaponCycleByTypeID,
        };
      },
      // ⚠ STRAIGHT TO THE WRAPPER, NEVER THROUGH `sendChatMessage`. That one
      // re-reads the channel into the store, which would repaint the Chat panel
      // of whichever pilot the player is looking at; a background companion must
      // not move the furniture in front of a human (see `readCompanionAmmoFacts`).
      // Local, for the reason the chat READ is local: fleet chat is not reachable.
      say: async (text) => {
        await api.sendChat("local", text, callOptions);
      },
      issue: async (action) => {
        // Straight to the `api.*` wrapper, the way `makeMiningBotDeps` does —
        // never through the script runner's own switch, which belongs to the
        // DSL. Every one of these is an abandonment-protocol call (decision 5);
        // the companion's ordinary work still issues nothing.
        switch (action.kind) {
          case "wait":
            return;
          case "warp":
            await flow.flying.warpAsTheAutopilot(action.targetID);
            return;
          case "warpToFleetMember":
            // Rung e2's other half: an id the ladder could not find on its own
            // grid, which got that far only by being a fleet-mate. The server
            // resolves where they are — see the route's own note.
            await warpToMember(action.characterID);
            return;
          case "approach":
            // ⚠ `range` IS WHERE TO STOP, and null hugs the object. Salvaging
            // and looting pass their working distance so the ship stops in
            // reach instead of flying all the way in for nothing.
            await flow.flying.approachShip(action.targetID, action.range ?? null);
            return;
          case "dock":
            await flow.flying.dockStep(action.stationID);
            return;
          case "leaveFleet":
            await leaveFleetCall(flow.flying.bridgeDo);
            return;
          case "acceptFleetInvite":
            await acceptFleetInviteCall(flow.flying.bridgeDo, action.fleetID, false);
            return;
          // Rung 7, "obeying the fleet" (fleetCompanionLoop.ts): a tag or a
          // `Target` broadcast, locked; an `AlignTo` broadcast, aligned to.
          // Straight to the api layer for the same reason every case above
          // is — the companion has to see a refusal to decide on it, not have
          // it swallowed the way the flow's own lockTarget()/alignTo() do.
          // (The align is the page's own call, bridge/movementWrites.ts, and
          // its refusal comes back here all the same.)
          case "align":
            await flow.flying.alignShip(action.targetID);
            return;
          case "lock":
            await lockTargetCall(flow.flying.bridgeDo, action.targetID, null);
            return;
          // Rung 7, the Heal family (fleetCompanionLoop.ts): a fitted remote
          // repairer, aimed at the ship the broadcast named. `repeat: -1` is
          // this codebase's own "run continuously" (see the DSL's own
          // `activate` case above `makeFleetCompanionDeps`). Phase 3 adds
          // SELF-targeted modules too (a hardener, a self-repairer), so this
          // adopts the DSL's own form: omitting the `targetID` key entirely
          // is this codebase's convention for "run it on the caster", and
          // `targetID: 0` is the DSL's sentinel for that, never a real item
          // id — it is not a ship this ladder measured on grid.
          case "activate":
            await flow.flying.switchModuleOn(
              action.moduleID,
              action.targetID > 0 ? { targetID: action.targetID, repeat: -1 } : { repeat: -1 },
              callOptions,
            );
            return;
          // Phase 3, "tank up": switch a module OFF. Same shape as the DSL's
          // own `deactivate` case — no target, since deactivation always
          // targets the caster's own fit.
          //
          // ⚠ THE typeID IS NOT OPTIONAL DECORATION FOR A PROP MOD. Deactivate
          // stops an afterburner/MWD only when it names the module's propulsion
          // effect, and the page asks the game's data for that name by the typeID
          // alone — without it the call returns success and the burner keeps
          // cycling (bridge/dogmaWrites.ts, deactivateModule: the page's own call
          // since 2026-10-14). The rung that emits a propulsion `deactivate` fills
          // this in; the tank-up rung leaves it undefined and the body simply
          // omits the key, exactly as before.
          case "deactivate":
            await flow.flying.switchModuleOff(
              action.moduleID,
              action.typeID === undefined ? {} : { typeID: action.typeID },
              callOptions,
            );
            return;
          // Rung 7, `TravelTo`: hand off to the SHARED autopilot, exactly as
          // the DSL's own `startSystemRoute` case does — same solver, same
          // bounds, and the ride ends in space at the destination system
          // since a fleet companion has no station to dock at here.
          case "travelTo":
            await flow.startRoute(action.systemID);
            return;
          // The `rearm` trip's way there: the same shared autopilot, given a
          // station, so the plan ends docked in it.
          case "routeToStation":
            await flow.startRoute(action.stationID);
            return;
          // The `rearm` trip's work. ⚠ ITS ANSWER IS THE NEXT TICK'S, NOT A THROW:
          // the rung waits for the lines under its own order, so a failure here
          // has to come back as one of them or the pilot sits until it times out.
          case "rearmShip": {
            let lines: string[];
            try {
              lines = await rearmDockedShip(action.stationID);
            } catch (error) {
              if (isSessionLost(error)) throw error;
              lines = [`Could not rearm: ${errorWords(error)}`];
            }
            companionRearmOutcome = { orderedAtMs: action.orderedAtMs, lines };
            return;
          }
          // Rung 4, "tackle → tag". ⚠ NOTHING IS READ BACK OFF THIS CALL, AND
          // NOTHING CAN BE. The server refuses a non-commander with a bare
          // `false` that its own caller discards, so the ack is identical
          // whether the tag landed or was dropped. The gate ran before the
          // write (`bridge/fleetCommand.ts`), and the confirmation is the
          // letter turning up in a later `fleetTargetTags` — which is why the
          // rung keeps its own attempt budget rather than trusting this
          // returning cleanly.
          case "setFleetTargetTag":
            await tagFleetTarget(flow.flying.bridgeDo, action.targetID, action.tag);
            return;
          // Rung 4's other arm, the one a plain member actually has: call the
          // tackler out by `Target` broadcast. THE ACK IS REAL HERE — the
          // server returns whether it sent, and both of its handlers return
          // that boolean rather than discarding it (the exact thing the tag
          // path above cannot say). A `false` is the 2-second broadcast rate
          // limit, which is ordinary and not an error: the rung calls each ship
          // once and is already shooting the one it just tried to name, so
          // there is nothing to raise and nothing to retry. Logged, not thrown.
          case "broadcastFleetTarget": {
            // The page's own call. To everyone: the scope a client is set to unless its pilot chose another.
            const sent = await flow.flying.fleetBroadcasts.toBubble("Target", FLEET_BROADCAST_SCOPE_ALL, action.targetID);
            if (!sent) {
              // ⚠ NOT AN ERROR AND NOT RETRIED. The rung calls each ship once
              // and is already shooting the one it just tried to name; a
              // re-send would be the same shout, and the next tick's rate limit
              // would very likely drop that too. Surfaced here rather than
              // swallowed only because this is the ONE fleet call whose refusal
              // is knowable at all -- worth being able to see in a console when
              // somebody asks why a call never reached the fleet.
              console.warn("companion: fleet target broadcast dropped (rate limit)", action.targetID);
            }
            return;
          }
          // Rung 6. `launchDrones` takes BAY STACK ids and `recallDrones` takes
          // the ENTITY ids of drones in space -- two different id spaces, which
          // is why the two action kinds carry differently named fields rather
          // than sharing one.
          //
          // Launch and recall are confirmed from the grid on the next tick.
          // Engage instead settles each requested drone from the server's
          // refusal dict and the authoritative post-call target read.
          case "launchDrones":
            // ⚠ THE WHOLE STACK, NOT ONE FROM IT. See wholeStackLaunch.
            await flow.flying.launchedThenRead(
              action.quantities === undefined
                ? wholeStackLaunch(action.droneItemIDs, companionDroneStackSizes)
                : action.droneItemIDs.map((itemID) => ({
                    itemID,
                    quantity: action.quantities?.[itemID] ?? companionDroneStackSizes.get(itemID) ?? 1,
                  })),
            );
            return;
          // ⚠ NO SCOOP FOLLOWS THIS. The server flies them home at full speed
          // and scoops them itself inside 2500 m; a scoop call would only ever
          // duplicate what it is already doing.
          case "recallDrones":
            await returnDronesToBay(flow.flying.bridgeDo, action.droneIDs);
            return;
          // ⚠ ONE CALL, TWO MEANINGS, AND THE SERVER PICKS. `CmdEngage` aimed at
          // a hostile is an attack; aimed at a friendly ship it is dispatched to
          // the drone REPAIR path instead. Both flights receive an explicit
          // order; server auto-defense alone does not follow the fleet primary.
          case "engageDrones":
            await flow.flying.engageDronesConfirmed(action.droneIDs, action.targetID);
            return;
          // ⚠ `targetID: 0` IS THE SERVER'S AUTO-PICK, not a missing value.
          case "salvageDrones":
            await salvageWithDrones(flow.flying.bridgeDo, action.droneIDs, action.targetID);
            return;
          // The `loot` chat order. Two calls because a wreck and a can are
          // different objects on the wire, not because they are different rules.
          case "lootWreck":
            await companionLootFrom(action.wreckID);
            return;
          case "lootContainer":
            await companionLootFrom(action.containerID);
            return;
          // Rung 5, the flee's recovery step. ⚠ THE ITEM IDS ARE THE SHOP'S OWN
          // QUOTE, read in observe() above and never guessed at here. The
          // wrapper carries `confirm: true` in the body, which is what
          // `requireWriteConfirmation` on the route wants -- a caller stating
          // intent, not a dialog. Forgetting it is a 400 CONFIRMATION_REQUIRED,
          // never a hang.
          //
          // ⚠ AND IT SPENDS THE OPERATOR'S MONEY. Nothing reaches this case
          // unless `repairsAtStation` was ticked; the rung checks before it
          // decides, and the request's risk classes say `financial` because of
          // it.
          case "repairItems":
            // A tick names items and has no quote in hand: the shop is asked for one, and paid at it.
            await repairItemsAtShop(flow.flying.bridgeAsk, flow.flying.bridgeDo, action.itemIDs, await flow.flying.dockedIn());
            return;
          // Rung 5, the last step of a round trip: back out into space. The
          // only call this loop makes that deliberately re-enters danger, which
          // is why `recoverAndReturn` does all its checking above it.
          case "undock":
            await flow.flying.orderedStep((flightNow) => undockCall(flow.flying.bridgeDo, flightNow, true));
            return;
          // ⚠ NO FAR-SIDE GATE, AND THAT IS THE POINT. The server resolves the
          // destination from the gate we are sitting on (`sourceGate.destinationID`);
          // passing 0 is what asks it to. See the action's own comment.
          case "jumpGate":
            await flow.flying.jumpStep(action.gateID, 0);
            return;
          // The standing follow rung: hold station off the fleet commander at
          // the range a `follow` chat order named — `CmdFollowBall` with a
          // non-zero range, the same call the DSL's own `follow-fleet-mate`
          // block makes for a hand-picked mate.
          //
          // ⚠ THE RUNG ISSUES THIS ONCE PER ANCHOR AND RANGE, NEVER ONCE PER
          // TICK, and this case is written on that promise. The server treats
          // it as a STANDING order: the ship goes on holding that station with
          // nothing further sent. A rung that re-sent it every tick would be
          // pure bridge traffic for a command already in force — which is why
          // the memory gate lives up in the ladder and not down here.
          case "keepAtRange":
            await flow.flying.keepShipAtRange(action.targetID, action.range);
            return;
          // `flight auto`: a gun boat orbits what it is shooting. Standing on the
          // server like keep-at-range, and gated the same way up in the ladder
          // (`holdNeedsReissue`), so this case is sent once per anchor and range.
          case "orbit":
            await flow.flying.orbitShip(action.targetID, action.range);
            return;
          // `stop` in fleet chat — the only companion action that exists to
          // UNDO standing orders rather than to issue one.
          //
          // ⚠ BOTH HALVES ARE NEEDED AND THE ORDER IS RETAIL'S, mirroring
          // `flow.stopShip()` above: abort the browser decide-loop FIRST so it
          // cannot issue another move into the stop, then tell the server to
          // cut the engines. Aborting alone ends the route and leaves the ship
          // coasting on the leg it was already flying; stopping alone halts a
          // ship the autopilot sets moving again on its next tick. A companion
          // told to stop has to end up stationary by both measures, because
          // the operator's words for this order are "it stops where it is".
          case "stopShip":
            flow.flying.abortAutopilot();
            await flow.flying.cutEngines();
            return;
          // The reload rung: put rounds in the guns from the ship's own cargo.
          //
          // ⚠ ALWAYS "cargo", NEVER "hangar". A companion that needs this is in
          // space, where there is no station hangar to draw from. The page's own
          // call (bridge/dogmaWrites.ts) names the ship as where the charges lie,
          // and asks nothing for a hangar the pilot is not docked at.
          //
          // ⚠ NOTHING IS READ BACK OFF THIS CALL, AND NOTHING CAN BE. Which
          // charges a module accepts lives in dogma attributes the browser has
          // no allowlisted read for, so the server refuses an incompatible load
          // with its own words that never reach this layer — an accepted load
          // and a refused one look identical from here. That is why the rung
          // confirms by watching the gun leave `emptyWeaponModuleIDs` on a
          // later tick and keeps its own attempt budget, exactly as rung 4's
          // tag write does.
          case "loadAmmo":
            await flow.flying.loadAmmoFrom(action.moduleIDs, [action.chargeItemID], "cargo");
            // ⚠ THE ONE THING THAT MAKES THE RUNG'S ATTEMPT BUDGET MEAN WHAT IT
            // SAYS. Its budget is three ATTEMPTS per gun, but the facts above
            // refresh only every ten seconds against a two-second tick — so
            // without this, all three could be spent against the SAME stale
            // "still empty" reading, and a load that actually worked would cost
            // three calls before the next refresh proved it. Expiring the cache
            // here makes the very next tick re-read, so each attempt is judged
            // against a fresh answer. Costs one extra pair of reads per load,
            // which only happens when a gun was genuinely dry.
            companionAmmoReadAtMs = 0;
            return;
          default: {
            // ⚠ EXHAUSTIVE ON PURPOSE. Every FleetCompanionAction kind MUST be
            // issued here, or a new kind silently no-ops at runtime instead of
            // failing to compile — exactly the gap that let `deactivate` land
            // with nothing wired up for one revision.
            const never: never = action;
            throw new Error(`The fleet companion action dispatcher is missing an action: ${String(never)}`);
          }
        }
      },
      // ⚠ NOT A PLAIN `setTimeout` -- see `companionSleep`. This is the one
      // loop of the four whose inputs ARRIVE AS PUSHES rather than as reads, so
      // it is the one loop for which sleeping out a fixed cadence means sitting
      // on an order it already has.
      sleep: companionSleep,
      // The same per-character log the script runner writes; see nav/companionLog.ts.
      log: flow.flying.log,
      onProgress: (progress) => {
        applyCompanionEvent(store, {
          type: "companion/progress",
          status: progress.status,
          phase: progress.phase,
          action: progress.action,
          why: progress.why,
          inFleet: progress.inFleet,
          followingOrderFrom: progress.followingOrderFrom,
          lastOrderHeard: progress.lastOrderHeard,
          targetMode: progress.targetMode,
          standingOrders: progress.standingOrders,
          canTag: progress.canTag,
          abandonment: progress.abandonment,
          failureReason: progress.failureReason,
          selfPaused: progress.selfPaused,
        });
        // The loop ended by itself: it flies nothing now, so the ship is free.
        if (progress.status === "stopped" || progress.status === "error") letGoOfShip();
      },
    };
  }
  /**
   * Who this host is flying with a bot — the union of the BFF's OWN running-bot
   * roster and whatever this host says it drives itself.
   *
   * The union is the point, because neither half alone is enough:
   *
   *   • `/api/bots/active` is the BFF's live claim map, so a headless companion
   *     reading it over loopback gets an EXACT answer covering every other
   *     headless companion — including ones this tab never started. It is
   *     unauthenticated by design (the login screen marks bot-flown pilots), so
   *     there is no token question here.
   *   • It cannot see a companion running in a BROWSER, which holds an ordinary
   *     bridge session like any human. That is what the injected half covers.
   *
   * A failed read returns `null`, never `[]`. An empty list would read as
   * "nobody is bot-driven", which makes every companion in the fleet look like a
   * human and disables the gate silently — the loudest possible failure being
   * the quiet one. `null` leaves the gate undecidable, which is the honest
   * answer and the one `decideCompanionAction` fails open on.
   */
  async function botDrivenCharacterIDs(): Promise<readonly number[] | null> {
    let serverBots: readonly number[];
    try {
      serverBots = (await api.listActiveServerBots(callOptions)).map((bot) => bot.characterID);
    } catch {
      return null;
    }
    const mine = flow.flying.hostDrivenCharacterIDs() ?? ownDrivenCharacterIDs();
    if (mine === null) {
      return null;
    }
    return [...new Set([...serverBots, ...mine])];
  }
  /**
   * The fallback for a host that injected nothing: this session alone, and only
   * while a bot is actually holding its ship.
   *
   * It is deliberately narrow. A pilot this session is flying BY HAND is not
   * something to subtract — a human at the keyboard is exactly the supervision
   * the gate is looking for.
   */
  function ownDrivenCharacterIDs(): readonly number[] {
    const me = store.station.get().online?.characterID ?? null;
    return me !== null && store.bots.get().runningBotID !== null ? [me] : [];
  }
  /** The pending fleet invite, narrowed to the two ids the rejoin gate reads. */
  function companionPendingInvite(): { readonly fleetID: number; readonly inviterID: number | null } | null {
    const invite = store.fleet.get().pendingInvite;
    return invite === null ? null : { fleetID: invite.fleetID, inviterID: invite.inviterID };
  }
  function letGoOfShip(): void {
    shipHold?.release();
    shipHold = null;
  }
  function stopCompanionController(): void {
    fleetCompanion?.stop();
    liveCompanionRequest = null;
    letGoOfShip();
    // The pilot has gone, and with it what this readout was about: stopping must not leave one behind.
    if (store.station.get().online === null) applyCompanionEvent(store, { type: "companion/cleared" });
    // The companion's movement rungs ride the same shared autopilot the mission
    // and custom loops use, so stopping the outer loop alone would leave that
    // inner controller flying after another bot takes the ship.
    flow.flying.abortAutopilot();
  }
  /** The preflight reads. Both are best-effort; a failure is null, never "no". */
  async function fleetCompanionReads(): Promise<FleetCompanionReads> {
    let inFleet: boolean | null = null;
    let docked: boolean | null = null;
    try {
      const fleetSnapshot = decodeFleetCenter(await api.loadBoundFleet(callOptions));
      inFleet = fleetSnapshot.availability === "ready";
    } catch {
      inFleet = null;
    }
    try {
      const step = await api.getFlightStatus(callOptions);
      docked = decodeFlightStatus(step.flight).docked;
    } catch {
      docked = null;
    }
    return { inFleet, docked };
  }
  /**
   * `resuming` re-seats an abandonment that was already under way when the BFF
   * went down, so its thirty-minute clock continues instead of restarting.
   * Only the bot host ever passes it; a player pressing Start never does.
   */
  /** A fit we could not read: judged nowhere, warned about nowhere. */
  const UNREADABLE_COMPANION_FIT: CompanionFitFacts = Object.freeze({
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    remoteShieldModuleIDs: [],
    remoteArmorModuleIDs: [],
    remoteCapacitorModuleIDs: [],
    weaponModuleIDs: [],
    salvagerModuleIDs: [],
    droneAssistModuleIDs: [],
    propulsionModules: [],
    modules: [],
    droneBay: null,
    droneBayRoles: { combat: [], salvage: [], logistic: [], unknown: [] },
    tankLayer: null,
    fitReadable: false,
  });
  /**
   * What the reload rung needs to know, read at most every
   * `COMPANION_AMMO_READ_INTERVAL_MS` and served from the cache in between.
   *
   * ⚠ STRAIGHT TO THE `api.*` WRAPPERS, NEVER THROUGH `flow.loadFitting()` OR
   * `flow.loadInventory()`. Those two APPLY to the store, which would repaint the
   * fitting and inventory panels of whichever pilot the player happens to be
   * looking at — and a background companion must not move the furniture in
   * front of a human (R92: a background pilot is still working, and its flow
   * outlives the panel). Decoding here and keeping the answer in this closure
   * leaves the store alone.
   *
   * ⚠ EVERY FIELD IS THREE-STATE. `null` means "could not read", which the
   * ladder treats as "cannot say" and never as "there is none" — a fit read
   * that stumbled must not be reported as a ship with no empty guns, nor a
   * cargo read that stumbled as a ship with no ammunition aboard.
   */
  async function readCompanionAmmoFacts(
    request: FleetCompanionRequest,
    inSpace: boolean,
    nowMs: number,
  ): Promise<typeof companionAmmoFacts> {
    // Docked there is nothing here to decide: the rung is guarded on being in
    // space, and a docked pilot's guns are not drawing from this cargo bay.
    if (!inSpace || nowMs - companionAmmoReadAtMs < COMPANION_AMMO_READ_INTERVAL_MS) {
      return companionAmmoFacts;
    }
    // Stamped BEFORE the reads, so a read that throws waits out the full
    // interval instead of being retried on every tick.
    companionAmmoReadAtMs = nowMs;

    let emptyWeaponModuleIDs: readonly number[] | null = null;
    let weaponChargeGroups: Readonly<Record<number, readonly number[]>> | null = null;
    let loadedCharges: CompanionLoadedCharge[] | null = null;
    let fitReads: Awaited<ReturnType<typeof api.loadFitting>> | null = null;
    try {
      const reads = await api.loadFitting(callOptions);
      fitReads = reads;
      if (!reads.errors.slots && !reads.errors.online) {
        const slots = buildSlots(reads.slots, reads.shipInfo, reads.online);
        const chargeFits = decodeChargeFits(reads.chargeFits);
        const guns = new Set(request.weaponModuleIDs);
        const empty: number[] = [];
        const groups: Record<number, readonly number[]> = {};
        const loaded: CompanionLoadedCharge[] = [];
        for (const slot of slots) {
          const module = slot.module;
          if (module === null || !module.online || !guns.has(module.itemID)) {
            continue;
          }
          const fitment = chargeFits[module.typeID];
          groups[module.itemID] = fitment?.groups ?? [];
          // ⚠ ONLY A MODULE THAT DEMONSTRABLY TAKES A CHARGE COUNTS AS EMPTY.
          // `decodeChargeFits` returns `{}` both for a module that takes none
          // and for a fit whose charge data never arrived — its own comment
          // says so — so a missing fitment is "cannot say", not "empty". This
          // is the same three-state `companionFitCheck.takesCharge` keeps, for
          // the same reason: a companion must not spend its attempt budget
          // trying to load rounds into a shield hardener.
          if (module.charge === null && (fitment?.groups.length ?? 0) > 0) {
            empty.push(module.itemID);
          }
          // What is in it, for the `status` answer and the low-ammo warning.
          if (module.charge !== null && module.charge.quantity > 0) {
            loaded.push({ moduleID: module.itemID, typeID: module.charge.typeID, quantity: module.charge.quantity });
          }
        }
        emptyWeaponModuleIDs = empty;
        weaponChargeGroups = groups;
        loadedCharges = loaded;
      }
    } catch {
      // Left null on purpose. See the three-state note above.
    }

    let cargoCharges: readonly CompanionCargoCharge[] | null = null;
    try {
      const panel = await api.loadInventory(callOptions);
      const cargo = decodeContainer(
        panel.cargo.list,
        panel.cargo.capacity,
        panel.cargo.error,
        panel.volumes,
      );
      cargoCharges =
        cargo.error !== null
          ? null
          : cargo.rows
              .filter((row) => row.categoryID === CHARGE_CATEGORY_ID && row.quantity > 0)
              .map((row) => ({
                itemID: row.itemID,
                typeID: row.typeID,
                groupID: row.groupID,
                quantity: row.quantity,
              }));
    } catch {
      // Left null on purpose. See the three-state note above.
    }

    companionAmmoFacts = { emptyWeaponModuleIDs, cargoCharges, weaponChargeGroups, loadedCharges };
    companionCombatWeapons = await readCompanionCombatWeapons(request, fitReads);
    companionChargeFacts = await readCompanionChargeFacts(cargoCharges, companionCombatWeapons);
    return companionAmmoFacts;
  }
  /**
   * The static facts ammo by target ranks with (companionAmmo.ts): every charge
   * type in the cargo or in a gun, and every gun type. `flow.flying.attributesOfTypes`
   * keeps what it was told per type, so after the first read of a type this
   * costs no call. A failure leaves that half `null`; names are warmed with the
   * same cache the panels use and are only ever a readout nicety.
   */
  async function readCompanionChargeFacts(
    cargo: readonly CompanionCargoCharge[] | null,
    weapons: CombatWeapons | null,
  ): Promise<typeof companionChargeFacts> {
    const chargeTypes = [...new Set([
      ...(cargo ?? []).map((charge) => charge.typeID),
      ...(weapons?.weapons ?? []).flatMap((weapon) => (weapon.chargeTypeID === null ? [] : [weapon.chargeTypeID])),
    ])];
    const weaponTypes = [...new Set((weapons?.weapons ?? []).map((weapon) => weapon.typeID))];
    let chargeFactsByTypeID: Record<number, ChargeFacts> | null = null;
    let weaponCycleByTypeID: Record<number, WeaponCycleFacts> | null = null;
    try {
      await flow.flying.resolveNamesNow(chargeTypes.map((id) => ({ kind: "type" as const, id }))).catch(() => {});
      const rows: Readonly<Record<number, Readonly<Record<number, number>>>> =
        chargeTypes.length > 0 ? await flow.flying.attributesOfTypes(chargeTypes, CHARGE_ATTRIBUTE_IDS) : {};
      const resolved = store.names.get().resolved;
      chargeFactsByTypeID = {};
      for (const typeID of chargeTypes) {
        if (rows[typeID] !== undefined) {
          chargeFactsByTypeID[typeID] = chargeFactsFromAttributes(rows[typeID], resolved[nameKey("type", typeID)] ?? null);
        }
      }
    } catch {
      chargeFactsByTypeID = null;
    }
    try {
      const rows: Readonly<Record<number, Readonly<Record<number, number>>>> =
        weaponTypes.length > 0 ? await flow.flying.attributesOfTypes(weaponTypes, WEAPON_CYCLE_ATTRIBUTE_IDS) : {};
      weaponCycleByTypeID = {};
      for (const typeID of weaponTypes) {
        const cycle = weaponCycleFromAttributes(rows[typeID]);
        if (cycle !== null) {
          weaponCycleByTypeID[typeID] = cycle;
        }
      }
    } catch {
      weaponCycleByTypeID = null;
    }
    return { chargeFactsByTypeID, weaponCycleByTypeID };
  }
  /**
   * The guns' reach with their loaded charges, from the fit the ammo read just
   * made. See `companionCombatWeapons` for why the bound dogma is read only when
   * `companionCombatChargeKey` changes: the key is every gun's loaded charge
   * type plus the hull, which is everything reach depends on that can change
   * mid-run. Any failure answers `null`, which the range gate reads as "fire".
   *
   * It also fills `companionCombatUtilities` (rung 8a) off the same two reads:
   * the key carries the utility modules' state too, so a ship with no guns but a
   * web still reads its dogma once, and again only when that module changes.
   */
  async function readCompanionCombatWeapons(
    request: FleetCompanionRequest,
    reads: Awaited<ReturnType<typeof api.loadFitting>> | null,
  ): Promise<CombatWeapons | null> {
    const shipID = companionShipID;
    if (shipID === null || reads === null ||
      reads.activeShipID !== shipID || reads.errors.slots || reads.errors.online || reads.errors.shipInfo) {
      companionCombatChargeKey = null;
      companionCombatUtilities = null;
      return null;
    }
    const slots = buildSlots(reads.slots, reads.shipInfo, reads.online);
    const guns = new Set(request.weaponModuleIDs);
    // Rung 8a's modules, told apart by the static data's group (kept per type, so
    // a call only the first time a type is seen). A read that stumbles finds no
    // utility this time; the next interval asks again.
    let types: Awaited<ReturnType<typeof flow.flying.combatUtilityOfTypes>> = {};
    try {
      types = await flow.flying.combatUtilityOfTypes([...new Set(slots.flatMap((slot) => slot.module === null ? []
        : [slot.module.typeID, ...(slot.module.charge === null ? [] : [slot.module.charge.typeID])]))]);
    } catch {
      types = {};
    }
    const utilityIDs = new Set(slots.flatMap((slot) => slot.module !== null &&
      AUTOMATIC_UTILITY_FAMILIES[types[slot.module.typeID]?.groupID ?? -1] !== undefined ? [slot.module.itemID] : []));
    if (request.weaponModuleIDs.length === 0 && utilityIDs.size === 0) {
      companionCombatChargeKey = null;
      companionCombatUtilities = null;
      return null;
    }
    const stateOf = (ids: ReadonlySet<number>): string => slots
      .flatMap((slot) => slot.module !== null && ids.has(slot.module.itemID)
        ? [`${slot.module.itemID}:${slot.module.online ? 1 : 0}:${slot.module.charge?.typeID ?? "-"}`] : [])
      .join(",");
    // ⚠ WIDENED, NOT A SECOND KEY: one dogma read serves both the guns and the
    // utilities, and it is re-read only when either's item, online or loaded
    // charge state moved.
    const key = `${shipID}|${stateOf(guns)}|${stateOf(utilityIDs)}`;
    if (key === companionCombatChargeKey) {
      return companionCombatWeapons;
    }
    try {
      const bound = await api.boundDogma(callOptions);
      if (bound.allInfo.error || Number(bound.allInfo.value?.activeShipID) !== shipID) {
        companionCombatChargeKey = null;
        companionCombatUtilities = null;
        return null;
      }
      companionCombatChargeKey = key;
      // No cargo for either: the reload rung reads its own (`cargoCharges`), reach
      // does not depend on what is in the hold, and the capacitor booster (the one
      // utility that loads from it) is not run by the companion. The ratio only
      // scales the capacity back out (`companionUtilities.ts`), so the page's own
      // last snapshot is enough.
      const seen = store.space.get().snapshot?.ship ?? null;
      const utilities = utilityIDs.size === 0 ? null : combatUtilityFit(shipID, slots, bound.allInfo.value,
        types, null, seen !== null && seen.itemID === shipID ? seen.capacitorRatio : null);
      // Gated like every other list of modules to switch on (`flow.flying.fittedModuleActivation`).
      if (utilities !== null) await flow.flying.readTypeActivation(utilities.modules.map((module) => module.typeID));
      companionCombatUtilities = utilities === null ? null
        : { ...utilities, modules: utilities.modules.filter((module) => flow.flying.fittedModuleActivation(module) !== "passive") };
      return request.weaponModuleIDs.length === 0 ? null
        : combatFit(shipID, slots, request.weaponModuleIDs, decodeChargeFits(reads.chargeFits), bound.allInfo.value, null);
    } catch {
      companionCombatChargeKey = null;
      companionCombatUtilities = null;
      return null;
    }
  }
  async function readCompanionFitFacts(): Promise<CompanionFitFacts> {
    try {
      await flow.loadFitting();
      const fit = store.fitting.get();
      // Read before the slots gate: the stats come off the hull, not the slots.
      companionTargeting = {
        maxLockedTargets: fit.stats.targeting.maxLockedTargets.known
          ? fit.stats.targeting.maxLockedTargets.value
          : null,
        maxTargetRangeM: fit.stats.targeting.maxTargetRange.known
          ? fit.stats.targeting.maxTargetRange.value
          : null,
      };
      // The DSL's own resolver: the fit stat when it is known, the pilot's
      // drone skills otherwise, `null` for a hull with a known-empty bay.
      companionDroneControlRangeM = await flow.flying.resolveDroneControlRange(fit);
      if (fit.slotsError !== null) {
        return UNREADABLE_COMPANION_FIT;
      }
      await flow.flying.warmFitFacts(fit);
      const defense = flow.flying.resolveDefenseModuleIDs();
      const remote = flow.flying.resolveRemoteRepModuleIDs();
      // The buffer fit's own answer to "where is this ship's tank", voted off
      // the same already-resolved group names the classifiers above read. Only
      // ever consulted when nothing repairable has already said so.
      const tankLayer = resolveTankLayer();
      const modules = fit.slots
        .filter((slot) => slot.module !== null && slot.module.online)
        .map((slot) => {
          const module = slot.module!;
          const fitment = fit.chargeFits[module.typeID];
          return {
            itemID: module.itemID,
            typeID: module.typeID,
            hasCharge: module.charge !== null,
            // ⚠ NULL WHEREVER WE CANNOT SAY. `decodeChargeFits` gives `{}` both
            // for a module that takes no charge and for a fit whose charge data
            // did not arrive, so only a positive group list is a confident
            // "this has somewhere to load something".
            takesCharge: fitment !== undefined && fitment.groups.length > 0 ? true : null,
          };
        });
      // ⚠ READ UNCONDITIONALLY NOW. This used to sit behind `useDrones`, because
      // the bay is a round trip and a pilot whose operator had not ticked drones
      // could never use one. There is no such tick: a companion flies the drones
      // it is carrying, so whether it has any is exactly the question this read
      // answers, and it cannot be skipped on the strength of an answer nobody
      // gave. One extra call, once, at start — not per tick.
      let droneBay: ReturnType<typeof decodeDroneBay> = null;
      let droneBayRoles: DroneRoleIDs = { combat: [], salvage: [], logistic: [], unknown: [] };
      try {
        const raw = await api.getDrones(callOptions);
        droneBay = decodeDroneBay(raw.bay);
        if (droneBay !== null) {
          // The same resolve-then-judge pass the module classifier makes, for
          // the same reason: the game says what a type IS and we only read the
          // answer. Warmed here because a bot host's name cache starts empty,
          // and an unresolved group leaves a drone in NO role rather than in a
          // wrong one.
          await flow.flying.resolveNamesNow(
            droneBay.map((stack) => ({ kind: "typeGroup" as const, id: stack.typeID })),
          );
          const names = store.names.get().resolved;
          droneBayRoles = splitDroneRoles(
            droneBay,
            (stack) => stack.typeID,
            (stack) => stack.itemID,
            (typeID) => names[nameKey("typeGroup", typeID)] ?? null,
          );
        }
      } catch {
        droneBay = null;
      }
      return {
        defenseModuleIDs: defense.hardeners,
        shieldBoosterModuleIDs: defense.shield,
        armorRepairerModuleIDs: defense.armor,
        hullRepairerModuleIDs: defense.hull,
        ancillaryRepairerModuleIDs: defense.ancillary,
        remoteShieldModuleIDs: remote.shield,
        remoteArmorModuleIDs: remote.armor,
        remoteCapacitorModuleIDs: remote.cap,
        weaponModuleIDs: defense.weapons,
        // ⚠ ITS OWN CLASSIFIER, NOT A BRANCH OF `flow.flying.resolveDefenseModuleIDs`.
        // `flow.flying.resolveSalvageModuleIDs` already existed for the DSL and matches the
        // game's own "Salvager" group in high slots only; reusing it means one
        // answer to "is this a salvager", not two that can drift.
        salvagerModuleIDs: flow.flying.resolveSalvageModuleIDs(),
        droneAssistModuleIDs: resolveDroneAssistModuleIDs(),
        propulsionModules: defense.propulsion,
        modules,
        droneBay,
        droneBayRoles,
        tankLayer,
        fitReadable: true,
      };
    } catch {
      return UNREADABLE_COMPANION_FIT;
    }
  }
  async function startFleetCompanion(
    setup: CompanionSetup,
    resuming: CompanionAbandonmentRecord | null = null,
    orders: CompanionStandingOrders | null = null,
    restarted = false,
  ): Promise<void> {
    flow.requireAutomationReady();
    const generation = flow.flying.sessionGeneration();
    applyCompanionEvent(store, { type: "companion/start-error", message: null });

    // Taking the ship is the first semantic act of every start, even one whose
    // own preflight later refuses — the player has said which loop they want.
    shipHold?.release();
    shipHold = flow.flying.holdShip(COMPANION_OWNER, "Fleet companion", stopCompanionController);

    // ⚠ A NEW RUN HAS FINISHED WITH NOTHING, and these two outlive the
    // controller because they hang off the flow. The ladder's own
    // `lootedItemIDs` already starts empty on every `start()` — for the reason
    // spelled out there: a can this run has not emptied is a can it must be
    // willing to try — and leaving these standing made that promise false from
    // the outside. A can set aside once (out of reach, a hold with no room, a
    // bind the server refused) stayed set aside for the life of the tab, so
    // re-ordering `loot` after fixing the cause did nothing at all and the pilot
    // ignored the can for ever.
    companionLootAttempts.clear();
    companionLootFinished.clear();
    // The shared marks go too, and are read back on the first tick that sees a
    // can on the grid. Nothing is lost -- the board is the BFF's, not this
    // run's -- and it keeps the promise above literally true: a new run starts
    // out willing to try everything, then asks.
    companionSharedEmpty.clear();
    companionSharedEmptyReadAtMs = 0;

    const preflight = evaluateRequirements(FLEET_COMPANION_REQUIREMENTS, await fleetCompanionReads());
    if (generation !== flow.flying.sessionGeneration() || flow.flying.isSessionClosing()) return;
    // A run coming back out of a fleet is not refused: it has a pilot in space to look after, and its ladder knows what
    // to do with nobody to fly with. Refusing would log the pilot off where it is.
    if (!preflight.canStart && !restarted) {
      // It took the ship from whatever flew it, as the player asked, and flies nothing itself.
      letGoOfShip();
      applyCompanionEvent(store, { type: "companion/start-error", message: preflight.blockedBy });
      return;
    }

    // ⚠ READ THE SHIP BEFORE THE LOOP SEES ANYTHING. The setup carries no module
    // lists at all -- they exist only once this has read the hull -- and the
    // first tick can fire immediately, so a loop started before this returned
    // would spend that tick believing the ship carries nothing.
    let fitFacts: Awaited<ReturnType<typeof readCompanionFitFacts>>;
    try {
      fitFacts = await readCompanionFitFacts();
    } catch (error) {
      letGoOfShip();
      throw error;
    }
    if (generation !== flow.flying.sessionGeneration() || flow.flying.isSessionClosing()) return;
    const flownRequest = requestForFit(setup, fitFacts);
    // Advisory, never a refusal: a human loads the missing thing or flies
    // anyway. Judged against the DERIVED request, because its lists are what
    // this run will actually cycle.
    const fitWarnings = companionFitWarnings(flownRequest, fitFacts);

    applyCompanionEvent(store, {
      type: "companion/started",
      startedAt: Date.now(),
      fitWarnings,
    });

    if (!fleetCompanion) {
      fleetCompanion = createFleetCompanion(makeFleetCompanionDeps());
    }
    // Before start(), not after: the first tick can fire immediately, and a tick
    // that read a stale request would decide this run on the last one's orders.
    liveCompanionRequest = flownRequest;
    fleetCompanion.start(flownRequest, resuming, orders);
    void fleetCompanion.run();
  }
  function pauseFleetCompanion(): void {
    fleetCompanion?.pause();
  }
  function resumeFleetCompanion(): void {
    flow.requireAutomationReady();
    if (!fleetCompanion) {
      return;
    }
    fleetCompanion.resume();
    void fleetCompanion.run();
  }
  function stopFleetCompanion(): void {
    stopCompanionController();
  }
  let fleetCompanion: FleetCompanionController | null = null;
  /**
   * The request the companion is CURRENTLY running, for the reads whose cost
   * depends on it -- chat, today.
   *
   * ⚠ IT IS A LIVE REFERENCE AND NOT A CAPTURED ONE, AND THAT IS THE WHOLE
   * POINT. `makeFleetCompanionDeps()` is built ONCE and the controller is
   * cached (`if (!fleetCompanion)`), so a request threaded in at deps-build
   * time would be the FIRST run's request forever: start a companion with chat
   * off, stop it, start another with chat on, and the second one would silently
   * never read chat. Assigned on EVERY start, cleared on stop.
   */
  let liveCompanionRequest: FleetCompanionRequest | null = null;
  /**
   * The fitted SALVAGERS, by the game's own group name ("Salvager") — the same
   * resolve-then-judge pass the miner resolution makes. Runs after
   * resolveMiningModuleIDs, so the names are already in the cache.
   */
  /**
   * The fitted DEFENSE modules by the game's own group names, for the repair
   * watch and the hardeners block. Same resolve-then-judge pass as the miners;
   * runs after resolveMiningModuleIDs so the names are already cached. Reps live
   * in mids/lows, so every family is scanned (not just high slots).
   */
  /**
   * Which layer this hull is BUILT around — the answer for a buffer fit, which
   * cycles nothing and therefore says nothing through any of the lists
   * `flow.flying.resolveDefenseModuleIDs` fills. The judging lives in `bots/tankLayer.ts`,
   * where it can be tested against real SDE group names without a store; this
   * half is the resolve, exactly as the drone-role split is arranged.
   *
   * ⚠ RIGS ARE INCLUDED, AND ARE EXCLUDED EVERYWHERE ELSE IN THIS FILE. A rig
   * cannot be activated, so no cycling list may hold one — but "Rig Armor" on a
   * hull is about as plain a statement of tank as this game makes. Their group
   * names are already in the cache: `readCompanionFitFacts` warms `typeGroup`
   * for every fitted slot, rigs included.
   *
   * ⚠ AN OFFLINE MODULE COUNTS TOO, unlike everywhere else here. What a hull
   * CARRIES is the statement; whether it happens to be powered this minute is
   * about capacitor and powergrid, not about where its tank was built.
   * Subsystems are skipped because a T3's subsystem group names describe a
   * hull role rather than a tank.
   */
  function resolveTankLayer(): CompanionTankLayer | null {
    const fit = store.fitting.get();
    if (fit.slotsError !== null) {
      return null;
    }
    const resolved = store.names.get().resolved;
    return voteTankLayer(
      fit.slots
        .filter((slot) => slot.module !== null && slot.family !== "subsystem")
        .map((slot) => resolved[nameKey("typeGroup", slot.module!.typeID)] ?? null),
    );
  }
  /**
   * Sizing facts for these combat drone types, reading only the ones never
   * looked up. One round trip per NEW drone type this tab ever sees. A failed
   * read is not cached and costs only this tick's sizing: the rung then
   * launches the whole bay as it always did.
   */
  async function combatDroneFacts(typeIDs: readonly number[]): Promise<ReadonlyMap<number, DroneFacts>> {
    const missing = [...new Set(typeIDs)].filter((typeID) => !droneFactsByTypeID.has(typeID));
    if (missing.length > 0) {
      try {
        const attributes = await api.fetchTypeDogma(missing, DRONE_SIZING_ATTRIBUTE_IDS, callOptions);
        for (const typeID of missing) {
          const row = attributes[typeID];
          if (row !== undefined) {
            droneFactsByTypeID.set(typeID, droneFactsFromAttributes(typeID, row));
          }
        }
      } catch {
        // Left uncached: asked again next tick.
      }
    }
    const facts = new Map<number, DroneFacts>();
    for (const typeID of typeIDs) {
      const known = droneFactsByTypeID.get(typeID);
      if (known !== undefined && known !== null) {
        facts.set(typeID, known);
      }
    }
    return facts;
  }
  /**
   * Fitted, online modules that boost the DRONES and must be switched on to do
   * it: the game's "Drone Tracking Modules" (Omnidirectional Tracking Link) and
   * "Drone Navigation Computer" groups, matched exactly. The passive "Drone
   * Tracking Enhancer" group is a different name and is never matched.
   *
   * ⚠ THE GROUP NAME DID NOT MAKE THEM SWITCHABLE. Seen live 2026-10-14: on this
   * server a Drone Navigation Computer I has no effect a pilot switches on, and
   * companions asked for it once a fight ("... cannot be activated."). The
   * group says what a module is FOR; whether it can be switched on is
   * `flow.flying.fittedModuleActivation`, here as in every list.
   */
  function resolveDroneAssistModuleIDs(): readonly number[] {
    const fit = store.fitting.get();
    if (fit.slotsError !== null) {
      return [];
    }
    const resolved = store.names.get().resolved;
    const ids: number[] = [];
    for (const slot of fit.slots) {
      if (slot.module === null || !slot.module.online || slot.family === "rig" || slot.family === "subsystem") {
        continue;
      }
      const group = resolved[nameKey("typeGroup", slot.module.typeID)] ?? null;
      if (group !== null && /^(drone tracking modules|drone navigation computer)$/i.test(group.trim()) &&
        flow.flying.fittedModuleActivation(slot.module) !== "passive") {
        ids.push(slot.module.itemID);
      }
    }
    return ids;
  }

  /** Stop new work and settle the tick already issuing an order, for a run being stopped. */
  function beginGracefulStop(): Promise<void> {
    liveCompanionRequest = null;
    return fleetCompanion?.beginGracefulStop() ?? Promise.resolve();
  }

  return { startFleetCompanion, pauseFleetCompanion, resumeFleetCompanion, stopFleetCompanion, beginGracefulStop };
}

export type CompanionFlow = ReturnType<typeof createCompanionFlow>;
