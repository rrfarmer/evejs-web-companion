import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  closestInSystem,
  parseAccessibleStructures,
  parseStructurePositions,
  parkNearest,
  parkWithPolicy,
  decodeParkingPolicy,
  routeDistances,
} from "./parking.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
const entry = (id: number, system: number) => [
  id,
  { type: "dict", entries: [["solarSystemID", system]] },
];
test("native dockable directory is strict and retains only player structures", () => {
  assert.deepEqual(
    parseAccessibleStructures({
      type: "dict",
      entries: [entry(60000004, 30002780), entry(1030000000001, 30002780)],
    }),
    [{ id: 1030000000001, systemID: 30002780 }],
  );
  assert.throws(() => parseAccessibleStructures(null), /unreadable/);
  assert.throws(
    () =>
      parseAccessibleStructures({
        type: "dict",
        entries: [[1030000000001, { type: "dict", entries: [] }]],
      }),
    /system/,
  );
});
test("native cached structure map parses positions without treating unknown as empty", () => {
  const row = {
    type: "packedrow",
    fields: { itemID: 1030000000001, locationID: 30002780, x: 1, y: 2, z: 3 },
  };
  const data = {
    type: "object",
    name: {
      type: "rawstr",
      value: "carbon.common.script.net.objectCaching.CachedMethodCallResult",
    },
    args: [null, { type: "substream", value: { type: "objectex2", list: [row] } }],
  };
  assert.deepEqual(parseStructurePositions(data, 30002780).get(1030000000001), {
    x: 1,
    y: 2,
    z: 3,
  });
  assert.throws(() => parseStructurePositions(null, 30002780), /unreadable/);
  assert.throws(
    () => parseStructurePositions({ type: "objectex2", list: [row, row] }, 30002780),
    /duplicate/,
  );
});
test("nearest uses actual same-system coordinates; graph uses directed gate edges", () => {
  const a = {
      destinationID: 1,
      kind: "station" as const,
      systemID: 3,
      position: { x: 500, y: 0, z: 0 },
    },
    b = { ...a, destinationID: 2, position: { x: 3, y: 0, z: 0 } };
  assert.equal(closestInSystem([a, b], { x: 0, y: 0, z: 0 }).destinationID, 2);
  assert.throws(
    () => closestInSystem([{ ...a, position: null }], { x: 0, y: 0, z: 0 }),
    /incomplete/,
  );
  const distances = routeDistances(1, {
    systems: { "1": "a", "2": "b", "3": "c" },
    edges: [
      [1, 2, 10, 20],
      [2, 3, 21, 30],
    ],
  });
  assert.equal(distances.get(3), 2);
  assert.equal(routeDistances(3, { systems: { "3": "c" }, edges: [] }).has(1), false);
});
test("one bounded parking route returns only after observing exact docking", async () => {
  const data = JSON.parse(
    fs.readFileSync(new URL("./npc-stations-3396210.json", import.meta.url), "utf8"),
  ) as { stations: number[][] };
  const stations = data.stations.filter((row) => row[1] === 30002780),
    chosen = stations[0]!,
    target = chosen[0]!;
  let routed = false,
    sent: number | null = null;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            inSpace: !routed,
            docked: routed,
            shipID: 99,
            solarSystemID: 30002780,
            stationID: routed ? target : null,
          },
        });
      if (p === "/api/bridge/space/snapshot")
        return Response.json({
          ok: true,
          space: {
            inSpace: true,
            solarSystemID: 30002780,
            shipID: 99,
            entities: [],
            ship: { itemID: 99, radius: 1, position: { x: chosen[2], y: chosen[3], z: chosen[4] } },
          },
        });
      if (p === "/api/map/system-stations/30002780")
        return Response.json({ ok: true, stations: stations.map((s) => ({ stationID: s[0] })) });
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: 30002780,
        });
      throw Error(`unexpected ${p}`);
    },
  };
  const session = {
    flow: {
      flying: {
        bridgeAsk: async () => ({ type: "dict", entries: [] }),
        autopilotProgress: () => null,
        abortAutopilot: () => {},
        dockStep: async () => assert.fail("already docked"),
      },
      startRoute: async (id: number) => {
        sent = id;
        routed = true;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const result = await parkNearest(
    run as never,
    session,
    () => {},
    () => {},
  );
  assert.equal(sent, target);
  assert.deepEqual(result, { destinationID: target, kind: "station", systemID: 30002780 });
});

test("already docked is accepted only with a settled, identifiable location", async () => {
  let calls = 0;
  const run = {
    baseUrl: "http://example.test",
    fetch: async () => {
      calls++;
      return Response.json({
        ok: true,
        flight: {
          inSpace: false,
          docked: true,
          shipID: 99,
          solarSystemID: 30002780,
          stationID: 60000004,
        },
      });
    },
  };
  const session = { flow: {} } as unknown as PilotSession;
  assert.deepEqual(
    await parkNearest(
      run as never,
      session,
      () => {},
      () => {},
    ),
    { destinationID: 60000004, systemID: 30002780, kind: "station" },
  );
  assert.equal(calls, 1);
  const unknown = {
    ...run,
    fetch: async () =>
      Response.json({
        ok: true,
        flight: { inSpace: false, docked: true, shipID: 99, solarSystemID: 30002780 },
      }),
  };
  await assert.rejects(
    parkNearest(
      unknown as never,
      session,
      () => {},
      () => {},
    ),
    /Docked location is unknown/,
  );
});

test("an already docked pilot waits for a fresh ready transition without issuing movement", async () => {
  let reads = 0;
  const run = {
    baseUrl: "http://example.test",
    fetch: async () =>
      Response.json({
        ok: true,
        flight: {
          inSpace: false,
          docked: true,
          shipID: 99,
          solarSystemID: 30002780,
          stationID: 60000004,
          transition: { phase: ++reads === 1 ? "session-changing" : "ready" },
        },
      }),
  };
  const result = await parkNearest(
    run as never,
    { flow: {} } as PilotSession,
    () => {},
    () => {},
  );
  assert.deepEqual(result, { destinationID: 60000004, systemID: 30002780, kind: "station" });
  assert.equal(reads, 2);
});
test("a definite session-change refusal after autopilot dock waits for exact physical dock and sends no second Dock", async () => {
  const data = JSON.parse(
    fs.readFileSync(new URL("./npc-stations-3396210.json", import.meta.url), "utf8"),
  ) as { stations: number[][] };
  const stations = data.stations.filter((r) => r[1] === 30002780),
    chosen = stations[0]!,
    target = chosen[0]!;
  let routed = false,
    docked = false,
    calls = 0;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            inSpace: !docked,
            docked,
            shipID: 99,
            solarSystemID: 30002780,
            stationID: docked ? target : null,
            transition: { phase: "ready" },
          },
        });
      if (p === "/api/bridge/space/snapshot")
        return Response.json({
          ok: true,
          space: {
            inSpace: true,
            solarSystemID: 30002780,
            shipID: 99,
            entities: [],
            ship: { itemID: 99, radius: 1, position: { x: chosen[2], y: chosen[3], z: chosen[4] } },
          },
        });
      if (p === "/api/map/system-stations/30002780")
        return Response.json({ ok: true, stations: stations.map((s) => ({ stationID: s[0] })) });
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: 30002780,
        });
      throw Error(`unexpected ${p}`);
    },
  };
  const session = {
    flow: {
      flying: {
        bridgeAsk: async () => ({ type: "dict", entries: [] }),
        autopilotProgress: () => (routed ? { status: "arrived" } : null),
        abortAutopilot() {},
        dockStep: async () => {
          calls++;
          docked = true;
          throw Object.assign(Error("dock transition not ready"), {
            code: "SESSION_CHANGE_IN_PROGRESS",
          });
        },
      },
      startRoute: async () => {
        routed = true;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const result = await parkNearest(
    run as never,
    session,
    () => {},
    () => {},
  );
  assert.equal(result.destinationID, target);
  assert.equal(calls, 1);
});

test("a transport-unknown dock result is never retried", async () => {
  const data = JSON.parse(
      fs.readFileSync(new URL("./npc-stations-3396210.json", import.meta.url), "utf8"),
    ) as { stations: number[][] },
    stations = data.stations.filter((r) => r[1] === 30002780),
    chosen = stations[0]!,
    target = chosen[0]!;
  let calls = 0;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            inSpace: true,
            docked: false,
            shipID: 99,
            solarSystemID: 30002780,
            transition: { phase: "ready" },
          },
        });
      if (p === "/api/bridge/space/snapshot")
        return Response.json({
          ok: true,
          space: {
            inSpace: true,
            solarSystemID: 30002780,
            shipID: 99,
            entities: [],
            ship: { itemID: 99, radius: 1, position: { x: chosen[2], y: chosen[3], z: chosen[4] } },
          },
        });
      if (p === "/api/map/system-stations/30002780")
        return Response.json({ ok: true, stations: stations.map((s) => ({ stationID: s[0] })) });
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: 30002780,
        });
      throw Error(`unexpected ${p}`);
    },
  };
  const session = {
    flow: {
      flying: {
        bridgeAsk: async () => ({ type: "dict", entries: [] }),
        autopilotProgress: () => ({ status: "arrived" }),
        abortAutopilot() {},
        dockStep: async () => {
          calls++;
          throw Error("transport unknown");
        },
      },
      startRoute: async () => ({ started: true }),
    },
  } as unknown as PilotSession;
  await assert.rejects(
    parkNearest(
      run as never,
      session,
      () => {},
      () => {},
    ),
    /transport unknown/,
  );
  assert.equal(calls, 1);
});

test("a definite refused Dock retries only after a fresh ready in-space observation", async () => {
  const data = JSON.parse(
      fs.readFileSync(new URL("./npc-stations-3396210.json", import.meta.url), "utf8"),
    ) as { stations: number[][] },
    stations = data.stations.filter((r) => r[1] === 30002780),
    chosen = stations[0]!,
    target = chosen[0]!;
  let calls = 0,
    readsAfterRefusal = 0,
    docked = false;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status") {
        const phase = calls === 1 && ++readsAfterRefusal === 1 ? "session-changing" : "ready";
        return Response.json({
          ok: true,
          flight: {
            inSpace: !docked,
            docked,
            shipID: 99,
            solarSystemID: 30002780,
            stationID: docked ? target : null,
            transition: { phase },
          },
        });
      }
      if (p === "/api/bridge/space/snapshot")
        return Response.json({
          ok: true,
          space: {
            inSpace: true,
            solarSystemID: 30002780,
            shipID: 99,
            entities: [],
            ship: { itemID: 99, radius: 1, position: { x: chosen[2], y: chosen[3], z: chosen[4] } },
          },
        });
      if (p === "/api/map/system-stations/30002780")
        return Response.json({ ok: true, stations: stations.map((s) => ({ stationID: s[0] })) });
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: 30002780,
        });
      throw Error(`unexpected ${p}`);
    },
  };
  const session = {
    flow: {
      flying: {
        bridgeAsk: async () => ({ type: "dict", entries: [] }),
        autopilotProgress: () => ({ status: "arrived" }),
        abortAutopilot() {},
        dockStep: async () => {
          calls++;
          if (calls === 1)
            throw Object.assign(Error("settling"), { code: "SESSION_CHANGE_IN_PROGRESS" });
          assert.ok(readsAfterRefusal >= 2);
          docked = true;
        },
      },
      startRoute: async () => ({ started: true }),
    },
  } as unknown as PilotSession;
  assert.equal(
    (
      await parkNearest(
        run as never,
        session,
        () => {},
        () => {},
      )
    ).destinationID,
    target,
  );
  assert.equal(calls, 2);
});

test("selected station routes from another dock and verifies exact arrival", async () => {
  let station = 60000004,
    routes = 0;
  const target = 60000005,
    system = 30002780;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            inSpace: false,
            docked: true,
            shipID: 99,
            solarSystemID: system,
            stationID: station,
          },
        });
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: system,
        });
      throw Error(p);
    },
  };
  const session = {
    flow: {
      flying: { abortAutopilot() {}, autopilotProgress: () => null },
      startRoute: async (id: number) => {
        assert.equal(id, target);
        routes++;
        station = target;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  assert.deepEqual(
    await parkWithPolicy(
      run as never,
      session,
      () => {},
      () => {},
      { mode: "selected", kind: "station", destinationID: target, systemID: system },
    ),
    { destinationID: target, systemID: system, kind: "station" },
  );
  assert.equal(routes, 1);
});
test("unlisted structure and malformed selection cannot route", async () => {
  let routes = 0;
  const run = {
    baseUrl: "http://example.test",
    fetch: async () =>
      Response.json({
        ok: true,
        flight: { inSpace: true, docked: false, shipID: 99, solarSystemID: 30002780 },
      }),
  };
  const session = {
    flow: {
      flying: { bridgeAsk: async () => ({ type: "dict", entries: [] }) },
      startRoute: async () => {
        routes++;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  await assert.rejects(
    parkWithPolicy(
      run as never,
      session,
      () => {},
      () => {},
      { mode: "selected", kind: "structure", destinationID: 1030000000001, systemID: 30002780 },
    ),
    /accessible directory/,
  );
  assert.equal(routes, 0);
  assert.equal(
    decodeParkingPolicy({ mode: "selected", kind: "station", destinationID: 1, systemID: 0 }),
    null,
  );
});

test("selected route waits for departure from the original dock", async () => {
  let routed = false,
    checks = 0;
  const from = 60000004,
    target = 60000005,
    system = 30002780;
  const run = {
    baseUrl: "http://example.test",
    fetch: async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/bridge/flight/status") {
        const station = routed && ++checks > 1 ? target : from;
        return Response.json({
          ok: true,
          flight: {
            inSpace: false,
            docked: true,
            shipID: 99,
            solarSystemID: system,
            stationID: station,
          },
        });
      }
      if (p === `/api/map/station/${target}`)
        return Response.json({ ok: true, station: { stationID: target } });
      if (p === `/api/map/resolve/${target}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: target,
          solarSystemID: system,
        });
      throw Error(p);
    },
  };
  const session = {
    flow: {
      flying: { abortAutopilot() {}, autopilotProgress: () => ({ status: "running" }) },
      startRoute: async () => {
        routed = true;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const result = await parkWithPolicy(
    run as never,
    session,
    () => {},
    () => {},
    { mode: "selected", kind: "station", destinationID: target, systemID: system },
  );
  assert.equal(result.destinationID, target);
  assert.equal(checks, 2);
});

test("parking uses stock flight until a fresh read can confirm the selected dock", async () => {
  const destinationID = 60000005,
    systemID = 30002780,
    shipID = 99;
  let step = 0,
    routeStarts = 0,
    flightReads = 0,
    gridReads = 0;
  const flight = () => ({
    shipID,
    solarSystemID: systemID,
    inSpace: step < 3,
    docked: step >= 3,
    stationID: step >= 3 ? destinationID : null,
  });
  const run = {
    baseUrl: "http://example.test",
    fetch: async (input: URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/flight/status")) {
        if (routeStarts) flightReads++;
        return Response.json({ ok: true, flight: flight() });
      }
      if (path.endsWith("/space/snapshot")) {
        gridReads++;
        return Response.json({ ok: true, space: {} });
      }
      if (path === `/api/map/station/${destinationID}`)
        return Response.json({ ok: true, station: { stationID: destinationID } });
      if (path === `/api/map/resolve/${destinationID}`)
        return Response.json({
          ok: true,
          kind: "station",
          stationID: destinationID,
          solarSystemID: systemID,
        });
      throw Error(path);
    },
  };
  const session = {
    store: { flight: { get: () => ({ status: flight() }) } },
    flow: {
      flying: {
        abortAutopilot() {},
        autopilotProgress: () => ({ status: "running", currentSystemID: systemID }),
      },
      startRoute: async () => {
        routeStarts++;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const result = await parkWithPolicy(
    run as never,
    session,
    () => {},
    () => {},
    { mode: "selected", kind: "station", destinationID, systemID },
    {
      wait: async () => {
        assert.ok(++step < 4);
      },
    },
  );
  assert.equal(result.destinationID, destinationID);
  assert.deepEqual(
    { routeStarts, flightReads, gridReads },
    { routeStarts: 1, flightReads: 1, gridReads: 0 },
  );
});
