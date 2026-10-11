"use strict";

// The GM console route: POST /api/bridge/gm/slash -> slash.SlashCmd(command).
//
// ⚠⚠ THE WIDEST SURFACE IN THE BFF. One route reaches every chat command this
// world has, including destructive ones. It exists because the web client could
// not otherwise stage its own test state — no ship, no module, no ammunition —
// which blocked verifying whole features against anything but a hand-edited
// gamestore.
//
// So what this suite pins is the SHAPE OF THE GATE, not the commands:
//   1. nothing dispatches without `confirm: true`;
//   2. the command reaches the server VERBATIM (a BFF that curated the list
//      would be a worse, staler copy of the server's own);
//   3. a command that is not a command is refused HERE, because the server
//      answers a bare word with its entire ~150-entry list;
//   4. the server's own reply is surfaced untouched, including its failures;
//   5. it still needs a live session and a web login, like every other write.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;
const CHARACTER_ID = 7;

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

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
        ? { characterID: CHARACTER_ID, accountID: 4, characterName: "Test Pilot" }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return {
    getStation() {
      return null;
    },
    getTypeName(id) {
      return `Type ${id}`;
    },
    resolveNames() {
      return { names: {}, capped: false, limit: 500 };
    },
  };
}

function fakeGateway(options = {}) {
  const calls = { callMethod: [] };
  return {
    calls,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: SOLAR_SYSTEM_ID,
          corporationID: 98000000,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.callMethod.push({ service, method, args, kwargs, bridgeSessionID });
      if (options.throwOn && options.throwOn === method) {
        throw Object.assign(new Error("CALL_FAILED"), { code: "CALL_FAILED" });
      }
      return {
        service,
        method,
        result: options.result === undefined ? "Gave 1 x 150mm Light AutoCannon I." : options.result,
        notifications: [],
      };
    },
  };
}

async function startTestServer(gateway) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.auth !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
}

function slashCalls(gateway) {
  return gateway.calls.callMethod.filter((call) => call.method === "SlashCmd");
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  }
  await Promise.all(closing);
});

test("⚠⚠ a GM command REFUSES without confirm — nothing reaches the world", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: "/giveitem 150mm Light AutoCannon I 1" },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  assert.equal(slashCalls(gateway).length, 0, "an unconfirmed GM command must not dispatch");
});

test("a confirmed command reaches slash.SlashCmd VERBATIM", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const command = "/giveitem Phased Plasma S 5000";
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command, confirm: true },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const [call] = slashCalls(gateway);
  assert.equal(call.service, "slash");
  // Verbatim, argument shape included: the server's own parser owns the rest.
  assert.deepEqual(call.args, [command]);
  assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
});

test("surrounding whitespace is trimmed, the command itself is not touched", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: "   /gmweapons   ", confirm: true },
  });

  assert.deepEqual(slashCalls(gateway)[0].args, ["/gmweapons"]);
});

test("the SERVER's own reply is surfaced untouched", async () => {
  const gateway = fakeGateway({ result: "Gave 5000 x Phased Plasma S." });
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: "/giveitem Phased Plasma S 5000", confirm: true },
  });

  assert.equal(payload.result, "Gave 5000 x Phased Plasma S.");
});

test("a command the world refuses is reported as the world worded it", async () => {
  // eve.js catches its own command errors and RETURNS the message rather than
  // throwing, so a failure arrives as an ordinary 200 with a sentence in it.
  // The route must not dress that up as a success or as an error of its own.
  const gateway = fakeGateway({ result: "Command failed: Unknown item 'Nonexistent Thing'." });
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: "/giveitem Nonexistent Thing", confirm: true },
  });

  assert.match(payload.result, /^Command failed:/);
});

test("something that is not a command is refused HERE, not answered with a wall of help", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  for (const command of ["giveitem Phased Plasma S", "hello", "  "]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
      method: "POST",
      body: { command, confirm: true },
    });
    assert.equal(response.status, 400, `${JSON.stringify(command)} must be refused`);
    assert.ok(["COMMAND_REQUIRED", "COMMAND_INVALID"].includes(payload.error), payload.error);
  }
  assert.equal(slashCalls(gateway).length, 0);
});

test("the dot-prefixed container commands are accepted too", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: ".container1", confirm: true },
  });

  assert.deepEqual(slashCalls(gateway)[0].args, [".container1"]);
});

test("it needs a live session, and a web login", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);

  // No character online.
  const noSession = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    body: { command: "/gmships", confirm: true },
  });
  assert.equal(noSession.response.status, 409);
  assert.equal(noSession.payload.error, "NO_LIVE_SESSION");

  // No login at all.
  const anonymous = await apiRequest(baseUrl, "/api/bridge/gm/slash", {
    method: "POST",
    auth: false,
    body: { command: "/gmships", confirm: true },
  });
  assert.equal(anonymous.response.status, 401);
  assert.equal(slashCalls(gateway).length, 0);
});

// ── the page's own call ──────────────────────────────────────────────────────
//
// The console's command is one of the writes the page makes itself: slash.SlashCmd by the generic call, as a
// pilot's call the page says it means. What the route checked of the line, the page checks before it asks.

test("a GM command by the page's own call is a write the page means: refused without both words, and sent verbatim with them", async () => {
  const gateway = fakeGateway({ result: "Gave 5000 x Phased Plasma S." });
  const baseUrl = await startTestServer(gateway);
  await selectOnServer(baseUrl);
  const command = "/giveitem Phased Plasma S 5000";
  const call = (more) => apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service: "slash", method: "SlashCmd", args: [command], kwargs: null, ...more } });

  for (const more of [{}, { pilot: true }, { confirm: true }]) {
    const refused = await call(more);
    assert.deepEqual([refused.response.status, refused.payload.error], [403, "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE"], JSON.stringify(more));
  }
  assert.equal(slashCalls(gateway).length, 0, "nothing reaches the world unmeant");

  const made = await call({ pilot: true, confirm: true });
  // The generic call's own answer, with the world's reply as it came; none of the route's envelope.
  assert.deepEqual([made.response.status, made.payload.ok, made.payload.service, made.payload.method, made.payload.result, made.payload.applied],
    [200, true, "slash", "SlashCmd", "Gave 5000 x Phased Plasma S.", undefined]);
  // sm.RemoteSvc('slash').SlashCmd(line): the one line, on the pilot's own session, once.
  assert.deepEqual(slashCalls(gateway).map((each) => [each.service, each.args, each.kwargs, each.bridgeSessionID]), [["slash", [command], null, BRIDGE_SESSION_ID]]);
});

test("the page's own GM command needs a pilot held, as its route did", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);

  const refused = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service: "slash", method: "SlashCmd", args: ["/gmships"], kwargs: null, pilot: true, confirm: true } });

  assert.deepEqual([refused.response.status, refused.payload.error], [409, "NO_LIVE_SESSION"]);
  assert.equal(slashCalls(gateway).length, 0);
});
