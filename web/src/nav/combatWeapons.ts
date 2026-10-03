import type { ScriptAction, MacroMemory } from "./scriptDecide.ts";

/** Fresh fitted identity and effective dogma. Null is never guessed range/ammo. */
export interface CombatWeapon {
  readonly itemID: number;
  readonly typeID: number;
  readonly chargeTypeID: number | null;
  readonly chargeQuantity: number | null;
  readonly acceptedGroups: readonly number[] | null;
  readonly chargeSize: number | null;
  readonly reachM: number | null;
  readonly tracking: number | null;
}
export interface CombatAmmo {
  readonly itemID: number; readonly typeID: number; readonly groupID: number | null;
  readonly size: number | null; readonly quantity: number;
}
export interface CombatWeapons {
  readonly shipID: number;
  readonly weaponBanks?: Readonly<Record<number, readonly number[]>> | null;
  readonly weapons: readonly CombatWeapon[];
  readonly cargo: readonly CombatAmmo[] | null;
}

export function compatibleAmmo(weapon: CombatWeapon, ammo: CombatAmmo): boolean {
  return ammo.quantity > 0 && ammo.groupID !== null &&
    weapon.acceptedGroups !== null && weapon.acceptedGroups.includes(ammo.groupID) &&
    weapon.chargeSize !== null && ammo.size !== null && ammo.size === weapon.chargeSize;
}

/** Policy envelope, not a claimed hit chance. Never drives movement doctrine. */
export function weaponUseful(weapon: CombatWeapon, distanceM: number | null): boolean {
  return distanceM !== null && weapon.reachM !== null && weapon.reachM > 0 &&
    distanceM <= weapon.reachM && weapon.chargeTypeID !== null &&
    weapon.chargeQuantity !== null && weapon.chargeQuantity > 0;
}

export const COMBAT_RELOAD_ATTEMPTS = 3;
export function combatReload(facts: CombatWeapons | null | undefined, mem: MacroMemory):
  { action: ScriptAction | null; memory: MacroMemory; degraded: boolean } {
  if (!facts || facts.cargo === null) return { action: null, memory: mem, degraded: true };
  const attempts = { ...(mem.reloadAttempts as Record<number, number> | undefined ?? {}) };
  let degraded = false;
  for (const weapon of facts.weapons) {
    if (weapon.chargeTypeID !== null && (weapon.chargeQuantity ?? 0) > 0) {
      delete attempts[weapon.itemID];
      continue;
    }
    degraded = true;
    if (!unbankedWeapon(facts, weapon.itemID)) continue;
    if ((attempts[weapon.itemID] ?? 0) >= COMBAT_RELOAD_ATTEMPTS) continue;
    const candidates = facts.cargo.filter(ammo => compatibleAmmo(weapon, ammo))
      .sort((a, b) => b.quantity - a.quantity || a.itemID - b.itemID);
    const ammo = candidates[0];
    if (!ammo) continue;
    attempts[weapon.itemID] = (attempts[weapon.itemID] ?? 0) + 1;
    return { action: { kind: "loadCombatAmmo", moduleID: weapon.itemID,
      chargeItemID: ammo.itemID, chargeTypeID: ammo.typeID },
      memory: { ...mem, reloadAttempts: attempts }, degraded };
  }
  return { action: null, memory: { ...mem, reloadAttempts: attempts }, degraded };
}
export function unbankedWeapon(facts: CombatWeapons, itemID: number): boolean {
  return facts.weaponBanks != null && !Object.entries(facts.weaponBanks)
    .some(([master, slaves]) => Number(master) === itemID || slaves.includes(itemID));
}
