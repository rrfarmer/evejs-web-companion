import test from "node:test";
import assert from "node:assert/strict";

import {
  squadStartFinished,
  squadStartSummary,
  squadStartWarnings,
  startCompanionSquad,
  type SquadStartEntry,
  type SquadStartTarget,
} from "../lib/squadStart.ts";
import { DEFAULT_COMPANION_SETUP } from "../lib/fleetCompanionLoop.ts";

// Synthetic throughout: 90000001-and-up mirrors ESI's documented example id.
const PILOT_A = 90000001;
const PILOT_B = 90000002;
const PILOT_C = 90000003;

function target(characterID: number, over = {}): SquadStartTarget {
  return {
    characterID,
    setup: { ...DEFAULT_COMPANION_SETUP, ...over },
  };
}

test("every pilot is started, one at a time, in roster order", () => {
  // ⚠ SEQUENCE IS THE ASSERTION, not merely that all three were called. A
  // browser allows about six connections per origin, so parallel starts fill
  // that pool and the next request of any kind queues behind them -- the same
  // reason App.svelte signs pilots in one at a time. Proven by refusing to
  // resolve one start until the next has NOT begun.
  const order: string[] = [];
  let inFlight = 0;
  const deps = {
    async startCompanion(characterID: number) {
      inFlight += 1;
      assert.equal(inFlight, 1, "two starts were in flight at once");
      order.push(`start:${characterID}`);
      await Promise.resolve();
      inFlight -= 1;
    },
  };
  return startCompanionSquad(deps, [target(PILOT_A), target(PILOT_B), target(PILOT_C)]).then(
    (entries) => {
      assert.deepEqual(order, [`start:${PILOT_A}`, `start:${PILOT_B}`, `start:${PILOT_C}`]);
      assert.deepEqual(
        entries.map((entry) => entry.state),
        ["started", "started", "started"],
      );
    },
  );
});

test("ONE REFUSAL MUST NOT STRAND THE REST OF A SQUAD", async () => {
  // ⚠ THE BEHAVIOUR THIS MODULE EXISTS FOR. A pilot already flown by a tab or
  // another bot refuses with CHARACTER_IN_USE; that is a fact about that pilot,
  // never about the operation. The pilots after it must still fly.
  const deps = {
    async startCompanion(characterID: number) {
      if (characterID === PILOT_B) {
        throw new Error("A web session is flying this character.");
      }
    },
  };
  const entries = await startCompanionSquad(deps, [
    target(PILOT_A),
    target(PILOT_B),
    target(PILOT_C),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.state),
    ["started", "refused", "started"],
  );
  assert.equal(entries[1]!.sentence, "A web session is flying this character.");
});

test("the server's own words are what the player reads", () => {
  // There is no code-to-sentence layer on the client for these, and a second
  // one here would drift from the first. CHARACTER_IN_USE already says it.
  const deps = {
    async startCompanion() {
      throw new Error("A server bot is already flying this character.");
    },
  };
  return startCompanionSquad(deps, [target(PILOT_A)]).then((entries) => {
    assert.equal(entries[0]!.sentence, "A server bot is already flying this character.");
  });
});

test("a throw that carries no message still reads as something", async () => {
  const deps = {
    async startCompanion() {
      throw new Error("");
    },
  };
  const entries = await startCompanionSquad(deps, [target(PILOT_A)]);
  assert.equal(entries[0]!.state, "refused");
  assert.ok((entries[0]!.sentence ?? "").length > 0, "never an empty explanation");
});

test("each pilot is started with ITS OWN setup", async () => {
  // ⚠ TWO PILOTS IN ONE SQUAD ARE NOT THE SAME RUN. Reusing one pilot's setup
  // for another would fly it under thresholds nobody chose for it.
  const seen: { id: number; capacitorFloor: number }[] = [];
  const deps = {
    async startCompanion(characterID: number, setup: { capacitorFloor: number }) {
      seen.push({ id: characterID, capacitorFloor: setup.capacitorFloor });
    },
  };
  await startCompanionSquad(deps, [
    target(PILOT_A, { capacitorFloor: 0.2 }),
    target(PILOT_B, { capacitorFloor: 0.4 }),
  ]);
  assert.deepEqual(seen, [
    { id: PILOT_A, capacitorFloor: 0.2 },
    { id: PILOT_B, capacitorFloor: 0.4 },
  ]);
});

test("progress is reported as each pilot moves, not once at the end", async () => {
  // A row must flip because that pilot is actually flying, not because a timer
  // fired -- the same honesty App.svelte's launch dialog is built around.
  const snapshots: SquadStartEntry[][] = [];
  const deps = { async startCompanion() {} };
  await startCompanionSquad(deps, [target(PILOT_A), target(PILOT_B)], (entries) =>
    snapshots.push(entries.map((entry) => ({ ...entry }))),
  );
  assert.ok(snapshots.length >= 5, "queued, then starting/started per pilot");
  assert.deepEqual(snapshots[0]!.map((entry) => entry.state), ["queued", "queued"]);
  assert.ok(
    snapshots.some((snap) => snap[0]!.state === "starting"),
    "a pilot is seen mid-start",
  );
  assert.deepEqual(snapshots.at(-1)!.map((entry) => entry.state), ["started", "started"]);
});

test("a progress snapshot cannot be mutated from outside", async () => {
  // The caller keeps these for a readout; handing out the live array would let
  // a later tick rewrite a row the screen had already drawn.
  const snapshots: SquadStartEntry[][] = [];
  const deps = { async startCompanion() {} };
  await startCompanionSquad(deps, [target(PILOT_A)], (entries) => {
    snapshots.push(entries as SquadStartEntry[]);
  });
  assert.equal(snapshots[0]![0]!.state, "queued", "the first snapshot still says queued");
  assert.equal(snapshots.at(-1)![0]!.state, "started");
});

test("an empty squad starts nothing and says so", async () => {
  let called = false;
  const deps = {
    async startCompanion() {
      called = true;
    },
  };
  const entries = await startCompanionSquad(deps, []);
  assert.equal(called, false);
  assert.deepEqual(entries, []);
  assert.match(squadStartSummary(entries), /no pilot in this squad is set up/i);
});

// --- what the operator is told before anything starts -----------------------
//
// ⚠ THERE IS NO TAGGING SETTING AND NO HAND-PICKED MODULE LIST ANY MORE, SO
// NEITHER OLD WARNING CAN FIRE. Tagging is gated server-side on `obs.canTag`
// and only ever tags a ship tackling THIS pilot, so two companions collide
// only if the same ship tackled both in the same tick before either letter was
// visible -- nothing a squad's own settings could cause or prevent. And every
// companion always reads its own fit now, so the fit-mixture warning describes
// a mixture that cannot occur. See squadStart.ts's own comment on
// `squadStartWarnings`.

test("starting a squad never mentions tagging", () => {
  const targets = [target(PILOT_A), target(PILOT_B)];
  const warnings = squadStartWarnings(targets);
  assert.deepEqual(warnings, []);
  for (const line of warnings) {
    assert.doesNotMatch(line, /tag/i);
  }
});

test("no warning ever refuses the squad", () => {
  // ⚠ ADVISORY, BY THE OPERATOR'S OWN RULE. `squadStartWarnings` returns words
  // and nothing else -- there is no verdict, no boolean, no blocker on it, so a
  // caller physically cannot read one as a refusal.
  const warnings = squadStartWarnings([target(PILOT_A), target(PILOT_B)]);
  assert.ok(Array.isArray(warnings));
  for (const line of warnings) {
    assert.equal(typeof line, "string");
  }
});

test("every warning and summary is plain ASCII", () => {
  const lines = [
    ...squadStartWarnings([target(PILOT_A), target(PILOT_B)]),
    squadStartSummary([]),
    squadStartSummary([{ characterID: PILOT_A, state: "started" }]),
    squadStartSummary([{ characterID: PILOT_A, state: "refused", sentence: "x" }]),
    squadStartSummary([
      { characterID: PILOT_A, state: "started" },
      { characterID: PILOT_B, state: "refused", sentence: "x" },
    ]),
  ];
  for (const line of lines) {
    const offenders = [...line].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
    assert.deepEqual(offenders, [], `non-ASCII in: ${line}`);
  }
});

test("finished means every pilot reached a final state", () => {
  assert.equal(squadStartFinished([]), true);
  assert.equal(squadStartFinished([{ characterID: PILOT_A, state: "queued" }]), false);
  assert.equal(squadStartFinished([{ characterID: PILOT_A, state: "starting" }]), false);
  assert.equal(
    squadStartFinished([
      { characterID: PILOT_A, state: "started" },
      { characterID: PILOT_B, state: "refused", sentence: "x" },
    ]),
    true,
  );
});

test("the summary counts both halves honestly", () => {
  assert.match(squadStartSummary([{ characterID: PILOT_A, state: "started" }]), /One pilot is flying/);
  assert.match(
    squadStartSummary([
      { characterID: PILOT_A, state: "started" },
      { characterID: PILOT_B, state: "started" },
    ]),
    /2 pilots are flying/,
  );
  assert.match(
    squadStartSummary([
      { characterID: PILOT_A, state: "started" },
      { characterID: PILOT_B, state: "refused", sentence: "x" },
    ]),
    /1 flying, 1 could not start/,
  );
  assert.match(
    squadStartSummary([{ characterID: PILOT_A, state: "refused", sentence: "x" }]),
    /could not start/,
  );
});
