// The scanner's sites asked by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { readScanFullState } from "./scanFullState.ts";

const emptyDict = { type: "dict", entries: [] } as const;

function harness(answer: unknown = [emptyDict, emptyDict, emptyDict, emptyDict], refusal: Error | null = null) {
  const asked: unknown[][] = [];
  const ask = async (...call: unknown[]) => { asked.push(call); if (refusal) throw refusal; return answer as never; };
  return { asked, ask };
}

test("the sites are asked of the scan manager by one call, with nothing, and of no object the page names", async () => {
  const { asked, ask } = harness();

  const state = await readScanFullState(ask);

  // sensorSuiteService (718, 722): self.scanSvc.GetScanMan().GetFullState().
  assert.deepEqual(asked, [["scanMgr", "GetFullState", []]]);
  // The four parts the server sends, each with nothing in it: a system that was read and has no sites.
  assert.deepEqual(state, { anomalies: [], signatures: [], staticSites: [], structures: [] });
});

test("what the scan manager answers is what is handed on: a site it knows of is a site", async () => {
  const site = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["targetID", "ABC-123"], ["position", [1, 2, 3]]] } };
  const { ask } = harness([{ type: "dict", entries: [[5380000140001, site]] }, emptyDict, emptyDict, emptyDict]);

  const state = await readScanFullState(ask);

  assert.deepEqual([state.anomalies.map((each) => [each.siteID, each.targetID]), state.signatures, state.staticSites, state.structures], [[[5380000140001, "ABC-123"]], [], [], []]);
});

test("a read the server refuses is the caller's, as it came: no sites are made up in its place", async () => {
  const { ask } = harness(null, new Error("scanner offline"));

  await assert.rejects(readScanFullState(ask), /scanner offline/);
});
