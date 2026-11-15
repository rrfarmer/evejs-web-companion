import { exactInt } from "./boundDogma.ts";
import { isListValue, readDictPairs, readKeyVal, readRowsetRows, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

export const MILITIA_FACTIONS = {
  500003: { corporationID: 1000179, name: "Amarr Empire", banner: "Amarr", logo: "amarr" },
  500001: { corporationID: 1000180, name: "Caldari State", banner: "Caldari", logo: "caldari" },
  500004: { corporationID: 1000181, name: "Gallente Federation", banner: "Gallente", logo: "gallente" },
  500002: { corporationID: 1000182, name: "Minmatar Republic", banner: "Minmatar", logo: "minmatar" },
  500011: { corporationID: 1000436, name: "Angel Cartel", banner: "Angels", logo: "angels" },
  500010: { corporationID: 1000437, name: "Guristas Pirates", banner: "Guristas", logo: "guristas" },
} as const;

export type MilitiaFactionID = keyof typeof MILITIA_FACTIONS;
export interface MilitiaOffice { readonly stationID: number; readonly systemID: number; readonly jumps: number | null }
export type TheatersPage = "overview" | "warfare" | "insurgencies" | "enlistment";
export const EMPIRE_MILITIAS = [500003, 500001, 500004, 500002] as const;
export const PIRATE_MILITIAS = [500011, 500010] as const;
export const WARZONE_FACTION_COLORS: Readonly<Record<number, string>> = { 500001: "#00acd1", 500002: "#fe3743", 500003: "#e7b815", 500004: "#40aa5e" };
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
  readonly organization?: MilitiaOrganization;
}

interface MilitiaOrganization {
  readonly status: 0 | 1 | 2 | null;
  readonly factionID: MilitiaFactionID | null;
  readonly allianceID: number | null;
  readonly isExecutor: boolean;
}

export function militiaOrganization(value: JsonValue, allianceID: number | null, isExecutor: boolean): MilitiaOrganization {
  const status = readKeyVal(value, "status");
  return { status: status === 0 || status === 1 || status === 2 ? status : null,
    factionID: militiaFactionID(readKeyVal(value, "factionID")), allianceID, isExecutor };
}

export const MILITIA_ORGANIZATION_METHODS = {
  joinCorporation: "JoinFactionAsCorporation", joinAlliance: "JoinFactionAsAlliance",
  retireCorporation: "LeaveFactionAsCorporation", retireAlliance: "LeaveFactionAsAlliance",
  withdrawCorporation: "WithdrawJoinFactionAsCorporation", withdrawAlliance: "WithdrawJoinFactionAsAlliance",
  cancelRetireCorporation: "WithdrawLeaveFactionAsCorporation", cancelRetireAlliance: "WithdrawLeaveFactionAsAlliance",
} as const;
export type MilitiaOrganizationAction = keyof typeof MILITIA_ORGANIZATION_METHODS;

export function militiaOrganizationActions(read: MilitiaEligibility, factionID: MilitiaFactionID): readonly MilitiaOrganizationAction[] {
  const org = read.organization;
  if (!org) return [];
  const alliance = org.allianceID !== null;
  if (org.status === null && read.factionID === null && read.stationFactions.includes(factionID)) {
    return org.isExecutor ? ["joinCorporation", "joinAlliance"] : ["joinCorporation"];
  }
  if (org.factionID !== factionID || (alliance && !org.isExecutor)) return [];
  if (org.status === 0) return [alliance ? "withdrawAlliance" : "withdrawCorporation"];
  if (read.factionID !== factionID || read.directFactionID !== null) return [];
  if (org.status === 1) return [alliance ? "retireAlliance" : "retireCorporation"];
  return org.status === 2 ? [alliance ? "cancelRetireAlliance" : "cancelRetireCorporation"] : [];
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

export function militiaEnlistmentWarning(read: MilitiaEligibility, factionID: MilitiaFactionID): "enlisted" | "location" | "disallowed" | "standing" | "cooldown" | "pending" | null {
  if (read.factionID !== null) return "enlisted";
  if (read.corpFactionID !== null) return "pending";
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
  readonly attackerID: MilitiaFactionID | null;
  readonly adjacency: string;
  readonly dateTaken: bigint | null;
}

function objectArguments(value: JsonValue | undefined): JsonValue[] | null {
  if (!value || typeof value !== "object" || !("header" in value) || !Array.isArray(value.header)) return null;
  return Array.isArray(value.header[1]) ? value.header[1] : null;
}

function listItems(value: JsonValue | undefined): readonly JsonValue[] {
  return isListValue(value) ? value.items : Array.isArray(value) ? value : [];
}

export function militiaWarzones(value: JsonValue): ReadonlyMap<number, readonly MilitiaSystem[]> {
  return new Map(readDictPairs(value).flatMap(([zone, states]) => {
    if (typeof zone !== "number") return [];
    const systems = readDictPairs(states).flatMap(([systemID, state]): MilitiaSystem[] => {
      const args = objectArguments(state);
      if (typeof systemID !== "number" || !args) return [];
      const occupierID = militiaFactionID(args[0]);
      const attackerID = listItems(args[2]).map(militiaFactionID).find(id => id !== null && id !== occupierID) ?? null;
      const date = exactInt(args[4]);
      return [{ systemID, occupierID, attackerID, adjacency: typeof args[1] === "string" ? args[1] : "",
        dateTaken: date === null ? null : BigInt(date) }];
    });
    return [[zone, systems] as const];
  }));
}

export interface MilitiaInsurgency {
  readonly campaignID: number;
  readonly factionID: MilitiaFactionID;
  readonly warzoneID: number | null;
  readonly originSystemID: number | null;
  readonly fobSystemID: number | null;
}

export interface MilitiaVictoryPoints {
  readonly score: number;
  readonly threshold: number;
}

export function militiaVictoryPoints(value: JsonValue | undefined): MilitiaVictoryPoints | null {
  const args = objectArguments(value);
  const score = unwrapReal(args?.[0]), threshold = unwrapReal(args?.[1]);
  return score !== null && score >= 0 && threshold !== null && threshold > 0 ? { score, threshold } : null;
}

export interface MilitiaWarzoneMarkers {
  readonly headquarters: ReadonlyMap<number, number>;
  readonly launchers: ReadonlySet<number>;
  readonly pads: readonly { systemID: number; factionID: number }[];
  readonly battlefields: ReadonlyMap<number, number>;
}

export function militiaWarzoneMarkers(hqs: JsonValue, launchers: JsonValue, pads: JsonValue, battlefields: JsonValue): MilitiaWarzoneMarkers {
  return {
    headquarters: new Map(readDictPairs(hqs).flatMap(([faction, system]) =>
      typeof faction === "number" && typeof system === "number" ? [[faction, system] as const] : [])),
    launchers: new Set(listItems(launchers).filter((id): id is number => typeof id === "number")),
    pads: listItems(pads).flatMap((pad) => {
      const args = objectArguments(pad);
      const systemID = args?.[1], factionID = args?.[2];
      return typeof systemID === "number" && typeof factionID === "number" && (unwrapLong(args?.[4]) ?? 0n) !== 0n ? [{ systemID, factionID }] : [];
    }),
    battlefields: new Map(readDictPairs(battlefields).flatMap(([system, dungeons]) => {
      const first = listItems(dungeons)[0];
      const nameID = readKeyVal(first, "dungeonNameID");
      return typeof system === "number" && first !== undefined ? [[system, typeof nameID === "number" ? nameID : 0] as const] : [];
    })),
  };
}

export interface InsurgencyCampaign extends MilitiaInsurgency {
  readonly coveredSystemIDs: readonly number[];
  readonly fsmState: number | null;
  readonly stateExpiryMs: number | null;
}

export function insurgencyCampaigns(value: JsonValue): InsurgencyCampaign[] {
  return listItems(value).flatMap((row): InsurgencyCampaign[] => {
    if (!row || typeof row !== "object" || !("header" in row) || !Array.isArray(row.header)) return [];
    const attrs = new Map(row.header.flatMap((part: JsonValue) => readDictPairs(part)));
    const campaignID = Number(unwrapLong(attrs.get("_campaignID")));
    const factionID = militiaFactionID(attrs.get("_pirateFactionID"));
    const warzoneID = Number(unwrapLong(attrs.get("_warzoneID"))) || null;
    const originSystemID = Number(unwrapLong(attrs.get("_originSolarsystemID"))) || null;
    const fobSystemID = Number(unwrapLong(attrs.get("_structureID"))) > 0 ? originSystemID : null;
    const covered = attrs.get("_coveredSolarsystemIDs");
    const coveredSystemIDs = listItems(objectArguments(covered)?.[0] ?? covered)
      .map((system) => Number(unwrapLong(system))).filter((id) => Number.isSafeInteger(id) && id > 0);
    const expiry = unwrapLong(attrs.get("_stateExpiryTimestamp"));
    const state = unwrapLong(attrs.get("_fsmState"));
    return campaignID > 0 && factionID ? [{
      campaignID, factionID, warzoneID, originSystemID, fobSystemID, coveredSystemIDs,
      fsmState: state === null ? null : Number(state),
      stateExpiryMs: expiry === null ? null : Number((expiry - 116_444_736_000_000_000n) / 10_000n),
    }] : [];
  });
}

export function militiaInsurgencies(value: JsonValue): MilitiaInsurgency[] {
  return insurgencyCampaigns(value).map(({ campaignID, factionID, warzoneID, originSystemID, fobSystemID }) => ({
    campaignID, factionID, warzoneID, originSystemID, fobSystemID,
  }));
}
