import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAG_CARGO,
  FLAG_DRONE_BAY,
  pickRearmFitting,
  planCorpFetch,
  rearmFitParts,
  rearmNeeds,
  rearmReport,
  type RearmFitting,
} from "../lib/companionRearm.ts";
import {
  decideCompanionAction,
  DEFAULT_FLEET_COMPANION_REQUEST,
  freshLadderMemory,
  type CompanionLadderMemory,
  type FleetCompanionObservation,
} from "../lib/fleetCompanionLoop.ts";
import { applyFitting } from "../../../web/src/bridge/fitModule.ts";
import type { ChatMessage, SpaceSnapshot } from "../../../web/src/store/types.ts";

// Synthetic ids throughout: the documented example character id and its
// neighbours, made-up item ids, and names nobody flies.
const HUMAN = 90000001;
const COMPANION = 90000002;
const SELF_NAME = "Pilot Alpha";
const RIFTER = 587;
const MERLIN = 603;
const GUN = 3082;
const SCRAM = 447;
const ANTIMATTER_S = 230;
const HOBGOBLIN = 2454;
const STATION = 60000001;
const STATION_LINK = `<url=showinfo:1529//${STATION}>Some Station</url>`;
const SYSTEM = 30000142;
const OTHER_SYSTEM = 30000144;
const HIGH_0 = 27;
const MID_0 = 19;

const NAMES: Record<number, string> = { [ANTIMATTER_S]: "Antimatter Charge S", [HOBGOBLIN]: "Hobgoblin I" };
const nameOf = (typeID: number): string | null => NAMES[typeID] ?? null;

function fitting(overrides: Partial<RearmFitting> = {}): RearmFitting {
  return {
    fittingID: 1,
    name: "Rifter brawl",
    shipTypeID: RIFTER,
    modules: [
      { typeID: GUN, flagID: HIGH_0, quantity: 1 },
      { typeID: SCRAM, flagID: MID_0, quantity: 1 },
      { typeID: ANTIMATTER_S, flagID: FLAG_CARGO, quantity: 1000 },
      { typeID: HOBGOBLIN, flagID: FLAG_DRONE_BAY, quantity: 5 },
    ],
    ...overrides,
  };
}

const FITTED = [{ flagID: HIGH_0, typeID: GUN }, { flagID: MID_0, typeID: SCRAM }];

// --- which fitting ------------------------------------------------------------

test("the fitting is the hull's whose slots hold what is fitted", () => {
  const other = fitting({ fittingID: 2, name: "Rifter kite", modules: [
    { typeID: GUN, flagID: HIGH_0, quantity: 1 },
    { typeID: ANTIMATTER_S, flagID: FLAG_CARGO, quantity: 500 },
  ] });
  const choice = pickRearmFitting([other, fitting(), fitting({ fittingID: 3, shipTypeID: MERLIN })], RIFTER, FITTED);
  assert.equal(choice.fitting?.fittingID, 1);
  assert.equal(choice.fitting !== null && choice.exact, true);
});

test("a tie keeps the library's order, so the pilot's own fitting wins", () => {
  const choice = pickRearmFitting([fitting({ fittingID: 7 }), fitting({ fittingID: 8 })], RIFTER, FITTED);
  assert.equal(choice.fitting?.fittingID, 7);
});

test("no fitting for the hull, or none with ammo or drones, is a reason and no fitting", () => {
  assert.deepEqual(pickRearmFitting([fitting({ shipTypeID: MERLIN })], RIFTER, FITTED), {
    fitting: null, reason: "There is no saved fitting for this ship.",
  });
  const bare = fitting({ modules: [{ typeID: GUN, flagID: HIGH_0, quantity: 1 }] });
  assert.deepEqual(pickRearmFitting([bare], RIFTER, FITTED), {
    fitting: null, reason: "No saved fitting for this ship lists any ammo or drones.",
  });
});

// --- what is missing ------------------------------------------------------------

test("what is missing is the fitting's quantity less what the hold and the bay hold", () => {
  const needs = rearmNeeds(
    fitting(),
    [{ itemID: 11, typeID: ANTIMATTER_S, quantity: 300 }],
    // A recovered drone is a singleton with quantity -1: it is one drone.
    [{ itemID: 21, typeID: HOBGOBLIN, quantity: 2 }, { itemID: 22, typeID: HOBGOBLIN, quantity: -1, singleton: true }],
  );
  assert.deepEqual(needs, [
    { flagID: FLAG_CARGO, typeID: ANTIMATTER_S, wanted: 1000, aboard: 300, missing: 700 },
    { flagID: FLAG_DRONE_BAY, typeID: HOBGOBLIN, wanted: 5, aboard: 3, missing: 2 },
  ]);
  const full = rearmNeeds(fitting(), [{ itemID: 11, typeID: ANTIMATTER_S, quantity: 1400 }], []);
  assert.equal(full[0]?.missing, 0, "more than the fitting lists is never a negative need");
});

// --- the corporation's stock ------------------------------------------------------

test("the corp hangar makes up only what the pilot's hangar lacks, lowest division first", () => {
  const needs = rearmNeeds(fitting(), [], []);
  const moves = planCorpFetch(
    needs,
    [{ itemID: 31, typeID: ANTIMATTER_S, quantity: 400 }],
    [
      { division: 3, rows: [{ itemID: 43, typeID: ANTIMATTER_S, quantity: 5000 }] },
      { division: 1, rows: [{ itemID: 41, typeID: ANTIMATTER_S, quantity: 100 }, { itemID: 42, typeID: HOBGOBLIN, quantity: 10 }] },
    ],
  );
  assert.deepEqual(moves, [
    { itemID: 41, typeID: ANTIMATTER_S, division: 1, quantity: 100, wholeStack: true },
    { itemID: 43, typeID: ANTIMATTER_S, division: 3, quantity: 500, wholeStack: false },
    { itemID: 42, typeID: HOBGOBLIN, division: 1, quantity: 5, wholeStack: false },
  ]);
});

test("nothing comes from the corp when the pilot's own hangar has enough", () => {
  const needs = rearmNeeds(fitting(), [], []);
  const moves = planCorpFetch(
    needs,
    [{ itemID: 31, typeID: ANTIMATTER_S, quantity: 1000 }, { itemID: 32, typeID: HOBGOBLIN, quantity: 5 }],
    [{ division: 1, rows: [{ itemID: 41, typeID: ANTIMATTER_S, quantity: 5000 }] }],
  );
  assert.deepEqual(moves, []);
});

// --- the client's FitFitting --------------------------------------------------------

test("the fit parts carry the fitting's whole quantities and the hangar's stacks of what is missing", () => {
  const needs = rearmNeeds(fitting(), [{ itemID: 11, typeID: ANTIMATTER_S, quantity: 300 }], [{ itemID: 21, typeID: HOBGOBLIN, quantity: 5 }]);
  const parts = rearmFitParts(fitting(), needs, [
    { itemID: 31, typeID: ANTIMATTER_S, quantity: 400 },
    { itemID: 32, typeID: ANTIMATTER_S, quantity: 400 },
    { itemID: 33, typeID: HOBGOBLIN, quantity: 5 },
  ]);
  assert.deepEqual(parts, {
    chargesByType: { [ANTIMATTER_S]: 1000 },
    dronesByType: {},
    itemsByType: { [ANTIMATTER_S]: [31, 32] },
  });
  assert.equal(rearmFitParts(fitting(), needs, []), null, "nothing in the hangar is nothing to fit");
});

test("applyFitting sends the charges and drones in the fitting KeyVal's own names", async () => {
  const calls: unknown[][] = [];
  await applyFitting(
    async (...args: unknown[]) => { calls.push(args); return null; },
    { shipID: 1000001, typeID: RIFTER },
    STATION,
    {},
    { [ANTIMATTER_S]: [31] },
    { chargesByType: { [ANTIMATTER_S]: 1000 }, dronesByType: { [HOBGOBLIN]: 5 } },
  );
  assert.deepEqual(calls, [[
    "invbroker", "FitFitting",
    [1000001, RIFTER, { [ANTIMATTER_S]: [31] }, STATION,
      { modulesByFlag: {}, chargesByType: { [ANTIMATTER_S]: 1000 }, dronesByType: { [HOBGOBLIN]: 5 } }, {}, false],
    null, 1000001,
  ]]);
});

// --- what the pilot says ---------------------------------------------------------

test("the report says what came aboard, how much from which corp division, and what is still short", () => {
  const before = rearmNeeds(fitting(), [], []);
  const after = rearmNeeds(fitting(), [{ itemID: 11, typeID: ANTIMATTER_S, quantity: 1000 }], [{ itemID: 21, typeID: HOBGOBLIN, quantity: 3 }]);
  const lines = rearmReport(
    fitting(), before, after,
    [{ itemID: 41, typeID: ANTIMATTER_S, division: 2, quantity: 600, wholeStack: true }],
    nameOf,
    (typeID) => (typeID === ANTIMATTER_S ? 1000 : 3),
  );
  assert.deepEqual(lines, [
    "Rearmed to Rifter brawl: 1000 Antimatter Charge S (600 from corp division 2), 3 Hobgoblin I.",
    "Still short: 2 Hobgoblin I. Not enough in my hangar or the corp hangar here.",
  ]);
});

test("short with the stock there is no room aboard, and a full ship is already rearmed", () => {
  const before = rearmNeeds(fitting(), [], []);
  const lines = rearmReport(fitting(), before, before, [], nameOf, () => 10_000);
  assert.deepEqual(lines, [
    "Could not load 1000 Antimatter Charge S, 5 Hobgoblin I: no room aboard, or the move was refused.",
  ]);
  const full = rearmNeeds(fitting(), [{ itemID: 11, typeID: ANTIMATTER_S, quantity: 1000 }], [{ itemID: 21, typeID: HOBGOBLIN, quantity: 5 }]);
  assert.deepEqual(rearmReport(fitting(), full, full, [], nameOf, () => 0), ["Already rearmed to Rifter brawl."]);
});

// --- `rearm` through the ladder ------------------------------------------------------

const REQUEST = DEFAULT_FLEET_COMPANION_REQUEST;

function grid(): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities: [{ itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null }],
  } as unknown as SpaceSnapshot;
}

/** A supervised companion in space in SYSTEM, nothing of its out. */
function obs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return {
    inSpace: true,
    inWarp: false,
    docked: false,
    fleetTargetTags: null,
    canTag: null,
    inFleet: true,
    fleetMemberCharacterIDs: [HUMAN, COMPANION],
    fleetCommanderCharacterIDs: [HUMAN],
    botDrivenCharacterIDs: [COMPANION],
    myCharacterID: COMPANION,
    pendingFleetInvite: null,
    selfCharacterID: COMPANION,
    selfCharacterName: SELF_NAME,
    flightStatus: { solarSystemID: SYSTEM },
    snapshot: grid(),
    ...overrides,
  } as FleetCompanionObservation;
}

/** Docked at STATION, in another system than the order was heard in. */
function dockedThere(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({
    inSpace: false,
    docked: true,
    snapshot: null,
    flightStatus: { solarSystemID: OTHER_SYSTEM, stationID: STATION, docked: true } as FleetCompanionObservation["flightStatus"],
    ...overrides,
  });
}

function chat(message: string, at = 1_000, characterID = HUMAN): ChatMessage {
  return { characterID, characterName: "Fleet Commander", message, createdAtMs: at };
}

function ordered(line = `rearm at ${STATION_LINK}`): CompanionLadderMemory {
  return decideCompanionAction(REQUEST, obs({ chatMessages: [chat(line)] }), freshLadderMemory(), 2_000).memory;
}

test("'rearm at <station>' routes the autopilot to that station and says so", () => {
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat(`rearm at ${STATION_LINK}`)] }), freshLadderMemory(), 2_000);
  assert.deepEqual(decision.action, { kind: "routeToStation", stationID: STATION });
  assert.equal(decision.phase, "Travelling");
  assert.deepEqual(decision.say, ["Going to rearm, then coming back."]);
  assert.equal(decision.memory.rearm?.orderedAtMs, 1_000);
  assert.equal(decision.memory.rearm?.fromSolarSystemID, SYSTEM);
});

test("a rearm addressed to another pilot moves nobody else", () => {
  const decision = decideCompanionAction(
    REQUEST, obs({ chatMessages: [chat(`rearm Pilot Beta at ${STATION_LINK}`)] }), freshLadderMemory(), 2_000);
  assert.notEqual(decision.action.kind, "routeToStation");
  assert.equal(decision.memory.rearm, null);
});

test("on the way the trip holds the tick and sends no second route", () => {
  const travelling = obs({
    travel: { status: "running", destinationStationID: STATION, destinationSystemID: OTHER_SYSTEM, remainingJumps: 2, failureReason: null },
  } as Partial<FleetCompanionObservation>);
  const decision = decideCompanionAction(REQUEST, travelling, ordered(), 20_000);
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Travelling");
});

test("drones out come home before the route goes, and the line goes with the route", () => {
  const out = obs({ myDroneIDs: [70001], chatMessages: [chat(`rearm at ${STATION_LINK}`)] });
  const recalling = decideCompanionAction(REQUEST, out, freshLadderMemory(), 2_000);
  assert.deepEqual(recalling.action, { kind: "recallDrones", droneIDs: [70001] });
  assert.deepEqual(recalling.say ?? [], []);
  const home = decideCompanionAction(REQUEST, obs({ myDroneIDs: [], chatMessages: [chat(`rearm at ${STATION_LINK}`)] }), recalling.memory, 4_000);
  assert.deepEqual(home.action, { kind: "routeToStation", stationID: STATION });
  assert.deepEqual(home.say, ["Going to rearm, then coming back."]);
});

test("docked there, the pilot rearms, says the answer and undocks for home", () => {
  const rearming = decideCompanionAction(REQUEST, dockedThere(), ordered(), 30_000);
  assert.deepEqual(rearming.action, { kind: "rearmShip", stationID: STATION, orderedAtMs: 1_000 });
  assert.equal(rearming.phase, "Rearming");
  const waitingOn = decideCompanionAction(REQUEST, dockedThere(), rearming.memory, 32_000);
  assert.equal(waitingOn.action.kind, "wait", "no second rearm while the first is answering");
  // An answer to an older order does not end this one.
  const stale = decideCompanionAction(REQUEST, dockedThere({ rearmOutcome: { orderedAtMs: 500, lines: ["old"] } }), rearming.memory, 33_000);
  assert.equal(stale.action.kind, "wait");
  const done = decideCompanionAction(
    REQUEST, dockedThere({ rearmOutcome: { orderedAtMs: 1_000, lines: ["Rearmed to Rifter brawl: 700 Antimatter Charge S."] } }),
    rearming.memory, 34_000);
  assert.deepEqual(done.say, ["Rearmed to Rifter brawl: 700 Antimatter Charge S."]);
  assert.deepEqual(done.action, { kind: "undock" });
  assert.equal(done.memory.rearm, null);
  assert.equal(done.memory.destinationSystemID, SYSTEM, "the way back is the system the order was heard in");
});

test("a rearm that never answers is given up and the pilot comes back as it is", () => {
  const rearming = decideCompanionAction(REQUEST, dockedThere(), ordered(), 30_000);
  const late = decideCompanionAction(REQUEST, dockedThere(), rearming.memory, 30_000 + 91_000);
  assert.deepEqual(late.say, ["The rearm never answered. Coming back as I am."]);
  assert.deepEqual(late.action, { kind: "undock" });
  assert.equal(late.memory.rearm, null);
});

test("docked at another station, the trip routes from there rather than undocking first", () => {
  const elsewhere = obs({
    inSpace: false, docked: true, snapshot: null,
    flightStatus: { solarSystemID: SYSTEM, stationID: 60000002, docked: true } as FleetCompanionObservation["flightStatus"],
  });
  // Past the settle of the route `ordered()` sent from space.
  const decision = decideCompanionAction(REQUEST, elsewhere, ordered(), 20_000);
  assert.deepEqual(decision.action, { kind: "routeToStation", stationID: STATION });
});

test("a bare 'rearm' rearms a docked pilot where it is, and asks where of one in space", () => {
  const docked = dockedThere({ chatMessages: [chat("rearm")] });
  const here = decideCompanionAction(REQUEST, docked, freshLadderMemory(), 2_000);
  assert.deepEqual(here.action, { kind: "rearmShip", stationID: STATION, orderedAtMs: 1_000 });
  assert.deepEqual(here.say, ["Rearming here, then coming back."]);
  const inSpace = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("rearm")] }), freshLadderMemory(), 2_000);
  assert.deepEqual(inSpace.say, ["Rearm where? Link a station: rearm at <station>."]);
  assert.equal(inSpace.memory.rearm, null);
});

test("a paused route is sent again, and only the last route's failure ends the trip out loud", () => {
  const failed = (at: number) => obs({
    travel: { status: "error", destinationStationID: STATION, destinationSystemID: OTHER_SYSTEM, remainingJumps: 0, failureReason: "Approach refused: CHARACTER_IN_USE" },
    chatMessages: [chat(`rearm at ${STATION_LINK}`)],
  } as Partial<FleetCompanionObservation>);
  let memory = decideCompanionAction(REQUEST, obs({ chatMessages: [chat(`rearm at ${STATION_LINK}`)] }), freshLadderMemory(), 2_000).memory;
  // Seen live: the approach to dock met the ladder's own call and the autopilot paused.
  for (const at of [100_000, 200_000]) {
    const again = decideCompanionAction(REQUEST, failed(at), memory, at);
    assert.deepEqual(again.action, { kind: "routeToStation", stationID: STATION }, `re-route at ${at}`);
    assert.deepEqual(again.say ?? [], []);
    memory = again.memory;
  }
  assert.equal(memory.rearm?.routes, 3);
  const decision = decideCompanionAction(REQUEST, failed(300_000), memory, 300_000);
  assert.deepEqual(decision.say, ["Cannot get to that station to rearm: Approach refused: CHARACTER_IN_USE"]);
  assert.equal(decision.memory.rearm, null);
});

test("'stop' calls a rearm trip off", () => {
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("stop", 1_500)] }), ordered(), 3_000);
  assert.equal(decision.memory.rearm, null);
});
