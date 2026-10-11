"use strict";

// Goal R41: the BFF's half of Planetary Interaction — GET /api/bridge/planets.
//
// WHAT THIS ROUTE IS NOT: it is not a bridge `callMethod`. It adds ZERO pairs to
// the gateway's deny-by-default allowlist, because the gateway's GET /snapshot
// already carries `planetRuntimeState` filtered to the requested character's own
// colonies. The planetMgr reads that WOULD have needed allowlisting
// (GetFullNetworkForOwner, GetCommandPinsForPlanet, GetExtractorsForPlanet) are
// owner-agnostic by design — GetFullNetworkForOwner takes the ownerID from
// args[1] — so allowlisting one would have handed the browser any character's
// colony layout for an arbitrary id. Declined, R38-style. The test at the bottom
// of this file pins that decision by proving the route makes no bridge call.
//
// The colony fixture below is NOT hand-written. It was produced by running
// eve.js's own planetRuntimeStore._testing.buildPin + normalizeColony, so every
// field, every default the normalizer fills in (`typeID: 2280` on links,
// `charID` on routes, string-keyed `contents`, sorted `heads`) is the shape the
// emulator really stores. The instants are Windows FILETIME strings, which is
// why they are strings: they overflow a double.
//
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTER_ID = 7;
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const ORIGIN_STATION_ID = 60003760;
const ORIGIN_SYSTEM_ID = 30000142;

const PLANET_ID = 40000002;
const COLONY_SYSTEM_ID = 30000001;
const COMMAND_CENTER_TYPE_ID = 2254;
const ECU_TYPE_ID = 3068;
const FACTORY_TYPE_ID = 2481;
const LAUNCHPAD_TYPE_ID = 2256;
const STORAGE_TYPE_ID = 2562;
const AQUEOUS_LIQUIDS_TYPE_ID = 2268;
const MICROORGANISMS_TYPE_ID = 2073;
const WATER_TYPE_ID = 3645;
const BACTERIA_TYPE_ID = 2393;
const PLANET_TEMPERATE_TYPE_ID = 11;

// ⚠ AN EXTRACTOR'S cycleTime IS IN 100ns FILETIME TICKS, NOT SECONDS.
// planetRuntimeStore divides it by SECOND_TICKS (10,000,000) wherever it uses
// it, and the real colony on Jita I carries 9,000,000,000 — 900 seconds, a
// 15-minute cycle. Treating it as seconds renders a cycle 285 years long.
const FILETIME_TICKS_PER_SECOND = 10000000;
const CYCLE_TICKS_1_HOUR = 3600 * FILETIME_TICKS_PER_SECOND;
const CYCLE_TICKS_30_MIN = 1800 * FILETIME_TICKS_PER_SECOND;
// The value a live read actually returned, kept verbatim.
const CYCLE_TICKS_LIVE_JITA = 9000000000;

// The two instants the active extractor carries, as the emulator stores them
// and as epoch ms. Computed independently of the route so the conversion is
// checked against arithmetic, not against itself.
const INSTALLED_AT_MS = Date.UTC(2026, 6, 21, 9, 0, 0);
const EXPIRES_AT_MS = Date.UTC(2026, 6, 22, 9, 0, 0);
const EXPIRED_EXPIRES_AT_MS = Date.UTC(2026, 6, 21, 10, 0, 0);

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

/** The colony, exactly as eve.js's normalizeColony emitted it. */
function capturedColony() {
  return {
    planetID: PLANET_ID,
    ownerID: 140000238,
    solarSystemID: COLONY_SYSTEM_ID,
    planetTypeID: PLANET_TEMPERATE_TYPE_ID,
    planetRadius: 5060000,
    level: 3,
    typeID: PLANET_TEMPERATE_TYPE_ID,
    currentSimTime: "134291087400000000",
    pins: [
      {
        id: 1,
        pinID: 1,
        ownerID: 140000238,
        typeID: COMMAND_CENTER_TYPE_ID,
        latitude: 0.1,
        longitude: 0.2,
        lastRunTime: "134291331597230000",
        contents: {},
        state: 0,
        lastLaunchTime: "0",
      },
      {
        id: 2,
        pinID: 2,
        ownerID: 140000238,
        typeID: ECU_TYPE_ID,
        latitude: 0.12,
        longitude: 0.22,
        lastRunTime: "134291331597240000",
        contents: {},
        state: 1,
        cycleTime: CYCLE_TICKS_1_HOUR,
        programType: AQUEOUS_LIQUIDS_TYPE_ID,
        qtyPerCycle: 2841,
        expiryTime: "134291844000000000",
        installTime: "134290980000000000",
        headRadius: 0.012,
        heads: [[0, 0.121, 0.221], [1, 0.119, 0.223], [2, 0.122, 0.219]],
      },
      {
        id: 3,
        pinID: 3,
        ownerID: 140000238,
        typeID: ECU_TYPE_ID,
        latitude: 0.31,
        longitude: 0.44,
        lastRunTime: "134291331597240000",
        contents: {},
        state: 0,
        cycleTime: CYCLE_TICKS_30_MIN,
        programType: MICROORGANISMS_TYPE_ID,
        qtyPerCycle: 1204,
        expiryTime: "134291016000000000",
        installTime: "134289360000000000",
        headRadius: 0.01,
        heads: [[0, 0.311, 0.441]],
      },
      {
        id: 4,
        pinID: 4,
        ownerID: 140000238,
        typeID: FACTORY_TYPE_ID,
        latitude: 0.13,
        longitude: 0.23,
        lastRunTime: "134291331597240000",
        contents: { 2268: 900 },
        state: 0,
        schematicID: 65,
        hasReceivedInputs: true,
        receivedInputsLastCycle: true,
      },
      {
        id: 5,
        pinID: 5,
        ownerID: 140000238,
        typeID: LAUNCHPAD_TYPE_ID,
        latitude: 0.14,
        longitude: 0.24,
        lastRunTime: "134291331597240000",
        contents: { 2393: 300, 3645: 4200 },
        state: 0,
        lastLaunchTime: "0",
      },
      {
        id: 6,
        pinID: 6,
        ownerID: 140000238,
        typeID: STORAGE_TYPE_ID,
        latitude: 0.15,
        longitude: 0.25,
        lastRunTime: "134291331597240000",
        contents: { 2268: 12000 },
        state: 0,
      },
    ],
    links: [
      { endpoint1: 1, endpoint2: 2, level: 0, typeID: 2280 },
      { endpoint1: 1, endpoint2: 4, level: 1, typeID: 2280 },
      { endpoint1: 4, endpoint2: 5, level: 0, typeID: 2280 },
      { endpoint1: 1, endpoint2: 6, level: 0, typeID: 2280 },
    ],
    routes: [
      {
        routeID: 1,
        path: [2, 4],
        commodityTypeID: AQUEOUS_LIQUIDS_TYPE_ID,
        commodityQuantity: 2841,
        charID: 140000238,
      },
      {
        routeID: 2,
        path: [4, 5],
        commodityTypeID: WATER_TYPE_ID,
        commodityQuantity: 20,
        charID: 140000238,
      },
    ],
  };
}

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === CHARACTER_ID
        ? { characterID: CHARACTER_ID, accountID: ACCOUNT.accountID, characterName: "Test Pilot" }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

const TYPE_NAMES = new Map([
  [COMMAND_CENTER_TYPE_ID, "Temperate Command Center"],
  [ECU_TYPE_ID, "Temperate Extractor Control Unit"],
  [FACTORY_TYPE_ID, "Temperate Basic Industry Facility"],
  [LAUNCHPAD_TYPE_ID, "Temperate Launchpad"],
  [STORAGE_TYPE_ID, "Temperate Storage Facility"],
  [AQUEOUS_LIQUIDS_TYPE_ID, "Aqueous Liquids"],
  [MICROORGANISMS_TYPE_ID, "Microorganisms"],
  [WATER_TYPE_ID, "Water"],
  [BACTERIA_TYPE_ID, "Bacteria"],
  [PLANET_TEMPERATE_TYPE_ID, "Planet (Temperate)"],
]);

// The real groupIDs, so the route's kind classification is exercised against
// the numbers the emulator's static data actually carries.
const TYPE_GROUPS = new Map([
  [COMMAND_CENTER_TYPE_ID, 1027],
  [ECU_TYPE_ID, 1063],
  [FACTORY_TYPE_ID, 1028],
  [LAUNCHPAD_TYPE_ID, 1030],
  [STORAGE_TYPE_ID, 1029],
  [AQUEOUS_LIQUIDS_TYPE_ID, 1033],
  [WATER_TYPE_ID, 1042],
  [BACTERIA_TYPE_ID, 1042],
  [PLANET_TEMPERATE_TYPE_ID, 7],
]);

// The capacity of a pin and the volume of a commodity, both off the gameStore's
// own itemTypes table — the same field planetRuntimeStore.getPinCapacity reads.
// ⚠ An extractor control unit and an industry facility really do carry capacity
// 0: they are not holds, and the emulator treats a non-finite capacity as no
// limit at all. The route must answer null for them, never 0.
const TYPE_CAPACITIES = new Map([
  [COMMAND_CENTER_TYPE_ID, 500],
  [ECU_TYPE_ID, 0],
  [FACTORY_TYPE_ID, 0],
  [LAUNCHPAD_TYPE_ID, 10000],
  [STORAGE_TYPE_ID, 12000],
]);

const TYPE_VOLUMES = new Map([
  [COMMAND_CENTER_TYPE_ID, 1000],
  [AQUEOUS_LIQUIDS_TYPE_ID, 0.005],
  [MICROORGANISMS_TYPE_ID, 0.005],
  [WATER_TYPE_ID, 0.19],
  [BACTERIA_TYPE_ID, 0.19],
]);

// planetSchematics row 65, as the gameStore carries it.
const SCHEMATIC_NAMES = new Map([[65, "Superconductors"]]);

function fakeStaticData() {
  return {
    getType(id) {
      const numeric = Number(id) || 0;
      return TYPE_GROUPS.has(numeric)
        ? {
          typeID: numeric,
          name: TYPE_NAMES.get(numeric),
          groupID: TYPE_GROUPS.get(numeric),
          capacity: TYPE_CAPACITIES.get(numeric) ?? 0,
          volume: TYPE_VOLUMES.get(numeric) ?? 0,
        }
        : null;
    },
    getPlanetSchematicName(id) {
      return SCHEMATIC_NAMES.get(Number(id) || 0) || null;
    },
    getTypeName(id) {
      return TYPE_NAMES.get(Number(id) || 0) || `Type ${id}`;
    },
    getPlanetName(id) {
      return Number(id) === PLANET_ID ? "Tanoo I" : null;
    },
    getSolarSystemName(id) {
      return Number(id) === COLONY_SYSTEM_ID ? "Tanoo" : `System ${id}`;
    },
    getStation() {
      return null;
    },
    // ecuNoiseFactor (1687): no extractor type carries it, so every one reads
    // the attribute's SDE default, 0.8.
    getTypeDogmaAttributeOrDefault(typeID, attributeID, fallback = null) {
      return Number(attributeID) === 1687 ? 0.8 : fallback;
    },
  };
}

function fakeGateway(overrides = {}) {
  const calls = { snapshot: [], call: [], bind: [], boundCall: [] };
  const gateway = {
    calls,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: ACCOUNT.accountID,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: ORIGIN_STATION_ID,
          structureID: null,
          solarSystemID: ORIGIN_SYSTEM_ID,
          corporationID: 98000000,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async getSnapshot(accountID, characterID) {
      calls.snapshot.push({ accountID, characterID });
      return {
        source: "evejs-web-gateway",
        apiVersion: 1,
        planetRuntimeState: {
          schemaVersion: 1,
          resourcesByPlanetID: {},
          coloniesByKey: { [`${PLANET_ID}:140000238`]: capturedColony() },
          launchesByID: {},
          acceptedNetworkEditsByKey: {},
          nextIDs: {},
        },
      };
    },
    async callMethod(service, method, args, kwargs) {
      calls.call.push({ service, method, args, kwargs });
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args) {
      calls.bind.push({ service, method, args });
      return { boundID: "bound-1", notifications: [] };
    },
    async callBoundMethod(boundID, service, method, args) {
      calls.boundCall.push({ boundID, service, method, args });
      return { service, method, result: null, notifications: [] };
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: options.staticData || fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selected(overrides) {
  const gateway = fakeGateway(overrides);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });
  return { gateway, baseUrl };
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  for (const server of activeServers) {
    server.close();
  }
  activeServers.clear();
});

test("the colony arrives named, not numbered", async () => {
  const { baseUrl } = await selected();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/planets");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.coloniesReadable, true);
  assert.equal(payload.colonies.length, 1);

  const colony = payload.colonies[0];
  assert.equal(colony.planetName, "Tanoo I");
  assert.equal(colony.solarSystemName, "Tanoo");
  assert.equal(colony.planetTypeName, "Planet (Temperate)");
  assert.equal(colony.commandCenterLevel, 3);
});

test("the read is owner-scoped by the SNAPSHOT, and makes no bridge call at all", async () => {
  const { gateway, baseUrl } = await selected();
  await apiRequest(baseUrl, "/api/bridge/planets");

  // The ownership check is the gateway's: it is handed the account that is
  // signed in and the character the bridge session holds, and it filters
  // coloniesByKey itself. Nothing here passes an ownerID the browser chose.
  assert.deepEqual(gateway.calls.snapshot, [
    { accountID: ACCOUNT.accountID, characterID: CHARACTER_ID },
  ]);

  // ⚠ The R38 decision, pinned. If someone later "improves" this route by
  // reaching for planetMgr.GetFullNetworkForOwner, this fails — that read takes
  // its ownerID from args[1] and would answer for any character.
  assert.deepEqual(gateway.calls.call, []);
  assert.deepEqual(gateway.calls.bind, []);
  assert.deepEqual(gateway.calls.boundCall, []);
});

test("every pin is classified by what it DOES, from the real groupIDs", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = payload.colonies[0].pins;

  assert.deepEqual(
    pins.map((pin) => [pin.pinID, pin.kind]),
    [
      [1, "command"],
      [2, "extractor-control"],
      [3, "extractor-control"],
      [4, "factory"],
      [5, "launchpad"],
      [6, "storage"],
    ],
  );
  assert.equal(pins[0].typeName, "Temperate Command Center");
  assert.equal(pins[4].typeName, "Temperate Launchpad");
});

test("a FILETIME becomes epoch ms, and \"0\" becomes nothing at all", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const colony = payload.colonies[0];
  const active = colony.pins.find((pin) => pin.pinID === 2);
  const expired = colony.pins.find((pin) => pin.pinID === 3);

  assert.equal(active.program.installedAtMs, INSTALLED_AT_MS);
  assert.equal(active.program.expiresAtMs, EXPIRES_AT_MS);
  assert.equal(expired.program.expiresAtMs, EXPIRED_EXPIRES_AT_MS);
  assert.equal(colony.lastSimulatedAtMs, Date.UTC(2026, 6, 21, 11, 59, 0));

  // The launchpad's lastLaunchTime is the string "0" — EveJS's "never". It must
  // not surface as an instant in 1601, and the route must not invent one.
  const launchpad = colony.pins.find((pin) => pin.pinID === 5);
  assert.equal(launchpad.program, null);

  // serverNowMs is sampled in the SAME read, so the browser compares one clock.
  assert.equal(typeof payload.serverNowMs, "number");
  assert.ok(payload.serverNowMs > Date.UTC(2020, 0, 1));
});

test("an extraction program carries the server's own numbers, unchanged", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const active = payload.colonies[0].pins.find((pin) => pin.pinID === 2);

  assert.equal(active.program.resourceTypeName, "Aqueous Liquids");
  assert.equal(active.program.cycleTimeSeconds, 3600);
  assert.equal(active.program.quantityPerCycle, 2841);
  assert.equal(active.program.headCount, 3);
  // The drill area, which sets the run length — a restart sends it back.
  assert.equal(active.program.headRadius, 0.012);
});

test("an extractor states the most a cycle can yield: what its routes must reserve", async () => {
  // The retail client's EcuPin.GetMaxOutput: trunc(1.8 * qtyPerCycle) *
  // cycleSeconds / 900. 2841 an hour -> trunc(5113.8) * 4 = 20452.
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = payload.colonies[0].pins;
  assert.equal(pins.find((pin) => pin.pinID === 2).program.maxOutputPerCycle, 20452);
  // Thirty minutes of 1204 -> trunc(2167.2) * 2 = 4334.
  assert.equal(pins.find((pin) => pin.pinID === 3).program.maxOutputPerCycle, 4334);
});

test("a pin says whether it is running now, and a missing state stays unknown", async () => {
  const { baseUrl } = await selected({
    async getSnapshot() {
      const colony = capturedColony();
      delete colony.pins.find((pin) => pin.pinID === 4).state;
      return {
        planetRuntimeState: { schemaVersion: 1, coloniesByKey: { "40000002:140000238": colony } },
      };
    },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = payload.colonies[0].pins;
  assert.equal(pins.find((pin) => pin.pinID === 2).active, true);
  assert.equal(pins.find((pin) => pin.pinID === 3).active, false);
  assert.equal(pins.find((pin) => pin.pinID === 4).active, null);
});

test("a cycle time is TICKS on the wire and SECONDS in the answer", async () => {
  // The exact value a live read returned for the colony on Jita I. If this is
  // ever copied across unconverted it renders as a cycle 285 years long.
  const { baseUrl } = await selected({
    async getSnapshot() {
      const colony = capturedColony();
      const ecu = colony.pins.find((pin) => pin.pinID === 2);
      ecu.cycleTime = CYCLE_TICKS_LIVE_JITA;
      return {
        planetRuntimeState: { schemaVersion: 1, coloniesByKey: { "40000002:140000238": colony } },
      };
    },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const active = payload.colonies[0].pins.find((pin) => pin.pinID === 2);

  assert.equal(active.program.cycleTimeSeconds, 900, "9e9 ticks is 15 minutes");
  assert.notEqual(
    active.program.cycleTimeSeconds,
    CYCLE_TICKS_LIVE_JITA,
    "the raw tick count must never reach the browser as a duration",
  );
});

test("a cycle time of zero stays zero rather than becoming a rounding artefact", async () => {
  const { baseUrl } = await selected({
    async getSnapshot() {
      const colony = capturedColony();
      colony.pins.find((pin) => pin.pinID === 2).cycleTime = 0;
      return {
        planetRuntimeState: { schemaVersion: 1, coloniesByKey: { "40000002:140000238": colony } },
      };
    },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  assert.equal(
    payload.colonies[0].pins.find((pin) => pin.pinID === 2).program.cycleTimeSeconds,
    0,
  );
});

test("what is stored on a pin arrives as names and quantities, biggest first", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const launchpad = payload.colonies[0].pins.find((pin) => pin.pinID === 5);

  assert.deepEqual(
    launchpad.contents.map((entry) => [entry.typeName, entry.quantity]),
    [["Water", 4200], ["Bacteria", 300]],
  );
});

test("routes name what they carry", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const colony = payload.colonies[0];

  assert.equal(colony.linkCount, 4);
  assert.deepEqual(
    colony.routes.map((route) => [route.commodityTypeName, route.commodityQuantity]),
    [["Aqueous Liquids", 2841], ["Water", 20]],
  );
});

// --- What a pin holds, and how close it is to full -------------------------
// The panel cannot work this out for itself: it would need every commodity's
// volume and every structure's capacity, which is static data the browser does
// not have. So the BFF answers both in m³ and the browser does one division.

test("a pin says how full it is, and an unreadable capacity is null, not zero", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = new Map(payload.colonies[0].pins.map((pin) => [pin.pinID, pin]));

  // 12,000 Aqueous Liquids at 0.005 m³ = 60 m³ of a 12,000 m³ storage facility:
  // nearly empty, though the unit count is the largest on the planet. This is
  // exactly the reading a count of units gets WRONG.
  assert.equal(pins.get(6).usedM3, 60);
  assert.equal(pins.get(6).capacityM3, 12000);

  // 300 Bacteria + 4,200 Water, both 0.19 m³ = 855 m³ of a 10,000 m³ pad.
  assert.equal(pins.get(5).usedM3, 855);
  assert.equal(pins.get(5).capacityM3, 10000);

  // An empty command centre: 0 used is a FACT, and stays 0.
  assert.equal(pins.get(1).usedM3, 0);
  assert.equal(pins.get(1).capacityM3, 500);

  // ⚠ An extractor control unit and an industry facility carry capacity 0 in
  // the static table — they are not holds. That must arrive as null, because a
  // 0 would be divided into and report every one of them as full.
  assert.equal(pins.get(2).capacityM3, null);
  assert.equal(pins.get(4).capacityM3, null);
  assert.equal(pins.get(4).usedM3, 4.5);
});

test("one commodity with no volume makes the whole used volume unknown", async () => {
  // A partial sum is not a smaller number, it is a wrong one — and it would be
  // shown as a fill percentage. The storage pin holds a type the static table
  // has never heard of, so the honest answer for the pin is "we cannot say".
  const UNKNOWN_TYPE_ID = 9999999;
  const { baseUrl } = await selected({
    async getSnapshot() {
      const colony = capturedColony();
      const storage = colony.pins.find((pin) => pin.pinID === 6);
      storage.contents = { [AQUEOUS_LIQUIDS_TYPE_ID]: 12000, [UNKNOWN_TYPE_ID]: 1 };
      return {
        planetRuntimeState: {
          schemaVersion: 1,
          coloniesByKey: { [`${PLANET_ID}:${colony.ownerID}`]: colony },
        },
      };
    },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const storage = payload.colonies[0].pins.find((pin) => pin.pinID === 6);

  assert.equal(storage.usedM3, null);
  // The capacity is still perfectly readable, and still answered.
  assert.equal(storage.capacityM3, 12000);
});

test("a factory arrives named by what it makes and whether it was fed", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = new Map(payload.colonies[0].pins.map((pin) => [pin.pinID, pin]));
  const factory = pins.get(4);

  assert.equal(factory.schematicName, "Superconductors");
  assert.equal(factory.hasReceivedInputs, true);
  assert.equal(factory.receivedInputsLastCycle, true);

  // ⚠ THE FLAGS EXIST ON PROCESS PINS ONLY. The emulator's normalizePin writes
  // them onto factories and nothing else, so an extractor must answer null —
  // "this pin has no such state" — and never false, which reads as starved.
  assert.equal(pins.get(2).receivedInputsLastCycle, null);
  assert.equal(pins.get(2).hasReceivedInputs, null);
  assert.equal(pins.get(2).schematicName, null);
  assert.equal(pins.get(2).schematicID, null);
});

test("a pin's own instants arrive as epoch ms, and \"never\" stays nothing", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = new Map(payload.colonies[0].pins.map((pin) => [pin.pinID, pin]));

  assert.equal(pins.get(1).lastRunAtMs, Date.UTC(2026, 6, 21, 18, 45, 59) + 723);
  assert.equal(pins.get(5).lastRunAtMs, Date.UTC(2026, 6, 21, 18, 45, 59) + 724);

  // lastLaunchTime is the string "0" on both the pad and the command centre —
  // EveJS's "never". Null, not an instant in 1601.
  assert.equal(pins.get(1).lastLaunchAtMs, null);
  // A pin the emulator gives no lastLaunchTime at all answers the same way.
  assert.equal(pins.get(6).lastLaunchAtMs, null);
});

test("links arrive with their upgrade level, not just a count", async () => {
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const colony = payload.colonies[0];

  // The count stays what it was; the links are new beside it.
  assert.equal(colony.linkCount, 4);
  assert.deepEqual(colony.links, [
    { endpoint1: 1, endpoint2: 2, level: 0 },
    { endpoint1: 1, endpoint2: 4, level: 1 },
    { endpoint1: 4, endpoint2: 5, level: 0 },
    { endpoint1: 1, endpoint2: 6, level: 0 },
  ]);
});

test("\"you have no colonies\" is a different answer from \"colonies could not be read\"", async () => {
  const empty = await selected({
    async getSnapshot() {
      return { planetRuntimeState: { schemaVersion: 1, coloniesByKey: {} } };
    },
  });
  const { payload: emptyPayload } = await apiRequest(empty.baseUrl, "/api/bridge/planets");
  assert.equal(emptyPayload.coloniesReadable, true);
  assert.deepEqual(emptyPayload.colonies, []);

  // A gateway that reports no colony table at all has NOT told us the character
  // has none. Saying "you have no colonies" here would be a guess.
  const silent = await selected({
    async getSnapshot() {
      return { source: "evejs-web-gateway", apiVersion: 1 };
    },
  });
  const { payload: silentPayload } = await apiRequest(silent.baseUrl, "/api/bridge/planets");
  assert.equal(silentPayload.coloniesReadable, false);
  assert.deepEqual(silentPayload.colonies, []);
});

test("a character the gateway does not know is a 404, not an empty colony list", async () => {
  const { baseUrl } = await selected({
    async getSnapshot() {
      return null;
    },
  });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  assert.equal(response.status, 404);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "CHARACTER_NOT_FOUND");
});

test("without a held bridge session there is nothing to read", async () => {
  const { baseUrl } = await startTestServer();
  const { response } = await apiRequest(baseUrl, "/api/bridge/planets");
  assert.equal(response.status, 409);
});

test("a planet the static map cannot name answers null, never a stringified id", async () => {
  const { baseUrl } = await selected();
  const app = await apiRequest(baseUrl, "/api/bridge/planets");
  assert.equal(app.payload.colonies[0].planetName, "Tanoo I");

  const unnamed = await selected({
    async getSnapshot() {
      const colony = capturedColony();
      colony.planetID = 40999999;
      return {
        planetRuntimeState: { schemaVersion: 1, coloniesByKey: { "40999999:140000238": colony } },
      };
    },
  });
  const { payload } = await apiRequest(unnamed.baseUrl, "/api/bridge/planets");
  assert.equal(payload.colonies[0].planetName, null);
  assert.ok(
    !JSON.stringify(payload.colonies[0].planetName).includes("40999999"),
    "an unnamed planet must not fall back to printing its id",
  );
});

test("an extractor states where its heads are and its yield's noise: what the planet is asked a programme's yield with", async () => {
  // clientPlanet.InstallProgram: remoteHandler.GetProgramResultInfo(pinID, typeID, pin.heads, headRadius), and
  // EcuPin.GetMaxOutput of what it answers, which wants the noise (attribute 1687).
  const { baseUrl } = await selected();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/planets");
  const pins = payload.colonies[0].pins;
  assert.deepEqual(pins.find((pin) => pin.pinID === 2).program.heads, [[0, 0.121, 0.221], [1, 0.119, 0.223], [2, 0.122, 0.219]]);
  assert.deepEqual(pins.find((pin) => pin.pinID === 3).program.heads, [[0, 0.311, 0.441]]);
  assert.deepEqual([pins.find((pin) => pin.pinID === 2).program.noiseFactor, pins.find((pin) => pin.pinID === 3).program.noiseFactor], [0.8, 0.8]);
});
