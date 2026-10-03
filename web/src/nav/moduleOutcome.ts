/** Shared scripted module postconditions. Transport ACK is not world proof. */
export function requireModuleOutcome(result: { itemID: number; active: boolean | null; stopped: boolean | null },
  itemID: number, action: "activate" | "deactivate"): void {
  const evidence = action === "activate" ? result.active : result.stopped;
  if (result.itemID === itemID && evidence === true) return;
  const refused = result.itemID === itemID && evidence === false && action === "activate";
  throw Object.assign(new Error(refused ? "The requested module refused activation." :
    "The requested module outcome is unconfirmed; reconcile before another mutation."),
    { code: refused ? "CALL_REFUSED" : "MODULE_ACTION_UNCERTAIN" });
}
/** Owned settlement can retain an unconfirmed OFF intent without replaying it. */
export function moduleSettlementNote(result: { itemID: number; stopped: boolean | null }, itemID: number): string | null {
  if (result.itemID !== itemID) throw Object.assign(new Error("Requested shutdown identity is unconfirmed."), { code: "MODULE_ACTION_UNCERTAIN" });
  return result.stopped === true ? null : "UNCERTAIN module shutdown: settlement retains custody and waits for a fresh OFF observation.";
}
