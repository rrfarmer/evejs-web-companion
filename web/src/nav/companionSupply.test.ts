import test from "node:test";
import assert from "node:assert/strict";

import {
  ammoSupply,
  FRESH_COMPANION_SUPPLY,
  LOW_AMMO_RELOADS,
  statusLine,
  SUPPLY_ALERT_SETTLE_MS,
  superviseSupply,
} from "./companionSupply.ts";
import {
  createFleetCompanion,
  decideCompanionAction,
  DEFAULT_FLEET_COMPANION_REQUEST,
  freshLadderMemory,
  type CompanionLadderMemory,
  type FleetCompanionAction,
  type FleetCompanionObservation,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import type { ChatMessage, SpaceSnapshot } from "../store/types.ts";

// Synthetic ids throughout: the documented example character id and its
// neighbours, and names nobody flies.
const HUMAN = 90000001;
const COMPANION = 90000002;
const OTHER_COMPANION = 90000003;
const SELF_NAME = "Pilot Alpha";
const GUN_A = 5001;
const GUN_B = 5002;
const HYBRID = 85; // a charge group
const ANTIMATTER_S = 230;
const IRON_S = 222;
const ANTIMATTER_M = 231;
const STATION = 60000001;
const SUN = 40000001;
const SYSTEM = 30000142;

const REQUEST: FleetCompanionRequest = { ...DEFAULT_FLEET_COMPANION_REQUEST, weaponModuleIDs: [GUN_A, GUN_B] };

function grid(withStation: boolean): SpaceSnapshot {
  const entities: unknown[] = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    { itemID: SUN, kind: "sun", isSelf: false, position: { x: 900_000_000, y: 0, z: 0 }, radius: 63_350_000, mode: null },
  ];
  if (withStation) {
    entities.push({ itemID: STATION, kind: "station", isSelf: false, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null });
  }
  return { inSpace: true, ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null }, entities } as unknown as SpaceSnapshot;
}

/** A supervised companion in space, its two small hybrid guns loaded with 40 each. */
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
    snapshot: grid(true),
    weaponChargeGroups: { [GUN_A]: [HYBRID], [GUN_B]: [HYBRID] },
    loadedCharges: [
      { moduleID: GUN_A, typeID: ANTIMATTER_S, quantity: 40 },
      { moduleID: GUN_B, typeID: ANTIMATTER_S, quantity: 40 },
    ],
    cargoCharges: [{ itemID: 7001, typeID: ANTIMATTER_S, groupID: HYBRID, quantity: 400 }],
    chargeFactsByTypeID: {
      [ANTIMATTER_S]: { damage: null, rangeMultiplier: null, falloffMultiplier: null, maxVelocity: null, explosionDelayMs: null, size: 1, name: "Antimatter Charge S" },
      [IRON_S]: { damage: null, rangeMultiplier: null, falloffMultiplier: null, maxVelocity: null, explosionDelayMs: null, size: 1, name: "Iron Charge S" },
      [ANTIMATTER_M]: { damage: null, rangeMultiplier: null, falloffMultiplier: null, maxVelocity: null, explosionDelayMs: null, size: 2, name: "Antimatter Charge M" },
    },
    combatDroneStacks: [{ itemID: 8001, typeID: 2488, quantity: 5 }],
    combatDroneIDs: [],
    droneLimits: { bandwidthMbit: 25, maxActive: 5 },
    ...overrides,
  } as FleetCompanionObservation;
}

function chat(message: string, at = 1_000, characterID = HUMAN): ChatMessage {
  return { characterID, characterName: "Fleet Commander", message, createdAtMs: at };
}

/** Run the supply step on its own over a series of observations, collecting what was said. */
function supervise(steps: readonly { readonly at: number; readonly obs: FleetCompanionObservation }[], memory = freshLadderMemory()) {
  const said: string[] = [];
  let mem: CompanionLadderMemory = memory;
  for (const step of steps) {
    const out = superviseSupply(REQUEST, step.obs, mem, step.at);
    said.push(...out.say);
    mem = out.memory;
  }
  return { said, memory: mem };
}

// --- ammo ---------------------------------------------------------------------

test("reloads are the spare rounds over a full load of every gun drawing on them", () => {
  // 400 spare over 2 x 40 = 5 reloads.
  assert.deepEqual(ammoSupply(REQUEST, obs(), {}), {
    reloads: 5,
    loaded: 80,
    spare: [{ typeID: ANTIMATTER_S, quantity: 400 }],
  });
});

test("a second charge the guns take counts as reloads; one of another size does not", () => {
  const supply = ammoSupply(REQUEST, obs({
    cargoCharges: [
      { itemID: 7001, typeID: ANTIMATTER_S, groupID: HYBRID, quantity: 100 },
      { itemID: 7002, typeID: IRON_S, groupID: HYBRID, quantity: 100 },
      { itemID: 7003, typeID: ANTIMATTER_M, groupID: HYBRID, quantity: 1000 },
    ],
  }), {});
  assert.equal(supply?.reloads, 2, "200 small rounds over 80 a load");
  // Largest first, and a tie by type id.
  assert.deepEqual(supply?.spare.map((stack) => stack.typeID), [IRON_S, ANTIMATTER_S]);
});

test("a gun's load is the most it has been seen holding, so a half-empty gun is not a small magazine", () => {
  const halfEmpty = obs({ loadedCharges: [
    { moduleID: GUN_A, typeID: ANTIMATTER_S, quantity: 10 },
    { moduleID: GUN_B, typeID: ANTIMATTER_S, quantity: 40 },
  ] });
  assert.equal(ammoSupply(REQUEST, halfEmpty, { [GUN_A]: 40 })?.reloads, 5);
});

test("an empty gun never seen loaded counts as its sibling; no gun ever seen loaded says nothing", () => {
  const oneEmpty = obs({ loadedCharges: [{ moduleID: GUN_B, typeID: ANTIMATTER_S, quantity: 40 }] });
  assert.equal(ammoSupply(REQUEST, oneEmpty, {})?.reloads, 5);
  assert.equal(ammoSupply(REQUEST, obs({ loadedCharges: [] }), {})?.reloads, null);
});

test("a laser's single crystal is not a magazine, so no spare crystals is not out of ammo", () => {
  const lasers = obs({
    loadedCharges: [
      { moduleID: GUN_A, typeID: ANTIMATTER_S, quantity: 1 },
      { moduleID: GUN_B, typeID: ANTIMATTER_S, quantity: 1 },
    ],
    cargoCharges: [],
  });
  assert.equal(ammoSupply(REQUEST, lasers, {})?.reloads, null);
  assert.deepEqual(supervise([{ at: 0, obs: lasers }, { at: 60_000, obs: lasers }]).said, []);
});

test("an unread fit or cargo is no ammo report at all, never zero", () => {
  assert.equal(ammoSupply(REQUEST, obs({ cargoCharges: null }), {}), null);
  assert.equal(ammoSupply(REQUEST, obs({ loadedCharges: null }), {}), null);
  assert.equal(ammoSupply(REQUEST, obs({ weaponChargeGroups: null }), {}), null);
});

test(`low ammo (${LOW_AMMO_RELOADS} reloads or fewer) is said once, after it has held`, () => {
  const low = obs({ cargoCharges: [{ itemID: 7001, typeID: ANTIMATTER_S, groupID: HYBRID, quantity: 160 }] });
  const { said, memory } = supervise([
    { at: 0, obs: obs() },
    { at: 1_000, obs: low },
    { at: 1_000 + SUPPLY_ALERT_SETTLE_MS - 1, obs: low },
  ]);
  assert.deepEqual(said, [], "not yet: a level must hold before it is said");
  const later = supervise([
    { at: 1_000 + SUPPLY_ALERT_SETTLE_MS, obs: low },
    { at: 30_000, obs: low },
  ], memory);
  assert.deepEqual(later.said, ["Low on ammo: 2 reloads left."]);
});

test("running out after low is said again; a resupply re-arms the warning silently", () => {
  const low = obs({ cargoCharges: [{ itemID: 7001, typeID: ANTIMATTER_S, groupID: HYBRID, quantity: 160 }] });
  const out = obs({ cargoCharges: [] });
  const { said } = supervise([
    { at: 0, obs: low },
    { at: SUPPLY_ALERT_SETTLE_MS, obs: low },
    { at: 20_000, obs: out },
    { at: 20_000 + SUPPLY_ALERT_SETTLE_MS, obs: out },
    { at: 40_000, obs: obs() },
    { at: 50_000, obs: low },
    { at: 50_000 + SUPPLY_ALERT_SETTLE_MS, obs: low },
  ]);
  assert.deepEqual(said, [
    "Low on ammo: 2 reloads left.",
    "Out of spare ammo: 80 rounds left in the guns.",
    "Low on ammo: 2 reloads left.",
  ]);
});

// --- drones ---------------------------------------------------------------------

test("losing drones below a full flight is said; launching them is not", () => {
  const launched = obs({ combatDroneStacks: [], combatDroneIDs: [1, 2, 3, 4, 5] });
  const lost = obs({ combatDroneStacks: [], combatDroneIDs: [1, 2, 3] });
  const { said } = supervise([
    { at: 0, obs: obs() },
    { at: 2_000, obs: launched },
    // One tick where the bay read was already empty and the scene had not caught up.
    { at: 4_000, obs: obs({ combatDroneStacks: [], combatDroneIDs: [1, 2] }) },
    { at: 6_000, obs: launched },
    { at: 30_000, obs: lost },
    { at: 30_000 + SUPPLY_ALERT_SETTLE_MS, obs: lost },
  ]);
  assert.deepEqual(said, ["Low on drones: 3 left (0 in bay, 3 out)."]);
});

test("a recovered drone, a singleton the bay reports as -1, counts as one", () => {
  const recovered = obs({ combatDroneStacks: [
    { itemID: 8001, typeID: 2488, quantity: -1 },
    { itemID: 8002, typeID: 2488, quantity: -1 },
    { itemID: 8003, typeID: 2488, quantity: 3 },
  ] });
  assert.match(statusLine(REQUEST, recovered, FRESH_COMPANION_SUPPLY), /Drones: 5 in bay, 0 out\.$/);
});

test("every drone gone is said as out of drones", () => {
  const none = obs({ combatDroneStacks: [], combatDroneIDs: [] });
  const { said } = supervise([
    { at: 0, obs: obs() },
    { at: 10_000, obs: none },
    { at: 10_000 + SUPPLY_ALERT_SETTLE_MS, obs: none },
  ]);
  assert.deepEqual(said, ["Out of drones."]);
});

test("a hull that carries fewer drones than the pilot could fly is not low for it", () => {
  const two = obs({ combatDroneStacks: [{ itemID: 8001, typeID: 2488, quantity: 2 }] });
  assert.deepEqual(supervise([{ at: 0, obs: two }, { at: 60_000, obs: two }]).said, []);
});

test("a ship that never carried drones never warns about them", () => {
  const none = obs({ combatDroneStacks: [], combatDroneIDs: [] });
  assert.deepEqual(supervise([{ at: 0, obs: none }, { at: 60_000, obs: none }]).said, []);
});

// --- the status line ---------------------------------------------------------------

test("the status line says reloads, rounds and drones in plain ASCII", () => {
  const line = statusLine(REQUEST, obs({ combatDroneStacks: [{ itemID: 8001, typeID: 2488, quantity: 2 }], combatDroneIDs: [1, 2, 3] }), FRESH_COMPANION_SUPPLY);
  assert.equal(line, "Ammo: 5 reloads left, 80 loaded, 400 Antimatter Charge S in cargo. Drones: 2 in bay, 3 out.");
  assert.match(line, /^[\x20-\x7e]+$/);
});

test("the status line says what it could not read rather than zero", () => {
  assert.equal(
    statusLine(REQUEST, obs({ cargoCharges: null, combatDroneIDs: null }), FRESH_COMPANION_SUPPLY),
    "Ammo: could not read. Drones: could not read.",
  );
  assert.equal(
    statusLine({ ...REQUEST, weaponModuleIDs: [] }, obs({ combatDroneStacks: [], combatDroneIDs: [] }), FRESH_COMPANION_SUPPLY),
    "Ammo: no guns that use it. Drones: none carried.",
  );
});

// --- `status` through the ladder --------------------------------------------------

test("'status' from the commander is answered in the same tick", () => {
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("status")] }), freshLadderMemory(), 2_000);
  assert.deepEqual(decision.say, ["Ammo: 5 reloads left, 80 loaded, 400 Antimatter Charge S in cargo. Drones: 5 in bay, 0 out."]);
  // Answered once: the same line on the next tick is old news.
  const next = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("status")] }), decision.memory, 4_000);
  assert.equal(next.say, undefined);
});

test("'status' naming this pilot is answered; naming another, or from a stranger, is not", () => {
  const ask = (line: string, from = HUMAN): readonly string[] | undefined =>
    decideCompanionAction(REQUEST, obs({ chatMessages: [chat(line, 1_000, from)] }), freshLadderMemory(), 2_000).say;
  assert.equal(ask("status pilot alpha")?.length, 1);
  assert.equal(ask(`status <url=showinfo:1377//${COMPANION}>x</url>`)?.length, 1);
  assert.equal(ask("status Pilot Beta"), undefined);
  assert.equal(ask("status", OTHER_COMPANION), undefined, "only a commander is heard");
});

// --- `repair` through the ladder --------------------------------------------------

test("'repair' in space flies to the station in this system and says so", () => {
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("repair")] }), freshLadderMemory(), 2_000);
  assert.deepEqual(decision.action, { kind: "dock", stationID: STATION });
  assert.equal(decision.phase, "Going to repair");
  assert.deepEqual(decision.say, ["Going to dock and repair, then coming back."]);
  assert.equal(decision.memory.flee?.ordered, true);
  assert.equal(decision.memory.fleeTripsSpent, 0, "an ordered trip spends no flee round trip");
});

test("with no station in the system the order is refused out loud, never flown to the sun", () => {
  const decision = decideCompanionAction(
    REQUEST, obs({ snapshot: grid(false), chatMessages: [chat("repair")] }), freshLadderMemory(), 2_000);
  assert.notEqual(decision.action.kind, "warp");
  assert.deepEqual(decision.say, ["Cannot repair: no station in this system."]);
  assert.equal(decision.memory.flee, null);
  assert.equal(decision.memory.repairOrderedAtMs, null);
});

test("docked on an order, the shop is paid even when the pilot is not set to pay, then it comes back", () => {
  const unpaid: FleetCompanionRequest = { ...REQUEST, repairsAtStation: false };
  const ordered = decideCompanionAction(unpaid, obs({ chatMessages: [chat("repair")] }), freshLadderMemory(), 2_000);
  const docked = (damaged: readonly number[] | null) =>
    obs({ docked: true, inSpace: false, snapshot: null, damagedItemIDs: damaged, chatMessages: [chat("repair")] });
  const repairing = decideCompanionAction(unpaid, docked([900001]), ordered.memory, 4_000);
  assert.deepEqual(repairing.action, { kind: "repairItems", itemIDs: [900001] });
  const back = decideCompanionAction(unpaid, docked([]), repairing.memory, 6_000);
  assert.deepEqual(back.action, { kind: "undock" });
  assert.deepEqual(back.say, ["Repaired. Coming back."]);
  assert.equal(back.memory.flee, null);
});

test("'repair' while docked repairs in place", () => {
  const decision = decideCompanionAction(REQUEST, obs({
    docked: true, inSpace: false, snapshot: null, damagedItemIDs: [900001], chatMessages: [chat("repair")],
  }), freshLadderMemory(), 2_000);
  assert.deepEqual(decision.action, { kind: "repairItems", itemIDs: [900001] });
  assert.deepEqual(decision.say, ["Repairing here, then coming back."]);
});

test("'repair' to a pilot waiting out a flee at the sun sends it to the station, paid", () => {
  const atTheSun: CompanionLadderMemory = {
    ...freshLadderMemory(),
    fleeTripsSpent: 1,
    flee: {
      triggeredAtMs: 0, triggeredAtHealth: 0.2, fromSolarSystemID: SYSTEM, repairAttempts: 0,
      onlyTheShieldWasHurt: false, arrivedSafe: true, safeSpotWarpIssued: true, safeSpotWarpSeen: true,
      safeSpotWarpAttempts: 1, safeSpotWarpWaited: 0, droneRecallWaited: null,
    },
  };
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("repair")] }), atTheSun, 2_000);
  assert.deepEqual(decision.action, { kind: "dock", stationID: STATION });
  assert.equal(decision.memory.flee?.repairPaid, true);
  assert.equal(decision.memory.flee?.ordered, undefined, "still the health flee: stop does not cancel it");
  assert.deepEqual(decision.say, ["Already leaving the fight. Will pay for the repair once docked."]);
});

test("'stop' calls off an ordered repair trip", () => {
  const ordered = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("repair")] }), freshLadderMemory(), 2_000);
  const stopped = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("repair"), chat("stop", 3_000)] }), ordered.memory, 4_000);
  assert.equal(stopped.memory.flee, null);
  assert.notEqual(stopped.action.kind, "dock");
});

test("'repair' naming another pilot leaves this one where it is", () => {
  const decision = decideCompanionAction(REQUEST, obs({ chatMessages: [chat("repair Pilot Beta")] }), freshLadderMemory(), 2_000);
  assert.equal(decision.memory.flee, null);
  assert.equal(decision.say, undefined);
});

// --- the controller says it -------------------------------------------------------

test("the controller sends the tick's lines to local chat, in order, beside the action", async () => {
  const said: string[] = [];
  const issued: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ chatMessages: [chat("status"), chat("repair", 1_001)] }),
    issue: async (action) => { issued.push(action); },
    sleep: async () => {},
    now: () => 2_000,
    say: async (text) => { said.push(text); },
  });
  controller.start(REQUEST);
  await controller.tick();
  await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  assert.deepEqual(issued, [{ kind: "dock", stationID: STATION }]);
  assert.deepEqual(said, [
    "Going to dock and repair, then coming back.",
    "Ammo: 5 reloads left, 80 loaded, 400 Antimatter Charge S in cargo. Drones: 5 in bay, 0 out.",
  ]);
});

test("a chat line that fails to send costs the run nothing", async () => {
  const issued: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ chatMessages: [chat("repair")] }),
    issue: async (action) => { issued.push(action); },
    sleep: async () => {},
    now: () => 2_000,
    say: async () => { throw new Error("chat refused"); },
  });
  controller.start(REQUEST);
  await controller.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().status, "running");
  assert.deepEqual(issued, [{ kind: "dock", stationID: STATION }]);
  controller.stop();
});
