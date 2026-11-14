// The table of agents, read by whoever wants it (the plan's Phase 6b).
//
// Until 2026-10-11 the page asked one route of the BFF (GET /api/bridge/agents), which read the pilot's flight,
// asked the server for the whole table, and handed on the agents at the station the BFF had the pilot at.
//
// THE CALL, as the client makes it (agents.__GetAllAgents, 89 to 115):
//
//   agents = sm.RemoteSvc('agentMgr').GetAgents().Clone()
//
// of the agent manager by its name, nothing sent. Recorded on Tranquility so, in two logins. It answers the whole
// table: a Rowset of a header and some eleven thousand lines, an agent each (its type, division, level, station,
// corporation, and what missions it gives). Nothing in it is the pilot's own.
//
// TRANQUILITY'S TABLE (its MachoNet cache of the call) has nine fields: agentID, agentTypeID, divisionID, level,
// stationID, bloodlineID, corporationID, gender and isLocatorAgent; its corporationID is None for an agent at a station
// of its own corporation's, which the client fills from the station's owner (agents.py 98). EveJS's has fifteen.
//
// WHAT IS KEPT. The client asks once for the life of its agents service and keeps the table, with indexes by
// station, system, corporation and so on. Whoever asks here keeps it likewise (the flow does): the table is a
// megabyte and a half as it comes, and the game port's transport keeps it too.
//
// A STATION'S AGENTS are picked from the table by the client itself: GetAgentsByStationID()[session.stationid]
// (dockedUI/agents.py 153). So here, by the station the page has its pilot docked at. At no station there are
// none: the agents in space are at no station either, and are nobody's station's.
//
// AN ANSWER THAT IS NO TABLE IS NOT "A TABLE OF NOBODY". The read fails as the call fails, and says so where the
// answer has no header that names an agent, or no lines.
//
// THE ROUTE STILL STANDS (src/server.js). Nothing of the page's asks it now.

import type { AgentRow } from "../store/types.ts";
import type { Ask } from "./ask.ts";
import { isListValue, readDictEntry, type JsonValue } from "./wire.ts";

/** A number above or below nought, or null: the table's nought and nothing are both "none" to the page. */
const numberOrNull = (value: unknown): number | null => Number(value) || null;
/** A text with something in it, or null. */
const textOrNull = (value: unknown): string | null => String(value || "") || null;

/** The table's agents, each line read by where the header puts its names; null where what was answered is no table of agents. */
function decodeAgentsTable(answered: JsonValue | undefined): readonly AgentRow[] | null {
  const fields = (answered as { args?: unknown } | null | undefined)?.args;
  const header = readDictEntry(fields, "header");
  const lines = readDictEntry(fields, "lines");
  if (!isListValue(header) || !isListValue(lines) || !header.items.includes("agentID")) {
    return null;
  }
  const at = (name: string): number => header.items.indexOf(name);
  const where = {
    agentID: at("agentID"), agentTypeID: at("agentTypeID"), divisionID: at("divisionID"), level: at("level"), stationID: at("stationID"),
    corporationID: at("corporationID"), missionKind: at("missionKind"), missionTypeLabel: at("missionTypeLabel"),
    bloodlineID: at("bloodlineID"), isLocatorAgent: at("isLocatorAgent"),
  };
  const agents: AgentRow[] = [];
  for (const line of lines.items) {
    const values: readonly unknown[] = isListValue(line) ? line.items : [];
    // (A field the header does not name is at place -1, where a line has nothing.)
    const agentID = Number(values[where.agentID]) || 0;
    if (agentID <= 0) {
      continue;
    }
    agents.push({
      agentID,
      agentTypeID: numberOrNull(values[where.agentTypeID]),
      divisionID: numberOrNull(values[where.divisionID]),
      level: numberOrNull(values[where.level]),
      stationID: numberOrNull(values[where.stationID]),
      corporationID: numberOrNull(values[where.corporationID]),
      missionKind: textOrNull(values[where.missionKind]),
      missionTypeLabel: textOrNull(values[where.missionTypeLabel]),
      ...(numberOrNull(values[where.bloodlineID]) === null ? {} : { bloodlineID: numberOrNull(values[where.bloodlineID]) as number }),
      ...(where.isLocatorAgent >= 0 && values[where.isLocatorAgent] ? { isLocatorAgent: true } : {}),
    });
  }
  return agents;
}

/**
 * The whole table of agents, as the server lists it. Fails as the call fails; and where the server's answer is no
 * table of agents, which is no list of them at all.
 */
export async function readAgentsTable(ask: Ask): Promise<readonly AgentRow[]> {
  const agents = decodeAgentsTable(await ask("agentMgr", "GetAgents", []));
  if (agents === null) {
    throw new Error("The agents could not be read (the server did not answer with their table).");
  }
  return agents;
}

/** The table's agents at one station, in the table's order. At no station there are none. */
export function agentsAtStation(table: readonly AgentRow[], stationID: number | null): readonly AgentRow[] {
  // (An agent with no station has null for one, and never nought: only null would pick the agents in space.)
  if (stationID === null) {
    return [];
  }
  return table.filter((agent) => agent.stationID === stationID);
}
