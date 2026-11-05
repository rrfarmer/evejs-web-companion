"use strict";

// THE SEAM: the route's REAL bytes, through the REAL decoder, into a REAL plan.
//
// test/piSchematics.test.js proves the route serves the documented shape.
// web/src/bridge/piRecipes.test.ts proves the decoder reads that shape.
// web/src/bridge/piChain*.test.ts prove the resolver's arithmetic.
//
// ⚠ ALL THREE CAN PASS WHILE THE FEATURE IS BROKEN. Each of them describes the
// wire shape in its own words — the route's tests from the route's side, the
// client's tests from a table they shape themselves — and two descriptions of
// one contract are exactly how a field gets renamed on one side only. Nothing
// above ever feeds the bytes the server actually sends into the code that
// actually has to read them.
//
// This file does. It boots the BFF, fetches the route, hands the response
// straight to `decodeRecipeBook`, and walks a real chain out the other end. If
// the two halves ever stop agreeing, this is the test that goes red.
//
// (The client modules are TypeScript; node runs them under `require` directly,
// which is why a CommonJS test can hold both halves at once.)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

const { createApp } = require("../../../src/server");
const staticData = require("../../../src/staticData");
const config = require("../../../src/config");

const { decodeRecipeBook, commodityName, tierOf } = require("../../../web/src/bridge/piRecipes.ts");
const { resolveChain, planProduction, chainLeaves } = require("../lib/piChain.ts");

const PLANET_SCHEMATICS_DATA_FILE = path.join(
  config.eveRoot,
  "_local",
  "gameStore",
  "data",
  "planetSchematics",
  "data.json",
);
const SKIP_REAL = fs.existsSync(PLANET_SCHEMATICS_DATA_FILE)
  ? false
  : "gameStore planetSchematics data.json not present";

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    createSessionToken: () => COOKIE_TOKEN,
    verifySessionToken: (token) =>
      token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "session" }
        : null,
    countConfiguredUsers: () => 1,
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
  };
}

/** `eveGatewayClient: {}` on purpose — a bridge call here would throw. */
async function fetchRecipeBook() {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  const response = await ORIGINAL_FETCH(`http://127.0.0.1:${port}/api/pi/schematics`, {
    headers: { cookie: `evejs_web_poc=${COOKIE_TOKEN}` },
  });
  assert.equal(response.status, 200);
  return decodeRecipeBook(await response.json());
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    );
  }
  await Promise.all(closing);
});

test("the route's own bytes decode into a readable recipe book", { skip: SKIP_REAL }, async () => {
  const book = await fetchRecipeBook();

  // `readable` false here would mean the decoder found no schematics array at
  // all — the exact "the server said nothing" case that must never be confused
  // with "there is nothing to make".
  assert.equal(book.readable, true);
  assert.ok(book.schematics.length >= 60, `decoded ${book.schematics.length} recipes`);

  // The bijection, now proved through the decoder rather than over the payload:
  // if the route ever served two recipes for one output, the book would quietly
  // drop one and every chain through it would be wrong.
  assert.equal(
    book.byOutputTypeID.size,
    book.schematics.length,
    "every decoded recipe makes something distinct",
  );

  for (const recipe of book.schematics) {
    assert.ok(recipe.output.quantity > 0, `${recipe.name} produces something`);
    assert.ok(
      recipe.cycleTimeSeconds !== null && recipe.cycleTimeSeconds > 0,
      `${recipe.name} kept its cycle length through the decoder`,
    );
    // Seconds survived the trip. A value in milliseconds would sail through
    // every type check and render a run of many hours.
    assert.ok(recipe.cycleTimeSeconds < 100000, `${recipe.name}: seconds, not milliseconds`);
  }
});

test("the decoded book names things, and never with an id", { skip: SKIP_REAL }, async () => {
  const book = await fetchRecipeBook();
  let named = 0;
  for (const [typeID] of book.commodities) {
    const name = commodityName(book, typeID);
    if (name === null) {
      continue;
    }
    named += 1;
    // R7d, checked where it would actually be violated: the route resolves the
    // names, so a fallback that stringified the id would arrive here looking
    // exactly like a name.
    assert.ok(
      !/^\d+$/.test(name.trim()),
      `commodity name for ${typeID} is a name, not an id: ${name}`,
    );
    assert.ok(!name.includes(String(typeID)), `commodity name does not carry its id: ${name}`);
  }
  assert.ok(named > 60, `most commodities came back named (${named})`);
});

test("the decoded book classifies both ends of the chain", { skip: SKIP_REAL }, async () => {
  const book = await fetchRecipeBook();
  const tiers = new Set();
  for (const [typeID] of book.commodities) {
    const tier = tierOf(book, typeID);
    if (tier !== null) {
      tiers.add(tier);
    }
  }
  // The raw end and the top end both have to classify, or the planner cannot
  // tell "dig this out of the ground" from "build this".
  assert.ok(tiers.has(0), "raw resources classify as tier 0");
  assert.ok(tiers.has(4), "the top of the tree classifies as tier 4");
});

test("a real chain resolves end to end from the route's bytes", { skip: SKIP_REAL }, async () => {
  const book = await fetchRecipeBook();

  // Take the deepest thing the table actually offers rather than naming one:
  // the test should not need editing when the table changes.
  const topTier = book.schematics.filter((recipe) => tierOf(book, recipe.output.typeID) === 4);
  assert.ok(topTier.length > 0, "the table offers something at the top of the tree");
  const target = topTier[0];

  const root = resolveChain(book, target.output.typeID, 1);
  assert.notEqual(root, null, `${target.name} resolves`);
  assert.equal(root.madeBy && root.madeBy.schematicID, target.schematicID);
  assert.ok(root.inputs.length > 0, `${target.name} is made of something`);

  const leaves = chainLeaves(root);
  assert.ok(leaves.length > 0, "the chain bottoms out");
  for (const leaf of leaves) {
    assert.equal(leaf.madeBy, null, "a leaf is made by nothing");
    assert.ok(leaf.needed > 0);
    // Every leaf of a real chain is something dug out of the ground. If one
    // came back unclassified it would mean the commodities map missed a type
    // the recipes depend on.
    assert.equal(tierOf(book, leaf.typeID), 0, `leaf ${leaf.typeName} is a raw resource`);
  }

  const plan = planProduction(book, target.output.typeID, 1);
  assert.notEqual(plan, null);
  const ids = plan.map((step) => step.typeID);
  assert.equal(new Set(ids).size, ids.length, "each commodity is planned once");
  assert.equal(ids[ids.length - 1], target.output.typeID, "the target is the last step");
  for (const step of plan) {
    assert.ok(step.needed > 0, `${step.typeName} needs a positive quantity`);
    if (step.madeBy !== null) {
      assert.ok(step.runs > 0 && step.produced >= step.needed, `${step.typeName} is made in whole runs`);
      // Time survived the whole trip. `runSeconds` is null when the cycle
      // length did not arrive, which is precisely what a field renamed on one
      // side of the wire looks like from here.
      assert.ok(
        step.runSeconds !== null && step.runSeconds > 0,
        `${step.typeName} knows how long its runs take`,
      );
    }
  }
});
