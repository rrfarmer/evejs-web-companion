"use strict";

// What the retail client's own code tells its object cache to forget, and when.
//
// The object cache keeps a service's answers the server marked as cached
// (session.js cachedMethodCall). The server says how long each is good for,
// and some are good for the whole run: this server answers a pilot's own
// market orders so. What makes the client ask again before then is the server
// naming the call, or the client's own code naming it:
//
//   sm.GetService('objectCaching').InvalidateCachedMethodCall(service, method, *args)
//   ...InvalidateCachedMethodCalls([(service, method, args), ...])
//
// The client names calls at some sixty places, of three kinds:
//
//   on a notice from the server      NAMED_ON_NOTICE, by the notice's name
//   on a change to its session       namedOnSessionChange
//   beside one of its own calls      NAMED_AFTER_CALL, by the call
//
// Each row answers the calls named, as [service, method, args], with the
// arguments the client's code gives. The session's object cache works out
// the key: the session's value an answer is kept by is its to put in, as it
// is the client's cache's (objectCaching.InvalidateCachedMethodCalls).
//
// A row is a no-op where nothing is kept under the name, which on this server
// is most of them: it marks some thirty methods as cached, and of those the
// rows here name the market's, the corporation's medals, a station, and the
// corporation's assets and asset safety.
//
// Not here, each for its reason:
//
//   Calls the BFF cannot make. The mailing lists' members (mailingListsSvc.py
//   100 to 134), the militia's joining and leaving (facWarSvc.py 212 to 269),
//   a character's looks (ccSvc.py 115 to 139), the access
//   groups' (accessGroupsController.py), the development indices' (sovSvc.py
//   131). A row for a call nothing here makes would be dead.
//
//   Names that need an item's owner, flag and station: items delivered to a
//   corporation's hangar or a member, a stack split and items trashed at
//   another station (invItemFunctions.py 287, called at 328, 372, 399, 625).
//
//   Names given on a refusal: a kill right that turned out not to be there
//   (bountySvc.py 337), a donation whose tax had changed (infrastructureHub.py
//   169).
//
//   Names that hang on what a window holds: the community's fittings when the
//   server's settings turn them off (fittingSvc.py 1265), a militia retired
//   from (enlistmentUtil.py 128), a bloodline changed (ccSvc.py 134), a tale
//   of one kind removed (contentProviderPirateStronghold.py 22), and the two
//   a GM has (bountySvc.py 235, assetSafetyEntry.py 55).

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);

/** A whole number as a BigInt, whichever way it came off the wire; null for anything else. */
function whole(value) {
  const inner = value && typeof value === "object" && !Buffer.isBuffer(value) && Object.hasOwn(value, "value") ? value.value : value;
  if (typeof inner === "bigint") return inner;
  if (typeof inner === "number") return Number.isSafeInteger(inner) ? BigInt(inner) : null;
  return typeof inner === "string" && /^-?\d+$/.test(inner) ? BigInt(inner) : null;
}

/** Whether two IDs are one: `ownerID == session.corpid`. Nothing is the same as nothing known. */
const sameID = (one, other) => whole(one) !== null && whole(one) === whole(other);

/** A field of a util.KeyVal off the wire, whose state is a dict. Undefined where it has none of that name. */
function fieldOf(value, name) {
  const state = value && value.type === "object" ? value.args : value;
  const entries = state && state.type === "dict" && Array.isArray(state.entries) ? state.entries : [];
  const found = entries.find((entry) => Array.isArray(entry) && text(entry[0]) === name);
  return found ? found[1] : undefined;
}

const KILL_RIGHTS = Object.freeze([["bountyProxy", "GetMyKillRights", []]]);
const medalsReceived = (args, session) => [["corporationSvc", "GetMedalsReceived", [session.charid]]];
const RANKS = Object.freeze([["facWarMgr", "GetMyCharacterRankInfo", []], ["facWarMgr", "GetMyCharacterRankOverview", []]]);

/** On a notice from the server, by its name: (the notice's arguments, the session's attributes) => the calls named. */
const NAMED_ON_NOTICE = Object.freeze({
  // marketsvc.py 113, MarketQuote.OnOwnOrdersChanged(orders, reason, isCorp). The plex orders are named once
  // for each order, as the loop there has it.
  OnOwnOrdersChanged: ([orders = null]) => [
    ["marketProxy", "GetCharOrders", []],
    ...(orders === null ? [] : items(orders).flatMap((order) => [["marketProxy", "GetOrders", [fieldOf(order, "typeID")]], ["marketProxy", "GetPlexOrders", []]])),
    ["marketProxy", "GetSystemAsks", []],
    ["marketProxy", "GetStationAsks", []],
    ["marketProxy", "GetMarketOrderHistory", []],
    ["marketProxy", "GetPlexBest", []],
  ],
  // fittingSvc.py 1269, OnCommunityFittingsUpdated, which names it where it holds the community's fittings.
  OnCommunityFittingsUpdated: () => [["corpFittingMgr", "GetCommunityFittings", []]],
  // eveCalendarsvc.py 352, OnEditCalendarEvent(eventID, ownerID, oldEventDateTime, eventDateTime, ...): named
  // where the event's time changed.
  OnEditCalendarEvent: ([eventID, ownerID, oldEventDateTime, eventDateTime]) => (whole(oldEventDateTime) === whole(eventDateTime)
    ? []
    : [["calendarMgr", "GetResponsesToEvent", [eventID, ownerID]]]),
  // eveCalendarsvc.py 409, OnEventResponseByExternal(eventID, eventKV, response), through _RespondToEvent (300).
  OnEventResponseByExternal: ([eventID, eventKV]) => [["calendarMgr", "GetResponsesToEvent", [eventID, fieldOf(eventKV, "ownerID")]]],
  // facWarSvc.py 308, OnNPCStandingChange.
  OnNPCStandingChange: () => RANKS,
  // medals.py 120, 131, 139.
  OnCorporationMedalAdded: ([medalID], session) => [["corporationSvc", "GetAllCorpMedals", [session.corpid]], ["corporationSvc", "GetRecipientsOfMedal", [medalID]]],
  OnMedalIssued: medalsReceived,
  OnMedalStatusChanged: medalsReceived,
  // assetSafetySvc.py 58, OnAssetSafetyCreated(ownerID, solarSystemID, locationID): the corporation's only.
  OnAssetSafetyCreated: ([ownerID, , locationID], session) => (sameID(ownerID, session.corpid)
    ? [["corpmgr", "GetAssetInventoryForLocation", [session.corpid, locationID, "offices"]], ["structureAssetSafety", "GetItemsInSafetyForCorp", []]]
    : []),
  // assetSafetySvc.py 65, OnAssetSafetyDelivered(ownerID): the corporation's, or else the pilot's own.
  OnAssetSafetyDelivered: ([ownerID], session) => {
    if (sameID(ownerID, session.corpid)) return [["structureAssetSafety", "GetItemsInSafetyForCorp", []]];
    return sameID(ownerID, session.charid) ? [["structureAssetSafety", "GetItemsInSafetyForCharacter", []]] : [];
  },
  // charactersheet.py 90, OnKillNotification.
  OnKillNotification: () => [["charMgr", "GetRecentShipKillsAndLosses", [25, null]]],
  // station/base.py 589, OnStationInformationUpdated(stationID).
  OnStationInformationUpdated: ([stationID]) => [["stationSvc", "GetStation", [stationID]]],
  // bountySvc.py 154, 158, 171.
  OnKillRightCreated: () => KILL_RIGHTS,
  OnKillRightUsed: () => KILL_RIGHTS,
  OnKillRightForYouSold: () => KILL_RIGHTS,
  // carbonui/control/browser/sites.py 335, 442.
  OnBrowserLockdownChange: () => [["browserLockdownSvc", "IsBrowserInLockdown", []]],
  OnFlaggedListsChange: () => [["browserLockdownSvc", "GetFlaggedSitesList", []], ["browserLockdownSvc", "GetFlaggedSitesHash", []]],
});

/** Beside one of the client's own calls, once it is done, by the call: (its arguments, the session's attributes, what
 * the call's object was bound by, for a call on a moniker) => the calls named. */
const NAMED_AFTER_CALL = Object.freeze({
  // corp_ui_accounts.py 411, TrashImpoundedItems: the impounded items at the station, named before
  // Moniker('officeManager', stationID).TrashImpoundedOffice(). Here once it is done: a trashing refused changed nothing.
  "officeManager.TrashImpoundedOffice": (args, session, bound) => [["corpmgr", "GetAssetInventoryForLocation", [session.corpid, Array.isArray(bound) ? bound[0] : bound ?? undefined, "impounded"]]],
  // officeManager.py 121, UnrentOffice: the corporation's assets where the session is docked, named before the
  // office is given up. Here once it is done: a giving up that was refused changed nothing.
  "officeManager.UnrentOffice": (args, session) => [["corpmgr", "GetAssetInventoryForLocation", [session.corpid, session.stationid || session.structureid || undefined, "offices"]]],
  // assetSafetyDeliverWindow.py 147, DoDeliver.
  "structureAssetSafety.MoveSafetyWrapToStructure": () => [
    ["structureAssetSafety", "GetStructuresICanDeliverTo", []],
    ["structureAssetSafety", "GetItemsInSafetyForCharacter", []],
    ["structureAssetSafety", "GetItemsInSafetyForCorp", []],
  ],
  // bountyWindow.py 447 and 1007, PlaceBounty: bountySvc.AddToBounty(ownerID, amount), and then the one it was put on.
  "bountyProxy.AddToBounty": ([ownerID]) => [["charMgr", "GetPublicInfo3", [ownerID]]],
  // bountySvc.py 255, 262.
  "bountyProxy.CancelSellKillRight": () => KILL_RIGHTS,
  "bountyProxy.SellKillRight": () => KILL_RIGHTS,
  // eveCalendarsvc.py 296, RespondToEvent: SendEventResponse(eventID, ownerID, response), and then _RespondToEvent (300).
  "calendarMgr.SendEventResponse": ([eventID, ownerID]) => [["calendarMgr", "GetResponsesToEvent", [eventID, ownerID]]],
  // eveCalendarsvc.py 196, UpdateEventParticipants(eventID, charsToAdd, charsToRemove): the pilot's own event.
  "calendarMgr.UpdateEventParticipants": ([eventID = null], session) => (eventID === null ? [] : [["calendarMgr", "GetResponsesToEvent", [eventID, session.charid]]]),
});

/** A row's answer, as a list of the asking's own, with the names that have an argument missing left out: there is no such call to forget. */
const withEveryArgument = (named) => named.filter(([, , args]) => args.every((arg) => arg !== undefined));

/** What the client's code names on a notice: [[service, method, args], ...], none for a notice it names nothing on. */
function namedOnNotice(method, args, attributes = {}) {
  const row = typeof method === "string" && Object.hasOwn(NAMED_ON_NOTICE, method) ? NAMED_ON_NOTICE[method] : null;
  return row ? withEveryArgument(row(Array.isArray(args) ? args : [], attributes || {})) : [];
}

/** What it names beside one of its own calls, once the call is done; `bound`, what a moniker's object was bound by. */
function namedAfterCall(service, method, args, attributes = {}, bound = undefined) {
  // A pair has a dot in it, which no name an object has of its own accord does.
  const row = NAMED_AFTER_CALL[`${service}.${method}`];
  return row ? withEveryArgument(row(Array.isArray(args) ? args : [], attributes || {}, bound)) : [];
}

/**
 * What it names on a change to its session ({name: [old, new]}).
 *
 * base_corporation_ui.py 98, CorporationUI.ProcessSessionChange: another corporation, and the pilot's
 * employment record is not what was kept. facWarSvc.py 57, OnSessionChanged: in or out of a militia, and
 * _RefreshCache (199) names four.
 */
function namedOnSessionChange(changes, attributes = {}) {
  const session = attributes || {};
  const employment = ["corporationSvc", "GetEmploymentRecord", [session.charid]];
  const named = [];
  if (changes && Object.hasOwn(changes, "corpid") && whole(session.charid) !== null && whole(session.charid) !== 0n) named.push(employment);
  if (changes && Object.hasOwn(changes, "warfactionid")) named.push(...RANKS, ["facWarMgr", "GetCorpFactionalWarStatus", []], employment);
  return withEveryArgument(named);
}

module.exports = { NAMED_AFTER_CALL, NAMED_ON_NOTICE, namedAfterCall, namedOnNotice, namedOnSessionChange };
