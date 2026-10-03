import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, MacroTick, ScriptAction } from "./scriptDecide.ts";
import { droneRoster } from "./droneLaunch.ts";

/** An invocation owns only mutations it initiated, never the whole active fit. */
export interface CombatOwnership {
  readonly shipID: number | null;
  readonly modules: Readonly<Record<number, { readonly typeID?: number; readonly weapon?: boolean }>>;
  readonly locks: readonly number[];
  readonly drones: readonly number[];
  readonly initialDrones: readonly number[];
  readonly launched: boolean;
  readonly pendingLaunch?: boolean;
  readonly movement: boolean;
  readonly fleetCall: boolean;
  readonly recallIssued?: boolean;
  readonly stopIssued?: boolean;
  readonly stoppingModuleID?: number;
  readonly unlockIssued?: readonly number[];
  readonly settlementTicks?: number;
}
export function combatOwnership(mem: MacroMemory, obs: ScriptObservation): CombatOwnership {
  const prior = mem.combatOwned as CombatOwnership | undefined;
  const roster = droneRoster(obs, "combat");
  const owned = prior ?? { shipID: obs.snapshot?.ship?.itemID ?? null, modules: {}, locks: [],
    drones: [], initialDrones: roster.out, launched: false, movement: false, fleetCall: false };
  return owned;
}
export function ownCombatAction(owned: CombatOwnership, action: ScriptAction, obs: ScriptObservation): CombatOwnership {
  if (action.kind === "activate" && obs.snapshot?.ship?.activeModuleIDs?.includes(action.moduleID) === false) {
    const typeID = action.typeID ?? obs.propulsionModules?.find(row => row.itemID === action.moduleID)?.typeID ??
      obs.combatWeapons?.weapons.find(row => row.itemID === action.moduleID)?.typeID;
    const weapon = obs.combatWeapons?.weapons.some(row => row.itemID === action.moduleID) === true;
    return { ...owned, modules: { ...owned.modules, [action.moduleID]: { ...(typeID === undefined ? {} : { typeID }), weapon } } };
  }
  if (action.kind === "lock" && obs.lockedTargetIDs != null && !obs.lockedTargetIDs.includes(action.targetID))
    return { ...owned, locks: [...new Set([...owned.locks, action.targetID])] };
  if (action.kind === "launchDrones") return { ...owned, launched: true, pendingLaunch: true };
  if (action.kind === "engageDrones") return { ...owned, drones: [...new Set([...owned.drones, ...action.droneIDs])] };
  if (["approach", "keepAtRange", "orbit"].includes(action.kind)) return { ...owned, movement: true, stopIssued: false };
  if (action.kind === "stopShip") return { ...owned, stopIssued: true };
  if (action.kind === "callPrimary") return { ...owned, fleetCall: action.targetID !== null };
  return owned;
}
export const COMBAT_SETTLEMENT_TICKS = 90;
/** One mutation then observation. No repeated recall/stop dispatch after ACK. */
export function settleCombat(obs: ScriptObservation, memory: MacroMemory): MacroTick {
  let owned = combatOwnership(memory, obs);
  const next = (action: ScriptAction, why: string, done = false): MacroTick => ({ action,
    why: typeof memory.combatFinishWhy === "string" ? `${memory.combatFinishWhy} ${why}` : why,
    phase: "Settling combat", armed: false, outcome: done ? { kind: "done" } : { kind: "acting" },
    nextMem: { ...memory, combatOwned: owned, combatSettling: true } });
  if (obs.docked === true) return next({ kind: "wait" }, "Docking has retired the ship's space effects and orders.", true);
  if (owned.pendingLaunch) return { ...next({ kind: "wait" }, "Launch cohort could not be confirmed."),
    outcome: { kind: "blocked", reason: "Drone launch outcome needs human reconciliation; unrelated drones will not be claimed." } };
  owned = { ...owned, settlementTicks: (owned.settlementTicks ?? 0) + 1 };
  if (owned.settlementTicks! > COMBAT_SETTLEMENT_TICKS) return { ...next({ kind: "wait" }, "Combat settlement could not be proven."),
    outcome: { kind: "blocked", reason: "Combat settlement is unconfirmed; human review is required." } };
  if (owned.shipID !== obs.snapshot?.ship?.itemID || obs.inSpace !== true || obs.inWarp === true)
    return next({ kind: "wait" }, "Waiting for the owned ship's authoritative space state.");
  if (owned.fleetCall) {
    owned = { ...owned, fleetCall: false };
    return next({ kind: "callPrimary", targetID: null }, "Retiring this combat invocation's fleet call.");
  }
  if ((owned.drones.length > 0 || owned.launched) && (obs.combatDroneIDs == null || obs.myDrones == null))
    return next({ kind: "wait" }, "Drone disposition is unreadable; completion is blocked.");
  const out = droneRoster(obs, "combat").out.filter(id => owned.drones.includes(id));
  if (out.length > 0) {
    if (owned.recallIssued) return next({ kind: "wait" }, "Waiting for the controlled combat drones to return.");
    owned = { ...owned, recallIssued: true };
    return next({ kind: "recallDrones", droneIDs: out }, "Returning drones ordered by this combat invocation.");
  }
  const active = obs.snapshot?.ship?.activeModuleIDs;
  if (active == null && Object.keys(owned.modules).length > 0) return next({ kind: "wait" }, "Active-module state is unreadable; completion is blocked.");
  const banks = obs.snapshot?.ship?.weaponBanks;
  if (banks == null && Object.values(owned.modules).some(row => row.weapon))
    return next({ kind: "wait" }, "Weapon-bank state is unreadable; owned weapon shutdown cannot be proven.");
  const banked = Object.entries(banks ?? {}).find(([master, slaves]) => active?.includes(Number(master)) &&
    [Number(master), ...slaves].some(id => owned.modules[id] !== undefined));
  if (banked) return { ...next({ kind: "wait" }, "Owned modules now belong to a weapon bank."),
    outcome: { kind: "blocked", reason: "Bank ownership changed; combat cannot stop unrelated bank members safely." } };
  const moduleID = Object.keys(owned.modules).map(Number).find(id => active?.includes(id));
  if (moduleID !== undefined) {
    if (owned.stoppingModuleID === moduleID) return next({ kind: "wait" }, "Waiting for the requested module cycle to end.");
    owned = { ...owned, stoppingModuleID: moduleID };
    const typeID = owned.modules[moduleID]?.typeID;
    return next({ kind: "deactivate", moduleID, settlement: true, ...(typeID === undefined ? {} : { typeID }) },
      "Stopping a temporary module activated by this combat invocation.");
  }
  owned = { ...owned, stoppingModuleID: undefined };
  if (owned.movement) {
    if (owned.stopIssued) {
      const mode = obs.flightStatus?.shipMode;
      if (mode == null || !/stop/i.test(mode)) return next({ kind: "wait" }, "Waiting for the owned movement order to stop.");
      owned = { ...owned, movement: false };
    } else {
      owned = { ...owned, stopIssued: true };
      return next({ kind: "stopShip" }, "Releasing this combat invocation's movement order.");
    }
  }
  if (obs.lockedTargetIDs == null && owned.locks.length > 0) return next({ kind: "wait" }, "Target-lock state is unreadable; completion is blocked.");
  const targetID = owned.locks.find(id => obs.lockedTargetIDs!.includes(id));
  if (targetID !== undefined) {
    if (owned.unlockIssued?.includes(targetID)) return next({ kind: "wait" }, "Waiting for the requested lock release.");
    owned = { ...owned, unlockIssued: [...(owned.unlockIssued ?? []), targetID] };
    return next({ kind: "unlock", targetID }, "Releasing a lock acquired by this combat invocation.");
  }
  return next({ kind: "wait" }, "Owned combat state is settled.", true);
}
