"use strict";

// The companion plugin's bridge routes. They only read the game's static data and what a colony
// holds, and move stored times: building a colony goes through the character's own session, as a
// retail client's does (tool/colony.js).
//
//   GET  /companion/colonies    ?characterID=         the character's colonies, settled to now
//   GET  /companion/pins        ?characterID=&planetID=   one colony's pins and their kinds
//   POST /companion/colony/plan { spec }              the changes that place a colony's pins
//   POST /companion/colony/age  { characterID, days, planetID? }   as if that many days had passed
//   POST /companion/colony/stock { characterID, planetID, pin, type, quantity }   goods in a pin

const { pinTypesFor, planPins, rewindColony, summarize } = require("./colonyPlan");

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

function filetimeNow() {
  return (BigInt(Date.now()) + FILETIME_EPOCH_OFFSET_MS) * 10_000n;
}

function positive(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function createCompanionServer({ require: serverRequire, log }) {
  const store = () => serverRequire("services/planet/planetRuntimeStore");
  const statics = () => serverRequire("services/planet/planetStaticData");
  const gameStore = () => serverRequire("gameStore");
  const world = () => serverRequire("space/worldData");

  const refused = (error) => ({ statusCode: 400, body: { ok: false, error } });
  const typeNamed = (name) => {
    const wanted = String(name).toLowerCase();
    const row = statics().listPITypeInfos().find((info) => info.typeName.toLowerCase() === wanted);
    if (!row) throw new Error(`no planetary type named ${name}`);
    return row.typeID;
  };
  const entityOf = (typeID) => statics().getPinEntityType(typeID);

  function colonies({ query }) {
    const characterID = positive(query && query.characterID);
    if (!characterID) return refused("A positive characterID is required.");
    const rows = store().listColoniesForCharacter(characterID).map((colony) => ({
      ...summarize(colony, { entityOf, filetimeNow: filetimeNow() }),
      planetName: (() => {
        const planet = world().getCelestialByID(Number(colony.planetID));
        return planet ? String(planet.itemName || planet.name || "") : "";
      })(),
    }));
    return { statusCode: 200, body: { ok: true, characterID, colonies: rows } };
  }

  function pins({ query }) {
    const characterID = positive(query && query.characterID);
    const planetID = positive(query && query.planetID);
    if (!characterID || !planetID) return refused("characterID and planetID are required.");
    const colony = store().getColony(planetID, characterID);
    if (!colony) return { statusCode: 404, body: { ok: false, error: "That character has no colony on that planet." } };
    return { statusCode: 200, body: { ok: true, pins: colony.pins.map((pin) => ({ pinID: pin.pinID, typeID: pin.typeID, kind: entityOf(pin.typeID) })) } };
  }

  function plan({ body }) {
    const spec = body && body.spec;
    const planet = spec && positive(spec.planetID) ? world().getCelestialByID(spec.planetID) : null;
    if (!planet) return refused(`no planet with ID ${spec && spec.planetID}`);
    try {
      const planned = planPins(spec, {
        pinTypes: pinTypesFor(Number(planet.typeID), statics().listPITypeInfos()),
        typeIDOf: typeNamed,
        schematicFor: (name) => {
          const typeID = typeNamed(name);
          const [schematic] = statics().getSchematicsByOutputTypeID(typeID);
          if (!schematic) throw new Error(`nothing makes ${name}`);
          const output = schematic.outputs.find((row) => row.typeID === typeID);
          return { schematicID: schematic.schematicID, typeID, quantity: output.quantity };
        },
      });
      return { statusCode: 200, body: { ok: true, ...planned, solarSystemID: Number(planet.solarSystemID) } };
    } catch (error) {
      return refused(error.message);
    }
  }

  function age({ body }) {
    const characterID = positive(body && body.characterID);
    const days = Number(body && body.days);
    const planetID = positive(body && body.planetID);
    if (!characterID) return refused("A positive characterID is required.");
    if (!(days > 0)) return refused("days: a number above 0.");
    const table = store().TABLE_NAME;
    const read = gameStore().read(table, "/");
    if (!read.success) return { statusCode: 500, body: { ok: false, error: read.errorMsg || "READ_ERROR" } };
    const state = read.data;
    let colonyCount = 0;
    let moved = 0;
    for (const colony of Object.values(state.coloniesByKey || {})) {
      if (Number(colony.ownerID) !== characterID || (planetID && Number(colony.planetID) !== planetID)) continue;
      moved += rewindColony(colony, days);
      colonyCount += 1;
    }
    const written = gameStore().write(table, "/", state, { force: true });
    if (!written.success) return { statusCode: 500, body: { ok: false, error: written.errorMsg || "WRITE_ERROR" } };
    if (log && log.debug) log.debug(`[AgentBridge] companion aged ${colonyCount} colonies of ${characterID} by ${days} days`);
    return { statusCode: 200, body: { ok: true, colonies: colonyCount, times: moved } };
  }

  function stock({ body }) {
    const characterID = positive(body && body.characterID);
    const planetID = positive(body && body.planetID);
    const quantity = positive(body && body.quantity);
    if (!characterID || !planetID || !quantity) return refused("characterID, planetID and quantity are required.");
    const colony = store().getColony(planetID, characterID);
    if (!colony) return { statusCode: 404, body: { ok: false, error: "That character has no colony on that planet." } };
    const kind = body.pin === "command" ? "command" : "spaceport";
    const pin = colony.pins.find((row) => entityOf(row.typeID) === kind);
    if (!pin) return refused(`that colony has no ${body.pin} pin`);
    try {
      store().addCommodityToColonyPin({ planetID, ownerID: characterID, pinID: pin.pinID, typeID: typeNamed(body.type), quantity });
    } catch (error) {
      return refused(error.message);
    }
    return { statusCode: 200, body: { ok: true, pinID: pin.pinID } };
  }

  return {
    routes: {
      "GET /companion/colonies": colonies,
      "GET /companion/pins": pins,
      "POST /companion/colony/plan": plan,
      "POST /companion/colony/age": age,
      "POST /companion/colony/stock": stock,
    },
  };
}

module.exports = { createCompanionServer };
