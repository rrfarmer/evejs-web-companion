import type { BotScript } from "../../../../web/src/plugin-api/index.ts";
import type { decodeSpaceSnapshot, decodeFlightStatus } from "../../../../web/src/plugin-api/flying.ts";
import type { FleetRewardPolicy } from "../../combat/rewardPolicy.ts";
export interface CombatOwnerObservation {
 readAtMs:number;refreshSucceeded:boolean;space:ReturnType<typeof decodeSpaceSnapshot>;
 flight:ReturnType<typeof decodeFlightStatus>;eligibleNpcIDs:number[]|null;combatSettled:boolean;
 remoteRepairModules?:{itemID:number;layer:"shield"|"armor"|"hull"}[];
 urgentNpcIDs?:number[];lockedByIDs?:number[];
 incomingNpcIDs?:number[];
 pve?:unknown;
}
export interface CombatDefinition {
 operationID?:string; revision?:number; name:string;mode:"BELT_PATROL"|"GATE_PATROL"|"SECURITY_MISSION"|"COMBAT_ANOMALY"|"DED_COMPLEX";systemID:number|null;systemName?:string|null;homeStationID:number|null;
 homeKind?:"station"|"structure";homeStationName?:string;parkingAccessPilotID?:number;
 objective?:{ownerCharacterID:number;agentID:number|null;corporationID?:number;repeat?:boolean;loot?:'NONE';resumeFromOperationID?:string;siteID?:number|null;maxSites?:number;dungeonID?:number;discoveryWaitMinutes?:number;maxDifficulty?:number;
   level?:number;levelRule?:"EXACT"|"UP_TO";stopRule?:"TIME"|"COUNT"|"ONE_MISSION";missionCount?:number;maxJumps?:number|null;rewardPolicy?:FleetRewardPolicy;
   resume?:{sourceOperationID:string}};
 parking?:{mode:"NEAREST"|"SELECTED"|"RETURN_HOME_DOCK"};
 preparation?:Record<string,unknown>;
 durationMinutes:number;observationSeconds?:number;
 members:{accountName:string;characterID:number;role?:"AUTO"|"TANK"|"DPS"|"DRONE_DPS"|"LOGISTICS";required?:boolean;preparation:{fittingID?:number}}[];
}
type MissionReward = {at?:number;iskDelta:number|null;lpDelta:number|null;taxISK?:number|null;corporationLpDelta?:number|null};
type CompletedObjective = {identity?:{acceptedKey?:string};reward?:MissionReward};
export interface CombatRow {definition:CombatDefinition;
 operationHistory?:{runID:string;activity:string;reason:string|null;completedCount:number|null}[];
 securityRunHistory?:{runID:string;stoppedAt?:number;reason?:string|null;completed?:CompletedObjective[]}[];
 run:null|{runID:string;phase:string;epoch:number|null;waypointIndex:number|null;waypoint?:{itemID:number;name:string;systemID:number};
 primaryID:number|null;reason?:string;holdReason?:string;stopReason?:string;anchor?:{characterID:number;shipID:number;size:number}|null;members:{characterID:number;shipID:number|null;state:string;required?:boolean;reason?:string;observationError?:string|null;supportTargetID?:number|null;fittingName?:string|null;parkingDestination?:{name:string}}[];
 startedAt?:number;securityContinue?:boolean;
 objective?:{stage:string;kind?:string;identity?:{contentID?:number;dungeonID?:number;instanceID?:number;roomID?:number;name?:string;difficulty?:number;npcHulls?:string[];acceptedKey?:string};blockedReason?:string;waitingReason?:string|null;agentName?:string|null;reward?:MissionReward;commands?:{status:string}[];completed?:CompletedObjective[]};
 recoveryRequired?:boolean;recoveryReceipt?:CombatRecovery;
 securityResume?:{identity:{acceptedKey:string};completed?:CompletedObjective[]};
 failures?:{reason?:string;code:string}[]}}
export interface CombatRecovery {
 runID:string;verified:boolean;reason?:string;
 members:{characterID:number;verified:boolean;reason:string}[];
}
export interface CombatReview {reviewHash:string;definition:CombatDefinition;profile:{rev:number;doc:BotScript}|null;
 blockers?:readonly string[];
 fleetMoves?:readonly {characterID:number;shipID:number;fromFleetID:number}[];
 timePolicy?:{requestedMinutes:number;grantMinutes:number;workBoundaryMinutes:number;cleanupReserveMinutes:number};
 canStart:boolean;staging:{id:number;name:string}|null;
 resume?:{sourceRunID:string;identity:{acceptedKey:string}}|null;
 continuation?:{remaining:number}|null;
 preparation:{state:string;members:{characterID:number;state:string;fittingName:string|null;reason:string|null}[]}}

export function combatMissionRewardSummary(run: CombatRow["run"]) {
 const objective=run?.objective;
 if (!objective) return null;
 const rewards=objective.completed?.length
   ? objective.completed.map(mission=>mission.reward)
   : objective.stage==="COMPLETED" ? [objective.reward] : [];
 if(!rewards.length)return null;
 const current=rewards.filter(r=>!r||r.at===undefined||run.startedAt===undefined||r.at>=run.startedAt);if(!current.length)return null;
 const sum=(key:'iskDelta'|'lpDelta'|'taxISK'|'corporationLpDelta')=>current.every(r=>r&&typeof r[key]==='number'&&Number.isFinite(r[key]))?current.reduce((n,r)=>n+(r![key] as number),0):null;
 return {isk:sum('iskDelta'),lp:sum('lpDelta'),taxISK:sum('taxISK'),corporationLp:sum('corporationLpDelta')};
}

export interface HostedRunPolicy { readonly maxRuntimeMinutes:number; readonly defaultRuntimeMinutes:number; readonly durationChoices:readonly number[] }
