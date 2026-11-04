"use strict";

// Colonies, from the CLI's side. Building goes through the character's own gateway session with
// planetMgr.UserUpdateNetwork, the call a retail client makes, so every rule the server has about
// a colony (skills, CPU, power, ISK) still applies.

const { HEAD_RADIUS, headChange, headsFor, placedPins, programChange } = require("../colonyPlan");

// The character behind an account: the held one when no account is named.
async function characterOf(io, user) {
  if (user) return (await io.pilotState(String(user))).characterID;
  const state = io.readState();
  if (!state.characterID) throw new io.CliError("no character: name an account, or log one in first");
  return state.characterID;
}

function planetCalls(io, state, planetID) {
  const session = { userid: state.accountID };
  const common = { confirm: true, session, bridgeSessionID: state.bridgeSessionID };
  let boundHandle = null;
  const call = async (method, args) => {
    if (!boundHandle) {
      const bound = await io.gateway("POST", "/bound/bind", { service: "planetMgr", method: "MachoBindObject", args: [planetID, null], ...common });
      boundHandle = bound.boundHandle;
    }
    const reply = await io.gateway("POST", "/bound/call", { service: "planetMgr", method, args, boundHandle, ...common });
    return reply.result;
  };
  return call;
}

// Builds a colony for the held character. -> the words for the step's line.
async function buildColony(io, spec) {
  const state = io.requireLogin(io.readState());
  const planned = await io.bridge("POST", "/companion/colony/plan", { spec });
  const call = planetCalls(io, state, planned.planetID);
  await call("UserUpdateNetwork", [planned.changes]);
  const listed = await io.bridge("GET", `/companion/pins?characterID=${state.characterID}&planetID=${planned.planetID}`);
  const placed = placedPins(listed.pins);
  if (placed.ecus.length !== planned.extractors.length) {
    throw new io.CliError(`placed ${placed.ecus.length} control units for ${planned.extractors.length} extract rows`);
  }
  await call("UserUpdateNetwork", [placed.ecus.map((ecu, index) => headChange(ecu, index))]);
  let factoryIndex = 0;
  let firstRoute = 1;
  let total = 0;
  const changes = [];
  for (const [index, plan] of planned.extractors.entries()) {
    const ecu = placed.ecus[index];
    const answer = await call("GetProgramResultInfo", [ecu, plan.resourceTypeID, headsFor(index), HEAD_RADIUS]);
    const yieldPerCycle = Number(Array.isArray(answer) ? answer[0] : 0);
    if (!(yieldPerCycle > 0)) throw new io.CliError(`planet ${planned.planetID} yields nothing of type ${plan.resourceTypeID} there`);
    total += yieldPerCycle;
    const factory = plan.make ? placed.factories[factoryIndex] : null;
    if (plan.make) factoryIndex += 1;
    const made = programChange({ ecu, plan, placed, factory, yieldPerCycle, firstRoute });
    changes.push(...made.changes);
    firstRoute = made.nextRoute;
  }
  await call("UserUpdateNetwork", [changes]);
  return `colony on planet ${planned.planetID}: ${listed.pins.length} pins, ${planned.extractors.length} extractor(s), ${total} units a cycle`;
}

async function ageColonies(io, { user, days, planetID }) {
  const characterID = await characterOf(io, user);
  const reply = await io.bridge("POST", "/companion/colony/age", { characterID, days, planetID });
  if (!reply.colonies) throw new io.CliError(`${user || "that character"} has no colony to age`);
  return `aged ${reply.colonies} colonies by ${days} days (${reply.times} stored times moved)`;
}

async function stockColony(io, { user, planetID, pin, type, quantity }) {
  const characterID = await characterOf(io, user);
  await io.bridge("POST", "/companion/colony/stock", { characterID, planetID, pin, type, quantity });
  return `${quantity} ${type} in the ${pin} of planet ${planetID}`;
}

// -> [COLONY event], each as the server settles it right now.
async function readColonies(io, user) {
  const characterID = await characterOf(io, user);
  const reply = await io.bridge("GET", `/companion/colonies?characterID=${characterID}`);
  return reply.colonies.map((row) => ({ kind: "COLONY", characterID, user: user || null, ...row }));
}

module.exports = { ageColonies, buildColony, characterOf, readColonies, stockColony };
