"use strict";

// The Gridcheck plugin (tools/gridcheck-plugin), with no server, no docker and no browser: what it
// plans and how it reads. The live proof is its scenarios, run with `gridcheck run pi-haul` and the
// like. See docs/gridcheck.md.
//
// GRIDCHECK_CHECKOUT=<a Gridcheck checkout> also loads every scenario and recipe through Gridcheck's
// own validator. Without it that test is skipped, as Gridcheck is not a dependency of this repo.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const plan = require("../tools/gridcheck-plugin/colonyPlan");
const { botEvents, newestRun, runFinished } = require("../tools/gridcheck-plugin/tool/botLog");
const { nodeFromFlags, nodeProblems } = require("../tools/gridcheck-plugin/tool/nodes");
const web = require("../tools/gridcheck-plugin/tool/webClient");

const PLUGIN_DIR = path.join(__dirname, "..", "tools", "gridcheck-plugin");
const GRIDCHECK = String(process.env.GRIDCHECK_CHECKOUT || "").trim();

const INFOS = [
  { typeID: 1, planetRestrictionTypeID: 2016, pinEntityType: "command" },
  { typeID: 2, planetRestrictionTypeID: 2016, pinEntityType: "spaceport" },
  { typeID: 3, planetRestrictionTypeID: 2016, pinEntityType: "ecu" },
  { typeID: 4, planetRestrictionTypeID: 2016, pinEntityType: "process", processorTier: "basic" },
  { typeID: 5, planetRestrictionTypeID: 2016, pinEntityType: "process", processorTier: "advanced" },
  { typeID: 9, planetRestrictionTypeID: 11, pinEntityType: "command" },
];
const lookups = {
  pinTypes: plan.pinTypesFor(2016, INFOS),
  typeIDOf: (name) => ({ "Base Metals": 2267, "Aqueous Liquids": 2268, Water: 3645 })[name],
  schematicFor: (name) => ({ schematicID: 121, typeID: name === "Water" ? 3645 : 0, quantity: 20 }),
};

test("a planet's pin types are its own, and a missing one is named", () => {
  assert.deepStrictEqual(plan.pinTypesFor(2016, INFOS), { command: 1, ecu: 3, launchpad: 2, factory: 4 });
  assert.throws(() => plan.pinTypesFor(11, INFOS), /no ecu pin for planet type 11/);
});

test("the command centre is placed and upgraded before anything else, or the next pin is refused on CPU", () => {
  const { changes, extractors } = plan.planPins({ planetID: 7, extract: [{ resource: "Base Metals" }] }, lookups);
  assert.deepStrictEqual(changes.map((change) => change[0]).slice(0, 3), [plan.COMMAND.CREATE_PIN, plan.COMMAND.UPGRADE_COMMAND_CENTER, plan.COMMAND.CREATE_PIN]);
  assert.deepStrictEqual(changes[1][1], [[1, 1], 5]);
  assert.deepStrictEqual(extractors, [{ resourceTypeID: 2267, into: "launchpad", make: null }]);
});

test("a factory gets its recipe and a link to the launchpad", () => {
  const { changes, extractors } = plan.planPins({ planetID: 7, level: 3, extract: [{ resource: "Aqueous Liquids", make: "Water" }] }, lookups);
  assert.ok(changes.some(([command, args]) => command === plan.COMMAND.SET_SCHEMATIC && args[1] === 121));
  assert.strictEqual(changes.filter(([command]) => command === plan.COMMAND.CREATE_LINK).length, 3);
  assert.deepStrictEqual(extractors[0].make, { typeID: 3645, quantity: 20 });
  assert.deepStrictEqual(changes[1][1][1], 3);
});

test("a colony spec's problems are named", () => {
  assert.deepStrictEqual(plan.specProblems({ planetID: 7, extract: [{ resource: "x" }] }), []);
  assert.match(plan.specProblems({ extract: [] }).join(";"), /planetID.*extract/);
  assert.match(plan.specProblems({ planetID: 7, extract: [{ resource: "x", into: "moon" }] }).join(), /into/);
  assert.match(plan.specProblems({ planetID: 7, extra: 1, extract: [{ resource: "x" }] }).join(), /extra: unknown key/);
  assert.match(plan.specProblems({ planetID: 7, extract: [{ resource: "x", make: "y", into: "command" }] }).join(), /make always delivers/);
  assert.throws(() => plan.planPins({ planetID: 0, extract: [] }, lookups), /planetID/);
});

test("a programme's yield goes where the row says", () => {
  const placed = plan.placedPins([
    { pinID: 10, kind: "command" }, { pinID: 11, kind: "spaceport" }, { pinID: 13, kind: "ecu" }, { pinID: 12, kind: "ecu" }, { pinID: 14, kind: "process" },
  ]);
  assert.deepStrictEqual(placed, { command: 10, pad: 11, ecus: [12, 13], factories: [14] });
  const routes = (row, factory = null) => plan.programChange({ ecu: 12, plan: row, placed, factory, yieldPerCycle: 400, firstRoute: 1 }).changes
    .filter(([command]) => command === plan.COMMAND.CREATE_ROUTE).map(([, args]) => args);
  assert.deepStrictEqual(routes({ resourceTypeID: 5, into: "launchpad", make: null }), [[[2, 1], [12, 11], 5, 400]]);
  assert.deepStrictEqual(routes({ resourceTypeID: 5, into: "command", make: null }), [[[2, 1], [12, 11, 10], 5, 400]]);
  assert.deepStrictEqual(routes({ resourceTypeID: 5, into: "launchpad", make: { typeID: 6, quantity: 20 } }, 14),
    [[[2, 1], [12, 11, 14], 5, 400], [[2, 2], [14, 11], 6, 20]]);
});

test("aging moves stored times back, and never a cycle length or an empty time", () => {
  const ticks = 864_000_000_000n;
  const colony = { lastSimulationTime: "134382489515870000", pins: [
    { lastRunTime: "134382489515870000", lastLaunchTime: "0", cycleTime: "72000000000", expiryTime: "134388489515870000", contents: { 2267: 5 } },
  ] };
  assert.strictEqual(plan.rewindColony(colony, 2), 3);
  assert.strictEqual(colony.pins[0].lastRunTime, String(134382489515870000n - 2n * ticks));
  assert.strictEqual(colony.pins[0].lastLaunchTime, "0");
  assert.strictEqual(colony.pins[0].cycleTime, "72000000000");
  assert.deepStrictEqual(colony.pins[0].contents, { 2267: 5 });
});

test("a colony reads as what is running, what has finished and what is waiting", () => {
  const entityOf = (typeID) => ({ 1: "command", 2: "spaceport", 3: "ecu" })[typeID];
  const row = plan.summarize({ planetID: 7, level: 5, routes: [{}], pins: [
    { typeID: 1, contents: { 9: 10 } },
    { typeID: 2, contents: { 9: 30, 8: 2 } },
    { typeID: 3, expiryTime: "2000" },
    { typeID: 3, expiryTime: "500" },
    { typeID: 3 },
  ] }, { entityOf, filetimeNow: 1000n });
  assert.deepStrictEqual(row, { planetID: 7, pins: 5, level: 5, extractors: 3, extracting: 1, finished: 2, launchpadUnits: 32, commandUnits: 10, routes: 1 });
});

test("every connection the web client makes goes to the tree's block: nothing is left at a stock port", () => {
  const ports = { game: 33860, gateway: 33862, gatewayTls: 33863, xmpp: 33870 };
  const env = web.containerEnv(ports, { sdeFolder: "sde-jsonl" });
  for (const name of web.HANDLED_CONNECTION_VARS) assert.ok(env[name], `${name} is set`);
  const text = Object.values(env).join(" ");
  for (const stock of ["26000", "26001", "26002", "26003", "5222", "443"]) assert.ok(!text.includes(`:${stock}`), `${stock} is not used`);
  assert.match(env.EVEJS_GATEWAY_URL, /:33862\//);
  assert.strictEqual(env.EVEJS_XMPP_PORT, "33870");
});

test("a checkout that reads a connection variable this plugin doesn't set is found", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.js"), "process.env.EVEJS_GATEWAY_URL; process.env.EVEJS_PILOT_TRANSPORT; process.env.EVEJS_ICON_CACHE_DIR;");
  assert.deepStrictEqual(web.unhandledConnectionVars(dir), []);
  fs.writeFileSync(path.join(dir, "src", "deep", "b.js"), "process.env.EVEJS_MARKET_HOST; process.env.EVEJS_NEW_THING_URL;");
  fs.writeFileSync(path.join(dir, "src", "deep", "b.test.js"), "process.env.EVEJS_TEST_PORT;");
  assert.deepStrictEqual(web.unhandledConnectionVars(dir), ["EVEJS_MARKET_HOST", "EVEJS_NEW_THING_URL"]);
});

test("a node names something on the page, and a bad one says why", () => {
  assert.deepStrictEqual(nodeProblems("Refresh"), []);
  assert.deepStrictEqual(nodeProblems({ role: "button", name: "Add", exact: true }), []);
  assert.deepStrictEqual(nodeProblems({ within: { role: "region" }, role: "button" }), []);
  assert.match(nodeProblems({ exact: true }).join(), /needs one of/);
  assert.match(nodeProblems({ name: "Add" }).join(), /name goes with role/);
  assert.match(nodeProblems({ text: "x", kind: 1 }).join(), /kind: unknown key/);
  assert.match(nodeProblems({ text: "x", within: {} }).join(), /within: a node needs/);
  assert.deepStrictEqual(nodeFromFlags({ role: "tab", name: "Stock", exact: true, index: "1" }), { role: "tab", name: "Stock", exact: true, index: 1 });
  assert.strictEqual(nodeFromFlags({ timeout: "3" }), null);
});

test("a bot run reads from its flight recorder, and a pause counts as its end", () => {
  const line = (kind, extra) => ({ t: "2026-11-04T06:58:10.000Z", kind, run: "a", ...extra });
  const lines = [
    { t: "2026-11-04T06:00:00.000Z", kind: "end", run: "old", status: "stopped" },
    line("decide", { status: "running", phase: "Starting" }),
    line("decide", { status: "running", phase: "Starting" }),
    line("decide", { status: "running", phase: "Waiting between actions" }),
    line("issue", { says: "undock", phase: "Leaving" }),
    line("result", { says: "undock", ok: false, error: "refused" }),
    line("decide", { status: "paused", phase: "Paused", reason: "No Epithal" }),
  ];
  assert.strictEqual(newestRun(lines), "a");
  assert.strictEqual(newestRun([]), null);
  assert.ok(runFinished(lines, "a"));
  assert.ok(!runFinished(lines.slice(0, 5), "a"));
  const events = botEvents(lines, "a", 7);
  assert.deepStrictEqual(events.map((event) => event.what), ["phase", "issue", "result", "end"]);
  assert.strictEqual(events[2].ok, false);
  assert.strictEqual(events[3].status, "paused");
  assert.strictEqual(events[3].reason, "No Epithal");
  assert.strictEqual(events[0].characterID, 7);
});

test("every shipped scenario and recipe loads, and a step's fields survive the core's own names", { skip: !GRIDCHECK && "no GRIDCHECK_CHECKOUT" }, () => {
  const { createToolRegistry } = require(path.resolve(GRIDCHECK, "core", "plugins"));
  const { loadRecipe, listRecipes } = require(path.resolve(GRIDCHECK, "core", "recipes"));
  const { validateScenario } = require(path.resolve(GRIDCHECK, "core", "scenario"));
  const registry = createToolRegistry({ active: [{ name: "companion", plugin: require("../tools/gridcheck-plugin/plugin"), dir: PLUGIN_DIR }], skipped: [] });
  const scenarios = fs.readdirSync(path.join(PLUGIN_DIR, "scenarios")).filter((name) => name.endsWith(".json"));
  assert.ok(scenarios.length >= 6);
  for (const name of scenarios) {
    const raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "scenarios", name), "utf8"));
    const scenario = validateScenario(raw, { source: name, defaultName: path.basename(name, ".json"), registry, recipeExists: () => true });
    for (const step of scenario.setup) {
      if (step.type === "webClick" || step.type === "webExpect" || step.type === "webFill" || step.type === "webSelect") assert.ok(step.locator, `${name}: ${step.type} keeps its node`);
      if (step.type === "colonyStock") assert.ok(step.commodity, `${name}: colonyStock keeps its commodity`);
      if (step.type === "pluginSignal") assert.strictEqual(step.backend, "pi-manager");
    }
  }
  const recipe = loadRecipe("pi-colonies", { registry, resolveSystemID: (text) => text });
  assert.deepStrictEqual(recipe.steps.filter((step) => step.type === "login").map((step) => step.user), ["e2epi", "e2epi2"]);
  assert.deepStrictEqual(recipe.steps.filter((step) => step.type === "colony").map((step) => step.spec.planetID), [40161463, 40161469, 40161464]);
  assert.ok(listRecipes({ registry }).some((row) => row.name === "pi-colonies"));
});
