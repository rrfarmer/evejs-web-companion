"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/server");
const { dispatchInProcess } = require("../src/pilotSocket");

const ACCOUNT = { username: "training-owner", accountID: 4, role: "0", banned: false };
const CHARACTER_ID = 90000001;
const character = { characterID: CHARACTER_ID, name: "Test Pilot", corporationID: 98000001, corporationName: "Mining Corp" };

function fixture() {
  return createApp({
    webAuth: {
      createSessionToken: () => "test-token",
      verifySessionToken: token => token === "test-token"
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "test-session" } : null,
    },
    eveStore: {
      getAccount: async name => name === ACCOUNT.username ? ACCOUNT : null,
      createAccount: async () => assert.fail("Training login must use an existing account"),
      async listCharactersForAccount(id) {
        assert.equal(id, ACCOUNT.accountID);
        return [{ ...character, characterName: character.name }];
      },
    },
    eveGatewayClient: {},
  });
}

test("Training login reads an existing account and its roster without replacing the cockpit cookie", async () => {
  const app = fixture();
  const login = (path, username) => dispatchInProcess(app, { method: "POST", path, body: { username } });
  for (const name of ["", "unknown-account"]) {
    const denied = await login("/api/pilot-training/login", name);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["set-cookie"], undefined);
  }

  const auth = await login("/api/pilot-training/login", ACCOUNT.username);
  assert.equal(auth.status, 200);
  assert.equal(auth.headers["set-cookie"], undefined);
  const payload = JSON.parse(auth.body);
  assert.equal(payload.sessionToken, "test-token");
  assert.equal(payload.accountCreated, false);
  assert.equal(payload.account.username, ACCOUNT.username);
  const roster = await dispatchInProcess(app, { path: "/api/pilot-training/characters",
    headers: { authorization: "Bearer " + payload.sessionToken } });
  assert.equal(roster.status, 200);
  assert.deepEqual(JSON.parse(roster.body), { ok: true, account: ACCOUNT.username, characters: [character] });

  const cockpit = await login("/api/login", ACCOUNT.username);
  assert.equal(cockpit.status, 200);
  assert.ok(cockpit.headers["set-cookie"]);
});

test("retired Training pages and operations return 404 even with a valid account", async () => {
  const app = fixture();
  const headers = { authorization: "Bearer test-token" };
  for (const path of ["/pilot-training", "/pilot-training/", "/goblin-factory", "/goblin-factory/"]) {
    const response = await dispatchInProcess(app, { path, headers });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.location, undefined);
  }
  for (const path of ["qualification", "miner", "homes", "home"]) {
    const response = await dispatchInProcess(app, { path: "/api/pilot-training/" + path, headers });
    assert.equal(response.status, 404, path);
  }
  const actions = ["queue/review", "queue/apply", "skills/review", "skills/acquire",
    "onboarding/review", "onboarding/apply", "equipment/review", "equipment/apply", "equipment/recover"];
  for (const path of ["/api/goblin-factory/login", ...actions.map(action => "/api/pilot-training/" + action)]) {
    const response = await dispatchInProcess(app, { method: "POST", path, headers, body: { characterID: CHARACTER_ID } });
    assert.equal(response.status, 404, path);
  }
});

test("training authentication refuses expired/deleted/banned identities without cockpit cleanup", async () => {
  let released = 0;
  const held = { accountID: ACCOUNT.accountID, characterID: CHARACTER_ID, bridgeSessionID: "held-gameplay" };
  const sessions = new Map([["cockpit-session", held]]);
  const instance = createApp({
    bridgeSessionStore: sessions,
    webAuth: { verifySessionToken(token, options) {
      assert.equal(options?.allowExpired, undefined, "read-only auth never seeks cleanup authority");
      return token === "expired" ? null : { username: token, accountID: ACCOUNT.accountID, sessionID: "cockpit-session" };
    } },
    eveStore: { async getAccount(name) { return name === "deleted" ? null : { ...ACCOUNT, banned: true }; } },
    eveGatewayClient: { async releaseBridgeSession() { released++; } },
    errorLogger() {},
  });
  for (const route of ["characters", "settings-context", "ownership?characterID=" + CHARACTER_ID]) {
    for (const [token, code] of [["expired", 401], ["deleted", 401], ["banned", 403]]) {
      const result = await dispatchInProcess(instance, { path: "/api/pilot-training/" + route,
        headers: { authorization: "Bearer " + token } });
      assert.equal(result.status, code);
      assert.equal(result.headers["set-cookie"], undefined);
      assert.equal(sessions.get("cockpit-session"), held);
    }
  }
  assert.equal(released, 0);
});
