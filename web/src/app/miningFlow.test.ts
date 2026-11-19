// The R23 slice B controller against a faked BFF: holds, survey, quote,
// unload, reprocess.
//
// What is pinned here is mostly what the flow REFUSES to claim. Both mutating
// actions move or consume real property, so neither trusts its own 200: the BFF
// re-reads and the flow reports what that re-read said. Three outcomes stay
// distinct, where a naive client would collapse all of them into "done":
//
//   refused             -> the server's own reason, verbatim
//   changed nothing     -> a silent decline, said plainly, with no cause invented
//   could not be checked -> "unknown", which is neither success nor decline
//
// And one number gets special care: the station's reprocessing TAX is debited
// from the player's wallet, so an unknown rate must never render as 0.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) => { status: number; body: unknown },
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

const ORE_STACK_ID = 8800001;
const ICE_STACK_ID = 8800002;

const HOLDS = [
  {
    key: "ore",
    label: "Ore hold",
    present: true,
    capacity: { capacity: 5000, used: 120 },
    items: [{ itemID: ORE_STACK_ID, typeID: 1230, quantity: 500 }],
    error: null,
  },
];

function holdsBody(): unknown {
  return { ok: true, activeShipID: 9001, stationID: 60003760, holds: HOLDS };
}

/**
 * The page's own unloading into the pilot's hangar (app/flow.ts, unloadToOwnHangar, since 2026-10-14): the pilot's
 * flight docked, the hangar's move through the generic call, and the holds read before it and after it, holding after
 * it what `stays` names of what was asked (null: the read after fails). Null for any other request.
 */
function unloading(stays: (asked: number[]) => number[] | null) {
  let asked: number[] | null = null;
  return (path: string, _method: string, body: Record<string, unknown>): { status: number; body: unknown } | null => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60003760, structureID: null, shipID: 9001 }, notifications: [] } };
    }
    if (path === "/api/bridge/call" && body.service === "invbroker") {
      const args = body.args as unknown[];
      asked = body.method === "MultiAdd" ? (args[0] as number[]) : [args[0] as number];
      return { status: 200, body: { ok: true, service: "invbroker", method: body.method, result: null, notifications: [] } };
    }
    if (path === "/api/bridge/ship/ore-hold" && asked !== null) {
      const moved = asked;
      const left = stays(moved);
      if (left === null) return { status: 502, body: { ok: false, error: "CALL_REFUSED", message: "Read failed" } };
      return { status: 200, body: { ok: true, activeShipID: 9001, stationID: 60003760,
        holds: HOLDS.map((hold) => ({ ...hold, items: hold.items.filter((item) => left.includes(item.itemID) || !moved.includes(item.itemID)) })) } };
    }
    return null;
  };
}

/** A pilot online, docked at 60003760 in the ship 9001: whose the refinery's output is. */
function pilotOnline(store: ReturnType<typeof createClientStore>): void {
  store.apply({ type: "character/online", character: {
    characterID: 140000001, characterName: "Pilot", stationID: 60003760, structureID: null, solarSystemID: 30000142, corporationID: 98000000,
  }, station: null });
}

/**
 * The page's own reprocessing (app/flow.ts, reprocessNow, since 2026-10-14): the pilot's flight docked, the hangar
 * (`hangar`: its items' numbers), and the refinery's Reprocess through the generic call answering what `said` names
 * of what it was asked (null: an answer that says nothing), or refusing with `refusal`. Null for any other request.
 */
function refinery(said: (asked: number[]) => number[] | null, hangar: number[] = [], refusal: string | null = null) {
  return (path: string, _method: string, body: Record<string, unknown>): { status: number; body: unknown } | null => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60003760, structureID: null, shipID: 9001 }, notifications: [] } };
    }
    if (path === "/api/bridge/inventory") {
      return { status: 200, body: { ok: true, stationID: 60003760, structureID: null, activeShipID: 9001, volumes: {},
        hangar: { list: { type: "list", items: hangar.map((itemID) => ({ type: "packedrow", fields: { itemID, typeID: 1228, groupID: 460, categoryID: 25, flagID: 4, quantity: 700, singleton: 0 } })) }, capacity: null, error: null },
        cargo: { list: { type: "list", items: [] }, capacity: null, error: null } } };
    }
    if (path === "/api/bridge/call" && body.method === "Reprocess") {
      if (refusal !== null) return { status: 409, body: { ok: false, error: "CALL_REFUSED", message: refusal } };
      const done = said((body.args as number[][])[0]!);
      return { status: 200, body: { ok: true, service: "reprocessingSvc", method: "Reprocess", result: done === null ? null : [{ type: "list", items: done }, { type: "dict", entries: [] }], notifications: [] } };
    }
    return null;
  };
}

// --- Reads ------------------------------------------------------------------

test("loadMiningHolds lands the holds, by name", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/ship/ore-hold") {
      return { status: 200, body: holdsBody() };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadMiningHolds();
  const state = store.mining.get();
  assert.equal(state.holdsLoaded, true);
  assert.equal(state.holds[0]?.label, "Ore hold");
  assert.equal(state.holds[0]?.items?.length, 1);
});

test("a failed holds read is surfaced, not swallowed", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 409,
    body: { ok: false, error: "NO_ACTIVE_SHIP", message: "No active ship." },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadMiningHolds();
  assert.equal(
    store.mining.get().holdsError,
    "Your holds could not be read: You are not in a ship right now.",
  );
});

test("runSurveyScan lands what the scanner saw, with its zeroes intact", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: {
      ok: true,
      results: [
        [50001248, 1230, 4200],
        [50001249, 1228, 0],
      ],
      notifications: [],
    },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.runSurveyScan();
  const survey = store.mining.get().survey;
  assert.equal(survey.length, 2);
  assert.equal(survey[1]?.remainingQuantity, 0, "a mined-out rock is a real answer");
  assert.ok((store.mining.get().surveyAtMs ?? 0) > 0, "the scan is timestamped");
});

test("disabling the overlay clears scan data and discards a survey response already in flight", async () => {
  const store = createClientStore();
  store.apply({ type: "mining/survey", survey: [{ itemID: 11, yieldTypeID: 1230, remainingQuantity: 90 }], atMs: 1 });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const { fetch } = makeFakeFetch(() => ({
    status: 200, body: { ok: true, results: [[11, 1230, 80]], notifications: [] },
  }));
  const flow = createAppFlow(store, { fetch: async (...args) => { await delayed; return fetch(...args); } });
  const pending = flow.runSurveyScan();
  flow.clearSurveyScan();
  release();
  assert.equal(await pending, null);
  assert.equal(store.mining.get().surveyAtMs, null);
  assert.deepEqual(store.mining.get().survey, []);
  assert.equal(store.mining.get().surveyProgress.size, 0);
  await flow.runSurveyScan();
  assert.equal(store.mining.get().survey[0]?.remainingQuantity, 80);
});

test("runSurveyScan from a ship the BFF asked nothing for lands no scan, and says why", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: { ok: true, asked: false, scannerUpgrade: 0, results: null, notifications: [] },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.runSurveyScan();
  assert.deepEqual(store.mining.get().survey, []);
  assert.equal(store.mining.get().surveyAtMs, null, "no scan was made");
  assert.equal(store.mining.get().surveyError, "No scan was made: this ship has no mining scanner upgrade.");
});

test("loadReprocessingQuote lands the quote AND the station's tax", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(() => ({
    status: 200,
    body: {
      ok: true,
      stationID: 60003760,
      taxRate: 0.05,
      quotes: [
        {
          itemID: ORE_STACK_ID,
          typeID: 1230,
          quantityToProcess: 500,
          leftOvers: 0,
          iskCost: 1234.5,
          outputs: [{ typeID: 34, quantity: 1000 }],
        },
      ],
    },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadReprocessingQuote([ORE_STACK_ID]);
  const state = store.mining.get();
  assert.equal(state.taxRate, 0.05);
  assert.equal(state.quotes[0]?.iskCost, 1234.5);
  assert.deepEqual(state.quotesFor, [ORE_STACK_ID]);
  assert.match(requests[0]?.path ?? "", /itemIDs=/);
});

test("⚠ an unknown tax rate stays NULL — never 0", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: { ok: true, stationID: 1, taxRate: null, quotes: [] },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadReprocessingQuote([ORE_STACK_ID]);
  assert.equal(
    store.mining.get().taxRate,
    null,
    "reprocessing debits this from the wallet — a wrong 0 says the refinery is free",
  );
});

test("a failed quote CLEARS the previous one rather than leaving stale numbers up", async () => {
  const store = createClientStore();
  let fail = false;
  const { fetch } = makeFakeFetch(() =>
    fail
      ? { status: 409, body: { ok: false, error: "NOT_DOCKED", message: "Dock first." } }
      : {
          status: 200,
          body: {
            ok: true,
            stationID: 1,
            taxRate: 0.05,
            quotes: [{ itemID: ORE_STACK_ID, typeID: 1230, outputs: [] }],
          },
        },
  );
  const flow = createAppFlow(store, { fetch });

  await flow.loadReprocessingQuote([ORE_STACK_ID]);
  assert.equal(store.mining.get().quotes.length, 1);

  fail = true;
  await flow.loadReprocessingQuote([ICE_STACK_ID]);
  const state = store.mining.get();
  assert.deepEqual(state.quotes, [], "a stale quote could arm a confirmation for other stacks");
  assert.equal(state.taxRate, null);
  // R31 — the refusal still says the quote failed and why; NOT_DOCKED is now
  // explained rather than named.
  assert.equal(
    state.quotesError,
    "The refinery could not quote that: Your ship is in space. That can only be done while docked.",
  );
});

// --- Unloading --------------------------------------------------------------

test("unloadMiningHolds reports success quietly, and re-reads the holds", async () => {
  const store = createClientStore();
  const answers = unloading(() => []);
  const { fetch, requests } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.unloadMiningHolds([ORE_STACK_ID]);
  // The hangar's own Add, the whole stack, from the ship it lies in, as the page moves one stack (bridge/inventoryWrites.ts).
  assert.deepEqual(requests.filter((entry) => entry.path === "/api/bridge/call").map((entry) => entry.body), [
    { service: "invbroker", method: "Add", args: [ORE_STACK_ID, 9001], kwargs: { qty: 500, flag: 4 }, pilot: true, confirm: true, of: "hangar" },
  ]);
  const state = store.mining.get();
  assert.equal(state.lastAction, "Unload");
  assert.equal(state.silentDecline, null);
  assert.equal(state.actionError, null);
  assert.ok(
    requests.some((entry) => entry.path === "/api/bridge/ship/ore-hold"),
    "the holds are re-read so the panel shows the truth after the move",
  );
});

test("an unload that moved NOTHING is a silent decline, with no cause invented", async () => {
  const store = createClientStore();
  const answers = unloading((asked) => asked);
  const { fetch } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.unloadMiningHolds([ORE_STACK_ID]);
  const state = store.mining.get();
  assert.equal(state.actionError, null, "nothing was refused");
  assert.match(state.silentDecline ?? "", /gave no reason/i);
  assert.doesNotMatch(state.silentDecline ?? "", /full|capacity|space|room/i);
});

test("a PARTIAL unload says exactly how much moved", async () => {
  // (The ice stack is in no hold the read gives, so it is moved by nobody, and stays unmoved.)
  const store = createClientStore();
  const answers = unloading(() => []);
  const { fetch } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.unloadMiningHolds([ORE_STACK_ID, ICE_STACK_ID]);
  assert.match(store.mining.get().silentDecline ?? "", /Only 1 of 2/);
});

test("an unload that could not be VERIFIED says 'unknown', not success", async () => {
  const store = createClientStore();
  // The holds cannot be read again after the move.
  const answers = unloading(() => null);
  const { fetch } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.unloadMiningHolds([ORE_STACK_ID]);
  assert.match(store.mining.get().silentDecline ?? "", /unknown/i);
});

test("an unload refusal carries the server's own reason", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 409,
    body: { ok: false, error: "NOT_DOCKED", message: "Dock at a station before unloading." },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.unloadMiningHolds([ORE_STACK_ID]);
  // R31 — NOT_DOCKED is explained rather than shown. The refusal is still a
  // refusal, and silentDecline is still null, which is what this test is for.
  assert.equal(
    store.mining.get().actionError,
    "Unload refused: Your ship is in space. That can only be done while docked.",
  );
  assert.equal(store.mining.get().silentDecline, null);
});

// --- Reprocessing -----------------------------------------------------------

test("reprocessItems is the page's own Reprocess: a hold's stack as the ship's, the output the hangar of where the pilot is docked", async () => {
  // itemReprocessor.Reprocess (13 to 41, 71): one call for each place, Reprocess(itemIDs, fromLocation, ownerID,
  // outputLocationID, outputFlagID), the output the window's own (the hangar, the pilot's).
  const store = createClientStore();
  pilotOnline(store);
  const answers = refinery((asked) => asked);
  const { fetch, requests } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.reprocessItems([ORE_STACK_ID]);
  const calls = requests.filter((entry) => entry.path === "/api/bridge/call").map((entry) => entry.body);
  assert.deepEqual(calls, [
    { service: "reprocessingSvc", method: "Reprocess", args: [[ORE_STACK_ID], 9001, 140000001, 60003760, 4], kwargs: null, pilot: true, confirm: true },
  ]);
  assert.equal(store.mining.get().silentDecline, null);
});

test("after reprocessing, the stale quote is dropped", async () => {
  const store = createClientStore();
  pilotOnline(store);
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/reprocessing/quote") {
      return { status: 200, body: { ok: true, taxRate: 0.05, quotes: [] } };
    }
    if (path.startsWith("/api/bridge/reprocessing/quote")) {
      return {
        status: 200,
        body: {
          ok: true,
          taxRate: 0.05,
          quotes: [{ itemID: ORE_STACK_ID, typeID: 1230, outputs: [] }],
        },
      };
    }
    return refinery((asked) => asked)(path, "", {}) ?? { status: 200, body: holdsBody() };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadReprocessingQuote([ORE_STACK_ID]);
  await flow.reprocessItems([ORE_STACK_ID]);
  const state = store.mining.get();
  assert.deepEqual(state.quotes, [], "the quote described stacks that no longer exist");
  assert.equal(state.taxRate, null);
});

test("a reprocess that consumed NOTHING is a silent decline", async () => {
  const store = createClientStore();
  pilotOnline(store);
  const answers = refinery(() => []);
  const { fetch } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.reprocessItems([ORE_STACK_ID]);
  assert.match(store.mining.get().silentDecline ?? "", /Nothing was reprocessed/i);
});

test("a refinery refusal carries the server's own reason", async () => {
  const store = createClientStore();
  pilotOnline(store);
  const answers = refinery(() => null, [], "You do not have enough ISK to pay the reprocessing tax.");
  const { fetch } = makeFakeFetch((path, method, body) => answers(path, method, body) ?? { status: 200, body: holdsBody() });
  const flow = createAppFlow(store, { fetch });

  await flow.reprocessItems([ORE_STACK_ID]);
  assert.match(store.mining.get().actionError ?? "", /enough ISK/);
});

// --- The Mining window's own read, and the hangar after what changes it ---------

const FLIGHT = { inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60003760, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null };
const hangarBody = () => ({
  ok: true, stationID: 60003760, structureID: null, activeShipID: 9001, volumes: {},
  hangar: { list: { type: "list", items: [{ type: "packedrow", fields: { itemID: 7700001, typeID: 1228, groupID: 460, categoryID: 25, flagID: 4, quantity: 700, singleton: 0 } }] }, capacity: null, error: null },
  cargo: { list: { type: "list", items: [] }, capacity: null, error: null },
});
/** A flow whose BFF answers the holds, the hangar (or refuses it) and the two actions, with every request listed. */
function windowFlow(options: { docked?: boolean; hangarRefused?: boolean } = {}) {
  const store = createClientStore();
  pilotOnline(store);
  store.apply({ type: "flight/status", status: { ...FLIGHT, docked: options.docked !== false, inSpace: options.docked === false } });
  // The refining is the page's own since 2026-10-14 (app/flow.ts, reprocessNow): the flight read, the hangar read for
  // each item's place, and the plant's Reprocess through the generic call, which says it reprocessed what it was asked.
  let hangarReads = 0;
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody() };
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: options.docked === false, docked: options.docked !== false, solarSystemID: 30000142, stationID: options.docked === false ? null : 60003760, structureID: null, shipID: 9001 }, notifications: [] } };
    }
    // The unloading into the pilot's own hangar is the page's own since 2026-10-14 (app/flow.ts, unloadToOwnHangar).
    if (path === "/api/bridge/call" && body.service === "invbroker") return { status: 200, body: { ok: true, service: "invbroker", method: body.method, result: null, notifications: [] } };
    if (path === "/api/bridge/inventory") {
      hangarReads += 1;
      // (A refused hangar is the window's read after the refining; the refining's own read of the places is answered.)
      return options.hangarRefused && hangarReads > 1 ? { status: 409, body: { ok: false, error: "NOT_DOCKED", message: "Dock first." } } : { status: 200, body: hangarBody() };
    }
    if (path === "/api/bridge/call" && body.method === "Reprocess") {
      return { status: 200, body: { ok: true, service: "reprocessingSvc", method: "Reprocess", result: [{ type: "list", items: (body.args as number[][])[0] }, { type: "dict", entries: [] }], notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const paths = () => requests.map((entry) => entry.path);
  return { store, flow: createAppFlow(store, { fetch }), paths };
}

test("the Mining window's read is the holds, and the hangar too where the pilot is docked; in space the holds alone; a hangar that cannot be read fails nothing", async () => {
  const docked = windowFlow();
  await docked.flow.loadMiningWindow();
  assert.deepEqual(docked.paths(), ["/api/bridge/ship/ore-hold", "/api/bridge/inventory"]);
  assert.deepEqual([docked.store.mining.get().holdsLoaded, docked.store.inventory.get().hangar.rows.map((each) => each.itemID)], [true, [7700001]]);
  const inSpace = windowFlow({ docked: false });
  await inSpace.flow.loadMiningWindow();
  assert.deepEqual(inSpace.paths(), ["/api/bridge/ship/ore-hold"]);
  const refused = windowFlow({ hangarRefused: true });
  await refused.flow.loadMiningWindow();
  assert.deepEqual([refused.paths(), refused.store.mining.get().holdsLoaded, refused.store.mining.get().holdsError], [["/api/bridge/ship/ore-hold", "/api/bridge/inventory"], true, null]);
});

test("after an unloading and after a refining the hangar is read again where the pilot is docked, for what went into it and what was made", async () => {
  const unloaded = windowFlow();
  await unloaded.flow.unloadMiningHolds([ORE_STACK_ID]);
  // (The flight, the holds read for the stacks, the hangar's move and the holds read for what stayed; then the
  // window's reads.)
  assert.deepEqual(unloaded.paths(), ["/api/bridge/flight/status", "/api/bridge/ship/ore-hold", "/api/bridge/call", "/api/bridge/ship/ore-hold", "/api/bridge/ship/ore-hold", "/api/bridge/inventory"]);
  const refined = windowFlow();
  await refined.flow.reprocessItems([7700001]);
  // (The flight and the hangar read for the stack's place, the plant's call, then the window's reads.)
  assert.deepEqual(refined.paths(), ["/api/bridge/flight/status", "/api/bridge/inventory", "/api/bridge/call", "/api/bridge/ship/ore-hold", "/api/bridge/inventory"]);
  assert.deepEqual([refined.store.mining.get().silentDecline, refined.store.mining.get().actionError], [null, null]);
  // In space the unloading is refused before anything else is asked (as its route refused it), and no hangar is
  // read; and a hangar that cannot be read fails no refining.
  const inSpace = windowFlow({ docked: false });
  await inSpace.flow.unloadMiningHolds([ORE_STACK_ID]);
  assert.deepEqual(inSpace.paths(), ["/api/bridge/flight/status"]);
  assert.ok(inSpace.store.mining.get().actionError);
  const refused = windowFlow({ hangarRefused: true });
  await refused.flow.reprocessItems([7700001]);
  assert.deepEqual([refused.store.mining.get().lastAction, refused.store.mining.get().actionError], ["Reprocess", null]);
});

// --- A refining that leaves what its quote said it would -------------------------

test("a refining that leaves only the stacks its quote said were too few is no decline: nothing is said of them; a stack left that the quote would have refined is", async () => {
  const TOO_FEW = 7700002;
  const OTHER = 7700003;
  /** A flow whose plant quotes each stack with what is to process of it, and reprocesses what `processed` names. */
  const quotedThenRefined = async (toProcess: Record<number, number | null>, processed: number[], quoteFirst = true) => {
    const store = createClientStore();
    pilotOnline(store);
    const ids = Object.keys(toProcess).map(Number);
    // Each stack in the hangar, and the plant saying it reprocessed what `processed` names of what it was asked.
    const answers = refinery((asked) => asked.filter((itemID) => processed.includes(itemID)), ids);
    const { fetch } = makeFakeFetch((path, method, body) => {
      if (path.startsWith("/api/bridge/reprocessing/quote")) {
        return { status: 200, body: { ok: true, taxRate: 0.05, quotes: ids.map((itemID) => ({ itemID, typeID: 1230, quantityToProcess: toProcess[itemID], leftOvers: 50, iskCost: 0, outputs: [] })) } };
      }
      return answers(path, method, body) ?? { status: 200, body: holdsBody() };
    });
    const flow = createAppFlow(store, { fetch });
    if (quoteFirst) await flow.loadReprocessingQuote(ids);
    await flow.reprocessItems(ids);
    return store.mining.get().silentDecline;
  };
  // One refined, and one the quote said had nothing to process: as foretold, and nothing is said.
  assert.equal(await quotedThenRefined({ [ORE_STACK_ID]: 1000, [TOO_FEW]: 0 }, [ORE_STACK_ID]), null);
  // A stack the quote would have refined is left as well: that one is told of, with the count of all that were asked.
  assert.match(await quotedThenRefined({ [ORE_STACK_ID]: 1000, [TOO_FEW]: 0, [OTHER]: 300 }, [ORE_STACK_ID]) ?? "", /Only 1 of 3 stacks were reprocessed/);
  // A quote that did not say what there was to process of a stack foretold nothing of it.
  assert.match(await quotedThenRefined({ [ORE_STACK_ID]: 1000, [TOO_FEW]: null }, [ORE_STACK_ID]) ?? "", /Only 1 of 2 stacks were reprocessed/);
  // With no quote on the page for them nothing was foretold.
  assert.match(await quotedThenRefined({ [ORE_STACK_ID]: 1000, [TOO_FEW]: 0 }, [ORE_STACK_ID], false) ?? "", /Only 1 of 2 stacks were reprocessed/);
  // Nothing refined at all is said as it was, whatever the quote said.
  assert.match(await quotedThenRefined({ [ORE_STACK_ID]: 0, [TOO_FEW]: 0 }, []) ?? "", /Nothing was reprocessed/);
});
