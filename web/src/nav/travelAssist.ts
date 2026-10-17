import { decidePropulsionModule, type PropulsionModule } from "./propulsion.ts";
import { measureSpace } from "./autopilotLoop.ts";
import type { SpaceSnapshot } from "../store/types.ts";

export function fittedTravelPropulsion(rows: readonly { itemID: number; typeID: number; online: boolean; effect: string | null }[]): PropulsionModule[] {
  return rows.filter(row => row.online && ["moduleBonusAfterburner", "moduleBonusMicrowarpdrive"].includes(row.effect ?? ""))
    .map(row => ({ itemID: row.itemID, typeID: row.typeID, kind: row.effect === "moduleBonusAfterburner" ? "afterburner" as const : "microwarpdrive" as const }));
}

/** Dogma dispatch chooses its propulsion path BEFORE generic default-effect
 * resolution. An empty effect can cycle without applying speed/mass bonuses. */
export function travelPropulsionActivation(module: PropulsionModule): { effect: string; repeat: -1 } {
  if (module.kind === null) throw new Error("Unknown propulsion effect");
  return { effect: module.kind === "afterburner" ? "moduleBonusAfterburner" : "moduleBonusMicrowarpdrive", repeat: -1 };
}

/** Centre-to-point distance from the ship; null when the ship's position is unknown. */
function distanceToPoint(snapshot: SpaceSnapshot, point: { x: number; y: number; z: number }): number | undefined {
  if (!snapshot.inSpace) return undefined;
  const origin = snapshot.ship?.position ?? snapshot.entities.find(entity => entity.isSelf)?.position ?? null;
  return origin ? Math.hypot(origin.x - point.x, origin.y - point.y, origin.z - point.z) : undefined;
}

export interface TravelAssistInput {
  enabled: boolean;
  scope: string | null;
  action: { kind: string; targetID?: number | null; range?: number; position?: { x: number; y: number; z: number }; moduleID?: number };
  /** Salvager scope: module work, looting and target handling while a leg is flown do not end the owned approach. */
  workWhileMoving?: boolean;
  snapshot: SpaceSnapshot | null;
  inWarp: boolean | null;
  docked: boolean | null;
  modules: readonly PropulsionModule[];
  scrammed: boolean | null;
}
export interface TravelAssistDeps {
  /** Explicit propulsion effect, continuous until owned approach cleanup.
   * Result confirms cycling/off, NOT physical acceleration. */
  change(module: PropulsionModule, on: boolean): Promise<boolean>;
  log(message: string): void;
}

/** Optional shared movement decorator. No MCC/profile selector and no reads or
 * polling of its own. Only a confirmed subwarp approach can create intent. */
/** Two points this close are one leg (see the salvager's next spot). */
const POINT_SAME_LEG_M = 1_000;

export function createTravelAssist(deps: TravelAssistDeps) {
  // `key` names the thing approached: an entity ("t<id>") or a fixed point ("p<x>,<y>,<z>"),
  // so a gotoPoint approach is owned and cleaned up exactly like an entity approach.
  let movement: { key: string; targetID: number | null; point: { x: number; y: number; z: number } | null; scope: string; range: number } | null = null;
  let owned: { module: PropulsionModule; key: string; scope: string; stopAttempts: number;
    baselineMax: number | null; baselineSpeed: number | null; observations: number; effectSeen: boolean; accelerationSeen: boolean } | null = null;
  let refused: string | null = null;
  let logged = "";
  const log = (message: string) => { if (message !== logged) { logged = message; deps.log(message); } };
  async function stop(): Promise<boolean> {
    if (!owned) return false;
    const current = owned;
    if (current.stopAttempts >= 3) return false; // retain custody: Stop/Parking cannot claim settlement
    current.stopAttempts++;
    try {
      if (!await deps.change(current.module, false)) throw new Error("authoritative off state not confirmed");
      log(`Travel assist deactivated ${current.module.itemID}: approach ended/authority changed.`);
      owned = null;
    } catch (error) {
      log(`Travel assist deactivation unconfirmed for ${current.module.itemID}: ${String(error)}; ownership retained for cleanup.`);
    }
    return true;
  }
  return {
    async beforeAction(input: TravelAssistInput): Promise<boolean> {
      const active = input.snapshot?.ship?.activeModuleIDs;
      const kind = input.action.kind;
      const isWork = input.workWhileMoving === true && (
        ["lock", "unlock", "lootWreck", "lootContainer", "salvageDrones", "launchDrones", "recallDrones", "salvageBatch"].includes(kind) ||
        (["activate", "deactivate"].includes(kind) && !input.modules.some(module => module.itemID === input.action.moduleID)));
      const usable = input.enabled && input.scope !== null && input.inWarp === false && input.docked === false && active != null;
      if (owned && active != null && !active.includes(owned.module.itemID)) {
        log(`Travel assist off confirmed: ${owned.module.itemID}; no automatic restart on the same approach.`);
        refused = `${owned.scope}:${owned.key}`;
        owned = null;
      }
      if (owned && active?.includes(owned.module.itemID)) {
        const max = input.snapshot?.ship?.maxVelocity;
        const velocity = input.snapshot?.ship?.velocity;
        const speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : NaN;
        owned.observations++;
        if (!owned.effectSeen && owned.baselineMax !== null && max != null && max > owned.baselineMax * 1.01) {
          owned.effectSeen = true;
          log(`Travel assist propulsion effect observed ${owned.module.itemID}: authoritative max velocity ${owned.baselineMax} -> ${max} m/s.`);
        }
        if (owned.effectSeen && !owned.accelerationSeen && owned.baselineSpeed !== null && speed > owned.baselineSpeed + 1) {
          owned.accelerationSeen = true;
          log(`Travel assist acceleration observed ${owned.module.itemID}: speed ${speed.toFixed(1)} m/s.`);
        }
        if (!owned.effectSeen && owned.observations === 3) log(`Travel assist ${owned.module.itemID}: cycling, but physical speed bonus not confirmed by current snapshots.`);
      }
      const point = input.action.kind === "gotoPoint" ? input.action.position : undefined;
      if (usable && ["approach", "orbit"].includes(input.action.kind) && input.action.targetID != null) {
        movement = { key: `t${input.action.targetID}`, targetID: input.action.targetID, point: null, scope: input.scope!, range: input.action.range ?? 0 };
      } else if (usable && point && [point.x, point.y, point.z].every(Number.isFinite)) {
        // ⚠ A POINT A FEW METRES ON IS THE SAME LEG. A salvager's next spot is worked out afresh each time it is
        // sent, and lands metres from the last: keyed exactly, each send ended the leg and lit the prop again,
        // flicking the afterburner every cycle (seen live 2026-10-14). Within POINT_SAME_LEG_M it keeps its key.
        const same = movement?.point && movement.scope === input.scope &&
          Math.hypot(movement.point.x - point.x, movement.point.y - point.y, movement.point.z - point.z) <= POINT_SAME_LEG_M;
        movement = same ? { ...movement!, point } : { key: `p${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`, targetID: null, point, scope: input.scope!, range: 0 };
      } else if (!usable || !(["wait", "lock"].includes(kind) || isWork) || movement?.scope !== input.scope) movement = null;
      const measured = !movement || !input.snapshot ? undefined
        : movement.point ? distanceToPoint(input.snapshot, movement.point)
        : measureSpace(input.snapshot)?.distances.get(movement.targetID!);
      const distance = measured == null || !Number.isFinite(measured) ? undefined : measured - (movement?.range ?? 0);
      if (distance == null || distance <= 5_000) movement = null;
      // ⚠ WHILE MOVING WITH WORK TO DO, THE PROP NEVER TAKES THE TICK. The runner drops the tick's own action when
      // this answers true, which a mining loop re-decides next tick but a salvager does not: its one order to fly
      // to the next spot was swallowed whenever the prop came on or off, and the ship drifted (seen live
      // 2026-10-14: fifteen sends, three reached the server). Here the change is made and the action still goes.
      const keepTick = input.workWhileMoving === true;
      if (owned && (!movement || owned.scope !== movement.scope || owned.key !== movement.key ||
          (input.scrammed === true && owned.module.kind === "microwarpdrive"))) {
        const stopped = await stop();
        return keepTick ? false : stopped;
      }
      if (!movement || owned || distance! <= 10_000 || input.action.kind === "lock" || isWork) return false;
      const key = `${movement.scope}:${movement.key}`;
      if (refused === key) return false;
      // Respect externally active modules. AB first, then itemID; shared policy
      // still owns capacitor/scram rules. Never activate both AB and MWD.
      if (input.modules.some(module => active!.includes(module.itemID))) { log("Travel assist skipped: propulsion already externally active."); return false; }
      const modules = input.modules.filter(module => module.kind !== null)
        .sort((a, b) => Number(a.kind !== "afterburner") - Number(b.kind !== "afterburner") || a.itemID - b.itemID);
      const picked = decidePropulsionModule({ modules, activeModuleIDs: new Set(active!), capacitorRatio: input.snapshot?.ship?.capacitorRatio ?? null,
        wantBurn: true, capFloor: 0.3, scrammed: input.scrammed });
      if (picked.kind !== "light") {
        const reason = modules.length === 0 ? "no online fitted propulsion with known effect"
          : input.scrammed === true && modules.every(module => module.kind !== "afterburner") ? "MWD blocked by warp scrambler"
          : "capacitor below 30% floor";
        log(`Travel assist skipped: ${reason}.`); return false;
      }
      const baselineMax = input.snapshot?.ship?.maxVelocity;
      const velocity = input.snapshot?.ship?.velocity;
      const baselineSpeed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : NaN;
      owned = { module: picked.module, key: movement.key, scope: movement.scope, stopAttempts: 0,
        baselineMax: baselineMax != null && Number.isFinite(baselineMax) ? baselineMax : null,
        baselineSpeed: Number.isFinite(baselineSpeed) ? baselineSpeed : null, observations: 0, effectSeen: false, accelerationSeen: false };
      try {
        if (!await deps.change(picked.module, true)) throw new Error("activation not confirmed");
        log(`Travel assist ${picked.module.kind} ${picked.module.itemID}: activation/cycling confirmed for approach ${movement.key}; awaiting physical effect observation.`);
      } catch (error) {
        refused = key;
        movement = null;
        // A definite already-active refusal is another controller's activation,
        // not an ambiguous write of ours. Never take shutdown custody of it.
        if (/MODULE_ALREADY_ACTIVE|ModuleAlreadyActive|already active/i.test(String(error))) owned = null;
        log(`Travel assist activation refused/unconfirmed: ${String(error)}; ordinary movement continues.`);
        // Keep custody of an ambiguous write until the next observation/off.
      }
      return !keepTick;
    },
    async requestStop(): Promise<void> { movement = null; await stop(); },
    pending(): boolean { return owned !== null; },
    confirmStopped(activeModuleIDs: readonly number[] | null): void {
      if (owned && activeModuleIDs !== null && !activeModuleIDs.includes(owned.module.itemID)) {
        log(`Travel assist off confirmed during cleanup: ${owned.module.itemID}.`);
        owned = null;
      }
    },
  };
}
