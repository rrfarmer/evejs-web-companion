import test from "node:test";
import assert from "node:assert/strict";

import type { BotLogDraft } from "./botLog.ts";
import { COMPANION_LOG_HEARTBEAT_MS, createCompanionRecorder } from "./companionLog.ts";
import type { CompanionTrace } from "./companionTrace.ts";
import type { FleetCompanionProgress } from "./fleetCompanionLoop.ts";

const RAT = 90000101;

function progress(overrides: Partial<FleetCompanionProgress> = {}): FleetCompanionProgress {
  return {
    status: "running",
    phase: "Obeying fleet",
    action: "wait",
    why: "Shooting the called target.",
    inFleet: true,
    followingOrderFrom: "tag",
    lastOrderHeard: null,
    targetMode: "called",
    canTag: true,
    abandonment: null,
    failureReason: null,
    selfPaused: false,
    ...overrides,
  };
}

function gunsAt(distanceM: number, outOfReach: readonly number[] = []): CompanionTrace {
  return { guns: { targetID: RAT, distanceM, inReach: [1, 2].filter((id) => !outOfReach.includes(id)), assumed: [], outOfReach } };
}

function recorder(): { rec: ReturnType<typeof createCompanionRecorder>; lines: BotLogDraft[]; at: (ms: number) => void } {
  const lines: BotLogDraft[] = [];
  let nowMs = 1_000_000;
  const rec = createCompanionRecorder({ write: (draft) => lines.push(draft) }, () => nowMs);
  rec.start();
  return { rec, lines, at: (ms) => { nowMs = 1_000_000 + ms; } };
}

const decides = (lines: readonly BotLogDraft[]) => lines.filter((line) => line.kind === "decide");

test("the decide line carries the trace and the tick's seq", () => {
  const { rec, lines } = recorder();
  rec.progress(progress({ trace: gunsAt(9_000) }), { seq: 4 });
  const line = decides(lines)[0]!;
  assert.equal(line.seq, 4);
  assert.deepEqual(line.trace, gunsAt(9_000));
  assert.equal(line.heartbeat, undefined);
});

test("only the trace's codes make a new decide line: metres moving do not", () => {
  const { rec, lines } = recorder();
  rec.progress(progress({ trace: gunsAt(9_000) }));
  rec.progress(progress({ trace: gunsAt(8_200) }));
  rec.progress(progress({ trace: gunsAt(7_400) }));
  assert.equal(decides(lines).length, 1, "distance alone is not a change");
  rec.progress(progress({ trace: gunsAt(7_400, [2]) }));
  assert.equal(decides(lines).length, 2, "a gun falling out of reach is");
});

test("force writes the decide line even when nothing changed", () => {
  const { rec, lines } = recorder();
  rec.progress(progress(), { seq: 1, force: true });
  rec.progress(progress(), { seq: 2, force: true });
  rec.progress(progress(), { seq: 3 });
  assert.deepEqual(decides(lines).map((line) => line.seq), [1, 2]);
});

test("a running pilot with nothing new writes a heartbeat after the interval, and not before", () => {
  const { rec, lines, at } = recorder();
  rec.progress(progress({ trace: gunsAt(9_000) }), { seq: 1 });
  at(COMPANION_LOG_HEARTBEAT_MS - 1);
  rec.progress(progress({ trace: gunsAt(8_000) }), { seq: 2 });
  assert.equal(decides(lines).length, 1, "not before");
  at(COMPANION_LOG_HEARTBEAT_MS);
  rec.progress(progress({ trace: gunsAt(7_000) }), { seq: 3 });
  const beat = decides(lines)[1]!;
  assert.equal(beat.heartbeat, true);
  assert.equal(beat.seq, 3);
  assert.equal(beat.why, "Shooting the called target.");
  assert.deepEqual(beat.trace, gunsAt(7_000), "the heartbeat carries the trace as it stands now");
  // The interval restarts from the heartbeat.
  at(COMPANION_LOG_HEARTBEAT_MS + 1_000);
  rec.progress(progress({ trace: gunsAt(7_000) }));
  assert.equal(decides(lines).length, 2);
});

test("no heartbeat for a pilot that is not running", () => {
  const { rec, lines, at } = recorder();
  rec.progress(progress({ status: "paused" }));
  at(COMPANION_LOG_HEARTBEAT_MS * 3);
  rec.progress(progress({ status: "paused" }));
  assert.equal(decides(lines).length, 1);
});

test("issue and result carry the seq; a failed result carries the verdict, a landed one none", () => {
  const { rec, lines } = recorder();
  rec.issue({ kind: "lock", targetID: RAT }, "Obeying fleet", "Locking it.", 7);
  rec.result(false, new Error("TargetNotWithinRangeGeneric"), { seq: 7, verdict: "refused" });
  rec.issue({ kind: "lock", targetID: RAT }, "Obeying fleet", "Locking it.", 8);
  rec.result(true, undefined, { seq: 8, verdict: "uncertain" });
  const [issue1, result1, issue2, result2] = lines.filter((line) => line.kind === "issue" || line.kind === "result");
  assert.equal(issue1!.seq, 7);
  assert.equal(result1!.seq, 7);
  assert.equal(result1!.verdict, "refused");
  assert.equal(issue2!.seq, 8);
  assert.equal(result2!.verdict, undefined);
});
