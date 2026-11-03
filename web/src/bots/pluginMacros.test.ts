// A plugin's block, end to end through every table a core block is in: read
// from a file, checked, priced, offered in the palette, described, born with
// its defaults, given the reads it asked for, and run.
//
// ⚠ ORDER MATTERS IN THIS FILE. The registry is module state and node runs a
// test file in one process, so the "plugin absent" test runs before anything
// registers.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep } from "./botScript.ts";
import { decodeScriptValue } from "./scriptCodec.ts";
import { validateScript } from "./validateScript.ts";
import { analyzeBotRunPolicy, macroRunPolicy } from "./runPolicy.ts";
import { categoriesInUse, macroCatalogList, macroEntry } from "./macroCatalogView.ts";
import { macroName, stepSentence } from "./scriptText.ts";
import { newStepFor } from "./editorDoc.ts";
import { argDescriptorsFor } from "./editorOptions.ts";
import { macroReads } from "./macroReads.ts";
import { pluginDeciders, registerPluginMacro, type PluginMacro } from "./pluginMacros.ts";
import { SCRIPT_MACROS } from "../nav/scriptMacros.ts";
import type { ScriptObservation } from "../nav/scriptConditions.ts";

const step: MacroStep = {
  id: "count",
  kind: "macro",
  macro: "test-plugin:count-colonies",
  args: { seconds: { kind: "count", value: 5 } },
};
const doc: BotScript = {
  format: "evejs-bot-script",
  version: 1,
  name: "Count colonies",
  notes: "",
  home: { entity: "station", id: 60003760, name: "Home", systemName: "Jita" },
  interrupts: [],
  program: [step],
};

const counter: PluginMacro = {
  id: "test-plugin:count-colonies",
  name: "Count the colonies",
  category: "planets",
  does: "Counts the pilot's colonies, then finishes.",
  needs: null,
  spec: { args: [{ key: "seconds", kind: "count", required: true, label: "Seconds to wait" }], untilRequired: false },
  runPolicy: { risks: ["colony"], restartSafe: true },
  reads: ["colonies"],
  decide: (_step, obs, mem) => ({
    action: { kind: "wait" },
    why: `${obs.colonies?.length ?? 0} colonies`,
    phase: "counting",
    armed: false,
    outcome: { kind: "done" },
    nextMem: mem,
  }),
  newArgs: () => ({ seconds: { kind: "count", value: 5 } }),
  sentence: (s) => `Count the colonies for ${s.args["seconds"]?.kind === "count" ? s.args["seconds"].value : "?"} seconds`,
};

test("a script using a block of a plugin this build lacks is refused, naming the plugin", () => {
  const result = decodeScriptValue(doc);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.refusal, /plugin "test-plugin", which this app does not have/);
  assert.equal(macroReads("test-plugin:count-colonies", "colonies"), false);
  assert.throws(() => macroRunPolicy("test-plugin:count-colonies"), /No plugin in this build provides/);
});

test("once its plugin registers it, the block is read, checked, priced, offered, described and run", () => {
  registerPluginMacro(counter);

  const decoded = decodeScriptValue(doc);
  assert.equal(decoded.ok, true);
  assert.deepEqual(validateScript(doc), []);
  assert.deepEqual(validateScript({ ...doc, program: [{ ...step, args: {} }] }).map((p) => p.sentence), ["This step needs seconds to wait."]);
  assert.deepEqual(analyzeBotRunPolicy(doc).riskClasses, ["colony"]);

  const entry = macroCatalogList().find((e) => e.id === step.macro);
  assert.equal(entry?.name, "Count the colonies");
  assert.deepEqual(entry?.params.map((p) => p.label), ["Seconds to wait"]);
  assert.equal(macroEntry(step.macro).category, "planets");
  assert.ok(categoriesInUse().includes("planets"));

  assert.equal(macroName(step.macro), "Count the colonies");
  assert.equal(stepSentence(step), "Count the colonies for 5 seconds");
  assert.deepEqual(newStepFor(step.macro, () => "new").args, { seconds: { kind: "count", value: 5 } });
  assert.deepEqual(argDescriptorsFor(step.macro).required.map((a) => a.label), ["Seconds to wait"]);

  assert.equal(macroReads(step.macro, "colonies"), true);
  assert.equal(macroReads(step.macro, "piLaunches"), false);

  const registry = { ...SCRIPT_MACROS, ...pluginDeciders() };
  const tick = registry[step.macro]!(step, { colonies: [{}, {}] } as unknown as ScriptObservation, {}, {});
  assert.equal(tick.why, "2 colonies");
  assert.throws(() => registerPluginMacro(counter), /already a block/);
});

test("core's blocks keep their own reads", () => {
  assert.equal(macroReads("board-ship", "shipNames"), true);
  assert.equal(macroReads("board-ship", "colonies"), false);
  assert.equal(macroReads("mine-at-belt", "colonies"), false);
  assert.equal(macroReads(null, "colonies"), false);
});
