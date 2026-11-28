"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createStartupRuns } = require("./startupRuns");
const identity = { accountID: 7, characterID: 10, scriptHash: "a".repeat(64), scriptRev: 1 };
function disk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-operation-startup-"));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "startup.json");
}

test("ordinary Startup records its completed step and MAIN cursor across restart", async t => {
  const filePath = disk(t);
  const runs = createStartupRuns({ filePath });
  const setup = { id: "undock", kind: "macro", macro: "undock", args: {} };
  const script = runs.open({ ...identity, steps: [setup], prefixLength: 1,
    program: [setup, { kind: "loop", body: [{ kind: "macro" }] }],
    adapters: { postcondition: () => true, actionSupported: () => true } });
  const memory = { position: { kind: "loop", node: 1, body: 0 }, board: {}, macroMem: {}, loopPass: 0,
    stepTicks: 0, cannotTellStreak: 0, latched: null };
  assert.equal(await script.observe(setup, { flightStatus: { shipID: 50, docked: false } }), "COMPLETE");
  await script.checkpoint(memory);
  const row = createStartupRuns({ filePath }).get(script.logicalRunID);
  assert.equal(row.mainEntered, true); assert.equal(row.blocks.undock.state, "COMPLETE");
});
