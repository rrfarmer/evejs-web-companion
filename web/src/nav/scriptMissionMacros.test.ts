// The distribution-mission blocks' key transitions: find publishes the agent to
// the board; request travels/talks/asks; accept gates then accepts (or declines
// and re-asks); load confirms aboard; travel rides the autopilot; turn-in
// unloads then completes; return heads back. Pure, over fixture observations.

import test from "node:test";
import assert from "node:assert/strict";

import type {
  AgentConversation,
  CourierBriefing,
  FlightStatus,
  InventoryItemRow,
  JournalState,
} from "../store/types.ts";
import type { MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, ScriptAction, ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS, scriptTravelHome } from "./scriptMacros.ts";
import { createScriptRunner } from "./scriptRunner.ts";

const AGENT = 3018920;
const AGENT_STATION = 60000004;
const PICKUP = 60000004;
const DROPOFF = 60000007;
const CARGO_TYPE = 3814;

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: false, docked: true, solarSystemID: 30000142, stationID: AGENT_STATION, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: false, docked: true, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), journal: { active: [], offered: [] },
    ...over,
  };
}

function convo(actions: readonly { actionID: number; buttonType: number }[], completedFlag = false): AgentConversation {
  return {
    agentSays: "…",
    agentSaysWords: null,
    contentID: 1,
    actions: actions.map((a) => ({ ...a, label: "btn" })),
    lastActionInfo: { missionCompleted: completedFlag, missionDeclined: null, missionQuit: null, loyaltyPoints: null },
  };
}

function briefing(over: Partial<CourierBriefing> = {}): CourierBriefing {
  return {
    missionTitleID: 1, cargoTypeID: CARGO_TYPE, cargoQuantity: 10, cargoVolume: 50,
    pickupLocationID: PICKUP, pickupSystemID: 30000142,
    destinationLocationID: DROPOFF, destinationSystemID: 30000144,
    rewardISK: "100000", bonusISK: null, loyaltyPoints: 10, expirationTime: null, acceptTimestamp: null,
    ...over,
  } as CourierBriefing;
}

function acceptedJournal(): JournalState {
  return { active: [{ missionState: 1, missionTypeLabel: "Courier", missionTitleID: 1, agentID: AGENT, missionID: 7, expirationTime: null }], offered: [] };
}

function row(over: Partial<InventoryItemRow> & { itemID: number }): InventoryItemRow {
  return { typeID: CARGO_TYPE, groupID: null, categoryID: null, flagID: null, quantity: 10, singleton: false, ...over };
}

function step(macro: MacroStep["macro"], args: MacroStep["args"] = {}): MacroStep {
  return { id: "s", kind: "macro", macro, args };
}

const find = SCRIPT_MACROS["find-distribution-agent"]!;
const request = SCRIPT_MACROS["request-mission"]!;
const accept = SCRIPT_MACROS["accept-mission"]!;
const load = SCRIPT_MACROS["load-mission-cargo"]!;
const travel = SCRIPT_MACROS["travel-to-dropoff"]!;
const turnIn = SCRIPT_MACROS["turn-in-mission"]!;
const back = SCRIPT_MACROS["return-to-agent"]!;
const NB: ScriptBoard = {};
const ONBOARD: ScriptBoard = { agentID: AGENT, agentStationID: AGENT_STATION, cargoTypeID: CARGO_TYPE, cargoQuantity: 10, pickupStationID: PICKUP, dropoffStationID: DROPOFF };

test("find: first tick publishes the search criteria to the board", () => {
  const t = find(step("find-distribution-agent", { level: { kind: "count", value: 2 } }), obs(), {}, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.boardPatch?.["findLevel"], 2);
  assert.equal(t.boardPatch?.["findFallback"], 0);
});

test("find: legacy policy is level 1 without fallback, and explicit fallback is published", () => {
  const legacy = find(step("find-distribution-agent"), obs(), {}, NB);
  assert.equal(legacy.boardPatch?.["findLevel"], 1);
  assert.equal(legacy.boardPatch?.["findFallback"], 0);
  const newer = find(step("find-distribution-agent", {
    level: { kind: "count", value: 4 }, fallback: { kind: "toggle", enabled: true },
  }), obs(), {}, NB);
  assert.equal(newer.boardPatch?.["findLevel"], 4);
  assert.equal(newer.boardPatch?.["findFallback"], 1);
});

test("find: exhausted authoritative search blocks rather than retrying", () => {
  const reason = "No eligible level 4 Distribution agent is available.";
  const t = find(step("find-distribution-agent"), obs({ agentSearchFailure: reason }), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.reason, reason);
});

test("find: a match from the finder lands the agent on the board and finishes", () => {
  const t = find(
    step("find-distribution-agent"),
    obs({ foundAgent: { agentID: AGENT, stationID: AGENT_STATION, name: "Aursa", stationName: "Home" } }),
    {},
    NB,
  );
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.boardPatch?.["agentID"], AGENT);
  assert.equal(t.boardPatch?.["agentStationID"], AGENT_STATION);
});

test("request: no agent anywhere -> blocked with a plain fix", () => {
  const t = request(step("request-mission"), obs(), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("request: docked with the agent, no offer -> press Request", () => {
  const t = request(
    step("request-mission"),
    obs({ conversation: convo([{ actionID: 815, buttonType: 2 }]) }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 815 && t.action.agentID === AGENT);
});

test("request: an offer on the table -> done", () => {
  const t = request(step("request-mission"), obs({ briefing: briefing() }), {}, ONBOARD);
  assert.equal(t.outcome.kind, "done");
});

test("request: not at the agent's station -> ride the autopilot there", () => {
  const t = request(
    step("request-mission"),
    obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === AGENT_STATION);
});

test("accept: a fitting offer -> press Accept", () => {
  const t = accept(
    step("accept-mission"),
    obs({
      briefing: briefing(),
      conversation: convo([{ actionID: 816, buttonType: 3 }]),
      cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
      jumpsToDropoff: 3,
    }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 816);
});

test("accept: cargo too big for the ship -> Decline instead", () => {
  const t = accept(
    step("accept-mission"),
    obs({
      briefing: briefing({ cargoVolume: 9000 }),
      conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
      cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
      jumpsToDropoff: 3,
    }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 819, "should press Decline");
});

test("accept: a selected level 4 agent still declines an oversized offer before acceptance", () => {
  const t = accept(
    step("accept-mission"),
    obs({
      briefing: briefing({ cargoVolume: 9000 }),
      conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
      cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
      jumpsToDropoff: 3,
    }),
    {},
    { ...ONBOARD, agentLevel: 4 },
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 819);
});

test("accept: over the player's jump limit -> Decline", () => {
  const t = accept(
    step("accept-mission", { maxJumps: { kind: "count", value: 2 } }),
    obs({
      briefing: briefing(),
      conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
      cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
      jumpsToDropoff: 8,
    }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 819);
});

// ── A reading we do not have is not a reason to turn a job down ──────────────
//
// ⚠ WATCHED HAPPEN, 2026-07-26. The first accept tick after docking gated on a
// cargo hold that had not been read yet, and the bot DECLINED a perfectly good
// courier job with "Your ship did not report how much room its cargo hold has".
// Declining is irreversible — it burns the offer and starts a decline timer —
// so it must never be the answer to "I could not see". `gateOffer` folds
// cannot-tell and fails-the-gate into one string, which is fine for a readout
// and wrong for a decision.

test("accept: an UNREAD cargo hold waits, it does not decline the job", () => {
  const t = accept(
    step("accept-mission"),
    obs({
      briefing: briefing(),
      conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
      cargo: null, // the hold has not been read yet
      jumpsToDropoff: 3,
    }),
    {},
    ONBOARD,
  );
  assert.equal(t.action.kind, "wait", "it must not press anything on a blind tick");
  assert.match(t.why, /Waiting for the ship to report its cargo hold/);
  assert.equal(t.outcome.kind, "acting");
});

test("accept: an offer with no stated volume waits too", () => {
  const t = accept(
    step("accept-mission"),
    obs({
      briefing: briefing({ cargoVolume: null }),
      conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
      cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
      jumpsToDropoff: 3,
    }),
    {},
    ONBOARD,
  );
  assert.equal(t.action.kind, "wait");
  assert.match(t.why, /how big the cargo is/);
});

test("accept: a missing ROUTE waits only when the player set a jump limit", () => {
  const world = (jumps: number | null) => obs({
    briefing: briefing(),
    conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
    cargo: { rows: [], capacity: { capacity: 450, used: 0 } },
    jumpsToDropoff: jumps,
  });
  const limited = accept(step("accept-mission", { maxJumps: { kind: "count", value: 5 } }), world(null), {}, ONBOARD);
  assert.equal(limited.action.kind, "wait");
  assert.match(limited.why, /route to the delivery point/);
  // No ceiling set means the route is not needed to judge the offer.
  const unlimited = accept(step("accept-mission"), world(null), {}, ONBOARD);
  assert.ok(unlimited.action.kind === "agentButton" && unlimited.action.actionID === 816);
});

test("accept: a reading that never arrives ends BLOCKED, not waiting forever", () => {
  const world = obs({
    briefing: briefing(),
    conversation: convo([{ actionID: 816, buttonType: 3 }, { actionID: 819, buttonType: 9 }]),
    cargo: null,
    jumpsToDropoff: 3,
  });
  let mem: Record<string, unknown> = {};
  let last = accept(step("accept-mission"), world, mem, ONBOARD);
  for (let i = 0; i < 10 && last.outcome.kind === "acting"; i++) {
    mem = last.nextMem;
    last = accept(step("accept-mission"), world, mem, ONBOARD);
  }
  assert.equal(last.outcome.kind, "blocked", "the blind wait has to be bounded like every other branch");
  assert.match(String((last.outcome as { reason?: string }).reason ?? ""), /could not read enough/);
});

test("accept: journal says accepted -> done, mission facts on the board", () => {
  const t = accept(step("accept-mission"), obs({ journal: acceptedJournal(), briefing: briefing() }), {}, ONBOARD);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.boardPatch?.["dropoffStationID"], DROPOFF);
});

test("load: package in the hangar -> move it aboard", () => {
  const t = load(
    step("load-mission-cargo"),
    obs({ briefing: briefing(), journal: acceptedJournal(), cargo: { rows: [], capacity: { capacity: 450, used: 0 } }, stationHangar: [row({ itemID: 42 })] }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "loadMissionCargo" && t.action.typeID === CARGO_TYPE && t.action.quantity === 10);
});

test("load: package aboard -> done", () => {
  const t = load(
    step("load-mission-cargo"),
    obs({ briefing: briefing(), cargo: { rows: [row({ itemID: 43 })], capacity: { capacity: 450, used: 50 } } }),
    {},
    ONBOARD,
  );
  assert.equal(t.outcome.kind, "done");
});

test("travel: not there -> startRoute to the drop-off; docked there -> done", () => {
  const going = travel(step("travel-to-dropoff"), obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, ONBOARD);
  assert.ok(going.action.kind === "startRoute" && going.action.stationID === DROPOFF);

  const there = travel(step("travel-to-dropoff"), obs({ flightStatus: flight({ stationID: DROPOFF }) }), {}, ONBOARD);
  assert.equal(there.outcome.kind, "done");
});

test("turn-in: cargo still aboard -> unload it first", () => {
  const t = turnIn(
    step("turn-in-mission"),
    obs({ journal: acceptedJournal(), flightStatus: flight({ stationID: DROPOFF }), cargo: { rows: [row({ itemID: 44 })], capacity: null }, stationHangar: [] }),
    {},
    ONBOARD,
  );
  assert.deepEqual(t.action, { kind: "unloadMissionCargo", itemIDs: [44], quantity: 10 });
});

test("turn-in: unloaded, Complete offered -> press it; journal cleared -> done", () => {
  const press = turnIn(
    step("turn-in-mission"),
    obs({ journal: acceptedJournal(), flightStatus: flight({ stationID: DROPOFF }), cargo: { rows: [], capacity: null }, stationHangar: [row({ itemID: 45 })], conversation: convo([{ actionID: 821, buttonType: 7 }]) }),
    {},
    ONBOARD,
  );
  assert.ok(press.action.kind === "agentButton" && press.action.actionID === 821);

  const done = turnIn(step("turn-in-mission"), obs({ journal: { active: [], offered: [] } }), {}, ONBOARD);
  assert.equal(done.outcome.kind, "done");
});

function deliveryWorld(cargoRows: readonly InventoryItemRow[], hangarRows: readonly InventoryItemRow[] = []): ScriptObservation {
  return obs({ journal: acceptedJournal(), flightStatus: flight({ stationID: DROPOFF }),
    cargo: { rows: cargoRows, capacity: null }, stationHangar: hangarRows,
    conversation: convo([{ actionID: 821, buttonType: 7 }]),
  });
}

for (const quantities of [[10, 1000], [1010], [6, 1004], [6, 4]]) {
  test(`turn-in: delivers ten required units from matching stacks ${quantities.join("+")} and leaves surplus aboard`, () => {
    let cargo = quantities.map((quantity, index) => row({ itemID: 44 + index, quantity }));
    const hangar: InventoryItemRow[] = [];
    let mem: MacroMemory = {};
    let moved = 0;
    for (let i = 0; i < 5; i++) {
      const decision = turnIn(step("turn-in-mission"), deliveryWorld(cargo, hangar), mem, ONBOARD);
      mem = decision.nextMem;
      if (decision.action.kind === "agentButton") break;
      assert.equal(decision.action.kind, "unloadMissionCargo");
      if (decision.action.kind !== "unloadMissionCargo") return;
      const action = decision.action;
      assert.equal(action.itemIDs.length, 1);
      moved += action.quantity;
      assert.ok(moved <= 10, "a later tick never unloads surplus of the same type");
      const selected = cargo.find(item => item.itemID === action.itemIDs[0])!;
      assert.ok(action.quantity <= selected.quantity);
      hangar.push(row({ itemID: 100 + i, quantity: action.quantity }));
      const itemID = selected.itemID;
      const movedQuantity = action.quantity;
      cargo = cargo.map(item => item.itemID === itemID ? { ...item, quantity: item.quantity - movedQuantity } : item).filter(item => item.quantity > 0);
    }
    assert.equal(moved, 10);
    assert.equal(cargo.reduce((sum, item) => sum + item.quantity, 0), quantities.reduce((sum, quantity) => sum + quantity, 0) - 10);
    assert.equal(turnIn(step("turn-in-mission"), deliveryWorld(cargo, hangar), mem, ONBOARD).action.kind, "agentButton");
  });
}

test("turn-in: matching cargo already ashore reduces the required transfer", () => {
  const initial = deliveryWorld([row({ itemID: 44, quantity: 1000 })], [row({ itemID: 45, quantity: 6 })]);
  const decision = turnIn(step("turn-in-mission"), initial, {}, ONBOARD);
  assert.deepEqual(decision.action, { kind: "unloadMissionCargo", itemIDs: [44], quantity: 4 });
  const enough = deliveryWorld([row({ itemID: 44, quantity: 1000 })], [row({ itemID: 45, quantity: 10 })]);
  assert.equal(turnIn(step("turn-in-mission"), enough, {}, ONBOARD).action.kind, "agentButton");
});

test("turn-in: an explicitly cargo-free mission still completes without inventory requirements", () => {
  const decision = turnIn(step("turn-in-mission"), obs({ journal: acceptedJournal(), conversation: convo([{ actionID: 821, buttonType: 7 }]) }), {},
    { ...ONBOARD, cargoTypeID: null, cargoQuantity: null, dropoffStationID: null });
  assert.equal(decision.action.kind, "agentButton");
});

test("turn-in: a transfer waits for both inventory deltas and never repeats a stale split", () => {
  const initial = deliveryWorld([row({ itemID: 44, quantity: 1010 })]);
  const transfer = turnIn(step("turn-in-mission"), initial, {}, ONBOARD);
  const stale = turnIn(step("turn-in-mission"), initial, transfer.nextMem, ONBOARD);
  assert.equal(stale.action.kind, "wait");
  const sourceOnly = deliveryWorld([row({ itemID: 44, quantity: 1000 })]);
  const halfRead = turnIn(step("turn-in-mission"), sourceOnly, stale.nextMem, ONBOARD);
  assert.equal(halfRead.action.kind, "wait");
  const landed = deliveryWorld([row({ itemID: 44, quantity: 1000 })], [row({ itemID: 45, quantity: 10 })]);
  assert.equal(turnIn(step("turn-in-mission"), landed, halfRead.nextMem, ONBOARD).action.kind, "agentButton");
  let last = stale;
  for (let i = 0; i < 12 && last.outcome.kind !== "blocked"; i++) {
    last = turnIn(step("turn-in-mission"), initial, last.nextMem, ONBOARD);
    assert.equal(last.action.kind, "wait");
  }
  assert.equal(last.outcome.kind, "blocked");
});

test("turn-in: unreadable or invalid requirements and inventory never transfer cargo", () => {
  const world = deliveryWorld([row({ itemID: 44, quantity: 1010 })]);
  const { cargoQuantity: _quantity, ...missingQuantity } = ONBOARD;
  for (const board of [missingQuantity, ...[null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(cargoQuantity => ({ ...ONBOARD, cargoQuantity }))]) {
    const decision = turnIn(step("turn-in-mission"), world, {}, board);
    assert.equal(decision.action.kind, "wait");
    assert.equal(decision.outcome.kind, "blocked");
  }
  for (const unreadable of [
    { ...world, cargo: null }, { ...world, stationHangar: null }, { ...world, journal: null },
    { ...world, flightStatus: flight({ stationID: PICKUP }) },
    deliveryWorld([row({ itemID: 44, quantity: NaN })]),
    deliveryWorld([row({ itemID: 44, quantity: 1010 })], [row({ itemID: 45, quantity: -1 })]),
  ]) {
    assert.equal(turnIn(step("turn-in-mission"), unreadable, {}, ONBOARD).action.kind, "wait");
  }
});

for (const code of ["CALL_REFUSED", "EVE_GATEWAY_TIMEOUT"]) {
  test(`turn-in: ${code} cannot consume or duplicate the required cargo quantity`, async () => {
    let first = true;
    const issued: ScriptAction[] = [];
    const runner = createScriptRunner({
      observe: async () => deliveryWorld([row({ itemID: 44, quantity: 1010 })]),
      issue: async action => { issued.push(action); if (first) { first = false; throw Object.assign(new Error(code), { code }); } },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: { "turn-in-mission": (s, o, m) => turnIn(s, o, m, ONBOARD) }, travelHome: scriptTravelHome,
    });
    runner.start({ format: "evejs-bot-script", version: 1, name: "Delivery", notes: "",
      home: { entity: "station", id: DROPOFF, name: "Drop-off", systemName: null }, interrupts: [], program: [step("turn-in-mission")] });
    await runner.tick();
    runner.resume();
    for (let i = 0; i < 12; i++) await runner.tick();
    const expected = { kind: "unloadMissionCargo", itemIDs: [44], quantity: 10 };
    assert.deepEqual(issued, code === "CALL_REFUSED" ? [expected, expected] : [expected]);
    if (code === "EVE_GATEWAY_TIMEOUT") assert.equal(runner.getStatus(), "paused");
  });
}

test("wait: counts down its seconds in ticks, then finishes", () => {
  const wait = SCRIPT_MACROS["wait"]!;
  const s = step("wait", { seconds: { kind: "count", value: 6 } }); // 6s @ 2s/tick = 3 ticks
  const t1 = wait(s, obs(), {}, NB);
  assert.equal(t1.action.kind, "wait");
  assert.equal(t1.outcome.kind, "acting");
  assert.equal(t1.armed, true, "armed from tick one so an `until` can end it early");
  const t2 = wait(s, obs(), t1.nextMem, NB);
  assert.equal(t2.outcome.kind, "acting");
  const t3 = wait(s, obs(), t2.nextMem, NB);
  assert.equal(t3.outcome.kind, "done");
});

test("wait: defaults to 10 seconds when no number is set", () => {
  const wait = SCRIPT_MACROS["wait"]!;
  let mem = {};
  let done = 0;
  for (let i = 0; i < 5; i += 1) {
    const t = wait(step("wait"), obs(), mem, NB);
    mem = t.nextMem;
    if (t.outcome.kind === "done") {
      done = i + 1;
      break;
    }
  }
  assert.equal(done, 5, "10s at the 2s cadence is 5 ticks");
});

// A hull whose bays were all READ and are all absent — the shape a ship with
// nothing but a cargo hold reports. Distinct from `null` (we could not look).
const NO_SPECIAL_BAYS = [
  { key: "cargo", label: "Cargo hold", present: true, capacity: null, items: [], error: null },
  { key: "ore", label: "Ore hold", present: false, capacity: null, items: null, error: null },
];

test("unload-cargo: docked with cargo -> move it all; empty ship -> done; undocked -> blocked", () => {
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  const move = unload(
    step("unload-cargo"),
    obs({
      cargo: { rows: [row({ itemID: 51 }), row({ itemID: 52, typeID: 34 })], capacity: null },
      shipBays: NO_SPECIAL_BAYS,
    }),
    {},
    NB,
  );
  assert.ok(move.action.kind === "unloadHolds", "it empties holds, not just the mission package");
  assert.deepEqual(
    move.action.kind === "unloadHolds" ? move.action.groups.map((g) => ({ bay: g.bay, n: g.itemIDs.length })) : [],
    [{ bay: null, n: 2 }],
    "one group, from the cargo hold",
  );

  const done = unload(step("unload-cargo"), obs({ cargo: { rows: [], capacity: null }, shipBays: NO_SPECIAL_BAYS }), {}, NB);
  assert.equal(done.outcome.kind, "done");

  const undocked = unload(step("unload-cargo"), obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, NB);
  assert.equal(undocked.outcome.kind, "blocked");
});

test("unload-cargo: FREIGHT in a specialised bay is unloaded too — the hauler bug", () => {
  // The ore hold fills from looted ore; before this the block read the cargo
  // hold alone, so a hauler could never put its freight ashore and every later
  // scoop was refused for want of room.
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  const tick = unload(
    step("unload-cargo"),
    obs({
      cargo: { rows: [row({ itemID: 51 })], capacity: null },
      shipBays: [
        { key: "cargo", label: "Cargo hold", present: true, capacity: null, items: [], error: null },
        { key: "ore", label: "Ore hold", present: true, capacity: null, items: [row({ itemID: 71, typeID: 1230 })], error: null },
        // The drone bay is kit and must NOT be emptied at the drop-off.
        { key: "drone", label: "Drone bay", present: true, capacity: null, items: [row({ itemID: 81, typeID: 2486 })], error: null },
        // The ammo hold IS emptied now: the operator asked for it to be
        // supported, and a bay a bot may fill has to be one it can empty. A
        // ship that must keep its charges names it in `exceptBays`.
        { key: "ammo", label: "Ammo hold", present: true, capacity: null, items: [row({ itemID: 82, typeID: 220 })], error: null },
      ],
    }),
    {},
    NB,
  );
  assert.ok(tick.action.kind === "unloadHolds");
  const groups = tick.action.kind === "unloadHolds" ? tick.action.groups : [];
  assert.deepEqual(
    groups.map((g) => ({ bay: g.bay, itemIDs: [...g.itemIDs] })),
    [
      { bay: null, itemIDs: [51] },
      { bay: "ore", itemIDs: [71] },
      { bay: "ammo", itemIDs: [82] },
    ],
    "cargo, the ore hold and the ammo hold: never the drone bay",
  );
});

test("unload-cargo: a bay named in exceptBays is left alone", () => {
  // The ship keeps its own charges. Without this the ammo hold is freight like
  // any other and would be emptied at the drop-off, which on a combat hull means
  // undocking with no ammunition.
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  const withExcept = {
    id: "u",
    kind: "macro",
    macro: "unload-cargo",
    args: { exceptBays: { kind: "bayList", bays: ["ammo"] } },
  } as never;
  const tick = unload(
    withExcept,
    obs({
      cargo: { rows: [], capacity: null },
      shipBays: [
        { key: "cargo", label: "Cargo hold", present: true, capacity: null, items: [], error: null },
        { key: "ore", label: "Ore hold", present: true, capacity: null, items: [row({ itemID: 71, typeID: 1230 })], error: null },
        { key: "ammo", label: "Ammo hold", present: true, capacity: null, items: [row({ itemID: 82, typeID: 220 })], error: null },
      ],
    }),
    {},
    NB,
  );
  assert.ok(tick.action.kind === "unloadHolds");
  const groups = tick.action.kind === "unloadHolds" ? tick.action.groups : [];
  assert.deepEqual(
    groups.map((g) => g.bay),
    ["ore"],
    "the ore hold went ashore; the ammo hold stayed aboard",
  );
});

test("unload-cargo: items named in keepItems stay aboard, wherever they are", () => {
  // The case no bay rule can answer: spare mining crystals sit in the CARGO
  // hold, beside the ore and salvage the trip was for.
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  const withKeep = {
    id: "u",
    kind: "macro",
    macro: "unload-cargo",
    args: { keepItems: { kind: "itemList", items: [{ match: "group", groupID: 483, name: "crystal" }] } },
  } as never;
  const tick = unload(
    withKeep,
    obs({
      cargo: {
        rows: [
          { itemID: 51, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 5, singleton: false },
          { itemID: 52, typeID: 3389, groupID: 483, categoryID: 8, flagID: null, quantity: 2, singleton: false },
        ],
        capacity: null,
      },
      shipBays: NO_SPECIAL_BAYS,
    }),
    {},
    NB,
  );
  assert.ok(tick.action.kind === "unloadHolds");
  const groups = tick.action.kind === "unloadHolds" ? tick.action.groups : [];
  assert.deepEqual(
    groups,
    [{ bay: null, itemIDs: [51] }],
    "the minerals went ashore; the crystals stayed",
  );
});

test("unload-cargo: an unclassifiable row is MOVED, since the hangar is recoverable", () => {
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  const withKeep = {
    id: "u",
    kind: "macro",
    macro: "unload-cargo",
    args: { keepItems: { kind: "itemList", items: [{ match: "group", groupID: 483, name: "crystal" }] } },
  } as never;
  const tick = unload(
    withKeep,
    obs({
      cargo: {
        rows: [{ itemID: 60, typeID: 999, groupID: null, categoryID: null, flagID: null, quantity: 1, singleton: false }],
        capacity: null,
      },
      shipBays: NO_SPECIAL_BAYS,
    }),
    {},
    NB,
  );
  assert.ok(tick.action.kind === "unloadHolds", "it still unloads what it cannot classify");
});

test("unload-cargo: a ship whose holds could not be READ never passes for empty", () => {
  // `shipBays: null` is "we could not look". Reporting done here is exactly the
  // conflation that let a full ore hold sail through this block.
  const unload = SCRIPT_MACROS["unload-cargo"]!;
  let mem: Record<string, unknown> = {};
  for (let i = 0; i < 5; i += 1) {
    const t = unload(step("unload-cargo"), obs({ cargo: { rows: [], capacity: null }, shipBays: null }), mem, NB);
    assert.equal(t.outcome.kind, "acting", `tick ${i} keeps looking rather than declaring done`);
    mem = t.nextMem as Record<string, unknown>;
  }
  const gaveUp = unload(step("unload-cargo"), obs({ cargo: { rows: [], capacity: null }, shipBays: null }), mem, NB);
  assert.equal(gaveUp.outcome.kind, "blocked", "and eventually says so rather than looping forever");
});

test("refine-ore: refines only what is CERTAINLY ore; unknown category is left alone", () => {
  const refine = SCRIPT_MACROS["refine-ore"]!;
  const s = step("refine-ore" as never);
  const ore = row({ itemID: 61, typeID: 1230, categoryID: 25 });
  const mystery = row({ itemID: 62, typeID: 999, categoryID: null });
  const module_ = row({ itemID: 63, typeID: 3634, categoryID: 7 });

  const t = refine(s, obs({ stationHangar: [ore, mystery, module_] }), {}, NB);
  assert.ok(t.action.kind === "reprocessOre");
  assert.deepEqual(t.action.kind === "reprocessOre" ? [...t.action.itemIDs] : [], [61], "only the certain ore stack");

  const done = refine(s, obs({ stationHangar: [mystery, module_] }), {}, NB);
  assert.equal(done.outcome.kind, "done");

  const undocked = refine(s, obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, NB);
  assert.equal(undocked.outcome.kind, "blocked");
});

test("repair watch: a thermostat — on when hurt, off when the cap starves, off when healed", async () => {
  const { decideScriptAction, initialMemory } = await import("./scriptDecide.ts");
  const { scriptTravelHome } = await import("./scriptMacros.ts");
  const script = {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [{ id: "w", when: { kind: "shield-below", fraction: 0.5 }, respond: "repair" }],
    program: [{ id: "s1", kind: "macro", macro: "wait", args: {} }],
  } as never;
  const mem = initialMemory(script as never);
  const base = {
    snapshot: { inSpace: true, solarSystemID: 1, shipID: 9001, sampledAtMs: 1, entities: [], ship: { itemID: 9001, typeID: 1, name: null, mode: null, maxVelocity: 1, radius: 1, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, shieldRatio: 0.3, armorRatio: 1, hullRatio: 1, capacitorRatio: 0.8, shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [] } },
    shieldRepairerIDs: [700],
  };

  // Hurt + cap healthy + rep idle -> switch it ON (self-targeted).
  const on = decideScriptAction(script as never, obs({ ...base, shieldRatio: 0.3, capacitorRatio: 0.8 } as never), mem, {}, scriptTravelHome);
  assert.ok(on.action.kind === "activate" && on.action.moduleID === 700 && on.action.targetID === 0);

  // Hurt but the CAP is starved and the rep is running -> switch it OFF.
  const starvedShip = { ...base.snapshot, ship: { ...base.snapshot.ship, activeModuleIDs: [700] } };
  const off = decideScriptAction(script as never, obs({ ...base, snapshot: starvedShip, shieldRatio: 0.3, capacitorRatio: 0.1 } as never), mem, {}, scriptTravelHome);
  assert.ok(off.action.kind === "deactivate" && off.action.moduleID === 700);

  // HEALED with the rep still running -> switch it off (the shutdown half).
  const healed = decideScriptAction(script as never, obs({ ...base, snapshot: starvedShip, shieldRatio: 0.95, capacitorRatio: 0.8 } as never), mem, {}, scriptTravelHome);
  assert.ok(healed.action.kind === "deactivate" && healed.action.moduleID === 700);

  // Hurt, rep already running, cap fine -> nothing to do; the program continues.
  const running = decideScriptAction(script as never, obs({ ...base, snapshot: starvedShip, shieldRatio: 0.3, capacitorRatio: 0.8 } as never), mem, {}, scriptTravelHome);
  assert.equal(running.action.kind, "wait", "the wait step keeps working while the rep cycles");
});

test("capacitor-below condition: tri-state over the cap reading", async () => {
  const { evaluateCondition } = await import("./scriptConditions.ts");
  assert.equal(evaluateCondition({ kind: "capacitor-below", fraction: 0.3 }, obs({ capacitorRatio: 0.2 } as never)), "met");
  assert.equal(evaluateCondition({ kind: "capacitor-below", fraction: 0.3 }, obs({ capacitorRatio: 0.8 } as never)), "not-met");
  assert.equal(evaluateCondition({ kind: "capacitor-below", fraction: 0.3 }, obs({ capacitorRatio: null } as never)), "cannot-tell");
});

const den = (label: string) => ({ label, kind: "combat" as const });
// One short of the block's own EMPTY_SCAN_CONFIRM_READS, so the next empty read
// is the one that is believed.
const EMPTY_READS_DONE = 2;
const rocks = (label: string) => ({ label, kind: "ore" as const });

// The tour commits its pick with a wait tick and presses the warp on the next
// one: the runner commits a block's memory only when its action succeeds, so
// the label has to be on record BEFORE the press for a refusal to be readable.
// These tests are about WHICH site is flown to, so they step past the commit.
function warpAfterPick(
  macro: NonNullable<(typeof SCRIPT_MACROS)["warp-to-anomaly"]>,
  s: MacroStep,
  o: ScriptObservation,
  board: ScriptBoard,
  mem: MacroMemory = {},
) {
  const picked = macro(s, o, mem, board);
  assert.equal(picked.action.kind, "wait", "the pick is committed before the warp is pressed");
  return macro(s, o, picked.nextMem, board);
}

test("warp-to-anomaly: walks the scanner's dens one by one, never repeating one this run", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const s = step("warp-to-anomaly" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });

  // First pick: the first unvisited den, remembered on the board.
  const go = warpAfterPick(anom, s, obs({ flightStatus: inSpace, anomalies: [den("QEE-288"), den("ABC-123")] }), NB);
  assert.ok(go.action.kind === "warpScan" && go.action.target === "QEE-288");
  assert.equal(go.boardPatch?.["anomsVisited"], "QEE-288");

  // Already visited QEE-288 -> the NEXT den.
  const next = warpAfterPick(anom, s, obs({ flightStatus: inSpace, anomalies: [den("QEE-288"), den("ABC-123")] }), { anomsVisited: "QEE-288" });
  assert.ok(next.action.kind === "warpScan" && next.action.target === "ABC-123");

  // All visited -> another lap over the same dens, not a stop.
  const lap = warpAfterPick(anom, s, obs({ flightStatus: inSpace, anomalies: [den("QEE-288")] }), { anomsVisited: "QEE-288" });
  assert.ok(lap.action.kind === "warpScan" && lap.action.target === "QEE-288");
  assert.equal(lap.outcome.kind, "acting");

  // Warp lifecycle: issued -> in warp -> landed = done.
  const riding = anom(s, obs({ flightStatus: inSpace, inWarp: true }), { issued: true }, NB);
  assert.equal(riding.action.kind, "wait");
  const landed = anom(s, obs({ flightStatus: inSpace, inWarp: false }), { issued: true, sawWarp: true }, NB);
  assert.equal(landed.outcome.kind, "done");

  // Docked -> blocked (undock first).
  const docked = anom(s, obs({}), {}, NB);
  assert.equal(docked.outcome.kind, "blocked");
});

test("warp-to-anomaly: an ore site is not a den — the ratting block skips it", () => {
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const s = step("warp-to-anomaly" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });

  // Rocks first on the scanner, one den behind them: the den is what it flies to.
  const go = warpAfterPick(anom, s, obs({ flightStatus: inSpace, anomalies: [rocks("ORE-111"), den("QEE-288")] }), NB);
  assert.ok(go.action.kind === "warpScan" && go.action.target === "QEE-288");

  // Nothing but rocks (and a site whose kind could not be read) -> blocked, not
  // a hopeful warp into an asteroid field.
  const onlyRocks = anom(
    s,
    obs({ flightStatus: inSpace, anomalies: [rocks("ORE-111"), { label: "XXX-999", kind: "unknown" as const }] }),
    {},
    NB,
  );
  assert.equal(onlyRocks.outcome.kind, "blocked");
});

test("warp-to-ore-anomaly: flies to ore sites only, on its own visited list", () => {
  const ore = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const s = step("warp-to-ore-anomaly" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });
  const sites = [den("QEE-288"), rocks("ORE-111"), rocks("ORE-222")];

  // The den is skipped even though it is first on the scanner.
  const go = warpAfterPick(ore, s, obs({ flightStatus: inSpace, anomalies: sites }), NB);
  assert.ok(go.action.kind === "warpScan" && go.action.target === "ORE-111");
  assert.equal(go.boardPatch?.["oreAnomsVisited"], "ORE-111");

  // Its visited list is its OWN slot: a ratting tour of this system does not
  // make the mining block think it has been everywhere.
  const next = warpAfterPick(ore, s, obs({ flightStatus: inSpace, anomalies: sites }), { oreAnomsVisited: "ORE-111", anomsVisited: "ORE-222" });
  assert.ok(next.action.kind === "warpScan" && next.action.target === "ORE-222");

  // Every ore site visited -> the lap starts again at the first one, and the
  // visited list is REPLACED rather than appended to, so the new lap is a lap
  // and not an immediate second restart. One miner does not empty a cluster in
  // one hold; the run should end at Mine-at-a-belt when the rock is gone, not
  // here because the ship has been here before.
  const lap = warpAfterPick(ore, s, obs({ flightStatus: inSpace, anomalies: sites }), { oreAnomsVisited: "ORE-111,ORE-222" });
  assert.ok(lap.action.kind === "warpScan" && lap.action.target === "ORE-111");
  assert.equal(lap.outcome.kind, "acting");
  assert.equal(lap.boardPatch?.["oreAnomsVisited"], "ORE-111");

  // The den is still not on the mining block's lap.
  const lapAgain = warpAfterPick(ore, s, obs({ flightStatus: inSpace, anomalies: sites }), { oreAnomsVisited: "ORE-111" });
  assert.ok(lapAgain.action.kind === "warpScan" && lapAgain.action.target === "ORE-222");
});

// The server answers a session whose system it cannot resolve with an EMPTY
// full state, not an error — indistinguishable from a system that holds
// nothing. One of those must not end a run.
test("warp-to-ore-anomaly: an empty scanner is re-read before it is believed", () => {
  const ore = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const s = step("warp-to-ore-anomaly" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });
  const empty = () => obs({ flightStatus: inSpace, anomalies: [] });

  const first = ore(s, empty(), {}, NB);
  assert.equal(first.outcome.kind, "acting");
  assert.equal(first.nextMem["emptyReads"], 1);

  const second = ore(s, empty(), first.nextMem, NB);
  assert.equal(second.outcome.kind, "acting");
  assert.equal(second.nextMem["emptyReads"], 2);

  // Third agreeing read: now it is believed.
  const third = ore(s, empty(), second.nextMem, NB);
  assert.equal(third.outcome.kind, "blocked");
  assert.ok(third.outcome.kind === "blocked" && third.outcome.reason.includes("lists no cosmic anomaly"));

  // A read that ARRIVES full on the second look is flown, not stopped on.
  const recovered = warpAfterPick(ore, s, obs({ flightStatus: inSpace, anomalies: [rocks("ORE-111")] }), NB, first.nextMem);
  assert.ok(recovered.action.kind === "warpScan" && recovered.action.target === "ORE-111");
});

// A pilot parked in a field of rock reads "the scanner shows no ore site" as the
// bot being blind, because the panel they are looking at is the OVERVIEW. The
// three dead ends are three different problems and say so.
test("warp-to-ore-anomaly: the dead end says WHICH dead end it is", () => {
  const ore = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
  const s = step("warp-to-ore-anomaly" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });
  const reasonOf = (t: ReturnType<typeof ore>) => (t.outcome.kind === "blocked" ? t.outcome.reason : "");

  // Nothing on the scanner at all: name the panel, because the rocks the pilot
  // can see are on the other one.
  const empty = ore(s, obs({ flightStatus: inSpace, anomalies: [] }), { emptyReads: EMPTY_READS_DONE }, NB);
  assert.equal(empty.outcome.kind, "blocked");
  assert.ok(reasonOf(empty).includes("lists no cosmic anomaly"));
  assert.ok(reasonOf(empty).includes("asteroid belt is not a scanner site"));

  // Sites are there, none of them ore, and one of them unreadable: the count of
  // unreadable rows is the whole diagnosis, so it is in the sentence.
  const noOre = ore(
    s,
    obs({
      flightStatus: inSpace,
      anomalies: [den("QEE-288"), den("ABC-123"), { label: "XXX-999", kind: "unknown" as const }],
    }),
    {},
    NB,
  );
  assert.equal(
    reasonOf(noOre),
    "The scanner lists 3 cosmic anomalies in this system, and not one of them is an ore site. One of them did not say what kind of site it is, and this block will not warp on a guess.",
  );

  // Nothing unreadable -> no second sentence to explain away.
  const cleanRead = ore(s, obs({ flightStatus: inSpace, anomalies: [den("QEE-288")] }), {}, NB);
  assert.equal(
    reasonOf(cleanRead),
    "The scanner lists 1 cosmic anomaly in this system, and not one of them is an ore site.",
  );

  // The ratting block gets the same three answers in its own words.
  const anom = SCRIPT_MACROS["warp-to-anomaly"]!;
  const noDens = anom(step("warp-to-anomaly" as never), obs({ flightStatus: inSpace, anomalies: [] }), { emptyReads: EMPTY_READS_DONE }, NB);
  assert.ok(noDens.outcome.kind === "blocked" && noDens.outcome.reason.includes("no den to fly to"));
  const allUnreadable = anom(
    step("warp-to-anomaly" as never),
    obs({ flightStatus: inSpace, anomalies: [{ label: "XXX-999", kind: "unknown" as const }] }),
    {},
    NB,
  );
  assert.ok(allUnreadable.outcome.kind === "blocked" && allUnreadable.outcome.reason.includes("It did not say what kind of site it is"));
});

test("refit-ship: boards the right hull when needed, applies by NAME, done only once seen fitted", () => {
  const refit = SCRIPT_MACROS["refit-ship"]!;
  const s: MacroStep = { id: "r", kind: "macro", macro: "refit-ship", args: { fitting: { kind: "fitting", fittingID: 5, name: "Ratting Vexor" } } } as never;
  // The rig (flag 92) is never part of a refit: not applied, not checked.
  const fitting = { fittingID: 5, name: "Ratting Vexor", description: "", shipTypeID: 626, ownerID: 1, savedDate: null,
    modules: [{ typeID: 500, flagID: 27, quantity: 1 }, { typeID: 700, flagID: 92, quantity: 1 }] };
  const fittedWith = (modules: { flagID: number; typeID: number }[]) => ({ shipID: 9001, modules });
  const dockedObs = (over: Record<string, unknown>) =>
    obs({ savedFittings: [fitting], activeShipID: 9001, activeFitting: fittedWith([{ flagID: 27, typeID: 501 }]), ...over } as never);

  // Flying the wrong hull (type 17476) with a Vexor (626) in the hangar -> board it.
  const wrongHull = dockedObs({
    stationHangar: [row({ itemID: 9001, typeID: 17476, categoryID: 6, singleton: true }), row({ itemID: 9002, typeID: 626, categoryID: 6, singleton: true })],
  });
  const board = refit(s, wrongHull, {}, NB);
  assert.ok(board.action.kind === "boardShip" && board.action.shipID === 9002);

  // Right hull, wrong module in the high slot, the right one in the hangar -> apply.
  const hullRow = row({ itemID: 9001, typeID: 626, categoryID: 6, singleton: true });
  const rightHull = dockedObs({ stationHangar: [hullRow, row({ itemID: 9100, typeID: 500, quantity: 1 })] });
  const apply = refit(s, rightHull, {}, NB);
  assert.ok(apply.action.kind === "applyFitting" && apply.action.fittingID === 5);
  // ⚠ The apply being SENT is not done: the old module is still fitted.
  const stillOld = refit(s, rightHull, apply.nextMem, NB);
  assert.equal(stillOld.outcome.kind, "acting");
  let mem = apply.nextMem;
  let last = stillOld;
  for (let i = 0; i < 10 && last.outcome.kind === "acting"; i++) { last = refit(s, rightHull, mem, NB); mem = last.nextMem; }
  assert.ok(last.outcome.kind === "blocked" && last.outcome.reason.includes("still not fitted"), "a fit that never lands must stop the bot");
  // Seen fitted (rig untouched) -> done.
  const landed = dockedObs({ stationHangar: [hullRow], activeFitting: fittedWith([{ flagID: 27, typeID: 500 }, { flagID: 92, typeID: 701 }]) });
  assert.equal(refit(s, landed, apply.nextMem, NB).outcome.kind, "done");
  // Already in the fit -> done without applying anything.
  const already = refit(s, landed, {}, NB);
  assert.ok(already.outcome.kind === "done" && already.action.kind === "wait");
  // The hangar lacks the module -> refused before anything moves.
  const empty = refit(s, dockedObs({ stationHangar: [hullRow] }), {}, NB);
  assert.ok(empty.outcome.kind === "blocked" && empty.outcome.reason.includes("1 module short"));

  // Fitting missing from the library -> blocked; undocked -> blocked.
  const missing = refit(s, dockedObs({ savedFittings: [], stationHangar: [] }), {}, NB);
  assert.equal(missing.outcome.kind, "blocked");
  const undocked = refit(s, obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, NB);
  assert.equal(undocked.outcome.kind, "blocked");
});

test("move-items: moves all stacks in one go, or a set amount by splitting; done confirmed by re-read", () => {
  const move = SCRIPT_MACROS["move-items"]!;
  const args = {
    item: { kind: "itemType", typeID: 34, name: "Tritanium" },
    from: { kind: "place", place: "hangar" },
    to: { kind: "place", place: "cargo" },
  } as const;
  const s: MacroStep = { id: "mv", kind: "macro", macro: "move-items", args } as never;
  const trit = (itemID: number, quantity: number) => row({ itemID, typeID: 34, quantity });

  // Move ALL: every matching stack in one action.
  const all = move(s, obs({ stationHangar: [trit(1, 100), trit(2, 50), row({ itemID: 3, typeID: 999 })] }), {}, NB);
  assert.ok(all.action.kind === "moveItems" && all.action.itemIDs.length === 2 && all.action.qty === null);

  // A set amount smaller than the stack: split.
  const some: MacroStep = { ...s, args: { ...args, amount: { kind: "count", value: 30 } } } as never;
  const split = move(some, obs({ stationHangar: [trit(1, 100)] }), {}, NB);
  assert.ok(split.action.kind === "moveItems" && split.action.qty === 30);

  // The FROM place empty of the item -> done.
  const done = move(s, obs({ stationHangar: [row({ itemID: 3, typeID: 999 })] }), {}, NB);
  assert.equal(done.outcome.kind, "done");

  // Same place both sides / undocked -> blocked.
  const bad: MacroStep = { ...s, args: { ...args, to: { kind: "place", place: "hangar" } } } as never;
  assert.equal(move(bad, obs({ stationHangar: [] }), {}, NB).outcome.kind, "blocked");
  assert.equal(move(s, obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, NB).outcome.kind, "blocked");
});

test("warp-to-bookmark: matches by NAME, warps in-system only, done when the warp lands", () => {
  const warpBm = SCRIPT_MACROS["warp-to-bookmark"]!;
  const s: MacroStep = { id: "bm", kind: "macro", macro: "warp-to-bookmark", args: { bookmark: { kind: "bookmark", bookmarkID: null, name: "Safe spot" } } } as never;
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });

  // Name-matched from the live list -> warp.
  const go = warpBm(s, obs({ flightStatus: inSpace, bookmarks: [{ bookmarkID: 77, name: "Safe spot", solarSystemID: 30000142 }] }), {}, NB);
  assert.ok(go.action.kind === "warpBookmark" && go.action.bookmarkID === 77);

  // The spot lives in ANOTHER system -> blocked with the travel hint.
  const elsewhere = warpBm(s, obs({ flightStatus: inSpace, bookmarks: [{ bookmarkID: 77, name: "Safe spot", solarSystemID: 30009999 }] }), {}, NB);
  assert.equal(elsewhere.outcome.kind, "blocked");

  // Warp lifecycle -> done; docked -> blocked.
  const landed = warpBm(s, obs({ flightStatus: inSpace, inWarp: false }), { issued: true, sawWarp: true }, NB);
  assert.equal(landed.outcome.kind, "done");
  assert.equal(warpBm(s, obs({}), {}, NB).outcome.kind, "blocked");
});

test("find-combat-agent: publishes the ENCOUNTER kind so the finder searches security agents", () => {
  const findCombat = SCRIPT_MACROS["find-combat-agent"]!;
  const t = findCombat(step("find-combat-agent" as never, { level: { kind: "count", value: 2 } }), obs(), {}, NB);
  assert.equal(t.boardPatch?.["findKind"], "encounter");
  assert.equal(t.boardPatch?.["findLevel"], 2);
});

test("accept: an ENCOUNTER offer (no cargo) skips the volume gate and accepts on jumps alone", () => {
  const noCargo = briefing({ cargoTypeID: null, cargoQuantity: null, cargoVolume: null });
  const t = accept(
    step("accept-mission", { maxJumps: { kind: "count", value: 10 } }),
    obs({ briefing: noCargo, conversation: convo([{ actionID: 816, buttonType: 3 }]), jumpsToDropoff: 3 }),
    {},
    ONBOARD,
  );
  assert.ok(t.action.kind === "agentButton" && t.action.actionID === 816, "no-cargo offer must not be volume-gated");
});

test("fly-to-mission-site: warps to the Agent Missions bookmark, preferring the real spot", () => {
  const fly = SCRIPT_MACROS["fly-to-mission-site"]!;
  const s = step("fly-to-mission-site" as never);
  const inSpace = flight({ docked: false, inSpace: true, stationID: null });
  const marks = [
    { bookmarkID: 70, name: "", solarSystemID: 30000142, folderName: "Agent Missions", hasSpot: false },
    { bookmarkID: 71, name: "", solarSystemID: 30000142, folderName: "Agent Missions", hasSpot: true },
    { bookmarkID: 72, name: "Safe", solarSystemID: 30000142, folderName: "Spots", hasSpot: true },
  ];
  const go = fly(s, obs({ flightStatus: inSpace, bookmarks: marks }), {}, NB);
  assert.ok(go.action.kind === "warpBookmark" && go.action.bookmarkID === 71, "the coordinates bookmark wins");

  // No mission marks at all -> blocked with "accept a mission first".
  const none = fly(s, obs({ flightStatus: inSpace, bookmarks: [marks[2]!] }), {}, NB);
  assert.equal(none.outcome.kind, "blocked");

  // Site in another system -> blocked with the travel hint.
  const far = fly(s, obs({ flightStatus: inSpace, bookmarks: [{ ...marks[1]!, solarSystemID: 30009999 }] }), {}, NB);
  assert.equal(far.outcome.kind, "blocked");
});

test("restart-extractors: restarts only EXPIRED programs on their own resource, one per tick", () => {
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("restart-extractors" as never);
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const colonies = [
    {
      planetID: 40000001,
      planetName: "Matar V",
      extractors: [
        { pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }, // expired -> restart
        { pinID: 2, resourceTypeID: 2305, expiresAtMs: future, headRadius: 0.02 }, // running -> leave
        { pinID: 3, resourceTypeID: null, expiresAtMs: past, headRadius: 0.02 }, // unknown resource -> never guess
        { pinID: 4, resourceTypeID: 2305, expiresAtMs: past, headRadius: null }, // unknown area -> never guess
      ],
    },
  ];

  const first = restart(s, obs({ colonies } as never), {}, NB);
  assert.ok(first.action.kind === "restartExtractor" && first.action.pinID === 1 && first.action.resourceTypeID === 2268);
  // The drill area goes back UNCHANGED: it is what sets how long the program runs.
  assert.equal(first.action.headRadius, 0.03);

  // The re-read shows pin 1 running again. The unknown-resource and
  // unknown-area pins are SKIPPED (with the skip said out loud), and the
  // running one untouched -> done.
  const after = [
    { ...colonies[0]!, extractors: colonies[0]!.extractors.map((pin) => (pin.pinID === 1 ? { ...pin, expiresAtMs: future } : pin)) },
  ];
  const second = restart(s, obs({ colonies: after } as never), first.nextMem, NB);
  assert.equal(second.outcome.kind, "done");
  assert.match(second.why, /2 extractors .*left alone/);

  // No colonies at all -> done, plainly.
  const none = restart(s, obs({ colonies: [] } as never), {}, NB);
  assert.equal(none.outcome.kind, "done");
});

test("restart-extractors: a restart the server refused ends the run BLOCKED, not done", () => {
  // Live, every restart came back "completely bonkers radius" and the run still
  // ended "Every extractor is running." A tried pin that still reads expired on
  // the next read was refused, and the player has to hear that.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("restart-extractors" as never);
  const past = Date.now() - 60_000;
  const colonies = [
    {
      planetID: 40000001,
      planetName: "Matar V",
      extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }],
    },
  ];
  const first = restart(s, obs({ colonies } as never), {}, NB);
  assert.equal(first.action.kind, "restartExtractor");
  // The re-read still shows it expired: refused.
  const second = restart(s, obs({ colonies } as never), first.nextMem, NB);
  assert.equal(second.outcome.kind, "blocked");
  assert.match(second.outcome.kind === "blocked" ? second.outcome.reason : "", /1 of 1 extractor restart did not take/);
});

test("restart-extractors: after the restarts land, routes sized for the old program are re-sized, then done", () => {
  // Live: a restart raised the yield, the emulator never grows routes, and the
  // game flagged the colony while every factory was running.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("restart-extractors" as never);
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const plan = {
    planetID: 40000001,
    pinID: 1,
    removeRouteIDs: [7],
    create: [{ path: [1, 2], typeID: 2268, quantity: 35608 }],
  };
  const expired = [{
    planetID: 40000001,
    planetName: "Matar V",
    extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }],
    reroutes: [],
  }];
  const first = restart(s, obs({ colonies: expired } as never), {}, NB);
  assert.equal(first.action.kind, "restartExtractor");

  // The re-read: running again, and its route now short of the new maximum.
  const running = [{ ...expired[0]!, extractors: [{ ...expired[0]!.extractors[0]!, expiresAtMs: future }], reroutes: [plan] }];
  const second = restart(s, obs({ colonies: running } as never), first.nextMem, NB);
  assert.deepEqual(second.action, { kind: "rerouteExtractor", ...plan });

  // Settled on the next read -> done.
  const settled = [{ ...running[0]!, reroutes: [] }];
  const third = restart(s, obs({ colonies: settled } as never), second.nextMem, NB);
  assert.equal(third.outcome.kind, "done");

  // Still short after its edit -> refused, and said so.
  const refused = restart(s, obs({ colonies: running } as never), second.nextMem, NB);
  assert.equal(refused.outcome.kind, "blocked");
  assert.match(refused.outcome.kind === "blocked" ? refused.outcome.reason : "", /1 extractor reroute did not take/);
});

test("restart-extractors: a roster of twelve expired extractors is restarted and re-sized to the end, not stopped on a fixed cap", () => {
  // Live: six colonies of two extractors each, all expired. Every restart and
  // reroute landed, and the run stopped on its 21st action saying the
  // reroutes "kept not taking", because the two shared a cap of 20.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("restart-extractors" as never);
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const running = new Set<number>();
  const rerouted = new Set<number>();
  const colonies = () => [1, 2, 3, 4, 5, 6].map((n) => {
    const pins = [n * 10, n * 10 + 1];
    return {
      planetID: 40000000 + n,
      planetName: `Matar ${n}`,
      extractors: pins.map((pinID) => ({ pinID, resourceTypeID: 2268, expiresAtMs: running.has(pinID) ? future : past, headRadius: 0.03 })),
      // A restarted extractor's routes are short of its new maximum until re-sized.
      reroutes: pins.filter((pinID) => running.has(pinID) && !rerouted.has(pinID)).map((pinID) => ({
        planetID: 40000000 + n, pinID, removeRouteIDs: [pinID], create: [{ path: [pinID, 99], typeID: 2268, quantity: 10 }],
      })),
    };
  });
  let mem: MacroMemory = {};
  const kinds: string[] = [];
  for (let tickNo = 0; tickNo < 40; tickNo += 1) {
    const t = restart(s, obs({ colonies: colonies() } as never), mem, NB);
    if (t.outcome.kind !== "acting") {
      assert.equal(t.outcome.kind, "done", t.outcome.kind === "blocked" ? t.outcome.reason : "");
      break;
    }
    const action = t.action as { kind: string; pinID: number };
    kinds.push(action.kind);
    // Each edit lands, as every one did live.
    (action.kind === "restartExtractor" ? running : rerouted).add(action.pinID);
    mem = t.nextMem;
  }
  assert.equal(kinds.filter((kind) => kind === "restartExtractor").length, 12);
  assert.equal(kinds.filter((kind) => kind === "rerouteExtractor").length, 12);
});

test("restart-extractors: a colony with nothing expired still gets its stale routes fixed", () => {
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("restart-extractors" as never);
  const colonies = [{
    planetID: 40000001,
    planetName: "Matar V",
    extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: Date.now() + 60_000, headRadius: 0.03 }],
    reroutes: [{ planetID: 40000001, pinID: 1, removeRouteIDs: [7], create: [{ path: [1, 2], typeID: 2268, quantity: 10 }] }],
  }];
  assert.equal(restart(s, obs({ colonies } as never), {}, NB).action.kind, "rerouteExtractor");
});

test("repair-ship: the shop's quote decides; repairs then done only on a clean re-quote", () => {
  const repair = SCRIPT_MACROS["repair-ship"]!;
  const s = step("repair-ship" as never);

  const fix = repair(s, obs({ damagedItemIDs: [9001, 700] } as never), {}, NB);
  assert.ok(fix.action.kind === "repairItems" && fix.action.itemIDs.length === 2);

  const clean = repair(s, obs({ damagedItemIDs: [] } as never), fix.nextMem, NB);
  assert.equal(clean.outcome.kind, "done");

  const undocked = repair(s, obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, NB);
  assert.equal(undocked.outcome.kind, "blocked");

  // Damage that never clears (no money) -> bounded, then a plain reason.
  let mem: Record<string, unknown> = {};
  let last = fix;
  for (let i = 0; i < 8; i += 1) {
    last = repair(s, obs({ damagedItemIDs: [9001] } as never), mem, NB);
    mem = { ...last.nextMem };
    if (last.outcome.kind === "blocked") break;
  }
  assert.equal(last.outcome.kind, "blocked");
});

test("describeBoard: names only, never ids; silent when there is nothing to say", async () => {
  const { describeBoard } = await import("./scriptDecide.ts");
  assert.equal(describeBoard({}), null);
  assert.equal(describeBoard({ agentID: 3018920 }), null, "an id alone renders NOTHING (R7d)");
  assert.equal(describeBoard({ agentName: "Aursa" }), "Working with Aursa");
  assert.equal(
    describeBoard({ agentName: "Aursa", agentStationName: "Home Station" }),
    "Working with Aursa (Home Station)",
  );
});

test("travel-home resolves fixed, starting and board-slot homes", async () => {
  const { resolveStationRef } = await import("./scriptMacros.ts");
  assert.equal(
    resolveStationRef({ entity: "station", id: 60000001, name: "Fixed", systemName: null }, null, {}),
    60000001,
  );
  assert.equal(
    resolveStationRef(
      { entity: "station", id: null, name: null, systemName: null, starting: true },
      AGENT_STATION,
      {},
    ),
    AGENT_STATION,
  );
  assert.equal(
    resolveStationRef(
      { entity: "station", id: null, name: null, systemName: null, slot: "dropoff-station" },
      null,
      { dropoffStationID: 60000077 },
    ),
    60000077,
  );
});

test("travel-home (safety fly-home): rides to resolved home; unknown space-start pauses honestly", async () => {
  const { scriptTravelHome } = await import("./scriptMacros.ts");
  // In space, home off-grid (another system entirely) -> hand it to the autopilot.
  const going = scriptTravelHome(obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }), homeStationID: AGENT_STATION, snapshot: null }), {});
  assert.ok(going.action.kind === "startRoute" && going.action.stationID === AGENT_STATION);

  // Docked — anywhere — is safe; the latch can fire its pause.
  const safe = scriptTravelHome(obs({ flightStatus: flight({ docked: true, stationID: 60000099 }), homeStationID: AGENT_STATION }), {});
  assert.equal(safe.outcome.kind, "done");

  // Starting in space cannot turn "starting station" into a station. It pauses
  // instead of falsely reporting that an exposed ship is safely home.
  const noHome = scriptTravelHome(
    obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }), homeStationID: null }),
    {},
  );
  assert.equal(noHome.outcome.kind, "blocked");
  assert.match(noHome.outcome.kind === "blocked" ? noHome.outcome.reason : "", /does not know which station/i);
});

test("return: rides home to the agent's station and is done when docked there", () => {
  const going = back(step("return-to-agent"), obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }), {}, ONBOARD);
  assert.ok(going.action.kind === "startRoute" && going.action.stationID === AGENT_STATION);

  const there = back(step("return-to-agent"), obs(), {}, ONBOARD);
  assert.equal(there.outcome.kind, "done");
});
