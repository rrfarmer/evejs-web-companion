"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { readResourceIndex } = require("../clientData/clientWords");

const CAMERA_EVENTS = Object.freeze({
  zoomIn: "client_mouseZoom_in",
  zoomOut: "client_mouseZoom_out",
  orbit: "client_spinCamera",
});
const CAMERA_TASK_IDS = [60, 61]; // monolith_task_tracker.common.const

function isCameraTaskEvent(value) {
  return typeof value === "string" && Object.hasOwn(CAMERA_EVENTS, value);
}

/** Read AchievementLoader's task conditions and resolve their event names. */
function createCameraTaskDefinitions(clientRoot, clientBuiltData) {
  let read;
  return () => read ??= (async () => {
    if (!clientRoot) return [];
    const [{ readFsdStatic }, index, events] = await Promise.all([
      import("../../tools/client-extract/lib/fsdStatic.mjs"),
      fs.readFile(path.join(clientRoot, "tq", "resfileindex.txt"), "utf8"),
      clientBuiltData.table("achievementEvents"),
    ]);
    const resource = readResourceIndex(index).get("res:/staticdata/achievements.static");
    if (!resource || !events) return [];
    const tasks = readFsdStatic(await fs.readFile(path.join(clientRoot, "ResFiles", resource)));
    return CAMERA_TASK_IDS.flatMap(id => {
      const task = tasks[id];
      if (!task?.isEnabled || !task.isClientAchievement) return [];
      const conditions = Object.values(task.simpleConditions ?? {}).map(row => ({
        event: events[row.statistic]?.name,
        target: row.targetValue,
      }));
      if (!conditions.length || conditions.some(row => !row.event || !Number.isSafeInteger(row.target) || row.target < 1)) return [];
      return [{ id, conditions }];
    });
  })().catch(error => { read = undefined; throw error; });
}

function entries(value) {
  if (value?.type !== "dict" || !Array.isArray(value.entries)) {
    throw new Error("The native task tracker did not return a dictionary.");
  }
  return new Map(value.entries);
}

function wireInteger(value) {
  return BigInt(value?.type === "long" ? value.value : value ?? 0);
}

function nativeDict(table) {
  return { type: "dict", entries: [...table] };
}

function nativeLong(value) {
  return { type: "long", value: value.toString() };
}

/** Persist only camera gestures while keeping all unrelated native counters and completion times. */
async function recordCameraTaskEvents(tasks, events, ask, now = Date.now) {
  const reply = entries(await ask("GetCompletedAchievementsAndClientEventCount", []));
  const completed = new Map([...entries(reply.get("completedDict"))].map(([id, value]) => [Number(wireInteger(id)), value]));
  const counts = entries(reply.get("eventDict"));
  const relevant = (event, task) => !completed.has(task.id) && task.conditions.some(condition => condition.event === event);
  let changed = false;
  for (const kind of events) {
    const event = CAMERA_EVENTS[kind];
    const matching = tasks.filter(task => relevant(event, task));
    if (!matching.length) continue;
    counts.set(event, nativeLong(wireInteger(counts.get(event)) + 1n));
    changed = true;
    for (const { id, conditions } of matching) {
      if (conditions.every(condition => wireInteger(counts.get(condition.event)) >= BigInt(condition.target))) {
        completed.set(id, nativeLong(BigInt(now()) * 10_000n + 116444736000000000n));
      }
    }
  }
  if (changed) await ask("UpdateClientAchievmentsAndCounters", [nativeDict(completed), nativeDict(counts)]);
  return Object.keys(CAMERA_EVENTS).filter(kind => tasks.some(task => relevant(CAMERA_EVENTS[kind], task)));
}

module.exports = { createCameraTaskDefinitions, isCameraTaskEvent, recordCameraTaskEvents };
