"use strict";

// A module type's overload effect, as static reference data: staticData.getOverloadEffectID and
// GET /api/types/overload-effects.
//
// WHY IT EXISTS: the retail client's module button overloads a module by naming the ID of the module's own
// effect of the overload category (shipmodulebutton.py 231: the first of moduleinfo.effects whose effectCategory
// is dgmEffOverload, 5), and sends godma's Overload(itemID, effectID) with it. Tranquility has one recorded:
// Overload(moduleID, 3001). The page knows a module's type and nothing of its effects, so it asks here, as it
// asks a type's cycle time (/api/types/cycle-times). No gateway call, no live session.
//
// The helper is read against a FIXTURE shaped as the gameStore's typeDogma is (typesByTypeID with each type's
// effect IDs, effectTypesByID with each effect's category), so the test does not want an EveJS checkout. The
// route is read against an injected staticData.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-overloadfx-"));
fs.mkdirSync(path.join(dataDir, "typeDogma"));
fs.writeFileSync(
  path.join(dataDir, "typeDogma", "data.json"),
  JSON.stringify({
    typesByTypeID: {
      // A turret: fitted, online, aimed, and one effect of the overload category.
      3634: { typeID: 3634, effects: [12, 16, 34, 3001] },
      // A strip miner: nothing of the overload category.
      17482: { typeID: 17482, effects: [12, 16, 67] },
      // A made-up type with two: the first as the type lists them is the one.
      7001: { typeID: 7001, effects: [16, 3025, 3001] },
      // One of its effects is not in the table of effects at all.
      7002: { typeID: 7002, effects: [16, 99999, 3175] },
      // No effects listed.
      999: { typeID: 999 },
    },
    effectTypesByID: {
      12: { effectID: 12, name: "hiPower", effectCategoryID: 0 },
      16: { effectID: 16, name: "online", effectCategoryID: 4 },
      34: { effectID: 34, name: "projectileFired", effectCategoryID: 2 },
      67: { effectID: 67, name: "miningLaser", effectCategoryID: 2 },
      3001: { effectID: 3001, name: "overloadRofBonus", effectCategoryID: 5 },
      3025: { effectID: 3025, name: "overloadSelfDamageBonus", effectCategoryID: 5 },
      3175: { effectID: 3175, name: "overloadSelfSpeedBonus", effectCategoryID: 5 },
    },
  }),
);
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
// Point the SDE dir somewhere empty so nothing else resolves accidentally.
process.env.EVEJS_SDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-nosde-"));

const staticData = require("../src/staticData");
const { createApp } = require("../src/server");

test("a type's overload effect is its effect of the overload category", () => {
  assert.equal(staticData.getOverloadEffectID(3634), 3001);
  assert.equal(staticData.getOverloadEffectID("3634"), 3001);
  // With an effect the table does not know beside it.
  assert.equal(staticData.getOverloadEffectID(7002), 3175);
});

test("of two it is the first as the type lists them", () => {
  assert.equal(staticData.getOverloadEffectID(7001), 3025);
});

test("a type with no such effect, with no effects, or not known at all has none", () => {
  assert.equal(staticData.getOverloadEffectID(17482), null);
  assert.equal(staticData.getOverloadEffectID(999), null);
  assert.equal(staticData.getOverloadEffectID(0), null);
  assert.equal(staticData.getOverloadEffectID(123456789), null);
  assert.equal(staticData.getOverloadEffectID("a web"), null);
});

// --- the route, against an injected staticData --------------------------------

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();
const FIXTURE_EFFECTS = { 7001: 3025, 3634: 3001 };

async function startTestServer(asked = []) {
  const app = createApp({
    eveStore: { async getAccount(username) { return username === ACCOUNT.username ? { ...ACCOUNT } : null; } },
    eveGatewayClient: {},
    webAuth: {
      createSessionToken() { return COOKIE_TOKEN; },
      verifySessionToken(token) { return token === COOKIE_TOKEN ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID } : null; },
      countConfiguredUsers() { return 1; },
    },
    staticData: { getOverloadEffectID(typeID) { asked.push(typeID); return FIXTURE_EFFECTS[typeID] ?? null; } },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, asked };
}

async function getEffects(baseUrl, query, options = {}) {
  const headers = options.authenticated === false ? {} : { cookie: `evejs_web_poc=${COOKIE_TOKEN}` };
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/types/overload-effects${query}`, { headers });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); }));
  }
  await Promise.all(closing);
});

test("GET /api/types/overload-effects answers each type asked of once: its effect's ID, or null where it has none", async () => {
  const { baseUrl, asked } = await startTestServer();
  const { response, payload } = await getEffects(baseUrl, "?typeIDs=7001,17482,7001,%203634%20,,0,-4,junk,1.5");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, source: "static-data", overloadEffectID: { 7001: 3025, 17482: null, 3634: 3001 }, capped: false, limit: 500 });
  // A type is looked up once however often it is named, and what is no type's ID is not looked up at all.
  assert.deepEqual(asked, [7001, 17482, 3634]);
});

test("GET /api/types/overload-effects with nothing asked answers nothing", async () => {
  const { baseUrl } = await startTestServer();
  for (const query of ["", "?typeIDs=", "?other=1"]) {
    const { response, payload } = await getEffects(baseUrl, query);
    assert.deepEqual([response.status, payload.overloadEffectID, payload.capped], [200, {}, false], query);
  }
});

test("GET /api/types/overload-effects answers no more types than its limit, and says it stopped", async () => {
  const { baseUrl, asked } = await startTestServer();
  const many = Array.from({ length: 503 }, (_, at) => 20000 + at);
  const { response, payload } = await getEffects(baseUrl, `?typeIDs=${many.join(",")}`);
  assert.equal(response.status, 200);
  assert.deepEqual([Object.keys(payload.overloadEffectID).length, payload.capped, payload.limit, asked.length], [500, true, 500, 500]);
  assert.equal(Object.hasOwn(payload.overloadEffectID, "20500"), false);
  // As many as the limit is all of them: nothing was left out, and it does not say so.
  const all = await getEffects(baseUrl, `?typeIDs=${many.slice(0, 500).join(",")}`);
  assert.deepEqual([Object.keys(all.payload.overloadEffectID).length, all.payload.capped], [500, false]);
});

test("GET /api/types/overload-effects requires the web login session", async () => {
  const { baseUrl, asked } = await startTestServer();
  const { response, payload } = await getEffects(baseUrl, "?typeIDs=7001", { authenticated: false });
  assert.deepEqual([response.status, payload.error, asked], [401, "AUTH_REQUIRED", []]);
});
