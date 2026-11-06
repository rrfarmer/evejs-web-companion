// The run-scoped refusal ledger. Pure — no runner, no BFF.
//
// The behaviour under test is the one whose absence let a bot answer 227
// consecutive refusals over twelve hours while reporting cheerful progress:
// that a repeated "no" is counted, worded, slowed down, and eventually acted on.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRefusal,
  NO_ROOM_CODE,
  pilotCannotPay,
  REFUSAL_LINE_SHOWN_MS,
  refusalLines,
  shipHasNoRoom,
  createRefusalLedger,
  isUnreachable,
  MAX_CONSECUTIVE_REFUSALS,
  refusalFor,
  refusalKey,
  settleTicksForRefusals,
  shouldSetAside,
} from "./refusalLedger.ts";
import { SCRIPT_CADENCE_MS } from "./scriptRunner.ts";

const NO_ROOM = "CALL_REFUSED: NotEnoughCargoSpace";

test("a repeated refusal on one key counts up", () => {
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 80001);
  assert.equal(ledger.consecutive(key), 0, "not failing until it fails");
  ledger.note(key, NO_ROOM, 1_000, true);
  ledger.note(key, NO_ROOM, 2_000, true);
  const third = ledger.note(key, NO_ROOM, 3_000, true);
  assert.equal(third.count, 3);
  assert.equal(third.firstAt, 1_000, "the streak remembers when it started");
  assert.equal(third.lastAt, 3_000);
});

test("a success ends the streak", () => {
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 80001);
  ledger.note(key, NO_ROOM, 1_000, true);
  ledger.note(key, NO_ROOM, 2_000, true);
  ledger.clear(key);
  assert.equal(ledger.consecutive(key), 0);
});

test("one failing target never spends another's budget, or masks it", () => {
  const ledger = createRefusalLedger();
  const stubborn = refusalKey("s1", "lootContainer", 80001);
  const fine = refusalKey("s1", "lootContainer", 80002);
  ledger.note(stubborn, NO_ROOM, 1_000, true);
  ledger.note(stubborn, NO_ROOM, 2_000, true);
  ledger.note(fine, NO_ROOM, 3_000, true);
  assert.equal(ledger.consecutive(stubborn), 2);
  assert.equal(ledger.consecutive(fine), 1);
});

test("the same target under a DIFFERENT step is a different streak", () => {
  const ledger = createRefusalLedger();
  ledger.note(refusalKey("s1", "lootContainer", 80001), NO_ROOM, 1_000, true);
  assert.equal(ledger.consecutive(refusalKey("s2", "lootContainer", 80001)), 0);
});

test("a refusal is worded by describeRefusal, never left as a code", () => {
  const ledger = createRefusalLedger();
  const record = ledger.note(refusalKey("s1", "lootContainer", 1), NO_ROOM, 1_000, true);
  assert.match(record.words, /room/i, "the player reads about room, not NotEnoughCargoSpace");
  assert.equal(/NotEnoughCargoSpace/.test(record.words), false);
});

test("records come back worst-first, which is what a readout leads with", () => {
  const ledger = createRefusalLedger();
  const quiet = refusalKey("s1", "lootContainer", 1);
  const loud = refusalKey("s1", "lootContainer", 2);
  ledger.note(quiet, NO_ROOM, 1, true);
  for (let i = 0; i < 4; i += 1) {
    ledger.note(loud, NO_ROOM, i, true);
  }
  assert.deepEqual(ledger.records().map((record) => record.key), [loud, quiet]);
});

// ── The classification that a plan revision turned on ───────────────────────

test("an ordinary refusal is 'refused' whatever the grid says", () => {
  assert.equal(classifyRefusal(NO_ROOM, true), "refused");
  assert.equal(classifyRefusal(NO_ROOM, false), "refused");
  assert.equal(classifyRefusal(NO_ROOM, null), "refused");
});

test("a bind miss on a target STILL on the grid is unreachable, not gone", () => {
  // eve.js throws FakeItemNotFound both for an id that matches nothing and for
  // its own scene/range check. Retiring on the bare code would abandon every can
  // the ship merely drifted away from.
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", true), "unreachable");
});

test("a bind miss on a target that has LEFT the grid is gone", () => {
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", false), "gone");
});

test("a bind miss with an UNREADABLE grid is unreachable — never retired on a guess", () => {
  // "We could not look" is not evidence the object stopped existing, and the
  // recoverable reading is the only safe one.
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", null), "unreachable");
});

// ── The backoff ─────────────────────────────────────────────────────────────

test("the wait grows with the streak and is capped", () => {
  assert.equal(settleTicksForRefusals(0), 2, "an unblemished key waits the ordinary settle");
  assert.ok(settleTicksForRefusals(1) > settleTicksForRefusals(0));
  assert.ok(settleTicksForRefusals(5) > settleTicksForRefusals(1));
  assert.equal(settleTicksForRefusals(1_000), settleTicksForRefusals(100), "capped, not unbounded");
  assert.ok(settleTicksForRefusals(1_000) <= 30);
});

test("the bound is looser than a block's own, because it stops the whole run", () => {
  // MAX_BLOCK_ATTEMPTS is 5 and bounds one visit to a block, where giving up and
  // trying the next can is cheap. This one ends the run.
  assert.ok(MAX_CONSECUTIVE_REFUSALS > 5);
});

// ── Decay: the thing that stops "set aside" meaning "for ever" ──────────────

test("something moving forgets every refused streak, so a set-aside can is retried", () => {
  // A can is set aside because it kept refusing, and it kept refusing because
  // the hold was full. Nothing would ever try it again once the hold is emptied,
  // because the only thing that clears a streak is a success on the SAME key and
  // the block has stopped issuing one. A hauler would quietly run out of work.
  const ledger = createRefusalLedger();
  const can = refusalKey("s1", "lootContainer", 80001);
  for (let i = 0; i < 6; i += 1) {
    ledger.note(can, NO_ROOM, i, true);
  }
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 80001, 5), true);

  ledger.forgetRefused();
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 80001, 5), false);
});

test("emptying a hold does NOT bring back a despawned can, or close a distance", () => {
  const ledger = createRefusalLedger();
  const ghost = refusalKey("s1", "lootContainer", 1);
  const far = refusalKey("s1", "lootContainer", 2);
  ledger.note(ghost, "CALL_REFUSED: FakeItemNotFound", 1, false);
  ledger.note(far, "CALL_REFUSED: FakeItemNotFound", 1, true);
  ledger.forgetRefused();
  assert.equal(ledger.consecutive(ghost), 1, "gone survives");
  assert.equal(ledger.consecutive(far), 1, "unreachable survives");
});

test("confirmed hold recovery clears NO_ROOM_ABOARD but retains durable target evidence", () => {
  const ledger = createRefusalLedger();
  const full = refusalKey("s1", "lootContainer", 3);
  const gone = refusalKey("s1", "lootContainer", 4);
  const far = refusalKey("s1", "lootContainer", 5);
  ledger.note(full, `${NO_ROOM_CODE}: full`, 1, true);
  ledger.note(gone, "CALL_REFUSED: FakeItemNotFound", 1, false);
  ledger.note(far, "CALL_REFUSED: FakeItemNotFound", 1, true);
  ledger.forgetRefused();
  assert.equal(ledger.consecutive(full), 1, "movement into a hold does not prove room");
  ledger.forgetRefused(true);
  assert.equal(ledger.consecutive(full), 0);
  assert.equal(ledger.consecutive(gone), 1);
  assert.equal(ledger.consecutive(far), 1);
});

// ── The read side a decider uses ────────────────────────────────────────────

test("a target nothing is recorded against is not set aside", () => {
  assert.equal(shouldSetAside([], "s1", "lootContainer", 80001, 5), false);
  assert.equal(shouldSetAside(null, "s1", "lootContainer", 80001, 5), false);
  assert.equal(refusalFor(undefined, "s1", "lootContainer", 1), null);
});

test("a GONE target is set aside at once, without spending the budget", () => {
  const ledger = createRefusalLedger();
  ledger.note(refusalKey("s1", "lootContainer", 1), "CALL_REFUSED: FakeItemNotFound", 0, false);
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), true);
});

test("an UNREACHABLE target is not set aside on the ordinary bound", () => {
  // It exists. The answer is to close the distance, not to give up on it — so
  // it survives the limit an outright refusal would be retired at. (It is not
  // patient for ever; see the test further down.)
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 1);
  for (let i = 0; i < 10; i += 1) {
    ledger.note(key, "CALL_REFUSED: FakeItemNotFound", i, true);
  }
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), false);
  assert.equal(isUnreachable(ledger.records(), "s1", "lootContainer", 1), true);
});

test("a stubborn but reachable target is set aside once it passes the limit", () => {
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 1);
  for (let i = 0; i < 4; i += 1) {
    ledger.note(key, NO_ROOM, i, true);
  }
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), false);
  ledger.note(key, NO_ROOM, 5, true);
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), true);
});

// ── "No room" is about the SHIP, not the target ────────────────────────────

test("a no-room failure is its own kind, and is worded without the marker", () => {
  const ledger = createRefusalLedger();
  const record = ledger.note(
    refusalKey("s1", "lootContainer", 1),
    `${NO_ROOM_CODE}: There is no room aboard for what is in that container.`,
    0,
    true,
  );
  assert.equal(record.kind, "no-room");
  assert.match(record.words, /no room aboard/i);
  assert.equal(record.words.includes(NO_ROOM_CODE), false, "the sentinel never reaches a player");
});

test("no room on ONE target answers for the whole step", () => {
  // The hold that had no room for this container has none for the next either,
  // so a block must be able to stop asking rather than prove it once per can —
  // five attempts and a growing backoff each, which reads as a hung bot.
  const ledger = createRefusalLedger();
  ledger.note(refusalKey("lc", "lootContainer", 80001), `${NO_ROOM_CODE}: full`, 0, true);
  assert.equal(shipHasNoRoom(ledger.records(), "lc", "lootContainer"), true);
  assert.equal(shipHasNoRoom(ledger.records(), "lc", "lootWreck"), false, "a different action");
  assert.equal(shipHasNoRoom(ledger.records(), "other", "lootContainer"), false, "a different step");
});

test("an ordinary refusal does not read as no-room", () => {
  const ledger = createRefusalLedger();
  ledger.note(refusalKey("lc", "lootContainer", 1), NO_ROOM, 0, true);
  assert.equal(shipHasNoRoom(ledger.records(), "lc", "lootContainer"), false);
});

test("a wallet that cannot pay is its own kind, worded for a player, and answers for the whole step", () => {
  const ledger = createRefusalLedger();
  const record = ledger.note(refusalKey("cc", "exportCustoms", 501), "CALL_REFUSED: NotEnoughMoney", 0, true);
  assert.equal(record.kind, "no-funds");
  assert.match(record.words, /enough ISK/);
  assert.equal(record.words.includes("NotEnoughMoney"), false);
  assert.equal(pilotCannotPay(ledger.records(), "cc", "exportCustoms"), true);
  assert.equal(pilotCannotPay(ledger.records(), "cc", "collectCustoms"), false, "a different action");
  assert.equal(pilotCannotPay(ledger.records(), "other", "exportCustoms"), false, "a different step");
  assert.equal(classifyRefusal("CALL_REFUSED: You cannot warp there right now.", true), "refused");
});

test("an UNREACHABLE target is eventually set aside, rather than approached for ever", () => {
  // It is never retired on the ordinary bound, but a can this ship will never
  // reach must not own the block for the rest of the run.
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 1);
  for (let i = 0; i < 19; i += 1) {
    ledger.note(key, "CALL_REFUSED: FakeItemNotFound", i, true);
  }
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), false, "still closing in");
  ledger.note(key, "CALL_REFUSED: FakeItemNotFound", 20, true);
  assert.equal(shouldSetAside(ledger.records(), "s1", "lootContainer", 1, 5), true, "and eventually gives up");
});

test("the readout's lines: one per sentence, most refused first, gone once old", () => {
  const ledger = createRefusalLedger();
  ledger.note("s1:lock:1", "CALL_REFUSED: TargetingSystemsAlreadyFullyUtilized", 1000, true);
  ledger.note("s1:lock:2", "CALL_REFUSED: TargetingSystemsAlreadyFullyUtilized", 1000, true);
  ledger.note("s1:loot:3", "CALL_REFUSED: FakeItemNotFound", 5000, false);
  const [locks, gone] = refusalLines(ledger.records(), 5000);
  assert.equal(locks?.count, 2);
  assert.match(locks?.words ?? "", /locking as many targets/);
  assert.equal(gone?.count, 1);

  const later = 1000 + REFUSAL_LINE_SHOWN_MS + 1;
  assert.deepEqual(refusalLines(ledger.records(), later).map((line) => line.count), [1], "only the newer sentence is left");
  assert.equal(refusalLines(ledger.records(), null).length, 2, "a run no longer asking keeps its lines");
  assert.equal(ledger.records().length, 3, "age hides a line, it never drops a record the bot still reads");
});

test("a line outlasts the longest backoff, so a live streak never blinks off", () => {
  const longestBackoffMs = settleTicksForRefusals(1000) * SCRIPT_CADENCE_MS;
  assert.ok(REFUSAL_LINE_SHOWN_MS > longestBackoffMs);
});
