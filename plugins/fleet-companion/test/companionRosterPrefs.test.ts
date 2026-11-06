// The companions window's roster: what survives a reload, and what a hostile or
// stale stored value is allowed to do to it (nothing).

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_COMPANION_ROSTER,
  addRosterMember,
  loadCompanionRoster,
  removeRosterMember,
  saveCompanionRoster,
  setCompanionRosterStorage,
  setRosterFleetName,
  setRosterSetup,
  type CompanionRosterStorage,
} from "../lib/companionRosterPrefs.ts";
import { DEFAULT_COMPANION_SETUP } from "../lib/fleetCompanionLoop.ts";

function memoryStorage(seed: Record<string, string> = {}): CompanionRosterStorage & {
  readonly items: Record<string, string>;
} {
  const items: Record<string, string> = { ...seed };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
}

const KEY = "evejs-web-companion-roster:v1";

test("an op survives a save and a load", () => {
  const store = memoryStorage();
  setCompanionRosterStorage(store);
  let prefs = setRosterFleetName(EMPTY_COMPANION_ROSTER, "Gabu ops");
  prefs = addRosterMember(prefs, 90000001);
  prefs = addRosterMember(prefs, 90000002);
  saveCompanionRoster(prefs);

  const back = loadCompanionRoster();
  assert.equal(back.fleetName, "Gabu ops");
  assert.deepEqual(back.members, [90000001, 90000002]);
  assert.deepEqual(back.setup, DEFAULT_COMPANION_SETUP);
});

test("pilots are kept by character, in the order they were added", () => {
  // ⚠ NOT BY SESSION. A session id is minted per slot per tab, so a roster
  // keyed by one would be empty after every reload.
  let prefs = addRosterMember(EMPTY_COMPANION_ROSTER, 90000002);
  prefs = addRosterMember(prefs, 90000001);
  assert.deepEqual(prefs.members, [90000002, 90000001]);
});

test("adding a pilot twice changes nothing, and neither does removing an absent one", () => {
  const once = addRosterMember(EMPTY_COMPANION_ROSTER, 90000001);
  assert.equal(addRosterMember(once, 90000001), once);
  assert.equal(removeRosterMember(EMPTY_COMPANION_ROSTER, 90000001), EMPTY_COMPANION_ROSTER);
});

test("removing takes exactly the one pilot out", () => {
  let prefs = addRosterMember(EMPTY_COMPANION_ROSTER, 90000001);
  prefs = addRosterMember(prefs, 90000002);
  assert.deepEqual(removeRosterMember(prefs, 90000001).members, [90000002]);
});

test("the fleet name is stored exactly as the player typed it", () => {
  // Every row echoes it back; normalising here would show the player a fleet
  // name they did not write.
  const prefs = setRosterFleetName(EMPTY_COMPANION_ROSTER, "  Gabu OPS ");
  assert.equal(prefs.fleetName, "  Gabu OPS ");
});

test("one setup covers the op", () => {
  const setup = { ...DEFAULT_COMPANION_SETUP, fleeHealthFloor: 0.5 };
  assert.equal(setRosterSetup(EMPTY_COMPANION_ROSTER, setup).setup.fleeHealthFloor, 0.5);
});

// ─── what stored bytes are allowed to do ─────────────────────────────────────

test("a stored setup that the codec refuses falls back to the default", () => {
  // The window always renders exactly one setup, so unlike a hangar config
  // there is nothing sensible to DROP to.
  setCompanionRosterStorage(
    memoryStorage({ [KEY]: JSON.stringify({ fleetName: "x", members: [], setup: { role: "dps" } }) }),
  );
  assert.deepEqual(loadCompanionRoster().setup, DEFAULT_COMPANION_SETUP);
});

test("junk in the members list is dropped, not defaulted, and duplicates collapse", () => {
  setCompanionRosterStorage(
    memoryStorage({
      [KEY]: JSON.stringify({ members: [90000001, "nope", 0, -3, null, 90000001, 90000002] }),
    }),
  );
  assert.deepEqual(loadCompanionRoster().members, [90000001, 90000002]);
});

test("an unreadable or absent store is an empty op, never a throw", () => {
  setCompanionRosterStorage(memoryStorage({ [KEY]: "{not json" }));
  assert.deepEqual(loadCompanionRoster(), EMPTY_COMPANION_ROSTER);
  setCompanionRosterStorage(memoryStorage());
  assert.deepEqual(loadCompanionRoster(), EMPTY_COMPANION_ROSTER);
  setCompanionRosterStorage(null);
  assert.deepEqual(loadCompanionRoster(), EMPTY_COMPANION_ROSTER);
});

test("a store that throws on write is not fatal", () => {
  setCompanionRosterStorage({
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  });
  assert.doesNotThrow(() => saveCompanionRoster(EMPTY_COMPANION_ROSTER));
  setCompanionRosterStorage(null);
});
