import type { FindAgentsResult, FoundAgent, AgentConversation } from "../shared/types.ts";
import { AGENT_BUTTON } from "../shared/helpers.ts";

export const MAX_DISTRIBUTION_LEVEL = 4;
export type AgentProbe = "usable" | "ineligible" | "unavailable";

/** DoAction(None) is the game's access verdict; static standings are never guessed here. */
export function classifyDistributionAgentConversation(conversation: AgentConversation): AgentProbe {
  if (/standings are not high enough|too low standings/i.test(conversation.agentSays))
    return "ineligible";
  const meaningful = new Set<number>(Object.values(AGENT_BUTTON));
  return conversation.actions.some(
    (action) =>
      Number.isSafeInteger(action.actionID) &&
      action.actionID > 0 &&
      meaningful.has(action.buttonType),
  )
    ? "usable"
    : "unavailable";
}

export interface DistributionAgentPolicy {
  readonly preferredLevel: number;
  readonly fallback: boolean;
  readonly corporationID: number | null;
  readonly maxJumps: number | null;
  readonly originSystemID: number | null;
  readonly distances: ReadonlyMap<number, number> | null;
}

export interface DistributionAgentSelection {
  readonly agent: FoundAgent | null;
  readonly level: number | null;
  readonly reason: string;
}

/** The Mining finder uses native conversation and route evidence. */
export async function selectMiningAgent(
  policy: Omit<DistributionAgentPolicy, "preferredLevel" | "fallback"> & {
    preferredLevel?: number;
    fallback?: boolean;
  },
  find: (level: number) => Promise<Pick<FindAgentsResult, "agents" | "capped" | "total">>,
  probe: (agentID: number) => Promise<AgentProbe>,
): Promise<DistributionAgentSelection> {
  const preferred = policy.preferredLevel ?? 1;
  const fallback = policy.fallback ?? false;
  if (
    !Number.isSafeInteger(preferred) ||
    preferred < 1 ||
    preferred > 4 ||
    typeof fallback !== "boolean"
  )
    return { agent: null, level: null, reason: "Choose a Mining level from 1 to 4." };
  if (
    !Number.isSafeInteger(policy.originSystemID) ||
    policy.originSystemID === null ||
    policy.originSystemID <= 0 ||
    policy.distances === null
  ) {
    return {
      agent: null,
      level: null,
      reason:
        "The current system or route distances could not be read. Check navigation, then retry.",
    };
  }
  const levels = fallback && preferred > 1 ? `levels 1–${preferred}` : `level ${preferred}`;
  const incomplete: number[] = [],
    unreadable: number[] = [];
  let matched = 0,
    reachable = 0,
    inRange = 0;
  for (let level = preferred; level >= (fallback ? 1 : preferred); level--) {
    const found = await find(level).catch(() => null);
    if (
      !found ||
      !Array.isArray(found.agents) ||
      !Number.isSafeInteger(found.total) ||
      found.total !== found.agents.length ||
      found.capped !== false
    ) {
      incomplete.push(level);
      continue;
    }
    const matches = found.agents.filter(
      (agent) =>
        agent.level === level &&
        agent.divisionID === 23 &&
        agent.agentTypeID === 2 &&
        agent.stationID !== null &&
        agent.solarSystemID !== null &&
        (policy.corporationID === null || agent.corporationID === policy.corporationID),
    );
    matched += matches.length;
    const routes = matches
      .map((agent) => ({
        agent,
        jumps:
          agent.solarSystemID === policy.originSystemID
            ? 0
            : (policy.distances?.get(agent.solarSystemID!) ?? Number.POSITIVE_INFINITY),
      }))
      .filter(({ jumps }) => Number.isFinite(jumps));
    reachable += routes.length;
    const candidates = routes
      .filter(({ jumps }) => policy.maxJumps === null || jumps <= policy.maxJumps)
      .sort((a, b) => a.jumps - b.jumps || a.agent.agentID - b.agent.agentID);
    inRange += candidates.length;
    let accessUnreadable = false;
    for (const { agent } of candidates) {
      let access: AgentProbe = "unavailable";
      try {
        access = await probe(agent.agentID);
      } catch {
        /* Failed reads cannot establish access. */
      }
      if (access === "usable")
        return { agent, level, reason: `Found an eligible level ${level} Mining agent.` };
      if (access !== "ineligible") accessUnreadable = true;
    }
    if (accessUnreadable) unreadable.push(level);
  }
  const reason = incomplete.length
    ? `The Mining agent list was incomplete for level(s) ${incomplete.join(", ")}. Retry the search.`
    : unreadable.length
      ? `Mining agent access could not be confirmed for level(s) ${unreadable.join(", ")}. Check agent access, then retry.`
      : !matched
        ? `No Mining agents match ${levels} and the selected corporation. Change the corporation or level rule.`
        : !reachable
          ? "No route reaches the matching Mining agents. Check the pilot's route settings or choose another corporation."
          : !inRange
            ? `All reachable Mining agents are outside the ${policy.maxJumps}-jump limit. Increase the limit or start closer.`
            : `The game denied agent access for all ${inRange} Mining agent(s) within range. Check standings or choose another corporation or level.`;
  return { agent: null, level: null, reason };
}
