// A fleet companion's reload, driven through the real flow over a faked BFF.
//
// The ladder's own tests (nav/fleetCompanionLoop.test.ts) prove WHEN a companion
// reloads and with which stack. This proves what the flow then sends: the
// client's own call (bridge/dogmaWrites.ts), the dogma location's LoadAmmo with
// the ship the pilot is flying named as where the charges lie, as a pilot's and
// as a write the page means. Until 2026-10-10 it asked a route of the BFF.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { DEFAULT_FLEET_COMPANION_REQUEST, type FleetCompanionRequest } from "../nav/fleetCompanionLoop.ts";
import { SHIP_ID, SOLAR_SYSTEM_ID, fittingBody, flightBody, holdsBody, namesBody, spaceBody } from "./botFixtures.ts";

// Synthetic ids, neighbours of the documented 90000001 example.
const OWN_CHARACTER_ID = 90000001;
const HUMAN_FLEET_MEMBER = 90000011;
const GUN = 9988400037300;
const OTHER_GUN = 9988400037301;
const GUN_TYPE = 7369;
const CHARGE_STACK = 9988400037400;
const CHARGE_TYPE = 230;
const CHARGE_GROUP = 85;

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

/** A fleet with a human in it, so that the companion is supervised and its own ladder runs. */
function fleetBody(): unknown {
  const emptyDict = { type: "dict", entries: [] };
  return {
    ok: true,
    characterID: OWN_CHARACTER_ID,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", "Ready up."],
          ["fleetID", 90000002],
          ["members", { type: "dict", entries: [[HUMAN_FLEET_MEMBER, keyVal([["charID", HUMAN_FLEET_MEMBER], ["role", 1]])]] }],
          ["squads", emptyDict],
          ["wings", emptyDict],
        ]),
      },
      GetWings: { result: emptyDict },
      GetMotd: { result: "Ready up." },
      GetJoinRequests: { result: emptyDict },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  };
}

/** The fixture ship with `guns` fitted, online and empty, each taking hybrid charges. */
function gunsFitted(guns: readonly number[]): unknown {
  const body = fittingBody({
    extraModules: guns.map((itemID, at) => ({ itemID, typeID: GUN_TYPE, flagID: 29 + at, groupID: 74, name: "250mm Railgun", groupName: "Hybrid Weapon" })),
  }) as Record<string, unknown>;
  return { ...body, chargeFits: { [GUN_TYPE]: { size: 2, groups: [CHARGE_GROUP] } } };
}

/** The hold, with one stack of charges the guns take. */
function holdBody(): unknown {
  const empty = { list: { type: "list", items: [] }, capacity: null, error: null };
  return {
    ok: true,
    stationID: null,
    activeShipID: SHIP_ID,
    hangar: empty,
    cargo: {
      shipID: SHIP_ID,
      list: { type: "list", items: [{ type: "packedrow", fields: { itemID: CHARGE_STACK, typeID: CHARGE_TYPE, groupID: CHARGE_GROUP, categoryID: 8, flagID: 5, quantity: 2000, stacksize: 2000, locationID: SHIP_ID } }] },
      capacity: null,
      error: null,
    },
  };
}

function harness(guns: readonly number[]) {
  const asked: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input), "http://bff.test").pathname;
    const body = (init && typeof init.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    asked.push({ path, body });
    return { ok: true, status: 200, async json() { return respond(path, body); } };
  }) as unknown as typeof fetch;
  function respond(path: string, body: Record<string, unknown>): unknown {
    if (path === "/api/bridge/flight/status") return flightBody(false);
    if (path === "/api/bridge/space/snapshot") return spaceBody();
    if (path === "/api/bridge/fitting") return gunsFitted(guns);
    if (path === "/api/bridge/inventory") return holdBody();
    if (path === "/api/bridge/ship/ore-hold") return holdsBody(0, []);
    if (path === "/api/names") {
      // The guns are known for weapons by how the game files their type: the companion reads its guns off the hull.
      const base = namesBody(body) as { names: Record<string, string> };
      const names = { ...base.names };
      for (const item of (body.items ?? []) as { kind: string; id: number }[]) {
        if (item.id === GUN_TYPE && item.kind === "type") names[`type:${GUN_TYPE}`] = "250mm Railgun";
        if (item.id === GUN_TYPE && item.kind === "typeGroup") names[`typeGroup:${GUN_TYPE}`] = "Hybrid Weapon";
      }
      return { ok: true, source: "static-data", count: Object.keys(names).length, names, unresolved: [] };
    }
    if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
    if (path === "/api/bridge/bound-fleet") return fleetBody();
    if (path === "/api/bridge/chat/local") return { ok: true, chat: { roomName: "Local", corporationID: null, solarSystemID: null, messages: [], roster: [] } };
    if (path === "/api/bridge/call") return { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
    return { ok: true };
  }
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: { characterID: OWN_CHARACTER_ID, characterName: "Synthetic Pilot", stationID: null, structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: 98000001 },
    station: null,
  });
  const flow = createAppFlow(store, { fetch: fakeFetch });
  const loads = () => asked.filter((each) => each.path === "/api/bridge/call" && each.body.service === "dogmaIM").map((each) => each.body);
  const routes = () => asked.filter((each) => each.path.startsWith("/api/bridge/dogma/ammo/")).map((each) => each.path);
  return { store, flow, loads, routes };
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const call = (args: unknown[]) => ({ service: "dogmaIM", method: "LoadAmmo", args, kwargs: null, pilot: true, confirm: true });

test("a companion's empty gun is loaded from the hold by the page's own call: the ship, the gun, the stack, and the ship again", { timeout: 10000 }, async () => {
  const { flow, loads, routes } = harness([GUN]);
  const request: FleetCompanionRequest = { ...DEFAULT_FLEET_COMPANION_REQUEST, weaponModuleIDs: [GUN] };
  await flow.startFleetCompanion(request);
  try {
    await waitFor(() => loads().length > 0, "the reload");
    // clientDogmaLocation.py 991: one module by its ID.
    assert.deepEqual(loads()[0], call([SHIP_ID, GUN, [CHARGE_STACK], SHIP_ID]));
    assert.deepEqual(routes(), [], "the route is not asked");
  } finally {
    flow.stopFleetCompanion();
  }
});

test("several empty guns that take the same stack go in one call, as a list", { timeout: 10000 }, async () => {
  const { flow, loads, routes } = harness([GUN, OTHER_GUN]);
  const request: FleetCompanionRequest = { ...DEFAULT_FLEET_COMPANION_REQUEST, weaponModuleIDs: [GUN, OTHER_GUN] };
  await flow.startFleetCompanion(request);
  try {
    await waitFor(() => loads().length > 0, "the reload");
    // 996: LoadAmmoToModules(shipID, moduleIDs, [the one stack], where it lies).
    assert.deepEqual(loads()[0], call([SHIP_ID, [GUN, OTHER_GUN], [CHARGE_STACK], SHIP_ID]));
    assert.deepEqual(routes(), []);
  } finally {
    flow.stopFleetCompanion();
  }
});
