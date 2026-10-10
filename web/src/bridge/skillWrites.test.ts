// The skill queue's writes, made by the page itself (bridge/skillWrites.ts; the plan's Phase 6b).
//
// What has to hold: the pause is the handler's own call, with nothing, and it answers and fails as that call
// does. That the flow makes it as a write the page means, and never by its route, is
// web/src/app/skillsFlow.test.ts; that the BFF makes such a write only so is test/bridgeSession.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import type { Ask } from "./ask.ts";
import { applyFreePoints, pauseTraining, saveQueue } from "./skillWrites.ts";

test("the pause of training is the skill handler's own call, with nothing; it answers nothing, and fails as the call fails", async () => {
  const asked: string[] = [];
  const act: Ask = async (service, method, args) => {
    asked.push(`${service}.${method}(${JSON.stringify(args).slice(1, -1)})`);
    return null;
  };
  assert.equal(await pauseTraining(act), undefined);
  assert.deepEqual(asked, ["skillHandler.AbortTraining()"]);
  // Whatever the server answered is not the pause's to hand on: the sheet read afterwards says what is so.
  assert.equal(await pauseTraining(async () => 5), undefined);
  const refused = Object.assign(new Error("NotNow"), { code: "CALL_REFUSED" });
  await assert.rejects(pauseTraining(async () => { throw refused; }), (error) => error === refused);
});

test("a queue is saved whole by the handler's own call: each skill by its place from nought, and started or not as it is told", async () => {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push([service, method, args, kwargs]);
    return null;
  };
  assert.equal(await saveQueue(act, [{ typeID: 3300, toLevel: 5 }, { typeID: 3327, toLevel: 4 }, { typeID: 3300, toLevel: 4 }], true), true);
  // skillQueueSvc.CommitTransaction: SaveNewQueue({0: (3300, 5), 1: (3327, 4), 2: (3300, 4)}, activate=True).
  assert.deepEqual(asked, [["skillHandler", "SaveNewQueue", [{ type: "dict", entries: [[0, [3300, 5]], [1, [3327, 4]], [2, [3300, 4]]] }], { activate: true }]]);
  // An empty list is the queue emptied: the same call, with nothing in it.
  asked.length = 0;
  assert.equal(await saveQueue(act, [], true), true);
  assert.deepEqual(asked, [["skillHandler", "SaveNewQueue", [{ type: "dict", entries: [] }], { activate: true }]]);
  // Saved unstarted where it is told so: the same queue, and activate=False.
  asked.length = 0;
  assert.equal(await saveQueue(act, [{ typeID: 3300, toLevel: 5 }], false), true);
  assert.deepEqual(asked, [["skillHandler", "SaveNewQueue", [{ type: "dict", entries: [[0, [3300, 5]]] }], { activate: false }]]);
  // Whatever the server answered is not the save's to hand on.
  assert.equal(await saveQueue(async () => 5, [], true), true);
});

test("a save the pilot's transport does not carry was not made, and says so; any other failure is the call's own", async () => {
  const notCarried = Object.assign(new Error("skillHandler.SaveNewQueue is not on the web-call allowlist."), { code: "CALL_NOT_ALLOWED", status: 403 });
  assert.equal(await saveQueue(async () => { throw notCarried; }, [{ typeID: 3300, toLevel: 5 }], true), false);
  for (const code of ["CALL_REFUSED", "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE", "NO_LIVE_SESSION", "SESSION_NOT_FOUND", "BRIDGE_NETWORK_ERROR"]) {
    const failure = Object.assign(new Error("QueueTooManySkills"), { code });
    await assert.rejects(saveQueue(async () => { throw failure; }, [], true), (error) => error === failure, code);
  }
  // What carries no code is no word that the call is not carried.
  const bare = new Error("CALL_NOT_ALLOWED");
  await assert.rejects(saveQueue(async () => { throw bare; }, [], false), (error) => error === bare);
});

test("free points are put into a skill by the handler's own call, with the skill and the points; it answers what the handler answers, and fails as the call fails", async () => {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push([service, method, args, kwargs]);
    return 3800;
  };
  // skillsvc.ApplyFreeSkillPoints (886): ApplyFreeSkillPoints(skillTypeID, pointsToApply), and what it answers is the free points left.
  assert.equal(await applyFreePoints(act, 3327, 1200), 3800);
  assert.deepEqual(asked, [["skillHandler", "ApplyFreeSkillPoints", [3327, 1200], undefined]]);
  // Whatever the handler answers is handed on as it came: what it means is the caller's to read.
  assert.equal(await applyFreePoints(async () => null, 3327, 1200), null);
  // A refusal, or a transport that does not carry the call, is the call's own failure: there is no other way to ask.
  for (const code of ["CALL_REFUSED", "CALL_NOT_ALLOWED", "NO_LIVE_SESSION", "SESSION_NOT_FOUND"]) {
    const failure = Object.assign(new Error("CannotApplyFreePointsWhileTrainingSkill"), { code });
    await assert.rejects(applyFreePoints(async () => { throw failure; }, 3327, 1200), (error) => error === failure, code);
  }
});
