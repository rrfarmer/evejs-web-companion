// A planetary launch's record removed, by the page itself (bridge/launchWrites.ts; the plan's Phase 6b).
//
// What has to hold: the record is removed by the planet manager's own call, with the launch's ID and nothing
// else; it answers nothing, whatever the server answered; and it fails as the call fails. That a bot's
// collecting makes it only once the container is seen empty, as a write the page means and never by its route,
// is web/src/app/launchCollectorFlow.test.ts; that the BFF makes such a write only so is test/bridgeSession.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import type { Ask } from "./ask.ts";
import { removeLaunch } from "./launchWrites.ts";

test("a launch's record is removed by the planet manager's own call, with the launch's ID and nothing else; it answers nothing, and fails as the call fails", async () => {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push([service, method, args, kwargs]);
    return true;
  };
  // journal.py 464: sm.RemoteSvc('planetMgr').DeleteLaunch(launchID).
  assert.equal(await removeLaunch(act, 500002), undefined);
  assert.deepEqual(asked, [["planetMgr", "DeleteLaunch", [500002], undefined]]);
  // The server answers false for a launch it would not remove; that is not this call's to read.
  assert.equal(await removeLaunch(async () => false, 500002), undefined);
  for (const code of ["CALL_REFUSED", "CALL_NOT_ALLOWED", "NO_LIVE_SESSION", "SESSION_NOT_FOUND"]) {
    const failure = Object.assign(new Error("Not now."), { code });
    await assert.rejects(removeLaunch(async () => { throw failure; }, 500002), (error) => error === failure, code);
  }
});
