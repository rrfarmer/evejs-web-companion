import test from "node:test";
import assert from "node:assert/strict";
import { unixMsToFiletime } from "../bridge/activity.ts";
import { autoMoonStatus, decodeAutoMoonDetails } from "../bridge/autoMoonMining.ts";
import type { BridgeCallRequestBody, JsonValue } from "../bridge/wire.ts";
import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "./flow.ts";

const structureID = 1030000000001;
const ownerID = 98000003;
const solarSystemID = 30002647;
const moonID = 40161465;
const now = 1770000000000;
const harvest = now + 5000;
const long = (value: bigint | number): JsonValue => ({ type: "long", value: String(value) });
const dict = (entries: JsonValue[][]): JsonValue => ({ type: "dict", entries });
const gas = (amount: number) => dict([[81143, long(amount)]]);
const wireDetails = (next: JsonValue, fuel = gas(1600), capacity = 498750) => dict([
  ["moonID", long(moonID)], ["nextHarvestTime", next], ["availableFuel", fuel],
  ["outputMaterials", dict([[16633, 125]])], ["remainingOutputBayCapacity", capacity],
]);

test("moon drill decodes native FILETIME and distinguishes stopped, low gas and full output", () => {
  const next = long(unixMsToFiletime(harvest));
  const details = decodeAutoMoonDetails(wireDetails(next, dict([[81143, 1600], [4051, long(1200)]])), now);
  assert.deepEqual(details, { moonID, nextHarvestAtMs: harvest, remainingCapacity: 498750, nowMs: now,
    fuel: new Map([[81143, 1600], [4051, 1200]]), materials: new Map([[16633, 125]]) });
  assert.equal(autoMoonStatus(details), "Operational");
  assert.equal(autoMoonStatus(decodeAutoMoonDetails(wireDetails(null, gas(0)), now)), "Stopped");
  assert.equal(autoMoonStatus(decodeAutoMoonDetails(wireDetails(next, gas(199)), now)), "Low Gas");
  assert.equal(autoMoonStatus(decodeAutoMoonDetails(wireDetails(next, gas(200), 0), now)), "Output Bay Full");
  assert.throws(() => decodeAutoMoonDetails(wireDetails("bad time"), now), /unreadable mining details/);
});

test("moon drill uses owner Station Manager permission or native profile access before reading output", async () => {
  const info = { type: "object", name: "util.KeyVal", args: dict([
    ["typeID", 81826], ["itemName", "Test Metenox"], ["ownerID", ownerID], ["solarSystemID", solarSystemID],
  ]) };
  const responses: Record<string, JsonValue> = {
    GetStructureInfo: info,
    CharacterHasSetting: false,
    RequestMiningDetails: wireDetails(long(unixMsToFiletime(harvest))),
    RequestMiningCycleOutput: dict([[16633, long(700)], [16636, 260]]),
  };
  const calls: BridgeCallRequestBody[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) !== "/api/bridge/call") return Response.json({ ok: true });
    const call = JSON.parse(String(init?.body)) as BridgeCallRequestBody;
    calls.push(call);
    return Response.json({ ok: true, service: call.service, method: call.method, result: responses[call.method] ?? null, notifications: [] });
  };
  const pilot = (corporationID: number, corpRole: string) => {
    const store = createClientStore();
    store.apply({ type: "character/online", station: null, character: {
      characterID: 140000001, characterName: "Test Pilot", corporationID, corpRole, stationID: null,
      structureID: null, solarSystemID,
    } });
    return createAppFlow(store, { fetch: fetcher });
  };

  const manager = pilot(ownerID, "2048");
  const miner = await manager.openAutoMoonMiner(structureID);
  assert.deepEqual(miner, { id: structureID, name: "Test Metenox", ownerID, solarSystemID });
  assert.equal((await manager.loadAutoMoonDetails(miner!)).nextHarvestAtMs, harvest);
  assert.deepEqual(await manager.loadAutoMoonCycle(miner!), new Map([[16633, 700], [16636, 260]]));
  assert.deepEqual(calls.splice(0).filter(call => call.service !== "config" && call.service !== "owner" && call.service !== "evelocations" && call.service !== "invtypes")
    .map(call => [call.service, call.method, call.args]), [
    ["structureDirectory", "GetStructureInfo", [structureID]],
    ["autoMoonMining", "RequestMiningDetails", [solarSystemID, structureID]],
    ["autoMoonMining", "RequestMiningCycleOutput", [solarSystemID, structureID]],
  ]);

  const outsider = pilot(ownerID + 1, "2048");
  assert.equal(await outsider.openAutoMoonMiner(structureID), null);
  assert.equal(outsider.dialogsSaid.get()[0]?.dialog, "AccessToAutoMoonMinerDenied");
  assert.deepEqual(calls.find(call => call.method === "CharacterHasSetting")?.args, [structureID, 36]);
  assert.equal(calls.some(call => call.service === "autoMoonMining"), false);

  responses.CharacterHasSetting = true;
  const member = pilot(ownerID, "0");
  assert.deepEqual(await member.openAutoMoonMiner(structureID), miner);
  assert.equal(member.dialogsSaid.get().length, 0);
});
