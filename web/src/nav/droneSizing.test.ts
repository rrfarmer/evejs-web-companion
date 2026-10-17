// Drone sizing: the server's hit rule applied to real drone dogma. Every drone
// fixture is a real type's attribute values from the pinned SDE
// (`typeDogma.jsonl`); the numbers are the point, so none is rounded to suit.
//
// Pinned here: lights beat heavies on a frigate, heavies beat lights on a
// battleship, a sentry is blind beyond its reach, the fill goes DOWN a size and
// never up, null is "unknown" and never zero, and the switch rule's asymmetry
// and minimum interval.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DRONE_SIZING_ATTRIBUTE_IDS,
  MIN_SWITCH_INTERVAL_MS,
  droneFactsFromAttributes,
  expectedAppliedDps,
  expectedShotMultiplier,
  hitChanceAgainst,
  planLaunch,
  scoreAgainst,
  shouldSwitch,
  sizeSwitchVerdict,
  sizedLaunch,
  switchCostSeconds,
  type DroneFacts,
  type TargetFacts,
} from "./droneSizing.ts";

type Attributes = Record<number, number>;

const HOBGOBLIN: Attributes = {
  37: 2800, 51: 4000, 54: 2100, 64: 1.6, 114: 0, 116: 0, 117: 0, 118: 20, 158: 2000, 160: 1.815,
  247: 2800, 416: 700, 508: 660, 552: 25, 620: 25, 665: 2800, 1272: 5,
};
const HAMMERHEAD: Attributes = {
  37: 1680, 51: 4000, 54: 4200, 64: 1.6, 114: 0, 116: 0, 117: 0, 118: 32, 158: 3000, 160: 0.58,
  247: 5600, 416: 1400, 508: 440, 552: 50, 620: 125, 665: 5600, 1272: 10,
};
const OGRE: Attributes = {
  37: 1000, 51: 4000, 54: 4200, 64: 1.6, 114: 0, 116: 0, 117: 0, 118: 64, 158: 5000, 160: 0.45,
  247: 7000, 416: 2800, 508: 250, 552: 100, 620: 400, 665: 7000, 1272: 25,
};
const GARDE: Attributes = {
  37: 1e-5, 51: 4000, 54: 15000, 64: 1.65, 114: 0, 116: 0, 117: 0, 118: 64, 158: 25000, 160: 0.028,
  247: 250000, 416: 1e-5, 508: 0, 552: 300, 620: 400, 665: 0, 1272: 25,
};

function must(typeID: number, attrs: Attributes): DroneFacts {
  const f = droneFactsFromAttributes(typeID, attrs);
  assert.notEqual(f, null);
  return f as DroneFacts;
}

const hobgoblin = must(2454, HOBGOBLIN);
const hammerhead = must(2183, HAMMERHEAD);
const ogre = must(2444, OGRE);
const garde = must(23561, GARDE);

const FACTS = new Map<number, DroneFacts>([
  [2454, hobgoblin],
  [2183, hammerhead],
  [2444, ogre],
  [23561, garde],
]);

const FRIGATE: TargetFacts = { signatureRadius: 35, speed: 400, distanceFromShipM: 8000 };
const BATTLESHIP: TargetFacts = { signatureRadius: 400, speed: 100, distanceFromShipM: 8000 };

test("the attribute ids are exactly the ones the reader uses, all distinct", () => {
  assert.equal(new Set(DRONE_SIZING_ATTRIBUTE_IDS).size, DRONE_SIZING_ATTRIBUTE_IDS.length);
  for (const id of Object.keys(HOBGOBLIN).map(Number)) {
    assert.ok(DRONE_SIZING_ATTRIBUTE_IDS.includes(id), `attribute ${id} is fetched`);
  }
  assert.ok(!DRONE_SIZING_ATTRIBUTE_IDS.includes(72), "72 is capacityBonus, the attack range is 247");
});

test("facts are read off the dogma, damage multiplier applied", () => {
  assert.equal(hobgoblin.shotDamage.thermal, 20 * 1.6);
  assert.equal(hobgoblin.cycleSeconds, 4);
  assert.equal(hobgoblin.bandwidthMbit, 5);
  assert.equal(hobgoblin.orbitRadiusM, 700);
  assert.equal(hammerhead.orbitRadiusM, 1400);
  assert.equal(ogre.orbitRadiusM, 2800);
  assert.equal(hobgoblin.stationary, false);
  assert.equal(garde.stationary, true);
});

test("an essential missing is null, never invented", () => {
  for (const id of [51, 54, 160, 1272, 37]) {
    const attrs = { ...HOBGOBLIN };
    delete attrs[id];
    assert.equal(droneFactsFromAttributes(1, attrs), null, `without ${id}`);
  }
  assert.equal(droneFactsFromAttributes(1, { ...HOBGOBLIN, 118: 0 }), null, "no damage at all");
  assert.equal(droneFactsFromAttributes(1, {}), null);
  assert.equal(droneFactsFromAttributes(1, null), null);
  assert.equal(droneFactsFromAttributes(1, { ...HOBGOBLIN, 160: Number.NaN }), null);
});

test("the server's own defaults apply to what it defaults", () => {
  const attrs = { ...HOBGOBLIN };
  delete attrs[620];
  delete attrs[552];
  delete attrs[64];
  const f = must(1, attrs);
  assert.equal(f.optimalSigRadius, 25);
  assert.equal(f.shotDamage.thermal, 20);
  const noSig = { ...HAMMERHEAD };
  delete noSig[620];
  assert.equal(must(1, noSig).optimalSigRadius, 50, "falls back to signatureRadius");
});

test("expected shot multiplier integrates the server's quality over the hitting rolls", () => {
  assert.equal(expectedShotMultiplier(0), 0);
  assert.ok(Math.abs(expectedShotMultiplier(0.005) - 0.015) < 1e-12, "all-wrecking sliver");
  assert.ok(Math.abs(expectedShotMultiplier(1) - 1.01505) < 1e-9);
  // Low-chance hits land light: far below chance * 1.015.
  assert.ok(expectedShotMultiplier(0.1) < 0.1 * 1.015);
  assert.ok(expectedShotMultiplier(0.5) > expectedShotMultiplier(0.4));
});

test("hit chance follows the server formula", () => {
  // Hobgoblin on the frigate: angVel = sqrt(660^2 + 400^2/2)/700.
  const angVel = Math.sqrt(660 * 660 + 400 * 400 / 2) / 700;
  const term = (angVel * 25) / (1.815 * 35);
  const expected = 0.5 ** (term * term);
  const got = hitChanceAgainst(hobgoblin, FRIGATE);
  assert.ok(got !== null && Math.abs(got - expected) < 1e-9);
  assert.ok(got > 0.8);
  // A stationary target at rest gives an angular velocity of just the orbit.
  const still = hitChanceAgainst(ogre, { signatureRadius: 400, speed: 0, distanceFromShipM: 1 });
  assert.ok(still !== null && still > 0.9);
});

test("lights beat heavies on a fast frigate", () => {
  const light = expectedAppliedDps(hobgoblin, FRIGATE);
  const medium = expectedAppliedDps(hammerhead, FRIGATE);
  const heavy = expectedAppliedDps(ogre, FRIGATE);
  assert.ok(light !== null && medium !== null && heavy !== null);
  assert.ok(light > medium && medium > heavy, `${light} ${medium} ${heavy}`);
  assert.ok(heavy < 0.5, "the heavy misses nearly everything");
  assert.ok((hitChanceAgainst(ogre, FRIGATE) ?? 1) < 0.05);
});

test("heavies beat lights on a slow battleship, per drone", () => {
  const light = expectedAppliedDps(hobgoblin, BATTLESHIP);
  const heavy = expectedAppliedDps(ogre, BATTLESHIP);
  assert.ok(light !== null && heavy !== null);
  assert.ok(heavy > light * 2.5, `${heavy} vs ${light}`);
  assert.ok((hitChanceAgainst(hobgoblin, BATTLESHIP) ?? 0) > 0.95, "the light still hits");
});

test("a drone slower than the target cannot hold it: 0, not unknown", () => {
  const fast: TargetFacts = { signatureRadius: 35, speed: 1500, distanceFromShipM: 5000 };
  assert.equal(expectedAppliedDps(ogre, fast), 0);
  assert.ok((expectedAppliedDps(hobgoblin, fast) ?? 0) > 0);
});

test("unknown target facts are null, which is not zero", () => {
  assert.equal(expectedAppliedDps(hobgoblin, { signatureRadius: null, speed: 100, distanceFromShipM: 1 }), null);
  assert.equal(expectedAppliedDps(hobgoblin, { signatureRadius: 35, speed: null, distanceFromShipM: 1 }), null);
  assert.equal(expectedAppliedDps(garde, { signatureRadius: 35, speed: 0, distanceFromShipM: null }), null);
  // A mobile drone does not need the distance from the ship.
  assert.notEqual(expectedAppliedDps(hobgoblin, { signatureRadius: 35, speed: 0, distanceFromShipM: null }), null);
});

test("a sentry is deadly inside its reach and useless far beyond it", () => {
  const near = expectedAppliedDps(garde, { signatureRadius: 400, speed: 0, distanceFromShipM: 10_000 });
  const far = expectedAppliedDps(garde, { signatureRadius: 400, speed: 0, distanceFromShipM: 100_000 });
  assert.ok(near !== null && far !== null);
  assert.ok(near > 20, `${near}`);
  assert.ok(far < near * 0.001, `${far}`);
  // And it cannot track a frigate even inside optimal.
  const frigate = expectedAppliedDps(garde, { signatureRadius: 35, speed: 400, distanceFromShipM: 10_000 });
  assert.ok(frigate !== null && frigate < 0.5);
});

test("resistances scale the damage, omitted means none", () => {
  const plain = expectedAppliedDps(hobgoblin, BATTLESHIP);
  const resisted = expectedAppliedDps(hobgoblin, {
    ...BATTLESHIP,
    resonance: { em: 1, thermal: 0.5, kinetic: 1, explosive: 1 },
  });
  assert.ok(plain !== null && resisted !== null);
  assert.ok(Math.abs(resisted - plain / 2) < 1e-9);
});

test("several targets score as the mean of the known ones", () => {
  const a = expectedAppliedDps(hobgoblin, FRIGATE) as number;
  const b = expectedAppliedDps(hobgoblin, BATTLESHIP) as number;
  const unknown: TargetFacts = { signatureRadius: null, speed: null, distanceFromShipM: null };
  const mean = scoreAgainst(hobgoblin, [FRIGATE, BATTLESHIP, unknown]);
  assert.ok(mean !== null && Math.abs(mean - (a + b) / 2) < 1e-9);
  assert.equal(scoreAgainst(hobgoblin, [unknown]), null);
});

const bay = (...rows: [number, number, number][]) => rows.map(([itemID, typeID, quantity]) => ({ itemID, typeID, quantity }));

test("a frigate gets the lights", () => {
  const plan = planLaunch(bay([1, 2454, 5], [2, 2183, 5], [3, 2444, 5]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, FRIGATE);
  assert.equal(plan.primaryTypeID, 2454);
  assert.deepEqual(plan.stacks, [{ itemID: 1, quantity: 5 }]);
  assert.ok((plan.expectedDps ?? 0) > 0);
});

test("a battleship gets the heavies, filled down only with what fits", () => {
  const plan = planLaunch(bay([1, 2454, 5], [2, 2183, 5], [3, 2444, 5]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, BATTLESHIP);
  assert.equal(plan.primaryTypeID, 2444);
  // 3 Ogres use all 75 Mbit: nothing is left to fill with.
  assert.deepEqual(plan.stacks, [{ itemID: 3, quantity: 3 }]);
});

test("leftover bandwidth and slots fill with the next size down, never up", () => {
  // Two heavies in the bay: 50 Mbit and 2 slots used, 25 Mbit and 3 slots left.
  // Two Hammerheads (20 Mbit, 2 slots), then one Hobgoblin (5 Mbit, 1 slot).
  const plan = planLaunch(bay([1, 2454, 5], [2, 2183, 5], [3, 2444, 2]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, BATTLESHIP);
  assert.equal(plan.primaryTypeID, 2444);
  assert.deepEqual(plan.stacks, [
    { itemID: 3, quantity: 2 },
    { itemID: 2, quantity: 2 },
    { itemID: 1, quantity: 1 },
  ]);
  // Never up: lights first means the bigger ones stay home.
  const lights = planLaunch(bay([1, 2454, 2], [3, 2444, 5]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, FRIGATE);
  assert.equal(lights.primaryTypeID, 2454);
  assert.deepEqual(lights.stacks, [{ itemID: 1, quantity: 2 }]);
});

test("a stack split across itemIDs is launched in order and capped", () => {
  const plan = planLaunch(bay([1, 2454, 2], [2, 2454, 2], [3, 2454, 2]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, FRIGATE);
  assert.deepEqual(plan.stacks, [
    { itemID: 1, quantity: 2 },
    { itemID: 2, quantity: 2 },
    { itemID: 3, quantity: 1 },
  ]);
});

test("a sentry out of reach is not launched into a slot", () => {
  const far: TargetFacts = { signatureRadius: 400, speed: 0, distanceFromShipM: 150_000 };
  const plan = planLaunch(bay([1, 23561, 3], [2, 2444, 3]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, far);
  assert.equal(plan.primaryTypeID, 2444);
  assert.ok(plan.stacks.every((s) => s.itemID !== 1));
});

test("an unknown target plans nothing and says so; a hopeless one says 0", () => {
  const unknown: TargetFacts = { signatureRadius: null, speed: null, distanceFromShipM: null };
  const plan = planLaunch(bay([1, 2454, 5]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, unknown);
  assert.deepEqual(plan, { stacks: [], primaryTypeID: null, expectedDps: null });
  const hopeless = planLaunch(bay([1, 23561, 3]), FACTS, { bandwidthMbit: 75, maxActive: 5 }, {
    signatureRadius: 35,
    speed: 400,
    distanceFromShipM: 500_000,
  });
  assert.equal(hopeless.primaryTypeID, null);
  assert.equal(hopeless.expectedDps, 0);
  assert.deepEqual(planLaunch([], FACTS, { bandwidthMbit: 75, maxActive: 5 }, FRIGATE).stacks, []);
});

test("a hull with no room launches nothing", () => {
  const plan = planLaunch(bay([1, 2454, 5]), FACTS, { bandwidthMbit: 0, maxActive: 5 }, FRIGATE);
  assert.equal(plan.primaryTypeID, null);
  assert.deepEqual(plan.stacks, []);
});

test("the switch cost counts both flights and the fixed handling", () => {
  const cost = switchCostSeconds({ distanceM: 14_000, currentMaxVelocityMs: 1000, newMaxVelocityMs: 2800 });
  assert.ok(Math.abs(cost - (2 + 14 + 2 + 5)) < 1e-9);
  assert.equal(switchCostSeconds({ distanceM: 50_000, currentMaxVelocityMs: 0, newMaxVelocityMs: 0 }), 4);
});

const NOW = 1_000_000;
const base = {
  direction: "down" as const,
  currentDps: 1,
  bestDps: 20,
  remainingEhp: 5000,
  switchCostS: 20,
  lastSwitchAtMs: null,
  nowMs: NOW,
};

test("too big: switch promptly when the saving beats the cost", () => {
  const verdict = shouldSwitch(base);
  assert.equal(verdict.switch, true);
  // 5000/1 - 5000/20 = 4750 s saved against a 20 s cost.
  assert.equal(shouldSwitch({ ...base, remainingEhp: 10 }).switch, false, "target nearly dead");
});

test("too big with unknown EHP switches only on a lopsided gain", () => {
  assert.equal(shouldSwitch({ ...base, remainingEhp: null }).switch, true);
  assert.equal(shouldSwitch({ ...base, remainingEhp: null, currentDps: 12 }).switch, false);
});

test("zero current dps switches whenever the alternative can hurt", () => {
  assert.equal(shouldSwitch({ ...base, currentDps: 0, remainingEhp: null }).switch, true);
  assert.equal(shouldSwitch({ ...base, currentDps: 0, bestDps: 0 }).switch, false);
});

test("too small: only when the fight will last", () => {
  const up = { ...base, direction: "up" as const, currentDps: 8, bestDps: 25 };
  // saved = ehp/8 - ehp/25 = ehp * 0.085; must beat 3 x 20 = 60 s.
  assert.equal(shouldSwitch({ ...up, remainingEhp: 500 }).switch, false, "short fight");
  assert.equal(shouldSwitch({ ...up, remainingEhp: 5000 }).switch, true, "long fight");
  assert.equal(shouldSwitch({ ...up, remainingEhp: null }).switch, false, "unknown EHP never");
});

test("the minimum interval holds both directions", () => {
  assert.equal(shouldSwitch({ ...base, lastSwitchAtMs: NOW - (MIN_SWITCH_INTERVAL_MS - 1) }).switch, false);
  assert.equal(shouldSwitch({ ...base, lastSwitchAtMs: NOW - MIN_SWITCH_INTERVAL_MS }).switch, true);
  assert.equal(
    shouldSwitch({ ...base, direction: "up", currentDps: 1, bestDps: 50, lastSwitchAtMs: NOW - 5000 }).switch,
    false,
  );
});

test("unknown dps never switches, and a worse alternative never does", () => {
  assert.equal(shouldSwitch({ ...base, currentDps: null }).switch, false);
  assert.equal(shouldSwitch({ ...base, bestDps: null }).switch, false);
  assert.equal(shouldSwitch({ ...base, bestDps: 1 }).switch, false);
});

test("every why is one short plain-ASCII sentence", () => {
  const cases = [
    shouldSwitch(base),
    shouldSwitch({ ...base, remainingEhp: 10 }),
    shouldSwitch({ ...base, remainingEhp: null }),
    shouldSwitch({ ...base, currentDps: null }),
    shouldSwitch({ ...base, currentDps: 0 }),
    shouldSwitch({ ...base, bestDps: 0.5 }),
    shouldSwitch({ ...base, lastSwitchAtMs: NOW }),
    shouldSwitch({ ...base, direction: "up", currentDps: 8, bestDps: 25 }),
    shouldSwitch({ ...base, direction: "up", currentDps: 8, bestDps: 25, remainingEhp: null }),
    shouldSwitch({ ...base, direction: "up", currentDps: 8, bestDps: 25, remainingEhp: 99999 }),
  ];
  for (const { why } of cases) {
    assert.match(why, /^[\x20-\x7e]+$/);
    assert.ok(why.length < 80, why);
    assert.ok(why.endsWith("."), why);
  }
});

// ── the companion's two questions ────────────────────────────────────────────

const HULL = { bandwidthMbit: 75, maxActive: 5 };
const MIXED_BAY = bay([11, 2454, 5], [12, 2444, 3]);

test("sizedLaunch: lights for a frigate, heavies for a battleship, from one bay", () => {
  assert.equal(sizedLaunch(MIXED_BAY, FACTS, HULL, [FRIGATE])?.primaryTypeID, 2454);
  assert.equal(sizedLaunch(MIXED_BAY, FACTS, HULL, [BATTLESHIP])?.primaryTypeID, 2444);
});

test("sizedLaunch cannot judge without the bay, the hull limits or a target", () => {
  assert.equal(sizedLaunch(null, FACTS, HULL, [FRIGATE]), null);
  assert.equal(sizedLaunch(MIXED_BAY, FACTS, null, [FRIGATE]), null);
  assert.equal(sizedLaunch(MIXED_BAY, FACTS, HULL, []), null);
  assert.equal(sizedLaunch(MIXED_BAY, FACTS, HULL, [{ ...FRIGATE, signatureRadius: null }]), null);
});

const SWITCH_BASE = {
  bay: bay([12, 2444, 3]),
  facts: FACTS,
  limits: HULL,
  remainingEhp: 4000,
  lastSwitchAtMs: null,
  nowMs: NOW,
};

test("sizeSwitchVerdict: heavies out on a frigate come home for the lights", () => {
  const verdict = sizeSwitchVerdict({
    ...SWITCH_BASE,
    bay: bay([11, 2454, 5]),
    flightTypeIDs: [2444, 2444, 2444],
    target: FRIGATE,
  });
  assert.equal(verdict?.switch, true);
});

test("sizeSwitchVerdict: lights on a nearly dead battleship stay out", () => {
  const verdict = sizeSwitchVerdict({
    ...SWITCH_BASE,
    flightTypeIDs: [2454, 2454, 2454, 2454, 2454],
    target: BATTLESHIP,
    remainingEhp: 500,
  });
  assert.equal(verdict?.switch, false);
});

test("sizeSwitchVerdict: lights on a fresh battleship go up when the fight is long", () => {
  const verdict = sizeSwitchVerdict({
    ...SWITCH_BASE,
    flightTypeIDs: [2454, 2454, 2454, 2454, 2454],
    target: BATTLESHIP,
    remainingEhp: 200_000,
  });
  assert.equal(verdict?.switch, true);
});

test("sizeSwitchVerdict: nothing better in the bay never recalls", () => {
  const verdict = sizeSwitchVerdict({
    ...SWITCH_BASE,
    bay: bay(),
    flightTypeIDs: [2444, 2444, 2444],
    target: FRIGATE,
  });
  assert.notEqual(verdict?.switch, true, "no recall when the bay holds nothing better");
});

test("sizeSwitchVerdict cannot judge a drone whose type or facts are unknown", () => {
  assert.equal(sizeSwitchVerdict({ ...SWITCH_BASE, flightTypeIDs: [null], target: FRIGATE }), null);
  assert.equal(sizeSwitchVerdict({ ...SWITCH_BASE, flightTypeIDs: [999], target: FRIGATE }), null);
  assert.equal(sizeSwitchVerdict({ ...SWITCH_BASE, flightTypeIDs: [2454], target: FRIGATE, limits: null }), null);
});
