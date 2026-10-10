// A ship sent to a point from the page, through the real flow over a faked BFF.
//
// It is the client's own call (bridge/movementWrites.ts): beyonce's CmdGotoPoint with the point's three, as a
// pilot's write the page means, and never the route it went by until 2026-10-10. What the route checked of the
// ship and the system, the page checks of its own read of the pilot's flight.
//
// Its askers are a mining support ship's positioning and the fleet-mine block of a script bot. Neither is reached
// here: each hands the flow's flyToPoint the point and the ship and system it was measured in.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { flightBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const POINT = { x: 0, y: -20, z: 30.5 };
const THE_CALL = { service: "beyonce", method: "CmdGotoPoint", args: [0, -20, 30.5], kwargs: null, pilot: true, confirm: true };

/** A flow for a pilot online, over a BFF whose word for the pilot's flight is `flight`. */
function harness(flight: unknown = flightBody(false), refusal: string | null = null) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  const asked: { readonly path: string; readonly body: unknown; readonly token: string | null }[] = [];
  const made = createAppFlow(store, { livePush: false, perSessionToken: true, initialSessionToken: "pilot", fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({ path, body, token: new Headers(init?.headers).get("authorization") });
    if (path === "/api/bridge/flight/status") return Response.json(flight);
    if (path === "/api/bridge/call" && refusal !== null) return Response.json({ ok: false, error: "CALL_REFUSED", message: refusal }, { status: 409 });
    if (path === "/api/bridge/call") return Response.json({ ok: true, service: body.service, method: body.method, result: null, notifications: [] });
    return Response.json({ ok: true });
  } });
  const paths = () => asked.map((each) => each.path);
  return { flow: made, asked, paths };
}

test("the ship is sent by the page's own call, with the pilot's own token, once its flight has been read", async () => {
  const { flow, asked } = harness();

  await flow.flyToPoint(POINT, SHIP_ID, SOLAR_SYSTEM_ID);

  assert.deepEqual(asked, [
    { path: "/api/bridge/flight/status", body: null, token: "Bearer pilot" },
    { path: "/api/bridge/call", body: THE_CALL, token: "Bearer pilot" },
  ]);
});

test("the route is not asked", async () => {
  const { flow, paths } = harness();

  await flow.flyToPoint(POINT, SHIP_ID, SOLAR_SYSTEM_ID);

  assert.equal(paths().includes("/api/bridge/flight/goto-point"), false);
});

test("a point measured for another ship, or in another system, is not flown to: the flight is read and nothing is sent", async () => {
  for (const [shipID, solarSystemID, words] of [[SHIP_ID + 1, SOLAR_SYSTEM_ID, /ship changed/], [SHIP_ID, SOLAR_SYSTEM_ID + 1, /system changed/]] as const) {
    const { flow, paths } = harness();
    await assert.rejects(flow.flyToPoint(POINT, shipID, solarSystemID), words);
    assert.deepEqual(paths(), ["/api/bridge/flight/status"]);
  }
});

test("docked, nothing is sent", async () => {
  const { flow, paths } = harness(flightBody(true));

  await assert.rejects(flow.flyToPoint(POINT, SHIP_ID, SOLAR_SYSTEM_ID), /not in space/);
  assert.deepEqual(paths(), ["/api/bridge/flight/status"]);
});

test("invalid geometry never leaves the page", async () => {
  const { flow, paths } = harness();

  await assert.rejects(flow.flyToPoint({ x: Number.NaN, y: 0, z: 0 }, SHIP_ID, SOLAR_SYSTEM_ID), /Unknown movement geometry or scope/);
  assert.deepEqual(paths(), []);
});

test("a refusal of the call is the caller's to hear", async () => {
  const { flow, paths } = harness(flightBody(false), "You are warping.");

  await assert.rejects(flow.flyToPoint(POINT, SHIP_ID, SOLAR_SYSTEM_ID), /You are warping\./);
  assert.deepEqual(paths(), ["/api/bridge/flight/status", "/api/bridge/call"]);
});
