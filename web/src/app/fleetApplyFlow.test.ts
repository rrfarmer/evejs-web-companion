// A fleet applied to from the page, through the real flow over a faked BFF.
//
// The join-by-name block's deciding (nav/scriptMacros.test.ts) is tested with stand-ins for what it reads. What
// the flow does when the block says "apply to this fleet" was reached by no test: the application made, its
// answer kept for the block, and the invitation it mints accepted.
//
// The application is the page's own call (bridge/fleetWrites.ts), which is the client's fleet service's
// (fleetSvc.py 1907: sm.ProxySvc('fleetProxy').ApplyToJoinFleet(fleetID, autoAccept)), and never the route it
// went by until 2026-10-10.

import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, holdsBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const FLEET = 654500010000;
const script: BotScript = {
  format: "evejs-bot-script", version: 1, name: "Join the mining op", notes: "",
  home: { entity: "station", id: null, name: null, systemName: null },
  interrupts: [],
  program: [{ id: "join", kind: "macro", macro: "join-advertised-fleet", args: { fleetName: { kind: "text", text: "Mining Op" } } }],
};

const dict = (entries: readonly (readonly [unknown, unknown])[]): unknown => ({ type: "dict", entries });
const keyVal = (entries: readonly (readonly [string, unknown])[]): unknown => ({ type: "object", name: "util.KeyVal", args: dict(entries) });
const emptySet = { type: "objectex1", header: [{ type: "token", value: "__builtin__.set" }, [{ type: "list", items: [] }]], list: [], dict: [] };

/** fleetProxy.GetAvailableFleetAds as the route hands it on: a dict of adverts by fleet, of the one fleet here. */
const adverts = (): unknown => dict([[FLEET, dict(Object.entries({
  fleetID: FLEET,
  leader: keyVal([["charID", 140000001], ["corpID", 98000001], ["allianceID", null], ["warFactionID", null], ["securityStatus", 5]]),
  solarSystemID: SOLAR_SYSTEM_ID, numMembers: 3,
  advertTime: { type: "long", value: "133500000000000000" }, dateCreated: { type: "long", value: "133400000000000000" },
  fleetName: "Mining Op", description: "", inviteScope: 8, activityValue: null, useAdvanceOptions: false, newPlayerFriendly: false,
  public_minStanding: null, public_minSecurity: null, public_allowedEntities: emptySet, public_disallowedEntities: emptySet,
  membergroups_minStanding: null, membergroups_minSecurity: null, membergroups_allowedEntities: emptySet, membergroups_disallowedEntities: emptySet,
  joinNeedsApproval: false, hideInfo: false, updateOnBossChange: true, advertJoinLimit: null,
}))]]);

const FLEET_READS = ["GetInitState", "GetWings", "GetMotd", "GetJoinRequests", "GetFleetComposition"] as const;
/** The fleet's own reads for a pilot in none: each refused, as the server refuses them. */
const noFleet = (): unknown => ({ ok: true, characterID: 140000005, fleetID: null,
  reads: Object.fromEntries(FLEET_READS.map(name => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }])) });
/** And for a pilot in one. */
const inFleet = (): unknown => ({ ok: true, characterID: 140000005, fleetID: null, reads: {
  GetInitState: { result: keyVal([["motd", ""], ["fleetID", FLEET], ["members", dict([])], ["squads", dict([])], ["wings", dict([])]]) },
  GetWings: { result: dict([]) }, GetMotd: { result: "" }, GetJoinRequests: { result: dict([]) },
  GetFleetComposition: { result: { type: "list", items: [] } },
} });

/** A flow over a BFF that has the one fleet advertised, and answers an application with `answer`. */
function harness(answer: boolean) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  /** What was asked that matters here, in order. */
  const asked: string[] = [];
  const applications: Record<string, unknown>[] = [];
  const accepts: Record<string, unknown>[] = [];
  let joined = false;
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/flight/status") result = flightBody(false);
    if (path === "/api/bridge/fitting") result = fittingBody();
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/bridge/script/observation") result = { ok: true, inSpace: [], bay: [], space: {
      inSpace: true, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID, sampledAtMs: Date.now(),
      ship: { itemID: SHIP_ID, typeID: 17480, radius: 100, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mode: "STOP" },
      entities: [],
    } };
    if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
    if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
    if (path === "/api/bridge/bound-fleet") result = joined ? inFleet() : noFleet();
    if (path === "/api/bridge/fleet-ads") {
      asked.push("the finder read");
      result = { ok: true, availableFleetAds: adverts(), myFleetFinderAdvert: null, errors: { availableFleetAds: null, myFleetFinderAdvert: null } };
    }
    if (path === "/api/bridge/fleet/apply") asked.push("the route");
    if (path === "/api/bridge/call" && body.service === "fleetProxy" && body.method === "ApplyToJoinFleet") {
      asked.push("applied, by the page's own call");
      applications.push(body);
      result = { ok: true, service: "fleetProxy", method: "ApplyToJoinFleet", result: answer, notifications: [] };
    }
    if (path === "/api/bridge/fleet/invite/accept") {
      asked.push("the invitation accepted");
      accepts.push(body);
      joined = true;
    }
    return Response.json(result);
  } });
  return { store, flow, asked, applications, accepts };
}

/** fleetSvc.py 1907, with the pilot's yes already given (joinFleetConfirmation.py 25): as a pilot's, and as a write the page means. */
const THE_CALL = { service: "fleetProxy", method: "ApplyToJoinFleet", args: [FLEET, true], kwargs: null, pilot: true, confirm: true };

test("a bot joining a fleet by name applies by the page's own call, then accepts the invitation that answers", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, asked, applications, accepts } = harness(false);
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const unsubscribe = store.customBot.subscribe(state => {
    if (state.status === "stopped") resolveFinished();
  });
  try {
    await flow.startCustomBot(script);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let tick = 0; tick < 12 && store.customBot.get().status !== "stopped"; tick += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await finished;
    // The finder, then the application, then the invitation: never by the application's route.
    const order = asked.filter((each, at) => asked.indexOf(each) === at);
    assert.deepEqual(order, ["the finder read", "applied, by the page's own call", "the invitation accepted"]);
    assert.deepEqual(applications, [THE_CALL]);
    assert.equal(accepts[0]?.fleetID, FLEET);
  } finally {
    unsubscribe();
    flow.stopCustomBot();
  }
});

test("an application the fleet's boss has to approve is not followed by an acceptance: the answer is kept for the block", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, asked, applications, accepts } = harness(true);
  try {
    await flow.startCustomBot(script);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let tick = 0; tick < 8 && store.customBot.get().status !== "stopped"; tick += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(applications, [THE_CALL]);
    assert.deepEqual(accepts, []);
    assert.equal(asked.includes("the route"), false);
    // (That no invitation was accepted is what shows the answer was kept as the boss's to approve: an answer
    // read as an invitation, or not read, is followed by an acceptance. The block's own sentence for it is
    // not looked for here: a run with no home station to go to is held with that said instead.)
    assert.equal(store.customBot.get().status, "paused");
  } finally {
    flow.stopCustomBot();
  }
});

test("the flow's own application answers which half of the round trip it took", async () => {
  const invited = harness(false);
  assert.equal(await invited.flow.applyToJoinFleet(FLEET), "invited");
  assert.deepEqual(invited.applications, [THE_CALL]);
  assert.equal(invited.asked.includes("the route"), false);

  const waiting = harness(true);
  assert.equal(await waiting.flow.applyToJoinFleet(FLEET), "needs-approval");
  assert.deepEqual(waiting.applications, [THE_CALL]);
});
