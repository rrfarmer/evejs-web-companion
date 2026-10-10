import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  FLEET_COMPANION_BURST_MS,
  FLEET_COMPANION_CADENCE_MS,
  TANK_LAYER_HURT_THRESHOLD,
  createFleetCompanion,
  decideCompanionAction,
  freshLadderMemory,
  supervisorsInFleet,
  type CompanionCargoCharge,
  type CompanionDecision,
  type FleetCompanionAction,
  type CompanionFlee,
  type CompanionLadderMemory,
  type FleetCompanionDeps,
  type FleetCompanionObservation,
  type CompanionPropulsionModule,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import type { ChatMessage, SpaceSnapshot } from "../store/types.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";

/**
 * Two obviously-synthetic character ids: the human whose presence satisfies the
 * supervision gate, and the companion itself. `90000001` is the example CCP's
 * own ESI documentation publishes for a character id, which is why it is the
 * one to reach for — documented, unmistakably not a real pilot.
 */
const HUMAN = 90000001;
const COMPANION = 90000002;

/**
 * A complete, valid observation with named overrides — the same builder shape
 * `miningBotLoop.test.ts` uses, so a test never hand-rolls a partial object and
 * then asserts against a field it forgot to set.
 */
function obs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return {
    inSpace: true,
    inWarp: false,
    docked: false,
    fleetTargetTags: null,
    canTag: null,
    // SUPERVISED by default, and every test that does not say otherwise relies
    // on it: a human and this pilot in the fleet, only this pilot bot-driven.
    // The alternative default — an empty fleet — would silently put every
    // unrelated test into the abandonment protocol.
    inFleet: true,
    fleetMemberCharacterIDs: [HUMAN, COMPANION],
    // ⚠ THE CHAT GATE, AND IT MOVED FROM THE REQUEST TO THE ROSTER. A chat
    // order is obeyed only from a character the fleet roster names a
    // COMMANDER; the hand-typed `chatCommandSenders` list that used to decide
    // this is gone. HUMAN is the commander in every test here, so a command
    // from anyone else -- see UNLISTED_SENDER -- must do nothing.
    fleetCommanderCharacterIDs: [HUMAN],
    botDrivenCharacterIDs: [COMPANION],
    myCharacterID: COMPANION,
    pendingFleetInvite: null,
    ...overrides,
  } as FleetCompanionObservation;
}

/** An observation with nobody in the fleet this host is not flying. */
function alone(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({ fleetMemberCharacterIDs: [COMPANION], ...overrides });
}

const REQUEST = DEFAULT_FLEET_COMPANION_REQUEST;

/** A space snapshot carrying one station at a given surface distance. */
/**
 * The system's star, the safe-spot fallback when no station is on grid.
 *
 * ⚠ `kind: "sun"` IS THE SERVER'S OWN WORD. `buildStaticCelestialEntity` stamps
 * the kind straight off the celestial row and every star row carries "sun";
 * it is added to every scene unconditionally and is visible to every session
 * in the system. Checked against the server 2026-09-11, after a note in this
 * repo claiming there was no sun to warp to turned out to be wrong.
 */
const SUN = 40000001;

/** A grid with no station, but with the star every real system has. */
function gridWithSunOnly(): SpaceSnapshot {
  const grid = gridWithStation(null) as unknown as { entities: unknown[] };
  grid.entities.push({
    itemID: SUN,
    kind: "sun",
    isSelf: false,
    position: { x: 900_000_000, y: 0, z: 0 },
    radius: 63_350_000,
    mode: null,
  });
  return grid as unknown as SpaceSnapshot;
}

function gridWithStation(distanceM: number | null): SpaceSnapshot {
  const entities = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
  ];
  if (distanceM !== null) {
    entities.push({
      itemID: 60000001,
      kind: "station",
      isSelf: false,
      position: { x: distanceM, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

/**
 * A space snapshot carrying a self ship plus one entity per given itemID, at
 * INCREASING distance in the order given — the first id is nearest. Used by
 * the rung-3 ("obeying the fleet") tests, where distance must sometimes lose
 * to a better tag rank, and sometimes be the only thing distinguishing
 * otherwise-equal candidates.
 */
function gridWithEntities(itemIDs: readonly number[]): SpaceSnapshot {
  const entities = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
    ...itemIDs.map((itemID, index) => ({
      itemID,
      kind: "ship",
      isSelf: false,
      position: { x: (index + 1) * 10_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    })),
  ];
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

/** A minimal, already-fresh fleet broadcast — decideCompanionAction never re-checks the TTL. */
function fleetBroadcast(name: FleetBroadcast["name"], itemID: number | null): FleetBroadcast {
  return {
    name,
    scope: 3,
    senderCharID: HUMAN,
    senderSolarSystemID: null,
    itemID,
    typeID: null,
    receivedAtMs: 0,
  };
}

function makeDeps(
  overrides: Partial<FleetCompanionDeps> = {},
): { deps: FleetCompanionDeps; issued: unknown[] } {
  const issued: unknown[] = [];
  const deps: FleetCompanionDeps = {
    observe: async () => obs(),
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, issued };
}

// --- the ladder -------------------------------------------------------------

test("in warp, the companion decides nothing at all", () => {
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: true }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "In warp");
  assert.match(decision.why, /warping/i);
});

test("an UNREADABLE inWarp fails open — null is not 'in warp'", () => {
  // ⚠ The rule is `=== true`, never `!== false`. A ship that cannot be read is
  // not a ship known to be warping, and treating it as one would freeze the
  // companion whenever a read degraded.
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: null }));
  assert.notEqual(decision.phase, "In warp");
});

test("not in warp, phase 0 stands by rather than inventing behaviour", () => {
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: false }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Standing by");
});

// --- the request ------------------------------------------------------------

test("the default request is inside its own bounds", () => {
  const request = DEFAULT_FLEET_COMPANION_REQUEST;
  assert.ok(request.fleeHealthFloor >= 0.05 && request.fleeHealthFloor <= 0.95);
  assert.ok(request.capacitorFloor >= 0.05 && request.capacitorFloor <= 0.95);
  assert.ok(request.maxFleeAttempts >= 1);
  assert.ok(request.droneRedeployHoldOffSeconds >= 1);
});

test("the default request arms nothing, because nothing has been read off a hull yet", () => {
  // ⚠ NOT A SAFETY DEFAULT ANY MORE, JUST AN EMPTY ONE. It used to be both: an
  // unticked weapon list meant "lock the call, never fire it", so a companion
  // could only shoot if somebody armed it. Deriving the lists from the hull
  // ended that deliberately (docs/fleet-companion-simplification.md). What this
  // constant now means is "no fit has been read", which is what a test wants
  // when it varies one field, and what a start falls back to when the fit could
  // not be read at all.
  assert.deepEqual(DEFAULT_FLEET_COMPANION_REQUEST.weaponModuleIDs, []);
  assert.deepEqual(DEFAULT_FLEET_COMPANION_REQUEST.defenseModuleIDs, []);
  assert.deepEqual(DEFAULT_FLEET_COMPANION_REQUEST.remoteShieldModuleIDs, []);
});

// --- lifecycle --------------------------------------------------------------

test("a companion that was never started does not read the world", async () => {
  const { deps, issued } = makeDeps();
  let observed = 0;
  const controller = createFleetCompanion({
    ...deps,
    observe: async () => {
      observed += 1;
      return obs();
    },
  });
  await controller.tick();
  assert.equal(observed, 0, "an idle companion must not call observe");
  assert.equal(issued.length, 0);
  assert.equal(controller.snapshot().status, "idle");
});

test("start / pause / resume / stop move through the states", () => {
  const { deps } = makeDeps();
  const controller = createFleetCompanion(deps);

  assert.equal(controller.snapshot().status, "idle");
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(controller.snapshot().status, "running");

  controller.pause();
  assert.equal(controller.snapshot().status, "paused");
  controller.resume();
  assert.equal(controller.snapshot().status, "running");
  controller.stop();
  assert.equal(controller.snapshot().status, "stopped");
});

test("a paused companion stops reading the world", async () => {
  let observed = 0;
  const controller = createFleetCompanion({
    observe: async () => {
      observed += 1;
      return obs();
    },
    issue: async () => {},
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.tick();
  assert.equal(observed, 1);
  controller.pause();
  await controller.tick();
  assert.equal(observed, 1, "a paused tick must not read");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((release, refuse) => { resolve = release; reject = refuse; });
  return { promise, resolve, reject };
}

test("pause and resume retire a companion driver still asleep", async () => {
  const firstSleep = deferred<void>();
  const secondSleep = deferred<void>();
  const secondRead = deferred<void>();
  let reads = 0;
  let sleeps = 0;
  const controller = createFleetCompanion({
    observe: async () => {
      reads += 1;
      if (reads === 2) secondRead.resolve();
      return obs();
    },
    issue: async () => {},
    sleep: async () => {
      sleeps += 1;
      await (sleeps === 1 ? firstSleep.promise : secondSleep.promise);
    },
  });
  controller.start(REQUEST);
  const retired = controller.run();
  // Await the first tick before resuming, while its cadence sleep is pending.
  while (sleeps === 0) await Promise.resolve();
  controller.pause();
  controller.resume();
  const current = controller.run();
  await secondRead.promise;
  firstSleep.resolve();
  await retired;
  assert.equal(reads, 2, "the retired timer must not drive another observation");
  controller.stop();
  secondSleep.resolve();
  await current;
});

test("resume waits for a retired observation and issues only from the new driver", async () => {
  const firstRead = deferred<FleetCompanionObservation>();
  const secondSleep = deferred<void>();
  const issued = deferred<void>();
  let reads = 0;
  const actions: FleetCompanionAction[] = [];
  const observed = obs({
    snapshot: gridWithEntities([TACKLE]),
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [],
  });
  const controller = createFleetCompanion({
    observe: async () => ++reads === 1 ? firstRead.promise : observed,
    issue: async (action) => { actions.push(action); issued.resolve(); },
    sleep: async () => secondSleep.promise,
  });
  controller.start(REQUEST);
  const retired = controller.run();
  controller.pause();
  controller.resume();
  const current = controller.run();
  await Promise.resolve();
  assert.equal(reads, 1, "the replacement must wait for the pending tick to settle");
  firstRead.resolve(observed);
  await issued.promise;
  await retired;
  assert.equal(reads, 2);
  assert.deepEqual(actions, [{ kind: "lock", targetID: TACKLE }]);
  controller.stop();
  secondSleep.resolve();
  await current;
});

test("calling run twice in the same generation shares one driver", async () => {
  const sleeping = deferred<void>();
  const enteredSleep = deferred<void>();
  let reads = 0;
  const controller = createFleetCompanion({
    observe: async () => { reads += 1; return obs(); },
    issue: async () => {},
    sleep: async () => { enteredSleep.resolve(); await sleeping.promise; },
  });
  controller.start(REQUEST);
  const first = controller.run();
  const second = controller.run();
  assert.equal(first, second);
  await enteredSleep.promise;
  assert.equal(reads, 1);
  controller.stop();
  sleeping.resolve();
  await Promise.all([first, second]);
});

test("a read that throws pauses with the reason rather than acting on stale state", async () => {
  const controller = createFleetCompanion({
    observe: async () => {
      throw new Error("space read failed");
    },
    issue: async () => {},
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  const action = await controller.tick();
  assert.equal(action.kind, "wait");
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().failureReason, "space read failed");
});

test("a retired observation failure cannot stop a replacement companion run", async () => {
  const oldRead = deferred<FleetCompanionObservation>();
  let reports = 0;
  const controller = createFleetCompanion({
    observe: async () => oldRead.promise,
    issue: async () => {},
    sleep: async () => {},
    onProgress: () => { reports += 1; },
  });
  controller.start(REQUEST);
  const oldTick = controller.tick();
  controller.stop();
  controller.start(REQUEST);
  const replacement = controller.snapshot();
  const replacementReports = reports;
  oldRead.reject(new Error("retired session read failed"));
  assert.deepEqual(await oldTick, { kind: "wait" });
  assert.deepEqual(controller.snapshot(), replacement);
  assert.equal(reports, replacementReports, "the old failure must publish no replacement progress");
});

test("an observation failure after pausing cannot change the paused run", async () => {
  const oldRead = deferred<FleetCompanionObservation>();
  const controller = createFleetCompanion({
    observe: async () => oldRead.promise,
    issue: async () => {},
    sleep: async () => {},
  });
  controller.start(REQUEST);
  const oldTick = controller.tick();
  controller.pause();
  const paused = controller.snapshot();
  oldRead.reject(new Error("read failed after pause"));
  await oldTick;
  assert.deepEqual(controller.snapshot(), paused);
});

// --- a refused call ---------------------------------------------------------
//
// ⚠ THE BUG THESE PIN, REPORTED LIVE 2026-09-11. A refusal came out of `issue`,
// out of `tick`, out of `run`, and landed on the `void run()` in flow.ts as an
// unhandled promise rejection: "TargetNotWithinRangeGeneric", twice, and the
// page stopped updating. The loop was dead and `status` still said "running".

test("a refused CALL keeps the run alive - the world is unchanged and the next tick re-reads it", async () => {
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () =>
      obs({
        snapshot: gridWithEntities([TACKLE]),
        fleetTargetTags: new Map([[TACKLE, "A"]]),
        lockedTargetIDs: [],
      }),
    issue: async (action) => {
      attempted.push(action);
      throw new Error("TargetNotWithinRangeGeneric");
    },
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);

  const first = await controller.tick();
  assert.equal(
    controller.snapshot().status,
    "running",
    "a refused WRITE leaves the world exactly as it was; only a failed READ may stop the pilot",
  );
  // ⚠ THE TICK REPORTS `wait`, AND THAT IS THE HONEST ANSWER: the call it chose
  // did not happen. What it must NOT do is stop choosing.
  assert.equal(first.kind, "wait");

  await controller.tick();
  assert.deepEqual(
    attempted.map((action) => action.kind),
    ["lock", "lock"],
    "the lock is re-issued, because the ship may have drifted into range since",
  );
});

test("an explicitly refused escape warp retries after tackle clears", async () => {
  let tackled = true;
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithSunOnly(), shieldRatio: 0.1,
      armorRatio: 1, hullRatio: 1, scrammed: tackled }),
    issue: async (action) => { attempted.push(action);
      if (tackled) throw Object.assign(new Error("WarpDisrupted"), { code: "CALL_REFUSED" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, tankLayer: "shield" });
  await controller.tick();
  tackled = false;
  await controller.tick();
  assert.deepEqual(attempted, [{ kind: "warp", targetID: SUN }, { kind: "warp", targetID: SUN }]);
  assert.equal(controller.snapshot().status, "running");
});

test("repeated definite escape refusals pause after a bounded number of attempts", async () => {
  let attempts = 0;
  const controller = createFleetCompanion({
    observe: async () => alone({ snapshot: gridWithSunOnly() }),
    issue: async () => { attempts += 1; throw Object.assign(new Error("WarpDisrupted"), { code: "CALL_REFUSED" }); },
    sleep: async () => {},
  });
  controller.start(REQUEST);
  for (let tick = 0; tick < 8; tick += 1) await controller.tick();
  assert.equal(attempts, 3);
  assert.equal(controller.snapshot().status, "paused");
  assert.match(controller.snapshot().why ?? "", /operator.*take over/i);
});

test("an escape warp with a lost response is reconciled without retrying or leaving fleet early", async () => {
  let inWarp = false;
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () => alone({ snapshot: gridWithSunOnly(), inWarp }),
    issue: async (action) => { attempted.push(action);
      if (action.kind === "warp") throw Object.assign(new Error("response lost"), { code: "BRIDGE_NETWORK_ERROR" }); },
    sleep: async () => {},
  });
  controller.start(REQUEST);
  await controller.tick();
  await controller.tick();
  assert.deepEqual(attempted, [{ kind: "warp", targetID: SUN }]);
  inWarp = true;
  await controller.tick();
  inWarp = false;
  await controller.tick();
  assert.deepEqual(attempted, [{ kind: "warp", targetID: SUN }, { kind: "leaveFleet" }]);
});

test("an escape warp that never becomes observable pauses instead of polling forever", async () => {
  let attempts = 0;
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithSunOnly(), shieldRatio: 0.1,
      armorRatio: 1, hullRatio: 1 }),
    issue: async () => { attempts += 1; throw Object.assign(new Error("response lost"), { code: "BRIDGE_BAD_RESPONSE" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, tankLayer: "shield" });
  for (let tick = 0; tick < 70; tick += 1) await controller.tick();
  assert.equal(attempts, 1);
  assert.equal(controller.snapshot().status, "paused");
  assert.match(controller.snapshot().why ?? "", /outcome could not be confirmed/i);
});

test("a refusal is SAID, in plain words, and never in the server's own vocabulary", async () => {
  const controller = createFleetCompanion({
    observe: async () =>
      obs({
        snapshot: gridWithEntities([TACKLE]),
        fleetTargetTags: new Map([[TACKLE, "A"]]),
        lockedTargetIDs: [],
      }),
    issue: async () => {
      throw new Error("TargetNotWithinRangeGeneric");
    },
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.tick();

  const readout = controller.snapshot();
  assert.match(readout.why ?? "", /out of reach/i, "it must say what happened");
  assert.doesNotMatch(
    readout.why ?? "",
    /TargetNotWithinRangeGeneric/,
    "the server's error-class name is raw vocabulary and must never reach a player",
  );
  // ...but it is kept where a diagnosis can find it.
  assert.equal(readout.failureReason, "TargetNotWithinRangeGeneric");
});

/** A controller whose every call is refused, watching a target the fleet called. */
function refusingController() {
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () =>
      obs({
        snapshot: gridWithEntities([TACKLE]),
        fleetTargetTags: new Map([[TACKLE, "A"]]),
        lockedTargetIDs: [],
      }),
    issue: async (action) => {
      attempted.push(action);
      throw new Error("TargetNotWithinRangeGeneric");
    },
    sleep: async () => {},
  });
  return { controller, attempted };
}

test("a target that will not lock is given up on after a few tries", async () => {
  // ⚠ WHY GIVING UP IS THE RIGHT ANSWER AND RETRYING FOR EVER IS NOT. The lock
  // is re-issued every tick by design -- the authoritative lock list is
  // consulted rather than believed -- which is right for a lock that will land
  // once the ship drifts closer, and wrong for one that never will: rung 7
  // returns a real decision every tick, so every rung BENEATH it is starved for
  // as long as the fleet keeps calling that ship.
  const { controller, attempted } = refusingController();
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);

  for (let tick = 0; tick < 6; tick += 1) {
    await controller.tick();
  }

  assert.equal(attempted.length, 3, "three goes at it, then it stops asking");
  assert.ok(
    attempted.every((action) => action.kind === "lock"),
    "and every one of them was the lock",
  );
});

test("...and it SAYS so, rather than going quiet", async () => {
  const { controller } = refusingController();
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  for (let tick = 0; tick < 4; tick += 1) {
    await controller.tick();
  }

  const readout = controller.snapshot();
  assert.equal(readout.phase, "Obeying fleet", "it is still answering the fleet's call");
  assert.match(readout.why ?? "", /stopped trying/i);
  assert.equal(
    readout.followingOrderFrom,
    "tag",
    "the call it cannot answer is still named, so the panel does not just go blank",
  );
});

test("a WARP clears every give-up - what is out of reach is a fact about where it stands", async () => {
  const { controller, attempted } = refusingController();
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  for (let tick = 0; tick < 4; tick += 1) {
    await controller.tick();
  }
  assert.equal(attempted.length, 3, "given up, as above");

  // The fleet then warps this pilot somewhere else, and the mid-warp tick is
  // what forgets: it is the one tick that knows the ship has moved.
  const midWarp = decideCompanionAction(
    DEFAULT_FLEET_COMPANION_REQUEST,
    obs({ inWarp: true, snapshot: gridWithEntities([TACKLE]) }),
    { ...freshLadderMemory(), lockGaveUpOn: [TACKLE], lockRefusedFor: TACKLE, lockRefusals: 2 },
  );
  assert.deepEqual(midWarp.memory.lockGaveUpOn, [], "a new grid is a clean slate");
  assert.equal(midWarp.memory.lockRefusedFor, null);
  assert.equal(midWarp.memory.lockRefusals, 0);
});

test("three refusals spread across DIFFERENT ships give up on none of them", async () => {
  // ⚠ THE BUDGET IS "THREE GOES AT THIS SHIP", NOT "THREE REFUSALS EVER". A
  // fleet calling three ships in a row has exhausted nothing, and a counter that
  // did not reset per target would retire the third one on its first try.
  let called = TACKLE;
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () =>
      obs({
        snapshot: gridWithEntities([TACKLE, OTHER]),
        fleetTargetTags: new Map([[called, "A"]]),
        lockedTargetIDs: [],
      }),
    issue: async (action) => {
      attempted.push(action);
      throw new Error("TargetNotWithinRangeGeneric");
    },
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);

  await controller.tick();
  called = OTHER;
  await controller.tick();
  called = TACKLE;
  await controller.tick();
  await controller.tick();

  assert.equal(attempted.length, 4, "every one of those was still worth a try");
});

test("run() cannot reject, whatever the ladder does", async () => {
  // ⚠ EVERY CALL SITE STARTS THIS WITH `void`, so a rejection here is an
  // unhandled promise rejection in the page. `observe` throwing is already
  // caught by `tick`; this drives the one thing that is not -- a `sleep` that
  // throws stands in for any defect inside the loop itself -- and pins that it
  // surfaces in the readout instead of in the console.
  const controller = createFleetCompanion({
    observe: async () => obs(),
    issue: async () => {},
    sleep: async () => {
      throw new Error("the timer exploded");
    },
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.run();
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().failureReason, "the timer exploded");
});

test("a tick from a STOPPED run cannot land after a restart", async () => {
  // ⚠ The stale-run guard. `observe` is held open across a stop+start, so the
  // tick that resumes belongs to a run the player already ended.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const issued: unknown[] = [];
  let first = true;
  const controller = createFleetCompanion({
    observe: async () => {
      if (first) {
        first = false;
        await gate;
      }
      return obs();
    },
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
  });

  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  const inFlight = controller.tick();
  controller.stop();
  release();
  const action = await inFlight;

  assert.equal(action.kind, "wait");
  assert.equal(issued.length, 0, "a stopped run must not issue");
  assert.equal(controller.snapshot().status, "stopped");
});

test("run() drives ticks and ends when the companion is stopped", async () => {
  // ⚠ STOP FROM INSIDE THE READ, not from a timer. `sleep` is faked to resolve
  // immediately, so the loop never yields to the timer phase — a
  // `setTimeout`-driven stop would never fire and this test would hang forever
  // rather than fail. Anything driving `run()` with an instant `sleep` has to
  // end the run from within the loop's own await chain.
  let ticks = 0;
  let controller: ReturnType<typeof createFleetCompanion>;
  const deps = {
    observe: async () => {
      ticks += 1;
      if (ticks >= 3) {
        controller.stop();
      }
      return obs();
    },
    issue: async () => {},
    sleep: async () => {},
  };
  controller = createFleetCompanion(deps);
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.run();
  assert.equal(ticks, 3, "run() must stop driving the moment the run ends");
  assert.equal(controller.snapshot().status, "stopped");
});

test("phase 0 issues NOTHING — the skeleton is reviewable before behaviour lands", async () => {
  const issued: unknown[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ inWarp: false, inSpace: true }),
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.tick();
  await controller.tick();
  assert.deepEqual(issued, []);
});

// --- phase 0b: the supervision gate (decision 5) -----------------------------
//
// The rule the operator stated is that a companion does no unsupervised work,
// CONTINUOUSLY and not merely at launch. These pin the check itself; the block
// below pins what happens when it fails.

test("supervisorsInFleet subtracts the bots this host flies, and this pilot", () => {
  assert.deepEqual(
    supervisorsInFleet(
      obs({
        fleetMemberCharacterIDs: [HUMAN, COMPANION, 90000003],
        botDrivenCharacterIDs: [COMPANION, 90000003],
      }),
    ),
    [HUMAN],
  );
});

test("supervisorsInFleet subtracts THIS pilot even if the host forgot to list it", () => {
  // Belt and braces: a companion must never read as its own supervisor, and a
  // host with a stale claim map must not be able to make it one.
  assert.deepEqual(
    supervisorsInFleet(obs({ fleetMemberCharacterIDs: [COMPANION], botDrivenCharacterIDs: [] })),
    [],
  );
});

test("supervisorsInFleet is null — not empty — when either read failed", () => {
  // ⚠ The distinction is the whole gate. `[]` means "looked, nobody there" and
  // starts the abandonment protocol; `null` means "could not look" and must not.
  assert.equal(supervisorsInFleet(obs({ fleetMemberCharacterIDs: null })), null);
  assert.equal(supervisorsInFleet(obs({ botDrivenCharacterIDs: null })), null);
});

test("COUNTING the fleet would pass where subtracting fails — four companions, no human", () => {
  // The failure decision 5 names: four companions plus an operator is still
  // four members the moment the operator logs off, so a size test sees a
  // healthy fleet. Subtraction sees the truth.
  const fleetOfBots = obs({
    fleetMemberCharacterIDs: [COMPANION, 90000003, 90000004, 90000005],
    botDrivenCharacterIDs: [COMPANION, 90000003, 90000004, 90000005],
  });
  assert.equal(fleetOfBots.fleetMemberCharacterIDs?.length, 4);
  assert.deepEqual(supervisorsInFleet(fleetOfBots), []);
  assert.equal(decideCompanionAction(REQUEST, fleetOfBots).phase, "Getting safe");
});

test("an UNREADABLE roster fails open: no abandonment is started", () => {
  // A transient roster failure must not dock a live fleet operation and disband
  // it. What bounds a read that stays broken is the run's own deadline.
  const decision = decideCompanionAction(REQUEST, obs({ fleetMemberCharacterIDs: null }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Checking supervision");
  assert.equal(decision.memory.abandonment, null);
});

test("an unreadable roster does not CLEAR an abandonment already under way", () => {
  // The other half of failing open: not being able to see the fleet is not
  // evidence that a human came back.
  const started = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }));
  assert.notEqual(started.memory.abandonment, null);
  const blind = decideCompanionAction(
    REQUEST,
    obs({ fleetMemberCharacterIDs: null }),
    started.memory,
  );
  assert.equal(blind.memory.abandonment?.abandonedAtMs, started.memory.abandonment?.abandonedAtMs);
});

test("the supervision gate sits ABOVE the ladder but BELOW the warp yield", () => {
  // Rung 1 is not an order source; it is the tick on which nothing can be
  // issued at all. So a fleet-warping ship decides nothing even when abandoned.
  const decision = decideCompanionAction(REQUEST, alone({ inWarp: true }));
  assert.equal(decision.phase, "In warp");
  assert.equal(decision.memory.abandonment, null);
});

test("supervision returning CLEARS the abandonment and remembers who is here", () => {
  const abandoned = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }));
  assert.notEqual(abandoned.memory.abandonment, null);
  const back = decideCompanionAction(REQUEST, obs(), abandoned.memory);
  assert.equal(back.memory.abandonment, null);
  assert.equal(back.phase, "Standing by");
  assert.deepEqual(back.memory.lastSupervisorIDs, [HUMAN]);
});

// --- phase 0b: the abandonment protocol --------------------------------------
//
// Get safe, THEN disband, then wait a bounded thirty minutes, and take a way
// back only from someone who was actually here.

test("a station beyond the warp floor is warped to", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(200_000) }));
  assert.deepEqual(decision.action, { kind: "warp", targetID: 60000001 });
  assert.equal(decision.phase, "Getting safe");
});

test("a station too close for the server to warp to is approached", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(50_000) }));
  assert.deepEqual(decision.action, { kind: "approach", targetID: 60000001 });
  // The approach is remembered, so the next tick reads "closing" rather than
  // restarting the approach every two seconds.
  assert.equal(decision.memory.closingOn, 60000001);
});

test("a station inside the docking radius is docked at", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(1_000) }));
  assert.deepEqual(decision.action, { kind: "dock", stationID: 60000001 });
});

test("SAFE FIRST, THEN LEAVE — a companion still in space does not drop fleet", () => {
  // ⚠ The order is load-bearing. Leaving first gives up the fleet-warp channel
  // while the ship is still sitting in space.
  const decision = decideCompanionAction(
    REQUEST,
    alone({ inFleet: true, docked: false, snapshot: gridWithStation(200_000) }),
  );
  assert.notEqual(decision.action.kind, "leaveFleet");
  assert.equal(decision.action.kind, "warp");
});

test("docked and still in the fleet, it leaves — one pilot, for itself", () => {
  const decision = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: true }));
  assert.deepEqual(decision.action, { kind: "leaveFleet" });
});

test("docked and out of the fleet, it waits and says how long is left", () => {
  const decision = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, fleetMemberCharacterIDs: [] }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Abandoned");
  assert.match(decision.why, /30 more minute/);
});

test("the thirty-minute wait ENDS the run, releasing the hull", () => {
  // Stopping is what releases the ship: the BFF's bot host treats a terminal
  // status as the end of the bot and logs its session out. A pause would hold
  // the hull for ever.
  const start = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }), undefined, 1_000);
  const expired = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    start.memory,
    1_000 + FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  );
  assert.ok(expired.stop);
  assert.match(expired.stop as string, /thirty minutes/i);
});

test("a rejoin from a pilot who WAS in the fleet is accepted", () => {
  // The allowlist can only be collected forward: at the moment of abandonment
  // there are no humans left to read, by definition.
  const supervised = decideCompanionAction(REQUEST, obs());
  assert.deepEqual(supervised.memory.lastSupervisorIDs, [HUMAN]);
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: HUMAN } }),
    waiting.memory,
  );
  assert.deepEqual(invited.action, { kind: "acceptFleetInvite", fleetID: 77 });
});

test("a rejoin from a STRANGER is refused — an idle docked pilot is not free to take", () => {
  // ⚠ Without this gate an idle docked companion can be fleet-invited by anyone
  // and handed a ship.
  const supervised = decideCompanionAction(REQUEST, obs());
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: 90000009 } }),
    waiting.memory,
  );
  assert.equal(invited.action.kind, "wait");
  assert.match(invited.why, /not in the fleet/i);
});

test("an invite with NO usable inviter id is refused", () => {
  // An unmatchable invite is exactly the one the gate exists to refuse.
  const supervised = decideCompanionAction(REQUEST, obs());
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: null } }),
    waiting.memory,
  );
  assert.equal(invited.action.kind, "wait");
});

test("the deadline beats a VALID invite — a bounded wait is not extendable", () => {
  // A rejoin past the deadline would be one bounded wait extended by another,
  // which is the unbounded life the persisted clock exists to prevent.
  const supervised = decideCompanionAction(REQUEST, obs(), undefined, 1_000);
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
    1_000,
  );
  const late = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: HUMAN } }),
    waiting.memory,
    1_000 + FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  );
  assert.ok(late.stop);
  assert.notEqual(late.action.kind, "acceptFleetInvite");
});

test("no station AND no star in view: it stops where it is, and says why", () => {
  // The one case with nothing to do. It should not happen in a real system --
  // every one of them has a star -- so it is reported rather than papered over.
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(null) }));
  assert.ok(decision.stop);
  assert.match(decision.stop as string, /no safe spot/i);
});

test("no station in view: it warps to the SUN, ONCE, with nothing configured", () => {
  // ⚠ NOTHING ON THE REQUEST SAYS WHERE TO GO, and that is the point. This used
  // to need an operator-named bookmark because a note in this repo said eve.js
  // had no celestial to warp to. It has one in every system, it is in the
  // snapshot the loop already reads, and warping to it is a mechanic the server
  // implements on purpose (`warpState.js` has a dedicated landing distance for
  // `kind: "sun"`).
  const first = decideCompanionAction(REQUEST, alone({ snapshot: gridWithSunOnly() }));
  assert.deepEqual(first.action, { kind: "warp", targetID: SUN });
  assert.equal(first.memory.abandonment?.safeSpotWarpIssued, true);
  // Not re-issued every two seconds while the server gets around to it.
  const second = decideCompanionAction(REQUEST, alone({ snapshot: gridWithSunOnly() }), first.memory);
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /warp to the sun to start/i);
});

test("the sun counts as safe only once the warp has been SEEN and is over", () => {
  // ⚠ "Issued the warp" is not "left the grid": the POST returns before
  // shipMode flips, and treating the two as the same would drop fleet with the
  // ship still sitting where it was. Confirmed by a reading, never by a timer.
  const request: FleetCompanionRequest = REQUEST;
  const issued = decideCompanionAction(request, alone({ snapshot: gridWithSunOnly() }));
  // Still on grid, warp not yet seen: it must NOT decide it is safe.
  const notYet = decideCompanionAction(
    request,
    alone({ inFleet: true, snapshot: gridWithSunOnly() }),
    issued.memory,
  );
  assert.notEqual(notYet.action.kind, "leaveFleet");
  // The warp is observed...
  const inWarp = decideCompanionAction(request, alone({ inWarp: true }), issued.memory);
  assert.equal(inWarp.memory.abandonment?.safeSpotWarpSeen, true);
  // ...and once it is over, the ship is safe and may drop fleet.
  const landed = decideCompanionAction(
    request,
    alone({ inFleet: true, snapshot: gridWithSunOnly() }),
    inWarp.memory,
  );
  assert.deepEqual(landed.action, { kind: "leaveFleet" });
});

// --- phase 0b: the controller ------------------------------------------------

test("start() re-seats a persisted abandonment, keeping its ORIGINAL clock", () => {
  // ⚠ The whole point of persisting it. A fresh thirty minutes on every restart
  // is an unbounded wait assembled out of bounded ones.
  const { deps } = makeDeps();
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST, { abandonedAtMs: 12_345, supervisorCharacterIDs: [HUMAN] });
  assert.equal(companion.snapshot().abandonment?.abandonedAtMs, 12_345);
  assert.deepEqual(companion.snapshot().abandonment?.supervisorCharacterIDs, [HUMAN]);
});

test("a re-seated abandonment does NOT claim the ship already reached safety", async () => {
  // The warp that was in flight when the process died is not a warp THIS run
  // observed. Claiming it had landed would let the next tick drop fleet with
  // the ship still in space.
  const { deps, issued } = makeDeps({
    observe: async () => alone({ inFleet: true, snapshot: gridWithStation(200_000) }),
  });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST, { abandonedAtMs: Date.now(), supervisorCharacterIDs: [HUMAN] });
  await companion.tick();
  assert.deepEqual(issued, [{ kind: "warp", targetID: 60000001 }]);
});

test("a ladder stop ends the run and KEEPS the sentence that says which one", async () => {
  const { deps } = makeDeps({ observe: async () => alone({ snapshot: gridWithStation(null) }) });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  const readout = companion.snapshot();
  assert.equal(readout.status, "stopped");
  assert.match(readout.failureReason as string, /no safe spot/i);
});

test("the readout carries the abandonment, which is how the clock gets persisted", async () => {
  const seen: (number | undefined)[] = [];
  const { deps } = makeDeps({
    observe: async () => alone({ docked: true, inFleet: false }),
    onProgress: (progress) => seen.push(progress.abandonment?.abandonedAtMs),
  });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  assert.ok(seen.some((at) => typeof at === "number"));
});

test("the ladder's memory is threaded, not dropped, between ticks", async () => {
  // ⚠ A decision whose memory is dropped silently un-does whatever that tick
  // learned — the safe-spot warp it just issued, or the humans it just saw.
  const { deps } = makeDeps({ observe: async () => obs() });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  const memory: CompanionLadderMemory = freshLadderMemory();
  assert.deepEqual(memory.lastSupervisorIDs, []);
  // After one supervised tick the loop is holding the human, ready to become
  // the rejoin allowlist the moment they leave.
  assert.equal(companion.snapshot().inFleet, true);
});

// --- rung 7: obeying the fleet ------------------------------------------------
//
// Below the supervision gate (only reached while a human is here) and above
// "Standing by". Tag beats broadcast — AUTHORITY, not freshness: a tag can
// only be a commander's write, a `Target` broadcast can come from any member.
// An order for something off THIS grid is not an order for this pilot at all,
// and it falls through rather than waiting.

/** Synthetic on-grid item ids — ordinary ships, not player or station ids. */
const TACKLE = 200001;
const LOGI = 200002;
const OTHER = 200003;

test("a fleet tag on grid is locked", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.ok(decision.lastOrderHeard);
});

test("the BEST tag wins when several are tagged, not the nearest", () => {
  // TACKLE is nearer (gridWithEntities puts the first id closest) but tagged
  // "Z" — the worst recognised letter. OTHER is farther but tagged "1", a
  // digit, which outranks every letter. Rank must win over distance.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetTargetTags: new Map([
        [TACKLE, "Z"],
        [OTHER, "1"],
      ]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: OTHER });
});

test("an unrecognised tag is still obeyed, not dropped", () => {
  // "Q" is not in the stock menu's A-J/X/Y/Z alphabet, but fleetTagRank still
  // gives it a finite rank — a hand-typed or non-stock tag is a real order.
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "Q"]]) }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("a tag on an item OFF this grid falls through to a broadcast", () => {
  // The tagged item (999999) never appears in the snapshot's entities, so the
  // tag names nothing this pilot can act on — it falls through to the Target
  // broadcast, which names an entity that IS on grid.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[999999, "A"]]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a Target broadcast locks the item it names, when it is on grid", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a tag BEATS a simultaneous conflicting Target broadcast — authority, not freshness", () => {
  // ⚠ This is the ordering that looks backwards. The broadcast is the fresher
  // act, but `setFleetTargetTag` refuses anyone who is not a fleet commander
  // while `sendBroadcast` checks only membership — a tag that exists is
  // provably the FC's, a broadcast could be any squad member's. The tag must
  // win even though the broadcast points at a DIFFERENT, equally on-grid item.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      fleetBroadcast: fleetBroadcast("Target", OTHER),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "tag");
});

test("an AlignTo broadcast aligns to the item it names", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([LOGI]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("AlignTo", LOGI),
    }),
  );
  assert.deepEqual(decision.action, { kind: "align", targetID: LOGI });
  assert.equal(decision.followingOrderFrom, "broadcast");
  // Never the wire name verbatim — the panel shows plain words.
  assert.ok(!decision.lastOrderHeard?.includes("AlignTo"));
});

function alignmentObs(source: "broadcast" | "chat", at: number, targetID = LOGI): FleetCompanionObservation {
  return obs({
    snapshot: gridWithAnchor(gridWithEntities([LOGI, OTHER])),
    fleetBroadcast: source === "broadcast" ? { ...fleetBroadcast("AlignTo", targetID), receivedAtMs: at } : null,
    chatMessages: source === "chat" ? [chatLine(chatCommandText("align", targetID), HUMAN, at)] : [],
  });
}

for (const source of ["broadcast", "chat"] as const) {
  test(`one successful ${source} alignment is dispatched once, and a new same-target order is obeyed`, async () => {
    let current = alignmentObs(source, 1_000);
    const { deps, issued } = makeDeps({ observe: async () => current });
    const companion = createFleetCompanion(deps);
    companion.start(REQUEST);
    assert.equal((await companion.tick()).kind, "align");
    for (let tick = 0; tick < 5; tick += 1) assert.equal((await companion.tick()).kind, "wait");
    assert.deepEqual(issued, [{ kind: "align", targetID: LOGI }], "standing align must not alternate with follow");
    current = alignmentObs(source, 2_000);
    assert.equal((await companion.tick()).kind, "align");
    assert.equal((await companion.tick()).kind, "wait");
    current = alignmentObs(source, 3_000, OTHER);
    assert.equal((await companion.tick()).kind, "align");
    assert.equal(issued.length, 3);
  });
}

test("a definitely refused alignment retries once and stops after success", async () => {
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => alignmentObs("broadcast", 1_000),
    issue: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Align refused"), { code: "CALL_REFUSED" });
    },
  }).deps);
  companion.start(REQUEST);
  await companion.tick();
  assert.equal((await companion.tick()).kind, "align");
  assert.equal((await companion.tick()).kind, "wait");
  assert.equal(calls, 2);
  assert.equal(companion.snapshot().status, "running");
});

test("an alignment success settling while paused is retained when the same run resumes", async () => {
  const began = deferred<void>();
  const outcome = deferred<void>();
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => alignmentObs("broadcast", 1_000),
    issue: async () => { calls += 1; began.resolve(); await outcome.promise; },
  }).deps);
  companion.start(REQUEST);
  const first = companion.tick();
  await began.promise;
  companion.pause();
  outcome.resolve();
  await first;
  assert.equal(companion.snapshot().status, "paused");
  companion.resume();
  assert.equal((await companion.tick()).kind, "wait");
  assert.match(companion.snapshot().why ?? "", /Continuing the alignment order/);
  assert.equal(calls, 1);
});

test("an alignment refusal settling after pause and resume still permits its bounded retry", async () => {
  const began = deferred<void>();
  const outcome = deferred<void>();
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => alignmentObs("broadcast", 1_000),
    issue: async () => {
      calls += 1;
      if (calls === 1) { began.resolve(); await outcome.promise; }
    },
  }).deps);
  companion.start(REQUEST);
  const first = companion.tick();
  await began.promise;
  companion.pause();
  companion.resume();
  outcome.reject(Object.assign(new Error("Align refused"), { code: "CALL_REFUSED" }));
  await first;
  assert.equal((await companion.tick()).kind, "align");
  assert.equal((await companion.tick()).kind, "wait");
  assert.equal(calls, 2);
});

test("an ambiguous alignment settling after pause and resume pauses the resumed driver without replay", async () => {
  const began = deferred<void>();
  const outcome = deferred<void>();
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => alignmentObs("broadcast", 1_000),
    issue: async () => { calls += 1; began.resolve(); await outcome.promise; },
  }).deps);
  companion.start(REQUEST);
  const first = companion.tick();
  await began.promise;
  companion.pause();
  companion.resume();
  outcome.reject(Object.assign(new Error("Align response lost"), { code: "BRIDGE_NETWORK_ERROR" }));
  await first;
  await companion.tick();
  assert.equal(companion.snapshot().status, "paused");
  assert.equal(calls, 1);
});

for (const oldOutcome of ["success", "CALL_REFUSED", "BRIDGE_NETWORK_ERROR"]) {
  test(`an old alignment ${oldOutcome} cannot settle a replacement Start with the same order identity`, async () => {
    const began = deferred<void>();
    const outcome = deferred<void>();
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => alignmentObs("broadcast", 1_000),
      issue: async () => {
        calls += 1;
        if (calls === 1) { began.resolve(); await outcome.promise; }
      },
    }).deps);
    companion.start(REQUEST);
    const first = companion.tick();
    await began.promise;
    companion.stop();
    companion.start(REQUEST);
    if (oldOutcome === "success") outcome.resolve();
    else outcome.reject(Object.assign(new Error("Old response failed"), { code: oldOutcome }));
    await first;
    assert.equal(companion.snapshot().status, "running");
    assert.equal((await companion.tick()).kind, "align");
    assert.equal((await companion.tick()).kind, "wait");
    assert.equal(calls, 2);
  });
}

test("overlapping public ticks share the pending command and do not issue another order", async () => {
  const began = deferred<void>();
  const outcome = deferred<void>();
  let current = alignmentObs("broadcast", 1_000);
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => current,
    issue: async () => {
      calls += 1;
      if (calls === 1) { began.resolve(); await outcome.promise; }
    },
  }).deps);
  companion.start(REQUEST);
  const first = companion.tick();
  await began.promise;
  current = alignmentObs("broadcast", 2_000, OTHER);
  const overlapping = companion.tick();
  assert.equal(overlapping, first);
  assert.equal(calls, 1);
  outcome.resolve();
  await first;
  assert.equal((await companion.tick()).kind, "align");
  assert.equal(calls, 2);
});

test("repeated definite alignment refusals pause after three writes", async () => {
  let calls = 0;
  const companion = createFleetCompanion(makeDeps({
    observe: async () => alignmentObs("broadcast", 1_000),
    issue: async () => {
      calls += 1;
      throw Object.assign(new Error("Align refused"), { code: "CALL_REFUSED" });
    },
  }).deps);
  companion.start(REQUEST);
  for (let tick = 0; tick < 10; tick += 1) await companion.tick();
  assert.equal(calls, 3);
  assert.equal(companion.snapshot().status, "paused");
});

for (const error of [
  Object.assign(new Error("Alignment response lost"), { code: "BRIDGE_NETWORK_ERROR" }),
  new Error("Unknown alignment failure"),
]) {
  test(`an ambiguous alignment response (${error.message}) pauses and is not replayed after resume`, async () => {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => alignmentObs("broadcast", 1_000),
      issue: async () => {
        calls += 1;
        throw error;
      },
    }).deps);
    companion.start(REQUEST);
    await companion.tick();
    assert.equal(companion.snapshot().status, "paused");
    companion.resume();
    for (let tick = 0; tick < 3; tick += 1) assert.equal((await companion.tick()).kind, "wait");
    assert.equal(calls, 1);
  });
}

test("a successful alignment is restored once after an observed fleet warp supersedes it", async () => {
  let current = alignmentObs("broadcast", 1_000);
  const { deps, issued } = makeDeps({ observe: async () => current });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  current = { ...current, inWarp: true, snapshot: null, fleetMemberCharacterIDs: null };
  await companion.tick();
  current = alignmentObs("broadcast", 1_000);
  assert.equal((await companion.tick()).kind, "align");
  assert.equal((await companion.tick()).kind, "wait");
  assert.deepEqual(issued, [{ kind: "align", targetID: LOGI }, { kind: "align", targetID: LOGI }]);
});

test("formation replacing an expired align lets the same order align again when it returns", async () => {
  let current = alignmentObs("broadcast", 1_000);
  const { deps, issued } = makeDeps({ observe: async () => current });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  current = { ...current, fleetBroadcast: null };
  assert.equal((await companion.tick()).kind, "keepAtRange");
  current = alignmentObs("broadcast", 1_000);
  assert.equal((await companion.tick()).kind, "align");
  assert.equal((await companion.tick()).kind, "wait");
  assert.deepEqual(issued, [
    { kind: "align", targetID: LOGI },
    { kind: "keepAtRange", targetID: FC_SHIP, range: DEFAULT_FOLLOW_M },
    { kind: "align", targetID: LOGI },
  ]);
});

test("a destination trip supersedes alignment and restores it once after route completion", async () => {
  let current = alignmentObs("broadcast", 1_000);
  const { deps, issued } = makeDeps({ observe: async () => current });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  current = { ...current, chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN, 2_000)] };
  assert.equal((await companion.tick()).kind, "travelTo");
  assert.equal((await companion.tick()).kind, "wait");
  current = { ...current, chatMessages: [], flightStatus: inSystem(SYSTEM_B) };
  assert.equal((await companion.tick()).kind, "align");
  assert.equal((await companion.tick()).kind, "wait");
  assert.deepEqual(issued, [
    { kind: "align", targetID: LOGI },
    { kind: "travelTo", systemID: SYSTEM_B },
    { kind: "align", targetID: LOGI },
  ]);
});

test("a standing alignment allows nearby loot but never approaches a distant can", async () => {
  let current = alignmentObs("broadcast", 1_000);
  const { deps, issued } = makeDeps({ observe: async () => current });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  const lootWhileAligned = (distance: number): FleetCompanionObservation => ({
    ...current,
    snapshot: gridWithAnchor({ ...lootGrid({ containerDistance: distance }),
      entities: [...lootGrid({ containerDistance: distance }).entities,
        ...gridWithEntities([LOGI]).entities.filter((entity) => !entity.isSelf)] }),
    chatMessages: [areaOrder("loot")],
  });
  current = lootWhileAligned(40_000);
  for (let tick = 0; tick < 3; tick += 1) assert.equal((await companion.tick()).kind, "wait");
  current = lootWhileAligned(500);
  assert.equal((await companion.tick()).kind, "lootContainer");
  assert.deepEqual(issued, [{ kind: "align", targetID: LOGI }, { kind: "lootContainer", containerID: CAN }]);
});

test("an already-locked target is not re-locked, and an EMPTY weaponModuleIDs holds it without firing", () => {
  // ⚠ EMPTY IS A REAL SETTING, NOT A FAULT. `weaponModuleIDs`'s own comment
  // says so: it is the default, and an operator who left it empty by accident
  // must read this pilot's "why" as a setting, never as the feature being
  // broken.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /locked/i);
  assert.match(decision.why, /no weapon is picked/i);
});

test("a lock the SERVER refused is retried, because the real list is consulted", () => {
  // ⚠ THE REGRESSION THIS PINS IS PERMANENT AND SILENT. A lock is issued
  // optimistically; the server can refuse it (out of range, already at max
  // targets, the ship died). If the already-locked check trusted this loop's
  // own memory of what it last ASKED for, a refused lock would read as done
  // for the rest of the run and the pilot would sit next to the fleet's
  // primary never locking it, with nothing in the readout saying why.
  //
  // So `obs.lockedTargetIDs` -- the authoritative list, re-read every tick --
  // wins over memory whenever it is available. An empty array is a real
  // "nothing is locked" answer and must be trusted as one.
  const memory = { ...freshLadderMemory(), lastLockIssuedFor: TACKLE };
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [],
    }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("obeying the fleet is skipped entirely once the supervision gate has failed", () => {
  // ⚠ An abandoned pilot getting safe must not start locking things. Nobody is
  // left to have given the order in the first place, and the whole point of
  // rung 2 sitting ABOVE this one is that it never runs while abandoned.
  const decision = decideCompanionAction(
    REQUEST,
    alone({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.notEqual(decision.phase, "Obeying fleet");
  // The abandonment protocol ran instead — no station and no safe spot here,
  // so it stops the run rather than doing anything with the tagged ship.
  assert.ok(decision.stop);
  assert.match(decision.stop as string, /no safe spot/i);
});

// --- rung 7: the Heal family --------------------------------------------------
//
// HealShield/HealArmor/HealCapacitor/HealTarget. Checked BEFORE the tag and
// the Target broadcast (a rep call is time-critical; a tag is standing
// state), but an already-satisfied Heal falls through to them instead of
// parking the tick — repairing and locking are not mutually exclusive for
// the same ship. See `decideFleetOrders`'s header for the full reasoning.

/** A fleet-mate's ship, distinct from the TACKLE/LOGI/OTHER combat targets. */
const ALLY = 200004;
const SHIELD_MODULE = 11200002;
const ARMOR_MODULE = 11200003;
const CAPACITOR_MODULE = 11200004;

/**
 * A grid carrying one or more ships plus this ship's own `activeModuleIDs` —
 * the authoritative "what is cycling" read the Heal rungs consult. `null`
 * means unreadable, matching `SpaceShipStatus.activeModuleIDs`'s own
 * null-means-unknown contract.
 */
function gridWithShipsAndActive(
  itemIDs: readonly number[],
  activeModuleIDs: readonly number[] | null = [],
): SpaceSnapshot {
  const entities = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    ...itemIDs.map((itemID, index) => ({
      itemID,
      kind: "ship",
      isSelf: false,
      position: { x: (index + 1) * 10_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    })),
  ];
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null, activeModuleIDs },
    entities,
  } as unknown as SpaceSnapshot;
}

test("remote repairs lock once and wait for authoritative lock confirmation", () => {
  const request = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const observation = obs({ snapshot: gridWithShipsAndActive([ALLY]),
    fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [] });
  const lock = decideCompanionAction(request, observation);
  assert.deepEqual(lock.action, { kind: "lock", targetID: ALLY });
  const pending = decideCompanionAction(request, observation, lock.memory);
  assert.equal(pending.action.kind, "wait");
  const unreadable = decideCompanionAction(request, { ...observation, lockedTargetIDs: null }, pending.memory);
  assert.equal(unreadable.action.kind, "wait", "memory of asking must not stand in for a lock");
  const ready = decideCompanionAction(request, { ...observation, lockedTargetIDs: [ALLY] }, unreadable.memory);
  assert.deepEqual(ready.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
});

test("an unconfirmed repair lock stops waiting without issuing duplicate locks", () => {
  const request = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const observation = obs({ snapshot: gridWithShipsAndActive([ALLY]),
    fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [] });
  let memory = freshLadderMemory();
  const actions: FleetCompanionAction[] = [];
  let why = "";
  for (let tick = 0; tick < 15; tick += 1) {
    const result = decideCompanionAction(request, observation, memory);
    memory = result.memory;
    actions.push(result.action);
    why = result.why;
  }
  assert.equal(actions.filter((action) => action.kind === "lock").length, 1);
  assert.equal(actions.filter((action) => action.kind === "activate").length, 0);
  assert.match(why, /could not be locked.*stopped asking/i);
});

test("definitely refused repair locks are bounded and never become activations", async () => {
  const attempted: FleetCompanionAction[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithShipsAndActive([ALLY]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [] }),
    issue: async (action) => { attempted.push(action); throw Object.assign(new Error("TargetTooFar"), { code: "CALL_REFUSED" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] });
  for (let tick = 0; tick < 8; tick += 1) await controller.tick();
  assert.deepEqual(attempted, Array.from({ length: 3 }, () => ({ kind: "lock", targetID: ALLY })));
});

test("out-of-range repair refusals stop retrying and let an area job continue", async () => {
  const attempted: FleetCompanionAction[] = [];
  const snapshot = gridWithShipsAndActive([ALLY]) as unknown as { entities: unknown[] };
  snapshot.entities.push({ itemID: 300001, kind: "container", isSelf: false,
    position: { x: 1000, y: 0, z: 0 }, radius: 0 });
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: snapshot as unknown as SpaceSnapshot,
      fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [ALLY],
      chatMessages: [chatLine("loot", HUMAN)] }),
    issue: async (action) => { attempted.push(action);
      if (action.kind === "activate") throw Object.assign(new Error("TargetNotWithinRangeGeneric"), { code: "CALL_REFUSED" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] });
  for (let tick = 0; tick < 8; tick += 1) await controller.tick();
  assert.equal(attempted.filter((action) => action.kind === "activate").length, 3);
  assert.ok(attempted.some((action) => action.kind === "lootContainer"));
});

test("an uncertain remote activation is not replayed against an inactive snapshot", async () => {
  let activations = 0;
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithShipsAndActive([ALLY]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [ALLY] }),
    issue: async () => { activations += 1; throw Object.assign(new Error("response lost"), { code: "BRIDGE_NETWORK_ERROR" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] });
  for (let tick = 0; tick < 8; tick += 1) await controller.tick();
  assert.equal(activations, 1);
  assert.match(controller.snapshot().why ?? "", /outcome could not be confirmed/i);
});

test("a changed heal recipient does not settle an uncertain module activation", async () => {
  const otherAlly = 200005;
  let targetID = ALLY;
  let activations = 0;
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithShipsAndActive([ALLY, otherAlly]),
      fleetBroadcast: fleetBroadcast("HealShield", targetID), lockedTargetIDs: [ALLY, otherAlly] }),
    issue: async () => { activations += 1; throw Object.assign(new Error("response lost"), { code: "BRIDGE_BAD_RESPONSE" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] });
  await controller.tick();
  targetID = otherAlly;
  await controller.tick();
  assert.equal(activations, 1);
  assert.match(controller.snapshot().why ?? "", /outcome could not be confirmed/i);
});

test("an uncertain repair lock is watched without duplicate dispatch", async () => {
  let attempts = 0;
  const controller = createFleetCompanion({
    observe: async () => obs({ snapshot: gridWithShipsAndActive([ALLY]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY), lockedTargetIDs: [] }),
    issue: async () => { attempts += 1; throw Object.assign(new Error("lock response lost"), { code: "BRIDGE_NETWORK_ERROR" }); },
    sleep: async () => {},
  });
  controller.start({ ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] });
  for (let tick = 0; tick < 15; tick += 1) await controller.tick();
  assert.equal(attempts, 1);
  assert.match(controller.snapshot().why ?? "", /could not be locked.*stopped asking/i);
});

test("HealShield activates a fitted remote SHIELD module on the ship the call names", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("HealArmor activates the ARMOUR list, never the shield one — families do not cross", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    remoteShieldModuleIDs: [SHIELD_MODULE],
    remoteArmorModuleIDs: [ARMOR_MODULE],
  };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealArmor", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_MODULE, targetID: ALLY });
});

test("HealCapacitor activates the CAPACITOR list", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteCapacitorModuleIDs: [CAPACITOR_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealCapacitor", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: CAPACITOR_MODULE, targetID: ALLY });
});

test("HealTarget draws on whichever remote-repair family this pilot has fitted", () => {
  // Real fleet logi use HealTarget to say "focus on THIS ship" without
  // saying which layer is hurt — this pilot brings whatever it has.
  const request: FleetCompanionRequest = { ...REQUEST, remoteArmorModuleIDs: [ARMOR_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealTarget", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_MODULE, targetID: ALLY });
});

test("a Heal call with no matching module fitted falls through — a logi-less pilot still flies", () => {
  const decision = decideCompanionAction(
    REQUEST, // no remote modules fitted at all
    obs({ snapshot: gridWithShipsAndActive([ALLY]), lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.notEqual(decision.action.kind, "activate");
  assert.equal(decision.phase, "Standing by");
});

test("a Heal call for a ship OFF this grid falls through rather than waiting", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({
      // ALLY, the ship the call names, is not among these entities.
      snapshot: gridWithShipsAndActive([TACKLE]),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.notEqual(decision.action.kind, "activate");
  assert.equal(decision.phase, "Standing by");
});

test("a module the server confirms is already running on this target is not re-activated", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], []),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  // The server now shows it cycling, and this ladder's own memory agrees it
  // was the one that aimed it at ALLY — nothing new to start.
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], [SHIELD_MODULE]),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "activate");
});

test("with no authoritative module read, the ladder falls back to its OWN memory of what it issued", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], null),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], null),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "activate");
});

test("the heal call moving to a DIFFERENT ship re-issues the module at the new one", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const OTHER_ALLY = 200005;
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], [SHIELD_MODULE]),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([OTHER_ALLY], [SHIELD_MODULE]),
      lockedTargetIDs: [OTHER_ALLY], fleetBroadcast: fleetBroadcast("HealShield", OTHER_ALLY),
    }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: OTHER_ALLY });
});

test("a fresh Heal call is answered even while a tag also stands — urgency wins this tick", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([TACKLE, ALLY]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
});

test("once the heal is already running, the SAME tick's tag is obeyed — not mutually exclusive", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastHealTargetID: ALLY,
    lastHealModuleIDs: [SHIELD_MODULE],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([TACKLE, ALLY], [SHIELD_MODULE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [ALLY], fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "tag");
});

// --- rung 7: opening fire once a called target is locked ---------------------
//
// `lockThenEngage` replaced `lockOrHold` (see its own header in
// fleetCompanionLoop.ts): a called target that is ALREADY locked no longer
// just sits there — it opens fire, one weapon a tick, using whatever this
// pilot has fitted in `weaponModuleIDs`. Lock, observe, THEN fire.

/** Synthetic weapon module ids — a small rack, none of them banked unless a test says so. */
const GUN_1 = 11300001;
const GUN_2 = 11300002;
const GUN_3 = 11300003;
const GUN_MASTER = 11300010;
const GUN_SLAVE = 11300011;
const GUN_UNBANKED = 11300012;

/**
 * As `gridWithEntities`, but the ship also carries `activeModuleIDs` and
 * `weaponBanks` — the two reads `decideOpenFire` consults. Neither
 * `gridWithEntities` (no rack) nor `gridWithShipsAndActive` (no tag/broadcast
 * targets — its ships are ALLY, the Heal family's own fixture) carries a
 * called target AND a rack state at once, which the fire tests below need.
 */
function gridWithEntitiesAndRack(
  itemIDs: readonly number[],
  activeModuleIDs: readonly number[] | null = [],
  weaponBanks: Readonly<Record<number, readonly number[]>> | null = {},
): SpaceSnapshot {
  const entities = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    ...itemIDs.map((itemID, index) => ({
      itemID,
      kind: "ship",
      isSelf: false,
      position: { x: (index + 1) * 10_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    })),
  ];
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null, activeModuleIDs, weaponBanks },
    entities,
  } as unknown as SpaceSnapshot;
}

test("a called target NOT YET LOCKED locks first, and does not fire", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("once the lock is OBSERVED, the very next tick opens fire on the called target", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.match(decision.why, /opening fire/i);
});

test("the rack comes up ONE WEAPON PER TICK, and each confirmed weapon is skipped the next", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2, GUN_3] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], []) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });

  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1]) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: TACKLE });

  const third = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1, GUN_2]) }),
    second.memory,
  );
  assert.deepEqual(third.action, { kind: "activate", moduleID: GUN_3, targetID: TACKLE });

  // The whole rack is now confirmed cycling — nothing NEW to start, and this
  // rung still reports "Obeying fleet", not a fall to "Standing by".
  const fourth = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1, GUN_2, GUN_3]) }),
    third.memory,
  );
  assert.equal(fourth.action.kind, "wait");
  assert.equal(fourth.phase, "Obeying fleet");
  assert.equal(fourth.followingOrderFrom, "tag");
  assert.match(fourth.why, /firing on it/i);
});

test("A NEW CALL RE-AIMS THE WHOLE RACK, even while the old guns still read as cycling", () => {
  // ⚠ THIS IS THE ONE THAT MATTERS MOST. `activeModuleIDs` says a module is
  // cycling and never says AT WHOM — see `lastFireTargetID`'s own comment. A
  // commander who re-tags OTHER must see every gun re-issued, gun by gun, not
  // a pilot that reads the still-cycling old guns as already answering the
  // new call.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2, GUN_3] };
  const firingOnTackle: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1, GUN_2, GUN_3],
  };
  // The server has not caught up: all three old guns still read as cycling,
  // unchanged, through every tick below — only the CALL has moved to OTHER.
  const stillCyclingFromTackle = [GUN_1, GUN_2, GUN_3];
  const called = { fleetTargetTags: new Map([[OTHER, "A"]]), lockedTargetIDs: [OTHER] };

  const first = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    firingOnTackle,
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: OTHER });

  const second = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: OTHER });

  const third = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    second.memory,
  );
  assert.deepEqual(third.action, { kind: "activate", moduleID: GUN_3, targetID: OTHER });

  // All three re-aimed at OTHER — the rack is done, and never once did a gun
  // read as already answering the new call just because it was still cycling.
  const fourth = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    third.memory,
  );
  assert.equal(fourth.action.kind, "wait");
  assert.match(fourth.why, /firing on it/i);
});

test("a banked SLAVE counts as already firing the moment its MASTER is seen cycling", () => {
  // ⚠ WITHOUT THIS, THE RUNG PICKS THE SAME SLAVE FOREVER. `activeModuleIDs`
  // never names a slave — see `cyclingWeapons`'s own header — so a slave
  // checked against the raw list alone never reads as firing, and because
  // this loop issues one call per tick, that one slave would starve every
  // rung beneath it.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_SLAVE] };
  const banks: Readonly<Record<number, readonly number[]>> = { [GUN_MASTER]: [GUN_SLAVE] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [], banks) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_SLAVE, targetID: TACKLE });

  // The server reports only the MASTER cycling now — activating a slave fires
  // the whole bank through it.
  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_MASTER], banks) }),
    first.memory,
  );
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /firing on it/i);
});

test("an UNBANKED weapon needs its OWN id in activeModuleIDs to count as firing", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_UNBANKED] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], []) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_UNBANKED, targetID: TACKLE });

  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_UNBANKED]) }),
    first.memory,
  );
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /firing on it/i);
});

test("an UNREADABLE activeModuleIDs falls back to memory alone, advancing the rack without re-firing it", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });

  // Still unreadable — no authoritative read to prefer, so the memory of
  // GUN_1 alone is trusted, and GUN_2 is the one that goes up. Never GUN_1
  // again, and never the whole rack re-fired at once.
  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: TACKLE });

  const third = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
    second.memory,
  );
  assert.equal(third.action.kind, "wait");
  assert.match(third.why, /firing on it/i);
});

test("a Target BROADCAST opens fire once its lock is observed, exactly as a tag does", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE], []),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a fully-firing tag still holds the tick, the same way an already-locked tag always did", () => {
  // Consistency check: `lockOrHold`'s already-locked branch always returned a
  // decision (never null) so nothing below it in `decideFleetOrders` was ever
  // reached that same tick. `lockThenEngage`'s fully-firing branch does the
  // same — a pending AlignTo broadcast here must NOT be answered instead.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE, LOGI], [GUN_1]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
      fleetBroadcast: fleetBroadcast("AlignTo", LOGI),
    }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /firing on it/i);
});

test("a satisfied Heal call falls through to the tag; a satisfied rack does not fall through any further", () => {
  // decideHealOrder's null and lockThenEngage's fully-firing WAIT are the SAME
  // "nothing NEW to start" answer, told two different ways for two different
  // reasons — see `decideHealOrder`'s own header on why heal falls through
  // (it does not compete with locking for the ship's state) versus why a tag
  // holds the tick outright (there is nothing lower-priority within
  // `decideFleetOrders` that a satisfied tag should yield to).
  const request: FleetCompanionRequest = {
    ...REQUEST,
    remoteShieldModuleIDs: [SHIELD_MODULE],
    weaponModuleIDs: [GUN_1],
  };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastHealTargetID: ALLY,
    lastHealModuleIDs: [SHIELD_MODULE],
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE, ALLY], [SHIELD_MODULE, GUN_1]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /firing on it/i);
});

// --- rung 7: TravelTo ---------------------------------------------------------

/** Synthetic solar system ids — no on-grid meaning, just a destination. */
const SYSTEM_B = 30000001;
const SYSTEM_C = 30000002;

test("a TravelTo broadcast starts the route once, and not again for the same system", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  assert.deepEqual(first.action, { kind: "travelTo", systemID: SYSTEM_B });
  assert.equal(first.memory.lastRoutedSystemID, SYSTEM_B);
  assert.equal(first.followingOrderFrom, "broadcast");

  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "travelTo");
});

test("a TravelTo broadcast naming a NEW system routes again", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_C) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "travelTo", systemID: SYSTEM_C });
});

// --- rung 7: JumpTo (honest partial) ------------------------------------------
//
// `itemID` is a single stargate; `api.jump` needs the gate on the far side
// too, which nothing available to this pure, synchronous ladder can supply
// without inventing it. So this rung gets the ship TO the gate and holds —
// see `decideFleetOrders`'s own comment for the full reasoning.

const GATE = 200006;

/** A grid carrying one stargate at a given surface distance (or none). */
function gridWithGate(distanceM: number | null): SpaceSnapshot {
  const entities = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
  ];
  if (distanceM !== null) {
    entities.push({
      itemID: GATE,
      kind: "stargate",
      isSelf: false,
      position: { x: distanceM, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

test("a JumpTo broadcast warps to the named gate when it is far", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(200_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(decision.action, { kind: "warp", targetID: GATE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a JumpTo broadcast closes in when too close for the server to warp to", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(50_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(decision.action, { kind: "approach", targetID: GATE });
  assert.equal(decision.memory.closingOn, GATE);
});

test("a JumpTo broadcast JUMPS once the ship is at the gate", () => {
  // ⚠ THIS TEST USED TO PIN THE OPPOSITE, and the reason it did was wrong. It
  // was "HOLDS at jump range - it never invents a second gate id", because
  // `api.jump` demanded a far-side gate this pure ladder could not solve. The
  // GAME never demanded one: `jumpSessionViaStargate` resolves the destination
  // from the source gate and rejects only a MISMATCHED far id. The requirement
  // was our own BFF check. Nothing is invented here -- 0 asks the server to use
  // the gate's own `destinationID`.
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(1_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(decision.action, { kind: "jumpGate", gateID: GATE });
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a WarpTo broadcast warps to the named object, ONCE", () => {
  // ⚠ THIS RUNG DID NOT EXIST. `WarpTo` was classified "no action needed"
  // because the table claimed the server warps the fleet when the broadcast
  // lands. It does not -- `sendBroadcast` only notifies -- so a fleet telling
  // this pilot to warp watched it sit still.
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(500_000), fleetBroadcast: fleetBroadcast("WarpTo", GATE) }),
  );
  assert.deepEqual(first.action, { kind: "warp", targetID: GATE });
  assert.equal(first.followingOrderFrom, "broadcast");

  // ⚠ AND NOT AGAIN. A broadcast stands for its whole freshness window, so a
  // rung that re-warped every tick would land and immediately warp off again.
  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(500_000), fleetBroadcast: fleetBroadcast("WarpTo", GATE) }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "warp");
});

test("a JumpTo broadcast for a gate OFF this grid falls through", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(null), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.notEqual(decision.action.kind, "warp");
  assert.equal(decision.phase, "Standing by");
});

// --- rung 7: chat commands ----------------------------------------------------
//
// A chat order reaches the SAME c-f branches a broadcast does, through
// `resolveNamedOrder` — see that function's own header and `decideFleetOrders`'s
// "c-f" comment. These tests exercise that shared path from the chat side: the
// sender gate (the whole security property of the feature), precedence against
// a broadcast, newest-wins, and each verb actually reaching its rung. They do
// NOT retest the parser's own grammar (link shape, verb aliases, truncation) —
// `chatCommands.test.ts` already owns that.

/** A character NOT on any request's `chatCommandSenders` in this section. */
const UNLISTED_SENDER = 90000006;

/** One chat line, addressed to whichever character id the test names. */
function chatLine(message: string, characterID: number, createdAtMs = 1_000): ChatMessage {
  return { characterID, characterName: "Fleet Mate", message, createdAtMs };
}

/** A well-formed chat-command line: a recognised verb plus a showinfo link
 *  naming `itemID` — see `chatCommands.ts`'s own header for the link format.
 *  The TYPEID (670 here) is never read back; any digits parse. */
function chatCommandText(verb: string, itemID: number): string {
  return verb + " <url=showinfo:670//" + itemID + ">Some Ship</url>";
}

/** As `gridWithGate`, but the ship reads FOLLOW — what `isFollowing` requires
 *  for `decideCloseIn`'s "closing" step (an approach already under way). */
function gridWithGateFollowing(distanceM: number): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: "FOLLOW" },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: GATE, kind: "stargate", isSelf: false, position: { x: distanceM, y: 0, z: 0 }, radius: 0, mode: null },
    ],
  } as unknown as SpaceSnapshot;
}

test("a follow order ends the gate approach, so a later JumpTo just outside jump range closes in again", () => {
  // Seen live: three companions approached the called gate, the call lapsed and
  // formation put them on the commander. At the next JumpTo the ones just
  // outside jump range read FOLLOW plus the old `closingOn` as "closing" and
  // waited at the gate until jumped by hand.
  const approaching = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithAnchor(gridWithGate(50_000)), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(approaching.action, { kind: "approach", targetID: GATE });
  assert.equal(approaching.memory.closingOn, GATE);

  const following = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithAnchor(gridWithGateFollowing(50_000)) }),
    approaching.memory,
  );
  assert.deepEqual(following.action, { kind: "keepAtRange", targetID: FC_SHIP, range: DEFAULT_FOLLOW_M });
  assert.equal(following.memory.closingOn, null);

  const called = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithAnchor(gridWithGateFollowing(3_000)), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
    following.memory,
  );
  assert.deepEqual(called.action, { kind: "approach", targetID: GATE });
});

test("a chat 'target <link>' from an ALLOWED sender locks the named ship, then fires once the lock is observed", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    weaponModuleIDs: [GUN_1],
  };
  const chatMessages = [chatLine(chatCommandText("target", TACKLE), HUMAN)];

  const locking = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntitiesAndRack([TACKLE]), chatMessages }),
  );
  assert.deepEqual(locking.action, { kind: "lock", targetID: TACKLE });
  assert.equal(locking.followingOrderFrom, "chat");

  // Same reachable path a broadcast target takes: lock, observe, then fire.
  const firing = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE], []),
      chatMessages,
      lockedTargetIDs: [TACKLE],
    }),
    locking.memory,
  );
  assert.deepEqual(firing.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.equal(firing.followingOrderFrom, "chat");
});

test("a companion obeys EVERY channel, with nothing configured to enable them", () => {
  // ⚠ THE TWO TESTS THIS REPLACES PINNED A FEATURE THAT NO LONGER EXISTS.
  // They were "obeys without tag ignores a tag" and "obeys without broadcast
  // ignores a Target broadcast" -- the `obeys` list an operator could untick a
  // channel from. The operator asked for that whole surface to go
  // (docs/fleet-companion-simplification.md): a companion listens to everything
  // and acts on what it can. What is worth pinning now is the opposite claim.
  const tagged = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.deepEqual(tagged.action, { kind: "lock", targetID: TACKLE });
  assert.equal(tagged.followingOrderFrom, "tag");

  const broadcast = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(broadcast.action, { kind: "lock", targetID: TACKLE });
  assert.equal(broadcast.followingOrderFrom, "broadcast");
});

test("THE SENDER GATE: a chat command from someone NOT in chatCommandSenders does nothing at all", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), UNLISTED_SENDER)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("THE SENDER GATE: a fleet with NO commander on the roster obeys nobody over chat", () => {
  // ⚠ AN UNREADABLE OR COMMANDERLESS ROSTER MEANS OBEY NOBODY, never "anybody
  // will do". The roster is the entire gate now that the hand-typed sender
  // list is gone, and chat is LOCAL chat -- readable by everyone in the system
  // -- so collapsing "cannot tell who is in charge" into "obey the sender"
  // would hand this pilot to a stranger.
  const request: FleetCompanionRequest = REQUEST;
  const decision = decideCompanionAction(
    request,
    obs({
      fleetCommanderCharacterIDs: [],
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("A BROADCAST OUTRANKS A CHAT LINE when they disagree, and chat is obeyed once the broadcast is gone", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const chatMessages = [chatLine(chatCommandText("target", OTHER), HUMAN)];

  const withBroadcast = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages,
    }),
  );
  assert.deepEqual(withBroadcast.action, { kind: "lock", targetID: TACKLE });
  assert.equal(withBroadcast.followingOrderFrom, "broadcast");

  const withoutBroadcast = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages }),
  );
  assert.deepEqual(withoutBroadcast.action, { kind: "lock", targetID: OTHER });
  assert.equal(withoutBroadcast.followingOrderFrom, "chat");
});

test("an OFF-GRID broadcast falls through to a chat order instead of starving it", () => {
  // ⚠ THE REGRESSION THIS PINS IS A BUG THE RUNG'S OWN HEADER FORBADE. It has
  // always said a call for something not on this grid is skipped "falling
  // through to the NEXT SOURCE" — which was trivially satisfied while a
  // broadcast was the only source that could be unactionable, because the only
  // thing under it was "Standing by". Once chat became a real next source, a
  // resolver that picked the broadcast FIRST and only then discovered it was
  // off-grid stopped falling through to anything: the pilot stood by with an
  // actionable, allowed-sender chat order sitting right there. Choosing the
  // source and testing whether it can be acted on have to be the same step.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      // OTHER is here to be shot; the broadcast names something that is not.
      snapshot: gridWithEntities([OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages: [chatLine(chatCommandText("target", OTHER), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: OTHER });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("an off-grid broadcast with NO chat order to fall through to still just stands by", () => {
  // The other half of the same rule, and the one that proves the fix did not
  // simply start obeying off-grid calls: with nothing underneath to fall
  // through TO, an unactionable call is still no order for this pilot.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages: [],
    }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.notEqual(decision.followingOrderFrom, "broadcast");
});

test("NEWEST WINS: the later createdAtMs is obeyed, regardless of which order the lines arrive in", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const older = chatLine(chatCommandText("target", TACKLE), HUMAN, 1_000);
  const newer = chatLine(chatCommandText("target", OTHER), HUMAN, 5_000);

  const olderFirst = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages: [older, newer] }),
  );
  assert.deepEqual(olderFirst.action, { kind: "lock", targetID: OTHER });

  const newerFirst = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages: [newer, older] }),
  );
  assert.deepEqual(newerFirst.action, { kind: "lock", targetID: OTHER });
});

test("a non-command chat line from an allowed sender is ignored, and does NOT suppress an older real command", () => {
  // ⚠ PINNED FROM THE CODE, NOT ASSUMED. `newestChatOrder` only ever compares
  // lines that PARSE against each other — a message that fails
  // `parseChatCommand` hits `continue` before it ever touches `best`, in the
  // same loop iteration a disallowed sender's line does. So ordinary chatter
  // typed after a real order never erases it; the order stands until a NEWER
  // command replaces it, exactly as a broadcast is only replaced by another
  // broadcast, never by silence.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const order = chatLine(chatCommandText("target", TACKLE), HUMAN, 1_000);
  const chatter = chatLine("nice kill on that last one", HUMAN, 5_000);
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE]), chatMessages: [order, chatter] }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'align <link>' reaches the align rung", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("align", LOGI), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "align", targetID: LOGI });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'travel <link>' reaches the travelTo rung", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([]),
      chatMessages: [chatLine(chatCommandText("travel", SYSTEM_B), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "travelTo", systemID: SYSTEM_B });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'jump <link>' reaches the JumpTo rung, through all four decideCloseIn steps", () => {
  // ⚠ FOUR STEP KINDS, ALL FOUR MUST STILL WORK FROM CHAT: arrive, closing,
  // approach, and the warp fallthrough. The broadcast tests above this section
  // never exercised "closing" at all (it needs the ship reading FOLLOW, not
  // merely a distance) — `gridWithGateFollowing` supplies that.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const chatMessages = [chatLine(chatCommandText("jump", GATE), HUMAN)];

  // warp — far enough that the server will take the warp.
  const warping = decideCompanionAction(request, obs({ snapshot: gridWithGate(200_000), chatMessages }));
  assert.deepEqual(warping.action, { kind: "warp", targetID: GATE });
  assert.equal(warping.followingOrderFrom, "chat");

  // approach — too close for the server to accept a warp, nothing closing yet.
  const approaching = decideCompanionAction(
    request,
    obs({ snapshot: gridWithGate(50_000), chatMessages }),
  );
  assert.deepEqual(approaching.action, { kind: "approach", targetID: GATE });
  assert.equal(approaching.memory.closingOn, GATE);
  assert.equal(approaching.followingOrderFrom, "chat");

  // closing — this pilot's own approach is already running on this gate.
  const closing = decideCompanionAction(
    request,
    obs({ snapshot: gridWithGateFollowing(50_000), chatMessages }),
    approaching.memory,
  );
  assert.equal(closing.action.kind, "wait");
  assert.match(closing.why, /closing on it/i);
  assert.equal(closing.followingOrderFrom, "chat");

  // arrive — at jump range: it jumps. This step used to HOLD, because
  // `api.jump` demanded a far-side gate the ladder could not solve; the game
  // never demanded one and our own BFF check did.
  const arrived = decideCompanionAction(request, obs({ snapshot: gridWithGate(1_000), chatMessages }));
  assert.deepEqual(arrived.action, { kind: "jumpGate", gateID: GATE });
  assert.equal(arrived.followingOrderFrom, "chat");
});

test("a chat 'warp <link>' to something ON THIS GRID is an ordinary item warp", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("warp", LOGI), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "warp", targetID: LOGI });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'warp <fleet-mate>' warps to the MEMBER, because the id is not on this grid", () => {
  // ⚠ THE "COME TO ME" CASE, AND THE ONLY ORDER IN THIS SET THAT IS USEFUL AT A
  // DISTANCE. A character link carries a CHARACTER id, which is in nobody's
  // grid: the ladder recognises it as a fleet-mate and hands the server its own
  // fleet-member warp, which resolves where that member is.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("warp", HUMAN), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "warpToFleetMember", characterID: HUMAN });
  assert.equal(decision.followingOrderFrom, "chat");
  assert.match(decision.why, /fleet-mate/i);
});

test("a chat 'warp <id>' naming neither a grid object nor a fleet-mate does nothing", () => {
  // The refusal that keeps a mistyped or stale link from becoming a warp to
  // somewhere nobody named. It falls through to this pilot's own ladder rather
  // than guessing at the id.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("warp", 424242), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "warp");
  assert.notEqual(decision.action.kind, "warpToFleetMember");
  assert.equal(decision.followingOrderFrom ?? null, null);
});

test("a roster that could not be read refuses a member warp rather than taking the id on faith", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      fleetMemberCharacterIDs: null,
      chatMessages: [chatLine(chatCommandText("warp", HUMAN), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "warpToFleetMember");
});

test("lastOrderHeard and the why sentence name CHAT, not the fleet, when the order came from chat", () => {
  // A player reading the panel must be able to tell "the fleet called this"
  // from "somebody typed this" — see `NamedOrder`'s own comment.
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("align", LOGI), HUMAN)],
    }),
  );
  assert.equal(decision.followingOrderFrom, "chat");
  assert.match(decision.lastOrderHeard ?? "", /chat/i);
  assert.match(decision.why, /chat/i);
  assert.doesNotMatch(decision.lastOrderHeard ?? "", /the fleet/i);
  assert.doesNotMatch(decision.why, /the fleet broadcast/i);
});

test("chat orders are ALSO skipped once the supervision gate has failed", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
  };
  const decision = decideCompanionAction(
    request,
    alone({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.notEqual(decision.phase, "Obeying fleet");
});

// --- rung 7: everything above is skipped once abandonment starts -------------

test("Heal and TravelTo are ALSO skipped once the supervision gate has failed", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const healDecision = decideCompanionAction(
    request,
    alone({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.notEqual(healDecision.action.kind, "activate");
  assert.notEqual(healDecision.phase, "Obeying fleet");

  const travelDecision = decideCompanionAction(
    REQUEST,
    alone({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  assert.notEqual(travelDecision.action.kind, "travelTo");
  assert.notEqual(travelDecision.phase, "Obeying fleet");
});

// --- rung 3: tank up -----------------------------------------
//
// Above obeying the fleet, below the supervision gate -- see `decideTankUp`'s
// own header in fleetCompanionLoop.ts for the full ladder: a fitted hardener
// while a fight is on, then each layer's own repairer (on while hurt, inverted
// off below the capacitor floor), then the fight-end stand-down.
//
/** Synthetic module item ids for the tank-up rung, distinct from every id used above. */
const HARDENER_1 = 11400001;
const HARDENER_2 = 11400002;
const SHIELD_BOOSTER = 11400003;
const ARMOR_REPAIRER = 11400004;
const HULL_REPAIRER = 11400005;

/** A whole, unhurt ship with a full capacitor and no fight -- what every tank-up test overrides from. */
function tankObs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    capacitorRatio: 1,
    hostileOnGrid: null,
    targetedByPlayer: null,
    snapshot: gridWithShipsAndActive([], []),
    ...overrides,
  });
}

test("a fitted hardener switches on, self-targeted, while hostiles are on this grid", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(request, tankObs({ hostileOnGrid: true }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

test("targetedByPlayer ALONE is enough to light a hardener, with hostileOnGrid unreadable", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: null, targetedByPlayer: true }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
});

test("an already-active hardener is skipped in favor of the next idle one", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1, HARDENER_2] };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], [HARDENER_1]) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_2, targetID: 0 });
});

test("only ONE hardener switches on per tick, even with several idle at once", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1, HARDENER_2] };
  const decision = decideCompanionAction(request, tankObs({ hostileOnGrid: true }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
});

// --- EACH LAYER USES ITS OWN LIST AND NEVER ANOTHER'S -------------------------

test("a hurt SHIELD starts its own shield booster", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ shieldRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_BOOSTER, targetID: 0 });
  assert.match(decision.why, /shield/i);
});

test("a hurt ARMOUR starts its own armour repairer, NEVER the shield booster", () => {
  // A shield booster cannot repair armour -- crossing families is the exact bug
  // this per-layer list shape exists to prevent. Both lists are fitted here so a
  // bug that reached across families would have something to reach for.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ armorRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
  assert.match(decision.why, /armor/i);
});

test("a hurt HULL starts its own hull repairer, never a shield or armour repairer", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ hullRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HULL_REPAIRER, targetID: 0 });
  assert.match(decision.why, /hull/i);
});

// --- THE CAPACITOR FLOOR INVERTS THE RUNG --------------------------------------

test("below the capacitor floor, a RUNNING repairer switches OFF even though the layer is still hurt", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    capacitorFloor: 0.2,
  };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      capacitorRatio: 0.1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.match(decision.why, /capacitor/i);
});

test("an UNREADABLE capacitor fails OPEN toward repairing -- it starts the cycle", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({ armorRatio: 0.5, capacitorRatio: null }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
});

// --- THE RECOVERED OFF-HALF ----------------------------------------------------

test("a layer that heals back to the threshold switches its running repairer off, saying the layer is whole -- not the capacitor sentence", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: TANK_LAYER_HURT_THRESHOLD,
      capacitorRatio: 1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.match(decision.why, /whole/i);
  assert.doesNotMatch(decision.why, /capacitor/i);
});

// --- an unreadable layer ratio is undecidable, not "not hurt" -----------------

test("an UNREADABLE layer ratio neither starts nor stops a cycle", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };

  // Idle, and unreadable: must not start.
  const idle = decideCompanionAction(
    request,
    tankObs({ armorRatio: null, snapshot: gridWithShipsAndActive([], []) }),
  );
  assert.notEqual(idle.phase, "Tanking up");

  // Running, and unreadable: must not stop either.
  const running = decideCompanionAction(
    request,
    tankObs({ armorRatio: null, snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
  );
  assert.notEqual(running.phase, "Tanking up");
  assert.notEqual(running.phase, "Standing down");
});

// --- AN UNREADABLE MODULE MAP IS "WHAT I LIT", NOT "NOTHING IS RUNNING" -------
//
// `activeModuleIDs` has three states and this rung used to see two: `[]` for an
// idle rack, `null` for a read that COULD NOT ANSWER, and a `?? []` that made
// them the same thing. On an unreadable tick every fitted module looked idle,
// and step 1's search tests only that set -- so it re-picked THE SAME hardener
// every tick, issued an action every tick, and starved every rung below it.
//
// ⚠ THIS IS A LADDER BUG WEARING A TANK BUG'S CLOTHES. A redundant activate
// costs one call. Returning a decision on every consecutive tick costs every
// rung beneath rung 3 its turn, for as long as the read stays broken -- and
// phase 6's flee sits beneath it, in exactly the fight where a partial snapshot
// is likeliest and leaving is most urgent.

test("an unreadable module map does not re-light the same hardener every tick", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    defenseModuleIDs: [HARDENER_1, HARDENER_2],
  };
  const unreadable = tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], null) });

  const first = decideCompanionAction(request, unreadable);
  assert.deepEqual(first.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });

  // The tick that used to repeat itself. Nothing about the world has changed --
  // the map is still unreadable -- so the ONLY thing that can move this on is
  // the rung's own record of what it lit.
  const second = decideCompanionAction(request, unreadable, first.memory);
  assert.deepEqual(
    second.action,
    { kind: "activate", moduleID: HARDENER_2, targetID: 0 },
    "an unreadable map must fall back to the record, not re-pick the first hardener",
  );
});

test("an unreadable module map lets the rung FALL THROUGH once its lists are accounted for", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    defenseModuleIDs: [HARDENER_1, HARDENER_2],
  };
  const unreadable = tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], null) });

  let memory: CompanionLadderMemory = freshLadderMemory();
  for (let tick = 0; tick < 2; tick += 1) {
    memory = decideCompanionAction(request, unreadable, memory).memory;
  }

  // ⚠ THE WHOLE POINT: the rung runs out of things to light and gets out of the
  // way. Before the fix this assertion could never hold, on any tick.
  const settled = decideCompanionAction(request, unreadable, memory);
  assert.notEqual(
    settled.phase,
    "Tanking up",
    "with every fitted hardener lit, an unreadable map must stop claiming the tick",
  );
});

test("an unreadable module map still lights a hardener this rung has NO record of", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    defenseModuleIDs: [HARDENER_1, HARDENER_2],
  };
  // The record names one of the two. The other has never been lit, and an
  // unreadable map is not a reason to leave it dark -- that is the failure that
  // actually costs a ship, and it is the one the fallback must not introduce.
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1],
  };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], null) }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_2, targetID: 0 });
});

test("a READABLE empty map is still an idle rack, and the record does not override it", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  // The server-side short-cycle case: this rung lit the hardener, the server
  // dropped it, and the map says so plainly. A readable answer always wins over
  // the rung's memory of what it asked for -- which is the contract the
  // `?? []` was hiding rather than honouring.
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1],
  };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], []) }),
    memory,
  );
  assert.deepEqual(
    decision.action,
    { kind: "activate", moduleID: HARDENER_1, targetID: 0 },
    "a module the server says is off must be re-lit, whatever this rung remembers",
  );
});

// --- STAND-DOWN NEVER FIRES ON A BLIND READ ------------------------------------

test("hostileOnGrid === false stands down ONE cycling module per tick, from the record", () => {
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1, ARMOR_REPAIRER],
  };
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], [HARDENER_1, ARMOR_REPAIRER]) }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: HARDENER_1 });
  assert.equal(decision.phase, "Standing down");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [ARMOR_REPAIRER]);
});

test("hostileOnGrid === false skips a record entry that already stopped cycling on its own", () => {
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1, ARMOR_REPAIRER],
  };
  const decision = decideCompanionAction(
    REQUEST,
    // HARDENER_1 is no longer active -- only ARMOR_REPAIRER is still cycling.
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [HARDENER_1]);
});

test("hostileOnGrid === null keeps the tank UP -- stand-down never fires on a blind read", () => {
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({ hostileOnGrid: null, snapshot: gridWithShipsAndActive([], [HARDENER_1]) }),
    memory,
  );
  assert.notEqual(decision.phase, "Standing down");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [HARDENER_1]);
});

test("the stand-down clears its record once everything it lit is off, issuing NO action that tick", () => {
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    REQUEST,
    // Nothing in the record is cycling any more -- ended on its own, or already
    // switched off over the last few ticks.
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], []) }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Standing by");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, []);
});

// --- RUNG ORDER: the tank goes up before the fleet is obeyed -------------------

test("with both a hurt tank and a live fleet target call, the tank goes up FIRST", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

test("once the rack is up and nothing is hurt, the rung falls through and the fleet order is obeyed on that same tick", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.phase, "Obeying fleet");
});

// --- the shipped default (empty module lists) is unaffected --------------------

test("a pilot with EMPTY module lists is completely unaffected -- the rung falls through every tick", () => {
  // The shipped default: DEFAULT_FLEET_COMPANION_REQUEST's four tank-up lists are
  // all empty. Even a fight on every layer at once must not touch this rung, or
  // the existing 96 tests -- none of which set a module list -- would break.
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({
      hostileOnGrid: true,
      targetedByPlayer: true,
      shieldRatio: 0.1,
      armorRatio: 0.1,
      hullRatio: 0.1,
      capacitorRatio: 0.1,
    }),
  );
  assert.notEqual(decision.phase, "Tanking up");
  assert.notEqual(decision.phase, "Standing down");
  assert.equal(decision.phase, "Standing by");
});

// --- the stand-down record states what is held ON right now --------------------

test("switching a repairer off -- for either reason -- drops it from the stand-down record", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [ARMOR_REPAIRER] };

  const recovered = decideCompanionAction(
    request,
    tankObs({ snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
    memory,
  );
  assert.equal(recovered.action.kind, "deactivate");
  assert.deepEqual(recovered.memory.lastTankUpModuleIDs, []);

  const capFloored = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      capacitorRatio: 0.1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
    memory,
  );
  assert.equal(capFloored.action.kind, "deactivate");
  assert.deepEqual(capFloored.memory.lastTankUpModuleIDs, []);
});

// --- the player-facing surface ----------------------------------------------

test("no player-facing string in this module carries a decorative non-ASCII character", () => {
  // ⚠ THIS SCANS THE SOURCE, NOT THE LADDER'S OUTPUT, ON PURPOSE. The panel
  // suite already has an ASCII check, but it renders against hand-written
  // fixture stores -- so it proves the FIXTURES are clean and never sees a
  // single `why` this ladder actually produces. Eight real strings slipped
  // past it that way, including the warp-yield line that fires on essentially
  // every fleet warp.
  //
  // Code COMMENTS are exempt and this file uses non-ASCII in them freely, so
  // they are stripped before the scan. Only string literals are judged.
  const source = readFileSync(new URL("./fleetCompanionLoop.ts", import.meta.url), "utf8");
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const code = source
    .replace(blockComment, "")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");

  // ⚠ TEMPLATE LITERALS ARE SCANNED TOO, AND THEY WERE NOT UNTIL PHASE 5.
  // This swept double-quoted literals only. That was complete when it was
  // written -- every `why` in the file was a plain string -- and phase 7's tag
  // messages were the first to interpolate, so they were the first player-facing
  // strings this guard could not see. They happened to be clean; the guard was
  // blind to them either way, and a rung that reports a drone count or a
  // hold-off has every reason to interpolate. Backticked strings are now swept
  // on the same terms. The `${...}` holes are blanked first: what a hole
  // interpolates is a value, judged where it is built, not text this file wrote.
  const doubleQuoted = new RegExp('"((?:[^"\\\\\\n]|\\\\.)*)"', "g");
  const backticked = new RegExp("`((?:[^`\\\\]|\\\\.)*)`", "g");
  const offenders: string[] = [];
  const judge = (value: string): void => {
    const withoutHoles = value.replace(/\$\{[^}]*\}/g, "");
    if ([...withoutHoles].some((character) => (character.codePointAt(0) ?? 0) > 127)) {
      offenders.push(withoutHoles);
    }
  };
  for (const match of code.matchAll(doubleQuoted)) {
    judge(match[1] ?? "");
  }
  for (const match of code.matchAll(backticked)) {
    judge(match[1] ?? "");
  }
  assert.deepEqual(
    offenders,
    [],
    "player-facing strings must be plain ASCII; an em-dash is the usual culprit",
  );
});

test("nothing this ladder says about a NOT-YET-LOCKED Target call claims the pilot is shooting", () => {
  // ⚠ LOCK, OBSERVE, THEN FIRE — see `lockThenEngage`'s own header. On the
  // tick that ISSUES the lock, nothing has fired yet no matter what this
  // pilot has fitted, so the readout must not claim otherwise. A weapon IS
  // fitted here on purpose — this pins the ordering, not merely the case
  // where there is nothing to fire in the first place.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.equal(decision.action.kind, "lock");
  const said = `${decision.why} ${decision.lastOrderHeard ?? ""}`;
  assert.doesNotMatch(said, /shoot|shooting|fir(e|ing)|attack/i, said);
});

// --- rung 4: tackle -> tag ---------------------------------------------------
//
// ABOVE obeying the fleet, because that rung PARKS the tick once a called
// target is locked and a standing FC primary is exactly the situation this
// pilot is scrambled in. Writes a LETTER, never a digit, so it can never
// collide with the DSL block that writes "1".
//
// ⚠ EVERY COMPANION TAGS NOW; THERE IS NO `attemptsTagging` CHECKBOX. The rung
// already only ever lettered ships that are tackling THIS pilot, which is
// exactly what was asked for, so the toggle gated behaviour that was already
// right. What keeps two companions from fighting over letters is not a setting:
// the server drops a non-commander's write (see the `canTag` tests below), and
// an already-lettered ship is skipped.

/** A request that tags -- which is now simply any request at all. */
const TAGGING: FleetCompanionRequest = REQUEST;

/** The commander verdict the gate produces for a real fleet boss. */
function taggingObs(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntities([TACKLE]),
    canTag: true,
    fleetTargetTags: new Map(),
    tackledBy: [TACKLE],
    ...overrides,
  });
}

test("a ship that has this pilot scrambled is lettered for the fleet", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs());
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "A",
  });
  assert.equal(decision.phase, "Tagging");
});

// ⚠ THE REPLACEMENT FOR THE OLD "attemptsTagging OFF writes no tag" TEST. There
// is no OFF any more, so what has to be pinned is the trigger instead: a pilot
// that is not being held down tags nothing, however many hostiles are on grid.
// "Only when they are tackled" was the operator's own wording.
test("a pilot that is NOT tackled writes no tag, however hostile the grid", () => {
  const decision = decideCompanionAction(REQUEST, taggingObs({ tackledBy: [] }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ THREE STATES. `null` is "could not read the roster", `false` is "read it,
// and this pilot is not a commander". Both forbid the write, and NEITHER is
// remembered: the server drops a non-commander's tag silently, so a client that
// cached a transient `null` as "no" would stop tagging for the rest of the run
// with nothing anywhere to say why.
test("canTag null and canTag false both write nothing", () => {
  for (const canTag of [null, false] as const) {
    const decision = decideCompanionAction(TAGGING, taggingObs({ canTag }));
    assert.notEqual(decision.action.kind, "setFleetTargetTag", String(canTag));
  }
});

test("a pilot nothing is holding writes nothing", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ tackledBy: [] }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ A tag is unique FLEET-WIDE: the server deletes any other item holding the
// same letter before it sets one. Writing without knowing which letters are
// taken would steal the FC's own mark.
test("an unreadable tag dict writes nothing, even for a commander that is tackled", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ fleetTargetTags: null }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// The other half of that contract: an EMPTY map is a real answer - "the fleet
// has tagged nothing" - and it is the commonest case at the start of a fight.
test("an EMPTY tag dict is a real answer and does write", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map() }),
  );
  assert.equal(decision.action.kind, "setFleetTargetTag");
});

test("a tackler that is not on this grid is not lettered", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: gridWithEntities([OTHER]), tackledBy: [TACKLE] }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// The rule that keeps the fleet's letters stable: a ship that is B stays B.
test("a tackler that already carries a tag is left alone", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[TACKLE, "B"]]) }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

test("the first FREE menu letter is used, skipping the ones the fleet already holds", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[OTHER, "A"], [LOGI, "B"]]) }),
  );
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "C",
  });
});

// ⚠ The server normalizes a tag by TRIMMING it and nothing else, so "a" and "A"
// are two keys to its uniqueness sweep and one letter to every human reading
// the overview. Writing "A" over somebody's "a" would steal their ship.
test("a lower-case tag already in use still blocks its letter", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[OTHER, " a "]]) }),
  );
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "B",
  });
});

// ⚠ NEVER A DIGIT. The stock menu offers 0-9 as well, and the DSL's own
// fleet-tag-target block writes "1". Staying on letters is what stops a squad
// running both from fighting over one tag.
test("every letter taken writes nothing rather than stealing one", () => {
  const taken = new Map<number, string>();
  for (const [index, letter] of [..."ABCDEFGHIJXYZ"].entries()) {
    taken.set(500000 + index, letter);
  }
  const decision = decideCompanionAction(TAGGING, taggingObs({ fleetTargetTags: taken }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ THE PLAYER-TACKLER CASE, AND THE WHOLE REASON THIS RUNG DOES NOT FILTER
// THROUGH `hostileRows`. That helper is `isHostile`, which is NPC-or-not, so a
// player holding this ship fails it - and a fleet fight against players is
// precisely what this feature is for. gridWithEntities builds plain ships with
// no `isNpc` flag at all, which is the shape a player row has.
test("a PLAYER tackler is lettered, not silently skipped for not being an NPC", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs());
  assert.equal(decision.action.kind, "setFleetTargetTag");
});

test("with two tacklers the nearer is lettered first, then the other", () => {
  // gridWithEntities puts the first id closest.
  const first = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: gridWithEntities([TACKLE, OTHER]), tackledBy: [OTHER, TACKLE] }),
  );
  assert.deepEqual(first.action, { kind: "setFleetTargetTag", targetID: TACKLE, tag: "A" });

  // Once the first one carries its letter, the next tick moves to the other.
  const second = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      tackledBy: [OTHER, TACKLE],
      fleetTargetTags: new Map([[TACKLE, "A"]]),
    }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "setFleetTargetTag", targetID: OTHER, tag: "B" });
});

// ⚠ THE WRITE'S OWN ACK IS WORTHLESS - the server refuses a non-commander with
// a bare false that its only caller discards - so the rung resends while it
// waits for the letter to appear, and STOPS after a bounded number of tries.
test("an unconfirmed tag is retried, then given up on", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const writes: number[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = decideCompanionAction(TAGGING, taggingObs(), memory);
    memory = decision.memory;
    if (decision.action.kind === "setFleetTargetTag") {
      writes.push(decision.action.targetID);
    }
  }
  assert.equal(writes.length, 3, "three attempts, then it stops resending for ever");
});

// ⚠ GIVE-UP IS REMEMBERED PER SHIP, and this is why the rung threads its memory
// back on a tick that issues NOTHING. A single "stop tagging" flag would work
// here and fail the moment a second tackler arrived.
test("giving up on one ship does not stop the next tackler being lettered", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const grid = gridWithEntities([TACKLE, OTHER]);
  // Burn the budget on TACKLE alone.
  for (let tick = 0; tick < 4; tick += 1) {
    memory = decideCompanionAction(
      TAGGING,
      taggingObs({ snapshot: grid, tackledBy: [TACKLE] }),
      memory,
    ).memory;
  }
  // Now a second ship joins in. It must still get a letter.
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: grid, tackledBy: [TACKLE, OTHER] }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "setFleetTargetTag", targetID: OTHER, tag: "A" });
});

// ⚠ PLACEMENT. decideFleetOrders parks the tick once a called target is locked,
// so a tag rung beneath it would be starved in every fight that has a primary
// called - which is every fight this rung exists for.
test("a standing fleet tag order does not starve the tackle rung", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([LOGI, TACKLE]),
      // The FC has already called LOGI, so rung 7 has work and would park.
      fleetTargetTags: new Map([[LOGI, "A"]]),
      lockedTargetIDs: [LOGI],
      tackledBy: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "setFleetTargetTag", targetID: TACKLE, tag: "B" });
});

// ...and the cost of that placement is bounded: once there is nothing left to
// tag, the very next tick obeys the fleet again.
test("with nothing left to tag the pilot goes back to obeying the fleet", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([LOGI, TACKLE]),
      fleetTargetTags: new Map([[LOGI, "A"], [TACKLE, "B"]]),
      tackledBy: [TACKLE],
    }),
  );
  assert.equal(decision.phase, "Obeying fleet");
});

// Rung 1 outranks everything, this rung included.
test("nothing is tagged mid-warp", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ inWarp: true }));
  assert.deepEqual(decision.action, { kind: "wait" });
});

// Rung 2 too: an unsupervised pilot is getting safe, not fighting.
test("an unsupervised pilot tags nothing", () => {
  const decision = decideCompanionAction(
    TAGGING,
    alone({
      snapshot: gridWithEntities([TACKLE]),
      canTag: true,
      fleetTargetTags: new Map(),
      tackledBy: [TACKLE],
    }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// --- rung 4's other arm: tackle -> BROADCAST ---------------------------------
//
// THE ARM THAT ACTUALLY RUNS. A companion alt joins somebody else's fleet as a
// plain member and is never promoted, so `canTag` is `false` for essentially
// every real run -- and the rung used to stop dead there, which meant the whole
// "letter what has you tackled" feature described something that never fired.
//
// It fires now, the way EVE lets a member fire it: `Target`, broadcast. The
// server has NO commander gate on broadcasting (`sendBroadcast`,
// fleetRuntime.js:2521, checks membership and nothing else) where it has a hard
// one on tagging (fleetRuntime.js:1317). Lettering is a commander's job and
// calling a target out is everybody's, which is the division these two arms
// mirror rather than invent.

/** A PLAIN MEMBER that is tackled: in a fleet, no command, nothing lettered. */
function memberObs(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntities([TACKLE]),
    canTag: false,
    canBroadcast: true,
    fleetTargetTags: new Map(),
    tackledBy: [TACKLE],
    ...overrides,
  });
}

test("a plain member broadcasts the ship that has it scrambled", () => {
  const decision = decideCompanionAction(TAGGING, memberObs());
  assert.deepEqual(decision.action, { kind: "broadcastFleetTarget", targetID: TACKLE });
  assert.equal(decision.phase, "Tagging");
});

// ⚠ THE READOUT MUST NAME THE CALL IT MADE. "Marking it for the fleet" over a
// broadcast would hide the one thing a player needs to know about this pilot:
// that its calls arrive in the broadcast window and not on the overview.
test("the reason says it BROADCAST, never that it marked or lettered", () => {
  const why = decideCompanionAction(TAGGING, memberObs()).why ?? "";
  assert.match(why, /broadcast/i);
  assert.doesNotMatch(why, /marking|letter|tag/i);
});

// ⚠ `canTag === false` ANSWERS TWO QUESTIONS AND ONLY ONE OF THEM HAS A
// FALLBACK. `canTagInFleet` returns false both for "in a fleet, not a commander"
// and for "in no fleet at all", and a pilot in no fleet has nobody to broadcast
// to. Deriving the second from the first is impossible, which is why
// `canBroadcast` is asked separately -- and why a host that does not populate it
// gets silence rather than a guess.
test("a pilot in no fleet broadcasts nothing", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ canBroadcast: false }));
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

test("an unpopulated canBroadcast is unknown, and unknown stays quiet", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ canBroadcast: undefined }));
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

// ⚠ `null` IS NOT THE BROADCAST ARM'S DOOR. An unreadable roster is not
// evidence this pilot lacks command; sending it down the fallback would make a
// transient read failure change how the pilot talks to its fleet.
test("an unreadable roster makes neither call", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ canTag: null }));
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ THE ONE PLACE THE TWO ARMS DISAGREE ABOUT THE TAG DICT, and it is not an
// oversight. The letter arm cannot write without knowing which letters are free
// (a tag is unique fleet-wide). A broadcast claims no letter, so an unreadable
// dict is no reason to stay quiet about being tackled.
test("an unreadable tag dict stops a letter but NOT a broadcast", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ fleetTargetTags: null }));
  assert.deepEqual(decision.action, { kind: "broadcastFleetTarget", targetID: TACKLE });
});

// ⚠ A LETTERED SHIP IS ALREADY CALLED. Broadcasting it as well would put a
// second call on a target the fleet is already pointed at -- and because every
// companion obeys the NEWEST target call, it would shove the commander's own
// standing primary aside for nothing.
test("a tackler the commander has already lettered is not broadcast", () => {
  const decision = decideCompanionAction(
    TAGGING,
    memberObs({ fleetTargetTags: new Map([[TACKLE, "B"]]) }),
  );
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

// ⚠ ONCE PER SHIP, AND THIS IS WHAT STOPS TWO COMPANIONS SHOUTING AT EACH
// OTHER. A broadcast leaves nothing behind to re-read, so a second send could
// learn nothing a first did not -- it would just be the same shout every two
// seconds for as long as the ship held this pilot. And since a `Target`
// broadcast is an ORDER to every companion that hears it, two pilots tackled by
// one ship would re-call it in turn without a per-ship memory.
test("one broadcast per ship, however long it keeps this pilot tackled", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const calls: number[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = decideCompanionAction(TAGGING, memberObs(), memory);
    memory = decision.memory;
    if (decision.action.kind === "broadcastFleetTarget") {
      calls.push(decision.action.targetID);
    }
  }
  assert.deepEqual(calls, [TACKLE], "called once, then silent about that ship");
});

// ⚠ PER SHIP, NOT A SINGLE "ALREADY CALLED" FLAG -- the same reasoning that
// makes the letter arm's give-up list per-ship. A flag would pass the test above
// and fail the moment a second ship joined in.
test("having called one tackler does not silence the next", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const grid = gridWithEntities([TACKLE, OTHER]);
  memory = decideCompanionAction(
    TAGGING,
    memberObs({ snapshot: grid, tackledBy: [TACKLE] }),
    memory,
  ).memory;
  const decision = decideCompanionAction(
    TAGGING,
    memberObs({ snapshot: grid, tackledBy: [TACKLE, OTHER] }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "broadcastFleetTarget", targetID: OTHER });
});

// The trigger is the same narrow one the letter arm has: ships holding THIS
// pilot down, never a ranking of the grid.
test("a plain member that is not tackled broadcasts nothing, however hostile the grid", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ tackledBy: [] }));
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

test("a tackler that is not on this grid is not broadcast", () => {
  const decision = decideCompanionAction(
    TAGGING,
    memberObs({ snapshot: gridWithEntities([OTHER]), tackledBy: [TACKLE] }),
  );
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

// Rungs 1 and 2 outrank this arm exactly as they outrank the letter arm.
test("nothing is broadcast mid-warp", () => {
  const decision = decideCompanionAction(TAGGING, memberObs({ inWarp: true }));
  assert.deepEqual(decision.action, { kind: "wait" });
});

test("an unsupervised pilot broadcasts nothing", () => {
  const decision = decideCompanionAction(
    TAGGING,
    alone({
      snapshot: gridWithEntities([TACKLE]),
      canTag: false,
      canBroadcast: true,
      fleetTargetTags: new Map(),
      tackledBy: [TACKLE],
    }),
  );
  assert.notEqual(decision.action.kind, "broadcastFleetTarget");
});

// --- the parking fix: a standing order no longer ends the tick ---------------
//
// `lockThenEngage`'s last branch used to return an ordinary wait once the called
// target was locked and the guns were running. That ended the ladder, so while a
// target call stood every rung BELOW the fleet-order rung was starved - which is
// exactly when they most want a turn. A pilot obeying a target call would never
// have fled.
//
// It now hands back a `standing` decision instead: the ladder holds it aside,
// runs everything beneath it, and falls back to it only if nothing else acted.
//
// ⚠ THE FULL PROOF OF THIS ARRIVES WITH PHASE 6. Its flee is the first rung to
// sit BENEATH the fleet-order rung, and the test that matters - "a pilot obeying
// a standing target call still flees when it drops through its floor" - can only
// be written once that rung exists. What is provable here is the mechanism: the
// decision is marked standing, the readout survives, and the ladder reaches its
// own end rather than returning from the middle.

/** A pilot with a gun fitted, which is what makes the standing case reachable. */
const ENGAGING: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };

/** A pilot locked onto, and shooting, the target the fleet called. */
function standingEngagement(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1]),
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
    ...overrides,
  });
}

/**
 * The tick AFTER the rack is running. A snapshot says a gun is cycling and
 * never says what it is cycling AT, so the first tick still has a weapon to
 * start and only the next one has nothing left to issue -- which is the tick
 * the standing case is about.
 */
function afterTheGunsAreUp(): CompanionDecision {
  const first = decideCompanionAction(ENGAGING, standingEngagement());
  assert.equal(first.action.kind, "activate", "the first tick starts the gun");
  return decideCompanionAction(ENGAGING, standingEngagement(), first.memory);
}

test("a standing, already-engaged target call is marked standing rather than parking", () => {
  const decision = afterTheGunsAreUp();
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.equal(
    decision.standing,
    true,
    "the fleet rung has nothing new to issue, so its decision must be held aside, not returned outright",
  );
});

// ⚠ THE READOUT IS WHY IT WAS PARKED IN THE FIRST PLACE, so losing it would be
// trading one bug for another. A pilot whose guns are running must not tell its
// operator it is standing by.
test("the standing readout survives the fall-through and still says Obeying fleet", () => {
  const decision = afterTheGunsAreUp();
  assert.equal(decision.phase, "Obeying fleet");
  assert.notEqual(decision.phase, "Standing by");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.ok(decision.lastOrderHeard);
  assert.match(decision.why, /firing/i);
});

// ⚠ A STANDING DECISION IS A READOUT AND NOTHING ELSE. If one ever carried a
// real call, holding it aside and then falling back to it a rung later would
// issue it late - or, if a lower rung acted, drop it silently.
test("nothing that is marked standing carries a real action", () => {
  for (const observation of [
    standingEngagement(),
    standingEngagement({ fleetTargetTags: null, fleetBroadcast: fleetBroadcast("Target", TACKLE) }),
  ]) {
    const decision = decideCompanionAction(ENGAGING, observation);
    if (decision.standing === true) {
      assert.deepEqual(decision.action, { kind: "wait" });
    }
  }
});

// The other half: a rung that DOES have something to issue still wins outright,
// which is what the decided precedence says and what must not regress.
test("a fleet order with a real call to make still beats everything beneath it", () => {
  const decision = decideCompanionAction(
    ENGAGING,
    standingEngagement({ lockedTargetIDs: [] }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.notEqual(decision.standing, true, "a real call is never merely standing");
});

// --- rung 5: flee ------------------------------------------------------------
//
// Above the drone rung and above the fleet rung; below tank-up and tackle-tag.
// See `decideFlee`'s own header for the operator decision that put it above the
// fleet rung, and for what that placement buys over the written precedence.

/** The system a fleeing pilot is remembering, so a later return has a name for it. */
const HOME_SYSTEM = 30000142;

/** A hurt ship on a grid with a station to run to. */
function fleeObs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({
    health: 0.1,
    snapshot: gridWithStation(200_000),
    flightStatus: { solarSystemID: HOME_SYSTEM } as FleetCompanionObservation["flightStatus"],
    ...overrides,
  });
}

test("a ship below its floor warps to the nearest station", () => {
  const decision = decideCompanionAction(REQUEST, fleeObs());
  assert.deepEqual(decision.action, { kind: "warp", targetID: 60000001 });
  assert.equal(decision.phase, "Getting clear");
});

test("a ship ABOVE its floor does not flee, and the rung falls through", () => {
  const decision = decideCompanionAction(REQUEST, fleeObs({ health: 0.9 }));
  assert.notEqual(decision.phase, "Getting clear");
});

// The threshold is the OPERATOR's, not a constant. A pilot set to leave at 80%
// must leave at 50%, and a default-configured one beside it must not.
test("the floor that decides is the request's own", () => {
  const jumpy: FleetCompanionRequest = { ...REQUEST, fleeHealthFloor: 0.8 };
  assert.equal(decideCompanionAction(jumpy, fleeObs({ health: 0.5 })).phase, "Getting clear");
  assert.notEqual(decideCompanionAction(REQUEST, fleeObs({ health: 0.5 })).phase, "Getting clear");
});

// --- which layers a flee is judged on -----------------------------------------
//
// ⚠ DAMAGE EATS SHIELD, THEN ARMOUR, THEN HULL, WHATEVER THE FIT. So an armour
// tank's shield is not its tank: it is the thing that empties in the first
// seconds of every fight. Folding all three layers made such a ship run for the
// door before its repairer had cycled once -- reported live, 2026-09-13, "they
// run away when shield is down instead of turning on armor repair and waiting
// for armor going below threshold". What the ship can REPAIR is what it is
// tanked in, and that is read off the hull at start.

/** A hull with an armour repairer and no booster: shield is buffer, not tank. */
const ARMOUR_TANKED: FleetCompanionRequest = {
  ...REQUEST,
  armorRepairerModuleIDs: [ARMOR_REPAIRER],
};

/** A hull that repairs its own shield: the shield IS the tank. */
const SHIELD_TANKED: FleetCompanionRequest = {
  ...REQUEST,
  shieldBoosterModuleIDs: [SHIELD_BOOSTER],
};

test("an armour-tanked ship does not run away over an empty shield", () => {
  const decision = decideCompanionAction(
    ARMOUR_TANKED,
    fleeObs({ health: 0.05, shieldRatio: 0.05, armorRatio: 1, hullRatio: 1 }),
  );
  assert.notEqual(decision.phase, "Getting clear");
  assert.equal(decision.memory.flee, null);
});

// ⚠ THE REPAIRER COMES FIRST, AND THAT IS THE ASKED-FOR ORDER. Rung 3 sits
// above the flee, so the first tick of a hurt layer switches its own repairer
// on ("turning on armor repair") and the door is only reached once that is
// already cycling and the layer is still going.
test("the hurt layer's own repairer is reached for before the door is", () => {
  const decision = decideCompanionAction(
    ARMOUR_TANKED,
    fleeObs({ health: 0.05, shieldRatio: 0.05, armorRatio: 0.2, hullRatio: 1 }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

/** The same grid, with one of this ship's own modules already cycling. */
function fleeObsCycling(
  moduleID: number,
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  const grid = gridWithStation(200_000);
  return fleeObs({
    snapshot: { ...grid, ship: { ...grid.ship, activeModuleIDs: [moduleID] } },
    ...overrides,
  } as Partial<FleetCompanionObservation>);
}

test("and it leaves when the layer it actually tanks with drops", () => {
  const decision = decideCompanionAction(
    ARMOUR_TANKED,
    fleeObsCycling(ARMOR_REPAIRER, {
      health: 0.05,
      shieldRatio: 0.05,
      armorRatio: 0.2,
      hullRatio: 1,
    }),
  );
  assert.equal(decision.phase, "Getting clear");
});

// The other half: a shield tank's shield is its health, and ignoring it would
// be the same mistake in the opposite direction.
test("a shield-tanked ship still leaves on its shield", () => {
  const decision = decideCompanionAction(
    SHIELD_TANKED,
    fleeObsCycling(SHIELD_BOOSTER, {
      health: 0.1,
      shieldRatio: 0.1,
      armorRatio: 1,
      hullRatio: 1,
    }),
  );
  assert.equal(decision.phase, "Getting clear");
});

// A fit that voted for NEITHER layer says nothing about where its hitpoints
// are, so the worst layer stays the honest answer.
test("a hull that said nothing about its tank keeps the worst-layer fold", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.05, shieldRatio: 0.05, armorRatio: 1, hullRatio: 1 }),
  );
  assert.equal(decision.phase, "Getting clear");
});

// --- the buffer fit, which cycles nothing and had nothing to say -------------
//
// A brick's plates and extenders are PASSIVE, so they never reach a list this
// loop can activate. `tankLayer` is voted off the hull's group names at start
// (bots/tankLayer.ts) and is the only thing such a fit has to say.

/** A plated brick: no repairer to cycle, and a fit that says so. */
const ARMOUR_BRICK: FleetCompanionRequest = { ...REQUEST, tankLayer: "armor" };

/** An extender brick. */
const SHIELD_BRICK: FleetCompanionRequest = { ...REQUEST, tankLayer: "shield" };

test("a plated brick does not run away over an empty shield either", () => {
  const decision = decideCompanionAction(
    ARMOUR_BRICK,
    fleeObs({ health: 0.05, shieldRatio: 0.05, armorRatio: 1, hullRatio: 1 }),
  );
  assert.notEqual(decision.phase, "Getting clear");
  assert.equal(decision.memory.flee, null);
});

test("and it leaves when its armour goes", () => {
  const decision = decideCompanionAction(
    ARMOUR_BRICK,
    fleeObs({ health: 0.05, shieldRatio: 0.05, armorRatio: 0.2, hullRatio: 1 }),
  );
  assert.equal(decision.phase, "Getting clear");
});

test("an extender brick still leaves on its shield", () => {
  const decision = decideCompanionAction(
    SHIELD_BRICK,
    fleeObs({ health: 0.1, shieldRatio: 0.1, armorRatio: 1, hullRatio: 1 }),
  );
  assert.equal(decision.phase, "Getting clear");
});

// ⚠ A FITTED REPAIRER OUTRANKS THE VOTE, and a hull that carries both is where
// that matters: a shield-boosted ship with a plate in the lows is shield-tanked,
// because the thing it can switch on is the plainer statement by far.
test("what the ship can cycle beats what it is built of", () => {
  const boostedAndPlated: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    tankLayer: "armor",
  };
  const decision = decideCompanionAction(
    boostedAndPlated,
    fleeObsCycling(SHIELD_BOOSTER, {
      health: 0.1,
      shieldRatio: 0.1,
      armorRatio: 1,
      hullRatio: 1,
    }),
  );
  assert.equal(decision.phase, "Getting clear");
});

// The way back is judged on the same layers, or a brick would wait at a safe
// spot for a shield that is empty by design.
test("a plated brick comes back once its ARMOUR is whole, whatever its shield says", () => {
  const decision = decideCompanionAction(
    ARMOUR_BRICK,
    fleeObs({
      health: 0.05,
      shieldRatio: 0.05,
      armorRatio: 1,
      hullRatio: 1,
      docked: false,
      // Somewhere else, so the return has a leg to fly and this asserts a move
      // rather than the absence of one.
      flightStatus: { solarSystemID: 30000144 } as FleetCompanionObservation["flightStatus"],
    }),
    fleeing({ safeSpotWarpIssued: true, safeSpotWarpSeen: true }),
  );
  assert.deepEqual(decision.action, { kind: "travelTo", systemID: HOME_SYSTEM });
  assert.equal(decision.phase, "Going back");
});

// Null is not "healthy" and it is not "dying" -- the same three-state discipline
// the tank-up rung keeps about a layer ratio. Fleeing on a dropped poll would
// abandon a fleet over a read that merely failed.
test("an UNREADABLE health never starts a flee", () => {
  const decision = decideCompanionAction(REQUEST, fleeObs({ health: null }));
  assert.notEqual(decision.phase, "Getting clear");
  assert.deepEqual(decision.action, { kind: "wait" });
});

// --- THE ACCEPTANCE TEST FOR THIS PHASE ---------------------------------------
//
// The handover nominated "a pilot obeying a standing target call still flees
// when it drops through its floor". It is written below, and it is worth having
// -- but it is NOT what proves this phase, and that was established by moving
// the rung rather than by reasoning about it.
//
// ⚠ ONLY THE MID-LOCK TEST DISCRIMINATES. With the flee rung moved beneath the
// fleet rung -- where the written precedence put it -- the standing test still
// passes, because phase 5's parking fix already holds a standing decision aside
// and lets the rungs below it run. The case that FAILS there, and the only one,
// is a pilot with a fresh primary still to lock: the fleet rung has a real call
// to issue, a real call wins outright, and the hurt pilot locks instead of
// leaving. That is the case the operator's ordering was chosen for, so that is
// the acceptance test for this phase.
//
// Both are kept. The standing one documents that the combination works; the
// mid-lock one is the one that would catch someone moving the rung back.
//
// ⚠ THE GRID MUST CARRY BOTH THE STATION AND THE CALLED SHIP, and the first
// draft of these tests did not. `fleeObs`'s default grid has a station and
// nothing else, so `bestTaggedEntity` found nothing on it and the fleet rung
// fell through of its own accord -- the tests passed with the flee rung moved
// BELOW the fleet rung, which is the very thing they exist to forbid. An
// off-grid call is not an order for this pilot at all (see `decideFleetOrders`),
// so a test about precedence has to put the called ship where the pilot can see
// it or it is testing nothing.
function fleeGridWithCalledShip(gunsUp = false): SpaceSnapshot {
  return {
    inSpace: true,
    ship: {
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
      activeModuleIDs: gunsUp ? [GUN_1] : [],
      weaponBanks: {},
    },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: TACKLE, kind: "ship", isSelf: false, position: { x: 10_000, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: 60000001, kind: "station", isSelf: false, position: { x: 200_000, y: 0, z: 0 }, radius: 0, mode: null },
    ],
  } as unknown as SpaceSnapshot;
}

test("a pilot obeying a STANDING target call still flees when it drops through its floor", () => {
  const engaging: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  // ⚠ GENUINELY STANDING, which takes a seeded memory to reach. The target is
  // locked AND the gun is cycling AND this loop is the one that aimed it, so
  // `decideOpenFire` has nothing left to start and the fleet rung hands back a
  // readout rather than a call. Without the seed the rung still has an
  // `activate` to issue and this would be the mid-engagement case below, under
  // a name that claims more than it tests.
  const standing: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1],
  };
  const decision = decideCompanionAction(
    engaging,
    fleeObs({
      snapshot: fleeGridWithCalledShip(true),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
    standing,
  );
  assert.equal(decision.phase, "Getting clear");
});

// The seed above is only honest if it really does produce a standing decision.
// This pins that: the same memory and grid on a HEALTHY pilot must fall all the
// way through the ladder and come back marked standing.
test("the seeded engagement really is standing, not merely mid-engagement", () => {
  const engaging: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    engaging,
    fleeObs({
      health: 0.9,
      snapshot: fleeGridWithCalledShip(true),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
    { ...freshLadderMemory(), lastFireTargetID: TACKLE, lastFireModuleIDs: [GUN_1] },
  );
  assert.equal(decision.standing, true);
  assert.equal(decision.phase, "Obeying fleet");
});

test("a pilot MID-LOCK on a fresh primary still flees", () => {
  // This is the case the ordering was chosen for. Nothing is locked yet, so the
  // fleet rung has a real `lock` to issue -- and under the written precedence it
  // would have won outright, then one activate per weapon after it: seven ticks
  // on a six-gun ship before anything beneath it got a turn.
  const engaging: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    engaging,
    fleeObs({
      snapshot: fleeGridWithCalledShip(),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [],
    }),
  );
  assert.notEqual(decision.action.kind, "lock", "a lock must not outrank leaving");
  assert.equal(decision.phase, "Getting clear");
});

// The other side of the same coin: a HEALTHY pilot on that identical grid must
// still obey the call. Without this, "flees" could be passing because the fleet
// rung is broken rather than because it was outranked.
test("the same pilot, unhurt, obeys the call on the same grid", () => {
  const engaging: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    engaging,
    fleeObs({
      health: 0.9,
      snapshot: fleeGridWithCalledShip(),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.phase, "Obeying fleet");
});

// --- what stays ABOVE the flee ------------------------------------------------

test("rung 1 still outranks the flee: nothing is decided mid-warp", () => {
  const decision = decideCompanionAction(REQUEST, fleeObs({ inWarp: true }));
  assert.equal(decision.phase, "In warp");
  assert.deepEqual(decision.action, { kind: "wait" });
});

// A ship running away must keep hardening. The phase 6 spec asked for tank-up to
// be "nested inside the flee continuation"; sitting ABOVE it is the same result
// with no nesting, and this is the test that says so.
test("a fleeing ship still lights an idle hardener first", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    request,
    fleeObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], []) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

// --- the drones come home, and do not go back out -----------------------------

test("a flee recalls what is in space before it warps", () => {
  const request: FleetCompanionRequest = REQUEST;
  const decision = decideCompanionAction(request, fleeObs({ myDroneIDs: [DRONE_A] }));
  assert.deepEqual(decision.action, { kind: "recallDrones", droneIDs: [DRONE_A] });
});

// "Flee outranks drone redeploy", enforced at RUNTIME as the spec asked and not
// merely by where the rung happens to be written. A redeploy record left
// standing would have rung 6 putting drones back out of a ship that is leaving.
test("latching a flee drops any drone redeploy cycle in flight", () => {
  const request: FleetCompanionRequest = REQUEST;
  const mid: CompanionLadderMemory = {
    ...freshLadderMemory(),
    droneCycle: { stage: "holding-off", recalledIDs: [DRONE_A], stageSinceMs: 0 },
  };
  const decision = decideCompanionAction(request, fleeObs(), mid);
  assert.equal(decision.memory.droneCycle, null, "a live redeploy must not survive a flee latching");
});

// --- nowhere to go ------------------------------------------------------------
//
// NOT a stop, unlike rung 2's answer to the very same grid: a hurt pilot still
// has guns, and a fleet that has a use for them.

test("no station and no safe spot does not stop the run, and does not spend a trip", () => {
  const decision = decideCompanionAction(REQUEST, fleeObs({ snapshot: gridWithStation(null) }));
  assert.equal(decision.stop, undefined, "being hurt with nowhere to go must not end the run");
  assert.equal(decision.phase, "Standing by");
  assert.equal(
    decision.memory.fleeTripsSpent,
    0,
    "a flee that never moved the ship must not cost the operator a round trip",
  );
  assert.equal(decision.memory.flee, null, "and it must not leave a latch nothing can clear");
});

// --- the budget ---------------------------------------------------------------

test("a flee spends one round trip, once, not once per tick", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  for (let tick = 0; tick < 4; tick += 1) {
    memory = decideCompanionAction(REQUEST, fleeObs(), memory).memory;
  }
  assert.equal(memory.fleeTripsSpent, 1);
});

test("a pilot that has spent its round trips stays home", () => {
  const spent: CompanionLadderMemory = {
    ...freshLadderMemory(),
    fleeTripsSpent: REQUEST.maxFleeAttempts,
  };
  const decision = decideCompanionAction(REQUEST, fleeObs(), spent);
  assert.notEqual(decision.phase, "Getting clear");
  assert.equal(decision.memory.flee, null);
});

// --- arriving -----------------------------------------------------------------

/** A flee already latched, mid-trip, with whatever overrides a test needs. */
function fleeing(overrides: Partial<CompanionFlee> = {}): CompanionLadderMemory {
  return {
    ...freshLadderMemory(),
    fleeTripsSpent: 1,
    flee: {
      triggeredAtMs: 1,
      triggeredAtHealth: 0.12,
      fromSolarSystemID: HOME_SYSTEM,
      repairAttempts: 0,
      // The cautious stamp by default: this flee cannot vouch for the armour,
      // so a station has to be asked about it. The tests that want the common
      // case -- a shield-tanked pilot whose other two layers never dropped --
      // say so explicitly.
      onlyTheShieldWasHurt: false,
      arrivedSafe: false,
      safeSpotWarpIssued: false,
      safeSpotWarpAttempts: 0,
      safeSpotWarpWaited: 0,
      safeSpotWarpSeen: false,
      droneRecallWaited: null,
      ...overrides,
    },
  };
}

test("a docked pilot holds, and says what it left at", () => {
  const decision = decideCompanionAction(
    REQUEST,
    // With damage the shop has named: a pilot holding in a station for a reason
    // is the one whose readout has to carry that reason.
    fleeObs({ docked: true, inSpace: false, damagedItemIDs: [900001] }),
    fleeing(),
  );
  assert.equal(decision.phase, "Safe");
  assert.match(decision.why, /12%/);
});

// The mid-warp tick is the ONLY one that can see a safe-spot warp happen, and
// before this phase it recorded the abandonment's latch and not the flee's.
test("a mid-warp tick records the flee's safe-spot warp, not just the abandonment's", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ inWarp: true }),
    fleeing({ safeSpotWarpIssued: true }),
  );
  assert.equal(decision.memory.flee?.safeSpotWarpSeen, true);
});

/** Synthetic item ids for the repair shop's quote. */
const SHIP_ITEM = 900001;
const RIG_ITEM = 900002;

// --- rung 5: getting whole, and going back ------------------------------------
//
// ⚠ DOCKING IS NOT A REPAIR. `topOffShipShieldAndCapacitorForDockingTransition`
// (space/transitions.js:242) sets charge and shieldCharge to 1 and leaves
// `damage` and `armorDamage` alone, so a shield flee is whole on arrival and an
// armour flee is not. Everything below is shaped around that one server fact.

/**
 * Docked at the station a flee ended at.
 *
 * ⚠ `health: null`, ALWAYS, AND THAT IS THE POINT OF THIS WHOLE SECTION. There
 * is no health read in a station: `obs.health` is folded from the SPACE
 * snapshot, and a docked ship has none. These fixtures used to hand the ladder
 * a docked health anyway -- `dockedAfterFleeing(1)` for "whole",
 * `dockedAfterFleeing(0.4)` for "hurt in the armour" -- which is a reading the
 * live loop can never get, and it is exactly why the stranded-pilot bug of
 * 2026-09-13 passed every test in here. A station answers two questions
 * instead: the flee's own stamp, and the shop's quote.
 */
function dockedAfterFleeing(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return fleeObs({ docked: true, inSpace: false, health: null, ...overrides });
}

/** The flee a shield-tanked pilot latches: armour and hull never dropped. */
const SHIELD_ONLY = { onlyTheShieldWasHurt: true } as const;

// THE REGRESSION, IN ONE TEST. Docking gives the shield back in full, so a
// shield-only flee is whole the moment it arrives -- with no health read, no
// quote, and no wallet.
test("a station reports no health at all, and a shield-only flee still goes home", () => {
  const decision = decideCompanionAction(REQUEST, dockedAfterFleeing(), fleeing(SHIELD_ONLY));
  assert.deepEqual(decision.action, { kind: "undock" });
  assert.equal(decision.phase, "Going back");
});

// ⚠ THE MARGIN, NOT THE FLOOR. Coming back at exactly the number that sends it
// running means the next tick reads the same number and leaves again: one fight
// would eat the whole budget without a shot fired. Asked at a SAFE SPOT, which
// is where a live health read is the authority.
test("a pilot only just above its floor stays put rather than commuting", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ health: REQUEST.fleeHealthFloor + 0.01, docked: false }),
    fleeing({ safeSpotWarpIssued: true, safeSpotWarpSeen: true }),
  );
  assert.notEqual(decision.action.kind, "undock");
  assert.equal(decision.phase, "Safe");
  assert.match(decision.why, /waiting out here/i);
});

test("an UNREADABLE health out at a safe spot never goes back", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ health: null, docked: false }),
    fleeing({ safeSpotWarpIssued: true, safeSpotWarpSeen: true }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.equal(decision.phase, "Safe");
});

// --- the armour case, which is the whole reason the opt-in exists -------------

test("without the opt-in, a pilot hurt in the armour says why it is staying", () => {
  const decision = decideCompanionAction(
    REQUEST,
    dockedAfterFleeing({ damagedItemIDs: [SHIP_ITEM] }),
    fleeing(),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.match(decision.why, /not set to pay for repairs/i);
  assert.notEqual(decision.action.kind, "undock");
});

// ⚠ AND IT SAYS IT ONLY OVER DAMAGE THE SHOP HAS NAMED. The wallet used to be
// consulted before the quote was, so a whole ship in a station was told it was
// staying put because nobody would pay to fix it.
test("a pilot that does not pay for repairs still waits for the quote before blaming it", () => {
  const decision = decideCompanionAction(
    REQUEST,
    dockedAfterFleeing({ damagedItemIDs: null }),
    fleeing(),
  );
  assert.match(decision.why, /quote/i);
});

// THE HAND-REPAIRED CASE, REPORTED LIVE THE SAME DAY: the operator fixed the
// armour themselves, so no companion ever spent a coin — and the pilot has to
// notice. It notices the only way a docked ship can: the shop has nothing left
// to quote for.
test("a pilot repaired BY HAND goes home, with no opt-in and nothing paid", () => {
  const decision = decideCompanionAction(
    REQUEST,
    dockedAfterFleeing({ damagedItemIDs: [] }),
    fleeing(),
  );
  assert.deepEqual(decision.action, { kind: "undock" });
  assert.equal(decision.phase, "Going back");
});

test("with the opt-in, it pays the shop for exactly what the quote named", () => {
  const paying: FleetCompanionRequest = { ...REQUEST, repairsAtStation: true };
  const decision = decideCompanionAction(
    paying,
    dockedAfterFleeing({ damagedItemIDs: [SHIP_ITEM, RIG_ITEM] }),
    fleeing(),
  );
  assert.deepEqual(decision.action, { kind: "repairItems", itemIDs: [SHIP_ITEM, RIG_ITEM] });
  assert.equal(decision.phase, "Repairing");
});

// THE OTHER HALF OF THE SAME BUG. The repair lands, the quote empties -- and the
// return was still gated on a health read the station cannot produce, so a pilot
// that had just been paid for stayed docked as surely as one that had not.
test("a paid-for pilot undocks once the shop's quote comes back empty", () => {
  const paying: FleetCompanionRequest = { ...REQUEST, repairsAtStation: true };
  const decision = decideCompanionAction(
    paying,
    dockedAfterFleeing({ damagedItemIDs: [] }),
    fleeing({ repairAttempts: 1 }),
  );
  assert.deepEqual(decision.action, { kind: "undock" });
  assert.equal(decision.phase, "Going back");
});

// Null is "could not say", never "nothing is damaged" -- the same contract the
// DSL's repair-ship read keeps. A tick spent waiting for the quote, not a
// conclusion that the ship is fine.
test("an unquoted shop is waited on, not read as nothing-to-fix", () => {
  const paying: FleetCompanionRequest = { ...REQUEST, repairsAtStation: true };
  const decision = decideCompanionAction(
    paying,
    dockedAfterFleeing({ damagedItemIDs: null }),
    fleeing(),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.match(decision.why, /quote/i);
});

test("a shop that keeps not fixing things is given up on, not asked for ever", () => {
  const paying: FleetCompanionRequest = { ...REQUEST, repairsAtStation: true };
  const decision = decideCompanionAction(
    paying,
    dockedAfterFleeing({ damagedItemIDs: [SHIP_ITEM] }),
    fleeing({ repairAttempts: 3 }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.match(decision.why, /stopped asking/i);
});

// --- the budget ---------------------------------------------------------------

test("a pilot that used its last trip stays docked even once it is whole", () => {
  const spent: CompanionLadderMemory = {
    ...fleeing(SHIELD_ONLY),
    fleeTripsSpent: REQUEST.maxFleeAttempts,
  };
  const decision = decideCompanionAction(REQUEST, dockedAfterFleeing(), spent);
  assert.notEqual(decision.action.kind, "undock");
  assert.match(decision.why, /staying home/i);
});

// "A return that holds resets the budget", made checkable: a pilot that comes
// back and stays well for long enough gets its trips back.
test("a return that HOLDS puts the budget back", () => {
  // Driven on a clock rather than by counting calls: the hold is a span now
  // (`FLEE_RECOVERY_HOLD_MS`), so how many ticks fit inside it is neither fixed
  // nor the thing being asserted.
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = { ...freshLadderMemory(), fleeTripsSpent: 2 };
  const well = fleeObs({ health: 1 });
  for (let tick = 0; tick < 16; tick += 1) {
    memory = decideCompanionAction(REQUEST, well, memory, nowMs).memory;
    nowMs += 2_000;
  }
  assert.equal(memory.fleeTripsSpent, 0);
});

// ⚠ AND THE SPAN IS WALL CLOCK, NOT A CALL COUNT. This is what stops a pilot
// whose ticks happen to be running fast -- a burst of orders to obey, see
// `FLEET_COMPANION_BURST_MS` -- from earning its flee budget back sooner than
// one sitting still.
test("a return that holds for too SHORT a time does not put the budget back", () => {
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = { ...freshLadderMemory(), fleeTripsSpent: 2 };
  const well = fleeObs({ health: 1 });
  for (let tick = 0; tick < 40; tick += 1) {
    memory = decideCompanionAction(REQUEST, well, memory, nowMs).memory;
    nowMs += 350;
  }
  assert.equal(
    memory.fleeTripsSpent,
    2,
    "forty fast ticks are still only fourteen seconds, and must not count as a hold",
  );
});

// ⚠ AND ONE THAT DOES NOT HOLD MUST NOT. This is the half that makes the bound
// mean anything: a pilot being sent home over and over never reaches the reset,
// so its trips accumulate and it eventually stays put.
test("dropping through the floor again restarts the recovery count", () => {
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = { ...freshLadderMemory(), fleeTripsSpent: 2 };
  const well = fleeObs({ health: 1 });
  for (let tick = 0; tick < 14; tick += 1) {
    memory = decideCompanionAction(REQUEST, well, memory, nowMs).memory;
    nowMs += 2_000;
  }
  assert.notEqual(memory.fleeRecoverySinceMs, null, "the span should be part-way through");

  // One bad tick, and the span starts again rather than carrying on.
  memory = decideCompanionAction(REQUEST, fleeObs({ health: 0.1 }), memory, nowMs).memory;
  assert.equal(memory.fleeRecoverySinceMs, null);
  assert.equal(memory.fleeTripsSpent, 3, "and it costs another trip");
});

// A pilot limping along just above the number that would send it running has
// not recovered from anything, so it must not earn its budget back that way.
test("limping just above the floor does not count as recovering", () => {
  let memory: CompanionLadderMemory = { ...freshLadderMemory(), fleeTripsSpent: 2 };
  const limping = fleeObs({ health: REQUEST.fleeHealthFloor + 0.01 });
  for (let tick = 0; tick < 20; tick += 1) {
    memory = decideCompanionAction(REQUEST, limping, memory).memory;
  }
  assert.equal(memory.fleeTripsSpent, 2, "the budget must not come back to a ship still hurt");
});

// --- the latch ends with the undock -------------------------------------------

test("undocking ends the flee, so the rung stops driving a pilot already back out", () => {
  const decision = decideCompanionAction(REQUEST, dockedAfterFleeing(), fleeing(SHIELD_ONLY));
  assert.equal(decision.memory.flee, null);
});

// --- the operator's own undock ------------------------------------------------
//
// ⚠ REPORTED LIVE, 2026-09-13: "I can not force them to undock, as soon as they
// are undocked they dock back." A parked flee read a ship that was suddenly in
// space as one still on its way out, and sent it straight back to the station --
// every two seconds, for ever. Nothing else can undock a parked pilot: this rung
// drops its own latch before every undock it issues, and no rung below it runs
// while it is parked.

/** A flee that has already delivered the ship to a station. */
function parkedInStation(overrides: Partial<CompanionFlee> = {}): CompanionLadderMemory {
  return fleeing({ arrivedSafe: true, ...overrides });
}

test("a pilot the operator undocks is not docked again", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.1, docked: false }),
    parkedInStation(),
  );
  assert.notEqual(decision.action.kind, "dock");
  assert.equal(decision.memory.flee, null, "the flee is over — a human is flying this ship");
});

test("and it stops sending itself home, rather than re-latching on the next tick", () => {
  let memory = parkedInStation();
  const pulledOut = fleeObs({ health: 0.1, docked: false });
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = decideCompanionAction(REQUEST, pulledOut, memory);
    memory = decision.memory;
    assert.notEqual(decision.action.kind, "dock", "no tick may put it back in the station");
  }
  assert.equal(memory.fleeTripsSpent, REQUEST.maxFleeAttempts);
});

// The override is not permanent: a ship that actually recovers earns its budget
// back the ordinary way, and may look after itself again later in the same run.
test("an overridden pilot that recovers gets its flee budget back", () => {
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.1, docked: false }),
    parkedInStation(),
    nowMs,
  ).memory;
  assert.equal(memory.fleeTripsSpent, REQUEST.maxFleeAttempts);
  const well = fleeObs({ health: 1 });
  for (let tick = 0; tick < 16; tick += 1) {
    nowMs += 2_000;
    memory = decideCompanionAction(REQUEST, well, memory, nowMs).memory;
  }
  assert.equal(memory.fleeTripsSpent, 0);
});

// --- what the trigger stamps --------------------------------------------------

test("a flee that leaves with the armour whole says so, and one that does not, does not", () => {
  const shieldOnly = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.1, shieldRatio: 0.1, armorRatio: 1, hullRatio: 1 }),
  );
  assert.equal(shieldOnly.memory.flee?.onlyTheShieldWasHurt, true);

  const armourToo = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.1, shieldRatio: 0.1, armorRatio: 0.1, hullRatio: 1 }),
  );
  assert.equal(armourToo.memory.flee?.onlyTheShieldWasHurt, false);
});

// A layer that did not read is a layer nobody can vouch for, and vouching for it
// is what would send a hurt ship back out of a station on no information.
test("a layer that could not be read at the trigger never counts as clear", () => {
  const decision = decideCompanionAction(
    REQUEST,
    fleeObs({ health: 0.1, shieldRatio: 0.1, armorRatio: null, hullRatio: 1 }),
  );
  assert.equal(decision.memory.flee?.onlyTheShieldWasHurt, false);
});

// The safe-spot half of a return: no station to undock from, so a pilot out at
// a bookmark routes back to the system it left.
test("a recovered pilot at a safe spot routes back to the system it left", () => {
  const elsewhere = fleeObs({
    health: 1,
    docked: false,
    flightStatus: { solarSystemID: 30000144 } as FleetCompanionObservation["flightStatus"],
  });
  const decision = decideCompanionAction(
    REQUEST,
    elsewhere,
    fleeing({ safeSpotWarpIssued: true, safeSpotWarpSeen: true }),
  );
  assert.deepEqual(decision.action, { kind: "travelTo", systemID: HOME_SYSTEM });
  assert.equal(decision.phase, "Going back");
});

// --- rung 5b: out of the station ----------------------------------------------
//
// ⚠ THE LADDER HAD NO WAY TO UNDOCK A PILOT THAT WAS NOT MID-FLEE, and the
// settings panel promised the opposite in writing the whole time ("It will
// undock when the fleet gives it something to do"). A companion started in a
// station, restarted while parked, or docked by its operator simply stayed
// there: every rung beneath read an empty grid and decided nothing.

/** Docked, with nothing wrong and no flee standing. */
function dockedWithNothingWrong(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({ docked: true, inSpace: false, health: null, ...overrides });
}

test("a docked companion with nothing keeping it docked leaves", () => {
  const decision = decideCompanionAction(REQUEST, dockedWithNothingWrong());
  assert.deepEqual(decision.action, { kind: "undock" });
  assert.equal(decision.phase, "Undocking");
});

test("an undock already in flight is waited on, not sent again every tick", () => {
  const decision = decideCompanionAction(
    REQUEST,
    dockedWithNothingWrong({
      flightStatus: {
        docked: true,
        transition: { kind: "undock", phase: "session-changing" },
      } as FleetCompanionObservation["flightStatus"],
    }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.equal(decision.phase, "Undocking");
});

// Every deliberate reason to STAY in a station is above this rung, and has to
// keep winning: this is the one that would otherwise drag a pilot back out of
// the repairs it is waiting on.
test("a pilot holding in a station for a reason is not dragged out of it", () => {
  const decision = decideCompanionAction(
    REQUEST,
    dockedAfterFleeing({ damagedItemIDs: [SHIP_ITEM] }),
    fleeing(),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.match(decision.why, /not set to pay for repairs/i);
});

test("and neither is one that has spent its round trips", () => {
  const spent: CompanionLadderMemory = {
    ...fleeing(SHIELD_ONLY),
    fleeTripsSpent: REQUEST.maxFleeAttempts,
  };
  const decision = decideCompanionAction(REQUEST, dockedAfterFleeing(), spent);
  assert.notEqual(decision.action.kind, "undock");
  assert.match(decision.why, /staying home/i);
});

// --- rung 6: drones ----------------------------------------------------------
//
// Recall a hurt drone, hold off, put them back out. Driven by a RECORD rather
// than by the condition that started it, because the condition extinguishes
// itself: the instant the recall lands the drones are not in space, so
// lowestDroneHealth reads null and the thing that fired is no longer true.
//
// ⚠ WHAT A RECALL ACTUALLY BUYS ON THIS SERVER IS A SHIELD REPAIR, not a broken
// lock. buildDroneRecoveryItemPatch stamps shieldCharge: 1 onto the item as it
// enters the bay; armour and hull damage survive. There is no target-loss
// memory and no drone cooldown anywhere in this server.

const DRONE_A = 700001;
const DRONE_B = 700002;
const DRONE_BAY_STACK = 800001;

/** A companion set up to fly drones, with the shipped floor and hold-off. */
const WITH_DRONES: FleetCompanionRequest = REQUEST;

function droneObs(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  // ⚠ THE ROLE LISTS ARE WHAT THE RUNG ACTUALLY READS NOW, and the flat ones
  // are kept only because other rungs still use them. The companion used to
  // launch `droneBayItemIDs` -- the WHOLE bay -- which is how a hurt combat
  // drone coming home could take a salvage drone back out with it. It launches
  // one role at a time now, so a fixture that set only the flat list would be
  // describing a ship whose drones the rung cannot classify and will not fly.
  // Combat by default: that is the hostile-on-grid case these tests are about.
  // ⚠ `in`, NOT `??`. `null` is a MEANING here -- "the bay was not read" --
  // and a nullish default would silently turn a test that deliberately says
  // "we could not look" into one that says "a stack of combat drones".
  const combatBay =
    "droneBayItemIDs" in overrides ? overrides.droneBayItemIDs : [DRONE_BAY_STACK];
  const combatOut = "myDroneIDs" in overrides ? overrides.myDroneIDs : [];
  return obs({
    snapshot: gridWithEntities([TACKLE]),
    hostileOnGrid: true,
    myDroneIDs: [],
    droneBayItemIDs: [DRONE_BAY_STACK],
    combatDroneBayItemIDs: combatBay,
    combatDroneIDs: combatOut,
    lowestDroneHealth: null,
    ...overrides,
  });
}

test("a hostile on grid and an empty sky puts the drones out", () => {
  const decision = decideCompanionAction(WITH_DRONES, droneObs());
  assert.deepEqual(decision.action, {
    kind: "launchDrones",
    droneItemIDs: [DRONE_BAY_STACK],
  });
  assert.equal(decision.phase, "Drones");
});

// ⚠ THE REPLACEMENT FOR THE OLD "useDrones OFF launches nothing" TEST. There is
// no toggle any more -- a pilot flies the drones it is carrying -- so what has
// to be pinned instead is that an EMPTY bay is not an error and launches
// nothing. A ship with no drones is a ship doing something else.
test("a pilot carrying no drones launches nothing, whatever is on grid", () => {
  const decision = decideCompanionAction(
    REQUEST,
    droneObs({ droneBayItemIDs: [], combatDroneBayItemIDs: [] }),
  );
  assert.notEqual(decision.action.kind, "launchDrones");
});

// ⚠ hostileOnGrid IS THREE-STATE and only `true` launches. `null` means the
// grid could not be read, and putting drones out onto a grid this pilot cannot
// see is the one place they are hardest to get back.
test("an unreadable grid launches nothing", () => {
  const decision = decideCompanionAction(WITH_DRONES, droneObs({ hostileOnGrid: null }));
  assert.notEqual(decision.action.kind, "launchDrones");
});

test("a quiet grid launches nothing", () => {
  const decision = decideCompanionAction(WITH_DRONES, droneObs({ hostileOnGrid: false }));
  assert.notEqual(decision.action.kind, "launchDrones");
});

// A null bay is "did not look" and an empty one is "nothing aboard". Neither
// launches, and neither is an error - a pilot with no drones fights without.
test("no bay listing and an empty bay both launch nothing", () => {
  for (const droneBayItemIDs of [null, []]) {
    const decision = decideCompanionAction(WITH_DRONES, droneObs({ droneBayItemIDs }));
    assert.notEqual(decision.action.kind, "launchDrones", String(droneBayItemIDs));
  }
});

// --- combat drones and the target the fleet called --------------------------
//
// ⚠ THE BUG THESE ARE FOR, REPORTED LIVE 2026-09-11: "they see rats, they
// harden and launch drones, even target, but drones do not engage". The rung
// gave combat drones no order at all, on the premise that the server assigns
// idle ones by itself. It does -- but ONLY onto something shooting their own
// controller (`noteIncomingAggression`, droneRuntime.js, reads the DAMAGED
// ship's own drones). Rats shooting the commander never touch the companion, so
// its drones had nothing to react to and watched the fight.

test("combat drones are sent onto the target the fleet called, once it is locked", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({
      myDroneIDs: [DRONE_A],
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "engageDrones",
    droneIDs: [DRONE_A],
    targetID: TACKLE,
  });
  assert.equal(decision.phase, "Drones");
});

test("...and the order is issued ONCE, not on every tick", () => {
  // Same reason `lastDroneRepairTargetID` exists: this loop issues one call a
  // tick, so an engage re-sent twice a second starves every rung beneath it.
  const grid = droneObs({
    myDroneIDs: [DRONE_A],
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
  });
  const first = decideCompanionAction(WITH_DRONES, grid);
  assert.equal(first.action.kind, "engageDrones");
  const second = decideCompanionAction(WITH_DRONES, grid, first.memory);
  assert.notEqual(second.action.kind, "engageDrones");
});

test("a called target that is NOT locked yet gets no drones, it gets locked first", () => {
  // ⚠ THE RUNG ORDER MAKES THIS CASE REAL, NOT HYPOTHETICAL. Drones (rung 6)
  // decide ABOVE the rung that locks (rung 7), so on the tick a call first
  // lands there is nothing locked to send drones onto. Sending them anyway
  // would spend the tick's one call on an order the server throws away.
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({
      myDroneIDs: [DRONE_A],
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("a NEW call moves the drones onto it, without anybody recalling them", () => {
  const first = decideCompanionAction(
    WITH_DRONES,
    droneObs({
      myDroneIDs: [DRONE_A],
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  const moved = decideCompanionAction(
    WITH_DRONES,
    droneObs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      myDroneIDs: [DRONE_A],
      fleetTargetTags: new Map([[OTHER, "A"]]),
      lockedTargetIDs: [TACKLE, OTHER],
    }),
    first.memory,
  );
  assert.deepEqual(moved.action, {
    kind: "engageDrones",
    droneIDs: [DRONE_A],
    targetID: OTHER,
  });
});

test("with NOBODY calling a target, combat drones are still left to the server", () => {
  // ⚠ THE OTHER HALF, AND IT MUST NOT REGRESS EITHER. Self-defence is the
  // server's own job and issuing an engage of our own would fight its choice of
  // target for no gain. The order exists for the fleet's call and nothing else.
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], fleetTargetTags: new Map(), lockedTargetIDs: [] }),
  );
  assert.notEqual(decision.action.kind, "engageDrones");
});

test("drones already out are not launched again", () => {
  const decision = decideCompanionAction(WITH_DRONES, droneObs({ myDroneIDs: [DRONE_A] }));
  assert.notEqual(decision.action.kind, "launchDrones");
});

test("a drone below the floor is recalled, and the readout says what that buys", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A, DRONE_B], lowestDroneHealth: 0.2 }),
  );
  assert.deepEqual(decision.action, {
    kind: "recallDrones",
    droneIDs: [DRONE_A, DRONE_B],
  });
  assert.match(decision.why, /shield/i);
});

test("a healthy drone is left alone", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.9 }),
  );
  assert.notEqual(decision.action.kind, "recallDrones");
});

// ⚠ null is "nothing out to judge", never "healthy" and never "hurt" - the same
// rule the DSL's own drone-health condition follows.
test("an unreadable drone health recalls nothing", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: null }),
  );
  assert.notEqual(decision.action.kind, "recallDrones");
});

// ⚠ THE WHOLE POINT OF THE RECORD. Once the recall is issued the drones leave
// space, so the trigger reads null - and a rung that re-derived its state from
// the observation would forget it was ever in a cycle.
test("the cycle survives its own trigger disappearing, and relaunches after the hold-off", () => {
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = freshLadderMemory();

  const recall = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 }),
    memory,
    nowMs,
  );
  assert.equal(recall.action.kind, "recallDrones");
  memory = recall.memory;

  // The drones are gone from the grid and the trigger now reads null.
  const gone = droneObs({ myDroneIDs: [], lowestDroneHealth: null });
  const ticks: string[] = [];
  for (let tick = 0; tick < 12; tick += 1) {
    nowMs += 2_000;
    const decision = decideCompanionAction(WITH_DRONES, gone, memory, nowMs);
    memory = decision.memory;
    ticks.push(decision.action.kind);
    if (decision.action.kind === "launchDrones") {
      break;
    }
  }
  assert.ok(
    ticks.includes("launchDrones"),
    "the hold-off must end in a relaunch, not in the cycle being forgotten",
  );
  assert.ok(
    ticks.filter((kind) => kind === "launchDrones").length === 1,
    "and it relaunches once, not every tick after",
  );
});

// ⚠ HOLDING OFF MUST NOT PARK THE TICK. The hold-off is a floor on a wait, not
// a reason to stop obeying the fleet - a pilot that went quiet every time a
// drone got shot would be worse than one with no drones at all.
test("the pilot keeps obeying its fleet all the way through the hold-off", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const recall = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 }),
    memory,
  );
  memory = recall.memory;

  // Mid-hold-off, with a fleet tag standing on a target that is not locked.
  const holding = droneObs({
    myDroneIDs: [],
    lowestDroneHealth: null,
    fleetTargetTags: new Map([[TACKLE, "A"]]),
  });
  const decision = decideCompanionAction(WITH_DRONES, holding, memory);
  assert.deepEqual(
    decision.action,
    { kind: "lock", targetID: TACKLE },
    "the drone rung is holding off and issuing nothing, so the fleet rung gets the tick",
  );
});

// ⚠ WATCHED PER RECORDED DRONE, never off a coarse flag. This ship may launch
// others mid-cycle, and a flag would call the recall finished the moment one
// unrelated drone came home.
test("the recall is not finished while one of the recalled drones is still out", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const recall = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A, DRONE_B], lowestDroneHealth: 0.2 }),
    memory,
  );
  memory = recall.memory;

  const oneStillOut = droneObs({ myDroneIDs: [DRONE_B], lowestDroneHealth: null });
  for (let tick = 0; tick < 3; tick += 1) {
    const decision = decideCompanionAction(WITH_DRONES, oneStillOut, memory);
    memory = decision.memory;
    assert.notEqual(
      decision.action.kind,
      "launchDrones",
      "nothing relaunches while a recalled drone is still on grid",
    );
  }
});

// ⚠ THE SILENT STUCK CASE. A drone that reaches scoop range to find a FULL BAY
// is refused, and the tick-driven recall path throws that refusal away - nothing
// reaches the client. The drone circles at 2500 m for ever, still on grid, with
// no error anywhere. Without a bound the rung would wait on it until the run
// ended.
test("a recall that never completes is given up on rather than waited on for ever", () => {
  // ⚠ THE CLOCK IS DRIVEN EXPLICITLY, because the bound is a DURATION and not a
  // tick count any more (see `DRONE_RECALL_GIVE_UP_MS`). A loop that called the
  // ladder twenty-five times inside one millisecond used to exhaust the bound;
  // now it would prove nothing at all, so the test advances a clock by a
  // plausible tick and asserts on the elapsed time it took to let go.
  const TICK_MS = 2_000;
  let nowMs = 1_000_000;
  let memory: CompanionLadderMemory = freshLadderMemory();
  const recall = decideCompanionAction(
    WITH_DRONES,
    droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 }),
    memory,
    nowMs,
  );
  memory = recall.memory;
  const startedAtMs = nowMs;

  // The drone never leaves the grid, because the bay it is trying to enter is
  // full and nothing will ever say so.
  const stuck = droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 });
  let letGo = false;
  let waitedMs = 0;
  for (let tick = 0; tick < 40; tick += 1) {
    nowMs += TICK_MS;
    memory = decideCompanionAction(WITH_DRONES, stuck, memory, nowMs).memory;
    if (memory.droneCycle === null) {
      letGo = true;
      waitedMs = nowMs - startedAtMs;
      break;
    }
  }
  assert.ok(letGo, "the stuck cycle must be let go of rather than waited on for ever");
  assert.ok(
    waitedMs <= 30_000 + TICK_MS,
    `the wait must be bounded near half a minute, saw ${waitedMs} ms`,
  );
});

// ⚠ THE SECOND CYCLE IS WORTH LESS THAN THE FIRST AND THE FOURTH IS WORTH
// NOTHING: a recall refills shields but not armour, so once the damage is in
// armour every later cycle returns the same hurt drone and re-trips the floor
// immediately. Bounding the count is what stops that eating the run.
test("the recall budget is spent, and then the pilot fights on without cycling", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const hurt = droneObs({ myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 });
  const gone = droneObs({ myDroneIDs: [], lowestDroneHealth: null });
  let recalls = 0;

  for (let tick = 0; tick < 120; tick += 1) {
    // Alternate what the grid says so a full cycle can complete each time.
    const decision = decideCompanionAction(
      WITH_DRONES,
      memory.droneCycle === null ? hurt : gone,
      memory,
    );
    memory = decision.memory;
    if (decision.action.kind === "recallDrones") {
      recalls += 1;
    }
  }
  assert.ok(recalls > 0, "it must cycle at least once");
  assert.ok(recalls <= 3, `the budget must bound the cycles, saw ${recalls}`);
});

// Rung 1 still outranks everything.
test("nothing about drones is decided mid-warp", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({ inWarp: true, myDroneIDs: [DRONE_A], lowestDroneHealth: 0.2 }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
});

// ⚠ AND IT SITS ABOVE THE FLEET RUNG. A drone bleeding out while the FC has a
// target called is exactly the case that matters: the recall costs one call,
// moves nothing, and does not stop the pilot obeying.
test("a standing fleet order does not stop a hurt drone being recalled", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    droneObs({
      myDroneIDs: [DRONE_A],
      lowestDroneHealth: 0.2,
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "recallDrones", droneIDs: [DRONE_A] });
});

// --- getting safe no longer gives the drones away ---------------------------
//
// ⚠ THE SERVER ABANDONS EVERY CONTROLLED DRONE ON ANY WARP, JUMP OR DOCK.
// handleControllerLost only attempts a bay recovery when the lifecycle reason is
// a disconnect or a logoff, and a normal departure passes neither - so the
// recovery branch is skipped outright however close the drones are. And an
// abandoned drone can be scooped by ANYBODY on grid. Leaving without a recall
// does not merely cost this pilot its drones; it hands them to whoever is
// still there.

test("an unsupervised pilot with drones out recalls them before it warps", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500_000), myDroneIDs: [DRONE_A] }),
  );
  assert.deepEqual(decision.action, { kind: "recallDrones", droneIDs: [DRONE_A] });
  assert.equal(decision.phase, "Getting safe");
});

test("with nothing out it warps straight away, exactly as it did before", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500_000), myDroneIDs: [] }),
  );
  assert.equal(decision.action.kind, "warp");
});

// ⚠ A HOST THAT DOES NOT WIRE THE READ UP GETS THE OLD BEHAVIOUR, not a pilot
// that refuses to leave over drones nobody can see.
test("an absent drone read does not strand the pilot", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500_000) }),
  );
  assert.equal(decision.action.kind, "warp");
});

test("the recall is issued once, then waited on rather than resent", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const stillOut = alone({ snapshot: gridWithStation(500_000), myDroneIDs: [DRONE_A] });

  const first = decideCompanionAction(WITH_DRONES, stillOut, memory);
  assert.equal(first.action.kind, "recallDrones");
  memory = first.memory;

  const second = decideCompanionAction(WITH_DRONES, stillOut, memory);
  assert.deepEqual(second.action, { kind: "wait" }, "a second recall would be a wasted call");
  assert.equal(second.phase, "Getting safe");
});

test("once the drones are home the warp goes ahead", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  memory = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500_000), myDroneIDs: [DRONE_A] }),
    memory,
  ).memory;

  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500_000), myDroneIDs: [] }),
    memory,
  );
  assert.equal(decision.action.kind, "warp");
});

// ⚠ DRONES ARE WORTH A FEW SECONDS AND ARE NOT WORTH THE SHIP. A recall that
// cannot complete - a full bay, which the server refuses in silence - must not
// strand an unsupervised pilot in space for the whole thirty-minute wait.
test("a recall that never completes does not strand the pilot in space", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const stuck = alone({ snapshot: gridWithStation(500_000), myDroneIDs: [DRONE_A] });
  let left = false;

  for (let tick = 0; tick < 20; tick += 1) {
    const decision = decideCompanionAction(WITH_DRONES, stuck, memory);
    memory = decision.memory;
    if (decision.action.kind === "warp") {
      left = true;
      break;
    }
  }
  assert.ok(left, "the pilot must give up on the recall and get itself safe");
});

// The safe-spot half of the ladder is a departure too, and has the same hazard.
test("the warp to the sun also recalls first", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithSunOnly(), myDroneIDs: [DRONE_A] }),
  );
  assert.deepEqual(decision.action, { kind: "recallDrones", droneIDs: [DRONE_A] });
});

// Docking is not a departure - it is the destination, and the recall already
// happened before the warp that got here. A pilot on the station must not
// stall.
test("a pilot already at the station docks without a fresh recall round", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    alone({ snapshot: gridWithStation(500), myDroneIDs: [] }),
  );
  assert.equal(decision.action.kind, "dock");
});

// --- one kind of drone at a time -------------------------------------------
//
// ⚠ THE OPERATOR'S OWN RULE: "Do not mix drones, at one time one type of the
// drones". The companion used to launch `droneBayItemIDs` -- the WHOLE bay --
// which is how a hull carrying combat and salvage drones sent both into the
// same fight: the salvage drones cannot fight it, and they fill the control
// slots the combat drones needed. Every scripted bot in this app has always
// launched one role at a time; this rung was the one place that did not.

/** A grid with a hostile and a WRECK, so a salvage job has something to do. */
function gridWithWreck(): SpaceSnapshot {
  const grid = gridWithEntities([TACKLE]) as unknown as { entities: unknown[] };
  grid.entities.push({
    itemID: 980350000099,
    kind: "wreck",
    isSelf: false,
    ownerID: null,
    position: { x: 3_000, y: 0, z: 0 },
    radius: 0,
    mode: null,
  });
  return grid as unknown as SpaceSnapshot;
}

const SALVAGE_BAY_STACK = 800002;
const LOGI_BAY_STACK = 800003;
const SALVAGE_DRONE_OUT = 700010;
const LOGI_DRONE_OUT = 700011;

/** A drone bay holding one stack of each kind, and nothing out. */
function mixedBayObs(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntities([TACKLE]),
    hostileOnGrid: true,
    myDroneIDs: [],
    droneBayItemIDs: [DRONE_BAY_STACK, SALVAGE_BAY_STACK, LOGI_BAY_STACK],
    combatDroneBayItemIDs: [DRONE_BAY_STACK],
    salvageDroneBayItemIDs: [SALVAGE_BAY_STACK],
    logisticDroneBayItemIDs: [LOGI_BAY_STACK],
    combatDroneIDs: [],
    salvageDroneIDs: [],
    logisticDroneIDs: [],
    lowestDroneHealth: null,
    ...overrides,
  });
}

test("a mixed bay launches ONLY the combat drones into a fight", () => {
  const decision = decideCompanionAction(WITH_DRONES, mixedBayObs());
  assert.deepEqual(decision.action, {
    kind: "launchDrones",
    droneItemIDs: [DRONE_BAY_STACK],
  });
});

test("drones of the WRONG role are brought home before the right ones go out", () => {
  // A salvage sweep that ran into a fight: the salvage drones are still in
  // space, and a hostile has arrived. The rung must not launch combat drones
  // alongside them -- it recalls first, and only then fills the slots.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "recallDrones",
    droneIDs: [SALVAGE_DRONE_OUT],
  });
  assert.match(decision.why, /combat drones/i);
});

test("combat drones already out are given NO order - the server defends with them", () => {
  // ⚠ NOT AN OMISSION. The server assigns idle combat drones onto whatever
  // shoots their controller by itself, and the behaviour setting that gates it
  // defaults to on with no client surface to change it. An engage of our own
  // would fight the server's choice of target for no gain, one call per tick.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({ myDroneIDs: [DRONE_A], combatDroneIDs: [DRONE_A] }),
  );
  assert.notEqual(decision.action.kind, "engageDrones");
  assert.notEqual(decision.action.kind, "launchDrones");
});

// --- repair drones ----------------------------------------------------------

test("a rep call puts the REPAIR drones out, not the combat ones", () => {
  // ⚠ URGENCY, THE SAME ORDER THE MODULE RUNGS USE. Answering a rep call
  // outranks joining a fight because somebody is dying now, where a fight is
  // still there next tick.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      snapshot: gridWithEntities([LOGI]),
      fleetBroadcast: fleetBroadcast("HealArmor", LOGI),
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "launchDrones",
    droneItemIDs: [LOGI_BAY_STACK],
  });
});

test("repair drones already out are sent to the ship the FLEET is calling for", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      snapshot: gridWithEntities([LOGI]),
      fleetBroadcast: fleetBroadcast("HealShield", LOGI),
      myDroneIDs: [LOGI_DRONE_OUT],
      logisticDroneIDs: [LOGI_DRONE_OUT],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "engageDrones",
    droneIDs: [LOGI_DRONE_OUT],
    targetID: LOGI,
  });
});

test("a repair order is issued once, not re-sent every tick", () => {
  // One atomic call per tick is this loop's whole contract; re-aiming drones
  // that are already repairing the right ship would starve every rung below.
  const observation = mixedBayObs({
    snapshot: gridWithEntities([LOGI]),
    fleetBroadcast: fleetBroadcast("HealShield", LOGI),
    myDroneIDs: [LOGI_DRONE_OUT],
    logisticDroneIDs: [LOGI_DRONE_OUT],
  });
  const first = decideCompanionAction(WITH_DRONES, observation);
  const second = decideCompanionAction(WITH_DRONES, observation, first.memory);
  assert.notEqual(second.action.kind, "engageDrones");
});

for (const role of ["combat", "repair"] as const) {
  test(`${role} drones engage the same target again after a complete hurt-drone cycle`, () => {
    const targetID = role === "combat" ? TACKLE : LOGI;
    const droneID = role === "combat" ? DRONE_A : LOGI_DRONE_OUT;
    const world = (out: boolean, hurt = false) => mixedBayObs({
      snapshot: gridWithEntities([targetID]),
      fleetTargetTags: role === "combat" ? new Map([[targetID, "A"]]) : new Map(),
      fleetBroadcast: role === "repair" ? fleetBroadcast("HealShield", targetID) : null,
      lockedTargetIDs: [targetID],
      myDroneIDs: out ? [droneID] : [],
      combatDroneIDs: role === "combat" && out ? [droneID] : [],
      logisticDroneIDs: role === "repair" && out ? [droneID] : [],
      lowestDroneHealth: out ? (hurt ? 0.2 : 0.9) : null,
    });
    let nowMs = 1_000_000;
    const engaged = decideCompanionAction(WITH_DRONES, world(true), undefined, nowMs);
    assert.equal(engaged.action.kind, "engageDrones");
    const recalled = decideCompanionAction(WITH_DRONES, world(true, true), engaged.memory, nowMs += 2_000);
    assert.equal(recalled.action.kind, "recallDrones");
    const holding = decideCompanionAction(WITH_DRONES, world(false), recalled.memory, nowMs += 2_000);
    assert.equal(holding.memory.droneCycle?.stage, "holding-off");
    const launched = decideCompanionAction(
      WITH_DRONES, world(false), holding.memory,
      nowMs += WITH_DRONES.droneRedeployHoldOffSeconds * 1_000,
    );
    assert.equal(launched.action.kind, "launchDrones");
    const freshFlight = decideCompanionAction(WITH_DRONES, world(true), launched.memory, nowMs += 2_000);
    assert.deepEqual(freshFlight.action, { kind: "engageDrones", droneIDs: [droneID], targetID });
    const continuing = decideCompanionAction(WITH_DRONES, world(true), freshFlight.memory, nowMs += 2_000);
    assert.notEqual(continuing.action.kind, "engageDrones");
  });
}

test("a recalled combat flight observed while supervision is unreadable gets a fresh order on return", () => {
  const world = (overrides: Partial<FleetCompanionObservation> = {}) => droneObs({
    myDroneIDs: [DRONE_A],
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
    ...overrides,
  });
  const engaged = decideCompanionAction(WITH_DRONES, world());
  assert.equal(engaged.action.kind, "engageDrones");
  const gone = decideCompanionAction(WITH_DRONES, world({
    myDroneIDs: [],
    fleetMemberCharacterIDs: null,
  }), engaged.memory);
  assert.equal(gone.phase, "Checking supervision");
  const returned = decideCompanionAction(WITH_DRONES, world(), gone.memory);
  assert.deepEqual(returned.action, { kind: "engageDrones", droneIDs: [DRONE_A], targetID: TACKLE });
});

test("a changed combat flight receives its standing target once, regardless of ID ordering", () => {
  const world = (droneIDs: readonly number[]) => droneObs({
    myDroneIDs: droneIDs,
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
  });
  const engaged = decideCompanionAction(WITH_DRONES, world([DRONE_A]));
  const added = decideCompanionAction(WITH_DRONES, world([DRONE_A, DRONE_B]), engaged.memory);
  assert.deepEqual(added.action, { kind: "engageDrones", droneIDs: [DRONE_A, DRONE_B], targetID: TACKLE });
  const reordered = decideCompanionAction(WITH_DRONES, world([DRONE_B, DRONE_A]), added.memory);
  assert.notEqual(reordered.action.kind, "engageDrones");
});

test("an unreadable combat flight does not retire its standing target order", () => {
  const world = (overrides: Partial<FleetCompanionObservation> = {}) => droneObs({
    myDroneIDs: [DRONE_A],
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
    ...overrides,
  });
  const engaged = decideCompanionAction(WITH_DRONES, world());
  const unreadable = decideCompanionAction(WITH_DRONES, world({
    myDroneIDs: undefined,
    combatDroneIDs: null,
    combatDroneBayItemIDs: null,
  }), engaged.memory);
  const recovered = decideCompanionAction(WITH_DRONES, world(), unreadable.memory);
  assert.notEqual(recovered.action.kind, "engageDrones");
});

function engagementObs(role: "combat" | "repair", droneIDs: readonly number[] = [DRONE_A, DRONE_B]): FleetCompanionObservation {
  return mixedBayObs({
    snapshot: gridWithEntities([LOGI]),
    fleetTargetTags: role === "combat" ? new Map([[LOGI, "A"]]) : new Map(),
    fleetBroadcast: role === "repair" ? fleetBroadcast("HealShield", LOGI) : null,
    lockedTargetIDs: [LOGI],
    myDroneIDs: droneIDs,
    combatDroneIDs: role === "combat" ? droneIDs : [],
    logisticDroneIDs: role === "repair" ? droneIDs : [],
  });
}

for (const role of ["combat", "repair"] as const) {
  test(`${role} drone engagement retries definite refusals and confirms the successful flight`, async () => {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => engagementObs(role),
      issue: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("Engage refused"), { code: "CALL_REFUSED" });
      },
    }).deps);
    companion.start(REQUEST);
    await companion.tick();
    assert.equal((await companion.tick()).kind, "engageDrones");
    assert.equal((await companion.tick()).kind, "wait");
    assert.equal(calls, 2);
  });

  test(`${role} drone engagement waits through session changes without spending ordinary refusal budget`, async () => {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => engagementObs(role),
      issue: async () => {
        calls += 1;
        if (calls <= 5) throw Object.assign(new Error("Session is changing"), { code: "SESSION_CHANGE_IN_PROGRESS" });
      },
    }).deps);
    companion.start(REQUEST);
    for (let tick = 0; tick < 12; tick += 1) await companion.tick();
    assert.equal((await companion.tick()).kind, "wait");
    assert.equal(calls, 6);
    assert.equal(companion.snapshot().status, "running");
  });
}

test("partial drone refusals retry only refused IDs and preserve accepted drones", async () => {
  const issued: FleetCompanionAction[] = [];
  const companion = createFleetCompanion(makeDeps({
    observe: async () => engagementObs("combat"),
    issue: async (action) => {
      issued.push(action);
      if (issued.length === 1) throw Object.assign(new Error("One drone refused"), {
        code: "CALL_REFUSED", acceptedDroneIDs: [DRONE_A], refusedDroneIDs: [DRONE_B], uncertainDroneIDs: [],
      });
    },
  }).deps);
  companion.start(REQUEST);
  await companion.tick();
  await companion.tick();
  await companion.tick();
  assert.deepEqual(issued, [
    { kind: "engageDrones", droneIDs: [DRONE_A, DRONE_B], targetID: LOGI },
    { kind: "engageDrones", droneIDs: [DRONE_B], targetID: LOGI },
  ]);
});

test("mixed drone results retry known refusals without replaying accepted or uncertain drones", async () => {
  const unknownDrone = 700099;
  const issued: FleetCompanionAction[] = [];
  const companion = createFleetCompanion(makeDeps({
    observe: async () => engagementObs("repair", [DRONE_A, DRONE_B, unknownDrone]),
    issue: async (action) => {
      issued.push(action);
      if (issued.length === 1) throw Object.assign(new Error("Some drone outcomes are unknown"), {
        code: "BRIDGE_BAD_RESPONSE", acceptedDroneIDs: [DRONE_A], refusedDroneIDs: [DRONE_B], uncertainDroneIDs: [unknownDrone],
      });
    },
  }).deps);
  companion.start(REQUEST);
  for (let tick = 0; tick < 4; tick += 1) await companion.tick();
  assert.deepEqual(issued, [
    { kind: "engageDrones", droneIDs: [DRONE_A, DRONE_B, unknownDrone], targetID: LOGI },
    { kind: "engageDrones", droneIDs: [DRONE_B], targetID: LOGI },
  ]);
  assert.equal(companion.snapshot().status, "paused");
});

test("drone engagement ordinary refusals are bounded, and transport ambiguity is never replayed", async () => {
  for (const code of ["CALL_REFUSED", "BRIDGE_NETWORK_ERROR"]) {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => engagementObs("combat"),
      issue: async () => { calls += 1; throw Object.assign(new Error("Engage failed"), { code }); },
    }).deps);
    companion.start(REQUEST);
    for (let tick = 0; tick < 8; tick += 1) await companion.tick();
    assert.equal(calls, code === "CALL_REFUSED" ? 3 : 1, code);
    assert.equal(companion.snapshot().status, "paused", code);
  }
});

test("a pilot with no repair drones answers a rep call by fighting on", () => {
  // A hull that cannot do the job is not "the logistic role with nothing to
  // launch" -- it is simply not that pilot, so the branch falls through.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      snapshot: gridWithEntities([LOGI, TACKLE]),
      fleetBroadcast: fleetBroadcast("HealArmor", LOGI),
      logisticDroneBayItemIDs: [],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "launchDrones",
    droneItemIDs: [DRONE_BAY_STACK],
  });
});

// --- the salvage and loot chat orders ---------------------------------------

const WRECK = 300001;
const CAN = 300002;

/** A bare `salvage` / `loot` line from the fleet's commander. */
function areaOrder(verb: string): ChatMessage {
  return { characterID: HUMAN, characterName: "Fleet Mate", message: verb, createdAtMs: 1_000 };
}

test("a bare 'salvage' from a commander puts the SALVAGE drones out", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      // ⚠ A WRECK HAS TO BE ON GRID. A salvage job clears itself the moment
      // there is nothing left to salvage, so an empty grid is "job done" and
      // correctly launches nothing.
      snapshot: gridWithWreck(),
      chatMessages: [areaOrder("salvage")],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "launchDrones",
    droneItemIDs: [SALVAGE_BAY_STACK],
  });
});

test("salvage drones out: lock the wreck, then send them at IT, never the server's auto-pick", () => {
  // ⚠ `targetID: 0` IS THE SERVER'S AUTO-PICK, which only takes wrecks owned by
  // the pilot or a current fleet mate. This wreck's owner is unknown, which is
  // exactly the case that left every salvage drone idle.
  const WRECK_ID = 980350000099;
  const world = (overrides: Partial<FleetCompanionObservation> = {}) =>
    mixedBayObs({
      hostileOnGrid: false,
      snapshot: gridWithWreck(),
      chatMessages: [areaOrder("salvage")],
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
      ...overrides,
    });
  const locking = decideCompanionAction(WITH_DRONES, world());
  assert.deepEqual(locking.action, { kind: "lock", targetID: WRECK_ID });

  const sending = decideCompanionAction(WITH_DRONES, world({ lockedTargetIDs: [WRECK_ID] }), locking.memory);
  assert.deepEqual(sending.action, {
    kind: "salvageDrones",
    droneIDs: [SALVAGE_DRONE_OUT],
    targetID: WRECK_ID,
  });

  // Sent once: a repeated order would restart the drone's salvage cycle.
  const after = decideCompanionAction(WITH_DRONES, world({ lockedTargetIDs: [WRECK_ID] }), sending.memory);
  assert.notEqual(after.action.kind, "salvageDrones");
});

test("a drone-only salvager closes to lock range, not to the wreck", () => {
  const WRECK_ID = 980350000099;
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      snapshot: gridWithWreck(), // wreck at 3 km
      chatMessages: [areaOrder("salvage")],
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
      maxTargetRangeM: 2_000,
    }),
  );
  assert.equal(decision.action.kind, "approach");
  const inReach = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      snapshot: gridWithWreck(),
      chatMessages: [areaOrder("salvage")],
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
      maxTargetRangeM: 40_000,
    }),
  );
  assert.deepEqual(inReach.action, { kind: "lock", targetID: WRECK_ID });
});

test("nobody said salvage, so the salvage drones stay in the bay", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({ hostileOnGrid: false, combatDroneBayItemIDs: [] }),
  );
  assert.notEqual(decision.action.kind, "launchDrones");
});

test("a salvage order from someone who is NOT a commander does nothing", () => {
  // The roster is the whole gate, and chat is LOCAL chat -- readable by
  // everyone in the system.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      combatDroneBayItemIDs: [],
      chatMessages: [
        { characterID: 90000099, characterName: "Nobody", message: "salvage", createdAtMs: 1_000 },
      ],
    }),
  );
  assert.notEqual(decision.action.kind, "launchDrones");
});

/**
 * A grid carrying a wreck and a can, at the distances the loot rung cares about.
 *
 * ⚠ `containerDistance` IS CENTRE TO CENTRE, which is what both the rung and the
 * server measure. The radii default to 0 so that for most tests here the surface
 * distance is the same number; the pair that gives them real values is pinning
 * exactly the case where the two disagree.
 */
function lootGrid(options: {
  readonly wreckOwner?: number | null;
  readonly wreckDistance?: number;
  readonly containerDistance?: number;
  readonly stationDistance?: number;
  /** The ship's own mode, so a test can say "a move is still under way". */
  readonly shipMode?: string;
  readonly shipRadius?: number;
  readonly containerRadius?: number;
}): SpaceSnapshot {
  const shipRadius = options.shipRadius ?? 0;
  const entities: unknown[] = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      position: { x: 0, y: 0, z: 0 },
      radius: shipRadius,
      mode: null,
    },
  ];
  if (options.wreckOwner !== undefined) {
    entities.push({
      itemID: WRECK,
      kind: "wreck",
      isSelf: false,
      ownerID: options.wreckOwner,
      position: { x: options.wreckDistance ?? 100, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  if (options.containerDistance !== undefined) {
    entities.push({
      itemID: CAN,
      kind: "container",
      isSelf: false,
      ownerID: null,
      position: { x: options.containerDistance, y: 0, z: 0 },
      radius: options.containerRadius ?? 0,
      mode: null,
    });
  }
  if (options.stationDistance !== undefined) {
    entities.push({
      itemID: 60000001,
      kind: "station",
      isSelf: false,
      ownerID: null,
      position: { x: options.stationDistance, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: shipRadius, mode: options.shipMode ?? null },
    entities,
  } as unknown as SpaceSnapshot;
}

test("a bare 'loot' empties a wreck of this pilot's own, in range", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ wreckOwner: COMPANION }),
      chatMessages: [areaOrder("loot")],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lootWreck", wreckID: WRECK });
  assert.equal(decision.phase, "Looting");
});

test("a container is looted whoever owns it - the server applies no check either", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ containerDistance: 100 }),
      chatMessages: [areaOrder("loot")],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lootContainer", containerID: CAN });
});

test("something out of reach is approached first, and the approach is issued ONCE", () => {
  const observation = obs({
    snapshot: lootGrid({ containerDistance: 40_000 }),
    chatMessages: [areaOrder("loot")],
  });
  const first = decideCompanionAction(WITH_DRONES, observation);
  // ⚠ NO RANGE ON THE APPROACH: a looter flies all the way in, by the
  // operator's own call ("for loot do not use range, for salvage do"). It has
  // nothing to gain by standing off, and hugging the can is what keeps it
  // clear of the server's own 2,500 m bind gate instead of parked on the edge
  // of it -- see SALVAGE_APPROACH_STOP_M for what parking on a threshold costs.
  assert.deepEqual(first.action, { kind: "approach", targetID: CAN });
  // ⚠ THE SHIP MUST ACTUALLY BE MOVING for the rung to wait. An approach that
  // was refused, or that finished early, leaves the ship stopped out of reach
  // -- and the rung re-issues rather than waiting on it for ever, which is the
  // bug that had a pilot parked next to a can doing nothing.
  const stillFlying = obs({
    snapshot: lootGrid({ containerDistance: 40_000, shipMode: "FOLLOW" }),
    chatMessages: [areaOrder("loot")],
  });
  const second = decideCompanionAction(WITH_DRONES, stillFlying, first.memory);
  assert.notEqual(second.action.kind, "approach");

  // ...and a ship that has STOPPED short gets a fresh approach.
  const stalled = decideCompanionAction(WITH_DRONES, observation, first.memory);
  assert.equal(stalled.action.kind, "approach");
});

test("a can whose HULL is near but whose CENTRE is not is closed on, never reached into", () => {
  // ⚠ THE BUG THIS IS FOR, OBSERVED LIVE 2026-09-11: a companion flew to a
  // container and stood next to it having looted nothing.
  //
  // `invbroker` binds a space container only while the straight-line distance
  // between the two CENTRES is within 2,500 m, and it refuses with
  // `FakeItemNotFound` -- the same answer it gives for an id it has never heard
  // of. The rung used to ask `measureSpace`, which answers SURFACE distances:
  // centres minus both radii. Here that is 2,800 - 200 - 300 = 2,300 m, inside
  // the old 2,400 m test, while the server was measuring 2,800 and refusing.
  //
  // The server log of that day shows the gate biting: three refusals over four
  // seconds, then a fourth call -- a few hundred metres later -- binding the
  // container and listing it. ⚠ Those calls came over a GAME CLIENT's socket,
  // not the companion's: the web gateway calls service handlers directly and
  // never appears in that log. So they pin the server's RULE, and the
  // companion's own failure follows from that rule plus the mismatch above.
  // `companionLootFrom`'s attempt bound is what turned it permanent.
  const stillTooFar = obs({
    snapshot: lootGrid({
      containerDistance: 2_800,
      shipRadius: 200,
      containerRadius: 300,
    }),
    chatMessages: [areaOrder("loot")],
  });
  const decision = decideCompanionAction(WITH_DRONES, stillTooFar);
  assert.deepEqual(
    decision.action,
    { kind: "approach", targetID: CAN },
    "2,300 m of clear space between the hulls is still 2,800 m to the server",
  );

  // ...and the same can, genuinely close, is opened. Both halves matter: a
  // rung that simply refused to loot anything would pass the assertion above.
  const arrived = obs({
    snapshot: lootGrid({
      containerDistance: 900,
      shipRadius: 200,
      containerRadius: 300,
    }),
    chatMessages: [areaOrder("loot")],
  });
  assert.deepEqual(
    decideCompanionAction(WITH_DRONES, arrived, decision.memory).action,
    { kind: "lootContainer", containerID: CAN },
  );
});

test("nobody said loot, so a grid full of wrecks is left alone", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({ snapshot: lootGrid({ wreckOwner: COMPANION }) }),
  );
  assert.notEqual(decision.action.kind, "lootWreck");
});

test("looting is BENEATH the flee - a pilot that is dying stops looting", () => {
  // ⚠ THE ONLY THING A COMPANION DOES THAT MOVES THE SHIP OF ITS OWN ACCORD, so
  // it is the one rung that could carry a pilot away from its fleet. It sits at
  // the very bottom of the ladder for exactly that reason.
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      // ⚠ A STATION ON GRID, so the flee has somewhere to GO. Without one the
      // get-safe ladder has nothing to issue and the tick falls through -- which
      // would make this test pass for the wrong reason.
      snapshot: lootGrid({ wreckOwner: COMPANION, stationDistance: 200_000 }),
      chatMessages: [areaOrder("loot")],
      shieldRatio: 0.05,
      armorRatio: 0.05,
      hullRatio: 0.05,
      health: 0.05,
    }),
  );
  assert.notEqual(decision.action.kind, "lootWreck");
});

// --- the salvage order acts on the FIT, not only on the drone bay -----------
//
// ⚠ FOUND IN LIVE TESTING, 2026-09-11. The first cut of the `salvage` verb
// acted on salvage DRONES alone, so a hull with a salvager bolted on and an
// empty drone bay was told to salvage and stood there. What a pilot can do is a
// property of its FIT -- the same principle that deleted every module picker.

const SALVAGER_1 = 11400001;
const SALVAGER_2 = 11400002;
const WRECK_NEAR = 300010;

/** A grid with one wreck at `distanceM`, plus this ship. */
function salvageGrid(
  distanceM: number,
  activeModuleIDs: readonly number[] = [],
  /** The ship's own server mode, so a test can say what move is being flown. */
  shipMode: string | null = null,
): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: shipMode, activeModuleIDs },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: shipMode },
      {
        itemID: WRECK_NEAR,
        kind: "wreck",
        isSelf: false,
        // ⚠ OURS, so this one grid can serve BOTH jobs. Salvaging ignores
        // ownership entirely; looting does not, and a wreck nobody can
        // attribute is never opened -- so an unowned wreck would make a `loot`
        // job clear itself the instant it was given.
        ownerID: COMPANION,
        position: { x: distanceM, y: 0, z: 0 },
        radius: 0,
        mode: null,
      },
    ],
  } as unknown as SpaceSnapshot;
}

/** A pilot with a salvager fitted and NOTHING in its drone bay. */
const WITH_SALVAGER: FleetCompanionRequest = {
  ...REQUEST,
  salvagerModuleIDs: [SALVAGER_1],
};

function salvageObs(
  snapshot: SpaceSnapshot,
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot,
    chatMessages: [areaOrder("salvage")],
    droneBayItemIDs: [],
    combatDroneBayItemIDs: [],
    salvageDroneBayItemIDs: [],
    logisticDroneBayItemIDs: [],
    ...overrides,
  });
}

test("a salvager-fitted pilot with an EMPTY drone bay still salvages when told", () => {
  // The exact live case: a hull that can salvage, no drones aboard, and an order
  // it used to ignore completely.
  const decision = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(30_000)));
  // Stops in salvager reach, not on the wreck itself.
  assert.deepEqual(decision.action, { kind: "approach", targetID: WRECK_NEAR, range: 3000 });
  assert.equal(decision.phase, "Salvaging");
});

test("in range it locks the wreck, then runs the salvager on it", () => {
  const inRange = salvageGrid(1_000);
  const locking = decideCompanionAction(WITH_SALVAGER, salvageObs(inRange));
  assert.deepEqual(locking.action, { kind: "lock", targetID: WRECK_NEAR });

  const running = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(inRange, { lockedTargetIDs: [WRECK_NEAR] }),
    locking.memory,
  );
  assert.deepEqual(running.action, {
    kind: "activate",
    moduleID: SALVAGER_1,
    targetID: WRECK_NEAR,
  });
});

test("a second salvager is started rather than the first re-activated", () => {
  const both: FleetCompanionRequest = {
    ...REQUEST,
    salvagerModuleIDs: [SALVAGER_1, SALVAGER_2],
  };
  const decision = decideCompanionAction(
    both,
    salvageObs(salvageGrid(1_000, [SALVAGER_1]), { lockedTargetIDs: [WRECK_NEAR] }),
    {
      ...freshLadderMemory(),
      salvageWreckID: WRECK_NEAR,
      salvageLockIssued: true,
    } satisfies CompanionLadderMemory,
  );
  assert.deepEqual(decision.action, {
    kind: "activate",
    moduleID: SALVAGER_2,
    targetID: WRECK_NEAR,
  });
});

test("a wreck that will not lock is given up on rather than waited on for ever", () => {
  // ⚠ THE SILENT CASE. Nothing tells a client that a lock will never land, so
  // without a bound this rung waits on one wreck while a grid full of others
  // goes unsalvaged.
  let memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    salvageWreckID: WRECK_NEAR,
    salvageLockIssued: true,
  };
  let gaveUp = false;
  for (let tick = 0; tick < 20; tick += 1) {
    const decision = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)), memory);
    memory = decision.memory;
    if (memory.salvageWreckID === null) {
      gaveUp = true;
      break;
    }
  }
  assert.ok(gaveUp, "the rung must move on from a wreck it cannot lock");
});

test("nobody said salvage, so a fitted salvager stays dark", () => {
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000), { chatMessages: [] }),
  );
  assert.notEqual(decision.phase, "Salvaging");
});

test("a pilot with no salvager and no salvage drones simply stands by", () => {
  // Not an error, and not a complaint: a ship that cannot do the job does not
  // do it. The same answer the drone half gives for an empty bay.
  const decision = decideCompanionAction(REQUEST, salvageObs(salvageGrid(1_000)));
  assert.notEqual(decision.phase, "Salvaging");
  assert.notEqual(decision.action.kind, "launchDrones");
});

test("salvaging is BENEATH the flee - a dying pilot stops salvaging", () => {
  // It moves the ship, exactly as looting does, so it sits at the bottom of the
  // ladder and a pilot that is dying leaves instead.
  const grid = salvageGrid(1_000);
  (grid as unknown as { entities: unknown[] }).entities.push({
    itemID: 60000001,
    kind: "station",
    isSelf: false,
    position: { x: 200_000, y: 0, z: 0 },
    radius: 0,
    mode: null,
  });
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(grid, {
      shieldRatio: 0.05,
      armorRatio: 0.05,
      hullRatio: 0.05,
      health: 0.05,
    }),
  );
  assert.notEqual(decision.phase, "Salvaging");
});

// --- an area order is a JOB, not an instant ---------------------------------
//
// ⚠ FOUND LIVE, 2026-09-11. These verbs were first read straight off the chat
// backlog, so they inherited the BROADCAST freshness window -- thirty seconds,
// which is right for a target call and wrong for a job that takes minutes. A
// pilot salvaged exactly ONE wreck and went back to standing by with two still
// on grid, because the order aged out mid-job. It latches now.

test("a salvage job outlives the chat message that started it", () => {
  // ⚠ THE REGRESSION THIS EXISTS FOR. The order is heard on the first tick and
  // NEVER HEARD AGAIN -- the second tick sees an empty chat, exactly as it would
  // once the message aged out of the freshness window. The job must continue.
  const heard = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000)),
  );
  assert.equal(heard.memory.areaJob, "salvage");

  const silent = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000), { chatMessages: [] }),
    heard.memory,
  );
  assert.equal(silent.memory.areaJob, "salvage", "silence must not cancel a job");
  assert.equal(silent.phase, "Salvaging");
});

test("a salvage job clears ITSELF once the grid has no wrecks left", () => {
  // ⚠ WHAT KEEPS THE LATCH FROM BEING A TRAP. Without this a pilot reports a job
  // it finished minutes ago and never falls back to its own ladder.
  const working = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  assert.equal(working.memory.areaJob, "salvage");

  const swept = decideCompanionAction(
    WITH_SALVAGER,
    obs({ snapshot: gridWithEntities([]), chatMessages: [] }),
    working.memory,
  );
  assert.equal(swept.memory.areaJob, null);
  assert.notEqual(swept.phase, "Salvaging");
});

test("a grid it cannot SEE never cancels a job", () => {
  // ⚠ "No wrecks" and "could not look" are different answers. A pilot
  // fleet-warped away mid-salvage must arrive with its order intact.
  const working = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  for (const blind of [
    obs({ inWarp: true, chatMessages: [] }),
    obs({ inSpace: false, docked: true, snapshot: null, chatMessages: [] }),
  ]) {
    const decision = decideCompanionAction(WITH_SALVAGER, blind, working.memory);
    assert.equal(decision.memory.areaJob, "salvage", JSON.stringify({ blind: blind.inWarp }));
  }
});

test("'stop' from a commander cancels a standing job", () => {
  const working = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  assert.equal(working.memory.areaJob, "salvage");

  const stopped = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000), { chatMessages: [areaOrder("stop")] }),
    working.memory,
  );
  assert.equal(stopped.memory.areaJob, null);
  assert.notEqual(stopped.phase, "Salvaging");
});

test("'stop' from someone who is NOT a commander cancels nothing", () => {
  // The same roster gate the order itself passed through. A stranger in local
  // must not be able to call off a fleet's work.
  const working = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  const ignored = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000), {
      chatMessages: [
        { characterID: 90000099, characterName: "Nobody", message: "stop", createdAtMs: 2_000 },
      ],
    }),
    working.memory,
  );
  assert.equal(ignored.memory.areaJob, "salvage");
});

test("a loot job latches and clears the same way", () => {
  const heard = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ wreckOwner: COMPANION }),
      chatMessages: [areaOrder("loot")],
    }),
  );
  assert.equal(heard.memory.areaJob, "loot");
  assert.deepEqual(heard.action, { kind: "lootWreck", wreckID: WRECK });

  // Once the transfer reports it emptied, nothing else is lootable here.
  const done = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ wreckOwner: COMPANION }),
      chatMessages: [],
      lootFinishedItemIDs: [WRECK],
    }),
    heard.memory,
  );
  assert.equal(done.memory.areaJob, null);
});

test("switching job: 'loot' while salvaging replaces the job rather than stacking", () => {
  // There is one area job, not a queue. The newest order is the one that stands.
  const salvaging = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  assert.equal(salvaging.memory.areaJob, "salvage");
  const switched = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(1_000), { chatMessages: [areaOrder("loot")] }),
    salvaging.memory,
  );
  assert.equal(switched.memory.areaJob, "loot");
});

test("a job is heard even while the pilot is getting safe, so 'stop' always lands", () => {
  // ⚠ THE LATCH IS UPDATED ABOVE THE SUPERVISION GATE. A pilot that is docking
  // itself because nobody is left must still hear a cancel, or an operator who
  // comes back finds a job they called off standing.
  const working = decideCompanionAction(WITH_SALVAGER, salvageObs(salvageGrid(1_000)));
  const whileAlone = decideCompanionAction(
    WITH_SALVAGER,
    alone({
      snapshot: gridWithStation(200_000),
      chatMessages: [areaOrder("stop")],
      fleetCommanderCharacterIDs: [HUMAN],
    }),
    working.memory,
  );
  assert.equal(whileAlone.memory.areaJob, null);
});


test("loot opens ANY wreck, whoever owns it - this is a private server", () => {
  // ⚠ THE OPERATOR'S OWN CALL: "just loot everything. we do not care about
  // ownership. this is private server." The codebase already said the same for
  // containers -- `lootContainers` in the DSL notes the server enforces no
  // ownership check either -- so wrecks were the inconsistent half.
  //
  // ⚠ AND THE GATE THIS REPLACES WAS BROKEN, NOT MERELY STRICT. It allowed a
  // wreck owned by this character or this CORPORATION, but a wreck carries the
  // CHARACTER id of whoever killed it -- so the corp clause could never match,
  // and a companion (which kills nothing) could never attribute one to itself.
  for (const owner of [COMPANION, HUMAN, 90000042, null]) {
    const decision = decideCompanionAction(
      WITH_DRONES,
      obs({
        snapshot: lootGrid({ wreckOwner: owner }),
        chatMessages: [areaOrder("loot")],
      }),
    );
    assert.deepEqual(
      decision.action,
      { kind: "lootWreck", wreckID: WRECK },
      "owner " + String(owner),
    );
  }
});

// --- two pilots on one grid split the work -----------------------------------
//
// ⚠ PREDICTED BEFORE IT WAS SEEN, by the operator: "two pilots will loot now.
// might be interesting race condition." With plain nearest-first both pick the
// SAME nearest can and convoy to it, doing the work of one. Not harmful -- the
// loser finds it emptied and moves on -- but half the fleet is wasted.
//
// The rule is a CLAIM computed from the shared snapshot, not a message: every
// companion runs it over the same data and reaches the same answer about who
// takes what, so they split a field without telling each other anything.

const MATE = 90000007;

/** A grid with two cans and, optionally, a fleet-mate's ship sitting on one. */
/**
 * Two cans and, optionally, a fleet-mate parked on the near one.
 *
 * `nearAt` defaults to INSIDE loot range, so the plain claim tests loot at once
 * rather than flying; the latch tests pass a distance that forces an approach,
 * because a target only stays latched while it is being flown to.
 */
function twoCanGrid(mateAt: { x: number } | null, nearAt = 1_000): SpaceSnapshot {
  const entities: unknown[] = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      characterID: COMPANION,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
    {
      itemID: CAN,
      kind: "container",
      isSelf: false,
      ownerID: null,
      position: { x: nearAt, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
    {
      itemID: CAN_FAR,
      kind: "container",
      isSelf: false,
      ownerID: null,
      // ⚠ THE OTHER SIDE OF THE SHIP, deliberately. With both cans the same
      // way out, a mate parked on the near one is closer to the far one TOO,
      // every candidate is beaten, and the rule correctly falls back to plain
      // nearest -- which would test the fallback instead of the claim.
      position: { x: -30_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
  ];
  if (mateAt !== null) {
    entities.push({
      itemID: 2,
      kind: "ship",
      isSelf: false,
      characterID: MATE,
      position: { x: mateAt.x, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

const CAN_FAR = 300003;

test("alone on the grid, a pilot takes the NEAREST can", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({ snapshot: twoCanGrid(null), chatMessages: [areaOrder("loot")] }),
  );
  assert.deepEqual(decision.action, { kind: "lootContainer", containerID: CAN });
});

test("a fleet-mate sitting on the near can sends this pilot to the FAR one", () => {
  // ⚠ THE WHOLE POINT. The near can is still nearest to us in absolute terms --
  // plain nearest-first would send us there and put two pilots on one can.
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: twoCanGrid({ x: 1_000 }),
      chatMessages: [areaOrder("loot")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION, MATE],
    }),
  );
  assert.deepEqual(
    decision.action,
    { kind: "approach", targetID: CAN_FAR },
    "the near can belongs to the mate parked on it",
  );
});

test("a STRANGER on the near can is not yielded to", () => {
  // Only fleet-mates are coordinated with. Somebody else racing us is not
  // somebody to give way to.
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: twoCanGrid({ x: 1_000 }),
      chatMessages: [areaOrder("loot")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lootContainer", containerID: CAN });
});

test("a pilot beaten to EVERY can still works rather than idling", () => {
  // ⚠ OTHERWISE THE LAST PILOT IN A BIG FLEET SITS STILL. Falling back to the
  // plain nearest means a duplicated trip at worst, which is better than a ship
  // doing nothing at all.
  const grid = twoCanGrid({ x: 1_000 }) as unknown as { entities: unknown[] };
  grid.entities.push({
    itemID: 3,
    kind: "ship",
    isSelf: false,
    characterID: 90000008,
    position: { x: -30_000, y: 0, z: 0 },
    radius: 0,
    mode: null,
  });
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: grid as unknown as SpaceSnapshot,
      chatMessages: [areaOrder("loot")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION, MATE, 90000008],
    }),
  );
  assert.notEqual(decision.action.kind, "wait");
  assert.equal(decision.phase, "Looting");
});

test("an exact tie breaks on character id, so both pilots agree who takes it", () => {
  // Two ships abreast, equidistant from the same can: without a tie-break both
  // claim it or both yield. COMPANION (90000002) is lower than MATE (90000007),
  // so this pilot takes it and the mate -- running the identical rule -- does not.
  const grid = {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, characterID: COMPANION, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: 2, kind: "ship", isSelf: false, characterID: MATE, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: CAN, kind: "container", isSelf: false, ownerID: null, position: { x: 1_000, y: 0, z: 0 }, radius: 0, mode: null },
    ],
  } as unknown as SpaceSnapshot;
  const decision = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: grid,
      chatMessages: [areaOrder("loot")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION, MATE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lootContainer", containerID: CAN });
});

test("salvage splits a field the same way", () => {
  const grid = {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, characterID: COMPANION, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: 2, kind: "ship", isSelf: false, characterID: MATE, position: { x: 2_000, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: WRECK_NEAR, kind: "wreck", isSelf: false, ownerID: null, position: { x: 2_000, y: 0, z: 0 }, radius: 0, mode: null },
      // Opposite side, so the mate on the near wreck is not nearer to this one.
      { itemID: 300099, kind: "wreck", isSelf: false, ownerID: null, position: { x: -30_000, y: 0, z: 0 }, radius: 0, mode: null },
    ],
  } as unknown as SpaceSnapshot;
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    obs({
      snapshot: grid,
      chatMessages: [areaOrder("salvage")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION, MATE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "approach", targetID: 300099, range: 3000 });
});

// --- the fight ends, the drones come home ------------------------------------
//
// ⚠ THIS BRANCH WAS MISSING AND NOTHING ELSE COVERED IT (observed live,
// 2026-09-11: a cleared grid left drones drifting for the rest of the run). The
// hurt-drone cycle needs a hurt drone; the wrong-role recall needs another role
// to want the slots; the flee only recalls on its way out. A fight that simply
// ENDS is none of those.

test("a cleared grid brings the drones home", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      myDroneIDs: [DRONE_A, DRONE_B],
      combatDroneIDs: [DRONE_A, DRONE_B],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "recallDrones",
    droneIDs: [DRONE_A, DRONE_B],
  });
  assert.equal(decision.phase, "Drones");
});

test("a grid we cannot READ does not pull the drones in", () => {
  // ⚠ `hostileOnGrid` is three-state and `null` is "the read failed". Recalling
  // on that would yank drones out of a live fight every time a snapshot
  // stumbled -- the one moment they are most needed.
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: null,
      myDroneIDs: [DRONE_A],
      combatDroneIDs: [DRONE_A],
    }),
  );
  assert.notEqual(decision.action.kind, "recallDrones");
});

test("a still-hostile grid keeps them out", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({ myDroneIDs: [DRONE_A], combatDroneIDs: [DRONE_A] }),
  );
  assert.notEqual(decision.action.kind, "recallDrones");
});

test("nothing out and nothing to do issues no recall at all", () => {
  const decision = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({ hostileOnGrid: false, myDroneIDs: [], combatDroneIDs: [] }),
  );
  assert.notEqual(decision.action.kind, "recallDrones");
});

test("salvage drones come home once the wrecks are gone", () => {
  // The same branch, reached from the other side: the area job cleared itself
  // when the grid ran out of wrecks, so no role is wanted and the drones that
  // were doing it are no longer doing anything.
  const working = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      snapshot: gridWithWreck(),
      chatMessages: [areaOrder("salvage")],
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
    }),
  );
  assert.equal(working.memory.areaJob, "salvage");

  const swept = decideCompanionAction(
    WITH_DRONES,
    mixedBayObs({
      hostileOnGrid: false,
      chatMessages: [],
      myDroneIDs: [SALVAGE_DRONE_OUT],
      salvageDroneIDs: [SALVAGE_DRONE_OUT],
    }),
    working.memory,
  );
  assert.deepEqual(swept.action, {
    kind: "recallDrones",
    droneIDs: [SALVAGE_DRONE_OUT],
  });
});

// --- a chosen can stays chosen ------------------------------------------------
//
// ⚠ OBSERVED LIVE, 2026-09-11: "approached, not looted, chose different
// container to loot". The rung re-picked its target from scratch on every tick,
// and the inputs move underneath it -- this ship's distances change as it
// closes, and the fleet-mate claim flips as another pilot moves -- so the
// nearest-unclaimed can stopped being the same can halfway there. It turned for
// the new one, and arrived at none of them.

test("a can being approached is not abandoned when another becomes nearer", () => {
  // The ship starts nearer CAN, commits to it, and then a fleet-mate parks on
  // CAN -- which is exactly the input that used to make it turn around. The
  // claim rule is consulted when CHOOSING, not on every tick.
  const start = decideCompanionAction(
    WITH_DRONES,
    obs({ snapshot: twoCanGrid(null, 20_000), chatMessages: [areaOrder("loot")] }),
  );
  assert.deepEqual(start.action, { kind: "approach", targetID: CAN });
  assert.equal(start.memory.lootTargetID, CAN);

  const tempted = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: twoCanGrid({ x: 20_000 }, 20_000),
      chatMessages: [areaOrder("loot")],
      fleetMemberCharacterIDs: [HUMAN, COMPANION, MATE],
    }),
    start.memory,
  );
  assert.equal(tempted.memory.lootTargetID, CAN, "it must stay committed");
  // ⚠ STILL THE SAME CAN. It is out of reach and the fixture's ship is not
  // shown moving, so a fresh approach is the RIGHT call here -- what must never
  // happen is that approach naming CAN_FAR, which is what the wander looked
  // like live.
  assert.deepEqual(tempted.action, { kind: "approach", targetID: CAN });
});

test("a can is finished by the OUTCOME, not by having been reached for", () => {
  // ⚠ THE RUNG USED TO MARK IT DONE THE MOMENT IT ASKED. `lootIntoShip` routes
  // each stack to the bay that will take it, and what fits nowhere STAYS IN THE
  // CAN -- so a pilot took one stack of three and flew off, twice, live.
  const asking = decideCompanionAction(
    WITH_DRONES,
    obs({ snapshot: lootGrid({ containerDistance: 100 }), chatMessages: [areaOrder("loot")] }),
  );
  assert.deepEqual(asking.action, { kind: "lootContainer", containerID: CAN });
  assert.equal(asking.memory.lootTargetID, CAN, "still the target until it is empty");
  assert.ok(!asking.memory.lootedItemIDs.includes(CAN));

  // Told it emptied, the rung lets go of it.
  const done = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ containerDistance: 100 }),
      chatMessages: [areaOrder("loot")],
      lootFinishedItemIDs: [CAN],
    }),
    asking.memory,
  );
  assert.notEqual(done.action.kind, "lootContainer");
});

test("a wreck ANOTHER pilot already emptied is never flown to", () => {
  // ⚠ THE FLEET'S WASTE, NOT THIS PILOT'S. Nothing in a snapshot says a wreck is
  // empty -- the server refuses to list one past 2,500 m, and the slim item's
  // `isEmpty` never reaches a web session -- so the question costs whoever asks
  // it the flight there. Each companion keeps its OWN record of what it emptied,
  // which is why a fleet of four used to send four ships to the same wreck, the
  // last three arriving at a hold the first one had already cleared.
  //
  // `lootFinishedItemIDs` is now fed from the BFF's shared loot memory as well
  // as from this pilot's own calls (flow.ts `companionSharedEmpty`), so what one
  // trip found out answers for everybody. This pilot has never touched this
  // wreck: the id arrives from somebody else, and the rung must treat it exactly
  // as it treats its own emptied can.
  const told = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ wreckOwner: COMPANION, wreckDistance: 30_000 }),
      chatMessages: [areaOrder("loot")],
      lootFinishedItemIDs: [WRECK],
    }),
  );
  assert.notEqual(told.action.kind, "approach", "no trip is made for a wreck known to be empty");
  assert.notEqual(told.action.kind, "lootWreck");
  assert.equal(told.memory.lootTargetID, null, "and nothing is latched onto");
  // With the one wreck accounted for there is no work left here, so the job
  // stands down rather than holding a pilot on a picked-clean grid.
  assert.equal(told.memory.areaJob, null);
});

test("a target that leaves the grid is dropped rather than waited on", () => {
  // A jetcan despawns when it is emptied -- by us or by anybody else. The rung
  // must notice it is gone and choose again, not hold a latch on nothing.
  const committed = decideCompanionAction(
    WITH_DRONES,
    obs({ snapshot: twoCanGrid(null, 20_000), chatMessages: [areaOrder("loot")] }),
  );
  assert.equal(committed.memory.lootTargetID, CAN);

  const vanished = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ containerDistance: 40_000 }),
      chatMessages: [areaOrder("loot")],
    }),
    { ...committed.memory, lootTargetID: 999999 },
  );
  assert.equal(vanished.memory.lootTargetID, CAN, "it picks again rather than stalling");
});

// --- the standing `follow` ---------------------------------------------------
//
// Following is the companion's STANDING behaviour: nobody has to type anything
// for it to happen, `follow <N> km` only changes the distance, and the anchor is
// whoever the ROSTER names a commander -- never whoever typed. These tests pin
// where the rung sits (the very bottom) as hard as they pin what it issues,
// because a formation-keeping rung that outranked anything would be a companion
// that answers nothing else.

/** The fleet commander's own ship, on this grid. */
const FC_SHIP = 200010;
/** A second commander's ship, for the re-anchor case. */
const FC_SHIP_2 = 200011;

/**
 * A grid carrying this ship plus one ship per (itemID, characterID) pair.
 * `characterID` is the field `fleetShipsOnGrid` matches the roster on, and
 * `gridWithEntities` above deliberately leaves it unset — which is why every
 * other test's grid anchors nothing.
 */
function gridWithFleetShips(
  ships: readonly { readonly itemID: number; readonly characterID: number }[],
): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      ...ships.map((ship, index) => ({
        itemID: ship.itemID,
        kind: "ship",
        isSelf: false,
        characterID: ship.characterID,
        position: { x: (index + 1) * 5_000, y: 0, z: 0 },
        radius: 0,
        mode: null,
      })),
    ],
  } as unknown as SpaceSnapshot;
}

/** The commander's ship alone on the grid — the ordinary escort case. */
function fcGrid(): SpaceSnapshot {
  return gridWithFleetShips([{ itemID: FC_SHIP, characterID: HUMAN }]);
}

function gridWithAnchor(grid: SpaceSnapshot): SpaceSnapshot {
  return { ...grid, entities: [...grid.entities, ...fcGrid().entities.filter((entity) => !entity.isSelf)] };
}

/**
 * The one field `decideDestinationTrip` reads off flight status. Cast the same
 * way every snapshot helper here is: the rung reads one property and the rest
 * of `FlightStatus` is noise a test should not have to invent.
 */
function inSystem(solarSystemID: number | null): FleetCompanionObservation["flightStatus"] {
  return { solarSystemID } as unknown as FleetCompanionObservation["flightStatus"];
}

/** The default escort distance, mirrored from the parser that owns it. */
const DEFAULT_FOLLOW_M = 2000;

test("with nobody saying anything, a companion holds station on its commander", () => {
  // ⚠ THE STANDING HALF. No chat at all: following is what a companion does
  // when nothing above it is acting, not something it is told to start.
  const decision = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  assert.deepEqual(decision.action, {
    kind: "keepAtRange",
    targetID: FC_SHIP,
    range: DEFAULT_FOLLOW_M,
  });
  assert.equal(decision.phase, "Following");
});

test("the keepAtRange goes out ONCE and is not re-sent on the next tick", () => {
  // ⚠ `CmdFollowBall` IS A STANDING SERVER-SIDE ORDER. Re-sending it every tick
  // would spend the loop's one call per tick telling the server what it is
  // already doing, and starve every rung beneath -- of which there are none, but
  // the bridge traffic alone is the reason.
  const first = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  assert.equal(first.action.kind, "keepAtRange");

  const second = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }), first.memory);
  assert.equal(second.action.kind, "wait");
  assert.equal(second.phase, "Following", "the readout still says what it is doing");
});

test("formation retries definite refusals but does not spend its budget on session changes", async () => {
  for (const code of ["CALL_REFUSED", "SESSION_CHANGE_IN_PROGRESS"]) {
    let calls = 0;
    const refusedCalls = code === "CALL_REFUSED" ? 1 : 5;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => obs({ snapshot: fcGrid() }),
      issue: async () => {
        calls += 1;
        if (calls <= refusedCalls) throw Object.assign(new Error("Follow refused"), { code });
      },
    }).deps);
    companion.start(REQUEST);
    const ticks = code === "SESSION_CHANGE_IN_PROGRESS" ? refusedCalls * 2 + 1 : refusedCalls + 1;
    for (let tick = 0; tick < ticks; tick += 1) await companion.tick();
    assert.equal((await companion.tick()).kind, "wait");
    assert.equal(calls, refusedCalls + 1, code);
  }
});

test("formation ordinary refusals are bounded and ambiguous responses are never replayed", async () => {
  for (const code of ["CALL_REFUSED", "BRIDGE_NETWORK_ERROR"]) {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => obs({ snapshot: fcGrid() }),
      issue: async () => { calls += 1; throw Object.assign(new Error("Follow failed"), { code }); },
    }).deps);
    companion.start(REQUEST);
    for (let tick = 0; tick < 8; tick += 1) await companion.tick();
    assert.equal(calls, code === "CALL_REFUSED" ? 3 : 1, code);
    assert.equal(companion.snapshot().status, "paused", code);
  }
});

for (const job of ["combat", "repair", "follow"] as const) {
  test(`${job} session-change deferrals are bounded with read-only ticks between writes`, async () => {
    let calls = 0;
    const companion = createFleetCompanion(makeDeps({
      observe: async () => job === "follow" ? obs({ snapshot: fcGrid() }) : engagementObs(job),
      issue: async () => { calls += 1; throw Object.assign(new Error("Session never becomes ready"), {
        code: "SESSION_CHANGE_IN_PROGRESS",
      }); },
    }).deps);
    companion.start(REQUEST);
    for (let tick = 0; tick < 100; tick += 1) {
      const before = calls;
      await companion.tick();
      if (calls > before && companion.snapshot().status === "running") {
        await companion.tick();
        assert.equal(calls, before + 1, "the following read must not write again");
      }
    }
    assert.equal(calls, 30);
    assert.equal(companion.snapshot().status, "paused");
  });
  for (const interruption of ["pause", "restart"] as const) {
    for (const outcomeKind of ["success", "CALL_REFUSED", "SESSION_CHANGE_IN_PROGRESS", "BRIDGE_NETWORK_ERROR"]) {
      test(`${job} ${outcomeKind} settles only its own pending record across ${interruption}`, async () => {
        const began = deferred<void>();
        const outcome = deferred<void>();
        let calls = 0;
        const companion = createFleetCompanion(makeDeps({
          observe: async () => job === "follow" ? obs({ snapshot: fcGrid() }) : engagementObs(job),
          issue: async () => {
            calls += 1;
            if (calls === 1) { began.resolve(); await outcome.promise; }
          },
        }).deps);
        companion.start(REQUEST);
        const first = companion.tick();
        await began.promise;
        if (interruption === "pause") { companion.pause(); companion.resume(); }
        else { companion.stop(); companion.start(REQUEST); }
        if (outcomeKind === "success") outcome.resolve();
        else outcome.reject(Object.assign(new Error("Deferred command failed"), { code: outcomeKind }));
        await first;
        let next = await companion.tick();
        if (interruption === "pause" && outcomeKind === "SESSION_CHANGE_IN_PROGRESS") {
          assert.equal(next.kind, "wait", "a deferral gets a fresh read-only tick before retry");
          assert.equal(calls, 1);
          next = await companion.tick();
        }
        if (interruption === "restart" || outcomeKind === "CALL_REFUSED" || outcomeKind === "SESSION_CHANGE_IN_PROGRESS") {
          assert.equal(next.kind, job === "follow" ? "keepAtRange" : "engageDrones");
          assert.equal(calls, 2);
          assert.equal(companion.snapshot().status, "running");
          assert.equal((await companion.tick()).kind, "wait");
        } else if (outcomeKind === "success") {
          assert.equal(next.kind, "wait");
          assert.equal(calls, 1);
          assert.equal(companion.snapshot().status, "running");
        } else {
          assert.equal(next.kind, "wait");
          assert.equal(calls, 1);
          assert.equal(companion.snapshot().status, "paused");
        }
      });
    }
  }
}

test("formation is restored after fleet warp observed while another rung cannot run", () => {
  const following = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  const warping = decideCompanionAction(REQUEST, obs({
    inWarp: true, snapshot: null, fleetMemberCharacterIDs: null,
  }), following.memory);
  assert.equal(warping.phase, "In warp");
  const landedGrid = fcGrid();
  const landed = decideCompanionAction(REQUEST, obs({
    snapshot: { ...landedGrid, ship: { ...landedGrid.ship!, mode: "STOP" } },
  }), warping.memory);
  assert.deepEqual(landed.action, { kind: "keepAtRange", targetID: FC_SHIP, range: DEFAULT_FOLLOW_M });
  const held = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }), landed.memory);
  assert.equal(held.action.kind, "wait");
});

test("a completed loot approach restores formation without needing a new follow command", () => {
  const following = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  const approach = decideCompanionAction(REQUEST, obs({
    snapshot: gridWithAnchor(lootGrid({ containerDistance: 40_000 })),
    chatMessages: [areaOrder("loot")],
  }), following.memory);
  assert.deepEqual(approach.action, { kind: "approach", targetID: CAN });
  const looted = decideCompanionAction(REQUEST, obs({
    snapshot: gridWithAnchor(lootGrid({ containerDistance: 500 })),
    chatMessages: [],
  }), approach.memory);
  assert.deepEqual(looted.action, { kind: "lootContainer", containerID: CAN });
  const cleared = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(), chatMessages: [] }), looted.memory);
  assert.deepEqual(cleared.action, { kind: "keepAtRange", targetID: FC_SHIP, range: DEFAULT_FOLLOW_M });
});

test("a completed salvage approach restores formation after the wreck disappears", () => {
  const following = decideCompanionAction(WITH_SALVAGER, obs({ snapshot: fcGrid() }));
  const approach = decideCompanionAction(WITH_SALVAGER,
    salvageObs(gridWithAnchor(salvageGrid(30_000))), following.memory);
  assert.equal(approach.action.kind, "approach");
  const locked = decideCompanionAction(WITH_SALVAGER,
    salvageObs(gridWithAnchor(salvageGrid(1_000)), { chatMessages: [] }), approach.memory);
  assert.deepEqual(locked.action, { kind: "lock", targetID: WRECK_NEAR });
  const working = decideCompanionAction(WITH_SALVAGER,
    salvageObs(gridWithAnchor(salvageGrid(1_000)), { chatMessages: [], lockedTargetIDs: [WRECK_NEAR] }), locked.memory);
  assert.equal(working.action.kind, "activate");
  const cleared = decideCompanionAction(WITH_SALVAGER,
    salvageObs(fcGrid(), { chatMessages: [] }), working.memory);
  assert.deepEqual(cleared.action, { kind: "keepAtRange", targetID: FC_SHIP, range: DEFAULT_FOLLOW_M });
});

for (const code of ["CALL_REFUSED", "BRIDGE_NETWORK_ERROR"]) {
  test(`formation resumes once after a superseding warp ends despite ${code}, without replaying warp`, async () => {
    let current = obs({ snapshot: gridWithAnchor(gridWithEntities([LOGI])) });
    const issued: FleetCompanionAction[] = [];
    const companion = createFleetCompanion({
      observe: async () => current,
      issue: async (action) => {
        issued.push(action);
        if (action.kind === "warp") throw Object.assign(new Error("Warp response failed"), { code });
      },
      now: () => 1_000,
      sleep: async () => {},
    });
    companion.start(REQUEST);
    assert.equal((await companion.tick()).kind, "keepAtRange");
    current = { ...current, fleetBroadcast: fleetBroadcast("WarpTo", LOGI) };
    await companion.tick();
    await companion.tick();
    assert.equal(issued.filter((action) => action.kind === "warp").length, 1);
    current = { ...current, fleetBroadcast: null };
    assert.equal((await companion.tick()).kind, "keepAtRange");
    assert.equal((await companion.tick()).kind, "wait");
    assert.equal(issued.filter((action) => action.kind === "keepAtRange").length, 2);
  });
}

test("a NEW anchor re-issues: the fleet changed commander, the companion re-forms", () => {
  const first = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  const reanchored = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithFleetShips([{ itemID: FC_SHIP_2, characterID: 90000007 }]),
      fleetMemberCharacterIDs: [HUMAN, COMPANION, 90000007],
      fleetCommanderCharacterIDs: [90000007],
    }),
    first.memory,
  );
  assert.deepEqual(reanchored.action, {
    kind: "keepAtRange",
    targetID: FC_SHIP_2,
    range: DEFAULT_FOLLOW_M,
  });
});

test("a NEW range re-issues against the same anchor", () => {
  const first = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid() }));
  const closer = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("follow 10 km", HUMAN, 2_000)] }),
    first.memory,
  );
  assert.deepEqual(closer.action, { kind: "keepAtRange", targetID: FC_SHIP, range: 10_000 });

  // And then holds there without re-sending it.
  const held = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("follow 10 km", HUMAN, 2_000)] }),
    closer.memory,
  );
  assert.equal(held.action.kind, "wait");
  assert.equal(held.phase, "Following");
});

test("the range a 'follow' named outlives the message that carried it", () => {
  // Same latch rule as an area job: a heard order changes it, silence does not.
  const heard = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("follow 10 km", HUMAN)] }),
  );
  assert.equal(heard.memory.followRangeM, 10_000);

  const silent = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [] }),
    heard.memory,
  );
  assert.equal(silent.memory.followRangeM, 10_000, "silence must not reset the distance");
});

test("a 'follow' from someone who is NOT a commander changes nothing", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("follow 100 km", UNLISTED_SENDER)] }),
  );
  assert.deepEqual(decision.action, {
    kind: "keepAtRange",
    targetID: FC_SHIP,
    range: DEFAULT_FOLLOW_M,
  });
});

test("in warp, docked, or with an unread roster, the follow rung issues nothing", () => {
  // ⚠ EACH OF THE THREE IS REFUSED BY A DIFFERENT RUNG, and only the middle one
  // is refused by the follow rung's own gates. Rung 1 takes the warp; the
  // supervision gate takes the unread roster (which is why `decideFollow`'s own
  // roster check is belt and braces -- see its comment). What is worth pinning
  // is the OUTCOME: none of the three puts a `keepAtRange` on the wire.
  for (const blind of [
    obs({ snapshot: fcGrid(), inWarp: true }),
    obs({ snapshot: null, inSpace: false, docked: true }),
    obs({ snapshot: fcGrid(), fleetMemberCharacterIDs: null }),
  ]) {
    const decision = decideCompanionAction(REQUEST, blind);
    assert.notEqual(decision.action.kind, "keepAtRange", JSON.stringify({ inWarp: blind.inWarp }));
  }
});

test("no commander on this grid means no anchor, and never a substitute one", () => {
  // ⚠ A fleet-mate who is not in charge is NOT the anchor. A companion whose FC
  // has not landed yet stands by rather than forming up on whoever is nearest.
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithFleetShips([{ itemID: FC_SHIP_2, characterID: 90000007 }]) }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Standing by");
});

test("an unreadable commander list anchors nothing — null is never 'anybody'", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), fleetCommanderCharacterIDs: null }),
  );
  assert.equal(decision.phase, "Standing by");
});

test("follow is BENEATH everything — a target call to obey wins the tick", () => {
  // The rung moves the ship for ever, so it sits at the very bottom. A
  // companion with a call to answer answers it; formation waits.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithFleetShips([
        { itemID: FC_SHIP, characterID: HUMAN },
        { itemID: TACKLE, characterID: 90000008 },
      ]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

// --- the `destination` trip ---------------------------------------------------
//
// The operator's words: "Companion sets destination and travels to it without
// additional interruption, unless stop is written in chat. It stops where it
// is." That sentence is why this rung is the ONE thing in the ladder that
// outranks the fleet's own calls — and why it still sits below the flee.

test("'destination <id>' latches and hands the route to the autopilot, once", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  assert.deepEqual(first.action, { kind: "travelTo", systemID: SYSTEM_B });
  assert.equal(first.memory.destinationSystemID, SYSTEM_B);
  assert.equal(first.followingOrderFrom, "chat");

  // ⚠ The route runs on the SHARED autopilot, a separate decide-loop. Re-issuing
  // would restart the solver twice a second.
  const riding = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [] }),
    first.memory,
  );
  assert.equal(riding.action.kind, "wait");
  assert.equal(riding.phase, "Travelling", "a multi-jump ride must not report Standing by");
  assert.equal(riding.memory.destinationSystemID, SYSTEM_B, "silence does not cancel a trip");
});

test("'destination <link>' is the same order, written the other way", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine(chatCommandText("destination", SYSTEM_B), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "travelTo", systemID: SYSTEM_B });
});

test("a trip is NOT derailed by a Target broadcast arriving mid-route", () => {
  // ⚠ THE WHOLE POINT OF THE RUNG'S PLACEMENT. "Without additional
  // interruption" means the fleet's own calls do not win while a trip stands;
  // beneath rung 7 this companion would stop two jumps out to lock something.
  const started = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const called = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithFleetShips([
        { itemID: FC_SHIP, characterID: HUMAN },
        { itemID: TACKLE, characterID: 90000008 },
      ]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages: [],
    }),
    started.memory,
  );
  assert.equal(called.action.kind, "wait");
  assert.equal(called.phase, "Travelling");
  assert.notEqual(called.action.kind, "lock");
});

test("a trip still yields to the flee — a dying companion leaves, it does not keep flying", () => {
  // ⚠ THE DELIBERATE NARROW READING OF "without additional interruption": do not
  // be distracted by the fleet's calls, NOT keep flying while the ship dies.
  const grid = gridWithFleetShips([{ itemID: FC_SHIP, characterID: HUMAN }]) as unknown as {
    entities: unknown[];
  };
  grid.entities.push({
    itemID: 60000001,
    kind: "station",
    isSelf: false,
    position: { x: 200_000, y: 0, z: 0 },
    radius: 0,
    mode: null,
  });
  const started = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: grid as unknown as SpaceSnapshot,
      chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)],
    }),
  );
  assert.equal(started.memory.destinationSystemID, SYSTEM_B);

  const dying = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: grid as unknown as SpaceSnapshot,
      chatMessages: [],
      shieldRatio: 0.05,
      armorRatio: 0.05,
      hullRatio: 0.05,
      health: 0.05,
    }),
    started.memory,
  );
  assert.equal(dying.phase, "Getting clear");
  assert.deepEqual(dying.action, { kind: "warp", targetID: 60000001 });
  // ⚠ AND THE TRIP IS NOT LOST, ONLY OUTRANKED. Nothing about being hurt says
  // the operator changed their mind about where this pilot was going.
  assert.equal(dying.memory.destinationSystemID, SYSTEM_B);
});

test("arriving clears the trip, and the companion goes back to its own ladder", () => {
  const started = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const arrived = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [], flightStatus: inSystem(SYSTEM_B) }),
    started.memory,
  );
  assert.equal(arrived.memory.destinationSystemID, null);
  assert.notEqual(arrived.phase, "Travelling");
});

test("a flight status that cannot say where the ship is leaves the trip standing", () => {
  // "Could not tell" is never "not there yet" and never "arrived". The trip
  // stands rather than ending on a read that failed.
  const started = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const unreadable = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [], flightStatus: inSystem(null) }),
    started.memory,
  );
  assert.equal(unreadable.memory.destinationSystemID, SYSTEM_B);
  assert.equal(unreadable.phase, "Travelling");
});

test("a NEW destination replaces the old one and routes again", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const changed = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine("destination " + SYSTEM_C, HUMAN, 5_000)],
    }),
    first.memory,
  );
  assert.deepEqual(changed.action, { kind: "travelTo", systemID: SYSTEM_C });
});

test("a 'destination' from someone who is NOT a commander starts nothing", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine("destination " + SYSTEM_B, UNLISTED_SENDER)],
    }),
  );
  assert.notEqual(decision.action.kind, "travelTo");
  assert.equal(decision.memory.destinationSystemID, null);
});

// --- `stop`: the one word that calls all of it off ---------------------------

test("'stop' cancels the trip, halts the ship, and suspends the standing follow", () => {
  const riding = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  assert.equal(riding.memory.destinationSystemID, SYSTEM_B);

  const stopped = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("stop", HUMAN, 5_000)] }),
    riding.memory,
  );
  assert.deepEqual(stopped.action, { kind: "stopShip" });
  assert.equal(stopped.memory.destinationSystemID, null, "the trip is off");
  assert.equal(stopped.memory.followHeld, true, "and the formation is suspended");
});

test("the stopShip goes out ONCE per 'stop' heard, not once per tick it is fresh", () => {
  // ⚠ A chat line stands for its whole freshness window. A ship told to stop
  // every two seconds for thirty seconds is a ship nothing else can move.
  const chatMessages = [chatLine("stop", HUMAN, 5_000)];
  const first = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(), chatMessages }));
  assert.deepEqual(first.action, { kind: "stopShip" });

  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "stopShip");
});

test("two stop messages in an unchanged backlog do not restart the stop each tick", () => {
  const observation = obs({ snapshot: fcGrid(), chatMessages:
    [chatLine("stop", HUMAN, 1_000), chatLine("stop", HUMAN, 2_000)] });
  let memory = freshLadderMemory();
  const actions: FleetCompanionAction[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const result = decideCompanionAction(REQUEST, observation, memory);
    memory = result.memory;
    actions.push(result.action);
  }
  assert.equal(actions.filter((action) => action.kind === "stopShip").length, 1);
  assert.equal(memory.followHeld, true);
});

test("an old stop and newer destination route once across repeated backlog reads", () => {
  const observation = obs({ snapshot: fcGrid(), flightStatus: inSystem(SYSTEM_C),
    chatMessages: [chatLine("stop", HUMAN, 1_000), chatLine(`destination ${SYSTEM_B}`, HUMAN, 2_000)] });
  let memory = freshLadderMemory();
  const actions: FleetCompanionAction[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const result = decideCompanionAction(REQUEST, observation, memory);
    memory = result.memory;
    actions.push(result.action);
  }
  assert.equal(actions.filter((action) => action.kind === "stopShip").length, 1);
  assert.equal(actions.filter((action) => action.kind === "travelTo").length, 1);
  assert.equal(memory.destinationSystemID, SYSTEM_B);
  const arrived = decideCompanionAction(REQUEST, { ...observation, flightStatus: inSystem(SYSTEM_B) }, memory);
  assert.equal(arrived.memory.destinationSystemID, null);
  const departed = decideCompanionAction(REQUEST, observation, arrived.memory);
  assert.equal(departed.memory.destinationSystemID, null, "the already completed command must not restart a trip");
});

test("new command identities sharing a timestamp are heard once each", () => {
  const otherCommander = 90000003;
  const base = obs({ snapshot: fcGrid(), fleetCommanderCharacterIDs: [HUMAN, otherCommander] });
  const stopped = decideCompanionAction(REQUEST, { ...base, chatMessages: [chatLine("stop", HUMAN, 1_000)] });
  const followed = decideCompanionAction(REQUEST, { ...base, chatMessages:
    [chatLine("stop", HUMAN, 1_000), chatLine("follow 5 km", HUMAN, 1_000)] }, stopped.memory);
  assert.deepEqual(followed.action, { kind: "keepAtRange", targetID: FC_SHIP, range: 5_000 });
  const stoppedAgain = decideCompanionAction(REQUEST, { ...base, chatMessages:
    [chatLine("stop", HUMAN, 1_000), chatLine("follow 5 km", HUMAN, 1_000), chatLine("stop", otherCommander, 1_000)] }, followed.memory);
  assert.deepEqual(stoppedAgain.action, { kind: "stopShip" });
  const repeated = decideCompanionAction(REQUEST, { ...base, chatMessages:
    [chatLine("stop", otherCommander, 1_000), chatLine("follow 5 km", HUMAN, 1_000), chatLine("stop", HUMAN, 1_000)] }, stoppedAgain.memory);
  assert.notEqual(repeated.action.kind, "stopShip");
  assert.equal(repeated.memory.followHeld, true);
});

test("an unauthorized newer line does not hide a commander's order", () => {
  const ignored = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(),
    chatMessages: [chatLine("stop", UNLISTED_SENDER, 9_000)] }));
  const authorized = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(),
    chatMessages: [chatLine("stop", HUMAN, 5_000), chatLine("stop", UNLISTED_SENDER, 9_000)] }), ignored.memory);
  assert.deepEqual(authorized.action, { kind: "stopShip" });
});

test("a delayed old command cannot undo a newer standing instruction", () => {
  const following = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(),
    chatMessages: [chatLine("follow 5 km", HUMAN, 9_000)] }));
  const delayed = decideCompanionAction(REQUEST, obs({ snapshot: fcGrid(),
    chatMessages: [chatLine("stop", HUMAN, 5_000), chatLine("follow 5 km", HUMAN, 9_000)] }), following.memory);
  assert.notEqual(delayed.action.kind, "stopShip");
  assert.equal(delayed.memory.followHeld, false);
});

test("fresh props-off history preserves the pending deactivate latch", () => {
  const module = { itemID: 12500001, typeID: 12500002, kind: "afterburner" as const };
  const request = { ...REQUEST, propulsionModules: [module] };
  const snapshot = { ...fcGrid(), ship: { ...fcGrid().ship!, activeModuleIDs: [module.itemID] } };
  const observation = obs({ snapshot, chatMessages: [chatLine("props off", HUMAN)] });
  const first = decideCompanionAction(request, observation);
  assert.equal(first.action.kind, "deactivate");
  const second = decideCompanionAction(request, observation, first.memory);
  assert.notEqual(second.action.kind, "deactivate");
  assert.equal(second.memory.propsStoppingID, module.itemID);
});

test("a completed area order is not replayed when another wreck appears", () => {
  const messages = [chatLine("salvage", HUMAN)];
  const working = decideCompanionAction(REQUEST, obs({ snapshot: gridWithEntities([TACKLE]),
    chatMessages: messages }));
  // There are no wrecks to work, so that area job already completed.
  assert.equal(working.memory.areaJob, null);
  const snapshot = gridWithEntities([]) as unknown as { entities: unknown[] };
  snapshot.entities.push({ itemID: 300002, kind: "wreck", isSelf: false,
    position: { x: 1000, y: 0, z: 0 }, radius: 0 });
  const later = decideCompanionAction(REQUEST, obs({ snapshot: snapshot as unknown as SpaceSnapshot,
    chatMessages: messages }), working.memory);
  assert.equal(later.memory.areaJob, null);
});

test("a suspended follow stays suspended — nothing but a 'follow' brings it back", () => {
  const stopped = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("stop", HUMAN, 5_000)] }),
  );
  // The order ages out of the window; the hold does not age with it.
  const quiet = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [] }),
    stopped.memory,
  );
  assert.notEqual(quiet.action.kind, "keepAtRange");
  assert.equal(quiet.phase, "Standing by");
  assert.equal(quiet.memory.followHeld, true);
});

test("a later 'follow' resumes the standing behaviour — the operator's own resume", () => {
  const stopped = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("stop", HUMAN, 5_000)] }),
  );
  const resumed = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("follow 5 km", HUMAN, 9_000)] }),
    stopped.memory,
  );
  assert.deepEqual(resumed.action, { kind: "keepAtRange", targetID: FC_SHIP, range: 5_000 });
  assert.equal(resumed.memory.followHeld, false);
});

test("order within one backlog is decided by timestamp, not by reading order", () => {
  // ⚠ THE REASON THE LATCH REPLAYS THE BACKLOG IN TIME ORDER. Both lines are
  // visible on the same tick; the LAST thing said is what stands, per latch.
  const stopThenFollow = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine("follow 5 km", HUMAN, 9_000), chatLine("stop", HUMAN, 5_000)],
    }),
  );
  assert.equal(stopThenFollow.memory.followHeld, false, "the follow is newer, so it stands");
  assert.equal(stopThenFollow.memory.followRangeM, 5_000);

  const followThenStop = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine("follow 5 km", HUMAN, 5_000), chatLine("stop", HUMAN, 9_000)],
    }),
  );
  assert.equal(followThenStop.memory.followHeld, true, "the stop is newer, so it wins");
  assert.deepEqual(followThenStop.action, { kind: "stopShip" });
});

test("'stop' from someone who is NOT a commander stops nothing", () => {
  const riding = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const ignored = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("stop", UNLISTED_SENDER, 5_000)] }),
    riding.memory,
  );
  assert.notEqual(ignored.action.kind, "stopShip");
  assert.equal(ignored.memory.destinationSystemID, SYSTEM_B);
  assert.equal(ignored.memory.followHeld, false);
});

test("a re-typed 'destination' after a 'stop' routes again rather than sitting still", () => {
  // ⚠ THE BUG A SHARED `lastRoutedSystemID` WOULD HAVE CAUSED. `stop` clears the
  // job but could not clear rung 7's record of the route, so the same system
  // named twice would have found itself already routed and issued nothing.
  const riding = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const stopped = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("stop", HUMAN, 5_000)] }),
    riding.memory,
  );
  const again = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN, 9_000)] }),
    stopped.memory,
  );
  assert.deepEqual(again.action, { kind: "travelTo", systemID: SYSTEM_B });
});

test("a 'stop' is still heard while the pilot is getting safe", () => {
  // Same reason the area latch is updated above the supervision gate: an
  // operator who calls a trip off must not find it standing when they come back.
  const riding = decideCompanionAction(
    REQUEST,
    obs({ snapshot: fcGrid(), chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)] }),
  );
  const whileAlone = decideCompanionAction(
    REQUEST,
    alone({
      snapshot: gridWithStation(200_000),
      chatMessages: [chatLine("stop", HUMAN, 5_000)],
      fleetCommanderCharacterIDs: [HUMAN],
    }),
    riding.memory,
  );
  assert.equal(whileAlone.memory.destinationSystemID, null);
  assert.equal(whileAlone.memory.followHeld, true);
});

// --- the reload rung ---------------------------------------------------------
//
// ⚠ NOTHING RELOADS A PLAYER'S GUNS ON THIS SERVER -- the charge item is removed
// outright when the last round is spent and no auto-reload path reaches a player
// turret. See `decideReload`'s own header for the call sites. That is why these
// tests are about a rung existing at all, and why it sits above the fleet's own
// target calls: a companion answering a call with an empty rack is answering
// nothing.

/** Synthetic gun item ids, distinct from the fire rung's rack above. */
const AUTOCANNON = 11500001;
const AUTOCANNON_2 = 11500002;
const LAUNCHER = 11500003;

/**
 * Synthetic charge GROUP ids. Deliberately not real ones: the ladder never looks
 * a group up, it only tests membership of the list the observation carries, so a
 * real id would suggest a table this file consults and does not.
 */
const PROJECTILE_GROUP = 700;
const MISSILE_GROUP = 701;

/** Synthetic charge stack item ids, in the cargo bay. */
const SLUGS = 12000001;
const SLUGS_FEW = 12000002;
const ROCKETS = 12000003;
const SLUGS_TIED_HIGH = 12000005;
const SLUGS_TIED_LOW = 12000004;

function charge(
  itemID: number,
  quantity: number,
  groupID: number | null,
): CompanionCargoCharge {
  // The type id is carried by the shape and read by nothing in the ladder -- the
  // stack is named to the server by ITEM id -- so it is derived from the item id
  // rather than invented per test.
  return { itemID, typeID: itemID + 100_000, groupID, quantity };
}

/** A rack of guns fitted to this hull, so the reload rung has weapons to be empty. */
const ARMED: FleetCompanionRequest = {
  ...REQUEST,
  weaponModuleIDs: [AUTOCANNON, AUTOCANNON_2, LAUNCHER],
};

test("an empty gun with matching ammunition in cargo is reloaded from cargo", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });
  assert.equal(decision.phase, "Reloading");
  assert.equal(decision.memory.reloadAttempts[AUTOCANNON], 1);
});

test("with several compatible stacks it takes the LARGEST -- the operator's own rule", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [
        charge(SLUGS_FEW, 50, PROJECTILE_GROUP),
        charge(SLUGS, 500, PROJECTILE_GROUP),
        // ⚠ THE BIGGEST STACK ABOARD, AND IT IS NOT PICKED: compatibility ranks
        // first, and only a rack that matches NOTHING falls back to size alone.
        charge(ROCKETS, 9_000, MISSILE_GROUP),
      ],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });
});

test("two stacks of the same size break the tie on the LOWER item id, every tick", () => {
  // ⚠ NOT COSMETIC. Without a second key the pick would follow whatever order
  // the cargo read returned, which is neither stable across ticks nor assertable
  // here -- and a gun that chose differently each tick would break the banking.
  const cargo = [
    charge(SLUGS_TIED_HIGH, 300, PROJECTILE_GROUP),
    charge(SLUGS_TIED_LOW, 300, PROJECTILE_GROUP),
  ];
  const first = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: cargo,
    }),
  );
  const reversed = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [...cargo].reverse(),
    }),
  );
  const expected = {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS_TIED_LOW,
  };
  assert.deepEqual(first.action, expected);
  assert.deepEqual(reversed.action, expected, "the cargo read's order must not decide this");
});

test("nothing matches by group, so it loads the largest stack aboard anyway", () => {
  // ⚠ THE RULE `chargeLooksCompatible` STATES FOR ITSELF: the table is advisory,
  // the SERVER decides what loads, and hiding a charge that would have worked is
  // the worse failure. The attempt budget is what bounds a wrong guess.
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(ROCKETS, 120, MISSILE_GROUP)],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: ROCKETS,
  });
});

test("a stack whose group could not be decoded is NEUTRAL, never a no", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 10, null)],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });
});

test("a gun with no entry in the group map is loaded too -- 'cannot say' is not 'no'", () => {
  const noEntry = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      // The fit was read, and it said nothing about THIS module's charges.
      weaponChargeGroups: {},
      cargoCharges: [charge(SLUGS_FEW, 50, PROJECTILE_GROUP), charge(ROCKETS, 120, MISSILE_GROUP)],
    }),
  );
  assert.deepEqual(noEntry.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: ROCKETS,
  });

  // And the same when the whole map is unreadable.
  const noMap = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: null,
      cargoCharges: [charge(SLUGS_FEW, 50, PROJECTILE_GROUP), charge(ROCKETS, 120, MISSILE_GROUP)],
    }),
  );
  assert.deepEqual(noMap.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: ROCKETS,
  });
});

test("a bank of guns that chose the same stack is ONE call, not one per gun", () => {
  // ⚠ THIS LOOP ISSUES ONE ATOMIC CALL PER TICK. Eight guns loaded one a tick is
  // sixteen seconds of a ship shooting nothing, and `api.loadAmmo` takes a list.
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON, AUTOCANNON_2],
      weaponChargeGroups: {
        [AUTOCANNON]: [PROJECTILE_GROUP],
        [AUTOCANNON_2]: [PROJECTILE_GROUP],
      },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON, AUTOCANNON_2],
    chargeItemID: SLUGS,
  });
});

test("a gun that chose a DIFFERENT stack waits for its own tick", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON, LAUNCHER],
      weaponChargeGroups: {
        [AUTOCANNON]: [PROJECTILE_GROUP],
        [LAUNCHER]: [MISSILE_GROUP],
      },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP), charge(ROCKETS, 120, MISSILE_GROUP)],
    }),
  );
  assert.deepEqual(decision.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });
});

test("no empty guns, nothing to do", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.notEqual(decision.action.kind, "loadAmmo");
  assert.equal(decision.phase, "Standing by");
});

test("empty guns and an EMPTY cargo bay are said out loud, not passed over in silence", () => {
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON, AUTOCANNON_2],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [],
    }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Out of ammunition");
  assert.match(decision.why, /nothing in the cargo bay/i);
});

test("the dry-guns readout never suppresses a rung that has something to ISSUE", () => {
  // ⚠ WHY THE READOUT IS CONSULTED LAST THOUGH ITS RUNG SITS HIGH. It is a
  // sentence, never a call; ahead of the follow rung it would stop a companion
  // re-anchoring for as long as its guns were dry.
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: fcGrid(),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [],
    }),
  );
  assert.equal(decision.action.kind, "keepAtRange");
});

test("a fit or a cargo bay that could not be READ is silence, never a claim", () => {
  // ⚠ THREE-STATE, BOTH OF THEM. `null` is "could not read": not a ship whose
  // guns are all loaded, and not a ship with nothing aboard to load them with.
  const unreadFit = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: null,
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.equal(unreadFit.phase, "Standing by");

  const unreadCargo = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: null,
    }),
  );
  assert.equal(unreadCargo.phase, "Standing by", "an unopened cargo bay is not an empty one");
});

test("in warp and docked, nothing is loaded", () => {
  const ammo = {
    emptyWeaponModuleIDs: [AUTOCANNON],
    weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
    cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
  };
  const warping = decideCompanionAction(
    ARMED,
    obs({ snapshot: gridWithStation(null), inWarp: true, ...ammo }),
  );
  assert.equal(warping.phase, "In warp");

  const docked = decideCompanionAction(
    ARMED,
    obs({ snapshot: null, inSpace: false, docked: true, ...ammo }),
  );
  assert.notEqual(docked.action.kind, "loadAmmo");
});

test("a gun that LEFT the empty list is not reloaded again, and gets its budget back", () => {
  // ⚠ THE CONFIRMATION, AND THE ONLY ONE THERE IS. The call's own ack says
  // nothing -- the server refuses in words this layer never sees -- so a gun
  // leaving `emptyWeaponModuleIDs` is what proves the load landed.
  const loaded = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.equal(loaded.memory.reloadAttempts[AUTOCANNON], 1);

  const confirmed = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(null),
      emptyWeaponModuleIDs: [],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 400, PROJECTILE_GROUP)],
    }),
    loaded.memory,
  );
  assert.notEqual(confirmed.action.kind, "loadAmmo");
  assert.equal(
    confirmed.memory.reloadAttempts[AUTOCANNON],
    undefined,
    "a gun that reloaded may run dry again, so its budget goes back to full",
  );
});

test("a gun nothing aboard will fit is given up on, and the next gun still gets loaded", () => {
  // Three calls and then this gun is left alone -- `MAX_COMPANION_RELOAD_ATTEMPTS`,
  // the same bound and the same reasoning as the tag rung's.
  const ammo = {
    snapshot: gridWithStation(null),
    emptyWeaponModuleIDs: [AUTOCANNON, LAUNCHER],
    weaponChargeGroups: {
      [AUTOCANNON]: [PROJECTILE_GROUP],
      [LAUNCHER]: [MISSILE_GROUP],
    },
    cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP), charge(ROCKETS, 120, MISSILE_GROUP)],
  };
  let memory: CompanionLadderMemory = freshLadderMemory();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = decideCompanionAction(ARMED, obs(ammo), memory);
    assert.deepEqual(
      decision.action,
      { kind: "loadAmmo", moduleIDs: [AUTOCANNON], chargeItemID: SLUGS },
      `attempt ${attempt} still belongs to the first gun`,
    );
    memory = decision.memory;
  }
  // ⚠ IT MOVES ON RATHER THAN ENDING THE TICK. One gun that cannot be loaded
  // must not hold the rest of the rack empty.
  const nextGun = decideCompanionAction(ARMED, obs(ammo), memory);
  assert.deepEqual(nextGun.action, {
    kind: "loadAmmo",
    moduleIDs: [LAUNCHER],
    chargeItemID: ROCKETS,
  });

  // And once every gun has spent its budget the rung falls through entirely,
  // rather than pinning the ladder for the rest of the run.
  let spent = nextGun.memory;
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    spent = decideCompanionAction(ARMED, obs(ammo), spent).memory;
  }
  const done = decideCompanionAction(ARMED, obs(ammo), spent);
  assert.notEqual(done.action.kind, "loadAmmo");
  assert.equal(done.phase, "Standing by");
});

test("reloading is BENEATH the flee -- a dying pilot leaves before it loads", () => {
  // ⚠ A STATION ON GRID, so the flee has somewhere to GO. Without one the
  // get-safe ladder issues nothing and this test would pass for the wrong reason.
  const decision = decideCompanionAction(
    ARMED,
    obs({
      snapshot: gridWithStation(200_000),
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
      shieldRatio: 0.05,
      armorRatio: 0.05,
      hullRatio: 0.05,
      health: 0.05,
    }),
  );
  assert.notEqual(decision.action.kind, "loadAmmo");
});

test("reloading is ABOVE obeying the fleet -- an empty rack is loaded before it is fired", () => {
  // ⚠ THE WHOLE REASON FOR THE PLACEMENT. `lockThenEngage` would `activate` the
  // gun, the server would accept it, and nothing would come off the target.
  const called = {
    snapshot: gridWithEntitiesAndRack([TACKLE]),
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
  };
  const armedAndEmpty = decideCompanionAction(
    { ...REQUEST, weaponModuleIDs: [AUTOCANNON] },
    obs({
      ...called,
      emptyWeaponModuleIDs: [AUTOCANNON],
      weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
      cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
    }),
  );
  assert.deepEqual(armedAndEmpty.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });

  // With the gun loaded, the very same tick obeys the call as it always did.
  const loaded = decideCompanionAction(
    { ...REQUEST, weaponModuleIDs: [AUTOCANNON] },
    obs({ ...called, emptyWeaponModuleIDs: [], cargoCharges: [] }),
  );
  assert.deepEqual(loaded.action, { kind: "activate", moduleID: AUTOCANNON, targetID: TACKLE });
});

test("a standing destination trip starves the reload rung, and that is the trip's own reading", () => {
  // ⚠ RECORDED RATHER THAN WORKED AROUND. The trip rung above returns a real
  // decision every tick it stands -- "travels to it without additional
  // interruption" -- so a companion crossing systems does not reload on the way,
  // exactly as it does not answer a target call on the way. Arriving, or `stop`,
  // frees this rung on the very next tick.
  const ammo = {
    emptyWeaponModuleIDs: [AUTOCANNON],
    weaponChargeGroups: { [AUTOCANNON]: [PROJECTILE_GROUP] },
    cargoCharges: [charge(SLUGS, 500, PROJECTILE_GROUP)],
  };
  const started = decideCompanionAction(
    ARMED,
    obs({
      snapshot: fcGrid(),
      chatMessages: [chatLine("destination " + SYSTEM_B, HUMAN)],
      ...ammo,
    }),
  );
  const riding = decideCompanionAction(
    ARMED,
    obs({ snapshot: fcGrid(), chatMessages: [], ...ammo }),
    started.memory,
  );
  assert.equal(riding.phase, "Travelling");

  const arrived = decideCompanionAction(
    ARMED,
    obs({ snapshot: fcGrid(), chatMessages: [], flightStatus: inSystem(SYSTEM_B), ...ammo }),
    riding.memory,
  );
  assert.deepEqual(arrived.action, {
    kind: "loadAmmo",
    moduleIDs: [AUTOCANNON],
    chargeItemID: SLUGS,
  });
});

// --- Rung 3b: the prop mod --------------------------------------------------
//
// Before this rung, group 46 "Propulsion Module" fell off the end of
// `resolveDefenseModuleIDs`'s branch chain and no companion ever touched an
// afterburner or an MWD. Three separate things had to be true for one to run:
// the classifier had to keep it, the request had to carry it (with its typeID,
// because Deactivate cannot stop a prop mod without naming its effect), and a
// rung had to decide when. These tests cover the third.

/** Two obviously-synthetic prop mods, one of each kind. */
const AFTERBURNER: CompanionPropulsionModule = {
  itemID: 11300001,
  typeID: 90000910,
  kind: "afterburner",
};
const MWD: CompanionPropulsionModule = {
  itemID: 11300002,
  typeID: 90000911,
  kind: "microwarpdrive",
};

/** An autopilot reading — `running` is the whole of what "travelling" means here. */
function travelling(status: "idle" | "running" | "arrived" = "running") {
  return {
    status,
    destinationStationID: null,
    destinationSystemID: 30000001,
    remainingJumps: 3,
    failureReason: null,
  } as FleetCompanionObservation["travel"];
}

function withProps(
  modules: readonly CompanionPropulsionModule[] = [MWD],
): FleetCompanionRequest {
  return { ...REQUEST, propulsionModules: [...modules] };
}

test("TRAVELLING lights the prop mod — the case that did not exist before this rung", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling() }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
  assert.equal(decision.phase, "Propulsion");
});

test("NOT travelling leaves a prop mod that is already off alone — no call, and the ladder goes on", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling("idle") }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// ⚠ THE OFF-HALF IS THE WHOLE REASON THE ACTION GREW A typeID. A bare
// Deactivate returns 200 with the burner still cycling: the server infers a
// prop mod's default effect on ACTIVATE and not on deactivate, and the BFF
// resolves the effect name from the typeID. A test that only checked the
// moduleID would pass against the broken call.
test("travel ENDING stands the prop mod down, and the deactivate NAMES the typeID", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], [MWD.itemID]), travel: travelling("arrived") }),
  );
  assert.deepEqual(decision.action, {
    kind: "deactivate",
    moduleID: MWD.itemID,
    typeID: MWD.typeID,
  });
});

test("a prop mod already lit while travelling is not re-activated — one call, then fall through", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], [MWD.itemID]), travel: travelling() }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

test("the deactivate is issued ONCE — the latch holds until the snapshot proves it stopped", () => {
  const lit = obs({
    snapshot: gridWithShipsAndActive([], [MWD.itemID]),
    travel: travelling("arrived"),
  });
  const first = decideCompanionAction(withProps(), lit);
  assert.equal(first.action.kind, "deactivate");
  // Same observation, one tick later: activeModuleIDs has not caught up yet.
  const second = decideCompanionAction(withProps(), lit, first.memory);
  assert.notEqual(second.phase, "Propulsion");
});

test("the stopping latch clears once the module is seen stopped, so a REFUSED deactivate retries", () => {
  const lit = obs({
    snapshot: gridWithShipsAndActive([], [MWD.itemID]),
    travel: travelling("arrived"),
  });
  const first = decideCompanionAction(withProps(), lit);
  const stopped = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling("arrived") }),
    first.memory,
  );
  assert.equal(stopped.memory.propsStoppingID, null);
  // And it is willing to try again if the burner turns out to still be running.
  const again = decideCompanionAction(withProps(), lit, stopped.memory);
  assert.equal(again.action.kind, "deactivate");
});

// --- the chat override ------------------------------------------------------

test("`props on` lights the prop mod even though this pilot is not travelling", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling("idle"),
      chatMessages: [chatLine("props on", HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("`props off` stands it down even though this pilot IS travelling", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], [MWD.itemID]),
      travel: travelling(),
      chatMessages: [chatLine("props off", HUMAN)],
    }),
  );
  assert.equal(decision.action.kind, "deactivate");
  assert.equal(decision.followingOrderFrom, "chat");
});

// ⚠ THE LATCH IS WHY `props on` IS WORTH TYPING ONCE. Re-reading it off the chat
// backlog every tick would switch the burner off the moment the line aged out of
// the freshness window — the exact failure `withStandingChatOrders` exists to
// prevent, and the reason propulsion rides that fold rather than the
// order-lapses path a target call takes.
test("the override LATCHES: silence after `props on` does not put it back on automatic", () => {
  const heard = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling("idle"),
      chatMessages: [chatLine("props on", HUMAN)],
    }),
  );
  assert.equal(heard.memory.propsHeld, true);
  // Chat has gone quiet and the pilot is still not travelling. It stays lit.
  const later = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling("idle") }),
    heard.memory,
  );
  assert.deepEqual(later.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
});

test("NEWEST WINS between the two halves, replayed in timestamp order like every other latch", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling("idle"),
      chatMessages: [
        { ...chatLine("props off", HUMAN), createdAtMs: 2_000 },
        { ...chatLine("props on", HUMAN), createdAtMs: 1_000 },
      ],
    }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// ⚠ `stop` CANCELS ORDERS AND PROPULSION IS NOT ONE. A commander halting a pilot
// has said nothing about whether it may keep its speed, and a ship told to stop
// is often the one that most needs to move again in a hurry.
test("a `stop` does not clear the propulsion override the way it clears the trip", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling("idle"),
      chatMessages: [
        { ...chatLine("props on", HUMAN), createdAtMs: 1_000 },
        { ...chatLine("stop", HUMAN), createdAtMs: 2_000 },
      ],
    }),
  );
  assert.equal(decision.memory.propsHeld, true);
});

test("a stranger in local cannot touch the prop mod — same commander gate as every chat order", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling("idle"),
      chatMessages: [chatLine("props on", 90000099)],
    }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// --- the scram gate ---------------------------------------------------------
//
// ⚠ THE ONE PLACE THE AB/MWD SPLIT EARNS ITS KEEP. SDE group 46 holds both, so
// the classifier has to reach into the SDE's own dogmaEffects to tell them
// apart. A warp SCRAMBLER (`warpScramblerMWD`, the jam carrying
// `blocksMicrowarpdrive`) turns an MWD off server-side and does nothing at all
// to an afterburner.

test("a scram stops the rung re-lighting an MWD the server has already killed", () => {
  const decision = decideCompanionAction(
    withProps([MWD]),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), scrammed: true }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

test("a scram does NOT stand an AFTERBURNER down — no jam in this vocabulary touches one", () => {
  const decision = decideCompanionAction(
    withProps([AFTERBURNER]),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), scrammed: true }),
  );
  assert.deepEqual(decision.action, {
    kind: "activate",
    moduleID: AFTERBURNER.itemID,
    targetID: 0,
  });
});

test("a ship carrying BOTH keeps its afterburner under a scram — the MWD is skipped, not the rung", () => {
  const decision = decideCompanionAction(
    withProps([MWD, AFTERBURNER]),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), scrammed: true }),
  );
  assert.deepEqual(decision.action, {
    kind: "activate",
    moduleID: AFTERBURNER.itemID,
    targetID: 0,
  });
});

// ⚠ FAIL OPEN, EVERY TIME. A dropped SSE frame must never be what takes the
// speed off a ship, so only an explicit `true` gates.
test("an UNREADABLE scram reading does not gate — three-state, and null is not `scrammed`", () => {
  const decision = decideCompanionAction(
    withProps([MWD]),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), scrammed: null }),
  );
  assert.equal(decision.action.kind, "activate");
});

// The cheap half of the wrong answer: an unclassifiable prop mod is assumed
// scram-vulnerable, costing at most a stationary afterburner on an already
// tackled pilot, rather than a call spent every tick to be refused.
test("a prop mod whose kind could not be read is treated as an MWD under a scram", () => {
  const unknown: CompanionPropulsionModule = { itemID: 11300003, typeID: 90000912, kind: null };
  const decision = decideCompanionAction(
    withProps([unknown]),
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), scrammed: true }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// --- the capacitor floor ----------------------------------------------------

test("below the operator's capacitor floor the rung does not LIGHT one", () => {
  const decision = decideCompanionAction(
    { ...withProps(), capacitorFloor: 0.5 },
    obs({
      snapshot: gridWithShipsAndActive([], []),
      travel: travelling(),
      capacitorRatio: 0.2,
    }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// ⚠ AND THE FLOOR MUST NOT GATE THE OFF-HALF, or a burner is stranded ON at
// exactly the capacitor level that made it dangerous.
test("below the floor it still STOPS one — a running module must always be stoppable", () => {
  const decision = decideCompanionAction(
    { ...withProps(), capacitorFloor: 0.5 },
    obs({
      snapshot: gridWithShipsAndActive([], [MWD.itemID]),
      travel: travelling("arrived"),
      capacitorRatio: 0.2,
    }),
  );
  assert.equal(decision.action.kind, "deactivate");
});

test("unreadable capacitor does not gate — the same fail-open rule the rest of the file follows", () => {
  const decision = decideCompanionAction(
    { ...withProps(), capacitorFloor: 0.5 },
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling(), capacitorRatio: null }),
  );
  assert.equal(decision.action.kind, "activate");
});

// --- the reads this rung refuses to guess at ---------------------------------

test("an UNREADABLE activeModuleIDs issues nothing — `cannot say` is not `nothing is running`", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], null), travel: travelling() }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

test("a hull with no prop mod fitted never reaches this rung at all", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithShipsAndActive([], []), travel: travelling() }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// A companion that has not been given a travel reading at all — an older host,
// or one that never wired it up — reads as "not travelling", never as
// "travelling". It must not burn capacitor on a guess.
test("an absent travel reading is NOT travelling", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridWithShipsAndActive([], []) }),
  );
  assert.notEqual(decision.phase, "Propulsion");
});

// ⚠ THE OVERRIDE DOES NOT SURVIVE A RESTART, and that is deliberate: the
// `props on` that set it is long out of the chat window and cannot be re-heard,
// so carrying it would be a standing order nobody can see or countermand.
test("a fresh ladder memory has no propulsion override — `null`, not `false`", () => {
  assert.equal(freshLadderMemory().propsHeld, null);
});

// --- the trigger that actually fires: the ship's own movement mode ----------
//
// ⚠ THESE ARE THE REGRESSION TESTS FOR THE BUG THIS RUNG SHIPPED WITH. Reading
// "travelling" as `obs.travel.status === "running"` — the shared autopilot — is
// true and nearly useless: a companion in ordinary fleet play never runs its own
// autopilot. It yields to the commander's fleet warp, holds station on them, and
// jumps the gate it is sitting on, so the autopilot stayed idle for an entire
// trip and no prop mod ever lit. Reported from a live fleet, 2026-09-13.
//
// The mode vocabulary is the SERVER's own and is six uppercase words
// (`space/destiny/commands/`): FIELD, FOLLOW, GOTO, ORBIT, STOP, WARP. ⚠ The
// word "approach" never appears in it, and an APPROACH IS FOLLOW — there is no
// CmdApproach at all, so `/flight/approach` sends `CmdFollowBall(target, range)`
// and `followShipEntity` sets FOLLOW. GOTO is the OTHER burn: an align, an
// undock, a landing out of warp, a throttle opened from STOP.
//
// This rung wants both, because both are a hull burning sub-warp. `isClosing`
// wants FOLLOW and WARP, because it asks a different question — "is the move I
// sent the move being flown" — and GOTO is the answer "no". Two lists, on
// purpose; see `NO_REAPPROACH_SHIP_MODES`.

/** A grid whose own ship carries a server movement mode. */
function gridInMode(mode: string | null, activeModuleIDs: readonly number[] = []): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode, activeModuleIDs },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode },
    ],
  } as unknown as SpaceSnapshot;
}

test("GOTO lights the prop mod — an approach, which is how a pilot closes on a gate", () => {
  const decision = decideCompanionAction(withProps(), obs({ snapshot: gridInMode("GOTO") }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
});

test("FOLLOW lights it too — keeping up with a commander who is pulling away", () => {
  const decision = decideCompanionAction(withProps(), obs({ snapshot: gridInMode("FOLLOW") }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
});

// ⚠ THE WHOLE POINT OF THE REGRESSION. No autopilot anywhere in this
// observation — exactly the shape of a companion following its FC through a
// dozen systems — and it must still burn.
test("a companion with NO autopilot trip still burns while closing — the reported bug", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridInMode("GOTO"), travel: travelling("idle") }),
  );
  assert.equal(decision.phase, "Propulsion");
});

test("ORBIT does not light it — a ship holding station has arrived, it is not closing", () => {
  const decision = decideCompanionAction(withProps(), obs({ snapshot: gridInMode("ORBIT") }));
  assert.notEqual(decision.phase, "Propulsion");
});

test("STOP stands a lit prop mod down — nothing is being closed on any more", () => {
  const decision = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridInMode("STOP", [MWD.itemID]) }),
  );
  assert.deepEqual(decision.action, {
    kind: "deactivate",
    moduleID: MWD.itemID,
    typeID: MWD.typeID,
  });
});

// The server sends uppercase; being liberal about case costs nothing and a
// future drop that changed it must not silently stop every companion burning.
test("the mode test is case-insensitive", () => {
  const decision = decideCompanionAction(withProps(), obs({ snapshot: gridInMode("goto") }));
  assert.equal(decision.phase, "Propulsion");
});

test("an unreadable mode falls back to the autopilot test rather than burning on a guess", () => {
  const idle = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridInMode(null), travel: travelling("idle") }),
  );
  assert.notEqual(idle.phase, "Propulsion");
  const onTrip = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridInMode(null), travel: travelling() }),
  );
  assert.equal(onTrip.phase, "Propulsion");
});

// ⚠ THE OVERRIDE STILL OUTRANKS THE MODE, in both directions.
test("`props off` beats a GOTO, and `props on` beats an ORBIT", () => {
  const off = decideCompanionAction(
    withProps(),
    obs({
      snapshot: gridInMode("GOTO", [MWD.itemID]),
      chatMessages: [chatLine("props off", HUMAN)],
    }),
  );
  assert.equal(off.action.kind, "deactivate");
  const on = decideCompanionAction(
    withProps(),
    obs({ snapshot: gridInMode("ORBIT"), chatMessages: [chatLine("props on", HUMAN)] }),
  );
  assert.deepEqual(on.action, { kind: "activate", moduleID: MWD.itemID, targetID: 0 });
});

// --- the approach latch: which modes mean "the move I sent is being flown" ---
//
// The loot and the salvage rungs both issue ONE approach and then wait on it, and
// what they wait on is `isClosing` — the ship's own mode, never their memory of
// having asked. Which modes that accepts is therefore a call-budget decision on
// every tick of a run, and it was being made by `/follow|approach|warp/i` over
// free text.
//
// ⚠ AN APPROACH IS **FOLLOW**. There is no CmdApproach on this server: retail's
// Approach is `CmdFollowBall(targetID, 0)`, `/api/bridge/flight/approach` sends
// exactly that after opening the throttle, and `followShipEntity` sets FOLLOW at
// any range — so the looter's range-less approach and the salvager's 3 km one
// both land there. The regex's "approach" alternative could never match anything
// the server is able to say; these tests pin the real vocabulary in its place.

/** A wreck 30 km off — out of salvager reach — with the hull in `mode`. */
function salvagingInMode(mode: string | null): FleetCompanionObservation {
  return salvageObs(salvageGrid(30_000, [], mode));
}

/** The memory left behind by the first tick, which issued the approach. */
function approachIssued(): CompanionLadderMemory {
  const first = decideCompanionAction(WITH_SALVAGER, salvagingInMode(null));
  assert.deepEqual(first.action, { kind: "approach", targetID: WRECK_NEAR, range: 3000 });
  assert.equal(first.memory.salvageApproachIssued, true);
  return first.memory;
}

test("FOLLOW is believed — the mode an approach actually sets, so the rung waits", () => {
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    salvagingInMode("FOLLOW"),
    approachIssued(),
  );
  assert.notEqual(decision.action.kind, "approach");
  assert.equal(decision.phase, "Salvaging");
});

// ⚠ THE ONE THAT MUST NOT BE SHARED WITH `CLOSING_SHIP_MODES`. GOTO is what the
// hull is left in when the follow was REFUSED — `followBall` bounces a pilot
// whose warp landing is still pending — and the throttle was opened BEFORE it,
// so the ship is under way at full speed somewhere that is not the wreck.
// Believing that mode would park the rung on one wreck for the rest of the run.
test("GOTO is NOT believed — a refused approach leaves the hull flying elsewhere", () => {
  const decision = decideCompanionAction(WITH_SALVAGER, salvagingInMode("GOTO"), approachIssued());
  assert.deepEqual(decision.action, { kind: "approach", targetID: WRECK_NEAR, range: 3000 });
});

test("an align by another rung does not hold the salvage latch either", () => {
  // CmdAlignTo also sets GOTO, and an align is a heading, not an approach: the
  // ship is burning away from the wreck on somebody else's order.
  const decision = decideCompanionAction(WITH_SALVAGER, salvagingInMode("GOTO"), approachIssued());
  assert.equal(decision.action.kind, "approach");
});

test("STOP and ORBIT get a fresh approach — neither is a move toward the wreck", () => {
  for (const mode of ["STOP", "ORBIT", "FIELD"]) {
    const decision = decideCompanionAction(
      WITH_SALVAGER,
      salvagingInMode(mode),
      approachIssued(),
    );
    assert.equal(decision.action.kind, "approach", `${mode} must not hold the latch`);
  }
});

// ⚠ WARP IS HELD, AND NOT BECAUSE A WARP IS AN APPROACH. `followShipEntity`
// refuses outright while the mode is WARP, so an approach sent there is a call
// spent to be told no. The rung's own `inWarp` guard usually catches this first,
// but that flag and the snapshot's mode are different reads and can disagree.
test("WARP holds the latch — an approach sent mid-warp is a call spent to be refused", () => {
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    salvageObs(salvageGrid(30_000, [], "WARP"), { inWarp: false }),
    approachIssued(),
  );
  assert.notEqual(decision.action.kind, "approach");
});

test("an unreadable mode re-issues rather than waiting on a move it cannot see", () => {
  const decision = decideCompanionAction(WITH_SALVAGER, salvagingInMode(null), approachIssued());
  assert.equal(decision.action.kind, "approach");
});

// The server sends uppercase; being liberal about case costs nothing, and a drop
// that changed it must not silently have every rung re-ordering a move that is
// already under way.
test("the latch is case-insensitive", () => {
  const decision = decideCompanionAction(WITH_SALVAGER, salvagingInMode("follow"), approachIssued());
  assert.notEqual(decision.action.kind, "approach");
});

// The looter runs the same latch on its own memory, and its approach carries no
// range — which changes nothing about the mode, because CmdFollowBall sets
// FOLLOW at any range at all.
test("the loot rung reads the same vocabulary — FOLLOW waits, GOTO re-approaches", () => {
  const out = obs({
    snapshot: lootGrid({ containerDistance: 40_000 }),
    chatMessages: [areaOrder("loot")],
  });
  const first = decideCompanionAction(WITH_DRONES, out);
  assert.deepEqual(first.action, { kind: "approach", targetID: CAN });

  const following = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ containerDistance: 40_000, shipMode: "FOLLOW" }),
      chatMessages: [areaOrder("loot")],
    }),
    first.memory,
  );
  assert.notEqual(following.action.kind, "approach");

  const goingSomewhereElse = decideCompanionAction(
    WITH_DRONES,
    obs({
      snapshot: lootGrid({ containerDistance: 40_000, shipMode: "GOTO" }),
      chatMessages: [areaOrder("loot")],
    }),
    first.memory,
  );
  assert.deepEqual(goingSomewhereElse.action, { kind: "approach", targetID: CAN });
});

// ⚠ THE REGRESSION THE OLD REGEX WOULD PASS AND THE NEW LIST MUST NOT. A mode
// that merely CONTAINS one of the old alternatives is not that mode. Nothing in
// the server's six words does, which is exactly why a substring test over free
// text was the wrong shape for a closed vocabulary.
test("a mode is matched whole, not as a substring", () => {
  const decision = decideCompanionAction(
    WITH_SALVAGER,
    salvagingInMode("NOTFOLLOWING"),
    approachIssued(),
  );
  assert.equal(decision.action.kind, "approach");
});

// --- the two beats ------------------------------------------------------------
//
// ⚠ WHAT THIS PINS IS A REACTION TIME, NOT AN IMPLEMENTATION DETAIL. Obeying a
// single `Target` call takes several ticks -- lock it, wait for the lock, put
// the drones on it, then bring the guns up one module at a time -- and at a flat
// cadence every one of those steps cost the full beat even though none of them
// was waiting on the world. The rule is: a tick that ISSUED something comes back
// at the burst, a tick that waited keeps the cadence.

test("a tick that issued a call comes back at the burst, not the cadence", async () => {
  const slept: number[] = [];
  let ticks = 0;
  const controller = createFleetCompanion({
    // Hostiles on grid with drones aboard: rung 6 has something to launch, so
    // the first tick issues a real call.
    observe: async () => droneObs(),
    issue: async () => {},
    sleep: async (ms) => {
      slept.push(ms);
      ticks += 1;
      if (ticks >= 1) {
        controller.stop();
      }
    },
  });
  controller.start(WITH_DRONES);
  await controller.run();
  assert.deepEqual(slept, [FLEET_COMPANION_BURST_MS]);
});

// ⚠ AND THE OTHER HALF, WHICH IS WHAT KEEPS EVERY WAIT IN THIS FILE HONEST. A
// rung that is merely waiting returns no action, so the tick is a `wait` and
// still sleeps the full cadence -- which is why a burst cannot quietly shorten
// a drone hold-off or a recall bound.
test("a tick that decided nothing keeps the full cadence", async () => {
  const slept: number[] = [];
  let ticks = 0;
  const controller = createFleetCompanion({
    observe: async () => obs(),
    issue: async () => {},
    sleep: async (ms) => {
      slept.push(ms);
      ticks += 1;
      if (ticks >= 1) {
        controller.stop();
      }
    },
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.run();
  assert.deepEqual(slept, [FLEET_COMPANION_CADENCE_MS]);
});

// The burst is a real saving only if it is well under the cadence; pinning the
// relationship rather than the number keeps a later tuning honest.
test("the burst is shorter than the cadence", () => {
  assert.ok(
    FLEET_COMPANION_BURST_MS > 0 && FLEET_COMPANION_BURST_MS < FLEET_COMPANION_CADENCE_MS,
    "a burst that is not shorter than the cadence is not a burst",
  );
});
