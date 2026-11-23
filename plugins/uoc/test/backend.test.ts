import assert from "node:assert/strict";
import test from "node:test";
import { civilianMiningPlan, civilianMiningRun, decodeCivilianMiningSetup } from "../backend.ts";

test("bounded mission setup is strict and canonical", async () => {
  const input = { missionCount: 1, agent: { maxJumps: 10, corporationID: null, level: 2, levelRule: "max", mode: "auto" } };
  const decoded = decodeCivilianMiningSetup(input);
  assert.deepEqual(decoded, { agent: { mode: "auto", levelRule: "max", level: 2, corporationID: null, maxJumps: 10 }, missionCount: 1 });
  assert.equal((await civilianMiningRun.check(input)).ok, true);
  assert.equal(decodeCivilianMiningSetup({...input,missionCount:2})?.missionCount,2);
  for (const bad of [
    { ...input, missionCount: 0 }, { ...input, missionCount: 501 }, { ...input, extra: true },
    { ...input, agent: { ...input.agent, maxJumps: 0 } },
    { ...input, agent: { ...input.agent, level: 5 } },
    { agent: { mode: "manual", agentID: -1 }, missionCount: 1 },
  ]) assert.equal(decodeCivilianMiningSetup(bad), null);
});

test("manual and automatic plans use the plugin's own blocks", () => {
  const manual = civilianMiningPlan({ agent: { mode: "manual", agentID: 42 }, missionCount: 1 });
  assert.deepEqual(manual.program.map(row => row.kind === "macro" ? row.macro : null), ["uoc:mine-mission"]);
  const auto = civilianMiningPlan({ agent: { mode: "auto", levelRule: "max", level: 3, corporationID: 8, maxJumps: 7 }, missionCount: 1 });
  assert.deepEqual(auto.program.map(row => row.kind === "macro" ? row.macro : null), ["uoc:find-mining-agent", "uoc:mine-mission"]);
  const first = auto.program[0];
  assert.ok(first && first.kind === "macro");
  assert.deepEqual(first.args.fallback, { kind: "toggle", enabled: true });
});
