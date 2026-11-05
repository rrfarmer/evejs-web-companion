import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createBotLogWriter } from "./botLogWriter.ts";
import { appendBotLog } from "./api.ts";

const { createBotLogStore } = createRequire(import.meta.url)("../../../src/botLogStore.js");
type Line = { readonly kind: string; readonly run: string };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const line = (kind: string, run: string): Line => ({ kind, run });

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "bot-log-writer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBotLogStore({ dir });
  const read = (which = "current"): string[] => store.read(7, which).map((row: Line) => `${row.run}:${row.kind}`);
  // Explicit flushes advance the test; no real timers or live data stores.
  const schedule = () => () => {};
  return { store, read, schedule };
}

test("a delayed failed start is retried before a newer run can reach the real log store", async (t) => {
  const { store, read, schedule } = fixture(t);
  let rejectFirst!: (error: Error) => void;
  const calls: string[] = [];
  const writer = createBotLogWriter<Line>(async (lines, batchID) => {
    calls.push(batchID);
    if (calls.length === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    else store.append(7, lines, { batchID });
  }, { schedule });
  writer.write(line("start", "A"));
  writer.write(line("end", "A"));
  writer.write(line("start", "B"));
  await turn();
  assert.equal(calls.length, 1, "a later start must wait for the older batch and its retry");
  rejectFirst(new Error("first request never arrived"));
  await turn();
  await writer.flush();
  assert.equal(calls[0], calls[1], "the retry keeps the exact batch identity");
  assert.deepEqual(read(), ["B:start"]);
  assert.deepEqual(read("previous"), ["A:start", "A:end"]);
});

test("a lost response after commit does not rotate the same start twice", async (t) => {
  const { store, read, schedule } = fixture(t);
  store.append(7, [line("start", "older")]);
  let calls = 0;
  const writer = createBotLogWriter<Line>(async (lines, batchID) => {
    store.append(7, lines, { batchID });
    if (++calls === 1) throw new Error("response lost after the append committed");
  }, { schedule });
  writer.write(line("start", "A"));
  await writer.flush();
  assert.equal(calls, 2);
  assert.deepEqual(read(), ["A:start"]);
  assert.deepEqual(read("previous"), ["older:start"]);
  assert.deepEqual(read("previous2"), []);
});

test("two failed attempts are dropped and newer lines can still be delivered", async (t) => {
  const { store, read, schedule } = fixture(t);
  let calls = 0;
  const writer = createBotLogWriter<Line>(async (lines, batchID) => {
    if (++calls <= 2) throw new Error("unreachable");
    store.append(7, lines, { batchID });
  }, { schedule });
  writer.write(line("issue", "A"));
  await writer.flush();
  assert.equal(calls, 2);
  writer.write(line("start", "B"));
  await writer.flush();
  assert.equal(calls, 3);
  assert.deepEqual(read(), ["B:start"]);
});

test("HTTP pages without crypto can send distinct batches through the API with their delivery ids", async (t) => {
  const { schedule } = fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  });
  const bodies: { entries: readonly Line[]; batchID?: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, written: 1 });
  };
  const writer = createBotLogWriter<Line>((entries, batchID) => appendBotLog(entries, { fetch }, batchID), { schedule });
  writer.write(line("start", "A"));
  await writer.flush();
  writer.write(line("end", "A"));
  await writer.flush();
  assert.deepEqual(bodies.map((body) => body.entries), [[line("start", "A")], [line("end", "A")]]);
  assert.equal(typeof bodies[0]?.batchID, "string");
  assert.notEqual(bodies[0]?.batchID, bodies[1]?.batchID);
});

test("draining waits for what was written behind the delivery in flight, where a flush leaves it for the timer", async (t) => {
  const { read, store, schedule } = fixture(t);
  let finishFirst!: () => void;
  let calls = 0;
  const writer = createBotLogWriter<Line>(async (lines, batchID) => {
    calls += 1;
    if (calls === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
    store.append(7, lines, { batchID });
  }, { schedule });
  writer.write(line("start", "A"));
  await turn();
  writer.write(line("decide", "A"));
  writer.write(line("result", "A"));
  const drained = writer.drain();
  await turn();
  finishFirst();
  await drained;
  assert.deepEqual(read(), ["A:start", "A:decide", "A:result"]);
});
