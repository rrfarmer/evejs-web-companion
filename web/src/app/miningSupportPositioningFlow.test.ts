import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { freshSupportPositionMemory } from "../nav/miningSupportPositioning.ts";
const request = { sessionEpoch: "run", intendedCharacterIDs: [2], requirements: { requireMiningBurst: true },
  policy: { deadbandMeters: 100, arrivalMeters: 10, settledSpeedMetersPerSecond: 0.1,
    service: { maintainBursts: true, useIndustrialCore: false, enableCompression: false, coreRequirement: "continueWithoutCore" as const } } };
test("normal positioning refuses offline or another controller before authority/action IO", async () => {
  const store = createClientStore();
  let calls = 0;
  const flow = createAppFlow(store, { perSessionToken: true, initialSessionToken: "pilot", fetch: async () => { calls++; throw new Error("unexpected IO"); } });
  await assert.rejects(flow.tickMiningSupportPositioning(freshSupportPositionMemory(), request), /online pilot/);
  store.apply({ type: "character/online", character: { characterID: 1, characterName: "Support", stationID: null, structureID: null, solarSystemID: 3001, corporationID: null }, station: null });
  store.apply({ type: "bot/started", beltName: "Belt", stationName: "Station", startedAt: 100 });
  await assert.rejects(flow.tickMiningSupportPositioning(freshSupportPositionMemory(), request), /Another controller/);
  assert.equal(calls, 0);
});
