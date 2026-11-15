import assert from "node:assert/strict";
import test from "node:test";
import { afterMilitiaEnlistment, militiaAffiliation, militiaCooldown, militiaEnlistmentWarning, militiaInsurgencies, militiaOrganization, militiaOrganizationActions, militiaStationFactions, militiaVictoryPoints, militiaWarzoneMarkers, militiaWarzones, relevantMilitiaPage, type MilitiaEligibility } from "./militiaEnlistment.ts";
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

test("corporation and alliance actions follow the native pending, active and retiring phases", () => {
  const status = (state: number | null, faction: number | null, alliance: number | null = null, executor = false) =>
    militiaOrganization({ type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["status", state], ["factionID", faction]] } }, alliance, executor);
  const read: MilitiaEligibility = { characterID: 140000003, corporationID: 98000000, factionID: null, directFactionID: null,
    corpFactionID: null, stationFactions: [500001], allowedFactions: [500001], standings: new Map(), cooldown: true };
  assert.deepEqual(militiaOrganizationActions(read, 500001), []);
  assert.deepEqual(militiaOrganizationActions({ ...read, organization: status(null, null) }, 500001), ["joinCorporation"]);
  assert.deepEqual(militiaOrganizationActions({ ...read, organization: status(null, null, 99000000, true) }, 500001), ["joinCorporation", "joinAlliance"]);
  const pending: MilitiaEligibility = { ...read, corpFactionID: 500001, organization: status(0, 500001, 99000000, true) };
  assert.equal(militiaEnlistmentWarning(pending, 500001), "pending");
  assert.deepEqual(militiaOrganizationActions(pending, 500001), ["withdrawAlliance"]);
  assert.deepEqual(militiaOrganizationActions(pending, 500004), []);
  const active: MilitiaEligibility = { ...pending, factionID: 500001, organization: status(1, 500001) };
  assert.deepEqual(militiaOrganizationActions(active, 500001), ["retireCorporation"]);
  assert.deepEqual(militiaOrganizationActions({ ...active, organization: status(2, 500001) }, 500001), ["cancelRetireCorporation"]);
  assert.deepEqual(militiaOrganizationActions({ ...active, organization: status(2, 500001, 99000000, false) }, 500001), []);
});

test("warzone occupation preserves FILETIME precision and unknown capture dates", () => {
  const captured = 134_000_000_000_000_001n;
  const state = (date: JsonValue): JsonValue => ({ type: "objectex1", header: [
    { type: "token", name: "factionwarfare.occupationState.OccupationState" },
    [500001, "FL", { type: "list", items: [500001, 500004] }, null, date],
  ] });
  const payload: JsonValue = { type: "dict", entries: [[2, { type: "dict", entries: [
    [30000142, state({ type: "long", value: String(captured) })], [30000143, state(null)],
  ] }]] };
  assert.deepEqual(militiaWarzones(payload).get(2), [
    { systemID: 30000142, occupierID: 500001, attackerID: 500004, adjacency: "FL", dateTaken: captured },
    { systemID: 30000143, occupierID: 500001, attackerID: 500004, adjacency: "FL", dateTaken: null },
  ]);
});

test("dashboard markers match linked pads, active battlefields and visible campaign origins", () => {
  const object = (args: JsonValue[]): JsonValue => ({ type: "objectex1", header: [null, args] });
  const markers = militiaWarzoneMarkers(
    { type: "dict", entries: [[500001, 30045324]] },
    { type: "list", items: [500001] },
    { type: "list", items: [object([1, 30004979, 500001, true, { type: "long", value: "134000000000000000" }, false]), object([2, 30004980, 500001, true, null, false])] },
    { type: "dict", entries: [[30004979, { type: "list", items: [{ type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["dungeonNameID", 999]] } }] }], [30004980, []]] },
  );
  assert.deepEqual([...markers.headquarters], [[500001, 30045324]]);
  assert.deepEqual([...markers.launchers], [500001]);
  assert.deepEqual(markers.pads, [{ systemID: 30004979, factionID: 500001 }]);
  assert.deepEqual([...markers.battlefields], [[30004979, 999]]);
  assert.deepEqual(militiaVictoryPoints(object([37500, 75000])), { score: 37500, threshold: 75000 });
  assert.equal(militiaVictoryPoints(object([37500, 0])), null);
  const campaign: JsonValue = { type: "objectex1", header: [null, { type: "dict", entries: [
    ["_campaignID", 21], ["_pirateFactionID", 500010], ["_warzoneID", 2], ["_originSolarsystemID", 30004979], ["_structureID", null],
  ] }] };
  assert.deepEqual(militiaInsurgencies([campaign]), [{ campaignID: 21, factionID: 500010, warzoneID: 2, originSystemID: 30004979, fobSystemID: null }]);
});
