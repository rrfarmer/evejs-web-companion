"use strict";

// Whether a module type can be switched on at all, as static reference data: staticData.getTypeActivatable and
// GET /api/types/activation.
//
// WHY IT EXISTS: the eve.js server activates a module by its type's first activatable effect
// (moduleActivationEffectRecord.js, resolveDefaultActivationEffect / isActivatableEffectRecord) and refuses a type
// with none: NO_ACTIVATABLE_EFFECT, "<module> cannot be activated." Seen live 2026-10-14: companions picked a
// Drone Navigation Computer by its group name and asked once a fight; its type has medPower, online and a
// category-4 bonus effect, and nothing a pilot switches on. The page asks here instead of asking the server.
//
// The helper is read against a FIXTURE shaped as the gameStore's typeDogma is, so the test does not want an EveJS
// checkout. The route is read against an injected staticData. Type IDs are made up; effect IDs and names are the
// static data's own.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-activation-"));
fs.mkdirSync(path.join(dataDir, "typeDogma"));
fs.writeFileSync(
  path.join(dataDir, "typeDogma", "data.json"),
  JSON.stringify({
    typesByTypeID: {
      // A drone tracking link: an activation effect with a duration.
      7001: { typeID: 7001, effects: [13, 16, 6557, 6558] },
      // A drone navigation computer as this server has it: online is filed under activation, and is no
      // activation; the bonus is category 4.
      7002: { typeID: 7002, effects: [13, 16, 6555] },
      // A turret: its effect is aimed at a target (category 2).
      7003: { typeID: 7003, effects: [12, 16, 34] },
      // A warp core stabilizer's active form: category 4, but a duration AND a discharge.
      7004: { typeID: 7004, effects: [16, 8121] },
      // Only an effect the table does not know.
      7005: { typeID: 7005, effects: [99999] },
      // No effects listed.
      7006: { typeID: 7006 },
      // A duration and no discharge, category 4: passive.
      7007: { typeID: 7007, effects: [16, 8122] },
    },
    effectTypesByID: {
      12: { effectID: 12, name: "hiPower", effectCategoryID: 0 },
      13: { effectID: 13, name: "medPower", effectCategoryID: 0 },
      16: { effectID: 16, name: "online", effectCategoryID: 1 },
      34: { effectID: 34, name: "projectileFired", effectCategoryID: 2, durationAttributeID: 51 },
      6555: { effectID: 6555, name: "moduleBonusDroneNavigationComputer", effectCategoryID: 4 },
      6557: { effectID: 6557, name: "moduleBonusOmnidirectionalTrackingLink", effectCategoryID: 1, durationAttributeID: 73, dischargeAttributeID: 6 },
      6558: { effectID: 6558, name: "moduleBonusOmnidirectionalTrackingLinkOverload", effectCategoryID: 5 },
      8121: { effectID: 8121, name: "warpCoreStabilizerActive", effectCategoryID: 4, durationAttributeID: 73, dischargeAttributeID: 6 },
      8122: { effectID: 8122, name: "madeUpTimedBonus", effectCategoryID: 4, durationAttributeID: 73 },
    },
  }),
);
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
// Point the SDE dir somewhere empty so nothing else resolves accidentally.
process.env.EVEJS_SDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-nosde-"));

const staticData = require("../src/staticData");
const { createApp } = require("../src/server");

test("a type with an effect of the activation or target category can be switched on", () => {
  assert.equal(staticData.getTypeActivatable(7001), true);
  assert.equal(staticData.getTypeActivatable("7001"), true);
  assert.equal(staticData.getTypeActivatable(7003), true);
});

test("online is never the activation, though the table files it under activation", () => {
  // The live sighting: medPower, online, and a category-4 bonus is a passive module.
  assert.equal(staticData.getTypeActivatable(7002), false);
});

test("an effect with both a duration and a discharge is switched on whatever its category", () => {
  assert.equal(staticData.getTypeActivatable(7004), true);
  assert.equal(staticData.getTypeActivatable(7007), false, "a duration alone is not enough");
});

test("a type with no effect the server would take is passive; a type with no dogma is not known", () => {
  assert.equal(staticData.getTypeActivatable(7005), false);
  assert.equal(staticData.getTypeActivatable(7006), false);
  assert.equal(staticData.getTypeActivatable(123456789), null);
  assert.equal(staticData.getTypeActivatable(0), null);
  assert.equal(staticData.getTypeActivatable("a web"), null);
});

// --- the route, against an injected staticData --------------------------------

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();
const FIXTURE_ACTIVATABLE = { 7001: true, 7002: false };

async function startTestServer(asked = []) {
  const app = createApp({
    eveStore: { async getAccount(username) { return username === ACCOUNT.username ? { ...ACCOUNT } : null; } },
    eveGatewayClient: {},
    webAuth: {
      createSessionToken() { return COOKIE_TOKEN; },
      verifySessionToken(token) { return token === COOKIE_TOKEN ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID } : null; },
      countConfiguredUsers() { return 1; },
    },
    staticData: { getTypeActivatable(typeID) { asked.push(typeID); return FIXTURE_ACTIVATABLE[typeID] ?? null; } },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, asked };
}

async function getActivation(baseUrl, query, options = {}) {
  const headers = options.authenticated === false ? {} : { cookie: `evejs_web_poc=${COOKIE_TOKEN}` };
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/types/activation${query}`, { headers });
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

test("GET /api/types/activation answers each type asked of once: true, false, or null where it is not known", async () => {
  const { baseUrl, asked } = await startTestServer();
  const { response, payload } = await getActivation(baseUrl, "?typeIDs=7001,7002,7001,%207003%20,,0,-4,junk,1.5");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, source: "static-data", activatable: { 7001: true, 7002: false, 7003: null }, capped: false, limit: 500 });
  assert.deepEqual(asked, [7001, 7002, 7003]);
});

test("GET /api/types/activation answers no more types than its limit, and says it stopped", async () => {
  const { baseUrl, asked } = await startTestServer();
  const many = Array.from({ length: 503 }, (_, at) => 20000 + at);
  const { response, payload } = await getActivation(baseUrl, `?typeIDs=${many.join(",")}`);
  assert.equal(response.status, 200);
  assert.deepEqual([Object.keys(payload.activatable).length, payload.capped, payload.limit, asked.length], [500, true, 500, 500]);
});

test("GET /api/types/activation requires the web login session", async () => {
  const { baseUrl, asked } = await startTestServer();
  const { response, payload } = await getActivation(baseUrl, "?typeIDs=7001", { authenticated: false });
  assert.deepEqual([response.status, payload.error, asked], [401, "AUTH_REQUIRED", []]);
});
