// The Haul button's remembered choices (app/piHaulPrefs.ts): what survives a
// reload, what a damaged or foreign entry turns into, and how learned division
// names merge.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PI_HAUL_PREFS,
  divisionLabel,
  learnDivisionNames,
  loadPiHaulPrefs,
  pickedDivisionWords,
  savePiHaulPrefs,
  withEntry,
} from "./piHaulPrefs.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

test("choices survive a save and a load", () => {
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  const prefs = {
    divisions: new Map([[90000001, { division: 3, name: "Industry" }]]),
    deliverTo: new Map([[90000001, { entity: "station" as const, id: 60000004, name: "Home Office", systemName: "Alpha" }]]),
    divisionNames: new Map([[98000001, [{ division: 3, name: "Industry" }]]]),
  };
  savePiHaulPrefs(prefs);
  const back = loadPiHaulPrefs();
  assert.deepEqual(back.divisions.get(90000001), { division: 3, name: "Industry" });
  assert.deepEqual(back.deliverTo.get(90000001), { entity: "station", id: 60000004, name: "Home Office", systemName: "Alpha" });
  assert.deepEqual(back.divisionNames.get(98000001), [{ division: 3, name: "Industry" }]);
});

test("damaged storage reads as nothing remembered, never a throw", () => {
  const storage = memoryStorage();
  storage.setItem("evejs.piHaul", "{not json");
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  assert.deepEqual(loadPiHaulPrefs(), EMPTY_PI_HAUL_PREFS);
  storage.setItem("evejs.piHaul", JSON.stringify({ divisions: { "1": { division: 99 } }, deliverTo: { "1": { entity: "belt", id: 5 } } }));
  const prefs = loadPiHaulPrefs();
  assert.equal(prefs.divisions.size, 0);
  assert.equal(prefs.deliverTo.size, 0);
});

test("learned names replace the corporation's old ones; a bad corporation id changes nothing", () => {
  const first = learnDivisionNames(EMPTY_PI_HAUL_PREFS, 98000001, [{ division: 1, name: "Ore" }]);
  const second = learnDivisionNames(first, 98000001, [{ division: 1, name: "Minerals" }, { division: 3, name: "Industry" }]);
  assert.deepEqual(second.divisionNames.get(98000001), [{ division: 1, name: "Minerals" }, { division: 3, name: "Industry" }]);
  assert.equal(learnDivisionNames(second, 0, [{ division: 1, name: "x" }]), second);
});

test("a division reads as its name, else its number", () => {
  assert.equal(divisionLabel(3, "Industry"), "Industry");
  assert.equal(divisionLabel(3, null), "Division 3");
  assert.equal(divisionLabel(3, "  "), "Division 3");
});

test("withEntry sets and removes", () => {
  const set = withEntry(new Map<number, string>(), 1, "a");
  assert.equal(set.get(1), "a");
  assert.equal(withEntry(set, 1, null).has(1), false);
});

test("a pick saved before the names were known reads by the corporation's name once it is learned", () => {
  const picked = { division: 1, name: null };
  const learned = learnDivisionNames(EMPTY_PI_HAUL_PREFS, 98000001, [{ division: 1, name: "Industry" }, { division: 2, name: null }]);
  assert.equal(pickedDivisionWords(learned, 98000001, picked), "Industry");
  // Unknown corporation, or no name for that division: the number, as before.
  assert.equal(pickedDivisionWords(learned, null, picked), "Division 1");
  assert.equal(pickedDivisionWords(learned, 98000001, { division: 2, name: null }), "Division 2");
  // The learned name wins over a stale one saved with the pick.
  assert.equal(pickedDivisionWords(learned, 98000001, { division: 1, name: "Old name" }), "Industry");
  assert.equal(pickedDivisionWords(learned, 98000001, null), null);
});
