"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BRIDGE_WRITE_PAIR_KEYS,
  PLUMBING_SWEEP_WRITE_PAIR_KEYS,
  SAFE_BROWSER_SESSION_FIELDS,
  isBridgeWritePair,
  isPageWritePair,
  personalRepackageLocation,
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

test("Personal Assets repackaging accepts only unique item tuples in one hangar", () => {
  const stationID = 60003760;
  const itemID = 9988400008296;
  const args = rows => [{ type: "dict", entries: [[stationID, { type: "list", items: rows }]] }];
  assert.equal(isBridgeWritePair("repackagingSvc", "RepackageItems"), true);
  assert.equal(isPageWritePair("repackagingSvc", "RepackageItems"), true);
  assert.equal(personalRepackageLocation(args([[itemID, stationID]]), null), stationID);
  assert.equal(personalRepackageLocation(args([[itemID, stationID]]), { destroyable: true }), stationID);
  assert.equal(personalRepackageLocation(args([[itemID, stationID + 1]]), null), null);
  assert.equal(personalRepackageLocation(args([[itemID, stationID], [itemID, stationID]]), null), null);
  assert.equal(personalRepackageLocation(args([[itemID, stationID]]), { destroyable: "true" }), null);
});

test("the writes the page makes itself are writes, each named once", () => {
  const { BRIDGE_WRITE_PAIR_KEYS, PAGE_WRITE_PAIR_KEYS, isBridgeWritePair, isPageWritePair } = require("../src/bridgeCallPolicy");
  // The repair shop's two repairs go by the server's own name through the gateway, whose list has no other; every
  // other call goes by its own.
  const { gatewaysNameFor } = require("../src/bridgeCallPolicy");
  assert.deepEqual([gatewaysNameFor("repairSvc", "RepairItemsInStation"), gatewaysNameFor("repairSvc", "RepairItemsInStructure")], ["RepairItems", "RepairItems"]);
  assert.deepEqual([gatewaysNameFor("repairSvc", "GetRepairQuotes"), gatewaysNameFor("repairSvc", "RepairItems"), gatewaysNameFor("ship", "RepairItemsInStation"), gatewaysNameFor("slash", "SlashCmd"), gatewaysNameFor("constructor", "prototype")],
    ["GetRepairQuotes", "RepairItems", "RepairItemsInStation", "SlashCmd", "prototype"]);
  // A list of one name spells that name when it is made into text, and is no name: it goes as it came.
  const listOfOne = ["RepairItemsInStation"];
  assert.deepEqual([gatewaysNameFor(["repairSvc"], "RepairItemsInStation"), gatewaysNameFor("repairSvc", listOfOne) === listOfOne, gatewaysNameFor(null, undefined)], ["RepairItemsInStation", true, undefined]);
  // The queue's saving is the client's own call, on its skill handler. The gateway's save of a queue is another
  // pair, a write as it always was, and its route's alone.
  assert.deepEqual([isBridgeWritePair("skillMgr", "SaveNewQueue"), isPageWritePair("skillMgr", "SaveNewQueue")], [true, false]);
  assert.deepEqual(PAGE_WRITE_PAIR_KEYS.filter(key => key.startsWith("calendarMgr.")), [
    "calendarMgr.SendEventResponse", "calendarMgr.CreatePersonalEvent", "calendarMgr.CreateCorporationEvent", "calendarMgr.CreateAllianceEvent",
    "calendarMgr.EditPersonalEvent", "calendarMgr.EditCorporationEvent", "calendarMgr.EditAllianceEvent",
    "calendarMgr.UpdateEventParticipants", "calendarMgr.DeleteEvent",
  ]);
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

test("the page's calls that are made on an object of the service's own say what the object is for", () => {
  const { PAGE_WRITE_PAIR_KEYS, objectOfPageCall } = require("../src/bridgeCallPolicy");
  // eveMoniker.GetPlanet(planetID): a colony's network is changed on the planet's own object.
  assert.equal(objectOfPageCall("planetMgr", "UserUpdateNetwork"), "planet");
  // Asked of the service by its name, as the client asks them.
  for (const [service, method] of [["planetMgr", "DeleteLaunch"], ["planetMgr", "GetPlanetsForChar"], ["beyonce", "CmdGotoPoint"], ["skillHandler", "SaveNewQueue"]]) {
    assert.equal(objectOfPageCall(service, method), null, `${service}.${method}`);
  }
  // A name that is no pair's is none, whatever an object happens to have by that name.
  for (const [service, method] of [["constructor", "prototype"], ["__proto__", "x"], ["toString", ""], ["planetMgr", ""], ["", ""]]) {
    assert.equal(objectOfPageCall(service, method), null, `${service}.${method}`);
  }
  // A list of one name spells that name when it is made into text, and is no name.
  assert.deepEqual([objectOfPageCall(["planetMgr"], "UserUpdateNetwork"), objectOfPageCall("planetMgr", ["UserUpdateNetwork"]), objectOfPageCall(null, undefined)], [null, null, null]);
  // The planet asked what a programme will yield, which the client asks of the same object before it installs one.
  assert.equal(objectOfPageCall("planetMgr", "GetProgramResultInfo"), "planet");
  // A write among them is one the page makes itself; a read among them is no write of any kind.
  const { PAGE_OBJECT_CALLS, isBridgeWritePair, isPageWritePair } = require("../src/bridgeCallPolicy");
  // fleetSvc.CreateFleet: asked of the handler by name, and what it answers is the fleet's own object, which the
  // BFF holds: so it is made as the fleet's other call is, with no object the page names.
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "CreateFleet"), isBridgeWritePair("fleetObjectHandler", "CreateFleet"), isPageWritePair("fleetObjectHandler", "CreateFleet")], ["fleet", true, true]);
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "Init"), isPageWritePair("fleetObjectHandler", "Init")], [null, false]);
  // fleetSvc.OnFleetInvite: GetFleet(fleetID).AcceptInvite(...), on a Moniker for the fleet the invitation names.
  // The page says which fleet, as it says which planet. And so for the invitation's other answer (1180, 1184, 1198).
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "AcceptInvite"), isBridgeWritePair("fleetObjectHandler", "AcceptInvite"), isPageWritePair("fleetObjectHandler", "AcceptInvite")], ["fleetByNumber", true, true]);
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "RejectInvite"), isBridgeWritePair("fleetObjectHandler", "RejectInvite"), isPageWritePair("fleetObjectHandler", "RejectInvite")], ["fleetByNumber", true, true]);
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "MassInvite"), isPageWritePair("fleetObjectHandler", "MassInvite"), objectOfPageCall("fleetObjectHandler", "Reconnect"), isPageWritePair("fleetObjectHandler", "Reconnect")], [null, false, null, false]);
  // fleetSvc.Invite: on the pilot's own fleet's object, which the call may say the number of, to be held to it.
  const policy = require("../src/bridgeCallPolicy");
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "Invite"), isBridgeWritePair("fleetObjectHandler", "Invite"), isPageWritePair("fleetObjectHandler", "Invite")], ["fleetExpected", true, true]);
  assert.deepEqual([policy.pageMayNameTheObject("fleetExpected"), policy.pageNamesTheObject("fleetExpected")], [true, false]);
  assert.deepEqual(["fleet", "fleetByNumber", "planet", "scanManager", null, undefined, ["fleetExpected"], "toString"].map((kind) => policy.pageMayNameTheObject(kind)), [false, false, false, false, false, false, false, false]);
  // movementFunctions.WarpToBookmark (416): GetAgentMoniker(agentID).WarpToLocation(...), on the agent's own object.
  // The page says which agent, as it says which planet. The agent's other calls are their routes' still.
  assert.deepEqual([objectOfPageCall("agentMgr", "WarpToLocation"), isBridgeWritePair("agentMgr", "WarpToLocation"), isPageWritePair("agentMgr", "WarpToLocation")], ["agent", true, true]);
  assert.deepEqual([policy.pageNamesTheObject("agent"), policy.pageMayNameTheObject("agent")], [true, false]);
  // Approach Location of a mission's spot (movementFunctions.ApproachLocation, 402): GotoLocation on the agent's object too.
  assert.deepEqual([objectOfPageCall("agentMgr", "GotoLocation"), isPageWritePair("agentMgr", "GotoLocation"), objectOfPageCall("agentMgr", "DoAction"), objectOfPageCall("agentMgr", "GetAgents")], ["agent", true, "agent", null]);
  // What is said to an agent and an offer taken out of the journal are asked of the agent's own object too
  // (agentDialogueWindow.py 427 to 428; agents.py 782 to 784), and are the page's own since 2026-10-13.
  assert.deepEqual([objectOfPageCall("agentMgr", "RemoveOfferFromJournal"), isPageWritePair("agentMgr", "DoAction"), isPageWritePair("agentMgr", "RemoveOfferFromJournal")], ["agent", true, true]);
  // base_corporation.KickOut397-412 and KickOutMultipleMembers459-476 call
  // GetCorpRegistry(): both writes must stay on their originating corporation object.
  // base_corporation.__ResignFromCEO780-783 uses the same originating registry.
  for (const method of ["KickOutMember", "KickOutMembers", "ResignFromCEO"]) {
    assert.deepEqual([objectOfPageCall("corpRegistry", method), isBridgeWritePair("corpRegistry", method), isPageWritePair("corpRegistry", method)], ["corporationExpected", true, true]);
  }
  // fleetSvc.LeaveFleet: on the fleet's own object, of which the session has one. A write, and one of the page's.
  // So are KickMember and MakeLeader from the fleet's menu for a member (fleetSvc.py 601 to 612), and SendBroadcast
  // from its Broadcast Travel To Me (SendGlobalBroadcast, 983 to 990; the lists above mended by reading 2026-10-15).
  // The fleet's other calls are their routes' still.
  assert.deepEqual([objectOfPageCall("fleetObjectHandler", "LeaveFleet"), objectOfPageCall("fleetObjectHandler", "KickMember"), objectOfPageCall("fleetObjectHandler", "MakeLeader"), objectOfPageCall("fleetMgr", "ForceLeaveFleet")], ["fleet", "fleet", "fleet", null]);
  assert.deepEqual([isBridgeWritePair("fleetObjectHandler", "LeaveFleet"), isPageWritePair("fleetObjectHandler", "LeaveFleet"), isPageWritePair("fleetMgr", "ForceLeaveFleet")], [true, true, false]);
  // sensorSuiteService: the sites, asked of the object GetSystemScanMgr() answered for the system the session is
  // in. A read. The scanner's three writes are asked of the same object (scanSvc.py 195, 341 and 279), and are the
  // page's own since 2026-10-13. The scan manager's other calls are their routes' still.
  assert.deepEqual([objectOfPageCall("scanMgr", "GetFullState"), objectOfPageCall("scanMgr", "RequestScans"), objectOfPageCall("scanMgr", "GetSystemScanMgr")], ["scanManager", "scanManager", null]);
  assert.deepEqual([objectOfPageCall("scanMgr", "RecoverProbes"), objectOfPageCall("scanMgr", "ReconnectToLostProbes"), objectOfPageCall("scanMgr", "DestroyProbe"), objectOfPageCall("dogmaIM", "LaunchProbes")], ["scanManager", "scanManager", null, null]);
  // A planet's object is one of many, and the call says which. The scan manager is the session's own: nothing is said.
  const { pageNamesTheObject } = require("../src/bridgeCallPolicy");
  // A fleet by its number is named, as a planet is; the pilot's own fleet is not.
  assert.deepEqual([pageNamesTheObject("fleetByNumber"), pageNamesTheObject("fleet"), pageNamesTheObject("fleetbynumber")], [true, false, false]);
  assert.deepEqual([pageNamesTheObject("planet"), pageNamesTheObject("scanManager"), pageNamesTheObject("fleet"), pageNamesTheObject(null), pageNamesTheObject(undefined), pageNamesTheObject("constructor"), pageNamesTheObject(["planet"])], [true, false, false, false, false, false, false]);
  // A colony's commodities launched, from the command centre's own window.
  assert.equal(objectOfPageCall("planetMgr", "UserLaunchCommodities"), "planet");
  assert.deepEqual([objectOfPageCall("planetMgr", "UserTransferCommodities"), objectOfPageCall("planetMgr", "UserAbandonPlanet")], ["planet", null]);
  for (const pair of Object.keys(PAGE_OBJECT_CALLS)) {
    const [service, method] = pair.split(".");
    assert.equal(isBridgeWritePair(service, method), isPageWritePair(service, method), pair);
  }
  assert.deepEqual([isBridgeWritePair("planetMgr", "GetProgramResultInfo"), PAGE_WRITE_PAIR_KEYS.includes("planetMgr.UserUpdateNetwork")], [false, true]);
});

test("the page's writes that swap the pilot's ship are made under the BFF's watch of the swap", () => {
  const { PAGE_WRITE_PAIR_KEYS, swapsThePilotsShip, swapTargetOf } = require("../src/bridgeCallPolicy");
  // station.TryLeaveShip: the pilot in its capsule from then on.
  assert.equal(swapsThePilotsShip("ship", "LeaveShip"), true);
  assert.equal(swapsThePilotsShip("structureControl", "BoardStructure"), true);
  assert.equal(swapsThePilotsShip("structureControl", "EjectFromStructure"), true);
  assert.equal(swapTargetOf("structureControl", "BoardStructure", [1030000000001]), 1030000000001);
  assert.equal(swapTargetOf("structureControl", "EjectFromStructure", [9988400004455]), 9988400004455);
  assert.equal(swapTargetOf("structureControl", "EjectFromStructure", [null]), null);
  assert.equal(swapsThePilotsShip("structureCargoDelivery", "DropOffItems"), false);
  // A follow is made as its routes made it: held back where the ship already flies it, and through the gateway
  // with the throttle opened first. The throttle and the page's other orders to the ship go as they are asked.
  const { PAGE_FOLLOW_CALLS, ordersAFollow } = require("../src/bridgeCallPolicy");
  assert.deepEqual([...PAGE_FOLLOW_CALLS], ["beyonce.CmdFollowBall", "beyonce.CmdOrbit"]);
  assert.deepEqual([ordersAFollow("beyonce", "CmdFollowBall"), ordersAFollow("beyonce", "CmdSetSpeedFraction"), ordersAFollow("beyonce", "CmdAlignTo"), ordersAFollow("beyonce", "CmdOrbit"), ordersAFollow("ship", "CmdFollowBall")], [true, false, false, true, false]);
  assert.deepEqual([ordersAFollow("beyonce", "CmdStop"), ordersAFollow("ship", "CmdOrbit"), ordersAFollow("beyonce", ["CmdOrbit"])], [false, false, false]);
  assert.deepEqual([ordersAFollow(["beyonce"], "CmdFollowBall"), ordersAFollow("beyonce", ["CmdFollowBall"]), ordersAFollow(null, undefined)], [false, false, false]);
  for (const pair of PAGE_FOLLOW_CALLS) assert.equal(PAGE_WRITE_PAIR_KEYS.includes(pair), true, pair);
  // station.CreateNewbieShip: the pilot in a corvette from then on.
  assert.equal(swapsThePilotsShip("dogmaIM", "CreateNewbieShip"), true);
  // The ship's other swaps have their routes; and a write that swaps nothing is none.
  for (const [service, method] of [["ship", "Eject"], ["ship", "BoardStoredShip"], ["dogmaIM", "Activate"], ["dogmaIM", "LeaveShip"], ["ship", "CreateNewbieShip"], ["skillHandler", "SaveNewQueue"], ["ship", ""], [["ship"], "LeaveShip"], ["ship", ["LeaveShip"]], [null, undefined]]) {
    assert.equal(swapsThePilotsShip(service, method), false, `${service}.${method}`);
  }
  assert.deepEqual([PAGE_WRITE_PAIR_KEYS.includes("ship.LeaveShip"), PAGE_WRITE_PAIR_KEYS.includes("dogmaIM.CreateNewbieShip")], [true, true]);
});
