import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { DEFAULT_COMPANION_SETUP } from "../nav/fleetCompanionLoop.ts";
import { fittingBody, flightBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const OWN = 90000001, HUMAN = 90000011, TARGET = 300001, DRONES = [601, 602], DRONE_TYPE = 2456;
const dict = (entries: unknown[][] = []) => ({ type: "dict", entries });
const keyVal = (entries: unknown[][]) => ({ type: "object", name: "util.KeyVal", args: dict(entries) });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(role: "combat" | "repair", unreadable = false) {
  const targets = new Map<number, number>();
  // Whether the drones' next read is the one an engagement makes after its call (app/flow.ts, orderedThenRead).
  let readAfterOrder = false;
  const orders: number[][] = [];
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: OWN, characterName: "Synthetic Pilot", stationID: null, structureID: null,
    solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000001,
  }, station: null });
  if (role === "combat") store.apply({ type: "fleet/target-tags", tags: new Map([[TARGET, "A"]]) });
  else store.apply({ type: "fleet/broadcast", broadcast: {
    name: "HealShield", scope: 3, senderCharID: HUMAN, senderSolarSystemID: SOLAR_SYSTEM_ID,
    itemID: TARGET, typeID: null, receivedAtMs: Date.now(),
  } });
  const inSpace = () => DRONES.map((itemID) => ({ itemID, typeID: DRONE_TYPE,
    controlled: true, targetID: targets.get(itemID) ?? null, activity: targets.has(itemID) ? "fighting" : "idle",
  }));
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    let answer: unknown = { ok: true };
    if (path === "/api/bridge/flight/status") answer = flightBody(false);
    // An order to the ship is the page's own call (bridge/movementWrites.ts), answered as its route was: taken.
    if (path === "/api/bridge/call" && body.service === "beyonce") answer = { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
    if (path === "/api/bridge/fitting") answer = fittingBody({});
    // The targets read also says who has the ship locked (GetTargeters).
    if (path.split("?")[0] === "/api/bridge/targets") answer = { ok: true, targetIDs: role === "combat" ? [TARGET] : [], notifications: [] };
    if (path === "/api/bots/active") answer = { ok: true, bots: [], characterIDs: [] };
    if (path === "/api/names") {
      const base = namesBody(body) as { names: Record<string, string> };
      answer = { ...base, names: { ...base.names, [`typeGroup:${DRONE_TYPE}`]: role === "combat" ? "Combat Drone" : "Logistic Drone" } };
    }
    if (path === "/api/bridge/bound-fleet") answer = { ok: true, characterID: OWN, fleetID: 90000002, reads: {
      GetInitState: { result: keyVal([["fleetID", 90000002], ["members", dict([
        [OWN, keyVal([["charID", OWN], ["role", 4], ["job", 0]])],
        [HUMAN, keyVal([["charID", HUMAN], ["role", 1], ["job", 0]])],
      ])], ["wings", dict()], ["squads", dict()], ["motd", "Ready."]]) },
      GetWings: { result: dict() }, GetMotd: { result: "Ready." }, GetJoinRequests: { result: dict() },
      GetFleetComposition: { result: { type: "list", items: [] } },
    } };
    if (path === "/api/bridge/drones") {
      answer = { ok: true, activeShipID: SHIP_ID, bay: [], inSpace: readAfterOrder && unreadable ? null : inSpace(), notifications: [] };
      readAfterOrder = false;
    }
    if (path === "/api/bridge/space/snapshot") answer = { ok: true, notifications: [], space: {
      inSpace: true, shipID: SHIP_ID, solarSystemID: SOLAR_SYSTEM_ID, sampledAtMs: Date.now(),
      ship: { itemID: SHIP_ID, typeID: 17480, characterID: OWN, corporationID: 98000001, position: { x: 0, y: 0, z: 0 },
        radius: 60, mode: "STOP", shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1, activeModuleIDs: [] },
      entities: [
        { itemID: TARGET, typeID: 999, kind: "ship", isNpc: role === "combat", isSelf: false, characterID: HUMAN,
          corporationID: role === "repair" ? 98000001 : 98000002,
          position: { x: 10000, y: 0, z: 0 }, radius: 30, shieldRatio: 0.8, armorRatio: 1, hullRatio: 1 },
        ...DRONES.map((itemID) => ({ itemID, typeID: DRONE_TYPE, kind: "drone", ownerID: OWN, controllerID: SHIP_ID,
          controllerOwnerID: OWN, targetEntityID: targets.get(itemID) ?? null, droneActivity: targets.has(itemID) ? "fighting" : "idle",
          position: { x: 1000, y: 0, z: 0 }, radius: 5, shieldRatio: 1, armorRatio: 1, hullRatio: 1 })),
      ],
    } };
    // The engagement is the page's own call since 2026-10-14 (entity.CmdEngage through the generic call), answered
    // with what the server says of each drone that could not; the drones are read after it, as the route read them.
    if (path === "/api/bridge/call" && body.service === "entity" && body.method === "CmdEngage") {
      const [ids, targetID] = body.args as [number[], number];
      assert.equal(targetID, TARGET);
      orders.push(ids);
      const refused = role === "combat" && orders.length === 1 ? [602] : [];
      for (const id of ids) if (!refused.includes(id)) targets.set(id, TARGET);
      answer = { ok: true, service: "entity", method: "CmdEngage", result: dict(refused.map((id) => [id, ["CustomNotify",
        dict([["notify", "That target is out of drone control range."]])]])), notifications: [] };
      readAfterOrder = true;
    }
    return { ok: true, status: 200, json: async () => answer };
  }) as unknown as typeof fetch;
  return { store, orders, flow: createAppFlow(store, { fetch: fetcher }) };
}

test("the real companion flow retries only the refused combat drone after a partial 200 response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { flow, store, orders } = harness("combat");
  try {
    await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
    for (let tick = 0; tick < 20 && orders.length < 2; tick += 1) { await turn(); t.mock.timers.tick(2000); }
    assert.deepEqual(orders, [[601, 602], [602]], "a 200 response must not suppress the refused drone or replay the accepted one");
    for (let tick = 0; tick < 3; tick += 1) { await turn(); t.mock.timers.tick(2000); }
    assert.equal(orders.length, 2);
    assert.equal(store.companion.get().status, "running");
  } finally { flow.stopFleetCompanion(); t.mock.timers.reset(); }
});

test("the real companion flow confirms same-corp repair drones without a target lock", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { flow, store, orders } = harness("repair");
  try {
    await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
    for (let tick = 0; tick < 5; tick += 1) { await turn(); t.mock.timers.tick(2000); }
    assert.deepEqual(orders, [[601, 602]]);
    assert.equal(store.companion.get().status, "running");
  } finally { flow.stopFleetCompanion(); t.mock.timers.reset(); }
});

test("the real companion flow retries a definite refusal at once and resends the flight when an outcome is unknown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { flow, store, orders } = harness("combat", true);
  try {
    await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
    for (let tick = 0; tick < 5; tick += 1) { await turn(); t.mock.timers.tick(2000); }
    assert.deepEqual(orders.slice(0, 2), [[601, 602], [602]], "the definite refused subset is retried first");
    assert.equal(store.companion.get().status, "running", "an unknown outcome is never a pause");
    for (let tick = 0; tick < 6; tick += 1) { await turn(); t.mock.timers.tick(2000); }
    assert.ok(orders.length >= 3, "the flight is sent again after the short wait");
    assert.deepEqual(orders[2], [601, 602], "engaging a drone already on the target is the same order, so the whole flight goes");
    assert.equal(store.companion.get().status, "running");
  } finally { flow.stopFleetCompanion(); t.mock.timers.reset(); }
});
