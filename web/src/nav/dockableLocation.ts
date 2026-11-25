import type { FlightStatus } from "../store/types.ts";

export type DockableKind = "station" | "structure";

/** Stable, kind-aware identity for a place at which a pilot may dock. */
export interface DockableLocation {
  readonly kind: DockableKind;
  readonly id: number;
  readonly name: string;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
}

export type DockableCapability = "dock" | "personalInventory" | "corporationHangar" |
  "fitting" | "repair" | "reprocessing" | "market" | "industry";

const SERVICE_ID: Readonly<Record<Exclude<DockableCapability, "personalInventory" | "industry">, number>> = {
  dock: 1, fitting: 2, corporationHangar: 3, reprocessing: 4, market: 5, repair: 8,
};

// structures.INDUSTRY_SERVICES includes the aggregate and every installed activity service.
const INDUSTRY_SERVICE_IDS = new Set([20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 40, 41, 42, 43]);

/** A service read is access-scoped; null means unreadable and grants nothing. */
export function structureHasCapability(ids: readonly number[] | null, capability: DockableCapability): boolean {
  if (ids === null) return false;
  if (capability === "industry") return ids.some(id => INDUSTRY_SERVICE_IDS.has(id));
  return ids.includes(SERVICE_ID[capability === "personalInventory" ? "dock" : capability]);
}

export function dockedAt(status: FlightStatus | null | undefined, location: Pick<DockableLocation, "kind" | "id">): boolean {
  return status?.docked === true &&
    (location.kind === "structure" ? status.structureID : status.stationID) === location.id;
}
