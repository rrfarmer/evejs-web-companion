import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { piHaulBotDoc } from "../app/piDispatch.ts";
import { lastEndedRun } from "../app/piRunOutcome.ts";
import { PROGRAM_DONE_PHASE } from "../nav/scriptDecide.ts";
import type { ServerBot } from "../app/api.ts";
import {
  colonyRunMark,
  leftCollectingStage,
  pauseHint,
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
  // An unknown reason has no fix to offer: the player reads the bot's words.
  assert.equal(view.todo, null);
});

const ISK_REASON = "This pilot does not have enough ISK to pay the customs office's export tax. Add ISK to its wallet and start the haul again.";

test("a paused run whose reason is known says it short, with what to do", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  const watch = watchPoll(startWatch("haul", 0, stages), bot("collect-1"));
  const view = piRunView(watch, bot("collect-1", { status: "paused", why: ISK_REASON }));
  assert.equal(view.tone, "paused");
  assert.equal(view.words, "Paused: The pilot has too little ISK to pay the customs office's export tax.");
  // A server run has no Resume: the fix always ends with Stop and a new start.
  assert.equal(view.todo, "Stop the run, put ISK in the pilot's wallet, then Haul again.");
  // Only a paused run is given a fix; the same words while running are just words.
  assert.equal(piRunView(watch, bot("collect-1", { why: ISK_REASON })).todo, null);
});

test("a restart's refusals point at the Bot Manager's log and say restart, not Haul", () => {
  const hint = pauseHint(
    "restart",
    "2 of 5 extractor restarts did not take - the server refused them. The bot log names the reason.",
  );
  assert.deepEqual(hint, {
    says: "2 of 5 extractor restarts did not take - the server refused them.",
    todo: "The Bot Manager's log for this run has the server's answer. Stop the run, then restart the extractors again once that is sorted.",
  });
  assert.match(pauseHint("restart", "The extractor restarts kept not taking, so the bot stopped.")!.todo, /Bot Manager's log/);
  assert.equal(pauseHint("haul", "Something nobody wrote a hint for."), null);
  assert.equal(pauseHint("haul", null), null);
});

test("every reason with a hint is still said, word for word, by the macros", () => {
  // Reworded there, a reason falls back to the bot's words here: right, but the
  // hint is lost without anyone noticing. This is the noticing.
  const macros = readFileSync(new URL("../nav/scriptMacros.ts", import.meta.url), "utf8");
  for (const said of [
    ISK_REASON,
    "No ship with a planetary commodities hold (an Epithal) is parked at this station.",
    "The trip home failed and the ship docked elsewhere for safety. Dock at home before boarding the planetary hauler.",
  ]) {
    assert.ok(macros.includes(`"${said}"`), said);
    assert.notEqual(pauseHint("haul", said), null, said);
  }
  // The two matched by their ending, as the template literals write them.
  assert.ok(macros.includes(". The bot log names the reason.`"));
  assert.ok(macros.includes(' kept not taking, so the bot stopped."'));
});

test("a run that drops off the roster is ending until its owner's read answers", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  let watch = watchPoll(startWatch("haul", 0, stages), bot("unload"));
  watch = watchPoll(watch, null);
  assert.equal(watch.ending, true);
  assert.equal(piRunView(watch, null).over, false);
  assert.match(piRunView(watch, null).words, /Looking up how it went/);

  const finished = piRunView(watchEnded(watch, { status: "stopped", why: "The program finished, so the bot stopped.", finished: true }), null);
  assert.equal(finished.tone, "done");
  assert.ok(finished.stages.every((stage) => stage.state === "done"));
  assert.equal(finished.over, true);

  const stopped = piRunView(watchEnded(watch, { status: "stopped", why: "The approved run time ended, so the server stopped this bot.", finished: false }), null);
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
  watch = watchEnded(watchPoll(watch, null), { status: "stopped", why: null, finished: true });
  assert.equal(piRunView(watch, null).words, "The restart finished. The colonies are read again.");
});

test("the owner's list answers with the pilot's latest ENDED run", () => {
  const row = (over: Partial<ServerBot>): ServerBot => ({
    characterID: 90000001, status: "idle", why: null, pauseReason: null, endedAt: null, ...over,
  } as ServerBot);
  const bots = [
    row({ status: "error", why: "Older.", endedAt: "2026-11-01T10:00:00.000Z" }),
    row({ status: "stopped", phase: "Finished", why: "Newer.", endedAt: "2026-11-01T12:00:00.000Z" }),
    row({ status: "running", endedAt: null }),
    row({ characterID: 90000002, status: "stopped", endedAt: "2026-11-01T13:00:00.000Z" }),
  ];
  assert.deepEqual(lastEndedRun(bots, 90000001), { status: "stopped", why: "Newer.", finished: true });
  assert.equal(lastEndedRun(bots, 90000003), null);
});

test("a run that reached its program's end is finished; a Stop click and a problem are not", () => {
  const ended = (over: Partial<ServerBot>): ServerBot => ({
    characterID: 90000001, status: "stopped", phase: null, why: null, pauseReason: null,
    endedAt: "2026-11-01T12:00:00.000Z", ...over,
  } as ServerBot);
  // As the runner leaves a finished program (nav/scriptRunner.ts: done is "stopped", in the done phase).
  const done = lastEndedRun([ended({ phase: PROGRAM_DONE_PHASE, why: "The program finished, so the bot stopped." })], 90000001);
  assert.equal(done?.finished, true);
  assert.equal(PROGRAM_DONE_PHASE, "Finished");
  // A Stop click mid-run ends "stopped" in whatever phase it was in.
  assert.equal(lastEndedRun([ended({ phase: "Recalling drones", why: "Stopping after controlled drones return." })], 90000001)?.finished, false);
  // A problem, and a pilot that went offline (an "idle" slice), are never finished.
  assert.equal(lastEndedRun([ended({ status: "error", phase: PROGRAM_DONE_PHASE })], 90000001)?.finished, false);
  assert.equal(lastEndedRun([ended({ status: "idle" })], 90000001)?.finished, false);

  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  const atUnload = watchPoll(watchPoll(startWatch("haul", 0, stages), bot("unload")), null);
  const view = piRunView(watchEnded(atUnload, done), null);
  assert.equal(view.tone, "done");
  assert.equal(view.words, "The haul finished. The colonies are read again.");
  assert.ok(view.stages.every((stage) => stage.state === "done"));
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
  const stopped = watchEnded(watchPoll(watch, null), { status: "stopped", why: null, finished: false });
  assert.equal(colonyRunMark(stopped, 40000001, 30000001), "collected");
  assert.equal(colonyRunMark(stopped, 40000003, 30000002), "missed");
  // A run that finished collected every colony it was started for.
  const finished = watchEnded(watchPoll(watch, null), { status: "stopped", why: null, finished: true });
  assert.equal(colonyRunMark(finished, 40000003, 30000002), "collected");
  // A restart marks no colony.
  assert.equal(colonyRunMark(startWatch("restart", 0), 40000001, 30000001), null);
});

test("leaving a system the haul collected in is the moment to read the pilot's colonies again", () => {
  const stages = piHaulStages(piHaulBotDoc(COLONIES, null));
  const atAlpha = watchPoll(startWatch("haul", 0, stages, [40000001, 40000003]), bot("collect-1"));
  // Launch to Board, or within Alpha: no collecting stage has been left.
  const boarding = watchPoll(startWatch("haul", 0, stages), bot("board-hauler"));
  assert.equal(leftCollectingStage(watchPoll(startWatch("haul", 0, stages), bot("launch")), boarding), false);
  assert.equal(leftCollectingStage(atAlpha, watchPoll(atAlpha, bot("launches-1"))), false);
  // Alpha to Beta: Alpha's launchpads were emptied.
  assert.equal(leftCollectingStage(atAlpha, watchPoll(atAlpha, bot("fly-2"))), true);
  // A poll that skipped straight from Board past Alpha still counts.
  assert.equal(leftCollectingStage(boarding, watchPoll(boarding, bot("collect-2"))), true);
  // Beta to Unload as well.
  const atBeta = watchPoll(atAlpha, bot("collect-2"));
  assert.equal(leftCollectingStage(atBeta, watchPoll(atBeta, bot("deliver"))), true);
});
