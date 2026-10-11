// A colony's network changed from the page, through the real flow over a faked BFF.
//
// It is the client's own call (bridge/planetWrites.ts): the planet manager's UserUpdateNetwork, on the planet's own
// object, which the call names with `of`; as a pilot's write the page means, and never the route it went by until
// 2026-10-10. A restart is made as the client makes one (bridge/extractorRestart.ts): the planet asked what the
// programme will yield, and then one change.
//
// Its askers are two rungs of a script bot's planet upkeep. Neither is reached here: each hands the flow's own
// function what it is to change.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const PLANET = 40176368;
const [ECU, PAD] = [1054656331536, 1054656331535];
const HEADS = [[0, 1.225, 1.225]];

/** The BFF's read of the pilot's colonies: the one, of an extractor with a programme and a route to a launchpad. */
const planets = (pins: unknown[] | null = null) => ({ ok: true, serverNowMs: Date.now(), coloniesReadable: true, colonies: [{
  // (Another colony of the pilot's, read first: the restart is planned from the one on the planet named.)
  planetID: PLANET + 1, planetName: "Muvolailen II", solarSystemID: 30002780, commandCenterLevel: 0, pins: [], links: [], routes: [],
}, {
  planetID: PLANET, planetName: "Muvolailen I", solarSystemID: 30002780, commandCenterLevel: 2,
  pins: pins ?? [
    { pinID: ECU, typeID: 2848, kind: "extractor-control", contents: [], program: { resourceTypeID: 2267, cycleTimeSeconds: 900, quantityPerCycle: 471, headCount: 1, headRadius: 0.01, maxOutputPerCycle: 847, heads: HEADS, noiseFactor: 0.8 } },
    { pinID: PAD, typeID: 2544, kind: "launchpad", contents: [] },
  ],
  links: [{ endpoint1: PAD, endpoint2: ECU, level: 0 }],
  routes: [{ routeID: 20, path: [ECU, PAD], commodityTypeID: 2267, commodityQuantity: 471 }],
}] });

/** A flow for a pilot online, over a BFF that has the colony, answers the yield, and takes a change or refuses `refused`. */
function harness(options: { readonly refused?: string; readonly message?: string; readonly colonies?: unknown } = {}) {
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
    if (path === "/api/bridge/planets") return Response.json(options.colonies ?? planets());
    if (path === "/api/bridge/call" && body.method === options.refused) return Response.json({ ok: false, error: "CALL_REFUSED", message: options.message }, { status: 409 });
    if (path === "/api/bridge/call" && body.method === "GetProgramResultInfo") return Response.json({ ok: true, service: body.service, method: body.method, result: [477, 9000000000, 4], notifications: [] });
    if (path === "/api/bridge/call") return Response.json({ ok: true, service: body.service, method: body.method, result: null, notifications: [] });
    return Response.json({ ok: true });
  } });
  return { flow: made, asked };
}

const theRead = { service: "planetMgr", method: "GetProgramResultInfo", args: [ECU, 2267, HEADS, 0.01], kwargs: null, pilot: true, of: PLANET };
const theChange = (changes: unknown) => ({ service: "planetMgr", method: "UserUpdateNetwork", args: [changes], kwargs: null, pilot: true, confirm: true, of: PLANET });

test("an extractor is restarted as the client restarts one: the colony read, the planet asked the yield, and ONE change", async () => {
  const { flow, asked } = harness();

  await flow.restartExtractor(PLANET, ECU, 2267, 0.01);

  assert.deepEqual(asked, [
    { path: "/api/bridge/planets", body: null, token: "Bearer pilot" },
    // A read on the planet's object: a pilot's, and no write.
    { path: "/api/bridge/call", body: theRead, token: "Bearer pilot" },
    // 477 a cycle is 858 at the most: the route taken off, the programme, and the route made anew for it.
    { path: "/api/bridge/call", body: theChange([[7, [20]], [13, [ECU, 2267, 0.01]], [6, [[2, 1], [ECU, PAD], 2267, 858]]]), token: "Bearer pilot" },
  ]);
});

test("an extractor's routes are made anew by the page's own call, in one change", async () => {
  const { flow, asked } = harness();

  await flow.rerouteExtractor(PLANET, [1620230403], [{ path: [ECU, PAD], typeID: 2267, quantity: 3000 }]);

  assert.deepEqual(asked, [{ path: "/api/bridge/call", body: theChange([[7, [1620230403]], [6, [[2, 1], [ECU, PAD], 2267, 3000]]]), token: "Bearer pilot" }]);
});

test("the route is not asked", async () => {
  const { flow, asked } = harness();

  await flow.restartExtractor(PLANET, ECU, 2267, 0.01);
  await flow.rerouteExtractor(PLANET, [5], []);

  assert.equal(asked.some((each) => each.path === "/api/bridge/planet/network/update"), false);
  assert.deepEqual(asked.map((each) => each.path), ["/api/bridge/planets", "/api/bridge/call", "/api/bridge/call", "/api/bridge/call"]);
});

test("a planet that will not say the yield has nothing changed", async () => {
  const { flow, asked } = harness({ refused: "GetProgramResultInfo", message: "CannotManagePlanetWithoutCommandCenter" });

  await assert.rejects(flow.restartExtractor(PLANET, ECU, 2267, 0.01), /CannotManagePlanetWithoutCommandCenter/);
  assert.equal(asked.some((each) => (each.body as { method?: string } | null)?.method === "UserUpdateNetwork"), false);
});

test("a refusal of the change is the caller's to hear", async () => {
  const { flow } = harness({ refused: "UserUpdateNetwork", message: "CantInstallProgramNeedsCooldown" });

  await assert.rejects(flow.restartExtractor(PLANET, ECU, 2267, 0.01), /CantInstallProgramNeedsCooldown/);
});

test("a colony the BFF does not read is not restarted on a guess: nothing is asked of the planet", async () => {
  const { flow, asked } = harness({ colonies: { ok: true, serverNowMs: Date.now(), coloniesReadable: false, colonies: [] } });

  await assert.rejects(flow.restartExtractor(PLANET, ECU, 2267, 0.01), /colony/);
  assert.deepEqual(asked.map((each) => each.path), ["/api/bridge/planets"]);
});

test("what is no planet never leaves the page", async () => {
  const { flow, asked } = harness();

  await assert.rejects(flow.restartExtractor(0, ECU, 2267, 0.01), /A positive planetID is required/);
  await assert.rejects(flow.rerouteExtractor(0, [5], []), /A positive planetID is required/);
  assert.deepEqual(asked, []);
});
