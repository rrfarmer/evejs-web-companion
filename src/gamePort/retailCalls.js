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

const { isDeepStrictEqual } = require("node:util");
const { constructorKeywordOrder, dictOrder, orderEntries } = require("./py27");
const { NO_OPTIONAL_MATERIAL } = require("../../web/src/bridge/industryReckonings.mjs");

/** A Python list, from a JS array (which would go out as a tuple) or from one already wrapped. */
const list = (value) => (Array.isArray(value) ? { type: "list", items: value } : value);
// Compiled MedalRibbonPickerWindow.SubmitData553-560 builds nested lists.
const medalGraphics = (value) => Array.isArray(value) ? list(value.map(list)) : value?.type === "list" && Array.isArray(value.items) ? { ...value, items: value.items.map(list) } : value;

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
 * A price, a rate or a delta as the client's Python holds it, a float (round(float(price), 2), marketsvc.py 266; a
 * quotient, GetDelta): a whole number given for one would go out an int (clientMarshal.js), and goes as a real.
 */
const asFloat = (value) => (typeof value === "number" && Number.isInteger(value) ? { type: "real", value } : value);

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
  const fields = {
    ...given,
    price: asFloat(Math.round(given.price * 100) / 100),
    officeID: given.officeID ?? null,
    delta: delta === undefined ? undefined : asFloat(delta),
    rawBrokerFeePercentage: rate === undefined ? undefined : asFloat(rate),
  };
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
/** A price as it is handed back: the whole number, or the long of one (its digits) that Tranquility's station answered. */
const isAQuotedPrice = (value) => isAPrice(value)
  || (value !== null && value.type === "long" && typeof value.value === "string" && /^\d+$/.test(value.value));
/** officeManager.RentOffice (117): self.station.RentOffice(cost), the price it was quoted. */
const rentAtThePrice = (args, kwargs) => (args.length === 1 && Object.keys(kwargs).length === 0 && isAQuotedPrice(args[0])
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
/** The Apply Skill Points window's levels (applySkillPointsWindow.py, skillTypeIDsAndLevels): one list of (typeID, level) pairs, and nothing else. */
const levelsListed = (args) => ({
  args: [list((Array.isArray(args[0]) ? args[0] : args[0] && Array.isArray(args[0].items) ? args[0].items : []).map((pair) => (Array.isArray(pair) ? pair : pair && Array.isArray(pair.items) ? pair.items : pair)))],
  kwargs: {},
});
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
/** invCache.ListStationItems (849): self.moniker.ListStationItems(stationID), the one station (or structure) and nothing else. */
const oneStationAlone = (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the one station, by its number, and nothing else: ListStationItems(stationID)." });
/** A thing's number: a whole one above nought. */
const aThingsID = (value) => Number.isSafeInteger(value) && value > 0;
/** A range as it was given: the number, or the number a float was made of. */
const rangeOf = (value) => (value !== null && typeof value === "object" && value.type === "real" ? value.value : value);
/**
 * michelle.CmdWarpToStuff (733 to 738): bp.CmdWarpToStuff(subject, subjectID, **kwargs), on the ballpark's object.
 * What goes with a warp is its caller's, by what the warp is to:
 *
 *   'item'      movementFunctions.WarpToItem (452): minRange=warpRange, the WarpTo distance of the pilot's settings,
 *               a whole number and nought by default (a float where a distance is picked from the menu's list:
 *               menusvc.WarpToMenu, 2259). Recorded on Tranquility so, each with a whole nought. Not for the
 *               pilot's own ship (438). With fleet=False beside it, and the range as the scan result's caller
 *               has it, where the thing is a scan result's own site: an anomaly or a structure the sensor suite
 *               knows (sensorSuiteService 799) is warped to as an item (menusvc 1427). Recorded twice.
 *   'char'      menusvc.WarpToMember (2748): minRange=warpRange and nothing else, the range a float as the fleet's
 *               menu makes it (float(defaultWarpDist), 712). Recorded so, once, with a float's nought.
 *   'bookmark'  movementFunctions.WarpToBookmark (419): minRange=warpRange, a float from the bookmark's menu
 *               (menusvc 1481 to 1483), and fleet=fleet. No recording has one. (A mission's bookmark is not warped
 *               to so: the client asks its agent, WarpToLocation, 416.)
 *   'scan'      menusvc._WarpXToScanResult (1428): minRange=minRange and fleet=fleet, by the result's label where
 *               the sensor suite has no site of its own for it; the range None from the scanner's list
 *               (scannerListEntries 276), a distance from the overlay's bracket. No recording has one.
 *   'launch'    journal.py 453: nothing.
 *
 * The routes send a range for an item every time, for the others only where it is above nought, and `fleet`
 * never. So a warp is given the keywords its caller in the client sends: the range that was said, or the nought
 * (the scanner's None) of one that was not, a float where the client's is one; and fleet=False where the client
 * says it. The transport puts them in a client's order (py27.js).
 *
 * A fleet's warp (fleet=True) goes with the formation's settings (michelle.SetFleetFormationSettings, 755 to 760:
 * fleetFormationSettings, a dict of the formation's type, spacing and size). The page makes one to a fleet member
 * (menusvc.WarpFleetToMember, 2753 to 2760: the fleet's menu for a member, Warp Fleet, Wing or Squad to Member), with
 * the range and the three settings; it goes with minRange as a float, fleet=True and the settings as a dict in the
 * client's order. No recording has one. A fleet's warp to anything else differs, as does any keyword else, a range
 * that is no distance, and a warp to what the routes do not warp to.
 */
const warping = (args, kwargs, context) => {
  const notAClients = (note) => ({ status: "differs", note });
  const [subject, which] = args;
  const said = Object.keys(kwargs);
  if (args.length !== 2 || said.some((name) => name !== "minRange" && name !== "fleet" && name !== "fleetFormationSettings")) {
    return notAClients("The client warps to one thing by what it is and its number, with a range and a fleet's word at most.");
  }
  const range = rangeOf(kwargs.minRange ?? null);
  if (range !== null && !(Number.isFinite(range) && range >= 0)) {
    return notAClients("A warp's range is a distance: a number, nought or more.");
  }
  if ((kwargs.fleet === true || kwargs.fleetFormationSettings !== undefined) && subject !== "char") {
    return notAClients("A fleet's warp goes with the formation's settings (michelle.SetFleetFormationSettings), which nothing here sends but to a fleet member.");
  }
  if (kwargs.fleet !== undefined && kwargs.fleet !== false && kwargs.fleet !== true) {
    return notAClients("A warp's fleet keyword is True or False.");
  }
  // What a caller that cannot say a float said: each keyword, with a float read as its number.
  const asSaid = (keywords) => Object.fromEntries(Object.entries(keywords).map(([name, value]) => [name, rangeOf(value)]));
  // The client's keywords go. Where they are what was said, but for a float the caller could not say (the page's
  // JSON has one kind of number), the call is the client's: a follow's nought is made a float so too. Where a
  // keyword was put in or a range given in place of none, it was reshaped.
  const made = (wanted) => (isDeepStrictEqual(asSaid(wanted), asSaid(kwargs))
    ? { kwargs: wanted }
    : { kwargs: wanted, status: "reshaped", note: "The warp was given the keywords the client's caller for it sends (minRange, and fleet=False where the client says it)." });
  switch (subject) {
    case "item":
      if (!aThingsID(which)) return notAClients("The client warps to a thing by its number.");
      // (A ship that is not known is no number an item's ID can be: the item is above nought.)
      if (Number(context.shipID) === which) return notAClients("The client does not warp to the pilot's own ship: it sends nothing.");
      return made(kwargs.fleet === false ? { minRange: kwargs.minRange ?? null, fleet: false } : { minRange: kwargs.minRange ?? 0 });
    case "char": {
      if (!aThingsID(which)) return notAClients("The client warps to a fleet member by its number, with a range and nothing else.");
      if (kwargs.fleet === undefined && kwargs.fleetFormationSettings === undefined) return made({ minRange: asReal(range ?? 0) });
      // menusvc.WarpFleetToMember: fleet=True, and the formation's three settings beside it.
      const given = kwargs.fleetFormationSettings;
      const settings = given !== null && typeof given === "object" && !Array.isArray(given) ? given : {};
      if (kwargs.fleet !== true || Object.keys(settings).length !== FORMATION_NAMES.length || !FORMATION_NAMES.every((name) => Number.isSafeInteger(settings[name]))) {
        return notAClients("The client warps its fleet to a member with fleet=True and the formation's three settings: CmdWarpToStuff('char', charID, minRange=warpRange, fleet=True, fleetFormationSettings={formationType, formationSpacing, formationSize}).");
      }
      // The settings go as a dict, in the client's order, whatever order they were written in: that is the
      // transport's making, as a page's JSON has no dict, and is no reshaping of what was said.
      const wanted = { minRange: asReal(range ?? 0), fleet: true, fleetFormationSettings: dict(FORMATION_NAMES.map((name) => [name, settings[name]])) };
      return isDeepStrictEqual(asSaid({ minRange: wanted.minRange, fleet: true }), asSaid({ minRange: kwargs.minRange, fleet: kwargs.fleet }))
        ? { kwargs: wanted }
        : { kwargs: wanted, status: "reshaped", note: "The fleet's warp was given the range the client's menu sends, a float." };
    }
    case "bookmark":
      if (!aThingsID(which)) return notAClients("The client warps to a bookmark by its number.");
      return made({ minRange: asReal(range ?? 0), fleet: false });
    case "scan":
      if (typeof which !== "string" || which === "") return notAClients("The client warps to a scan result by its label.");
      return made({ minRange: kwargs.minRange ?? null, fleet: false });
    case "launch":
      if (!aThingsID(which) || said.length > 0) return notAClients("The client warps to a launch by its number, and with nothing else.");
      return {};
    default:
      return notAClients("No route warps to that: an item, a fleet member, a bookmark, a scan result or a launch.");
  }
};
/** autopilot.AP_WarpToDestID (465): GetRemotePark().CmdWarpToStuffAutopilot(destinationID), the one thing and nothing else. */
const autopilotWarping = (args, kwargs) => (args.length === 1 && aThingsID(args[0]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client's autopilot sends the one thing it warps to, by its number, and nothing else." });
/** The three names of a fleet's formation settings, in the order the client's own Python writes its dict of them (the recordings have it so). */
const FORMATION_NAMES = Object.freeze(["formationType", "formationSpacing", "formationSize"]);
/**
 * movementFunctions.WarpToBookmark (414 to 416): GetAgentMoniker(agentID).WarpToLocation(locationType,
 * locationNumber, warpRange, fleet, referringAgentID, GetFormationSettings()), on the agent's own object. Six, and no
 * keyword. Recorded 23 times on Tranquility: ('dungeon', 0, a whole nought or a float's, False, None,
 * {formationType: 0, formationSpacing: 1000, formationSize: 10000}).
 *
 * The settings are a dict, and go as one in the client's order whatever order they were written in. A fleet's
 * warp (fleet=True) is none of a caller's here: it differs, as does what is no type, no whole number, no distance,
 * no agent or None for the other agent, and settings that are not those three numbers.
 */
const agentWarping = (args, kwargs) => {
  const notAClients = { status: "differs", note: "The client sends the location's type and number, a range, False, another agent or None, and its three formation settings: WarpToLocation(locationType, locationNumber, warpRange, False, referringAgentID, settings)." };
  const [locationType, locationNumber, range, fleet, referringAgentID, settings] = args;
  const distance = rangeOf(range);
  const given = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const named = Object.keys(given);
  if (args.length !== 6 || Object.keys(kwargs).length > 0) return notAClients;
  if (typeof locationType !== "string" || locationType === "" || !Number.isSafeInteger(locationNumber)) return notAClients;
  if (!(Number.isFinite(distance) && distance >= 0) || fleet !== false) return notAClients;
  if (!(referringAgentID === null || aThingsID(referringAgentID))) return notAClients;
  if (named.length !== FORMATION_NAMES.length || !FORMATION_NAMES.every((name) => Number.isSafeInteger(given[name]))) return notAClients;
  return { args: [locationType, locationNumber, range, fleet, referringAgentID, dict(FORMATION_NAMES.map((name) => [name, given[name]]))] };
};
/**
 * movementFunctions.ApproachLocation (402): GetAgentMoniker(agentID).GotoLocation(locationType, locationNumber,
 * referringAgentID), on the agent's own object: the location's type and number as the journal has them, and another
 * agent or None. Three, and no keyword.
 */
const agentGoing = (args, kwargs) => {
  const [locationType, locationNumber, referringAgentID] = args;
  return args.length === 3 && typeof locationType === "string" && locationType !== "" && Number.isSafeInteger(locationNumber)
    && (referringAgentID === null || aThingsID(referringAgentID)) && Object.keys(kwargs).length === 0
    ? {}
    : { status: "differs", note: "The client sends the location's type and number and another agent or None: GotoLocation(locationType, locationNumber, referringAgentID)." };
};
/** A judge for a call the client sends with nothing: no argument, and no keyword. */
/**
 * transferMoneyWnd.py Confirm (148): GiveCash(self.toID, amount, reason, toAccountKey=toAccountKey): the one given to,
 * the amount the window's float field holds, the reason its text field's, and the account key by keyword every time,
 * None for a character.
 */
const givingCash = (args, kwargs) => {
  const [toID, amount, reason] = args;
  const said = Object.keys(kwargs);
  // The wallet's Give ISK tab (giveIskPanel.py TransferISK): GiveCash(selectedCharacterID, amount), and nothing else.
  if (args.length === 2 && said.length === 0 && Number.isSafeInteger(toID) && toID > 0 && typeof amount === "number" && amount > 0) {
    const clients = [toID, asFloat(amount)];
    return sameValues(clients, args) ? { args, kwargs } : { args: clients, kwargs, status: "reshaped" };
  }
  if (args.length !== 3 || !(Number.isSafeInteger(toID) && toID > 0) || typeof amount !== "number" || !(amount > 0)
    || typeof reason !== "string" || said.some((name) => name !== "toAccountKey")) {
    return { args, kwargs, status: "differs", note: "The client sends the one given to, the amount, the reason, and the account key by keyword. This is not that." };
  }
  const clients = [toID, asFloat(amount), reason];
  return sameValues(clients, args) && said.length === 1
    ? { args, kwargs }
    : { args: clients, kwargs: { toAccountKey: kwargs.toAccountKey ?? null }, status: "reshaped" };
};
/** A redeem token's key as the redeem window keys it (redeemItemsContainer.py token_key, 401 to 402): its token ID and its mass token ID, which may be None. */
const isRedeemTokenKey = (key) => Array.isArray(key) && key.length === 2 && Number.isSafeInteger(key[0]) && key[0] > 0
  && (key[1] === null || (Number.isSafeInteger(key[1]) && key[1] > 0));
/**
 * redeemsvc.py ClaimRedeemTokens (103): sm.RemoteSvc('userSvc').ClaimRedeemTokens(tokens, charID,
 * useHomeStation=useHomeStation): the tokens a list of (tokenID, massTokenID) tuples (_HandleMctTokens, 198 to 205),
 * one at least; the character the session's own; and the home station by keyword every time, a bool.
 */
const claimingRedeemTokens = (args, kwargs, context) => {
  const [tokens, charID] = args;
  const said = Object.keys(kwargs);
  const keys = Array.isArray(tokens) ? tokens : tokens && tokens.type === "list" && Array.isArray(tokens.items) ? tokens.items : null;
  if (args.length !== 2 || keys === null || keys.length === 0 || !keys.every(isRedeemTokenKey)
    || !(Number.isSafeInteger(charID) && charID > 0) || (context && context.characterID && charID !== context.characterID)
    || said.some((name) => name !== "useHomeStation") || (said.length === 1 && typeof kwargs.useHomeStation !== "boolean")) {
    return { args, kwargs, status: "differs", note: "The client claims a list of (tokenID, massTokenID) for the session's own character, with useHomeStation by keyword. This is not that." };
  }
  const clients = [list(keys.map((key) => [key[0], key[1]])), charID];
  return Array.isArray(tokens) || said.length === 0
    ? { args: clients, kwargs: { useHomeStation: kwargs.useHomeStation === true }, status: "reshaped" }
    : { args: clients, kwargs };
};
const sentWithNothing = (args, kwargs) => (args.length === 0 && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends nothing with this call." });
/** A judge for a call the client sends with one bool and nothing else. */
const oneBoolAlone = (args, kwargs) => (args.length === 1 && typeof args[0] === "boolean" && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends one bool with this call, and nothing else." });
/** Items' IDs as the client's repair shop lists them: whole numbers above nought, and one at least. */
const itemIDsListed = (value) => Array.isArray(value) && value.length > 0 && value.every((each) => Number.isSafeInteger(each) && each > 0);
/** repair.GetRepairQuotes (base_repairshop.py 63): GetRemoteRepairMgr().GetRepairQuotes(itemIDs), the IDs a list. */
const quotingRepairs = (args, kwargs) => (args.length === 1 && itemIDsListed(args[0]) && Object.keys(kwargs).length === 0
  ? { args: [list(args[0])], kwargs }
  : { args, kwargs, status: "differs", note: "The client asks a quote for a list of items, and nothing else." });
/**
 * repair.RepairItems (65 to 67), docked in a station: RepairItemsInStation(itemIDs, payment). The payment is the
 * shop window's amount (300 to 327): the whole cost, the part of it the pilot chose, or 0.0 where nothing is owed.
 * A float always, so a whole number goes as one.
 */
const repairingInAStation = (args, kwargs, context) => {
  if (!(args.length === 2 && itemIDsListed(args[0]) && Number.isFinite(args[1]) && args[1] >= 0 && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client repairs a list of items for one payment, and nothing else." };
  }
  if (context.structureID !== null && context.structureID !== undefined) {
    return { args, kwargs, status: "differs", note: "Docked in a structure the client asks RepairItemsInStructure, with no payment." };
  }
  return { args: [list(args[0]), { type: "real", value: args[1] }], kwargs };
};
/** repair.RepairItems (68 and 69), docked in a structure: RepairItemsInStructure(itemIDs), with nothing paid. */
const repairingInAStructure = (args, kwargs, context) => {
  if (!(args.length === 1 && itemIDsListed(args[0]) && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client repairs a list of items in a structure, and nothing else." };
  }
  if (context.structureID === null || context.structureID === undefined) {
    return { args, kwargs, status: "differs", note: "Docked in a station the client asks RepairItemsInStation, with its payment." };
  }
  return { args: [list(args[0])], kwargs };
};
/** menusvc.py's GM entries and svc_slash.py 522: sm.RemoteSvc('slash').SlashCmd(line), the one line of text. */
const aSlashCommand = (args, kwargs) => (args.length === 1 && typeof args[0] === "string" && args[0] !== "" && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the command's one line of text, and nothing else." });
/** structures.SERVICE_MARKET. */
const STRUCTURE_SERVICE_MARKET = 5;
/**
 * marketsvc.py 239: CharacterGetService(structureID, structures.SERVICE_MARKET), the structure's ID and the market's,
 * and nothing else. Nothing of the client asks it of another service.
 */
const ofAStructuresMarket = (args, kwargs) => (args.length === 2 && Number.isSafeInteger(args[0]) && args[0] > 0 && args[1] === STRUCTURE_SERVICE_MARKET && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client asks one thing of a structure's single service: its market's tax for the pilot, by the structure's ID and the market's (5), and nothing else." });
/** structureGuests.py 25: GetGuests(session.structureid), the structure the session is docked in and nothing else. */
const ofTheStructureDockedIn = (args, kwargs, context) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && args[0] === context.structureID && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client asks for the guests of the structure it is docked in, by its ID, and nothing else." });
/** structureServices.py 35 and 56: CharacterGetServices(structureID), the one structure's ID and nothing else. */
const ofOneStructure = (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client asks for one structure's services, by its ID, and nothing else." });
/**
 * quotes.GetQuotes (reprocessing/ui/quotes.py 20): GetReprocessingSvc().GetQuotes(itemIDs, activeShipID). What the
 * window hands in for the items is its own dict of them, each item's row by the item's ID (inputItemAdder.py 17 to
 * 26 and 94), the rows being the inventory cache's as the server listed them; and the ship is the one the pilot is
 * in (eveCfg.GetActiveShip, by reprocessingWnd.py 749). A call that names the items alone is given each one's row
 * from what the pilot's own listings hold, and the ship from its session. Where a listing has not an item, the
 * items go named alone, and the call is said not to be the client's.
 */
const quotingReprocessing = (args, kwargs, context) => {
  if (!(args.length === 1 && itemIDsListed(args[0]) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client asks a quote for the items in its window, each by its own row, and names the ship the pilot is in." };
  }
  const itemIDs = [...new Set(args[0])];
  const rows = itemIDs.map((itemID) => (context && context.itemRow ? context.itemRow(itemID) : null));
  if (rows.some((row) => row === null)) {
    return { status: "differs", note: "The client hands the quote each item's own row. An item of this call is in no listing the pilot holds, and the items go named alone." };
  }
  return { args: [dict(itemIDs.map((itemID, index) => [itemID, rows[index]])), context.shipID ?? null], status: "reshaped" };
};
/**
 * itemReprocessor.Reprocess and _DoReprocess (reprocessing/ui/itemReprocessor.py 18 to 44 and 71):
 * GetReprocessingSvc().Reprocess(itemIDs, fromLocation, ownerID, outputLocationID, outputFlagID). The items are a
 * list, all of one place. **The output is never left unnamed.** The window's own choice is the hangar of where the
 * pilot is docked (reprocessingWnd.py 344 to 367: the place and the hangar's flag), with the pilot its owner; with
 * "the input's place" chosen the reprocessor names the first item's place, owner and flag itself (31 to 35); a
 * corporation's division has the corporation its owner; and for an output anywhere else the owner is None.
 */
const reprocessingItems = (args, kwargs) => {
  const whole = (value) => Number.isSafeInteger(value) && value > 0;
  const [itemIDs, from, owner, outputLocation, outputFlag] = args;
  if (!(args.length === 5 && itemIDsListed(itemIDs) && whole(from) && (owner === null || whole(owner)) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client reprocesses a list of items of one place, for an owner or none, to a place and a flag, and nothing else." };
  }
  if (!(whole(outputLocation) && whole(outputFlag))) {
    return { status: "differs", note: "The client never leaves the output unnamed: its window names the hangar of where the pilot is docked, or the reprocessor the first item's own place and flag." };
  }
  return { args: [list(itemIDs), from, owner, outputLocation, outputFlag], status: "reshaped" };
};
/** inventorycommon/const.py flagHangar and flagCargo. */
const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;
/**
 * Is an Add the fitting's own unfitting of a module (fittingSlotController.UnfitModule, 238 and 241): a thing in a
 * slot of the pilot's ship. UnloadModuleToContainer1077-1104 also names qty=None
 * with any destination flag, or omits both kwargs for a flagless container such
 * as Trade. Preserve those forms as well as UnfitModule's hangar/cargo forms.
 */
const unfitsAModule = (args, kwargs, context) => {
  if (!context || typeof context.slotOf !== "function" || args.length !== 2 || args[1] !== context.shipID) return false;
  if (context.slotOf(args[0]) === null) return false;
  return !Object.hasOwn(kwargs, "qty")
    ? kwargs.flag === FLAG_HANGAR || !Object.hasOwn(kwargs, "flag")
    : kwargs.qty === null && Object.hasOwn(kwargs, "flag");
};
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
  // eveMoniker.GetEntityAccess() (58): Moniker('entity', session.solarsystemid2), made at each drone order
  // (droneFunctions.py) and not kept. Every one Tranquility has recorded rides its own bind.
  entity: new Set(),
  // repair.GetRemoteRepairMgr (base_repairshop.py 45 to 60): Moniker('repairSvc', (the dockable place, the place,
  // the place's group)), made anew at each use. Nothing of the repair service is asked by its name.
  repairSvc: new Set(),
  // reprocessing.GetReprocessingSvc (reprocessingsvc.py 64 to 69): eveMoniker.GetReprocessingManager(), which is
  // Moniker('reprocessingSvc', session.structureid or session.stationid), kept until the character, the station or
  // the structure changes. Nothing of the reprocessing service is asked by its name.
  reprocessingSvc: new Set(),
  // war_cso.GetMoniker (57 to 67): eveMoniker.GetWar(), which is Moniker('warRegistry', (session.allianceid or
  // session.corpid, 1)), kept until that owner is another's and bound before each use. The client reaches the war
  // registry by nothing else: nothing of it is asked by its name.
  warRegistry: new Set(),
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
  repairSvc: Object.freeze({
    has: "dockedAt",
    source: "eve/client/script/ui/station/repairshop/base_repairshop.py:56",
    note: "The client asks this on a moniker for the station or structure its session is docked in. In space its repair service raises instead of making one, and does not ask.",
  }),
  reprocessingSvc: Object.freeze({
    has: "dockedAt",
    source: "eve/common/script/net/eveMoniker.py:88",
    note: "The client asks this on a moniker for the station or structure its session is docked in. In space the moniker's maker raises instead, and nothing is asked.",
  }),
  entity: Object.freeze({
    has: "solarSystemID",
    source: "eve/common/script/net/eveMoniker.py:58",
    note: "The client orders its drones on a moniker for the system its session is in space in. Docked it cannot make one (GetEntityAccess raises), and orders none.",
  }),
});

/**
 * shipConfigSvc.py 51: eveMoniker.GetShipAccess().GetShipConfiguration(shipID), and baseHangarBehaviours.py 89:
 * eveMoniker.GetShipAccess().GetDirtTimestamp(itemID), each a Moniker of its own each time.
 */
const OWN_SHIP_MONIKER = new Set(["GetShipConfiguration", "GetDirtTimestamp"]);
/**
 * Whether the client makes a new Moniker for this call, which binds carrying it and is not kept, or calls one it
 * keeps. All of crimewatch's are made anew (crimewatchSvc.py: CharGetCrimewatchLocation().Method(...) at each use).
 * The ship's go through gameui.GetShipAccess (gameui.py 228), which makes a new one each time while the session
 * has a station and keeps one otherwise for as long as the system, the ship and the character are the same; a
 * service that makes its own does so wherever the pilot is.
 */
const madeAfresh = (service, method, { dockedInStation = false } = {}) =>
  service === "crimewatch" || service === "planetOrbitalRegistryBroker" || service === "entity" || service === "repairSvc" || (service === "ship" && (dockedInStation || OWN_SHIP_MONIKER.has(method)));
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
 * transport makes it (pilots.js): cfg.eveowners' priming, for the names of players' owners, and cfg.evelocations',
 * for a named item's own name (a ship, a container: uix.GetItemName, IsValidNamedItem), and the
 * corporations' and alliances' tickers', as the client primes them for the balls added and as its overview gets
 * them (cfg.corptickernames, cfg.allianceshortnames); one facility
 * asked for by itself, as the client's facility service asks where the server names it, where a job was refused
 * at it, and where a job is given one that has rig modifiers or is not among the region's; the price table
 * the client's cfg asks for two seconds after it loads; and the chat service's four as it logs in to the chat
 * server (xmppchatclient/xmppchatsvc.py 284, 312, 318, 350): the chat's hostname, the address where the global
 * config names none, the secret, and the system channels to join; and the sites service's two as its lists are
 * populated for the chat's spam check (carbonui/control/browser/sites.py 396, 398): the hash of the flagged
 * sites, and the sites where the hash is not the kept list's.
 */
// (The station's office object's reads are the lobby's, which the gateway never had: see GAME_PORT_ONLY_CALLS.)
const TRANSPORT_OWN_CALLS = Object.freeze([
  "config.GetMultiOwnersEx", "config.GetMultiLocationsEx", "config.GetMultiCorpTickerNamesEx", "config.GetMultiAllianceShortNamesEx", "facilityManager.GetFacility", "config.GetAverageMarketPrices",
  "XmppChatMgr.Hostname", "XmppChatMgr.GetDeprecatedPrefsFallback", "chatAuthenticationService.GetAuthenticationToken", "XmppChatMgr.ResyncSystemChannelAccess",
  "browserLockdownSvc.GetFlaggedSitesHash", "browserLockdownSvc.GetFlaggedSitesList",
  // What a client asks before a character is chosen: the cfg's two as it loads (eveCfg.py 476, 750), whether the
  // AIR tutorial is enabled as the global config comes (airnpe.py 73), whether the user is banned from the raffles
  // (raffle_service.py 52), and where the character may be loaded, of the population cap's moniker, as it is
  // entered as (characterSelection.py 750).
  "config.GetBlackListedPlanets", "config.GetOldStationData", "air_npe.is_air_npe_enabled", "raffleProxy.AmIBanned",
  "populationCap.GetCharacterLoadSlot",
]);

/**
 * Calls the game port carries that the web gateway's list has not got: a pilot on the game port may make them, and
 * through the gateway they are refused. The customs office's transfer is the client's own call at an office
 * (importExportUI.py 549), and the gateway never had it.
 */
const GAME_PORT_ONLY_CALLS = Object.freeze([
  "invCache.FetchItem",
  "invCache.InvalidateLocationCache",
  "invbroker.EnterPassword",
  "invbroker.GetPriceForItems",
  "invbroker.GetSelfInvItem",
  "itemLocking.GetItemsByLocation",
  "itemLocking.GetLockedItemLocations",
  // The corporation's votes (services/corporation/voting.py CorporationVotes on sm.RemoteSvc('voteManager')): the
  // Votes panel's reads, a vote cast and a vote case made (Run For CEO). The gateway's list has none of them.
  "voteManager.GetVoteCasesByCorporation", "voteManager.GetVoteCaseOptions", "voteManager.GetVotes", "voteManager.CanViewVotes",
  "voteManager.CanRunForCEO", "voteManager.InsertVote", "voteManager.InsertVoteCase",
  // corpvotes.GetSanctionedActions: the wizard's unlock step, and Sanctionable Actions.
  "voteManager.GetCorpSanctionedActions", "voteManager.GetVoteCase", "voteManager.ActivateSanctionedAction",
  // A server-returned direct-trade Moniker; the page binds it lazily with List.
  "trademgr.InitiateTrade", "trademgr.MachoBindObject", "trademgr.List", "trademgr.Abort", "trademgr.Add", "trademgr.MultiAdd", "trademgr.OfferMoney", "trademgr.MakeOffer",
  // xmppchatsvc.py 1197-1208 / 1257-1261: private allocation and elevated addition, both on the proxy.
  "XmppChatMgr.CreatePrivateChannel", "XmppChatMgr.AddCharacterToChannel",
  "charMgr.GetPrivateInfo",
  "bannedwords.check_search_words_allowed",
  "facWarMgr.GetCorporationWarFactionID",
  "invbroker.ImportExportWithPlanet", "officeManager.GetCorporationsWithOffices", "officeManager.GetEmptyOfficeCount",
  // The lobby's buttons, on the station's own office object. (The BFF's list of writes names the renting; the
  // gateway's list of what it will carry has none of these.)
  "officeManager.GetPriceQuote", "officeManager.HasCorpImpoundedItems", "officeManager.PrimeOfficeItem", "officeManager.RentOffice", "officeManager.UnrentOffice",
  // The account's clone grade, which the client asks as it logs in. The gateway's list has nothing of the subscription manager's.
  "subscriptionMgr.GetCloneGrade",
  // The epic arcs' service (epicArcSvc.ReconstructController, epicArcController._GetMissionMessageID): the pilot's arc
  // missions' statuses and the arcs' journal messages. The gateway's list has neither.
  "agentMgr.GetMyEpicArcStatus", "agentMgr.GetMessagesForEpicArcMissions",
  // The job board's combat anomalies (evedungeons anomalyTracker CombatAnomalyTracker). The gateway's list has nothing of it.
  "dungeonInstanceCacheMgr.GetCombatAnomalyInstances",
  // The corporation finder's searches (base_corporation.GetRecruitmentAdsByCriteria / GetRecruitmentAdsForCorpID), on
  // the recruitment proxy. The gateway's list has nothing of it.
  "corpRecProxy.SearchCorpAds", "corpRecProxy.GetRecruitmentAdsByCorpID",
  // The corporation's own ads and their recruiters (CorpRecruitment.GetCorpRecruitmentAds, GetRecruiters), and the ad
  // made (CorpRecruitmentContainerCreation.UpdateAdvert: corp.CreateRecruitmentAd).
  "corpRecProxy.GetRecruitmentAdsForCorporation", "corpRecProxy.GetRecruiters", "corpRecProxy.CreateRecruitmentAd",
  // RecruitmentEntry.DeleteRecruitmentAd (corp.DeleteRecruitmentAd), after CorpAdsAreYouSureYouWantToDelete.
  "corpRecProxy.DeleteRecruitmentAd",
  // CorpRecruitmentContainerCreation.UpdateAdvert for an existing ad (corp.UpdateRecruitmentAd: minSP and otherMask named).
  "corpRecProxy.UpdateRecruitmentAd",
  // WarLandingPage.GetLandingPageInfo: war.GetPeaceTreaties (peaceTreatyMgr) and the corporation's war bills (billMgr).
  "peaceTreatyMgr.GetPeaceTreatiesForSession", "billMgr.GetCorporationBills",
  // WarDeclareWnd._DoDeclareMutualWar: mutualWarInvites.SendInvite.
  "mutualWarInviteMgr.SendInviteByPlayer",
  // MutualWarInvites (Administration > Wars): the invites to and from the pilot's owner, withdrawing one, answering
  // one, blocking them (svc.mutualWarInvites, each a RemoteSvc call).
  "mutualWarInviteMgr.GetPendingInvitesForSession", "mutualWarInviteMgr.WithdrawInviteByPlayer", "mutualWarInviteMgr.RespondToInviteByPlayer",
  "mutualWarInviteMgr.SetInvitesBlockedByPlayer", "mutualWarInviteMgr.IsCorpInvitesBlockedPlayer",
  // FormAlliancesMembers: alliance.GetMembers() (all_cso_members, the alliance moniker's), its corporations with their
  // chosen executor and joining date.
  "allianceRegistry.GetMembers",
  // FormAlliancesSovereignty's SovDashboard: sovSvc.GetSovereigntyStructuresInfoForAlliance - the alliance moniker's
  // GetAllianceSovereigntyStructuresInfo() (its TCU and Sov Hub rows and the campaign scores).
  "allianceRegistry.GetAllianceSovereigntyStructuresInfo",
  // FormAlliancesSystems: ClaimedSystemsDashboard's sovSvc.GetAllDevelopmentIndicesMapped (devIndexManager's
  // GetAllDevelopmentIndices) and the pending capital's cancel (the moniker's CancelCapitalSystemTransition).
  "devIndexManager.GetAllDevelopmentIndices", "allianceRegistry.CancelCapitalSystemTransition",
  // ExpandedSovHubEntry's skyhooks: SovHubEntryController.GetNumSkyhooks - sovereigntyResourceSvc
  // GetMyCorporationSkyhooksMemoized (RemoteSvc('colonyResourcesMgr').GetMyCorporationSkyhooks()).
  "colonyResourcesMgr.GetMyCorporationSkyhooks",
  // FormAlliancesApplications / FormAlliancesRankings: the corporation's applications to alliances (bco_alliance:
  // corpRegistry GetAllianceApplications, DeleteAllianceApplication, ApplyToJoinAlliance) and the alliance's decision
  // on one (all_cso_applications: the moniker's UpdateApplication(corpID, applicationText, state)).
  "corpRegistry.GetAllianceApplications", "corpRegistry.DeleteAllianceApplication", "corpRegistry.ApplyToJoinAlliance", "allianceRegistry.UpdateApplication",
  // FormAlliancesMembers.DeleteMember: the moniker's DeleteMember(corpID) - quitting (one's own) or kicking.
  "allianceRegistry.DeleteMember",
  // base_corporation.DeleteBulletin / all_cso.UpdateBulletinOrder: an alliance bulletin's on the alliance moniker.
  "allianceRegistry.DeleteBulletin", "allianceRegistry.UpdateBulletinOrder",
  // WarReportWnd: the war's statistics object (eveMoniker.GetWarStatistic(warID), bound) - GetBaseInfo, GetKills,
  // GetKillsByGroup.
  "warStatisticMgr.MachoBindObject", "warStatisticMgr.GetBaseInfo", "warStatisticMgr.GetKills", "warStatisticMgr.GetKillsByGroup",
  // officeManager.TrashImpoundAtStation (officeManager.py 156): Moniker('officeManager', stationID).TrashImpoundedOffice(),
  // a station the corporation assets' menu names - bound for it.
  "officeManager.MachoBindObject", "officeManager.TrashImpoundedOffice",
  // An acceleration gate's activation, the keeper's (movementFunctions.py 553). The gateway's list has nothing of the keeper's.
  "keeper.ActivateAccelerationGate",
  // A fitting saved, and one of the same name saved over (fittingSvc.PersistFitting, 302 and 304). The gateway's list
  // has the fitting manager's SaveManyFittings and not these.
  "charFittingMgr.SaveFitting", "charFittingMgr.UpdateFitting",
  // The same, and the name and description changed, on the corporation's and the alliance's fitting managers
  // (fittingSvc.GetFittingMgr, 85 to 92). The gateway's list has none of them.
  "corpFittingMgr.SaveFitting", "corpFittingMgr.UpdateFitting", "corpFittingMgr.UpdateNameAndDescription",
  "allianceFittingMgr.SaveFitting", "allianceFittingMgr.UpdateFitting", "allianceFittingMgr.UpdateNameAndDescription",
  "corpFittingMgr.DeleteFitting", "allianceFittingMgr.DeleteFitting",
  "corpFittingMgr.DeleteManyFittings", "allianceFittingMgr.DeleteManyFittings",
  // Everything of the pilot's, for the assets window's search (invCache.py 880). The web gateway refuses it on purpose
  // (a wider read than its assets panel wanted: evejsWebGatewayRuntime.js), so it goes on the game port alone.
  "charMgr.ListIncludingContainers",
  // The structures and NPC stations the pilot may dock at in its region (structureDirectory.py 65: the region's
  // markets, GetMarketDockableLocationsInRegion, which the multibuy's station list reads). The web gateway refuses it
  // (it once carried owners' timers; eve.js b5f7b0009 answers as Tranquility does), so it goes on the game port alone.
  "structureDirectory.GetMyCharacterStructures",
  // The dungeon a character is in, the keeper's (dungeonTracking.py 66), asked as its session starts in space.
  "keeper.GetCurrentDungeonForCharacter",
  // The ship's fighters, which the client's ship fighter state asks at every change of the session's ship. The
  // gateway's list has the fighter manager's writes and not this read.
  "fighterMgr.GetFightersForShip",
  // What is left of each mission the pilot has accepted, which the client's mission tracker asks at every change
  // of the session and as each warp ends. The gateway's list has nothing of the mission tracker's.
  "missionTrackerMgr.GetMissionInfoItems",
  // The pilot's jump timers, which the client's crimewatch service asks once, for its timer panel. The gateway's
  // list has nothing of the jump timers' service.
  "jumpTimers.GetTimers",
  // The occupation state of the system the session is in, which the client's warzone service asks once for a
  // system, for its location panel. The gateway's list has nothing of the warzone service's.
  "fwWarzoneSolarsystem.GetLocalOccupationState",
  // The bounty output of the system the session is in, which the client's dynamic resource service asks for the
  // same panel. The gateway's list has nothing of the dynamic bounty manager's.
  "dynamicBountyMgr.GetOutputForClientSolarSystem",
  // The solar systems whose security is other than the map's, which the client's security service asks once as
  // its session first has a solar system. The gateway's list has the map service's read of them, which is the
  // character selection screen's, and nothing of the security manager's.
  "securityMgr.get_modified_systems",
  // The character's settings, which the client's character settings service asks once and keeps. The gateway's
  // list has the character manager's GetSettingsInfo, which is another thing, and not this.
  "charMgr.GetCharacterSettings",
  // The same service's Save and Delete (characterSettingsSvc.py 44 to 58), which the gateway's list has neither of.
  "charMgr.SaveCharacterSetting", "charMgr.DeleteCharacterSetting",
  // What the character has completed of the client's achievements and how often its client's events have come,
  // which the client's achievement service asks once. The gateway's list has nothing of the achievement tracker's.
  "achievementTrackerMgr.GetCompletedAchievementsAndClientEventCount",
  // How many non-diminishing skill injections the character has left, which the client's service for them asks
  // as a character comes onto the session. The gateway's list has nothing of that manager's.
  "nonDiminishingInjectionMgr.GetAvailableNonDiminishingInjections",
  // The season the character may play, and its progress in it, which the client's season service asks as a
  // character comes onto the session. The gateway's list has nothing of the season manager's.
  "seasonManager.get_season_data_for_character", "seasonManager.get_character_progress_by_character_id",
  // The logon told to the milestone manager, which the client's milestone service tells as a character comes onto
  // the session. The gateway's list has nothing of the milestone manager's.
  "milestoneMgr.ProcessCharacterLogon",
  // Whether the character may play the tutorial, which the client's services that mind its operations ask once
  // for the character. The gateway's list has nothing of the operations manager's.
  "operationsManager.can_character_play_the_tutorial",
  // The insurgency campaigns a client may see, which the client's insurgency info panel has asked for as the info
  // panels are looked over. The gateway's list has nothing of the insurgencies'.
  "insurgencySolarsystem.GetAllVisibleCampaigns",
  // What the account may redeem, which the client's redeem service fetches as the neocom is set up. The gateway's
  // list has nothing of the user service's.
  "userSvc.GetRedeemTokens",
  // The redeem window's claim of those tokens, to the session's station or the home station. The page makes it by
  // name; the gateway's list has nothing of the user service's.
  "userSvc.ClaimRedeemTokens",
  // The account's daily login campaign, which the client's login campaign service asks for as its neocom button is
  // set up, and the day's claim of it. The page asks both by name; the gateway's list has nothing of the login
  // campaign manager's.
  "loginCampaignManager.get_client_campaign_state", "loginCampaignManager.claim_reward",
  // The seasonal login campaign: which one is on, the days the account has claimed of it, and the day's claim. The
  // client's seasonal campaign service asks the first as it starts and the second when first wanted; the page asks
  // all three by name. The gateway's list has nothing of the seasonal login campaign manager's.
  "seasonalLoginCampaignManager.get_active_campaign", "seasonalLoginCampaignManager.get_claim_history",
  "seasonalLoginCampaignManager.claim_reward",
  // Whether the character has done Project Discovery's tutorial, and whether Project Discovery is enabled, which
  // the client's Project Discovery service asks as a character comes onto the session and as the neocom's button
  // for it is looked at. The gateway's list has nothing of Project Discovery's.
  "ProjectDiscovery.initialize_tutorial_status", "ProjectDiscovery.is_enabled",
  // Whether the client wraps its texts for QA, which the client's localization service tells as a first character
  // comes onto a session of the QA role. The gateway's list has nothing of the localization server's.
  "localizationServer.UpdateLocalizationQAWrap",
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
  // Skill books bought as the client's books window buys them, on the handler (characterskills/client/purchase.py
  // 100). The page makes it by name. The gateway's list has not got it.
  "skillHandler.PurchaseSkills",
  // Free points spread over the levels of skills, as the client's Apply Skill Points window spreads them: what they
  // would come to, and the spreading (skillQueueSvc.py 608 to 613). The page makes them by name. The gateway's list
  // has neither.
  "skillHandler.GetFreeSkillPointsAppliedToSkills", "skillHandler.ApplyFreeSkillPointsToSkills",
  // The account's extra training slots, which the client's queue service asks for to tell whether a change of
  // the queue may start it (skillQueueSvc.py 851). The gateway's list has nothing of the user service's.
  "userSvc.GetMultiCharactersTrainingSlots",
  // The repair shop's two repairs by the client's names, on the shop's Moniker. The gateway's list has only the
  // server's own name for both, RepairItems, which the BFF asks there in their place (bridgeCallPolicy.js).
  "repairSvc.RepairItemsInStation", "repairSvc.RepairItemsInStructure",
  // A structure's services for the pilot, which the client's structure services service asks as the pilot docks
  // in one (structureServices.py 56). The gateway's list has nothing of the structure settings': through the
  // gateway a structure's services are not to be had, and what stands on them is refused (stockCompatibility.js).
  "structureSettings.CharacterGetServices",
  // A structure's market tax for the pilot, which the client's market service asks before it names a broker's fee
  // rate there (marketsvc.py 239). The transport asks it for an order placed in a structure; no route does.
  "structureSettings.CharacterGetService",
  // A structure's guests, which the client's lobby asks for as the pilot docks in one (structureGuests.py 25). The
  // gateway's list has a station's guests and nothing of a structure's.
  "structureGuests.GetGuests",
  // A pilot's dock at a player structure and its undock from one, as the client's structure docking service asks
  // them, by the service's name (structureDocking.py 69 and 36). The gateway's list has nothing of them: through the
  // gateway the BFF asks the park's CmdDock of the structure and the ship's Undock in their place (server.js,
  // dispatchPlaceChangeWrite).
  "structureDocking.Dock", "structureDocking.Undock",
  // A pilot's employment record and character transfers, which the client's History panel's employment tab asks
  // (infosvc.py 2842). The gateway's list has nothing of the corporation service's.
  "corporationSvc.GetEmployementRecordAndCharacterTransfers",
  // medals.py60/64/87/89/108: catalogue, recipients, received medals, details and awards on RemoteSvc.
  "corporationSvc.GetAllCorpMedals", "corporationSvc.GetRecipientsOfMedal", "corporationSvc.GetMedalDetails", "corporationSvc.GetMedalsReceived", "corporationSvc.CreateMedal", "corporationSvc.GiveMedalToCharacters",
  // A folder of the mail window marked read, trashed, and the trash restored (evemail.py StaticMenu). The gateway's
  // list has the mail manager's others, not these.
  "mailMgr.MarkAsReadByLabel", "mailMgr.MoveToTrashByLabel", "mailMgr.MoveAllFromTrash",
  // A mailing list's mails marked read and trashed, and its owner's delete of it (evemail.py MaillistMenu). The
  // gateway's list has none of them.
  "mailMgr.MarkAsReadByList", "mailMgr.MoveToTrashByList", "mailingListsMgr.Delete",
  // A mailing list's members made members, muted or operators, and kicked, from its management window's Members tab
  // (evemailingListConfig.py ApplyActionToMembers). The gateway's list has none of them.
  "mailingListsMgr.SetMembersClear", "mailingListsMgr.SetMembersMuted", "mailingListsMgr.SetMembersOperator", "mailingListsMgr.KickMembers",
  // A mailing list's subscription access and default role set, and whom it lets in or keeps out, from its management
  // window's Access tab (evemailingListConfig.py 302 to 326, 453 to 457). The gateway's list has none of them.
  "mailingListsMgr.SetDefaultAccess", "mailingListsMgr.SetEntitiesAccess", "mailingListsMgr.ClearEntityAccess",
  // A mailing list's welcome mail read, saved, saved and sent to every member, and cleared, from its management
  // window's Welcome Mail tab (evemailingListConfig.py 482 to 507). The gateway's list has none of them.
  "mailingListsMgr.GetWelcomeMail", "mailingListsMgr.SaveWelcomeMail", "mailingListsMgr.SendWelcomeMail", "mailingListsMgr.ClearWelcomeMail",
  // The search service's quick query, as the compose window and its "Search for Recipients" find a pilot
  // (searchOld.Search; searchUtil.GetResultsList). The gateway's list has nothing of the search service's.
  "search.QuickQuery",
  // Its query by kinds, as the People & Places window's Search tab finds owners (searchUtil.GetResultsByGroupID).
  "search.Query",
  // The pilot's contact labels, as the address book asks them for the Contacts window's labels
  // (addressbookService.py GetContactLabels, 1022 to 1044). The gateway's list has the contacts and not these.
  "charMgr.GetLabels",
  // A contact edited (addressbookService.py AddToAddressBook, 786 to 789). The gateway's list has its adding and
  // not this.
  "charMgr.EditContact",
  // The pilot's contact labels made, renamed and deleted, and given to contacts or taken off them
  // (addressbookService.py 1001 to 1147). The gateway's list has none of them.
  "charMgr.CreateLabel", "charMgr.EditLabel", "charMgr.DeleteLabel", "charMgr.AssignLabels", "charMgr.RemoveLabels",
  // Alliance contact forms use their own moniker and label table (all_cso243-278).
  "allianceRegistry.EditAllianceContact", "allianceRegistry.RemoveAllianceContacts", "allianceRegistry.EditContactsRelationshipID",
  "allianceRegistry.GetLabels", "allianceRegistry.CreateLabel", "allianceRegistry.EditLabel", "allianceRegistry.DeleteLabel", "allianceRegistry.AssignLabels", "allianceRegistry.RemoveLabels",
  // A bookmark folder's subfolders made, renamed and deleted, and a folder put online or offline for the pilot
  // (bookmarkSvc.py 483 to 589). The gateway's list has its folders' and bookmarks' writes and none of these.
  "accessGroupBookmarkMgr.CreateSubfolder", "accessGroupBookmarkMgr.UpdateSubfolder", "accessGroupBookmarkMgr.DeleteSubfolder",
  "accessGroupBookmarkMgr.UpdateKnownFolderState",
  // The pilot's access lists, which the folder window offers a shared folder's access levels from
  // (accessGroupsController.py 105). The gateway's list has nothing of the owner group manager's.
  "ownerGroupManager.GetMyGroups",
  // A shared folder disconnected from (bookmarkSvc.py 460), and an access list the pilot has not got asked by its
  // number (accessGroupsController.py 184). The gateway's list has neither.
  "accessGroupBookmarkMgr.RemoveFromKnownFolders", "ownerGroupManager.GetGroup",
  // Bookmarks copied into a folder (bookmarkSvc.py 701). The gateway's list has their moving and not this.
  "accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder",
  // A folder added to those the pilot knows (bookmarkSvc.py 357). The gateway's list has not got it.
  "accessGroupBookmarkMgr.AddToKnownFolders",
  // A jump to a fleet member's lit cyno, the fleet's jump with the pilot's own, and a bridge opened to it
  // (cynoTravelSvc.py 36, 103 and 62), on the ballpark's object. The gateway's list has none of them.
  "beyonce.CmdJumpToFleetModuleBeacon", "beyonce.CmdGroupJumpToFleetModuleBeacon", "beyonce.CmdBridgeToFleetModuleBeacon",
  // The systems of the Triglavians' and EDENCOM's minor victories and EDENCOM's fortresses, which the client's map
  // service asks for the autopilot's avoidance ticks (mapSvc.py 501 to 513) and which a Tranquility client asks as it
  // logs in. The gateway's list has the map service's history and none of these.
  "map.GetTriglavianMinorVictorySystems", "map.GetEdencomFortressSystems", "map.GetEdencomMinorVictorySystems",
  // A mission's objectives and whether the pilot is in its site, which the client's mission objectives tracker asks
  // for each accepted mission (missionObjectivesTracker.py 312 and 320). The gateway's list has none of them.
  "missionTrackerMgr.GetAllMissionObjectives", "missionTrackerMgr.IsInActiveDungeonID",
  // And its asking after missions, which the server answers by OnMissionsUpdated (UpdateMissionStatusData, 216 to 220):
  // at its start, for a mission accepted, as an awaited item comes aboard and as an awaited place is reached.
  "missionTrackerMgr.UpdateAllMissions",
  // The ship turned toward a direction: a probe result's Align To (scanSvc.AlignToPosition, 459 to 465), and the
  // double click in space. The gateway's list has it not.
  "beyonce.CmdGotoDirection",
  // The factions a player corporation's members may enlist with, the Permitted Faction Enlistments row of its Show Info
  // (infosvc.UpdateDataCorp: fwEnlistmentSvc.GetCorpAllowedEnlistmentFactions). The gateway's list has nothing of the
  // enlistment manager's.
  "fwCharacterEnlistmentMgr.GetCorpAllowedEnlistmentFactions",
  // The corporation window's Direct Enlistment (corp_ui_direct_enlistment_mgt.WhitelistManagement.ApplyChanges:
  // fwEnlistmentSvc.SetCorpAllowedEnlistmentFactions - SetMyCorpAllowedEnlistmentFactions(allowedFactionIDs)).
  "fwCharacterEnlistmentMgr.SetMyCorpAllowedEnlistmentFactions",
  // The pilot's expert systems and one of them taken out (expertSystems/client/service.py: GetMyExpertSystems,
  // RemoveMyExpertSystem, on expertSystemMgr by its name). The gateway's list has nothing of the expert systems'.
  "expertSystemMgr.GetMyExpertSystems", "expertSystemMgr.RemoveMyExpertSystem",
  // The NPCs' standings with each other, which the standing service keeps (standingsvc.py 115) and an owner's Show Info
  // reads in its Standings tab (panelStandings.GetStandingsFromManyToOneMutual). The gateway's list has it not.
  "standingMgr.GetNPCNPCStandings",
  // A ship's dirt time, which the client's hangar asks for the docked ship (baseHangarBehaviours.SetShipDirtLevel:
  // GetShipAccess().GetDirtTimestamp(itemID), for its hull's dust). The gateway's list has it not.
  "ship.GetDirtTimestamp",
]);

/**
 * Calls the client makes on an object that another call answered, where no moniker is: the system's scan manager,
 * which GetSystemScanMgr() answers. Asked of the service by its name, such a call is not the client's call,
 * whatever it is asked with.
 */
const ON_AN_ANSWERED_OBJECT = Object.freeze(new Set(["scanMgr.GetFullState"]));

/** Whether the retail client makes this call on the service's moniker for where the pilot is. */
/**
 * What the client asks of its ballpark's own object (michelle.GetRemotePark()) and the page asks of beyonce by its
 * name: made on the park's object, where the pilot has a park.
 */
// (CmdDock since 2026-10-14, when the page made the dock at a station itself: movementFunctions.RealDock's bp.CmdDock,
// made on the ballpark's bound object as Tranquility's recordings have it. Its route bound the park for itself. And
// CmdStargateJump the same day, the page's own jump: gateJumpSvc.JumpThroughGate's remoteBallpark.CmdStargateJump.)
// (CmdGotoBookmark on 2026-10-15, the page's Approach Location of a bookmark: movementFunctions.ApproachLocation's
// bp.CmdGotoBookmark, on the ballpark's object.)
// (CmdJumpToFleetModuleBeacon, CmdGroupJumpToFleetModuleBeacon and CmdBridgeToFleetModuleBeacon on 2026-10-15, the fleet
// menu's Jump To, Conduit Jump To and Bridge To: cynoTravelSvc.py's bp.Cmd..., on the ballpark's object.)
const ON_THE_PARK = Object.freeze(new Set(["CmdFleetTagTarget", "CmdGotoPoint", "CmdGotoDirection", "BookmarkScanResult", "CmdGotoBookmark", "CmdAlignTo", "CmdFollowBall", "CmdSetSpeedFraction", "CmdOrbit", "CmdStop", "BookmarkLocation", "CmdWarpToStuff", "CmdWarpToStuffAutopilot", "CmdDock", "CmdStargateJump", "CmdJumpToFleetModuleBeacon", "CmdGroupJumpToFleetModuleBeacon", "CmdBridgeToFleetModuleBeacon"]));
const madeOnMoniker = (service, method) => Object.hasOwn(MONIKER_SERVICES, service) && !MONIKER_SERVICES[service].has(method) && method !== "MachoBindObject";
/**
 * Whether the game port makes a call on an object though it is asked of a service by its name: on the service's
 * moniker, or on the ballpark's own object (pilots.js, callMethod). What else is asked by name goes by name.
 */
const madeOnAnObject = (service, method) => madeOnMoniker(service, method) || (service === "beyonce" && ON_THE_PARK.has(method));

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
const INV_ITEM_FUNCTIONS = "eve/client/script/ui/services/menuSvcExtras/invItemFunctions.py";
const SHIP_CONFIG = "eve/client/script/ui/services/shipConfigSvc.py";
const FITTING_SVC = "eve/client/script/environment/fittingSvc.py";
/**
 * fittingSvc.PersistFitting (268 to 300): the fitting a utillib.KeyVal() given its fields one at a time, the name
 * (stripped, at most 50), the description (at most 500), the ship's type and fitData, then the owner, so that they go
 * out in the order a dict of the five iterates; the name and the description typed text (typedText: the display
 * window's edits), and fitData a list of (typeID, flag, qty) tuples. A route gives the fitting as a plain object of
 * those fields. Null for anything else.
 */
function persistedFitting(fitting) {
  if (!fitting || typeof fitting !== "object" || Array.isArray(fitting) || fitting.type !== undefined) return null;
  const rows = Array.isArray(fitting.fitData) ? fitting.fitData : null;
  if (rows === null || typeof fitting.name !== "string" || typeof fitting.description !== "string") return null;
  if (!wholeAndPositive(fitting.shipTypeID) || !wholeAndPositive(fitting.ownerID)) return null;
  if (!rows.every((row) => Array.isArray(row) && row.length === 3 && row.every((value) => Number.isSafeInteger(value)))) return null;
  return keyVal(orderEntries([
    ["name", typedText(fitting.name)],
    ["description", typedText(fitting.description)],
    ["shipTypeID", fitting.shipTypeID],
    ["fitData", { type: "list", items: rows.map((row) => [...row]) }],
    ["ownerID", fitting.ownerID],
  ]));
}
/** SaveFitting(ownerID, fitting), as PersistFitting asks it (304). */
function fittingSaved(args, kwargs) {
  const [ownerID, fitting] = args;
  const made = persistedFitting(fitting);
  if (args.length !== 2 || !wholeAndPositive(ownerID) || made === null || Object.keys(kwargs).length > 0) {
    return { status: "differs", note: "The client saves an owner's fitting as the KeyVal of five PersistFitting makes, and nothing else." };
  }
  return { args: [ownerID, made], status: "reshaped" };
}
/** UpdateFitting(ownerID, fitting, fittingID=...), as PersistFitting asks it (302), for the owner's fitting of that name. */
function fittingUpdated(args, kwargs) {
  const [ownerID, fitting] = args;
  const made = persistedFitting(fitting);
  if (args.length !== 2 || !wholeAndPositive(ownerID) || made === null || !wholeAndPositive(kwargs.fittingID) || Object.keys(kwargs).length !== 1) {
    return { status: "differs", note: "The client updates an owner's fitting with the KeyVal of five PersistFitting makes and the fitting's number by keyword, and nothing else." };
  }
  return { args: [ownerID, made], kwargs: { fittingID: kwargs.fittingID }, status: "reshaped" };
}
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
/**
 * fleetSvc.GetMyFleetFinderAdvert (2394): nothing sent. It is asked from GetCurrentAdvertForMyFleet (1924), which
 * asks nothing where the session is in no fleet (nor where its fleet is not registered with the finder, which is
 * not judged here), and where a fleet's boss has changed (949). A session in no fleet never asks it.
 */
const askingItsFleetsAdvert = (args, kwargs, context) => {
  if (!(args.length === 0 && Object.keys(kwargs).length === 0)) return { status: "differs", note: "The client sends nothing with this call." };
  return context.fleetID === null || context.fleetID === undefined
    ? { status: "differs", note: "The client asks for its fleet's advert only from a session in a fleet: in none it asks nothing." }
    : {};
};
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
/** The broadcasts fleetSvc sends to the whole fleet, by name (SendGlobalBroadcast's callers, 1010 to 1035 and 1128). */
const GLOBAL_BROADCASTS = Object.freeze(new Set(["EnemySpotted", "NeedBackup", "HoldPosition", "TravelTo", "InPosition", "JumpBeacon", "Location"]));
/**
 * fleetSvc.SendGlobalBroadcast (983 to 990): self.fleet.SendBroadcast(name, self.broadcastScope, itemID, typeID), on
 * the fleet's object: one of those names, the scope, the item (a solar system for TravelTo), and a type where InPosition
 * and JumpBeacon give one, None else; and only from a session in a fleet (CheckIsInFleet, 984). No recording has one.
 */
const aGlobalBroadcast = (args, kwargs, context) => {
  if (!(args.length === 4 && GLOBAL_BROADCASTS.has(args[0]) && BROADCAST_SCOPES.has(args[1]) && Number.isSafeInteger(args[2]) && args[2] > 0
    && (args[3] === null || (Number.isSafeInteger(args[3]) && args[3] > 0)) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client sends one of its seven names for the fleet, its scope, the item and a type or None, and nothing else: SendBroadcast(name, scope, itemID, typeID)." };
  }
  return context.fleetID === null ? { status: "differs", note: "The client broadcasts only from a session in a fleet: in none it sends nothing." } : {};
};
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

/**
 * fleetSvc's watchlist, self.favorites: a set, which blue writes by the reduce protocol, (set, ([...],)) (blue's
 * src/Marshal.cpp WriteObjectReduce; set.__reduce_ex__(2) in the client's Python), its items in the set's own order.
 * The page says a list, of pilots' numbers. Null where what was given is no such list.
 */
const watchlistSet = (given) => {
  const listed = Array.isArray(given) ? given : given && given.type === "list" && Array.isArray(given.items) ? given.items : null;
  if (listed === null || !listed.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
  return { type: "objectex1", header: [token("__builtin__.set"), [{ type: "list", items: dictOrder(listed) }]], list: [], dict: [] };
};
/**
 * fleetSvc.AddFavorite (640 to 682): fleetMgr.AddToWatchlist(newCharsAdded, fav), the pilots just added (a list) and
 * every favourite with them (GetWatchlistMembers, 788: the set; None with damage updates off, which the page never is);
 * from a session in a fleet (CheckIsInFleet, 641). No recording has one.
 */
const addingToWatchlist = (args, kwargs, context) => {
  const [added, favorites] = args;
  const set = watchlistSet(favorites);
  if (!(args.length === 2 && Array.isArray(added) && added.length > 0 && added.every((id) => Number.isSafeInteger(id) && id > 0) && set !== null && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends the pilots it added, as a list, and every favourite, as its set: AddToWatchlist(newCharsAdded, favorites)." };
  }
  if (context.fleetID === null) return { args, kwargs, status: "differs", note: "The client keeps a watchlist only in a fleet: in none it sends nothing." };
  // newCharsAdded is a list the client appends to (659 to 663); an array of the page's goes as a tuple else.
  return { args: [{ type: "list", items: added }, set], kwargs };
};
/** fleetSvc.RemoveFavorite (715 to 723): fleetMgr.RemoveFromWatchlist(charID, favs), the pilot taken off and every favourite left (the set). */
const removingFromWatchlist = (args, kwargs, context) => {
  const [taken, favorites] = args;
  const set = watchlistSet(favorites);
  if (!(args.length === 2 && Number.isSafeInteger(taken) && taken > 0 && set !== null && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends the pilot it took off and every favourite left, as its set: RemoveFromWatchlist(charID, favorites)." };
  }
  if (context.fleetID === null) return { args, kwargs, status: "differs", note: "The client keeps a watchlist only in a fleet: in none it sends nothing." };
  return { args: [taken, set], kwargs };
};

/**
 * fleetSvc.RegisterForDamageUpdates (793 to 796): fleetMgr.RegisterForDamageUpdates(fav), every favourite (the set),
 * at a change of system in space in a fleet (ProcessSessionChange, 1688 to 1691); the client's own, which the game
 * port makes as it keeps the watchlist. No recording has one.
 */
const registeringForDamage = (args, kwargs, context) => {
  const set = watchlistSet(args[0]);
  if (!(args.length === 1 && set !== null && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends every favourite, as its set: RegisterForDamageUpdates(favorites)." };
  }
  if (context.fleetID === null) return { args, kwargs, status: "differs", note: "The client registers only in a fleet." };
  return { args: [set], kwargs };
};

/** droneFunctions.RealScoopToDroneBay (195): ship.ScoopDrone(objectIDs), the drones as one list of their IDs and nothing else. */
const scooping = (args, kwargs) => (args.length === 1 && Array.isArray(args[0]) && args[0].length > 0 && args[0].every((each) => Number.isSafeInteger(each) && each > 0)
  && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends the drones as one list of their IDs, and nothing else." });

/** invItemFunctions.Jettison (63): ship.Jettison(itemIDs), with itemIDs = itemsByID.keys(): the items as one list of their IDs and nothing else. */
const jettisoning = (args, kwargs) => (args.length === 1 && Array.isArray(args[0]) && args[0].length > 0 && args[0].every((each) => Number.isSafeInteger(each) && each > 0)
  && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends the items as one list of their IDs, and nothing else." });

/** industrySvc.CompleteJob (150) and CancelJob (160): the job, and the job's own solar system (idCheckers.IsSolarSystem), and nothing else. */
/** One ID alone, a whole number above nought, and nothing by keyword. */
const oneIDAlone = (what) => (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: `The client asks with ${what} alone.` });
/** The pilot's own character alone, and nothing by keyword. */
const ownCharacterAlone = (args, kwargs, context) => (args.length === 1 && context.characterID !== undefined && context.characterID !== null
  && Number(args[0]) === Number(context.characterID) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client asks with the pilot's own character alone." });
/**
 * war_cso.GetWars (98 to 106): self.GetMoniker().GetWars(ownerID), the owner always named and nothing else sent.
 * A route that names none means the pilot's own: its alliance, or its corporation where it is in none, the owner
 * the client's own askings name (IsPlayerCurrentlyAtWarOrInFW, 302 to 306; _CheckForWarStartingOrEnding, 185).
 */
const ofAWarOwner = (args, kwargs, context) => {
  if (Object.keys(kwargs).length > 0 || args.length > 1) return { args, kwargs, status: "differs", note: "The client asks the war registry for one owner's wars, with the owner alone." };
  if (args.length === 1) {
    return Number.isSafeInteger(args[0]) && args[0] > 0
      ? { args, kwargs, status: "same" }
      : { args, kwargs, status: "differs", note: "The client asks the war registry for one owner's wars, with the owner alone." };
  }
  const ownerID = context.allianceID ?? context.corporationID ?? null;
  return ownerID === null
    ? { args, kwargs, status: "differs", note: "The client names the owner whose wars it asks for. With no corporation known there is none to name, and the call goes as it was given." }
    : { args: [ownerID], kwargs, status: "reshaped" };
};
/** facilitySvc.GetFacilityLocations (114 to 120): the facility and the owner the job is for, each an ID, and nothing by keyword. */
const aFacilityAndAnOwner = (args, kwargs) => (args.length === 2 && args.every((each) => Number.isSafeInteger(each) && each > 0) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client asks with a facility and the owner the job is for, and nothing else." });
const aJobAndItsSystem = (args, kwargs) => (args.length === 2 && Number.isSafeInteger(args[0]) && args[0] > 0 && Number.isSafeInteger(args[1]) && args[1] >= 30000000 && args[1] <= 39999999
  && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends the job and its own solar system, and nothing else." });

/** droneFunctions.py: an order to drones names them as a list, as every recorded one does. */
const dronesListed = ([drones, ...rest], kwargs) => ({ args: [list(drones), ...rest], kwargs });
/** The address book's writes of owners (addressbookService.py 658, 674, 842): the owners a list, as the client's are. */
const ownersListed = ([owners, ...rest], kwargs) => ({ args: [list(owners), ...rest], kwargs });
/** Corporation contact editors confirm round(slider.value, 1), a Python float (corpAllianceContactManagementWindow.py 117). */
const corporationContactStanding = ([owner, standing, ...rest], kwargs) => ({
  args: [owner, typeof standing === "number" && Number.isFinite(standing) ? { type: "real", value: standing } : standing, ...rest], kwargs,
});
const corporationContactsStanding = (args, kwargs) => corporationContactStanding(ownersListed(args, kwargs).args, kwargs);
/** notificationSvc.DeleteNotifications (319): the notifications a list, as the client's are. */
const notificationsListed = ([notifications, ...rest], kwargs) => ({ args: [list(notifications), ...rest], kwargs });
/**
 * A contact label's bit, or the sum of several (manageLabels.py ManageLabel, 76 to 78), as the page sends it: a
 * number as it is, and past what a number holds exactly the text of its digits, a long. Anything else as it came.
 */
const labelBits = (value) => orderNumber(value) ?? value;
/** The address book's labels given or taken (addressbookService.py 1097, 1134): the owners a list, then the label's bits. */
const ownersLabelled = ([owners, bits, ...rest], kwargs) => ({ args: [list(owners), labelBits(bits), ...rest], kwargs });
/** A contact label renamed or deleted (1004, 1073): the label's bit first; the client's call where it goes as it came. */
const labelFirst = ([bits, ...rest], kwargs) => {
  const sent = labelBits(bits);
  return { args: [sent, ...rest], kwargs, ...(sent === bits ? { status: "same" } : {}) };
};
/** mailSvc.SendMail (965): the recipients a list, as the compose window's self.toChars.values() is (evemail.py 2281). */
const recipientsListed = ([recipients, ...rest], kwargs) => ({ args: [list(recipients), ...rest], kwargs });
/** A mailing list's number, then its members chosen, a list (evemailingListConfig.py _GetSelectedMembers, 295 to 300). */
const membersListed = ([listID, members, ...rest], kwargs) => ({ args: [listID, list(members), ...rest], kwargs });
/** The search service's QuickQuery (searchUtil.GetResultsList, 297 to 301): the text as the client's edit gives it, a unicode string, and the result types a list. */
const searchTextUnicode = ([text, types, ...rest], kwargs) => ({ args: [typeof text === "string" ? { type: "wstring", value: text } : text, list(types), ...rest], kwargs });
/**
 * Text the pilot typed into one of the client's edits, as the edit gives it: a unicode string. Each character typed
 * goes in as a unichr (baseSingleLineEdit.py Insert, 641 to 658), and an editor's markup is made of its Decode's
 * (editPlainText.py 320 to 321, GetValueForParagraphs), so what holds any text is unicode; an edit with nothing in
 * it gives the empty byte string it was made with, and goes so. Tranquility's recordings have
 * QuickQuery(u'harper frost', ...) and invbroker's SetLabel(itemID, u'LittleLittle').
 */
const typedText = (value) => (typeof value === "string" && value !== "" ? { type: "wstring", value } : value);
/**
 * An entry whose arguments at `places` are text typed into the client's edits (typedText), after its own shape,
 * where it has one, has judged the call as it was given. A call that was the client's in all else is reshaped where
 * any of them is made unicode; one that differs still does.
 */
const typing = (entry, places) => Object.freeze({
  ...entry,
  shape: (args, kwargs, context) => {
    const shaped = typeof entry.shape === "function" ? entry.shape(args, kwargs, context) : { args, kwargs };
    const sent = [...shaped.args];
    let made = false;
    for (const place of places) {
      const value = typedText(sent[place]);
      if (value !== sent[place]) {
        sent[place] = value;
        made = true;
      }
    }
    const status = shaped.status ?? entry.status;
    return { ...shaped, args: sent, ...(made && status === "same" ? { status: "reshaped" } : {}) };
  },
});
/**
 * A mailing list's number, then whom it lets in or keeps out, a dict of whole numbers to 0 (kept out) or 1 (let in)
 * (mailingListsSvc.py SetEntityAccess, 110 to 111: {entityID: access}). A route gives a plain object.
 */
const accessListed = ([listID, given, ...rest], kwargs) => {
  const pairs = plainPairs(given);
  const access = pairs === null
    ? given
    : { type: "dict", entries: orderEntries(pairs.map(([key, value]) => [wholeKey(key), value === 0 || value === 1 ? value : null]).filter(([key, value]) => key !== null && value !== null)) };
  return { args: [listID, access, ...rest], kwargs };
};

const aFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const asReal = (value) => ({ type: "real", value });
const anExtractorHead = (each) => Array.isArray(each) && each.length === 3 && Number.isInteger(each[0]) && each[0] >= 0 && aFiniteNumber(each[1]) && aFiniteNumber(each[2]);
/**
 * clientPlanet.InstallProgram (525): remoteHandler.GetProgramResultInfo(pinID, typeID, pin.heads, headRadius), on
 * the planet's own object. The heads are a list of (the head's number, latitude, longitude), and each angle and
 * the radius is a float, a whole number among them too. Recorded on Tranquility so.
 */
const programAsked = (args, kwargs) => (args.length === 4 && Number.isSafeInteger(args[0]) && args[0] > 0 && Number.isSafeInteger(args[1]) && args[1] > 0
  && Array.isArray(args[2]) && args[2].every(anExtractorHead) && aFiniteNumber(args[3]) && Object.keys(kwargs).length === 0
  ? { args: [args[0], args[1], list(args[2].map(([head, latitude, longitude]) => [head, asReal(latitude), asReal(longitude)])), asReal(args[3])], kwargs }
  : { args, kwargs, status: "differs", note: "The client sends the unit, the commodity, the unit's heads as a list of (head, latitude, longitude), and the radius, and nothing else." });

/** How many arguments each of a colony's commands has, by the command's number (commandStream.Serialize, 185 to 229). */
const COLONY_COMMAND_ARGUMENTS = Object.freeze({ 1: 4, 2: 1, 3: 3, 4: 2, 5: 3, 6: 4, 7: 1, 8: 2, 9: 2, 10: 4, 11: 2, 12: 4, 13: 3 });
const COLONY_CREATE_ROUTE = 6;
// (A number that is no command's has no count, and no arguments are that many.)
const aColonyCommand = (each) => Array.isArray(each) && each.length === 2 && Number.isInteger(each[0])
  && Array.isArray(each[1]) && each[1].length === COLONY_COMMAND_ARGUMENTS[each[0]] && (each[0] !== COLONY_CREATE_ROUTE || Array.isArray(each[1][1]));
/**
 * clientPlanet._SubmitChanges (171 to 180): remoteHandler.UserUpdateNetwork(self.changes.Serialize()). Serialize
 * answers a LIST of (the command's number, its arguments as a tuple), and a route's path, the second argument of
 * CREATEROUTE, is a list. Everything else in a command is a plain thing, or a tuple of two for a temporary ID.
 */
const networkChanges = (args, kwargs) => (args.length === 1 && Array.isArray(args[0]) && args[0].every(aColonyCommand) && Object.keys(kwargs).length === 0
  ? { args: [list(args[0].map(([command, given]) => [command, command === COLONY_CREATE_ROUTE ? [given[0], list(given[1]), ...given.slice(2)] : given]))], kwargs }
  : { args, kwargs, status: "differs", note: "The client sends its changes alone: a list of commands, each a command's number and that command's own arguments." });
/**
 * droneFunctions.Salvage (157 to 160): the drones, and the active target's ID, which is None where the pilot has
 * nothing targeted (it does not ask for one). Nought, the BFF's word for "any wreck", is none.
 */
const salvaging = ([drones, target, ...rest], kwargs) => ({ args: [list(drones), target === 0 || target === undefined ? null : target, ...rest], kwargs });

/**
 * movementFunctions._Ship_GoToPoint (320 to 324): bp.CmdGotoPoint(*position), on the ballpark's object. The
 * position is the positional control's (positionalControl.py 199 to 213): the ballpark's own position of the ship
 * added to where the pilot dragged to, so three floats, and a whole number among them goes as a float here too.
 */
const goingToPoint = (args, kwargs) => (args.length === 3 && args.every((each) => typeof each === "number" && Number.isFinite(each)) && Object.keys(kwargs).length === 0
  ? { args: args.map((each) => ({ type: "real", value: each })), kwargs }
  : { args, kwargs, status: "differs", note: "The client sends a point's three numbers and nothing else." });

/**
 * scanSvc.AlignToPosition (459 to 465): rbp.CmdGotoDirection(*directionalVector), on the ballpark's object: the three
 * of the place less the ship's own position, each a float. (The double click in space sends a direction of length
 * one, eveCommands.py 1092 and 1127; Tranquility has it so in six recordings, three floats and nothing else.)
 */
const goingInDirection = (args, kwargs) => (args.length === 3 && args.every((each) => typeof each === "number" && Number.isFinite(each)) && Object.keys(kwargs).length === 0
  ? { args: args.map((each) => ({ type: "real", value: each })), kwargs }
  : { args, kwargs, status: "differs", note: "The client sends a direction's three numbers and nothing else." });

/** movementFunctions.ApproachLocation (405): bp.CmdGotoBookmark(bookmark.bookmarkID), on the ballpark's object, the bookmark's number and nothing else. */
const goingToBookmark = (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends a bookmark's number and nothing else." });

/**
 * menusvc._AlignTo (2778 to 2793): bp.CmdAlignTo(dstID=targetID, bookmarkID=bookmarkID), on the ballpark's object,
 * and the only place the client makes the call. Nothing goes by position. Of the two by name one is an ID and the
 * other None: a thing (AlignTo, 2770, which does nothing for session.shipid) or a bookmark (AlignToBookmark, 2804).
 */
const aligning = (args, kwargs, context) => {
  const anID = (value) => Number.isSafeInteger(value) && value > 0;
  const { dstID, bookmarkID } = kwargs;
  const oneOfTheTwo = (anID(dstID) && bookmarkID === null) || (dstID === null && anID(bookmarkID));
  if (!(args.length === 0 && Object.keys(kwargs).length === 2 && oneOfTheTwo)) {
    return { status: "differs", note: "The client names a thing or a bookmark by name, dstID and bookmarkID, one of them an ID and the other None, and nothing by position." };
  }
  // (A ship that is not known is no number an item's ID can be: the item is above nought.)
  return Number(context.shipID) === dstID ? { status: "differs", note: "The client does not align to the pilot's own ship: it sends nothing." } : {};
};

/** eveCommands.CmdStopShip (1104) and menusvc.Activate (2432): bp.CmdStop(), on the ballpark's object, with nothing at all. */
const stopping = (args, kwargs) => (args.length === 0 && Object.keys(kwargs).length === 0 ? {} : { status: "differs", note: "The client sends nothing with a stop." });

/** idCheckers.IsRegion, IsConstellation, IsSolarSystem and IsStation, by the number alone. */
const isStaticPlace = (itemID) => (itemID >= 10000000 && itemID <= 39999999) || (itemID >= 60000000 && itemID <= 63999999);
/**
 * bookmarkSvc.ACLBookmarkLocation (609 to 620): bp.BookmarkLocation(itemID, folderID, name, comment, expiry,
 * subfolderID=subfolderID), on the ballpark's object. The subfolder goes by keyword every time, None where there
 * is none: it is put in where a call came without it. The name is never nothing (bookmarkLocationWindow.Confirm,
 * 212), and the time is one of bookmarkConst's four. A region, a constellation, a system or a station is not
 * asked of the park at all, but of accessGroupBookmarkMgr (BookmarkStaticLocation, 613); so is a structure, which
 * cannot be told by its number. No Tranquility recording has a bookmark made.
 */
const bookmarking = (args, kwargs) => {
  const anID = (value) => Number.isSafeInteger(value) && value > 0;
  const keywords = Object.keys(kwargs);
  const [thing, folder, name, comment, expiry] = args;
  const formed = args.length === 5 && anID(thing) && anID(folder) && typeof name === "string" && name.trim() !== "" && typeof comment === "string"
    && [0, 1, 2, 3].includes(expiry)
    && (keywords.length === 0 || (keywords.length === 1 && (kwargs.subfolderID === null || anID(kwargs.subfolderID))));
  if (!formed) {
    return { args, kwargs, status: "differs", note: "The client sends a thing, a folder, a name, a note and one of its four times to keep it, and the subfolder or None by keyword." };
  }
  if (isStaticPlace(thing)) {
    return { args, kwargs, status: "differs", note: "The client bookmarks a region, a constellation, a system or a station by accessGroupBookmarkMgr's BookmarkStaticLocation, and asks the park nothing." };
  }
  return keywords.length === 0 ? { args, kwargs: { subfolderID: null } } : { args, kwargs, status: "same" };
};

/**
 * movementFunctions.ShipApproach (302) and _Ship_KeepAtRange (229): bp.CmdFollowBall(targetID, range), on the
 * ballpark's object, with const.approachRange or the pilot's distance; neither for the pilot's own ship
 * (_IsInvalidMovementTarget, 390). The autopilot's (autopilot.py 437 and 454) is CmdFollowBall(destID, 0.0).
 * Tranquility's recordings (168): the menu's ranges whole numbers, the autopilot's a float of nought. A whole
 * number goes as one from here, so a range of nought is made the float; any other goes as it stands.
 */
/**
 * bookmarkSvc.ACLBookmarkLocation (609 to 613): self.accessGroupBookmarkMgr.BookmarkStaticLocation(itemID, folderID,
 * name, comment, expiry, subfolderID=subfolderID) for a region, a constellation, a system or a station, the subfolder
 * by keyword every time, None where there is none; put in where a call came without it. A thing in space is the
 * park's. No Tranquility recording has a bookmark made.
 */
/**
 * bookmarkSvc.ACLBookmarkScanResult (623 to 631), for a scan result the sensor suite has no site of (one it has is
 * bookmarked as a thing, BookmarkLocation): bp.BookmarkScanResult(locationID, name, comment, resultID, folderID,
 * expiry, subfolderID=subfolderID), on the ballpark's object. The system, the label (unicode, the window's) and the
 * note, the result's own ID (its label, scanSvc.GetScannedDownMenu's bookmarkData.id), the folder, one of the four
 * times, and the subfolder or None by keyword. No recording has one.
 */
const bookmarkingScanResult = (args, kwargs) => {
  const anID = (value) => Number.isSafeInteger(value) && value > 0;
  const keywords = Object.keys(kwargs);
  const [system, name, comment, resultID, folder, expiry] = args;
  const formed = args.length === 6 && anID(system) && typeof name === "string" && name.trim() !== "" && typeof comment === "string"
    && typeof resultID === "string" && resultID.trim() !== "" && anID(folder) && [0, 1, 2, 3].includes(expiry)
    && (keywords.length === 0 || (keywords.length === 1 && (kwargs.subfolderID === null || anID(kwargs.subfolderID))));
  if (!formed) {
    return { args, kwargs, status: "differs", note: "The client sends the system, a name, a note, the result's own ID, a folder and one of its four times to keep it, and the subfolder or None by keyword." };
  }
  return keywords.length === 0 ? { args, kwargs: { subfolderID: null } } : { args, kwargs, status: "same" };
};

const bookmarkingStatic = (args, kwargs) => {
  const anID = (value) => Number.isSafeInteger(value) && value > 0;
  const keywords = Object.keys(kwargs);
  const [thing, folder, name, comment, expiry] = args;
  const formed = args.length === 5 && anID(thing) && anID(folder) && typeof name === "string" && name.trim() !== "" && typeof comment === "string"
    && [0, 1, 2, 3].includes(expiry)
    && (keywords.length === 0 || (keywords.length === 1 && (kwargs.subfolderID === null || anID(kwargs.subfolderID))));
  if (!formed) {
    return { args, kwargs, status: "differs", note: "The client sends a place, a folder, a name, a note and one of its four times to keep it, and the subfolder or None by keyword." };
  }
  if (!isStaticPlace(thing)) {
    return { args, kwargs, status: "differs", note: "The client asks the bookmark manager for a region, a constellation, a system or a station, and the park for a thing in space." };
  }
  return keywords.length === 0 ? { args, kwargs: { subfolderID: null }, status: "reshaped" } : { args, kwargs };
};

/**
 * bookmarkSvc.UpdateACLBookmark (642 to 646): UpdateBookmark(bookmarkID, folderID, name, note, subfolderID,
 * newFolderID, expiryCancel), the last the window's 0 until its Cancel automated expiry box is ticked
 * (bookmarkLocationWindow.py 55, 180 to 182), then the box's True or False.
 */
const updatingBookmark = (args, kwargs) => {
  if (args.length !== 7 || Object.keys(kwargs).length > 0) {
    return { args, kwargs, status: "differs", note: "The client sends seven: the bookmark, its folder, the name, the note, the subfolder, the folder chosen and whether its expiry is cancelled." };
  }
  const cancel = args[6];
  return cancel === true || cancel === 0 ? { args, kwargs } : { args: [...args.slice(0, 6), cancel === false ? 0 : cancel], kwargs, status: "reshaped" };
};

/**
 * bookmarkSvc.DeleteBookmarks (656 to 668): DeleteBookmarks(folderID, bookmarks), the bookmarks of the folder a set
 * (a defaultdict(set)'s, by folder), which Python reduces to (set, ([...],)). A route gives a list.
 */
const bookmarksOfFolder = ([folderID, given, ...rest], kwargs) => {
  const listed = Array.isArray(given) ? given : given && given.type === "list" && Array.isArray(given.items) ? given.items : null;
  if (listed === null) return { args: [folderID, given, ...rest], kwargs };
  const ids = listed.map(wholeKey).filter((id) => id !== null);
  return { args: [folderID, { type: "objectex1", header: [token("__builtin__.set"), [{ type: "list", items: dictOrder(ids) }]], list: [], dict: [] }, ...rest], kwargs };
};

/** The bookmark service's folder and subfolder calls (bookmarkSvc.py 453 to 589): numbers above nought, and a name that is not nothing. */
const aBookmarkFolderID = (value) => Number.isSafeInteger(value) && value > 0;
const aSubfolderName = (value) => typeof value === "string" && value.trim() !== "";
/** bookmarkSvc.CreateSubfolder (565): CreateSubfolder(folderID, subfolderName), the subfolder window's name stripped (bookmarkSubfolderWindow.Confirm, 104 to 107). */
const subfolderMade = (args, kwargs) => (args.length === 2 && aBookmarkFolderID(args[0]) && aSubfolderName(args[1]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends a folder's number and the subfolder's name, and nothing else." });
/** bookmarkSvc.UpdateSubfolder (572): UpdateSubfolder(folderID, subfolderID, subfolderName). */
const subfolderRenamed = (args, kwargs) => (args.length === 3 && aBookmarkFolderID(args[0]) && aBookmarkFolderID(args[1]) && aSubfolderName(args[2]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the folder's number, the subfolder's and its new name, and nothing else." });
/** bookmarkSvc.DeleteSubfolder (589): DeleteSubfolder(subfolder.folderID, subfolderID). */
const subfolderDeleted = (args, kwargs) => (args.length === 2 && aBookmarkFolderID(args[0]) && aBookmarkFolderID(args[1]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the folder's number and the subfolder's, and nothing else." });
/** bookmarkSvc.UpdateFolderActiveState (483): UpdateKnownFolderState(folderID, isActive), True or False from the folder's menu. */
const folderStateSet = (args, kwargs) => (args.length === 2 && aBookmarkFolderID(args[0]) && typeof args[1] === "boolean" && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the folder's number and True or False, and nothing else." });
/** bookmarkSvc.DeleteBookmarkFolder (453): DeleteFolder(folderID). */
const folderDeleted = (args, kwargs) => (args.length === 1 && aBookmarkFolderID(args[0]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the folder's number and nothing else." });

/** An access list's number, or None. */
const anAccessList = (value) => value === null || aBookmarkFolderID(value);
/**
 * bookmarkSvc.CreateBookmarkFolder (426): AddFolder(isPersonal, folderName, description, adminGroupID, manageGroupID,
 * useGroupID, viewGroupID), the folder window's Confirm (bookmarkContainerWindow.py 197 to 242): a personal folder with
 * the four None, a shared one with its admins' list and the others or None.
 */
const folderMade = (args, kwargs) => {
  const [isPersonal, name, description, ...groups] = args;
  const lists = groups.length === 4 && groups.every(anAccessList) && (isPersonal === true ? groups.every((each) => each === null) : groups[0] !== null);
  return args.length === 7 && typeof isPersonal === "boolean" && aSubfolderName(name) && typeof description === "string" && lists && Object.keys(kwargs).length === 0
    ? {}
    : { status: "differs", note: "The client sends whether the folder is personal, its name, its notes and its four access lists (None for a personal folder, an admins' list for a shared one), and nothing else." };
};
/** bookmarkSvc.UpdateBookmarkFolder (441): UpdateFolder(folderID, folderName, description, adminGroupID, manageGroupID, useGroupID, viewGroupID). */
const folderChanged = (args, kwargs) => {
  const [folderID, name, description, ...groups] = args;
  return args.length === 7 && aBookmarkFolderID(folderID) && aSubfolderName(name) && typeof description === "string" && groups.length === 4 && groups.every(anAccessList) && Object.keys(kwargs).length === 0
    ? {}
    : { status: "differs", note: "The client sends the folder's number, its name, its notes and its four access lists, and nothing else." };
};
/** accessGroupsController.GetGroupInfoFromID (184): GetGroup(groupID). */
const listAsked = (args, kwargs) => (args.length === 1 && aBookmarkFolderID(args[0]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the access list's number and nothing else." });
/** bookmarkSvc.GetBookmarkFolder and GetFolderInfo (519, 528): GetFolderInfo(folderID). */
const folderAsked = (args, kwargs) => (args.length === 1 && aBookmarkFolderID(args[0]) && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client sends the folder's number and nothing else." });

/**
 * bookmarkSvc.MoveOrCopyBookmarks (678 to 711): MoveBookmarksToFolderAndSubfolder and CopyBookmarksToFolderAndSubfolder,
 * each (oldFolderID, folderID, subfolderID, bookmarks), the subfolder None for the folder itself and the bookmarks a
 * source folder's set (a defaultdict(set)'s), which Python reduces to (set, ([...],)). A list given is made the set.
 */
const bookmarksMovedOrCopied = (args, kwargs) => {
  const [oldFolderID, folderID, subfolderID, given] = args;
  const listed = Array.isArray(given) ? given : given && given.type === "list" && Array.isArray(given.items) ? given.items : null;
  const ids = listed === null ? null : listed.map(wholeKey);
  if (!(args.length === 4 && aBookmarkFolderID(oldFolderID) && aBookmarkFolderID(folderID) && anAccessList(subfolderID)
    && ids !== null && ids.length > 0 && ids.every((id) => id !== null) && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends the folder the bookmarks are in, the folder and the subfolder (or None) they go to, and the bookmarks, and nothing else." };
  }
  return { args: [oldFolderID, folderID, subfolderID, { type: "objectex1", header: [token("__builtin__.set"), [{ type: "list", items: dictOrder(ids) }]], list: [], dict: [] }], kwargs, status: "reshaped" };
};

const following = (args, kwargs, context) => {
  const [thing, range] = args;
  if (!(args.length === 2 && Number.isSafeInteger(thing) && thing > 0 && Number.isFinite(range) && range >= 0 && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends a thing and a range, a distance in metres, and nothing else." };
  }
  // (A ship that is not known is no number an item's ID can be: the item is above nought.)
  if (Number(context.shipID) === thing) return { args, kwargs, status: "differs", note: "The client sends no follow for the pilot's own ship." };
  return range === 0 ? { args: [thing, { type: "real", value: 0 }], kwargs } : { args, kwargs, status: "same" };
};

/**
 * movementFunctions.Orbit (243) and _Ship_Orbit (260): the range is made float(range) under ten metres and
 * int(range) from there, and then bp.CmdOrbit(targetID, range), on the ballpark's object; not for the pilot's own
 * ship (_IsInvalidMovementTarget, 390). Tranquility's recordings (79) are all of whole numbers, none under ten
 * metres. A whole number goes as one from here, so one under ten is made the float; and a range of ten or more
 * that is no whole number is cut to one, as int() cuts it.
 */
const orbiting = (args, kwargs, context) => {
  const [thing, range] = args;
  if (!(args.length === 2 && Number.isSafeInteger(thing) && thing > 0 && Number.isFinite(range) && range >= 0 && Object.keys(kwargs).length === 0)) {
    return { args, kwargs, status: "differs", note: "The client sends a thing and a range, a distance in metres, and nothing else." };
  }
  // (A ship that is not known is no number an item's ID can be: the item is above nought.)
  if (Number(context.shipID) === thing) return { args, kwargs, status: "differs", note: "The client sends no orbit of the pilot's own ship." };
  if (range < 10) return { args: [thing, { type: "real", value: range }], kwargs, status: Number.isInteger(range) ? "reshaped" : "same" };
  return Number.isInteger(range) ? { args, kwargs, status: "same" } : { args: [thing, Math.trunc(range)], kwargs };
};

/**
 * autopilot.py 434 and 451: park.CmdSetSpeedFraction(1.0), before the autopilot's approach. The ship's own panel
 * sends min(1.0, speedRatio) (activeShipController.py 227), and the shortcuts a speed or 1.0 (eveCommands.py 1071,
 * 1130). One fraction, from nought to one, and a float in every one of Tranquility's recordings (ten): so it goes.
 */
const throttling = (args, kwargs) => (args.length === 1 && typeof args[0] === "number" && args[0] >= 0 && args[0] <= 1 && Object.keys(kwargs).length === 0
  ? { args: [{ type: "real", value: args[0] }], kwargs }
  : { args, kwargs, status: "differs", note: "The client sends a fraction of the ship's speed, from nought to one, and nothing else." });

/**
 * station.TryLeaveShip (base.py 236 to 251): LeaveShip(shipid) only for dogmaLocation.GetCurrentShipID(), from a
 * pilot that is docked. In space the client's menu ejects, which is ship.Eject.
 */
const leavingTheShip = (args, kwargs, context) => {
  if (!(args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the ship it leaves, and nothing else." };
  }
  if (context.dockedAt === null || context.dockedAt === undefined) {
    return { status: "differs", note: "In space the client ejects: it leaves a ship so only where it is docked." };
  }
  return Number(context.shipID) === args[0] ? {} : { status: "differs", note: "The client leaves the ship the pilot is in, and no other." };
};

/** idCheckers.IsNewbieShip: a corvette's group. */
const GROUP_CORVETTE = 237;
/**
 * station.CreateNewbieShip (base.py 597 to 613): locationID = session.stationid or session.structureid, the ship
 * godma's own, and sm.RemoteSvc('dogmaIM').CreateNewbieShip(shipID, locationID). Aboard a corvette the client
 * refuses by itself (606), and its button is out of use (corvetteButton.py). A hull whose group is not known is
 * judged by the rest.
 */
const boardingACorvette = (args, kwargs, context) => {
  const named = (each) => Number.isSafeInteger(each) && each > 0;
  if (!(args.length === 2 && named(args[0]) && named(args[1]) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the ship and where it is docked, and nothing else." };
  }
  if (context.dockedAt === null || context.dockedAt === undefined) {
    return { status: "differs", note: "The client asks for a corvette only where it is docked." };
  }
  if (Number(context.dockedAt) !== args[1]) {
    return { status: "differs", note: "The client names where the pilot is docked, and no other place." };
  }
  if (Number(context.shipID) !== args[0]) {
    return { status: "differs", note: "The client names the ship the pilot is in, and no other." };
  }
  return context.shipGroupID === GROUP_CORVETTE ? { status: "differs", note: "The client asks for no corvette aboard a corvette: it refuses by itself." } : {};
};

/** The tags the client's menu offers for a thing in space (menusvc.py 1945 and 1946): the ten digits and thirteen letters. */
const FLEET_TAGS = new Set("0123456789ABCDEFGHIJXYZ");
/**
 * menusvc.TagItem (2822): bp.CmdFleetTagTarget(itemID, tag), on the ballpark's object. The tag is one of the
 * menu's, a string of one character, or None to take a tag off (1948). The menu is offered for a thing that is not
 * the pilot's own ship, to a fleet's commander (celestialCheckers.OfferFleetTagItem), and the shortcuts do nothing
 * outside a fleet (eveCommands.py 3043).
 */
const tagging = (args, kwargs, context) => {
  if (!(args.length === 2 && Number.isSafeInteger(args[0]) && args[0] > 0 && (args[1] === null || FLEET_TAGS.has(args[1])) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the thing and one of its tags, a digit or one of thirteen letters as text, or None to take the tag off, and nothing else." };
  }
  // (A ship that is not known is no number an item's ID can be: the item is above nought.)
  if (Number(context.shipID) === args[0]) {
    return { status: "differs", note: "The client offers no tag for the pilot's own ship." };
  }
  return context.fleetID === null ? { status: "differs", note: "The client tags only from a session in a fleet: in none it sends nothing." } : {};
};

/** The dogma location asked of a target: the target, and nothing else (targetMgr.py 1366, 1385, 1303). */
const aTargetAlone = (args, kwargs) => args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0;
const NOT_A_TARGET_ALONE = Object.freeze({ status: "differs", note: "The client sends the target, and nothing else." });
/** Whether the ship has the thing locked, as the target service's own list is kept (`context.targetLocked`). Null where that is not known. */
const lockedAlready = (context, itemID) => (typeof context.targetLocked === "function" ? context.targetLocked(itemID) : null);
/** targetMgr.TryLockTarget (1307), by which every lock is asked: none of a thing in targetsByID. */
const lockingATarget = (args, kwargs, context) => (!aTargetAlone(args, kwargs) ? NOT_A_TARGET_ALONE
  : lockedAlready(context, args[0]) === true ? { status: "differs", note: "The client asks no lock of a thing the ship has locked." } : {});
/** targetMgr.UnlockTarget (1384): `if tid in self.targetsByID:`, and for no other. */
const lettingGoOfATarget = (args, kwargs, context) => (!aTargetAlone(args, kwargs) ? NOT_A_TARGET_ALONE
  : lockedAlready(context, args[0]) === false ? { status: "differs", note: "The client lets go only of a thing the ship has locked: this one it has not locked." } : {});
/** targetMgr.CancelAddTarget (1298): of a lock the client is still making, which a thing it has locked is not. */
const callingOffALock = (args, kwargs, context) => (!aTargetAlone(args, kwargs) ? NOT_A_TARGET_ALONE
  : lockedAlready(context, args[0]) === true ? { status: "differs", note: "The client calls off a lock that is still being made: this one is made." } : {});
/** fleetSvc.KickMember (607): the pilot's own number is not kicked. The client leaves the fleet itself instead. */
const kickingAnother = (args, kwargs, context) => (String(args[0]) === String(context.characterID) ? {
  status: "differs",
  note: "The client does not kick the pilot's own character: it leaves the fleet instead (LeaveFleet, on the fleet's object).",
} : {});
/**
 * fleetSvc.OnFleetInvite (1168 to 1199): the invitation turned down on a Moniker for its fleet. From a session in
 * a fleet, RejectInvite(True), at once and with nothing asked of the pilot (1180). Where the pilot's setting or a
 * blocked window turns invitations away, RejectInvite(False) (1184, 1187). On the pilot's no, RejectInvite()
 * (1198). So True is said from within a fleet and from nowhere else, and nothing else is said from there.
 * `context.fleetID` is the session's fleet, null in none; where it is not known it is not held against the call.
 */
const turningDown = (args, kwargs, context) => {
  const asTheClient = Object.keys(kwargs).length === 0 && (args.length === 0 || (args.length === 1 && typeof args[0] === "boolean"));
  if (!asTheClient) return { status: "differs", note: "The client turns an invitation down with True, False or nothing, and nothing by keyword." };
  if (context.fleetID === undefined) return {};
  const inAFleet = context.fleetID !== null;
  if (inAFleet && args[0] !== true) return { status: "differs", note: "From a session in a fleet the client turns an invitation down with True, and with nothing else." };
  if (!inAFleet && args[0] === true) return { status: "differs", note: "The client says True only from a session in a fleet: this one is in no fleet." };
  return {};
};
/**
 * idCheckers, as fleetSvc.Invite goes by them before it asks (357): not IsNPC, and IsCharacter. By the number
 * alone: a player's character of the second or the third generation, or a number of the range the older
 * characters share with other things, where the client asks its cache of owners and nothing here can.
 */
const couldBeAPilot = (characterID) => Number.isSafeInteger(characterID)
  && ((characterID >= 90000000 && characterID <= 97999999) || (characterID >= 100000000 && characterID <= 2129999999));
/**
 * fleetSvc.Invite (351 to 363): self.fleet.Invite(charID, wingID, squadID, role), through CSPAChargedAction
 * (eveMisc.py 89), which asks it once as it stands and again with approvedCost by keyword where the server says
 * what the contact costs. A wing, a squad and a role are each an ID or None. For what by its number is no pilot
 * (357) and for the pilot's own character (361) the client asks nothing.
 */
const inviting = (args, kwargs, context) => {
  const anID = (value) => Number.isSafeInteger(value) && value > 0;
  const orNone = (value) => value === null || anID(value);
  const keywords = Object.keys(kwargs);
  const asTheClient = args.length === 4 && couldBeAPilot(args[0]) && orNone(args[1]) && orNone(args[2]) && orNone(args[3])
    && (keywords.length === 0 || (keywords.length === 1 && keywords[0] === "approvedCost"));
  if (!asTheClient) {
    return { status: "differs", note: "The client names a pilot, and a wing, a squad and a role or None for each, and nothing by keyword but a cost it has agreed to." };
  }
  // (A pilot that is not known is no number an invitee can be: the invitee is above nought.)
  return Number(context.characterID) === args[0] ? { status: "differs", note: "The client does not invite the pilot itself: it sends nothing." } : {};
};
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
const EXPERT_SYSTEM_SVC = "expertSystems/client/service.py";
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

/** industry/job.py 624 to 640: the seventeen names of a job's dump, in the order the client's own Python iterates its dict (scripts/py27-oracle.py). */
const JOB_DUMP_NAMES = Object.freeze(["productTypeID", "outputLocation", "facilityID", "corporationID", "runs", "tax", "account", "materials", "activityID", "cost", "blueprintTypeID", "time", "blueprintID", "solarSystemID", "inputLocation", "characterID", "licensedRuns"]);
/** The seven fields the server gives each place of a facility's (GetFacilityLocations), in the order the client's Python iterates a dict of them. */
const JOB_PLACE_NAMES = Object.freeze(["itemID", "typeID", "flagID", "canTake", "ownerID", "solarSystemID", "canView"]);
/** An object of the BFF's own, and no list. (A value in the codec's form is one too: it is told from a job by its names.) */
const heldPlainly = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const withJustTheNames = (value, names) => heldPlainly(value) && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
/**
 * industrySvc.InstallJob (141) and ConnectJob (307): the one argument is job.dump(), a dict of seventeen names.
 * Its materials are a dict of type to quantity, its time a float (timedelta.total_seconds()), its account a
 * pair or None, and each of its two places an industry.job.Location, the client's own object, or None: written
 * by the client's marshal as the class in a tuple and then the state, which is how the server's own test of a
 * request has it (eve.js, server/tests/industryPayloads.test.js). No Tranquility recording has anything of
 * industry.
 *
 * The BFF's routes hold the job as a plain object of the seventeen names, which the gateway takes as it is and
 * no marshal can write. Here it is made the client's dict. A job's time, its cost, its tax and its materials are
 * the client's own reckoning where the routes could make it (web/src/bridge/industryReckonings.mjs), and nought and an empty map
 * where they could not: the server reckons each itself, and checks only a number that is not nought and a map
 * that is not empty. (The materials go in the order of their types, where the client's dict has its Python's
 * order for one filled in the blueprint's: the value read is the same.)
 *
 * An invention's materials have the place of its optional material, the decryptor, whether one is in it or not:
 * with none, the client's dict has the place under None (industryCommon.GetDecryptors, 458 to 482; job.py 637),
 * and the routes' job has it under the name web/src/bridge/industryReckonings.mjs gives it, which is written here as that None.
 */
const jobDumped = (args, kwargs) => {
  const [job] = args;
  const aPlace = (value) => value === null || withJustTheNames(value, JOB_PLACE_NAMES);
  const anAccount = (value) => value === null || (Array.isArray(value) && value.length === 2);
  const materialsHeld = (value) => heldPlainly(value) && Object.entries(value).every(([typeID, quantity]) => (typeID === NO_OPTIONAL_MATERIAL || /^[1-9][0-9]*$/.test(typeID)) && Number.isSafeInteger(quantity));
  if (!(args.length === 1 && Object.keys(kwargs).length === 0 && withJustTheNames(job, JOB_DUMP_NAMES) && materialsHeld(job.materials) && typeof job.time === "number" && Number.isFinite(job.time)
    && aPlace(job.inputLocation) && aPlace(job.outputLocation) && anAccount(job.account))) {
    return { args, kwargs, status: "differs", note: "The client sends one dict and nothing else, its job's dump: seventeen names, the materials a dict of type to quantity, the time a number, the account a pair or None, and each place an industry.job.Location or None." };
  }
  const place = (value) => (value === null ? null : { type: "objectex2", header: [[token("industry.job.Location")], dict(JOB_PLACE_NAMES.map((name) => [name, value[name]]))], list: [], dict: [] });
  const sent = {
    ...job,
    time: { type: "real", value: job.time },
    materials: dict(Object.entries(job.materials).map(([typeID, quantity]) => [typeID === NO_OPTIONAL_MATERIAL ? null : Number(typeID), quantity])),
    inputLocation: place(job.inputLocation),
    outputLocation: place(job.outputLocation),
  };
  return { args: [dict(JOB_DUMP_NAMES.map((name) => [name, sent[name]]))], kwargs };
};
/** industrySvc.DisconnectJob (313): DisconnectJob(job.monitorID if job else None). */
const aMonitorLetGo = (args, kwargs) => (args.length === 1 && (args[0] === null || (Number.isSafeInteger(args[0]) && args[0] > 0)) && Object.keys(kwargs).length === 0
  ? {} : { status: "differs", note: "The client sends the monitor's number, or None, and nothing else." });

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

/**
 * godma.RepairManyModules (2206): InitiateModuleRepairMany(itemIDs), the list the module button's Repair All makes
 * (shipmodulebutton.GetMenu 507 to 516), and nothing else. The page's array goes as the client's list.
 */
const moduleList = (args, kwargs) => {
  const [itemIDs] = args;
  const items = Array.isArray(itemIDs) ? itemIDs : itemIDs && itemIDs.type === "list" && Array.isArray(itemIDs.items) ? itemIDs.items : null;
  if (!(args.length === 1 && items && items.length > 0 && items.every((id) => Number.isSafeInteger(id) && id > 0) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client sends one list of the modules, and nothing else." };
  }
  return { args: [{ type: "list", items }] };
};

/** godma.RepairModule and StopRepairModule (2227, 2261): the one module, a whole number above nought, and nothing else. */
const oneModule = (args, kwargs) => (args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0
  ? {}
  : { status: "differs", note: "The client names the one module and nothing else." });

/**
 * groupAllIcon.OnClick (36, 38): the ship the session is flying, session.shipid, and nothing else.
 * `context.shipID` is that ship where the session's is known.
 */
const ownShipAlone = (args, kwargs, context) => {
  if (!(args.length === 1 && Number.isSafeInteger(args[0]) && args[0] > 0 && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the one ship, the one its session is flying, and nothing else." };
  }
  return context.shipID === null || context.shipID === undefined || Number(context.shipID) === args[0]
    ? {}
    : { status: "differs", note: "The client names the ship its session is flying. This call names another." };
};

/** remoteDogmaLM.UnlinkModule(shipID, moduleID): the ship the session is flying, and the bank's master by its number. */
const ownShipAndModule = (args, kwargs, context) => {
  if (!(args.length === 2 && args.every((id) => Number.isSafeInteger(id) && id > 0) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the ship its session is flying and the bank's master, and nothing else." };
  }
  return context.shipID === null || context.shipID === undefined || Number(context.shipID) === args[0]
    ? {}
    : { status: "differs", note: "The client names the ship its session is flying. This call names another." };
};

/** LinkWeapons and MergeModuleGroups(shipID, masterID, moduleID): the ship the session is flying, and two modules by their numbers. */
const ownShipAndTwoModules = (args, kwargs, context) => {
  if (!(args.length === 3 && args.every((id) => Number.isSafeInteger(id) && id > 0) && Object.keys(kwargs).length === 0)) {
    return { status: "differs", note: "The client names the ship its session is flying, the bank's master and a module, and nothing else." };
  }
  return context.shipID === null || context.shipID === undefined || Number(context.shipID) === args[0]
    ? {}
    : { status: "differs", note: "The client names the ship its session is flying. This call names another." };
};

/** godma's Deactivate(itemID, effectName): the effect is the one the client holds as running, by name. */
function deactivation(args, kwargs, context) {
  const [itemID, effectName] = args;
  const named = text(effectName) || (context.effectName ? context.effectName(itemID) : null) || "";
  const shaped = { args: [itemID, named], kwargs };
  return named ? shaped : { ...shaped, status: "differs", note: "The client always names the effect it is stopping. This call names none, and what the module is was not known." };
}

/** Whether a call naming `shipID` names another ship than the one the session is flying, where that is known. */
const namesAnotherShip = (shipID, context) => context.shipID !== null && context.shipID !== undefined && Number(context.shipID) !== Number(shipID);
const ANOTHER_SHIP = Object.freeze({ status: "differs", note: "The client names the ship its session is flying. This call names another." });

/**
 * clientDogmaLocation.LoadChargesToModule (991): LoadAmmo(shipID, moduleID, [chargeItemID, ...], chargeLocationID),
 * one module by its ID (a bank's master standing for its bank), which is every one Tranquility has recorded; and
 * LoadAmmoToModules (996), the same with the modules as a list. The charges are a list either way. The ship is the
 * one the module sits in, which is the ship the session is flying.
 */
function loading(args, kwargs, context) {
  const [shipID, modules, charges, ...rest] = args;
  const shaped = { args: [shipID, list(modules), list(charges), ...rest], kwargs };
  return namesAnotherShip(shipID, context) ? { ...shaped, ...ANOTHER_SHIP } : shaped;
}

/**
 * clientDogmaLocation.UnloadAmmoFromModules sends a list; the module-container
 * path sends one scalar module with three arguments. UnloadAmmoToContainer
 * names one module and a fourth quantity (including None).
 */
function unloading(args, kwargs, context) {
  const [shipID, modules, destination, quantity] = args;
  const whose = namesAnotherShip(shipID, context) ? ANOTHER_SHIP : {};
  // Three: UnloadAmmoFromModules (1136), the modules a list; UnloadModuleToContainer (1095, 1097), one module and the
  // container, as Tranquility recorded it (UnloadAmmo(ship, module, ship)). Four: UnloadAmmoToContainer (1127), one
  // module, where, and the quantity, None where none is named, which goes as None.
  if (args.length < 4) return { args: [shipID, Array.isArray(modules) || modules?.type === "list" ? list(modules) : modules, destination], kwargs, ...whose };
  const several = Array.isArray(modules) ? modules : modules && Array.isArray(modules.items) ? modules.items : null;
  if (several === null) return { args: [shipID, modules, destination, quantity], kwargs, ...whose };
  if (several.length === 1) return { args: [shipID, several[0], destination, quantity], kwargs, ...whose };
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
  "charUnboundMgr.GetValidRandomName": same(
    `${CC_STEPS}/sections/chooseNameSection.py:96`,
    "RandomizeName: name = sm.RemoteSvc('charUnboundMgr').GetValidRandomName(self.GetInfo().raceID), by name, with the race's number, from the name screen's Randomize button (the newer screen's is the same: charcreation_new, 83). No recording has one.",
  ),
  "charUnboundMgr.ValidateNameEx": typing(reshaped(
    `${CC_STEPS}/sections/chooseNameSection.py:201`,
    ([name, checked, ...rest], kwargs) => ({ args: [name, checked ?? 0, ...rest], kwargs }),
    "ValidateNameEx(charName, how many names the screen has checked before this one), the name the name field's, stripped (192), so unicode. The page's creation screen keeps the client's count (each name asked once, a rolled name kept as valid) and sends it; the BFF's own check of the one name it is about to create sends 0, as the client does with its first.",
  ), [0]),
  "charUnboundMgr.CreateCharacterWithDoll": typing(differs(
    `${CC_SVC}:97`,
    "The client sends ten: (name, raceID, bloodlineID, genderID, ancestryID, charInfo, portraitInfo, schoolID, None, qaStarterSystemID), with the doll and the portrait it drew, the name the name field's, so unicode. The web client draws neither, and the BFF sends the server's older seven: (name, bloodlineID, genderID, ancestryID, None, None, 0), the name unicode as the client's.",
  ), [0]),

  // ── saved fittings ─────────────────────────────────────────────────────────
  "charFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("characterID", "character"), "GetFittingMgr(session.charid).GetFittings(session.charid)"),
  "charFittingMgr.UpdateNameAndDescription": typing(same(`${FITTING_SVC}:720`, "GetFittingMgr(ownerID).UpdateNameAndDescription(fittingID, ownerID, name, description): fittingSvc.ChangeNameAndDescription, from the fitting display's Save (fittingMgmtCont.SaveExistingFitting) where the name or the description changed; the name stripped, both typed in the window's edits. In no recording."), [2, 3]),
  "charFittingMgr.SaveFitting": judged(`${FITTING_SVC}:304`, fittingSaved, "GetFittingMgr(ownerID).SaveFitting(ownerID, fitting): fittingSvc.PersistFitting, from the fitting display's Save of a fitting not saved yet (the fitting window's Save Fit As, fittingSvc.DoSaveFitting); the fitting the KeyVal of five it makes (persistedFitting). Answered the fitting's number. In no recording."),
  "charFittingMgr.UpdateFitting": judged(`${FITTING_SVC}:302`, fittingUpdated, "GetFittingMgr(ownerID).UpdateFitting(ownerID, fitting, fittingID=existingFitting.fittingID): PersistFitting where the owner has a fitting of that name for the ship and the pilot said Yes to UpdateFitPersonal (289 to 299). Answered the fitting's number. In no recording."),
  "charFittingMgr.DeleteFitting": same(`${FITTING_SVC}:435`, "GetFittingMgr(ownerID).DeleteFitting(ownerID, fittingID): fittingSvc.DeleteFitting, from fittingUtil.DeleteFittings of one fitting (the browser's Delete Fitting, after DeleteFitting's Yes). In no recording."),
  "corpFittingMgr.DeleteFitting": same(`${FITTING_SVC}:435`, "GetFittingMgr(ownerID).DeleteFitting(ownerID, fittingID), the corporation's fitting manager, by one with the fitting manager's role (fittingUtil.CanDeleteFit). In no recording."),
  "allianceFittingMgr.DeleteFitting": same(`${FITTING_SVC}:435`, "GetFittingMgr(ownerID).DeleteFitting(ownerID, fittingID), the alliance's fitting manager, by one with the role whose corporation is the alliance's executor (fittingUtil.CanDeleteFit). In no recording."),
  "charFittingMgr.DeleteManyFittings": same(`${FITTING_SVC}:448`, "GetFittingMgr(ownerID).DeleteManyFittings(ownerID, fittingIDs): fittingSvc.DeleteManyFittings, one call for each owner at once (uthread.parallel), from fittingUtil.DeleteFittings of more than one (the browser's Delete Fitting with many selected, after DeleteFittingsManyOneOwner's or DeleteFittingsMany's Yes); the fittings deleted answered as a list. In no recording."),
  "corpFittingMgr.DeleteManyFittings": same(`${FITTING_SVC}:448`, "GetFittingMgr(ownerID).DeleteManyFittings(ownerID, fittingIDs), the corporation's fitting manager, for the corporation's fittings of the many selected, where fittingUtil.CanDeleteFit lets the pilot (GetDeletableNodes). In no recording."),
  "allianceFittingMgr.DeleteManyFittings": same(`${FITTING_SVC}:448`, "GetFittingMgr(ownerID).DeleteManyFittings(ownerID, fittingIDs), the alliance's fitting manager, for the alliance's fittings of the many selected, where fittingUtil.CanDeleteFit lets the pilot. In no recording."),
  "corpFittingMgr.UpdateNameAndDescription": typing(same(`${FITTING_SVC}:720`, "GetFittingMgr(ownerID).UpdateNameAndDescription(fittingID, ownerID, name, description), the corporation's fitting manager for a fitting of the corporation's: as the pilot's (fittingMgmtCont.SaveExistingFitting, by one with the fitting manager's role). In no recording."), [2, 3]),
  "corpFittingMgr.SaveFitting": judged(`${FITTING_SVC}:304`, fittingSaved, "GetFittingMgr(ownerID).SaveFitting(ownerID, fitting), the corporation's fitting manager: as the pilot's (the fitting display's Save for Corporation, fittingMgmtCont.SaveNewFitting). In no recording."),
  "corpFittingMgr.UpdateFitting": judged(`${FITTING_SVC}:302`, fittingUpdated, "GetFittingMgr(ownerID).UpdateFitting(ownerID, fitting, fittingID=...), the corporation's fitting manager: as the pilot's, where the pilot said Yes to UpdateFitCorp. In no recording."),
  "allianceFittingMgr.UpdateNameAndDescription": typing(same(`${FITTING_SVC}:720`, "GetFittingMgr(ownerID).UpdateNameAndDescription(fittingID, ownerID, name, description), the alliance's fitting manager for a fitting of the alliance's: as the pilot's. In no recording."), [2, 3]),
  "allianceFittingMgr.SaveFitting": judged(`${FITTING_SVC}:304`, fittingSaved, "GetFittingMgr(ownerID).SaveFitting(ownerID, fitting), the alliance's fitting manager: as the pilot's (the fitting display's Save for Alliance, offered to the executor corporation's). In no recording."),
  "allianceFittingMgr.UpdateFitting": judged(`${FITTING_SVC}:302`, fittingUpdated, "GetFittingMgr(ownerID).UpdateFitting(ownerID, fitting, fittingID=...), the alliance's fitting manager: as the pilot's, where the pilot said Yes to UpdateFitPersonal (PersistFitting asks UpdateFitCorp of the corporation's alone). In no recording."),
  "corpFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("corporationID", "corporation"), "GetFittingMgr(session.corpid).GetFittings(session.corpid)"),
  "allianceFittingMgr.GetFittings": reshaped(`${FITTING_SVC}:430`, fittingsOf("allianceID", "alliance"), "GetFittingMgr(session.allianceid).GetFittings(session.allianceid), and only for a pilot in an alliance"),

  // ── an inventory (a bound invbroker object) ───────────────────────────────
  "invCache.InvalidateLocationCache": {
    status: "local",
    source: `${INV_CACHE}:596-605`,
    note: "CLIENT-LOCAL: retire only the exact published inventory key and its mapped handles. No native server RPC, manager/session reset or broker-lock reset. Numeric station IDs do not alias containerHangar; pending-only binds remain. Retained Python old-guard behavior is outside the semantic-address API.",
  },
  "invCache.FetchItem": {
    status: "local",
    source: `${INV_CACHE}:693-702`,
    note: "CLIENT-LOCAL: numeric item from exactly one retained source inventory. NPC station sources map to containerHangar; other numeric sources stay exact. Missing guard/row returns None, with no bind/List/GetAllInfo RPC. Tuple charge source lookup and dynamic dogma fitting indices remain separate prerequisites.",
  },
  "invbroker.EnterPassword": typing(same(`${INV_CACHE}:1442-1477`, "PasswordHandlerCallWrapper sends EnterPassword(passwordType, scalar text from NamePopup) on the SAME underlying bound inventory; type1 is general, type2 configuration. The return is ignored before retrying the original operation. Nonempty edit text is Unicode. No Tranquility capture established."), [1]),
  "invbroker.GetSelfInvItem": judged(`${INV_CACHE}:966-975`, sentWithNothing, "invCacheContainer.GetItem reads its inventory's GetSelfInvItem(), as DogmaLocation.UnloadModuleToContainer1087-1088 requires before unloading to a Trade inventory."),
  "itemLocking.GetItemsByLocation": same("eve/client/script/ui/services/corporation/itemLocking.py:30-34,57-64", "GetItemsByLocation(current station or docked structure), cached per location until OnLockedItemChange. invCacheContainer.MultiAdd1044 checks every ordinary item ID before acquiring a local broker lock."),
  "itemLocking.GetLockedItemLocations": judged("eve/client/script/ui/services/corporation/itemLocking.py:36-40", sentWithNothing, "lockedItems.GetLockedItemLocations: once, then kept and amended by OnLockedItemChange; the corporation assets' Lockdown tab (corp_ui_accounts.ShowLockdown 528)."),
  "invbroker.GetPriceForItems": reshaped(`${INV_CACHE}:769`, (args, kwargs) => ({ args: [list(args[0] ?? [])], kwargs }), "Asset Safety wrap GetPriceForItems([itemIDs]), before the recovery question and quantity popup."),
  "structureAssetSafety.GetWrapNames": reshaped("eve/client/script/ui/shared/assets/assetSafetySvc.py:79", (args, kwargs) => ({ args: [list(args[0] ?? [])], kwargs }), "GetWrapNames(wrapIDs), a list of all requested wraps when any name is uncached."),
  "invbroker.GetAvailableTurretSlots": judged("achievements/client/eventHandler.py:427", sentWithNothing, "invCache.GetInventoryFromId(shipID).GetAvailableTurretSlots(), nothing sent, on the ship's own inventory: how many of its turret hardpoints are free. The achievements' event handler asks it at every change of the session's ship to a ship (251 to 260, 419 to 429: godma's item of the ship first, and only for one of the ship category) and when what is fitted high changes (inventorysvc.py 124). Tranquility's recordings have it in 20: at a login, an ejection, a boarding."),
  "invbroker.List": reshaped(
    `${INV_CACHE}:1138`,
    // Local List1131-1138: the first positional flag wins, even 0/None. Keep local filters until listedRead consumes them.
    (args, kwargs) => ({ args: [], kwargs: { ...kwargs, flag: args.length > 0 ? args[0] : kwargs.flag ?? null } }),
    "List(flag=flag)",
  ),
  "invbroker.ListByFlags": reshaped(
    `${INV_CACHE}:1174`,
    // Local ListByFlags1167: positional flagIDs wins; listedRead sends only the uncached flags remotely.
    (args, kwargs) => ({ args: [], kwargs: { ...kwargs, flags: list(args.length > 0 ? args[0] ?? [] : kwargs.flags ?? []) } }),
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
  "planetMgr.GetProgramResultInfo": reshaped("eve/client/script/environment/planet/clientPlanet.py:525", programAsked,
    "remoteHandler.GetProgramResultInfo(pinID, typeID, pin.heads, headRadius), on the planet's own object, as a programme is about to be installed: the heads a list of (head, latitude, longitude), the angles and the radius floats. It answers (what a cycle yields, a cycle's length, the count of cycles). Recorded on Tranquility so, 114 ms before the change that installs the programme."),
  "planetMgr.UserUpdateNetwork": reshaped("eve/client/script/environment/planet/clientPlanet.py:180", networkChanges,
    "remoteHandler.UserUpdateNetwork(self.changes.Serialize()), on the planet's own object (eveMoniker.GetPlanet(planetID)): the changes a list of (the command's number, its arguments), a route's path a list. Recorded on Tranquility so. It answers the colony as it now is, which the client's planet takes for its own. A restart of an extractor is one call there (its routes removed, its programme installed, the routes made anew), and one from the page."),
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
    //
    // But for a module taken out of its slot, which is the fitting's own Add and names no quantity
    // (fittingSlotController.UnfitModule): docked, of the hangar's inventory with no qty at all (238:
    // Add(moduleID, shipID, flag=const.flagHangar)), and in space, of the ship's own with a qty of None (241:
    // Add(moduleID, shipID, qty=None, flag=const.flagCargo)). A call of either form, of a thing a listing has in a
    // slot of the pilot's ship, goes as it is said. DogmaLocation1077-1104
    // additionally omits both kwargs for a flagless destination such as Trade,
    // and names qty=None with other destination flags.
    (args, kwargs, context) => {
      if (kwargs.qty !== undefined && kwargs.qty !== null) return { status: "same" };
      if (unfitsAModule(args, kwargs, context)) return { status: "same" };
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
  "invbroker.MultiMerge": reshaped(
    `${INV_CACHE}:1124`,
    // self.moniker.MultiMerge(ops, sourceContainerID): the ops a list of (source, destination, qty) tuples
    // (invControllers.py 335). Recorded on Tranquility so, once: a list of one tuple, and the station.
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "MultiMerge([(source, destination, qty)], sourceContainerID)",
  ),
  "invbroker.TrashItems": reshaped(
    "eve/client/script/ui/services/menuSvcExtras/invItemFunctions.py:618",
    // invCache.GetInventoryMgr().TrashItems(itemsToTrash, locationID): the items a list (TrashInvItems, 607 to 612).
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "TrashItems([itemIDs], locationID)",
  ),
  "invbroker.DestroyFitting": same("eve/client/script/ui/shared/fitting/fittingSlotController.py:262",
    "parentInv.DestroyFitting(moduleID), on the ship's own inventory (invCache.GetInventoryFromId(the ship)): a rig taken off the ship from the Fitting window, after the RigUnFittingInfo dialog's OK, where the rig cannot be unfitted whole (Unfit, 245 to 266). In no recording."),
  "invbroker.SetLabel": typing(same("eve/client/script/ui/services/menuSvcExtras/menuFunctions.py:343", "invCache.GetInventoryMgr().SetLabel(itemID, name), on the inventory manager of where the pilot is (eveMoniker.GetInventoryMgr): an item named, from a ship's Change Name or a container's Set Name, the name the window answered with its line breaks made spaces. Recorded on Tranquility (SetLabel(itemID, u'LittleLittle')), the server's OnCfgDataChanged('evelocations', ...) after it."), [1]),
  "invbroker.StackAll": same(`${INV_CONTROLLERS}:387`, "StackAll(locationFlag), or StackAll()"),
  "invbroker.AssembleCargoContainer": same("eve/client/script/ui/services/menusvc.py:3564", "invCache.GetInventoryMgr().AssembleCargoContainer(itemID, None, 0.0), on the inventory manager of where the pilot is (eveMoniker.GetInventoryMgr), once for each item: a packaged container assembled from its menu's Assemble Container (itemCheckers.OfferAssembleContainer: a player's container that is not a siphon's, packaged, the pilot docked, the container where the pilot is) or by a double click on it (item.py 838 and 839). No name, and a real zero. In no recording."),

  // ── an agent (a bound agentMgr object) ────────────────────────────────────
  "agentMgr.DoAction": same(`${AGENT_WINDOW}:428`, "DoAction(actionID)"),
  "agentMgr.GetMissionBriefingInfo": same(`${AGENTS}:750`, "no arguments"),
  "agentMgr.GetMissionObjectiveInfo": same(`${AGENT_WINDOW}:222`, "no arguments when the dialogue opens; the job board's page of a mission adds ignoreLocateCheck=True (jobboard/client/features/agent_missions/job.py:413)"),
  "agentMgr.GetAgentLocationWrap": same(`${AGENT_WINDOW}:276`, "no arguments"),
  "agentMgr.GotoLocation": judged("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:402", agentGoing,
    "GetAgentMoniker(agentID).GotoLocation(locationType, locationNumber, referringAgentID): a mission's bookmark's Approach Location, on the agent's own object. It answers nothing. In no recording."),
  "agentMgr.WarpToLocation": judged("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:416", agentWarping,
    "GetAgentMoniker(agentID).WarpToLocation(locationType, locationNumber, warpRange, fleet, referringAgentID, GetFormationSettings()), on the agent's own object: a mission's marked spot warped to. Recorded 23 times on Tranquility, each ('dungeon', 0, nought, False, None, the three settings)."),
  "agentMgr.RemoveOfferFromJournal": same(`${AGENTS}:783`, "GetAgentMoniker(agentID).RemoveOfferFromJournal(), no arguments, on the agent's bound object"),
  "agentMgr.GetMissionJournalInfo": differs(`${AGENTS}:747`, "The client sends (charID, contentID). The BFF sends nothing."),

  // ── the scanner (the scan manager a service call answers with, and the dogma location) ─────────────
  "beyonce.GetFormations": same("eve/client/script/remote/michelle.py:324", "RemoteSvc('beyonce').GetFormations(), no arguments, by name, as the ballpark is made. Recorded on Tranquility so."),
  "beyonce.CmdWarpToStuffAutopilot": judged("eve/client/script/parklife/autopilot.py:465", autopilotWarping, "GetRemotePark().CmdWarpToStuffAutopilot(destinationID): the autopilot's warp, on the ballpark's object. Recorded on Tranquility with the one ID."),
  "beyonce.CmdWarpToStuff": judged("eve/client/script/remote/michelle.py:737", warping,
    "bp.CmdWarpToStuff(subject, subjectID, **kwargs), on the ballpark's object, with the keywords its caller sends: 'item' and the thing's ID with minRange (movementFunctions.py 452), 'char' for a fleet member with minRange a float (menusvc.py 2748), 'bookmark' with minRange a float and fleet (movementFunctions.py 419), 'scan' with minRange and fleet (menusvc.py 1428), 'launch' and a launch's ID with nothing (journal.py 453). Recorded on Tranquility as ('item', itemID, minRange=0), and as ('char', charID, minRange=0.0)."),
  "beyonce.CmdStargateJump": Object.freeze({
    status: "same",
    source: "stargate/client/gateJumpSvc.py:124",
    note: "remoteBallpark.CmdStargateJump(stargateID, beaconID, session.shipid), on the ballpark's object, through sessionMgr.PerformSessionChange: the gate, its own far gate off its slim item (jumps[0].toCelestialID: movementFunctions.DockOrJumpOrActivateGate, autopilot.py 358) and the ship. Recorded on Tranquility in an autopilot's trip so.",
    shape: (args, kwargs, context) => {
      if (args.length !== 3) return { args, kwargs, status: "differs", note: "The client sends three: the gate, its far gate and the ship." };
      const [gate, far, ship] = args;
      const known = context && typeof context.gateDestination === "function" ? context.gateDestination(gate) : null;
      if (wholeAndPositive(far)) {
        return known === null || known === far ? { args, kwargs } : { args, kwargs, status: "differs", note: "The client names the far gate the gate's slim item has. This call names another." };
      }
      if (known === null) return { args, kwargs, status: "differs", note: "The client names the gate's far gate, off its slim item. This call names none, and the ballpark has not the gate." };
      return { args: [gate, known, ship], kwargs, status: "reshaped" };
    },
  }),
  "structureDocking.Dock": same("eve/client/script/ui/services/structure/structureDocking.py:69", "RemoteSvc('structureDocking').Dock(structureID, session.shipid), by the service's name, once the autopilot has the ship within 2,500 m of the structure (80). Recorded on Tranquility with the two IDs, the structure's and the ship's."),
  "corporationSvc.GetEmployementRecordAndCharacterTransfers": same("eve/client/script/ui/shared/info/infosvc.py:2842", "RemoteSvc('corporationSvc').GetEmployementRecordAndCharacterTransfers(itemID), CCP's spelling, with the character the History panel's employment tab is of (session.charid). In no recording."),
  "structureDocking.Undock": same("eve/client/script/ui/services/structure/structureDocking.py:36", "RemoteSvc('structureDocking').Undock(session.structureid, shipID, ignoreContraband=...), by the service's name, through sessionMgr.PerformSessionChange('undock', ...), the ship None where it is the structure; no online modules named. Recorded on Tranquility with the two IDs and ignoreContraband False."),
  "beyonce.CmdDock": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:517", "bp.CmdDock(itemID, session.shipid), on the ballpark's object, through sessionMgr.PerformSessionChange('dock', ...). Recorded on Tranquility with the two IDs."),
  "beyonce.CmdJumpToFleetModuleBeacon": same("eve/client/script/parklife/cynoTravelSvc.py:36", "bp.CmdJumpToFleetModuleBeacon(charID, beaconID, solarsystemID), on the ballpark's object, through sessionMgr.PerformSessionChange('jump', ...): the member whose cyno it is, the beacon and its system as fleetSvc keeps them (menusvc.JumpToMember). In no recording."),
  "beyonce.CmdGroupJumpToFleetModuleBeacon": same("eve/client/script/parklife/cynoTravelSvc.py:103", "bp.CmdGroupJumpToFleetModuleBeacon(charID, beaconID, solarsystemID), on the ballpark's object, through sessionMgr.PerformSessionChange('jump', ...) (menusvc.GroupJumpToMember). In no recording."),
  "beyonce.CmdBridgeToFleetModuleBeacon": same("eve/client/script/parklife/cynoTravelSvc.py:62", "bp.CmdBridgeToFleetModuleBeacon(charID, beaconID, solarsystemID), on the ballpark's object, no session change: the ship that opens the bridge stays (menusvc.BridgeToMember). In no recording."),
  "abyssalMgr.AbyssalEntranceDeployment": same("abyss/client/abyssal_service.py:53", "RemoteSvc('abyssalMgr').AbyssalEntranceDeployment(item_id, game_mode_id), by the service's name, from the key activation window's button (keyActivationWindow.py 49 to 54): the filament and the game mode, 1 solo, 2 co-op, 3 two-player; solo's through sessionMgr.PerformSessionChange('JumpToAbyss', ...), the others' without. In no recording."),
  "abyssalMgr.AbyssalEntranceGateActivation": same("abyss/client/abyssal_service.py:58", "RemoteSvc('abyssalMgr').AbyssalEntranceGateActivation(item_id), by the service's name, from a trace's jump window (AbyssJumpWindow.py JumpActivationController._Activate), through sessionMgr.PerformSessionChange('JumpToAbyss', ...): the trace. In no recording."),
  "abyssalMgr.AbyssalGateActivation": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:569", "RemoteSvc('abyssalMgr').AbyssalGateActivation(itemID, violateSafetyTimer=True), by the service's name, through sessionMgr.PerformSessionChange('abyssToAbyssJump', ...): a pocket's Transfer Conduit (typeAbyssEncounterGate), from the menu's Activate Gate once the ship is within 2,500 m (menusvc.ActivateAbyssalAccelerationGate). In no recording."),
  "abyssalMgr.AbyssalEndGateActivation": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:579", "RemoteSvc('abyssalMgr').AbyssalEndGateActivation(itemID), by the service's name, through sessionMgr.PerformSessionChange('abyssToKnownJump', ...): the last room's conduit out (typeAbyssExitGate), from the menu's Activate Gate once within 2,500 m. In no recording."),
  "keeper.GetCurrentDungeonForCharacter": same("eve/client/script/parklife/dungeonTracking.py:66", "RemoteSvc('keeper').GetCurrentDungeonForCharacter(), no arguments, by the service's name: the dungeon tracking's ask when a character's session starts in space (OnCharacterSessionChanged), answered (dungeon_id, room_id, instance_id, dungeon_values) or None. In no recording."),
  "keeper.ActivateAccelerationGate": same("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:553", "RemoteSvc('keeper').ActivateAccelerationGate(itemID, violateSafetyTimer=1), by the service's name, through sessionMgr.PerformSessionChange: an acceleration gate, from the menu's Activate Gate once within 2,500 m and the crimewatch safety check passed. In no recording."),
  "structureJumpBridgeMgr.CmdJumpThroughStructureStargate": same("eve/client/script/parklife/autopilot.py:349", "RemoteSvc('structureJumpBridgeMgr').CmdJumpThroughStructureStargate(destID), by the service's name, through sessionMgr.PerformSessionChange: the Ansiblex the autopilot's ship is within 2,500 m of (menusvc.ReallyJumpThroughStructureJumpBridge, 2106, the same). In no recording."),
  "beyonce.CmdFollowBall": reshaped("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:302", following, "bp.CmdFollowBall(targetID, range), on the ballpark's object: the menu's approach with const.approachRange, keep at range with the pilot's distance (229), the autopilot's with 0.0 (autopilot.py 437). Not sent for the pilot's own ship. Recorded on Tranquility as (itemID, 50), and at 5000 and 7500, each a whole number; the autopilot's twice, its range a float of nought, which is how a range of nought goes."),
  "beyonce.CmdOrbit": reshaped("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:260", orbiting, "bp.CmdOrbit(targetID, range), on the ballpark's object: the range a float under 10 m and a whole number from there (243). Not sent for the pilot's own ship. Recorded on Tranquility as (itemID, 1000) and (itemID, 5000), 7500 and 10000, each a whole number, with nothing before it; none is recorded under ten metres, where the client's float is how it goes."),
  "beyonce.CmdStop": judged("eve/client/script/ui/eveCommands.py:1104", stopping, "bp.CmdStop(), no arguments, on the ballpark's object: from the stop command, in a ship in space, and from a double click on the pilot's own capsule (menusvc.py 2432). Recorded on Tranquility so, 24 times."),
  "beyonce.CmdSetSpeedFraction": reshaped("eve/client/script/parklife/autopilot.py:434", throttling, "park.CmdSetSpeedFraction(1.0), on the ballpark's object, before the autopilot's approach; the ship's panel sends the pilot's own fraction (activeShipController.py 227). Recorded on Tranquility as (1.0), and every fraction as a float, which is how it goes. The menu's approach, keep at range and orbit send none before theirs, and on the game port the BFF's routes send none either; through the gateway they do."),
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
  "scanMgr.SetProbeDestination": webOnly(`${SCAN_SVC}:169`, "The client keeps a probe's destination itself and sends it with the next RequestScans. On the game port the transport keeps it the same way and sends nothing (pilots.js, callBoundMethod)."),
  "scanMgr.SetProbeRangeStep": webOnly(`${SCAN_SVC}:173`, "The client keeps a probe's range step itself and sends it with the next RequestScans. On the game port the transport keeps it the same way and sends nothing (pilots.js, callBoundMethod)."),
  "scanMgr.ConeScan": same("eve/client/script/parklife/directionalScanSvc.py:47", "ConeScan(scanAngle, scanRange, x, y, z)"),
  "dogmaIM.GetAllInfo": Object.freeze({
    status: "same",
    source: `${GODMA}:2409`,
    note: "GetDogmaLM().GetAllInfo(primeCharacter, primeShip, primeStructure): three positional, each saying whether that one is to be primed, which is whether godma holds it not: (True, True, None) at a session's first priming, (False, True, None) at each after it, the third True in a structure. The game port's own priming asks so. Asked with fewer by a route, it goes out as godma's first priming does: (True, True, None)",
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
  "agentMgr.GetAgents": judged(`${AGENTS}:92`, sentWithNothing,
    "agents = sm.RemoteSvc('agentMgr').GetAgents().Clone(), by name and with nothing: the whole table, kept for the life of the client's agents service. Recorded on Tranquility so, in two logins. The transport keeps the table as the client does, and answers the page's asking from it; the page keeps it too, and picks a station's agents from it as the client's docked view does."),
  "agentMgr.GetMyJournalDetails": same(`${JOURNAL_WINDOW}:312`, "RemoteSvc('agentMgr').GetMyJournalDetails(), no arguments"),
  "charMgr.GetPublicInfo": same("eve/client/script/ui/shared/info/panels/panelStandings.py:120", "RemoteSvc('charMgr').GetPublicInfo(ownerID): a character's public row, its corporation for its Show Info's Standings tab"),
  "corpmgr.GetCorporationIDForCharacter": same("eve/client/script/ui/shared/info/characterInfoWindow.py:111", "RemoteSvc('corpmgr').GetCorporationIDForCharacter(item_id): an NPC character's corporation, for its Show Info header, where it is no agent"),
  "corpmgr.GetCorporations": same(`${CORP_SVC}/bco_corporations.py:51`, "RemoteSvc('corpmgr').GetCorporations(corpid): another corporation's row, which the corporation service keeps (GetCorporation)"),
  "standingMgr.GetNPCNPCStandings": same(`${STANDING_SVC}:115`, "RemoteSvc('standingMgr').GetNPCNPCStandings(), no arguments: the NPCs' standings with each other, kept by the standing service"),
  "standingMgr.GetCharStandings": same(`${STANDING_SVC}:119`, "RemoteSvc('standingMgr').GetCharStandings(), no arguments"),
  "standingMgr.GetCorpStandings": same(`${STANDING_SVC}:126`, "RemoteSvc('standingMgr').GetCorpStandings(), no arguments, and only for a pilot whose corporation is not an NPC one (118)"),
  "standingMgr.GetStandingTransactions": ofAnEntity(`${STANDING_SVC}:178`, "RemoteSvc('standingMgr').GetStandingTransactions(fromID, toID): the entity, then the character. The panel asks it for a row that is the character's (standingsPanel.py 108), and the client keeps the answer for the two until the standing changes"),
  "standingMgr.GetStandingCompositions": ofAnEntity(`${STANDING_SVC}:283`, "RemoteSvc('standingMgr').GetStandingCompositions(fromID, toID): the entity, then the corporation. The panel asks it for a row that is the corporation's (standingsPanel.py 111); on Tranquility, GetStandingCompositions(500001, the corporation)"),
  // ── a station, its guests, the map's stations, a structure ────────────────
  "stationSvc.GetStationItemBits": same("eve/client/script/ui/station/base.py:575", "RemoteSvc('stationSvc').GetStationItemBits(), no arguments, while the item it has is not that of the station the session is in; the transport keeps it so (pilotStation.js)"),
  "station.GetGuests": same("eve/client/script/ui/station/base.py:103", "RemoteSvc('station').GetGuests(), no arguments, once for a station and kept, then changed at OnCharNowInStation and OnCharNoLongerInStation (86, 93); the transport keeps it so (pilotStation.js)"),
  "map.GetStationInfo": same("eve/client/script/ui/services/uisvc.py:246", "RemoteSvc('map').GetStationInfo(), no arguments"),
  "structureDirectory.GetMyCharacterStructures": same("eve/client/script/ui/services/structure/structureDirectory.py:65", "RemoteSvc('structureDirectory').GetMyCharacterStructures(), no arguments, kept by the client per region (GetMarketDockableLocationsInRegion) and for five seconds by the structure browser (GetStructures)"),
  "structureDirectory.GetStructureMapData": same("eve/client/script/ui/services/structure/structureDirectory.py:76", "RemoteSvc('structureDirectory').GetStructureMapData(solarsystemID), the system's structures for its items (mapSvc.GetSolarsystemItems), kept three minutes (Memoize(3))"),
  "structureDirectory.GetStructureInfo": same("eve/client/script/ui/services/structure/structureDirectory.py:38", "RemoteSvc('structureDirectory').GetStructureInfo(structureID), kept by structure"),
  // ── the reprocessing plant (the reprocessing service's Moniker) ───────────
  "reprocessingSvc.GetQuotes": judged("reprocessing/ui/quotes.py:20", quotingReprocessing,
    "GetReprocessingSvc().GetQuotes(itemIDs, activeShipID): the window's own dict of its items, each row by its item's ID, and the ship the pilot is in. Answers the place's tax, its efficiency by type, and each item's quote."),
  "inSpaceCompressionMgr.CompressItemInSpace": same("itemcompression/client/itemCompression.py:9",
    "sm.RemoteSvc('inSpaceCompressionMgr').CompressItemInSpace(compressibleItem.itemID, compressionFacilityBallID): from the compression window (compression_window.py 99) and the menu's Compress; answered (sourceItemID, sourceTypeID, sourceQuantity, outputItemID, outputTypeID, outputQuantity), or None, after which the client says nothing. In no recording."),
  "reprocessingSvc.Reprocess": judged("reprocessing/ui/itemReprocessor.py:71", reprocessingItems,
    "GetReprocessingSvc().Reprocess(itemIDs, fromLocation, ownerID, outputLocationID, outputFlagID): the items a list, the output named always. Answers the items reprocessed and what they made, by type."),
  "structureSettings.CharacterGetService": judged("eve/client/script/ui/services/marketsvc.py:239", ofAStructuresMarket,
    "RemoteSvc('structureSettings').CharacterGetService(structureID, structures.SERVICE_MARKET): a structure's market tax for the pilot, a percentage, which the client's market service asks before it works out the broker's fee there, and keeps two minutes by the structure (GetMarketTaxAtStructure, Memoize(2), 237). The transport asks and keeps it so."),
  "structureGuests.GetGuests": judged("eve/client/script/ui/services/structure/structureGuests.py:25", ofTheStructureDockedIn,
    "RemoteSvc('structureGuests').GetGuests(session.structureid): asked once for the structure the pilot is docked in and kept, then changed at OnCharacterEnteredStructure and OnCharacterLeftStructure (36, 40), and let go when the session's structure changes (31). The transport keeps it so (pilotStructureGuests.js)."),
  "structureSettings.CharacterGetServices": judged("eve/client/script/ui/services/structure/structureServices.py:56", ofOneStructure,
    "RemoteSvc('structureSettings').CharacterGetServices(structureID): asked as the pilot docks in a structure and kept for it, and asked again when the server says its services changed (21 to 24, 48 to 52); asked each time for any other structure (35). The transport keeps it so."),

  // ── an agent's place and a mission's keywords ─────────────────────────────
  "agentMgr.GetSolarSystemOfAgent": same(`${AGENTS}:801`, "RemoteSvc('agentMgr').GetSolarSystemOfAgent(agentID), kept by agent"),
  "agentMgr.GetMissionKeywords": same(`${AGENTS}:633`, "GetAgentMoniker(agentID).GetMissionKeywords(contentID), on the agent's own object"),

  // ── a corporation's assets ────────────────────────────────────────────────
  "corpmgr.GetPublicInfo": same("eve/client/script/ui/shared/info/corporationInfoWindow.py:49", "RemoteSvc('corpmgr').GetPublicInfo(item_id): Show Info on a corporation"),
  "corpmgr.GetAggressionSettings": same(`${CORP_SVC}/base_corporation.py:259`, "RemoteSvc('corpmgr').GetAggressionSettings(corpID): the friendly fire row of a corporation's Show Info, kept per corporation"),
  "fwCharacterEnlistmentMgr.SetMyCorpAllowedEnlistmentFactions": same("eve/client/script/ui/services/fwEnlistmentSvc.py:107", "RemoteSvc('fwCharacterEnlistmentMgr').SetMyCorpAllowedEnlistmentFactions(allowedFactionIDs): the corporation window's Direct Enlistment, Apply"),
  "fwCharacterEnlistmentMgr.GetCorpAllowedEnlistmentFactions": same("eve/client/script/ui/services/fwEnlistmentSvc.py:104", "RemoteSvc('fwCharacterEnlistmentMgr').GetCorpAllowedEnlistmentFactions(corporationID): a player corporation's Show Info"),
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
  "charMgr.AddContact": typing(same("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:789", "eveMisc.CSPAChargedAction('CSPAContactNotifyCheck', sm.RemoteSvc('charMgr'), 'AddContact', contactID, relationshipID, inWatchlist, sendNotification, message): from the contact management window, the standing one of the five, the buddy list's box and the notification's a bool each, the message the editor's (the empty byte string where it holds nothing). An agent is added with its contactID alone (733). In no recording."), [4]),
  "charMgr.EditContact": typing(same("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:789", "eveMisc.CSPAChargedAction('CSPAContactNotifyCheck', sm.RemoteSvc('charMgr'), 'EditContact', contactID, relationshipID, inWatchlist, sendNotification, message): as AddContact, for a contact the pilot has. In no recording."), [4]),
  "charMgr.DeleteContacts": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:842", ownersListed, "sm.RemoteSvc('charMgr').DeleteContacts(contactIDs): the contacts a list, after the RemoveOneFromContacts or RemoveManyFromContacts question. In no recording."),
  "charMgr.BlockOwners": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:658", ownersListed, "sm.RemoteSvc('charMgr').BlockOwners([ownerID]): one owner, in a list, not the pilot, no NPC's and none blocked already. In no recording."),
  "charMgr.UnblockOwners": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:674", ownersListed, "sm.RemoteSvc('charMgr').UnblockOwners(blocked): the owners blocked among those named, a list. In no recording."),
  "charMgr.GetLabels": same("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1029", "GetContactLabels('contact'): RemoteSvc('charMgr').GetLabels(), no arguments, by the service's name: the pilot's contact labels, asked as the Contacts window's labels are first shown (contactsForm.py GetLabelsSubContent) and kept. In no recording."),
  "charMgr.EditContactsRelationshipID": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:688", ownersListed, "sm.RemoteSvc('charMgr').EditContactsRelationshipID(contactIDs, relationshipID): from the window that edits several contacts (ContactManagementMultiEditWnd), the contacts selected a list and the standing one of the five. In no recording."),
  "charMgr.CreateLabel": typing(same("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1016", "CreateContactLabel(name): self.GetSvc().CreateLabel(name, color), the color None, from the Manage Labels window's Create (evemail.py ManageLabelsBase.CreateLabel), the name its field's, stripped, unicode; answered the label's bit. In no recording."), [0]),
  "charMgr.EditLabel": typing(reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1004", labelFirst, "EditContactLabel(labelID, name=name): self.GetSvc().EditLabel(labelID, name, color), a rename (RenameContactLabelFromUI, 990 to 999), the name the popup's, stripped, unicode, and the color None. In no recording."), [1]),
  "charMgr.DeleteLabel": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1073", labelFirst, "self.GetSvc().DeleteLabel(labelID), after the DeleteMailLabel dialog (DeleteContactLabelFromUI, 1067 to 1070); then the labels asked again (1074 to 1084). In no recording."),
  "charMgr.AssignLabels": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1097", ownersLabelled, "self.GetSvc().AssignLabels(selIDs, labelID): the contacts a list and the label's bit, or from the Manage Labels window the sum of the labels ticked (manageLabels.py 76 to 78). In no recording."),
  "charMgr.RemoveLabels": reshaped("eve/client/script/ui/shared/neocom/addressBook/addressbookService.py:1134", ownersLabelled, "self.GetSvc().RemoveLabels(selIDs, labelID): as AssignLabels, the label taken off. In no recording."),
  "onlineStatus.GetInitialState": same("eve/client/script/ui/shared/comtool/onlineStatus.py:79", "RemoteSvc('onlineStatus').GetInitialState(), no arguments: asked once (Prime), as the character is chosen, and kept by contact"),
  "onlineStatus.GetOnlineStatus": same("eve/client/script/ui/shared/comtool/onlineStatus.py:56", "RemoteSvc('onlineStatus').GetOnlineStatus(charID), for a character the kept state does not have, and kept"),
  "onlineStatus.Prime": webOnly("eve/client/script/ui/shared/comtool/onlineStatus.py:74", "The client never asks this of the server. Prime is its own service's method, which asks GetInitialState() once."),
  "home_station.get_home_station": same("homestation/client/service.py:67", "RemoteSvc('home_station').get_home_station(), no arguments: asked once and kept, until the server says the home station changed or was moved from its structure, or the pilot's corporation changes. Recorded on Tranquility at a login and after OnHomeStationChanged"),
  "charMgr.GetHomeStationRow": same("eve/client/script/ui/shared/neocom/charactersheet.py:59", "RemoteSvc('charMgr').GetHomeStationRow(), no arguments, asked once and kept until the session is reset"),
  "charMgr.GetHomeStation": webOnly("eve/client/script/ui/shared/neocom/charactersheet.py:59", "The client never asks this of charMgr: its character sheet's service asks GetHomeStationRow()."),
  "charMgr.GetCloneInfo": webOnly("eve/client/script/ui/services/clonejumpsvc.py:76", "The client never asks this. Its jump clones, their implants and the time of the last jump come from GetCloneState() on the jumpCloneSvc moniker for where the pilot is; the implants in the pilot's head are what its skill handler answers GetImplants() with (skillsvc.py 967), which godma's 'implants' of the character hands on."),
  "charMgr.ListStationItems": judged(`${INV_CACHE}:849`, oneStationAlone,
    "invCache's global container: self.moniker.ListStationItems(stationID), with the one station. No recording has one. The client keeps each station's answer five minutes; the page asks each time a station is opened in its assets window, and the transport keeps nothing of it."),
  "charMgr.ListIncludingContainers": judged(`${INV_CACHE}:880`, sentWithNothing,
    "invCache's global container: self.moniker.ListIncludingContainers(), with nothing, for the assets window's search (assetsWindow.py 415). No recording has one. The client keeps the answer five minutes (_DeleteCachedItemsAll); so does the page's flow."),
  "charMgr.ListStations": judged(`${INV_CACHE}:833`, sentWithNothing,
    "invCache's global container, Moniker('charMgr', (session.charid, const.containerGlobal)): self.moniker.ListStations(), with nothing. Recorded on Tranquility so, three times, twice riding the bind. The client keeps the answer five minutes; the page asks each time its assets window asks, and the transport keeps nothing of it."),

  // ── industry ──────────────────────────────────────────────────────────────
  "blueprintManager.GetBlueprintDataByOwner": same(`${INDUSTRY}/blueprintSvc.py:150`, "RemoteSvc('blueprintManager').GetBlueprintDataByOwner(ownerID, None), or with a facility's ID for the blueprints at one (137)"),
  "industryManager.GetJobsByOwner": same(`${INDUSTRY}/industrySvc.py:73`, "RemoteSvc('industryManager').GetJobsByOwner(ownerID, includeCompleted)"),
  "industryManager.GetJobCounts": same(`${INDUSTRY}/industrySvc.py:243`, "RemoteSvc('industryManager').GetJobCounts(session.charid)"),
  "industryManager.CompleteJob": judged(`${INDUSTRY}/industrySvc.py:150`, aJobAndItsSystem, "RemoteSvc('industryManager').CompleteJob(int(jobID), solarSystemID), the system the job's own, from a ready job's button. No recording has one."),
  "industryManager.CancelJob": judged(`${INDUSTRY}/industrySvc.py:160`, aJobAndItsSystem, "RemoteSvc('industryManager').CancelJob(int(jobID), solarSystemID), the system the job's own, from a running job's button, pressed twice. No recording has one."),
  "industryManager.InstallJob": reshaped(`${INDUSTRY}/industrySvc.py:141`, jobDumped, "RemoteSvc('industryManager').InstallJob(job.dump()): the job's dump, a dict of seventeen names (industry/job.py 624 to 640). The route's plain object is made that dict, its places the client's own objects. A manufacturing job's time, its cost and its tax are the client's own reckoning (industry/job.py 460 to 468, 310 to 320 and 450 to 458); any other job's go as nought. No recording has one."),
  "industryMonitor.ConnectJob": reshaped(`${INDUSTRY}/industrySvc.py:307`, jobDumped, "RemoteSvc('industryMonitor').ConnectJob(job.dump()), once the job has a place to take its materials from: the same dump, made the same dict."),
  "industryMonitor.DisconnectJob": judged(`${INDUSTRY}/industrySvc.py:313`, aMonitorLetGo, "RemoteSvc('industryMonitor').DisconnectJob(job.monitorID if job else None)."),
  "facilityManager.GetFacilityLocations": judged(`${INDUSTRY}/facilitySvc.py:118`, aFacilityAndAnOwner,
    "self.facilityManager.GetFacilityLocations(facilityID, ownerID): the facility, and the owner the job is for (the blueprint's: the pilot, or its corporation). Asked when a job is given a facility (industrySvc.LoadLocations, 319), and kept by the client's facility service a while (Memoize, 113). No recording has anything of industry."),
  "blueprintManager.GetBlueprintData": judged(`${INDUSTRY}/blueprintSvc.py:96`, oneIDAlone("a blueprint's ID"),
    "self.blueprintManager.GetBlueprintData(blueprintID): the blueprint's own item, alone (blueprintSvc.GetBlueprintItem). The BFF asks it once a job is installed, to see the blueprint is in the job."),
  "industryManager.GetJob": judged(`${INDUSTRY}/industrySvc.py:60`, oneIDAlone("a job's ID"),
    "sm.RemoteSvc('industryManager').GetJob(jobID): the job alone (industrySvc.GetJobByID). The BFF asks it once a job is installed, delivered or stopped, to see what became of it."),
  "facilityManager.GetFacilities": same(`${INDUSTRY}/facilitySvc.py:133`, "RemoteSvc('facilityManager').GetFacilities(), no arguments"),
  "facilityManager.GetMaxActivityModifiers": same(`${INDUSTRY}/facilitySvc.py:87`, "RemoteSvc('facilityManager').GetMaxActivityModifiers(), no arguments"),

  // ── mail and notifications ────────────────────────────────────────────────
  "mailingListsMgr.Create": typing(same("eve/client/script/ui/services/mail/mailingListsSvc.py:68", "sm.RemoteSvc('mailingListsMgr').Create(name, defaultAccess, defaultMemberAccess, cost): from the mail window's Create, the defaults 1, 1 and 0; answered the list's number. In no recording. The name as typed, unicode."), [0]),
  "mailingListsMgr.Join": typing(same("eve/client/script/ui/services/mail/mailingListsSvc.py:75", "self.mailingListsMgr.Join(name): by the list's name; answered the list's KeyVal. In no recording. The name as typed, unicode."), [0]),
  "mailingListsMgr.Leave": same("eve/client/script/ui/services/mail/mailingListsSvc.py:81", "self.mailingListsMgr.Leave(listID). In no recording."),
  "mailingListsMgr.Delete": same("eve/client/script/ui/services/mail/mailingListsSvc.py:91", "self.mailingListsMgr.Delete(listID): the owner's, from the list's menu after the DeleteMailingList dialog (evemail.py 505 to 508). In no recording."),
  "mailingListsMgr.GetSettings": same("eve/client/script/ui/services/mail/mailingListsSvc.py:142", "self.mailingListsMgr.GetSettings(listID): asked three times as the management window opens, its Access panel being built first (evemailingListConfig.py 378, 389, 437), and again after a kick; answered a KeyVal of defaultAccess, defaultMemberAccess, cost and access. In no recording."),
  "mailingListsMgr.GetMembers": same("eve/client/script/ui/services/mail/mailingListsSvc.py:106", "self.mailingListsMgr.GetMembers(listID): each time the management window's Members tab shows its members (UpdateMembersScroll, evemailingListConfig.py 167); answered a dict of each member's number and place. In no recording."),
  "mailingListsMgr.SetMembersClear": reshaped("eve/client/script/ui/services/mail/mailingListsSvc.py:133", membersListed, "self.mailingListsMgr.SetMembersClear(listID, memberIDs): the Members tab's Set role: Member, the members chosen a list. In no recording."),
  "mailingListsMgr.SetMembersMuted": reshaped("eve/client/script/ui/services/mail/mailingListsSvc.py:123", membersListed, "self.mailingListsMgr.SetMembersMuted(listID, memberIDs): the Members tab's Set role: Muted member, the members chosen a list. In no recording."),
  "mailingListsMgr.SetMembersOperator": reshaped("eve/client/script/ui/services/mail/mailingListsSvc.py:128", membersListed, "self.mailingListsMgr.SetMembersOperator(listID, memberIDs): the Members tab's Set role: Operator, the members chosen a list. In no recording."),
  "mailingListsMgr.KickMembers": reshaped("eve/client/script/ui/services/mail/mailingListsSvc.py:101", membersListed, "self.mailingListsMgr.KickMembers(listID, memberIDs): the Members tab's Kick, the members chosen a list. In no recording."),
  "mailingListsMgr.SetDefaultAccess": same("eve/client/script/ui/services/mail/mailingListsSvc.py:138", "self.mailingListsMgr.SetDefaultAccess(listID, defaultAccess, defaultMemberAccess, mailCost): the Access tab's Apply with its two choices, the cost 0 (evemailingListConfig.py ApplySettings, 453 to 457). In no recording."),
  "mailingListsMgr.SetEntitiesAccess": reshaped("eve/client/script/ui/services/mail/mailingListsSvc.py:115", accessListed, "self.mailingListsMgr.SetEntitiesAccess(listID, accessByEntityID): the Access tab's Allow or Block, the one owner picked as {entityID: access} (SetEntityAccess, 110 to 111). In no recording."),
  "mailingListsMgr.ClearEntityAccess": same("eve/client/script/ui/services/mail/mailingListsSvc.py:119", "self.mailingListsMgr.ClearEntityAccess(listID, entityID): the Access tab's Remove Selected, one call for each chosen (evemailingListConfig.py 302 to 309). In no recording."),
  "lookupSvc.LookupPCOwners": typing(same("eve/client/script/ui/util/searchOld.py:259", "sm.RemoteSvc('lookupSvc').LookupPCOwners(searchStr, exact): SearchOwners with hideNPC, from the mailing list window's Allow and Block, exact False; answered a list of owner rows. In no recording. The text as typed, unicode."), [0]),
  "mailingListsMgr.GetWelcomeMail": same("eve/client/script/ui/services/mail/mailingListsSvc.py:183", "self.mailingListsMgr.GetWelcomeMail(listID): as the management window's Welcome Mail tab is shown, until one is had (evemailingListConfig.py Load 528 to 530, UpdateWelcome 482 to 492); answered a list of it, a KeyVal of title and body, or of nothing. In no recording."),
  "mailingListsMgr.SaveWelcomeMail": typing(same("eve/client/script/ui/services/mail/mailingListsSvc.py:186", "self.mailingListsMgr.SaveWelcomeMail(listID, title, body): the Welcome Mail tab's Save, the box not ticked; the body the editor's markup. In no recording. The subject and the body as typed, unicode (the subject a byte string where the pilot leaves the server's as it was loaded and the server gave one, which the page does not tell apart)."), [1, 2]),
  "mailingListsMgr.SendWelcomeMail": typing(same("eve/client/script/ui/services/mail/mailingListsSvc.py:189", "self.mailingListsMgr.SendWelcomeMail(listID, title, body): the Welcome Mail tab's Save with its box ticked (SaveAndSendWelcomeMail); the body the editor's markup. In no recording. The subject and the body as typed, unicode (the subject a byte string where the pilot leaves the server's as it was loaded and the server gave one, which the page does not tell apart)."), [1, 2]),
  "mailingListsMgr.ClearWelcomeMail": same("eve/client/script/ui/services/mail/mailingListsSvc.py:192", "self.mailingListsMgr.ClearWelcomeMail(listID): the Welcome Mail tab's Save with no subject and no mail. In no recording."),
  "mailingListsMgr.GetInfo": same("eve/client/script/ui/services/mail/mailingListsSvc.py:61", "self.mailingListsMgr.GetInfo(listID): GetDisplayName's ask for a list neither joined nor asked before, kept after (55 to 66): a list's own mail at a sync or as it comes, a mail to a list as it is opened or quoted; answered the list's KeyVal, or None. In no recording."),
  "search.Query": reshaped("eve/client/script/ui/util/searchUtil.py:278", searchTextUnicode, "sm.ProxySvc('search').Query(searchStr, groupIDList, exact=searchBy): the text as the edit gives it with its * taken out and stripped, a unicode string; the result types a list; Search By the keyword exact. From the People & Places window's Search tab (addressBookWindow.py SearchPanel._search, 351 to 363) the kinds of its Search Type: for Any [2, 3, 4, 1, 5]. Answered a dict of each kind's IDs. In no recording."),
  "search.QuickQuery": reshaped("eve/client/script/ui/util/searchUtil.py:301", searchTextUnicode, "sm.ProxySvc('search').QuickQuery(searchStr, groupIDList, hideNPC=hideNPC, onlyAltName=onlyAltName, exact=searchBy): the text a unicode string, the result types a list; a mail's recipient a character ([2]) with hideNPC 1, by the exact phrase (2) from the compose window's field, or by Search By from its search window. Tranquility's recording of a contracts search has QuickQuery(u'harper frost', [2, 3]) with hideNPC, exact, onlyAltName, machoVersion, answered a list of numbers."),
  "mailingListsMgr.GetJoinedLists": same("eve/client/script/ui/services/mail/mailingListsSvc.py:43", "self.mailingListsMgr.GetJoinedLists(), no arguments, as the mailing lists service starts, which it does as the mail window first draws its lists group; kept. Tranquility's recording of the mail window opened has it after GetLabels, answered {}."),
  "mailMgr.GetLabels": same(`${MAIL_SERVICES}/mailSvc.py:678`, "self.mailMgr.GetLabels(), no arguments; asked once as the mail window first draws its folders, and kept. Tranquility's recording of the mail window opened has it after SyncMail(None, 0), answered {}."),
  "mailMgr.GetMailHeaders": reshaped(`${MAIL_SERVICES}/mailSvc.py:193`, recipientsListed, "self.mailMgr.GetMailHeaders(toFetch.keys()): one list of the messages the sync gave a status of whose header the client does not hold. In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.GetBody": same(`${MAIL_SERVICES}/mailSvc.py:512`, "self.mailMgr.GetBody(messageID, shouldMarkAsRead): whether to mark it read a bool, true for a message not read; answered the body deflated, or None. In no recording."),
  "mailMgr.MarkAsUnread": reshaped(`${MAIL_SERVICES}/mailSvc.py:326`, recipientsListed, "self.mailMgr.MarkAsUnread(messageIDs): a list; the mail window's Mark as Unread. In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.MoveToTrash": reshaped(`${MAIL_SERVICES}/mailSvc.py:294`, recipientsListed, "self.mailMgr.MoveToTrash(messageIDs): a list; the mail window's Trash. In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.MoveFromTrash": reshaped(`${MAIL_SERVICES}/mailSvc.py:305`, recipientsListed, "self.mailMgr.MoveFromTrash(messageIDs): a list; the mail window's Restore. In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.DeleteMail": reshaped(`${MAIL_SERVICES}/mailSvc.py:480`, recipientsListed, "self.mailMgr.DeleteMail(messageIDs): a list; the mail window's Delete of a trashed message. In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.MarkAllAsRead": same(`${MAIL_SERVICES}/mailSvc.py:417`, "self.mailMgr.MarkAllAsRead(), no arguments; the mail window's Mark All as Read of All Mails, asked to be sure of. In no recording."),
  "mailMgr.MarkAsReadByLabel": same(`${MAIL_SERVICES}/mailSvc.py:428`, "self.mailMgr.MarkAsReadByLabel(labelID); the mail window's Mark All as Read of a folder, asked to be sure of. In no recording."),
  "mailMgr.MarkAsReadByList": same(`${MAIL_SERVICES}/mailSvc.py:439`, "self.mailMgr.MarkAsReadByList(listID); a mailing list's Mark All as Read, asked to be sure of. In no recording."),
  "mailMgr.MoveAllToTrash": same(`${MAIL_SERVICES}/mailSvc.py:352`, "self.mailMgr.MoveAllToTrash(), no arguments; the mail window's Trash All of All Mails, asked to be sure of. In no recording."),
  "mailMgr.MoveToTrashByLabel": same(`${MAIL_SERVICES}/mailSvc.py:362`, "self.mailMgr.MoveToTrashByLabel(labelID); the mail window's Trash All of a folder, asked to be sure of. In no recording."),
  "mailMgr.MoveToTrashByList": same(`${MAIL_SERVICES}/mailSvc.py:373`, "self.mailMgr.MoveToTrashByList(listID); a mailing list's Trash All, asked to be sure of. In no recording."),
  "mailMgr.MoveAllFromTrash": same(`${MAIL_SERVICES}/mailSvc.py:450`, "self.mailMgr.MoveAllFromTrash(), no arguments; the trash's Restore All, asked to be sure of. In no recording."),
  "mailMgr.CreateLabel": typing(same(`${MAIL_SERVICES}/mailSvc.py:734`, "self.mailMgr.CreateLabel(name, color): from the labels window, the colour None; answered the label's bit. In no recording. The name the labels window's field's, stripped, unicode (evemail.py 1563 to 1578)."), [0]),
  "mailMgr.EditLabel": typing(same(`${MAIL_SERVICES}/mailSvc.py:715`, "self.mailMgr.EditLabel(labelID, name, color): a rename, the colour None (RenameLabelFromUI, 1290 to 1299), or Assign Color, the name None and the colour a swatch's number (ChangeLabelColorFromUI, 1301 to 1309). In no recording. The name the popup's, stripped, unicode."), [1]),
  "mailMgr.DeleteLabel": same(`${MAIL_SERVICES}/mailSvc.py:741`, "self.mailMgr.DeleteLabel(labelID), after the DeleteMailLabel dialog (1314 to 1317). In no recording."),
  "mailMgr.AssignLabels": reshaped(`${MAIL_SERVICES}/mailSvc.py:765`, recipientsListed, "self.mailMgr.AssignLabels(mailsToGetLabel.keys(), labelID): the messages that lack the label, a list, and the label. In no recording."),
  "mailMgr.RemoveLabels": reshaped(`${MAIL_SERVICES}/mailSvc.py:783`, recipientsListed, "self.mailMgr.RemoveLabels(mailsToRemoveLabelFrom.keys(), labelID): the messages that have the label, a list, and the label. In no recording."),
  "mailMgr.EmptyTrash": same(`${MAIL_SERVICES}/mailSvc.py:460`, "self.mailMgr.EmptyTrash(), no arguments; the trash's Empty Trash, asked to be sure of. In no recording."),
  "mailMgr.MarkAsRead": reshaped(`${MAIL_SERVICES}/mailSvc.py:339`, recipientsListed, "self.mailMgr.MarkAsRead(messageIDs): a list; asked by GetBody for a body kept of a message not read (497 to 498). In no recording. The messages a list, as the client's are; the page's array goes as one."),
  "mailMgr.SyncMail": same(`${MAIL_SERVICES}/mailSvc.py:157`, "RemoteSvc('mailMgr').SyncMail(firstID, lastID): the lowest and highest message IDs the client holds, (None, 0) when it holds none"),
  "mailMgr.SendMail": typing(reshaped(`${MAIL_SERVICES}/mailSvc.py:965`, recipientsListed,
    "self.mailMgr.SendMail(toCharacterIDs, toListID, toCorpOrAllianceID, title, body, isReplyTo, isForwardedFrom), through eveMisc.CSPAChargedAction: the recipients a list (the compose window's self.toChars.values(), evemail.py 2281), the message answered and the one forwarded 0 for none. In no recording. The subject and the body unicode, the body the empty byte string where the editor holds nothing."), [3, 4]),
  "notificationMgr.GetByGroupID": same(`${MAIL_SERVICES}/notificationSvc.py:64`, "RemoteSvc('notificationMgr').GetByGroupID(groupID)"),
  "notificationMgr.DeleteNotifications": reshaped(`${MAIL_SERVICES}/notificationSvc.py:319`, notificationsListed, "self.notificationMgr.DeleteNotifications(notificationIDs): the notifications a list, from the Contacts tab's notification entry's Delete notification ([self.notificationID]: contactNotificationEntry.py DeleteNotifications), a hundred at most. In no recording."),
  "notificationMgr.MarkAsProcessed": reshaped(`${MAIL_SERVICES}/notificationSvc.py:258`, notificationsListed, "self.notificationMgr.MarkAsProcessed(notificationsList): the unread ones of those given, a list, a hundred at most; from the notification window's reading pane (neocom/notifications.py LoadReadingPane, 297 to 305) and its entry's Mark as read. Tranquility's recording of a notification read in the window: MarkAsProcessed([2413004682L])."),
  "notificationMgr.MarkGroupAsProcessed": same(`${MAIL_SERVICES}/notificationSvc.py:224`, "self.notificationMgr.MarkGroupAsProcessed(groupID): a group's Mark All As Read in the notification window, where the group has an unread one and the dialog EvemailNotificationsMarkGroupRead is answered yes. In no recording."),
  "notificationMgr.MarkAllAsProcessed": same(`${MAIL_SERVICES}/notificationSvc.py:232`, "self.notificationMgr.MarkAllAsProcessed(), no arguments: the notification window's Mark All As Read, where any is unread, after the dialog EvemailNotificationsMarkAllRead. In no recording."),
  "notificationMgr.DeleteGroupNotifications": same(`${MAIL_SERVICES}/notificationSvc.py:291`, "self.notificationMgr.DeleteGroupNotifications(groupID): a group's Delete All in the notification window, where the group has any, after the dialog EvemailNotificationsDeleteGroup. In no recording."),
  "notificationMgr.DeleteAllNotifications": same(`${MAIL_SERVICES}/notificationSvc.py:301`, "self.notificationMgr.DeleteAllNotifications(), no arguments: the notification window's Delete All, after the dialog EvemailNotificationsDeleteAll. In no recording."),
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
  "fleetObjectHandler.CreateFleet": same(
    `${FLEET_SVC}:334`,
    "CreateFleet: self.fleet = sm.RemoteSvc('fleetObjectHandler').CreateFleet(), by the service's name and with nothing, from a session in no fleet (332: with one it raises FleetError and asks nothing). It answers the fleet's own object, which Init is asked on next (336).",
  ),
  "fleetObjectHandler.Init": needing(reshaped(`${FLEET_SVC}:336`, fleetInit, "self.fleet.Init(self.GetMyShipTypeID(), setupName, adInfoData=adInfoData), on the object CreateFleet answered"), "dogma"),
  "fleetObjectHandler.AcceptInvite": needing(reshaped(`${FLEET_SVC}:1194`, withOwnShipType, "GetFleet(fleetID).AcceptInvite(self.GetMyShipTypeID()), on the invite's fleet's Moniker, which binds with it and is the fleet's object from then"), "dogma"),
  "fleetObjectHandler.UpdateMemberInfo": needing(reshaped(`${FLEET_SVC}:1807`, withOwnShipType, "self.fleet.UpdateMemberInfo(self.GetMyShipTypeID())"), "dogma"),
  "fleetObjectHandler.RejectInvite": judged(`${FLEET_SVC}:1198`, turningDown, "GetFleet(fleetID).RejectInvite(), and RejectInvite(True) from a pilot already in a fleet (1180), RejectInvite(False) where invitations are turned away unasked (1184)"),
  "fleetObjectHandler.Invite": judged(`${FLEET_SVC}:362`, inviting, "CSPAChargedAction('CSPAFleetCheck', self.fleet, 'Invite', charID, wingID, squadID, role): self.fleet.Invite(...) on the fleet's object, None for a wing, squad or role not named; asked again with approvedCost= where the server says the contact costs and the user agrees. A pilot in no fleet forms one first (352)"),
  // Its writes.
  "fleetObjectHandler.CreateWing": same(`${FLEET_SVC}:577`, "self.fleet.CreateWing(), no arguments; a wing that was made is given a squad at once (CreateSquad(wingID), 579)"),
  "fleetObjectHandler.CreateSquad": same(`${FLEET_SVC}:589`, "self.fleet.CreateSquad(wingID)"),
  "fleetObjectHandler.MoveMember": same(`${FLEET_SVC}:518`, "self.fleet.MoveMember(charID, wingID, squadID, role)"),
  "fleetObjectHandler.MakeLeader": same(`${FLEET_SVC}:604`, "self.fleet.MakeLeader(charID), once the user has agreed"),
  "fleetObjectHandler.SetMotdEx": same(`${FLEET_SVC}:1961`, "self.fleet.SetMotdEx(motd)"),
  "fleetObjectHandler.KickMember": judged(`${FLEET_SVC}:611`, kickingAnother, "self.fleet.KickMember(charID), for any member but the pilot's own"),
  "fleetObjectHandler.SendBroadcast": judged(`${FLEET_SVC}:989`, aGlobalBroadcast, "self.fleet.SendBroadcast(name, self.broadcastScope, itemID, typeID), on the fleet's object, after the client's own checks and wait"),
  "fleetObjectHandler.DisbandFleet": judged(`${FLEET_SVC}:617`, disbandingAsBoss, "self.fleet.DisbandFleet(), no arguments, for the fleet's boss"),
  "fleetObjectHandler.SetOptions": reshaped(`${FLEET_SVC}:449`, fleetOptionsCopy, "self.fleet.SetOptions(options): a copy of the options the client keeps, free move changed"),
  "fleetObjectHandler.Reconnect": same(`${FLEET_SVC}:1714`, "GetFleet(fleetID).Reconnect(), no arguments, on a Moniker for the fleet the connection was lost in"),
  "fleetObjectHandler.LeaveFleet": judged(`${FLEET_SVC}:369`, leavingOnTheObject, "self.fleet.LeaveFleet(), no arguments, on the fleet's object"),
  "fleetProxy.GetAvailableFleetAds": judged(`${FLEET_SVC}:1891`, sentWithNothing, "sm.ProxySvc('fleetProxy').GetAvailableFleetAds(), nothing sent: the adverts open to the session, from the fleet finder's window, the Agency's and a fleet's link. Recorded on Tranquility so, once."),
  "fleetProxy.GetMyFleetFinderAdvert": judged(`${FLEET_SVC}:2394`, askingItsFleetsAdvert, "sm.ProxySvc('fleetProxy').GetMyFleetFinderAdvert(), nothing sent, and only from a session in a fleet (1924). No recording has one."),
  "fleetProxy.ApplyToJoinFleet": judged(`${FLEET_SVC}:1907`, applyingToOneFleet,
    "sm.ProxySvc('fleetProxy').ApplyToJoinFleet(fleetID, autoAccept): from the fleet finder and a fleet's link with False, from the Agency's join window with True. It answers True where the boss must approve and False where an invitation was made. No recording has one."),
  // ── drones: eveMoniker.GetEntityAccess(), a Moniker made for each order ──
  "entity.CmdEngage": reshaped(`${DRONE_FUNCTIONS}:93`, dronesListed,
    "eveMoniker.GetEntityAccess().CmdEngage(droneIDs, targetID): the drones a list and the active target, on a Moniker made for the order. Recorded on Tranquility so fifty times, each riding its own bind and answering the drones that could not, which was none."),
  "entity.CmdReturnBay": reshaped(`${DRONE_FUNCTIONS}:187`, dronesListed,
    "eveMoniker.GetEntityAccess().CmdReturnBay(droneIDs): the drones a list. Recorded on Tranquility so eleven times, each riding its own bind."),
  "entity.CmdMineRepeatedly": reshaped(`${DRONE_FUNCTIONS}:151`, dronesListed,
    "eveMoniker.GetEntityAccess().CmdMineRepeatedly(droneIDs, targetID): the drones a list and the active target. No recording has one."),
  "entity.CmdReconnectToDrones": reshaped(`${DRONE_FUNCTIONS}:254`, dronesListed,
    "eveMoniker.GetEntityAccess().CmdReconnectToDrones(droneCandidates), on a Moniker made for the order: the candidates a list of the balls in the park that are the pilot's drones and not under its control (ReconnectToDrones, 215 to 233, at most MAX_DRONE_RECONNECTS), from Reconnect to Lost Drones. It answers each failure as a UserError's name and values, which the client raises five seconds apart (256 to 258). In no recording."),
  "entity.CmdSalvage": reshaped(`${DRONE_FUNCTIONS}:160`, salvaging,
    "eveMoniker.GetEntityAccess().CmdSalvage(droneIDs, targetID): the drones a list, and the active target or None, from a salvage drone's menu and the drones' primary action. It answers the drones that could not, each with why. No recording has one."),
  "accessGroupBookmarkMgr.BookmarkStaticLocation": typing(Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:612",
    note: "self.accessGroupBookmarkMgr.BookmarkStaticLocation(itemID, folderID, name, comment, expiry, subfolderID=subfolderID): the bookmark window's Submit (bookmarkLocationWindow.py Confirm, 205 to 225) for a region, a constellation, a system or a station; the name the label's, the comment the notes' editor's, each unicode where it holds text; answered (bookmarkID, itemID, typeID, x, y, z, locationID, expiryDate). In no recording.",
    shape: bookmarkingStatic,
  }), [2, 3]),
  "accessGroupBookmarkMgr.UpdateBookmark": typing(Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:646",
    note: "self.accessGroupBookmarkMgr.UpdateBookmark(bookmarkID, folderID, name, note, subfolderID, newFolderID, expiryCancel): the bookmark window's Submit in its edit (Edit Location, a bookmark's menu or its double click); the name the label's and the note the editor's, unicode where they hold text. In no recording.",
    shape: updatingBookmark,
  }), [2, 3]),
  "accessGroupBookmarkMgr.DeleteBookmarks": reshaped("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:664", bookmarksOfFolder, "self.accessGroupBookmarkMgr.DeleteBookmarks(folderID, bookmarks), each folder's bookmarks a set, from Remove Location after RemoveLocation or RemoveMultipleLocation; answered the ones deleted. In no recording."),
  "accessGroupBookmarkMgr.CreateSubfolder": typing(judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:565", subfolderMade,
    "self.accessGroupBookmarkMgr.CreateSubfolder(folderID, subfolderName): the subfolder window's Submit (bookmarkSubfolderWindow.py Confirm, 104 to 122), from Create Subfolder at the Locations window's bottom or a folder's menu; the name the edit's, stripped, unicode. Answered the subfolder. In no recording."), [1]),
  "accessGroupBookmarkMgr.UpdateSubfolder": typing(judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:572", subfolderRenamed,
    "self.accessGroupBookmarkMgr.UpdateSubfolder(folderID, subfolderID, subfolderName): the subfolder window's Submit in its edit (Edit Subfolder, a subfolder's menu); the name unicode. Answered whether the subfolder was there; the client says BookmarkSubfolderNoLongerThere where it was not. In no recording."), [2]),
  "accessGroupBookmarkMgr.DeleteSubfolder": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:589", subfolderDeleted,
    "self.accessGroupBookmarkMgr.DeleteSubfolder(subfolder.folderID, subfolderID): Delete Subfolder, a subfolder's menu, after ConfirmDeleteSubfolder. Answered the bookmarks deleted with it. In no recording."),
  "accessGroupBookmarkMgr.UpdateKnownFolderState": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:483", folderStateSet,
    "self.accessGroupBookmarkMgr.UpdateKnownFolderState(folderID, isActive): Online Folder and Offline Folder, a folder's menu; online only where the pilot has fewer than the most online of its kind (ValidateActiveFolderCount). Answered the folder, its bookmarks and its subfolders. In no recording."),
  "accessGroupBookmarkMgr.DeleteFolder": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:453", folderDeleted,
    "self.accessGroupBookmarkMgr.DeleteFolder(folderID): Delete Folder, a folder's menu, after ConfirmDeleteFolder; for a personal folder or one the pilot administers. Answered nothing. In no recording."),
  "accessGroupBookmarkMgr.AddFolder": typing(judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:426", folderMade,
    "self.accessGroupBookmarkMgr.AddFolder(isPersonal, folderName, description, adminGroupID, manageGroupID, useGroupID, viewGroupID): the folder window's Submit (bookmarkContainerWindow.py Confirm, 197 to 242), from Create Folder; the name the edit's, stripped, and the notes the editor's, each unicode where it holds text. Answered the folder. In no recording."), [1, 2]),
  "accessGroupBookmarkMgr.UpdateFolder": typing(judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:441", folderChanged,
    "self.accessGroupBookmarkMgr.UpdateFolder(folderID, folderName, description, adminGroupID, manageGroupID, useGroupID, viewGroupID): the folder window's Submit in its edit (Edit Folder, a folder's menu); the name and the notes unicode where they hold text. Answered the pilot's access to the folder after. In no recording."), [1, 2]),
  "accessGroupBookmarkMgr.GetFolderInfo": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:519", folderAsked,
    "self.accessGroupBookmarkMgr.GetFolderInfo(folderID): the folder as the server has it, asked by Edit Folder before its window opens (GetBookmarkFolder with refresh) and for a folder the client does not know (GetFolderInfo, 528). In no recording."),
  "accessGroupBookmarkMgr.RemoveFromKnownFolders": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:460", folderAsked,
    "self.accessGroupBookmarkMgr.RemoveFromKnownFolders(folderID): Disconnect from Folder, a shared folder's menu, after ConfirmForgetFolder. Answered nothing. In no recording."),
  "ownerGroupManager.GetGroup": judged("eve/client/script/ui/structure/accessGroups/accessGroupsController.py:184", listAsked,
    "self.remoteSvc.GetGroup(groupID), of ownerGroupManager by its name: an access list that is none of the pilot's, asked where its name is wanted (GetGroupInfoFromID with fetchToServer: a folder's lists in the folder window and in Folder Information). Answered the list. In no recording."),
  "ownerGroupManager.GetMyGroups": judged("eve/client/script/ui/structure/accessGroups/accessGroupsController.py:105", sentWithNothing,
    "self.remoteSvc.GetMyGroups(), of ownerGroupManager by its name and with nothing: the pilot's access lists, asked once and kept by the client's controller; the folder window offers a shared folder's access levels from them. In no recording."),
  "accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder": reshaped("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:690", bookmarksMovedOrCopied,
    "self.accessGroupBookmarkMgr.MoveBookmarksToFolderAndSubfolder(oldFolderID, folderID, subfolderID, bookmarkIDs): bookmarks dropped on a folder or a subfolder of the Locations window (DropInPlacesFolder), each source folder's a set; answered the rows moved and a message or None. In no recording."),
  "accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder": reshaped("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:701", bookmarksMovedOrCopied,
    "self.accessGroupBookmarkMgr.CopyBookmarksToFolderAndSubfolder(oldFolderID, folderID, subfolderID, bookmarkIDs): the same drop with Shift held, or from a folder the pilot may only view or use; answered the new bookmarks by number and a message or None. In no recording."),
  "accessGroupBookmarkMgr.AddToKnownFolders": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:357", folderStateSet,
    "self.accessGroupBookmarkMgr.AddToKnownFolders(folderID, isActive): Folder Information's Add Folder for a folder the pilot does not know (LinkedBookmarkFolderWindow.AddFolder), online or offline as chosen; answered the folder, its bookmarks and its subfolders. In no recording."),
  "accessGroupBookmarkMgr.SearchFoldersWithAdminAccess": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:715", sentWithNothing,
    "self.accessGroupBookmarkMgr.SearchFoldersWithAdminAccess(), by name and with nothing, kept two minutes (Memoize(2)): the folders the pilot may administer, for the Locations window's Folders with Admin Access. In no recording."),
  "accessGroupBookmarkMgr.GetMyActiveBookmarks": judged("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:163", sentWithNothing,
    "folders, bookmarks, subfolders = self.accessGroupBookmarkMgr.GetMyActiveBookmarks(), by name and with nothing: recorded on Tranquility so, in three recordings. The client asks once in a session and keeps the three, changing them as it makes, changes and deletes a bookmark and as the server says a shared folder changed. The transport asks as a character is chosen and keeps the three (pilots.js, bookmarksRead): a place bookmarked on the ballpark's object is worked into them as the client works it (afterBookmarkCall), and they are let go at any other write of the pilot's own of a bookmark, a folder or a subfolder and at the server's word of a shared folder, and asked for when they are next wanted. The page asks each time it wants them, and is answered from what is kept."),
  "beyonce.BookmarkLocation": typing(reshaped("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:617", bookmarking,
    "bp.BookmarkLocation(itemID, folderID, name, comment, expiry, subfolderID=subfolderID), on the ballpark's object: the subfolder by keyword every time, None where there is none. No recording has one. The name the label field's, unicode (bookmarkLocationWindow.py Confirm, 212 to 219), and the note the editor's, the empty byte string where it holds nothing."), [2, 3]),
  "beyonce.BookmarkScanResult": typing(reshaped("eve/client/script/ui/shared/bookmarks/bookmarkSvc.py:629", bookmarkingScanResult,
    "bp.BookmarkScanResult(locationID, name, comment, resultID, folderID, expiry, subfolderID=subfolderID), on the ballpark's object: a probe result's Bookmark Location where the sensor suite has no site of it, the result by its own ID, its label. No recording has one. It answers the eight the client keeps (bookmarkID, itemID, typeID, x, y, z, locationID, expiry)."), [1, 2]),
  "beyonce.CmdGotoPoint": reshaped("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:324", goingToPoint,
    "bp.CmdGotoPoint(*position), on the ballpark's object: the point's three, each a float, from the positional control's drag, once the autopilot's navigation in the system is cancelled. A pilot controlling a structure sends none. It answers nothing. In no recording."),
  "beyonce.CmdGotoDirection": reshaped("eve/client/script/parklife/scanSvc.py:465", goingInDirection,
    "rbp.CmdGotoDirection(x, y, z), on the ballpark's object: a probe result's Align To sends the place less the ship's own position, each a float; the double click in space a direction of length one. It answers nothing. Recorded on Tranquility in six sessions, three floats and nothing else."),
  "beyonce.CmdGotoBookmark": judged("eve/client/script/ui/services/menuSvcExtras/movementFunctions.py:405", goingToBookmark,
    "bp.CmdGotoBookmark(bookmark.bookmarkID), on the ballpark's object: a bookmark's Approach Location, once the menu has forgotten what was aligned to (StoreAlignTarget). An agent's bookmark is asked of the agent (GotoLocation). It answers nothing. In no recording."),
  "beyonce.CmdAlignTo": judged("eve/client/script/ui/services/menusvc.py:2790", aligning,
    "bp.CmdAlignTo(dstID=targetID, bookmarkID=bookmarkID), on the ballpark's object: a thing or a bookmark by name, the other None, and nothing by position; from the menu, the shortcut and a site's bracket. With no park, and for the pilot's own ship, it sends nothing. It answers nothing. Tranquility's two recordings have it so, the thing a long."),
  "beyonce.CmdFleetTagTarget": judged("eve/client/script/ui/services/menusvc.py:2825", tagging,
    "michelle.GetRemotePark().CmdFleetTagTarget(itemID, tag): a fleet's tag on a thing in space, from the menu and from the shortcuts, on the ballpark's object. It answers nothing, set or not. No recording has one."),
  "fleetMgr.AddToWatchlist": judged(`${FLEET_SVC}:669`, addingToWatchlist, "sm.RemoteSvc('fleetMgr').AddToWatchlist(newCharsAdded, fav): the pilots added and every favourite, the client's set"),
  "fleetMgr.RemoveFromWatchlist": judged(`${FLEET_SVC}:719`, removingFromWatchlist, "sm.RemoteSvc('fleetMgr').RemoveFromWatchlist(charID, favs): the pilot taken off and every favourite left, the client's set"),
  "fleetMgr.RegisterForDamageUpdates": judged(`${FLEET_SVC}:795`, registeringForDamage, "sm.RemoteSvc('fleetMgr').RegisterForDamageUpdates(fav): every favourite, the client's set, at a change of system in space in a fleet"),
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
  "contractProxy.GetLoginInfo": same(`${CONTRACTS_SVC}:191`, "GetContractProxySvc().GetLoginInfo(), no arguments. The client asks once, when its notifications are ready, for the Neocom's blink; the game port keeps that answer for the session (pilots.js KEPT_UNTIL_CHANGED), and the page's contracts panel is answered from it."),
  "contractProxy.GetMyExpiredContractList": same(`${CONTRACTS_SVC}:748`, "ProxySvc('contractProxy').GetMyExpiredContractList(False), and (True) for the corporation's straight after: the client asks the two together and keeps them."),
  "contractProxy.GetContractListForOwner": Object.freeze({
    status: "same",
    source: `${CONTRACT_PANELS}:419`,
    note: "ProxySvc('contractProxy').GetContractListForOwner(ownerID, status, contractType, issuedBy, num=100, startContractID=...): the My Contracts panel's list, asked when the panel opens and when its button is pressed, for the status its filter is on. Recorded on Tranquility as (charID, 0, None, None), num=100, startContractID=None.",
    shape: ownersContracts,
  }),
  "crimewatch.GetClientStates": same(`${CRIMEWATCH_SVC}:89`, "CharGetCrimewatchLocation().GetClientStates(), no arguments, on a moniker made for the call. Recorded on Tranquility as the call a bind of crimewatch carried."),
  "trademgr.Add": same("eve/client/script/environment/invControllers.py:193-226", "PlayerTrade inherits locationFlag=None: Add(itemID, sourceLocationID, qty=quantity, flag=None). Compiled cdx2995 confirms the keyword values."),
  "trademgr.MultiAdd": reshaped("eve/client/script/environment/invControllers.py:489", ([ids, source], kwargs) => ({ args: [list(ids), source], kwargs }), "BaseInvContainer.AddItems sorts by type volume times stacksize, then MultiAdd(list IDs, sourceLocation, flag=flagNone0). Compiled cdx2995 confirms list/order/flag."),
  "trademgr.OfferMoney": reshaped("eve/client/script/ui/station/pvptrade/pvptradewnd.py:160-164", ([amount], kwargs) => ({ args: [asFloat(amount)], kwargs }), "QtyPopup returns a two-decimal float; OfferMoney(qty) on the trade object. No money offer in the TQ corpus."),
  "trademgr.MakeOffer": reshaped("eve/client/script/ui/station/pvptrade/pvptradewnd.py:92-115", ([manifest], kwargs) => ({ args: [manifest && manifest.type === undefined ? keyVal(constructorKeywordOrder(["tradeContainerID", "money", "tradeItems"]).map(name => [name, name === "money" ? list(manifest[name]) : manifest[name]])) : manifest], kwargs }), "KeyVal(tradeContainerID, money list in trader order, tradeItems Python set of both sides' DBRows), after the native other-party ship warning. TQ968 exposes manifest/None offer state; its packet is LARGE PAYLOAD."),
  "trademgr.InitiateTrade": same("eve/client/script/ui/station/pvptrade/pvptradesvc.py:38-41", "RemoteSvc InitiateTrade(charID) returns the trade Moniker. Its node/params are retained unchanged; no location-derived moniker is invented."),
  "trademgr.List": same("eve/client/script/ui/station/pvptrade/pvptradesvc.py:28-51", "List() on the returned or notified trade Moniker, first carried by its lazy bind. TQ In station trade41-48 records the receiver path and inline Row."),
  "trademgr.Abort": same("eve/client/script/ui/station/pvptrade/pvptradewnd.py:67-89", "Abort() on that same trade object after confirmed Cancel or during close, including after completion. TQ In station trade1268/1432 records close-time Abort -> True."),
  "crimewatch.StartDuelChallenge": same(`${CRIMEWATCH_SVC}:583-588`, "CharGetCrimewatchLocation().StartDuelChallenge(charID), after the local engagement guard; one selected other player, high/low security. No exact TQ call recording found."),
  "crimewatch.RespondToDuelChallenge": same(`${CRIMEWATCH_SVC}:562-579`, "RespondToDuelChallenge(fromCharID, expiryTime, accept): exact notice FILETIME long and bool, only after an explicit accept/decline result; timeout/close sends nothing."),
  "crimewatch.SetSafetyLevel": judged(`${CRIMEWATCH_SVC}:343`, oneSafetyLevel,
    "CharGetCrimewatchLocation().SetSafetyLevel(safetyLevel): one of the three levels, from the safety button's selector, at once for a level no lower than the one now and after its Confirm for a lower one (shipSafetyButton.py 464, 660). The service keeps the level it set and asks nothing. In none of the recordings."),
  "crimewatch.GetMySecurityStatus": same(`${CRIMEWATCH_SVC}:592`, "CharGetCrimewatchLocation().GetMySecurityStatus(), no arguments: asked once and kept. Recorded on Tranquility as the call a bind of crimewatch carried."),
  "crimewatch.GetCharacterSecurityStatus": same(`${CRIMEWATCH_SVC}:596`, "CharGetCrimewatchLocation().GetCharacterSecurityStatus(charID)"),
  "crimewatch.GetSecurityStatusTransactions": same(`${CRIMEWATCH_SVC}:603`, "CharGetCrimewatchLocation().GetSecurityStatusTransactions(), no arguments"),
  "agentMgr.GetMyEpicArcStatus": same("eve/client/script/ui/shared/epicArcSvc.py:32", "sm.RemoteSvc('agentMgr').GetMyEpicArcStatus(), no arguments: each arc's missions' statuses (acceptedDate, completedDate, quitDate, nameID), asked as the controller is made and again on OnEpicJournalChange."),
  "agentMgr.GetMessagesForEpicArcMissions": same("eve/client/script/ui/shared/epicArcs/epicArcController.py:68", "sm.RemoteSvc('agentMgr').GetMessagesForEpicArcMissions(), no arguments: the arcs' missions' journal messages (chapter title, in progress, completed) by message kind and mission."),
  "dungeonInstanceCacheMgr.GetCombatAnomalyInstances": same("evedungeons/client/anomalyTracker.py:235", "sm.RemoteSvc('dungeonInstanceCacheMgr').GetCombatAnomalyInstances(), no arguments: by solar system, each combat anomaly's KeyVal (dungeonID, instanceID, siteID, archetypeID, factionID, difficulty, entryObjectTypeID, dungeonNameID, position). Recorded on Tranquility so (AIR Oportunities - Amarr, 10/30/2026)."),
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
  "skillHandler.GetFreeSkillPointsAppliedToSkills": reshaped(
    "eve/client/script/ui/services/skillQueueSvc.py:610",
    levelsListed,
    "GetSkillHandler().GetFreeSkillPointsAppliedToSkills(skillTypeIDsAndLevels): the levels as one list of (typeID, level). It answers the points each skill would take. Asked by the Apply Skill Points window as it opens (applySkillPointsWindow.py 123) and before the spreading. In no recording.",
  ),
  "skillHandler.ApplyFreeSkillPointsToSkills": reshaped(
    "eve/client/script/ui/services/skillQueueSvc.py:612",
    levelsListed,
    "GetSkillHandler().ApplyFreeSkillPointsToSkills(skillTypeIDsAndLevels), where the asking before it answered any points: the levels as one list of (typeID, level). It answers the free points left. In no recording.",
  ),
  "skillHandler.PurchaseSkills": reshaped(
    "characterskills/client/purchase.py:100",
    // GetSkillHandler().PurchaseSkills(skill_type_ids): the skills as one list, and nothing else.
    (args) => ({ args: [list(Array.isArray(args[0]) ? args[0] : args[0] && Array.isArray(args[0].items) ? args[0].items : [args[0]])], kwargs: {} }),
    "GetSkillHandler().PurchaseSkills(skill_type_ids), from the books window's Buy and Inject (MissingSkillbooksWnd, after its context's validate: each a skill, each sold, none injected, the cost within the wallet): the books bought as one list. It answers the skills bought. In no recording.",
  ),
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
      const priced = [...args.slice(0, 2), asFloat(args[2]), ...args.slice(3, 8)];
      const rate = typeof args[8] === "number" ? args[8] : brokersFeeOf(context, args[0]);
      if (rate === null) {
        return { args: [...priced, args[8]], kwargs, status: "differs", note: "The client names the broker's fee rate its window showed, and the server holds the order to it. This call names none, and it could not be worked out for this station." };
      }
      const clients = [...priced, asFloat(rate)];
      return sameValues(clients, args) ? { args, kwargs } : { args: clients, kwargs, status: "reshaped" };
    },
  }), "fee"),
  "marketProxy.BuyMultipleItems": needing(Object.freeze({
    status: "same",
    source: `${MARKET_QUOTE}:271`,
    note: "GetMarketProxy().BuyMultipleItems(stationID, itemList, useCorp) (marketsvc.BuyMulti, from the multibuy window's Buy, buyMultiFromBase.py 296 to 311): the station, a list of the items, each a util.KeyVal of six fields (marketutil/orderInfo.py GetBuyItemInfo: stationID, typeID, the price rounded to cents, quantity, minVolume 1, and delta, how far the price is from the type's average), and whether it is for the corporation. It answers the orders made. In no recording.",
    shape: (args, kwargs, context) => {
      const [stationID, given, useCorp] = args;
      const listed = Array.isArray(given) ? given : given && given.type === "list" && Array.isArray(given.items) ? given.items : null;
      if (args.length !== 3 || !wholeAndPositive(stationID) || listed === null || listed.length === 0) {
        return { args, kwargs, status: "differs", note: "The client sends three: the station, a list of the items, and whether it is for the corporation." };
      }
      if (listed.every((item) => item && typeof item === "object" && item.type === "object")) return { args, kwargs };
      const items = listed.map((item) => {
        if (!item || typeof item !== "object" || item.type !== undefined) return null;
        if (!wholeAndPositive(item.typeID) || !wholeAndPositive(item.quantity) || typeof item.price !== "number" || !(item.price > 0)) return null;
        const price = Math.round(item.price * 100) / 100;
        const delta = item.delta !== undefined ? item.delta : deltaFrom(price, averagePriceOf(context, item.typeID));
        return keyVal([
          ["stationID", item.stationID ?? stationID], ["typeID", item.typeID], ["price", asFloat(price)], ["quantity", item.quantity],
          ["minVolume", item.minVolume ?? 1], ["delta", asFloat(delta ?? 0)],
        ]);
      });
      if (items.includes(null)) {
        return { args, kwargs, status: "differs", note: "Each item the client sends has its type, a price above nought and how many; one of these has not." };
      }
      return { args: [stationID, { type: "list", items }, useCorp === true], kwargs: {}, status: "reshaped" };
    },
  }), "buy"),
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
      const fee = asFloat(duration !== 0 && typeof named !== "number" && typeof items[0].rate === "number" ? items[0].rate : named);
      const asGiven = !Array.isArray(given) && fee === named && items.every(({ item }, at) => item === listed[at]);
      const shaped = asGiven ? args : [{ type: "list", items: items.map(({ item }) => item) }, useCorp, duration, fee];
      const lacking = SALE_ITEM.filter((name) => items.some(({ has }) => !has.includes(name)));
      if (lacking.length > 0) {
        const what = { delta: "how far the price is from the type's average (delta)", rawBrokerFeePercentage: "the broker's fee rate (rawBrokerFeePercentage)" };
        return { args: shaped, kwargs, status: "differs", note: `The client's item has eight fields. These lack what its window works out: ${lacking.map((name) => what[name] ?? name).join(", and ")}.` };
      }
      if (duration !== 0 && typeof fee !== "number" && !(fee && fee.type === "real")) return { args: shaped, kwargs, status: "differs", note: "For an order that stands, the client names the broker's fee rate its window showed. This call names none." };
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
        // The prices as floats: the row's as the server wrote it, which the game port keeps as a number.
        const clients = [row.orderID, asFloat(rest[0]), ...sevenOfTheRow.slice(0, 3), asFloat(sevenOfTheRow[3]), ...sevenOfTheRow.slice(4)];
        return sameValues(clients, [given, ...rest]) ? { args: clients, kwargs } : { args: clients, kwargs, status: "reshaped" };
      }
      const args = [orderID, asFloat(rest[0]), ...rest.slice(1)];
      if (rest.length !== 8) return { args, kwargs, status: "differs", note: "The client sends nine: the order's number, the new price, and seven more off the order's row." };
      const issued = rest[7];
      if (!((typeof issued === "bigint" && issued > 0n) || (typeof issued === "number" && issued > 0) || (issued && typeof issued === "object"))) {
        return { args, kwargs, status: "differs", note: "The client sends the order's own date of issue. This call has none." };
      }
      return orderID === given && args[1] === rest[0] ? { args, kwargs } : { args, kwargs, status: "reshaped" };
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
  "account.GetCashBalance": same(`${WALLET_SVC}:41,156-170`, "GetCashBalance(0) for personal wealth; corporate GetCorpWealth sends (1, accountKey=None/explicit key) freshly, separately from its one-minute per-key cache"),
  "account.GiveCashFromCorpAccount": Object.freeze({
    status: "same", source: "eve/client/script/ui/shared/neocom/wallet/transferMoneyWnd.py:150",
    note: "Corporate-source transfer: character, float amount, captured source key; destination None and original edit reason by keyword. TQ Corp Transfers1804 has this three-argument/keyword shape and None reply.",
    shape: (args, kwargs) => ({ args: [args[0], asFloat(args[1]), args[2]], kwargs: { ...kwargs, reason: typedText(kwargs.reason) }, status: "reshaped" }),
  }),
  "account.GiveCash": typing(Object.freeze({
    status: "same",
    source: "eve/client/script/ui/shared/neocom/wallet/transferMoneyWnd.py:148",
    note: "sm.RemoteSvc('account').GiveCash(self.toID, amount, reason, toAccountKey=toAccountKey): the transfer window's OK, from an owner's menu's Give Money; the amount a float of two decimal places, the reason its edit's, and the account key None for a character. Tranquility's recording of a transfer to a corporation: GiveCash(98827279, 100.0, '') with toAccountKey=1000, answered the two balances. The wallet's Give ISK tab sends GiveCash(selectedCharacterID, amount) and nothing else (giveIskPanel.py TransferISK).",
    shape: givingCash,
  }), [2]),
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
  "allianceRegistry.GetAlliancePublicInfo": same(`${ALLIANCE_SVC}/all_cso.py:136`, "RemoteSvc('allianceRegistry').GetAlliancePublicInfo(allianceID), by name: Show Info on an alliance"),
  "allianceRegistry.GetAllianceContacts": same(`${ALLIANCE_SVC}/all_cso.py:243`, "GetMoniker().GetAllianceContacts(), no arguments, on the alliance's moniker: the address book asks it as the character is chosen, for a pilot in an alliance"),
  "allianceRegistry.AddAllianceContact": reshaped(`${ALLIANCE_SVC}/all_cso.py:246`, corporationContactStanding, "AddAllianceContact(id, standing), positional on the alliance moniker; compiled editor Confirm sends a float rounded to tenths. No exact TQ write capture."),
  "allianceRegistry.EditAllianceContact": reshaped(`${ALLIANCE_SVC}/all_cso.py:250`, corporationContactStanding, "EditAllianceContact(id, standing), the same float and moniker as Add. No exact TQ write capture."),
  "allianceRegistry.RemoveAllianceContacts": reshaped(`${ALLIANCE_SVC}/all_cso.py:254`, ownersListed, "RemoveAllianceContacts(ids), a positional list; member menu merged callbacks remove each owner separately."),
  "allianceRegistry.EditContactsRelationshipID": reshaped(`${ALLIANCE_SVC}/all_cso.py:258`, corporationContactsStanding, "ContactsForm's multi editor sends a list and rounded float on the alliance moniker."),
  "allianceRegistry.GetLabels": same(`${ALLIANCE_SVC}/all_cso.py:261`, "GetLabels(), no args on the alliance moniker, kept separately from other scopes."),
  "allianceRegistry.CreateLabel": typing(same(`${ALLIANCE_SVC}/all_cso.py:264`, "CreateLabel(name, color), unicode name and None color from addressbook.CreateContactLabel."), [0]),
  "allianceRegistry.EditLabel": typing(reshaped(`${ALLIANCE_SVC}/all_cso.py:271`, labelFirst, "EditLabel(bit, name, color), positional; None preserves each field."), [1]),
  "allianceRegistry.DeleteLabel": reshaped(`${ALLIANCE_SVC}/all_cso.py:268`, labelFirst, "DeleteLabel(bit), long bits preserved; native clears this mask bit and rereads labels."),
  "allianceRegistry.AssignLabels": reshaped(`${ALLIANCE_SVC}/all_cso.py:274`, ownersLabelled, "AssignLabels(ids, mask), positional list and full-width label bits."),
  "allianceRegistry.RemoveLabels": reshaped(`${ALLIANCE_SVC}/all_cso.py:277`, ownersLabelled, "RemoveLabels(ids, mask), positional list and full-width label bits."),
  "allianceRegistry.GetApplications": same(`${ALLIANCE_SVC}/all_cso_applications.py:26`, "GetMoniker().GetApplications(), no arguments, on the alliance's moniker, kept"),
  "allianceRegistry.GetBulletins": same(`${ALLIANCE_SVC}/all_cso.py:231`, "GetMoniker().GetBulletins(), no arguments, on the alliance's moniker, kept for fifteen minutes"),
  "allianceRegistry.GetBills": same(`${ALLIANCE_SVC}/all_cso.py:217`, "GetMoniker().GetBills(), no arguments, on the alliance's moniker, by an accountant"),
  "allianceRegistry.GetPrimeTimeInfo": same(`${ALLIANCE_SVC}/all_cso.py:288`, "GetMoniker().GetPrimeTimeInfo(), no arguments, on the alliance's moniker"),
  "allianceRegistry.GetCapitalSystemInfo": same(`${ALLIANCE_SVC}/all_cso.py:295`, "GetMoniker().GetCapitalSystemInfo(), no arguments, on the alliance's moniker"),
  "allianceRegistry.GetRelationships": same(`${ALLIANCE_SVC}/all_cso_relationships.py:25`, "GetMoniker().GetRelationships(), no arguments, on the alliance's moniker, kept"),
  "allianceRegistry.GetRankedAlliances": same(`${ALLIANCE_SVC}/all_cso_alliance.py:30`, "RemoteSvc('allianceRegistry').GetRankedAlliances(maxLen), by name, kept for five seconds"),
  "corpRegistry.GetAggressionSettings": same("eve/client/script/ui/services/crimewatchSvc.py:615", "GetCorpRegistry().GetAggressionSettings(), no arguments, on the corporation's moniker: asked when the session's corporation changes, the choosing of a character among them, and kept"),
  "corpRegistry.RegisterNewAggressionSettings": same("eve/client/script/ui/shared/neocom/corporation/corp_ui_home.py:634", "GetCorpRegistry().RegisterNewAggressionSettings(not isFFEnabled): the one bool, on the corporation's moniker. What it answers is for the window that asked: the settings the client keeps change by the server's notice"),
  "corpRegistry.GetMemberTrackingInfo": same(`${CORP_SVC}/base_corporation.py:865`, "GetCorpRegistry().GetMemberTrackingInfo(), no arguments, for a Director. Recorded bound in Archive/Opening all corp admin panels and assets search.txt:1033; cached for five minutes."),
  "corpRegistry.GetMemberTrackingInfoSimple": same(`${CORP_SVC}/base_corporation.py:867`, "GetCorpRegistry().GetMemberTrackingInfoSimple(), no arguments, for other members. CorpMemberTracking.ShowMemberTracking asks again as filters change."),
  "corpRegistry.GetMemberIDsByQuery": same(`${CORP_SVC}/base_corporation.py:492`, "CorpQueryMembersForm.ExecuteQuery276-293 forwards the native criteria list and includeImplied/searchTitles booleans on the corporation moniker. The first term has three fields; joined terms have four. TQ admin panels2673-2674 records empty list/False/False -> empty list."),
  "corpRegistry.SetAccountKey": same(`${CORP_SVC}/bco_members.py:249`, "One unchanged wallet account key on the corporation moniker. base_corporation.SetAccountKey165 uses PerformSessionChange with violateSafetyTimer=True. TQ Receiving Corp Roles1899/1918/2107 records key1000, corpAccountKey notification and True reply."),
  "corpRegistry.GetMember": same(`${CORP_SVC}/bco_members.py:168`, "GetCorpRegistry().GetMember(charID), positional on the corporation moniker. EditMemberDialog reads the viewer's grantable state and the target member."),
  "corpRegistry.MoveCompanyShares": same(`${CORP_SVC}/bco_shares.py:43`, "Compiled EditMemberDialog.OnGiveShares526 uses QtyPopup(2147483647,1,'1',HowManySharesToGive(player=charID),GiveShares), then MoveCompanyShares(session.corpid,charID,qty); Cancel sends nothing, no role gate or profile Apply. Wallet GiveSharesDialog.TransferShares104 passes the holding's issuerID as first argument; CorpSharesPanel.GetOwnerID supplies session.corpid as owner. Both send three unchanged positional arguments on the current corporation moniker; no TQ transfer recording found."),
  "charMgr.GetPrivateInfo": same("eve/client/script/ui/shared/neocom/corporation/corp_dlg_edit_member.py:148", "RemoteSvc('charMgr').GetPrivateInfo(charID), the one positional character ID, when Member Details loads the character."),
  "corpRegistry.UpdateMember": same(`${CORP_SVC}/bco_members.py:243`, "UpdateMember(charID,title,divisionID,squadronID,roles,grantableRoles,rolesAtHQ,grantableRolesAtHQ,rolesAtBase,grantableRolesAtBase,rolesAtOther,grantableRolesAtOther,baseID,titleMask,blockRoles), all 15 positional. Member Details General preserves role masks, titleMask=None, blockRoles=None; typed title Unicode."),
  "corpRegistry.KickOutMembers": reshaped(`${CORP_SVC}/base_corporation.py:469`, ownersListed, "Compiled KickOutMultipleMembers forwards the merged Python list of character IDs as one argument. Preserve list type on the native wire; a JS array alone would marshal as a tuple. The originating registry and result handling are unchanged. No exact plural-expulsion recording was found."),
  "corporationSvc.GetAllCorpMedals": same("eve/client/script/ui/services/medals.py:60", "RemoteSvc('corporationSvc').GetAllCorpMedals(corpID), catalogue and graphics rowsets; recorded as a cached object in Archive/Opening all corp admin panels and assets search.txt:1242-1261."),
  "corporationSvc.GetRecipientsOfMedal": same("eve/client/script/ui/services/medals.py:64", "RemoteSvc('corporationSvc').GetRecipientsOfMedal(medalID), lazily from corp_ui_member_decorations.GetMedalSubContent112-149; repeated recepientID rows form one awardee entry."),
  "corporationSvc.GetMedalDetails": same("eve/client/script/ui/services/medals.py:89", "RemoteSvc('corporationSvc').GetMedalDetails(medalID); infoContentBase1450-1453 and675-687 read info[0] separately for caption/description and corporation/count header."),
  "corporationSvc.GetMedalsReceived": same("eve/client/script/ui/services/medals.py:87", "GetMedalsReceived(characterID), received medal and graphics rowsets, invalidated by OnMedalIssued/OnMedalStatusChanged."),
  "corporationSvc.CreateMedal": typing(reshaped("eve/client/script/ui/services/medals.py:31-53", ([title, description, graphics, ...rest], kwargs) => ({ args: [title, description, medalGraphics(graphics), ...rest], kwargs }), "Unicode title/description and nested Python graphics lists from MedalRibbonPickerWindow.SubmitData553-560. Initial three arguments; fourth True only after ConfirmCreatingMedal and Yes. No recorded TQ fee or confirmation policy."), [0, 1]),
  "corporationSvc.GiveMedalToCharacters": typing(reshaped("eve/client/script/ui/services/medals.py:108", ([medalID, recipients, ...rest], kwargs) => ({ args: [medalID, list(recipients), ...rest], kwargs }), "Scalar medal ID, Python list of recipients, Unicode reason; fourth True only after a ConfirmGivingMedal* refusal and Yes. Top-level RemoteSvc, not the corporation moniker. No TQ award capture found."), [2]),
  "facWarMgr.GetCorporationWarFactionID": same("eve/client/script/ui/services/facWarSvc.py:92", "facWarMgr.GetCorporationWarFactionID(corpID), for a player corporation. CorpMemberTracking.ShowMemberTracking asks after its tracking rows; the recorded director panel takes a cached result of 0."),
  "bannedwords.check_search_words_allowed": typing(same("bannedwords/client/bannedwords_client.py:80", "RemoteSvc('bannedwords').check_search_words_allowed(text), positional Unicode from the character edit (baseSingleLineEdit.Insert 641). Only where the held global config enables banned_words_search_enabled; member tracking asks after its rows and before its faction read."), [0]),
  "corpRegistry.GetLabels": same(`${CORP_SVC}/base_corporation.py:1011`, "GetCorpRegistry().GetLabels(), no arguments; the corporation contact labels, read on first showing the form."),
  "corpRegistry.AddCorporateContact": reshaped(`${CORP_SVC}/base_corporation.py:995`, corporationContactStanding, "AddCorporateContact(contactID, relationshipID), positional on the corporation moniker; the slider rounds to one decimal (corpAllianceContactManagementWindow.py 117-118), a float even at whole standings. In no recording."),
  "corpRegistry.EditCorporateContact": reshaped(`${CORP_SVC}/base_corporation.py:999`, corporationContactStanding, "EditCorporateContact(contactID, relationshipID), the same corporation editor's float, positional on the corporation moniker. In no recording."),
  "corpRegistry.RemoveCorporateContacts": reshaped(`${CORP_SVC}/base_corporation.py:1003`, ownersListed, "RemoveCorporateContacts(contactIDs), a list from addressbookService.RemoveFromAddressBook (817-869), positional on the corporation moniker. In no recording."),
  "corpRegistry.EditContactsRelationshipID": reshaped(`${CORP_SVC}/base_corporation.py:1007`, corporationContactsStanding, "EditContactsRelationshipID(contactIDs, relationshipID), a list and the multi-editor's rounded float; Confirm's compiled code returns that float (the decompile misindents self.level). In no recording."),
  "corpRegistry.CreateLabel": typing(same(`${CORP_SVC}/base_corporation.py:1014`, "CreateLabel(name, color), positional on the corporation moniker; addressbookService.CreateContactLabel (1011-1021), typed unicode and color None. In no recording."), [0]),
  "corpRegistry.EditLabel": typing(reshaped(`${CORP_SVC}/base_corporation.py:1021`, labelFirst, "EditLabel(labelID, name, color), positional on the corporation moniker; addressbookService.EditContactLabel (1001-1006), typed unicode and color None. In no recording."), [1]),
  "corpRegistry.DeleteLabel": reshaped(`${CORP_SVC}/base_corporation.py:1017`, labelFirst, "DeleteLabel(labelID), the label's bit as received; addressbookService.DeleteContactLabel (1072-1084) then asks for labels again. In no recording."),
  "corpRegistry.AssignLabels": reshaped(`${CORP_SVC}/base_corporation.py:1025`, ownersLabelled, "AssignLabels(contactIDs, labelMask), the selected contacts a list and the label bits, positional on the corporation moniker (addressbookService.AssignLabelFromWnd, 1094-1100). In no recording."),
  "corpRegistry.RemoveLabels": reshaped(`${CORP_SVC}/base_corporation.py:1029`, ownersLabelled, "RemoveLabels(contactIDs, labelMask), a list and the label bits, positional on the corporation moniker (addressbookService.RemoveLabelFromWnd, 1131-1137). In no recording."),
  "corpRegistry.GetCorporateContacts": same(`${CORP_SVC}/base_corporation.py:993`, "GetCorpRegistry().GetCorporateContacts(), no arguments, on the corporation's moniker: the address book asks it as the character is chosen, and only for a pilot whose corporation is not an NPC one (991)"),
  "corpRegistry.GetEveOwners": judged(`${CORP_SVC}/bco_members.py:136`, sentWithNothing,
    "eveowners = self.GetCorpRegistry().GetEveOwners(), with nothing, on the corporation's moniker: recorded on Tranquility so. Asked when the session's corporation changes, for its members' names and their numbers, which the client keeps and changes as the server says a member changed (OnCorporationMemberChanged); a pilot is a member to the client where its number is among them (161). The native transport retains those IDs from the login/session prime for the page's atomic membership read. An explicit raw GetEveOwners RPC still asks the registry."),
  "corpRegistry.GetMyApplications": same(`${CORP_SVC}/bco_applications.py:72`, "GetCorpRegistry().GetMyApplications(), no arguments, on the corporation's moniker: asked once by the client, which keeps the list and works it over at each OnCorporationApplicationChanged"),
  "corpRegistry.GetMyOldApplications": same(`${CORP_SVC}/bco_applications.py:98`, "Personal history, no arguments on the current corporation moniker; requested each time, only when the retained showingOld setting is True."),
  "corpRegistry.InsertInvitation": same(`${CORP_SVC}/base_corporation.py:1145`, "InviteToJoinCorp asks ConfirmSendInviteToJoinCorp(charID), OK/Cancel; only OK sends the single positional character ID on the current registry. No exact TQ direct-invitation packet was found."),
  "corpRegistry.UpdateApplicationOffer": same(`${CORP_SVC}/bco_applications.py:141`, "TempLock UpdateApplicationOffer; seven positional args: applicationID, characterID, target corporationID, original typed applicationText, status, empty byte customMessage, None date. Archive/Applying and accepting a corp invite.txt1324 confirms Unicode text/status2/empty/None. No session-change cooldown."),
  "corpRegistry.GetCorporation": same(`${CORP_SVC}/bco_corporations.py:49`, "GetCorpRegistry().GetCorporation(), no arguments, on the corporation's moniker"),
  "corpRegistry.GetSharesByShareholder": same(`${CORP_SVC}/bco_shares.py:30`, "GetCorpRegistry().GetSharesByShareholder(corpShares) on the corporation's moniker: the wallet's Shares tab asks it each time it is chosen with IsCorpWallet(), False for the pilot's own (sharesPanel.py GetScrollList), and the client indexes the rows by corporationID"),
  "officeManager.GetCorporationsWithOffices": judged(`${CORP_SVC}/officeManager.py:34`, sentWithNothing, "Moniker('officeManager', stationID).GetCorporationsWithOffices(), no arguments, while it has none for where the session is docked; let go at any OnOfficeRentalChange (71) and out of the station or structure (58, 66); the transport keeps it so (pilots.js, stationOffices). Recorded on Tranquility after an office was rented and after one was given up."),
  "officeManager.GetEmptyOfficeCount": judged(`${CORP_SVC}/officeManager.py:136`, sentWithNothing, "Moniker('officeManager', stationID).GetEmptyOfficeCount(), no arguments, each time the lobby's offices are listed; not asked in a structure (133). Recorded on Tranquility beside the corporations with offices."),
  "officeManager.GetPriceQuote": judged(`${CORP_SVC}/officeManager.py:114`, priceForOwnCorporation, "Moniker('officeManager', stationID).GetPriceQuote(session.corpid), as the lobby's rent button is pressed (dockedUI/offices.py). Recorded on Tranquility: answered a long."),
  "officeManager.RentOffice": judged(`${CORP_SVC}/officeManager.py:117`, rentAtThePrice, "Moniker('officeManager', stationID).RentOffice(cost), the price GetPriceQuote answered, once the player has said yes to it. Recorded on Tranquility: answered None, after the server's two notices of the office."),
  "officeManager.UnrentOffice": judged(`${CORP_SVC}/officeManager.py:122`, sentWithNothing, "Moniker('officeManager', stationID).UnrentOffice(), no arguments, once the player has said yes; the client names the corporation's assets there for its object cache first (121). Recorded on Tranquility: answered None."),
  "officeManager.PrimeOfficeItem": judged(`${CORP_SVC}/officeManager.py:108`, sentWithNothing, "Moniker('officeManager', stationID).PrimeOfficeItem(), no arguments, once for a Moniker, where the corporation has an office in the station (106: isPrimed); the transport asks it once so (pilots.js, officePrimed). Recorded on Tranquility after an office was rented."),
  "officeManager.HasCorpImpoundedItems": judged(`${CORP_SVC}/officeManager.py:143`, sentWithNothing, "Moniker('officeManager', stationID).HasCorpImpoundedItems(), no arguments, where a player's corporation has no office in the station (139 to 142). Recorded on Tranquility after an office was given up."),
  "officeManager.GetMyCorporationsOffices": same(`${CORP_SVC}/officeManager.py:41`, "RemoteSvc('officeManager').GetMyCorporationsOffices(), no arguments, while it has none; let go at OnOfficeRentalChange of the session's corporation (72) and in another corporation (62); the transport keeps it so (pilots.js, KEPT_UNTIL_CHANGED)"),
  "dogmaIM.LaunchProbes": same(`${SCAN_SVC}:494`, "LaunchProbes(moduleID, numProbes)"),
  "expertSystemMgr.GetMyExpertSystems": same(`${EXPERT_SYSTEM_SVC}:42`, "GetMyExpertSystems(), no arguments (a Tranquility recording has it so)"),
  "expertSystemMgr.RemoveMyExpertSystem": same(`${EXPERT_SYSTEM_SVC}:66`, "RemoveMyExpertSystem(expertSystemTypeID)"),
  "dogmaIM.InjectSkillIntoBrain": reshaped(
    `${SKILL_SVC}:784`,
    (args, kwargs) => ({ args: [list(args[0]), ...args.slice(1)], kwargs }),
    "GetDogmaLM().InjectSkillIntoBrain([itemID, ...]): the books' item ids, a list",
  ),
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
  "dogmaIM.OverloadRack": judged(`${GODMA}:2082`, oneModule,
    "GetDogmaLM().OverloadRack(itemID), on the dogma location bound for where the pilot is: the module button's Overload Rack (shipmodulebutton 695), with the module whose rack it is. It answers the rack's modules overloaded. No recording has one."),
  "dogmaIM.StopOverloadRack": judged(`${GODMA}:2127`, oneModule,
    "GetDogmaLM().StopOverloadRack(itemID): the button's Stop Overloading Rack (699), the same module. It answers the modules stopped. No recording has one."),
  "dogmaIM.InitiateModuleRepair": judged(`${GODMA}:2227`, oneModule,
    "GetDogmaLM().InitiateModuleRepair(itemID), on the dogma location bound for where the pilot is: the module button's Repair, for a module with damage. The server takes the paste and begins; an answer of False begins nothing. No recording has one."),
  "dogmaIM.InitiateModuleRepairMany": judged(`${GODMA}:2206`, moduleList,
    "GetDogmaLM().InitiateModuleRepairMany(itemIDs), on the dogma location bound for where the pilot is: the module button's Repair All (shipmodulebutton 516, RepairManyModules), the ship's damaged modules not being repaired, in the order godma's set of them gives, the one clicked first. It answers (success, missingCharges, failed), each a list of modules. No recording has one."),
  "dogmaIM.StopModuleRepair": judged(`${GODMA}:2261`, oneModule,
    "GetDogmaLM().StopModuleRepair(itemID): godma's own doing when the repair's time is up (the damage over the character's repair rate, in minutes, and a second), at Cancel Repair, and at a session's change. The server mends the module at this call. No recording has one."),
  "dogmaIM.LinkAllWeapons": judged(`${CLIENT_DOGMA}:800`, ownShipAlone,
    "remoteDogmaLM.LinkAllWeapons(shipID), on the dogma location: the group-all button, with session.shipid (groupAllIcon.py 36), where some weapon could still be grouped. It answers the ship's banks. No recording has one; LinkWeapons(shipID, master, slave) is recorded, riding the dogma location's bind."),
  "dogmaIM.LinkWeapons": judged(`${CLIENT_DOGMA}:780`, ownShipAndTwoModules,
    "remoteDogmaLM.LinkWeapons(shipID, masterID, moduleID), on the dogma location: a weapon dropped with Shift held on a slot of the same type (the fitting slot's LinkWithWeapon), with the master of that slot's bank or its module. It answers the ship's banks. Tranquility recorded it twice: (ship, master, module), riding the dogma location's bind."),
  "dogmaIM.MergeModuleGroups": judged(`${CLIENT_DOGMA}:776`, ownShipAndTwoModules,
    "remoteDogmaLM.MergeModuleGroups(shipID, masterID, otherMasterID), on the dogma location: as LinkWeapons, where the weapon dropped is in a bank already, with that bank's master. It answers the ship's banks. No recording has one."),
  "dogmaIM.PeelAndLink": judged(`${CLIENT_DOGMA}:778`, ownShipAndTwoModules,
    "remoteDogmaLM.PeelAndLink(shipID, masterID, otherMasterID), on the dogma location: as MergeModuleGroups, where the HUD's drag of a bank onto another weapon has Shift held (slotsContainer.ChangeSlots 84, merge=not shift): a weapon peeled off the bank dragged and linked alone. It answers the ship's banks. No recording has one."),
  "dogmaIM.DestroyWeaponBank": judged(`${CLIENT_DOGMA}:865`, ownShipAndModule,
    "remoteDogmaLM.DestroyWeaponBank(shipID, masterID), on the dogma location: a grouped weapon put into a container off its slot once its pilot has said Yes to ClearGroupModule (UnloadModuleToContainer, 1086), with the bank's master. It answers nothing, and the client's own banks lose that bank (OnWeaponGroupDestroyed). No recording has one."),
  "dogmaIM.UnlinkModule": judged(`${CLIENT_DOGMA}:785`, ownShipAndModule,
    "remoteDogmaLM.UnlinkModule(shipID, moduleID), on the dogma location: UngroupModule (784), with the bank's master, as a grouped weapon is unfitted from its slot once its pilot has said Yes to ClearGroupModule (fittingSlotController.UnfitModule, 234). It answers the slave the server took out of the bank. No recording has one."),
  "dogmaIM.UnlinkAllModules": judged(`${CLIENT_DOGMA}:794`, ownShipAlone,
    "remoteDogmaLM.UnlinkAllModules(shipID): the same button where every weapon that can be is grouped (groupAllIcon.py 38). No recording has one."),
  "dogmaIM.Activate": needing(reshaped(`${MODULE_BUTTON}:1348`, activation, "godma's GetDogmaLM().Activate(itemID, effectName, target, repeats) (godma.py 2062), on the dogma location bound for where the pilot is"), "dogma"),
  "dogmaIM.Deactivate": needing(reshaped(`${GODMA}:2101`, deactivation, "GetDogmaLM().Deactivate(itemID, effectName), on the dogma location bound for where the pilot is"), "dogma"),
  "dogmaIM.GetTargets": same(`${GODMA}:2361`, "GetDogmaLM().GetTargets(), no arguments"),
  "dogmaIM.AddTarget": judged(`${TARGET_MGR}:1366`, lockingATarget, "GetDogmaLM().AddTarget(targetID), by TryLockTarget (1305): for no thing the client has locked or is locking. Recorded on Tranquility 223 times, the target a long."),
  "dogmaIM.CancelAddTarget": judged(`${TARGET_MGR}:1303`, callingOffALock, "GetDogmaLM().CancelAddTarget(targetID), of a lock still being made. No recording has one."),
  "dogmaIM.ClearTargets": judged(`${TARGET_MGR}:1420`, sentWithNothing, "GetDogmaLM().ClearTargets(), nothing sent: every lock the ship has is let go. Its one caller in the client is gameui (parklife/gameui.py 621), at a change of ship in space with the system the same: a ship boarded there, or the capsule a pilot is left in when its ship is destroyed. The game port asks it then, of its own accord. Recorded on Tranquility three times (a pilot killed to its capsule, an eject and a boarding in space), each the same bytes, within a third of a second of the session's change."),
  "dogmaIM.RemoveTarget": judged(`${TARGET_MGR}:1385`, lettingGoOfATarget, "GetDogmaLM().RemoveTarget(targetID), of a thing the client has locked (1384). Recorded on Tranquility 4 times, the target a long."),
  "dogmaIM.SetModuleOnline": same(`${CLIENT_DOGMA}:702`, "SetModuleOnline(the ship the module is in, moduleID)"),
  "dogmaIM.TakeModuleOffline": same(`${CLIENT_DOGMA}:718`, "TakeModuleOffline(the ship the module is in, moduleID)"),
  "dogmaIM.LoadAmmo": reshaped(`${CLIENT_DOGMA}:991`, loading, "LoadAmmo(shipID, moduleID, [chargeItemID, ...], chargeLocationID) for one module, as every recording has it, or with the modules as a list (LoadAmmoToModules, 996): the ship is the one the session is flying, and the charges are a list"),
  "dogmaIM.UnloadAmmo": reshaped(`${CLIENT_DOGMA}:1140`, unloading, "UnloadAmmo(shipID, [moduleID, ...], destination), or UnloadAmmo(shipID, moduleID, destination, quantity) for one module (1127): the ship is the one the session is flying"),
  "dogmaIM.ShipGetInfo": webOnly(`${GODMA}:2409`, "The client never asks this. What it knows of its ship is in GetAllInfo, which godma is primed from."),
  "dogmaIM.ShipOnlineModules": webOnly(`${GODMA}:697`, "godma has a wrapper for this that nothing in the client calls, and throws its answer away. Which modules are online the client reads from the effects GetAllInfo lists. eve.js answers with the online modules, and the BFF reads that."),
  "ship.LaunchDrones": reshaped(`${EVE_MISC}:29`, launching, "GetShipAccess().LaunchDrones([(itemID, quantity), ...], whoseBehalfID, ignoreWarning): a list of pairs, and None for whose behalf when it is the pilot's own"),
  "ship.ScoopDrone": judged(`${DRONE_FUNCTIONS}:195`, scooping, "GetShipAccess().ScoopDrone(droneIDs), the drones as one list, from a drone's menu. No recording has one."),
  "warRegistry.GetWars": reshaped("eve/client/script/ui/services/wars/war_cso.py:103", ofAWarOwner, "self.GetMoniker().GetWars(ownerID), on the war service's moniker for the pilot's alliance or corporation (eveMoniker.GetWar, bound before it is used): an owner's wars, each by its ID. The war service keeps an owner's for twelve hours (98 to 106) and works the server's OnWarChanged into them (82 to 96); its timer panel asks for the pilot's own owner's as it is made (crimewatchTimers.py 356) and its thread reads them every ten seconds (172 to 182). Tranquility's recordings of a login have MachoBindObject((owner, 1), None) and then the one GetWars(owner) on the object."),
  "ProjectDiscovery.initialize_tutorial_status": judged("projectdiscovery/client/projects/covid/service.py:25", sentWithNothing, "self.remote_service.initialize_tutorial_status(), which is sm.RemoteSvc('ProjectDiscovery') (baseservice.py 28 to 32), nothing sent: whether the character has done Project Discovery's tutorial, a bool. The project's client service asks it at a change of the session's character, where the character is not the one it had (22 to 30), and keeps the answer. Tranquility's recordings of a login have it once, answered False."),
  "ProjectDiscovery.is_enabled": judged("projectdiscovery/client/baseservice.py:41", sentWithNothing, "self.remote_service.is_enabled(), nothing sent: whether Project Discovery is enabled, a bool, asked while none is kept and kept as long as the client runs (39 to 42). The neocom asks, of its button for Project Discovery (eve/client/script/ui/shared/neocom/neocom/btnData/btnDataNode.py 485). Tranquility's recordings of a login have it once, answered True."),
  "localizationServer.UpdateLocalizationQAWrap": judged("carbon/client/script/localization/localizationClient.py:27", oneBoolAlone, "sm.RemoteSvc('localizationServer').UpdateLocalizationQAWrap(LocWrapSettingsActive()), the one bool: whether any of the client's QA settings of its texts is on (localization/settings/qaSettings.py 53 to 65). Told as a first character comes onto a session whose role has ROLE_QA (24 to 27), and as those settings are saved (qaSettings.py 49). Tranquility's recordings, which are of players, have none."),
  "userSvc.GetRedeemTokens": judged("eve/client/script/ui/services/redeemsvc.py:64", sentWithNothing, "sm.RemoteSvc('userSvc').GetRedeemTokens(), nothing sent: what the account may redeem, a rowset of tokens (the token, its type and quantity, its label and description, when it came, runs out and is to be had, where, and whether it is bound). The redeem service fetches it as its neocom extension is set up (37 to 46), at the server's OnRedeemingQueueUpdated (162 to 169) and after a claim, and keeps it (51 to 54). Tranquility's recordings of a login have it once from the choosing on."),
  "userSvc.ClaimRedeemTokens": Object.freeze({
    status: "same",
    source: "eve/client/script/ui/services/redeemsvc.py:103",
    note: "sm.RemoteSvc('userSvc').ClaimRedeemTokens(tokens, charID, useHomeStation=useHomeStation): the redeem window's Redeem to Current Station or Redeem to Home Station (redeemItemsContainer.py redeem, 343 to 356), the selected tokens as a list of (tokenID, massTokenID) and the session's character. Answered a dict of errors (tokenID, error), itemsCreated, stationID and what was given otherwise; the redeem service fetches the tokens afresh after it (127).",
    shape: claimingRedeemTokens,
  }),
  "loginCampaignManager.get_client_campaign_state": judged("loginrewards/client/loginCampaignService.py:111", sentWithNothing, "sm.RemoteSvc('loginCampaignManager').get_client_campaign_state(), nothing sent: the account's daily login campaign, a util.KeyVal of static_data (the campaign, its length and item_rewards_by_day, each day's typeID, quantity and tier), item_progress (next_reward_index, num_claimed_rewards, next_reward_timestamp) and bucket_progress; None where the account is in no campaign. The service asks it once and keeps it until a claim or the server's word of a change (106 to 123)."),
  "seasonalLoginCampaignManager.get_active_campaign": judged("loginrewards/client/seasonalLoginCampaignService.py:44", sentWithNothing, "sm.RemoteSvc('seasonalLoginCampaignManager').get_active_campaign(), nothing sent: (campaign_id, end_date_ordinal, turnover_time_str, num_remaining_rewards), the campaign's ID None where none is on; the end a date's ordinal, the turnover 'HH:MM:SS' in UTC. Asked once as the service starts (39 to 51)."),
  "seasonalLoginCampaignManager.get_claim_history": judged("loginrewards/client/seasonalLoginCampaignService.py:93", sentWithNothing, "sm.RemoteSvc('seasonalLoginCampaignManager').get_claim_history(), nothing sent: a dict of each day claimed (a date's ordinal) to the clone grade it was claimed as. Asked when first wanted and kept (90 to 97)."),
  "seasonalLoginCampaignManager.claim_reward": judged("loginrewards/client/seasonalLoginCampaignService.py:84", sentWithNothing, "sm.RemoteSvc('seasonalLoginCampaignManager').claim_reward(), nothing sent: the day's reward claimed, answered True or False (80 to 88). The rewards go to the account's redeem queue."),
  "loginCampaignManager.claim_reward": judged("loginrewards/client/loginCampaignService.py:199", sentWithNothing, "sm.RemoteSvc('loginCampaignManager').claim_reward(), nothing sent: the day's reward claimed, by the window's Claim. Answered (item_reward, item_progress, bucket typeID, bucket_progress), or None where nothing may be claimed (196 to 212). The reward goes to the account's redeem queue."),
  "insurgencySolarsystem.GetAllVisibleCampaigns": judged("eve/client/script/ui/services/insurgencyCampaignSvc.py:93", sentWithNothing, "sm.RemoteSvc('insurgencySolarsystem').GetAllVisibleCampaigns(), nothing sent: the insurgency campaigns a client may see, a list of snapshots. insurgencyCampaignSvc keeps it half a minute (96 to 98) and lets it go at the server's notices of a campaign where the client is (59 to 90). The insurgency's info panel asks for it as the info panels are looked over (infoPanelInsurgency.py 287 to 290), the dashboard, the agency and the map when they are opened. Tranquility's recordings have it once at each login and once after each change of solar system."),
  "operationsManager.can_character_play_the_tutorial": judged("operations/common/util.py:99", ownCharacterAlone, "sm.RemoteSvc('operationsManager').can_character_play_the_tutorial(character_id), the session's own character alone: whether the tutorial is open to it, a bool. is_npe_enabled_for_character asks it once for a character and keeps the answer (93 to 101); its askers go by are_operations_active of the session's character (operations/client/util.py 12 to 13). Tranquility's recordings of a login have it once, answered True."),
  "milestoneMgr.ProcessCharacterLogon": judged("milestones/client/milestoneSvc.py:22", sentWithNothing, "sm.RemoteSvc('milestoneMgr').ProcessCharacterLogon(), nothing sent, answering nothing: the character has logged on, at which the server starts the login milestone's timer and says when it runs out (OnMilestoneTimerStarted). The milestone service calls it at every change of the session's character (20 to 23). Tranquility's recordings of a login each have the one call."),
  "seasonManager.get_season_data_for_character": judged("seasons/client/seasonservice.py:269", sentWithNothing, "sm.RemoteSvc('seasonManager').get_season_data_for_character(), nothing sent: nothing where no season runs for the character, a list of seasons where it is to choose one, or the season it is in. The season service asks it once for a character on the session (64 to 82, 268 to 279). Tranquility's recordings of a login have it, answered nothing."),
  "seasonManager.get_character_progress_by_character_id": judged("seasons/client/seasonservice.py:285", sentWithNothing, "sm.RemoteSvc('seasonManager').get_character_progress_by_character_id(), nothing sent: the character's progress in the season it is in. The season service asks it behind get_season_data_for_character where that answered a season of the character's own (281 to 288), and again when the seasons' data changes (98 to 101). No recording has it."),
  "nonDiminishingInjectionMgr.GetAvailableNonDiminishingInjections": judged("eve/client/script/ui/services/nonDiminishingInjectionService.py:50", sentWithNothing, "sm.RemoteSvc('nonDiminishingInjectionMgr').GetAvailableNonDiminishingInjections(), nothing sent: how many skill injections the character may still take at their full worth, a number. The service asks it at every change of the session's character (23 to 25), keeps it, and counts it up and down at the server's OnNonDiminishingInjectionsAdded, Used and Removed (27 to 42). Tranquility's recordings of a login each have the one call, answered 0."),
  "achievementTrackerMgr.GetCompletedAchievementsAndClientEventCount": judged("achievements/client/achievementSvc.py:129", sentWithNothing, "sm.RemoteSvc('achievementTrackerMgr').GetCompletedAchievementsAndClientEventCount(), nothing sent: a dict of 'completedDict' (each achievement the character has completed, with when) and 'eventDict' (how often each of the client's own events has come). The achievement service asks it once, as a character comes onto its session and it has nothing yet (182 to 188), and keeps both (128 to 134). The retail client of this build asks it at every login; Tranquility's recordings, of a later build, have the same call under the service name monolithTaskTrackerMgr."),
  "charMgr.SaveCharacterSetting": same("eve/client/script/ui/services/characterSettingsSvc.py:49", "session.ConnectToRemoteService('charMgr').SaveCharacterSetting(settingKey, value): the key and the setting's text, at most 102400 (an empty one is deleted instead, 45 to 46); worked into what the service keeps (50). The wallet's Auto Payment tab saves 'personalAutopayment' so (personalPaySettingsPanel.py 66 to 78)."),
  "charMgr.DeleteCharacterSetting": same("eve/client/script/ui/services/characterSettingsSvc.py:55", "session.ConnectToRemoteService('charMgr').DeleteCharacterSetting(settingKey), for a setting the service keeps, and taken out of what it keeps (56)."),
  "charMgr.GetCharacterSettings": judged("eve/client/script/ui/services/characterSettingsSvc.py:33", sentWithNothing, "session.ConnectToRemoteService('charMgr').GetCharacterSettings(), nothing sent: the settings the client keeps at the server for the character, each under its key (the mail's, the fleet's setups, the inventory's and the chat's filters and others), answered as a utillib.KeyVal of unicode strings. characterSettingsSvc asks once, when something first wants a setting, and keeps them for the session (31 to 34); its Save and Delete call SaveCharacterSetting and DeleteCharacterSetting and work them into what is kept (44 to 58). Tranquility's recordings of a login each have the one call."),
  "securityMgr.get_modified_systems": judged("security/client/securitySvc.py:41", sentWithNothing, "sm.RemoteSvc('securityMgr').get_modified_systems(), nothing sent: the solar systems whose security is other than the map's, each by its ID with a row of (solarSystemID, security, modifiedSecurity). The security service asks it once, as its session first has a solar system (45 to 48), keeps each system's modified level (39 to 43) and takes the server's OnSecurityModified for a system's level from then (50 to 54). Tranquility's recordings of a login each have the one call, answered an indexed rowset with no rows."),
  "dynamicBountyMgr.GetOutputForClientSolarSystem": judged("eve/client/script/ui/shared/dynamicResource/dynamicResourceSvc.py:64", sentWithNothing, "sm.RemoteSvc('dynamicBountyMgr').GetOutputForClientSolarSystem(), nothing sent: (the bounty output of the solar system the session is in, whether the dynamic bounty system is at work there). dynamicResourceSvc keeps it ninety minutes (58 to 65), lets it go at a change of the session's solar system (175 to 182) and takes the server's OnSystemDynamicBountyStateChanged for what it is (160 to 165). The location panel reads it as it is drawn (infoPanelLocationInfo.py 320). Tranquility's recordings have it once at each login and once after each change of solar system, answered (1.0, False)."),
  "fwWarzoneSolarsystem.GetLocalOccupationState": judged("eve/client/script/ui/services/fwWarzoneSvc.py:52", sentWithNothing, "sm.RemoteSvc('fwWarzoneSolarsystem').GetLocalOccupationState(), nothing sent: (the solar system the session is in, its occupation state), the state None where the system is in no warzone. fwWarzoneSvc keeps it while the session is in that system (34 to 37, 47 to 60), asks once more where the answer is for another system, and takes the server's OnWarzoneOccupationStateUpdated for what it is from then (78 to 93). The location panel has it asked as it is drawn (infoPanelLocationInfo.py 341). Tranquility's recordings have it once at each login and once after each change of solar system."),
  "jumpTimers.GetTimers": judged("eve/client/script/ui/services/crimewatchSvc.py:607", ownCharacterAlone, "sm.RemoteSvc('jumpTimers').GetTimers(session.charid): the end of the pilot's jump activation, the end of its jump fatigue and when they were last reckoned, each a time or None. crimewatchSvc asks it once, as its timer panel is first made (ui/crimewatch/crimewatchTimers.py 355), keeps it, and from then on takes the server's OnJumpTimersUpdated for what they are (605 to 612). Tranquility's four recordings of a login each have the one call, answered (None, None, None)."),
  "missionTrackerMgr.GetMissionInfoItems": judged("missions/client/missionObjectivesTracker.py:275", oneIDAlone("the mission's agent"), "sm.RemoteSvc('missionTrackerMgr').GetMissionInfoItems(agentID): what is left to do of the mission that agent gave, as a list of words (['TravelTo', '30011392'], ['TransportItemsMissing', '3814', '30']). The client's mission tracker asks it for each mission the pilot has accepted and that has not run out, one after another, at every change of the session once a character is on it (89 to 94, 213, 267 to 279) and as each warp ends (84 to 87). Tranquility's recordings have it in 24, three at a time for a pilot on three missions."),
  "fighterMgr.GetFightersForShip": judged("eve/client/script/parklife/fightersSvc.py:99", sentWithNothing, "sm.RemoteSvc('fighterMgr').GetFightersForShip(), nothing sent: the fighters in the ship's tubes, those of its in space, and their abilities' states. The client's ship fighter state asks it at every session change that names the ship (ui/inflight/squadrons/shipFighterState.py 72 to 74), from whatever ship, docked or in space; the choosing of a character is one. The game port asks it then, of its own accord, and keeps nothing of the answer. Recorded on Tranquility twelve times, at logins and at changes of ship, each answered ([], [], {})."),
  "miningScanMgr.perform_scan": judged("mining/client/asteroid_scanning_service.py:134", sentWithNothing, "sm.RemoteSvc('miningScanMgr').perform_scan(), nothing sent: each asteroid about the ship with what it yields and how much is left, for the survey scan. The client asks only from a ship whose miningScannerUpgrade (attribute 5979) is 1 or more, and at most ten times a minute; from any other ship the scan asks nothing (perform_scan, 103). The BFF's route holds to this on the game port, where it has godma's value of the attribute for the ship being flown (GET /api/bridge/mining/scan); off the game port it has none and asks from any ship. No recording has one: in the one recording of a ship with a survey chipset fitted, the scan was never asked for."),
  "ship.Jettison": judged(`${INV_ITEM_FUNCTIONS}:63`, jettisoning, "GetShipAccess().Jettison(itemIDs), the items as one list, from an item's menu (and a node graph's action, with no confirmation). Recorded twice, each on the bind of the ship's Moniker for the solar system, with one list of one ID and no keywords, and answered two lists: what went to a can, and what was launched for itself."),
  "ship.LeaveShip": judged(`${STATION_SVC}:248`, leavingTheShip, "station.TryLeaveShip: gameui.GetShipAccess().LeaveShip(shipid), for the ship the pilot is in and no other, docked; from the item's menu and before a clone jump. In a structure, structureDocking.LeaveShip makes the same call and then makes the capsule it answers active. In space the menu ejects. In no recording."),
  "dogmaIM.CreateNewbieShip": judged(`${STATION_SVC}:613`, boardingACorvette, "station.CreateNewbieShip: sm.RemoteSvc('dogmaIM').CreateNewbieShip(shipID, locationID), by the service's name, for the ship the pilot is in and where it is docked (session.stationid or session.structureid). The client asks the pilot first unless it is in a capsule, and refuses by itself aboard a corvette. From the lobby's corvette button and no other place. In no recording."),
  "ship.AssembleShip": reshaped(
    `${INV_ITEM_FUNCTIONS}:197`,
    // GetShipAccess().AssembleShip(itemIDs, name=name, subSystems=subSystems): the ships one list, the two keywords.
    (args, kwargs) => ({
      args: [list(Array.isArray(args[0]) ? args[0] : args[0] && Array.isArray(args[0].items) ? args[0].items : [args[0]])],
      kwargs: { name: kwargs.name ?? null, subSystems: kwargs.subSystems ?? null },
    }),
    "GetShipAccess().AssembleShip(itemIDs, name=name, subSystems=subSystems), from a packaged ship's menu in the hangar (Assemble Ship, and Board Ship's first step): the ships as one list, the name the pilot gave in the naming window or None, and a modular ship's subsystems or None. In no recording.",
  ),
  "ship.FitShips": reshaped(
    `${FITTING_SVC}:510`,
    // GetShipAccess().FitShips(shipTypeID=..., fitInfo=..., itemLocationID=..., cargoItemsByType=..., fitRigs=...,
    // name=..., numToFit=..., itemContainerID=...): every argument a keyword, in that order.
    (args, kwargs) => ({
      args: [],
      kwargs: {
        shipTypeID: kwargs.shipTypeID ?? args[0] ?? null,
        fitInfo: fittingKeyVal(kwargs.fitInfo ?? args[1] ?? {}),
        itemLocationID: kwargs.itemLocationID ?? args[2] ?? null,
        cargoItemsByType: quantitiesByType(kwargs.cargoItemsByType ?? args[3] ?? {}),
        fitRigs: Boolean(kwargs.fitRigs ?? args[4]),
        name: typedText(kwargs.name ?? args[5] ?? ""),
        numToFit: kwargs.numToFit ?? args[6] ?? null,
        itemContainerID: kwargs.itemContainerID ?? args[7] ?? null,
      },
    }),
    "fittingSvc.DoFitManyShips: GetShipAccess().FitShips(shipTypeID=, fitInfo=, itemLocationID=session.stationid or session.structureid, cargoItemsByType=, fitRigs=, name=, numToFit=, itemContainerID=), from the multifit window's Fit (multiFitWnd.DoFitShips, 363 to 405): every argument a keyword; the fitting the util.KeyVal of six dicts its Fitting makes (shipfitting/fitting.py 119), the cargo a dict of the rigs by type where rigs are not fitted, the name the window's edit's (unicode) or the fitting's, the container the equipment's place or None for the item hangar. Answered None, or (failedToLoad, failedShipID). In no recording.",
  ),
  "ship.Board": same("eve/client/script/ui/services/menuSvcExtras/menuFunctions.py:209", "GetShipAccess().Board(shipID, session.shipid or session.stationid), through sessionMgr.PerformSessionChange('board', ...). Recorded on Tranquility in space as (shipID, the ship left), the bind carrying it."),
  "repairSvc.GetRepairQuotes": reshaped("eve/client/script/ui/station/repairshop/base_repairshop.py:63", quotingRepairs, "GetRemoteRepairMgr().GetRepairQuotes(itemIDs): the items as a list, on a Moniker of repairSvc made for the one call (45 to 60). In no recording."),
  "repairSvc.RepairItemsInStation": reshaped("eve/client/script/ui/station/repairshop/base_repairshop.py:67", repairingInAStation, "GetRemoteRepairMgr().RepairItemsInStation(itemIDs, payment), docked in a station: the items as a list and the payment a float, the amount the shop's window worked out (300 to 327). In no recording."),
  "repairSvc.RepairItemsInStructure": reshaped("eve/client/script/ui/station/repairshop/base_repairshop.py:69", repairingInAStructure, "GetRemoteRepairMgr().RepairItemsInStructure(itemIDs), docked in a structure, with nothing paid. In no recording."),
  "repairSvc.RepairItems": differs("eve/client/script/ui/station/repairshop/base_repairshop.py:65", "The client's repair service asks RepairItemsInStation or RepairItemsInStructure of the shop's Moniker. This name is the server's own for both, and what the web gateway's list has."),
  "slash.SlashCmd": typing(judged("eve/client/script/ui/services/menusvc.py:834", aSlashCommand, "RemoteSvc('slash').SlashCmd(line), by name, with the one line of text: what the client's GM menus send, and what its own slash service sends for a line typed in chat once its aliases are worked out (svc_slash.py 520 to 523). No recording has one. A line typed in chat goes unicode, as the page's GM console's does; the GM menus' own lines are byte strings, and the page sends none of those."), [0]),
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
  const rowOf = (key) => pairs.get(key) ?? { pair: key, calls: 0, sent: 0, carried: 0, statuses: {}, source: null, note: null };
  return {
    /**
     * A pair the transport asked for, in the form it took: `calls` counts these. Not every asking is sent: one
     * shared with the same call already out takes that call's answer (session.js _call).
     */
    note(service, method, form) {
      const key = `${service}.${method}`;
      const row = rowOf(key);
      row.calls += 1;
      row.statuses[form.status] = (row.statuses[form.status] ?? 0) + 1;
      if (row.source === null) row.source = form.source ?? null;
      if (row.note === null || (form.status !== "same" && form.note)) row.note = form.note ?? row.note;
      pairs.set(key, row);
    },
    /**
     * A pair the session put on the wire: `sent` counts these, and `carried` those of them a bind carried, which
     * went in the bind's packet (MachoBindObject(params, (method, args, keywords))). A call on an object whose
     * service the session does not know is counted under "(object)".
     */
    sent(service, method, { carried = false } = {}) {
      const key = `${service ?? "(object)"}.${method}`;
      const row = rowOf(key);
      row.sent += 1;
      if (carried) row.carried += 1;
      pairs.set(key, row);
    },
    /** Every pair asked or sent, most sent first. */
    rows() {
      return [...pairs.values()]
        .sort((a, b) => b.sent - a.sent || b.calls - a.calls || a.pair.localeCompare(b.pair))
        .map((row) => ({ ...row, statuses: { ...row.statuses } }));
    },
  };
}

module.exports = { CONTRACT_SEARCH_KEYWORDS, GAME_PORT_ONLY_CALLS, MONIKER_SERVICES, ON_AN_ANSWERED_OBJECT, ON_THE_PARK, PROXY_SERVICES, REPEATS, RETAIL_CALLS, TRANSPORT_OWN_CALLS, couldBeAPilot, createCallLedger, list, madeAfresh, madeOnAnObject, madeOnMoniker, retailForm, retailNeeds };
