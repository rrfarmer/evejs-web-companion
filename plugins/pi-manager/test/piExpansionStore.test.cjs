"use strict";

// The saved PI expansion plan store: intent only (where to look, which
// colonies were accepted), guarded by a revision.

const test = require("node:test");
const assert = require("node:assert/strict");

const { lazyPiDb, MIGRATIONS } = require("../backend/piDb.cjs");
const { createPiExpansionStore, MAX_ROWS } = require("../backend/piExpansionStore.cjs");

function memoryStore() {
  const handle = lazyPiDb({ filename: ":memory:" });
  let n = 0;
  let clock = 0;
  const store = createPiExpansionStore({
    db: handle,
    uuid: () => `plan-${++n}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(),
  });
  return { store, handle };
}

const SETTINGS = { homeSystemID: 30000001, maxJumps: 3, nullsecTolerance: 0.5, characterIDs: [90000002, 90000001] };
const ROWS = [
  { characterID: 90000001, planetID: 40000002, resourceTypeID: 2268, productTypeID: 2389 },
  { characterID: 90000002, planetID: 40000002, resourceTypeID: 2268, productTypeID: 2389 },
];

test("the plugin's database holds its tables, plans first", () => {
  const { handle } = memoryStore();
  const db = handle.get();
  assert.equal(MIGRATIONS.length, 3);
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all().map((row) => row.name);
  assert.deepEqual(tables, ["pi_plans", "pi_expansion_plans", "pi_handover"]);
});

test("a new plan round-trips: settings canonical, rows in order, active, revision 1", () => {
  const { store } = memoryStore();
  const plan = store.create({ settings: SETTINGS, rows: ROWS, note: "  second ring  " });
  assert.deepEqual(plan, {
    planID: "plan-1",
    settings: { homeSystemID: 30000001, maxJumps: 3, nullsecTolerance: 0.5, characterIDs: [90000001, 90000002] },
    rows: ROWS,
    note: "second ring",
    status: "active",
    rev: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.deepEqual(store.get("plan-1"), plan);
  assert.deepEqual(store.list().map((entry) => entry.planID), ["plan-1"]);
  assert.equal(store.get("missing"), null);
});

test("no pilots and no colonies is a valid plan", () => {
  const { store } = memoryStore();
  const plan = store.create({ settings: { ...SETTINGS, characterIDs: [] }, rows: [] });
  assert.deepEqual(plan.settings.characterIDs, []);
  assert.deepEqual(plan.rows, []);
});

test("settings and rows are required, and checked for shape and range", () => {
  const { store } = memoryStore();
  const bad = [
    {},
    { settings: SETTINGS },
    { rows: ROWS },
    { settings: { ...SETTINGS, homeSystemID: 0 }, rows: [] },
    { settings: { ...SETTINGS, maxJumps: 6 }, rows: [] },
    { settings: { ...SETTINGS, maxJumps: -1 }, rows: [] },
    { settings: { ...SETTINGS, maxJumps: 1.5 }, rows: [] },
    { settings: { ...SETTINGS, nullsecTolerance: 1.1 }, rows: [] },
    { settings: { ...SETTINGS, nullsecTolerance: "0.5" }, rows: [] },
    { settings: { ...SETTINGS, characterIDs: [90000001, 90000001] }, rows: [] },
    { settings: { ...SETTINGS, characterIDs: [0] }, rows: [] },
    { settings: { ...SETTINGS, characterIDs: "90000001" }, rows: [] },
    { settings: SETTINGS, rows: [{ ...ROWS[0], planetID: 0 }] },
    { settings: SETTINGS, rows: [{ characterID: 90000001, planetID: 40000002, resourceTypeID: 2268 }] },
    { settings: SETTINGS, rows: [ROWS[0], { ...ROWS[0], productTypeID: 9999 }] },
    { settings: SETTINGS, rows: Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ ...ROWS[0], planetID: i + 1 })) },
    { settings: SETTINGS, rows: ROWS, status: "paused" },
    { settings: SETTINGS, rows: ROWS, note: 5 },
    { settings: SETTINGS, rows: ROWS, note: "x".repeat(501) },
  ];
  for (const input of bad) {
    assert.throws(() => store.create(input), { code: "PI_EXPANSION_INVALID" }, JSON.stringify(input).slice(0, 120));
  }
  assert.throws(() => store.create(null), { code: "PI_EXPANSION_INVALID" });
  assert.deepEqual(store.list(), []);
});

test("the same planet is fine for different pilots, and MAX_ROWS rows are allowed", () => {
  const { store } = memoryStore();
  const rows = Array.from({ length: MAX_ROWS }, (_, i) => ({ ...ROWS[0], planetID: i + 1 }));
  assert.equal(store.create({ settings: SETTINGS, rows }).rows.length, MAX_ROWS);
  assert.equal(store.create({ settings: SETTINGS, rows: ROWS }).rows.length, 2);
});

test("an update needs the revision it was based on, and bumps it", () => {
  const { store } = memoryStore();
  const plan = store.create({ settings: SETTINGS, rows: ROWS });
  const changed = store.update(plan.planID, { rows: [ROWS[0]], status: "done" }, 1);
  assert.deepEqual(changed.rows, [ROWS[0]]);
  assert.equal(changed.status, "done");
  assert.equal(changed.rev, 2);
  assert.throws(() => store.update(plan.planID, { note: "late" }, 1), { code: "PI_EXPANSION_REV_CONFLICT" });
  assert.equal(store.get(plan.planID).note, "", "the refused write changed nothing");
  assert.throws(() => store.update("missing", { note: "x" }, 1), { code: "PI_EXPANSION_NOT_FOUND" });
  assert.throws(() => store.update(plan.planID, { status: "paused" }, 2), { code: "PI_EXPANSION_INVALID" });
  assert.throws(() => store.update(plan.planID, { settings: { ...SETTINGS, maxJumps: 6 } }, 2), { code: "PI_EXPANSION_INVALID" });
});

test("an update that leaves settings and rows out keeps them", () => {
  const { store } = memoryStore();
  const plan = store.create({ settings: SETTINGS, rows: ROWS });
  const changed = store.update(plan.planID, { note: "later" }, plan.rev);
  assert.deepEqual(changed.rows, ROWS);
  assert.equal(changed.settings.homeSystemID, 30000001);
  assert.equal(changed.note, "later");
});

test("active plans list first, then the most recently changed", () => {
  const { store } = memoryStore();
  const first = store.create({ settings: { ...SETTINGS, homeSystemID: 30000001 }, rows: [] });
  store.create({ settings: { ...SETTINGS, homeSystemID: 30000002 }, rows: [] });
  store.update(first.planID, { status: "done" }, first.rev);
  store.create({ settings: { ...SETTINGS, homeSystemID: 30000003 }, rows: [] });
  assert.deepEqual(store.list().map((plan) => plan.settings.homeSystemID), [30000003, 30000002, 30000001]);
});

test("delete is for good", () => {
  const { store } = memoryStore();
  const plan = store.create({ settings: SETTINGS, rows: ROWS });
  assert.equal(store.remove(plan.planID), true);
  assert.equal(store.remove(plan.planID), false);
  assert.equal(store.get(plan.planID), null);
});
