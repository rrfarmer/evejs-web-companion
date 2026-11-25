import test from "node:test";
import assert from "node:assert/strict";
import {
  createSecurityProgressRoute,
  createSecurityHistoryRoute,
  createSecurityReceiptsRoute,
} from "./progress.ts";
const state = (runID: string, n: number) => ({
  version: 1,
  revision: 1,
  runID,
  accountID: "test47",
  characterID: 44,
  shipID: 3,
  agentID: 4,
  agentStationID: 5,
  agentSystemID: 6,
  deadlineMs: 1,
  missionLimit: 2,
  phase: "DONE",
  pending: null,
  completed: Array.from({ length: n }, (_, i) => ({
    identity: { acceptedKey: `key-${i}`, missionID: 2504, dungeonID: 875, instanceID: 12 },
    commandID: `cmd-${i}`,
    reward: { confirmedIsk: "100" },
  })),
});
function fixture() {
  const documents: Record<string, unknown> = {
    "security:44": {
      format: "security-history-v1",
      history: [state("old", 1)],
      active: state("new", 2),
    },
    "security-telemetry:44:new": {
      runID: "new",
      events: Array.from({ length: 64 }, (_, i) => ({
        kind: "sample",
        at: i,
        data: { large: "x".repeat(4000) },
      })),
    },
  };
  let closes = 0,
    reads: string[] = [];
  const route = createSecurityProgressRoute(() => ({
    read: (name) => {
      reads.push(name);
      return documents[name] ?? null;
    },
    close: () => {
      closes++;
    },
  }));
  const request = (runID: string, username = "Test47", characterID = "44") => ({
    method: "GET",
    path: "",
    params: { characterID },
    query: { runID },
    body: null,
    account: { username, accountID: 62 },
  });
  return { route, request, documents, reads, closed: () => closes };
}
test("exact active and archived runs remain separate and compact", async () => {
  const x = fixture(),
    a = await x.route(x.request("new")),
    b = await x.route(x.request("old"));
  assert.equal(a.status, 200);
  assert.equal((a.body as any).readout.completedCount, 2);
  assert.equal((a.body as any).readout.latestReceipt.missionKey, "key-1");
  assert.equal((b.body as any).readout.completedCount, 1);
  assert.equal((b.body as any).runID, "old");
  assert.ok(Buffer.byteLength(JSON.stringify(a.body)) < 16384);
  assert.equal(x.closed(), 2);
});
test("foreign account, wrong pilot or run cannot read another run", async () => {
  const x = fixture();
  for (const r of [
    x.request("new", "Other"),
    x.request("other"),
    x.request("new", "Test47", "45"),
    x.request("new", "Test47", "not-an-id"),
  ])
    assert.equal((await x.route(r)).status, 404);
  assert.equal(x.reads.includes("security-telemetry:44:new"), false);
});
test("duplicate run rows and malformed telemetry do not produce a summary", async () => {
  const x = fixture();
  (x.documents["security:44"] as any).history.push({ ...state("new", 2), accountID: "other" });
  assert.equal((await x.route(x.request("new"))).status, 404);
  assert.equal(x.reads.includes("security-telemetry:44:new"), false);
  (x.documents["security:44"] as any).history.pop();
  x.documents["security-telemetry:44:new"] = { runID: "other", events: [] };
  assert.equal((await x.route(x.request("new"))).status, 503);
});
test("durable history returns separate owned runs without asserting parking", async () => {
  const x = fixture();
  const route = createSecurityHistoryRoute(() => ({
    read: (name) => x.documents[name] ?? null,
    close() {},
  }));
  const result = await route(x.request("ignored"));
  assert.equal(result.status, 200);
  const body = result.body as any;
  assert.deepEqual(
    body.rows.map((r: any) => [r.runID, r.completedCount]),
    [
      ["new", 2],
      ["old", 1],
    ],
  );
  assert.equal("parking" in body.rows[0], false);
  assert.equal((await route(x.request("ignored", "Other"))).status, 404);
  assert.equal((await route(x.request("ignored", "Test47", "45"))).status, 404);
});
test("durable history rejects ambiguous runs and bounds returned history", async () => {
  const x = fixture();
  const route = createSecurityHistoryRoute(() => ({
    read: (name) => x.documents[name] ?? null,
    close() {},
  }));
  const doc = x.documents["security:44"] as any;
  doc.history.push(state("new", 1));
  assert.equal((await route(x.request("ignored"))).status, 503);
  doc.history = Array.from({ length: 25 }, (_, i) => state(`old-${i}`, 1));
  const result = await route(x.request("ignored"));
  assert.equal(result.status, 200);
  assert.equal((result.body as any).rows.length, 20);
  assert.equal((result.body as any).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= 12000);
});
test("owned paged receipts retain independent 100-percent tax and unknown LP without cross-run leakage", async () => {
  const x = fixture(),
    doc = x.documents["security:44"] as any;
  doc.active = state("new", 21);
  doc.active.completed[0].reward = {
    confirmedIsk: "0.00",
    withheldIsk: "100.00",
    observedLpChange: null,
    observedCorporationLpChange: "12",
  };
  doc.active.completed[0].lp = 99;
  const route = createSecurityReceiptsRoute(() => ({
    read: (name) => x.documents[name] ?? null,
    close() {},
  }));
  const a = await route(x.request("new")),
    b = await route({ ...x.request("new"), query: { runID: "new", offset: "20" } });
  assert.equal(a.status, 200);
  assert.equal((a.body as any).entries.length, 20);
  assert.equal((a.body as any).nextOffset, 20);
  assert.deepEqual((a.body as any).entries[0], {
    missionKey: "key-0",
    commandID: "cmd-0",
    confirmedIsk: "0.00",
    withheldIsk: "100.00",
    observedLpChange: null,
    observedCorporationLpChange: "12",
  });
  assert.equal((b.body as any).entries.length, 1);
  assert.equal((b.body as any).nextOffset, null);
  assert.equal((await route(x.request("new", "Other"))).status, 404);
  assert.ok(Buffer.byteLength(JSON.stringify(a.body)) <= 12000);
});
