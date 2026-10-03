// R109 slice 3: saved Industry Manager plans on the client side, and the
// browser-local view of them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  askAsAnyone,
  decodeChoices,
  decodeIndustryPlan,
  decodeIndustryPlans,
  NO_ASKER_WORDS,
  NO_CHOICES,
  resolverChoices,
  withAssumedTerms,
  withDecryptor,
  withFacility,
  withBuying,
  withIndustryPlan,
  withJobs,
  withoutIndustryPlan,
  type IndustryPlanDeps,
  type SavedIndustryPlan,
} from "./industryPlans.ts";
import {
  EMPTY_INDUSTRY_PLAN_VIEW,
  loadIndustryPlanView,
  pruneIndustryPlanView,
  saveIndustryPlanView,
  setIndustryPlanViewStorage,
  withFolds,
  withOpenIndustryPlan,
} from "./industryPlanView.ts";
import type { JsonValue } from "../bridge/wire.ts";

const ROW = {
  planID: "plan-1",
  productTypeID: 2456,
  runs: 10,
  choices: { buy: [11399], jobs: { 11688: 2 }, blueprints: { 2457: { materialEfficiency: 4, timeEfficiency: 8 } } },
  note: "drones",
  status: "active",
  rev: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:01.000Z",
};

function plan(overrides: Partial<SavedIndustryPlan> = {}): SavedIndustryPlan {
  const decoded = decodeIndustryPlan(ROW as unknown as JsonValue);
  assert.ok(decoded);
  return { ...decoded, ...overrides };
}

// --- decoding -----------------------------------------------------------------

test("a server row decodes into a plan with its choices", () => {
  const decoded = plan();
  assert.equal(decoded.productTypeID, 2456);
  assert.equal(decoded.runs, 10);
  assert.deepEqual(decoded.choices, { ...ROW.choices, decryptors: {} });
});

test("a row out of shape is dropped from a list, not guessed at", () => {
  const plans = decodeIndustryPlans([
    ROW,
    { ...ROW, planID: "" },
    { ...ROW, planID: "x", runs: 0 },
    { ...ROW, planID: "y", status: "paused" },
  ] as unknown as JsonValue);
  assert.deepEqual(plans.map((entry) => entry.planID), ["plan-1"]);
});

test("choices out of range are left out one by one, the rest kept", () => {
  assert.deepEqual(
    decodeChoices({
      buy: [5, 5, -1, "7", 3],
      jobs: { 10: 2, 11: 1, x: 3 },
      blueprints: { 20: { materialEfficiency: 2, timeEfficiency: 4 }, 21: { materialEfficiency: 99, timeEfficiency: 0 } },
    }),
    { buy: [3, 5], jobs: { 10: 2 }, blueprints: { 20: { materialEfficiency: 2, timeEfficiency: 4 } }, decryptors: {} },
  );
  assert.deepEqual(decodeChoices(null), NO_CHOICES);
});

// --- choices to the resolver -----------------------------------------------

test("stored choices become the resolver's; an owned blueprint beats a stored assumption", () => {
  const owned = new Map([[2457, { materialEfficiency: 10, timeEfficiency: 20, owned: true }]]);
  const choices = resolverChoices(plan().choices, owned);
  assert.equal(choices.obtain?.get(11399), "buy");
  assert.equal(choices.jobs?.get(11688), 2);
  assert.deepEqual(choices.blueprints?.get(2457), { materialEfficiency: 10, timeEfficiency: 20, owned: true });
  const unowned = resolverChoices(plan().choices, new Map());
  assert.deepEqual(unowned.blueprints?.get(2457), { materialEfficiency: 4, timeEfficiency: 8, owned: false });
});

test("withBuying, withJobs and withAssumedTerms change one thing and keep the rest", () => {
  const start = plan().choices;
  assert.deepEqual(withBuying(start, 34, true).buy, [34, 11399]);
  assert.deepEqual(withBuying(start, 11399, false).buy, []);
  assert.deepEqual(withJobs(start, 11688, 1).jobs, {});
  assert.deepEqual(withJobs(start, 34, 3).jobs, { 11688: 2, 34: 3 });
  assert.deepEqual(withAssumedTerms(start, 2457, 50, -3).blueprints[2457], { materialEfficiency: 10, timeEfficiency: 0 });
  assert.deepEqual(start.buy, [11399], "the original is untouched");
});

test("withIndustryPlan replaces in place or puts a new plan first; withoutIndustryPlan drops it", () => {
  const first = plan();
  const second = plan({ planID: "plan-2" });
  assert.deepEqual(withIndustryPlan([first], second).map((entry) => entry.planID), ["plan-2", "plan-1"]);
  assert.equal(withIndustryPlan([first, second], { ...first, runs: 99 })[0]?.runs, 99);
  assert.deepEqual(withoutIndustryPlan([first, second], "plan-1").map((entry) => entry.planID), ["plan-2"]);
});

// --- who asks -----------------------------------------------------------------

function recordingDeps(refuse: readonly string[] = []): IndustryPlanDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async signIn(accountName) {
      log.push(`in:${accountName}`);
      if (refuse.includes(accountName)) throw new Error("refused");
      return `token-${accountName}`;
    },
    async signOut(token) {
      log.push(`out:${token}`);
    },
  };
}

test("an online pilot is asked on its own session, and nobody is signed in", async () => {
  const deps = recordingDeps();
  const used = await askAsAnyone(
    { online: [{ token: "online-token" }], accounts: ["alpha"] },
    async (options) => options.token,
    deps,
  );
  assert.equal(used, "online-token");
  assert.deepEqual(deps.log, []);
});

test("with nobody online, the first hangar account that signs in asks, and is signed out after", async () => {
  const deps = recordingDeps(["alpha"]);
  const used = await askAsAnyone({ online: [], accounts: ["alpha", "beta", "beta"] }, async (options) => options.token, deps);
  assert.equal(used, "token-beta");
  assert.deepEqual(deps.log, ["in:alpha", "in:beta", "out:token-beta"]);
});

test("a refusal from the call itself is thrown as it came, after signing out", async () => {
  const deps = recordingDeps();
  await assert.rejects(
    askAsAnyone({ online: [], accounts: ["alpha"] }, async () => {
      throw new Error("This plan was changed somewhere else.");
    }, deps),
    /changed somewhere else/,
  );
  assert.deepEqual(deps.log, ["in:alpha", "out:token-alpha"]);
});

test("with nobody to ask, the words say what is needed", async () => {
  await assert.rejects(askAsAnyone({ online: [], accounts: [] }, async () => 1, recordingDeps()), { message: NO_ASKER_WORDS });
});

// --- the view -------------------------------------------------------------------

function memoryStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

test("the view keeps the open plan and hand folds, and survives a round trip", () => {
  const storage = memoryStorage();
  setIndustryPlanViewStorage(storage);
  try {
    let view = withOpenIndustryPlan(EMPTY_INDUSTRY_PLAN_VIEW, "plan-1");
    view = withFolds(view, "plan-1", { "2456>11688": false, "2456>11688>16670": true });
    saveIndustryPlanView(view);
    assert.deepEqual(loadIndustryPlanView(), view);
  } finally {
    setIndustryPlanViewStorage(null);
  }
});

test("a broken stored view reads as empty, never as an error", () => {
  const storage = memoryStorage();
  storage.data.set("evejs-web-industry-plan-view:v1", "{not json");
  setIndustryPlanViewStorage(storage);
  try {
    assert.deepEqual(loadIndustryPlanView(), EMPTY_INDUSTRY_PLAN_VIEW);
  } finally {
    setIndustryPlanViewStorage(null);
  }
});

test("pruning drops folds and the open plan of plans the server no longer has", () => {
  let view = withOpenIndustryPlan(EMPTY_INDUSTRY_PLAN_VIEW, "gone");
  view = withFolds(view, "gone", { a: true });
  view = withFolds(view, "kept", { b: false });
  assert.deepEqual(pruneIndustryPlanView(view, ["kept"]), { openID: null, folds: { kept: { b: false } } });
  assert.deepEqual(withFolds(view, "kept", {}).folds, { gone: { a: true } }, "an empty fold map forgets the plan");
});

test("a chosen decryptor fixes the invented copy: ME 2 + its ME, TE 4 + its TE, and its extra runs", () => {
  const decryptors = new Map([[34201, {
    typeID: 34201, name: "Parity Decryptor", probabilityMultiplier: 1.5, materialEfficiency: 1, timeEfficiency: -2, maxRuns: 3,
  }]]);
  const choices = withDecryptor(plan().choices, 2457, 34201);
  const resolved = resolverChoices(choices, new Map(), decryptors);
  assert.deepEqual(resolved.blueprints?.get(2457), { materialEfficiency: 3, timeEfficiency: 2, owned: false });
  assert.equal(resolved.inventionRunsBonus?.get(2457), 3);
  // Owning the blueprint still wins over any invented assumption.
  const owned = resolverChoices(choices, new Map([[2457, { materialEfficiency: 10, timeEfficiency: 20, owned: true }]]), decryptors);
  assert.deepEqual(owned.blueprints?.get(2457), { materialEfficiency: 10, timeEfficiency: 20, owned: true });
  assert.deepEqual(withDecryptor(choices, 2457, null).decryptors, {});
});

test("where to build is kept per activity, cleared to nothing, and decoded only when sound", () => {
  const built = withFacility(withFacility(NO_CHOICES, "manufacturing", 60003760), "reaction", 1035000000001);
  assert.deepEqual(built.facilities, { manufacturing: 60003760, reaction: 1035000000001 });
  const cleared = withFacility(withFacility(built, "manufacturing", null), "reaction", null);
  // No facilities left: the field goes, so the plan reads as an older one.
  assert.equal("facilities" in cleared, false);
  assert.deepEqual(decodeChoices({ buy: [], facilities: { manufacturing: 60003760, invention: 1, reaction: "x" } }).facilities, { manufacturing: 60003760 });
  assert.equal("facilities" in decodeChoices({ buy: [], facilities: { manufacturing: 0 } }), false);
});
