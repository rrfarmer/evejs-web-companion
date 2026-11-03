// The R5b Travel flow against a faked BFF: startRoute loads the client-side
// route graph, reads the origin from flight-status, resolves the destination,
// solves the route, applies travel/planned, and launches the decide-loop.
// Unreachable/unknown destinations surface a plan error (not a throw). Abort
// stops the loop. The decide-loop's own atomic sequencing is covered
// exhaustively in nav/autopilotLoop.test.ts; here we cover the flow wiring.

import test from "node:test";
import assert from "node:assert/strict";

import { createRequire } from "node:module";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const { createPilotRouteSettings } = createRequire(import.meta.url)("../../../src/pilotRouteSettings.js");

// A 3-system line: Alpha(1) <-> Bravo(2) <-> Charlie(3). The origin is Alpha
// (from flight-status), the destination station 60000003 is in Charlie.
// The systems are numbered as known space is, and each has a security: the route is the client's
// autopilot's, which plots only through known space and goes by security (nav/autopilotRoute.ts).
const ALPHA = 30000001;
const BRAVO = 30000002;
const CHARLIE = 30000003;
const GRAPH = {
  ok: true,
  systems: { [ALPHA]: "Alpha", [BRAVO]: "Bravo", [CHARLIE]: "Charlie" },
  security: { [ALPHA]: 1, [BRAVO]: 0.9, [CHARLIE]: 0.8 },
  edges: [
    [ALPHA, BRAVO, 112, 211],
    [BRAVO, ALPHA, 211, 112],
    [BRAVO, CHARLIE, 223, 322],
    [CHARLIE, BRAVO, 322, 223],
  ],
};
const DOCKED_ALPHA = {
  inSpace: false,
  docked: true,
  solarSystemID: ALPHA,
  stationID: 60000001,
  structureID: null,
  shipID: 9001,
  shipMode: null,
  shipSpeedFraction: null,
};

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
}

// A permissive responder: the graph, resolve, flight-status, and movement
// endpoints all answer so the background loop's ticks are harmless.
function defaultResponder(path: string): { status: number; body: unknown } {
  if (path === "/api/map/graph") {
    return { status: 200, body: GRAPH };
  }
  if (path.startsWith("/api/map/resolve/")) {
    const id = Number(path.split("/").pop());
    if (id === 60000001) {
      return { status: 200, body: { ok: true, id, kind: "station", stationID: id,
        stationName: "Alpha Station", solarSystemID: ALPHA, systemName: "Alpha" } };
    }
    if (id === 60000003) {
      return { status: 200, body: { ok: true, id, kind: "station", stationID: id, stationName: "Charlie Station", solarSystemID: CHARLIE, systemName: "Charlie" } };
    }
    if (id === 99999999) {
      return { status: 200, body: { ok: true, id, kind: "unknown", solarSystemID: null } };
    }
    return { status: 200, body: { ok: true, id, kind: "system", solarSystemID: id, systemName: `System ${id}` } };
  }
  if (path === "/api/bridge/flight/status") {
    return { status: 200, body: { ok: true, flight: DOCKED_ALPHA, notifications: [] } };
  }
  if (path.startsWith("/api/dockable-structures/find?")) {
    return { status: 200, body: { ok: true, matches: [] } };
  }
  if (path.startsWith("/api/bridge/flight/")) {
    return { status: 200, body: { ok: true, result: null, flight: DOCKED_ALPHA, notifications: [] } };
  }
  throw new Error(`unexpected ${path}`);
}

test("startRoute solves a multi-hop route and applies travel/planned", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  const outcome = await flow.startRoute(60000003); // station in Charlie(3)
  flow.abortRoute(); // stop the background loop

  assert.equal(outcome.started, true, "a plan that reached the autopilot reports started");
  const travel = store.travel.get();
  assert.equal(travel.destinationSystemID, CHARLIE);
  assert.equal(travel.destinationStationID, 60000003);
  assert.equal(travel.destinationName, "Charlie Station");
  assert.equal(travel.totalJumps, 2);
  assert.deepEqual(
    travel.route.map((h) => [h.fromSystemID, h.toSystemID, h.gateToWarpID, h.jumpToGateID]),
    [
      [ALPHA, BRAVO, 112, 211],
      [BRAVO, CHARLIE, 223, 322],
    ],
  );
  assert.equal(travel.route[0]?.fromSystemName, "Alpha");
  assert.equal(travel.route[1]?.toSystemName, "Charlie");
});

test("accessible structure routes through its authoritative system and access loss blocks departure", async () => {
  const structureID = 1030000000002;
  const paths: string[] = [];
  let access = true;
  const responder = (path: string) => {
    paths.push(path);
    if (path === `/api/map/resolve/${structureID}`) {
      return { status: 200, body: { ok: true, id: structureID, kind: "structure", structureID,
        solarSystemID: CHARLIE, systemName: "Charlie", structureName: "QA Astrahus" } };
    }
    if (path === `/api/dockable-structures/${structureID}`) {
      return access
        ? { status: 200, body: { ok: true, location: { kind: "structure", id: structureID,
          name: "QA Astrahus", solarSystemID: CHARLIE, solarSystemName: "Charlie" } } }
        : { status: 409, body: { ok: false, error: "STRUCTURE_DOCK_ACCESS_DENIED" } };
    }
    return defaultResponder(path);
  };
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });
  const first = await flow.startRoute(structureID);
  flow.abortRoute();
  assert.equal(first.started, true);
  assert.equal(store.travel.get().destinationStationID, structureID);
  assert.equal(store.travel.get().destinationSystemID, CHARLIE);
  assert.equal(store.travel.get().destinationName, "QA Astrahus");
  access = false;
  const second = await flow.startRoute(structureID);
  assert.equal(second.started, false);
  assert.match(second.started === false ? second.reason : "", /access/i);
  assert.equal(paths.filter((path) => path === `/api/dockable-structures/${structureID}`).length, 2);
});

test("startRoute to a same-system destination plans zero jumps", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  await flow.startRoute(ALPHA); // Alpha, our current system
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.totalJumps, 0);
  assert.equal(travel.destinationSystemID, ALPHA);
  assert.equal(travel.route.length, 0);
});

test("startRoute surfaces an unreachable destination as a plan error", async () => {
  const store = createClientStore();
  const responder = (path: string) => {
    if (path === "/api/map/resolve/30000050") {
      return { status: 200, body: { ok: true, id: 30000050, kind: "system", solarSystemID: 30000050, systemName: "Island" } };
    }
    return defaultResponder(path);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const outcome = await flow.startRoute(30000050); // a system in known space that the map has no jump to

  const travel = store.travel.get();
  assert.equal(travel.status, "idle");
  assert.match(travel.failureReason ?? "", /No gate route/i);
  // The failure is ALSO the return value — that is what the mission bot's
  // startTravel dep throws on, so a flight that never started is never booked.
  assert.equal(outcome.started, false);
  assert.match(outcome.started === false ? outcome.reason : "", /No gate route/i);
});

test("startRoute surfaces an unknown destination as a plan error", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  const outcome = await flow.startRoute(99999999);

  const travel = store.travel.get();
  assert.equal(travel.status, "idle");
  assert.match(travel.failureReason ?? "", /Unknown destination/i);
  assert.equal(outcome.started, false);
});

test("searchDestinations finds systems/stations by name, annotated with jumps (R7a)", async () => {
  const store = createClientStore();
  // The player is docked in Alpha(1), so jumps are measured from system 1.
  store.apply({
    type: "character/online",
    character: { characterID: 140000003, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 },
    station: null,
  });
  const responder = (path: string) => {
    if (path.startsWith("/api/map/find")) {
      return {
        status: 200,
        body: {
          ok: true,
          source: "static-data",
          q: "char",
          kind: null,
          total: 2,
          capped: false,
          matches: [
            { id: CHARLIE, name: "Charlie", kind: "system", solarSystemID: CHARLIE, solarSystemName: "Charlie" },
            { id: 60000003, name: "Charlie Station", kind: "station", solarSystemID: CHARLIE, solarSystemName: "Charlie" },
          ],
        },
      };
    }
    return defaultResponder(path);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const results = await flow.searchDestinations("char");

  assert.equal(results.length, 2);
  const system = results.find((r) => r.kind === "system");
  const station = results.find((r) => r.kind === "station");
  assert.equal(system?.id, CHARLIE);
  assert.equal(system?.solarSystemName, "Charlie");
  // Charlie is 2 jumps from Alpha over the 3-system line; both are in Charlie(3).
  assert.equal(system?.jumps, 2);
  assert.equal(station?.jumps, 2);
});

test("searchDestinations ignores a too-short query without a request", async () => {
  const store = createClientStore();
  const responder = (path: string) => {
    throw new Error(`unexpected ${path}`);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const results = await flow.searchDestinations("J");
  assert.equal(results.length, 0);
});

test("startRoute plans the route to a station (R7a)", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  // The autopilot hands its first waypoint to startRoute (a search result is Set as
  // the destination, nav/waypoints.ts). The station in Charlie(3) plans a 2-hop
  // route from Alpha(1).
  await flow.startRoute(60000003);
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.destinationStationID, 60000003);
  assert.equal(travel.totalJumps, 2);
});

test("abortRoute after start marks the travel state aborted", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  await flow.startRoute(60000003);
  flow.abortRoute();

  assert.equal(store.travel.get().status, "aborted");
});

// --- R24 slice B: the smart Dock command ------------------------------------

const IN_SPACE_ALPHA = {
  inSpace: true,
  docked: false,
  solarSystemID: ALPHA,
  stationID: null,
  structureID: null,
  shipID: 9001,
  shipMode: "STOP",
  shipSpeedFraction: 0,
};

/** The default responder, but with the ship in space rather than docked. */
function inSpaceResponder(path: string): { status: number; body: unknown } {
  if (path === "/api/bridge/flight/status") {
    return { status: 200, body: { ok: true, flight: IN_SPACE_ALPHA, notifications: [] } };
  }
  if (path === "/api/bridge/space/snapshot") {
    return { status: 200, body: { ok: true, space: null, notifications: [] } };
  }
  if (path.startsWith("/api/bridge/flight/")) {
    return { status: 200, body: { ok: true, result: null, flight: IN_SPACE_ALPHA, notifications: [] } };
  }
  // The page's own movement calls (a warp, an approach, a dock at a station: bridge/movementWrites.ts,
  // bridge/placeChanges.ts) go by the generic call, and answer 200 here too.
  if (path === "/api/bridge/call") {
    return { status: 200, body: { ok: true, result: null, notifications: [] } };
  }
  return defaultResponder(path);
}

test("dockAt hands the SAME decide-loop a zero-hop plan for the station (no second autopilot)", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(inSpaceResponder) });

  await flow.dockAt(60000001); // a station in Alpha, our current system
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.destinationStationID, 60000001, "the station is the destination");
  assert.equal(travel.destinationSystemID, ALPHA, "in the system we are already in");
  assert.equal(travel.totalJumps, 0);
  assert.equal(travel.route.length, 0, "no hops: Dock never routes between systems");
  // R7d — the readout carries a NAME, never the id.
  assert.equal(typeof travel.destinationName, "string");
});

test("dockAt never treats the Dock call's 200 as docked — arrival comes from flight status", async () => {
  // The confirmed hazard: `Handle_CmdDock` can return 200/null WITHOUT docking
  // (beyonceService.js:3031-3042 — WARP_LANDING_PENDING, STATION_NOT_FOUND,
  // SHIP_IMMOBILE, DOCKING_APPROACH_REQUIRED all reach the browser as ok:true).
  // Here EVERY movement call answers 200, and flight status keeps saying the
  // ship is in space. The loop must not reach "arrived".
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(inSpaceResponder) });

  await flow.dockAt(60000001);
  // Let the background loop take a few ticks against the lying server.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = store.travel.get().status;
  flow.abortRoute();

  assert.notEqual(status, "arrived", "a 200 from Dock is not proof the ship docked");
});

test("dockAt at the station you are already in says so instead of starting a loop", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) }); // docked at 60000001

  await flow.dockAt(60000001);

  assert.match(String(store.travel.get().failureReason), /already docked/i);
  assert.equal(store.travel.get().destinationStationID, null, "no plan was started");
});

test("dockAt refuses a non-station id with a reason, not a request", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch(() => {
      throw new Error("no request should be made");
    }),
  });

  await flow.dockAt(0);
  assert.match(String(store.travel.get().failureReason), /not a station/i);
});

// --- R30 slice A: nearbyGates ------------------------------------------------

test("nearbyGates reads the SAME cached graph the autopilot uses — no new server surface", async () => {
  const store = createClientStore();
  const paths: string[] = [];
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch((path) => {
      paths.push(path);
      return defaultResponder(path);
    }),
  });

  const fromBravo = await flow.nearbyGates(BRAVO);
  assert.deepEqual(fromBravo, [
    { gateID: 211, toSystemID: ALPHA, toSystemName: "Alpha", destinationGateID: 112 },
    { gateID: 223, toSystemID: CHARLIE, toSystemName: "Charlie", destinationGateID: 322 },
  ]);

  // The ONLY route it touches is the static map graph the route solver already
  // fetches. Nothing here is a game call, so it starts nothing.
  assert.deepEqual(paths, ["/api/map/graph"]);

  // Cached: a second system's gates cost no second fetch.
  const fromAlpha = await flow.nearbyGates(ALPHA);
  assert.equal(fromAlpha.length, 1);
  assert.equal(fromAlpha[0]?.toSystemName, "Bravo");
  assert.deepEqual(paths, ["/api/map/graph"], "the graph is fetched once, then cached");
});

test("nearbyGates answers a system with no gates, and an invalid one, without a request", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  assert.deepEqual(await flow.nearbyGates(0), [], "an unknown system asks nothing");
  assert.deepEqual(await flow.nearbyGates(-7), []);
  // A system the graph does not reach is empty, not an error.
  assert.deepEqual(await flow.nearbyGates(4242), []);
});

test("nearbyGates surfaces a failed graph read instead of pretending there are no gates", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch((path) => {
      if (path === "/api/map/graph") {
        return { status: 500, body: { ok: false, error: "map unavailable" } };
      }
      throw new Error(`unexpected ${path}`);
    }),
  });

  // "No gates here" and "I could not read the star map" are different facts and
  // the panel renders them differently — so this must reject, not return [].
  await assert.rejects(() => flow.nearbyGates(BRAVO));
});

// --- the route is the client's autopilot's ----------------------------------

test("startRoute plots the way the client's autopilot does: the safe way, and round Jita, not the fewest jumps", async () => {
  // Alpha to Delta: two jumps through a low-security system, two through Jita, or three through safe ones.
  const DELTA = 30000004;
  const LOW = 30000006;
  const JITA = 30000142;
  const graph = {
    ok: true,
    systems: { [ALPHA]: "Alpha", [BRAVO]: "Bravo", [CHARLIE]: "Charlie", [DELTA]: "Delta", [LOW]: "Low", [JITA]: "Jita" },
    security: { [ALPHA]: 1, [BRAVO]: 0.9, [CHARLIE]: 0.8, [DELTA]: 0.7, [LOW]: 0.3, [JITA]: 0.9 },
    edges: [[ALPHA, LOW], [LOW, DELTA], [ALPHA, JITA], [JITA, DELTA], [ALPHA, BRAVO], [BRAVO, CHARLIE], [CHARLIE, DELTA]]
      .flatMap(([a, b], at) => [[a, b, 700 + at * 2, 701 + at * 2], [b, a, 701 + at * 2, 700 + at * 2]]),
  };
  const routeTo = async (destination: number) => {
    const store = createClientStore();
    const flow = createAppFlow(store, { fetch: makeFakeFetch((path) => (path === "/api/map/graph" ? { status: 200, body: graph } : defaultResponder(path))) });
    const outcome = await flow.startRoute(destination);
    const travel = store.travel.get();
    flow.abortRoute();
    return { outcome, systems: travel.route.map((hop) => hop.toSystemID), jumps: travel.totalJumps };
  };
  const toDelta = await routeTo(DELTA);
  assert.equal(toDelta.outcome.started, true, JSON.stringify(toDelta.outcome));
  assert.deepEqual(toDelta.systems, [BRAVO, CHARLIE, DELTA]);
  assert.equal(toDelta.jumps, 3);
  // Jita itself, and a low-security system, can be gone to.
  assert.deepEqual((await routeTo(JITA)).systems, [JITA]);
  assert.deepEqual((await routeTo(LOW)).systems, [LOW]);
});

// --- the autopilot's settings ------------------------------------------------

/** Alpha to Delta: two jumps through a low-security system, two through Jita, or three through safe ones. */
const SETTINGS_DELTA = 30000004;
const SETTINGS_LOW = 30000006;
const SETTINGS_JITA = 30000142;
const SETTINGS_GRAPH = {
  ok: true,
  systems: { [ALPHA]: "Alpha", [BRAVO]: "Bravo", [CHARLIE]: "Charlie", [SETTINGS_DELTA]: "Delta", [SETTINGS_LOW]: "Low", [SETTINGS_JITA]: "Jita" },
  security: { [ALPHA]: 1, [BRAVO]: 0.9, [CHARLIE]: 0.8, [SETTINGS_DELTA]: 0.7, [SETTINGS_LOW]: 0.3, [SETTINGS_JITA]: 0.9 },
  edges: [[ALPHA, SETTINGS_LOW], [SETTINGS_LOW, SETTINGS_DELTA], [ALPHA, SETTINGS_JITA], [SETTINGS_JITA, SETTINGS_DELTA], [ALPHA, BRAVO], [BRAVO, CHARLIE], [CHARLIE, SETTINGS_DELTA]]
    .flatMap(([a, b], at) => [[a, b, 700 + at * 2, 701 + at * 2], [b, a, 701 + at * 2, 700 + at * 2]]),
};
function settingsFlow(kept: Map<string, string> | null, characterID = 140000003) {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch((path) => (path === "/api/map/graph" ? { status: 200, body: SETTINGS_GRAPH } : defaultResponder(path))),
    storage: kept === null ? null : { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => { kept.set(key, value); } },
  });
  store.apply({ type: "character/online", character: { characterID, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 }, station: null });
  const wayTo = async (destination: number) => {
    await flow.startRoute(destination);
    const systems = store.travel.get().route.map((hop) => hop.toSystemID);
    flow.abortRoute();
    return systems;
  };
  return { store, flow, wayTo };
}

test("the route goes by the pilot's settings: shorter still goes round what is avoided, and with avoiding off through it", async () => {
  const { flow, wayTo } = settingsFlow(new Map());
  assert.deepEqual(flow.autopilotSettings(), {});
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [BRAVO, CHARLIE, SETTINGS_DELTA]);
  // Shorter: through low security, but not through Jita.
  assert.deepEqual(flow.setAutopilotRouteType("shortest"), { pfRouteType: "shortest" });
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);
  // Safer again, with avoiding off: through Jita. The first click on the tick leaves avoiding on.
  flow.setAutopilotRouteType("safe");
  assert.deepEqual(flow.clickAutopilotAvoidSystems(), { pfRouteType: "safe", pfAvoidSystems: true });
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [BRAVO, CHARLIE, SETTINGS_DELTA]);
  assert.deepEqual(flow.clickAutopilotAvoidSystems(), { pfRouteType: "safe", pfAvoidSystems: false });
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [SETTINGS_JITA, SETTINGS_DELTA]);
  // Less secure: the low-security way is the one inside its limits.
  flow.setAutopilotRouteType("unsafe");
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);
  // The penalty: at its least, one low-security system costs the safe route less than two more jumps.
  flow.setAutopilotRouteType("safe");
  flow.clickAutopilotAvoidSystems();
  assert.deepEqual(flow.setAutopilotPenalty(1), { pfRouteType: "safe", pfAvoidSystems: true, pfPenalty: 1 });
  assert.deepEqual(await wayTo(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);
});

test("the settings are kept for the character: another flow reads them back, and another character has its own", async () => {
  const kept = new Map<string, string>();
  const first = settingsFlow(kept);
  first.flow.setAutopilotRouteType("shortest");
  first.flow.setAutopilotPenalty(20);
  assert.deepEqual(JSON.parse(kept.get("evejs.autopilot.settings.140000003")!), { pfRouteType: "shortest", pfPenalty: 20 });

  const again = settingsFlow(kept);
  assert.deepEqual(again.flow.autopilotSettings(), { pfRouteType: "shortest", pfPenalty: 20 });
  assert.deepEqual(await again.wayTo(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);

  const other = settingsFlow(kept, 140000009);
  assert.deepEqual(other.flow.autopilotSettings(), {});
  assert.deepEqual(await other.wayTo(SETTINGS_DELTA), [BRAVO, CHARLIE, SETTINGS_DELTA]);
  other.flow.setAutopilotRouteType("unsafe");
  assert.deepEqual(again.flow.autopilotSettings(), { pfRouteType: "shortest", pfPenalty: 20 });
  assert.deepEqual(Object.keys(Object.fromEntries(kept)).sort(), ["evejs.autopilot.settings.140000003", "evejs.autopilot.settings.140000009"]);

  // With nowhere to keep them they last as long as the flow does.
  const unkept = settingsFlow(null);
  unkept.flow.setAutopilotRouteType("shortest");
  assert.deepEqual(unkept.flow.autopilotSettings(), { pfRouteType: "shortest" });
  assert.deepEqual(await unkept.wayTo(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);
});

test("a page's flow hands the pilot's route settings to the BFF as they change; a flow not told to share does not", async () => {
  const sent: unknown[] = [];
  const flowWith = (shareRouteSettings: boolean) => {
    const store = createClientStore();
    const flow = createAppFlow(store, {
      fetch: makeFakeFetch((path, method, body) => {
        if (path === "/api/pilot-route-settings" && method === "POST") {
          sent.push(body);
          return { status: 200, body: { ok: true } };
        }
        return path === "/api/map/graph" ? { status: 200, body: SETTINGS_GRAPH } : defaultResponder(path);
      }),
      storage: null,
      shareRouteSettings,
    });
    store.apply({ type: "character/online", character: { characterID: 90000001, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 }, station: null });
    return flow;
  };
  flowWith(false).setAutopilotRouteType("shortest");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, []);
  flowWith(true).setAutopilotRouteType("shortest");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ characterID: 90000001, settings: { pfRouteType: "shortest" } }]);
});

test("a hosted run plans by the route settings its pilot's page handed the BFF", async () => {
  // As the bot host builds it: the BFF's store, answering with what the page sent (src/pilotRouteSettings.js).
  const shared = createPilotRouteSettings();
  const hosted = (characterID: number) => {
    const store = createClientStore();
    const flow = createAppFlow(store, {
      fetch: makeFakeFetch((path) => (path === "/api/map/graph" ? { status: 200, body: SETTINGS_GRAPH } : defaultResponder(path))),
      storage: shared.storageFor(characterID),
    });
    store.apply({ type: "character/online", character: { characterID, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 }, station: null });
    return async (destination: number) => {
      await flow.startRoute(destination);
      const systems = store.travel.get().route.map((hop) => hop.toSystemID);
      flow.abortRoute();
      return systems;
    };
  };
  // Nothing handed over: "Prefer safer", round the low-security system.
  assert.deepEqual(await hosted(90000001)(SETTINGS_DELTA), [BRAVO, CHARLIE, SETTINGS_DELTA]);
  shared.set(90000001, { pfRouteType: "shortest" });
  assert.deepEqual(await hosted(90000001)(SETTINGS_DELTA), [SETTINGS_LOW, SETTINGS_DELTA]);
  // Another pilot's settings are its own.
  assert.deepEqual(await hosted(90000002)(SETTINGS_DELTA), [BRAVO, CHARLIE, SETTINGS_DELTA]);
});

test("the jumps worked out are by the settings too, and are forgotten when a setting changes or the pilot does", async () => {
  const kept = new Map<string, string>();
  const { store, flow } = settingsFlow(kept);
  const jumps = () => store.names.get().autopilotJumps;
  const worked = async () => {
    flow.requestAutopilotJumps(ALPHA, [SETTINGS_DELTA]);
    for (let waited = 0; waited < 200 && !(`${ALPHA}:${SETTINGS_DELTA}` in jumps()); waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    return jumps()[`${ALPHA}:${SETTINGS_DELTA}`];
  };
  assert.equal(await worked(), 3);
  flow.setAutopilotRouteType("shortest");
  assert.deepEqual(jumps(), {});
  assert.equal(await worked(), 2);
  flow.setAutopilotPenalty(30);
  assert.deepEqual(jumps(), {});
  assert.equal(await worked(), 2);
  flow.clickAutopilotAvoidSystems();
  assert.deepEqual(jumps(), {});
  // Another pilot at the helm, with nothing set: the last one's counts are not kept for it.
  assert.equal(await worked(), 2);
  store.apply({ type: "character/online", character: { characterID: 140000009, characterName: "Other", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 }, station: null });
  assert.equal(await worked(), 3);
  assert.deepEqual(flow.autopilotSettings(), {});
});

// --- jumps in the search's results are the autopilot's ----------------------

test("a searched place's jumps are the autopilot's with the pilot's settings, as the client's own search counts them", async () => {
  const store = createClientStore();
  store.apply({ type: "character/online", character: { characterID: 140000003, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: ALPHA, corporationID: 98000000 }, station: null });
  const found = { ok: true, query: "de", total: 2, capped: false, matches: [
    { id: SETTINGS_DELTA, name: "Delta", kind: "system", solarSystemID: SETTINGS_DELTA, solarSystemName: "Delta" },
    { id: SETTINGS_JITA, name: "Jita", kind: "system", solarSystemID: SETTINGS_JITA, solarSystemName: "Jita" },
  ] };
  const flow = createAppFlow(store, {
    storage: null,
    fetch: makeFakeFetch((path) => {
      if (path === "/api/map/graph") return { status: 200, body: SETTINGS_GRAPH };
      if (path.startsWith("/api/map/find")) return { status: 200, body: found };
      return defaultResponder(path);
    }),
  });
  const jumps = async () => Object.fromEntries((await flow.searchDestinations("de", "system")).map((match) => [match.name, match.jumps]));
  // Round the low-security system and round Jita to Delta; into Jita itself in one.
  assert.deepEqual(await jumps(), { Delta: 3, Jita: 1 });
  flow.setAutopilotRouteType("shortest");
  assert.deepEqual(await jumps(), { Delta: 2, Jita: 1 });
});
