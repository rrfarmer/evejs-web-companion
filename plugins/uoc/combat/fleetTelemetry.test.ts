import test from "node:test";
import assert from "node:assert/strict";
import { createFleetTelemetry, createFleetSecurityProgressRoute } from "./fleetTelemetry.ts";
const id = {
  operationID: "op",
  operationRunID: "epoch",
  botID: "b2",
  characterID: 2,
  shipID: 12,
  sessionGeneration: 7,
  account: "Pilot2",
};
function fixture() {
  const docs = new Map<string, unknown>(),
    document = (key: string) => ({
      read: () => docs.get(key) ?? null,
      write: (v: unknown) => {
        docs.set(key, structuredClone(v));
      },
    }),
    telemetry = createFleetTelemetry(document, id),
    route = createFleetSecurityProgressRoute(() => ({
      read: (key) => structuredClone(docs.get(key) ?? null),
      close() {},
    }));
  const request = (username = "pilot2", botID = "b2") =>
    ({
      params: { characterID: "2" },
      query: { operationID: "op", operationRunID: "epoch", botID },
      account: { username },
    }) as any;
  return { docs, telemetry, route, request };
}
test("exact owned actor route returns verified ship/generation and retains uncertain native dispatch after ring eviction", async () => {
  const f = fixture();
  f.telemetry.record("launch-dispatch", { stacks: [{ itemID: 7, quantity: 2 }] });
  for (let i = 0; i < 160; i++) f.telemetry.record("sample", { n: i });
  const r = (await f.route(f.request())) as any;
  assert.equal(r.status, 200);
  assert.equal(r.body.shipID, 12);
  assert.equal(r.body.pending.launch.seq, 1);
  assert.ok(r.body.events.every((e: any, i: number, a: any[]) => i === 0 || e.seq > a[i - 1].seq));
  assert.equal(r.body.sessionGeneration, 7);
  assert.equal(r.body.pending.launch.kind, "launch-dispatch");
  assert.equal(r.body.events.length <= 32, true);
  assert.equal(Buffer.byteLength(JSON.stringify(r.body)) <= 12000, true);
  assert.equal(((await f.route(f.request("other"))) as any).status, 404);
  assert.equal(((await f.route(f.request("pilot2", "other"))) as any).status, 404);
  f.telemetry.record("launch-confirmed", { drones: [{ itemID: 8, ownerID: 2, controllerID: 12 }] });
  assert.equal(((await f.route(f.request())) as any).body.pending.launch, undefined);
});
test("agent dispatch history and Complete pending survive observation churn until confirmed", async () => {
  const f = fixture();
  f.telemetry.record("mission-offered", { offer: { key: "k" } });
  f.telemetry.record("agent-action-dispatch", { kind: "REQUEST", commandID: "r" });
  f.telemetry.record("agent-action-response", { kind: "REQUEST", commandID: "r" });
  f.telemetry.record("complete-dispatch", {
    commandID: "c",
    objectiveComplete: true,
    dungeonComplete: true,
  });
  f.telemetry.record("complete-response", { commandID: "c", completed: true });
  for (let i = 0; i < 140; i++) f.telemetry.record("sample", { n: i });
  const r = (await f.route(f.request())) as any;
  assert.equal(r.body.pending.complete.data.commandID, "c");
  assert.equal(r.body.milestones["mission-offered"].data.offer.key, "k");
  assert.deepEqual(
    r.body.agentActions.map((v: any) => v.data.kind),
    ["REQUEST", "REQUEST"],
  );
  assert.equal(r.body.agentActionsTruncated, false);
  f.telemetry.record("complete-confirmed", { commandID: "c" });
  assert.equal(((await f.route(f.request())) as any).body.pending.complete, undefined);
});

test("failed durable confirmation preserves pending and does not advance the in-memory sequence", () => {
  let persisted: unknown = null,
    fail = false;
  const telemetry = createFleetTelemetry(
    () => ({
      read: () => structuredClone(persisted),
      write: (v) => {
        if (fail) throw Error("fsync failed");
        persisted = structuredClone(v);
      },
    }),
    id,
  );
  telemetry.record("engage-dispatch", { target: 90 });
  const before = telemetry.snapshot();
  fail = true;
  assert.throws(() => telemetry.record("engage-confirmed", { target: 90 }), /fsync failed/);
  const after = telemetry.snapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(persisted, before);
  assert.equal(after.pending.engage.seq, 1);
  assert.equal(after.milestones["engage-confirmed"], undefined);
  assert.equal(after.nextSeq, 2);
  fail = false;
  telemetry.record("sample", { value: 1 });
  assert.equal(telemetry.snapshot().events.at(-1).seq, 2);
  assert.equal(telemetry.snapshot().pending.engage.seq, 1);
});

test("exact absent target clears only its matching pending dispatch while retaining its native response", () => {
  const f = fixture(),
    scope = { acceptedKey: "mission", dungeonID: 3030, instanceID: 3363, roomID: 0 },
    ids = [8, 9],
    refusal = [
      "CustomNotify",
      { type: "dict", entries: [["notify", "That target cannot be engaged by drones."]] },
    ];
  f.telemetry.record("engage-dispatch", { ids, target: 90, scope });
  f.telemetry.record("engage-response", {
    ids,
    target: 90,
    result: { type: "dict", entries: ids.map((id) => [id, refusal]) },
  });
  f.telemetry.record("engage-target-absent", { target: 91, scope });
  assert.equal(f.telemetry.snapshot().pending.engage.seq, 1);
  f.telemetry.record("engage-target-absent", { target: 90, scope: { ...scope, instanceID: 9 } });
  assert.equal(f.telemetry.snapshot().pending.engage.seq, 1);
  f.telemetry.record("engage-target-absent", { target: 90, scope });
  let x = f.telemetry.snapshot();
  assert.equal(x.pending.engage, undefined);
  assert.equal(x.pending.engageResponse, undefined);
  const proof = x.milestones["engage-absent-settlement"].data;
  assert.equal(proof.dispatch.seq, 1);
  assert.equal(proof.response.seq, 2);
  assert.equal(proof.absence.data.target, 90);
  assert.equal(proof.response.data.result.entries.length, 2);
  for (let i = 0; i < 150; i++) f.telemetry.record("sample", { i });
  x = f.telemetry.snapshot();
  assert.equal(x.milestones["engage-absent-settlement"].data.response.seq, 2);
});
test("missing or mismatched response cannot fabricate absence settlement", () => {
  const f = fixture(),
    scope = { acceptedKey: "mission", dungeonID: 3, instanceID: 4, roomID: 0 };
  f.telemetry.record("engage-dispatch", { ids: [8, 9], target: 90, scope });
  f.telemetry.record("engage-response", {
    ids: [8],
    target: 90,
    result: { type: "dict", entries: [] },
  });
  f.telemetry.record("engage-target-absent", { target: 90, scope });
  const x = f.telemetry.snapshot();
  assert.ok(x.pending.engage);
  assert.equal(x.milestones["engage-absent-settlement"], undefined);
});
test("failed durable absence settlement leaves exact pending and sequence unchanged", () => {
  let persisted: any = null,
    fail = false;
  const t = createFleetTelemetry(
      () => ({
        read: () => structuredClone(persisted),
        write: (v) => {
          if (fail) throw Error("fsync failed");
          persisted = structuredClone(v);
        },
      }),
      id,
    ),
    scope = { acceptedKey: "mission", dungeonID: 3, instanceID: 4, roomID: 0 };
  t.record("engage-dispatch", { ids: [8], target: 90, scope });
  t.record("engage-response", { ids: [8], target: 90, result: { type: "dict", entries: [] } });
  const before = t.snapshot();
  fail = true;
  assert.throws(() => t.record("engage-target-absent", { target: 90, scope }), /fsync failed/);
  assert.deepEqual(t.snapshot(), before);
  assert.deepEqual(persisted, before);
  assert.ok(t.snapshot().pending.engage);
  assert.equal(t.snapshot().milestones["engage-absent-settlement"], undefined);
});
