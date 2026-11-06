// The fitting window's derived statistics (goal R21, slice B).
//
// These are not made-up fixtures. Every attribute map below was produced by
// running EveJS's own fitting maths over the R20 dogma corpus
// (`tools/dogma-oracle/corpus.json`) with the operator's real skill sheet, and
// the expected outputs are the reference values in
// `docs/dogma-divergence-report.md` — which an INDEPENDENT dogma engine
// (EVEShipFit's, MIT) agreed with on every attribute, 767 comparisons, zero
// disagreements.
//
// So this suite does not check that our arithmetic is self-consistent. It
// checks it against a second engine's answer.

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNIFORM_DAMAGE_PROFILE,
  deriveShipStats,
  lockLimitOf,
  type Stat,
} from "./shipStats.ts";

function attributes(entries: Record<number, number>): ReadonlyMap<number, number | null> {
  return new Map(Object.entries(entries).map(([id, value]) => [Number(id), value]));
}

/** Assert a stat is known and read its value. */
function value(stat: Stat): number {
  assert.equal(stat.known, true, `expected a known value, got: ${stat.known ? "" : stat.why}`);
  return (stat as { known: true; value: number }).value;
}

/**
 * `drake-shield`: Drake + 6x HML II / Fury, 2x LSE II, 2x Multispectrum Shield
 * Hardener II, 2x BCS II, 2x CDFE. The shield resonances are quoted at full
 * precision from the divergence report, where both engines agreed to fifteen
 * significant figures.
 *
 * THIS IS THE ASSUMED-ACTIVE MAP — the one `dogmaIM.ShipGetInfo` really
 * returns, with both hardeners applied.
 */
const DRAKE = attributes({
  4: 13500000,
  9: 4687.5,
  37: 187.5,
  38: 450,
  109: 0.67,
  110: 0.67,
  111: 0.67,
  113: 0.67,
  55: 468750,
  70: 0.43875,
  76: 81250,
  192: 8,
  211: 22.8,
  263: 17688.4375,
  265: 4062.5,
  267: 0.5,
  268: 0.9,
  269: 0.75,
  270: 0.55,
  271: 0.38746944336953026,
  272: 0.19373472168476513,
  273: 0.23248166602171813,
  274: 0.30997555469562427,
  283: 25,
  479: 1050000,
  482: 3125,
  552: 377.991936,
  564: 243.75,
  600: 3.5,
  1271: 25,
  1281: 1,
});

/**
 * The SAME Drake as `buildShipResourceState()` reports it when called bare —
 * passive and online effects only, both hardeners silently missing. Every
 * shield resonance is the bare hull's. This map exists purely so the test
 * below can prove we are not reading it.
 */
const DRAKE_PASSIVE_ONLY = attributes({
  ...Object.fromEntries(DRAKE),
  271: 0.8,
  272: 0.4,
  273: 0.48,
  274: 0.64,
});

/** `rifter-tank`: Rifter + DCII, SAR II, 2x Multispectrum Coating II, SSE II, Trimark. */
const RIFTER_TANK = attributes({
  4: 1067000,
  9: 437.5,
  37: 456.25,
  38: 140,
  109: 0.402,
  110: 0.402,
  111: 0.402,
  113: 0.402,
  55: 93750,
  70: 2.268,
  76: 28125,
  192: 4,
  209: 9.6,
  263: 1212.5,
  265: 646.875,
  267: 0.228877,
  268: 0.514974,
  269: 0.429145,
  270: 0.371925,
  271: 0.875,
  272: 0.4375,
  273: 0.525,
  274: 0.7,
  479: 468750,
  482: 312.5,
  552: 37,
  564: 825,
  600: 5,
  1281: 1,
});

/** `mammoth-bare`: an unfitted hull, the simplest possible baseline. */
const MAMMOTH_BARE = attributes({
  4: 11500000,
  9: 1168.75,
  37: 187.5,
  38: 6875,
  109: 0.67,
  110: 0.67,
  111: 0.67,
  113: 0.67,
  55: 234375,
  70: 0.61425,
  76: 56250,
  192: 2,
  209: 9.6,
  263: 800,
  265: 750,
  267: 0.4,
  268: 0.9,
  269: 0.75,
  270: 0.65,
  271: 1,
  272: 0.5,
  273: 0.6,
  274: 0.8,
  479: 468750,
  482: 700,
  552: 180,
  564: 106.25,
  600: 3.5,
  1281: 1,
});

// ===========================================================================
// THE REGRESSION THAT MATTERS MOST
// ===========================================================================
//
// R20's highest-impact finding: `buildShipResourceState()` called bare applies
// only passive and online effects. Active modules contribute NOTHING and
// nothing errors — a Drake's EM resist reads 20% instead of 61.3% and its EHP
// halves, silently. If anything ever reroutes our read down that path, this
// test is what says so.

test("REGRESSION: a Drake's EM resist is ~61%, not the passive-only 20%", () => {
  const stats = deriveShipStats(DRAKE);
  const em = value(stats.tank.shield.resistances.em) * 100;

  // The number the oracle and EveJS both produce, with both hardeners applied.
  assert.ok(
    Math.abs(em - 61.253) < 0.01,
    `Drake shield EM resist should be ~61.25%, got ${em.toFixed(3)}%`,
  );

  // And explicitly NOT the trap's answer. If this ever reads 20%, the fitting
  // window has started calling `buildShipResourceState()` bare somewhere and
  // every tank number on screen is about half what it should be.
  assert.ok(
    Math.abs(em - 20) > 1,
    "Drake EM resist read 20% — the passive-only trap has been reintroduced",
  );
});

test("REGRESSION: a Drake's EHP is ~76k, not the passive-only ~38k", () => {
  const stats = deriveShipStats(DRAKE);
  const ehp = value(stats.totalEhp);

  // The oracle's own figure for this fit, to the unit.
  assert.ok(
    Math.abs(ehp - 75982) < 1,
    `Drake EHP should be 75 982 (the oracle's figure), got ${Math.round(ehp)}`,
  );
});

test("the trap, demonstrated: the passive-only map really does halve the tank", () => {
  // Feeding the WRONG map through the SAME code proves the divergence is in
  // the input, not in our arithmetic — and shows exactly what a future
  // regression would look like on screen.
  //
  // NOTE ON THE NUMBERS. The divergence report says a trapped Drake reads
  // "~38 000 instead of ~76 000". Computed exactly from the two attribute
  // maps, the totals are 43 512 and 75 982 — a 1.75x understatement, not 2x.
  // The report's "factor-of-two" is exactly right about the layer it is
  // actually talking about: the SHIELD, which the vanished hardeners act on,
  // drops 62 967 -> 30 497, a factor of 2.065. Armor and structure are
  // untouched by the trap, which is what dilutes the total. Pinned here at
  // full precision so neither figure has to be approximated again.
  const trapped = deriveShipStats(DRAKE_PASSIVE_ONLY);
  const correct = deriveShipStats(DRAKE);

  assert.ok(
    Math.abs(value(trapped.tank.shield.resistances.em) * 100 - 20) < 0.001,
    "passive-only EM resist should be exactly the bare hull's 20%",
  );

  // The shield layer: the factor of two the report warns about.
  const trappedShield = value(trapped.tank.shield.ehp);
  const correctShield = value(correct.tank.shield.ehp);
  assert.ok(Math.abs(trappedShield - 30497) < 1, `got ${Math.round(trappedShield)}`);
  assert.ok(Math.abs(correctShield - 62967) < 1, `got ${Math.round(correctShield)}`);
  assert.ok(
    Math.abs(correctShield / trappedShield - 2.065) < 0.005,
    "the shield layer must be understated by ~2x under the trap",
  );

  // Armor and structure are unaffected — the trap only eats ACTIVE modules.
  assert.equal(value(trapped.tank.armor.ehp), value(correct.tank.armor.ehp));
  assert.equal(value(trapped.tank.hull.ehp), value(correct.tank.hull.ehp));

  // And the total, which is what a player actually reads off the window.
  const trappedTotal = value(trapped.totalEhp);
  assert.ok(Math.abs(trappedTotal - 43512) < 1, `got ${Math.round(trappedTotal)}`);
  assert.ok(Math.abs(value(correct.totalEhp) / trappedTotal - 1.746) < 0.005);
});

// ===========================================================================
// Against the R20 reference table
// ===========================================================================

test("resistances match the oracle on every fit in the corpus", () => {
  // docs/dogma-divergence-report.md, "shield resists (EM/Exp/Kin/Th)".
  const cases: [string, ReadonlyMap<number, number | null>, [number, number, number, number]][] = [
    ["drake-shield", DRAKE, [61.3, 80.6, 76.8, 69.0]],
    ["rifter-tank", RIFTER_TANK, [12.5, 56.3, 47.5, 30.0]],
    ["mammoth-bare", MAMMOTH_BARE, [0, 50.0, 40.0, 20.0]],
  ];
  for (const [id, map, expected] of cases) {
    const shield = deriveShipStats(map).tank.shield.resistances;
    const actual = [
      value(shield.em) * 100,
      value(shield.explosive) * 100,
      value(shield.kinetic) * 100,
      value(shield.thermal) * 100,
    ];
    for (let i = 0; i < 4; i += 1) {
      assert.ok(
        Math.abs(actual[i]! - expected[i]!) < 0.06,
        `${id} shield resist ${i}: expected ${expected[i]}%, got ${actual[i]!.toFixed(2)}%`,
      );
    }
  }
});

test("EHP matches the oracle on every fit in the corpus", () => {
  // docs/dogma-divergence-report.md, "EHP" column, uniform 25/25/25/25.
  const cases: [string, ReadonlyMap<number, number | null>, number][] = [
    ["drake-shield", DRAKE, 75982],
    ["rifter-tank", RIFTER_TANK, 4674],
    ["mammoth-bare", MAMMOTH_BARE, 3959],
  ];
  for (const [id, map, expected] of cases) {
    const ehp = value(deriveShipStats(map).totalEhp);
    assert.ok(
      Math.abs(ehp - expected) <= 1,
      `${id} EHP: expected ${expected}, got ${Math.round(ehp)}`,
    );
  }
});

test("align time matches the oracle, using the server's own formula", () => {
  // docs/dogma-divergence-report.md, "align" column.
  const cases: [string, ReadonlyMap<number, number | null>, number][] = [
    ["drake-shield", DRAKE, 8.21],
    ["rifter-tank", RIFTER_TANK, 3.35],
    ["mammoth-bare", MAMMOTH_BARE, 9.79],
  ];
  for (const [id, map, expected] of cases) {
    const align = value(deriveShipStats(map).navigation.alignTimeSeconds);
    assert.ok(
      Math.abs(align - expected) < 0.01,
      `${id} align: expected ${expected}s, got ${align.toFixed(2)}s`,
    );
  }
});

test("velocity is passed through exactly as the server reports it", () => {
  assert.equal(value(deriveShipStats(DRAKE).navigation.maxVelocity), 187.5);
  assert.equal(value(deriveShipStats(RIFTER_TANK).navigation.maxVelocity), 456.25);
});

test("EHP is quoted against a stated damage profile", () => {
  const stats = deriveShipStats(DRAKE);
  assert.deepEqual(stats.damageProfile, UNIFORM_DAMAGE_PROFILE);
  // A different profile really does change the answer — proof the profile is
  // an input and not decoration.
  const emHeavy = deriveShipStats(DRAKE, { em: 1, thermal: 0, kinetic: 0, explosive: 0 });
  assert.notEqual(Math.round(value(emHeavy.totalEhp)), Math.round(value(stats.totalEhp)));
});

// ===========================================================================
// The rest of what the window shows
// ===========================================================================

test("the per-layer tank is broken out with its own HP, resists and EHP", () => {
  const tank = deriveShipStats(DRAKE).tank;
  assert.equal(value(tank.shield.hp), 17688.4375);
  assert.equal(value(tank.armor.hp), 4062.5);
  assert.equal(value(tank.hull.hp), 4687.5);

  // Armor: 4062.5 / mean(0.5, 0.55, 0.75, 0.9) = 4062.5 / 0.675.
  assert.ok(Math.abs(value(tank.armor.ehp) - 4062.5 / 0.675) < 0.001);
  // Hull: all four resonances are 0.67.
  assert.ok(Math.abs(value(tank.hull.ehp) - 4687.5 / 0.67) < 0.001);

  // The three layers sum to the total.
  const sum = value(tank.shield.ehp) + value(tank.armor.ehp) + value(tank.hull.ehp);
  assert.ok(Math.abs(sum - value(deriveShipStats(DRAKE).totalEhp)) < 0.001);
});

test("hull resistances read 109/110/111/113 and never 112", () => {
  // 112 is `energyDamageAbsorptionFactor`, NOT a resistance. A contiguous
  // 109-112 read looks obviously right and is wrong, so this pins it: a map
  // with a decoy 112 must not change any hull resistance.
  const withDecoy = attributes({ ...Object.fromEntries(DRAKE), 112: 0.123 });
  const before = deriveShipStats(DRAKE).tank.hull.resistances;
  const after = deriveShipStats(withDecoy).tank.hull.resistances;
  assert.deepEqual(after, before);
});

test("targeting, navigation and bay figures come straight off the read", () => {
  const stats = deriveShipStats(DRAKE);
  assert.equal(value(stats.targeting.maxTargetRange), 81250);
  assert.equal(value(stats.targeting.maxLockedTargets), 8);
  assert.equal(value(stats.targeting.scanResolution), 243.75);
  assert.equal(value(stats.targeting.sensorStrength), 22.8);
  assert.equal(stats.targeting.sensorName, "Gravimetric");

  assert.equal(value(stats.navigation.signatureRadius), 377.991936);
  // Warp speed is base x multiplier.
  assert.equal(value(stats.navigation.warpSpeedAuPerSecond), 3.5);

  assert.equal(value(stats.bays.cargoCapacity), 450);
  assert.equal(value(stats.bays.droneCapacity), 25);
  assert.equal(value(stats.bays.droneBandwidth), 25);
});

test("the sensor is named by which one the hull actually has", () => {
  assert.equal(deriveShipStats(RIFTER_TANK).targeting.sensorName, "Ladar");
  assert.equal(deriveShipStats(DRAKE).targeting.sensorName, "Gravimetric");
});

test("capacitor capacity and recharge are shown; recharge is in seconds", () => {
  const cap = deriveShipStats(DRAKE).capacitor;
  assert.equal(value(cap.capacity), 3125);
  // The attribute is milliseconds (468 750 ms).
  assert.equal(value(cap.rechargeSeconds), 468.75);
});

test("a docked ship's capacitor still reads, via charge instead of capacity", () => {
  // Docked, attribute 482 comes back null and the effective capacitor arrives
  // as attribute 18 — the same quirk R12's resource bar already handles.
  const docked = new Map<number, number | null>([...DRAKE, [482, null], [18, 2900]]);
  assert.equal(value(deriveShipStats(docked).capacitor.capacity), 2900);
});

// ===========================================================================
// UNAVAILABLE — the honesty rules
// ===========================================================================

test("capacitor stability is never invented", () => {
  // EveJS has no capacitor solver, and R20 established the oracle's own
  // approach is unusable here (it needs EVEShipFit-specific attributes that
  // are not in the SDE). So we say so.
  const cap = deriveShipStats(DRAKE).capacitor;
  assert.equal(cap.stability.known, false);
  assert.equal(cap.lastsForSeconds.known, false);
  assert.equal(cap.deltaPerSecond.known, false);
});

test("everything that needs per-module numbers is unavailable, with a reason", () => {
  // The bridge is allowed exactly two fitting reads — the SHIP's attributes
  // and which modules are online. Nothing returns per-module effective
  // attributes, so nothing that must be summed over modules can be computed.
  const stats = deriveShipStats(DRAKE);
  const blocked: Stat[] = [
    stats.firepower.dps,
    stats.firepower.volley,
    stats.firepower.droneDps,
    stats.mining.cubicMetresPerSecond,
    stats.repairs.shield,
    stats.repairs.armor,
    stats.repairs.hull,
  ];
  for (const stat of blocked) {
    assert.equal(stat.known, false);
    assert.ok(
      (stat as { known: false; why: string }).why.length > 10,
      "an unavailable stat must explain itself",
    );
  }
});

test("an unavailable statistic is never a zero and never a blank", () => {
  // The failure mode this guards: a stat we could not source rendering as `0`
  // or as an empty cell, both of which a player reads as "zero", which is a
  // claim we are not entitled to make.
  const empty = deriveShipStats(new Map());
  const stats = [
    empty.totalEhp,
    empty.navigation.alignTimeSeconds,
    empty.navigation.warpSpeedAuPerSecond,
    empty.capacitor.capacity,
    empty.targeting.sensorStrength,
    empty.tank.shield.hp,
    empty.tank.shield.ehp,
    empty.tank.shield.resistances.em,
  ];
  for (const stat of stats) {
    assert.equal(stat.known, false, "a ship that reports nothing must yield no known values");
    const why = (stat as { known: false; why: string }).why;
    assert.ok(why.length > 0);
    // The reason is player-facing prose, not a code or a bare dash.
    assert.doesNotMatch(why, /^[-—0\s]*$/);
  }
  assert.equal(empty.targeting.sensorName, null);
});

test("a partial read yields partial answers, never a wrong total", () => {
  // Shield HP present, armor and structure missing: the layers we know still
  // report, and the TOTAL refuses rather than understating the ship.
  const partial = attributes({
    263: 5000,
    271: 0.4,
    272: 0.4,
    273: 0.4,
    274: 0.4,
  });
  const stats = deriveShipStats(partial);
  assert.equal(stats.tank.shield.ehp.known, true);
  assert.equal(value(stats.tank.shield.ehp), 12500);
  assert.equal(stats.tank.armor.ehp.known, false);
  assert.equal(
    stats.totalEhp.known,
    false,
    "a total that omits a layer would understate the ship and must not be shown",
  );
});

test("the lock limit is the lower of the hull's and the pilot's", () => {
  const hull = deriveShipStats(attributes({ 192: 10 })).targeting.maxLockedTargets;
  assert.equal(lockLimitOf(hull, 5), 5, "a pilot short of the hull's limit is what the server holds them to");
  assert.equal(lockLimitOf(deriveShipStats(attributes({ 192: 3 })).targeting.maxLockedTargets, 12), 3, "and a small hull the other way");
  assert.equal(lockLimitOf(hull, null), 10, "a pilot not read says nothing");
  assert.equal(lockLimitOf(hull, 0), 10);
  assert.equal(lockLimitOf(deriveShipStats(attributes({})).targeting.maxLockedTargets, 5), null, "a hull not read is not a guess");
});
