// The Abyssal info panel's objectives, as the client keeps them.
//
// THE PANEL (eve/client/script/ui/shared/infoPanels/infoPanelAbyss.py InfoPanelAbyss): headed "Abyssal Deadspace"
// (UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace), shown in an Abyssal system once the abyss service has an
// objective chain (IsAvailable), and drawing that chain (objectives/client/ui/objective_chain.py ObjectiveChainEntry):
// each objective not hidden, by its rendering order, its title over its tasks not hidden (ui/objective.py
// ObjectiveEntry).
//
// THE CHAIN (abyss/client/abyssal_service.py): ABYSS_OBJECTIVE_CHAIN_ID, started at the pocket's first
// OnAbyssalLocationEntered(client_data) with the context's rooms_completed the client_data's location_id less one; at
// each later one rooms_completed set again, and the objective "destroy_lootable" stopped and started two seconds later
// (75 to 93); stopped where the session leaves Abyssal space (195 to 207). When the task "destroy_npcs" completes in
// the last room the rooms completed go up by one (on_objective_task_changed, 95 to 102).
//
// THE ENGINE (objectives/client): the chain's context starts with its parameters' defaults (objective_chain.py
// _get_objective_chain_default_values; set_default_values sets only what has no value); each objective of the chain
// that starts active is made and started, its values its chain's context's (inputParametersMap), each change of the
// context passed on (_context_value_changed). An objective (objective/base.py) is made with every task of its type,
// each task's values its objective's (inputParameters); it starts the tasks that start active, runs a task's triggers
// on each change of its state (task_trigger: start_task, stop_task), and is complete where every active task is
// (_check_completed_state), hidden where complete and not shown completed. A task (objective_task/base.py) is hidden
// where not active, or complete and not shown completed.
//
// The task types drawn here:
//   9  ProgressTask (generic.py): current_value of goal_value, "n/m" and a bar; hidden with no goal; complete at it.
//   14 DestroyHostileTargetsTask (destroy_counter.py): uses the same counter for hostile category-Entity NPCs.
//   45 DestroyTargetsCounterTask (destroy_counter.py): the things on the grid that its type list, types or groups
//      name, but the ship itself, counted from its start (_find_targets) and as they come (OnBallAdded); one is
//      destroyed at no hull (OnDamageStateChange) or gone (OnObjectExplode, DoBallRemove). "left/all" and a red bar of
//      what is left; hidden with none; complete with some and none left. Started again while active, it forgets them
//      and counts only what comes after.
//   52 DestroyTargetsTask (destroy_target.py): one row for each such thing (BaseTargetsTask), its name and its hull,
//      armour and shield bars in red (EnemyTargetWidget), complete at no hull; a row goes with its thing (DoBallRemove).
//      The group complete where all its rows are (_update_completed_state).
//   56 JumpThroughAbyssGate (abyss.py): in an Abyssal system, the warp gate closest to the ship (TargetTask
//      _find_target: FindClosestObject(group_id=groupWarpGate)), by its name; complete when the jump through it starts
//      (OnClientEvent_JumpStarted).
//
// The jump's start is the travel effect the server plays on the pilot's ship (subwaySvc.OnSpecialFX,
// PreJumpServiceCalls), which the game port hands on to the page (gamePort/pilots.js).
//
// Not as the client has it yet: a thing's name is its type's (the client's is its slim item's nameID message where it
// has one); the icons are not the client's; the chain's context-parameter triggers (none in the Abyss chain) are not
// run.

import { isNpcOwner } from "./mail.ts";
import { GROUP_WARP_GATE } from "./gateActivation.ts";
import { readDictEntry, unwrapLong, type JsonValue } from "./wire.ts";
import type { SpaceEntity } from "../store/types.ts";
import { formatInterval } from "./clientWords.ts";
import type { ObjectiveTarget, ObjectiveTimer, ObjectiveValue as Value } from "./dungeonTracking.ts";

/** abyss/client/abyssal_service.py ABYSS_OBJECTIVE_CHAIN_ID. */
export const ABYSS_OBJECTIVE_CHAIN_ID = 95;
/** InfoPanelAbyss.label: the panel's header. */
export const ABYSS_PANEL_LABEL = "UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace";
/** abyssal_service.py OnAbyssalLocationEntered: the objective stopped and started again in each room after the first. */
export const ABYSS_LOOTABLE_OBJECTIVE = "destroy_lootable";
/** abyssal_service.py: how long it is left stopped (uthread2.sleep(2)). */
export const ABYSS_LOOTABLE_RESTART_MS = 2_000;
/** abyssal_service.py on_objective_task_changed: the task whose completion in the last room counts that room. */
const ABYSS_NPC_TASK = "destroy_npcs";

const TASK_PROGRESS = 9;
const TASK_DESTROY_HOSTILES = 14;
const TASK_ENTER_NEXT_DUNGEON_ROOM = 15;
const TASK_HACK_CONTAINER = 18;
const CATEGORY_ENTITY = 11;
const TASK_TIMER = 30;
const TASK_DESTROY_COUNTER = 45;
const TASK_DESTROY_TARGETS = 52;
const TASK_HACK_CONTAINERS = 54;
const TASK_HACK_ALL_CONTAINERS = 55;
const TASK_JUMP_THROUGH_ABYSS_GATE = 56;
const HACKED = 2; // hackingcommon.hackingConstants.hackingStateHacked

const timerOf = (value: Value | undefined): ObjectiveTimer | null =>
  value && typeof value === "object" && "endMs" in value ? value : null;

interface TriggerInfo {
  readonly action: string;
  readonly taskKey: string;
}
interface TaskInfo {
  readonly key: string;
  readonly taskType: number;
  readonly title: string | null;
  readonly icon: string | null;
  readonly startActive: boolean;
  readonly showCompleted: boolean;
  /** The task's own parameter by the objective's value it takes. */
  readonly inputParameters: Readonly<Record<string, string>>;
  readonly triggers: Readonly<Record<string, readonly TriggerInfo[]>>;
}
interface ObjectiveTypeInfo {
  readonly title: string | null;
  readonly tasks: readonly TaskInfo[];
}
interface TaskTypeInfo {
  readonly title: string | null;
  readonly icon: string | null;
  readonly parameterKeys: readonly string[];
}
interface ObjectiveInfo {
  readonly key: string;
  readonly objectiveType: number;
  readonly title: string | null;
  readonly startActive: boolean;
  readonly showCompleted: boolean;
  /** The objective's value by the context's key it takes. */
  readonly inputParametersMap: Readonly<Record<string, string>>;
  readonly taskOverrides: Readonly<Record<string, { readonly title: string | null; readonly icon: string | null }>>;
  readonly renderingOrder: number;
}

/** An objective chain as the BFF answers it (GET /api/objectives/chain: the client's own data). */
export interface ObjectiveChainData {
  readonly chainID: number;
  readonly defaults: Readonly<Record<string, Value>>;
  readonly objectives: readonly ObjectiveInfo[];
  readonly objectiveTypes: ReadonlyMap<number, ObjectiveTypeInfo>;
  readonly taskTypes: ReadonlyMap<number, TaskTypeInfo>;
  /** evetypes.GetTypeIDsByListID of each type list the context names. */
  readonly typeLists: ReadonlyMap<number, ReadonlySet<number>>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const whole = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
};
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const flag = (value: unknown): boolean => value === true || value === 1;
const strings = (value: unknown): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(record(value) ?? {})) if (typeof inner === "string") out[key] = inner;
  return out;
};
/** objectives.common.util.fix_fsd_value, for a context default: a list as a list, a number or a word as itself. */
const fsdValue = (value: unknown, parameterType: unknown): Value => {
  if (Array.isArray(value)) {
    return parameterType === "stringListType"
      ? value.filter((item): item is string => typeof item === "string")
      : value.map(whole).filter((id): id is number => id !== null);
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return null;
};

function decodeTask(value: unknown): TaskInfo | null {
  const row = record(value);
  const key = text(row?.key);
  const taskType = whole(row?.taskType);
  if (row === null || key === null || taskType === null) return null;
  const triggers: Record<string, TriggerInfo[]> = {};
  for (const [reason, actions] of Object.entries(record(row.triggers) ?? {})) {
    triggers[reason] = list(actions).flatMap((action) => {
      const entry = record(action);
      const name = text(entry?.action);
      const taskKey = text(entry?.taskKey);
      return name !== null && taskKey !== null ? [{ action: name, taskKey }] : [];
    });
  }
  return {
    key, taskType, title: text(row.title), icon: text(row.icon), startActive: flag(row.startActive),
    showCompleted: flag(row.showCompleted), inputParameters: strings(row.inputParameters), triggers,
  };
}

/** The BFF's answer read; null where the chain was not found. */
export function decodeObjectiveChain(data: Readonly<Record<string, JsonValue>>): ObjectiveChainData | null {
  const chain = record(data.chain);
  const chainID = whole(data.chainID);
  if (data.found !== true || chain === null || chainID === null) return null;
  const defaults: Record<string, Value> = {};
  for (const parameter of list(chain.contextParameters)) {
    const row = record(parameter);
    const key = text(row?.parameterKey);
    if (key !== null && row !== null && row.defaultValue !== undefined && row.defaultValue !== null) {
      defaults[key] = fsdValue(row.defaultValue, row.parameterType);
    }
  }
  const objectives = list(chain.objectives).flatMap((value): ObjectiveInfo[] => {
    const row = record(value);
    const key = text(row?.key);
    const objectiveType = whole(row?.objectiveType);
    if (row === null || key === null || objectiveType === null) return [];
    const taskOverrides = Object.fromEntries(Object.entries(record(row.taskOverrides) ?? {}).map(([taskKey, value]) => {
      const override = record(value);
      return [taskKey, { title: text(override?.title), icon: text(override?.icon) }];
    }));
    return [{
      key, objectiveType, title: text(row.title), startActive: flag(row.startActive), showCompleted: flag(row.showCompleted),
      inputParametersMap: strings(row.inputParametersMap), taskOverrides, renderingOrder: whole(row.renderingOrder) || 5,
    }];
  });
  const objectiveTypes = new Map<number, ObjectiveTypeInfo>();
  for (const [key, value] of Object.entries(record(data.objectiveTypes) ?? {})) {
    const row = record(value);
    const id = whole(key);
    if (row !== null && id !== null) {
      objectiveTypes.set(id, { title: text(row.title), tasks: list(row.tasks).map(decodeTask).filter((task): task is TaskInfo => task !== null) });
    }
  }
  const taskTypes = new Map<number, TaskTypeInfo>();
  for (const [key, value] of Object.entries(record(data.taskTypes) ?? {})) {
    const row = record(value);
    const id = whole(key);
    if (row !== null && id !== null) {
      taskTypes.set(id, {
        title: text(row.title), icon: text(row.icon),
        parameterKeys: list(row.inputParameters).map((parameter) => text(record(parameter)?.parameterKey)).filter((key): key is string => key !== null),
      });
    }
  }
  const typeLists = new Map<number, ReadonlySet<number>>();
  for (const [key, value] of Object.entries(record(data.typeLists) ?? {})) {
    const id = whole(key);
    if (id !== null && Array.isArray(value)) typeLists.set(id, new Set(value.map(whole).filter((typeID): typeID is number => typeID !== null)));
  }
  return { chainID, defaults, objectives, objectiveTypes, taskTypes, typeLists };
}

/** OnAbyssalLocationEntered's client_data: its location_id, the room (1 for the first); null where it cannot be read. */
export function abyssalLocationEntered(clientData: unknown): number | null {
  const value = readDictEntry(clientData, "location_id");
  const room = typeof value === "number" ? value : value === undefined ? null : Number(unwrapLong(value) ?? NaN);
  return room !== null && Number.isSafeInteger(room) && room > 0 ? room : null;
}

/** objectives.common.util.value_as_set. */
function valueAsSet(value: Value | undefined): ReadonlySet<number> {
  if (Array.isArray(value)) return new Set(value.filter((item): item is number => typeof item === "number"));
  return typeof value === "number" && value !== 0 ? new Set([value]) : new Set();
}

interface Task {
  readonly info: TaskInfo;
  readonly type: TaskTypeInfo | undefined;
  readonly values: Record<string, Value>;
  active: boolean;
  completed: boolean;
  /** 45: what it counts, and what of it is destroyed. */
  readonly targets: Set<number>;
  readonly destroyed: Set<number>;
  /** 52: its rows, each complete or not. */
  readonly rows: Map<number, boolean>;
  /** 56: the gate it found. */
  gateID: number | null;
}
interface Objective {
  readonly info: ObjectiveInfo;
  readonly title: string | null;
  readonly values: Record<string, Value>;
  readonly tasks: Map<string, Task>;
  active: boolean;
  completed: boolean;
  starting: boolean;
  triggering: boolean;
}

/** One line of a task as the panel draws it. */
export interface AbyssTaskRow {
  readonly key: string;
  /** The task's icon by the client's name for it (eveicon); null for a target's row. */
  readonly icon: string | null;
  /** A label for its words, or null where it is named by its thing. */
  readonly titleLabel: string | null;
  /** Its thing: a target's or the gate's; null for a task with none. */
  readonly itemID: number | null;
  readonly typeID: number | null;
  /** The authored gate object for EnterNextDungeonRoom's Ship Restrictions task. */
  readonly shipRestrictionGateID?: number;
  readonly value: string;
  /** Its bar, 0 to 1; null for none. */
  readonly progress: number | null;
  /** The bar in the danger colour (_DestroyTargetsCounterTask.progress_bar_color). */
  readonly danger: boolean;
  readonly completed: boolean;
  /** A target's hull, armour and shield, 0 to 1 (EnemyTargetWidget). */
  readonly health: { readonly hull: number; readonly armor: number; readonly shield: number } | null;
}
export interface AbyssObjectiveRow {
  readonly key: string;
  readonly titleLabel: string | null;
  readonly completed: boolean;
  readonly titleOnly: boolean;
  readonly rows: readonly AbyssTaskRow[];
}

/** eveformat.number(value, 0). */
const count = (value: number): string => Math.round(value).toLocaleString("en-US");

/** A task's look at the whole grid, not only at what was just added. */
const FIND = Symbol("find");

/** An authored chain observed from the local ballpark and the pilot's context. */
export class ObjectiveChain {
  private readonly data: ObjectiveChainData;
  private readonly pilotID: number | null;
  readonly context: Record<string, Value> = {};
  private readonly objectives = new Map<string, Objective>();
  private entities: readonly SpaceEntity[] = [];
  private simNowMs: number | null = null;
  private npcStanding: (ownerID: number) => number | null = () => null;
  /** What was on the grid at the last look: a thing not among it is one just added (OnBallAdded). */
  private seen: ReadonlySet<number> = new Set();

  constructor(data: ObjectiveChainData, context: Readonly<Record<string, Value>> = {}, pilotID: number | null = null) {
    this.data = data;
    this.pilotID = pilotID;
    Object.assign(this.context, context);
    // set_default_values: only what has no value yet.
    for (const [key, value] of Object.entries(data.defaults)) if (this.context[key] === undefined || this.context[key] === null) this.context[key] = value;
  }

  /** ObjectiveChain.start: each objective that starts active. */
  start(entities: readonly SpaceEntity[]): void {
    this.entities = entities;
    this.seen = new Set(entities.map((entity) => entity.itemID));
    for (const info of this.data.objectives) if (info.startActive) this.startObjective(info.key);
  }

  /** A context value changed (Blackboard.update), passed on to the objectives that take it. */
  setContext(key: string, value: Value): void {
    if (this.context[key] === value) return;
    this.context[key] = value;
    for (const objective of this.objectives.values()) {
      for (const [objectiveKey, contextKey] of Object.entries(objective.info.inputParametersMap)) {
        if (contextKey === key) this.objectiveValue(objective, objectiveKey, value);
      }
    }
  }

  /** ObjectiveChain.start_objective. */
  startObjective(key: string): void {
    if (!this.objectives.has(key)) this.makeObjective(key);
    const objective = this.objectives.get(key);
    if (!objective || objective.active) return;
    objective.active = true;
    objective.starting = true;
    for (const task of objective.tasks.values()) if (task.info.startActive) this.startTask(objective, task);
    objective.starting = false;
    this.checkObjective(objective);
  }

  /** ObjectiveChain.stop_objective: stopped, and let go. */
  stopObjective(key: string): void {
    const objective = this.objectives.get(key);
    if (!objective) return;
    objective.active = false;
    for (const task of objective.tasks.values()) this.stopTask(objective, task);
    this.objectives.delete(key);
  }

  /** What is on the grid now: the targets counted, listed and found (OnBallAdded, OnDamageStateChange, DoBallRemove). */
  observe(entities: readonly SpaceEntity[], simNowMs = this.simNowMs, npcStanding = this.npcStanding): void {
    this.simNowMs = simNowMs;
    this.npcStanding = npcStanding;
    this.entities = entities;
    const added = new Set(entities.filter((entity) => !this.seen.has(entity.itemID)).map((entity) => entity.itemID));
    this.seen = new Set(entities.map((entity) => entity.itemID));
    for (const objective of [...this.objectives.values()]) {
      for (const task of objective.tasks.values()) if (task.active) this.observeTask(objective, task, added);
    }
  }

  /** OnClientEvent_JumpStarted(gate_id): a jump through a gate begun. */
  jumpStarted(gateID: number): void {
    for (const objective of [...this.objectives.values()]) {
      for (const task of objective.tasks.values()) {
        if (task.active && task.info.taskType === TASK_JUMP_THROUGH_ABYSS_GATE && task.gateID === gateID) this.setCompleted(objective, task, true);
      }
    }
  }

  /** The panel's objectives: those not hidden, by rendering order, each with its tasks not hidden. */
  view(): readonly AbyssObjectiveRow[] {
    const shown = [...this.objectives.values()].filter((objective) => !this.objectiveHidden(objective));
    shown.sort((a, b) => a.info.renderingOrder - b.info.renderingOrder);
    return shown.map((objective) => ({
      key: objective.info.key,
      titleLabel: objective.title,
      completed: objective.completed,
      titleOnly: objective.tasks.size === 0,
      rows: [...objective.tasks.values()].filter((task) => !this.taskHidden(task)).flatMap((task) => this.taskRows(task)),
    }));
  }

  private makeObjective(key: string): void {
    const info = this.data.objectives.find((objective) => objective.key === key);
    const type = info ? this.data.objectiveTypes.get(info.objectiveType) : undefined;
    if (!info || !type) return;
    const values: Record<string, Value> = {};
    for (const [objectiveKey, contextKey] of Object.entries(info.inputParametersMap)) values[objectiveKey] = this.context[contextKey] ?? null;
    const tasks = new Map<string, Task>();
    for (const taskInfo of type.tasks) {
      const taskValues: Record<string, Value> = {};
      for (const [taskKey, objectiveKey] of Object.entries(taskInfo.inputParameters)) {
        if (objectiveKey in values) taskValues[taskKey] = values[objectiveKey] ?? null;
      }
      const override = info.taskOverrides[taskInfo.key];
      tasks.set(taskInfo.key, {
        info: override ? { ...taskInfo, title: override.title ?? taskInfo.title, icon: override.icon ?? taskInfo.icon } : taskInfo,
        type: this.data.taskTypes.get(taskInfo.taskType), values: taskValues, active: false, completed: false,
        targets: new Set(), destroyed: new Set(), rows: new Map(), gateID: null,
      });
    }
    // Objective: its own title, else its type's.
    this.objectives.set(key, { info, title: info.title ?? type.title, values, tasks, active: false, completed: false, starting: false, triggering: false });
  }

  /** Objective.update_value: the value kept, and passed on to its tasks that take it (ObjectiveTask.update_value). */
  private objectiveValue(objective: Objective, key: string, value: Value): void {
    objective.values[key] = value;
    for (const task of objective.tasks.values()) {
      for (const [taskKey, objectiveKey] of Object.entries(task.info.inputParameters)) {
        if (objectiveKey !== key || !(task.type?.parameterKeys.includes(taskKey) ?? false)) continue;
        task.values[taskKey] = value;
        this.taskValueChanged(objective, task, taskKey);
      }
    }
  }

  private taskValueChanged(objective: Objective, task: Task, key: string): void {
    switch (task.info.taskType) {
      case TASK_TIMER:
        if (task.active) this.updateTimer(objective, task);
        return;
      case TASK_PROGRESS:
        if (key === "current_value") task.values.current_value = Math.min(Number(task.values.current_value) || 0, Number(task.values.goal_value) || 0);
        if (task.active) this.updateProgress(objective, task);
        return;
      case TASK_DESTROY_COUNTER:
        // _parameter_updated: what it counts forgotten, and looked for again on the whole grid (_find_targets).
        task.targets.clear();
        task.destroyed.clear();
        if (task.active) this.observeTask(objective, task, FIND);
        return;
      case TASK_ENTER_NEXT_DUNGEON_ROOM:
        task.gateID = null;
        if (task.active) this.observeTask(objective, task, FIND);
        return;
      case TASK_HACK_CONTAINER:
      case TASK_HACK_CONTAINERS:
      case TASK_DESTROY_TARGETS:
        task.rows.clear();
        if (task.active) this.observeTask(objective, task, FIND);
        return;
      default:
    }
  }

  private startTask(objective: Objective, task: Task): void {
    const taskType = task.info.taskType;
    const counter = taskType === TASK_DESTROY_COUNTER || taskType === TASK_DESTROY_HOSTILES;
    if (counter || taskType === TASK_DESTROY_TARGETS || taskType === TASK_HACK_CONTAINERS || taskType === TASK_HACK_ALL_CONTAINERS) {
      // Both forget what they had (_DestroyTargetsCounterTask.start, BaseTargetsTask.start); started while active, the
      // counter counts only what comes after, and the list waits for what comes.
      task.targets.clear();
      task.destroyed.clear();
      task.rows.clear();
      if (task.active) {
        if (counter) this.updateCounter(objective, task);
        return;
      }
    }
    if (task.active) return;
    this.setActive(objective, task, true);
    if (task.info.taskType === TASK_JUMP_THROUGH_ABYSS_GATE) {
      task.gateID = null;
      this.setCompleted(objective, task, false);
    }
    this.observeTask(objective, task, FIND);
  }

  private stopTask(objective: Objective, task: Task): void {
    if (!task.active) return;
    if (task.info.taskType === TASK_JUMP_THROUGH_ABYSS_GATE) task.gateID = null;
    this.setActive(objective, task, false);
  }

  private matches(task: Task, entity: SpaceEntity): boolean {
    if (entity.isSelf) return false;
    if (task.info.taskType === TASK_DESTROY_HOSTILES) {
      const threshold = entity.hostileResponseThreshold ?? 0;
      if (entity.categoryID !== CATEGORY_ENTITY || entity.ownerID === null || !isNpcOwner(entity.ownerID) || threshold <= 0) return false;
      const standing = this.npcStanding(entity.ownerID);
      return threshold >= 10 || (standing !== null && standing <= threshold);
    }
    const typeIDs = valueAsSet(task.values.type_ids);
    const groupIDs = valueAsSet(task.values.group_ids);
    const listID = Number(task.values.type_list_id) || 0;
    const listed = listID > 0 ? this.data.typeLists.get(listID) : undefined;
    const itemIDs = valueAsSet(task.values.item_ids);
    const dungeonObjectIDs = valueAsSet(task.values.dungeon_object_ids);
    const targetGroups = task.values.objective_target_groups;
    const targetGroup = entity.objectiveTargetGroup;
    return (targetGroup != null && (Array.isArray(targetGroups) ? targetGroups.includes(targetGroup) : targetGroups === targetGroup)) ||
      (entity.typeID !== null && typeIDs.has(entity.typeID)) ||
      (entity.groupID !== null && groupIDs.has(entity.groupID)) ||
      (entity.typeID !== null && listed !== undefined && listed.has(entity.typeID)) ||
      itemIDs.has(entity.itemID) ||
      (entity.dunObjectID !== undefined && entity.dunObjectID !== null && dungeonObjectIDs.has(entity.dunObjectID));
  }

  private closestEntity(matches: (entity: SpaceEntity) => boolean): SpaceEntity | null {
    const self = this.entities.find((entity) => entity.isSelf);
    let closest: SpaceEntity | null = null;
    let closestDistance = Infinity;
    for (const entity of this.entities) {
      if (entity.isSelf || !matches(entity)) continue;
      const distance = self
        ? Math.hypot(entity.position.x - self.position.x, entity.position.y - self.position.y, entity.position.z - self.position.z)
        : 0;
      if (distance < closestDistance) {
        closest = entity;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private findTarget(target: ObjectiveTarget): SpaceEntity | null {
    if (target.itemID !== null) return this.closestEntity((entity) => entity.itemID === target.itemID);
    if (target.dungeonObjectID !== null) return this.closestEntity((entity) => entity.dunObjectID === target.dungeonObjectID);
    return this.closestEntity((entity) =>
      (target.typeID === null || entity.typeID === target.typeID) &&
      (target.groupID === null || entity.groupID === target.groupID));
  }

  private hackComplete(task: Task, entity: SpaceEntity): boolean {
    return entity.hackingSecurityState === HACKED &&
      (task.values.personal_only === false || (this.pilotID !== null && entity.ownerID === this.pilotID));
  }

  /**
   * A task's look at the grid: on the whole of it where it looks for its targets (FIND: _find_targets at its start or
   * a change of what it is after), else at the things just added (OnBallAdded); and at what became of what it has.
   */
  private observeTask(objective: Objective, task: Task, added: ReadonlySet<number> | typeof FIND): void {
    if (task.info.taskType === TASK_TIMER) {
      this.updateTimer(objective, task);
      return;
    }
    const present = new Map(this.entities.map((entity) => [entity.itemID, entity] as const));
    const finding = added === FIND;
    const looked = finding ? this.entities : this.entities.filter((entity) => added.has(entity.itemID));
    switch (task.info.taskType) {
      case TASK_PROGRESS:
        this.updateProgress(objective, task);
        return;
      case TASK_DESTROY_HOSTILES:
      case TASK_DESTROY_COUNTER:
        // Standing data can finish loading after the NPC first appears.
        for (const entity of task.info.taskType === TASK_DESTROY_HOSTILES ? this.entities : looked) {
          if (this.matches(task, entity)) task.targets.add(entity.itemID);
        }
        for (const itemID of task.targets) {
          const entity = present.get(itemID);
          if (entity === undefined || entity.hullRatio === 0) task.destroyed.add(itemID);
        }
        this.updateCounter(objective, task);
        return;
      case TASK_HACK_CONTAINER: {
        const target = task.values.target;
        const entity = target && typeof target === "object" && "itemID" in target ? this.findTarget(target) : null;
        const complete = entity !== null && this.hackComplete(task, entity);
        task.rows.clear();
        if (entity !== null) task.rows.set(entity.itemID, complete);
        this.setCompleted(objective, task, complete);
        return;
      }
      case TASK_DESTROY_TARGETS:
      case TASK_HACK_CONTAINERS:
      case TASK_HACK_ALL_CONTAINERS: {
        const hackAll = task.info.taskType === TASK_HACK_ALL_CONTAINERS;
        const complete = (entity: SpaceEntity) => task.info.taskType === TASK_DESTROY_TARGETS
          ? entity.hullRatio === 0
          : this.hackComplete(task, entity);
        let changed = false;
        for (const itemID of [...task.rows.keys()]) {
          const entity = present.get(itemID);
          if (entity === undefined) {
            task.rows.delete(itemID);
            changed = true;
          } else if (task.rows.get(itemID) !== complete(entity)) {
            task.rows.set(itemID, complete(entity));
            changed = true;
          }
        }
        for (const entity of looked) {
          const matches = hackAll ? !entity.isSelf && entity.hackingSecurityState !== undefined : this.matches(task, entity);
          if (task.rows.has(entity.itemID) || !matches) continue;
          task.rows.set(entity.itemID, complete(entity));
          changed = true;
        }
        // _update_completed_state: complete where every row is; asked at a change, and at a look for targets only with
        // some found (all_tasks_added).
        if (finding ? task.rows.size > 0 : changed) this.setCompleted(objective, task, [...task.rows.values()].every(Boolean));
        return;
      }
      case TASK_ENTER_NEXT_DUNGEON_ROOM:
      case TASK_JUMP_THROUGH_ABYSS_GATE: {
        if (task.gateID !== null) return;
        const gateObjectID = Number(task.values.gate_id) || 0;
        const closest = this.closestEntity((entity) =>
          entity.groupID === GROUP_WARP_GATE && (gateObjectID <= 0 || entity.dunObjectID === gateObjectID));
        if (closest !== null) task.gateID = closest.itemID;
        return;
      }
      default:
    }
  }

  private updateProgress(objective: Objective, task: Task): void {
    const goal = Number(task.values.goal_value) || 0;
    const current = Number(task.values.current_value) || 0;
    this.setCompleted(objective, task, goal > 0 && current >= goal);
  }

  private updateCounter(objective: Objective, task: Task): void {
    const left = task.targets.size - task.destroyed.size;
    this.setCompleted(objective, task, task.targets.size > 0 && left === 0);
  }

  private setActive(objective: Objective, task: Task, value: boolean): void {
    if (task.active === value) return;
    task.active = value;
    this.taskChanged(objective, task, value ? "on_start" : "on_stop");
  }

  private updateTimer(objective: Objective, task: Task): void {
    const timer = timerOf(task.values.timer);
    this.setCompleted(objective, task, timer === null || (this.simNowMs !== null && timer.endMs <= this.simNowMs));
  }

  private setCompleted(objective: Objective, task: Task, value: boolean): void {
    if (task.completed === value) return;
    task.completed = value;
    this.taskChanged(objective, task, value ? "on_complete" : "on_incomplete");
  }

  /** Objective._task_state_changed: the task's triggers, the abyss service's word, the objective's completion. */
  private taskChanged(objective: Objective, task: Task, reason: string): void {
    const actions = task.info.triggers[reason] ?? [];
    if (actions.length > 0) {
      objective.triggering = true;
      for (const action of actions) {
        const target = objective.tasks.get(action.taskKey);
        if (!target) continue;
        if (action.action === "start_task") this.startTask(objective, target);
        else if (action.action === "stop_task") this.stopTask(objective, target);
      }
      objective.triggering = false;
    }
    // abyssal_service.on_objective_task_changed: the last room's NPCs gone, that room counted.
    if (task.info.key === ABYSS_NPC_TASK && reason === "on_complete") {
      const roomsCompleted = Number(this.context.rooms_completed) || 0;
      if (roomsCompleted + 1 >= (Number(this.context.num_rooms) || 0)) this.setContext("rooms_completed", roomsCompleted + 1);
    }
    this.checkObjective(objective);
  }

  private checkObjective(objective: Objective): void {
    if (objective.starting || objective.triggering || !objective.active || objective.tasks.size === 0) return;
    objective.completed = [...objective.tasks.values()].every((task) => !task.active || task.completed);
  }

  private objectiveHidden(objective: Objective): boolean {
    return !objective.active || (objective.completed && !objective.info.showCompleted);
  }

  private taskHidden(task: Task): boolean {
    if (!task.active || (task.completed && !task.info.showCompleted)) return true;
    switch (task.info.taskType) {
      case TASK_TIMER:
        return this.simNowMs === null || timerOf(task.values.timer) === null;
      case TASK_PROGRESS:
        return !(Number(task.values.goal_value) > 0);
      case TASK_DESTROY_HOSTILES:
      case TASK_DESTROY_COUNTER:
        return task.targets.size === 0;
      case TASK_ENTER_NEXT_DUNGEON_ROOM:
      case TASK_JUMP_THROUGH_ABYSS_GATE:
        return task.gateID === null;
      case TASK_HACK_CONTAINER:
        return task.rows.size === 0;
      case TASK_DESTROY_TARGETS:
      case TASK_HACK_CONTAINERS:
      case TASK_HACK_ALL_CONTAINERS:
        return false;
      default:
        return true;
    }
  }

  private taskRows(task: Task): AbyssTaskRow[] {
    const icon = task.info.icon ?? task.type?.icon ?? null;
    const titleLabel = task.info.title ?? task.type?.title ?? null;
    const base = { key: task.info.key, icon, titleLabel, itemID: null, typeID: null, value: "", progress: null, danger: false, completed: task.completed, health: null };
    switch (task.info.taskType) {
      case TASK_TIMER: {
        const timer = timerOf(task.values.timer);
        if (timer === null || this.simNowMs === null) return [];
        const remaining = Math.max(0, timer.endMs - this.simNowMs);
        const progress = Math.min(1, remaining / (timer.endMs - timer.startMs));
        return [{ ...base, value: formatInterval(remaining * 10_000), progress }];
      }
      case TASK_PROGRESS: {
        const goal = Number(task.values.goal_value) || 0;
        const current = Number(task.values.current_value) || 0;
        // display_percentage: asked for, or a goal of a million or more.
        const percentage = task.values.display_percentage === true || goal >= 1_000_000;
        return [{ ...base, value: percentage ? `${Math.trunc((current / goal) * 100)}%` : `${count(current)}/${count(goal)}`, progress: Math.min(current / goal, 1) }];
      }
      case TASK_DESTROY_HOSTILES:
      case TASK_DESTROY_COUNTER: {
        const all = task.targets.size;
        const left = all - task.destroyed.size;
        return [{ ...base, value: `${count(left)}/${count(all)}`, progress: all > 0 ? left / all : 0, danger: true }];
      }
      case TASK_ENTER_NEXT_DUNGEON_ROOM:
      case TASK_JUMP_THROUGH_ABYSS_GATE: {
        const gate = this.entities.find((entity) => entity.itemID === task.gateID);
        const gateObjectID = gate?.dunObjectID;
        const restriction = task.info.taskType === TASK_ENTER_NEXT_DUNGEON_ROOM && gateObjectID
          ? { shipRestrictionGateID: gateObjectID } : {};
        return [{ ...base, titleLabel: null, itemID: task.gateID, typeID: gate?.typeID ?? null, ...restriction }];
      }
      case TASK_HACK_CONTAINER:
      case TASK_DESTROY_TARGETS:
      case TASK_HACK_CONTAINERS:
      case TASK_HACK_ALL_CONTAINERS:
        return [...task.rows.entries()].map(([itemID, done]) => {
          const entity = this.entities.find((thing) => thing.itemID === itemID);
          return {
            ...base, key: `${task.info.key}:${itemID}`, icon: null, titleLabel: null, itemID, typeID: entity?.typeID ?? null, completed: done,
            health: task.info.taskType === TASK_DESTROY_TARGETS
              ? { hull: entity?.hullRatio ?? 0, armor: entity?.armorRatio ?? 0, shield: entity?.shieldRatio ?? 0 }
              : null,
          };
        });
      default:
        return [];
    }
  }
}
