import { MILITIA_FACTIONS } from "./militiaEnlistment.ts";
import { readDictPairs, unwrapLong, type JsonValue } from "./wire.ts";

/** resourcewars.common.const.FACTION_TO_RW_LP_CORP */
export const RESOURCE_WAR_LP_ISSUERS = new Set([1000283, 1000284, 1000285, 1000286]);

/** inventorycommon.const.typeInsurgencyFOBAngel and typeInsurgencyFOBGuristas. */
export const PIRATE_LP_STORES = [
  { factionID: 500011, issuerID: MILITIA_FACTIONS[500011].corporationID, typeID: 78260 },
  { factionID: 500010, issuerID: MILITIA_FACTIONS[500010].corporationID, typeID: 79172 },
] as const;

export const ACTIVE_LP_FOB_STATES = new Set([2, 3, 4]);

export interface WalletLpStoreLocation {
  readonly factionID: number | null;
  readonly stationID: number | null;
  readonly fob: { readonly typeID: number; readonly systemID: number } | null;
  readonly unavailable: boolean;
}

export function resourceWarLpStations(value: JsonValue): ReadonlyMap<number, number> {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "dict") {
    throw new Error("Resource Wars store locations could not be read.");
  }
  return new Map(readDictPairs(value).flatMap(([issuer, station]) => {
    const issuerID = Number(unwrapLong(issuer)), stationID = Number(unwrapLong(station));
    return RESOURCE_WAR_LP_ISSUERS.has(issuerID) && Number.isSafeInteger(stationID) && stationID > 0
      ? [[issuerID, stationID] as const] : [];
  }));
}
