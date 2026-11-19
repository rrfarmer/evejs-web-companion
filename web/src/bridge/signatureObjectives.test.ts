import test from "node:test";
import assert from "node:assert/strict";
import { decodeObjectiveChain, ObjectiveChain } from "./abyssObjectives.ts";
import { canEnterDungeonInShip, decodeShipRestrictions, dungeonEntered, dungeonEntryObjectives, dungeonEntryObjectivesToRestart,
  dungeonObjectiveContext, dungeonValuesChanged, enterDungeonRoom, readCurrentDungeon, winterNexusDeposited,
  winterNexusEntryObjectives, type DungeonEntryRule } from "./dungeonTracking.ts";
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

test("filtered hacking targets follow the authored selectors and complete for the hacking pilot", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 121,
    chain: {
      contextParameters: [
        { parameterKey: "normal_cans", parameterType: "integerListType", defaultValue: [60712] },
        { parameterKey: "target_groups", parameterType: "stringListType", defaultValue: ["special"] },
      ],
      objectives: [{ key: "hack_containers", objectiveType: 83, startActive: 1, showCompleted: 1,
        inputParametersMap: { type_ids: "normal_cans", objective_target_groups: "target_groups" } }],
    },
    objectiveTypes: { 83: { tasks: [{ key: "hack", taskType: 54, startActive: 1, showCompleted: 1,
      inputParameters: { type_ids: "type_ids", objective_target_groups: "objective_target_groups" } }] } },
    taskTypes: { 54: { inputParameters: [{ parameterKey: "type_ids" }, { parameterKey: "objective_target_groups" }] } },
    typeLists: {},
  });
  assert.ok(data);
  const pilot = 140000001;
  const chain = new ObjectiveChain(data, {}, pilot);
  const node = { itemID: 101, typeID: 60712, isSelf: false, ownerID: null, hackingSecurityState: 0 } as SpaceEntity;
  const alternate = { ...node, itemID: 102, typeID: 90043, objectiveTargetGroup: "later" };
  const optional = { ...node, itemID: 103, typeID: 90044, objectiveTargetGroup: "special" };
  const generic = { ...node, itemID: 104, typeID: 3060 };
  chain.start([node, alternate, optional, generic]);
  const rows = () => chain.view()[0]?.rows.map(({ itemID, completed }) => [itemID, completed]);
  assert.deepEqual(rows(), [[101, false], [103, false]]);

  const dungeon = dungeonEntered([9238, 27912, null, 422, { target_groups: { type: "list", items: ["later"] } }]);
  assert.ok(dungeon);
  const targetGroups = dungeonObjectiveContext(dungeon).target_groups;
  assert.deepEqual(targetGroups, ["later"]);
  chain.setContext("target_groups", targetGroups ?? null);
  assert.deepEqual(rows(), [[101, false], [102, false]]);

  chain.observe([{ ...node, hackingSecurityState: 2, ownerID: pilot + 1 }, alternate, optional, generic]);
  assert.deepEqual(rows(), [[101, false], [102, false]]);
  chain.observe([{ ...node, hackingSecurityState: 2, ownerID: pilot }, alternate, optional, generic]);
  assert.deepEqual(rows(), [[101, true], [102, false]]);
  chain.observe([{ ...node, hackingSecurityState: 2, ownerID: pilot }, optional, generic]);
  assert.deepEqual(rows(), [[101, true]]);
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

test("Winter Nexus uses the landed grid, ship cargo and native deposit state for its objectives", () => {
  const rules = {
    hackObjectiveKey: "hack_container", depositObjectiveKey: "deposit_mutator_hisec", cargoTypeID: 91019, restartHackMs: 2000,
  };
  const entered = dungeonEntered([9029, 27582, null, 424, {}]);
  assert.ok(entered);
  const hack = [rules.hackObjectiveKey];
  const both = [...hack, rules.depositObjectiveKey];
  assert.deepEqual(winterNexusEntryObjectives(entered, rules, "warping", true, false, []), []);
  assert.deepEqual(winterNexusEntryObjectives(entered, rules, "landed", false, false, []), hack);
  assert.deepEqual(winterNexusEntryObjectives(entered, rules, "landed", true, false, hack), both);
  assert.deepEqual(winterNexusEntryObjectives(entered, rules, "warping", true, false, both), hack);
  assert.deepEqual(winterNexusEntryObjectives(entered, rules, "waiting", false, false, both), both);

  const deposited = dungeonValuesChanged(entered, [9029, { mutator_deposited: "1" }]);
  assert.ok(deposited);
  assert.equal(winterNexusDeposited(deposited), true);
  assert.deepEqual(winterNexusEntryObjectives(deposited, rules, "landed", false, true, both), [rules.depositObjectiveKey]);
  assert.deepEqual(winterNexusEntryObjectives(deposited, rules, "landed", false, false, []), both);
  const failed = dungeonValuesChanged(deposited, [9029, { dungeon_state: "Failure" }]);
  assert.ok(failed);
  assert.deepEqual(winterNexusEntryObjectives(failed, rules, "landed", false, false, both), [rules.depositObjectiveKey]);
});

test("Pochven switches the in-dungeon objectives when the difficulty or wormhole state changes", () => {
  const state = "dungeon_state", difficulty = "current_difficulty", collapsed = "WormholeCollapsed", cooldown = "Cooldown";
  const restartOn = [state, difficulty];
  const rules: readonly DungeonEntryRule[] = [
    { listKey: null, objectiveKey: "warping", duringWarp: true },
    { listKey: null, objectiveKey: "collapsed", when: { key: state, value: collapsed }, restartOn },
    { listKey: null, objectiveKey: "timer", when: { key: state, value: cooldown }, restartOn },
    { listKey: null, objectiveKey: "destroy", unless: { key: state, values: [collapsed, cooldown] }, restartOn },
    { listKey: null, objectiveKey: "medium", when: { key: difficulty, value: "Medium" },
      unless: { key: state, values: [collapsed] }, restartOn },
  ];
  const entered = dungeonEntered([8935, 27490, null, 425, {}]);
  assert.ok(entered);
  assert.deepEqual(dungeonEntryObjectives(entered, rules), ["destroy"]);
  assert.deepEqual(dungeonEntryObjectives(entered, rules, true), ["warping"]);
  const challenged = dungeonValuesChanged(entered, [8935, { [difficulty]: "Medium" }]);
  assert.ok(challenged);
  assert.deepEqual(dungeonEntryObjectives(challenged, rules), ["destroy", "medium"]);
  assert.ok(dungeonEntryObjectivesToRestart(entered, challenged, rules).includes("destroy"));
  const cooling = dungeonValuesChanged(challenged, [8935, { [state]: cooldown }]);
  assert.ok(cooling);
  assert.deepEqual(dungeonEntryObjectives(cooling, rules), ["timer", "medium"]);
  const timerUpdate = dungeonValuesChanged(cooling, [8935, { timer: {} }]);
  assert.ok(timerUpdate);
  assert.deepEqual(dungeonEntryObjectivesToRestart(cooling, timerUpdate, rules), []);
  const closed = dungeonValuesChanged(cooling, [8935, { [state]: collapsed }]);
  assert.ok(closed);
  assert.deepEqual(dungeonEntryObjectives(closed, rules), ["collapsed"]);
});

test("the election approach objective uses the authored trader and live hull-to-hull range", () => {
  const data = decodeObjectiveChain({
    found: true, chainID: 131,
    chain: {
      contextParameters: [
        { parameterKey: "roden_item_trader", parameterType: "unionDictType", defaultValue: { type_id: 92435 } },
        { parameterKey: "the_range", defaultValue: 2500 },
      ],
      objectives: [{ key: "roden_approach_trader", objectiveType: 22, showCompleted: 1,
        inputParametersMap: { target: "roden_item_trader", distance: "the_range" } }],
    },
    objectiveTypes: { 22: { title: "UI/Objectives/Titles/Approach", tasks: [{ key: "get_within_range", taskType: 7,
      startActive: 1, inputParameters: { target: "target", distance: "distance" } }] } },
    taskTypes: { 7: {} }, typeLists: {},
  });
  assert.ok(data);
  const chain = new ObjectiveChain(data, {});
  const entity = (itemID: number, typeID: number, x: number, radius: number, isSelf = false) =>
    ({ itemID, typeID, radius, isSelf, position: { x, y: 0, z: 0 } } as SpaceEntity);
  const self = entity(1, 587, 0, 100, true), decoy = entity(2, 92434, 500, 900);
  const trader = (distance: number) => entity(3, 92435, distance, 900);
  const view = () => chain.view()[0];
  chain.start([self, decoy]);
  chain.startObjective("roden_approach_trader");
  assert.equal(view()?.rows[0]?.typeID, 92435);
  assert.equal(view()?.rows[0]?.itemID, null);
  assert.equal(view()?.rows[0]?.progress, 0);
  chain.observe([self, decoy, trader(11_000)]);
  assert.equal(view()?.rows[0]?.itemID, 3);
  assert.equal(view()?.rows[0]?.progress, 0);
  chain.observe([self, decoy, trader(6000)]);
  assert.ok(Math.abs((view()?.rows[0]?.progress ?? 0) - 2 / 3) < 1e-12);
  chain.observe([self, decoy, trader(3500)]);
  assert.equal(view()?.completed, true);
  assert.deepEqual(view()?.rows, []);
  chain.observe([self, decoy, trader(3600)]);
  assert.equal(view()?.completed, false);
  assert.equal(view()?.rows[0]?.value, "100 m");
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
