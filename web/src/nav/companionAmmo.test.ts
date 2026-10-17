// Ammo by target in the companion ladder: the swap step and the empty-gun
// ranking, mostly END TO END through `decideCompanionAction`, because the
// wiring (rung 7 standing, the lock-ahead's next target, the reload rung above
// rung 7) is what this file exists to pin. The ranking's own rules are pinned
// in ammoRanking.test.ts; the reach arithmetic in ammoReach.test.ts.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decideCompanionAction,
  freshLadderMemory,
  type CompanionDecision,
  type CompanionLadderMemory,
  type FleetCompanionObservation,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import {
  FRESH_COMPANION_AMMO,
  ammoSkipTrace,
  decideAmmoSwap,
  emptyGunAmmo,
  firingUnits,
  ratResonancesFromAttributes,
  weaponCycleFromAttributes,
  type AmmoLadder,
  type LoadedReachRecord,
} from "./companionAmmo.ts";
import { chargeFactsFromAttributes } from "./ammoReach.ts";
import type { CombatWeapon } from "./combatWeapons.ts";
import {
  FIGHT_GUN_1,
  FIGHT_GUN_2,
  RAT,
  RAT_2,
  TWO_GUNS,
  TYPE_LONG_RAT,
  TYPE_SHORT_RAT,
  fightGrid,
  fightObs,
} from "./fightFixtures.test-util.ts";
import type { SpaceSnapshot } from "../store/types.ts";

// ─── Fixtures (synthetic ids throughout) ─────────────────────────────────────

const ONE_GUN: FleetCompanionRequest = { ...TWO_GUNS, weaponModuleIDs: [FIGHT_GUN_1] };
const GUN_TYPE = 3001;
const HYBRID = 85;
/** Short range, the most raw damage: 12 a shot. Loaded, it reaches 20 km. */
const A = 9101;
/** Long range, little damage: 5 a shot. In the same gun it reaches 29 km. */
const B = 9102;
/** Short range like A, all thermal: 12 a shot. */
const C = 9103;
const STACK_A = 7001;
const STACK_B = 7002;
const STACK_C = 7003;

const CHARGES = {
  [A]: chargeFactsFromAttributes({ 117: 7, 118: 5, 120: 0.5, 128: 1 }, "Charge A"),
  [B]: chargeFactsFromAttributes({ 117: 3, 118: 2, 120: 0.8, 128: 1 }, "Charge B"),
  [C]: chargeFactsFromAttributes({ 118: 12, 120: 0.5, 128: 1 }, "Charge C"),
};

/** A gun loaded with `chargeTypeID`: measured optimal 15 km, reach 20 km (base optimal 30 km, falloff 5 km). */
function loadedGun(itemID: number, chargeTypeID: number | null = A): CombatWeapon {
  return {
    itemID, typeID: GUN_TYPE, chargeTypeID, chargeQuantity: chargeTypeID === null ? 0 : 40,
    acceptedGroups: [HYBRID], chargeSize: 1,
    reachM: chargeTypeID === null ? null : 20_000, optimalM: chargeTypeID === null ? null : 15_000, tracking: 0.1,
  };
}

function stack(itemID: number, typeID: number, quantity: number) {
  return { itemID, typeID, groupID: HYBRID, quantity };
}

const ALL_THREE = [stack(STACK_A, A, 1_000), stack(STACK_B, B, 500), stack(STACK_C, C, 500)];

/** Kinetic-resistant on every layer: C does 12, A does 7 x 0.2 + 5 = 6.4. */
const KINETIC_TANK = ratResonancesFromAttributes({ 273: 0.2, 269: 0.2, 109: 0.2 })!;

/** A grid with the rat (and optionally a second) at `x`, our guns cycling, banks as given. */
function grid(
  x: number,
  options: {
    readonly rats?: readonly { readonly itemID: number; readonly typeID: number; readonly x: number }[];
    readonly active?: readonly number[];
    readonly banks?: Readonly<Record<number, readonly number[]>>;
    readonly ratios?: Readonly<Record<number, { shieldRatio: number; armorRatio: number; hullRatio: number }>>;
  } = {},
): SpaceSnapshot {
  const base = fightGrid({
    rats: options.rats ?? [{ itemID: RAT, typeID: TYPE_LONG_RAT, x }],
    activeModuleIDs: options.active ?? [FIGHT_GUN_1],
  });
  return {
    ...base,
    ship: { ...base.ship!, weaponBanks: options.banks ?? {} },
    entities: base.entities.map((entity) =>
      options.ratios?.[entity.itemID] === undefined ? entity : { ...entity, ...options.ratios[entity.itemID] }),
  } as SpaceSnapshot;
}

function ammoObs(
  snapshot: SpaceSnapshot,
  overrides: Partial<FleetCompanionObservation> = {},
  weapons: readonly CombatWeapon[] = [loadedGun(FIGHT_GUN_1)],
): FleetCompanionObservation {
  return fightObs(weapons, snapshot, RAT, {
    cargoCharges: ALL_THREE,
    weaponChargeGroups: Object.fromEntries(weapons.map((weapon) => [weapon.itemID, [HYBRID]])),
    emptyWeaponModuleIDs: [],
    chargeFactsByTypeID: CHARGES,
    ...overrides,
  });
}

/** Rung 7 already firing the guns at RAT: its decision this tick is a standing readout. */
function firing(guns: readonly number[] = [FIGHT_GUN_1], base: CompanionLadderMemory = freshLadderMemory()): CompanionLadderMemory {
  return { ...base, lastFireTargetID: RAT, lastFireModuleIDs: [...guns] };
}

const T0 = 5_000_000;

function run(
  obsAt: (tick: number) => FleetCompanionObservation,
  ticks: number,
  memory: CompanionLadderMemory = firing(),
  request: FleetCompanionRequest = ONE_GUN,
): { readonly decisions: readonly CompanionDecision[]; readonly memory: CompanionLadderMemory } {
  const decisions: CompanionDecision[] = [];
  let mem = memory;
  for (let tick = 0; tick < ticks; tick++) {
    const decision = decideCompanionAction(request, obsAt(tick), mem, T0 + tick * 2_000);
    decisions.push(decision);
    mem = decision.memory;
  }
  return { decisions, memory: mem };
}

const loads = (decisions: readonly CompanionDecision[]): readonly CompanionDecision[] =>
  decisions.filter((decision) => decision.action.kind === "loadAmmo");

// ─── The swap, end to end ────────────────────────────────────────────────────

test("out of reach and unable to close: the longer charge is loaded after five ticks, once", () => {
  // Follow mode (the default): the ship cannot close. 25 km: past A's 20 km, inside B's 29 km.
  const { decisions } = run(() => ammoObs(grid(25_000)), 12);
  const swaps = loads(decisions);
  assert.equal(swaps.length, 1, "one swap, then the pending latch holds");
  assert.equal(decisions.indexOf(swaps[0]!), 4, "on the fifth tick, not before");
  assert.deepEqual(swaps[0]!.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_B });
  assert.match(swaps[0]!.why, /^Changing ammo to Charge B -- loading the longer-range charge/);
  assert.equal(swaps[0]!.phase, "Obeying fleet");
  assert.equal(swaps[0]!.followingOrderFrom, "tag");
  for (const decision of decisions.slice(0, 4)) {
    assert.equal(decision.action.kind, "wait", "the standing readout until then");
  }
});

test("an x / x+1 / x wobble across a reach edge issues no loadAmmo in 20 ticks", () => {
  // Across A's sticky edge (20 km + 500 m): A applies on every even tick.
  const acrossLoaded = run((tick) => ammoObs(grid(tick % 2 === 0 ? 20_500 : 20_501)), 20);
  assert.equal(loads(acrossLoaded.decisions).length, 0);
  // Across B's entry edge (29 km - 500 m), with A out of reach throughout.
  const acrossOther = run((tick) => ammoObs(grid(tick % 2 === 0 ? 28_500 : 28_501)), 20);
  assert.equal(loads(acrossOther.decisions).length, 0);
});

test("no swap while the ship can still close; once the closing budget is spent, it swaps", () => {
  const closing: CompanionLadderMemory = {
    ...firing(),
    flightMode: "auto",
    combatPosition: {
      hold: null, reform: false,
      target: { targetID: RAT, farTicks: 3, spentAtM: null, closing: true, leashed: false },
    },
  };
  const ladder: AmmoLadder = { nextTarget: () => null, remainingHitPoints: () => null };
  const obs = ammoObs(grid(25_000));
  let memory = closing;
  for (let tick = 0; tick < 10; tick++) {
    const step = decideAmmoSwap(ONE_GUN, obs, memory, RAT, T0 + tick * 2_000, ladder);
    assert.equal(step.swap, null, `closing beats reloading (tick ${tick})`);
    memory = step.memory;
  }
  const spent = {
    ...memory,
    combatPosition: { ...memory.combatPosition, target: { ...memory.combatPosition.target!, spentAtM: 25_000 } },
  };
  const step = decideAmmoSwap(ONE_GUN, obs, spent, RAT, T0 + 30_000, ladder);
  assert.deepEqual(step.swap?.moduleIDs, [FIGHT_GUN_1]);
  assert.equal(step.swap?.chargeItemID, STACK_B);
});

test("lock-ahead moment: the gun is loaded for the next target at once, then left alone", () => {
  const snapshot = grid(10_000, {
    rats: [{ itemID: RAT, typeID: TYPE_LONG_RAT, x: 10_000 }, { itemID: RAT_2, typeID: TYPE_SHORT_RAT, x: 12_000 }],
    ratios: { [RAT]: { shieldRatio: 0, armorRatio: 0, hullRatio: 0.5 } },
  });
  const obs = ammoObs(snapshot, {
    lockedTargetIDs: [RAT, RAT_2],
    hitPointsByTypeID: { [TYPE_LONG_RAT]: { shield: 1_000, armor: 1_000, hull: 1_000 } },
    ratResonancesByTypeID: { [TYPE_SHORT_RAT]: KINETIC_TANK },
  });
  const { decisions } = run(() => obs, 6);
  assert.deepEqual(decisions[0]!.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_C },
    "no persistence on the lock-ahead tick");
  assert.match(decisions[0]!.why, /Charge C -- loading the better charge for the next target/);
  assert.equal(loads(decisions).length, 1, "the pending latch holds after it");

  // The same grid with the current target healthy: nothing is loaded for the next one.
  const healthy = grid(10_000, {
    rats: [{ itemID: RAT, typeID: TYPE_LONG_RAT, x: 10_000 }, { itemID: RAT_2, typeID: TYPE_SHORT_RAT, x: 12_000 }],
    ratios: { [RAT]: { shieldRatio: 1, armorRatio: 1, hullRatio: 1 } },
  });
  const calm = run(() => ammoObs(healthy, {
    lockedTargetIDs: [RAT, RAT_2],
    hitPointsByTypeID: { [TYPE_LONG_RAT]: { shield: 1_000, armor: 1_000, hull: 1_000 } },
    ratResonancesByTypeID: { [TYPE_SHORT_RAT]: KINETIC_TANK },
  }), 8);
  assert.equal(loads(calm.decisions).length, 0, "A and C are equal against the current target");
});

test("one ammo type aboard never swaps, however long the target sits out of reach", () => {
  const { decisions } = run(() => ammoObs(grid(25_000), { cargoCharges: [stack(STACK_A, A, 1_000)] }), 20);
  assert.equal(loads(decisions).length, 0);
});

test("a charge that is clearly better against the target is swapped in mid-fight after persistence", () => {
  const snapshot = grid(10_000, { ratios: { [RAT]: { shieldRatio: 1, armorRatio: 1, hullRatio: 1 } } });
  const { decisions } = run(() => ammoObs(snapshot, {
    hitPointsByTypeID: { [TYPE_LONG_RAT]: { shield: 50_000, armor: 50_000, hull: 50_000 } },
    ratResonancesByTypeID: { [TYPE_LONG_RAT]: KINETIC_TANK },
    weaponCycleByTypeID: { [GUN_TYPE]: weaponCycleFromAttributes({ 51: 4_000, 64: 2 })! },
  }), 8);
  const swaps = loads(decisions);
  assert.equal(swaps.length, 1);
  assert.equal(decisions.indexOf(swaps[0]!), 4);
  assert.equal((swaps[0]!.action as { chargeItemID: number }).chargeItemID, STACK_C);

  // A target that dies before the reload pays off is not swapped for.
  const fragile = run(() => ammoObs(snapshot, {
    // 30 HP left; the reload's silence costs 6.4 x 2 x (10 s / 4 s) = 32.
    hitPointsByTypeID: { [TYPE_LONG_RAT]: { shield: 10, armor: 10, hull: 10 } },
    ratResonancesByTypeID: { [TYPE_LONG_RAT]: KINETIC_TANK },
    weaponCycleByTypeID: { [GUN_TYPE]: weaponCycleFromAttributes({ 51: 4_000, 64: 2 })! },
  }), 8);
  assert.equal(loads(fragile.decisions).length, 0);
});

test("banked guns swap together, in one call, remembered once", () => {
  const snapshot = grid(25_000, { active: [FIGHT_GUN_1], banks: { [FIGHT_GUN_1]: [FIGHT_GUN_2] } });
  const weapons = [loadedGun(FIGHT_GUN_1), loadedGun(FIGHT_GUN_2)];
  const { decisions, memory } = run(() => ammoObs(snapshot, {}, weapons), 6, firing([FIGHT_GUN_1, FIGHT_GUN_2]), TWO_GUNS);
  const swaps = loads(decisions);
  assert.equal(swaps.length, 1);
  assert.deepEqual(swaps[0]!.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1, FIGHT_GUN_2], chargeItemID: STACK_B });
  assert.match(swaps[0]!.why, /\(2 guns\)/);
  assert.deepEqual(Object.keys(memory.ammo.swap), [String(FIGHT_GUN_1)]);

  // Two unbanked guns that pick the same stack on the same tick also share the call.
  const loose = run(() => ammoObs(grid(25_000, { active: [FIGHT_GUN_1, FIGHT_GUN_2] }), {}, weapons), 6,
    firing([FIGHT_GUN_1, FIGHT_GUN_2]), TWO_GUNS);
  assert.deepEqual(loads(loose.decisions).map((decision) => decision.action),
    [{ kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1, FIGHT_GUN_2], chargeItemID: STACK_B }]);
});

test("firing units: a bank is one unit led by its master, in the request's order", () => {
  assert.deepEqual(firingUnits([1, 2, 3, 4], { 2: [4] }), [[1], [2, 4], [3]]);
  assert.deepEqual(firingUnits([1, 2], null), [[1], [2]]);
  assert.deepEqual(firingUnits([4, 2], { 2: [4] }), [[2, 4]], "a slave picked first still names the bank");
});

// ─── Empty guns ──────────────────────────────────────────────────────────────

test("an empty gun takes the ranked stack when the target is known, the largest otherwise", () => {
  const empty = [loadedGun(FIGHT_GUN_1, null)];
  const known = {
    ...FRESH_COMPANION_AMMO,
    targetID: RAT,
    lastLoaded: { [FIGHT_GUN_1]: { chargeTypeID: A, reachM: 20_000, optimalM: 15_000, turret: true } },
  };
  const obs = ammoObs(grid(25_000, { active: [] }), { emptyWeaponModuleIDs: [FIGHT_GUN_1] }, empty);
  const ranked = decideCompanionAction(ONE_GUN, obs, { ...freshLadderMemory(), ammo: known }, T0);
  assert.deepEqual(ranked.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_B },
    "B reaches the rat at 25 km; the larger A stack does not");

  const unknown = decideCompanionAction(ONE_GUN, obs, freshLadderMemory(), T0);
  assert.deepEqual(unknown.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_A },
    "no target known: today's largest-stack rule");
});

test("a loaded gun's measured reach is remembered for when it runs dry; the engaged target too", () => {
  const { memory } = run(() => ammoObs(grid(10_000)), 1);
  assert.deepEqual(memory.ammo.lastLoaded[FIGHT_GUN_1], { chargeTypeID: A, reachM: 20_000, optimalM: 15_000, turret: true });
  assert.equal(memory.ammo.targetID, RAT);
});

test("rat resonances: absent attributes are no resist; an unknown type is unknown", () => {
  assert.deepEqual(KINETIC_TANK.shield, { em: 1, thermal: 1, kinetic: 0.2, explosive: 1 });
  assert.equal(ratResonancesFromAttributes({}), null);
  assert.equal(ratResonancesFromAttributes(undefined), null);
  const full = ratResonancesFromAttributes({
    271: 0.1, 274: 0.2, 273: 0.3, 272: 0.4, 267: 0.5, 270: 0.6, 269: 0.7, 268: 0.8, 113: 0.9, 110: 0.11, 109: 0.12, 111: 0.13,
  })!;
  assert.deepEqual(full.shield, { em: 0.1, thermal: 0.2, kinetic: 0.3, explosive: 0.4 });
  assert.deepEqual(full.armor, { em: 0.5, thermal: 0.6, kinetic: 0.7, explosive: 0.8 });
  assert.deepEqual(full.hull, { em: 0.9, thermal: 0.11, kinetic: 0.12, explosive: 0.13 });
});

// ─── The decision trace ──────────────────────────────────────────────────────

const NO_LADDER: AmmoLadder = { nextTarget: () => null, remainingHitPoints: () => null };

/** `ticks` calls of the swap step 2 s apart, memory carried; the steps in order. */
function steps(
  obs: FleetCompanionObservation,
  ticks: number,
  request: FleetCompanionRequest = ONE_GUN,
  ladder: AmmoLadder = NO_LADDER,
  engaged: number = RAT,
): readonly ReturnType<typeof decideAmmoSwap>[] {
  const out: ReturnType<typeof decideAmmoSwap>[] = [];
  let memory = firing();
  for (let tick = 0; tick < ticks; tick++) {
    const step = decideAmmoSwap(request, obs, memory, engaged, T0 + tick * 2_000, ladder);
    out.push(step);
    memory = step.memory;
  }
  return out;
}

test("a gun with a load in flight is not swapped until its reload window has passed", () => {
  // The reload rung sent a load at T0 (`reloadInFlight`); the gun may still read
  // loaded for a tick or two, and a swap on top of a reload in progress would
  // queue a second one. Skipped as an empty gun is, then judged normally.
  const firstSwapTick = (memory: CompanionLadderMemory): number => {
    let mem = memory;
    for (let tick = 0; tick < 16; tick++) {
      const step = decideAmmoSwap(ONE_GUN, ammoObs(grid(25_000)), mem, RAT, T0 + tick * 2_000, NO_LADDER);
      if (step.swap !== null) {
        return tick;
      }
      mem = step.memory;
    }
    return -1;
  };
  assert.equal(firstSwapTick(firing()), 4, "control: five persisting ticks and it swaps");
  const sent = firstSwapTick({ ...firing(), reloadInFlight: { [FIGHT_GUN_1]: T0 } });
  // The default reload (12 s) + the 1.5 s margin: ticks 0-6 are inside it.
  assert.ok(sent >= 7, `no swap while the reload is running, swapped on tick ${sent}`);
  const first = decideAmmoSwap(
    ONE_GUN, ammoObs(grid(25_000)), { ...firing(), reloadInFlight: { [FIGHT_GUN_1]: T0 } }, RAT, T0, NO_LADDER);
  assert.equal(first.trace.units[0]!.code, "gun-empty");
});

test("trace: each early return says why the step looked at no gun", () => {
  const obs = ammoObs(grid(10_000));
  const skipOf = (request: FleetCompanionRequest, o: FleetCompanionObservation, engaged: number = RAT) =>
    decideAmmoSwap(request, o, firing(), engaged, T0, NO_LADDER);

  const noSnapshot = skipOf(ONE_GUN, { ...obs, snapshot: null });
  assert.equal(noSnapshot.trace.skipped, "no-snapshot");
  assert.equal(skipOf(ONE_GUN, { ...obs, inSpace: false }).trace.skipped, "no-snapshot", "docked");
  assert.equal(skipOf(ONE_GUN, { ...obs, inWarp: true }).trace.skipped, "no-snapshot", "in warp");
  assert.equal(skipOf(ONE_GUN, { ...obs, combatWeapons: null }).trace.skipped, "no-weapons", "rack unread");
  assert.equal(skipOf({ ...ONE_GUN, weaponModuleIDs: [] }, obs).trace.skipped, "no-weapons", "no guns requested");
  assert.equal(skipOf(ONE_GUN, { ...obs, cargoCharges: null }).trace.skipped, "no-cargo");
  const offGrid = skipOf(ONE_GUN, obs, RAT_2);
  assert.equal(offGrid.trace.skipped, "no-target", "the engaged ship is not on the grid");
  assert.equal(offGrid.trace.targetID, RAT_2);

  for (const step of [noSnapshot, offGrid]) {
    assert.equal(step.swap, null);
    assert.deepEqual(step.trace.units, []);
    assert.equal(step.trace.distanceM, null);
    assert.equal(step.trace.nextTargetMoment, false);
  }

  // The one skip that happens before the step is reached is built by the caller.
  assert.deepEqual(ammoSkipTrace("not-engaged"), {
    skipped: "not-engaged", targetID: null, distanceM: null, nextTargetMoment: false, canClose: false, units: [],
  });
  // A tick that does look at the guns says so.
  assert.equal(skipOf(ONE_GUN, obs).trace.skipped, null);
});

test("trace: the keep reasons land in the trace, with the numbers the gate used", () => {
  const sequence = steps(ammoObs(grid(25_000)), 6);
  assert.deepEqual(sequence.map((step) => step.trace.units[0]!.code),
    ["persisting", "persisting", "persisting", "persisting", "swap", "reload-pending"]);
  const first = sequence[0]!.trace;
  assert.equal(first.skipped, null);
  assert.equal(first.targetID, RAT);
  assert.equal(first.distanceM, 25_000);
  assert.equal(first.nextTargetMoment, false);
  assert.equal(first.canClose, false);
  assert.deepEqual(first.units[0], {
    leadID: FIGHT_GUN_1, code: "persisting", loadedTypeID: A, wantedTypeID: B, wantedTicks: 1, pending: false,
  });
  assert.equal(sequence[3]!.trace.units[0]!.wantedTicks, 4);
  assert.deepEqual(sequence[4]!.trace.units[0], {
    leadID: FIGHT_GUN_1, code: "swap", loadedTypeID: A, wantedTypeID: B, wantedTicks: 5, pending: true,
  });
  assert.equal(sequence[4]!.swap?.chargeItemID, STACK_B);
  assert.equal(sequence[5]!.swap, null);
  assert.equal(sequence[5]!.trace.units[0]!.pending, true, "the reload in flight");

  // At close range the loaded charge is already the best.
  const near = steps(ammoObs(grid(10_000)), 1)[0]!;
  assert.equal(near.trace.units[0]!.code, "already-best");
  assert.equal(near.trace.units[0]!.wantedTypeID, null);
  assert.equal(near.swap, null);
});

test("trace: closing in is a code, and canClose is carried", () => {
  const closing: CompanionLadderMemory = {
    ...firing(),
    flightMode: "auto",
    combatPosition: {
      hold: null, reform: false,
      target: { targetID: RAT, farTicks: 3, spentAtM: null, closing: true, leashed: false },
    },
  };
  const step = decideAmmoSwap(ONE_GUN, ammoObs(grid(25_000)), closing, RAT, T0, NO_LADDER);
  assert.equal(step.swap, null);
  assert.equal(step.trace.canClose, true);
  assert.equal(step.trace.units[0]!.code, "closing-instead");
});

test("trace: the wobble across a reach edge swaps nothing and every tick carries a keep code", () => {
  let memory = firing();
  for (let tick = 0; tick < 20; tick++) {
    const obs = ammoObs(grid(tick % 2 === 0 ? 20_500 : 20_501));
    const step = decideAmmoSwap(ONE_GUN, obs, memory, RAT, T0 + tick * 2_000, NO_LADDER);
    assert.equal(step.swap, null, `tick ${tick}`);
    assert.equal(step.trace.units.length, 1);
    assert.notEqual(step.trace.units[0]!.code, "swap");
    memory = step.memory;
  }
});

test("trace: the next-target moment ranks against the next ship and says so", () => {
  const snapshot = grid(10_000, {
    rats: [{ itemID: RAT, typeID: TYPE_LONG_RAT, x: 10_000 }, { itemID: RAT_2, typeID: TYPE_SHORT_RAT, x: 12_000 }],
    ratios: { [RAT]: { shieldRatio: 0, armorRatio: 0, hullRatio: 0.5 } },
  });
  const obs = ammoObs(snapshot, {
    lockedTargetIDs: [RAT, RAT_2],
    hitPointsByTypeID: { [TYPE_LONG_RAT]: { shield: 1_000, armor: 1_000, hull: 1_000 } },
    ratResonancesByTypeID: { [TYPE_SHORT_RAT]: KINETIC_TANK },
  });
  const ladder: AmmoLadder = {
    nextTarget: (o) => o.snapshot?.entities.find((entity) => entity.itemID === RAT_2) ?? null,
    remainingHitPoints: () => 100,
  };
  const step = steps(obs, 1, ONE_GUN, ladder)[0]!;
  assert.equal(step.trace.nextTargetMoment, true);
  assert.equal(step.trace.targetID, RAT_2, "the ranking target, not the engaged one");
  assert.equal(step.trace.distanceM, 12_000);
  assert.equal(step.trace.units[0]!.code, "swap");
  assert.equal(step.swap?.chargeItemID, STACK_C);
});

test("trace: a gun with no row is gun-unread, an empty gun is gun-empty, both beside a considered one", () => {
  const unread = steps(ammoObs(grid(25_000, { active: [FIGHT_GUN_1, FIGHT_GUN_2] }), {}, [loadedGun(FIGHT_GUN_1)]), 1, TWO_GUNS)[0]!;
  assert.deepEqual(unread.trace.units.map((unit) => [unit.leadID, unit.code]),
    [[FIGHT_GUN_1, "persisting"], [FIGHT_GUN_2, "gun-unread"]]);
  assert.equal(unread.trace.units[1]!.loadedTypeID, null);

  const weapons = [loadedGun(FIGHT_GUN_1), loadedGun(FIGHT_GUN_2, null)];
  const empty = steps(
    ammoObs(grid(25_000, { active: [FIGHT_GUN_1] }), { emptyWeaponModuleIDs: [FIGHT_GUN_2] }, weapons), 1, TWO_GUNS)[0]!;
  assert.deepEqual(empty.trace.units.map((unit) => [unit.leadID, unit.code]),
    [[FIGHT_GUN_1, "persisting"], [FIGHT_GUN_2, "gun-empty"]]);
  assert.equal(empty.swap, null);

  // A bank with one empty member is the reload rung's, as one unit led by its master.
  const banked = steps(
    ammoObs(grid(25_000, { banks: { [FIGHT_GUN_1]: [FIGHT_GUN_2] } }), { emptyWeaponModuleIDs: [FIGHT_GUN_2] },
      [loadedGun(FIGHT_GUN_1), loadedGun(FIGHT_GUN_2)]), 1, TWO_GUNS)[0]!;
  assert.deepEqual(banked.trace.units.map((unit) => [unit.leadID, unit.code]), [[FIGHT_GUN_1, "gun-empty"]]);
});

test("trace: a unit that would swap to another stack than the one already chosen is other-stack-chosen", () => {
  // Gun 2 takes group 86 only, and its only way to B is a stack in that group.
  const OTHER_GROUP = 86;
  const STACK_B_OTHER = 7004;
  const cargo = [...ALL_THREE, { itemID: STACK_B_OTHER, typeID: B, groupID: OTHER_GROUP, quantity: 500 }];
  const weapons = [loadedGun(FIGHT_GUN_1), { ...loadedGun(FIGHT_GUN_2), acceptedGroups: [OTHER_GROUP] }];
  const obs = ammoObs(grid(25_000, { active: [FIGHT_GUN_1, FIGHT_GUN_2] }), {
    cargoCharges: cargo,
    weaponChargeGroups: { [FIGHT_GUN_1]: [HYBRID], [FIGHT_GUN_2]: [OTHER_GROUP] },
  }, weapons);
  const sequence = steps(obs, 5, TWO_GUNS);
  for (const step of sequence.slice(0, 4)) {
    assert.deepEqual(step.trace.units.map((unit) => unit.code), ["persisting", "persisting"]);
  }
  const fifth = sequence[4]!;
  assert.deepEqual(fifth.trace.units.map((unit) => unit.code), ["swap", "other-stack-chosen"]);
  assert.deepEqual(fifth.swap?.moduleIDs, [FIGHT_GUN_1], "only the first stack is called");
  assert.equal(fifth.swap?.chargeItemID, STACK_B);
  const second = fifth.trace.units[1]!;
  assert.equal(second.wantedTypeID, B);
  assert.equal(second.wantedTicks, 5);
  assert.equal(second.pending, false, "it keeps last tick's memory and gets its turn next tick");
  assert.equal(fifth.memory.ammo.swap[FIGHT_GUN_2]!.wantedTicks, 4, "unchanged by the other call");
});

// ─── Empty guns: which rule chose ────────────────────────────────────────────

test("emptyGunAmmo: the rule says ranked when the target is known and a stack ranks, largest otherwise", () => {
  const empty = [loadedGun(FIGHT_GUN_1, null)];
  const known = {
    ...FRESH_COMPANION_AMMO,
    targetID: RAT,
    lastLoaded: { [FIGHT_GUN_1]: { chargeTypeID: A, reachM: 20_000, optimalM: 15_000, turret: true } },
  };
  const obs = ammoObs(grid(25_000, { active: [] }), { emptyWeaponModuleIDs: [FIGHT_GUN_1] }, empty);

  const ranked = emptyGunAmmo(obs, { ...freshLadderMemory(), ammo: known });
  assert.deepEqual(ranked.pickWithRule(FIGHT_GUN_1, ALL_THREE), { charge: ALL_THREE[1], rule: "ranked" });
  assert.equal(ranked.pick(FIGHT_GUN_1, ALL_THREE), ALL_THREE[1], "pick returns the same stack as before");

  const noTarget = emptyGunAmmo(obs, freshLadderMemory());
  assert.deepEqual(noTarget.pickWithRule(FIGHT_GUN_1, ALL_THREE), { charge: null, rule: "largest" });
  assert.equal(noTarget.pick(FIGHT_GUN_1, ALL_THREE), null);

  // A known target but nothing the gun certainly takes: the reload rung's rule stands.
  const wrongGroup = ALL_THREE.map((charge) => ({ ...charge, groupID: 86 }));
  assert.deepEqual(ranked.pickWithRule(FIGHT_GUN_1, wrongGroup), { charge: null, rule: "largest" });
  assert.equal(ranked.pick(FIGHT_GUN_1, wrongGroup), null);
});

// ─── A clear grid (operator, 2026-10-14) ─────────────────────────────────────
//
// "When the companion determines that the grid is clear and decides to recall
// drones ... it should as well reload weapons. Just reload all." Empty guns:
// own charge, else the other guns' charge, else the most versatile.

/** The last charge a gun measured: C, gone from cargo in these tests unless put back. */
const LAST_C = { chargeTypeID: C, reachM: 20_000, optimalM: 15_000, turret: true } as const;

/** No rat, nothing called or locked, `hostileOnGrid` a confident false. */
function clearObs(
  weapons: readonly CombatWeapon[],
  overrides: Partial<FleetCompanionObservation> = {},
  fcOnGrid = true,
): FleetCompanionObservation {
  const quiet = fightGrid({ rats: [], fcAt: fcOnGrid ? -5_000 : null });
  return ammoObs(quiet, {
    hostileOnGrid: false,
    fleetTargetTags: null,
    lockedTargetIDs: [],
    ...overrides,
  }, weapons);
}

function withLastLoaded(records: Readonly<Record<number, LoadedReachRecord>>): CompanionLadderMemory {
  return { ...freshLadderMemory(), ammo: { ...FRESH_COMPANION_AMMO, lastLoaded: records } };
}

test("a clear grid reloads every loaded gun with the charge it has, once per gun", () => {
  const weapons = [loadedGun(FIGHT_GUN_1, A), loadedGun(FIGHT_GUN_2, B)];
  const { decisions, memory } = run(() => clearObs(weapons), 8, freshLadderMemory(), TWO_GUNS);
  assert.deepEqual(loads(decisions).map((decision) => decision.action), [
    { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_A },
    { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_2], chargeItemID: STACK_B },
  ], "one call per charge type, then never again on this clear grid");
  assert.equal(decisions[0]!.why, "The grid is clear: reloading the guns (a gun, Charge A).");
  assert.deepEqual([...memory.ammo.clearGridToppedUp].sort(), [FIGHT_GUN_1, FIGHT_GUN_2].sort());

  // Guns on the same charge share the call.
  const same = run(() => clearObs([loadedGun(FIGHT_GUN_1, A), loadedGun(FIGHT_GUN_2, A)]), 6,
    freshLadderMemory(), TWO_GUNS);
  assert.deepEqual(loads(same.decisions).map((decision) => decision.action),
    [{ kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1, FIGHT_GUN_2], chargeItemID: STACK_A }]);
  assert.equal(loads(same.decisions)[0]!.why, "The grid is clear: reloading the guns (2 guns, Charge A).");
});

test("a clear grid: a gun whose charge is gone from cargo is not topped up", () => {
  const { decisions } = run(() => clearObs([loadedGun(FIGHT_GUN_1, A)], {
    cargoCharges: [stack(STACK_B, B, 500)],
  }), 4, freshLadderMemory());
  assert.equal(loads(decisions).length, 0);
});

test("no top-up while hostiles remain, on a read that stumbled, or on a called target", () => {
  const weapons = [loadedGun(FIGHT_GUN_1, A)];
  const fighting = run(() => clearObs(weapons, { hostileOnGrid: true }), 6, freshLadderMemory());
  assert.equal(loads(fighting.decisions).length, 0, "hostiles on grid");
  const blind = run(() => clearObs(weapons, { hostileOnGrid: null }), 6, freshLadderMemory());
  assert.equal(loads(blind.decisions).length, 0, "null is a failed read, never a clear grid");
  // A called, locked target the NPC count does not see: rung 7 stands on it.
  const called = run(() => ammoObs(grid(10_000), { hostileOnGrid: false }), 6);
  assert.equal(loads(called.decisions).length, 0, "a called target is a fight");
});

test("a fight starting again re-arms the clear-grid top-up", () => {
  const weapons = [loadedGun(FIGHT_GUN_1, A)];
  const first = run(() => clearObs(weapons), 3, freshLadderMemory());
  assert.equal(loads(first.decisions).length, 1);
  const fight = decideCompanionAction(ONE_GUN, clearObs(weapons, { hostileOnGrid: true }), first.memory, T0 + 10_000);
  assert.deepEqual(fight.memory.ammo.clearGridToppedUp, [], "re-armed");
  const second = run(() => clearObs(weapons), 3, fight.memory);
  assert.deepEqual(loads(second.decisions).map((decision) => decision.action),
    [{ kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_A }], "the next clear grid reloads again");
});

test("a clear grid: an empty gun takes its own last charge back while any is aboard", () => {
  const memory = withLastLoaded({ [FIGHT_GUN_1]: { ...LAST_C, chargeTypeID: B } });
  const decision = decideCompanionAction(ONE_GUN, clearObs([loadedGun(FIGHT_GUN_1, null)], {
    emptyWeaponModuleIDs: [FIGHT_GUN_1],
  }), memory, T0);
  assert.deepEqual(decision.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_B },
    "B, its own, and not the larger A stack");
  assert.equal(decision.why, "The grid is clear: a gun is empty. Loading Charge B again.");
});

test("a clear grid: one empty gun next to loaded guns takes their charge, not the most versatile", () => {
  // GUN_2 runs on C; A is the bigger stack AND the more versatile one (equal
  // score, more of it), so only the match rule picks C.
  const weapons = [loadedGun(FIGHT_GUN_1, null), loadedGun(FIGHT_GUN_2, C)];
  const decision = decideCompanionAction(TWO_GUNS, clearObs(weapons, { emptyWeaponModuleIDs: [FIGHT_GUN_1] }),
    freshLadderMemory(), T0);
  assert.deepEqual(decision.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_C });
  assert.equal(decision.why,
    "The grid is clear: a gun is empty and its ammo is gone. Loading Charge C to match the other guns.");
});

test("a clear grid: every gun empty and their charge gone -- the most versatile charge", () => {
  // Last loaded C, which is gone. B is the biggest stack (the rung's old rule);
  // A is the most versatile: 12 x 20 km against B's 5 x 29 km.
  const memory = withLastLoaded({ [FIGHT_GUN_1]: LAST_C, [FIGHT_GUN_2]: LAST_C });
  const weapons = [loadedGun(FIGHT_GUN_1, null), loadedGun(FIGHT_GUN_2, null)];
  const decision = decideCompanionAction(TWO_GUNS, clearObs(weapons, {
    emptyWeaponModuleIDs: [FIGHT_GUN_1, FIGHT_GUN_2],
    cargoCharges: [stack(STACK_A, A, 100), stack(STACK_B, B, 1_000)],
  }), memory, T0);
  assert.deepEqual(decision.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1, FIGHT_GUN_2], chargeItemID: STACK_A });
  assert.equal(decision.why,
    "The grid is clear: 2 guns are empty and their ammo is gone. Loading Charge A, the most versatile I carry.");
});

test("a clear grid: the loaded guns' charge is not in cargo either -- the most versatile charge", () => {
  const memory = withLastLoaded({ [FIGHT_GUN_1]: LAST_C });
  const weapons = [loadedGun(FIGHT_GUN_1, null), loadedGun(FIGHT_GUN_2, C)];
  const decision = decideCompanionAction(TWO_GUNS, clearObs(weapons, {
    emptyWeaponModuleIDs: [FIGHT_GUN_1],
    cargoCharges: [stack(STACK_A, A, 100), stack(STACK_B, B, 1_000)],
  }), memory, T0);
  assert.deepEqual(decision.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_A });
  assert.match(decision.why, /Loading Charge A, the most versatile I carry\.$/);
});

test("a clear grid: nothing aboard fits an empty gun -- no load, and a readout saying so", () => {
  const weapons = [loadedGun(FIGHT_GUN_1, null)];
  const obs = clearObs(weapons, {
    emptyWeaponModuleIDs: [FIGHT_GUN_1],
    cargoCharges: [{ itemID: STACK_A, typeID: A, groupID: 86, quantity: 1_000 }],
  }, false);
  const { decisions } = run(() => obs, 5, freshLadderMemory());
  assert.equal(loads(decisions).length, 0, "nothing is loaded, and no attempt is spent guessing");
  assert.equal(decisions[0]!.why, "The grid is clear: a gun is empty and nothing in the cargo bay fits it.");

  // A stack whose group could not be decoded is "cannot say": the rung's own rule loads it.
  const undecoded = decideCompanionAction(ONE_GUN, clearObs(weapons, {
    emptyWeaponModuleIDs: [FIGHT_GUN_1],
    cargoCharges: [{ itemID: STACK_A, typeID: A, groupID: null, quantity: 1_000 }],
  }, false), freshLadderMemory(), T0);
  assert.deepEqual(undecoded.action, { kind: "loadAmmo", moduleIDs: [FIGHT_GUN_1], chargeItemID: STACK_A });
});
