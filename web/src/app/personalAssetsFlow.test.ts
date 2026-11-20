// R37 — the Personal Assets flow, against the REAL BFF envelopes.
//
// The payloads below are the verbatim bodies of live reads against the running
// emulator (account `test2`, character GM Elysian docked-list at Jita IV-4).
//
// The three facts this suite exists to keep apart:
//   * nothing loaded yet
//   * the read FAILED
//   * the read SUCCEEDED and the character genuinely owns nothing
// Every previous panel in this codebase that conflated the last two rendered a
// broken read as an empty world, which is why `ownsNothing` is a fact carried
// from the BFF rather than inferred from an empty array here.
//
// Since 2026-10-11 the list of stations is the page's own read (bridge/assetReads.ts): charMgr.ListStations by
// the generic call, as the client's assets window asks it. "Owns nothing" is said there of a rowset read and
// empty, and of nothing else. What is at a station is the page's own read too (charMgr.ListStationItems), with
// each type's volume asked of the BFF's static data (GET /api/types/volumes), once for a type.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "./flow.ts";

const STATION_ID = 60003760;
const SYSTEM_ID = 30000142;
const STATION_TYPE_ID = 52678;

const STATION_COLUMNS = [
  ["stationID", 20],
  ["solarSystemID", 20],
  ["typeID", 3],
  ["itemCount", 3],
  ["upkeepState", 17],
];

const ITEM_COLUMNS = [
  ["itemID", 20],
  ["typeID", 3],
  ["ownerID", 3],
  ["locationID", 20],
  ["flagID", 2],
  ["quantity", 3],
  ["groupID", 3],
  ["categoryID", 3],
  ["customInfo", 129],
  ["singleton", 2],
  ["stacksize", 3],
];

/** charMgr.ListStations' CRowset — rows on `list`, positional packedrows. */
function stationsCrowset(rows: unknown[][]): unknown {
  return {
    type: "objectex2",
    header: [
      [{ type: "token", value: "carbon.common.script.sys.crowset.CRowset" }],
      { type: "dict", entries: [["header", { type: "objectex1", header: [], list: [], dict: [] }]] },
    ],
    list: rows.map((values) => ({
      type: "packedrow",
      header: { type: "objectex1", header: [], list: [], dict: [] },
      columns: STATION_COLUMNS,
      values,
    })),
    dict: [],
  };
}

/** charMgr.ListStationItems' list — a DIFFERENT shape: name-keyed packedrows. */
function stationItems(rows: Record<string, unknown>[]): unknown {
  return {
    type: "list",
    items: rows.map((fields) => ({
      type: "packedrow",
      header: { type: "objectex1", header: [], list: [], dict: [] },
      columns: ITEM_COLUMNS,
      fields,
    })),
  };
}

/** The live rows GM Elysian's read returned, verbatim (quantity -1 and all). */
const LIVE_ITEM_ROWS: Record<string, unknown>[] = [
  {
    itemID: 9988400022135, typeID: 9854, ownerID: 140000004, locationID: STATION_ID,
    flagID: 4, quantity: -1, groupID: 237, categoryID: 6, customInfo: "",
    singleton: 1, stacksize: 1,
  },
  {
    itemID: 9988400022136, typeID: 40340, ownerID: 140000004, locationID: STATION_ID,
    flagID: 4, quantity: 12, groupID: 1657, categoryID: 65, customInfo: "",
    singleton: 0, stacksize: 12,
  },
];

const LIVE_VOLUMES = { "9854": 20400, "40340": 800000 };

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    requests.push({
      path,
      method: (init && init.method) || "GET",
      body: init && typeof init.body === "string" ? JSON.parse(init.body) : {},
    });
    const outcome = responder(path, init && typeof init.body === "string" ? JSON.parse(init.body) : {});
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

/** The BFF's own successful envelope, exactly as GET /api/bridge/assets sends it. */
function assetsPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    characterID: 140000004,
    stations: stationsCrowset([[STATION_ID, SYSTEM_ID, STATION_TYPE_ID, 9, null]]),
    ownsNothing: false,
    error: null,
    ...overrides,
  };
}

function stationPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    stationID: STATION_ID,
    items: stationItems(LIVE_ITEM_ROWS),
    volumes: LIVE_VOLUMES,
    hasNoItems: false,
    error: null,
    ...overrides,
  };
}

/** The page's own read of where the pilot's things are: charMgr.ListStations by the generic call. */
const isStationsCall = (path: string, body: Record<string, unknown>): boolean =>
  path === "/api/bridge/call" && body.service === "charMgr" && body.method === "ListStations";
const stationsAnswer = (rows: unknown[][]) => ({ status: 200, body: { ok: true, service: "charMgr", method: "ListStations", result: stationsCrowset(rows), notifications: [] } });
// assetsWindow.py 923, invCache.py 833: self.moniker.ListStations(), nothing sent, on the pilot's own object.
const THE_STATIONS_READ = { service: "charMgr", method: "ListStations", args: [], kwargs: null, pilot: true };
/** Another station than the one the page's own read answers: what the route says, which nothing is to ask. */
const THE_ROUTES_STATION = 60008494;

/** The page's own read of what is at a station: charMgr.ListStationItems by the generic call. */
const isItemsCall = (path: string, body: Record<string, unknown>): boolean =>
  path === "/api/bridge/call" && body.service === "charMgr" && body.method === "ListStationItems";
const itemsAnswer = (rows: Record<string, unknown>[]) => ({ status: 200, body: { ok: true, service: "charMgr", method: "ListStationItems", result: stationItems(rows), notifications: [] } });
// assetsWindow.py 745, invCache.py 849: self.moniker.ListStationItems(stationID), on the pilot's own object.
const THE_ITEMS_READ = { service: "charMgr", method: "ListStationItems", args: [STATION_ID], kwargs: null, pilot: true };
/** What the station's route says is there, which nothing is to ask: another ship. */
const THE_ROUTES_ITEM = { itemID: 9988400099999, typeID: 587, ownerID: 140000004, locationID: STATION_ID, flagID: 4, quantity: -1, groupID: 25, categoryID: 6, customInfo: "", singleton: 1, stacksize: 1 };
/** GET /api/types/volumes as the BFF answers it: each type asked of, with its volume or null. */
const typesAskedOf = (path: string): number[] => (new URL(path, "http://bff").searchParams.get("typeIDs") ?? "").split(",").filter((part) => part !== "").map(Number);
const volumesAnswer = (path: string, known: Record<string, number | null> = LIVE_VOLUMES) =>
  ({ status: 200, body: { ok: true, source: "static-data", volumes: Object.fromEntries(typesAskedOf(path).map((typeID) => [String(typeID), known[String(typeID)] ?? null])), capped: false, limit: 500 } });
const volumeRequests = (requests: readonly Recorded[]): number[][] => requests.filter((entry) => entry.path.startsWith("/api/types/volumes")).map((entry) => typesAskedOf(entry.path).sort((a, b) => a - b));

function respondOk(extra: (path: string, body: Record<string, unknown>) => unknown = () => null) {
  return (path: string, body: Record<string, unknown> = {}) => {
    const custom = extra(path, body);
    if (custom !== null && custom !== undefined) {
      return custom as { status: number; body: unknown };
    }
    // The station's route, which nothing is to ask: it answers another item than the page's own read does.
    if (path.startsWith("/api/bridge/assets/station")) {
      return { status: 200, body: stationPayload({ items: stationItems([THE_ROUTES_ITEM]), volumes: { "587": 16500 } }) };
    }
    if (isItemsCall(path, body)) {
      return itemsAnswer(LIVE_ITEM_ROWS);
    }
    if (path.startsWith("/api/types/volumes")) {
      return volumesAnswer(path);
    }
    if (path.startsWith("/api/bridge/assets")) {
      return { status: 200, body: assetsPayload({ stations: stationsCrowset([[THE_ROUTES_STATION, 30002187, 1529, 1, null]]) }) };
    }
    if (isStationsCall(path, body)) {
      return stationsAnswer([[STATION_ID, SYSTEM_ID, STATION_TYPE_ID, 9, null]]);
    }
    if (path === "/api/names") {
      return { status: 200, body: { ok: true, names: {} } };
    }
    return { status: 200, body: { ok: true } };
  };
}

function makeFlow(responder: ReturnType<typeof respondOk>) {
  const store = createClientStore();
  const { fetch: fakeFetch, requests } = makeFakeFetch(responder);
  const flow = createAppFlow(store, { fetch: fakeFetch });
  return { store, flow, requests };
}

async function settleNames(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// --- the happy path ---------------------------------------------------------

test("a live read lands the character's stations in the store, by the page's own call and never by the route", async () => {
  const { store, flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  assert.deepEqual(requests.filter((entry) => entry.path === "/api/bridge/call").map((entry) => entry.body), [THE_STATIONS_READ]);
  assert.deepEqual(requests.filter((entry) => entry.path.startsWith("/api/bridge/assets")), []);

  const assets = store.get().assets;
  assert.equal(assets.loaded, true);
  assert.equal(assets.error, null);
  assert.equal(assets.ownsNothing, false);
  assert.equal(assets.stations.length, 1);
  assert.equal(assets.stations[0]!.stationID, STATION_ID);
  assert.equal(assets.stations[0]!.itemCount, 9);
});

test("expanding a station reads it by the page's own call, never by the route, and keeps its contents under that station", async () => {
  const { store, flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);
  assert.deepEqual(requests.filter((entry) => entry.path === "/api/bridge/call" && entry.body.method === "ListStationItems").map((entry) => entry.body), [THE_ITEMS_READ]);
  assert.deepEqual(requests.filter((entry) => entry.path.startsWith("/api/bridge/assets")), []);
  // Each type's volume, asked of the BFF's static data in one request for the two.
  assert.deepEqual(volumeRequests(requests), [[9854, 40340]]);

  const assets = store.get().assets;
  assert.equal(assets.expandedStationID, STATION_ID);
  const contents = assets.contents[STATION_ID]!;
  assert.equal(contents.error, null);
  assert.equal(contents.items.length, 2);
  // The assembled ship counts as one, not as the -1 the wire carries.
  assert.equal(contents.items.find((item) => item.typeID === 9854)!.units, 1);
  assert.equal(contents.items.find((item) => item.typeID === 40340)!.units, 12);
  // Volume arrived from the BFF's static data.
  assert.equal(contents.items.find((item) => item.typeID === 40340)!.volume, 800000);
  assert.equal(contents.items.find((item) => item.typeID === 9854)!.volume, 20400);
  assert.equal(contents.hasNoItems, false);
});

test("collapsing a station touches no server", async () => {
  const { store, flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  const before = requests.length;
  await flow.openAssetStation(null);
  assert.equal(store.get().assets.expandedStationID, null);
  assert.equal(requests.length, before, "collapsing must not issue a read");
});

test("independent station reads can complete out of order and share a pending read of the same station", async () => {
  const other = { ...THE_ROUTES_ITEM, locationID: THE_ROUTES_STATION };
  const { fetch: recorded, requests } = makeFakeFetch(respondOk((path, body) =>
    isItemsCall(path, body) && (body.args as number[])[0] === THE_ROUTES_STATION ? itemsAnswer([other]) : null));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const response = await recorded(input, init);
    if (isItemsCall(String(input), body) && body.args[0] === STATION_ID) await waiting;
    return response;
  };
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.loadPersonalAssets();
  const first = flow.loadAssetStation(STATION_ID);
  const duplicate = flow.loadAssetStation(STATION_ID);
  await flow.loadAssetStation(THE_ROUTES_STATION);
  assert.equal(store.assets.get().contents[THE_ROUTES_STATION]?.items[0]?.itemID, other.itemID);
  assert.equal(store.assets.get().contents[STATION_ID], undefined);
  release();
  await Promise.all([first, duplicate]);
  assert.equal(store.assets.get().expandedStationID, null);
  assert.equal(store.assets.get().contents[STATION_ID]?.items.length, 2);
  assert.deepEqual(requests.filter(({ path, body }) => isItemsCall(path, body)).map(({ body }) => body.args), [[STATION_ID], [THE_ROUTES_STATION]]);
});

test("an older station response cannot overwrite contents from a refreshed asset list", async () => {
  let rows = LIVE_ITEM_ROWS;
  const { fetch: recorded } = makeFakeFetch(respondOk((path, body) => isItemsCall(path, body) ? itemsAnswer(rows) : null));
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { started = resolve; });
  let first = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const response = await recorded(input, init);
    if (first && isItemsCall(String(input), body)) {
      first = false;
      started();
      await waiting;
    }
    return response;
  };
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.loadPersonalAssets();
  const old = flow.loadAssetStation(STATION_ID);
  await reading;
  rows = [{ ...LIVE_ITEM_ROWS[1]!, itemID: 9988400022335, quantity: 3, stacksize: 3 }];
  await flow.loadPersonalAssets();
  await flow.loadAssetStation(STATION_ID);
  release();
  await old;
  assert.deepEqual(store.assets.get().contents[STATION_ID]?.items.map(({ itemID, units }) => [itemID, units]), [[9988400022335, 3]]);
});

// --- empty is NOT failed ----------------------------------------------------

test("a SUCCESSFUL empty read says the character owns nothing", async () => {
  const { store, flow } = makeFlow(
    respondOk((path, body) => (isStationsCall(path, body) ? stationsAnswer([]) : null)),
  );
  await flow.loadPersonalAssets();

  const assets = store.get().assets;
  assert.equal(assets.ownsNothing, true, "a successful empty read may say so");
  assert.equal(assets.error, null);
  assert.deepEqual(assets.stations, []);
});

test("a FAILED read never claims the character owns nothing", async () => {
  const { store, flow } = makeFlow(
    respondOk((path, body) =>
      isStationsCall(path, body) ? { status: 502, body: { ok: false, error: "CALL_FAILED", message: "CALL_FAILED" } } : null,
    ),
  );
  await flow.loadPersonalAssets();

  const assets = store.get().assets;
  // THE WHOLE POINT: an empty list here must not be readable as "you own
  // nothing". The panel branches on these two fields, and they disagree.
  // (The call's own code is what the failure is kept as.)
  assert.equal(assets.error, "CALL_FAILED");
  assert.equal(assets.ownsNothing, false, "a failed read may never make that claim");
  assert.equal(assets.loaded, true, "the attempt completed, so the panel stops waiting");
  assert.deepEqual(assets.stations, []);
});

test("a read that reports an error is not rendered, even if it carried rows", async () => {
  // Defence in depth against a PARTIAL answer. If a refusal ever arrives with
  // some rows on it, showing those rows would present a
  // known-incomplete list as if it were the whole truth — the player would see
  // "your things are in 1 place" when the read that would have found the other
  // places failed. The error wins; nothing is decoded.
  const { store, flow } = makeFlow(
    respondOk((path, body) =>
      isStationsCall(path, body)
        ? {
            status: 502,
            body: { ok: false, error: "CALL_FAILED", message: "CALL_FAILED", result: stationsCrowset([[STATION_ID, SYSTEM_ID, STATION_TYPE_ID, 9, null]]) },
          }
        : null,
    ),
  );
  await flow.loadPersonalAssets();

  const assets = store.get().assets;
  assert.equal(assets.error, "CALL_FAILED");
  assert.deepEqual(
    assets.stations,
    [],
    "a partial answer must not be shown as if the read had succeeded",
  );
});

test("a station whose contents fail keeps the failure to itself", async () => {
  const { store, flow } = makeFlow(
    respondOk((path, body) =>
      isItemsCall(path, body) ? { status: 502, body: { ok: false, error: "CALL_FAILED", message: "CALL_FAILED" } } : null,
    ),
  );
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);

  const assets = store.get().assets;
  // The station LIST survived; only the one station's contents are missing.
  assert.equal(assets.stations.length, 1);
  assert.equal(assets.error, null);
  const contents = assets.contents[STATION_ID]!;
  // (The call's own code is what the failure is kept as.)
  assert.equal(contents.error, "CALL_FAILED");
  assert.equal(contents.hasNoItems, false, "a failed read is not an empty station");
  assert.deepEqual(contents.items, []);
});

test("a station's failed read is not rendered, even if it carried rows", async () => {
  // The same defence as above, on the per-station read: a partial list of what
  // is stored somewhere is worse than saying the read failed, because the
  // player would believe they had seen everything.
  const { store, flow } = makeFlow(
    respondOk((path, body) =>
      isItemsCall(path, body)
        ? {
            status: 502,
            body: { ok: false, error: "CALL_FAILED", message: "CALL_FAILED", result: stationItems(LIVE_ITEM_ROWS) },
          }
        : null,
    ),
  );
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);

  const contents = store.get().assets.contents[STATION_ID]!;
  assert.equal(contents.error, "CALL_FAILED");
  assert.deepEqual(contents.items, [], "a partial answer is not shown as the whole truth");
});

test("a station that is genuinely empty says so, distinctly", async () => {
  const { store, flow, requests } = makeFlow(
    respondOk((path, body) => (isItemsCall(path, body) ? itemsAnswer([]) : null)),
  );
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);

  const contents = store.get().assets.contents[STATION_ID]!;
  assert.equal(contents.hasNoItems, true);
  assert.equal(contents.error, null);
  // And no type's volume is asked for, there being no type.
  assert.deepEqual(volumeRequests(requests), []);
});

// --- R7d --------------------------------------------------------------------

test("every id the panel will show is asked for by NAME in one round-trip", async () => {
  const { flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  await settleNames();

  const nameRequest = requests.find((entry) => entry.path === "/api/names");
  assert.ok(nameRequest, "names resolve in ONE batched round-trip");
  const asked = (nameRequest.body.items as { kind: string; id: number }[]) ?? [];
  const keys = new Set(asked.map((ref) => `${ref.kind}:${ref.id}`));
  // Without these the page reads "an unnamed place" in "an unnamed system".
  assert.ok(keys.has(`station:${STATION_ID}`), "the place itself");
  assert.ok(keys.has(`system:${SYSTEM_ID}`), "and the system it sits in");
  assert.ok(keys.has(`type:${STATION_TYPE_ID}`), "and its type, for the icon");
});

test("asset stations and structures request the name kinds used by location labels", async () => {
  const structureID = 1030000000000;
  const { flow, requests } = makeFlow(respondOk((path, body) => isStationsCall(path, body)
    ? stationsAnswer([[STATION_ID, SYSTEM_ID, STATION_TYPE_ID, 9, null], [structureID, 30002647, 35835, 1, null]])
    : null));
  await flow.loadPersonalAssets();
  await settleNames();
  const asked = requests.filter(({ path }) => path === "/api/names")
    .flatMap(({ body }) => body.items as { kind: string; id: number }[]);
  const locations = asked.filter(({ id }) => id === structureID || id === STATION_ID);
  assert.deepEqual(locations, [{ kind: "station", id: STATION_ID }, { kind: "structure", id: structureID }]);
});

test("asset search matches the station keyword against a structure name", async () => {
  const structureID = 1030000000000;
  const item: Record<string, unknown> = { ...LIVE_ITEM_ROWS[0]!, locationID: structureID };
  const { flow } = makeFlow(respondOk((path, body) => {
    if (path === "/api/bridge/call" && body.service === "charMgr" && body.method === "ListIncludingContainers") {
      return { status: 200, body: { ok: true, service: "charMgr", method: "ListIncludingContainers", result: stationItems([item]) } };
    }
    if (isStationsCall(path, body)) return stationsAnswer([[structureID, 30002647, 35835, 1, null]]);
    if (path === "/api/words") return { status: 200, body: { ok: true, available: true, words: { "UI/Inventory/AssetSearch/KeywordStationName": "station" } } };
    if (path === "/api/names") return {
      status: 200,
      body: { ok: true, names: { [`structure:${structureID}`]: "Codex Live Moon Athanor", [`type:${item.typeID}`]: "A ship" } },
    };
    return null;
  }));
  const result = await flow.searchPersonalAssets("station:moon athanor");
  assert.equal(result.stopped, false);
  assert.deepEqual(result.locations.map((location) => [location.stationID, location.items[0]?.itemID]), [[structureID, item.itemID]]);
});

test("expanding a station asks for its item types by name", async () => {
  const { flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  await settleNames();
  const before = requests.filter((entry) => entry.path === "/api/names").length;

  await flow.openAssetStation(STATION_ID);
  await settleNames();

  const nameRequests = requests.filter((entry) => entry.path === "/api/names");
  assert.ok(nameRequests.length > before, "the new types trigger a resolve");
  const asked = nameRequests
    .flatMap((entry) => (entry.body.items as { kind: string; id: number }[]) ?? []);
  const keys = new Set(asked.map((ref) => `${ref.kind}:${ref.id}`));
  assert.ok(keys.has("type:9854"), "the ship");
  assert.ok(keys.has("type:40340"), "and the stack beside it");
});

// --- setting a destination --------------------------------------------------

test("setting a destination from an asset location makes the station the destination, and flies nothing", async () => {
  // Set Destination, as the client's map menu sets it (starMapSvc.SetWaypoint(id, True)): the station the only
  // waypoint, kept for the pilot; nothing is planned or flown until the autopilot is switched on. It is a station of
  // the map, in known space and of no deprecated type (_IsDestinationValid, 2301 to 2318), as the BFF's map answers.
  const { store, flow } = makeFlow(respondOk((path) => (path === `/api/map/resolve/${STATION_ID}`
    ? { status: 200, body: { ok: true, id: STATION_ID, kind: "station", stationID: STATION_ID, stationName: "A station", solarSystemID: SYSTEM_ID, systemName: "A system", stationTypeID: STATION_TYPE_ID } }
    : null)));
  store.apply({
    type: "character/online",
    character: { characterID: 140000001, characterName: "Pilot", stationID: 60000001, structureID: null, solarSystemID: 30000140, corporationID: 1000001 },
    station: null,
  });

  await flow.setDestinationToAssetStation(STATION_ID);

  assert.deepEqual(flow.waypoints.get(), [STATION_ID]);
  assert.equal(store.get().travel.status, "idle");
  assert.equal(store.get().travel.destinationStationID, null);
});

// --- the list of stations, as the page's own read -----------------------------

test("an answer that is no rowset is a read that failed, and never nothing owned", async () => {
  const answers: Array<[string, unknown]> = [["nothing", null], ["a list", { type: "list", items: [] }], ["a yes", true], ["the route's envelope", assetsPayload({ ownsNothing: true })]];
  for (const [what, result] of answers) {
    const { store, flow } = makeFlow(
      respondOk((path, body) => (isStationsCall(path, body) ? { status: 200, body: { ok: true, service: "charMgr", method: "ListStations", result, notifications: [] } } : null)),
    );
    await flow.loadPersonalAssets();
    const assets = store.get().assets;
    assert.deepEqual([assets.loaded, assets.error, assets.ownsNothing, assets.stations], [true, "READ_FAILED", false, []], what);
  }
});

test("a pilot's session gone, or none held, fails the load itself: it is not kept as the read's failure", async () => {
  for (const [status, error] of [[404, "SESSION_NOT_FOUND"], [409, "NO_LIVE_SESSION"]] as const) {
    const { store, flow } = makeFlow(
      respondOk((path, body) => (isStationsCall(path, body) ? { status, body: { ok: false, error, message: error } } : null)),
    );
    store.apply({ type: "character/online", character: {
      characterID: 140000004, characterName: "Test", stationID: STATION_ID,
      structureID: null, solarSystemID: SYSTEM_ID, corporationID: 98000000,
    }, station: null } as never);
    assert.notEqual(store.get().station.online, null, error);
    await assert.rejects(flow.loadPersonalAssets(), (reason: { code?: string }) => reason.code === error, error);
    assert.deepEqual([store.get().assets.loaded, store.get().assets.error], [false, null], error);
    // And the pilot is offline to the page: its session is the server's no longer.
    assert.equal(store.get().station.online, null, error);
  }
});

test("names are asked for the stations the page's own read answered, and for none of the route's", async () => {
  const { flow, requests } = makeFlow(respondOk());
  await flow.loadPersonalAssets();
  await settleNames();
  const asked = requests.filter((entry) => entry.path === "/api/names").flatMap((entry) => (entry.body.items as { kind: string; id: number }[]) ?? []);
  assert.deepEqual(asked.filter((ref) => ref.kind === "station").map((ref) => ref.id), [STATION_ID]);
  assert.equal(asked.some((ref) => ref.id === THE_ROUTES_STATION), false);
});

// --- what is at a station, as the page's own read -----------------------------

test("an answer that is no list is a station's read that failed, and never an empty station", async () => {
  const answers: Array<[string, unknown]> = [["nothing", null], ["a rowset", stationsCrowset([])], ["a yes", true], ["the route's envelope", stationPayload({ hasNoItems: true })]];
  for (const [what, result] of answers) {
    const { store, flow, requests } = makeFlow(
      respondOk((path, body) => (isItemsCall(path, body) ? { status: 200, body: { ok: true, service: "charMgr", method: "ListStationItems", result, notifications: [] } } : null)),
    );
    await flow.loadPersonalAssets();
    await flow.openAssetStation(STATION_ID);
    const contents = store.get().assets.contents[STATION_ID]!;
    assert.deepEqual([contents.error, contents.hasNoItems, contents.items], ["READ_FAILED", false, []], what);
    assert.deepEqual(volumeRequests(requests), [], what);
  }
});

test("a type's volume is asked for once and kept: a second look asks for none, and a new type is asked for alone", async () => {
  let rows = LIVE_ITEM_ROWS;
  const { store, flow, requests } = makeFlow(respondOk((path, body) => (isItemsCall(path, body) ? itemsAnswer(rows) : null)));
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);
  await flow.openAssetStation(STATION_ID);
  assert.deepEqual(volumeRequests(requests), [[9854, 40340]]);
  assert.equal(store.get().assets.contents[STATION_ID]!.items.find((item) => item.typeID === 40340)!.volume, 800000);
  // More stacks have come: two of one type not seen yet, and one of another, neither known to the static tables.
  rows = [...LIVE_ITEM_ROWS, { ...LIVE_ITEM_ROWS[1], itemID: 9988400022137, typeID: 34, stacksize: 5, quantity: 5 }, { ...LIVE_ITEM_ROWS[1], itemID: 9988400022138, typeID: 70001, stacksize: 3, quantity: 3 },
    { ...LIVE_ITEM_ROWS[1], itemID: 9988400022139, typeID: 34, stacksize: 2, quantity: 2 }];
  await flow.openAssetStation(STATION_ID);
  // A type is asked for once however many stacks of it there are.
  assert.deepEqual(volumeRequests(requests), [[9854, 40340], [34, 70001]]);
  // A type the tables do not know has no volume, and never one of nought. It is not asked for again either.
  const unknown = store.get().assets.contents[STATION_ID]!.items.filter((item) => item.typeID === 34 || item.typeID === 70001);
  assert.deepEqual(unknown.map((item) => item.volume), [null, null, null]);
  await flow.openAssetStation(STATION_ID);
  assert.equal(volumeRequests(requests).length, 2);
});

test("a type the BFF did not answer for is asked for again; one it said has no volume is not", async () => {
  // The first answer leaves the stack's type out altogether (an answer cut short), and says the ship's has none.
  let first = true;
  const { store, flow, requests } = makeFlow(
    respondOk((path) => {
      if (!path.startsWith("/api/types/volumes")) return null;
      const answer = first ? { status: 200, body: { ok: true, source: "static-data", volumes: { "9854": null }, capped: true, limit: 500 } } : volumesAnswer(path);
      first = false;
      return answer;
    }),
  );
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);
  assert.deepEqual(store.get().assets.contents[STATION_ID]!.items.map((item) => [item.typeID, item.volume]), [[40340, null], [9854, null]]);
  await flow.openAssetStation(STATION_ID);
  assert.deepEqual(volumeRequests(requests), [[9854, 40340], [40340]]);
  assert.deepEqual(store.get().assets.contents[STATION_ID]!.items.map((item) => [item.typeID, item.volume]), [[40340, 800000], [9854, null]]);
});

test("volumes that could not be read leave the items listed without them, and are asked for again", async () => {
  let failing = true;
  const { store, flow, requests } = makeFlow(
    respondOk((path) => (path.startsWith("/api/types/volumes") && failing ? { status: 500, body: { ok: false, error: "INTERNAL_ERROR", message: "boom" } } : null)),
  );
  await flow.loadPersonalAssets();
  await flow.openAssetStation(STATION_ID);
  const first = store.get().assets.contents[STATION_ID]!;
  // The station's read is whole: only what each thing measures is not known.
  assert.deepEqual([first.error, first.hasNoItems, first.items.map((item) => [item.typeID, item.units, item.volume])], [null, false, [[40340, 12, null], [9854, 1, null]]]);
  failing = false;
  await flow.openAssetStation(STATION_ID);
  assert.deepEqual(store.get().assets.contents[STATION_ID]!.items.map((item) => [item.typeID, item.volume]), [[40340, 800000], [9854, 20400]]);
  assert.deepEqual(volumeRequests(requests), [[9854, 40340], [9854, 40340]]);
});

test("a pilot's session gone while a station is read fails the look itself, and the pilot is offline", async () => {
  const { store, flow } = makeFlow(
    respondOk((path, body) => (isItemsCall(path, body) ? { status: 404, body: { ok: false, error: "SESSION_NOT_FOUND", message: "SESSION_NOT_FOUND" } } : null)),
  );
  await flow.loadPersonalAssets();
  store.apply({ type: "character/online", character: {
    characterID: 140000004, characterName: "Test", stationID: STATION_ID,
    structureID: null, solarSystemID: SYSTEM_ID, corporationID: 98000000,
  }, station: null } as never);
  await assert.rejects(flow.openAssetStation(STATION_ID), (reason: { code?: string }) => reason.code === "SESSION_NOT_FOUND");
  assert.equal(store.get().station.online, null);
});
