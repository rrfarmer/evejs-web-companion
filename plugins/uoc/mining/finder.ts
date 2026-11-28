import type { MacroDecider, MacroTick } from "../../../web/src/plugin-api/index.ts";

/** Publish search criteria for the host; never treat a failed search as an eligible agent. */
export const findMiningAgent: MacroDecider = (step, obs, _mem, board) => {
  const tick = (why: string, outcome: MacroTick["outcome"]): MacroTick => ({
    action: { kind: "wait" },
    why,
    phase: "Finding an agent",
    armed: false,
    outcome,
    nextMem: {},
  });
  const level = step.args.level,
    fallback = step.args.fallback,
    corp = step.args.corporation,
    jumps = step.args.maxJumps;
  if (
    (level &&
      (level.kind !== "count" ||
        !Number.isSafeInteger(level.value) ||
        level.value < 1 ||
        level.value > 4)) ||
    (fallback && (fallback.kind !== "toggle" || typeof fallback.enabled !== "boolean")) ||
    (corp &&
      (corp.kind !== "corp" ||
        !Number.isSafeInteger(corp.id) ||
        corp.id === null ||
        corp.id <= 0)) ||
    (jumps &&
      (jumps.kind !== "count" ||
        !Number.isSafeInteger(jumps.value) ||
        jumps.value < 1 ||
        jumps.value > 30))
  )
    return tick("Mining agent configuration is invalid.", {
      kind: "blocked",
      reason: "Choose a valid corporation and agent travel limit.",
    });
  if (typeof board.agentID === "number")
    return tick("An agent is already picked for this run.", { kind: "done" });
  const found = obs.foundAgent;
  if (found)
    return {
      ...tick("Found a Mining agent to work with.", { kind: "done" }),
      boardPatch: {
        agentID: found.agentID,
        agentStationID: found.stationID,
        agentName: found.name,
        agentStationName: found.stationName,
        ...(found.level === undefined ? {} : { agentLevel: found.level }),
      },
    };
  if (obs.agentSearchFailure)
    return tick(obs.agentSearchFailure, { kind: "blocked", reason: obs.agentSearchFailure });
  return {
    ...tick("Searching for a Mining agent.", { kind: "acting" }),
    boardPatch: {
      findKind: "mining",
      findLevel: level?.kind === "count" ? level.value : 1,
      findFallback: fallback?.kind === "toggle" && fallback.enabled ? 1 : 0,
      findMaxJumps: jumps?.kind === "count" ? jumps.value : null,
      findCorpID: corp?.kind === "corp" ? corp.id : null,
    },
  };
};
