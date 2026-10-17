// The rat classifier: raw dogma in, "what it will do to you" out. Pins the one
// case a name or group match cannot see (two rats of the same faction and size
// where only the attribute separates the tackler from the harmless one), the
// chance-is-the-gate rule (a range without a chance is not a scrammer), and the
// cannot-tell rule (an empty attribute map is "not told", never "safe").
//
// Every fixture below is a real entity type's real attribute values, read out
// of the pinned SDE (`typeDogma.jsonl`) — the numbers are the point of the
// test, so a fixture that drifted from the game would be no fixture at all.

import test from "node:test";
import assert from "node:assert/strict";

import { THREAT_ATTRIBUTE_IDS, UNKNOWN_THREAT, threatFromAttributes } from "./ratThreat.ts";

// id -> value, exactly the shape a dogma fetch hands over.
type Attributes = Record<number, number>;

// The tackle frigates: chance 0.25, reach 20 km, and a web on the same hull.
const DIRE_PITHI_ARROGATOR: Attributes = { 20: -50, 103: 20_000, 105: 1, 504: 0.25 };
const ARCH_ANGEL_ROGUE: Attributes = { 20: -50, 103: 20_000, 105: 1, 504: 0.25 };
// Same family, one tier down: carries neither.
const PITHI_ARROGATOR: Attributes = { 20: 0, 103: 0, 504: 0 };
// A damper, and nothing that holds the ship down.
const SERPENTIS_WATCHMAN: Attributes = { 20: 0, 103: 0, 504: 0, 932: 0.05 };
// ⚠ The trap: a scrambler's range AND strength, with the chance at zero.
const PITHUM_SILENCER: Attributes = { 20: 0, 103: 15_000, 105: 1, 504: 0 };

test("a rat that will hold the ship down is read off its dogma, reach and all", () => {
  for (const [name, attributes] of [
    ["Dire Pithi Arrogator", DIRE_PITHI_ARROGATOR],
    ["Arch Angel Rogue", ARCH_ANGEL_ROGUE],
  ] as const) {
    const threat = threatFromAttributes(attributes);
    assert.deepEqual(threat, { scram: true, scramRangeM: 20_000, web: true, ewar: false, ecm: false }, name);
  }
});

test("the same family, one tier down, is not a threat — and only the attribute says so", () => {
  // ⚠ THE TEST THIS MODULE EXISTS FOR. Same faction, same hull size, names that
  // differ by one word: a group match and a name match both put these two in
  // the same bucket, and the dogma does not.
  const harmless = threatFromAttributes(PITHI_ARROGATOR);
  assert.deepEqual(harmless, { scram: false, scramRangeM: null, web: false, ewar: false, ecm: false });
  const tackler = threatFromAttributes(DIRE_PITHI_ARROGATOR);
  assert.notEqual(harmless.scram, tackler.scram, "the classifier must separate them");
});

test("a scrambler's range and strength are NOT a scrambler — the chance is the gate", () => {
  // Range 15 km and strength 1 on the hull, chance 0: it has the numbers and
  // never uses them. Reading the range instead would make a stand-off block
  // flee an ordinary rat.
  const threat = threatFromAttributes(PITHUM_SILENCER);
  assert.equal(threat.scram, false);
  assert.equal(threat.scramRangeM, null, "no reach is reported for something that does not reach");
});

test("a scram range is reported only for a scrammer, and never as 0", () => {
  assert.equal(threatFromAttributes({ 504: 0.25, 103: 20_000 }).scramRangeM, 20_000);
  // Scrams, but nobody said from how far: null is "not told", and a 0 here
  // would read as "holds you at zero metres" to anything computing a band.
  assert.equal(threatFromAttributes({ 504: 0.25 }).scramRangeM, null);
  assert.equal(threatFromAttributes({ 504: 0.25, 103: 0 }).scramRangeM, null);
  assert.equal(threatFromAttributes({ 103: 20_000 }).scramRangeM, null, "a range alone reports nothing");
});

test("webbing is speedFactor STRICTLY below zero — carrying the attribute at 0 does nothing", () => {
  assert.equal(threatFromAttributes({ 20: -50 }).web, true);
  assert.equal(threatFromAttributes({ 20: -1 }).web, true);
  assert.equal(threatFromAttributes({ 20: 0 }).web, false);
  assert.equal(threatFromAttributes({ 20: 10 }).web, false, "a positive speed factor is not a web");
});

test("each of the four ewar chances is read, and only above zero", () => {
  for (const id of [930, 931, 932, 935]) {
    assert.equal(threatFromAttributes({ [id]: 0.05 }).ewar, true, `attribute ${id} at 0.05`);
    assert.equal(threatFromAttributes({ [id]: 0 }).ewar, false, `attribute ${id} at 0`);
  }
  const watchman = threatFromAttributes(SERPENTIS_WATCHMAN);
  assert.deepEqual(watchman, { scram: false, scramRangeM: null, web: false, ewar: true, ecm: false });
});

test("ECM is gated on ECMEntityChance above zero — and a jammer is ewar too", () => {
  // Guristas Despoiler: 930 = 1, 504 = 0, 20 = 0 — jams, holds nobody.
  const jammer = threatFromAttributes({ 20: 0, 103: 0, 504: 0, 930: 1 });
  assert.deepEqual(jammer, { scram: false, scramRangeM: null, web: false, ewar: true, ecm: true });
  // The attribute listed at zero does nothing, same as the scram gate.
  const dormant = threatFromAttributes({ 20: 0, 504: 0, 930: 0 });
  assert.equal(dormant.ecm, false);
  assert.equal(dormant.ewar, false);
  // A damper is ewar but not ECM: the two are told apart.
  assert.equal(threatFromAttributes({ 932: 0.05 }).ecm, false);
  // Missing attribute is "not told" for the flag, never a jam; unreadable too.
  assert.equal(threatFromAttributes({ 504: 0.25 }).ecm, false);
  assert.equal(threatFromAttributes({ 930: Number.NaN }).ecm, false);
});

test("a rat can be more than one thing at once — the flags do not compete", () => {
  const both = threatFromAttributes({ 504: 0.25, 103: 20_000, 20: -50, 931: 0.1 });
  assert.deepEqual(both, { scram: true, scramRangeM: 20_000, web: true, ewar: true, ecm: false });
});

test("nothing known is UNKNOWN — 'not told', which is never the same as 'harmless'", () => {
  assert.deepEqual(threatFromAttributes(null), UNKNOWN_THREAT);
  assert.deepEqual(threatFromAttributes(undefined), UNKNOWN_THREAT);
  assert.deepEqual(threatFromAttributes({}), UNKNOWN_THREAT, "an empty fetch is not an answer");
  assert.deepEqual(UNKNOWN_THREAT, { scram: false, scramRangeM: null, web: false, ewar: false, ecm: false });
});

test("an unreadable value is treated as absent, not as a threat", () => {
  // NaN is what a bad decode leaves behind; promoting it would invent tackle.
  assert.equal(threatFromAttributes({ 504: Number.NaN, 20: Number.NaN }).scram, false);
  assert.equal(threatFromAttributes({ 504: Number.NaN, 20: Number.NaN }).web, false);
  // A map that carried only unreadable values still counts as "asked", and the
  // answer is the same all-false verdict — never a guess in the other direction.
  assert.equal(threatFromAttributes({ 504: Number.NaN }).ewar, false);
});

test("the fetch list carries every attribute the classifier reads", () => {
  // Two lists on purpose — this one is what a caller ASKS for, the classifier
  // is what it READS — so an attribute added to one and forgotten in the other
  // would silently classify every rat off half its dogma.
  assert.deepEqual([...THREAT_ATTRIBUTE_IDS].sort((a, b) => a - b), [20, 103, 504, 930, 931, 932, 935]);
});
