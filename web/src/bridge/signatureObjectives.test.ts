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

test("the ghost-site chain shows the revealed native timer on the pilot's simulation clock", () => {
  const chain = decodeObjectiveChain({
    found: true,
    chainID: 115,
    chain: { objectives: [{ key: "hack", objectiveType: 68, startActive: 0, inputParametersMap: { timer: "destruction_timer" } }] },
    objectiveTypes: { 68: { title: "UI/Objectives/Titles/HackContainers", tasks: [
      { key: "timer", taskType: 30, startActive: 1, showCompleted: 0, inputParameters: { timer: "timer" } },
    ] } },
    taskTypes: { 30: { title: "UI/Objectives/Titles/TimeRemaining", inputParameters: [{ parameterKey: "timer" }] } },
    typeLists: {},
  });
  assert.ok(chain);
  const entered = dungeonEntered([5533, 24052, null, 106, { type: "dict", entries: [] }]);
  assert.ok(entered);
  const objective = new ObjectiveChain(chain, dungeonObjectiveContext(entered));
  objective.start([]);
  for (const key of dungeonEntryObjectives(entered, [{ listKey: null, objectiveKey: "hack" }])) objective.startObjective(key);
  assert.equal(objective.view()[0]?.rows.length ?? 0, 0);
  const start = 1_700_000_000_000;
  const filetime = (ms: number) => ({ type: "long", value: String(116444736000000000n + BigInt(ms) * 10_000n) });
  const active = dungeonValuesChanged(entered, [5533, {
    type: "dict", entries: [["destruction_timer", { type: "dict", entries: [
      ["start_time", filetime(start)], ["end_time", filetime(start + 30_000)],
    ] }]],
  }]);
  assert.ok(active);
  const { destruction_timer: timer } = dungeonObjectiveContext(active);
  assert.deepEqual(timer, { startMs: start, endMs: start + 30_000 });
  assert.ok(timer);
  objective.setContext("destruction_timer", timer);
  objective.observe([], start + 9_000);
  assert.equal(objective.view()[0]?.rows[0]?.value, "21s");
  assert.equal(objective.view()[0]?.rows[0]?.progress, 0.7);
  objective.observe([], start + 30_000);
  assert.equal(objective.view()[0]?.rows.length ?? 0, 0);
});

test("the wormhole Destroy task counts live hostile Entity NPCs and picks up later waves", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 155,
    chain: { objectives: [{ key: "destroy", objectiveType: 9, startActive: 0, showCompleted: 1 }] },
    objectiveTypes: { 9: { title: "UI/Objectives/Titles/DestroyTargets", tasks: [
      { key: "destroy_targets", taskType: 14, startActive: 1, showCompleted: 0 },
    ] } },
    taskTypes: { 14: { title: "UI/Objectives/Titles/HostilesRemaining" } },
    typeLists: {},
  });
  assert.ok(data);
  const chain = new ObjectiveChain(data);
  chain.start([]);
  const npc = (itemID: number, overrides: Partial<SpaceEntity> = {}) => ({
    itemID, ownerID: 500021, categoryID: 11, isSelf: false, hostileResponseThreshold: 11, hullRatio: 1, ...overrides,
  } as SpaceEntity);
  const first = npc(101), second = npc(102, { ownerID: 1000002, hostileResponseThreshold: 2 });
  const others = [
    npc(201, { categoryID: 6 }),
    npc(202, { ownerID: 140000001 }),
    npc(203, { hostileResponseThreshold: 0 }),
    npc(204, { ownerID: 1000003, hostileResponseThreshold: 2 }),
    npc(205, { ownerID: null }),
    npc(206, { isSelf: true }),
  ];
  chain.observe([first, second, ...others]);
  chain.startObjective("destroy");
  const row = () => chain.view()[0]?.rows[0];
  assert.equal(row()?.value, "1/1");
  const standing = (owner: number) => owner === 1000002 ? 2 : 3;
  chain.observe([first, second, ...others], null, standing);
  assert.equal(row()?.value, "2/2");
  chain.observe([npc(101, { hullRatio: 0 }), second, ...others]);
  assert.equal(row()?.value, "1/2");
  assert.equal(row()?.progress, 0.5);
  assert.equal(row()?.danger, true);
  chain.observe(others);
  assert.equal(row(), undefined);
  assert.equal(chain.view()[0]?.completed, true);
  chain.observe([...others, npc(103)]);
  assert.equal(row()?.value, "1/3");
  assert.equal(chain.view()[0]?.completed, false);
});
