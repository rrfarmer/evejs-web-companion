/** Hosted grant includes the cleanup margin where the BFF policy permits it. */
export function securityTimePolicy(requestedMinutes: number, maxRuntimeMinutes: number) {
  if (
    !Number.isSafeInteger(requestedMinutes) ||
    requestedMinutes < 1 ||
    !Number.isSafeInteger(maxRuntimeMinutes) ||
    requestedMinutes > maxRuntimeMinutes
  )
    throw Error("The selected runtime exceeds the current hosted policy.");
  const grantMinutes = Math.min(requestedMinutes + 3, maxRuntimeMinutes);
  if (grantMinutes < 4)
    throw Error("Security hosting requires at least four minutes including cleanup.");
  return {
    requestedMinutes,
    grantMinutes,
    workBoundaryMinutes: Math.min(requestedMinutes, grantMinutes - 3),
    cleanupReserveMinutes: 3,
  };
}

/** Optional leases never shorten the healthy required fleet's work boundary. */
export function combatWorkDeadline(
  members: readonly { characterID: number; required?: boolean }[],
  expiry: (id: number) => number,
) {
  const required = members.filter((m) => m.required !== false),
    basis = required.length ? required : members;
  if (!basis.length) throw Error("Combat runtime roster is empty.");
  return Math.min(...basis.map((m) => expiry(m.characterID))) - 180000;
}
