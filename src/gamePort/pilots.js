"use strict";

// The game-port transport for a selected pilot.
//
// src/pilotTransport.js sends a pilot's nine functions either to the web
// gateway or here. This implements them on a GamePortSession: the retail
// protocol on TCP 26000, one connection per pilot, logged in and kept alive as
// the retail client's is.
//
// The contract is the gateway client's (src/eveGatewayClient.js): the same
// arguments, the same answers, the same error codes. What the gateway does
// for each function was read from eve.js
// (server/src/_secondary/express/evejsWebGatewayRuntime.js) and is matched
// here, because everything above this module was written against it:
//
//   - A call's arguments are JSON in the marshaller's own tree, and its
//     answer is that tree as JSON (bridgeJson.js maps ours onto it).
//   - A session keeps a backlog of what the server pushed. Every answer
//     drains it; the event stream carries the same notifications as they
//     arrive. The stream is liveness, the drain is correctness.
//   - A refusal by the game is CALL_REFUSED with the handler's own words. A
//     session that is gone is SESSION_NOT_FOUND, which is what tells the BFF
//     to send the browser back to character selection.
//
// What is the game port's own:
//
//   - Selecting is what the retail client's character selection does: log in,
//     GetCharacterSelectionData, GetCharacterLockType, SelectCharacterID.
//   - The account is the one the BFF authenticated. The game port takes any
//     password on a development server, so the login name comes from the
//     BFF's signed session and the server's answer is checked against the
//     BFF's account ID before anything else is asked of it.
//   - The connection closing is the session ending. There is no time-to-live.
//
//   - A bound object is bound as the retail client binds it. The gateway's
//     "bind" calls a method as though it were a service's and keeps whatever
//     bound object comes back; the retail client first binds a service's
//     object for where the pilot is (eveMoniker.py) and then asks that for
//     the inventory (invCache.py). bindRetail() below is that translation,
//     one case per shape the BFF asks for.
//
//   - A pilot in space has a ballpark of its own, kept as the retail client
//     keeps one (pilotSpace.js): made when the session enters a solar system,
//     fed by the session, stepped once a second, and let go on docking. The
//     space snapshot and the movement half of the flight status are read from
//     it (spaceProjection.js), where the gateway reads the server's scene.
//   - The ship's own readings that the ballpark does not hold (capacitor, the
//     three capacities) are dogma's, loaded and kept as the retail client's
//     godma keeps them (pilotDogma.js).
//
// Not here yet (docs/game-port-transport-plan.md, Phase 4): the scanner in
// space, how damaged each module is, and which weapons are grouped.

const crypto = require("node:crypto");
const { GamePortSession } = require("./session");
const { connectTcp, gameEndpoint } = require("./tcp");
const { notificationToBridgeJson, sessionChangeToBridgeJson, wireToBridgeJson } = require("./bridgeJson");
const { GAME_PORT_HANDLE_PREFIX } = require("../pilotTransport");
const { GAME_PORT_ONLY_CALLS, ON_AN_ANSWERED_OBJECT, createCallLedger, madeAfresh, retailForm, retailNeeds } = require("./retailCalls");
const { createPilotSpace } = require("./pilotSpace");
const { createPilotClock } = require("./pilotClock");
const { EFFECT_CATEGORY, EFFECT_ONLINE, createPilotDogma, rowFields } = require("./pilotDogma");
const { MAX_PROBES, createPilotScanner } = require("./pilotScanner");
const { createPilotFleet } = require("./pilotFleet");
const { createPilotStandings } = require("./pilotStandings");
const { createPilotSkills } = require("./pilotSkills");
const { createPilotJournal } = require("./pilotJournal");
const { createKeptReads } = require("./keptReads");
const { createPilotStation } = require("./pilotStation");
const { CLIENT_STATE_NOTICES, statesAfter } = require("./crimewatchStates");
const { isBridgeWritePair } = require("../bridgeCallPolicy");
const { namedAfterCall, namedOnNotice, namedOnSessionChange } = require("./cachedCallsNamed");
const { brokersFeeRate } = require("./brokerFee");
const { averagePrice, historyRows } = require("./priceHistory");
const { TARGETS, TARGETERS, createPilotTargets } = require("./pilotTargets");
const { buildSkillSheet } = require("./skillSheet");
const { projectFlight, projectSpace } = require("./spaceProjection");
const { MODE: BALL_MODE } = require("./destiny/state");
const contract = require("../../contracts/evejs-web-bridge-contract.json");

/** The gateway's own codes and statuses (WEB_CALL_ERROR_STATUS_CODES), plus the gateway client's two. */
const STATUS = Object.freeze({
  CALL_INVALID: 400,
  CALL_NOT_ALLOWED: 403,
  CALL_FAILED: 502,
  CALL_REFUSED: 409,
  QUESTION_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  SESSION_SELECT_FAILED: 502,
  BOUND_HANDLE_NOT_FOUND: 404,
  BOUND_NO_OBJECT: 502,
  EVE_GATEWAY_TIMEOUT: 502,
  EVE_GATEWAY_UNREACHABLE: 502,
  PILOT_TRANSPORT_UNAVAILABLE: 501,
});

/** An error with the `code` and `statusCode` the BFF reads off a gateway error. */
class GamePortPilotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GamePortPilotError";
    this.code = code;
    this.statusCode = STATUS[code] || 502;
  }
}

const fail = (code, message) => new GamePortPilotError(code, message);

const SESSION_GONE = "Unknown, expired, or released bridge session.";
/** The gateway's event-stream envelope. The browser checks `source`, so it is the contract, not a label. */
const STREAM_SOURCE = "evejs-web-gateway";
const STREAM_HISTORY_LIMIT = 256;
/** A backlog nobody drains must not grow for ever; the stream and the next read still tell the story. */
const BACKLOG_LIMIT = 4096;
/** The gateway drops these on purpose: nothing above reads them, and they arrive ten times a second. */
const SUPPRESSED_NOTIFICATIONS = new Set(["DoDestinyUpdate"]);
/** appConst.charLockInTransferQueue, charLockOnSale: what characterSelection.py refuses with. */
const LOCK_REFUSALS = new Map([[1, "CharacterTransferring"], [2, "CharacterOnSale"]]);
const GROUP_CAPSULE = 29;
const GROUP_SCANNER_PROBE = 479;
const GROUP_SCAN_PROBE_LAUNCHER = 481;
/** inventorycommon/const.py */
const GROUP_SOLAR_SYSTEM = 5;
const GROUP_STATION = 15;
const CONTAINER_HANGAR = 10004;
/** evefleet/const.py fleetCmdrRoles: a fleet's commander, a wing's, a squad's. */
const FLEET_COMMANDER_ROLES = new Set([1, 2, 3]);
/** idCheckers.IsNPC: maxSystemItem < ownerID < minPlayerOwner. */
const MAX_SYSTEM_ITEM = 10000;
const MIN_PLAYER_OWNER = 90000000;
const CONTAINER_STRUCTURE = 10014;
/**
 * Services whose object is bound for where the pilot is. The retail client's
 * moniker for one carries a session check, and is bound afresh when the pilot
 * moves; here the handle is dropped, and the BFF binds again.
 */
const LOCATION_SERVICES = new Set(["invbroker", "ship", "dogmaIM", "crimewatch", "reprocessingSvc", "entity", "beyonce", "scanMgr"]);
const LOCATION_ATTRIBUTES = ["stationid", "structureid", "solarsystemid", "locationid"];
/**
 * Services whose moniker is for the pilot's corporation, not for where the
 * pilot is (eveMoniker.GetCorpRegistry: its session check is on corpid). It is
 * kept through a move and bound afresh when the corporation changes.
 */
const CORPORATION_SERVICES = new Set(["corpRegistry"]);
const CORP_REGISTRY = "corpRegistry";
/**
 * The service whose moniker is for the pilot's alliance (eveMoniker.GetAlliance: its session check is on
 * allianceid). Kept through a move, and made again when the alliance changes.
 */
const ALLIANCE_REGISTRY = "allianceRegistry";
/**
 * The registry's read whose answer is kept as the client keeps it: the corporation's aggression settings
 * (crimewatchSvc.corpAggressionSettings). Asked when the client asks, and from then on answered from what is kept.
 */
const AGGRESSION_SETTINGS = "GetAggressionSettings";
/**
 * Monikers the client binds for their own sake before it calls anything on them: base_corporation.GetCorpRegistry
 * makes the corporation's and calls Bind() on it, which sends MachoBindObject(params, None), and all_cso.GetMoniker
 * does the same with the alliance's. Any other binds when it is first called, with that call riding along
 * (moniker.py).
 */
const BOUND_BEFORE_USE = new Set(["corpRegistry", "allianceRegistry"]);
const NOTIFICATION_MGR = "notificationMgr";
const CALENDAR_PROXY = "calendarProxy";
/**
 * What a read of the notification manager's is kept as, for the three the client's notification service keeps:
 * all of them from the first (allNotifications: GetAllNotifications(fromID=0), as its notification window asks
 * when a character is chosen), the unread ones (unreadNotifications: GetUnprocessed()), and those of a group
 * (notifications[groupID]: GetByGroupID(groupID)). Null for any other read: all of them from a later one is asked
 * each time.
 */
function notificationKeptAs(method, form) {
  if (method === "GetAllNotifications") return form.kwargs && form.kwargs.fromID === 0 ? "all" : null;
  if (method === "GetUnprocessed") return "unread";
  return method === "GetByGroupID" ? `group:${form.args[0]}` : null;
}
/**
 * The two reads the client's station service answers from what it keeps, for a pilot docked in a station
 * (pilotStation.js): the station's guests, and its own item.
 */
const STATION_KEPT = new Set(["station.GetGuests", "stationSvc.GetStationItemBits"]);
/** A list or a tuple off the wire. */
const isAList = (value) => Array.isArray(value) || Boolean(value && value.type === "list" && Array.isArray(value.items));
const PLANET_MGR = "planetMgr";
const PLANET_INFO = "GetPlanetInfo";
/**
 * The two reads of a planet's own object that are kept by the planet (planetRead): its colony, which
 * clientPlanet.PreparePlanet asks for when the planet is first wanted (clientPlanet.py 83), and what the planet
 * carries (clientPlanet.py 644).
 */
const PLANET_READS = new Set([PLANET_INFO, "GetPlanetResourceInfo"]);
/**
 * How long a colony is kept as it was answered. The client keeps a planet's colony for as long as it has the
 * planet, and reckons what the colony makes by itself (the colony's own simulation); it asks again only when the
 * server says the planet's state changed. Nothing here reckons a colony, so what is kept is let go after a
 * minute, and asked for when it is next wanted: more often than the client asks, and never more than a minute
 * behind what a colony has made.
 */
const PLANET_INFO_KEPT_MS = 60_000;
/** The server's word that a colony is not as it was: planetSvc.OnMajorPlanetStateUpdate, and the pins it says to look at again. */
const COLONY_NOTICES = new Set(["OnMajorPlanetStateUpdate", "OnRefreshPins"]);
/** The pilot's own calls on a planet's object that change its colony or what a pin holds. */
const COLONY_WRITES = new Set(["UserUpdateNetwork", "UserLaunchCommodities", "UserTransferCommodities", "UserAbandonPlanet"]);
/** Whether one of the pilot's own calls on an object may have changed a colony: those, and goods sent between a launchpad and a customs office. */
const changesAColony = (service, method) => (service === PLANET_MGR && COLONY_WRITES.has(method)) || (service === "invbroker" && method === "ImportExportWithPlanet");
/**
 * What a read of the planet manager's is kept as: the pilot's colonies (planetSvc.colonizationData:
 * GetPlanetsForChar(), planetSvc.py 65) and its launches (planetUISvc.launchsRowSet: GetMyLaunchesDetails(),
 * planetUISvc.py 170), each asked with nothing. Null for any other read, and for one with something sent beside
 * it, which is no call of the client's and is asked as it came.
 */
const planetKeptAs = (method, form) => (form.args.length > 0 ? null : method === "GetPlanetsForChar" ? "colonies" : method === "GetMyLaunchesDetails" ? "launches" : null);
const CRIMEWATCH = "crimewatch";
/** crimewatchSvc's two reads that it keeps: its client states (the timers, the engagements, who is flagged, the safety level), and the pilot's own security status. */
const CLIENT_STATES = "GetClientStates";
const OWN_SECURITY_STATUS = "GetMySecurityStatus";
/** Whether a call is one of crimewatchSvc's two kept reads, asked as the client asks it: with nothing. */
const SET_SAFETY_LEVEL = "SetSafetyLevel";
/** The account's clone grade, which the client's clone grade service asks once and keeps (omega/client/clone_grade_svc.py 125). */
const SUBSCRIPTION_MGR = "subscriptionMgr";
const CLONE_GRADE = "GetCloneGrade";
const keptCloneGrade = (service, method, form) => service === SUBSCRIPTION_MGR && method === CLONE_GRADE && form.args.length === 0 && form.kwargs === null;
const keptOfCrimewatch = (service, method, form) => service === CRIMEWATCH && (method === CLIENT_STATES || method === OWN_SECURITY_STATUS) && form.args.length === 0 && form.kwargs === null;
const OFFICE_MANAGER = "officeManager";
/**
 * The read of the station's own office object that the client's office manager keeps (officeManager.offices,
 * officeManager.py 34): the corporations with an office where the session is docked.
 */
const STATION_OFFICES = "GetCorporationsWithOffices";
/**
 * The call the client makes once for a station's Moniker, where its corporation has an office there
 * (officeManager.GetCorpOfficeAtLocation, 106: the Moniker's isPrimed).
 */
const PRIME_OFFICE = "PrimeOfficeItem";
const STANDING_MGR = "standingMgr";
/**
 * What the client's standings service asks for when the character is chosen and keeps right from the server's
 * notices (standingsvc.py 111): the character's standings and its corporation's. Asked for again by name, as the
 * page asks when it shows them, they are answered from what is kept (refreshStandings): the client's panel reads
 * its service, and its service does not ask twice.
 */
const STANDINGS_KEPT = Object.freeze({ GetCharStandings: "char", GetCorpStandings: "corp" });
const ACCOUNT = "account";
/**
 * What the client's account service asks for once and keeps (svc.account GetStaticData, accountsvc.py 86: kept in
 * `self.data` until the character changes): the names of a wallet entry's kinds. On Tranquility it was asked once
 * while the wallet's transactions were asked three times (Archive/Open Wallet - Plex - Corp Wallet - Corp Transfers).
 */
const ACCOUNT_STATIC = new Set(["GetEntryTypes"]);
/**
 * What a read of the office manager's is kept as: the offices the pilot's corporation rents, wherever they are
 * (officeManager.corp_offices: GetMyCorporationsOffices(), officeManager.py 41), asked with nothing. Null for any
 * other read, and for one with something sent beside it, which is no call of the client's and is asked as it came.
 */
const officesKeptAs = (method, form) => (method === "GetMyCorporationsOffices" && form.args.length === 0 && form.kwargs === null ? "corporation" : null);
/** Whether a notice of an office (corporationID, officeID) is of the corporation the session is in (officeManager.py 72). */
const ofOwnCorporation = (args, attributes) => wholeOf(Array.isArray(args) ? args[0] : null) === wholeOf(attributes.corpid);
/** What a read of the calendar's is kept as: a month's events, by the month (calendar.events[(month, year)]: GetEventList(month, year)). */
const calendarKeptAs = (method, form) => (method === "GetEventList" ? `${form.args[1]}-${form.args[0]}` : null);
/**
 * The answers a service of the client's keeps until something changes them, by the service they are asked of
 * (keptReads.js). `keptAs` says what a read is kept as, or null for one that is not kept. What changes them is
 * the server's word (`notices`; where there is a `concerns`, only a notice it says yes to, by the notice's
 * arguments and the session's attributes) and the pilot's own writes, by the service each is made on (`writes`). The
 * client works each change into what it keeps (notificationSvc.py, eveCalendarsvc.py). Here everything kept of
 * the service is forgotten at any of them, and asked for when it is next wanted.
 */
const KEPT_UNTIL_CHANGED = Object.freeze({
  // notificationSvc: one received, deleted or brought back, and the pilot's own marking and deleting.
  [NOTIFICATION_MGR]: Object.freeze({
    keptAs: notificationKeptAs,
    notices: new Set(["OnNotificationReceived", "OnNotificationDeleted", "OnNotificationUndeleted"]),
    writes: Object.freeze({ notificationMgr: new Set(["MarkGroupAsProcessed", "MarkAllAsProcessed", "MarkAsProcessed", "DeleteGroupNotifications", "DeleteAllNotifications", "DeleteNotifications"]) }),
  }),
  // calendar: an event made, changed or taken away, by anyone or by the pilot. Another corporation or alliance
  // forgets them too (calendar.OnSessionChanged), which the session's change sees to.
  [CALENDAR_PROXY]: Object.freeze({
    keptAs: calendarKeptAs,
    notices: new Set(["OnNewCalendarEvent", "OnEditCalendarEvent", "OnRemoveCalendarEvent"]),
    writes: Object.freeze({ calendarMgr: new Set(["CreatePersonalEvent", "CreateCorporationEvent", "CreateAllianceEvent", "EditPersonalEvent", "EditCorporationEvent", "EditAllianceEvent", "DeleteEvent"]) }),
  }),
  // planetSvc and planetUISvc: the launches changed (OnPILaunchesChange, at which the client forgets them), a
  // planet's state changed (OnMajorPlanetStateUpdate, at which the client changes its own list of colonies), the
  // pilot removed a launch (journal.py 465: the launches asked afresh), or changed a colony's network, which is
  // done on the planet's own object and at which the client changes its own count of the colony's pins.
  [PLANET_MGR]: Object.freeze({
    keptAs: planetKeptAs,
    notices: new Set(["OnPILaunchesChange", "OnMajorPlanetStateUpdate"]),
    writes: Object.freeze({ planetMgr: new Set(["DeleteLaunch", "UserUpdateNetwork"]) }),
  }),
  // officeManager: an office rented or given up by the pilot's own corporation (OnOfficeRentalChange, 69; the
  // corporation's offices are let go only where the corporation is the session's, 72). The client lets nothing go
  // at its own renting: the server's word of it does that. Another corporation forgets them too
  // (officeManager.OnSessionChanged, 62), which the session's change sees to.
  [OFFICE_MANAGER]: Object.freeze({
    keptAs: officesKeptAs,
    notices: new Set(["OnOfficeRentalChange"]),
    concerns: ofOwnCorporation,
    writes: Object.freeze({}),
  }),
});
/**
 * A container's two listings, which the client's inventory cache keeps (invCacheContainer.List, ListByFlags, in
 * invCache.py): a flag's items are asked for once, and from then on the cache goes by the server's word of each
 * item that changes. Here a listing is kept as the server answered it, by the handle it was asked on and what
 * was asked, and every listing is forgotten when anything may have changed one: at either of the server's two
 * notices of an item, in another place or ship, and at any write of the pilot's own, done or refused. What is
 * forgotten is asked for when it is next wanted. (The client works each change into what it holds, and asks
 * again for nothing.)
 */
const INVENTORY_LISTINGS = new Set(["List", "ListByFlags"]);
const ITEM_NOTICES = new Set(["OnItemChange", "OnItemsChanged"]);
const MARKET_PROXY = "marketProxy";
/** The clock's 100 ns ticks at the start of Unix time. */
const FILETIME_OF_UNIX_EPOCH = 116444736000000000n;
/** invconst.typeBrokerRelations. */
const TYPE_BROKER_RELATIONS = 3446;
const OWN_ORDERS = "GetCharOrders";

/** A whole number as a BigInt, a number or a long off the wire; null for anything else. */
function wholeOf(value) {
  if (typeof value === "bigint") return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
}

/**
 * One line of a Rowset off the wire (header, lines), by the whole number one column has: its values by the
 * columns' names, each as it came. Null where it is no Rowset with that column, or no line has that number.
 */
function rowsetLine(rowset, column, wanted) {
  const entries = rowset && rowset.type === "object" && rowset.args && Array.isArray(rowset.args.entries) ? rowset.args.entries : [];
  const part = (name) => (entries.find((entry) => Array.isArray(entry) && textOf(entry[0]) === name) ?? [])[1];
  const header = itemsOf(part("header")).map(textOf);
  const at = header.indexOf(column);
  const number = wholeOf(wanted);
  if (at === -1 || number === null) return null;
  const line = itemsOf(part("lines")).map(itemsOf).find((values) => wholeOf(values[at]) === number);
  return line ? Object.fromEntries(header.map((name, index) => [name, line[index]])) : null;
}
/** The dogma location's calls that lock and unlock: a write each, and no container's contents are changed by one. */
const TARGETING = new Set(["AddTarget", "CancelAddTarget", "RemoveTarget", "RemoveTargets", "ClearTargets"]);
/**
 * Whether one of the pilot's own calls may have changed what a container holds: any the BFF counts as a write
 * (bridgeCallPolicy.js), but for an order to the ship's engines and a lock, which move no item.
 */
const mayChangeContents = (service, method) => isBridgeWritePair(service, method) && service !== "beyonce" && !(service === "dogmaIM" && TARGETING.has(method));
/** What a listing is kept as: the handle, and what was asked as it is sent, which says which of the two it is (flag=, or flags=). */
const listingKeptAs = (boundHandle, form) => `${boundHandle}|${JSON.stringify([form.args, form.kwargs], (key, value) => (typeof value === "bigint" ? String(value) : value))}`;
/** The dogma location's two reads the client's target service keeps the answers of, by what each is kept as (pilotTargets.js). */
const TARGETS_KEPT = Object.freeze({ GetTargets: TARGETS, GetTargeters: TARGETERS });
/** calendar.FetchNextEvents: the month of a time and the month after it, each as [month, year], December's next being January's (GetBrowsedMonth). */
function monthAndNext(ms) {
  const now = new Date(ms);
  const [month, year] = [now.getUTCMonth() + 1, now.getUTCFullYear()];
  return [[month, year], month === 12 ? [1, year + 1] : [month + 1, year]];
}
/** The name the BFF asks the skill handler's reads by. What they are bound by is what the handler's own moniker says. */
const SKILL_HANDLER = "skillHandler";
/**
 * The handler's reads the client's skill services keep the answers of, by what each is kept as (pilotSkills.js):
 * asked for when first wanted, and from then on answered from what is kept (skillsvc.GetSkills,
 * GetSkillsIncludingLapsed, GetBoosters, GetImplants, GetCharacterAttributes, GetSkillHistory, GetFreeSkillPoints,
 * GetRespecInfo).
 */
const SKILL_KEPT = Object.freeze({
  GetSkills: "skills",
  GetAllSkills: "allSkills",
  GetBoosters: "boosters",
  GetImplants: "implants",
  GetAttributes: "attributes",
  GetSkillHistory: "history",
  GetFreeSkillPoints: "freeSkillPoints",
  GetRespecInfo: "respecInfo",
});
/**
 * What a real client asked of its skill handler when its character was chosen, in the order it asked this server
 * (the server's log of 2026-10-06, where the first went with the bind): the skill service's own list, the boosters,
 * the queue (skillQueueSvc.PrimeSkillQueue), the list with the lapsed, and the notifications' two
 * (skillHistoryProvider.py: CheckAndSendNotifications(), then GetSkillHistory(10), which is what the skill service
 * then has kept as the history). Tranquility's recording of a login has the same six, the boosters with the bind,
 * and after them the boosters again, the implants and the attributes (GetCharacterAttributes), which neither log
 * of a real client on this server has at login: here those three are asked when something first wants them.
 */
const SKILL_LOGIN_READS = Object.freeze([
  ["GetSkills", []],
  ["GetBoosters", []],
  ["GetSkillQueueAndFreePoints", []],
  ["GetAllSkills", []],
  ["CheckAndSendNotifications", []],
  ["GetSkillHistory", [10]],
]);
/**
 * The client's home station service (homestation/client/service.py): it asks the server's for the home station
 * once and keeps it, until one of its notices says otherwise or the pilot's corporation changes.
 */
const HOME_STATION = "home_station";
const GET_HOME_STATION = "get_home_station";
/** OnHomeStationChanged(newHomeStationID) and OnHomeStationMovedFromStructure(): the station kept is not the home any more. */
const HOME_STATION_NOTICES = new Set(["OnHomeStationChanged", "OnHomeStationMovedFromStructure"]);
/** skillQueueSvc.PrimeSkillQueue's read: (the queue, the free points). The queue service keeps the queue. */
const SKILL_QUEUE_READ = "GetSkillQueueAndFreePoints";
/** Whether a call of the handler's is the queue service's own read, as it asks it: with nothing. */
const isSkillQueueRead = (method, args, kwargs) => method === SKILL_QUEUE_READ && args.length === 0 && kwargs === null;
const MONIKER_CLASS = "carbon.common.script.net.moniker.Moniker";

/**
 * A Moniker as it arrives in an answer: its state is (service, nodeID, bindParams, sessionCheck) (moniker.py
 * __getstate__). Null for anything else, or for one with no service or nothing to bind by.
 */
function monikerOf(value) {
  if (!value || textOf(value.name) !== MONIKER_CLASS || !Array.isArray(value.args)) return null;
  const [service, nodeID, params] = value.args;
  if (!textOf(service) || params === null || params === undefined) return null;
  return { service: textOf(service), nodeID: positive(nodeID), params };
}

/**
 * How long a call waits once the server has said its answer will be late. The
 * client waits a day for the player; the browser's request behind this call
 * does not, so past this the call fails as one the server never answered.
 */
const PROVISIONAL_WAIT_LIMIT_MS = 120_000;

/**
 * How long a question waits for the user. Shorter than the wait above, so
 * that a question nobody answers is closed, and the call behind it finished,
 * before whoever made that call gives up on it.
 */
const QUESTION_WAIT_MS = 110_000;
/** An account's own connection, with no character chosen, is closed this long after the last call on it. */
const ACCOUNT_IDLE_MS = 5_000;

/** A localisation label as the server sends one, (labelID, {parameters}), or plain text. */
function words(value) {
  if (Array.isArray(value)) {
    return { label: textOf(value[0]), parameters: wireToBridgeJson(value[1] ?? null), text: null };
  }
  return { label: null, parameters: null, text: textOf(value) };
}

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && typeof value.value === "string") return value.value;
  return null;
};

/**
 * What this client's own services answer when the server calls them, or
 * undefined for a call it has no answer to. The server makes these calls and
 * waits; on the retail client most of them put a window in front of the player.
 *
 *   agents.YesNo(title, body, agentID, contentID, suppressID)
 *       ui/station/agents/agents.py 404: a Yes/No window, answered with whether
 *       Yes was pressed. The server asks it before a mission is quit or
 *       declined and before research is cancelled. The question goes to the
 *       user (`askUser`), and anything but Yes is No, as closing the window is.
 *       With nobody to ask it is answered Yes: a hosted bot pressed the button,
 *       and the client answers the same way at once, with no window, when the
 *       player has ticked "do not show this again" (prompt_player's suppress_id).
 *   agents.SingleChoiceBox(title, body, choices, agentID, contentID, suppressID)
 *       agents.py 437: a box of radio buttons with OK and Cancel, which a
 *       research agent raises to ask what to research. Answers (OK pressed,
 *       the selected button's name), the name being "radioboxOption<n>Selected"
 *       counted from 1 (radioButtonMessageBox.py 48), on Cancel too. Dismissed
 *       when there is nobody to ask: the first button, and not OK.
 *   agents.GetQuantity(**keywords)
 *       agents.py 469: uix.QtyPopup(maxvalue, minvalue, setvalue, hint, caption,
 *       label, digits), a number box with OK and Cancel, raised to ask how many
 *       datacores to buy. Answers the number, or None on Cancel.
 *   XmppChat.AskYesNoQuestion(question, props, defaultChoice=1)
 *       xmppchatsvc.py 1745: a Yes/No dialog by message ID, which customs
 *       raises over contraband. Answers whether Yes was pressed. The server
 *       gives it a short time and then decides for itself, which is what it
 *       does when a player is not there; so with nobody to ask, and when the
 *       user does not answer in time, this is left unanswered.
 *   objectCaching.InvalidateCachedMethodCall(service, method, *args)
 *       carbon/common/script/net/objectCaching.py 222: forget a method's cached
 *       answer, so the next call asks the server. Nothing is kept here to
 *       forget (every call is sent), and the method returns None.
 *
 * `askUser(question)` puts a question to whoever is watching this pilot and
 * resolves with {asked, answer}: asked is false when nobody is watching, and
 * answer is undefined when the question was shown and not answered in time.
 */
function defaultClientCallAnswer({ service, method, args, kwargs }, characterID, askUser = async () => ({ asked: false })) {
  const list = itemsOf(args);
  switch (`${service}.${method}`) {
    case "agents.YesNo":
      return askUser({
        kind: "yesNo",
        title: words(list[0]),
        body: words(list[1]),
        agentID: positive(list[2]),
        contentID: positive(list[3]),
        suppressID: textOf(list[4]),
      }).then((reply) => (reply.asked ? reply.answer === true : true));
    case "agents.SingleChoiceBox":
      return askUser({
        kind: "choice",
        title: words(list[0]),
        body: words(list[1]),
        choices: itemsOf(list[2]).map(words),
        agentID: positive(list[3]),
        contentID: positive(list[4]),
        suppressID: textOf(list[5]),
      }).then((reply) => {
        const given = reply.asked && reply.answer ? reply.answer : { confirmed: false, index: 0 };
        return [given.confirmed === true, `radioboxOption${given.index + 1}Selected`];
      });
    case "agents.GetQuantity": {
      const keyword = (name) => dictValue(kwargs, name);
      return askUser({
        kind: "quantity",
        title: words(keyword("caption") ?? null),
        body: words(keyword("label") ?? null),
        agentID: null,
        contentID: null,
        suppressID: null,
        quantity: {
          min: finite(keyword("minvalue")) ?? 0,
          max: finite(keyword("maxvalue")),
          initial: finite(keyword("setvalue")),
          digits: finite(keyword("digits")) ?? 0,
        },
      }).then((reply) => (reply.asked && typeof reply.answer === "number" ? reply.answer : null));
    }
    case "XmppChat.AskYesNoQuestion": {
      // A dialog by its name with its parameters, where an agent's question has a label with its. The
      // dialog's title and body are both the client's (its dialog table, by that name), filled from the same
      // parameters. The name stays as the body's label for a page with no client's words to go by.
      const dialog = textOf(list[0]);
      const parameters = wireToBridgeJson(list[1] ?? null);
      return askUser({
        kind: "yesNo",
        title: { label: null, dialog, part: "title", parameters, text: null },
        body: { label: dialog, dialog, part: "body", parameters, text: null },
        agentID: null,
        contentID: null,
        suppressID: null,
      }).then((reply) => (reply.asked && typeof reply.answer === "boolean" ? reply.answer : undefined));
    }
    case "objectCaching.InvalidateCachedMethodCall":
    case "objectCaching.InvalidateCachedMethodCalls":
      return null;
    default:
      return undefined;
  }
}

/** The items of a decoded list or tuple, or none. */
const itemsOf = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);

/** A keyword by name from a decoded dict, or undefined. */
function dictValue(dict, name) {
  const entries = dict && dict.type === "dict" && Array.isArray(dict.entries) ? dict.entries : [];
  const found = entries.find(([key]) => textOf(key) === name);
  return found ? found[1] : undefined;
}

/** A number the wire or the JSON carried, or null. */
const finite = (value) => {
  const number = typeof value === "number" || typeof value === "bigint" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};

/** Whether an answer is one the question can take: what its window on the retail client could give. */
function answerFits(question, answer) {
  switch (question.kind) {
    case "yesNo":
      return typeof answer === "boolean";
    case "choice":
      return Boolean(answer) && typeof answer === "object" && typeof answer.confirmed === "boolean" &&
        Number.isSafeInteger(answer.index) && answer.index >= 0 && answer.index < question.choices.length;
    case "quantity": {
      // Cancel is None. Otherwise a number the box's field would have let through (intonly / floatonly, min to max).
      if (answer === null) return true;
      const { min, max, digits } = question.quantity;
      return typeof answer === "number" && Number.isFinite(answer) && (digits > 0 || Number.isInteger(answer)) &&
        answer >= min && (max === null || answer <= max);
    }
    default:
      return false;
  }
}

/** The kind of a dogma effect, from the static data the BFF already reads. Loaded when first asked. */
function defaultEffectCategory(effectID) {
  // eslint-disable-next-line global-require
  const effect = require("../staticData").getEffect(effectID);
  return effect && Number.isInteger(effect.effectCategoryID) ? effect.effectCategoryID : null;
}

/** A type's dogma attribute and its group, from the same static data (godma.GetTypeAttribute, evetypes.GetGroupID). */
function defaultTypeAttribute(typeID, attributeID) {
  // eslint-disable-next-line global-require
  return require("../staticData").getTypeDogmaAttribute(typeID, attributeID);
}
/** A type's dogma effects, each as the static data has it: { effectID, name, effectCategoryID, durationAttributeID, ... }. */
function defaultTypeEffects(typeID) {
  // eslint-disable-next-line global-require
  const staticData = require("../staticData");
  const dogma = staticData.getTypeDogma(typeID);
  return (dogma && Array.isArray(dogma.effects) ? dogma.effects : []).map((effectID) => staticData.getEffect(effectID)).filter(Boolean);
}
/** const.attributeDisallowRepeatingActivation: a module that is set off once each time. */
const ATTRIBUTE_DISALLOW_REPEATING = 1014;
/** A type's name and its group's, as the static data has them: what the client knows of a type without asking. */
function defaultTypeNames(typeID) {
  // eslint-disable-next-line global-require
  const type = require("../staticData").getType(typeID);
  return type ? { name: String(type.name ?? ""), groupName: String(type.groupName ?? "") } : null;
}
/** A type's { basePrice, portionSize } from the game's static data; null for a type it has not. */
function defaultTypeBasePrice(typeID) {
  // eslint-disable-next-line global-require
  const type = require("../staticData").getType(typeID);
  return type ? { basePrice: Number(type.basePrice) || 0, portionSize: Number(type.portionSize) || 1 } : null;
}

/** A station's { ownerID, factionID } from the game's static data; null for what is no station there. */
function defaultStationOwner(stationID) {
  // eslint-disable-next-line global-require
  const staticData = require("../staticData");
  const station = staticData.getStation(stationID);
  const ownerID = station ? positive(station.corporationID) : null;
  if (ownerID === null) return null;
  const corporation = staticData.getCorporation(ownerID);
  return { ownerID, factionID: corporation ? positive(corporation.factionID) : null };
}

function defaultTypeGroup(typeID) {
  // eslint-disable-next-line global-require
  const type = require("../staticData").getType(typeID);
  return type && Number.isInteger(type.groupID) ? type.groupID : null;
}

/** A positive whole number, however the wire or the JSON spelled it; else null. */
const positive = (value) => {
  const number = typeof value === "number" || typeof value === "bigint" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** JSON arguments as the BFF sends them, into what the client's marshaller takes. */
function argumentsToWire(value) {
  if (Array.isArray(value)) return value.map(argumentsToWire);
  if (value === null || typeof value !== "object") return value;
  switch (value.type) {
    case "Buffer":
      return Buffer.from(Array.isArray(value.data) ? value.data : []);
    case "bytes":
      return argumentsToWire(value.value);
    case "tuple":
    case "list":
      return { ...value, items: (value.items ?? []).map(argumentsToWire) };
    case "dict":
      return { ...value, entries: (value.entries ?? []).map(([key, entry]) => [argumentsToWire(key), argumentsToWire(entry)]) };
    case "object":
      return { ...value, args: argumentsToWire(value.args) };
    default:
      return value;
  }
}

/**
 * The "N=node:id" of the first bound object in an answer, or null. A bound
 * object arrives as a substruct holding a substream of (id, timestamp), alone
 * or inside the (object, result) pair a bind answers with.
 */
function boundObjectID(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object" || Buffer.isBuffer(value)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = boundObjectID(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value.type === "substruct" && value.value) {
    const pair = value.value.type === "substream" ? value.value.value : value.value;
    const id = Array.isArray(pair) ? pair[0] : null;
    const name = Buffer.isBuffer(id) ? id.toString("utf8") : typeof id === "string" ? id : "";
    if (name.startsWith("N=")) return name;
  }
  for (const inner of [value.value, value.items, value.args]) {
    const found = boundObjectID(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

/** One field of a util.KeyVal, in bridge JSON. */
function keyValField(row, name) {
  const entries = row && row.type === "object" && row.args && Array.isArray(row.args.entries) ? row.args.entries : [];
  const entry = entries.find((candidate) => Array.isArray(candidate) && candidate[0] === name);
  return entry ? entry[1] : undefined;
}

/** A character's row in GetCharacterSelectionData's answer (userDetails, training, characters, wars), or null. */
function selectionRow(selection, characterID) {
  const characters = Array.isArray(selection) ? selection[2] : null;
  const rows = characters && characters.type === "list" && Array.isArray(characters.items) ? characters.items : [];
  return rows.find((row) => positive(keyValField(row, "characterID")) === characterID) ?? null;
}

/**
 * The game-port transport.
 *
 *   connect()           -> a frame transport to the game server
 *   createSession(t)    -> a GamePortSession on it
 *   passwordFor(name)   -> the password to log in with (a development server takes any)
 *   isOnline(accountID, characterID) -> whether the server still has the character
 *                          in game; asked after a release so "released" means it
 *   allowed             -> the "service.method" pairs a pilot may call
 *   shape(service, method, args, kwargs) -> the call as the retail client sends it (retailCalls.js)
 */
function createGamePortPilots({
  endpoint = gameEndpoint(),
  connect = () => connectTcp(endpoint),
  createSession = (transport) => new GamePortSession({ transport, provisionalWaitLimitMs: PROVISIONAL_WAIT_LIMIT_MS }),
  passwordFor = () => "",
  isOnline = null,
  allowed = new Set([...contract.gatewayAllowlist.pairs, ...GAME_PORT_ONLY_CALLS]),
  shape = retailForm,
  selectSettleMs = 5000,
  releaseSettleMs = 5000,
  randomBytes = crypto.randomBytes,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // A pilot's ballpark while it is in space (pilotSpace.js).
  createSpace = (options) => createPilotSpace(options),
  onSpaceError = () => {},
  // What kind a dogma effect is, from the game's static data (dogma.data.get_effect on the retail client).
  effectCategory = defaultEffectCategory,
  // A type's dogma attribute and its group, for the scanner: a probe's range steps, and whether a launcher's charge is a probe.
  typeAttribute = defaultTypeAttribute,
  typeGroup = defaultTypeGroup,
  // A station's owner and that owner's faction, for the broker's fee: cfg.stations and get_corporation_faction_id on the retail client.
  stationOwner = defaultStationOwner,
  // A type's base price and portion size, for its average price where nothing has traded: evetypes on the retail client.
  typeBasePrice = defaultTypeBasePrice,
  typeNames = defaultTypeNames,
  // A type's dogma effects, for naming the one a module is switched on by and saying whether it repeats.
  typeEffects = defaultTypeEffects,
  // The client's own services, for the calls the server makes to it, and a word about each call once it is over.
  answerClientCall = defaultClientCallAnswer,
  onClientCall = () => {},
  // How long a question put to the user waits for an answer, and the timers that count it.
  questionWaitMs = QUESTION_WAIT_MS,
  timers = { setTimeout, clearTimeout },
  // How long an account's own connection is kept after the last thing asked on it.
  accountIdleMs = ACCOUNT_IDLE_MS,
} = {}) {
  const sessions = new Map();
  /** The accounts' own connections, by account, each with no character chosen on it. */
  const accountLines = new Map();
  const epoch = randomBytes(12).toString("base64url");
  /** Every call made, by pair and by how it compares with the retail client's (retailCalls.js). */
  const ledger = createCallLedger();
  const DOGMA_AS_GODMA_PRIMES = Object.freeze({ status: "same", source: "eve/client/script/environment/godma.py:2409", note: null });
  /** The server's clock (100 ns since 1601) for a reading of this machine's, in milliseconds. */
  const filetime = (ms) => (BigInt(Math.trunc(ms)) + 11644473600000n) * 10000n;
  /** standingsvc.__RefreshStandings: RemoteSvc('standingMgr').GetNPCNPCStandings(), no arguments. The web client never asks it. */
  const NPC_STANDINGS_AS_THE_CLIENT_ASKS = Object.freeze({ status: "same", source: "eve/client/script/ui/services/standingsvc.py:115", note: null });
  /** cfg.eveowners' priming: config.GetMultiOwnersEx(list(keysToGet)), which no route of the BFF's may ask by name. */
  const OWNERS_AS_THE_CLIENT_ASKS = Object.freeze({ status: "same", source: "carbon/common/script/sys/cfg.py:579", note: null });
  /**
   * agents.py __GetAllAgents: the whole table of agents, which every client asks its server for once and keeps for
   * as long as it runs. It is the same for every pilot and large (some eleven thousand rows), so here it is kept
   * once for them all, in the gateway's form: what the last pilot to ask was answered. Null until one has been.
   */
  let agentsTable = null;
  /** journal._UpdateMissionDataPartial: GetAgentMoniker(agentID).GetMyJournalDetails(), no arguments, on the agent's own moniker. */
  const AGENTS_OWN_JOURNAL = Object.freeze({ status: "same", source: "eve/client/script/ui/shared/neocom/journal.py:325", note: null });
  /** What the client asks of its skill handler of its own accord that the web client never asks, and where each is asked. */
  const SKILL_OWN = Object.freeze({
    CheckAndSendNotifications: Object.freeze({ status: "same", source: "notifications/client/development/skillHistoryProvider.py:26", note: null }),
    // CommitTransaction: skillHandler.SaveNewQueue(queueInfo, activate=activate). The web client's pair for it is skillMgr's, by name.
    SaveNewQueue: Object.freeze({ status: "same", source: "eve/client/script/ui/services/skillQueueSvc.py:153", note: null }),
  });
  /**
   * The refusals of a queue's saving after which the client's queue panel opens no new transaction, and so does
   * not ask for the queue again (skillQueuePanelNew.ApplySkillQueue).
   */
  const NO_NEW_QUEUE_TRANSACTION = new Set(["UserAlreadyHasSkillInTraining", "SkillInQueueRequiresOmegaCloneState"]);
  /** What the client's fleet service asks of its own accord that the web client never asks, and where each is asked. */
  const FLEET_OWN = Object.freeze({
    // CreateFleet: self.fleet.GetFleetID(), once the fleet it formed has been read.
    GetFleetID: Object.freeze({ status: "same", source: "eve/client/script/parklife/fleetSvc.py:338", note: null }),
    // OnFleetMove: self.fleet.FinishMove().
    FinishMove: Object.freeze({ status: "same", source: "eve/client/script/parklife/fleetSvc.py:1816", note: null }),
  });
  const BOUND_AS_THE_CLIENT_BINDS = Object.freeze({ status: "reshaped", source: "eve/common/script/net/eveMoniker.py, eve/client/script/environment/invCache.py", note: null });

  // ── errors ────────────────────────────────────────────────────────────────

  /** A failure of the session, in the gateway's terms. */
  function toPilotError(error, service, method) {
    if (error instanceof GamePortPilotError) return error;
    const code = error && error.code;
    const detail = String((error && error.message) || error).slice(0, 300);
    if (code === "GAME_CALL_REFUSED" && error.refusal && error.refusal.reason) {
      // What the server refused with, by name and with its values: the client acts on some of them
      // (ShipContrabandWarningUndock is a question, not a failure), and the words alone do not say which.
      return Object.assign(fail("CALL_REFUSED", String(error.refusal.reason)), {
        refusal: { key: String(error.refusal.key || ""), values: error.refusal.values ?? null },
      });
    }
    if (["CONNECTION_LOST", "CONNECTION_CLOSED", "TRANSPORT_CLOSED", "NOT_CONNECTED", "BAD_FRAME"].includes(code)) {
      return fail("SESSION_NOT_FOUND", SESSION_GONE);
    }
    if (code === "CALL_TIMEOUT" || code === "HANDSHAKE_TIMEOUT") {
      return fail("EVE_GATEWAY_TIMEOUT", "The game server did not answer in time.");
    }
    if (/^Cannot marshal/.test(detail)) {
      return fail("CALL_INVALID", `${service}.${method} was given an argument that cannot be sent: ${detail}`);
    }
    return fail("CALL_FAILED", `${service}.${method} failed: ${detail}`);
  }

  function assertAllowed(service, method) {
    // (Two names, as text: what would only spell a pair on the list is not on it.)
    if (typeof service !== "string" || typeof method !== "string" || !allowed.has(`${service}.${method}`)) {
      throw fail("CALL_NOT_ALLOWED", `${service}.${method} is not on the web-call allowlist.`);
    }
  }

  // ── what the server pushes ────────────────────────────────────────────────

  // The retail client is told a thing once, on its one connection. Here a notification goes out twice: on
  // the pilot's stream as it arrives, and with the next answer, which is what a reader with no stream has.
  // So the copy kept for the answer names the stream frame it also went out in (its cursor), and a reader
  // that has both can tell they are one.
  function record(entry, notification) {
    if (SUPPRESSED_NOTIFICATIONS.has(notification.method)) return;
    const frame = publish(entry, { kind: "notification", notification });
    entry.backlog.push(Object.freeze({ ...notification, cursor: frame.cursor }));
    if (entry.backlog.length > BACKLOG_LIMIT) entry.backlog.splice(0, entry.backlog.length - BACKLOG_LIMIT);
  }

  /** One event on the pilot's stream, for whoever is listening now and whoever resumes from before it. */
  function publish(entry, event) {
    entry.sequence += 1;
    const frame = Object.freeze({
      source: STREAM_SOURCE,
      apiVersion: 1,
      streamVersion: 1,
      type: "event",
      cursor: Object.freeze({ epoch, sequence: entry.sequence }),
      event,
    });
    entry.history.push(frame);
    if (entry.history.length > STREAM_HISTORY_LIMIT) entry.history.shift();
    for (const subscriber of [...entry.subscribers]) deliver(subscriber, frame);
    return frame;
  }

  // ── what the server asks the user ─────────────────────────────────────────
  //
  // The retail client puts a window up and the server waits for it. Here the
  // question goes out on the pilot's stream, to the browser showing that pilot,
  // and the answer comes back by answerClientQuestion. A stream is only open
  // while a browser is attached, so "nobody is listening" is "nobody to ask".

  function askUser(entry, call, question) {
    if (entry.ended || ![...entry.subscribers].some((subscriber) => !subscriber.closed)) {
      return Promise.resolve({ asked: false, answer: undefined });
    }
    const id = randomBytes(9).toString("base64url");
    // No longer than the server itself will wait: an answer after that reaches nobody.
    const serverWaitMs = Number.isFinite(call.timeoutSeconds) && call.timeoutSeconds > 0 ? call.timeoutSeconds * 1000 : Infinity;
    const waitMs = Math.min(questionWaitMs, serverWaitMs);
    return new Promise((resolve) => {
      const asked = {
        id,
        question,
        timer: timers.setTimeout(() => asked.settle(undefined, "expired"), waitMs),
        settle(answer, reason) {
          if (!entry.questions.delete(id)) return;
          timers.clearTimeout(asked.timer);
          if (!entry.ended) publish(entry, { kind: "question-closed", id, reason });
          resolve({ asked: true, answer });
        },
      };
      entry.questions.set(id, asked);
      publish(entry, {
        kind: "question",
        question: { id, service: call.service, method: call.method, ...question, askedAtMs: now(), expiresAtMs: now() + waitMs },
      });
    });
  }

  /**
   * The pilot's own ship's attribute, as godma holds it: primed once with GetAllInfo, as the client primes it,
   * and kept right by the server's notices. The client reads a hold's capacity from here and never asks the
   * server for one (godma.py 871). Null for an attribute godma was not told of, or with godma not primed.
   */
  async function shipAttribute(attributeID, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    await shipReadings(entry, place);
    return entry.dogma.attribute(place.shipID, attributeID);
  }

  /**
   * The pilot's own ship and what type it is, as the session and godma hold them. The client's inventory tree
   * goes by the type to say which bays a ship has (treeData.py 300 to 363). The type is null where godma was
   * not told of the ship.
   */
  async function ship(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    await shipReadings(entry, place);
    return { shipID: place.shipID, typeID: entry.dogma.typeOf(place.shipID) };
  }

  /** One call the client makes of its own accord on the dogma location, in the client's form and in the ledger. */
  async function ownDogmaCall(entry, method, args) {
    const form = shape("dogmaIM", method, args, null, contextFor(entry));
    ledger.note("dogmaIM", method, form);
    return monikerCall(entry, "dogmaIM", method, argumentsToWire(form.args), form.kwargs);
  }

  /**
   * godma.UpdateItem, for a module the server says is in a slot of the ship the pilot is in: the client asks what
   * dogma has of it, ItemGetInfo(itemID), and holds the answer. With no answer the module is held as it was.
   */
  function askAbout(entry, item) {
    if (item.locationID !== attribute(entry, "shipid")) return;
    entry.itemWork = entry.itemWork.then(async () => {
      try {
        entry.dogma.updateItem(item.itemID, await ownDogmaCall(entry, "ItemGetInfo", [item.itemID]));
      } catch {
        // The client's item change carries on to its dogma location whatever came of this.
      }
    });
  }

  /**
   * clientDogmaLocation._OnlineModuleIfApplicable and OnlineModule: a module newly fitted to the ship the pilot is
   * in is put online by the client itself, where its type can be online at all. The effect is running from then
   * and the server is told, SetModuleOnline(the ship, the module). A server that has it online already says so
   * (EffectAlreadyActive2), and that is no failure; refused for any other reason, or not answered, the effect is
   * not running after all. It comes after godma's asking, as it does on the client.
   */
  function onlineIfApplicable(entry, item) {
    if (item.locationID !== attribute(entry, "shipid")) return;
    if (!typeEffects(item.typeID).some((effect) => effect.effectID === EFFECT_ONLINE)) return;
    entry.itemWork = entry.itemWork.then(async () => {
      entry.dogma.setEffect(item.itemID, EFFECT_ONLINE, true);
      try {
        await ownDogmaCall(entry, "SetModuleOnline", [item.locationID, item.itemID]);
      } catch (error) {
        if (!error.refusal || error.refusal.key !== "EffectAlreadyActive2") entry.dogma.setEffect(item.itemID, EFFECT_ONLINE, false);
      }
    });
  }

  /**
   * The fleet the pilot is in, as the session says: session.fleetid, which the server sets with a session change
   * and the client's fleet service goes by for everything it asks of a fleet (fleetSvc.py). Null in none. And
   * whether the fleet's own object is held, as that service holds one in self.fleet: what CreateFleet answered, or
   * the Moniker that accepted an invite. It leaves by that object where it has it (LeaveFleet, 365).
   */
  function fleet(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    return { fleetID: attribute(entry, "fleetid"), holdsObject: entry.fleet !== null };
  }

  /**
   * The pilot's own ship as dogma has it, without asking: the ship's row from godma's priming, with its
   * attributes as godma holds them now, and the modules fitted in it that are online. It is what the server
   * answers to ShipGetInfo and ShipOnlineModules, which the client never asks (godma.py 2409, 697). The row
   * is null where godma is not primed for the ship where it is.
   */
  async function shipInfo(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    await shipReadings(entry, place);
    // A module just fitted is as the server has answered of it, once it has.
    await entry.itemWork;
    // Only the row godma was primed with for this ship where it is now: never an earlier ship's, or this one's from
    // somewhere it has left, when the priming for here did not come.
    const kept = entry.dogmaLoaded === primedFor(entry, place) ? entry.shipRow : null;
    if (!kept) return { shipID: place.shipID, row: null, online: [] };
    const now = { type: "dict", entries: entry.dogma.attributesOf(place.shipID) };
    const entries = kept.args.entries.map(([name, value]) => [name, name === "attributes" ? now : value]);
    return { shipID: place.shipID, row: { ...kept, args: { ...kept.args, entries } }, online: entry.dogma.onlineModules(place.shipID).map(([, moduleID]) => moduleID) };
  }

  /** The user's answer to a question the server asked. */
  async function answerClientQuestion(bridgeSessionID, questionID, answer, sessionFields = {}) {
    const entry = held(bridgeSessionID, sessionFields);
    const asked = entry.questions.get(String(questionID || ""));
    if (!asked) throw fail("QUESTION_NOT_FOUND", "That question is no longer open.");
    if (!answerFits(asked.question, answer)) throw fail("CALL_INVALID", "That is not an answer this question takes.");
    asked.settle(answer, "answered");
    return { answered: true, questionID: asked.id };
  }

  function deliver(subscriber, frame) {
    if (subscriber.closed) return;
    try {
      subscriber.onFrame(frame);
    } catch {
      // A listener's failure is its own; the session and the other listeners carry on.
    }
  }

  const drain = (entry) => entry.backlog.splice(0);

  // ── sessions ──────────────────────────────────────────────────────────────

  /** The live session a handle names, or SESSION_NOT_FOUND. */
  function held(handle, sessionFields) {
    const entry = sessions.get(String(handle || ""));
    const asked = sessionFields && sessionFields.userid !== undefined ? Number(sessionFields.userid) : undefined;
    if (!entry || entry.ended || (asked !== undefined && asked !== entry.accountID)) {
      throw fail("SESSION_NOT_FOUND", SESSION_GONE);
    }
    return entry;
  }

  /** The session is over: forget it, close it, and tell whoever is listening. */
  function end(entry, reason, refusalStatus = 404) {
    if (entry.ended) return;
    entry.ended = true;
    // Nobody is left to answer: each question closes unanswered, as its window would with the client.
    for (const asked of [...entry.questions.values()]) asked.settle(undefined, "session_ended");
    if (entry.space) entry.space.release();
    entry.space = null;
    sessions.delete(entry.handle);
    entry.session.close();
    for (const subscriber of [...entry.subscribers]) {
      entry.subscribers.delete(subscriber);
      if (subscriber.closed) continue;
      subscriber.closed = true;
      try {
        subscriber.onClose({ code: 0, reason, refusalStatus });
      } catch {
        // As above.
      }
    }
  }

  /** Run one request on a session, with its failures in the gateway's terms. */
  async function run(entry, service, method, request) {
    try {
      return await request();
    } catch (error) {
      const mapped = toPilotError(error, service, method);
      if (mapped.code === "SESSION_NOT_FOUND") end(entry, "connection_closed");
      throw mapped;
    }
  }

  const attribute = (entry, name) => positive(entry.session.attributes[name]);

  // ── the nine ──────────────────────────────────────────────────────────────

  async function selectCharacter(args = [], kwargs = null, sessionFields = {}) {
    const accountID = positive(sessionFields && sessionFields.userid);
    const userName = String((sessionFields && sessionFields.userName) || "").trim();
    const characterID = positive(Array.isArray(args) ? args[0] : null);
    if (accountID === null) throw fail("CALL_INVALID", "Call session requires a positive integer userid.");
    if (!userName) throw fail("CALL_INVALID", "A game-port login needs the account's name.");
    if (characterID === null) throw fail("CALL_INVALID", "SelectCharacterID needs a character.");

    let transport;
    try {
      transport = await connect();
    } catch {
      throw fail("EVE_GATEWAY_UNREACHABLE", "The game server is unreachable.");
    }
    const session = createSession(transport);
    const clock = createPilotClock({ now });
    const entry = {
      handle: `${GAME_PORT_HANDLE_PREFIX}${randomBytes(24).toString("base64url")}`,
      session,
      accountID,
      userName,
      characterID,
      backlog: [],
      sequence: 0,
      history: [],
      subscribers: new Set(),
      ship: null,
      /** boundHandle -> { objectID, service }: what the BFF holds, and what it names here. */
      bound: new Map(),
      /** fleetSvc's self.fleet: the one object the client keeps for the pilot's fleet, as it is held in `bound`; null with none. */
      fleet: null,
      /** The two inventory managers invCache keeps, by which: the "N=..." of each. */
      inventoryManagers: new Map(),
      /** The monikers the client keeps for where the pilot is, by service: the "N=..." each is bound to (monikerCall). */
      monikers: new Map(),
      /** The binds under way, by what is being bound: a Moniker binds once, and a call that finds it binding waits. */
      binding: new Map(),
      /** skillsvc's skillHandler: the moniker skillMgr2 answered, once asked for; a promise of { service, nodeID, params }. */
      skillHandler: null,
      /** The pilot's sim clock (pilotClock.js): what its park steps by and its dogma measures in. */
      clock,
      /** The pilot's ballpark while it is in space (pilotSpace.js), else null. */
      space: null,
      /** The pilot's ship as dogma has it (pilotDogma.js), and which ship and place that was loaded for. */
      dogma: createPilotDogma({
        characterID,
        now: () => filetime(clock.simTime()),
        effectCategory,
        onSlotted: (item) => askAbout(entry, item),
        onFitted: (item) => onlineIfApplicable(entry, item),
      }),
      dogmaLoaded: null,
      /** What the client does of its own accord for an item the server says has moved, one call after another: over when each is answered. */
      itemWork: Promise.resolve(),
      /** The pilot's scan probes as the client's scan service knows them (pilotScanner.js). */
      scanner: createPilotScanner({ typeAttribute }),
      /** The pilot's fleet as the client's fleet service keeps it (pilotFleet.js): read once, kept right by the server's notices. */
      fleetKept: createPilotFleet({ characterID }),
      /** What the client asks of a fleet of its own accord, one thing after another: over when each is answered. */
      fleetWork: Promise.resolve(),
      /** The pilot's standings as the client's standing service keeps them (pilotStandings.js), and the reading of them that is under way. */
      standings: createPilotStandings({ characterID, corporationID: () => attribute(entry, "corpid") }),
      standingsWork: Promise.resolve(),
      /** The pilot's skills as the client's skill services keep them (pilotSkills.js), and what is being asked for them, one thing after another. */
      skills: createPilotSkills(),
      skillsWork: Promise.resolve(),
      /** The character's name, as the selection screen's row had it. */
      characterName: "",
      /** The pilot's agents' journal as the client's journal service keeps it (pilotJournal.js), and the readings of it, one after another. */
      journal: createPilotJournal(),
      journalWork: Promise.resolve(),
      /** agents.agentMonikers: the one object the client keeps for an agent, by agent, each as it is held in `bound`. */
      agents: new Map(),
      /** agents.allAgents: this pilot's own asking for the table of agents, once it has asked; over when it is answered. */
      agentsAsked: null,
      /** cfg.eveowners: each owner the server has been asked about, as { name, typeID }, or null for one it had no row for; and the askings, one after another. */
      owners: new Map(),
      ownersWork: Promise.resolve(),
      /** What the client's services keep until it changes, as the server answered it, by the service asked (KEPT_UNTIL_CHANGED). */
      kept: Object.fromEntries(Object.keys(KEPT_UNTIL_CHANGED).map((service) => [service, createKeptReads()])),
      /** The two reads of a planet's own object that are kept by the planet, each as { at, answer } (planetRead). */
      planetReads: new Map(),
      /** The station the pilot is docked in, as the client's station service keeps it; and its askings, one after another. */
      station: createPilotStation(),
      /** The corporations with offices where the pilot is docked, as the station's office object answered (STATION_OFFICES). */
      stationOffices: createKeptReads(),
      /** crimewatchSvc's client states as last answered (CLIENT_STATES), and the pilot's security status (mySecurityStatus): undefined while none is had. */
      clientStates: createKeptReads(),
      securityStatus: undefined,
      /** The account's clone grade as the server last said it (clonegrade/const.py: 0 alpha, 1 omega): undefined while none is had. */
      cloneGrade: undefined,
      /** Whether the office's item was primed on the Moniker for where the pilot is docked (PRIME_OFFICE): its answer, kept while docked there. */
      officePrimed: createKeptReads(),
      /** The account service's static data (ACCOUNT_STATIC), kept for as long as the character is. */
      accountStatic: createKeptReads(),
      /** The home station as the client's home station service keeps it (GET_HOME_STATION). */
      homeStation: createKeptReads(),
      /**
       * The selection screen's data as the server answered it at the choosing, in the form a call's answer has:
       * the client's character service keeps it for as long as the character is on (ccSvc.py 39 to 43, let go at
       * on_character_log_off). Null until a character has been chosen, which every pilot held here has been.
       */
      selection: null,
      /** godma's priming that is out now, and the ship in a place it is for: whoever wants the ship's readings meanwhile waits for it. */
      dogmaPriming: null,
      stationWork: Promise.resolve(),
      /** What each container bound for the BFF lists, as the server answered, until something may have changed it (INVENTORY_LISTINGS). */
      listings: createKeptReads(),
      /** marketQuote.GetAveragePrice for the items of the sale being made, by type (saleAveragesRead). */
      saleAverages: new Map(),
      /** beyonce.GetFormations as the server answered it, or the asking of it under way; null before it is asked (formationsKnown). */
      formations: null,
      /** The pilot's last order to its ship in this ballpark, as { method, targetID, range }, or null (alreadyFollowing). */
      lastMove: null,
      /** What the ship has locked and what has it locked, as the client's target service keeps them (pilotTargets.js); the askings of them, one after another; and whether godma has yet to ask for them. */
      targets: createPilotTargets(),
      targetsWork: Promise.resolve(),
      targetsOwed: false,
      /** crimewatchSvc.corpAggressionSettings: the corporation's aggression settings as last answered or told, or null; and the askings of them, one after another. */
      aggression: null,
      corpWork: Promise.resolve(),
      /** Questions the server has asked and the user has not answered yet, by ID. */
      questions: new Map(),
      ended: false,
    };
    session.clientCalls = (call) => answerClientCall(call, characterID, (question) => askUser(entry, call, question));
    session.onClientCall((call) => onClientCall(call, characterID));
    session.onNotification((notification) => {
      // machoNet.OnMachoObjectDisconnect(objectID, clientID, refID): the server has let a bound object go.
      if (notification.method === "OnMachoObjectDisconnect" && Array.isArray(notification.args)) {
        const gone = notification.args[0];
        forgetObject(entry, Buffer.isBuffer(gone) ? gone.toString("utf8") : String(gone));
      }
      entry.clock.feed(notification);
      if (entry.space) entry.space.feed(notification);
      entry.dogma.feed(notification);
      entry.scanner.feed(notification);
      afterFleetNotice(entry, entry.fleetKept.feed(notification));
      entry.standings.feed(notification);
      afterSkillNotice(entry, entry.skills.feed(notification));
      afterCorporationNotice(entry, notification);
      entry.targets.feed(notification);
      // station/base.py: a pilot arrived in the station, or left it.
      entry.station.feed(notification);
      // crimewatchSvc (222 to 288): a timer, a flag or an engagement changed. The client works the notice into what
      // it keeps and asks nothing; so here (crimewatchStates.js). States the notice cannot be worked into are let go.
      if (CLIENT_STATE_NOTICES.has(notification.method)) entry.clientStates.amend(CLIENT_STATES, (states) => statesAfter(states, notification.method, notification.args));
      // clone_grade_svc.OnSubscriptionChangedServer(new_state): the grade is what the server says.
      if (notification.method === "OnSubscriptionChangedServer" && typeof notification.args?.[0] === "number") entry.cloneGrade = notification.args[0];
      // crimewatchSvc.OnSecurityStatusUpdate(newSecurityStatus): the status is what the server says.
      if (notification.method === "OnSecurityStatusUpdate" && typeof notification.args?.[0] === "number") entry.securityStatus = notification.args[0];
      // home_station (163, 168): the home station changed, or was moved from its structure. What is kept is let go.
      if (HOME_STATION_NOTICES.has(notification.method)) entry.homeStation.forget();
      // officeManager.OnOfficeRentalChange (71): an office rented or given up, whoever's, and the station's are not as kept.
      if (notification.method === "OnOfficeRentalChange") entry.stationOffices.forget();
      // invCache.OnItemChange: an item changed, and what a container lists may not be so any more.
      if (ITEM_NOTICES.has(notification.method)) entry.listings.forget();
      // What the client's own services tell its object cache to forget on this notice.
      forgetNamed(entry, namedOnNotice(notification.method, notification.args, entry.session.attributes));
      for (const [service, keeper] of Object.entries(KEPT_UNTIL_CHANGED)) {
        if (keeper.notices.has(notification.method) && (!keeper.concerns || keeper.concerns(notification.args, entry.session.attributes))) entry.kept[service].forget();
      }
      if (COLONY_NOTICES.has(notification.method)) forgetColonies(entry);
      // A mission changed: what the client shows of its missions is drawn again from the journal, which reads it again.
      if (entry.journal.feed(notification)) journalUpToDate(entry);
      record(entry, notificationToBridgeJson(notification));
    });
    session.onSessionChange((changes) => {
      // What the client's own services tell its object cache to forget on this change.
      forgetNamed(entry, namedOnSessionChange(changes, entry.session.attributes));
      // A new place, or a new ship: what dogma said of the old one is not about this one, and nor is what a container listed.
      if (LOCATION_ATTRIBUTES.some((name) => name in changes) || "shipid" in changes) {
        entry.dogmaLoaded = null;
        entry.listings.forget();
      }
      // gameui.GetShipAccess: the ship's moniker it keeps is for the ship the pilot is in.
      if ("shipid" in changes) entry.monikers.delete("ship");
      // station/base.py OnSessionChanged and ProcessSessionChange: out of a station, its guests and its item are let go.
      if ("stationid" in changes) entry.station.left();
      // crimewatchSvc.ProcessSessionChange and OnSessionChanged: the states asked for at a change of place, and
      // in space at a change of system or ship. (The choosing of the character asks them itself.)
      if (sessions.has(entry.handle)) clientStatesAtAChange(entry, changes);
      // station/base.py: arrived in a station, the lobby asks for the station's item and its guests. (The choosing
      // of the character asks them itself.)
      if ("stationid" in changes && sessions.has(entry.handle)) lobbyRead(entry);
      // officeManager.DoSessionChanging and OnSessionChanged (58, 66): another station or structure, or none, and its offices are not this one's.
      if ("stationid" in changes || "structureid" in changes) {
        entry.stationOffices.forget();
        entry.officePrimed.forget();
      }
      // fleetSvc.ProcessSessionChange: in no fleet, there is no fleet's object.
      if ("fleetid" in changes) {
        entry.fleetKept.sessionChanged();
        if (changes.fleetid[1] === null) outOfFleet(entry);
      }
      // scanSvc.OnSessionChanged: another system, ship or structure, and the scanner knows of no probes.
      if (["solarsystemid", "shipid", "structureid"].some((name) => name in changes)) entry.scanner.flush();
      // calendar.OnSessionChanged: in another corporation or alliance the months of events kept are not its.
      if ("corpid" in changes || "allianceid" in changes) entry.kept[CALENDAR_PROXY].forget();
      // officeManager.OnSessionChanged: in another corporation the offices kept are not its.
      if ("corpid" in changes) entry.kept[OFFICE_MANAGER].forget();
      // home_station.OnSessionChanged (173): 'corpid' in change, and the home station kept is let go.
      if ("corpid" in changes) entry.homeStation.forget();
      // all_cso.OnSessionChanged: another alliance, another moniker, made and bound at once; no alliance, none.
      if ("allianceid" in changes) {
        entry.monikers.delete(ALLIANCE_REGISTRY);
        if (sessions.has(entry.handle)) allianceBound(entry).catch(() => {});
      }
      // base_corporation.GetCorpRegistry: another corporation, another registry.
      if ("corpid" in changes) {
        for (const service of CORPORATION_SERVICES) entry.monikers.delete(service);
        // crimewatchSvc.ProcessSessionChange and bco_members.OnSessionChanged: in another corporation, its aggression
        // settings and its members' names are read at once. (The choosing of the character reads them itself.)
        entry.aggression = null;
        if (changes.corpid[1] && sessions.has(entry.handle)) corporationRead(entry);
        // standingsvc.ProcessSessionChange: in another corporation the standings are read again. (The choosing of
        // the character reads them itself, once the character is on the session.)
        if (changes.corpid[1] && sessions.has(entry.handle)) refreshStandings(entry);
      }
      if (LOCATION_ATTRIBUTES.some((name) => name in changes)) {
        // targetMgr.ProcessSessionChange: docked, or its ballpark let go, it has no targets. Undocking, or logging in
        // in space, godma asks what the ship has locked and what has it locked, once its dogma location is primed.
        entry.targetsOwed = arrivingInSpace(entry, changes);
        if (entry.targetsOwed) entry.targets.forget();
        else entry.targets.emptied();
        forgetLocationObjects(entry);
        if (sessions.has(entry.handle)) syncSpace(entry);
      }
      record(entry, sessionChangeToBridgeJson(changes));
    });

    let result;
    let row;
    try {
      await session.login(userName, passwordFor(userName));
      // The login function the server sends has been answered: if it was the one that frees the client's clock, this pilot's is free.
      clock.loggedIn(session.handshakeAnswer);
      if (positive(session.attributes.userid) !== accountID) {
        throw fail("SESSION_SELECT_FAILED", "The game server logged that name in as a different account.");
      }
      // gameui.OnSessionChanged (449): an account come onto the session has its clone's grade asked. A grade that
      // could not be read is asked for when it is next wanted, as the client's service asks where it has none.
      await cloneGradeRead(entry).catch(() => {});
      // The character selection screen, as the retail client fills and leaves it.
      for (const method of ["GetCharacterSelectionData", "GetCharacterLockType", "SelectCharacterID"]) {
        ledger.note("charUnboundMgr", method, shape("charUnboundMgr", method, [], null));
      }
      const selection = wireToBridgeJson(await session.call("charUnboundMgr", "GetCharacterSelectionData", []));
      row = selectionRow(selection, characterID);
      if (!row) throw fail("CALL_REFUSED", "That character is not on this account.");
      entry.selection = selection;
      entry.characterName = String(keyValField(row, "characterName") || "");
      const lockType = await session.call("charUnboundMgr", "GetCharacterLockType", [characterID]);
      if (lockType !== null && lockType !== undefined) {
        throw fail("CALL_REFUSED", LOCK_REFUSALS.get(Number(lockType)) ?? "CharacterLocked");
      }
      // The gateway's session begins at this call, so what the server pushed
      // while logging in (the account's own session change) is not part of it.
      entry.backlog.length = 0;
      entry.history.length = 0;
      entry.sequence = 0;
      result = await session.call("charUnboundMgr", "SelectCharacterID", argumentsToWire(args), kwargs);
      // The session change that puts the character on the session arrives
      // before the answer. Give a slow server a moment, then take it at its word.
      for (let waited = 0; positive(session.attributes.charid) !== characterID && waited < selectSettleMs; waited += 50) {
        await sleep(50);
      }
      if (positive(session.attributes.charid) !== characterID) {
        throw fail("SESSION_SELECT_FAILED", "charUnboundMgr.SelectCharacterID completed without bringing a character online.");
      }
      // standingsvc.ProcessSessionChange: a character chosen has its standings read.
      await refreshStandings(entry);
      // skillsvc, skillQueueSvc and the notifications: a character chosen has its skills, its queue and its history read.
      await primeSkills(entry);
      // journal._UpdateMissionDataFull: a character chosen has its agents' journal read, for the missions it is on.
      await journalUpToDate(entry).catch(() => {});
      // crimewatchSvc: the client's states, as a character on the session and a system under it each ask them; and
      // the pilot's own security status, which the client asks for once.
      await clientStatesAtAChange(entry, { charid: [null, characterID], ...(attribute(entry, "solarsystemid") === null ? {} : { solarsystemid: [null, attribute(entry, "solarsystemid")] }) });
      await securityStatusRead(entry).catch(() => {});
      // crimewatchSvc and bco_members: the corporation's registry is bound, and asked its settings and its members' names.
      await corporationRead(entry);
      // addressbook.GetContacts: the pilot's contacts, its corporation's, and who of the watched is online.
      await addressBookRead(entry);
      // The lobby of a docked client is up from the first: its reads are asked as the character is chosen in a station.
      await lobbyRead(entry, { chosen: true });
      // bco_applications: the pilot's own applications, which the client asks for once.
      await corporationAsk(entry, "GetMyApplications").catch(() => {});
      // contracts.NeocomBlink: what of the pilot's contracts wants attention, asked once the notifications are ready.
      await asks(entry, "contractProxy", "GetLoginInfo").catch(() => {});
      // notificationUI._NotificationProvider: all the pilot's notifications, from the first, for the notification window.
      await keptRead(entry, NOTIFICATION_MGR, "GetAllNotifications", shape(NOTIFICATION_MGR, "GetAllNotifications", [], { fromID: 0 }, contextFor(entry))).catch(() => {});
      // calendar.GetEventsNextXMonths: this month's events and the next's, by the server's clock, a month at a time.
      for (const monthAndYear of monthAndNext(session.serverNow())) {
        await keptRead(entry, CALENDAR_PROXY, "GetEventList", shape(CALENDAR_PROXY, "GetEventList", monthAndYear, null, contextFor(entry))).catch(() => {});
      }
      // agents.__GetAllAgents: the table of agents is asked for as a character is chosen. The choosing does not wait
      // on it, so it is asked for last: a call sent right behind it was answered 50 to 80 ms late (2026-10-09).
      agentsKnown(entry);
    } catch (error) {
      session.close();
      // The login failing is not the select call failing; say what the session said.
      if (/^(LOGIN_REFUSED|LOGON_QUEUE|BAD_SERVER_SIGNATURE|INCOMPATIBLE_PROTOCOL|HANDSHAKE_INCOMPATIBLE)/.test(String(error && error.code))) {
        throw fail("SESSION_SELECT_FAILED", String(error.message));
      }
      const mapped = toPilotError(error, "charUnboundMgr", "SelectCharacterID");
      // No session was ever handed out, so there is none to have lost.
      throw mapped.code === "SESSION_NOT_FOUND"
        ? fail("SESSION_SELECT_FAILED", "The game server closed the connection during character selection.")
        : mapped;
    }
    // The readings after the choosing fail quietly, each for itself. A connection lost under them is the choosing lost.
    if (session.closed) throw fail("SESSION_SELECT_FAILED", "The game server closed the connection during character selection.");

    sessions.set(entry.handle, entry);
    session.onClose(() => end(entry, "connection_closed"));
    // A pilot that was left in space comes back in space.
    syncSpace(entry);
    return {
      bridgeSessionID: entry.handle,
      service: "charUnboundMgr",
      method: "SelectCharacterID",
      result: wireToBridgeJson(result === undefined ? null : result),
      notifications: drain(entry),
      session: {
        userid: accountID,
        characterID,
        characterName: String(keyValField(row, "characterName") || ""),
        stationID: attribute(entry, "stationid"),
        structureID: attribute(entry, "structureid"),
        solarSystemID: attribute(entry, "solarsystemid2") ?? attribute(entry, "solarsystemid"),
        corporationID: attribute(entry, "corpid"),
        shipID: attribute(entry, "shipid"),
      },
    };
  }

  /** A service's own method: at the proxy node for a service the client reaches with sm.ProxySvc, by the name alone for any other. */
  const byName = (session, service, method, form) => (form.proxy
    ? session.proxyCall(service, method, argumentsToWire(form.args), form.kwargs)
    : session.call(service, method, argumentsToWire(form.args), form.kwargs));

  async function callMethod(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    assertAllowed(service, method);
    // What the client has to hand before it makes this call: godma primed for the ship, which it is from the moment it has one,
    // and anything just fitted answered for.
    if (retailNeeds(service, method) === "orders") await ownOrdersRead(entry);
    if (retailNeeds(service, method) === "fee" || retailNeeds(service, method) === "sale") await feeInputsRead(entry);
    if (retailNeeds(service, method) === "sale") await saleAveragesRead(entry, args);
    if (retailNeeds(service, method) === "dogma") {
      await shipReadings(entry, whereabouts(entry));
      await entry.itemWork;
    }
    // The client's agents service has the table of agents from when its character was chosen, and asks for it only
    // where it has none.
    if (service === "agentMgr" && method === "GetAgents") {
      await run(entry, service, method, () => agentsKnown(entry));
      return { service, method, result: agentsTable, notifications: drain(entry) };
    }
    const form = shape(service, method, args, kwargs, contextFor(entry));
    // What a service of the client's keeps until it changes is that service's to answer, and is noted where it is asked for.
    if (Object.hasOwn(KEPT_UNTIL_CHANGED, service) && KEPT_UNTIL_CHANGED[service].keptAs(method, form) !== null) {
      const kept = await run(entry, service, method, () => keptRead(entry, service, method, form));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // The formations are asked for once, as the client's object cache has them after its first asking.
    if (service === "beyonce" && method === "GetFormations") {
      const known = await run(entry, service, method, () => formationsKnown(entry));
      return { service, method, result: wireToBridgeJson(known === undefined ? null : known), notifications: drain(entry) };
    }
    // An attribute's value is the client's own dogma location's to answer, where godma holds the item.
    if (service === "dogmaIM" && method === "QueryAttributeValue") {
      const held = attributeHeld(entry, form.args);
      if (held !== undefined) return { service, method, result: held, notifications: drain(entry) };
    }
    // What the ship has locked, and what has it locked, are the client's target service's to answer.
    if (service === "dogmaIM" && Object.hasOwn(TARGETS_KEPT, method)) {
      const kept = await run(entry, service, method, async () => {
        // Asking for them is godma's own, and godma is primed first.
        if (entry.targetsOwed && whereabouts(entry).shipID) await shipReadings(entry, whereabouts(entry));
        return targetsRead(entry, method);
      });
      return { service, method, result: wireToBridgeJson(kept), notifications: drain(entry) };
    }
    // The guests of the station a pilot is docked in, and the station's own item, are the client's station
    // service's to answer, where they are asked as the client asks them. (For a pilot in no station nothing is
    // ever had, and each asking is sent.)
    if (STATION_KEPT.has(`${service}.${method}`) && form.args.length === 0 && form.kwargs === null) {
      const kept = await run(entry, service, method, () => stationRead(entry, service, method, form));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // The account's clone grade is the client's clone grade service's to answer, where it is asked as the client
    // asks it: with nothing.
    if (keptCloneGrade(service, method, form)) {
      const kept = await run(entry, service, method, () => cloneGradeRead(entry));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // crimewatchSvc's client states and the pilot's security status are that service's to answer, where they are
    // asked as the client asks them: with nothing.
    if (keptOfCrimewatch(service, method, form)) {
      const kept = await run(entry, service, method, () => crimewatchKept(entry, method));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // The corporations with offices where a pilot is docked are the client's office manager's to answer, where
    // they are asked as the client asks them: of the station's own object, with nothing.
    if (service === OFFICE_MANAGER && method === STATION_OFFICES && form.moniker && form.args.length === 0 && form.kwargs === null) {
      const kept = await run(entry, service, method, () => entry.stationOffices.read(method, () => {
        // Asked of the service by name and made on its moniker, as any call of a moniker's is noted.
        ledger.note(service, method, form.status === "same" ? { ...form, status: "reshaped" } : form);
        return monikerCall(entry, service, method, [], null);
      }));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // The office's item is primed once for a station's Moniker, whatever is rented or given up there since.
    if (service === OFFICE_MANAGER && method === PRIME_OFFICE && form.moniker && form.args.length === 0 && form.kwargs === null) {
      const kept = await run(entry, service, method, () => entry.officePrimed.read(method, () => {
        ledger.note(service, method, form.status === "same" ? { ...form, status: "reshaped" } : form);
        return monikerCall(entry, service, method, [], null);
      }));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // The standings service's two lists: answered from what is kept, where anything is. Nothing is sent, and nothing is counted.
    if (service === STANDING_MGR && Object.hasOwn(STANDINGS_KEPT, method) && form.args.length === 0 && form.kwargs === null) {
      await entry.standingsWork;
      if (entry.standings.loaded) {
        return { service, method, result: wireToBridgeJson(entry.standings[STANDINGS_KEPT[method]]()), notifications: drain(entry) };
      }
    }
    // The journal service's reading (journal.py 290): the whole asked for once and kept, a changed mission's agent
    // asked for its own part. Asked for by name, as the page asks when it shows the journal, it is answered from
    // the journal as it is kept, made right first. Where no journal is kept (what the server answered was none),
    // the call goes on as any call does.
    if (service === "agentMgr" && method === "GetMyJournalDetails" && form.args.length === 0 && form.kwargs === null) {
      await run(entry, service, method, () => journalUpToDate(entry));
      const journal = entry.journal.read();
      if (journal) return { service, method, result: wireToBridgeJson(journal), notifications: drain(entry) };
    }
    // The selection screen's data: the client's character service keeps what it was answered at the choosing
    // (ccSvc.GetCharacterSelectionData), and whoever asks it again, as its queue service does to count the
    // account's characters in training, has that. Asked for by name with nothing, it is what was kept: nothing
    // is sent, and nothing is counted.
    if (service === "charUnboundMgr" && method === "GetCharacterSelectionData" && form.args.length === 0 && form.kwargs === null) {
      return { service, method, result: entry.selection, notifications: drain(entry) };
    }
    // The home station service's read: asked once and kept, until the server says the home station is another.
    if (service === HOME_STATION && method === GET_HOME_STATION && form.args.length === 0 && form.kwargs === null) {
      const kept = await run(entry, service, method, () => entry.homeStation.read(method, () => {
        ledger.note(service, method, form);
        return byName(entry.session, service, method, form);
      }));
      return { service, method, result: wireToBridgeJson(kept), notifications: drain(entry) };
    }
    // The account service's static data: asked once and kept, however many windows want it and however many at once.
    if (service === ACCOUNT && ACCOUNT_STATIC.has(method)) {
      const kept = await run(entry, service, method, () => entry.accountStatic.read(method, () => {
        ledger.note(service, method, form);
        return byName(entry.session, service, method, form);
      }));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    // objectCaching.PerformCachedMethodCall: what the server marked as cached is answered from its first answer
    // for as long as the client would keep it. Nothing is sent, and nothing is counted.
    if (!form.moniker && typeof entry.session.cachedMethodCall === "function") {
      const kept = entry.session.cachedMethodCall(service, method, argumentsToWire(form.args));
      if (kept) return { service, method, result: wireToBridgeJson(kept.result === undefined ? null : kept.result), notifications: drain(entry) };
    }
    // Asked of the service by name and made on its moniker: the arguments may be the client's as they stand, the call was not.
    // What the client's skill services keep is noted where it is asked for, which is not every time it is wanted (skillRead).
    const keptByAService = (service === SKILL_HANDLER && (Object.hasOwn(SKILL_KEPT, method) || isSkillQueueRead(method, form.args, form.kwargs))) ||
      (service === CORP_REGISTRY && method === AGGRESSION_SETTINGS);
    if (!keptByAService) {
      ledger.note(service, method, ON_AN_ANSWERED_OBJECT.has(`${service}.${method}`)
        ? { ...form, status: "differs", note: "Asked of the service by its name. The client asks the object another call answered." }
        : form.moniker && form.status === "same" ? { ...form, status: "reshaped" } : form);
    }
    // A call the client makes on a service's moniker is made on the object bound for where the pilot is.
    const result = await run(entry, service, method, async () => (form.moniker
      ? monikerCall(entry, service, method, argumentsToWire(form.args), form.kwargs)
      : byName(entry.session, service, method, form))).finally(() => {
      forgetKeptAfter(entry, service, method);
      if (mayChangeContents(service, method)) entry.listings.forget();
    });
    // crimewatchSvc.SetSafetyLevel (343 to 345): once the server has taken the level, it is the level the client has.
    if (service === CRIMEWATCH && method === SET_SAFETY_LEVEL) await safetyLevelSet(entry, form.args[0]);
    // What the client's own code names beside this call, which it does once the call is done (a refusal threw above).
    forgetNamed(entry, namedAfterCall(service, method, argumentsToWire(form.args), entry.session.attributes));
    // targetMgr._LockTarget: (flag, targets) with no flag set says the lock is made already, and the client adds the target itself.
    if (service === "dogmaIM" && method === "AddTarget" && itemsOf(result).length > 0 && !itemsOf(result)[0]) entry.targets.added(form.args[0]);
    return {
      service,
      method,
      result: wireToBridgeJson(result === undefined ? null : result),
      notifications: drain(entry),
    };
  }

  // ── the pilot's own market orders, as the object cache has them ──────────

  /**
   * marketQuote.GetMyOrders: GetMarketProxy().GetCharOrders(), which the client's object cache keeps for the run and
   * OnOwnOrdersChanged names. One order of that list by its ID, as its row has it by the columns' names (each value
   * as it came off the wire): null where the session keeps no list, or the order is not in it.
   */
  function ownOrderOf(entry, orderID) {
    const kept = typeof entry.session.cachedMethodCall === "function" ? entry.session.cachedMethodCall(MARKET_PROXY, OWN_ORDERS, []) : null;
    return kept ? rowsetLine(kept.result, "orderID", orderID) : null;
  }

  /**
   * The pilot's orders asked for where the session keeps none, as the client has them before it takes one down or
   * reprices it: both are done from its list of them. Noted as the client's own asking. A refusal is not this
   * call's to tell: the order then goes out as it came.
   */
  async function ownOrdersRead(entry) {
    if (typeof entry.session.cachedMethodCall !== "function" || entry.session.cachedMethodCall(MARKET_PROXY, OWN_ORDERS, [])) return;
    const form = shape(MARKET_PROXY, OWN_ORDERS, [], null, contextFor(entry));
    ledger.note(MARKET_PROXY, OWN_ORDERS, form);
    await byName(entry.session, MARKET_PROXY, OWN_ORDERS, form).catch(() => {});
  }

  // ── the broker's fee rate, as the client works it out ────────────────────

  /**
   * marketsvc.GetBrokersFeeCommissionFromStationID (161): the broker's fee rate at a station, from the pilot's
   * Broker Relations in effect and the standings the station's owner and its faction have to the pilot, where the
   * owner is an NPC (brokerFee.js). Null where it cannot be worked out here: what is no station of the game's data
   * (a structure's rate is asked of the server), or the pilot's skills or standings are not kept.
   *
   * Not lowered for a system the militias have upgraded: the client asks the war's manager for that, and this
   * server does not lower its own rate for it either.
   */
  function brokersFeeAt(entry, stationID) {
    const station = stationOwner(positive(stationID));
    if (!station) return null;
    // marketsvc.FactionAndCorpToCharStandings (745): an owner that is no NPC has no standing that counts, nor has its faction.
    const npc = station.ownerID > MAX_SYSTEM_ITEM && station.ownerID < MIN_PLAYER_OWNER;
    const sums = {
      brokerRelations: entry.skills.effectiveLevel(TYPE_BROKER_RELATIONS),
      factionToCharStanding: npc ? entry.standings.toCharacter(station.factionID) : 0.0,
      corpToCharStanding: npc ? entry.standings.toCharacter(station.ownerID) : 0.0,
    };
    // A skill's level or a standing that is not known is null: no rate is made of a guess.
    return Object.values(sums).every((value) => typeof value === "number") ? brokersFeeRate(sums) : null;
  }

  /**
   * buySellItemContainerBase.py 28: each entry of the client's sale window asks the market for its type's average
   * price when it is made, which is the two halves of the type's price history (marketsvc.GetAveragePrice, 368).
   * Here they are asked for as the sale goes, once for each item that has no delta of its own, each noted as the
   * client's asking, and the average worked out from them (priceHistory.js) is kept for the shaping of this sale.
   * A history that cannot be read leaves the type without an average: the item then goes without a delta.
   */
  async function saleAveragesRead(entry, args) {
    entry.saleAverages.clear();
    const [given] = Array.isArray(args) ? args : [];
    for (const item of itemsOf(given)) {
      const typeID = item && typeof item === "object" && item.type === undefined && item.delta === undefined ? positive(item.typeID) : null;
      if (typeID === null) continue;
      const half = (method) => {
        const form = shape(MARKET_PROXY, method, [typeID], null, contextFor(entry));
        ledger.note(MARKET_PROXY, method, form);
        return byName(entry.session, MARKET_PROXY, method, form);
      };
      try {
        const old = historyRows(await half("GetOldPriceHistory"));
        const fresh = historyRows(await half("GetNewPriceHistory"));
        const now = BigInt(Math.trunc(entry.session.serverNow())) * 10000n + FILETIME_OF_UNIX_EPOCH;
        entry.saleAverages.set(typeID, averagePrice(old, fresh, now, typeBasePrice(typeID) ?? undefined));
      } catch {
        // Not this sale's to tell. Nothing is kept from a sale before (cleared above), so the type has no average.
      }
    }
  }

  /** The rate for whoever wants to show it: what an order placed at that station would name, or null. */
  async function brokersFeeRateFor(stationID, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    await feeInputsRead(entry);
    return brokersFeeAt(entry, stationID);
  }

  /**
   * What the rate is worked out from, read where it is not kept: the pilot's skills, as its skill service has them
   * from the first thing that wants them, and its standings, which are read when it is chosen. Neither failing is
   * this call's to tell: the order then names no rate.
   */
  async function feeInputsRead(entry) {
    if (!entry.skills.has("skills")) await skillRead(entry, "GetSkills", []).catch(() => {});
    if (!entry.standings.loaded) await (entry.standingsWork ?? refreshStandings(entry));
  }

  // ── an attribute's value, from what godma holds ──────────────────────────

  /**
   * baseDogmaLocation.GetAttributeValue (1722): the client asks its own dogma location for an attribute's value,
   * never the server. Here godma answers for an item it was told of, with the value as it stands now (what
   * GetAllInfo brought, and each change the server has told of since). Undefined for an item, or an attribute of
   * one, that godma holds nothing of: that is the server's to answer.
   */
  function attributeHeld(entry, args) {
    // Null from godma is "nothing held": of the item, or of that attribute of it.
    const value = entry.dogma.attribute(args[0], args[1]);
    return typeof value === "number" ? value : undefined;
  }

  /**
   * The session's object cache is told to forget the calls named, as the client's own code tells its cache
   * (objectCaching.InvalidateCachedMethodCalls): what cachedCallsNamed.js answers for a notice, for a change to
   * the session, and for one of the pilot's own calls. What the server names itself is the session's to hear.
   */
  function forgetNamed(entry, named) {
    if (named.length > 0 && typeof entry.session.invalidateCachedMethodCalls === "function") entry.session.invalidateCachedMethodCalls(named);
  }

  // ── what the ship has locked, as it is kept ──────────────────────────────

  /**
   * One of the dogma location's two reads the target service keeps (TARGETS_KEPT): answered from what is kept, and
   * asked for, and noted, where the list is not known. One asking after another.
   */
  function targetsRead(entry, method) {
    const which = TARGETS_KEPT[method];
    const reading = entry.targetsWork.then(async () => {
      const kept = entry.targets.read(which);
      if (kept !== undefined) return kept;
      const asked = entry.targets.asking();
      ledger.note("dogmaIM", method, shape("dogmaIM", method, [], null, contextFor(entry)));
      const answer = await monikerCall(entry, "dogmaIM", method, [], null);
      entry.targets.keep(which, answer, asked);
      return answer === undefined ? null : answer;
    });
    entry.targetsWork = reading.catch(() => {});
    return reading;
  }

  /** godma.RefreshTargets (2360): what the ship has locked, then what has it locked, each asked for if it is not known. */
  async function targetsRefreshed(entry) {
    entry.targetsOwed = false;
    for (const method of Object.keys(TARGETS_KEPT)) await targetsRead(entry, method);
  }

  /**
   * Whether a change of the session's is one godma asks for the targets at (targetMgr.ProcessSessionChange 492):
   * the session has a solar system where it had none, and is in no station. That is logging in in space, as the
   * client calls it, and undocking from a station too: docked in one, a session has no solar system. (Docked in a
   * structure it has one, so logging in there is the same change, and the client asks there as well.)
   */
  function arrivingInSpace(entry, changes) {
    const system = changes.solarsystemid;
    return Boolean(system) && positive(system[0]) === null && attribute(entry, "stationid") === null;
  }

  // ── the names of owners, as the client's cfg.eveowners has them ──────────

  /**
   * cfg.eveowners.Prime(keys) (carbon cfg.py, Recordset._Prime): of the owners asked about, those not known yet
   * are asked for in one call, config.GetMultiOwnersEx(a list of their IDs), by name. Each row answered,
   * (ownerID, ownerName, typeID, gender, ownerNameID), is kept for as long as the pilot is on. An owner the
   * server answers no row for is not asked about again (the Recordset's knownLuzers). One asking after another.
   *
   * Answers a Map of each owner asked about to { name, typeID }, or to null for one with no row. The type says
   * what the owner is. Fails as the call fails, with nothing kept of it.
   */
  async function ownersNamed(ownerIDs, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    const wanted = [...new Set((Array.isArray(ownerIDs) ? ownerIDs : []).map(positive).filter((ownerID) => ownerID !== null))];
    const priming = entry.ownersWork.then(() => run(entry, "config", "GetMultiOwnersEx", async () => {
      const unknown = wanted.filter((ownerID) => !entry.owners.has(ownerID));
      if (unknown.length > 0) {
        ledger.note("config", "GetMultiOwnersEx", OWNERS_AS_THE_CLIENT_ASKS);
        const [header, rows] = itemsOf(await entry.session.call("config", "GetMultiOwnersEx", [{ type: "list", items: unknown }], null));
        const columns = itemsOf(header).map(textOf);
        const [ownerID, ownerName, typeID] = ["ownerID", "ownerName", "typeID"].map((column) => columns.indexOf(column));
        for (const row of itemsOf(rows).map(itemsOf)) entry.owners.set(positive(row[ownerID]), { name: textOf(row[ownerName]), typeID: positive(row[typeID]) ?? 0 });
        for (const each of unknown) if (!entry.owners.has(each)) entry.owners.set(each, null);
      }
      return new Map(wanted.map((each) => [each, entry.owners.get(each)]));
    }));
    entry.ownersWork = priming.catch(() => {});
    return priming;
  }

  // ── the station, as the client's station service keeps it ────────────────

  /**
   * station/base.py GetGuests (99) and GetStationItem (573): answered from what is kept for the station the pilot
   * is in, and asked for, and noted, where nothing is. One reading at a time, so that two that find nothing kept
   * ask once. An answer that is no list is handed on as it came with nothing kept of it, and so is one that came
   * after the pilot had left that station.
   */
  function stationRead(entry, service, method, form) {
    const ofGuests = service === "station";
    const reading = entry.stationWork.then(async () => {
      const stationID = attribute(entry, "stationid");
      if (ofGuests ? entry.station.guestsKnown(stationID) : entry.station.itemKnown(stationID)) {
        return ofGuests ? { type: "list", items: entry.station.guestsRead() } : entry.station.itemRead();
      }
      ledger.note(service, method, form);
      const answered = await byName(entry.session, service, method, form);
      if (isAList(answered) && attribute(entry, "stationid") === stationID) {
        if (ofGuests) entry.station.guestsReceived(stationID, answered);
        else entry.station.itemReceived(answered);
      }
      return answered;
    });
    entry.stationWork = reading.catch(() => {});
    return reading;
  }

  // ── what the client's services keep until it changes ──────────────────────

  /**
   * A read of a planet's own object that is kept by the planet: answered from what is kept, and asked for, and
   * noted, where nothing is. A colony kept longer than PLANET_INFO_KEPT_MS is asked for again. One that could not
   * be asked is not kept.
   */
  function planetRead(entry, object, method, ask) {
    const keptAs = `${method}:${JSON.stringify(object.params)}`;
    const kept = entry.planetReads.get(keptAs);
    if (kept && (method !== PLANET_INFO || now() - kept.at < PLANET_INFO_KEPT_MS)) return kept.answer;
    const record = { at: now(), answer: ask() };
    entry.planetReads.set(keptAs, record);
    record.answer.catch(() => { if (entry.planetReads.get(keptAs) === record) entry.planetReads.delete(keptAs); });
    return record.answer;
  }

  /** One of crimewatchSvc's own askings, with nothing, on a Moniker made for the call (eveMoniker.CharGetCrimewatchLocation()): noted as it is sent. */
  function crimewatchAsked(entry, method) {
    ledger.note(CRIMEWATCH, method, shape(CRIMEWATCH, method, [], null, contextFor(entry)));
    return monikerCall(entry, CRIMEWATCH, method, [], null);
  }

  /**
   * crimewatchSvc.ProcessSessionChange (94) and OnSessionChanged (116): the client's states asked for where the
   * change has the place or the character in it, and again where the pilot is in space and the change has the
   * system or the ship in it. Each asking's answer is what is kept from then on. Each fails for itself.
   */
  async function clientStatesAtAChange(entry, changes) {
    const asked = () => entry.clientStates.read(CLIENT_STATES, () => crimewatchAsked(entry, CLIENT_STATES)).catch(() => {});
    if ("locationid" in changes || "charid" in changes) {
      entry.clientStates.forget();
      await asked();
    }
    if (attribute(entry, "solarsystemid") !== null && ("solarsystemid" in changes || "shipid" in changes)) {
      entry.clientStates.forget();
      await asked();
    }
  }

  /** One of crimewatchSvc's two kept reads: what is kept, or asked for where nothing is. */
  /**
   * crimewatchSvc.SetSafetyLevel: the client sets the level at the server, keeps it as the level it has, and asks
   * crimewatch nothing. The states kept say it in their fourth place, after the timers, the engagements and who is
   * flagged (GetClientStates, 96); what is kept in another form says no level, and is left as it is.
   */
  const safetyLevelSet = (entry, level) => entry.clientStates.amend(CLIENT_STATES, (states) => (
    Array.isArray(states) && states.length === 4 ? [states[0], states[1], states[2], level] : states));

  const crimewatchKept = (entry, method) => (method === CLIENT_STATES
    ? entry.clientStates.read(method, () => crimewatchAsked(entry, method))
    : securityStatusRead(entry));

  /**
   * clone_grade_svc.get_clone_grade_with_grace_period (113): sm.RemoteSvc('subscriptionMgr').GetCloneGrade(), by the
   * service's name, asked for while there is none and kept.
   */
  async function cloneGradeRead(entry) {
    if (entry.cloneGrade === undefined) {
      ledger.note(SUBSCRIPTION_MGR, CLONE_GRADE, shape(SUBSCRIPTION_MGR, CLONE_GRADE, [], null));
      entry.cloneGrade = await entry.session.call(SUBSCRIPTION_MGR, CLONE_GRADE, []);
    }
    return entry.cloneGrade;
  }

  /** crimewatchSvc.GetMySecurityStatus (590): asked for while there is none, and kept. */
  async function securityStatusRead(entry) {
    if (entry.securityStatus === undefined) entry.securityStatus = await crimewatchAsked(entry, OWN_SECURITY_STATUS);
    return entry.securityStatus;
  }

  /**
   * What a docked client's lobby asks as it comes up, on the pilot's own session and as the client sends each.
   * As a character is chosen in a station: the offices its corporation rents (officeManager.corp_offices), the
   * station's own item and its guests (station/base.py GetStationItem, GetGuests), and the map's stations
   * (uisvc.GetStation), in the order the server's log of a retail client logging in docked has them. As a pilot
   * docks: the item and the guests, the other two being the client's still. A pilot in no station is asked none.
   * Each is kept as its own service keeps it, so that what the page reads of them after is answered from here;
   * and each fails for itself.
   */
  async function lobbyRead(entry, { chosen = false } = {}) {
    if (attribute(entry, "stationid") === null) return;
    const form = (service, method) => shape(service, method, [], null, contextFor(entry));
    if (chosen) await keptRead(entry, OFFICE_MANAGER, "GetMyCorporationsOffices", form(OFFICE_MANAGER, "GetMyCorporationsOffices")).catch(() => {});
    await stationRead(entry, "stationSvc", "GetStationItemBits", form("stationSvc", "GetStationItemBits")).catch(() => {});
    await stationRead(entry, "station", "GetGuests", form("station", "GetGuests")).catch(() => {});
    if (chosen) await asks(entry, "map", "GetStationInfo").catch(() => {});
  }

  /** Every colony kept is forgotten, and asked for when it is next wanted. What a planet carries stays. */
  function forgetColonies(entry) {
    for (const keptAs of [...entry.planetReads.keys()]) if (keptAs.startsWith(`${PLANET_INFO}:`)) entry.planetReads.delete(keptAs);
  }

  /** One of the pilot's own writes that changes what a service keeps, done or refused, by name or on an object: what was kept may not be so. */
  function forgetKeptAfter(entry, service, method) {
    for (const [reads, keeper] of Object.entries(KEPT_UNTIL_CHANGED)) {
      if (Object.hasOwn(keeper.writes, service) && keeper.writes[service].has(method)) entry.kept[reads].forget();
    }
  }

  /** A read a service keeps the answer of (KEPT_UNTIL_CHANGED): answered from what is kept, and asked for, and noted, where nothing is. */
  function keptRead(entry, service, method, form) {
    return entry.kept[service].read(KEPT_UNTIL_CHANGED[service].keptAs(method, form), () => {
      ledger.note(service, method, form);
      return byName(entry.session, service, method, form);
    });
  }

  /** One of the client's own askings of a service by its name, with nothing: noted as it is sent. */
  function asks(entry, service, method) {
    const form = shape(service, method, [], null, contextFor(entry));
    ledger.note(service, method, form);
    return byName(entry.session, service, method, form);
  }

  /**
   * An account's connection: the retail client at its character selection and
   * creation screens, logged in as the account and nothing more. One for an
   * account, opened by the first thing asked on it.
   */
  function accountLine(accountID, userName) {
    const have = accountLines.get(accountID);
    if (have) return have;
    const line = { session: null, opening: null, calls: 0, timer: null };
    const forget = () => {
      if (accountLines.get(accountID) === line) accountLines.delete(accountID);
      timers.clearTimeout(line.timer);
      line.timer = null;
    };
    line.hangUp = () => {
      forget();
      if (line.session) line.session.close();
    };
    line.opening = (async () => {
      let transport;
      try {
        transport = await connect();
      } catch {
        throw fail("EVE_GATEWAY_UNREACHABLE", "The game server is unreachable.");
      }
      line.session = createSession(transport);
      // The server hanging up, or anything else that ends it: the next thing asked opens another.
      line.session.onClose(forget);
      await line.session.login(userName, passwordFor(userName));
      if (positive(line.session.attributes.userid) !== accountID) {
        throw fail("CALL_REFUSED", "The game server logged that name in as a different account.");
      }
      return line.session;
    })();
    accountLines.set(accountID, line);
    return line;
  }

  /**
   * A call the retail client makes before a character is chosen. On its
   * character selection and creation screens the client is logged in as the
   * account and nothing more, and it asks `charUnboundMgr` whatever those
   * screens need, all on the one connection.
   *
   * The BFF has no such screen open. What it asks for an account in one go
   * (making a character is five calls) is asked on one connection, logged in
   * as the client logs in, and the connection is closed when nothing has been
   * asked on it for a little while.
   *
   * The server lets an account log in beside its own pilot: only taking over a
   * character that is online puts the earlier session off
   * (charService.js, "Login takeover"). So this does not disturb a pilot of
   * the same account that something else is flying.
   */
  async function accountCall(service, method, args = [], kwargs = null, sessionFields = {}) {
    const accountID = positive(sessionFields && sessionFields.userid);
    const userName = String((sessionFields && sessionFields.userName) || "").trim();
    if (accountID === null) throw fail("CALL_INVALID", "Call session requires a positive integer userid.");
    if (!userName) throw fail("CALL_INVALID", "A game-port login needs the account's name.");
    assertAllowed(service, method);
    // Choosing a character brings it online on the connection it is chosen on, and this one is not kept.
    if (method === "SelectCharacterID") throw fail("CALL_NOT_ALLOWED", "A character is chosen by selecting it, not by a call of the account's.");
    const line = accountLine(accountID, userName);
    timers.clearTimeout(line.timer);
    line.timer = null;
    line.calls += 1;
    // No session was handed out for this call, so there is none for the caller to have lost.
    const failed = (error) => {
      const mapped = toPilotError(error, service, method);
      return mapped.code === "SESSION_NOT_FOUND" ? fail("CALL_FAILED", `${service}.${method} failed: the game server closed the connection.`) : mapped;
    };
    try {
      let session;
      try {
        session = await line.opening;
      } catch (error) {
        line.hangUp();
        throw failed(error);
      }
      try {
        const form = shape(service, method, args, kwargs, {});
        ledger.note(service, method, form);
        const result = await byName(session, service, method, form);
        return { service, method, result: wireToBridgeJson(result), notifications: [] };
      } catch (error) {
        // The server saying no is an answer, and the client stays on its screen. Anything else, and the connection is not asked again.
        if (!(error && error.code === "GAME_CALL_REFUSED")) line.hangUp();
        throw failed(error);
      }
    } finally {
      line.calls -= 1;
      if (line.calls === 0 && accountLines.get(accountID) === line) {
        line.timer = timers.setTimeout(line.hangUp, accountIdleMs);
        // A connection waiting to be closed is nothing to keep the process alive for.
        if (line.timer && typeof line.timer.unref === "function") line.timer.unref();
      }
    }
  }

  async function releaseBridgeSession(bridgeSessionID, sessionFields = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    end(entry, "session_released");
    // Closing the connection is the whole of a retail logoff, and the server
    // acts on it a moment later. "Released" is only said once it has.
    if (typeof isOnline === "function") {
      for (let waited = 0; waited < releaseSettleMs; waited += 100) {
        if ((await isOnline(entry.accountID, entry.characterID)) === false) {
          return { released: true, characterID: entry.characterID };
        }
        await sleep(100);
      }
      return { released: false, characterID: entry.characterID };
    }
    return { released: true, characterID: entry.characterID };
  }

  /**
   * The active ship's type and whether it is a capsule, from the ship's own row as godma holds it: primed with
   * GetAllInfo once for a ship in a place, as the client is. The client never asks ShipGetInfo.
   * Location is still worth reporting where godma could not be primed: an unknown type says so, and is never guessed.
   */
  async function shipFacts(entry, place) {
    await shipReadings(entry, place);
    const item = entry.dogma.item(place.shipID);
    const typeID = item ? positive(item.typeID) : null;
    const groupID = item ? positive(item.groupID) : null;
    return { shipID: place.shipID, typeID, isCapsule: typeID === null || groupID === null ? null : groupID === GROUP_CAPSULE };
  }

  /** Where the session says the pilot is. In space is `solarsystemid` set, as on any retail session. */
  function whereabouts(entry) {
    const stationID = attribute(entry, "stationid");
    const structureID = attribute(entry, "structureid");
    const inSpace = !stationID && !structureID && attribute(entry, "solarsystemid") !== null;
    return {
      inSpace,
      stationID,
      structureID,
      solarSystemID: attribute(entry, "solarsystemid2") ?? attribute(entry, "solarsystemid"),
      shipID: attribute(entry, "shipid"),
    };
  }

  /**
   * godma.Prime: the ship's items and their attributes, from the dogma location
   * bound for where the pilot is, in one call. Asked once for a ship in a
   * place; after that godma is told of each change. Answers what dogma says of
   * the ship now, or null if it could not be asked.
   */
  /** What godma is primed for: a ship in a place. It is primed again for another ship, or the same one somewhere else. */
  const primedFor = (entry, place) => `${place.shipID}@${place.stationID ?? place.structureID ?? attribute(entry, "solarsystemid")}`;

  async function shipReadings(entry, place) {
    const loadedFor = primedFor(entry, place);
    if (entry.dogmaLoaded !== loadedFor) {
      // Once for a ship in a place means once however many want its readings while the asking is out: the client
      // has one godma, and one priming of it. Each of them waits for the one answer.
      if (!entry.dogmaPriming || entry.dogmaPriming.for !== loadedFor) {
        const priming = { for: loadedFor, done: null };
        priming.done = primeGodma(entry, place, loadedFor).finally(() => {
          if (entry.dogmaPriming === priming) entry.dogmaPriming = null;
        });
        entry.dogmaPriming = priming;
      }
      if (!(await entry.dogmaPriming.done)) return null; // the snapshot is still worth having; the readings say unknown
    }
    return entry.dogma.shipReadings(place.shipID);
  }

  /** The asking itself. True where godma is primed for the ship in the place; false where dogma could not be asked; fails where the session is lost. */
  async function primeGodma(entry, place, loadedFor) {
    try {
      // godma.GetDogmaLM: the dogma location bound for where the pilot is, kept and asked everything of.
      ledger.note("dogmaIM", "GetAllInfo", DOGMA_AS_GODMA_PRIMES);
      // primeCharacter, primeShip, primeStructure: a character and a ship, and no structure.
      const allInfo = await monikerCall(entry, "dogmaIM", "GetAllInfo", [true, true, null]);
      entry.dogma.clear();
      entry.dogma.loadAllInfo(allInfo);
      entry.dogmaLoaded = loadedFor;
      if (entry.targetsOwed) targetsRefreshed(entry).catch(() => {});
      // The ship's own row, as the server gave it: what ShipGetInfo would answer, were it asked.
      const rows = keyValField(wireToBridgeJson(allInfo), "shipInfo");
      const own = rows && Array.isArray(rows.entries) ? rows.entries.find(([itemID]) => positive(itemID) === place.shipID) : null;
      entry.shipRow = own ? own[1] : null;
      return true;
    } catch (error) {
      const mapped = toPilotError(error, "dogmaIM", "GetAllInfo");
      if (mapped.code === "SESSION_NOT_FOUND") {
        end(entry, "connection_closed");
        throw mapped;
      }
      return false;
    }
  }

  /**
   * michelle.UpdateBallpark: a ballpark while the session is in a solar system
   * and not docked, and none otherwise; a new one for a new system.
   */
  function syncSpace(entry) {
    const place = whereabouts(entry);
    const wanted = place.inSpace ? attribute(entry, "solarsystemid") : null;
    if (entry.space && entry.space.solarSystemID !== wanted) {
      entry.space.release();
      entry.space = null;
      // Its orders were to a ship in that ballpark.
      entry.lastMove = null;
    }
    if (wanted !== null && !entry.space) {
      entry.space = createSpace({ session: entry.session, solarSystemID: wanted, sleep, simTime: entry.clock.simTime, askFormations: () => formationsKnown(entry), onError: (error, what) => onSpaceError(error, what, entry.characterID) });
      // michelle.DoDestinyUpdate: the dogma messages riding with a ballpark update are scattered as OnMultiEvent, which is godma's.
      entry.space.park.onMultiEvent = (messages) => entry.dogma.multiEvent(messages);
      // targetMgr.DoBallsRemove: a ball that goes is no target any more.
      entry.space.park.onBallsRemoved = (gone) => entry.targets.ballsRemoved(gone.map((each) => each.id));
      // Nobody waits on this: the state arrives when the server has answered the bind.
      Promise.resolve(entry.space.start()).catch((error) => onSpaceError(error, "start", entry.characterID));
    }
  }

  async function readFlightStatus(bridgeSessionID, sessionFields = {}) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    const ship = place.shipID ? await shipFacts(entry, place) : null;
    return {
      flight: {
        inSpace: place.inSpace,
        docked: !place.inSpace && Boolean(place.stationID || place.structureID),
        solarSystemID: place.solarSystemID,
        stationID: place.stationID,
        structureID: place.structureID,
        shipID: place.shipID,
        shipTypeID: ship ? ship.typeID : null,
        shipIsCapsule: ship ? ship.isCapsule : null,
        // session.corprole: the roles the pilot has in its corporation, as the server's session has them now. The
        // client's lobby reads its buttons off it (dockedUI/controllers/baseController.py, _HasRole). A 64-bit
        // mask, so as its digits. The BFF keeps it for itself and hands the page none of it.
        corpRole: String(wholeOf(entry.session.attributes.corprole) ?? 0n),
        // Movement is the pilot's own ball in its ballpark; nothing to say when docked or before the state has come.
        ...(place.inSpace && entry.space && entry.space.park.validState ? projectFlight(entry.space.park) : { shipMode: null, shipSpeedFraction: null }),
      },
      notifications: drain(entry),
    };
  }

  async function readSpaceSnapshot(bridgeSessionID, sessionFields = {}) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    // The pace the pilot's clock is meant to hold (blue.os.desiredSimDilation): what the client's time dilation indicator reads.
    const timeDilation = entry.clock.timeDilation;
    if (place.inSpace) {
      const park = entry.space ? entry.space.park : null;
      const readings = park && park.validState ? await shipReadings(entry, place) : null;
      return {
        // Until the server's state has arrived there is a park and nothing in it.
        space: park && park.validState
          ? { ...projectSpace(park, { solarSystemID: place.solarSystemID, shipID: place.shipID, readings, warpDestination: entry.warpDestination ?? null, alignTarget: alignTargetOf(entry, park), simTime: entry.space.simTime() }), timeDilation }
          : { inSpace: true, solarSystemID: place.solarSystemID, shipID: place.shipID, sampledAtMs: now(), entities: [], ship: null, timeDilation },
        notifications: drain(entry),
      };
    }
    return {
      space: { inSpace: false, solarSystemID: place.solarSystemID, shipID: place.shipID, sampledAtMs: now(), entities: [], ship: null, timeDilation },
      notifications: drain(entry),
    };
  }

  /**
   * The scanner as the retail client's scan service has it: the probes it has
   * been told of (pilotScanner.js), and the launcher godma shows on the ship
   * (scanSvc.GetProbeLauncher, GetChargesInProbeLauncher). Nothing is asked of
   * the server for the probes: a pilot that logs in with probes still out has
   * none here until it reconnects to them, as on the client.
   */
  async function readScannerState(bridgeSessionID, sessionFields = {}) {
    const entry = held(bridgeSessionID, sessionFields);
    const place = whereabouts(entry);
    if (!place.inSpace) {
      return {
        scanner: { inSpace: false, solarSystemID: place.solarSystemID, shipID: place.shipID, maxActiveProbes: 0, launcher: null, probes: [] },
        notifications: drain(entry),
      };
    }
    // godma.Prime, if the ship has not been loaded for this place yet.
    await shipReadings(entry, place);
    const probes = entry.scanner.activeProbes().slice(0, MAX_PROBES);
    const fitted = entry.dogma.onlineModule(place.shipID, GROUP_SCAN_PROBE_LAUNCHER);
    let launcher = null;
    if (fitted) {
      // Only scan probes count as loaded: a launcher can hold other things.
      const charge = fitted.charge && typeGroup(fitted.charge.typeID) === GROUP_SCANNER_PROBE ? fitted.charge : null;
      const loadedCount = charge ? Math.max(0, Math.trunc(charge.quantity)) : 0;
      launcher = {
        moduleID: fitted.moduleID,
        typeID: fitted.typeID,
        online: true,
        chargeTypeID: charge ? charge.typeID : null,
        loadedCount,
        launchCount: Math.min(loadedCount, Math.max(0, MAX_PROBES - probes.length)),
      };
    }
    return {
      scanner: {
        inSpace: true,
        solarSystemID: place.solarSystemID,
        shipID: place.shipID,
        maxActiveProbes: MAX_PROBES,
        launcher,
        probes: probes.map((probe) => ({
          probeID: probe.probeID,
          typeID: probe.typeID,
          pos: probe.pos,
          destination: probe.destination,
          scanRange: probe.scanRange,
          rangeStep: probe.rangeStep,
          state: probe.state,
          expiry: String(probe.expiry ?? "0"),
        })),
      },
      notifications: drain(entry),
    };
  }

  /**
   * What the client's scan service does to its own list after a call to the
   * scan manager has been answered (scanSvc.py, probeTracker.py):
   *
   *   RequestScans(probes)        the probes it sent are moving (SetProbesAsMoving)
   *   RecoverProbes(probeIDs)     the ones the server answers with are moving
   *   DestroyProbe(probeID)       that probe is gone
   *   SetActivityState(ids, on)   each goes between idle and inactive
   *
   * and, for the two calls the web client makes where the retail client only
   * changes its own list (SetProbeDestination, SetProbeRangeStep), that change.
   */
  /**
   * What the client's dogma location does to its own weapon banks once a
   * grouping call has been answered (clientDogmaLocation.py 763 to 801):
   *
   *   LinkWeapons, MergeModuleGroups, PeelAndLink, LinkAllWeapons   the answer is the ship's banks, anew
   *   UnlinkModule(shipID, moduleID)                                the answer is the slave taken out of that bank
   *   UnlinkAllModules(shipID)                                      no banks
   */
  function afterGroupingCall(entry, method, args, result) {
    if (["LinkWeapons", "MergeModuleGroups", "PeelAndLink", "LinkAllWeapons"].includes(method)) {
      entry.dogma.setWeaponBanks(args[0], result);
    } else if (method === "UnlinkModule") {
      entry.dogma.unlinkModule(args[0], args[1], result);
    } else if (method === "UnlinkAllModules") {
      entry.dogma.setWeaponBanks(args[0], null);
    }
  }

  /**
   * What the client keeps of its own movement orders. Asked to warp to a thing, it notes which
   * (space.WarpDestination(celestialID=...), from the menu and from the autopilot), and words the warp from it
   * if the server's warp then points there. A warp to anything else forgets it.
   */
  function afterMovementCall(entry, method, args, kwargs) {
    // The pilot's last order to its ship, for alreadyFollowing: what was ordered, and after what, at what range.
    if (method.startsWith("Cmd")) entry.lastMove = { method, targetID: positive(args[0]), range: typeof args[1] === "number" ? args[1] : null };
    if (method === "CmdWarpToStuffAutopilot") {
      entry.warpDestination = positive(args[0]);
    } else if (method === "CmdWarpToStuff") {
      entry.warpDestination = args[0] === "item" ? positive(args[1]) : null;
    } else if (method === "CmdAlignTo") {
      // menusvc._AlignTo: what was aligned to is kept (StoreAlignTarget), a thing or a bookmark, and the HUD
      // names it for as long as the ship flies that course. `since` is the park's tick at the order.
      const given = kwargs && typeof kwargs === "object" ? kwargs : {};
      const itemID = positive(given.dstID);
      const bookmark = positive(given.bookmarkID) !== null;
      entry.alignTarget = itemID !== null || bookmark ? { itemID: bookmark ? null : itemID, bookmark, since: parkTick(entry) } : null;
    } else if (method === "CmdGotoDirection") {
      // Steered by hand: the client forgets what it had aligned to (cameraUtil, eveCommands: ClearAlignTargets).
      entry.alignTarget = null;
    }
  }

  /**
   * movementFunctions._IsAlreadyFollowingBallAtRange: the pilot's own ball, in its own ballpark, is already in
   * that mode (following, or orbiting for CmdOrbit), after that ball, at that range. The client's menu then sends
   * no approach, keep at range or orbit. The range is compared as the client compares it, with the float the
   * ballpark holds.
   *
   * Held to one thing more than the client is: the pilot's last order must have been this one, or none. The
   * client goes by its ballpark alone, which has not yet heard of a stop sent a moment ago; it would hold back the
   * approach that was to follow the stop, and leave the ship stopped.
   */
  function alreadyFollowing(bridgeSessionID, sessionFields, method, targetID, range) {
    const entry = held(bridgeSessionID, sessionFields);
    const park = entry.space ? entry.space.park : null;
    const ball = park && park.ego !== null ? park.ballpark.ball(park.ego) : null;
    if (!ball) return false;
    const mode = method === "CmdOrbit" ? BALL_MODE.ORBIT : BALL_MODE.FOLLOW;
    if (ball.mode !== mode || ball.followId !== targetID || ball.followRange !== range) return false;
    const last = entry.lastMove;
    return last === null || (last.method === method && last.targetID === targetID && last.range === range);
  }

  /**
   * michelle.AddBallpark: sm.RemoteSvc('beyonce').GetFormations(), each time a ballpark is made. The client's
   * object cache answers every asking after the first (recorded on Tranquility: "returning a cached result" at
   * each ballpark of a flight through several systems), so the server is asked once. Here the first asking is
   * sent, noted, and kept for the pilot; a ballpark made later, and the BFF's own asking, are answered from it.
   * An asking that fails is not kept.
   */
  function formationsKnown(entry) {
    if (entry.formations === null) {
      ledger.note("beyonce", "GetFormations", shape("beyonce", "GetFormations", [], null, contextFor(entry)));
      const asking = entry.session.call("beyonce", "GetFormations", []);
      entry.formations = asking;
      asking.catch(() => { if (entry.formations === asking) entry.formations = null; });
    }
    return entry.formations;
  }

  /** The tick of the pilot's park, or null when it has none. */
  const parkTick = (entry) => (entry.space && entry.space.park && entry.space.park.validState ? entry.space.park.currentTime : null);

  /**
   * The client forgets what it had aligned to as soon as its ship is seen doing anything but fly that course
   * (spaceMgr.GetHeaderAndSubtextForActionIndication: ClearAlignTargets when the ball is not in GOTO). The
   * order takes a tick or two to come back from the server as the ball's new course, so for that long the
   * ship's old mode is not held against it.
   */
  const ALIGN_GRACE_TICKS = 3;
  function alignTargetOf(entry, park) {
    const kept = entry.alignTarget ?? null;
    if (kept === null) return null;
    const ego = park.ego === null ? null : park.ballpark.ball(park.ego);
    if (ego && ego.mode !== BALL_MODE.GOTO && (kept.since === null || park.currentTime >= kept.since + ALIGN_GRACE_TICKS)) {
      entry.alignTarget = null;
      return null;
    }
    return kept;
  }

  function afterScanManagerCall(entry, method, args, result) {
    const list = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);
    if (method === "RequestScans") {
      const sent = args[0];
      // As it went out: {probeID: probe}, or None for a scan with no probes.
      const probeIDs = sent && sent.type === "dict" && Array.isArray(sent.entries) ? sent.entries.map(([probeID]) => probeID) : [];
      entry.scanner.moving(probeIDs.map(Number).filter(Number.isFinite));
    } else if (method === "RecoverProbes") {
      entry.scanner.moving(list(result).map(Number).filter(Number.isFinite));
    } else if (method === "DestroyProbe") {
      entry.scanner.removed(Number(args[0]));
    } else if (method === "SetActivityState") {
      for (const probeID of list(args[0])) entry.scanner.setActive(Number(probeID), args[1] === true);
    } else if (method === "SetProbeDestination") {
      entry.scanner.setDestination(Number(args[0]), args[1]);
    } else if (method === "SetProbeRangeStep") {
      entry.scanner.setRangeStep(Number(args[0]), Number(args[1]));
    }
  }

  // ── bound objects ─────────────────────────────────────────────────────────

  /** The pilot moved: what was bound for the old place is the old place's. */
  function forgetLocationObjects(entry) {
    entry.inventoryManagers.clear();
    for (const service of [...entry.monikers.keys()]) {
      // The skill handler is the character's, wherever it is: skillsvc keeps its moniker until it forgets everything.
      if (!CORPORATION_SERVICES.has(service) && service !== ALLIANCE_REGISTRY && service !== SKILL_HANDLER) entry.monikers.delete(service);
    }
    for (const [handle, object] of entry.bound) {
      if (LOCATION_SERVICES.has(object.service)) entry.bound.delete(handle);
    }
  }

  /** The server has let one bound object go: whatever names it here is forgotten, as the client forgets the object. */
  function forgetObject(entry, objectID) {
    // An agent's moniker is the client's still, and binds again by its next call: the handles for it are new ones' to ask for.
    for (const [agentID, object] of entry.agents) {
      if (object.objectID === objectID) entry.agents.set(agentID, { ...object, objectID: null });
    }
    for (const [which, held] of entry.inventoryManagers) {
      if (held === objectID) entry.inventoryManagers.delete(which);
    }
    for (const [service, held] of entry.monikers) {
      if (held === objectID) entry.monikers.delete(service);
    }
    for (const [handle, object] of entry.bound) {
      if (object.objectID === objectID) entry.bound.delete(handle);
    }
    if (entry.fleet && entry.fleet.objectID === objectID) outOfFleet(entry);
  }

  /** eveMoniker.GetLocationBindParams: the solar system when the session has one, else the station. */
  function locationBindParams(entry) {
    const solarSystemID = attribute(entry, "solarsystemid");
    if (solarSystemID !== null) return [solarSystemID, GROUP_SOLAR_SYSTEM];
    const stationID = attribute(entry, "stationid");
    if (stationID !== null) return [stationID, GROUP_STATION];
    throw fail("CALL_FAILED", "You have no place to go");
  }

  /**
   * What a service's Moniker is made with (eveMoniker.py), or undefined where the
   * retail client makes none. `given` is what the BFF passed, for the ones that take it.
   */
  function monikerParams(entry, service, given) {
    switch (service) {
      case "ship": // GetShipAccess
      case "invbroker": // GetInventoryMgr
      case "dogmaIM": // CharGetDogmaLocation
      case "crimewatch": // CharGetCrimewatchLocation
        return locationBindParams(entry);
      case "entity": // GetEntityAccess: only with session.solarsystemid
        return attribute(entry, "solarsystemid") === null ? undefined : attribute(entry, "solarsystemid2");
      case "beyonce": // GetBallPark
        return attribute(entry, "solarsystemid") ?? undefined;
      case "planetOrbitalRegistryBroker": // GetPlanetOrbitalRegistry(session.solarsystemid): in space only
        return attribute(entry, "solarsystemid") ?? undefined;
      case OFFICE_MANAGER: // officeManager.station: Moniker('officeManager', session.stationid or session.structureid)
        return attribute(entry, "stationid") ?? attribute(entry, "structureid") ?? undefined;
      case "reprocessingSvc": // GetReprocessingManager
        return attribute(entry, "structureid") ?? attribute(entry, "stationid") ?? undefined;
      case "corpRegistry": // GetCorpRegistry: Moniker('corpRegistry', session.corpid)
        return attribute(entry, "corpid") ?? undefined;
      case "allianceRegistry": // GetAlliance: Moniker('allianceRegistry', (session.allianceid, 1)), the 1 for "is master"
        return [attribute(entry, "allianceid"), 1];
      case "fleetObjectHandler": // GetFleet: Moniker(fleetID or session.fleetid), which is None outside a fleet
        return positive(Array.isArray(given) ? given[0] : given) ?? attribute(entry, "fleetid");
      default: // agentMgr (agentID), planetMgr (planetID), charMgr ((charid, containerGlobal)): as given
        return argumentsToWire(given === undefined ? null : given);
    }
  }

  /**
   * A call on a Moniker the client keeps (moniker.py MonikeredCall, Bind). While the moniker is not bound the
   * call goes with the bind, MachoBindObject(params, (method, args, keywords)), which answers the object and the
   * call's own answer together; after that it goes to the object. A Moniker binds once at a time: a call that
   * finds it binding waits, and is made on the object, or binds for itself if that bind failed. `kept` is where
   * the object is held under `key`, until the pilot is somewhere else or the server lets it go. A moniker the
   * client binds before it uses it is bound with no call, and the call made on what it bound.
   */
  async function keptCall(entry, kept, key, service, paramsOf, method, args, kwargs) {
    const name = `${service}:${key}`;
    while (!kept.has(key) && entry.binding.has(name)) await entry.binding.get(name).catch(() => {});
    if (kept.has(key)) return entry.session.callBound(kept.get(key), method, args, kwargs);
    const carries = !BOUND_BEFORE_USE.has(service);
    const bound = await binds(entry, kept, key, name, service, paramsOf(), carries ? [method, args, kwargs] : null);
    return carries ? bound.result : entry.session.callBound(bound.objectID, method, args, kwargs);
  }

  /** A moniker's bind, with the call it carries or none: known as binding while it is, and its object kept when it answers. */
  async function binds(entry, kept, key, name, service, params, call) {
    const binding = entry.session.bind(service, params, call);
    entry.binding.set(name, binding);
    try {
      const bound = await binding;
      kept.set(key, bound.objectID);
      return bound;
    } finally {
      entry.binding.delete(name);
    }
  }

  /**
   * all_cso.GetMoniker, as the session's alliance changes: the new alliance's moniker made and bound for its own
   * sake (Bind()). Nothing is sent for a session with no alliance: the client cannot make the moniker.
   */
  async function allianceBound(entry) {
    if (attribute(entry, "allianceid") === null) return;
    await binds(entry, entry.monikers, ALLIANCE_REGISTRY, `${ALLIANCE_REGISTRY}:${ALLIANCE_REGISTRY}`, ALLIANCE_REGISTRY, monikerParams(entry, ALLIANCE_REGISTRY, undefined), null);
  }

  /**
   * skillsvc.GetSkillHandler: the client asks skillMgr2 for its skill handler once and keeps the Moniker that
   * answers. The moniker says what it is bound by: its service, its parameters, and its node where the server
   * names one, which is then known without asking (moniker.py __setstate__). Asked for again after an answer
   * that was no moniker, or none.
   */
  function skillHandlerMoniker(entry) {
    if (!entry.skillHandler) {
      const asked = (async () => {
        ledger.note("skillMgr2", "GetMySkillHandler", shape("skillMgr2", "GetMySkillHandler", [], null, contextFor(entry)));
        const moniker = monikerOf(await entry.session.call("skillMgr2", "GetMySkillHandler", [], null));
        if (!moniker) throw fail("CALL_FAILED", "skillMgr2.GetMySkillHandler did not answer a skill handler.");
        if (moniker.nodeID !== null) entry.session.setNodeOfAddress(moniker.service, moniker.params, moniker.nodeID);
        return moniker;
      })();
      entry.skillHandler = asked;
      asked.catch(() => { if (entry.skillHandler === asked) entry.skillHandler = null; });
    }
    return entry.skillHandler;
  }

  /**
   * A call on a moniker the client keeps: for where the pilot is (eveMoniker.py: GetShipAccess for `ship`,
   * CharGetDogmaLocation for `dogmaIM`), for its corporation, or its skill handler.
   */
  async function monikerCall(entry, service, method, args, kwargs = null) {
    if (madeAfresh(service, method, { dockedInStation: attribute(entry, "stationid") !== null })) {
      // A Moniker the client makes for the one call: it binds carrying the call, and is not kept.
      return (await entry.session.bind(service, monikerParams(entry, service, undefined), [method, args, kwargs])).result;
    }
    // crimewatchSvc.GetCorpAggressionSettings: the settings as they are kept, asked for where none are.
    if (service === CORP_REGISTRY && method === AGGRESSION_SETTINGS) return corporationDoes(entry, () => entry.aggression ?? aggressionRefreshed(entry));
    if (service !== SKILL_HANDLER) {
      return keptCall(entry, entry.monikers, service, service, () => monikerParams(entry, service, undefined), method, args, kwargs);
    }
    // What the client's skill services keep is theirs to answer. Anything else of the handler's is asked of it.
    if (Object.hasOwn(SKILL_KEPT, method)) return skillsDoes(entry, () => skillRead(entry, method, args));
    if (isSkillQueueRead(method, args, kwargs)) return skillsDoes(entry, () => skillQueueRead(entry));
    // skillQueueSvc.CommitTransaction: the save, with what the client's queue service and panel do around it.
    if (method === "SaveNewQueue") return skillsDoes(entry, () => saveOnHandler(entry, args, kwargs));
    // skillsvc.ApplyFreeSkillPoints: the points applied, with what the client's skill service does around it.
    if (method === "ApplyFreeSkillPoints") return skillsDoes(entry, () => freePointsApplied(entry, args, kwargs));
    return onSkillHandler(entry, method, args, kwargs);
  }

  /**
   * ApplyFreeSkillPoints on the handler, as the client's skill service makes it (skillsvc.py 867 to 888): the
   * free points are had first, asked for where none are kept (868); and what the handler answers is the free
   * points left, which the service has from then on (887). `args` and `kwargs` are the call's own.
   */
  async function freePointsApplied(entry, args, kwargs) {
    await skillRead(entry, "GetFreeSkillPoints", []);
    const left = await onSkillHandler(entry, "ApplyFreeSkillPoints", args, kwargs);
    entry.skills.keep("freeSkillPoints", left);
    return left;
  }

  // ── the skills as they are kept ───────────────────────────────────────────

  /** A call on the skill handler: on the moniker skillMgr2 answered, bound by the first call made on it and kept. */
  async function onSkillHandler(entry, method, args = [], kwargs = null) {
    const moniker = await skillHandlerMoniker(entry);
    return keptCall(entry, entry.monikers, SKILL_HANDLER, moniker.service, () => moniker.params, method, args, kwargs);
  }

  /** One of the skill services' own askings of the handler: noted as it is sent, and what answers kept where the services keep it. */
  async function skillAsk(entry, method, args = []) {
    // With no handler to ask there is no call, and none is noted.
    await skillHandlerMoniker(entry);
    ledger.note(SKILL_HANDLER, method, SKILL_OWN[method] ?? shape(SKILL_HANDLER, method, args, null, contextFor(entry)));
    const answer = await onSkillHandler(entry, method, args);
    if (Object.hasOwn(SKILL_KEPT, method)) entry.skills.keep(SKILL_KEPT[method], answer);
    else if (method === "GetSkillQueueAndFreePoints") entry.skills.keep("queue", answer);
    return answer;
  }

  /**
   * What the client's skill services keep of one of the handler's reads, asked for where none is kept. The
   * attributes are asked for behind the boosters and the implants, each asked again whatever is kept
   * (skillsvc.GetCharacterAttributes). The history is asked for by how many its asker wants (retailCalls.js); the
   * others with nothing, whatever the asker passed. What answers is handed on as it came, kept or not.
   */
  async function skillRead(entry, method, args) {
    const name = SKILL_KEPT[method];
    if (entry.skills.has(name)) return entry.skills.read(name);
    if (name === "attributes") {
      await skillAsk(entry, "GetBoosters");
      await skillAsk(entry, "GetImplants");
    }
    return skillAsk(entry, method, name === "history" ? args : []);
  }

  /**
   * The queue service's read, asked for by name: the queue as it is kept and the free points as they are kept, in
   * the form the handler answers in. Asked of the handler where no queue is kept (PrimeSkillQueue), and what it
   * answers then handed on as it came.
   */
  async function skillQueueRead(entry) {
    if (!entry.skills.has("queue")) return skillAsk(entry, SKILL_QUEUE_READ);
    return [entry.skills.read("queue"), entry.skills.read("freeSkillPoints") ?? 0];
  }

  /** The skill services' askings one after another, so that what one keeps the next finds kept. Fails as `work` fails, for whoever waits on it; nobody need. */
  function skillsDoes(entry, work) {
    const doing = entry.skillsWork.then(work);
    entry.skillsWork = doing.catch(() => {});
    return doing;
  }

  /**
   * What the client asks of its skill handler when a character is chosen (SKILL_LOGIN_READS). Never fails: at the
   * first that cannot be read the rest are left, and each is asked for when it is next wanted.
   */
  function primeSkills(entry) {
    return skillsDoes(entry, async () => {
      for (const [method, args] of SKILL_LOGIN_READS) await skillAsk(entry, method, args);
    }).catch(() => {});
  }

  /**
   * The server's clock as this pilot's session has it (session.js serverNow), in whole milliseconds. It is what the
   * pilot's own client would read off its clock: the session's connection keeps it set.
   */
  function serverNowMs(sessionFields = {}, bridgeSessionID = undefined) {
    return Math.trunc(held(bridgeSessionID, sessionFields).session.serverNow());
  }

  /**
   * The Skills window's sheet, made from what the client's skill services keep (skillSheet.js), in the form the
   * web gateway's sheet is in. What is not kept is asked for as the client's windows would ask: the two lists,
   * the queue and the free points (skillsvc.GetFreeSkillPoints), and, where a skill is in training, the
   * character's attributes, which its points so far are reckoned from (skillQueueSvc.GetEstimatedSkillPointsTrained
   * reads skillsvc.GetCharacterAttributes: the boosters, the implants and the attributes).
   */
  async function skillSheet(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    return run(entry, SKILL_HANDLER, "GetSkills", () => skillsDoes(entry, async () => {
      const skills = await skillRead(entry, "GetSkills", []);
      const allSkills = await skillRead(entry, "GetAllSkills", []);
      // skillQueueSvc.PrimeSkillQueue, where the choosing's own asking of it could not be made.
      if (!entry.skills.has("queue")) await skillAsk(entry, "GetSkillQueueAndFreePoints");
      const freeSkillPoints = await skillRead(entry, "GetFreeSkillPoints", []);
      const attributes = entry.skills.inTraining() === null ? entry.skills.read("attributes") ?? null : await skillRead(entry, "GetAttributes", []);
      return buildSkillSheet({
        characterID: entry.characterID,
        characterName: entry.characterName,
        skills,
        allSkills,
        queue: entry.skills.read("queue"),
        freeSkillPoints,
        attributes,
        now: () => entry.session.serverNow(),
        typeName: (typeID) => typeNames(typeID)?.name,
        typeGroupName: (typeID) => typeNames(typeID)?.groupName,
        typeAttribute,
      });
    }));
  }

  /**
   * A queue saved as the client's queue panel saves one (skillQueuePanelNew.ApplySkillQueue, activate=True).
   * `entries` is the whole queue wanted, each [typeID, toLevel], in order.
   *
   *   skillQueueSvc.TrimQueue          each entry's training time is reckoned first, which reads the character's
   *                                    attributes where they are not kept; an empty queue has nothing to reckon
   *   skillQueueSvc.CommitTransaction  SaveNewQueue({position: (typeID, toLevel)}, activate=True), on the handler
   *   ApplySkillQueue's finally        a new transaction, which asks for the queue afresh
   *                                    (GetSkillQueueAndFreePoints): after a refusal too, but for two refusals
   *
   * Recorded on Tranquility as those two calls one after the other (Archive/Apply Skill Points Flow). The queue
   * kept is right from the server's own notice of the save, and then from the asking. Not done, which the client
   * does: the queue cut where it would train for longer than a queue may (TrimQueue), an alpha clone's levels
   * refused before anything is sent, and the save made again unstarted where the server refuses an alpha's queue
   * for its size.
   *
   * The same save asked for by the handler's name (the page's own, the plan's Phase 6b) is made the same way:
   * monikerCall hands it to saveOnHandler, which is the three steps above.
   */
  async function saveSkillQueue(entries, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    return run(entry, SKILL_HANDLER, "SaveNewQueue", () => skillsDoes(entry, async () => {
      const queueInfo = { type: "dict", entries: entries.map(([typeID, toLevel], position) => [position, [typeID, toLevel]]) };
      const result = await saveOnHandler(entry, [queueInfo], { activate: true }, () => ledger.note(SKILL_HANDLER, "SaveNewQueue", SKILL_OWN.SaveNewQueue));
      return { service: SKILL_HANDLER, method: "SaveNewQueue", result: wireToBridgeJson(result === undefined ? null : result), notifications: drain(entry) };
    }));
  }

  /**
   * SaveNewQueue on the handler, with what the client's queue service and its panel do before and after it.
   * `args` and `kwargs` are the save's own, as they go on the wire: the queue by place, and `activate`.
   * The attributes are read only for a save that says it starts the queue, of a queue with something on it: an
   * unstarted queue is not trimmed (CommitTransaction 149), an empty one has nothing to reckon, and a save that
   * does not say is not the client's. `sent` is called once there is a handler to save on, before the save goes.
   */
  async function saveOnHandler(entry, args, kwargs, sent = () => {}) {
    const queued = Array.isArray(args[0]?.entries) ? args[0].entries.length : 0;
    if (queued > 0 && kwargs?.activate === true) await skillRead(entry, "GetAttributes", []);
    await skillHandlerMoniker(entry);
    sent();
    let asksAgain = true;
    try {
      return await onSkillHandler(entry, "SaveNewQueue", args, kwargs);
    } catch (error) {
      asksAgain = !NO_NEW_QUEUE_TRANSACTION.has(String(error && error.refusal && error.refusal.key));
      throw error;
    } finally {
      if (asksAgain) await skillAsk(entry, "GetSkillQueueAndFreePoints").catch(() => {});
    }
  }

  /** What the client's skill service does after a notice that only the transport can do (pilotSkills.js feed). */
  function afterSkillNotice(entry, next) {
    for (const what of next) {
      if (what === "reset") {
        // skillsvc.Reset: self.skillHandler = None. Its next call asks skillMgr2 for the handler again, and binds it again.
        entry.skillHandler = null;
        entry.monikers.delete(SKILL_HANDLER);
      } else {
        // skillsvc.GetCharacterAttributes(True): the boosters, the implants and the attributes, read again at once.
        skillsDoes(entry, async () => {
          for (const method of ["GetBoosters", "GetImplants", "GetAttributes"]) await skillAsk(entry, method);
        });
      }
    }
  }

  /**
   * shipmodulebutton.GetDefaultEffect, as far as the static data here can say
   * it: the one effect of a type that a pilot switches on (an activation or a
   * target effect, and not `online`), by name. Null when the type has none, or
   * more than one: the client tells those apart by a flag this data lacks.
   */
  function defaultEffectName(typeID) {
    if (typeID === null) return null;
    const found = typeEffects(typeID).filter((effect) => effect.effectID !== EFFECT_ONLINE &&
      (effect.effectCategoryID === EFFECT_CATEGORY.ACTIVATION || effect.effectCategoryID === EFFECT_CATEGORY.TARGET));
    return found.length === 1 ? found[0].name : null;
  }

  /** shipmodulebutton.IsEffectRepeatable: the effect has a duration and the module does not forbid repeating. Null when the effect is not one of the type's. */
  function effectRepeats(typeID, effectName) {
    if (typeID === null) return null;
    const effect = typeEffects(typeID).find((each) => each.name === effectName);
    if (!effect) return null;
    return effect.durationAttributeID !== null && effect.durationAttributeID !== undefined && !typeAttribute(typeID, ATTRIBUTE_DISALLOW_REPEATING);
  }

  /** shipmodulebutton.ActivateEffect (1318): the effect is one aimed at a target (effectCategory 2). Null when the effect is not one of the type's. */
  function effectTargeted(typeID, effectName) {
    if (typeID === null) return null;
    const effect = typeEffects(typeID).find((each) => each.name === effectName);
    return effect ? effect.effectCategoryID === EFFECT_CATEGORY.TARGET : null;
  }

  /**
   * An item's stack size as the client's inventory cache would have it (item.stacksize), from the item's row in a
   * listing the pilot holds (INVENTORY_LISTINGS): the row's own stack size where the codec gives one, else its
   * quantity, and 1 for a thing that is one of a kind, whose quantity is below nothing. Null for an item no
   * listing held has, and for a row that says neither.
   */
  function stackSizeOf(entry, itemID) {
    const wanted = positive(itemID);
    if (wanted === null) return null;
    for (const listing of entry.listings.answers()) {
      for (const row of itemsOf(listing)) {
        const fields = rowFields(row);
        if (fields === null || positive(fields.itemID) !== wanted) continue;
        const [size, quantity] = [fields.stacksize, fields.quantity].map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
        return size !== null ? size : quantity === null ? null : quantity < 0 ? 1 : quantity;
      }
    }
    return null;
  }

  /** What only the pilot's own client would know, for a call to be sent as that client sends it (retailCalls.js). */
  function contextFor(entry) {
    const typeOf = (itemID) => entry.dogma.typeOf(positive(itemID) ?? 0);
    return {
      shipID: attribute(entry, "shipid"),
      characterID: entry.characterID,
      corporationID: attribute(entry, "corpid"),
      allianceID: attribute(entry, "allianceid"),
      // session.solarsystemid: the system the pilot is in space in, and none while docked.
      solarSystemID: attribute(entry, "solarsystemid"),
      // session.stationid or session.structureid: where the pilot is docked, and none in space.
      dockedAt: attribute(entry, "stationid") ?? attribute(entry, "structureid"),
      onlineModules: () => {
        const shipID = attribute(entry, "shipid");
        return entry.dogmaLoaded && shipID !== null ? entry.dogma.onlineModules(shipID) : null;
      },
      // invCache: the item as a listing has it.
      stackSize: (itemID) => stackSizeOf(entry, itemID),
      // marketQuote.GetMyOrders: one of the pilot's own orders, as its row has it.
      ownOrder: (orderID) => ownOrderOf(entry, orderID),
      // marketQuote.GetBrokersFeeCommissionFromStationID: the rate the client names with an order there.
      brokersFee: (stationID) => brokersFeeAt(entry, stationID),
      // marketQuote.GetAveragePrice, as the entries of the sale being made have it (saleAveragesRead).
      averagePrice: (typeID) => entry.saleAverages.get(positive(typeID)) ?? null,
      effectName: (itemID) => defaultEffectName(typeOf(itemID)),
      effectTargeted: (itemID, effectName) => effectTargeted(typeOf(itemID), effectName),
      effectRepeats: (itemID, effectName) => effectRepeats(typeOf(itemID), effectName),
      // fleetSvc.GetMyShipTypeID: godma's word for the ship the pilot is in.
      shipTypeID: () => typeOf(attribute(entry, "shipid")),
      fleetID: attribute(entry, "fleetid"),
      holdsFleet: entry.fleet !== null,
      // fleetSvc.IsBoss and self.options, as the fleet is kept (pilotFleet.js).
      fleetBoss: entry.fleetKept.isBoss(),
      fleetOptions: () => entry.fleetKept.options(),
    };
  }

  /**
   * A call on invCache's `inventorymgr` (where the pilot is) or `stationInventoryMgr` (its station): each a Moniker it
   * keeps. The station's is only asked of a pilot docked in one, for whom the two are bound by the same parameters.
   */
  const inventoryCall = (entry, which, method, args) =>
    keptCall(entry, entry.inventoryManagers, which, "invbroker", () => locationBindParams(entry), method, args, null);

  /**
   * Make the bind the BFF asked the gateway for, as the retail client makes
   * it. Answers the bound object's "N=...", or null when the server handed
   * none back.
   */
  async function bindRetail(entry, service, method, args, kwargs) {
    const { session } = entry;
    if (method === "MachoBindObject") {
      // michelle.GetRemotePark(): the park's own bound ballpark, the one object everything is asked of. Any other
      // moniker is made by bindObject and binds when it is first called.
      return entry.space.remote();
    }
    if (service === "invbroker" && method === "GetInventory") {
      // invCache.GetInventory(const.containerHangar): the station's hangar from
      // the station's manager, or the structure's from the location's.
      const asked = positive(args[0]);
      const structureID = attribute(entry, "structureid");
      if (asked !== (structureID ?? attribute(entry, "stationid"))) {
        throw fail("CALL_REFUSED", "The pilot is not docked there.");
      }
      return boundObjectID(await inventoryCall(entry, structureID === null ? "station" : "location", "GetInventory", [structureID === null ? CONTAINER_HANGAR : CONTAINER_STRUCTURE, null]));
    }
    if (service === "invbroker" && method === "GetInventoryFromId") {
      // invCache.GetInventoryFromId(itemid, passive=0): both positional.
      const passive = kwargs && kwargs.passive !== undefined ? kwargs.passive : args[1] ?? 0;
      return boundObjectID(await inventoryCall(entry, "location", "GetInventoryFromId", [argumentsToWire(args[0]), passive]));
    }
    // A service's own method that answers with a bound object:
    // sm.RemoteSvc('scanMgr').GetSystemScanMgr(), sm.RemoteSvc('fleetObjectHandler').CreateFleet().
    return boundObjectID(await session.call(service, method, argumentsToWire(args), kwargs ?? null));
  }

  /** idCheckers.IsNPC(session.corpid): whether the pilot's corporation is an NPC one. */
  function inNpcCorporation(entry) {
    const corporationID = attribute(entry, "corpid");
    return corporationID > MAX_SYSTEM_ITEM && corporationID < MIN_PLAYER_OWNER;
  }

  // ── the standings as they are kept ────────────────────────────────────────

  /**
   * standingsvc.__RefreshStandings: the NPCs' standings with each other, then the character's, and beside the
   * character's its corporation's where that is not an NPC corporation, whose standings are none
   * (idCheckers.IsNPC(session.corpid)). What is answered is kept; what cannot be read leaves what was kept as it
   * was. Never fails.
   */
  function refreshStandings(entry) {
    const ask = (method) => {
      ledger.note("standingMgr", method, method === "GetNPCNPCStandings" ? NPC_STANDINGS_AS_THE_CLIENT_ASKS : shape("standingMgr", method, [], null, contextFor(entry)));
      return entry.session.call("standingMgr", method, [], null);
    };
    entry.standingsWork = (async () => {
      const npcNpc = await ask("GetNPCNPCStandings");
      const [char, corp] = inNpcCorporation(entry) ? [await ask("GetCharStandings")] : await Promise.all([ask("GetCharStandings"), ask("GetCorpStandings")]);
      entry.standings.refreshed({ npcNpc, char, corp });
    })().catch(() => {});
    return entry.standingsWork;
  }

  /**
   * The pilot's standings as the client's standing service has them kept: the character's and its corporation's,
   * each as the server answered it when the character was chosen, kept right since by the server's notices, in
   * the gateway's form. The corporation's is null where none is kept (an NPC corporation's are none). Null where
   * the character's could not be read: then nothing is kept.
   */
  async function standingsKept(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    await entry.standingsWork;
    if (!entry.standings.loaded) return null;
    return { char: wireToBridgeJson(entry.standings.char()), corp: wireToBridgeJson(entry.standings.corp()) };
  }

  // ── the fleet's own object, and the fleet as it is kept ───────────────────

  /** No fleet's object is held, and nothing of a fleet is kept (fleetSvc.Clear, and a session in no fleet). */
  function outOfFleet(entry) {
    entry.fleet = null;
    entry.fleetKept.clear();
  }

  /** One call the client makes of its own accord on the fleet's object, in the client's form and in the ledger. */
  function ownFleetCall(entry, object, method, args = []) {
    ledger.note("fleetObjectHandler", method, FLEET_OWN[method] ?? shape("fleetObjectHandler", method, args, null, contextFor(entry)));
    return entry.session.callBound(object.objectID, method, args, null);
  }

  /** fleetSvc.InitFleet: the fleet's state asked of its object, and kept where that is the fleet's object still. */
  async function initFleet(entry, object) {
    const state = await ownFleetCall(entry, object, "GetInitState");
    if (entry.fleet === object) entry.fleetKept.init(state);
  }

  /**
   * Something the client's fleet service does of its own accord. Each is a tasklet of its own in the client, so
   * none waits for another (the same call made twice at once is one call: session.js). What cannot be done is
   * left undone, as an error in the client's handler leaves it. Answers when this one is over; entry.fleetWork
   * is over when all of them are.
   */
  function fleetDoes(entry, work) {
    const doing = work().catch(() => {});
    entry.fleetWork = Promise.all([entry.fleetWork, doing]);
    return doing;
  }

  /** What the client does after a notice about its fleet (pilotFleet.js feed): each of `next`, in order. */
  function afterFleetNotice(entry, next) {
    for (const what of next) {
      const object = entry.fleet;
      if (what === "left") {
        entry.fleet = null;
      } else if (object && what === "init") {
        // OnFleetJoin, the pilot's own: InitFleet.
        fleetDoes(entry, () => initFleet(entry, object));
      } else if (object && what === "move") {
        // OnFleetMove: self.fleet.FinishMove(), by which the session's wing and squad change.
        fleetDoes(entry, () => ownFleetCall(entry, object, "FinishMove"));
      } else if (object) {
        // A wing or squad's notice: self.wings = self.fleet.GetWings().
        fleetDoes(entry, async () => {
          const wings = await ownFleetCall(entry, object, "GetWings");
          if (entry.fleet === object) entry.fleetKept.setWings(wings);
        });
      }
    }
  }

  /**
   * fleetSvc keeps one object for the pilot's fleet, self.fleet, and reads the fleet's state from it as soon as
   * it has it. CreateFleet (331): after Init, InitFleet and then self.fleet.GetFleetID(). OnFleetInvite (1194):
   * the Moniker that accepted is the object from then on, and InitFleet. LeaveFleet (365): once it has answered
   * there is no object and nothing kept (self.Clear()). CreateWing (575): a wing that was made is given a squad at
   * once, CreateSquad(wingID). `result` is what the call answered.
   */
  function afterFleetCall(entry, object, method, result) {
    if (method === "AcceptInvite") {
      entry.fleet = object;
      return fleetDoes(entry, () => initFleet(entry, object));
    }
    if (entry.fleet !== object) return null;
    if (method === "LeaveFleet") outOfFleet(entry);
    if (method === "CreateWing" && positive(result) !== null) return fleetDoes(entry, () => ownFleetCall(entry, object, "CreateSquad", [result]));
    if (method !== "Init") return null;
    return fleetDoes(entry, async () => {
      await initFleet(entry, object);
      await ownFleetCall(entry, object, "GetFleetID");
    });
  }

  /**
   * The fleet as the client's fleet service has it kept, for a pilot whose fleet's object is held: its state as
   * GetInitState answered it when the pilot formed or joined the fleet, kept right since by the server's notices;
   * its wings; its message of the day, asked for only where the server has said none (fleetSvc.GetMotd). And what
   * the two windows the client's main one offers to some would show, for a pilot who would have them
   * (fleetwindow.py): the join requests, the boss's, asked for where none is kept the first time they are shown
   * for a fleet; and the composition, a commander's or the boss's, asked for again when the kept one is twenty
   * seconds old or the pilot's own record has changed (fleetSvc.GetFleetComposition). Anyone else is asked for
   * neither, and has none. Each in the gateway's form, under the name of the read it stands for. Null where no
   * object is held or no state could be read: then nothing is kept, as the client keeps nothing.
   */
  async function fleetKept(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    // What the client is asking of its own accord comes first.
    await entry.fleetWork;
    // A state that could not be read when the client read it is read now: the BFF's own doing, for the page's sake.
    const object = entry.fleet;
    if (object && !entry.fleetKept.inited) await fleetDoes(entry, () => initFleet(entry, object));
    if (!entry.fleetKept.inited) return null;
    if (entry.fleetKept.motd() === null) {
      await fleetDoes(entry, async () => entry.fleetKept.setMotd(await ownFleetCall(entry, object, "GetMotd")));
    }
    if (entry.fleetKept.isBoss() && entry.fleetKept.openJoinRequests()) {
      await fleetDoes(entry, async () => {
        const requests = await ownFleetCall(entry, object, "GetJoinRequests");
        if (entry.fleet === object) entry.fleetKept.setJoinRequests(requests);
      });
    }
    const commands = () => entry.fleetKept.isBoss() || FLEET_COMMANDER_ROLES.has(attribute(entry, "fleetrole"));
    if (commands() && entry.fleetKept.compositionDue(now())) {
      await fleetDoes(entry, async () => {
        const composition = await ownFleetCall(entry, object, "GetFleetComposition");
        if (entry.fleet === object) entry.fleetKept.setComposition(composition, now());
      });
    }
    // Out of the fleet meanwhile, there is nothing kept.
    if (!entry.fleetKept.inited) return null;
    return {
      GetInitState: wireToBridgeJson(entry.fleetKept.read()),
      GetWings: wireToBridgeJson(entry.fleetKept.wings()),
      GetMotd: wireToBridgeJson(entry.fleetKept.motd()),
      GetJoinRequests: wireToBridgeJson(entry.fleetKept.isBoss() ? entry.fleetKept.joinRequests() : { type: "dict", entries: [] }),
      GetFleetComposition: wireToBridgeJson(commands() ? entry.fleetKept.composition() : null),
      notifications: drain(entry),
    };
  }

  /**
   * A call on a moniker the BFF asked for. As the client's own Moniker (moniker.py), it binds when it is first
   * called, carrying that call, and the calls after go to the object it bound; and where the client makes a new
   * Moniker for a call, one is made here for it and not kept.
   */
  function handleCall(entry, handle, object, method, args, kwargs) {
    if (madeAfresh(object.service, method, { dockedInStation: attribute(entry, "stationid") !== null })) {
      return entry.session.bind(object.service, object.params, [method, args, kwargs]).then((bound) => bound.result);
    }
    const kept = { has: () => object.objectID !== null, get: () => object.objectID, set: (key, objectID) => { object.objectID = objectID; } };
    // An object several handles name is bound once: its own name, where it has one, is what its binding is known by.
    return keptCall(entry, kept, object.key ?? handle, object.service, () => object.params, method, args, kwargs);
  }

  // ── the corporation's registry, as the client's services ask and keep it ──

  /** One of the client's own askings of the corporation's registry: noted as it is sent, with nothing, on the corporation's moniker. */
  function corporationAsk(entry, method) {
    ledger.note(CORP_REGISTRY, method, shape(CORP_REGISTRY, method, [], null, contextFor(entry)));
    return keptCall(entry, entry.monikers, CORP_REGISTRY, CORP_REGISTRY, () => monikerParams(entry, CORP_REGISTRY, undefined), method, [], null);
  }

  /** crimewatchSvc.RefreshCorpAggressionSettings: the settings asked for, and kept as answered. */
  async function aggressionRefreshed(entry) {
    entry.aggression = await corporationAsk(entry, AGGRESSION_SETTINGS);
    return entry.aggression;
  }

  /** What asks for the settings or reads them kept, one after another, so that what one keeps the next finds kept. Fails as `work` fails, for whoever waits on it. */
  function corporationDoes(entry, work) {
    const doing = entry.corpWork.then(work);
    entry.corpWork = doing.catch(() => {});
    return doing;
  }

  /**
   * What the client's services ask of the corporation's registry when the session's corporation changes, the
   * choosing of a character among them: its aggression settings (crimewatchSvc.ProcessSessionChange), which
   * are kept, and its members' names (bco_members.OnSessionChanged, which primes the client's names with them
   * and keeps nothing else). Each fails for itself.
   *
   * A character chosen is asked besides for its own applications, as the client asks for them once
   * (bco_applications), after the address book's reads as a recorded login has them. They are not kept here,
   * though the client keeps them and works its list over at each OnCorporationApplicationChanged: the BFF's own
   * flows read one pilot's applications straight after another pilot's change to them, on another connection,
   * where a kept list could be a notice behind.
   */
  function corporationRead(entry) {
    return corporationDoes(entry, async () => {
      await aggressionRefreshed(entry).catch(() => {});
      await corporationAsk(entry, "GetEveOwners").catch(() => {});
    });
  }

  /**
   * addressbook.GetContacts, as a character is chosen (OnCharacterSessionChanged). The client asks these side by
   * side, and Tranquility's recording of a login has them in this order: the pilot's contacts and blocked owners
   * (charMgr.GetContactList), its corporation's contacts where the corporation is not an NPC one
   * (corp.GetContactList, which is GetCorpRegistry().GetCorporateContacts()), and who of its watched contacts is
   * online (onlineStatus.Prime, which is GetInitialState). Each fails for itself.
   *
   * A pilot in an alliance is asked for the alliance's contacts beside these, between the corporation's and the
   * online state (alliance.GetContactList, which is GetMoniker().GetAllianceContacts(), the moniker made and bound
   * for it). No recording has an alliance: the place is the address book's own order.
   *
   * Nothing is kept of them, though the client keeps them all and works them over at the server's notices: no
   * window of the page reads a contact yet.
   */
  async function addressBookRead(entry) {
    const ofTheAlliance = (method) => {
      ledger.note(ALLIANCE_REGISTRY, method, shape(ALLIANCE_REGISTRY, method, [], null, contextFor(entry)));
      return keptCall(entry, entry.monikers, ALLIANCE_REGISTRY, ALLIANCE_REGISTRY, () => monikerParams(entry, ALLIANCE_REGISTRY, undefined), method, [], null);
    };
    await Promise.all([
      asks(entry, "charMgr", "GetContactList"),
      ...(inNpcCorporation(entry) ? [] : [corporationAsk(entry, "GetCorporateContacts")]),
      ...(attribute(entry, "allianceid") === null ? [] : [ofTheAlliance("GetAllianceContacts")]),
      asks(entry, "onlineStatus", "GetInitialState"),
    ].map((asked) => asked.catch(() => {})));
  }

  /** crimewatchSvc.OnCorpAggressionSettingsChange(aggressionSettings): the settings are what the server says. */
  function afterCorporationNotice(entry, notification) {
    if (notification.method === "OnCorpAggressionSettingsChange") entry.aggression = Array.isArray(notification.args) ? notification.args[0] : null;
  }

  // ── the agents' table, and the agents' journal as it is kept ──────────────

  /**
   * agents.__GetAllAgents, for one pilot: RemoteSvc('agentMgr').GetAgents(), asked once and not again while what
   * answered is had. Asked again where the asking failed. What answers is the one table kept for all pilots.
   */
  function agentsKnown(entry) {
    if (!entry.agentsAsked) {
      const asked = (async () => {
        ledger.note("agentMgr", "GetAgents", shape("agentMgr", "GetAgents", [], null, contextFor(entry)));
        agentsTable = wireToBridgeJson(await entry.session.call("agentMgr", "GetAgents", [], null));
      })();
      entry.agentsAsked = asked;
      asked.catch(() => { entry.agentsAsked = null; });
    }
    return entry.agentsAsked;
  }

  /** agents.GetAgentMoniker: the one Moniker('agentMgr', agentID) the client keeps for an agent, made when first wanted. */
  function agentObject(entry, agentID) {
    if (!entry.agents.has(agentID)) entry.agents.set(agentID, { objectID: null, service: "agentMgr", params: agentID, key: `agent:${agentID}` });
    return entry.agents.get(agentID);
  }

  /**
   * journal._CheckUpdateMissionData, one reading at a time as under the service's semaphore. With no journal kept
   * the whole of it is asked for by name. With one kept and agents marked, each marked agent is asked for its own
   * part on its own moniker, all at once, and the parts are put into what is kept (pilotJournal.js). Fails as the
   * asking fails, for whoever waits on it: the agents marked are then marked no longer, and what was kept is as it
   * was, as in the client.
   */
  function journalUpToDate(entry) {
    const reading = entry.journalWork.then(async () => {
      if (!entry.journal.kept) {
        ledger.note("agentMgr", "GetMyJournalDetails", shape("agentMgr", "GetMyJournalDetails", [], null, contextFor(entry)));
        entry.journal.full(await entry.session.call("agentMgr", "GetMyJournalDetails", [], null));
        return;
      }
      const agentIDs = entry.journal.takeOutdated();
      const answers = await Promise.all(agentIDs.map((agentID) => {
        ledger.note("agentMgr", "GetMyJournalDetails", AGENTS_OWN_JOURNAL);
        const object = agentObject(entry, agentID);
        return handleCall(entry, object.key, object, "GetMyJournalDetails", [], null);
      }));
      entry.journal.partial(agentIDs, answers);
    });
    entry.journalWork = reading.catch(() => {});
    return reading;
  }

  /**
   * The pilot's agents' journal as the client's journal service has it: read when the character was chosen, and
   * after a mission's change made right by its agent's own answer. In the gateway's form. Null where what the
   * server answered was no journal: then nothing is kept.
   */
  async function journalKept(sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    await run(entry, "agentMgr", "GetMyJournalDetails", () => journalUpToDate(entry));
    const journal = entry.journal.read();
    return journal ? wireToBridgeJson(journal) : null;
  }

  async function bindObject(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    assertAllowed(service, method);
    ledger.note(service, method, BOUND_AS_THE_CLIENT_BINDS);
    if (method === "MachoBindObject" && !(service === "beyonce" && entry.space)) {
      // A Moniker: what it is bound by is settled now, from what the client's own carries (eveMoniker.py), and
      // nothing is sent until it is called.
      const given = Array.isArray(args) ? args[0] : undefined;
      // The pilot's own fleet (none named, or the session's named) is asked of the one object fleetSvc keeps for
      // it, where it is held: no Moniker is made.
      const named = positive(Array.isArray(given) ? given[0] : given);
      const fleets = service === "fleetObjectHandler" && (named === null || named === attribute(entry, "fleetid")) ? entry.fleet : null;
      // An agent is asked on the one object the client's agents service keeps for it, whoever asks.
      const own = fleets ?? (service === "agentMgr" && named !== null ? agentObject(entry, named) : null);
      const params = monikerParams(entry, service, given);
      if (params === undefined) throw fail("BOUND_NO_OBJECT", `${service}.${method} did not return a bound object.`);
      const made = randomBytes(24).toString("base64url");
      entry.bound.set(made, own ?? { objectID: null, service, params });
      return { boundHandle: made, service, method, notifications: drain(entry) };
    }
    let objectID;
    try {
      objectID = await run(entry, service, method, async () => bindRetail(entry, service, method, Array.isArray(args) ? args : [], kwargs));
    } catch (error) {
      // The session's own word for a bind the server answered without an object.
      if (error.code === "CALL_FAILED" && / did not return a bound object\.| could not say where its object lives\./.test(error.message)) objectID = null;
      else throw error;
    }
    if (!objectID) throw fail("BOUND_NO_OBJECT", `${service}.${method} did not return a bound object.`);
    const boundHandle = randomBytes(24).toString("base64url");
    const object = { objectID, service };
    entry.bound.set(boundHandle, object);
    // fleetSvc.CreateFleet: self.fleet = sm.RemoteSvc('fleetObjectHandler').CreateFleet(), from the answer on.
    if (method === "CreateFleet") entry.fleet = object;
    return { boundHandle, service, method, notifications: drain(entry) };
  }

  async function callBoundMethod(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined, boundHandle = undefined) {
    const entry = held(bridgeSessionID, sessionFields);
    const object = entry.bound.get(String(boundHandle || ""));
    if (!object) throw fail("BOUND_HANDLE_NOT_FOUND", "Unknown bound-object handle for this session.");
    if (object.service !== service) throw fail("BOUND_HANDLE_NOT_FOUND", "Bound-object handle does not belong to the requested service.");
    assertAllowed(service, method);
    if (retailNeeds(service, method) === "dogma") await shipReadings(entry, whereabouts(entry));
    const form = shape(service, method, args, kwargs, contextFor(entry));
    if (service === "dogmaIM" && method === "QueryAttributeValue") {
      const held = attributeHeld(entry, form.args);
      if (held !== undefined) return { service, method, result: held, notifications: drain(entry) };
    }
    // What crimewatch's service keeps is its to answer on a Moniker's handle too.
    if (keptOfCrimewatch(service, method, form)) {
      const kept = await run(entry, service, method, () => crimewatchKept(entry, method));
      return { service, method, result: wireToBridgeJson(kept === undefined ? null : kept), notifications: drain(entry) };
    }
    /** The call itself, noted as it is sent. */
    const sent = async () => {
      ledger.note(service, method, form);
      // fittingSvc.LoadFitting: the fitting is applied on the ship's own inventory, invCache.GetInventoryFromId(ship),
      // which the location's manager is asked for. The BFF's route has the manager's handle.
      if (service === "invbroker" && method === "FitFitting") {
        // invCache.GetInventoryFromId(itemid, passive=0), noted as the bind of an inventory it is.
        ledger.note("invbroker", "GetInventoryFromId", BOUND_AS_THE_CLIENT_BINDS);
        const shipInventory = boundObjectID(await inventoryCall(entry, "location", "GetInventoryFromId", [argumentsToWire(form.args[0]), 0]));
        return entry.session.callBound(shipInventory, method, argumentsToWire(form.args), form.kwargs);
      }
      return object.params === undefined
        ? entry.session.callBound(object.objectID, method, argumentsToWire(form.args), form.kwargs)
        : handleCall(entry, String(boundHandle), object, method, argumentsToWire(form.args), form.kwargs);
    };
    // What a container lists is the inventory cache's to answer: asked for, and noted, only where nothing is kept.
    const listing = service === "invbroker" && INVENTORY_LISTINGS.has(method);
    // A planet's colony and what the planet carries are kept by the planet, where they are asked as the client asks them.
    const ofAPlanet = service === PLANET_MGR && PLANET_READS.has(method) && object.params !== undefined && form.args.length === 0;
    let result;
    try {
      result = await run(entry, service, method, () => (listing ? entry.listings.read(listingKeptAs(boundHandle, form), sent) : ofAPlanet ? planetRead(entry, object, method, sent) : sent()));
    } catch (error) {
      if (mayChangeContents(service, method)) entry.listings.forget();
      forgetKeptAfter(entry, service, method);
      if (changesAColony(service, method)) forgetColonies(entry);
      // The session's own word for a bind the server answered without an object: the gateway's, for a bind.
      if (/ did not return a bound object\.| could not say where its object lives\./.test(error.message)) {
        throw fail("BOUND_NO_OBJECT", `${service}.MachoBindObject did not return a bound object.`);
      }
      throw error;
    }
    if (mayChangeContents(service, method)) entry.listings.forget();
    forgetKeptAfter(entry, service, method);
    if (changesAColony(service, method)) forgetColonies(entry);
    if (service === "scanMgr") afterScanManagerCall(entry, method, form.args, result);
    if (service === "dogmaIM") afterGroupingCall(entry, method, form.args, result);
    if (service === "beyonce") afterMovementCall(entry, method, form.args, kwargs);
    if (service === "fleetObjectHandler") await afterFleetCall(entry, object, method, result);
    return {
      service,
      method,
      result: wireToBridgeJson(result === undefined ? null : result),
      notifications: drain(entry),
    };
  }

  /**
   * The session's notifications as they arrive, in the gateway's frames. A
   * cursor from this process that is still in the history is replayed from;
   * any other gets a snapshot frame, which tells the reader to re-read.
   */
  function openSessionEventStream({ bridgeSessionID, userid, cursor = null, onFrame, onOpen, onClose } = {}) {
    const subscriber = {
      onFrame: typeof onFrame === "function" ? onFrame : () => {},
      onClose: typeof onClose === "function" ? onClose : () => {},
      closed: false,
    };
    let entry;
    try {
      entry = held(bridgeSessionID, userid === undefined ? undefined : { userid });
    } catch {
      // Deferred, as the gateway client's is: the caller must be holding the
      // handle this returns by the time its close handler runs.
      queueMicrotask(() => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        subscriber.onClose({ code: 0, reason: "session not found", refusalStatus: 404 });
      });
      return { close() { subscriber.closed = true; } };
    }
    const sequence = cursor && cursor.epoch === epoch ? Number(cursor.sequence) : NaN;
    const oldest = entry.history.length > 0 ? entry.history[0].cursor.sequence : entry.sequence + 1;
    const replayable = Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= entry.sequence && sequence >= oldest - 1;
    const first = replayable
      ? entry.history.filter((frame) => frame.cursor.sequence > sequence)
      : [Object.freeze({
          source: STREAM_SOURCE,
          apiVersion: 1,
          streamVersion: 1,
          type: "snapshot",
          cursor: Object.freeze({ epoch, sequence: entry.sequence }),
          reason: cursor ? "cursor_not_replayable" : "no_cursor",
        })];
    // Subscribed before the first frames go out, so nothing published while
    // they are being read is lost; they go out on the next tick, behind onOpen.
    const pending = [...first];
    const live = subscriber.onFrame;
    subscriber.onFrame = (frame) => pending.push(frame);
    entry.subscribers.add(subscriber);
    queueMicrotask(() => {
      if (subscriber.closed) return;
      if (typeof onOpen === "function") {
        try {
          onOpen();
        } catch {
          // The stream is open whether or not the listener liked hearing so.
        }
      }
      subscriber.onFrame = live;
      for (const frame of pending.splice(0)) deliver(subscriber, frame);
    });
    return {
      close() {
        subscriber.closed = true;
        entry.subscribers.delete(subscriber);
      },
    };
  }

  /** Close every session: the BFF is stopping, and each pilot logs off as a closed client's would. */
  function shutdown() {
    for (const entry of [...sessions.values()]) end(entry, "transport_shutdown");
    for (const line of [...accountLines.values()]) line.hangUp();
  }

  return {
    selectCharacter,
    callMethod,
    bindObject,
    callBoundMethod,
    alreadyFollowing,
    releaseBridgeSession,
    readFlightStatus,
    readScannerState,
    readSpaceSnapshot,
    openSessionEventStream,
    accountCall,
    answerClientQuestion,
    ship,
    fleet,
    fleetKept,
    standingsKept,
    brokersFeeRate: brokersFeeRateFor,
    skillSheet,
    serverNowMs,
    saveSkillQueue,
    journalKept,
    ownersNamed,
    shipInfo,
    shipAttribute,
    shutdown,
    /** Every pair called since this transport was made, most called first, with how each compares with the retail client's. */
    callLedger: () => ledger.rows(),
    /** How many pilots are on the game port now. */
    get size() {
      return sessions.size;
    },
  };
}

module.exports = { GamePortPilotError, argumentsToWire, boundObjectID, createGamePortPilots };
