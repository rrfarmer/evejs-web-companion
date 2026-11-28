import test from "node:test";
import assert from "node:assert/strict";
import { createCompressionController } from "./compressionController.ts";
import type { CompressionFacilityProof } from "./compressionFacility.ts";
function fixture(beforeDispatch?: () => void) {
  let state: unknown = null,
    writeFail = false,
    mode: "success" | "lost" | "unknown" = "success",
    calls = 0,
    facilityReads = 0,
    changeClaim = false;
  const row = {
    itemID: 20,
    typeID: 30,
    ownerID: 3,
    locationID: 13,
    flagID: 134,
    quantity: 10,
    categoryID: 25,
  };
  let held = [{ ...row }];
  const list = (rows: unknown[]) => ({
    type: "list",
    items: rows.map((fields) => ({ type: "packedrow", fields })),
  });
  const proof: CompressionFacilityProof = {
    operationID: "op",
    runID: "run",
    claimKey: "site",
    claimGeneration: 1,
    commanderCharacterID: 4,
    commanderShipID: 14,
    minerCharacterID: 3,
    minerShipID: 13,
    systemID: 300,
    observedAt: Date.now(),
    sceneSampledAt: Date.now(),
    facilityTypeListIDs: [5],
    matchingTypeListIDs: [5],
    rangeMeters: 5000,
    surfaceDistanceMeters: 500,
    sourceTypeID: 30,
    compressedTypeID: 31,
    coreModuleID: 80,
    compressorModuleID: 81,
    compressorEffectID: 82,
  };
  const fetcher: typeof fetch = async (input) => {
    const p = new URL(String(input)).pathname;
    let data: any;
    if (p === "/api/bridge/flight/status")
      data = {
        flight: { shipID: 13, solarSystemID: 300, inSpace: true, docked: false, shipMode: "STOP" },
      };
    else if (p === "/api/mining-operations/resources")
      data = { resources: [{ typeID: 30, family: "ore", name: "raw" }] };
    else if (p === "/api/client-data/dogma-types")
      data = { available: true, types: { 30: { categoryID: 25 }, 31: { categoryID: 25 } } };
    else if (p === "/api/types/volumes") data = { volumes: { 30: 1, 31: 0.1 }, capped: false };
    else if (p === "/api/types/compressed") data = { compressedTypeIDs: { 30: 31 }, capped: false };
    else throw Error(p);
    return Response.json({ ok: true, ...data });
  };
  const session: any = {
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async (s: string, m: string, args: any[]) => {
          if (s === "invCache") return null;
          if (s === "inSpaceCompressionMgr" && m === "CompressItemInSpace") {
            calls++;
            assert.ok((state as any).pending);
            assert.deepEqual(args, [20, 14]);
            if (mode !== "unknown") held = [{ ...row, typeID: 31 }];
            if (mode !== "success") throw Error("lost response");
            return [20, 30, 10, 20, 31, 10];
          }
          throw Error("unexpected write");
        },
        bridgeAsk: async (_s: string, _m: string, _a: any, kw: any) =>
          list(held.filter((x) => x.flagID === kw.flag)),
      },
    },
  };
  const controller = () =>
    createCompressionController({
      operationID: "op",
      runID: "run",
      run: { characterID: 3, baseUrl: "http://bff", fetch: fetcher },
      session,
      shipID: 13,
      systemID: 300,
      beforeDispatch,
      current() {},
      document: {
        read: () => state,
        write(x) {
          if (writeFail) throw Error("disk failed");
          state = structuredClone(x);
        },
      },
      facility: async () => {
        facilityReads++;
        return { ...proof, claimGeneration: changeClaim && facilityReads > 1 ? 2 : 1 };
      },
    });
  return {
    controller,
    get calls() {
      return calls;
    },
    get state() {
      return state;
    },
    set state(x: unknown) {
      state = structuredClone(x);
    },
    set mode(x: typeof mode) {
      mode = x;
    },
    set writeFail(x: boolean) {
      writeFail = x;
    },
    set changeClaim(x: boolean) {
      changeClaim = x;
    },
    complete() {
      held = [{ ...row, typeID: 31 }];
    },
  };
}
test("native single-stack compression is fenced before call and proven by exact same-item physical replacement", async () => {
  const x = fixture(),
    c = x.controller(),
    receipt = await c.compress(20);
  assert.equal(x.calls, 1);
  assert.deepEqual(receipt?.output, { itemID: 20, typeID: 31, quantity: 10, flagID: 134 });
  assert.equal(receipt?.rawUnitVolumeM3, 1);
  assert.equal(receipt?.compressedUnitVolumeM3, 0.1);
  assert.equal(c.snapshot().pending, null);
});
test("unknown native outcome stays pending without replay and can reconcile by exact later physical replacement", async () => {
  const x = fixture();
  x.mode = "unknown";
  const c = x.controller();
  assert.equal(await c.compress(20), null);
  await assert.rejects(c.compress(20), /no replay/);
  assert.equal(x.calls, 1);
  x.complete();
  const r = await x.controller().reconcile();
  assert.equal(r?.acknowledged, false);
  assert.equal(r?.output.typeID, 31);
  assert.equal(x.calls, 1);
});
test("lost ACK resolves from physical replacement without a second mutation", async () => {
  const x = fixture();
  x.mode = "lost";
  const receipt = await x.controller().compress(20);
  assert.equal(receipt?.acknowledged, false);
  assert.equal(receipt?.output.typeID, 31);
  assert.equal(x.calls, 1);
});
test("failed persistence and changed claim prevent native mutation", async () => {
  for (const change of ["write", "claim"]) {
    const x = fixture();
    if (change === "write") x.writeFail = true;
    else x.changeClaim = true;
    await assert.rejects(x.controller().compress(20));
    assert.equal(x.calls, 0);
  }
});

test("malformed persisted compression custody is rejected before reconciliation", async () => {
  const x = fixture();
  x.mode = "unknown";
  await x.controller().compress(20);
  const bad = structuredClone(x.state) as any;
  bad.pending.facility.minerShipID = 99;
  x.state = bad;
  assert.throws(() => x.controller(), /journal requires reconciliation/);
  assert.equal(x.calls, 1);
});

test("stop at either dispatch fence prevents native compression and preserves any saved intent as not dispatched", async () => {
  for (const stopAt of [1, 2]) {
    let checks = 0;
    const x = fixture(() => {
      if (++checks === stopAt) throw Error("stop requested");
    });
    const c = x.controller();
    await assert.rejects(c.compress(20), /stop requested/);
    assert.equal(x.calls, 0);
    assert.equal(c.snapshot().pending, null);
    assert.equal(c.snapshot().notDispatched?.length ?? 0, stopAt === 2 ? 1 : 0);
    if (stopAt === 2)
      assert.equal(c.snapshot().notDispatched?.[0]?.outcome, "STOP_BEFORE_DISPATCH");
    assert.equal(await c.reconcile(), null);
  }
});
