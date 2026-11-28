import test from "node:test";
import assert from "node:assert/strict";
import { createPatrolOperation, type PatrolPeer } from "./operation.ts";
test("belt and gate patrol share one fighter, settle before travel, and never invent site completion", async () => {
  let clock = 1,
    at = 0,
    entities: any[] = [
      {
        itemID: 20,
        typeID: 2379,
        groupID: 572,
        categoryID: 11,
        kind: "ship",
        isNpc: true,
        isSelf: false,
        geometryAvailable: true,
        npcEntityType: "npc",
        position: { x: 100, y: 0, z: 0 },
      },
    ],
    doc: unknown = null;
  const events: string[] = [];
  const peer: any = {
    characterID: 1,
    shipID: 3,
    botID: "bot",
    sessionGeneration: 1,
    current() {},
    navigate: async (w: any) => {
      events.push(`navigate:${w.itemID}`);
      at = w.itemID;
    },
    assertAtWaypoint: async (w: any) => {
      assert.equal(at, w.itemID);
    },
    view: async () => ({
      characterID: 1,
      shipID: 3,
      systemID: 4,
      shipPosition: { x: 0, y: 0, z: 0 },
      waypointPosition: { x: 0, y: 0, z: 0 },
      entities,
    }),
    fighter: {
      tick: async (id: any, current: () => void) => {
        current();
        events.push(`fight:${id.waypointID}`);
      },
    },
    settle: async () => {
      events.push("settle");
      return { characterID: 1, shipID: 3, modulesInactive: true, dronesSafe: true };
    },
    park: async () => {
      events.push("park");
      return { characterID: 1, shipID: 3, docked: true, destinationID: 9 };
    },
  } as unknown as PatrolPeer;
  const operation = createPatrolOperation({
    operationID: "op",
    operationRunID: "run",
    leaderID: 1,
    waypoints: [
      { systemID: 4, itemID: 8, groupID: 9, name: "Belt" },
      { systemID: 4, itemID: 9, groupID: 10, name: "Gate" },
    ],
    peers: [peer],
    document: {
      read: () => doc,
      write: (v) => {
        doc = structuredClone(v);
      },
    },
    assemblyDocument: { read: () => null, write() {} },
    observationMs: 1000,
    deadline: 99999,
    now: () => clock,
  });
  await operation.tick();
  await operation.tick();
  entities = [];
  await operation.tick();
  clock = 1002;
  await operation.tick();
  await operation.tick();
  await operation.stop();
  assert.deepEqual(events, ["navigate:8", "fight:8", "settle", "navigate:9", "settle", "park"]);
  assert.equal(operation.snapshot().state, "STOPPED");
  assert.equal("receipt" in (doc as object), false);
});
test("unqualified structures, neutral players and NPCs outside the waypoint never become patrol targets", async () => {
  let fought = 0;
  const peer: any = {
    characterID: 1,
    shipID: 3,
    botID: "bot",
    sessionGeneration: 1,
    current() {},
    navigate: async () => {},
    assertAtWaypoint: async () => {},
    view: async () => ({
      characterID: 1,
      shipID: 3,
      systemID: 4,
      shipPosition: { x: 0, y: 0, z: 0 },
      waypointPosition: { x: 0, y: 0, z: 0 },
      entities: [
        {
          itemID: 20,
          typeID: 2379,
          groupID: 572,
          categoryID: 11,
          kind: "ship",
          isNpc: false,
          isSelf: false,
          geometryAvailable: true,
          position: { x: 0, y: 0, z: 0 },
        },
        {
          itemID: 21,
          typeID: 26727,
          groupID: 319,
          categoryID: 11,
          kind: "ship",
          isNpc: true,
          isSelf: false,
          geometryAvailable: true,
          position: { x: 0, y: 0, z: 0 },
        },
        {
          itemID: 22,
          typeID: 2379,
          groupID: 572,
          categoryID: 11,
          kind: "ship",
          isNpc: true,
          isSelf: false,
          geometryAvailable: true,
          position: { x: 500001, y: 0, z: 0 },
        },
      ],
    }),
    fighter: {
      tick: async () => {
        fought++;
      },
    },
    settle: async () => ({ characterID: 1, shipID: 3, modulesInactive: true, dronesSafe: true }),
    park: async () => ({ characterID: 1, shipID: 3, docked: true, destinationID: 9 }),
  };
  const op = createPatrolOperation({
    operationID: "op",
    operationRunID: "run",
    leaderID: 1,
    waypoints: [{ systemID: 4, itemID: 8, groupID: 10, name: "Gate" }],
    peers: [peer],
    document: { read: () => null, write() {} },
    assemblyDocument: { read: () => null, write() {} },
    observationMs: 1000,
    deadline: 99999,
    now: () => 1,
  });
  await op.tick();
  await op.tick();
  assert.equal(fought, 0);
  await op.stop();
});

test("a parked optional patrol anchor hands the existing operation to a qualified successor without a second executor", async () => {
  const calls: string[] = [],
    docs = new Map<string, unknown>(),
    document = (k: string) => ({
      read: () => docs.get(k) ?? null,
      write: (v: unknown) => {
        docs.set(k, structuredClone(v));
      },
    });
  const peers = [1, 2].map((id) => ({
    characterID: id,
    shipID: id + 10,
    botID: "pilot-" + id,
    sessionGeneration: 1,
    required: id !== 1,
    current() {},
    read: async () => ({ state: "ready" as const, fleetID: 90, memberIDs: [1, 2] }),
    invitation: () => null,
    create: async () => {
      throw Error("duplicate fleet");
    },
    invite: async () => {},
    accept: async () => {},
    navigate: async () => {
      calls.push("navigate:" + id);
    },
    assertAtWaypoint: async () => {},
    view: async () => ({
      characterID: id,
      shipID: id + 10,
      systemID: 300,
      shipPosition: { x: 0, y: 0, z: 0 },
      waypointPosition: { x: 0, y: 0, z: 0 },
      entities: [
        {
          itemID: 20,
          typeID: 2379,
          groupID: 572,
          categoryID: 11,
          kind: "ship",
          isNpc: true,
          isSelf: false,
          geometryAvailable: true,
          npcEntityType: "npc",
          position: { x: 100, y: 0, z: 0 },
        },
      ],
    }),
    fighter: {
      tick: async (_id: any, guard: () => void) => {
        guard();
        calls.push("fight:" + id);
      },
    },
    settle: async () => ({
      characterID: id,
      shipID: id + 10,
      modulesInactive: true,
      dronesSafe: true,
    }),
    park: async () => {
      calls.push("park:" + id);
      return { characterID: id, shipID: id + 10, docked: true, destinationID: 600 };
    },
  }));
  const op = createPatrolOperation({
    operationID: "handoff",
    operationRunID: "epoch",
    leaderID: 1,
    waypoints: [{ systemID: 300, itemID: 8, groupID: 10, name: "Gate" }],
    peers,
    document: document("op"),
    assemblyDocument: document("assembly"),
    observationMs: 1000,
    deadline: 99999,
    now: () => 1000,
    successor: async (ids) => {
      assert.deepEqual(ids, [2]);
      return 2;
    },
  });
  await op.tick();
  await op.retire(1, "Operator retired optional anchor");
  peers[0]!.current = () => {
    throw Error("prior hosted session released");
  };
  await op.tick();
  assert.ok(calls.includes("fight:2"));
  assert.equal(calls.includes("fight:1"), false);
  assert.equal(calls.filter((c) => c === "navigate:2").length, 1);
  await op.stop();
  assert.equal(op.snapshot().state, "STOPPED");
  assert.equal(calls.filter((c) => c === "park:1").length, 1);
  assert.equal(calls.filter((c) => c === "park:2").length, 1);
});
