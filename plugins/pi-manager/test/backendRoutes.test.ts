// The PI Manager's backend routes over a database in memory: the same shapes
// the BFF answered at /api/pi/plans and /api/pi/expansions, and the one-time
// handover of the rows the companion's database kept.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { adoptRows, piRoutes } from "../backend.ts";
import type { BackendRequest } from "../../../web/src/plugin-api/backend.ts";

const require = createRequire(import.meta.url);
const { lazyPiDb } = require("../backend/piDb.cjs");

function call(routes: ReturnType<typeof piRoutes>, key: string, params: Record<string, string> = {}, body: unknown = null) {
  const request: BackendRequest = { method: key.split(" ")[0]!, path: "", params, query: {}, body, account: { accountID: 1, username: "tester" } };
  return routes[key]!(request);
}

test("a plan is created, listed, updated on its revision and deleted", async () => {
  const routes = piRoutes(lazyPiDb({ filename: ":memory:" }));
  const created = (await call(routes, "POST /plans", {}, { typeID: 2393, quantity: 100 })).body as { plan: { planID: string; rev: number } };
  assert.equal(created.plan.rev, 1);
  assert.equal(((await call(routes, "GET /plans")).body as { plans: unknown[] }).plans.length, 1);
  const updated = (await call(routes, "POST /plans/:planID", { planID: created.plan.planID }, { quantity: 50, baseRev: 1 })).body as { plan: { rev: number } };
  assert.equal(updated.plan.rev, 2);
  const stale = await call(routes, "POST /plans/:planID", { planID: created.plan.planID }, { quantity: 5, baseRev: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual((await call(routes, "POST /plans/:planID/delete", { planID: created.plan.planID })).body, { ok: true, removed: true });
});

test("a refused plan is a 400 with the store's own sentence", async () => {
  const routes = piRoutes(lazyPiDb({ filename: ":memory:" }));
  const refused = await call(routes, "POST /plans", {}, { typeID: -1, quantity: 1 });
  assert.equal(refused.status, 400);
  assert.equal((refused.body as { error: string }).error, "PI_PLAN_INVALID");
});

test("the companion's rows are taken over once, and a second handover changes nothing", async () => {
  const db = lazyPiDb({ filename: ":memory:" });
  const row = { id: "p1", type_id: 2393, quantity: 10, note: "", status: "active", rev: 3, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z" };
  adoptRows(db, { plans: [row], expansions: [] });
  adoptRows(db, { plans: [{ ...row, quantity: 999 }], expansions: [] });
  const plans = ((await call(piRoutes(db), "GET /plans")).body as { plans: { planID: string; quantity: number; rev: number }[] }).plans;
  assert.deepEqual(plans.map((plan) => [plan.planID, plan.quantity, plan.rev]), [["p1", 10, 3]]);
});
