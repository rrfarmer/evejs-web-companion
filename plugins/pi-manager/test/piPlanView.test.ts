// Where the player was in the planner: which saved plan was open, and which of
// its tree nodes were unfolded. Browser-local, untrusted on the way back in.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PI_PLAN_VIEW,
  loadPiPlanView,
  prunePiPlanView,
  savePiPlanView,
  setPiPlanViewStorage,
  withOpenNodes,
  withOpenPlan,
  type PiPlanViewStorage,
} from "../lib/piPlanView.ts";

function memoryStorage(): PiPlanViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

test("the open plan and its unfolded nodes survive a reload", () => {
  const storage = memoryStorage();
  setPiPlanViewStorage(storage);
  try {
    const view = withOpenNodes(withOpenPlan(EMPTY_PI_PLAN_VIEW, "plan-1"), "plan-1", ["2867", "2867/9832"]);
    savePiPlanView(view);
    assert.deepEqual(loadPiPlanView(), view);
  } finally {
    setPiPlanViewStorage(null);
  }
});

test("a hand-edited or foreign store decodes to what is usable", () => {
  const storage = memoryStorage();
  setPiPlanViewStorage(storage);
  try {
    storage.data.set("evejs-web-pi-plan-view:v1", "{not json");
    assert.deepEqual(loadPiPlanView(), EMPTY_PI_PLAN_VIEW);
    storage.data.set(
      "evejs-web-pi-plan-view:v1",
      JSON.stringify({ openID: 7, openNodes: { a: ["k", "k", 3, ""], b: "nope", c: [] } }),
    );
    assert.deepEqual(loadPiPlanView(), { openID: null, openNodes: { a: ["k"] } });
  } finally {
    setPiPlanViewStorage(null);
  }
});

test("no storage at all is an empty view, never an error", () => {
  setPiPlanViewStorage(null);
  assert.deepEqual(loadPiPlanView(), EMPTY_PI_PLAN_VIEW);
  savePiPlanView(withOpenPlan(EMPTY_PI_PLAN_VIEW, "x"));
});

test("folding everything forgets the plan's entry", () => {
  const view = withOpenNodes(EMPTY_PI_PLAN_VIEW, "plan-1", ["k"]);
  assert.deepEqual(withOpenNodes(view, "plan-1", []).openNodes, {});
});

test("pruning against the server's list drops deleted plans, and the open one if it went", () => {
  let view = withOpenPlan(EMPTY_PI_PLAN_VIEW, "gone");
  view = withOpenNodes(view, "gone", ["k"]);
  view = withOpenNodes(view, "kept", ["k"]);
  assert.deepEqual(prunePiPlanView(view, ["kept"]), { openID: null, openNodes: { kept: ["k"] } });
  const open = withOpenPlan(view, "kept");
  assert.equal(prunePiPlanView(open, ["kept"]).openID, "kept");
});
