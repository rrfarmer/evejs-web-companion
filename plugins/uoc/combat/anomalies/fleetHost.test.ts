const nativeShipInfo = (id: number) => ({
  type: "object",
  name: "util.KeyVal",
  args: {
    type: "dict",
    entries: [
      ["itemID", id + 10],
      [
        "invItem",
        { type: "packedrow", fields: { itemID: id + 10, ownerID: id, locationID: 300, flagID: 0 } },
      ],
      ["time", { type: "long", value: "134385676761330000" }],
      ["wallclockTime", { type: "long", value: "134385676761330001" }],
    ],
  },
});
import test from "node:test";
import assert from "node:assert/strict";
import { createAnomalyFleetRuns } from "./fleetHost.ts";
const site = {
  systemID: 300,
  scannerKey: 55,
  instanceID: 89,
  dungeonID: 5579,
  label: "ABC",
  position: { x: 1, y: 2, z: 3 },
  observedAt: 100,
};
const setup = {
  operationID: "op",
  operationRunID: "run",
  leaderID: 1,
  site,
  members: [
    { characterID: 1, shipID: 11 },
    { characterID: 2, shipID: 12 },
  ],
};
function fixture(extra: Record<string, unknown> = {}) {
  const docs = new Map<string, unknown>(),
    reports: any[] = [];
  let sessionsClosed = 0;
  const factory = createAnomalyFleetRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => docs.set(name, structuredClone(v)),
    }),
    ...extra,
    catalog: () => [
      { dungeonID: 5579, enabled: true, entryRoomID: 0, typeGroups: { "11040": 550 } },
    ],
    attach: async (run) =>
      ({
        store: { station: { get: () => ({ online: { characterID: run.held.characterID } }) } },
        flow: {
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
          requestOptions: () => ({}),
          setLivePush: () => {
            sessionsClosed++;
          },
          abortRoute: () => {},
        },
      }) as any,
  });
  function run(id: number) {
    return {
      botID: `bot${id}`,
      characterID: id,
      held: { characterID: id },
      setup,
      resumed: false,
      baseUrl: "http://bff",
      report: (r: any) => reports.push({ id, ...r }),
      fetch: async (input: any) => {
        const p = new URL(String(input)).pathname;
        if (p === "/api/pilot-training/characters")
          return Response.json({
            ok: true,
            account: `Test${id}`,
            characters: [{ characterID: id }],
          });
        if (p === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: id + 10,
              solarSystemID: 300,
              docked: true,
              inSpace: false,
              stationID: 600,
            },
          });
        throw Error(`unexpected ${p}`);
      },
    } as any;
  }
  return {
    factory,
    run,
    reports,
    docs,
    get closed() {
      return sessionsClosed;
    },
  };
}
test("one held pilot can stop before fleet assembly; a later actor cannot join the terminal group", async () => {
  const f = fixture(),
    handle = await f.factory.member.start(f.run(1));
  await handle.stop();
  assert.ok(f.reports.some((r) => r.id === 1 && r.status === "stopped"));
  assert.equal(f.closed, 1);
  await assert.rejects(Promise.resolve(f.factory.member.start(f.run(2))), /already stopping/);
});
test("the anomaly work deadline invokes the existing single Stop path before grant expiry and retains native dock checks", async () => {
  let state = "CREATED",
    stops = 0;
  const f = fixture({
      expiry: async () => Date.now() + 180005,
      peer: (c: any) => ({ characterID: c.run.characterID }),
      operation: (_c: any) => ({
        authority: () => ({ state, primary: null, primaryGeneration: 0 }),
        assertTarget() {},
        fence: async () => {},
        snapshot: () => ({ state, receipt: null }),
        async tick() {
          state = "COMBAT";
        },
        async stop() {
          stops++;
          state = "STOPPED";
        },
      }),
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    }),
    one = f.run(1),
    two = f.run(2);
  one.botID = "deadline-1";
  two.botID = "deadline-2";
  const a = await f.factory.member.start(one),
    b = await f.factory.member.start(two);
  for (let i = 0; i < 100 && f.reports.filter((r) => r.status === "stopped").length < 2; i++)
    await new Promise((r) => setTimeout(r, 2));
  assert.equal(stops, 1);
  assert.equal(f.reports.filter((r) => r.status === "stopped").length, 2);
  await a.stop();
  await b.stop();
  assert.equal(stops, 1);
});
test("disabled source catalog and forged duplicate ships cannot pass check", () => {
  const f = fixture();
  assert.equal(
    (
      f.factory.member.check({
        ...setup,
        members: [
          { characterID: 1, shipID: 11 },
          { characterID: 2, shipID: 11 },
        ],
      }) as any
    ).ok,
    false,
  );
  const g = createAnomalyFleetRuns({
    document: () => ({ read: () => null, write: () => {} }),
    catalog: () => [{ dungeonID: 5579, enabled: false, entryRoomID: 0, typeGroups: {} }],
  });
  assert.equal((g.member.check(setup) as any).ok, false);
});

test("all held members share one coordinator and stop only after fleet settlement", async () => {
  let stops = 0,
    ticks = 0,
    state = "CREATED";
  const peers: number[] = [];
  const f = fixture({
    peer: (c: any) => {
      peers.push(c.run.characterID);
      return { characterID: c.run.characterID };
    },
    operation: (c: any) => ({
      authority: () => ({ state, primary: null, primaryGeneration: 0 }),
      assertTarget() {},
      fence: async () => {},
      snapshot: () => ({ state, receipt: null }),
      async tick() {
        ticks++;
        state = "COMBAT";
      },
      async stop() {
        stops++;
        state = "STOPPED";
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 2)),
  });
  const a = await f.factory.member.start(f.run(1)),
    b = await f.factory.member.start(f.run(2));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(peers, [1, 2]);
  assert.ok(ticks >= 1);
  await a.stop();
  await b.stop();
  assert.equal(stops, 1);
  assert.deepEqual(
    f.reports
      .filter((r) => r.status === "stopped")
      .map((r) => r.id)
      .sort(),
    [1, 2],
  );
});

test("two hosted actors share one real coordinator and native completion precedes fleet release", async () => {
  const { createSignal } = await import("../../../../web/src/store/signals.ts"),
    docs = new Map<string, unknown>(),
    reports: any[] = [],
    calls: string[] = [];
  let eventSent = false;
  const live = createSignal<any>({
      status: "live",
      epoch: "epoch",
      sequence: 2,
      notifications: [],
      lastEventAtMs: null,
      questions: [],
    }),
    dict = (entries: any[] = []) => ({ type: "dict", entries }),
    kv = (entries: any[]) => ({ type: "object", name: "util.KeyVal", args: dict(entries) }),
    list = (items: any[]) => ({ type: "list", items }),
    scan = [
      dict([
        [
          55,
          kv([
            ["targetID", "ABC"],
            ["instanceID", 89],
            ["siteID", 89],
            ["dungeonID", 5579],
            ["archetypeID", 24],
            ["solarSystemID", 300],
            ["position", [1, 2, 3]],
          ]),
        ],
      ]),
      dict(),
      dict(),
      dict(),
    ];
  const s = { ...setup, site: { ...site, position: { x: 1, y: 2, z: 3 }, observedAt: Date.now() } };
  const factory = createAnomalyFleetRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => docs.set(name, structuredClone(v)),
    }),
    catalog: () => [
      { dungeonID: 5579, enabled: true, entryRoomID: 0, typeGroups: { "11040": 550 } },
    ],
    sleep: () => new Promise((r) => setImmediate(r)),
    attach: async (run) =>
      ({
        store: {
          live,
          station: { get: () => ({ online: { characterID: run.held.characterID } }) },
        },
        flow: {
          requestOptions: () => ({}),
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeAsk: async (svc: string) => {
              if (svc !== "scanMgr") throw Error(`unsupported ${svc}`);
              return scan;
            },
          },
          abortRoute() {},
          setLivePush() {},
        },
      }) as any,
    peer: (c: any) =>
      ({
        characterID: c.run.characterID,
        shipID: c.shipID,
        botID: c.run.botID,
        session: c.session,
        sessionGeneration: 1,
        current: c.current,
        async read() {
          return { state: "ready", fleetID: 10, memberIDs: [1, 2] };
        },
        invitation() {
          return null;
        },
        async create() {
          throw Error("unexpected");
        },
        async invite() {
          throw Error("unexpected");
        },
        async accept() {
          throw Error("unexpected");
        },
        async view() {
          return {
            characterID: c.run.characterID,
            shipID: c.shipID,
            systemID: 300,
            inSpace: true,
            inWarp: false,
            shipPosition: { x: 1, y: 2, z: 3 },
            keeper: { dungeonID: 5579, instanceID: 89, roomID: 0 },
            sampledAt: Date.now(),
            npcs: [
              {
                kind: "ship",
                itemID: 90,
                typeID: 11040,
                groupID: 550,
                categoryID: 11,
                isNpc: true,
                isSelf: false,
                geometryAvailable: true,
                position: { x: 2, y: 2, z: 3 },
              },
            ],
          };
        },
        async navigate() {
          calls.push(`nav:${c.run.characterID}`);
        },
        fighter: {
          async tick(_id: any, current: () => void) {
            current();
            calls.push(`fight:${c.run.characterID}`);
            if (c.run.characterID === 2 && !eventSent) {
              eventSent = true;
              const prior = live.get();
              live.set({
                ...prior,
                sequence: 3,
                notifications: [
                  {
                    kind: "notification",
                    service: null,
                    method: "OnDungeonCompleted",
                    args: [5579],
                    receivedAtMs: Date.now(),
                  },
                ],
              });
            }
          },
        },
        async settle() {
          calls.push(`settle:${c.run.characterID}`);
          return {
            characterID: c.run.characterID,
            shipID: c.shipID,
            modulesInactive: true,
            dronesSafe: true,
            observedAt: Date.now(),
          };
        },
        async park() {
          calls.push(`park:${c.run.characterID}`);
          return {
            characterID: c.run.characterID,
            shipID: c.shipID,
            docked: true,
            destinationID: 600,
            observedAt: Date.now(),
          };
        },
      }) as any,
  });
  function run(id: number) {
    return {
      botID: `live-bot${id}`,
      characterID: id,
      held: { characterID: id },
      setup: s,
      resumed: false,
      baseUrl: "http://bff",
      report: (r: any) => reports.push({ id, ...r }),
      fetch: async (input: any) => {
        const p = new URL(String(input)).pathname;
        if (p === "/api/pilot-training/characters")
          return Response.json({
            ok: true,
            account: `Test${id}`,
            characters: [{ characterID: id }],
          });
        if (p === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: id + 10,
              solarSystemID: 300,
              docked: true,
              inSpace: false,
              stationID: 600,
            },
          });
        throw Error(`unexpected ${p}`);
      },
    } as any;
  }
  const a = await factory.member.start(run(1)),
    b = await factory.member.start(run(2));
  for (let n = 0; n < 100 && reports.filter((r) => r.status === "stopped").length < 2; n++)
    await new Promise((r) => setImmediate(r));
  assert.equal(reports.filter((r) => r.status === "stopped").length, 2, JSON.stringify(reports));
  assert.deepEqual(calls, [
    "nav:1",
    "nav:2",
    "fight:1",
    "fight:2",
    "settle:1",
    "settle:2",
    "park:1",
    "park:2",
  ]);
  for (const report of reports.filter((r) => r.status === "stopped"))
    assert.equal(report.readout.completion.source, "native-dungeon-completed");
  await a.stop();
  await b.stop();
});

test("partial roster cannot finish on stale or foreign dock evidence", async () => {
  const f = fixture(),
    r = f.run(1),
    original = r.fetch;
  let flight: any = {
    docked: true,
    inSpace: false,
    shipID: 11,
    stationID: 600,
    solarSystemID: 300,
  };
  r.botID = "partial-proof";
  r.fetch = async (input: any) =>
    new URL(String(input)).pathname === "/api/bridge/flight/status"
      ? Response.json({ ok: true, flight })
      : original(input);
  const handle = await f.factory.member.start(r);
  flight = { docked: false, inSpace: true, shipID: 11, stationID: null, solarSystemID: 300 };
  await assert.rejects(async () => await handle.stop(), /dock proof/);
  assert.equal(
    f.reports.some((x) => x.status === "stopped"),
    false,
  );
  flight = { docked: true, inSpace: false, shipID: 99, stationID: 600, solarSystemID: 300 };
  await assert.rejects(async () => await handle.stop(), /dock proof/);
  flight = {
    docked: true,
    inSpace: false,
    shipID: 11,
    stationID: 600,
    solarSystemID: 300,
    transition: { phase: "bogus" },
  };
  await assert.rejects(async () => await handle.stop(), /dock proof/);
  flight = { docked: true, inSpace: false, shipID: 11, stationID: 600, solarSystemID: 300 };
  await handle.stop();
  assert.ok(f.reports.some((x) => x.status === "stopped"));
});
test("concurrent Stop during parking waits once and never aborts the parking route", async () => {
  let phase = "CREATED",
    finish!: () => void,
    started!: () => void,
    stops = 0,
    aborts = 0;
  const parking = new Promise<void>((r) => {
      finish = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  const f = fixture({
    attach: async (run: any) => ({
      store: { station: { get: () => ({ online: { characterID: run.held.characterID } }) } },
      flow: {
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        requestOptions: () => ({}),
        setLivePush() {},
        abortRoute() {
          aborts++;
        },
      },
    }),
    peer: (c: any) => ({ characterID: c.run.characterID }),
    operation: (_c: any) => ({
      authority: () => ({ state: phase, primary: null, primaryGeneration: 0 }),
      assertTarget() {},
      fence: async () => {},
      snapshot: () => ({ state: phase, receipt: null }),
      async tick() {
        phase = "SETTLING";
        started();
        await parking;
        phase = "STOPPED";
      },
      async stop() {
        stops++;
        await parking;
        phase = "STOPPED";
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const a = f.run(1),
    b = f.run(2);
  a.botID = "park-stop-1";
  b.botID = "park-stop-2";
  const attach = f.factory as any;
  const h1 = await attach.member.start(a),
    h2 = await attach.member.start(b);
  await entered;
  const one = Promise.resolve(h1.stop()),
    two = Promise.resolve(h2.stop());
  await new Promise((r) => setImmediate(r));
  assert.equal(
    f.reports.some((r) => r.status === "stopped"),
    false,
  );
  finish();
  await Promise.all([one, two]);
  assert.equal(stops, 1);
  const last = f.reports.filter((r) => r.id === 1).at(-1);
  assert.equal(last?.status, "stopped");
  assert.equal(aborts, 0);
});

test("Stop waits for a failing in-flight tick and never publishes paused after stopped", async () => {
  let phase = "CREATED",
    release!: () => void,
    entered!: () => void;
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const f = fixture({
    peer: (c: any) => ({ characterID: c.run.characterID }),
    operation: (_c: any) => ({
      authority: () => ({ state: phase, primary: null, primaryGeneration: 0 }),
      assertTarget() {},
      fence: async () => {},
      snapshot: () => ({ state: phase, receipt: null }),
      async tick() {
        phase = "ENTRY";
        entered();
        await hold;
        throw Error("retired during navigation");
      },
      async stop() {
        await hold;
        phase = "STOPPED";
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const a = f.run(1),
    b = f.run(2);
  a.botID = "stop-tick-1";
  b.botID = "stop-tick-2";
  const h1 = await f.factory.member.start(a),
    h2 = await f.factory.member.start(b);
  await started;
  const end = Promise.all([h1.stop(), h2.stop()]);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    f.reports.some((r) => r.status === "stopped"),
    false,
  );
  release();
  await end;
  await new Promise((r) => setImmediate(r));
  for (const id of [1, 2]) {
    const events = f.reports.filter((r) => r.id === id),
      last = events.at(-1);
    assert.equal(last?.status, "stopped");
    assert.equal(
      events.some((r) => r.status === "paused"),
      false,
    );
  }
});

test("a post-release reporting failure can finish the same exact claim without a second native action", async () => {
  let phase = "CREATED",
    stops = 0,
    failed = false;
  const f = fixture({
      peer: (c: any) => ({ characterID: c.run.characterID }),
      operation: (_c: any) => ({
        authority: () => ({ state: phase, primary: null, primaryGeneration: 0 }),
        assertTarget() {},
        fence: async () => {},
        snapshot: () => ({ state: phase, receipt: null }),
        async tick() {
          phase = "COMBAT";
        },
        async stop() {
          stops++;
          phase = "STOPPED";
        },
      }),
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    }),
    a = f.run(1),
    b = f.run(2);
  a.botID = "release-report-1";
  b.botID = "release-report-2";
  const report = a.report;
  a.report = (event: any) => {
    if (event.status === "stopped" && !failed) {
      failed = true;
      throw Error("report failed");
    }
    report(event);
  };
  const h1 = await f.factory.member.start(a),
    h2 = await f.factory.member.start(b);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(async () => await h1.stop(), /report failed/);
  await h1.stop();
  await h2.stop();
  assert.equal(stops, 2);
  assert.ok(f.reports.filter((r) => r.status === "stopped").length === 2);
});

test("automatic cold start assembles fleet, undocks once, scans and claims before constructing the existing operation", async () => {
  const docs = new Map<string, unknown>(),
    events: string[] = [],
    online = new Map([
      [1, false],
      [2, false],
    ]),
    kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    dict = (entries: any[] = []) => ({ type: "dict", entries }),
    systemID = 300;
  let operationConfig: any;
  const setupAuto = {
    operationID: "cold-auto",
    operationRunID: "epoch",
    leaderID: 1,
    systemID,
    siteSearch: { kind: "COMBAT_ANOMALY" },
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
  };
  const factory = createAnomalyFleetRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, structuredClone(v));
        if (name.startsWith("anomaly-site:")) events.push("claim");
      },
    }),
    catalog: () => [{ dungeonID: 2226, enabled: true, entryRoomID: 0, typeGroups: {} }],
    sleep: async () => {},
    attach: async (run) =>
      ({
        store: { station: { get: () => ({ online: { characterID: (run as any).characterID } }) } },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          async undock() {
            events.push("undock");
            online.set((run as any).characterID, true);
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeAsk: async (svc: string) => {
              if (svc === "dogmaIM") return nativeShipInfo((run as any).characterID);
              events.push("scan");
              return [
                dict([
                  [
                    55,
                    kv([
                      ["targetID", "ABC"],
                      ["instanceID", 89],
                      ["siteID", 89],
                      ["dungeonID", 2226],
                      ["archetypeID", 24],
                      ["solarSystemID", 300],
                      ["position", [1, 2, 3]],
                    ]),
                  ],
                ]),
                dict(),
                dict(),
                dict(),
              ];
            },
          },
        },
      }) as any,
    fleetPeer: (c: any) => ({
      characterID: c.run.characterID,
      shipID: c.shipID,
      botID: c.run.botID,
      current: c.current,
      read: async () => {
        events.push(`fleet:${c.run.characterID}`);
        return { state: "ready", fleetID: 90, memberIDs: [1, 2] };
      },
      invitation: () => null,
      create: async () => {},
      invite: async () => {},
      accept: async () => {},
    }),
    peer: (c: any) => ({ characterID: c.run.characterID }) as any,
    operation: (c: any) => {
      events.push("operation");
      operationConfig = c;
      return {
        snapshot: () => ({ state: "COMBAT", receipt: null }),
        tick: async () => new Promise(() => {}),
        stop: async () => {},
      } as any;
    },
  });
  function run(id: number) {
    return {
      botID: `cold-${id}`,
      characterID: id,
      held: { characterID: id },
      setup: setupAuto,
      resumed: false,
      baseUrl: "http://bff",
      report() {},
      fetch: async (input: any) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/pilot-training/characters")
          return Response.json({ ok: true, account: `A${id}`, characters: [{ characterID: id }] });
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: id + 10,
              solarSystemID: 300,
              docked: !online.get(id),
              inSpace: !!online.get(id),
              stationID: online.get(id) ? null : 600,
              shipMode: "STOP",
            },
          });
        if (path === "/api/bridge/space/snapshot")
          return Response.json({
            ok: true,
            space: {
              stateValid: true,
              inSpace: true,
              solarSystemID: 300,
              shipID: id + 10,
              sampledAtMs: Date.now() - 1634000,
              ship: {
                itemID: id + 10,
                characterID: id,
                position: { x: 0, y: 0, z: 0 },
                radius: 1,
                mode: "STOP",
              },
              entities: [],
            },
          });
        throw Error(path);
      },
    } as any;
  }
  await factory.member.start(run(1));
  await factory.member.start(run(2));
  for (let i = 0; i < 100 && !operationConfig; i++) await new Promise((r) => setImmediate(r));
  assert.ok(operationConfig);
  assert.equal(operationConfig.site.instanceID, 89);
  assert.ok(events.indexOf("fleet:1") < events.indexOf("undock"));
  assert.ok(events.indexOf("undock") < events.indexOf("scan"));
  assert.ok(events.indexOf("scan") < events.indexOf("claim"));
  assert.ok(events.indexOf("claim") < events.indexOf("operation"));
  assert.equal(events.filter((x) => x === "undock").length, 1);
  const search = [...docs.entries()].find(([k]) => k.startsWith("anomaly-search:"))?.[1] as any;
  assert.ok(search.undockProof);
  assert.ok(search.undockedAt - search.undockProof.simulationSampledAt >= 1634000);
  assert.equal(search.undockedAt, search.undockProof.readFinishedAt);
});

test("automatic search setup is canonical and cannot be mixed with an exact site", () => {
  const f = fixture(),
    auto = {
      operationID: "auto-check",
      operationRunID: "run",
      leaderID: 1,
      systemID: 300,
      siteSearch: { kind: "COMBAT_ANOMALY" },
      members: setup.members,
    };
  const check = f.factory.member.check(auto) as any;
  assert.equal(check.ok, true);
  assert.deepEqual(check.setup, auto);
  assert.equal((f.factory.member.check({ ...auto, site }) as any).ok, false);
  assert.equal((f.factory.member.check({ ...auto, siteSearch: { kind: "DED" } }) as any).ok, false);
  const exact = f.factory.member.check(setup) as any;
  assert.equal(JSON.stringify(exact.setup), JSON.stringify(setup));
});

test("Stop during auto-search undock reconciles movement and parks before reporting stopped", async () => {
  const docs = new Map<string, unknown>(),
    events: string[] = [],
    space = new Map([
      [1, false],
      [2, false],
    ]);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    observed = new Promise<void>((r) => (started = r)),
    setupAuto = {
      operationID: "cold-stop",
      operationRunID: "epoch",
      leaderID: 1,
      systemID: 300,
      siteSearch: { kind: "COMBAT_ANOMALY" },
      members: [
        { characterID: 1, shipID: 11 },
        { characterID: 2, shipID: 12 },
      ],
    };
  const factory = createAnomalyFleetRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => docs.set(name, structuredClone(v)),
    }),
    catalog: () => [{ dungeonID: 2226, enabled: true, entryRoomID: 0, typeGroups: {} }],
    sleep: async () => {},
    attach: async (run) =>
      ({
        store: { station: { get: () => ({ online: { characterID: (run as any).characterID } }) } },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          async undock() {
            events.push("undock");
            started();
            await waiting;
            space.set(1, true);
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeAsk: async (svc: string) => {
              if (svc === "dogmaIM") return nativeShipInfo((run as any).characterID);
              throw Error("scan after stop");
            },
          },
        },
      }) as any,
    fleetPeer: (c: any) => ({
      characterID: c.run.characterID,
      shipID: c.shipID,
      botID: c.run.botID,
      current: c.current,
      read: async () => ({ state: "ready", fleetID: 90, memberIDs: [1, 2] }),
      invitation: () => null,
      create: async () => {},
      invite: async () => {},
      accept: async () => {},
    }),
    settle: async (run) => {
      events.push(`settle:${(run as any).characterID}`);
      return { modulesInactive: true, dronesSafe: true, observedAt: Date.now() };
    },
    park: async (run) => {
      events.push(`park:${(run as any).characterID}`);
      space.set((run as any).characterID, false);
      return { destinationID: 600, systemID: 300, kind: "station" as const };
    },
  });
  function run(id: number) {
    return {
      botID: `stop-auto-${id}`,
      characterID: id,
      held: { characterID: id },
      setup: setupAuto,
      resumed: false,
      baseUrl: "http://bff",
      report: (r: any) => {
        if (r.status === "stopped") events.push(`stopped:${id}`);
      },
      fetch: async (input: any) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/pilot-training/characters")
          return Response.json({ ok: true, account: `A${id}`, characters: [{ characterID: id }] });
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: id + 10,
              solarSystemID: 300,
              docked: !space.get(id),
              inSpace: !!space.get(id),
              stationID: space.get(id) ? null : 600,
              shipMode: "STOP",
            },
          });
        if (path === "/api/bridge/space/snapshot")
          return Response.json({
            ok: true,
            space: {
              stateValid: true,
              inSpace: true,
              solarSystemID: 300,
              shipID: id + 10,
              sampledAtMs: Date.now(),
              ship: {
                itemID: id + 10,
                characterID: id,
                position: { x: 0, y: 0, z: 0 },
                radius: 1,
                mode: "STOP",
              },
              entities: [],
            },
          });
        throw Error(path);
      },
    } as any;
  }
  const a = await factory.member.start(run(1)),
    b = await factory.member.start(run(2));
  await observed;
  const stopping = Promise.all([a.stop(), b.stop()]);
  assert.equal(
    events.some((x) => x.startsWith("stopped:")),
    false,
  );
  release();
  await stopping;
  assert.equal(events.filter((x) => x === "undock").length, 1);
  assert.ok(events.indexOf("park:1") < events.indexOf("stopped:1"));
  assert.ok(events.includes("settle:2"));
});

test("fleet move authority is exact and canonical in auto and selected setup", () => {
  const f = fixture(),
    members = setup.members,
    moves = [{ characterID: 2, shipID: 12, fromFleetID: 90 }],
    auto = {
      operationID: "with-move",
      operationRunID: "epoch",
      leaderID: 1,
      systemID: 300,
      siteSearch: { kind: "COMBAT_ANOMALY" },
      fleetMoves: moves,
      members,
    },
    exact = {
      operationID: setup.operationID,
      operationRunID: setup.operationRunID,
      leaderID: setup.leaderID,
      site: setup.site,
      fleetMoves: moves,
      members,
    };
  const a = f.factory.member.check(auto) as any;
  assert.equal(a.ok, true);
  assert.equal(JSON.stringify(a.setup), JSON.stringify(auto));
  const b = f.factory.member.check(exact) as any;
  assert.equal(b.ok, true);
  assert.equal(JSON.stringify(b.setup), JSON.stringify(exact));
  assert.equal(
    (f.factory.member.check({ ...auto, fleetMoves: [{ ...moves[0], shipID: 99 }] }) as any).ok,
    false,
  );
  assert.equal(
    (f.factory.member.check({ ...auto, fleetMoves: [...moves, ...moves] }) as any).ok,
    false,
  );
});

test("final fresh dock proof fences site-claim release for every held pilot", async () => {
  let state = "CREATED",
    wrong = false;
  const f = fixture({
      peer: (c: any) => ({ characterID: c.run.characterID }),
      operation: () => ({
        authority: () => ({ state, primary: null, primaryGeneration: 0 }),
        assertTarget() {},
        fence: async () => {},
        snapshot: () => ({ state, receipt: null }),
        async tick() {
          state = "COMBAT";
        },
        async stop() {
          state = "STOPPED";
        },
      }),
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    }),
    a = f.run(1),
    b = f.run(2),
    original = b.fetch;
  b.fetch = async (input: any) =>
    wrong && new URL(String(input)).pathname === "/api/bridge/flight/status"
      ? Response.json({
          ok: true,
          flight: { shipID: 999, solarSystemID: 300, docked: true, inSpace: false, stationID: 600 },
        })
      : original(input);
  const h1 = await f.factory.member.start(a),
    h2 = await f.factory.member.start(b);
  await new Promise((r) => setTimeout(r, 5));
  wrong = true;
  await assert.rejects(async () => await h1.stop(), /dock proof/);
  assert.equal((f.docs.get("anomaly-site:300:89") as any).state, "ACTIVE");
  assert.equal(
    f.reports.some((r) => r.status === "stopped"),
    false,
  );
  wrong = false;
  await h1.stop();
  await h2.stop();
  assert.equal((f.docs.get("anomaly-site:300:89") as any).state, "RELEASED");
  assert.equal(f.reports.filter((r) => r.status === "stopped").length, 2);
});

test("two-site search persists distinct native receipts before group release", async () => {
  const docs = new Map<string, unknown>(),
    reports: any[] = [],
    space = new Map([
      [1, false],
      [2, false],
    ]),
    kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    dict = (entries: any[] = []) => ({ type: "dict", entries });
  let scans = 0,
    cycles = 0;
  const selected = {
    operationID: "multi",
    operationRunID: "epoch",
    leaderID: 1,
    systemID: 300,
    siteSearch: { kind: "COMBAT_ANOMALY", maxSites: 2, maxDifficulty: 1, searchMs: 10000 },
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
  };
  const factory = createAnomalyFleetRuns({
    document: (n) => ({
      read: () => docs.get(n) ?? null,
      write: (v) => docs.set(n, structuredClone(v)),
    }),
    catalog: () => [
      { dungeonID: 2226, enabled: true, entryRoomID: 0, difficulty: 1, typeGroups: {} },
    ],
    sleep: async () => {},
    attach: async (run) =>
      ({
        store: { station: { get: () => ({ online: { characterID: run.held.characterID } }) } },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          undock: async () => {
            space.set(run.held.characterID, true);
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            abortAutopilot() {},
            autopilotProgress: () => null,
            bridgeAsk: async (svc: string) => {
              if (svc === "dogmaIM") return nativeShipInfo(run.held.characterID);
              scans++;
              const id = scans === 1 ? 89 : 90;
              return [
                dict([
                  [
                    id,
                    kv([
                      ["targetID", `A${id}`],
                      ["instanceID", id],
                      ["siteID", id],
                      ["dungeonID", 2226],
                      ["archetypeID", 24],
                      ["solarSystemID", 300],
                      ["position", [1, 2, 3]],
                    ]),
                  ],
                ]),
                dict(),
                dict(),
                dict(),
              ];
            },
          },
        },
      }) as any,
    fleetPeer: (c: any) => ({
      characterID: c.run.held.characterID,
      shipID: c.shipID,
      botID: c.run.botID,
      current: c.current,
      read: async () => ({ state: "ready", fleetID: 90, memberIDs: [1, 2] }),
      invitation: () => null,
      create: async () => {},
      invite: async () => {},
      accept: async () => {},
    }),
    peer: (c: any) => ({ characterID: c.run.held.characterID }) as any,
    operation: (c: any) => {
      let done = false;
      const n = ++cycles;
      return {
        snapshot: () => ({
          state: done ? "STOPPED" : "COMBAT",
          receipt: done
            ? {
                source: "native-dungeon-completed",
                site: { instanceID: c.site.instanceID },
                sequence: n,
              }
            : null,
        }),
        tick: async () => {
          done = true;
          space.set(1, false);
          space.set(2, false);
        },
        stop: async () => {
          done = true;
        },
      } as any;
    },
  });
  function run(id: number) {
    return {
      botID: `multi-${id}`,
      characterID: id,
      held: { characterID: id },
      setup: selected,
      resumed: false,
      baseUrl: "http://bff",
      report: (v: any) => reports.push(v),
      fetch: async (input: any) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/pilot-training/characters")
          return Response.json({ ok: true, account: `A${id}`, characters: [{ characterID: id }] });
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: {
              shipID: id + 10,
              solarSystemID: 300,
              docked: !space.get(id),
              inSpace: !!space.get(id),
              stationID: space.get(id) ? null : 600,
              shipMode: "STOP",
              transition: { phase: "ready" },
            },
          });
        if (path === "/api/bridge/space/snapshot")
          return Response.json({
            ok: true,
            space: {
              stateValid: true,
              inSpace: true,
              solarSystemID: 300,
              shipID: id + 10,
              sampledAtMs: Date.now(),
              ship: {
                itemID: id + 10,
                characterID: id,
                position: { x: 0, y: 0, z: 0 },
                radius: 1,
                mode: "STOP",
              },
              entities: [],
            },
          });
        throw Error(path);
      },
    } as any;
  }
  await factory.member.start(run(1));
  await factory.member.start(run(2));
  for (let i = 0; i < 200 && !reports.some((v) => v.status === "stopped"); i++)
    await new Promise((r) => setImmediate(r));
  const journal = docs.get(`anomaly-cycles:${JSON.stringify(["multi", "epoch"])}`) as any;
  assert.equal(cycles, 2, JSON.stringify(reports));
  assert.deepEqual(
    journal.completed.map((v: any) => v.site.instanceID),
    [89, 90],
  );
  assert.equal(reports.filter((v) => v.status === "stopped").length, 2);
  assert.equal(reports.at(-1).readout.completedCount, 2);
});
