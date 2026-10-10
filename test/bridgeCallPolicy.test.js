"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BRIDGE_WRITE_PAIR_KEYS,
  EARLIER_WRITE_PAIR_KEYS,
  FEATURE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  isBridgeWritePair,
  pickSafeBrowserSessionFields,
} = require("../src/bridgeCallPolicy");

test("the generic-call write policy covers the complete canonical plumbing inventory", () => {
  const worklist = fs.readFileSync(
    path.join(__dirname, "..", "docs", "plumbing-worklist.md"),
    "utf8",
  );
  const phaseBody = worklist.slice(
    worklist.indexOf("## PHASE 3"),
    worklist.indexOf("## ORCHESTRATOR NOTES"),
  );
  const declaredCount = [...phaseBody.matchAll(/^## PHASE [34].*\((\d+)\)/gm)]
    .reduce((total, match) => total + Number(match[1]), 0);

  assert.equal(declaredCount, 301, "the canonical worklist declares 152 + 149 writes");
  assert.equal(PLUMBING_SWEEP_WRITE_PAIR_KEYS.length, declaredCount);
  for (const key of PLUMBING_SWEEP_WRITE_PAIR_KEYS) {
    const separator = key.indexOf(".");
    const service = key.slice(0, separator);
    const method = key.slice(separator + 1);
    // The worklist uses the retail owner name skillMgr; after
    // GetMySkillHandler the web gateway dispatch seam is named skillHandler.
    const worklistService = service === "skillHandler" ? "skillMgr" : service;
    assert.ok(
      phaseBody.includes(worklistService),
      `${service} must be named by the canonical write phases`,
    );
    assert.ok(phaseBody.includes(method), `${key} must be named by the canonical write phases`);
    assert.equal(isBridgeWritePair(service, method), true, key);
  }
});

test("the write policy adds every pre-sweep and post-sweep write without duplicates", () => {
  assert.equal(EARLIER_WRITE_PAIR_KEYS.length, 49);
  assert.deepEqual(FEATURE_WRITE_PAIR_KEYS, ["repairSvc.RepairItems", "officeManager.RentOffice", "officeManager.UnrentOffice", "skillHandler.PurchaseSkills", "skillHandler.SaveNewQueue", "slash.SlashCmd", "invbroker.ImportExportWithPlanet"]);
  assert.equal(BRIDGE_WRITE_PAIR_KEYS.length, 357);
  assert.equal(new Set(BRIDGE_WRITE_PAIR_KEYS).size, BRIDGE_WRITE_PAIR_KEYS.length);

  assert.equal(isBridgeWritePair("charUnboundMgr", "SelectCharacterID"), true);
  assert.equal(isBridgeWritePair("fleetObjectHandler", "Init"), true);
  assert.equal(isBridgeWritePair("repairSvc", "RepairItems"), true);
  assert.equal(isBridgeWritePair("officeManager", "RentOffice"), true, "generic bridge dispatch cannot rent an office");
  assert.equal(isBridgeWritePair("officeManager", "UnrentOffice"), true, "nor give one up");
  assert.equal(isBridgeWritePair("skillHandler", "PurchaseSkills"), true, "direct skill purchase requires a reviewed Factory action");
  assert.equal(isBridgeWritePair("repairSvc", "GetRepairQuotes"), false);
  assert.equal(isBridgeWritePair("map", "GetStationInfo"), false);
  // ⚠⚠ The GM console. Listed as a write for one reason: so the generic
  // /api/bridge/call route cannot become a second, UNCONFIRMED way to run
  // /giveitem, /npc or /suicide against the live world.
  assert.equal(isBridgeWritePair("slash", "SlashCmd"), true);
});

test("browser session projection retains only explicit language preferences", () => {
  assert.deepEqual(SAFE_BROWSER_SESSION_FIELDS, [
    "languageID",
    "languageId",
    "languageid",
    "language",
  ]);
  assert.deepEqual(
    pickSafeBrowserSessionFields({
      userid: 999,
      userName: "spoofed-admin",
      charid: 7,
      corporationID: 8,
      roles: Number.MAX_SAFE_INTEGER,
      stationid: 60003760,
      solarSystemID: 30000142,
      shipid: 9001,
      languageID: "EN",
      language: "en",
      languageId: { nested: "not a scalar" },
    }),
    { languageID: "EN", language: "en" },
  );
  assert.deepEqual(pickSafeBrowserSessionFields(null), {});
  assert.deepEqual(pickSafeBrowserSessionFields([]), {});
});

test("the writes the page makes itself are writes, each named once, and the first is the pause of training", () => {
  const { BRIDGE_WRITE_PAIR_KEYS, PAGE_WRITE_PAIR_KEYS, isBridgeWritePair, isPageWritePair } = require("../src/bridgeCallPolicy");
  assert.deepEqual(PAGE_WRITE_PAIR_KEYS, ["skillHandler.AbortTraining", "skillHandler.SaveNewQueue", "skillHandler.ApplyFreeSkillPoints", "crimewatch.SetSafetyLevel", "contractProxy.AcceptContract", "planetMgr.DeleteLaunch", "fleetProxy.ApplyToJoinFleet", "fleetMgr.BroadcastToBubble"]);
  // The queue's saving is the client's own call, on its skill handler. The gateway's save of a queue is another
  // pair, a write as it always was, and its route's alone.
  assert.deepEqual([isBridgeWritePair("skillMgr", "SaveNewQueue"), isPageWritePair("skillMgr", "SaveNewQueue")], [true, false]);
  assert.equal(new Set(PAGE_WRITE_PAIR_KEYS).size, PAGE_WRITE_PAIR_KEYS.length);
  for (const pair of PAGE_WRITE_PAIR_KEYS) {
    const [service, method] = pair.split(".");
    assert.deepEqual([isPageWritePair(service, method), isBridgeWritePair(service, method)], [true, true], pair);
  }
  // Every other write is its route's alone; a read is no write of anybody's; what is no pair is none.
  const others = BRIDGE_WRITE_PAIR_KEYS.filter((pair) => !PAGE_WRITE_PAIR_KEYS.includes(pair));
  assert.ok(others.length > 100);
  for (const pair of others) assert.equal(isPageWritePair(...pair.split(".")), false, pair);
  for (const [service, method] of [["skillHandler", "GetSkills"], ["skillHandler", "abortTraining"], ["skillMgr", "AbortTraining"], [null, "AbortTraining"], ["skillHandler", undefined], ["skillHandler.AbortTraining", ""]]) {
    assert.equal(isPageWritePair(service, method), false, String([service, method]));
  }
  // What would spell a pair if it were made into text is no pair: a list of one name is not that name.
  for (const [service, method] of [[["skillHandler"], "AbortTraining"], ["skillHandler", ["AbortTraining"]], [{ toString: () => "skillHandler" }, "AbortTraining"]]) {
    assert.deepEqual([isPageWritePair(service, method), isBridgeWritePair(service, method)], [false, false], JSON.stringify([service, method]));
  }
});
