// A ship's weapons linked and unlinked from the page, through the real flow over a faked BFF.
//
// The flow's own test of this verb (writeVerification.test.ts) reads its source for the snapshot check. What it
// sends was reached by no test.
//
// It sends the client's own calls (bridge/dogmaWrites.ts): the dogma location's LinkAllWeapons(shipID) and
// UnlinkAllModules(shipID) (clientDogmaLocation.py 794 and 800), each naming the ship the pilot is flying, as the
// group-all button names session.shipid (groupAllIcon.py 36 and 38). The button is dead for two seconds after a
// request of its kind was answered (UpdateGroupAllButton). Until 2026-10-10 the page asked a route of the BFF for
// each, which named the ship itself.

import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { fittingBody, namesBody, spaceBody, SHIP_ID, SOLAR_SYSTEM_ID, STRIP_MINER_ITEM_IDS } from "./botFixtures.ts";

const [MASTER, SLAVE] = STRIP_MINER_ITEM_IDS as readonly [number, number];

/** A flow in the fixture ship, over a BFF whose server links and unlinks as it is asked, or answers with `refuses`. */
async function harness(options: { readonly refuses?: () => string | null; readonly fitted?: boolean } = {}) {
  const store = createClientStore();
  store.apply({ type: "character/online", character: {
    characterID: 140000005, characterName: "Test", stationID: null,
    structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000000,
  }, station: null });
  /** What the page asked of the server for the banks, in order. */
  const calls: Record<string, unknown>[] = [];
  const routes: string[] = [];
  let linked = false;
  const flow = createAppFlow(store, { livePush: false, fetch: async (input, init) => {
    const path = new URL(String(input), "http://bff.test").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/fitting") result = fittingBody();
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/bridge/space/snapshot") {
      const space = spaceBody() as { space: { ship: Record<string, unknown> } };
      space.space.ship.weaponBanks = linked ? { [String(MASTER)]: [SLAVE] } : {};
      result = space;
    }
    if (path.startsWith("/api/bridge/dogma/weapons/")) routes.push(path);
    if (path === "/api/bridge/call" && body.service === "dogmaIM") {
      calls.push(body);
      const refusal = options.refuses?.() ?? null;
      if (refusal !== null) return Response.json({ ok: false, error: "CALL_REFUSED", message: refusal }, { status: 409 });
      linked = body.method === "LinkAllWeapons";
      result = { ok: true, service: "dogmaIM", method: body.method, result: linked ? { type: "dict", entries: [[MASTER, [SLAVE]]] } : null, notifications: [] };
    }
    return Response.json(result);
  } });
  if (options.fitted !== false) await flow.loadFitting();
  return { store, flow, calls, routes };
}

const call = (method: string) => ({ service: "dogmaIM", method, args: [SHIP_ID], kwargs: null, pilot: true, confirm: true });
const said = (store: ReturnType<typeof createClientStore>) => [store.targeting.get().lastAction, store.targeting.get().actionError, store.targeting.get().silentDecline];

test("the weapons are linked and unlinked by the page's own calls, each naming the ship the pilot is flying", async () => {
  const { store, flow, calls, routes } = await harness();
  await flow.setWeaponBanks(true);
  // clientDogmaLocation.py 800: remoteDogmaLM.LinkAllWeapons(shipID), as a pilot's and as a write the page means.
  assert.deepEqual(calls, [call("LinkAllWeapons")]);
  assert.deepEqual(said(store), ["Link weapons", null, null]);
  await flow.setWeaponBanks(false);
  // 794: UnlinkAllModules(shipID).
  assert.deepEqual(calls.slice(1), [call("UnlinkAllModules")]);
  assert.deepEqual(said(store), ["Unlink weapons", null, null]);
  assert.deepEqual(routes, [], "neither route is asked");
});

test("a request is not made again inside two seconds of one of its kind being answered, as the client's button is dead then", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const { store, flow, calls } = await harness();
  await flow.setWeaponBanks(true);
  await flow.setWeaponBanks(false);
  // Linking again at once: the last link was answered less than two seconds ago. Nothing is asked.
  await flow.setWeaponBanks(true);
  assert.deepEqual(calls.map(each => each.method), ["LinkAllWeapons", "UnlinkAllModules"]);
  assert.match(String(store.targeting.get().actionError), /^Link weapons refused: .*moment/);
  // The other kind is its own wait: unlinking was answered just now too.
  await flow.setWeaponBanks(false);
  assert.equal(calls.length, 2);
  assert.match(String(store.targeting.get().actionError), /^Unlink weapons refused: .*moment/);
  // Two seconds on, both go.
  context.mock.timers.tick(2000);
  await flow.setWeaponBanks(true);
  await flow.setWeaponBanks(false);
  assert.deepEqual(calls.slice(2), [call("LinkAllWeapons"), call("UnlinkAllModules")]);
});

test("a refusal is said in the server's words, and does not start the wait: the same can be asked again at once", async () => {
  let refusal: string | null = "CantLinkModuleNotOnline";
  const { store, flow, calls } = await harness({ refuses: () => refusal });
  await flow.setWeaponBanks(true);
  assert.deepEqual(calls, [call("LinkAllWeapons")]);
  assert.match(String(store.targeting.get().actionError), /^Link weapons refused: /);
  refusal = null;
  await flow.setWeaponBanks(true);
  assert.deepEqual(calls.slice(1), [call("LinkAllWeapons")]);
  assert.equal(store.targeting.get().actionError, null);
});

test("with no ship known nothing is asked: the call names the ship, and the page will not guess one", async () => {
  const { store, flow, calls, routes } = await harness({ fitted: false });
  await flow.setWeaponBanks(true);
  assert.deepEqual([calls, routes], [[], []]);
  assert.match(String(store.targeting.get().actionError), /^Link weapons refused: .*ship/);
  // Once the ship has been read in space, that is the ship, with the fitting still unread.
  await flow.loadSpaceSnapshot();
  await flow.setWeaponBanks(true);
  assert.deepEqual(calls, [call("LinkAllWeapons")]);
});
