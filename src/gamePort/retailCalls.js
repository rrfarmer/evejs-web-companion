"use strict";

// What the retail client sends for each call, and how what the BFF asks for
// compares with it.
//
// The BFF's routes were written against the web gateway, which hands a call's
// arguments straight to the handler. A handler reads a flag from the first
// position or from a keyword alike, a list or a tuple alike, so the routes
// were free to spell a call any way that worked. The retail client spells each
// call one way. On the game port the goal is to send what that client sends.
//
// Each entry below is one "service.method" pair, checked against the
// decompiled client (eve.js/tools/ClientCodeGrabber/Latest), with the file and
// line it was checked against. An entry says one of:
//
//   same       the BFF's call is the retail client's, as it stands
//   reshaped   `shape` turns the BFF's arguments into the retail client's
//   differs    a known difference this cannot repair from the arguments alone
//              (the note says what; the route has to change)
//   web-only   the retail client does not make this call at all (the note says
//              what it does instead). The call is still sent: the web client
//              needs its answer until that feature is rebuilt the client's way
//
// Two services the client asks ON A MONIKER: not by name, as the BFF's routes
// ask, but on the object bound for where the pilot is (eveMoniker.py:
// GetShipAccess for `ship`, CharGetDogmaLocation for `dogmaIM`). In the whole
// client only ship.GetShipFittingInfo, dogmaIM.CreateNewbieShip and
// dogmaIM.GetRequiredSkillLevels are asked of those two by the service's
// name. So every other pair of theirs is made on the moniker, read or not:
// the pilot binds that object as the client does and calls it there. An entry
// may say the pilot must have something first (`needs`).
//
// A third the client asks on a moniker and never by name at all: the
// corporation registry (eveMoniker.GetCorpRegistry, Moniker('corpRegistry',
// session.corpid)). sm.RemoteSvc('corpRegistry') appears nowhere in the client.
// Its moniker is the corporation's, not the place's: the corp service binds it
// once and again when the pilot's corporation changes (base_corporation.py 137).
//
// A shape may need what only the pilot's own client would know: which of its
// modules are online, what a module's effect is called. It is handed a
// `context` of such answers (pilots.js makes it); each may be absent, and a
// shape that cannot be completed says the call differs.
//
// A pair with no entry is "unchecked": sent as the BFF spelt it, and counted,
// so the list of what still needs reading is measured rather than guessed.
// `shape` may also decide the status from the arguments it is given.

const { constructorKeywordOrder, dictOrder, orderEntries } = require("./py27");

/** A Python list, from a JS array (which would go out as a tuple) or from one already wrapped. */
const list = (value) => (Array.isArray(value) ? { type: "list", items: value } : value);

/**
 * A market order's ID as the client has it: a number, off the order's row. The BFF's routes have it as the text the
 * page sent, and text on the wire is a string. A number as it is, a string of digits as the number it spells (a
 * long, past what a number holds exactly), and null for what is no order's ID.
 */
function orderNumber(value) {
  if (typeof value === "bigint") return value > 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number > 0 ? number : null;
  return BigInt(value);
}

const token = (value) => ({ type: "token", value });
/** A whole number above nought, off a number or off the text a plain object's key is; else null. */
const wholeKey = (value) => {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
};
/** A dict of whole numbers to whole numbers, in the order a Python dict filled with them in that order has them. Pairs that are not such are left out. */
function numbersDict(pairs) {
  const entries = pairs.map(([key, value]) => [wholeKey(key), wholeKey(value)]).filter(([key, value]) => key !== null && value !== null);
  return { type: "dict", entries: orderEntries(entries) };
}
/** What a route gave for a dict: a plain object's own pairs; a dict of the wire's as it is (null). */
const plainPairs = (given) => (given && typeof given === "object" && !Array.isArray(given) && given.type === undefined ? Object.entries(given) : null);

/** cargoItemsByType, or one of a fitting's dicts: quantities by type. */
const quantitiesByType = (given) => (plainPairs(given) === null ? given : numbersDict(plainPairs(given)));

/**
 * fittingSvc.LoadFitting's itemsToFit, a defaultdict(set): the hangar's items to fit from, by type. Python reduces
 * a defaultdict to (collections.defaultdict, (set,)) with its items after, and a set to (set, ([...],)); so each
 * goes to the wire as an object made by that call. A route gives a plain object of lists.
 */
function itemsToFit(given) {
  const pairs = plainPairs(given);
  if (pairs === null) return given;
  const byType = pairs.map(([typeID, itemIDs]) => [wholeKey(typeID), (Array.isArray(itemIDs) ? itemIDs : []).map(wholeKey).filter((itemID) => itemID !== null)])
    .filter(([typeID, itemIDs]) => typeID !== null && itemIDs.length > 0);
  const setOf = (itemIDs) => ({ type: "objectex1", header: [token("__builtin__.set"), [{ type: "list", items: dictOrder(itemIDs) }]], list: [], dict: [] });
  return { type: "objectex1", header: [token("collections.defaultdict"), [token("__builtin__.set")]], list: [], dict: orderEntries(byType.map(([typeID, itemIDs]) => [typeID, setOf(itemIDs)])) };
}

/** The six a fitting is applied by, in the order the client writes them (shipfitting/fitting.py 119). */
const FITTING_PARTS = Object.freeze(["chargesByType", "dronesByType", "fightersByTypeID", "iceByType", "modulesByFlag", "implantsByTypeID"]);

/**
 * Fitting.GetKeyValForApplyingFit: a util.KeyVal of six dicts, the modules by slot and five kinds of thing by type.
 * A route gives the modules by slot alone, as a plain object, or a plain object of the parts by those names; a
 * part it has not is an empty dict, as it is in the client for a fitting with none of that kind.
 */
function fittingKeyVal(given) {
  const pairs = plainPairs(given);
  if (pairs === null) return given;
  const parts = pairs.some(([name]) => FITTING_PARTS.includes(name)) ? given : { modulesByFlag: given };
  return keyVal(constructorKeywordOrder(FITTING_PARTS).map((name) => [name, quantitiesByType(parts[name] ?? {})]));
}

/** The eight keywords a sale's item is made with, in the order the client's window writes them (sellMulti.py 501). */
const SALE_ITEM = Object.freeze(["stationID", "typeID", "itemID", "price", "quantity", "officeID", "delta", "rawBrokerFeePercentage"]);
const wholeAndPositive = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * sellMulti.py 483, GetValidatedItem: one item of a sale, as the window makes it,
 *
 *   KeyVal(stationID=int(...), typeID=int(...), itemID=..., price=round(price, 2), quantity=int(qty),
 *          officeID=..., delta=..., rawBrokerFeePercentage=...)
 *
 * with officeID None for an item that is not in a corporation's office. A route gives one as a plain object with
 * what it knows of it, which is no value the wire has. Answers { item, has, rate }: the util.KeyVal, its fields in
 * the order the client's Python keeps the keywords of such a call (py27.js constructorKeywordOrder); which of the
 * eight it has; and its broker's fee rate, where it has one. Of the two the window works out, the fee rate is
 * `rateAt(stationID)` where a route gave none and it can be worked out, and delta is how far the price is from
 * `averageOf(typeID)`, the type's average over a week (GetDelta, buySellItemContainerBase.py 57), where that is to
 * be had. Neither is made up. An item that is the client's KeyVal already is answered as it is. Null for what is
 * no item of a sale.
 */
function saleItem(given, rateAt = () => null, averageOf = () => null) {
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  if (given.type === "object") {
    const entries = given.args && Array.isArray(given.args.entries) ? given.args.entries : [];
    const rate = entries.find(([name]) => name === "rawBrokerFeePercentage");
    return { item: given, has: entries.map(([name]) => name), rate: rate ? rate[1] : null };
  }
  if (given.type !== undefined || given.itemID === undefined || given.itemID === null) return null;
  if (!wholeAndPositive(given.stationID) || !wholeAndPositive(given.typeID) || !wholeAndPositive(given.quantity)) return null;
  if (typeof given.price !== "number" || !Number.isFinite(given.price) || given.price <= 0) return null;
  const rate = given.rawBrokerFeePercentage ?? rateAt(given.stationID) ?? undefined;
  const delta = given.delta !== undefined ? given.delta : deltaFrom(given.price, averageOf(given.typeID));
  const fields = { ...given, price: Math.round(given.price * 100) / 100, officeID: given.officeID ?? null, delta, rawBrokerFeePercentage: rate };
  const written = SALE_ITEM.filter((name) => fields[name] !== undefined);
  return { item: keyVal(constructorKeywordOrder(written).map((name) => [name, fields[name]])), has: written, rate: rate ?? null };
}

/** buySellItemContainerBase.GetDelta: how far a price is from an average, as a fraction of it; undefined with no average, or one of nothing. */
const deltaFrom = (price, average) => (average !== null && average > 0 ? (price - average) / average : undefined);

/** A type's average price over a week as the client's sale entry has it, where whoever shapes the call has it: a number, or null. */
function averagePriceOf(context, typeID) {
  const average = context && typeof context.averagePrice === "function" ? context.averagePrice(typeID) : null;
  return typeof average === "number" && Number.isFinite(average) ? average : null;
}

/** The broker's fee rate at a station as the client would work it out, where whoever shapes the call can: a number, or null. */
function brokersFeeOf(context, stationID) {
  const rate = context && typeof context.brokersFee === "function" ? context.brokersFee(stationID) : null;
  return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
}

/** The order's own row in the pilot's orders the session keeps, by the columns' names: null where there is none, or no such order in it. */
const ownOrderRow = (context, orderID) => (context && typeof context.ownOrder === "function" ? context.ownOrder(orderID) ?? null : null);

/** Whether two lists of arguments are the same values in the same kinds: the call is the client's as it stands. */
const sameValues = (one, other) => one.length === other.length && one.every((value, at) => value === other[at]);

const same = (source, note) => Object.freeze({ status: "same", source, note });
/** A whole number that is not below nought, as a price is. */
const isAPrice = (value) => Number.isSafeInteger(value) && value >= 0;
/** officeManager.GetPriceQuote (114): self.station.GetPriceQuote(session.corpid), and nothing else. */
const priceForOwnCorporation = (args, kwargs, context) => (args.length === 1 && Object.keys(kwargs).length === 0 && args[0] === context.corporationID
  ? {}
  : { status: "differs", note: "The client asks the price with the session's corporation, and nothing else." });
/** officeManager.RentOffice (117): self.station.RentOffice(cost), the price it was quoted. */
const rentAtThePrice = (args, kwargs) => (args.length === 1 && Object.keys(kwargs).length === 0 && isAPrice(args[0])
  ? {}
  : { status: "differs", note: "The client rents with the one price it was quoted, and nothing else." });
/**
 * skillQueueSvc.CommitTransaction (152, 153): the whole queue as one dict of place to (typeID, toLevel), the places
 * from nought in order, and `activate` said and nothing else.
 */
const queueByPlace = (args, kwargs) => {
  const queue = args.length === 1 && args[0]?.type === "dict" && Array.isArray(args[0].entries) ? args[0].entries : null;
  const whole = queue !== null && queue.every((entry, place) => Array.isArray(entry) && entry.length === 2 && entry[0] === place &&
    Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every((value) => Number.isSafeInteger(value)));
  return whole && Object.keys(kwargs).length === 1 && typeof kwargs.activate === "boolean"
    ? {}
    : { status: "differs", note: "The client sends the whole queue as one dict, each entry (typeID, toLevel) by its place from nought, and says whether it is to be started." };
};
/** skillsvc.ApplyFreeSkillPoints (886): one skill and how many points, each a whole number above nought, and nothing else. */
const pointsForOneSkill = (args, kwargs) => (args.length === 2 && args.every((value) => Number.isSafeInteger(value) && value > 0) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client names one skill and how many points to put into it, more than none, and nothing else." });
/** crimewatchSvc.SetSafetyLevel (343): one of the ship's three safety levels (crimewatch/const.py), and nothing else. */
const oneSafetyLevel = (args, kwargs) => (args.length === 1 && [0, 1, 2].includes(args[0]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sets one of the three safety levels (0, 1 or 2), and sends nothing else." });
/** contracts.AcceptContract (422): the contract's ID, a whole number above nought, and whether it is for the corporation, True or False; nothing else. */
const oneContractForWhom = (args, kwargs) => (args.length === 2 && Number.isSafeInteger(args[0]) && args[0] > 0 && typeof args[1] === "boolean" && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client names the one contract and says whether it is taken on for the corporation, and nothing else: AcceptContract(contractID, forCorp)." });
/** journal.DeleteLaunchEntry (464): the one launch's ID, a whole number above nought, and nothing else. */
const oneLaunch = (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client names the one launch and nothing else: DeleteLaunch(launchID)." });
/** A judge for a call the client sends with nothing: no argument, and no keyword. */
const sentWithNothing = (args, kwargs) => (args.length === 0 && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends nothing with this call." });
const reshaped = (source, shape, note) => Object.freeze({ status: "reshaped", source, shape, note });
const differs = (source, note) => Object.freeze({ status: "differs", source, note });
/** Same or differs, depending on what the call carries: `judge` answers { status, note }. */
const judged = (source, judge, note) => Object.freeze({
  status: "same",
  source,
  note,
  shape: (args, kwargs, context) => ({ args, kwargs, ...judge(args, kwargs, context) }),
});
const webOnly = (source, note) => Object.freeze({ status: "web-only", source, note });
/** The same entry, with what the pilot must have before the call can be shaped: "dogma" is godma primed for the ship. */
const needing = (entry, needs) => Object.freeze({ ...entry, needs });

/** The services the client asks on a moniker, and the few methods of each it asks by the service's name all the same. */
const MONIKER_SERVICES = Object.freeze({
  ship: new Set(["GetShipFittingInfo"]),
  dogmaIM: new Set(["CreateNewbieShip", "GetRequiredSkillLevels"]),
  corpRegistry: new Set(),
  // skillsvc.GetSkillHandler: the moniker skillMgr2.GetMySkillHandler answers, kept. On this server it names this service.
  skillHandler: new Set(),
  // crimewatchSvc: eveMoniker.CharGetCrimewatchLocation(), made at every use.
  crimewatch: new Set(),
  // The alliance service's moniker for the session's alliance (all_cso.GetMoniker: eveMoniker.GetAlliance(), bound
  // when it is made). What is asked about any alliance by its ID is asked of the service by name.
  allianceRegistry: new Set(["GetAlliancePublicInfo", "GetRankedAlliances", "GetEmploymentRecord", "GetAllianceMembers", "GetDaysInAlliance", "GetAllianceMembersOlderThan"]),
  // eveMoniker.GetPlanetOrbitalRegistry(session.solarsystemid): Moniker('planetOrbitalRegistryBroker', solarSystemID),
  // made where it is wanted and not kept (importExportUI.py 383, infosvc.py 2066).
  planetOrbitalRegistryBroker: new Set(),
  // officeManager.station (officeManager.py 50): Moniker('officeManager', session.stationid or session.structureid),
  // kept while the session is there. The corporation's own offices, wherever they are, are asked by name (41).
  officeManager: new Set(["GetMyCorporationsOffices"]),
});
/**
 * Monikers for something a session may not have, by what it is in the call's context: the client cannot make one
 * without it (eveMoniker.GetAlliance raises), or makes one for nothing (a system's, with session.solarsystemid None
 * while docked). Each with where the client's moniker is made, and what the ledger says of a call made without it.
 */
const MONIKER_NEEDS = Object.freeze({
  allianceRegistry: Object.freeze({
    has: "allianceID",
    source: "eve/common/script/net/eveMoniker.py:171",
    note: "The client asks this on a moniker it cannot make while its session has no alliance, and so does not ask it at all.",
  }),
  planetOrbitalRegistryBroker: Object.freeze({
    has: "solarSystemID",
    source: "eve/common/script/net/eveMoniker.py:219",
    note: "The client asks this on a moniker for the system its session is in space in, at a customs office. Docked it has no such system, and does not ask.",
  }),
  officeManager: Object.freeze({
    has: "dockedAt",
    source: "eve/client/script/ui/services/corporation/officeManager.py:48",
    note: "The client asks this on a moniker for the station or structure its session is docked in. In space it has none, and does not ask.",
  }),
});

/** shipConfigSvc.py 51: eveMoniker.GetShipAccess().GetShipConfiguration(shipID), a Moniker of its own each time. */
const OWN_SHIP_MONIKER = new Set(["GetShipConfiguration"]);
/**
 * Whether the client makes a new Moniker for this call, which binds carrying it and is not kept, or calls one it
 * keeps. All of crimewatch's are made anew (crimewatchSvc.py: CharGetCrimewatchLocation().Method(...) at each use).
 * The ship's go through gameui.GetShipAccess (gameui.py 228), which makes a new one each time while the session
 * has a station and keeps one otherwise for as long as the system, the ship and the character are the same; a
 * service that makes its own does so wherever the pilot is.
 */
const madeAfresh = (service, method, { dockedInStation = false } = {}) =>
  service === "crimewatch" || service === "planetOrbitalRegistryBroker" || (service === "ship" && (dockedInStation || OWN_SHIP_MONIKER.has(method)));
/**
 * The services the client reaches with sm.ProxySvc(name): every one in the decompiled client, and none
 * of them is asked any other way. Such a call is addressed to the client's proxy node
 * (serviceManager.py 558: session.ConnectToRemoteService(name, machoNet.myProxyNodeID)); a
 * sm.RemoteSvc call names no node. The server's own log of a retail client shows the two apart
 * ("dst=node", "dst=any").
 */
const PROXY_SERVICES = Object.freeze(new Set([
  "XmppChatMgr", "alert", "bountyProxy", "calendarProxy", "clientStatLogger", "contractProxy", "corpRecProxy",
  "eventLog", "fleetProxy", "machoNet", "marketProxy", "pingService", "raffleProxy", "search",
]));

/**
 * Calls of the client's own that the transport makes when a feature wants them, and that no route of the BFF's
 * may ask by name, so that they have no entry in the table below. Each is read against the client where the
 * transport makes it (pilots.js): cfg.eveowners' priming, for the names of players' owners.
 */
// (The station's office object's reads are the lobby's, which the gateway never had: see GAME_PORT_ONLY_CALLS.)
const TRANSPORT_OWN_CALLS = Object.freeze(["config.GetMultiOwnersEx"]);

/**
 * Calls the game port carries that the web gateway's list has not got: a pilot on the game port may make them, and
 * through the gateway they are refused. The customs office's transfer is the client's own call at an office
 * (importExportUI.py 549), and the gateway never had it.
 */
const GAME_PORT_ONLY_CALLS = Object.freeze([
  "invbroker.ImportExportWithPlanet", "officeManager.GetCorporationsWithOffices", "officeManager.GetEmptyOfficeCount",
  // The lobby's buttons, on the station's own office object. (The BFF's list of writes names the renting; the
  // gateway's list of what it will carry has none of these.)
  "officeManager.GetPriceQuote", "officeManager.HasCorpImpoundedItems", "officeManager.PrimeOfficeItem", "officeManager.RentOffice", "officeManager.UnrentOffice",
  // The account's clone grade, which the client asks as it logs in. The gateway's list has nothing of the subscription manager's.
  "subscriptionMgr.GetCloneGrade",
  // The queue service's priming. The page asks for it by name to make the Skills window's sheet itself (the plan's
  // Phase 6b), and is answered from what the transport keeps. The gateway's list has not got it: through the
  // gateway the sheet is the gateway's own.
  "skillHandler.GetSkillQueueAndFreePoints",
  // The home station as the client's own service asks for it, which its Character Sheet reads. The gateway's list
  // has charMgr's row and not this.
  "home_station.get_home_station",
  // The queue's saving as the client's queue service makes it, on the handler. The page makes it by name (the
  // plan's Phase 6b). The gateway's list has skillMgr's save and not this: through the gateway the route saves.
  "skillHandler.SaveNewQueue",
  // The account's extra training slots, which the client's queue service asks for to tell whether a change of
  // the queue may start it (skillQueueSvc.py 851). The gateway's list has nothing of the user service's.
  "userSvc.GetMultiCharactersTrainingSlots",
]);

/**
 * Calls the client makes on an object that another call answered, where no moniker is: the system's scan manager,
 * which GetSystemScanMgr() answers. Asked of the service by its name, such a call is not the client's call,
 * whatever it is asked with.
 */
const ON_AN_ANSWERED_OBJECT = Object.freeze(new Set(["scanMgr.GetFullState"]));

/** Whether the retail client makes this call on the service's moniker for where the pilot is. */
const madeOnMoniker = (service, method) => Object.hasOwn(MONIKER_SERVICES, service) && !MONIKER_SERVICES[service].has(method) && method !== "MachoBindObject";

const INV_CACHE = "eve/client/script/environment/invCache.py";
const INV_CONTROLLERS = "eve/client/script/environment/invControllers.py";
const AGENT_WINDOW = "eve/client/script/ui/station/agents/agentDialogueWindow.py";
const AGENTS = "eve/client/script/ui/station/agents/agents.py";
const CHAR_SELECT = "eve/client/script/ui/login/charSelection/characterSelection.py";
const SCAN_SVC = "eve/client/script/parklife/scanSvc.py";
const STATION_SVC = "eve/client/script/ui/station/base.py";
const GODMA = "eve/client/script/environment/godma.py";
const MODULE_BUTTON = "eve/client/script/ui/inflight/shipModuleButton/shipmodulebutton.py";
const TARGET_MGR = "eve/client/script/parklife/targetMgr.py";
const CLIENT_DOGMA = "eve/client/script/dogma/clientDogmaLocation.py";
const EVE_MISC = "eve/client/script/util/eveMisc.py";
const DRONE_FUNCTIONS = "eve/client/script/ui/services/menuSvcExtras/droneFunctions.py";
const SHIP_CONFIG = "eve/client/script/ui/services/shipConfigSvc.py";
const FITTING_SVC = "eve/client/script/environment/fittingSvc.py";
const CLIENT_PLANET = "eve/client/script/environment/planet/clientPlanet.py";
const IMPORT_EXPORT = "eve/client/script/ui/shared/planet/importExportUI.py";
const CC_SVC = "eve/client/script/ui/services/ccSvc.py";
const CC_STEPS = "eve/client/script/ui/login/charcreation/steps";
const ACCOUNT_SVC = "eve/client/script/ui/services/accountsvc.py";
const WALLET_SVC = "eve/client/script/ui/shared/neocom/wallet/walletSvc.py";
const CORP_SVC = "eve/client/script/ui/services/corporation";
const ALLIANCE_SVC = "eve/client/script/ui/services/alliances";
/**
 * all_cso_alliance.GetAlliance(allianceID): its own alliance the client asks of its moniker, with nothing; another
 * it asks of the service by name, by the alliance's ID. Asked with none, the pilot's own.
 */
const ofAnAlliance = (args, kwargs, context) => {
  const asked = Number(args[0]) > 0 ? Number(args[0]) : null;
  if (asked === null) return { args: [], kwargs };
  return asked === context.allianceID ? { args: [], kwargs, status: "reshaped" } : { args: [asked], kwargs, moniker: false };
};
const CONTRACTS_SVC = "eve/client/script/ui/shared/neocom/contracts/contracts.py";
const CONTRACT_SEARCH = "eve/client/script/ui/shared/neocom/contracts/contractsearch.py";
const MARKET_QUOTE = "eve/client/script/ui/services/marketsvc.py";
const CALENDAR_SVC = "eve/client/script/ui/services/eveCalendarsvc.py";
/** The keywords of the client's one contract search, in the order its call writes them (contractsearch.py 1367). */
const CONTRACT_SEARCH_KEYWORDS = Object.freeze([
  "itemTypes", "itemTypeName", "itemCategoryID", "itemGroupID", "contractType", "securityClasses", "locationID",
  "endLocationID", "issuerID", "minPrice", "maxPrice", "minReward", "maxReward", "minCollateral", "maxCollateral",
  "minVolume", "maxVolume", "excludeTrade", "excludeMultiple", "excludeNoBuyout", "availability", "description",
  "searchHint", "sortBy", "sortDir", "startNum",
]);
const INDUSTRY = "eve/client/script/industry";
const CORP_ASSETS = "eve/client/script/ui/shared/neocom/corporation/corp_ui_accounts.py";
const MAIL_SERVICES = "eve/client/script/ui/services/mail";
const FLEET_SVC = "eve/client/script/parklife/fleetSvc.py";
/** A read of one character, which the client always names: the pilot's own, when the route named none. */
const ofTheCharacter = (args, kwargs, context) => {
  if (args[0] !== null && args[0] !== undefined) return { args, kwargs };
  const characterID = context.characterID ?? null;
  return characterID === null
    ? { args, kwargs, status: "differs", note: "The client names the character it asks about. With no pilot known there is no one to name, and the call goes as it was given." }
    : { args: [characterID], kwargs, status: "reshaped" };
};
/** The calendar's two reads of one event: the client has the event's row to hand, so its ID and its owner's both. */
const ofAnOpenedEvent = (args) => (args[0] > 0 && args[1] !== null && args[1] !== undefined
  ? { status: "same" }
  : { status: "differs", note: "The client asks this of an event the pilot has opened, by the event's ID and its owner's (eventInfo.eventID, eventInfo.ownerID). It never asks of no event, nor without the owner." });
const CONTRACT_PANELS = "eve/client/script/ui/shared/neocom/contracts/contractPanels.py";
const CRIMEWATCH_SVC = "eve/client/script/ui/services/crimewatchSvc.py";
/** contractPanels.py RESULTS_PER_PAGE. */
const CONTRACTS_PER_PAGE = 100;
/**
 * MyContractsPanel._GetContractsToShow: whose, in what state, of what type and issued to or by, then by name how
 * many to a page and the contract the page starts at. None is "all" for a filter and "the first" for the page.
 */
function ownersContracts(args, kwargs) {
  const [ownerID, status, contractType, issuedBy] = args;
  if (ownerID === null || ownerID === undefined || status === null || status === undefined) {
    return { args, kwargs, status: "differs", note: "The client always names an owner and a status. This call leaves one of them out, and goes as it was given." };
  }
  const sent = { args: [ownerID, status, contractType ?? null, issuedBy ?? null], kwargs: { num: CONTRACTS_PER_PAGE, startContractID: kwargs.startContractID ?? null } };
  const whole = args.length === 4 && Object.keys(kwargs).length === 2 && kwargs.num === CONTRACTS_PER_PAGE && "startContractID" in kwargs;
  return whole ? sent : { ...sent, status: "reshaped" };
}
/**
 * fleetSvc.GetMyShipTypeID (1948): the type of the ship the pilot is in, godma's word for it in space and the dogma
 * location's docked; None in no ship. Undefined where the ship's type was not known here.
 */
function ownShipType(context) {
  if (context.shipID === null) return null;
  return (context.shipTypeID ? context.shipTypeID() : null) ?? undefined;
}
const SHIP_TYPE_UNKNOWN = "The client sends the type of the ship the pilot is in. It was not known here, so the call went as the BFF spelt it.";

/** AcceptInvite(shipTypeID), UpdateMemberInfo(shipTypeID): the pilot's own ship's type and nothing else, whatever the caller named. */
function withOwnShipType(args, kwargs, context) {
  const typeID = ownShipType(context);
  return typeID === undefined ? { args, kwargs, status: "differs", note: SHIP_TYPE_UNKNOWN } : { args: [typeID], kwargs };
}

/** skillsvc.GetSkillHistory(maxresults=50). */
const SKILL_HISTORY_ASKED = 50;

/** fleetSvc.CreateFleet's Init(shipTypeID, setupName, adInfoData=adInfoData): the advert always by keyword, None where there is none. */
function fleetInit(args, kwargs, context) {
  const typeID = ownShipType(context);
  if (typeID === undefined) return { args, kwargs, status: "differs", note: SHIP_TYPE_UNKNOWN };
  return { args: [typeID, args[1] ?? null], kwargs: { ...kwargs, adInfoData: kwargs.adInfoData ?? null } };
}

/**
 * fleetSvc.LeaveFleet (365): on the fleet's own object where the client holds one, self.fleet; and of fleetMgr by
 * name only where it holds none and the session is in a fleet. `context.holdsFleet` says whether one is held here.
 */
const leavingOnTheObject = (args, kwargs, context) => (context.holdsFleet === true ? {} : {
  status: "differs",
  note: "The client asks this of the fleet's object it holds. Here it holds no object for a fleet: it would ask fleetMgr.ForceLeaveFleet of a fleet the session is in, and nothing otherwise.",
});
const leavingByName = (args, kwargs, context) => (context.holdsFleet === false && context.fleetID !== null && context.fleetID !== undefined ? {} : {
  status: "differs",
  note: "The client asks this only where it holds no object for a fleet the session is in. With the object it asks LeaveFleet of that, and in no fleet it asks nothing.",
});

/**
 * fleetSvc.ApplyToJoinFleet (1898 to 1910): the one fleet, and whether its invitation is to be taken with no
 * asking, as True or False; and only from a session in no fleet. In its own fleet the client refuses, and in
 * another it asks to change and leaves that one first.
 */
const applyingToOneFleet = (args, kwargs, context) => {
  if (!(args.length === 2 && Number.isSafeInteger(args[0]) && args[0] > 0 && typeof args[1] === "boolean" && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the one fleet and says whether its invitation is taken with no asking, and nothing else: ApplyToJoinFleet(fleetID, autoAccept)." };
  }
  return context.fleetID === null || context.fleetID === undefined ? {} : {
    status: "differs",
    note: "The client applies only from a session in no fleet: in its own fleet it refuses, and in another it leaves that one first.",
  };
};
/** The broadcasts fleetSvc sends to its bubble, by name (1039 to 1055), and the scopes a client can be set to (evefleet/const.py 33 to 35). */
const BUBBLE_BROADCASTS = Object.freeze(new Set(["HealArmor", "HealShield", "HealCapacitor", "Target", "HealTarget"]));
const BROADCAST_SCOPES = Object.freeze(new Set([1, 2, 3]));
/**
 * fleetSvc.SendBubbleBroadcast (992 to 998): one of those names, the scope, the item, and None for the type, which
 * no caller of it gives; and only from a session in a fleet (CheckIsInFleet, 993).
 */
const oneBubbleBroadcast = (args, kwargs, context) => {
  if (!(args.length === 4 && BUBBLE_BROADCASTS.has(args[0]) && BROADCAST_SCOPES.has(args[1]) && Number.isSafeInteger(args[2]) && args[2] > 0 && args[3] === null && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client sends one of its five names for the bubble, its scope, the item and None for the type, and nothing else: BroadcastToBubble(name, scope, itemID, None)." };
  }
  return context.fleetID === null ? { status: "differs", note: "The client broadcasts only from a session in a fleet: in none it sends nothing." } : {};
};

/** fleetSvc.KickMember (607): the pilot's own number is not kicked. The client leaves the fleet itself instead. */
const kickingAnother = (args, kwargs, context) => (String(args[0]) === String(context.characterID) ? {
  status: "differs",
  note: "The client does not kick the pilot's own character: it leaves the fleet instead (LeaveFleet, on the fleet's object).",
} : {});
/** fleetSvc.DisbandFleet (614): unless the pilot is the fleet's boss the client refuses it itself, and nothing is sent. */
const disbandingAsBoss = (args, kwargs, context) => (context.fleetBoss === true ? {} : {
  status: "differs",
  note: "The client disbands a fleet only for its boss, and refuses anyone else itself (CannotDisbandFleetIfNotBoss) with nothing sent. The pilot is not the boss of a fleet kept here.",
});
/**
 * fleetSvc.SetOptions (444): options = copy.copy(self.options), free move set where one was asked for, and that
 * copy sent. It is a KeyVal, as what the server sent is, and nothing else of it is changed this way.
 * `context.fleetOptions()` is the options as they are kept.
 */
function fleetOptionsCopy(args, kwargs, context) {
  const given = args[0];
  const kept = context.fleetOptions ? context.fleetOptions() : null;
  const asked = given !== null && typeof given === "object" ? Object.keys(given) : null;
  if (asked === null || asked.some((name) => name !== "isFreeMove") || (asked.length === 1 && typeof given.isFreeMove !== "boolean")) {
    return { args, kwargs, status: "differs", note: "The client changes a fleet's free move this way and nothing else, on a copy of the options it keeps. This call asks for something else, and went as the BFF spelt it." };
  }
  if (!Array.isArray(kept?.args?.entries)) {
    return { args, kwargs, status: "differs", note: "The client sends a copy of the options it keeps. None are kept here, so the call went as the BFF spelt it." };
  }
  const entries = kept.args.entries.map(([name, value]) => [name, asked.length === 1 && text(name) === "isFreeMove" ? given.isFreeMove : value]);
  return { args: [{ ...kept, args: { ...kept.args, entries } }], kwargs };
}
/** contractscommon.py: auctions and item exchanges searched together, and the sorts by date created and by price. */
const CONTYPE_AUCTION_AND_ITEM_EXCHANGE = 10;
const CONTRACT_SORT_ID = 0;
const CONTRACT_SORT_PRICE = 1;
const DRONE_DAMAGE = "eveDrones/droneDamageTracker.py";
const SKILL_SVC = "eve/client/script/ui/services/skillsvc.py";
const STANDING_SVC = "eve/client/script/ui/services/standingsvc.py";
/**
 * A standing's detail, as the client's standings service asks for it: of an entity, with whoever's standing it is.
 * Two IDs and nothing else. Asked any other way it is not the client's call.
 */
const ofAnEntity = (source, note) => Object.freeze({
  status: "same",
  source,
  note,
  shape: (args, kwargs) => (args.length === 2 && args.every((id) => Number.isSafeInteger(id) && id > 0) && Object.keys(kwargs).length === 0
    ? { args, kwargs }
    : { args, kwargs, status: "differs", note: "The client asks with two IDs and nothing else: the entity's, then the character's or the corporation's." }),
});
const JOURNAL_WINDOW = "eve/client/script/ui/shared/neocom/journal.py";
const DEV_TOOLS = "eve/devtools/script";
const CLIENT_OWN_DOGMA = "eve/common/script/dogma/baseDogmaLocation.py";
/** What the module button sends for a module left to repeat: settings.char.autorepeat unset, and an effect that can repeat. */
const REPEATS = 1000;

/** A Python dict, from [key, value] pairs. */
const dict = (entries) => ({ type: "dict", entries });
const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "");

/**
 * shipmodulebutton.ActivateEffect: the module's default effect by name, the
 * target or None, and how often to repeat. The BFF's routes say -1 for "go on
 * repeating" and leave the name empty when they do not know it; the client
 * sends 1000 for a module left to repeat, 0 for an effect that cannot, and
 * always the name. The page sends what the pilot has locked with every module;
 * the client's button gives a target to an effect aimed at one (effectCategory
 * 2) and None to any other, an afterburner's among them.
 */
function activation(args, kwargs, context) {
  const [itemID, effectName, target, repeat] = args;
  const named = text(effectName) || (context.effectName ? context.effectName(itemID) : null) || "";
  const canRepeat = named && context.effectRepeats ? context.effectRepeats(itemID, named) : null;
  const asked = Number(repeat);
  const repeats = asked >= 0 ? asked : canRepeat === null ? repeat : canRepeat ? REPEATS : 0;
  // Only an effect aimed at a target is given one: the button fills in the active target for those alone (1318).
  const aimed = named && context.effectTargeted ? context.effectTargeted(itemID, named) : null;
  const shaped = { args: [itemID, named, aimed === false ? null : target ?? null, repeats], kwargs };
  if (!named) return { ...shaped, status: "differs", note: "The client always names the module's default effect. This call names none, and what the module is was not known." };
  if (asked < 0 && canRepeat === null) return { ...shaped, status: "differs", note: "The client sends 1000 or 0 for the repeats. Whether this effect can repeat was not known, so the BFF's -1 went as it was." };
  return shaped;
}

/**
 * godma.Overload and StopOverload (2074, 2119): the module, and the ID of its own effect of the overload category,
 * which the module's button finds among the module's effects (shipmodulebutton.py 231). `context.overloadEffect`
 * says which that is where godma knows the module, and null where the module has none or godma does not know it.
 * A call that names no effect (the BFF's routes say 0) is given the module's own.
 */
function overloading(args, kwargs, context) {
  const [itemID, effectID] = args;
  if (!(args.length === 2 && Number.isSafeInteger(itemID) && itemID > 0 && Number.isSafeInteger(effectID) && effectID >= 0 && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client names the module and the ID of the module's overload effect, and nothing else." };
  }
  const own = context.overloadEffect ? context.overloadEffect(itemID) : undefined;
  if (effectID === 0) {
    return own
      ? { args: [itemID, own], kwargs, status: "reshaped" }
      : { args, kwargs, status: "differs", note: "The client always names the module's overload effect. This call names none, and what the module is was not known." };
  }
  // With no godma to ask, an effect named is taken for the module's own.
  if (own === undefined || own === effectID) return { args, kwargs };
  return { args, kwargs, status: "differs", note: own === null
    ? "The client overloads only a module that has an overload effect, and that godma knows. This one has none here."
    : "The client names the module's own overload effect. This call names another." };
}

/** godma's Deactivate(itemID, effectName): the effect is the one the client holds as running, by name. */
function deactivation(args, kwargs, context) {
  const [itemID, effectName] = args;
  const named = text(effectName) || (context.effectName ? context.effectName(itemID) : null) || "";
  const shaped = { args: [itemID, named], kwargs };
  return named ? shaped : { ...shaped, status: "differs", note: "The client always names the effect it is stopping. This call names none, and what the module is was not known." };
}

/**
 * clientDogmaLocation.UnloadAmmoFromModules and UnloadAmmoToContainer. With no
 * quantity the client sends the modules as a list; with one it names a single
 * module, the one the charge is in.
 */
function unloading(args, kwargs) {
  const [shipID, modules, destination, quantity] = args;
  if (quantity === undefined || quantity === null) return { args: [shipID, list(modules), destination], kwargs };
  const several = Array.isArray(modules) ? modules : modules && Array.isArray(modules.items) ? modules.items : null;
  if (several === null) return { args: [shipID, modules, destination, quantity], kwargs };
  if (several.length === 1) return { args: [shipID, several[0], destination, quantity], kwargs };
  return { args: [shipID, modules, destination, quantity], kwargs, status: "differs", note: "With a quantity the client unloads one module, the one the charge is in. This call names several." };
}

/**
 * eveMisc.LaunchFromShip: LaunchDrones([(itemID, quantity), ...],
 * whoseBehalfID, ignoreWarning). The stacks are a list; on whose behalf is
 * None unless it is someone other than the pilot. The BFF's route sends the
 * pilot's own character there.
 */
function launching(args, kwargs, context) {
  const [stacks, whose, ignoreWarning] = args;
  const own = whose === 0 || (context.characterID !== undefined && context.characterID !== null && Number(whose) === Number(context.characterID));
  return { args: [list(stacks), whose === undefined || own ? null : whose, ignoreWarning === true], kwargs };
}

/** shipConfigSvc.GetShipConfig: GetShipConfiguration(shipID). The BFF's route sends nothing; the ship is the pilot's own. */
function configuration(args, kwargs, context) {
  if (args.length > 0) return { args, kwargs };
  if (context.shipID !== undefined && context.shipID !== null) return { args: [context.shipID], kwargs };
  return { args, kwargs, status: "differs", note: "The client names the ship. This call names none, and the pilot's ship was not known." };
}

/**
 * station.UndockAttempt: Undock(shipID, ignoreContraband, onlineModules=...),
 * where onlineModules is the ship's online modules by the slot each is in,
 * {flagID: moduleID}, from the client's own dogma. The BFF's route sends an
 * empty list.
 */
function undocking(args, kwargs, context) {
  const online = context.onlineModules ? context.onlineModules() : null;
  const shaped = { args: [args[0], args[1] === true], kwargs: { ...kwargs, onlineModules: online ? dict(online) : dict([]) } };
  return online ? shaped : { ...shaped, status: "differs", note: "The client sends its online modules by slot. Dogma could not be asked, so none were sent." };
}

/** A util.KeyVal with these fields, in this order. */
/**
 * fittingSvc.PrimeFittings (430): GetFittingMgr(ownerID).GetFittings(ownerID), where the owner
 * is the session's own character, corporation or alliance, and says which manager is asked.
 * The BFF often leaves the owner out and lets the server take it from the session.
 */
const fittingsOf = (owner, whose) => ([ownerID, ...rest], kwargs, context) => {
  const known = ownerID ?? context[owner] ?? null;
  if (known === null) return { args: [], kwargs, status: "differs", note: `The client asks only for an owner it has: this pilot has no ${whose}.` };
  // With the owner named already, the call is the client's as it stands.
  return { args: [known, ...rest], kwargs, status: ownerID === known ? "same" : "reshaped" };
};

const keyVal = (entries) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
/** The clock's 100 ns ticks, however a route spelt them: a long. */
const filetime = (value) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === "object" && value.type === "long" && /^-?\d+$/.test(String(value.value))) return BigInt(value.value);
  return typeof value === "number" && Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
};
const point = (value) => (Array.isArray(value) ? value.slice(0, 3).map(Number) : value && Array.isArray(value.items) ? value.items.slice(0, 3).map(Number) : [0, 0, 0]);

/**
 * scanSvc.RequestScans: the client's idle probes, {probeID: probe}, each the
 * util.KeyVal the server sent with what the client has since changed on it;
 * or None when there are no probes at all. A route gives them as a plain
 * object keyed by the ID.
 */
function scanProbes(given) {
  if (given === null || given === undefined) return null;
  if (given.type === "dict") return given;
  if (typeof given !== "object" || Array.isArray(given)) return given;
  const entries = [];
  for (const [probeID, probe] of Object.entries(given)) {
    const id = Number(probeID);
    if (!Number.isSafeInteger(id) || id <= 0 || !probe || typeof probe !== "object") continue;
    entries.push([id, keyVal([
      ["probeID", id],
      ["typeID", Number(probe.typeID) || null],
      ["pos", point(probe.pos)],
      ["destination", point(probe.destination ?? probe.pos)],
      ["scanRange", Number(probe.scanRange) || 0],
      ["rangeStep", Number(probe.rangeStep) || 0],
      ["state", Number(probe.state) || 0],
      ["expiry", filetime(probe.expiry)],
    ])]);
  }
  return entries.length > 0 ? { type: "dict", entries } : null;
}

const RETAIL_CALLS = Object.freeze({
  // ── character selection (made by the transport itself) ────────────────────
  "charUnboundMgr.GetCharacterSelectionData": same(`${CHAR_SELECT}`, "no arguments"),
  "charUnboundMgr.GetCharacterLockType": same(`${CHAR_SELECT}:695`, "GetCharacterLockType(charID)"),
  "charUnboundMgr.SelectCharacterID": same(`${CHAR_SELECT}:713`, "SelectCharacterID(charID, secondChoiceID, skipTutorial)"),

  // ── character creation (the account's own calls, with no character chosen) ──
  "charUnboundMgr.GetCharCreationInfo": webOnly(`${CC_STEPS}/bloodLineStep.py:107`, "The client never asks this. The races and bloodlines on its creation screens are in its own static data (characterdata)."),
  "charUnboundMgr.ValidateNameEx": reshaped(
    `${CC_STEPS}/sections/chooseNameSection.py:201`,
    ([name, checked, ...rest], kwargs) => ({ args: [name, checked ?? 0, ...rest], kwargs }),
    "ValidateNameEx(charName, how many names the screen has checked before this one). The BFF keeps no such screen and checks the one name it is about to create, so it sends 0, as the client does with its first.",
  ),
  "charUnboundMgr.CreateCharacterWithDoll": differs(
    `${CC_SVC}:97`,
    "The client sends ten: (name, raceID, bloodlineID, genderID, ancestryID, charInfo, portraitInfo, schoolID, None, qaStarterSystemID), with the doll and the portrait it drew. The web client draws neither, and the BFF sends the server's older seven: (name, bloodlineID, genderID, ancestryID, None, None, 0).",
  ),

  // ── saved fittings ─────────────────────────────────────────────────────────
  "charFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("characterID", "character"), "GetFittingMgr(session.charid).GetFittings(session.charid)"),
  "corpFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("corporationID", "corporation"), "GetFittingMgr(session.corpid).GetFittings(session.corpid)"),
  "allianceFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("allianceID", "alliance"), "GetFittingMgr(session.allianceid).GetFittings(session.allianceid), and only for a pilot in an alliance"),

  // ── an inventory (a bound invbroker object) ───────────────────────────────
  "invbroker.List": reshaped(
    `${INV_CACHE}:1138`,
    // self.moniker.List(flag=flag): the flag is always a keyword, None when there is none.
    (args, kwargs) => ({ args: [], kwargs: { ...kwargs, flag: kwargs.flag !== undefined ? kwargs.flag : args[0] ?? null } }),
    "List(flag=flag)",
  ),
  "invbroker.ListByFlags": reshaped(
    `${INV_CACHE}:1174`,
    // self.moniker.ListByFlags(flags=uncachedFlags): a keyword, and a list.
    (args, kwargs) => ({ args: [], kwargs: { ...kwargs, flags: list(kwargs.flags !== undefined ? kwargs.flags : args[0] ?? []) } }),
    "ListByFlags(flags=[...])",
  ),
  "invbroker.GetCapacity": webOnly(
    `${INV_CACHE}:1224`,
    "The client works a capacity out itself: the attribute from dogma or the type, and the volume of what List returned. It never asks the server.",
  ),
  "planetOrbitalRegistryBroker.GetTaxRate": same(`${IMPORT_EXPORT}:383`, "eveMoniker.GetPlanetOrbitalRegistry(session.solarsystemid).GetTaxRate(officeID), on a Moniker made for the call, which binds carrying it. Recorded on Tranquility so, three times in one export."),
  "invbroker.ImportExportWithPlanet": Object.freeze({
    status: "same",
    source: `${IMPORT_EXPORT}:549`,
    note: "customsOfficeInventory.ImportExportWithPlanet(spaceportPinID, importData, exportData, taxRate), on the office's own inventory (invCache.GetInventoryFromId): what comes down a dict of quantities by the item in the office, what goes up a dict of quantities by type, and the rate the registry answered. Recorded on Tranquility with the quantity a float, as its colony's pins hold them; this server's pins hold whole numbers.",
    shape: (args, kwargs) => {
      if (args.length !== 4 || !Number.isFinite(args[3])) {
        return { args, kwargs, status: "differs", note: "The client sends four: the launchpad's pin, what comes down, what goes up, and the tax rate the office's registry answered." };
      }
      const [down, up] = [quantitiesByType(args[1]), quantitiesByType(args[2])];
      return down === args[1] && up === args[2] ? { args, kwargs } : { args: [args[0], down, up, args[3]], kwargs, status: "reshaped" };
    },
  }),
  "planetMgr.GetPlanetsForChar": judged("eve/client/script/environment/planetSvc.py:67", sentWithNothing,
    "sm.RemoteSvc('planetMgr').GetPlanetsForChar(), by name and with nothing: recorded on Tranquility so. The client asks once and keeps the answer, changing it itself as a colony's pins change; the transport keeps it so, and asks again where the client would change it (pilots.js)."),
  "planetMgr.GetMyLaunchesDetails": judged("eve/client/script/ui/shared/planet/planetUISvc.py:172", sentWithNothing,
    "sm.RemoteSvc('planetMgr').GetMyLaunchesDetails(), by name and with nothing: recorded on Tranquility so. The client asks once and keeps the answer until the server says the launches changed (OnPILaunchesChange) or its window asks afresh; the transport keeps it so (pilots.js)."),
  "planetMgr.GetPlanetInfo": judged(`${CLIENT_PLANET}:83`, sentWithNothing,
    "planetInfo = self.remoteHandler.GetPlanetInfo(), on the planet's own object (eveMoniker.GetPlanet(planetID)) and with nothing. Recorded on Tranquility riding the planet's bind: MachoBindObject(planetID, ('GetPlanetInfo', (), {})). The client asks when it first wants the planet and again when the server says the planet's state changed, reckoning the colony itself between; the transport keeps the answer a minute (pilots.js)."),
  "planetMgr.GetPlanetResourceInfo": judged(`${CLIENT_PLANET}:644`, sentWithNothing,
    "self.remoteHandler.GetPlanetResourceInfo(), on the planet's own object and with nothing: what the planet carries, and how rich each is. The transport keeps it by the planet (pilots.js)."),
  "planetMgr.DeleteLaunch": judged("eve/client/script/ui/shared/neocom/journal.py:464", oneLaunch,
    "sm.RemoteSvc('planetMgr').DeleteLaunch(launchID), by name: Remove on a launch in the journal's list, which the client then asks for afresh. No recording has one."),
  "planetMgr.UserLaunchCommodities": Object.freeze({
    status: "same",
    source: `${CLIENT_PLANET}:412`,
    note: "remoteHandler.UserLaunchCommodities(commandPinID, commoditiesToLaunch), on the planet's own object: the commodities a dict of quantities by type.",
    shape: (args, kwargs) => {
      if (args.length !== 2) return { args, kwargs, status: "differs", note: "The client sends two: the command center's pin, and a dict of the quantities to launch by type." };
      const commodities = quantitiesByType(args[1]);
      return commodities === args[1] ? { args, kwargs } : { args: [args[0], commodities], kwargs, status: "reshaped" };
    },
  }),
  "planetMgr.UserTransferCommodities": Object.freeze({
    status: "same",
    source: `${CLIENT_PLANET}:448`,
    note: "remoteHandler.UserTransferCommodities(path, commodities), on the planet's own object: the path a list of pins from the one the commodities leave to the one they reach, the commodities a dict of quantities by type.",
    shape: (args, kwargs) => {
      if (args.length !== 2) return { args, kwargs, status: "differs", note: "The client sends two: the path, a list of pins, and a dict of the quantities to move by type." };
      const path = list(args[0]);
      const commodities = quantitiesByType(args[1]);
      return path === args[0] && commodities === args[1] ? { args, kwargs } : { args: [path, commodities], kwargs, status: "reshaped" };
    },
  }),
  "invbroker.FitFitting": needing(Object.freeze({
    status: "same",
    source: `${FITTING_SVC}:618`,
    note: "shipInv.FitFitting(activeShipID, shipTypeID, itemsToFit, session.stationid or session.structureid, fittingObjKeyVal, cargoItemsByType, fitRigs), on the ship's own inventory: the items a defaultdict(set) of the hangar's by type, the fitting a util.KeyVal of six dicts (shipfitting/fitting.py 119). The wire forms of the defaultdict and its sets are worked out from how Python reduces each and from what this server reads and sends: no recording has them.",
    shape: (args, kwargs, context) => {
      if (args.length !== 7) return { args, kwargs, status: "differs", note: "The client sends seven: the ship, its type, the items to fit, where the pilot is docked, the fitting, the cargo, and whether to fit rigs." };
      const [shipID, givenType, items, locationID, fitting, cargo, fitRigs] = args;
      const ownType = context && context.shipID === shipID && typeof context.shipTypeID === "function" ? context.shipTypeID() : null;
      const shipTypeID = givenType ?? ownType ?? null;
      const shaped = [shipID, shipTypeID, itemsToFit(items), locationID, fittingKeyVal(fitting), quantitiesByType(cargo), Boolean(fitRigs)];
      if (shipTypeID === null) return { args: shaped, kwargs, status: "differs", note: "The client names the type of the ship it fits. This call names none, and the ship is not the one the pilot is in." };
      const asGiven = shaped.every((value, at) => value === args[at]);
      return asGiven ? { args, kwargs } : { args: shaped, kwargs, status: "reshaped" };
    },
    // The ship's type is godma's word for the ship the pilot is in.
  }), "dogma"),
  "invbroker.Add": judged(
    `${INV_CONTROLLERS}:213`,
    // Add(itemID, sourceLocationID, qty=quantity, flag=self.locationFlag): both keywords, always. The quantity is
    // the stack's size when the whole stack moves (_AddItem: quantity = item.stacksize, from the item the client's
    // inventory cache holds). A call with none is given it from what the pilot's own listings hold of the item.
    (args, kwargs, context) => {
      if (kwargs.qty !== undefined && kwargs.qty !== null) return { status: "same" };
      const size = context && context.stackSize ? context.stackSize(args[0]) : null;
      return size === null
        ? { status: "differs", note: "The client always sends qty, the stack's size when the whole stack moves. This call has none, and the item is in no listing the pilot holds." }
        : { kwargs: { ...kwargs, qty: size }, status: "reshaped" };
    },
    "Add(itemID, sourceLocationID, qty=, flag=)",
  ),
  "invbroker.MultiAdd": reshaped(
    `${INV_CACHE}:1058`,
    // self.moniker.MultiAdd(list(nonCharges), sourceID, **kw): the item IDs are a list.
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "MultiAdd([itemIDs], sourceID, flag=)",
  ),
  "invbroker.StackAll": same(`${INV_CONTROLLERS}:387`, "StackAll(locationFlag), or StackAll()"),

  // ── an agent (a bound agentMgr object) ────────────────────────────────────
  "agentMgr.DoAction": same(`${AGENT_WINDOW}:428`, "DoAction(actionID)"),
  "agentMgr.GetMissionBriefingInfo": same(`${AGENTS}:750`, "no arguments"),
  "agentMgr.GetMissionObjectiveInfo": same(`${AGENT_WINDOW}:222`, "no arguments when the dialogue opens; the job board's page of a mission adds ignoreLocateCheck=True (jobboard/client/features/agent_missions/job.py:413)"),
  "agentMgr.GetAgentLocationWrap": same(`${AGENT_WINDOW}:276`, "no arguments"),
  "agentMgr.RemoveOfferFromJournal": same(`${AGENTS}:783`, "GetAgentMoniker(agentID).RemoveOfferFromJournal(), no arguments, on the agent's bound object"),
  "agentMgr.GetMissionJournalInfo": differs(`${AGENTS}:747`, "The client sends (charID, contentID). The BFF sends nothing."),

  // ── the scanner (the scan manager a service call answers with, and the dogma location) ─────────────
  "beyonce.GetFormations": same("eve/client/script/remote/michelle.py:324", "RemoteSvc('beyonce').GetFormations(), no arguments, by name, as the ballpark is made. Recorded on Tranquility so."),
  "beyonce.CmdWarpToStuffAutopilot": same("eve/client/script/parklife/autopilot.py:465", "GetRemotePark().CmdWarpToStuffAutopilot(destinationID): the autopilot's warp, on the ballpark's object. Recorded on Tranquility with the one ID."),
  "beyonce.CmdWarpToStuff": same("eve/client/script/remote/michelle.py:737", "bp.CmdWarpToStuff(subject, subjectID, minRange=...), on the ballpark's object: 'item' and the thing's ID from the menu (movementFunctions.py 452), 'char' for a fleet member, 'bookmark' for a bookmark, 'launch' and a launch's ID with no range for a planetary launch (journal.py 453). Recorded on Tranquility as ('item', itemID, minRange=0)."),
  "beyonce.CmdDock": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:517", "bp.CmdDock(itemID, session.shipid), on the ballpark's object, through sessionMgr.PerformSessionChange('dock', ...). Recorded on Tranquility with the two IDs."),
  "beyonce.CmdFollowBall": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:302", "bp.CmdFollowBall(targetID, range), on the ballpark's object: the menu's approach with const.approachRange, keep at range with the pilot's distance (229), the autopilot's with 0.0 (autopilot.py 437). Recorded on Tranquility as (itemID, 50)."),
  "beyonce.CmdOrbit": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:260", "bp.CmdOrbit(targetID, range), on the ballpark's object: the range a float under 10 m and a whole number from there (243). Recorded on Tranquility as (itemID, 1000) and (itemID, 5000), with nothing before it."),
  "beyonce.CmdStop": same("eve/client/script/ui/eveCommands.py:1104", "bp.CmdStop(), no arguments, on the ballpark's object. Recorded on Tranquility so."),
  "beyonce.CmdSetSpeedFraction": same("eve/client/script/parklife/autopilot.py:434", "park.CmdSetSpeedFraction(1.0), on the ballpark's object, before the autopilot's approach; the ship's panel sends the pilot's own fraction (activeShipController.py 227). Recorded on Tranquility as (1.0). The menu's approach, keep at range and orbit send none before theirs, and on the game port the BFF's routes send none either; through the gateway they do."),
  "scanMgr.GetFullState": same("eve/client/script/parklife/sensorSuiteService.py:718", "scanSvc.GetScanMan().GetFullState(), no arguments, on the system's scan manager: the object GetSystemScanMgr() answers. Recorded on Tranquility on that object."),
  "scanMgr.GetSystemScanMgr": same(`${SCAN_SVC}:115`, "no arguments"),
  "scanMgr.RequestScans": reshaped(
    `${SCAN_SVC}:195`,
    (args, kwargs) => ({ args: [scanProbes(args[0])], kwargs }),
    "RequestScans({probeID: probe}), each probe a util.KeyVal, or RequestScans(None). The client's probes also carry the scanBonuses the server sent; a route's do not.",
  ),
  "scanMgr.RecoverProbes": reshaped(
    `${SCAN_SVC}:341`,
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "RecoverProbes([probeID, ...]): a list",
  ),
  "scanMgr.DestroyProbe": same(`${SCAN_SVC}:266`, "DestroyProbe(probeID)"),
  "scanMgr.ReconnectToLostProbes": same(`${SCAN_SVC}:279`, "no arguments"),
  "scanMgr.SetActivityState": reshaped(
    `${SCAN_SVC}:426`,
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "SetActivityState([probeID, ...], True or False): a list",
  ),
  "scanMgr.SetProbeDestination": webOnly(`${SCAN_SVC}:169`, "The client keeps a probe's destination itself and sends it with the next RequestScans."),
  "scanMgr.SetProbeRangeStep": webOnly(`${SCAN_SVC}:173`, "The client keeps a probe's range step itself and sends it with the next RequestScans."),
  "scanMgr.ConeScan": same("eve/client/script/parklife/directionalScanSvc.py:47", "ConeScan(scanAngle, scanRange, x, y, z)"),
  "dogmaIM.GetAllInfo": Object.freeze({
    status: "same",
    source: `${GODMA}:2409`,
    note: "GetDogmaLM().GetAllInfo(primeCharacter, primeShip, primeStructure): three positional, each saying whether that one is to be primed. Asked with fewer, it goes out as godma's first priming does: (True, True, None)",
    shape: (args, kwargs) => (args.length === 3 ? { args, kwargs } : { args: [true, true, null], kwargs, status: "reshaped" }),
  }),
  "dogmaIM.ItemGetInfo": judged(
    `${GODMA}:1649`,
    (args) => (args.length === 1 && args[0] !== null && args[0] !== undefined ? { status: "same" } : { status: "differs", note: "The client always names the item: ItemGetInfo(itemID). Asked with none, the server answers for the ship; the client never asks so." }),
    "GetDogmaLM().ItemGetInfo(itemID)",
  ),
  "dogmaIM.GetTargeters": same(`${GODMA}:2364`, "GetDogmaLM().GetTargeters(), no arguments"),
  "dogmaIM.GetLayerDamageValuesByItems": differs(`${DRONE_DAMAGE}:38`, "The client sends a set of the drones in the bay whose damage it does not know, and does not ask at all when there are none. The BFF sends a list, and sends it empty."),
  "dogmaIM.GetDroneSettingAttributes": webOnly(`${GODMA}:2357`, "The client never asks this: godma keeps the drone settings that GetAllInfo brought, and answers from those."),
  "dogmaIM.GetCharacterAttributes": webOnly(`${SKILL_SVC}:224`, "The client never asks dogma for these: its skills service asks the skill handler (GetSkillHandler().GetAttributes())."),
  "dogmaIM.GetRequiredSkillLevels": webOnly(`${DEV_TOOLS}/dna.py:584`, "Only a developer's tool in the client asks this (RemoteSvc('dogmaIM').GetRequiredSkillLevels(typeID), by the service's name). The client proper has a type's required skills in its own static data."),
  "dogmaIM.QueryAllAttributesForItem": webOnly(`${DEV_TOOLS}/svc_dgmattr.py:220`, "Only a developer's tool in the client asks this (GetServerDogmaLM().QueryAllAttributesForItem(itemID))."),
  "dogmaIM.QueryAttributeValue": needing(webOnly(`${CLIENT_OWN_DOGMA}:1722`, "The client never asks the server this. Its own dogma location works an attribute's value out, from what GetAllInfo and the server's notices brought. The transport answers from what godma holds of an item it was told of, and asks the server only of one it was not."), "dogma"),
  "dogmaIM.GetLocationInfo": webOnly("dogma/items/baseDogmaItem.py:58", "The client never asks the server this. Its own dogma items know their owner, place and flag."),
  "agentMgr.GetAgents": same(`${AGENTS}:92`, "RemoteSvc('agentMgr').GetAgents(), no arguments: the whole table, kept for the session"),
  "agentMgr.GetMyJournalDetails": same(`${JOURNAL_WINDOW}:312`, "RemoteSvc('agentMgr').GetMyJournalDetails(), no arguments"),
  "standingMgr.GetCharStandings": same(`${STANDING_SVC}:119`, "RemoteSvc('standingMgr').GetCharStandings(), no arguments"),
  "standingMgr.GetCorpStandings": same(`${STANDING_SVC}:126`, "RemoteSvc('standingMgr').GetCorpStandings(), no arguments, and only for a pilot whose corporation is not an NPC one (118)"),
  "standingMgr.GetStandingTransactions": ofAnEntity(`${STANDING_SVC}:178`, "RemoteSvc('standingMgr').GetStandingTransactions(fromID, toID): the entity, then the character. The panel asks it for a row that is the character's (standingsPanel.py 108), and the client keeps the answer for the two until the standing changes"),
  "standingMgr.GetStandingCompositions": ofAnEntity(`${STANDING_SVC}:283`, "RemoteSvc('standingMgr').GetStandingCompositions(fromID, toID): the entity, then the corporation. The panel asks it for a row that is the corporation's (standingsPanel.py 111); on Tranquility, GetStandingCompositions(500001, the corporation)"),
  // ── a station, its guests, the map's stations, a structure ────────────────
  "stationSvc.GetStationItemBits": same("eve/client/script/ui/station/base.py:575", "RemoteSvc('stationSvc').GetStationItemBits(), no arguments, while the item it has is not that of the station the session is in; the transport keeps it so (pilotStation.js)"),
  "station.GetGuests": same("eve/client/script/ui/station/base.py:103", "RemoteSvc('station').GetGuests(), no arguments, once for a station and kept, then changed at OnCharNowInStation and OnCharNoLongerInStation (86, 93); the transport keeps it so (pilotStation.js)"),
  "map.GetStationInfo": same("eve/client/script/ui/services/uisvc.py:246", "RemoteSvc('map').GetStationInfo(), no arguments"),
  "structureDirectory.GetStructureInfo": same("eve/client/script/ui/services/structure/structureDirectory.py:38", "RemoteSvc('structureDirectory').GetStructureInfo(structureID), kept by structure"),

  // ── an agent's place and a mission's keywords ─────────────────────────────
  "agentMgr.GetSolarSystemOfAgent": same(`${AGENTS}:801`, "RemoteSvc('agentMgr').GetSolarSystemOfAgent(agentID), kept by agent"),
  "agentMgr.GetMissionKeywords": same(`${AGENTS}:633`, "GetAgentMoniker(agentID).GetMissionKeywords(contentID), on the agent's own object"),

  // ── a corporation's assets ────────────────────────────────────────────────
  "corpmgr.GetAssetInventory": same(`${CORP_ASSETS}:100`, "RemoteSvc('corpmgr').GetAssetInventory(session.corpid, which)"),
  "corpmgr.GetAssetInventoryForLocation": same(`${CORP_ASSETS}:423`, "RemoteSvc('corpmgr').GetAssetInventoryForLocation(session.corpid, locationID, which)"),
  "corpmgr.SearchAssets": Object.freeze({
    status: "same",
    source: `${CORP_ASSETS}:752`,
    note: "RemoteSvc('corpmgr').SearchAssets(which, itemCategoryID, itemGroupID, itemTypeID, qty): five positional, and a filter that is not set is None, never nought. Asked when the pilot presses Search.",
    shape: (args, kwargs) => {
      const set = (value) => (typeof value === "number" && value > 0 ? value : null);
      const sent = [args[0] || null, set(args[1]), set(args[2]), set(args[3]), set(args[4])];
      return args.length === sent.length && sent.every((value, index) => value === args[index]) ? { args, kwargs } : { args: sent, kwargs, status: "reshaped" };
    },
  }),

  // ── a character: its sheet, its stations ──────────────────────────────────
  "charMgr.GetPublicInfo3": Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/info/characterInfoWindow.py:194",
    note: "RemoteSvc('charMgr').GetPublicInfo3(itemID): the character named, by the window that shows one. Asked with none, the pilot's own.",
    shape: ofTheCharacter,
  }),
  "charMgr.GetCharacterDescription": Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/neocom/charsheet/bioPanel.py:28",
    note: "RemoteSvc('charMgr').GetCharacterDescription(session.charid): the character named. Asked with none, the pilot's own.",
    shape: ofTheCharacter,
  }),
  "charMgr.GetContactList": same("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:207", "RemoteSvc('charMgr').GetContactList(), no arguments: asked as the character is chosen, beside the corporation's contacts and the watched contacts' online state, and kept"),
  "onlineStatus.GetInitialState": same("eve/client/script/ui/shared/comtool/onlineStatus.py:79", "RemoteSvc('onlineStatus').GetInitialState(), no arguments: asked once (Prime), as the character is chosen, and kept by contact"),
  "onlineStatus.GetOnlineStatus": same("eve/client/script/ui/shared/comtool/onlineStatus.py:56", "RemoteSvc('onlineStatus').GetOnlineStatus(charID), for a character the kept state does not have, and kept"),
  "onlineStatus.Prime": webOnly("eve/client/script/ui/shared/comtool/onlineStatus.py:74", "The client never asks this of the server. Prime is its own service's method, which asks GetInitialState() once."),
  "home_station.get_home_station": same("homestation/client/service.py:67", "RemoteSvc('home_station').get_home_station(), no arguments: asked once and kept, until the server says the home station changed or was moved from its structure, or the pilot's corporation changes. Recorded on Tranquility at a login and after OnHomeStationChanged"),
  "charMgr.GetHomeStationRow": same("eve/client/script/ui/shared/neocom/charactersheet.py:59", "RemoteSvc('charMgr').GetHomeStationRow(), no arguments, asked once and kept until the session is reset"),
  "charMgr.GetHomeStation": webOnly("eve/client/script/ui/shared/neocom/charactersheet.py:59", "The client never asks this of charMgr: its character sheet's service asks GetHomeStationRow()."),
  "charMgr.GetCloneInfo": webOnly("eve/client/script/ui/services/clonejumpsvc.py:76", "The client never asks this. Its jump clones, their implants and the time of the last jump come from GetCloneState() on the jumpCloneSvc moniker for where the pilot is; the implants in the pilot's head are what its skill handler answers GetImplants() with (skillsvc.py 967), which godma's 'implants' of the character hands on."),
  "charMgr.ListStations": same(`${INV_CACHE}:833`, "invCache's global container: self.moniker.ListStations(), no arguments, kept for five minutes"),

  // ── industry ──────────────────────────────────────────────────────────────
  "blueprintManager.GetBlueprintDataByOwner": same(`${INDUSTRY}/blueprintSvc.py:150`, "RemoteSvc('blueprintManager').GetBlueprintDataByOwner(ownerID, None), or with a facility's ID for the blueprints at one (137)"),
  "industryManager.GetJobsByOwner": same(`${INDUSTRY}/industrySvc.py:73`, "RemoteSvc('industryManager').GetJobsByOwner(ownerID, includeCompleted)"),
  "industryManager.GetJobCounts": same(`${INDUSTRY}/industrySvc.py:243`, "RemoteSvc('industryManager').GetJobCounts(session.charid)"),
  "facilityManager.GetFacilities": same(`${INDUSTRY}/facilitySvc.py:133`, "RemoteSvc('facilityManager').GetFacilities(), no arguments"),
  "facilityManager.GetMaxActivityModifiers": same(`${INDUSTRY}/facilitySvc.py:87`, "RemoteSvc('facilityManager').GetMaxActivityModifiers(), no arguments"),

  // ── mail and notifications ────────────────────────────────────────────────
  "mailMgr.SyncMail": same(`${MAIL_SERVICES}/mailSvc.py:157`, "RemoteSvc('mailMgr').SyncMail(firstID, lastID): the lowest and highest message IDs the client holds, (None, 0) when it holds none"),
  "notificationMgr.GetByGroupID": same(`${MAIL_SERVICES}/notificationSvc.py:64`, "RemoteSvc('notificationMgr').GetByGroupID(groupID)"),
  "notificationMgr.GetUnprocessed": same(`${MAIL_SERVICES}/notificationSvc.py:107`, "RemoteSvc('notificationMgr').GetUnprocessed(), no arguments"),
  "notificationMgr.GetAllNotifications": Object.freeze({
    status: "same",
    source: `${MAIL_SERVICES}/notificationSvc.py:93`,
    note: "RemoteSvc('notificationMgr').GetAllNotifications(fromID=fromID): a keyword, nought for all of them",
    shape: (args, kwargs) => (args.length === 0 && "fromID" in kwargs
      ? { args, kwargs }
      : { args: [], kwargs: { ...kwargs, fromID: kwargs.fromID ?? args[0] ?? 0 }, status: "reshaped" }),
  }),

  // ── a fleet's own object: asked only by a pilot who is in the fleet ───────
  "fleetObjectHandler.GetInitState": same(`${FLEET_SVC}:259`, "self.fleet.GetInitState(), no arguments, on the fleet's object"),
  "fleetObjectHandler.GetWings": same(`${FLEET_SVC}:1165`, "self.fleet.GetWings(), no arguments"),
  "fleetObjectHandler.GetMotd": same(`${FLEET_SVC}:1967`, "self.fleet.GetMotd(), no arguments"),
  "fleetObjectHandler.GetJoinRequests": same(`${FLEET_SVC}:461`, "self.fleet.GetJoinRequests(), no arguments"),
  "fleetObjectHandler.GetFleetComposition": same(`${FLEET_SVC}:900`, "self.fleet.GetFleetComposition(), no arguments"),
  // Forming one, joining one and leaving one.
  "fleetObjectHandler.Init": needing(reshaped(`${FLEET_SVC}:336`, fleetInit, "self.fleet.Init(self.GetMyShipTypeID(), setupName, adInfoData=adInfoData), on the object CreateFleet answered"), "dogma"),
  "fleetObjectHandler.AcceptInvite": needing(reshaped(`${FLEET_SVC}:1194`, withOwnShipType, "GetFleet(fleetID).AcceptInvite(self.GetMyShipTypeID()), on the invite's fleet's Moniker, which binds with it and is the fleet's object from then"), "dogma"),
  "fleetObjectHandler.UpdateMemberInfo": needing(reshaped(`${FLEET_SVC}:1807`, withOwnShipType, "self.fleet.UpdateMemberInfo(self.GetMyShipTypeID())"), "dogma"),
  "fleetObjectHandler.RejectInvite": same(`${FLEET_SVC}:1198`, "GetFleet(fleetID).RejectInvite(), and RejectInvite(True) from a pilot already in a fleet (1180), RejectInvite(False) where invitations are turned away unasked (1184)"),
  "fleetObjectHandler.Invite": same(`${FLEET_SVC}:362`, "CSPAChargedAction('CSPAFleetCheck', self.fleet, 'Invite', charID, wingID, squadID, role): self.fleet.Invite(...) on the fleet's object, None for a wing, squad or role not named; asked again with approvedCost= where the server says the contact costs and the user agrees. A pilot in no fleet forms one first (352)"),
  // Its writes.
  "fleetObjectHandler.CreateWing": same(`${FLEET_SVC}:577`, "self.fleet.CreateWing(), no arguments; a wing that was made is given a squad at once (CreateSquad(wingID), 579)"),
  "fleetObjectHandler.CreateSquad": same(`${FLEET_SVC}:589`, "self.fleet.CreateSquad(wingID)"),
  "fleetObjectHandler.MoveMember": same(`${FLEET_SVC}:518`, "self.fleet.MoveMember(charID, wingID, squadID, role)"),
  "fleetObjectHandler.MakeLeader": same(`${FLEET_SVC}:604`, "self.fleet.MakeLeader(charID), once the user has agreed"),
  "fleetObjectHandler.SetMotdEx": same(`${FLEET_SVC}:1961`, "self.fleet.SetMotdEx(motd)"),
  "fleetObjectHandler.KickMember": judged(`${FLEET_SVC}:611`, kickingAnother, "self.fleet.KickMember(charID), for any member but the pilot's own"),
  "fleetObjectHandler.DisbandFleet": judged(`${FLEET_SVC}:617`, disbandingAsBoss, "self.fleet.DisbandFleet(), no arguments, for the fleet's boss"),
  "fleetObjectHandler.SetOptions": reshaped(`${FLEET_SVC}:449`, fleetOptionsCopy, "self.fleet.SetOptions(options): a copy of the options the client keeps, free move changed"),
  "fleetObjectHandler.Reconnect": same(`${FLEET_SVC}:1714`, "GetFleet(fleetID).Reconnect(), no arguments, on a Moniker for the fleet the connection was lost in"),
  "fleetObjectHandler.LeaveFleet": judged(`${FLEET_SVC}:369`, leavingOnTheObject, "self.fleet.LeaveFleet(), no arguments, on the fleet's object"),
  "fleetProxy.ApplyToJoinFleet": judged(`${FLEET_SVC}:1907`, applyingToOneFleet,
    "sm.ProxySvc('fleetProxy').ApplyToJoinFleet(fleetID, autoAccept): from the fleet finder and a fleet's link with False, from the Agency's join window with True. It answers True where the boss must approve and False where an invitation was made. No recording has one."),
  "fleetMgr.BroadcastToBubble": judged(`${FLEET_SVC}:998`, oneBubbleBroadcast,
    "sm.RemoteSvc('fleetMgr').BroadcastToBubble(name, self.broadcastScope, itemID, typeID): the client's broadcasts to its bubble (the three calls for repair, Target and HealTarget), the type left at None, and none sent inside the client's own wait since its last broadcast. No recording has one."),
  "fleetMgr.ForceLeaveFleet": judged(`${FLEET_SVC}:367`, leavingByName, "sm.RemoteSvc('fleetMgr').ForceLeaveFleet(), no arguments: asked only where the client holds no object for a fleet the session is in"),

  // ── contracts, the market and the calendar: the proxy's services ──────────
  "contractProxy.SearchContracts": Object.freeze({
    status: "same",
    source: `${CONTRACT_SEARCH}:1367`,
    note: "ProxySvc('contractProxy').SearchContracts(itemTypes=..., ..., startNum=...): twenty-six keywords, every one every time, None for a filter not set, and no positional arguments. The sort is the choice of the panel's list, which starts on date created, oldest first (on price, lowest first, for auctions and exchanges together). The client's panel starts on the current region; a search with no locationID is its All Regions. For a search that is not for couriers the client sends the 'exclude multiple' tick as a bool: nothing here searches those yet.",
    shape: (args, kwargs) => {
      // PopulateSortCombo (267): the saved choice, or the list's first; (SORT_PRICE, 0) for auctions and exchanges together.
      const startsOn = kwargs.contractType === CONTYPE_AUCTION_AND_ITEM_EXCHANGE ? CONTRACT_SORT_PRICE : CONTRACT_SORT_ID;
      const unset = { sortBy: startsOn, sortDir: 0, startNum: 0 };
      const sent = {};
      for (const name of CONTRACT_SEARCH_KEYWORDS) sent[name] = kwargs[name] ?? unset[name] ?? null;
      const whole = args.length === 0 && Object.keys(kwargs).length === CONTRACT_SEARCH_KEYWORDS.length && CONTRACT_SEARCH_KEYWORDS.every((name) => kwargs[name] === sent[name]);
      return whole ? { args: [], kwargs: sent } : { args: [], kwargs: sent, status: "reshaped" };
    },
  }),
  "contractProxy.GetLoginInfo": same(`${CONTRACTS_SVC}:191`, "GetContractProxySvc().GetLoginInfo(), no arguments. The client asks once, when its notifications are ready, for the Neocom's blink; the page asks with every opening of its panel."),
  "contractProxy.GetMyExpiredContractList": same(`${CONTRACTS_SVC}:748`, "ProxySvc('contractProxy').GetMyExpiredContractList(False), and (True) for the corporation's straight after: the client asks the two together and keeps them."),
  "contractProxy.GetContractListForOwner": Object.freeze({
    status: "same",
    source: `${CONTRACT_PANELS}:419`,
    note: "ProxySvc('contractProxy').GetContractListForOwner(ownerID, status, contractType, issuedBy, num=100, startContractID=...): the My Contracts panel's list, asked when the panel opens and when its button is pressed, for the status its filter is on. Recorded on Tranquility as (charID, 0, None, None), num=100, startContractID=None.",
    shape: ownersContracts,
  }),
  "crimewatch.GetClientStates": same(`${CRIMEWATCH_SVC}:89`, "CharGetCrimewatchLocation().GetClientStates(), no arguments, on a moniker made for the call. Recorded on Tranquility as the call a bind of crimewatch carried."),
  "crimewatch.SetSafetyLevel": judged(`${CRIMEWATCH_SVC}:343`, oneSafetyLevel,
    "CharGetCrimewatchLocation().SetSafetyLevel(safetyLevel): one of the three levels, from the safety button's selector, at once for a level no lower than the one now and after its Confirm for a lower one (shipSafetyButton.py 464, 660). The service keeps the level it set and asks nothing. In none of the recordings."),
  "crimewatch.GetMySecurityStatus": same(`${CRIMEWATCH_SVC}:592`, "CharGetCrimewatchLocation().GetMySecurityStatus(), no arguments: asked once and kept. Recorded on Tranquility as the call a bind of crimewatch carried."),
  "crimewatch.GetCharacterSecurityStatus": same(`${CRIMEWATCH_SVC}:596`, "CharGetCrimewatchLocation().GetCharacterSecurityStatus(charID)"),
  "crimewatch.GetSecurityStatusTransactions": same(`${CRIMEWATCH_SVC}:603`, "CharGetCrimewatchLocation().GetSecurityStatusTransactions(), no arguments"),
  "subscriptionMgr.GetCloneGrade": same("omega/client/clone_grade_svc.py:125", "sm.RemoteSvc('subscriptionMgr').GetCloneGrade(), no arguments: asked as the account comes onto the session (gameui.py 450) and kept; then what OnSubscriptionChangedServer says. In this server's log of a retail client's login it is the call before the character selection's."),
  "userSvc.GetMultiCharactersTrainingSlots": judged("eve/client/script/ui/services/skillQueueSvc.py:851", sentWithNothing,
    "sm.RemoteSvc('userSvc').GetMultiCharactersTrainingSlots(), no arguments: the account's extra training slots, a dict. The queue service reckons from it whether every slot is used (IsAllCharacterTrainingSlotsUsed, 859) and keeps that until OnMultipleCharactersTrainingUpdated. Recorded on Tranquility at every login, answering {}."),
  "skillMgr2.GetMySkillHandler": same(`${SKILL_SVC}:130`, "session.ConnectToRemoteService('skillMgr2').GetMySkillHandler(), no arguments: asked once and the moniker it answers kept."),
  "skillHandler.GetSkills": same(`${SKILL_SVC}:136`, "GetSkillHandler().GetSkills(), no arguments"),
  "skillHandler.GetAllSkills": same(`${SKILL_SVC}:142`, "GetSkillHandler().GetAllSkills(), no arguments"),
  "skillHandler.GetAttributes": same(`${SKILL_SVC}:224`, "GetSkillHandler().GetAttributes(), no arguments"),
  "skillHandler.AbortTraining": same(`${SKILL_SVC}:796`, "GetSkillHandler().AbortTraining(), no arguments: the queue panel's pause, pressed while a skill is in training. The queue is kept, and the server's OnServerSkillsChanged says it is paused"),
  "skillHandler.ApplyFreeSkillPoints": judged(`${SKILL_SVC}:886`, pointsForOneSkill,
    "GetSkillHandler().ApplyFreeSkillPoints(skillTypeID, pointsToApply): free points put into one skill, from the skill's own menu (skillQueueSvc.UseFreeSkillPoints, 926). The service has the free points first, sends nothing for a skill in training, one not known, or no points, and takes what the handler answers for the free points left."),
  "skillHandler.SaveNewQueue": judged(
    "eve/client/script/ui/services/skillQueueSvc.py:153",
    queueByPlace,
    "GetSkillHandler().SaveNewQueue({place: (typeID, toLevel)}, activate=activate): the whole queue, and whether it is to be started. The queue service says True for each change it commits, and False where every training slot of the account is used by its other characters (OnClientQueueModified, 389); the panel's start button says True. Recorded on Tranquility, with the queue asked for again after it.",
  ),
  "skillHandler.GetSkillHistory": reshaped(
    `${SKILL_SVC}:363`,
    (args, kwargs) => (args.length === 1 && args[0] > 0 ? { args, kwargs, status: "same" } : { args: [SKILL_HISTORY_ASKED], kwargs }),
    "GetSkillHandler().GetSkillHistory(maxresults): always with how many, 50 where the asker does not say. Asked once and kept until a skill changes; the notifications ask first, for 10, when the character is chosen.",
  ),
  "skillHandler.GetSkillChangesForISIS": same(`${SKILL_SVC}:379`, "GetSkillHandler().GetSkillChangesForISIS(), no arguments"),
  "skillHandler.GetRespecInfo": same(`${SKILL_SVC}:802`, "GetSkillHandler().GetRespecInfo(), no arguments"),
  "skillHandler.GetFreeSkillPoints": same(`${SKILL_SVC}:852`, "GetSkillHandler().GetFreeSkillPoints(), no arguments"),
  "skillHandler.GetBoosters": same(`${SKILL_SVC}:962`, "GetSkillHandler().GetBoosters(), no arguments: asked once and kept. Recorded on Tranquility as the call the handler's bind carried."),
  "skillHandler.GetImplants": same(`${SKILL_SVC}:967`, "GetSkillHandler().GetImplants(), no arguments: the implants in the pilot's head, asked once and kept (godma's 'implants' of the character is this). Recorded on Tranquility at login."),
  "skillHandler.GetSkillPoints": same(`${SKILL_SVC}:989`, "GetSkillHandler().GetSkillPoints(), no arguments"),
  "skillHandler.GetSkillQueueAndFreePoints": same("eve/client/script/ui/services/skillQueueSvc.py:117", "GetSkillHandler().GetSkillQueueAndFreePoints(), no arguments: the queue service's priming (PrimeSkillQueue), asked once; the queue is kept, and kept right by the server's notices"),
  "contractProxy.AcceptContract": judged(`${CONTRACTS_SVC}:422`, oneContractForWhom,
    "GetContractProxySvc().AcceptContract(contractID, forCorp): the contract and whether it is taken on for the corporation, from the details window's two buttons (contractsDetailsWnd.py 516, 528) once the service has asked the pilot (contracts.py 345 to 420). It answers the contract's row. Recorded on Tranquility with (contractID, False), answering a DBRow."),
  "contractProxy.GetContract": judged(
    `${CONTRACTS_SVC}:336`,
    (args) => (args.length === 1 && args[0] > 0 ? { status: "same" } : { status: "differs", note: "The client names the one contract and nothing else: GetContract(contractID)." }),
    "GetContractProxySvc().GetContract(contractID): one contract in full, which the client keeps for five minutes. Recorded on Tranquility with the ID alone.",
  ),
  "contractProxy.GetMyCurrentContractList": webOnly(`${CONTRACTS_SVC}:784`, "The client's contracts service has a wrapper for this that nothing in the client calls. Its My Contracts panel lists with GetContractListForOwner(ownerID, status, contractType, issuedBy, num=100, startContractID=...) (contractPanels.py 419)."),
  "marketProxy.GetCharOrders": same(`${MARKET_QUOTE}:389`, "GetMarketProxy().GetCharOrders(), no arguments"),
  "marketProxy.GetMarketOrderHistory": same(`${MARKET_QUOTE}:395`, "GetMarketProxy().GetMarketOrderHistory(), no arguments"),
  "marketProxy.GetCharEscrow": same(`${MARKET_QUOTE}:401`, "GetMarketProxy().GetCharEscrow(), no arguments"),
  "marketProxy.GetOrders": same(`${MARKET_QUOTE}:734`, "GetMarketProxy().GetOrders(typeID): a type's book, which the object cache keeps and OnOwnOrdersChanged names"),
  "marketProxy.GetOldPriceHistory": same(`${MARKET_QUOTE}:338`, "GetMarketProxy().GetOldPriceHistory(typeID): the first half of a type's price history, which the client joins to the other (GetHistoryRowList, 344)"),
  "marketProxy.GetNewPriceHistory": same(`${MARKET_QUOTE}:339`, "GetMarketProxy().GetNewPriceHistory(typeID): the second half of a type's price history, asked right behind the first"),
  "marketProxy.PlaceBuyOrder": needing(Object.freeze({
    status: "same",
    source: `${MARKET_QUOTE}:266`,
    note: "GetMarketProxy().PlaceBuyOrder(stationID, typeID, price, quantity, orderRange, minVolume, duration, useCorp, expectedBrokersFee): nine, the last the broker's fee the client's window showed (buyThisTypeWindow.py 701).",
    shape: (args, kwargs, context) => {
      if (args.length !== 9) return { args, kwargs, status: "differs", note: "The client sends nine, the last of them the broker's fee its window showed." };
      if (typeof args[8] === "number") return { args, kwargs };
      const rate = brokersFeeOf(context, args[0]);
      return rate === null
        ? { args, kwargs, status: "differs", note: "The client names the broker's fee rate its window showed, and the server holds the order to it. This call names none, and it could not be worked out for this station." }
        : { args: [...args.slice(0, 8), rate], kwargs, status: "reshaped" };
    },
  }), "fee"),
  "marketProxy.PlaceMultiSellOrder": needing(Object.freeze({
    status: "same",
    source: `${MARKET_QUOTE}:276`,
    note: "GetMarketProxy().PlaceMultiSellOrder(itemList, useCorp, duration, expectedBrokersFee) (sellMulti.py 462): a list of the items, each a util.KeyVal of eight fields (sellMulti.py 501), and the broker's fee rate the window showed, or None for a sale at once.",
    shape: (args, kwargs, context) => {
      const [given, useCorp, duration, named] = args;
      const listed = Array.isArray(given) ? given : given && given.type === "list" && Array.isArray(given.items) ? given.items : null;
      const items = listed ? listed.map((item) => saleItem(item, (stationID) => brokersFeeOf(context, stationID), (typeID) => averagePriceOf(context, typeID))) : [];
      if (args.length !== 4 || items.length === 0 || items.includes(null)) {
        return { args, kwargs, status: "differs", note: "The client sends four: a list of the items, each a util.KeyVal, whether it is for the corporation, for how long, and the broker's fee rate. This is not that." };
      }
      // sellMulti.py 444: for an order that stands, the rate the call names is the first item's.
      const fee = duration !== 0 && typeof named !== "number" && typeof items[0].rate === "number" ? items[0].rate : named;
      const asGiven = !Array.isArray(given) && fee === named && items.every(({ item }, at) => item === listed[at]);
      const shaped = asGiven ? args : [{ type: "list", items: items.map(({ item }) => item) }, useCorp, duration, fee];
      const lacking = SALE_ITEM.filter((name) => items.some(({ has }) => !has.includes(name)));
      if (lacking.length > 0) {
        const what = { delta: "how far the price is from the type's average (delta)", rawBrokerFeePercentage: "the broker's fee rate (rawBrokerFeePercentage)" };
        return { args: shaped, kwargs, status: "differs", note: `The client's item has eight fields. These lack what its window works out: ${lacking.map((name) => what[name] ?? name).join(", and ")}.` };
      }
      if (duration !== 0 && typeof fee !== "number") return { args: shaped, kwargs, status: "differs", note: "For an order that stands, the client names the broker's fee rate its window showed. This call names none." };
      return asGiven ? { args, kwargs } : { args: shaped, kwargs, status: "reshaped" };
    },
  }), "sale"),
  "marketProxy.CancelCharOrder": needing(Object.freeze({
    status: "same",
    source: `${MARKET_QUOTE}:282`,
    note: "GetMarketProxy().CancelCharOrder(order.orderID, order.regionID) (quote.py 302): both off the order's own row in the pilot's orders, which the client has before it touches one.",
    shape: ([given, ...rest], kwargs, context) => {
      const orderID = orderNumber(given);
      if (orderID === null) return { args: [given, ...rest], kwargs, status: "differs", note: "The client names an order by the number its row has. This is no order's number." };
      const row = ownOrderRow(context, orderID);
      if (row && row.regionID !== undefined) {
        const clients = [row.orderID, row.regionID];
        return sameValues(clients, [given, ...rest]) ? { args: clients, kwargs } : { args: clients, kwargs, status: "reshaped" };
      }
      const args = [orderID, ...rest];
      if (!(typeof rest[0] === "number" && Number.isSafeInteger(rest[0]) && rest[0] > 0)) return { args, kwargs, status: "differs", note: "The client names the region the order is in, off the order's row. This call names none, and the order is in no list of the pilot's orders the session holds." };
      return orderID === given ? { args, kwargs } : { args, kwargs, status: "reshaped" };
    },
  }), "orders"),
  "marketProxy.ModifyCharOrder": needing(Object.freeze({
    status: "same",
    source: `${MARKET_QUOTE}:288`,
    note: "GetMarketProxy().ModifyCharOrder(order.orderID, newPrice, order.bid, order.stationID, order.solarSystemID, order.price, order.range, order.volRemaining, order.issueDate): nine, all but the new price off the order's own row.",
    shape: ([given, ...rest], kwargs, context) => {
      const orderID = orderNumber(given);
      if (orderID === null) return { args: [given, ...rest], kwargs, status: "differs", note: "The client names an order by the number its row has. This is no order's number." };
      const row = ownOrderRow(context, orderID);
      const sevenOfTheRow = row ? ["bid", "stationID", "solarSystemID", "price", "range", "volRemaining", "issueDate"].map((name) => row[name]) : [];
      if (rest.length >= 1 && sevenOfTheRow.length === 7 && sevenOfTheRow.every((value) => value !== undefined)) {
        const clients = [row.orderID, rest[0], ...sevenOfTheRow];
        return sameValues(clients, [given, ...rest]) ? { args: clients, kwargs } : { args: clients, kwargs, status: "reshaped" };
      }
      const args = [orderID, ...rest];
      if (rest.length !== 8) return { args, kwargs, status: "differs", note: "The client sends nine: the order's number, the new price, and seven more off the order's row." };
      const issued = rest[7];
      if (!((typeof issued === "bigint" && issued > 0n) || (typeof issued === "number" && issued > 0) || (issued && typeof issued === "object"))) {
        return { args, kwargs, status: "differs", note: "The client sends the order's own date of issue. This call has none." };
      }
      return orderID === given ? { args, kwargs } : { args, kwargs, status: "reshaped" };
    },
  }), "orders"),
  "marketProxy.CharGetTransactions": Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/marketSvc.py:23",
    note: "GetMarketProxy().CharGetTransactions(fromDate), and the date is None wherever the client asks (marketTransactionsPanel.py 161, transactionOverviewController.py 99): all of them. Nought or nothing goes out as None.",
    shape: (args, kwargs) => {
      if (args.length === 1 && args[0] === null) return { args, kwargs };
      if (args.length === 0 || args[0] === 0) return { args: [null], kwargs, status: "reshaped" };
      return { args, kwargs, status: "differs", note: "The client asks for all of the market's transactions, with None for the date. A date is the web client's own." };
    },
  }),
  "calendarProxy.GetEventList": same(`${CALENDAR_SVC}:239`, "GetCalendarProxy().GetEventList(month, year), kept by month for the session"),
  "calendarProxy.GetEventDetails": judged(`${CALENDAR_SVC}:261`, ofAnOpenedEvent, "GetCalendarProxy().GetEventDetails(eventID, ownerID), kept by event"),
  "calendarMgr.GetResponsesForCharacter": same(`${CALENDAR_SVC}:252`, "RemoteSvc('calendarMgr').GetResponsesForCharacter(), no arguments, asked once and kept"),
  "calendarMgr.GetResponsesToEvent": judged(`${CALENDAR_SVC}:415`, ofAnOpenedEvent, "RemoteSvc('calendarMgr').GetResponsesToEvent(eventID, ownerID)"),
  "account.GetCashBalance": same(`${WALLET_SVC}:41`, "RemoteSvc('account').GetCashBalance(0): nought for the pilot's own wallet"),
  "account.GetEntryTypes": same(`${ACCOUNT_SVC}:101`, "GetAccountMgr().GetEntryTypes(), no arguments, once for the session"),
  "account.GetWalletDivisionsInfo": same(`${ACCOUNT_SVC}:135`, "GetAccountMgr().GetWalletDivisionsInfo(), no arguments, kept five minutes"),
  "account.GetTransactions": Object.freeze({
    status: "same",
    source: `${ACCOUNT_SVC}:116`,
    note: "GetAccountMgr().GetTransactions(accountKey, year, month, isCorp): four positional, the last a bool (False for the pilot's own, with accountingKeyCash)",
    // Whether it is the corporation's is a bool to the client; the BFF's routes have said it with a number.
    shape: ([accountKey, year = null, month = null, isCorp = false], kwargs) => (typeof isCorp === "boolean"
      ? { args: [accountKey, year, month, isCorp], kwargs }
      : { args: [accountKey, year, month, Boolean(isCorp)], kwargs, status: "reshaped" }),
  }),
  "allianceRegistry.GetAlliance": Object.freeze({
    status: "same",
    source: `${ALLIANCE_SVC}/all_cso_alliance.py:51`,
    note: "GetMoniker().GetAlliance(), no arguments, on the alliance's moniker, for the session's own alliance; RemoteSvc('allianceRegistry').GetAlliance(allianceID) by name for any other (53)",
    shape: ofAnAlliance,
  }),
  "allianceRegistry.GetAllianceContacts": same(`${ALLIANCE_SVC}/all_cso.py:243`, "GetMoniker().GetAllianceContacts(), no arguments, on the alliance's moniker: the address book asks it as the character is chosen, for a pilot in an alliance"),
  "allianceRegistry.GetApplications": same(`${ALLIANCE_SVC}/all_cso_applications.py:26`, "GetMoniker().GetApplications(), no arguments, on the alliance's moniker, kept"),
  "allianceRegistry.GetBulletins": same(`${ALLIANCE_SVC}/all_cso.py:231`, "GetMoniker().GetBulletins(), no arguments, on the alliance's moniker, kept for fifteen minutes"),
  "allianceRegistry.GetBills": same(`${ALLIANCE_SVC}/all_cso.py:217`, "GetMoniker().GetBills(), no arguments, on the alliance's moniker, by an accountant"),
  "allianceRegistry.GetPrimeTimeInfo": same(`${ALLIANCE_SVC}/all_cso.py:288`, "GetMoniker().GetPrimeTimeInfo(), no arguments, on the alliance's moniker"),
  "allianceRegistry.GetCapitalSystemInfo": same(`${ALLIANCE_SVC}/all_cso.py:295`, "GetMoniker().GetCapitalSystemInfo(), no arguments, on the alliance's moniker"),
  "allianceRegistry.GetRelationships": same(`${ALLIANCE_SVC}/all_cso_relationships.py:25`, "GetMoniker().GetRelationships(), no arguments, on the alliance's moniker, kept"),
  "allianceRegistry.GetRankedAlliances": same(`${ALLIANCE_SVC}/all_cso_alliance.py:30`, "RemoteSvc('allianceRegistry').GetRankedAlliances(maxLen), by name, kept for five seconds"),
  "corpRegistry.GetAggressionSettings": same("eve/client/script/ui/services/crimewatchSvc.py:615", "GetCorpRegistry().GetAggressionSettings(), no arguments, on the corporation's moniker: asked when the session's corporation changes, the choosing of a character among them, and kept"),
  "corpRegistry.RegisterNewAggressionSettings": same("eve/client/script/ui/shared/neocom/corporation/corp_ui_home.py:634", "GetCorpRegistry().RegisterNewAggressionSettings(not isFFEnabled): the one bool, on the corporation's moniker. What it answers is for the window that asked: the settings the client keeps change by the server's notice"),
  "corpRegistry.GetCorporateContacts": same(`${CORP_SVC}/base_corporation.py:993`, "GetCorpRegistry().GetCorporateContacts(), no arguments, on the corporation's moniker: the address book asks it as the character is chosen, and only for a pilot whose corporation is not an NPC one (991)"),
  "corpRegistry.GetEveOwners": same(`${CORP_SVC}/bco_members.py:136`, "GetCorpRegistry().GetEveOwners(), no arguments, on the corporation's moniker: asked when the session's corporation changes, for its members' names"),
  "corpRegistry.GetMyApplications": same(`${CORP_SVC}/bco_applications.py:72`, "GetCorpRegistry().GetMyApplications(), no arguments, on the corporation's moniker: asked once by the client, which keeps the list and works it over at each OnCorporationApplicationChanged"),
  "corpRegistry.GetCorporation": same(`${CORP_SVC}/bco_corporations.py:49`, "GetCorpRegistry().GetCorporation(), no arguments, on the corporation's moniker"),
  "officeManager.GetCorporationsWithOffices": judged(`${CORP_SVC}/officeManager.py:34`, sentWithNothing, "Moniker('officeManager', stationID).GetCorporationsWithOffices(), no arguments, while it has none for where the session is docked; let go at any OnOfficeRentalChange (71) and out of the station or structure (58, 66); the transport keeps it so (pilots.js, stationOffices). Recorded on Tranquility after an office was rented and after one was given up."),
  "officeManager.GetEmptyOfficeCount": judged(`${CORP_SVC}/officeManager.py:136`, sentWithNothing, "Moniker('officeManager', stationID).GetEmptyOfficeCount(), no arguments, each time the lobby's offices are listed; not asked in a structure (133). Recorded on Tranquility beside the corporations with offices."),
  "officeManager.GetPriceQuote": judged(`${CORP_SVC}/officeManager.py:114`, priceForOwnCorporation, "Moniker('officeManager', stationID).GetPriceQuote(session.corpid), as the lobby's rent button is pressed (dockedUI/offices.py). Recorded on Tranquility: answered a long."),
  "officeManager.RentOffice": judged(`${CORP_SVC}/officeManager.py:117`, rentAtThePrice, "Moniker('officeManager', stationID).RentOffice(cost), the price GetPriceQuote answered, once the player has said yes to it. Recorded on Tranquility: answered None, after the server's two notices of the office."),
  "officeManager.UnrentOffice": judged(`${CORP_SVC}/officeManager.py:122`, sentWithNothing, "Moniker('officeManager', stationID).UnrentOffice(), no arguments, once the player has said yes; the client names the corporation's assets there for its object cache first (121). Recorded on Tranquility: answered None."),
  "officeManager.PrimeOfficeItem": judged(`${CORP_SVC}/officeManager.py:108`, sentWithNothing, "Moniker('officeManager', stationID).PrimeOfficeItem(), no arguments, once for a Moniker, where the corporation has an office in the station (106: isPrimed); the transport asks it once so (pilots.js, officePrimed). Recorded on Tranquility after an office was rented."),
  "officeManager.HasCorpImpoundedItems": judged(`${CORP_SVC}/officeManager.py:143`, sentWithNothing, "Moniker('officeManager', stationID).HasCorpImpoundedItems(), no arguments, where a player's corporation has no office in the station (139 to 142). Recorded on Tranquility after an office was given up."),
  "officeManager.GetMyCorporationsOffices": same(`${CORP_SVC}/officeManager.py:41`, "RemoteSvc('officeManager').GetMyCorporationsOffices(), no arguments, while it has none; let go at OnOfficeRentalChange of the session's corporation (72) and in another corporation (62); the transport keeps it so (pilots.js, KEPT_UNTIL_CHANGED)"),
  "dogmaIM.LaunchProbes": same(`${SCAN_SVC}:494`, "LaunchProbes(moduleID, numProbes)"),
  "ship.Undock": needing(reshaped(`${STATION_SVC}:498`, undocking, "GetShipAccess().Undock(shipID, ignoreContraband, onlineModules={flagID: moduleID}), on the ship object bound for the station"), "dogma"),
  "dogmaIM.Overload": needing(Object.freeze({
    status: "same",
    source: `${GODMA}:2075`,
    note: "GetDogmaLM().Overload(itemID, effectID), on the dogma location bound for where the pilot is: the module, and the ID of its own effect of the overload category, which the module's button finds (shipmodulebutton.py 231). Recorded on Tranquility as Overload(moduleID, 3001).",
    shape: overloading,
  }), "dogma"),
  "dogmaIM.StopOverload": needing(Object.freeze({
    status: "same",
    source: `${GODMA}:2120`,
    note: "GetDogmaLM().StopOverload(itemID, effectID), the same two as Overload. No recording has one.",
    shape: overloading,
  }), "dogma"),
  "dogmaIM.Activate": needing(reshaped(`${MODULE_BUTTON}:1348`, activation, "godma's GetDogmaLM().Activate(itemID, effectName, target, repeats) (godma.py 2062), on the dogma location bound for where the pilot is"), "dogma"),
  "dogmaIM.Deactivate": needing(reshaped(`${GODMA}:2101`, deactivation, "GetDogmaLM().Deactivate(itemID, effectName), on the dogma location bound for where the pilot is"), "dogma"),
  "dogmaIM.GetTargets": same(`${GODMA}:2361`, "GetDogmaLM().GetTargets(), no arguments"),
  "dogmaIM.AddTarget": same(`${TARGET_MGR}:1366`, "GetDogmaLM().AddTarget(targetID)"),
  "dogmaIM.CancelAddTarget": same(`${TARGET_MGR}:1303`, "GetDogmaLM().CancelAddTarget(targetID)"),
  "dogmaIM.RemoveTarget": same(`${TARGET_MGR}:1385`, "GetDogmaLM().RemoveTarget(targetID)"),
  "dogmaIM.SetModuleOnline": same(`${CLIENT_DOGMA}:702`, "SetModuleOnline(the ship the module is in, moduleID)"),
  "dogmaIM.TakeModuleOffline": same(`${CLIENT_DOGMA}:718`, "TakeModuleOffline(the ship the module is in, moduleID)"),
  "dogmaIM.LoadAmmo": reshaped(`${CLIENT_DOGMA}:996`, ([shipID, modules, charges, ...rest], kwargs) => ({ args: [shipID, list(modules), list(charges), ...rest], kwargs }), "LoadAmmo(shipID, [moduleID, ...], [chargeItemID, ...], ammoLocationID): the modules and the charges are lists"),
  "dogmaIM.UnloadAmmo": reshaped(`${CLIENT_DOGMA}:1140`, unloading, "UnloadAmmo(shipID, [moduleID, ...], destination), or UnloadAmmo(shipID, moduleID, destination, quantity) for one module (1127)"),
  "dogmaIM.ShipGetInfo": webOnly(`${GODMA}:2409`, "The client never asks this. What it knows of its ship is in GetAllInfo, which godma is primed from."),
  "dogmaIM.ShipOnlineModules": webOnly(`${GODMA}:697`, "godma has a wrapper for this that nothing in the client calls, and throws its answer away. Which modules are online the client reads from the effects GetAllInfo lists. eve.js answers with the online modules, and the BFF reads that."),
  "ship.LaunchDrones": reshaped(`${EVE_MISC}:29`, launching, "GetShipAccess().LaunchDrones([(itemID, quantity), ...], whoseBehalfID, ignoreWarning): a list of pairs, and None for whose behalf when it is the pilot's own"),
  "ship.ScoopDrone": same(`${DRONE_FUNCTIONS}:195`, "GetShipAccess().ScoopDrone(droneIDs)"),
  "ship.LeaveShip": same(`${STATION_SVC}:248`, "GetShipAccess().LeaveShip(shipID)"),
  "ship.Board": same("eve/client/script/ui/services/menuSvcExtras/menuFunctions.py:209", "GetShipAccess().Board(shipID, session.shipid or session.stationid), through sessionMgr.PerformSessionChange('board', ...). Recorded on Tranquility in space as (shipID, the ship left), the bind carrying it."),
  "slash.SlashCmd": same("eve/client/script/ui/services/menusvc.py:834", "RemoteSvc('slash').SlashCmd(command), by name: what the client's GM menus send. No recording has one."),
  "ship.GetShipConfiguration": reshaped(`${SHIP_CONFIG}:51`, configuration, "GetShipAccess().GetShipConfiguration(shipID)"),
});

/**
 * A call as the retail client sends it.
 *
 * Answers { args, kwargs, status, source, note }. `kwargs` is null when there
 * are none, as the BFF passes it. An unchecked pair comes back untouched.
 */
function retailForm(service, method, args, kwargs, context = {}) {
  const given = { args: Array.isArray(args) ? args : [], kwargs: kwargs && Object.keys(kwargs).length > 0 ? kwargs : null };
  const entry = RETAIL_CALLS[`${service}.${method}`];
  const moniker = madeOnMoniker(service, method);
  const proxy = PROXY_SERVICES.has(service);
  // A call for a moniker the client cannot make, its session lacking what the moniker is for: the client asks
  // nothing. What the BFF asks all the same goes as it was given, by the service's name.
  const needs = Object.hasOwn(MONIKER_NEEDS, service) ? MONIKER_NEEDS[service] : null;
  const lacking = needs !== null && !(context ?? {})[needs.has];
  const made = (form) => (form.moniker && lacking
    ? { ...given, status: "web-only", source: needs.source, note: needs.note, moniker: false, proxy }
    : form);
  if (!entry) return made({ ...given, status: "unchecked", source: null, note: null, moniker, proxy });
  if (typeof entry.shape !== "function") return made({ ...given, status: entry.status, source: entry.source, note: entry.note ?? null, moniker, proxy });
  const shaped = entry.shape(given.args, given.kwargs ?? {}, context ?? {});
  const keywords = shaped.kwargs && Object.keys(shaped.kwargs).length > 0 ? shaped.kwargs : null;
  return made({
    args: shaped.args,
    kwargs: keywords,
    status: shaped.status ?? entry.status,
    source: entry.source,
    note: shaped.note ?? entry.note ?? null,
    moniker: shaped.moniker ?? moniker,
    proxy,
  });
}

/** What the pilot must have before this call can be shaped as the client's: "dogma", or null. */
const retailNeeds = (service, method) => RETAIL_CALLS[`${service}.${method}`]?.needs ?? null;

/**
 * A tally of the calls a process has made, by pair and by how each compared
 * with the retail client: the measured list of what is left to check.
 */
function createCallLedger() {
  const pairs = new Map();
  return {
    note(service, method, form) {
      const key = `${service}.${method}`;
      const row = pairs.get(key) ?? { pair: key, calls: 0, statuses: {}, source: form.source, note: form.note };
      row.calls += 1;
      row.statuses[form.status] = (row.statuses[form.status] ?? 0) + 1;
      if (form.status !== "same" && form.note) row.note = form.note;
      pairs.set(key, row);
    },
    /** Every pair called, most called first. */
    rows() {
      return [...pairs.values()].sort((a, b) => b.calls - a.calls || a.pair.localeCompare(b.pair)).map((row) => ({ ...row, statuses: { ...row.statuses } }));
    },
  };
}

module.exports = { CONTRACT_SEARCH_KEYWORDS, GAME_PORT_ONLY_CALLS, MONIKER_SERVICES, ON_AN_ANSWERED_OBJECT, PROXY_SERVICES, REPEATS, RETAIL_CALLS, TRANSPORT_OWN_CALLS, createCallLedger, list, madeAfresh, madeOnMoniker, retailForm, retailNeeds };
