// Fight fixtures shared by the `flight auto` tests: the ladder's end-to-end ones
// in fleetCompanionLoop.test.ts and the rung's own in
// companionCombatPosition.test.ts.
//
// ⚠ NOT A TEST FILE, AND THE NAME IS WHY. It does not match `*.test.ts`, so the
// runner never loads it on its own; and it imports nothing from a test file,
// because importing one would run every test in it a second time. The handful of
// ids it shares with fleetCompanionLoop.test.ts (the commander, the companion,
// the guns, the commander's ship) carry the SAME synthetic values there, so a
// fixture built here and an assertion written there agree.

import assert from "node:assert/strict";

import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  decideCompanionAction,
  freshLadderMemory,
  type CompanionDecision,
  type CompanionLadderMemory,
  type FleetCompanionAction,
  type FleetCompanionObservation,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import type { RatCombatFacts } from "./combatPosition.ts";
import type { CombatWeapon } from "./combatWeapons.ts";
import type { ChatMessage, SpaceSnapshot } from "../store/types.ts";

/**
 * The fleet commander (a human) and this companion. `90000001` is the example
 * CCP's own ESI documentation publishes for a character id: documented, and
 * unmistakably not a real pilot.
 */
export const FIGHT_COMMANDER = 90000001;
export const FIGHT_COMPANION = 90000002;
/** The commander's own ship, on this grid. */
export const FIGHT_FC_SHIP = 200010;
/** The default formation distance, mirrored from the parser that owns it. */
export const FIGHT_FOLLOW_M = 2000;
export const FIGHT_GUN_1 = 11300001;
export const FIGHT_GUN_2 = 11300002;

export const RAT = 200100;
export const RAT_2 = 200101;
/** A turret rat that reaches 30 km (20 km optimal + 10 km falloff). */
export const TYPE_LONG_RAT = 601;
/** A turret rat that reaches 10 km. */
export const TYPE_SHORT_RAT = 602;
/** A type whose combat facts were never read. */
export const TYPE_UNREAD_RAT = 603;

export const LONG_RAT: RatCombatFacts = {
  missile: false, optimalM: 20_000, falloffM: 10_000, trackingSpeed: null,
  attackRangeM: null, orbitRangeM: null, maxVelocity: null,
};
export const SHORT_RAT: RatCombatFacts = { ...LONG_RAT, optimalM: 6_000, falloffM: 4_000 };

export const FIGHT_NO_THREAT = { scram: false, scramRangeM: null, web: false, ewar: false, ecm: false };

/** A fitted gun with its LOADED charge's reach, as `combatFit` reports it. */
export function gun(itemID: number, reachM: number | null, optimalM: number | null): CombatWeapon {
  return {
    itemID, typeID: 1, chargeTypeID: 2, chargeQuantity: 100, acceptedGroups: null,
    chargeSize: null, reachM, optimalM, tracking: null,
  };
}

/** Short guns: 20 km and 10 km reach, so a rat at 30 km is out of both. */
export const SHORT_GUNS = [gun(FIGHT_GUN_1, 20_000, 15_000), gun(FIGHT_GUN_2, 10_000, 8_000)];
/** Long guns: 40 km reach, which out-ranges a 10 km rat by more than the buffer. */
export const LONG_GUNS = [gun(FIGHT_GUN_1, 40_000, 30_000), gun(FIGHT_GUN_2, 40_000, 30_000)];
export const TWO_GUNS: FleetCompanionRequest = {
  ...DEFAULT_FLEET_COMPANION_REQUEST, weaponModuleIDs: [FIGHT_GUN_1, FIGHT_GUN_2],
};

/** A chat line from the fleet commander. */
export function commanderSays(message: string, createdAtMs = 1_000): ChatMessage {
  return { characterID: FIGHT_COMMANDER, characterName: "Fleet Mate", message, createdAtMs };
}

/**
 * A complete, supervised observation: the commander and this pilot in the
 * fleet, the commander in charge. The same shape as fleetCompanionLoop.test.ts's
 * own `obs`.
 */
export function companionObs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return {
    inSpace: true,
    inWarp: false,
    docked: false,
    fleetTargetTags: null,
    canTag: null,
    inFleet: true,
    fleetMemberCharacterIDs: [FIGHT_COMMANDER, FIGHT_COMPANION],
    fleetCommanderCharacterIDs: [FIGHT_COMMANDER],
    botDrivenCharacterIDs: [FIGHT_COMPANION],
    myCharacterID: FIGHT_COMPANION,
    pendingFleetInvite: null,
    ...overrides,
  } as FleetCompanionObservation;
}

/**
 * This ship at the origin, the commander's ship at `fcAt` on the x axis (null:
 * not on grid), and NPC rats at their own x. Radii are 0, so surface distance
 * is x.
 */
export function fightGrid(options: {
  readonly rats?: readonly { readonly itemID: number; readonly typeID: number; readonly x: number }[];
  readonly fcAt?: number | null;
  readonly activeModuleIDs?: readonly number[];
  readonly extra?: readonly Record<string, unknown>[];
} = {}): SpaceSnapshot {
  const rats = options.rats ?? [{ itemID: RAT, typeID: TYPE_LONG_RAT, x: 30_000 }];
  const fcAt = options.fcAt === undefined ? -5_000 : options.fcAt;
  return {
    inSpace: true,
    ship: {
      position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null, maxVelocity: 300,
      activeModuleIDs: options.activeModuleIDs ?? [], weaponBanks: {},
    },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      ...(fcAt === null ? [] : [{
        itemID: FIGHT_FC_SHIP, kind: "ship", isSelf: false, characterID: FIGHT_COMMANDER,
        position: { x: fcAt, y: 0, z: 0 }, radius: 0, mode: null,
      }]),
      ...rats.map((rat) => ({
        itemID: rat.itemID, typeID: rat.typeID, kind: "ship", isSelf: false, isNpc: true,
        npcEntityType: "npc", position: { x: rat.x, y: 0, z: 0 }, radius: 0, mode: null,
      })),
      ...(options.extra ?? []),
    ],
  } as unknown as SpaceSnapshot;
}

/** A grid with one rat at `x`, of the long-reach type unless named. */
export function ratAt(x: number, typeID: number = TYPE_LONG_RAT, extra: Parameters<typeof fightGrid>[0] = {}): SpaceSnapshot {
  return fightGrid({ ...extra, rats: [{ itemID: RAT, typeID, x }] });
}

/** The fleet has tagged `target`, it is locked, and the grid's rat facts are read. */
export function fightObs(
  weapons: readonly CombatWeapon[] | null,
  grid: SpaceSnapshot = fightGrid(),
  target: number = RAT,
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return companionObs({
    snapshot: grid,
    fleetTargetTags: new Map([[target, "A"]]),
    lockedTargetIDs: [target],
    hostileOnGrid: true,
    combatWeapons: weapons === null ? null : { shipID: 1, weapons, cargo: null },
    ratCombatByTypeID: { [TYPE_LONG_RAT]: LONG_RAT, [TYPE_SHORT_RAT]: SHORT_RAT },
    threatByTypeID: {
      [TYPE_LONG_RAT]: FIGHT_NO_THREAT, [TYPE_SHORT_RAT]: FIGHT_NO_THREAT, [TYPE_UNREAD_RAT]: FIGHT_NO_THREAT,
    },
    maxTargetRangeM: 60_000,
    ...overrides,
  });
}

export function flyingAuto(overrides: Partial<CompanionLadderMemory> = {}): CompanionLadderMemory {
  return { ...freshLadderMemory(), flightMode: "auto", ...overrides };
}

/** A quiet tick on the commander: the formation order goes out and its latch is set. */
export function inFormation(memory: CompanionLadderMemory = freshLadderMemory()): CompanionDecision {
  const formed = decideCompanionAction(TWO_GUNS, companionObs({ snapshot: fightGrid({ rats: [] }) }), memory);
  assert.deepEqual(formed.action, { kind: "keepAtRange", targetID: FIGHT_FC_SHIP, range: FIGHT_FOLLOW_M });
  assert.equal(formed.memory.followAnchorID, FIGHT_FC_SHIP);
  return formed;
}

export const isMove = (action: FleetCompanionAction): boolean =>
  action.kind === "orbit" || action.kind === "keepAtRange" || action.kind === "approach";
