// B2 — the runner controller, driven with fake deps so the lifecycle is tested
// without a live ship: selective settle ticks, pause/stop staleness,
// session-loss unwind, the read-failure give-up, and a clean finish.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep, ProgramNode } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { FlightStatus } from "../store/types.ts";
import { MAX_CONSECUTIVE_REFUSALS } from "./refusalLedger.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import type {
  HomeTravelDecider,
  MacroDecider,
  MacroRegistry,
  MacroTick,
  ScriptAction,
} from "./scriptDecide.ts";
import type { BotLogDraft, BotLogSink } from "./botLog.ts";
import {
  MAX_READ_FAILURES,
  SETTLE_TICKS,
  createScriptRunner,
  needsMobileCombat,
  type ScriptRunnerSnapshot,
} from "./scriptRunner.ts";

class SessionLost extends Error {}

function calm(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    ...over,
  };
}

function mt(action: ScriptAction, outcome: MacroTick["outcome"]): MacroTick {
  return { action, why: "why", phase: "phase", armed: true, outcome, nextMem: {} };
}

const undock: MacroDecider = (_s, o) =>
  o.inSpace ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "undock" }, { kind: "acting" });
const deliver: MacroDecider = (_s, o) =>
  o.holdEmpty ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" });
const home: HomeTravelDecider = (o) =>
  o.docked ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "warp", targetID: 9 }, { kind: "acting" });

const registry = { undock, "deliver-ore": deliver };

test("mobile combat observation is requested before a preceding node advances", async () => {
  const doc = script([macroStep("u", "undock"), { id: "repeat", kind: "loop", repeat: { kind: "forever" },
    body: [macroStep("fight", "fight-with-drones")] }]);
  assert.equal(needsMobileCombat(doc.program), true);
  assert.equal(needsMobileCombat(script([macroStep("stationary", "fight-the-rats")]).program), false);
  let hint: import("./scriptRunner.ts").ObserveHint | null = null;
  const runner = createScriptRunner({ observe: async value => { hint = value; return calm(); },
    issue: async () => {}, registry: { ...registry, "fight-with-drones": () => mt({kind:"wait"}, {kind:"acting"}) },
    travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String });
  runner.start(doc); await runner.tick();
  assert.equal((hint as unknown as import("./scriptRunner.ts").ObserveHint).activeMacro, "undock");
  assert.equal((hint as unknown as import("./scriptRunner.ts").ObserveHint).needsMobileCombat, true);
  runner.stop();
});

test("uncertain requested-module mutation pauses custody and is never replayed by Resume", async () => {
  const activate: MacroDecider = () => mt({ kind: "activate", moduleID: 11, targetID: 0 }, { kind: "acting" });
  const h = harness({ registry: { "fight-with-drones": activate }, issueThrows: () =>
    Object.assign(new Error("Requested module state is unreadable"), { code: "MODULE_ACTION_UNCERTAIN" }) });
  h.runner.start(script([macroStep("fight", "fight-with-drones")]));
  await h.runner.tick();
  assert.equal(h.runner.getStatus(), "paused");
  h.runner.resume(); await h.runner.tick();
  assert.equal(h.issued.length, 1);
});
test("definite module refusal leaves the action safely retryable", async () => {
  let calls = 0;
  const activate: MacroDecider = () => mt({ kind: "activate", moduleID: 11, targetID: 0 }, { kind: "acting" });
  const h = harness({ registry: { "fight-with-drones": activate }, issueThrows: () => ++calls === 1
    ? Object.assign(new Error("NotEnoughCapacitor"), { code: "CALL_REFUSED" }) : null });
  h.runner.start(script([macroStep("fight", "fight-with-drones")]));
  for (let i = 0; i < 10 && h.issued.length < 2; i++) await h.runner.tick();
  assert.deepEqual(h.issued[1], h.issued[0]);
});
test("retired Stop generation cannot dispatch old combat cleanup", async () => {
  let releaseRead!: () => void;
  let stopping = false;
  const issued: ScriptAction[] = [];
  const combat: MacroDecider = () => ({ ...mt({ kind: "activate", moduleID: 11, targetID: 0 }, { kind: "acting" }),
    nextMem: { combatOwned: { shipID: 9001, modules: { 11: {} }, locks: [], drones: [], initialDrones: [],
      launched: false, movement: false, fleetCall: false } } });
  const runner = createScriptRunner({ observe: async () => {
    if (stopping) await new Promise<void>(resolve => { releaseRead = resolve; });
    return calm({ snapshot: { ship: { itemID: 9001, activeModuleIDs: [11], weaponBanks: {} }, entities: [] } as unknown as import("../store/types.ts").SpaceSnapshot,
      lockedTargetIDs: [], combatDroneIDs: [], myDrones: [] });
  }, issue: async action => { issued.push(action); }, registry: { "fight-with-drones": combat }, travelHome: home,
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String });
  runner.start(script([macroStep("fight", "fight-with-drones")])); await runner.tick();
  await runner.beginGracefulStop(); stopping = true;
  const pending = runner.settleCombatStop!(Date.now() + 60_000);
  await Promise.resolve(); runner.stop(); releaseRead();
  await assert.rejects(pending, /generation changed/);
  assert.equal(issued.length, 1);
});

function macroStep(id: string, macro: MacroStep["macro"]): MacroStep {
  return { id, kind: "macro", macro, args: {} };
}
test("uncertain Stop retains pending intent, blocks Start/Resume, and reconciles without replay", async () => {
  let active = true, reads = 0;
  const issued: ScriptAction[] = [];
  const combat: MacroDecider = () => ({ ...mt({ kind: "activate", moduleID: 11, targetID: 0 }, { kind: "acting" }),
    nextMem: { combatOwned: { shipID: 9001, modules: { 11: {} }, locks: [], drones: [], initialDrones: [],
      launched: false, movement: false, fleetCall: false } } });
  const runner = createScriptRunner({ observe: async () => {
    if (++reads > 3) active = false;
    return calm({ snapshot: { ship: { itemID: 9001, activeModuleIDs: active ? [11] : [], weaponBanks: {} }, entities: [] } as unknown as import("../store/types.ts").SpaceSnapshot,
      lockedTargetIDs: [], combatDroneIDs: [], myDrones: [] });
  }, issue: async action => { issued.push(action); if (action.kind === "deactivate")
    throw Object.assign(new Error("Deferred stop"), { code: "MODULE_ACTION_UNCERTAIN" }); },
  registry: { "fight-with-drones": combat }, travelHome: home, sleep: async () => {},
  onProgress: () => {}, isSessionLost: () => false, refusalReason: String });
  const doc = script([macroStep("fight", "fight-with-drones")]);
  runner.start(doc); await runner.tick(); await runner.beginGracefulStop();
  await assert.rejects(runner.settleCombatStop!(Date.now() + 60_000), /Deferred stop/);
  assert.throws(() => runner.start(doc), /unresolved settlement/);
  runner.resume(); assert.equal(runner.getStatus(), "paused");
  await runner.settleCombatStop!(Date.now() + 60_000);
  assert.equal(issued.filter(action => action.kind === "deactivate").length, 1);
});
function script(program: readonly ProgramNode[]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }],
    program,
  };
}

interface Harness {
  mutationCustody?: () => boolean;
  observeThrows?: () => never;
  registry?: MacroRegistry;
  /** Throw from `issue` — the refusal path. Return null to let the call pass. */
  issueThrows?: (action: ScriptAction) => unknown | null;
  /** A NOTE from `issue` — the call landed, but not as asked. */
  issueNote?: (action: ScriptAction) => string | null;
  /** A flight recorder to hand the runner (nav/botLog.ts). */
  log?: BotLogSink;
}

function harness(opts: Harness = {}) {
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  let obs = calm();
  const runner = createScriptRunner({
    observe: async () => {
      if (opts.observeThrows) {
        opts.observeThrows();
      }
      return obs;
    },
    issue: async (a) => {
      issued.push(a);
      const thrown = opts.issueThrows?.(a) ?? null;
      if (thrown !== null) {
        throw thrown;
      }
      return opts.issueNote?.(a) ?? null;
    },
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    registry: opts.registry ?? registry,
    travelHome: home,
    log: opts.log,
    mutationCustody: opts.mutationCustody,
  });
  return { runner, issued, progress, setObs: (o: ScriptObservation) => { obs = o; } };
}

const completionCases: readonly { step: MacroStep; observation: ScriptObservation; action: ScriptAction["kind"] }[] = [
  {
    step: { id: "buy", kind: "macro", macro: "buy-item", args: {
      item: { kind: "itemType", typeID: 34, name: "Tritanium" },
      quantity: { kind: "qty", value: 10 }, price: { kind: "isk", value: 1 },
    } },
    observation: calm({ inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 1 }) }),
    action: "placeBuyOrder",
  },
  {
    step: { id: "refit", kind: "macro", macro: "refit-ship", args: {
      fitting: { kind: "fitting", fittingID: 5, name: "Vexor" },
    } },
    observation: calm({ inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 1 }),
      activeShipID: 9001,
      stationHangar: [{ itemID: 9001, typeID: 626, categoryID: 6, groupID: null, flagID: null, quantity: 1, singleton: true }],
      savedFittings: [{ fittingID: 5, name: "Vexor", description: "", shipTypeID: 626, ownerID: 1, savedDate: null, modules: [] }],
    }),
    action: "applyFitting",
  },
  {
    step: { id: "scan", kind: "macro", macro: "analyze-signatures", args: {} },
    observation: calm({ scannerOperations: { inSpace: true, solarSystemID: 30000001, shipID: 9001, maxActiveProbes: 8, launcher: null,
      probes: [{ probeID: 7001, typeID: 30013, pos: [0, 0, 0], destination: [0, 0, 0], scanRange: 1, rangeStep: 1, state: 1, expiry: "1" }],
    } }),
    action: "scannerAnalyze",
  },
  {
    step: { id: "move", kind: "macro", macro: "move-items", args: {
      item: { kind: "itemType", typeID: 34, name: "Tritanium" }, from: { kind: "place", place: "hangar" },
      to: { kind: "place", place: "cargo" }, amount: { kind: "count", value: 30 },
    } },
    observation: calm({ inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 1 }),
      stationHangar: [{ itemID: 101, typeID: 34, categoryID: 4, groupID: 18, flagID: null, quantity: 100, singleton: false }],
    }),
    action: "moveItems",
  },
];

for (const scenario of completionCases) {
  for (const refusal of [new Error("CALL_REFUSED: NotEnoughMoney"), settling()]) {
    test(`${scenario.step.macro} retries an explicit ${refusal.message.split(":")[0]} without committing completion`, async () => {
      let attempts = 0;
      const h = harness({ registry: SCRIPT_MACROS, issueThrows: () => attempts++ === 0 ? refusal : null });
      h.setObs(scenario.observation);
      h.runner.start(script([scenario.step]));
      await issueTicks(h, 2);
      assert.deepEqual(h.issued.map(action => action.kind), [scenario.action, scenario.action]);
      assert.deepEqual(h.issued[1], h.issued[0], "the refused quantity or one-shot action was not consumed");
      for (let i = 0; i < 10 && h.runner.getStatus() === "running"; i++) await h.runner.tick();
      assert.equal(h.runner.getStatus(), "stopped", "only the successful retry completes the step");
      assert.equal(h.issued.length, 2);
    });
  }

  test(`${scenario.step.macro} retains an uncertain dispatched outcome until explicit Stop`, async () => {
    const h = harness({ registry: SCRIPT_MACROS,
      issueThrows: () => Object.assign(new Error("EVE_GATEWAY_TIMEOUT"), { code: "EVE_GATEWAY_TIMEOUT" }),
    });
    h.setObs(scenario.observation);
    const doc = script([scenario.step]);
    h.runner.start(doc);
    await h.runner.tick();
    assert.equal(h.runner.getStatus(), "paused");
    assert.match(h.runner.snapshot().pauseReason ?? "", /outcome.*could not be confirmed/);
    h.runner.resume();
    assert.equal(h.runner.getStatus(), "paused");
    assert.equal(h.runner.resumeHeadHome("run ended"), false);
    assert.throws(() => h.runner.start(doc), /Verify the previous action/);
    await h.runner.suspendTransport();
    assert.equal(h.runner.transportCustody(), true);
    assert.throws(() => h.runner.resumeTransport(), /unresolved/);
    await h.runner.tick();
    assert.equal(h.issued.length, 1, "uncertain work is never replayed or declared complete");
    h.runner.stop();
    assert.equal(h.runner.transportCustody(), false, "explicit Stop acknowledges the outcome check");
  });
}

test("a one-shot action confirmed while paused completes without a duplicate on Resume", async () => {
  const scenario = completionCases[0]!;
  let finish: () => void = () => {};
  let started: () => void = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({ observe: async () => scenario.observation,
    issue: async action => { issued.push(action); started(); await pending; },
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    registry: SCRIPT_MACROS, travelHome: home,
  });
  const doc = script([scenario.step]);
  runner.start(doc);
  const tick = runner.tick();
  await entered;
  runner.pause();
  runner.resume();
  assert.equal(runner.getStatus(), "paused", "Resume waits for the issued write's outcome");
  assert.equal(runner.resumeHeadHome("Stop"), false);
  assert.equal(runner.tick(), tick, "concurrent ticks share the outstanding transaction");
  assert.throws(() => runner.start(doc), /still awaiting its outcome/);
  finish();
  await tick;
  assert.equal(runner.getStatus(), "paused");
  runner.resume();
  await runner.tick();
  assert.equal(runner.getStatus(), "stopped");
  assert.equal(issued.length, 1);
});

for (const outcome of ["refused", "ambiguous"] as const) {
  test(`a pending ${outcome} one-shot blocks all resume paths until its outcome settles`, async () => {
    const scenario = completionCases[0]!;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let fail!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    const issued: ScriptAction[] = [];
    let first = true;
    const runner = createScriptRunner({ observe: async () => scenario.observation,
      issue: async action => { issued.push(action); if (first) { first = false; entered(); await pending; } },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: SCRIPT_MACROS, travelHome: home,
    });
    const doc = script([scenario.step]);
    runner.start(doc);
    const tick = runner.tick();
    await started;
    runner.pause();
    runner.resume();
    assert.equal(runner.getStatus(), "paused");
    assert.equal(runner.resumeHeadHome("Stop"), false);
    const suspended = runner.suspendTransport();
    assert.throws(() => runner.resumeTransport(), /unresolved/);
    assert.throws(() => runner.start(doc), /still awaiting/);
    assert.equal(runner.tick(), tick);
    assert.equal(issued.length, 1);
    fail(Object.assign(new Error(outcome === "refused" ? "CALL_REFUSED" : "EVE_GATEWAY_TIMEOUT"),
      { code: outcome === "refused" ? "CALL_REFUSED" : "EVE_GATEWAY_TIMEOUT" }));
    await tick;
    await suspended;
    if (outcome === "refused") {
      runner.resume();
      assert.equal(runner.getStatus(), "paused", "ordinary Resume cannot bypass session recovery");
      runner.resumeTransport();
      for (let i = 0; i < 8 && runner.getStatus() === "running"; i++) await runner.tick();
      assert.equal(issued.length, 2, "a definite refusal remains retryable after settlement");
      assert.equal(runner.getStatus(), "stopped");
    } else {
      runner.resume();
      assert.equal(runner.getStatus(), "paused");
      assert.equal(runner.resumeHeadHome("Stop"), false);
      assert.throws(() => runner.resumeTransport(), /unresolved/);
      assert.throws(() => runner.start(doc), /Verify the previous/);
      assert.equal(issued.length, 1);
    }
    runner.stop();
  });
}

test("Stop cannot replace an outstanding action with a fresh driver", async () => {
  const scenario = completionCases[0]!;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const runner = createScriptRunner({ observe: async () => scenario.observation,
    issue: async () => { entered(); await pending; }, sleep: async () => {}, onProgress: () => {},
    isSessionLost: () => false, refusalReason: String, registry: SCRIPT_MACROS, travelHome: home,
  });
  const doc = script([scenario.step]);
  runner.start(doc);
  const tick = runner.tick();
  await started;
  runner.stop();
  assert.throws(() => runner.start(doc), /still awaiting/);
  assert.equal(runner.tick(), tick);
  finish();
  await tick;
  assert.equal(runner.getStatus(), "stopped");
  assert.doesNotThrow(() => runner.start(doc));
  runner.stop();
});

for (const scenario of completionCases) {
  test(`${scenario.step.macro} keeps completion when a pending success settles during transport suspension`, async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const issued: ScriptAction[] = [];
    const runner = createScriptRunner({ observe: async () => scenario.observation,
      issue: async action => { issued.push(action); entered(); await pending; },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: SCRIPT_MACROS, travelHome: home,
    });
    runner.start(script([scenario.step]));
    const ticking = runner.tick();
    await started;
    const suspension = runner.suspendTransport();
    assert.throws(() => runner.resumeTransport(), /unresolved/);
    finish();
    await ticking;
    await suspension;
    runner.resume();
    assert.equal(runner.getStatus(), "paused");
    assert.equal(runner.resumeHeadHome("Stop"), false);
    runner.resumeTransport();
    for (let i = 0; i < 8 && runner.getStatus() === "running"; i++) await runner.tick();
    assert.equal(runner.getStatus(), "stopped");
    assert.deepEqual(issued.map(action => action.kind), [scenario.action], "confirmed completion survived recovery");
  });
}

for (const outcome of ["success", "refused", "ambiguous"] as const) {
  test(`partial move quantity survives a ${outcome} second write across transport recovery`, async () => {
    const scenario = completionCases[3]!;
    const row = (itemID: number, quantity: number) => ({ itemID, quantity, typeID: 34, categoryID: 4, groupID: 18,
      flagID: null, singleton: false });
    let observation = { ...scenario.observation, stationHangar: [row(101, 20), row(102, 100)] };
    let entered!: () => void, finish!: () => void, fail!: (error: unknown) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const issued: ScriptAction[] = [];
    const runner = createScriptRunner({ observe: async () => observation,
      issue: async action => { issued.push(action);
        if (issued.length === 1) observation = { ...observation, stationHangar: [row(102, 100)] };
        if (issued.length === 2) { entered(); await pending; }
      },
      sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: SCRIPT_MACROS, travelHome: home,
    });
    runner.start(script([scenario.step]));
    await runner.tick();
    for (let i = 0; i < SETTLE_TICKS; i++) await runner.tick();
    const ticking = runner.tick();
    await started;
    assert.equal(issued[1]?.kind === "moveItems" && issued[1].qty, 10);
    const suspension = runner.suspendTransport();
    if (outcome === "success") finish();
    else fail(Object.assign(new Error(outcome), { code: outcome === "refused" ? "CALL_REFUSED" : "EVE_GATEWAY_TIMEOUT" }));
    await ticking;
    await suspension;
    if (outcome === "ambiguous") {
      assert.throws(() => runner.resumeTransport(), /unresolved/);
      runner.resume();
      assert.equal(runner.resumeHeadHome("Stop"), false);
      assert.equal(runner.getStatus(), "paused");
      assert.equal(issued.length, 2, "the unverified final ten units cannot be replayed");
      runner.stop();
      return;
    }
    runner.resumeTransport();
    for (let i = 0; i < 8 && runner.getStatus() === "running"; i++) await runner.tick();
    assert.equal(runner.getStatus(), "stopped");
    assert.deepEqual(issued.filter(action => action.kind === "moveItems").map(action => action.qty),
      outcome === "success" ? [null, 10] : [null, 10, 10], "the first twenty units are never forgotten");
  });
}

test("unclassified accepted state stays intact and transport paused; previous completed steps do not block a new step", async () => {
  const state = { aimedAt: 42, accepted: true };
  let seen: unknown;
  const h = harness({ registry: {
    undock: (_step, _obs, mem) => { seen = mem; return mem["accepted"]
      ? { ...mt({ kind: "wait" }, { kind: "done" }), nextMem: mem }
      : { ...mt({ kind: "align", targetID: 42 }, { kind: "acting" }), nextMem: state }; },
    "wait": (_step, _obs, mem) => ({ ...mt({ kind: "wait" }, { kind: "acting" }), nextMem: mem }),
  } });
  const doc = script([macroStep("u", "undock"), macroStep("later", "wait")]);
  h.runner.start(doc);
  await h.runner.tick();
  await h.runner.suspendTransport();
  assert.throws(() => h.runner.resumeTransport(), /cannot be reset safely.*Progress has been preserved/);
  assert.match(h.runner.snapshot().pauseReason ?? "", /Verify it in the game/);
  h.runner.resume();
  assert.equal(h.runner.getStatus(), "paused");
  assert.equal(h.runner.resumeHeadHome("Stop"), false);
  assert.throws(() => h.runner.start(doc), /preserved step/);
  h.runner.stop();
  h.runner.start(doc);
  await h.runner.tick();
  for (let i = 0; i < SETTLE_TICKS + 1; i++) await h.runner.tick();
  assert.equal(seen, state, "the accepted record is retained in ordinary operation");
  assert.equal(h.runner.snapshot().stepPath, "later");
  await h.runner.suspendTransport();
  assert.doesNotThrow(() => h.runner.resumeTransport(), "the completed earlier step has relinquished its state");
  h.runner.stop();
});

test("a confirmed sell retains its step state and requires verification instead of an automatic replay", async () => {
  const scenario = completionCases[3]!;
  const step: MacroStep = { id: "sell", kind: "macro", macro: "sell-item", args: {
    item: { kind: "itemType", typeID: 34, name: "Tritanium" }, price: { kind: "isk", value: 1 },
  } };
  const h = harness({ registry: SCRIPT_MACROS });
  h.setObs(scenario.observation);
  h.runner.start(script([step]));
  await h.runner.tick();
  assert.equal(h.issued[0]?.kind, "placeSellOrder");
  await h.runner.suspendTransport();
  assert.throws(() => h.runner.resumeTransport(), /cannot be reset safely/);
  h.runner.resume();
  await h.runner.tick();
  assert.equal(h.runner.getStatus(), "paused");
  assert.equal(h.issued.length, 1);
  h.runner.stop();
});

for (const partial of [true, false]) {
  for (const suspended of [true, false]) {
    test(`${partial ? "partial" : "all-refused"} drone engagement ${suspended ? "during recovery" : "in a running tick"} retains the correct retry ownership`, async () => {
      const doc = script([macroStep("defend", "defend-with-drones")]);
      let entered!: () => void, fail!: (error: unknown) => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
      const issued: ScriptAction[] = [];
      const runner = createScriptRunner({ observe: async () => calm(),
        issue: async action => { issued.push(action); if (issued.length === 1) { entered(); await pending; } },
        registry: { "defend-with-drones": (_step, _obs, mem) => mem["engaged"]
          ? mt({ kind: "wait" }, { kind: "done" })
          : { ...mt({ kind: "engageDrones", droneIDs: [1, 2], targetID: 42 }, { kind: "acting" }), nextMem: { engaged: true } } },
        travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false,
        refusalReason: error => error instanceof Error ? `${"code" in error ? error.code : ""}: ${error.message}` : String(error),
      });
      runner.start(doc);
      const ticking = runner.tick();
      await started;
      const suspension = suspended ? runner.suspendTransport() : null;
      fail(Object.assign(new Error("TargetNotWithinRangeGeneric"), { code: "CALL_REFUSED",
        acceptedDroneIDs: partial ? [1] : [], refusedDroneIDs: partial ? [2] : [1, 2], uncertainDroneIDs: [],
      }));
      await ticking;
      await suspension;
      if (partial) {
        assert.equal(runner.getStatus(), "paused");
        assert.match(runner.snapshot().pauseReason ?? "", /Some drones accepted.*Verify.*Stop/);
        assert.equal(runner.transportCustody(), true);
        runner.resume();
        assert.equal(runner.resumeHeadHome("Stop"), false);
        assert.throws(() => runner.start(doc), /Verify the previous action/);
        await runner.suspendTransport();
        assert.throws(() => runner.resumeTransport(), /unresolved/);
        await runner.tick();
        assert.equal(issued.length, 1, "accepted drone 1 is never replayed by a full-flight retry");
        runner.stop();
        assert.equal(runner.transportCustody(), false, "explicit Stop follows manual outcome verification");
      } else {
        assert.equal(runner.transportCustody(), false, "every refused drone is positively known not to have accepted");
        if (suspended) runner.resumeTransport();
        for (let i = 0; i < 8 && runner.getStatus() === "running"; i++) await runner.tick();
        assert.equal(runner.getStatus(), "stopped");
        assert.equal(issued.length, 2);
        assert.deepEqual(issued[1], issued[0], "an entirely refused flight may retry unchanged");
      }
    });
  }
}

test("a refused first home movement does not discard the safety watch's destination", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: FakeItemNotFound") });
  h.setObs(calm({ health: 0.4 }));
  h.runner.start(script([macroStep("u", "undock")]));
  await h.runner.tick();
  h.setObs(calm({ health: 1 }));
  await issueTicks(h, 2);
  assert.deepEqual(h.issued.map(action => action.kind), ["warp", "warp"]);
  assert.equal(h.runner.getStatus(), "running", "recovered health does not abandon the latched trip");
});

test("owner overload is a definite non-dispatch and retries a one-shot action", async () => {
  const scenario = completionCases[0]!;
  let attempts = 0;
  const h = harness({ registry: SCRIPT_MACROS, issueThrows: () => attempts++ === 0
    ? Object.assign(new Error("EDGE_OWNER_OVERLOADED"), { code: "EDGE_OWNER_OVERLOADED" }) : null });
  h.setObs(scenario.observation);
  h.runner.start(script([scenario.step]));
  await issueTicks(h, 2);
  assert.equal(h.issued.length, 2);
  assert.equal(h.runner.getStatus(), "running");
});

test("pending jettison owns manual and transport resume and cannot issue twice", async () => {
  let pending = false;
  const h = harness({ mutationCustody: () => pending,
    registry: { "jettison-ore": () => mt({ kind: "jettison", itemIDs: [10] }, { kind: "acting" }) },
    issueThrows: () => { pending = true; return new Error("ambiguous jettison"); } });
  const s = script([macroStep("ore", "jettison-ore")]);
  h.runner.start(s);
  await h.runner.tick();
  assert.equal(h.issued.length, 1);
  assert.equal(h.runner.getStatus(), "paused");
  h.runner.resume();
  assert.equal(h.runner.getStatus(), "paused");
  assert.equal(h.runner.resumeHeadHome("Stop"), false);
  assert.throws(() => h.runner.start(s), /custody/);
  await h.runner.suspendTransport();
  assert.equal(h.runner.transportCustody(), true);
  assert.throws(() => h.runner.resumeTransport(), /unresolved/);
  await h.runner.tick();
  assert.equal(h.issued.length, 1);
  pending = false;
  h.runner.resumeTransport();
  assert.equal(h.runner.getStatus(), "running");
});

// ── The refusal ledger ──────────────────────────────────────────────────────
//
// THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. A bot answered 227
// consecutive refusals over twelve hours because the runner dropped every one
// of them: no count, no readout, no bound, and the same settle as a success.

/** Drive `count` decide-and-issue ticks, skipping whatever settle is imposed. */
async function issueTicks(h: ReturnType<typeof harness>, count: number): Promise<void> {
  let guard = 0;
  while (h.issued.length < count && guard < 500) {
    guard += 1;
    await h.runner.tick();
    if (h.runner.getStatus() !== "running") {
      return;
    }
  }
}

test("a refused call is COUNTED and shows up in the readout", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await issueTicks(h, 2);

  const latest = h.progress[h.progress.length - 1]!;
  assert.equal(latest.refusals.length, 1, "the run says what it is being refused");
  assert.equal(latest.refusals[0]?.count, 2);
  assert.match(latest.refusals[0]!.words, /room/i, "in player language, not a code");
  assert.equal(/NotEnoughCargoSpace/.test(latest.refusals[0]!.words), false);
});

test("a refused call BACKS OFF — it does not retry at the same speed as a success", async () => {
  const refused = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  refused.setObs(calm({ holdEmpty: false }));
  refused.runner.start(script([macroStep("a", "deliver-ore")]));

  // Ticks spent to get from the first issue to the second.
  await issueTicks(refused, 1);
  let ticksBetween = 0;
  while (refused.issued.length < 2 && ticksBetween < 100) {
    ticksBetween += 1;
    await refused.runner.tick();
  }
  assert.ok(
    ticksBetween > SETTLE_TICKS,
    `a refusal waits longer than the ordinary settle (waited ${ticksBetween})`,
  );
});

test("a run being refused over and over STOPS, in the server's own words", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 2_000) {
    guard += 1;
    await h.runner.tick();
  }

  assert.equal(h.runner.getStatus(), "paused", "it stopped rather than asking forever");
  const latest = h.progress[h.progress.length - 1]!;
  assert.match(latest.pauseReason ?? "", /refusals in a row/);
  assert.match(latest.pauseReason ?? "", /room/i, "and says WHAT was refused");
  // It does not stop WHERE IT STANDS: the first refusal cap latches and flies
  // the ship home, so the run only really stops once the way home is being
  // refused too. That is two budgets, not one, and still nothing like 227.
  assert.ok(
    h.issued.some((a) => a.kind === "warp"),
    "it tried to get the ship home before giving up",
  );
  assert.ok(
    h.issued.length <= MAX_CONSECUTIVE_REFUSALS * 2,
    `it gave up after ${h.issued.length} attempts, not 227`,
  );
});

test("a refusal storm heads home first, and only stops in space if the way home is refused too", async () => {
  // Only the DELIVER call is refused; the flight home is not. The bot must not
  // come to rest in the belt it was refused in.
  const h = harness({
    issueThrows: (a) => (a.kind === "unloadOre" ? new Error("CALL_REFUSED: NotEnoughCargoSpace") : null),
  });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 200 && !h.issued.some((a) => a.kind === "warp")) {
    guard += 1;
    await h.runner.tick();
  }
  assert.ok(h.issued.some((a) => a.kind === "warp"), "the refusal cap sends it home");
  assert.equal(h.runner.getStatus(), "running", "and it is still flying, not parked");

  // Docked: now it stops, with the refusal as the reason.
  h.setObs(calm({ holdEmpty: false, docked: true, inSpace: false }));
  guard = 0;
  while (h.runner.getStatus() === "running" && guard < 50) {
    guard += 1;
    await h.runner.tick();
  }
  assert.equal(h.runner.getStatus(), "paused");
  assert.match(h.progress[h.progress.length - 1]!.pauseReason ?? "", /refusals in a row/);
});

test("headHome flies the ship in and pauses docked with the given reason", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  await h.runner.tick();

  assert.equal(h.runner.headHome("The approved run time ended."), true);
  assert.equal(h.runner.headHome("The approved run time ended."), true, "already on its way is still yes");
  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 50 && !h.issued.some((a) => a.kind === "warp")) {
    guard += 1;
    await h.runner.tick();
  }
  assert.ok(h.issued.some((a) => a.kind === "warp"), "it flies home rather than stopping in space");
  assert.equal(h.runner.getStatus(), "running");

  h.setObs(calm({ holdEmpty: false, docked: true, inSpace: false }));
  guard = 0;
  while (h.runner.getStatus() === "running" && guard < 50) {
    guard += 1;
    await h.runner.tick();
  }
  assert.equal(h.runner.getStatus(), "paused");
  assert.match(h.progress[h.progress.length - 1]!.pauseReason ?? "", /approved run time ended/);
});

test("headHome has nothing to send when no script is running", () => {
  const h = harness();
  assert.equal(h.runner.headHome("The approved run time ended."), false);
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  h.runner.pause();
  assert.equal(h.runner.headHome("The approved run time ended."), false);
});

test("an unconfirmed corporate route move pauses before any automatic retry", async () => {
  const action: ScriptAction = { kind: "haulTransfer", itemID: 10, quantity: 5,
    from: { kind: "cargo" }, to: { kind: "corp", division: 2 },
    stationID: 1, corporationID: 98000123, division: 2, typeID: 34, sourceQuantity: 10 };
  const h = harness({
    registry: { "haul-all": () => mt(action, { kind: "acting" }) },
    issueThrows: () => new Error("HAUL_TRANSFER_UNCONFIRMED"),
  });
  h.runner.start(script([macroStep("h", "haul-all")]));
  await h.runner.tick();
  assert.equal(h.runner.getStatus(), "paused");
  assert.match(h.progress.at(-1)?.pauseReason ?? "", /reconciliation/i);
  await h.runner.tick();
  assert.equal(h.issued.length, 1, "the route cannot blindly retry or auto-reconcile while paused");
});

for (const applied of [true, false]) {
  test(`a suspended corporate transfer retains its manifest for ${applied ? "applied" : "refused"} reconciliation`, async () => {
    const row = (itemID: number, quantity: number) => ({ itemID, quantity, typeID: 34, groupID: 18, categoryID: 4,
      flagID: null, singleton: false, volume: 1 });
    const station = (id: number) => ({ kind: "station" as const, ref: { entity: "station" as const, id,
      name: `Station ${id}`, systemName: null } });
    const step: MacroStep = { id: "haul", kind: "macro", macro: "haul-all", args: {
      pickupStation: station(1), deliveryStation: station(2),
      pickupCorpDivision: { kind: "corpDivision", division: 1, name: null },
      deliveryCorpDivision: { kind: "corpDivision", division: 2, name: null },
    } };
    const source = [row(10, 20)];
    const destination = [row(99, 30)];
    let observation = calm({ inSpace: false, docked: true,
      flightStatus: flight({ inSpace: false, docked: true, stationID: 1 }), myCorporationID: 98000123,
      haulDivisions: { 1: source }, cargo: { rows: destination, capacity: { capacity: 100, used: 30 } }, shipBays: [],
    });
    let entered!: () => void, fail!: (error: unknown) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    let received: Parameters<MacroDecider>[2] | null = null;
    const issued: ScriptAction[] = [];
    const runner = createScriptRunner({ observe: async () => observation,
      issue: async action => { issued.push(action); entered(); await pending; },
      registry: { "haul-all": (s, o, mem, board) => { received = mem; return SCRIPT_MACROS["haul-all"](s, o, mem, board); } },
      travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    });
    runner.start(script([step]));
    const ticking = runner.tick();
    await started;
    assert.equal(issued[0]?.kind, "haulTransfer");
    const suspension = runner.suspendTransport();
    fail(Object.assign(new Error("EVE_GATEWAY_TIMEOUT"), { code: "EVE_GATEWAY_TIMEOUT" }));
    await ticking;
    await suspension;
    if (applied) observation = { ...observation, haulDivisions: { 1: [] },
      cargo: { rows: [row(99, 50)], capacity: { capacity: 100, used: 50 } } };
    runner.resumeTransport();
    await runner.tick();
    const manifest = (received as Parameters<MacroDecider>[2] | null)?.["haul"] as
      { pending?: { source: unknown; destination: unknown; quantity: number } } | undefined;
    assert.equal(manifest?.pending?.source, source, "the exact source baseline is retained");
    assert.equal(manifest?.pending?.destination, destination, "the exact destination baseline is retained");
    assert.equal(manifest?.pending?.quantity, 20);
    assert.equal(issued.length, 1, "reconciliation runs before any new transfer");
    if (applied) assert.match(runner.snapshot().why ?? "", /route transfer is verified/);
    else assert.match(runner.snapshot().pauseReason ?? "", /partial, refused or ambiguous/);
    runner.stop();
  });
}

test("a suspended strict corporate unload retains unverified state and cannot bypass recovery", async () => {
  const manifest = { itemIDs: [10], destination: 2 };
  let entered!: () => void, fail!: (error: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const runner = createScriptRunner({ observe: async () => calm({ holdEmpty: false }),
    issue: async () => { entered(); await pending; },
    registry: { "deliver-ore": () => ({ ...mt({ kind: "unloadOre", itemIDs: [10], division: 2, strictCorp: true },
      { kind: "acting" }), nextMem: { pending: manifest } }) },
    travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
  });
  runner.start(script([macroStep("deliver", "deliver-ore")]));
  const ticking = runner.tick();
  await started;
  const suspension = runner.suspendTransport();
  fail(Object.assign(new Error("EVE_GATEWAY_TIMEOUT"), { code: "EVE_GATEWAY_TIMEOUT" }));
  await ticking;
  await suspension;
  assert.throws(() => runner.resumeTransport(), /cannot be reset safely/);
  runner.resume();
  assert.equal(runner.getStatus(), "paused");
  assert.equal(runner.resumeHeadHome("Stop"), false);
  runner.stop();
});

test("hosted graceful Stop waits for an issued action, then can resume only the home trip", async () => {
  let issueStarted: () => void = () => {};
  let finishIssue: () => void = () => {};
  const started = new Promise<void>((resolve) => { issueStarted = resolve; });
  const held = new Promise<void>((resolve) => { finishIssue = resolve; });
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({
    observe: async () => calm({ holdEmpty: false }),
    issue: async (action) => {
      issued.push(action);
      if (action.kind === "unloadOre") { issueStarted(); await held; }
      return null;
    },
    sleep: async () => {}, onProgress: () => {},
    isSessionLost: () => false, refusalReason: (error) => String(error), registry, travelHome: home,
  });
  runner.start(script([macroStep("a", "deliver-ore")]));
  const ticking = runner.tick();
  await started;
  let settled = false;
  const stopping = runner.beginGracefulStop().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "an in-flight issue still owns the pilot");
  assert.equal(runner.getStatus(), "paused");
  finishIssue();
  await ticking;
  await stopping;
  assert.equal(settled, true);
  assert.equal(runner.resumeHeadHome("Deadline reached"), true);
  await runner.tick();
  assert.ok(issued.some((action) => action.kind === "warp"), "Farmer's home trip still runs after safety settlement");
});

test("transport suspension waits for an issued transfer and retains its claim on session loss", async () => {
  let entered!: () => void, fail!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const released: string[] = [];
  const runner = createScriptRunner({
    observe: async () => calm({ flightStatus: { solarSystemID: 30000142 } as FlightStatus }),
    issue: async () => { entered(); await pending; return null; },
    claims: { read: async () => [], acquire: async () => true, release: async owner => { released.push(owner); } },
    registry: { "loot-containers": () => ({ ...mt({ kind: "lootContainer", containerID: 42 }, { kind: "acting" }), containerTargetID: 42 }) },
    travelHome: home, sleep: async () => {}, onProgress: () => {},
    isSessionLost: e => e instanceof SessionLost, refusalReason: String,
  });
  runner.start(script([macroStep("a", "loot-containers")]));
  const ticking = runner.tick(); await started;
  let finished = false;
  const frozen = runner.suspendTransport().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(runner.getStatus(), "paused");
  fail(new SessionLost()); await ticking; await frozen;
  assert.equal(runner.getStatus(), "paused", "late session loss cannot terminally unwind the suspended runner");
  assert.equal(runner.transportCustody(), true);
  assert.deepEqual(released, [], "transport loss cannot surrender the pending transfer's claim");
  await runner.tick(); assert.deepEqual(released, []);
  await runner.beginGracefulStop(); assert.equal(released.length, 1, "ordinary explicit settlement remains available");
});

test("transport suspension fences an awaited observation without resetting the script", async () => {
  let entered!: () => void, fail!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<ScriptObservation>((_resolve, reject) => { fail = reject; });
  let first = true;
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({
    observe: async () => { if (first) { first = false; entered(); return pending; } return calm({ holdEmpty: false }); },
    issue: async action => { issued.push(action); return null; },
    registry, travelHome: home, sleep: async () => {}, onProgress: () => {},
    isSessionLost: e => e instanceof SessionLost, refusalReason: String,
  });
  runner.start(script([macroStep("a", "deliver-ore")]));
  const ticking = runner.tick(); await started;
  const frozen = runner.suspendTransport(); fail(new SessionLost()); await ticking; await frozen;
  assert.equal(runner.getStatus(), "paused"); assert.equal(runner.transportCustody(), false);
  assert.equal(issued.length, 0);
  runner.resumeTransport(); await runner.tick();
  assert.equal(issued[0]?.kind, "unloadOre", "the original program can continue after fresh authority is verified");
});

test("late claim acquisition cannot release custody or resurrect a suspended runner", async () => {
  for (const outcome of ["acquired", "refused", "unreadable"] as const) {
    let entered!: () => void, finish!: (value: boolean) => void, fail!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const acquisition = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    const released: string[] = [];
    const runner = createScriptRunner({
      observe: async () => calm({ flightStatus: { solarSystemID: 30000142 } as FlightStatus }),
      issue: async () => { assert.fail("a superseded acquisition cannot issue"); },
      claims: { read: async () => [], acquire: async () => { entered(); return acquisition; }, release: async owner => { released.push(owner); } },
      registry: { "loot-containers": () => ({ ...mt({ kind: "lootContainer", containerID: 42 }, { kind: "acting" }), containerTargetID: 42 }) },
      travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    });
    runner.start(script([macroStep("a", "loot-containers")]));
    const ticking = runner.tick(); await started; const frozen = runner.suspendTransport();
    if (outcome === "unreadable") fail(new Error("claim authority lost")); else finish(outcome === "acquired");
    await ticking; await frozen;
    assert.equal(runner.getStatus(), "paused"); assert.deepEqual(released, []);
    assert.equal(runner.transportCustody(), outcome === "acquired");
    if (outcome === "acquired") assert.throws(() => runner.resumeTransport(), /unresolved/);
    else { runner.resumeTransport(); assert.equal(runner.getStatus(), "running"); }
  }
});

test("the pause reason survives the decider's cheerful why", async () => {
  // The decider's tick knows nothing about a refusal the issue then hit, so a
  // snapshot built from it alone would pause the run and still show "why".
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 2_000) {
    guard += 1;
    await h.runner.tick();
  }
  const latest = h.progress[h.progress.length - 1]!;
  assert.notEqual(latest.why, "why", "the decider's wording must not survive a refusal pause");
  assert.equal(latest.why, latest.pauseReason);
});

test("a call that succeeds ENDS the streak, so an old blip cannot stop the run later", async () => {
  let failNext = true;
  const h = harness({
    issueThrows: () => (failNext ? new Error("CALL_REFUSED: NotEnoughCargoSpace") : null),
  });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await issueTicks(h, 1);
  assert.equal(h.progress[h.progress.length - 1]!.refusals.length, 1);

  failNext = false;
  await issueTicks(h, 2);
  assert.deepEqual(
    h.progress[h.progress.length - 1]!.refusals,
    [],
    "one success clears it",
  );
});

test("a fresh run does not inherit the last one's refusals", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  await issueTicks(h, 3);
  assert.ok(h.progress[h.progress.length - 1]!.refusals[0]!.count >= 3);

  h.runner.start(script([macroStep("a", "deliver-ore")]));
  assert.deepEqual(h.progress[h.progress.length - 1]!.refusals, []);
});

test("ordinary writes still settle before deciding again", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await h.runner.tick();
  assert.deepEqual(h.issued.map((a) => a.kind), ["unloadOre"]);

  // The next SETTLE_TICKS ticks issue nothing.
  for (let i = 0; i < SETTLE_TICKS; i += 1) {
    await h.runner.tick();
  }
  assert.equal(h.issued.length, 1, "no world call during the settle window");

  // The write has now landed; the next decision can observe completion.
  h.setObs(calm({ holdEmpty: true }));
  await h.runner.tick();
  assert.deepEqual(h.issued.map((a) => a.kind), ["unloadOre"]);
  assert.equal(h.runner.getStatus(), "stopped");
});

// ── The per-kind settle (scriptDecide `settleTicksFor`) ──────────────────────
//
// The runner used to charge every action the same flat two ticks of
// not-deciding, so at a 2 s cadence EVERY action cost six seconds — 20-35 s
// between landing on a grid and the first point of drone damage. These pin the
// three buckets from the runner's side: the table is consulted, it is consulted
// per KIND, and the one entry a future reader is most likely to "tidy" is not
// in it.

/** A macro that issues `action` for ever — so a settle is the ONLY thing that gates it. */
function alwaysIssues(action: ScriptAction): MacroDecider {
  return () => mt(action, { kind: "acting" });
}

test("a 0-settle action can issue again on the very next tick", async () => {
  // `lock` is guard-(a) at every real call site, so the runner owes it nothing.
  const h = harness({ registry: { undock: alwaysIssues({ kind: "lock", targetID: 4001 }) } });
  h.runner.start(script([macroStep("a", "undock")]));

  await h.runner.tick();
  assert.deepEqual(h.issued.map((a) => a.kind), ["lock"]);

  await h.runner.tick();
  assert.deepEqual(
    h.issued.map((a) => a.kind),
    ["lock", "lock"],
    "no settle at all — the next tick decides",
  );
});

test("a 1-settle action waits exactly one tick, then can issue", async () => {
  // `activate` pays one tick because its guard is the observation's running-module
  // list, and a duplicate comes back as EffectAlreadyActive2 — a refusal the
  // ledger books, and ten on one key end the run.
  const h = harness({
    registry: { undock: alwaysIssues({ kind: "activate", moduleID: 7, targetID: 4001 }) },
  });
  h.runner.start(script([macroStep("a", "undock")]));

  await h.runner.tick();
  assert.equal(h.issued.length, 1);

  await h.runner.tick();
  assert.equal(h.issued.length, 1, "exactly one tick of not-deciding");

  await h.runner.tick();
  assert.equal(h.issued.length, 2, "and then it decides again — not two ticks, not three");
});

test("⚠ warp still pays the FULL settle — it is the one movement action that is not idempotent", async () => {
  // THE REGRESSION TEST. Every other movement action (approach/align/orbit/
  // keepAtRange) is a standing server-side order and sits at 0, which makes warp
  // look like an oversight. It is not: re-sending a warp is "at worst a second
  // warp the moment the first lands", and travelToBelt / mineNoTargetRocks /
  // dockAtNearest / compressOre all emit it with NO memory guard whatsoever. The
  // flat settle is the only thing preventing a double warp at those sites.
  const h = harness({ registry: { undock: alwaysIssues({ kind: "warp", targetID: 4002 }) } });
  h.runner.start(script([macroStep("a", "undock")]));

  await h.runner.tick();
  assert.equal(h.issued.length, 1);

  for (let i = 0; i < SETTLE_TICKS; i += 1) {
    await h.runner.tick();
    assert.equal(h.issued.length, 1, `a warp must not be re-issued ${i + 1} tick(s) after the first`);
  }

  await h.runner.tick();
  assert.equal(h.issued.length, 2, "and after the full settle it may warp again");
});

// These four used to be served by the runner's own
// `returnsAuthoritativeSessionReadiness`; they are now simply the first four
// entries of `settleTicksFor`'s table. The behaviour they pin must be identical,
// which is the point of leaving the tests exactly as they were.
const READY_RETURNING_SESSION_ACTIONS: readonly ScriptAction[] = [
  { kind: "undock" },
  { kind: "dock", stationID: 60003760 },
  { kind: "jump", fromGateID: 50000802, toGateID: 50001248 },
  { kind: "boardShip", shipID: 9001 },
];

for (const sessionAction of READY_RETURNING_SESSION_ACTIONS) {
  test(`ready-returning ${sessionAction.kind} immediately advances without duplicating the call`, async () => {
    const sessionChange: MacroDecider = (_step, observation) =>
      observation.inSpace
        ? mt({ kind: "wait" }, { kind: "done" })
        : mt(sessionAction, { kind: "acting" });
    const h = harness({
      registry: { undock: sessionChange, "deliver-ore": deliver },
    });
    h.setObs(calm({ inSpace: false, holdEmpty: false }));
    h.runner.start(script([
      macroStep("session", "undock"),
      macroStep("next", "deliver-ore"),
    ]));

    await h.runner.tick();
    assert.deepEqual(h.issued.map((action) => action.kind), [sessionAction.kind]);

    // The BFF promise has returned with authoritative ready state. The next
    // tick advances straight to the following decision—no fixed settle ticks.
    h.setObs(calm({ inSpace: true, holdEmpty: false }));
    await h.runner.tick();
    assert.deepEqual(
      h.issued.map((action) => action.kind),
      [sessionAction.kind, "unloadOre"],
    );
    assert.equal(
      h.issued.filter((action) => action.kind === sessionAction.kind).length,
      1,
      "the completed session change is not re-issued",
    );
  });
}

test("pause stops the loop and blocks further ticks", async () => {
  const h = harness();
  h.setObs(calm({ inSpace: false, holdEmpty: false }));
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.tick();
  const before = h.issued.length;

  h.runner.pause();
  assert.equal(h.runner.getStatus(), "paused");
  await h.runner.tick(); // must do nothing
  assert.equal(h.issued.length, before);
});

test("a lost session ends the run in error", async () => {
  const h = harness({ observeThrows: () => { throw new SessionLost("gone"); } });
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.tick();
  assert.equal(h.runner.getStatus(), "error");
  assert.equal(h.progress.at(-1)?.status, "error");
});

test("repeated read failures give up with a plain reason", async () => {
  let fail = true;
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  const runner = createScriptRunner({
    observe: async () => {
      if (fail) {
        throw new Error("read failed"); // not a session loss
      }
      return calm();
    },
    issue: async (a) => { issued.push(a); },
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    registry,
    travelHome: home,
  });
  runner.start(script([macroStep("a", "undock")]));
  for (let i = 0; i < MAX_READ_FAILURES; i += 1) {
    await runner.tick();
  }
  assert.equal(runner.getStatus(), "paused");
  assert.match(progress.at(-1)?.pauseReason ?? "", /several tries/i);
});

test("failed observations retain their cause without changing the bounded retry gate", async () => {
  const entries: BotLogDraft[] = [];
  const h = harness({ observeThrows: () => { throw new Error("CALL_REFUSED: fitting unavailable"); },
    log: { write: row => { entries.push(row); } } });
  h.runner.start(script([macroStep("a", "undock")]));
  for (let n = 0; n < MAX_READ_FAILURES; n++) await h.runner.tick();
  const failures = entries.filter(row => row.kind === "result" && row.says === "observe ship state");
  assert.equal(failures.length, MAX_READ_FAILURES);
  assert.ok(failures.every(row => row.ok === false && row.refusal === "CALL_REFUSED: fitting unavailable" && row.action === undefined));
  assert.equal(h.runner.getStatus(), "paused");
  assert.ok(!h.issued.some(row => row.kind === "undock"));
});

test("branch-entry observation hints reach the observer before selecting a macro", async () => {
  const branch: ProgramNode = { id: "hold", kind: "branch", when: { kind: "ore-hold-at-least", fraction: 0.9 },
    then: [macroStep("delivery", "deliver-ore")], else: [macroStep("depart", "undock")] };
  for (const program of [[branch], [{ id: "loop", kind: "loop", repeat: { kind: "forever" }, body: [branch] }]] as readonly (readonly ProgramNode[])[]) {
    const entries: BotLogDraft[] = [];
    const h = harness({ log: { write: row => { entries.push(row); } } });
    h.setObs(calm({ inSpace: false, docked: true }));
    h.runner.start(script(program));
    for (let n = 0; n < 8; n++) await h.runner.tick();
    assert.ok(h.issued.some(action => action.kind === "undock"));
    assert.equal(entries.filter(row => row.says === "observe ship state").length, 0);
    assert.equal(h.runner.getStatus(), "running");
  }
});

test("reads that give up send the ship to the station the bot is configured to dock at", async () => {
  // Blind, nothing can be DECIDED -- but the autopilot runs on its own reads, and
  // the dock station is a SETTING on the script, not something read from the
  // world. So the ship gets moving instead of floating where it went blind.
  let reads = 0;
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  const runner = createScriptRunner({
    observe: async () => {
      reads += 1;
      if (reads > 1) {
        throw new Error("read failed"); // not a session loss
      }
      return calm({ holdEmpty: false }); // note: no homeStationID on the read
    },
    issue: async (a) => { issued.push(a); },
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    registry,
    travelHome: home,
  });
  runner.start(script([macroStep("a", "deliver-ore")]));
  // Generous: the one good read issues an action, and the settle between actions
  // costs ticks before the failures even start counting.
  for (let i = 0; i < 30 && runner.getStatus() === "running"; i += 1) {
    await runner.tick();
  }

  assert.equal(runner.getStatus(), "paused");
  const route = issued.find((a) => a.kind === "startRoute");
  assert.ok(route !== undefined && route.kind === "startRoute" && route.stationID === 1, "sent to the script's own home");
  assert.match(progress.at(-1)?.pauseReason ?? "", /sent it to a station/i);
});

test("reads that give up with NO station to send it to say the plain thing", async () => {
  // Home is "wherever the ship started", the run started in space, and nothing
  // was observed to fall back on -- so there is no honest destination.
  const homeless: BotScript = {
    ...script([macroStep("a", "deliver-ore")]),
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
  };
  let reads = 0;
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  const runner = createScriptRunner({
    observe: async () => {
      reads += 1;
      if (reads > 1) {
        throw new Error("read failed");
      }
      return calm({ holdEmpty: false });
    },
    issue: async (a) => { issued.push(a); },
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    registry,
    travelHome: home,
  });
  runner.start(homeless);
  for (let i = 0; i < 30 && runner.getStatus() === "running"; i += 1) {
    await runner.tick();
  }
  assert.equal(runner.getStatus(), "paused");
  assert.equal(issued.some((a) => a.kind === "startRoute"), false, "no guessed destination");
  assert.match(progress.at(-1)?.pauseReason ?? "", /so the bot stopped/i);
});

test("run() drives to a clean finish and stops", async () => {
  const h = harness();
  h.setObs(calm({ inSpace: true })); // undock already satisfied -> program done at once
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.run();
  assert.equal(h.runner.getStatus(), "stopped");
  assert.equal(h.progress.at(-1)?.status, "stopped");
});

// ── The flight recorder ──────────────────────────────────────────────────────
//
// The runner is the ONE place an action is performed, so it is the one place
// the log is written — no macro knows the recorder exists. These pin what
// reaches it and, above all, that it can never cost a ship.

function recordingSink(): { sink: BotLogSink; lines: BotLogDraft[] } {
  const lines: BotLogDraft[] = [];
  return { sink: { write: (draft) => lines.push(draft) }, lines };
}

test("a run writes its header, then intent BEFORE each action and the result after", async () => {
  const { sink, lines } = recordingSink();
  const h = harness({ log: sink });
  h.setObs(calm({ inSpace: false }));
  h.runner.start(script([macroStep("u", "undock")]));
  await h.runner.tick();

  const kinds = lines.map((l) => l.kind);
  assert.deepEqual(kinds.slice(0, 2), ["start", "decide"], "the run announces itself before anything else");
  const issued = lines.findIndex((l) => l.kind === "issue");
  const result = lines.findIndex((l) => l.kind === "result");
  assert.ok(issued >= 0 && result > issued, "intent must be written before the call, result after");
  assert.equal(lines[issued]!.says, "undock", "the line says what it was, in words");
  assert.deepEqual(lines[issued]!.action, { kind: "undock" }, "and carries the action verbatim");
  assert.equal(lines[result]!.ok, true);
  assert.ok(lines.every((l) => l.run === lines[0]!.run), "every line of a run shares its id");
});

test("a refusal is logged as a result that did NOT land, with the server's words", async () => {
  const { sink, lines } = recordingSink();
  const h = harness({ log: sink, issueThrows: () => new Error("FakeItemNotFound") });
  h.setObs(calm({ inSpace: false }));
  h.runner.start(script([macroStep("u", "undock")]));
  await h.runner.tick();

  const result = lines.find((l) => l.kind === "result");
  assert.ok(result !== undefined);
  assert.equal(result.ok, false);
  assert.match(result.refusal ?? "", /FakeItemNotFound/);
});

test("a note from a landed call is recorded WITHOUT being counted as a refusal", async () => {
  // The delivery that went into the pilot's own hangar because the corporation
  // refused it. The ore is ashore, so there is nothing to retry and no streak to
  // count — but a run that said nothing would leave the player to discover it
  // from an empty corporation hangar.
  const { sink, lines } = recordingSink();
  const h = harness({
    log: sink,
    issueNote: (a) => (a.kind === "unloadOre" ? "corp division 3 refused; the load went into your own hangar" : null),
  });
  h.setObs(calm({ holdEmpty: false, docked: true, inSpace: false }));
  h.runner.start(script([macroStep("d", "deliver-ore")]));
  await h.runner.tick();

  const result = lines.find((l) => l.kind === "result");
  assert.ok(result !== undefined);
  assert.equal(result.ok, true, "a note is not a failure");
  assert.match(result.status ?? "", /went into your own hangar/);
  assert.equal(result.refusal, undefined, "and it is not the server refusing the call");

  const latest = h.progress[h.progress.length - 1]!;
  assert.deepEqual([...latest.refusals], [], "nothing to retry, so nothing is counted");
  assert.equal(h.runner.getStatus(), "running");
});

test("only CHANGES are written — a bot repeating itself does not fill a disk", async () => {
  const { sink, lines } = recordingSink();
  const h = harness({ log: sink });
  h.runner.start(script([macroStep("u", "undock"), macroStep("d", "deliver-ore")]));
  await h.runner.tick();
  const afterFirst = lines.filter((l) => l.kind === "decide").length;
  await h.runner.tick();
  await h.runner.tick();
  const afterMore = lines.filter((l) => l.kind === "decide").length;
  assert.ok(afterMore <= afterFirst + 1, `repeated identical ticks wrote ${afterMore - afterFirst} lines`);
});

test("the run's end is written, with the reason it ended", async () => {
  const { sink, lines } = recordingSink();
  const h = harness({ log: sink });
  h.runner.start(script([macroStep("u", "undock"), macroStep("d", "deliver-ore")]));
  await h.runner.tick();
  await h.runner.tick();
  const end = lines.find((l) => l.kind === "end");
  assert.ok(end !== undefined, "a finished run must say so");
  assert.equal(end.status, "stopped");
});

test("⚠ RULE 4: a recorder that throws loses its lines, never the ship", async () => {
  const exploding: BotLogSink = {
    write: () => {
      throw new Error("the disk is full and the route is down");
    },
  };
  const h = harness({ log: exploding });
  h.setObs(calm({ inSpace: false }));
  h.runner.start(script([macroStep("u", "undock")]));
  await h.runner.tick();

  assert.deepEqual(h.issued, [{ kind: "undock" }], "the action still went out");
  assert.equal(h.runner.getStatus(), "running", "and the run is still running");
});

test("a run ends exactly once, however many times it is told to stop", async () => {
  const { sink, lines } = recordingSink();
  const h = harness({ log: sink });
  h.runner.start(script([macroStep("u", "undock"), macroStep("d", "deliver-ore")]));
  await h.runner.tick();
  await h.runner.tick();
  h.runner.stop();
  h.runner.stop();
  assert.equal(lines.filter((l) => l.kind === "end").length, 1, "a log nobody can count runs in is worth less");
});

// ── Coming back in a pod, and arriving on a gate ─────────────────────────────
//
// THE TESTS THAT WOULD HAVE CAUGHT THE 2026-09-09/10 LOSSES. Three ships were
// destroyed and every one of them kept flying its script afterwards: the
// session survives a hull, the reads keep working, and nothing in the loop ever
// asked whether the thing it was flying was still a ship. The second pair cover
// the other half of the same night — a jump's ten-second cooldown turning the
// hardeners back, booked as a refusal and never asked for again.

/** A flight status carrying only what these tests judge on. */
function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: true, docked: false, solarSystemID: 30000001, stationID: null,
    structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null,
    shipMode: null, shipSpeedFraction: null, ...over,
  };
}

/** The BFF's 409 while a previous session change is still settling. */
function settling(): Error & { code: string } {
  return Object.assign(new Error("SESSION_CHANGE_IN_PROGRESS: still settling"), {
    code: "SESSION_CHANGE_IN_PROGRESS",
  });
}

test("a pod is not a ship: the script stops rather than mining in a capsule", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false, flightStatus: flight({ shipIsCapsule: true }) }));
  h.runner.start(script([macroStep("d", "deliver-ore")]));

  await h.runner.tick();

  assert.equal(h.issued.length, 0, "nothing from the script goes out in a pod");
  const latest = h.progress[h.progress.length - 1]!;
  assert.match(latest.why ?? "", /capsule/i, "and it says why, in player language");
  assert.equal(h.runner.getStatus(), "running", "still ticking — a pod parked in a belt is still a target");
  assert.equal(latest.phase, "Heading home", "it heads for a station instead of stopping where it floats");
});

test("a pod heads home ONCE — the guard does not re-fire and pause it mid-flight", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false, flightStatus: flight({ shipIsCapsule: true }) }));
  h.runner.start(script([macroStep("d", "deliver-ore")]));

  await h.runner.tick();
  for (let i = 0; i < 6; i += 1) {
    await h.runner.tick();
  }

  assert.notEqual(h.runner.getStatus(), "paused", "pausing here strands the pod where it died");
  assert.ok(h.issued.some((a) => a.kind === "warp"), "the way home is actually flown");
});

test("`shipIsCapsule: null` is not a verdict — an older BFF must not stop a healthy run", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false, flightStatus: flight({ shipIsCapsule: null }) }));
  h.runner.start(script([macroStep("d", "deliver-ore")]));

  await h.runner.tick();

  assert.deepEqual(h.issued, [{ kind: "unloadOre", itemIDs: [1] }], "the script flies on");
  const latest = h.progress[h.progress.length - 1]!;
  assert.equal(/capsule/i.test(latest.why ?? ""), false, "we were not told, so nothing is claimed");
});

test("a settling session change is NOT a refusal: the same press is made again", async () => {
  let thrown = 0;
  const h = harness({
    issueThrows: () => (thrown++ < 2 ? settling() : null),
  });
  h.setObs(calm({ inSpace: false }));
  h.runner.start(script([macroStep("u", "undock")]));

  await issueTicks(h, 3);

  assert.deepEqual(
    h.issued,
    [{ kind: "undock" }, { kind: "undock" }, { kind: "undock" }],
    "the press the cooldown ate is asked for again — this is the hardener that never went up",
  );
  const latest = h.progress[h.progress.length - 1]!;
  assert.equal(latest.refusals.length, 0, "a cooldown is not the ship refusing, and must not fill the ledger");
  assert.equal(h.runner.getStatus(), "running");
});

test("a session change that never settles still ends the run, by heading home", async () => {
  const h = harness({ issueThrows: () => settling() });
  h.setObs(calm({ inSpace: false }));
  h.runner.start(script([macroStep("u", "undock")]));

  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 400) {
    guard += 1;
    await h.runner.tick();
    const latest = h.progress[h.progress.length - 1];
    if (latest?.phase === "Heading home") {
      break;
    }
  }

  const latest = h.progress[h.progress.length - 1]!;
  assert.match(latest.why ?? "", /turned back while a session change/i, "waiting forever is its own way to lose a ship");
});
