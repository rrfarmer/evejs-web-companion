import type { InfoWindowState } from "../app/infoWindows.ts";
import { resolvedName } from "../store/names.ts";
export function infoWindowLabel(w: InfoWindowState, names: Readonly<Record<string, string | null>>): string {
  const s = w.captionEntry.subject;
  switch (s.kind) {
    case "character": return resolvedName(names, "character", s.characterID, "Show Info");
    case "corporation": return resolvedName(names, "corporation", s.corporationID, "Show Info");
    case "alliance": return resolvedName(names, "alliance", s.allianceID, "Show Info");
    case "faction": return resolvedName(names, "faction", s.factionID, "Show Info");
    case "rank": return s.name;
    case "mapLocation": return resolvedName(names, s.typeID === 3 ? "region" : s.typeID === 4 ? "constellation" : "system", s.itemID, "Show Info");
    default: return s.typeID === null ? "Show Info" : resolvedName(names, "type", s.typeID, "Show Info");
  }
}
