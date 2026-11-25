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
const { createMiningSupportAnchorBoard } = require("../src/miningSupportAnchorBoard");

const ACCOUNT = { username: "miner-account", accountID: 4001, role: "0", banned: false };
const JITA = 30000142;
const FLEET = "654500019999";
const PILOTS = [
  { characterID: 7001, accountID: 4001, characterName: "Miner One" },
  { characterID: 7002, accountID: 4001, characterName: "Miner Two" },
  { characterID: 7005, accountID: 4001, characterName: "Command One" },
  { characterID: 7004, accountID: 4001, characterName: "Miner Alone" },
];
const START = 1_800_000_000_000;
const realFetch = globalThis.fetch;
const activeServers = new Set();

const keyVal = (entries) => ({ type: "object", args: { type: "dict", entries } });
const shipOf = (characterID) => 500000 + characterID;
/** A pilot's own scene: its own ship in Jita, sound unless told otherwise. */
const scene = (characterID, ship = {}, more = {}) => ({ inSpace: true, shipID: shipOf(characterID), solarSystemID: JITA, sampledAtMs: 400,
  ship: { itemID: shipOf(characterID), characterID, radius: 100, position: { x: 0, y: 0, z: 0 }, shieldRatio: 0.9, armorRatio: 1, hullRatio: 1,
    miningBurstServices: { activeModuleIDs: [42], bursts: [{ moduleID: 42, typeID: 99, rangeMeters: 90_000 }] },
    compressionService: { state: "active", typeListRanges: [{ typeListID: 10, rangeMeters: 60_000 }], compressors: [{ moduleID: 43, typeID: 100 }] }, ...ship },
  entities: [], ...more });
const refusedAs = (status, code) => (error) => error.status === status && error.code === code;

async function fleet() {
  const clock = { at: START };
  const now = () => clock.at;
  const held = new Map();
  const claims = new Map();
  const errors = [];
  const scenes = new Map();
  const sameClaim = (characterID, secret) => claims.has(Number(characterID)) && claims.get(Number(characterID)).secret === secret;
  const app = createApp({
    eveStore: {
      getAccount: async (username) => (username === ACCOUNT.username ? { ...ACCOUNT } : null),
      getCharacterForAccount: async (accountID, characterID) => PILOTS.find((row) => row.characterID === Number(characterID)) || null,
      listCharactersForAccount: async () => PILOTS.map((row) => ({ ...row })),
    },
    // The pilot's transport: its fleet as its session is told it (every pilot online here is of the one fleet),
    // and its own scene.
    eveGatewayClient: {
      async bindObject(service, method, args, kwargs, fields, bridgeSessionID) { return { boundHandle: bridgeSessionID }; },
      async callBoundMethod() {
        return { result: keyVal([["fleetID", { type: "long", value: FLEET }],
          ["members", { type: "dict", entries: [...held.values()].map((row) => [row.characterID, keyVal([["charID", row.characterID], ["solarSystemID", JITA]])]) }]]) };
      },
      async readSpaceSnapshot(bridgeSessionID, session) {
        return { space: scenes.get(bridgeSessionID) };
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
    miningSupportAnchorBoard: createMiningSupportAnchorBoard({ now }),
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
    scenes.set(`held-${pilot.characterID}`, scene(pilot.characterID));
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

test("a support anchor released: the page posts, and the fleet's board has that pilot's anchor no more, and the others' still", async () => {
  const { api, paths, bodies, answers, tab, errors, bots } = await fleet();
  // Two of the fleet publish what their own scenes say they offer, by the page's own asker.
  await api.publishMiningSupportAnchor(shipOf(7005), 400, bots[7005], { expectedCharacterID: 7005 });
  await api.publishMiningSupportAnchor(shipOf(7001), 400, bots[7001], { expectedCharacterID: 7001 });
  assert.deepEqual((await api.readMiningSupportAnchors(bots[7002])).anchors.map((anchor) => [anchor.characterID, anchor.freshness]), [[7001, "fresh"], [7005, "fresh"]]);
  paths.length = 0;
  bodies.length = 0;
  answers.length = 0;

  assert.equal(await api.releaseMiningSupportAnchor(bots[7005]), undefined);
  assert.deepEqual([paths[0], bodies[0], answers[0]], ["POST /api/bots/mining-support-anchors/release", {}, [200, { ok: true }]]);
  assert.deepEqual((await api.readMiningSupportAnchors(bots[7002])).anchors.map((anchor) => anchor.characterID), [7001]);
  // Released again, and by one that published none: answered, and nothing more is gone.
  assert.equal(await api.releaseMiningSupportAnchor(bots[7005]), undefined);
  assert.equal(await api.releaseMiningSupportAnchor(bots[7002]), undefined);
  assert.deepEqual((await api.readMiningSupportAnchors(bots[7002])).anchors.map((anchor) => anchor.characterID), [7001]);
  // It can publish again after.
  await api.publishMiningSupportAnchor(shipOf(7005), 400, bots[7005], { expectedCharacterID: 7005 });
  assert.deepEqual((await api.readMiningSupportAnchors(bots[7002])).anchors.map((anchor) => anchor.characterID), [7001, 7005]);
  // No pilot online: nobody's anchor to release.
  await assert.rejects(api.releaseMiningSupportAnchor(tab), refusedAs(409, "NO_LIVE_SESSION"));
  assert.deepEqual(errors, []);
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
