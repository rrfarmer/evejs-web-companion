import test from "node:test";
import assert from "node:assert/strict";

import {
  FRESH_COMPANION_UTILITIES,
  MAX_UTILITY_START_ATTEMPTS,
  MAX_UTILITY_STOP_ATTEMPTS,
  UTILITY_ACTIVATION_GRACE_MS,
  UTILITY_STOP_RETRY_MS,
  decideCompanionUtilities,
  decideUtilityRung,
  utilitiesAfterWarp,
  type CompanionUtilityFamily,
  type CompanionUtilityInputs,
  type CompanionUtilityMemory,
} from "./companionUtilities.ts";
import type { CombatUtilities, CombatUtility } from "./combatUtilities.ts";

// Synthetic ids throughout: the ship, the rats, and one module per family.
const SHIP = 100001;
const RAT = 200100;
const RAT_2 = 200101;
const WEB = 300001;
const PAINTER = 300002;
const SENSOR = 300003;
const TRACKING = 300004;
const T0 = 1_000_000;

const SPEC: Readonly<Record<CompanionUtilityFamily, readonly [number, number]>> = {
  web: [65, 6426], painter: [379, 6425], sensor: [212, 2670], tracking: [213, 4559],
};

function utility(itemID: number, family: CompanionUtilityFamily, overrides: Partial<CombatUtility> = {}): CombatUtility {
  const [groupID, effectID] = SPEC[family];
  const typeID = 5000 + groupID;
  return {
    itemID, typeID, family, effectID, active: false, targetID: null,
    rangeM: family === "web" || family === "painter" ? 10_000 : null,
    falloffM: null, capNeed: 10, modeKnown: true,
    type: { typeID, groupID, categoryID: 7, effects: [effectID], attributes: {}, capacity: null, volume: null },
    charge: null, quantity: 0, chargeUnits: null,
    ...overrides,
  };
}

function facts(modules: readonly CombatUtility[], capacitor: number | null = 1_000): CombatUtilities {
  return { shipID: SHIP, modules, cargo: null, capacitor, capacitorRatio: capacitor === null ? null : 1 };
}

const ALL = facts([utility(WEB, "web"), utility(PAINTER, "painter"), utility(SENSOR, "sensor"), utility(TRACKING, "tracking")]);

function inputs(overrides: Partial<CompanionUtilityInputs> = {}): CompanionUtilityInputs {
  return {
    facts: ALL,
    shipID: SHIP,
    activeModuleIDs: [],
    engagedTargetID: RAT,
    targetLocked: true,
    targetDistanceM: 5_000,
    fightOn: true,
    hasTurrets: true,
    hasDamage: true,
    capacitorRatio: 0.8,
    capacitorFloor: 0.2,
    nowMs: T0,
    ...overrides,
  };
}

/** A record that owns `itemID`, switched on at `targetID` long enough ago to be past its grace. */
function owning(family: CompanionUtilityFamily, itemID: number, targetID: number, extra: Partial<CompanionUtilityMemory> = {}): CompanionUtilityMemory {
  return {
    ...FRESH_COMPANION_UTILITIES,
    shipID: SHIP,
    owned: [{ itemID, typeID: 5000 + SPEC[family][0], family, targetID, sinceMs: T0 - 60_000, seen: true }],
    ...extra,
  };
}

const only = (...modules: CombatUtility[]): CombatUtilities => facts(modules);

// --- web and painter ---------------------------------------------------------

test("a web goes on the engaged, locked target inside its optimal, and is owned", () => {
  const step = decideCompanionUtilities(inputs({ facts: only(utility(WEB, "web")) }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(step.call, { kind: "activate", moduleID: WEB, targetID: RAT });
  assert.equal(step.why, "Webbing the target.");
  assert.deepEqual(step.memory.owned.map((own) => [own.itemID, own.targetID]), [[WEB, RAT]]);
  assert.equal(step.memory.shipID, SHIP);
});

test("a web stays off outside its optimal, on an unlocked target, with no target, or with an unknown optimal", () => {
  const web = only(utility(WEB, "web"));
  for (const over of [
    { targetDistanceM: 12_000 },
    { targetLocked: false },
    { engagedTargetID: null },
    { targetDistanceM: null },
    { facts: only(utility(WEB, "web", { rangeM: null })) },
  ] as Partial<CompanionUtilityInputs>[]) {
    const step = decideCompanionUtilities(inputs({ facts: web, ...over }), FRESH_COMPANION_UTILITIES);
    assert.equal(step.call, null, JSON.stringify(over));
  }
});

test("the web's edge is sticky: a target wobbling across the optimal does not toggle it", () => {
  const web = only(utility(WEB, "web"));
  // In from the plain edge at 9.8 km, then held across 10.2 km (inside the margin).
  const on = decideCompanionUtilities(inputs({ facts: web, targetDistanceM: 9_800 }), FRESH_COMPANION_UTILITIES);
  assert.equal(on.call?.kind, "activate");
  const held = decideCompanionUtilities(
    inputs({ facts: web, targetDistanceM: 10_200, activeModuleIDs: [WEB], nowMs: T0 + 2_000 }), on.memory);
  assert.equal(held.call, null, "10.2 km is inside the margin: the web keeps running");
  // Past the margin, it goes off.
  const off = decideCompanionUtilities(
    inputs({ facts: web, targetDistanceM: 10_600, activeModuleIDs: [WEB], nowMs: T0 + 4_000 }), held.memory);
  assert.deepEqual(off.call, { kind: "deactivate", moduleID: WEB, typeID: 5065 });
  assert.equal(off.why, "Target out of range: switching the stasis webifier off.");
});

test("a web judged out stays off until the target is well inside again", () => {
  const web = only(utility(WEB, "web"));
  let memory = FRESH_COMPANION_UTILITIES;
  for (const x of [10_600, 9_800, 10_200]) {
    const step = decideCompanionUtilities(inputs({ facts: web, targetDistanceM: x }), memory);
    assert.equal(step.call, null, `at ${x}`);
    memory = step.memory;
  }
  const inside = decideCompanionUtilities(inputs({ facts: web, targetDistanceM: 9_400 }), memory);
  assert.deepEqual(inside.call, { kind: "activate", moduleID: WEB, targetID: RAT });
});

test("an owned web goes off when the engagement moves on, or the target is gone", () => {
  const web = only(utility(WEB, "web"));
  const memory = owning("web", WEB, RAT);
  const moved = decideCompanionUtilities(inputs({ facts: web, engagedTargetID: RAT_2, activeModuleIDs: [WEB] }), memory);
  assert.deepEqual(moved.call, { kind: "deactivate", moduleID: WEB, typeID: 5065 });
  assert.equal(moved.why, "The target changed: switching the stasis webifier off.");
  const gone = decideCompanionUtilities(
    inputs({ facts: web, engagedTargetID: null, targetLocked: false, activeModuleIDs: [WEB] }), memory);
  assert.deepEqual(gone.call, { kind: "deactivate", moduleID: WEB, typeID: 5065 });
  assert.equal(gone.why, "No target engaged: switching the stasis webifier off.");
});

test("a web that stopped on its own (the target died) is forgotten without a call", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web")), engagedTargetID: null, targetLocked: false }), owning("web", WEB, RAT));
  assert.equal(step.call, null);
  assert.deepEqual(step.memory.owned, []);
});

test("a painter goes on only while something is shooting, and off when nothing is", () => {
  const painter = only(utility(PAINTER, "painter"));
  const idle = decideCompanionUtilities(inputs({ facts: painter, hasDamage: false }), FRESH_COMPANION_UTILITIES);
  assert.equal(idle.call, null);
  const on = decideCompanionUtilities(inputs({ facts: painter }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(on.call, { kind: "activate", moduleID: PAINTER, targetID: RAT });
  assert.equal(on.why, "Painting the target.");
  const off = decideCompanionUtilities(
    inputs({ facts: painter, hasDamage: false, activeModuleIDs: [PAINTER] }), owning("painter", PAINTER, RAT));
  assert.deepEqual(off.call, { kind: "deactivate", moduleID: PAINTER, typeID: 5379 });
  assert.equal(off.why, "Nothing is shooting: switching the target painter off.");
});

// --- sensor booster and tracking computer ------------------------------------

test("the self-buffs go on in a fight, self-targeted, and off when it ends", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const on = decideCompanionUtilities(inputs({ facts: sensor, engagedTargetID: null, targetLocked: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(on.call, { kind: "activate", moduleID: SENSOR, targetID: 0 });
  assert.equal(on.why, "In a fight: switching the sensor booster on.");
  const quiet = decideCompanionUtilities(
    inputs({ facts: sensor, engagedTargetID: null, targetLocked: false, fightOn: false, activeModuleIDs: [SENSOR] }),
    owning("sensor", SENSOR, 0));
  assert.deepEqual(quiet.call, { kind: "deactivate", moduleID: SENSOR, typeID: 5212 });
  assert.equal(quiet.why, "Fight over: switching the sensor booster off.");
  const none = decideCompanionUtilities(inputs({ facts: sensor, fightOn: false, engagedTargetID: null }), FRESH_COMPANION_UTILITIES);
  assert.equal(none.call, null, "no fight, nothing to switch on");
});

test("a tracking computer only with turrets fitted; the sensor booster regardless", () => {
  const both = only(utility(TRACKING, "tracking"), utility(SENSOR, "sensor"));
  const noTurrets = decideCompanionUtilities(inputs({ facts: both, hasTurrets: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(noTurrets.call, { kind: "activate", moduleID: SENSOR, targetID: 0 });
  const turrets = decideCompanionUtilities(inputs({ facts: both }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(turrets.call, { kind: "activate", moduleID: TRACKING, targetID: 0 });
  const over = decideCompanionUtilities(
    inputs({ facts: both, fightOn: false, engagedTargetID: null, activeModuleIDs: [TRACKING] }), owning("tracking", TRACKING, 0));
  assert.equal(over.why, "Fight over: switching the tracking computer off.");
});

test("a module with a script the framework does not understand stays off", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(SENSOR, "sensor", { modeKnown: false })) }), FRESH_COMPANION_UTILITIES);
  assert.equal(step.call, null);
});

test("the web comes before the self-buffs", () => {
  const step = decideCompanionUtilities(inputs(), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(step.call, { kind: "activate", moduleID: WEB, targetID: RAT });
});

// --- ownership ---------------------------------------------------------------

test("a module already running that this rung did not switch on is never stopped or claimed", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web"), utility(SENSOR, "sensor")), engagedTargetID: null, targetLocked: false,
      fightOn: false, activeModuleIDs: [WEB, SENSOR] }),
    FRESH_COMPANION_UTILITIES);
  assert.equal(step.call, null);
  assert.deepEqual(step.memory.owned, []);
});

test("an activation in its grace is not asked again; past it, an unstarted module is forgotten", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const on = decideCompanionUtilities(inputs({ facts: sensor }), FRESH_COMPANION_UTILITIES);
  const soon = decideCompanionUtilities(inputs({ facts: sensor, nowMs: T0 + 2_000 }), on.memory);
  assert.equal(soon.call, null, "still in its grace");
  assert.equal(soon.memory.owned.length, 1);
  const later = decideCompanionUtilities(inputs({ facts: sensor, nowMs: T0 + UTILITY_ACTIVATION_GRACE_MS + 1 }), soon.memory);
  assert.deepEqual(later.call, { kind: "activate", moduleID: SENSOR, targetID: 0 }, "refused: asked again");
});

test("a refused activation is retried a bounded number of times per fight", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  let memory = FRESH_COMPANION_UTILITIES;
  let now = T0;
  let calls = 0;
  for (let i = 0; i < MAX_UTILITY_START_ATTEMPTS + 3; i++) {
    const step = decideCompanionUtilities(inputs({ facts: sensor, nowMs: now }), memory);
    if (step.call !== null) calls += 1;
    memory = step.memory;
    now += UTILITY_ACTIVATION_GRACE_MS + 1;
  }
  assert.equal(calls, MAX_UTILITY_START_ATTEMPTS);
  // A fight that ends gives the next one a fresh budget.
  const quiet = decideCompanionUtilities(inputs({ facts: sensor, fightOn: false, engagedTargetID: null, nowMs: now }), memory);
  const again = decideCompanionUtilities(inputs({ facts: sensor, nowMs: now + 1 }), quiet.memory);
  assert.equal(again.call?.kind, "activate");
});

test("a deactivate is sent once, retried after the wait, and given up after its budget", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const quiet = (nowMs: number) => inputs({ facts: sensor, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR], nowMs });
  let memory = owning("sensor", SENSOR, 0);
  let now = T0;
  let calls = 0;
  for (let i = 0; i < 12; i++) {
    const step = decideCompanionUtilities(quiet(now), memory);
    if (step.call?.kind === "deactivate") calls += 1;
    if (i === 1) assert.equal(step.call, null, "the stop in flight is not re-sent at once");
    memory = step.memory;
    now += i === 0 ? 2_000 : UTILITY_STOP_RETRY_MS;
  }
  assert.equal(calls, MAX_UTILITY_STOP_ATTEMPTS);
  assert.deepEqual(memory.owned, [], "given up: no longer ours");
});

test("a stop seen through clears its latch", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const stop = decideCompanionUtilities(
    inputs({ facts: sensor, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR] }), owning("sensor", SENSOR, 0));
  assert.equal(stop.memory.stopping.length, 1);
  const done = decideCompanionUtilities(
    inputs({ facts: sensor, fightOn: false, engagedTargetID: null, nowMs: T0 + 2_000 }), stop.memory);
  assert.equal(done.call, null);
  assert.deepEqual(done.memory.stopping, []);
  assert.deepEqual(done.memory.owned, []);
});

test("another ship owns nothing", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: { ...ALL, shipID: SHIP + 1 }, shipID: SHIP + 1, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR] }),
    owning("sensor", SENSOR, 0));
  assert.equal(step.call, null);
  assert.deepEqual(step.memory.owned, []);
});

test("an unreadable rack decides nothing", () => {
  const step = decideCompanionUtilities(inputs({ activeModuleIDs: null, fightOn: false }), owning("sensor", SENSOR, 0));
  assert.equal(step.call, null);
  assert.equal(step.memory.owned.length, 1);
});

test("facts about another ship start nothing", () => {
  const step = decideCompanionUtilities(inputs({ facts: { ...ALL, shipID: SHIP + 1 } }), FRESH_COMPANION_UTILITIES);
  assert.equal(step.call, null);
});

// --- capacitor ---------------------------------------------------------------

test("below the capacitor floor nothing starts, but an owned module still stops", () => {
  const low = decideCompanionUtilities(inputs({ capacitorRatio: 0.1 }), FRESH_COMPANION_UTILITIES);
  assert.equal(low.call, null);
  const stop = decideCompanionUtilities(
    inputs({ capacitorRatio: 0.1, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR] }), owning("sensor", SENSOR, 0));
  assert.deepEqual(stop.call, { kind: "deactivate", moduleID: SENSOR, typeID: 5212 });
});

test("an unreadable capacitor does not hold a start back; too little for one cycle does", () => {
  const unread = decideCompanionUtilities(inputs({ capacitorRatio: null }), FRESH_COMPANION_UTILITIES);
  assert.equal(unread.call?.kind, "activate");
  const short = decideCompanionUtilities(
    inputs({ facts: only(utility(SENSOR, "sensor", { capNeed: 500 })), capacitorRatio: 0.3 }), FRESH_COMPANION_UTILITIES);
  assert.equal(short.call, null, "300 GJ left, 500 needed");
});

// --- warp --------------------------------------------------------------------

test("a warp forgets the targeted modules and keeps the self-buffs", () => {
  const memory: CompanionUtilityMemory = {
    ...FRESH_COMPANION_UTILITIES,
    shipID: SHIP,
    owned: [
      { itemID: WEB, typeID: 5065, family: "web", targetID: RAT, sinceMs: T0 },
      { itemID: SENSOR, typeID: 5212, family: "sensor", targetID: 0, sinceMs: T0 },
    ],
    stopping: [{ itemID: WEB, sinceMs: T0, attempts: 1 }],
    attempts: { [`${WEB}:${RAT}`]: 1 },
  };
  const after = utilitiesAfterWarp(memory);
  assert.deepEqual(after.owned.map((own) => own.itemID), [SENSOR]);
  assert.deepEqual(after.stopping, []);
  assert.deepEqual(after.attempts, {});
  assert.equal(utilitiesAfterWarp(undefined), FRESH_COMPANION_UTILITIES);
});

// --- the decision trace --------------------------------------------------------

/** The trace's skip codes by module id, for a compact assertion. */
const codes = (step: { readonly trace: { readonly skipped: readonly { readonly moduleID: number; readonly code: string }[] } }) =>
  Object.fromEntries(step.trace.skipped.map((entry) => [entry.moduleID, entry.code]));

const NOTHING = { skipped: [], gaveUp: [] };

test("a quiet grid reports nothing: modules correctly off are not skipped", () => {
  const step = decideCompanionUtilities(
    inputs({ engagedTargetID: null, targetLocked: false, fightOn: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(step.trace, NOTHING);
  // The sensor runs (not ours) and the web has no target to be on.
  const fight = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web"), utility(SENSOR, "sensor")), engagedTargetID: null, targetLocked: false,
      activeModuleIDs: [SENSOR] }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(fight.trace, NOTHING);
});

test("an activation reports no skip for the module it starts", () => {
  const step = decideCompanionUtilities(inputs(), FRESH_COMPANION_UTILITIES);
  assert.equal(step.call?.kind, "activate");
  assert.deepEqual(step.trace, NOTHING);
});

test("no-rack: an unreadable rack names what was wanted, and what we own", () => {
  const step = decideCompanionUtilities(inputs({ activeModuleIDs: null }), owning("sensor", SENSOR, 0));
  assert.equal(step.call, null);
  assert.deepEqual(codes(step), { [WEB]: "no-rack", [PAINTER]: "no-rack", [SENSOR]: "no-rack", [TRACKING]: "no-rack" });
  const quiet = decideCompanionUtilities(
    inputs({ activeModuleIDs: null, engagedTargetID: null, targetLocked: false, fightOn: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(quiet.trace.skipped, []);
});

test("no-facts: no fit read, or another ship's, is one entry for no module, and only in a fight", () => {
  for (const over of [{ facts: null }, { facts: { ...ALL, shipID: SHIP + 1 } }] as Partial<CompanionUtilityInputs>[]) {
    const step = decideCompanionUtilities(inputs(over), FRESH_COMPANION_UTILITIES);
    assert.deepEqual(step.trace.skipped, [{ moduleID: 0, family: "all", code: "no-facts" }]);
    const quiet = decideCompanionUtilities(
      inputs({ ...over, fightOn: false, engagedTargetID: null, targetLocked: false }), FRESH_COMPANION_UTILITIES);
    assert.deepEqual(quiet.trace.skipped, []);
  }
  const noRack = decideCompanionUtilities(inputs({ facts: null, activeModuleIDs: null }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(noRack.trace.skipped, [{ moduleID: 0, family: "all", code: "no-rack" }]);
});

test("cap-floor: below the floor every wanted module is held, and a quiet grid holds nothing", () => {
  const step = decideCompanionUtilities(inputs({ capacitorRatio: 0.1 }), FRESH_COMPANION_UTILITIES);
  assert.equal(step.call, null);
  assert.deepEqual(codes(step), { [WEB]: "cap-floor", [PAINTER]: "cap-floor", [SENSOR]: "cap-floor", [TRACKING]: "cap-floor" });
  const quiet = decideCompanionUtilities(
    inputs({ capacitorRatio: 0.1, engagedTargetID: null, targetLocked: false, fightOn: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(quiet.trace.skipped, []);
});

test("cap-need: too little for one cycle of this module", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(SENSOR, "sensor", { capNeed: 500 })), capacitorRatio: 0.3 }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(step), { [SENSOR]: "cap-need" });
});

test("mode-unknown: a script the framework does not understand", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(SENSOR, "sensor", { modeKnown: false })) }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(step), { [SENSOR]: "mode-unknown" });
});

test("not-locked: a target is engaged but not yet locked", () => {
  const step = decideCompanionUtilities(inputs({ facts: only(utility(WEB, "web")), targetLocked: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(step), { [WEB]: "not-locked" });
});

test("optimal-unknown: no optimal read, or no distance to hold it against", () => {
  const noRange = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web", { rangeM: null })) }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(noRange), { [WEB]: "optimal-unknown" });
  const noDistance = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web")), targetDistanceM: null }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(noDistance), { [WEB]: "optimal-unknown" });
});

test("out-of-optimal: measured, and past the module's optimal", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web"), utility(PAINTER, "painter")), targetDistanceM: 12_000 }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(step), { [WEB]: "out-of-optimal", [PAINTER]: "out-of-optimal" });
});

test("no-damage: a painter with nothing shooting", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(PAINTER, "painter")), hasDamage: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(codes(step), { [PAINTER]: "no-damage" });
});

test("no-turrets: a tracking computer on a ship without turrets, the sensor booster unaffected", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(TRACKING, "tracking"), utility(SENSOR, "sensor")), hasTurrets: false }), FRESH_COMPANION_UTILITIES);
  assert.equal(step.call?.kind, "activate");
  assert.deepEqual(codes(step), { [TRACKING]: "no-turrets" });
});

test("a module after the one that takes the tick still reports its own gate", () => {
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web"), utility(PAINTER, "painter")), hasDamage: false }), FRESH_COMPANION_UTILITIES);
  assert.deepEqual(step.call, { kind: "activate", moduleID: WEB, targetID: RAT });
  assert.deepEqual(codes(step), { [PAINTER]: "no-damage" });
});

test("stop-retry-wait: a deactivate in flight is waited on, and named", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const quiet = (nowMs: number) => inputs({ facts: sensor, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR], nowMs });
  const first = decideCompanionUtilities(quiet(T0), owning("sensor", SENSOR, 0));
  assert.equal(first.call?.kind, "deactivate");
  assert.deepEqual(first.trace, NOTHING);
  const waiting = decideCompanionUtilities(quiet(T0 + 2_000), first.memory);
  assert.equal(waiting.call, null);
  assert.deepEqual(waiting.trace, { skipped: [{ moduleID: SENSOR, family: "sensor", code: "stop-retry-wait" }], gaveUp: [] });
});

test("grace-dropped: an activation that never showed as running; a module that ran and ended is silent", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const on = decideCompanionUtilities(inputs({ facts: sensor }), FRESH_COMPANION_UTILITIES);
  const soon = decideCompanionUtilities(inputs({ facts: sensor, nowMs: T0 + 2_000 }), on.memory);
  assert.deepEqual(soon.trace, NOTHING, "still in its grace");
  // Past the grace and not running, and the start held back: the drop is named.
  const late = T0 + UTILITY_ACTIVATION_GRACE_MS + 1;
  const held = decideCompanionUtilities(inputs({ facts: sensor, nowMs: late, capacitorRatio: 0.1 }), soon.memory);
  assert.deepEqual(held.trace.skipped, [{ moduleID: SENSOR, family: "sensor", code: "grace-dropped" }]);
  // Dropped and asked for again in the same tick: acted on, not skipped.
  const again = decideCompanionUtilities(inputs({ facts: sensor, nowMs: late }), soon.memory);
  assert.equal(again.call?.kind, "activate");
  assert.deepEqual(again.trace, NOTHING);
  // Seen running, then gone: it ran its cycle out. No code.
  const running = decideCompanionUtilities(inputs({ facts: sensor, nowMs: T0 + 2_000, activeModuleIDs: [SENSOR] }), on.memory);
  assert.equal(running.memory.owned[0]?.seen, true);
  const ended = decideCompanionUtilities(
    inputs({ facts: sensor, fightOn: false, engagedTargetID: null, targetLocked: false, nowMs: T0 + 30_000 }), running.memory);
  assert.deepEqual(ended.trace, NOTHING);
  assert.deepEqual(ended.memory.owned, []);
});

test("attempts-spent and the start give-up: the budget runs out on one tick, then reads attempts-spent", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  let memory = FRESH_COMPANION_UTILITIES;
  let now = T0;
  const seen: { readonly call: string | null; readonly skipped: string[]; readonly gaveUp: string[] }[] = [];
  for (let i = 0; i < MAX_UTILITY_START_ATTEMPTS + 3; i++) {
    const step = decideCompanionUtilities(inputs({ facts: sensor, nowMs: now }), memory);
    seen.push({
      call: step.call?.kind ?? null,
      skipped: step.trace.skipped.map((entry) => entry.code),
      gaveUp: step.trace.gaveUp.map((entry) => `${entry.moduleID}:${entry.what}`),
    });
    memory = step.memory;
    now += UTILITY_ACTIVATION_GRACE_MS + 1;
  }
  const spent = MAX_UTILITY_START_ATTEMPTS; // the tick on which the last allowed activation is found dropped
  for (let i = 0; i < spent; i++) {
    assert.equal(seen[i]!.call, "activate", `tick ${i}`);
    assert.deepEqual(seen[i]!.gaveUp, [], `tick ${i}`);
  }
  assert.deepEqual(seen[spent], { call: null, skipped: ["grace-dropped"], gaveUp: [`${SENSOR}:start`] }, "the moment of giving up");
  assert.deepEqual(seen[spent + 1], { call: null, skipped: ["attempts-spent"], gaveUp: [] }, "and never again");
  assert.deepEqual(seen[spent + 2], { call: null, skipped: ["attempts-spent"], gaveUp: [] });
});

test("the stop give-up: reported on the tick ownership drops, with a readout, and not before or after", () => {
  const sensor = only(utility(SENSOR, "sensor"));
  const quiet = (nowMs: number) => inputs({ facts: sensor, fightOn: false, engagedTargetID: null, activeModuleIDs: [SENSOR], nowMs });
  let memory = owning("sensor", SENSOR, 0);
  let now = T0;
  const gaveUpAt: number[] = [];
  let notice = "";
  for (let i = 0; i < 12; i++) {
    const step = decideCompanionUtilities(quiet(now), memory);
    if (step.trace.gaveUp.length > 0) {
      gaveUpAt.push(i);
      assert.deepEqual(step.trace.gaveUp, [{ moduleID: SENSOR, family: "sensor", what: "stop" }]);
      assert.equal(step.call, null);
      notice = step.why;
    } else if (step.call === null) {
      assert.equal(step.why, "", `tick ${i}: the notice is not repeated`);
    }
    memory = step.memory;
    now += i === 0 ? 2_000 : UTILITY_STOP_RETRY_MS;
  }
  assert.deepEqual(gaveUpAt, [MAX_UTILITY_STOP_ATTEMPTS + 1], "once, after the last try had its full wait");
  assert.equal(notice, "Could not switch the sensor booster off after 3 tries; leaving it.");
  const web = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web")), engagedTargetID: null, targetLocked: false, activeModuleIDs: [WEB] }),
    owning("web", WEB, RAT, { stopping: [{ itemID: WEB, sinceMs: T0 - 60_000, attempts: MAX_UTILITY_STOP_ATTEMPTS }] }));
  assert.equal(web.why, "Could not switch the webifier off after 3 tries; leaving it.");
});

test("a give-up notice rides along with a call made the same tick, and the trace still names it", () => {
  const memory = owning("web", WEB, RAT, { stopping: [{ itemID: WEB, sinceMs: T0 - 60_000, attempts: MAX_UTILITY_STOP_ATTEMPTS }] });
  const step = decideCompanionUtilities(
    inputs({ facts: only(utility(WEB, "web"), utility(SENSOR, "sensor")), engagedTargetID: null, targetLocked: false,
      activeModuleIDs: [WEB] }), memory);
  assert.deepEqual(step.call, { kind: "activate", moduleID: SENSOR, targetID: 0 });
  assert.equal(step.why, "In a fight: switching the sensor booster on. Could not switch the webifier off after 3 tries; leaving it.");
  assert.deepEqual(step.trace.gaveUp, [{ moduleID: WEB, family: "web", what: "stop" }]);
});

test("the target going away reads four ways: nothing engaged, off the grid, not hostile, not locked", () => {
  const web = only(utility(WEB, "web"));
  const owned = owning("web", WEB, RAT);
  const why = (over: Partial<CompanionUtilityInputs>) =>
    decideCompanionUtilities(inputs({ facts: web, activeModuleIDs: [WEB], ...over }), owned).why;
  const sentences = [
    why({ engagedTargetID: null, targetLocked: false, targetOnGrid: false, targetHostile: false }),
    why({ targetLocked: false, targetOnGrid: false, targetHostile: false }),
    why({ targetLocked: false, targetOnGrid: true, targetHostile: false }),
    why({ targetLocked: false, targetOnGrid: true, targetHostile: true }),
  ];
  assert.deepEqual(sentences, [
    "No target engaged: switching the stasis webifier off.",
    "The target left the grid: switching the stasis webifier off.",
    "The target is no longer hostile: switching the stasis webifier off.",
    "The target is not locked: switching the stasis webifier off.",
  ]);
  for (const sentence of sentences) assert.match(sentence, /^[\x20-\x7e]+$/, "plain ASCII");
  // A caller that cannot say why gets the plain "not locked".
  assert.equal(why({ targetLocked: false }), "The target is not locked: switching the stasis webifier off.");
});

test("the rung's early returns trace nothing", () => {
  const rung = (memory: object, obs: object) =>
    decideUtilityRung({} as never, obs as never, null, memory as never, T0);
  assert.deepEqual(rung({ flee: {}, abandonment: null }, { inSpace: true }).trace, NOTHING);
  assert.deepEqual(rung({ flee: null, abandonment: null }, { inSpace: false }).trace, NOTHING);
  assert.deepEqual(rung({ flee: null, abandonment: null }, { inSpace: true, docked: true }).trace, NOTHING);
  assert.deepEqual(rung({ flee: null, abandonment: null }, { inSpace: true, inWarp: true }).trace, NOTHING);
});
