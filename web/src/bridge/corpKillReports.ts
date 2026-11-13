// The corporation's kill reports (corp_ui_killreports.py CorpKillReports): corpRegistry.GetRecentKills /
// GetRecentLosses(num, offset) - a CachedMethodCallResult of a CRowset, one packed row a kill (killID, solarSystemID,
// victim and final blow characters, corporations, alliances, factions, ships, the final blow's weapon, killTime a
// FILETIME, moonID, ...). The page reads what the client's KillMail entry shows.
import { readRowField, unwrapLong, type JsonValue } from "./wire.ts";
import { unwrapCachedResult } from "./market.ts";
import { filetimeToUnixMs } from "./activity.ts";

export interface KillReport {
  readonly killID: number;
  readonly solarSystemID: number | null;
  readonly victimCharacterID: number | null;
  readonly victimCorporationID: number | null;
  readonly victimAllianceID: number | null;
  readonly victimShipTypeID: number | null;
  readonly finalCharacterID: number | null;
  readonly finalCorporationID: number | null;
  readonly finalAllianceID: number | null;
  readonly finalShipTypeID: number | null;
  readonly finalWeaponTypeID: number | null;
  /** The kill's time, ms since the epoch (its FILETIME), or null. */
  readonly killTimeMs: number | null;
}

/** A row's id field: a positive number, else null (the client's None). */
function idOf(value: JsonValue | undefined): number | null {
  const n = typeof value === "number" ? value : (() => { const l = unwrapLong(value); return l === null ? 0 : Number(l); })();
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The kills of a GetRecentKills / GetRecentLosses answer, as the server ordered them; [] for none or a malformed one. */
export function decodeKillReports(result: JsonValue | null | undefined): KillReport[] {
  const rowset = unwrapCachedResult((result ?? null) as JsonValue) as { list?: unknown } | null;
  const list = rowset && typeof rowset === "object" && !Array.isArray(rowset) && Array.isArray(rowset.list) ? (rowset.list as JsonValue[]) : [];
  const out: KillReport[] = [];
  for (const row of list) {
    const killID = idOf(readRowField(row, "killID"));
    if (killID === null) continue;
    const time = readRowField(row, "killTime");
    out.push({
      killID,
      solarSystemID: idOf(readRowField(row, "solarSystemID")),
      victimCharacterID: idOf(readRowField(row, "victimCharacterID")),
      victimCorporationID: idOf(readRowField(row, "victimCorporationID")),
      victimAllianceID: idOf(readRowField(row, "victimAllianceID")),
      victimShipTypeID: idOf(readRowField(row, "victimShipTypeID")),
      finalCharacterID: idOf(readRowField(row, "finalCharacterID")),
      finalCorporationID: idOf(readRowField(row, "finalCorporationID")),
      finalAllianceID: idOf(readRowField(row, "finalAllianceID")),
      finalShipTypeID: idOf(readRowField(row, "finalShipTypeID")),
      finalWeaponTypeID: idOf(readRowField(row, "finalWeaponTypeID")),
      killTimeMs: filetimeToUnixMs(unwrapLong(time)),
    });
  }
  return out;
}
