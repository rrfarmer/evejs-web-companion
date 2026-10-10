"use strict";

// src/gamePort/retailCalls.js: each call as the retail client sends it, and the
// tally of how what was called compares. Every reshaping here was read off the
// decompiled client; the entry names the file and line.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONTRACT_SEARCH_KEYWORDS, GAME_PORT_ONLY_CALLS, MONIKER_SERVICES, PROXY_SERVICES, REPEATS, RETAIL_CALLS, createCallLedger, list, madeAfresh, madeOnMoniker, retailForm, retailNeeds } = require("../src/gamePort/retailCalls");
const { keywordOrder } = require("../src/gamePort/py27");
const contract = require("../contracts/evejs-web-bridge-contract.json");

const form = (pair, args, kwargs = null) => {
  const [service, method] = pair.split(".");
  return retailForm(service, method, args, kwargs);
};

test("a pair nobody has checked goes out as the BFF spelt it, and says so", () => {
  const args = [1, [2, 3]];
  const kwargs = { flag: 5 };
  const answer = retailForm("someService", "SomeMethod", args, kwargs);
  assert.deepEqual(answer, { args, kwargs, status: "unchecked", source: null, note: null, moniker: false, proxy: false });
  assert.equal(answer.args, args, "untouched, not copied");
  assert.deepEqual(retailForm("someService", "SomeMethod", undefined, undefined), { args: [], kwargs: null, status: "unchecked", source: null, note: null, moniker: false, proxy: false });
});

test("a pair that is the same as the client's is left alone", () => {
  const answer = form("agentMgr.DoAction", [376]);
  assert.deepEqual([answer.args, answer.kwargs, answer.status], [[376], null, "same"]);
  assert.match(answer.source, /agentDialogueWindow\.py:\d+$/);
});

test("List goes out as List(flag=flag): a keyword, and None when there is no flag", () => {
  assert.deepEqual(form("invbroker.List", [5]), { args: [], kwargs: { flag: 5 }, status: "reshaped", source: RETAIL_CALLS["invbroker.List"].source, note: "List(flag=flag)", moniker: false, proxy: false });
  assert.deepEqual(form("invbroker.List", []).kwargs, { flag: null });
  assert.deepEqual(form("invbroker.List", [], { flag: 4 }).kwargs, { flag: 4 }, "already a keyword: kept");
  assert.deepEqual(form("invbroker.List", [0]).kwargs, { flag: 0 }, "flag 0 is a flag");
});

test("ListByFlags goes out as ListByFlags(flags=[...]): a keyword, and a list", () => {
  const answer = form("invbroker.ListByFlags", [[11, 12, 13]]);
  assert.deepEqual([answer.args, answer.kwargs], [[], { flags: { type: "list", items: [11, 12, 13] } }]);
  assert.deepEqual(form("invbroker.ListByFlags", [{ type: "list", items: [5] }]).kwargs, { flags: { type: "list", items: [5] } });
  assert.deepEqual(form("invbroker.ListByFlags", []).kwargs, { flags: { type: "list", items: [] } });
});

test("MultiAdd's item IDs go out as a list; the rest is as given", () => {
  const answer = form("invbroker.MultiAdd", [[100, 101], 60003760], { flag: 5 });
  assert.deepEqual(answer.args, [{ type: "list", items: [100, 101] }, 60003760]);
  assert.deepEqual(answer.kwargs, { flag: 5 });
  assert.equal(answer.status, "reshaped");
});

test("Add is the client's when it carries a quantity, and is marked when it does not", () => {
  const whole = form("invbroker.Add", [100, 60003760], { flag: 5 });
  assert.equal(whole.status, "differs");
  assert.match(whole.note, /always sends qty/);
  assert.deepEqual([whole.args, whole.kwargs], [[100, 60003760], { flag: 5 }], "sent as it is: the quantity is not invented");
  const split = form("invbroker.Add", [100, 60003760], { flag: 5, qty: 3 });
  assert.equal(split.status, "same");
  assert.deepEqual(split.kwargs, { flag: 5, qty: 3 });
  // Where the pilot's inventory cache holds the item, a call with no quantity is given the stack's size, as the
  // client's own would be (invControllers._AddItem: quantity = item.stacksize).
  const knows = { stackSize: (itemID) => (itemID === 100 ? 3822 : itemID === 101 ? 1 : null) };
  const filled = withContext("invbroker.Add", [100, 60003760], { flag: 5 }, knows);
  assert.deepEqual([filled.args, filled.kwargs, filled.status, filled.moniker], [[100, 60003760], { flag: 5, qty: 3822 }, "reshaped", false]);
  assert.deepEqual(withContext("invbroker.Add", [101, 60003760], { flag: 4 }, knows).kwargs, { flag: 4, qty: 1 });
  // A quantity the caller gave is the caller's, whatever is held of the item; null is none given.
  assert.deepEqual([withContext("invbroker.Add", [100, 60003760], { flag: 5, qty: 3 }, knows).kwargs, withContext("invbroker.Add", [100, 60003760], { flag: 5, qty: 3 }, knows).status], [{ flag: 5, qty: 3 }, "same"]);
  assert.deepEqual(withContext("invbroker.Add", [100, 60003760], { flag: 5, qty: null }, knows).kwargs, { flag: 5, qty: 3822 });
  // An item the cache does not hold: sent as it came, and marked.
  const unknown = withContext("invbroker.Add", [999, 60003760], { flag: 5 }, knows);
  assert.deepEqual([unknown.kwargs, unknown.status], [{ flag: 5 }, "differs"]);
  assert.match(unknown.note, /always sends qty.* This call has none, and the item is in no listing the pilot holds\.$/);
});

test("a call the client never makes is still sent, and is counted as the web client's own", () => {
  const answer = form("invbroker.GetCapacity", [5]);
  assert.deepEqual([answer.args, answer.kwargs, answer.status], [[5], null, "web-only"]);
  assert.match(answer.note, /never asks the server/);
});

test("no keywords is null, as the BFF passes it", () => {
  assert.equal(form("agentMgr.DoAction", [null], {}).kwargs, null);
  assert.equal(form("invbroker.StackAll", [4]).kwargs, null);
  // A reshaping that ends with no keywords says null too, not an empty object.
  assert.equal(form("invbroker.MultiAdd", [[1], 2]).kwargs, null);
  assert.equal(form("invbroker.MultiAdd", [[1], 2], {}).kwargs, null);
});

test("list() wraps an array and leaves anything else", () => {
  assert.deepEqual(list([1, 2]), { type: "list", items: [1, 2] });
  const wrapped = { type: "list", items: [1] };
  assert.equal(list(wrapped), wrapped);
  assert.equal(list(null), null);
});

test("every entry names a pair the web client may call, a status, and where it was read", () => {
  // The gateway's list, and what the game port carries beside it.
  const allowed = new Set([...contract.gatewayAllowlist.pairs, ...GAME_PORT_ONLY_CALLS]);
  const clientRoot = path.resolve(__dirname, "..", "..", "eve.js", "tools", "ClientCodeGrabber", "Latest");
  const haveClient = fs.existsSync(clientRoot);
  for (const [pair, entry] of Object.entries(RETAIL_CALLS)) {
    assert.ok(allowed.has(pair), `${pair} is on the allowlist`);
    assert.ok(["same", "reshaped", "differs", "web-only"].includes(entry.status), `${pair} has a status`);
    assert.match(entry.source, /\.py(:\d+)?$/, `${pair} names a client file`);
    if (entry.status === "reshaped") assert.equal(typeof entry.shape, "function", `${pair} says how`);
    if (entry.status === "differs" || entry.status === "web-only") assert.ok(entry.note, `${pair} says what differs`);
    // Where the decompiled client is on this machine, the file each entry cites is really there.
    if (haveClient) assert.ok(fs.existsSync(path.join(clientRoot, entry.source.replace(/:\d+$/, ""))), `${pair}: ${entry.source} exists`);
  }
});

test("the ledger tallies each pair by how it compared, most called first", () => {
  const ledger = createCallLedger();
  for (let index = 0; index < 3; index += 1) ledger.note("invbroker", "GetCapacity", form("invbroker.GetCapacity", [5]));
  ledger.note("invbroker", "Add", form("invbroker.Add", [1, 2], { flag: 5, qty: 1 }));
  ledger.note("invbroker", "Add", form("invbroker.Add", [1, 2], { flag: 5 }));
  ledger.note("invbroker", "Add", form("invbroker.Add", [1, 2], { flag: 5, qty: 1 }));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  const rows = ledger.rows();
  assert.deepEqual(rows.map((row) => [row.pair, row.calls, row.statuses]), [
    ["invbroker.Add", 3, { same: 2, differs: 1 }],
    ["invbroker.GetCapacity", 3, { "web-only": 3 }],
    ["someService.SomeMethod", 1, { unchecked: 1 }],
  ]);
  assert.match(rows[0].note, /always sends qty/, "the note is the difference, whenever it was seen, not the description");
  rows[0].statuses.x = 1;
  assert.equal(ledger.rows()[0].statuses.x, undefined, "a copy, not the tally itself");
  // Most called first; a tie goes by name.
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  assert.deepEqual(ledger.rows().map((row) => row.pair), ["someService.SomeMethod", "invbroker.Add", "invbroker.GetCapacity"]);
});

// ── the report ───────────────────────────────────────────────────────────────

test("the report lists each pair under the worst status it was seen with, and counts them", () => {
  const { report, worst } = require("../scripts/call-ledger-report");
  assert.equal(worst({ same: 2, differs: 1 }), "differs");
  assert.equal(worst({ reshaped: 1 }), "reshaped");
  assert.equal(worst({ "web-only": 1, unchecked: 4 }), "web-only");
  assert.equal(worst({}), "unchecked");
  const ledger = createCallLedger();
  for (let index = 0; index < 3; index += 1) ledger.note("invbroker", "GetCapacity", form("invbroker.GetCapacity", [5]));
  ledger.note("invbroker", "Add", form("invbroker.Add", [1, 2], { flag: 5, qty: 1 }));
  ledger.note("invbroker", "Add", form("invbroker.Add", [1, 2], { flag: 5 }));
  ledger.note("invbroker", "List", form("invbroker.List", [5]));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  ledger.note("someService", "SomeMethod", retailForm("someService", "SomeMethod", [], null));
  const text = report(ledger.rows(), { what: "a test", generatedOn: "2026-10-08" });
  assert.match(text, /^# Game-port call ledger\n/);
  assert.match(text, /on 2026-10-08, from a test\./);
  assert.match(text, /\| web-only \| 1 \| 3 \|/);
  assert.match(text, /\| differs \| 1 \| 2 \|/);
  assert.match(text, /\| unchecked \| 1 \| 2 \|/);
  assert.match(text, /\| reshaped \| 1 \| 1 \|/);
  assert.match(text, /\| same \| 0 \| 0 \|/);
  assert.match(text, /\| \*\*total\*\* \| \*\*4\*\* \| \*\*8\*\* \|/);
  assert.match(text, /## unchecked \(1\)\n\n`someService\.SomeMethod` ×2\n/);
  assert.match(text, /\| `invbroker\.Add` \| 2 \| `eve\/client\/script\/environment\/invControllers\.py:213` \| The client always sends qty/);
  assert.equal(text.includes("## same"), false, "an empty group has no section");
});

// ── the scanner ──────────────────────────────────────────────────────────────

test("RequestScans goes out as the client's {probeID: probe}, each probe a util.KeyVal, or as None", () => {
  const route = { 990000000005: { typeID: 30013, pos: [1.5, 2, 3], destination: [4, 5, 6], scanRange: 2393565931200, rangeStep: 7, state: 1, expiry: "134359490166880000" } };
  const shaped = form("scanMgr.RequestScans", [route]);
  assert.equal(shaped.status, "reshaped");
  assert.deepEqual(shaped.args, [{
    type: "dict",
    entries: [[990000000005, {
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries: [["probeID", 990000000005], ["typeID", 30013], ["pos", [1.5, 2, 3]], ["destination", [4, 5, 6]], ["scanRange", 2393565931200], ["rangeStep", 7], ["state", 1], ["expiry", 134359490166880000n]] },
    }]],
  }]);
  assert.equal(shaped.kwargs, null);
  const fields = (probe) => new Map(form("scanMgr.RequestScans", [{ 7: probe }]).args[0].entries[0][1].args.entries);
  // A position in a list wrapper, a time as a long or a number, no destination (it is where the probe is), nothing at all.
  assert.deepEqual(fields({ pos: { type: "list", items: [1, 2, 3, 4] } }).get("pos"), [1, 2, 3]);
  assert.deepEqual(fields({ pos: [1, 2, 3] }).get("destination"), [1, 2, 3]);
  assert.deepEqual(fields({ pos: [1, 2, 3, 4] }).get("pos"), [1, 2, 3], "three numbers and no more");
  assert.equal(fields({ expiry: { type: "long", value: "55" } }).get("expiry"), 55n);
  assert.equal(fields({ expiry: 55 }).get("expiry"), 55n);
  assert.equal(fields({ expiry: 55n }).get("expiry"), 55n);
  assert.deepEqual([...fields({})], [["probeID", 7], ["typeID", null], ["pos", [0, 0, 0]], ["destination", [0, 0, 0]], ["scanRange", 0], ["rangeStep", 0], ["state", 0], ["expiry", null]]);
  assert.equal(fields({ expiry: "soon" }).get("expiry"), null);
  // No probes: None, which is the ship's own scan. What is no probe is left out.
  for (const none of [null, undefined, {}, { x: { typeID: 1 } }, { 0: { typeID: 1 } }, { 5: null }, { "5.5": {} }]) {
    assert.deepEqual(form("scanMgr.RequestScans", [none]).args, [null], JSON.stringify(none));
  }
  assert.deepEqual(form("scanMgr.RequestScans", []).args, [null]);
  // Already a dict, as the client would hand it: left alone.
  const dict = { type: "dict", entries: [[5, { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [] } }]] };
  assert.equal(form("scanMgr.RequestScans", [dict]).args[0], dict);
  // Two probes keep the order they were given in.
  assert.deepEqual(form("scanMgr.RequestScans", [{ 9: {}, 8: {} }]).args[0].entries.map(([probeID]) => probeID), [8, 9]);
});

test("the probes to recall and the probes to switch go out as lists; the rest of the scan calls are the client's as they stand", () => {
  assert.deepEqual(form("scanMgr.RecoverProbes", [[5, 6]]).args, [{ type: "list", items: [5, 6] }]);
  assert.deepEqual(form("scanMgr.SetActivityState", [[5, 6], true]).args, [{ type: "list", items: [5, 6] }, true]);
  assert.deepEqual(form("scanMgr.SetActivityState", [{ type: "list", items: [5] }, false]).args, [{ type: "list", items: [5] }, false]);
  for (const [pair, args] of [["scanMgr.GetSystemScanMgr", []], ["scanMgr.DestroyProbe", [5]], ["scanMgr.ReconnectToLostProbes", []], ["scanMgr.ConeScan", [1, 2, 0, 0, 1]], ["dogmaIM.LaunchProbes", [9988400109051, 4]]]) {
    const shaped = form(pair, args);
    assert.deepEqual([shaped.status, shaped.args], ["same", args], pair);
  }
  // Two calls the client never makes: it keeps a probe's destination and range step itself.
  for (const pair of ["scanMgr.SetProbeDestination", "scanMgr.SetProbeRangeStep"]) {
    const shaped = form(pair, [5, 3]);
    assert.deepEqual([shaped.status, shaped.args], ["web-only", [5, 3]], pair);
    assert.match(shaped.note, /RequestScans/);
  }
});

// ── calls the client makes on a moniker ──────────────────────────────────────

const withContext = (pair, args, kwargs, context) => {
  const [service, method] = pair.split(".");
  return retailForm(service, method, args, kwargs, context);
};

test("undock goes to the ship's moniker with the online modules by slot, as the station service sends it", () => {
  const online = () => [[19, 9001], [27, 9002]];
  const answer = withContext("ship.Undock", [5000, false], { onlineModules: [] }, { onlineModules: online });
  assert.deepEqual(answer, {
    args: [5000, false],
    kwargs: { onlineModules: { type: "dict", entries: [[19, 9001], [27, 9002]] } },
    status: "reshaped",
    source: RETAIL_CALLS["ship.Undock"].source,
    note: RETAIL_CALLS["ship.Undock"].note,
    moniker: true,
    proxy: false,
  });
  assert.match(answer.source, /ui\/station\/base\.py:498$/);
  // The second argument is a yes or a no: only a true is a yes.
  assert.deepEqual(withContext("ship.Undock", [5000, true], null, { onlineModules: online }).args, [5000, true]);
  assert.deepEqual(withContext("ship.Undock", [5000, 1], null, { onlineModules: online }).args, [5000, false]);
  assert.deepEqual(withContext("ship.Undock", [5000], null, { onlineModules: online }).args, [5000, false]);
  // No module online is still an answer: an empty dict, and the client's call.
  assert.deepEqual(((form) => [form.kwargs, form.status])(withContext("ship.Undock", [5000, false], null, { onlineModules: () => [] })), [{ onlineModules: { type: "dict", entries: [] } }, "reshaped"]);
  // Dogma not to be had: an empty dict goes, and the tally says the call is not the client's.
  for (const context of [{}, { onlineModules: () => null }, undefined]) {
    const blind = withContext("ship.Undock", [5000, false], { onlineModules: [] }, context);
    assert.deepEqual([blind.kwargs, blind.status, blind.moniker], [{ onlineModules: { type: "dict", entries: [] } }, "differs", true]);
    assert.match(blind.note, /online modules by slot/);
  }
  // Another keyword a route sent is kept.
  assert.deepEqual(Object.keys(withContext("ship.Undock", [5000, false], { other: 1 }, { onlineModules: online }).kwargs), ["other", "onlineModules"]);
});

test("a module is switched on with its effect named and its repeats the client's: 1000 to go on, 0 for one that cannot", () => {
  assert.equal(REPEATS, 1000);
  const knows = { effectName: (itemID) => (itemID === 7 ? "burn" : null), effectRepeats: (itemID, name) => (name === "burn" ? true : name === "fire" ? false : null) };
  const on = (args, context = knows) => withContext("dogmaIM.Activate", args, null, context);
  // The BFF's -1 is "go on repeating".
  assert.deepEqual(on([7, "burn", undefined, -1]), { args: [7, "burn", null, 1000], kwargs: null, status: "reshaped", source: RETAIL_CALLS["dogmaIM.Activate"].source, note: RETAIL_CALLS["dogmaIM.Activate"].note, moniker: true, proxy: false });
  assert.match(RETAIL_CALLS["dogmaIM.Activate"].source, /shipmodulebutton\.py:1348$/);
  // An effect that cannot repeat is sent once, whatever was asked.
  assert.deepEqual(on([8, "fire", 4242, -1]).args, [8, "fire", 4242, 0]);
  // Only an effect aimed at a target is sent one: the page sends what is locked with every module, and the client's
  // button fills a target in for a target effect alone. Where that is not known the target goes as it came.
  const aims = { ...knows, effectTargeted: (itemID, name) => (name === "fire" ? true : name === "burn" ? false : null) };
  assert.deepEqual([on([7, "burn", 4242, -1], aims).args, on([7, "", 4242, -1], aims).args], [[7, "burn", null, 1000], [7, "burn", null, 1000]]);
  assert.deepEqual([on([8, "fire", 4242, -1], aims).args, on([8, "fire", null, -1], aims).args], [[8, "fire", 4242, 0], [8, "fire", null, 0]]);
  assert.deepEqual([on([9, "glow", 4242, 0], aims).args, on([9, "", 4242, -1], aims).args], [[9, "glow", 4242, 0], [9, "", 4242, -1]]);
  assert.equal(on([7, "burn", 4242, -1], aims).status, "reshaped");
  // A count the caller gave is the caller's: once, or five times.
  assert.deepEqual([on([7, "burn", null, 0]).args[3], on([7, "burn", null, 5]).args[3], on([7, "burn", null, "0"]).args[3]], [0, 5, 0]);
  // No name given: the module's own, from what the pilot knows of it. A name on the wire may be bytes.
  assert.deepEqual(on([7, "", null, -1]).args, [7, "burn", null, 1000]);
  assert.deepEqual(on([9, Buffer.from("glow"), null, 0]).args, [9, "glow", null, 0]);
  assert.deepEqual(on([7, null, null, -1]).args, [7, "burn", null, 1000]);
  // No name to be had: it goes as it came, and the tally says so.
  const nameless = on([9, "", null, -1]);
  assert.deepEqual([nameless.args, nameless.status, nameless.moniker], [[9, "", null, -1], "differs", true]);
  assert.match(nameless.note, /always names/);
  assert.deepEqual(on([9, "", null, -1], {}).status, "differs");
  // Named, but whether it repeats is not known: the -1 goes as it is, and that is said. A count given needs no such knowledge.
  const unsure = on([9, "glow", null, -1]);
  assert.deepEqual([unsure.args, unsure.status], [[9, "glow", null, -1], "differs"]);
  assert.match(unsure.note, /1000 or 0/);
  assert.deepEqual([on([9, "glow", null, 0]).status, on([9, "glow", null, 0]).args], ["reshaped", [9, "glow", null, 0]]);
  assert.deepEqual(on([9, "glow", null, -1], {}).status, "differs");
});

test("a module is switched off by its effect's name, on the same moniker", () => {
  const knows = { effectName: (itemID) => (itemID === 7 ? "burn" : null) };
  const off = (args, context = knows) => withContext("dogmaIM.Deactivate", args, null, context);
  assert.deepEqual(off([7, "burn"]), { args: [7, "burn"], kwargs: null, status: "reshaped", source: RETAIL_CALLS["dogmaIM.Deactivate"].source, note: RETAIL_CALLS["dogmaIM.Deactivate"].note, moniker: true, proxy: false });
  assert.match(RETAIL_CALLS["dogmaIM.Deactivate"].source, /godma\.py:2101$/);
  assert.deepEqual(off([7, ""]).args, [7, "burn"]);
  assert.deepEqual(off([7]).args, [7, "burn"]);
  const nameless = off([9, ""]);
  assert.deepEqual([nameless.args, nameless.status, nameless.moniker], [[9, ""], "differs", true]);
  assert.match(nameless.note, /always names/);
  assert.equal(off([9, ""], {}).status, "differs");
});

test("what a call needs the pilot to have first is said by the registry: godma primed, for these three", () => {
  assert.deepEqual(["ship.Undock", "dogmaIM.Activate", "dogmaIM.Deactivate"].map((pair) => retailNeeds(...pair.split("."))), ["dogma", "dogma", "dogma"]);
  assert.deepEqual([retailNeeds("invbroker", "List"), retailNeeds("agentMgr", "DoAction"), retailNeeds("someService", "SomeMethod"), retailNeeds("dogmaIM", "GetTargets")], [null, null, null, null]);
});

test("everything of ship, dogmaIM, corpRegistry and the skill handler is made on a moniker, read or not, but the three the client asks by name", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MONIKER_SERVICES).map(([service, named]) => [service, [...named].sort()])), {
    ship: ["GetShipFittingInfo"],
    dogmaIM: ["CreateNewbieShip", "GetRequiredSkillLevels"],
    // The client never asks the corporation registry by name at all.
    corpRegistry: [],
    // Nor its skill handler: every read of it is a call on the moniker skillMgr2 answered.
    skillHandler: [],
    // Nor crimewatch: each use makes a moniker for where the pilot is and calls it.
    crimewatch: [],
    // The alliance's registry is asked by name about any alliance by its ID; all else is asked of the moniker for the session's own.
    allianceRegistry: ["GetAllianceMembers", "GetAllianceMembersOlderThan", "GetAlliancePublicInfo", "GetDaysInAlliance", "GetEmploymentRecord", "GetRankedAlliances"],
    // Nor a system's orbital registry: each use at a customs office makes a moniker for the system and calls it.
    planetOrbitalRegistryBroker: [],
    // The office manager asks for its corporation's offices by name; all else is asked of the moniker for where the session is docked.
    officeManager: ["GetMyCorporationsOffices"],
  });
  assert.deepEqual([madeOnMoniker("corpRegistry", "GetCorporation"), madeOnMoniker("corpRegistry", "AddBulletin"), madeOnMoniker("corpRegistry", "MachoBindObject")], [true, true, false]);
  assert.deepEqual([madeOnMoniker("ship", "Undock"), madeOnMoniker("dogmaIM", "GetTargets"), madeOnMoniker("ship", "SomethingNobodyRead"), madeOnMoniker("dogmaIM", "Overload")], [true, true, true, true]);
  assert.deepEqual([madeOnMoniker("ship", "GetShipFittingInfo"), madeOnMoniker("dogmaIM", "CreateNewbieShip"), madeOnMoniker("dogmaIM", "GetRequiredSkillLevels")], [false, false, false]);
  // Other services are asked by name, whatever their methods are called; and a bind is a bind, not a call on what it makes.
  assert.deepEqual([madeOnMoniker("invbroker", "List"), madeOnMoniker("agentMgr", "DoAction"), madeOnMoniker("toString", "Undock"), madeOnMoniker("constructor", "x")], [false, false, false, false]);
  assert.deepEqual([madeOnMoniker("ship", "MachoBindObject"), madeOnMoniker("dogmaIM", "MachoBindObject")], [false, false]);
  // The form says so for a pair nobody has read, and for one that has an entry.
  assert.deepEqual(retailForm("ship", "SomethingNobodyRead", [1], null), { args: [1], kwargs: null, status: "unchecked", source: null, note: null, moniker: true, proxy: false });
  assert.equal(retailForm("dogmaIM", "CreateNewbieShip", [1, 2], null).moniker, false);
  for (const pair of Object.keys(RETAIL_CALLS)) {
    const [service, method] = pair.split(".");
    // On the moniker for every pair of those services but the ones the client asks by the service's name. (For a
    // pilot in an alliance: one in none has no moniker for an alliance's registry.)
    assert.equal(retailForm(service, method, [], null, { allianceID: 99000001, solarSystemID: 30002780, dockedAt: 60003760 }).moniker, Object.hasOwn(MONIKER_SERVICES, service) && !MONIKER_SERVICES[service].has(method), pair);
  }
});

test("the alliance's registry is asked on the moniker for the session's alliance, by name about any alliance, and not at all by a client in none", () => {
  const IN = { allianceID: 99000001 };
  const form = (method, args, context) => { const made = retailForm("allianceRegistry", method, args, null, context); return [made.status, made.args, made.moniker]; };
  // eveMoniker.GetAlliance: the client's alliance service asks its moniker, read against the client or not.
  assert.deepEqual([form("GetRelationships", [], IN), form("SetRelationship", [5, 99000002], IN)], [["same", [], true], ["unchecked", [5, 99000002], true]]);
  assert.equal(retailForm("allianceRegistry", "GetRelationships", [], null, IN).source, "eve/client/script/ui/services/alliances/all_cso_relationships.py:25");
  // What is asked about any alliance is asked by name, in an alliance or out of one.
  assert.deepEqual([form("GetRankedAlliances", [100], IN), form("GetRankedAlliances", [100], {}), form("GetAlliancePublicInfo", [99000002], {})], [["same", [100], false], ["same", [100], false], ["unchecked", [99000002], false]]);
  // all_cso_alliance.GetAlliance: the session's own alliance of the moniker, with nothing, however the BFF named it; another's by name, by its ID.
  assert.deepEqual([form("GetAlliance", [], IN), form("GetAlliance", [99000001], IN), form("GetAlliance", [99000002], IN)], [["same", [], true], ["reshaped", [], true], ["same", [99000002], false]]);
  // With no alliance the client cannot make the moniker (eveMoniker.py 171) and asks nothing of it: what the BFF asks
  // goes by name as it was given, and is the web's alone. Another alliance's record is still the client's to ask.
  for (const context of [{}, { allianceID: null }, undefined]) {
    assert.deepEqual([form("GetRelationships", [], context), form("SetRelationship", [5, 99000002], context), form("GetAlliance", [], context)], [["web-only", [], false], ["web-only", [5, 99000002], false], ["web-only", [], false]]);
    assert.deepEqual(form("GetAlliance", [99000002], context), ["same", [99000002], false]);
  }
  assert.equal(retailForm("allianceRegistry", "GetRelationships", [], null, {}).source, "eve/common/script/net/eveMoniker.py:171");
  // No other service's moniker wants anything of the session.
  assert.deepEqual([retailForm("corpRegistry", "GetCorporation", [], null, {}).moniker, retailForm("ship", "Undock", [], null, {}).moniker], [true, true]);
});

test("an approach, the speed set before the autopilot's, and a GM's command are the client's calls as they stand", () => {
  for (const [pair, args, where, moniker] of [
    ["beyonce.CmdFollowBall", [9001, 50], /movementFunctions\.py:302$/, false],
    ["beyonce.CmdSetSpeedFraction", [1.0], /autopilot\.py:434$/, false],
    ["beyonce.CmdOrbit", [9001, 5000], /movementFunctions\.py:260$/, false],
    ["beyonce.CmdStop", [], /eveCommands\.py:1104$/, false],
    ["slash.SlashCmd", ["/giveskill me 3386 3"], /menusvc\.py:834$/, false],
  ]) {
    const answer = form(pair, args);
    assert.deepEqual([answer.args, answer.kwargs, answer.status, answer.moniker], [args, null, "same", moniker], pair);
    assert.match(answer.source, where, pair);
  }
  // Where the client sends none, and that the game port's routes send none there either, is said beside it.
  assert.match(RETAIL_CALLS["beyonce.CmdSetSpeedFraction"].note, /send none before theirs, and on the game port the BFF's routes send none either; through the gateway they do/);
});

test("targeting, onlining, scooping and leaving a ship are the client's calls as they stand", () => {
  for (const [pair, args, where] of [
    ["dogmaIM.GetTargets", [], /godma\.py:2361$/],
    ["dogmaIM.AddTarget", [9001], /targetMgr\.py:1366$/],
    ["dogmaIM.CancelAddTarget", [9001], /targetMgr\.py:1303$/],
    ["dogmaIM.RemoveTarget", [9001], /targetMgr\.py:1385$/],
    ["dogmaIM.SetModuleOnline", [5000, 7], /clientDogmaLocation\.py:702$/],
    ["dogmaIM.TakeModuleOffline", [5000, 7], /clientDogmaLocation\.py:718$/],
    ["ship.ScoopDrone", [[11, 12]], /droneFunctions\.py:195$/],
    ["ship.LeaveShip", [5000], /ui\/station\/base\.py:248$/],
    ["ship.Board", [5001, 5000], /menuFunctions\.py:209$/],
  ]) {
    const answer = form(pair, args);
    assert.deepEqual([answer.args, answer.kwargs, answer.status, answer.moniker], [args, null, "same", true], pair);
    assert.match(answer.source, where, pair);
  }
});

test("ammunition goes in and out with its modules as a list, and one module by itself when a quantity is named", () => {
  assert.deepEqual(form("dogmaIM.LoadAmmo", [5000, [7, 8], [31, 32], 60003760]).args, [5000, list([7, 8]), list([31, 32]), 60003760]);
  assert.deepEqual(form("dogmaIM.LoadAmmo", [5000, list([7]), list([31]), 5000]).args, [5000, list([7]), list([31]), 5000], "already lists: kept");
  assert.equal(form("dogmaIM.LoadAmmo", [5000, [7], [31], 5000]).status, "reshaped");
  const hangar = [60003760, 140000001, 4];
  // No quantity: the modules as a list, the place as it came (a tuple, which is what an array is on the wire).
  assert.deepEqual(form("dogmaIM.UnloadAmmo", [5000, [7, 8], hangar]).args, [5000, list([7, 8]), hangar]);
  assert.deepEqual(form("dogmaIM.UnloadAmmo", [5000, [7], hangar, null]).args, [5000, list([7]), hangar]);
  // A quantity: the one module by itself.
  assert.deepEqual(form("dogmaIM.UnloadAmmo", [5000, [7], hangar, 40]).args, [5000, 7, hangar, 40]);
  assert.deepEqual(form("dogmaIM.UnloadAmmo", [5000, list([7]), hangar, 40]).args, [5000, 7, hangar, 40]);
  assert.deepEqual(form("dogmaIM.UnloadAmmo", [5000, 7, hangar, 40]).args, [5000, 7, hangar, 40]);
  assert.equal(form("dogmaIM.UnloadAmmo", [5000, [7], hangar, 40]).status, "reshaped");
  // Several modules and a quantity is not a call the client has.
  const several = form("dogmaIM.UnloadAmmo", [5000, [7, 8], hangar, 40]);
  assert.deepEqual([several.args, several.status], [[5000, [7, 8], hangar, 40], "differs"]);
  assert.match(several.note, /one module/);
});

test("ammunition loaded or unloaded names the ship the session is flying: another ship's is counted as not the client's", () => {
  // clientDogmaLocation.py 991 and 996, 1127 and 1140: the ship is the one the client's module sits in, which is
  // the ship its session is flying (or the structure it controls). Every LoadAmmo Tranquility has recorded is
  // (shipID, moduleID, [chargeItemID], shipID): one module by its ID, which stays as it is.
  const flying = { shipID: 5000 };
  const ask = (method, args, context = flying) => retailForm("dogmaIM", method, args, null, context);
  const hold = [5000, 140000001, 5];
  for (const [method, own, other, shaped] of [
    ["LoadAmmo", [5000, 7, [31], 5000], [5001, 7, [31], 5001], [5001, 7, list([31]), 5001]],
    ["LoadAmmo", [5000, [7, 8], [31, 32], 60003760], [5001, [7, 8], [31, 32], 60003760], [5001, list([7, 8]), list([31, 32]), 60003760]],
    ["UnloadAmmo", [5000, [7], hold], [5001, [7], hold], [5001, list([7]), hold]],
    ["UnloadAmmo", [5000, 7, hold, 40], [5001, 7, hold, 40], [5001, 7, hold, 40]],
    // One module in a list with a quantity is named by itself, and whose ship it is still counts.
    ["UnloadAmmo", [5000, [7], hold, 40], [5001, [7], hold, 40], [5001, 7, hold, 40]],
  ]) {
    const made = ask(method, own);
    assert.deepEqual([made.status, made.moniker, made.args[0]], ["reshaped", true, 5000], method);
    assert.doesNotMatch(String(made.note), /names another/, method);
    // Another ship than the session's goes as the client would have shaped it, and is counted as differing.
    const anothers = ask(method, other);
    assert.deepEqual([anothers.status, anothers.args], ["differs", shaped], method);
    assert.match(anothers.note, /ship its session is flying/, method);
    // Where the session's ship is not known (through the web gateway), a ship named is taken for it.
    for (const context of [{}, { shipID: null }, { shipID: undefined }]) assert.equal(ask(method, other, context).status, "reshaped", method);
  }
  assert.deepEqual(ask("LoadAmmo", [5000, 7, [31], 5000]).args, [5000, 7, list([31]), 5000], "one module by its ID, as it is recorded");
  // What was already not the client's keeps its own reason.
  const several = ask("UnloadAmmo", [5001, [7, 8], hold, 40]);
  assert.deepEqual([several.status, several.args], ["differs", [5001, [7, 8], hold, 40]]);
  assert.match(several.note, /one module/);
});

test("a fleet's target tag is the client's call when it names a thing that is not the pilot's own ship and one of the client's tags, from a session in a fleet", () => {
  // menusvc.py 2825: bp.CmdFleetTagTarget(itemID, tag), on the ballpark's object. The menu's tags are the ten
  // digits and thirteen letters (1945, 1946), each a string of one character, and None to take a tag off (1948).
  const flying = { shipID: 5000, fleetID: 654500010000 };
  const ask = (args, kwargs = null, context = flying) => retailForm("beyonce", "CmdFleetTagTarget", args, kwargs, context);
  for (const tag of [..."0123456789ABCDEFGHIJXYZ", null]) {
    const made = ask([9001, tag]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.proxy], ["same", "eve/client/script/ui/services/menusvc.py:2825", [9001, tag], null, false], String(tag));
  }
  for (const [args, kwargs, why, note] of [
    [[], null, "nothing", /one of its tags/],
    [[9001], null, "no tag named", /one of its tags/],
    [[9001, "A", 1], null, "a third argument", /one of its tags/],
    [[9001, "A"], { fleet: true }, "a keyword", /one of its tags/],
    [[0, "A"], null, "no item", /one of its tags/],
    [[-9001, "A"], null, "an item below nought", /one of its tags/],
    [["9001", "A"], null, "an item as text", /one of its tags/],
    [[9001.5, "A"], null, "half an item", /one of its tags/],
    [[9001, "K"], null, "a letter the menu has not", /one of its tags/],
    [[9001, "a"], null, "a small letter", /one of its tags/],
    [[9001, "AB"], null, "two letters", /one of its tags/],
    [[9001, ""], null, "an empty tag", /one of its tags/],
    [[9001, 1], null, "a digit as a number", /one of its tags/],
    [[9001, undefined], null, "a tag left out", /one of its tags/],
    [[5000, "A"], null, "the pilot's own ship", /own ship/],
  ]) {
    const made = ask(args, kwargs);
    assert.deepEqual([made.status, made.args], ["differs", args], why);
    assert.match(made.note, note, why);
  }
  // MakeCmdTagItem (eveCommands.py 3043) and the menu's checker: only from a session in a fleet.
  const fleetless = ask([9001, "A"], null, { shipID: 5000, fleetID: null });
  assert.equal(fleetless.status, "differs");
  assert.match(fleetless.note, /in a fleet/);
  // Where the session's ship or fleet is not known (through the web gateway), neither is held against the call.
  for (const context of [{}, { shipID: null }, { shipID: undefined, fleetID: undefined }]) assert.equal(ask([5000, "A"], null, context).status, "same");
});

test("drones are launched as a list of stacks, on nobody's behalf when it is the pilot's own", () => {
  const stacks = [[11, 1], [12, 3]];
  const launch = (args, context = { characterID: 140000001 }) => withContext("ship.LaunchDrones", args, null, context);
  assert.deepEqual(launch([stacks, 140000001, false]).args, [list(stacks), null, false]);
  assert.deepEqual(launch([stacks, 0, false]).args, [list(stacks), null, false]);
  assert.deepEqual(launch([stacks]).args, [list(stacks), null, false]);
  assert.deepEqual(launch([stacks, 0, false], {}).args, [list(stacks), null, false]);
  // On another's behalf (a corporation's, say) the name stays; and without knowing who the pilot is, so does the pilot's.
  assert.deepEqual(launch([stacks, 98000001, true]).args, [list(stacks), 98000001, true]);
  assert.deepEqual(launch([stacks, 140000001, false], {}).args, [list(stacks), 140000001, false]);
  // Only a true is a yes.
  assert.deepEqual(launch([stacks, 0, 1]).args[2], false);
  assert.match(RETAIL_CALLS["ship.LaunchDrones"].source, /eveMisc\.py:29$/);
});

test("the ship's configuration is asked for by the ship's ID, which the pilot knows", () => {
  const asked = (args, context) => withContext("ship.GetShipConfiguration", args, null, context);
  assert.deepEqual([asked([], { shipID: 5000 }).args, asked([], { shipID: 5000 }).status], [[5000], "reshaped"]);
  assert.deepEqual(asked([6000], { shipID: 5000 }).args, [6000], "one named already is kept");
  const blind = asked([], {});
  assert.deepEqual([blind.args, blind.status], [[], "differs"]);
  assert.match(blind.note, /names the ship/);
  assert.equal(asked([], { shipID: null }).status, "differs");
});

test("two reads the client never makes are still sent, and said to be the web client's own", () => {
  for (const pair of ["dogmaIM.ShipGetInfo", "dogmaIM.ShipOnlineModules"]) {
    const answer = form(pair, []);
    assert.deepEqual([answer.args, answer.status, answer.moniker], [[], "web-only", true], pair);
    assert.ok(answer.note.length > 40, pair);
  }
});

test("the account's calls with no character chosen: what the client sends, and what it never asks", () => {
  const info = retailForm("charUnboundMgr", "GetCharCreationInfo", [], null);
  assert.equal(info.status, "web-only");
  assert.match(info.source, /login\/charcreation\/steps\/bloodLineStep\.py:107$/);
  assert.deepEqual(info.args, []);
  assert.match(info.note, /never asks/);

  // ValidateNameEx(charName, how many names the screen has checked before this one).
  const first = retailForm("charUnboundMgr", "ValidateNameEx", ["A Name"], null);
  assert.equal(first.status, "reshaped");
  assert.match(first.source, /steps\/sections\/chooseNameSection\.py:201$/);
  assert.deepEqual(first.args, ["A Name", 0]);
  assert.equal(first.kwargs, null);
  // A count that is given is the caller's to give, and whatever else came with it goes too.
  assert.deepEqual(retailForm("charUnboundMgr", "ValidateNameEx", ["A Name", 3], null).args, ["A Name", 3]);
  const more = retailForm("charUnboundMgr", "ValidateNameEx", ["A Name", 0, "more"], { a: 1 });
  assert.deepEqual(more.args, ["A Name", 0, "more"]);
  assert.deepEqual(more.kwargs, { a: 1 });

  // The client's ten, with a doll, are not the web client's to send.
  const seven = ["A Name", 2, 1, 8, null, null, 0];
  const made = retailForm("charUnboundMgr", "CreateCharacterWithDoll", seven, null);
  assert.equal(made.status, "differs");
  assert.match(made.source, /ui\/services\/ccSvc\.py:97$/);
  assert.deepEqual(made.args, seven);
  assert.match(made.note, /raceID, bloodlineID, genderID, ancestryID, charInfo, portraitInfo, schoolID, None, qaStarterSystemID/);

  // Asked of the service by name, as the client asks them: none is a moniker's.
  assert.deepEqual([info.moniker, first.moniker, made.moniker], [false, false, false]);
});

test("saved fittings are asked of the owner's manager with the owner, as fittingSvc asks", () => {
  const context = { characterID: 140000001, corporationID: 1000044, allianceID: 99000001 };
  const cases = [
    ["charFittingMgr", 140000001],
    ["corpFittingMgr", 1000044],
    ["allianceFittingMgr", 99000001],
  ];
  for (const [service, owner] of cases) {
    // The BFF leaves the owner to the server; the client names it.
    const filled = retailForm(service, "GetFittings", [], null, context);
    assert.equal(filled.status, "reshaped", service);
    assert.match(filled.source, /environment\/fittingSvc\.py:430$/);
    assert.deepEqual(filled.args, [owner], service);
    assert.equal(filled.kwargs, null);
    assert.equal(filled.moniker, false);
    // An owner that is given is the caller's to give, and the call is then the client's as it stands.
    const given = retailForm(service, "GetFittings", [7, "more"], { a: 1 }, context);
    assert.deepEqual(given.args, [7, "more"]);
    assert.equal(given.status, "same", service);
    assert.equal(retailForm(service, "GetFittings", [null], null, context).status, "reshaped", "an owner of nothing is no owner");
    assert.deepEqual(retailForm(service, "GetFittings", [7], { a: 1 }, context).kwargs, { a: 1 });
  }
  // A pilot in no alliance: the client does not ask, and the BFF's call goes as it was.
  const none = retailForm("allianceFittingMgr", "GetFittings", [], null, { characterID: 140000001, corporationID: 1000044, allianceID: null });
  assert.equal(none.status, "differs");
  assert.deepEqual(none.args, []);
  assert.match(none.note, /no alliance/);
  assert.match(retailForm("corpFittingMgr", "GetFittings", [], null, {}).note, /no corporation/);
  assert.match(retailForm("charFittingMgr", "GetFittings", [], null).note, /no character/);
});

test("removing an offer is asked as the client asks it: nothing but the call, on the agent's object", () => {
  const form = retailForm("agentMgr", "RemoveOfferFromJournal", [], null);
  assert.equal(form.status, "same");
  assert.match(form.source, /ui\/station\/agents\/agents\.py:783$/);
  assert.deepEqual(form.args, []);
  assert.equal(form.kwargs, null);
});

test("a mission's objectives are asked as the client asks them: with nothing, or from the job board's page with ignoreLocateCheck", () => {
  const plain = retailForm("agentMgr", "GetMissionObjectiveInfo", [], null);
  assert.equal(plain.status, "same");
  assert.deepEqual(plain.args, []);
  assert.equal(plain.kwargs, null);
  // The keyword goes out as it was given.
  const page = retailForm("agentMgr", "GetMissionObjectiveInfo", [], { ignoreLocateCheck: true });
  assert.equal(page.status, "same");
  assert.deepEqual(page.args, []);
  assert.deepEqual(page.kwargs, { ignoreLocateCheck: true });
  assert.match(page.note, /ignoreLocateCheck=True \(jobboard\/client\/features\/agent_missions\/job\.py:413\)/);
});

test("the wallet's reads: the balance, the entry types and the divisions as they stand; the transactions with a bool for whose they are", () => {
  for (const [pair, args] of [["account.GetCashBalance", [0]], ["account.GetEntryTypes", []], ["account.GetWalletDivisionsInfo", []], ["officeManager.GetMyCorporationsOffices", []]]) {
    const form = retailForm(...pair.split("."), args, null);
    assert.deepEqual([form.status, form.args, form.kwargs, form.moniker], ["same", args, null, false], pair);
  }
  // GetTransactions(accountingKeyCash, year, month, False): as the client sends it, it is the client's.
  const asClient = retailForm("account", "GetTransactions", [1000, null, null, false], null);
  assert.deepEqual([asClient.status, asClient.args], ["same", [1000, null, null, false]]);
  assert.deepEqual(retailForm("account", "GetTransactions", [1002, 2026, 9, true], null).args, [1002, 2026, 9, true]);
  // Said with a number, or with less, it goes out as the client's and is counted as reshaped.
  for (const [given, sent] of [[[1000, null, null, 0], [1000, null, null, false]], [[1002, 2026, 9, 1], [1002, 2026, 9, true]], [[1000], [1000, null, null, false]]]) {
    const form = retailForm("account", "GetTransactions", given, null);
    assert.deepEqual([form.status, form.args], [given.length === 4 ? "reshaped" : "same", sent], JSON.stringify(given));
  }
  // The corporation's own record is asked with nothing, of the registry's moniker.
  const corporation = retailForm("corpRegistry", "GetCorporation", [], null);
  assert.deepEqual([corporation.status, corporation.args, corporation.moniker], ["same", [], true]);
});

test("dogma's reads: all info as godma first primes it, an item by its ID, and what the client never asks marked as the web client's own", () => {
  // GetAllInfo(primeCharacter, primeShip, primeStructure): three, as given; with fewer, godma's first priming.
  assert.deepEqual([retailForm("dogmaIM", "GetAllInfo", [true, false, null], null).status, retailForm("dogmaIM", "GetAllInfo", [true, false, null], null).args], ["same", [true, false, null]]);
  for (const given of [[], [true], [true, true]]) {
    const form = retailForm("dogmaIM", "GetAllInfo", given, null);
    assert.deepEqual([form.status, form.args, form.moniker], ["reshaped", [true, true, null], true], JSON.stringify(given));
  }
  // An item is always named.
  assert.equal(retailForm("dogmaIM", "ItemGetInfo", [9988400023309], null).status, "same");
  for (const given of [[], [null], [1, 2]]) {
    const form = retailForm("dogmaIM", "ItemGetInfo", given, null);
    assert.deepEqual([form.status, form.args], ["differs", given], JSON.stringify(given));
    assert.match(form.note, /always names the item/);
  }
  assert.equal(retailForm("dogmaIM", "GetTargeters", [], null).status, "same");
  assert.equal(retailForm("dogmaIM", "GetLayerDamageValuesByItems", [[]], null).status, "differs");
  for (const method of ["GetDroneSettingAttributes", "GetCharacterAttributes", "GetRequiredSkillLevels", "QueryAllAttributesForItem", "QueryAttributeValue", "GetLocationInfo"]) {
    const form = retailForm("dogmaIM", method, [], null);
    assert.equal(form.status, "web-only", method);
    assert.ok(form.note.length > 20, method);
  }
  // The one of those the client's tools ask by the service's name is not made on the moniker.
  assert.equal(retailForm("dogmaIM", "GetRequiredSkillLevels", [587], null).moniker, false);
  assert.equal(retailForm("dogmaIM", "QueryAttributeValue", [1, 4], null).moniker, true);
});

test("the agents' table and journal, and the standings, are asked with nothing, as the client asks", () => {
  for (const pair of ["agentMgr.GetAgents", "agentMgr.GetMyJournalDetails", "standingMgr.GetCharStandings", "standingMgr.GetCorpStandings"]) {
    const form = retailForm(...pair.split("."), [], null);
    assert.deepEqual([form.status, form.args, form.kwargs, form.moniker], ["same", [], null, false], pair);
  }
});

test("a standing's detail is asked of an entity and of whose standing it is: two IDs, as the client asks, and anything else is said to differ", () => {
  for (const [method, line] of [["GetStandingTransactions", 178], ["GetStandingCompositions", 283]]) {
    const form = retailForm("standingMgr", method, [500001, 140000005], null);
    assert.deepEqual([form.status, form.args, form.kwargs, form.moniker, form.source], ["same", [500001, 140000005], null, false, `eve/client/script/ui/services/standingsvc.py:${line}`], method);
    // One ID, three, one that is no ID, or a keyword: sent as given, and not counted as the client's.
    for (const [args, kwargs] of [[[500001], null], [[500001, 140000005, 1], null], [[500001, "140000005"], null], [[0, 140000005], null], [[500001, 1.5], null], [[500001, 140000005], { toID: 1 }]]) {
      const odd = retailForm("standingMgr", method, args, kwargs);
      assert.deepEqual([odd.status, odd.args, odd.kwargs], ["differs", args, kwargs], `${method} ${JSON.stringify([args, kwargs])}`);
      assert.match(odd.note, /two IDs/);
    }
  }
});

test("the services the client reaches with sm.ProxySvc are called at its proxy node, and no others", () => {
  // Every sm.ProxySvc('<name>') of the decompiled client. A service among them is asked no other way.
  assert.deepEqual([...PROXY_SERVICES].sort(), ["XmppChatMgr", "alert", "bountyProxy", "calendarProxy", "clientStatLogger", "contractProxy", "corpRecProxy", "eventLog", "fleetProxy", "machoNet", "marketProxy", "pingService", "raffleProxy", "search"]);
  for (const service of PROXY_SERVICES) assert.equal(retailForm(service, "AnyMethod", [], null).proxy, true, service);
  // A service's name ending in Proxy or Mgr says nothing: the calendar has one of each kind.
  for (const service of ["account", "calendarMgr", "contractMgr", "standingMgr", "dogmaIM", "corpRegistry", "ship", "charMgr", "notificationMgr", "someService"]) {
    assert.equal(retailForm(service, "AnyMethod", [], null).proxy, false, service);
  }
  // With an entry of its own or without, shaped or not.
  assert.equal(form("contractProxy.GetLoginInfo", []).proxy, true);
  assert.equal(form("contractProxy.SearchContracts", [], { contractType: 3 }).proxy, true);
  assert.equal(form("account.GetTransactions", [1000, null, null, 0]).proxy, false);
  // No service is both the proxy's and a moniker's.
  for (const service of PROXY_SERVICES) assert.equal(Object.hasOwn(MONIKER_SERVICES, service), false, service);
});

test("a contract search goes out with the client's twenty-six keywords, in the order its call writes them", () => {
  const nothing = Object.fromEntries(CONTRACT_SEARCH_KEYWORDS.map((name) => [name, null]));
  // The order the client's call writes them in (contractsearch.py 1367). The order on the wire comes of it
  // wherever two names want the same slot of the dict, so it is kept as written.
  assert.deepEqual([...CONTRACT_SEARCH_KEYWORDS], [
    "itemTypes", "itemTypeName", "itemCategoryID", "itemGroupID", "contractType", "securityClasses", "locationID", "endLocationID", "issuerID",
    "minPrice", "maxPrice", "minReward", "maxReward", "minCollateral", "maxCollateral", "minVolume", "maxVolume",
    "excludeTrade", "excludeMultiple", "excludeNoBuyout", "availability", "description", "searchHint", "sortBy", "sortDir", "startNum",
  ]);

  // What the page gives, None for the rest, and the sort the panel's list starts on: by date created, oldest first.
  const asked = form("contractProxy.SearchContracts", [], { contractType: 3, availability: 0, startNum: 100 });
  assert.equal(asked.status, "reshaped");
  assert.deepEqual(asked.args, []);
  assert.deepEqual(Object.keys(asked.kwargs), [...CONTRACT_SEARCH_KEYWORDS]);
  assert.deepEqual(asked.kwargs, { ...nothing, contractType: 3, availability: 0, sortBy: 0, sortDir: 0, startNum: 100 });

  // For auctions and exchanges together the panel starts sorted by price; the first page starts at nought.
  const items = form("contractProxy.SearchContracts", [], { contractType: 10 });
  assert.deepEqual([items.kwargs.sortBy, items.kwargs.sortDir, items.kwargs.startNum], [1, 0, 0]);
  // A sort and a filter the page chose are kept.
  const chosen = form("contractProxy.SearchContracts", [], { contractType: 3, sortBy: 8, sortDir: 1, locationID: 10000033, minReward: 5000000 });
  assert.deepEqual([chosen.kwargs.sortBy, chosen.kwargs.sortDir, chosen.kwargs.locationID, chosen.kwargs.minReward], [8, 1, 10000033, 5000000]);
  // None is no sort: the panel's list always has one.
  assert.deepEqual([form("contractProxy.SearchContracts", [], { contractType: 3, sortBy: null, sortDir: null }).kwargs.sortBy, form("contractProxy.SearchContracts", [], { contractType: 3, sortBy: null, sortDir: null }).kwargs.sortDir], [0, 0]);

  // Given whole, in whatever order, it is the client's, and goes out in the call's order.
  const whole = form("contractProxy.SearchContracts", [], Object.fromEntries([...CONTRACT_SEARCH_KEYWORDS].reverse().map((name) => [name, name === "contractType" ? 3 : 0])));
  assert.equal(whole.status, "same");
  assert.deepEqual(Object.keys(whole.kwargs), [...CONTRACT_SEARCH_KEYWORDS]);
  assert.equal(whole.kwargs.contractType, 3);
  // The client's call has no positional arguments, no other keyword, and a sort every time: each of those is put right.
  const everything = { ...nothing, contractType: 3, sortBy: 0, sortDir: 0, startNum: 0 };
  assert.equal(form("contractProxy.SearchContracts", [], everything).status, "same");
  for (const [args, kwargs] of [[[3], everything], [[], { ...everything, somethingElse: 1 }], [[], { ...everything, sortBy: null }], [[], { ...everything, startNum: null }]]) {
    const odd = form("contractProxy.SearchContracts", args, kwargs);
    assert.deepEqual([odd.status, odd.args, odd.kwargs], ["reshaped", [], everything], JSON.stringify([args, Object.keys(kwargs).length]));
    assert.deepEqual(Object.keys(odd.kwargs), [...CONTRACT_SEARCH_KEYWORDS]);
  }

  // On the wire: the order the client's own Python gives these keywords and machoVersion
  // (a service's method, the dict copied, machoVersion added), asked of the client's python27.dll. A recording of
  // the client searching on Tranquility ("Open and Search Contract") has the twenty-seven in this same order.
  assert.deepEqual(keywordOrder(Object.keys(asked.kwargs)), ["itemTypeName", "itemCategoryID", "issuerID", "excludeNoBuyout", "securityClasses", "endLocationID", "availability", "machoVersion", "maxReward", "minVolume", "startNum", "itemTypes", "itemGroupID", "excludeTrade", "maxCollateral", "description", "excludeMultiple", "sortBy", "maxVolume", "contractType", "minPrice", "minReward", "sortDir", "searchHint", "maxPrice", "minCollateral", "locationID"]);
});

test("an owner's contracts are asked for as the My Contracts panel asks: owner, status, type, issued to or by, then a hundred from the first by name", () => {
  // contractPanels.py 419, and a recording of the client on Tranquility: (charID, 0, None, None) with num=100 and
  // startContractID=None, asked of the proxy.
  const asked = form("contractProxy.GetContractListForOwner", [140000002, 0, null, null], { num: 100, startContractID: null });
  assert.deepEqual([asked.status, asked.args, asked.kwargs, asked.proxy, asked.moniker], ["same", [140000002, 0, null, null], { num: 100, startContractID: null }, true, false]);
  assert.match(asked.source, /contractPanels\.py:419$/);
  // The recording's own order on the wire, machoVersion among them.
  assert.deepEqual(keywordOrder(Object.keys(asked.kwargs)), ["num", "machoVersion", "startContractID"]);
  // Asked with less, or otherwise, it goes as the client's: the two filters None, a hundred to the page, from the first.
  for (const [args, kwargs, sent] of [
    [[7, 1], null, [[7, 1, null, null], { num: 100, startContractID: null }]],
    [[7, 1, 3, false], { startContractID: 55 }, [[7, 1, 3, false], { num: 100, startContractID: 55 }]],
    [[7, 4, null, true], { num: 50, startContractID: null }, [[7, 4, null, true], { num: 100, startContractID: null }]],
    [[7, 0, null, null], { num: 100 }, [[7, 0, null, null], { num: 100, startContractID: null }]],
    [[7, 0, null, null], { num: 100, forCorp: true }, [[7, 0, null, null], { num: 100, startContractID: null }]],
    [[7, 0, null, null], { num: 100, startContractID: null, forCorp: true }, [[7, 0, null, null], { num: 100, startContractID: null }]],
    [[7, 0, null, null, 9], { num: 100, startContractID: null }, [[7, 0, null, null], { num: 100, startContractID: null }]],
  ]) {
    const odd = form("contractProxy.GetContractListForOwner", args, kwargs);
    assert.deepEqual([odd.status, odd.args, odd.kwargs], ["reshaped", ...sent], JSON.stringify([args, kwargs]));
    assert.deepEqual(Object.keys(odd.kwargs), ["num", "startContractID"]);
  }
  // The client always names whose and in what state.
  for (const args of [[], [null, 0], [7], [7, null]]) {
    const nobody = form("contractProxy.GetContractListForOwner", args, null);
    assert.deepEqual([nobody.status, /owner and a status/.test(nobody.note)], ["differs", true], JSON.stringify(args));
  }
});

test("which calls the client makes on a Moniker of their own: all of crimewatch's, and the ship's while docked in a station or where a service makes its own", () => {
  // crimewatchSvc.py: every use is eveMoniker.CharGetCrimewatchLocation().Method(...). Recorded on Tranquility at
  // login as two binds of crimewatch, each carrying its call.
  for (const method of ["GetClientStates", "GetMySecurityStatus", "SetSafetyLevel", "SomethingNobodyRead"]) {
    assert.deepEqual([madeAfresh("crimewatch", method), madeAfresh("crimewatch", method, { dockedInStation: true })], [true, true], method);
  }
  // gameui.GetShipAccess (gameui.py 228): a new one each time while the session has a station, and one kept otherwise.
  for (const method of ["Undock", "LeaveShip", "LaunchDrones", "SomethingNobodyRead"]) {
    assert.deepEqual([madeAfresh("ship", method, { dockedInStation: true }), madeAfresh("ship", method, { dockedInStation: false }), madeAfresh("ship", method)], [true, false, false], method);
  }
  // shipConfigSvc.py 51 makes its own wherever the pilot is.
  assert.deepEqual([madeAfresh("ship", "GetShipConfiguration"), madeAfresh("ship", "GetShipConfiguration", { dockedInStation: true })], [true, true]);
  // The ones the client keeps, and services that have no moniker at all.
  for (const [service, method] of [["dogmaIM", "GetAllInfo"], ["corpRegistry", "GetCorporation"], ["skillHandler", "GetImplants"], ["station", "GetGuests"], ["toString", "x"]]) {
    assert.deepEqual([madeAfresh(service, method), madeAfresh(service, method, { dockedInStation: true })], [false, false], service);
  }
  // crimewatch's calls are made on its moniker, and five of them are set beside the client's.
  for (const [method, args, line] of [["GetClientStates", [], 89], ["SetSafetyLevel", [1], 343], ["GetMySecurityStatus", [], 592], ["GetCharacterSecurityStatus", [140000002], 596], ["GetSecurityStatusTransactions", [], 603]]) {
    const call = form(`crimewatch.${method}`, args);
    assert.deepEqual([call.status, call.args, call.kwargs, call.moniker, call.source.endsWith(`crimewatchSvc.py:${line}`)], ["same", args, null, true, true], method);
  }
});

test("the skill handler is asked for by name and its reads are made on what its moniker binds", () => {
  // skillsvc.py 130: session.ConnectToRemoteService('skillMgr2').GetMySkillHandler(), no arguments, kept. Recorded
  // on Tranquility at login with the reads after it on the object its moniker bound.
  const handler = form("skillMgr2.GetMySkillHandler", []);
  assert.deepEqual([handler.status, handler.args, handler.kwargs, handler.moniker, handler.proxy], ["same", [], null, false, false]);
  assert.match(handler.source, /skillsvc\.py:130$/);
  for (const [method, line] of [["GetSkills", 136], ["GetAllSkills", 142], ["GetAttributes", 224], ["GetSkillChangesForISIS", 379], ["GetRespecInfo", 802], ["GetFreeSkillPoints", 852], ["GetBoosters", 962], ["GetImplants", 967], ["GetSkillPoints", 989]]) {
    const read = form(`skillHandler.${method}`, []);
    assert.deepEqual([read.status, read.args, read.kwargs, read.moniker, read.source.endsWith(`skillsvc.py:${line}`)], ["same", [], null, true, true], method);
  }
  // skillsvc.py 363: GetSkillHistory(maxresults=50), always with how many. Asked as the client asks, it is the client's;
  // asked with nothing, or with something that is no count, it is made the client's own default.
  for (const [args, status, sent] of [[[10], "same", [10]], [[50], "same", [50]], [[], "reshaped", [50]], [[0], "reshaped", [50]], [[10, 5], "reshaped", [50]]]) {
    const history = form("skillHandler.GetSkillHistory", args);
    assert.deepEqual([history.status, history.args, history.kwargs, history.moniker, history.source.endsWith("skillsvc.py:363")], [status, sent, null, true, true], JSON.stringify(args));
  }
  // A read of it this registry has not set beside the client's is still made on the moniker.
  const unread = form("skillHandler.GetSkillQueue", []);
  assert.deepEqual([unread.status, unread.moniker], ["unchecked", true]);
});

test("one contract in full is asked for by its ID, as the client's contracts service asks", () => {
  // contracts.py 336, and recorded on Tranquility as GetContract(contractID) with nothing else, asked of the proxy.
  const asked = form("contractProxy.GetContract", [233598633]);
  assert.deepEqual([asked.status, asked.args, asked.kwargs, asked.proxy], ["same", [233598633], null, true]);
  assert.match(asked.source, /contracts.py:336$/);
  for (const args of [[], [null], [0], [233598633, true]]) {
    const odd = form("contractProxy.GetContract", args);
    assert.deepEqual([odd.status, odd.args, /names the one contract/.test(odd.note)], ["differs", args, true], JSON.stringify(args));
  }
});

test("the contracts' own lists, the market's and the calendar's reads, set beside the client's", () => {
  for (const [pair, args] of [
    ["contractProxy.GetLoginInfo", []],
    ["contractProxy.GetMyExpiredContractList", [false]],
    ["contractProxy.GetMyExpiredContractList", [true]],
    ["marketProxy.GetCharOrders", []],
    ["marketProxy.GetMarketOrderHistory", []],
    ["marketProxy.GetCharEscrow", []],
    ["marketProxy.CharGetTransactions", [null]],
    ["calendarProxy.GetEventList", [10, 2026]],
    ["calendarProxy.GetEventDetails", [77, 140000002]],
    ["calendarMgr.GetResponsesForCharacter", []],
    ["calendarMgr.GetResponsesToEvent", [77, 140000002]],
  ]) {
    const answer = form(pair, args);
    assert.deepEqual([answer.status, answer.args, answer.kwargs], ["same", args, null], pair);
    assert.match(answer.source, /\.py:\d+$/, pair);
  }
  // An event is asked about by its ID and its owner's, for an event the pilot opened: never event nought, never without the owner.
  for (const pair of ["calendarProxy.GetEventDetails", "calendarMgr.GetResponsesToEvent"]) {
    for (const given of [[0, null], [77, null], [0, 140000002], [77], []]) {
      const answer = form(pair, given);
      assert.deepEqual([answer.status, answer.args], ["differs", given], `${pair} ${JSON.stringify(given)}`);
      assert.match(answer.note, /an event the pilot has opened/, pair);
    }
  }
  // The client's contracts service has a wrapper for this that nothing calls.
  const current = form("contractProxy.GetMyCurrentContractList", [false, false]);
  assert.equal(current.status, "web-only");
  assert.match(current.note, /GetContractListForOwner/);
  // The market's transactions are asked for with no date: all of them.
  for (const given of [[0], []]) {
    const answer = form("marketProxy.CharGetTransactions", given);
    assert.deepEqual([answer.status, answer.args], ["reshaped", [null]], JSON.stringify(given));
  }
  // A date is not the client's, and is not thrown away either.
  const dated = form("marketProxy.CharGetTransactions", [134359051855730000]);
  assert.deepEqual([dated.status, dated.args], ["differs", [134359051855730000]]);
});

test("the character's own reads name the character, as the client names it", () => {
  const withPilot = (pair, args) => retailForm(...pair.split("."), args, null, { characterID: 140000002 });
  // charMgr.GetPublicInfo3(itemID) and GetCharacterDescription(session.charid): asked with none, the pilot's own.
  for (const pair of ["charMgr.GetPublicInfo3", "charMgr.GetCharacterDescription"]) {
    assert.deepEqual([withPilot(pair, []).status, withPilot(pair, []).args], ["reshaped", [140000002]], pair);
    assert.deepEqual([withPilot(pair, [null]).status, withPilot(pair, [null]).args], ["reshaped", [140000002]], pair);
    // Another character's, as the info window asks, goes as it was given.
    assert.deepEqual([withPilot(pair, [140000001]).status, withPilot(pair, [140000001]).args], ["same", [140000001]], pair);
    // With no pilot known there is nothing to name: sent as it was, and said to differ.
    const blind = retailForm(...pair.split("."), [], null, {});
    assert.deepEqual([blind.status, blind.args], ["differs", []], pair);
    assert.match(blind.note, /names the character/, pair);
  }
  // The row is the client's read of its home station; the other two it never makes.
  assert.equal(form("charMgr.GetHomeStationRow", []).status, "same");
  for (const pair of ["charMgr.GetHomeStation", "charMgr.GetCloneInfo"]) {
    assert.equal(form(pair, []).status, "web-only", pair);
    assert.ok(form(pair, []).note.length > 40, pair);
  }
  assert.match(form("charMgr.GetHomeStation", []).note, /GetHomeStationRow/);
  assert.match(form("charMgr.GetCloneInfo", []).note, /jumpCloneSvc/);
});

test("industry's reads, mail's, the notifications' and the fleet's, set beside the client's", () => {
  for (const [pair, args] of [
    ["charMgr.ListStations", []],
    ["blueprintManager.GetBlueprintDataByOwner", [140000002, null]],
    ["blueprintManager.GetBlueprintDataByOwner", [140000002, 60000004]],
    ["industryManager.GetJobsByOwner", [140000002, true]],
    ["industryManager.GetJobsByOwner", [140000002, false]],
    ["industryManager.GetJobCounts", [140000002]],
    ["facilityManager.GetFacilities", []],
    ["facilityManager.GetMaxActivityModifiers", []],
    ["notificationMgr.GetByGroupID", [3]],
    ["notificationMgr.GetUnprocessed", []],
    ["mailMgr.SyncMail", [null, 0]],
    ["mailMgr.SyncMail", [311, 340]],
    ["fleetObjectHandler.GetInitState", []],
    ["fleetObjectHandler.GetWings", []],
    ["fleetObjectHandler.GetMotd", []],
    ["fleetObjectHandler.GetJoinRequests", []],
    ["fleetObjectHandler.GetFleetComposition", []],
  ]) {
    const answer = form(pair, args);
    assert.deepEqual([answer.status, answer.args, answer.kwargs, answer.proxy], ["same", args, null, false], pair);
    assert.match(answer.source, /\.py:\d+$/, pair);
  }
  // All of a pilot's notifications are asked for with the keyword: GetAllNotifications(fromID=fromID).
  for (const given of [[[0], null], [[77], null], [[], null]]) {
    const answer = form("notificationMgr.GetAllNotifications", ...given);
    assert.deepEqual([answer.status, answer.args, answer.kwargs], ["reshaped", [], { fromID: given[0][0] ?? 0 }], JSON.stringify(given));
  }
  const spelt = form("notificationMgr.GetAllNotifications", [], { fromID: 77 });
  assert.deepEqual([spelt.status, spelt.args, spelt.kwargs], ["same", [], { fromID: 77 }]);
  // Said both ways, the keyword is the one that counts, and nothing goes positionally.
  const both = form("notificationMgr.GetAllNotifications", [5], { fromID: 77 });
  assert.deepEqual([both.status, both.args, both.kwargs], ["reshaped", [], { fromID: 77 }]);
});

test("the ledger's last pass left no pair unread", () => {
  // Every pair of docs/game-port-call-ledger.md's pass (the docked routes, as Test Two) has an entry.
  for (const pair of [
    "blueprintManager.GetBlueprintDataByOwner", "charMgr.GetCharacterDescription", "charMgr.GetCloneInfo", "charMgr.GetHomeStation", "charMgr.GetPublicInfo3", "charMgr.ListStations",
    "facilityManager.GetFacilities", "facilityManager.GetMaxActivityModifiers", "fleetObjectHandler.GetFleetComposition", "fleetObjectHandler.GetInitState", "fleetObjectHandler.GetJoinRequests",
    "fleetObjectHandler.GetMotd", "fleetObjectHandler.GetWings", "industryManager.GetJobCounts", "industryManager.GetJobsByOwner", "mailMgr.SyncMail",
    "notificationMgr.GetAllNotifications", "notificationMgr.GetByGroupID", "notificationMgr.GetUnprocessed",
  ]) assert.ok(Object.hasOwn(RETAIL_CALLS, pair), pair);
});

test("what a walk through the page's panels asks, set beside the client's", () => {
  for (const [pair, args] of [
    ["corpmgr.GetAssetInventory", [98000000, "offices"]],
    ["corpmgr.GetAssetInventoryForLocation", [98000000, 60000004, "offices"]],
    ["corpmgr.SearchAssets", ["offices", null, null, null, null]],
    ["corpmgr.SearchAssets", ["offices", 6, null, 34, 10]],
    ["agentMgr.GetMissionKeywords", [57959]],
    ["agentMgr.GetSolarSystemOfAgent", [3008416]],
    ["map.GetStationInfo", []],
    ["station.GetGuests", []],
    ["stationSvc.GetStationItemBits", []],
    ["structureDirectory.GetStructureInfo", [1030000000001]],
  ]) {
    const answer = form(pair, args);
    assert.deepEqual([answer.status, answer.args, answer.kwargs, answer.proxy], ["same", args, null, false], pair);
    assert.match(answer.source, /\.py:\d+$/, pair);
  }
  // A filter of the search that is not set is None in the client, never nought; what is asked of stays first.
  for (const [given, sent] of [
    [["offices", 0, 0, 0, 0], ["offices", null, null, null, null]],
    [["offices", 0, 25, 0, 3], ["offices", null, 25, null, 3]],
    [["deliveries"], ["deliveries", null, null, null, null]],
    [["offices", undefined, null, -1, "x"], ["offices", null, null, null, null]],
    [[], [null, null, null, null, null]],
    [["", 6, 0, 0, 0], [null, 6, null, null, null]],
    // A filter is a whole number or it is None: text is not one. And the call has five arguments, no more.
    [["offices", "6", 25, 0, 0], ["offices", null, 25, null, null]],
    [["offices", null, null, null, null, 7], ["offices", null, null, null, null]],
  ]) {
    const answer = form("corpmgr.SearchAssets", given);
    assert.deepEqual([answer.status, answer.args], ["reshaped", sent], JSON.stringify(given));
  }
});

test("forming, joining and leaving a fleet, set beside the client's", () => {
  // fleetSvc.GetMyShipTypeID: the type of the ship the pilot is in, which the client knows and sends of itself.
  const aboard = { shipID: 9001, shipTypeID: () => 648 };
  // CreateFleet: self.fleet.Init(self.GetMyShipTypeID(), setupName, adInfoData=adInfoData).
  const init = withContext("fleetObjectHandler.Init", [null, null], null, aboard);
  assert.deepEqual([init.status, init.args, init.kwargs], ["reshaped", [648, null], { adInfoData: null }]);
  assert.match(init.source, /fleetSvc\.py:336$/);
  // A setup and an advert the caller named go as named; the ship's type is the pilot's own whatever the caller said.
  const advert = { type: "dict", entries: [["fleetName", "Ore"]] };
  const named = withContext("fleetObjectHandler.Init", [11, "Mining"], { adInfoData: advert }, aboard);
  assert.deepEqual([named.status, named.args, named.kwargs], ["reshaped", [648, "Mining"], { adInfoData: advert }]);
  assert.deepEqual(withContext("fleetObjectHandler.Init", [], null, aboard).args, [648, null]);
  // OnFleetInvite: GetFleet(fleetID).AcceptInvite(self.GetMyShipTypeID()); UpdateFleetInfo: self.fleet.UpdateMemberInfo(self.GetMyShipTypeID()).
  for (const [pair, line] of [["fleetObjectHandler.AcceptInvite", 1194], ["fleetObjectHandler.UpdateMemberInfo", 1807]]) {
    for (const given of [[null], [], [11], [11, 22]]) {
      const answer = withContext(pair, given, null, aboard);
      assert.deepEqual([answer.status, answer.args, answer.kwargs], ["reshaped", [648], null], `${pair} ${JSON.stringify(given)}`);
      assert.match(answer.source, new RegExp(`fleetSvc\\.py:${line}$`), pair);
    }
  }
  for (const pair of ["fleetObjectHandler.Init", "fleetObjectHandler.AcceptInvite", "fleetObjectHandler.UpdateMemberInfo"]) {
    const rest = pair.endsWith(".Init") ? [null] : [];
    // In no ship the client has no type, and sends None: that is its own call too.
    const afoot = withContext(pair, [11, ...rest], null, { shipID: null, shipTypeID: () => 648 });
    assert.deepEqual([afoot.status, afoot.args], ["reshaped", [null, ...rest]], pair);
    // A ship whose type was not known, or nobody to say: the call goes as it was spelt, and is said to differ.
    for (const context of [{ shipID: 9001, shipTypeID: () => null }, { shipID: 9001 }, {}]) {
      const unknown = withContext(pair, [11, ...rest], null, context);
      assert.deepEqual([unknown.status, unknown.args], ["differs", [11, ...rest]], `${pair} ${JSON.stringify(context)}`);
      assert.match(unknown.note, /type of the ship/, pair);
    }
    // Each is shaped from godma's own word for the ship.
    assert.equal(retailNeeds(...pair.split(".")), "dogma", pair);
  }

  // fleetSvc.LeaveFleet: self.fleet.LeaveFleet() on the fleet's object where it holds one; and where it holds none
  // but the session is in a fleet, sm.RemoteSvc('fleetMgr').ForceLeaveFleet().
  const holding = { holdsFleet: true, fleetID: 654500010000 };
  const without = { holdsFleet: false, fleetID: 654500010000 };
  const leave = withContext("fleetObjectHandler.LeaveFleet", [], null, holding);
  assert.deepEqual([leave.status, leave.args, leave.kwargs], ["same", [], null]);
  assert.match(leave.source, /fleetSvc\.py:369$/);
  // The object is held from the moment CreateFleet answers, in a fleet or not yet.
  assert.equal(withContext("fleetObjectHandler.LeaveFleet", [], null, { holdsFleet: true, fleetID: null }).status, "same");
  for (const context of [without, { holdsFleet: false, fleetID: null }, {}]) {
    const answer = withContext("fleetObjectHandler.LeaveFleet", [], null, context);
    assert.deepEqual([answer.status, answer.args], ["differs", []], JSON.stringify(context));
    assert.match(answer.note, /holds no object/);
  }
  const forced = withContext("fleetMgr.ForceLeaveFleet", [], null, without);
  assert.deepEqual([forced.status, forced.args, forced.kwargs, forced.moniker], ["same", [], null, false]);
  assert.match(forced.source, /fleetSvc\.py:367$/);
  for (const context of [holding, { holdsFleet: false, fleetID: null }, { holdsFleet: false }, { holdsFleet: true, fleetID: null }, { fleetID: 654500010000 }, {}]) {
    const answer = withContext("fleetMgr.ForceLeaveFleet", [], null, context);
    assert.deepEqual([answer.status, answer.args], ["differs", []], JSON.stringify(context));
    assert.match(answer.note, /only where it holds no object for a fleet the session is in/);
  }

  // Declining an invite, and coming back to a fleet the connection was lost in: as the BFF spells them.
  for (const [pair, args, line] of [
    ["fleetObjectHandler.RejectInvite", [], 1198],
    ["fleetObjectHandler.RejectInvite", [true], 1198],
    ["fleetObjectHandler.RejectInvite", [false], 1198],
    ["fleetObjectHandler.Reconnect", [], 1714],
    // Invite(charID, wingID, squadID, role): None for each of the three where the pilot is only asked into the fleet.
    ["fleetObjectHandler.Invite", [140000002, null, null, null], 362],
    ["fleetObjectHandler.Invite", [140000002, 654500040001, 654500050001, 4], 362],
  ]) {
    const answer = withContext(pair, args, null, {});
    assert.deepEqual([answer.status, answer.args, answer.kwargs], ["same", args, null], `${pair} ${JSON.stringify(args)}`);
    assert.match(answer.source, new RegExp(`fleetSvc\\.py:${line}$`), pair);
  }
});

test("a fleet's writes, set beside the client's", () => {
  // As the BFF spells them, each of these is the client's call.
  for (const [pair, args, line] of [
    ["fleetObjectHandler.CreateWing", [], 577],
    ["fleetObjectHandler.CreateSquad", [654500030002], 589],
    ["fleetObjectHandler.MoveMember", [140000002, 654500030002, 654500040002, 4], 518],
    ["fleetObjectHandler.MakeLeader", [140000002], 604],
    ["fleetObjectHandler.SetMotdEx", ["Fly safe"], 1961],
  ]) {
    const answer = withContext(pair, args, null, {});
    assert.deepEqual([answer.status, answer.args, answer.kwargs], ["same", args, null], pair);
    assert.match(answer.source, new RegExp(`fleetSvc\\.py:${line}$`), pair);
  }

  // fleetSvc.KickMember (607): the pilot's own number is not kicked. The client leaves the fleet instead.
  const me = { characterID: 140000001 };
  const kicked = withContext("fleetObjectHandler.KickMember", [140000002], null, me);
  assert.deepEqual([kicked.status, kicked.args], ["same", [140000002]]);
  assert.match(kicked.source, /fleetSvc\.py:611$/);
  for (const own of [140000001, 140000001n, "140000001"]) {
    const self = withContext("fleetObjectHandler.KickMember", [own], null, me);
    assert.deepEqual([self.status, self.args], ["differs", [own]], String(own));
    assert.match(self.note, /LeaveFleet/);
  }
  // Nobody to say who the pilot is: it goes as it was spelt, and is not said to differ.
  assert.equal(withContext("fleetObjectHandler.KickMember", [140000001], null, {}).status, "same");

  // fleetSvc.DisbandFleet (614): unless the pilot is the boss the client refuses it itself, and sends nothing.
  const disbanded = withContext("fleetObjectHandler.DisbandFleet", [], null, { fleetBoss: true });
  assert.deepEqual([disbanded.status, disbanded.args, disbanded.kwargs], ["same", [], null]);
  assert.match(disbanded.source, /fleetSvc\.py:617$/);
  for (const context of [{ fleetBoss: false }, {}, { fleetBoss: null }, { fleetBoss: 1 }]) {
    const refused = withContext("fleetObjectHandler.DisbandFleet", [], null, context);
    assert.equal(refused.status, "differs", JSON.stringify(context));
    assert.match(refused.note, /boss/);
  }

  // fleetSvc.SetOptions (444): a copy of the options the client keeps, with free move as it was asked for, and
  // nothing else of them changed. The copy is a KeyVal, as what the server sent is.
  const kept = { type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: [[Buffer.from("isFreeMove"), false], [Buffer.from("isRegistered"), true], ["autoJoinSquadID", 5n]] } };
  const context = { fleetOptions: () => kept };
  const with_ = (isFreeMove) => ({ ...kept, args: { type: "dict", entries: [[Buffer.from("isFreeMove"), isFreeMove], [Buffer.from("isRegistered"), true], ["autoJoinSquadID", 5n]] } });
  for (const [given, sent] of [[{ isFreeMove: true }, with_(true)], [{ isFreeMove: false }, with_(false)], [{}, with_(false)]]) {
    const answer = withContext("fleetObjectHandler.SetOptions", [given], null, context);
    assert.deepEqual([answer.status, answer.args, answer.kwargs], ["reshaped", [sent], null], JSON.stringify(given));
    assert.match(answer.source, /fleetSvc\.py:449$/);
    // What is kept is not what is changed: it is a copy that is sent.
    assert.equal(kept.args.entries[0][1], false, JSON.stringify(given));
    assert.notEqual(answer.args[0], kept);
  }
  // Anything but free move is not changed this way by the client, and is not sent as if it were.
  for (const given of [{ isRegistered: true }, { isFreeMove: true, autoJoinSquadID: 6 }, { isFreeMove: 1 }, { isFreeMove: null }, null, "free", [true], kept]) {
    const answer = withContext("fleetObjectHandler.SetOptions", [given], null, context);
    assert.deepEqual([answer.status, answer.args], ["differs", [given]], JSON.stringify(given, (key, value) => (typeof value === "bigint" ? String(value) : value)));
    assert.match(answer.note, /free move/);
  }
  // With no options kept there is nothing to copy.
  for (const none of [{}, { fleetOptions: () => null }, { fleetOptions: () => ({ type: "dict", entries: [] }) }]) {
    const answer = withContext("fleetObjectHandler.SetOptions", [{ isFreeMove: true }], null, none);
    assert.deepEqual([answer.status, answer.args], ["differs", [{ isFreeMove: true }]]);
    assert.match(answer.note, /keeps/);
  }
});

test("an attribute's value is the web's alone to ask, and is answered from godma where godma holds the item: so godma is primed for it first", () => {
  const entry = RETAIL_CALLS["dogmaIM.QueryAttributeValue"];
  assert.deepEqual([entry.status, retailNeeds("dogmaIM", "QueryAttributeValue")], ["web-only", "dogma"]);
  assert.match(entry.source, /baseDogmaLocation\.py:1722$/);
  assert.match(entry.note, /answers from what godma holds of an item it was told of, and asks the server only of one it was not/);
  // Sent as it came where it is sent at all.
  const sent = form("dogmaIM.QueryAttributeValue", [9001, 73]);
  assert.deepEqual([sent.args, sent.kwargs, sent.status, sent.moniker], [[9001, 73], null, "web-only", true]);
});

// marketsvc.py 281, CancelOrder(orderID, regionID), and 285, ModifyOrder(order, newPrice): the client has the order's
// ID off the order's own row, where it is a number. The BFF's routes have it as the text the page sent, and on the
// wire text is a string: this server read it as order 0, and no order could be taken down on the game port.

test("an order taken down or repriced is named by its number, as the client has it off the order's own row", () => {
  const cancelled = form("marketProxy.CancelCharOrder", ["1129", 10000002]);
  assert.deepEqual([cancelled.status, cancelled.args, cancelled.kwargs], ["reshaped", [1129, 10000002], null]);
  assert.match(cancelled.source, /marketsvc\.py:282$/);
  // Named by its number already: the client's call as it stands.
  assert.deepEqual([form("marketProxy.CancelCharOrder", [1129, 10000002]).status, form("marketProxy.CancelCharOrder", [1129, 10000002]).args], ["same", [1129, 10000002]]);
  // An ID past what a number holds exactly is a long, to the digit.
  assert.deepEqual(form("marketProxy.CancelCharOrder", ["9007199254740993", 10000002]).args, [9007199254740993n, 10000002]);
  // The BFF's route names no region, and the client names the one the order is in.
  for (const region of [0, null, undefined, "10000002"]) {
    const none = form("marketProxy.CancelCharOrder", region === undefined ? ["1129"] : ["1129", region]);
    assert.deepEqual([none.status, none.args[0]], ["differs", 1129], String(region));
    assert.match(none.note, /region/);
  }
  // What is no order's ID is not made into one.
  for (const given of ["", "12a", "-5", " 7", null, 1.5, {}]) {
    const answer = form("marketProxy.CancelCharOrder", [given, 10000002]);
    assert.deepEqual([answer.status, answer.args], ["differs", [given, 10000002]], JSON.stringify(given));
    assert.match(answer.note, /order/);
  }
});

test("an order repriced goes out with the order's number first and the rest as the client's nine, and says so where the route made one up", () => {
  const nine = (orderID, issueDate = 134360504783110000n) => [orderID, 5.5, true, 60003760, 30000142, 5, -1, 1, issueDate];
  const repriced = form("marketProxy.ModifyCharOrder", nine("1129"));
  assert.deepEqual([repriced.status, repriced.args], ["reshaped", nine(1129)]);
  assert.match(repriced.source, /marketsvc\.py:288$/);
  assert.deepEqual([form("marketProxy.ModifyCharOrder", nine(1129)).status, form("marketProxy.ModifyCharOrder", nine(1129)).args], ["same", nine(1129)]);
  // The BFF's route has no date of issue to send, and sends nought: the client sends the order's own.
  const dateless = form("marketProxy.ModifyCharOrder", nine("1129", 0));
  assert.deepEqual([dateless.status, dateless.args], ["differs", nine(1129, 0)]);
  assert.match(dateless.note, /issue/);
  // Fewer than the nine, more than the nine, or no order's ID: sent as it came, and not the client's call.
  const short = form("marketProxy.ModifyCharOrder", ["1129", 5.5]);
  assert.deepEqual([short.status, short.args], ["differs", [1129, 5.5]]);
  assert.match(short.note, /nine/);
  const long = form("marketProxy.ModifyCharOrder", [...nine(1129), 7]);
  assert.deepEqual([long.status, long.args], ["differs", [...nine(1129), 7]]);
  assert.match(long.note, /nine/);
  assert.deepEqual([form("marketProxy.ModifyCharOrder", nine("x")).status, form("marketProxy.ModifyCharOrder", nine("x")).args], ["differs", nine("x")]);
});

// quote.py 302, CancelOrder(order.orderID, order.regionID), and marketsvc.py 285, ModifyOrder(order, newPrice): both
// off the row the client has of the order, in its list of the pilot's own orders. The row below has the columns and
// the kinds of value this server's list has off a game-port session; the numbers are made up.

const ORDER_ROW = Object.freeze({ orderID: 77n, typeID: 34, charID: 140000002, regionID: 10000002, stationID: 60003760, range: -1, bid: 1, price: 0.01, volEntered: 1, volRemaining: 1, issueDate: 134360517603990000n, minVolume: 1, contraband: 0, duration: 1, isCorp: 0, solarSystemID: 30000142, escrow: 0.01 });
/** A session whose kept list of the pilot's orders has that one order. */
const ordersHeld = (row = ORDER_ROW) => ({ ownOrder: (orderID) => (BigInt(orderID) === 77n ? row : null) });
const without = (name) => Object.fromEntries(Object.entries(ORDER_ROW).filter(([column]) => column !== name));

test("an order taken down goes out as the client's: the ID and the region off the order's own row", () => {
  const cancelled = withContext("marketProxy.CancelCharOrder", ["77", 0], null, ordersHeld());
  assert.deepEqual([cancelled.status, cancelled.args, cancelled.kwargs], ["reshaped", [77n, 10000002], null]);
  assert.match(cancelled.source, /marketsvc\.py:282$/);
  // Whatever region the caller named, the client's is the row's.
  assert.deepEqual(withContext("marketProxy.CancelCharOrder", [77, 10000033], null, ordersHeld()).args, [77n, 10000002]);
  // Sent as the client sends it already: the same call.
  assert.deepEqual([withContext("marketProxy.CancelCharOrder", [77n, 10000002], null, ordersHeld()).status, withContext("marketProxy.CancelCharOrder", [77n, 10000002], null, ordersHeld()).args], ["same", [77n, 10000002]]);
  // An order the kept list has not, or a row that names no region: as the call came, with the ID a number, and noted.
  for (const context of [ordersHeld(without("regionID")), { ownOrder: () => null }, {}, undefined]) {
    const unheld = withContext("marketProxy.CancelCharOrder", ["77", 0], null, context);
    assert.deepEqual([unheld.status, unheld.args], ["differs", [77, 0]]);
    assert.match(unheld.note, /region/);
    assert.deepEqual([withContext("marketProxy.CancelCharOrder", ["77", 10000002], null, context).status, withContext("marketProxy.CancelCharOrder", ["77", 10000002], null, context).args], ["reshaped", [77, 10000002]]);
  }
  // More than the client's two is not the client's call as it stands.
  assert.deepEqual([withContext("marketProxy.CancelCharOrder", [77n, 10000002, 5], null, ordersHeld()).status, withContext("marketProxy.CancelCharOrder", [77n, 10000002, 5], null, ordersHeld()).args], ["reshaped", [77n, 10000002]]);
  // An order held under another ID is not this one's row.
  assert.deepEqual(withContext("marketProxy.CancelCharOrder", ["78", 0], null, ordersHeld()).args, [78, 0]);
  // Both calls want the pilot's orders read first, where the session holds none.
  assert.deepEqual([retailNeeds("marketProxy", "CancelCharOrder"), retailNeeds("marketProxy", "ModifyCharOrder")], ["orders", "orders"]);
});

test("an order repriced goes out as the client's nine: the new price, and the rest off the order's own row", () => {
  const clients = [77n, 0.02, 1, 60003760, 30000142, 0.01, -1, 1, 134360517603990000n];
  // The BFF's route has the ID as text, a bool for the side, where the pilot is for the station, and nought for the date.
  const repriced = withContext("marketProxy.ModifyCharOrder", ["77", 0.02, true, 60000004, 30000001, 5, 32767, 9, 0], null, ordersHeld());
  assert.deepEqual([repriced.status, repriced.args, repriced.kwargs], ["reshaped", clients, null]);
  assert.match(repriced.source, /marketsvc\.py:288$/);
  // The order and a price are enough: the client's other seven are the row's.
  assert.deepEqual(withContext("marketProxy.ModifyCharOrder", ["77", 0.02], null, ordersHeld()).args, clients);
  assert.deepEqual([withContext("marketProxy.ModifyCharOrder", clients, null, ordersHeld()).status, withContext("marketProxy.ModifyCharOrder", clients, null, ordersHeld()).args], ["same", clients]);
  // No new price is no reprice, whatever the row has.
  const priceless = withContext("marketProxy.ModifyCharOrder", ["77"], null, ordersHeld());
  assert.deepEqual([priceless.status, priceless.args], ["differs", [77]]);
  // A row short of one of the seven is not made up for: the call as it came.
  for (const name of ["bid", "stationID", "solarSystemID", "price", "range", "volRemaining", "issueDate"]) {
    const short = withContext("marketProxy.ModifyCharOrder", ["77", 0.02, true, 60000004, 30000001, 5, 32767, 9, 0], null, ordersHeld(without(name)));
    assert.deepEqual([short.status, short.args], ["differs", [77, 0.02, true, 60000004, 30000001, 5, 32767, 9, 0]], name);
  }
  for (const context of [{ ownOrder: () => null }, {}, undefined]) {
    assert.equal(withContext("marketProxy.ModifyCharOrder", ["77", 0.02, true, 60000004, 30000001, 5, 32767, 9, 0], null, context).status, "differs");
  }
});

test("the market's other three of the walk: a type's book as the client asks it, its history asked in one half, and a buy order without the fee the client names", () => {
  const book = form("marketProxy.GetOrders", [34]);
  assert.deepEqual([book.status, book.args], ["same", [34]]);
  assert.match(book.source, /marketsvc\.py:734$/);
  // marketsvc.py 338, 339: a type's history in its two halves, each with the type.
  for (const [method, line] of [["GetOldPriceHistory", 338], ["GetNewPriceHistory", 339]]) {
    const half = form(`marketProxy.${method}`, [34]);
    assert.deepEqual([half.status, half.args], ["same", [34]], method);
    assert.match(half.source, new RegExp(`marketsvc\\.py:${line}$`), method);
  }
  // marketsvc.py 266: nine, the last the broker's fee the client's window showed. The BFF's route has none to name.
  const nine = [60003760, 34, 0.01, 1, -1, 1, 1, false];
  const feeless = form("marketProxy.PlaceBuyOrder", [...nine, null]);
  assert.deepEqual([feeless.status, feeless.args], ["differs", [...nine, null]]);
  assert.match(feeless.note, /fee/);
  assert.match(feeless.source, /marketsvc\.py:266$/);
  assert.deepEqual([form("marketProxy.PlaceBuyOrder", [...nine, 0.03]).status, form("marketProxy.PlaceBuyOrder", [...nine, 0.03]).args], ["same", [...nine, 0.03]]);
  // Not the client's nine at all.
  assert.equal(form("marketProxy.PlaceBuyOrder", nine).status, "differs");
  assert.equal(form("marketProxy.PlaceBuyOrder", [...nine, 0.03, 1]).status, "differs");
});

// sellMulti.py 462, SellMulti(self.sellItemList, useCorp, duration, expectedBrokerFeePercentage), each item made at
// 501: KeyVal(stationID=..., typeID=..., itemID=..., price=..., quantity=..., officeID=..., delta=...,
// rawBrokerFeePercentage=...). The BFF's route gave an item as a plain object, which cannot be put on the wire at
// all: nothing could be sold on the game port. The orders of the fields below are the client's own Python's
// (test/fixtures/py27Oracle.json, "constructed").

const saleKeyVal = (entries) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
const ROUTES_ITEM = { itemID: 9988400109051, typeID: 34, stationID: 60003760, price: 987654.32, quantity: 1 };
const SIX = saleKeyVal([["itemID", 9988400109051], ["typeID", 34], ["price", 987654.32], ["stationID", 60003760], ["officeID", null], ["quantity", 1]]);
const WHOLE_ITEM = { ...ROUTES_ITEM, officeID: null, delta: -0.25, rawBrokerFeePercentage: 0.03 };
const EIGHT = saleKeyVal([["itemID", 9988400109051], ["typeID", 34], ["rawBrokerFeePercentage", 0.03], ["price", 987654.32], ["officeID", null], ["stationID", 60003760], ["delta", -0.25], ["quantity", 1]]);

test("a sale's items go out as the client's: a list of util.KeyVal, each with its fields in the order its Python keeps them", () => {
  // The BFF's route: one item with the five it knows, and no fee. Sent so that the server can read it, and noted for what it lacks.
  const routes = form("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null]);
  assert.deepEqual([routes.status, routes.args, routes.kwargs], ["differs", [{ type: "list", items: [SIX] }, false, 1, null], null]);
  assert.match(routes.note, /delta/);
  assert.match(routes.note, /rawBrokerFeePercentage/);
  assert.match(routes.source, /marketsvc\.py:276$/);
  // The item in whole, and the fee named: the client's call, made from what a route gave.
  const whole = form("marketProxy.PlaceMultiSellOrder", [[WHOLE_ITEM, WHOLE_ITEM], false, 1, 0.03]);
  assert.deepEqual([whole.status, whole.args], ["reshaped", [{ type: "list", items: [EIGHT, EIGHT] }, false, 1, 0.03]]);
  // As the client sends it already.
  const clients = [{ type: "list", items: [EIGHT] }, false, 1, 0.03];
  assert.deepEqual([form("marketProxy.PlaceMultiSellOrder", clients).status, form("marketProxy.PlaceMultiSellOrder", clients).args], ["same", clients]);
  // The window's own numbers: a station and a type as whole numbers, a price to the hundredth, an item in an office named with the office.
  const rounded = form("marketProxy.PlaceMultiSellOrder", [[{ ...WHOLE_ITEM, price: 1.239, officeID: 77 }], false, 1, 0.03]).args[0].items[0].args.entries;
  assert.deepEqual([rounded.find(([name]) => name === "price")[1], rounded.find(([name]) => name === "officeID")[1]], [1.24, 77]);
});

test("a sale at once names no fee, as the client names none; an order that stands with no fee named is not the client's", () => {
  const atOnce = form("marketProxy.PlaceMultiSellOrder", [[WHOLE_ITEM], false, 0, null]);
  assert.deepEqual([atOnce.status, atOnce.args], ["reshaped", [{ type: "list", items: [EIGHT] }, false, 0, null]]);
  // An order that stands names the rate its first item has (sellMulti.py 444), where the call named none.
  const standing = form("marketProxy.PlaceMultiSellOrder", [[WHOLE_ITEM, { ...WHOLE_ITEM, rawBrokerFeePercentage: 0.5 }], false, 3, null]);
  assert.deepEqual([standing.status, standing.args[3]], ["reshaped", 0.03]);
  // An item whose rate is no number has none to name: the call is not the client's.
  const rateless = saleKeyVal(EIGHT.args.entries.map(([name, value]) => [name, name === "rawBrokerFeePercentage" ? null : value]));
  const unnamed = form("marketProxy.PlaceMultiSellOrder", [{ type: "list", items: [rateless] }, false, 3, null]);
  assert.deepEqual([unnamed.status, unnamed.args], ["differs", [{ type: "list", items: [rateless] }, false, 3, null]]);
  assert.match(unnamed.note, /fee/);
});

test("what is no list of a sale's items goes out as it came, and is not the client's call", () => {
  for (const given of [
    [[], false, 1, null],
    [["x"], false, 1, null],
    [[{ typeID: 34, stationID: 60003760, price: 5, quantity: 1 }], false, 1, null],
    [[{ ...ROUTES_ITEM, quantity: 0 }], false, 1, null],
    [[{ ...ROUTES_ITEM, price: "dear" }], false, 1, null],
    [[{ ...ROUTES_ITEM, stationID: 1.5 }], false, 1, null],
    [[ROUTES_ITEM, null], false, 1, null],
    [ROUTES_ITEM, false, 1, null],
    [[ROUTES_ITEM], false, 1],
    [[ROUTES_ITEM], false, 1, null, 5],
    [],
  ]) {
    const answer = form("marketProxy.PlaceMultiSellOrder", given);
    assert.deepEqual([answer.status, answer.args], ["differs", given], JSON.stringify(given));
    assert.match(answer.note, /four/);
  }
});

// The broker's fee rate (src/gamePort/brokerFee.js): a buy order's ninth argument, a sale's fourth for an order that
// stands, and each sale item's rawBrokerFeePercentage. The BFF's routes name none. Where the transport can work it
// out for the station (context.brokersFee), the registry names it as the client does.

const feeKnown = (rate = 0.0251) => ({ brokersFee: (stationID) => (stationID === 60003760 ? rate : null) });

test("a buy order with no fee named goes out with the rate the client would name, where it can be worked out for the station", () => {
  const nine = [60003760, 34, 0.01, 1, -1, 1, 1, false];
  const named = withContext("marketProxy.PlaceBuyOrder", [...nine, null], null, feeKnown());
  assert.deepEqual([named.status, named.args], ["reshaped", [...nine, 0.0251]]);
  // A rate named already is not worked out again.
  assert.deepEqual([withContext("marketProxy.PlaceBuyOrder", [...nine, 0.03], null, feeKnown()).status, withContext("marketProxy.PlaceBuyOrder", [...nine, 0.03], null, feeKnown()).args], ["same", [...nine, 0.03]]);
  // A station it cannot be worked out for, or nothing to work it out with: as the call came, and noted.
  for (const context of [feeKnown(null), { brokersFee: () => null }, {}, undefined]) {
    const unnamed = withContext("marketProxy.PlaceBuyOrder", [60000004, ...nine.slice(1), null], null, context);
    assert.deepEqual([unnamed.status, unnamed.args], ["differs", [60000004, ...nine.slice(1), null]]);
    assert.match(unnamed.note, /fee/);
  }
  // A rate of nought is a rate.
  assert.deepEqual(withContext("marketProxy.PlaceBuyOrder", [...nine, null], null, feeKnown(0)).args[8], 0);
  assert.equal(retailNeeds("marketProxy", "PlaceBuyOrder"), "fee");
});

test("a sale's items are given the fee rate of their station, and an order that stands names the first item's", () => {
  const withRate = (rate) => saleKeyVal([["itemID", 9988400109051], ["typeID", 34], ["rawBrokerFeePercentage", rate], ["price", 987654.32], ["stationID", 60003760], ["officeID", null], ["quantity", 1]]);
  // The route's item, with the rate worked out: seven fields, in the order the client's Python keeps those seven.
  const standing = withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null], null, feeKnown());
  assert.deepEqual(standing.args, [{ type: "list", items: [withRate(0.0251)] }, false, 1, 0.0251]);
  // Still short of the client's eight by the one its window works out from the type's average price.
  assert.equal(standing.status, "differs");
  assert.match(standing.note, /delta/);
  assert.doesNotMatch(standing.note, /rawBrokerFeePercentage/);
  // A sale at once: the items have the rate, and the call names none, as the client names none.
  assert.deepEqual(withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 0, null], null, feeKnown()).args, [{ type: "list", items: [withRate(0.0251)] }, false, 0, null]);
  // With the delta given too, it is the client's call, the fee named for it.
  const whole = withContext("marketProxy.PlaceMultiSellOrder", [[{ ...ROUTES_ITEM, delta: -0.25 }], false, 1, null], null, feeKnown(0.03));
  assert.deepEqual([whole.status, whole.args], ["reshaped", [{ type: "list", items: [EIGHT] }, false, 1, 0.03]]);
  // A rate given with an item, or with the call, is not worked out again.
  assert.deepEqual(withContext("marketProxy.PlaceMultiSellOrder", [[WHOLE_ITEM], false, 1, 0.5], null, feeKnown(0.0251)).args, [{ type: "list", items: [EIGHT] }, false, 1, 0.5]);
  // Where it cannot be worked out, the item and the call go without, as before.
  const without = withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null], null, feeKnown(null));
  assert.deepEqual([without.status, without.args], ["differs", [{ type: "list", items: [SIX] }, false, 1, null]]);
  assert.match(without.note, /rawBrokerFeePercentage/);
});

// A sale item's delta (buySellItemContainerBase.py 57): how far its price is from the type's average over a week,
// which the entry asks the market for when it is made. Where whoever shapes the call has the average
// (context.averagePrice), the item is the client's eight and the sale the client's call.

const averageKnown = (average = 790123.456) => ({ ...feeKnown(0.03), averagePrice: (typeID) => (typeID === 34 ? average : null) });

test("a sale's item is given how far its price is from the type's average, and with the fee is the client's eight", () => {
  const delta = (987654.32 - 790123.456) / 790123.456;
  const whole = withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null], null, averageKnown());
  assert.equal(whole.status, "reshaped");
  assert.deepEqual(whole.args, [{ type: "list", items: [saleKeyVal([["itemID", 9988400109051], ["typeID", 34], ["rawBrokerFeePercentage", 0.03], ["price", 987654.32], ["officeID", null], ["stationID", 60003760], ["delta", delta], ["quantity", 1]])] }, false, 1, 0.03]);
  // A price at the average is no distance from it, and that is a delta.
  assert.equal(withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null], null, averageKnown(987654.32)).args[0].items[0].args.entries.find(([name]) => name === "delta")[1], 0);
  // A delta given with the item is not worked out again.
  assert.equal(withContext("marketProxy.PlaceMultiSellOrder", [[{ ...ROUTES_ITEM, delta: -0.25 }], false, 1, null], null, averageKnown()).args[0].items[0].args.entries.find(([name]) => name === "delta")[1], -0.25);
  // No average to be had, or an average of nothing: no delta is made up, and the sale is noted for it.
  for (const context of [averageKnown(null), averageKnown(0), { ...feeKnown(0.03), averagePrice: () => "100" }, feeKnown(0.03)]) {
    const short = withContext("marketProxy.PlaceMultiSellOrder", [[ROUTES_ITEM], false, 1, null], null, context);
    assert.equal(short.status, "differs");
    assert.match(short.note, /delta/);
    assert.equal(short.args[0].items[0].args.entries.some(([name]) => name === "delta"), false);
  }
  // Another type's average is not this one's.
  assert.equal(withContext("marketProxy.PlaceMultiSellOrder", [[{ ...ROUTES_ITEM, typeID: 35 }], false, 1, null], null, averageKnown()).status, "differs");
  assert.equal(retailNeeds("marketProxy", "PlaceMultiSellOrder"), "sale");
});

// fittingSvc.LoadFitting (554): shipInv.FitFitting(activeShipID, shipTypeID, itemsToFit, session.stationid or
// session.structureid, fittingObjKeyVal, cargoItemsByType, fitRigs). itemsToFit is a defaultdict(set) of the
// hangar's items by type, the fitting a util.KeyVal of six dicts (shipfitting/fitting.py 119). The BFF's route gave
// plain objects for the three, which cannot be put on the wire: no saved fitting could be applied on the game port.
// The orders below are the client's own Python's, asked for these very names and numbers.

const fitToken = (value) => ({ type: "token", value });
const fitSet = (...ids) => ({ type: "objectex1", header: [fitToken("__builtin__.set"), [{ type: "list", items: ids }]], list: [], dict: [] });
const fitItems = (...pairs) => ({ type: "objectex1", header: [fitToken("collections.defaultdict"), [fitToken("__builtin__.set")]], list: [], dict: pairs });
const fitDict = (...entries) => ({ type: "dict", entries });
const fitKeyVal = ({ modules = fitDict(), drones = fitDict(), charges = fitDict(), fighters = fitDict(), ice = fitDict(), implants = fitDict() } = {}) =>
  saleKeyVal([["fightersByTypeID", fighters], ["dronesByType", drones], ["modulesByFlag", modules], ["iceByType", ice], ["chargesByType", charges], ["implantsByTypeID", implants]]);
const FIT_SHIP = 9988400103291;
const inThatShip = { shipID: FIT_SHIP, shipTypeID: () => 588 };

test("a saved fitting goes out as the client applies it: the ship's type, the items a defaultdict of sets, the fitting a KeyVal of six dicts", () => {
  // The BFF's route: no ship type, and a plain object for the items, for the modules by slot and for the cargo.
  const routes = [FIT_SHIP, null, { 483: [9001], 92: [9988400109051, 9988400109052, 9988400109060, 9001] }, 60003760, { 27: 483, 28: 484, 11: 3, 19: 4, 92: 5, 125: 6, 12: 7 }, { 34: 100 }, false];
  const fitted = withContext("invbroker.FitFitting", routes, null, inThatShip);
  assert.equal(fitted.status, "reshaped");
  assert.deepEqual(fitted.args, [
    FIT_SHIP,
    588,
    // By type in the order a dict has them, each type's items in the order a set has them.
    fitItems([483, fitSet(9001)], [92, fitSet(9988400109051, 9988400109052, 9001, 9988400109060)]),
    60003760,
    fitKeyVal({ modules: fitDict([92, 5], [11, 3], [12, 7], [19, 4], [27, 483], [28, 484], [125, 6]) }),
    fitDict([34, 100]),
    false,
  ]);
  assert.match(fitted.source, /fittingSvc\.py:618$/);
  // A fitting given by its parts, and a ship's type named: both as given.
  const whole = withContext("invbroker.FitFitting", [FIT_SHIP, 603, {}, 60003760, { modulesByFlag: { 27: 483 }, dronesByType: { 2488: 5 }, chargesByType: { 215: 200 } }, {}, 1], null, inThatShip);
  assert.deepEqual(whole.args, [FIT_SHIP, 603, fitItems(), 60003760, fitKeyVal({ modules: fitDict([27, 483]), drones: fitDict([2488, 5]), charges: fitDict([215, 200]) }), fitDict(), true]);
  // The ship's type is godma's to say: it is primed first.
  assert.equal(retailNeeds("invbroker", "FitFitting"), "dogma");
  // The client's own call is the client's call.
  const clients = [FIT_SHIP, 588, fitItems([483, fitSet(9001)]), 60003760, fitKeyVal({ modules: fitDict([27, 483]) }), fitDict(), true];
  assert.deepEqual([withContext("invbroker.FitFitting", clients, null, inThatShip).status, withContext("invbroker.FitFitting", clients, null, inThatShip).args], ["same", clients]);
});

test("a fitting for a ship whose type is not known, or that is no seven arguments, goes out noted", () => {
  const routes = (shipID) => [shipID, null, { 483: [9001] }, 60003760, { 27: 483 }, {}, false];
  // Another ship than the one the pilot is in: its type is not godma's to say.
  const other = withContext("invbroker.FitFitting", routes(FIT_SHIP + 1), null, inThatShip);
  assert.deepEqual([other.status, other.args[1], other.args[2]], ["differs", null, fitItems([483, fitSet(9001)])]);
  assert.match(other.note, /type/);
  for (const context of [{ shipID: FIT_SHIP, shipTypeID: () => null }, { shipID: FIT_SHIP }, {}, undefined]) assert.equal(withContext("invbroker.FitFitting", routes(FIT_SHIP), null, context).status, "differs");
  // Not the client's seven: as it came.
  for (const given of [[FIT_SHIP, null, {}, 60003760, {}, {}], [FIT_SHIP, null, {}, 60003760, {}, {}, false, 1], []]) {
    const answer = withContext("invbroker.FitFitting", given, null, inThatShip);
    assert.deepEqual([answer.status, answer.args], ["differs", given], JSON.stringify(given));
    assert.match(answer.note, /seven/);
  }
  // What is no type, no item and no slot is left out of what is made.
  const odd = withContext("invbroker.FitFitting", [FIT_SHIP, null, { x: [9001], 483: ["y", 9002, 0], 484: "z", 485: [] }, 60003760, { a: 483, 27: "b", 28: 484 }, { 34: 0, q: 5, 35: 2 }, false], null, inThatShip);
  assert.deepEqual([odd.args[2], odd.args[4], odd.args[5]], [fitItems([483, fitSet(9002)]), fitKeyVal({ modules: fitDict([28, 484]) }), fitDict([35, 2])]);
});

// clientPlanet.py 412 and 448: remoteHandler.UserLaunchCommodities(commandPinID, commoditiesToLaunch) and
// remoteHandler.UserTransferCommodities(path, commodities), on the planet's own object. The commodities are a dict
// of quantities by type and the path a list of pins. The BFF's routes gave the commodities as a plain object,
// which cannot be put on the wire: nothing could be launched from a colony, or moved in one, on the game port.

test("a colony's commodities are launched and moved as dicts of quantities by type, and a path is a list of pins", () => {
  const launched = form("planetMgr.UserLaunchCommodities", [1054656331534, { 2268: 100, 2073: 5, 9848: 3 }]);
  // In the order a dict has them, which for these three is not the order of their numbers.
  assert.deepEqual([launched.status, launched.args, launched.kwargs], ["reshaped", [1054656331534, fitDict([9848, 3], [2073, 5], [2268, 100])], null]);
  assert.match(launched.source, /clientPlanet\.py:412$/);
  const moved = form("planetMgr.UserTransferCommodities", [[1054656331535, 1054656331534], { 2268: 50 }]);
  assert.deepEqual([moved.status, moved.args], ["reshaped", [{ type: "list", items: [1054656331535, 1054656331534] }, fitDict([2268, 50])]]);
  assert.match(moved.source, /clientPlanet\.py:448$/);
  // As the client sends them already: the same calls.
  const clientsLaunch = [1054656331534, fitDict([2268, 100])];
  assert.deepEqual([form("planetMgr.UserLaunchCommodities", clientsLaunch).status, form("planetMgr.UserLaunchCommodities", clientsLaunch).args], ["same", clientsLaunch]);
  const clientsMove = [{ type: "list", items: [1054656331535, 1054656331534] }, fitDict([2268, 50])];
  assert.deepEqual([form("planetMgr.UserTransferCommodities", clientsMove).status, form("planetMgr.UserTransferCommodities", clientsMove).args], ["same", clientsMove]);
});

test("what is no quantity of a type is left out of a colony's commodities, and a call that is not the client's two arguments goes as it came", () => {
  assert.deepEqual(form("planetMgr.UserLaunchCommodities", [7, { 2268: 0, x: 5, 2073: "y", 9848: 3 }]).args, [7, fitDict([9848, 3])]);
  for (const [pair, given] of [["planetMgr.UserLaunchCommodities", [7]], ["planetMgr.UserLaunchCommodities", [7, {}, 1]], ["planetMgr.UserTransferCommodities", [[1, 2]]], ["planetMgr.UserTransferCommodities", []]]) {
    const answer = form(pair, given);
    assert.deepEqual([answer.status, answer.args], ["differs", given], `${pair} ${JSON.stringify(given)}`);
    assert.match(answer.note, /two/);
  }
  // The client's own dict with a path that came as an array: the path is made a list.
  const halfway = form("planetMgr.UserTransferCommodities", [[1054656331535, 1054656331534], fitDict([2268, 50])]);
  assert.deepEqual([halfway.status, halfway.args], ["reshaped", [{ type: "list", items: [1054656331535, 1054656331534] }, fitDict([2268, 50])]]);
  // A path that is no list of pins is sent as it came, with the commodities made a dict all the same.
  assert.deepEqual(form("planetMgr.UserTransferCommodities", ["x", { 2268: 5 }]).args, ["x", fitDict([2268, 5])]);
});

// planetSvc.py 67 and planetUISvc.py 172: sm.RemoteSvc('planetMgr').GetPlanetsForChar() and
// .GetMyLaunchesDetails(), each by name and with nothing. Tranquility's recordings have both so. The page's
// Planetary Industry window and its haul read both, and the ledger had them unchecked.

test("a pilot's colonies and launches are asked of the planet manager by name, with nothing", () => {
  for (const [method, file, line] of [["GetPlanetsForChar", "planetSvc", 67], ["GetMyLaunchesDetails", "planetUISvc", 172]]) {
    const asked = form(`planetMgr.${method}`, []);
    assert.deepEqual([asked.status, asked.args, asked.kwargs], ["same", [], null], method);
    assert.match(asked.source, new RegExp(`${file}\\.py:${line}$`), method);
    assert.match(asked.note, /Tranquility/, method);
    // Something sent with it is not the client's call.
    const withMore = form(`planetMgr.${method}`, [140000002]);
    assert.deepEqual([withMore.status, withMore.args], ["differs", [140000002]], method);
    assert.match(withMore.note, /nothing/, method);
  }
  // journal.py 464: a launch taken off the list, by its ID. No recording has one.
  const removed = form("planetMgr.DeleteLaunch", [1000001]);
  assert.deepEqual([removed.status, removed.args, removed.kwargs], ["same", [1000001], null]);
  assert.match(removed.source, /journal.py:464$/);
});

// importExportUI.py 383 and 549, and eveMoniker.py 219. At a customs office the client asks the system's orbital
// registry for the office's tax rate, on a Moniker it makes for that call, and sends goods up or down with
// ImportExportWithPlanet on the office's own inventory, naming the rate it was told. Tranquility's recording of an
// export has both: MachoBindObject(30034971, ('GetTaxRate', (officeID,), {})) three times over, and
// ImportExportWithPlanet(pinID, {}, {2398: 100.0}, 0.20000000149011612) on the inventory GetInventoryFromId answered.

test("a station's offices are asked of the office manager's Moniker for where the session is docked, kept, and not at all in space", () => {
  // officeManager.py: station (50) is Moniker('officeManager', session.stationid or session.structureid), kept
  // while the session is there; corp_offices (41) is asked of the service by name. Tranquility's recordings of an
  // office rented and of one given up have GetCorporationsWithOffices and GetEmptyOfficeCount on the bound
  // object, each with an empty tuple.
  const DOCKED = { dockedAt: 60003760 };
  for (const [method, line] of [["GetCorporationsWithOffices", 34], ["GetEmptyOfficeCount", 136]]) {
    const asked = retailForm("officeManager", method, [], null, DOCKED);
    assert.deepEqual([asked.status, asked.args, asked.kwargs, asked.moniker, asked.source], ["same", [], null, true, `eve/client/script/ui/services/corporation/officeManager.py:${line}`], method);
    // The client sends nothing with either: no argument, and no keyword.
    assert.deepEqual([retailForm("officeManager", method, [60003760], null, DOCKED).status, retailForm("officeManager", method, [60003760], null, DOCKED).moniker], ["differs", true], method);
    const keyed = retailForm("officeManager", method, [], { all: true }, DOCKED);
    assert.deepEqual([keyed.status, keyed.args, keyed.kwargs, keyed.moniker], ["differs", [], { all: true }, true], method);
    assert.match(keyed.note, /sends nothing/);
    // In space the client's office manager has no station: it asks nothing, and what is asked all the same goes by name.
    for (const context of [{}, { dockedAt: null }, undefined]) {
      const inSpace = retailForm("officeManager", method, [], null, context);
      assert.deepEqual([inSpace.status, inSpace.moniker], ["web-only", false], method);
      assert.match(inSpace.source, /officeManager\.py:48$/);
      assert.match(inSpace.note, /docked/);
    }
  }
  assert.deepEqual([madeOnMoniker("officeManager", "GetCorporationsWithOffices"), madeOnMoniker("officeManager", "RentOffice"), madeOnMoniker("officeManager", "GetMyCorporationsOffices")], [true, true, false]);
  // The moniker is kept: nothing of it is made afresh, docked or not.
  assert.deepEqual([madeAfresh("officeManager", "GetCorporationsWithOffices"), madeAfresh("officeManager", "GetEmptyOfficeCount", { dockedInStation: true })], [false, false]);
  // The corporation's own offices are asked by name wherever the pilot is.
  for (const context of [DOCKED, {}]) assert.deepEqual([retailForm("officeManager", "GetMyCorporationsOffices", [], null, context).status, retailForm("officeManager", "GetMyCorporationsOffices", [], null, context).moniker], ["same", false]);
  // The gateway's list has neither read of the station's object: the game port alone carries them.
  assert.deepEqual(GAME_PORT_ONLY_CALLS.filter((pair) => pair.startsWith("officeManager.")).slice(0, 2), ["officeManager.GetCorporationsWithOffices", "officeManager.GetEmptyOfficeCount"]);
});

test("an office is rented and given up on the station's own object: the price for the session's corporation, the rent with that price, the rest with nothing", () => {
  // officeManager.py 114, 117, 122, 108, 143. Tranquility's recording of an office rented has, on the bound
  // object, GetPriceQuote(98838096), the corporation's ID, answered 100113; then RentOffice(100113), answered
  // None. The recording of one given up has UnrentOffice(), answered None, and HasCorpImpoundedItems() after it.
  const SOURCE = "eve/client/script/ui/services/corporation/officeManager.py";
  const OWN = { dockedAt: 60003760, corporationID: 98000001 };
  const asked = (method, args, kwargs = null, context = OWN) => { const made = retailForm("officeManager", method, args, kwargs, context); return [made.status, made.args, made.kwargs, made.moniker, made.source]; };
  assert.deepEqual(asked("GetPriceQuote", [98000001]), ["same", [98000001], null, true, `${SOURCE}:114`]);
  assert.deepEqual(asked("RentOffice", [10000]), ["same", [10000], null, true, `${SOURCE}:117`]);
  assert.deepEqual(asked("RentOffice", [0]), ["same", [0], null, true, `${SOURCE}:117`]);
  for (const [method, line] of [["UnrentOffice", 122], ["PrimeOfficeItem", 108], ["HasCorpImpoundedItems", 143]]) {
    assert.deepEqual(asked(method, []), ["same", [], null, true, `${SOURCE}:${line}`], method);
    assert.equal(asked(method, [60003760])[0], "differs", method);
    assert.equal(asked(method, [], { all: true })[0], "differs", method);
  }
  // The price is asked for the corporation the session is in, and for no other; with that one thing, and no keyword.
  for (const args of [[98000002], [], [98000001, 1], ["98000001"], [null]]) assert.equal(asked("GetPriceQuote", args)[0], "differs", JSON.stringify(args));
  assert.equal(asked("GetPriceQuote", [98000001], { all: true })[0], "differs");
  assert.equal(asked("GetPriceQuote", [98000001], null, { dockedAt: 60003760 })[0], "differs");
  assert.match(retailForm("officeManager", "GetPriceQuote", [98000002], null, OWN).note, /session's corporation/);
  // The rent goes with the one price, a whole number that is not below nought.
  for (const args of [[], [10000, 1], ["10000"], [10000.5], [-1], [null]]) assert.equal(asked("RentOffice", args)[0], "differs", JSON.stringify(args));
  assert.equal(asked("RentOffice", [10000], { all: true })[0], "differs");
  assert.match(retailForm("officeManager", "RentOffice", [], null, OWN).note, /price/);
  // In space the client's office manager has no station, and asks none of them.
  for (const [method, args] of [["GetPriceQuote", [98000001]], ["RentOffice", [10000]], ["UnrentOffice", []], ["PrimeOfficeItem", []], ["HasCorpImpoundedItems", []]]) {
    const inSpace = retailForm("officeManager", method, args, null, { corporationID: 98000001 });
    assert.deepEqual([inSpace.status, inSpace.moniker], ["web-only", false], method);
  }
});

test("a customs office's tax rate is asked of the system's orbital registry, on a Moniker made for the call, and only in space", () => {
  const OFFICE = 1200040176368;
  const asked = retailForm("planetOrbitalRegistryBroker", "GetTaxRate", [OFFICE], null, { solarSystemID: 30002780 });
  assert.deepEqual([asked.status, asked.args, asked.kwargs, asked.moniker], ["same", [OFFICE], null, true]);
  assert.match(asked.source, /importExportUI\.py:383$/);
  assert.match(asked.note, /Tranquility/);
  assert.deepEqual([madeOnMoniker("planetOrbitalRegistryBroker", "GetTaxRate"), madeAfresh("planetOrbitalRegistryBroker", "GetTaxRate"), madeAfresh("planetOrbitalRegistryBroker", "GetTaxRate", { dockedInStation: true })], [true, true, true]);
  // Docked, the session has no system to make the Moniker for (session.solarsystemid is None): the client asks
  // nothing. What the BFF asks all the same goes by name, and is the web's alone.
  for (const context of [{}, { solarSystemID: null }, undefined]) {
    const docked = retailForm("planetOrbitalRegistryBroker", "GetTaxRate", [OFFICE], null, context);
    assert.deepEqual([docked.status, docked.args, docked.moniker], ["web-only", [OFFICE], false]);
    assert.match(docked.source, /eveMoniker\.py:219$/);
    assert.match(docked.note, /space/);
  }
  // An alliance's moniker still says what it wants in its own words.
  const noAlliance = retailForm("allianceRegistry", "GetRelationships", [], null, { solarSystemID: 30002780 });
  assert.deepEqual([noAlliance.status, noAlliance.moniker], ["web-only", false]);
  assert.match(noAlliance.note, /alliance/);
  assert.match(noAlliance.source, /eveMoniker\.py:171$/);
});

test("what goes up into a customs office, and comes down from one, goes as the client sends it", () => {
  const PIN = 1054656331535;
  const up = form("invbroker.ImportExportWithPlanet", [PIN, {}, { 2268: 200, 2073: 5, 9848: 3 }, 0.05]);
  // The goods a dict of quantities by type, in the order a dict has them; what comes down a dict too, empty here.
  assert.deepEqual([up.status, up.args, up.kwargs], ["reshaped", [PIN, fitDict(), fitDict([9848, 3], [2073, 5], [2268, 200]), 0.05], null]);
  assert.match(up.source, /importExportUI\.py:549$/);
  // What comes down is named by its item in the office.
  const down = form("invbroker.ImportExportWithPlanet", [PIN, { 9988400109060: 40 }, {}, 0.05]);
  assert.deepEqual([down.status, down.args], ["reshaped", [PIN, fitDict([9988400109060, 40]), fitDict(), 0.05]]);
  // As the client sends it already: the same call.
  const clients = [PIN, fitDict(), fitDict([2268, 200]), 0.2];
  assert.deepEqual([form("invbroker.ImportExportWithPlanet", clients).status, form("invbroker.ImportExportWithPlanet", clients).args], ["same", clients]);
  // Half the client's: one dict made, the other left.
  assert.deepEqual(form("invbroker.ImportExportWithPlanet", [PIN, fitDict(), { 2268: 1 }, 0]).args, [PIN, fitDict(), fitDict([2268, 1]), 0]);
  assert.deepEqual(form("invbroker.ImportExportWithPlanet", [PIN, { 77: 1 }, fitDict(), 0]).status, "reshaped");
  // Not the client's four, or with no rate to name: it goes as it came, and says what is missing.
  for (const given of [[PIN, {}, { 2268: 1 }], [PIN, {}, { 2268: 1 }, 0.05, 1], [PIN, {}, { 2268: 1 }, null], [PIN, {}, { 2268: 1 }, "0.05"], [PIN, {}, { 2268: 1 }, Number.NaN]]) {
    const answer = form("invbroker.ImportExportWithPlanet", given);
    assert.deepEqual([answer.status, answer.args], ["differs", given], JSON.stringify(given));
    assert.match(answer.note, /tax rate/);
  }
});

test("the game port carries the customs office's transfer, the station's offices and the clone's grade, which the web gateway's list has not got", () => {
  assert.deepEqual(GAME_PORT_ONLY_CALLS, [
    "invbroker.ImportExportWithPlanet", "officeManager.GetCorporationsWithOffices", "officeManager.GetEmptyOfficeCount",
    "officeManager.GetPriceQuote", "officeManager.HasCorpImpoundedItems", "officeManager.PrimeOfficeItem", "officeManager.RentOffice", "officeManager.UnrentOffice",
    "subscriptionMgr.GetCloneGrade",
    "skillHandler.GetSkillQueueAndFreePoints",
    "home_station.get_home_station",
    "skillHandler.SaveNewQueue",
    "userSvc.GetMultiCharactersTrainingSlots",
  ]);
  // skillQueueSvc.py 851: sm.RemoteSvc('userSvc').GetMultiCharactersTrainingSlots(), by the service's name and with nothing.
  const slots = retailForm("userSvc", "GetMultiCharactersTrainingSlots", [], null);
  assert.deepEqual([slots.status, slots.source, slots.args, slots.kwargs, slots.moniker], ["same", "eve/client/script/ui/services/skillQueueSvc.py:851", [], null, false]);
  for (const [args, kwargs] of [[[4], null], [[], { force: true }]]) {
    assert.equal(retailForm("userSvc", "GetMultiCharactersTrainingSlots", args, kwargs).status, "differs", JSON.stringify([args, kwargs]));
  }
  // homestation/client/service.py 67: self.remote.get_home_station(), of the service by its name, with nothing.
  const home = retailForm("home_station", "get_home_station", [], null);
  assert.deepEqual([home.status, home.source, home.args, home.kwargs, home.moniker, home.proxy], ["same", "homestation/client/service.py:67", [], null, false, false]);
  // skillQueueSvc.py 117: self.skills.GetSkillHandler().GetSkillQueueAndFreePoints(), on the handler's moniker and with nothing.
  const queue = retailForm("skillHandler", "GetSkillQueueAndFreePoints", [], null);
  assert.deepEqual([queue.status, queue.source, queue.args, queue.kwargs, queue.moniker], ["same", "eve/client/script/ui/services/skillQueueSvc.py:117", [], null, true]);
  // clone_grade_svc.py 125: sm.RemoteSvc('subscriptionMgr').GetCloneGrade(), by the service's name and with nothing.
  const grade = RETAIL_CALLS["subscriptionMgr.GetCloneGrade"];
  assert.deepEqual([grade.status, grade.source, MONIKER_SERVICES.subscriptionMgr, PROXY_SERVICES.has("subscriptionMgr")], ["same", "omega/client/clone_grade_svc.py:125", undefined, false]);
  // When the gateway's list gains one of these, it is the gateway's too, and comes off this list.
  for (const pair of GAME_PORT_ONLY_CALLS) assert.equal(contract.gatewayAllowlist.pairs.includes(pair), false, pair);
});

// clientPlanet.py 83 and 644: planetInfo = self.remoteHandler.GetPlanetInfo() and
// self.remoteHandler.GetPlanetResourceInfo(), on the planet's own object (eveMoniker.GetPlanet(planetID)), each
// with nothing. Tranquility's recordings have the first riding the bind: MachoBindObject(40344202,
// ('GetPlanetInfo', (), {})).

test("a planet's colony and what the planet carries are asked of the planet's own object, with nothing", () => {
  for (const [method, line] of [["GetPlanetInfo", 83], ["GetPlanetResourceInfo", 644]]) {
    const asked = form(`planetMgr.${method}`, []);
    assert.deepEqual([asked.status, asked.args, asked.kwargs], ["same", [], null], method);
    assert.match(asked.source, new RegExp(`clientPlanet\\.py:${line}$`), method);
    // With the planet named again beside it, as an older route of the BFF's does, it is not the client's call.
    const named = form(`planetMgr.${method}`, [40176368]);
    assert.deepEqual([named.status, named.args], ["differs", [40176368]], method);
    assert.match(named.note, /nothing/, method);
  }
  assert.match(form("planetMgr.GetPlanetInfo", []).note, /Tranquility/);
});

test("a queue's saving is the client's when it is the whole queue by place and says whether it is to be started, and nothing else", () => {
  const queue = (...places) => ({ type: "dict", entries: places });
  const save = (args, kwargs) => retailForm("skillHandler", "SaveNewQueue", args, kwargs);
  // skillQueueSvc.py 152, 153: {idx: (typeID, toLevel)} and activate=activate, on the handler's moniker.
  for (const [args, kwargs] of [
    [[queue([0, [3300, 5]], [1, [3327, 4]])], { activate: true }],
    [[queue([0, [3300, 5]])], { activate: false }],
    [[queue()], { activate: true }],
  ]) {
    const made = save(args, kwargs);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy], ["same", "eve/client/script/ui/services/skillQueueSvc.py:153", args, kwargs, true, false], JSON.stringify([args, kwargs]));
  }
  // Anything else goes as it came, and is counted as differing from the client's.
  const whole = queue([0, [3300, 5]], [1, [3327, 4]]);
  for (const [args, kwargs, why] of [
    [[whole], null, "nothing said of starting"],
    [[whole], {}, "nothing said of starting"],
    [[whole], { activate: 1 }, "starting said with a number"],
    [[whole], { activate: true, more: 1 }, "another keyword"],
    [[whole, 1], { activate: true }, "a second argument"],
    [[], { activate: true }, "no queue"],
    [[null], { activate: true }, "nothing for the queue"],
    [[[[3300, 5]]], { activate: true }, "a list for the queue"],
    [[{ type: "list", items: [[3300, 5]] }], { activate: true }, "a list for the queue"],
    [[{ type: "dict" }], { activate: true }, "a dict with no entries to read"],
    [[{ entries: [[0, [3300, 5]]] }], { activate: true }, "entries, in what is no dict"],
    [[{ type: "list", entries: [[0, [3300, 5]]] }], { activate: true }, "entries, in what says it is a list"],
    [[{ type: "dict", entries: [null] }], { activate: true }, "a place that is nothing"],
    [[queue([0, "35"])], { activate: true }, "a place whose skill and level are two letters"],
    [[queue([1, [3300, 5]])], { activate: true }, "places not from nought"],
    [[queue([1, [3327, 4]], [0, [3300, 5]])], { activate: true }, "places out of order"],
    [[queue([0, [3300, 5]], [0, [3327, 4]])], { activate: true }, "a place twice"],
    [[queue([0, [3300]])], { activate: true }, "no level"],
    [[queue([0, [3300, 5, 1]])], { activate: true }, "a third thing in a place"],
    [[queue([0, [3300, "5"]])], { activate: true }, "a level as text"],
    [[queue([0, [3300.5, 5]])], { activate: true }, "a type that is no whole number"],
    [[queue([0, 3300])], { activate: true }, "a place that is no pair"],
    [[queue([0, [3300, 5], 7])], { activate: true }, "an entry of three"],
    [[queue(["0", [3300, 5]])], { activate: true }, "a place as text"],
  ]) {
    const made = save(args, kwargs);
    assert.deepEqual([made.status, made.args, made.moniker], ["differs", args, true], why);
    assert.match(made.note, /whole queue/, why);
  }
});

test("free points put into a skill are the client's call when they name one skill and how many points, more than none, and nothing else", () => {
  const apply = (args, kwargs = null) => retailForm("skillHandler", "ApplyFreeSkillPoints", args, kwargs);
  // skillsvc.py 886: self.GetSkillHandler().ApplyFreeSkillPoints(skill.typeID, pointsToApply), on the handler's moniker.
  for (const args of [[3327, 1200], [3300, 1]]) {
    const made = apply(args);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker], ["same", "eve/client/script/ui/services/skillsvc.py:886", args, null, true], JSON.stringify(args));
  }
  // Anything else goes as it came, and is counted as differing: the client sends none of these.
  for (const [args, kwargs, why] of [
    [[3327, 0], null, "no points (the service sends nothing for none, 884)"],
    [[3327, -5], null, "fewer than none"],
    [[0, 100], null, "no skill"],
    [[3327], null, "no points said"],
    [[], null, "nothing"],
    [[3327, 100, 1], null, "a third thing"],
    [[3327, 100.5], null, "half a point"],
    [["3327", 100], null, "a skill as text"],
    [[3327, "100"], null, "points as text"],
    [[null, null], null, "nothing for either"],
    [[[3327], 100], null, "a list of skills"],
    [[3327, 100], { force: true }, "a keyword"],
  ]) {
    const made = apply(args, kwargs);
    assert.deepEqual([made.status, made.args, made.moniker], ["differs", args, true], why);
    assert.match(made.note, /one skill/, why);
  }
});

test("a safety level set is the client's call when it names one of the three levels and nothing else", () => {
  const set = (args, kwargs = null) => retailForm("crimewatch", "SetSafetyLevel", args, kwargs);
  // crimewatchSvc.py 343: eveMoniker.CharGetCrimewatchLocation().SetSafetyLevel(safetyLevel), with none, partial or full.
  for (const level of [0, 1, 2]) {
    const made = set([level]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker], ["same", "eve/client/script/ui/services/crimewatchSvc.py:343", [level], null, true], String(level));
  }
  // Anything else goes as it came, and is counted as differing.
  for (const [args, kwargs, why] of [
    [[3], null, "a level above full"],
    [[-1], null, "a level below none"],
    [[1.5], null, "half a level"],
    [["1"], null, "a level as text"],
    [[true], null, "a level as a truth"],
    [[null], null, "nothing for the level"],
    [[], null, "no level"],
    [[1, 2], null, "two levels"],
    [[[1]], null, "a list of one level"],
    [[1], { confirm: true }, "a keyword"],
  ]) {
    const made = set(args, kwargs);
    assert.deepEqual([made.status, made.args, made.moniker], ["differs", args, true], why);
    assert.match(made.note, /three safety levels/, why);
  }
});

test("a contract taken on is the client's call when it names the one contract and says for whom, and nothing else", () => {
  const accept = (args, kwargs = null) => retailForm("contractProxy", "AcceptContract", args, kwargs);
  // contracts.py 422: self.GetContractProxySvc().AcceptContract(contractID, forCorp), of the proxy by its name.
  for (const args of [[233598633, false], [8100, true]]) {
    const made = accept(args);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy], ["same", "eve/client/script/ui/shared/neocom/contracts/contracts.py:422", args, null, false, true], JSON.stringify(args));
  }
  // Anything else goes as it came, and is counted as differing.
  for (const [args, kwargs, why] of [
    [[8100], null, "for whom not said"],
    [[], null, "nothing"],
    [[8100, false, 1], null, "a third thing"],
    [[0, false], null, "no contract"],
    [[-8100, false], null, "a contract below nought"],
    [[8100.5, false], null, "half a contract"],
    [["8100", false], null, "a contract as text"],
    [[8100, 0], null, "for whom as a number"],
    [[8100, "false"], null, "for whom as text"],
    [[8100, null], null, "for whom as nothing"],
    [[[8100], false], null, "a list of contracts"],
    [[8100, false], { forCorp: true }, "a keyword"],
  ]) {
    const made = accept(args, kwargs);
    assert.deepEqual([made.status, made.args, made.proxy], ["differs", args, true], why);
    assert.match(made.note, /one contract/, why);
  }
});

test("a launch's record removed is the client's call when it names the one launch and nothing else", () => {
  const remove = (args, kwargs = null) => retailForm("planetMgr", "DeleteLaunch", args, kwargs);
  // journal.py 464: sm.RemoteSvc('planetMgr').DeleteLaunch(launchID), of the planet manager by its name.
  const made = remove([500002]);
  assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker], ["same", "eve/client/script/ui/shared/neocom/journal.py:464", [500002], null, false]);
  // Anything else goes as it came, and is counted as differing.
  for (const [args, kwargs, why] of [
    [[], null, "no launch"],
    [[0], null, "no launch's ID"],
    [[-3], null, "an ID below nought"],
    [[500002.5], null, "half an ID"],
    [["500002"], null, "an ID as text"],
    [[null], null, "nothing for the ID"],
    [[500002, 140000005], null, "an owner beside it"],
    [[[500002]], null, "a list of launches"],
    [[500002], { force: true }, "a keyword"],
  ]) {
    const odd = remove(args, kwargs);
    assert.deepEqual([odd.status, odd.args], ["differs", args], why);
    assert.match(odd.note, /one launch/, why);
  }
});

test("a fleet applied to is the client's call when it names the one fleet and says whether its invitation is taken unasked, from a session in no fleet", () => {
  const apply = (args, kwargs = null, context = {}) => retailForm("fleetProxy", "ApplyToJoinFleet", args, kwargs, context);
  // fleetSvc.py 1907: sm.ProxySvc('fleetProxy').ApplyToJoinFleet(fleetID, autoAccept), to the client's proxy node.
  for (const autoAccept of [true, false]) {
    const made = apply([654500010000, autoAccept]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy],
      ["same", "eve/client/script/parklife/fleetSvc.py:1907", [654500010000, autoAccept], null, false, true]);
  }
  assert.equal(apply([654500010000, true], null, { fleetID: null, holdsFleet: false }).status, "same");
  // Anything else goes as it came, and is counted as differing.
  for (const [args, kwargs, why] of [
    [[], null, "no fleet"],
    [[654500010000], null, "the fleet alone"],
    [[0, true], null, "no fleet's ID"],
    [[-5, true], null, "an ID below nought"],
    [[1.5, false], null, "half an ID"],
    [["654500010000", true], null, "an ID as text"],
    [[654500010000, 1], null, "a number for the yes or no"],
    [[654500010000, null], null, "nothing for the yes or no"],
    [[654500010000, true, 3], null, "a third thing"],
    [[654500010000, true], { autoAccept: true }, "a keyword"],
  ]) {
    const odd = apply(args, kwargs);
    assert.deepEqual([odd.status, odd.args], ["differs", args], why);
    assert.match(odd.note, /one fleet/, why);
  }
  // 1899 to 1905: in a fleet the client refuses its own, and leaves another before it applies.
  const fleeted = apply([654500010000, true], null, { fleetID: 654500010999, holdsFleet: true });
  assert.deepEqual([fleeted.status, fleeted.args], ["differs", [654500010000, true]]);
  assert.match(fleeted.note, /in no fleet/);
});

test("a broadcast to the bubble is the client's call with one of its five names, a scope, the item and no type, from a session in a fleet", () => {
  const send = (args, kwargs = null, context = {}) => retailForm("fleetMgr", "BroadcastToBubble", args, kwargs, context);
  // fleetSvc.py 998: sm.RemoteSvc('fleetMgr').BroadcastToBubble(name, self.broadcastScope, itemID, typeID), the type
  // left at None by every caller (1039 to 1055).
  for (const name of ["HealArmor", "HealShield", "HealCapacitor", "Target", "HealTarget"]) {
    for (const scope of [1, 2, 3]) {
      const made = send([name, scope, 200001, null]);
      assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy],
        ["same", "eve/client/script/parklife/fleetSvc.py:998", [name, scope, 200001, null], null, false, false], `${name} ${scope}`);
    }
  }
  assert.equal(send(["Target", 3, 200001, null], null, { fleetID: 654500010000, holdsFleet: true }).status, "same");
  for (const [args, kwargs, why] of [
    [[], null, "nothing"],
    [["Target", 3, 200001], null, "no place for the type"],
    [["Target", 3, 200001, 587], null, "a type"],
    [["Target", 3, 200001, null, 1], null, "a fifth thing"],
    [["EnemySpotted", 3, 200001, null], null, "a name the client sends to the whole fleet"],
    [["target", 3, 200001, null], null, "a name in small letters"],
    [[null, 3, 200001, null], null, "no name"],
    [["Target", 0, 200001, null], null, "no scope"],
    [["Target", 4, 200001, null], null, "a fourth scope"],
    [["Target", "3", 200001, null], null, "a scope as text"],
    [["Target", null, 200001, null], null, "nothing for the scope"],
    [["Target", 3, 0, null], null, "no item"],
    [["Target", 3, -4, null], null, "an item below nought"],
    [["Target", 3, 1.5, null], null, "half an item"],
    [["Target", 3, "200001", null], null, "an item as text"],
    [["Target", 3, null, null], null, "nothing for the item"],
    [["Target", 3, 200001, null], { typeID: 587 }, "a keyword"],
  ]) {
    const odd = send(args, kwargs);
    assert.deepEqual([odd.status, odd.args], ["differs", args], why);
    assert.match(odd.note, /five names/, why);
  }
  // 993 (CheckIsInFleet): in no fleet the client sends nothing.
  const alone = send(["Target", 3, 200001, null], null, { fleetID: null, holdsFleet: false });
  assert.deepEqual([alone.status, alone.args], ["differs", ["Target", 3, 200001, null]]);
  assert.match(alone.note, /in a fleet/);
});

test("a module overloaded or cooled is the client's call when it names the module and the module's own overload effect", () => {
  // godma.py 2075 and 2120: GetDogmaLM().Overload(itemID, effectID) and StopOverload(itemID, effectID), on the dogma
  // location's object. Tranquility has the first recorded: Overload(moduleID, 3001). The effect is the module's own
  // of the overload category (shipmodulebutton.py 231), which godma knows and `overloadEffect` stands for here.
  const knows = { overloadEffect: (itemID) => (itemID === 61001 ? 3001 : null) };
  for (const [method, line] of [["Overload", 2075], ["StopOverload", 2120]]) {
    const ask = (args, kwargs = null, context = knows) => retailForm("dogmaIM", method, args, kwargs, context);
    const made = ask([61001, 3001]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy],
      ["same", `eve/client/script/environment/godma.py:${line}`, [61001, 3001], null, true, false], method);
    // No effect named, as the BFF's route asks: it is given the module's own.
    const given = ask([61001, 0]);
    assert.deepEqual([given.status, given.args], ["reshaped", [61001, 3001]], method);
    // Another effect, a module with no overload effect, and a module godma does not know: each goes as it came.
    for (const [args, why] of [[[61001, 3025], "another effect"], [[61002, 3001], "a module with none"], [[61002, 0], "none named, and none known"]]) {
      const odd = ask(args);
      assert.deepEqual([odd.status, odd.args], ["differs", args], `${method}: ${why}`);
      assert.match(odd.note, /overload effect/, why);
    }
    // With no godma to ask (through the web gateway): an effect named is taken for the module's; none named is not the client's.
    assert.deepEqual([ask([61001, 3001], null, {}).status, ask([61001, 3025], null, {}).status], ["same", "same"], method);
    const blind = ask([61001, 0], null, {});
    assert.deepEqual([blind.status, blind.args], ["differs", [61001, 0]], method);
    // Anything else goes as it came, and is counted as differing: for its form alone, with no godma asked.
    for (const [args, kwargs, why] of [
      [[], null, "nothing"],
      [[61001], null, "the module alone"],
      [[0, 3001], null, "no module"],
      [[-5, 3001], null, "a module below nought"],
      [[61001.5, 3001], null, "half a module"],
      [["61001", 3001], null, "a module as text"],
      [[61001, -1], null, "an effect below nought"],
      [[61001, 3001.5], null, "half an effect"],
      [[61001, "3001"], null, "an effect as text"],
      [[61001, null], null, "nothing for the effect"],
      [[61001, 3001, 1], null, "a third thing"],
      [[61001, 3001], { repeat: 1 }, "a keyword"],
    ]) {
      const odd = ask(args, kwargs, {});
      assert.deepEqual([odd.status, odd.args], ["differs", args], `${method}: ${why}`);
      assert.match(odd.note, /overload effect/, why);
    }
  }
  // Each wants godma primed first: it is godma that knows what the module is.
  assert.deepEqual(["Overload", "StopOverload"].map((method) => retailNeeds("dogmaIM", method)), ["dogma", "dogma"]);
});

test("a module's repair begun or ended is the client's call when it names the one module and nothing else", () => {
  // godma.py 2227 and 2261: GetDogmaLM().InitiateModuleRepair(itemID) and StopModuleRepair(itemID), on the dogma
  // location's object. No recording has either.
  for (const [method, line] of [["InitiateModuleRepair", 2227], ["StopModuleRepair", 2261]]) {
    const ask = (args, kwargs = null) => retailForm("dogmaIM", method, args, kwargs);
    const made = ask([61001]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy],
      ["same", `eve/client/script/environment/godma.py:${line}`, [61001], null, true, false], method);
    for (const [args, kwargs, why] of [
      [[], null, "no module"],
      [[0], null, "no module's ID"],
      [[-5], null, "a module below nought"],
      [[61001.5], null, "half a module"],
      [["61001"], null, "a module as text"],
      [[null], null, "nothing for the module"],
      [[[61001]], null, "a list of modules"],
      [[61001, 61002], null, "two modules"],
      [[61001], { quick: true }, "a keyword"],
    ]) {
      const odd = ask(args, kwargs);
      assert.deepEqual([odd.status, odd.args], ["differs", args], `${method}: ${why}`);
      assert.match(odd.note, /one module/, why);
    }
  }
});

test("the weapons linked or unlinked all at once is the client's call when it names the ship the session is flying and nothing else", () => {
  // clientDogmaLocation.py 800 and 794: remoteDogmaLM.LinkAllWeapons(shipID) and UnlinkAllModules(shipID), on the
  // dogma location's object, from the group-all button with session.shipid (groupAllIcon.py 36 and 38).
  const flying = { shipID: 9988400023309 };
  for (const [method, line] of [["LinkAllWeapons", 800], ["UnlinkAllModules", 794]]) {
    const ask = (args, kwargs = null, context = flying) => retailForm("dogmaIM", method, args, kwargs, context);
    const made = ask([9988400023309]);
    assert.deepEqual([made.status, made.source, made.args, made.kwargs, made.moniker, made.proxy],
      ["same", `eve/client/script/dogma/clientDogmaLocation.py:${line}`, [9988400023309], null, true, false], method);
    // Another ship than the session's goes as it came, and is counted as differing.
    const other = ask([9988400099999]);
    assert.deepEqual([other.status, other.args], ["differs", [9988400099999]], method);
    assert.match(other.note, /ship its session is flying/);
    // Where the session's ship is not known (through the web gateway), a ship named is taken for it.
    for (const context of [{}, { shipID: null }]) assert.equal(ask([9988400099999], null, context).status, "same", method);
    for (const [args, kwargs, why] of [
      [[], null, "no ship"],
      [[0], null, "no ship's ID"],
      [[-5], null, "a ship below nought"],
      [[9988400023309.5], null, "half a ship"],
      [["9988400023309"], null, "a ship as text"],
      [[null], null, "nothing for the ship"],
      [[9988400023309, 61001], null, "a module beside it"],
      [[9988400023309], { merge: true }, "a keyword"],
    ]) {
      const odd = ask(args, kwargs, {});
      assert.deepEqual([odd.status, odd.args], ["differs", args], `${method}: ${why}`);
      assert.match(odd.note, /one ship/, why);
    }
  }
});
