import type { ApiOptions } from "../../web/src/plugin-api/index.ts";
import type { FindAgentsResult, FoundAgent } from "./shared/types.ts";

export type CivilianMissionType = "mining" | "distribution";

interface AgentFilters {
  readonly level: number;
  readonly levelRule: "exact" | "max";
  readonly corporationID: number | null;
  readonly query: string;
}

export async function loadCivilianAgents(
  type: CivilianMissionType,
  options: ApiOptions,
): Promise<FindAgentsResult> {
  const kind = type === "mining" ? "mining" : "courier";
  const response = await (options.fetch ?? globalThis.fetch)(
    `${options.baseUrl ?? ""}/api/agents/find?kind=${kind}&limit=5000`,
    {
      method: "GET",
      signal: options.signal,
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
      credentials: options.token ? "omit" : "same-origin",
    },
  );
  const body = await response.json();
  if (
    !response.ok ||
    body.ok === false ||
    !Array.isArray(body.agents) ||
    !Number.isSafeInteger(body.total) ||
    typeof body.capped !== "boolean"
  )
    throw new Error("The native agent directory is unreadable.");
  const missing = [
    ...new Set<number>(
      (body.agents as FoundAgent[]).flatMap((agent) =>
        Number.isSafeInteger(agent.corporationID) &&
        agent.corporationID! > 0 &&
        !agent.corporationName
          ? [agent.corporationID!]
          : [],
      ),
    ),
  ];
  const names = new Map<number, string>();
  for (let offset = 0; offset < missing.length; offset += 100) {
    const ids = missing.slice(offset, offset + 100);
    const named = await (options.fetch ?? globalThis.fetch)(`${options.baseUrl ?? ""}/api/names`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      credentials: options.token ? "omit" : "same-origin",
      body: JSON.stringify({ items: ids.map((id) => ({ kind: "owner", id })) }),
    });
    const result = await named.json();
    if (
      !named.ok ||
      result.ok !== true ||
      result.capped === true ||
      !result.names ||
      typeof result.names !== "object"
    )
      throw Error("Corporation names could not be read. Refresh the agent directory.");
    for (const id of ids) {
      const name = result.names[`owner:${id}`];
      if (typeof name === "string" && name.trim()) names.set(id, name.trim());
    }
  }
  const agents = (body.agents as FoundAgent[]).map((agent) =>
    names.has(agent.corporationID!)
      ? { ...agent, corporationName: names.get(agent.corporationID!)! }
      : agent,
  );
  return { kind, level: body.level ?? null, total: body.total, capped: body.capped, agents };
}

// WC74 Civilian Missions used these directory filters before checking native pilot access.
export function filterCivilianAgents(
  agents: readonly FoundAgent[],
  filters: AgentFilters,
): FoundAgent[] {
  const query = filters.query.trim().toLowerCase();
  return agents.filter(
    (agent) =>
      agent.agentID > 0 &&
      agent.stationID !== null &&
      agent.level !== null &&
      agent.level >= 1 &&
      (filters.levelRule === "exact"
        ? agent.level === filters.level
        : agent.level <= filters.level) &&
      (filters.corporationID === null || agent.corporationID === filters.corporationID) &&
      [agent.name, agent.stationName, agent.solarSystemName].some((name) =>
        name?.toLowerCase().includes(query),
      ),
  );
}
