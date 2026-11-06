// What a companion has left to fight with, said in chat: the `status` answer,
// and the low-ammo and low-drone warnings it gives without being asked.
//
// Pure: it reads the observation and the ladder memory and returns the memory
// and the lines to say. `decideCompanionAction` runs it after every tick's step,
// so it never takes a tick from a rung, and the controller sends the lines.
//
// ⚠ RELOADS ARE COUNTED AGAINST WHAT A GUN HAS BEEN SEEN TO HOLD. A gun's full
// load is its capacity over the charge's volume, and neither is read here; the
// most charges the gun has been seen loaded with this run is the number the
// server itself put in it. Guns start a run full, and every reload fills one,
// so this is a full load after the first read and never a guess before it: a
// gun never seen loaded has no load, and its pool says nothing about reloads.
//
// ⚠ SPARE AMMO IS EVERY STACK THE GUN CAN TAKE, not only the type in it. The
// reload rung loads whatever fits once a type runs out, so 400 rounds of a
// second type are reloads too. "Fits" is the gun's own charge groups and, when
// both are read, the same charge size; an unread size is not a reason to doubt
// a stack whose group fits.
//
// ⚠ A WARNING IS SAID ONCE PER STEP DOWN, AND ONLY AFTER IT HOLDS. A launch or
// a scoop moves a drone between the bay read and the scene read of the same
// tick, and for that tick a drone can be counted twice or not at all. A level
// worse than the last one said must stand `SUPPLY_ALERT_SETTLE_MS` before it is
// said; getting better is taken silently, so a resupply re-arms the warning.

import type {
  CompanionLadderMemory,
  FleetCompanionObservation,
  FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";

/** At or below this many reloads left, the pilot says it is low on ammo. */
export const LOW_AMMO_RELOADS = 2;

/** How long a worse supply level must stand before it is said. See the header. */
export const SUPPLY_ALERT_SETTLE_MS = 6_000;

export type SupplyLevel = "ok" | "low" | "out";

/** One resource's warning state: what was last said, and a worse level waiting to settle. */
export interface SupplyAlert {
  readonly said: SupplyLevel | null;
  readonly worse: { readonly level: SupplyLevel; readonly sinceMs: number } | null;
}

export interface CompanionSupplyMemory {
  /** Weapon module item id -> the most charges it has been seen loaded with. */
  readonly loads: Readonly<Record<number, number>>;
  /** The most combat drones seen aboard (bay and space) this run. */
  readonly dronesPeak: number;
  readonly ammoAlert: SupplyAlert;
  readonly droneAlert: SupplyAlert;
  /** A `status` addressed to this pilot was heard and not answered yet. */
  readonly statusAsked: boolean;
}

const QUIET: SupplyAlert = Object.freeze({ said: null, worse: null });

export const FRESH_COMPANION_SUPPLY: CompanionSupplyMemory = Object.freeze({
  loads: Object.freeze({}),
  dronesPeak: 0,
  ammoAlert: QUIET,
  droneAlert: QUIET,
  statusAsked: false,
});

/** One charge stack in the cargo that some gun can take. */
interface SpareStack {
  readonly typeID: number;
  readonly quantity: number;
}

export interface AmmoSupply {
  /** Reloads left across the guns, the worst pool; null when no pool has a known load. */
  readonly reloads: number | null;
  /** Charges in the guns now. */
  readonly loaded: number;
  /** Spare charges the guns can take, by type, largest first. */
  readonly spare: readonly SpareStack[];
}

/**
 * The ammunition left, or null when there is nothing to say: no gun takes a
 * charge, or the fit or the cargo could not be read.
 */
export function ammoSupply(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  loads: Readonly<Record<number, number>>,
): AmmoSupply | null {
  const groups = obs.weaponChargeGroups ?? null;
  const cargo = obs.cargoCharges ?? null;
  const loadedCharges = obs.loadedCharges ?? null;
  if (groups === null || cargo === null || loadedCharges === null) {
    return null;
  }
  const sizeOfCharge = (typeID: number): number | null => obs.chargeFactsByTypeID?.[typeID]?.size ?? null;
  const guns = request.weaponModuleIDs.filter((id) => (groups[id]?.length ?? 0) > 0);
  if (guns.length === 0) {
    return null;
  }
  let loaded = 0;
  // Guns sharing the same eligible stacks draw on one pool, and a pool's reloads
  // are its spare rounds over the loads of every gun drawing on it.
  const pools = new Map<string, { stacks: readonly number[]; load: number; unknownLoads: number; knownLoads: number[] }>();
  for (const gun of guns) {
    const inGun = loadedCharges.find((charge) => charge.moduleID === gun) ?? null;
    loaded += inGun?.quantity ?? 0;
    const size = obs.combatWeapons?.weapons.find((weapon) => weapon.itemID === gun)?.chargeSize
      ?? (inGun === null ? null : sizeOfCharge(inGun.typeID));
    const accepted = groups[gun] ?? [];
    const stacks = cargo
      .filter((stack) => stack.groupID !== null && accepted.includes(stack.groupID))
      .filter((stack) => {
        const stackSize = sizeOfCharge(stack.typeID);
        return size === null || stackSize === null || stackSize === size;
      })
      .map((stack) => stack.itemID)
      .sort((a, b) => a - b);
    const key = stacks.join(",");
    const pool = pools.get(key) ?? { stacks, load: 0, unknownLoads: 0, knownLoads: [] };
    const full = Math.max(loads[gun] ?? 0, inGun?.quantity ?? 0);
    if (full > 0) {
      pool.load += full;
      pool.knownLoads.push(full);
    } else {
      pool.unknownLoads += 1;
    }
    pools.set(key, pool);
  }
  let reloads: number | null = null;
  for (const pool of pools.values()) {
    // ⚠ A GUN THAT HOLDS ONE CHARGE HOLDS A LENS. A laser takes a single
    // frequency crystal and firing does not use it up, so "no spare crystals" is
    // not "out of ammo" and warning about it would be a laser boat crying wolf
    // every run. Every turret charge and every missile comes many to a load.
    if (pool.knownLoads.length === 0 || Math.max(...pool.knownLoads) <= 1) {
      continue;
    }
    // A gun of the pool not yet seen loaded counts as its biggest sibling: the
    // same pool is the same charges, and so in practice the same gun.
    const load = pool.load + pool.unknownLoads * Math.max(...pool.knownLoads);
    const rounds = cargo
      .filter((stack) => pool.stacks.includes(stack.itemID))
      .reduce((sum, stack) => sum + stack.quantity, 0);
    const here = Math.floor(rounds / load);
    reloads = reloads === null ? here : Math.min(reloads, here);
  }
  const eligible = new Set([...pools.values()].flatMap((pool) => pool.stacks));
  const byType = new Map<number, number>();
  for (const stack of cargo) {
    if (eligible.has(stack.itemID)) {
      byType.set(stack.typeID, (byType.get(stack.typeID) ?? 0) + stack.quantity);
    }
  }
  const spare = [...byType.entries()]
    .map(([typeID, quantity]) => ({ typeID, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.typeID - b.typeID);
  return { reloads, loaded, spare };
}

export interface DroneSupply {
  readonly inBay: number;
  readonly out: number;
}

/** The combat drones aboard and out, or null when either half could not be read. */
export function droneSupply(obs: FleetCompanionObservation): DroneSupply | null {
  const stacks = obs.combatDroneStacks ?? null;
  const out = obs.combatDroneIDs ?? null;
  if (stacks === null || out === null) {
    return null;
  }
  // ⚠ A QUANTITY BELOW NOUGHT IS ONE DRONE. A drone that has been launched and
  // scooped comes back a singleton, and the bay reports a singleton's quantity
  // as -1 (the client reads it so: eveMisc.LaunchFromShip). Summed raw, a bay of
  // eleven recovered drones read "-11 in bay" (seen live 2026-10-16).
  const inBay = stacks.reduce((sum, stack) => sum + (stack.quantity < 0 ? 1 : stack.quantity), 0);
  // ⚠ A DRONE BEING SCOOPED IS IN BOTH READS FOR A MOMENT. It comes back a
  // singleton with its own item id, and the bay read has it a second or so
  // before the scene read lets it go; counted in both, a flight coming home
  // read as eleven drones plus five, the run's most-carried mark went up to
  // match, and once they were all aboard the real eleven read "low" (seen live
  // 2026-10-20). A drone the bay already holds is counted there and only there.
  const aboard = new Set(stacks.map((stack) => stack.itemID));
  return { inBay, out: out.filter((droneID) => !aboard.has(droneID)).length };
}

function ammoLevel(ammo: AmmoSupply | null): SupplyLevel | null {
  if (ammo === null || ammo.reloads === null) {
    return null;
  }
  return ammo.reloads === 0 ? "out" : ammo.reloads <= LOW_AMMO_RELOADS ? "low" : "ok";
}

/**
 * The drone level against a full flight: the fewer of the most drones this run
 * has carried and the pilot's active-drone cap. Measured against what the ship
 * was seen to carry, so a hull that carries two by design is not forever "low"
 * against a skill cap of five. Null for a ship that has never carried any.
 */
function droneLevel(drones: DroneSupply | null, peak: number, maxActive: number | null): SupplyLevel | null {
  if (drones === null || peak === 0) {
    return null;
  }
  const total = drones.inBay + drones.out;
  const full = Math.min(peak, maxActive ?? peak);
  return total === 0 ? "out" : total < full ? "low" : "ok";
}

const RANK: Readonly<Record<SupplyLevel, number>> = { ok: 0, low: 1, out: 2 };

/** The alert after this tick's level, and whether the level is to be said now. */
function stepAlert(alert: SupplyAlert, level: SupplyLevel | null, nowMs: number): { alert: SupplyAlert; say: boolean } {
  if (level === null) {
    return { alert, say: false };
  }
  if (RANK[level] <= RANK[alert.said ?? "ok"]) {
    return { alert: alert.said === level && alert.worse === null ? alert : { said: level, worse: null }, say: false };
  }
  if (alert.worse?.level !== level) {
    return { alert: { said: alert.said, worse: { level, sinceMs: nowMs } }, say: false };
  }
  if (nowMs - alert.worse.sinceMs < SUPPLY_ALERT_SETTLE_MS) {
    return { alert, say: false };
  }
  return { alert: { said: level, worse: null }, say: true };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function chargeName(obs: FleetCompanionObservation, typeID: number): string {
  return obs.chargeFactsByTypeID?.[typeID]?.name ?? "rounds";
}

function ammoWords(obs: FleetCompanionObservation, ammo: AmmoSupply): string {
  const spare = ammo.spare.length === 0
    ? "nothing spare in cargo"
    : `${ammo.spare.map((stack) => `${stack.quantity} ${chargeName(obs, stack.typeID)}`).join(", ")} in cargo`;
  const reloads = ammo.reloads === null ? "" : `${plural(ammo.reloads, "reload", "reloads")} left, `;
  return `Ammo: ${reloads}${ammo.loaded} loaded, ${spare}.`;
}

function droneWords(drones: DroneSupply | null, peak: number): string {
  if (drones === null) {
    return "Drones: could not read.";
  }
  if (drones.inBay + drones.out === 0 && peak === 0) {
    return "Drones: none carried.";
  }
  return `Drones: ${drones.inBay} in bay, ${drones.out} out.`;
}

/** The answer to `status`: ammunition, then drones, in one plain line. */
export function statusLine(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  supply: CompanionSupplyMemory,
): string {
  const ammo = ammoSupply(request, obs, supply.loads);
  const anyGun = request.weaponModuleIDs.some((id) => (obs.weaponChargeGroups?.[id]?.length ?? 0) > 0);
  const fitRead = obs.weaponChargeGroups != null && obs.cargoCharges != null && obs.loadedCharges != null;
  const ammoPart = ammo !== null ? ammoWords(obs, ammo)
    : fitRead && !anyGun ? "Ammo: no guns that use it." : "Ammo: could not read.";
  return `${ammoPart} ${droneWords(droneSupply(obs), supply.dronesPeak)}`;
}

/**
 * This tick's supply bookkeeping: learn the guns' loads and the drones carried,
 * step both warnings, answer a pending `status`. Returns the memory to keep and
 * the lines to say, in order.
 */
export function superviseSupply(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): { readonly memory: CompanionLadderMemory; readonly say: readonly string[] } {
  const before = memory.supply;
  let loads = before.loads;
  for (const charge of obs.loadedCharges ?? []) {
    if (request.weaponModuleIDs.includes(charge.moduleID) && charge.quantity > (loads[charge.moduleID] ?? 0)) {
      loads = { ...loads, [charge.moduleID]: charge.quantity };
    }
  }
  const drones = droneSupply(obs);
  const dronesPeak = drones === null ? before.dronesPeak : Math.max(before.dronesPeak, drones.inBay + drones.out);
  const ammo = ammoSupply(request, obs, loads);
  const ammoStep = stepAlert(before.ammoAlert, ammoLevel(ammo), nowMs);
  const droneStep = stepAlert(before.droneAlert, droneLevel(drones, dronesPeak, obs.droneLimits?.maxActive ?? null), nowMs);

  const say: string[] = [];
  if (ammoStep.say && ammo !== null) {
    say.push(ammoStep.alert.said === "out"
      ? ammo.loaded === 0 ? "Out of ammo." : `Out of spare ammo: ${ammo.loaded} rounds left in the guns.`
      : `Low on ammo: ${plural(ammo.reloads ?? 0, "reload", "reloads")} left.`);
  }
  if (droneStep.say && drones !== null) {
    say.push(droneStep.alert.said === "out"
      ? "Out of drones."
      : `Low on drones: ${drones.inBay + drones.out} left (${drones.inBay} in bay, ${drones.out} out).`);
  }
  const next: CompanionSupplyMemory = {
    loads,
    dronesPeak,
    ammoAlert: ammoStep.alert,
    droneAlert: droneStep.alert,
    statusAsked: false,
  };
  if (before.statusAsked) {
    say.push(statusLine(request, obs, next));
  }
  const changed = loads !== before.loads || dronesPeak !== before.dronesPeak ||
    ammoStep.alert !== before.ammoAlert || droneStep.alert !== before.droneAlert || before.statusAsked;
  return { memory: changed ? { ...memory, supply: next } : memory, say };
}
