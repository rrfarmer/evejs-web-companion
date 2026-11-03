import test from "node:test";
import assert from "node:assert/strict";
import "./harness.ts";
import { createAppFlow } from "../../../web/src/app/flow.ts";
import { createClientStore } from "../../../web/src/store/clientStore.ts";
import type { BotScript } from "../../../web/src/bots/botScript.ts";
import type { CustomBotState } from "../../../web/src/store/types.ts";
import { fittingBody, flightBody, holdsBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID } from "../../../web/src/app/botFixtures.ts";

const OFFICE_A = 1200040000001;
const OFFICE_B = 1200040000002;
const script: BotScript = {
  format: "evejs-bot-script", version: 1, name: "Collect customs", notes: "",
  home: { entity: "station", id: null, name: null, systemName: null },
  interrupts: [],
  program: [{ id: "customs", kind: "macro", macro: "pi-manager:collect-customs", args: {} }],
};

for (const failure of ["null", "malformed"] as const) {
  test(`an HTTP 200 with ${failure} office contents waits, retries and collects recovered goods`, { timeout: 10_000 }, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const store = createClientStore();
    store.apply({ type: "character/online", character: {
      characterID: 140000005, characterName: "Test", stationID: null,
      structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
    }, station: null });
    const counts = new Map<number, number>();
    const transfers: Record<string, unknown>[] = [];
    let resolveFirst!: (state: CustomBotState) => void;
    const firstDecision = new Promise<CustomBotState>(resolve => { resolveFirst = resolve; });
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const unsubscribe = store.customBot.subscribe(state => {
      if (state.stepPath === "customs") {
        resolveFirst(state);
      }
      if (state.status === "stopped") {
        resolveFirst(state);
        resolveFinished();
      }
    });
    const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      let result: unknown = { ok: true };
      if (path === "/api/bridge/flight/status") result = flightBody(false);
      if (path === "/api/bridge/fitting") result = fittingBody();
      if (path === "/api/names") result = namesBody(body);
      if (path === "/api/bridge/script/observation") result = { ok: true, inSpace: [], bay: [], space: {
        inSpace: true, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID, sampledAtMs: Date.now(),
        ship: { itemID: SHIP_ID, typeID: 17480, radius: 100, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mode: "STOP" },
        entities: [OFFICE_A, OFFICE_B].map(itemID => ({
          itemID, kind: "orbital", typeID: 2233, groupID: 1025, radius: 1000,
          position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        })),
      } };
      if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
      if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
      if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) result = { ok: true, shipID: SHIP_ID, bays: [
        { key: "cargo", label: "Cargo", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
        { key: "planetary", label: "Planetary", present: true, capacity: { capacity: 10000, used: 0 }, items: [], error: null },
      ] };
      if (path === "/api/bridge/inventory/transfer") {
        transfers.push(body);
        result = { ok: true, applied: true, moved: [90070], declined: [], notFound: [] };
      }
      const container = path.match(/^\/api\/bridge\/inventory\/container\/(\d+)$/);
      if (container) {
        const officeID = Number(container[1]);
        const count = (counts.get(officeID) ?? 0) + 1;
        counts.set(officeID, count);
        result = { ok: true, containerID: officeID, capacity: null, volumes: { "3645": 0.38 },
          list: officeID === OFFICE_B && count === 1
            ? failure === "null" ? null : { type: "list", items: [{ type: "packedrow", fields: {} }] }
            : { type: "list", items: officeID === OFFICE_B && transfers.length === 0 ? [{
                type: "packedrow", fields: { itemID: 90070, typeID: 3645, categoryID: 43, quantity: 70, singleton: 0 },
              }] : [] },
        };
      }
      return Response.json(result);
    } });
    try {
      await flow.startCustomBot(script);
      const first = await firstDecision;
      assert.equal(first.status, "running", first.pauseReason ?? first.why ?? "");
      assert.equal(first.why, "Reading the customs offices.");
      assert.equal(store.customBot.get().status, "running");
      await new Promise<void>(resolve => setImmediate(resolve));
      for (let tick = 0; tick < 3; tick += 1) {
        context.mock.timers.tick(2000);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await finished;
      assert.deepEqual(transfers, [{ itemIDs: [90070], from: { kind: "container", itemID: OFFICE_B },
        to: { kind: "shipBay", bay: "planetary" } }]);
      assert.equal(counts.get(OFFICE_A), 3);
      // The recovered transfer is followed by a read proving whether cargo remains.
      assert.equal(counts.get(OFFICE_B), 5);
      assert.equal(store.customBot.get().status, "stopped");
    } finally {
      unsubscribe();
      flow.stopCustomBot();
    }
  });
}
