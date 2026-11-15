import type { DogmaTypeFacts } from "./location.ts";

/** dogma.ammoloadingUtils.can_load_charge_into_module in 24.02. */
export function academyChargeAllowed(charge: DogmaTypeFacts | null | undefined, module: DogmaTypeFacts | null | undefined): boolean {
  return charge?.academy !== true || module?.academy === true;
}

/** Info._IsUsedWithCandidate includes Academy types even when unpublished. */
export function usedWithCandidate(type: DogmaTypeFacts | null | undefined): type is DogmaTypeFacts {
  return type != null && (type.published !== false || type.academy === true);
}
