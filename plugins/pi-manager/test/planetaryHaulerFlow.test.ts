import test from "node:test";
import assert from "node:assert/strict";
import "./harness.ts";
import { createAppFlow } from "../../../web/src/app/flow.ts";
import { createClientStore } from "../../../web/src/store/clientStore.ts";
import type { BotScript } from "../../../web/src/bots/botScript.ts";
import type { CustomBotState } from "../../../web/src/store/types.ts";
import { fittingBody, flightBody, holdsBody, namesBody, SHIP_ID, STATION_ID, SOLAR_SYSTEM_ID } from "../../../web/src/app/botFixtures.ts";

const HAULER_ID = 9988400091901;
const script: BotScript = {
  format: "evejs-bot-script", version: 1, name: "Board the hauler", notes: "",
  home: { entity: "station", id: STATION_ID, name: "Home", systemName: null },
  interrupts: [],
  program: [{ id: "hauler", kind: "macro", macro: "pi-manager:board-hauler", args: {} }],
};

for (const failure of ["capacity", "request"] as const) {
  test(`a ${failure} failure on the parked hauler waits and retries instead of claiming no hauler is parked`, { timeout: 10_000 }, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const store = createClientStore();
    store.apply({ type: "character/online", character: {
      characterID: 140000005, characterName: "Test", stationID: STATION_ID,
      structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
    }, station: null });
    let haulerReads = 0;
    let resolveBoarded!: (shipID: number) => void;
    const boarded = new Promise<number>(resolve => { resolveBoarded = resolve; });
    const paths: string[] = [];
    // The board is the page's own call since 2026-10-14 (ship.Board through the generic call): named by the call.
    const boards: unknown[] = [];
    const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
      const path = String(input);
      paths.push(path);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      let result: unknown = { ok: true };
      if (path === "/api/bridge/flight/status") result = flightBody(true);
      if (path === "/api/bridge/fitting") result = fittingBody();
      if (path === "/api/names") result = namesBody(body);
      if (path === "/api/bridge/script/observation") result = { ok: true, space: { inSpace: false }, inSpace: [], bay: [] };
      if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
      if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
      if (path === "/api/bridge/inventory") result = {
        ok: true, stationID: STATION_ID, activeShipID: SHIP_ID,
        hangar: { list: { type: "list", items: [SHIP_ID, HAULER_ID].map(itemID => ({
          type: "packedrow", fields: { itemID, typeID: itemID === HAULER_ID ? 650 : 17480,
            categoryID: 6, groupID: 28, singleton: 1, quantity: -1 },
        })) } },
        cargo: { list: { type: "list", items: [] }, capacity: null },
      };
      if (path === `/api/bridge/ship/${SHIP_ID}/bays?keys=planetary`) result = {
        ok: true, shipID: SHIP_ID, bays: [{ key: "planetary", present: false,
          capacity: { capacity: 0, used: 0 }, items: null, error: null }],
      };
      if (path === `/api/bridge/ship/${HAULER_ID}/bays?keys=planetary`) {
        haulerReads += 1;
        if (haulerReads === 1 && failure === "request") {
          return new Response(JSON.stringify({ ok: false, error: "CALL_REFUSED", message: "Read failed" }), { status: 502 });
        }
        // The real bays route returns 200 with present=null when GetCapacity fails.
        result = { ok: true, shipID: HAULER_ID, bays: [{ key: "planetary",
          present: haulerReads === 1 ? null : true,
          capacity: haulerReads === 1 ? null : { capacity: 45000, used: 0 },
          items: haulerReads === 1 ? null : [], error: haulerReads === 1 ? "READ_FAILED" : null }],
        };
      }
      if (path === "/api/bridge/call" && body.service === "ship" && body.method === "Board") {
        boards.push(body.args);
        resolveBoarded(body.args[0]);
      }
      return new Response(JSON.stringify(result));
    } });
    let resolveFirst!: (state: CustomBotState) => void;
    const firstDecision = new Promise<CustomBotState>(resolve => { resolveFirst = resolve; });
    const unsubscribe = store.customBot.subscribe(state => {
      if (state.stepPath === "hauler") resolveFirst(state);
    });
    try {
      await flow.startCustomBot(script);
      const first = await firstDecision;
      assert.equal(first.status, "running", first.pauseReason ?? first.why ?? "");
      assert.equal(first.why, "Reading the ships parked here.");
      assert.equal(boards.length, 0);
      // Let the first tick schedule its ordinary cadence, then advance to its retry.
      await new Promise<void>(resolve => setImmediate(resolve));
      context.mock.timers.tick(2000);
      assert.equal(await boarded, HAULER_ID);
      assert.equal(haulerReads, 2);
    } finally {
      unsubscribe();
      flow.stopCustomBot();
    }
  });
}
