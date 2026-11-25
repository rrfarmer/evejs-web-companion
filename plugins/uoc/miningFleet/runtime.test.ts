import { officeList, corporationRow } from "./corporateOfficeFixture.ts";
import { memoryFleetDocuments } from "./operationStoreFixture.ts";
import { testPilotSession } from "../test/pilotSession.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  confirmCommandFinalHold,
  createMiningFleetRuntime,
  fleetHaulDocumentKey,
  commandStopDeadline,
  confirmIndustrialCoreInactive,
  coreReadyForActivation,
  readHullRatio,
  searchTargetAvailable,
  canReleaseExpiredTarget,
  type FleetSetup,
} from "./runtime.ts";
import { createTargetBoard, targetKey, type Target } from "./targetBoard.ts";
import { createNativeBeltNavigation, readMiningReadiness } from "./nativeBelt.ts";
import { pilotServiceOwner, registerRun, runControlRoutes } from "../runControl.ts";
import { FleetStopBeforeDispatch } from "./stopSignal.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { createBurstGroup } from "./support/burstGroup.ts";
import type { Member } from "./operation.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import type { JsonValue } from "../shared/wire.ts";
const docs = new Map<string, unknown>(),
  storage = memoryFleetDocuments(docs),
  document = storage.document;
const deps = {
  storage,
  createCycle: async () => ({ tick: async () => "blocked" as const, stop: async () => {} }),
  settle: async () => ({
    modulesInactive: true as const,
    dronesSafe: true as const,
    observedAt: Date.now(),
  }),
};
const base: FleetSetup = {
  operationID: "runtime-test",
  operationRunID: "epoch-1",
  systemID: 300,
  destinationID: 600,
  corporationID: 77,
  division: 1,
  beltID: 99,
  beltName: "belt",
  canCapacityM3: 100,
  members: [
    { characterID: 1, shipID: 11, role: "MINER" },
    { characterID: 2, shipID: 12, role: "MINER" },
    { characterID: 3, shipID: 13, role: "HAULER" },
  ],
};

test("productive fleet passes take no per-pilot parking snapshots; Stop reads current settlement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const members: Member[] = Array.from({ length: 15 }, (_, i) => ({
    characterID: i + 1,
    shipID: i + 20,
    role: i < 9 ? "MINER" : i < 13 ? "DEFENDER" : "HAULER",
  }));
  const setup = { ...base, operationID: "parking-snapshot-reads", members };
  const group = createMiningFleetRuntime(deps).getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName! }));
  assert.ok(group.op.activate(1));
  for (const member of members)
    group.entries.set(member.characterID, {
      member,
      active: true,
      busy: true,
      expiry: Date.now() + 600_000,
      run: { botID: "b" + member.characterID, characterID: member.characterID, report() {} },
      session: {
        store: {
          station: {
            get: () => ({ online: { characterID: member.characterID, corporationID: 77 } }),
          },
        },
        flow: { setLivePush() {} },
      },
      native: {},
      startupManaged: false,
      lease: null,
    } as any);
  const reads = t.mock.method(group.op, "snapshot");
  const turn = async () => {
    reads.mock.resetCalls();
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return reads.mock.callCount();
  };
  const activeReads = await turn();
  group.requestStop("RETURN_HOME");
  const stopReads = await turn();
  for (const e of group.entries.values()) {
    e.active = false;
    e.busy = false;
  }
  group.retireStoppedGroup();
  t.diagnostic(`15 pilots: ${activeReads} snapshots while active, ${stopReads} during Return Home`);
  assert.equal(activeReads, 3, "one active pass uses only the fleet-level snapshots");
  assert.ok(stopReads >= members.length, "Stop snapshot reads: " + stopReads);
});

test("fourteen admitted pilots share one fleet roster read and recheck a removed member in its own session", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const members: Member[] = Array.from({ length: 14 }, (_, i) => ({
    characterID: i + 1,
    shipID: i + 20,
    role: i < 8 ? "MINER" : i < 12 ? "DEFENDER" : "HAULER",
  }));
  const setup = { ...base, operationID: "active-roster-reads", beltName: "active roster", members };
  const group = createMiningFleetRuntime(deps).getOrCreate(setup);
  t.after(() => group.shutdown());
  const memberIDs = members.map((m) => m.characterID),
    fleetID = 900;
  const key = `mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`;
  document(key).write({
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      members.map((m) => [m.characterID, m.shipID, `bot-${m.characterID}`]),
    ]),
    leaderID: 1,
    fleetID,
    pending: null,
    joined: memberIDs,
  });
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  const rosterReads: number[] = [],
    flightReads: number[] = [];
  let currentMembers = memberIDs;
  const kv = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  for (const member of members) {
    const id = member.characterID;
    group.entries.set(id, {
      member,
      startupManaged: true,
      anchorReady: true,
      active: true,
      busy: true,
      unregister() {},
      expiry: Date.now() + 600_000,
      run: {
        botID: `bot-${id}`,
        characterID: id,
        baseUrl: "http://bff",
        report() {},
        async fetch(input: unknown) {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/status")) {
            flightReads.push(id);
            return Response.json({
              ok: true,
              flight: { shipID: member.shipID, inSpace: true, solarSystemID: 300 },
            });
          }
          assert.equal(url.pathname, "/api/bridge/bound-fleet");
          assert.equal(url.searchParams.get("view"), "menu");
          rosterReads.push(id);
          if (!currentMembers.includes(id))
            return Response.json({ ok: false, error: "CALL_TIMEOUT" }, { status: 504 });
          const fleet = kv([
            ["fleetID", fleetID],
            [
              "members",
              { type: "dict", entries: currentMembers.map((n) => [n, kv([["charID", n]])]) },
            ],
          ]);
          return Response.json({ ok: true, fleetID, reads: { GetInitState: { result: fleet } } });
        },
      },
      session: {
        store: { station: { get: () => ({ online: { characterID: id } }) } },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: { isSessionClosing: () => false, bridgeAsk: async () => null },
        },
      },
    } as any);
  }
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await tick(1500);
  assert.deepEqual(rosterReads, memberIDs);
  assert.deepEqual(flightReads, memberIDs);
  rosterReads.length = 0;
  flightReads.length = 0;
  await tick(9000);
  assert.deepEqual(rosterReads, [1]);
  assert.deepEqual(flightReads, []);
  currentMembers = memberIDs.slice(0, -1);
  await tick(9000);
  assert.equal(group.entries.get(14)?.fleetRead, null);
  await tick(1500);
  assert.deepEqual(rosterReads, [1, 1, 14]);
  assert.deepEqual(flightReads, [14]);
});

test("MCC Burst reporting uses the observations from the current module turn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const modules = [
    { moduleID: 700, typeID: 701 },
    { moduleID: 702, typeID: 703 },
  ];
  const member = { characterID: 4, shipID: 14, role: "COMMAND" as const };
  const setup = {
    ...base,
    operationID: "burst-summary-reads",
    beltName: "burst-summary",
    command: { bursts: modules },
    members: [...base.members, member],
  };
  const runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup);
  t.after(() => group.shutdown());
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  const reads: number[] = [],
    active = new Set([700]);
  let unknown = false;
  const bursts = createBurstGroup({
    modules,
    current() {},
    create: (module) =>
      ({
        ...module,
        proof: {},
        command: {
          observe: async () => {
            reads.push(module.moduleID);
            return {
              ...module,
              active: active.has(module.moduleID),
              chargeQuantity: 5,
              observedAt: Date.now(),
            } as BurstObservation;
          },
        },
      }) as any,
    tick: async (unit) => {
      const before = await unit.command.observe();
      if (before.active) return before;
      if (unknown) throw Error("Burst activation reply lost");
      active.add(unit.moduleID);
      return unit.command.observe();
    },
  });
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 4, corporationID: 77 } }) } },
    flow: { setLivePush() {}, flying: { isSessionClosing: () => false } },
  };
  const reports: { phase?: string; why?: string; status?: string }[] = [];
  group.entries.set(4, {
    member,
    session,
    run: {
      botID: "burst",
      characterID: 4,
      report: (report: (typeof reports)[number]) => reports.push(report),
    },
    active: true,
    busy: false,
    unregister() {},
    failed: null,
    expiry: Date.now() + 600_000,
    navigation: { navigate: async () => {} },
    commandGroup: bursts,
  } as any);
  const tick = async () => {
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await tick();
  assert.deepEqual(reads, [700, 702, 702]);
  assert.ok(reports.some((report) => report.phase === "Command observed"));
  reads.length = 0;
  active.delete(702);
  unknown = true;
  await tick();
  assert.deepEqual(reads, [700, 702]);
  assert.ok(
    reports.some(
      (report) =>
        report.phase === "Command support degraded" &&
        report.why?.includes("activation reply lost"),
    ),
  );
  assert.equal(group.entries.get(4)?.failed, null);
});

test("one in-process operation authority rejects another generation or a malformed roster", () => {
  const runtime = createMiningFleetRuntime(deps);
  const first = runtime.getOrCreate(base);
  assert.equal(runtime.getOrCreate(structuredClone(base)), first);
  assert.throws(() => runtime.getOrCreate({ ...base, operationRunID: "other" }), /generation/);
  assert.equal(
    (runtime.runs.MINER.check({ ...base, members: base.members.slice(0, 2) }) as any).ok,
    false,
  );
});
test("a missing Command support module keeps the chosen policy and never authorizes an invented module", async () => {
  const runtime = createMiningFleetRuntime(deps),
    supportPolicy = {
      maintainBursts: true,
      useIndustrialCore: true,
      coreRequirement: "continueWithoutCore",
      enableCompression: true,
      selfMining: false,
      tractor: true,
      collection: "TRACTOR_ONLY",
      compressCollectedOre: false,
      supportLoss: "CONTINUE_UNSUPPORTED",
    } as const;
  const setup = {
    ...base,
    members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    command: {},
    supportPolicy,
    fleetPolicy: "MANAGED" as const,
  };
  const checked = await runtime.runs.COMMAND.check(setup);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.deepEqual((checked.setup as any).supportPolicy, supportPolicy);
    assert.deepEqual((checked.setup as any).command, {});
  }
  assert.equal(
    (
      await runtime.runs.COMMAND.check({
        ...setup,
        command: { compressor: { moduleID: 52, typeID: 99 } },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await runtime.runs.COMMAND.check({
        ...setup,
        command: { tractor: { moduleID: 52, typeID: 99 } },
        supportPolicy: { ...supportPolicy, tractor: false },
      })
    ).ok,
    false,
  );
});
test("unfinished persisted epoch refuses a different generation", () => {
  const op = "prior-test",
    index = `mining-fleet-index:${op}`,
    key = `mining-fleet-operation:${JSON.stringify([op, "old"])}`;
  docs.set(index, { runID: "old" });
  docs.set(key, { state: "ACTIVE" });
  const runtime = createMiningFleetRuntime(deps);
  assert.throws(
    () => runtime.getOrCreate({ ...base, operationID: op, operationRunID: "new" }),
    /unfinished/,
  );
});
test("a new start uses the live grid after release without adopting historical haul claims", () => {
  const setup = {
    ...base,
    operationID: "released-haul-history",
    operationRunID: "old",
    beltName: "shared-restart-belt",
  };
  const runtime = createMiningFleetRuntime(deps);
  const target = { kind: "BELT" as const, systemID: setup.systemID, name: setup.beltName };
  const can = (quantity: number) => ({
    containerID: 900,
    ownerID: 1,
    observedAt: Date.now(),
    capacityM3: 100,
    items: [{ itemID: 901, typeID: 30, quantity, unitVolumeM3: 1, freightKind: "RAW" as const }],
  });
  const old = runtime.getOrCreate(setup).op,
    oldClaim = old.reserve(1, target)!;
  assert.ok(old.activate(1));
  assert.ok(old.registerGridJetcan(3, oldClaim, can(10)));
  const previous = old.claimContainer(3, 900)!;
  assert.ok(old.dispatchHaul(3, 900, previous.generation));
  assert.ok(runtime.discardGeneration(setup.operationID, "old", true));
  const next = runtime.getOrCreate({ ...setup, operationRunID: "new" }).op,
    nextClaim = next.reserve(1, target)!;
  assert.ok(next.activate(1));
  assert.deepEqual(next.snapshot().haulClaims, {});
  assert.deepEqual(next.snapshot().manifests, []);
  assert.ok(next.registerGridJetcan(3, nextClaim, can(4)));
  assert.equal(next.snapshot().manifests[0]?.items[0]?.quantity, 4);
  const retained = runtime.operationSnapshot(setup.operationID, "old");
  assert.equal(retained?.haulClaims["900"]?.dispatched, true);
  assert.equal(retained?.manifests[0]?.items[0]?.quantity, 10);
});
test("type facts only admit ore named by the raw catalogue with real category and volume", async () => {
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("resources")
      ? { resources: [{ typeID: 30, family: "ore", name: "ore" }] }
      : path.endsWith("compressed")
        ? { compressedTypeIDs: { 30: 31 }, capped: false }
        : path.endsWith("dogma-types")
          ? {
              available: true,
              types: { 30: { categoryID: 25 }, 31: { categoryID: 25 }, 40: { categoryID: 8 } },
            }
          : { volumes: { 30: 1, 31: 0.1, 40: 2 }, capped: false };
    return new Response(JSON.stringify({ ok: true, ...body }), {
      headers: { "content-type": "application/json" },
    });
  };
  const facts = await createRawTypeFacts({ baseUrl: "http://bff", fetch: fetcher }, () => {})([
    30, 31, 40,
  ]);
  assert.equal(facts[30]?.freightKind, "RAW");
  assert.equal(facts[31]?.freightKind, "COMPRESSED");
  assert.equal(facts[40]?.freightKind, null);
});
test("haul document is scoped to exact operation, generation, container, pilot and ship", () => {
  const key = fleetHaulDocumentKey("op", "run", 100, 2, 3, 13);
  assert.equal(key, `mining-fleet-haul:${JSON.stringify(["op", "run", 100, 2, 3, 13])}`);
  const variants: [string, string, number, number, number, number][] = [
    ["other", "run", 100, 2, 3, 13],
    ["op", "other", 100, 2, 3, 13],
    ["op", "run", 101, 2, 3, 13],
    ["op", "run", 100, 3, 3, 13],
    ["op", "run", 100, 2, 4, 13],
    ["op", "run", 100, 2, 3, 14],
  ];
  for (const args of variants) assert.notEqual(fleetHaulDocumentKey(...args), key);
  assert.throws(() => fleetHaulDocumentKey("op", "run", 100, 0, 3, 13), /invalid/);
});
test("an expired pickup lease does not block Hauler readback or delivery, while corporation changes still do", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let corporationID = 77;
  const setup = { ...base, operationID: "expired-pickup-lease", beltName: "expired pickup belt" };
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) =>
      ({
        store: {
          station: {
            get: () => ({ online: { characterID: run.held.characterID, corporationID } }),
          },
        },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as unknown as PilotSession,
  });
  const group = runtime.getOrCreate(setup),
    botID = "expired-pickup-hauler";
  const controller = await runtime.runs.HAULER.start({
    botID,
    characterID: 3,
    setup,
    held: { characterID: 3 },
    baseUrl: "http://bff",
    report() {},
    fetch: async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/pilot-training/characters")
        return Response.json({ ok: true, account: "test", characters: [{ characterID: 3 }] });
      if (path === "/api/bots")
        return Response.json({
          ok: true,
          bots: [{ botID, characterID: 3, expiresAt: new Date(Date.now() + 600000).toISOString() }],
        });
      assert.fail("Unexpected request " + path);
    },
  } as any);
  try {
    const entry = group.entries.get(3)!;
    entry.lease = {
      itemID: 100,
      systemID: 300,
      confirmedAt: Date.now(),
      lost: true,
      timer: setInterval(() => {}, 30000),
    };
    assert.doesNotThrow(() => entry.native.current());
    corporationID = 88;
    assert.throws(() => entry.native.current(), /Held corporation changed/);
    corporationID = 77;
  } finally {
    await controller.stop();
    group.requestStop();
    group.retireStoppedGroup();
  }
});

for (const reason of [undefined, "reconnect"] as const)
  test(
    "Hauler runner exit releases only its undispatched claim " + (reason ?? "on Stop"),
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const setup: FleetSetup = {
        ...base,
        operationID: "haul-owner-exit-" + (reason ?? "stop"),
        beltName: "owner exit " + (reason ?? "stop"),
        members: [...base.members, { characterID: 4, shipID: 14, role: "HAULER" }],
      };
      const runtime = createMiningFleetRuntime({
        ...deps,
        attach: async (run) =>
          ({
            store: {
              station: {
                get: () => ({ online: { characterID: run.held.characterID, corporationID: 77 } }),
              },
            },
            flow: {
              requestOptions: () => ({}),
              setLivePush() {},
              flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
            },
          }) as unknown as PilotSession,
      });
      const group = runtime.getOrCreate(setup),
        op = group.op;
      const start = (id: number) => {
        const botID = "owner-exit-" + (reason ?? "stop") + "-" + id;
        return runtime.runs.HAULER.start({
          botID,
          characterID: id,
          setup,
          held: { characterID: id },
          baseUrl: "http://bff",
          report() {},
          fetch: async (input: unknown) => {
            const path = new URL(String(input)).pathname;
            if (path === "/api/pilot-training/characters")
              return Response.json({
                ok: true,
                account: "test" + id,
                characters: [{ characterID: id }],
              });
            if (path === "/api/bots")
              return Response.json({
                ok: true,
                bots: [
                  {
                    botID,
                    characterID: id,
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                  },
                ],
              });
            assert.fail("Unexpected request " + path);
          },
        } as any);
      };
      const a = await start(3),
        b = await start(4);
      try {
        const target = { kind: "BELT" as const, systemID: 300, name: setup.beltName! },
          claim = op.reserve(1, target)!;
        assert.ok(claim && op.activate(1));
        const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
        for (const containerID of [100, 101, 102]) {
          const items = [
            {
              itemID: containerID + 20,
              typeID: 30,
              quantity: 10,
              freightKind: "RAW" as const,
              unitVolumeM3: 1,
            },
          ];
          const scope = {
            source: "checked-ship-holds" as const,
            characterID: 1,
            shipID: 11,
            systemID: 300,
            targetKey: claim.key,
            claimGeneration: claim.generation,
            observedAt: Date.now(),
            items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
          };
          const intent = op.prepareJetcan(1, items, 100, facts, scope)!;
          assert.ok(intent && op.dispatchJetcan(1, intent.generation));
          assert.ok(
            op.registerJetcan(
              {
                source: "native-jetcan",
                operationID: setup.operationID,
                runID: setup.operationRunID,
                characterID: 1,
                shipID: 11,
                systemID: 300,
                targetKey: claim.key,
                claimGeneration: claim.generation,
                observedAt: Date.now(),
                containerID,
                intentGeneration: intent.generation,
                capacityM3: 100,
                items,
              },
              facts,
            ),
          );
        }
        const issued = op.claimContainer(3, 100)!;
        assert.ok(issued && op.dispatchHaul(3, 100, issued.generation));
        const approach = op.claimContainer(3, 101, "haul", undefined, true)!;
        assert.ok(approach);
        const other = op.claimContainer(4, 102)!;
        assert.ok(other);
        assert.equal(op.claimContainer(4, 101), null);
        const before = op.snapshot().haulClaims;
        if (reason === "reconnect") {
          assert.ok(
            op.prepareRelocation(1, claim, { ...target, name: "new " + target.name }, 99, [1, 2]),
          );
          assert.ok(op.drainRelocation());
          const observedAt = Date.now();
          for (const id of [1, 2])
            assert.ok(
              op.settleMember(id, {
                source: "native-settlement",
                runID: setup.operationRunID,
                shipID: id + 10,
                modulesInactive: true,
                dronesSafe: true,
                observedAt,
              }),
            );
          assert.ok(
            op.relocateAfterSettlement(
              [1, 2].map((characterID) => ({
                characterID,
                shipID: characterID + 10,
                source: "native-flight" as const,
                systemID: 300,
                inSpace: true,
                docked: false,
                observedAt,
              })),
            ),
          );
          assert.ok(op.activate(1));
        } else op.noteStopRequest("COLLECT_FREIGHT");
        assert.deepEqual(
          op.snapshot().haulClaims,
          before,
          "Collect Freight and belt rotation preserve claims still in use",
        );
        await (a.stop as (reason?: "reconnect") => void | Promise<void>)(reason);
        assert.equal(group.entries.get(3)?.active, false);
        assert.equal(op.snapshot().haulClaims["101"], undefined);
        assert.equal(op.snapshot().manifests.find((m) => m.containerID === 101)?.delivered, false);
        assert.deepEqual(op.snapshot().haulClaims["100"], { ...issued, dispatched: true });
        assert.deepEqual(op.snapshot().haulClaims["102"], other);
        assert.ok(op.dispatchHaul(4, 102, other.generation));
        assert.ok(op.claimContainer(4, 101, "haul", undefined, true));
        assert.equal(op.dispatchHaul(3, 101, approach.generation), false);
        assert.equal(op.claimContainer(4, 100, "haul", undefined, true), null);
      } finally {
        await a.stop();
        await b.stop();
        group.requestStop();
        group.retireStoppedGroup();
      }
    },
  );

test("Collect Freight releases a partial Hauler load while a flushed Miner is still parking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const setup = {
    ...base,
    operationID: "collect-while-miner-parks",
    beltName: "collect-while-miner-parks",
  };
  const group = createMiningFleetRuntime(deps).getOrCreate(setup),
    op = group.op;
  const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
  assert.ok(claim && op.activate(1));
  const items = [
    { itemID: 29, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
  ];
  const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  const scope = {
    characterID: 1,
    shipID: 11,
    systemID: 300,
    targetKey: claim.key,
    claimGeneration: claim.generation,
    observedAt: Date.now(),
  };
  const intent = op.prepareJetcan(1, items, 100, facts, {
    ...scope,
    source: "checked-ship-holds",
    items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 134 })),
  })!;
  assert.ok(intent && op.dispatchJetcan(1, intent.generation));
  assert.ok(
    op.registerJetcan(
      {
        ...scope,
        source: "native-jetcan",
        operationID: setup.operationID,
        runID: setup.operationRunID,
        containerID: 100,
        intentGeneration: intent.generation,
        capacityM3: 100,
        items,
      },
      facts,
    ),
  );
  const haul = op.claimContainer(3, 100)!;
  assert.ok(haul && op.dispatchHaul(3, 100, haul.generation));
  const stoppedMining = {
    member: setup.members[0]!,
    active: true,
    busy: true,
    flushed: false,
    failed: null,
    expiry: Date.now() + 600000,
    run: { report() {} },
  };
  const waiting: boolean[] = [];
  group.entries.set(1, stoppedMining as any);
  group.entries.set(3, {
    member: setup.members[2]!,
    active: true,
    busy: false,
    failed: null,
    expiry: Date.now() + 600000,
    run: {
      characterID: 3,
      baseUrl: "http://bff",
      report() {},
      fetch: async () =>
        Response.json({ ok: true, flight: { shipID: 13, inSpace: true, solarSystemID: 300 } }),
    },
    session: {
      store: { station: { get: () => ({ online: { characterID: 3 } }) } },
      flow: { requestOptions: () => ({}), flying: { isSessionClosing: () => false } },
    },
    native: {
      current() {},
      async haulTrip(owned: Array<{ waitForMore(): boolean }>) {
        assert.equal(owned.length, 1);
        waiting.push(owned[0]!.waitForMore());
        return "waiting";
      },
    },
  } as any);
  const tick = async () => {
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    group.requestStop("COLLECT_FREIGHT");
    await tick();
    assert.equal(op.snapshot().state, "ACTIVE");
    stoppedMining.flushed = true;
    await tick();
    assert.equal(op.snapshot().state, "DRAINING");
    assert.deepEqual(waiting, [true, false]);
    assert.equal(stoppedMining.busy, true);
    assert.equal(op.snapshot().haulClaims["100"]?.dispatched, true);
  } finally {
    for (const e of group.entries.values()) {
      e.active = false;
      e.busy = false;
    }
    group.retireStoppedGroup();
  }
});

for (const scenario of [
  "ore",
  "empty",
  "lost reply",
  "unverified transfer",
  "division denied",
] as const)
  test(
    "Collect Freight sends Miner to delivery during Jettison cooldown: " + scenario,
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
      const setup: FleetSetup = {
        ...base,
        operationID: "collect-miner-" + scenario,
        beltName: "collect-miner-" + scenario,
        division: 2,
        delivery: {
          kind: "station",
          destinationID: 600,
          systemID: 300,
          corporationID: 77,
          division: 2,
        },
        parking: { mode: "RETURN_HOME_DOCK", destinationID: 601, kind: "station", systemID: 300 },
        members: [
          base.members[0]!,
          base.members[2]!,
          { characterID: 4, shipID: 14, role: "DEFENDER" },
        ],
      };
      const calls: string[] = [],
        docked = new Map<number, number>(),
        reports = new Map<number, { phase?: string; why?: string }>();
      if (scenario === "empty") docked.set(1, 600);
      let heldOre = scenario === "empty" ? 0 : 12,
        corpOre = 7,
        writes = 0;
      const denied = scenario === "division denied",
        unverified = scenario === "unverified transfer";
      const runtime = createMiningFleetRuntime({
        ...deps,
        settle: async (run) => {
          calls.push("settle:" + run.characterID);
          return deps.settle();
        },
      });
      const group = runtime.getOrCreate(setup),
        op = group.op;
      const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName! })!;
      assert.ok(claim && op.activate(1));
      const scope = {
        operationID: setup.operationID,
        runID: setup.operationRunID,
        targetKey: claim.key,
        claimGeneration: claim.generation,
        characterID: 1,
        shipID: 11,
        systemID: 300,
        observedAt: Date.now(),
      };
      const items = [
        { itemID: 29, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
      ];
      const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
      const prepare = () =>
        op.prepareJetcan(1, items, 100, facts, {
          ...scope,
          source: "checked-ship-holds",
          items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 134 })),
        })!;
      const intent = prepare();
      assert.ok(intent && op.dispatchJetcan(1, intent.generation));
      assert.ok(
        op.registerJetcan(
          {
            ...scope,
            source: "native-jetcan",
            containerID: 100,
            intentGeneration: intent.generation,
            capacityM3: 100,
            items,
          },
          facts,
        ),
      );
      const refused = prepare();
      assert.ok(
        refused &&
          op.dispatchJetcan(1, refused.generation) &&
          op.refuseJetcanCooldown(1, refused.generation),
      );
      const prepared = prepare();
      assert.ok(prepared);
      assert.ok(op.jetcanCooldownRemaining(1) > 0);

      let resumeMiner!: () => void, resumeHauler!: () => void;
      const minerStopping = new Promise<void>((resolve) => {
        resumeMiner = resolve;
      });
      const haulerDelivering = new Promise<void>((resolve) => {
        resumeHauler = resolve;
      });
      for (const member of setup.members) {
        const id = member.characterID;
        const run = {
          characterID: id,
          botID: "collect-during-stop-" + id,
          baseUrl: "http://bff",
          report(r: { phase?: string; why?: string }) {
            reports.set(id, r);
          },
          fetch: async (input: unknown) => {
            const url = new URL(String(input)),
              stationID = docked.get(id) ?? null;
            if (url.pathname === "/api/bridge/flight/status")
              return Response.json({
                ok: true,
                flight: {
                  shipID: member.shipID,
                  solarSystemID: 300,
                  inSpace: stationID === null,
                  docked: stationID !== null,
                  stationID,
                  shipMode: "STOP",
                  transition: { phase: "ready" },
                },
              });
            const destination = id === 3 ? 601 : 600;
            if (url.pathname === "/api/map/station/" + destination)
              return Response.json({ ok: true, station: { stationID: destination } });
            if (url.pathname === "/api/map/resolve/" + destination)
              return Response.json({
                ok: true,
                kind: "station",
                stationID: destination,
                solarSystemID: 300,
              });
            assert.equal(id, 1);
            if (url.pathname === "/api/bridge/corp-offices") {
              assert.notEqual(scenario, "empty");
              assert.equal(stationID, 600);
              assert.equal(url.search, "");
              return Response.json(officeList());
            }
            if (url.pathname === "/api/mining-operations/resources")
              return Response.json({
                ok: true,
                resources: [{ typeID: 30, family: "ore", name: "Ore" }],
              });
            if (url.pathname === "/api/client-data/dogma-types")
              return Response.json({
                ok: true,
                available: true,
                types: { 30: { categoryID: 25 } },
              });
            if (url.pathname === "/api/types/volumes")
              return Response.json({ ok: true, volumes: { 30: 1 }, capped: false });
            assert.fail("Unexpected request " + url.pathname);
          },
        };
        const session = {
          store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
          flow: {
            requestOptions: () => ({}),
            setLivePush() {},
            async startRoute(destination: number) {
              assert.equal(destination, id === 3 ? 601 : 600);
              assert.ok(calls.includes("settle:" + id));
              calls.push("route:" + id);
              return { started: true };
            },
            flying: {
              sessionGeneration: () => 1,
              isSessionClosing: () => false,
              autopilotProgress: () => ({ status: "arrived" }),
              abortAutopilot() {},
              async dockStep(destination: number) {
                calls.push("dock:" + id);
                docked.set(id, destination);
              },
              async bridgeAsk(
                service: string,
                method: string,
                _args: unknown,
                { flag } = { flag: 0 },
                locationID?: number,
              ) {
                assert.equal(id, 1);
                assert.equal(docked.get(id), 600);
                if (service === "corpRegistry")
                  return corporationRow(method, id, 77, denied ? 0n : 2097152n);
                if (service === "officeManager")
                  return { list: [{ fields: { stationID: 600, officeID: 700 } }] };
                assert.equal(service, "invbroker");
                assert.equal(method, "List");
                const row =
                  locationID === 11 && flag === 134 && heldOre > 0
                    ? { itemID: 30, quantity: heldOre, ownerID: 1 }
                    : locationID === 700 && flag === 116
                      ? { itemID: 40, quantity: corpOre, ownerID: 77 }
                      : null;
                return {
                  type: "list",
                  items: row ? [{ ...row, locationID, flagID: flag, typeID: 30 }] : [],
                };
              },
              async bridgeDo(
                service: string,
                method: string,
                args: number[],
                kwargs?: { qty: number; flag: number },
                locationID?: number,
              ) {
                if (service === "invCache") {
                  assert.equal(method, "InvalidateLocationCache");
                  return;
                }
                assert.equal(service, "invbroker");
                assert.equal(method, "Add");
                assert.equal(locationID, 700);
                assert.deepEqual(args, [30, 11]);
                assert.deepEqual(kwargs, { qty: 12, flag: 116 });
                assert.equal(docked.get(id), 600);
                assert.equal(heldOre, 12);
                writes++;
                if (!unverified) {
                  heldOre = 0;
                  corpOre += 12;
                }
                if (scenario === "lost reply" || unverified)
                  throw Object.assign(Error("Lost deposit reply"), { code: "CALL_TIMEOUT" });
              },
            },
          },
        };
        const hauler = {
          current() {},
          async haulTrip(_owned: unknown, next: any) {
            const work = await next(async () => true);
            if (!work) return "idle";
            assert.ok(work.dispatch());
            calls.push("pickup");
            await haulerDelivering;
            work.complete({
              source: "native-transfer",
              operationID: setup.operationID,
              runID: setup.operationRunID,
              containerID: 100,
              claimGeneration: work.generation,
              shipID: 13,
              destinationID: 600,
              sourceAfter: [],
              destinationBefore: [],
              destinationAfter: [{ typeID: 30, quantity: 10 }],
              observedAt: Date.now(),
            });
            return "delivered";
          },
        };
        group.entries.set(id, {
          run,
          member,
          session,
          native:
            id === 3
              ? hauler
              : {
                  current() {},
                  navigate() {
                    assert.fail("Collect Freight must not send Miner to a belt");
                  },
                  observeHolds() {
                    assert.fail("Collect Freight must not check Jettison readiness");
                  },
                  jettison() {
                    assert.fail("Collect Freight must not jettison");
                  },
                },
          startupManaged: scenario === "empty" && id === 1,
          cycle:
            id === 1
              ? {
                  async stop() {
                    calls.push("miner-stop");
                    await minerStopping;
                  },
                }
              : null,
          active: true,
          busy: false,
          failed: null,
          flushed: false,
          expiry: Date.now() + 600000,
          lease: null,
          unregister() {
            if (id === 1) {
              assert.equal(docked.get(1), 600);
              assert.equal(heldOre, 0);
            }
            calls.push("release:" + id);
          },
        } as any);
      }
      const tick = async () => {
        t.mock.timers.tick(1500);
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      try {
        group.requestStop("COLLECT_FREIGHT");
        assert.equal(op.snapshot().jetcanIntents["1"], undefined);
        assert.equal(op.dispatchJetcan(1, prepared.generation), false);
        assert.equal(prepare(), null);
        await tick();
        assert.ok(calls.includes("miner-stop") && calls.includes("pickup"));
        assert.equal(op.snapshot().manifests[0]?.delivered, false);
        resumeMiner();
        for (let i = 0; i < 8; i++) await tick();
        assert.equal(op.jetcanCooldownRemaining(1) > 0, true);
        assert.equal(docked.get(1), 600);
        assert.equal(calls.includes("route:1"), scenario !== "empty");
        assert.equal(calls.filter((x) => x === "miner-stop").length, 1);
        assert.equal(calls.filter((x) => x === "settle:1").length, 1);
        assert.equal(writes, scenario === "empty" || denied ? 0 : 1);
        assert.equal(corpOre, scenario === "empty" || denied || unverified ? 7 : 19);
        assert.equal(heldOre, denied || unverified ? 12 : 0);
        if (denied || unverified) {
          assert.equal(reports.get(1)?.phase, "Stop needs attention");
          assert.match(
            reports.get(1)?.why ?? "",
            denied
              ? /lacks verified Query access to corporation division 2/
              : /Raw deposit outcome remains unknown; no replay/,
          );
          assert.ok(!calls.includes("release:1"));
        } else assert.ok(calls.includes("release:1"));
        assert.equal(docked.get(4), 600);
        assert.ok(calls.includes("release:4"));
        assert.equal(
          op.snapshot().manifests[0]?.delivered,
          false,
          "Defender parking is independent of the Hauler",
        );
        resumeHauler();
        for (let i = 0; i < 8 && !calls.includes("release:3"); i++) await tick();
        assert.equal(op.snapshot().manifests[0]?.delivered, true);
        assert.equal(docked.get(3), 601);
        assert.ok(calls.includes("release:3"));
        assert.equal(op.snapshot().state === "STOPPED", !denied && !unverified);
      } finally {
        resumeMiner();
        resumeHauler();
        for (const e of group.entries.values()) e.active = false;
        group.retireStoppedGroup();
      }
    },
  );

for (const resumed of [false, true])
  test(`Return Home parks the current capsule ${resumed ? "after reconnect while unrelated freight is unresolved" : "alongside normal intact-ship parking"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const setup: FleetSetup = {
      ...base,
      operationID: `capsule-stop-${resumed}`,
      beltName: `capsule-belt-${resumed}`,
      parking: { mode: "RETURN_HOME_DOCK", destinationID: 601, kind: "station", systemID: 300 },
    };
    const reports: { id: number; status: string }[] = [],
      actions: string[] = [],
      docked = new Map<number, number>();
    let reattachedSession: PilotSession | undefined;
    const runtime = createMiningFleetRuntime({
      ...deps,
      attach: async () => {
        assert.ok(reattachedSession);
        return reattachedSession;
      },
      createCycle: async () =>
        assert.fail("Reconnected capsule must not reopen the destroyed ship's cycle"),
      settle: async (run) => {
        actions.push(`settle:${run.characterID}`);
        assert.notEqual(
          run.characterID,
          1,
          "The destroyed ship's modules and drones must be skipped",
        );
        return deps.settle();
      },
    });
    const group = runtime.getOrCreate(setup),
      op = group.op;
    const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName! })!;
    assert.ok(claim && op.activate(1));
    const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
    const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ];
    for (const containerID of resumed ? [100, 101] : [100]) {
      const observedAt = Date.now();
      const intent = op.prepareJetcan(2, items, 100, facts, {
        source: "checked-ship-holds",
        characterID: 2,
        shipID: 12,
        systemID: 300,
        targetKey: claim.key,
        claimGeneration: claim.generation,
        observedAt,
        items: items.map((i) => ({ ...i, ownerID: 2, locationID: 12, flagID: 134 })),
      })!;
      assert.ok(intent && op.dispatchJetcan(2, intent.generation));
      assert.ok(
        op.registerJetcan(
          {
            source: "native-jetcan",
            operationID: setup.operationID,
            runID: setup.operationRunID,
            targetKey: claim.key,
            claimGeneration: claim.generation,
            characterID: 2,
            shipID: 12,
            systemID: 300,
            containerID,
            intentGeneration: intent.generation,
            observedAt,
            capacityM3: 100,
            items,
          },
          facts,
        ),
      );
      const haul = op.claimContainer(3, containerID)!;
      assert.ok(haul && op.dispatchHaul(3, containerID, haul.generation));
      if (containerID === 100)
        assert.ok(
          op.markDelivered(3, {
            source: "native-transfer",
            operationID: setup.operationID,
            runID: setup.operationRunID,
            containerID,
            claimGeneration: haul.generation,
            shipID: 13,
            destinationID: 600,
            sourceAfter: [],
            destinationBefore: [],
            destinationAfter: [{ typeID: 30, quantity: 10 }],
            observedAt,
          }),
        );
    }
    const original = op.snapshot();
    group.requestStop("RETURN_HOME");
    op.requestStop();
    for (const member of setup.members) {
      const id = member.characterID,
        capsule = id === 1,
        shipID = capsule ? 901 : member.shipID;
      const botID = `capsule-${id}`;
      const fetcher: typeof fetch = async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/pilot-training/characters")
          return Response.json({
            ok: true,
            account: "pilot" + id,
            characters: [{ characterID: id }],
          });
        if (pathname === "/api/bots")
          return Response.json({
            ok: true,
            bots: [
              { botID, characterID: id, expiresAt: new Date(Date.now() + 600000).toISOString() },
            ],
          });
        if (pathname === "/api/bridge/flight/status") {
          const stationID = docked.get(id) ?? null;
          return Response.json({
            ok: true,
            flight: {
              shipID,
              shipIsCapsule: capsule,
              solarSystemID: 300,
              inSpace: stationID === null,
              docked: stationID !== null,
              stationID,
              shipMode: "STOP",
              transition: { phase: "ready" },
            },
          });
        }
        const destinationID = capsule ? 600 : 601;
        if (pathname === `/api/map/station/${destinationID}`)
          return Response.json({ ok: true, station: { stationID: destinationID } });
        if (pathname === `/api/map/resolve/${destinationID}`)
          return Response.json({
            ok: true,
            kind: "station",
            stationID: destinationID,
            solarSystemID: 300,
          });
        assert.fail(`Unexpected API call ${pathname}`);
      };
      const session = {
        store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          startRoute: async (destinationID: number) => {
            actions.push(`route:${id}:${destinationID}`);
            return { started: true };
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => ({ status: "arrived" }),
            dockStep: async (destinationID: number) => {
              actions.push(`dock:${id}:${destinationID}`);
              docked.set(id, destinationID);
            },
          },
        },
      };
      const run = {
        characterID: id,
        botID,
        baseUrl: "http://bff",
        fetch: fetcher,
        report: (r: { status: string }) => reports.push({ ...r, id }),
      };
      if (capsule && resumed) {
        reattachedSession = session as unknown as PilotSession;
        await runtime.runs.MINER.start({
          ...run,
          setup,
          held: { characterID: id },
          resumed: true,
        } as any);
        assert.equal(pilotServiceOwner(id, "pilot" + id)?.run.botID, botID);
        continue;
      }
      const cycle = {
        async stop() {
          actions.push(`stop:${id}`);
          assert.ok(!capsule, "Destroyed ship's fitting must not be read");
        },
        async release() {
          actions.push(`release:${id}`);
          assert.ok(!capsule, "Destroyed ship's cycle must not be closed");
        },
      };
      group.entries.set(id, {
        run,
        member,
        session,
        cycle: member.role === "MINER" ? cycle : null,
        native: {},
        active: true,
        busy: resumed && id === 3,
        failed: null,
        flushed: false,
        expiry: Date.now() + 600000,
        lease: null,
        unregister() {
          actions.push(`unregister:${id}`);
        },
      } as any);
    }
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(1500);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const after = op.snapshot();
    assert.deepEqual(
      actions.filter((x) => x.split(":")[1] === "1"),
      ["route:1:600", "dock:1:600", ...(resumed ? [] : ["unregister:1"])],
    );
    assert.deepEqual(
      actions.filter((x) => x.split(":")[1] === "2"),
      ["stop:2", "settle:2", "route:2:601", "dock:2:601", "release:2", "unregister:2"],
    );
    assert.ok(
      after.parked.includes(1) &&
        after.settled.includes(1) &&
        reports.some((r) => r.id === 1 && r.status === "stopped"),
    );
    assert.equal(group.entries.get(1)?.active, false);
    if (resumed) assert.equal(pilotServiceOwner(1, "pilot1"), null);
    assert.deepEqual(after.members, original.members);
    assert.deepEqual(after.manifests, original.manifests);
    assert.deepEqual(after.haulClaims, original.haulClaims);
    assert.equal(after.state, resumed ? "DRAINING" : "STOPPED");
  });
const hullLayers = (shipID: number, hullRatio: number) => ({
  type: "dict",
  entries: [
    [
      shipID,
      {
        type: "object",
        name: "util.KeyVal",
        args: {
          type: "dict",
          entries: [
            ["hullRatio", { type: "real", value: hullRatio }],
            ["hullMax", { type: "real", value: 1000 }],
            ["armorRatio", { type: "real", value: 0.2 }],
          ],
        },
      },
    ],
  ],
});

test("hull ratio uses the exact ship and preserves native numeric wire forms and unknown values", () => {
  const layers = (max: JsonValue, ratio: JsonValue): JsonValue => ({
    type: "dict",
    entries: [
      [12, hullLayers(12, 1).entries[0]![1] as JsonValue],
      [
        { type: "long", value: "11" },
        {
          type: "object",
          name: "util.KeyVal",
          args: {
            type: "dict",
            entries: [
              ["hullMax", max],
              ["hullRatio", ratio],
            ],
          },
        },
      ],
    ],
  });
  assert.equal(readHullRatio(hullLayers(11, 0.94) as JsonValue, 11), 0.94);
  assert.equal(readHullRatio(layers({ type: "long", value: "1000" }, "0.6"), 11), 0.6);
  assert.equal(readHullRatio(layers(1000, { type: "real", value: "0" }), 11), 0);
  assert.equal(readHullRatio(layers(1000, "1"), 12), 1);
  assert.equal(readHullRatio(layers(1000, "1"), 99), null);
  for (const [max, ratio] of [
    [null, "0.6"],
    [0, "0.6"],
    ["invalid", "0.6"],
    [1000, 1.1],
    [1000, ".95"],
    [1000, null],
  ])
    assert.equal(readHullRatio(layers(max ?? null, ratio ?? null), 11), null);
  assert.equal(readHullRatio(null, 11), null);
});

for (const outcome of [
  "resume on new belt",
  "repair refused",
  "repair unverified",
  "operator Stop during quote",
  "corporate-funded repair",
  "corporate wallet insufficient",
  "corporate transfer unconfirmed",
] as const)
  test("MCC hull policy uses native thresholds and handles " + outcome, async (t) => {
    const relocates = outcome === "resume on new belt";
    t.mock.timers.enable(
      relocates ? { apis: ["setInterval"] } : { apis: ["setInterval", "Date"], now: 100000 },
    );
    const members: Member[] = [...base.members, { characterID: 4, shipID: 14, role: "DEFENDER" }];
    if (!relocates) members.push({ characterID: 5, shipID: 15, role: "COMMAND" });
    const setup: FleetSetup = {
      ...base,
      operationID: "hull-" + outcome,
      beltName: "hull-original-" + outcome,
      members,
      ...(!relocates
        ? {
            command: {},
            supportPolicy: {
              maintainBursts: false,
              useIndustrialCore: false,
              coreRequirement: "continueWithoutCore" as const,
              enableCompression: false,
              selfMining: false,
              tractor: false,
              collection: "TRACTOR_ONLY" as const,
              compressCollectedOre: false,
              supportLoss: "CONTINUE_UNSUPPORTED" as const,
            },
          }
        : {}),
      fleetPolicy: "MANAGED",
      parking: { mode: "RETURN_HOME_DOCK", destinationID: 600, kind: "station", systemID: 300 },
    };
    const hull = new Map([
      [1, 0.95],
      [2, 1],
      [3, 0.59],
      [4, 0.94],
      [5, 0.6],
    ]);
    const damage = new Map([
      [3, 410],
      [4, 60],
      [5, 400],
    ]);
    const repairDock = (id: number) => (id === 3 ? 600 : 601);
    const hullReads = new Map<number, number>();
    const docked = new Map<number, number>(),
      ore = new Map<number, number>(),
      hauling: string[] = [],
      escortReturns: string[] = [];
    const pursuing = new Set([4]);
    const parkedNearest: number[] = [],
      quotes: number[] = [],
      payments = new Map<number, unknown[][]>(),
      released: number[] = [];
    const corporateRepair = outcome.startsWith("corporate");
    const moneyError = (amount: number, balance: number) =>
      Object.assign(Error("NotEnoughMoney"), {
        code: "CALL_REFUSED",
        status: 409,
        refusal: {
          key: "NotEnoughMoney",
          values: {
            type: "dict",
            entries: [
              ["amount", amount],
              ["balance", balance],
            ],
          },
        },
      });
    let personal = 20,
      withdrawals = 0;
    let walletEntry: unknown = null;
    const reports: { id: number; status: string; why: string }[] = [];
    let finishQuote!: () => void,
      depleted = false;
    const quoteReady = new Promise<void>((resolve) => {
      finishQuote = resolve;
    });
    const runtime = createMiningFleetRuntime({
      ...deps,
      createCycle: async (run) => ({
        async tick() {
          ore.set(run.characterID, (ore.get(run.characterID) ?? 0) + 10);
          return "yield" as const;
        },
        async stop() {},
      }),
      park: async (_run, session, _progress, current) => {
        current();
        const id = session.store.station.get().online!.characterID;
        assert.ok(!pursuing.has(id), "Clear a Defender's native chase before withdrawal");
        parkedNearest.push(id);
        docked.set(id, 601);
        return { destinationID: 601, kind: "station", systemID: 300 };
      },
      createDefender: ({ run, target }) => ({
        async navigate() {
          const id = run.characterID;
          if (!docked.has(id)) return;
          assert.ok(hull.get(id)! >= 0.95, "Escort cannot resume until hull is verified");
          docked.delete(id);
          escortReturns.push(targetKey(target));
        },
        readyToEscort: async () => true,
        focus: () => null,
        tick: async () => "responding",
        stop: async () => {},
        warning: () => null,
        repairStatus: () => null,
        droneIDs: () => [],
      }),
    });
    const group = runtime.getOrCreate(setup),
      op = group.op;
    const original = op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName! })!;
    assert.ok(original && op.activate(1));
    for (const member of members) {
      const id = member.characterID;
      const flight = () => ({
        shipID: member.shipID,
        shipIsCapsule: false,
        solarSystemID: 300,
        inSpace: !docked.has(id),
        docked: docked.has(id),
        stationID: docked.get(id) ?? null,
        shipMode: pursuing.has(id) ? "FOLLOW" : "STOP",
        transition: {
          phase: "ready",
          sessionStable: true,
          locationReady: true,
          sceneReady: true,
          egoReady: true,
          shipReady: true,
          boundContextReady: true,
        },
      });
      const run = {
        characterID: id,
        botID: "hull-" + outcome + "-" + id,
        baseUrl: "http://bff",
        report: (r: { status: string; why: string }) => reports.push({ ...r, id }),
        fetch: async (input: unknown) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/bridge/flight/status")
            return Response.json({ ok: true, flight: flight() });
          if (path === "/api/client-data/system-objects/300")
            return Response.json({
              ok: true,
              available: true,
              objects: [
                { itemID: 99, groupID: 9 },
                { itemID: 100, groupID: 9 },
              ],
            });
          if (path === "/api/names")
            return Response.json({
              ok: true,
              names: { "evelocation:99": setup.beltName, "evelocation:100": "hull-next" },
            });
          if (path === "/api/bridge/space/snapshot")
            return Response.json({
              ok: true,
              space: {
                inSpace: true,
                solarSystemID: 300,
                shipID: member.shipID,
                sampledAtMs: Date.now(),
                ship: {
                  itemID: member.shipID,
                  characterID: id,
                  mode: "STOP",
                  radius: 10,
                  position: { x: 0, y: 0, z: 0 },
                },
                entities: [
                  {
                    itemID: 100,
                    kind: "celestial",
                    groupID: 9,
                    name: "hull-next",
                    radius: 10,
                    position: { x: 100, y: 0, z: 0 },
                  },
                ],
              },
            });
          if (path === "/api/map/station/600")
            return Response.json({ ok: true, station: { stationID: 600 } });
          if (path === "/api/map/resolve/600")
            return Response.json({ ok: true, kind: "station", stationID: 600, solarSystemID: 300 });
          assert.fail("Unexpected native route " + path);
        },
      };
      const session = {
        store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          stopShip: async () => {
            pursuing.delete(id);
          },
          startRoute: async (target: number) => {
            assert.equal(target, 600);
            docked.delete(id);
            return { started: true };
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => ({ status: "arrived" }),
            dockStep: async (target: number) => {
              docked.set(id, target);
            },
            bridgeAsk: async (service: string, method: string, args: unknown[]) => {
              if (service === "account") {
                assert.equal(id, 3);
                if (method === "GetCashBalance") {
                  assert.deepEqual(args, [0]);
                  return personal;
                }
                assert.equal(method, "GetTransactions");
                assert.deepEqual(args, [1000, null, null, false]);
                return { type: "list", items: walletEntry ? [walletEntry] : [] };
              }
              assert.deepEqual(args, [[member.shipID]]);
              if (method === "GetLayerDamageValuesByItems") {
                assert.equal(service, "dogmaIM");
                hullReads.set(id, (hullReads.get(id) ?? 0) + 1);
                return hullLayers(member.shipID, hull.get(id)!);
              }
              assert.equal(method, "GetRepairQuotes");
              assert.equal(service, "repairSvc");
              assert.ok(damage.has(id));
              assert.equal(docked.get(id), repairDock(id));
              quotes.push(id);
              await quoteReady;
              const part = (itemID: number, damage: number) => ({
                type: "packedrow",
                fields: { itemID, damage, maxHealth: 1000, costToRepairOneUnitOfDamage: 2 },
              });
              return {
                type: "dict",
                entries: [
                  [
                    member.shipID,
                    { type: "list", items: [part(member.shipID, damage.get(id)!), part(700, 10)] },
                  ],
                ],
              };
            },
            bridgeDo: async (
              service: string,
              method: string,
              args: unknown[],
              kwargs?: { toAccountKey: null; reason: string },
              of?: number,
            ) => {
              if (service === "account") {
                assert.equal(method, "GiveCashFromCorpAccount");
                assert.equal(of, 77);
                assert.deepEqual(args, [3, 800, 1000]);
                assert.equal(kwargs?.toAccountKey, null);
                withdrawals++;
                if (outcome === "corporate wallet insufficient") throw moneyError(800, 100);
                if (outcome === "corporate transfer unconfirmed") return null;
                walletEntry = {
                  type: "packedrow",
                  fields: {
                    transactionID: 155,
                    description: kwargs?.reason,
                    ownerID1: 77,
                    ownerID2: 3,
                    amount: 800,
                  },
                };
                personal += 800;
                throw Object.assign(Error("Transfer reply lost after credit"), {
                  code: "CALL_TIMEOUT",
                });
              }
              assert.equal(service, "repairSvc");
              assert.equal(docked.get(id), repairDock(id));
              payments.set(id, [...(payments.get(id) ?? []), [method, args]]);
              if (id === 3 && corporateRepair && personal < 820) throw moneyError(820, personal);
              if (id === 3 && corporateRepair) personal -= 820;
              if (id === 3 && outcome === "repair refused")
                throw Error("The station repair service refused payment.");
              if (id === 4 && outcome === "repair unverified") return null;
              hull.set(id, id === 4 ? 0.95 : 1);
              if (id === 3) throw Error("Repair response lost after payment.");
              return null;
            },
          },
        },
      };
      const native =
        member.role === "MINER"
          ? {
              current() {},
              navigate: async () => {},
              async mineCycle() {
                if (depleted) return "depleted";
                ore.set(id, (ore.get(id) ?? 0) + 10);
                return "yield";
              },
            }
          : member.role === "HAULER"
            ? {
                current() {},
                async haulTrip() {
                  assert.fail("No freight to collect in the repair fixture.");
                },
                async waitAtBelt(target: Target, _claim: unknown, current: () => void) {
                  current();
                  assert.equal(target.kind, "BELT");
                  hauling.push((target as Extract<Target, { kind: "BELT" }>).name);
                  docked.delete(id);
                },
              }
            : {};
      group.entries.set(id, {
        run,
        session,
        member,
        generation: 1,
        active: true,
        busy: false,
        failed: null,
        flushed: false,
        native,
        cycle: member.role === "MINER" ? { async stop() {} } : null,
        selfUnload: null,
        lease: null,
        expiry: Date.now() + 600000,
        navigation:
          member.role === "COMMAND"
            ? {
                async navigate() {
                  docked.delete(id);
                },
              }
            : undefined,
        unregister() {
          released.push(id);
        },
      } as any);
    }
    const turns = async (n: number) => {
      for (let i = 0; i < n; i++) {
        t.mock.timers.tick(1500);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    try {
      await turns(24);
      const damagedPilots = relocates ? [3, 4] : [3, 4, 5];
      assert.deepEqual(
        [...parkedNearest].sort(),
        damagedPilots.slice(1),
        "94% and 60% use the nearest dock",
      );
      assert.deepEqual([...quotes].sort(), damagedPilots);
      assert.deepEqual(
        damagedPilots.map((id) => docked.get(id)),
        damagedPilots.map(repairDock),
        "59% uses the delivery station",
      );
      assert.equal(escortReturns.length, 0);
      assert.equal(op.snapshot().stopRequested, undefined);
      assert.ok((ore.get(1) ?? 0) > 0, "95% hull remains productive despite low armor");
      const priorOre = ore.get(1)!;
      if (relocates) {
        depleted = true;
        await turns(8);
        assert.equal(op.assignment(3)?.claim?.key, "BELT:300:hull-next");
      }
      if (outcome === "operator Stop during quote") group.requestStop("RETURN_HOME");
      const haulingBeforeRepair = hauling.length,
        defenderReadsBeforeRepair = hullReads.get(4)!;
      finishQuote();
      await turns(12);
      if (outcome === "operator Stop during quote") {
        assert.equal(payments.size, 0);
        assert.equal(hauling.length, haulingBeforeRepair);
        assert.deepEqual(escortReturns, []);
        assert.equal(op.snapshot().state, "STOPPED");
        assert.ok(members.every((m) => released.includes(m.characterID)));
      } else {
        assert.deepEqual([...payments.keys()].sort(), damagedPilots);
        for (const id of damagedPilots) {
          const payment = ["RepairItemsInStation", [[id + 10], damage.get(id)! * 2]];
          assert.deepEqual(
            payments.get(id),
            id === 3 && outcome === "corporate-funded repair" ? [payment, payment] : [payment],
          );
        }
        assert.equal(withdrawals, corporateRepair ? 1 : 0);
        assert.deepEqual(
          [...parkedNearest].sort(),
          damagedPilots.slice(1),
          "A repaired pilot does not retreat again",
        );
        assert.equal(op.snapshot().state, "ACTIVE");
        assert.ok(ore.get(1)! > priorOre, "A healthy Miner continues working");
        if (
          outcome === "repair refused" ||
          outcome === "corporate wallet insufficient" ||
          outcome === "corporate transfer unconfirmed"
        ) {
          assert.equal(hauling.length, haulingBeforeRepair);
          assert.deepEqual(released, [3]);
          const expected =
            outcome === "repair refused"
              ? "repair service refused payment"
              : outcome === "corporate wallet insufficient"
                ? "Master Wallet has insufficient ISK"
                : "funding was not confirmed";
          assert.ok(
            reports.some((r) => r.id === 3 && r.status === "stopped" && r.why.includes(expected)),
          );
        } else {
          assert.equal(hull.get(3), 1);
          assert.ok(
            hauling.slice(haulingBeforeRepair).includes(relocates ? "hull-next" : setup.beltName!),
          );
          assert.deepEqual(released, outcome === "repair unverified" ? [4] : []);
        }
        if (outcome === "repair unverified") {
          assert.deepEqual(escortReturns, []);
          assert.equal(docked.get(4), 601);
          assert.ok(
            reports.some(
              (r) =>
                r.id === 4 &&
                r.status === "stopped" &&
                r.why.includes("did not confirm restored hull integrity"),
            ),
          );
        } else {
          assert.deepEqual(escortReturns, [
            "BELT:300:" + (relocates ? "hull-next" : setup.beltName),
          ]);
          assert.equal(docked.has(4), false);
          if (!relocates)
            assert.ok(
              hullReads.get(4)! > defenderReadsBeforeRepair + 1,
              "A later 95% read keeps the Defender working",
            );
        }
      }
    } finally {
      finishQuote();
      for (const e of group.entries.values()) e.active = false;
      group.requestStop();
      group.retireStoppedGroup();
    }
  });

test("the hosted capsule parking path records exact fleet losses and excludes the belt", (t) =>
  checkCapsuleParking(t, "available"),
);
test("verified capsule docking can finish when the loss-history read is retired", (t) =>
  checkCapsuleParking(t, "retired"),
);
test("capsule parking finishes after the two bounded loss-history reads time out", (t) =>
  checkCapsuleParking(t, "timeout"),
);

async function checkCapsuleParking(t: TestContext, history: "available" | "retired" | "timeout") {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_000 });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (history !== "timeout" || ms !== 2_000) return nativeTimeout(ms);
    const caller = new AbortController();
    setTimeout(() => caller.abort(new DOMException("Loss-history deadline", "TimeoutError")), ms);
    return caller.signal;
  });
  const setup = {
    ...base,
    operationID: "capsule-parking-" + history,
    beltName: "Loss history " + history,
  };
  const target = { kind: "BELT" as const, systemID: setup.systemID, name: setup.beltName };
  const seen = Date.now(),
    opKey = JSON.stringify([setup.operationID, setup.operationRunID]);
  const store = document("mining-fleet-telemetry:" + opKey),
    targetKeyValue = targetKey(target);
  store.write({
    version: 1,
    operationID: setup.operationID,
    runID: setup.operationRunID,
    startedAt: seen,
    stoppedAt: null,
    observedAt: seen,
    members: [],
    history: [
      {
        kind: "TARGET_SELECTION",
        at: new Date(seen).toISOString(),
        target: {
          targetType: "BELT",
          targetName: target.name,
          targetKey: targetKeyValue,
          claimedByOperationID: setup.operationID,
          systemID: 300,
        },
        evidence: null,
      },
    ],
  });
  const runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup),
    op = group.op;
  const claim = op.reserve(1, target)!;
  assert.ok(op.activate(1));
  const log: Record<number, string[]> = {},
    reports: Record<number, string> = {};
  for (const member of setup.members) {
    const id = member.characterID,
      botID = "wipe-" + id,
      capsule = 900 + id;
    log[id] = [];
    const run = {
      botID,
      characterID: id,
      held: { characterID: id },
      baseUrl: "http://fixture",
      report: (r: { status: string; why?: string }) => {
        reports[id] = r.status + (r.status === "paused" ? " " + r.why : "");
      },
      fetch: async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: capsule,
              shipIsCapsule: true,
              shipTypeID: 670,
              solarSystemID: 300,
              inSpace: false,
              docked: true,
              stationID: 600,
              transition: { phase: "ready" },
            },
          });
        if (path === "/api/bridge/call") {
          const body = JSON.parse(String(init?.body));
          log[id]!.push(body.method);
          assert.deepEqual(
            [body.service, body.method, body.args, body.pilot],
            ["charMgr", "GetRecentShipKillsAndLosses", [25, null], true],
          );
          if (history === "retired")
            return Response.json({ ok: false, error: "SESSION_REQUEST_RETIRED" }, { status: 409 });
          if (history === "timeout") {
            const signal = init?.signal;
            assert.ok(signal);
            signal.throwIfAborted();
            return new Promise<Response>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return Response.json({
            ok: true,
            service: body.service,
            method: body.method,
            result: {
              type: "list",
              items: [
                {
                  type: "object",
                  name: "util.KeyVal",
                  args: {
                    type: "dict",
                    entries: Object.entries({
                      killID: 100 + id,
                      solarSystemID: 300,
                      victimCharacterID: id,
                      victimShipTypeID: 597,
                      killTime: {
                        type: "long",
                        value: String(BigInt(seen + 500 + id) * 10000n + 116444736000000000n),
                      },
                    }),
                  },
                },
              ],
            },
          });
        }
        if (path === "/api/map/station/600")
          return Response.json({ ok: true, station: { stationID: 600 } });
        if (path === "/api/map/resolve/600")
          return Response.json({ ok: true, kind: "station", stationID: 600, solarSystemID: 300 });
        assert.fail("Unexpected API call " + path);
      },
    };
    const session = {
      store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        async startRoute() {
          assert.fail("A verified dock needs no route");
        },
        flying: {
          bridgeAsk: testPilotSession(id, run).flow.flying.bridgeAsk,
          sessionGeneration: () => 1,
          isSessionClosing: () => false,
          abortAutopilot() {},
          autopilotProgress: () => ({ status: "arrived" }),
          async dockStep() {
            assert.fail("A verified dock needs no Dock command");
          },
        },
      },
    };
    group.entries.set(id, {
      run,
      session,
      member,
      active: true,
      emergency: false,
      busy: false,
      failed: null,
      flushed: false,
      deployedAt: seen,
      lastShip: { shipTypeID: 597, at: seen },
      generation: 1,
      expiry: seen + 600_000,
      unregister() {},
    } as any);
  }
  group.requestStop("RETURN_HOME");
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const attempts = history === "timeout" ? 2 : 1;
  for (const m of setup.members)
    assert.deepEqual(log[m.characterID], Array(attempts).fill("GetRecentShipKillsAndLosses"));
  const deadlines = timeout.mock.calls.filter((call) => call.arguments[0] === 2_000);
  assert.equal(deadlines.length, attempts * setup.members.length);
  assert.deepEqual(reports, { 1: "stopped", 2: "stopped", 3: "stopped" });
  assert.equal((store.read() as any).shipLosses?.length ?? 0, history === "available" ? 3 : 0);
  assert.equal(runtime.targetSnapshot()[claim.key]?.state === "DANGEROUS", history === "available");
  assert.equal(op.snapshot().stopFreight, "RETURN_HOME");
}

for (const kind of ["BELT", "ORE_ANOMALY", "ICE"] as const)
  test(`ten of thirteen losses on ${kind} mark the target and return the survivors home`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_800_000_000_000 });
    const { beltID, beltName: _, ...rest } = base;
    const name = "Fleet wipe " + kind;
    const target: Target =
      kind === "BELT"
        ? { kind, systemID: 300, name }
        : {
            kind,
            systemID: 300,
            name,
            siteID: 55,
            instanceID: kind === "ICE" ? 90 : 89,
            position: { x: 1, y: 2, z: 3 },
          };
    const targetSetup =
      target.kind === "BELT"
        ? { beltID, beltName: name }
        : {
            site: {
              target,
              label: name,
              scannerKey: 55,
              instanceID: target.instanceID!,
              archetypeID: target.kind === "ICE" ? (28 as const) : (27 as const),
              observedAt: Date.now(),
            },
          };
    const members: Member[] = Array.from({ length: 13 }, (_, i) => ({
      characterID: i + 1,
      shipID: i + 11,
      role: i < 8 ? "MINER" : i < 12 ? "DEFENDER" : "HAULER",
    }));
    const setup: FleetSetup = {
      ...rest,
      ...targetSetup,
      members,
      operationID: "wipe-return-" + kind,
    };
    const key = targetKey(target),
      seen = Date.now(),
      identity = { operationID: setup.operationID, operationRunID: setup.operationRunID };
    const store = document(
      "mining-fleet-telemetry:" + JSON.stringify([setup.operationID, setup.operationRunID]),
    );
    store.write({
      version: 1,
      operationID: setup.operationID,
      runID: setup.operationRunID,
      startedAt: seen,
      stoppedAt: null,
      observedAt: seen,
      members: [],
      history: [
        {
          kind: "TARGET_SELECTION",
          at: new Date(seen).toISOString(),
          target: {
            targetKey: key,
            targetType: kind,
            targetName: name,
            systemID: 300,
            claimedByOperationID: setup.operationID,
          },
          evidence: null,
        },
      ],
    });
    const parked: number[] = [],
      settled = new Set<number>(),
      losses = new Set<number>();
    let mining = 0,
      releaseMine!: () => void,
      minePaused = false,
      depletionPending = false;
    const pendingMine = new Promise<void>((resolve) => {
      releaseMine = resolve;
    });
    const runtime = createMiningFleetRuntime({
      ...deps,
      park: async (_run, session, _report, current) => {
        current();
        parked.push(session.store.station.get().online!.characterID);
        return { destinationID: 600, systemID: 300, kind: "station" };
      },
    });
    const group = runtime.getOrCreate(setup),
      op = group.op;
    const saved = runtime.retainedSetup(identity.operationID, identity.operationRunID);
    assert.ok(op.reserve(1, target));
    assert.ok(op.activate(1));
    for (const m of members) {
      const id = m.characterID,
        capsule = 900 + id;
      const run = {
        botID: "wipe-" + kind + "-" + id,
        characterID: id,
        baseUrl: "http://fixture",
        report(info: { status: string }) {
          if (info.status === "stopped") settled.add(id);
        },
        async fetch(input: unknown, init?: RequestInit) {
          const path = new URL(String(input)).pathname;
          if (path === "/api/bridge/flight/status") {
            const lost = losses.has(id);
            return Response.json({
              ok: true,
              flight: {
                shipID: lost ? capsule : m.shipID,
                shipIsCapsule: lost,
                shipTypeID: lost ? 670 : 597,
                solarSystemID: 300,
                inSpace: !lost,
                docked: lost,
                stationID: lost ? 600 : null,
                transition: { phase: "ready" },
              },
            });
          }
          if (path === "/api/bridge/call") {
            const body = JSON.parse(String(init?.body));
            if (body.service === "dogmaIM" && body.method === "GetLayerDamageValuesByItems")
              return Response.json({ ok: true, result: { type: "list", items: [] } });
            assert.deepEqual([body.service, body.method], ["charMgr", "GetRecentShipKillsAndLosses"]);
            assert.ok(losses.has(id));
            return Response.json({
              ok: true,
              service: body.service,
              method: body.method,
              result: {
                type: "list",
                items: [
                  {
                    type: "object",
                    name: "util.KeyVal",
                    args: {
                      type: "dict",
                      entries: Object.entries({
                        killID: 100 + id,
                        solarSystemID: 300,
                        victimCharacterID: id,
                        victimShipTypeID: 597,
                        killTime: {
                          type: "long",
                          value: String(BigInt(seen + id) * 10000n + 116444736000000000n),
                        },
                      }),
                    },
                  },
                ],
              },
            });
          }
          if (path === "/api/map/station/600")
            return Response.json({ ok: true, station: { stationID: 600 } });
          if (path === "/api/map/resolve/600")
            return Response.json({ ok: true, kind: "station", stationID: 600, solarSystemID: 300 });
          assert.fail("Unexpected read " + path);
        },
      };
      const session = {
        store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => ({ status: "arrived" }),
            bridgeAsk: testPilotSession(id, run).flow.flying.bridgeAsk,
          },
        },
      };
      const native = {
        current() {},
        navigate: async () => {},
        observeHolds: async () => ({ items: [] }),
        async mineCycle() {
          mining++;
          if (minePaused && id === 8) {
            depletionPending = true;
            await pendingMine;
            return "depleted";
          }
          return "blocked";
        },
      };
      group.entries.set(id, {
        run,
        session,
        member: m,
        active: true,
        emergency: false,
        busy: false,
        failed: null,
        flushed: false,
        native,
        cycle: null,
        deployedAt: seen,
        lastShip: { shipTypeID: 597, at: seen },
        generation: 1,
        expiry: seen + 600_000,
        unregister() {},
      } as any);
    }
    const lose = (ids: number[]) => {
      for (const id of ids) {
        losses.add(id);
        group.entries.get(id)!.emergency = true;
      }
    };
    async function advance(done: () => boolean) {
      for (let i = 0; i < 18 && !done(); i++) {
        t.mock.timers.tick(1500);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.ok(
        done(),
        JSON.stringify(
          [...group.entries.values()].map((e) => [
            e.member.characterID,
            e.telemetry?.phase,
            e.failed,
          ]),
        ),
      );
    }
    t.after(() => {
      releaseMine();
      for (const e of group.entries.values()) e.active = false;
      group.retireStoppedGroup();
    });
    lose([9, 10, 11, 12]);
    await advance(() => settled.size === 4);
    assert.ok(mining > 0);
    assert.equal(op.snapshot().stopRequested, undefined);
    assert.equal(runtime.targetSnapshot()[key]?.state, "ACTIVE");
    lose([1, 2, 3, 4, 5]);
    await advance(() => settled.size === 9);
    assert.equal(op.snapshot().stopRequested, undefined);
    assert.equal(runtime.targetSnapshot()[key]?.state, "ACTIVE");
    if (kind === "ICE") assert.equal(group.requestStop("COLLECT_FREIGHT"), "COLLECT_FREIGHT");
    if (kind === "BELT") minePaused = true;
    lose([6]);
    await advance(() => op.snapshot().stopFreight === "RETURN_HOME");
    assert.equal(runtime.targetSnapshot()[key]?.state, "DANGEROUS");
    if (kind === "BELT")
      assert.ok(depletionPending, "the in-flight mining pass will report depletion after the wipe");
    const turns = mining;
    releaseMine();
    await advance(() => op.snapshot().state === "STOPPED" && settled.size === 13);
    assert.equal(mining, turns);
    assert.deepEqual(
      parked.sort((a, b) => a - b),
      [7, 8, 13],
    );
    assert.equal(op.snapshot().claim, null);
    assert.equal(runtime.targetSnapshot()[key]?.state, "DANGEROUS");
    assert.equal(runtime.targetSnapshot()[key]?.claim, null);
    assert.deepEqual(runtime.retainedSetup(identity.operationID, identity.operationRunID), saved);
  });

for (const incident of [
  "damaged Miner with no repair quote",
  "capsule after hull loss during retreat",
  "capsule first observed on grid",
])
  test(`individual emergency parks the ${incident} and the fleet keeps working`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100000 });
    const lostShip = incident !== "damaged Miner with no repair quote",
      alreadyCapsule = incident === "capsule first observed on grid";
    const members = [
      ...base.members,
      { characterID: 4, shipID: 14, role: "MINER" as const },
      { characterID: 5, shipID: 15, role: "MINER" as const },
      { characterID: 6, shipID: 16, role: "DEFENDER" as const },
    ];
    const setup = {
      ...base,
      operationID: "individual-retreat-" + incident,
      beltName: "retreat-belt-" + incident,
      members,
    };
    const docked = new Map<number, number>(),
      ore = new Map<number, number>(),
      reports: { id: number; status: string; phase: string }[] = [],
      actions: string[] = [];
    const ship = new Map(members.map((m) => [m.characterID, m.shipID]));
    if (alreadyCapsule) ship.set(1, 901);
    let resumeRetreat!: () => void,
      escortTurns = 0,
      jettisons = 0;
    const retreat = new Promise<void>((resolve) => {
      resumeRetreat = resolve;
    });
    const runtime = createMiningFleetRuntime({
      ...deps,
      settle: async (run) => {
        assert.notEqual(
          run.characterID,
          1,
          "Withdrawing Miner must not wait on old fitting settlement",
        );
        return deps.settle();
      },
      park: async (_run, session, _report, current) => {
        const id = session.store.station.get().online!.characterID;
        if (id === 1) {
          actions.push("retreat:1");
          await retreat;
          if (lostShip) {
            ship.set(1, 901);
            throw Error("Held ship changed during Parking.");
          }
        }
        current();
        const destinationID = id === 1 ? 601 : 600;
        docked.set(id, destinationID);
        return { destinationID, kind: "station" as const, systemID: 300 };
      },
      createDefender: () => ({
        async navigate() {},
        async readyToEscort() {
          return true;
        },
        focus: () => null,
        async tick() {
          escortTurns++;
          return "responding";
        },
        async stop() {
          actions.push("escort-stop");
        },
        warning: () => null,
        repairStatus: () => null,
        droneIDs: () => [],
      }),
    });
    const group = runtime.getOrCreate(setup),
      op = group.op;
    const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
    assert.ok(claim && op.activate(1));
    const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ];
    for (const member of members) {
      const id = member.characterID,
        botID = `retreat-${incident}-${id}`;
      const run = {
        characterID: id,
        botID,
        held: { characterID: id },
        baseUrl: "http://bff",
        report: (r: { status: string; phase: string }) => reports.push({ ...r, id }),
        fetch: async (input: unknown) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/bridge/flight/status") {
            const stationID = docked.get(id) ?? null,
              shipID = ship.get(id);
            return Response.json({
              ok: true,
              flight: {
                shipID,
                shipIsCapsule: shipID === 901,
                solarSystemID: 300,
                inSpace: stationID === null,
                docked: stationID !== null,
                stationID,
                shipMode: "STOP",
                transition: { phase: "ready" },
              },
            });
          }
          if (path === "/api/map/station/600")
            return Response.json({ ok: true, station: { stationID: 600 } });
          if (path === "/api/map/resolve/600")
            return Response.json({ ok: true, kind: "station", stationID: 600, solarSystemID: 300 });
          assert.fail("Unexpected API call " + path);
        },
      };
      const session = {
        store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          startRoute: async (destinationID: number) => {
            actions.push(`route:${id}:${destinationID}`);
            if (alreadyCapsule && id === 1) await retreat;
            return { started: true };
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => ({ status: "arrived" }),
            bridgeAsk: async (_service: string, method: string) =>
              method === "GetRepairQuotes"
                ? { type: "dict", entries: [] }
                : hullLayers(ship.get(id)!, id === 1 ? 0.949 : 0.95),
            dockStep: async (destinationID: number) => {
              actions.push(`dock:${id}:${destinationID}`);
              docked.set(id, destinationID);
            },
          },
        },
      };
      const navigate =
        alreadyCapsule && id === 1
          ? createNativeBeltNavigation(run, session as unknown as PilotSession, {
              shipID: member.shipID,
              beltID: 99,
              current: () => {},
            }).navigate
          : async () => {};
      const miner: Partial<import("./memberLoops.ts").RawMinerNative> = {
        current() {},
        navigate,
        async mineCycle(_target, _claim, ready, _arrival, drop) {
          ore.set(id, (ore.get(id) ?? 0) + 10);
          if (id === 2 && jettisons === 0 && ready) assert.equal(await drop!(items), true);
          return "yield";
        },
        async jettison(ids) {
          assert.equal(id, 2);
          assert.deepEqual(ids, [20]);
          jettisons++;
        },
      };
      const hauler: Partial<import("./memberLoops.ts").RawHaulerNative> = {
        current() {},
        async waitAtBelt() {},
        async observeGridJetcans(_target, _claim, _excluded, _pending, available, publish) {
          if (jettisons && available(100, 2))
            await publish({
              containerID: 100,
              ownerID: 2,
              observedAt: Date.now(),
              capacityM3: 100,
              items,
            });
        },
        async haulTrip(_owned, next, destinationID) {
          const work = await next(async () => true);
          if (!work) return "idle";
          assert.ok(work.dispatch());
          work.complete({
            source: "native-transfer",
            operationID: setup.operationID,
            runID: setup.operationRunID,
            containerID: work.manifest.containerID,
            claimGeneration: work.generation,
            shipID: member.shipID,
            destinationID,
            sourceAfter: [],
            destinationBefore: [],
            destinationAfter: [{ typeID: 30, quantity: 10 }],
            observedAt: Date.now(),
          });
          return "delivered";
        },
      };
      const native = member.role === "MINER" ? miner : member.role === "HAULER" ? hauler : {};
      const cycle =
        member.role === "MINER"
          ? {
              async stop() {
                assert.notEqual(id, 1, "Emergency must skip the old mining cycle");
              },
              async release() {
                assert.notEqual(id, 1, "Emergency must not reopen the old mining journal");
              },
            }
          : null;
      group.entries.set(id, {
        run,
        member,
        session,
        cycle,
        native,
        selfUnload: null,
        generation: 1,
        active: true,
        busy: false,
        failed: null,
        flushed: false,
        expiry: Date.now() + 600000,
        lease: null,
        unregister() {
          actions.push("release:" + id);
        },
      } as any);
    }
    const turn = async (n: number) => {
      for (let i = 0; i < n; i++) {
        t.mock.timers.tick(1500);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    try {
      await turn(4);
      assert.deepEqual(actions, alreadyCapsule ? ["route:1:600"] : ["retreat:1"]);
      assert.equal(op.snapshot().state, "ACTIVE");
      assert.equal(op.snapshot().stopRequested, undefined);
      assert.equal(op.snapshot().stopFreight, undefined);
      assert.ok([2, 4, 5].every((id) => (ore.get(id) ?? 0) > 0));
      assert.equal(escortTurns, 4);
      assert.equal(jettisons, 1);
      const receipts = runtime
        .deliveryReceiptIndex(setup.operationID)
        .map(
          ({ runID, containerID }) =>
            runtime.deliveryReceipt(setup.operationID, runID, containerID)?.receipt,
        );
      assert.equal(receipts?.length, 1);
      assert.deepEqual(receipts[0]?.destinationAfter, [{ typeID: 30, quantity: 10 }]);

      resumeRetreat();
      await turn(3);
      assert.equal(docked.get(1), lostShip ? 600 : 601);
      assert.deepEqual(
        actions,
        lostShip
          ? [...(alreadyCapsule ? [] : ["retreat:1"]), "route:1:600", "dock:1:600", "release:1"]
          : ["retreat:1", "release:1"],
      );
      assert.deepEqual(op.snapshot().parked, [1]);
      assert.equal(op.snapshot().state, "ACTIVE");
      assert.equal(group.telemetrySnapshot().stopRequested, false);
      assert.ok(
        reports.some(
          (r) =>
            r.id === 1 &&
            r.phase === (lostShip ? "Emergency dock" : "Parked after hull retreat") &&
            r.status === "stopped",
        ),
      );
      assert.ok(
        members
          .filter((m) => m.characterID !== 1)
          .every((m) => group.entries.get(m.characterID)?.active),
      );
      assert.ok(escortTurns > 4);

      assert.equal(
        runtime.requestOperationStop(
          { operationID: setup.operationID, operationRunID: setup.operationRunID },
          "RETURN_HOME",
        ).mode,
        "RETURN_HOME",
      );
      await turn(12);
      assert.equal(op.snapshot().state, "STOPPED");
      assert.equal(op.snapshot().parked.length, members.length);
      assert.ok([...group.entries.values()].every((entry) => !entry.active));
      assert.deepEqual(
        runtime
          .deliveryReceiptIndex(setup.operationID)
          .map(
            ({ runID, containerID }) =>
              runtime.deliveryReceipt(setup.operationID, runID, containerID)?.receipt,
          ),
        receipts,
      );
      assert.equal(actions.filter((x) => x === "release:1").length, 1);
      assert.ok(actions.includes("escort-stop"));
    } finally {
      resumeRetreat();
      for (const entry of group.entries.values()) entry.active = false;
      group.requestStop();
    }
  });

test("a trusted Stop race does not poison the miner before final flush", async () => {
  const setup = { ...base, operationID: "stop-before-dispatch-race" },
    runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => ({ destinationID: 600, kind: "station" as const, systemID: 300 }),
    });
  const group = runtime.getOrCreate(setup),
    reports: any[] = [],
    cycleStops = new Set<number>();
  let intercepted = false;
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: "belt" }));
  assert.equal(group.op.activate(1), true);
  for (const m of setup.members) {
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        flying: { isSessionClosing: () => false },
        setLivePush() {},
      },
    };
    const native: any = {
      current() {},
      async navigate() {
        if (m.characterID === 1 && !intercepted) {
          intercepted = true;
          group.requestStop();
          throw new FleetStopBeforeDispatch();
        }
      },
      async mineCycle() {
        return "blocked";
      },
      async observeHolds() {
        return {
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        };
      },
      async navigateAndVerify() {},
      async transferAndDeliver() {
        throw Error("unexpected");
      },
    };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        baseUrl: "http://bff",
        fetch: async () =>
          Response.json({
            ok: true,
            flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
          }),
        report: (r: any) => reports.push(r),
      },
      session,
      member: m,
      cycle: {
        stop: async () => {
          cycleStops.add(m.characterID);
        },
        tick: async () => "blocked",
      },
      native,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (
    let i = 0;
    i < 120 &&
    (group.op.snapshot().state !== "STOPPED" ||
      reports.filter((r) => r.status === "stopped").length !== 3);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(intercepted, true);
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.deepEqual([...cycleStops].sort(), [1, 2]);
  assert.equal(reports.filter((r) => r.status === "stopped").length, 3);
});

test("hosted roster waits for a real common fleet before any productive cycle", async () => {
  let cycles = 0;
  const setup = { ...base, operationID: "native-fleet-barrier" };
  const reports: any[] = [];
  const fetchFor =
    (characterID: number, shipID: number, botID: string): typeof fetch =>
    async (input) => {
      const path = new URL(String(input)).pathname;
      let body: any;
      if (path === "/api/pilot-training/characters")
        body = { account: `pilot${characterID}`, characters: [{ characterID }] };
      else if (path === "/api/bots")
        body = {
          bots: [{ botID, characterID, expiresAt: new Date(Date.now() + 600000).toISOString() }],
        };
      else if (path === "/api/bridge/flight/status")
        body = { flight: { shipID, inSpace: true, solarSystemID: 300 } };
      else if (path === "/api/bridge/bound-fleet")
        body = {
          characterID,
          fleetID: null,
          reads: Object.fromEntries(
            ["GetInitState", "GetWings", "GetMotd", "GetJoinRequests", "GetFleetComposition"].map(
              (k) => [k, { error: "CALL_REFUSED", message: "FleetNotFound" }],
            ),
          ),
        };
      else throw Error(`unexpected ${path}`);
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) =>
      ({
        store: {
          station: {
            get: () => ({ online: { characterID: run.held.characterID, corporationID: 77 } }),
          },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
    createCycle: async () => ({
      tick: async () => {
        cycles++;
        return "blocked" as const;
      },
      stop: async () => {},
    }),
  });
  const handles = [];
  for (const m of setup.members) {
    const botID = `barrier-${m.characterID}`;
    handles.push(
      await runtime.runs[m.role as "MINER" | "HAULER"].start({
        botID,
        characterID: m.characterID,
        setup,
        held: { characterID: m.characterID },
        baseUrl: "http://bff",
        fetch: fetchFor(m.characterID, m.shipID, botID),
        resumed: false,
        resumeData: null,
        routeSettings: null,
        report: (r: any) => reports.push(r),
      } as any),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(cycles, 0);
  assert.equal(runtime.getOrCreate(setup).op.snapshot().state, "READY");
  assert.ok(reports.some((r) => r.phase === "Waiting for fleet"));
  for (const h of handles) await h.stop();
});
test("hosted Stop recovers a temporary GamePort failure and verifies parking before terminal success", async () => {
  const setup = { ...base, operationID: "stop-lifecycle" },
    reports: any[] = [];
  let cyclesStarted = 0,
    cycleStops = 0,
    outage = true;
  docs.set(`mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`, {
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      [
        [1, 11, "stop-1"],
        [2, 12, "stop-2"],
        [3, 13, "stop-3"],
      ],
    ]),
    leaderID: 1,
    fleetID: 900,
    pending: null,
    joined: [1, 2, 3],
  });
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fleet = keyval([
    ["fleetID", 900],
    [
      "members",
      {
        type: "dict",
        entries: setup.members.map((m) => [m.characterID, keyval([["charID", m.characterID]])]),
      },
    ],
  ]);
  const fetchFor =
    (characterID: number, shipID: number, botID: string): typeof fetch =>
    async (input) => {
      const path = new URL(String(input)).pathname;
      let body: any;
      if (path === "/api/pilot-training/characters")
        body = { account: `p${characterID}`, characters: [{ characterID }] };
      else if (path === "/api/bots")
        body = {
          bots: [{ botID, characterID, expiresAt: new Date(Date.now() + 600000).toISOString() }],
        };
      else if (path === "/api/bridge/flight/status")
        body = {
          flight: {
            shipID,
            inSpace: true,
            solarSystemID: 300,
            shipMode: "STOP",
            transition: {
              phase: "ready",
              sessionStable: true,
              locationReady: true,
              sceneReady: true,
              egoReady: true,
              shipReady: true,
              boundContextReady: true,
            },
          },
        };
      else if (path === "/api/bridge/bound-fleet")
        body = { fleetID: 900, reads: { GetInitState: { result: fleet } } };
      else if (path === "/api/bridge/space/snapshot")
        body = {
          space: {
            inSpace: true,
            solarSystemID: 300,
            shipID,
            sampledAtMs: Date.now(),
            ship: {
              itemID: shipID,
              characterID,
              mode: "STOP",
              radius: 10,
              position: { x: 0, y: 0, z: 0 },
            },
            entities: [
              {
                itemID: 99,
                kind: "celestial",
                groupID: 9,
                name: "belt",
                radius: 10,
                position: { x: 100, y: 0, z: 0 },
              },
            ],
          },
        };
      else if (path === "/api/client-data/dogma-types")
        body = { available: true, types: { 23: { attributes: [[38, 27500]] } } };
      else if (path === "/api/mining-operations/resources")
        body = { resources: [{ typeID: 30, family: "ore", name: "ore" }] };
      else throw Error(`unexpected ${path}`);
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) =>
      ({
        store: {
          station: {
            get: () => ({ online: { characterID: run.held.characterID, corporationID: 77 } }),
          },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeDo: async () => null,
            bridgeAsk: async () => ({ type: "list", items: [] }),
          },
        },
      }) as any,
    createCycle: async (run) => {
      cyclesStarted++;
      return {
        tick: async () => "blocked" as const,
        stop: async () => {
          if (run.characterID === 1 && outage) {
            outage = false;
            throw Object.assign(Error("Native effect read timed out"), { code: "CALL_TIMEOUT" });
          }
          cycleStops++;
        },
      };
    },
    park: async () => ({ destinationID: 600, kind: "station" as const, systemID: 300 }),
  });
  const group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName! }));
  assert.ok(group.op.activate(1));
  const handles = [];
  for (const m of setup.members) {
    const botID = `stop-${m.characterID}`;
    handles.push(
      await runtime.runs[m.role as "MINER" | "HAULER"].start({
        botID,
        characterID: m.characterID,
        setup,
        held: { characterID: m.characterID },
        baseUrl: "http://bff",
        fetch: fetchFor(m.characterID, m.shipID, botID),
        resumed: false,
        resumeData: null,
        routeSettings: null,
        report: (r: any) => reports.push(r),
      } as any),
    );
  }
  for (let i = 0; i < 60 && cyclesStarted < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cyclesStarted, 2);
  group.requestStop();
  for (let i = 0; i < 120 && reports.filter((r) => r.status === "stopped").length !== 3; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(cycleStops, 2);
  assert.ok(reports.some((r) => r.phase === "Retrying Stop"));
  assert.equal(reports.filter((r) => r.status === "stopped").length, 3);
  for (const h of handles) await h.stop();
});
for (const scenario of [
  "deadline",
  "manual",
  "recall fallback",
  "route refused",
  "unload unconfirmed",
] as const)
  test(
    "configured Return Home uses the exact dock and verifies unload on " + scenario,
    async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
      const home = 600,
        homeSystem = 301,
        office = 700;
      const delivery = {
        kind: "station" as const,
        destinationID: home,
        systemID: homeSystem,
        corporationID: 77,
        division: 1,
      };
      const setup = {
        ...base,
        operationID: "return-home-" + scenario,
        beltName: "return-home-" + scenario,
        delivery,
        parking: { mode: "RETURN_HOME_UNLOAD_DOCK" as const, ...delivery },
      };
      const routes: number[][] = [],
        stopped: number[] = [],
        settledMining: number[] = [];
      const reports = new Map<number, { phase?: string; why?: string }>();
      const holds = new Map([
          [1, 12],
          [2, 0],
          [3, 20],
        ]),
        writes: number[] = [];
      let corporateOre = 0,
        nearest = 0;
      const runtime = createMiningFleetRuntime({
        ...deps,
        park: async () => {
          nearest++;
          return { kind: "station", destinationID: 602, systemID: 300 };
        },
        settle: async (run, _session, _current, options) => {
          if (
            scenario === "recall fallback" &&
            run.characterID === 2 &&
            !routes.some(([id]) => id === 2)
          ) {
            assert.ok(options?.parkAfterRecallFailure);
            await options.parkAfterRecallFailure();
          }
          return { modulesInactive: true, dronesSafe: true, observedAt: Date.now() };
        },
      });
      const group = runtime.getOrCreate(setup),
        op = group.op;
      assert.ok(op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
      assert.ok(op.activate(1));
      for (const member of setup.members) {
        const id = member.characterID,
          shipID = member.shipID,
          itemID = 100 + id;
        let stationID: number | null = id === 1 ? 601 : id === 3 ? home : null;
        let systemID = id === 1 ? 300 : id === 3 ? homeSystem : 302;
        const run = {
          characterID: id,
          botID: setup.operationID + "-" + id,
          baseUrl: "http://bff",
          report(r: { phase?: string; why?: string; status?: string }) {
            reports.set(id, r);
            if (r.status === "stopped") {
              assert.equal(stationID, home);
              assert.equal(holds.get(id), 0);
              stopped.push(id);
            }
          },
          async fetch(input: unknown) {
            const path = new URL(String(input)).pathname;
            if (path === "/api/bridge/flight/status")
              return Response.json({
                ok: true,
                flight: {
                  shipID,
                  solarSystemID: systemID,
                  inSpace: stationID === null,
                  docked: stationID !== null,
                  stationID,
                  shipMode: "STOP",
                  transition: { phase: "ready" },
                },
              });
            if (path === "/api/map/graph")
              return Response.json({
                ok: true,
                systems: { 300: "Mining", 301: "Home", 302: "Outlying" },
                edges: [
                  [300, 301, 50, 51],
                  [302, 300, 52, 53],
                ],
              });
            if (path === "/api/map/station/" + home)
              return Response.json({ ok: true, station: { stationID: home } });
            if (path === "/api/map/resolve/" + home)
              return Response.json({
                ok: true,
                kind: "station",
                stationID: home,
                solarSystemID: homeSystem,
              });
            if (path === "/api/bridge/corp-offices") return Response.json(officeList([home]));
            if (path === "/api/mining-operations/resources")
              return Response.json({
                ok: true,
                resources: [{ typeID: 30, family: "ore", name: "Ore" }],
              });
            if (path === "/api/client-data/dogma-types")
              return Response.json({
                ok: true,
                available: true,
                types: { 30: { categoryID: 25 } },
              });
            if (path === "/api/types/volumes")
              return Response.json({ ok: true, volumes: { 30: 1 }, capped: false });
            assert.fail("Unexpected request " + path);
          },
        };
        const session = {
          store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
          flow: {
            setLivePush() {},
            requestOptions: () => ({}),
            async startRoute(destination: number) {
              routes.push([id, destination]);
              if (scenario === "route refused" && id === 2)
                return { started: false, reason: "destination route unavailable" };
              assert.equal(destination, home);
              stationID = null;
              systemID = homeSystem;
              return { started: true };
            },
            flying: {
              isSessionClosing: () => false,
              abortAutopilot() {},
              autopilotProgress: () => ({ status: "arrived" }),
              async dockStep(destination: number) {
                assert.equal(systemID, homeSystem);
                stationID = destination;
              },
              async bridgeAsk(
                service: string,
                method: string,
                _args: unknown,
                { flag } = { flag: 0 },
                locationID?: number,
              ) {
                assert.equal(stationID, home);
                if (service === "corpRegistry") return corporationRow(method, id, 77);
                if (service === "officeManager")
                  return { list: [{ fields: { stationID: home, officeID: office } }] };
                assert.deepEqual([service, method], ["invbroker", "List"]);
                const quantity = holds.get(id) ?? 0;
                const row =
                  locationID === shipID && flag === 134 && quantity > 0
                    ? { itemID, quantity, ownerID: id }
                    : locationID === office && flag === 115 && corporateOre > 0
                      ? { itemID: 500, quantity: corporateOre, ownerID: 77 }
                      : null;
                return {
                  type: "list",
                  items: row ? [{ ...row, locationID, flagID: flag, typeID: 30 }] : [],
                };
              },
              async bridgeDo(
                service: string,
                method: string,
                args: number[],
                kwargs?: { qty: number; flag: number },
                inventoryID?: number,
              ) {
                if (service === "invCache") {
                  assert.equal(method, "InvalidateLocationCache");
                  return;
                }
                assert.equal(stationID, home);
                assert.deepEqual(
                  [service, method, args, kwargs, inventoryID],
                  ["invbroker", "Add", [itemID, shipID], { qty: holds.get(id), flag: 115 }, office],
                );
                writes.push(id);
                if (scenario === "unload unconfirmed" && id === 3) return;
                corporateOre += holds.get(id) ?? 0;
                holds.set(id, 0);
              },
            },
          },
        };
        group.entries.set(id, {
          member,
          run,
          session,
          active: true,
          busy: false,
          failed: null,
          flushed: false,
          startupManaged: id === 1,
          leftStartupDock: false,
          lease: null,
          unregister() {},
          expiry: Date.now() + (scenario === "manual" ? 600_000 : 181_000),
          cycle:
            member.role === "MINER"
              ? {
                  async stop() {
                    settledMining.push(id);
                  },
                }
              : null,
        } as any);
      }
      t.after(() => {
        for (const entry of group.entries.values()) entry.active = false;
        group.retireGroup();
      });
      if (scenario === "manual") group.requestStop("RETURN_HOME");
      for (let turn = 0; turn < (scenario === "unload unconfirmed" ? 24 : 12); turn++) {
        t.mock.timers.tick(1500);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(op.snapshot().stopFreight, "RETURN_HOME");
      assert.equal(nearest, 0);
      assert.deepEqual(
        routes.sort((a, b) => a[0]! - b[0]!),
        [
          [1, home],
          [2, home],
        ],
      );
      assert.deepEqual(
        settledMining.sort((a, b) => a - b),
        [1, 2],
      );
      assert.deepEqual(
        writes.sort((a, b) => a - b),
        [1, 3],
        JSON.stringify([...reports]),
      );
      const blocked =
        scenario === "route refused" ? 2 : scenario === "unload unconfirmed" ? 3 : null;
      assert.equal(op.snapshot().state, blocked ? "PARKING" : "STOPPED");
      assert.deepEqual(
        stopped.sort((a, b) => a - b),
        [1, 2, 3].filter((id) => id !== blocked),
      );
      assert.equal(corporateOre, scenario === "unload unconfirmed" ? 12 : 32);
      if (blocked !== null) {
        assert.ok(!op.snapshot().parked.includes(blocked));
        assert.equal(reports.get(blocked)?.phase, "Stop needs attention");
        assert.match(
          reports.get(blocked)?.why ?? "",
          scenario === "route refused"
            ? /destination route unavailable/
            : /still in the ship's hold.*Last verified aboard: 20 ore units/i,
        );
        if (blocked === 3) assert.equal(holds.get(3), 20);
      }
    },
  );
test("incomplete roster Stop releases an already docked member without a new route or a terminal fleet receipt", async () => {
  const setup = { ...base, operationID: "partial-stop" },
    reports: any[] = [];
  let parked = 0;
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) =>
      ({
        store: {
          station: {
            get: () => ({ online: { characterID: run.held.characterID, corporationID: 77 } }),
          },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
    park: async () => {
      parked++;
      return { destinationID: 600, kind: "station" as const, systemID: 300 };
    },
  });
  const botID = "partial-1",
    fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const body =
        path === "/api/pilot-training/characters"
          ? { account: "pilot1", characters: [{ characterID: 1 }] }
          : path === "/api/bridge/flight/status"
            ? { flight: { shipID: 11, docked: true, stationID: 601, solarSystemID: 300 } }
            : {
                bots: [
                  { botID, characterID: 1, expiresAt: new Date(Date.now() + 600000).toISOString() },
                ],
              };
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
  const handle = await runtime.runs.MINER.start({
      botID,
      characterID: 1,
      setup,
      held: { characterID: 1 },
      baseUrl: "http://bff",
      fetch: fetcher,
      resumed: false,
      resumeData: null,
      routeSettings: null,
      report: (r: any) => reports.push(r),
    } as any),
    group = runtime.getOrCreate(setup);
  group.requestStop();
  for (let i = 0; i < 60 && !reports.some((r) => r.status === "stopped"); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(parked, 0);
  assert.equal(group.op.snapshot().state, "READY");
  assert.match(reports.find((r) => r.status === "stopped")?.why ?? "", /launch remains incomplete/);
  assert.ok(group.retireStoppedGroup());
  await handle.stop();
});
test("loss of one active member parks remaining safe pilots without releasing target custody", async () => {
  const setup = { ...base, operationID: "lost-member", beltName: "lost-member belt" };
  let parked = 0;
  const runtime = createMiningFleetRuntime({
    ...deps,
    park: async () => {
      parked++;
      return { destinationID: 600, kind: "station" as const, systemID: 300 };
    },
  });
  const group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.equal(group.op.activate(1), true);
  for (const m of setup.members) {
    const online = { characterID: m.characterID, corporationID: 77 },
      session: any = {
        store: { station: { get: () => ({ online }) } },
        flow: {
          requestOptions: () => ({}),
          flying: { isSessionClosing: () => false },
          setLivePush() {},
        },
      };
    const native: any = {
      current() {},
      navigate: async () => {},
      observeHolds: async () => ({
        items: [],
        source: {},
        facts: {},
        existingContainerIDs: [],
        sceneSampledAt: Date.now(),
        capacityM3: 100,
      }),
    };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        baseUrl: "http://bff",
        fetch: async () =>
          Response.json({
            ok: true,
            flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
          }),
        report() {},
      },
      session,
      member: m,
      cycle: { stop: async () => {}, tick: async () => "blocked" },
      native,
      active: m.characterID !== 2,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 95 && [1, 3].some((id) => group.entries.get(id)?.active); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(parked, 2);
  assert.deepEqual([...group.op.snapshot().parked].sort(), [1, 3]);
  assert.ok([1, 3].every((id) => !group.entries.get(id)?.active));
  assert.equal(group.op.snapshot().state, "SETTLING");
  assert.ok(group.op.snapshot().claim);
});

async function exerciseHostedAssembly(
  scenario: "join" | "stop" | "refused",
  t: import("node:test").TestContext,
) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
  const turn = async () => {
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const stopAtInvite = scenario === "stop";
  const setup = { ...base, operationID: "hosted-assembly-" + scenario, beltName: "different belt" },
    fleet = new Set<number>(),
    pending = new Map<number, any>(),
    calls: any[] = [],
    assemblyReports: any[] = [];
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fetchFor =
    (id: number, ship: number, botID: string): typeof fetch =>
    async (input) => {
      const path = new URL(String(input)).pathname;
      let body: any;
      if (path === "/api/pilot-training/characters")
        body = { account: `p${id}`, characters: [{ characterID: id }] };
      else if (path === "/api/bots")
        body = {
          bots: [
            { botID, characterID: id, expiresAt: new Date(Date.now() + 600000).toISOString() },
          ],
        };
      else if (path === "/api/bridge/flight/status")
        body = {
          flight: {
            shipID: ship,
            inSpace: false,
            docked: true,
            stationID: 601,
            solarSystemID: 300,
          },
        };
      else if (path === "/api/bridge/bound-fleet")
        body = fleet.has(id)
          ? {
              fleetID: 900,
              reads: {
                GetInitState: {
                  result: keyval([
                    ["fleetID", 900],
                    [
                      "members",
                      {
                        type: "dict",
                        entries: [...fleet].map((n) => [n, keyval([["charID", n]])]),
                      },
                    ],
                  ]),
                },
              },
            }
          : {
              fleetID: null,
              reads: Object.fromEntries(
                [
                  "GetInitState",
                  "GetWings",
                  "GetMotd",
                  "GetJoinRequests",
                  "GetFleetComposition",
                ].map((k) => [k, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
              ),
            };
      else throw Error(`unexpected ${path}`);
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
  const runtime = createMiningFleetRuntime({
    ...deps,
    park: async () => {
      throw Error("No departure took place.");
    },
    attach: async (run) => {
      const id = run.held.characterID;
      return {
        store: {
          station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) },
          fleet: { get: () => ({ pendingInvite: pending.get(id) ?? null }) },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            async bridgeDo(
              service: string,
              method: string,
              args: any[],
              _kw: unknown,
              of: unknown,
            ) {
              calls.push([id, service, method, args, of]);
              if (method === "CreateFleet") {
                fleet.add(id);
                return null;
              }
              if (method === "Invite") {
                if (!stopAtInvite)
                  pending.set(args[0], { fleetID: 900, inviterID: id, receivedAtMs: Date.now() });
                return null;
              }
              if (method === "AcceptInvite") {
                assert.equal(of, 900);
                if (scenario === "refused" && id === 2)
                  throw Object.assign(Error("FleetTooManyMembers"), { code: "CALL_REFUSED" });
                fleet.add(id);
                pending.delete(id);
                return null;
              }
              throw Error("unexpected native write");
            },
          },
        },
      } as any;
    },
  });
  const handles = [];
  for (const m of setup.members) {
    const botID = setup.operationID + "-" + m.characterID;
    handles.push(
      await runtime.runs[m.role as "MINER" | "HAULER"].start({
        botID,
        characterID: m.characterID,
        setup,
        held: { characterID: m.characterID },
        baseUrl: "http://bff",
        fetch: fetchFor(m.characterID, m.shipID, botID),
        resumed: false,
        resumeData: null,
        routeSettings: null,
        report(r: any) {
          assemblyReports.push({ ...r, id: m.characterID });
        },
      } as any),
    );
  }
  const group = runtime.getOrCreate(setup);
  if (stopAtInvite) {
    for (let i = 0; i < 12 && !calls.some((x) => x[2] === "Invite"); i++) await turn();
    assert.ok(calls.some((x) => x[2] === "Invite"));
    group.requestStop();
    for (let i = 0; i < 12 && assemblyReports.filter((x) => x.status === "stopped").length < 3; i++)
      await turn();
    assert.deepEqual(
      calls.map((x) => x[2]),
      ["CreateFleet", "Invite"],
    );
    assert.equal(group.op.snapshot().state, "STOPPED");
    assert.equal(assemblyReports.filter((x) => x.status === "stopped").length, 3);
    assert.equal(assemblyReports.filter((x) => x.phase === "Stopping startup").length, 3);
  } else if (scenario === "refused") {
    for (let i = 0; i < 20; i++) await turn();
    assert.deepEqual([...fleet], [1, 3]);
    assert.equal(group.op.snapshot().claim, null);
    assert.equal(calls.filter((x) => x[0] === 2 && x[2] === "AcceptInvite").length, 2);
    const lastReport = assemblyReports.filter((x) => x.id === 2).at(-1);
    assert.equal(lastReport?.phase, "Fleet admission needs attention");
    assert.equal(lastReport?.why, "Fleet acceptance refused: FleetTooManyMembers");
    const sent = calls.length;
    group.requestStop();
    for (let i = 0; i < 12 && group.op.snapshot().state !== "STOPPED"; i++) await turn();
    assert.equal(group.op.snapshot().state, "STOPPED");
    assert.equal(calls.length, sent);
  } else {
    for (let i = 0; i < 30 && !group.op.snapshot().claim; i++) await turn();
    assert.equal(
      group.op.snapshot().claim?.key,
      "BELT:300:different belt",
      JSON.stringify({ calls, assemblyReports }),
    );
    assert.equal(group.op.snapshot().state, "READY");
    assert.deepEqual(
      calls.map((x) => x[2]),
      ["CreateFleet", "Invite", "AcceptInvite", "Invite", "AcceptInvite"],
    );
    assert.deepEqual(
      calls.filter((x) => x[2] === "Invite").map((x) => [x[0], x[3], x[4]]),
      [
        [1, [2, null, null, null], 900],
        [1, [3, null, null, null], 900],
      ],
    );
  }
  for (const handle of handles) await handle.stop();
}
test("hosted three-run fleet assembly issues the stock native calls and waits for observed roster", (t) =>
  exerciseHostedAssembly("join", t));
test("Stop while a native invitation is pending settles all held pilots at their current docks", (t) =>
  exerciseHostedAssembly("stop", t));
test("a final native fleet refusal stays visible for its pilot and does not prevent Stop", (t) =>
  exerciseHostedAssembly("refused", t));

test("MCC verifies CreateFleet before the selected leader leaves dock, without holding another pilot at anchor", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
  const setup = { ...base, operationID: "formation-before-undock" },
    events: string[] = [];
  const members = new Set<number>(),
    locations = new Map([
      [1, 301],
      [2, 301],
      [3, 300],
    ]);
  let releaseCreate!: () => void;
  const creating = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const kv = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) => {
      const id = run.held.characterID;
      return {
        store: {
          station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            async bridgeDo(_service: string, method: string) {
              if (method === "CreateFleet") {
                assert.equal(id, 1);
                assert.equal(locations.get(id), 301);
                events.push("CreateFleet");
                await creating;
                members.add(id);
                return;
              }
              if (method !== "Invite") throw new Error("unexpected native action");
            },
          },
        },
      } as any;
    },
    anchor: async (run) => {
      if (run.characterID === 1) assert.ok(members.has(1));
      events.push("Undock:" + run.characterID);
      locations.set(run.characterID, 300);
      return "arrived";
    },
  });
  const handles = [];
  try {
    for (const m of setup.members) {
      const botID = "formation-" + m.characterID;
      const fetch = async (input: URL) => {
        const url = new URL(input),
          id = m.characterID;
        if (url.pathname === "/api/pilot-training/characters")
          return Response.json({ ok: true, account: "p" + id, characters: [{ characterID: id }] });
        if (url.pathname === "/api/bots")
          return Response.json({
            ok: true,
            bots: [
              { botID, characterID: id, expiresAt: new Date(Date.now() + 600000).toISOString() },
            ],
          });
        if (url.pathname === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: m.shipID,
              docked: true,
              inSpace: false,
              stationID: 600,
              solarSystemID: locations.get(id),
            },
          });
        if (url.pathname === "/api/bridge/bound-fleet") {
          assert.equal(url.searchParams.get("view"), "menu");
          return Response.json(
            members.has(id)
              ? {
                  ok: true,
                  fleetID: 900,
                  reads: {
                    GetInitState: {
                      result: kv([
                        ["fleetID", 900],
                        ["members", { type: "dict", entries: [[id, kv([["charID", id]])]] }],
                      ]),
                    },
                  },
                }
              : { ok: true, membership: "none", fleetID: null, reads: {} },
          );
        }
        return Response.json({ ok: false, error: "not used in this scenario" }, { status: 503 });
      };
      handles.push(
        await runtime.runs[m.role as "MINER" | "HAULER"].start({
          botID,
          characterID: m.characterID,
          setup,
          held: { characterID: m.characterID },
          baseUrl: "http://bff",
          fetch,
          resumed: false,
          report() {},
        } as any),
      );
    }
    const step = async () => {
      t.mock.timers.tick(1500);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    for (let i = 0; i < 8 && !events.includes("CreateFleet"); i++) await step();
    assert.ok(events.includes("CreateFleet"));
    assert.ok(events.includes("Undock:2"));
    assert.ok(!events.includes("Undock:1"));
    releaseCreate();
    for (let i = 0; i < 10 && !events.includes("Undock:1"); i++) await step();
    assert.ok(events.indexOf("Undock:1") > events.indexOf("CreateFleet"));
  } finally {
    releaseCreate();
    for (const handle of handles) await handle.stop();
  }
});

async function exerciseAnchorStop(t: import("node:test").TestContext, lostOwner: boolean) {
  const members = [
    base.members[2]!,
    base.members[0]!,
    base.members[1]!,
    { characterID: 4, shipID: 14, role: "DEFENDER" as const },
  ];
  const setup = {
      ...base,
      operationID: lostOwner ? "lost-anchor-owner" : "parallel-anchor",
      members,
      fleetPolicy: "EXISTING_ONLY" as const,
    },
    routes: number[] = [],
    stopped: number[] = [],
    parked: number[] = [],
    reports: any[] = [];
  const sleep = () => new Promise((r) => setTimeout(r, 50));
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fleet = {
    fleetID: 900,
    reads: {
      GetInitState: {
        result: keyval([
          ["fleetID", 900],
          [
            "members",
            {
              type: "dict",
              entries: members.map((m) => [m.characterID, keyval([["charID", m.characterID]])]),
            },
          ],
        ]),
      },
    },
  };
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) =>
      ({
        store: {
          station: {
            get: () => ({ online: { characterID: run.held.characterID, corporationID: 77 } }),
          },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
    createDefender: () => assert.fail("Anchor travel must not start Defender combat."),
    anchor: async (run, _session, config) => {
      routes.push(run.characterID);
      while (!config.stopRequested()) await sleep();
      if (config.stopRequested()) {
        if (lostOwner && run.characterID === 2) {
          config.document.write({ pending: { issuedAt: Date.now() } });
          throw Error("Original anchor owner ended.");
        }
        stopped.push(run.characterID);
        return "stopped";
      }
      return "arrived";
    },
    park: async (_run, session) => {
      parked.push(session.store.station.get().online!.characterID);
      return { destinationID: 600, kind: "station", systemID: 300 };
    },
  });
  t.after(() => runtime.shutdown());
  for (const m of members) {
    const id = m.characterID,
      botID = setup.operationID + "-" + id,
      fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/pilot-training/characters")
          return Response.json({
            ok: true,
            account: "parallel-" + id,
            characters: [{ characterID: id }],
          });
        if (path === "/api/bots")
          return Response.json({
            ok: true,
            bots: [
              { botID, characterID: id, expiresAt: new Date(Date.now() + 600000).toISOString() },
            ],
          });
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: m.shipID,
              solarSystemID: routes.includes(id) ? 300 : 301,
              docked: !routes.includes(id),
              inSpace: routes.includes(id),
              stationID: routes.includes(id) ? null : 601,
            },
          });
        if (path === "/api/bridge/bound-fleet") return Response.json({ ok: true, ...fleet });
        throw Error(path);
      };
    await runtime.runs[m.role].start({
      botID,
      characterID: id,
      setup,
      held: { characterID: id },
      baseUrl: "http://bff",
      fetch: fetcher,
      resumed: false,
      report: (r: any) => reports.push({ ...r, id }),
    } as any);
  }
  const group = runtime.getOrCreate(setup);
  try {
    for (let i = 0; i < 100 && routes.length < 4; i++) await sleep();
    assert.deepEqual([...routes].sort(), [1, 2, 3, 4]);
    assert.equal(group.op.snapshot().state, "READY");
  } finally {
    if (lostOwner) group.entries.get(2)!.active = false;
    group.requestStop();
  }
  const finished = lostOwner ? [1, 3, 4] : [1, 2, 3, 4];
  for (
    let i = 0;
    i < 240 && reports.filter((r) => r.status === "stopped").length < finished.length;
    i++
  )
    await sleep();
  assert.deepEqual(stopped.sort(), lostOwner ? [1, 3, 4] : [1, 2, 3, 4]);
  assert.deepEqual(parked.sort(), finished);
  assert.equal(group.op.snapshot().state, lostOwner ? "SETTLING" : "STOPPED");
  assert.deepEqual([...group.op.snapshot().parked].sort(), finished);
  assert.ok(reports.some((r) => r.id === 3 && r.phase === "Stopping startup"));
  assert.equal(reports.filter((r) => r.status === "stopped").length, finished.length);
}
test("all anchor routes start concurrently; Stop settles all started routes", (t) =>
  exerciseAnchorStop(t, false));
test("a missing anchor owner leaves its route retained and healthy startup peers park", (t) =>
  exerciseAnchorStop(t, true));

function startupFleet(
  t: import("node:test").TestContext,
  operationID: string,
  preparation?: {
    prepareMember?: import("./runtime.ts").FleetRuntimeDependencies["prepareMember"];
    wrongShip?: number;
  },
) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const members: Member[] = Array.from({ length: 15 }, (_, i) => ({
    characterID: i + 1,
    shipID: i + 21,
    role: i < 8 ? "MINER" : i < 12 ? "DEFENDER" : "HAULER",
  }));
  const defender = 12,
    rallyDock = 601;
  const { corporationID, division, ...personal } = base;
  const setup: FleetSetup = {
    ...(preparation ? personal : base),
    operationID,
    operationRunID: "start",
    beltName: operationID + " belt",
    members,
    fleetPolicy: "EXISTING_ONLY",
    ...(preparation
      ? {
          destinationID: rallyDock,
          delivery: {
            kind: "station",
            destinationID: rallyDock,
            systemID: 300,
            corporationID: null,
            division: null,
          },
          startupPreparation: preparation.prepareMember
            ? [
                {
                  characterID: defender,
                  preparation: {
                    source: { kind: "hangar" },
                    fittingID: 100,
                    suppliesRequired: false,
                  },
                },
              ]
            : [],
        }
      : {}),
  };
  const events: { event: string; id: number; at: number }[] = [],
    reports: { id: number; phase: string | null; why: string | null; status: string }[] = [];
  const states = new Map(
    members.map(({ characterID: id }) => [
      id,
      {
        system: id === defender ? 301 : 300,
        station: id === defender ? null : rallyDock,
        warping: false,
        onBelt: false,
      },
    ]),
  );
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const handles: Awaited<
    ReturnType<ReturnType<typeof createMiningFleetRuntime>["runs"]["MINER"]["start"]>
  >[] = [];
  const record = (event: string, id: number) => events.push({ event, id, at: Date.now() });
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fleet = {
    fleetID: 900,
    reads: {
      GetInitState: {
        result: keyval([
          ["fleetID", 900],
          [
            "members",
            {
              type: "dict",
              entries: members.map((m) => [m.characterID, keyval([["charID", m.characterID]])]),
            },
          ],
        ]),
      },
    },
  };
  const flight = (id: number, shipID: number) => {
    const p = states.get(id)!;
    return {
      shipID: preparation?.wrongShip === id ? shipID + 1000 : shipID,
      solarSystemID: p.system,
      inSpace: p.station === null,
      docked: p.station !== null,
      stationID: p.station,
      shipMode: p.warping ? "WARP" : "STOP",
      transition,
    };
  };
  const runtime = createMiningFleetRuntime({
    ...deps,
    prepareMember: preparation?.prepareMember,
    attach: async (run) => {
      const id = run.held.characterID,
        p = states.get(id)!,
        m = members.find((m) => m.characterID === id)!;
      return {
        store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          async startRoute(to: number) {
            assert.equal(to, rallyDock);
            record("rally route", id);
            return { started: true };
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => ({ status: "arrived" }),
            readFlightNow: async () => flight(id, m.shipID),
            async dockStep(to: number) {
              assert.equal(to, rallyDock);
              p.station = to;
              record("rally dock", id);
            },
            async bridgeDo(_service: string, method: string) {
              if (method === "Undock") {
                record("undock", id);
                p.station = null;
                return;
              }
              assert.equal(method, "InvalidateLocationCache");
            },
            async warpAsTheAutopilot(to: number) {
              assert.equal(to, setup.beltID);
              assert.ok(
                members.every((member) =>
                  events.some((e) => e.id === member.characterID && e.event === "rallied"),
                ),
              );
              record("belt warp", id);
              if (id === defender) p.warping = true;
              else p.onBelt = true;
            },
          },
        },
      } as unknown as PilotSession;
    },
    anchor: async (run, _session, config) => {
      assert.equal(run.characterID, defender);
      record("anchor route", defender);
      await arrived;
      if (config.stopRequested()) return "stopped";
      states.get(defender)!.system = 300;
      return "arrived";
    },
    createDefender: (config) => ({
      async navigate() {
        assert.fail("The initial grid confirmation already positioned this Defender.");
      },
      readyToEscort: async () => true,
      focus: () => null,
      warning: () => null,
      repairStatus: () => null,
      droneIDs: () => [],
      tick: async () => {
        assert.ok(states.get(config.run.characterID)?.onBelt);
        record("defender watch", config.run.characterID);
        return "watching";
      },
      stop: async () => {},
    }),
    createCycle: async (run) => ({
      tick: async () => {
        assert.ok(
          members
            .filter((m) => m.role === "DEFENDER")
            .every((m) => states.get(m.characterID)?.onBelt),
        );
        record("mine", run.characterID);
        return "blocked";
      },
      stop: async () => {},
    }),
    park: async (_run, session) => {
      const id = session.store.station.get().online!.characterID;
      states.get(id)!.station = rallyDock;
      record("park", id);
      return { kind: "station", destinationID: rallyDock, systemID: 300 };
    },
  });
  const group = runtime.getOrCreate(setup);
  async function start(member: Member) {
    const { characterID: id, shipID } = member,
      p = states.get(id)!,
      botID = operationID + "-" + id;
    const fetcher: typeof fetch = async (input) => {
      let body: object;
      switch (new URL(String(input)).pathname) {
        case "/api/pilot-training/characters":
          body = { account: "pilot-" + id, characters: [{ characterID: id }] };
          break;
        case "/api/bots":
          body = {
            bots: [
              { botID, characterID: id, expiresAt: new Date(Date.now() + 600_000).toISOString() },
            ],
          };
          break;
        case "/api/bridge/bound-fleet":
          body = fleet;
          break;
        case "/api/bridge/flight/status":
          body = { flight: flight(id, shipID) };
          break;
        case "/api/bridge/space/snapshot":
          body = {
            space: {
              inSpace: true,
              stateValid: true,
              shipID,
              solarSystemID: p.system,
              sampledAtMs: Date.now(),
              ship: {
                itemID: shipID,
                characterID: id,
                mode: p.warping ? "WARP" : "STOP",
                position: { x: p.onBelt ? 100 : 1_000_000, y: 0, z: 0 },
                radius: 10,
              },
              entities: [
                {
                  itemID: setup.beltID,
                  groupID: 9,
                  name: setup.beltName,
                  position: { x: 0, y: 0, z: 0 },
                  radius: 100,
                },
              ],
            },
          };
          break;
        case "/api/bridge/drones":
          body = {
            activeShipID: shipID,
            bay: [],
            inSpace: [],
            errors: { bay: null, inSpace: null },
          };
          break;
        case "/api/map/station/601":
          body = { station: { stationID: rallyDock } };
          break;
        case "/api/map/resolve/601":
          body = { kind: "station", stationID: rallyDock, solarSystemID: 300 };
          break;
        default:
          throw Error("Unexpected fixture request " + String(input));
      }
      return Response.json({ ok: true, ...body });
    };
    const handle = await runtime.runs[member.role].start({
      botID,
      characterID: id,
      setup: JSON.parse(JSON.stringify(setup)),
      held: { characterID: id },
      baseUrl: "http://bff",
      fetch: fetcher,
      resumed: false,
      resumeData: null,
      routeSettings: null,
      report(report) {
        reports.push({
          id,
          status: report.status,
          phase: report.phase ?? null,
          why: report.why ?? null,
        });
        if (report.phase === "At fleet rally") record("rallied", id);
      },
    } as Parameters<typeof runtime.runs.MINER.start>[0]);
    handles.push(handle);
  }
  async function advance(turns = 1) {
    for (let i = 0; i < turns; i++) {
      t.mock.timers.tick(1500);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  t.after(async () => {
    arrive();
    for (const handle of handles) await handle.stop();
  });
  return { setup, runtime, group, events, reports, states, defender, arrive, start, advance };
}

test("the first miners hold, all fifteen rally and Warp together, and mining waits for the last Defender's grid", async (t) => {
  const f = startupFleet(t, "initial-rally-15"),
    members = f.setup.members;
  await Promise.all(members.slice(0, 2).map(f.start));
  await f.advance(5);
  assert.deepEqual(
    f.events.map((e) => [e.event, e.id]),
    [
      ["rallied", 1],
      ["rallied", 2],
    ],
  );
  assert.equal(f.group.op.snapshot().claim, null);
  await Promise.all(members.slice(2).map(f.start));
  await f.advance(6);
  assert.equal(f.group.entries.size, 15);
  assert.ok(f.events.some((e) => e.event === "anchor route" && e.id === f.defender));
  assert.equal(f.group.op.snapshot().state, "READY");
  assert.ok(!f.events.some((e) => ["belt warp", "undock", "mine"].includes(e.event)));

  f.arrive();
  await f.advance(10);
  const warps = f.events.filter((e) => e.event === "belt warp");
  assert.deepEqual(
    warps.map((e) => e.id).sort((a, b) => a - b),
    members.map((m) => m.characterID),
    JSON.stringify(f.reports.slice(-20)),
  );
  assert.equal(new Set(warps.map((e) => e.at)).size, 1);
  assert.ok(f.events.some((e) => e.event === "rally dock" && e.id === f.defender));
  assert.equal(f.group.op.snapshot().state, "READY");
  assert.equal(f.group.op.assignment(1)?.targetGranted, false);
  assert.ok(!f.events.some((e) => e.event === "mine"));

  const defender = f.states.get(f.defender)!;
  defender.warping = false;
  defender.onBelt = true;
  await f.advance(6);
  assert.equal(f.group.op.snapshot().state, "ACTIVE", JSON.stringify(f.reports.slice(-20)));
  assert.equal(new Set(f.events.filter((e) => e.event === "mine").map((e) => e.id)).size, 8);
  assert.equal(
    new Set(f.events.filter((e) => e.event === "defender watch").map((e) => e.id)).size,
    4,
  );
  assert.equal(f.events.filter((e) => e.event === "belt warp").length, 15);
});

test("Stop during rally settles the hosted pilots while a Defender is still traveling", async (t) => {
  const f = startupFleet(t, "stop-during-rally");
  await Promise.all(f.setup.members.map(f.start));
  await f.advance(7);
  assert.equal(f.group.op.snapshot().state, "READY");
  assert.ok(!f.events.some((e) => e.event === "belt warp" || e.event === "mine"));
  f.group.requestStop("RETURN_HOME");
  f.arrive();
  await f.advance(12);
  const snapshot = f.group.op.snapshot();
  assert.equal(snapshot.state, "STOPPED", JSON.stringify(f.reports.slice(-20)));
  assert.equal(snapshot.parked.length, 15);
  assert.equal(f.reports.filter((r) => r.status === "stopped").length, 15);
  assert.ok(!f.events.some((e) => e.event === "belt warp" || e.event === "mine"));
});

test("MCC waits for a Defender's preparation in its hosted session and uses that session for Rally", async (t) => {
  let complete!: () => void;
  const equipment = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const checked: number[] = [];
  const f = startupFleet(t, "held-startup-preparation", {
    prepareMember: async (run, setup, held) => {
      checked.push(run.characterID);
      assert.equal(run.botID, "held-startup-preparation-12");
      assert.equal(setup.preparation.fittingID, 100);
      assert.equal(
        held.shipID,
        f.setup.members.find((m) => m.characterID === run.characterID)?.shipID,
      );
      await equipment;
      held.current();
      return { status: "stopped", phase: "Mining member prepared" };
    },
  });
  t.after(complete);
  await Promise.all(f.setup.members.map(f.start));
  f.arrive();
  await f.advance(8);
  assert.deepEqual(checked, [f.defender]);
  assert.equal(f.group.op.snapshot().claim, null);
  assert.ok(!f.events.some((e) => e.event === "belt warp" || e.event === "mine"));
  complete();
  await f.advance(10);
  assert.equal(
    f.events.filter((e) => e.event === "belt warp").length,
    15,
    JSON.stringify(f.reports.slice(-15)),
  );
  assert.ok(!f.events.some((e) => e.event === "mine"));
  f.states.get(f.defender)!.warping = false;
  f.states.get(f.defender)!.onBelt = true;
  await f.advance(6);
  assert.equal(f.group.op.snapshot().state, "ACTIVE");
  assert.deepEqual(checked, [f.defender]);
});

test("a planned hull is verified against the active ship before that pilot can join or travel", async (t) => {
  const f = startupFleet(t, "wrong-startup-hull", { wrongShip: 12 }),
    defender = f.setup.members.find((m) => m.characterID === f.defender)!;
  await assert.rejects(f.start(defender), /active ship or location does not match the Start plan/);
  assert.equal(f.group.entries.size, 0);
  assert.deepEqual(f.events, []);
});

test("Stop during held preparation prevents replenishment and releases the assembling pilots", async (t) => {
  let complete!: () => void;
  const equipment = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let checks = 0;
  const f = startupFleet(t, "stop-during-held-preparation", {
    prepareMember: async (_run, _setup, held) => {
      checks++;
      await equipment;
      assert.equal(held.stopRequested(), true);
      return { status: "stopped", phase: "Mining preparation settled" };
    },
  });
  t.after(complete);
  await Promise.all(f.setup.members.map(f.start));
  await f.advance(5);
  assert.equal(checks, 1);
  f.group.requestStop("RETURN_HOME");
  complete();
  f.arrive();
  await f.advance(12);
  assert.equal(f.group.op.snapshot().state, "STOPPED", JSON.stringify(f.reports.slice(-15)));
  assert.equal(f.group.op.snapshot().parked.length, 15);
  assert.ok(!f.events.some((e) => e.event === "belt warp" || e.event === "mine"));
});

test("an absent Defender keeps the starting belt closed", async (t) => {
  const f = startupFleet(t, "missing-defender-at-rally");
  await Promise.all(f.setup.members.filter((m) => m.characterID !== f.defender).map(f.start));
  await f.advance(10);
  assert.equal(f.events.filter((e) => e.event === "rallied").length, 14);
  assert.equal(f.group.op.snapshot().state, "READY");
  assert.equal(f.group.op.snapshot().claim, null);
  assert.ok(!f.events.some((e) => e.event === "belt warp" || e.event === "mine"));
  const { operationID, operationRunID } = f.setup;
  const scope = { operationID, operationRunID };
  const selected = f.runtime.requestOperationStop(scope, "RETURN_HOME", {
    ...scope,
    version: 1,
    revision: 1,
    planHash: "plan",
    setupHash: "setup",
    members: f.setup.members.map((m) => ({
      characterID: m.characterID,
      accountName: "pilot-" + m.characterID,
      role: m.role,
      kind:
        m.role === "MINER" ? "mcc-miner" : m.role === "DEFENDER" ? "mcc-defender" : "mcc-hauler",
      beforeIDs: [],
      status: m.characterID === f.defender ? "PREPARED" : "ACCEPTED",
      botID: m.characterID === f.defender ? null : operationID + "-" + m.characterID,
    })),
  });
  assert.deepEqual(selected, { live: true, mode: "RETURN_HOME" });
  await f.advance(8);
  const stopped = f.group.op.snapshot();
  assert.equal(stopped.state, "STOPPED", JSON.stringify(f.reports.slice(-20)));
  assert.equal(stopped.parked.length, 14);
  assert.deepEqual(stopped.neverStarted, [f.defender]);
});

test("two self-unload miners each resume mining after their own trip and Stop follows Parking without another productive trip", async () => {
  const setup = {
      ...base,
      operationID: "self-unload-return",
      beltName: "self-unload-test-belt",
      haulMode: "SELF_UNLOAD" as const,
      members: base.members.slice(0, 2),
    },
    events: string[] = [],
    reports: any[] = [];
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => ({ destinationID: 600, kind: "station" as const, systemID: 300 }),
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: "self-unload-test-belt" }));
  assert.equal(group.op.activate(1), true);
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  for (const m of setup.members) {
    let trips = 0;
    const fetcher: typeof fetch = async (input) => {
      const p = new URL(String(input)).pathname;
      const body =
        p === "/api/bridge/flight/status"
          ? { flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 } }
          : {
              fleetID: 900,
              reads: {
                GetInitState: {
                  result: keyval([
                    ["fleetID", 900],
                    [
                      "members",
                      {
                        type: "dict",
                        entries: setup.members.map((x) => [
                          x.characterID,
                          keyval([["charID", x.characterID]]),
                        ]),
                      },
                    ],
                  ]),
                },
              },
            };
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        flying: { isSessionClosing: () => false },
        setLivePush() {},
      },
    };
    const selfUnload: any = {
      trip: async () => {
        trips++;
        events.push(`trip:${m.characterID}:${trips}`);
        return { deposited: trips === 1, rawRemaining: [], observedAt: Date.now() };
      },
      snapshot: () => ({ receipts: [] }),
    };
    const native: any = {
      current() {},
      navigate: async () => {
        events.push(`navigate:${m.characterID}`);
      },
      mineCycle: async () => {
        if (!trips) return "hold-full";
        events.push(`mine:${m.characterID}`);
        return "yield";
      },
    };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        baseUrl: "http://bff",
        fetch: fetcher,
        report: (r: any) => reports.push(r),
      },
      session,
      member: m,
      cycle: { stop: async () => {}, tick: async () => "yield" },
      native,
      selfUnload,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (
    let i = 0;
    i < 100 && !setup.members.every((m) => events.includes(`mine:${m.characterID}`));
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  for (const m of setup.members) {
    assert.ok(events.indexOf(`trip:${m.characterID}:1`) >= 0);
    assert.ok(events.indexOf(`mine:${m.characterID}`) > events.indexOf(`trip:${m.characterID}:1`));
  }
  group.requestStop();
  for (
    let i = 0;
    i < 150 &&
    (group.op.snapshot().state !== "STOPPED" ||
      reports.filter((r) => r.status === "stopped").length !== 2);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(group.op.snapshot().claim, null);
  assert.deepEqual(group.op.snapshot().manifests, []);
  assert.deepEqual(events.filter((e) => e.startsWith("trip:")).sort(), ["trip:1:1", "trip:2:1"]);
  assert.equal(reports.filter((r) => r.status === "stopped").length, 2);
});

test("Gateway flight reads recover on the same Miner with bounded per-pilot retries", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100000 });
  const setup = {
    ...base,
    operationID: "gateway-read-retry",
    beltName: "gateway-read-belt",
    haulMode: "SELF_UNLOAD" as const,
    members: base.members.slice(0, 2),
  };
  const group = createMiningFleetRuntime(deps).getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  const reports: { id: number; phase: string; why: string }[] = [],
    failures: number[] = [],
    ore = [0, 0];
  const ready = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  let remaining = 1,
    shipID = 11,
    failPilot = 1,
    loseOwner = false,
    unowned = 0;
  for (const member of setup.members) {
    const id = member.characterID;
    const run = {
      characterID: id,
      botID: "gateway-" + id,
      baseUrl: "http://bff",
      report: (r: { phase: string; why: string }) => reports.push({ id, ...r }),
      fetch: async (input: unknown) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/bridge/flight/status") {
          if (id === failPilot && remaining > 0) {
            remaining--;
            failures.push(Date.now());
            if (loseOwner) unowned = id;
            return Response.json(
              {
                ok: false,
                error: "EVE_GATEWAY_UNREACHABLE",
                message: "EveJS gateway is unreachable.",
              },
              { status: 502 },
            );
          }
          return Response.json({
            ok: true,
            flight: {
              shipID: id === 1 ? shipID : member.shipID,
              shipIsCapsule: false,
              solarSystemID: 300,
              inSpace: true,
              docked: false,
              shipMode: "STOP",
              transition: ready,
            },
          });
        }
        assert.equal(url.pathname, "/api/bridge/space/snapshot");
        return Response.json({
          ok: true,
          space: {
            inSpace: true,
            stateValid: true,
            shipID: member.shipID,
            solarSystemID: 300,
            sampledAtMs: Date.now(),
            ship: {
              itemID: member.shipID,
              characterID: id,
              mode: "STOP",
              position: { x: 100, y: 0, z: 0 },
              radius: 10,
            },
            entities: [
              {
                itemID: 99,
                groupID: 9,
                name: setup.beltName,
                position: { x: 0, y: 0, z: 0 },
                radius: 10,
              },
            ],
          },
        });
      },
    };
    const session = {
      store: {
        station: {
          get: () => ({ online: id === unowned ? null : { characterID: id, corporationID: 77 } }),
        },
      },
      flow: {
        requestOptions: () => ({}),
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        setLivePush() {},
      },
    } as unknown as PilotSession;
    const native = {
      ...createNativeBeltNavigation(run, session, {
        shipID: member.shipID,
        beltID: 99,
        current: () => {},
      }),
      mineCycle: async () => {
        ore[id - 1]! += 11;
        return "yield";
      },
    };
    const selfUnload = { snapshot: () => null };
    group.entries.set(id, {
      run,
      session,
      member,
      native,
      selfUnload,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  const miner = group.entries.get(1)!;
  const turn = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(1500);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  try {
    await turn();
    assert.equal(ore[0], 0);
    assert.equal(miner.failed, null);
    assert.equal(miner.observationFailures, 1);
    assert.match(
      reports.find((r) => r.id === 1 && r.phase === "Retrying native observation")!.why,
      /EveJS gateway is unreachable/,
    );
    await turn(2);
    assert.equal(ore[0], 11);
    assert.equal(miner.observationFailures, 0);
    const peerBefore = ore[1]!;
    const affectedBefore = ore[0];
    remaining = 5;
    await turn();
    await turn(30);
    assert.deepEqual(
      failures.slice(1).map((at, i, a) => at - a[0]!),
      [0, 3000, 9000, 21000, 45000],
    );
    assert.equal(miner.observationFailures, 5);
    assert.equal(miner.retryAt, failures.at(-1)! + 30000);
    assert.equal(ore[0], affectedBefore);
    assert.ok(ore[1]! > peerBefore);
    assert.ok(
      reports.some(
        (r) =>
          r.id === 1 && r.phase === "Native observation unavailable" && /30 seconds/.test(r.why),
      ),
    );
    await turn(20);
    assert.ok(ore[0]! > affectedBefore);
    assert.equal(group.entries.get(1), miner);
    assert.equal(miner.observationFailures, 0);
    assert.equal(group.op.snapshot().state, "ACTIVE");

    shipID = 101;
    await turn();
    assert.equal(miner.failed, "Mining ship changed.");
    assert.equal(miner.observationFailures, 0);
    remaining = 1;
    failPilot = 2;
    loseOwner = true;
    await turn();
    const peer = group.entries.get(2)!;
    assert.equal(peer.failed, "Held pilot or session changed.");
    assert.equal(peer.observationFailures, 0);
    assert.equal(group.op.snapshot().state, "ACTIVE");
  } finally {
    for (const entry of group.entries.values()) entry.active = false;
    group.requestStop();
  }
});

test("a miner with no usable equipment reports its own runtime failure while its peer mines", async () => {
  const setup = {
    ...base,
    operationID: "independent-member-failure",
    beltName: "mixed capability belt",
    haulMode: "SELF_UNLOAD" as const,
    members: base.members.slice(0, 2),
  };
  const runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup),
    mined: number[] = [],
    reports: { id: number; phase: string; why: string }[] = [];
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.equal(group.op.activate(1), true);
  for (const member of setup.members) {
    const current = () => {},
      stop = () => {};
    const session = {
      store: {
        station: {
          get: () => ({ online: { characterID: member.characterID, corporationID: 77 } }),
        },
      },
      flow: {
        requestOptions: () => ({}),
        flying: { isSessionClosing: () => false },
        setLivePush() {},
      },
    };
    const native = {
      current,
      navigate: async () => {},
      mineCycle: async () => {
        if (member.characterID === 1) throw Error("No online raw ore mining module is fitted.");
        mined.push(member.characterID);
        return "yield";
      },
    };
    const selfUnload = { shouldUnload: async () => false, snapshot: () => ({ receipts: [] }) };
    const run = {
      characterID: member.characterID,
      baseUrl: "http://bff",
      fetch: async (input: unknown) => {
        const path = new URL(String(input)).pathname;
        assert.equal(path, "/api/bridge/flight/status");
        return Response.json({
          ok: true,
          flight: { shipID: member.shipID, inSpace: true, solarSystemID: 300 },
        });
      },
      report: (r: any) => reports.push({ id: member.characterID, ...r }),
    };
    group.entries.set(member.characterID, {
      run,
      session,
      member,
      native,
      selfUnload,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister: stop,
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  try {
    for (
      let i = 0;
      i < 50 && (!mined.length || !reports.some((r) => r.phase === "Needs attention"));
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(mined.includes(2));
    assert.equal(group.telemetrySnapshot().stopRequested, false);
    assert.ok(
      reports.some(
        (r) =>
          r.id === 1 &&
          r.phase === "Needs attention" &&
          /No online raw ore mining module/.test(r.why),
      ),
    );
    assert.equal(group.op.snapshot().state, "ACTIVE");
  } finally {
    for (const e of group.entries.values()) e.active = false;
    group.requestStop();
  }
});

test("ore anomaly setup preserves distinct scanner and instance identities and refuses unsupported variants", () => {
  const runtime = createMiningFleetRuntime(deps);
  const { beltID, beltName, ...rest } = base;
  const site = {
    scannerKey: 55,
    instanceID: 89,
    label: "ore-site",
    archetypeID: 27 as const,
    observedAt: 100,
    target: {
      kind: "ORE_ANOMALY" as const,
      systemID: 300,
      name: "ore-site",
      siteID: 55,
      instanceID: 89,
      position: { x: 1, y: 2, z: 3 },
    },
  };
  const setup = { ...rest, site };
  assert.equal((runtime.runs.MINER.check(setup) as any).ok, true);
  assert.equal(
    (
      runtime.runs.MINER.check({
        ...setup,
        haulMode: "SELF_UNLOAD",
        members: base.members.slice(0, 2),
      }) as any
    ).ok,
    true,
  );
  for (const bad of [
    { ...setup, beltID: 99 },
    { ...setup, site: { ...site, instanceID: 55 } },
    { ...setup, site: { ...site, archetypeID: 28 } },
  ])
    assert.equal((runtime.runs.MINER.check(bad) as any).ok, false);
});

test("fleet move approvals are exact selected-pilot scopes and preserve the legacy setup when omitted", () => {
  const runtime = createMiningFleetRuntime(deps),
    old = runtime.runs.MINER.check(base) as any;
  assert.equal(old.ok, true);
  assert.equal("fleetMoves" in old.setup, false);
  const fleetMoves = [{ characterID: 3, shipID: 13, fromFleetID: 91 }],
    checked = runtime.runs.MINER.check({ ...base, fleetMoves }) as any;
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.setup.fleetMoves, fleetMoves);
  assert.ok(
    Object.keys(checked.setup).indexOf("fleetMoves") <
      Object.keys(checked.setup).indexOf("members"),
  );
  for (const bad of [
    [{ characterID: 3, shipID: 99, fromFleetID: 91 }],
    [{ characterID: 4, shipID: 14, fromFleetID: 91 }],
    [{ characterID: 3, shipID: 13, fromFleetID: 0 }],
    [...fleetMoves, ...fleetMoves],
  ])
    assert.equal((runtime.runs.MINER.check({ ...base, fleetMoves: bad }) as any).ok, false);
});

test("ICE and optional burst commander are admitted only with exact role and module scope", () => {
  const runtime = createMiningFleetRuntime(deps),
    site = {
      scannerKey: 55,
      instanceID: 89,
      label: "ice-site",
      archetypeID: 28 as const,
      observedAt: 100,
      target: {
        kind: "ICE" as const,
        systemID: 300,
        name: "ice-site",
        siteID: 55,
        instanceID: 89,
        position: { x: 1, y: 2, z: 3 },
      },
    };
  const { beltID, beltName, ...rest } = base,
    command = { moduleID: 700, typeID: 701 },
    members = [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    setup = { ...rest, site, command, members };
  assert.equal((runtime.runs.COMMAND.check(setup) as any).ok, true);
  assert.equal((runtime.runs.MINER.check({ ...setup, command: undefined }) as any).ok, false);
  assert.equal(
    (runtime.runs.MINER.check({ ...setup, command: { moduleID: 0, typeID: 701 } }) as any).ok,
    false,
  );
  assert.equal(
    (
      runtime.runs.MINER.check({
        ...setup,
        haulMode: "SELF_UNLOAD",
        members: members.filter((m) => m.role !== "HAULER"),
      }) as any
    ).ok,
    true,
  );
});
test("optional Core preserves Burst-only setup and binds exact distinct module identity", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    command = { moduleID: 700, typeID: 701 },
    plain = runtime.runs.COMMAND.check({ ...base, members, command }) as any;
  assert.equal(plain.ok, true);
  assert.equal("core" in plain.setup.command, false);
  const selected = runtime.runs.COMMAND.check({
    ...base,
    members,
    command: { ...command, core: { moduleID: 702, typeID: 703 } },
  }) as any;
  assert.deepEqual(selected.setup.command.core, { moduleID: 702, typeID: 703 });
  for (const core of [
    { moduleID: 0, typeID: 703 },
    { moduleID: 700, typeID: 703 },
    { moduleID: 702, typeID: 0 },
  ])
    assert.equal(
      (runtime.runs.COMMAND.check({ ...base, members, command: { ...command, core } }) as any).ok,
      false,
    );
});
test("COMMAND capabilities are independent, with compressor requiring its own distinct Core", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    core = { moduleID: 702, typeID: 703 },
    compressor = { moduleID: 704, typeID: 705 },
    tractor = { moduleID: 706, typeID: 707 };
  for (const command of [
    { core },
    { tractor },
    { core, compressor },
    { core, compressor, tractor },
    { moduleID: 700, typeID: 701, core, compressor, tractor },
  ]) {
    const checked = runtime.runs.COMMAND.check({ ...base, members, command }) as any;
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.setup.command, command);
  }
  for (const command of [
    {},
    { compressor },
    { moduleID: 700 },
    { core, compressor: { moduleID: 702, typeID: 705 } },
    { tractor: { moduleID: 0, typeID: 707 } },
  ])
    assert.equal((runtime.runs.COMMAND.check({ ...base, members, command }) as any).ok, false);
});
test("lazy miner support becomes available only for exact arrived live Core and compressor and retires on Stop", async () => {
  const setup = {
      ...base,
      operationID: "compressor-hook",
      beltName: "compressor-hook",
      command: { core: { moduleID: 702, typeID: 703 }, compressor: { moduleID: 704, typeID: 705 } },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup),
    claim = group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
  assert.ok(group.op.activate(1));
  assert.equal(group.commandSupport(), null);
  const session: any = {
      store: { station: { get: () => ({ online: { characterID: 4 } }) } },
      flow: { flying: { isSessionClosing: () => false } },
    },
    core = {
      snapshot: () => ({ current: { activation: { effect: {} }, fuel: { status: "VERIFIED" } } }),
      observe: async () => ({ availability: "available", core: { active: true } }),
    },
    compressor = {
      effectID: 8364,
      snapshot: () => ({ current: { active: {}, inactive: null } }),
      observe: async () => ({ observedAt: Date.now(), module: { effects: [{ effectID: 8364 }] } }),
    };
  group.entries.set(4, {
    run: { characterID: 4, report() {} },
    session,
    member: setup.members[3],
    core,
    compressor,
    commandArrival: { key: claim.key, generation: claim.generation },
    active: true,
    busy: false,
    failed: null,
    flushed: false,
    unregister() {},
    expiry: Date.now() + 600000,
    lease: null,
  } as any);
  const view = group.commandSupport();
  assert.ok(view);
  assert.equal(view.commander.shipID, 14);
  assert.equal((await view.observeSupport()).compressorEffectID, 8364);
  group.requestStop();
  assert.equal(group.commandSupport(), null);
  await assert.rejects(view.observeSupport(), /authority changed/);
  for (const e of group.entries.values()) e.active = false;
});
function commandStopPilot(member: Member) {
  const { characterID, shipID } = member;
  return {
    session: {
      store: { station: { get: () => ({ online: { characterID, corporationID: 77 } }) } },
      flow: {
        requestOptions: () => ({}),
        flying: { isSessionClosing: () => false },
        setLivePush() {},
      },
    },
    run: {
      characterID,
      baseUrl: "http://fixture",
      fetch: async (input: RequestInfo | URL) => {
        assert.equal(new URL(String(input)).pathname, "/api/bridge/flight/status");
        return Response.json({
          ok: true,
          flight: { shipID, solarSystemID: 300, inSpace: true, docked: false, shipMode: "STOP" },
        });
      },
    },
  };
}
test("COMMAND compressor settles before its Core and Burst", async () => {
  const setup = {
      ...base,
      operationID: "compressor-stop-order",
      beltName: "compressor-stop-order",
      command: {
        moduleID: 700,
        typeID: 701,
        core: { moduleID: 702, typeID: 703 },
        compressor: { moduleID: 704, typeID: 705 },
      },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [];
  let compressorActive = true,
    coreActive = true,
    compressorWrites = 0,
    coreWrites = 0;
  const compressor = {
    effectID: 8364,
    settle: async () => {
      if (!compressorWrites++) {
        events.push("compressor-deactivate");
      }
    },
    reconcile: async () => ({
      current: { activation: {}, active: {} },
      lastInactive: compressorActive ? null : { observedAt: Date.now() },
    }),
    observe: async () => ({
      observedAt: Date.now(),
      module: {
        timeFiletime: "10001",
        effects: compressorActive
          ? [{ effectID: 8364, startFiletime: "10000", durationMs: 60000 }]
          : [],
      },
    }),
  };
  const core = {
    settle: async () => {
      if (!coreWrites++) {
        events.push("core-deactivate");
      }
    },
    reconcile: async () => ({
      current: { activation: { effect: {}, refusal: null } },
      lastInactive: coreActive ? null : { effectObservedAt: Date.now() },
    }),
    observe: async () => ({
      availability: "available",
      effectObservedAt: Date.now(),
      core: {
        active: coreActive,
        timeFiletime: "10001",
        effect: coreActive ? { startFiletime: "10000", durationMs: 60000 } : null,
      },
    }),
  };
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => {
        events.push("park");
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  for (const m of setup.members) {
    const { session, run } = commandStopPilot(m);
    group.entries.set(m.characterID, {
      run: { ...run, report() {} },
      session,
      member: m,
      cycle:
        m.role === "MINER"
          ? {
              stop: async () => {
                events.push("miner-stop");
              },
              tick: async () => "blocked",
            }
          : null,
      native: {
        current() {},
        navigate: async () => {},
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
      },
      compressor: m.role === "COMMAND" ? compressor : null,
      core: m.role === "COMMAND" ? core : null,
      command:
        m.role === "COMMAND"
          ? {
              settle: async () => {
                events.push("burst-settle");
              },
            }
          : null,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 40 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    events.filter((e) => e.endsWith("deactivate")),
    ["compressor-deactivate"],
  );
  compressorActive = false;
  for (let i = 0; i < 40 && !events.includes("core-deactivate"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    events.filter((e) => e.endsWith("deactivate")),
    ["compressor-deactivate", "core-deactivate"],
  );
  coreActive = false;
  for (let i = 0; i < 60 && !events.includes("burst-settle"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    events.filter((e) => e.endsWith("deactivate") || e === "burst-settle"),
    ["compressor-deactivate", "core-deactivate", "burst-settle"],
  );
  for (const e of group.entries.values()) e.active = false;
});
test("Core admits a ready coasting ship and refuses native warp", async () => {
  let mode = "GOTO";
  const transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    },
    run: any = {
      characterID: 4,
      baseUrl: "http://bff",
      fetch: async (input: unknown) => {
        const p = new URL(String(input)).pathname;
        return Response.json({
          ok: true,
          ...(p === "/api/bridge/flight/status"
            ? {
                flight: {
                  inSpace: true,
                  docked: false,
                  shipID: 14,
                  solarSystemID: 300,
                  shipMode: mode,
                  transition,
                },
              }
            : {
                space: {
                  stateValid: true,
                  inSpace: true,
                  shipID: 14,
                  solarSystemID: 300,
                  sampledAtMs: Date.now(),
                  ship: {
                    itemID: 14,
                    characterID: 4,
                    mode,
                    position: { x: 0, y: 0, z: 0 },
                    velocity: { x: 50, y: 0, z: 0 },
                    radius: 10,
                  },
                  entities: [],
                },
              }),
        });
      },
    },
    session: any = { flow: { requestOptions: () => ({}) } };
  assert.equal(
    coreReadyForActivation(await readMiningReadiness(run, session, 14, 300, () => {})),
    true,
  );
  mode = "WARP";
  assert.equal(
    coreReadyForActivation(await readMiningReadiness(run, session, 14, 300, () => {})),
    false,
  );
});
test("Core movement remains fenced for unseen activation or stale and unknown inactive reads", async () => {
  const core: any = {
    settle: async () => {},
    reconcile: async () => ({
      current: { activation: { effect: null, refusal: null } },
      lastInactive: { effectObservedAt: 100 },
    }),
    observe: async () => ({
      availability: "available",
      effectObservedAt: 101,
      core: { active: false },
    }),
  };
  assert.equal(await confirmIndustrialCoreInactive(core, () => {}), false);
  core.reconcile = async () => ({
    current: { activation: { effect: {}, refusal: null } },
    lastInactive: { effectObservedAt: 100 },
  });
  core.observe = async () => ({ availability: "unknown" });
  assert.equal(await confirmIndustrialCoreInactive(core, () => {}), false);
  core.observe = async () => ({
    availability: "available",
    effectObservedAt: 99,
    core: { active: false },
  });
  assert.equal(await confirmIndustrialCoreInactive(core, () => {}), false);
  core.observe = async () => ({
    availability: "available",
    effectObservedAt: 101,
    core: { active: false },
  });
  assert.equal(await confirmIndustrialCoreInactive(core, () => {}), true);
});
test("COMMAND waits for its real Core cycle while independent pilots stop", async () => {
  const setup = {
      ...base,
      operationID: "core-stop-test",
      beltName: "core-stop-test",
      command: { moduleID: 700, typeID: 701, core: { moduleID: 702, typeID: 703 } },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [],
    reports: any[] = [];
  let active = true,
    writes = 0;
  const observed = () => ({
    availability: "available",
    effectObservedAt: Date.now(),
    core: {
      active,
      timeFiletime: "10001",
      effect: active ? { startFiletime: "10000", durationMs: 60000 } : null,
    },
  });
  const core = {
    settle: async () => {
      if (!writes) {
        writes++;
        events.push("core-deactivate");
      }
    },
    reconcile: async () => ({
      current: { activation: { effect: {}, refusal: null } },
      lastInactive: active ? null : observed(),
    }),
    observe: async () => observed(),
  };
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => {
        events.push("park");
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  for (const m of setup.members) {
    const { session, run } = commandStopPilot(m);
    group.entries.set(m.characterID, {
      run: {
        ...run,
        report(r: any) {
          reports.push(r);
        },
      },
      session,
      member: m,
      cycle:
        m.role === "MINER"
          ? {
              stop: async () => {
                events.push("miner-stop");
              },
              tick: async () => "blocked",
            }
          : null,
      native: {
        current() {},
        navigate: async () => {},
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
      },
      core: m.role === "COMMAND" ? core : null,
      command:
        m.role === "COMMAND"
          ? {
              settle: async () => {
                events.push("burst-settle");
              },
            }
          : null,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 40 && !writes; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1600));
  assert.ok(events.includes("miner-stop"));
  assert.equal(events.includes("burst-settle"), false);
  assert.equal(writes, 1);
  active = false;
  for (let i = 0; i < 140 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED", JSON.stringify({ events, reports }));
  assert.ok(events.indexOf("burst-settle") > events.indexOf("core-deactivate"));
  assert.equal(writes, 1);
});
test("independent pilots park and release while COMMAND still awaits its own effect", async () => {
  const setup = {
      ...base,
      operationID: "command-stop-barrier",
      beltName: "command-stop-test",
      command: { moduleID: 700, typeID: 701 },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [];
  let release!: () => void;
  const latch = new Promise<void>((r) => {
    release = r;
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      settle: async (run) => {
        events.push(`settle:${run.characterID}`);
        return {
          modulesInactive: true as const,
          dronesSafe: true as const,
          observedAt: Date.now(),
        };
      },
      park: async (run) => {
        events.push(`park:${(run as any).characterID}`);
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: "command-stop-test" }));
  assert.ok(group.op.activate(1));
  for (const m of setup.members) {
    const { session, run } = commandStopPilot(m);
    const native: any = {
      current() {},
      navigate: async () => {
        events.push(`move:${m.characterID}`);
      },
      observeHolds: async () => ({
        items: [],
        source: {},
        facts: {},
        existingContainerIDs: [],
        sceneSampledAt: Date.now(),
        capacityM3: 100,
      }),
      navigateAndVerify: async () => {
        events.push("haul-move");
      },
    };
    group.entries.set(m.characterID, {
      run: { ...run, report() {} },
      session,
      member: m,
      cycle:
        m.role === "MINER"
          ? {
              stop: async () => {
                events.push(`miner-stop:${m.characterID}`);
              },
              tick: async () => "blocked",
            }
          : null,
      native,
      command:
        m.role === "COMMAND"
          ? {
              settle: async () => {
                events.push("burst-settle");
                await latch;
              },
            }
          : null,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 110 && [1, 2, 3].some((id) => group.entries.get(id)?.active); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(events.includes("burst-settle"));
  assert.deepEqual([...group.op.snapshot().parked].sort(), [1, 2, 3]);
  assert.ok([1, 2, 3].every((id) => !group.entries.get(id)?.active));
  assert.equal(group.op.snapshot().stopRequested, true);
  assert.notEqual(group.op.snapshot().state, "STOPPED");
  group.requestStop();
  release();
  for (let i = 0; i < 100 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(events.filter((e) => e.startsWith("park:")).length, 4);
  assert.equal(events.filter((e) => e === "burst-settle").length, 1);
});

test("unknown COMMAND effect preserves its exact reason while peers park", async () => {
  const setup = {
      ...base,
      operationID: "command-unknown-stop",
      beltName: "command-unknown-test",
      command: { moduleID: 700, typeID: 701 },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [],
    runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => {
        events.push("park");
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: "command-unknown-test" }));
  assert.ok(group.op.activate(1));
  for (const m of setup.members) {
    const { session, run } = commandStopPilot(m);
    group.entries.set(m.characterID, {
      run: { ...run, report() {} },
      session,
      member: m,
      cycle:
        m.role === "MINER"
          ? {
              stop: async () => {
                events.push("miner-stop");
              },
              tick: async () => "blocked",
            }
          : null,
      native: { current() {}, navigate: async () => {}, observeHolds: async () => ({ items: [] }) },
      command:
        m.role === "COMMAND"
          ? {
              snapshot: () => ({ pending: null, history: [] }),
              settle: async () => {
                events.push("burst-unknown");
                throw Error("effect unreadable");
              },
            }
          : null,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 110 && [1, 2, 3].some((id) => group.entries.get(id)?.active); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.filter((e) => e === "burst-unknown").length, 1);
  assert.deepEqual([...group.op.snapshot().parked].sort(), [1, 2, 3]);
  assert.notEqual(group.op.snapshot().state, "STOPPED");
  assert.ok(group.op.snapshot().claim);
  const row = group.telemetrySnapshot().members.find((m) => m.characterID === 4);
  assert.equal(row?.phase, "Stop needs attention");
  assert.match(row?.reason ?? "", /COMMAND.*effect unreadable/);
  group.requestStop();
  for (let i = 0; i < 30 && events.filter((e) => e === "burst-unknown").length < 2; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.filter((e) => e === "park").length, 3);
  assert.equal(events.filter((e) => e === "burst-unknown").length, 2);
});
import { createBurstController, type BurstObservation } from "./support/controller.ts";
async function delayedCommandStop(lostAck: boolean) {
  const setup = {
      ...base,
      operationID: lostAck ? "command-delay-lost" : "command-delay-accepted",
      beltName: lostAck ? "cmd-delay-lost" : "cmd-delay-accepted",
      command: { moduleID: 700, typeID: 701 },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [];
  let active = true,
    writes = 0,
    saved: unknown = null;
  const observation = () => ({
    characterID: 4,
    shipID: 14,
    moduleID: 700,
    typeID: 701,
    flagID: 27,
    effectID: 99,
    online: true,
    active,
    observedAt: Date.now(),
  });
  const command = createBurstController({
    identity: {
      operationID: setup.operationID,
      runID: setup.operationRunID,
      characterID: 4,
      shipID: 14,
      moduleID: 700,
      typeID: 701,
    },
    document: {
      read: () => saved,
      write(v) {
        saved = structuredClone(v);
      },
    },
    current() {},
    observe: async () => {
      throw Error("recipients disconnected");
    },
    observeOwn: async () => observation(),
    activate: async () => {
      throw Error("unexpected activation");
    },
    deactivate: async () => {
      writes++;
      events.push("deactivate");
      if (lostAck) throw Error("ack lost");
    },
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async () => {
        events.push("park");
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  for (const m of setup.members) {
    const { session, run } = commandStopPilot(m);
    const native: any = {
      current() {},
      navigate: async () => {
        events.push("move");
      },
      observeHolds: async () => ({
        items: [],
        source: {},
        facts: {},
        existingContainerIDs: [],
        sceneSampledAt: Date.now(),
        capacityM3: 100,
      }),
      navigateAndVerify: async () => {
        events.push("haul-move");
      },
    };
    group.entries.set(m.characterID, {
      run: { ...run, report() {} },
      session,
      member: m,
      cycle:
        m.role === "MINER"
          ? {
              stop: async () => {
                events.push("miner-stop");
              },
              tick: async () => "blocked",
            }
          : null,
      native,
      command: m.role === "COMMAND" ? command : null,
      commandBaseline: m.role === "COMMAND" ? ({ cycleMs: 60000 } as BurstObservation) : null,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  group.requestStop();
  for (let i = 0; i < 50 && !writes; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(writes, 1);
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(events.filter((e) => e === "deactivate").length, 1);
  assert.equal(group.entries.get(4)?.failed, null);
  assert.equal(command.snapshot().pending?.kind, "deactivate");
  assert.equal(command.snapshot().pending?.acknowledged, !lostAck);
  active = false;
  for (let i = 0; i < 150 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(writes, 1);
  assert.equal(events.filter((x) => x === "park").length, 4);
}
test("accepted deactivation waits for native cycle end without a second order", async () =>
  delayedCommandStop(false));
test("lost deactivation acknowledgement resolves on native effect removal without replay", async () =>
  delayedCommandStop(true));

test("command shutdown deadline is fixed to the original intent and observed cycle", () => {
  const state: any = {
    pending: { kind: "deactivate", issuedAt: 1000 },
    history: [{ intent: { kind: "activate", before: { cycleMs: 60000 } } }],
  };
  assert.equal(commandStopDeadline(state), 91000);
  assert.equal(commandStopDeadline({ ...state, pending: null }), null);
  assert.equal(commandStopDeadline({ ...state, history: [] }), 41000);
  assert.equal(
    commandStopDeadline({
      ...state,
      history: [{ intent: { kind: "activate", before: { cycleMs: 500000 } } }],
    }),
    306000,
  );
});
import { createCommandProof } from "./commandProof.ts";
test("command runtime retains proof after a post-activation write failure and captures delayed miner buffs without replay", async () => {
  const setup = {
      ...base,
      operationID: "proof-integration",
      beltName: "proof-integration-belt",
      command: { moduleID: 700, typeID: 701 },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup);
  const claim = group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
  assert.ok(claim);
  assert.ok(group.op.activate(1));
  let active = false,
    showBuff = false,
    activations = 0,
    proofWrites = 0,
    failUpdate = true,
    proofData: unknown = null;
  const kv = (entries: unknown[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  const identity = JSON.stringify([setup.operationID, setup.operationRunID, 4, 14, 700, 701]),
    proof = createCommandProof(
      {
        read: () => proofData,
        write(v) {
          proofWrites++;
          if (proofWrites === 2 && failUpdate) throw Error("proof disk failed");
          proofData = structuredClone(v);
        },
      },
      identity,
    );
  let receipt: any = null;
  const observation = () => ({
    characterID: 4,
    shipID: 14,
    moduleID: 700,
    typeID: 701,
    flagID: 27,
    effectID: 99,
    chargeTypeID: 300,
    chargeItemID: 301,
    chargeQuantity: 5,
    cycleMs: 60000,
    rangeMeters: 90000,
    online: true,
    active,
    observedAt: Date.now(),
    recipients: [1, 2].map((id) => ({
      characterID: id,
      shipID: id + 10,
      inFleet: true,
      distanceMeters: 100,
      buffs: showBuff ? [{ collectionID: 5, value: 2, expiresMs: Date.now() + 60000 }] : [],
    })),
    effectCollections: [5],
  });
  const command: any = {
    observe: async () => observation(),
    activate: async () => {
      activations++;
      const issuedAt = Date.now();
      active = true;
      receipt = {
        intent: { kind: "activate", issuedAt, acknowledged: true },
        after: {
          characterID: 4,
          shipID: 14,
          moduleID: 700,
          typeID: 701,
          flagID: 27,
          effectID: 99,
          online: true,
          active: true,
          observedAt: Date.now(),
        },
        observedAt: Date.now(),
      };
    },
    reconcile: async () => receipt,
    snapshot: () => ({ pending: null, history: receipt ? [receipt] : [] }),
  };
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      quote = async () => ({
        characterID: m.characterID,
        shipID: m.shipID,
        botID: `proof-${m.characterID}`,
        sessionGeneration: 1,
        moduleID: 100 + m.characterID,
        typeID: 200 + m.characterID,
        family: "ore" as const,
        cycleMs: active ? 90 : 100,
        timeFiletime: "134385165369240001",
        sceneSampledAtMs: Date.now(),
        observedAt: Date.now(),
      });
    const native: any = {
      current() {},
      navigate: async () => {},
      observeHolds: async () => ({
        items: [],
        source: {},
        facts: {},
        existingContainerIDs: [],
        sceneSampledAt: Date.now(),
        capacityM3: 100,
      }),
      mineCycle: async () => "blocked",
      navigateAndVerify: async () => {},
    };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `proof-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) =>
          new URL(String(input)).pathname === "/api/bridge/flight/status"
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }),
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle:
        m.role === "MINER" ? { stop: async () => {}, tick: async () => "blocked", quote } : null,
      native,
      command: m.role === "COMMAND" ? command : null,
      commandProof: m.role === "COMMAND" ? proof : undefined,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 50 && proofWrites < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(activations, 1);
  assert.equal(proof.snapshot().pending?.after, null);
  failUpdate = false;
  for (let i = 0; i < 50 && !proof.snapshot().pending?.after; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(proof.snapshot().pending?.status, "UNCONFIRMED");
  showBuff = true;
  for (let i = 0; i < 50 && !proof.snapshot().history.length; i++)
    await new Promise((r) => setTimeout(r, 100));
  const row = proof.snapshot().history[0];
  assert.equal(row?.status, "BENEFIT_OBSERVED");
  assert.deepEqual(row?.recipientsConfirmed, [1, 2]);
  assert.deepEqual(
    row?.before.miners.map((q) => q?.cycleMs),
    [100, 100],
  );
  assert.deepEqual(
    row?.after?.miners.map((q) => q?.cycleMs),
    [90, 90],
  );
  assert.equal(activations, 1);
  for (const e of group.entries.values()) e.active = false;
});

test("reviewed site classification must match native source identity", () => {
  const runtime = createMiningFleetRuntime(deps),
    { beltID, beltName, ...rest } = base,
    scannerKey = 5800000000000 + 300 * 1000 + 1,
    site = {
      scannerKey,
      instanceID: 89,
      label: "ore-site",
      archetypeID: 27 as const,
      observedAt: 100,
      siteFamily: "ORE" as const,
      sourceDungeonID: 12245,
      target: {
        kind: "ORE_ANOMALY" as const,
        systemID: 300,
        name: "ore-site",
        siteID: scannerKey,
        instanceID: 89,
        position: { x: 1, y: 2, z: 3 },
      },
    };
  assert.equal((runtime.runs.MINER.check({ ...rest, site }) as any).ok, true);
  assert.equal(
    (runtime.runs.MINER.check({ ...rest, site: { ...site, siteFamily: "MOON" } }) as any).ok,
    false,
  );
  assert.equal(
    (runtime.runs.MINER.check({ ...rest, site: { ...site, siteFamily: "UNKNOWN" } }) as any).ok,
    false,
  );
});

test("active hauler reports waiting for freight instead of remaining in forming-fleet state", async () => {
  const setup = { ...base, operationID: "hauler-idle-report", beltName: "hauler-idle-report-belt" },
    reports: any[] = [],
    runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  const kv = (entries: unknown[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => "blocked",
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
        navigateAndVerify: async () => {
          throw Error("no freight");
        },
      };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        baseUrl: "http://bff",
        fetch: async (input: unknown) =>
          new URL(String(input)).pathname === "/api/bridge/flight/status"
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }),
        report: (r: any) => reports.push({ id: m.characterID, ...r }),
      },
      session,
      member: m,
      cycle: null,
      native,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (
    let i = 0;
    i < 50 && !reports.some((r) => r.id === 3 && r.phase === "Waiting for freight");
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    reports.some((r) => r.id === 3 && r.phase === "Waiting for freight" && r.status === "running"),
  );
  assert.equal(group.op.snapshot().manifests.length, 0);
  for (const e of group.entries.values()) e.active = false;
});
test("automatic anomaly search accepts only an exclusive classified family and preserves its setup", () => {
  const runtime = createMiningFleetRuntime(deps);
  const { beltID, beltName, ...rest } = base;
  for (const family of ["ORE", "MOON", "ICE"] as const) {
    const input = { ...rest, siteSearch: { family } },
      checked = runtime.runs.MINER.check(input) as any;
    assert.equal(checked.ok, true);
    assert.equal((runtime.runs.FINISH.check(input) as any).ok, false);
    assert.deepEqual(checked.setup.siteSearch, { family });
    assert.equal("beltID" in checked.setup, false);
    assert.equal((runtime.runs.MINER.check({ ...input, beltID: 99 }) as any).ok, false);
  }
  assert.equal(
    (runtime.runs.MINER.check({ ...rest, siteSearch: { family: "UNKNOWN" } }) as any).ok,
    false,
  );
});
test("automatic search waits for fleet and defers miners until a native target is resolved", async () => {
  const { beltID, beltName, ...rest } = base,
    setup = { ...rest, operationID: "auto-site-deferred", siteSearch: { family: "ORE" as const } },
    events: string[] = [];
  let release!: (value: any) => void;
  const pending = new Promise<any>((r) => {
    release = r;
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      searchSite: async () => {
        events.push("search");
        return pending;
      },
      createCycle: async (run) => {
        events.push(`cycle:${run.characterID}:${(run.setup as any).site?.instanceID}`);
        return { tick: async () => "blocked" as const, stop: async () => {} };
      },
    }),
    group = runtime.getOrCreate(setup);
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      ["members", dictMembers()],
    ]);
  function dictMembers() {
    return {
      type: "dict",
      entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
    };
  }
  docs.set(`mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`, {
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      [
        [1, 11, "auto-1"],
        [2, 12, "auto-2"],
        [3, 13, "auto-3"],
      ],
    ]),
    leaderID: 1,
    fleetID: 900,
    pending: null,
    joined: [1, 2, 3],
  });
  for (const m of setup.members) {
    const botID = `auto-${m.characterID}`,
      fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === "/api/pilot-training/characters"
            ? { account: `p${m.characterID}`, characters: [{ characterID: m.characterID }] }
            : path === "/api/bots"
              ? {
                  bots: [
                    {
                      botID,
                      characterID: m.characterID,
                      expiresAt: new Date(Date.now() + 600000).toISOString(),
                    },
                  ],
                }
              : path.endsWith("/status")
                ? { flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 } }
                : { fleetID: 900, reads: { GetInitState: { result: fleet } } };
        return new Response(JSON.stringify({ ok: true, ...body }), {
          headers: { "content-type": "application/json" },
        });
      };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
    };
    group.entries.set(m.characterID, {
      run: {
        botID,
        characterID: m.characterID,
        setup,
        baseUrl: "http://bff",
        fetch: fetcher,
        report() {},
      },
      session,
      member: m,
      startupManaged: true,
      cycle: null,
      native: null,
      selfUnload: null,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, ["search"]);
  assert.equal(group.op.snapshot().claim, null);
  const site = {
    scannerKey: 5800000300001,
    instanceID: 89,
    label: "ore-site",
    archetypeID: 27,
    observedAt: Date.now(),
    sourceDungeonID: 12245,
    siteFamily: "ORE",
    target: {
      kind: "ORE_ANOMALY",
      systemID: 300,
      name: "ore-site",
      siteID: 5800000300001,
      instanceID: 89,
      position: { x: 1, y: 2, z: 3 },
    },
  };
  release(site);
  for (let i = 0; i < 75 && (group.op.snapshot().state !== "ACTIVE" || events.length < 3); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "ACTIVE");
  assert.deepEqual(events.slice(1), ["cycle:1:89", "cycle:2:89"]);
  for (const e of group.entries.values()) e.active = false;
});

test("Stop during pending search waits and no-site shutdown parks without freight", async () => {
  const { beltID, beltName, ...rest } = base,
    setup = { ...rest, operationID: "auto-site-stop", siteSearch: { family: "ORE" as const } },
    events: string[] = [];
  let release!: (value: any) => void;
  const pending = new Promise<any>((r) => {
    release = r;
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async (run) => {
        events.push(`park:${(run as any).characterID}`);
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
      searchSite: async () => {
        events.push("search");
        return pending;
      },
      createCycle: async (run) => {
        events.push(`cycle:${run.characterID}:${(run.setup as any).site?.instanceID}`);
        return { tick: async () => "blocked" as const, stop: async () => {} };
      },
    }),
    group = runtime.getOrCreate(setup);
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      ["members", dictMembers()],
    ]);
  function dictMembers() {
    return {
      type: "dict",
      entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
    };
  }
  docs.set(`mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`, {
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      [
        [1, 11, "auto-1"],
        [2, 12, "auto-2"],
        [3, 13, "auto-3"],
      ],
    ]),
    leaderID: 1,
    fleetID: 900,
    pending: null,
    joined: [1, 2, 3],
  });
  for (const m of setup.members) {
    const botID = `auto-${m.characterID}`,
      fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === "/api/pilot-training/characters"
            ? { account: `p${m.characterID}`, characters: [{ characterID: m.characterID }] }
            : path === "/api/bots"
              ? {
                  bots: [
                    {
                      botID,
                      characterID: m.characterID,
                      expiresAt: new Date(Date.now() + 600000).toISOString(),
                    },
                  ],
                }
              : path.endsWith("/status")
                ? { flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 } }
                : { fleetID: 900, reads: { GetInitState: { result: fleet } } };
        return new Response(JSON.stringify({ ok: true, ...body }), {
          headers: { "content-type": "application/json" },
        });
      };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
    };
    group.entries.set(m.characterID, {
      run: {
        botID,
        characterID: m.characterID,
        setup,
        baseUrl: "http://bff",
        fetch: fetcher,
        report() {},
      },
      session,
      member: m,
      startupManaged: true,
      cycle: null,
      native: null,
      selfUnload: null,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, ["search"]);
  assert.equal(group.op.snapshot().claim, null);
  group.requestStop();
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(events[0], "search");
  assert.ok(["SETTLING", "PARKING"].includes(group.op.snapshot().state));
  assert.equal(group.op.snapshot().claim, null);
  release({ kind: "NO_SITE_OBSERVED", family: "ORE", observedAt: Date.now(), scans: 2 });
  for (let i = 0; i < 120 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(events.filter((e) => e.startsWith("park:")).length, 3);
  assert.deepEqual(group.op.snapshot().manifests, []);
  assert.equal(
    events.some((e) => e.startsWith("cycle:")),
    false,
  );
});

test("Stop retries rejected unknown search read-only after native settlement", async () => {
  const { beltID, beltName, ...rest } = base,
    setup = { ...rest, operationID: "auto-site-reconcile", siteSearch: { family: "ORE" as const } },
    events: string[] = [];
  let scoutID: number | undefined;
  let release!: (value: any) => void;
  const pending = new Promise<any>((r) => {
    release = r;
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async (run) => {
        events.push(`park:${(run as any).characterID}`);
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
      searchSite: async (run, _session, config) => {
        if (!config.stopRequested()) {
          scoutID = run.characterID;
          events.push("search");
          config.document.write({ pending: { issuedAt: 1 } });
          throw Error("undock remains unknown");
        }
        assert.equal(run.characterID, scoutID);
        events.push("readonly-reconcile");
        await pending;
        config.document.write({ pending: null });
        return { kind: "STOPPED" as const, observedAt: Date.now() };
      },
      createCycle: async (run) => {
        events.push(`cycle:${run.characterID}:${(run.setup as any).site?.instanceID}`);
        return { tick: async () => "blocked" as const, stop: async () => {} };
      },
    }),
    group = runtime.getOrCreate(setup);
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      ["members", dictMembers()],
    ]);
  function dictMembers() {
    return {
      type: "dict",
      entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
    };
  }
  docs.set(`mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`, {
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      [
        [1, 11, "auto-1"],
        [2, 12, "auto-2"],
        [3, 13, "auto-3"],
      ],
    ]),
    leaderID: 1,
    fleetID: 900,
    pending: null,
    joined: [1, 2, 3],
  });
  for (const m of setup.members) {
    const botID = `auto-${m.characterID}`,
      fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === "/api/pilot-training/characters"
            ? { account: `p${m.characterID}`, characters: [{ characterID: m.characterID }] }
            : path === "/api/bots"
              ? {
                  bots: [
                    {
                      botID,
                      characterID: m.characterID,
                      expiresAt: new Date(Date.now() + 600000).toISOString(),
                    },
                  ],
                }
              : path.endsWith("/status")
                ? { flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 } }
                : { fleetID: 900, reads: { GetInitState: { result: fleet } } };
        return new Response(JSON.stringify({ ok: true, ...body }), {
          headers: { "content-type": "application/json" },
        });
      };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
    };
    group.entries.set(m.characterID, {
      run: {
        botID,
        characterID: m.characterID,
        setup,
        baseUrl: "http://bff",
        fetch: fetcher,
        report() {},
      },
      session,
      member: m,
      startupManaged: true,
      cycle: null,
      native: null,
      selfUnload: null,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, ["search"]);
  assert.equal(group.op.snapshot().claim, null);
  group.requestStop();
  for (let i = 0; i < 40 && !events.includes("readonly-reconcile"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.slice(0, 2), ["search", "readonly-reconcile"]);
  for (let i = 0; i < 80 && group.op.snapshot().parked.length < 2; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(setup.members.some((m) => m.characterID === scoutID && m.role === "MINER"));
  assert.deepEqual(
    [...group.op.snapshot().parked].sort(),
    setup.members
      .map((m) => m.characterID)
      .filter((id) => id !== scoutID)
      .sort(),
  );
  assert.equal(group.op.snapshot().state, "SETTLING");
  assert.equal(group.op.snapshot().claim, null);
  release(null);
  for (let i = 0; i < 120 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(events.filter((e) => e.startsWith("park:")).length, 3);
  assert.deepEqual(group.op.snapshot().manifests, []);
  assert.equal(
    events.some((e) => e.startsWith("cycle:")),
    false,
  );
});

test("No-site command pilot settles while docked without burst activity", async () => {
  const { beltID, beltName, ...rest } = base,
    setup = {
      ...rest,
      operationID: "auto-site-command",
      siteSearch: { family: "ORE" as const },
      command: { moduleID: 700, typeID: 701 },
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    },
    events: string[] = [];
  let release!: (value: any) => void;
  const pending = new Promise<any>((r) => {
    release = r;
  });
  const runtime = createMiningFleetRuntime({
      ...deps,
      park: async (run) => {
        events.push(`park:${(run as any).characterID}`);
        return { destinationID: 600, kind: "station" as const, systemID: 300 };
      },
      searchSite: async () => {
        events.push("search");
        return pending;
      },
      createCycle: async (run) => {
        events.push(`cycle:${run.characterID}:${(run.setup as any).site?.instanceID}`);
        return { tick: async () => "blocked" as const, stop: async () => {} };
      },
    }),
    group = runtime.getOrCreate(setup);
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      ["members", dictMembers()],
    ]);
  function dictMembers() {
    return {
      type: "dict",
      entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
    };
  }
  docs.set(`mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`, {
    version: 1,
    identity: JSON.stringify([
      setup.operationID,
      setup.operationRunID,
      [
        [1, 11, "auto-1"],
        [2, 12, "auto-2"],
        [3, 13, "auto-3"],
        [4, 14, "auto-4"],
      ],
    ]),
    leaderID: 1,
    fleetID: 900,
    pending: null,
    joined: [1, 2, 3],
  });
  for (const m of setup.members) {
    const botID = `auto-${m.characterID}`,
      fetcher: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === "/api/pilot-training/characters"
            ? { account: `p${m.characterID}`, characters: [{ characterID: m.characterID }] }
            : path === "/api/bots"
              ? {
                  bots: [
                    {
                      botID,
                      characterID: m.characterID,
                      expiresAt: new Date(Date.now() + 600000).toISOString(),
                    },
                  ],
                }
              : path.endsWith("/status")
                ? {
                    flight: {
                      shipID: m.shipID,
                      inSpace: m.role !== "COMMAND",
                      docked: m.role === "COMMAND",
                      stationID: m.role === "COMMAND" ? 600 : null,
                      solarSystemID: 300,
                    },
                  }
                : { fleetID: 900, reads: { GetInitState: { result: fleet } } };
        return new Response(JSON.stringify({ ok: true, ...body }), {
          headers: { "content-type": "application/json" },
        });
      };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
    };
    group.entries.set(m.characterID, {
      run: {
        botID,
        characterID: m.characterID,
        setup,
        baseUrl: "http://bff",
        fetch: fetcher,
        report() {},
      },
      session,
      member: m,
      startupManaged: true,
      cycle: null,
      native: null,
      selfUnload: null,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, ["search"]);
  assert.equal(group.op.snapshot().claim, null);
  group.requestStop();
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(events[0], "search");
  assert.ok(["SETTLING", "PARKING"].includes(group.op.snapshot().state));
  assert.equal(group.op.snapshot().claim, null);
  release({ kind: "NO_SITE_OBSERVED", family: "ORE", observedAt: Date.now(), scans: 2 });
  for (let i = 0; i < 120 && group.op.snapshot().state !== "STOPPED"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.equal(events.filter((e) => e.startsWith("park:")).length, 3);
  assert.ok(group.op.snapshot().parked.includes(4));
  assert.deepEqual(group.op.snapshot().manifests, []);
  assert.equal(
    events.some((e) => e.startsWith("cycle:")),
    false,
  );
});

test("automatic search skips other owners, quarantined and depleted targets before selecting a free site", () => {
  let time = 1000;
  let saved: unknown = null;
  const board = createTargetBoard(
    { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    () => time,
    100,
  );
  const site = (id: number): Target => ({
    kind: "ORE_ANOMALY",
    systemID: 300,
    name: `site-${id}`,
    siteID: id,
    instanceID: id,
    position: { x: id, y: 0, z: 0 },
  });
  const reserved = site(1),
    quarantined = site(2),
    depleted = site(3),
    free = site(4),
    own = site(5),
    draining = site(6);
  const old = board.reserve("other", "run", quarantined)!;
  assert.equal(board.activate(old), true);
  time += 101;
  assert.equal(board.read(targetKey(quarantined))?.state, "QUARANTINED");
  const other = board.reserve("other", "run", reserved)!;
  const finished = board.reserve("other", "run", depleted)!;
  assert.equal(board.activate(finished), true);
  assert.equal(board.drain(finished), true);
  assert.equal(
    board.finish(
      finished,
      { source: "checked-empty-grid", key: finished.key, observedAt: time },
      true,
    ),
    true,
  );
  const mine = board.reserve("mine", "epoch", own)!;
  const drain = board.reserve("mine", "epoch", draining)!;
  assert.equal(board.activate(drain), true);
  assert.equal(board.drain(drain), true);
  const available = (t: Target) => searchTargetAvailable(board, t, "mine", "epoch", time);
  assert.equal([reserved, quarantined, depleted, free].find(available), free);
  assert.equal(available(own), true);
  assert.equal(available(draining), false);
  assert.equal(searchTargetAvailable(board, own, "mine", "different", time), false);
  assert.equal(board.activate(mine), true);
  assert.equal(available(own), true);
  time += 101;
  assert.equal(available(reserved), true);
  assert.equal(available(own), false);
  assert.equal(board.read(other.key), null);
  assert.equal(board.read(mine.key)?.state, "QUARANTINED");
});

test("one, two, three, five and twelve haulers preserve their exact roster", () => {
  const runtime = createMiningFleetRuntime(deps);
  for (const count of [1, 2, 3, 5, 12]) {
    const haulers = Array.from({ length: count }, (_, i) => ({
        characterID: 100 + i,
        shipID: 200 + i,
        role: "HAULER" as const,
      })),
      setup = { ...base, members: [...base.members.filter((m) => m.role === "MINER"), ...haulers] },
      checked = runtime.runs.HAULER.check(setup) as any;
    assert.equal(checked.ok, true, `count ${count}`);
    assert.deepEqual(checked.setup.members, setup.members);
  }
});

test("role-derived one, three, five and twelve miners retain exact roster for hauling and self-unload", () => {
  const runtime = createMiningFleetRuntime(deps);
  for (const count of [1, 3, 5, 12]) {
    const miners = Array.from({ length: count }, (_, i) => ({
        characterID: 100 + i,
        shipID: 200 + i,
        role: "MINER" as const,
      })),
      hauler = { characterID: 999, shipID: 1999, role: "HAULER" as const };
    for (const [members, haulMode] of [
      [[...miners, hauler], undefined],
      [miners, "SELF_UNLOAD"],
    ] as const) {
      const setup = {
          ...base,
          members,
          ...(haulMode ? { haulMode } : {}),
          operationID: `miners-${count}-${haulMode ?? "haul"}`,
        },
        checked = runtime.runs.MINER.check(setup) as any;
      assert.equal(checked.ok, true, `count ${count} mode ${haulMode}`);
      assert.deepEqual(checked.setup.members, members);
    }
  }
});
test("single self-unload miner acquires target without creating or leaving a native fleet", async () => {
  const setup = {
      ...base,
      operationID: "solo-self-unload",
      beltName: "solo belt",
      members: [base.members[0]!],
      haulMode: "SELF_UNLOAD" as const,
    },
    calls: string[] = [],
    botID = "solo-test";
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/pilot-training/characters")
      return Response.json({ ok: true, account: "pilot", characters: [{ characterID: 1 }] });
    if (path === "/api/bots")
      return Response.json({
        ok: true,
        bots: [{ botID, characterID: 1, expiresAt: new Date(Date.now() + 600000).toISOString() }],
      });
    if (path === "/api/bridge/flight/status")
      return Response.json({
        ok: true,
        flight: { shipID: 11, solarSystemID: 300, docked: true, stationID: 600 },
      });
    throw Error(`unexpected ${path}`);
  };
  const runtime = createMiningFleetRuntime({
      ...deps,
      attach: async () =>
        ({
          store: { station: { get: () => ({ online: { characterID: 1, corporationID: 77 } }) } },
          flow: {
            setLivePush() {},
            requestOptions: () => ({}),
            flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          },
        }) as any,
    }),
    handle = await runtime.runs.MINER.start({
      botID,
      characterID: 1,
      setup,
      held: { characterID: 1 },
      baseUrl: "http://bff",
      fetch: fetcher,
      resumed: false,
      resumeData: null,
      routeSettings: null,
      report() {},
    } as any);
  const group = runtime.getOrCreate(setup);
  for (let i = 0; i < 50 && group.op.snapshot().state !== "ACTIVE"; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(group.op.snapshot().state, "ACTIVE");
  assert.equal(calls.includes("/api/bridge/bound-fleet"), false);
  await handle.stop();
});
test("defenders join selected roster and never receive operation cargo authority", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [...base.members, { characterID: 4, shipID: 14, role: "DEFENDER" as const }],
    setup = { ...base, operationID: "defender-roster", members };
  const check = runtime.runs.DEFENDER.check(setup) as any;
  assert.equal(check.ok, true);
  assert.ok(check.policy.riskClasses.includes("combat"));
  const group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: "defender belt" }));
  assert.equal(group.op.activate(1), true);
  assert.equal(group.op.assignment(4)?.targetGranted, true);
  assert.deepEqual(group.op.assignment(4)?.manifests, []);
  assert.equal(group.op.claimContainer(4, 999), null);
});
test("hosted Stop parks healthy members while a failed Defender retains its unresolved command", async () => {
  const events: string[] = [],
    reports = new Map<number, any[]>();
  let canSettleDefender = false;
  const setup = {
    ...base,
    operationID: "defender-lifecycle",
    beltName: "defender lifecycle belt",
    members: [...base.members, { characterID: 4, shipID: 14, role: "DEFENDER" as const }],
  };
  const runtime = createMiningFleetRuntime({
    ...deps,
    park: async (run) => {
      events.push("park:" + (run as { characterID?: number }).characterID);
      return { destinationID: 600, kind: "station" as const, systemID: 300 };
    },
    createDefender: () => ({
      readyToEscort: async () => true,
      focus: () => null,
      warning: () => null,
      repairStatus: () => null,
      droneIDs: () => [],
      navigate: async () => {
        events.push("defender-nav");
      },
      tick: async () => {
        throw Error("Defender native read failed.");
      },
      stop: async () => {
        events.push("defender-stop");
        if (!canSettleDefender) throw Error("Defender command has no native outcome yet.");
      },
    }),
  });
  const group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.equal(group.op.activate(1), true);
  const kv = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fleet = kv([
    ["fleetID", 900],
    [
      "members",
      {
        type: "dict",
        entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
      },
    ],
  ]);
  for (const m of setup.members) {
    const session = {
      store: {
        station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
      },
      flow: {
        requestOptions: () => ({}),
        flying: { isSessionClosing: () => false },
        setLivePush() {},
      },
    };
    const native = {
      current() {},
      async navigate() {},
      async observeHolds() {
        return {
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        };
      },
    };
    const memberReports: any[] = [];
    reports.set(m.characterID, memberReports);
    const run = {
      botID: "defender-stop-" + m.characterID,
      characterID: m.characterID,
      setup,
      baseUrl: "http://bff",
      fetch: async (input: any) =>
        Response.json(
          new URL(String(input)).pathname === "/api/bridge/bound-fleet"
            ? { ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }
            : { ok: true, flight: { shipID: m.shipID, solarSystemID: 300, inSpace: true } },
        ),
      report(r: any) {
        memberReports.push(r);
      },
    };
    group.entries.set(m.characterID, {
      run,
      session,
      member: m,
      cycle: {
        stop: async () => {
          events.push("miner-stop:" + m.characterID);
        },
      },
      native,
      active: true,
      busy: m.role !== "DEFENDER",
      failed: null,
      flushed: false,
      unregister: registerRun(run as any, "test" + m.characterID, group.requestStop),
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 120 && !f(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      f(),
      JSON.stringify({
        state: group.op.snapshot().state,
        events,
        reports: [...reports].map(([id, rows]) => [id, rows.at(-1)]),
      }),
    );
  };
  const stop = () =>
    runControlRoutes["POST /runs/:botID/stop"]({
      params: { botID: "defender-stop-4" },
      account: { username: "test4" },
    } as any);
  await until(() => reports.get(4)!.at(-1)?.why === "Defender native read failed.");
  for (const e of group.entries.values()) if (e.member.role !== "DEFENDER") e.busy = false;
  assert.equal((await stop()).status, 202);
  assert.equal(group.telemetrySnapshot().stopRequested, true);
  await until(() => [1, 2, 3].every((id) => reports.get(id)!.at(-1)?.status === "stopped"));
  assert.match(reports.get(4)!.at(-1)?.why, /no native outcome/);
  assert.equal(group.op.snapshot().state, "SETTLING");
  assert.deepEqual(
    [...group.op.snapshot().parked].sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.ok(events.includes("miner-stop:1") && events.includes("miner-stop:2"));
  canSettleDefender = true;
  assert.equal((await stop()).status, 202);
  await until(() => reports.get(4)!.at(-1)?.status === "stopped");
  assert.equal(group.op.snapshot().state, "STOPPED");
  assert.deepEqual(
    [...group.op.snapshot().parked].sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
});

test("delivery admission preserves legacy and binds a personal hangar to exact destination", () => {
  const runtime = createMiningFleetRuntime(deps);
  const { corporationID, division, ...personal } = base;
  const d = {
    kind: "structure" as const,
    destinationID: base.destinationID,
    systemID: base.systemID,
    corporationID: null,
    division: null,
  };
  assert.equal((runtime.runs.MINER.check({ ...personal, delivery: d }) as any).ok, true);
  assert.equal(
    (runtime.runs.MINER.check({ ...personal, delivery: { ...d, destinationID: 999 } }) as any).ok,
    false,
  );
  assert.equal(
    (runtime.runs.MINER.check({ ...personal, delivery: { ...d, division: 1 } }) as any).ok,
    false,
  );
  assert.equal((runtime.runs.MINER.check({ ...base, delivery: d }) as any).ok, false);
  assert.equal((runtime.runs.MINER.check(base) as any).ok, true);
});

test("COMMAND Burst roster binds every distinct module and preserves legacy form", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    bursts = [
      { moduleID: 700, typeID: 701 },
      { moduleID: 702, typeID: 703 },
    ],
    setup = { ...base, members, command: { bursts } };
  const good = runtime.runs.COMMAND.check(setup) as any;
  assert.equal(good.ok, true);
  assert.deepEqual(good.setup.command.bursts, bursts);
  for (const command of [
    { bursts: [bursts[0], bursts[0]] },
    { bursts, moduleID: 700, typeID: 701 },
    { bursts, core: { moduleID: 702, typeID: 800 } },
    { bursts: [] },
  ])
    assert.equal((runtime.runs.COMMAND.check({ ...setup, command }) as any).ok, false);
  const legacy = runtime.runs.COMMAND.check({
    ...setup,
    command: { moduleID: 700, typeID: 701 },
  }) as any;
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.setup.command, { moduleID: 700, typeID: 701 });
});

test("support policy accepts missing modules but refuses unselected modules and invalid requirements", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
    command = { moduleID: 700, typeID: 701 },
    supportPolicy = {
      maintainBursts: true,
      useIndustrialCore: false,
      coreRequirement: "continueWithoutCore" as const,
      enableCompression: false,
      selfMining: false,
      tractor: false,
      collection: "TRACTOR_ONLY" as const,
      compressCollectedOre: false,
      supportLoss: "PAUSE" as const,
    };
  const checked = runtime.runs.COMMAND.check({ ...base, members, command, supportPolicy }) as any;
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.setup.supportPolicy, supportPolicy);
  assert.equal(
    (
      runtime.runs.COMMAND.check({
        ...base,
        members,
        command,
        supportPolicy: { ...supportPolicy, selfMining: true },
      }) as any
    ).ok,
    true,
  );
  for (const bad of [
    { ...supportPolicy, coreRequirement: "requireCore" },
    { ...supportPolicy, maintainBursts: false },
  ])
    assert.equal(
      (runtime.runs.COMMAND.check({ ...base, members, command, supportPolicy: bad }) as any).ok,
      false,
    );
});

test("EXISTING_ONLY uses exact observed native fleet without assembly writes", async () => {
  const setup = {
      ...base,
      operationID: "existing-only-fleet",
      beltName: "existing-only-belt",
      fleetPolicy: "EXISTING_ONLY" as const,
    },
    fleet = new Set<number>([1, 2, 3]),
    pending = new Map<number, any>(),
    calls: any[] = [],
    assemblyReports: any[] = [];
  const keyval = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
  const fetchFor =
    (id: number, ship: number, botID: string): typeof fetch =>
    async (input) => {
      const path = new URL(String(input)).pathname;
      let body: any;
      if (path === "/api/pilot-training/characters")
        body = { account: `p${id}`, characters: [{ characterID: id }] };
      else if (path === "/api/bots")
        body = {
          bots: [
            { botID, characterID: id, expiresAt: new Date(Date.now() + 600000).toISOString() },
          ],
        };
      else if (path === "/api/bridge/flight/status")
        body = {
          flight: {
            shipID: ship,
            inSpace: false,
            docked: true,
            stationID: 601,
            solarSystemID: 300,
          },
        };
      else if (path === "/api/bridge/bound-fleet")
        body = fleet.has(id)
          ? {
              fleetID: 900,
              reads: {
                GetInitState: {
                  result: keyval([
                    ["fleetID", 900],
                    [
                      "members",
                      {
                        type: "dict",
                        entries: [...fleet].map((n) => [n, keyval([["charID", n]])]),
                      },
                    ],
                  ]),
                },
              },
            }
          : {
              fleetID: null,
              reads: Object.fromEntries(
                [
                  "GetInitState",
                  "GetWings",
                  "GetMotd",
                  "GetJoinRequests",
                  "GetFleetComposition",
                ].map((k) => [k, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
              ),
            };
      else throw Error(`unexpected ${path}`);
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
  const runtime = createMiningFleetRuntime({
    ...deps,
    attach: async (run) => {
      const id = run.held.characterID;
      return {
        store: {
          station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) },
          fleet: { get: () => ({ pendingInvite: pending.get(id) ?? null }) },
        },
        flow: {
          setLivePush() {},
          requestOptions: () => ({}),
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeDo: async (
              service: string,
              method: string,
              args: any[],
              _kw: unknown,
              of: unknown,
            ) => {
              calls.push([id, service, method, args, of]);
              if (method === "CreateFleet") {
                fleet.add(id);
                return null;
              }
              if (method === "Invite") {
                pending.set(args[0], { fleetID: 900, inviterID: id, receivedAtMs: Date.now() });
                return null;
              }
              if (method === "AcceptInvite") {
                assert.equal(of, 900);
                fleet.add(id);
                pending.delete(id);
                return null;
              }
              throw Error("unexpected native write");
            },
          },
        },
      } as any;
    },
  });
  const handles = [];
  for (const m of setup.members) {
    const botID = `assembly-${m.characterID}`;
    handles.push(
      await runtime.runs[m.role as "MINER" | "HAULER"].start({
        botID,
        characterID: m.characterID,
        setup,
        held: { characterID: m.characterID },
        baseUrl: "http://bff",
        fetch: fetchFor(m.characterID, m.shipID, botID),
        resumed: false,
        resumeData: null,
        routeSettings: null,
        report(r: any) {
          assemblyReports.push(r);
        },
      } as any),
    );
  }
  const group = runtime.getOrCreate(setup);
  for (let i = 0; i < 160 && !group.op.snapshot().claim; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    group.op.snapshot().claim?.key,
    "BELT:300:existing-only-belt",
    JSON.stringify({ calls, assemblyReports }),
  );
  assert.equal(group.op.snapshot().state, "READY");
  assert.deepEqual(calls, []);
  for (const handle of handles) await handle.stop();
});

test("COMMAND producer alternates real support and mining steps on its own held ship", async () => {
  const setup = {
      ...base,
      operationID: "command-producer",
      beltName: "command-producer-belt",
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
      command: { moduleID: 700, typeID: 701 },
      supportPolicy: {
        maintainBursts: true,
        useIndustrialCore: false,
        coreRequirement: "continueWithoutCore" as const,
        enableCompression: false,
        selfMining: true,
        tractor: false,
        collection: "TRACTOR_ONLY" as const,
        compressCollectedOre: false,
        supportLoss: "PAUSE" as const,
      },
    },
    runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  let mined = 0,
    observed = 0;
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => {
          if (m.role === "COMMAND") mined++;
          return "blocked";
        },
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
        navigateAndVerify: async () => {},
      };
    const command =
      m.role === "COMMAND"
        ? {
            observe: async () => {
              observed++;
              return { active: true };
            },
            snapshot: () => ({ pending: null, history: [] }),
          }
        : undefined;
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `producer-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) =>
          new URL(String(input)).pathname.endsWith("/status")
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }),
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle: null,
      native,
      command,
      commandProof:
        m.role === "COMMAND" ? { snapshot: () => ({ pending: null, history: [] }) } : undefined,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 90 && (!observed || !mined); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(observed > 0);
  assert.ok(mined > 0);
  for (const e of group.entries.values()) e.active = false;
});

test("tractor service waits for busy hauler and claims exact second can globally before native control", async () => {
  const setup = {
      ...base,
      operationID: "tractor-service",
      beltName: "tractor-service-belt",
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
      command: { tractor: { moduleID: 700, typeID: 701 } },
      supportPolicy: {
        maintainBursts: false,
        useIndustrialCore: false,
        coreRequirement: "continueWithoutCore" as const,
        enableCompression: false,
        selfMining: false,
        tractor: true,
        collection: "TRACTOR_ONLY" as const,
        compressCollectedOre: false,
        supportLoss: "PAUSE" as const,
      },
    },
    events: string[] = [],
    runtime = createMiningFleetRuntime({
      ...deps,
      createTractor: async (c) => {
        events.push(`native:${c.manifest.containerID}`);
        c.claimCurrent();
        return {
          advance: async () => ({ movement: null }),
          stop: async () => ({}),
          snapshot: () => ({}),
        } as any;
      },
    }),
    group = runtime.getOrCreate(setup),
    claim = group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
  assert.ok(group.op.activate(1));
  const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  for (const [id, can] of [
    [1, 100],
    [2, 101],
  ] as const) {
    const items = [
        { itemID: 20 + id, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
      ],
      at = Date.now(),
      source = {
        source: "checked-ship-holds" as const,
        characterID: id,
        shipID: id + 10,
        systemID: 300,
        targetKey: claim.key,
        claimGeneration: claim.generation,
        observedAt: at,
        items: items.map((i) => ({ ...i, ownerID: id, locationID: id + 10, flagID: 134 })),
      },
      intent = group.op.prepareJetcan(id, items, 100, facts, source)!;
    assert.ok(intent);
    assert.ok(group.op.dispatchJetcan(id, intent.generation));
    assert.ok(
      group.op.registerJetcan(
        {
          source: "native-jetcan",
          operationID: setup.operationID,
          runID: setup.operationRunID,
          targetKey: claim.key,
          claimGeneration: claim.generation,
          characterID: id,
          shipID: id + 10,
          systemID: 300,
          containerID: can,
          intentGeneration: intent.generation,
          observedAt: at,
          capacityM3: 100,
          items,
        },
        facts,
      ),
    );
  }
  const kv = (v: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries: v },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => "blocked",
        navigateAndVerify: async () => {},
      };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `tractor-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) => {
          const p = new URL(String(input)).pathname;
          if (p === "/api/bots/loot-memory/claim") {
            events.push("global");
            return Response.json({ ok: true, claimed: true });
          }
          return p.endsWith("/status")
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } });
        },
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle: null,
      native,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: m.role === "HAULER",
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(events.length, 0);
  assert.ok(group.op.claimContainer(3, 100));
  for (let i = 0; i < 50 && !events.includes("native:101"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.slice(0, 2), ["global", "native:101"]);
  assert.equal(group.op.snapshot().haulClaims["101"]?.purpose, "tractor");
  for (const e of group.entries.values()) {
    e.active = false;
    if (e.lease) clearInterval(e.lease.timer);
  }
});

test("optional Core fuel shortage permits independent Burst and miners", async () => {
  const setup = {
      ...base,
      operationID: "optional-core-empty",
      beltName: "optional-core-empty-belt",
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
      command: { moduleID: 700, typeID: 701, core: { moduleID: 710, typeID: 711 } },
      supportPolicy: {
        maintainBursts: true,
        useIndustrialCore: true,
        coreRequirement: "continueWithoutCore" as const,
        enableCompression: false,
        selfMining: false,
        tractor: false,
        collection: "TRACTOR_ONLY" as const,
        compressCollectedOre: false,
        supportLoss: "PAUSE" as const,
      },
    },
    runtime = createMiningFleetRuntime(deps),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  let mined = 0,
    observed = 0;
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => {
          if (m.role === "MINER") mined++;
          return "blocked";
        },
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
        navigateAndVerify: async () => {},
      };
    const command =
      m.role === "COMMAND"
        ? {
            observe: async () => {
              observed++;
              return { active: true };
            },
            snapshot: () => ({ pending: null, history: [] }),
          }
        : undefined;
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `producer-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) =>
          new URL(String(input)).pathname.endsWith("/status")
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }),
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle: null,
      native,
      command,
      commandArrival:
        m.role === "COMMAND"
          ? {
              key: group.op.snapshot().claim!.key,
              generation: group.op.snapshot().claim!.generation,
            }
          : undefined,
      core:
        m.role === "COMMAND"
          ? {
              reconcile: async () => ({ current: null }),
              observe: async () => ({
                availability: "available",
                core: { active: false },
                fuel: {
                  availability: "available",
                  requiredQuantity: 10,
                  availableQuantity: 0,
                  sufficient: false,
                },
              }),
            }
          : undefined,
      commandProof:
        m.role === "COMMAND" ? { snapshot: () => ({ pending: null, history: [] }) } : undefined,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 90 && (!observed || !mined); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(observed > 0);
  assert.ok(mined > 0);
  for (const e of group.entries.values()) e.active = false;
});

test("COMMAND final hold requires fresh ship scope and rejects any remaining resource", async () => {
  let rows: any[] = [],
    ship = 14,
    fleetCapacity = 0;
  const flags: number[] = [];
  const session: any = {
      flow: {
        requestOptions: () => ({}),
        flying: {
          bridgeDo: async () => {},
          bridgeAsk: async (_s: string, _m: string, _a: any, k: any) => {
            flags.push(k.flag);
            return {
              type: "list",
              items: rows
                .filter((r) => r.flagID === k.flag)
                .map((fields) => ({ type: "packedrow", fields })),
            };
          },
        },
      },
    },
    run: any = {
      characterID: 4,
      baseUrl: "http://bff",
      fetch: async (input: any) => {
        const p = new URL(String(input)).pathname;
        return Response.json(
          p.endsWith("/flight/status")
            ? {
                ok: true,
                flight: {
                  shipID: ship,
                  docked: true,
                  inSpace: false,
                  stationID: 600,
                  solarSystemID: 300,
                },
              }
            : p.endsWith("/bays")
              ? {
                  ok: true,
                  shipID: ship,
                  bays: [{
                    key: "fleet",
                    present: fleetCapacity > 0,
                    error: Number.isFinite(fleetCapacity) ? null : "Bay read failed",
                    capacity: { capacity: fleetCapacity, used: 0 },
                  }],
                }
              : p.endsWith("/resources")
                ? { ok: true, resources: [{ typeID: 30, family: "ore", name: "ore" }] }
                : p.endsWith("/dogma-types")
                  ? { ok: true, available: true, types: { 30: { categoryID: 25 } } }
                  : p.endsWith("/volumes")
                    ? { ok: true, volumes: { 30: 1 }, capped: false }
                    : { ok: false },
        );
      },
    };
  assert.deepEqual((await confirmCommandFinalHold(run, session, 14, () => {})).rawRemaining, []);
  rows = [
    {
      itemID: 20,
      typeID: 30,
      ownerID: 4,
      locationID: 14,
      flagID: 134,
      quantity: 1,
      categoryID: 25,
    },
  ];
  await assert.rejects(
    confirmCommandFinalHold(run, session, 14, () => {}),
    /not confirmed empty/,
  );
  rows[0].flagID = 155;
  flags.length = 0;
  await confirmCommandFinalHold(run, session, 14, () => {});
  assert.ok(!flags.includes(155), "an unavailable Fleet Hangar is not queried");
  fleetCapacity = 100;
  await assert.rejects(confirmCommandFinalHold(run, session, 14, () => {}), /not confirmed empty/);
  assert.ok(flags.includes(155));
  rows = [];
  await confirmCommandFinalHold(run, session, 14, () => {});
  fleetCapacity = NaN;
  await assert.rejects(confirmCommandFinalHold(run, session, 14, () => {}), /fleet hangar|bay/i);
  ship = 99;
  await assert.rejects(
    confirmCommandFinalHold(run, session, 14, () => {}),
    /flight identity/,
  );
});

test("COMMAND tractor collection releases service claim then uses ordinary haul receipt", async () => {
  const setup = {
      ...base,
      operationID: "tractor-collect",
      beltName: "tractor-collect-belt",
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
      command: { tractor: { moduleID: 700, typeID: 701 } },
      supportPolicy: {
        maintainBursts: false,
        useIndustrialCore: false,
        coreRequirement: "continueWithoutCore" as const,
        enableCompression: false,
        selfMining: false,
        tractor: true,
        collection: "TRACTOR_AND_COLLECT" as const,
        compressCollectedOre: false,
        supportLoss: "PAUSE" as const,
      },
    },
    events: string[] = [],
    runtime = createMiningFleetRuntime({
      ...deps,
      createTractor: async (c) => {
        events.push(`native:${c.manifest.containerID}`);
        c.claimCurrent();
        return {
          advance: async () => ({ movement: { at: Date.now() } }),
          stop: async () => ({}),
          snapshot: () => ({
            version: 1,
            identity: {
              operationID: c.manifest.operationID,
              runID: c.manifest.runID,
              botID: c.run.botID,
              sessionGeneration: 1,
              characterID: 4,
              shipID: 14,
              moduleID: 700,
              typeID: 701,
              flagID: 27,
              canID: c.manifest.containerID,
              systemID: 300,
              claimGeneration: c.claimGeneration,
              targetGeneration: c.targetGeneration,
            },
            qualification: { typeID: 701, effectID: 99, effectName: "tractorBeamCan" },
            activation: null,
            active: null,
            deactivation: null,
            inactive: {
              at: Date.now(),
              module: {
                moduleID: 700,
                typeID: 701,
                ownerID: 4,
                shipID: 14,
                flagID: 27,
                timeFiletime: "134385165369180001",
                wallclockFiletime: "134385165369179999",
                effects: [],
                activeTargets: [],
              },
            },
          }),
        } as any;
      },
    }),
    group = runtime.getOrCreate(setup),
    claim = group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName })!;
  assert.ok(group.op.activate(1));
  const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  for (const [id, can] of [
    [1, 100],
    [2, 101],
  ] as const) {
    const items = [
        { itemID: 20 + id, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
      ],
      at = Date.now(),
      source = {
        source: "checked-ship-holds" as const,
        characterID: id,
        shipID: id + 10,
        systemID: 300,
        targetKey: claim.key,
        claimGeneration: claim.generation,
        observedAt: at,
        items: items.map((i) => ({ ...i, ownerID: id, locationID: id + 10, flagID: 134 })),
      },
      intent = group.op.prepareJetcan(id, items, 100, facts, source)!;
    assert.ok(intent);
    assert.ok(group.op.dispatchJetcan(id, intent.generation));
    assert.ok(
      group.op.registerJetcan(
        {
          source: "native-jetcan",
          operationID: setup.operationID,
          runID: setup.operationRunID,
          targetKey: claim.key,
          claimGeneration: claim.generation,
          characterID: id,
          shipID: id + 10,
          systemID: 300,
          containerID: can,
          intentGeneration: intent.generation,
          observedAt: at,
          capacityM3: 100,
          items,
        },
        facts,
      ),
    );
  }
  const kv = (v: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries: v },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => "blocked",
        navigateAndVerify: async () => {},
      };
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `tractor-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) => {
          const p = new URL(String(input)).pathname;
          if (p === "/api/bots/loot-memory/claim") {
            events.push("global");
            return Response.json({ ok: true, claimed: true });
          }
          if (p === "/api/bots/loot-memory/release") {
            events.push("release");
            return Response.json({ ok: true });
          }
          return p.endsWith("/status")
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } });
        },
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle: null,
      native,
      commandHauler:
        m.role === "COMMAND"
          ? {
              current() {},
              navigateAndVerify: async (manifest: any) => {
                events.push(`pickup:${manifest.containerID}`);
              },
              transferAndDeliver: async (
                manifest: any,
                generation: number,
                destinationID: number,
              ) => ({
                source: "native-transfer",
                operationID: manifest.operationID,
                runID: manifest.runID,
                containerID: manifest.containerID,
                claimGeneration: generation,
                shipID: 14,
                destinationID,
                sourceAfter: [],
                destinationBefore: [],
                destinationAfter: [{ typeID: 30, quantity: 10 }],
                observedAt: Date.now(),
              }),
            }
          : undefined,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: m.role === "HAULER",
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(events.length, 0);
  assert.ok(group.op.claimContainer(3, 100));
  for (let i = 0; i < 100 && !events.includes("pickup:101"); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events.slice(0, 4), ["global", "native:101", "release", "pickup:101"]);
  assert.equal(group.op.snapshot().manifests.find((m) => m.containerID === 101)?.delivered, true);
  for (const e of group.entries.values()) {
    e.active = false;
    if (e.lease) clearInterval(e.lease.timer);
  }
});

test("known empty Burst charge degrades without activation and miners continue", async () => {
  const setup = {
      ...base,
      operationID: "optional-burst-empty",
      beltName: "optional-burst-empty-belt",
      members: [...base.members, { characterID: 4, shipID: 14, role: "COMMAND" as const }],
      command: { moduleID: 700, typeID: 701 },
      supportPolicy: {
        maintainBursts: true,
        useIndustrialCore: false,
        coreRequirement: "continueWithoutCore" as const,
        enableCompression: false,
        selfMining: false,
        tractor: false,
        collection: "TRACTOR_ONLY" as const,
        compressCollectedOre: false,
        supportLoss: "STOP" as const,
      },
    },
    runtime = createMiningFleetRuntime({
      ...deps,
      observeBurstCharge: async () => ({ state: "EMPTY", quantity: 0 }),
    }),
    group = runtime.getOrCreate(setup);
  assert.ok(group.op.reserve(1, { kind: "BELT", systemID: 300, name: setup.beltName }));
  assert.ok(group.op.activate(1));
  let mined = 0,
    observed = 0;
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    fleet = kv([
      ["fleetID", 900],
      [
        "members",
        {
          type: "dict",
          entries: setup.members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
        },
      ],
    ]);
  for (const m of setup.members) {
    const session: any = {
        store: {
          station: { get: () => ({ online: { characterID: m.characterID, corporationID: 77 } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      native: any = {
        current() {},
        navigate: async () => {},
        mineCycle: async () => {
          if (m.role === "MINER") mined++;
          return "blocked";
        },
        observeHolds: async () => ({
          items: [],
          source: {},
          facts: {},
          existingContainerIDs: [],
          sceneSampledAt: Date.now(),
          capacityM3: 100,
        }),
        navigateAndVerify: async () => {},
      };
    const command =
      m.role === "COMMAND"
        ? {
            observe: async () => {
              observed++;
              return { active: true };
            },
            snapshot: () => ({ pending: null, history: [] }),
          }
        : undefined;
    group.entries.set(m.characterID, {
      run: {
        characterID: m.characterID,
        botID: `producer-${m.characterID}`,
        baseUrl: "http://bff",
        fetch: async (input: unknown) =>
          new URL(String(input)).pathname.endsWith("/status")
            ? Response.json({
                ok: true,
                flight: { shipID: m.shipID, inSpace: true, solarSystemID: 300 },
              })
            : Response.json({ ok: true, fleetID: 900, reads: { GetInitState: { result: fleet } } }),
        report() {},
      },
      session,
      member: m,
      generation: 1,
      cycle: null,
      native,
      command,
      commandArrival:
        m.role === "COMMAND"
          ? {
              key: group.op.snapshot().claim!.key,
              generation: group.op.snapshot().claim!.generation,
            }
          : undefined,
      core:
        m.role === "COMMAND"
          ? {
              reconcile: async () => ({ current: null }),
              observe: async () => ({
                availability: "available",
                core: { active: false },
                fuel: {
                  availability: "available",
                  requiredQuantity: 10,
                  availableQuantity: 0,
                  sufficient: false,
                },
              }),
            }
          : undefined,
      commandProof:
        m.role === "COMMAND" ? { snapshot: () => ({ pending: null, history: [] }) } : undefined,
      navigation: m.role === "COMMAND" ? { navigate: async () => {} } : undefined,
      selfUnload: null,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  for (let i = 0; i < 90 && !mined; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(observed, 0);
  assert.ok(mined > 0);
  for (const e of group.entries.values()) e.active = false;
});

for (const blockedHauler of [false, true])
  test(
    blockedHauler
      ? "belt relocation preserves a Hauler's unresolved delivery error"
      : "eight held Miners change belts while the Hauler still scans and collects the old belt",
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const members: Member[] = [
        ...Array.from({ length: 8 }, (_, index) => ({
          characterID: index + 1,
          shipID: index + 11,
          role: "MINER" as const,
        })),
        { characterID: 9, shipID: 19, role: "HAULER" },
      ];
      if (blockedHauler) members.push({ characterID: 10, shipID: 20, role: "HAULER" });
      const oldBelt = blockedHauler ? "old-blocked-belt" : "old-belt",
        newBelt = blockedHauler ? "new-blocked-belt" : "new-belt";
      const setup = {
        ...base,
        operationID: "relocation-runtime-" + oldBelt,
        beltName: oldBelt,
        members,
      };
      const events: string[] = [];
      let releaseScan!: () => void,
        deliver = false;
      const scanGate = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      const runtime = createMiningFleetRuntime({
        ...deps,
        createCycle: async () => {
          events.push("new-cycle");
          return { tick: async () => "blocked" as const, stop: async () => {} };
        },
      });
      const group = runtime.getOrCreate(setup),
        op = group.op;
      const old = op.reserve(1, { kind: "BELT", systemID: 300, name: oldBelt })!;
      assert.ok(op.activate(1));
      const can = (containerID: number) => ({
        containerID,
        ownerID: 1,
        observedAt: Date.now(),
        capacityM3: 100,
        items: [
          {
            itemID: containerID + 1000,
            typeID: 30,
            quantity: 10,
            unitVolumeM3: 1,
            freightKind: "RAW" as const,
          },
        ],
      });
      assert.ok(op.registerGridJetcan(9, old, can(890)));
      if (blockedHauler) {
        assert.ok(op.registerGridJetcan(10, old, can(891)));
        const work = op.claimContainer(10, 891);
        assert.ok(work && op.dispatchHaul(10, 891, work.generation));
      }
      const kv = (v: unknown[]) => ({
        type: "object",
        name: "util.KeyVal",
        args: { type: "dict", entries: v },
      });
      const fleet = kv([
        ["fleetID", 900],
        [
          "members",
          {
            type: "dict",
            entries: members.map((m) => [m.characterID, kv([["charID", m.characterID]])]),
          },
        ],
      ]);
      const sessions = new Map();
      for (const member of members) {
        const id = member.characterID;
        const session = {
          store: { station: { get: () => ({ online: { characterID: id, corporationID: 77 } }) } },
          flow: {
            requestOptions: () => ({}),
            flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
            setLivePush() {},
          },
        };
        sessions.set(id, session);
        const failed = id === 10 ? "Raw deposit outcome remains unknown; no replay." : null;
        group.entries.set(id, {
          run: {
            characterID: id,
            botID: "reloc-" + id,
            baseUrl: "http://bff",
            report() {},
            async fetch(input: unknown) {
              const path = new URL(String(input)).pathname;
              if (path.endsWith("/status"))
                return Response.json({
                  ok: true,
                  flight: {
                    shipID: member.shipID,
                    docked: true,
                    inSpace: false,
                    stationID: 600,
                    solarSystemID: 300,
                    transition: { phase: "ready" },
                  },
                });
              if (path.startsWith("/api/client-data/system-objects/"))
                return Response.json({
                  ok: true,
                  available: true,
                  objects: [
                    { itemID: 99, groupID: 9 },
                    { itemID: 100, groupID: 9 },
                  ],
                });
              if (path === "/api/names")
                return Response.json({
                  ok: true,
                  names: { "evelocation:99": oldBelt, "evelocation:100": newBelt },
                  capped: false,
                });
              return Response.json({
                ok: true,
                fleetID: 900,
                reads: { GetInitState: { result: fleet } },
              });
            },
          },
          session,
          member,
          generation: 1,
          active: true,
          busy: false,
          failed,
          flushed: false,
          selfUnload: null,
          ...(failed
            ? { telemetry: { phase: "Needs attention", reason: failed, reportedAt: Date.now() } }
            : {}),
          unregister() {
            assert.fail("Relocation released a held pilot");
          },
          expiry: Date.now() + 600000,
          lease: null,
          cycle:
            member.role === "MINER"
              ? {
                  tick: async () => "blocked",
                  stop: async () => {
                    events.push("stop");
                  },
                  release: async () => {
                    events.push("release-cycle");
                  },
                }
              : null,
          native: {
            current() {},
            async navigate() {},
            async mineCycle() {
              return "blocked";
            },
            async jettison() {
              assert.fail("A Miner jettisoned during relocation");
            },
            async waitAtBelt(_target: unknown, _claim: unknown, current: () => void) {
              current();
            },
            async observeGridJetcans(
              _target: unknown,
              claim: { key: string },
              _excluded: unknown,
              _owners: unknown,
              available: (id: number, owner: number) => boolean,
              publish: (can: unknown) => void,
              final: boolean,
            ) {
              if (!final) return;
              assert.equal(claim.key, old.key);
              assert.equal(events.filter((event) => event === "stop").length, 8);
              events.push("scan");
              await scanGate;
              assert.ok(available(900, 1));
              publish(can(900));
            },
            async haulTrip(
              _owned: unknown,
              next: (
                eligible: () => Promise<boolean>,
              ) => Promise<import("./memberLoops.ts").HaulWork | null>,
            ) {
              if (id === 10) {
                events.push("blocked-hauler-retried");
                return "waiting";
              }
              if (!deliver) return "waiting";
              const work = await next(async () => true);
              if (!work) return "idle";
              assert.equal(work.claim.key, old.key);
              assert.equal(op.snapshot().claim?.key, `BELT:300:${newBelt}`);
              assert.ok(work.dispatch());
              work.complete({
                source: "native-transfer",
                operationID: setup.operationID,
                runID: setup.operationRunID,
                containerID: work.manifest.containerID,
                claimGeneration: work.generation,
                shipID: 19,
                destinationID: 600,
                sourceAfter: [],
                destinationBefore: [],
                destinationAfter: [{ typeID: 30, quantity: 10 }],
                observedAt: Date.now(),
              });
              events.push("collected");
              return "delivered";
            },
          },
        } as any);
      }
      const scope = {
        operationID: setup.operationID,
        operationRunID: setup.operationRunID,
        claimKey: old.key,
        claimGeneration: old.generation,
      };
      try {
        const next = await runtime.prepareRelocation(scope);
        assert.deepEqual(next, { beltID: 100, beltName: newBelt });
        assert.ok(next);
        assert.equal(
          group.requestRelocation({ ...scope, claimGeneration: old.generation + 1, next }, 99),
          false,
        );
        assert.equal(group.requestRelocation({ ...scope, next }, 99), true);
        for (
          let i = 0;
          i < 20 &&
          (events.filter((event) => event === "new-cycle").length < 8 || !events.includes("scan"));
          i++
        ) {
          t.mock.timers.tick(1500);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const snapshot = op.snapshot();
        assert.equal(snapshot.state, "ACTIVE");
        assert.equal(snapshot.claim?.key, `BELT:300:${newBelt}`);
        assert.ok(snapshot.claim.generation > old.generation);
        assert.equal(events.filter((event) => event === "new-cycle").length, 8);
        assert.ok(events.includes("scan"));
        assert.ok(!events.includes("collected"));
        assert.equal(op.freightTailToScan()?.claim.key, old.key);
        assert.equal(op.haulTarget(snapshot.manifests[0]!)?.oldBeltID, 99);
        if (blockedHauler) {
          const blocked = group.telemetrySnapshot().members.find((m) => m.characterID === 10);
          assert.equal(blocked?.phase, "Needs attention");
          assert.equal(blocked?.reason, "Raw deposit outcome remains unknown; no replay.");
          assert.equal(op.snapshot().haulClaims["891"]?.characterID, 10);
          assert.ok(!events.includes("blocked-hauler-retried"));
          return;
        }
        deliver = true;
        releaseScan();
        for (let i = 0; i < 20 && events.filter((event) => event === "collected").length < 2; i++) {
          t.mock.timers.tick(1500);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(events.filter((event) => event === "collected").length, 2);
        assert.equal(op.freightTailToScan(), null);
        assert.deepEqual(
          op.snapshot().manifests.map((m) => [m.containerID, m.delivered]),
          [
            [890, true],
            [900, true],
          ],
        );
        for (const entry of group.entries.values()) {
          assert.equal(entry.session, sessions.get(entry.member.characterID));
          assert.ok(entry.active);
        }
      } finally {
        releaseScan();
        for (const entry of group.entries.values()) entry.active = false;
        group.retireStoppedGroup();
      }
    },
  );

test("an old-belt scan retired by another Hauler lets the delayed Hauler resume on the active belt", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const members: Member[] = [...base.members, { characterID: 4, shipID: 14, role: "HAULER" }];
  const setup = {
    ...base,
    operationID: "concurrent-final-freight",
    beltName: "old freight belt",
    members,
  };
  const group = createMiningFleetRuntime(deps).getOrCreate(setup),
    op = group.op;
  const oldTarget = { kind: "BELT" as const, systemID: setup.systemID, name: setup.beltName };
  const next = { ...oldTarget, name: "new freight belt" };
  const old = op.reserve(1, oldTarget)!;
  assert.ok(op.activate(1));

  let returningWithFreight = true;
  const scans: number[] = [],
    newBeltVisits: number[] = [],
    reports: { characterID: number; phase: string; why?: string }[] = [];
  let finishFirstScan!: () => void, finishSecondScan!: () => void;
  const firstScan = new Promise<void>((resolve) => {
    finishFirstScan = resolve;
  });
  const secondScan = new Promise<void>((resolve) => {
    finishSecondScan = resolve;
  });
  for (const member of members) {
    const { characterID, shipID } = member,
      first = characterID === 3,
      miner = member.role === "MINER";
    group.entries.set(characterID, {
      member,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      expiry: Date.now() + 600000,
      lease: null,
      unregister() {
        assert.fail("Relocation should keep all pilots hosted.");
      },
      run: {
        characterID,
        botID: `tail-${characterID}`,
        baseUrl: "http://bff",
        report(r: { phase: string; why?: string }) {
          reports.push({ characterID, ...r });
        },
        async fetch(input: unknown) {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/status"))
            return Response.json({
              ok: true,
              flight: {
                shipID,
                docked: true,
                inSpace: false,
                stationID: 600,
                solarSystemID: 300,
                transition: { phase: "ready" },
              },
            });
          if (path.startsWith("/api/client-data/system-objects/"))
            return Response.json({
              ok: true,
              available: true,
              objects: [
                { itemID: 99, groupID: 9 },
                { itemID: 100, groupID: 9 },
              ],
            });
          if (path === "/api/names")
            return Response.json({
              ok: true,
              names: { "evelocation:99": oldTarget.name, "evelocation:100": next.name },
              capped: false,
            });
          assert.fail(`Unexpected request ${path}`);
        },
      },
      session: {
        store: { station: { get: () => ({ online: { characterID, corporationID: 77 } }) } },
        flow: {
          requestOptions: () => ({}),
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          setLivePush() {},
        },
      },
      cycle: miner ? { async stop() {} } : null,
      native: miner
        ? {
            current() {},
            async navigate() {},
            async mineCycle() {
              return characterID === 1 ? "depleted" : "blocked";
            },
          }
        : {
            current() {},
            hasUnfinishedOwnFreight: () => first && returningWithFreight,
            async haulTrip() {
              assert.ok(first && returningWithFreight);
              if (!op.freightTailToScan()) return "waiting";
              returningWithFreight = false;
              return "delivered";
            },
            async waitAtBelt(target: Target, _claim: unknown, current: () => void) {
              current();
              if (target.name === next.name) newBeltVisits.push(characterID);
            },
            async observeGridJetcans(
              target: Target,
              _claim: unknown,
              _excluded: unknown,
              _owners: unknown,
              _available: unknown,
              _publish: unknown,
              final: boolean,
            ) {
              if (!final) return;
              assert.equal(target.name, oldTarget.name);
              scans.push(characterID);
              await (first ? firstScan : secondScan);
            },
          },
    } as any);
  }
  const step = async () => {
    t.mock.timers.tick(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    for (let i = 0; i < 20 && !scans.length; i++) await step();
    assert.equal(op.snapshot().state, "ACTIVE");
    assert.equal(op.snapshot().claim?.key, targetKey(next));
    assert.equal(op.freightTailToScan()?.claim.key, old.key);
    assert.equal(returningWithFreight, false);
    assert.deepEqual(scans, [4]);
    await step();
    assert.deepEqual(scans, [4, 3]);
    finishSecondScan();
    await group.entries.get(4)?.work;
    assert.equal(op.freightTailToScan(), null);
    finishFirstScan();
    await group.entries.get(3)?.work;
    assert.equal(op.snapshot().state, "ACTIVE");
    assert.ok(!op.snapshot().stopRequested);
    assert.equal(group.entries.get(3)?.failed, null);
    assert.ok(
      !reports.some(
        (r) =>
          r.characterID === 3 &&
          (r.phase === "Needs attention" || r.why?.includes("Stop ended the haul")),
      ),
    );
    for (let i = 0; i < 4; i++) await step();
    assert.ok(newBeltVisits.includes(3));
    assert.ok(!op.snapshot().stopRequested);
  } finally {
    finishFirstScan();
    finishSecondScan();
    for (const entry of group.entries.values()) entry.active = false;
    await Promise.allSettled([...group.entries.values()].map((e) => e.work));
    group.retireGroup();
  }
});

test("SELF_UNLOAD admits the selected COMMAND without adding a hauler", () => {
  const runtime = createMiningFleetRuntime(deps),
    members = [
      ...base.members.slice(0, 2),
      { characterID: 4, shipID: 14, role: "COMMAND" as const },
    ],
    setup = {
      ...base,
      haulMode: "SELF_UNLOAD" as const,
      members,
      command: { moduleID: 700, typeID: 701 },
    },
    result = runtime.runs.COMMAND.check(setup) as any;
  assert.equal(result.ok, true);
  assert.deepEqual(result.setup.members, members);
  assert.equal((runtime.runs.COMMAND.check({ ...setup, command: undefined }) as any).ok, false);
});

test("historical support telemetry retains native observation time and is scoped to the exact run", () => {
  const runtime = createMiningFleetRuntime(deps),
    key = `mining-fleet-support-telemetry:${JSON.stringify(["history-op", "old-run"])}`;
  docs.set(key, {
    version: 1,
    operationID: "history-op",
    runID: "old-run",
    value: {
      characterID: 4,
      shipID: 14,
      botID: "old-bot",
      sessionGeneration: 2,
      active: true,
      observedSupport: {
        observation: { state: "READY", core: "active", reason: null, fresh: true },
        observedAt: 1234,
      },
      bursts: [],
      core: null,
      compressor: null,
      tractor: null,
      tractorContainerID: null,
      collectionContainerID: null,
    },
  });
  const result = runtime.supportSnapshot("history-op", "old-run");
  assert.equal(result?.active, false);
  assert.equal(result?.observedSupport?.observedAt, 1234);
  assert.equal(result?.observedSupport?.observation.fresh, false);
  assert.equal(runtime.supportSnapshot("history-op", "new-run"), null);
});

test("an expired belt is freed when its exact owner ends, with historical freight intact", () => {
  let now = 1000,
    hasOwner = true,
    record: any = null;
  const store = document("expiry-fixture"),
    target = { kind: "BELT" as const, systemID: 300, name: "Expiry A" };
  let board = createTargetBoard(
    store,
    () => now,
    100,
    (claim) => !hasOwner && canReleaseExpiredTarget(claim, record),
  );
  const claim = board.reserve("expiry", "epoch", target)!;
  assert.ok(board.activate(claim));
  record = {
    version: 1,
    operationID: "expiry",
    runID: "epoch",
    state: "DRAINING",
    stopRequested: true,
    stopFreight: "RETURN_HOME",
    claim,
    manifests: [{ delivered: false }],
    haulClaims: { 100: { dispatched: true } },
    jetcanIntents: {},
  };
  assert.equal(board.reserve("next", "next-epoch", target), null);
  now += 101;
  assert.equal(board.read(claim.key)?.state, "QUARANTINED");
  hasOwner = false;
  board = createTargetBoard(
    store,
    () => now,
    100,
    (claim) => !hasOwner && canReleaseExpiredTarget(claim, record),
  );
  assert.equal(
    canReleaseExpiredTarget(claim, {
      ...record,
      claim: { ...claim, generation: claim.generation + 1 },
    }),
    false,
  );
  assert.equal(canReleaseExpiredTarget(claim, { ...record, state: "ACTIVE" }), true);
  const original = structuredClone(record);
  assert.equal(board.snapshot()[claim.key], undefined);
  const next = board.reserve("next", "next-epoch", target)!;
  assert.ok(next.generation > claim.generation);
  assert.equal(board.resumeDraining(claim), null);
  assert.deepEqual(record, original);
  assert.ok(board.activate(next));
  assert.ok(
    board.noteDepletion(next, { source: "checked-empty-grid", key: next.key, observedAt: now }),
  );
  record = { ...record, operationID: "next", runID: "next-epoch", claim: next };
  now += 101;
  assert.equal(board.reserve("third", "epoch", target), null);
  assert.ok(board.read(next.key)?.depletion);
});
