import type { StationStatic } from "../store/types.ts";
import { hasSecurityOffice } from "./securityOffice.ts";

// stationServiceConst.serviceData and infosvc.GetServicesForStation.
export const NPC_STATION_SERVICE_LABELS = [
  ["UI/Station/CharacterRecustomization", "Re-customization", "charcustomization", [-1]],
  ["UI/Medical/Medical", "Clone Bay", "cloneBay", [10, 11, 12, 24]],
  ["UI/Station/Repairshop", "Repairshop", "repairshop", [13]],
  ["UI/Station/ReprocessingPlant", "Reprocessing Plant", "Reprocess", [5]],
  ["UI/Station/Market", "Market", "market", [7]],
  ["UI/Station/Fitting", "Fitting", "fitting", [17]],
  ["UI/Industry/Industry", "Industry", "Industry", [14, 15]],
  ["UI/Station/MilitiaOffice", "Militia Office", "factionalwarfare", [26]],
  ["UI/Station/Insurance", "Insurance", "insurance", [21]],
  ["UI/Station/LPStore", "LP Store", "lpstore", [25]],
  ["UI/Station/SecurityOffice", "Security Office", "concord", [27]],
] as const;

const empireFactions = new Set([500001, 500002, 500003, 500004]);
const restricted = new Set([5, 13, 14, 17, 24]);
interface NpcStationService {
  readonly label: string;
  readonly fallback: string;
  readonly icon: string;
  readonly restriction: { readonly owner: number; readonly required: number } | null;
}

export function npcStationServices(station: StationStatic, pilotSecurity: number | null,
  restrictions: Readonly<Record<string, Readonly<Record<string, number>>>>): readonly NpcStationService[] {
  const owners = [station.ownerID, station.systemFactionID].filter((id): id is number => id != null);
  const services = new Set(station.serviceIDs);
  services.add(-1);
  if (pilotSecurity !== null && pilotSecurity >= 0.45) services.add(13);
  if (!empireFactions.has(station.ownerFactionID ?? 0)) services.delete(26);
  if (!hasSecurityOffice(station.ownerID ?? null, station.security)) services.delete(27);
  return NPC_STATION_SERVICE_LABELS.flatMap<NpcStationService>(([label, fallback, icon, ids]) => {
    if (!ids.some(id => services.has(id))) return [];
    for (const id of ids) {
      if (!restricted.has(id)) continue;
      for (const owner of owners) {
        const required = restrictions[owner]?.[id];
        if (required) return [{ label, fallback, icon, restriction: { owner, required } }];
      }
    }
    return [{ label, fallback, icon, restriction: null }];
  });
}
