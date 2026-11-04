"use strict";

// What building and aging a colony comes to, free of the game and of the CLI, so it can be tested
// with stubs. The server half supplies the static data (server.js); the CLI sends the changes on
// the character's own session, the call a retail client makes (tool/colony.js).

const COMMAND = Object.freeze({
  CREATE_PIN: 1,
  CREATE_LINK: 3,
  CREATE_ROUTE: 6,
  SET_SCHEMATIC: 8,
  UPGRADE_COMMAND_CENTER: 9,
  ADD_EXTRACTOR_HEAD: 10,
  INSTALL_PROGRAM: 13,
});
const TEMPORARY_PIN = 1;
const TEMPORARY_ROUTE = 2;
const HEAD_RADIUS = 0.03;
const SPACING = 0.02;
const FILETIME_TICKS_PER_DAY = 864_000_000_000n;

const pinID = (index) => [TEMPORARY_PIN, index];

// The problems with a colony spec, as text; none means it is good.
function specProblems(spec) {
  const problems = [];
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return ["a colony is an object: { planetID, extract: [...] }"];
  for (const key of Object.keys(spec)) {
    if (!["planetID", "level", "extract"].includes(key)) problems.push(`${key}: unknown key; a colony takes planetID, level and extract`);
  }
  if (!(Number.isInteger(spec.planetID) && spec.planetID > 0)) problems.push("planetID: the planet's ID");
  if (spec.level !== undefined && !(Number.isInteger(spec.level) && spec.level >= 0 && spec.level <= 5)) problems.push("level: the command centre's level, 0 to 5");
  if (!Array.isArray(spec.extract) || !spec.extract.length) problems.push('extract: at least one { "resource": "Base Metals" }');
  for (const [index, row] of (Array.isArray(spec.extract) ? spec.extract : []).entries()) {
    if (row === null || typeof row !== "object") {
      problems.push(`extract[${index}]: an object`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!["resource", "make", "into"].includes(key)) problems.push(`extract[${index}].${key}: unknown key; resource, make or into`);
    }
    if (typeof row.resource !== "string" || !row.resource) problems.push(`extract[${index}].resource: the resource's name`);
    if (row.make !== undefined && typeof row.make !== "string") problems.push(`extract[${index}].make: the name of what a factory makes from it`);
    if (row.into !== undefined && !["launchpad", "command"].includes(row.into)) problems.push(`extract[${index}].into: launchpad (the default) or command`);
    if (row.make !== undefined && row.into === "command") problems.push(`extract[${index}]: make always delivers to the launchpad; leave into out`);
  }
  return problems;
}

// The planet's own pin types: a command centre, an extractor control unit, a launchpad and a
// basic factory. infos: planetStaticData.listPITypeInfos() rows.
function pinTypesFor(planetTypeID, infos) {
  const mine = infos.filter((row) => row.planetRestrictionTypeID === planetTypeID);
  const one = (entity, tier = null) => {
    const row = mine.find((info) => info.pinEntityType === entity && (tier === null || info.processorTier === tier));
    if (!row) throw new Error(`no ${tier ? `${tier} ` : ""}${entity} pin for planet type ${planetTypeID}`);
    return row.typeID;
  };
  return { command: one("command"), ecu: one("ecu"), launchpad: one("spaceport"), factory: one("process", "basic") };
}

// The first change: the pins, the links and the factories' recipes. The command centre is upgraded
// straight after it is placed, or the next pin is refused on CPU. typeIDOf(name), schematicFor(name).
function planPins(spec, { pinTypes, typeIDOf, schematicFor }) {
  const problems = specProblems(spec);
  if (problems.length) throw new Error(problems.join("; "));
  const latitude = 1.5;
  const longitude = 1.5;
  const changes = [];
  let next = 1;
  const place = (typeID, lat, lon) => {
    const id = pinID(next);
    next += 1;
    changes.push([COMMAND.CREATE_PIN, [id, typeID, lat, lon]]);
    return id;
  };
  const command = place(pinTypes.command, latitude, longitude);
  changes.push([COMMAND.UPGRADE_COMMAND_CENTER, [command, spec.level === undefined ? 5 : spec.level]]);
  const pad = place(pinTypes.launchpad, latitude + SPACING, longitude);
  changes.push([COMMAND.CREATE_LINK, [command, pad, 0]]);
  const extractors = [];
  for (const [index, row] of spec.extract.entries()) {
    const ecu = place(pinTypes.ecu, latitude + SPACING, longitude + SPACING * (index + 1));
    changes.push([COMMAND.CREATE_LINK, [pad, ecu, 0]]);
    const plan = { resourceTypeID: typeIDOf(row.resource), into: row.into || "launchpad", make: null };
    if (row.make) {
      const schematic = schematicFor(row.make);
      const factory = place(pinTypes.factory, latitude + SPACING * 2, longitude + SPACING * (index + 1));
      changes.push([COMMAND.CREATE_LINK, [pad, factory, 0]]);
      changes.push([COMMAND.SET_SCHEMATIC, [factory, schematic.schematicID]]);
      plan.make = { typeID: schematic.typeID, quantity: schematic.quantity };
    }
    extractors.push(plan);
  }
  return { planetID: spec.planetID, changes, extractors };
}

// Which placed pins are the plan's. Pins get their IDs in the order they were placed, so the nth
// control unit and the nth factory are the nth extract row's. pins: [{ pinID, kind }].
function placedPins(pins) {
  const ofKind = (kind) => pins.filter((pin) => pin.kind === kind).map((pin) => pin.pinID).sort((a, b) => a - b);
  return { command: ofKind("command")[0], pad: ofKind("spaceport")[0], ecus: ofKind("ecu"), factories: ofKind("process") };
}

// One extractor's head, to go before its programme is asked for its yield.
function headChange(ecu, index) {
  return [COMMAND.ADD_EXTRACTOR_HEAD, [ecu, 0, 1.5 + SPACING, 1.5 + SPACING * (index + 1) + HEAD_RADIUS]];
}

function headsFor(index) {
  return [[0, 1.5 + SPACING, 1.5 + SPACING * (index + 1) + HEAD_RADIUS]];
}

// The second change for one extractor: its programme and where the yield goes.
function programChange({ ecu, plan, placed, factory, yieldPerCycle, firstRoute }) {
  const changes = [[COMMAND.INSTALL_PROGRAM, [ecu, plan.resourceTypeID, HEAD_RADIUS]]];
  let route = firstRoute;
  const create = (path, typeID, quantity) => {
    changes.push([COMMAND.CREATE_ROUTE, [[TEMPORARY_ROUTE, route], path, typeID, quantity]]);
    route += 1;
  };
  if (plan.make) {
    create([ecu, placed.pad, factory], plan.resourceTypeID, yieldPerCycle);
    create([factory, placed.pad], plan.make.typeID, plan.make.quantity);
  } else if (plan.into === "command") {
    create([ecu, placed.pad, placed.command], plan.resourceTypeID, yieldPerCycle);
  } else {
    create([ecu, placed.pad], plan.resourceTypeID, yieldPerCycle);
  }
  return { changes, nextRoute: route };
}

// A colony as if `days` had passed: every stored time moves back, and the server settles the
// production the next time it reads the colony. Moving the times back, not the clock forward,
// keeps them agreeing with the wall clock the page compares them against. Only a whole filetime
// moves, never a cycle length. -> the number of times moved.
function rewindColony(colony, days) {
  const ticks = BigInt(Math.round(days * 1000)) * FILETIME_TICKS_PER_DAY / 1000n;
  let moved = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (/Time$/.test(key) && /^[0-9]{17,}$/.test(String(inner))) {
        value[key] = String(BigInt(inner) - ticks);
        moved += 1;
      } else {
        walk(inner);
      }
    }
  };
  walk(colony);
  return moved;
}

// What the timeline says of a colony. entityOf(typeID): the pin's kind; filetimeNow: a BigInt.
function summarize(colony, { entityOf, filetimeNow }) {
  const pins = Array.isArray(colony.pins) ? colony.pins : [];
  const units = (kinds) => pins.filter((pin) => kinds.includes(entityOf(pin.typeID)))
    .reduce((total, pin) => total + Object.values(pin.contents || {}).reduce((sum, quantity) => sum + Number(quantity), 0), 0);
  const programmes = pins.filter((pin) => entityOf(pin.typeID) === "ecu" && pin.expiryTime);
  const running = programmes.filter((pin) => BigInt(pin.expiryTime) > filetimeNow);
  const ecus = pins.filter((pin) => entityOf(pin.typeID) === "ecu");
  return {
    planetID: Number(colony.planetID),
    pins: pins.length,
    level: Number(colony.level ?? colony.commandCenterLevel ?? 0),
    extractors: ecus.length,
    extracting: running.length,
    finished: ecus.length - running.length,
    launchpadUnits: units(["spaceport"]),
    commandUnits: units(["command"]),
    routes: Array.isArray(colony.routes) ? colony.routes.length : 0,
  };
}

module.exports = {
  COMMAND,
  HEAD_RADIUS,
  headChange,
  headsFor,
  pinTypesFor,
  placedPins,
  planPins,
  programChange,
  rewindColony,
  specProblems,
  summarize,
};
