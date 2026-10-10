// A colony's network changed from the page, through the real flow over a faked BFF.
//
// It is the client's own call (bridge/planetWrites.ts): the planet manager's UserUpdateNetwork, on the planet's own
// object, which the call names with `of`; as a pilot's write the page means, and never the route it went by until
// 2026-10-10.
//
// Its askers are two rungs of a script bot's planet upkeep. Neither is reached here: each hands the flow's own
// function what it is to change.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const PLANET = 40176368;
const [ECU, STORE] = [1054656331535, 1054656331531];

/** A flow for a pilot online, over a BFF that answers a change with the colony, or refuses it. */
function harness(refusal: string | null = null) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000002, characterName: "Test", stationID: 60000358,
    structureID: null, solarSystemID: 30002780, corporationID: 98000000,
  }, station: null });
  const asked: { readonly path: string; readonly body: unknown; readonly token: string | null }[] = [];
  const made = createAppFlow(store, { livePush: false, perSessionToken: true, initialSessionToken: "pilot", fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({ path, body, token: new Headers(init?.headers).get("authorization") });
    if (path === "/api/bridge/call" && refusal !== null) return Response.json({ ok: false, error: "CALL_REFUSED", message: refusal }, { status: 409 });
    if (path === "/api/bridge/call") return Response.json({ ok: true, service: body.service, method: body.method, result: null, notifications: [] });
    return Response.json({ ok: true });
  } });
  return { flow: made, asked };
}

const theCall = (changes: unknown) => ({ service: "planetMgr", method: "UserUpdateNetwork", args: [changes], kwargs: null, pilot: true, confirm: true, of: PLANET });

test("an extractor is restarted by the page's own call on the planet's object, with the pilot's own token", async () => {
  const { flow, asked } = harness();

  await flow.restartExtractor(PLANET, ECU, 2267, 0.0101);

  assert.deepEqual(asked, [{ path: "/api/bridge/call", body: theCall([[13, [ECU, 2267, 0.0101]]]), token: "Bearer pilot" }]);
});

test("an extractor's routes are made anew by the page's own call, in one change", async () => {
  const { flow, asked } = harness();

  await flow.rerouteExtractor(PLANET, [1620230403], [{ path: [ECU, STORE], typeID: 2267, quantity: 3000 }]);

  assert.deepEqual(asked, [{ path: "/api/bridge/call", body: theCall([[7, [1620230403]], [6, [[2, 1], [ECU, STORE], 2267, 3000]]]), token: "Bearer pilot" }]);
});

test("the route is not asked", async () => {
  const { flow, asked } = harness();

  await flow.restartExtractor(PLANET, ECU, 2267, 0.0101);
  await flow.rerouteExtractor(PLANET, [5], []);

  assert.equal(asked.some((each) => each.path === "/api/bridge/planet/network/update"), false);
  assert.equal(asked.length, 2);
});

test("a refusal of the change is the caller's to hear", async () => {
  const { flow } = harness("Cannot install a program with a completely bonkers radius");

  await assert.rejects(flow.restartExtractor(PLANET, ECU, 2267, 5), /completely bonkers radius/);
});

test("what is no planet never leaves the page", async () => {
  const { flow, asked } = harness();

  await assert.rejects(flow.restartExtractor(0, ECU, 2267, 0.0101), /A positive planetID is required/);
  assert.deepEqual(asked, []);
});
