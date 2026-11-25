import test from "node:test";
import assert from "node:assert/strict";
import { createAnomalyNavigation, settlePendingNavigation } from "./navigation.ts";
function fixture() {
  let time = 100,
    doc: unknown = null,
    calls: string[] = [],
    sample: any = {
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: true,
      inSpace: false,
      inWarp: false,
      sampledAt: 100,
      keeper: null,
    },
    fail = false;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: 100,
    },
    roomID: 0,
    operationID: "op",
    operationRunID: "run",
    leader: true,
    document: {
      read: () => doc,
      write: (v) => {
        doc = structuredClone(v);
      },
    },
    current() {},
    sample: async () => ({ ...sample, sampledAt: time }),
    undock: async () => {
      calls.push("undock");
      if (fail) throw Error("unknown");
      sample = { ...sample, docked: false, inSpace: true };
      time++;
    },
    warpSite: async () => {
      calls.push("warp");
      sample = { ...sample, keeper: { dungeonID: 5579, instanceID: 5, roomID: 0 } };
      time++;
    },
    warpLeader: async () => {
      throw Error("wrong warp");
    },
    sleep: async () => {
      time++;
    },
    now: () => time,
    timeoutMs: 10,
  });
  return {
    nav,
    calls,
    fail: () => (fail = true),
    arrive: () => {
      sample = { ...sample, docked: false, inSpace: true };
      time++;
    },
  };
}
test("undock and warp each require fresh physical observation", async () => {
  const f = fixture();
  await f.nav.navigate();
  assert.deepEqual(f.calls, ["undock", "warp"]);
  assert.equal(f.nav.snapshot().pending, null);
  assert.equal(f.nav.snapshot().history.length, 2);
});
test("unknown dispatch is never replayed; fresh physical undock reconciles it", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.nav.navigate(), /unknown/);
  assert.equal(f.nav.snapshot().pending?.acknowledged, false);
  await assert.rejects(f.nav.navigate(), /unresolved/);
  assert.deepEqual(f.calls, ["undock"]);
  f.arrive();
  assert.equal(await f.nav.reconcile(), true);
  assert.equal(f.nav.snapshot().history[0]?.acknowledged, false);
});

test("physical arrival settles movement while keeper remains independently required and warp is not replayed", async () => {
  let time = 100,
    doc: any = null,
    calls = 0;
  const phases: string[] = [];
  let sample: any = {
    characterID: 1,
    shipID: 2,
    systemID: 3,
    docked: false,
    inSpace: true,
    inWarp: false,
    sampledAt: 100,
    position: { x: 500000, y: 0, z: 0 },
    keeper: null,
  };
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: 100,
    },
    roomID: 0,
    operationID: "op",
    operationRunID: "run",
    leader: true,
    document: { read: () => doc, write: (v) => (doc = structuredClone(v)) },
    current() {},
    sample: async () => ({ ...sample, sampledAt: time }),
    undock: async () => {},
    warpSite: async () => {
      calls++;
      sample.position = { x: 10, y: 0, z: 0 };
      time++;
    },
    warpLeader: async () => {},
    onPhase: (phase) => phases.push(phase),
    sleep: async () => {
      time++;
    },
    now: () => time,
    timeoutMs: 5,
  });
  await assert.rejects(nav.navigate(), /keeper entry/);
  assert.equal(nav.snapshot().pending, null);
  assert.deepEqual(phases, ["travel", "waiting-keeper"]);
  assert.equal(nav.snapshot().history[0]?.after.keeper, null);
  await assert.rejects(nav.navigate(), /keeper entry/);
  assert.equal(calls, 1);
});

test("acknowledged warp survives thrown and stale reads before native keeper arrival", async () => {
  let time = 100000,
    stage = 0,
    calls = 0,
    saved: any = null;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: time,
    },
    roomID: 0,
    operationID: "retry",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => {
      if (calls && stage++ === 0) throw Error("scene temporarily unavailable");
      if (calls && stage === 2)
        return {
          characterID: 1,
          shipID: 2,
          systemID: 3,
          docked: false,
          inSpace: true,
          inWarp: false,
          sampledAt: time - 70000,
          position: { x: 0, y: 0, z: 0 },
          keeper: null,
        };
      return {
        characterID: 1,
        shipID: 2,
        systemID: 3,
        docked: false,
        inSpace: true,
        inWarp: false,
        sampledAt: time + (calls ? 500 : 0),
        position: { x: calls ? 0 : 500000, y: 0, z: 0 },
        keeper: calls ? { dungeonID: 5579, instanceID: 5, roomID: 0 } : null,
      };
    },
    undock: async () => {},
    warpSite: async () => {
      calls++;
      time++;
    },
    warpLeader: async () => {},
    sleep: async () => {
      time += 10000;
    },
    now: () => time,
    timeoutMs: 180000,
    readTimeoutMs: 90000,
  });
  await nav.navigate();
  assert.equal(calls, 1);
  assert.equal(saved.pending, null);
  assert.match(saved.firstUnavailable.reason, /temporarily unavailable/);
  assert.equal(saved.firstUnavailable.characterID, null);
  assert.ok(time >= 120000);
});
test("future tolerance accepts half a second and rejects beyond five seconds until fresh", async () => {
  let time = 100000,
    n = 0,
    saved: any = null;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: time,
    },
    roomID: 0,
    operationID: "future",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => ({
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: time + (n++ === 0 ? 5001 : 500),
      keeper: { dungeonID: 5579, instanceID: 5, roomID: 0 },
    }),
    undock: async () => {},
    warpSite: async () => {
      throw Error("no warp");
    },
    warpLeader: async () => {},
    sleep: async () => {
      time += 1000;
    },
    now: () => time,
    readTimeoutMs: 10000,
  });
  await nav.navigate();
  assert.equal(n, 2);
  assert.match(saved.firstUnavailable.reason, /future skew/);
  assert.equal(saved.firstUnavailable.sampledAt, 105001);
});
test("unknown observations retain acknowledged warp until later physical reconciliation without inventing keeper", async () => {
  let time = 100000,
    calls = 0,
    saved: any = null,
    recover = false;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: time,
    },
    roomID: 0,
    operationID: "unknown",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => {
      if (calls && !recover) throw Error("read unavailable");
      return {
        characterID: 1,
        shipID: 2,
        systemID: 3,
        docked: false,
        inSpace: true,
        inWarp: false,
        sampledAt: time,
        position: { x: recover ? 0 : 500000, y: 0, z: 0 },
        keeper: null,
      };
    },
    undock: async () => {},
    warpSite: async () => {
      calls++;
      time++;
    },
    warpLeader: async () => {},
    sleep: async () => {
      time += 500;
    },
    now: () => time,
    timeoutMs: 2000,
    readTimeoutMs: 1000,
  });
  await assert.rejects(nav.navigate(), /unresolved/);
  assert.equal(saved.pending.acknowledged, true);
  assert.equal(calls, 1);
  recover = true;
  time++;
  assert.equal(await nav.reconcile(), true);
  assert.equal(saved.pending, null);
  assert.equal(saved.history[0].after.keeper, null);
  assert.equal(calls, 1);
});

test("retired owner is never treated as a retryable native read failure", async () => {
  let alive = true,
    calls = 0;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: 100,
    },
    roomID: 0,
    operationID: "owner",
    operationRunID: "run",
    leader: true,
    document: { read: () => null, write() {} },
    current() {
      if (!alive) throw Error("owner retired");
    },
    sample: async () => {
      calls++;
      alive = false;
      throw Error("read failed");
    },
    undock: async () => {},
    warpSite: async () => {},
    warpLeader: async () => {},
    sleep: async () => {},
    now: () => 100,
    readTimeoutMs: 1000,
  });
  await assert.rejects(nav.navigate(), /owner retired/);
  assert.equal(calls, 1);
});

function pendingSettlement() {
  let time = 100000,
    alive = true,
    finish = false,
    settles = 0;
  const site = {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: 90000,
    },
    identity = JSON.stringify(["settle", "run", 1, 2, 3, 5, 5579, 7, 0, true]),
    before = {
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: 90000,
      position: { x: 500000, y: 0, z: 0 },
      keeper: null,
    };
  let saved: any = {
    version: 1,
    identity,
    pending: { kind: "site-warp", issuedAt: 95000, before, acknowledged: true },
    history: [],
  };
  const current = () => {
      if (!alive) throw Error("owner retired");
    },
    nav = createAnomalyNavigation({
      characterID: 1,
      shipID: 2,
      site,
      roomID: 0,
      operationID: "settle",
      operationRunID: "run",
      leader: true,
      document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
      current,
      sample: async () => ({
        ...before,
        sampledAt: time,
        inWarp: !finish,
        position: { x: finish ? 0 : 500000, y: 0, z: 0 },
      }),
      undock: async () => {
        throw Error("unexpected undock");
      },
      warpSite: async () => {
        throw Error("unexpected warp");
      },
      warpLeader: async () => {
        throw Error("unexpected warp");
      },
      sleep: async (ms) => {
        time += ms;
        if (time >= 145000) finish = true;
      },
      now: () => time,
    });
  return {
    nav,
    current,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      if (time >= 145000) finish = true;
    },
    settle: async () => {
      settles++;
    },
    retire: () => (alive = false),
    get settles() {
      return settles;
    },
    get saved() {
      return saved;
    },
  };
}
test("Stop waits through a 45-second pending warp before fighter settlement", async () => {
  const x = pendingSettlement();
  await settlePendingNavigation(x.nav, x.current, x.sleep, x.settle, x.now);
  assert.equal(x.now(), 145000);
  assert.equal(x.saved.pending, null);
  assert.equal(x.saved.history[0].after.keeper, null);
  assert.equal(x.settles, 1);
});
test("Stop keeps pending movement and does not settle fighter after deadline or owner loss", async () => {
  const x = pendingSettlement();
  await assert.rejects(
    settlePendingNavigation(x.nav, x.current, x.sleep, x.settle, x.now, 2000),
    /unresolved/,
  );
  assert.ok(x.saved.pending);
  assert.equal(x.settles, 0);
  x.retire();
  await assert.rejects(
    settlePendingNavigation(x.nav, x.current, x.sleep, x.settle, x.now),
    /owner retired/,
  );
  assert.ok(x.saved.pending);
  assert.equal(x.settles, 0);
});

function offsetProof(wall: number, sim: number, overrides: any = {}) {
  return {
    kind: "native-own-ship-location",
    characterID: 1,
    shipID: 2,
    systemID: 3,
    locationID: 3,
    botID: "bot",
    sessionGeneration: 4,
    readStartedAt: wall - 2,
    readFinishedAt: wall - 1,
    timeFiletime: "134385676761330000",
    wallclockFiletime: "134385676761330001",
    simulationSampledAt: sim,
    ...overrides,
  };
}
test("27 minute simulation offset with held ship proof and fresh keeper permits exactly one warp", async () => {
  let wall = 2000000,
    sim = 380000,
    calls = 0,
    saved: any = null;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    botID: "bot",
    sessionGeneration: 4,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: wall,
    },
    roomID: 0,
    operationID: "offset",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => ({
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: sim,
      position: { x: calls ? 0 : 500000, y: 0, z: 0 },
      keeper: calls ? { dungeonID: 5579, instanceID: 5, roomID: 0 } : null,
      keeperObservedAt: wall,
      nativeProof: offsetProof(wall, sim),
    }),
    undock: async () => {},
    warpSite: async () => {
      calls++;
      wall += 1000;
      sim += 1000;
    },
    warpLeader: async () => {},
    sleep: async () => {
      wall += 500;
      sim += 500;
    },
    now: () => wall,
  });
  await nav.navigate();
  assert.equal(calls, 1);
  assert.equal(saved.pending, null);
  assert.equal(saved.history[0].after.sampledAt, 381000);
  assert.equal(saved.history[0].after.keeper.instanceID, 5);
});
test("offset warp cannot settle on proximity, old keeper, mismatched owner or stale held proof", async () => {
  for (const mode of ["proximity", "oldkeeper", "owner", "stale", "generation"]) {
    let wall = 2000000,
      sim = 381000;
    const before = {
        characterID: 1,
        shipID: 2,
        systemID: 3,
        docked: false,
        inSpace: true,
        inWarp: false,
        sampledAt: 380000,
        position: { x: 500000, y: 0, z: 0 },
        keeper: null,
      },
      identity = JSON.stringify(["offset", "run", 1, 2, 3, 5, 5579, 7, 0, true]);
    let saved: any = {
      version: 1,
      identity,
      pending: { kind: "site-warp", issuedAt: 1999000, before, acknowledged: true },
      history: [],
    };
    const proof = offsetProof(
      wall,
      sim,
      mode === "owner"
        ? { shipID: 99 }
        : mode === "stale"
          ? { readStartedAt: wall - 61000 }
          : mode === "generation"
            ? { sessionGeneration: 8 }
            : {},
    );
    const nav = createAnomalyNavigation({
      characterID: 1,
      shipID: 2,
      botID: "bot",
      sessionGeneration: 4,
      site: {
        systemID: 3,
        instanceID: 5,
        dungeonID: 5579,
        scannerKey: 7,
        label: "A",
        position: { x: 0, y: 0, z: 0 },
        observedAt: wall,
      },
      roomID: 0,
      operationID: "offset",
      operationRunID: "run",
      leader: true,
      document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
      current() {},
      sample: async () => ({
        characterID: 1,
        shipID: 2,
        systemID: 3,
        docked: false,
        inSpace: true,
        inWarp: false,
        sampledAt: sim,
        position: { x: 0, y: 0, z: 0 },
        keeper: mode === "proximity" ? null : { dungeonID: 5579, instanceID: 5, roomID: 0 },
        keeperObservedAt: mode === "oldkeeper" ? 1998999 : wall,
        nativeProof: proof,
      }),
      undock: async () => {
        throw Error("unexpected");
      },
      warpSite: async () => {
        throw Error("replay");
      },
      warpLeader: async () => {},
      sleep: async () => {
        wall += 1000;
      },
      now: () => wall,
      readTimeoutMs: 1000,
    });
    if (["oldkeeper", "owner", "stale", "generation"].includes(mode))
      await assert.rejects(nav.reconcile(), /unavailable/);
    else assert.equal(await nav.reconcile(), false);
    assert.ok(saved.pending, mode);
  }
});

test("old pending undock reconciles exact native location across simulation offset without replay", async () => {
  const wall = 2000000,
    sim = 380000,
    before = {
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: true,
      inSpace: false,
      inWarp: false,
      sampledAt: 1998000,
      keeper: null,
    },
    identity = JSON.stringify(["offset", "run", 1, 2, 3, 5, 5579, 7, 0, true]);
  let saved: any = {
      version: 1,
      identity,
      pending: { kind: "undock", issuedAt: 1999000, before, acknowledged: false },
      history: [],
    },
    undocks = 0;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    botID: "bot",
    sessionGeneration: 4,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: wall,
    },
    roomID: 0,
    operationID: "offset",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => ({
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: sim,
      position: { x: 500000, y: 0, z: 0 },
      keeper: null,
      keeperObservedAt: wall,
      nativeProof: offsetProof(wall, sim),
    }),
    undock: async () => {
      undocks++;
    },
    warpSite: async () => {},
    warpLeader: async () => {},
    sleep: async () => {},
    now: () => wall,
  });
  assert.equal(await nav.reconcile(), true);
  assert.equal(saved.pending, null);
  assert.equal(undocks, 0);
  assert.equal(saved.history[0].after.sampledAt, sim);
});

test("post-intent native keeper reconciles a warp despite a backward simulation rebase", async () => {
  let wall = 2000000,
    sim = 380000,
    calls = 0,
    saved: any = null;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    botID: "bot",
    sessionGeneration: 4,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: wall,
    },
    roomID: 0,
    operationID: "rebase",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => ({
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: sim,
      position: { x: calls ? 0 : 500000, y: 0, z: 0 },
      keeper: calls ? { dungeonID: 5579, instanceID: 5, roomID: 0 } : null,
      keeperObservedAt: wall,
      nativeProof: offsetProof(wall, sim),
    }),
    undock: async () => {},
    warpSite: async () => {
      calls++;
      wall += 1000;
      sim = 370000;
    },
    warpLeader: async () => {},
    sleep: async () => {
      wall += 500;
    },
    now: () => wall,
  });
  await nav.navigate();
  assert.equal(calls, 1);
  assert.equal(saved.pending, null);
  assert.equal(saved.history[0].after.sampledAt, 370000);
  assert.equal(saved.history[0].after.keeper.instanceID, 5);
});
test("a pre-intent native ship proof cannot settle a post-command warp even with exact keeper", async () => {
  const wall = 2000000,
    sim = 370000,
    before = {
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: 380000,
      position: { x: 500000, y: 0, z: 0 },
      keeper: null,
    },
    identity = JSON.stringify(["offset", "run", 1, 2, 3, 5, 5579, 7, 0, true]);
  let saved: any = {
      version: 1,
      identity,
      pending: { kind: "site-warp", issuedAt: 1999000, before, acknowledged: true },
      history: [],
    },
    calls = 0;
  const nav = createAnomalyNavigation({
    characterID: 1,
    shipID: 2,
    botID: "bot",
    sessionGeneration: 4,
    site: {
      systemID: 3,
      instanceID: 5,
      dungeonID: 5579,
      scannerKey: 7,
      label: "A",
      position: { x: 0, y: 0, z: 0 },
      observedAt: wall,
    },
    roomID: 0,
    operationID: "offset",
    operationRunID: "run",
    leader: true,
    document: { read: () => saved, write: (v) => (saved = structuredClone(v)) },
    current() {},
    sample: async () => ({
      characterID: 1,
      shipID: 2,
      systemID: 3,
      docked: false,
      inSpace: true,
      inWarp: false,
      sampledAt: sim,
      position: { x: 0, y: 0, z: 0 },
      keeper: { dungeonID: 5579, instanceID: 5, roomID: 0 },
      keeperObservedAt: wall,
      nativeProof: offsetProof(wall, sim, { readStartedAt: 1998999, readFinishedAt: 1999000 }),
    }),
    undock: async () => {},
    warpSite: async () => {
      calls++;
    },
    warpLeader: async () => {},
    sleep: async () => {},
    now: () => wall,
  });
  assert.equal(await nav.reconcile(), false);
  assert.ok(saved.pending);
  assert.equal(calls, 0);
});
