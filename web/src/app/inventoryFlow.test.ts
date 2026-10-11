// The R3 Inventory & Ship controller against a faked BFF: loadInventory decodes
// the raw hangar/cargo reads into the store; move/stack/board run their BFF
// mutation then reload; failures surface through the store; a lost session
// unwinds to offline.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function inventoryPanel(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    stationID: 60003760,
    activeShipID: 9001,
    hangar: {
      list: {
        type: "list",
        items: [
          packedRow({ itemID: 100, typeID: 34, categoryID: 4, flagID: 4, quantity: 750, singleton: 0 }),
          packedRow({ itemID: 200, typeID: 597, categoryID: 6, flagID: 4, quantity: 1, singleton: 1 }),
        ],
      },
      capacity: { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["capacity", 1000000], ["used", 7.5]] } },
      error: null,
    },
    cargo: {
      shipID: 9001,
      list: { type: "object", name: "__builtin__.set", args: [{ type: "list", items: [] }] },
      capacity: { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["capacity", 135], ["used", 0]] } },
      error: null,
    },
    ...overrides,
  };
}

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

test("loadInventory decodes the hangar and cargo reads into the store", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return { status: 200, body: inventoryPanel() };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadInventory();

  const inv = store.inventory.get();
  assert.equal(inv.loaded, true);
  assert.equal(inv.stationID, 60003760);
  assert.equal(inv.activeShipID, 9001);
  assert.equal(inv.hangar.rows.length, 2);
  assert.deepEqual(inv.hangar.capacity, { capacity: 1000000, used: 7.5 });
  assert.equal(inv.cargo.rows.length, 0);
  assert.deepEqual(inv.cargo.capacity, { capacity: 135, used: 0 });
});

test("a failed container read is surfaced without blanking the other container", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: inventoryPanel({
      cargo: { shipID: 9001, list: null, capacity: null, error: "NO_ACTIVE_SHIP" },
    }),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadInventory();

  const inv = store.inventory.get();
  assert.equal(inv.hangar.rows.length, 2, "hangar still shows");
  assert.equal(inv.cargo.error, "NO_ACTIVE_SHIP");
});

test("moveItem posts the move then reloads the panel", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory/move") {
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.moveItem(100, "toCargo", 250);

  const move = requests.find((r) => r.path === "/api/bridge/inventory/move");
  assert.ok(move, "move was posted");
  assert.deepEqual(move!.body, { itemID: 100, direction: "toCargo", qty: 250 });
  // A reload followed the mutation.
  assert.ok(requests.some((r) => r.path === "/api/bridge/inventory" && r.method === "GET"));
  assert.equal(store.inventory.get().loaded, true);
  assert.equal(store.inventory.get().actionError, null);
});

test("stackContainer and boardShip post their BFF mutations then reload", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory/stack") {
      return { status: 200, body: { ok: true } };
    }
    if (path === "/api/bridge/ship/board") {
      return { status: 200, body: { ok: true, activeShipID: 200 } };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.stackContainer("hangar");
  await flow.boardShip(200);

  const stack = requests.find((r) => r.path === "/api/bridge/inventory/stack");
  assert.deepEqual(stack!.body, { target: "hangar" });
  const board = requests.find((r) => r.path === "/api/bridge/ship/board");
  assert.deepEqual(board!.body, { shipID: 200 });
  assert.equal(requests.filter((r) => r.path === "/api/bridge/inventory").length, 2);
});

/** The generic call's answer to a ship left. */
const LEFT = { status: 200, body: { ok: true, service: "ship", method: "LeaveShip", result: null, notifications: [] } };
/** station.TryLeaveShip (248): GetShipAccess().LeaveShip(shipid), as a pilot's write the page means. */
const theLeaving = (shipID: number) => ({ service: "ship", method: "LeaveShip", args: [shipID], kwargs: null, pilot: true, confirm: true });

test("boardCorvette posts its confirmed ship swap, and leaveShip makes the page's own call for the ship the pilot is in; each then reloads", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/ship/board-corvette") {
      return { status: 200, body: { ok: true, applied: true } };
    }
    if (path === "/api/bridge/call") {
      return LEFT;
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  // Load first so leaveShip can name the real active hull.
  await flow.loadInventory();
  await flow.boardCorvette();
  await flow.leaveShip();

  const corvette = requests.find((r) => r.path === "/api/bridge/ship/board-corvette");
  assert.ok(corvette, "board-corvette was posted");
  assert.deepEqual(corvette!.body, { confirm: true });
  assert.deepEqual(requests.filter((r) => r.path === "/api/bridge/call").map((r) => r.body), [theLeaving(9001)]);
  assert.equal(requests.some((r) => r.path === "/api/bridge/ship/leave"), false, "the route is not asked");
  // Each mutation reloaded the panel (plus the explicit initial load).
  assert.equal(requests.filter((r) => r.path === "/api/bridge/inventory" && r.method === "GET").length, 3);
  assert.equal(store.inventory.get().actionError, null);
});

test("leaveShip before the panel has loaded asks the pilot's flight which ship it is in, and names that one", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: false, docked: true, stationID: 60003760, solarSystemID: 30000142, shipID: 7007 }, notifications: [] } };
    }
    if (path === "/api/bridge/call") {
      return LEFT;
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.leaveShip();

  const order = requests.map((r) => r.path).filter((path) => path === "/api/bridge/flight/status" || path === "/api/bridge/call");
  assert.deepEqual(order, ["/api/bridge/flight/status", "/api/bridge/call"]);
  assert.deepEqual(requests.find((r) => r.path === "/api/bridge/call")!.body, theLeaving(7007));
});

test("with no ship known from the panel or the flight, nothing is asked to be left, and the page says so", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: false, docked: true, stationID: 60003760, shipID: null }, notifications: [] } };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.leaveShip();

  assert.equal(requests.some((r) => r.path === "/api/bridge/call" || r.path === "/api/bridge/ship/leave"), false);
  assert.match(String(store.inventory.get().actionError), /Which ship this is is not known yet/);
});

test("a leaving the server refuses is said in the panel, in its words", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/call") {
      return { status: 409, body: { ok: false, error: "CALL_REFUSED", message: "A session change is already in progress." } };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadInventory();
  await flow.leaveShip();

  assert.match(String(store.inventory.get().actionError), /A session change is already in progress/);
});

test("a refused mutation is surfaced through the store, not thrown", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory/move") {
      return { status: 403, body: { ok: false, error: "CALL_NOT_ALLOWED", message: "nope" } };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.moveItem(100, "toCargo");

  // R31 — surfaced, in words. The point of the test is that it is surfaced
  // at all rather than thrown, and that is unchanged.
  assert.equal(
    store.inventory.get().actionError,
    "This client is not allowed to ask the game server for that.",
  );
  // No reload after a failed mutation (only the failed move was requested).
  assert.equal(requests.filter((r) => r.path === "/api/bridge/inventory").length, 0);
});

test("a lost session during a mutation flips the character offline and rethrows", async () => {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: 140000003,
      characterName: "Test Three",
      stationID: 60003760,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 98000000,
    },
    station: null,
  });
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(() => flow.boardShip(200));
  assert.equal(store.station.get().online, null, "character flipped offline");
});

// --- Station repair shop -----------------------------------------------------
// The docked panel's "Repair ship" is a QUOTE first and a charge second, so the
// two halves are tested apart: the quote names the hull and everything fitted
// to it and reports only what the shop calls damaged; the repair posts exactly
// the ids it was given, confirmed.

function fittingPanel() {
  return {
    ok: true,
    activeShipID: 9001,
    stationID: 60003760,
    slots: { type: "list", items: [packedRow({ itemID: 5001, typeID: 3634, groupID: 53, flagID: 27 })] },
    // The hull's own slot counts (14 high / 13 mid / 12 low / 1137 rig) — without
    // them the fit has nowhere to put the module and the quote would miss it.
    shipInfo: {
      type: "dict",
      entries: [
        [
          9001,
          {
            type: "object",
            name: "util.KeyVal",
            args: {
              type: "dict",
              entries: [
                ["itemID", 9001],
                ["attributes", { type: "dict", entries: [[14, 4], [13, 2], [12, 5], [1137, 3]] }],
              ],
            },
          },
        ],
      ],
    },
    online: { type: "list", items: [5001] },
    errors: { slots: null, shipInfo: null, online: null },
  };
}

test("quoteShipRepair quotes the hull and its fitted modules, and reports only the damaged", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/fitting") {
      return { status: 200, body: fittingPanel() };
    }
    if (path.startsWith("/api/bridge/station/repair-quotes")) {
      return {
        status: 200,
        body: {
          ok: true,
          quotes: {
            type: "dict",
            entries: [
              [9001, { type: "list", items: [{ type: "packedrow", fields: { cost: 1250 } }] }],
              [5001, { type: "list", items: [] }],
            ],
          },
        },
      };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadInventory();
  const quote = await flow.quoteShipRepair();

  const asked = requests.find((r) => r.path.startsWith("/api/bridge/station/repair-quotes"));
  assert.ok(asked, "the shop was asked for a quote");
  assert.match(asked!.path, /itemIDs=9001,5001$/, "the hull and the fitted module were quoted");
  assert.deepEqual(quote, [{
    itemID: 9001,
    repairItemIDs: [9001],
    damagedParts: 1,
    parts: [{ itemID: 9001, typeID: null, damage: null, maxHealth: null, cost: 1250 }],
    cost: 1250,
  }]);
});

test("quoteShipRepair with no hull to quote asks nothing and answers null", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/fitting") {
      return { status: 200, body: { ...fittingPanel(), activeShipID: null, slots: { type: "list", items: [] } } };
    }
    return { status: 200, body: inventoryPanel({ activeShipID: null }) };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadInventory();

  assert.equal(await flow.quoteShipRepair(), null);
  assert.equal(
    requests.filter((r) => r.path.startsWith("/api/bridge/station/repair-quotes")).length,
    0,
    "nothing to quote must not reach the shop",
  );
});

test("repairShip posts the confirmed repair for exactly the quoted ids, then reloads", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/station/repair") {
      return { status: 200, body: { ok: true, result: null } };
    }
    if (path === "/api/bridge/fitting") {
      return { status: 200, body: fittingPanel() };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.repairShip([9001]);

  const repair = requests.find((r) => r.path === "/api/bridge/station/repair");
  assert.ok(repair, "the repair was posted");
  assert.deepEqual(repair!.body, { itemIDs: [9001], confirm: true });
  assert.ok(requests.some((r) => r.path === "/api/bridge/inventory" && r.method === "GET"), "the panel reloaded");
  assert.equal(store.inventory.get().actionError, null);
});

test("a refused repair surfaces the server's words instead of charging silently", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/station/repair") {
      return {
        status: 400,
        body: { ok: false, error: "CALL_REFUSED", message: "You cannot afford these repairs." },
      };
    }
    return { status: 200, body: inventoryPanel() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.repairShip([9001]);

  // R31 — the handler's OWN sentence, surfaced rather than thrown.
  assert.match(store.inventory.get().actionError ?? "", /cannot afford these repairs/);
});
