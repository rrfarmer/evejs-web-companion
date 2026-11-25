import type { IndustrialCoreRead } from "./industrialObservation.ts";
export type CoreServiceDecision = {
  readonly state:
    "ACTIVE" | "ACTIVATE" | "INACTIVE" | "DEGRADED" | "REQUIRED_UNAVAILABLE" | "WAIT" | "SETTLE";
  readonly reason: string | null;
};
/** Interpret the native Core/fuel read only; action and debit receipts remain with industrialCore. */
export function decideCoreService(
  config: { enabled: boolean; requirement: "continueWithoutCore" | "requireCore" },
  read: IndustrialCoreRead,
): CoreServiceDecision {
  if (
    typeof config.enabled !== "boolean" ||
    !["continueWithoutCore", "requireCore"].includes(config.requirement) ||
    (config.requirement === "requireCore" && !config.enabled)
  )
    throw Error("Core policy is invalid.");
  if (read.availability !== "available")
    return { state: "WAIT", reason: "Core effect is unreadable." };
  if (!config.enabled)
    return read.core.active
      ? { state: "SETTLE", reason: "Core must settle before dependent movement." }
      : { state: "INACTIVE", reason: null };
  if (read.core.active) return { state: "ACTIVE", reason: null };
  if (read.fuel.availability !== "available")
    return { state: "WAIT", reason: "Native fuel read is unavailable." };
  const fuel = read.fuel;
  if (
    !Number.isSafeInteger(fuel.requiredQuantity) ||
    fuel.requiredQuantity <= 0 ||
    !Number.isSafeInteger(fuel.availableQuantity) ||
    fuel.availableQuantity < 0 ||
    typeof fuel.sufficient !== "boolean" ||
    fuel.sufficient !== fuel.availableQuantity >= fuel.requiredQuantity
  )
    return { state: "WAIT", reason: "Native fuel read is inconsistent." };
  if (!fuel.sufficient)
    return {
      state: config.requirement === "requireCore" ? "REQUIRED_UNAVAILABLE" : "DEGRADED",
      reason: "Native fuel is insufficient for another Core cycle.",
    };
  return { state: "ACTIVATE", reason: null };
}
