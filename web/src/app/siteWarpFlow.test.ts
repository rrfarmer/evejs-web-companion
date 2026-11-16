// A bot's warp to a scan result made by the page itself (the plan's Phase 6b), through the real flow over a faked
// BFF.
//
// Until 2026-10-11 it was POST /api/bridge/flight/warp-scan, which warped to every site by its label
// (CmdWarpToStuff('scan', label)). The client's scanner warps to an anomaly its sensor suite knows as an item, by
// the site's own number, with minRange=None and fleet=False (menusvc._WarpXToScanResult, 1418 to 1428): so does
// the page now, by its own call (bridge/movementWrites.ts), looking among the sites its last look read.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, holdsBody, namesBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const PILOT = 140000005;
const SITE = 5380000140002;
const LABEL = "YLD-909";

// The server's form of a site (a KeyVal by the site's number), a combat anomaly by its scan strength's attribute.
const keyVal = (entries: readonly (readonly [string, unknown])[]): unknown => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
const none = { type: "dict", entries: [] };
const anomaly = keyVal([["targetID", LABEL], ["position", [3.0e11, 1.0e10, -2.0e11]], ["scanStrengthAttribute", 1136], ["archetypeID", null], ["instanceID", null]]);
/** scanMgr.GetFullState as the server answers it: anomalies, signatures, static sites, structures. */
const SITES = [{ type: "dict", entries: [[SITE, anomaly]] }, none, none, none];

type Answer = { readonly status: number; readonly body: unknown };
const answered = (service: string, method: string, result: unknown): Answer => ({ status: 200, body: { ok: true, service, method, result, notifications: [] } });

// sensorSuiteService 718 and 722: self.scanSvc.GetScanMan().GetFullState(), a pilot's read.
const THE_READ = { service: "scanMgr", method: "GetFullState", args: [], kwargs: null, pilot: true };
// menusvc 1428: michelle.CmdWarpToStuff('item', siteID, minRange=None, fleet=False), a pilot's write.
const THE_WARP = { service: "beyonce", method: "CmdWarpToStuff", args: ["item", SITE], kwargs: { minRange: null, fleet: false }, pilot: true, confirm: true };

/**
 * A pilot in space in a system with one combat anomaly, and a BFF that says what it was asked, in order: "look"
 * for a bot's reading of the scene, "sites" for a read of the scanner, "warp" for the page's own warp.
 */
function harness({ solarSystemID = SOLAR_SYSTEM_ID as number | null, warp = (): Answer => answered("beyonce", "CmdWarpToStuff", null),
  dungeon = null as { entryTypeID: number; objectiveChainID: number | null } | null } = {}) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: PILOT, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null } as never);
  const asked: string[] = [];
  const reads: Record<string, unknown>[] = [];
  const warps: Record<string, unknown>[] = [];
  const routes: string[] = [];
  const flight = flightBody(false) as { flight: Record<string, unknown> };
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let answer: Answer = { status: 200, body: { ok: true } };
    if (path === "/api/bridge/flight/status") answer = { status: 200, body: { ...flight, flight: { ...flight.flight, solarSystemID } } };
    if (path === "/api/bridge/fitting") answer = { status: 200, body: fittingBody() };
    if (path === "/api/names") answer = { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/script/observation") {
      asked.push("look");
      answer = { status: 200, body: { ok: true, inSpace: [], bay: [], space: {
        inSpace: true, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID, sampledAtMs: Date.now(),
        ship: { itemID: SHIP_ID, typeID: 17480, radius: 100, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, mode: "STOP" },
        entities: [],
      } } };
    }
    if (path === "/api/bridge/targets") answer = { status: 200, body: { ok: true, targetIDs: [] } };
    if (dungeon && path === "/api/client-data/dungeons?ids=900") {
      answer = { status: 200, body: { ok: true, available: true, dungeons: { 900: { nameID: 123, ...dungeon } } } };
    }
    if (dungeon && path === "/api/bridge/call" && body.service === "keeper" && body.method === "GetCurrentDungeonForCharacter") {
      answer = answered("keeper", "GetCurrentDungeonForCharacter", [900, 80, 42, none]);
    }
    if (path === "/api/bridge/ship/ore-hold") answer = { status: 200, body: holdsBody(0, []) };
    // The route, which nothing is to ask.
    if (path === "/api/bridge/flight/warp-scan") { routes.push(path); answer = { status: 200, body: flightBody(false) }; }
    if (path === "/api/bridge/call" && body.service === "scanMgr") {
      asked.push("sites");
      reads.push(body);
      answer = answered("scanMgr", "GetFullState", SITES);
    }
    if (path === "/api/bridge/call" && body.service === "beyonce" && body.method === "CmdWarpToStuff") {
      asked.push("warp");
      warps.push(body);
      answer = warp();
    }
    return Response.json(answer.body, { status: answer.status });
  } });
  return { store, flow, asked, reads, warps, routes };
}

test("the current signature qualifies for Active only with an authored objective chain", async () => {
  for (const [entryTypeID, objectiveChainID, expected] of [[19728, null, false], [19728, 155, true], [28356, 38, false]] as const) {
    const { flow } = harness({ dungeon: { entryTypeID, objectiveChainID } });
    await flow.dungeonJobs(); // Starts the native keeper read for a reconnect in space.
    const job = (await flow.dungeonJobs()).find((row) => row.kind === "signature");
    assert.equal(job !== undefined, expected);
    if (job) {
      assert.equal(job.instanceID, 42);
      assert.equal(flow.untrackedObjectiveDungeonInstanceID.get(), null);
      flow.setObjectiveDungeonTracked(42, false);
      assert.equal(flow.untrackedObjectiveDungeonInstanceID.get(), 42);
      assert.equal((await flow.activeObjectiveDungeonJob())?.instanceID, 42);
    }
  }
});

const script: BotScript = {
  format: "evejs-bot-script", version: 1, name: "To a den", notes: "",
  home: { entity: "station", id: null, name: null, systemName: null },
  interrupts: [],
  program: [{ id: "den", kind: "macro", macro: "warp-to-anomaly", args: {} }],
};

/** The bot started and its clock turned until the test's condition holds, or the bot stops, or twelve looks have passed. */
async function run(context: TestContext, made: ReturnType<typeof harness>, until: () => boolean) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  /** What the bot said it was doing, as it changed. */
  const said: string[] = [];
  const unsubscribe = made.store.customBot.subscribe((state) => {
    const line = `${state.status}: ${state.why ?? ""}`;
    if (said.at(-1) !== line) said.push(line);
  });
  try {
    await made.flow.startCustomBot(script);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let look = 0; look < 12 && !until() && made.store.customBot.get().status === "running"; look += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    unsubscribe();
    made.flow.stopCustomBot();
  }
  return said;
}

/** What was asked from the bot's last reading of the scene to its first warp. */
const fromTheLastLook = (asked: readonly string[]): readonly string[] => {
  const upTo = asked.slice(0, asked.indexOf("warp") + 1);
  return upTo.slice(upTo.lastIndexOf("look"));
};

test("a bot's warp to an anomaly is the page's own call: to the site's own number as an item, with no range and no fleet's word, by what its look read", { timeout: 10_000 }, async (context) => {
  const made = harness();
  await run(context, made, () => made.warps.length > 0);
  assert.deepEqual(made.warps, [THE_WARP]);
  // The look read the scanner, and the warp went by that read: the scanner was not read again for it.
  assert.deepEqual(fromTheLastLook(made.asked), ["look", "sites", "warp"]);
  for (const each of made.reads) assert.deepEqual(each, THE_READ);
  assert.deepEqual(made.routes, []);
});

test("where the pilot's system is not known the look's read is not taken for this system's: the scanner is read again before the warp", { timeout: 10_000 }, async (context) => {
  const made = harness({ solarSystemID: null });
  await run(context, made, () => made.warps.length > 0);
  assert.deepEqual(made.warps, [THE_WARP]);
  assert.deepEqual(fromTheLastLook(made.asked), ["look", "sites", "sites", "warp"]);
  for (const each of made.reads) assert.deepEqual(each, THE_READ);
  assert.deepEqual(made.routes, []);
});

test("a warp the server refuses is the bot's to hear of: it waits for no warp that was not taken, and the route is not asked in its place", { timeout: 10_000 }, async (context) => {
  const made = harness({ warp: () => ({ status: 409, body: { ok: false, error: "CALL_REFUSED", message: "You cannot warp there right now." } }) });
  const said = await run(context, made, () => false);
  assert.deepEqual(made.warps, [THE_WARP]);
  assert.deepEqual(made.routes, []);
  // The one den refused, the bot's next step is the trip home to try again, and this bot has no home: it stops there.
  // A refusal it had not heard of would have had it waiting for the warp to start.
  const after = said.slice(said.indexOf("running: Warping to the next den.") + 1);
  assert.ok(said.includes("running: Warping to the next den."), said.join(" | "));
  assert.equal(after.some((line) => /Waiting for the warp|In warp/.test(line)), false, said.join(" | "));
  assert.match(after.at(-1) ?? "", /^paused: /, said.join(" | "));
});
