import test from "node:test";
import assert from "node:assert/strict";
import { createFleetNavigation } from "./fleetNavigation.ts";
const mission = {
  agentID: 10,
  missionID: 2504,
  titleID: 1,
  acceptedKey: "mission",
  contentID: 2504,
  dungeonID: 875,
  destinationSystemID: 300,
  locationNumber: 0,
  instanceID: 40,
  roomID: 1,
};
test("an uncertain fleet warp persists and is never repeated; only exact observed room retires it", async () => {
  let row: unknown = null,
    calls = 0;
  const store = {
    read: () => row,
    write: (v: unknown) => {
      row = structuredClone(v);
    },
  };
  const nav = createFleetNavigation(store, "op"),
    f = { docked: false, inSpace: true, inWarp: false, systemID: 300, roomMatches: false, mission },
    ops = {
      guard: () => {},
      undock: async () => {},
      route: async () => {},
      warp: async () => {
        calls++;
        throw Error("lost acknowledgement");
      },
    };
  await assert.rejects(nav.step(f, ops), /lost acknowledgement/);
  assert.equal((row as any).pending.kind, "fleet-warp");
  assert.equal(await nav.step(f, ops), "pending");
  assert.equal(calls, 1);
  await assert.rejects(
    nav.step({ ...f, roomMatches: true, mission: { ...mission, roomID: 2 } }, ops),
    /another room/,
  );
  assert.equal(await nav.step({ ...f, roomMatches: true }, ops), "arrived");
  assert.equal((row as any).pending, null);
});
test("unknown undock is reconciled only by observed space; then one warp may be sent", async () => {
  let row: unknown = null,
    undocks = 0,
    warps = 0;
  const nav = createFleetNavigation(
      {
        read: () => row,
        write: (v) => {
          row = v;
        },
      },
      "op",
    ),
    ops = {
      guard: () => {},
      undock: async () => {
        undocks++;
        throw Error("unknown");
      },
      route: async () => {},
      warp: async () => {
        warps++;
      },
    };
  const f = {
    docked: true,
    inSpace: false,
    inWarp: false,
    systemID: 300,
    roomMatches: false,
    mission,
  };
  await assert.rejects(nav.step(f, ops), /unknown/);
  assert.equal(await nav.step(f, ops), "pending");
  assert.equal(undocks, 1);
  assert.equal(await nav.step({ ...f, docked: false, inSpace: true }, ops), "dispatched");
  assert.equal(warps, 1);
});

test("Stop reconciles a physically observed undock read-only and preserves the original intent", async () => {
  let row: any = null,
    undocks = 0;
  const nav = createFleetNavigation(
      {
        read: () => row,
        write: (v) => {
          row = structuredClone(v);
        },
      },
      JSON.stringify(["op", "run", 1, 11]),
    ),
    f = { docked: true, inSpace: false, inWarp: false, systemID: 300, roomMatches: false, mission };
  await nav.step(f, {
    guard() {},
    undock: async () => {
      undocks++;
    },
    route: async () => {},
    warp: async () => {},
  });
  const original = structuredClone(row.pending),
    o = {
      characterID: 1,
      shipID: 11,
      observedAt: original.at + 10,
      inSpace: true,
      docked: false,
      inWarp: false,
      systemID: 300,
      scene: { shipID: 11, systemID: 300, sampledAt: original.at + 5 },
      keeper: null,
    };
  assert.equal(
    nav.reconcile(o, { characterID: 1, shipID: 11, mission: null }, () => {}),
    "settled",
  );
  assert.equal(row.pending, null);
  assert.deepEqual(row.retired[0].intent, original);
  assert.equal(row.retired[0].outcome, "PHYSICALLY_OBSERVED");
  assert.equal(undocks, 1);
});
test("Stop never retires pending movement without exact fresh physical proof", async () => {
  for (const mode of ["ship", "old-scene", "warp", "system", "keeper"]) {
    let row: any = null,
      writes = 0;
    const nav = createFleetNavigation(
        {
          read: () => row,
          write: (v) => {
            row = structuredClone(v);
            writes++;
          },
        },
        JSON.stringify(["op", "run", 1, 11]),
      ),
      f = {
        docked: false,
        inSpace: true,
        inWarp: false,
        systemID: 300,
        roomMatches: false,
        mission,
      };
    await nav.step(f, {
      guard() {},
      undock: async () => {},
      route: async () => {},
      warp: async () => {},
    });
    const original = structuredClone(row.pending),
      o = {
        characterID: 1,
        shipID: mode === "ship" ? 12 : 11,
        observedAt: original.at + 10,
        inSpace: true,
        docked: false,
        inWarp: mode === "warp",
        systemID: mode === "system" ? 301 : 300,
        scene: {
          shipID: 11,
          systemID: 300,
          sampledAt: mode === "old-scene" ? original.at - 1 : original.at + 5,
        },
        keeper: { dungeonID: 875, instanceID: mode === "keeper" ? 41 : 40, roomID: 1 },
      };
    assert.equal(
      nav.reconcile(o, { characterID: 1, shipID: 11, mission }, () => {}),
      "pending",
      mode,
    );
    assert.deepEqual(row.pending, original);
    assert.equal(writes, 1);
  }
});
test("Stop retires exact fleet warp only with original mission and native keeper", async () => {
  let row: any = null;
  const nav = createFleetNavigation(
      {
        read: () => row,
        write: (v) => {
          row = structuredClone(v);
        },
      },
      JSON.stringify(["op", "run", 1, 11]),
    ),
    f = { docked: false, inSpace: true, inWarp: false, systemID: 300, roomMatches: false, mission };
  await nav.step(f, {
    guard() {},
    undock: async () => {},
    route: async () => {},
    warp: async () => {},
  });
  const p = row.pending,
    o = {
      characterID: 1,
      shipID: 11,
      observedAt: p.at + 5,
      inSpace: true,
      docked: false,
      inWarp: false,
      systemID: 300,
      scene: { shipID: 11, systemID: 300, sampledAt: p.at + 1 },
      keeper: { dungeonID: 875, instanceID: 40, roomID: 1 },
    };
  assert.equal(
    nav.reconcile(
      o,
      { characterID: 1, shipID: 11, mission: { ...mission, acceptedKey: "other" } },
      () => {},
    ),
    "pending",
  );
  assert.equal(
    nav.reconcile(o, { characterID: 1, shipID: 11, mission }, () => {}),
    "settled",
  );
});

test("Stop settles an original route only in its exact observed destination system", async () => {
  let row: any = null,
    routes = 0;
  const nav = createFleetNavigation(
      {
        read: () => row,
        write: (v) => {
          row = structuredClone(v);
        },
      },
      JSON.stringify(["op", "run", 1, 11]),
    ),
    f = { docked: false, inSpace: true, inWarp: false, systemID: 301, roomMatches: false, mission };
  await nav.step(f, {
    guard() {},
    undock: async () => {},
    route: async () => {
      routes++;
    },
    warp: async () => {},
  });
  const p = row.pending,
    o = {
      characterID: 1,
      shipID: 11,
      observedAt: p.at + 20,
      inSpace: true,
      docked: false,
      inWarp: false,
      systemID: 300,
      scene: { shipID: 11, systemID: 300, sampledAt: p.at + 10 },
      keeper: null,
    };
  assert.equal(p.kind, "route");
  assert.equal(
    nav.reconcile(o, { characterID: 1, shipID: 11, mission: null }, () => {}),
    "settled",
  );
  assert.equal(row.retired[0].intent.systemID, 300);
  assert.equal(routes, 1);
});
const missionTwo = {
  agentID: 10,
  missionID: 2925,
  titleID: 1,
  acceptedKey: "m",
  contentID: 2925,
  dungeonID: 1940,
  destinationSystemID: 300,
  locationNumber: 0,
  instanceID: 40,
  roomID: 0,
};
test("pending fleet warp reconciles an exact fresh native ship and keeper even with a 27-minute simulation offset", async () => {
  let row: any = null,
    writes = 0,
    warps = 0;
  const nav = createFleetNavigation(
    {
      read: () => row,
      write: (v) => {
        row = structuredClone(v);
        writes++;
      },
    },
    JSON.stringify(["op", "run", 1, 11]),
  );
  await nav.step(
    {
      docked: false,
      inSpace: true,
      inWarp: false,
      systemID: 300,
      roomMatches: false,
      mission: missionTwo,
    },
    {
      guard() {},
      undock: async () => {},
      route: async () => {},
      warp: async () => {
        warps++;
      },
    },
  );
  const p = row.pending,
    sim = p.at - 1634000,
    base = {
      characterID: 1,
      shipID: 11,
      observedAt: p.at + 100,
      inSpace: true,
      docked: false,
      inWarp: false,
      systemID: 300,
      scene: { shipID: 11, systemID: 300, sampledAt: sim },
      keeper: { dungeonID: 1940, instanceID: 40, roomID: 0 },
      keeperObservedAt: p.at + 90,
      nativeProof: {
        kind: "native-own-ship-location" as const,
        characterID: 1,
        shipID: 11,
        systemID: 300,
        locationID: 300,
        readStartedAt: p.at + 10,
        readFinishedAt: p.at + 20,
        timeFiletime: "134385676761330000",
        wallclockFiletime: "134385676761330001",
        simulationSampledAt: sim,
      },
    };
  for (const x of [
    { ...base, nativeProof: { ...base.nativeProof, shipID: 12 } },
    { ...base, nativeProof: { ...base.nativeProof, readStartedAt: p.at - 1 } },
    { ...base, keeper: { ...base.keeper, instanceID: 41 } },
    { ...base, keeperObservedAt: p.at + 19 },
  ]) {
    assert.equal(
      nav.reconcile(x, { characterID: 1, shipID: 11, mission: missionTwo }, () => {}),
      "pending",
    );
    assert.ok(row.pending);
  }
  assert.equal(
    nav.reconcile(base, { characterID: 1, shipID: 11, mission: missionTwo }, () => {}),
    "settled",
  );
  assert.equal(warps, 1);
  assert.equal(writes, 2);
  assert.equal(row.retired[0].intent.at, p.at);
});
