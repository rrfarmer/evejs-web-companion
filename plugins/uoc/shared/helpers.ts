// Pure helper copies: WC75 web/src/bridge/agents.ts, nav/missionBotLoop.ts,
// nav/miningSite.ts, nav/missionCompletion.ts and bridge/dungeonTracking.ts.
import type { AgentConversation, CurrentDungeon, JournalState, ModuleReach, SpaceSnapshot } from "./types.ts";
export const AGENT_BUTTON = Object.freeze({ VIEW_MISSION: 1, REQUEST_MISSION: 2, ACCEPT: 3, ACCEPT_CHOICE: 4, ACCEPT_REMOTELY: 5, COMPLETE: 6, COMPLETE_REMOTELY: 7, CONTINUE: 8, DECLINE: 9, DEFER: 10, QUIT: 11, START_RESEARCH: 12, CANCEL_RESEARCH: 13, BUY_DATACORES: 14, LOCATE_CHARACTER: 15, LOCATE_ACCEPT: 16, LOCATE_REJECT: 17, YES: 18, NO: 19 });
export function agentActionID(conversation: AgentConversation | null, buttonType: number): number | null { return conversation?.actions.find(action => action.buttonType === buttonType)?.actionID ?? null; }
export function iceMiningType(attributes: Readonly<Record<number, number>> | undefined): boolean { return !!attributes && (attributes[77] ?? 0) > 0 && [182, 183, 184, 1285, 1289, 1290].some(id => attributes[id] === 16281); }
export function acceptedMissionKey(journal: JournalState | null | undefined, agentID: number): string | null { const rows = journal?.active.filter(row => row.agentID === agentID) ?? []; const row = rows.length === 1 ? rows[0] : null; return row && Number.isSafeInteger(row.missionID) && row.missionID! > 0 ? JSON.stringify([agentID, row.missionID, row.missionTitleID, row.expirationTime]) : null; }
const whole = (value: unknown): number | null => { const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : null; };
export function dungeonEntered(args: readonly unknown[]): CurrentDungeon | null { const dungeonID = whole(args[0]); return dungeonID === null ? null : { dungeonID, roomID: args[1] === 0 || args[1] === "0" ? 0 : whole(args[1]), instanceID: whole(args[3]) }; }
/** Fresh same-scene identity only. Absent stock projection is unknown, not a range. */
export function readObservedModuleReach(scene: SpaceSnapshot | null, moduleID: number, typeID: number): ModuleReach | null {
 const observation = scene?.ship?.moduleReach;
 if (!scene?.inSpace || scene.shipID === null || scene.ship?.itemID !== scene.shipID || observation?.availability !== "available" || observation.shipID !== scene.shipID || scene.sampledAtMs === null || observation.sampledAtSimTimeMs !== scene.sampledAtMs) return null;
 return observation.modules?.find(row => row.moduleID === moduleID && row.typeID === typeID && row.availability === "available") ?? null;
}
