import type { MiningBurstServices, CompressionServiceObservation } from "../bridge/miningSupportServices.ts";
import type { CoreMobilityFuelObservation } from "../bridge/miningSupportCore.ts";

export interface SupportAnchorServices {
  readonly bursts: MiningBurstServices | null;
  readonly compression: CompressionServiceObservation;
  /** Runtime effect identities/state; no fitted-hull classification or fuel policy. */
  readonly supportEffects: Pick<CoreMobilityFuelObservation, "activeModuleIDs" | "mobility"> & {
    readonly modules: readonly Pick<CoreMobilityFuelObservation["modules"][number], "moduleID" | "typeID" | "active" | "effect">[];
  } | null;
}

export interface MiningSupportAnchor {
  readonly characterID: number;
  readonly shipID: number;
  readonly fleetID: string;
  readonly solarSystemID: number | null;
  /** Opaque BFF epoch, never a gateway handle or auth token. */
  readonly sessionEpoch: string;
  readonly sampledAtMs: number;
  readonly observedAtMs: number;
  readonly publishedAtMs: number;
  readonly expiresAtMs: number;
  readonly ageMs: number;
  readonly freshness: "fresh" | "stale" | "invalid";
  readonly reason: string | null;
  readonly services: SupportAnchorServices;
}
export interface SupportFleetRoster {
  readonly fleetID: string;
  readonly readerCharacterID: number;
  readonly members: readonly { readonly characterID: number; readonly solarSystemID: number | null }[];
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}
export interface MiningSupportAnchorRead {
  readonly availability: "available" | "unknown";
  readonly reason: string | null;
  readonly readAtMs: number;
  readonly fleet: SupportFleetRoster | null;
  readonly anchors: readonly MiningSupportAnchor[];
}
