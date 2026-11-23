import {decodeParkingPolicy,type ParkingPolicy} from "../shared/parkingPolicy.ts";
import {readContinuation, type MissionContinuation} from "../civilian/acceptedMission.ts";
import type { BotScript } from '../../../web/src/plugin-api/index.ts';
type Agent = { readonly mode: "manual"; readonly agentID: number } |
  { readonly mode: "auto"; readonly levelRule: "exact" | "max"; readonly level: number; readonly corporationID: number | null; readonly maxJumps: number };
export interface CivilianMiningSetup { readonly agent: Agent; readonly missionCount: number; readonly parking?:ParkingPolicy; readonly durationMinutes?:number; readonly continuation?:MissionContinuation }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Untrusted setup is decoded once and returned in a stable, canonical order. */
export function decodeCivilianMiningSetup(value: unknown): CivilianMiningSetup | null {
  if (!record(value) || !Object.keys(value).every(k=>["agent","missionCount","parking","durationMinutes","continuation"].includes(k)) || !Object.hasOwn(value,"agent") || !Object.hasOwn(value,"missionCount") || (!positive(value.missionCount) || value.missionCount > 500) || !record(value.agent)) return null;
  const parking=decodeParkingPolicy(value.parking);if(!parking || (value.durationMinutes!==undefined && (!positive(value.durationMinutes)||value.durationMinutes>4320)))return null;
  const continuation=value.continuation===undefined?undefined:readContinuation(value.continuation);
  if(continuation===null||continuation&&(value.missionCount!==1||value.durationMinutes!==undefined))return null;
  const extras={...(value.parking===undefined?{}:{parking}),...(value.durationMinutes===undefined?{}:{durationMinutes:value.durationMinutes as number}),...(continuation?{continuation}:{})};
  const a = value.agent;
  if (a.mode === "manual" && keys(a, ["mode", "agentID"]) && positive(a.agentID))
    return { agent: { mode: "manual", agentID: a.agentID }, missionCount: value.missionCount, ...extras };
  if (a.mode === "auto" && keys(a, ["mode", "levelRule", "level", "corporationID", "maxJumps"]) &&
      (a.levelRule === "exact" || a.levelRule === "max") && positive(a.level) && a.level <= 4 &&
      (a.corporationID === null || positive(a.corporationID)) && positive(a.maxJumps) && a.maxJumps <= 30)
    return { agent: { mode: "auto", levelRule: a.levelRule, level: a.level, corporationID: a.corporationID, maxJumps: a.maxJumps }, missionCount: value.missionCount, ...extras };
  return null;
}

export function civilianMiningPlan(setup: CivilianMiningSetup): BotScript {
  const agent = setup.agent;
  const find = agent.mode === "auto" ? [{ id: "find-agent", kind: "macro" as const, macro: "uoc:find-mining-agent" as const,
    args: { level: { kind: "count" as const, value: agent.level }, fallback: { kind: "toggle" as const, enabled: agent.levelRule === "max" },
      maxJumps: { kind: "count" as const, value: agent.maxJumps },
      ...(agent.corporationID === null ? {} : { corporation: { kind: "corp" as const, id: agent.corporationID, name: null } }) } }] : [];
  return { format: "evejs-bot-script", version: 1, name: "Civilian mining", notes: "One mining mission.",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true }, interrupts: [],
    program: [...find, { id: "mine-mission", kind: "macro", macro: "uoc:mine-mission", args: agent.mode === "manual"
      ? { agent: { kind: "agent", ref: { entity: "agent", id: agent.agentID, name: null, systemName: null } } } : {} }] };
}
