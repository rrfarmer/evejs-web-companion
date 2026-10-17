import test from "node:test";
import assert from "node:assert/strict";

import {
  CHARGE_ATTRIBUTE_IDS,
  UNKNOWN_CHARGE,
  candidateReachM,
  chargeFactsFromAttributes,
  type ChargeFacts,
} from "./ammoReach.ts";

// Synthetic type ids; the attribute rows mirror the shapes static dogma carries.
const ANTIMATTER = 9001; // turret charge: 0.5 optimal factor, no 517 at all (default 1)
const IRON = 9002; // turret charge: 1.6 optimal factor, 0.75 falloff factor
const FAST_MISSILE = 9003;
const SLOW_MISSILE = 9004;

const antimatter = chargeFactsFromAttributes({ 114: 0, 116: 0, 117: 7, 118: 5, 120: 0.5, 128: 1 });
const iron = chargeFactsFromAttributes({ 114: 0, 116: 0, 117: 3, 118: 2, 120: 1.6, 517: 0.75, 128: 1 });
const fast = chargeFactsFromAttributes({ 117: 83, 37: 3750, 281: 5000 });
const slow = chargeFactsFromAttributes({ 116: 90, 37: 2500, 281: 6000 });

test("charge facts: damage split, range factors, size; absent 120/517 are the SDE default 1", () => {
  assert.deepEqual(antimatter.damage, { em: 0, thermal: 5, kinetic: 7, explosive: 0 });
  assert.equal(antimatter.rangeMultiplier, 0.5);
  assert.equal(antimatter.falloffMultiplier, 1, "a charge without 517 is dogma's default, not unknown");
  assert.equal(antimatter.size, 1);
  assert.equal(antimatter.maxVelocity, null);
  assert.deepEqual(fast.damage, { em: 0, thermal: 0, kinetic: 83, explosive: 0 }, "missing components are 0");
  assert.equal(fast.maxVelocity, 3750);
  assert.equal(fast.explosionDelayMs, 5000);
  assert.equal(fast.size, null);
});

test("charge facts: an unanswered or unknown type is unknown throughout, and the read fits one call", () => {
  assert.deepEqual(chargeFactsFromAttributes(undefined), UNKNOWN_CHARGE);
  assert.deepEqual(chargeFactsFromAttributes({}, "Name"), { ...UNKNOWN_CHARGE, name: "Name" });
  assert.equal(chargeFactsFromAttributes({ 120: 1 }).damage, null, "a type carrying no damage at all has none known");
  assert.equal(chargeFactsFromAttributes({ 117: 3, 120: 0 }).rangeMultiplier, null, "a zero factor is not a factor");
  assert.ok(CHARGE_ATTRIBUTE_IDS.length <= 32);
});

test("turret: base optimal and falloff are recovered from the loaded charge, then rescaled", () => {
  // Measured with Antimatter: optimal 5 km, reach 8 km (falloff 3 km).
  // Base optimal 5 / 0.5 = 10 km; base falloff 3 / 1 = 3 km.
  // Iron: 10 x 1.6 + 3 x 0.75 = 18.25 km.
  const gun = { reachM: 8_000, optimalM: 5_000, turret: true };
  assert.equal(candidateReachM(gun, ANTIMATTER, antimatter, IRON, iron), 18_250);
  // And back again: measured with Iron, Antimatter is 8 km.
  const ironGun = { reachM: 18_250, optimalM: 16_000, turret: true };
  assert.equal(candidateReachM(ironGun, IRON, iron, ANTIMATTER, antimatter), 8_000);
});

test("missile: reach scales with velocity x flight time", () => {
  const launcher = { reachM: 30_000, optimalM: null, turret: false };
  // 30 km x (2500 x 6000) / (3750 x 5000) = 24 km.
  assert.equal(candidateReachM(launcher, FAST_MISSILE, fast, SLOW_MISSILE, slow), 24_000);
});

test("the loaded type is its measured reach, without the arithmetic", () => {
  const gun = { reachM: 8_000, optimalM: 5_000, turret: true };
  assert.equal(candidateReachM(gun, ANTIMATTER, null, ANTIMATTER, null), 8_000);
});

test("any unknown factor is an unknown reach, never a guess", () => {
  const gun = { reachM: 8_000, optimalM: 5_000, turret: true };
  const noFactor: ChargeFacts = { ...iron, rangeMultiplier: null };
  assert.equal(candidateReachM(gun, ANTIMATTER, antimatter, IRON, noFactor), null, "candidate factor unknown");
  assert.equal(candidateReachM(gun, ANTIMATTER, null, IRON, iron), null, "loaded charge unread");
  assert.equal(candidateReachM(gun, ANTIMATTER, antimatter, IRON, null), null, "candidate unread");
  assert.equal(candidateReachM({ ...gun, optimalM: null }, ANTIMATTER, antimatter, IRON, iron), null, "optimal unread");
  assert.equal(candidateReachM({ ...gun, reachM: null }, ANTIMATTER, antimatter, IRON, iron), null, "reach unread");
  assert.equal(candidateReachM({ ...gun, turret: null }, ANTIMATTER, antimatter, IRON, iron), null, "weapon kind unknown");
  assert.equal(candidateReachM({ ...gun, reachM: Number.NaN }, ANTIMATTER, antimatter, ANTIMATTER, antimatter), null);
  const launcher = { reachM: 30_000, optimalM: null, turret: false };
  assert.equal(candidateReachM(launcher, FAST_MISSILE, fast, SLOW_MISSILE, { ...slow, explosionDelayMs: null }), null);
  assert.equal(candidateReachM(launcher, FAST_MISSILE, { ...fast, maxVelocity: null }, SLOW_MISSILE, slow), null);
});
