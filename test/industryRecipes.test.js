"use strict";

// R109 slice 1, BFF half: the industry recipe book seen from the product side.
// Same two-layer shape as test/piSchematics.test.js:
//   1. The pure index against hand-written rows (deterministic) and against the
//      REAL `industryBlueprints` table (skipped when the data is not on this
//      machine). The real-table cases are where the reaction trap is proved:
//      the file's own reverse index misses every reaction, this one must not.
//   2. The two routes against an injected fake staticData: auth, wire shape,
//      no gateway call, input caps.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

const { createApp } = require("../src/server");
const staticData = require("../src/staticData");
const config = require("../src/config");
const {
  buildIndustryRecipeIndex,
  recipeClosure,
  searchIndustryBlueprints,
} = require("../src/industryRecipes");

const BLUEPRINTS_FILE = path.join(config.gamestoreDataDir, "industryBlueprints", "data.json");
const HAS_REAL_DATA = fs.existsSync(BLUEPRINTS_FILE);
const SKIP_REAL = HAS_REAL_DATA ? false : "gameStore industryBlueprints data.json not present";

// --- hand-written rows ------------------------------------------------------

const ROWS = [
  {
    blueprintTypeID: 1001,
    blueprintName: "Widget Blueprint",
    productTypeID: 101,
    maxProductionLimit: 300,
    activities: {
      manufacturing: {
        materials: [{ typeID: 201, quantity: 10 }, { typeID: 102, quantity: 2 }],
        products: [{ typeID: 101, quantity: 1 }],
        time: 600,
      },
      invention: {
        materials: [{ typeID: 301, quantity: 2 }],
        products: [{ typeID: 1003, quantity: 10, probability: 0.34 }],
        skills: [{ typeID: 401, level: 1 }, { typeID: 402, level: 1 }, { typeID: 403, level: 1 }],
        time: 7800,
      },
    },
  },
  {
    blueprintTypeID: 1002,
    blueprintName: "Gizmo Reaction Formula",
    productTypeID: 0,
    activities: {
      reaction: {
        materials: [{ typeID: 202, quantity: 100 }],
        products: [{ typeID: 102, quantity: 200 }],
        time: 10800,
      },
    },
  },
  {
    blueprintTypeID: 1003,
    blueprintName: "Widget II Blueprint",
    productTypeID: 103,
    activities: {
      manufacturing: {
        materials: [{ typeID: 101, quantity: 1 }, { typeID: 203, quantity: 5 }],
        products: [{ typeID: 103, quantity: 1 }],
        // A science skill shortens the job (dogma 1982); Industry does not.
        skills: [{ typeID: 3380, level: 5 }, { typeID: 401, level: 1 }],
        time: 900,
      },
    },
  },
  {
    blueprintTypeID: 1004,
    blueprintName: "Test Widget Blueprint",
    published: false,
    activities: {
      manufacturing: {
        materials: [{ typeID: 201, quantity: 1 }],
        products: [{ typeID: 104, quantity: 1 }],
        time: 1,
      },
    },
  },
];

test("a reaction product is indexed from the ACTIVITY, not the row's top-level productTypeID", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  const gizmo = index.byProduct.get(102);
  assert.ok(gizmo, "the formula's product is found although its row says productTypeID 0");
  assert.equal(gizmo.activity, "reaction");
  assert.equal(gizmo.blueprintTypeID, 1002);
  assert.equal(gizmo.quantityPerRun, 200);
  assert.equal(gizmo.timeSeconds, 10800);
  assert.equal(index.byProduct.has(0), false);
});

test("an unpublished row makes nothing", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  assert.equal(index.byProduct.has(104), false);
  assert.equal(index.searchable.some((entry) => entry.blueprintTypeID === 1004), false);
});

test("invention is indexed by the blueprint it produces, with runs per copy and chance", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  assert.deepEqual(index.inventedFrom.get(1003), [{
    blueprintTypeID: 1001,
    blueprintName: "Widget Blueprint",
    runsPerCopy: 10,
    probability: 0.34,
    timeSeconds: 7800,
    materials: [{ typeID: 301, quantity: 2 }],
    skills: [{ typeID: 401, level: 1 }, { typeID: 402, level: 1 }, { typeID: 403, level: 1 }],
  }]);
});

test("two recipes for one product: the lowest blueprint id wins, whatever the row order", () => {
  const twin = {
    blueprintTypeID: 999,
    blueprintName: "Other Widget Blueprint",
    activities: {
      manufacturing: {
        materials: [{ typeID: 201, quantity: 1 }],
        products: [{ typeID: 101, quantity: 1 }],
        time: 1,
      },
    },
  };
  assert.equal(buildIndustryRecipeIndex([...ROWS, twin]).byProduct.get(101).blueprintTypeID, 999);
  assert.equal(buildIndustryRecipeIndex([twin, ...ROWS]).byProduct.get(101).blueprintTypeID, 999);
});

test("the closure walks materials down through reactions and stops at raw materials", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  const closure = recipeClosure(index, [103]);
  assert.deepEqual(closure.recipes.map((recipe) => recipe.productTypeID), [103, 101, 102]);
  assert.deepEqual(closure.missing, []);
  assert.equal(closure.capped, false);
  // The T2 recipe carries how its blueprint is invented; the T1 one does not.
  assert.equal(closure.recipes[0].inventedFrom.length, 1);
  assert.deepEqual(closure.recipes[1].inventedFrom, []);
  for (const typeID of [103, 101, 102, 201, 202, 203, 1003, 1001, 301]) {
    assert.ok(closure.typeIDs.includes(typeID), `type ${typeID} is named by the answer`);
  }
});

test("the closure names an asked product nothing makes, and bounds itself", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  assert.deepEqual(recipeClosure(index, [201, 103]).missing, [201]);
  const tight = recipeClosure(index, [103], { maxRecipes: 2 });
  assert.equal(tight.recipes.length, 2);
  assert.equal(tight.capped, true);
});

test("search ranks a name that starts with the words first, and needs two letters", () => {
  const index = buildIndustryRecipeIndex(ROWS);
  const result = searchIndustryBlueprints(index, "widget", 10);
  assert.deepEqual(result.matches.map((match) => match.blueprintName), [
    "Widget Blueprint",
    "Widget II Blueprint",
  ]);
  assert.equal(searchIndustryBlueprints(index, "w", 10).matches.length, 0);

  // A word that starts with the query outranks a shorter name that only
  // contains it mid-word.
  const named = (blueprintTypeID, blueprintName, productTypeID) => ({
    blueprintTypeID,
    blueprintName,
    activities: {
      manufacturing: {
        materials: [{ typeID: 201, quantity: 1 }],
        products: [{ typeID: productTypeID, quantity: 1 }],
        time: 1,
      },
    },
  });
  const ranked = buildIndustryRecipeIndex([
    ...ROWS,
    named(2001, "Superwidget Blueprint", 501),
    named(2002, "Large Widget Blueprint", 502),
  ]);
  assert.deepEqual(searchIndustryBlueprints(ranked, "widget", 10).matches.map((match) => match.blueprintName), [
    "Widget Blueprint",
    "Widget II Blueprint",
    "Large Widget Blueprint",
    "Superwidget Blueprint",
  ]);
  assert.equal(searchIndustryBlueprints(index, "formula", 10).matches[0].activity, "reaction");
});

// --- the real table ---------------------------------------------------------

test("real table: every published reaction product is indexed, though the file's own index has none", { skip: SKIP_REAL }, () => {
  const raw = JSON.parse(fs.readFileSync(BLUEPRINTS_FILE, "utf8"));
  const index = buildIndustryRecipeIndex(staticData.getAllIndustryBlueprints());
  let reactions = 0;
  let inFileIndex = 0;
  for (const row of raw.blueprintDefinitions) {
    if (row.published === false || !row.activities.reaction) {
      continue;
    }
    for (const product of row.activities.reaction.products || []) {
      reactions += 1;
      assert.equal(index.byProduct.get(product.typeID).activity, "reaction", row.blueprintName);
      if (raw.blueprintTypeIDsByProductTypeID[product.typeID]) {
        inFileIndex += 1;
      }
    }
  }
  assert.ok(reactions > 100, "the real table carries over a hundred formulas");
  // The trap this module exists to step around. If upstream ever fixes the
  // file, this fails and the comment at the top of industryRecipes.js is stale.
  assert.equal(inFileIndex, 0);
});

test("real table: no unpublished blueprint makes anything in the index", { skip: SKIP_REAL }, () => {
  const rows = staticData.getAllIndustryBlueprints();
  const unpublished = new Set(rows.filter((row) => row.published === false).map((row) => row.blueprintTypeID));
  assert.ok(unpublished.size > 0);
  for (const recipe of buildIndustryRecipeIndex(rows).byProduct.values()) {
    assert.equal(unpublished.has(recipe.blueprintTypeID), false, recipe.blueprintName);
  }
});

test("real table: a T2 drone's closure reaches its T1 hull, a component and a reaction, and says how it is invented", { skip: SKIP_REAL }, () => {
  const index = buildIndustryRecipeIndex(staticData.getAllIndustryBlueprints());
  const t2 = [...index.byProduct.values()].find((recipe) => recipe.blueprintName === "Hobgoblin II Blueprint");
  assert.ok(t2);
  const closure = recipeClosure(index, [t2.productTypeID]);
  const names = new Map(closure.recipes.map((recipe) => [recipe.blueprintName, recipe]));
  assert.ok(names.has("Hobgoblin I Blueprint"), "the T1 hull is built");
  assert.ok(names.has("Particle Accelerator Unit Blueprint"), "the component is built");
  assert.equal(names.get("Crystalline Carbonide Reaction Formula").activity, "reaction");
  const invention = closure.recipes[0].inventedFrom;
  assert.equal(invention.length, 1);
  assert.equal(invention[0].blueprintName, "Hobgoblin I Blueprint");
  assert.equal(invention[0].runsPerCopy, 10);
  assert.equal(closure.capped, false);
});

// --- the routes -------------------------------------------------------------

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
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
  };
}

const TYPES = {
  101: { name: "Widget", groupID: 11, groupName: "Widgets", categoryID: 7, volume: 5 },
  102: { name: "Gizmo", groupID: 12, groupName: "Composite", categoryID: 4, volume: 1 },
  103: { name: "Widget II", groupID: 11, groupName: "Widgets", categoryID: 7, volume: 5 },
  201: { name: "Tritanium", groupID: 18, groupName: "Mineral", categoryID: 4, volume: 0.01 },
};

function fakeStaticData() {
  return {
    getClientTypeList(listID) {
      return Number(listID) === 799 ? { listID: 799, includedTypeIDs: [403] } : null;
    },
    getTypesInGroup(groupID) {
      return Number(groupID) === 1304
        ? [{ typeID: 34201, name: "Parity Decryptor", groupID: 1304 }, { typeID: 34202, name: "Accelerant Decryptor", groupID: 1304 }]
        : [];
    },
    getTypeDogmaAttribute(typeID, attributeID, fallback) {
      // 401 is a science skill: -1% manufacturing time per level (dogma 1982).
      const table = { 401: { 1982: -1 }, 34201: { 1112: 1.5, 1113: 1, 1114: -2, 1124: 3 }, 34202: { 1112: 1.2, 1113: 2, 1114: 10, 1124: 1 } };
      const value = (table[Number(typeID)] || {})[Number(attributeID)];
      return value === undefined ? fallback : value;
    },
    getAllIndustryBlueprints() {
      return ROWS;
    },
    getType(typeID) {
      return TYPES[Number(typeID)] || null;
    },
    getCategoryName(categoryID) {
      return { 4: "Material", 7: "Module" }[Number(categoryID)] || null;
    },
  };
}

// eveGatewayClient is `{}`: a route reaching for the gateway would throw, so a
// 200 back is itself the proof that none was made.
async function startTestServer() {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function call(baseUrl, route, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${route}`, {
    method: options.body ? "POST" : "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

test("both routes refuse an unauthenticated request", async () => {
  const { baseUrl } = await startTestServer();
  const closure = await call(baseUrl, "/api/industry/recipe-closure", {
    body: { productTypeIDs: [103] },
    authenticated: false,
  });
  assert.equal(closure.response.status, 401);
  const search = await call(baseUrl, "/api/industry/blueprints/search?q=widget", { authenticated: false });
  assert.equal(search.response.status, 401);
});

test("POST /api/industry/recipe-closure sends the tree's recipes and names every type it mentions", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await call(baseUrl, "/api/industry/recipe-closure", {
    body: { productTypeIDs: [103] },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "static-data");
  assert.deepEqual(payload.recipes.map((recipe) => recipe.productTypeID), [103, 101, 102]);
  assert.deepEqual(payload.recipes[2], {
    productTypeID: 102,
    activity: "reaction",
    blueprintTypeID: 1002,
    blueprintName: "Gizmo Reaction Formula",
    quantityPerRun: 200,
    timeSeconds: 10800,
    maxRunsPerBlueprint: null,
    materials: [{ typeID: 202, quantity: 100 }],
    skills: [],
    inventedFrom: [],
  });
  assert.deepEqual(payload.types["201"], {
    name: "Tritanium",
    groupID: 18,
    groupName: "Mineral",
    categoryID: 4,
    categoryName: "Material",
    volume: 0.01,
  });
  // A type static data cannot name is sent as an explicit null, never omitted
  // and never "Type 202".
  assert.ok("202" in payload.types);
  assert.equal(payload.types["202"], null);
  assert.deepEqual(payload.missing, []);
});

test("the closure route caps how many products one call may ask about", async () => {
  const { baseUrl } = await startTestServer();
  const many = Array.from({ length: 51 }, (_, index) => index + 1);
  const { response, payload } = await call(baseUrl, "/api/industry/recipe-closure", {
    body: { productTypeIDs: many },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "TOO_MANY_PRODUCTS");
});

test("GET /api/industry/blueprints/search answers names, with the product named too", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await call(baseUrl, "/api/industry/blueprints/search?q=widget&limit=1");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.matches, [{
    blueprintTypeID: 1001,
    blueprintName: "Widget Blueprint",
    productTypeID: 101,
    activity: "manufacturing",
    productName: "Widget",
  }]);
  assert.equal(payload.total, 2);
  assert.equal(payload.capped, true);
});

test("GET /api/industry/invention-terms: the lower-rate skills from list 799, and every decryptor with its four values", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await call(baseUrl, "/api/industry/invention-terms");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.lowerRateSkillTypeIDs, [403]);
  assert.deepEqual(payload.decryptors, [
    { typeID: 34202, name: "Accelerant Decryptor", probabilityMultiplier: 1.2, materialEfficiency: 2, timeEfficiency: 10, maxRuns: 1 },
    { typeID: 34201, name: "Parity Decryptor", probabilityMultiplier: 1.5, materialEfficiency: 1, timeEfficiency: -2, maxRuns: 3 },
  ]);
  const anonymous = await call(baseUrl, "/api/industry/invention-terms", { authenticated: false });
  assert.equal(anonymous.response.status, 401);
});

test("real table: list 799 and the eight decryptors come from the same tables the server reads", { skip: SKIP_REAL }, () => {
  const list = staticData.getClientTypeList(799);
  assert.ok(list && list.includedTypeIDs.length > 0);
  const decryptors = staticData.getTypesInGroup(1304);
  assert.equal(decryptors.length, 8);
  const accelerant = decryptors.find((type) => type.name === "Accelerant Decryptor");
  assert.ok(accelerant);
  assert.deepEqual([1112, 1113, 1114, 1124].map((attributeID) => staticData.getTypeDogmaAttribute(accelerant.typeID, attributeID)), [1.2, 2, 10, 1]);
});

test("the closure route says how much each manufacturing skill shortens a job, and only those that do", async () => {
  const { baseUrl } = await startTestServer();
  const { payload } = await call(baseUrl, "/api/industry/recipe-closure", { body: { productTypeIDs: [103] } });
  assert.deepEqual(payload.recipes[0].skills, [{ typeID: 3380, level: 5 }, { typeID: 401, level: 1 }]);
  // Industry has no per-level time bonus of its own here: it is the
  // character's attribute, not a required-skill bonus.
  assert.deepEqual(payload.skillTimePercent, { 401: -1 });
});
