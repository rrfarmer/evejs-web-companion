// The Drones window's bay stays TRUE, instead of being read once and believed
// for the rest of the session.
//
// ⚠ THE BUG, AS REPORTED. "Drones window does not show any drones, even if
// Inventory & Ship does show them." Both windows read the same flag off the
// same hull through the same bind, and the BFF answers both identically — so
// the difference was never in the read. It was in WHEN:
//
//   • `DronesPanel` asks for the slice only `if (!$drones.loaded)`, and `loaded`
//     lives in the STORE, not in the component. Closing the window and opening
//     it again therefore re-reads nothing at all.
//   • Nothing else re-read it. `OnItemsChanged` — the frame that fires when
//     anything in any inventory moves — scheduled the mining holds and only the
//     mining holds. Moving drones into the bay from Inventory & Ship refreshed
//     that panel and left this one saying "Nothing in the drone bay".
//   • And the slice is HULL-KEYED (bay stacks, both launch limits, whether a
//     drone in space answers to this ship), but R88's hull-change invalidation
//     dropped the fit and the dogma snapshot and left the drones behind. Board a
//     drone boat after the window had read an empty pod bay once, and it stayed
//     empty for good.
//
// So: the store drops it when the hull changes, and the flow re-reads it when
// items move — the same two halves R88 gave the fit.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

const CHARACTER_ID = 90000001;
const POD = 9988400000001;
const DRONE_BOAT = 9988400000002;
const HOBGOBLIN_TYPE = 2454;

// --- the store half ----------------------------------------------------------

function inventoryEvent(activeShipID: number | null) {
  return {
    type: "inventory/loaded" as const,
    stationID: 60003760,
    activeShipID,
    hangar: { rows: [], capacity: null, error: null },
    cargo: { rows: [], capacity: null, error: null },
  };
}

function dronesLoadedEvent() {
  return {
    type: "drones/loaded" as const,
    bay: [{ itemID: 101, typeID: HOBGOBLIN_TYPE, quantity: 5 }],
    inSpace: [],
    limits: { maxActiveDrones: 5, droneBandwidth: 25 },
  };
}

function storeFlyingWithDrones(activeShipID: number) {
  const store = createClientStore();
  store.apply(inventoryEvent(activeShipID) as never);
  store.apply(dronesLoadedEvent() as never);
  return store;
}

test("the STORE drops a drone bay that belongs to a hull you are no longer in", () => {
  const store = storeFlyingWithDrones(DRONE_BOAT);
  assert.equal(store.get().drones.loaded, true, "precondition: the bay was read");

  store.apply(inventoryEvent(POD) as never);

  assert.equal(
    store.get().drones.loaded,
    false,
    "the previous hull's bay must not survive the swap",
  );
  assert.equal(store.get().drones.bay, null, "and it must read as UNKNOWN, never as empty");
});

test("the two launch limits go with the hull as well", () => {
  // They are the ship's own dogma attributes. A pod showing a battleship's five
  // drones and 25 Mbit/sec is not a cosmetic staleness — it is an invitation to
  // launch something that cannot be launched.
  const store = storeFlyingWithDrones(DRONE_BOAT);
  store.apply(inventoryEvent(POD) as never);

  assert.equal(store.get().drones.limits.maxActiveDrones, null);
  assert.equal(store.get().drones.limits.droneBandwidth, null);
});

test("the FIRST load is not a hull change", () => {
  // activeShipID moves from null to a real hull the first time we look. Reading
  // that as a swap would throw away a bay that has just been read — the same
  // three-valued reasoning the fit needed.
  const store = createClientStore();
  store.apply(dronesLoadedEvent() as never);

  store.apply(inventoryEvent(DRONE_BOAT) as never);

  assert.equal(store.get().drones.loaded, true, "the first reading discarded a good bay");
});

test("a reload with the SAME hull keeps the bay", () => {
  // The ordinary case: a poll, a move, a stack. Nothing about the ship changed,
  // so nothing hull-scoped may be thrown away.
  const store = storeFlyingWithDrones(DRONE_BOAT);
  store.apply(inventoryEvent(DRONE_BOAT) as never);
  assert.equal(store.get().drones.loaded, true);
  assert.equal(store.get().drones.bay?.length, 1);
});

// --- the flow half -----------------------------------------------------------

interface FakeSource extends EventSourceLike {
  emit(frame: unknown): void;
  open(): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (): EventSourceLike => {
    const source: FakeSource = {
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      open() {
        source.onopen?.();
      },
      close() {},
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

function itemsChangedFrame(sequence: number, method = "OnItemsChanged", args: unknown[] = []) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "epoch-1", sequence },
    event: {
      kind: "notification",
      notification: {
        kind: "client",
        service: null,
        method,
        args,
        kwargs: null,
      },
    },
  };
}

/**
 * A world whose drone bay is EMPTY until something puts drones in it — which is
 * exactly the shape of the report: the bay the window read first is not the bay
 * the player is looking at.
 */
function makeWorld() {
  const state = { droneReads: 0, bayLoaded: false };
  const fetchImpl = (async (input: unknown) => {
    const path = String(input);
    let body: unknown = { ok: true };
    if (path === "/api/bridge/select") {
      body = {
        ok: true,
        character: {
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
        },
        station: null,
        notifications: [],
      };
    } else if (path === "/api/bridge/drones") {
      state.droneReads += 1;
      body = {
        ok: true,
        activeShipID: DRONE_BOAT,
        bay: state.bayLoaded ? [{ itemID: 101, typeID: HOBGOBLIN_TYPE, quantity: 5 }] : [],
        inSpace: [],
        shipInfo: null,
        errors: {},
      };
    } else if (path === "/api/bridge/inventory") {
      body = {
        ok: true,
        stationID: 60003760,
        activeShipID: DRONE_BOAT,
        hangar: { list: [], capacity: null, error: null },
        cargo: { list: [], capacity: null, error: null },
        volumes: {},
      };
    } else if (path === "/api/bridge/inventory/transfer") {
      // The move itself is what put the drones in the bay.
      state.bayLoaded = true;
      body = { ok: true, applied: true, moved: [101], declined: [], notifications: [] };
    }
    return { ok: true, status: 200, async json() { return body; } };
  }) as unknown as typeof fetch;
  return { state, fetch: fetchImpl };
}

async function onlineFlow() {
  const store = createClientStore();
  const world = makeWorld();
  const { factory, sources } = makeFakeEventSource();
  const flow = createAppFlow(store, { fetch: world.fetch, eventSource: factory });
  await flow.selectCharacter(CHARACTER_ID);
  const source = sources[0];
  assert.ok(source, "coming online must open the live event channel");
  source.open();
  return { store, flow, source, state: world.state };
}

/** Let the flow's OnItemsChanged coalescing window close. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600));
}

test("drones moved INTO the bay show up in the window that launches them", async () => {
  const { store, flow, state } = await onlineFlow();
  // The window is open and has read an empty bay — the state every report of
  // this bug starts from.
  await flow.loadDrones();
  assert.deepEqual(store.get().drones.bay, [], "precondition: the window read an empty bay");

  await flow.transferItems([101], { kind: "hangar" }, { kind: "shipBay", bay: "drone" });

  assert.equal(store.get().drones.bay?.length, 1, "the drones just loaded are not on screen");
  assert.equal(state.droneReads > 1, true, "the bay was never re-read");
});

test("a session that never opened the Drones window pays for no drone read", async () => {
  // The cost control. One drones read is three calls on the BFF, and
  // OnItemsChanged fires on every ore grant of every mining cycle.
  const { flow, state } = await onlineFlow();
  assert.equal(state.droneReads, 0, "precondition: nothing has asked for drones");

  await flow.transferItems([101], { kind: "hangar" }, { kind: "cargo" });

  assert.equal(state.droneReads, 0, "an unopened window must cost nothing");
});

test("a bay changed by something ELSE is re-read off the live frame", async () => {
  // A drone destroyed in space, a bot loading the bay, the game's own client on
  // the same character: no call of ours returns, and this frame is the only word
  // we get.
  const { store, flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;
  state.bayLoaded = true;

  source.emit(itemsChangedFrame(1));
  await settle();

  assert.equal(state.droneReads > before, true, "the frame did not reach the bay");
  assert.equal(store.get().drones.bay?.length, 1);
});

test("a BURST of item frames costs ONE re-read", async () => {
  // Mining grants ore stack by stack, so a busy cycle pushes several frames at
  // once. They must coalesce, exactly as the holds' own refresh does.
  const { flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;

  for (let index = 0; index < 6; index += 1) {
    source.emit(itemsChangedFrame(index + 1));
  }
  await settle();

  assert.equal(state.droneReads - before, 1, "one coalescing window, one read");
});

test("a live frame on a session that never opened the window reads nothing", async () => {
  const { source, state } = await onlineFlow();

  source.emit(itemsChangedFrame(1));
  await settle();

  assert.equal(state.droneReads, 0);
});

// --- one item's move ---------------------------------------------------------
//
// The server tells of SEVERAL items' moves by OnItemsChanged and of ONE item's by
// OnItemChange (its characterState.js sends the second unless a batch is asked
// for). A drone landing in its bay is one item. Seen in the tab on 2026-10-10: a
// drone the server had in the bay was still read "Coming home" by the window
// minutes later, since only the first name made the page look again.
//
// Which moves: the ones the client's drones window reads again on
// (dronesWindow.OnItemChange, 254 to 260; bridge/droneBayNotices.ts).

const SYSTEM = 30000142;
/** One item's move as the server sends it: the item as it now is, and what it was, by column (3 where, 4 which flag). */
function oneItemFrame(sequence: number, locationID: number, flagID: number, was: (readonly [number, number])[]) {
  const fields = { itemID: 101, typeID: HOBGOBLIN_TYPE, ownerID: CHARACTER_ID, locationID, flagID, quantity: -1, groupID: 100, categoryID: 18, customInfo: "", stacksize: 1, singleton: 1 };
  return itemsChangedFrame(sequence, "OnItemChange", [{ type: "packedrow", fields }, { type: "dict", entries: was }, null]);
}
const landed = (sequence: number) => oneItemFrame(sequence, DRONE_BOAT, 87, [[3, SYSTEM], [4, 0]]);

test("a drone come home is told as ONE item, and the window is read again on it", async () => {
  const { store, flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;
  state.bayLoaded = true;

  source.emit(landed(1));
  await settle();

  assert.equal(state.droneReads - before, 1, "the one-item frame did not reach the bay");
  assert.equal(store.get().drones.bay?.length, 1);
});

test("one item moved into the HOLD is not the drones' business, and nothing is read", async () => {
  const { flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;

  source.emit(oneItemFrame(1, DRONE_BOAT, 5, [[3, 60003760], [4, 4]]));
  await settle();

  assert.equal(state.droneReads, before);
});

test("the ship whose bay it is, is the one the drones were last read for", async () => {
  // The same row on another ship is not this window's.
  const { flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;

  source.emit(oneItemFrame(1, POD, 87, [[3, SYSTEM], [4, 0]]));
  await settle();

  assert.equal(state.droneReads, before);
});

test("the two names together still cost ONE re-read", async () => {
  // A landing sends the item's row and its dogma together, and a batch may follow.
  const { flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;

  for (let index = 0; index < 6; index += 1) {
    source.emit(index % 2 === 0 ? landed(index + 1) : itemsChangedFrame(index + 1));
  }
  await settle();

  assert.equal(state.droneReads - before, 1, "one coalescing window, one read");
});

test("a one-item frame on a session that never opened the window reads nothing", async () => {
  const { source, state } = await onlineFlow();

  source.emit(landed(1));
  await settle();

  assert.equal(state.droneReads, 0);
});

test("a frame of another name is no item's move, and nothing is read", async () => {
  const { flow, source, state } = await onlineFlow();
  await flow.loadDrones();
  const before = state.droneReads;

  source.emit(itemsChangedFrame(1, "OnGodmaPrimeItem", landed(1).event.notification.args));
  await settle();

  assert.equal(state.droneReads, before);
});
