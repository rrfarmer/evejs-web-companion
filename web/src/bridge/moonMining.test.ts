import test from "node:test";
import assert from "node:assert/strict";
import { canManageMoonPull, decodeCorporationMoonPulls, decodeMoonResources, decodeMoonSchedule, estimateMoonOutput, MAX_MOON_PULL_SECONDS,
  MIN_MOON_PULL_SECONDS, moonPullDuration, moonPullStage } from "./moonMining.ts";

const structure = 1_030_000_000_000;
const started = 1_795_100_000_000;
const ready = started + MIN_MOON_PULL_SECONDS * 1000;
const automatic = ready + 3600 * 1000;
const filetime = (ms: number) => ({ type: "long", value: (116444736000000000n + BigInt(ms) * 10000n).toString() });
const extraction = {
  type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["structureID", { type: "long", value: String(structure) }],
    ["extractionID", 7],
    ["startMoveTime", filetime(started)],
    ["chunkAvailableTime", filetime(ready)],
    ["naturalDecayTime", filetime(automatic)],
    ["yieldMultiplier", { type: "real", value: 1.024 }],
  ] },
};

test("refinery schedule distinguishes idle, pulling, ready and confirmed fracture", () => {
  const idle = decodeMoonSchedule([null, null], structure, started);
  assert.deepEqual(idle, { pull: null, calendarEventID: null, nowMs: started });
  const { pull, calendarEventID } = decodeMoonSchedule([extraction, 23], structure, started);
  assert.deepEqual(pull, { id: 7, startedAtMs: started, readyAtMs: ready, automaticAtMs: automatic, yieldMultiplier: 1.024 });
  assert.equal(calendarEventID, 23);
  assert.equal(moonPullStage(idle.pull, started, false), "idle");
  assert.equal(moonPullStage(pull, ready - 1, false), "pulling");
  assert.equal(moonPullStage(pull, ready, false), "ready");
  assert.equal(moonPullStage(pull, ready, true), "fracturing");
  assert.throws(() => decodeMoonSchedule([extraction, 23], structure + 1, started), /unreadable moon schedule/);
  assert.throws(() => decodeMoonSchedule(null, structure, started), /unreadable moon schedule/);
});

test("the refinery projects ore volumes and the total using the duration and yield multiplier", () => {
  const composition = [{ typeID: 45493, fraction: 0.9754 }, { typeID: 45490, fraction: 0.0246 }];
  const estimate = estimateMoonOutput(composition, 7 * 86_400, 1.024);
  assert.ok(Math.abs(estimate.totalVolume - 5_160_960) < 1e-8);
  assert.deepEqual(estimate.ores.map(ore => [ore.typeID, Math.trunc(ore.volume)]), [
    [45493, 5_034_000], [45490, 126_959],
  ]);
  const later = estimateMoonOutput(composition, 7 * 86_400 + 1800, 1.024);
  assert.ok(Math.abs(later.totalVolume - estimate.totalVolume - 15_360) < 1e-8);
});

test("estimated ore value uses fractional units and totals the unrounded prices", () => {
  const resources = [{ typeID: 45493, fraction: 0.9754 }, { typeID: 45490, fraction: 0.0246 }];
  const quotes = new Map([
    [45493, { unitVolume: 10, unitPrice: 1500 }],
    [45490, { unitVolume: 20, unitPrice: 2345.25 }],
  ]);
  const estimate = estimateMoonOutput(resources, 3600, 1, quotes);
  assert.equal(estimate.totalVolume, 30_000);
  assert.equal(estimate.ores[0]?.price, 4_389_300);
  assert.ok(Math.abs(estimate.ores[1]!.price! - 86_539.725) < 1e-8);
  assert.ok(Math.abs(estimate.totalPrice! - 4_475_839.725) < 1e-8);
  quotes.delete(45490);
  const partial = estimateMoonOutput(resources, 3600, 1, quotes);
  assert.equal(partial.ores[0]?.price, 4_389_300);
  assert.equal(partial.ores[1]?.price, null);
  assert.equal(partial.totalPrice, null);
});

test("refinery composition and scheduling honor the native fraction, duration and role values", () => {
  assert.deepEqual(decodeMoonResources({ type: "dict", entries: [
    [45490, { type: "real", value: 0.0246 }], [45493, 0.9754], [45491, -1],
  ] }), [{ typeID: 45493, fraction: 0.9754 }, { typeID: 45490, fraction: 0.0246 }]);
  assert.equal(moonPullDuration(ready - 1000, started), null);
  assert.equal(moonPullDuration(ready, started), MIN_MOON_PULL_SECONDS);
  assert.equal(moonPullDuration(started + MAX_MOON_PULL_SECONDS * 1000, started), MAX_MOON_PULL_SECONDS);
  assert.equal(moonPullDuration(started + MAX_MOON_PULL_SECONDS * 1000 + 1, started), null);
  assert.equal(canManageMoonPull(98000003, 98000003, "9223372036854775807"), true);
  assert.equal(canManageMoonPull(98000003, 98000004, "2048"), false);
  assert.equal(canManageMoonPull(98000003, 98000003, "1024"), false);
});

test("the native corporation schedule accepts only owned pulls and orders them by chunk ready time", () => {
  const owner = 98000003;
  const system = 30002647;
  const row = (id: number, ownerID: number, delay: number) => ({
    ...extraction, args: { ...extraction.args, entries: [
      ...extraction.args.entries.filter(([key]) => !["extractionID", "chunkAvailableTime", "naturalDecayTime"].includes(String(key))),
      ["extractionID", id], ["ownerID", ownerID], ["solarSystemID", system],
      ["chunkAvailableTime", filetime(ready + delay)], ["naturalDecayTime", filetime(automatic + delay)],
    ] },
  });
  const items = [row(4, owner, 60000), row(6, owner + 1, 0), row(5, owner, 0), extraction, null];
  const pulls = decodeCorporationMoonPulls({ type: "list", items }, owner);
  assert.deepEqual(pulls.map(pull => [pull.id, pull.structureID, pull.solarSystemID, pull.readyAtMs]), [
    [5, structure, system, ready], [4, structure, system, ready + 60000],
  ]);
  assert.deepEqual(decodeCorporationMoonPulls([], owner), []);
  assert.throws(() => decodeCorporationMoonPulls(null, owner), /schedule could not be read/);
});
