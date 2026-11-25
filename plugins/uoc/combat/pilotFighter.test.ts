import test from "node:test";
import assert from "node:assert/strict";
import { createPilotFighter, SecurityTargetUnobserved } from "./pilotFighter.ts";
import { FleetRoomRetired } from "./fleetAuthority.ts";
const identity = {
  agentID: 4,
  missionID: 2504,
  titleID: 1,
  acceptedKey: "mission",
  contentID: 2504,
  dungeonID: 875,
  destinationSystemID: 6,
  locationNumber: 0,
  instanceID: 200,
  roomID: 0,
};
function fixture(
  mode:
    | "between-reads"
    | "final-read"
    | "final-range"
    | "wrong-target"
    | "unobserved"
    | "changed"
    | "unknown"
    | "delayed-read"
    | "delayed-write"
    | "timeout-write",
  moduleDocuments?: any,
) {
  let sceneCount = 0,
    activeTarget = 0,
    selected = 42,
    once = true;
  const calls: number[] = [],
    events: string[] = [];
  const state = {
    currentIdentity: identity,
    entryAnchor: { x: 0, y: 0, z: 0 },
    droneUnresolved: false,
  };
  const scene = async () => {
    sceneCount++;
    const absent =
      (mode === "between-reads" && sceneCount === 2) || (mode === "final-read" && sceneCount === 3);
    return {
      sampledAtMs: sceneCount,
      shipID: 11,
      ship: {
        itemID: 11,
        position: { x: 0, y: 0, z: 0 },
        radius: 10,
        hullRatio: 1,
        geometryAvailable: true,
      },
      entities: [
        ...(!absent
          ? [
              {
                itemID: selected,
                kind: "ship",
                isNpc: true,
                npcEntityType: "npc",
                isSelf: false,
                categoryID: 11,
                groupID: 818,
                typeID: mode === "wrong-target" && sceneCount === 3 ? 26727 : 16087,
                geometryAvailable: true,
                position: {
                  x: mode === "final-range" && sceneCount === 3 ? 100000 : 100,
                  y: 0,
                  z: 0,
                },
                radius: 10,
                shieldRatio: 1,
                armorRatio: 1,
                hullRatio: 1,
              },
            ]
          : []),
        {
          itemID: 8,
          kind: "drone",
          ownerID: 1,
          controllerID: 11,
          targetEntityID: activeTarget || null,
          geometryAvailable: true,
          position: { x: 0, y: 0, z: 0 },
          shieldRatio: 1,
          armorRatio: 1,
          hullRatio: 1,
        },
      ],
    } as any;
  };
  const fighter = createPilotFighter({
    run: { characterID: 1 } as any,
    session: () =>
      ({
        store: { fitting: { get: () => ({}) } },
        flow: {
          flying: {
            classifyDroneRoles: async () => ({ bay: { combat: [] }, out: { combat: [8] } }),
            readFit: async () => true,
            resolveDroneControlRange: async () => 45000,
          },
          approach: async () => {},
        },
      }) as any,
    state,
    current() {},
    guard() {},
    flight: async () => ({ inSpace: true, shipID: 11 }),
    scene,
    dungeon: async () => ({ dungeonID: 875, instanceID: 200, roomID: 0 }),
    mission: async () => ({ objective: { offer: { key: "mission", status: "accepted" } } }),
    ask: async (_svc, method, args) => {
      if (method === "List") return { type: "list", items: [] };
      if (method === "CmdEngage") {
        calls.push(Number(args?.[1]));
        if (mode === "unknown") throw Error("unknown native response");
        if (mode === "delayed-write") await new Promise<void>((r) => setTimeout(r, 11000));
        if (mode === "timeout-write") await new Promise<void>(() => {});
        activeTarget = Number(args?.[1]);
        return { type: "dict", entries: [] };
      }
      return null;
    },
    diagnostic: (kind) => events.push(kind),
    droneSample: () => null,
    fenceCombat: async (target) => {
      if (mode === "delayed-read" && once) {
        once = false;
        await new Promise<void>((r) => setTimeout(r, 11000));
      }
      if (target !== null && once && (mode === "unobserved" || mode === "changed")) {
        once = false;
        throw mode === "changed"
          ? new FleetRoomRetired("primary changed")
          : new SecurityTargetUnobserved("absent");
      }
    },
    sleep: async () => {},
    moduleDocuments,
  });
  return {
    fighter,
    calls,
    events,
    select: (id: number) => {
      selected = id;
    },
    state,
  };
}
test("classified drones may continue after an unreadable untouched module fit, never after a module intent", async () => {
  const blank = { read: () => null, write() {} },
    untouched = fixture("unobserved", { locks: blank, actions: blank });
  await untouched.fighter.tick(identity, () => {});
  assert.ok(untouched.events.includes("combat-fit-unavailable"));
  const pending = fixture("unobserved", {
    locks: blank,
    actions: { read: () => ({ version: 1, entries: [{ status: "DISPATCHED" }] }), write() {} },
  });
  await assert.rejects(
    pending.fighter.tick(identity, () => {}),
    /fitting does not match/,
  );
  assert.deepEqual(pending.calls, []);
});
test("target vanishing between fresh fence and scene skips native engage and permits new primary", async () => {
  for (const mode of ["between-reads", "final-read"] as const) {
    const x = fixture(mode);
    await x.fighter.tick(identity, () => {});
    assert.deepEqual(x.calls, []);
    assert.ok(x.events.includes("engage-not-dispatched"));
    x.select(43);
    await x.fighter.tick(identity, () => {});
    assert.deepEqual(x.calls, [43]);
  }
});
test("absent target or changed generation before dispatch does not poison fighter", async () => {
  for (const mode of ["unobserved", "changed"] as const) {
    const x = fixture(mode);
    await x.fighter.tick(identity, () => {});
    assert.deepEqual(x.calls, []);
    x.select(43);
    await x.fighter.tick(identity, () => {});
    assert.deepEqual(x.calls, [43]);
  }
});
test("unknown native engage response is never replayed", async () => {
  const x = fixture("unknown");
  await assert.rejects(
    x.fighter.tick(identity, () => {}),
    /unknown native response/,
  );
  await assert.rejects(
    x.fighter.tick(identity, () => {}),
    /no longer observable/,
  );
  assert.deepEqual(x.calls, [42]);
});

test("an unissued target may be reconsidered when freshly visible again", async () => {
  const x = fixture("between-reads");
  await x.fighter.tick(identity, () => {});
  assert.deepEqual(x.calls, []);
  await x.fighter.tick(identity, () => {});
  assert.deepEqual(x.calls, [42]);
});

test("target leaving native control range at final observation is not dispatched", async () => {
  const x = fixture("final-range");
  await x.fighter.tick(identity, () => {});
  assert.deepEqual(x.calls, []);
  assert.ok(x.events.includes("engage-not-dispatched"));
  x.select(43);
  await x.fighter.tick(identity, () => {});
  assert.deepEqual(x.calls, [43]);
});

test("a present but unqualified final target is refused without native engage", async () => {
  const x = fixture("wrong-target");
  await assert.rejects(
    x.fighter.tick(identity, () => {}),
    /identity is not qualified/,
  );
  assert.deepEqual(x.calls, []);
});

test("native read and engage tolerate eleven-second stalls without another dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["delayed-read", "delayed-write"] as const) {
    const x = fixture(mode),
      pending = x.fighter.tick(identity, () => {});
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(11000);
    await pending;
    assert.deepEqual(x.calls, [42]);
    assert.equal(x.state.droneUnresolved, false);
  }
});
test("an expired unknown native engage retains custody and is never reissued", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = fixture("timeout-write"),
    pending = x.fighter.tick(identity, () => {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(x.calls, [42]);
  const rejected = assert.rejects(pending, /still in flight/);
  t.mock.timers.tick(90000);
  await rejected;
  assert.equal(x.state.droneUnresolved, true);
  await assert.rejects(
    x.fighter.tick(identity, () => {}),
    /no longer observable/,
  );
  assert.deepEqual(x.calls, [42]);
  await assert.rejects(
    x.fighter.settle(() => {}),
    /custody is retained/,
  );
});

function launchFixture(timeout: boolean) {
  let out = false,
    calls = 0;
  const state = {
    currentIdentity: identity,
    entryAnchor: { x: 0, y: 0, z: 0 },
    droneUnresolved: false,
  };
  const fighter = createPilotFighter({
    run: { characterID: 1 } as any,
    session: () =>
      ({
        flow: {
          flying: {
            classifyDroneRoles: async () => ({
              bay: { combat: [7] },
              out: { combat: out ? [8] : [] },
            }),
          },
        },
      }) as any,
    state,
    current() {},
    guard() {},
    flight: async () => ({ inSpace: true, shipID: 11 }),
    mission: async () => ({}),
    dungeon: async () => ({}),
    scene: async () =>
      ({
        shipID: 11,
        ship: { hullRatio: 1, position: { x: 0, y: 0, z: 0 } },
        entities: out
          ? [
              {
                itemID: 8,
                kind: "drone",
                ownerID: 1,
                controllerID: 11,
                targetEntityID: null,
                shieldRatio: 1,
                armorRatio: 1,
                hullRatio: 1,
              },
            ]
          : [],
      }) as any,
    ask: async (_svc, method) => {
      if (method === "List")
        return {
          type: "list",
          items: [{ itemID: 7, typeID: 2454, ownerID: 1, locationID: 11, flagID: 87, quantity: 1 }],
        };
      if (method === "LaunchDrones") {
        calls++;
        if (timeout) await new Promise<void>(() => {});
        else await new Promise<void>((r) => setTimeout(r, 11000));
        out = true;
        return { type: "dict", entries: [[7, { type: "list", items: [8] }]] };
      }
      return null;
    },
    diagnostic() {},
    droneSample: () => null,
    fenceCombat: async () => {},
    sleep: async () => {},
  });
  return { fighter, state, calls: () => calls };
}
test("a delayed launch is dispatched once and verified from actual drone custody", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = launchFixture(false),
    pending = x.fighter.tick(identity, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(x.calls(), 1);
  t.mock.timers.tick(11000);
  await pending;
  assert.equal(x.calls(), 1);
  assert.equal(x.state.droneUnresolved, false);
});
test("an unknown timed-out launch retains custody and cannot launch again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = launchFixture(true),
    pending = x.fighter.tick(identity, () => {});
  await new Promise((r) => setImmediate(r));
  const rejected = assert.rejects(pending, /still in flight/);
  t.mock.timers.tick(90000);
  await rejected;
  assert.equal(x.state.droneUnresolved, true);
  await assert.rejects(
    x.fighter.tick(identity, () => {}),
    /did not launch/,
  );
  await assert.rejects(
    x.fighter.settle(() => {}),
    /custody is retained/,
  );
  assert.equal(x.calls(), 1);
});
