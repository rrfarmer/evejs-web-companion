"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loginProgram, marshal } = require("../test/helpers/catalogLogin");
const { createInProcessFetch } = require("./inProcessFetch");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wc-effective-catalog-"));
process.env.EVEJS_WEB_POC_DATA_DIR = path.join(scratch, "wc");
process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(scratch, "static");
process.env.EVEJS_SDE_DIR = path.join(scratch, "sde");
process.env.EVEJS_CLIENT_ROOT = "";
test.after(() => {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^wc-effective-catalog-/);
  fs.rmSync(resolved, { recursive: true, force: true });
});

const FixtureHauler = 2100000919;
const Bestower = 1944;
const OtherHull = 2100000920;
const ModModule = 2100000921;
const ModMaterial = 2100000922;
const Unknown = 2100000999;
const ModEffect = 2100000998;
const Afterburner = 12056;
const AmarrHauler = 3343;
const SpaceshipCommand = 3327;
const corporationID = 20;
const characterID = 10;
const account = { accountID: 7, username: "fixture", banned: false };

function type(typeID, name, categoryID, groupID) {
  return { typeID, name, categoryID, groupID, published: true, volume: 123, basePrice: 500, portionSize: 1, marketGroupID: 85 };
}

const installed = [
  type(Bestower, "Bestower", 6, 28), type(Afterburner, "10MN Afterburner I", 7, 46),
  type(AmarrHauler, "Amarr Hauler", 16, 257), type(SpaceshipCommand, "Spaceship Command", 16, 257),
];
const stockTypes = new Map(installed.map(row => [row.typeID, row]));
function staticTable(name, value) {
  const directory = path.join(process.env.EVEJS_GAMESTORE_DATA_DIR, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "data.json"), JSON.stringify(value));
}
staticTable("itemTypes", { types: installed });
staticTable("typeDogma", { typesByTypeID: { [Bestower]: { attributes: { 182: AmarrHauler, 277: 1 }, effects: [] } } });

const { createApp } = require("./server");
const { GamePortSession } = require("./gamePort/session");
const { createEffectiveCatalog } = require("./effectiveCatalog");

const nativeCatalog = {
  additions: {
    itemTypes: [
      type(FixtureHauler, "FixtureHauler", 6, 28), type(OtherHull, "Test Mod Transport", 6, 999),
      type(ModModule, "Test Mod Module", 7, 46), type(ModMaterial, "Test Mod Material", 4, 18),
    ],
    typeDogma: {
      [FixtureHauler]: { typeID: FixtureHauler, attributes: { 12: 5, 182: AmarrHauler, 277: 1 }, effects: [] },
      [OtherHull]: { typeID: OtherHull, attributes: { 12: 4 }, effects: [] },
      [ModModule]: { typeID: ModModule, attributes: { 73: 1000 }, effects: [ModEffect], defaultEffectID: ModEffect },
    },
  },
  effects: { [ModEffect]: { effectID: ModEffect, name: "fixtureCycle", effectCategoryID: 1, durationAttributeID: 73 } },
};

function savedFitting(fittingID, name, shipTypeID, moduleTypeID) {
  return [fittingID, {
    type: "object", args: { type: "dict", entries: Object.entries({
      fittingID, name, shipTypeID, ownerID: corporationID, savedDate: "134386123032690000",
      fitData: { type: "list", items: [{ type: "tuple", items: [moduleTypeID, 19, 1] }] },
    }) },
  }];
}

const gateway = {
  async callMethod(service, method) {
    assert.deepEqual([service, method], ["corpFittingMgr", "GetFittings"]);
    return { result: { type: "dict", entries: [
      savedFitting(32, "Corp FixtureHauler", FixtureHauler, Afterburner),
      savedFitting(34, "Corp Bestower Hauler", Bestower, Afterburner),
      savedFitting(35, "Other transport", OtherHull, ModModule),
      savedFitting(36, "Unknown hull", Unknown, Afterburner),
    ] } };
  },
};

const tables = {
  requiredSkillsForTypes: { [Bestower]: [[AmarrHauler, 1]], [AmarrHauler]: [[SpaceshipCommand, 3]] },
  groupCategories: { 28: 6, 46: 7 },
  metaGroupNameIDs: {},
  dogmaAttributes: { 73: { name: "duration" }, 182: { name: "requiredSkill1" } },
  typeBasePrices: Object.fromEntries(installed.map(row => [row.typeID, row.basePrice])),
  typePublished: Object.fromEntries(installed.map(row => [row.typeID, row.published])),
  typePortionSizes: Object.fromEntries(installed.map(row => [row.typeID, row.portionSize])),
  typesGroupIDsOrdered: { [Bestower]: 28, "#order": [Bestower] },
};
const installedData = {
  async table(name) { return tables[name] ?? null; },
  async rows(name, ids) {
    if (name === "types") return Object.fromEntries(ids.map(id => [id, stockTypes.get(id) ?? null]));
    return {};
  },
};

test("GamePort publishes one catalog for training, ship reviews and Dogma while retaining stock types", async () => {
  const effectiveCatalog = createEffectiveCatalog();
  const app = createApp({
    effectiveCatalog,
    eveStore: {
      async getAccount() { return account; },
      async listCharactersForAccount() { return [{ ...account, characterID, corporationID, characterName: "Fixture pilot" }]; },
    },
    eveGatewayClient: gateway,
    webAuth: { verifySessionToken: () => ({ ...account, sessionID: "fixture-account" }) },
    clientBuiltData: installedData,
  });
  const baseUrl = "http://catalog.test";
  const request = createInProcessFetch(app, { baseUrl, fetch: () => assert.fail("Unexpected external request") });
  async function read(route, body) {
    const response = await request(new URL(route, baseUrl), {
      method: body ? "POST" : "GET", body: body && JSON.stringify(body),
      headers: { authorization: "Bearer fixture", "content-type": "application/json" },
    });
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  }

  const catalogPath = `/api/ship-provisioning/review?characterID=${characterID}&providerCharacterID=${characterID}&fittingID=0`;
  const readCatalog = async () => (await read(catalogPath)).definitions;
  const skillsQuery = `/api/client-data/required-skills?typeIDs=${FixtureHauler},${Bestower},${Unknown}`;
  assert.deepEqual((await readCatalog()).contracts.map(fit => fit.name), ["Corp Bestower Hauler"]);
  const before = (await read(skillsQuery)).required;
  assert.deepEqual(before[Bestower], { [AmarrHauler]: 1 });
  assert.deepEqual(before[SpaceshipCommand], {});
  assert.deepEqual(before[FixtureHauler], {});

  const session = new GamePortSession({ transport: {}, onLoginProgram: effectiveCatalog.observeLogin });
  session._runHandshakeFunction([loginProgram(nativeCatalog)]);
  const { contracts, invalid } = await readCatalog();
  assert.deepEqual(contracts.map(fit => fit.name), ["Corp FixtureHauler", "Corp Bestower Hauler", "Other transport"]);
  assert.equal(contracts.find(fit => fit.definition.fittingID === 32).shipTypeID, FixtureHauler);
  assert.deepEqual(invalid.map(row => row.fittingID), [36]);
  const graph = await read(skillsQuery + `,${OtherHull},${ModMaterial}`);
  assert.deepEqual(graph.required[FixtureHauler], { [AmarrHauler]: 1 });
  assert.deepEqual(graph.order[FixtureHauler], [[AmarrHauler, 1]]);
  assert.deepEqual(graph.required[Bestower], before[Bestower]);
  assert.deepEqual(graph.required[AmarrHauler], { [SpaceshipCommand]: 3 });
  assert.deepEqual(graph.required[OtherHull], {});
  assert.equal(Object.hasOwn(graph.required, Unknown), false);
  assert.equal(Object.hasOwn(graph.required, ModMaterial), false);

  const names = await read("/api/names", { items: [FixtureHauler, Bestower, OtherHull, ModModule, ModMaterial, Unknown]
    .map(id => ({ kind: "type", id })) });
  assert.deepEqual(names.names, {
    [`type:${FixtureHauler}`]: "FixtureHauler", [`type:${Bestower}`]: "Bestower", [`type:${OtherHull}`]: "Test Mod Transport",
    [`type:${ModModule}`]: "Test Mod Module", [`type:${ModMaterial}`]: "Test Mod Material", [`type:${Unknown}`]: null,
  });
  assert.ok((await read("/api/market/find?q=FixtureHauler")).matches.some(row => row.typeID === FixtureHauler));
  const meta = (await read(`/api/client-data/type-meta?typeIDs=${OtherHull}`)).types;
  assert.equal(meta[OtherHull].groupID, 999);
  assert.equal(meta[OtherHull].categoryID, 6);
  const prices = await read(`/api/client-data/type-prices?typeIDs=${ModModule}`);
  assert.equal(prices.published[ModModule], true);
  assert.equal(prices.basePrice[ModModule], 500);

  const dogma = await read(`/api/client-data/dogma-types?typeIDs=${FixtureHauler},${ModModule},${Unknown}`);
  assert.deepEqual(dogma.types[FixtureHauler].requiredSkills, [AmarrHauler]);
  assert.equal(dogma.types[ModModule].defaultEffectID, ModEffect);
  assert.equal(dogma.effects[ModEffect].name, "fixtureCycle");
  assert.equal(dogma.types[Unknown], null);
  const rawDogma = await read("/api/types/dogma", { typeIDs: [FixtureHauler, ModModule], attributeIDs: [12, 73] });
  assert.deepEqual(rawDogma.attributes, { [FixtureHauler]: { 12: 5 }, [ModModule]: { 73: 1000 } });
  const groups = await effectiveCatalog.withEffectiveCatalog(installedData).table("typesGroupIDsOrdered");
  assert.equal(groups, tables.typesGroupIDsOrdered);

  session._runHandshakeFunction(Buffer.from("ordinary login program"));
  assert.equal((await readCatalog()).contracts.length, 3);
  assert.equal(createEffectiveCatalog().getType(FixtureHauler), null);
  assert.equal(graph.available, false);
  assert.deepEqual(graph.unknownTypeIDs.sort(), [Unknown, ModMaterial].sort());
});

test("the BFF wires its live type readers into GamePort, including specialized hold Dogma", t => {
  const pilotPort = require("./gamePort/pilots");
  const factory = t.mock.method(pilotPort, "createGamePortPilots");
  const app = createApp({ env: { EVEJS_PILOT_TRANSPORT: "gameport" }, eveStore: {} });
  assert.equal(factory.mock.callCount(), 1);
  const options = factory.mock.calls[0].arguments[0];
  const first = new GamePortSession({ transport: {}, onLoginProgram: options.onLoginProgram });
  const second = new GamePortSession({ transport: {}, onLoginProgram: options.onLoginProgram });
  const { shipHasHold } = require("./clientData/holdCapacity");
  const gasFlag = 135, gasCapacity = 1557;
  const hasGasHold = () => shipHasHold(gasFlag, id => options.typeAttribute(FixtureHauler, id),
    options.typeGroup(FixtureHauler), { byFlag: new Map([[gasFlag, gasCapacity]]) });

  function checkStock() {
    assert.deepEqual(options.typeNames(Bestower), { name: "Bestower", groupName: "" });
    assert.deepEqual(options.typeFacts(Bestower), { groupID: 28, categoryID: 6 });
    assert.deepEqual(options.typeBasePrice(Bestower), { basePrice: 500, portionSize: 1 });
    assert.equal(options.typeAttribute(Bestower, 182), AmarrHauler);
    assert.deepEqual(options.typeEffects(Bestower), []);
  }
  checkStock();
  assert.equal(options.typeGroup(FixtureHauler), null);
  assert.equal(hasGasHold(), false);
  const catalog = structuredClone(nativeCatalog);
  const hull = catalog.additions.itemTypes.find(row => row.typeID === FixtureHauler);
  hull.groupName = "Hauler";
  const dogma = catalog.additions.typeDogma[FixtureHauler];
  dogma.attributes[gasCapacity] = 12000;
  dogma.effects = [ModEffect];
  // A partial row for an installed hull cannot overwrite its name, price or Dogma.
  catalog.additions.itemTypes.push({ typeID: Bestower, name: "Conflicting name", categoryID: 6, groupID: 999, published: true });
  catalog.additions.typeDogma[Bestower] = { typeID: Bestower, attributes: { 12: 0 }, effects: [ModEffect] };
  first._runHandshakeFunction(loginProgram(catalog));
  assert.deepEqual(options.typeNames(FixtureHauler), { name: "FixtureHauler", groupName: "Hauler" });
  assert.deepEqual(options.typeFacts(FixtureHauler), { groupID: 28, categoryID: 6 });
  assert.equal(options.typeGroup(FixtureHauler), 28);
  assert.deepEqual(options.typeBasePrice(FixtureHauler), { basePrice: 500, portionSize: 1 });
  assert.equal(options.effectCategory(ModEffect), 1);
  assert.deepEqual(options.typeEffects(FixtureHauler).map(e => e.name), ["fixtureCycle"]);
  assert.equal(hasGasHold(), true);
  assert.equal(options.typeAttribute(FixtureHauler, gasCapacity), 12000);
  second._runHandshakeFunction(marshal("ordinary_login()"));
  assert.equal(options.typeAttribute(FixtureHauler, gasCapacity), 12000);
  dogma.attributes[gasCapacity] = 16500;
  catalog.effects[ModEffect].name = "revisedCycle";
  second._runHandshakeFunction(loginProgram(catalog));
  assert.deepEqual(options.typeEffects(FixtureHauler).map(e => e.name), ["revisedCycle"]);
  assert.equal(options.typeAttribute(FixtureHauler, gasCapacity), 16500);
  checkStock();
  assert.equal(app.locals.gamePortPilots.size, 0);
});

test("only the documented carrier can extend data or recover a known native reply", () => {
  const catalog = createEffectiveCatalog();
  const digest = require("node:crypto").createHash("sha256").update(marshal("fixture_native()")).digest("hex");
  const session = new GamePortSession({ transport: {}, onLoginProgram: catalog.observeLogin,
    handshakeFunctions: new Map([[digest, "recorded reply"]]) });
  assert.equal(session._runHandshakeFunction(loginProgram(nativeCatalog)), "recorded reply");
  assert.equal(session._runHandshakeFunction(loginProgram(nativeCatalog, "different()")), "");
  const unrelated = createEffectiveCatalog();
  unrelated.observeLogin(Buffer.from(JSON.stringify({ catalog: nativeCatalog })));
  assert.equal(unrelated.getType(FixtureHauler), null);
  for (const change of [c => { c.additions.typeDogma[FixtureHauler].attributes[12] = "5"; },
    c => { c.additions.typeDogma[ModModule].defaultEffectID = 999; }]) {
    const invalid = structuredClone(nativeCatalog);
    change(invalid);
    unrelated.observeLogin(loginProgram(invalid));
    assert.equal(unrelated.getType(FixtureHauler), null);
  }
});

test("stock rows and skill values win, merged tables are reused", async () => {
  const catalog = createEffectiveCatalog();
  const incoming = structuredClone(nativeCatalog);
  incoming.additions.typeDogma[FixtureHauler].attributes[277] = 9;
  catalog.observeLogin(loginProgram(incoming));
  const original = { [FixtureHauler]: [[42, 2]] };
  const wrapped = catalog.withEffectiveCatalog({ table: async () => original,
    rows: async () => ({ [FixtureHauler]: { iconID: 42, marketGroupID: 73 } }) });
  assert.deepEqual((await wrapped.rows("types", [FixtureHauler]))[FixtureHauler], { iconID: 42, marketGroupID: 73 });
  const table = await wrapped.table("requiredSkillsForTypes");
  assert.deepEqual(table[FixtureHauler], [[42, 2]]);
  assert.equal(await wrapped.table("requiredSkillsForTypes"), table);
});

test("without client data ordinary required-skills and mixed type-meta retain unavailable", async () => {
  const effectiveCatalog = createEffectiveCatalog();
  effectiveCatalog.observeLogin(loginProgram(nativeCatalog));
  const empty = { available: () => false, table: async () => null, rows: async () => null };
  const app = createApp({ effectiveCatalog, clientBuiltData: empty, sdeBuiltData: installedData,
    eveStore: { getAccount: async () => account }, eveGatewayClient: gateway,
    webAuth: { verifySessionToken: () => ({ ...account, sessionID: "read-only" }) } });
  const baseUrl = "http://catalog.test";
  const fetch = createInProcessFetch(app, { baseUrl, fetch: () => assert.fail() });
  async function read(route) {
    const response = await fetch(new URL("/api/client-data/" + route, baseUrl), { headers: { authorization: "Bearer fixture" } });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal((await read("required-skills?typeIDs=" + Bestower)).available, false);
  assert.equal((await read("type-meta?typeIDs=" + FixtureHauler + "," + Bestower)).available, false);
  assert.equal((await read("type-meta?typeIDs=" + FixtureHauler)).available, true);
  assert.deepEqual((await read("required-skills?typeIDs=" + FixtureHauler)).required[FixtureHauler], { [AmarrHauler]: 1 });
});
