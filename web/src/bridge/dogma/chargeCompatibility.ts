import type { DogmaTypeFacts } from "./location.ts";

/** dogma.ammoloadingUtils.can_load_charge_into_module in 24.02. */
export function academyChargeAllowed(charge: DogmaTypeFacts | null | undefined, module: DogmaTypeFacts | null | undefined): boolean {
  return charge?.academy !== true || module?.academy === true;
}

/** Info._IsUsedWithCandidate includes Academy types even when unpublished. */
export function usedWithCandidate(type: DogmaTypeFacts | null | undefined): type is DogmaTypeFacts {
  return type != null && (type.published === true || type.academy === true);
}

const USED_WITH_CHARGE_ATTRIBUTES = new Set([604, 605, 606, 609]);

/** Infosvc._AddUsedWithTypeIDs uses chargeGroup1 through chargeGroup4. */
export function usedWithChargeGroups(type: DogmaTypeFacts | null | undefined): number[] {
  return (type?.attributes ?? []).flatMap(([id, value]) =>
    USED_WITH_CHARGE_ATTRIBUTES.has(id) && value !== null && value > 0 ? [Math.trunc(value)] : []);
}

export function usedWithPair(module: DogmaTypeFacts | null | undefined, charge: DogmaTypeFacts | null | undefined): boolean {
  if (!usedWithCandidate(module) || !usedWithCandidate(charge) || !academyChargeAllowed(charge, module)) return false;
  if (charge.groupID === null || !usedWithChargeGroups(module).includes(charge.groupID)) return false;
  const capacity = module.attributes.find(([id]) => id === 38)?.[1] ?? null;
  const volume = charge.attributes.find(([id]) => id === 161)?.[1] ?? 0;
  if (capacity !== null && volume > capacity) return false;
  const size = module.attributes.find(([id]) => id === 128)?.[1];
  return !size || size === charge.attributes.find(([id]) => id === 128)?.[1];
}
