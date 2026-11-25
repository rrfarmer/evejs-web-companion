import test from "node:test";
import assert from "node:assert/strict";
import { createCompressionFacilityObserver } from "./compressionFacility.ts";
function fixture() {
  const state = { active: true, changed: false, compressor: true, compatible: true };
  let reads = 0;
  const transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    },
    now = Date.now();
  const fetcher: typeof fetch = async (input) => {
    const u = new URL(String(input));
    let data: any;
    if (u.pathname === "/api/bridge/flight/status")
      data = {
        flight: {
          inSpace: true,
          docked: false,
          shipID: 14,
          solarSystemID: 300,
          shipMode: "STOP",
          transition,
        },
      };
    else if (u.pathname === "/api/bridge/space/snapshot") {
      reads++;
      data = {
        space: {
          stateValid: true,
          inSpace: true,
          shipID: 14,
          solarSystemID: 300,
          sampledAtMs: 1000,
          ship: {
            itemID: 14,
            characterID: 4,
            ownerID: 4,
            mode: "STOP",
            position: { x: 0, y: 0, z: 0 },
            radius: 10,
          },
          entities: state.active
            ? [
                {
                  itemID: 14,
                  characterID: 4,
                  kind: "ship",
                  isNpc: false,
                  position: { x: 0, y: 0, z: 0 },
                  radius: 10,
                  compressionFacility: {
                    rangeMeters: 5000,
                    typeListIDs: [state.changed && reads > 1 ? 6 : 5],
                  },
                },
              ]
            : [],
        },
      };
    } else if (u.pathname === "/api/mining/compression-compatibility")
      data = {
        compatibility: [
          {
            typeID: 30,
            availability: "available",
            compressedTypeID: 31,
            matchingTypeListIDs: state.compatible ? [5] : [],
          },
        ],
      };
    else if (u.pathname === "/api/client-data/dogma-types")
      data = {
        available: true,
        types: { 92: { categoryID: 7, effects: [82], attributes: [[3255, 5]] } },
        effects: { 82: { name: "industrialItemCompression" } },
      };
    else throw Error(u.pathname);
    return Response.json({ ok: true, ...data });
  };
  const h: any = {
    run: { characterID: 4, baseUrl: "http://local", fetch: fetcher },
    session: {
      flow: {
        requestOptions: () => ({}),
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
      store: { station: { get: () => ({ online: { characterID: 4 } }) } },
    },
    shipID: 14,
    current() {},
  };
  const observer = createCompressionFacilityObserver({
    operationID: "op",
    runID: "run",
    systemID: 300,
    commander: h,
    miner: h,
    claim: () => ({
      operationID: "op",
      runID: "run",
      key: "site",
      generation: 1,
      expiresAt: Date.now() + 30000,
    }),
    observeSupport: async () => ({
      core: {
        availability: "available",
        scope: {
          operationID: "op",
          runID: "run",
          characterID: 4,
          shipID: 14,
          moduleID: 80,
          typeID: 90,
          sessionGeneration: 1,
        },
        core: { online: true, effectID: 91, active: true, effect: { effectID: 91 } },
        effectObservedAt: now,
      } as any,
      compressor: {
        moduleID: 81,
        typeID: 92,
        ownerID: 4,
        shipID: 14,
        flagID: 27,
        online: true,
        timeFiletime: "134385165369180001",
        effects: state.compressor
          ? [{ effectID: 82, durationMs: 60000, startFiletime: "134385165369120001" }]
          : [],
      } as any,
      compressorEffectID: 82,
      observedAt: Date.now(),
    }),
  });
  return { observer, state };
}
test("own active exact Core and compressor qualify same-ship facility without fleet or movement", async () => {
  const f = fixture(),
    p = await f.observer(30);
  assert.equal(p.commanderShipID, 14);
  assert.equal(p.minerShipID, 14);
  assert.equal(p.surfaceDistanceMeters, 0);
  assert.deepEqual(p.matchingTypeListIDs, [5]);
  assert.equal(p.compressedTypeID, 31);
});
test("self facility inactive, changing or incompatible never authorizes compression", async () => {
  for (const k of ["active", "compressor", "compatible", "changed"] as const) {
    const f = fixture();
    if (k === "changed") f.state.changed = true;
    else f.state[k] = false;
    await assert.rejects(f.observer(30));
  }
});
