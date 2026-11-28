"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/server");

const FLEET = "9007199254740993123";
const OTHER = "654500019999";
const keyVal = entries => ({ type: "object", args: { type: "dict", entries } });

const servers = new Set();
test.afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

async function fixture() {
  const sessions = new Map([1, 2, 3].map(n => [String(n), { accountID: n, characterID: 90000000 + n,
    bridgeSessionID: `bridge:${n}`, activeShipID: 1000 + n, fleetID: OTHER,
    actualFleet: n === 3 ? OTHER : FLEET, boundHandles: new Map(), transition: null, streamSubscribers: new Set() }]));
  let rosterOverride = null;
  let fleetFailure = null;
  const gateway = {
    async bindObject(service, method, args, kwargs, fields, sessionID) {
      assert.equal(service, "fleetObjectHandler");
      assert.equal(method, "MachoBindObject");
      assert.deepEqual(args, [], "only session-owned fleet binding");
      return { boundHandle: sessionID };
    },
    async callBoundMethod(service, method, args, kwargs, fields, sessionID) {
      assert.equal(method, "GetInitState");
      assert.deepEqual(args, []);
      if (fleetFailure) throw Object.assign(new Error(fleetFailure), { code: fleetFailure });
      const held = [...sessions.values()].find(row => row.bridgeSessionID === sessionID);
      const members = rosterOverride ?? [...sessions.values()].filter(row => row.actualFleet === held.actualFleet);
      return { result: keyVal([["fleetID", held.actualFleet === null ? null : { type: "long", value: held.actualFleet }],
        ["members", { type: "dict", entries: members.map(row => [row.characterID, keyVal([["charID", row.characterID], ["solarSystemID", row.actualSolarSystemID ?? 30000142]])]) }]]) };
    },
  };
  const app = createApp({ eveStore: { async getAccount(username) { return { username, accountID: Number(username), role: "0", banned: false }; } },
    webAuth: { verifySessionToken(token) { return ["1", "2", "3"].includes(token) ? { username: token, accountID: Number(token), sessionID: token } : null; }, countConfiguredUsers() { return 3; } },
    eveGatewayClient: gateway, bridgeSessionStore: sessions, staticData: {}, errorLogger() {} });
  const server = app.listen(0, "127.0.0.1");
  servers.add(server);
  await once(server, "listening");
  async function request(pilot = 1) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/mining-support-anchors`, {
      headers: { cookie: `evejs_web_poc=${pilot}` },
    });
    return { status: response.status, ...(await response.json()) };
  }
  return { sessions, request,
    setRoster(value) { rosterOverride = value; }, setFleetFailure(value) { fleetFailure = value; } };
}

test("the support roster is bound to this pilot's session and the fleet ID from EveJS", async () => {
  const f = await fixture();
  const read = await f.request(2);
  assert.equal(read.status, 200);
  assert.equal(read.fleet.fleetID, FLEET);
  assert.equal(read.fleet.readerCharacterID, 90000002);
  assert.deepEqual(read.fleet.members.map(row => row.characterID), [90000001, 90000002]);
  assert.equal(read.fleet.expiresAtMs - read.fleet.observedAtMs, 10_000);
  assert.deepEqual((await f.request(3)).fleet.members.map(row => row.characterID), [90000003]);
  assert.equal((await f.request(9)).status, 401);
  f.sessions.delete("2");
  assert.equal((await f.request(2)).error, "NO_LIVE_SESSION");
});

test("an absent member or failed fleet read cannot confirm support membership", async () => {
  const f = await fixture();
  f.setRoster([]);
  assert.equal((await f.request()).availability, "unknown");
  assert.equal(f.sessions.get("1").fleetID, null);
  f.setFleetFailure("READ_FAILED");
  const read = await f.request();
  assert.equal(read.availability, "unknown");
  assert.equal(read.reason, "READ_FAILED");
  assert.equal(read.fleet, null);
});
