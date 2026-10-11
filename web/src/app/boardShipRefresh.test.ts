// Boarding a ship refreshes everything scoped to the hull (goal R87).
//
// ⚠ THE BUG. Boarding went through `runMutation`, which reloads the hangar and
// the cargo — so `activeShipID` updated and the item lists were right, and the
// panel looked like it had refreshed. Two things keyed to the HULL were not
// touched:
//
//   • `openShip` — the bays the Ship Inventory tab draws. It is opened once in
//     the panel's `onMount`, and the `inventory/loaded` reducer deliberately
//     preserves it across a reload, so it kept showing the bays of the ship the
//     player had just stepped out of.
//   • The fitting slice — an open Fitting window kept the previous hull's
//     modules.
//
// Both stale in the worst way: they look live, they are under the right heading,
// and nothing about them says they describe a different ship.

import test from "node:test";
import assert from "node:assert/strict";
import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "./flow.ts";
import { deriveShipStats } from "../bridge/shipStats.ts";

const OLD_SHIP = 9988400023309;
const NEW_SHIP = 9988400091901;
const VELDSPAR_TYPE = 1230;

interface Recorded {
  readonly path: string;
}

/**
 * A server where the active ship really changes when you board.
 *
 * `/api/bridge/inventory` answers with whatever hull is currently active, so the
 * flow's own reload is what moves the store on — exactly as it does live.
 */
function fakeServer(): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  let activeShipID = OLD_SHIP;

  const impl = (async (input: unknown, init?: { method?: string }) => {
    const path = String(input);
    requests.push({ path });
    let body: unknown = { ok: true };

    if (path === "/api/bridge/ship/board") {
      activeShipID = NEW_SHIP;
      body = { ok: true, activeShipID };
    } else if (path === "/api/bridge/inventory") {
      body = {
        ok: true,
        stationID: 60003760,
        activeShipID,
        hangar: { list: [], capacity: null, error: null },
        cargo: { list: [], capacity: null, error: null },
        volumes: {},
      };
    } else if (path.startsWith("/api/bridge/ship/") && path.endsWith("/bays")) {
      const shipID = Number(path.split("/")[4]);
      body = {
        ok: true,
        shipID,
        activeShipID,
        bays: [
          {
            key: "ore",
            label: "Ore hold",
            present: true,
            capacity: { capacity: shipID === OLD_SHIP ? 16000 : 400, used: 0 },
            items:
              shipID === OLD_SHIP
                ? [
                    {
                      itemID: 1,
                      typeID: VELDSPAR_TYPE,
                      groupID: 462,
                      categoryID: 25,
                      quantity: 123752,
                      singleton: false,
                    },
                  ]
                : [],
            error: null,
          },
        ],
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
    };
  }) as unknown as typeof fetch;

  return { fetch: impl, requests };
}

/** Board the old ship and open its bays, the way the panel does on mount. */
async function dockedWithOldShipOpen() {
  const store = createClientStore();
  const net = fakeServer();
  const flow = createAppFlow(store, { fetch: net.fetch });
  await flow.loadInventory();
  await flow.openShipBays(OLD_SHIP);
  return { store, net, flow };
}

test("boarding re-opens the bays of the ship you are NOW flying", async () => {
  const { store, flow } = await dockedWithOldShipOpen();
  assert.equal(store.get().inventory.openShip?.itemID, OLD_SHIP, "precondition");

  await flow.boardShip(NEW_SHIP);

  assert.equal(
    store.get().inventory.activeShipID,
    NEW_SHIP,
    "the active hull must have moved on",
  );
  assert.equal(
    store.get().inventory.openShip?.itemID,
    NEW_SHIP,
    "the Ship Inventory tab still shows the hull you stepped out of",
  );
});

test("the bays shown are the NEW hull's, not the old one's contents", async () => {
  // The sharpest form of the bug: the old hull was a Procurer with a 16,000 m³
  // ore hold holding 123,752 Veldspar. Keeping that on screen after boarding a
  // frigate is not a cosmetic staleness — it is a hold that does not exist.
  const { store, flow } = await dockedWithOldShipOpen();
  const before = store.get().inventory.openShip?.bays.find((bay) => bay.key === "ore");
  assert.equal(before?.capacity?.capacity, 16000, "precondition: the big ore hold");
  assert.equal(before?.items?.length, 1, "precondition: it holds ore");

  await flow.boardShip(NEW_SHIP);

  const after = store.get().inventory.openShip?.bays.find((bay) => bay.key === "ore");
  assert.equal(after?.capacity?.capacity, 400, "the new hull's own capacity");
  assert.deepEqual(after?.items, [], "the old hull's ore must not follow you");
});

test("boarding re-reads the FIT, because the modules belong to the hull", async () => {
  const { net, flow } = await dockedWithOldShipOpen();
  const before = net.requests.filter((r) => r.path === "/api/bridge/fitting").length;

  await flow.boardShip(NEW_SHIP);

  const after = net.requests.filter((r) => r.path === "/api/bridge/fitting").length;
  assert.ok(after > before, "an open Fitting window would keep the old hull's modules");
});

test("the bays are read for the hull the SERVER settled on, not the one asked for", async () => {
  // ⚠ The refresh reads `activeShipID` back out of the store AFTER the
  // mutation's own reload. A refused board leaves it unchanged, and re-reading
  // the ship we are actually in is right in both cases — asking for the
  // requested ship would show a hull the player never boarded.
  const { net, flow } = await dockedWithOldShipOpen();
  net.requests.length = 0;

  await flow.boardShip(NEW_SHIP);

  const bayReads = net.requests.filter((r) => r.path.includes("/bays"));
  assert.ok(bayReads.length > 0, "the bays must be re-read at all");
  for (const read of bayReads) {
    assert.match(
      read.path,
      new RegExp(`/${NEW_SHIP}/bays$`),
      `bays were read for the wrong hull: ${read.path}`,
    );
  }
});

test("leaving a ship closes the bays instead of leaving a ghost hull open", async () => {
  const store = createClientStore();
  const net = fakeServer();
  const flow = createAppFlow(store, { fetch: net.fetch });
  await flow.loadInventory();
  await flow.openShipBays(OLD_SHIP);

  // The server reports no active hull once you step out.
  const impl = (async (input: unknown) => {
    const path = String(input);
    net.requests.push({ path });
    const body =
      path === "/api/bridge/inventory"
        ? {
            ok: true,
            stationID: 60003760,
            activeShipID: null,
            hangar: { list: [], capacity: null, error: null },
            cargo: { list: [], capacity: null, error: null },
            volumes: {},
          }
        : path === "/api/bridge/call"
          // The page's own call for the ship left (bridge/shipWrites.ts), answered as a call is.
          ? { ok: true, service: "ship", method: "LeaveShip", result: null, notifications: [] }
          : { ok: true };
    return { ok: true, status: 200, async json() { return body; } };
  }) as unknown as typeof fetch;
  const leaving = createAppFlow(store, { fetch: impl });

  await leaving.leaveShip();

  assert.equal(store.get().inventory.actionError, null, "the leaving itself went through");
  assert.equal(net.requests.some((request) => request.path === "/api/bridge/call"), true, "by the page's own call");
  assert.equal(
    store.get().inventory.openShip,
    null,
    "a hull you are no longer in must not stay open",
  );
});

// --- R88: the store makes it impossible, not merely unlikely -----------------
//
// R87 put the fix in the CALLERS: board/leave re-read the hull-scoped views.
// That works until something else changes the active ship — a server push, a
// bot, an eject, a hull destroyed under you — and then the same silent
// staleness is back. These exercise the store directly, with no flow involved,
// because that is where the guarantee now lives.

function inventoryEvent(activeShipID: number | null) {
  return {
    type: "inventory/loaded" as const,
    stationID: 60003760,
    activeShipID,
    hangar: { rows: [], capacity: null, error: null },
    cargo: { rows: [], capacity: null, error: null },
  };
}

function withFitAndOpenShip(activeShipID: number) {
  const store = createClientStore();
  store.apply(inventoryEvent(activeShipID) as never);
  store.apply({
    type: "inventory/ship-open",
    itemID: activeShipID,
    typeID: 622,
  } as never);
  store.apply({
    type: "fitting/loaded",
    activeShipID,
    slots: [],
    resources: {
      cpu: { used: 0, total: 0, known: false },
      powergrid: { used: 0, total: 0, known: false },
      capacitor: { used: 0, total: 0, known: false },
      calibration: { used: 0, total: 0, known: false },
    },
    stats: deriveShipStats(new Map()),
    slotsError: null,
    resourcesError: null,
  } as never);
  return store;
}

test("the STORE drops a fit that belongs to a hull you are no longer in", () => {
  const store = withFitAndOpenShip(OLD_SHIP);
  assert.equal(store.get().fitting.loaded, true, "precondition: a fit is loaded");

  store.apply(inventoryEvent(NEW_SHIP) as never);

  assert.equal(
    store.get().fitting.loaded,
    false,
    "the previous hull's modules must not survive the swap",
  );
});

test("the STORE drops a bays card that was tracking the hull you were flying", () => {
  const store = withFitAndOpenShip(OLD_SHIP);
  store.apply(inventoryEvent(NEW_SHIP) as never);
  assert.equal(store.get().inventory.openShip, null);
});

test("a bays card opened on some OTHER ship is KEPT", () => {
  // Looking inside a hull parked in the hangar is a deliberate pick, and it is
  // still true after boarding something else. Closing it would throw the pick
  // away for no reason.
  const store = createClientStore();
  store.apply(inventoryEvent(OLD_SHIP) as never);
  const OTHER = 9988400055555;
  store.apply({ type: "inventory/ship-open", itemID: OTHER, typeID: 622 } as never);

  store.apply(inventoryEvent(NEW_SHIP) as never);

  assert.equal(store.get().inventory.openShip?.itemID, OTHER);
});

test("the FIRST load is not a hull change", () => {
  // ⚠ activeShipID moves from null to a real hull on the first read. Treating
  // that as a swap would make every character coming online throw away the fit
  // it had just been given. Same three-valued reasoning the dock transition
  // needed, for the same reason.
  const store = createClientStore();
  store.apply({
    type: "fitting/loaded",
    activeShipID: OLD_SHIP,
    slots: [],
    resources: {
      cpu: { used: 0, total: 0, known: false },
      powergrid: { used: 0, total: 0, known: false },
      capacitor: { used: 0, total: 0, known: false },
      calibration: { used: 0, total: 0, known: false },
    },
    stats: deriveShipStats(new Map()),
    slotsError: null,
    resourcesError: null,
  } as never);

  store.apply(inventoryEvent(OLD_SHIP) as never);

  assert.equal(store.get().fitting.loaded, true, "the first reading discarded a good fit");
});

test("a reload with the SAME hull keeps everything", () => {
  // The ordinary case: polling, a move, a stack. Nothing about the ship changed,
  // so nothing hull-scoped may be thrown away.
  const store = withFitAndOpenShip(OLD_SHIP);
  store.apply(inventoryEvent(OLD_SHIP) as never);
  assert.equal(store.get().fitting.loaded, true);
  assert.equal(store.get().inventory.openShip?.itemID, OLD_SHIP);
});
