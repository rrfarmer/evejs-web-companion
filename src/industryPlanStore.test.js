"use strict";

// The saved Industry Manager plan store (R109 slice 3): intent only, guarded by
// a revision, with the player's choices stored canonical and bounded.

const test = require("node:test");
const assert = require("node:assert/strict");

const { lazyCompanionDb, MIGRATIONS } = require("./companionDb");
const { createIndustryPlanStore, guardChoices, MAX_RUNS } = require("./industryPlanStore");

function memoryStore() {
  const handle = lazyCompanionDb({ filename: ":memory:" });
  let n = 0;
  let clock = 0;
  const store = createIndustryPlanStore({
    db: handle,
    uuid: () => `plan-${++n}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(),
  });
  return { store, handle };
}

test("the industry_plans table arrives by migration, after pi_plans", () => {
  const { handle } = memoryStore();
  const db = handle.get();
  assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes("pi_plans"));
  assert.ok(tables.includes("industry_plans"));
});

test("a new plan is intent: product, runs, choices, note, active, revision 1", () => {
  const { store } = memoryStore();
  const plan = store.create({ productTypeID: 2456, runs: 10, note: "  for the fleet  " });
  assert.deepEqual(plan, {
    planID: "plan-1",
    productTypeID: 2456,
    runs: 10,
    choices: { buy: [], jobs: {}, blueprints: {}, decryptors: {} },
    note: "for the fleet",
    status: "active",
    rev: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.deepEqual(store.list().map((entry) => entry.planID), ["plan-1"]);
});

test("a plan needs a product and a whole number of runs within bounds", () => {
  const { store } = memoryStore();
  assert.throws(() => store.create({ runs: 1 }), { code: "INDUSTRY_PLAN_INVALID" });
  assert.throws(() => store.create({ productTypeID: 1, runs: 0 }), { code: "INDUSTRY_PLAN_INVALID" });
  assert.throws(() => store.create({ productTypeID: 1, runs: 1.5 }), { code: "INDUSTRY_PLAN_INVALID" });
  assert.throws(() => store.create({ productTypeID: 1, runs: MAX_RUNS + 1 }), { code: "INDUSTRY_PLAN_INVALID" });
  assert.throws(() => store.create({ productTypeID: 1, runs: 1, status: "paused" }), { code: "INDUSTRY_PLAN_INVALID" });
});

test("choices are stored canonical: sorted, deduplicated, one-job splits dropped", () => {
  assert.deepEqual(
    guardChoices({
      buy: [30, 10, 30],
      jobs: { 20: 3, 5: 1 },
      blueprints: { 1900: { materialEfficiency: 2, timeEfficiency: 4 } },
    }),
    {
      buy: [10, 30],
      jobs: { 20: 3 },
      blueprints: { 1900: { materialEfficiency: 2, timeEfficiency: 4 } },
      decryptors: {},
    },
  );
  // Key order in the stored text follows the numbers, so two equal plans
  // write the same text.
  assert.equal(
    JSON.stringify(guardChoices({ jobs: { 100: 2, 9: 2 } })),
    JSON.stringify(guardChoices({ jobs: { 9: 2, 100: 2 } })),
  );
});

test("choices out of range or out of shape are refused, not trimmed", () => {
  const bad = [
    { buy: "101" },
    { buy: [0] },
    { buy: Array.from({ length: 1001 }, (_, index) => index + 1) },
    { jobs: { 101: 0 } },
    { jobs: { abc: 2 } },
    { jobs: { 101: 1001 } },
    { blueprints: { 1900: { materialEfficiency: 11, timeEfficiency: 0 } } },
    { blueprints: { 1900: { materialEfficiency: 0, timeEfficiency: 21 } } },
    { blueprints: { 1900: { materialEfficiency: 2 } } },
    { decryptors: { 1900: 0 } },
    { decryptors: { x: 34201 } },
    [],
  ];
  for (const choices of bad) {
    assert.throws(() => guardChoices(choices), { code: "INDUSTRY_PLAN_INVALID" }, JSON.stringify(choices));
  }
});

test("an update needs the revision it was based on, and bumps it", () => {
  const { store } = memoryStore();
  const plan = store.create({ productTypeID: 2456, runs: 10 });
  const changed = store.update(plan.planID, { runs: 20, choices: { buy: [11399] } }, 1);
  assert.equal(changed.runs, 20);
  assert.deepEqual(changed.choices.buy, [11399]);
  assert.equal(changed.rev, 2);
  assert.throws(() => store.update(plan.planID, { runs: 30 }, 1), { code: "INDUSTRY_PLAN_REV_CONFLICT" });
  assert.equal(store.get(plan.planID).runs, 20, "the refused write changed nothing");
  assert.throws(() => store.update("missing", { runs: 1 }, 1), { code: "INDUSTRY_PLAN_NOT_FOUND" });
});

test("an update that leaves the choices out keeps them", () => {
  const { store } = memoryStore();
  const plan = store.create({ productTypeID: 2456, runs: 10, choices: { buy: [11399] } });
  const changed = store.update(plan.planID, { note: "later" }, plan.rev);
  assert.deepEqual(changed.choices.buy, [11399]);
});

test("active plans list first, then the most recently changed", () => {
  const { store } = memoryStore();
  const first = store.create({ productTypeID: 1, runs: 1 });
  store.create({ productTypeID: 2, runs: 1 });
  store.update(first.planID, { status: "done" }, first.rev);
  store.create({ productTypeID: 3, runs: 1 });
  assert.deepEqual(store.list().map((plan) => plan.productTypeID), [3, 2, 1]);
});

test("a damaged choices cell reads as no choices rather than breaking the list", () => {
  const { store, handle } = memoryStore();
  const plan = store.create({ productTypeID: 1, runs: 1, choices: { buy: [5] } });
  handle.get().prepare("UPDATE industry_plans SET choices = 'not json' WHERE id = ?").run(plan.planID);
  assert.deepEqual(store.get(plan.planID).choices, { buy: [], jobs: {}, blueprints: {}, decryptors: {} });
});

test("delete is for good", () => {
  const { store } = memoryStore();
  const plan = store.create({ productTypeID: 1, runs: 1 });
  assert.equal(store.remove(plan.planID), true);
  assert.equal(store.remove(plan.planID), false);
  assert.equal(store.get(plan.planID), null);
});

test("a decryptor choice is kept per blueprint, canonical", () => {
  assert.deepEqual(guardChoices({ decryptors: { 2457: 34201, 1900: 34202 } }).decryptors, { 1900: 34202, 2457: 34201 });
});

test("where to build is kept per activity, and left out when none is chosen", () => {
  assert.deepEqual(guardChoices({ facilities: { reaction: 61000001, manufacturing: 60003760 } }).facilities,
    { manufacturing: 60003760, reaction: 61000001 });
  assert.equal("facilities" in guardChoices({}), false);
  assert.equal("facilities" in guardChoices({ facilities: {} }), false);
  for (const facilities of [{ invention: 60003760 }, { manufacturing: 0 }, { manufacturing: "here" }, [60003760]]) {
    assert.throws(() => guardChoices({ facilities }), /facility|readable/);
  }
});
