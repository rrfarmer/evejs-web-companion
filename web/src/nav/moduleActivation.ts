// Whether a fitted module is something a pilot switches on: the one test every
// list of modules the companion activates is gated by.
//
// ⚠ THE GROUP SAYS WHAT A MODULE IS FOR, NEVER WHETHER IT CAN BE SWITCHED ON.
// Seen live 2026-10-14: companions picked a "Drone Navigation Computer I" by its
// group name and tried it once a fight; the server refused every time ("Drone
// Navigation Computer I cannot be activated.", NO_ACTIVATABLE_EFFECT). On this
// server that type has medPower, online and a category-4 bonus effect, and
// nothing a pilot switches on. Dropping that group from a pattern would fix one
// module; the rule is that a passive module is never tried, whatever its group.
//
// ⚠ THE SERVER'S OWN TEST, NOT A LOOKALIKE. eve.js activates a module by its
// type's first activatable effect (server/src/space/runtime/
// moduleActivationEffectRecord.js, resolveDefaultActivationEffect and
// isActivatableEffectRecord: an activation, target or area effect that is not
// `online` or a slot effect, or one naming both a duration and a discharge).
// The BFF answers that same test per type from the same static tables
// (staticData.getTypeActivatable, GET /api/types/activation). A duration
// attribute is NOT the same answer: an Abyssal module's TYPE has no duration
// (its item does), and a Mining Foreman Link's type has one and no effect the
// server would take. So the type's answer comes first, and the live item's
// cycle (bridge/boundDogma.ts itemHasActivationCycle) only stands in for it when
// the type's answer has not been read.
//
// ⚠ UNKNOWN NEVER EXCLUDES. Neither read in yet is "cannot say", and a fight is
// not blocked on an unread read: cycling a passive module wastes one call,
// refusing to cycle a real one loses the tank or the guns. What the server
// refuses anyway is caught by `isNotActivatableRefusal` and never asked again
// for the rest of the run (nav/fleetCompanionLoop.ts).

export type ModuleActivation = "activatable" | "passive" | "unknown";

export interface ModuleActivationFacts {
  /** The server's test over the type's effects (GET /api/types/activation); null or absent when not known. */
  readonly typeActivatable: boolean | null | undefined;
  /** The fitted item's own duration or rate of fire, from live dogma; null when not read. */
  readonly itemCycles: boolean | null;
}

export function moduleActivation(facts: ModuleActivationFacts): ModuleActivation {
  if (facts.typeActivatable === true) return "activatable";
  if (facts.typeActivatable === false) return "passive";
  if (facts.itemCycles === true) return "activatable";
  if (facts.itemCycles === false) return "passive";
  return "unknown";
}

/**
 * The server's refusal of a module that cannot be switched on at all:
 * `"<module name> cannot be activated."` (NO_ACTIVATABLE_EFFECT,
 * UNSUPPORTED_EFFECT and UNSUPPORTED_MODULE in dogmaService/moduleOperation.js).
 *
 * ⚠ ANCHORED AT THE END ON PURPOSE. The same server says "That module cannot be
 * activated while you are warp scrambled." and "... in the current security
 * band." -- refusals of the moment, not of the module, which must stay
 * retryable. Only the sentence that ends there names a module that never will.
 */
export function isNotActivatableRefusal(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "CALL_REFUSED") {
    return false;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /\bcannot be activated\.?\s*$/i.test(message);
}
