import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_LOG_MAX_BUFFER, createBotLogBuffer } from "./botLogBuffer.ts";

function fill(buffer: ReturnType<typeof createBotLogBuffer<number>>, count: number, from = 0) {
  for (let i = 0; i < count; i += 1) buffer.push(from + i);
}

test("the default cap is 1000 lines and the oldest are dropped past it", () => {
  assert.equal(BOT_LOG_MAX_BUFFER, 1000);
  const buffer = createBotLogBuffer<number>();
  fill(buffer, 1200);
  assert.equal(buffer.size, 1000);
  const first = buffer.take();
  assert.equal(first.lines[0], 200, "the 200 oldest lines were the ones dropped");
});

test("take never hands out more than one route-sized batch", () => {
  const buffer = createBotLogBuffer<number>(1000, 500);
  fill(buffer, 800);
  assert.equal(buffer.take().lines.length, 500);
  assert.equal(buffer.size, 300);
});

test("a failed flush goes back to the front, in order, ahead of newer lines", () => {
  const buffer = createBotLogBuffer<number>(10, 10);
  fill(buffer, 3);
  const batch = buffer.take();
  fill(buffer, 2, 100);
  buffer.requeue(batch);
  assert.deepEqual(buffer.take().lines, [0, 1, 2, 100, 101]);
});

test("a batch that fails twice is dropped: exactly one retry", () => {
  const buffer = createBotLogBuffer<number>(10, 10);
  fill(buffer, 3);
  buffer.requeue(buffer.take());
  assert.equal(buffer.size, 3, "first failure keeps the batch");
  buffer.requeue(buffer.take());
  assert.equal(buffer.size, 0, "second failure drops it");
});

test("a retried batch does not carry its marker onto newer lines", () => {
  const buffer = createBotLogBuffer<number>(10, 10);
  fill(buffer, 2);
  const failed = buffer.take();
  fill(buffer, 2, 50);
  buffer.requeue(failed);
  const mixed = buffer.take();
  assert.deepEqual(mixed.lines, [0, 1, 50, 51]);
  buffer.requeue(mixed);
  assert.deepEqual(buffer.take().lines, [50, 51], "only the new lines still have a retry left");
});

test("requeueing never pushes the total past the cap", () => {
  const buffer = createBotLogBuffer<number>(5, 5);
  fill(buffer, 5);
  const batch = buffer.take();
  fill(buffer, 4, 100);
  buffer.requeue(batch);
  assert.equal(buffer.size, 5, "capped at the maximum");
  assert.deepEqual(buffer.take().lines, [4, 100, 101, 102, 103].slice(0, 5), "the oldest were dropped");
});
