"use strict";

// The page's plain reads that no test of the BFF's asked, by the game-port audit's own list of 2026-10-11:
//
//   GET /api/types/cycle-times                     GET /api/characters/find
//   GET /api/market/groups                         GET /api/dockable-structures/pilots
//   GET /api/market/group-types                    GET /api/health
//   GET /api/mining/compression-compatibility
//
// None makes a call of the server's for a pilot: each answers from the static data, or from the account's own
// store. What can go wrong between the page and the BFF is the wire itself, the name of a query or of an
// answer, and neither side's own tests would see it: the page's tests answer themselves, and the BFF had none.
// So each is asked here BY THE PAGE'S OWN ASKER (web/src/app/api.ts) of the BFF's own route, with the static
// data and the store stood in for: what the page sends and reads, and what the route takes and answers, in one
// test.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const TOKEN = "raw-signed-login-token";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const ATTRIBUTE_DURATION = 73;
const activeServers = new Set();

/** The BFF on a server, the page's own askers, and what the static data, the store and the BFF were asked. */
async function page(overrides = {}) {
  const asked = [];
  const staticData = {
    // A module that cycles, one whose duration is nought, one whose duration is no number, and (any other) one
    // the tables have no duration for.
    getTypeDogmaAttribute(typeID, attributeID, fallback) {
      asked.push(["attribute", typeID, attributeID]);
      return { 438: 5000, 7001: 0, 7002: "long" }[typeID] ?? fallback;
    },
    getMarketGroupChildren(parent) {
      asked.push(["children", parent]);
      if (parent === 0) return [{ marketGroupID: 4, name: "Ships", hasTypes: false }, { marketGroupID: 9, name: "Ship Equipment", hasTypes: true }];
      return parent === 4 ? [{ marketGroupID: 5, name: "Frigates", hasTypes: true }] : [];
    },
    getMarketGroupTypes(group) {
      asked.push(["types", group]);
      return group === 5
        ? { types: [{ typeID: 588, name: "Reaper", groupName: "Corvette" }, { typeID: 603, name: "Merlin", groupName: "Frigate" }], total: 7, capped: true }
        : { types: [], total: 0, capped: false };
    },
    getMiningCompressionCompatibility(typeIDs, typeListIDs) {
      asked.push(["compression", typeIDs, typeListIDs]);
      return typeIDs.map((typeID) => (typeID === 1230
        ? { typeID, compressedTypeID: 62516, matchingTypeListIDs: [typeListIDs[0]], availability: "available" }
        : { typeID, compressedTypeID: null, matchingTypeListIDs: null, availability: "unknown" }));
    },
    findCharacters(query) {
      asked.push(["characters", query]);
      return { q: query.q, total: 2, capped: false, limit: 20, matches: [{ characterID: 90000002, name: "Abel" }, { characterID: 90000003, name: "Abigail" }] };
    },
    ...(overrides.staticData || {}),
  };
  const app = createApp({
    eveStore: {
      async getAccount(username) { return username === ACCOUNT.username ? { ...ACCOUNT } : null; },
      async listCharactersForAccount(accountID) {
        asked.push(["pilots of", accountID]);
        return [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }, { characterID: 8, accountID: 4, characterName: "Test Two" },
          { characterID: 99, accountID: 5, characterName: "Another's" }];
      },
      async getStatus() {
        asked.push(["status"]);
        if (overrides.status instanceof Error) throw overrides.status;
        return overrides.status;
      },
    },
    eveGatewayClient: {},
    webAuth: {
      createSessionToken() { return TOKEN; },
      verifySessionToken(token) { return token === TOKEN ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "signed-session" } : null; },
      countConfiguredUsers() { return 1; },
    },
    staticData,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const api = await import("../web/src/app/api.ts");
  const paths = [];
  // The page's own request, as it makes one with a session's token: what it asked is kept, and it is sent on.
  const options = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: TOKEN,
    fetch: (input, init) => { paths.push(`${(init && init.method) || "GET"} ${String(input).replace(/^https?:\/\/[^/]+/, "")}`); return fetch(input, init); },
  };
  return { api, options, asked, paths };
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

test("a module type's base cycle time: the page asks by typeIDs, and reads baseCycleMs, a time or null and never nought", async () => {
  const { api, options, asked, paths } = await page();
  const answered = await api.loadBaseCycleTimes([438, 7001, 438, 7002, 999], options);
  assert.deepEqual(answered, { baseCycleMs: { 438: 5000, 7001: null, 7002: null, 999: null } });
  assert.deepEqual(paths, ["GET /api/types/cycle-times?typeIDs=438%2C7001%2C438%2C7002%2C999"]);
  // The route looks a type's duration up once, however often the page named it.
  assert.deepEqual(asked, [["attribute", 438, ATTRIBUTE_DURATION], ["attribute", 7001, ATTRIBUTE_DURATION], ["attribute", 7002, ATTRIBUTE_DURATION], ["attribute", 999, ATTRIBUTE_DURATION]]);
});

test("the market's tree: the page asks a group's children by parent, the roots at nought, and reads groups", async () => {
  const { api, options, asked, paths } = await page();
  // (a group's icon file is null where the BFF sends none, as this stub's groups have none)
  assert.deepEqual(await api.loadMarketGroups(0, options), [{ marketGroupID: 4, name: "Ships", hasTypes: false, iconFile: null }, { marketGroupID: 9, name: "Ship Equipment", hasTypes: true, iconFile: null }]);
  assert.deepEqual(await api.loadMarketGroups(4, options), [{ marketGroupID: 5, name: "Frigates", hasTypes: true, iconFile: null }]);
  assert.deepEqual(await api.loadMarketGroups(5, options), []);
  assert.deepEqual(paths, ["GET /api/market/groups?parent=0", "GET /api/market/groups?parent=4", "GET /api/market/groups?parent=5"]);
  assert.deepEqual(asked, [["children", 0], ["children", 4], ["children", 5]]);
});

test("a market group's items: the page asks by group, and reads types, how many there are in all, and whether some were left out", async () => {
  const { api, options, asked, paths } = await page();
  assert.deepEqual(await api.loadMarketGroupTypes(5, options), {
    types: [{ typeID: 588, name: "Reaper", groupName: "Corvette" }, { typeID: 603, name: "Merlin", groupName: "Frigate" }], total: 7, capped: true });
  assert.deepEqual(await api.loadMarketGroupTypes(4, options), { types: [], total: 0, capped: false });
  assert.deepEqual(paths, ["GET /api/market/group-types?group=5", "GET /api/market/group-types?group=4"]);
  assert.deepEqual(asked, [["types", 5], ["types", 4]]);
});

test("what an ore compresses to: the page asks by typeIDs and typeListIDs, and reads compatibility, a row for each type", async () => {
  const { api, options, asked, paths } = await page();
  assert.deepEqual(await api.getMiningCompressionCompatibility([1230, 1228], [320, 321], options), [
    { typeID: 1230, compressedTypeID: 62516, matchingTypeListIDs: [320], availability: "available" },
    { typeID: 1228, compressedTypeID: null, matchingTypeListIDs: null, availability: "unknown" },
  ]);
  assert.deepEqual(paths, ["GET /api/mining/compression-compatibility?typeIDs=1230,1228&typeListIDs=320,321"]);
  assert.deepEqual(asked, [["compression", [1230, 1228], [320, 321]]]);
  // What the page would not ask, it does not: nothing of a type, and more than the route takes.
  assert.equal(await api.getMiningCompressionCompatibility([], [320], options), null);
  assert.equal(await api.getMiningCompressionCompatibility(Array.from({ length: 33 }, (_unused, at) => at + 1), [320], options), null);
  assert.equal(paths.length, 1);
});

test("a tables' answer for compression that is none: the page reads no compatibility, and a route with no such tables answers so", async () => {
  const none = await page({ staticData: { getMiningCompressionCompatibility: undefined } });
  assert.equal(await none.api.getMiningCompressionCompatibility([1230], [320], none.options), null);
  assert.deepEqual(none.paths, ["GET /api/mining/compression-compatibility?typeIDs=1230&typeListIDs=320"]);
});

test("someone to write to: the page asks by q, its ends trimmed, and reads matches; under two letters it asks nothing", async () => {
  const { api, options, asked, paths } = await page();
  assert.deepEqual(await api.findCharacters("  ab ", options), [{ characterID: 90000002, name: "Abel" }, { characterID: 90000003, name: "Abigail" }]);
  assert.deepEqual(await api.findCharacters("a", options), []);
  assert.deepEqual(paths, ["GET /api/characters/find?q=ab"]);
  // With no pilot chosen, nobody is left out of the search; the page names no limit.
  assert.deepEqual(asked, [["characters", { q: "ab", limit: undefined, excludeCharacterID: 0 }]]);
});

test("the account's pilots, for a structure's access list: the page reads pilots, the account's own and no other's", async () => {
  const { api, options, asked, paths } = await page();
  assert.deepEqual(await api.listDockableAccessPilots(options), [{ characterID: 7, characterName: "Test Pilot" }, { characterID: 8, characterName: "Test Two" }]);
  assert.deepEqual(paths, ["GET /api/dockable-structures/pilots"]);
  assert.deepEqual(asked, [["pilots of", ACCOUNT.accountID]]);
});

test("the page's first question: ready where the gateway's runtime is, or the gateway says it is, and not otherwise", async () => {
  for (const [status, ready] of [
    // The usual: the runtime ready, and the gateway's own word no (its optional token is not set).
    [{ ok: true, ready: false, runtime: { ready: true } }, true],
    [{ ok: true, ready: true, runtime: { ready: false } }, true],
    [{ ok: true, ready: false, runtime: { ready: false } }, false],
    [{ ok: true }, false],
    // The gateway cannot be reached: the route answers that it failed, and the page reads not ready.
    [new Error("connect ECONNREFUSED"), false],
  ]) {
    const { api, options, asked, paths } = await page({ status });
    // (Asked before any login: the page has no token yet, and the route wants none.)
    assert.deepEqual(await api.getHealth({ ...options, token: null }), { ready }, JSON.stringify(status instanceof Error ? status.message : status));
    assert.deepEqual([paths, asked], [["GET /api/health"], [["status"]]]);
  }
});

test("each of these but the first question wants a login: without one the page's asker fails, and nothing is looked up", async () => {
  const { api, options, asked } = await page();
  const anonymous = { ...options, token: null };
  for (const ask of [
    () => api.loadBaseCycleTimes([438], anonymous), () => api.loadMarketGroups(0, anonymous), () => api.loadMarketGroupTypes(5, anonymous),
    () => api.getMiningCompressionCompatibility([1230], [320], anonymous), () => api.findCharacters("ab", anonymous), () => api.listDockableAccessPilots(anonymous),
  ]) {
    await assert.rejects(ask(), (error) => error.status === 401);
  }
  assert.deepEqual(asked, []);
});
