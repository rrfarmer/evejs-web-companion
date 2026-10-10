// A damaged module repaired from the page, through the real flow over a faked BFF.
//
// The flow's own test of this verb (writeVerification.test.ts) reads its source for the damage check. What it
// sends was reached by no test.
//
// A retail client's repair is two calls, both godma's (godma.py 2225 to 2262): InitiateModuleRepair(itemID),
// which takes the paste and begins; and, once the repair's time is up, StopModuleRepair(itemID), which godma
// sends itself. The time is the module's damage over the character's repair rate, in minutes, and a second
// (RepairModule_thread). The server mends the module at the second call and not before. Until 2026-10-10 the page
// asked a route of the BFF for the first and never made the second.

import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { fittingBody, namesBody, spaceBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const CHARACTER = 140000005;
// One of the fixture ship's fitted modules, with 40 hit points of its own, a quarter of them gone.
const WEB = { itemID: 9988400023312, typeID: 527, hp: 40, damage: 0.25 };
// The character mends 10 hit points a minute: 10 points take a minute, and godma waits a second more.
const REPAIR_RATE = 10;
const THE_WAIT_MS = 61_000;

const keyVal = (entries: readonly (readonly [string, unknown])[]): unknown => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
const packedRow = (fields: Record<string, unknown>): unknown => ({ type: "packedrow", fields });
/** One entry of godma's priming: an item, and its attributes by ID. */
const infoEntry = (itemID: number, typeID: number, locationID: number, flagID: number, categoryID: number, attributes: readonly (readonly [number, number])[]): unknown => keyVal([
  ["itemID", itemID],
  ["invItem", packedRow({ itemID, typeID, ownerID: CHARACTER, locationID, flagID, quantity: -1, groupID: 0, categoryID, customInfo: "", stacksize: 1 })],
  ["activeEffects", { type: "dict", entries: [] }],
  ["time", "134292246678390000"],
  ["attributes", { type: "dict", entries: attributes }],
]);
/**
 * dogmaIM.GetAllInfo as the BFF hands it on: the ship (with hit points of its own, which are not the module's), its
 * module with its hit points (9), and the character with its repair rate (1267).
 */
const allInfo = (rate: number | null, hp: number | null): unknown => ({ ok: true, reads: { GetAllInfo: { error: null, result: keyVal([
  ["activeShipID", SHIP_ID],
  ["shipInfo", { type: "dict", entries: [
    [SHIP_ID, infoEntry(SHIP_ID, 17480, 60003760, 0, 6, [[9, 5000]])],
    [WEB.itemID, infoEntry(WEB.itemID, WEB.typeID, SHIP_ID, 19, 7, hp === null ? [[3, 0]] : [[9, hp], [3, 0]])],
  ] }],
  ["charInfo", [{ type: "dict", entries: [[CHARACTER, infoEntry(CHARACTER, 1373, 60003760, 0, 3, rate === null ? [] : [[1267, rate]])]] }, null]],
  ["shipState", []],
  ["systemWideEffectsOnShip", { type: "dict", entries: [] }],
  ["structureInfo", { type: "dict", entries: [] }],
  ["locationInfo", { type: "dict", entries: [] }],
]) } } });

/** A flow in the fixture ship, one module damaged, over a BFF that answers a repair's beginning with `begins`. */
async function harness(options: { readonly begins?: () => unknown; readonly rate?: number | null; readonly hp?: number | null; readonly damage?: number } = {}) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: CHARACTER, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  /** What the page asked of the server for the repair, in order. */
  const calls: Record<string, unknown>[] = [];
  const routes: string[] = [];
  let damage: number = options.damage ?? WEB.damage;
  /** Notices the server has for the pilot: they come with the next reading of the ship. */
  const pending: unknown[] = [];
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const path = new URL(String(input), "http://bff.test").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/fitting") result = fittingBody();
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/bridge/bound-dogma") result = allInfo(options.rate === undefined ? REPAIR_RATE : options.rate, options.hp === undefined ? WEB.hp : options.hp);
    if (path === "/api/bridge/space/snapshot") {
      const space = spaceBody() as { space: { ship: Record<string, unknown> }; notifications?: unknown[] };
      space.space.ship.moduleDamage = damage > 0 ? { [String(WEB.itemID)]: damage } : {};
      space.notifications = pending.splice(0);
      result = space;
    }
    if (path.startsWith("/api/bridge/dogma/module/repair/")) routes.push(path);
    if (path === "/api/bridge/call" && body.service === "dogmaIM") {
      calls.push(body);
      let answer: unknown = true;
      if (body.method === "InitiateModuleRepair" && options.begins) answer = options.begins();
      // The server mends the module when the repair is stopped, and not before.
      if (body.method === "StopModuleRepair") damage = 0;
      if (answer instanceof Error) return Response.json({ ok: false, error: "CALL_REFUSED", message: answer.message }, { status: 409 });
      result = { ok: true, service: "dogmaIM", method: body.method, result: answer, notifications: [] };
    }
    return Response.json(result);
  } });
  await flow.loadFitting();
  await flow.loadSpaceSnapshot();
  /** The server tells the pilot its session changed in what `names` says, with the next reading of the ship. */
  const sessionChanged = async (names: Record<string, unknown>): Promise<void> => {
    pending.push({ kind: "client", service: null, method: "OnSessionChanged", idType: "clientID", args: [names], kwargs: null });
    await flow.loadSpaceSnapshot();
  };
  return { store, flow, calls, routes, sessionChanged, damage: () => store.space.get().snapshot?.ship?.moduleDamage?.[WEB.itemID] ?? 0 };
}

const call = (method: string, moduleID: number) => ({ service: "dogmaIM", method, args: [moduleID], kwargs: null, pilot: true, confirm: true });
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>(resolve => setImmediate(resolve)); };

test("a repair is begun by the page's own call, and ended by the page when its time is up, as godma ends it", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, calls, routes, damage } = await harness();
  await flow.repairModule(WEB.itemID);
  // godma.py 2227: GetDogmaLM().InitiateModuleRepair(itemID), as a pilot's and as a write the page means.
  assert.deepEqual(calls, [call("InitiateModuleRepair", WEB.itemID)]);
  assert.deepEqual([store.targeting.get().lastAction, store.targeting.get().actionError, store.targeting.get().silentDecline], ["Repair", null, null]);
  assert.equal(damage(), WEB.damage, "nothing is mended yet");

  // A millisecond short of the time: nothing more. The time is 10 of 40 hit points at 10 a minute, and a second.
  context.mock.timers.tick(THE_WAIT_MS - 1);
  await settle();
  assert.equal(calls.length, 1);
  context.mock.timers.tick(1);
  await settle();
  // 2261: StopModuleRepair(itemID), godma's own doing. The ship is read again after it, and the module is whole.
  assert.deepEqual(calls.slice(1), [call("StopModuleRepair", WEB.itemID)]);
  assert.equal(damage(), 0);
  assert.deepEqual(routes, [], "neither route is asked");
});

test("a repair the server will not begin is not ended: its answer of False is taken as godma takes it", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, calls } = await harness({ begins: () => false });
  await flow.repairModule(WEB.itemID);
  assert.deepEqual(calls, [call("InitiateModuleRepair", WEB.itemID)]);
  assert.match(String(store.targeting.get().actionError), /^Repair refused: /);
  context.mock.timers.tick(10 * THE_WAIT_MS);
  await settle();
  assert.equal(calls.length, 1, "no repair was begun, so none is stopped");
});

test("a repair the server refuses is said in its words, and is not ended either", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, calls } = await harness({ begins: () => new Error("NotEnoughRepairMaterialToFinishAllRepairs") });
  await flow.repairModule(WEB.itemID);
  assert.match(String(store.targeting.get().actionError), /^Repair refused: /);
  context.mock.timers.tick(10 * THE_WAIT_MS);
  await settle();
  assert.deepEqual(calls, [call("InitiateModuleRepair", WEB.itemID)]);
});

test("a module being repaired is not begun again", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, flow, calls } = await harness();
  await flow.repairModule(WEB.itemID);
  await flow.repairModule(WEB.itemID);
  assert.equal(calls.length, 1);
  assert.match(String(store.targeting.get().actionError), /^Repair refused: .*being repaired/);
  context.mock.timers.tick(THE_WAIT_MS);
  await settle();
  assert.deepEqual(calls.map(each => each.method), ["InitiateModuleRepair", "StopModuleRepair"]);
});

test("where the repair's time cannot be worked out nothing is begun: no paste is taken for a repair nobody would end", async () => {
  // The character's repair rate is not among what godma was primed with.
  const { store, flow, calls, routes } = await harness({ rate: null });
  await flow.repairModule(WEB.itemID);
  assert.deepEqual([calls, routes], [[], []]);
  assert.match(String(store.targeting.get().actionError), /^Repair refused: .*how long/i);
  // Nor, each in a flow of its own: the module's hit points (its damage is known only as a share of them); a rate
  // of nought, which no time can be had from; and a module the ship's reading lists no damage for.
  for (const [why, options] of [["no hit points", { hp: null }], ["a rate of nought", { rate: 0 }], ["no damage read", { damage: 0 }]] as const) {
    const unknown = await harness(options);
    await unknown.flow.repairModule(WEB.itemID);
    assert.deepEqual([unknown.calls, unknown.routes], [[], []], why);
    assert.match(String(unknown.store.targeting.get().actionError), /^Repair refused: .*how long/i, why);
  }
});

test("a change of ship or of place ends every repair begun, as godma's own session change does", { timeout: 10_000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { flow, calls, sessionChanged } = await harness();
  await flow.repairModule(WEB.itemID);
  // godma.ProcessSessionChange (1156, 1199): a change that names the station, the system, the ship, the character
  // or the structure.
  await sessionChanged({ corpid: [1, 2] });
  await settle();
  assert.equal(calls.length, 1, "a change that names none of them ends nothing");
  await sessionChanged({ stationid: [null, 60003760] });
  await settle();
  assert.deepEqual(calls.slice(1), [call("StopModuleRepair", WEB.itemID)]);
  // And the time coming up afterwards ends nothing twice.
  context.mock.timers.tick(THE_WAIT_MS);
  await settle();
  assert.equal(calls.length, 2);
});
