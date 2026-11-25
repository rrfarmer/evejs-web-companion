// WC74 web/src/app/miningSetup.ts @ 213da333; imports adapted for UOC plugin.
import type { MiningPreparationOptions } from "./miningPreparation.ts";
import { isPlayerCorporation } from "../../../../web/src/plugin-api/index.ts";

export function miningUnloadPolicy(members: readonly { role: string }[]) {
  return members.some((member) => member.role === "HAULER")
    ? ("HAULER_SERVICE" as const)
    : ("SELF_UNLOAD" as const);
}

/** A fitting provider's corporation does not identify a different fleet member's corporation. */
export function memberCorporationID(
  characterID: number,
  providerID: number,
  options?: MiningPreparationOptions,
): number | null {
  if (options?.pilot.characterID !== characterID) return null;
  const id =
    options?.pilot.corporationID ??
    (!providerID || providerID === characterID ? options?.definitions.corporationID : null);
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null;
}

/** A shared corporate destination is available only when every participating pilot is verified in the same player corporation. */
export function sharedPlayerCorporation(corporations: readonly (number | null)[]): number | null {
  if (!corporations.length || corporations.some((id) => !isPlayerCorporation(id))) return null;
  const [first] = corporations;
  return first !== null && first !== undefined && corporations.every((id) => id === first)
    ? first
    : null;
}

/** Keep a saved identity pinned. Empty new selections can use the verified fleet corporation. */
export function resolveFleetCorporation(saved: number, verified: number | null): number {
  if (verified === null)
    throw new Error("Verify that the participating pilots belong to the same player corporation.");
  if (saved !== 0 && saved !== verified)
    throw new Error(
      "The saved corporation differs from the pilots' verified corporation. Choose the verified corporation before saving.",
    );
  return verified;
}
