import test from "node:test";
import assert from "node:assert/strict";
import { inspectSupplies, decodeSupplyTargets } from "./supplyInspect.ts";
test("optional supplies use fresh own bay counts and never turn shortage into refusal", async () => {
  const calls: string[] = [],
    session: any = {
      flow: {
        requestOptions: () => ({}),
        flying: {
          bridgeDo: async (s: string, m: string) => {
            calls.push(`${s}.${m}`);
          },
          bridgeAsk: async (_s: string, _m: string, _a: any, k: any) => ({
            type: "list",
            items:
              k.flag === 133
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: 9,
                        typeID: 16272,
                        ownerID: 1,
                        locationID: 11,
                        flagID: 133,
                        quantity: 20,
                      },
                    },
                  ]
                : [],
          }),
        },
      },
    },
    run: any = {
      characterID: 1,
      baseUrl: "http://bff",
      fetch: async () =>
        Response.json({
          ok: true,
          flight: { shipID: 11, docked: true, inSpace: false, stationID: 600, solarSystemID: 300 },
        }),
    },
    targets = decodeSupplyTargets([
      { typeID: 16272, target: 100, mode: "CARRIED_SPARES", eligibleFlags: [133], required: true },
    ])!;
  const result = await inspectSupplies(run, session, 11, targets, () => {});
  assert.equal(result[0]?.state, "DEGRADED");
  assert.equal(result[0]?.quantity, 20);
  assert.match(result[0]?.reason ?? "", /departure remains available/);
  assert.deepEqual(calls, ["invCache.InvalidateLocationCache"]);
});
test("unreadable native inventory remains UNKNOWN and invalid policies are rejected", async () => {
  const session: any = {
      flow: {
        requestOptions: () => ({}),
        flying: { bridgeDo: async () => {}, bridgeAsk: async () => null },
      },
    },
    run: any = {
      characterID: 1,
      baseUrl: "http://bff",
      fetch: async () =>
        Response.json({
          ok: true,
          flight: { shipID: 11, docked: true, inSpace: false, stationID: 600, solarSystemID: 300 },
        }),
    },
    targets = decodeSupplyTargets([
      { typeID: 1, target: 10, mode: "CARRIED_SPARES", eligibleFlags: [5], required: false },
    ])!;
  assert.equal((await inspectSupplies(run, session, 11, targets, () => {}))[0]?.state, "UNKNOWN");
  assert.equal(
    decodeSupplyTargets([
      { typeID: 1, target: 10, mode: "CARRIED_SPARES", eligibleFlags: [999], required: false },
    ]),
    null,
  );
});
