import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { memoryFleetDocuments } from "./operationStoreFixture.ts";
import { createMiningFleetRuntime, type FleetSetup } from "./runtime.ts";

const miner = { characterID: 1, shipID: 11, role: "MINER" } as const;
const runID = "run";
const dock = { kind: "station", destinationID: 600, systemID: 300 } as const;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fleet(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  async function pulse() {
    t.mock.timers.tick(1500);
    await flush();
  }
  let finishRelease!: () => void;
  const gate = new Promise<void>(resolve => { finishRelease = resolve; });
  const release = t.mock.fn(() => gate);
  const cycle = { tick: async () => "blocked" as const, stop: async () => {}, release };
  const runtime = createMiningFleetRuntime({
    storage: memoryFleetDocuments(), createCycle: async () => cycle,
    settle: async () => ({ modulesInactive: true, dronesSafe: true, observedAt: Date.now() }),
  });
  t.after(async () => { finishRelease(); await runtime.shutdown(); });
  const setup: FleetSetup = {
    operationID: "tick-test", operationRunID: runID, systemID: 300, destinationID: 600,
    delivery: { ...dock, corporationID: null, division: null }, parking: { mode: "RETURN_HOME_DOCK", ...dock },
    beltID: 99, beltName: "Belt", canCapacityM3: 100, haulMode: "SELF_UNLOAD", members: [miner],
  };
  const group = runtime.getOrCreate(setup);
  const reports: Parameters<PluginRunContext["report"]>[0][] = [];
  const unregister = t.mock.fn();
  const session = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: { requestOptions: () => ({}), setLivePush() {}, flying: {
      isSessionClosing: () => false,
      async bridgeDo(service: string, method: string) {
        assert.deepEqual([service, method], ["invCache", "InvalidateLocationCache"]);
      },
      async bridgeAsk(_service: string, method: string) {
        assert.equal(method, "List");
        return { type: "list", items: [] };
      },
    } },
  };
  const run = {
    botID: "miner", characterID: 1, baseUrl: "http://test.invalid",
    report: (update: typeof reports[number]) => reports.push(update),
    async fetch(input: URL | string) {
      assert.equal(new URL(input).pathname, "/api/bridge/flight/status");
      return Response.json({ ok: true, flight: { shipID: 11, solarSystemID: 300, docked: true,
        inSpace: false, stationID: 600, transition: { phase: "ready" } } });
    },
  };
  group.entries.set(1, {
    member: miner, run, session, cycle, native: {}, selfUnload: null, active: true, busy: false,
    failed: null, flushed: true, expiry: Date.now() + 600_000, lease: null, unregister,
  } as unknown as Parameters<typeof group.entries.set>[1]);
  function settleMiner() {
    assert.ok(group.op.settleMember(1, { source: "native-settlement", runID, shipID: 11,
      modulesInactive: true, dronesSafe: true, observedAt: Date.now() }));
  }
  function parkMiner() {
    group.op.requestStop();
    settleMiner();
    assert.ok(group.op.parkMember(1, { source: "native-flight", runID, shipID: 11,
      locationID: 600, docked: true, observedAt: Date.now() }));
    assert.equal(group.op.snapshot().state, "STOPPED");
  }
  return { group, setup, runtime, release, finishRelease, unregister, reports, parkMiner, settleMiner, pulse };
}

test("a slow STOPPED pass releases its cycle once while another operation keeps ticking", async t => {
  const f = fleet(t);
  f.parkMiner();
  const other = f.runtime.getOrCreate({ ...f.setup, operationID: "another-fleet" });
  const otherReads = t.mock.method(other.op, "snapshot");
  await f.pulse();
  for (let i = 0; i < 3; i++) {
    otherReads.mock.resetCalls();
    await f.pulse();
    assert.ok(otherReads.mock.callCount() > 0);
  }
  assert.equal(f.release.mock.callCount(), 1);
  assert.equal(f.unregister.mock.callCount(), 0);
  f.finishRelease();
  await flush();
  await f.pulse();
  assert.equal(f.release.mock.callCount(), 1);
  assert.equal(f.unregister.mock.callCount(), 1);
  assert.equal(f.reports.filter(r => r.status === "stopped").length, 1);
});

test("an error in a fleet pass is reported and the next interval can finish it", async t => {
  const f = fleet(t);
  f.parkMiner();
  f.release.mock.mockImplementationOnce(async () => { throw Error("release failed"); });
  f.finishRelease();
  await f.pulse();
  assert.ok(f.reports.some(r => r.phase === "Needs attention" && r.why === "release failed"));
  assert.equal(f.unregister.mock.callCount(), 0);
  await f.pulse();
  assert.equal(f.release.mock.callCount(), 2);
  assert.equal(f.reports.filter(r => r.status === "stopped").length, 1);
});

for (const mode of ["COLLECT_FREIGHT", "RETURN_HOME"] as const) {
  test(`${mode} interrupts a belt change while its tick is waiting for release`, async t => {
    const f = fleet(t);
    const { op } = f.group;
    const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: "Belt" });
    assert.ok(claim && op.activate(1));
    assert.ok(f.group.requestRelocation({ ...f.setup, claimKey: claim.key, claimGeneration: claim.generation,
      next: { beltID: 100, beltName: "Next belt" } }, 99));
    assert.ok(op.drainRelocation());
    assert.ok(op.recordSelfUnloadFinal(1, { source: "native-self-unload", runID, shipID: 11,
      rawRemaining: [], observedAt: Date.now() }));
    f.settleMiner();
    await f.pulse(); // Observe the docked pilot at the old target.
    await f.pulse(); // Relocation now waits for the old cycle to release.
    assert.equal(f.release.mock.callCount(), 1);
    assert.deepEqual(f.runtime.requestOperationStop(f.setup, mode), { mode, live: true });
    assert.equal(op.snapshot().stopFreight, mode);
    await f.pulse();
    assert.ok(op.snapshot().relocation, "a second pass must not advance the interrupted relocation");
    f.finishRelease();
    await flush();
    assert.ok(op.snapshot().relocation, "the skipped interval must not be replayed on release");
    for (let i = 0; i < 6 && !f.unregister.mock.callCount(); i++) await f.pulse();
    assert.equal(op.snapshot().state, "STOPPED", JSON.stringify(f.reports));
    assert.deepEqual(op.snapshot().parked, [1]);
    assert.equal(op.snapshot().relocationHistory?.length ?? 0, 0);
    assert.equal(f.release.mock.callCount(), 1);
    assert.equal(f.unregister.mock.callCount(), 1);
  });
}

test("runtime shutdown clears its timers and waits for the active pass without finalizing twice", async t => {
  const f = fleet(t);
  f.parkMiner();
  await f.pulse();
  assert.equal(f.release.mock.callCount(), 1);
  const cleared = t.mock.method(globalThis, "clearInterval");
  let drained = false;
  const shutdown = f.runtime.shutdown().then(() => { drained = true; });
  assert.equal(cleared.mock.callCount(), 2); // Tick and heartbeat.
  await f.pulse();
  assert.equal(drained, false);
  f.finishRelease();
  await shutdown;
  await f.pulse();
  assert.equal(cleared.mock.callCount(), 2);
  assert.equal(f.release.mock.callCount(), 1);
  assert.equal(f.unregister.mock.callCount(), 1);
  assert.ok(!f.reports.some(r => r.status === "stopped"));
});
