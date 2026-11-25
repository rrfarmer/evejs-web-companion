import test from "node:test";
import assert from "node:assert/strict";
import { createSignal } from "../../../../web/src/store/signals.ts";
import { createAnomalyOperation } from "./operation.ts";
const site = {
    systemID: 300,
    scannerKey: 55,
    instanceID: 89,
    dungeonID: 5579,
    label: "ABC-123",
    position: { x: 1, y: 2, z: 3 },
    observedAt: 1000,
  },
  catalog = [{ dungeonID: 5579, enabled: true, entryRoomID: 0, typeGroups: { "11040": 550 } }];
function fixture(count = 2) {
  let at = 1000,
    current = true,
    wrong = false;
  const live = createSignal<any>({
      status: "live",
      epoch: "e",
      sequence: 5,
      notifications: [],
      lastEventAtMs: null,
      questions: [],
    }),
    docs = new Map<string, unknown>(),
    calls: string[] = [],
    receipts: unknown[] = [];
  const store = (key: string) => ({
    read: () => docs.get(key) ?? null,
    write: (v: unknown) => {
      docs.set(key, structuredClone(v));
      if (key === "receipt") receipts.push(structuredClone(v));
    },
  });
  const npc = {
    kind: "ship",
    itemID: 90,
    typeID: 11040,
    groupID: 550,
    categoryID: 11,
    isNpc: true,
    isSelf: false,
    geometryAvailable: true,
    npcEntityType: "npc",
    position: { x: 2, y: 2, z: 3 },
  };
  let npcs = [npc];
  const peers = Array.from({ length: count }, (_, i) => i + 1).map((i) => ({
    characterID: i,
    shipID: i + 10,
    botID: `bot${i}`,
    sessionGeneration: 1,
    session: { store: { live } },
    current() {
      if (!current) throw Error("retired");
    },
    async read() {
      return {
        state: "ready" as const,
        fleetID: 90,
        memberIDs: Array.from({ length: count }, (_, i) => i + 1),
      };
    },
    invitation: () => null,
    async create() {
      throw Error("unexpected create");
    },
    async invite() {
      throw Error("unexpected invite");
    },
    async accept() {
      throw Error("unexpected accept");
    },
    async view() {
      return {
        characterID: i,
        shipID: i + 10,
        systemID: 300,
        inSpace: true,
        inWarp: false,
        shipPosition: { x: 1, y: 2, z: 3 },
        keeper: { dungeonID: 5579, instanceID: wrong ? 99 : 89, roomID: 0 },
        sampledAt: at,
        npcs,
      };
    },
    async navigate() {
      calls.push(`navigate:${i}`);
    },
    fighter: {
      async tick(identity: any, guard: () => void) {
        guard();
        assert.equal(identity.kind, "combat-anomaly");
        assert.equal("acceptedKey" in identity, false);
        calls.push(`fight:${i}`);
      },
    },
    async settle() {
      calls.push(`settle:${i}`);
      return {
        characterID: i,
        shipID: i + 10,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: at,
      };
    },
    async park() {
      calls.push(`park:${i}`);
      return { characterID: i, shipID: i + 10, docked: true, destinationID: 600, observedAt: at };
    },
  }));
  const op = createAnomalyOperation({
    operationID: "op",
    operationRunID: "run",
    site,
    entryRoomID: 0,
    leaderID: 1,
    peers: peers as any,
    catalog,
    document: store("op"),
    assemblyDocument: store("assembly"),
    receiptDocument: store("receipt"),
    readSites: async () => [{ ...site, observedAt: at }],
    assertSiteClaim: () => {
      if (!current) throw Error("claim lost");
    },
    now: () => at,
    sleep: async () => {
      at += 10000;
    },
  });
  return {
    op,
    calls,
    receipts,
    peers,
    advance: (ms: number) => {
      at += ms;
    },
    wrong: () => {
      wrong = true;
    },
    empty: () => {
      npcs = [];
    },
    notify: () => {
      at++;
      const s = live.get();
      live.set({
        ...s,
        sequence: 9,
        notifications: [
          {
            kind: "notification",
            service: null,
            method: "OnDungeonCompleted",
            args: [5579],
            receivedAtMs: at,
          },
        ],
      });
    },
    disconnect: () => live.set({ ...live.get(), status: "degraded" }),
  };
}
test("native fleet and exact room precede shared qualified target; only native completion yields receipt", async () => {
  const x = fixture();
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  await x.op.tick();
  assert.equal(x.op.authority().primary, 90);
  assert.deepEqual(x.calls.slice(0, 4), ["navigate:1", "navigate:2", "fight:1", "fight:2"]);
  assert.equal(x.receipts.length, 0);
  x.notify();
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "STOPPED");
  assert.equal(x.receipts.length, 1);
  assert.equal((x.receipts[0] as any).site.instanceID, 89);
  assert.ok(
    x.calls.includes("settle:1") &&
      x.calls.includes("settle:2") &&
      x.calls.includes("park:1") &&
      x.calls.includes("park:2"),
  );
});
test("empty NPC overview cannot count as completion", async () => {
  const x = fixture();
  await x.op.tick();
  x.empty();
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  assert.equal(x.receipts.length, 0);
  await x.op.stop();
});
test("wrong native instance or interrupted live stream never produces completion", async () => {
  const x = fixture();
  x.wrong();
  await assert.rejects(x.op.tick(), /exact observed anomaly room/);
  assert.equal(x.receipts.length, 0);
  assert.equal(
    x.calls.some((c) => c.startsWith("fight:")),
    false,
  );
  await x.op.stop();
  const y = fixture();
  await y.op.tick();
  y.disconnect();
  await assert.rejects(y.op.tick(), /continuity/);
  assert.equal(y.receipts.length, 0);
  await y.op.stop();
});

test("native per-pilot fence rejects a different primary, generation or room", async () => {
  const x = fixture();
  await x.op.tick();
  await x.op.tick();
  const g = x.op.authority().primaryGeneration;
  await x.op.fence(2, 90, g);
  assert.throws(() => x.op.assertTarget(2, 91, g), /authority changed/);
  await assert.rejects(x.op.fence(2, 90, g - 1), /authority changed/);
  x.wrong();
  await assert.rejects(x.op.fence(2, 90, g), /exact observed anomaly room/);
  await x.op.stop();
});

test("unsettled member blocks all parking and never marks group stopped", async () => {
  const x = fixture();
  await x.op.tick();
  x.peers[1]!.settle = async () => {
    throw Error("unresolved drones");
  };
  x.notify();
  await assert.rejects(x.op.tick(), /unresolved drones/);
  assert.equal(x.op.snapshot().state, "SETTLING");
  assert.equal(
    x.calls.some((c) => c.startsWith("park:")),
    false,
  );
  assert.equal(x.receipts.length, 1);
});

test("concurrent per-pilot fences share one verified fleet read", async () => {
  const x = fixture();
  await x.op.tick();
  await x.op.tick();
  const g = x.op.authority().primaryGeneration;
  await Promise.all([x.op.fence(1, 90, g), x.op.fence(2, 90, g)]);
  await x.op.stop();
});

test("member failure waits for the other native action before settlement", async () => {
  const x = fixture();
  await x.op.tick();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      started = r;
    });
  x.peers[0]!.fighter.tick = async () => {
    throw Error("member failed");
  };
  x.peers[1]!.fighter.tick = async () => {
    started();
    await held;
  };
  const fighting = x.op.tick();
  await ready;
  const stopping = x.op.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(
    x.calls.some((c) => c.startsWith("settle:")),
    false,
  );
  release();
  await assert.rejects(fighting, /member failed/);
  await stopping;
  assert.ok(x.calls.includes("settle:1") && x.calls.includes("settle:2"));
});

test("room view retries stale and failed native reads before accepting the exact keeper", async () => {
  const x = fixture(),
    original = x.peers[0]!.view;
  let reads = 0;
  x.peers[0]!.view = async () => {
    reads++;
    if (reads === 2) throw Error("native scene temporarily unavailable");
    const v = await original();
    return { ...v, sampledAt: reads === 1 ? v.sampledAt - 70000 : v.sampledAt + 500 };
  };
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  assert.ok(reads >= 4);
  assert.equal(x.receipts.length, 0);
  await x.op.stop();
});
test("an exact but far-future room sample is retried, never treated as entry", async () => {
  const x = fixture(),
    original = x.peers[0]!.view;
  let reads = 0;
  x.peers[0]!.view = async () => {
    reads++;
    const v = await original();
    return { ...v, sampledAt: reads === 1 ? v.sampledAt + 5001 : v.sampledAt };
  };
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  assert.ok(reads >= 3);
  assert.equal(x.receipts.length, 0);
  await x.op.stop();
});

test("each timely settlement and dock proof survives another pilot taking two minutes", async () => {
  const x = fixture();
  await x.op.tick();
  let releaseSettle!: () => void, releasePark!: () => void;
  const settleGate = new Promise<void>((r) => (releaseSettle = r)),
    parkGate = new Promise<void>((r) => (releasePark = r)),
    settle = x.peers[1]!.settle,
    park = x.peers[1]!.park;
  x.peers[1]!.settle = async () => {
    await settleGate;
    x.advance(120000);
    return settle();
  };
  x.peers[1]!.park = async () => {
    await parkGate;
    x.advance(120000);
    return park();
  };
  const stopping = x.op.stop();
  await new Promise((r) => setImmediate(r));
  releaseSettle();
  await new Promise((r) => setImmediate(r));
  assert.ok(x.calls.includes("park:1"));
  releasePark();
  await stopping;
  assert.equal(x.op.snapshot().state, "STOPPED");
  assert.ok(x.calls.includes("park:2"));
});
test("a mismatched individual docking receipt still blocks completion", async () => {
  const x = fixture();
  await x.op.tick();
  x.peers[1]!.park = async () => ({
    characterID: 2,
    shipID: 999,
    docked: true,
    destinationID: 600,
    observedAt: 1000,
  });
  await assert.rejects(x.op.stop(), /parking is unavailable/);
  assert.equal(x.op.snapshot().state, "SETTLING");
});

test("exact held native proofs and keeper permit room view despite simulation clock offset", async () => {
  const x = fixture();
  x.advance(2000000);
  for (const peer of x.peers) {
    const view = peer.view;
    peer.view = async () => {
      const v = await view(),
        sim = v.sampledAt - 1620000;
      return {
        ...v,
        sampledAt: sim,
        keeperObservedAt: v.sampledAt,
        nativeProof: {
          kind: "native-own-ship-location",
          characterID: peer.characterID,
          shipID: peer.shipID,
          systemID: 300,
          locationID: 300,
          botID: peer.botID,
          sessionGeneration: 1,
          readStartedAt: v.sampledAt - 1,
          readFinishedAt: v.sampledAt,
          timeFiletime: "134385676761330000",
          wallclockFiletime: "134385676761330001",
          simulationSampledAt: sim,
        },
      };
    };
  }
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  await x.op.tick();
  assert.equal(x.op.authority().primary, 90);
  assert.equal(x.receipts.length, 0);
  await x.op.stop();
});

test("one pilot uses the same native completion and settlement without fleet writes", async () => {
  const x = fixture(1);
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "COMBAT");
  await x.op.tick();
  assert.deepEqual(x.calls.slice(0, 2), ["navigate:1", "fight:1"]);
  x.notify();
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "STOPPED");
  assert.equal(x.receipts.length, 1);
  assert.ok(x.calls.includes("settle:1") && x.calls.includes("park:1"));
});

test("optional anomaly assistant retires through its original native settle/Parking while the anchor keeps fighting", async () => {
  const x = fixture();
  (x.peers[1] as any).required = false;
  await x.op.tick();
  const retired = await x.op.retire(2, "Operator retired optional assistant");
  assert.equal(retired?.destinationID, 600);
  await x.op.tick();
  assert.ok(x.calls.includes("fight:1"));
  assert.equal(x.calls.includes("fight:2"), false);
  assert.equal(x.op.snapshot().state, "COMBAT");
  assert.throws(
    () => x.op.assertTarget(2, 90, x.op.authority().primaryGeneration),
    /authority changed/,
  );
  x.notify();
  await x.op.tick();
  assert.equal(x.op.snapshot().state, "STOPPED");
  assert.equal(x.calls.filter((c) => c === "park:2").length, 1);
  assert.equal(x.receipts.length, 1);
});
test("unknown optional anomaly ownership preserves healthy combat but cannot fabricate the missing Parking proof", async () => {
  const x = fixture();
  (x.peers[1] as any).required = false;
  await x.op.tick();
  x.peers[1]!.current = () => {
    throw Error("unknown owner");
  };
  await x.op.tick();
  assert.ok(x.calls.includes("fight:1"));
  assert.equal(x.op.snapshot().state, "COMBAT");
  await assert.rejects(x.op.stop(), /Retired anomaly custody/);
  assert.notEqual(x.op.snapshot().state, "STOPPED");
  assert.equal(x.receipts.length, 0);
});
