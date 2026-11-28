import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceEntity } from "../../../web/src/plugin-api/blocks.ts";
import type { Ask } from "../../../web/src/plugin-api/flying.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import * as uoc from "./flying.ts";
// Test-only comparison with Farmer’s current wire decoders and ownership rules.
import { decodeCorpAssetItems } from "../../../web/src/bridge/corpAssets.ts";
import { unwrapCachedResult } from "../../../web/src/bridge/market.ts";
import { isLootableContainer, lootRightsGrant } from "../../../web/src/nav/lootableContainers.ts";
import { droneRoleForGroup } from "../../../web/src/nav/droneRoles.ts";
import { quoteRepairs, repairQuoted } from "../../../web/src/bridge/repairShop.ts";

test("cached corporation assets keep their item and division identity", () => {
  const rowset = {type: "objectex2", list: [
    {type: "packedrow", fields: {itemID: {type: "long", value: "110"}, typeID: 9, flagID: 116, ownerID: 33,
      locationID: 88, categoryID: 6, groupID: 17, quantity: -1, singleton: 1, customInfo: "assembled"}},
    {type: "packedrow", columns: ["itemID", "stacksize", "quantity"], values: ["111", 6, 6]},
  ]} as JsonValue;
  for (const raw of [rowset, null, {type: "object", name: {value: "objectCaching.CachedMethodCallResult"},
    args: [0, {type:"substream", value:rowset}]}, {type:"object", name:"objectCaching.CachedMethodCallResult", args:[]}] as JsonValue[]) {
    assert.deepEqual(uoc.unwrapCachedResult(raw), unwrapCachedResult(raw));
    assert.deepEqual(uoc.decodeCorpAssetItems(raw), decodeCorpAssetItems(raw));
  }
});

test("loot checks retain stock ownership, fleet rights and protected-property precedence", () => {
  const pilot = { characterID: 91000001, corporationID: 99000001, fleetID: 22, fleetMemberIDs: [91000002] };
  for (const data of [{}, {ownerID:pilot.characterID}, {ownerID:pilot.corporationID}, {ownerID:91000002},
    {ownerID:1}, {lootAbandoned:true}, {ownerID:pilot.characterID, protectedPropertyCorporationID:99000004},
    {protectedPropertyCorporationMarkerPresent:true}, {ownerID:91000004, lootRightCorpID:pilot.corporationID},
    {lootRights:{abandoned:false, fleetID:22}}, {lootRights:{abandoned:false, corpID:pilot.corporationID}}]) {
    const entity = {kind:"container", ...data} as SpaceEntity;
    assert.equal(uoc.lootRightsGrant(entity, pilot), lootRightsGrant(entity, pilot));
    assert.equal(uoc.isLootableContainer(entity, pilot), isLootableContainer(entity, pilot));
  }
  for (const name of [null, "Mining Drone", "Combat Drone", "SALVAGE DRONE", "Logistic Drone", "Unknown"]) {
    assert.equal(uoc.droneRoleForGroup(name), droneRoleForGroup(name));
  }
});

test("MCC selects the hull’s own damaged part and pays the same station or structure quote", async () => {
  for (const item of [{itemID:8, damage:2.3, costToRepairOneUnitOfDamage:4}, {itemID:8, cost:3},
    {itemID:8, damage:1}, {itemID:8, damage:0}, {itemID:9, cost:77}]) {
    const ask: Ask = async () => ({type:"dict", entries:[["8", {items:[{itemID:9,cost:40}, item]}]]} as JsonValue);
    const part = (await quoteRepairs(ask, [8]))[0]?.parts.find(row => row.itemID === 8);
    assert.deepEqual(await uoc.quoteHullRepair(ask,8), part ? {cost:part.cost} : null);
    if (!part) continue;
    for (const dock of [{stationID:3,structureID:null}, {stationID:null,structureID:8}]) {
      const actual: unknown[] = [], expected: unknown[] = [];
      const stock: PromiseSettledResult<void>[] = await Promise.allSettled([repairQuoted(async (...args) => { expected.push(args); return null; },
        [{itemID:8, repairItemIDs:[8], damagedParts:1, parts:[part], cost:part.cost}], dock)]);
      const local: PromiseSettledResult<void>[] = await Promise.allSettled([uoc.repairQuotedHull(async (...args) => {actual.push(args); return null;}, 8, part.cost, dock)]);
      assert.equal(local[0]?.status, stock[0]?.status);
      assert.deepEqual(actual, expected);
    }
  }
});
