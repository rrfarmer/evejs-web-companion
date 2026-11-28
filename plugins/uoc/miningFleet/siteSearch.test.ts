import test from "node:test";
import assert from "node:assert/strict";
import { resolveMiningSite } from "./siteSearch.ts";
const dict = (entries: any[] = []) => ({ type: "dict", entries });
function fixture() {
  let doc: any = null,
    clock = 1000,
    space = false,
    orders = 0,
    stop = false,
    lost = false,
    land = true,
    bad = false,
    empty = false,
    refusal = false,
    stale = false;
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const key = 5800000000000 + 300 * 1000 + 1;
  const rows = [
    dict([
      [
        key,
        {
          type: "object",
          name: "util.KeyVal",
          args: dict([
            ["instanceID", 89],
            ["targetID", "ORE-1"],
            ["archetypeID", 27],
            ["scanStrengthAttribute", 211],
            ["dungeonID", 12245],
            ["solarSystemID", 300],
            ["position", [1, 2, 3]],
          ]),
        },
      ],
    ]),
    dict(),
    dict(),
    dict(),
  ];
  const run: any = {
    botID: "b",
    characterID: 1,
    baseUrl: "http://bff",
    fetch: async (input: any) => {
      const path = new URL(String(input)).pathname;
      const flight = {
        inSpace: space,
        docked: !space,
        shipID: 11,
        solarSystemID: 300,
        stationID: space ? null : 60000001,
        shipMode: "STOP",
        transition,
      };
      const scene = {
        stateValid: true,
        inSpace: true,
        shipID: 11,
        solarSystemID: 300,
        sampledAtMs: stale ? 1 : clock,
        ship: {
          itemID: 11,
          characterID: 1,
          mode: "STOP",
          position: { x: 0, y: 0, z: 0 },
          radius: 10,
        },
        entities: [],
      };
      return new Response(
        JSON.stringify({ ok: true, ...(path.endsWith("/status") ? { flight } : { space: scene }) }),
        { headers: { "content-type": "application/json" } },
      );
    },
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        sessionGeneration: () => 2,
        bridgeDo: async () => {
          orders++;
          if (refusal)
            throw Object.assign(Error("session busy"), { code: "SESSION_CHANGE_IN_PROGRESS" });
          if (land) space = true;
          if (lost) throw Error("lost");
        },
        bridgeAsk: async () => (bad ? null : empty ? [dict(), dict(), dict(), dict()] : rows),
      },
    },
  };
  const config: any = {
    shipID: 11,
    systemID: 300,
    family: "ORE",
    current() {},
    stopRequested: () => stop,
    document: {
      read: () => doc,
      write: (v: any) => {
        doc = structuredClone(v);
      },
    },
    now: () => clock,
    wait: async () => {
      clock += 30000;
    },
  };
  return {
    run,
    session,
    config,
    resolve: () => resolveMiningSite(run, session, config),
    doc: () => doc,
    orders: () => orders,
    lost: () => {
      lost = true;
    },
    noLand: () => {
      land = false;
    },
    stop: () => {
      stop = true;
    },
    empty: () => {
      empty = true;
    },
    bad: () => {
      bad = true;
    },
    refuse: () => {
      refusal = true;
    },
    stale: () => {
      stale = true;
    },
  };
}
test("lost undock ACK reconciles physical scene once and persists exact classified site", async () => {
  const x = fixture();
  x.lost();
  const site: any = await x.resolve();
  assert.equal(site.siteFamily, "ORE");
  assert.equal(site.instanceID, 89);
  assert.equal(x.orders(), 1);
  assert.equal(x.doc().pending, null);
  assert.equal(x.doc().history[0].intent.acknowledged, false);
  assert.equal(((await x.resolve()) as any).scannerKey, site.scannerKey);
  assert.equal(x.orders(), 1);
});
test("unknown undock is retained and never redispatched", async () => {
  const x = fixture();
  x.noLand();
  x.lost();
  await assert.rejects(x.resolve(), /outcome remains unknown/);
  assert.ok(x.doc().pending);
  await assert.rejects(x.resolve(), /outcome remains unknown/);
  assert.equal(x.orders(), 1);
});
test("valid empty scanner is bounded negative; malformed scanner stays unknown", async () => {
  const x = fixture();
  x.empty();
  const result: any = await x.resolve();
  assert.equal(result.kind, "NO_SITE_OBSERVED");
  assert.ok(result.scans > 0);
  const y = fixture();
  y.bad();
  await assert.rejects(y.resolve(), /unreadable/);
});
test("stop before dispatch causes no undock", async () => {
  const x = fixture();
  x.stop();
  assert.equal(((await x.resolve()) as any).kind, "STOPPED");
  assert.equal(x.orders(), 0);
});
test("Stop during an accepted undock waits for the physical in-space settlement", async () => {
  const x = fixture(),
    original = x.session.flow.flying.bridgeDo;
  x.session.flow.flying.bridgeDo = async (...args: any[]) => {
    x.stop();
    await original(...args);
  };
  assert.equal(((await x.resolve()) as any).kind, "STOPPED");
  assert.equal(x.orders(), 1);
  assert.equal(x.doc().pending, null);
  assert.equal(x.doc().history[0].outcome, "undocked");
});
test("family selection uses native classification and skips unavailable sites", async () => {
  for (const family of ["ORE", "MOON", "ICE"] as const) {
    const x = fixture();
    x.config.family = family;
    const base = family === "MOON" ? 5910000000000 : 5800000000000,
      archetype = family === "ICE" ? 28 : 27,
      dungeon = family === "MOON" ? 0 : 12245;
    const row = (n: number) => [
      base + 300 * 1000 + n,
      {
        type: "object",
        name: "util.KeyVal",
        args: dict([
          ["instanceID", n + 88],
          ["targetID", `${family}-${n}`],
          ["archetypeID", archetype],
          ["scanStrengthAttribute", 211],
          ["dungeonID", dungeon],
          ["solarSystemID", 300],
          ["position", [n, 2, 3]],
        ]),
      },
    ];
    x.session.flow.flying.bridgeAsk = async () => [dict([row(2), row(1)]), dict(), dict(), dict()];
    x.config.available = (s: any) => s.instanceID !== 89;
    const result: any = await x.resolve();
    assert.equal(result.siteFamily, family);
    assert.equal(result.instanceID, 90);
  }
});

test("stale own scene cannot retire undock intent", async () => {
  const x = fixture();
  x.stale();
  await assert.rejects(x.resolve(), /outcome remains unknown/);
  assert.ok(x.doc().pending);
  assert.equal(x.orders(), 1);
});
test("exact predispatch session refusal with fresh dock proof is durable and never replayed", async () => {
  const x = fixture();
  x.refuse();
  await assert.rejects(x.resolve(), /not dispatched/);
  assert.equal(x.doc().pending, null);
  assert.equal(x.doc().history[0].refusal.code, "SESSION_CHANGE_IN_PROGRESS");
  await assert.rejects(x.resolve(), /no undock replay/);
  assert.equal(x.orders(), 1);
});

test("native locality callback chooses only a still-eligible exact scanner site", async () => {
  for (const foreign of [false, true]) {
    const x = fixture();
    let selected = 0;
    x.config.select = async (sites: any[]) => {
      selected++;
      return foreign ? { ...sites[0], instanceID: 999 } : sites[0];
    };
    if (foreign) {
      await assert.rejects(x.resolve(), /selection changed/);
      assert.equal(x.doc().site, null);
    } else {
      assert.equal(((await x.resolve()) as any).instanceID, 89);
      assert.equal(x.doc().site.instanceID, 89);
    }
    assert.equal(selected, 1);
    assert.equal(x.orders(), 1);
  }
});
