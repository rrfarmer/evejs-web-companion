import assert from "node:assert/strict";
import test from "node:test";
import { createAchievementTracking } from "./achievementTracking.ts";

test("five tracked achievements are stored in order and share one expanded row per pilot", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const player = createAchievementTracking(140000001, storage);
  for (const id of ["a", "b", "c", "d", "e"]) assert.equal(player.track(id), true);
  assert.equal(player.track("f"), false);
  assert.deepEqual(player.state.get(), { ids: ["a", "b", "c", "d", "e"], expanded: "e" });
  player.toggleExpanded("b");
  assert.deepEqual(createAchievementTracking(140000001, storage).state.get(), { ids: ["a", "b", "c", "d", "e"], expanded: "b" });
  assert.deepEqual(createAchievementTracking(140000002, storage).state.get(), { ids: [], expanded: null });
  player.untrack("b");
  assert.equal(player.track("a"), false);
  assert.deepEqual(player.state.get(), { ids: ["a", "c", "d", "e"], expanded: null });
  assert.equal(player.track("f"), true);
  player.toggleExpanded("f");
  assert.deepEqual(player.state.get(), { ids: ["a", "c", "d", "e", "f"], expanded: null });
});
