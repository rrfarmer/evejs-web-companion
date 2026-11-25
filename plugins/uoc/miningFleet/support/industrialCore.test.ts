import test from "node:test";
import assert from "node:assert/strict";
import { createIndustrialCore } from "./industrialCore.ts";
import type { IndustrialCoreRead } from "./industrialObservation.ts";
const identity = {
  operationID: "op",
  runID: "run",
  botID: "bot",
  sessionGeneration: 2,
  characterID: 1,
  shipID: 11,
  moduleID: 55,
  typeID: 66,
};
function fixture() {
  let state: any = null,
    at = 1000,
    active = false,
    qty = 200,
    fuelUnknown = false,
    activationFail: unknown = null,
    shutdownFail: unknown = null,
    writesFail = false,
    activations = 0,
    shutdowns = 0;
  const doc = {
      read: () => structuredClone(state),
      write: (x: unknown) => {
        if (writesFail) throw Error("disk failed");
        state = structuredClone(x);
      },
    },
    scope = {
      operationID: "op",
      runID: "run",
      sessionGeneration: 2,
      characterID: 1,
      shipID: 11,
      moduleID: 55,
      typeID: 66,
    };
  const row = (n: number) => ({
    itemID: 700,
    typeID: 16272,
    ownerID: 1,
    locationID: 11,
    flagID: 133,
    quantity: n,
    categoryID: 4,
  });
  const observe = async (): Promise<IndustrialCoreRead> => ({
    availability: "available",
    scope,
    core: {
      flagID: 27,
      effectID: 4575,
      effectName: "industrialCoreEffect2",
      online: true,
      active,
      effect: active
        ? {
            effectID: 4575,
            targetID: null,
            startFiletime: "134385165369130001",
            durationMs: 60000,
            repeat: 1,
          }
        : null,
      effectiveCycleMs: 60000,
      timeFiletime: active ? "134385165369180001" : "134385165369120001",
      wallclockFiletime: "134385165369179999",
    },
    fuel: fuelUnknown
      ? { availability: "unknown", reason: "failed" }
      : {
          availability: "available",
          source: "client-effective-dogma",
          typeID: 16272,
          requiredQuantity: 80,
          availableQuantity: qty,
          sufficient: qty >= 80,
          eligibleFlags: [133, 5],
          stacks: qty ? [row(qty)] : [],
        },
    deactivation: "unknown",
    startedAt: at,
    effectObservedAt: at,
    completedAt: at,
  });
  const create = (overrides: Record<string, unknown> = {}) =>
    createIndustrialCore({
      identity,
      document: doc,
      current() {},
      observe,
      activate: async () => {
        activations++;
        assert.equal(state.current.activation.acknowledged, false);
        if (activationFail) throw activationFail;
      },
      deactivate: async () => {
        shutdowns++;
        assert.equal((state.current?.shutdown ?? state.standaloneShutdown).acknowledged, false);
        if (shutdownFail) throw shutdownFail;
      },
      now: () => at,
      ...overrides,
    });
  return {
    create,
    observe,
    doc,
    get state() {
      return state;
    },
    set state(v) {
      state = v;
    },
    set active(v: boolean) {
      active = v;
    },
    set qty(v: number) {
      qty = v;
    },
    set fuelUnknown(v: boolean) {
      fuelUnknown = v;
    },
    set activationFail(v: unknown) {
      activationFail = v;
    },
    set shutdownFail(v: unknown) {
      shutdownFail = v;
    },
    set writesFail(v: boolean) {
      writesFail = v;
    },
    tick() {
      at += 1;
    },
    get activations() {
      return activations;
    },
    get shutdowns() {
      return shutdowns;
    },
  };
}
test("effect and exact fuel debit reconcile separately; long active shutdown waits for physical absence", async () => {
  const x = fixture(),
    c = x.create();
  await c.activate();
  assert.equal(x.activations, 1);
  assert.equal(c.snapshot().current?.activation.effect, null);
  x.tick();
  x.active = true;
  x.fuelUnknown = true;
  await c.reconcile();
  assert.ok(c.snapshot().current?.activation.effect);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
  await c.settle();
  assert.equal(x.shutdowns, 1);
  await c.reconcile();
  assert.equal(c.snapshot().current?.shutdown?.inactive, null);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
  x.tick();
  x.active = false;
  await c.reconcile();
  assert.ok(c.snapshot().current?.shutdown?.inactive);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
  await assert.rejects(c.activate(), /unresolved/);
  x.fuelUnknown = false;
  x.qty = 120;
  x.tick();
  await c.reconcile();
  assert.equal(c.snapshot().current?.fuel.status, "VERIFIED");
  await c.activate();
  assert.equal(x.activations, 2);
  assert.equal(c.snapshot().history.length, 1);
  assert.equal(c.snapshot().history[0]?.fuel.status, "VERIFIED");
});
test("unknown native activation is never replayed, including after controller reload; active core can stop", async () => {
  const x = fixture();
  x.activationFail = Error("timeout");
  const c = x.create();
  await c.activate();
  assert.equal(c.snapshot().current?.activation.acknowledged, false);
  assert.equal(c.snapshot().current?.activation.unknownError, "timeout");
  await assert.rejects(c.activate(), /unresolved/);
  const reloaded = x.create();
  await assert.rejects(reloaded.activate(), /unresolved/);
  x.active = true;
  x.tick();
  await reloaded.settle();
  assert.equal(x.activations, 1);
  assert.equal(x.shutdowns, 1);
  assert.ok(reloaded.snapshot().current?.activation.effect);
  assert.equal(reloaded.snapshot().current?.fuel.status, "PENDING");
  await reloaded.settle();
  assert.equal(x.shutdowns, 1);
});
test("explicit structured refusal is retained separately; generic failure remains unknown", async () => {
  const x = fixture();
  x.activationFail = Error("native no fuel");
  const c = x.create({ classifyRefusal: () => ({ code: "NO_FUEL", status: 409 }) });
  await c.activate();
  assert.equal(c.snapshot().current?.activation.refusal?.evidence.code, "NO_FUEL");
  assert.equal(c.snapshot().current?.fuel.status, "NOT_CONSUMED_REFUSAL");
  assert.equal(c.snapshot().current?.activation.effect, null);
});
test("failed durable write does not dispatch; native ACK alone never proves effect or debit", async () => {
  const x = fixture(),
    c = x.create();
  x.writesFail = true;
  await assert.rejects(c.activate(), /disk/);
  assert.equal(x.activations, 0);
  x.writesFail = false;
  await c.activate();
  assert.equal(c.snapshot().current?.activation.acknowledged, true);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
  assert.equal(c.snapshot().current?.activation.effect, null);
});
test("foreign generation and fuel changes cannot settle exact custody", async () => {
  const x = fixture(),
    c = x.create();
  await c.activate();
  x.active = true;
  x.qty = 119;
  x.tick();
  await c.reconcile();
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
  const foreign = x.create({
    observe: async () => {
      const o = await x.observe();
      if (o.availability === "available") o.scope.sessionGeneration = 99;
      return o;
    },
  });
  await foreign.reconcile();
  assert.equal(foreign.snapshot().current?.fuel.status, "PENDING");
  assert.throws(
    () => x.create({ identity: { ...identity, sessionGeneration: 3 } }),
    /journal scope/,
  );
});

test("corrupted saved refusal or fuel cannot authorize a new activation", async () => {
  const x = fixture(),
    c = x.create();
  await c.activate();
  const damaged = structuredClone(x.state);
  damaged.current.activation.refusal = { error: "fake", evidence: { code: "NO_FUEL" } };
  x.state = damaged;
  assert.throws(() => x.create(), /journal scope/);
  assert.equal(x.activations, 1);
});

test("shutdown timeout remains pending and is not resent after reload", async () => {
  const x = fixture(),
    c = x.create();
  await c.activate();
  x.active = true;
  x.tick();
  x.shutdownFail = Error("timeout");
  await c.settle();
  assert.equal(c.snapshot().current?.shutdown?.acknowledged, false);
  await x.create().settle();
  assert.equal(x.shutdowns, 1);
  x.active = false;
  x.tick();
  await c.reconcile();
  assert.ok(c.snapshot().current?.shutdown?.inactive);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
});
test("fuel proof rejects changed type, eligible flags, added stack or source location", async () => {
  for (const mutate of [
    (f: any) => {
      f.typeID = 16273;
    },
    (f: any) => {
      f.eligibleFlags = [5, 133];
    },
    (f: any) => {
      f.stacks[0].itemID = 701;
    },
    (f: any) => {
      f.stacks[0].locationID = 12;
    },
  ]) {
    const x = fixture(),
      c = x.create();
    await c.activate();
    x.active = true;
    x.qty = 120;
    x.tick();
    const other = x.create({
      observe: async () => {
        const o = await x.observe();
        if (o.availability === "available" && o.fuel.availability === "available") mutate(o.fuel);
        return o;
      },
    });
    await other.reconcile();
    assert.equal(other.snapshot().current?.fuel.status, "PENDING");
  }
});

test("concurrent activation coalesces; Stop waits behind the in-flight activation read", async () => {
  const x = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  let first = true,
    dispatches = 0;
  const c = x.create({
    observe: async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return x.observe();
    },
    activate: async () => {
      dispatches++;
      x.active = true;
    },
  });
  const a = c.activate(),
    b = c.activate(),
    stop = c.settle();
  await ready;
  release();
  await Promise.all([a, b, stop]);
  assert.equal(c.snapshot().nextOrdinal, 2);
  assert.equal(dispatches, 1);
  assert.equal(x.shutdowns, 1);
  assert.equal(c.snapshot().current?.shutdown?.kind, "dispatch");
});
test("first inactive observation is read-only and is cleared durably by next activation", async () => {
  const x = fixture(),
    c = x.create();
  await c.settle();
  assert.ok(c.snapshot().lastInactive);
  assert.equal(c.snapshot().current, null);
  assert.equal(x.shutdowns, 0);
  await c.activate();
  assert.equal(c.snapshot().lastInactive, null);
  assert.equal(x.activations, 1);
});
test("standalone active Core permits one shutdown without inventing activation or fuel", async () => {
  const x = fixture();
  x.active = true;
  const c = x.create();
  await Promise.all([c.settle(), c.settle()]);
  assert.equal(x.shutdowns, 1);
  assert.equal(c.snapshot().current, null);
  assert.equal(c.snapshot().standaloneShutdown?.kind, "dispatch");
  assert.equal(c.snapshot().standaloneShutdown?.inactive, null);
  x.tick();
  x.active = false;
  await c.reconcile();
  assert.ok(c.snapshot().standaloneShutdown?.inactive);
  assert.ok(c.snapshot().lastInactive);
  await c.activate();
  assert.equal(c.snapshot().lastInactive, null);
  assert.equal(c.snapshot().standaloneHistory.length, 1);
  assert.equal(c.snapshot().standaloneShutdown, null);
});
test("automatic or refused inactive Core gives native proof without synthetic shutdown ACK", async () => {
  for (const refused of [false, true]) {
    const x = fixture();
    if (refused) x.activationFail = Error("native refusal");
    const c = x.create(refused ? { classifyRefusal: () => ({ code: "NO_FUEL" }) } : {});
    await c.activate();
    x.tick();
    await c.settle();
    const current = c.snapshot().current!;
    assert.equal(current.shutdown?.kind, "observed-inactive");
    assert.equal(current.shutdown?.acknowledged, false);
    assert.equal(x.shutdowns, 0);
    assert.equal(current.fuel.status, refused ? "NOT_CONSUMED_REFUSAL" : "PENDING");
    if (!refused) await assert.rejects(c.activate(), /unresolved/);
  }
});
test("equal native FILETIME tick still accepts exact inactive-before then active-after", async () => {
  const x = fixture(),
    c = x.create({
      observe: async () => {
        const o = await x.observe();
        if (o.availability === "available" && o.core.active && o.core.effect)
          o.core.effect.startFiletime = "134385165369120001";
        return o;
      },
    });
  await c.activate();
  x.active = true;
  x.tick();
  await c.reconcile();
  assert.ok(c.snapshot().current?.activation.effect);
});

test("concurrent activation write failure emits no activation or shutdown", async () => {
  const x = fixture(),
    c = x.create();
  x.writesFail = true;
  const [a, b] = await Promise.allSettled([c.activate(), c.activate()]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "rejected");
  assert.equal(x.activations, 0);
  assert.equal(x.shutdowns, 0);
});

test("repeated Stop reconciles native inactivity, stores latest proof and never repeats Deactivate", async () => {
  const x = fixture(),
    c = x.create();
  await c.activate();
  x.active = true;
  x.tick();
  await c.settle();
  assert.equal(x.shutdowns, 1);
  assert.equal(c.snapshot().current?.shutdown?.inactive, null);
  assert.equal(c.snapshot().lastInactive, null);
  await c.settle();
  assert.equal(x.shutdowns, 1);
  assert.equal(c.snapshot().lastInactive, null);
  x.active = false;
  x.tick();
  await c.settle();
  assert.equal(x.shutdowns, 1);
  assert.ok(c.snapshot().current?.shutdown?.inactive);
  assert.ok(c.snapshot().lastInactive);
  assert.equal(c.snapshot().current?.fuel.status, "PENDING");
});
