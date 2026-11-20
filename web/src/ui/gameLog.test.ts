import assert from "node:assert/strict";
import { test } from "node:test";
import { get } from "svelte/store";
import { addGameLogLine, beginGameLog, captureGameLog, clearGameLog, gameLog, setLogCount, setLogFilter } from "./gameLog.ts";

const labels = { title: "Game Log", listener: "Listener", started: "Session started" };

test("a capture includes filtered and older entries in occurrence order", (t) => {
  const now = new Date(2026, 10, 20, 14, 3, 8).getTime();
  t.mock.method(Date, "now", () => now);
  beginGameLog(140000001, "First Pilot");
  setLogCount(100);
  setLogFilter("mining", false);
  t.after(() => { setLogFilter("mining", true); clearGameLog(); });

  addGameLogLine("Filtered mining yield", "mining");
  assert.equal(get(gameLog).length, 0);
  addGameLogLine("Older combat result", "combat");
  for (let i = 0; i < 200; i++) addGameLogLine(`Combat result ${i}`, "combat");
  assert.equal(get(gameLog).length, 100);
  assert.equal(get(gameLog)[0]?.text, "Combat result 100");

  const { filename, text } = captureGameLog(labels);
  assert.equal(filename, "20261120_140308_140000001.txt");
  assert.match(text, /Listener: First Pilot/);
  assert.match(text, /\[ 2026\.11\.20 14:03:08 \] \(mining\) Filtered mining yield\n.*Older combat result/);
  assert.match(text, /Combat result 199\n$/);
});

test("clearing the log and changing pilot start fresh captures", () => {
  beginGameLog(140000001, "First Pilot");
  addGameLogLine("Before clearing", "notify");
  clearGameLog();
  assert.deepEqual(get(gameLog), []);
  assert.doesNotMatch(captureGameLog(labels).text, /Before clearing/);
  assert.match(captureGameLog(labels).text, /Listener: First Pilot/);

  addGameLogLine("After clearing", "notify");
  beginGameLog(140000002, "Second Pilot");
  assert.deepEqual(get(gameLog), []);
  const { filename, text } = captureGameLog(labels);
  assert.match(filename, /_140000002\.txt$/);
  assert.match(text, /Listener: Second Pilot/);
  assert.doesNotMatch(text, /First Pilot|After clearing/);
});
