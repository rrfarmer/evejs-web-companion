import test from "node:test";
import assert from "node:assert/strict";
import { createTractorController, type TractorIdentity, type TractorRead } from "./tractor.ts";
const identity: TractorIdentity = {
  operationID: "op",
  runID: "epoch",
  botID: "bot",
  sessionGeneration: 4,
  characterID: 10,
  shipID: 11,
  moduleID: 12,
  typeID: 24348,
  flagID: 27,
  canID: 13,
  systemID: 14,
  claimGeneration: 1,
  targetGeneration: 2,
};
const q = { typeID: 24348, effectID: 650, effectName: "tractorBeamCan" as const };
function fixture() {
  let t = 1000,
    locked = false,
    active = false,
    x = 3000,
    owner = 10,
    owns = true,
    failWrite = false,
    lockError = false,
    activationError = false,
    activationWithoutEffect = false,
    deactivationError = false,
    saved: any = null;
  const calls: string[] = [];
  const dict = (x: any) => ({ type: "dict", entries: Object.entries(x) }),
    long = (value: string) => ({ type: "long", value }),
    effect = (id: number, target: number | null) => [
      12,
      10,
      11,
      target,
      null,
      [],
      id,
      long("134385165369120001"),
      60000,
      1,
    ];
  const read = async (): Promise<TractorRead> => ({
    observedAt: t,
    shipID: 11,
    systemID: 14,
    canID: 13,
    inSpace: true,
    shipPosition: { x: 0, y: 0, z: 0 },
    canPosition: { x, y: 0, z: 0 },
    shipRadius: 1,
    canRadius: 1,
    lockedTargetIDs: locked ? [13] : [],
    module: {
      type: "object",
      name: "util.KeyVal",
      args: dict({
        itemID: 12,
        invItem: {
          type: "packedrow",
          fields: { itemID: 12, typeID: 24348, ownerID: owner, locationID: 11, flagID: 27 },
        },
        time: long("134385165369180001"),
        wallclockTime: long("134385165369179999"),
        attributes: { type: "dict", entries: [[54, 40000]] },
        activeEffects: {
          type: "dict",
          entries: [[16, effect(16, null)], ...(active ? [[650, effect(650, 13)]] : [])],
        },
      }),
    },
  });
  const config = {
    identity,
    qualification: q,
    now: () => t,
    heldCurrent: () => {},
    readOwn: async () => ({ module: (await read()).module, observedAt: t }),
    current: () => {
      if (!owns) throw Error("claim lost");
    },
    read,
    document: {
      read: () => saved,
      write: (v: any) => {
        if (failWrite) throw Error("disk failure");
        saved = structuredClone(v);
      },
    },
    lock: async () => {
      calls.push("lock");
      locked = true;
      if (lockError) throw Error("lock outcome unknown");
    },
    activate: async () => {
      calls.push("activate");
      if (activationWithoutEffect) throw Error("transport unknown");
      active = true;
      if (activationError) throw Error("activate outcome unknown");
    },
    deactivate: async () => {
      calls.push("deactivate");
      active = false;
      if (deactivationError) throw Error("deactivate outcome unknown");
    },
  };
  return {
    config,
    c: createTractorController(config),
    calls,
    step: () => {
      t++;
    },
    reactivate: () => {
      active = true;
    },
    move: (v: number) => {
      x = v;
    },
    lockError: () => {
      lockError = true;
    },
    activationError: () => {
      activationError = true;
    },
    activationWithoutEffect: () => {
      activationWithoutEffect = true;
    },
    deactivationError: () => {
      deactivationError = true;
    },
    lose: () => {
      owns = false;
    },
    foreign: () => {
      owner = 99;
    },
    failWrite: () => {
      failWrite = true;
    },
    snapshot: () => structuredClone(saved),
  };
}
test("native lock and exact active effect precede measured target movement, then one stop", async () => {
  const f = fixture();
  await f.c.advance();
  assert.deepEqual(f.calls, ["lock"]);
  f.step();
  await f.c.advance();
  assert.deepEqual(f.calls, ["lock", "activate"]);
  assert.equal(f.c.snapshot().active, null);
  assert.equal(f.c.snapshot().movement, null);
  f.step();
  await f.c.reconcile();
  assert.ok(f.c.snapshot().active);
  assert.equal(f.c.snapshot().movement, null);
  f.step();
  f.move(2900);
  await f.c.reconcile();
  assert.equal(f.c.snapshot().movement?.surfaceDistance, 2898);
  await f.c.stop();
  assert.deepEqual(f.calls, ["lock", "activate", "deactivate"]);
  f.step();
  await f.c.stop();
  assert.ok(f.c.snapshot().inactive);
  assert.deepEqual(f.calls, ["lock", "activate", "deactivate"]);
});
test("unknown lock and activation outcomes reconcile only through native reads without replay", async () => {
  const f = fixture();
  f.lockError();
  await f.c.advance();
  assert.match(f.c.snapshot().lock!.error!, /unknown/);
  f.step();
  f.activationError();
  await f.c.advance();
  assert.match(f.c.snapshot().activation!.error!, /unknown/);
  f.step();
  await f.c.advance();
  assert.ok(f.c.snapshot().active);
  assert.deepEqual(f.calls, ["lock", "activate"]);
});
test("unknown deactivation never retries; fresh native inactive proves shutdown", async () => {
  const f = fixture();
  await f.c.advance();
  f.step();
  await f.c.advance();
  f.step();
  await f.c.reconcile();
  f.deactivationError();
  await f.c.stop();
  assert.match(f.c.snapshot().deactivation!.error!, /unknown/);
  f.step();
  await f.c.stop();
  assert.ok(f.c.snapshot().inactive);
  assert.equal(f.calls.filter((x) => x === "deactivate").length, 1);
});
test("foreign item, lost claim and failed durable intent cause no command", async () => {
  for (const kind of ["foreign", "lose", "failWrite"] as const) {
    const f = fixture();
    f[kind]();
    await assert.rejects(f.c.advance());
    assert.deepEqual(f.calls, []);
  }
});
test("retained state cannot be adopted by another target or effect", async () => {
  const f = fixture();
  await f.c.advance();
  assert.throws(
    () => createTractorController({ ...f.config, identity: { ...identity, canID: 99 } }),
    /another or unreadable/,
  );
  assert.throws(
    () => createTractorController({ ...f.config, qualification: { ...q, effectID: 651 } }),
    /another or unreadable/,
  );
});

test("inactive observation cannot retire an unknown activation which has never shown an effect", async () => {
  const f = fixture();
  await f.c.advance();
  f.step();
  f.activationWithoutEffect();
  await f.c.advance();
  f.step();
  await assert.rejects(f.c.stop(), /outcome remains unknown/);
  assert.equal(f.c.snapshot().inactive, null);
  assert.deepEqual(f.calls, ["lock", "activate"]);
});

test("a stop fence before productive dispatch prevents a lock while preserving safe shutdown", async () => {
  const f = fixture();
  const c = createTractorController({
    ...f.config,
    beforeAction: () => {
      throw Error("stopping");
    },
  });
  await assert.rejects(c.advance(), /stopping/);
  assert.deepEqual(f.calls, []);
  assert.ok((await c.stop()).inactive);
});

test("repeat stop refreshes native inactivity and invalidates stale proof if effect reappears without replay", async () => {
  const f = fixture();
  await f.c.advance();
  f.step();
  await f.c.advance();
  f.step();
  await f.c.reconcile();
  await f.c.stop();
  f.step();
  await f.c.stop();
  const first = f.c.snapshot().inactive!.at;
  f.step();
  await f.c.stop();
  assert.ok(f.c.snapshot().inactive!.at > first);
  assert.equal(f.c.snapshot().inactiveHistory?.length, 1);
  f.step();
  f.reactivate();
  await f.c.stop();
  assert.equal(f.c.snapshot().inactive, null);
  assert.equal(f.calls.filter((x) => x === "deactivate").length, 1);
});

test("stop between persisted intent and native dispatch records negative and clears only that intent", async () => {
  const f = fixture();
  let gates = 0;
  const c = createTractorController({
    ...f.config,
    beforeAction: () => {
      if (++gates === 2) throw Error("stopping");
    },
  });
  await assert.rejects(c.advance(), /stopping/);
  assert.deepEqual(f.calls, []);
  assert.equal(c.snapshot().lock, null);
  assert.equal(c.snapshot().notDispatched?.[0]?.outcome, "PRE_DISPATCH_REFUSED");
});

test("lease loss permits only own-module shutdown and fresh inactive proof", async () => {
  const f = fixture();
  await f.c.advance();
  f.step();
  await f.c.advance();
  f.step();
  await f.c.reconcile();
  f.lose();
  await assert.rejects(f.c.advance(), /claim lost/);
  f.step();
  await f.c.stopOwn();
  assert.deepEqual(f.calls, ["lock", "activate", "deactivate"]);
  assert.ok(f.c.snapshot().ownInactive);
  f.step();
  f.reactivate();
  await f.c.stopOwn();
  assert.equal(f.c.snapshot().ownInactive, undefined);
  assert.equal(f.calls.filter((x) => x === "deactivate").length, 1);
});
