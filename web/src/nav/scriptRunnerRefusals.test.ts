// Refusals through the REAL runner and the REAL macros.
//
// ⚠ WHY THIS FILE EXISTS. The runner commits a block's memory and board patch
// only when its world-call action SUCCEEDS (2fd4a77), so a block that sets an
// "I issued that" flag on the issuing tick and reads it back on the next one to
// react to a refusal never gets there: after a refusal its memory is unchanged.
// scriptMacros.test.ts drives macros one tick at a time and hands each tick the
// previous tick's nextMem, which is exactly what the runner does NOT do for a
// refused action — so those tests passed while two blocks were unreachable live.
// Everything here goes through `createScriptRunner` with `issue` throwing.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, InterruptRow, MacroStep, ProgramNode } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type { HomeTravelDecider, MacroDecider, ScriptAction } from "./scriptDecide.ts";
import { SCRIPT_MACROS, scriptTravelHome } from "./scriptMacros.ts";
import { createScriptRunner } from "./scriptRunner.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };
const AU = 149_597_870_700;

function calm(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null,
      shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null },
    lockedTargetIDs: [], holds: null, droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  } as ScriptObservation;
}

function rock(itemID: number, x: number): SpaceEntity {
  return {
    itemID, kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: "Veldspar", ownerID: null,
    radius: 10, position: { x, y: 0, z: 0 }, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: 1230, beltID: 40001, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
  } as SpaceEntity;
}

function space(entities: SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities,
    ship: {
      itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
      position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
      shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
      overloadedModuleIDs: null, moduleDamage: null, weaponBanks: null,
    },
  };
}

const home: HomeTravelDecider = () => ({
  action: { kind: "wait" }, why: "home", phase: "Heading home", armed: true, outcome: { kind: "acting" }, nextMem: {},
});

function script(program: readonly ProgramNode[], watches: readonly InterruptRow[] = []): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }, ...watches],
    program,
  };
}

const REFUSED_WARP = "CALL_REFUSED: You cannot warp there right now.";
const REFUSED_LOCK = "CALL_REFUSED: TargetNotWithinRangeGeneric";

/** The runner, the real macros, and an `issue` that throws whatever `refuse` says. */
function rig(
  program: readonly ProgramNode[],
  observation: () => ScriptObservation,
  refuse: (action: ScriptAction) => string | null,
  registry: Record<string, MacroDecider> = SCRIPT_MACROS as unknown as Record<string, MacroDecider>,
  watches: readonly InterruptRow[] = [],
  travelHome: HomeTravelDecider = home,
) {
  const issued: ScriptAction[] = [];
  /** Every status line the run showed, in order: how a test sees which rung a block reached. */
  const said: string[] = [];
  const runner = createScriptRunner({
    observe: async () => observation(),
    issue: async (action) => {
      issued.push(action);
      const words = refuse(action);
      if (words !== null) {
        throw new Error(words);
      }
      return null;
    },
    sleep: async () => {},
    onProgress: (snapshot) => {
      if (snapshot.why !== null) said.push(snapshot.why);
    },
    isSessionLost: () => false,
    refusalReason: (error) => (error instanceof Error ? error.message : String(error)),
    registry: registry as never,
    travelHome,
  });
  runner.start(script(program, watches));
  const run = async (ticks: number, until: () => boolean = () => false): Promise<void> => {
    for (let i = 0; i < ticks && runner.getStatus() === "running" && !until(); i += 1) {
      await runner.tick();
    }
  };
  return { runner, issued, said, run };
}

const oreSite = (label: string, x: number) => ({ label, kind: "ore" as const, position: { x, y: 0, z: 0 } });
const warpStep: MacroStep = { id: "w", kind: "macro", macro: "warp-to-ore-anomaly", args: {} };
const marker: MacroStep = { id: "u", kind: "macro", macro: "undock", args: {} };
const mineStep: MacroStep = {
  id: "m", kind: "macro", macro: "mine-at-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
  until: { kind: "ore-hold-at-least", fraction: 0.9 },
};

/** `undock` stands in for "the block after the warp": reaching it proves the warp step finished. */
function withMarker() {
  const state = { reached: false };
  const registry = {
    ...(SCRIPT_MACROS as unknown as Record<string, MacroDecider>),
    undock: ((_step, _obs) => {
      state.reached = true;
      return { action: { kind: "wait" }, why: "reached", phase: "Reached", armed: true, outcome: { kind: "done" }, nextMem: {} };
    }) as MacroDecider,
  };
  return { state, registry };
}

const warpScans = (issued: readonly ScriptAction[]) =>
  issued.filter((a): a is Extract<ScriptAction, { kind: "warpScan" }> => a.kind === "warpScan");

test("warp-to-ore-anomaly: a refused warp from INSIDE the site is one press, then the step is done", async () => {
  const { state, registry } = withMarker();
  const world = calm({
    snapshot: space([]),
    anomalies: [oreSite("ORE-111", 100_000)], // 100 km: under the server's own 150 km warp floor
    completedWarps: 3,
  });
  const { issued, run, runner } = rig(
    [warpStep, marker],
    () => world,
    (action) => (action.kind === "warpScan" ? REFUSED_WARP : null),
    registry,
  );
  await run(60, () => state.reached);
  assert.equal(warpScans(issued).length, 1, "pressed once, not until the ten-refusal cap");
  assert.equal(state.reached, true, "the step finished and the program moved on");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

test("warp-to-ore-anomaly: a refused site is set aside and the OTHER site gets the next warp", async () => {
  const world = calm({
    snapshot: space([]),
    anomalies: [oreSite("GUN-001", 4 * AU), oreSite("GUV-002", 6 * AU)],
    completedWarps: 3,
  });
  const { issued, run } = rig(
    [warpStep],
    () => world,
    (action) => (action.kind === "warpScan" && action.target === "GUN-001" ? REFUSED_WARP : null),
  );
  await run(60, () => warpScans(issued).length >= 2);
  assert.deepEqual(
    warpScans(issued).map((a) => a.target),
    ["GUN-001", "GUV-002"],
    "the refused label is not asked for again",
  );
});

test("mine-at-belt: a lock refused for range is NOT re-pressed at an unchanged distance, and is once the rock is 20% closer", async () => {
  let x = 60_000;
  const { issued, run, runner } = rig(
    [mineStep],
    () => calm({ snapshot: space([rock(50001, x)]), miningModuleIDs: [700], maxTargetRangeM: null }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  const locks = () => issued.filter((a) => a.kind === "lock").length;
  await run(40);
  assert.equal(locks(), 1, "one refused lock, then the block holds instead of spending the refusal cap");
  assert.equal(runner.getStatus(), "running", "and the ship is not sent home");

  x = 47_000; // under 0.8 x the refused distance
  await run(40, () => locks() >= 2);
  assert.equal(locks(), 2, "real progress buys a second press");
});

test("mine-at-belt: with a known lock range nothing is pressed beyond it, and one lock goes out once inside", async () => {
  let x = 60_000;
  const { issued, run, runner } = rig(
    [mineStep],
    () => calm({ snapshot: space([rock(50001, x)]), miningModuleIDs: [700], maxTargetRangeM: 40_000 }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  const locks = () => issued.filter((a) => a.kind === "lock").length;
  await run(40);
  assert.equal(locks(), 0, "beyond the lock range the block closes in and presses nothing");
  assert.equal(runner.getStatus(), "running");

  x = 39_000;
  await run(40, () => locks() >= 1);
  assert.equal(locks(), 1, "inside it, one lock");
});

// ── salvage-wrecks / fight-the-rats: the lock press ──────────────────────────
//
// Both blocks wrote `lockIssued` on the pressing tick and gave up on a target
// from the timed wait that flag opens. A refused press never set it, so the
// press was repeated on every backoff and "would not lock" was never said.

/** Anything on the grid that is not a rock, built from the rock. */
function thing(itemID: number, x: number, over: Partial<SpaceEntity>): SpaceEntity {
  return { ...rock(itemID, x), name: null, miningYieldTypeID: null, beltID: null, ...over };
}
const wreck = (itemID: number, x: number) => thing(itemID, x, { kind: "wreck" });
const rat = (itemID: number, x: number) => thing(itemID, x, { kind: "ship", isNpc: true, npcEntityType: "npc" });

const salvageStep: MacroStep = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} };
const fightStep: MacroStep = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} };
const WOULD_NOT_LOCK = /would not lock/;

const locksOn = (issued: readonly ScriptAction[], targetID: number) =>
  issued.filter((a) => a.kind === "lock" && a.targetID === targetID).length;

test("salvage-wrecks: with every lock refused each wreck is passed in turn and the block finishes", async () => {
  const { state, registry } = withMarker();
  const { issued, said, run, runner } = rig(
    [salvageStep, marker],
    () => calm({ snapshot: space([wreck(70001, 3000), wreck(70002, 4000)]), salvageModuleIDs: [800] }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
    registry,
  );
  await run(300, () => state.reached);
  assert.equal(state.reached, true, "both wrecks were passed and the program moved on");
  assert.notEqual(runner.snapshot().phase, "Heading home");
  assert.equal(said.filter((why) => WOULD_NOT_LOCK.test(why)).length, 2, "each wreck was given up on in words");
  // The visit's first refusal has no committed count to be compared with, so it
  // is believed on the second press; every later one is believed on the first.
  assert.equal(locksOn(issued, 70001), 2);
  assert.equal(locksOn(issued, 70002), 1);
});

test("salvage-wrecks: a wreck whose lock is refused is passed and the NEXT wreck is salvaged", async () => {
  const locked: number[] = [];
  const { issued, run, runner } = rig(
    [salvageStep],
    () =>
      calm({
        snapshot: space([wreck(70001, 3000), wreck(70002, 4000)]),
        salvageModuleIDs: [800],
        lockedTargetIDs: [...locked],
      }),
    (action) => {
      if (action.kind !== "lock") return null;
      if (action.targetID === 70001) return REFUSED_LOCK;
      locked.push(action.targetID);
      return null;
    },
  );
  const salvaging = () => issued.some((a) => a.kind === "activate" && a.targetID === 70002);
  await run(300, salvaging);
  assert.equal(salvaging(), true, "the salvager runs on the wreck that did lock");
  assert.ok(locksOn(issued, 70001) <= 2, "the refused wreck did not spend the refusal cap");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

test("fight-the-rats: a refused lock reaches 'would not lock' instead of the ten-refusal trip home", async () => {
  const { issued, said, run, runner } = rig(
    [fightStep],
    () => calm({ snapshot: space([rat(6661, 5000)]), weaponModuleIDs: [500] }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the block said so");
  assert.ok(locksOn(issued, 6661) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home", "and the ship is still in the fight");
});

test("fight-the-rats: after a lock that landed, a refused one is believed on the first press", async () => {
  let rats = [rat(6661, 5000)];
  const locked: number[] = [];
  const { issued, said, run } = rig(
    [fightStep],
    () => calm({ snapshot: space(rats), weaponModuleIDs: [500], lockedTargetIDs: [...locked] }),
    (action) => {
      if (action.kind !== "lock") return null;
      if (action.targetID === 6662) return REFUSED_LOCK;
      locked.push(action.targetID);
      return null;
    },
  );
  await run(20, () => issued.some((a) => a.kind === "activate" && a.targetID === 6661));
  assert.ok(issued.some((a) => a.kind === "activate" && a.targetID === 6661), "the first rat was locked and shot");

  rats = [rat(6662, 5000)]; // it died, and the next one refuses the lock
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.equal(locksOn(issued, 6662), 1);
});

test("fight-back watch: the borrowed ladder reads the refusal under the WATCH ROW's id", async () => {
  // The watch is where a working bot actually fights, and the ledger keys its
  // presses by the row id it hands the ladder as the step id.
  const fightBack: InterruptRow = { id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back" };
  const { issued, said, run, runner } = rig(
    [mineStep],
    () =>
      calm({
        snapshot: space([rock(50001, 3000), rat(6661, 5000)]),
        hostileOnGrid: true,
        miningModuleIDs: [700],
        weaponModuleIDs: [500],
      }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
    undefined,
    [fightBack],
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the watch said so");
  assert.ok(locksOn(issued, 6661) <= 2);
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

// ── fight-with-drones: the primary's lock and the pre-lock ───────────────────
//
// The drone boat's ladder is fight-the-rats' shape: the pick and the press are
// one tick, and the timed wait opens on a flag the press writes. Its pre-lock
// rung stops on "already asked for this one", which a refused press never wrote.

const droneStep: MacroStep = { id: "d", kind: "macro", macro: "fight-with-drones", args: {} };

test("fight-with-drones: a refused lock reaches 'would not lock' instead of the ten-refusal trip home", async () => {
  const { issued, said, run, runner } = rig(
    [droneStep],
    () => calm({ snapshot: space([rat(6661, 5000)]), hostileOnGrid: true, weaponModuleIDs: [500] }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the block said so");
  assert.ok(locksOn(issued, 6661) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home", "and the ship is still in the fight");
});

test("fight-with-drones: a refused PRE-lock is asked for once, not until the ten-refusal trip home", async () => {
  const locked: number[] = [];
  const { issued, run, runner } = rig(
    [droneStep],
    () =>
      calm({
        snapshot: space([rat(6661, 5000), rat(6662, 6000)]),
        hostileOnGrid: true,
        weaponModuleIDs: [500],
        lockedTargetIDs: [...locked],
        maxLockedTargets: 3,
      }),
    (action) => {
      if (action.kind !== "lock") return null;
      // Whichever the ladder makes its primary locks; the other one never does.
      if (locked.length > 0 && !locked.includes(action.targetID)) return REFUSED_LOCK;
      if (!locked.includes(action.targetID)) locked.push(action.targetID);
      return null;
    },
  );
  await run(150);
  assert.equal(locked.length, 1, "the primary locked");
  const spare = locked[0] === 6661 ? 6662 : 6661;
  assert.equal(locksOn(issued, spare), 1, "the pre-lock that was refused is not asked for again");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home", "and the ship is still in the fight");
});

// ── remote-rep / remote-cap: the fleet-mate's lock ───────────────────────────
//
// Both decided "this is a new mate, press the lock" by comparing the mate to an
// id the PRESS wrote. A refused press never wrote it, so every tick was a new
// mate and "would not lock" was never said.

/** A fleet-mate on grid. The character id is ESI's own published example. */
const MATE_CHARACTER = 90000001;
const mate = (itemID: number, x: number, over: Partial<SpaceEntity>) =>
  thing(itemID, x, { kind: "ship", isNpc: false, characterID: MATE_CHARACTER, shieldRatio: 1, armorRatio: 1, hullRatio: 1, ...over });

const repStep: MacroStep = { id: "r", kind: "macro", macro: "remote-rep", args: {} };
const capStep: MacroStep = { id: "c", kind: "macro", macro: "remote-cap", args: {} };

test("remote-rep: a refused lock reaches 'would not lock' instead of the ten-refusal trip home", async () => {
  const { issued, said, run, runner } = rig(
    [repStep],
    () =>
      calm({
        snapshot: space([mate(7001, 3000, { shieldRatio: 0.4 })]),
        fleetMemberCharacterIDs: [MATE_CHARACTER],
        remoteShieldRepairerIDs: [600],
      }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the block said so");
  assert.ok(locksOn(issued, 7001) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

test("remote-cap: a refused lock reaches 'would not lock' instead of the ten-refusal trip home", async () => {
  const { issued, said, run, runner } = rig(
    [capStep],
    () =>
      calm({
        snapshot: space([mate(7001, 3000, { capacitorRatio: 0.3 })]),
        fleetMemberCharacterIDs: [MATE_CHARACTER],
        remoteCapModuleIDs: [800],
      }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the block said so");
  assert.ok(locksOn(issued, 7001) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

// ── the fight out of a blocked trip home ────────────────────────────────────────
//
// The trip borrows fight-the-rats, and the runner books the trip's presses under
// the LATCH: the watch row that fired, or no step at all when the runner latched
// the trip itself. The borrowed ladder read the ledger under a made-up step id
// and so never saw its own refusals. Worse than a trip home here: a second fault
// under a latch is a stop, so the ship was left paused in space, still held.

/** A ship that cannot leave: the autopilot failed on the way to the home station. */
const held = (over: Partial<ScriptObservation> = {}) =>
  calm({
    snapshot: space([rat(6661, 5000)]),
    hostileOnGrid: true,
    weaponModuleIDs: [500],
    homeStationID: 1,
    travel: { status: "paused", destinationStationID: 1, remainingJumps: 0, failureReason: "You are warp scrambled." },
    ...over,
  });

test("fight free: under a WATCH's latch a refused lock reaches 'would not lock' instead of a stop in space", async () => {
  // Health under the floor watch every script here carries, so the watch latches the trip.
  const { issued, said, run, runner } = rig(
    [fightStep],
    () => held({ health: 0.2, shieldRatio: 0.2, armorRatio: 0.2, hullRatio: 0.2 }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
    undefined,
    [],
    scriptTravelHome,
  );
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.equal(runner.snapshot().phase, "Fighting free");
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the trip said so");
  assert.ok(locksOn(issued, 6661) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running", "and the ship is still fighting, not paused in space");
});

test("fight free: under the RUNNER's own latch, which names no step, the refusal is read too", async () => {
  const { issued, said, run, runner } = rig(
    [fightStep],
    () => held(),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
    undefined,
    [],
    scriptTravelHome,
  );
  assert.equal(runner.headHome("Sent home."), true);
  await run(200, () => said.some((why) => WOULD_NOT_LOCK.test(why)));
  assert.equal(runner.snapshot().phase, "Fighting free");
  assert.ok(said.some((why) => WOULD_NOT_LOCK.test(why)), "the timed wait ran out and the trip said so");
  assert.ok(locksOn(issued, 6661) <= 2, "pressed twice at most on the way there");
  assert.equal(runner.getStatus(), "running", "and the ship is still fighting, not paused in space");
});

test("fight-with-drones: a new primary does not inherit the disappeared spare's refused pre-lock", async () => {
  let replaced = false;
  const locked: number[] = [];
  const { issued, said, run } = rig(
    [droneStep],
    () => calm({
      snapshot: space(replaced ? [rat(6663, 5000)] : [rat(6661, 5000), rat(6662, 6000)]),
      hostileOnGrid: true, weaponModuleIDs: [500], lockedTargetIDs: [...locked], maxLockedTargets: 3,
    }),
    (action) => {
      if (action.kind !== "lock") return null;
      if (action.targetID === 6662) {
        replaced = true;
        locked.length = 0;
        said.length = 0;
        return REFUSED_LOCK;
      }
      locked.push(action.targetID);
      return null;
    },
  );
  await run(100, () => locksOn(issued, 6663) > 0);
  assert.equal(locksOn(issued, 6662), 1);
  assert.equal(locksOn(issued, 6663), 1);
  assert.equal(said.some((why) => /Waiting for the lock|would not lock/.test(why)), false,
    "the new primary receives a lock before any lock timeout can be attributed to it");
});

test("fight-with-drones: the next spare gets a pre-lock when the refused spare leaves", async () => {
  let replaced = false;
  const locked: number[] = [];
  const { issued, run } = rig(
    [droneStep],
    () => calm({
      snapshot: space([rat(6661, 5000), rat(replaced ? 6663 : 6662, 6000)]),
      hostileOnGrid: true, weaponModuleIDs: [500], lockedTargetIDs: [...locked], maxLockedTargets: 3,
    }),
    (action) => {
      if (action.kind !== "lock") return null;
      if (action.targetID === 6662) { replaced = true; return REFUSED_LOCK; }
      locked.push(action.targetID);
      return null;
    },
  );
  await run(100, () => locksOn(issued, 6663) > 0);
  assert.equal(locksOn(issued, 6662), 1);
  assert.equal(locksOn(issued, 6663), 1,
    "the replacement spare was never pressed and must not be booked as the refused one");
});

for (const step of [fightStep, droneStep]) {
  test(`${step.macro}: a new fleet primary gets its own lock after the previous primary refuses`, async () => {
    let called = 6661;
    const locked: number[] = [];
    const { issued, said, run, runner } = rig(
      [{ ...step, args: { squad: { kind: "squadRole", role: "follow" } } }],
      () => calm({
        snapshot: space([rat(6661, 5000), rat(6662, 6000), rat(6663, 7000)]),
        hostileOnGrid: true, weaponModuleIDs: [500], lockedTargetIDs: [...locked],
        squadPrimaryTargetID: called,
      }),
      (action) => {
        if (action.kind !== "lock") return null;
        if (action.targetID === 6662) {
          called = 6663;
          said.length = 0;
          return REFUSED_LOCK;
        }
        locked.push(action.targetID);
        return null;
      },
    );
    await run(30, () => locksOn(issued, 6661) > 0);
    assert.equal(locksOn(issued, 6661), 1);
    called = 6662;
    await run(100, () => locksOn(issued, 6663) > 0);
    assert.equal(locksOn(issued, 6662), 1);
    assert.equal(locksOn(issued, 6663), 1);
    assert.equal(said.some((why) => /Waiting for the lock|would not lock/.test(why)), false,
      "a changed fleet call cannot spend the rejected primary's lock wait");
    assert.equal(runner.getStatus(), "running");
  });
}

test("lock refusals still exhaust the run budget when every target changes", async () => {
  let targetID = 6661;
  const { issued, run, runner } = rig(
    [fightStep],
    () => calm({ snapshot: space([rat(targetID, 5000)]), weaponModuleIDs: [500] }),
    (action) => {
      if (action.kind !== "lock") return null;
      targetID += 1;
      return REFUSED_LOCK;
    },
  );
  await run(500, () => runner.snapshot().phase === "Heading home");
  const locks = issued.filter((action) => action.kind === "lock");
  assert.equal(locks.length, 10, "changing targets does not buy a new run refusal budget");
  assert.equal(new Set(locks.map((action) => action.targetID)).size, 10);
  assert.equal(runner.snapshot().phase, "Heading home");
  assert.match(runner.snapshot().why ?? "", /10 refusals in a row/);
  // The fault transition preserves the prior readout until the Home decision.
  await run(1);
  assert.equal(runner.snapshot().refusals[0]?.count, 10);
  assert.equal(runner.snapshot().refusals[0]?.targetID, targetID - 1);
});

for (const step of [repStep, capStep]) {
  test(`${step.macro}: a newly urgent mate does not inherit another mate's refused lock wait`, async () => {
    let refusedLocks = 0;
    let changedMate = false;
    const { issued, said, run, runner } = rig(
      [step],
      () => calm({
        snapshot: space([
          mate(7001, 3000, { shieldRatio: changedMate ? 1 : 0.4, capacitorRatio: changedMate ? 1 : 0.3 }),
          mate(7002, 3000, {
            characterID: MATE_CHARACTER + 1,
            shieldRatio: changedMate ? 0.4 : 1,
            capacitorRatio: changedMate ? 0.3 : 1,
          }),
        ]),
        fleetMemberCharacterIDs: [MATE_CHARACTER, MATE_CHARACTER + 1],
        remoteShieldRepairerIDs: [600],
        remoteCapModuleIDs: [800],
      }),
      (action) => {
        if (action.kind !== "lock" || action.targetID !== 7001) return null;
        refusedLocks += 1;
        if (refusedLocks === 2) {
          changedMate = true;
          // Earlier waits may correctly belong to 7001. From here, 7002 needs
          // assistance but has never had a lock requested.
          said.length = 0;
        }
        return REFUSED_LOCK;
      },
    );
    await run(200, () => locksOn(issued, 7002) > 0);
    assert.equal(refusedLocks, 2, "the priority changed after the old mate's refused lock");
    assert.equal(locksOn(issued, 7002), 1, "the newly urgent mate gets its own lock request");
    assert.equal(
      said.some((why) => /Waiting for the lock|would not lock/.test(why)),
      false,
      "the new mate is not left waiting on a lock that was never requested",
    );
    assert.equal(runner.getStatus(), "running");
  });
}

// ── collect-customs: a launchpad that will not send its goods up ─────────────
//
// The block keys a launchpad's refusals by the launchpad (scriptRunner's actionTargetID), so that one launchpad
// the server will not take from does not spend the next one's tries, nor the office's. Through the real runner,
// which is where a refusal's count comes from.
