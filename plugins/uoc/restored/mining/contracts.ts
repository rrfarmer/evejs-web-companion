// WC74 type-only contracts from web/src/nav and app/api.ts @ 213da333. No execution code.

export interface SpaceVector { readonly x:number; readonly y:number; readonly z:number; }

export type MiningOperationRole = "MINER" | "HAULER" | "DEFENDER" | "COMMAND";
export interface MiningSupportOptions {
  readonly version: 1; readonly characterID: number; readonly fleetPolicy: "EXISTING_ONLY" | "MANAGED";
  readonly maintainBursts: boolean; readonly useIndustrialCore: boolean; readonly coreRequirement: "continueWithoutCore" | "requireCore";
  readonly enableCompression: boolean; readonly selfMining: boolean; readonly tractor: boolean;
  readonly collection: "TRACTOR_ONLY" | "TRACTOR_AND_COLLECT"; readonly compressCollectedOre: boolean;
  readonly supportLoss: "CONTINUE_UNSUPPORTED" | "PAUSE" | "STOP";
}
export type MiningTargetType = "BELT" | "ORE_ANOMALY" | "ICE" | "GAS";
export interface MiningOperationTarget {
  readonly relocationRequested?:boolean;
  readonly claimedAt?:number|null;
  readonly siteIdentity?: string;
  readonly siteID?: number;
  readonly instanceID?: number | null;
  readonly position?: SpaceVector;
  readonly targetKey: string;
  readonly targetType: MiningTargetType;
  readonly systemID: number;
  readonly systemName: string | null;
  readonly targetName: string;
  readonly state: "AVAILABLE" | "RESERVED" | "ACTIVE" | "DRAINING" | "DEPLETED" | "QUARANTINED" | "DANGEROUS";
  readonly claimedByOperationID: string | null;
}
export interface MiningOperationAssignment {
  readonly oreLogistics?:OreLogisticsConfig;
  readonly standardRoutine?:boolean;
  readonly freightStopRequested?:boolean;
  readonly operationRunID?: string | null;
  readonly support?: MiningSupportOptions;
  readonly supportPolicy?: { readonly mode: "NORMAL" | "FALLBACK" | "PAUSE" | "STOP"; readonly reason: string | null };
  readonly intendedFleetCharacterIDs?: readonly number[];
  readonly resourcePolicy?: ResourcePolicy | null;
  readonly travelAssist?: "DISABLED" | "AUTO";
  readonly stopRequested?: boolean;
  readonly operationID: string;
  readonly operationName: string;
  readonly role: MiningOperationRole;
  readonly unloadPolicy: "HAULER_SERVICE" | "SELF_UNLOAD";
  readonly area: {
    readonly anchorSystemID: number;
    readonly anchorSystemName: string | null;
    readonly reach: "CURRENT_SYSTEM" | "CURRENT_AND_ADJACENT";
    readonly targetClasses: readonly MiningTargetType[];
  };
  readonly state: string;
  readonly currentTarget: MiningOperationTarget | null;
  readonly logisticsTarget: MiningOperationTarget | null;
  /** BFF-recorded cans from this run's miner jettison at the assigned target. */
  readonly ownedContainerIDs?: readonly number[];
  readonly miningOwnerIDs?: readonly number[];
  readonly containerProvenanceUnconfirmed?: boolean;
  readonly containerManifests?:readonly {readonly containerID:number;readonly category:'RAW'|'COMPRESSED';readonly volumeM3:number;readonly registeredAtMs:number}[];
  readonly rendezvous: {
    readonly kind: "MINER_CLEARANCE" | "SELF_UNLOAD";
    readonly required: readonly number[];
    readonly ready: readonly number[];
    readonly thisMemberReady: boolean;
  } | null;
}

export interface SupportCapabilityReadiness {
  readonly capability:"Bursts"|"Industrial Core"|"Compression"|"Tractor"|"Mobility";
  readonly state:"QUALIFIED"|"NOT_FITTED"|"MISSING_SUPPLIES"|"BLOCKED"|"PENDING";
  readonly modules:number;
  readonly reason:string;
}

export interface ResourcePolicy {
  readonly mode: "ANY_ELIGIBLE" | "PREFER_LIST";
  readonly source: "MANUAL";
  readonly typeIDs: readonly number[];
}

export type DockableKind = "station" | "structure";

/** Stable, kind-aware identity for a place at which a pilot may dock. */
export interface DockableLocation {
  readonly kind: DockableKind;
  readonly id: number;
  readonly name: string;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
}

export interface OreLogisticsConfig {readonly version:1;readonly remoteCompression:boolean;readonly compressedJettisonFraction:number;}
export interface OreLogisticsObservation {readonly enabled:boolean;readonly jetcanCapacityM3:number|null;readonly facility:QualifiedRemoteFacility|null;
 readonly compatibility:readonly CompressionCompatibility[]|null;readonly pending:boolean|null;readonly jettisonRetryAfterMs:number;readonly compressionRetryAfterMs?:number;readonly fault:string|null;}
export interface OreLogisticsWork extends OreLogisticsObservation {readonly rawM3:number|null;readonly compressedM3:number|null;readonly capacityM3:number|null;
 readonly rawUnits:number|null;readonly compressedUnits:number|null;readonly observedAtMs:number;readonly holds?:readonly {flagID:number;capacityM3:number;rawM3:number;compressedM3:number}[];readonly facilityObservation?:{rangeMeters:number;surfaceDistanceMeters:number;observedAt:number}|null;}

export interface QualifiedRemoteFacility {
 readonly shipID:number;readonly characterID:number;readonly fleetID:string;readonly sessionEpoch:string;
 readonly typeListRanges:readonly {readonly typeListID:number;readonly rangeMeters:number}[];readonly distanceMeters:number;
}

export interface CompressionCompatibility {
  readonly typeID: number; readonly compressedTypeID: number | null;
  readonly matchingTypeListIDs: readonly number[] | null; readonly availability: "available" | "unknown";
}
