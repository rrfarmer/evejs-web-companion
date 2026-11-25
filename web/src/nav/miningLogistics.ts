import type { MiningHold } from "../store/types.ts";

/** A failed contents read is never evidence that a final load is ashore. */
export function freightReadable(holds: readonly MiningHold[] | null | undefined): holds is readonly (MiningHold & { items: NonNullable<MiningHold["items"]> })[] {
  return holds != null && holds.every(hold => hold.error == null && hold.items != null);
}
