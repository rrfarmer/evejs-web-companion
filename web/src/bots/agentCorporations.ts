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

/** What the picker shows: the corporations, or why there are none to show. */
export interface AgentCorporationsResult {
  readonly corporations: readonly AgentCorporation[];
  readonly error: string | null;
}

/** The agents a finder step looks for: delivery ("courier") or combat ("encounter"). */
export type AgentFinderKind = "courier" | "encounter";

/** Every distinct corporation ID among `agents`. */
export function agentCorporationIDs(agents: readonly { readonly corporationID: number | null }[]): number[] {
  const ids = new Set<number>();
  for (const agent of agents) {
    if (agent.corporationID !== null && Number.isSafeInteger(agent.corporationID) && agent.corporationID > 0) {
      ids.add(agent.corporationID);
    }
  }
  return [...ids];
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
  return agentCorporationIDs(agents)
    .map((id) => ({ id, name: nameOf(id) ?? `Corporation ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/**
 * Read the corporations that employ agents of one kind. Static reference data,
 * so an account sign-in reads it as well as a pilot's session. One read per
 * level, as the delivery finder itself reads them, so no level is cut short by
 * the server's per-request cap. A failed read throws: the caller words it, and
 * it is never an empty list that would read as "no corporation has such agents".
 */
export async function readAgentCorporations(
  kind: AgentFinderKind,
  options: ApiOptions,
): Promise<AgentCorporation[]> {
  const levels = kind === "courier" ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
  const found = await Promise.all(levels.map((level) => api.findAgents({ kind, level, limit: 5000 }, options)));
  const agents = found.flatMap((result) => result.agents);
  const ids = agentCorporationIDs(agents);
  const names = ids.length === 0
    ? {}
    : (await api.resolveNames(ids.map((id) => ({ kind: "corporation" as const, id })), options)).names;
  return agentCorporations(agents, (id) => names[nameKey("corporation", id)] ?? null);
}

/**
 * A reader that keeps each kind's answer once it has one. The agent table does
 * not change while the BFF runs, and the picker mounts every time a finder step
 * is selected, so without this every click re-read a few thousand agent rows.
 * A failed read is not kept, so the next mount asks again.
 */
export function createAgentCorporationsReader(
  read: (kind: AgentFinderKind) => Promise<AgentCorporation[]>,
): (kind: AgentFinderKind) => Promise<AgentCorporation[]> {
  const answers = new Map<AgentFinderKind, Promise<AgentCorporation[]>>();
  return (kind) => {
    const held = answers.get(kind);
    if (held !== undefined) return held;
    const answer = read(kind);
    answers.set(kind, answer);
    answer.catch(() => answers.delete(kind));
    return answer;
  };
}
