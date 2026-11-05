// A plugin's loop holds the ship as core's own loops do: taking it stops them, and they stop it.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow, type AppFlow, type HeldPilot } from "./flow.ts";
import { fittingBody, namesBody } from "./botFixtures.ts";
import { createClientStore } from "../store/clientStore.ts";

const CHARACTER = {
  characterID: 90000001, characterName: "Test", stationID: null,
  structureID: null, solarSystemID: 30000142, corporationID: 98000000,
};
const HELD = { characterID: CHARACTER.characterID, character: CHARACTER, station: null } as unknown as HeldPilot;

type Answer = (path: string, init: RequestInit | undefined) => Record<string, unknown>;

async function makeFlow(notifications: () => readonly unknown[] = () => [], answer: Answer = () => ({})) {
  const asked: string[] = [];
  const store = createClientStore();
  const flow = createAppFlow(store, {
    livePush: false,
    browserPilotRecovery: false,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: async (input, init) => {
      asked.push(String(input));
      return Response.json({ ok: true, released: true, flight: {}, notifications: notifications(), ...answer(String(input), init) });
    },
  });
  await flow.attachToHeldPilot(HELD);
  return { store, flow, asked };
}

const holderOf = (store: ReturnType<typeof createClientStore>) => store.get().bots;
const NOBODY = { runningBotID: null, runningPluginName: null };

/** Runs `body` with console.error silenced, and gives back what it was told. */
async function quietly(body: () => void | Promise<void>): Promise<readonly string[]> {
  const told: string[] = [];
  const real = console.error;
  console.error = (...words: unknown[]) => { told.push(words.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.error = real;
  }
  return told;
}

test("a plugin's hold says who holds the ship, in the plugin's own words", async () => {
  const { store, flow } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => {});
  assert.deepEqual(holderOf(store), { runningBotID: "plugin:trader", runningPluginName: "The trader" });
});

test("letting go leaves nothing holding the ship, and does not call the plugin's stop", async () => {
  const { store, flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; }).release();
  assert.deepEqual(holderOf(store), NOBODY);
  store.apply({ type: "character/offline" });
  assert.equal(stopped, 0, "and nothing is left watching for the pilot to go");
});

test("a hold stands through what the store hears that has nothing to do with who holds the ship", async () => {
  const { store, flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  store.apply({ type: "custom-bot/cleared" });
  store.apply({ type: "companion/start-error", message: null });
  store.apply({ type: "live/status", status: "connected" } as never);
  assert.equal(stopped, 0);
  assert.equal(holderOf(store).runningBotID, "plugin:trader");
});

test("a hold let go leaves nothing behind to end the next one", async () => {
  const { store, flow } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => {}).release();
  let stopped = 0;
  flow.flying.holdShip("plugin:hauler", "The hauler", () => { stopped += 1; });
  store.apply({ type: "custom-bot/cleared" });
  assert.equal(stopped, 0);
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("a hold that was stopped leaves nothing behind to end the next one", async () => {
  const { store, flow } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => {});
  let stopped = 0;
  flow.flying.holdShip("plugin:hauler", "The hauler", () => { stopped += 1; });
  store.apply({ type: "custom-bot/cleared" });
  assert.equal(stopped, 0);
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("swapping holds from inside a store's listener does not let the old watcher end the new hold", async () => {
  const { store, flow } = await makeFlow();
  let first: ReturnType<typeof flow.flying.holdShip> | null = null;
  let stopped = 0;
  let swapped = false;
  store.subscribe(() => {
    if (first === null || swapped) return;
    swapped = true;
    first.release();
    flow.flying.holdShip("plugin:hauler", "The hauler", () => { stopped += 1; });
  });
  first = flow.flying.holdShip("plugin:trader", "The trader", () => {});
  store.apply({ type: "custom-bot/cleared" });
  assert.equal(stopped, 0);
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("another pilot chosen on this flow stops a loop flying the last one", async () => {
  const { flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  await flow.attachToHeldPilot({ ...HELD, characterID: 90000002, character: { ...CHARACTER, characterID: 90000002 } } as unknown as HeldPilot);
  assert.equal(stopped, 1);
});

test("with no pilot online there is nothing to hold", () => {
  const flow = createAppFlow(createClientStore(), { livePush: false, perSessionToken: true, initialSessionToken: "pilot", fetch: async () => Response.json({ ok: true }) });
  assert.throws(() => flow.flying.holdShip("plugin:trader", "The trader", () => {}), /No pilot/);
});

test("a second plugin taking the ship stops the first, whose late release changes nothing", async () => {
  const { store, flow } = await makeFlow();
  const stopped: string[] = [];
  const first = flow.flying.holdShip("plugin:trader", "The trader", () => stopped.push("trader"));
  flow.flying.holdShip("plugin:hauler", "The hauler", () => stopped.push("hauler"));
  assert.deepEqual(stopped, ["trader"]);
  first.release();
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("one of core's loops taking the ship stops a plugin's", async () => {
  const { store, flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  // A start takes the ship before anything it awaits, so this much has happened as it returns.
  void flow.startFleetCompanion({} as Parameters<typeof flow.startFleetCompanion>[0]).catch(() => {});
  assert.equal(stopped, 1);
  assert.notEqual(holderOf(store).runningBotID, "plugin:trader");
});

test("a start already on its way when a plugin took the ship still stops the plugin as it lands", async () => {
  const { store, flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  store.apply({ type: "custom-bot/started", name: "Mine" });
  assert.deepEqual(holderOf(store), { runningBotID: "custom", runningPluginName: null });
  assert.equal(stopped, 1);
});

test("a panic recall stops a plugin's loop, or it would undock again", async () => {
  const { flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  await flow.panicRecallAndDock().catch(() => {});
  assert.equal(stopped, 1);
});

test("a player's Stop ends a plugin's loop in this tab, and does nothing if there is none", async () => {
  const { store, flow } = await makeFlow();
  flow.stopPluginLoop();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  flow.stopPluginLoop();
  assert.equal(stopped, 1);
  assert.deepEqual(holderOf(store), NOBODY);
  flow.stopPluginLoop();
  assert.equal(stopped, 1);
});

test("with no pilot online the refusal says so, whatever drone recovery is doing", () => {
  const flow = createAppFlow(createClientStore(), {
    livePush: false,
    browserPilotRecovery: true,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: async () => Response.json({ ok: true }),
  });
  assert.throws(() => flow.flying.holdShip("plugin:trader", "The trader", () => {}), /No pilot/);
});

test("a hold waits for drone recovery, as every start does", async () => {
  // Every request waits, so recovery is still checking when the hold is asked for.
  const waiting: (() => void)[] = [];
  const flow = createAppFlow(createClientStore(), {
    livePush: false,
    browserPilotRecovery: true,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: () => new Promise<Response>((resolve) => { waiting.push(() => resolve(Response.json({ ok: true }))); }),
  });
  const attaching = flow.attachToHeldPilot(HELD);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => flow.flying.holdShip("plugin:trader", "The trader", () => {}), /recovery/i);
  while (waiting.length > 0) {
    waiting.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.race([attaching.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 100))]);
});

test("a lost session stops a plugin's loop, in the flow as well as the store", async () => {
  const { store, flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  store.apply({ type: "character/offline" });
  assert.equal(stopped, 1);
  assert.deepEqual(holderOf(store), NOBODY);
  await flow.attachToHeldPilot(HELD);
  assert.deepEqual(holderOf(store), NOBODY, "and nothing comes back with the pilot");
});

test("a pilot's session closing stops a plugin's loop, and no hold can be taken after", async () => {
  const { flow } = await makeFlow();
  let stopped = 0;
  flow.flying.holdShip("plugin:trader", "The trader", () => { stopped += 1; });
  assert.equal(flow.flying.isSessionClosing(), false);
  const before = flow.flying.sessionGeneration();
  const closing = flow.releaseSession().catch(() => {});
  assert.equal(stopped, 1);
  assert.equal(flow.flying.sessionGeneration(), before + 1);
  assert.throws(() => flow.flying.holdShip("plugin:trader", "The trader", () => {}), /released/);
  await closing;
});

test("a plugin's stop that throws cannot wedge a session's release", async () => {
  const { flow, asked } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => { throw new Error("boom"); });
  const told = await quietly(() => flow.releaseSession());
  assert.ok(told.some((line) => line.includes("boom")));
  assert.ok(asked.includes("/api/bridge/release"), "the pilot was released");
});

test("a plugin's stop that throws is not the next claimant's problem", async () => {
  const { store, flow } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", () => { throw new Error("boom"); });
  await quietly(() => { flow.flying.holdShip("plugin:hauler", "The hauler", () => {}); });
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

test("an async stop that rejects goes no further either", async () => {
  const { flow } = await makeFlow();
  flow.flying.holdShip("plugin:trader", "The trader", async () => { throw new Error("async boom"); });
  const told = await quietly(async () => {
    flow.flying.holdShip("plugin:hauler", "The hauler", () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(told.some((line) => line.includes("async boom")));
});

test("a plugin's stop cannot take the ship back, so no second loop is left flying", async () => {
  const { store, flow } = await makeFlow();
  const refused: string[] = [];
  flow.flying.holdShip("plugin:trader", "The trader", () => {
    try {
      flow.flying.holdShip("plugin:trader", "Again", () => {});
    } catch (error) {
      refused.push(String(error));
    }
  });
  flow.flying.holdShip("plugin:hauler", "The hauler", () => {});
  assert.equal(refused.length, 1);
  assert.equal(holderOf(store).runningBotID, "plugin:hauler");
});

const PUSHES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["a fleet broadcast", { method: "OnFleetBroadcast", args: ["Target", 3, 90000002, 30000142, 9001, null] }],
  ["a fleet target tag", { method: "OnFleetStateChange", args: [{ type: "dict", entries: [[9001, "A"]] }] }],
  ["this ship's lock landing", { method: "OnTarget", args: ["add", 9001] }],
  ["a jam starting", { method: "OnJamStart", args: [9001, 7777, 9002, "warpScramblerMWD", 0, 5000] }],
];

for (const [what, push] of PUSHES) {
  test(`listeners hear ${what} as it arrives, until they stop listening`, async () => {
    let pending: readonly unknown[] = [];
    const { flow } = await makeFlow(() => { const taken = pending; pending = []; return taken; });
    let heard = 0;
    const stop = flow.flying.onPush(() => { heard += 1; });
    pending = [push];
    await flow.flying.readFlightNow();
    assert.equal(heard, 1);
    stop();
    pending = [push];
    await flow.flying.readFlightNow();
    assert.equal(heard, 1);
  });
}

test("a listener that throws fails neither the call that brought the push, nor the next listener", async () => {
  let pending: readonly unknown[] = [];
  const { flow } = await makeFlow(() => { const taken = pending; pending = []; return taken; });
  flow.flying.onPush(() => { throw new Error("listener boom"); });
  let heard = 0;
  flow.flying.onPush(() => { heard += 1; });
  pending = [PUSHES[0]![1]];
  const told = await quietly(async () => { await flow.flying.readFlightNow(); });
  assert.equal(heard, 1);
  assert.ok(told.some((line) => line.includes("listener boom")));
});

async function sleptFor(flow: AppFlow, ms: number, duringSleep: () => void = () => {}): Promise<number> {
  const started = Date.now();
  const sleep = flow.flying.sleepUntilPush(ms);
  duringSleep();
  await sleep;
  return Date.now() - started;
}

test("a sleep with no push runs its length", async () => {
  const { flow } = await makeFlow();
  assert.ok(await sleptFor(flow, 60) >= 55);
});

test("a storm of pushes ends a sleep early, but not before the floor", async () => {
  let pending: readonly unknown[] = [];
  const { flow } = await makeFlow(() => { const taken = pending; pending = []; return taken; });
  const push = (): void => {
    pending = [PUSHES[0]![1]];
    void flow.flying.readFlightNow();
  };
  const slept = await sleptFor(flow, 5_000, () => {
    push();
    setTimeout(push, 30);
    setTimeout(push, 60);
  });
  assert.ok(slept >= 300, `slept ${slept} ms, under the floor`);
  assert.ok(slept < 2_000, `slept ${slept} ms, so the push did not wake it`);
});

test("what a sleep watches rejecting goes no further", async () => {
  const { flow } = await makeFlow();
  const told = await quietly(async () => {
    await flow.flying.sleepUntilPush(5, async () => { throw new Error("async watch boom"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(told.some((line) => line.includes("async watch boom")));
});

test("a listener that rejects goes no further", async () => {
  let pending: readonly unknown[] = [];
  const { flow } = await makeFlow(() => { const taken = pending; pending = []; return taken; });
  flow.flying.onPush(async () => { throw new Error("async listener boom"); });
  pending = [PUSHES[0]![1]];
  const told = await quietly(async () => {
    await flow.flying.readFlightNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(told.some((line) => line.includes("async listener boom")));
});

test("what a sleep watches throwing does not fail the sleep", async () => {
  const { flow } = await makeFlow();
  const told = await quietly(() => flow.flying.sleepUntilPush(5, () => { throw new Error("watch boom"); }));
  assert.ok(told.some((line) => line.includes("watch boom")));
});

test("what a sleep is watching is told when it ends", async () => {
  const { flow } = await makeFlow();
  let asleep: (() => boolean) | null = null;
  await flow.flying.sleepUntilPush(5, (isAsleep) => { asleep = isAsleep; });
  assert.equal((asleep as unknown as () => boolean)(), false);
});

test("the resolve calls answer as if the ship were empty until the fit has been read", async () => {
  const { flow, asked } = await makeFlow(() => [], (path, init) => {
    if (path === "/api/bridge/fitting") return fittingBody() as Record<string, unknown>;
    if (path === "/api/names") return namesBody(JSON.parse(String(init?.body))) as Record<string, unknown>;
    return {};
  });
  assert.equal(asked.includes("/api/bridge/fitting"), false, "attaching reads no fit");
  assert.deepEqual(flow.flying.resolveDefenseModuleIDs().propulsion, []);
  const before = asked.length;
  assert.equal(await flow.flying.readFit(), true);
  assert.equal(flow.flying.resolveDefenseModuleIDs().propulsion.length, 1, "the fixture's afterburner");
  const read = asked.slice(before);
  for (const part of ["/api/names", "dogma", "activation"]) {
    assert.ok(read.some((path) => path.toLowerCase().includes(part)), `waited for ${part}: ${read.join(" ")}`);
  }
});

test("a fit whose module groups could not be named says so, and does not read as a ship without them", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    livePush: false,
    browserPilotRecovery: false,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: async (input) => (String(input) === "/api/names"
      ? new Response("{}", { status: 502 })
      : Response.json(String(input) === "/api/bridge/fitting" ? fittingBody() : { ok: true })),
  });
  await flow.attachToHeldPilot(HELD);
  assert.equal(await flow.flying.readFit(), false);
});

test("a fit whose modules could not be read says so, and does not read as an empty ship", async () => {
  const { flow } = await makeFlow(() => [], (path) => (
    path === "/api/bridge/fitting" ? { ...(fittingBody() as Record<string, unknown>), errors: { slots: "refused" } } : {}
  ));
  assert.equal(await flow.flying.readFit(), false);
});
