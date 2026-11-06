// The hangar's saved arrangement (app/hangarPrefs.ts).
//
// This is the only state in the app that has no server behind it at all, so the
// things worth pinning are the ones a bad edit would corrupt quietly: deleting a
// squad must not leave its membership and its chip pin behind, removing a pilot
// must not leave squads counting it, and a storage that throws or holds junk must
// degrade to an empty arrangement rather than taking the screen down.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PREFS,
  SQUAD_PALETTE,
  addSquad,
  addSquadMembers,
  deleteSquad,
  forgetPilots,
  loadHangarPrefs,
  nextSquadColor,
  saveHangarPrefs,
  setHangarPrefsStorage,
  squadMemberCount,
  squadsForPilot,
  toggleCollapsedAccount,
  togglePinnedPilot,
  togglePinnedSquad,
  toggleSquadMember,
  updateSquad,
  onHangarPrefsSaved,
  type HangarPrefsStorage,
} from "./hangarPrefs.ts";

function memoryStorage(seed: Record<string, string> = {}): HangarPrefsStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const MINING = { id: "s1", name: "Mining Op", color: "#52d9a3" };
const SCOUTS = { id: "s2", name: "Scout Net", color: "#e0b155" };

test("a squad round-trips through storage with its members, pins and collapses", () => {
  const storage = memoryStorage();
  setHangarPrefsStorage(storage);
  try {
    let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2]);
    prefs = togglePinnedSquad(prefs, MINING.id);
    prefs = togglePinnedPilot(prefs, 2);
    prefs = toggleCollapsedAccount(prefs, "Account One");
    saveHangarPrefs(prefs);

    const back = loadHangarPrefs();
    assert.deepEqual(back.squads, [MINING]);
    assert.deepEqual(back.members[MINING.id], [1, 2]);
    assert.deepEqual(back.pinnedSquads, [MINING.id]);
    assert.deepEqual(back.pinnedPilots, [2]);
    assert.deepEqual(back.collapsedAccounts, ["Account One"]);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("junk in storage reads back as an empty arrangement, never a throw", () => {
  setHangarPrefsStorage(memoryStorage({ "evejs-web-hangar-prefs:v1": "{not json" }));
  try {
    assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("a half-written arrangement keeps the parts that are valid", () => {
  setHangarPrefsStorage(
    memoryStorage({
      "evejs-web-hangar-prefs:v1": JSON.stringify({
        squads: [MINING, { id: 7 }, null],
        members: { s1: [1, "two", 3] },
        pinnedSquads: ["s1", 9],
        pinnedPilots: [1, "x"],
      }),
    }),
  );
  try {
    const prefs = loadHangarPrefs();
    assert.deepEqual(prefs.squads, [MINING]);
    assert.deepEqual(prefs.members.s1, [1, 3]);
    assert.deepEqual(prefs.pinnedSquads, ["s1"]);
    assert.deepEqual(prefs.pinnedPilots, [1]);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("with no storage at all the arrangement is empty and saving is a no-op", () => {
  setHangarPrefsStorage(null);
  assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
  saveHangarPrefs(addSquad(EMPTY_PREFS, MINING));
  assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
});

test("deleting a squad takes its membership and its chip pin with it", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2]);
  prefs = addSquad(prefs, SCOUTS, [2]);
  prefs = togglePinnedSquad(prefs, MINING.id);
  prefs = deleteSquad(prefs, MINING.id);
  assert.deepEqual(prefs.squads, [SCOUTS]);
  assert.equal(prefs.members[MINING.id], undefined);
  assert.deepEqual(prefs.pinnedSquads, []);
  assert.deepEqual(prefs.members[SCOUTS.id], [2], "the other squad is untouched");
});

test("forgetting pilots clears them out of every squad and off the pin list", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3]);
  prefs = addSquad(prefs, SCOUTS, [2, 3]);
  prefs = togglePinnedPilot(prefs, 2);
  prefs = forgetPilots(prefs, [2, 3]);
  assert.deepEqual(prefs.members[MINING.id], [1]);
  assert.deepEqual(prefs.members[SCOUTS.id], []);
  assert.deepEqual(prefs.pinnedPilots, []);
});

test("membership toggles both ways and a pilot can be in several squads", () => {
  let prefs = addSquad(addSquad(EMPTY_PREFS, MINING), SCOUTS);
  prefs = toggleSquadMember(prefs, MINING.id, 1);
  prefs = toggleSquadMember(prefs, SCOUTS.id, 1);
  assert.deepEqual(
    squadsForPilot(prefs, 1).map((s) => s.name),
    ["Mining Op", "Scout Net"],
  );
  prefs = toggleSquadMember(prefs, MINING.id, 1);
  assert.deepEqual(
    squadsForPilot(prefs, 1).map((s) => s.name),
    ["Scout Net"],
  );
});

test("a squad counts only members that are still in the roster", () => {
  const prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3]);
  assert.equal(squadMemberCount(prefs, MINING.id, new Set([1, 3])), 2);
  assert.equal(squadMemberCount(prefs, "nope", new Set([1])), 0);
});

test("renaming and recolouring leaves everything else alone", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1]);
  prefs = updateSquad(prefs, MINING.id, { name: "Ore Run", color: "#b48ae0" });
  assert.deepEqual(prefs.squads, [{ id: "s1", name: "Ore Run", color: "#b48ae0" }]);
  assert.deepEqual(prefs.members[MINING.id], [1]);
  assert.deepEqual(updateSquad(prefs, "gone", { name: "x" }).squads, prefs.squads);
});

test("new squads cycle the palette so two made in a row do not look alike", () => {
  let prefs = EMPTY_PREFS;
  const picked: string[] = [];
  for (let i = 0; i < SQUAD_PALETTE.length + 1; i += 1) {
    const color = nextSquadColor(prefs);
    picked.push(color);
    prefs = addSquad(prefs, { id: `s${i}`, name: `Squad ${i}`, color });
  }
  assert.deepEqual(picked.slice(0, SQUAD_PALETTE.length), [...SQUAD_PALETTE]);
  assert.equal(picked[SQUAD_PALETTE.length], SQUAD_PALETTE[0]);
});

test("adding a selection to a squad is a union, never a replacement", () => {
  // "Save as squad → Mining Op" with two pilots selected must not throw away
  // the four already in it, and must not list a pilot twice when one of the two
  // was already a member.
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3, 4]);
  prefs = addSquadMembers(prefs, MINING.id, [3, 5]);
  assert.deepEqual(prefs.members[MINING.id], [1, 2, 3, 4, 5]);
});

test("adding pilots to a squad that is not there changes nothing", () => {
  // A squad deleted in another tab must not come back as a members entry with
  // no squad on the chip row to match it.
  const prefs = addSquad(EMPTY_PREFS, MINING, [1]);
  const after = addSquadMembers(prefs, SCOUTS.id, [2]);
  assert.equal(after, prefs, "the same value back, so nothing is written");
  assert.equal(after.members[SCOUTS.id], undefined);
});


// --- what the arrangement keeps for plugins ---------------------------------

const PILOT_A = 90000001;
const PILOT_B = 90000002;

test("a field this build does not know survives a save, so a plugin switched off keeps its settings", () => {
  // ⚠ A plugin may keep per-squad-member settings in the same blob; if core
  // rewrote the record with only the fields it knows, switching the plugin off
  // for a session would erase what it stored.
  const store = memoryStorage();
  setHangarPrefsStorage(store);
  store.setItem(
    "evejs-web-hangar-prefs:v1",
    JSON.stringify({
      squads: [MINING],
      members: { [MINING.id]: [PILOT_A] },
      pinnedSquads: [],
      pinnedPilots: [],
      collapsedAccounts: [],
      somePluginField: { [MINING.id]: { [String(PILOT_A)]: { keep: true } } },
    }),
  );
  const prefs = toggleSquadMember(loadHangarPrefs(), MINING.id, PILOT_B);
  saveHangarPrefs(prefs);
  const raw = JSON.parse(store.getItem("evejs-web-hangar-prefs:v1")!);
  assert.deepEqual(raw.somePluginField, { [MINING.id]: { [String(PILOT_A)]: { keep: true } } });
  assert.deepEqual(raw.members[MINING.id], [PILOT_A, PILOT_B], "core's own fields are still written");
  setHangarPrefsStorage(null);
});

test("a listener hears each save, and stops hearing once it unsubscribes", () => {
  // ⚠ This is how a plugin learns that a pilot left a squad or a squad was
  // deleted, so it can drop what it kept for them.
  setHangarPrefsStorage(memoryStorage());
  const heard: number[] = [];
  const stop = onHangarPrefsSaved((prefs) => heard.push(prefs.squads.length));
  saveHangarPrefs(addSquad(EMPTY_PREFS, MINING));
  saveHangarPrefs(deleteSquad(addSquad(EMPTY_PREFS, MINING), MINING.id));
  stop();
  saveHangarPrefs(addSquad(EMPTY_PREFS, MINING));
  assert.deepEqual(heard, [1, 0]);
  setHangarPrefsStorage(null);
});

test("a listener that throws does not stop the save or the other listeners", () => {
  const store = memoryStorage();
  setHangarPrefsStorage(store);
  const heard: number[] = [];
  const originalError = console.error;
  console.error = () => {};
  const stopBad = onHangarPrefsSaved(() => {
    throw new Error("boom");
  });
  const stopGood = onHangarPrefsSaved((prefs) => heard.push(prefs.squads.length));
  try {
    saveHangarPrefs(addSquad(EMPTY_PREFS, MINING));
  } finally {
    console.error = originalError;
    stopBad();
    stopGood();
  }
  assert.deepEqual(heard, [1]);
  assert.equal(loadHangarPrefs().squads.length, 1);
  setHangarPrefsStorage(null);
});

test("an arrangement saved by an older build, lacking newer keys, still loads", () => {
  // ⚠ EVERY EXISTING INSTALL IS THIS CASE: an older blob must come back with
  // its squads and pins intact.
  const store = memoryStorage();
  setHangarPrefsStorage(store);
  store.setItem(
    "evejs-web-hangar-prefs:v1",
    JSON.stringify({ squads: [MINING], members: { [MINING.id]: [PILOT_A] }, pinnedSquads: [MINING.id] }),
  );
  const back = loadHangarPrefs();
  assert.deepEqual(back.squads, [MINING]);
  assert.deepEqual(back.members[MINING.id], [PILOT_A]);
  assert.deepEqual(back.pinnedSquads, [MINING.id]);
  setHangarPrefsStorage(null);
});
