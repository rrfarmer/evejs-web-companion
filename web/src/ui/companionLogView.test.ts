// The companion log viewer's pure half: trace summary, grouping by seq, filter.

import test from "node:test";
import assert from "node:assert/strict";

import { buildLogView, clockOf, matchesFilter, parseLogLines, traceSummary } from "./companionLogView.ts";
import type { BotLogEntry } from "../nav/botLog.ts";
import type { CompanionTrace } from "../nav/companionTrace.ts";

function line(over: Partial<BotLogEntry> & Pick<BotLogEntry, "kind">): BotLogEntry {
  return { t: "2026-10-13T12:34:56.789Z", run: "r1", characterID: 90000001, ...over };
}

const FULL_TRACE: CompanionTrace = {
  combat: {
    mode: "auto",
    outcome: "orbit-optimal",
    targetID: 5001,
    distanceM: 12000,
    holdOrder: "orbit",
    holdRangeM: 9000,
    standingRangeM: 9000,
    floorM: null,
    ceilingM: null,
    far: true,
    farTicks: 2,
    spentAtM: null,
    leashed: false,
    leashApartM: null,
    ratFactsMissing: false,
    reissueSuppressed: false,
    latch: null,
  },
  guns: { targetID: 5001, distanceM: 12000, inReach: [1], assumed: [2], outOfReach: [3] },
  props: { want: true, because: "closing", withheld: null },
  ammo: {
    skipped: null,
    targetID: 5001,
    distanceM: 12000,
    nextTargetMoment: false,
    canClose: true,
    units: [
      { leadID: 1, code: "persisting", loadedTypeID: 10, wantedTypeID: 11, wantedTicks: 1, pending: false },
      { leadID: 2, code: "persisting", loadedTypeID: 10, wantedTypeID: 11, wantedTicks: 1, pending: false },
    ],
  },
  util: { skipped: [{ moduleID: 7, family: "web", code: "out-of-optimal" }], gaveUp: [] },
};

test("traceSummary renders every rung on one line", () => {
  assert.equal(
    traceSummary(FULL_TRACE),
    "combat: orbit-optimal 12.0 km, closing | guns 2/3 (1 assumed) | props: closing | ammo: persisting | util: web out-of-optimal",
  );
});

test("traceSummary only speaks for the rungs that wrote a slice", () => {
  assert.equal(traceSummary({ props: { want: false, because: "none", withheld: "cap-floor" } }), "props: none (withheld: cap-floor)");
  assert.equal(traceSummary({}), "");
  assert.equal(traceSummary(null), "");
  assert.equal(traceSummary(undefined), "");
});

test("traceSummary says how hurt a health hold was, against what, and whether anything was repairing it", () => {
  assert.equal(
    traceSummary({ health: { code: "rejoin-under-mark", tank: 0.42, layer: "armor", floor: 0.3, mark: 0.5, repairer: "fitted" } }),
    "health: rejoin-under-mark armor 42% (floor 30%, mark 50%), repairer fitted",
  );
});

test("traceSummary covers skipped ammo, gave-up utilities, short distances and cleared latches", () => {
  const summary = traceSummary({
    combat: { ...FULL_TRACE.combat!, outcome: "no-reach", distanceM: 850, far: false, leashed: true },
    ammo: { ...FULL_TRACE.ammo!, skipped: "no-cargo", units: [] },
    util: { skipped: [], gaveUp: [{ moduleID: 7, family: "painter", what: "start" }] },
    cleared: { by: "orbit", follow: true, hold: true },
  });
  assert.equal(
    summary,
    "combat: no-reach 850 m, leashed | ammo: skipped, no-cargo | util: painter gave up start | cleared: orbit (follow+hold)",
  );
  assert.equal(traceSummary({ util: { skipped: [], gaveUp: [] } }), "util: none");
});

test("traceSummary caps a long list of codes", () => {
  const units = ["swap", "load", "cooldown", "gun-empty", "already-best"].map((code, i) => ({
    leadID: i,
    code: code as "swap",
    loadedTypeID: null,
    wantedTypeID: null,
    wantedTicks: 0,
    pending: false,
  }));
  assert.equal(traceSummary({ ammo: { ...FULL_TRACE.ammo!, units } }), "ammo: swap, load, cooldown +2");
});

test("clockOf is HH:MM:SS of the ISO string, UTC, and never throws", () => {
  assert.equal(clockOf("2026-10-13T01:02:03.456Z"), "01:02:03");
  assert.equal(clockOf("not a time"), "not a time");
});

test("parseLogLines keeps only well-formed lines", () => {
  const good = line({ kind: "start" });
  const kept = parseLogLines([good, null, 3, "x", { t: "2026-10-13T00:00:00Z" }, { t: "x", kind: "bogus" }, { t: "x", kind: "end" }]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], good);
});

test("rows are newest first, with a tick's lines kept in the order they happened", () => {
  const entries = [
    line({ kind: "start", script: "fleet-companion" }),
    line({ kind: "decide", seq: 1, phase: "Fighting", why: "Engaging", trace: FULL_TRACE }),
    line({ kind: "issue", seq: 1, says: "orbit 5001 at 9000m", observeMs: 12 }),
    line({ kind: "result", seq: 1, ok: true, callMs: 40 }),
    line({ kind: "decide", seq: 2, phase: "Fighting", why: "Still engaging" }),
  ];
  const view = buildLogView(entries);
  assert.deepEqual(
    view.rows.map((row) => row.index),
    [4, 1, 2, 3, 0],
  );
  assert.deepEqual(
    view.rows.map((row) => [row.inGroup, row.groupStart]),
    [
      [false, true],
      [true, true],
      [true, false],
      [true, false],
      [false, true],
    ],
  );
  assert.equal(view.total, 5);
  assert.equal(view.hidden, 0);
  assert.equal(view.rows[1]!.summary, traceSummary(FULL_TRACE));
  assert.equal(view.rows[1]!.time, "12:34:56");
  assert.equal(view.rows[2]!.text, "orbit 5001 at 9000m (read 12 ms)");
  assert.equal(view.rows[3]!.text, "ok (40 ms)");
  assert.equal(view.rows[4]!.text, "start: fleet-companion");
});

test("the same seq in a different run is a different group", () => {
  const view = buildLogView([
    line({ kind: "decide", seq: 1, run: "a", why: "one" }),
    line({ kind: "decide", seq: 1, run: "b", why: "two" }),
  ]);
  assert.deepEqual(
    view.rows.map((row) => row.inGroup),
    [false, false],
  );
});

test("a refusal reads as a refusal, with its verdict and tone", () => {
  const view = buildLogView([
    line({ kind: "result", seq: 3, ok: false, refusal: "TARGET_OUT_OF_RANGE", verdict: "refused" }),
    line({ kind: "result", seq: 4, ok: false, refusal: "timeout", verdict: "uncertain" }),
    line({ kind: "result", seq: 5, ok: false }),
    line({ kind: "result", seq: 6, ok: true }),
  ]);
  const byIndex = new Map(view.rows.map((row) => [row.index, row]));
  assert.equal(byIndex.get(0)!.text, "refused: TARGET_OUT_OF_RANGE");
  assert.equal(byIndex.get(0)!.tone, "bad");
  assert.equal(byIndex.get(1)!.text, "uncertain: timeout");
  assert.equal(byIndex.get(1)!.tone, "warn");
  assert.equal(byIndex.get(2)!.text, "refused: refused");
  assert.equal(byIndex.get(3)!.tone, "good");
});

test("heartbeat lines are flagged, and the word finds them", () => {
  const view = buildLogView([line({ kind: "decide", why: "Idle", heartbeat: true }), line({ kind: "decide", why: "Idle" })], "heartbeat");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]!.heartbeat, true);
});

test("the filter narrows by every term, in any case, across the summary too", () => {
  const entries = [
    line({ kind: "decide", seq: 1, phase: "Fighting", why: "Engaging", trace: FULL_TRACE }),
    line({ kind: "decide", seq: 2, phase: "Docked", why: "Waiting at the station" }),
    line({ kind: "result", seq: 2, ok: false, refusal: "NOT_IN_SPACE", verdict: "refused" }),
  ];
  assert.equal(buildLogView(entries, "ORBIT-OPTIMAL").rows.length, 1);
  assert.equal(buildLogView(entries, "not_in_space refused").rows.length, 1);
  assert.equal(buildLogView(entries, "docked").rows.length, 1);
  assert.equal(buildLogView(entries, "  ").rows.length, 3);
  assert.equal(buildLogView(entries, "nothing like it").rows.length, 0);
  const view = buildLogView(entries, "decide");
  assert.equal(view.matched, 2);
  assert.equal(view.total, 3);
  assert.equal(matchesFilter("abc def", "def abc"), true);
});

test("the row cap hides the oldest and says how many", () => {
  const entries = Array.from({ length: 10 }, (_, i) => line({ kind: "decide", seq: i, why: `tick ${i}` }));
  const view = buildLogView(entries, "", 4);
  assert.equal(view.rows.length, 4);
  assert.equal(view.hidden, 6);
  assert.equal(view.rows[0]!.index, 9);
});

test("a line with nothing optional still renders", () => {
  const view = buildLogView([line({ kind: "decide" }), line({ kind: "issue" }), line({ kind: "end" })]);
  assert.equal(view.rows.length, 3);
  assert.equal(view.rows[0]!.text, "end");
  assert.equal(view.rows[0]!.summary, null);
});
