import { test } from "node:test";
import assert from "node:assert/strict";

import { createOverloadEffects, setOverload } from "./dogmaWrites.ts";
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

// godma.py 2074 and 2119. Tranquility has the first recorded: Overload(moduleID, 3001), on the dogma location.

test("a module is overloaded by godma's Overload, the module and its overload effect by place", async () => {
  const { act, asked } = asking(9988400023312);
  await setOverload(act, 9988400023312, 3001, true);
  assert.deepEqual(asked, [["dogmaIM", "Overload", [9988400023312, 3001]]]);
});

test("and cooled by StopOverload, with the same two", async () => {
  const { act, asked } = asking(9988400023312);
  await setOverload(act, 9988400023312, 3001, false);
  assert.deepEqual(asked, [["dogmaIM", "StopOverload", [9988400023312, 3001]]]);
});

test("setOverload fails as the call fails", async () => {
  await assert.rejects(() => setOverload(asking(new Error("DontHaveThermoDynamicsSkill")).act, 1, 3001, true), /DontHaveThermoDynamicsSkill/);
});

// ── What a type's overload effect is ─────────────────────────────────────────

/** The static read, standing in: what each asking named, and the answer it gets. */
function reading(answers: Readonly<Record<number, number | null>>, failing: () => boolean = () => false) {
  const asked: number[][] = [];
  const read = async (typeIDs: readonly number[]) => {
    asked.push([...typeIDs]);
    if (failing()) throw new Error("the static data could not be read");
    return Object.fromEntries(typeIDs.filter(typeID => Object.hasOwn(answers, typeID)).map(typeID => [typeID, answers[typeID]!]));
  };
  return { asked, effects: createOverloadEffects(read) };
}

test("a type's overload effect is asked for once and kept, and so is that it has none", async () => {
  const { asked, effects } = reading({ 527: 3001, 17482: null });
  assert.equal(await effects.of(527), 3001);
  assert.equal(await effects.of(527), 3001);
  assert.equal(await effects.of(17482), null);
  assert.equal(await effects.of(17482), null);
  assert.deepEqual(asked, [[527], [17482]]);
});

test("a reading that fails is not kept: the type is asked for again", async () => {
  let failing = true;
  const { asked, effects } = reading({ 527: 3001 }, () => failing);
  await assert.rejects(() => effects.of(527), /could not be read/);
  failing = false;
  assert.equal(await effects.of(527), 3001);
  assert.deepEqual(asked, [[527], [527]]);
});

test("an answer that does not speak of the type is no answer: it fails, and is not kept as none", async () => {
  const { asked, effects } = reading({});
  await assert.rejects(() => effects.of(527));
  await assert.rejects(() => effects.of(527));
  assert.equal(asked.length, 2);
});
