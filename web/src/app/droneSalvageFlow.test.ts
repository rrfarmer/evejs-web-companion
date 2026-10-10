// Drones sent to salvage from the page, through the real flow over a faked BFF.
//
// It is the client's own call (bridge/boundEntityWrites.ts): the entity
// service's CmdSalvage with the drones and the pilot's active target, or None
// where it has none (droneFunctions.py 156 to 161), as a pilot's write the page
// means. What the server says of each drone that could not is shown as it came,
// where the client raises the first of them.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const CHARACTER_ID = 90000001;
const SHIP_ID = 9988400023309;
const [SALVAGER_A, SALVAGER_B] = [9988400023500, 9988400023501];
const WRECK = 9988400024000;
const SALVAGE_DRONE = 32787;

const outThere = (ids: readonly number[]) => ids.map((itemID) => ({
  itemID, typeID: SALVAGE_DRONE, name: "Salvage Drone I", activity: "idle", targetID: null, shieldRatio: 1, armorRatio: 1, hullRatio: 1, controlled: true,
}));

/** A flow for a pilot in space, over a BFF whose server answers a salvage order with `answer` (or refuses with `refusal`). */
function harness(options: { readonly answer?: unknown; readonly refusal?: string; readonly out?: readonly number[] } = {}) {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: { characterID: CHARACTER_ID, characterName: "Synthetic Pilot", stationID: null, structureID: null, solarSystemID: 30000142, corporationID: 98000001 },
    station: null,
  });
  const asked: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input), "http://bff.test").pathname;
    const body = (init && typeof init.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    asked.push({ path, body });
    const respond = (status: number, payload: unknown) => ({ ok: status >= 200 && status < 300, status, async json() { return payload; } });
    if (path === "/api/bridge/call" && body.service === "entity") {
      if (options.refusal !== undefined) return respond(409, { ok: false, error: "CALL_REFUSED", message: options.refusal });
      return respond(200, { ok: true, service: "entity", method: body.method, result: options.answer ?? { type: "dict", entries: [] }, notifications: [] });
    }
    if (path === "/api/bridge/drones") {
      return respond(200, { ok: true, activeShipID: SHIP_ID, bay: [], inSpace: outThere(options.out ?? [SALVAGER_A, SALVAGER_B]), shipInfo: null, errors: {} });
    }
    return respond(200, { ok: true });
  }) as unknown as typeof fetch;
  const flow = createAppFlow(store, { fetch: fakeFetch });
  const orders = () => asked.filter((each) => each.path === "/api/bridge/call" && each.body.service === "entity").map((each) => each.body);
  const routes = () => asked.filter((each) => each.path.startsWith("/api/bridge/entity/drones/")).map((each) => each.path);
  return { store, flow, asked, orders, routes };
}

const order = (args: unknown[]) => ({ service: "entity", method: "CmdSalvage", args, kwargs: null, pilot: true, confirm: true });

test("drones are sent to salvage by the page's own call: the drones, and None where nothing is named", async () => {
  const { store, flow, orders, routes } = harness();

  await flow.salvageDrones([SALVAGER_A, SALVAGER_B], null);

  // droneFunctions.py 160: entity.CmdSalvage(droneIDs, targetID), the target None with nothing targeted.
  assert.deepEqual(orders(), [order([[SALVAGER_A, SALVAGER_B], null])]);
  assert.deepEqual(routes(), [], "the route is not asked");
  assert.deepEqual([store.drones.get().lastAction, store.drones.get().actionError, store.drones.get().silentDecline, store.drones.get().orderReports], ["Salvage", null, null, []]);
});

test("with a wreck named, that wreck is the target", async () => {
  const { flow, orders } = harness();

  await flow.salvageDrones([SALVAGER_A], WRECK);

  assert.deepEqual(orders(), [order([[SALVAGER_A], WRECK])]);
});

test("the drones are read again after the order, and what is out is what the server says", async () => {
  const { store, flow, asked } = harness({ out: [SALVAGER_A] });

  await flow.salvageDrones([SALVAGER_A], null);

  const paths = asked.map((each) => each.path);
  const sent = paths.indexOf("/api/bridge/call");
  assert.ok(sent >= 0 && paths.indexOf("/api/bridge/drones", sent) > sent, "the drones are read after the order, not before");
  assert.deepEqual((store.drones.get().inSpace ?? []).map((drone) => drone.itemID), [SALVAGER_A]);
});

test("what the server says of a drone that could not is shown in its own words, by the drone's name", async () => {
  // The answer is the drones that could not, each with why: a CustomNotify with the sentence.
  const sentence = "No salvageable wreck owned by you or a fleet member is available.";
  const answer = { type: "dict", entries: [[SALVAGER_B, ["CustomNotify", { type: "dict", entries: [["notify", sentence]] }]]] };
  const { store, flow } = harness({ answer });

  await flow.salvageDrones([SALVAGER_A, SALVAGER_B], null);

  const reports = store.drones.get().orderReports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.label, "Salvage Drone I");
  assert.match(String(reports[0]?.text), /No salvageable wreck/);
  assert.equal(store.drones.get().actionError, null);
});

test("an order the server refuses outright is said in its words, and nothing is read as done", async () => {
  const { store, flow, orders } = harness({ refusal: "ShipNotInSpace" });

  await flow.salvageDrones([SALVAGER_A], null);

  assert.equal(orders().length, 1);
  assert.match(String(store.drones.get().actionError), /^Salvage refused: /);
  assert.equal(store.drones.get().lastAction === "Salvage", false);
});

test("with no drones nothing is asked of the server, and nothing is said to have been ordered", async () => {
  const { store, flow, asked, orders } = harness();

  await flow.salvageDrones([], null);

  assert.deepEqual(orders(), []);
  assert.deepEqual(asked.map((each) => each.path), [], "not even the drones are read");
  assert.equal(store.drones.get().lastAction, null);
});

test("an order none of whose drones is still out says so", async () => {
  const { store, flow } = harness({ out: [] });

  await flow.salvageDrones([SALVAGER_A], null);

  assert.match(String(store.drones.get().silentDecline), /none of those drones are in space/);
});
