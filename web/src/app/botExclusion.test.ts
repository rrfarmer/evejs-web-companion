// ONE SHIP, ONE BOT (goal R43).
//
// The bug this suite exists to pin: mutual exclusion between the two browser
// decide-loops was TWO HAND-WRITTEN LINES and they were asymmetric.
//
//   flow.ts  startMissionBot -> miningBot?.stop()    ✓
//   flow.ts  startMiningBot  -> autopilot?.abort()   ✗ never stopped missionBot
//
// So starting the mining bot while the mission bot ran left BOTH loops ticking,
// each issuing movement and module calls against the same ship, and neither
// able to see the other. Nothing in the app noticed.
//
// ⚠ THE FIX IS STRUCTURAL, NOT A THIRD LINE. `nav/botRegistry.ts` holds one
// `BotID` union and one exhaustive `Record<BotID, () => void>` of stoppers;
// `createShipClaim` walks EVERY other bot and stops it. A fourth bot cannot be
// added without the compiler demanding its stopper, and it inherits exclusion
// from every existing bot without anyone remembering to write a line. The store
// then carries ONE `runningBotID`, recomputed from the loops' own statuses after
// every event, so the readout can never drift from the loops.
//
// This suite drives the REAL flow over a faked BFF and asserts the property that
// matters: whichever bot you start, exactly one is left running.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { BOT_IDS, SHIP_CONTROLLER_IDS } from "../nav/botRegistry.ts";
import type { BotScript } from "../bots/botScript.ts";
import {
  STRIP_MINER_ITEM_IDS,
  fittingBody,
  flightBody,
  holdsBody,
  namesBody,
  spaceBody,
} from "./botFixtures.ts";

const BELT = 40000123;
const STATION = 60003760;
const AGENT = 3018920;

const MINING_REQUEST = {
  beltID: BELT,
  beltName: "Asteroid Belt 1",
  stationID: STATION,
  stationName: "Jita IV - Moon 4",
  miningModuleIDs: [7001],
  healthFloor: 0.5,
  useDrones: false,
};

const MISSION_REQUEST = {
  agentID: AGENT,
  agentName: "Aursa Bemenen",
  agentStationID: STATION,
  agentStationName: "Jita IV - Moon 4",
  maxJumps: 10,
  maxMissions: 0,
};

const CUSTOM_DOC: BotScript = {
  format: "evejs-bot-script",
  version: 1,
  name: "Patient custom bot",
  notes: "",
  home: { entity: "station", id: STATION, name: "Jita IV - Moon 4", systemName: "Jita" },
  interrupts: [],
  program: [
    {
      id: "wait",
      kind: "macro",
      macro: "wait",
      args: { seconds: { kind: "count", value: 500 } },
    },
  ],
};

/**
 * A world in which BOTH bots can legitimately start.
 *
 * The mining bot needs to be in space with a belt, a station, a powered-up
 * miner and room in the hold; the mission bot needs to be docked with an agent.
 * Those two cannot both be true of one flight status, so the harness serves
 * whichever the caller asked for and the exclusion test starts the bot that
 * matches. `docked` therefore parameterises the world, not the assertion.
 */
function harness(docked: boolean, options: { readonly minersOffline?: boolean } = {}) {
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const outcome = respond(path, body as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      async json() {
        return outcome;
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string, body: Record<string, unknown>): unknown {
    if (path === "/api/bridge/flight/status") return flightBody(docked);
    if (path === "/api/bridge/space/snapshot") return spaceBody();
    if (path === "/api/bridge/fitting") {
      return fittingBody(options.minersOffline ? { offline: STRIP_MINER_ITEM_IDS } : {});
    }
    if (path === "/api/bridge/ship/ore-hold") return holdsBody(0, []);
    if (path === "/api/names") return namesBody(body);
    if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
    return { ok: true };
  }

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }) };
}

/** Every bot the client can run, and whether its loop currently holds the ship. */
function holders(store: ReturnType<typeof createClientStore>): string[] {
  const state = store.get();
  const held: string[] = [];
  if (state.bot.status === "running" || state.bot.status === "paused") held.push("mining");
  if (state.missionBot.status === "running" || state.missionBot.status === "paused") {
    held.push("mission");
  }
  if (state.customBot.status === "running" || state.customBot.status === "paused") {
    held.push("custom");
  }
  return held;
}

test("R43 — starting the MINING bot stops the mission bot (the asymmetric half of the old bug)", async () => {
  // The mission bot starts docked; the mining bot's preflight needs space. The
  // world is docked, so this drives the exact sequence that used to leave two
  // loops running: mission bot up, then a mining start against the same ship.
  const { store, flow } = harness(true);
  await flow.startMissionBot(MISSION_REQUEST);
  assert.equal(store.get().missionBot.status, "running", "the mission bot is up");

  await flow.startMiningBot(MINING_REQUEST);

  // Whether or not the mining bot's own preflight lets it start from a docked
  // ship, the mission bot must NOT still be driving: the claim is taken before
  // any start decision, because the player has said which bot they want.
  assert.equal(
    store.get().missionBot.status,
    "stopped",
    "the mission bot must be stopped by the mining bot's claim on the ship",
  );
  flow.stopMiningBot();
  flow.stopMissionBot();
});

test("R43 — starting the MISSION bot stops the mining bot (the half that already worked)", async () => {
  const { store, flow } = harness(false);
  await flow.startMiningBot(MINING_REQUEST);
  assert.equal(store.get().bot.status, "running", "the mining bot is up");

  await flow.startMissionBot(MISSION_REQUEST);

  assert.equal(store.get().bot.status, "stopped", "the mining bot must be stopped");
  flow.stopMiningBot();
  flow.stopMissionBot();
});

test("R43 — starting each bot while each other runs leaves AT MOST ONE running", async () => {
  // Every ordered pair of starts, from both a docked ship and one in space.
  // This is the property the two hand-written lines could not give: it has to
  // hold in BOTH orders and from BOTH starting points, and it is asserted after
  // every single start rather than only at the end.
  const starts: Record<string, (flow: ReturnType<typeof harness>["flow"]) => Promise<void>> = {
    mining: (flow) => flow.startMiningBot(MINING_REQUEST),
    mission: (flow) => flow.startMissionBot(MISSION_REQUEST),
    custom: (flow) => flow.startCustomBot(CUSTOM_DOC),
  };
  const names = Object.keys(starts);

  for (const docked of [false, true]) {
    for (const first of names) {
      for (const second of names) {
        const { store, flow } = harness(docked);
        await starts[first]!(flow);
        assert.ok(holders(store).length <= 1, `after ${first}: never two loops on one ship`);
        await starts[second]!(flow);
        assert.ok(
          holders(store).length <= 1,
          `${second} started while ${first} ran (docked=${docked}): ${holders(store).join(" + ")}`,
        );
        flow.stopMiningBot();
        flow.stopMissionBot();
        flow.stopCustomBot();
        assert.deepEqual(holders(store), [], "and stopping both leaves nothing running");
      }
    }
  }
});

test("R43 — a REFUSED start still lets the other bot go: the claim is taken first", async () => {
  // ⚠ THE ORDER IS THE ASSERTION. The claim happens before the preflight can
  // refuse, because the player has already said which bot they want. If the
  // claim came second, a refused start would leave the previous bot flying the
  // ship out from under a decision that had already been made — the old
  // two-loops bug, wearing an error message.
  //
  // The miners are powered down, so the mining bot's one BLOCKING requirement
  // fails and it cannot start.
  const { store, flow } = harness(false, { minersOffline: true });
  await flow.startMissionBot(MISSION_REQUEST);
  assert.deepEqual(holders(store), ["mission"], "the mission bot is up");

  await flow.startMiningBot(MINING_REQUEST);

  assert.deepEqual(holders(store), [], "the refused start still took the ship off the mission bot");
  assert.match(
    String(store.get().bot.startError),
    /fitted but not switched on/i,
    "and it says which requirement failed, in words a player can act on",
  );
});

test("R43 — the store carries ONE runningBotID and it never disagrees with the loops", async () => {
  const { store, flow } = harness(true);
  assert.equal(store.get().bots.runningBotID, null, "nothing runs at rest");

  await flow.startMissionBot(MISSION_REQUEST);
  assert.equal(store.get().bots.runningBotID, "mission");

  flow.pauseMissionBot();
  assert.equal(
    store.get().bots.runningBotID,
    "mission",
    "a PAUSED bot still holds the ship — it has not let go of it",
  );

  flow.stopMissionBot();
  assert.equal(store.get().bots.runningBotID, null);

  await flow.startCustomBot(CUSTOM_DOC);
  assert.equal(store.get().bots.runningBotID, "custom", "player-authored bots participate in the same view");
  flow.stopCustomBot();
  assert.equal(store.get().bots.runningBotID, null);
});

test("R43 — every registered bot is reachable by the exclusion machinery", () => {
  // The compiler enforces that `createShipClaim` is given a stopper for every
  // BotID (it takes an exhaustive Record). This asserts the OTHER half: the
  // registry is not empty and carries no duplicate, so a bot cannot be
  // registered twice and stop itself.
  assert.ok(BOT_IDS.length >= 2, "the live-proven bots are registered");
  assert.equal(new Set(BOT_IDS).size, BOT_IDS.length, "no bot is registered twice");
  assert.deepEqual(
    [...SHIP_CONTROLLER_IDS].sort(),
    ["custom", "mining", "mission"],
    "the ownership registry includes the player-authored controller",
  );
  assert.ok(
    !SHIP_CONTROLLER_IDS.includes("companion" as never),
    "the fleet companion is a plugin now, so core's registry does not name it",
  );
});
