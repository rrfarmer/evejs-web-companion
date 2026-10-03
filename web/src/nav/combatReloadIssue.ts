import { compatibleAmmo, unbankedWeapon, type CombatWeapons } from "./combatWeapons.ts";
import type { ScriptAction } from "./scriptDecide.ts";

/** Revalidate the exact weapon and stack under the same pilot/run authority. */
export async function issueCombatReload(action: Extract<ScriptAction, { kind: "loadCombatAmmo" }>, deps: {
  read(): Promise<CombatWeapons | null>;
  current(): boolean;
  load(): Promise<unknown>;
  /** Read-only reconciliation after the single dispatch, never another load. */
  sleep?(): Promise<void>;
}): Promise<string | void> {
  const facts = await deps.read();
  if (!deps.current()) throw Object.assign(new Error("Reload authority retired before dispatch."), { code: "CALL_REFUSED" });
  const weapon = facts?.weapons.find(row => row.itemID === action.moduleID);
  const ammo = facts?.cargo?.find(row => row.itemID === action.chargeItemID && row.typeID === action.chargeTypeID);
  if (!facts || !weapon || !ammo || !unbankedWeapon(facts, weapon.itemID) || !compatibleAmmo(weapon, ammo))
    return "Reload refused: unbanked weapon and compatible ammunition could not be proven.";
  if (weapon.chargeTypeID !== null && (weapon.chargeQuantity ?? 0) > 0) return "Weapon is already loaded.";
  try { await deps.load(); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CALL_REFUSED")
      return "Reload definitely refused; the bounded attempt was consumed.";
    throw Object.assign(new Error("Reload dispatch outcome requires reconciliation."), { code: "MODULE_ACTION_UNCERTAIN", cause: error });
  }
  for (let read = 0; read < (deps.sleep ? 21 : 1); read++) {
    if (!deps.current()) break;
    if (read > 0) await deps.sleep!();
    if (!deps.current()) break;
    const after = await deps.read();
    const loaded = after?.weapons.find(row => row.itemID === action.moduleID);
    if (deps.current() && after?.shipID === facts.shipID && loaded?.chargeTypeID === action.chargeTypeID && (loaded.chargeQuantity ?? 0) > 0) return;
  }
  throw Object.assign(new Error("Reload outcome requires reconciliation; no second load will be sent."), { code: "MODULE_ACTION_UNCERTAIN" });
}
