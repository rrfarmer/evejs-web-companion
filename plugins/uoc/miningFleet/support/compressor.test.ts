import test from "node:test";
import assert from "node:assert/strict";
import {
  createCompressorController,
  CompressorNotDispatched,
  type CompressorIdentity,
} from "./compressor.ts";
const identity: CompressorIdentity = {
  operationID: "op",
  runID: "run",
  botID: "bot",
  sessionGeneration: 1,
  characterID: 4,
  shipID: 14,
  moduleID: 30,
  typeID: 62622,
  effectID: 8364,
};
function fixture() {
  let saved: any = null,
    active = false,
    core = true,
    clock = 1000,
    starts = 0,
    stops = 0,
    lostStart = false,
    lostStop = false,
    writeFail = false;
  const observe = async () => ({
    identity,
    module: {
      moduleID: 30,
      typeID: 62622,
      ownerID: 4,
      shipID: 14,
      flagID: 28,
      online: true,
      timeFiletime: "100",
      wallclockFiletime: "100",
      effects: active
        ? [{ effectID: 8364, startFiletime: "100", durationMs: 60000, targetID: null, repeat: 0 }]
        : [],
      activeTargets: [],
      attributes: null,
    },
    observedAt: clock,
  });
  const make = () =>
    createCompressorController({
      identity,
      document: {
        read: () => saved,
        write: (v) => {
          if (writeFail) throw Error("disk failed");
          saved = structuredClone(v);
        },
      },
      current() {},
      observe,
      coreReady: async () => core,
      activate: async () => {
        starts++;
        assert.ok(saved.current.activation);
        if (lostStart) throw Error("lost activation");
      },
      deactivate: async () => {
        stops++;
        assert.ok(saved.current.shutdown);
        if (lostStop) throw Error("lost shutdown");
      },
      now: () => clock,
    });
  return {
    make,
    observe,
    get saved() {
      return saved;
    },
    set saved(x) {
      saved = structuredClone(x);
    },
    set active(v: boolean) {
      active = v;
    },
    set core(v: boolean) {
      core = v;
    },
    set lostStart(v: boolean) {
      lostStart = v;
    },
    set lostStop(v: boolean) {
      lostStop = v;
    },
    set writeFail(v: boolean) {
      writeFail = v;
    },
    tick() {
      clock++;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
  };
}
test("compressor requires observed Core and persists before native activation", async () => {
  const x = fixture(),
    c = x.make();
  x.core = false;
  await assert.rejects(c.activate(), /Core/);
  assert.equal(x.starts, 0);
  x.core = true;
  x.writeFail = true;
  await assert.rejects(c.activate(), /disk/);
  assert.equal(x.starts, 0);
  x.writeFail = false;
  await c.activate();
  assert.equal(x.starts, 1);
});
test("unknown activation never replays or grants shutdown until actual effect appears", async () => {
  const x = fixture(),
    c = x.make();
  x.lostStart = true;
  await c.activate();
  await assert.rejects(c.activate(), /unresolved/);
  await assert.rejects(c.settle(), /unresolved/);
  assert.equal(x.starts, 1);
  assert.equal(x.stops, 0);
  x.active = true;
  x.tick();
  await c.settle();
  assert.equal(x.stops, 1);
});
test("lost shutdown is sent once; physical active effect retains custody until absent", async () => {
  const x = fixture(),
    c = x.make();
  await c.activate();
  x.active = true;
  x.tick();
  x.lostStop = true;
  await c.settle();
  await c.settle();
  assert.equal(x.stops, 1);
  assert.equal(c.snapshot().lastInactive, null);
  x.active = false;
  x.tick();
  await c.reconcile();
  assert.ok(c.snapshot().lastInactive);
  assert.equal(x.stops, 1);
});
test("standalone native active compressor is settled once and cannot fake inactive", async () => {
  const x = fixture(),
    c = x.make();
  x.active = true;
  await c.settle();
  await c.settle();
  assert.equal(x.stops, 1);
  assert.equal(c.snapshot().lastInactive, null);
  x.active = false;
  x.tick();
  await c.reconcile();
  assert.ok(c.snapshot().lastInactive);
});
test("corrupt or unrelated saved identity and malformed cycle refuse use", async () => {
  const x = fixture(),
    c = x.make();
  await c.activate();
  const bad = structuredClone(x.saved);
  bad.current.activation.before.module.ownerID = 99;
  x.saved = bad;
  assert.throws(() => x.make(), /journal/);
});
test("a definite local pre-dispatch Stop is durably negative and settles without a shutdown write", async () => {
  let saved: any = null,
    writes = 0;
  const module = {
    moduleID: 30,
    typeID: 62622,
    ownerID: 4,
    shipID: 14,
    flagID: 28,
    online: true,
    timeFiletime: "100",
    wallclockFiletime: "100",
    effects: [],
    activeTargets: [],
    attributes: null,
  };
  const c = createCompressorController({
    identity,
    document: {
      read: () => saved,
      write: (v) => {
        saved = structuredClone(v);
      },
    },
    current() {},
    observe: async () => ({ identity, module, observedAt: 1000 }),
    coreReady: async () => true,
    activate: async () => {
      throw new CompressorNotDispatched("stop before native call");
    },
    deactivate: async () => {
      writes++;
    },
    now: () => 1000,
  });
  await c.activate();
  assert.equal(c.snapshot().current?.activation?.notDispatched, true);
  await c.settle();
  assert.ok(c.snapshot().lastInactive);
  assert.equal(writes, 0);
});
