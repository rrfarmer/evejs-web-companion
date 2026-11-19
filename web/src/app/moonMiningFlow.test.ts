import test from "node:test";
import assert from "node:assert/strict";
import { unixMsToFiletime } from "../bridge/activity.ts";
import type { BridgeCallRequestBody } from "../bridge/wire.ts";
import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "./flow.ts";

test("starting a pull checks live fuel and sends nothing when the pilot declines", async () => {
  const structureID = 1030000000000;
  const corporationID = 98000003;
  const systemID = 30002647;
  const now = Date.now();
  const day = 86400000;
  const ready = now + 7 * day;
  let fuel = now + 20 * day;
  const calls: BridgeCallRequestBody[] = [];
  const store = createClientStore();
  store.apply({ type: "character/online", station: null, character: {
    characterID: 140000001, characterName: "Test Pilot", corporationID, corpRole: "2048",
    stationID: null, structureID, solarSystemID: systemID,
  } });
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === "/api/bridge/flight/status") {
      return Response.json({ ok: true, flight: { docked: true, inSpace: false, stationID: null,
        structureID, solarSystemID: systemID, shipID: structureID }, notifications: [] });
    }
    assert.equal(String(input), "/api/bridge/call");
    assert.equal(typeof init?.body, "string");
    const call: BridgeCallRequestBody = JSON.parse(init!.body as string);
    calls.push(call);
    const result = call.method === "GetStructureInfo" ? {
      type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
        ["typeID", 35835], ["ownerID", corporationID], ["itemName", "Test Athanor"],
        ["fuelExpires", { type: "long", value: unixMsToFiletime(fuel).toString() }],
      ] },
    } : call.method === "CharacterHasSetting" ? true : null;
    return Response.json({ ok: true, service: call.service, method: call.method, result, notifications: [] });
  };
  const flow = createAppFlow(store, { fetch: fetcher });
  await flow.loadFlightStatus();
  const refinery = await flow.loadMoonRefinery(structureID);
  assert.equal(refinery?.id, structureID);
  fuel = now + 4 * day;

  const pending = flow.startMoonPull(structureID, ready, false);
  for (let attempts = 0; attempts < 30 && flow.dialogsSaid.get().length === 0; attempts++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const question = flow.dialogsSaid.get()[0];
  assert.equal(question?.dialog, "NotEnoughFuelForExtractionDuration");
  flow.answerDialog(question!.n, false);
  await pending;
  assert.deepEqual(calls.filter(call => call.method !== "GetGuests").map(call => call.method),
    ["GetStructureInfo", "CharacterHasSetting", "GetStructureInfo"]);

  fuel = now + 20 * day;
  await flow.startMoonPull(structureID, ready, false);
  assert.deepEqual(calls.slice(-2).map(call => call.method), ["GetStructureInfo", "StartNewExtraction"]);
  assert.equal(calls.at(-1)?.args?.[0], structureID);
  assert.equal(calls.at(-1)?.args?.[2], false);
  assert.equal(calls.at(-1)?.confirm, true);
  assert.equal(flow.dialogsSaid.get().length, 0);
});
