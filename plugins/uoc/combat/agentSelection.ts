/** Select a Security agent using a complete held-pilot finder and native access checks. */
export async function selectSecurityAgent<
  T extends {
    agentID: number;
    level: number | null;
    missionKind: string | null;
    stationID: number | null;
    solarSystemID: number | null;
    corporationID: number | null;
    jumps: number | null;
  },
>(
  found: { loaded: boolean; error: unknown; capped: boolean; total: number; agents: readonly T[] },
  policy: {
    maxJumps: number | null;
    corporationID: number | null;
    systemID?: number;
    currentStationID?: number;
    level?: 1 | 2;
    levelRule?: "EXACT" | "UP_TO";
  },
  probe: (candidate: T) => Promise<boolean>,
): Promise<T> {
  if (!found.loaded || found.error || found.capped || found.total !== found.agents.length)
    throw Error("Security agent discovery is incomplete.");
  const level = policy.level ?? 1,
    rule = policy.levelRule ?? "EXACT";
  const candidates = found.agents
    .filter(
      (c) =>
        typeof c.level === "number" &&
        (c.level === 1 || c.level === 2) &&
        (rule === "UP_TO" ? c.level <= level : c.level === level) &&
        c.missionKind === "encounter" &&
        Number.isSafeInteger(c.agentID) &&
        c.agentID > 0 &&
        Number.isSafeInteger(c.stationID) &&
        c.stationID! > 0 &&
        Number.isSafeInteger(c.solarSystemID) &&
        c.solarSystemID! > 0 &&
        typeof c.jumps === "number" &&
        Number.isSafeInteger(c.jumps) &&
        c.jumps >= 0 &&
        (policy.maxJumps === null || c.jumps <= policy.maxJumps) &&
        (!policy.systemID || c.solarSystemID === policy.systemID) &&
        (policy.corporationID === null || c.corporationID === policy.corporationID),
    )
    .sort(
      (a, b) =>
        a.jumps! - b.jumps! ||
        b.level! - a.level! ||
        Number(b.stationID === policy.currentStationID) -
          Number(a.stationID === policy.currentStationID) ||
        a.agentID - b.agentID,
    );
  for (const candidate of candidates) if (await probe(candidate)) return candidate;
  throw Error("No accessible Security agent matches the requested level and search.");
}
