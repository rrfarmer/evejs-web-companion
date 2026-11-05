"use strict";

// The companion's own database and the saved-PI-plan store over it: the file
// is created where it is asked for, migrations run once and in order, and a
// plan is intent (commodity, quantity, note, status) guarded by a revision.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { lazyPiDb } = require("../backend/piDb.cjs");
const { createPiPlanStore, MAX_NOTE_LEN } = require("../backend/piPlanStore.cjs");

function memoryStore(overrides = {}) {
  const handle = lazyPiDb({ filename: ":memory:" });
  let n = 0;
  let clock = 0;
  const store = createPiPlanStore({
    db: handle,
    uuid: () => `plan-${++n}`,
    now: () => new Date(Date.UTC(2026, 8, 24, 0, 0, clock++)).toISOString(),
    ...overrides,
  });
  return { store, handle };
}

test("building the store opens nothing", () => {
  let opened = 0;
  createPiPlanStore({ db: { get: () => { opened += 1; return null; } } });
  assert.equal(opened, 0);
});

test("a plan is created active at rev 1, with an empty note by default", () => {
  const { store, handle } = memoryStore();
  const plan = store.create({ typeID: 2867, quantity: 20 });
  assert.deepEqual(
    { ...plan, createdAt: undefined, updatedAt: undefined },
    { planID: "plan-1", typeID: 2867, quantity: 20, note: "", status: "active", rev: 1, createdAt: undefined, updatedAt: undefined },
  );
  assert.deepEqual(store.get("plan-1"), plan);
  handle.close();
});

test("shape and range are checked, and the server's sentence says which", () => {
  const { store, handle } = memoryStore();
  assert.throws(() => store.create(null), { code: "PI_PLAN_INVALID" });
  assert.throws(() => store.create({ typeID: 0, quantity: 1 }), { code: "PI_PLAN_INVALID", message: "Choose something to make." });
  assert.throws(() => store.create({ typeID: 2867, quantity: 1.5 }), { code: "PI_PLAN_INVALID" });
  assert.throws(() => store.create({ typeID: 2867, quantity: "20" }), { code: "PI_PLAN_INVALID" });
  assert.throws(() => store.create({ typeID: 2867, quantity: 1, note: "x".repeat(MAX_NOTE_LEN + 1) }), { code: "PI_PLAN_INVALID" });
  assert.throws(() => store.create({ typeID: 2867, quantity: 1, status: "paused" }), { code: "PI_PLAN_INVALID" });
  assert.deepEqual(store.list(), []);
  handle.close();
});

test("an update changes only what it names and bumps the revision", () => {
  const { store, handle } = memoryStore();
  const plan = store.create({ typeID: 2867, quantity: 20, note: "  for fuel  " });
  assert.equal(plan.note, "for fuel");
  const changed = store.update(plan.planID, { quantity: 40 }, 1);
  assert.equal(changed.quantity, 40);
  assert.equal(changed.typeID, 2867);
  assert.equal(changed.note, "for fuel");
  assert.equal(changed.rev, 2);
  assert.notEqual(changed.updatedAt, plan.updatedAt);
  handle.close();
});

test("an update from a stale revision is refused and changes nothing", () => {
  const { store, handle } = memoryStore();
  const plan = store.create({ typeID: 2867, quantity: 20 });
  store.update(plan.planID, { quantity: 30 }, 1);
  assert.throws(() => store.update(plan.planID, { quantity: 99 }, 1), { code: "PI_PLAN_REV_CONFLICT" });
  assert.equal(store.get(plan.planID).quantity, 30);
  assert.throws(() => store.update("nope", { quantity: 1 }, 1), { code: "PI_PLAN_NOT_FOUND" });
  handle.close();
});

test("the list puts active plans first, then the most recently changed", () => {
  const { store, handle } = memoryStore();
  const a = store.create({ typeID: 1, quantity: 1 });
  const b = store.create({ typeID: 2, quantity: 1 });
  const c = store.create({ typeID: 3, quantity: 1 });
  store.update(a.planID, { status: "done" }, 1);
  store.update(b.planID, { note: "touched" }, 1);
  assert.deepEqual(store.list().map((plan) => plan.planID), [b.planID, c.planID, a.planID]);
  handle.close();
});

test("delete is for good and says whether there was anything", () => {
  const { store, handle } = memoryStore();
  const plan = store.create({ typeID: 2867, quantity: 20 });
  assert.equal(store.remove(plan.planID), true);
  assert.equal(store.remove(plan.planID), false);
  assert.equal(store.get(plan.planID), null);
  handle.close();
});
