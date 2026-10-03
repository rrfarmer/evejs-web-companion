// A4b — the orchestrator. These drive the scan with FAKE macros so the safety
// properties are tested in isolation from real world calls: sequencing, loop
// counting with per-pass memory reset, the arming guard on `until` (the
// belt-empty class), the livelock guard, the cannot-tell streak, the step-tick
// cap, and every interrupt response.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, BranchBlock, Condition, InterruptRow, MacroStep, ProgramNode } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import {
  MAX_RECOVER_TRIPS,
  MAX_SILENT_STEP_TICKS,
  decideScriptAction,
  initialMemory,
  activeMacroID,
  activeStepToursOreSites,
  activeSquadRole,
  watchSquadRole,
  DEFAULT_SETTLE_TICKS,
  settleTicksFor,
  type HomeTravelDecider,
  type MacroDecider,
  type MacroMemory,
  type MacroTick,
  type ScriptMemory,
} from "./scriptDecide.ts";
import { MAX_CANNOT_TELL_STREAK } from "./scriptConditions.ts";

test("acute hull escape outranks combat and idle/active/no-op repair even when authored last", () => {
  const combat: InterruptRow = { id: "combat", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const repair: InterruptRow = { id: "rep", when: { kind: "hull-below", fraction: 0.5 }, respond: "repair" };
  const escape: InterruptRow = { id: "acute", when: { kind: "hull-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const s = underWatches([combat, repair, escape]);
  for (const active of [[], [13]]) {
    const r = decideScriptAction(s, obs({ hullRatio: 0.2, hostileOnGrid: true, hullRepairerIDs: [13],
      combatDroneBayItemIDs: [21], snapshot: running(...active) }), initialMemory(s), registry, home);
    assert.equal(r.interruptID, "acute"); assert.equal(r.action.kind, "warp");
    const docked = decideScriptAction(s, obs({ docked: true, inSpace: false, hullRatio: 0.2 }), r.memory, registry, home);
    assert.equal(docked.status, "paused");
  }
});
test("recovered repairer OFF maintenance outranks a persistent combat watch", () => {
  const s = underWatches([
    { id: "combat", when: { kind: "hostile-on-grid" }, respond: "launch-drones" },
    { id: "rep", when: { kind: "armor-below", fraction: 0.3 }, respond: "repair" },
  ]);
  const r = decideScriptAction(s, obs({ hostileOnGrid: true, armorRatio: 1, armorRepairerIDs: [12],
    combatDroneBayItemIDs: [21], snapshot: running(12) }), initialMemory(s), registry, home);
  assert.deepEqual(r.action, { kind: "deactivate", moduleID: 12 });
});
test("unknown cap or active-module state does not blind-activate a repairer", () => {
  const s = underWatches([{ id: "rep", when: { kind: "armor-below", fraction: 0.3 }, respond: "repair" }]);
  for (const unknown of [{ capacitorRatio: null, snapshot: running() }, { capacitorRatio: 1, snapshot: null }]) {
    const r = decideScriptAction(s, obs({ armorRatio: 0.2, armorRepairerIDs: [12], ...unknown }), initialMemory(s), registry, home);
    assert.notEqual(r.interruptID, "rep");
  }
});
test("a repair recovery latch becomes terminal when hull emergency appears", () => {
  const s = underWatches([
    { id: "repair-trip", when: { kind: "armor-below", fraction: 0.3 }, respond: "dock-and-repair" },
    { id: "acute", when: { kind: "hull-below", fraction: 0.3 }, respond: "dock-and-pause" },
  ]);
  const recovery = decideScriptAction(s, obs({ armorRatio: 0.2 }), initialMemory(s), registry, home);
  assert.ok(recovery.memory.latched?.recover);
  const escape = decideScriptAction(s, obs({ hullRatio: 0.2 }), recovery.memory, registry, home);
  assert.equal(escape.memory.latched?.interruptID, "acute");
  assert.equal(escape.memory.latched?.recover, undefined);
  const arrived = decideScriptAction(s, obs({ docked: true, inSpace: false, hullRatio: 0.2 }), escape.memory, registry, home);
  assert.equal(arrived.status, "paused");
  assert.notEqual(arrived.action.kind, "undock");
});
test("combat until settles ownership before advancing to another block", () => {
  const s = script([macroStep("fight", "fight-with-drones", { kind: "hold-empty" }), macroStep("work", "mine-at-belt")], []);
  const memory = { ...initialMemory(s), macroMem: { fight: { combatOwned: { shipID: 9001, modules: { 12: {} },
    locks: [], drones: [], initialDrones: [], launched: false, movement: false, fleetCall: false } } } };
  const world = obs({ snapshot: { ...running(12)!, ship: { ...running(12)!.ship!, itemID: 9001 } },
    combatDroneIDs: [], myDrones: [], lockedTargetIDs: [] });
  const result = decideScriptAction(s, world, memory, { ...registry, "fight-with-drones": mine }, home);
  assert.deepEqual(result.action, { kind: "deactivate", moduleID: 12, settlement: true });
  assert.equal(result.stepPath, "fight");
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    capacitorRatio: 1,
    ...over,
  };
}

// A plain player-made health watch, reused across tests — not privileged in any
// way (the old non-deletable, auto-injected safety floor was removed 2026-07-23).
const floor: InterruptRow = {
  id: "floor",
  when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause",
};

function tick(action: MacroTick["action"], outcome: MacroTick["outcome"], armed = true, nextMem: MacroMemory = {}): MacroTick {
  return { action, why: "why", phase: "phase", armed, outcome, nextMem };
}

// Undock: done once in space, else issues undock.
const undock: MacroDecider = (_s, o) =>
  o.inSpace ? tick({ kind: "wait" }, { kind: "done" }) : tick({ kind: "undock" }, { kind: "acting" });

// Deliver: done once the hold is empty, else unloads.
const deliver: MacroDecider = (_s, o) =>
  o.holdEmpty ? tick({ kind: "wait" }, { kind: "done" }) : tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" });

// Mine: always acting and armed; the step's `until` decides when it is finished.
const mine: MacroDecider = () => tick({ kind: "activate", moduleID: 1, targetID: 2 }, { kind: "acting" }, true);

// Home travel: docked at home => done, else warps.
const home: HomeTravelDecider = (o) =>
  o.docked ? tick({ kind: "wait" }, { kind: "done" }) : tick({ kind: "warp", targetID: 9 }, { kind: "acting" });

function macroStep(id: string, macro: MacroStep["macro"], until?: MacroStep["until"]): MacroStep {
  const base = {
    id, kind: "macro" as const, macro,
    args: {
      belt: { kind: "belt" as const, belt: { mode: "nearest" as const } },
      station: { kind: "station" as const, ref: { entity: "station" as const, id: 1, name: "H", systemName: null } },
      equipment: { kind: "equipment" as const, equipment: { groupID: 1, label: "x" } },
    },
  };
  return until === undefined ? base : { ...base, until };
}

function script(program: readonly ProgramNode[], interrupts: readonly InterruptRow[] = [floor]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts, program,
  };
}

const registry = { undock, "deliver-ore": deliver, "mine-at-belt": mine, "travel-to-station": undock };

// Drive the runner across a sequence of observations, stopping when it leaves "running".
function run(
  s: BotScript,
  seq: readonly ScriptObservation[],
  reg: Record<string, MacroDecider> = registry,
): { results: ReturnType<typeof decideScriptAction>[]; mem: ScriptMemory } {
  let mem = initialMemory(s);
  const results: ReturnType<typeof decideScriptAction>[] = [];
  for (const o of seq) {
    const r = decideScriptAction(s, o, mem, reg, home);
    results.push(r);
    mem = r.memory;
    if (r.status !== "running") break;
  }
  return { results, mem };
}

// ─── Sequencing ──────────────────────────────────────────────────────────────

test("a two-step program runs in order and then finishes", () => {
  const s = script([macroStep("a", "undock"), macroStep("b", "deliver-ore")]);
  const { results } = run(s, [
    obs({ inSpace: false, holdEmpty: false }), // undock acts
    obs({ inSpace: true, holdEmpty: false }),  // undock done -> deliver acts
    obs({ inSpace: true, holdEmpty: true }),   // deliver done -> program done
  ]);
  assert.equal(results[0]?.action.kind, "undock");
  assert.equal(results[0]?.stepPath, "a");
  assert.equal(results[1]?.action.kind, "unloadOre");
  assert.equal(results[1]?.stepPath, "b");
  assert.equal(results[2]?.status, "done");
});

// ─── Loops ───────────────────────────────────────────────────────────────────

test("a times-2 loop runs its body twice and stops, memory resetting each pass", () => {
  // Body: mine (until ore full), then deliver (done when empty).
  const loop: ProgramNode = {
    id: "L", kind: "loop", repeat: { kind: "times", count: 2 },
    body: [macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }), macroStep("h", "deliver-ore")],
  };
  const s = script([loop]);
  // A realistic fill/haul cycle, consistent obs (empty <=> fraction 0).
  const { results } = run(s, [
    obs({ oreHoldFraction: 0.4, holdEmpty: false }), // pass1 mine
    obs({ oreHoldFraction: 0.95, holdEmpty: false }),// pass1 mine done -> haul acts
    obs({ oreHoldFraction: 0, holdEmpty: true }),    // pass1 haul done -> wrap -> pass2 mine acts
    obs({ oreHoldFraction: 0.95, holdEmpty: false }),// pass2 mine done -> haul acts
    obs({ oreHoldFraction: 0, holdEmpty: true }),    // pass2 haul done -> count reached -> program done
  ]);
  assert.equal(results[0]?.stepPath, "m");
  assert.equal(results[2]?.stepPath, "m", "pass 2 mines again after the wrap");
  assert.equal(results.at(-1)?.status, "done");
});

test("until-met with a mining laser still cycling switches it off before advancing", () => {
  // mine-at-belt's own tick (module 1, "activate") is thrown away the instant
  // `until` reads met — but if the laser is ALREADY active from an earlier
  // tick, leaving it cycling keeps filling the very hold the next step (a
  // jettison, typically) is trying to drain. It has to come off first.
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }), macroStep("h", "deliver-ore")]);
  const activeSnapshot = { ship: { activeModuleIDs: [1] } } as unknown as ScriptObservation["snapshot"];
  const { results } = run(s, [
    // until met, laser still active -> deactivate it, stay on the mine step.
    obs({ oreHoldFraction: 0.95, holdEmpty: false, miningModuleIDs: [1], snapshot: activeSnapshot }),
    // laser off now -> the mine step actually advances to the haul step.
    obs({
      oreHoldFraction: 0.95, holdEmpty: false, miningModuleIDs: [1],
      snapshot: { ship: { activeModuleIDs: [] } } as unknown as ScriptObservation["snapshot"],
    }),
  ]);
  assert.equal(results[0]?.action.kind, "deactivate");
  assert.ok(results[0]?.action.kind === "deactivate" && results[0].action.moduleID === 1);
  assert.equal(results[0]?.stepPath, "m", "still on the mine step — it has not advanced yet");
  assert.equal(results[1]?.stepPath, "h", "the laser is off, so it can advance now");
});

test("until-met with the laser off but the rock still locked releases the lock before advancing", () => {
  // The lock outlives the step exactly the same way the laser did above — left
  // alone, the NEXT mining cycle (after a jettison, say) picks a fresh rock on
  // top of it instead of trading it out, and a few cycles of that walk the ship
  // up to its max locked targets.
  const mineHoldingRock2: MacroDecider = () =>
    tick({ kind: "activate", moduleID: 1, targetID: 2 }, { kind: "acting" }, true, { rockID: 2 });
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }), macroStep("h", "deliver-ore")]);
  const idleSnapshot = { ship: { activeModuleIDs: [] } } as unknown as ScriptObservation["snapshot"];
  const localRegistry = { ...registry, "mine-at-belt": mineHoldingRock2 };
  const { results } = run(s, [
    // until met, laser already off, rock 2 still locked -> release it, stay put.
    obs({ oreHoldFraction: 0.95, holdEmpty: false, miningModuleIDs: [1], lockedTargetIDs: [2], snapshot: idleSnapshot }),
    // rock 2 no longer locked -> the mine step can finally advance.
    obs({ oreHoldFraction: 0.95, holdEmpty: false, miningModuleIDs: [1], lockedTargetIDs: [], snapshot: idleSnapshot }),
  ], localRegistry);
  assert.equal(results[0]?.action.kind, "unlock");
  assert.ok(results[0]?.action.kind === "unlock" && results[0].action.targetID === 2);
  assert.equal(results[0]?.stepPath, "m", "still on the mine step — it has not advanced yet");
  assert.equal(results[1]?.stepPath, "h", "the rock is unlocked, so it can advance now");
});

// ─── The "skipped" outcome ───────────────────────────────────────────────────

/** A step that cannot do its job on this ship — the salvage-without-a-salvager case. */
const skipper: MacroDecider = () => tick({ kind: "wait" }, { kind: "skipped", reason: "no way to do this" });
const skipRegistry = { ...registry, "salvage-wrecks": skipper };

test("a skipped step warns ONCE through the alert path and the program moves on", () => {
  const s = script([macroStep("sv", "salvage-wrecks"), macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  const first = decideScriptAction(s, obs(), initialMemory(s), skipRegistry, home);
  assert.equal(first.status, "running", "not paused");
  assert.equal(first.action.kind, "alert");
  assert.match(first.action.kind === "alert" ? first.action.message : "", /Skipped "Salvage the wrecks on this grid": no way to do this/);
  assert.equal(first.stepPath, "sv");
  // Next tick: the step after it is working, and nothing was said again.
  const next = decideScriptAction(s, obs(), first.memory, skipRegistry, home);
  assert.equal(next.stepPath, "m");
  assert.equal(next.action.kind, "activate");
});

test("a skipped step inside a loop is silent the second time round, and a loop of nothing but skips trips the livelock guard", () => {
  const loop: ProgramNode = { id: "L", kind: "loop", repeat: { kind: "forever" }, body: [macroStep("sv", "salvage-wrecks"), macroStep("u", "undock")] };
  const s = script([loop]);
  const first = decideScriptAction(s, obs({ inSpace: true }), initialMemory(s), skipRegistry, home);
  assert.equal(first.action.kind, "alert", "said once");
  // Round two: the skip is silent and the scan runs on to the livelock guard,
  // because undock-in-space and skip-salvage between them do nothing.
  const second = decideScriptAction(s, obs({ inSpace: true }), first.memory, skipRegistry, home);
  assert.equal(second.status, "running", "in space it heads home rather than parking there");
  assert.equal(second.action.kind, "warp");
  const stopped = decideScriptAction(s, obs({ inSpace: true, docked: true }), second.memory, skipRegistry, home);
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /nothing it can do/i);
});

test("a loop whose body can never do anything trips the livelock guard, and heads home to stop", () => {
  // Body is a single undock, but the ship is already in space, so every pass
  // completes instantly issuing no world call.
  const loop: ProgramNode = { id: "L", kind: "loop", repeat: { kind: "forever" }, body: [macroStep("u", "undock")] };
  const s = script([loop]);
  const r = decideScriptAction(s, obs({ inSpace: true }), initialMemory(s), registry, home);
  assert.equal(r.status, "running");
  assert.equal(r.action.kind, "warp", "a livelock in space is flown home, not parked");
  const stopped = decideScriptAction(s, obs({ inSpace: true, docked: true }), r.memory, registry, home);
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /nothing it can do/i);
});

// ─── Branches ────────────────────────────────────────────────────────────────

function branchNode(id: string, when: Condition, thenSteps: MacroStep[], elseSteps: MacroStep[]): BranchBlock {
  return { id, kind: "branch", when, then: thenSteps, else: elseSteps };
}

test("a branch runs the THEN side when its condition holds", () => {
  const s = script([branchNode("br", { kind: "shield-below", fraction: 0.5 }, [macroStep("t", "deliver-ore")], [macroStep("e", "undock")])], []);
  const { results } = run(s, [
    obs({ shieldRatio: 0.2, holdEmpty: false }), // shields low -> THEN: deliver acts
    obs({ shieldRatio: 0.2, holdEmpty: true }),  // deliver done -> branch done -> program done
  ]);
  assert.equal(results[0]?.stepPath, "t");
  assert.equal(results[0]?.action.kind, "unloadOre");
  assert.equal(results.at(-1)?.status, "done");
});

test("a branch runs the ELSE side when its condition does not hold", () => {
  const s = script([branchNode("br", { kind: "shield-below", fraction: 0.5 }, [macroStep("t", "undock")], [macroStep("e", "deliver-ore")])], []);
  const { results } = run(s, [obs({ shieldRatio: 0.9, holdEmpty: false })]); // shields fine -> ELSE: deliver acts
  assert.equal(results[0]?.stepPath, "e");
  assert.equal(results[0]?.action.kind, "unloadOre");
});

test("a branch cannot-tell waits rather than pick a side blind", () => {
  const s = script([branchNode("br", { kind: "shield-below", fraction: 0.5 }, [macroStep("t", "deliver-ore")], [macroStep("e", "undock")])], []);
  const r = decideScriptAction(s, obs({ shieldRatio: null }), initialMemory(s), registry, home);
  assert.equal(r.status, "running");
  assert.equal(r.action.kind, "wait");
  assert.equal(r.stepPath, "br"); // tied to the branch, no side chosen
});

test("an empty chosen side is skipped, not stuck", () => {
  const s = script([branchNode("br", { kind: "shield-below", fraction: 0.5 }, [], [macroStep("e", "undock")])], []);
  const r = decideScriptAction(s, obs({ shieldRatio: 0.2 }), initialMemory(s), registry, home);
  assert.equal(r.status, "done"); // THEN empty + met -> skip the branch -> nothing after -> done
});

test("a branch commits to its side on entry and never flips mid-side", () => {
  const s = script(
    [
      branchNode(
        "br",
        { kind: "shield-below", fraction: 0.5 },
        [macroStep("t1", "undock"), macroStep("t2", "deliver-ore")],
        [macroStep("e", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })],
      ),
    ],
    [],
  );
  const { results } = run(s, [
    obs({ shieldRatio: 0.2, inSpace: false, holdEmpty: false }), // enter THEN (shields low): t1 undock acts
    obs({ shieldRatio: 0.9, inSpace: true, holdEmpty: false }),  // shields now FINE, but committed: t1 done -> t2 deliver acts
    obs({ shieldRatio: 0.9, inSpace: true, holdEmpty: true }),   // t2 done -> branch done -> program done
  ]);
  assert.equal(results[0]?.stepPath, "t1");
  assert.equal(results[1]?.stepPath, "t2", "stayed in the THEN side after the condition flipped");
  assert.equal(results.at(-1)?.status, "done");
});

// ─── Branches INSIDE a loop ──────────────────────────────────────────────────

test("a branch inside a loop forks each pass, re-evaluated every lap", () => {
  // Loop x2: [ undock, if hold-empty -> mine else deliver ].
  const loop: ProgramNode = {
    id: "L",
    kind: "loop",
    repeat: { kind: "times", count: 2 },
    body: [
      macroStep("u", "undock"),
      branchNode("br", { kind: "hold-empty" }, [macroStep("t", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [macroStep("e", "deliver-ore")]),
    ],
  };
  const s = script([loop], []);
  const { results } = run(s, [
    // Pass 1: in space so undock is done -> branch: hold EMPTY -> THEN (mine).
    obs({ inSpace: true, holdEmpty: true, oreHoldFraction: 0.1 }),
    // mine's until met -> side done -> loop wraps to pass 2; undock done again ->
    // branch RE-EVALUATED: hold NOT empty now -> ELSE (deliver) acts.
    obs({ inSpace: true, holdEmpty: false, oreHoldFraction: 0.95 }),
    // deliver done (hold empty) -> side done -> loop count reached -> program done.
    obs({ inSpace: true, holdEmpty: true, oreHoldFraction: 0 }),
  ]);
  assert.equal(results[0]?.stepPath, "t", "pass 1 took the THEN side");
  assert.equal(results[1]?.stepPath, "e", "pass 2 re-evaluated and took the ELSE side");
  assert.equal(results.at(-1)?.status, "done");
});

test("a branch as the LAST loop element still wraps the pass correctly", () => {
  const loop: ProgramNode = {
    id: "L",
    kind: "loop",
    repeat: { kind: "forever" },
    body: [branchNode("br", { kind: "hold-empty" }, [macroStep("t", "deliver-ore")], [macroStep("e", "deliver-ore")])],
  };
  const s = script([loop], []);
  // hold NOT empty -> ELSE side -> deliver acts (a real world call each pass).
  const r = decideScriptAction(s, obs({ holdEmpty: false }), initialMemory(s), registry, home);
  assert.equal(r.status, "running");
  assert.equal(r.stepPath, "e");
  assert.equal(r.action.kind, "unloadOre");
});

test("a loop whose branch sides do nothing still trips the livelock guard", () => {
  // Both sides empty is refused by the codec; here the chosen side's step is a
  // no-op (undock while already in space), so a whole pass emits no world call.
  const loop: ProgramNode = {
    id: "L",
    kind: "loop",
    repeat: { kind: "forever" },
    body: [branchNode("br", { kind: "hold-empty" }, [macroStep("t", "undock")], [macroStep("e", "undock")])],
  };
  const s = script([loop], []);
  const r = decideScriptAction(s, obs({ inSpace: true, holdEmpty: true }), initialMemory(s), registry, home);
  assert.equal(r.action.kind, "warp", "heads home first");
  const stopped = decideScriptAction(s, obs({ inSpace: true, holdEmpty: true, docked: true }), r.memory, registry, home);
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /nothing it can do/i);
});

test("a loop-level until still ends the loop when the body starts with a branch", () => {
  const loop: ProgramNode = {
    id: "L",
    kind: "loop",
    repeat: { kind: "forever" },
    until: { kind: "hold-empty" },
    body: [branchNode("br", { kind: "shield-below", fraction: 0.5 }, [macroStep("t", "deliver-ore")], [macroStep("e", "deliver-ore")])],
  };
  const s = script([loop], []);
  // The loop's own until is met at the top of the pass -> the loop ends, and with
  // nothing after it the program is done (the branch never runs).
  const r = decideScriptAction(s, obs({ holdEmpty: true }), initialMemory(s), registry, home);
  assert.equal(r.status, "done");
});

// ─── Arming (the belt-empty guard) ───────────────────────────────────────────

test("an until does not advance the step while the macro is unarmed", () => {
  // mineUnarmed reports armed=false (as if still in warp); even with the ore
  // hold reading full, the step must not be treated as finished.
  const mineUnarmed: MacroDecider = () => tick({ kind: "activate", moduleID: 1, targetID: 2 }, { kind: "acting" }, false);
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }), macroStep("b", "deliver-ore")]);
  const r = decideScriptAction(s, obs({ oreHoldFraction: 0.99 }), initialMemory(s), { ...registry, "mine-at-belt": mineUnarmed }, home);
  assert.equal(r.stepPath, "m", "still on the mine step");
  assert.equal(r.action.kind, "activate");
});

// ─── Interrupts ──────────────────────────────────────────────────────────────

test("a plain-pause interrupt gets the ship to a station first, then stops with the condition as its reason", () => {
  const shields: InterruptRow = { id: "s", when: { kind: "shield-below", fraction: 0.3 }, respond: "pause" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, shields]);
  const r = decideScriptAction(s, obs({ shieldRatio: 0.2 }), initialMemory(s), registry, home);
  assert.equal(r.status, "running", "a watch the player set to STOP still does not stop in space");
  assert.equal(r.action.kind, "warp");
  assert.equal(r.interruptID, "s");
  const stopped = decideScriptAction(s, obs({ shieldRatio: 0.2, docked: true }), r.memory, registry, home);
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.interruptID, "s", "the row that stopped it is still named");
  assert.match(stopped.pauseReason ?? "", /shields/i);
});

test("a plain-pause interrupt fired while ALREADY docked stops on the spot", () => {
  // The flight home costs nothing when there is no flying to do: the travel
  // decider reports done on its first consultation and the pause lands the same tick.
  const wallet: InterruptRow = { id: "w", when: { kind: "wallet-below", isk: 100 }, respond: "pause" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [wallet]);
  const r = decideScriptAction(s, obs({ docked: true, inSpace: false, walletBalance: 10 }), initialMemory(s), registry, home);
  assert.equal(r.status, "paused");
  assert.equal(r.interruptID, "w");
});

test("a dock-and-pause interrupt flies home and then stops", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  // Health below the watch's threshold fires it (dock-and-pause).
  const start = initialMemory(s);
  const flying = decideScriptAction(s, obs({ health: 0.2, docked: false }), start, registry, home);
  assert.equal(flying.status, "running");
  assert.equal(flying.action.kind, "warp", "heading home");
  assert.equal(flying.interruptID, "floor");
  // Next tick, now docked at home: it stops.
  const stopped = decideScriptAction(s, obs({ health: 0.2, docked: true }), flying.memory, registry, home);
  assert.equal(stopped.status, "paused");
});

test("a launch-drones interrupt launches once, then yields to the step when drones are out", () => {
  const drones: InterruptRow = { id: "d", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, drones]);
  const launching = decideScriptAction(s, obs({ hostileOnGrid: true, dronesOut: false, combatDroneBayItemIDs: [1, 2], salvageDroneBayItemIDs: [3] }), initialMemory(s), registry, home);
  assert.equal(launching.action.kind, "launchDrones");
  assert.deepEqual(launching.action.kind === "launchDrones" ? launching.action.droneItemIDs : [], [1, 2], "the COMBAT drones only — the salvage drone stays in the bay");
  assert.equal(launching.interruptID, "d");
  // Drones now out: the interrupt is satisfied and the step keeps working.
  const working = decideScriptAction(s, obs({ hostileOnGrid: true, dronesOut: true, combatDroneIDs: [1, 2] }), launching.memory, registry, home);
  assert.equal(working.action.kind, "activate");
  assert.equal(working.stepPath, "m");
});

// ─── fight-back ──────────────────────────────────────────────────────────────
//
// The response borrows the Fight-the-rats decider out of the registry, so these
// stand in a fake one and check the three properties that matter: the ladder's
// actions reach the world, its memory survives tick to tick (so the primary is
// not re-picked every time), and it RELEASES the ship the moment it stops acting.

/** A fake ratting ladder: lock, then shoot, then report the grid clear. */
const ratLadder: MacroDecider = (_s, o, mem) => {
  if (o.hostileOnGrid !== true) {
    return tick({ kind: "wait" }, { kind: "done" });
  }
  if (mem["locked"] !== true) {
    return tick({ kind: "lock", targetID: 77 }, { kind: "acting" }, true, { locked: true });
  }
  return tick({ kind: "activate", moduleID: 5, targetID: 77 }, { kind: "acting" }, true, mem);
};
const fightRegistry = { ...registry, "fight-the-rats": ratLadder };

const fightBack: InterruptRow = { id: "fb", when: { kind: "hostile-on-grid" }, respond: "fight-back" };

test("a fight-back interrupt runs the ratting ladder and keeps its memory across ticks", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const locking = decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), fightRegistry, home);
  assert.equal(locking.action.kind, "lock");
  assert.equal(locking.interruptID, "fb");

  // The ladder remembered the lock, so the next tick SHOOTS rather than
  // re-locking — which is the whole point of keying its memory by the row id.
  const shooting = decideScriptAction(s, obs({ hostileOnGrid: true }), locking.memory, fightRegistry, home);
  assert.equal(shooting.action.kind, "activate");
  assert.equal(shooting.interruptID, "fb");
});

test("fight-back hands the ship back to the step once there is nothing left to fight", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const fighting = decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), fightRegistry, home);
  assert.equal(fighting.interruptID, "fb");

  // Grid clear: the watch no longer fires at all and mining resumes.
  const mining = decideScriptAction(s, obs({ hostileOnGrid: false }), fighting.memory, fightRegistry, home);
  assert.equal(mining.stepPath, "m");
  assert.equal(mining.action.kind, "activate");
});

test("fight-back releases the step even while the pirate is STILL there, when the ladder stops acting", () => {
  // The hostile is on grid (so the watch keeps firing) but the ladder reports
  // itself done — out of targeting range, or no way to fight. The step must not
  // be starved: an always-armed response that never released would own the ship.
  const stalled: MacroDecider = () => tick({ kind: "wait" }, { kind: "done" });
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const r = decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), { ...registry, "fight-the-rats": stalled }, home);
  assert.equal(r.stepPath, "m");
  assert.equal(r.action.kind, "activate");
});

// ─── fight-back: hardeners up, then the stand-down ───────────────────────────
//
// The watch owns two module decisions the ladder knows nothing about: the tank
// goes up BEFORE the shooting, and it comes back down — with the drones — once
// the pirate is gone. The second half cannot run inside `fireInterrupt` (a watch
// stops being consulted the moment its condition clears), so these drive it
// through whole ticks rather than the response alone.

/** A snapshot whose only interesting part is which modules are running. */
function running(...moduleIDs: number[]): ScriptObservation["snapshot"] {
  return {
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    sampledAtMs: 1,
    entities: [],
    ship: { itemID: 9001, activeModuleIDs: moduleIDs },
  } as unknown as ScriptObservation["snapshot"];
}

test("fight-back runs the hardeners up before it points anything at the pirate", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const pirate = { hostileOnGrid: true, hardenerModuleIDs: [40, 41], snapshot: running() };

  const first = decideScriptAction(s, obs(pirate), initialMemory(s), fightRegistry, home);
  assert.equal(first.action.kind, "activate", "the tank goes up first");
  assert.equal(first.action.kind === "activate" ? first.action.moduleID : 0, 40);
  assert.equal(first.action.kind === "activate" ? first.action.targetID : -1, 0, "self-targeted");
  assert.equal(first.interruptID, "fb");

  const second = decideScriptAction(s, obs({ ...pirate, snapshot: running(40) }), first.memory, fightRegistry, home);
  assert.equal(second.action.kind === "activate" ? second.action.moduleID : 0, 41, "the second hardener");

  // Everything hardened: NOW the ladder gets the ship.
  const fighting = decideScriptAction(s, obs({ ...pirate, snapshot: running(40, 41) }), second.memory, fightRegistry, home);
  assert.equal(fighting.action.kind, "lock");
});

test("fight-back leaves the player's own already-running hardener alone", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  // 40 is already on — a Hardeners-on block earlier in the program lit it.
  const r = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, hardenerModuleIDs: [40, 41], snapshot: running(40) }),
    initialMemory(s),
    fightRegistry,
    home,
  );
  assert.equal(r.action.kind === "activate" ? r.action.moduleID : 0, 41, "only the idle one");
});

test("a hardener that will not come on is tried once, not every tick", () => {
  // Otherwise the watch would re-issue the same activate forever and starve the
  // step underneath it — the same way an unreleased fight would.
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const stuck = { hostileOnGrid: true, hardenerModuleIDs: [40], snapshot: running() };
  const tried = decideScriptAction(s, obs(stuck), initialMemory(s), fightRegistry, home);
  assert.equal(tried.action.kind, "activate");
  // Still not running next tick: the watch gives up on it and fights anyway.
  const fighting = decideScriptAction(s, obs(stuck), tried.memory, fightRegistry, home);
  assert.equal(fighting.action.kind, "lock");
});

test("once the pirate is gone the watch calls the drones in and switches its own hardeners off", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const pirate = { hostileOnGrid: true, hardenerModuleIDs: [40], snapshot: running() };
  const hardening = decideScriptAction(s, obs(pirate), initialMemory(s), fightRegistry, home);
  assert.equal(hardening.action.kind, "activate");

  // Grid clear, drones still out, the watch's hardener still running.
  const clear = { hostileOnGrid: false, hardenerModuleIDs: [40], snapshot: running(40), combatDroneIDs: [1, 2], dronesOut: true };
  const recalling = decideScriptAction(s, obs(clear), hardening.memory, fightRegistry, home);
  assert.equal(recalling.action.kind, "recallDrones", "the drones come home first, tank still up");
  assert.deepEqual(recalling.action.kind === "recallDrones" ? recalling.action.droneIDs : [], [1, 2]);
  assert.equal(recalling.interruptID, "fb");

  // Then the hardener it lit goes back off.
  const cooling = decideScriptAction(s, obs(clear), recalling.memory, fightRegistry, home);
  assert.equal(cooling.action.kind, "deactivate");
  assert.equal(cooling.action.kind === "deactivate" ? cooling.action.moduleID : 0, 40);

  // Stood down: the step has the ship back, and it stays that way.
  const stoodDown = { hostileOnGrid: false, hardenerModuleIDs: [40], snapshot: running(), dronesOut: false };
  const mining = decideScriptAction(s, obs(stoodDown), cooling.memory, fightRegistry, home);
  assert.equal(mining.stepPath, "m");
  assert.equal(mining.action.kind, "activate");
  const stillMining = decideScriptAction(s, obs(stoodDown), mining.memory, fightRegistry, home);
  assert.equal(stillMining.stepPath, "m", "the stand-down is over, not repeating");
});

test("the stand-down never switches off a hardener the watch did not switch on", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  // 40 was already running when the pirate arrived, so the watch only claims 41.
  const pirate = { hostileOnGrid: true, hardenerModuleIDs: [40, 41], snapshot: running(40) };
  const hardening = decideScriptAction(s, obs(pirate), initialMemory(s), fightRegistry, home);
  assert.equal(hardening.action.kind === "activate" ? hardening.action.moduleID : 0, 41);

  const clear = { hostileOnGrid: false, hardenerModuleIDs: [40, 41], snapshot: running(40, 41) };
  const cooling = decideScriptAction(s, obs(clear), hardening.memory, fightRegistry, home);
  assert.equal(cooling.action.kind === "deactivate" ? cooling.action.moduleID : 0, 41, "its own, not the player's");
  // Nothing of the watch's left running: 40 stays on and mining resumes.
  const mining = decideScriptAction(s, obs(clear), cooling.memory, fightRegistry, home);
  assert.equal(mining.stepPath, "m");
});

test("a hull with no hardeners fitted still gets its drones back when the grid clears", () => {
  // The stand-down record is written by the FIGHT as well as by the hardeners,
  // so a droneboat with nothing to harden is not left with its drones in space.
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const fighting = decideScriptAction(s, obs({ hostileOnGrid: true, hardenerModuleIDs: [] }), initialMemory(s), fightRegistry, home);
  assert.equal(fighting.action.kind, "lock");
  const recalling = decideScriptAction(s, obs({ hostileOnGrid: false, combatDroneIDs: [7], dronesOut: true }), fighting.memory, fightRegistry, home);
  assert.equal(recalling.action.kind, "recallDrones");
  assert.deepEqual(recalling.action.kind === "recallDrones" ? recalling.action.droneIDs : [], [7]);
  // Nothing else to undo, so the step has the ship straight back.
  const mining = decideScriptAction(s, obs({ hostileOnGrid: false, combatDroneIDs: [] }), recalling.memory, fightRegistry, home);
  assert.equal(mining.stepPath, "m");
});

test("a fight-back watch that never got to act leaves the drones where it found them", () => {
  // The ladder reported itself done on the first tick (out of range, or no way to
  // fight), so the watch committed nothing — and must not call in drones some
  // other block of the program deliberately put out.
  const stalled: MacroDecider = () => tick({ kind: "wait" }, { kind: "done" });
  const idleRegistry = { ...registry, "fight-the-rats": stalled };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const released = decideScriptAction(s, obs({ hostileOnGrid: true, hardenerModuleIDs: [] }), initialMemory(s), idleRegistry, home);
  assert.equal(released.stepPath, "m");
  const mining = decideScriptAction(s, obs({ hostileOnGrid: false, combatDroneIDs: [7], dronesOut: true }), released.memory, idleRegistry, home);
  assert.equal(mining.stepPath, "m", "no record, so no recall");
  assert.equal(mining.action.kind, "activate");
});

test("a fight-back watch with no ratting macro in the registry leaves the program running", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const r = decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), registry, home);
  assert.equal(r.stepPath, "m");
  assert.equal(r.status, "running");
});

// ─── fight-back: a pirate out of reach does not seize the ship ───────────────
//
// Caught live 2026-09-30: `hostile-on-grid` counts the whole grid, the ladder
// only what is inside targeting range. A rat parked beyond it made the ladder
// spend its three empty-grid confirm reads, release for one tick, and be
// borrowed again — the step under the watch ran one tick in four.

/** A grid holding NPC hostiles at the given distances (metres, along x). */
function pirateGrid(...metres: number[]): ScriptObservation["snapshot"] {
  return {
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    sampledAtMs: 1,
    entities: metres.map((x, i) => ({
      itemID: 6661 + i, kind: "ship", isNpc: true, npcEntityType: "npc", isSelf: false,
      position: { x, y: 0, z: 0 },
    })),
    ship: { itemID: 9001, position: { x: 0, y: 0, z: 0 }, activeModuleIDs: [] },
  } as unknown as ScriptObservation["snapshot"];
}

/** A stand-in for the real ladder's empty-grid rung: three confirm reads, then done. */
function confirmingLadder(calls: { n: number }): MacroDecider {
  return (_s, _o, mem) => {
    calls.n += 1;
    const reads = (typeof mem["emptyGridReads"] === "number" ? mem["emptyGridReads"] : 0) + 1;
    return reads < 3
      ? tick({ kind: "wait" }, { kind: "acting" }, false, { emptyGridReads: reads })
      : tick({ kind: "wait" }, { kind: "done" });
  };
}

test("fight-back: a pirate beyond targeting range leaves the step every tick", () => {
  const calls = { n: 0 };
  const reg = { ...registry, "fight-the-rats": confirmingLadder(calls) };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const far = obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000), maxTargetRangeM: 30_000 });
  const { results } = run(s, [far, far, far, far, far, far, far, far], reg);
  assert.equal(results.length, 8);
  for (const r of results) {
    assert.equal(r.stepPath, "m", "the step, not the watch");
    assert.equal(r.action.kind, "activate");
    assert.equal(r.interruptID, null);
  }
  assert.equal(calls.n, 0, "the ladder is never borrowed for a rat it would gate out");
});

test("fight-back: the watch still takes the ship the moment the pirate closes into range", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const far = decideScriptAction(
    s, obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000), maxTargetRangeM: 30_000 }), initialMemory(s), fightRegistry, home,
  );
  assert.equal(far.stepPath, "m");
  const near = decideScriptAction(
    s, obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000, 20_000), maxTargetRangeM: 30_000 }), far.memory, fightRegistry, home,
  );
  assert.equal(near.interruptID, "fb");
  assert.equal(near.action.kind, "lock");
});

test("fight-back: the tank still goes up against a pirate out of reach", () => {
  // It may be shooting from beyond our lock range; the hardeners cost one tick each.
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const r = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000), maxTargetRangeM: 30_000, hardenerModuleIDs: [40] }),
    initialMemory(s),
    fightRegistry,
    home,
  );
  assert.equal(r.interruptID, "fb");
  assert.equal(r.action.kind === "activate" ? r.action.moduleID : 0, 40);
});

test("fight-back: a fight already under way still winds down through the ladder", () => {
  // The last rat in reach just died and a far one remains: the ladder's memory is
  // present, so it keeps the ship long enough to confirm, stand down and recall.
  const calls = { n: 0 };
  const reg = { ...registry, "fight-the-rats": confirmingLadder(calls) };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  const mid: ScriptMemory = { ...initialMemory(s), macroMem: { fb: { targetID: 6660 } } };
  const far = obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000), maxTargetRangeM: 30_000 });
  const first = decideScriptAction(s, far, mid, reg, home);
  assert.equal(first.interruptID, "fb", "the fight in progress is the ladder's to finish");
  assert.equal(calls.n, 1);
  const second = decideScriptAction(s, far, first.memory, reg, home);
  assert.equal(second.interruptID, "fb");
  // Third read: the ladder reports done and releases, dropping its memory...
  const third = decideScriptAction(s, far, second.memory, reg, home);
  assert.equal(third.stepPath, "m");
  assert.equal("fb" in third.memory.macroMem, false);
  // ...and from then on the far rat no longer borrows it at all.
  const fourth = decideScriptAction(s, far, third.memory, reg, home);
  assert.equal(fourth.stepPath, "m");
  assert.equal(calls.n, 3);
});

test("fight-back: an unreadable targeting range, or a grid with no hostile rows, is still the ladder's call", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  // No range: no gate at all, so the far rat is a target (the bounded lock is the backstop).
  const noRange = decideScriptAction(
    s, obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000) }), initialMemory(s), fightRegistry, home,
  );
  assert.equal(noRange.interruptID, "fb");
  // No hostile rows on the snapshot: an empty grid gets the ladder's confirm reads,
  // never this shortcut.
  const calls = { n: 0 };
  const empty = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, snapshot: pirateGrid(), maxTargetRangeM: 30_000 }),
    initialMemory(s),
    { ...registry, "fight-the-rats": confirmingLadder(calls) },
    home,
  );
  assert.equal(calls.n, 1);
  assert.equal(empty.interruptID, "fb");
});

test("fight-back: standing aside for an unreachable pirate lets a lower watch fire", () => {
  const flee: InterruptRow = { id: "flee", when: { kind: "armor-below", fraction: 0.5 }, respond: "dock-and-pause" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [fightBack, flee]);
  const r = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, snapshot: pirateGrid(90_000), maxTargetRangeM: 30_000, armorRatio: 0.2 }),
    initialMemory(s),
    fightRegistry,
    home,
  );
  assert.equal(r.interruptID, "flee");
  assert.equal(r.action.kind, "warp");
});

test("a launch-drones interrupt with no combat drones to launch yields to the step rather than spinning", () => {
  const drones: InterruptRow = { id: "d", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, drones]);
  // A bay of salvage drones defends nothing.
  const salvageOnly = decideScriptAction(s, obs({ hostileOnGrid: true, dronesOut: false, combatDroneBayItemIDs: [], salvageDroneBayItemIDs: [3] }), initialMemory(s), registry, home);
  assert.equal(salvageOnly.action.kind, "activate");
  assert.equal(salvageOnly.stepPath, "m");
  // Other drones hold the slots: a launch would be refused every tick, so the step keeps working.
  const slotsTaken = decideScriptAction(s, obs({ hostileOnGrid: true, dronesOut: true, combatDroneBayItemIDs: [1], combatDroneIDs: [] }), initialMemory(s), registry, home);
  assert.equal(slotsTaken.action.kind, "activate");
});

// ─── Bounds: cannot-tell streak and the step-tick cap ────────────────────────

test("an unreadable until heads home after the cannot-tell streak runs out", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  let mem = initialMemory(s);
  let last = decideScriptAction(s, obs({ oreHoldFraction: null }), mem, registry, home);
  for (let i = 0; i < MAX_CANNOT_TELL_STREAK + 2 && last.action.kind !== "warp"; i += 1) {
    mem = last.memory;
    last = decideScriptAction(s, obs({ oreHoldFraction: null }), mem, registry, home);
  }
  assert.equal(last.action.kind, "warp", "it gives up by flying home, not by parking in space");
  const stopped = decideScriptAction(s, obs({ oreHoldFraction: null, docked: true }), last.memory, registry, home);
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /could not read/i);
});

// A macro that WAITS for ever: acting, armed, and never a world call. This is
// the only shape the silence cap is meant to catch.
const silent: MacroDecider = () => tick({ kind: "wait" }, { kind: "acting" }, true);

/** Drive one step until it leaves "running" or the budget is provably clear. */
function driveStep(reg: Record<string, MacroDecider>, over: Partial<ScriptObservation>, ticks: number) {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  let mem = initialMemory(s);
  let last = decideScriptAction(s, obs(over), mem, reg, home);
  for (let i = 0; i < ticks && last.action.kind !== "warp"; i += 1) {
    mem = last.memory;
    last = decideScriptAction(s, obs(over), mem, reg, home);
  }
  return { s, last };
}

test("a step that emits nothing at all trips the silence cap", () => {
  const { s, last } = driveStep(
    { ...registry, "mine-at-belt": silent },
    { oreHoldFraction: 0 },
    MAX_SILENT_STEP_TICKS + 5,
  );
  assert.equal(last.action.kind, "warp", "the cap sends it home rather than leaving it there");
  const stopped = decideScriptAction(
    s, obs({ oreHoldFraction: 0, docked: true }), last.memory, { ...registry, "mine-at-belt": silent }, home,
  );
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /did nothing/i);
});

test("a new invocation at the same loop path gets a fresh silence budget", () => {
  const s = script([{ id: "L", kind: "loop", repeat: { kind: "forever" }, body: [macroStep("m", "mine-at-belt")] }]);
  const old = { ...initialMemory(s), stepTicks: MAX_SILENT_STEP_TICKS };
  let invocations = 0;
  const reg = { ...registry, "mine-at-belt": () => invocations++ === 0
    ? tick({ kind: "wait" }, { kind: "done" })
    : tick({ kind: "wait" }, { kind: "acting" }) };
  const next = decideScriptAction(s, obs(), old, reg, home);
  assert.equal(next.status, "running");
  assert.equal(next.stepPath, "m", "the new invocation has the identical path");
  assert.equal(next.memory.stepTicks, 1);
});

test("a step that keeps acting is never stopped for taking a long time", () => {
  // THE REGRESSION. `mine` acts every tick and its `until` is never met — a
  // miner filling a big hold from two ores, which is exactly what the elapsed-
  // tick cap used to stop at 90 minutes. Far past the budget, it is still mining.
  const { last } = driveStep(registry, { oreHoldFraction: 0 }, MAX_SILENT_STEP_TICKS * 3);
  assert.equal(last.status, "running", "a slow job is not a stuck one");
  assert.equal(last.action.kind, "activate", "and it is still working, not parked");
  assert.equal(last.memory.stepTicks, 0, "a world call leaves no silence behind it");
});

test("a step that acts only now and then keeps its budget from running out", () => {
  // The real shape of a working macro: long silences broken by a world call.
  // Each call has to clear the count, or the silences add up and stop the bot.
  const reg = { ...registry, "mine-at-belt": silent };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  const acting = { ...registry };
  let mem = initialMemory(s);
  for (let i = 0; i < MAX_SILENT_STEP_TICKS * 3; i += 1) {
    // One world call every 100 ticks, silence in between.
    const r = decideScriptAction(s, obs({ oreHoldFraction: 0 }), mem, i % 100 === 0 ? acting : reg, home);
    assert.equal(r.status, "running", `stopped at tick ${i}: ${r.pauseReason ?? ""}`);
    assert.notEqual(r.action.kind, "warp", `headed home at tick ${i}`);
    mem = r.memory;
  }
});

// ─── A blocked macro ─────────────────────────────────────────────────────────

const stuck: MacroDecider = () => tick({ kind: "wait" }, { kind: "blocked", reason: "There are no rocks left here." });
const stuckRegistry = { ...registry, "mine-at-belt": stuck };

test("a blocked macro heads home, then pauses with the macro's own reason", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  const r = decideScriptAction(s, obs(), initialMemory(s), stuckRegistry, home);
  assert.equal(r.status, "running", "a blocked belt is not a place to sit");
  assert.equal(r.action.kind, "warp");
  const stopped = decideScriptAction(s, obs({ docked: true }), r.memory, stuckRegistry, home);
  assert.equal(stopped.status, "paused");
  assert.match(stopped.pauseReason ?? "", /no rocks left/i);
});

test("a fault stops in space after all when there is no home to fly to", () => {
  // The one honest exception, and the bound that stops the latch being forever:
  // if the way home is BLOCKED (no home station known), the runner stops where
  // it is and says why, rather than flying at a guess or latching in a loop.
  const noHome: HomeTravelDecider = () =>
    tick({ kind: "wait" }, { kind: "blocked", reason: "This bot does not know which station is home." });
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  const r = decideScriptAction(s, obs(), initialMemory(s), stuckRegistry, noHome);
  assert.equal(r.status, "paused");
  assert.match(r.pauseReason ?? "", /does not know which station is home/i);
});

test("a fault keeps flying home across ticks instead of re-deciding the fault every tick", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  let r = decideScriptAction(s, obs(), initialMemory(s), stuckRegistry, home);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(r.action.kind, "warp");
    assert.equal(r.status, "running");
    r = decideScriptAction(s, obs(), r.memory, stuckRegistry, home);
  }
  assert.equal(decideScriptAction(s, obs({ docked: true }), r.memory, stuckRegistry, home).status, "paused");
});

// ─── The "alert me" response ─────────────────────────────────────────────────
//
// Three properties, and each one is a bug if it breaks: it speaks, it speaks
// ONCE per episode, and while spent it lets the rest of the ladder work.

const alertShields: InterruptRow = {
  id: "tellme", when: { kind: "shield-below", fraction: 0.6 }, respond: "alert",
};

test("alert: fires once, keeps the program running, and does not repeat while it holds", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [alertShields, floor]);
  const hurt = obs({ shieldRatio: 0.4 });
  const { results, mem } = run(s, [hurt, hurt, hurt]);

  assert.equal(results[0]?.action.kind, "alert", "the first tick alerts");
  assert.ok(results[0]?.action.kind === "alert" && /shields drop below 60%/.test(results[0].action.message));
  assert.equal(results[0]?.interruptID, "tellme");
  assert.equal(results[0]?.status, "running", "an alert never stops the bot");
  // Ticks 2 and 3: the row is spent, so the program is what runs.
  assert.equal(results[1]?.action.kind, "activate", "the bot goes back to work");
  assert.equal(results[2]?.action.kind, "activate");
  assert.deepEqual(mem.spentAlerts, ["tellme"]);
});

test("an escape outranks an alert even before the alert is spent", () => {
  // The pattern the design exists for: tell me, AND dock. Same threshold, alert
  // above. Tick 1 alerts; tick 2 must reach the dock-and-pause row below it.
  const dockRow: InterruptRow = { id: "dock", when: { kind: "shield-below", fraction: 0.6 }, respond: "dock-and-pause" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [alertShields, dockRow, floor]);
  const hurt = obs({ shieldRatio: 0.4 });
  const { results } = run(s, [hurt, hurt, obs({ shieldRatio: 0.4, docked: true })]);

  assert.equal(results[0]?.action.kind, "warp");
  assert.equal(results[1]?.interruptID, "dock", "the dock watch under the spent alert must fire");
  assert.equal(results[1]?.action.kind, "warp", "and it flies home");
  assert.equal(results[2]?.status, "paused", "then stops, docked");
});

test("alert: re-arms once the condition clears, so a second episode speaks again", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [alertShields, floor]);
  let mem = initialMemory(s);
  const step = (o: ScriptObservation): ReturnType<typeof decideScriptAction> => {
    const r = decideScriptAction(s, o, mem, registry, home);
    mem = r.memory;
    return r;
  };
  assert.equal(step(obs({ shieldRatio: 0.4 })).action.kind, "alert", "episode one");
  assert.equal(step(obs({ shieldRatio: 0.4 })).action.kind, "activate", "spent");
  assert.equal(step(obs({ shieldRatio: 1 })).action.kind, "activate", "recovered — released");
  assert.deepEqual(mem.spentAlerts, [], "the row is armed again");
  assert.equal(step(obs({ shieldRatio: 0.4 })).action.kind, "alert", "episode two speaks");
});

test("alert: an UNREADABLE check does not re-arm the row (no crying wolf on a blind read)", () => {
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [alertShields, floor]);
  let mem = initialMemory(s);
  const step = (o: ScriptObservation): ReturnType<typeof decideScriptAction> => {
    const r = decideScriptAction(s, o, mem, registry, home);
    mem = r.memory;
    return r;
  };
  assert.equal(step(obs({ shieldRatio: 0.4 })).action.kind, "alert");
  step(obs({ shieldRatio: null, health: 1 })); // cannot tell — not evidence it passed
  assert.deepEqual(mem.spentAlerts, ["tellme"], "still spent");
  assert.equal(step(obs({ shieldRatio: 0.4 })).action.kind, "activate", "so it does not alert again");
});

test("a dock-and-pause row outranks an unspent alert above it", () => {
  // A spent alert must never silence a real response sitting under it. Alert on
  // health above the plain health-below dock-and-pause watch.
  const alertHealth: InterruptRow = { id: "tellhealth", when: { kind: "health-below", fraction: 0.5 }, respond: "alert" };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [alertHealth, floor]);
  const dying = obs({ health: 0.2 });
  const { results } = run(s, [dying, dying, obs({ health: 0.2, docked: true })]);
  assert.equal(results[0]?.action.kind, "warp");
  assert.equal(results[1]?.interruptID, "floor", "the dock-and-pause row is reached");
  assert.equal(results[2]?.status, "paused");
});

// ─── A row that DOES NOTHING is transparent ──────────────────────────────────
//
// The spent-alert rule just above, generalised to every response that can fire
// and then have no work. Interrupts are first-match-wins, so such a row used to
// win the scan every tick and answer by running the program — which silenced
// every row UNDER it for as long as its condition held. Each test below is one
// response that can do nothing, with a flee row beneath it that MUST be reached;
// "activate" (the mine step) is the bug, "warp" is the fix.

/** The row that has to survive an inert watch sitting on top of it. */
const fleeArmor: InterruptRow = {
  id: "flee", when: { kind: "armor-below", fraction: 0.45 }, respond: "dock-and-pause",
};

/** The mining step every test here runs under, so "kept working" is visible. */
function underWatches(interrupts: readonly InterruptRow[]): BotScript {
  return script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], interrupts);
}

test("repair: a layer with no repairer fitted does not silence the flee row under it", () => {
  // The shape that costs a ship. An armour-tanked hull with a shield watch on
  // top: `shield-below -> repair` reaches for shield boosters this fit does not
  // have, and shields under 10% is exactly when the armour row was meant to run.
  const rep: InterruptRow = { id: "rep", when: { kind: "shield-below", fraction: 0.1 }, respond: "repair" };
  const s = underWatches([rep, fleeArmor]);
  const r = decideScriptAction(s, obs({ shieldRatio: 0.05, armorRatio: 0.2 }), initialMemory(s), registry, home);
  assert.equal(r.interruptID, "flee", "the armour row under the inert repair row fires");
  assert.equal(r.action.kind, "warp", "and it flies home");
});

test("repair: repairers that are ALL already running do not silence it either", () => {
  // A thermostat doing everything it can is still a thermostat doing nothing
  // this tick — and the ship is losing armour anyway, which is what the row
  // below is for.
  const rep: InterruptRow = { id: "rep", when: { kind: "armor-below", fraction: 0.9 }, respond: "repair" };
  const s = underWatches([rep, fleeArmor]);
  const hurt = { armorRatio: 0.2, armorRepairerIDs: [12], capacitorRatio: 0.9 };

  const saturated = decideScriptAction(s, obs({ ...hurt, snapshot: running(12) }), initialMemory(s), registry, home);
  assert.equal(saturated.interruptID, "flee");
  assert.equal(saturated.action.kind, "warp");

  // ⚠ AND THE OTHER WAY. Transparency must not turn into "the repair row never
  // wins": with the repairer idle it is the one with work, and it keeps the tick.
  const idle = decideScriptAction(s, obs({ ...hurt, snapshot: running() }), initialMemory(s), registry, home);
  assert.equal(idle.interruptID, "flee");
  assert.equal(idle.action.kind, "warp");
});

test("launch-drones: a watch whose drones are already out stands aside", () => {
  const launch: InterruptRow = { id: "dro", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const s = underWatches([launch, fleeArmor]);
  const r = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, dronesOut: true, combatDroneIDs: [1, 2], armorRatio: 0.2 }),
    initialMemory(s),
    registry,
    home,
  );
  assert.equal(r.interruptID, "flee", "drones already out is no answer to an armour reading");
  assert.equal(r.action.kind, "warp");
});

test("fight-back: a watch with nothing left to fight stands aside", () => {
  // The release rung: the pirate is on the grid (so the row still fires) but
  // nothing is inside targeting range, so the ladder reports it is not acting.
  const clearLadder: MacroDecider = () => tick({ kind: "wait" }, { kind: "done" });
  const s = underWatches([fightBack, fleeArmor]);
  const r = decideScriptAction(
    s,
    obs({ hostileOnGrid: true, armorRatio: 0.2 }),
    initialMemory(s),
    { ...registry, "fight-the-rats": clearLadder },
    home,
  );
  assert.equal(r.interruptID, "flee");
  assert.equal(r.action.kind, "warp");
});

test("standing aside ends at the program when no row below fires — it cannot loop", () => {
  // The bottom of the fall-through: one inert row and nothing under it is the
  // behaviour that always shipped, and the recursion has to come to rest there.
  const rep: InterruptRow = { id: "rep", when: { kind: "shield-below", fraction: 0.1 }, respond: "repair" };
  const s = underWatches([rep]);
  const r = decideScriptAction(s, obs({ shieldRatio: 0.05 }), initialMemory(s), registry, home);
  assert.equal(r.action.kind, "activate", "the step keeps working");
  assert.equal(r.stepPath, "m");
  assert.equal(r.interruptID, null);
  assert.equal(r.status, "running");
});

// ── The observe hint's fleet half ────────────────────────────────────────────
//
// A board read per tick is only paid for by a block that asked to FOLLOW one, so
// this is the gate that keeps a mining bot from calling the squad board every
// two seconds.

test("activeSquadRole reads the active step's role, and is 'off' for everything else", () => {
  const following: MacroStep = {
    ...macroStep("s1", "fight-the-rats"),
    args: { squad: { kind: "squadRole", role: "follow" } },
  };
  const plain = macroStep("s2", "mine-at-belt");

  const withFollow = script([following]);
  assert.equal(activeSquadRole(withFollow, initialMemory(withFollow)), "follow");

  const withoutRole = script([plain]);
  assert.equal(activeSquadRole(withoutRole, initialMemory(withoutRole)), "off", "a block with no squad arg pays nothing");

  // A latched run (flying home to stop) consults no block at all.
  const latched: ScriptMemory = { ...initialMemory(withFollow), latched: { interruptID: null, reason: "stopping" } };
  assert.equal(activeSquadRole(withFollow, latched), "off");
});

// ── The watch fights like a block ────────────────────────────────────────────
//
// ⚠ THIS IS THE HANDLER THAT ACTUALLY FIGHTS. A combat BLOCK only looks at the
// grid while it is the active step, and a working bot is mining or hauling when
// the rats arrive — caught live: two fleeted miners sat through a spawn inside a
// wait block until their shield watch pulled them home. So the watch carries the
// same two combat settings a block does, and they have to reach the ladder.

test("a fight-back watch hands its own combat settings to the borrowed ladder", () => {
  const seenSteps: MacroStep[] = [];
  const recording: MacroDecider = (step, _o, mem) => {
    seenSteps.push(step);
    return tick({ kind: "lock", targetID: 77 }, { kind: "acting" }, true, mem);
  };
  const row: InterruptRow = {
    id: "fb",
    when: { kind: "hostile-on-grid" },
    respond: "fight-back",
    squad: "call",
    targets: ["tackle", "ewar"],
  };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, row]);
  decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), { ...registry, "fight-the-rats": recording }, home);

  const seen = seenSteps[0];
  assert.ok(seen !== undefined);
  assert.deepEqual(seen.args["squad"], { kind: "squadRole", role: "call" });
  assert.deepEqual(seen.args["targets"], { kind: "targetList", classes: ["tackle", "ewar"] });
});

test("a watch that says nothing about fighting passes no settings — the shipped ladder", () => {
  const seenSteps: MacroStep[] = [];
  const recording: MacroDecider = (step, _o, mem) => {
    seenSteps.push(step);
    return tick({ kind: "lock", targetID: 77 }, { kind: "acting" }, true, mem);
  };
  const s = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [floor, fightBack]);
  decideScriptAction(s, obs({ hostileOnGrid: true }), initialMemory(s), { ...registry, "fight-the-rats": recording }, home);
  assert.deepEqual(seenSteps[0]?.args, {});
});

test("watchSquadRole reads the document's watches, and following wins", () => {
  const step = macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 });
  const calling: InterruptRow = { ...fightBack, id: "c", squad: "call" };
  const following: InterruptRow = { ...fightBack, id: "f", squad: "follow" };

  assert.equal(watchSquadRole(script([step], [floor, fightBack])), "off", "a plain fight-back pays for no board read");
  assert.equal(watchSquadRole(script([step], [floor, calling])), "call");
  assert.equal(watchSquadRole(script([step], [floor, calling, following])), "follow", "only following needs the read");
  // A setting on a watch that does not fight is not a fleet role.
  const paused: InterruptRow = { id: "p", when: { kind: "hostile-on-grid" }, respond: "dock-and-pause", squad: "follow" };
  assert.equal(watchSquadRole(script([step], [floor, paused])), "off");
});

// ─── dock-and-repair ─────────────────────────────────────────────────────────
//
// The one response that flies the ship home WITHOUT ending the run. Like
// fight-back it borrows a block out of the registry (Repair-ship), so these
// stand in a fake shop and check the four properties that matter: the trip
// happens in order (home, shop, back out), the run never pauses on a good trip,
// a shop that refuses does not strand the bot, and a trip that never helps is
// capped instead of commuting forever.

/** A fake repair shop: quote, pay, then report nothing left — the real ladder's shape. */
const shop: MacroDecider = (_s, o) => {
  const damaged = o.damagedItemIDs ?? null;
  if (damaged === null) {
    return tick({ kind: "wait" }, { kind: "acting" });
  }
  return damaged.length === 0
    ? tick({ kind: "wait" }, { kind: "done" })
    : tick({ kind: "repairItems", itemIDs: damaged }, { kind: "acting" });
};

const shieldTrip: InterruptRow = {
  id: "trip",
  when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-repair",
};

/** The trip's registry: the program's blocks plus the shop it borrows. */
const withShop = { ...registry, "repair-ship": shop };

function tripScript(): BotScript {
  return script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })], [shieldTrip]);
}

test("dock-and-repair flies home, pays the shop, undocks, and carries on where it left off", () => {
  const s = tripScript();
  const { results } = run(s, [
    // Shields gone in space: the watch fires and the ship heads home.
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, damagedItemIDs: [7] }),
    // Docked: the borrowed shop is paid.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7] }),
    // Nothing left to fix: back out.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [] }),
    // In space with the shields the dock gave back: the STEP runs again.
    obs({ shieldRatio: 1, inSpace: true, docked: false }),
  ], withShop);
  assert.equal(results[0]?.action.kind, "warp", "heading home");
  assert.equal(results[0]?.interruptID, "trip");
  assert.equal(results[1]?.action.kind, "repairItems", "the shop is paid at the station");
  assert.equal(results[2]?.action.kind, "undock", "patched up, so back out");
  assert.equal(results[3]?.action.kind, "activate", "the mining step picks up where it left off");
  assert.equal(results[3]?.stepPath, "m");
  assert.deepEqual(results.map((r) => r.status), ["running", "running", "running", "running"],
    "a repair trip never pauses the run — that is the whole difference from dock-and-pause");
});

test("the trip asks for the repair quote — the observer gates it on the active block", () => {
  const s = tripScript();
  const flying = decideScriptAction(s, obs({ shieldRatio: 0.2, docked: false }), initialMemory(s), withShop, home);
  assert.equal(activeMacroID(s, flying.memory), "repair-ship",
    "a latched trip still names the block it is about to run, or nobody fetches the quote");
});

test("a shop that will not fix it does not strand the bot at the station", () => {
  const broke: MacroDecider = () => tick({ kind: "wait" }, { kind: "blocked", reason: "no money" });
  const s = tripScript();
  const r = decideScriptAction(
    s,
    obs({ shieldRatio: 0.2, inSpace: false, docked: true }),
    initialMemory(s),
    { ...registry, "repair-ship": broke },
    home,
  );
  // It fired while DOCKED, so there is nothing to undock for: it just carries on.
  assert.equal(r.status, "running");
  assert.equal(r.action.kind, "activate", "the step runs — a refused quote is not a reason to stop");
});

test("a trip that fired in station leaves the ship docked", () => {
  const s = tripScript();
  const r = decideScriptAction(
    s,
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [] }),
    initialMemory(s),
    withShop,
    home,
  );
  assert.notEqual(r.action.kind, "undock", "undocking a bot that was working in the hangar would break it");
});

test("a repair trip that never helps is capped, and then stops from the station", () => {
  const s = tripScript();
  // Docked with the shields still reading low every tick: the trip completes,
  // the reading does not improve, and the row goes round again.
  const hurt = obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [] });
  const { results } = run(s, [hurt, hurt, hurt, hurt], withShop);
  assert.deepEqual(results.slice(0, MAX_RECOVER_TRIPS).map((r) => r.status),
    Array(MAX_RECOVER_TRIPS).fill("running"), "it is allowed its trips");
  assert.equal(results[MAX_RECOVER_TRIPS]?.status, "paused", "the fourth trip is a pattern, not a bad pull");
  assert.match(String(results[MAX_RECOVER_TRIPS]?.pauseReason), /went home to repair/);
  assert.equal(results[MAX_RECOVER_TRIPS]?.interruptID, "trip");
});

test("a trip that DOES help puts the whole cap back", () => {
  const s = tripScript();
  const hurt = obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [] });
  const well = obs({ shieldRatio: 1, inSpace: false, docked: true });
  // Two trips, a tick where the shields read fine, then three more trips: the
  // recovery cleared the tally, so the cap is nowhere near.
  const { results } = run(s, [hurt, hurt, well, hurt, hurt, hurt], withShop);
  assert.deepEqual(results.map((r) => r.status), Array(6).fill("running"));
});

// ─── dock-and-repair: a system mismatch rewinds the loop ────────────────────
//
// The incident: a nullsec mining bot's shields dipped mid mine-at-belt.
// dock-and-repair flew it home, patched it up at the (highsec) home system,
// and sent it back out — where the program resumed mine-at-belt exactly where
// it left off, its "nearest belt" binding still pointing at the nullsec grid
// it no longer stood on. It mined nothing, marked the home system's belts
// dry, and the run died. These prove the fix: a trip that lands somewhere
// DIFFERENT from where it fired restarts the loop the interrupted step sits
// in, from its first element, instead of resuming that step directly.

/** A loop of two steps — mine until the hold is 90% full, then deliver — so a
 * rewind (back to "m") is visibly different from a resume (staying at "h"). */
function loopTripScript(): BotScript {
  const loop: ProgramNode = {
    id: "L", kind: "loop", repeat: { kind: "forever" },
    body: [
      macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }),
      macroStep("h", "deliver-ore"),
    ],
  };
  return script([loop], [shieldTrip]);
}

/** Like `deliver`, but tags its memory while acting — so a test can tell
 * whether the abandoned step's memory survived a recovery or was cleared. */
const stickyDeliver: MacroDecider = (_s, o) =>
  o.holdEmpty
    ? tick({ kind: "wait" }, { kind: "done" })
    : tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }, true, { pinnedBelt: "stale-binding" });

const withShopAndMem = { ...withShop, "deliver-ore": stickyDeliver };

test("recovery in the SAME system resumes the interrupted step", () => {
  const s = loopTripScript();
  const { results } = run(s, [
    obs({ oreHoldFraction: 0.4, holdEmpty: false }),  // mine acts (m)
    obs({ oreHoldFraction: 0.95, holdEmpty: false }), // mine done -> deliver acts (h)
    // Shields gone in space, in "Alpha": the watch fires and the ship heads home.
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, holdEmpty: false, damagedItemIDs: [7], systemName: "Alpha" }),
    // Docked, still "Alpha" (home happens to be in the same system): shop paid.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Alpha" }),
    // Nothing left to fix, still "Alpha": back out — same system, no rewind.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Alpha" }),
    // In space, still "Alpha": the DELIVER step runs again — not mine.
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, systemName: "Alpha" }),
  ], withShopAndMem);
  assert.equal(results[4]?.action.kind, "undock", "patched up, so back out");
  assert.deepEqual(results[4]?.memory.macroMem["h"], { pinnedBelt: "stale-binding" },
    "same system: the interrupted step's own memory is untouched");
  assert.equal(results[5]?.stepPath, "h", "same system: resumes the step it was interrupted on");
  assert.equal(results[5]?.action.kind, "unloadOre");
});

test("recovery in a DIFFERENT system restarts the loop body at its first step", () => {
  const s = loopTripScript();
  const { results } = run(s, [
    obs({ oreHoldFraction: 0.4, holdEmpty: false }),  // mine acts (m)
    obs({ oreHoldFraction: 0.95, holdEmpty: false }), // mine done -> deliver acts (h)
    // Shields gone in space, working "Nullscape": the watch fires, heads home.
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, holdEmpty: false, damagedItemIDs: [7], systemName: "Nullscape" }),
    // Docked home, in "Havenhome" — a different system: shop paid.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Havenhome" }),
    // Nothing left to fix, still "Havenhome": back out — a mismatch, so the
    // loop rewinds to its first element and "h"'s stale memory is dropped.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Havenhome" }),
    // In space, in "Havenhome": MINE runs — the loop's first step, not deliver.
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, oreHoldFraction: 0.4, systemName: "Havenhome" }),
  ], withShopAndMem);
  assert.equal(results[4]?.action.kind, "undock", "patched up, so back out");
  assert.equal(results[4]?.memory.macroMem["h"], undefined,
    "a different system: the abandoned step's own memory is forgotten with it");
  assert.equal(results[5]?.stepPath, "m", "different system: restarts the loop, not the interrupted step");
  assert.equal(results[5]?.action.kind, "activate");
});

test("an UNREADABLE system never counts as a mismatch — it never rewinds", () => {
  const s = loopTripScript();
  const { results } = run(s, [
    obs({ oreHoldFraction: 0.4, holdEmpty: false }),  // mine acts (m)
    obs({ oreHoldFraction: 0.95, holdEmpty: false }), // mine done -> deliver acts (h)
    // Fires with no system reading at all (an older BFF, or a blind tick).
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, holdEmpty: false, damagedItemIDs: [7] }),
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Havenhome" }),
    // Even though THIS reading is fine, the fired-side one never was — no
    // honest comparison was ever possible, so the rewind never fires.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Havenhome" }),
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, systemName: "Havenhome" }),
  ], withShopAndMem);
  assert.equal(results[5]?.stepPath, "h", "a null reading is never grounds to rewind a working program");
});

test("a TOP-LEVEL step (no enclosing loop) never rewinds", () => {
  // Two plain program steps, no loop around either of them.
  const s = script(
    [macroStep("a", "undock"), macroStep("b", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })],
    [shieldTrip],
  );
  const { results } = run(s, [
    obs({ inSpace: false }),                      // undock acts (a)
    obs({ inSpace: true, oreHoldFraction: 0.4 }),  // undock done -> mine acts (b)
    // Shields gone at "b", in "Nullscape".
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, damagedItemIDs: [7], systemName: "Nullscape" }),
    // Patched up at home, in "Havenhome" — a different system.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Havenhome" }),
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Havenhome" }),
    // Back in space: "b" runs again — "b" has no loop to restart, so it keeps
    // today's behaviour regardless of the system mismatch.
    obs({ shieldRatio: 1, inSpace: true, docked: false, oreHoldFraction: 0.4, systemName: "Havenhome" }),
  ], withShop);
  assert.equal(results[5]?.stepPath, "b", "no enclosing loop: the interrupted step resumes, never rewound");
  assert.equal(results[5]?.action.kind, "activate");
});

test("a rewind cannot be mistaken for the livelock guard's runaway loop", () => {
  const s = loopTripScript();
  const { results } = run(s, [
    obs({ oreHoldFraction: 0.4, holdEmpty: false }),  // mine acts (m)
    obs({ oreHoldFraction: 0.95, holdEmpty: false }), // mine done -> deliver acts (h)
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, holdEmpty: false, damagedItemIDs: [7], systemName: "Nullscape" }),
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Havenhome" }),
    // Mismatch: rewinds to "m" and hands back "undock".
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Havenhome" }),
    // The rewound loop runs a FULL extra lap from here — mine, deliver, and
    // wraps back to mine again — normally, never reading as a hollow pass.
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, oreHoldFraction: 0.4, systemName: "Havenhome" }),
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, oreHoldFraction: 0.95, systemName: "Havenhome" }),
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: true, systemName: "Havenhome" }),
  ], withShop);
  assert.deepEqual(results.map((r) => r.status), Array(8).fill("running"),
    "the rewind, and the ordinary wrap right after it, are both a single free lap each — never a livelock");
  assert.equal(results[5]?.stepPath, "m", "resumes at the rewound loop start");
  assert.equal(results[6]?.stepPath, "h");
  assert.equal(results[7]?.stepPath, "m", "one ordinary wrap after the rewind");
  assert.equal(results[7]?.memory.loopPass, 1,
    "loopPass counts the wrap that happened AFTER the rewind, not the rewind itself");
});

// ⚠ A REWIND MUST NOT BUY THE LOOP ANOTHER RUN. `loopPass` counts the passes a
// loop has COMPLETED, and the pass a rewind lands back at the start of is the
// one that never finished — so the count is exactly what it was a tick ago.
// Zeroing it here would be invisible in every `forever` script and ruinous in
// every counted one: a hauling run told to make a fixed number of trips would
// make almost twice as many because its shields once dipped in the wrong
// system, which is the kind of bug that is only ever found by counting the
// wallet afterwards.
test("a rewind does not give a times-bounded loop extra passes", () => {
  const loop: ProgramNode = {
    id: "L", kind: "loop", repeat: { kind: "times", count: 2 },
    body: [
      macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 }),
      macroStep("h", "deliver-ore"),
    ],
  };
  const s = script([loop], [shieldTrip]);
  const { results } = run(s, [
    // ── pass one, in full ──
    obs({ oreHoldFraction: 0.4, holdEmpty: false }),  // mine acts (m)
    obs({ oreHoldFraction: 0.95, holdEmpty: false }), // mine done -> deliver acts (h)
    obs({ holdEmpty: true }),                         // deliver done -> wraps, pass one counted
    // ── pass two, interrupted and relocated ──
    obs({ shieldRatio: 0.2, inSpace: true, docked: false, holdEmpty: false, damagedItemIDs: [7], systemName: "Nullscape" }),
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [7], systemName: "Havenhome" }),
    // Mismatch: rewinds to "m" — and the pass already banked stays banked.
    obs({ shieldRatio: 0.2, inSpace: false, docked: true, damagedItemIDs: [], systemName: "Havenhome" }),
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, oreHoldFraction: 0.4, systemName: "Havenhome" }),
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: false, oreHoldFraction: 0.95, systemName: "Havenhome" }),
    // Pass two finishes here. Two of two: the program is over, not restarted.
    obs({ shieldRatio: 1, inSpace: true, docked: false, holdEmpty: true, systemName: "Havenhome" }),
  ], withShop);
  assert.equal(results[2]?.memory.loopPass, 1, "pass one is banked before the trouble starts");
  assert.equal(results[5]?.memory.loopPass, 1,
    "the rewind re-enters the pass that never finished — it does not un-count the one that did");
  assert.equal(results[6]?.stepPath, "m", "and it really did rewind to the loop's first step");
  assert.equal(results[8]?.status, "done",
    "two passes asked for, two passes run: the rewind did not buy a third");
});

// ─── In warp, nothing is decided ─────────────────────────────────────────────

// The guard at the top of `decideScriptAction`. Until it existed the macros each
// carried their own `obs.inWarp === true` check and the interrupt scan carried
// NONE, so a watch could fire in mid-flight and issue a module, drone or lock
// call against a grid the ship had already left.

/**
 * One tank layer's watch, the repairer it would switch on, and a hurt reading.
 *
 * ⚠ THE TABLE IS THE TEST. A ship may be shield-tanked, armour-tanked or hull
 * -tanked, and a guard proven against `shield-below` alone would look correct on
 * every fixture anybody happened to write while leaving the armour boat issuing
 * repairer calls into warp. `repairersFor` is already symmetric across the
 * three, so the guard above it has to be proven symmetric too.
 */
const LAYER_WATCHES: readonly {
  readonly layer: string;
  readonly when: Condition;
  readonly hurt: Partial<ScriptObservation>;
  readonly moduleID: number;
}[] = [
  { layer: "shield", when: { kind: "shield-below", fraction: 0.5 },
    hurt: { shieldRatio: 0.2, shieldRepairerIDs: [11] }, moduleID: 11 },
  { layer: "armour", when: { kind: "armor-below", fraction: 0.5 },
    hurt: { armorRatio: 0.2, armorRepairerIDs: [12] }, moduleID: 12 },
  { layer: "hull", when: { kind: "hull-below", fraction: 0.5 },
    hurt: { hullRatio: 0.2, hullRepairerIDs: [13] }, moduleID: 13 },
];

test("a repair watch fires in space and is SILENT in warp - every tank layer, not just shields", () => {
  for (const w of LAYER_WATCHES) {
    const row: InterruptRow = { id: `r-${w.layer}`, when: w.when, respond: "repair" };
    const s = script([macroStep("m", "mine-at-belt")], [row]);
    const mem = initialMemory(s);

    // The in-space half is not decoration: without it a guard that silenced the
    // watch for some unrelated reason would pass the warp half every time.
    const acting = decideScriptAction(s, obs({ ...w.hurt, inWarp: false, snapshot: running() }), mem, registry, home);
    assert.deepEqual(acting.action, { kind: "activate", moduleID: w.moduleID, targetID: 0 },
      `${w.layer}: the watch has to actually fire, or the warp half proves nothing`);
    assert.equal(acting.interruptID, row.id);

    const warping = decideScriptAction(s, obs({ ...w.hurt, inWarp: true }), mem, registry, home);
    assert.deepEqual(warping.action, { kind: "wait" }, `${w.layer}: no module call in warp`);
    assert.equal(warping.phase, "In warp");
    assert.equal(warping.status, "running", `${w.layer}: waiting out a warp is not a stop`);
    assert.equal(warping.interruptID, null, `${w.layer}: the row never got as far as firing`);
  }
});

test("the same guard silences the capacitor watch and the drone watch", () => {
  // Two more shapes of world call the scan could have issued mid-flight: a
  // latching trip home, and a drone launch. Neither is tank-layer specific, and
  // neither gets a tick in warp.
  const trip: InterruptRow = { id: "cap", when: { kind: "capacitor-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const sCap = script([macroStep("m", "mine-at-belt")], [trip]);
  const flat = { capacitorRatio: 0.1 };
  assert.equal(decideScriptAction(sCap, obs({ ...flat, inWarp: false }), initialMemory(sCap), registry, home).action.kind,
    "warp", "the capacitor watch fires in space");
  assert.deepEqual(decideScriptAction(sCap, obs({ ...flat, inWarp: true }), initialMemory(sCap), registry, home).action,
    { kind: "wait" }, "and issues nothing in warp");

  const drones: InterruptRow = { id: "dro", when: { kind: "drone-health-below", fraction: 0.5 }, respond: "launch-drones" };
  const sDro = script([macroStep("m", "mine-at-belt")], [drones]);
  const hurtDrone = { lowestDroneHealth: 0.2, combatDroneBayItemIDs: [21], dronesOut: false };
  assert.equal(decideScriptAction(sDro, obs({ ...hurtDrone, inWarp: false }), initialMemory(sDro), registry, home).action.kind,
    "launchDrones", "the drone watch fires in space");
  assert.deepEqual(decideScriptAction(sDro, obs({ ...hurtDrone, inWarp: true }), initialMemory(sDro), registry, home).action,
    { kind: "wait" }, "and issues nothing in warp");
});

test("an UNREADABLE inWarp fails OPEN - null is not 'in warp'", () => {
  // Same tri-state rule as every other read here. A null that blocked the tick
  // would let one unreadable field mute every watch the ship has.
  const row: InterruptRow = { id: "r", when: { kind: "armor-below", fraction: 0.5 }, respond: "repair" };
  const s = script([macroStep("m", "mine-at-belt")], [row]);
  const r = decideScriptAction(
    s, obs({ armorRatio: 0.2, armorRepairerIDs: [12], inWarp: null, snapshot: running() }), initialMemory(s), registry, home);
  assert.deepEqual(r.action, { kind: "activate", moduleID: 12, targetID: 0 });
});

test("the guard hands the memory back UNTOUCHED, so a latched trip resumes on the tick the warp clears", () => {
  // This is the whole reason the guard may sit above the latch. A warp that
  // spent the trip - or the alert release, or a repair tally - would turn a
  // safety response into a coin flip on how far the ship happened to be flying.
  const row: InterruptRow = { id: "trip", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" };
  const s = script([macroStep("m", "mine-at-belt")], [row]);
  const hurt = { hullRatio: 0.2 };

  const latched = decideScriptAction(s, obs({ ...hurt, inWarp: false }), initialMemory(s), registry, home);
  assert.equal(latched.action.kind, "warp", "the trip starts");
  assert.notEqual(latched.memory.latched, null);

  const warping = decideScriptAction(s, obs({ ...hurt, inWarp: true }), latched.memory, registry, home);
  assert.deepEqual(warping.action, { kind: "wait" }, "the trip does not steer mid-warp");
  assert.equal(warping.memory, latched.memory, "the SAME memory object, not a rebuilt one");

  const landed = decideScriptAction(s, obs({ ...hurt, inWarp: false }), warping.memory, registry, home);
  assert.equal(landed.action.kind, "warp", "and picks the trip straight back up");
  assert.equal(landed.interruptID, "trip");
});

test("a finished program still reports done in warp", () => {
  // The guard sits AFTER the `done` check on purpose. `done()` issues nothing,
  // so a warp cannot make it unsafe, and going first would hold a finished run
  // "running" for the length of a warp it has no stake in.
  const s = script([macroStep("a", "undock")]);
  const mem = { ...initialMemory(s), position: { kind: "done" as const } };
  assert.equal(decideScriptAction(s, obs({ inWarp: true }), mem, registry, home).status, "done");
});

test("the ordinary program issues nothing in warp either", () => {
  // Not just the watches: the step under them is held too, which is what makes
  // this one guard the whole precedence rule rather than an interrupt patch.
  const s = script([macroStep("m", "mine-at-belt")], []);
  const r = decideScriptAction(s, obs({ inWarp: true }), initialMemory(s), registry, home);
  assert.deepEqual(r.action, { kind: "wait" });
  assert.equal(r.stepPath, null);
});

// ─── The per-kind settle ─────────────────────────────────────────────────────

test("settleTicksFor is an ALLOWLIST: a kind it does not name keeps the default", () => {
  // ⚠ THE PROPERTY THE WHOLE TABLE RESTS ON. The map is deliberately PARTIAL, so
  // silence means "unchanged" and an action kind added later by somebody who
  // never read the table inherits today's safe behaviour without doing anything.
  // `unlock` and the asset-moving group are named in the table's own comment as
  // never-cut entries; `createFleet` is simply one it has never heard of. All three
  // must come back the same.
  assert.equal(settleTicksFor({ kind: "unlock", targetID: 4001 }), DEFAULT_SETTLE_TICKS);
  assert.equal(settleTicksFor({ kind: "jettison", itemIDs: [1] }), DEFAULT_SETTLE_TICKS);
  assert.equal(
    settleTicksFor({ kind: "createFleet" }),
    DEFAULT_SETTLE_TICKS,
    "a kind with no entry at all is not a special case — it is the default",
  );
});

test("settleTicksFor cuts the guarded actions to nothing and the unconfirmed ones to one", () => {
  // 0: `lock` is guard-(a) at every call site (`lockIssued` written in the tick
  // the lock goes out), so a duplicate is structurally impossible and the runner
  // owes it no waiting at all.
  assert.equal(settleTicksFor({ kind: "lock", targetID: 4001 }), 0);
  // 1: `activate` has only an observation-derived guard, and a duplicate comes
  // back as EffectAlreadyActive2 — a refusal the ledger books, ten of which on
  // one key end the run. One tick, not zero, and not two.
  assert.equal(settleTicksFor({ kind: "activate", moduleID: 7, targetID: 4001 }), 1);
});

test("⚠ warp is NOT in the table — the one movement action that is not idempotent", () => {
  // Its neighbours in the 0 bucket are standing server-side orders; a warp is a
  // one-shot, and travelToBelt / mineNoTargetRocks / dockAtNearest / compressOre
  // all emit it with no memory guard at all. If this assertion ever fails,
  // somebody has tidied warp in for symmetry and bought a double warp with it.
  assert.equal(settleTicksFor({ kind: "warp", targetID: 4002 }), DEFAULT_SETTLE_TICKS);
});

// ─── The scanner read a site-mode mining block needs ─────────────────────────

test("a mining block set to SITE asks for the scanner read — nearest and chosen do not", () => {
  // ⚠ THE LIVE FAILURE THIS LOCKS SHUT. `observe` fetches `anomalies` only for
  // the blocks that fly to an anomaly by name, and `mine-at-belt` is not one of
  // them — so site mode's barren-grid path, which names the next site ITSELF,
  // read `null` (meaning "unread yet", which waits) on every tick. Five pilots
  // mined their ore site out and then sat on "Reading the scanner for the next
  // ore site." indefinitely with the scanner never asked once.
  const site: BotScript = script([
    { id: "m", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "site" } } },
      until: { kind: "ore-hold-at-least", fraction: 0.9 } },
  ]);
  assert.equal(activeStepToursOreSites(site, initialMemory(site)), true);

  // Pointed at a belt, the SAME block must not pay for a read it never looks at.
  const nearest = script([macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })]);
  assert.equal(activeStepToursOreSites(nearest, initialMemory(nearest)), false);

  const chosen: BotScript = script([
    { id: "m", kind: "macro", macro: "mine-at-belt",
      args: { belt: { kind: "belt", belt: { mode: "chosen", ref: { entity: "belt", id: null, name: "V - Belt 1", systemName: null } } } },
      until: { kind: "ore-hold-at-least", fraction: 0.9 } },
  ]);
  assert.equal(activeStepToursOreSites(chosen, initialMemory(chosen)), false);

  // And no other block earns it by sitting next to one that does.
  const hauling = script([macroStep("d", "deliver-ore")]);
  assert.equal(activeStepToursOreSites(hauling, initialMemory(hauling)), false);
});

test("Farmer flight gate preserves stationary Fleet Miner ownership and settles point travel", () => {
  const miner = script([macroStep("miner", "fleet-mine")], []);
  const drone = { itemID: 201, typeID: 10250, name: null, activity: "mining", targetID: 800,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } }, entities: [] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const reading = obs({ snapshot, dronesOut: true,
    miningDrones: { bay: [], out: [drone], maxActive: 5, roles: { 10250: "mining" } } });
  const stationary: MacroDecider = () => tick({ kind: "wait" }, { kind: "acting" });
  assert.equal(decideScriptAction(miner, reading, initialMemory(miner), { ...registry, "fleet-mine": stationary }, home).action.kind, "wait");
  for (const action of [{ kind: "gotoPoint", position: { x: 100, y: 0, z: 0 }, shipID: 1, solarSystemID: 2 },
    { kind: "stopShip" }] as const) {
    const travel: MacroDecider = () => tick(action, { kind: "acting" });
    assert.equal(decideScriptAction(miner, reading, initialMemory(miner), { ...registry, "fleet-mine": travel }, home).action.kind,
      "recallDrones", "measured Fleet Miner travel settles controlled flight");
  }
});

test("running support keeps its internal drone owner while terminal and travel still settle", () => {
  const support = script([macroStep("support", "mining-support")], []);
  const drone = { itemID: 201, typeID: 10250, name: null, activity: "mining", targetID: 800,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } }, entities: [] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const reading = obs({ snapshot, dronesOut: true,
    miningDrones: { bay: [], out: [drone], maxActive: 5, roles: { 10250: "mining" } } });
  for (const relocating of [false, true]) {
    const maintain: MacroDecider = () => tick({ kind: "maintainMiningSupport", relocating }, { kind: "acting" });
    const result = decideScriptAction(support, reading, initialMemory(support), { ...registry, "mining-support": maintain }, home);
    assert.deepEqual(result.action, { kind: "maintainMiningSupport", relocating }, "support owns work and relocation recall");
    assert.equal(result.memory.miningFlight, undefined);
  }
  const terminal = decideScriptAction(support, reading, { ...initialMemory(support), position: { kind: "done" } }, registry, home);
  assert.equal(terminal.action.kind, "recallDrones"); assert.equal(terminal.status, "running");
  const blocked: MacroDecider = () => tick({ kind: "wait" }, { kind: "blocked", reason: "unavailable" });
  assert.equal(decideScriptAction(support, reading, initialMemory(support), { ...registry, "mining-support": blocked }, home).action.kind, "recallDrones");
  const traveling: MacroDecider = () => tick({ kind: "warp", targetID: 9 }, { kind: "acting" });
  assert.equal(decideScriptAction(support, reading, initialMemory(support), { ...registry, "mining-support": traveling }, home).action.kind, "recallDrones");
});

test("site miner recalls a controlled mining flight before its next movement order", () => {
  const site = script([{ id: "m", kind: "macro", macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "site" } } } }], []);
  const moving: MacroDecider = () => tick({ kind: "warpScan", target: "QA-001" }, { kind: "acting" });
  const drone = { itemID: 201, typeID: 101, name: null, activity: "mining", targetID: 800,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } }, entities: [] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const reading = (out: readonly typeof drone[]) => obs({
    snapshot, hostileOnGrid: false, dronesOut: out.length > 0,
    miningDrones: { bay: [], out, maxActive: 5, roles: { 101: "mining" } },
  });
  const first = decideScriptAction(site, reading([drone]), initialMemory(site), { ...registry, "mine-at-belt": moving }, home);
  assert.equal(first.action.kind, "recallDrones");
  const pending = decideScriptAction(site, reading([{ ...drone, activity: "returning" }]), first.memory,
    { ...registry, "mine-at-belt": moving }, home);
  assert.equal(pending.action.kind, "wait");
  const returned = decideScriptAction(site, reading([]), pending.memory, { ...registry, "mine-at-belt": moving }, home);
  assert.equal(returned.action.kind, "warpScan");
});

test("terminal DONE waits for fresh empty controlled flight after recall, including counted completion", () => {
  const s = script([{ id: "L", kind: "loop", repeat: { kind: "times", count: 1 },
    body: [macroStep("m", "mine-at-belt", { kind: "ore-hold-at-least", fraction: 0.9 })] }], []);
  const drone = { itemID: 201, typeID: 101, name: null, activity: "mining", targetID: 800,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } }, entities: [] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const reading = (out: readonly typeof drone[] | null) => obs({ oreHoldFraction: 0.95, snapshot,
    miningDrones: { bay: [], out, maxActive: 5, roles: { 101: "mining" } } });
  let mem = initialMemory(s);
  let result = decideScriptAction(s, reading([drone]), mem, registry, home);
  mem = result.memory;
  for (let n = 0; n < 4 && result.action.kind !== "recallDrones"; n++) {
    result = decideScriptAction(s, reading([drone]), mem, registry, home);
    mem = result.memory;
  }
  assert.equal(result.action.kind, "recallDrones");
  assert.equal(result.status, "running");
  result = decideScriptAction(s, reading([{ ...drone, activity: "returning" }]), mem, registry, home);
  assert.equal(result.status, "running", "recall acknowledgement is not return");
  result = decideScriptAction(s, reading([]), result.memory, registry, home);
  assert.equal(result.status, "done");
});

test("terminal drone authority UNKNOWN cannot become clean DONE", () => {
  const s = script([], []);
  const mem = { ...initialMemory(s), position: { kind: "done" as const } };
  const unknown = decideScriptAction(s, obs({ miningDrones: null }), mem, registry, home);
  assert.equal(unknown.status, "running");
  assert.equal(unknown.action.kind, "wait");
  const confirmed = decideScriptAction(s, obs({ miningDrones: { bay: null, out: [], maxActive: null, roles: {} } }),
    unknown.memory, registry, home);
  assert.equal(confirmed.status, "done");
  const combat = { itemID: 81, typeID: 102, name: null, activity: "fighting", targetID: 9,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const fighting = decideScriptAction(s, obs({ miningDrones: { bay: [], out: [combat], maxActive: 5,
    roles: { 102: "combat" } } }), mem, registry, home);
  assert.equal(fighting.action.kind, "recallDrones");
  assert.equal(fighting.status, "running");
  const expired = decideScriptAction(s, obs({ miningDrones: null }),
    { ...unknown.memory, terminalDroneTicks: 90 }, registry, home);
  assert.equal(expired.status, "paused", "bounded failure retains ownership without clean completion");
});

test("ordinary depleted site recalls before heading home; emergency watch may escape", () => {
  const s = script([macroStep("m", "mine-at-belt")], []);
  const drone = { itemID: 201, typeID: 102, name: null, activity: "fighting", targetID: 800,
    controlled: true, shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } }, entities: [] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const reading = (out: readonly typeof drone[]) => obs({ snapshot,
    miningDrones: { bay: [], out, maxActive: 5, roles: { 102: "combat" } } });
  const blocked: MacroDecider = () => tick({ kind: "wait" }, { kind: "blocked", reason: "Site depleted." });
  const first = decideScriptAction(s, reading([drone]), initialMemory(s), { ...registry, "mine-at-belt": blocked }, home);
  assert.equal(first.action.kind, "recallDrones");
  const pending = decideScriptAction(s, reading([{ ...drone, activity: "returning" }]), first.memory,
    { ...registry, "mine-at-belt": blocked }, home);
  assert.equal(pending.action.kind, "wait");
  const returned = decideScriptAction(s, reading([]), pending.memory, { ...registry, "mine-at-belt": blocked }, home);
  assert.equal(returned.action.kind, "warp");

  const danger = script([macroStep("m", "mine-at-belt")], [floor]);
  const escape = decideScriptAction(danger, obs({ ...reading([drone]), shieldRatio: 0.2, health: 0.2 }),
    initialMemory(danger), registry, home);
  assert.equal(escape.action.kind, "warp", "a newly fired health watch keeps its survival route");
  const continuingEscape = decideScriptAction(danger,
    obs({ ...reading([drone]), shieldRatio: 0.2, health: 0.2 }), escape.memory, registry, home);
  assert.equal(continuingEscape.action.kind, "warp", "the latched emergency remains exempt until safe");
});

test("site miner launches mining-role stacks for its confirmed locked rock", () => {
  const site = script([{ id: "m", kind: "macro", macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "site" } } } }], []);
  const snapshot = { ship: { position: { x: 0, y: 0, z: 0 } },
    entities: [{ itemID: 800, miningYieldTypeID: 1230 }] } as unknown as NonNullable<ScriptObservation["snapshot"]>;
  const prior = { ...initialMemory(site), macroMem: { m: { rockID: 800 } } };
  const result = decideScriptAction(site, obs({ snapshot, lockedTargetIDs: [800],
    miningDrones: { bay: [{ itemID: 100, typeID: 101, quantity: 5 },
      { itemID: 101, typeID: 102, quantity: 5 }], out: [], maxActive: 5,
      roles: { 101: "mining", 102: "combat" } },
  }), prior, registry, home);
  assert.deepEqual(result.action, { kind: "launchDrones", droneItemIDs: [100] });
});

test("a latched repair trip does not order the scanner read on the site block's behalf", () => {
  // The trip is running the borrowed Repair-ship block, not the mining one (see
  // `activeMacroID` above), and the read is priced per block.
  const s: BotScript = {
    ...script([
      { id: "m", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "site" } } },
        until: { kind: "ore-hold-at-least", fraction: 0.9 } },
    ], [shieldTrip]),
  };
  const flying = decideScriptAction(s, obs({ shieldRatio: 0.2, docked: false }), initialMemory(s), withShop, home);
  assert.equal(activeStepToursOreSites(s, flying.memory), false);
});
