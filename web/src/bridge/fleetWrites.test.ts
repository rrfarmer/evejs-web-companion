import { test } from "node:test";
import assert from "node:assert/strict";

import { applyToJoinFleet, createFleetBroadcasts, decodeFleetWriteAck, decodeFleetAdvertWriteAck } from "./fleetWrites.ts";
import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

/** A stand-in for the page's asking: what was asked, and `answer` (or what it throws) for each. */
function asking(answer: JsonValue | Error) {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push(kwargs === undefined ? [service, method, args] : [service, method, args, kwargs]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { act, asked };
}

// --- R94 fleet top-level write acks (Phase-3 WRITES) -----------------------

test("decodeFleetWriteAck reads ok/applied off the BFF envelope", () => {
  const ack = decodeFleetWriteAck({ ok: true, applied: true, result: null });
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("decodeFleetWriteAck is false for a non-object / empty response (never throws)", () => {
  assert.deepEqual(decodeFleetWriteAck(null as unknown as JsonValue), { ok: false, applied: false });
  assert.deepEqual(decodeFleetWriteAck({ ok: false, applied: false }), {
    ok: false,
    applied: false,
  });
});

test("decodeFleetAdvertWriteAck reports advertPresent=true when the handler returned an advert dict", () => {
  const advert: JsonValue = { type: "dict", entries: [["fleetID", 1]] } as unknown as JsonValue;
  const ack = decodeFleetAdvertWriteAck({ ok: true, applied: true, result: advert });
  assert.equal(ack.applied, true);
  assert.equal(ack.advertPresent, true);
});

test("decodeFleetAdvertWriteAck reports advertPresent=false when the handler returned null (no advert)", () => {
  const ack = decodeFleetAdvertWriteAck({ ok: true, applied: true, result: null });
  assert.equal(ack.applied, true);
  assert.equal(ack.advertPresent, false);
});

// ── ApplyToJoinFleet's answer ────────────────────────────────────────────────
// ⚠ CORRECTS AN R94 FAST-MODE GUESS. This write was recorded as "returns
// null/ack" because it was never fired live. It returns a BOOLEAN, and that
// boolean is the protocol: true = the boss must approve, false = an invite was
// minted and the client must accept it. Getting this wrong is what made the
// join-by-name block hang on a healthy fleet.

// The page makes the call itself since 2026-10-10 (the plan's Phase 6b), and
// reads the call's own answer where it read a route's acknowledgement.

test("applyToJoinFleet makes the client's call: true is the approval path, false is a minted invite", async () => {
  // fleetSvc.py 1907: sm.ProxySvc('fleetProxy').ApplyToJoinFleet(fleetID, autoAccept), both by place.
  const approval = asking(true);
  assert.equal(await applyToJoinFleet(approval.act, 90000001, true), "needs-approval");
  assert.deepEqual(approval.asked, [["fleetProxy", "ApplyToJoinFleet", [90000001, true]]]);
  const invite = asking(false);
  assert.equal(await applyToJoinFleet(invite.act, 90000002, false), "invited");
  assert.deepEqual(invite.asked, [["fleetProxy", "ApplyToJoinFleet", [90000002, false]]]);
  // Some servers answer a python bool as 1/0.
  assert.equal(await applyToJoinFleet(asking(1).act, 90000001, true), "needs-approval");
  assert.equal(await applyToJoinFleet(asking(0).act, 90000001, true), "invited");
});

test("applyToJoinFleet: anything else is 'unknown', which callers must TRY", async () => {
  // Not "assume approval". An unknown answer must fall through to accepting,
  // because the invite half is the common one and a bot that refuses to accept
  // strands itself with an invitation sitting unanswered.
  for (const answer of [null, "yes", {}, 2] as JsonValue[]) {
    assert.equal(await applyToJoinFleet(asking(answer).act, 90000001, true), "unknown", JSON.stringify(answer));
  }
});

test("applyToJoinFleet fails as the call fails", async () => {
  await assert.rejects(() => applyToJoinFleet(asking(new Error("FleetNotFound")).act, 90000001, true), /FleetNotFound/);
});

// ── A broadcast to the bubble ────────────────────────────────────────────────
// fleetSvc.SendBubbleBroadcast (992 to 998), with the wait the client keeps
// before it (962 to 981): two seconds after a broadcast of the same name, a
// third of that after one of another.

/** Broadcasts over a stand-in, with a clock the test moves. */
function broadcasting(answer: JsonValue | Error = true) {
  const { act, asked } = asking(answer);
  const clock = { nowMs: 1_000_000 };
  return { asked, clock, broadcasts: createFleetBroadcasts(act, () => clock.nowMs) };
}

test("a broadcast to the bubble is the client's call, the type left empty, and answers whether the server sent it", async () => {
  const sent = broadcasting(true);
  assert.equal(await sent.broadcasts.toBubble("Target", 3, 200001), true);
  assert.deepEqual(sent.asked, [["fleetMgr", "BroadcastToBubble", ["Target", 3, 200001, null]]]);
  // The server's own wait: it answers False, and nothing was sent to the fleet.
  assert.equal(await broadcasting(false).broadcasts.toBubble("HealArmor", 1, 9988400023309), false);
  // An answer that is no yes or no is no refusal.
  assert.equal(await broadcasting(null).broadcasts.toBubble("Target", 3, 200001), true);
});

test("the very first broadcast is sent, whatever the clock says", async () => {
  const { act, asked } = asking(true);
  assert.equal(await createFleetBroadcasts(act, () => 5).toBubble("Target", 3, 200001), true);
  assert.equal(asked.length, 1);
});

test("a broadcast of the same name is held back for two seconds, as the client holds it, and nothing is asked", async () => {
  const { asked, clock, broadcasts } = broadcasting();
  assert.equal(await broadcasts.toBubble("Target", 3, 200001), true);
  clock.nowMs += 1999;
  assert.equal(await broadcasts.toBubble("Target", 3, 200002), false);
  assert.equal(asked.length, 1);
  // What was held back does not start the wait again: the two seconds are from the one that was sent.
  clock.nowMs += 1;
  assert.equal(await broadcasts.toBubble("Target", 3, 200002), true);
  assert.deepEqual(asked.at(-1), ["fleetMgr", "BroadcastToBubble", ["Target", 3, 200002, null]]);
  assert.equal(asked.length, 2);
});

test("a broadcast of another name is held back for a third of that", async () => {
  const { asked, clock, broadcasts } = broadcasting();
  assert.equal(await broadcasts.toBubble("Target", 3, 200001), true);
  clock.nowMs += 666;
  assert.equal(await broadcasts.toBubble("HealArmor", 3, 9988400023309), false);
  assert.equal(asked.length, 1);
  clock.nowMs += 1;
  assert.equal(await broadcasts.toBubble("HealArmor", 3, 9988400023309), true);
  assert.equal(asked.length, 2);
  // And it is the name sent last that the next is set against: "Target" again is now another name.
  clock.nowMs += 667;
  assert.equal(await broadcasts.toBubble("Target", 3, 200001), true);
  clock.nowMs += 1999;
  assert.equal(await broadcasts.toBubble("Target", 3, 200001), false);
  assert.equal(asked.length, 3);
});

test("the wait starts when the broadcast is made, whether or not the call comes back", async () => {
  // fleetSvc.py 967: the name and the time are kept before the call is made.
  const { asked, clock, broadcasts } = broadcasting(new Error("the connection went"));
  await assert.rejects(() => broadcasts.toBubble("Target", 3, 200001), /the connection went/);
  clock.nowMs += 1000;
  assert.equal(await broadcasts.toBubble("Target", 3, 200001), false);
  assert.equal(asked.length, 1);
});
