"use strict";

// The server-side bot routes' HANDOVER contract: POST /api/bots/start moves
// the hull in ONE request. When the CALLER's own web session is flying the
// requested character, the route releases that session BEFORE the bot host
// starts — so the instant the request answers, the bot exists and the
// login/select screens' bot-flying marks are right on their first read. Any
// other session's hull is never touched here (the host's own CHARACTER_IN_USE
// check still refuses those).
//
// The bot HOST itself is faked (its engine is covered by src/botHost.test.js
// and live drills); these tests pin the ROUTE's behavior around it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-bots-"));

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");

const FARMER = { username: "farmer", accountID: 4001, role: "0", banned: false };
const CHARACTERS = [
  { characterID: 7001, accountID: 4001, characterName: "Ore Farmer" },
  { characterID: 7002, accountID: 4001, characterName: "Second Pilot" },
];
const GRANT = { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 720 };

const activeServers = new Set();

function fakeStore() {
  return {
    async getAccount(username) {
      return String(username) === FARMER.username ? { ...FARMER } : null;
    },
    async listCharactersForAccount(accountID) {
      return Number(accountID) === FARMER.accountID ? CHARACTERS.map((row) => ({ ...row })) : [];
    },
    async getCharacterForAccount(accountID, characterID) {
      if (Number(accountID) !== FARMER.accountID) {
        return null;
      }
      const row = CHARACTERS.find((entry) => entry.characterID === Number(characterID));
      return row ? { ...row } : null;
    },
  };
}

// Bridge sessions the fake gateway has "lost": a call on one is refused the way
// a reaped or taken-over session is.
const lostSessions = new Set();

function fakeGateway(log) {
  return {
    async getCharacterStatus(_accountID, characterID) { return { characterID, online: false, controlState: "offline" }; },
    async selectFactoryCharacter(_accountID, characterID) { return this.selectCharacter([characterID]); },
    async readFlightStatus(bridgeSessionID) {
      if (lostSessions.has(bridgeSessionID)) {
        throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND" });
      }
      return { flight: { docked: true, inSpace: false, stationID: 60000004, shipID: 9001 }, notifications: [] };
    },
    async selectCharacter(args) {
      const characterID = Number(args[0]);
      return {
        bridgeSessionID: `bridge-for-${characterID}`,
        session: { characterID, characterName: "x", stationID: 60000004, solarSystemID: 30000001, corporationID: 1000001, shipID: 9001 },
        notifications: [],
      };
    },
    async releaseBridgeSession(bridgeSessionID) {
      log.push(["release", bridgeSessionID]);
      return { released: true };
    },
    async callMethod(service, method, args, kwargs, identity, bridgeSessionID) {
      if (lostSessions.has(bridgeSessionID)) {
        throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND" });
      }
      return { service, method, result: {}, notifications: [] };
    },
    openSessionEventStream(options) {
      return { ...options, close() {} };
    },
  };
}

function fakeBotHost(log) {
  return {
    async start(input) {
      if (input.beforeStart) await input.beforeStart();
      // The full input, not just the characterID — the companion tests below
      // need to see which branch of /api/bots/start actually built it.
      log.push(["start", input]);
      return {
        ok: true,
        bot: { botID: "bot-1", characterID: input.characterID, status: "running", startedAt: "now" },
      };
    },
    async stop() {
      return { ok: false, code: "BOT_NOT_FOUND" };
    },
    list: () => [],
    claimedBy: () => null,
    authorizesClaim: () => false,
    activeCharacterIDs: () => [7001],
    activeBots: () => [
      { characterID: 7001, status: "running", phase: "Mining", why: null, note: null, vitals: null },
    ],
    sampleAllVitals: async () => {},
    resume: async () => {},
    stopAll: async () => {},
  };
}

async function startTestServer(log, suppliedBotHost = null, suppliedGateway = null) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: suppliedGateway || fakeGateway(log),
    webAuth,
    botHost: suppliedBotHost || fakeBotHost(log),
    // The script library is platform-wide, so get() looks up by scriptID alone
    // and every account sees the same record; `authorAccountID` is display-only
    // and grants nothing. AUTHORITY over the hull is still per-account, and the
    // route proves it through getCharacterForAccount above, not through here.
    botScriptStore: {
      get: (scriptID) =>
        scriptID === "s1"
          ? {
              scriptID: "s1",
              authorAccountID: FARMER.accountID,
              authorName: FARMER.username,
              name: "Miner",
              rev: 1,
              doc: { format: "evejs-bot-script" },
            }
          : null,
      list: () => [],
    },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
}

test.after(() => {
  for (const server of activeServers) {
    server.close();
  }
});

async function request(baseUrl, routePath, { method = "GET", token, body, headers: suppliedHeaders = {} } = {}) {
  const headers = { "content-type": "application/json", ...suppliedHeaders };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function signInAndSelect(baseUrl, characterID) {
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  const token = login.payload.sessionToken;
  const selected = await request(baseUrl, "/api/bridge/select", { method: "POST", token, body: { characterID } });
  assert.equal(selected.response.status, 200);
  const ready = await request(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", token, body: { checkID: selected.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
  return token;
}

test("run-on-server releases the CALLER's held hull before the bot starts", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = await signInAndSelect(baseUrl, 7001);
  assert.equal(app.locals.bridgeSessions.size, 1);

  const { response, payload } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7001, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.bot.characterID, 7001);
  // The caller's session is gone, and it was gone BEFORE the host started.
  assert.equal(app.locals.bridgeSessions.size, 0);
  assert.deepEqual(
    log.filter((row) => row[0] !== "start" || true).map((row) => row[0]),
    ["release", "start"],
  );
});

test("an unconfirmed browser release blocks handoff without forgetting the owner", async () => {
  const log = [];
  const gateway = fakeGateway(log);
  gateway.releaseBridgeSession = async () => ({ released: false });
  const { baseUrl, app } = await startTestServer(log, null, gateway);
  const token = await signInAndSelect(baseUrl, 7001);
  const { response, payload } = await request(baseUrl, "/api/bots/start", {
    method: "POST", token, body: { characterID: 7001, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "PILOT_RELEASE_UNVERIFIED");
  assert.equal(app.locals.bridgeSessions.size, 1);
});

test("a failed hosted start restores only the released caller's browser owner", async () => {
  const log = [];
  const botHost = fakeBotHost(log);
  botHost.start = async (input) => {
    await input.beforeStart();
    return { ok: false, code: "BOT_START_FAILED", message: "Could not start." };
  };
  const { baseUrl, app } = await startTestServer(log, botHost);
  const token = await signInAndSelect(baseUrl, 7001);
  const original = app.locals.bridgeSessions.get(webAuth.verifySessionToken(token).sessionID);
  const { response } = await request(baseUrl, "/api/bots/start", {
    method: "POST", token, body: { characterID: 7001, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 502);
  const restored = app.locals.bridgeSessions.get(webAuth.verifySessionToken(token).sessionID);
  assert.equal(restored.characterID, 7001);
  assert.notEqual(restored, original, "a fresh gateway selection restored ownership");
});

test("forged cleanup cannot release another session; signed expired cleanup can", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = webAuth.createSessionToken(FARMER, { ttlMs: 1 });
  const [encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  app.locals.bridgeSessions.set(payload.sessionID, {
    bridgeSessionID: "expired-bridge", accountID: FARMER.accountID, characterID: 7001,
    boundHandles: new Map(), streamSubscribers: new Set(), stream: null, chat: null,
    droneRecoveryReady: true,
  });
  const altered = { ...payload, accountID: 9999 };
  const forged = `${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;
  const forgedResult = await request(baseUrl, "/api/logout", { method: "POST", token: forged });
  assert.equal(forgedResult.response.status, 401);
  assert.equal(app.locals.bridgeSessions.has(payload.sessionID), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { response } = await request(baseUrl, "/api/logout", { method: "POST", token });
  assert.equal(response.status, 200);
  assert.equal(app.locals.bridgeSessions.has(payload.sessionID), false);
  assert.deepEqual(log.filter(([name]) => name === "release"), [["release", "expired-bridge"]]);
});

test("a signed token cannot confirm logout of a held row owned by another account", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = webAuth.createSessionToken(FARMER);
  const payload = webAuth.verifySessionToken(token);
  app.locals.bridgeSessions.set(payload.sessionID, {
    bridgeSessionID: "other-account-bridge", accountID: 9999, characterID: 7001,
    boundHandles: new Map(), streamSubscribers: new Set(), stream: null, chat: null,
  });
  const { response } = await request(baseUrl, "/api/logout", { method: "POST", token });
  assert.equal(response.status, 409);
  assert.equal(app.locals.bridgeSessions.has(payload.sessionID), true);
  assert.equal(log.some(([name]) => name === "release"), false);
});

test("an ambiguous logout leaves the signed session held for safe retry", async () => {
  const log = [];
  const gateway = fakeGateway(log);
  gateway.releaseBridgeSession = async () => ({ released: false });
  const { baseUrl, app } = await startTestServer(log, null, gateway);
  const token = await signInAndSelect(baseUrl, 7001);
  const { response, payload } = await request(baseUrl, "/api/logout", { method: "POST", token });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "PILOT_RELEASE_UNVERIFIED");
  assert.equal(app.locals.bridgeSessions.size, 1);
});

test("a caller flying a DIFFERENT character keeps their hull", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = await signInAndSelect(baseUrl, 7001);

  const { response } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7002, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 200);
  // No release happened; the caller still flies 7001.
  assert.equal(app.locals.bridgeSessions.size, 1);
  assert.deepEqual(log.map((row) => row[0]), ["start"]);
});

test("/api/bots/active answers WITHOUT auth: ids + game-state rows, nothing controllable", async () => {
  const { baseUrl } = await startTestServer([]);
  const { response, payload } = await request(baseUrl, "/api/bots/active");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.characterIDs, [7001]);
  assert.equal(payload.bots.length, 1);
  assert.equal(payload.bots[0].characterID, 7001);
  assert.equal(payload.bots[0].phase, "Mining");
  // No handle a caller could act on, and no account/script identity.
  assert.equal("botID" in payload.bots[0], false);
  assert.equal("scriptID" in payload.bots[0], false);
  assert.equal("accountID" in payload.bots[0], false);
});

test("a public bot ID cannot bypass the claimed-character select guard", async () => {
  const log = [];
  const host = {
    ...fakeBotHost(log),
    claimedBy: (characterID) => (Number(characterID) === 7001 ? "public-bot-id" : null),
    authorizesClaim: (characterID, secret) => Number(characterID) === 7001 && secret === "private-capability",
  };
  const { baseUrl } = await startTestServer(log, host);
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  const token = login.payload.sessionToken;

  const refused = await request(baseUrl, "/api/bridge/select", {
    method: "POST",
    token,
    headers: { "x-evejs-bot-claim": "public-bot-id" },
    body: { characterID: 7001 },
  });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.payload.error, "CHARACTER_IN_USE_BY_BOT");

  const authorized = await request(baseUrl, "/api/bridge/select", {
    method: "POST",
    token,
    headers: { "x-evejs-bot-claim": "private-capability" },
    body: { characterID: 7001 },
  });
  assert.equal(authorized.response.status, 200);
});

// ── kind: "companion" — the SAME route, branched by the body ────────────────
// docs/fleet-companion-handoff.md, "3. Extend botHost": no second route, so
// these pin that /api/bots/start's companion branch reaches botHost.start
// with the request instead of a script lookup, while the ownership check and
// the same-session hull handover stay identical either way.

const COMPANION_REQUEST = { role: "dps", useDrones: false };
const COMPANION_GRANT = { scriptRev: 1, riskClasses: ["fleet", "social"], maxRuntimeMinutes: 720 };

test("kind: \"companion\" reaches botHost.start with the request, never a script lookup", async () => {
  const log = [];
  // A botScriptStore whose get() throws proves the companion branch never
  // touches the script library at all.
  const scriptLookups = [];
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: fakeGateway(log),
    webAuth,
    botHost: fakeBotHost(log),
    botScriptStore: {
      get: (scriptID) => {
        scriptLookups.push(scriptID);
        return null;
      },
      list: () => [],
    },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const token = await signInAndSelect(baseUrl, 7001);
  const { response, payload } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7001, kind: "companion", request: COMPANION_REQUEST, grant: COMPANION_GRANT },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.bot.characterID, 7001);
  assert.equal(scriptLookups.length, 0, "the companion branch must never look up a saved script");

  const startCall = log.find((row) => row[0] === "start");
  assert.ok(startCall, "botHost.start must have been called");
  assert.equal(startCall[1].kind, "companion");
  assert.deepEqual(startCall[1].request, COMPANION_REQUEST);
  assert.deepEqual(startCall[1].grant, COMPANION_GRANT);
  // The same handover this route already proves for a script: the caller's
  // own held hull is released before the bot starts.
  assert.equal(app.locals.bridgeSessions.size, 0);
});

test("kind absent defaults to \"script\" — an old caller's request body still starts a script", async () => {
  const log = [];
  const { baseUrl } = await startTestServer(log);
  const token = await signInAndSelect(baseUrl, 7001);
  const { response, payload } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7001, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.bot.characterID, 7001);
  const startCall = log.find((row) => row[0] === "start");
  assert.equal(startCall[1].kind, "script");
  assert.equal(startCall[1].scriptID, "s1");
});

// GET /api/bots/corp-assets: the PI board's corp hangar read through a RUNNING
// bot's own game session. The held session a real bot would hold is stood up
// here by an ordinary select; the fake host hands out its web session id the
// way botHost.readableSessionOf does -- for the owning account only.
async function botHeldSession(baseUrl, app, characterID) {
  const botToken = await signInAndSelect(baseUrl, characterID);
  const botSessionID = webAuth.verifySessionToken(botToken).sessionID;
  assert.ok(app.locals.bridgeSessions.has(botSessionID));
  return botSessionID;
}

async function signIn(baseUrl) {
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  return login.payload.sessionToken;
}

function readingHost(log, sessionOf) {
  return { ...fakeBotHost(log), readableSessionOf: sessionOf };
}

test("a bot's corp read rides the bot's session and only reads corpmgr", async () => {
  const log = [];
  let botSessionID = null;
  const asked = [];
  const { baseUrl, app } = await startTestServer(
    log,
    readingHost(log, (characterID, accountID) => {
      asked.push([characterID, accountID]);
      return botSessionID;
    }),
  );
  botSessionID = await botHeldSession(baseUrl, app, 7001);
  const token = await signIn(baseUrl);

  const { response, payload } = await request(baseUrl, "/api/bots/corp-assets?characterID=7001&locationID=60000004", { token });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.requested.corporationID, 1000001);
  assert.deepEqual(asked, [[7001, FARMER.accountID]]);
  // The bot's hull is exactly where it was: nothing released, nothing started.
  assert.equal(app.locals.bridgeSessions.get(botSessionID).characterID, 7001);
  assert.deepEqual(log, []);
});

test("no bot flying the pilot is a plain 409, never a select", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log, readingHost(log, () => null));
  const token = await signIn(baseUrl);
  const { response, payload } = await request(baseUrl, "/api/bots/corp-assets?characterID=7001", { token });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_BOT_SESSION");
  assert.equal(app.locals.bridgeSessions.size, 0);
});

test("the bot corp read needs a sign-in", async () => {
  const log = [];
  const { baseUrl } = await startTestServer(log, readingHost(log, () => "anything"));
  const { response } = await request(baseUrl, "/api/bots/corp-assets?characterID=7001");
  assert.equal(response.status, 401);
});

test("a lost session on a bot corp read leaves the bot's handle in place", async () => {
  const log = [];
  let botSessionID = null;
  const { baseUrl, app } = await startTestServer(log, readingHost(log, () => botSessionID));
  botSessionID = await botHeldSession(baseUrl, app, 7001);
  const token = await signIn(baseUrl);
  // The gateway has lost the bot's game session; the select above predates it.
  const bridgeSessionID = app.locals.bridgeSessions.get(botSessionID).bridgeSessionID;
  lostSessions.add(bridgeSessionID);
  try {
    const { response } = await request(baseUrl, "/api/bots/corp-assets?characterID=7001", { token });
    assert.notEqual(response.status, 200);
  } finally {
    lostSessions.delete(bridgeSessionID);
  }
  assert.ok(app.locals.bridgeSessions.has(botSessionID), "the bot must find its lost session itself");
});

// GET /api/bots/corp-division-names: the Haul picker's division names, read
// through a RUNNING bot's own session, on the same terms as the corp read.
test("a bot's division-name read rides the bot's session and answers seven divisions", async () => {
  const log = [];
  let botSessionID = null;
  const asked = [];
  const { baseUrl, app } = await startTestServer(
    log,
    readingHost(log, (characterID, accountID) => {
      asked.push([characterID, accountID]);
      return botSessionID;
    }),
  );
  botSessionID = await botHeldSession(baseUrl, app, 7001);
  const token = await signIn(baseUrl);

  const { response, payload } = await request(baseUrl, "/api/bots/corp-division-names?characterID=7001", { token });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.divisions.length, 7);
  assert.deepEqual(payload.divisions[0], { division: 1, name: null });
  assert.deepEqual(asked, [[7001, FARMER.accountID]]);
  assert.equal(app.locals.bridgeSessions.get(botSessionID).characterID, 7001);
  assert.deepEqual(log, []);
});

test("no bot flying the pilot: the division-name read is a plain 409, never a select", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log, readingHost(log, () => null));
  const token = await signIn(baseUrl);
  const { response, payload } = await request(baseUrl, "/api/bots/corp-division-names?characterID=7001", { token });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_BOT_SESSION");
  assert.equal(app.locals.bridgeSessions.size, 0);
});
