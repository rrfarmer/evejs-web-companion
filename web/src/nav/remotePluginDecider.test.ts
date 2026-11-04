// A plugin block decided in its plugin's own process, for a bot the BFF hosts
// (bots/pluginMacros.ts setRemotePluginDecider): the runner asks, decides
// again with the answer, and acts on it; a plugin that cannot answer stops its
// own bot with the reason, and nothing is acted on.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { HomeTravelDecider, MacroDecider, MacroTick, ScriptAction } from "./scriptDecide.ts";
import { createScriptRunner } from "./scriptRunner.ts";
import { setRemotePluginDecider } from "../bots/pluginMacros.ts";

function mt(action: ScriptAction, outcome: MacroTick["outcome"]): MacroTick {
  return { action, why: "why", phase: "phase", armed: true, outcome, nextMem: {} };
}

const calm = (): ScriptObservation => ({
  inSpace: true, docked: false, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
  oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
});

const step = (id: string, macro: MacroStep["macro"]): MacroStep => ({ id, kind: "macro", macro, args: {} });

const doc = (program: MacroStep[]): BotScript => ({
  format: "evejs-bot-script", version: 1, name: "t", notes: "",
  home: { entity: "station", id: 1, name: "Home", systemName: null }, interrupts: [], program,
});

const home: HomeTravelDecider = () => mt({ kind: "wait" }, { kind: "done" });
// The BFF never runs a plugin's own decider: its registry entry is a stand-in that must not be called.
const stub: MacroDecider = () => {
  throw new Error("a plugin block was decided in the BFF");
};

function runner(issued: ScriptAction[]) {
  return createScriptRunner({
    observe: async () => calm(), issue: async (action) => { issued.push(action); }, registry: { "test:first": stub, "test:second": stub },
    travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
  });
}

test("the plugin's answer is acted on, and a plugin step done hands on to the next within the tick", async (t) => {
  const asked: string[] = [];
  setRemotePluginDecider(async (macro) => {
    asked.push(macro);
    return { tick: macro === "test:first" ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "warp", targetID: 7 }, { kind: "acting" }) };
  });
  t.after(() => setRemotePluginDecider(null));
  const issued: ScriptAction[] = [];
  const bot = runner(issued);
  bot.start(doc([step("a", "test:first"), step("b", "test:second")]));
  await bot.tick();
  assert.deepEqual(asked, ["test:first", "test:second"]);
  assert.deepEqual(issued, [{ kind: "warp", targetID: 7 }]);
  bot.stop();
});

test("⚠ a bot with a startup prefix still asks the plugin's process, never decides in the BFF", async (t) => {
  const asked: string[] = [];
  setRemotePluginDecider(async (macro) => {
    asked.push(macro);
    return { tick: mt({ kind: "warp", targetID: 7 }, { kind: "acting" }) };
  });
  t.after(() => setRemotePluginDecider(null));
  const issued: ScriptAction[] = [];
  const bot = createScriptRunner({
    observe: async () => calm(), issue: async (action) => { issued.push(action); }, registry: { "test:first": stub, "test:second": stub },
    travelHome: home, sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    startup: { logicalRunID: "run", observe: async () => "NEEDED", beforeIssue: async () => {} },
  });
  // A step ahead of a final loop is a startup step (bots/startup.ts).
  bot.start({ ...doc([]), program: [step("a", "test:first"), { id: "l", kind: "loop", repeat: { kind: "forever" }, body: [step("b", "test:second")] }] });
  await bot.tick();
  assert.deepEqual(asked, ["test:first"]);
  assert.deepEqual(issued, [{ kind: "warp", targetID: 7 }]);
  bot.stop();
});

test("⚠ a plugin that cannot answer stops its own bot as any failed block does: home first, then a pause that says why", async (t) => {
  let asks = 0;
  setRemotePluginDecider(async () => {
    asks += 1;
    return { error: "The plugin's server part did not answer in time." };
  });
  t.after(() => setRemotePluginDecider(null));
  const issued: ScriptAction[] = [];
  const bot = createScriptRunner({
    observe: async () => calm(), issue: async (action) => { issued.push(action); }, registry: { "test:first": stub },
    // In space, the first consultation flies; the next finds the ship home.
    travelHome: () => issued.length > 0 ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "warp", targetID: 9 }, { kind: "acting" }),
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
  });
  bot.start(doc([step("a", "test:first")]));
  await bot.tick();
  assert.equal(bot.getStatus(), "running", "a ship in space is not left where it floats");
  assert.deepEqual(issued, [], "nothing of the failed tick is acted on");
  await bot.tick();
  assert.deepEqual(issued, [{ kind: "warp", targetID: 9 }], "it heads home");
  // The runner's usual gap between actions comes before it looks again.
  for (let ticks = 0; ticks < 10 && bot.getStatus() === "running"; ticks++) await bot.tick();
  assert.equal(bot.getStatus(), "paused");
  assert.match(bot.snapshot().pauseReason ?? "", /could not decide its block "test:first": The plugin's server part did not answer in time/);
  assert.equal(asks, 1, "the flight home asks no plugin");
});
