// The one test every list of modules the companion switches on is gated by
// (nav/moduleActivation.ts). Seen live 2026-10-14: a Drone Navigation Computer I,
// picked by its group name, was refused "... cannot be activated." once a fight.

import test from "node:test";
import assert from "node:assert/strict";

import { isNotActivatableRefusal, moduleActivation } from "./moduleActivation.ts";

const refused = (message: string, code = "CALL_REFUSED"): Error => Object.assign(new Error(message), { code });

test("the type's own answer decides, whatever the item's cycle says", () => {
  // A Drone Navigation Computer: no effect the server would take.
  assert.equal(moduleActivation({ typeActivatable: false, itemCycles: null }), "passive");
  // A Mining Foreman Link's type carries a duration and no effect the server would take.
  assert.equal(moduleActivation({ typeActivatable: false, itemCycles: true }), "passive");
  // An Abyssal module's TYPE has no duration; its item does, and the server takes its effect.
  assert.equal(moduleActivation({ typeActivatable: true, itemCycles: false }), "activatable");
  assert.equal(moduleActivation({ typeActivatable: true, itemCycles: null }), "activatable");
});

test("with the type's answer unread, the item's cycle stands in for it", () => {
  for (const unread of [null, undefined]) {
    assert.equal(moduleActivation({ typeActivatable: unread, itemCycles: true }), "activatable");
    assert.equal(moduleActivation({ typeActivatable: unread, itemCycles: false }), "passive");
  }
});

test("nothing read is unknown, and unknown is never passive", () => {
  assert.equal(moduleActivation({ typeActivatable: null, itemCycles: null }), "unknown");
  assert.equal(moduleActivation({ typeActivatable: undefined, itemCycles: null }), "unknown");
});

test("the server's refusal of a module that never can be switched on is recognised", () => {
  assert.equal(isNotActivatableRefusal(refused("Drone Navigation Computer I cannot be activated.")), true);
  assert.equal(isNotActivatableRefusal(refused("Damage Control II cannot be activated")), true);
});

test("a refusal of the moment is not one: it stays retryable", () => {
  for (const message of [
    "That module cannot be activated while you are warp scrambled.",
    "That module cannot be activated while your ship is immobilized.",
    "That module cannot be activated in the current security band.",
    "MODULE_NOT_ONLINE",
    "TargetNotWithinRangeGeneric",
  ]) {
    assert.equal(isNotActivatableRefusal(refused(message)), false, message);
  }
});

test("only a definite refusal counts: a lost answer or a non-error says nothing", () => {
  assert.equal(isNotActivatableRefusal(refused("Drone Navigation Computer I cannot be activated.", "BRIDGE_NETWORK_ERROR")), false);
  assert.equal(isNotActivatableRefusal(new Error("Drone Navigation Computer I cannot be activated.")), false);
  assert.equal(isNotActivatableRefusal("Drone Navigation Computer I cannot be activated."), false);
  assert.equal(isNotActivatableRefusal(null), false);
});
