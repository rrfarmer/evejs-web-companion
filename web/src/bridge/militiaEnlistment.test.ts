import assert from "node:assert/strict";
import test from "node:test";
import { afterMilitiaEnlistment, militiaAffiliation, militiaCooldown, militiaEnlistmentWarning, militiaStationFactions, relevantMilitiaPage, type MilitiaEligibility } from "./militiaEnlistment.ts";
import type { JsonValue } from "./wire.ts";

test("24.02 routes confirmed pirate enlistment to Insurgencies and an unregistered Conquest Overview to Overview", () => {
  assert.deepEqual(militiaAffiliation([500011, null, 500011]), { factionID: 500011, directFactionID: null, corpFactionID: 500011 });
  assert.deepEqual(militiaAffiliation([500001, 500001, null]), { factionID: 500001, directFactionID: 500001, corpFactionID: null });
  assert.equal(afterMilitiaEnlistment(null, 500001), "overview");
  assert.equal(afterMilitiaEnlistment(null, 500010), "insurgencies");
  assert.equal(afterMilitiaEnlistment(null, null), null);
  assert.equal(afterMilitiaEnlistment(500001, 500001), null);
  assert.equal(relevantMilitiaPage(null), "enlistment");
  assert.equal(relevantMilitiaPage(500004), "warfare");
  assert.equal(relevantMilitiaPage(500011), "insurgencies");
});

test("enlistment gates the exact station, direct corporation permissions and raw standing", () => {
  assert.deepEqual(militiaStationFactions(null, 30000142, 500001), []);
  assert.deepEqual(militiaStationFactions(60003760, 30000142, 500001), [500001]);
  assert.deepEqual(militiaStationFactions(60015187, 30100000, null), [500011, 500010]);
  const read: MilitiaEligibility = {
    characterID: 140000001, corporationID: 1000171, factionID: null, directFactionID: null, corpFactionID: null,
    stationFactions: [500001], allowedFactions: null, standings: new Map(), cooldown: false,
  };
  assert.equal(militiaEnlistmentWarning(read, 500001), null);
  assert.equal(militiaEnlistmentWarning(read, 500004), "location");
  assert.equal(militiaEnlistmentWarning({ ...read, allowedFactions: [] }, 500001), "disallowed");
  assert.equal(militiaEnlistmentWarning({ ...read, standings: new Map([[500001, -0.01]]) }, 500001), "standing");
  assert.equal(militiaEnlistmentWarning({ ...read, cooldown: true }, 500001), "cooldown");
});

test("the direct timer and the recent NPC militia employment each prevent enlistment", () => {
  const now = 134_000_000_000_000_000n;
  const day = 864_000_000_000n;
  const long = (value: bigint): JsonValue => ({ type: "long", value: String(value) });
  const employment = (corporationID: number, start: bigint): JsonValue => ({
    type: "object", name: "eve.common.script.sys.rowset.Rowset", args: { type: "dict", entries: [
      ["columns", { type: "list", items: ["corporationID", "startDate"] }],
      ["lines", { type: "list", items: [[corporationID, long(start)]] }],
    ] },
  });
  assert.equal(militiaCooldown(long(now + 1n), null, now), true);
  assert.equal(militiaCooldown(long(now), null, now), false);
  assert.equal(militiaCooldown(null, employment(1000437, now - day + 1n), now), true);
  assert.equal(militiaCooldown(null, employment(1000437, now - day), now), false);
  assert.equal(militiaCooldown(null, employment(1000171, now), now), false);
});
