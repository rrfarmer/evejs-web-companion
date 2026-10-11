// Every action a bot can decide on has a case where the page carries actions
// out. An action with a sentence in the log (nav/botLog.test.ts holds that) and
// no case here would be logged as issued and do nothing: a launch's own warp
// was added on 2026-10-09 with no test that would have noticed it missing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The action kinds the union itself declares, read out of the source. */
function unionKinds(): readonly string[] {
  const source = readFileSync(fileURLToPath(new URL("../nav/scriptDecide.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export type ScriptAction =");
  assert.ok(start >= 0, "the action union moved");
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  return [...new Set([...body.matchAll(/readonly kind: "([a-zA-Z]+)"/g)].map((match) => match[1] as string))];
}

test("every action the union declares has a case where the page carries actions out", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const kinds = unionKinds();
  assert.ok(kinds.length > 60, `the union read as ${kinds.length} kinds, which is too few to be it`);
  const missing = kinds.filter((kind) => !flow.includes(`case "${kind}":`));
  assert.deepEqual(missing, [], "these actions are decided on and never carried out");
});

test("a launch's warp is carried out as the launch's own warp", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const at = flow.indexOf('case "warpLaunch":');
  assert.ok(at >= 0);
  assert.match(flow.slice(at, at + 160), /^case "warpLaunch":\s+await api\.warpToLaunch\(action\.launchID, callOptions\);\s+return;/);
});

test("a launchpad sent up at its office is carried out by the customs office's own transfer, and the colonies are read while offices are collected from", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  const at = flow.indexOf('case "exportCustoms":');
  assert.ok(at >= 0);
  assert.match(flow.slice(at, at + 220), /^case "exportCustoms":\s+await api\.exportToCustomsOffice\(action\.officeID, action\.pinID, action\.commodities, callOptions\);\s+return;/);
  // The block needs what each launchpad holds, so the read that gives it runs for this block too.
  assert.match(flow, /if \(macro === "restart-extractors" \|\| macro === "launch-commodities" \|\| macro === "collect-customs"\) \{/);
});

test("an align is carried out by the page's own call wherever the page carries a bot's actions out, and before a recall's warp home", () => {
  const flow = readFileSync(fileURLToPath(new URL("./flow.ts", import.meta.url)), "utf8");
  // The fleet companion's actions and a script bot's: two places, and the same call in each.
  assert.equal(flow.split('case "align":').length - 1, 2);
  assert.equal([...flow.matchAll(/case "align":\s+await alignShip\(action\.targetID\);\s+return;/g)].length, 2);
  // Drones called home before a dock: the ship is aligned out while they come, and a refusal is let go.
  assert.equal(flow.split("await alignShip(best.itemID).catch(() => {});").length - 1, 1);
  // The route's asker is gone from the flow, and from the page's askers.
  assert.equal(flow.includes("api.alignTo("), false);
  const api = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
  assert.equal(api.includes("/api/bridge/flight/align"), false);
});
