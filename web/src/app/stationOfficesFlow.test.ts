// The lobby's offices on the page.
//
// The retail client's lobby lists the corporations with an office in the station, and how many offices are free,
// when its Offices tab is shown, and lists them again at each office rented or given up, whoever's it is
// (dockedUI/offices.py: LoadPanel, OnOfficeRentalChanged). The page lists them when the player asks, and from then
// on at each notice. Before the player has asked, a notice lists nothing: the client's panel is not loaded either.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { panelErrorWords } from "../bridge/refusals.ts";

const PILOT = 140000003;
const CORPORATION = 98000001;
const STATION = 60003760;

interface PushSource {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/** A docked pilot online with its live channel open. `answer` is what the offices read answers now; `hold` keeps an answer back until it is let go. */
async function docked() {
  const store = createClientStore();
  const state: { answer: unknown; fail: boolean; hold: Promise<void> | null; flight: unknown; price: unknown; refuse: string | null; refusal: { status: number; error: string; message: string } | null } = {
    answer: { ok: true, available: true, stationID: STATION, corporationIDs: [98000000, 98000003], freeOffices: 17 },
    fail: false,
    hold: null,
    // The pilot's flight: docked in the station.
    flight: { inSpace: false, docked: true, stationID: STATION, structureID: null, solarSystemID: 30000142, shipID: 9001 },
    // What the station's office manager answers for a price.
    price: 10000,
    refuse: null,
    // A call the server refuses, as the BFF hands the refusal on.
    refusal: null,
  };
  let reads = 0;
  const sent: Array<[string, unknown]> = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    let status = 200;
    let answer: unknown = { ok: true };
    if (path === "/api/bridge/select") {
      answer = { ok: true, character: { characterID: PILOT, characterName: "Test Three", stationID: STATION, structureID: null, solarSystemID: 30000142, corporationID: CORPORATION }, droneRecoveryCheckID: "check-1" };
    } else if (path === "/api/bridge/station/offices") {
      reads += 1;
      const answered = state.answer;
      if (state.hold) await state.hold;
      if (state.fail) {
        status = 502;
        answer = { ok: false, error: "EVE_GATEWAY_UNREACHABLE", message: "The game server is unreachable." };
      } else {
        answer = answered;
      }
    } else if (path.startsWith("/api/bridge/station/office/")) {
      // The three routes the page asked before: none of them is asked now, and one asked would show here.
      sent.push([path, body]);
    } else if (path === "/api/bridge/flight/status") {
      answer = { ok: true, flight: state.flight, notifications: [] };
    } else if (path === "/api/bridge/call" && body.service === "officeManager") {
      sent.push([body.method, body]);
      if (state.refusal) {
        status = state.refusal.status;
        answer = { ok: false, error: state.refusal.error, message: state.refusal.message };
      } else if (state.refuse) {
        status = 502;
        answer = { ok: false, error: "EVE_GATEWAY_CALL_FAILED", message: state.refuse };
      } else {
        answer = { ok: true, service: body.service, method: body.method, result: body.method === "GetPriceQuote" ? state.price : null, notifications: [] };
      }
    } else if (path === "/api/bridge/call") {
      answer = { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
    }
    return { ok: status >= 200 && status < 300, status, async json() { return answer; } };
  }) as unknown as typeof fetch;
  const sources: PushSource[] = [];
  const eventSource = (): PushSource => {
    const source: PushSource = { onmessage: null, onopen: null, onerror: null, close() {} };
    sources.push(source);
    return source;
  };
  const flow = createAppFlow(store, { fetch: fetchImpl, eventSource });
  await flow.selectCharacter(PILOT);
  const source = sources[0];
  assert.ok(source, "coming online opens the live channel");
  source.onopen?.();
  let sequence = 0;
  /** The server pushes a notification, and what it sets going is given time to finish. */
  const push = async (method: string, args: readonly unknown[]) => {
    sequence += 1;
    source.onmessage?.({ data: JSON.stringify({
      source: "evejs-web-gateway", apiVersion: 1, type: "event", cursor: { epoch: "epoch-1", sequence },
      event: { kind: "notification", notification: { kind: "client", service: null, method, args, kwargs: null } },
    }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  /** The server pushes several notifications at once, as it does where one thing is told to two audiences. */
  const pushTogether = async (...notices: ReadonlyArray<readonly [string, readonly unknown[]]>) => {
    for (const [method, args] of notices) {
      sequence += 1;
      source.onmessage?.({ data: JSON.stringify({
        source: "evejs-web-gateway", apiVersion: 1, type: "event", cursor: { epoch: "epoch-1", sequence },
        event: { kind: "notification", notification: { kind: "client", service: null, method, args, kwargs: null } },
      }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  const shown = () => store.station.get().offices;
  return { store, flow, state, push, pushTogether, shown, reads: () => reads, sent };
}

const OFFICE = { type: "long", value: "1054657764826" };
const NO_BUTTONS = { ownOffice: false, impounded: false, canRent: false, canGiveUp: false };

test("the lobby's offices are listed when the player asks, and again at each office rented or given up there", async () => {
  const { flow, state, push, shown, reads } = await docked();
  // Not asked for yet: nothing is shown, and a notice lists nothing.
  await push("OnOfficeRentalChange", [CORPORATION, OFFICE]);
  assert.deepEqual([shown(), reads()], [null, 0]);
  await flow.loadStationOffices();
  assert.deepEqual([shown(), reads()], [{ available: true, corporationIDs: [98000000, 98000003], freeOffices: 17, ...NO_BUTTONS }, 1]);
  // Another corporation rents an office here: the lobby lists them again, whoever's the office is.
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [98000000, 98000003, 98000005], freeOffices: 16 };
  await push("OnOfficeRentalChange", [98000005, OFFICE]);
  assert.deepEqual([shown(), reads()], [{ available: true, corporationIDs: [98000000, 98000003, 98000005], freeOffices: 16, ...NO_BUTTONS }, 2]);
  // And the pilot's own gives one up.
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [98000003, 98000005], freeOffices: 17 };
  await push("OnOfficeRentalChange", [CORPORATION, OFFICE]);
  assert.deepEqual([shown(), reads()], [{ available: true, corporationIDs: [98000003, 98000005], freeOffices: 17, ...NO_BUTTONS }, 3]);
  // Another notice lists nothing.
  await push("OnOfficeSomethingElse", [CORPORATION, OFFICE]);
  await push("OnCharNowInStation", [[140000001, 1000044, null, null]]);
  assert.equal(reads(), 3);
});

test("what the read answers is taken for what it says and no more", async () => {
  const { flow, state, shown } = await docked();
  // A pilot whose transport does not carry the read.
  state.answer = { ok: true, available: false, stationID: STATION, corporationIDs: [], freeOffices: null };
  await flow.loadStationOffices();
  assert.deepEqual(shown(), { available: false, corporationIDs: [], freeOffices: null, ...NO_BUTTONS });
  // What is no corporation is left out, and a count that is no whole number is no count.
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [98000003, "x", null, 0, -2, 2.5, 98000000], freeOffices: "many" };
  await flow.loadStationOffices();
  assert.deepEqual(shown(), { available: true, corporationIDs: [98000003, 98000000], freeOffices: null, ...NO_BUTTONS });
  for (const [freeOffices, expected] of [[0, 0], [-1, null], [1.5, null], [undefined, null]] as const) {
    state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: "none", freeOffices };
    await flow.loadStationOffices();
    assert.deepEqual(shown(), { available: true, corporationIDs: [], freeOffices: expected, ...NO_BUTTONS }, String(freeOffices));
  }
  // The buttons' facts are each what the answer says outright, and nothing else is yes.
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [], freeOffices: 3, ownOffice: true, impounded: true, canRent: true, canGiveUp: true };
  await flow.loadStationOffices();
  assert.deepEqual(shown(), { available: true, corporationIDs: [], freeOffices: 3, ownOffice: true, impounded: true, canRent: true, canGiveUp: true });
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [], freeOffices: 3, ownOffice: "yes", impounded: 1, canRent: {}, canGiveUp: null };
  await flow.loadStationOffices();
  assert.deepEqual(shown(), { available: true, corporationIDs: [], freeOffices: 3, ...NO_BUTTONS });
});

test("a read that fails leaves what was shown, and one that answers after the pilot has gone elsewhere is not shown", async () => {
  const { store, flow, state, push, shown, reads } = await docked();
  await flow.loadStationOffices();
  const first = shown();
  // The player's own asking says why it failed; a notice's asking fails quietly. Either way what was shown stays.
  state.fail = true;
  await assert.rejects(flow.loadStationOffices());
  await push("OnOfficeRentalChange", [CORPORATION, OFFICE]);
  assert.deepEqual([shown(), reads()], [first, 3]);
  // An answer on its way while the pilot docks somewhere else is the old station's.
  state.fail = false;
  let release: () => void = () => {};
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const asking = flow.loadStationOffices();
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.apply({ type: "station/relocated", stationID: 60000004, structureID: null, solarSystemID: 30002780, station: null } as never);
  // Another station: its offices are not listed yet.
  assert.equal(shown(), null);
  release();
  await asking;
  assert.equal(shown(), null);
});

test("told twice of one office, of the station and of the corporation, the page lists the offices once", async () => {
  // Tranquility's recordings of an office rented and of one given up have the notice twice, and the lobby's two
  // reads once: the client's panel does not load again while it is loading (offices.py, _load).
  const { flow, state, pushTogether, push, shown, reads } = await docked();
  await flow.loadStationOffices();
  state.answer = { ok: true, available: true, stationID: STATION, corporationIDs: [98000003], freeOffices: 18 };
  await pushTogether(["OnOfficeRentalChange", [98000000, OFFICE]], ["OnOfficeRentalChange", [98000000, OFFICE]]);
  assert.deepEqual([shown(), reads()], [{ available: true, corporationIDs: [98000003], freeOffices: 18, ...NO_BUTTONS }, 2]);
  // Once that listing is done, the next notice lists again.
  await push("OnOfficeRentalChange", [98000000, OFFICE]);
  assert.equal(reads(), 3);
  // And after a listing that failed.
  state.fail = true;
  await pushTogether(["OnOfficeRentalChange", [98000000, OFFICE]], ["OnOfficeRentalChange", [98000000, OFFICE]]);
  state.fail = false;
  await push("OnOfficeRentalChange", [98000000, OFFICE]);
  assert.equal(reads(), 5);
});

// ── an office rented and given up ────────────────────────────────────────────
//
// dockedUI/offices.py: the rent button asks the price, asks the player, and rents at that price; the other asks the
// player and gives the office up. Neither lists anything itself: the server's notice of the office does.

/** What the page's own call of the office manager sends: a pilot's read, or a pilot's write the page means. */
const theCall = (method: string, args: readonly unknown[], write: boolean) => ({ service: "officeManager", method, args, kwargs: null, pilot: true, ...(write ? { confirm: true } : {}) });
/** The listing of a pilot who may rent and may give up, with or without an office here. */
const mayDoBoth = (ownOffice: boolean) => ({ ok: true, available: true, stationID: STATION, corporationIDs: [98000000, 98000003], freeOffices: 17, ownOffice, impounded: false, canRent: true, canGiveUp: true });

test("an office's price is asked of the office manager as the button is pressed, and the rent goes with the price as the station said it", async () => {
  const { flow, state, sent, reads } = await docked();
  state.answer = mayDoBoth(false);
  await flow.loadStationOffices();
  // officeManager.GetPriceQuote (114): for the session's corporation. A read.
  assert.deepEqual(await flow.quoteStationOffice(), { cost: 10000, days: 30, quoted: 10000 });
  assert.deepEqual(sent, [["GetPriceQuote", theCall("GetPriceQuote", [CORPORATION], false)]]);
  // officeManager.RentOffice (117): the price, and nothing else. A write the page means.
  await flow.rentStationOffice({ cost: 10000, days: 30, quoted: 10000 });
  assert.deepEqual(sent.at(-1), ["RentOffice", theCall("RentOffice", [10000], true)]);
  // Nothing is listed again by the rent: the notice does that. And neither route is asked.
  assert.deepEqual([reads(), sent.length], [1, 2]);
  // Tranquility's station answered a long: shown as its number, and rented with as it came.
  state.price = { type: "long", value: "100113" };
  const long = await flow.quoteStationOffice();
  assert.deepEqual(long, { cost: 100113, days: 30, quoted: { type: "long", value: "100113" } });
  await flow.rentStationOffice(long);
  assert.deepEqual(sent.at(-1), ["RentOffice", theCall("RentOffice", [{ type: "long", value: "100113" }], true)]);
  // A price of nought is a price; what is no price is not handed on as one.
  state.price = 0;
  assert.deepEqual(await flow.quoteStationOffice(), { cost: 0, days: 30, quoted: 0 });
  for (const price of ["10000", -1, 10.5, null, { type: "long", value: "cheap" }]) {
    state.price = price;
    await assert.rejects(flow.quoteStationOffice(), /did not say what an office costs/, JSON.stringify(price));
  }
});

test("an office is given up with the player's yes, by the page's own call, and a rent or a giving up that is refused says why", async () => {
  const { flow, state, sent, reads } = await docked();
  state.answer = mayDoBoth(true);
  await flow.loadStationOffices();
  await flow.giveUpStationOffice();
  // officeManager.UnrentOffice (122): nothing.
  assert.deepEqual([sent, reads()], [[["UnrentOffice", theCall("UnrentOffice", [], true)]], 1]);
  state.refuse = "Your corporation's wallet has too little for the rent.";
  await assert.rejects(flow.giveUpStationOffice(), /too little for the rent/);
  const renting = await docked();
  renting.state.answer = mayDoBoth(false);
  await renting.flow.loadStationOffices();
  renting.state.refuse = "Your corporation's wallet has too little for the rent.";
  await assert.rejects(renting.flow.rentStationOffice({ cost: 10000, days: 30, quoted: 10000 }), /too little for the rent/);
});

test("the page asks the office manager nothing where the client's lobby has no button, and nothing in a structure", async () => {
  // Before the offices are listed there is no button on the page either.
  const unlisted = await docked();
  await assert.rejects(unlisted.flow.quoteStationOffice(), /have not been listed yet/);
  // A pilot with neither role: the listing says so, and the page goes by it.
  const noRole = await docked();
  noRole.state.answer = { ...mayDoBoth(true), canRent: false, canGiveUp: false };
  await noRole.flow.loadStationOffices();
  await assert.rejects(noRole.flow.giveUpStationOffice(), /takes a director/);
  await assert.rejects(noRole.flow.quoteStationOffice(), /role that may rent one/);
  // The pilot's flight says where it is docked now: in a structure the page rents and gives up nothing.
  const structure = await docked();
  structure.state.answer = mayDoBoth(true);
  await structure.flow.loadStationOffices();
  structure.state.flight = { inSpace: false, docked: true, stationID: null, structureID: 1030000000001, solarSystemID: 30000142, shipID: 9001 };
  await assert.rejects(structure.flow.giveUpStationOffice(), /in a structure/);
  // And in space nothing either.
  structure.state.flight = { inSpace: true, docked: false, stationID: null, structureID: null, solarSystemID: 30000142, shipID: 9001 };
  await assert.rejects(structure.flow.giveUpStationOffice(), /while docked/);
  assert.deepEqual([unlisted.sent, noRole.sent, structure.sent], [[], [], []]);
});

test("a rent the corporation's wallet cannot pay is said in the panel's own words for that refusal", async () => {
  const { flow, state } = await docked();
  state.answer = mayDoBoth(false);
  await flow.loadStationOffices();
  // As the game port's BFF answered one, measured 2026-10-10: the server's key and nothing beside it.
  state.refusal = { status: 409, error: "CALL_REFUSED", message: "NotEnoughMoney" };
  let caught: unknown = null;
  await flow.rentStationOffice({ cost: 10000, days: 30, quoted: 10000 }).catch((error: unknown) => { caught = error; });
  // The Station panel says a failed press with panelErrorWords (StationPanel.svelte, run).
  assert.equal(panelErrorWords(caught), "There is not enough ISK in the wallet that pays for that.");
});
