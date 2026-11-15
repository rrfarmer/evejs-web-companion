// The corporations an agent finder step can be limited to.
//
// The finder steps filter agents by corporation ID (`findCorpID` on the run's
// board), so the step has to hold an ID, and the only honest way to get one is
// to offer the corporations that actually employ agents of that kind. Typing a
// name gave the step no ID at all, and every typed name failed the step's check.

import * as api from "../app/api.ts";
import type { ApiOptions } from "../app/api.ts";
import { nameKey } from "../store/names.ts";

/** One corporation the finder can be limited to. */
export interface AgentCorporation {
  readonly id: number;
  readonly name: string;
}

/**
 * Every corporation that employs at least one of `agents`, named from
 * `nameOf`, in name order. A corporation whose name has not resolved is still
 * offered, under a plain placeholder, because its agents are still real.
 */
export function agentCorporations(
  agents: readonly { readonly corporationID: number | null }[],
  nameOf: (corporationID: number) => string | null,
): AgentCorporation[] {
  const ids = new Set<number>();
  for (const agent of agents) {
    if (agent.corporationID !== null && Number.isSafeInteger(agent.corporationID) && agent.corporationID > 0) {
      ids.add(agent.corporationID);
    }
  }
  return [...ids]
    .map((id) => ({ id, name: nameOf(id) ?? `Corporation ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** What the picker shows: the corporations, or why there are none to show. */
export interface AgentCorporationsResult {
  readonly corporations: readonly AgentCorporation[];
  readonly error: string | null;
}

/**
 * Read the corporations that employ agents of one kind ("courier" for the
 * delivery finder, "encounter" for the combat finder). Static reference data,
 * so an account sign-in reads it as well as a pilot's session. One read per
 * level, as the delivery finder itself reads them, so no level is cut short by
 * the server's per-request cap. A failed read is an `error`, never an empty list
 * that would read as "no corporation has such agents".
 */
export async function readAgentCorporations(
  kind: "courier" | "encounter",
  options: ApiOptions,
): Promise<AgentCorporationsResult> {
  try {
    const levels = kind === "courier" ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
    const found = await Promise.all(levels.map((level) => api.findAgents({ kind, level, limit: 5000 }, options)));
    const agents = found.flatMap((result) => result.agents);
    const ids = agentCorporations(agents, () => null).map((corporation) => corporation.id);
    const names = ids.length === 0
      ? {}
      : (await api.resolveNames(ids.map((id) => ({ kind: "corporation" as const, id })), options)).names;
    return { corporations: agentCorporations(agents, (id) => names[nameKey("corporation", id)] ?? null), error: null };
  } catch (error) {
    return { corporations: [], error: error instanceof Error ? error.message : String(error) };
  }
}
