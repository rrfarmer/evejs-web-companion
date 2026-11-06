import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { SHIP_ID, SOLAR_SYSTEM_ID, fittingBody, flightBody, holdsBody, namesBody, spaceBody } from "./botFixtures.ts";

const combat: BotScript = {
  format: "evejs-bot-script", version: 1, name: "Combat handoff", notes: "",
  home: { entity: "station", id: 60003760, name: "Home", systemName: "Test" }, interrupts: [],
  program: [{ id: "fight", kind: "macro", macro: "fight-with-drones", args: {} }],
};

for (const replacement of ["mining", "mission"] as const) {
  test(`starting ${replacement} retains the combat controller until its owned work settles`, { timeout: 5000 }, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const store = createClientStore();
    store.apply({ type: "character/online", character: { characterID: 90000001, characterName: "Test",
      corporationID: 98000000, stationID: null, structureID: null, solarSystemID: SOLAR_SYSTEM_ID }, station: null });
    let docked = false;
    let resolveIssued!: () => void;
    const issued = new Promise<void>(resolve => { resolveIssued = resolve; });
    const mutations: string[] = [];
    const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
      const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
      let result: unknown = { ok: true };
      if (path === "/api/bridge/call") result = { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
      if (path === "/api/bridge/flight/status") result = flightBody(docked);
      if (path === "/api/bridge/fitting") result = fittingBody();
      if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
      if (path === "/api/names") result = { ...(namesBody(body) as object), names: {
        ...((namesBody(body) as { names: object }).names), "typeGroup:2454": "Combat Drone", "type:2454": "Test combat drone",
      } };
      if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
      if (path === "/api/bridge/script/observation" || path === "/api/bridge/space/snapshot") {
        const sample = spaceBody() as { space: { ship: object } };
        result = { ok: true, activeShipID: SHIP_ID, bay: [], inSpace: [{ itemID: 7007, typeID: 2454,
          controlled: true, reconnectCandidate: false, activity: "idle", shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
          space: { ...sample.space, ship: { ...sample.space.ship, weaponBanks: {} }, entities: [
            { itemID: 7007, typeID: 2454, kind: "drone", controllerID: SHIP_ID, radius: 5,
              position: { x: 100, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
            { itemID: 8008, typeID: 999, kind: "ship", isNpc: true, npcEntityType: "npc", radius: 50,
              position: { x: 5000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
          ] } };
      }
      if (init?.method === "POST" && path.startsWith("/api/bridge/") && path !== "/api/bridge/call" && path !== "/api/names") {
        mutations.push(path);
        resolveIssued();
      }
      // A write the page makes itself (bridge/movementWrites.ts: a follow is beyonce's own call) is an order too.
      if (path === "/api/bridge/call" && body.confirm === true) {
        mutations.push(`${body.service}.${body.method}`);
        resolveIssued();
      }
      return Response.json(result);
    } });
    try {
      await flow.startCustomBot(combat);
      await issued;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(mutations.some(path => /targets\/lock|^beyonce\.CmdFollowBall$/.test(path)), "combat acquired a lock or movement order");
      const replace = replacement === "mining" ? () => flow.startMiningBot({ beltID: 40000123, beltName: "Belt",
        stationID: 60003760, stationName: "Home", miningModuleIDs: [7001], healthFloor: 0.5, useDrones: false }) :
        () => flow.startMissionBot({ agentID: 3018920, agentName: "Agent",
          agentStationID: 60003760, agentStationName: "Home", maxJumps: 10, maxMissions: 0 });
      await assert.rejects(replace(), /previous controller|unresolved work|Stop.*sett|Combat Stop/i);
      assert.equal(store.customBot.get().status, "running", "the new start cannot silently abandon combat custody");
      docked = true;
      flow.stopCustomBot();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(store.customBot.get().status, "stopped", "authoritative docking lets combat Stop retire its owned work");
      await assert.doesNotReject(replace(), "the settled controller no longer blocks replacement");
    } finally {
      docked = true;
      flow.stopMiningBot(); flow.stopMissionBot(); flow.stopCustomBot();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}
