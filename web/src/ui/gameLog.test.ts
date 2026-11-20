import assert from "node:assert/strict";
import { test } from "node:test";
import { get } from "svelte/store";
import {
  addGameLogLine, beginGameLog, captureGameLog, clearGameLog, gameLog, gameLogClipboard, setLogCount,
  setLogFilter, sortGameLogLines, type GameLogLine,
} from "./gameLog.ts";

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

test("log columns sort by full timestamps, displayed type and message", () => {
  const midnight = new Date(2026, 10, 21).getTime();
  const rows: GameLogLine[] = [
    { n: 1, atMs: midnight - 1000, type: "damage", text: "Second line by name" },
    { n: 2, atMs: midnight + 1000, type: "yield", text: "Another line" },
    { n: 3, atMs: midnight + 2000, type: "damage", text: "Third line by name" },
  ];
  const types = (type: string) => type === "damage" ? "Zeta" : "Alpha";
  assert.deepEqual(sortGameLogLines(rows, 0, false, types).map((row) => row.n), [1, 2, 3]);
  assert.deepEqual(sortGameLogLines(rows, 0, true, types).map((row) => row.n), [3, 2, 1]);
  assert.deepEqual(sortGameLogLines(rows, 1, false, types).map((row) => row.n), [2, 1, 3]);
  assert.deepEqual(sortGameLogLines(rows, 2, true, types).map((row) => row.n), [3, 1, 2]);
  assert.deepEqual(rows.map((row) => row.n), [1, 2, 3]);
});

test("copy uses the visible table order for selected rows and falls back to all visible rows", () => {
  const morning = new Date(2026, 10, 20, 7).getTime();
  const rows: GameLogLine[] = [
    { n: 51, atMs: morning + 2000, type: "damage", text: "Incoming damage" },
    { n: 3, atMs: morning + 1000, type: "yield", text: "Veldspar" },
    { n: 35, atMs: morning, type: "damage", text: "Earlier hit" },
  ];
  const types = (type: string) => type === "damage" ? "Combat" : "Mining";
  assert.deepEqual(gameLogClipboard(rows, new Set([35, 51, 12]), types), {
    text: "07:00:02\tCombat\tIncoming damage\n07:00:00\tCombat\tEarlier hit", count: 2,
  });
  assert.deepEqual(gameLogClipboard(rows, new Set([12]), types), {
    text: "07:00:02\tCombat\tIncoming damage\n07:00:01\tMining\tVeldspar\n07:00:00\tCombat\tEarlier hit", count: 3,
  });
  assert.deepEqual(gameLogClipboard([], new Set(), types), { text: "", count: 0 });
});
