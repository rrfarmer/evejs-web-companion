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
//   POST /companion/fleet/form  { bossCharacterID, memberCharacterIDs }   a fleet, and an invitation to each member
//   POST /companion/ship/health { characterID, shield?, armor?, hull? }   a ship in space left at these fractions
//
// The last two go through the server's own calls and notices, so the pilots' sessions hear of them as
// they would hear of a fleet invite accepted, or of damage taken.

const { pinTypesFor, planPins, rewindColony, summarize } = require("./colonyPlan");

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

function filetimeNow() {
  return (BigInt(Date.now()) + FILETIME_EPOCH_OFFSET_MS) * 10_000n;
}

function positive(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function createCompanionServer({ require: serverRequire, log, seams }) {
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
    const kind = body.pin === "command" ? "command" : body.pin === "launchpad" ? "spaceport" : null;
    if (!kind) return refused("pin: launchpad or command");
    const pin = colony.pins.find((row) => entityOf(row.typeID) === kind);
    if (!pin) return refused(`that colony has no ${body.pin} pin`);
    let added;
    try {
      added = store().addCommodityToColonyPin({ planetID, ownerID: characterID, pinID: pin.pinID, typeID: typeNamed(body.type), quantity });
    } catch (error) {
      return refused(error.message);
    }
    // The store says no by returning it, not by throwing.
    if (!added || !added.success) return refused(`the colony refused the goods: ${(added && added.errorMsg) || "no reason given"}`);
    return { statusCode: 200, body: { ok: true, pinID: pin.pinID } };
  }

  const sessionOf = (characterID) => (seams && typeof seams.findSession === "function" ? seams.findSession(characterID) : null);

  // A refusal the server raised as a user error carries its message key, not words.
  const reasonOf = (error) => (error && (error.msgKey || error.message || (error.args && error.args[0]))) || String(error);

  function formFleet({ body }) {
    const bossID = positive(body && body.bossCharacterID);
    const memberIDs = Array.isArray(body && body.memberCharacterIDs) ? body.memberCharacterIDs.map(positive) : [];
    if (!bossID || memberIDs.length === 0 || memberIDs.includes(0)) return refused("bossCharacterID and memberCharacterIDs are required.");
    const fleets = serverRequire("services/fleets/fleetRuntime");
    const sessions = new Map([bossID, ...memberIDs].map((id) => [id, sessionOf(id)]));
    const offline = [...sessions].filter(([, session]) => !session).map(([id]) => id);
    if (offline.length) return refused(`not online: ${offline.join(", ")}`);
    const inFleet = [...sessions.keys()].filter((id) => fleets.getFleetForCharacter(id));
    if (inFleet.length) return refused(`already in a fleet: ${inFleet.join(", ")}`);
    const boss = sessions.get(bossID);
    let fleet;
    try {
      fleet = fleets.createFleetRecord(boss);
      fleets.initFleet(boss, fleet.fleetID, {});
      // Invited, not joined: the web client holds a fleet only through the call it made itself to
      // join it, so the page answers the invitation as a player does.
      for (const memberID of memberIDs) fleets.inviteCharacter(boss, fleet.fleetID, memberID, null, null, null);
    } catch (error) {
      return refused(`the fleet refused: ${reasonOf(error)}`);
    }
    if (log && log.debug) log.debug(`[AgentBridge] companion formed fleet ${fleet.fleetID}: boss ${bossID}, invited ${memberIDs.join(", ")}`);
    return { statusCode: 200, body: { ok: true, fleetID: fleet.fleetID } };
  }

  // Each layer given is left at that fraction of its whole, the others as they are. Only ever
  // lowered here: a repair is the ship's own business, or /heal's.
  function shipHealth({ body }) {
    const characterID = positive(body && body.characterID);
    if (!characterID) return refused("A positive characterID is required.");
    const wanted = {};
    for (const layer of ["shield", "armor", "hull"]) {
      if (body[layer] === undefined) continue;
      const fraction = Number(body[layer]);
      if (!(fraction >= 0 && fraction <= 1)) return refused(`${layer}: a fraction from 0 to 1.`);
      wanted[layer] = fraction;
    }
    if (Object.keys(wanted).length === 0) return refused("Name at least one of shield, armor, hull.");
    if (wanted.hull === 0) return refused("hull: above 0. This sets health; it does not destroy ships.");
    const session = sessionOf(characterID);
    if (!session) return refused(`not online: ${characterID}`);
    const runtime = serverRequire("space/runtime");
    const shipID = positive(session._space && session._space.shipID);
    const scene = shipID ? runtime.getSceneForSession(session) : null;
    const entity = scene ? scene.getEntityByID(shipID) : null;
    if (!entity || entity.kind !== "ship") return refused("That pilot is not in a ship in space.");
    const health = serverRequire("space/runtime/shipHealthState");
    const before = { ...(entity.conditionState || {}) };
    entity.conditionState = {
      ...before,
      ...(wanted.shield === undefined ? {} : { shieldCharge: wanted.shield }),
      ...(wanted.armor === undefined ? {} : { armorDamage: 1 - wanted.armor }),
      ...(wanted.hull === undefined ? {} : { damage: 1 - wanted.hull }),
    };
    const transition = health.buildShipHealthTransitionResult(entity, before);
    health.notifyShipHealthAttributesToSession(session, entity, transition, Date.now());
    health.broadcastDamageStateChange(scene, entity);
    return { statusCode: 200, body: { ok: true, shipID, layers: transition.data.afterLayers } };
  }

  return {
    routes: {
      "GET /companion/colonies": colonies,
      "GET /companion/pins": pins,
      "POST /companion/colony/plan": plan,
      "POST /companion/colony/age": age,
      "POST /companion/colony/stock": stock,
      "POST /companion/fleet/form": formFleet,
      "POST /companion/ship/health": shipHealth,
    },
  };
}

module.exports = { createCompanionServer };
