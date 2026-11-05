// Saved PI plans, browser side: what the server answers is decoded before it
// becomes a plan, and every call is made on a throwaway sign-in that is always
// signed out again -- never a select.

import test from "node:test";
import assert from "node:assert/strict";

import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import {
  NO_ACCOUNT_WORDS,
  createPiPlan,
  decodePiPlan,
  decodePiPlans,
  loadPiPlans,
  updatePiPlan,
  withPlan,
  withoutPlan,
  type PiPlanDeps,
  type SavedPiPlan,
} from "../lib/piPlans.ts";

const ROW = {
  planID: "plan-1",
  typeID: 2867,
  quantity: 20,
  note: "for fuel",
  status: "active",
  rev: 1,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

function fakeDeps(overrides: Partial<PiPlanDeps> = {}): { deps: PiPlanDeps; log: string[] } {
  const log: string[] = [];
  const deps: PiPlanDeps = {
    async signIn(accountName) {
      log.push(`in:${accountName}`);
      return `token-${accountName}`;
    },
    async signOut(token) {
      log.push(`out:${token}`);
    },
    async list(token) {
      log.push(`list:${token}`);
      return [ROW, { planID: "broken" }] as JsonValue;
    },
    async create(fields, token) {
      log.push(`create:${token}`);
      return { ...ROW, ...fields } as JsonValue;
    },
    async update(planID, fields, baseRev, token) {
      log.push(`update:${planID}@${baseRev}:${token}`);
      return { ...ROW, ...fields, rev: baseRev + 1 } as JsonValue;
    },
    async remove(planID, token) {
      log.push(`remove:${planID}:${token}`);
    },
    ...overrides,
  };
  return { deps, log };
}

test("a row decodes to a plan; anything else is null", () => {
  assert.deepEqual(decodePiPlan(ROW), ROW);
  assert.equal(decodePiPlan({ ...ROW, quantity: 0 }), null);
  assert.equal(decodePiPlan({ ...ROW, status: "paused" }), null);
  assert.equal(decodePiPlan({ ...ROW, planID: "" }), null);
  assert.equal(decodePiPlan([ROW] as JsonValue), null);
  assert.equal(decodePiPlan({ ...ROW, note: 7 })?.note, "");
  assert.deepEqual(decodePiPlans(null), []);
});

test("the list keeps only the rows that decode, and signs out after", async () => {
  const { deps, log } = fakeDeps();
  const plans = await loadPiPlans(["pilotacct"], deps);
  assert.deepEqual(plans.map((plan) => plan.planID), ["plan-1"]);
  assert.deepEqual(log, ["in:pilotacct", "list:token-pilotacct", "out:token-pilotacct"]);
});

test("an account that will not sign in is skipped for the next", async () => {
  const { deps, log } = fakeDeps({
    async signIn(accountName) {
      if (accountName === "gone") throw new Error("no such account");
      log.push(`in:${accountName}`);
      return `token-${accountName}`;
    },
  });
  await loadPiPlans(["gone", "gone", "second"], deps);
  assert.deepEqual(log[0], "in:second");
});

test("with no account that signs in, the window is told in words", async () => {
  const { deps } = fakeDeps({
    async signIn() {
      throw new Error("refused");
    },
  });
  await assert.rejects(loadPiPlans(["a"], deps), { message: NO_ACCOUNT_WORDS });
  await assert.rejects(loadPiPlans([], deps), { message: NO_ACCOUNT_WORDS });
});

test("a refusal from the server is passed on, and the token is still signed out", async () => {
  const { deps, log } = fakeDeps({
    async update() {
      throw new Error("This plan was changed somewhere else. Reopen it and try again.");
    },
  });
  await assert.rejects(
    updatePiPlan(["a"], ROW as SavedPiPlan, { quantity: 3 }, deps),
    { message: /changed somewhere else/ },
  );
  assert.equal(log.at(-1), "out:token-a");
});

test("an update is sent against the plan's own revision", async () => {
  const { deps, log } = fakeDeps();
  const next = await updatePiPlan(["a"], { ...(ROW as SavedPiPlan), rev: 4 }, { quantity: 9 }, deps);
  assert.ok(log.includes("update:plan-1@4:token-a"));
  assert.equal(next.rev, 5);
  assert.equal(next.quantity, 9);
});

test("an answer that is not a plan is an error, not a silent null", async () => {
  const { deps } = fakeDeps({ create: async () => ({ ok: true }) as JsonValue });
  await assert.rejects(createPiPlan(["a"], { typeID: 1, quantity: 1 }, deps));
});

test("withPlan replaces in place or puts a new plan first; withoutPlan drops it", () => {
  const a = ROW as SavedPiPlan;
  const b = { ...a, planID: "plan-2" };
  assert.deepEqual(withPlan([a], b).map((plan) => plan.planID), ["plan-2", "plan-1"]);
  assert.equal(withPlan([a, b], { ...a, quantity: 5 })[0]?.quantity, 5);
  assert.deepEqual(withoutPlan([a, b], "plan-1"), [b]);
});
