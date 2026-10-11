// A ship aligned from the page, through the real flow over a faked BFF.
//
// It is the client's own call (bridge/movementWrites.ts): beyonce's CmdAlignTo with the thing by name and no
// bookmark, as a pilot's write the page means, and never the route it went by until 2026-10-11. The route read the
// pilot's flight before its order, to refuse a pilot that is docked, and after it, for the panel to show. The page
// reads both itself.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { flightBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const THING = 40009089;
const THE_CALL = { service: "beyonce", method: "CmdAlignTo", args: [], kwargs: { dstID: THING, bookmarkID: null }, pilot: true, confirm: true };
const STATUS = "/api/bridge/flight/status";

type Answer = { readonly status: number; readonly body: unknown };
/** The pilot's flight in space, its ship flying as said. */
const flying = (shipMode: string): Answer => {
  const body = flightBody(false) as { flight: Record<string, unknown> };
  return { status: 200, body: { ...body, flight: { ...body.flight, shipMode } } };
};
const TAKEN: Answer = { status: 200, body: { ok: true, service: "beyonce", method: "CmdAlignTo", result: null, notifications: [] } };

/**
 * A flow for a pilot online, over a BFF that answers each reading of the pilot's flight with the next of
 * `flights` (and every one after them with the last), and the align with `align`.
 */
function harness(flights: readonly Answer[], align: Answer = TAKEN) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  const asked: { readonly path: string; readonly body: unknown }[] = [];
  let read = 0;
  const flow = createAppFlow(store, { livePush: false, perSessionToken: true, initialSessionToken: "pilot", fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({ path, body });
    if (path === STATUS) {
      const answer = flights[Math.min(read, flights.length - 1)];
      if (answer === undefined) throw new Error("the stand-in has no flight to answer with");
      read += 1;
      return Response.json(answer.body, { status: answer.status });
    }
    if (path === "/api/bridge/call" && body.service === "beyonce") return Response.json(align.body, { status: align.status });
    if (path === "/api/bridge/call") return Response.json({ ok: true, service: body.service, method: body.method, result: null, notifications: [] });
    return Response.json({ ok: true });
  } });
  /** The readings of the flight and the orders to the ship, in the order they were asked. */
  const steps = () => asked.filter((each) => each.path === STATUS || each.path.startsWith("/api/bridge/flight/") ||
    (each.path === "/api/bridge/call" && (each.body as { service?: string }).service === "beyonce"));
  const panel = () => {
    const flight = store.flight.get();
    return [flight.lastAction, flight.actionError, flight.status?.shipMode ?? null];
  };
  return { flow, store, asked, steps, panel };
}

test("the panel's Align is the page's own call, between two readings of the pilot's flight, and the panel shows the flight read after", async () => {
  const { flow, steps, panel } = harness([flying("STOP"), flying("GOTO")]);

  await flow.alignTo(THING);

  assert.deepEqual(steps(), [{ path: STATUS, body: null }, { path: "/api/bridge/call", body: THE_CALL }, { path: STATUS, body: null }]);
  assert.deepEqual(panel(), ["Align", null, "GOTO"]);
});

test("the route is not asked", async () => {
  const { flow, asked } = harness([flying("STOP")]);

  await flow.alignTo(THING);

  assert.equal(asked.some((each) => each.path === "/api/bridge/flight/align"), false);
});

test("docked, nothing is sent, and the panel says why and shows the flight as it is", async () => {
  const { flow, steps, panel } = harness([{ status: 200, body: flightBody(true) }]);

  await flow.alignTo(THING);

  // The reading before, and the reading the panel makes after a refusal.
  assert.deepEqual(steps().map((each) => each.path), [STATUS, STATUS]);
  assert.deepEqual(panel(), [null, "Align refused: The ship is not in space; undock first.", null]);
});

test("the pilot's own ship, and what is no thing, are aligned to by no call", async () => {
  for (const [thing, words] of [[SHIP_ID, "Align refused: A ship cannot align to itself."], [0, "Align refused: That target could not be identified."]] as const) {
    const { flow, steps, panel } = harness([flying("STOP")]);

    await flow.alignTo(thing);

    assert.equal(steps().some((each) => each.path === "/api/bridge/call"), false, String(thing));
    assert.deepEqual(panel(), [null, words, "STOP"], String(thing));
  }
});

test("where the reading after fails, the one before stands: the order was taken, and the panel does not call it refused", async () => {
  const { flow, steps, panel } = harness([flying("STOP"), { status: 502, body: { ok: false, error: "GATEWAY_UNAVAILABLE", message: "The gateway did not answer." } }]);

  await flow.alignTo(THING);

  assert.deepEqual(steps().map((each) => each.path), [STATUS, "/api/bridge/call", STATUS]);
  assert.deepEqual(panel(), ["Align", null, "STOP"]);
});

test("a session lost at the reading after is a session lost, and the pilot is offline", async () => {
  const { flow, store } = harness([flying("STOP"), { status: 404, body: { ok: false, error: "SESSION_NOT_FOUND", message: "The session is gone." } }]);

  await assert.rejects(flow.alignTo(THING), (error: unknown) => (error as { code?: string }).code === "SESSION_NOT_FOUND");

  assert.equal(store.station.get().online, null);
});

test("an align the call refuses is shown as refused, in the refusal's own words, and the flight is read again", async () => {
  const { flow, steps, panel } = harness([flying("STOP"), flying("WARP")],
    { status: 409, body: { ok: false, error: "CALL_REFUSED", message: "The pilot has no ballpark to ask: it is not in space." } });

  await flow.alignTo(THING);

  assert.deepEqual(steps().map((each) => each.path), [STATUS, "/api/bridge/call", STATUS]);
  assert.deepEqual(panel(), [null, "Align refused: The pilot has no ballpark to ask: it is not in space.", "WARP"]);
});
