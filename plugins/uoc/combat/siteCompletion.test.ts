import test from "node:test";
import assert from "node:assert/strict";
import { createSignal } from "../../../web/src/store/signals.ts";
import { createSiteCompletionObserver, type SiteCompletionReceipt } from "./siteCompletion.ts";
const scope = { operationID: "op", operationRunID: "epoch", botID: "bot", sessionGeneration: 7 };
const site = {
  characterID: 1,
  shipID: 11,
  systemID: 300,
  dungeonID: 875,
  instanceID: 222,
  roomID: 1,
};
function fixture() {
  let time = 100,
    keeper: any = { dungeonID: 875, instanceID: 222, roomID: 1 },
    alive = true,
    failSave = false;
  const saved: SiteCompletionReceipt[] = [],
    signal = createSignal<any>({
      status: "live",
      epoch: "e1",
      sequence: 5,
      notifications: [],
      lastEventAtMs: null,
      questions: [],
    });
  const observer = createSiteCompletionObserver({
    site,
    scope,
    live: signal,
    assertCurrent() {
      if (!alive) throw Error("held session changed");
    },
    readKeeper: async () => keeper,
    saveReceipt: (r) => {
      if (failSave) throw Error("disk failure");
      saved.push(r);
    },
    now: () => time,
  });
  const event = (method: string, args: unknown[], sequence: number) => {
    time++;
    const s = signal.get();
    signal.set({
      ...s,
      sequence,
      notifications: [
        ...s.notifications,
        { kind: "notification", service: null, method, args, receivedAtMs: time },
      ].slice(-50),
    });
  };
  return {
    observer,
    signal,
    saved,
    event,
    changeKeeper: (v: unknown) => {
      keeper = v;
    },
    retire: () => {
      alive = false;
    },
    failSave: () => {
      failSave = true;
    },
  };
}
test("stream starts before entry; pre-arm event cannot become completion and sequence gaps are allowed", async () => {
  const x = fixture();
  x.observer.begin();
  x.event("OnDungeonCompleted", [875], 6);
  await x.observer.arm();
  assert.deepEqual(await x.observer.check(), { state: "pending" });
  x.event("Other", [], 9);
  x.event("OnDungeonCompleted", [875], 13);
  const r = await x.observer.check();
  assert.equal(r.state, "confirmed");
  if (r.state === "confirmed") {
    assert.deepEqual(r.receipt.scope, scope);
    assert.equal(r.receipt.baseline.sequence, 5);
    assert.equal(r.receipt.event.sequence, 13);
    assert.equal(r.receipt.event.method, "OnDungeonCompleted");
    assert.equal(r.receipt.keeperAfter.value.instanceID, 222);
  }
  assert.equal(x.saved.length, 1);
  x.observer.close();
});
test("foreign dungeon or empty notification does not prove completion", async () => {
  const x = fixture();
  x.observer.begin();
  await x.observer.arm();
  x.event("OnDungeonCompleted", [876], 6);
  x.event("OnDungeonCompleted", [], 7);
  assert.deepEqual(await x.observer.check(), { state: "pending" });
  x.observer.close();
});
test("degraded channel, epoch change, cursor regression and resync tail reset are unknown", async () => {
  for (const change of [
    (s) => ({ ...s, status: "degraded" }),
    (s) => ({ ...s, epoch: "other" }),
    (s) => ({ ...s, sequence: 4 }),
    (s) => ({ ...s, notifications: [] }),
    (s) => ({
      ...s,
      sequence: 7,
      notifications: [
        { method: "Other", args: [], receivedAtMs: 101 },
        { method: "Other", args: [], receivedAtMs: 102 },
      ],
    }),
  ] as ((s: any) => any)[]) {
    const x = fixture();
    x.observer.begin();
    await x.observer.arm();
    x.signal.set(change(x.signal.get()));
    assert.equal((await x.observer.check()).state, "unknown");
    x.event("OnDungeonCompleted", [875], 7);
    assert.equal(x.saved.length, 0);
    x.observer.close();
  }
});
test("keeper mismatch, retired session and failed durable write cannot produce receipt", async () => {
  for (const mode of ["keeper", "session", "save"]) {
    const x = fixture();
    x.observer.begin();
    await x.observer.arm();
    x.event("OnDungeonCompleted", [875], 6);
    if (mode === "keeper") x.changeKeeper({ dungeonID: 875, instanceID: 999, roomID: 1 });
    if (mode === "session") x.retire();
    if (mode === "save") x.failSave();
    assert.equal((await x.observer.check()).state, "unknown", mode);
    assert.equal(x.saved.length, 0);
    x.observer.close();
  }
});
test("entry keeper must match before arming; no live baseline cannot start", async () => {
  const x = fixture();
  x.signal.set({ ...x.signal.get(), status: "connecting" });
  assert.throws(() => x.observer.begin(), /baseline/);
  x.signal.set({ ...x.signal.get(), status: "live" });
  x.observer.begin();
  x.changeKeeper(null);
  await assert.rejects(x.observer.arm(), /site/);
  assert.deepEqual(await x.observer.check(), { state: "pending" });
  x.observer.close();
});

test("closing before reconciliation cannot later create a receipt", async () => {
  const x = fixture();
  x.observer.begin();
  await x.observer.arm();
  x.event("OnDungeonCompleted", [875], 6);
  x.observer.close();
  assert.equal((await x.observer.check()).state, "unknown");
  assert.equal(x.saved.length, 0);
});

test("retired owner or closed observer cannot return active confirmation or write again", async () => {
  for (const mode of ["retired", "closed"]) {
    const x = fixture();
    x.observer.begin();
    await x.observer.arm();
    x.event("OnDungeonCompleted", [875], 6);
    assert.equal((await x.observer.check()).state, "confirmed");
    const stored = structuredClone(x.saved[0]);
    if (mode === "retired") x.retire();
    else x.observer.close();
    assert.equal((await x.observer.check()).state, "unknown");
    assert.equal(x.saved.length, 1);
    assert.deepEqual(x.saved[0], stored);
    x.observer.close();
  }
});
