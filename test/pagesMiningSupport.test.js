"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-mining-support-"));
process.env.EVEJS_WEB_POC_DATA_DIR = dataDir;

const { createApp } = require("../src/server");
const { BOT_HEADER } = require("../src/botHost");

const ACCOUNT = { username: "miner-account", accountID: 4001, role: "0", banned: false };
const JITA = 30000142;
const FLEET = "654500019999";
const PILOTS = [
  { characterID: 7001, accountID: 4001, characterName: "Miner One" },
  { characterID: 7002, accountID: 4001, characterName: "Miner Two" },
  { characterID: 7005, accountID: 4001, characterName: "Command One" },
  { characterID: 7004, accountID: 4001, characterName: "Miner Alone" },
];
const realFetch = globalThis.fetch;
const activeServers = new Set();

const keyVal = (entries) => ({ type: "object", args: { type: "dict", entries } });
const shipOf = (characterID) => 500000 + characterID;
async function fleet() {
  const held = new Map();
  const claims = new Map();
  const errors = [];
  const sameClaim = (characterID, secret) => claims.has(Number(characterID)) && claims.get(Number(characterID)).secret === secret;
  const app = createApp({
    eveStore: {
      getAccount: async (username) => (username === ACCOUNT.username ? { ...ACCOUNT } : null),
      getCharacterForAccount: async (accountID, characterID) => PILOTS.find((row) => row.characterID === Number(characterID)) || null,
      listCharactersForAccount: async () => PILOTS.map((row) => ({ ...row })),
    },
    // The pilot reads its own fleet roster.
    eveGatewayClient: {
      async bindObject(service, method, args, kwargs, fields, bridgeSessionID) { return { boundHandle: bridgeSessionID }; },
      async callBoundMethod() {
        return { result: keyVal([["fleetID", { type: "long", value: FLEET }],
          ["members", { type: "dict", entries: [...held.values()].map((row) => [row.characterID, keyVal([["charID", row.characterID], ["solarSystemID", JITA]])]) }]]) };
      },
    },
    webAuth: {
      createSessionToken() { return "token-tab"; },
      verifySessionToken(token) {
        return /^token-(\d+|tab)$/.test(String(token)) ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: `session-${String(token).slice(6)}` } : null;
      },
      countConfiguredUsers() { return 1; },
    },
    botHost: {
      claimedBy: (characterID) => (claims.has(Number(characterID)) ? `bot-${characterID}` : null),
      authorizesClaim: sameClaim,
      activeCharacterIDs: () => [],
      activeBots: () => [],
      sampleAllVitals: async () => {},
      resume: async () => {},
      stopAll: async () => {},
    },
    bridgeSessionStore: held,
    staticData: { listMiningResources: () => [{ typeID: 123, name: "Test ore", family: "ore" }] },
    errorLogger(error) { errors.push(error); },
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = await import("../web/src/app/api.ts");
  const paths = [];
  const bodies = [];
  const answers = [];
  // The page's own request with a session's token, and a hosted bot's claim on it where there is one: what was
  // asked, what was sent and what was answered are kept, and it is sent on.
  const asking = (token, secret) => ({
    baseUrl,
    token,
    fetch: async (input, init = {}) => {
      paths.push(`${init.method || "GET"} ${String(input).replace(/^https?:\/\/[^/]+/, "")}`);
      bodies.push(init.body === undefined ? null : JSON.parse(init.body));
      const headers = new Headers(init.headers);
      if (secret) headers.set(BOT_HEADER, secret);
      const response = await realFetch(input, { ...init, headers });
      answers.push([response.status, await response.clone().json().catch(() => null)]);
      return response;
    },
  });
  /** A pilot online in a web session of its own, in its own ship in Jita: a hosted bot's where it is given a secret. */
  const online = (pilot, secret = null) => {
    held.set(`session-${pilot.characterID}`, { characterID: pilot.characterID, accountID: ACCOUNT.accountID, bridgeSessionID: `held-${pilot.characterID}`,
      solarSystemID: JITA, activeShipID: shipOf(pilot.characterID), fleetID: null, boundHandles: new Map(), transition: null, streamSubscribers: new Set(),
      ...(secret ? { botClaimSecret: secret } : {}) });
  };
  const tab = asking("token-tab", null);
  const bots = {};
  for (const pilot of PILOTS) {
    const secret = `secret-${pilot.characterID}`;
    claims.set(pilot.characterID, { secret });
    online(pilot, secret);
    bots[pilot.characterID] = asking(`token-${pilot.characterID}`, secret);
  }
  return { api, baseUrl, bots, paths, bodies, answers, tab, errors };
}


test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    server.closeAllConnections();
    closing.push(new Promise((resolve) => { server.close(() => resolve()); }));
  }
  await Promise.all(closing);
});

test("the hosted pilot can read its support fleet roster and the anchor writes are retired", async () => {
  const { api, baseUrl, bots } = await fleet();
  const read = await api.readMiningSupportAnchors(bots[7002]);
  assert.equal(read.availability, "available");
  assert.equal(read.fleet.readerCharacterID, 7002);
  assert.ok(read.fleet.members.some(pilot => pilot.characterID === 7005));
  assert.deepEqual(read.anchors, []);
  for (const suffix of ["", "/release"]) {
    const response = await realFetch(baseUrl + "/api/bots/mining-support-anchors" + suffix, {
      method: "POST", headers: { authorization: "Bearer token-7002", [BOT_HEADER]: "secret-7002" },
    });
    assert.equal(response.status, 404);
  }
});

test("the authenticated resource catalog remains available while retired Core MCC routes return 404", async () => {
  const oldStore = path.join(dataDir, "mining-operations.json");
  const oldData = JSON.stringify({ operations: [{ operationID: "retired" }] });
  fs.writeFileSync(oldStore, oldData);
  const { baseUrl, api, tab } = await fleet();
  assert.deepEqual(await api.listMiningResources(tab), [{ typeID: 123, name: "Test ore", family: "ore" }]);
  assert.equal((await realFetch(baseUrl + "/api/mining-operations/resources")).status, 401);
  for (const [method, path] of [
    ["GET", "/mining-command-center"], ["GET", "/mining-command-center/"], ["GET", "/mining-command-center/old"],
    ["GET", "/api/mining-operations"], ["POST", "/api/mining-operations"],
    ["GET", "/api/mining-operations/assignment/current"], ["GET", "/api/mining-operations/preparation-options"],
    ["POST", "/api/mining-operations/old/start"], ["POST", "/api/mining-operations/old/stop"],
    ["POST", "/api/mining-operations/old/delete"], ["POST", "/api/bots/old/reconnect"],
    ["POST", "/api/bridge/ship/jettison"], ["POST", "/api/bridge/ship/jettison/reconcile"],
  ]) {
    const response = await realFetch(baseUrl + path, { method, headers: { authorization: "Bearer token-tab" } });
    assert.equal(response.status, 404, method + " " + path);
  }
  assert.equal(fs.readFileSync(oldStore, "utf8"), oldData);
});
