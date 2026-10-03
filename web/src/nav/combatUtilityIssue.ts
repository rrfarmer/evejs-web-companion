import { utilityChargeFits, type CombatUtilities, type CombatUtility } from "./combatUtilities.ts";
import type { ScriptAction } from "./scriptDecide.ts";

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
interface UtilityIssueDeps {
  current(): boolean;
  read(): Promise<CombatUtilities | null>;
  sleep?(): Promise<void>;
}
/** Dispatch once, then fresh exact effect/target or charge AND capacitor evidence. */
export async function issueCombatUtility(action: Extract<ScriptAction, { kind: "activate" }>, deps: UtilityIssueDeps & {
  activate(): Promise<{ itemID: number; active: boolean | null }>;
  targetValid?(module: CombatUtility): Promise<boolean>;
}): Promise<void> {
  const before = await deps.read();
  if (!deps.current()) fail("CALL_REFUSED", "Utility authority retired before dispatch.");
  const module = before?.modules.find(row => row.itemID === action.moduleID && row.typeID === action.typeID);
  if (!before || !module || module.active || !module.modeKnown || before.capacitor === null ||
      module.capNeed === null || before.capacitor < module.capNeed) fail("CALL_REFUSED", "Exact idle utility fit/mode/cap is not proven.");
  if (["web", "painter"].includes(module.family) && (action.targetID <= 0 || await deps.targetValid?.(module) !== true))
    fail("CALL_REFUSED", "Fresh locked NPC and proven utility reach are required.");
  if (!deps.current()) fail("CALL_REFUSED", "Utility authority retired before dispatch.");
  if (module.family === "capacitor" && (!module.charge || !utilityChargeFits(module.type, module.charge) ||
      module.chargeUnits === null || module.chargeUnits <= 0 || module.quantity < module.chargeUnits || before.cargo === null ||
      action.repeat !== 0 || action.capDemandFloor === undefined || before.capacitorRatio === null || before.capacitorRatio >= action.capDemandFloor))
    fail("CALL_REFUSED", "Compatible loaded capacitor charge is not proven.");
  const receipt = await deps.activate(); // Transport failure belongs to existing runner uncertainty custody.
  if (receipt.itemID !== module.itemID) fail("MODULE_ACTION_UNCERTAIN", "Utility receipt identity is unconfirmed.");
  let provenInactive = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await deps.sleep?.();
    const after = await deps.read();
    if (!deps.current()) fail("MODULE_ACTION_UNCERTAIN", "Utility authority retired during reconciliation.");
    if (after?.shipID !== before.shipID) continue;
    const next = after.modules.find(row => row.itemID === module.itemID && row.typeID === module.typeID);
    provenInactive = next?.active === false;
    if (module.family === "capacitor") {
      const count = (facts: CombatUtilities, row: CombatUtility) => facts.cargo === null ? null :
        (row.charge?.typeID === module.charge!.typeID ? row.quantity : 0) +
        facts.cargo.filter(stack => stack.type.typeID === module.charge!.typeID).reduce((sum, stack) => sum + stack.quantity, 0);
      const initial = count(before, module), final = next && count(after, next);
      if (next && initial !== null && final != null && initial - final === module.chargeUnits &&
          after.capacitor !== null && after.capacitor > before.capacitor!) return;
    } else if (next?.active && next.effectID === module.effectID && next.targetID === (action.targetID > 0 ? action.targetID : null)) return;
  }
  if (receipt.active === false && provenInactive && module.family !== "capacitor")
    fail("CALL_REFUSED", "Exact utility activation was refused and application was not observed.");
  fail("MODULE_ACTION_UNCERTAIN", "Exact utility application is unconfirmed; do not replay.");
}

export async function issueUtilityReload(action: Extract<ScriptAction, { kind: "loadCombatAmmo" }>, deps: UtilityIssueDeps & {
  load(): Promise<unknown>;
}): Promise<string | void> {
  const before = await deps.read();
  if (!deps.current()) fail("CALL_REFUSED", "Utility reload authority retired.");
  const module = before?.modules.find(row => row.itemID === action.moduleID && row.family === "capacitor");
  const stack = before?.cargo?.find(row => row.itemID === action.chargeItemID && row.type.typeID === action.chargeTypeID);
  if (!before || !module || module.active || module.quantity > 0 || !stack ||
      (module.chargeUnits ?? 0) <= 0 || stack.quantity < module.chargeUnits! || !utilityChargeFits(module.type, stack.type) ||
      (stack.type.attributes[67] ?? 0) <= 0) return "REFUSED utility reload: exact compatible empty fit/stack is not proven.";
  try { await deps.load(); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "CALL_REFUSED") return "REFUSED utility reload; bounded attempt consumed.";
    fail("MODULE_ACTION_UNCERTAIN", "Utility reload dispatch outcome is unknown.");
  }
  for (let attempt = 0; attempt < (deps.sleep ? 21 : 1); attempt++) {
    if (attempt > 0) await deps.sleep?.();
    const after = await deps.read();
    if (!deps.current()) fail("MODULE_ACTION_UNCERTAIN", "Utility reload authority retired during reconciliation.");
    const next = after?.shipID === before.shipID ? after.modules.find(row => row.itemID === module.itemID) : null;
    if (next?.charge?.typeID === action.chargeTypeID && next.quantity >= module.chargeUnits! &&
        utilityChargeFits(next.type, next.charge)) return;
  }
  fail("MODULE_ACTION_UNCERTAIN", "Loaded utility charge is unconfirmed; do not replay.");
}
