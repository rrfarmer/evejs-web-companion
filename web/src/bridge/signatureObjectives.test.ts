import test from "node:test";
import assert from "node:assert/strict";
import { decodeObjectiveChain, ObjectiveChain } from "./abyssObjectives.ts";
import { dungeonEntered, dungeonEntryObjectives, dungeonObjectiveContext, dungeonValuesChanged, enterDungeonRoom, readCurrentDungeon } from "./dungeonTracking.ts";
import type { SpaceEntity } from "../store/types.ts";

test("the authored container objective follows slim state and the hacking pilot", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 102,
    chain: { objectives: [{ key: "hack", objectiveType: 81, startActive: 1, showCompleted: 1 }] },
    objectiveTypes: { 81: { title: "UI/Objectives/Titles/HackContainers", tasks: [{ key: "hack", taskType: 55, startActive: 1, showCompleted: 1 }] } },
    taskTypes: { 55: {} },
    typeLists: {},
  });
  assert.ok(data);
  const pilot = 140000001;
  const chain = new ObjectiveChain(data, {}, pilot);
  const item = (itemID: number, hackingSecurityState?: number, ownerID: number | null = null) =>
    ({ itemID, typeID: 76186, isSelf: false, hackingSecurityState, ownerID } as SpaceEntity);
  const can = item(101, 0), sealed = item(102, 3), unrelated = item(103);
  chain.start([can, sealed, unrelated]);
  const completion = () => chain.view()[0]?.rows.map(({ itemID, completed }) => [itemID, completed]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 1, pilot), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 2, pilot + 1), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 2, pilot), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, true], [102, false]]);
  chain.observe([item(101, 2, pilot), unrelated]);
  assert.deepEqual(completion(), [[101, true]]);
  assert.equal(chain.view()[0]?.completed, true);
});

test("a tracked signature uses its keeper and room-entry lists for graph objective membership", async () => {
  const payload = { type: "dict", entries: [
    ["complete_on_hack", { type: "list", items: [3735] }],
    ["complete_on_explode", { type: "list", items: [] }],
  ] } as const;
  const rules = [
    { listKey: "complete_on_hack", objectiveKey: "hack" },
    { listKey: "complete_on_explode", objectiveKey: "destroy" },
  ];
  const entered = dungeonEntered([3735, 21535, null, 106, payload]);
  const restored = await readCurrentDungeon(async () => [3735, 21535, 106, payload]);
  assert.deepEqual(entered, restored);
  assert.ok(entered);
  assert.deepEqual(dungeonObjectiveContext(entered), {
    dungeon_id: 3735, dungeon_room_id: 21535, complete_on_hack: [3735], complete_on_explode: [],
  });
  assert.deepEqual(dungeonEntryObjectives(entered, rules), ["hack"]);
  assert.equal(dungeonValuesChanged(entered, [3707, payload]), entered);
  const lobby = dungeonValuesChanged(entered, [3735, { lobby_room_id: 21535 }]);
  assert.ok(lobby);
  assert.deepEqual(dungeonEntryObjectives(lobby, rules), []);
  const landing = dungeonEntered([3735, 21536, null, 106, null]);
  assert.ok(landing);
  assert.deepEqual(dungeonEntryObjectives(enterDungeonRoom(lobby, landing), rules), ["hack"]);
  const combat = dungeonEntered([3707, 21505, null, 108, { complete_on_explode: [3707] }]);
  assert.ok(combat);
  assert.deepEqual(dungeonEntryObjectives(combat, rules), ["destroy"]);
  const missing = dungeonEntered([3735, 21535, null, 106, {}]);
  assert.ok(missing);
  assert.deepEqual(dungeonEntryObjectives(missing, rules), []);
});
