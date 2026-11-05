// What a plugin's loop keeps about a pilot and writes down, and how the pilot's routes reach it.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow, type AppFlow, type HeldPilot } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { createPilotSession } from "../plugin-api/pilotSession.ts";

const CHARACTER = {
  characterID: 90000001, characterName: "Test", stationID: null,
  structureID: null, solarSystemID: 30000142, corporationID: 98000000,
};
const HELD = { characterID: CHARACTER.characterID, character: CHARACTER, station: null } as unknown as HeldPilot;

test("a plugin's state: the same key is the same signal, and another key another", () => {
  const store = createClientStore();
  const state = store.pluginState("plugin:trader", { orders: 0 });
  state.set({ orders: 3 });
  assert.deepEqual(store.pluginState("plugin:trader", { orders: 0 }).get(), { orders: 3 });
  assert.deepEqual(store.pluginState("plugin:hauler", { orders: 0 }).get(), { orders: 0 });
});

test("a plugin's state tells who is listening, as a slice of core's does", () => {
  const store = createClientStore();
  const state = store.pluginState("plugin:trader", 0);
  const heard: number[] = [];
  const stop = state.subscribe((value) => heard.push(value));
  state.set(1);
  stop();
  state.set(2);
  assert.equal(heard.at(-1), 1);
});

test("a pilot going offline puts a plugin's state back to where it began", () => {
  const store = createClientStore();
  const state = store.pluginState("plugin:trader", 0);
  state.set(5);
  store.apply({ type: "character/offline" });
  assert.equal(state.get(), 0);
});

function fetchRecording(asked: { readonly path: string; readonly body: unknown }[]): typeof fetch {
  return async (input, init) => {
    asked.push({ path: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return Response.json({ ok: true, written: 1 });
  };
}

test("signing out and choosing a pilot put a plugin's state back as well", () => {
  const store = createClientStore();
  const state = store.pluginState("plugin:trader", 0);
  state.set(5);
  store.apply({ type: "session/logged-out" });
  assert.equal(state.get(), 0);
  state.set(5);
  store.apply({ type: "character/online", character: CHARACTER, station: null } as never);
  assert.equal(state.get(), 0);
});

test("a line written to the flight recorder reaches this pilot's log, with an action of the plugin's own", async () => {
  const asked: { readonly path: string; readonly body: unknown }[] = [];
  const flow: AppFlow = createAppFlow(createClientStore(), {
    livePush: false,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: fetchRecording(asked),
  });
  await flow.attachToHeldPilot(HELD);
  flow.flying.log.write({
    t: "2026-11-05T12:00:00.000Z", kind: "issue", run: "r1",
    action: { kind: "buyOre" }, trace: { reason: "cheap" },
  });
  await flow.flying.log.flush();
  const sent = asked.find((request) => request.path === "/api/bots/bot-log")?.body as { entries: Record<string, unknown>[] };
  assert.deepEqual(sent.entries[0]?.action, { kind: "buyOre" });
  assert.deepEqual(sent.entries[0]?.trace, { reason: "cheap" });
});

test("a run's flow plans routes as its pilot set them, and has no browser storage to write them to", async () => {
  const { flow } = await createPilotSession({
    baseUrl: "",
    fetch: fetchRecording([]),
    held: HELD,
    routeSettings: { pfRouteType: "shortest" },
  });
  assert.equal(flow.autopilotSettings().pfRouteType, "shortest");
});
