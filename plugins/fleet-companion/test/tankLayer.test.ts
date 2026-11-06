import test from "node:test";
import assert from "node:assert/strict";

import { voteTankLayer } from "../lib/tankLayer.ts";

// ⚠ EVERY GROUP NAME BELOW IS THE SDE's OWN ENGLISH NAME, checked against
// `groups.jsonl` rather than remembered: 38 Shield Extender, 39 Shield
// Recharger, 57 Shield Power Relay, 60 Damage Control, 77 Shield Hardener, 98
// Armor Coating, 295 Shield Resistance Amplifier, 326 Energized Armor Membrane,
// 328 Armor Hardener, 329 Armor Plate, 338 Shield Boost Amplifier, 773 Rig
// Armor, 774 Rig Shield, 1150 Armor Resistance Shift Hardener, 1699 Flex Armor
// Hardener, 1700 Flex Shield Hardener. A test that invents a group name proves
// nothing about a classifier whose whole job is matching real ones.

test("a plated brick says armour", () => {
  assert.equal(voteTankLayer(["Armor Plate", "Armor Plate", "Energized Armor Membrane"]), "armor");
});

test("an extender brick says shield", () => {
  assert.equal(voteTankLayer(["Shield Extender", "Shield Extender", "Shield Recharger"]), "shield");
});

test("the passive skins vote, which is the whole point — none of them can be cycled", () => {
  assert.equal(voteTankLayer(["Armor Coating"]), "armor");
  assert.equal(voteTankLayer(["Shield Resistance Amplifier"]), "shield");
  assert.equal(voteTankLayer(["Shield Power Relay"]), "shield");
  assert.equal(voteTankLayer(["Shield Boost Amplifier"]), "shield");
});

test("rigs vote, and they are the plainest statement a fit makes", () => {
  assert.equal(voteTankLayer(["Rig Armor", "Rig Armor"]), "armor");
  assert.equal(voteTankLayer(["Rig Shield"]), "shield");
});

test("the hardeners of both layers vote, flex and resistance-shift included", () => {
  assert.equal(voteTankLayer(["Armor Hardener"]), "armor");
  assert.equal(voteTankLayer(["Armor Resistance Shift Hardener"]), "armor");
  assert.equal(voteTankLayer(["Flex Armor Hardener"]), "armor");
  assert.equal(voteTankLayer(["Shield Hardener"]), "shield");
  assert.equal(voteTankLayer(["Flex Shield Hardener"]), "shield");
});

// ⚠ THE ONE MODULE THAT WOULD DROWN EVERY OTHER SIGNAL. Group 60 hardens all
// three layers and is on a large share of all fits; if it voted, it would vote
// on nearly every ship in the game and mean nothing on any of them.
test("a Damage Control does not vote for anybody", () => {
  assert.equal(voteTankLayer(["Damage Control"]), null);
  assert.equal(voteTankLayer(["Damage Control", "Armor Plate"]), "armor");
});

// Somebody else's tank is not evidence about this hull's, and this is the exact
// shape of the Remote-Shield-Booster-read-as-a-local-rep bug the module
// classifier already carries a warning about.
test("remote modules never vote", () => {
  assert.equal(voteTankLayer(["Remote Shield Booster", "Remote Armor Repairer"]), null);
  assert.equal(voteTankLayer(["Remote Shield Booster", "Armor Plate"]), "armor");
});

// A fleet-boost module is about the FLEET's shields, not this ship's, and an
// unanchored /shield/ would have counted it.
test("a shield command burst is not a shield tank", () => {
  assert.equal(voteTankLayer(["Shield Command Burst"]), null);
});

test("and neither is a shield booster — the repairer lists already answered that", () => {
  // Not an oversight: `tankHealth` decides on the self-repair lists before it
  // ever asks this module, so counting boosters here would be a second, weaker
  // answer to a question that already has a stronger one.
  assert.equal(voteTankLayer(["Shield Booster", "Armor Repair Unit"]), null);
});

// ⚠ A TIE IS NOT A COIN TOSS. A hull building both tanks has not said which one
// matters, and `null` puts the ladder back on the worst-layer fold -- which is
// what every fit did before this existed, so an unrecognised name can only ever
// be as bad as the old behaviour.
test("a fit that builds both tanks says nothing", () => {
  assert.equal(voteTankLayer(["Shield Extender", "Armor Plate"]), null);
});

test("an empty fit, an unresolved group and a blank name all say nothing", () => {
  assert.equal(voteTankLayer([]), null);
  assert.equal(voteTankLayer([null, null]), null);
  assert.equal(voteTankLayer(["   "]), null);
});

test("the match is the whole group name, never a substring of it", () => {
  assert.equal(voteTankLayer(["Structure Armor Reinforcer"]), null);
  assert.equal(voteTankLayer(["Armor Plate Blueprint"]), null);
});

test("a name the game gave with stray whitespace still counts", () => {
  assert.equal(voteTankLayer([" Armor Plate "]), "armor");
});
