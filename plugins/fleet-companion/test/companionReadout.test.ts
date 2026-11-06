import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canTagWords, inFleetWords, orderFromWords } from "../lib/companionReadout.ts";

test("the chat channel is named LOCAL to the player, never fleet", () => {
  // ⚠ THIS IS A REGRESSION GUARD FOR A STRING THAT SHIPPED WRONG. The panel
  // said "Fleet chat commands" and "a fleet chat command" while `flow.ts` read
  // LOCAL deliberately -- fleet chat is not reachable on this server at all.
  // The operator accepted Local knowingly; what they accepted is that the whole
  // system can read the command. A label saying "fleet" hid exactly that.
  const phrase = orderFromWords("chat");
  assert.match(phrase, /local/i);
  assert.doesNotMatch(phrase, /fleet/i);
});

test("canTag keeps three states, and the unread one is never a settled answer", () => {
  // ⚠ THE THIRD STATE IS THE WHOLE POINT. The roster is the only place either
  // answer exists, so a pilot whose roster has not been read yet knows nothing
  // about how it calls targets. Flattening "not known" into either answer would
  // report a confident falsehood on every tick before the first roster read.
  //
  // ⚠ AND "THE THREE READ DIFFERENTLY" IS NOT THE ASSERTION. That was the first
  // version of this test and it was VACUOUS: flattening the unread state to a
  // settled answer still left it a distinct STRING from the other two, so the
  // guard passed over the exact bug it was written to catch. Mutation-tested
  // both ways. What is required is that the unread state claims NEITHER method,
  // so that is what is asserted.
  const unread = canTagWords(null);
  assert.doesNotMatch(unread, /tags targets/i, "an unread roster must not claim it letters targets");
  assert.doesNotMatch(unread, /broadcasts/i, "nor that it broadcasts them");
});

test("canTag === false reports a METHOD, not a shortcoming", () => {
  // ⚠ THE REGRESSION THIS EXISTS FOR SHIPPED, AND READ AS A FAULT ON EVERY RUN.
  // `false` means "not a fleet, wing or squad commander", which is what a
  // companion alt in somebody else's fleet permanently is. It used to print
  // "no - not a fleet commander", which stated the pilot's standing condition as
  // a refusal -- and was misleading besides: the pilot cannot LETTER a target
  // (fleetRuntime.js:1317 refuses a non-commander) but broadcasts one perfectly
  // well (fleetRuntime.js:2521 gates on membership alone), which is what rung 4
  // now makes it do.
  const plainMember = canTagWords(false);
  assert.doesNotMatch(plainMember, /^no\b/i, "a plain member is not refused anything it needs");
  assert.doesNotMatch(plainMember, /cannot|can't|unable/i);
  assert.match(plainMember, /broadcast/i, "it must say what the pilot DOES do instead");
  assert.match(canTagWords(true), /tag/i, "and a commander must still be distinguishable");
  assert.notEqual(canTagWords(true), plainMember);
});

test("inFleet keeps three states too", () => {
  assert.notEqual(inFleetWords(null), inFleetWords(false));
  assert.equal(inFleetWords(true), "yes");
  assert.equal(inFleetWords(false), "no");
});

test("every authority the progress can name has its own words", () => {
  // ⚠ `squad-board` IS DELIBERATELY ABSENT FROM THIS LIST. It used to be a
  // fourth channel here; it is gone from `CompanionOrderAuthority` itself
  // (`nav/fleetCompanionLoop.ts`) because nothing in the loop ever emitted it
  // -- see the comment on `orderFromWords`. This list is typed against that
  // same union (`as const` feeding a `CompanionOrderAuthority | null`
  // parameter), so writing "squad-board" back in here would fail to compile,
  // not just fail an assertion.
  const said = new Set<string>();
  for (const value of ["broadcast", "tag", "chat", "own-ladder", null] as const) {
    const words = orderFromWords(value);
    assert.ok(words.length > 0, `no words for ${String(value)}`);
    assert.ok(!said.has(words), `two authorities read identically: ${words}`);
    said.add(words);
  }
});

test("no string in this module carries a decorative non-ASCII character", () => {
  // Every string literal in this module is player-facing by construction --
  // that is what the module is for -- so the scan needs no allowlist. Code
  // COMMENTS are exempt and are stripped before judging, exactly as the
  // equivalent guard in fleetCompanionLoop.test.ts does.
  const source = readFileSync(new URL("../lib/companionReadout.ts", import.meta.url), "utf8");
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const code = source
    .replace(blockComment, "")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");

  const doubleQuoted = new RegExp('"((?:[^"\\\\\\n]|\\\\.)*)"', "g");
  const offenders: string[] = [];
  for (const match of code.matchAll(doubleQuoted)) {
    const value = match[1] ?? "";
    if ([...value].some((character) => (character.codePointAt(0) ?? 0) > 127)) {
      offenders.push(value);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "player-facing strings must be plain ASCII; an em-dash is the usual culprit",
  );
});
