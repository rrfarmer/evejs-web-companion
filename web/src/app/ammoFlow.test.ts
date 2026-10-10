// Loading and unloading ammunition through the page controller.
//
// What matters here is the SHAPE OF THE CALL and what happens to a refusal.
//
// The page makes the client's own calls (bridge/dogmaWrites.ts): the dogma
// location's LoadAmmo and UnloadAmmo, naming the ship the pilot is flying and
// the place the charges lie or go, as a client names them
// (clientDogmaLocation.py 973 to 1141). Until 2026-10-10 the page asked a route
// of the BFF for each with a WORD for the place, and the BFF named the ship and
// the place itself. The panel still says "cargo" or "hangar"; what each means
// is worked out here from what the session says of the pilot.
//
// Compatibility is deliberately NOT decided here. Which charges a module accepts
// lives in dogma attributes the browser has no allowlisted read for, so an
// incompatible charge is the server's refusal to give — surfaced as the fitting
// slice's action error, in the server's own words.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { spaceBody, SHIP_ID, SOLAR_SYSTEM_ID } from "./botFixtures.ts";

const MODULE_ID = 9988400094759;
const OTHER_MODULE_ID = 9988400094760;
const CHARGE_ID = 9988400094757;
const OTHER_CHARGE_ID = 9988400094758;
const CHARACTER_ID = 90000001;
const STATION_ID = 60003760;
const STRUCTURE_ID = 1030000000001;
/** invConst.flagHangar and flagCargo. */
const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;

interface Recorded {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

type Charge = { typeID: number; quantity: number } | null;

/** A fitting read whose one high slot holds `charge` (or nothing), in the ship the pilot is flying. */
function fittingBody(charge: Charge) {
  const rows: unknown[] = [
    { type: "packedrow", fields: { itemID: MODULE_ID, typeID: 485, groupID: 55, categoryID: 7, flagID: 27, quantity: -1 } },
  ];
  if (charge) {
    rows.push({
      type: "packedrow",
      fields: { itemID: 777, typeID: charge.typeID, groupID: 83, categoryID: 8, flagID: 27, quantity: charge.quantity },
    });
  }
  return {
    ok: true,
    activeShipID: SHIP_ID,
    slots: { type: "list", items: rows },
    shipInfo: {
      type: "dict",
      entries: [
        [
          SHIP_ID,
          {
            type: "object",
            name: "util.KeyVal",
            args: { type: "dict", entries: [["attributes", { type: "dict", entries: [[14, 4]] }]] },
          },
        ],
      ],
    },
    online: { type: "list", items: [MODULE_ID] },
    errors: {},
  };
}

interface Where {
  readonly stationID?: number | null;
  readonly structureID?: number | null;
}

/**
 * A flow for a pilot docked at Jita (or wherever `where` says), over a BFF whose
 * fitting read answers a scripted sequence of charge states and whose generic
 * call answers as the live server does: null, loaded or not, with `notifications`.
 * `refusal` makes the call a refusal in the server's words.
 */
function harness(options: {
  readonly where?: Where;
  /** No pilot is online: nothing has been chosen yet. */
  readonly nobody?: boolean;
  readonly states?: readonly Charge[];
  readonly notifications?: readonly unknown[];
  readonly refusal?: string;
} = {}) {
  const store = createClientStore();
  const docked = options.where ?? { stationID: STATION_ID };
  if (!options.nobody) store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Synthetic Pilot",
      stationID: docked.stationID ?? null,
      structureID: docked.structureID ?? null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000001,
    },
    station: null,
  });
  const requests: Recorded[] = [];
  const states = options.states ?? [null];
  let read = 0;
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input), "http://bff.test").pathname;
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    const respond = (status: number, payload: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
    });
    if (path === "/api/bridge/call" && body.service === "dogmaIM") {
      if (options.refusal !== undefined) return respond(409, { ok: false, error: "CALL_REFUSED", message: options.refusal });
      // The envelope the live server actually sends, loaded or not.
      return respond(200, { ok: true, service: "dogmaIM", method: body.method, result: null, notifications: options.notifications ?? [] });
    }
    if (path.startsWith("/api/bridge/fitting")) {
      const state = states[Math.min(read, states.length - 1)] ?? null;
      read += 1;
      return respond(200, fittingBody(state));
    }
    if (path === "/api/bridge/space/snapshot") return respond(200, spaceBody());
    return respond(200, { ok: true });
  }) as unknown as typeof fetch;
  const flow = createAppFlow(store, { fetch: fakeFetch });
  /** What the page asked of the dogma service, in order. */
  const calls = () => requests.filter((r) => r.path === "/api/bridge/call" && r.body.service === "dogmaIM").map((r) => r.body);
  /** The two routes, which nothing of the page's asks any more. */
  const routes = () => requests.filter((r) => r.path.startsWith("/api/bridge/dogma/ammo/")).map((r) => r.path);
  return { store, flow, requests, calls, routes };
}

const call = (method: string, args: unknown[]) => ({ service: "dogmaIM", method, args, kwargs: null, pilot: true, confirm: true });

test("ammunition is loaded by the page's own call: the ship, the one module, the stacks, and the ship as where they lie", async () => {
  const { flow, calls, routes } = harness();
  await flow.loadFitting();

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  // clientDogmaLocation.py 991: LoadAmmo(shipID, moduleID, [chargeItemID, ...], chargeLocationID), as every one
  // Tranquility has recorded: one module by its ID, and the ship twice.
  assert.deepEqual(calls(), [call("LoadAmmo", [SHIP_ID, MODULE_ID, [CHARGE_ID], SHIP_ID])]);
  assert.deepEqual(routes(), [], "the route is not asked");
});

test("several modules go as a list, and every stack named goes with them", async () => {
  const { flow, calls } = harness();
  await flow.loadFitting();

  await flow.loadAmmo([MODULE_ID, OTHER_MODULE_ID], [CHARGE_ID, OTHER_CHARGE_ID], "cargo");

  // 996: LoadAmmoToModules(shipID, moduleIDs, chargeItemIDs, ammoLocationID).
  assert.deepEqual(calls(), [call("LoadAmmo", [SHIP_ID, [MODULE_ID, OTHER_MODULE_ID], [CHARGE_ID, OTHER_CHARGE_ID], SHIP_ID])]);
});

test("from the hangar the charges lie where the pilot is docked: the station, or the structure before it", async () => {
  const station = harness();
  await station.flow.loadFitting();
  await station.flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");
  assert.deepEqual(station.calls(), [call("LoadAmmo", [SHIP_ID, MODULE_ID, [CHARGE_ID], STATION_ID])]);

  // session.structureid or session.stationid.
  const structure = harness({ where: { structureID: STRUCTURE_ID } });
  await structure.flow.loadFitting();
  await structure.flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");
  assert.deepEqual(structure.calls(), [call("LoadAmmo", [SHIP_ID, MODULE_ID, [CHARGE_ID], STRUCTURE_ID])]);

  const both = harness({ where: { stationID: STATION_ID, structureID: STRUCTURE_ID } });
  await both.flow.loadFitting();
  await both.flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");
  assert.deepEqual(both.calls(), [call("LoadAmmo", [SHIP_ID, MODULE_ID, [CHARGE_ID], STRUCTURE_ID])]);
});

test("from the hangar with the pilot in space nothing is asked: there is no hangar there, and the page says so", async () => {
  const { store, flow, calls, routes } = harness({ where: {} });
  await flow.loadFitting();

  const outcome = await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.equal(outcome, "refused");
  assert.deepEqual([calls(), routes()], [[], []]);
  assert.match(store.fitting.get().actionError ?? "", /docked/i);
});

test("with no ship known nothing is asked: the call names the ship, and the page will not guess one", async () => {
  const { store, flow, calls, routes } = harness({ where: {} });

  assert.equal(await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo"), "refused");
  assert.equal(await flow.unloadAmmo([MODULE_ID], "cargo"), "refused");

  assert.deepEqual([calls(), routes()], [[], []]);
  assert.match(store.fitting.get().actionError ?? "", /ship/i);
  // Once the ship has been read in space, that is the ship, with the fitting still unread.
  await flow.loadSpaceSnapshot();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");
  assert.deepEqual(calls()[0], call("LoadAmmo", [SHIP_ID, MODULE_ID, [CHARGE_ID], SHIP_ID]));
});

test("with no pilot online nothing is asked: the place is named with the pilot, and there is none", async () => {
  const { store, flow, calls, routes } = harness({ nobody: true });
  await flow.loadFitting();

  assert.equal(await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo"), "refused");
  assert.equal(await flow.unloadAmmo([MODULE_ID], "cargo"), "refused");

  assert.deepEqual([calls(), routes()], [[], []]);
  assert.match(store.fitting.get().actionError ?? "", /not known yet/);
});

test("ammunition is unloaded by the page's own call: the modules as a list, and the place as the client names one", async () => {
  const { flow, calls, routes } = harness();
  await flow.loadFitting();

  await flow.unloadAmmo([MODULE_ID], "cargo");
  await flow.unloadAmmo([MODULE_ID, OTHER_MODULE_ID], "hangar");

  // clientDogmaLocation.py 1140, with the destinations of fittingSlotController.py 180 to 187:
  // (the ship, the pilot, the cargo flag), and (where the pilot is docked, the pilot, the hangar flag).
  assert.deepEqual(calls(), [
    call("UnloadAmmo", [SHIP_ID, [MODULE_ID], [SHIP_ID, CHARACTER_ID, FLAG_CARGO]]),
    call("UnloadAmmo", [SHIP_ID, [MODULE_ID, OTHER_MODULE_ID], [STATION_ID, CHARACTER_ID, FLAG_HANGAR]]),
  ]);
  // No quantity is named: the modules are emptied, which is all the panel asks for.
  assert.deepEqual(routes(), [], "the route is not asked");
});

test("unloading to the hangar with the pilot in space asks nothing", async () => {
  const { store, flow, calls } = harness({ where: {}, states: [{ typeID: 184, quantity: 160 }] });
  await flow.loadFitting();

  assert.equal(await flow.unloadAmmo([MODULE_ID], "hangar"), "refused");

  assert.deepEqual(calls(), []);
  assert.match(store.fitting.get().actionError ?? "", /docked/i);
});

test("both verbs re-read the fit afterwards — the panel shows what the SERVER did", async () => {
  const { flow, requests } = harness();
  await flow.loadFitting();

  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  const order = requests.map((r) => r.path);
  const wrote = order.indexOf("/api/bridge/call");
  const reread = order.findIndex((p, i) => i > wrote && p.startsWith("/api/bridge/fitting"));
  assert.ok(wrote >= 0 && reread > wrote, "the fit is re-read after the load, not before");
});

// ⚠ THE INCOMPATIBLE-CHARGE PATH. The panel offers every charge in the chosen
// inventory on purpose, so this refusal is a NORMAL outcome rather than an edge
// case — it has to arrive in the player's words, not vanish.
test("⚠ a charge the module will not take surfaces the SERVER's own refusal", async () => {
  const { store, flow } = harness({ refusal: "That module cannot use that type of charge." });
  await flow.loadFitting();

  assert.equal(await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar"), "refused");

  assert.match(store.fitting.get().actionError ?? "", /cannot use that type of charge/i);
});

// --- ⚠ The silent decline ------------------------------------------------------
//
// MEASURED LIVE, and the reason this verification exists. dogmaIM.LoadAmmo
// returns null whether it loaded or refused, so the answer is the same flat
// envelope either way. Clicking "Load Arch Angel Carbonized Lead XL" into a
// 150mm Light AutoCannon I on a live Rifter produced exactly that, changed
// nothing, and told the player nothing at all. The RE-READ is the only authority.

test("⚠ a load that changed nothing is reported, not passed off as success", async () => {
  // Loaded before, identically loaded after: the XL round went nowhere.
  const loaded = { typeID: 184, quantity: 160 };
  const { store, flow } = harness({ states: [loaded, loaded] });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  const message = store.fitting.get().actionError ?? "";
  assert.match(message, /loaded nothing/i);
  assert.match(message, /gave no reason/i);
  // And it points at the real cause without diagnosing this particular call.
  assert.match(message, /only takes certain kinds of charge/i);
});

test("a load that DID change what is held says nothing", async () => {
  const { store, flow } = harness({ states: [null, { typeID: 184, quantity: 160 }] });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null);
});

test("reloading the same type but a different amount counts as a change", async () => {
  const { store, flow } = harness({ states: [{ typeID: 184, quantity: 40 }, { typeID: 184, quantity: 160 }] });

  await flow.loadFitting();
  await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null, "topping a stack up is a real load");
});

test("⚠ an unload that left the ammunition in place is reported", async () => {
  const loaded = { typeID: 184, quantity: 160 };
  const { store, flow } = harness({ states: [loaded, loaded] });

  await flow.loadFitting();
  await flow.unloadAmmo([MODULE_ID], "hangar");

  assert.match(store.fitting.get().actionError ?? "", /still loaded/i);
});

test("an unload that emptied the module says nothing", async () => {
  const { store, flow } = harness({ states: [{ typeID: 184, quantity: 160 }, null] });

  await flow.loadFitting();
  await flow.unloadAmmo([MODULE_ID], "hangar");

  assert.equal(store.fitting.get().actionError, null);
});

// In space the server QUEUES a load for the module's reload time, so the fit
// read straight after the call still shows the gun empty. Its announcement
// (`OnChargeBeingLoadedToModule`, which comes with the call's answer) is the
// proof the load is coming, and must not be reported as a load that did nothing.
const RELOAD_ANNOUNCED = {
  method: "OnChargeBeingLoadedToModule",
  args: [{ type: "list", items: [MODULE_ID] }, 184, 10000],
};

test("an in-space load the server queued and announced is reloading, not declined", async () => {
  const { store, flow } = harness({ where: {}, states: [null, null], notifications: [RELOAD_ANNOUNCED] });

  await flow.loadFitting();
  const outcome = await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  assert.equal(outcome, "reloading");
  assert.equal(store.fitting.get().actionError, null);
  const reload = store.fitting.get().reloads[MODULE_ID];
  assert.equal(reload?.chargeTypeID, 184);
  assert.equal(reload?.durationMs, 10000);
});

test("without the announcement an unchanged fit is still a decline", async () => {
  const { store, flow } = harness({ where: {}, states: [null, null] });

  await flow.loadFitting();
  const outcome = await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo");

  assert.equal(outcome, "unchanged");
  assert.match(store.fitting.get().actionError ?? "", /loaded nothing/i);
});

test("a load the fit shows is changed", async () => {
  const { flow } = harness({ where: {}, states: [null, { typeID: 184, quantity: 160 }] });

  await flow.loadFitting();
  assert.equal(await flow.loadAmmo([MODULE_ID], [CHARGE_ID], "cargo"), "changed");
});
