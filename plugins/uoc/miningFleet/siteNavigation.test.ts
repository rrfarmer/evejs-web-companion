import test from "node:test";
import assert from "node:assert/strict";
import { createSiteNavigation } from "./siteNavigation.ts";
import { targetKey } from "./targetBoard.ts";
const site: any = {
  scannerKey: 1234,
  instanceID: 5678,
  label: "mining-anomaly:ICE:encoded",
  archetypeID: 28,
  observedAt: 1,
  target: {
    kind: "ICE",
    systemID: 300,
    name: "mining-anomaly:ICE:encoded",
    siteID: 1234,
    instanceID: 5678,
    position: { x: 1000000, y: 0, z: 0 },
  },
};
function fixture() {
  let state: unknown = null,
    mode = "STOP",
    position = 0,
    clock = 1000,
    warps = 0,
    fail = false,
    replaced = false,
    active = true,
    draining = false,
    scannerBad = false,
    scannerEmpty = false,
    stale = false,
    missingAfterWarp = false;
  const claim = {
    key: targetKey(site.target),
    operationID: "op",
    runID: "run",
    generation: 3,
    expiresAt: 100000,
  };
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const fetcher: typeof fetch = async (input) => {
    const p = new URL(String(input)).pathname;
    const body = p.endsWith("/status")
      ? { flight: { inSpace: true, shipID: 11, solarSystemID: 300, shipMode: mode, transition } }
      : {
          space: {
            stateValid: true,
            inSpace: true,
            shipID: 11,
            solarSystemID: 300,
            sampledAtMs: clock,
            ship: {
              itemID: 11,
              characterID: 1,
              mode,
              position: { x: position, y: 0, z: 0 },
              radius: 10,
            },
            entities: [],
          },
        };
    return new Response(JSON.stringify({ ok: true, ...body }), {
      headers: { "content-type": "application/json" },
    });
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      warpToProbeResult: async (label: string, range: number) => {
        assert.equal(label, site.label);
        assert.equal(range, 0);
        warps++;
        if (fail) throw Error("warp reply lost");
        if (missingAfterWarp) scannerEmpty = true;
        mode = "WARP";
        position = 1000000;
      },
    },
  };
  const config: any = {
    shipID: 11,
    site,
    claim,
    authority: () =>
      active ? { state: draining ? "DRAINING" : "ACTIVE", target: site.target, claim } : null,
    readSites: async () => {
      if (scannerBad) throw Error("scanner unreadable");
      return scannerEmpty
        ? []
        : [
            replaced
              ? { ...site, instanceID: 8888, target: { ...site.target, instanceID: 8888 } }
              : stale
                ? { ...site, observedAt: 1 }
                : { ...site, observedAt: clock },
          ];
    },
    current() {},
    document: {
      read: () => state,
      write: (v: unknown) => {
        state = structuredClone(v);
      },
    },
    now: () => clock,
    wait: async () => {
      clock += 10;
      mode = "STOP";
    },
    timeoutMs: 100,
    pollMs: 10,
  };
  const make = (allowDraining = false) =>
    createSiteNavigation({ characterID: 1, baseUrl: "http://bff", fetch: fetcher }, session, {
      ...config,
      allowDraining,
    });
  return {
    make,
    setSite: (value: any) => {
      config.site = value;
    },
    setReadSites: (read: any) => {
      config.readSites = read;
    },
    warps: () => warps,
    setFail: () => {
      fail = true;
    },
    setReplaced: () => {
      replaced = true;
    },
    setInactive: () => {
      active = false;
    },
    setDraining: () => {
      draining = true;
    },
    setScannerBad: () => {
      scannerBad = true;
    },
    setScannerEmpty: () => {
      scannerEmpty = true;
    },
    removeAfterWarp: () => {
      missingAfterWarp = true;
    },
    setStale: () => {
      stale = true;
      clock = 20000;
    },
    setPosition: (n: number) => {
      position = n;
    },
    advance: () => {
      clock += 10;
    },
    setMode: (s: string) => {
      mode = s;
    },
  };
}
test("native acknowledged warp completes only after fresh non-warp own-scene arrival", async () => {
  const x = fixture(),
    nav = x.make();
  await nav.navigate();
  assert.equal(x.warps(), 1);
  assert.equal(nav.snapshot().pending, null);
  assert.equal(nav.snapshot().history.length, 1);
});
test("an arrived miner reads the scanner only around the physical arrival check", async () => {
  const x = fixture();
  let scannerReads = 0;
  x.setPosition(1000000);
  x.setReadSites(async () => {
    scannerReads++;
    return [{ ...site, observedAt: 1000 }];
  });
  await x.make().navigate();
  assert.equal(x.warps(), 0);
  assert.equal(scannerReads, 2);
});
test("freight can revisit the exact draining anomaly using its own scanner result", async () => {
  const x = fixture();
  x.setDraining();
  await assert.rejects(x.make().navigate(), /claim is stale or lost/);
  assert.equal(x.warps(), 0);
  await x.make(true).navigate();
  assert.equal(x.warps(), 1);
  const missing = fixture();
  missing.setDraining();
  missing.setScannerEmpty();
  await assert.rejects(missing.make(true).navigate(), /missing or ambiguous/);
  assert.equal(missing.warps(), 0);
});
test("lost warp acknowledgement resolves only after an ordered fresh native arrival without replay", async () => {
  const x = fixture(),
    nav = x.make();
  x.setFail();
  await assert.rejects(nav.navigate(), /reply lost/);
  x.setPosition(1000000);
  await assert.rejects(x.make().navigate(), /unknown/);
  assert.equal(x.make().snapshot().pending?.acknowledged, false);
  x.advance();
  const restored = x.make();
  await restored.navigate();
  assert.equal(x.warps(), 1);
  assert.equal(restored.snapshot().pending, null);
  assert.equal(restored.snapshot().history[0]?.acknowledged, false);
  assert.ok(
    restored.snapshot().history[0]!.after.sampledAtMs >
      restored.snapshot().history[0]!.before.sampledAtMs,
  );
});
test("replaced instance, unreadable scan and lost claim block without warp", async () => {
  for (const setup of [
    (x: any) => x.setReplaced(),
    (x: any) => x.setScannerBad(),
    (x: any) => x.setInactive(),
  ]) {
    const x = fixture();
    setup(x);
    await assert.rejects(x.make().navigate());
    assert.equal(x.warps(), 0);
  }
});
test("coordinates during warp are not arrival proof", async () => {
  const x = fixture();
  x.setPosition(1000000);
  x.setMode("WARP");
  const nav = x.make();
  assert.equal(await nav.observeArrival(), false);
  assert.equal(x.warps(), 0);
});

test("stale scanner data and a missing exact site cannot authorize movement", async () => {
  for (const setup of [(x: any) => x.setScannerEmpty(), (x: any) => x.setStale()]) {
    const x = fixture();
    setup(x);
    await assert.rejects(x.make().navigate());
    assert.equal(x.warps(), 0);
  }
});
test("two concurrent callers share the original warp intent", async () => {
  const x = fixture(),
    nav = x.make(),
    a = nav.navigate(),
    b = nav.navigate();
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(x.warps(), 1);
});

test("scanner disappearance after an acknowledged warp preserves its pending custody", async () => {
  const x = fixture(),
    nav = x.make();
  x.removeAfterWarp();
  await assert.rejects(nav.navigate(), /missing or ambiguous/);
  assert.equal(x.warps(), 1);
  assert.equal(nav.snapshot().pending?.acknowledged, true);
  assert.equal(nav.snapshot().arrivedAt, null);
  await assert.rejects(nav.navigate(), /missing or ambiguous/);
  assert.equal(x.warps(), 1);
});

test("site replacement after lost acknowledgement cannot reconcile a superficially arrived ship", async () => {
  const x = fixture(),
    nav = x.make();
  x.setFail();
  await assert.rejects(nav.navigate(), /reply lost/);
  x.setPosition(1000000);
  x.advance();
  x.setReplaced();
  await assert.rejects(x.make().navigate(), /replaced or changed/);
  assert.equal(x.warps(), 1);
  assert.equal(x.make().snapshot().pending?.acknowledged, false);
});

test("classified site rechecks exact family and source before a native warp", async () => {
  const selected = { ...site, siteFamily: "ICE", sourceDungeonID: 5497 };
  const good = fixture();
  good.setSite(selected);
  good.setReadSites(async () => [{ ...selected, observedAt: 1000 }]);
  await good.make().navigate();
  assert.equal(good.warps(), 1);
  for (const patch of [
    { sourceDungeonID: 5498 },
    { siteFamily: "UNKNOWN" },
    { siteFamily: undefined, sourceDungeonID: undefined },
  ]) {
    const x = fixture();
    x.setSite(selected);
    x.setReadSites(async () => [{ ...selected, ...patch, observedAt: 1000 }]);
    await assert.rejects(x.make().navigate(), /replaced or changed/);
    assert.equal(x.warps(), 0);
  }
});
