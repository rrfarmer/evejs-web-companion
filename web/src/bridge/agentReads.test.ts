// The table of agents, read by the page itself: the call as the client makes it, the table read off its header
// and lines, a station's agents picked from it, and an answer that is no table told from a table of nobody.

import test from "node:test";
import assert from "node:assert/strict";

import { agentsAtStation, readAgentsTable } from "./agentReads.ts";
import type { JsonValue } from "./wire.ts";

// The form both transports printed for this server (2026-10-11): a Rowset, its header a list of names and its
// lines a list of lists. Numbers made up.
const HEADER = ["agentID", "agentTypeID", "divisionID", "level", "stationID", "corporationID", "isLocatorAgent", "isInSpace", "careerID", "importantMission", "missionKind", "missionTypeLabel", "specialityID", "stationTypeID", "bloodlineID"];
const line = (...items: unknown[]) => ({ type: "list", items });
const rowset = (header: unknown, lines: unknown): JsonValue => ({
  type: "object", name: "eve.common.script.sys.rowset.Rowset",
  args: { type: "dict", entries: [["header", header], ["RowClass", { type: "token", value: "carbon.common.script.sys.row.Row" }], ["lines", lines]] },
}) as unknown as JsonValue;
const table = (...lines: unknown[]): JsonValue => rowset({ type: "list", items: HEADER }, { type: "list", items: lines });
const AT_A = line(3000001, 2, 22, 1, 60000001, 1000002, false, false, 14, false, "courier", "UI/Agents/MissionTypes/Courier", 15, 1531, 1);
const AT_B = line(3000002, 2, 24, 4, 60000002, 1000003, true, false, 14, false, "encounter", "UI/Agents/MissionTypes/Encounter", 15, 1531, 1);
const IN_SPACE = line(3000003, 6, 0, 0, null, 0, false, true, 14, false, "", null, 15, 0, 1);

function asker(answer: JsonValue | Error | undefined) {
  const asked: unknown[] = [];
  const ask = async (service: string, method: string, args: readonly JsonValue[], kwargs?: unknown, of?: unknown) => {
    asked.push([service, method, args, kwargs ?? null, of ?? null]);
    if (answer instanceof Error) throw answer;
    return answer as JsonValue;
  };
  return { ask, asked };
}

test("the table of agents is asked for by name with nothing, and each line read by the header's names", async () => {
  const one = asker(table(AT_A, AT_B, IN_SPACE));
  const read = await readAgentsTable(one.ask);
  // agents.py 92: agents = sm.RemoteSvc('agentMgr').GetAgents().Clone().
  assert.deepEqual(one.asked, [["agentMgr", "GetAgents", [], null, null]]);
  assert.deepEqual(read, [
    // Its bloodline where the table gives one (characterInfoWindow 190: its Show Info's Description is the bloodline's).
    { agentID: 3000001, agentTypeID: 2, divisionID: 22, level: 1, stationID: 60000001, corporationID: 1000002, missionKind: "courier", missionTypeLabel: "UI/Agents/MissionTypes/Courier", bloodlineID: 1 },
    // And a locator agent's isLocatorAgent (the Agency's Locator Agents page goes by it).
    { agentID: 3000002, agentTypeID: 2, divisionID: 24, level: 4, stationID: 60000002, corporationID: 1000003, missionKind: "encounter", missionTypeLabel: "UI/Agents/MissionTypes/Encounter", bloodlineID: 1, isLocatorAgent: true },
    // An agent in space: no station, and nothing where the table has nought or nothing.
    { agentID: 3000003, agentTypeID: 6, divisionID: null, level: null, stationID: null, corporationID: null, missionKind: null, missionTypeLabel: null, bloodlineID: 1 },
  ]);
  // A table of no lines is a table: nobody is an agent.
  assert.deepEqual(await readAgentsTable(asker(table()).ask), []);
});

test("a line is read by where the header puts each name, and a line that names no agent is no agent", async () => {
  // Another order, and fewer fields: what the header does not name is not known of an agent.
  const short = rowset({ type: "list", items: ["stationID", "agentID", "level"] }, { type: "list", items: [line(60000001, 3000001, 3), line(60000001, 0, 2), line(60000001, null, 2), line(), "junk", null] });
  assert.deepEqual(await readAgentsTable(asker(short).ask), [
    { agentID: 3000001, agentTypeID: null, divisionID: null, level: 3, stationID: 60000001, corporationID: null, missionKind: null, missionTypeLabel: null },
  ]);
});

test("an answer that is no table of agents is the agents unread, not a table of nobody", async () => {
  const answers: Array<[string, unknown]> = [
    ["nothing", null], ["nothing at all", undefined], ["a list", { type: "list", items: [] }], ["a number", 0], ["an array", [AT_A]],
    ["a rowset with no header", rowset(undefined, { type: "list", items: [AT_A] })],
    ["a rowset with no lines", rowset({ type: "list", items: HEADER }, undefined)],
    ["a header that names no agent", rowset({ type: "list", items: ["stationID", "level"] }, { type: "list", items: [] })],
    ["lines that are no list", rowset({ type: "list", items: HEADER }, { type: "dict", entries: [] })],
    ["an object with no fields", { type: "object", name: "eve.common.script.sys.rowset.Rowset" }],
  ];
  for (const [what, answer] of answers) {
    await assert.rejects(readAgentsTable(asker(answer as JsonValue | undefined).ask), /^Error: The agents could not be read \(the server did not answer with their table\)\.$/, what);
  }
});

test("a read that failed fails as the call failed: the caller has the call's own reason", async () => {
  const refused = Object.assign(new Error("CALL_FAILED"), { code: "CALL_FAILED" });
  await assert.rejects(readAgentsTable(asker(refused).ask), (error) => error === refused);
});

test("a station's agents are those the table has at that station; at no station there are none", async () => {
  const read = await readAgentsTable(asker(table(AT_A, AT_B, IN_SPACE, line(3000004, 2, 22, 2, 60000001, 1000002, false, false, 14, false, "courier", "x", 15, 1531, 1))).ask);
  // dockedUI/agents.py 153: sm.GetService('agents').GetAgentsByStationID()[session.stationid].
  assert.deepEqual(agentsAtStation(read, 60000001).map((agent) => agent.agentID), [3000001, 3000004]);
  assert.deepEqual(agentsAtStation(read, 60000002).map((agent) => agent.agentID), [3000002]);
  assert.deepEqual(agentsAtStation(read, 60000009), []);
  // No station is not "the agents of nowhere": the ones in space are not listed for a pilot the page has at none.
  for (const none of [null, 0, -1, Number.NaN]) assert.deepEqual(agentsAtStation(read, none as number | null), [], String(none));
});
