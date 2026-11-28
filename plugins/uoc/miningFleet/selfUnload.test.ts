import { officeList, corporationRow } from "./corporateOfficeFixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createSelfUnload, createNativeSelfUnload } from "./selfUnload.ts";
import { FleetObservationUnavailable } from "./stopSignal.ts";
function memory() {
  let x: unknown = null;
  return {
    read: () => structuredClone(x),
    write: (v: unknown) => {
      x = structuredClone(v);
    },
  };
}
function fixture() {
  const store = memory(),
    calls: string[] = [],
    item = { itemID: 20, typeID: 30, quantity: 8 };
  let rows = [item],
    lost = false,
    receipts = new Map<number, any>();
  const driver = createSelfUnload({
    operationID: "op",
    runID: "run",
    characterID: 1,
    shipID: 11,
    destinationID: 600,
    current() {},
    store,
    settle: async () => {
      calls.push("settle");
    },
    readRaw: async () => structuredClone(rows),
    travel: async () => {
      calls.push("travel");
    },
    deposit: async (source, ordinal) => {
      calls.push(`deposit:${ordinal}`);
      if (receipts.has(ordinal)) return receipts.get(ordinal);
      rows = [];
      const receipt: any = {
        source,
        destinationID: 600,
        corporationID: 77,
        division: 1,
        officeID: 700,
        completedAt: 1,
        batches: [],
      };
      receipts.set(ordinal, receipt);
      if (lost) {
        lost = false;
        throw Error("post-deposit acknowledgement lost");
      }
      return receipt;
    },
  });
  return {
    driver,
    calls,
    setRows: (r: typeof rows) => {
      rows = r;
    },
    lose: () => {
      lost = true;
    },
  };
}
test("independent self-unload trips preserve source identity and increment durable ordinals", async () => {
  const x = fixture();
  assert.equal((await x.driver.trip()).deposited, true);
  x.setRows([{ itemID: 21, typeID: 30, quantity: 4 }]);
  assert.equal((await x.driver.trip()).deposited, true);
  assert.deepEqual(x.calls, ["settle", "travel", "deposit:1", "settle", "travel", "deposit:2"]);
  assert.deepEqual(x.driver.snapshot().totals, {
    trips: 2,
    unitsByType: { "30": 12 },
    volumeM3: null,
  });
});
test("an old self-unload resumes its pending ordinal with compact totals", async () => {
  const store = memory(),
    from = {
      kind: "own-ship-raw" as const,
      operationID: "o",
      runID: "r",
      characterID: 1,
      shipID: 11,
    };
  const previous = { itemID: 20, typeID: 30, quantity: 8 },
    item = { itemID: 21, typeID: 31, quantity: 4 };
  const deposit = (
    source: typeof from & {
      items: readonly { itemID: number; typeID: number; quantity: number }[];
    },
  ) => ({
    source,
    destinationID: 600,
    corporationID: 77,
    division: 1,
    officeID: 700,
    completedAt: 1,
    batches: [],
  });
  store.write({
    version: 1,
    identity: '["o","r",1,11]',
    nextOrdinal: 3,
    pending: {
      ordinal: 2,
      items: [item],
      movement: { destinationID: 600, routeIssuedAt: 1, dockIssuedAt: 2, arrivedAt: 3 },
    },
    receipts: [{ ordinal: 1, receipt: deposit({ ...from, items: [previous] }) }],
  });
  const driver = createSelfUnload({
    ...from,
    destinationID: 600,
    current() {},
    store,
    readRaw: async () => [],
    settle: async () => {},
    travel: async (movement) => assert.equal(movement.arrivedAt, 3),
    deposit: async (source, ordinal) => {
      assert.equal(ordinal, 2);
      assert.deepEqual(source.items, [item]);
      return deposit({ ...from, items: source.items });
    },
  });
  assert.equal(Object.hasOwn(store.read() as object, "receipts"), false);
  assert.equal(driver.snapshot().pending?.ordinal, 2);
  await driver.trip();
  assert.deepEqual(driver.snapshot().totals, {
    trips: 2,
    unitsByType: { "30": 8, "31": 4 },
    volumeM3: null,
  });
  assert.equal(driver.snapshot().pending, null);
});
test("lost completion reuses the exact persisted trip and cannot create a second deposit", async () => {
  const x = fixture();
  x.lose();
  await assert.rejects(x.driver.trip(), /lost/);
  assert.equal(x.driver.snapshot()?.pending?.ordinal, 1);
  assert.equal((await x.driver.trip()).deposited, true);
  assert.deepEqual(
    x.calls.filter((c) => c.startsWith("deposit:")),
    ["deposit:1", "deposit:1"],
  );
  assert.equal(x.driver.snapshot()?.nextOrdinal, 2);
});
test("final partial hold is deposited and an empty hold needs no movement", async () => {
  const x = fixture();
  x.setRows([{ itemID: 22, typeID: 30, quantity: 1 }]);
  assert.equal((await x.driver.trip()).deposited, true);
  assert.equal((await x.driver.trip()).deposited, false);
  assert.equal(x.calls.filter((c) => c === "travel").length, 1);
});

test("a failed durable trip intent prevents travel and deposit", async () => {
  let travel = 0,
    deposit = 0;
  const x = createSelfUnload({
    operationID: "o",
    runID: "r",
    characterID: 1,
    shipID: 11,
    destinationID: 600,
    current() {},
    store: {
      read: () => null,
      write: () => {
        throw Error("storage failed");
      },
    },
    readRaw: async () => [{ itemID: 20, typeID: 30, quantity: 1 }],
    settle: async () => {},
    travel: async () => {
      travel++;
    },
    deposit: async () => {
      deposit++;
      throw Error("unexpected");
    },
  });
  await assert.rejects(x.trip(), /storage failed/);
  assert.equal(travel, 0);
  assert.equal(deposit, 0);
});
test("a malformed or foreign saved trip refuses without taking a new trip", () => {
  for (const data of [
    { version: 1, identity: "wrong", nextOrdinal: 1, pending: null, receipts: [] },
    {
      version: 1,
      identity: JSON.stringify(["o", "r", 1, 11]),
      nextOrdinal: 2,
      pending: { ordinal: 1, items: [] },
      receipts: [],
    },
    {
      version: 1,
      identity: JSON.stringify(["o", "r", 1, 11]),
      nextOrdinal: 2,
      pending: null,
      receipts: [{}],
    },
  ])
    assert.throws(
      () =>
        createSelfUnload({
          operationID: "o",
          runID: "r",
          characterID: 1,
          shipID: 11,
          destinationID: 600,
          current() {},
          store: { read: () => data, write() {} },
          readRaw: async () => [],
          settle: async () => {},
          travel: async () => {},
          deposit: async () => {
            throw Error("unexpected");
          },
        }),
      /reconciliation/,
    );
});

test("unknown route outcome keeps the exact trip movement intent and never dispatches a second route", async () => {
  const store = memory();
  let routes = 0,
    deposits = 0;
  const source = { itemID: 20, typeID: 30, quantity: 8 };
  const x = createSelfUnload({
    operationID: "o",
    runID: "r",
    characterID: 1,
    shipID: 11,
    destinationID: 600,
    current() {},
    store,
    readRaw: async () => [source],
    settle: async () => {},
    travel: async (m, beforeRoute) => {
      if (m.routeIssuedAt === null) {
        beforeRoute();
        routes++;
        throw Error("route acknowledgement lost");
      }
      throw Error("movement outcome unknown; no replay");
    },
    deposit: async () => {
      deposits++;
      throw Error("unexpected");
    },
  });
  await assert.rejects(x.trip(), /acknowledgement lost/);
  const pending = x.snapshot()?.pending;
  assert.ok(pending?.movement.routeIssuedAt);
  await assert.rejects(x.trip(), /no replay/);
  assert.equal(routes, 1);
  assert.equal(deposits, 0);
  assert.deepEqual(x.snapshot()?.pending, pending);
});
test("concurrent Stop coalesces with an in-flight trip before moving or depositing again", async () => {
  const store = memory();
  let release: () => void = () => {},
    started: () => void = () => {};
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    begun = new Promise<void>((r) => {
      started = r;
    });
  let rows = [{ itemID: 20, typeID: 30, quantity: 8 }],
    routes = 0,
    deposits = 0;
  const x = createSelfUnload({
    operationID: "o",
    runID: "r",
    characterID: 1,
    shipID: 11,
    destinationID: 600,
    current() {},
    store,
    readRaw: async () => rows,
    settle: async () => {},
    travel: async (_m, beforeRoute) => {
      beforeRoute();
      routes++;
      started();
      await gate;
    },
    deposit: async (src) => {
      deposits++;
      rows = [];
      return {
        source: src,
        destinationID: 600,
        corporationID: 77,
        division: 1,
        officeID: 700,
        completedAt: 1,
        batches: [],
      };
    },
  });
  const first = x.trip();
  await begun;
  const stop = x.trip();
  assert.equal(first, stop);
  release();
  await Promise.all([first, stop]);
  assert.equal(routes, 1);
  assert.equal(deposits, 1);
  assert.equal(x.snapshot()?.pending, null);
});

function nativeTripFixture() {
  const tripStore = memory(),
    docs = new Map<number, ReturnType<typeof memory>>();
  let stationID: number | null = null,
    systemID = 300,
    held: any[] = [
      { itemID: 20, typeID: 30, ownerID: 1, locationID: 11, flagID: 134, quantity: 8 },
    ],
    corp: any[] = [],
    routes = 0,
    adds = 0;
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const flight = () => ({
    inSpace: stationID === null,
    docked: stationID !== null,
    shipID: 11,
    solarSystemID: systemID,
    stationID,
    shipMode: stationID === null ? "STOP" : null,
    transition,
  });
  const list = (rows: any[]) => ({
    type: "list",
    items: rows.map((fields) => ({ type: "packedrow", fields })),
  });
  const run: any = {
    characterID: 1,
    baseUrl: "http://bff",
    fetch: async (input: URL) => {
      const p = new URL(String(input)).pathname;
      if (p === "/api/map/station/600")
        return Response.json({ ok: true, station: { stationID: 600 } });
      if (p === "/api/map/resolve/600")
        return Response.json({ ok: true, kind: "station", stationID: 600, solarSystemID: 300 });
      if (p.endsWith("/corp-offices")) return Response.json(officeList());
      if (p.endsWith("/flight/status")) return Response.json({ ok: true, flight: flight() });
      if (p.endsWith("/space/snapshot"))
        return Response.json({
          ok: true,
          space: {
            stateValid: true,
            inSpace: true,
            shipID: 11,
            solarSystemID: systemID,
            sampledAtMs: Date.now(),
            ship: {
              itemID: 11,
              characterID: 1,
              mode: "STOP",
              position: { x: 0, y: 0, z: 0 },
              radius: 10,
            },
            entities: [],
          },
        });
      if (p.endsWith("/mining-operations/resources"))
        return Response.json({ ok: true, resources: [{ typeID: 30, family: "ore", name: "ore" }] });
      if (p.endsWith("/client-data/dogma-types"))
        return Response.json({ ok: true, available: true, types: { 30: { categoryID: 25 } } });
      if (p.endsWith("/types/volumes"))
        return Response.json({ ok: true, volumes: { 30: 1 }, capped: false });
      throw Error(`unexpected ${p}`);
    },
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1, corporationID: 77 } }) } },
    flow: {
      requestOptions: () => ({}),
      startRoute: async () => {
        routes++;
        throw Error("route reply lost");
      },
      flying: {
        bridgeDo: async (
          service: string,
          method: string,
          args: any[],
          _kwargs: any,
          objectID: number,
        ) => {
          if (service === "invCache") return null;
          if (service === "invbroker" && method === "Add" && objectID === 700) {
            adds++;
            const row = held.find((x) => x.itemID === args[0]);
            held = [];
            corp = [{ ...row, ownerID: 77, locationID: 700, flagID: 115 }];
            return null;
          }
          throw Error("unexpected write");
        },
        bridgeAsk: async (
          service: string,
          method: string,
          _args: any,
          kwargs: any,
          objectID: number,
        ) => {
          if (service === "corpRegistry") return corporationRow(method, 1, 77);
          if (service === "officeManager")
            return { list: [{ fields: { stationID: 600, officeID: 700 } }] };
          if (service === "invbroker" && method === "List")
            return list(
              objectID === 11
                ? held.filter((row) => row.flagID === kwargs?.flag)
                : objectID === 700
                  ? corp
                  : [],
            );
          throw Error("unexpected read");
        },
        autopilotProgress: () => null,
      },
    },
  };
  const build = () =>
    createNativeSelfUnload(run, session, {
      operationID: "o",
      runID: "r",
      shipID: 11,
      destinationID: 600,
      corporationID: 77,
      division: 1,
      delivery: {
        kind: "station",
        destinationID: 600,
        systemID: 300,
        corporationID: 77,
        division: 1,
      },
      current() {},
      settle: async () => {},
      store: tripStore,
      tripDocument: (n) => {
        if (!docs.has(n)) docs.set(n, memory());
        return docs.get(n)!;
      },
    });
  return {
    build,
    run,
    session,
    counts: () => ({ routes, adds }),
    setPosition: (system: number, station: number | null) => {
      systemID = system;
      stationID = station;
    },
    setStartRoute: (start: () => unknown) => {
      session.flow.startRoute = async () => {
        routes++;
        return start();
      };
    },
  };
}

test("unknown delivery resumes from a verified dock or replans on a reconnected session", async () => {
  for (const resumed of [false, true]) {
    const f = nativeTripFixture(),
      adapter = f.build();
    await assert.rejects(adapter.trip(), /route reply lost/);
    assert.ok(adapter.snapshot()?.pending?.movement.routeIssuedAt);
    await assert.rejects(adapter.trip(), /no route replay/);
    await assert.rejects(f.build().trip(), /no route replay/);
    assert.deepEqual(f.counts(), { routes: 1, adds: 0 });
    f.run.resumed = resumed;
    if (resumed)
      f.setStartRoute(() => {
        f.setPosition(300, 600);
        return { started: true };
      });
    else f.setPosition(300, 600);
    const recovered = f.build();
    assert.equal((await recovered.trip()).deposited, true);
    assert.deepEqual(f.counts(), { routes: resumed ? 2 : 1, adds: 1 });
    assert.equal(recovered.snapshot()?.pending, null);
  }
});

test("a confirmed route planning timeout leaves self-unload ready to retry the same cargo", async () => {
  const f = nativeTripFixture(),
    adapter = f.build(),
    cause = Object.assign(Error("origin timed out"), { code: "CALL_TIMEOUT" });
  f.setStartRoute(() => ({ started: false, reason: "Could not read your location", cause }));
  await assert.rejects(adapter.trip(), FleetObservationUnavailable);
  assert.equal(adapter.snapshot()?.pending?.movement.routeIssuedAt, null);
  assert.deepEqual(adapter.snapshot()?.pending?.items, [
    { itemID: 20, typeID: 30, quantity: 8, unitVolumeM3: 1 },
  ]);
  assert.deepEqual(f.counts(), { routes: 1, adds: 0 });
  f.setStartRoute(() => {
    f.setPosition(300, 600);
    return { started: true };
  });
  assert.equal((await adapter.trip()).deposited, true);
  assert.deepEqual(adapter.snapshot().totals, { trips: 1, unitsByType: { "30": 8 }, volumeM3: 8 });
  assert.deepEqual(f.counts(), { routes: 2, adds: 1 });
});

test("self-unload follows a progressing route past three minutes and verifies the dock before unloading", async (t) => {
  const f = nativeTripFixture(),
    adapter = f.build();
  let clock = Date.now(),
    polls = 0,
    docks = 0;
  t.mock.method(Date, "now", () => clock);
  f.setPosition(301, null);
  f.setStartRoute(() => ({ started: true }));
  f.session.flow.flying.autopilotProgress = () => {
    if (++polls === 1) {
      clock += 181_000;
      f.setPosition(300, null);
      return { status: "running", currentSystemID: 301, remainingJumps: 1 };
    }
    return { status: "arrived", currentSystemID: 300, remainingJumps: 0 };
  };
  f.session.flow.flying.dockStep = async (id: number) => {
    assert.equal(id, 600);
    assert.equal(f.counts().adds, 0);
    docks++;
    f.setPosition(300, 600);
  };
  assert.equal((await adapter.trip()).deposited, true);
  assert.equal(docks, 1);
  assert.deepEqual(f.counts(), { routes: 1, adds: 1 });
});

test("ore self-unload refuses catalogue ice before any trip or inventory mutation", async () => {
  let moves = 0;
  const item = {
    itemID: 20,
    typeID: 31,
    ownerID: 1,
    locationID: 11,
    flagID: 134,
    quantity: 1,
    stacksize: 1,
    categoryID: 25,
  };
  const run: any = {
    characterID: 1,
    baseUrl: "http://bff",
    fetch: async (input: any) => {
      const p = new URL(String(input)).pathname;
      const body = p.endsWith("/flight/status")
        ? {
            flight: {
              shipID: 11,
              docked: true,
              inSpace: false,
              stationID: 600,
              solarSystemID: 300,
              transition: { phase: "ready" },
            },
          }
        : p.endsWith("/resources")
          ? { resources: [{ typeID: 31, family: "ice", name: "ice" }] }
          : p.endsWith("/dogma-types")
            ? { available: true, types: { 31: { categoryID: 25 } } }
            : p.endsWith("/volumes")
              ? { volumes: { 31: 2.5 }, capped: false }
              : null;
      if (!body) throw Error("Unexpected read");
      return Response.json({ ok: true, ...body });
    },
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1, corporationID: 77 } }) } },
    flow: {
      requestOptions: () => ({}),
      startRoute: async () => {
        moves++;
        throw Error("Unexpected movement");
      },
      flying: {
        bridgeDo: async (s: string, m: string) => {
          if (s === "invCache" && m === "InvalidateLocationCache") return null;
          moves++;
          throw Error("Unexpected mutation");
        },
        bridgeAsk: async (s: string, m: string, _a: any, k: any) => {
          assert.equal(s, "invbroker");
          assert.equal(m, "List");
          return {
            type: "list",
            items: k?.flag === 134 ? [{ type: "packedrow", fields: item }] : [],
          };
        },
      },
    },
  };
  const x = createNativeSelfUnload(run, session, {
    operationID: "o",
    runID: "r",
    shipID: 11,
    destinationID: 600,
    corporationID: 77,
    division: 1,
    current() {},
    settle: async () => {},
    store: memory(),
    tripDocument: () => memory(),
  });
  await assert.rejects(x.trip(), /Only verified raw resources/);
  assert.equal(moves, 0);
  assert.equal(x.snapshot()?.pending ?? null, null);
});

test("ICE self-unload uses the actual ice bay, native volume and exact corporation deposit", async () => {
  let held: any[] = [
      {
        itemID: 20,
        typeID: 31,
        ownerID: 1,
        locationID: 11,
        flagID: 181,
        quantity: 3,
        categoryID: 25,
      },
    ],
    corp: any[] = [],
    adds = 0;
  const list = (v: any[]) => ({
    type: "list",
    items: v.map((fields) => ({ type: "packedrow", fields })),
  });
  const run: any = {
    characterID: 1,
    baseUrl: "http://bff",
    fetch: async (input: any) => {
      const p = new URL(String(input)).pathname;
      let x: any;
      if (p.endsWith("/corp-offices")) x = officeList();
      else if (p.endsWith("/flight/status"))
        x = {
          flight: {
            shipID: 11,
            docked: true,
            inSpace: false,
            stationID: 600,
            solarSystemID: 300,
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
      else if (p.endsWith("/ore-hold"))
        x = {
          activeShipID: 11,
          holds: [
            {
              key: "ice",
              present: true,
              error: null,
              capacity: { capacity: 100, used: 90 },
              items: [],
            },
          ],
        };
      else if (p.endsWith("/resources"))
        x = { resources: [{ typeID: 31, family: "ice", name: "ice" }] };
      else if (p.endsWith("/dogma-types"))
        x = { available: true, types: { 31: { categoryID: 25 } } };
      else if (p.endsWith("/volumes")) x = { volumes: { 31: 2.5 }, capped: false };
      else throw Error(p);
      return Response.json({ ok: true, ...x });
    },
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1, corporationID: 77 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async (s: string, m: string, args: any[], _k: any, of: number) => {
          if (s === "invCache") return;
          if (s === "invbroker" && m === "Add" && of === 700) {
            adds++;
            corp = [{ ...held[0], ownerID: 77, locationID: 700, flagID: 115 }];
            held = [];
            return;
          }
          throw Error("unexpected write");
        },
        bridgeAsk: async (s: string, m: string, _a: any, k: any, of: number) => {
          if (s === "corpRegistry") return corporationRow(m, 1, 77);
          if (s === "officeManager")
            return { list: [{ fields: { stationID: 600, officeID: 700 } }] };
          if (m === "List")
            return list(of === 11 ? held.filter((x) => x.flagID === k?.flag) : corp);
          throw Error("unexpected read");
        },
      },
    },
  };
  const x = createNativeSelfUnload(run, session, {
    operationID: "o",
    runID: "r",
    shipID: 11,
    resourceFamily: "ice",
    destinationID: 600,
    corporationID: 77,
    division: 1,
    current() {},
    settle: async () => {},
    store: memory(),
    tripDocument: () => memory(),
  });
  assert.equal((await x.trip()).deposited, true);
  assert.equal(adds, 1);
  assert.equal(corp[0].quantity, 3);
});
