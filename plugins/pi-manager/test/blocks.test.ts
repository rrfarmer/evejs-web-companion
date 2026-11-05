// The PI blocks as the bot builder and the launch grant see them: priced and
// described from the plugin's own definitions (moved from core's
// runPolicy.test.ts and scriptText.test.ts with the blocks).

import test from "node:test";
import assert from "node:assert/strict";

import "./harness.ts";
import type { BotScript, MacroStep } from "../../../web/src/bots/botScript.ts";
import { analyzeBotRunPolicy, macroRunPolicy } from "../../../web/src/bots/runPolicy.ts";
import { stepSentence } from "../../../web/src/bots/scriptText.ts";
import { decodeScriptValue } from "../../../web/src/bots/scriptCodec.ts";

function step(macro: MacroStep["macro"]): MacroStep {
  return { id: "s", kind: "macro", macro, args: {} };
}

function script(program: readonly MacroStep[]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null }, interrupts: [], program,
  };
}

// launch-commodities changes a colony's command centre AND spends money (the
// server debits planetary export tax on every launch) — both risks are real,
// and neither is a re-read-and-confirm the way unload-cargo's is, so a resumed
// process must not replay it blind.
test("launching from a command centre is colony and financial risk, and not restart-safe", () => {
  const entry = macroRunPolicy("pi-manager:launch-commodities");
  assert.deepEqual([...entry.risks].sort(), ["colony", "financial"]);
  assert.equal(entry.restartSafe, false);

  const result = analyzeBotRunPolicy(script([step("pi-manager:launch-commodities")]));
  assert.deepEqual(result.riskClasses, ["financial", "colony"]);
  assert.equal(result.restartSafe, false);
  assert.deepEqual(result.restartBlockers, ["pi-manager:launch-commodities"]);
});

test("a launch step promises the threshold the block will actually use", () => {
  const at = (args: MacroStep["args"]): string =>
    stepSentence({ id: "s1", kind: "macro", macro: "pi-manager:launch-commodities", args });

  // Unset is the shipped default, said out loud rather than left implied.
  assert.match(at({}), /once it is 80% full/);
  assert.match(at({ fullPercent: { kind: "count", value: 50 } }), /once it is 50% full/);

  // ⚠ NOTHING BOUNDS A count ARG. validateScript bounds loop repeats and
  // nothing else, so a player can type these — and the sentence must say what
  // the decider will do with them, not repeat the number back. A block whose
  // own description disagrees with its behaviour is the defect here.
  assert.match(at({ fullPercent: { kind: "count", value: 500 } }), /once it is 100% full/);
  assert.match(at({ fullPercent: { kind: "count", value: 0 } }), /once it is 1% full/);
  assert.match(at({ fullPercent: { kind: "count", value: -20 } }), /once it is 1% full/);

  assert.match(at({ anyAmount: { kind: "toggle", enabled: true } }), /Launch whatever the command centre holds/);
  assert.match(at({ anyAmount: { kind: "toggle", enabled: false } }), /once it is 80% full/);
  assert.match(at({ fullPercent: { kind: "count", value: 50 }, anyAmount: { kind: "toggle", enabled: false } }), /once it is 50% full/);
  assert.match(at({ fullPercent: { kind: "count", value: 50 }, anyAmount: { kind: "toggle", enabled: true } }), /Launch whatever the command centre holds/);
});

test("a script saved with the blocks' old core ids is read as the plugin's blocks", () => {
  const old = { ...script([]), program: [{ id: "r", kind: "macro", macro: "restart-extractors", args: {} }, { id: "b", kind: "macro", macro: "board-planetary-hauler", args: {} }] };
  const decoded = decodeScriptValue(old);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.ok ? decoded.doc.program.map((node) => node.kind === "macro" ? node.macro : null) : [], ["pi-manager:restart-extractors", "pi-manager:board-hauler"]);
});

// The office's export tax comes out of the wallet (the block stops on a refusal
// to pay), so the grant must say so. A replay re-reads the pads and pays nothing twice.
test("collecting from the customs offices is financial risk too, and restart-safe", () => {
  const entry = macroRunPolicy("pi-manager:collect-customs");
  assert.ok(entry.risks.includes("financial"));
  assert.equal(entry.restartSafe, true);
});
