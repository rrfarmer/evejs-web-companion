import test from "node:test";
import assert from "node:assert/strict";
import { decodeObjectiveChain, ObjectiveChain } from "./abyssObjectives.ts";
import { canEnterDungeonInShip, decodeShipRestrictions, dungeonEntered, dungeonEntryObjectives, dungeonObjectiveContext, dungeonValuesChanged, enterDungeonRoom, readCurrentDungeon } from "./dungeonTracking.ts";
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

test("Observatory Infiltration switches from its lobby gate to the vault counter", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 81,
    chain: { objectives: [
      { key: "lobby", objectiveType: 10, startActive: 0 },
      {
        key: "hack", objectiveType: 74, startActive: 0,
        inputParametersMap: { current: "containers_hacked_current", max: "containers_hacked_max" },
        taskOverrides: { collections: { title: "UI/Objectives/Titles/drifterCollection", icon: "hacking" } },
      },
    ] },
    objectiveTypes: {
      10: { tasks: [{ key: "gate", taskType: 15, startActive: 1 }] },
      74: { tasks: [{ key: "collections", taskType: 9, startActive: 1, inputParameters: { current_value: "current", goal_value: "max" } }] },
    },
    taskTypes: { 15: {}, 9: { inputParameters: [{ parameterKey: "current_value" }, { parameterKey: "goal_value" }] } },
    typeLists: {},
  });
  assert.ok(data);
  const rules = [
    { listKey: null, objectiveKey: "lobby", lobby: true },
    { listKey: null, objectiveKey: "hack" },
  ];
  const lobby = dungeonEntered([12260, 30594, null, 107, {
    lobby_room_id: 30594, containers_hacked_current: 0, containers_hacked_max: 3,
  }]);
  assert.ok(lobby);
  const objective = new ObjectiveChain(data, dungeonObjectiveContext(lobby));
  objective.start([]);
  assert.deepEqual(dungeonEntryObjectives(lobby, rules), ["lobby"]);
  objective.startObjective("lobby");
  assert.equal(objective.view()[0]?.rows.length ?? 0, 0);
  const gate = { itemID: 101, typeID: 17831, groupID: 366, dunObjectID: 1259676, isSelf: false, position: { x: 7000, y: 0, z: 0 } } as SpaceEntity;
  objective.observe([gate]);
  assert.equal(objective.view()[0]?.rows[0]?.itemID, 101);
  assert.equal(objective.view()[0]?.rows[0]?.shipRestrictionGateID, 1259676);

  const next = dungeonEntered([12260, 30563, null, 107, null]);
  assert.ok(next);
  const vault = enterDungeonRoom(lobby, next);
  assert.deepEqual(dungeonEntryObjectives(vault, rules), ["hack"]);
  objective.stopObjective("lobby");
  objective.startObjective("hack");
  assert.equal(objective.view()[0]?.rows[0]?.value, "0/3");
  assert.equal(objective.view()[0]?.rows[0]?.titleLabel, "UI/Objectives/Titles/drifterCollection");
  assert.equal(objective.view()[0]?.rows[0]?.icon, "hacking");

  const failed = dungeonValuesChanged(vault, [12260, {
    dungeon_state: "Lockdown", containers_hacked_current: 0, containers_hacked_max: 3,
  }]);
  assert.ok(failed);
  for (const [key, value] of Object.entries(dungeonObjectiveContext(failed))) objective.setContext(key, value);
  objective.observe([{ itemID: 102, typeID: 85231, isSelf: false, hackingSecurityState: 3 } as SpaceEntity]);
  assert.equal(objective.view()[0]?.rows[0]?.value, "0/3");
  assert.equal(objective.view()[0]?.completed, false);

  const updated = dungeonValuesChanged(failed, [12260, { containers_hacked_current: 1 }]);
  assert.ok(updated);
  for (const [key, value] of Object.entries(dungeonObjectiveContext(updated))) objective.setContext(key, value);
  assert.equal(objective.view()[0]?.rows[0]?.value, "1/3");

  // Graph 883's explosive variant sends a lower count after removing a can.
  const exploded = dungeonValuesChanged(updated, [12260, {
    dungeon_state: "Lockdown", containers_hacked_current: 0, containers_hacked_max: 3,
  }]);
  assert.ok(exploded);
  for (const [key, value] of Object.entries(dungeonObjectiveContext(exploded))) objective.setContext(key, value);
  assert.equal(objective.view()[0]?.rows[0]?.value, "0/3");
  assert.equal(objective.view()[0]?.completed, false);
});

test("a gate's eligibility uses the full native list instead of the ship tree rows", () => {
  const allowed = [{ typeID: 605, groupID: 25 }];
  const restrictions = decodeShipRestrictions({ found: true, allowed, allowedShipTypes: [605, 17715] });
  assert.ok(restrictions);
  assert.equal(canEnterDungeonInShip(restrictions, 605), true);
  assert.equal(canEnterDungeonInShip(restrictions, 17715), true);
  assert.equal(canEnterDungeonInShip(restrictions, 670), false);
  assert.equal(canEnterDungeonInShip(restrictions, null), false);
  assert.equal(canEnterDungeonInShip(null, 670), true);

  const noShips = decodeShipRestrictions({ found: true, allowed, allowedShipTypes: [] });
  assert.ok(noShips);
  assert.equal(canEnterDungeonInShip(noShips, 605), false);
  const oldReply = decodeShipRestrictions({ found: true, allowed });
  assert.ok(oldReply);
  assert.equal(canEnterDungeonInShip(oldReply, 605), true);
});

test("the Observatory lockdown reveals the banner or controller for the current room", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 81,
    chain: { objectives: [
      { key: "lockdown_lobby", objectiveType: 3, title: "UI/Objectives/Titles/observatoryInfiltrationLockdown" },
      { key: "lockdown_disabled", objectiveType: 3, title: "UI/Objectives/Titles/observatoryInfiltrationLockdownDeactivated" },
      { key: "lockdown", objectiveType: 67, showCompleted: 1, inputParametersMap: { container: "security_controller", timer: "lockdown_timer" } },
    ] },
    objectiveTypes: {
      3: { tasks: [] },
      67: { tasks: [
        { key: "hack_container", taskType: 18, startActive: 1, showCompleted: 1, inputParameters: { target: "container" } },
        { key: "timer", taskType: 30, startActive: 1, showCompleted: 0, inputParameters: { timer: "timer" } },
      ] },
    },
    taskTypes: {
      18: { inputParameters: [{ parameterKey: "target" }] },
      30: { title: "UI/Objectives/Titles/TimeRemaining", inputParameters: [{ parameterKey: "timer" }] },
    },
    typeLists: {},
  });
  assert.ok(data);
  const when = (value: string) => ({ key: "dungeon_state", value });
  const rules = [
    { listKey: null, objectiveKey: "lockdown_lobby", lobby: true, when: when("Lockdown") },
    { listKey: null, objectiveKey: "lockdown", when: when("Lockdown") },
    { listKey: null, objectiveKey: "lockdown_disabled", when: when("Deactivated") },
  ];
  const lobby = dungeonEntered([12260, 30594, null, 107, {
    lobby_room_id: 30594, dungeon_state: "Default",
    security_controller: { type: "dict", entries: [["dungeon_object_id", 1259438]] },
  }]);
  assert.ok(lobby);
  assert.deepEqual(dungeonEntryObjectives(lobby, rules), []);
  const start = 1_700_000_000_000;
  const filetime = (ms: number) => ({ type: "long", value: String(116444736000000000n + BigInt(ms) * 10_000n) });
  const locked = dungeonValuesChanged(lobby, [12260, {
    dungeon_state: "Lockdown",
    lockdown_timer: { type: "dict", entries: [["start_time", filetime(start)], ["end_time", filetime(start + 1_800_000)]] },
  }]);
  assert.ok(locked);
  assert.deepEqual(dungeonEntryObjectives(locked, rules), ["lockdown_lobby"]);
  const landing = dungeonEntered([12260, 30563, null, 107, null]);
  assert.ok(landing);
  const vault = enterDungeonRoom(locked, landing);
  assert.deepEqual(dungeonEntryObjectives(vault, rules), ["lockdown"]);
  const pilot = 140000001;
  const objective = new ObjectiveChain(data, dungeonObjectiveContext(vault), pilot);
  objective.start([]);
  objective.startObjective("lockdown");
  const controller = { itemID: 101, typeID: 85362, dunObjectID: 1259438, isSelf: false, hackingSecurityState: 0 } as SpaceEntity;
  objective.observe([{ ...controller, itemID: 102, dunObjectID: 1259768 }, controller]);
  assert.deepEqual(objective.view()[0]?.rows.map(({ itemID, completed }) => [itemID, completed]), [[101, false]]);
  objective.observe([{ ...controller, hackingSecurityState: 2, ownerID: pilot + 1 }]);
  assert.equal(objective.view()[0]?.rows[0]?.completed, false);
  objective.observe([{ ...controller, hackingSecurityState: 2, ownerID: pilot }]);
  assert.equal(objective.view()[0]?.rows[0]?.completed, true);
  objective.observe([controller], start + 30_000);
  const countdown = objective.view()[0]?.rows.find((row) => row.key === "timer");
  assert.equal(countdown?.value, "29m 30s");
  assert.equal(countdown?.progress, 1_770_000 / 1_800_000);

  const deactivated = dungeonValuesChanged(vault, [12260, { dungeon_state: "Deactivated", lockdown_timer: null }]);
  assert.ok(deactivated);
  assert.equal(dungeonObjectiveContext(deactivated).lockdown_timer, null);
  assert.deepEqual(dungeonEntryObjectives(deactivated, rules), ["lockdown_disabled"]);
  objective.stopObjective("lockdown");
  objective.startObjective("lockdown_disabled");
  assert.deepEqual(objective.view().map(({ key, titleOnly }) => [key, titleOnly]), [["lockdown_disabled", true]]);
});
