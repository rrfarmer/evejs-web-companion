// collect-customs: the hauler's half of the customs-office export. The Haul
// button sends a colony's launchpads up into the planet's own customs office
// (over the game port, before the run starts); this block empties every office
// in THIS system that holds goods of the pilot's. Pure, over fixture
// observations - the same idiom as scriptCollectLaunches.test.ts.
//
// What these pin:
//   • an office is found by its GROUP (1025, Planetary Customs Offices), never
//     by its name or by where it sits;
//   • an unread list is "nobody looked", never "they are empty" - reading empty
//     out of a null would fly the hauler home past a full office;
//   • an office that reads empty is finished and the next one is worked;
//   • a full ship ends the block, because that is a finished trip;
//   • warp, then close in, then take - the shape every loot block has.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, SpaceEntity, SpaceShipStatus, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import type { MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { stepSentence } from "../bots/scriptText.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };
const SYSTEM = 30000142;
const GROUP_CUSTOMS_OFFICES = 1025;
const OFFICE_A = 1_200_040_000_001;
const OFFICE_B = 1_200_040_000_002;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "orbital", typeID: 2233, groupID: GROUP_CUSTOMS_OFFICES, categoryID: 46,
    name: "Customs Office", ownerID: null,
    radius: 1000, position: ORIGIN, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  };
}

function ship(over: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: 9001, typeID: 650, name: "Epithal", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[]): SpaceSnapshot {
  return { inSpace: true, solarSystemID: SYSTEM, shipID: 9001, sampledAtMs: 1, entities, ship: ship() };
}

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: true, docked: false, solarSystemID: SYSTEM, stationID: null, structureID: null,
    shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null,
    ...over,
  };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: snapshot([]), lockedTargetIDs: [], holds: null,
    droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null, systemName: "Test System",
    ...over,
  };
}

const NB: ScriptBoard = {};
const collect = SCRIPT_MACROS["collect-customs"]!;
const step: MacroStep = { id: "cc", kind: "macro", macro: "collect-customs", args: {} };

/** An office on grid, `away` metres down the x axis. */
function office(itemID: number, away: number, over: Partial<SpaceEntity> = {}): SpaceEntity {
  return entity({ itemID, position: { x: away, y: 0, z: 0 }, ...over });
}

const holding = (officeID: number, units: number) => ({ officeID, stacks: 1, units });

test("the block is in the catalogue and says what it does", () => {
  assert.equal(stepSentence(step), "Empty every customs office in this system that holds your goods");
});

test("docked -> blocked: an office is emptied from space", () => {
  const t = collect(step, obs({
    inSpace: false, docked: true, snapshot: null,
    flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("⚠ an unread list waits; it is never read as 'every office is empty'", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: null,
  }), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
  assert.match(t.why, /Reading the customs offices/);
});

test("⚠ an empty grid read waits before it is believed; a gate jump lands on one", () => {
  // "There is no office here" finishes the block, which would walk the hauler
  // past a full office if the tick after a jump saw a sparse snapshot.
  const t = collect(step, obs({ snapshot: snapshot([]), customsOffices: [] }), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.match(t.why, /Looking for this system's customs offices/);
});

test("a system that really has no office finishes the block, once", () => {
  const t = collect(step, obs({ snapshot: snapshot([]), customsOffices: [] }), { looked: 15 }, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /no customs office in this system/);
});

test("every office read empty finishes the block", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000), office(OFFICE_B, 2000)]),
    customsOffices: [holding(OFFICE_A, 0), holding(OFFICE_B, 0)],
  }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /Every customs office in this system is emptied/);
});

test("an office holding goods, in reach, is emptied", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_A });
});

test("an office far off is warped to, not flown to", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 20_000_000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "warp", targetID: OFFICE_A });
});

test("an office inside warp range but out of reach is approached", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 50_000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "approach", targetID: OFFICE_A });
});

test("the nearest office holding something is worked first", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 20_000_000), office(OFFICE_B, 1000)]),
    customsOffices: [holding(OFFICE_A, 300), holding(OFFICE_B, 10)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_B });
});

test("an empty office is skipped for one that is holding goods", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000), office(OFFICE_B, 2000)]),
    customsOffices: [holding(OFFICE_A, 0), holding(OFFICE_B, 42)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_B });
});

test("⚠ a structure that is not a customs office is never opened", () => {
  // Group 1025 is the test, not the name: a gantry carries the office's own
  // words and holds nothing.
  const gantry = office(OFFICE_B, 500, { groupID: 1026, typeID: 3962, name: "Customs Office Gantry" });
  const t = collect(step, obs({
    snapshot: snapshot([gantry]),
    customsOffices: [holding(OFFICE_B, 99)],
  }), { looked: 15 }, NB);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.action.kind, "wait");
});

test("a full ship is a finished trip, not a failure", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
    holds: [{
      key: "planetary", label: "Planetary Hold", items: [], present: true, error: null,
      capacity: { capacity: 5000, used: 5000 },
    }] as never,
  }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /full/);
});

test("in warp, nothing is decided", () => {
  const t = collect(step, obs({
    inWarp: true,
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.outcome.kind, "acting");
});

// ── sending a colony's launchpads up, at the office ─────────────────────────
//
// importExportUI.py 549: the client sends a launchpad's goods up from the office's own window, at the office.
// The office's slim item says which planet it is (customsOfficeItem.planetID, importExportUI.py 94), and the
// colony's pins say what each launchpad holds. So the block sends them up when the ship is at that planet's
// office, one launchpad at a time, and then takes what the office holds.

const PLANET_A = 40000001;
const PLANET_B = 40000002;
type Colony = NonNullable<ScriptObservation["colonies"]>[number];
const pin = (pinID: number, kind: Colony["pins"][number]["kind"], contents: readonly [number, number][]): Colony["pins"][number] => ({
  pinID, kind, usedM3: null, capacityM3: null, lastLaunchAtMs: null,
  contents: contents.map(([typeID, quantity]) => ({ typeID, quantity })),
});
const colony = (planetID: number, pins: Colony["pins"]): Colony => ({ planetID, planetName: null, extractors: [], pins });
const refused = (action: string, targetID: number, count: number) => ({
  key: `cc:${action}:${targetID}`, targetID, count, firstAt: 0, lastAt: 0, words: "The server said no.", kind: "refused" as const,
});

test("at an office, a launchpad of its planet's colony that holds goods is sent up before anything is taken", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 300)],
    colonies: [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200], [2073, 50]])])],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "exportCustoms", officeID: OFFICE_A, pinID: 501, commodities: { 2268: 200, 2073: 50 } });
  assert.equal(t.outcome.kind, "acting");
  assert.match(t.why, /up into the customs office/);
});

test("an office that holds nothing is still gone to when its planet's launchpad holds goods", () => {
  const seen = obs({
    snapshot: snapshot([office(OFFICE_A, 500_000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 0)],
    colonies: [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200]])])],
  });
  const t = collect(step, seen, {}, NB);
  assert.deepEqual(t.action, { kind: "warp", targetID: OFFICE_A });
  // With nothing on the launchpad either, there is nothing to go there for.
  const empty = collect(step, { ...seen, colonies: [colony(PLANET_A, [pin(501, "launchpad", [])])] }, {}, NB);
  assert.equal(empty.outcome.kind, "done");
});

test("one launchpad is sent up at a time, and with the launchpads empty the office is emptied", () => {
  const at = (pins: Colony["pins"]) => collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 300)],
    colonies: [colony(PLANET_A, pins)],
  }), {}, NB).action;
  assert.deepEqual(at([pin(501, "launchpad", [[2268, 200]]), pin(502, "launchpad", [[2073, 50]])]), { kind: "exportCustoms", officeID: OFFICE_A, pinID: 501, commodities: { 2268: 200 } });
  assert.deepEqual(at([pin(501, "launchpad", []), pin(502, "launchpad", [[2073, 50]])]), { kind: "exportCustoms", officeID: OFFICE_A, pinID: 502, commodities: { 2073: 50 } });
  assert.deepEqual(at([pin(501, "launchpad", []), pin(502, "launchpad", [])]), { kind: "collectCustoms", officeID: OFFICE_A });
});

test("only a launchpad is sent up: what a command center, a storage or a factory holds stays where it is", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 300)],
    colonies: [colony(PLANET_A, [pin(601, "command", [[2268, 9]]), pin(602, "storage", [[2268, 9]]), pin(603, "factory", [[2268, 9]])])],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_A });
});

test("a factory's inputs on a launchpad stay on the planet: only what the colony makes is sent up", () => {
  const at = (contents: readonly [number, number][]) => collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 300)],
    // 2268 is routed into a factory here: an import the colony runs on.
    colonies: [{ ...colony(PLANET_A, [pin(501, "launchpad", contents)]), factoryInputTypeIDs: [2268] }],
  }), {}, NB).action;
  assert.deepEqual(at([[2268, 3000], [3645, 300]]), { kind: "exportCustoms", officeID: OFFICE_A, pinID: 501, commodities: { 3645: 300 } });
  // Nothing but inputs on the pad: nothing to send up, so the office is emptied.
  assert.deepEqual(at([[2268, 3000]]), { kind: "collectCustoms", officeID: OFFICE_A });
});

test("an office whose planet is not said, another planet's office, and colonies not read: nothing is sent up", () => {
  const pads = [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200]])])];
  const at = (planetID: number | null | undefined, colonies: ScriptObservation["colonies"], units: number) => collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000, planetID === undefined ? {} : { planetID })]),
    customsOffices: [holding(OFFICE_A, units)],
    colonies,
  }), {}, NB);
  // The gateway's snapshot does not say which planet an office is.
  for (const planetID of [undefined, null]) {
    assert.deepEqual(at(planetID, pads, 300).action, { kind: "collectCustoms", officeID: OFFICE_A });
    assert.equal(at(planetID, pads, 0).outcome.kind, "done");
  }
  assert.deepEqual(at(PLANET_B, pads, 300).action, { kind: "collectCustoms", officeID: OFFICE_A });
  assert.equal(at(PLANET_B, pads, 0).outcome.kind, "done");
  // Colonies that could not be read are no reason to stop taking what the offices hold.
  for (const colonies of [null, undefined]) {
    assert.deepEqual(at(PLANET_A, colonies, 300).action, { kind: "collectCustoms", officeID: OFFICE_A });
    assert.equal(at(PLANET_A, colonies, 0).outcome.kind, "done");
  }
});

test("a launchpad the server would not take from is left after five tries; the office is still emptied, and the block says so when it ends", () => {
  const seen = (count: number, units: number) => obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, units)],
    colonies: [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200]]), pin(502, "launchpad", [[2073, 50]])])],
    refusals: count > 0 ? [refused("exportCustoms", 501, count)] : [],
  });
  // Four refusals: still tried. Five: the next launchpad's turn.
  assert.deepEqual(collect(step, seen(4, 300), {}, NB).action, { kind: "exportCustoms", officeID: OFFICE_A, pinID: 501, commodities: { 2268: 200 } });
  assert.deepEqual(collect(step, seen(5, 300), {}, NB).action, { kind: "exportCustoms", officeID: OFFICE_A, pinID: 502, commodities: { 2073: 50 } });
  // Both left: what the office holds is taken all the same.
  const bothLeft = obs({
    snapshot: snapshot([office(OFFICE_A, 1000, { planetID: PLANET_A })]),
    customsOffices: [holding(OFFICE_A, 300)],
    colonies: [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200]]), pin(502, "launchpad", [[2073, 50]])])],
    refusals: [refused("exportCustoms", 501, 5), refused("exportCustoms", 502, 5)],
  });
  assert.deepEqual(collect(step, bothLeft, {}, NB).action, { kind: "collectCustoms", officeID: OFFICE_A });
  // And with the office empty the block ends, saying what it could not send up.
  const ended = collect(step, { ...bothLeft, customsOffices: [holding(OFFICE_A, 0)] }, {}, NB);
  assert.equal(ended.outcome.kind, "done");
  assert.match(ended.why, /2 launchpads would not send their goods up/);
  const one = collect(step, { ...bothLeft, customsOffices: [holding(OFFICE_A, 0)], colonies: [colony(PLANET_A, [pin(501, "launchpad", [[2268, 200]])])] }, {}, NB);
  assert.match(one.why, /1 launchpad would not send its goods up/);
});

test("the nearest office with something to do is worked first, whether that is goods to take or a launchpad to send up", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 900_000, { planetID: PLANET_A }), office(OFFICE_B, 400_000, { planetID: PLANET_B })]),
    customsOffices: [holding(OFFICE_A, 300), holding(OFFICE_B, 0)],
    colonies: [colony(PLANET_B, [pin(701, "launchpad", [[2268, 5]])])],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "warp", targetID: OFFICE_B });
});
