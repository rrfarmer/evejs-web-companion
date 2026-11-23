import assert from "node:assert/strict";
import test from "node:test";
import { decodeScriptValue, PROGRAM_DONE_PHASE } from "../../../web/src/plugin-api/index.ts";
import { createPilotSession, type PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { createNativeBeltNavigation } from "./nativeBelt.ts";
import { miningSystemTransitScript } from "./transitScript.ts";
import { FleetObservationUnavailable } from "./stopSignal.ts";
import manifest from "../plugin.ts";

const origin = 30003485;
const destination = 30003484;
const beltID = 7001;
const gateID = 7002;
const adjacentGateID = 7003;
const shipID = 11;
const characterID = 21;
const belt = { kind: "BELT" as const, systemID: destination, name: "Sibot I - Asteroid Belt 1" };
const claim = { key: `BELT:${destination}:${belt.name}`, operationID: "op", runID: "run", generation: 1, expiresAt: Infinity };

test("transit uses a stock script with the assigned system and adds nothing to the palette", () => {
  const decoded = decodeScriptValue(miningSystemTransitScript(destination));
  assert.equal(decoded.ok, true);
  assert.deepEqual(manifest.macros ?? [], []);
  const step = decoded.ok && decoded.doc.program[0];
  assert.ok(step && step.kind === "macro");
  assert.equal(step.macro, "travel-to-system");
  assert.deepEqual(step.args.system, { kind: "system", ref: { entity: "system", id: destination, name: null, systemName: null } });
});

for (const arrived of [true, false]) test(arrived
  ? "MCC continues on the confirmed belt after the transit script deadline"
  : "MCC retries an unconfirmed transit on a later pass without replaying this route", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let system = origin;
  const calls: string[] = [];
  let markSubscribed!: () => void;
  const subscribed = new Promise<void>(resolve => { markSubscribed = resolve; });
  const position = { x: 0, y: 0, z: 0 };
  const transition = { phase: "ready", sessionStable: true, locationReady: true, sceneReady: true,
    egoReady: true, shipReady: true, boundContextReady: true };
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/bridge/flight/status") {
      calls.push("flight");
      return Response.json({ ok: true, flight: { inSpace: true, docked: false, shipID, shipMode: "STOP",
        solarSystemID: system, transition } });
    }
    assert.equal(path, "/api/bridge/space/snapshot");
    calls.push("grid");
    return Response.json({ ok: true, space: { inSpace: true, stateValid: true, solarSystemID: system, shipID,
      sampledAtMs: Date.now(), ship: { itemID: shipID, characterID, mode: "STOP", position, radius: 10 },
      entities: [{ itemID: beltID, groupID: 9, kind: "celestial", position, radius: 10 }] } });
  };
  const session = {
    flow: {
      requestOptions: () => ({}),
      flying: {},
      async startCustomBot() { calls.push("start"); if (arrived) system = destination; },
      async cancelHostedHome() { calls.push("cancel"); },
      stopCustomBot() { calls.push("stop"); },
    },
    store: {
      station: { get: () => ({ online: { characterID } }) },
      travel: { get: () => ({}), subscribe: () => () => {} },
      customBot: { subscribe: () => { markSubscribed(); return () => {}; } },
    },
  } as unknown as PilotSession;
  const nav = createNativeBeltNavigation({ baseUrl: "http://fixture.invalid", fetch: fetcher, characterID }, session,
    { shipID, beltID, timeoutMs: 100, current() {} });
  const work = nav.navigate(belt, claim, () => { calls.push("arrived"); });
  const outcome = arrived ? work : assert.rejects(work, FleetObservationUnavailable);
  await subscribed;
  t.mock.timers.tick(100);
  await outcome;
  assert.deepEqual(calls, arrived
    ? ["flight", "start", "cancel", "stop", "flight", "grid", "flight", "arrived"]
    : ["flight", "start", "cancel", "stop", "flight"]);
});

for (const reachable of [true, false]) test(reachable
  ? "MCC transit issues a gate jump through the real WC runner on the existing session"
  : "MCC transit reports a refused route from the WC runner and retires it", async () => {
  let system = origin;
  const calls: string[] = [];
  const jumps: unknown[] = [];
  const phase = { phase: "ready", sessionStable: true, locationReady: true, sceneReady: true, egoReady: true, shipReady: true, boundContextReady: true };
  const position = { x: 0, y: 0, z: 0 };
  const flight = () => ({ inSpace: true, docked: false, shipID, shipMode: "STOP", solarSystemID: system, transition: phase });
  const grid = () => ({ inSpace: true, solarSystemID: system, shipID, stateValid: true, sampledAtMs: Date.now(),
    ship: { itemID: shipID, characterID, mode: "STOP", position, radius: 10, hullRatio: 1, shieldRatio: 1, armorRatio: 1 },
    entities: system === origin
      ? [{ itemID: gateID, kind: "celestial", groupID: 10, name: "Stargate", position, radius: 10 }]
      : [{ itemID: beltID, kind: "celestial", groupID: 9, name: belt.name, position, radius: 10 }],
  });
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    switch (path) {
      case "/api/bridge/flight/status": return Response.json({ ok: true, flight: flight() });
      case "/api/bridge/space/snapshot": return Response.json({ ok: true, space: grid() });
      case "/api/bridge/script/observation": return Response.json({ ok: true, space: grid(), bay: [], inSpace: [], activeShipID: shipID });
      case "/api/bridge/fitting": return Response.json({ ok: true, activeShipID: shipID, slots: [], errors: {} });
      case "/api/bridge/targets": return Response.json({ ok: true, targetIDs: [], targeterIDs: [] });
      case "/api/bridge/ship/ore-hold": return Response.json({ ok: true, activeShipID: shipID, holds: [] });
      case "/api/map/graph": return Response.json({ ok: true, systems: { [origin]: "Origin", [destination]: "Destination" },
        security: { [origin]: 0.7, [destination]: 0.7 },
        edges: reachable ? [[origin, destination, gateID, adjacentGateID], [destination, origin, adjacentGateID, gateID]] : [] });
      case `/api/map/resolve/${destination}`: return Response.json({ ok: true, kind: "system", solarSystemID: destination });
      case "/api/bridge/call": {
        const call = JSON.parse(String(init?.body));
        if (call.method === "CmdStargateJump") {
          jumps.push(call.args);
          system = destination;
        }
        return Response.json({ ok: true, service: call.service, method: call.method, result: null, notifications: [] });
      }
      default: return Response.json({ ok: false, error: "UNAVAILABLE_IN_FIXTURE" }, { status: 404 });
    }
  };
  const run = { baseUrl: "http://fixture.invalid", fetch: fetcher, routeSettings: null,
    held: { characterID, character: { characterID, characterName: "Test pilot", stationID: null, structureID: null,
      solarSystemID: origin, corporationID: null }, station: null } };
  const session = await createPilotSession(run);
  session.flow.setLivePush(false);
  let finished = false;
  const unsubscribe = session.store.customBot.subscribe(progress => { finished ||= progress.phase === PROGRAM_DONE_PHASE; });
  let departures = 0;
  const nav = createNativeBeltNavigation({ ...run, characterID }, session, { shipID, beltID,
    timeoutMs: 14_000, current() {}, beforeDeparture: async () => { departures++; } });
  try {
    if (reachable) await nav.navigate(belt, claim);
    else await assert.rejects(nav.navigate(belt, claim), /No gate route from Origin/);
    assert.deepEqual(jumps, reachable ? [[gateID, adjacentGateID, shipID]] : []);
    assert.equal(departures, 1);
    assert.equal(finished, reachable);
    assert.equal(session.store.customBot.get().status, "stopped");
    assert.equal(calls.some(path => path.startsWith("/api/botscripts") || path === "/api/bots/start" || path === "/api/bridge/select"), false);
  } finally {
    unsubscribe();
    session.flow.stopCustomBot();
  }
});
