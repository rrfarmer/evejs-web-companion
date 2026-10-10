// A launch collected by a bot, through the real flow over a faked BFF.
//
// The block's deciding (nav/scriptCollectLaunches.test.ts) is tested with stand-ins for what it reads. What the
// flow does when the block says "collect this launch" was reached by no test: the container emptied into the
// ship, read again, and the launch's record removed. This starts the bot and watches that.
//
// The record is removed by the page's own call (bridge/launchWrites.ts), which is the client's journal's Remove
// (journal.py 464), and never by the route it went by until 2026-10-10.

import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, holdsBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const CONTAINER = 1028000000002;
const LAUNCH = 500002;
const script: BotScript = {
  format: "evejs-bot-script", version: 1, name: "Collect launches", notes: "",
  home: { entity: "station", id: null, name: null, systemName: null },
  interrupts: [],
  program: [{ id: "launches", kind: "macro", macro: "collect-launches", args: {} }],
};

const LAUNCH_COLUMNS = [["launchID", 3], ["solarSystemID", 3], ["itemID", 20], ["ownerID", 3], ["planetID", 3], ["status", 17], ["launchTime", 64], ["x", 5], ["y", 5], ["z", 5]];
const LAUNCH_DESCRIPTOR = { type: "objectex1", header: [{ type: "token", value: "blue.DBRowDescriptor" }, [LAUNCH_COLUMNS]], list: [], dict: [] };
/** planetMgr.GetMyLaunchesDetails as the route hands it on: a CRowset, of one launch in this system or of none. */
const launchesOf = (listed: boolean): unknown => ({
  type: "objectex2",
  header: [[{ type: "token", value: "carbon.common.script.sys.crowset.CRowset" }], { type: "dict", entries: [["header", LAUNCH_DESCRIPTOR]] }],
  list: listed ? [{
    type: "packedrow", header: LAUNCH_DESCRIPTOR, columns: LAUNCH_COLUMNS,
    values: [LAUNCH, SOLAR_SYSTEM_ID, CONTAINER, 140000005, 40009077, 1, String(BigInt(Date.now()) * 10000n + 116444736000000000n), 1000, 0, 0],
  }] : [],
  dict: [],
});

test("a launch collected is emptied into the ship, read again, and only then has its record removed, by the page's own call", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  /** What the bot asked that matters here, in order. */
  const asked: string[] = [];
  const removals: Record<string, unknown>[] = [];
  let removed = false;
  let emptied = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const unsubscribe = store.customBot.subscribe(state => {
    if (state.status === "stopped") resolveFinished();
  });
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
      // The launch's container, on grid and inside loot range.
      entities: [{ itemID: CONTAINER, kind: "container", typeID: 2263, groupID: 1025, radius: 14, position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }],
    } };
    if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
    if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) result = { ok: true, shipID: SHIP_ID, bays: [
      { key: "cargo", label: "Cargo", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
      { key: "planetary", label: "Planetary", present: true, capacity: { capacity: 10000, used: 0 }, items: [], error: null },
    ] };
    // The launches: the one in this system, until its record has been removed.
    if (path === "/api/bridge/pi-colonies") result = { ok: true, colonies: [], launches: launchesOf(!removed), errors: {} };
    if (path === `/api/bridge/inventory/container/${CONTAINER}`) {
      asked.push(emptied ? "the container, empty" : "the container, with goods");
      result = { ok: true, containerID: CONTAINER, capacity: null, volumes: { "3645": 0.38 },
        list: { type: "list", items: emptied ? [] : [{ type: "packedrow", fields: { itemID: 90070, typeID: 3645, categoryID: 43, quantity: 70, singleton: 0 } }] } };
    }
    if (path === "/api/bridge/inventory/transfer") {
      asked.push("the goods moved");
      emptied = true;
      result = { ok: true, applied: true, moved: [90070], declined: [], notFound: [] };
    }
    if (path === "/api/bridge/planet/launch/delete") {
      asked.push("the route");
      removed = true;
    }
    if (path === "/api/bridge/call" && body.service === "planetMgr" && body.method === "DeleteLaunch") {
      asked.push("the launch's record removed");
      removals.push(body);
      removed = true;
      result = { ok: true, service: "planetMgr", method: "DeleteLaunch", result: true, notifications: [] };
    }
    return Response.json(result);
  } });
  try {
    await flow.startCustomBot(script);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let tick = 0; tick < 12 && store.customBot.get().status !== "stopped"; tick += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    }
    await finished;
    // The goods first, then the container seen empty, and only then the record: never by its route.
    const order = asked.filter((each, at) => asked.indexOf(each) === at);
    assert.deepEqual(order, ["the container, with goods", "the goods moved", "the container, empty", "the launch's record removed"]);
    // journal.py 464: sm.RemoteSvc('planetMgr').DeleteLaunch(launchID), as a pilot's and as a write the page means. Once.
    assert.deepEqual(removals, [{ service: "planetMgr", method: "DeleteLaunch", args: [LAUNCH], kwargs: null, pilot: true, confirm: true }]);
    assert.equal(store.customBot.get().status, "stopped");
  } finally {
    unsubscribe();
    flow.stopCustomBot();
  }
});

test("a launch whose goods did not all fit keeps its record: the container is not empty, and nothing is removed", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  const removals: string[] = [];
  let transfers = 0;
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
      entities: [{ itemID: CONTAINER, kind: "container", typeID: 2263, groupID: 1025, radius: 14, position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }],
    } };
    if (path === "/api/bridge/targets") result = { ok: true, targetIDs: [] };
    if (path === "/api/bridge/ship/ore-hold") result = holdsBody(0, []);
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) result = { ok: true, shipID: SHIP_ID, bays: [
      { key: "cargo", label: "Cargo", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
      { key: "planetary", label: "Planetary", present: true, capacity: { capacity: 10000, used: 0 }, items: [], error: null },
    ] };
    if (path === "/api/bridge/pi-colonies") result = { ok: true, colonies: [], launches: launchesOf(true), errors: {} };
    // One stack is moved and another is left behind: the container is never seen empty.
    if (path === `/api/bridge/inventory/container/${CONTAINER}`) {
      result = { ok: true, containerID: CONTAINER, capacity: null, volumes: { "3645": 0.38 },
        list: { type: "list", items: [{ type: "packedrow", fields: { itemID: 90071, typeID: 3645, categoryID: 43, quantity: 70, singleton: 0 } }] } };
    }
    if (path === "/api/bridge/inventory/transfer") {
      transfers += 1;
      result = { ok: true, applied: true, moved: [90071], declined: [], notFound: [] };
    }
    if (path === "/api/bridge/planet/launch/delete") removals.push("the route");
    if (path === "/api/bridge/call" && body.method === "DeleteLaunch") removals.push("the call");
    return Response.json(result);
  } });
  try {
    await flow.startCustomBot(script);
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let tick = 0; tick < 4; tick += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(transfers >= 1, "the goods were asked to be moved");
    assert.deepEqual(removals, []);
  } finally {
    flow.stopCustomBot();
  }
});
