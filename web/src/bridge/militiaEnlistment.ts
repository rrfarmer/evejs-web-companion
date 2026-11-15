import { exactInt } from "./boundDogma.ts";
import { isListValue, readDictPairs, readRowsetRows, unwrapLong, type JsonValue } from "./wire.ts";

export const MILITIA_FACTIONS = {
  500003: { corporationID: 1000179, name: "Amarr Empire", banner: "Amarr", logo: "amarr" },
  500001: { corporationID: 1000180, name: "Caldari State", banner: "Caldari", logo: "caldari" },
  500004: { corporationID: 1000181, name: "Gallente Federation", banner: "Gallente", logo: "gallente" },
  500002: { corporationID: 1000182, name: "Minmatar Republic", banner: "Minmatar", logo: "minmatar" },
  500011: { corporationID: 1000436, name: "Angel Cartel", banner: "Angels", logo: "angels" },
  500010: { corporationID: 1000437, name: "Guristas Pirates", banner: "Guristas", logo: "guristas" },
} as const;

export type MilitiaFactionID = keyof typeof MILITIA_FACTIONS;
export type TheatersPage = "overview" | "warfare" | "insurgencies" | "enlistment";
export const EMPIRE_MILITIAS = [500003, 500001, 500004, 500002] as const;
export const PIRATE_MILITIAS = [500011, 500010] as const;
const militiaCorporations = new Set<number>(Object.values(MILITIA_FACTIONS).map((faction) => faction.corporationID));

export interface MilitiaAffiliation {
  readonly factionID: MilitiaFactionID | null;
  readonly directFactionID: MilitiaFactionID | null;
  readonly corpFactionID: MilitiaFactionID | null;
}

export interface MilitiaEligibility extends MilitiaAffiliation {
  readonly characterID: number;
  readonly corporationID: number;
  readonly stationFactions: readonly MilitiaFactionID[];
  readonly allowedFactions: readonly MilitiaFactionID[] | null;
  readonly standings: ReadonlyMap<number, number>;
  readonly cooldown: boolean;
}

export function militiaFactionID(value: unknown): MilitiaFactionID | null {
  return typeof value === "number" && Object.hasOwn(MILITIA_FACTIONS, value) ? value as MilitiaFactionID : null;
}

export function militiaIsPirate(id: number | null): boolean {
  return id === 500010 || id === 500011;
}

export function militiaAffiliation(value: JsonValue): MilitiaAffiliation {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("The server did not return militia affiliations.");
  const [effective, direct, corporation] = value;
  return { factionID: militiaFactionID(effective), directFactionID: militiaFactionID(direct), corpFactionID: militiaFactionID(corporation) };
}

export function allowedMilitiaFactions(value: JsonValue): MilitiaFactionID[] {
  const rows = isListValue(value) ? value.items : value;
  if (!Array.isArray(rows)) throw new Error("The server did not return permitted enlistments.");
  return rows.map(militiaFactionID).filter((id) => id !== null);
}

/** facWarSvc.GetCurrentStationFactionIDs, including The Fulcrum's two pirate militias. */
export function militiaStationFactions(stationID: number | null, systemID: number | null, ownerFactionID: number | null): MilitiaFactionID[] {
  if (!stationID) return [];
  const factionID = militiaFactionID(ownerFactionID);
  return [...new Set([...(factionID ? [factionID] : []), ...(stationID === 60015187 && systemID === 30100000 ? PIRATE_MILITIAS : [])])];
}

/** facWarSvc.IsCharacterInFwCooldown uses the start of the militia employment. */
export function militiaCooldown(direct: JsonValue, employment: JsonValue, now: bigint): boolean {
  const directUntil = exactInt(direct);
  if (directUntil !== null && BigInt(directUntil) > now) return true;
  return readRowsetRows(employment).some((row) => {
    const start = exactInt(row.startDate);
    return start !== null && militiaCorporations.has(Number(row.corporationID)) && BigInt(start) > now - 864_000_000_000n;
  });
}

export function militiaEnlistmentWarning(read: MilitiaEligibility, factionID: MilitiaFactionID): "enlisted" | "location" | "disallowed" | "standing" | "cooldown" | null {
  if (read.factionID !== null) return "enlisted";
  if (read.allowedFactions !== null && !read.allowedFactions.includes(factionID)) return "disallowed";
  if ((read.standings.get(factionID) ?? 0) < -0.0001) return "standing";
  if (read.cooldown) return "cooldown";
  return read.stationFactions.includes(factionID) ? null : "location";
}

/** eveCommands.OpenRelevantFWWindow selects a panel for the current session. */
export function relevantMilitiaPage(factionID: number | null): TheatersPage {
  return factionID === null ? "enlistment" : militiaIsPirate(factionID) ? "insurgencies" : "warfare";
}

/** The 24.02 dashboard falls back to Overview for its unregistered Conquest Overview. */
export function afterMilitiaEnlistment(previous: number | null, confirmed: number | null): TheatersPage | null {
  if (previous !== null || confirmed === null) return null;
  return militiaIsPirate(confirmed) ? "insurgencies" : "overview";
}

export interface MilitiaSystem {
  readonly systemID: number;
  readonly occupierID: MilitiaFactionID | null;
  readonly adjacency: string;
}

export function militiaWarzones(value: JsonValue): ReadonlyMap<number, readonly MilitiaSystem[]> {
  return new Map(readDictPairs(value).flatMap(([zone, states]) => {
    if (typeof zone !== "number") return [];
    const systems = readDictPairs(states).flatMap(([systemID, state]): MilitiaSystem[] => {
      if (typeof systemID !== "number" || !state || typeof state !== "object" || !("header" in state) || !Array.isArray(state.header)) return [];
      const args = state.header[1];
      if (!Array.isArray(args)) return [];
      return [{ systemID, occupierID: militiaFactionID(args[0]), adjacency: typeof args[1] === "string" ? args[1] : "" }];
    });
    return [[zone, systems] as const];
  }));
}

export interface MilitiaInsurgency {
  readonly campaignID: number;
  readonly factionID: MilitiaFactionID;
  readonly fobSystemID: number | null;
}

export function militiaInsurgencies(value: JsonValue): MilitiaInsurgency[] {
  const rows = isListValue(value) ? value.items : value;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): MilitiaInsurgency[] => {
    if (!row || typeof row !== "object" || !("header" in row) || !Array.isArray(row.header)) return [];
    const attrs = new Map(row.header.flatMap((part: JsonValue) => readDictPairs(part)));
    const campaignID = Number(unwrapLong(attrs.get("_campaignID")));
    const factionID = militiaFactionID(attrs.get("_pirateFactionID"));
    const fobSystemID = Number(unwrapLong(attrs.get("_structureID"))) > 0 ? Number(unwrapLong(attrs.get("_originSolarsystemID"))) || null : null;
    return campaignID > 0 && factionID ? [{ campaignID, factionID, fobSystemID }] : [];
  });
}
