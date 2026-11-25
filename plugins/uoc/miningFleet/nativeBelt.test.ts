import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FleetObservationUnavailable } from "./stopSignal.ts";
import { createNativeBeltNavigation, readMiningReadiness } from "./nativeBelt.ts";
import { PROGRAM_DONE_PHASE } from "../../../web/src/plugin-api/index.ts";
const target = { kind: "BELT" as const, systemID: 300, name: "belt" };
const claim = {
  key: "BELT:300:belt",
  operationID: "op",
  runID: "run",
  generation: 1,
  expiresAt: 99999999999,
};
function setup(movementAdmission?: () => Promise<void>, beforeDeparture?: () => Promise<void>) {
  let distance = 300000,
    warps = 0,
    mode = "STOP",
    phase: string | null = null,
    holdWarp = false,
    beltName: string | null = "belt",
    group = 9,
    missing = false;
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/status")
      ? {
          flight: {
            inSpace: true,
            docked: false,
            shipID: 11,
            solarSystemID: 300,
            shipMode: mode,
            transition: {
              phase: phase ?? "ready",
              sessionStable: true,
              locationReady: true,
              sceneReady: true,
              egoReady: true,
              shipReady: true,
              boundContextReady: true,
            },
          },
        }
      : {
          space: {
            inSpace: true,
            solarSystemID: 300,
            shipID: 11,
            sampledAtMs: 10,
            ship: { itemID: 11, characterID: 1, mode, position: { x: 0, y: 0, z: 0 }, radius: 10 },
            entities: missing
              ? []
              : [
                  {
                    itemID: 99,
                    kind: "celestial",
                    groupID: group,
                    name: beltName,
                    position: { x: distance, y: 0, z: 0 },
                    radius: 10,
                  },
                ],
          },
        };
    return new Response(JSON.stringify({ ok: true, ...body }), {
      headers: { "content-type": "application/json" },
    });
  };
  const session: any = {
    flow: {
      requestOptions: () => ({}),
      flying: {
        warpAsTheAutopilot: async (id: number) => {
          assert.equal(id, 99);
          warps++;
          distance = 1000;
          if (holdWarp) mode = "WARP";
        },
      },
    },
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
  };
  return {
    native: createNativeBeltNavigation(
      { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
      session,
      {
        shipID: 11,
        beltID: 99,
        current() {},
        movementAdmission,
        beforeDeparture,
        pollMs: 1,
        timeoutMs: 1000,
      },
    ),
    warps: () => warps,
    setNear: () => {
      distance = 1000;
    },
    setMode: (v: string) => {
      mode = v;
    },
    setPhase: (v: string | null) => {
      phase = v;
    },
    holdWarp: () => {
      holdWarp = true;
    },
    setName: (name: string | null) => {
      beltName = name;
    },
    setGroup: (id: number) => {
      group = id;
    },
    hideBelt: (hidden: boolean) => {
      missing = hidden;
    },
  };
}
test("navigator warps to the exact claimed belt and confirms physical arrival", async () => {
  const x = setup();
  await x.native.navigate(target, claim);
  await x.native.assertAtTarget(target, claim);
  assert.equal(x.warps(), 1);
});
test("navigator rejects a target different from the claimed belt", async () => {
  const x = setup();
  await assert.rejects(
    x.native.navigate({ ...target, name: "other" }, claim),
    /exact claimed belt/,
  );
  assert.equal(x.warps(), 0);
});

test("coordinates at belt do not count as arrival while ship is warping", async () => {
  const x = setup();
  x.holdWarp();
  let completed = false;
  const work = x.native.navigate(target, claim).then(() => {
    completed = true;
  });
  for (let i = 0; i < 30 && x.warps() === 0; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(x.warps(), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(completed, false);
  await assert.rejects(x.native.assertAtTarget(target, claim), /safely reached/);
  x.setMode("STOP");
  await work;
  assert.equal(completed, true);
});
test("pending native transition blocks arrival even with stable coordinates", async () => {
  const x = setup();
  x.holdWarp();
  let completed = false;
  const work = x.native.navigate(target, claim).then(() => {
    completed = true;
  });
  for (let i = 0; i < 30 && x.warps() === 0; i++) await new Promise((r) => setTimeout(r, 2));
  x.setMode("STOP");
  x.setPhase("session-changing");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(completed, false);
  x.setPhase("ready");
  await work;
  assert.equal(completed, true);
});

test("both bracketing flight mode and own-scene mode must independently prove no warp", async () => {
  for (const [first, sceneMode, last, phase] of [
    ["WARP", "STOP", "STOP", null],
    ["STOP", "WARP", "STOP", null],
    ["STOP", "STOP", "WARP", null],
    ["STOP", "STOP", "STOP", "session-changing"],
    ["STOP", "STOP", "STOP", "unknown"],
    [null, "STOP", "STOP", null],
  ] as const) {
    let n = 0;
    const fetcher: typeof fetch = async (input) => {
      const p = new URL(String(input)).pathname;
      const body = p.endsWith("/status")
        ? {
            flight: {
              inSpace: true,
              shipID: 11,
              solarSystemID: 300,
              shipMode: n++ === 0 ? first : last,
              transition: {
                phase: phase ?? "ready",
                sessionStable: true,
                locationReady: true,
                sceneReady: true,
                egoReady: true,
                shipReady: true,
                boundContextReady: true,
              },
            },
          }
        : {
            space: {
              inSpace: true,
              shipID: 11,
              solarSystemID: 300,
              sampledAtMs: 10,
              ship: {
                itemID: 11,
                characterID: 1,
                mode: sceneMode,
                position: { x: 0, y: 0, z: 0 },
                radius: 10,
              },
              entities: [],
            },
          };
      return new Response(JSON.stringify({ ok: true, ...body }), {
        headers: { "content-type": "application/json" },
      });
    };
    const session: any = { flow: { requestOptions: () => ({}) } };
    const x = await readMiningReadiness(
      { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
      session,
      11,
      300,
      () => {},
    );
    assert.equal(x.ready, false, `${first}/${sceneMode}/${last}/${phase}`);
  }
});

test("movement gate is skipped at the belt and blocks warp before dispatch when Core is active", async () => {
  let calls = 0;
  const gate = async () => {
    calls++;
    throw Error("Core active");
  };
  const near = setup(gate);
  near.setNear();
  await near.native.navigate(target, claim);
  assert.equal(calls, 0);
  const far = setup(gate);
  await assert.rejects(far.native.navigate(target, claim), /Core active/);
  assert.equal(calls, 1);
  assert.equal(far.warps(), 0);
});

test("a Miner already on the belt reuses flight and snapshot without a third transport read", async () => {
  const paths: string[] = [],
    transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    };
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json({
      ok: true,
      ...(path.endsWith("/status")
        ? {
            flight: {
              inSpace: true,
              docked: false,
              shipID: 11,
              solarSystemID: 300,
              shipMode: "STOP",
              transition,
            },
          }
        : {
            space: {
              stateValid: true,
              inSpace: true,
              shipID: 11,
              solarSystemID: 300,
              sampledAtMs: Date.now(),
              ship: {
                itemID: 11,
                characterID: 1,
                mode: "STOP",
                position: { x: 0, y: 0, z: 0 },
                radius: 10,
              },
              entities: [{ itemID: 99, groupID: 9, position: { x: 0, y: 0, z: 0 }, radius: 1000 }],
            },
          }),
    });
  };
  const session: any = {
    flow: { requestOptions: () => ({}) },
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
  };
  const native = createNativeBeltNavigation(
    { characterID: 1, baseUrl: "http://fixture", fetch: fetcher },
    session,
    { shipID: 11, beltID: 99, current() {} },
  );
  await native.navigate(target, claim);
  assert.deepEqual(paths, ["/api/bridge/flight/status", "/api/bridge/space/snapshot"]);
});

test("departure waits for the recall proof and never sends a warp on unresolved recovery", async () => {
  let ready!: () => void, entered!: () => void;
  const latch = new Promise<void>((r) => {
    ready = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const nav = setup(undefined, async () => {
    entered();
    await latch;
  });
  const work = nav.native.navigate(target, claim);
  await started;
  assert.equal(nav.warps(), 0);
  ready();
  await work;
  assert.equal(nav.warps(), 1);
  const blocked = setup(undefined, async () => {
    throw Error("Drones returning");
  });
  await assert.rejects(blocked.native.navigate(target, claim), /Drones returning/);
  assert.equal(blocked.warps(), 0);
});
test("a transient missing grid row allows the next pass without accepting a wrong object", async () => {
  const x = setup();
  x.hideBelt(true);
  await assert.rejects(x.native.navigate(target, claim), FleetObservationUnavailable);
  assert.equal(x.warps(), 0);
  x.hideBelt(false);
  x.setGroup(10);
  await assert.rejects(x.native.navigate(target, claim), /not an asteroid belt/);
  assert.equal(x.warps(), 0);
  x.setGroup(9);
  x.setName(null);
  await x.native.navigate(target, claim);
  x.setName("Changed display name");
  await x.native.assertAtTarget(target, claim);
  assert.equal(x.warps(), 1);
});

function returningHauler(t: TestContext, startSystem: number, stalled = false) {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  let systemID = startSystem,
    mode = "STOP",
    distance = 300000,
    warps = 0,
    transits = 0;
  const arrive = () => {
    mode = "STOP";
    distance = 1000;
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/status"))
      return Response.json({
        ok: true,
        flight: {
          inSpace: true,
          docked: false,
          shipID: 11,
          solarSystemID: systemID,
          shipMode: mode,
          transition,
        },
      });
    if (mode === "WARP") {
      t.mock.timers.tick(stalled ? 110 : 30);
      if (!stalled) arrive();
    }
    return Response.json({
      ok: true,
      space: {
        inSpace: true,
        solarSystemID: systemID,
        shipID: 11,
        sampledAtMs: Date.now(),
        ship: { itemID: 11, characterID: 1, mode, position: { x: 0, y: 0, z: 0 }, radius: 10 },
        entities: [{ itemID: 99, groupID: 9, position: { x: distance, y: 0, z: 0 }, radius: 10 }],
      },
    });
  };
  const session: any = {
    store: {
      station: { get: () => ({ online: { characterID: 1 } }) },
      travel: { get: () => ({}), subscribe: () => () => {} },
      customBot: {
        subscribe: (publish: (value: unknown) => void) => {
          publish({ status: "stopped", phase: PROGRAM_DONE_PHASE });
          return () => {};
        },
      },
    },
    flow: {
      requestOptions: () => ({}),
      startCustomBot: async () => {
        transits++;
        systemID = 300;
        t.mock.timers.tick(95);
      },
      cancelHostedHome: async () => {},
      stopCustomBot() {},
      flying: {
        async warpAsTheAutopilot(id: number) {
          assert.equal(id, 99);
          warps++;
          mode = "WARP";
        },
      },
    },
  };
  const native = createNativeBeltNavigation(
    { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
    session,
    { shipID: 11, beltID: 99, current() {}, pollMs: 1, timeoutMs: 100 },
  );
  return { native, arrive, warps: () => warps, transits: () => transits };
}

test("a late Jump leaves the local belt warp its own arrival window", async (t) => {
  const x = returningHauler(t, 301);
  await x.native.navigate(target, claim);
  assert.equal(x.transits(), 1);
  assert.equal(x.warps(), 1);
  assert.ok(Date.now() > 10100);
});

test("a belt timeout yields to the next pass, which accepts a finished warp without replay", async (t) => {
  const x = returningHauler(t, 300, true);
  await assert.rejects(x.native.navigate(target, claim), FleetObservationUnavailable);
  assert.equal(x.warps(), 1);
  x.arrive();
  await x.native.navigate(target, claim);
  assert.equal(x.warps(), 1);
});
