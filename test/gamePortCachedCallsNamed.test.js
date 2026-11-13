"use strict";

// What the client's own code tells its object cache to forget (src/gamePort/cachedCallsNamed.js): on a notice,
// on a change to the session, and beside one of its own calls. Each case is what the client's function names,
// read out of the decompiled client; the file and line are beside each row of the tables.

const test = require("node:test");
const assert = require("node:assert/strict");

const { NAMED_AFTER_CALL, NAMED_ON_NOTICE, namedAfterCall, namedOnNotice, namedOnSessionChange } = require("../src/gamePort/cachedCallsNamed");

const CHARACTER = 140000002n;
const CORPORATION = 98000000;
const SESSION = { charid: CHARACTER, corpid: CORPORATION };
const keyVal = (fields) => ({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: Object.entries(fields).map(([name, value]) => [Buffer.from(name), value]) } });

// The notice as this server sends it, off the game port: a list of KeyVals, each with the order's fields as a
// dict's entries, then the reason, then whether it is the corporation's. (The shape is from a buy order placed
// on the running server and read off the BFF; the numbers are made up.)
const order = (typeID, more = {}) => keyVal({ orderID: 77, typeID, charID: 140000002, regionID: 10000002, stationID: 60003760, range: -1, bid: 1, price: 0.01, volEntered: 1, volRemaining: 1, ...more });
const ownOrdersChanged = (orders) => [orders, Buffer.from("Created"), 0];

const MARKET_ALWAYS = [["marketProxy", "GetSystemAsks", []], ["marketProxy", "GetStationAsks", []], ["marketProxy", "GetMarketOrderHistory", []], ["marketProxy", "GetPlexBest", []]];

test("OnOwnOrdersChanged names the pilot's orders, the book of each order's type, the plex orders once an order, and the market's four", () => {
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", ownOrdersChanged({ type: "list", items: [order(34)] }), SESSION), [
    ["marketProxy", "GetCharOrders", []],
    ["marketProxy", "GetOrders", [34]],
    ["marketProxy", "GetPlexOrders", []],
    ...MARKET_ALWAYS,
  ]);
  // Two orders: each one's type, and the plex orders named for each, as the client's loop has it.
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", ownOrdersChanged([order(34), order(35)]), SESSION), [
    ["marketProxy", "GetCharOrders", []],
    ["marketProxy", "GetOrders", [34]],
    ["marketProxy", "GetPlexOrders", []],
    ["marketProxy", "GetOrders", [35]],
    ["marketProxy", "GetPlexOrders", []],
    ...MARKET_ALWAYS,
  ]);
});

test("OnOwnOrdersChanged with no orders names no type's book, and an order that names no type is not made into a call", () => {
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", ownOrdersChanged(null), SESSION), [["marketProxy", "GetCharOrders", []], ...MARKET_ALWAYS]);
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", ownOrdersChanged({ type: "list", items: [] }), SESSION), [["marketProxy", "GetCharOrders", []], ...MARKET_ALWAYS]);
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", ownOrdersChanged([keyVal({ orderID: 77 })]), SESSION), [["marketProxy", "GetCharOrders", []], ["marketProxy", "GetPlexOrders", []], ...MARKET_ALWAYS]);
  // No arguments at all.
  assert.deepEqual(namedOnNotice("OnOwnOrdersChanged", undefined, SESSION), [["marketProxy", "GetCharOrders", []], ...MARKET_ALWAYS]);
});

test("the medals' notices name the corporation's medals and a medal's recipients, or the pilot's own", () => {
  assert.deepEqual(namedOnNotice("OnCorporationMedalAdded", [501], SESSION), [["corporationSvc", "GetAllCorpMedals", [CORPORATION]], ["corporationSvc", "GetRecipientsOfMedal", [501]]]);
  assert.deepEqual(namedOnNotice("OnMedalIssued", [], SESSION), [["corporationSvc", "GetMedalsReceived", [CHARACTER]]]);
  assert.deepEqual(namedOnNotice("OnMedalStatusChanged", [1, 2], SESSION), [["corporationSvc", "GetMedalsReceived", [CHARACTER]]]);
  // A session that does not say whose: there is no such call to name.
  assert.deepEqual(namedOnNotice("OnCorporationMedalAdded", [501], {}), [["corporationSvc", "GetRecipientsOfMedal", [501]]]);
  assert.deepEqual(namedOnNotice("OnMedalIssued", [], {}), []);
  assert.deepEqual(namedOnNotice("OnMedalIssued", [], null), []);
});

test("asset safety made names the corporation's assets there and its safety list, for the corporation's own only", () => {
  const made = (ownerID) => namedOnNotice("OnAssetSafetyCreated", [ownerID, 30000142, 1030000000001n], SESSION);
  const named = [["corpmgr", "GetAssetInventoryForLocation", [CORPORATION, 1030000000001n, "offices"]], ["structureAssetSafety", "GetItemsInSafetyForCorp", []]];
  // The owner is the corporation however the number came off the wire.
  assert.deepEqual([made(98000000), made(98000000n), made({ type: "long", value: "98000000" })], [named, named, named]);
  assert.deepEqual([made(CHARACTER), made(98000001), made(null)], [[], [], []]);
  // With no corporation known, no owner is the corporation: not None either.
  assert.deepEqual(namedOnNotice("OnAssetSafetyCreated", [null, 30000142, 5], {}), []);
});

test("asset safety delivered names the corporation's safety list, or else the pilot's own, or nothing", () => {
  const delivered = (ownerID) => namedOnNotice("OnAssetSafetyDelivered", [ownerID], SESSION);
  assert.deepEqual(delivered(CORPORATION), [["structureAssetSafety", "GetItemsInSafetyForCorp", []]]);
  assert.deepEqual(delivered(140000002), [["structureAssetSafety", "GetItemsInSafetyForCharacter", []]]);
  assert.deepEqual(delivered(140000009), []);
});

test("a calendar event edited names its responses where its time changed, and one answered from outside names them by the event's owner", () => {
  const edited = (was, is) => namedOnNotice("OnEditCalendarEvent", [9001, 140000005, was, is, 60, Buffer.from("title"), 0], SESSION);
  assert.deepEqual(edited(134360000000000000n, 134360000600000000n), [["calendarMgr", "GetResponsesToEvent", [9001, 140000005]]]);
  assert.deepEqual(edited(134360000000000000n, 134360000000000000n), []);
  assert.deepEqual(edited(134360000000000000n, { type: "long", value: "134360000000000000" }), [], "the same time however it came");
  assert.deepEqual(namedOnNotice("OnEventResponseByExternal", [9001, keyVal({ ownerID: 98000000, flag: 2 }), 1], SESSION), [["calendarMgr", "GetResponsesToEvent", [9001, 98000000]]]);
  assert.deepEqual(namedOnNotice("OnEventResponseByExternal", [9001, keyVal({ flag: 2 }), 1], SESSION), [], "an event that names no owner");
});

test("the notices that name the same calls whatever they carry", () => {
  const killRights = [["bountyProxy", "GetMyKillRights", []]];
  const ranks = [["facWarMgr", "GetMyCharacterRankInfo", []], ["facWarMgr", "GetMyCharacterRankOverview", []]];
  assert.deepEqual(namedOnNotice("OnCommunityFittingsUpdated", [], SESSION), [["corpFittingMgr", "GetCommunityFittings", []]]);
  assert.deepEqual(namedOnNotice("OnNPCStandingChange", [1000125, 1.5, 1.2], SESSION), ranks);
  assert.deepEqual(namedOnNotice("OnKillNotification", [], SESSION), [["charMgr", "GetRecentShipKillsAndLosses", [25, null]]]);
  assert.deepEqual(namedOnNotice("OnStationInformationUpdated", [60003760], SESSION), [["stationSvc", "GetStation", [60003760]]]);
  assert.deepEqual(namedOnNotice("OnStationInformationUpdated", [], SESSION), [], "a station that is not named");
  assert.deepEqual([namedOnNotice("OnKillRightCreated", [1, 2, 3, 4], SESSION), namedOnNotice("OnKillRightUsed", [1, 2], SESSION), namedOnNotice("OnKillRightForYouSold", [1], SESSION)], [killRights, killRights, killRights]);
  assert.deepEqual(namedOnNotice("OnBrowserLockdownChange", [1], SESSION), [["browserLockdownSvc", "IsBrowserInLockdown", []]]);
  assert.deepEqual(namedOnNotice("OnFlaggedListsChange", [], SESSION), [["browserLockdownSvc", "GetFlaggedSitesList", []], ["browserLockdownSvc", "GetFlaggedSitesHash", []]]);
  // Each asking has a list of its own: one changed is not the next one's.
  namedOnNotice("OnKillRightUsed", [], SESSION).push("x");
  namedOnNotice("OnNPCStandingChange", [], SESSION).push("x");
  assert.deepEqual([namedOnNotice("OnKillRightUsed", [], SESSION), namedOnNotice("OnNPCStandingChange", [], SESSION)], [killRights, ranks]);
});

test("a notice the client names nothing on names nothing, and so does a name that is only an object's own", () => {
  for (const method of ["OnItemChange", "OnTarget", "", "constructor", "toString", "hasOwnProperty", "__proto__", null, undefined, 7]) {
    assert.deepEqual(namedOnNotice(method, [1, 2], SESSION), [], String(method));
  }
});

test("the notices with a row are the ones read out of the client", () => {
  assert.deepEqual(Object.keys(NAMED_ON_NOTICE).sort(), [
    "OnAssetSafetyCreated", "OnAssetSafetyDelivered", "OnBrowserLockdownChange", "OnCommunityFittingsUpdated", "OnCorporationMedalAdded",
    "OnEditCalendarEvent", "OnEventResponseByExternal", "OnFlaggedListsChange", "OnKillNotification", "OnKillRightCreated", "OnKillRightForYouSold",
    "OnKillRightUsed", "OnMedalIssued", "OnMedalStatusChanged", "OnNPCStandingChange", "OnOwnOrdersChanged", "OnStationInformationUpdated",
  ]);
  assert.deepEqual(Object.keys(NAMED_AFTER_CALL).sort(), [
    "bountyProxy.AddToBounty", "bountyProxy.CancelSellKillRight", "bountyProxy.SellKillRight",
    "calendarMgr.SendEventResponse", "calendarMgr.UpdateEventParticipants", "officeManager.TrashImpoundedOffice", "officeManager.UnrentOffice", "structureAssetSafety.MoveSafetyWrapToStructure",
  ]);
});

test("beside an impounded office trashed: the impounded items at the station its object was bound for", () => {
  // corp_ui_accounts.py 411: InvalidateCachedMethodCall('corpmgr', 'GetAssetInventoryForLocation', session.corpid,
  // stationID, 'impounded'), the station of Moniker('officeManager', stationID).TrashImpoundedOffice().
  assert.deepEqual(namedAfterCall("officeManager", "TrashImpoundedOffice", [], { corpid: 98000001 }, 60003760), [["corpmgr", "GetAssetInventoryForLocation", [98000001, 60003760, "impounded"]]]);
  // With no station it was bound for, there is no such call to forget.
  assert.deepEqual(namedAfterCall("officeManager", "TrashImpoundedOffice", [], { corpid: 98000001 }), []);
});

test("beside an office given up: the corporation's assets where the session is docked, in a station or a structure", () => {
  // officeManager.py 121: InvalidateCachedMethodCall('corpmgr', 'GetAssetInventoryForLocation', session.corpid,
  // session.stationid or session.structureid, 'offices').
  const assets = (where) => [["corpmgr", "GetAssetInventoryForLocation", [98000001, where, "offices"]]];
  assert.deepEqual(namedAfterCall("officeManager", "UnrentOffice", [], { corpid: 98000001, stationid: 60003760, structureid: null }), assets(60003760));
  assert.deepEqual(namedAfterCall("officeManager", "UnrentOffice", [], { corpid: 98000001, stationid: null, structureid: 1052851966475n }), assets(1052851966475n));
  // In neither, there is no such call to forget.
  assert.deepEqual(namedAfterCall("officeManager", "UnrentOffice", [], { corpid: 98000001, stationid: null, structureid: null }), []);
  assert.deepEqual(namedAfterCall("officeManager", "UnrentOffice", [], { corpid: 98000001 }), []);
  // Renting names nothing.
  assert.deepEqual(namedAfterCall("officeManager", "RentOffice", [10000], { corpid: 98000001, stationid: 60003760 }), []);
});

test("beside one of the pilot's own calls: what the client's function names once the call is done", () => {
  const killRights = [["bountyProxy", "GetMyKillRights", []]];
  assert.deepEqual(namedAfterCall("structureAssetSafety", "MoveSafetyWrapToStructure", [5, 30000142], SESSION), [
    ["structureAssetSafety", "GetStructuresICanDeliverTo", []],
    ["structureAssetSafety", "GetItemsInSafetyForCharacter", []],
    ["structureAssetSafety", "GetItemsInSafetyForCorp", []],
  ]);
  assert.deepEqual(namedAfterCall("bountyProxy", "AddToBounty", [140000009, 100000], SESSION), [["charMgr", "GetPublicInfo3", [140000009]]]);
  assert.deepEqual([namedAfterCall("bountyProxy", "CancelSellKillRight", [3, 4], SESSION), namedAfterCall("bountyProxy", "SellKillRight", [3, 500, null], SESSION)], [killRights, killRights]);
  assert.deepEqual(namedAfterCall("calendarMgr", "SendEventResponse", [9001, 98000000, 1], SESSION), [["calendarMgr", "GetResponsesToEvent", [9001, 98000000]]]);
  // An event's own guests changed: its responses as the pilot's own event.
  assert.deepEqual(namedAfterCall("calendarMgr", "UpdateEventParticipants", [9001, [140000009], []], SESSION), [["calendarMgr", "GetResponsesToEvent", [9001, CHARACTER]]]);
  assert.deepEqual(namedAfterCall("calendarMgr", "UpdateEventParticipants", [null, [], []], SESSION), []);
  assert.deepEqual(namedAfterCall("calendarMgr", "UpdateEventParticipants", [], SESSION), []);
  // Calls with an argument missing name nothing that needs it.
  assert.deepEqual([namedAfterCall("bountyProxy", "AddToBounty", [], SESSION), namedAfterCall("calendarMgr", "SendEventResponse", [9001], SESSION)], [[], []]);
});

test("a call the client names nothing beside names nothing", () => {
  for (const [service, method] of [["marketProxy", "PlaceBuyOrder"], ["slash", "SlashCmd"], ["bountyProxy", "GetMyKillRights"], ["calendarMgr", "constructor"], ["", ""], ["constructor", "constructor"]]) {
    assert.deepEqual(namedAfterCall(service, method, [1, 2], SESSION), [], `${service}.${method}`);
  }
  assert.deepEqual(namedAfterCall("bountyProxy", "SellKillRight", undefined, null), [["bountyProxy", "GetMyKillRights", []]], "with no arguments and no session to read");
});

test("another corporation names the pilot's employment record; in or out of a militia names the ranks, the corporation's standing in the war, and the record", () => {
  const employment = ["corporationSvc", "GetEmploymentRecord", [CHARACTER]];
  assert.deepEqual(namedOnSessionChange({ corpid: [98000000, 1000044] }, SESSION), [employment]);
  assert.deepEqual(namedOnSessionChange({ warfactionid: [null, 500001] }, SESSION), [
    ["facWarMgr", "GetMyCharacterRankInfo", []],
    ["facWarMgr", "GetMyCharacterRankOverview", []],
    ["facWarMgr", "GetCorpFactionalWarStatus", []],
    employment,
  ]);
  assert.equal(namedOnSessionChange({ corpid: [1, 2], warfactionid: [null, 500001] }, SESSION).length, 5);
  // Any other change names nothing; and with no character, a corporation changing names nothing (bool(session.charid)).
  assert.deepEqual(namedOnSessionChange({ stationid: [60003760, null], shipid: [1, 2] }, SESSION), []);
  assert.deepEqual([namedOnSessionChange({ corpid: [1, 2] }, {}), namedOnSessionChange({ corpid: [1, 2] }, { charid: null }), namedOnSessionChange({ corpid: [1, 2] }, { charid: 0 }), namedOnSessionChange({ corpid: [1, 2] }, null)], [[], [], [], []]);
  // A militia change with no character: the three that need none.
  assert.equal(namedOnSessionChange({ warfactionid: [500001, null] }, {}).length, 3);
  assert.deepEqual([namedOnSessionChange(null, SESSION), namedOnSessionChange(undefined, SESSION), namedOnSessionChange({}, SESSION)], [[], [], []]);
});
