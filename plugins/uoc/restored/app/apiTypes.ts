// Exact WC74 view-model declarations @ 213da333; type imports adapted to plugin-owned contracts.
import type { JsonValue, BotLaunchGrant } from "../../../../web/src/plugin-api/index.ts";
import type { MiningTargetType, MiningOperationTarget } from "../mining/contracts.ts";
export interface FoundAgent {
  readonly agentID: number;
  readonly name: string;
  readonly level: number | null;
  readonly divisionID: number | null;
  readonly agentTypeID: number | null;
  readonly missionKind: string | null;
  readonly missionTypeLabel: string | null;
  readonly corporationID: number | null;
  readonly corporationName?: string | null;
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindAgentsResult {
  readonly kind: string;
  readonly level: number | null;
  readonly total: number;
  readonly capped: boolean;
  readonly agents: readonly FoundAgent[];
}

export interface ResolvedDestination {
  readonly id: number;
  readonly kind: "station" | "system" | "structure" | "unknown";
  readonly solarSystemID: number | null;
  readonly systemName: string | null;
  readonly stationID: number | null;
  readonly stationName: string | null;
  /**
   * R38 — true when this came back `unknown` because a player-structure lookup
   * could not be completed, rather than because nothing bears the ID. A caller
   * must not cache the miss when this is set.
   */
  readonly lookupFailed: boolean;
  /** A station's type (idCheckers.IsDeprecatedStation reads it); null for anything else, or where it is not known. */
  readonly stationTypeID: number | null;
}

export interface MapLocation {
  readonly id: number;
  readonly name: string;
  readonly kind: "system" | "station" | "structure";
  readonly solarSystemID: number | null;
  readonly solarSystemName: string | null;
}

export interface FindMapLocationsResult {
  readonly q: string;
  readonly kind: string | null;
  readonly total: number;
  readonly capped: boolean;
  readonly matches: readonly MapLocation[];
}

export interface PveDedChoice {
  dungeonID: number;
  name: string;
  rating: number;
  entryRoomID: number;
  rooms: number;
  shipClass: string;
}

export interface MiningOperationMemberDefinition {
  readonly preparation?: import("../mining/miningPreparation.ts").MiningPreparationFitting;
  readonly characterID: number;
  readonly characterName: string;
  readonly accountName: string;
  readonly role: "MINER" | "HAULER" | "DEFENDER" | "COMMAND";
  readonly routineMode?: "STANDARD" | "CUSTOM";
  readonly automationID: string;
}

export interface MiningOperationDefinition {
  readonly revision?: number;
  readonly oreLogistics?: import("../mining/contracts.ts").OreLogisticsConfig;
  readonly preparation?: import("../mining/miningPreparation.ts").MiningPreparationConfig;
  readonly support?: import("../mining/contracts.ts").MiningSupportOptions;
  readonly policies?: {
    readonly version: 1;
    readonly parking: {
      readonly mode: "STAY_IN_PLACE" | "RETURN_HOME_DOCK" | "RETURN_HOME_UNLOAD_DOCK";
      readonly destination:
        | {
            readonly stationID: number;
            readonly stationName: string;
            readonly systemName: string;
            readonly kind?: "station";
          }
        | import("../mining/contracts.ts").DockableLocation
        | null;
      readonly corporationDivision: number | null;
      readonly corporationID?: number | null;
    };
    readonly travelAssist?: { readonly mode: "DISABLED" | "AUTO" };
    readonly resourceTarget?: { readonly mode: "ANY_ELIGIBLE" };
    readonly resourcePolicy?: import("../mining/contracts.ts").ResourcePolicy;
    readonly scouting?: { readonly mode: "DISABLED" };
    readonly defense?: { readonly mode: "EXISTING_SELF_DEFENSE" };
  };
  readonly operationID?: string;
  readonly name: string;
  readonly area: {
    readonly anchorSystemID: number;
    readonly anchorSystemName: string | null;
    readonly reach: "CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT";
    readonly targetClasses: readonly MiningTargetType[];
    readonly anomalyFamily?: "ORE" | "MOON";
  };
  readonly targetPolicy: "ANY_ELIGIBLE";
  readonly unloadPolicy: "HAULER_SERVICE" | "SELF_UNLOAD";
  readonly unloadDestination?:
    | {
        readonly stationID: number;
        readonly stationName: string;
        readonly systemName?: string;
        readonly corporationDivision: number | null;
        readonly corporationID?: number | null;
      }
    | {
        readonly kind: "structure";
        readonly id: number;
        readonly name: string;
        readonly solarSystemID: number;
        readonly solarSystemName: string | null;
        readonly corporationDivision: number | null;
        readonly corporationID?: number | null;
      }
    | null;
  readonly members: readonly MiningOperationMemberDefinition[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MiningOperationRuntime {
  readonly extensionSupported?: boolean;
  readonly shiftEndsAt?: string;
  readonly supportStatus?: {
    readonly state: string;
    readonly core: string;
    readonly reason: string | null;
    readonly observedAtMs: number;
    readonly capabilities?: readonly import("../mining/contracts.ts").SupportCapabilityReadiness[];
  };
  readonly operationRunID?: string | null;
  readonly lastRun?: import("../../miningFleet/operationStore.ts").FleetRunResult | null;
  readonly preparation?: import("../mining/miningPreparation.ts").MiningPreparationProjection;
  readonly operationID: string;
  readonly state: string;
  readonly statusReason?: string | null;
  readonly observedAt?: string;
  readonly recoveryRequired?: boolean;
  readonly stopFreight?: import("../../miningFleet/operation.ts").StopFreightMode | null;
  readonly stopUnload?: import("../../operations/miningRecovery.ts").StopUnload;
  readonly canCloseOfflineStop?: boolean;
  readonly unverifiedStop?: import("../../operations/miningRecovery.ts").UnverifiedMiningStop;
  readonly currentTarget: MiningOperationTarget | null;
  readonly members: readonly (MiningOperationMemberDefinition & {
    readonly oreLogisticsWork?: import("../mining/contracts.ts").OreLogisticsWork | null;
    readonly preparation?: import("../mining/miningPreparation.ts").MiningMemberPreparation;
    readonly runtimeState: string;
    readonly phase: string | null;
    readonly reason: string | null;
    readonly failureCode?: string | null;
    readonly parkingState?: string | null;
    readonly dockedForUnload?: boolean;
    readonly canCheckUnload?: boolean;
    readonly pendingUnloadUnits?: number;
    readonly parkingSince?: number | null;
    readonly botID: string | null;
    readonly expiresAt?: string | null;
    readonly maxRuntimeMinutes?: number | null;
    readonly hosted?: boolean;
    readonly hostStartedAt?: string | null;
    readonly hostResumedAt?: string | null;
    readonly lastHostReason?: string | null;
  })[];
  readonly logisticsTail: readonly {
    readonly target: MiningOperationTarget;
    readonly pendingHaulers: readonly number[];
  }[];
  readonly rendezvous: {
    readonly kind: "MINER_CLEARANCE" | "SELF_UNLOAD";
    readonly target: MiningOperationTarget;
    readonly required: readonly number[];
    readonly ready: readonly number[];
  } | null;
  readonly history: readonly {
    readonly kind: string;
    readonly at: string;
    readonly target: MiningOperationTarget | null;
    readonly evidence: unknown;
  }[];
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly stopFailures: readonly { readonly characterID: number; readonly message: string }[];
}

export interface MiningOperationsPayload {
  readonly results?: readonly {
    readonly characterID: number;
    readonly ok: boolean;
    readonly error?: string;
    readonly message?: string;
  }[];
  readonly operations: readonly {
    readonly definition: MiningOperationDefinition & { readonly operationID: string };
    readonly runtime: MiningOperationRuntime;
  }[];
  readonly targetBoard: readonly MiningOperationTarget[];
  readonly capabilities: {
    readonly hostedRunPolicy?: import("../mining/hostedRunPolicy.ts").HostedRunPolicy;
    readonly targetClasses: Readonly<
      Record<MiningTargetType, { readonly executable: boolean; readonly note: string }>
    >;
    readonly reach: Readonly<
      Record<string, { readonly executable: boolean; readonly note?: string }>
    >;
    readonly defender: { readonly executable: boolean; readonly note: string };
    readonly operationOwnedContainers: { readonly executable: boolean; readonly note: string };
  };
}

export interface MiningResourceChoice {
  readonly typeID: number;
  readonly name: string;
  readonly family: "ore" | "ice";
}

export interface OperationLaunchPlanMember {
  readonly characterID: number;
  readonly routineMode: "STANDARD" | "CUSTOM";
  readonly pluginRun?: string;
  readonly script?: {
    readonly scriptID: string;
    readonly name: string;
    readonly rev: number;
    readonly doc: JsonValue;
  };
}

export interface MiningOperationLaunchPlan {
  readonly planHash: string;
  readonly warnings: readonly string[];
  readonly members: readonly OperationLaunchPlanMember[];
  readonly preparation?: import("../mining/miningPreparation.ts").MiningPreparationProjection;
}

export interface OperationPilotChoice {
  readonly accountName: string;
  readonly characterID: number;
  readonly characterName: string;
}

export type PilotAvailability =
  | "AVAILABLE"
  | "ACCOUNT_BUSY"
  | "WC_SESSION"
  | "HOSTED"
  | "CHECKING"
  | "RECOVERY"
  | "IN_GAME"
  | "OTHER_SESSION"
  | "UNKNOWN"
  | "UNCHECKED";

export interface VerifiedOperationPilot extends OperationPilotChoice {
  readonly corporationID?: number | null;
  readonly corporationName: string | null;
  readonly shipName: string | null;
  readonly availability: PilotAvailability;
  readonly reason: string;
  readonly assignment?: string;
  readonly currentStation?: {
    stationID: number;
    stationName: string;
    solarSystemID: number;
    solarSystemName: string | null;
  } | null;
}
