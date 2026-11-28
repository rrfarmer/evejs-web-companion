import {
  iceMiningType,
  AGENT_BUTTON,
  agentActionID,
  readObservedModuleReach,
  acceptedMissionKey,
} from "../shared/helpers.ts";
import { unwrapReal, readKeyVal, unwrapLong } from "../shared/wire.ts";
import { decodeItemInfo } from "../shared/dogma.ts";
import { decodeInventoryRowsChecked } from "../shared/inventory.ts";
import type {
  FittedModule,
  CurrentDungeon,
  FoundAgent,
  RawInventoryPanel,
  Ask,
  MiningHold,
  SpaceEntity,
  SpaceSnapshot,
  JournalState,
  AgentConversation,
} from "../shared/types.ts";
import type { MacroMemory, MacroStep } from "../../../web/src/plugin-api/index.ts";
import type {
  MiningScriptObservation as ScriptObservation,
  MiningMacroDecider as MacroDecider,
  MiningMacroTick as MacroTick,
  MiningScriptAction as ScriptAction,
} from "../shared/missionTypes.ts";
import type { MiningObjective, MiningObjectiveRead } from "./objective.ts";
import { entryAfter, type DungeonEntryReceipt } from "./entryEvidence.ts";
import { missionTravelContext } from "./missionTravel.ts";
export const MINING_MISSION_BOARD = "miningMissionState";
export const MAX_MINING_TRIPS = 32;
export const MISSION_READ_MAX_AGE_MS = 15_000;
import type {
  MissionMiningReach,
  MissionMiningCycle,
  MiningMissionMutation,
  MiningMissionState,
  MiningMissionReceipt,
  MiningMissionCheckpoint,
  MiningMissionObservation,
  MissionCycleSettlement,
} from "../shared/missionTypes.ts";
export type {
  MissionMiningReach,
  MissionMiningCycle,
  MiningMissionMutation,
  MiningMissionState,
  MiningMissionReceipt,
  MiningMissionCheckpoint,
  MiningMissionObservation,
  MissionCycleSettlement,
} from "../shared/missionTypes.ts";
export function missionLedgerGain(
  raw: unknown,
  state: MiningMissionState,
  shipTypeID: number,
  nowMs = Date.now(),
): { minedGain: number; ledgerEntryIDs: number[] } | null {
  const c = state.cycle,
    o = state.objective;
  if (!c || !o || c.observedAtMs == null) return null;
  let fit;
  try {
    fit = JSON.parse(c.scope)[8] as MiningMissionObservation["fit"];
  } catch {
    return null;
  }
  const module = fit?.find((m) => m.itemID === c.moduleID && m.typeID === c.typeID);
  if (!module || !(module.cycleMs > 0)) return null;
  const rows = Array.isArray(raw)
    ? raw
    : (raw as { type?: string; items?: unknown[] })?.type === "list"
      ? (raw as { items: unknown[] }).items
      : null;
  if (!rows) return null;
  const from = c.deadlineMs - Math.max(30_000, module.cycleMs + 30_000),
    ids = new Set<number>(),
    matched: number[] = [];
  let minedGain = 0;
  for (const row of rows) {
    const field = (name: string) => readKeyVal(row as never, name),
      n = (name: string) => unwrapReal(field(name));
    const id = n("entryID"),
      date = unwrapLong(field("eventDate"));
    if (id === null || !Number.isSafeInteger(id) || id <= 0 || ids.has(id) || date === null)
      return null;
    ids.add(id);
    let at;
    try {
      at = Number((BigInt(date) - 116444736000000000n) / 10000n);
    } catch {
      return null;
    }
    if (at < from || at > Math.min(c.deadlineMs, nowMs)) continue;
    if (
      n("characterID") !== state.characterID ||
      n("solarSystemID") !== o.systemID ||
      n("typeID") !== o.content.typeID ||
      n("moduleTypeID") !== c.typeID ||
      n("shipTypeID") !== shipTypeID
    )
      continue;
    const q = n("quantity");
    if (q === null || !Number.isSafeInteger(q) || q < 0) return null;
    minedGain += q;
    matched.push(id);
  }
  return { minedGain, ledgerEntryIDs: matched };
}
/** Current native effect authority, not a docked module-state null or a remembered command. */
export async function readMissionCycleSettlement(
  ask: Ask,
  state: MiningMissionState,
  now: () => number = Date.now,
): Promise<MissionCycleSettlement | null> {
  const c = state.cycle;
  if (!c || c.status !== "accepted" || state.pending) return null;
  const info = decodeItemInfo(await ask("dogmaIM", "ItemGetInfo", [c.moduleID]));
  const effects = info?.activeEffects as { type?: string; entries?: readonly unknown[][] } | null;
  if (
    !info ||
    Number(info.itemID) !== c.moduleID ||
    info.typeID !== c.typeID ||
    Number(info.ownerID) !== state.characterID ||
    Number(info.locationID) !== state.shipID ||
    info.categoryID !== 7 ||
    effects?.type !== "dict" ||
    !Array.isArray(effects.entries) ||
    effects.entries.some((row) => !Array.isArray(row) || row.length !== 2 || Number(row[0]) !== 16)
  )
    return null;
  const hull =
    c.observedAtMs == null
      ? null
      : decodeItemInfo(await ask("dogmaIM", "ItemGetInfo", [state.shipID]));
  if (
    c.observedAtMs != null &&
    (!hull ||
      Number(hull.itemID) !== state.shipID ||
      Number(hull.ownerID) !== state.characterID ||
      hull.categoryID !== 6 ||
      !hull.typeID)
  )
    return null;
  const ledger =
    c.observedAtMs == null
      ? null
      : missionLedgerGain(
          await ask("characterMiningLedger", "GetCharacterLogs", []),
          state,
          hull!.typeID!,
          now(),
        );
  if (c.observedAtMs != null && !ledger) return null;
  return {
    source: "ItemGetInfo",
    cycleKey: JSON.stringify(c),
    characterID: state.characterID,
    shipID: state.shipID,
    ...ledger,
    ...(ledger ? { ledgerSource: "characterMiningLedger.GetCharacterLogs" as const } : {}),
    stationID: state.stationID,
    readAtMs: now(),
    moduleID: c.moduleID,
    typeID: c.typeID,
    nativeTime: info.wallclockTime,
  };
}
export function missionIdentity(o: MiningObjective): string {
  return JSON.stringify([
    o.characterID,
    o.agentID,
    o.content.contentID,
    o.content.templateID,
    o.content.typeID,
    o.content.quantity,
    o.systemID,
    o.stationID,
    o.position,
    o.acceptTimestamp,
  ]);
}
export function sameMission(a: MiningObjective, b: MiningObjective, accepted = true): boolean {
  return (
    missionIdentity(accepted ? a : { ...a, acceptTimestamp: null }) ===
    missionIdentity(accepted ? b : { ...b, acceptTimestamp: null })
  );
}
/** Fresh pre-dispatch read, separate from the coordinator's previous review. */
export function miningMissionActionCurrent(
  state: MiningMissionState,
  read: MiningObjectiveRead,
  journal: JournalState | null,
  conversation: AgentConversation,
  action: { agentID: number; actionID: number; miningMissionOperationID?: string },
): boolean {
  if (
    !journal ||
    !state.pending ||
    action.agentID !== state.agentID ||
    state.pending.id !== action.miningMissionOperationID
  )
    return false;
  const kind = state.pending.kind,
    button =
      kind === "request"
        ? AGENT_BUTTON.REQUEST_MISSION
        : kind === "accept"
          ? AGENT_BUTTON.ACCEPT
          : kind === "complete"
            ? AGENT_BUTTON.COMPLETE
            : null;
  if (button === null || agentActionID(conversation, button) !== action.actionID) return false;
  if (kind === "request")
    return (
      read.reason === "NO_MISSION" && journal.active.length === 0 && journal.offered.length === 0
    );
  const o = read.objective,
    rows = [...journal.active, ...journal.offered];
  return (
    !!o &&
    !!state.objective &&
    rows.length === 1 &&
    rows[0]!.agentID === state.agentID &&
    rows[0]!.missionID === o.content.contentID &&
    rows[0]!.missionState === o.missionState &&
    sameMission(state.objective, o, kind !== "accept") &&
    (kind === "accept" ? o.missionState === 1 : o.missionState === 2 && o.completionStatus === 1)
  );
}
export function missionHangarRead(
  panel: RawInventoryPanel,
  status: { stationID: number | null; shipID: number | null },
) {
  return status.stationID !== null &&
    panel.stationID === status.stationID &&
    panel.activeShipID === status.shipID &&
    panel.hangar.error === null &&
    panel.cargo.error === null
    ? decodeInventoryRowsChecked(panel.hangar.list, panel.volumes)
    : null;
}
export async function miningMissionCycles(
  ask: Ask,
  fit: NonNullable<MiningMissionObservation["fit"]>,
) {
  const result = [];
  for (const module of fit) {
    const cycleMs = unwrapReal(await ask("dogmaIM", "QueryAttributeValue", [module.itemID, 73]));
    if (cycleMs === null || !Number.isFinite(cycleMs) || cycleMs <= 0)
      throw new Error("Unknown native mining cycle");
    result.push({ ...module, cycleMs });
  }
  return result;
}
export function normalMiningAgent(
  a: FoundAgent | null,
): a is FoundAgent & { stationID: number; solarSystemID: number } {
  return (
    !!a &&
    a.divisionID === 23 &&
    a.agentTypeID === 2 &&
    a.stationID !== null &&
    a.solarSystemID !== null &&
    a.level !== null &&
    a.level >= 1 &&
    a.level <= 4
  );
}
export function missionHold(
  holds: readonly MiningHold[] | null | undefined,
  family: "ore" | "ice",
): MiningHold | null {
  if (
    !holds ||
    !holds.length ||
    new Set(holds.map((h) => h.key)).size !== holds.length ||
    holds.some(
      (h) =>
        h.error !== null ||
        h.items === null ||
        (h.present &&
          (h.capacity?.capacity == null ||
            h.capacity.used == null ||
            !Number.isFinite(h.capacity.capacity) ||
            !Number.isFinite(h.capacity.used) ||
            h.capacity.used < 0 ||
            h.capacity.capacity < 0)),
    )
  )
    return null;
  const pick =
    holds.find((h) => h.present && h.key === (family === "ice" ? "ice" : "asteroid")) ??
    holds.find((h) => h.present && h.key === "ore") ??
    holds.find((h) => h.present && h.key === "cargo");
  return pick &&
    !pick.error &&
    pick.items !== null &&
    pick.capacity?.capacity != null &&
    pick.capacity.used !== null &&
    pick.capacity.capacity > 0
    ? pick
    : null;
}
export function missionShipQuantity(
  obs: Pick<ScriptObservation, "holds">,
  typeID: number,
): number | null {
  const holds = obs.holds;
  if (
    !holds?.length ||
    !holds.some((h) => h.key === "cargo" && h.present) ||
    new Set(holds.map((h) => h.key)).size !== holds.length ||
    holds.some(
      (h) => h.items === null || h.error !== null || (h.present && h.capacity?.capacity == null),
    )
  )
    return null;
  let total = 0;
  for (const h of holds.filter((h) => h.present))
    for (const item of h.items ?? []) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) return null;
      if (item.typeID === typeID) total += item.quantity;
    }
  return total;
}
export function missionHangarQuantity(obs: ScriptObservation, o: MiningObjective): number | null {
  if (
    obs.miningMission?.characterID !== o.characterID ||
    obs.flightStatus?.docked !== true ||
    obs.flightStatus.stationID !== o.stationID ||
    obs.stationHangar == null
  )
    return null;
  if (obs.stationHangar.some((r) => !Number.isSafeInteger(r.quantity) || r.quantity < 0))
    return null;
  return obs.stationHangar
    .filter((r) => r.typeID === o.content.typeID)
    .reduce((n, r) => n + r.quantity, 0);
}
const pointKey = (o: MiningObjective) => JSON.stringify([o.systemID, o.position]);
export function missionModuleRange(
  obs: ScriptObservation,
  moduleID: number,
  typeID: number,
  family: "ore" | "ice",
): number | null {
  const f = obs.miningMission;
  if (
    !f ||
    f.nowMs - f.readAtMs < 0 ||
    f.nowMs - f.readAtMs > MISSION_READ_MAX_AGE_MS ||
    !f.fit?.some((m) => m.itemID === moduleID && m.typeID === typeID && m.family === family)
  )
    return null;
  if (obs.snapshot?.ship?.moduleReach != null) {
    const reach = readObservedModuleReach(obs.snapshot, moduleID, typeID);
    return reach?.family === "mining" &&
      reach.resourceFamily === family &&
      (reach.maxRangeMeters ?? 0) > 0
      ? reach.maxRangeMeters
      : null;
  }
  // Original-protocol GamePort exposes Dogma's current maxRange pairs rather
  // than the optional extended moduleReach projection. Use that client range
  // for approach/admission only: native Activate still adjudicates the actual
  // range, and only the observed exact effect/yield can settle the cycle.
  const scene = obs.snapshot,
    ship = scene?.ship;
  if (
    !scene?.inSpace ||
    scene.shipID == null ||
    ship?.itemID !== scene.shipID ||
    obs.flightStatus?.shipID !== scene.shipID ||
    f.nowMs - f.sceneReadAtMs < 0 ||
    f.nowMs - f.sceneReadAtMs > MISSION_READ_MAX_AGE_MS
  )
    return null;
  const ranges = ship.moduleRanges?.filter((row) => row.moduleID === moduleID);
  return ranges?.length === 1 && Number.isFinite(ranges[0]!.rangeM) && ranges[0]!.rangeM > 0
    ? ranges[0]!.rangeM
    : null;
}

export function missionCycleScope(obs: ScriptObservation, s: MiningMissionState): string | null {
  const f = obs.miningMission;
  if (!f?.fitKey || !s.objective || !s.entryConfirmed || !missionPocketProven(obs, s)) return null;
  return JSON.stringify([
    f.characterID,
    f.epoch,
    s.shipID,
    missionIdentity(s.objective),
    s.instanceID,
    f.flowGeneration,
    f.entryEvidence.contextGeneration,
    f.fitKey,
    f.fit,
  ]);
}
/** Read-only reconciliation of an already observed cycle, never another mining action. */
export async function refreshMissionCycleHolds<T>(
  local: Ask,
  read: () => Promise<T>,
  state: MiningMissionState | null | undefined,
  scope: {
    characterID: number;
    shipID: number;
    epoch: string;
    nowMs: number;
    inSpace: boolean | null;
    inWarp: boolean | null;
    activeModuleIDs: readonly number[] | null | undefined;
    activeModuleTargets: readonly { moduleID: number; targetID: number }[] | null | undefined;
  },
  quantity: number | null,
  current: () => boolean,
): Promise<T | undefined> {
  const c = state?.cycle;
  if (
    !state ||
    !c ||
    c.status !== "accepted" ||
    c.observedAtMs == null ||
    c.observedAtMs > scope.nowMs ||
    scope.nowMs > c.deadlineMs ||
    state.characterID !== scope.characterID ||
    state.shipID !== scope.shipID ||
    state.epoch !== scope.epoch ||
    scope.inSpace !== true ||
    scope.inWarp !== false ||
    quantity === null ||
    quantity !== c.quantityBefore ||
    quantity !== state.shipQuantity ||
    !Array.isArray(scope.activeModuleIDs) ||
    scope.activeModuleIDs.includes(c.moduleID) ||
    !Array.isArray(scope.activeModuleTargets) ||
    scope.activeModuleTargets.some((t) => t.moduleID === c.moduleID)
  )
    return;
  const check = () => {
    if (!current()) throw new Error("Mining Mission inventory observation retired");
  };
  check();
  // Stock invCache596-605 retires only this client's exact hull cache. It sends
  // no game-server mutation. The following ordinary List supplies the evidence.
  await local("invCache", "InvalidateLocationCache", [scope.shipID]);
  check();
  const fresh = await read();
  check();
  return fresh;
}
/** Read-only reconciliation never reinterprets the contradictory scalar as a range. */
export function reconcileMissionCycle(
  obs: ScriptObservation,
  s: MiningMissionState,
  quantity: number,
): "waiting" | "settling" | "yield" | "terminal-yield" | "terminal-observed" | "blocked" {
  const c = s.cycle,
    f = obs.miningMission,
    active = obs.snapshot?.ship?.activeModuleIDs;
  if (
    !c ||
    !f ||
    c.status !== "accepted" ||
    c.scope !== missionCycleScope(obs, s) ||
    active == null ||
    f.nowMs > c.deadlineMs ||
    quantity < c.quantityBefore
  )
    return "blocked";
  const paired =
    obs.snapshot!.entities.some((e) => e.itemID === c.targetID) &&
    active.includes(c.moduleID) &&
    obs.snapshot!.ship!.activeModuleTargets?.some(
      (t) => t.moduleID === c.moduleID && t.targetID === c.targetID,
    );
  if (quantity > c.quantityBefore) {
    if (paired) return "yield";
    // A final yield can remove the exhausted rock and stop its effect. This
    // settles an earlier observed action only; it never admits another one.
    if (
      c.observedAtMs != null &&
      c.observedAtMs <= f.nowMs &&
      !active.includes(c.moduleID) &&
      Array.isArray(obs.snapshot!.ship!.activeModuleTargets) &&
      !obs.snapshot!.ship!.activeModuleTargets.some((t) => t.moduleID === c.moduleID)
    )
      return "terminal-yield";
    return "blocked";
  }
  // Yield and native effect shutdown can arrive on separate observations. The
  // exact already credited quantity plus completed native objective settles the
  // old cycle only; it cannot credit more ore or authorize a new Activate.
  if (
    !paired &&
    c.observedAtMs != null &&
    c.observedAtMs <= f.nowMs &&
    quantity > 0 &&
    quantity === s.shipQuantity &&
    f.read?.objective?.completionStatus === 1 &&
    !active.includes(c.moduleID) &&
    Array.isArray(obs.snapshot!.ship!.activeModuleTargets) &&
    !obs.snapshot!.ship!.activeModuleTargets.some((t) => t.moduleID === c.moduleID)
  )
    return "terminal-observed";
  // Effect shutdown and scene removal may precede the fresh hold read. Preserve
  // the exact accepted cycle and its original deadline while observing only;
  // absence credits no material and never authorizes another Activate.
  if (
    c.observedAtMs != null &&
    c.observedAtMs <= f.nowMs &&
    quantity === c.quantityBefore &&
    quantity === s.shipQuantity &&
    !active.includes(c.moduleID) &&
    Array.isArray(obs.snapshot!.ship!.activeModuleTargets) &&
    !obs.snapshot!.ship!.activeModuleTargets.some((t) => t.moduleID === c.moduleID)
  )
    return "settling";
  return paired ? "waiting" : "blocked";
}

export function missionPocketProven(obs: ScriptObservation, state: MiningMissionState): boolean {
  const f = obs.miningMission,
    o = f?.read?.objective,
    scene = obs.snapshot,
    entry = state.entry;
  if (
    !f ||
    !o ||
    !state.objective ||
    !entry ||
    !sameMission(state.objective, o) ||
    state.epoch !== f.epoch ||
    pointKey(o) !== entry.positionKey ||
    f.nowMs - f.sceneReadAtMs < 0 ||
    f.nowMs - f.sceneReadAtMs > MISSION_READ_MAX_AGE_MS ||
    f.sceneReadAtMs <= entry.issuedAt ||
    (obs.completedWarps ?? -1) <= entry.warps ||
    !f.hosted ||
    f.characterID !== state.characterID ||
    !scene?.inSpace ||
    scene.solarSystemID !== o.systemID ||
    scene.shipID !== state.shipID ||
    scene.ship?.itemID !== state.shipID ||
    scene.ship.characterID !== state.characterID ||
    scene.ship.geometryAvailable !== true ||
    !scene.ship.position ||
    obs.inWarp !== false ||
    obs.flightStatus?.solarSystemID !== o.systemID
  )
    return false;
  if (
    entry.flowGeneration !== f.flowGeneration ||
    f.tracker !== true ||
    !f.dungeon ||
    f.dungeon.dungeonID !== o.content.dungeonID ||
    !f.dungeon.instanceID
  )
    return false;
  const freshEntry = entryAfter(
    f.entryEvidence.entry,
    {
      scope: {
        characterID: state.characterID,
        shipID: state.shipID,
        flowGeneration: f.flowGeneration,
      },
      afterSequence: entry.afterSequence,
      issuedAtMs: entry.issuedAt,
      dungeonID: o.content.dungeonID,
      instanceID: state.instanceID,
    },
    f.nowMs,
  );
  const confirmed = state.entryConfirmed;
  if (
    confirmed &&
    (confirmed.contextGeneration !== f.entryEvidence.contextGeneration ||
      !f.entryEvidence.entry ||
      f.entryEvidence.entry.scope.characterID !== state.characterID ||
      f.entryEvidence.entry.scope.shipID !== state.shipID ||
      f.entryEvidence.entry.scope.flowGeneration !== f.flowGeneration ||
      f.entryEvidence.entry.dungeon.instanceID !== confirmed.instanceID)
  )
    return false;
  const provenInstance =
    confirmed &&
    confirmed.sequence > entry.afterSequence &&
    confirmed.receivedAtMs >= entry.issuedAt
      ? confirmed.instanceID
      : freshEntry
        ? f.entryEvidence.entry!.dungeon.instanceID
        : null;
  if (state.instanceID != null && provenInstance !== state.instanceID) return false;
  if (!provenInstance || f.dungeon.instanceID !== provenInstance) return false;
  const p = scene.ship.position;
  return Math.hypot(p.x - o.position.x, p.y - o.position.y, p.z - o.position.z) < 150_000;
}
export function missionTargets(
  obs: ScriptObservation,
  state: MiningMissionState,
): readonly SpaceEntity[] | null {
  if (!missionPocketProven(obs, state)) return null;
  const o = state.objective!;
  const rocks = obs.snapshot!.entities.filter(
    (e) => !e.isSelf && e.miningYieldTypeID === o.content.typeID,
  );
  if (
    rocks.some(
      (e) =>
        e.categoryID !== 25 ||
        e.groupID !== o.content.resourceGroupID ||
        e.geometryAvailable !== true ||
        !e.position ||
        ![e.position.x, e.position.y, e.position.z].every(Number.isFinite) ||
        e.typeID !== o.content.typeID ||
        e.miningResourceFamily !== o.content.family ||
        (e.remainingQuantity !== null &&
          (!Number.isSafeInteger(e.remainingQuantity) || e.remainingQuantity < 0)) ||
        (state.pocketIDs.length > 0 && !state.pocketIDs.includes(e.itemID)),
    )
  )
    return null;
  if (
    rocks.length > o.content.rockCount ||
    obs.snapshot!.entities.some(
      (e) => !e.isSelf && e.categoryID === 25 && e.miningYieldTypeID !== o.content.typeID,
    )
  )
    return null;
  // Native remaining quantities are not projected. Unknown is eligible, never "depleted".
  return rocks.filter((e) => e.remainingQuantity === null || e.remainingQuantity > 0);
}
const WAIT = { kind: "wait" } as const;
interface Mechanics {
  station(obs: ScriptObservation, id: number, phase: string): MacroTick | null;
  system(obs: ScriptObservation, id: number, phase: string): MacroTick | null;
  mine(
    step: MacroStep,
    obs: ScriptObservation,
    memory: MacroMemory,
    scene: SpaceSnapshot,
    rocks: readonly SpaceEntity[],
    range: MissionMiningReach,
  ): MacroTick;
}

export function miningAgentApproach(
  state: MiningMissionState | null,
  receipt: MiningMissionReceipt | null,
): boolean {
  return (
    !receipt &&
    (!state ||
      ((state.phase === "ready" || state.phase === "review") &&
        !state.objective &&
        !state.pending &&
        !state.cycle))
  );
}

export function createMiningMissionMacro(mechanics: Mechanics): MacroDecider {
  return (step, obs, mem, board) => {
    const f = obs.miningMission;
    const agentArg = step.args.agent;
    const agentID =
      agentArg?.kind === "agent"
        ? (agentArg.ref?.id ?? null)
        : typeof board.agentID === "number"
          ? board.agentID
          : null;
    const result = (
      state: MiningMissionState | null,
      action: ScriptAction,
      why: string,
      blocked = false,
      done = false,
      child: MacroMemory = {},
    ): MacroTick => ({
      action,
      why,
      phase:
        "Mining Missions — " +
        (state?.phase ?? "review") +
        (state?.completedEpoch === f?.epoch ? ` · ${state?.completedCount ?? 0} completed` : ""),
      armed: false,
      outcome: blocked
        ? { kind: "blocked", reason: why }
        : done
          ? { kind: "done" }
          : { kind: "acting" },
      nextMem: child,
      settleDrones: state?.phase !== "mining",
      boardPatch: {
        ...(agentID ? { agentID } : {}),
        ...(state
          ? {
              agentStationID: state.stationID,
              [MINING_MISSION_BOARD]: JSON.stringify(state),
            }
          : {}),
      },
    });
    const fail = (state: MiningMissionState | null, reason: string) =>
      result(state, WAIT, reason, true);
    if (step.until)
      return fail(
        null,
        "Mining Missions finish only after verified completion; remove the custom until condition.",
      );
    if (!f || (agentID !== null && board.agentID !== agentID))
      return result(null, WAIT, "Reading Mining Mission authority for the selected agent.");
    if (!f.hosted)
      return fail(null, "RECOVERY_REQUIRED: Mining Missions require the hosted bot lifecycle.");
    const saved = f.state;
    let s = saved;
    const advance = (patch: Partial<MiningMissionState>): MiningMissionState => ({
      ...s!,
      ...patch,
      revision: (saved?.revision ?? 0) + 1,
    });
    if (!agentID)
      return result(
        null,
        WAIT,
        "Choose an ordinary Mining agent or use Find a mining agent.",
        true,
      );
    if (!normalMiningAgent(f.agent) || f.agent.agentID !== agentID)
      return fail(
        s,
        "MINING_AGENT_AUTHORITY: A normal Mining division agent could not be verified.",
      );
    if (f.entryAuthorityFailure)
      return fail(
        s,
        `Mining agent ${f.agent.name} is eligible, but the held connection cannot verify mission entry: ${f.entryAuthorityFailure}.`,
      );
    if (
      f.characterID !== (s?.characterID ?? f.characterID) ||
      f.nowMs - f.readAtMs < 0 ||
      f.nowMs - f.readAtMs > MISSION_READ_MAX_AGE_MS
    )
      return fail(s, "RECOVERY_REQUIRED: Mission owner or fresh authority is unavailable.");
    if (s && f.observationSettling && ["return", "bank"].includes(s.phase)) {
      if (s.readSettlingSince != null && f.nowMs - s.readSettlingSince > 30_000)
        return fail(
          s,
          "RECOVERY_REQUIRED: Native Dock mission reads did not settle within the bounded window.",
        );
      return result(
        advance({ readSettlingSince: s.readSettlingSince ?? f.nowMs }),
        WAIT,
        "Waiting for native Dock mission observation readiness; no action dispatched.",
      );
    }
    const flight = obs.flightStatus;
    if (flight?.shipID == null)
      return fail(s, "RECOVERY_REQUIRED: The active Mining ship could not be read.");
    if (!s) {
      s = {
        version: 2,
        revision: 1,
        epoch: f.epoch,
        characterID: f.characterID,
        shipID: flight.shipID,
        agentID,
        stationID: f.agent.stationID,
        phase: "ready",
        objective: null,
        baseline: 0,
        banked: 0,
        trip: 0,
        tripBankedStart: 0,
        pending: null,
        entry: null,
        pocketIDs: [],
        shipQuantity: 0,
        progressAt: f.nowMs,
        waitTicks: 0,
      };
    }
    if (
      s.phase !== "done" &&
      (s.agentID !== agentID ||
        s.stationID !== f.agent.stationID ||
        (s.shipID !== flight.shipID && !(s.epoch !== f.epoch && !s.objective && !s.pending)))
    )
      return fail(s, "RECOVERY_REQUIRED: The pilot, ship or Mining agent changed.");
    if (miningAgentApproach(saved, f.receipt)) {
      const rows = obs.journal && [...obs.journal.active, ...obs.journal.offered];
      if (
        rows?.some((row) => row.agentID !== agentID || row.missionState !== 1) ||
        (rows?.length ?? 0) > 1
      )
        return fail(
          saved,
          "CONFLICTING_MISSION: Review the existing mission journal before traveling to the Mining agent.",
        );
      if (
        s.phase === "review" &&
        rows &&
        (rows.length !== 1 ||
          (s.reviewedOfferID != null && rows[0]?.missionID !== s.reviewedOfferID))
      )
        return fail(
          saved,
          "RECOVERY_REQUIRED: The reviewed offer changed; no reroll or additional Request will be made.",
        );
      if (obs.missionAdmissionClosed)
        return fail(
          saved,
          "Returning before the run ends. No new Mining mission will be accepted.",
        );
      const arrived = flight.docked && flight.stationID === s.stationID;
      const travel = obs.travel;
      if (!arrived && travel?.destinationStationID === s.stationID && travel.failureReason)
        return fail(
          saved,
          `The trip to the Mining agent could not be finished: ${travel.failureReason}`,
        );
      const sameRoute =
        travel?.destinationStationID === s.stationID &&
        travel.status === "running" &&
        !travel.failureReason;
      if (!arrived && sameRoute && saved?.shipID === flight.shipID)
        return result(
          saved,
          WAIT,
          "Flying to the selected Mining agent. Agent dialogue is checked after docking.",
        );
      const transition = flight.transition?.phase;
      if (
        f.observationSettling ||
        (transition !== undefined && transition !== "ready" && transition !== "failed")
      ) {
        const since =
          typeof mem["agentReadWaitSince"] === "number" ? mem["agentReadWaitSince"] : f.nowMs;
        if (f.nowMs - since > 30_000)
          return fail(
            saved,
            "MINING_AGENT_READ_UNAVAILABLE: The agent station or session did not become ready. Check the pilot's dock before retrying.",
          );
        return result(
          saved,
          WAIT,
          "Waiting for the flight session to settle before reading the Mining agent.",
          false,
          false,
          { ...mem, agentReadWaitSince: since },
        );
      }
      if (!obs.journal)
        return fail(
          saved,
          "RECOVERY_REQUIRED: The native Mining Mission journal could not be verified.",
        );
      if (!arrived) {
        const ride = mechanics.station(obs, s.stationID, "Flying to the Mining agent");
        if (ride)
          return {
            ...ride,
            boardPatch: {
              ...ride.boardPatch,
              agentID,
              agentStationID: s.stationID,
              [MINING_MISSION_BOARD]: JSON.stringify(s),
            },
          };
      }
    }
    if (obs.journal == null || obs.conversation == null)
      return fail(
        saved,
        obs.journal == null
          ? "RECOVERY_REQUIRED: The native Mining Mission journal could not be verified."
          : "MINING_AGENT_READ_UNAVAILABLE: The selected agent's dialogue could not be read. Check the pilot's dock and agent access.",
      );
    if (s.readSettlingSince != null)
      return result(
        advance({ readSettlingSince: undefined }),
        WAIT,
        "Fresh native Dock mission reads are ready.",
      );
    if (s.phase === "done") {
      if (mem["completionVerified"] === true)
        return result(s, WAIT, "Mining mission completion was confirmed.", false, true);
      if (obs.journal.active.length || obs.journal.offered.length)
        return fail(
          s,
          "CONFLICTING_MISSION: Previous completion is retired only with a fresh empty journal.",
        );
      return result(
        advance({
          epoch: f.epoch,
          agentID,
          stationID: f.agent.stationID,
          shipID: flight.shipID,
          phase: "ready",
          objective: null,
          reviewedOfferID: null,
          instanceID: null,
          entryConfirmed: null,
          baseline: 0,
          banked: 0,
          trip: 0,
          tripBankedStart: 0,
          pending: null,
          entry: null,
          pocketIDs: [],
          shipQuantity: 0,
          waitTicks: 0,
        }),
        WAIT,
        "Retired the positively completed mission; a new run may request once.",
      );
    }
    const rows = [...obs.journal.active, ...obs.journal.offered];
    if (rows.some((r) => r.agentID !== agentID) || rows.length > 1)
      return fail(
        s,
        "CONFLICTING_MISSION: Resolve other active or offered missions before continuing.",
      );
    const o = f.read?.objective ?? null;
    const hasMission = rows.length === 1;
    if (s.phase === "complete") {
      if (s.pending && f.receipt?.id === s.pending.id && f.receipt.missionCompleted === true)
        return result(
          advance({
            epoch: f.epoch,
            phase: "done",
            pending: null,
            completedCount: (s.completedEpoch === f.epoch ? (s.completedCount ?? 0) : 0) + 1,
            completedEpoch: f.epoch,
          }),
          WAIT,
          "Mining mission completed.",
          false,
          false,
          { completionVerified: true },
        );
      return fail(
        s,
        "CONSEQUENTIAL_OUTCOME_UNCERTAIN: Complete was dispatched; no positive completion receipt is available. It will not be resent.",
      );
    }
    if (s.phase === "request" && hasMission && rows[0]?.missionState === 1) {
      return result(
        advance({
          epoch: f.epoch,
          phase: "review",
          pending: null,
          reviewedOfferID: rows[0].missionID,
        }),
        WAIT,
        "Request produced a fresh offer; reviewing exact content before Accept.",
      );
    }
    if (
      s.epoch !== f.epoch &&
      !s.objective &&
      !s.pending &&
      (s.phase === "ready" || s.phase === "review")
    ) {
      // A manually started hosted run may review a still-unaccepted offer after
      // the operator changes equipment. Automatic process restart is disabled.
      if (rows.some((r) => r.missionState !== 1))
        return fail(s, "RECOVERY_REQUIRED: An accepted mission has no matching durable identity.");
      return result(
        advance({
          epoch: f.epoch,
          shipID: flight.shipID,
          phase: hasMission ? "review" : "ready",
          reviewedOfferID: rows[0]?.missionID ?? null,
        }),
        WAIT,
        "Fresh hosted owner is reviewing unaccepted mission state.",
      );
    }
    if (
      s.phase === "review" &&
      (!hasMission || (s.reviewedOfferID != null && rows[0]?.missionID !== s.reviewedOfferID))
    )
      return fail(
        s,
        "RECOVERY_REQUIRED: The reviewed offer changed; no reroll or additional Request will be made.",
      );
    if (hasMission && !o)
      return fail(
        s,
        f.read?.reason ?? "MALFORMED_MINING_OBJECTIVE: The current mission could not be decoded.",
      );
    if (
      o &&
      (!hasMission ||
        rows[0]?.missionID !== o.content.contentID ||
        rows[0]?.missionState !== o.missionState ||
        o.stationID !== s.stationID ||
        o.stationSystemID !== f.agent.solarSystemID ||
        o.agentID !== agentID ||
        o.characterID !== s.characterID)
    )
      return fail(s, "MALFORMED_MINING_OBJECTIVE: Journal, owner, agent and objective disagree.");
    if (s.objective && (!o || !sameMission(s.objective, o, s.phase !== "accept")))
      return fail(s, "RECOVERY_REQUIRED: The accepted mission identity changed or disappeared.");
    if (s.phase === "request" && !hasMission) {
      return fail(
        s,
        "CONSEQUENTIAL_OUTCOME_UNCERTAIN: Request was dispatched; no offer is proven. It will not be repeated.",
      );
    }
    if (s.epoch !== f.epoch) {
      if (s.cycle) {
        const proof = f.cycleSettlement,
          aboard = o ? missionShipQuantity(obs, o.content.typeID) : null,
          hangar = o ? missionHangarQuantity(obs, o) : null;
        const known =
          aboard === s.cycle.quantityBefore &&
          s.shipQuantity === s.cycle.quantityBefore &&
          (aboard === 0 ||
            (s.cycle.observedAtMs != null && f.fitKey === JSON.parse(s.cycle.scope)[7]));
        if (
          s.pending ||
          s.cycle.status !== "accepted" ||
          !o ||
          !s.objective ||
          !sameMission(s.objective, o) ||
          o.missionState !== 2 ||
          flight.docked !== true ||
          flight.stationID !== s.stationID ||
          !proof ||
          proof.source !== "ItemGetInfo" ||
          proof.cycleKey !== JSON.stringify(s.cycle) ||
          proof.characterID !== s.characterID ||
          proof.shipID !== s.shipID ||
          proof.stationID !== s.stationID ||
          proof.moduleID !== s.cycle.moduleID ||
          proof.typeID !== s.cycle.typeID ||
          f.nowMs - proof.readAtMs < 0 ||
          f.nowMs - proof.readAtMs > MISSION_READ_MAX_AGE_MS ||
          (!known &&
            (aboard !== s.cycle.quantityBefore + (proof.minedGain ?? 0) ||
              s.shipQuantity !== s.cycle.quantityBefore ||
              !(proof.minedGain! > 0) ||
              !s.cycle.observedAtMs ||
              proof.ledgerSource !== "characterMiningLedger.GetCharacterLogs" ||
              !proof.ledgerEntryIDs?.length ||
              f.fitKey !== JSON.parse(s.cycle.scope)[7])) ||
          hangar !== s.baseline + s.banked
        )
          return fail(
            s,
            "RECOVERY_REQUIRED: Previous mining cycle needs native inactive effect and exact docked inventory reconciliation.",
          );
        return result(
          advance({
            epoch: f.epoch,
            phase: aboard! > 0 ? "bank" : "outbound",
            shipQuantity: aboard!,
            entry: aboard! > 0 ? s.entry : null,
            entryConfirmed: aboard! > 0 ? s.entryConfirmed : null,
            pocketIDs: aboard! > 0 ? s.pocketIDs : [],
            cycle: null,
            cycleTerminals: [
              ...(s.cycleTerminals ?? []),
              {
                cycle: s.cycle,
                outcome: known
                  ? aboard! > 0
                    ? "SETTLED_PREVIOUSLY_CREDITED"
                    : "SETTLED_NO_CREDIT"
                  : "SETTLED_OBSERVED_GAIN",
                evidence: proof,
                shipQuantity: aboard!,
                hangarQuantity: hangar!,
              },
            ],
          }),
          WAIT,
          "Previous accepted mining cycle reconciled with native inactive effects and exact inventory; continuing verified custody.",
        );
      }
      if (
        s.phase === "accept" &&
        s.pending?.kind === "accept" &&
        o?.missionState === 2 &&
        s.objective &&
        sameMission(s.objective, o, false) &&
        missionShipQuantity(obs, o.content.typeID) === 0 &&
        missionHangarQuantity(obs, o) === s.baseline
      ) {
        return result(
          advance({ epoch: f.epoch, phase: "bank", objective: o, pending: null }),
          WAIT,
          "Fresh accepted identity resolved the previous Accept; no action was replayed.",
        );
      }
      if (
        s.phase === "unload" &&
        s.pending?.kind === "unload" &&
        o &&
        f.receipt?.id === s.pending.id &&
        f.receipt.acknowledged &&
        missionHangarQuantity(obs, o) === s.pending.hangarBefore! + s.pending.quantity! &&
        missionShipQuantity(obs, o.content.typeID) === s.pending.shipBefore! - s.pending.quantity!
      ) {
        return result(
          advance({
            epoch: f.epoch,
            phase: "bank",
            pending: null,
            banked: s.pending.hangarBefore! + s.pending.quantity! - s.baseline,
            shipQuantity: s.pending.shipBefore! - s.pending.quantity!,
          }),
          WAIT,
          "The acknowledged transfer and both fresh inventories resolved settlement; no transfer was replayed.",
        );
      }
      if (s.pending)
        return fail(
          s,
          "RECOVERY_REQUIRED: A previous hosted run has an unresolved consequential action.",
        );
      const aboard = o ? missionShipQuantity(obs, o.content.typeID) : null;
      const resumingTrip = s.phase === "return" || s.phase === "bank";
      const settledTrip =
        resumingTrip &&
        aboard !== null &&
        aboard === s.shipQuantity &&
        Number.isSafeInteger(aboard + s.banked) &&
        (aboard === 0 || (s.entry !== null && s.pocketIDs.length > 0));
      if (
        !o ||
        o.missionState !== 2 ||
        !s.objective ||
        !sameMission(s.objective, o) ||
        !flight.docked ||
        flight.stationID !== s.stationID ||
        (resumingTrip ? !settledTrip : aboard !== 0) ||
        missionHangarQuantity(obs, o) !== s.baseline + s.banked
      )
        return fail(
          s,
          "RECOVERY_REQUIRED: Reconcile the accepted mission, ship inventory and accumulated personal hangar before resuming.",
        );
      return result(
        advance({
          epoch: f.epoch,
          phase: ["outbound", "entry", "mining"].includes(s.phase) ? "outbound" : "bank",
          entryConfirmed: settledTrip && aboard! > 0 ? s.entryConfirmed : null,
          entry: settledTrip && aboard! > 0 ? s.entry : null,
          pocketIDs: settledTrip && aboard! > 0 ? s.pocketIDs : [],
          waitTicks: 0,
        }),
        WAIT,
        "Restored the same accepted mission and verified accumulated hangar quantity.",
      );
    }
    if (s.phase === "ready" || s.phase === "review") {
      if (obs.missionAdmissionClosed && !s.pending && !obs.journal.active.length)
        return fail(s, "Returning before the run ends. No new Mining mission will be accepted.");
      const ride = mechanics.station(obs, s.stationID, "Flying to the Mining agent");
      if (ride)
        return {
          ...ride,
          boardPatch: {
            ...ride.boardPatch,
            agentID,
            agentStationID: s.stationID,
            [MINING_MISSION_BOARD]: JSON.stringify(s),
          },
        };
      if (!hasMission) {
        if (!f.read || f.read.reason !== "NO_MISSION")
          return fail(s, "RECOVERY_REQUIRED: Fresh objective absence could not be established.");
        const actionID = agentActionID(obs.conversation, AGENT_BUTTON.REQUEST_MISSION);
        if (actionID === null)
          return fail(s, "REQUEST_UNAVAILABLE: The agent has no fresh Request action.");
        const pending: MiningMissionMutation = {
          id: s.epoch + ":request:" + (s.revision + 1),
          kind: "request",
        };
        return result(
          advance({ phase: "request", pending }),
          {
            kind: "agentButton",
            agentID,
            actionID,
            label: "Request Mining Mission",
            miningMissionOperationID: pending.id,
          },
          "Requesting one Mining mission.",
        );
      }
      if (!o) return fail(s, f.read?.reason ?? "MALFORMED_MINING_OBJECTIVE: Offer unavailable.");
      if (o.missionState !== 1)
        return fail(
          s,
          "RECOVERY_REQUIRED: An accepted mission has no matching durable Mining Mission run.",
        );
      const fit = f.fit?.filter((m) => m.family === o.content.family);
      if (!fit?.length)
        return fail(
          s,
          "EQUIPMENT_INCOMPATIBLE: Fit usable " +
            o.content.family +
            " mining equipment before accepting this mission.",
        );
      const hold = missionHold(obs.holds, o.content.family);
      const aboard = missionShipQuantity(obs, o.content.typeID),
        bank = missionHangarQuantity(obs, o);
      if (!hold || aboard === null || bank === null)
        return fail(
          s,
          "STORAGE_UNREADABLE: Mining storage or personal hangar could not be verified.",
        );
      if (aboard !== 0)
        return fail(
          s,
          "RESOURCE_PROVENANCE: Remove pre-existing objective material from the ship before accepting.",
        );
      if (hold.capacity!.capacity! - hold.capacity!.used! < o.unitVolume)
        return fail(
          s,
          "STORAGE_UNAVAILABLE: The usable mining hold cannot accept even one objective unit.",
        );
      const actionID = agentActionID(obs.conversation, AGENT_BUTTON.ACCEPT);
      if (actionID === null)
        return fail(s, "ACCEPT_UNAVAILABLE: The reviewed offer has no fresh Accept action.");
      const pending: MiningMissionMutation = {
        id: s.epoch + ":accept:" + (s.revision + 1),
        kind: "accept",
      };
      return result(
        advance({ phase: "accept", objective: o, baseline: bank, pending }),
        {
          kind: "agentButton",
          agentID,
          actionID,
          label: "Accept Mining Mission",
          miningMissionOperationID: pending.id,
        },
        "Accepting the audited " + o.content.family + " mission once.",
      );
    }
    if (!o) return fail(s, "RECOVERY_REQUIRED: The accepted mission is unavailable.");
    if (s.phase === "accept") {
      if (o.missionState !== 2)
        return fail(
          s,
          "CONSEQUENTIAL_OUTCOME_UNCERTAIN: Acceptance is not proven; Accept will not be repeated.",
        );
      return result(
        advance({ phase: "bank", objective: o, pending: null }),
        WAIT,
        "Accepted mission identity confirmed freshly.",
      );
    }
    if (o.missionState !== 2)
      return fail(s, "RECOVERY_REQUIRED: This mission is no longer accepted.");
    const shipQuantity = missionShipQuantity(obs, o.content.typeID);
    if (shipQuantity === null)
      return fail(s, "STORAGE_UNREADABLE: Objective material aboard could not be read.");
    if (s.phase === "unload") {
      const bank = missionHangarQuantity(obs, o),
        pending = s.pending;
      if (!pending || bank === null)
        return fail(s, "UNLOAD_TRANSFER_UNCERTAIN: Personal hangar settlement could not be read.");
      if (
        f.receipt?.id !== pending.id ||
        !f.receipt.acknowledged ||
        bank !== pending.hangarBefore! + pending.quantity! ||
        shipQuantity !== pending.shipBefore! - pending.quantity!
      )
        return fail(
          s,
          "UNLOAD_TRANSFER_UNCERTAIN: The exact transfer was not confirmed on both inventories; it will not be repeated.",
        );
      return result(
        advance({ phase: "bank", pending: null, banked: bank - s.baseline, shipQuantity }),
        WAIT,
        "Confirmed the exact deposit in the personal hangar.",
      );
    }
    if (s.phase === "bank") {
      const bank = missionHangarQuantity(obs, o);
      if (bank === null)
        return fail(
          s,
          "STORAGE_UNREADABLE: Read the pilot's personal hangar at the agent station.",
        );
      if (bank !== s.baseline + s.banked)
        return fail(
          s,
          "RESOURCE_PROVENANCE: Personal hangar changed outside the verified mission deposits.",
        );
      if (shipQuantity > 0) {
        if (!s.entry || !s.pocketIDs.length || shipQuantity !== s.shipQuantity)
          return fail(
            s,
            "RESOURCE_PROVENANCE: Aboard material is not the settled yield of this mission trip.",
          );
        const source = obs.holds!.find(
          (h) => h.present && h.items?.some((r) => r.typeID === o.content.typeID && r.quantity > 0),
        );
        const row = source?.items?.find((r) => r.typeID === o.content.typeID && r.quantity > 0);
        if (!source || !row)
          return fail(s, "STORAGE_UNREADABLE: The objective stack's source hold is unavailable.");
        const pending: MiningMissionMutation = {
          id: s.epoch + ":unload:" + (s.revision + 1),
          kind: "unload",
          hangarBefore: bank,
          shipBefore: shipQuantity,
          quantity: row.quantity,
          itemID: row.itemID,
          bay: source.key === "cargo" ? null : source.key,
          typeID: row.typeID,
        };
        return result(
          advance({ phase: "unload", pending }),
          {
            kind: "unloadHolds",
            groups: [{ bay: source.key === "cargo" ? null : source.key, itemIDs: [row.itemID] }],
            miningMissionOperationID: pending.id,
          },
          "Depositing mission material into your personal hangar.",
        );
      }
      // Native dungeon progress counts asteroid depletion, while critical mining
      // bonuses also enter cargo. A sufficient bank is not a completed pocket.
      // Continue through the existing bounded trip/entry/admission path until the
      // native objective agrees; never infer Complete from our cargo quantity.
      if (s.banked >= o.content.quantity && o.completionStatus === 1) {
        const actionID = agentActionID(obs.conversation, AGENT_BUTTON.COMPLETE);
        if (actionID === null || !acceptedMissionKey(obs.journal, agentID))
          return fail(s, "COMPLETE_UNAVAILABLE: The agent has no fresh Complete action.");
        const pending: MiningMissionMutation = {
          id: s.epoch + ":complete:" + (s.revision + 1),
          kind: "complete",
        };
        return result(
          advance({ phase: "complete", pending }),
          {
            kind: "agentButton",
            agentID,
            actionID,
            label: "Complete Mining Mission",
            missionKey: acceptedMissionKey(obs.journal, agentID) ?? undefined,
            miningMissionOperationID: pending.id,
          },
          "Completing the verified Mining mission once.",
        );
      }
      if (s.trip >= MAX_MINING_TRIPS)
        return fail(s, "TRIP_LIMIT: The bounded Mining Mission trip budget is exhausted.");
      if (s.trip > 0 && s.banked <= s.tripBankedStart)
        return fail(
          s,
          "RESOURCE_DEPLETED: No mission-origin material was delivered; inspect the objective and pocket.",
        );
      return result(
        advance({
          phase: "outbound",
          trip: s.trip + 1,
          tripBankedStart: s.banked,
          entry: null,
          entryConfirmed: null,
          pocketIDs: [],
          shipQuantity: 0,
          progressAt: f.nowMs,
          waitTicks: 0,
        }),
        WAIT,
        "Returning to the same accepted mission for trip " + (s.trip + 1) + ".",
      );
    }
    if (s.phase === "return") {
      if (!flight.docked && obs.snapshot?.ship?.activeModuleIDs == null)
        return fail(s, "RECOVERY_REQUIRED: Active mining modules could not be read.");
      const active = [
        ...new Set([...(obs.miningModuleIDs ?? []), ...(f.fit ?? []).map((m) => m.itemID)]),
      ].find((id) => obs.snapshot?.ship?.activeModuleIDs?.includes(id));
      if (active !== undefined)
        return result(
          s,
          { kind: "deactivate", moduleID: active },
          "Settling mining cycles before leaving.",
        );
      if (obs.dronesOut !== false)
        return result(s, WAIT, "Returning drones before leaving the mission.");
      const ride = mechanics.station(obs, s.stationID, "Returning mission material to the agent");
      if (ride)
        return {
          ...ride,
          settleDrones: true,
          boardPatch: { [MINING_MISSION_BOARD]: JSON.stringify(advance({ shipQuantity })) },
        };
      return result(
        advance({ phase: "bank", shipQuantity }),
        WAIT,
        "Docked for personal hangar settlement.",
      );
    }
    if (s.phase === "outbound") {
      if (shipQuantity !== 0)
        return fail(
          s,
          "RESOURCE_PROVENANCE: A new trip must begin with no objective material aboard.",
        );
      const ride = mechanics.system(obs, o.systemID, "Travelling to the accepted Mining mission");
      if (ride) return { ...ride, boardPatch: { [MINING_MISSION_BOARD]: JSON.stringify(s) } };
      if (flight.docked)
        return result(s, { kind: "undock" }, "Undocking for the accepted mission.");
      if (obs.dronesOut !== false) return result(s, WAIT, "Settling drones before mission entry.");
      if (obs.completedWarps == null)
        return fail(s, "MISSION_ENTRY_UNAVAILABLE: Warp observation is unavailable.");
      const trip = missionTravelContext(obs.journal);
      const spots =
        trip?.spots.filter(
          (p) =>
            p.locationType === "dungeon" &&
            p.locationNumber === o.locationNumber &&
            p.solarSystemID === o.systemID &&
            p.ownerID === s.characterID &&
            p.x === o.position.x &&
            p.y === o.position.y &&
            p.z === o.position.z,
        ) ?? [];
      if (!trip || trip.agentID !== agentID || spots.length !== 1)
        return fail(
          s,
          "MISSION_ENTRY_UNAVAILABLE: Exactly one matching owner/agent/dungeon mark is required.",
        );
      return result(
        advance({
          phase: "entry",
          entry: {
            warps: obs.completedWarps,
            positionKey: pointKey(o),
            issuedAt: f.nowMs,
            afterSequence: f.entryEvidence.sequence,
            flowGeneration: f.flowGeneration,
          },
          waitTicks: 0,
        }),
        {
          kind: "warpMissionLocation",
          agentID,
          locationType: "dungeon",
          locationNumber: o.locationNumber,
          missionKey: trip.key,
        },
        "Entering this accepted mission through the native authorized location.",
      );
    }
    if (s.phase === "entry") {
      if (!missionPocketProven(obs, s)) {
        if (s.waitTicks >= 120)
          return fail(
            s,
            "MISSION_POCKET_NOT_PROVEN: Accepted identity, authorized entry and scene did not join.",
          );
        return result(
          advance({ waitTicks: s.waitTicks + 1 }),
          WAIT,
          "Verifying the accepted mission pocket.",
        );
      }
      const targets = missionTargets(obs, s);
      if (!targets)
        return fail(s, "MISSION_POCKET_NOT_PROVEN: Scene resource identity is ambiguous.");
      if (!targets.length)
        return result(
          advance({ phase: "return", shipQuantity: 0 }),
          WAIT,
          "MISSION_RESOURCE_NOT_FOUND: Rechecking the objective and accumulated hangar.",
        );
      if (s.trip === 1 && targets.length !== o.content.rockCount)
        return fail(
          s,
          "MISSION_POCKET_NOT_PROVEN: First entry does not match the conservative authored rock count.",
        );
      const receipt = f.entryEvidence.entry!;
      return result(
        advance({
          phase: "mining",
          instanceID: f.dungeon!.instanceID,
          entryConfirmed: {
            sequence: receipt.sequence,
            receivedAtMs: receipt.receivedAtMs,
            instanceID: receipt.dungeon.instanceID,
            contextGeneration: f.entryEvidence.contextGeneration,
          },
          pocketIDs: targets.map((r) => r.itemID),
          progressAt: f.nowMs,
          waitTicks: 0,
        }),
        WAIT,
        "Accepted mission pocket and exact resource field proven.",
      );
    }
    const targets = missionTargets(obs, s);
    if (targets === null)
      return fail(
        s,
        "MISSION_POCKET_NOT_PROVEN: Current mining scene no longer matches the accepted mission.",
      );
    const fit = f.fit?.filter((m) => m.family === o.content.family) ?? [];
    if (!fit.length)
      return fail(
        s,
        "EQUIPMENT_INCOMPATIBLE: Compatible online " +
          o.content.family +
          " equipment is unavailable.",
      );
    const reaches = fit.map((m) => missionModuleRange(obs, m.itemID, m.typeID, o.content.family));
    const hold = missionHold(obs.holds, o.content.family);
    if (!hold) return fail(s, "STORAGE_UNREADABLE: Compatible mining capacity is unknown.");
    if (shipQuantity < s.shipQuantity || (shipQuantity > s.shipQuantity && !s.cycle))
      return fail(s, "RESOURCE_PROVENANCE: Objective material changed outside verified mining.");
    const progressed = shipQuantity > s.shipQuantity;
    const activeModules = obs.snapshot?.ship?.activeModuleIDs;
    if (activeModules == null)
      return fail(s, "EQUIPMENT_INCOMPATIBLE: Active mining state is unreadable.");

    let next = advance({ shipQuantity, progressAt: progressed ? f.nowMs : s.progressAt });
    if (s.cycle) {
      const outcome = reconcileMissionCycle(obs, s, shipQuantity);
      if (outcome === "blocked")
        return fail(
          s,
          "RECOVERY_REQUIRED: Accepted mining cycle identity, custody or bounded outcome is unresolved; no Activate replay.",
        );
      if (outcome === "settling")
        return result(
          s,
          WAIT,
          "Observing final cycle inventory after native target and effect shutdown; no mining action replay.",
        );
      if (outcome === "waiting")
        return result(
          { ...next, cycle: { ...s.cycle, observedAtMs: f.nowMs } },
          WAIT,
          "Observing the accepted exact mining cycle; contradictory range cannot authorize a new action.",
        );
      const free = hold.capacity!.capacity! - hold.capacity!.used!;
      if (
        outcome === "terminal-yield" ||
        outcome === "terminal-observed" ||
        free < o.unitVolume ||
        hold.capacity!.used! / hold.capacity!.capacity! >= 0.95 ||
        (s.banked < o.content.quantity
          ? shipQuantity + s.banked >= o.content.quantity
          : o.completionStatus === 1)
      )
        return result(
          { ...next, cycle: null, phase: "return" },
          WAIT,
          "Accepted cycle produced mission ore; settling for authoritative bank readback.",
        );
      const module = fit.find(
        (m) => m.itemID === s.cycle!.moduleID && m.typeID === s.cycle!.typeID,
      );
      if (!module || !Number.isFinite(module.cycleMs) || module.cycleMs <= 0)
        return fail(s, "RECOVERY_REQUIRED: Accepted cycle duration is unknown.");
      return result(
        {
          ...next,
          cycle: {
            ...s.cycle,
            quantityBefore: shipQuantity,
            observedAtMs: f.nowMs,
            deadlineMs: f.nowMs + Math.max(30_000, module.cycleMs + 30_000),
          },
        },
        WAIT,
        "Verified same-target yield; observing the already running module without another Activate.",
      );
    }
    if (reaches.some((r) => r === null))
      return fail(
        s,
        "EQUIPMENT_INCOMPATIBLE: Effective mining family or range could not be verified.",
      );
    // A unit must fit, and leave before the practical 95% threshold. All miners
    // are settled before travel; partial ore cycles may add a final observed yield.
    const free = hold.capacity!.capacity! - hold.capacity!.used!;
    if (
      free < o.unitVolume ||
      hold.capacity!.used! / hold.capacity!.capacity! >= 0.95 ||
      (s.banked < o.content.quantity
        ? shipQuantity + s.banked >= o.content.quantity
        : o.completionStatus === 1) ||
      targets.length === 0
    )
      return result(
        { ...next, phase: "return" },
        WAIT,
        "Settling this trip for personal hangar delivery.",
      );
    const grace = Math.max(180_000, ...fit.map((m) => m.cycleMs * 3 + 30_000));
    if (f.nowMs - next.progressAt > grace)
      return fail(
        next,
        "NO_YIELD: The qualified objective produced no observed yield within the bounded mining window.",
      );
    const mined = mechanics.mine(
      step,
      { ...obs, miningModuleIDs: fit.map((m) => m.itemID) },
      mem,
      obs.snapshot!,
      targets,
      { kind: "mission-reach", meters: Math.min(...reaches.map((r) => r!)) },
    );
    if (mined.action.kind === "activate") {
      const action = mined.action;
      const module = fit.find((m) => m.itemID === action.moduleID),
        scope = missionCycleScope(obs, s);
      if (
        !scope ||
        !module ||
        !Number.isFinite(module.cycleMs) ||
        module.cycleMs <= 0 ||
        !targets.some((t) => t.itemID === action.targetID)
      )
        return fail(s, "RECOVERY_REQUIRED: Exact cycle admission scope is unavailable.");
      return {
        ...mined,
        armed: false,
        boardPatch: {
          [MINING_MISSION_BOARD]: JSON.stringify({
            ...next,
            cycle: {
              moduleID: module.itemID,
              typeID: module.typeID,
              targetID: mined.action.targetID,
              status: "prepared",
              scope,
              quantityBefore: shipQuantity,
              deadlineMs: f.nowMs + Math.max(30_000, module.cycleMs + 30_000),
            },
          }),
        },
      };
    }
    return { ...mined, armed: false, boardPatch: { [MINING_MISSION_BOARD]: JSON.stringify(next) } };
  };
}

/** Numeric SDE module groups plus dogma mining amount/required skill authority. */
export function miningMissionFit(
  modules: readonly FittedModule[],
  facts: Readonly<Record<number, Readonly<Record<number, number>>>>,
): NonNullable<MiningMissionObservation["fit"]> {
  return modules.flatMap((m) => {
    const a = facts[m.typeID];
    if (
      !m.online ||
      ![54, 464, 483, 2004].includes(m.groupID ?? -1) ||
      !a ||
      !(a[77]! > 0) ||
      !(a[73]! > 0)
    )
      return [];
    return [
      {
        itemID: m.itemID,
        typeID: m.typeID,
        family: iceMiningType(a) ? ("ice" as const) : ("ore" as const),
        cycleMs: a[73]!,
      },
    ];
  });
}
