export interface AccountPilot {
  readonly characterID: number;
  readonly name: string;
  readonly accountName: string;
}
/** Decode a fresh account-only roster; cached browser identities are not authoritative. */
export function parseAccountRoster(data: unknown, expected: string): AccountPilot[] {
  const r = data as any;
  if (
    !r ||
    r.ok === false ||
    typeof r.account !== "string" ||
    r.account.toLowerCase() !== expected.trim().toLowerCase() ||
    !Array.isArray(r.characters)
  )
    throw new Error("The account roster is unavailable or changed.");
  const seen = new Set<number>();
  return r.characters.map((c: any) => {
    if (
      !Number.isSafeInteger(c?.characterID) ||
      c.characterID <= 0 ||
      typeof c.name !== "string" ||
      !c.name ||
      seen.has(c.characterID)
    )
      throw new Error("The account roster is malformed or contains duplicate pilots.");
    seen.add(c.characterID);
    return { characterID: c.characterID, name: c.name, accountName: r.account };
  });
}
