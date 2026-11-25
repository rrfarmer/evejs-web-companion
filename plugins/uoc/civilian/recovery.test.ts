import test from "node:test";
import assert from "node:assert/strict";
import { bindCivilianScope, registerCivilianRecovery, continueCivilianOwner } from "./recovery.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
test("Continue delegates to the exact original paused executor without acquiring or replacing a session", async () => {
  let resumed = 0;
  const run = { botID: "same-owner" } as PluginRunContext,
    row: any = {
      botID: run.botID,
      characterID: 7,
      owner: "pilot",
      worldID: "world",
      kind: "mining",
    };
  bindCivilianScope(run, () => row);
  const release = registerCivilianRecovery(
    run,
    async () => ({}),
    async () => {
      resumed++;
    },
  );
  try {
    await continueCivilianOwner(row);
    assert.equal(resumed, 1);
    await assert.rejects(continueCivilianOwner({ ...row, owner: "other" }));
    await assert.rejects(continueCivilianOwner({ ...row, worldID: "other" }));
    assert.equal(resumed, 1);
  } finally {
    release();
  }
  await assert.rejects(continueCivilianOwner(row));
});
