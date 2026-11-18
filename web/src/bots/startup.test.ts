import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScriptRunner } from "../nav/scriptRunner.ts";
import { SCRIPT_MACROS } from "../nav/scriptMacros.ts";
import type { BotScript, MacroStep } from "./botScript.ts";
import type { ScriptObservation } from "../nav/scriptConditions.ts";
import type { ScriptAction, MacroTick } from "../nav/scriptDecide.ts";
import { startupPrefix, startupSteps, startupPostcondition, startupActionSupported, startupActionLanded, startupChangesShip,
  startupActionUnfenced,
  type StartupCheckpoint } from "./startup.ts";
import { toEditorState, toScript } from "./editorDoc.ts";
import { encodeScriptDoc, decodeScriptValue } from "./scriptCodec.ts";
const { createStartupRuns } = createRequire(import.meta.url)("../../../src/startupRuns.js");
const setup: MacroStep = { id: "setup", kind: "macro", macro: "undock", args: {}, until: { kind: "hold-empty" } };
const doc: BotScript = { format: "evejs-bot-script", version: 1, name: "Startup", notes: "", home: { entity: "station", id: 60, name: "Home", systemName: null },
  interrupts: [], program: [setup, { id: "main", kind: "loop", repeat: { kind: "forever" }, body: [{ id: "work", kind: "macro", macro: "deliver-ore", args: {
    station: { kind: "station", ref: { entity: "station", id: 60, name: "Home", systemName: null } } } }] }] };
const tick = (action: ScriptAction, outcome: MacroTick["outcome"]): MacroTick => ({ action, outcome, why: "test", phase: "test", armed: true, nextMem: {} });
function observation(docked: boolean): ScriptObservation {
  return { inSpace: !docked, docked, inWarp: false, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1, oreHoldFraction: 0,
    flightStatus: { inSpace: !docked, docked, shipID: 50, shipTypeID: 1, stationID: docked ? 60 : null, structureID: null,
      solarSystemID: 3001, shipIsCapsule: false, shipMode: null, shipSpeedFraction: 0 } };
}
function harness(startup: StartupCheckpoint, prematurelyDone = false) {
  let facts = observation(true);
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({ startup, observe: async () => facts, issue: async action => { issued.push(action); }, sleep: async () => {},
    onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    registry: { undock: () => prematurelyDone ? tick({ kind: "wait" }, { kind: "done" }) : tick({ kind: "undock" }, { kind: "acting" }),
      "dock-at-nearest": () => tick({ kind: "dock", stationID: 60 }, { kind: "acting" }),
      "deliver-ore": () => tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }) },
    travelHome: () => tick({ kind: "wait" }, { kind: "done" }) });
  return { runner, issued, setFacts: (value: ScriptObservation) => { facts = value; }, pump: async (count = 6) => { for (let i = 0; i < count; i++) await runner.tick(); } };
}
function manager() {
  const runs = createStartupRuns();
  const input = { accountID: 7, characterID: 10, scriptHash: "a".repeat(64), scriptRev: 1, steps: startupSteps(doc), prefixLength: 1, program: doc.program,
    adapters: { postcondition: startupPostcondition, actionSupported: startupActionSupported } };
  return { runs, input, open: () => runs.open(input) };
}
test("prefix + main loop round-trips as v1; old loops and finite/mixed documents retain shape", () => {
  const edit = toEditorState(doc); assert.equal(edit.startup[0]?.id, "setup"); assert.equal(edit.steps[0]?.id, "work");
  assert.equal(encodeScriptDoc(toScript(edit)), encodeScriptDoc(doc)); assert.equal(decodeScriptValue(toScript(edit)).ok, true);
  const old = { ...doc, program: [doc.program[1]!] }; assert.deepEqual(toEditorState(old).startup, []);
  const finite = { ...doc, program: [setup] }; assert.equal(startupPrefix(finite).length, 0);
  const advanced = { ...doc, program: [doc.program[1]!, setup] }; assert.ok(toEditorState(advanced).advancedProgram);
  assert.equal(encodeScriptDoc(toScript(toEditorState(advanced))), encodeScriptDoc(advanced));
  const emptyMain = toScript({ ...edit, steps: [] });
  assert.equal(emptyMain.program.at(-1)?.kind, "loop"); assert.equal(decodeScriptValue(emptyMain).ok, false);
});
test("ACK and until cannot complete required Startup; pause/resume and same-process reconnect cannot resend", async () => {
  const m = manager(), checkpoint = m.open(), h = harness(checkpoint);
  h.runner.start(doc); await h.runner.tick(); assert.equal(h.issued[0]?.kind, "undock");
  h.runner.pause(); h.runner.resume(); await h.pump(2);
  await h.runner.suspendTransport(); h.runner.resumeTransport(); await h.pump(2);
  assert.equal(h.issued.length, 1); assert.equal(checkpoint.snapshot().blocks.setup.state, "PENDING");
  h.setFacts(observation(false)); await h.pump();
  assert.equal(checkpoint.snapshot().blocks.setup.state, "COMPLETE"); assert.ok(h.issued.some(action => action.kind === "unloadOre"));
  assert.equal(h.issued.filter(action => action.kind === "undock").length, 1);
});
test("a macro reporting done without the postcondition cannot open MAIN", async () => {
  const m = manager(), h = harness(m.open(), true); h.runner.start(doc); await h.pump();
  assert.equal(h.issued.length, 0); assert.equal(h.runner.getStatus(), "running");
});
test("restored completed checkpoint skips Startup; Stop then fresh Start creates another logical run", async () => {
  const m = manager(), first = m.open();
  await first.observe(setup, observation(false));
  const same = m.runs.open({ ...m.input, logicalRunID: first.logicalRunID }), h = harness(same);
  h.runner.start(doc); await h.pump(); assert.ok(h.issued.some(action => action.kind === "unloadOre"));
  assert.equal(h.issued.some(action => action.kind === "undock"), false);
  h.runner.stop(); same.end(); const next = m.open(); assert.notEqual(next.logicalRunID, first.logicalRunID);
  const fresh = harness(next); fresh.runner.start(doc); await fresh.runner.tick(); assert.equal(fresh.issued[0]?.kind, "undock");
});
test("unsupported mutation is blocked before dispatch", async () => {
  const unsafe = { ...setup, macro: "move-items" as const };
  assert.equal(startupPostcondition(unsafe, observation(true), 60), null);
  assert.equal(startupActionSupported(unsafe, { kind: "applyFitting", fittingID: 1 }), false);
  // Refit actions belong to the refit step only.
  assert.equal(startupActionSupported(setup, { kind: "boardShip", shipID: 77 }), false);
});
function fileFor(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-startup-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "startup.json");
}
test("pending restart never resends and a changed ship cannot prove the original action", async t => {
  const filePath = fileFor(t), input = manager().input;
  const first = createStartupRuns({ filePath }).open(input), original = harness(first);
  original.runner.start(doc); await original.runner.tick(); assert.equal(original.issued.length, 1);
  const restored = createStartupRuns({ filePath }).open({ ...input, logicalRunID: first.logicalRunID }), h = harness(restored);
  h.runner.start(doc); await h.pump(); assert.equal(h.issued.length, 0); assert.equal(h.runner.getStatus(), "paused");
  const changed = { ...observation(false), flightStatus: { ...observation(false).flightStatus!, shipID: 51 } };
  h.setFacts(changed); h.runner.resume(); await h.pump(); assert.equal(h.issued.length, 0);
  h.setFacts(observation(false)); h.runner.resume(); await h.pump(); assert.ok(h.issued.some(action => action.kind === "unloadOre"));
});
test("a branch choice and completed prefix cursor survive WC restart without changing sides", async t => {
  const filePath = fileFor(t), input = manager().input;
  const dock: MacroStep = { id: "dock", kind: "macro", macro: "dock-at-nearest", args: {} };
  const branchDoc: BotScript = { ...doc, program: [{ id: "choice", kind: "branch", when: { kind: "hold-empty" },
    then: [setup, dock], else: [{ id: "other", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 1 } } }] }, doc.program[1]!] };
  const args = { ...input, program: branchDoc.program, steps: startupSteps(branchDoc) };
  const first = createStartupRuns({ filePath }).open(args), h = harness(first);
  h.runner.start(branchDoc); await h.pump(2); assert.equal(h.issued[0]?.kind, "undock");
  h.setFacts(observation(false)); await h.pump(1);
  assert.deepEqual(first.snapshot().runnerMemory.position, { kind: "branch", node: 0, side: "then", body: 1 });
  const second = createStartupRuns({ filePath }).open({ ...args, logicalRunID: first.logicalRunID }), after = harness(second);
  after.setFacts({ ...observation(false), holdEmpty: false }); after.runner.start(branchDoc); await after.pump(1);
  assert.equal(after.issued[0]?.kind, "dock"); assert.equal(second.snapshot().branchChoices.choice, "then");
  after.setFacts(observation(true)); await after.pump(); assert.ok(after.issued.some(action => action.kind === "unloadOre"));
});
test("pure wait deadline survives restart and malformed evidence cannot skip MAIN barrier", async t => {
  const filePath = fileFor(t), input = manager().input;
  const wait: MacroStep = { id: "wait", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 3 } } };
  const args = { ...input, steps: [wait], program: [wait, doc.program[1]!] };
  let now = 1000;
  const first = createStartupRuns({ filePath, now: () => now }).open(args);
  assert.equal(await first.observe(wait, observation(true)), "NEEDED"); now = 2500;
  const second = createStartupRuns({ filePath, now: () => now }).open({ ...args, logicalRunID: first.logicalRunID });
  assert.equal(await second.observe(wait, observation(true)), "NEEDED"); now = 4000;
  assert.equal(await second.observe(wait, observation(true)), "COMPLETE");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  raw.records[first.logicalRunID].mainEntered = true;
  raw.records[first.logicalRunID].runnerMemory = { position: { kind: "loop", node: 999, body: 0 }, loopPass: 0, stepTicks: 0,
    cannotTellStreak: 0, latched: null, macroMem: {}, board: {} };
  fs.writeFileSync(filePath, JSON.stringify(raw));
  assert.throws(() => createStartupRuns({ filePath }).open({ ...args, logicalRunID: first.logicalRunID }), /checkpoint is invalid/);
});
test("failure to persist the dispatch fence pauses without issuing a mutation", async t => {
  const filePath = fileFor(t), checkpoint = createStartupRuns({ filePath }).open(manager().input);
  await checkpoint.observe(setup, observation(true));
  fs.unlinkSync(filePath); fs.mkdirSync(filePath);
  const h = harness(checkpoint); h.runner.start(doc); await h.runner.tick();
  assert.equal(h.issued.length, 0); assert.equal(h.runner.getStatus(), "paused");
});
test("stable IDs that match object prototype names still persist the dispatch fence", async t => {
  const filePath = fileFor(t), unusual = { ...setup, id: "__proto__" };
  const input = { ...manager().input, steps: [unusual], program: [unusual, doc.program[1]!] };
  const first = createStartupRuns({ filePath }).open(input);
  await first.beforeIssue(unusual, { kind: "undock" }, 1);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(filePath, "utf8")).records[first.logicalRunID].blocks, "__proto__"), true);
  const restored = createStartupRuns({ filePath }).open({ ...input, logicalRunID: first.logicalRunID });
  assert.equal(await restored.observe(unusual, observation(true)), "BLOCKED");
  await assert.rejects(restored.beforeIssue(unusual, { kind: "undock" }, 2));
});

for (const code of ["CALL_REFUSED", "EVE_GATEWAY_TIMEOUT"]) {
  test(`Farmer Startup cursor fences MAIN without committing ${code} action progress`, async () => {
    const checkpoint = manager().open();
    let calls = 0;
    const runner = createScriptRunner({ startup: checkpoint, observe: async () => observation(false),
      issue: async () => {
        calls++;
        const evidence = checkpoint.snapshot();
        assert.equal(evidence.mainEntered, true, "verified prefix cursor is durable before MAIN dispatch");
        assert.deepEqual(evidence.runnerMemory.macroMem, {}, "requested completion is not durable progress");
        throw Object.assign(new Error(code), { code });
      }, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
      registry: { undock: () => tick({ kind: "undock" }, { kind: "acting" }),
        "deliver-ore": (_step, _facts, mem) => mem?.sent
          ? tick({ kind: "wait" }, { kind: "done" })
          : { ...tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }), nextMem: { sent: true } } },
      travelHome: () => tick({ kind: "wait" }, { kind: "done" }) });
    runner.start(doc);
    for (let i = 0; i < 30 && calls < 2 && runner.getStatus() === "running"; i++) await runner.tick();
    if (code === "CALL_REFUSED") assert.equal(calls, 2, "definite refusal remains retryable");
    else {
      assert.equal(calls, 1);
      assert.equal(runner.transportCustody(), true);
      runner.resume(); await runner.tick();
      assert.equal(calls, 1, "uncertain dispatched outcome cannot be replayed");
    }
  });
}

test("Farmer MAIN dispatch refuses when the verified Startup cursor cannot persist", async () => {
  const checkpoint = manager().open();
  const h = harness({ ...checkpoint, checkpoint: async memory => {
    if (memory.position.kind !== "done" && memory.position.node >= 1) throw new Error("cursor write failed");
    await checkpoint.checkpoint(memory);
  } });
  h.setFacts(observation(false)); h.runner.start(doc);
  // A stop in space latches the trip home first (scriptRunner `pauseWith`);
  // the cursor still cannot persist, so the next tick's write ends the run.
  for (let i = 0; i < 5 && h.runner.getStatus() === "running"; i++) await h.runner.tick();
  assert.equal(h.issued.length, 0);
  assert.equal(h.runner.getStatus(), "paused");
  // The trip's own tick may persist the Startup cursor; MAIN is never entered.
  assert.notEqual(checkpoint.snapshot().mainEntered, true);
});

test("Startup authority cannot relax Farmer recovery for an unrelated MAIN action", async () => {
  const checkpoint = manager().open();
  const runner = createScriptRunner({ startup: checkpoint, observe: async () => observation(false),
    issue: async () => {}, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    registry: { undock: () => tick({ kind: "undock" }, { kind: "acting" }),
      "deliver-ore": () => ({ ...tick({ kind: "undock" }, { kind: "acting" }), nextMem: { sent: true } }) },
    travelHome: () => tick({ kind: "wait" }, { kind: "done" }) });
  runner.start(doc); await runner.tick(); await runner.suspendTransport();
  assert.throws(() => runner.resumeTransport(), /state that cannot be reset safely/);
});

// ── Refit in Startup: board the fitting's hull, apply the fit, then MAIN ──────
// Two actions in one step, and the second runs in a different ship, so this
// exercises the engine's landed-action and ship-change rules end to end.
const refit: MacroStep = { id: "refit", kind: "macro", macro: "refit-ship",
  args: { fitting: { kind: "fitting", fittingID: 5, name: "Ice fit" } } };
const refitDoc: BotScript = { ...doc, program: [refit, doc.program[1]!] };
const iceFit = { fittingID: 5, name: "Ice fit", description: "", shipTypeID: 900, ownerID: 1, savedDate: null,
  modules: [{ typeID: 11, flagID: 27, quantity: 1 }, { typeID: 12, flagID: 11, quantity: 1 },
    // Drones in the bay are part of the fitting but not of the hull's fit.
    { typeID: 13, flagID: 87, quantity: 5 }] };
const FITTED = [{ flagID: 27, typeID: 11 }, { flagID: 11, typeID: 12 }];
function refitObs(shipID: number, shipTypeID: number, modules: readonly { flagID: number; typeID: number }[]): ScriptObservation {
  const base = observation(true);
  return { ...base, flightStatus: { ...base.flightStatus!, shipID, shipTypeID },
    savedFittings: [iceFit], activeFitting: { shipID, modules } };
}
function refitRun(start: ScriptObservation, applyLands = true) {
  const runs = createStartupRuns();
  const checkpoint = runs.open({ accountID: 7, characterID: 10, scriptHash: "b".repeat(64), scriptRev: 1,
    steps: startupSteps(refitDoc), prefixLength: 1, program: refitDoc.program,
    adapters: { postcondition: startupPostcondition, actionSupported: startupActionSupported,
      actionLanded: startupActionLanded, changesShip: startupChangesShip } });
  let facts = start;
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({ startup: checkpoint, observe: async () => facts, sleep: async () => {},
    issue: async action => {
      issued.push(action);
      if (action.kind === "boardShip") facts = refitObs(action.shipID, 900, []);
      if (action.kind === "applyFitting") facts = refitObs(77, 900, applyLands ? FITTED : FITTED.slice(1));
    },
    onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    registry: { "refit-ship": (_step, obs) => obs.flightStatus?.shipID !== 77
        ? tick({ kind: "boardShip", shipID: 77 }, { kind: "acting" })
        : tick({ kind: "applyFitting", fittingID: 5 }, { kind: "acting" }),
      "deliver-ore": () => tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }) },
    travelHome: () => tick({ kind: "wait" }, { kind: "done" }) });
  return { runner, issued, checkpoint, pump: async (count = 16) => { for (let i = 0; i < count; i++) await runner.tick(); } };
}

test("refit postcondition: the fitting's hull with every slotted module, by name first", () => {
  assert.equal(startupPostcondition(refit, refitObs(77, 900, FITTED), null), true);
  assert.equal(startupPostcondition(refit, refitObs(77, 900, [...FITTED, { flagID: 19, typeID: 99 }]), null), true,
    "an extra module does not fail the fit");
  assert.equal(startupPostcondition(refit, refitObs(77, 900, FITTED.slice(1)), null), false, "a missing module is not the fit");
  assert.equal(startupPostcondition(refit, refitObs(50, 1, FITTED), null), false, "the wrong hull is not the fit");
  const acrossSwap = { ...refitObs(77, 900, FITTED), activeFitting: { shipID: 50, modules: FITTED } };
  assert.equal(startupPostcondition(refit, acrossSwap, null), null, "a read from another hull proves nothing");
  assert.equal(startupPostcondition(refit, { ...refitObs(77, 900, FITTED), activeFitting: null }, null), null);
  const renamed = { ...refit, args: { fitting: { kind: "fitting" as const, fittingID: 999, name: "Ice fit" } } };
  assert.equal(startupPostcondition(renamed, refitObs(77, 900, FITTED), null), true, "the name wins over a stale id");
  // In space too: a ship already carrying the fit needs no trip home.
  const undocked = { ...refitObs(77, 900, FITTED), flightStatus: { ...observation(false).flightStatus!, shipID: 77, shipTypeID: 900 } };
  assert.equal(startupPostcondition(refit, undocked, null), true);
});

test("a Startup refit boards, applies, moves the run onto the new hull, then opens MAIN", async () => {
  const h = refitRun(refitObs(50, 1, []));
  h.runner.start(refitDoc); await h.pump();
  assert.deepEqual(h.issued.slice(0, 2).map(action => action.kind), ["boardShip", "applyFitting"]);
  assert.equal(h.issued.filter(action => action.kind === "boardShip").length, 1, "boarding is never resent");
  assert.ok(h.issued.some(action => action.kind === "unloadOre"), "MAIN never started");
  const evidence = h.checkpoint.snapshot();
  assert.equal(evidence.blocks.refit.state, "COMPLETE");
  assert.equal(evidence.startingShipID, 77, "the refitted hull is the run's ship from here on");
});

test("a pilot already in the fit skips the refit entirely", async () => {
  const h = refitRun(refitObs(77, 900, FITTED));
  h.runner.start(refitDoc); await h.pump();
  assert.equal(h.issued.some(action => action.kind === "boardShip" || action.kind === "applyFitting"), false);
  assert.ok(h.issued.some(action => action.kind === "unloadOre"));
});

test("a fit that only partly lands never opens MAIN and is not reapplied", async () => {
  const h = refitRun(refitObs(50, 1, []), false);
  h.runner.start(refitDoc); await h.pump(30);
  assert.equal(h.issued.filter(action => action.kind === "applyFitting").length, 1);
  assert.equal(h.issued.some(action => action.kind === "unloadOre"), false);
  assert.equal(h.runner.getStatus(), "paused");
});

test("a ship swap the refit did not make still blocks it", async () => {
  const h = refitRun(refitObs(50, 1, []));
  assert.equal(await h.checkpoint.observe(refit, refitObs(50, 1, [])), "NEEDED");
  assert.equal(await h.checkpoint.observe(refit, refitObs(60, 1, [])), "BLOCKED");
});

// ── Started in space: a hosted run seen live pausing on its own safety trip ───
// Live 2026-10-06: a server-hosted refit started in space blocked ("dock
// first"), the decider latched a trip home under the step's id, and the Startup
// fence refused the trip's startRoute ("no reconciliation adapter").

test("a hosted refit started in space flies home, boards, applies, then opens MAIN", async () => {
  const runs = createStartupRuns();
  const checkpoint = runs.open({ accountID: 7, characterID: 10, scriptHash: "c".repeat(64), scriptRev: 1,
    steps: startupSteps(refitDoc), prefixLength: 1, program: refitDoc.program,
    adapters: { postcondition: startupPostcondition, actionSupported: startupActionSupported,
      actionLanded: startupActionLanded, changesShip: startupChangesShip, unfenced: startupActionUnfenced } });
  const hangar = (_shipID: number) => [
    { itemID: 50, typeID: 1, groupID: null, categoryID: 6, flagID: null, quantity: 1, singleton: true },
    { itemID: 77, typeID: 900, groupID: null, categoryID: 6, flagID: null, quantity: 1, singleton: true },
    { itemID: 301, typeID: 11, groupID: null, categoryID: 7, flagID: null, quantity: 1, singleton: false },
    { itemID: 302, typeID: 12, groupID: null, categoryID: 7, flagID: null, quantity: 1, singleton: false },
  ];
  const docked = (shipID: number, shipTypeID: number, modules: readonly { flagID: number; typeID: number }[]) =>
    ({ ...refitObs(shipID, shipTypeID, modules), homeStationID: 60, activeShipID: shipID, stationHangar: hangar(shipID) });
  const space = observation(false);
  let facts: ScriptObservation = { ...space, flightStatus: { ...space.flightStatus!, shipID: 50, shipTypeID: 1 },
    savedFittings: [iceFit], activeFitting: { shipID: 50, modules: [] }, homeStationID: 60 };
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({ startup: checkpoint, observe: async () => facts, sleep: async () => {},
    issue: async action => {
      issued.push(action);
      if (action.kind === "startRoute") facts = docked(50, 1, []);
      if (action.kind === "boardShip") facts = docked(action.shipID, 900, []);
      if (action.kind === "applyFitting") facts = docked(77, 900, FITTED);
    },
    onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    registry: { "refit-ship": SCRIPT_MACROS["refit-ship"]!,
      "deliver-ore": () => tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }) },
    travelHome: () => tick({ kind: "wait" }, { kind: "done" }) });
  runner.start(refitDoc);
  for (let i = 0; i < 24; i++) await runner.tick();
  assert.deepEqual(issued.slice(0, 3).map(action => action.kind), ["startRoute", "boardShip", "applyFitting"]);
  assert.ok(issued.some(action => action.kind === "unloadOre"), `MAIN never started: ${runner.getStatus()}`);
  assert.equal(checkpoint.snapshot().blocks.refit.state, "COMPLETE");
});

test("a Startup step that blocks in space flies home instead of tripping the fence", async () => {
  const dock: MacroStep = { id: "setup", kind: "macro", macro: "dock-at-nearest", args: {} };
  const dockDoc: BotScript = { ...doc, program: [dock, doc.program[1]!] };
  const checkpoint = createStartupRuns().open({ ...manager().input, steps: [dock], program: dockDoc.program });
  const issued: ScriptAction[] = [];
  let pauseReason: string | null = null;
  const runner = createScriptRunner({ startup: checkpoint, observe: async () => observation(false), sleep: async () => {},
    issue: async action => { issued.push(action); },
    onProgress: snapshot => { pauseReason = snapshot.pauseReason ?? pauseReason; }, isSessionLost: () => false, refusalReason: String,
    registry: { "dock-at-nearest": () => tick({ kind: "wait" }, { kind: "blocked", reason: "cannot here" }),
      "deliver-ore": () => tick({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" }) },
    travelHome: () => tick({ kind: "startRoute", stationID: 60 }, { kind: "acting" }) });
  runner.start(dockDoc);
  for (let i = 0; i < 4; i++) await runner.tick();
  assert.ok(issued.some(action => action.kind === "startRoute"), "the safety trip home never left");
  assert.doesNotMatch(String(pauseReason ?? ""), /reconciliation adapter/);
  assert.equal(issued.some(action => action.kind === "unloadOre"), false, "a blocked Startup never opens MAIN");
});
