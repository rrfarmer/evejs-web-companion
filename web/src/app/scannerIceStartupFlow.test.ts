import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript, MacroStep } from "../bots/botScript.ts";
import { fittingBody, flightBody, namesBody, SHIP_ID, STRIP_MINER_ITEM_IDS } from "./botFixtures.ts";

const HOME = { entity: "station" as const, id: 60000358, name: "Home", systemName: null };
const wait: MacroStep = { id: "wait", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 500 } } };
const undock: MacroStep = { id: "undock", kind: "macro", macro: "undock", args: {} };
const mine = (id: string, mode: "site" | "ice-site"): MacroStep =>
  ({ id, kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode } } } });
const script = (program: BotScript["program"]): BotScript =>
  ({ format: "evejs-bot-script", version: 1, name: "Scanner tour", notes: "", home: HOME, interrupts: [], program });

function fixture(module: "none" | "gas" | "ice" = "none", miningOperationID?: string, structureID?: number) {
  // Synthetic high-slot additions leave the shared captured fit untouched.
  const extraModules = module === "none" ? [] : [{ itemID: 7002, typeID: module === "ice" ? 16278 : 25266,
    flagID: 29, groupID: module === "ice" ? 464 : 737,
    name: module === "ice" ? "Ice Harvester I" : "Gas Cloud Scoop I",
    groupName: module === "ice" ? "Strip Miner" : "Gas Cloud Scoops" }];
  const paths: string[] = [];
  const unloads: Record<string, unknown>[] = [];
  const store = createClientStore();
  const keyVal = (entries: unknown[][]) => ({ type: "object", args: { type: "dict", entries } });
  const flow = createAppFlow(store, { livePush: false, miningOperationID, fetch: async (input, init) => {
    const path = String(input); paths.push(path);
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    // A call of the page's own is noted by its pair too: the undock is one (bridge/placeChanges.ts).
    if (path === "/api/bridge/call") paths.push(`call:${String(body.service)}.${String(body.method)}`);
    let result: unknown = { ok: true };
    if (path === "/api/bridge/select") result = { ok: true, character: { characterID: 42, characterName: "Test", stationID: HOME.id },
      station: null, droneRecoveryCheckID: "current-check" };
    if (path === "/api/bridge/flight/status") {
      const status = flightBody(true) as { flight: Record<string, unknown> };
      result = structureID === undefined ? status : { ...status, flight: { ...status.flight, stationID: null, structureID } };
    }
    if (path === "/api/bridge/ship/ore-hold") result = { ok: true, holds: [{ key: "ore", label: "Ore Hold", present: true,
      capacity: { capacity: 1000, used: unloads.length === 0 ? 100 : 0 }, error: null,
      items: unloads.length === 0 ? [{ itemID: 8001, typeID: 16264, groupID: 465, categoryID: 25, quantity: 10 }] : [] }] };
    if (path === "/api/bridge/ship/ore-hold/unload") {
      unloads.push(body);
      result = { ok: true, moved: [8001], remaining: [], movedToCorp: [8001], fellBack: null };
    }
    if (path === "/api/bridge/drones") result = { ok: true, inSpace: [], bay: [] };
    if (path === "/api/bridge/space/snapshot") result = { ok: true, space: { inSpace: false, shipID: SHIP_ID, sampledAtMs: 400,
      ship: { itemID: SHIP_ID, characterID: 42, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, radius: 50, geometryAvailable: true } } };
    if (path === "/api/bridge/fitting") result = fittingBody({ offline: STRIP_MINER_ITEM_IDS, extraModules });
    if (path === "/api/bridge/bound-dogma") result = { ok: true, reads: { GetAllInfo: { result: keyVal([["activeShipID", SHIP_ID]]) } } };
    if (path === "/api/types/dogma") result = { ok: true, attributes: { 16278: { 77: 1000, 182: 16281 }, 25266: { 77: 10, 182: 25544 } } };
    if (path === "/api/names") {
      const base = namesBody(body) as { names: Record<string, string> };
      const names = { ...base.names };
      for (const row of extraModules) for (const item of (body.items ?? []) as { kind: string; id: number }[]) {
        if (item.id === row.typeID && item.kind === "type") names[`type:${row.typeID}`] = row.name;
        if (item.id === row.typeID && item.kind === "typeGroup") names[`typeGroup:${row.typeID}`] = row.groupName;
      }
      result = { ok: true, source: "static-data", count: Object.keys(names).length, names, unresolved: [] };
    }
    if (path === "/api/bridge/call") result = { ok: true, service: body.service, method: body.method, result: [], notifications: [] };
    return new Response(JSON.stringify(result));
  } });
  return { store, flow, paths, unloads };
}

test("an ice script started inside an Upwell unloads at its starting structure rather than its configured home", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("ice", undefined, 1030000000000);
  await f.flow.selectCharacter(42);
  try {
    await f.flow.startCustomBot(script([{ id: "haul", kind: "macro", macro: "deliver-ore", args: {
      station: { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null, starting: true } },
      into: { kind: "corpDivision", division: 1, name: null },
    } }]));
    for (let look = 0; look < 10 && f.unloads.length === 0; look += 1) {
      context.mock.timers.tick(2000);
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(f.unloads, [{ itemIDs: [8001], division: 1, strictCorp: true,
      expectedDestination: { kind: "structure", id: 1030000000000 } }]);
    assert.equal(f.paths.some(path => path.includes("/route")), false);
  } finally { f.flow.stopCustomBot(); }
});

test("mixed plain ore/ice Start validates the later Ice Harvester before undocking", async () => {
  for (const module of ["none", "gas"] as const) {
    const f = fixture(module); await f.flow.selectCharacter(42);
    try {
      await assert.rejects(f.flow.startCustomBot(script([undock, mine("ore", "site"), mine("ice", "ice-site")])),
        /ICE_MINING_CAPABILITY_REQUIRED/);
      assert.equal(f.paths.includes("call:ship.Undock"), false);
      assert.equal(f.store.customBot.get().status, "idle");
    } finally { f.flow.stopCustomBot(); }
  }
});

test("a missing-harvester Start refusal leaves the custom controller idle", async () => {
  const f = fixture(); await f.flow.selectCharacter(42);
  try {
    await assert.rejects(f.flow.startCustomBot(script([mine("ice", "ice-site")])), /ICE_MINING_CAPABILITY_REQUIRED/);
    assert.equal(f.store.customBot.get().status, "idle");
    assert.equal(f.store.customBot.get().name, null);
  } finally { f.flow.stopCustomBot(); }
});

test("plain ore Start preserves its existing capability policy", async () => {
  const f = fixture(); await f.flow.selectCharacter(42);
  try {
    await f.flow.startCustomBot(script([wait, mine("ore", "site")]));
    assert.equal(f.store.customBot.get().status, "running");
  } finally { f.flow.stopCustomBot(); }
});

test("custom mining and support bots start on HTTP pages without crypto.randomUUID", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  // A LAN HTTP browser still exposes getRandomValues, but not randomUUID.
  Object.defineProperty(globalThis, "crypto", { configurable: true,
    value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } });
  try {
    for (const support of [false, true]) {
      const f = fixture("none", support ? "operation" : undefined);
      await f.flow.selectCharacter(42);
      try {
        const work: MacroStep = support
          ? { id: "support", kind: "macro", macro: "mining-support", args: {} }
          : mine("ore", "site");
        await f.flow.startCustomBot(script([wait, work]));
        assert.equal(f.store.customBot.get().status, "running");
      } finally { f.flow.stopCustomBot(); }
    }
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); }
});

test("an operation still refuses missing ore capability before its program undocks", async () => {
  const f = fixture("gas", "operation"); await f.flow.selectCharacter(42);
  try {
    await assert.rejects(f.flow.startCustomBot(script([undock, mine("ore", "site"), mine("ice", "ice-site")])),
      /ORE_MINING_CAPABILITY_REQUIRED/);
    assert.equal(f.paths.includes("call:ship.Undock"), false);
    assert.equal(f.store.customBot.get().status, "idle");
  } finally { f.flow.stopCustomBot(); }
});

test("mixed plain ore/ice Start succeeds with an online Ice Harvester", async () => {
  const f = fixture("ice"); await f.flow.selectCharacter(42);
  try {
    await f.flow.startCustomBot(script([wait, mine("ore", "site"), mine("ice", "ice-site")]));
    assert.equal(f.paths.includes("/api/types/dogma"), true);
    assert.equal(f.store.customBot.get().status, "running");
  } finally { f.flow.stopCustomBot(); }
});
