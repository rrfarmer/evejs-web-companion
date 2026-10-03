import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
import { asFloat } from "../bridge/boundDogma.ts";
import { readDictPairs } from "../bridge/wire.ts";
import { slotFlagOf } from "../bridge/fitting.ts";
import type { FittingSlot } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, ScriptAction } from "./scriptDecide.ts";
import type { CombatOwnership } from "./combatOwnership.ts";

export type UtilityFamily = "web" | "painter" | "sensor" | "tracking" | "omni" | "capacitor";
export interface UtilityType {
  readonly typeID: number; readonly groupID: number; readonly categoryID: number;
  readonly effects: readonly number[]; readonly attributes: Readonly<Record<number, number>>;
  readonly capacity: number | null; readonly volume: number | null;
}
export interface CombatUtility {
  readonly itemID: number; readonly typeID: number; readonly family: UtilityFamily;
  readonly effectID: number; readonly active: boolean; readonly targetID: number | null;
  readonly rangeM: number | null; readonly falloffM: number | null; readonly capNeed: number | null;
  readonly modeKnown: boolean; readonly type: UtilityType; readonly charge: UtilityType | null;
  readonly quantity: number; readonly chargeUnits: number | null;
}
export interface UtilityCargo { readonly itemID: number; readonly quantity: number; readonly type: UtilityType }
export interface CombatUtilities {
  readonly shipID: number; readonly modules: readonly CombatUtility[];
  readonly cargo: readonly UtilityCargo[] | null; readonly capacitor: number | null;
  readonly capacitorRatio: number | null;
}
// Pinned SDE group AND activation effect; no names, hulls, or module type allowlist.
const FAMILIES: Readonly<Record<number, readonly [UtilityFamily, number]>> = {
  65: ["web", 6426], 379: ["painter", 6425], 212: ["sensor", 2670],
  213: ["tracking", 4559], 646: ["omni", 6557], 76: ["capacitor", 48],
};
// Explicit understood script modes from the pinned SDE. Other scripts stay off.
const SCRIPTS: Readonly<Record<string, readonly number[]>> = {
  sensor: [29009, 29011, 41155], tracking: [28999, 29001], omni: [28999, 29001],
};
const attr = (entry: DogmaItemInfo | undefined, id: number): number | null => {
  const value = entry?.attributes.find(row => row.attributeID === id)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** Retail activeEffects value: [item, owner, ship, target, other, [], effect, time, duration, repeat]. */
export function utilityEffect(entry: DogmaItemInfo, effectID: number, shipID: number):
  { active: boolean; targetID: number | null } | null {
  const effects = entry.activeEffects as { type?: unknown; entries?: unknown } | null;
  if (!effects || effects.type !== "dict" || !Array.isArray(effects.entries) ||
      !effects.entries.every(row => Array.isArray(row) && row.length === 2 &&
        Number.isSafeInteger(asFloat(row[0])) && asFloat(row[0])! > 0)) return null;
  const pairs = readDictPairs(effects);
  if (new Set(pairs.map(([key]) => asFloat(key))).size !== pairs.length) return null;
  const raw = pairs.find(([key]) => asFloat(key) === effectID)?.[1];
  if (raw === undefined) return { active: false, targetID: null };
  if (!Array.isArray(raw) || raw.length !== 10 || asFloat(raw[0]) !== Number(entry.itemID) ||
      asFloat(raw[2]) !== shipID || asFloat(raw[6]) !== effectID) return null;
  const target = raw[3] === null ? null : asFloat(raw[3]);
  if (raw[3] !== null && (target === null || !Number.isSafeInteger(target) || target <= 0)) return null;
  return { active: true, targetID: target };
}

/** EveJS chargeCompatibilityPolicy: declared group + required numeric size, otherwise physical size.
 * Unlike the server's one-unit fallback, missing capacity/volume fails closed here. */
export function utilityChargeFits(module: UtilityType, charge: UtilityType): boolean {
  const groups = [604, 605, 606, 609, 610].map(id => module.attributes[id]).filter(id => id !== undefined && id > 0);
  const size = module.attributes[128] ?? 0;
  const capacity = module.attributes[38] ?? module.capacity;
  return charge.categoryID === 8 && groups.includes(charge.groupID) &&
    (size <= 0 || charge.attributes[128] === size) && capacity !== null && capacity > 0 &&
    charge.volume !== null && charge.volume > 0 && charge.volume <= capacity;
}

export function combatUtilityFit(shipID: number, slots: readonly FittingSlot[], dogma: BoundDogmaAllInfo | null,
  types: Readonly<Record<number, UtilityType>>, cargo: readonly UtilityCargo[] | null, capRatio: number | null): CombatUtilities | null {
  if (dogma === null || Number(dogma.activeShipID) !== shipID) return null;
  const capacity = attr(dogma.ships.find(row => Number(row.itemID) === shipID), 482);
  return { shipID, cargo, capacitorRatio: capRatio, capacitor: capacity !== null && capacity > 0 && capRatio !== null ? capacity * capRatio : null,
    modules: slots.flatMap(slot => {
      const m = slot.module, type = m && types[m.typeID], spec = type && FAMILIES[type.groupID];
      if (!m?.online || !type || type.categoryID !== 7 || type.groupID !== m.groupID || !spec || !type.effects.includes(spec[1])) return [];
      const entry = dogma.ships.find(row => Number(row.itemID) === m.itemID && row.typeID === m.typeID &&
        Number(row.locationID) === shipID && row.flagID === slotFlagOf(slot.family, slot.index));
      if (!entry || !(attr(entry, 73)! > 0)) return [];
      const effect = utilityEffect(entry, spec[1], shipID);
      if (!effect) return [];
      const charge = m.charge ? types[m.charge.typeID] ?? null : null;
      const modeKnown = m.charge === null ? true : charge !== null && utilityChargeFits(type, charge) &&
        (spec[0] === "capacitor" ? (charge.attributes[67] ?? 0) > 0 : SCRIPTS[spec[0]]?.includes(charge.typeID) === true);
      return [{ itemID: m.itemID, typeID: m.typeID, type, family: spec[0], effectID: spec[1], ...effect,
        rangeM: attr(entry, 54), falloffM: attr(entry, 2044), capNeed: spec[0] === "capacitor" ? 0 : attr(entry, 6),
        modeKnown, charge, quantity: m.charge?.quantity ?? 0, chargeUnits: attr(entry, 56) }];
    }) };
}

type UtilityDecision = { action: ScriptAction | null; memory: MacroMemory; why: string; blocked?: string };
const none = (memory: MacroMemory): UtilityDecision => ({ action: null, memory, why: "" });
function retiring(memory: MacroMemory): UtilityDecision {
  const ticks = Number(memory.utilityRetireTicks ?? 0) + 1;
  return { action: { kind: "wait" }, memory: { ...memory, utilityRetireTicks: ticks },
    why: "Waiting for the exact owned utility OFF state.",
    ...(ticks > 30 ? { blocked: "Utility shutdown could not be proven; human reconciliation is required." } : {}) };
}
function request(module: CombatUtility, targetID: number, memory: MacroMemory): UtilityDecision {
  const attempts = memory.utilityAttempts as Record<string, number> | undefined ?? {};
  const key = `${module.itemID}:${targetID}`;
  if ((attempts[key] ?? 0) >= 3) return none(memory);
  return { action: { kind: "activate", moduleID: module.itemID, typeID: module.typeID, targetID, utility: true,
    ...(module.family === "capacitor" ? { repeat: 0 as const } : {}) },
    memory: { ...memory, utilityAttempts: { ...attempts, [key]: (attempts[key] ?? 0) + 1 } },
    why: `Using fitted combat ${module.family}.` };
}
/** Optional rung, after primary/drone custody, before guns. Never selects targets or movement. */
export function decideCombatUtilities(obs: ScriptObservation, memory: MacroMemory, primaryID: number | null): UtilityDecision {
  const facts = obs.combatUtilities;
  if (!facts || obs.inSpace !== true || obs.inWarp === true || obs.snapshot?.ship?.itemID !== facts.shipID)
    return memory.utilityStopping !== undefined ? retiring(memory) : none(memory);
  const custody = memory.combatOwned as CombatOwnership | undefined;
  const owned = custody?.modules ?? {};
  const primary = obs.snapshot.entities.find(row => row.itemID === primaryID && row.isNpc === true && row.characterID == null);
  const targetValid = primary != null && obs.lockedTargetIDs?.includes(primary.itemID) === true &&
    primary.geometryAvailable === true && obs.snapshot.ship.geometryAvailable === true;
  const origin = obs.snapshot.ship.position;
  const distance = primary && origin ? Math.max(0, Math.hypot(primary.position.x-origin.x, primary.position.y-origin.y,
    primary.position.z-origin.z) - primary.radius - (obs.snapshot.ship.radius ?? 0)) : null;
  const hasDrones = (obs.combatDroneIDs?.length ?? 0) > 0;
  const hasTurrets = obs.combatWeapons?.weapons.some(row => row.tracking !== null && row.tracking > 0) === true;
  const damage = hasDrones || obs.combatWeapons?.weapons.some(row => row.reachM !== null && (row.chargeQuantity ?? 0) > 0) === true;
  for (const module of facts.modules) {
    if (!["web", "painter"].includes(module.family) || !module.active || owned[module.itemID] === undefined) continue;
    if (!targetValid || module.targetID !== primaryID || distance === null || module.rangeM === null || distance > module.rangeM) {
      const retiring = memory.utilityStopping as number | undefined;
      if (retiring === module.itemID) return { action: { kind: "wait" },
        memory: { ...memory, utilityRetireTicks: Number(memory.utilityRetireTicks ?? 0) + 1 },
        ...(Number(memory.utilityRetireTicks ?? 0) >= 30 ? { blocked: "Owned utility OFF state is unconfirmed." } : {}),
        why: "Waiting for the owned utility cycle to retire." };
      return { action: { kind: "deactivate", moduleID: module.itemID, typeID: module.typeID, settlement: true },
        memory: { ...memory, utilityStopping: module.itemID,
          combatOwned: { ...custody!, stoppingModuleID: module.itemID } },
        why: "Retiring an owned utility before target reassignment." };
    }
  }
  if (memory.utilityStopping !== undefined) {
    const stopping = facts.modules.find(row => row.itemID === memory.utilityStopping);
    if (!stopping || stopping.active) return retiring(memory);
    memory = { ...memory, utilityStopping: undefined, utilityRetireTicks: undefined,
      combatOwned: { ...custody!, stoppingModuleID: undefined } };
  }
  for (const module of facts.modules) {
    if (module.active || !module.modeKnown || module.family === "capacitor" || facts.capacitor === null ||
        module.capNeed === null || facts.capacitor < module.capNeed) continue;
    const targeted = module.family === "web" || module.family === "painter";
    if (targeted && (!targetValid || distance === null || module.rangeM === null || module.rangeM <= 0 || distance > module.rangeM ||
        (module.family === "painter" && !damage))) continue;
    if (!targeted && (!targetValid || (module.family === "tracking" && !hasTurrets) || (module.family === "omni" && !hasDrones))) continue;
    const result = request(module, targeted ? primaryID! : 0, memory);
    if (result.action) return result;
  }
  return none(memory);
}

/** Called only by an existing required-action cap gate, never by an arbitrary low-cap watch. */
export function combatCapSustain(obs: ScriptObservation, memory: MacroMemory, floor: number): UtilityDecision {
  const facts = obs.combatUtilities;
  if (!facts || facts.capacitor === null || facts.capacitorRatio === null || facts.capacitorRatio >= floor ||
      obs.inSpace !== true || obs.inWarp === true || obs.snapshot?.ship?.itemID !== facts.shipID) return none(memory);
  for (const module of facts.modules) {
    if (module.family !== "capacitor" || module.active || (module.chargeUnits ?? 0) <= 0) continue;
    if (module.charge && module.modeKnown && module.quantity >= module.chargeUnits! &&
        (module.charge.attributes[67] ?? 0) > 0) {
      const result = request(module, 0, memory);
      return { ...result, action: result.action?.kind === "activate" ? { ...result.action, capDemandFloor: floor } : result.action };
    }
    if (module.quantity > 0 || facts.cargo === null) continue;
    const attempts = memory.utilityReloadAttempts as Record<number, number> | undefined ?? {};
    if ((attempts[module.itemID] ?? 0) >= 3) continue;
    const ammo = facts.cargo.find(row => row.quantity >= module.chargeUnits! && utilityChargeFits(module.type, row.type) &&
      (row.type.attributes[67] ?? 0) > 0);
    if (ammo) return { action: { kind: "loadCombatAmmo", moduleID: module.itemID, chargeItemID: ammo.itemID,
      chargeTypeID: ammo.type.typeID, utility: true }, memory: { ...memory,
        utilityReloadAttempts: { ...attempts, [module.itemID]: (attempts[module.itemID] ?? 0) + 1 } },
      why: "Loading a strictly compatible capacitor charge for a blocked required action." };
  }
  return none(memory);
}
