// Crimewatch's write, made by the page itself (bridge/crimewatchWrites.ts; the plan's Phase 6b).
//
// What has to hold: the safety level is set by the crimewatch service's own call, with the level and nothing
// else; it answers nothing, whatever the server answered; and it fails as the call fails. That the flow makes it
// as a write the page means, and never by its route, is web/src/app/crimewatchFlow.test.ts; that the BFF makes
// such a write only so is test/bridgeSession.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import type { Ask } from "./ask.ts";
import { setSafetyLevel } from "./crimewatchWrites.ts";

test("the safety level is set by crimewatch's own call, with the level and nothing else; it answers nothing, and fails as the call fails", async () => {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push([service, method, args, kwargs]);
    return 2;
  };
  // crimewatchSvc.SetSafetyLevel (343): CharGetCrimewatchLocation().SetSafetyLevel(safetyLevel), for each of the three.
  for (const level of [0, 1, 2] as const) assert.equal(await setSafetyLevel(act, level), undefined, String(level));
  assert.deepEqual(asked, [0, 1, 2].map((level) => ["crimewatch", "SetSafetyLevel", [level], undefined]));
  // A refusal, or a session gone, is the call's own failure: the level is not the level until the call has answered.
  for (const code of ["CALL_REFUSED", "SESSION_CHANGE_IN_PROGRESS", "NO_LIVE_SESSION", "SESSION_NOT_FOUND"]) {
    const failure = Object.assign(new Error("Not now."), { code });
    await assert.rejects(setSafetyLevel(async () => { throw failure; }, 0), (error) => error === failure, code);
  }
});
