import test from "node:test";
import assert from "node:assert/strict";

import { piHaulBotDoc } from "../app/piDispatch.ts";
import { lastEndedRun } from "../app/piRunOutcome.ts";
import type { ServerBot } from "../app/api.ts";
import {
  colonyRunMark,
  piHaulStages,
  piRunView,
  startWatch,
  watchEnded,
  watchPoll,
  type PiRunBot,
} from "./piRunProgress.ts";

const COLONIES = [
  { planetID: 40000001, planetName: "Alpha I", solarSystemID: 30000001, solarSystemName: "Alpha" },
  { planetID: 40000002, planetName: "Alpha II", solarSystemID: 30000001, solarSystemName: "Alpha" },
  { planetID: 40000003, planetName: "Beta IV", solarSystemID: 30000002, solarSystemName: "Beta" },
];
const DELIVER = { entity: "station" as const, id: 60000001, name: "Gamma - Station", systemName: "Gamma" };

const bot = (stepPath: string | null, over: Partial<PiRunBot> = {}): PiRunBot =>
  ({ status: "running", phase: "Working", why: "Flying.", stepPath, ...over });

test("a haul's stages are its route: launch, board, each system once, unload, home", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null, DELIVER));
  assert.deepEqual(stages.map((stage) => stage.label), ["Launch", "Board", "Alpha", "Beta", "Unload", "Home"]);
  assert.deepEqual(stages[2]!.stepIDs, ["fly-1", "collect-1", "launches-1"]);
  // A collecting stage knows its system, so a colony row can find its stage.
  assert.equal(stages[2]!.solarSystemID, 30000001);
  assert.equal(stages[0]!.solarSystemID, undefined);
  // Getting back into the first ship is one tick: it rides on the last stage.
  assert.deepEqual(stages[5]!.stepIDs, ["home", "board-back"]);
});

test("without a Deliver-to station there is no Home stage; board-back joins Unload", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES.slice(0, 1), null));
  assert.deepEqual(stages.map((stage) => stage.label), ["Launch", "Board", "Alpha", "Unload"]);
  assert.deepEqual(stages[3]!.stepIDs, ["deliver", "unload", "board-back"]);
});

test("the stepper follows the step the server reports, and never moves back", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null, DELIVER));
  let watch = startWatch("haul", 0, stages);
  assert.equal(piRunView(watch, null).words, "Starting on the server...");
  watch = watchPoll(watch, bot("collect-2"));
  const view = piRunView(watch, bot("collect-2", { why: "Collecting from the customs office." }));
  assert.deepEqual(view.stages.map((stage) => stage.state), ["done", "done", "done", "current", "todo", "todo"]);
  assert.equal(view.words, "Collecting from the customs office.");
  // A step outside the route (an interrupt, a null path) keeps the last stage.
  watch = watchPoll(watch, bot(null));
  assert.equal(watch.reached, 3);
});

test("a paused run says so, in the bot's own words", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  const watch = watchPoll(startWatch("haul", 0, stages), bot("board-hauler"));
  const view = piRunView(watch, bot("board-hauler", { status: "paused", why: "No ship with a planetary hold is parked here." }));
  assert.equal(view.tone, "paused");
  assert.equal(view.words, "Paused: No ship with a planetary hold is parked here.");
});

test("a run that drops off the roster is ending until its owner's read answers", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  let watch = watchPoll(startWatch("haul", 0, stages), bot("unload"));
  watch = watchPoll(watch, null);
  assert.equal(watch.ending, true);
  assert.equal(piRunView(watch, null).over, false);
  assert.match(piRunView(watch, null).words, /Looking up how it went/);

  const finished = piRunView(watchEnded(watch, { status: "idle", why: "The program finished, so the bot stopped." }), null);
  assert.equal(finished.tone, "done");
  assert.ok(finished.stages.every((stage) => stage.state === "done"));
  assert.equal(finished.over, true);

  const stopped = piRunView(watchEnded(watch, { status: "stopped", why: "The approved run time ended, so the server stopped this bot." }), null);
  assert.equal(stopped.tone, "stopped");
  assert.equal(stopped.words, "The haul stopped at Unload: The approved run time ended, so the server stopped this bot.");
  assert.equal(stopped.stages[4]!.state, "stopped");

  const unread = piRunView(watchEnded(watch, null), null);
  assert.equal(unread.tone, "ended");
  assert.equal(unread.words, "The haul has ended. The Bot Manager says how it went.");
});

test("a start the roster has not shown yet is not mistaken for an ended run", () => {
  const watch = startWatch("restart", 0);
  assert.equal(watchPoll(watch, null), watch);
});

test("a restart has no stages, only its words and how it ended", () => {
  let watch = watchPoll(startWatch("restart", 0), bot("restart-extractors", { why: "Restarting extractors on Alpha I." }));
  assert.deepEqual(piRunView(watch, bot("restart-extractors", { why: "Restarting extractors on Alpha I." })).stages, []);
  watch = watchEnded(watchPoll(watch, null), { status: "idle", why: null });
  assert.equal(piRunView(watch, null).words, "The restart finished. The colonies are read again.");
});

test("the owner's list answers with the pilot's latest ENDED run", () => {
  const row = (over: Partial<ServerBot>): ServerBot => ({
    characterID: 90000001, status: "idle", why: null, pauseReason: null, endedAt: null, ...over,
  } as ServerBot);
  const bots = [
    row({ status: "error", why: "Older.", endedAt: "2026-11-01T10:00:00.000Z" }),
    row({ status: "idle", why: "Newer.", endedAt: "2026-11-01T12:00:00.000Z" }),
    row({ status: "running", endedAt: null }),
    row({ characterID: 90000002, status: "stopped", endedAt: "2026-11-01T13:00:00.000Z" }),
  ];
  assert.deepEqual(lastEndedRun(bots, 90000001), { status: "idle", why: "Newer." });
  assert.equal(lastEndedRun(bots, 90000003), null);
});

test("each hauled colony says where the run is with it, by its system's stage", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  // Alpha I and Beta IV are in the run; Alpha II is not.
  let watch = watchPoll(startWatch("haul", 0, stages, [40000001, 40000003]), bot("collect-1"));
  assert.equal(colonyRunMark(watch, 40000001, 30000001), "collecting");
  assert.equal(colonyRunMark(watch, 40000003, 30000002), "queued");
  assert.equal(colonyRunMark(watch, 40000002, 30000001), null);
  watch = watchPoll(watch, bot("fly-2"));
  assert.equal(colonyRunMark(watch, 40000001, 30000001), "collected");
  assert.equal(colonyRunMark(watch, 40000003, 30000002), "collecting");
  // Stopped before reaching Beta: Beta's colony was not collected.
  const stopped = watchEnded(watchPoll(watch, null), { status: "stopped", why: null });
  assert.equal(colonyRunMark(stopped, 40000001, 30000001), "collected");
  assert.equal(colonyRunMark(stopped, 40000003, 30000002), "missed");
  // A run that finished collected every colony it was started for.
  const finished = watchEnded(watchPoll(watch, null), { status: "idle", why: null });
  assert.equal(colonyRunMark(finished, 40000003, 30000002), "collected");
  // A restart marks no colony.
  assert.equal(colonyRunMark(startWatch("restart", 0), 40000001, 30000001), null);
});
