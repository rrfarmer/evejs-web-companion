// Plugin-owned copy of WC75 mining mission state contracts; no core runner dependency.
import type { FoundAgent, CurrentDungeon } from "./types.ts";
// Native observations and command fences shared by a hosted mission and its pilot flow.
export interface MiningMissionContent {
 readonly contentID:number; readonly level:number; readonly dungeonID:number; readonly templateID:string;
 readonly family:"ore"|"ice"; readonly typeID:number; readonly quantity:number; readonly resourceGroupID:number;
 readonly rockCount:number; readonly unitVolume:number; readonly rooms:1; readonly gates:0; readonly activeEncounters:0;
}

export interface MiningObjective {
  readonly kind: "mining";
  readonly characterID: number;
  readonly agentID: number;
  readonly content: MiningMissionContent;
  readonly missionState: 1 | 2;
  readonly acceptTimestamp: string | null;
  readonly systemID: number;
  readonly stationID: number;
  readonly stationSystemID: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly unitVolume: number;
  readonly completionStatus: 0 | 1;
  readonly locationNumber:number;
}
export type MiningObjectiveRead =
  | { readonly objective: MiningObjective; readonly reason: null }
  | { readonly objective: null; readonly reason: string };


export interface DungeonEntryScope {
  readonly characterID:number; readonly shipID:number; readonly flowGeneration:number;
}
export interface DungeonEntryReceipt {
  readonly source:"NATIVE_PUSH"; readonly scope:DungeonEntryScope;
  readonly sequence:number; readonly receivedAtMs:number;
  readonly dungeon:CurrentDungeon & {readonly instanceID:number};
}

export interface MissionMiningReach { readonly kind: "mission-reach"; readonly meters: number; }
export interface MissionMiningCycle {
  readonly moduleID:number;readonly typeID:number;readonly targetID:number;
  readonly status:"prepared"|"accepted";readonly scope:string;readonly quantityBefore:number;
  readonly deadlineMs:number;
  readonly observedAtMs?:number;
}
export interface MiningMissionMutation {
  readonly id: string;
  readonly kind: "request" | "accept" | "complete" | "unload";
  readonly hangarBefore?: number;
  readonly shipBefore?: number;
  readonly quantity?: number;
  readonly itemID?:number;readonly bay?:string|null;readonly typeID?:number;
}
export interface MiningMissionState {
  readonly version: 2; readonly revision: number; readonly epoch: string;
  readonly characterID: number; readonly shipID: number; readonly agentID: number; readonly stationID: number;
  readonly completedCount?: number; readonly completedEpoch?: string;
  readonly phase: "ready" | "request" | "review" | "accept" | "outbound" | "entry" | "mining" | "return" | "bank" | "unload" | "complete" | "done";
  readonly objective: MiningObjective | null;
  readonly reviewedOfferID?: number | null;
  readonly baseline: number; readonly banked: number; readonly trip: number; readonly tripBankedStart: number;
  readonly pending: MiningMissionMutation | null;
  readonly entry: { readonly warps: number; readonly positionKey: string; readonly issuedAt: number; readonly afterSequence:number; readonly flowGeneration:number } | null;
  readonly pocketIDs: readonly number[];
  readonly instanceID?:number|null;
  readonly entryConfirmed?:{readonly sequence:number;readonly receivedAtMs:number;readonly instanceID:number;readonly contextGeneration:number}|null;
  readonly shipQuantity: number;
  readonly progressAt: number;
  readonly waitTicks: number;
  readonly cycle?:MissionMiningCycle|null;
  readonly readSettlingSince?:number;
  readonly cycleTerminals?:readonly {readonly cycle:MissionMiningCycle;readonly outcome:"SETTLED_NO_CREDIT"|"SETTLED_OBSERVED_GAIN"|"SETTLED_PREVIOUSLY_CREDITED";
    readonly evidence:MissionCycleSettlement;readonly shipQuantity:number;readonly hangarQuantity:number}[];
}
export interface MiningMissionReceipt {
  readonly id: string; readonly dispatched: boolean; readonly acknowledged: boolean;
  readonly missionCompleted: boolean;
}
export interface MiningMissionCheckpoint {
  readonly characterID: number;
  readonly epoch: string;
  read(): { readonly state: MiningMissionState | null; readonly receipt: MiningMissionReceipt | null };
  save(state: MiningMissionState): Promise<void>;
  dispatch(id: string): Promise<void>;
  acknowledge(id: string, missionCompleted?: boolean): Promise<void>;
  assertCurrent(): void;
}
export interface MiningMissionObservation {
  readonly characterID: number; readonly epoch: string; readonly nowMs: number; readonly readAtMs: number;
  readonly sceneReadAtMs: number;
  readonly agent: FoundAgent | null;
  readonly read: MiningObjectiveRead | null;
  readonly state: MiningMissionState | null;
  readonly receipt: MiningMissionReceipt | null;
  readonly hosted: boolean;
  /** Full fitted inventory/charge identity; unknown does not authorize a cycle receipt. */
  readonly fitKey?:string|null;
  readonly cycleSettlement?:MissionCycleSettlement|null;
  readonly observationSettling?:boolean;
  readonly entryAuthorityFailure?: string | null;
  readonly dungeon:CurrentDungeon|null;
  readonly tracker:boolean|null;
  readonly flowGeneration:number;
  readonly entryEvidence:{readonly sequence:number;readonly contextGeneration:number;readonly entry:DungeonEntryReceipt|null};
  readonly fit: readonly { readonly itemID: number; readonly typeID: number; readonly family: "ore" | "ice"; readonly cycleMs: number }[] | null;
}
export interface MissionCycleSettlement {
  readonly source:"ItemGetInfo";readonly cycleKey:string;readonly characterID:number;readonly shipID:number;
  readonly stationID:number;readonly readAtMs:number;readonly moduleID:number;readonly typeID:number;
  readonly nativeTime:string|null;
  readonly minedGain?:number;readonly ledgerEntryIDs?:readonly number[];
  readonly ledgerSource?:"characterMiningLedger.GetCharacterLogs";
}


// Local dispatch vocabulary extends the stock plugin API without changing core.
import type { MacroMemory, MacroStep, MacroTick, ScriptAction, ScriptBoard, ScriptObservation } from "../../../web/src/plugin-api/index.ts";
import type { JournalState, SpaceSnapshot } from "./types.ts";
export type MiningScriptObservation = Omit<ScriptObservation, "snapshot" | "journal"> & {
  readonly snapshot?: SpaceSnapshot | null;
  readonly journal?: JournalState | null;
  readonly miningMission?: MiningMissionObservation | null;
  readonly missionAdmissionClosed?: boolean;
};
export type MiningScriptAction = Exclude<ScriptAction, {kind: "agentButton" | "unloadHolds" | "warpMissionLocation"}> |
  (Extract<ScriptAction, {kind: "agentButton"}> & { readonly missionKey?: string; readonly miningMissionOperationID?: string }) |
  (Extract<ScriptAction, {kind: "unloadHolds"}> & { readonly miningMissionOperationID?: string }) |
  (Extract<ScriptAction, {kind: "warpMissionLocation"}> & { readonly missionKey?: string });
export type MiningMacroTick = Omit<MacroTick, "action"> & { readonly action: MiningScriptAction };
export type MiningMacroDecider = (step: MacroStep, observation: MiningScriptObservation, memory: MacroMemory, board: ScriptBoard) => MiningMacroTick;
