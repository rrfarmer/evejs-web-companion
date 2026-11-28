import test from "node:test";
import assert from "node:assert/strict";
import { createBurstController, confirmedRecipients, type BurstObservation } from "./controller.ts";
function fixture() {
  let time = 1000,
    state: unknown = null,
    active = false,
    charge = 4,
    activateCalls = 0,
    deactivateCalls = 0,
    lose = false,
    inFleet = true,
    distance = 10,
    writeFail = false;
  const identity = {
    operationID: "op",
    runID: "run",
    characterID: 1,
    shipID: 11,
    moduleID: 55,
    typeID: 66,
  };
  const document = {
    read: () => state,
    write: (x: unknown) => {
      if (writeFail) throw Error("write failed");
      state = structuredClone(x);
    },
  };
  const observation = (): BurstObservation => ({
    characterID: 1,
    shipID: 11,
    moduleID: 55,
    typeID: 66,
    flagID: 27,
    effectID: 99,
    chargeTypeID: 300,
    chargeItemID: 301,
    chargeQuantity: charge,
    cycleMs: 60000,
    rangeMeters: 1000,
    online: true,
    active,
    observedAt: time,
    recipients: [
      {
        characterID: 2,
        shipID: 12,
        inFleet,
        distanceMeters: distance,
        buffs: active ? [{ collectionID: 5, value: 2, expiresMs: time + 10000 }] : [],
      },
    ],
    effectCollections: active ? [5] : [],
  });
  const make = () =>
    createBurstController({
      identity,
      document,
      current() {},
      now: () => time,
      observe: async () => observation(),
      observeOwn: async () => observation(),
      activate: async () => {
        activateCalls++;
        active = true;
        charge--;
        time++;
        if (lose) throw Error("lost response");
      },
      deactivate: async () => {
        deactivateCalls++;
        active = false;
        time++;
        if (lose) throw Error("lost response");
      },
    });
  return {
    make,
    observation,
    setLose: (v: boolean) => {
      lose = v;
    },
    setActive: (v: boolean) => {
      active = v;
    },
    setFleet: (v: boolean) => {
      inFleet = v;
    },
    setDistance: (v: number) => {
      distance = v;
    },
    setWriteFail: (v: boolean) => {
      writeFail = v;
    },
    activationCalls: () => activateCalls,
    deactivationCalls: () => deactivateCalls,
  };
}
test("actual effect settles the durable activation once; recipient notification is separate evidence", async () => {
  const x = fixture(),
    c = x.make(),
    before = x.observation(),
    r = await c.activate();
  assert.equal(x.activationCalls(), 1);
  assert.equal(r?.after.active, true);
  assert.equal(c.snapshot().pending, null);
  assert.deepEqual(confirmedRecipients(before, x.observation()), [{ characterID: 2, shipID: 12 }]);
  assert.equal((await c.settle())?.after.active, false);
  assert.equal(x.deactivationCalls(), 1);
});
test("lost activation acknowledgement is reconciled from native active effect without replay", async () => {
  const x = fixture(),
    c = x.make();
  x.setLose(true);
  await assert.rejects(c.activate(), /lost response/);
  assert.equal(c.snapshot().pending?.acknowledged, false);
  x.setLose(false);
  const result = await x.make().activate();
  assert.equal(result?.intent?.acknowledged, false);
  assert.equal(x.activationCalls(), 1);
});
test("unknown inactive activation remains fenced and failed persistence dispatches nothing", async () => {
  const x = fixture(),
    c = x.make();
  x.setLose(true);
  await assert.rejects(c.activate());
  x.setActive(false);
  await assert.rejects(x.make().activate(), /unknown/);
  assert.equal(x.activationCalls(), 1);
  const y = fixture();
  y.setWriteFail(true);
  await assert.rejects(y.make().activate(), /write failed/);
  assert.equal(y.activationCalls(), 0);
});
test("foreign fleet and out-of-range recipients never authorize activation", async () => {
  for (const bad of [
    (x: ReturnType<typeof fixture>) => x.setFleet(false),
    (x: ReturnType<typeof fixture>) => x.setDistance(1001),
  ]) {
    const x = fixture();
    bad(x);
    await assert.rejects(x.make().activate(), /fleet, range/);
    assert.equal(x.activationCalls(), 0);
  }
});
test("lost deactivation is not replayed and can settle only from observed inactive effect", async () => {
  const x = fixture(),
    c = x.make();
  await c.activate();
  x.setLose(true);
  await assert.rejects(c.settle(), /lost response/);
  x.setLose(false);
  assert.equal((await x.make().settle())?.after.active, false);
  assert.equal(x.deactivationCalls(), 1);
});
test("preexisting same recipient buff is not a new notification", () => {
  const x = fixture();
  x.setActive(true);
  const a = x.observation(),
    b = x.observation();
  assert.deepEqual(confirmedRecipients(a, b), []);
});

test("Stop archives an unknown activation once current own effect is inactive", async () => {
  const x = fixture(),
    c = x.make();
  x.setLose(true);
  await assert.rejects(c.activate(), /lost response/);
  x.setActive(false);
  const proof = await x.make().settle();
  assert.equal(proof && "resolution" in proof ? proof.resolution : undefined, "INACTIVE_ON_STOP");
  const stored = x.make().snapshot();
  assert.equal(stored.pending, null);
  assert.equal(stored.history[0]?.intent.acknowledged, false);
  assert.equal(stored.history[0]?.after.active, false);
  assert.equal(x.activationCalls(), 1);
  assert.equal(x.deactivationCalls(), 0);
});
