import test from "node:test";
import assert from "node:assert/strict";
import { inspectDefenderCapability } from "./defenderCapability.ts";
const dict = (x: Record<string, unknown>) => ({ type: "dict", entries: Object.entries(x) }),
  lng = { type: "long", value: "134385165369120001" };
function fixture(role = true, owner = 7) {
  const calls: string[] = [];
  const item = {
    type: "object",
    name: "util.KeyVal",
    args: dict({
      itemID: 11,
      invItem: { type: "packedrow", fields: { itemID: 11, typeID: 12, ownerID: 7 } },
      time: lng,
      wallclockTime: lng,
      attributes: {
        type: "dict",
        entries: [
          [49, 10],
          [48, 100],
          [15, 20],
          [11, 100],
        ],
      },
    }),
  };
  const run = {
    characterID: 7,
    held: { characterID: 7 },
    baseUrl: "http://bff",
    fetch: async () =>
      Response.json({
        ok: true,
        flight: {
          docked: true,
          inSpace: false,
          shipID: 11,
          shipTypeID: 12,
          solarSystemID: 13,
          stationID: 14,
        },
      }),
  } as any;
  const session = {
    store: { fitting: { get: () => ({}) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async (_s: string, m: string) => {
          calls.push(m);
        },
        bridgeAsk: async (_s: string, m: string) =>
          m === "ItemGetInfo"
            ? item
            : {
                type: "list",
                items: [
                  {
                    type: "packedrow",
                    fields: {
                      itemID: 21,
                      typeID: 22,
                      ownerID: owner,
                      locationID: 11,
                      flagID: 87,
                      quantity: 5,
                      stacksize: 5,
                      categoryID: 18,
                    },
                  },
                ],
              },
        classifyDroneRoles: async () => ({ bay: { combat: role ? [21] : [] }, out: null }),
        readFit: async () => true,
        resolveDroneControlRange: async () => 45000,
      },
    },
  } as any;
  return { run, session, calls };
}
test("qualifies only exact owned bay drones identified by the actual combat classifier", async () => {
  const f = fixture(),
    r = await inspectDefenderCapability(f.run, f.session, () => {});
  assert.equal(r.qualified, true);
  assert.deepEqual(
    (r.evidence as any).combatDrones.map((x: any) => x.itemID),
    [21],
  );
  assert.deepEqual(f.calls, ["InvalidateLocationCache"]);
});
test("noncombat drones and foreign inventory remain unavailable", async () => {
  for (const f of [fixture(false), fixture(true, 99)]) {
    const r = await inspectDefenderCapability(f.run, f.session, () => {});
    assert.equal(r.qualified, false);
    assert.ok(r.reason);
  }
});
test("retired owner is not converted into a normal qualification result", async () => {
  const f = fixture();
  await assert.rejects(
    inspectDefenderCapability(f.run, f.session, () => {
      throw Error("owner retired");
    }),
    /owner retired/,
  );
});
test("weapon-only readiness requires the host execution capability and exact online native range", async () => {
  const f = fixture(false),
    old = f.session.flow.flying.bridgeAsk;
  f.session.store.fitting.get = () => ({
    activeShipID: 11,
    slotsError: null,
    slots: [
      { family: "high", index: 0, module: { itemID: 31, typeID: 32, online: true, charge: null } },
    ],
  });
  f.session.flow.flying.resolveDefenseModuleIDs = () => ({
    weapons: [31],
    shield: [],
    armor: [],
    hull: [],
    hardeners: [],
  });
  f.session.flow.flying.resolveRemoteRepModuleIDs = () => ({
    shield: [],
    armor: [],
    hull: [],
    cap: [],
  });
  f.session.flow.flying.fittedModuleActivation = () => "activatable";
  f.session.flow.flying.bridgeAsk = async (s: string, m: string, args: any[]) =>
    m === "ItemGetInfo" && args?.[0] === 31
      ? {
          type: "object",
          name: "util.KeyVal",
          args: dict({
            itemID: 31,
            invItem: {
              type: "packedrow",
              fields: { itemID: 31, typeID: 32, ownerID: 7, locationID: 11, flagID: 27 },
            },
            time: lng,
            wallclockTime: lng,
            activeEffects: {
              type: "dict",
              entries: [[16, [31, 7, 11, null, null, [], 16, lng, -1, 1]]],
            },
            attributes: {
              type: "dict",
              entries: [
                [54, 1000],
                [158, 500],
                [160, 1],
              ],
            },
          }),
        }
      : old(s, m, args);
  assert.equal((await inspectDefenderCapability(f.run, f.session, () => {})).qualified, false);
  const r = await inspectDefenderCapability(f.run, f.session, () => {}, {
    weaponExecutionEnabled: true,
  });
  assert.equal(r.qualified, true);
  assert.equal((r.evidence as any).weapon.range, 1500);
});
