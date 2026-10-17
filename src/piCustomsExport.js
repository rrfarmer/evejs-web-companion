"use strict";

// ── The customs-office export hop ───────────────────────────────────────────
//
// Moving a colony's launchpad goods up into the planet's customs office, the
// way the retail client does it: invbroker.ImportExportWithPlanet on the bound
// office. The web gateway does not carry that call - its allowlist has every
// invbroker verb the inventory panel needs and planetMgr.UserLaunchCommodities
// (the command-centre launch that leaves a container in space), but not this
// one - so this hop speaks the GAME PORT instead (src/gameClient.js), exactly
// as the retail client would. Nothing is patched on the server.
//
// ⚠ IT EVICTS WHOEVER HOLDS THE PILOT, SO IT HANDS THE PILOT BACK. One
// character may be in game on one session: selecting it here logs out the
// gateway session that held it. The route that calls this therefore refuses a
// pilot somebody else is holding, and re-selects the caller's own pilot
// afterwards. A pilot nobody holds (the ordinary case - the bot host has not
// started yet) costs nothing.
//
// ⚠ THE LAUNCHPAD, NOT THE COMMAND CENTRE. The server takes only a spaceport
// pin here (prepareSpaceportImportExport refuses any other entity type), and
// that is the point of the hop: a launchpad holds 10,000 m3 of what the
// factories actually made, where a command centre holds 500. The old
// command-centre launch is a different call and still its own block.
//
// ⚠ THE OFFICE IS LOOKED UP, NEVER COMPUTED. A planet with no player structure
// gets a synthesized InterBus office whose id is an offset plus the planet id,
// but a planet with an anchored POCO has a real item id instead and the
// synthesized one addresses nothing. map.GetSolarsystemItems lists both kinds
// the same way, each row carrying the planet it orbits, so the office is read
// from the world rather than guessed from the planet id.

const {
  GameClient,
  gameEndpoint,
  text,
  dictValue,
  numberOf,
} = require("./gameClient");
const { orderEntries } = require("./gamePort/py27");

/** invGroups 1025, Planetary Customs Offices - both InterBus and anchored. */
const GROUP_PLANETARY_CUSTOMS_OFFICES = 1025;

/**
 * How long to let the server settle after the character select before calling
 * on its behalf. SelectCharacterID returns before the session is fully in
 * place; the probe that proved this hop waited the same.
 */
const SELECT_SETTLE_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The items of a decoded marshal list, or [] for anything else. */
function listItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && value.type === "list" && Array.isArray(value.items)) {
    return value.items;
  }
  return [];
}

/**
 * The rows of a decoded Rowset, as objects keyed by its own column names.
 *
 * buildRowset sends {header, columns, RowClass, lines}: `columns` names the
 * fields and `lines` is one bare array per row, in that order. Reading the
 * names off the answer rather than hard-coding them means a column added
 * upstream shifts nothing here.
 */
function rowsetRows(value) {
  const args = value && typeof value === "object" && value.type === "object" ? value.args : value;
  const columns = listItems(dictValue(args, "columns") ?? dictValue(args, "header"))
    .map((column) => text(column))
    .filter((name) => name !== null);
  if (columns.length === 0) return [];
  return listItems(dictValue(args, "lines")).map((line) => {
    const cells = listItems(line);
    const row = {};
    columns.forEach((name, index) => {
      row[name] = cells[index] ?? null;
    });
    return row;
  });
}

/**
 * Which customs office belongs to which planet, from one system's item list.
 *
 * The map rows carry `orbitID` - the celestial the thing orbits - so a customs
 * office names its planet itself. Both flavours (a synthesized InterBus office
 * and an anchored POCO) come through the same rows with the same group.
 */
function officesByPlanetID(solarSystemItems) {
  const offices = new Map();
  for (const row of solarSystemItems) {
    if (numberOf(row.groupID) !== GROUP_PLANETARY_CUSTOMS_OFFICES) continue;
    const itemID = numberOf(row.itemID);
    const planetID = numberOf(row.orbitID);
    if (itemID === null || itemID <= 0 || planetID === null || planetID <= 0) continue;
    offices.set(planetID, itemID);
  }
  return offices;
}

/**
 * The commodities a colony's own factories are fed: every type a route
 * delivers into a factory pin. Mirrors factoryInputTypeIDs in
 * web/src/bridge/colonyRoutes.ts, which the run's collect-customs block uses.
 */
function factoryInputTypeIDs(colony) {
  const pins = Array.isArray(colony && colony.pins) ? colony.pins : [];
  const factories = new Set(pins.filter((pin) => pin && pin.kind === "factory").map((pin) => Number(pin.pinID) || 0));
  const inputs = new Set();
  for (const route of Array.isArray(colony && colony.routes) ? colony.routes : []) {
    const path = Array.isArray(route && route.path) ? route.path : [];
    const into = Number(path[path.length - 1]) || 0;
    const typeID = Number(route && route.commodityTypeID) || 0;
    if (into > 0 && factories.has(into) && typeID > 0) inputs.add(typeID);
  }
  return inputs;
}

/**
 * What to export, read off the colonies the gateway snapshot already carries.
 *
 * One entry per planet asked about, in the order asked. A planet with no
 * colony, or whose launchpads are empty, comes back with no pads: the caller
 * says so rather than connecting for nothing.
 *
 * ⚠ ONLY WHAT THE COLONY MAKES. A launchpad can be a colony's only store,
 * holding the imports its factories run on beside their output. A type a route
 * delivers into a factory is an input and stays on the planet; a pad holding
 * nothing else counts as empty.
 */
function planCustomsExports(colonies, planetIDs) {
  const byPlanetID = new Map();
  for (const colony of colonies) {
    const planetID = Number(colony && colony.planetID) || 0;
    if (planetID > 0) byPlanetID.set(planetID, colony);
  }
  const plan = [];
  for (const asked of planetIDs) {
    const planetID = Number(asked) || 0;
    if (planetID <= 0) continue;
    const colony = byPlanetID.get(planetID) ?? null;
    if (colony === null) {
      plan.push({ planetID, planetName: null, solarSystemID: 0, solarSystemName: null, pads: [], reason: "no-colony" });
      continue;
    }
    const pads = [];
    const inputs = factoryInputTypeIDs(colony);
    for (const pin of Array.isArray(colony.pins) ? colony.pins : []) {
      if (pin.kind !== "launchpad") continue;
      const commodities = {};
      let any = false;
      for (const entry of Array.isArray(pin.contents) ? pin.contents : []) {
        const typeID = Number(entry && entry.typeID) || 0;
        const quantity = Math.trunc(Number(entry && entry.quantity) || 0);
        if (typeID > 0 && quantity > 0 && !inputs.has(typeID)) {
          commodities[typeID] = (commodities[typeID] || 0) + quantity;
          any = true;
        }
      }
      if (any) pads.push({ pinID: Number(pin.pinID) || 0, commodities });
    }
    plan.push({
      planetID,
      planetName: colony.planetName ?? null,
      solarSystemID: Number(colony.solarSystemID) || 0,
      solarSystemName: colony.solarSystemName ?? null,
      pads: pads.filter((pad) => pad.pinID > 0),
      reason: pads.length === 0 ? "nothing-on-the-pads" : null,
    });
  }
  return plan;
}

/** How many units one planet's entry moves, for the sentence the window shows. */
function unitsOf(entry) {
  let units = 0;
  for (const pad of entry.pads) {
    for (const quantity of Object.values(pad.commodities)) units += quantity;
  }
  return units;
}

/**
 * Run the hop for a planned set of colonies, on an already-planned connection.
 *
 * Returns one result per planned planet, in order. A planet the server refuses
 * does NOT stop the others: a colony whose pad emptied between the snapshot
 * and the call is an ordinary race, and the rest of the haul is still worth
 * launching.
 */
async function exportPlannedColonies(client, plan, { log = () => {} } = {}) {
  const results = [];
  const officesBySystem = new Map();
  for (const entry of plan) {
    if (entry.pads.length === 0) {
      results.push({ ...entry, officeID: null, exported: false, units: 0, reason: entry.reason ?? "nothing-on-the-pads", message: null });
      continue;
    }
    let officeID = null;
    let moved = 0;
    try {
      if (!officesBySystem.has(entry.solarSystemID)) {
        const items = await client.call("map", "GetSolarsystemItems", [entry.solarSystemID]);
        officesBySystem.set(entry.solarSystemID, officesByPlanetID(rowsetRows(items)));
      }
      officeID = officesBySystem.get(entry.solarSystemID).get(entry.planetID) ?? null;
      if (officeID === null) {
        results.push({ ...entry, officeID: null, exported: false, units: 0, reason: "no-office", message: null });
        continue;
      }
      // The office states its own tax and the server compares what we send
      // against it to the sixth decimal (TaxChanged), so it is read now rather
      // than carried from an earlier read.
      const taxRate = numberOf(await client.call("planetOrbitalRegistryBroker", "GetTaxRate", [officeID]));
      if (!Number.isFinite(taxRate)) {
        results.push({ ...entry, officeID, exported: false, units: 0, reason: "no-tax-rate", message: "The customs office did not provide an export tax rate." });
        continue;
      }
      const office = await client.bind("invbroker", [officeID]);
      for (const pad of entry.pads) {
        // The retail client builds this dict with a comprehension and sends it
        // in its own dict order, which is not ascending type ID.
        const commodities = {
          type: "dict",
          entries: orderEntries(Object.entries(pad.commodities).map(([typeID, quantity]) => [Number(typeID), quantity])),
        };
        // (spaceportPinID, import, export, taxRate) - import stays empty: this
        // hop only ever sends goods UP.
        await client.callBound(office, "ImportExportWithPlanet", [
          pad.pinID,
          { type: "dict", entries: [] },
          commodities,
          taxRate,
        ]);
        for (const quantity of Object.values(pad.commodities)) moved += quantity;
      }
      log(`exported ${moved} units from planet ${entry.planetID} into office ${officeID}`);
      results.push({ ...entry, officeID, exported: true, units: moved, reason: null, message: null });
    } catch (error) {
      // The server's own words where it gave any: a refusal the player can act
      // on ("CannotLaunchCommoditiesNotFound" when a route drained the pad
      // between the read and the call) beats a sentence of ours.
      results.push({
        ...entry,
        // Earlier pads already committed. Keep that progress beside the
        // refusal so the caller can report and collect the portion sent up.
        officeID,
        exported: moved > 0,
        units: moved,
        reason: "refused",
        message: error && error.message ? String(error.message) : null,
      });
    }
  }
  return results;
}

/**
 * The whole hop: connect, select, export, disconnect.
 *
 * The connection is opened only when there is something to send, and is always
 * closed - including on the way out of a failure - because a connection left
 * open keeps the character logged in on it and the hand-back would fight it.
 */
async function runCustomsExport({
  accountName,
  characterID,
  colonies,
  planetIDs,
  // The caller may pass the plan it already read, so the decision it took on it
  // (whether to let go of the pilot at all) and the one taken here cannot
  // diverge. Absent, it is read here.
  plan: planned = null,
  env = process.env,
  createClient = (endpoint) => new GameClient(endpoint),
  settleMs = SELECT_SETTLE_MS,
  beforeSelect = async () => {},
  log = () => {},
}) {
  const plan = planned ?? planCustomsExports(colonies, planetIDs);
  const withGoods = plan.filter((entry) => entry.pads.length > 0);
  if (withGoods.length === 0) {
    // Nothing to send: nobody is evicted and no game connection is opened.
    return {
      connected: false,
      results: plan.map((entry) => ({
        ...entry,
        officeID: null,
        exported: false,
        units: 0,
        reason: entry.reason ?? "nothing-on-the-pads",
        message: null,
      })),
    };
  }
  const client = createClient(gameEndpoint(env));
  try {
    await client.login(accountName);
    await beforeSelect();
    await client.call("charUnboundMgr", "SelectCharacterID", [characterID]);
    if (settleMs > 0) await sleep(settleMs);
    const results = await exportPlannedColonies(client, plan, { log });
    return { connected: true, results };
  } finally {
    client.close();
  }
}

module.exports = {
  GROUP_PLANETARY_CUSTOMS_OFFICES,
  SELECT_SETTLE_MS,
  listItems,
  rowsetRows,
  officesByPlanetID,
  planCustomsExports,
  unitsOf,
  exportPlannedColonies,
  runCustomsExport,
};
