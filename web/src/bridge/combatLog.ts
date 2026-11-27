import { decodeKillReport, killReportRows, type KillReport } from "./corpKillReports.ts";
import { readRowField, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

export interface CombatLogReport extends KillReport {
  readonly killTime: bigint | null;
  readonly victimFactionID: number | null;
  readonly moonID: number | null;
  readonly damageTaken: number | null;
  readonly finalDamageDone: number | null;
  readonly finalFactionID: number | null;
  readonly finalSecurityStatus: number | null;
  readonly killBlob: string;
}

export interface CombatReportWindow {
  readonly id: string;
  readonly report: CombatLogReport;
}

export function decodeCombatLog(result: JsonValue): CombatLogReport[] {
  return killReportRows(result).map(decodeCombatReport).filter(report => report !== null);
}

export function decodeCombatReport(row: JsonValue): CombatLogReport | null {
  const report = decodeKillReport(row);
  if (report === null) return null;
  const id = (field: string) => Number(unwrapLong(readRowField(row, field)) ?? 0n) || null;
  const blob = readRowField(row, "killBlob");
  return {
    ...report,
    killTime: unwrapLong(readRowField(row, "killTime")),
    victimFactionID: id("victimFactionID"),
    moonID: id("moonID"),
    damageTaken: unwrapReal(readRowField(row, "victimDamageTaken")),
    finalDamageDone: unwrapReal(readRowField(row, "finalDamageDone")),
    finalFactionID: id("finalFactionID"),
    finalSecurityStatus: unwrapReal(readRowField(row, "finalSecurityStatus")),
    killBlob: typeof blob === "string" ? blob : "",
  };
}

export const COMBAT_REPORT_LABEL = "UI/Corporations/Wars/Killmails/KillReport";

export function combatReportUrl(killID: number, hash: string): string {
  return `killReport:${killID}:${hash}`;
}

export function parseCombatReportUrl(url: string): { killID: number; hash: string } | null {
  const parts = /^killReport:([1-9]\d*):([0-9a-f]{40})$/i.exec(url);
  if (!parts) return null;
  const killID = Number(parts[1]);
  return Number.isSafeInteger(killID) ? { killID, hash: parts[2]! } : null;
}

export async function combatReportHash(row: CombatLogReport): Promise<string> {
  const input = [row.victimCharacterID, row.finalCharacterID, row.victimShipTypeID, row.killTime]
    .map(value => value === null ? "None" : String(value)).join("");
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function combatReportDetails(row: CombatLogReport) {
  // Older mail blobs leave numeric attributes unquoted. Parse inert XML and
  // read only the native attacker and item fields.
  const xml = row.killBlob.replace(/=(-?\d+(?:\.\d+)?)(?=[\s/>])/g, '="$1"');
  const doc = new DOMParser().parseFromString(`<mail>${xml}</mail>`, "text/xml");
  const number = (node: Element, name: string) => Number(node.getAttribute(name)) || 0;
  const attackers = [...doc.querySelectorAll("attackers > a")].map(node => ({
    characterID: number(node, "c"),
    corporationID: number(node, "r"),
    allianceID: number(node, "a"),
    factionID: number(node, "f"),
    shipTypeID: number(node, "s"),
    weaponTypeID: number(node, "w"),
    damage: number(node, "d"),
    security: node.getAttribute("t") ?? "",
    final: false,
  }));
  const final = attackers.find(each => (row.finalCharacterID !== null
    ? each.characterID === row.finalCharacterID : each.corporationID === row.finalCorporationID && each.shipTypeID === row.finalShipTypeID));
  if (final) final.final = true;
  else if (row.finalCharacterID || row.finalCorporationID) attackers.push({
    characterID: row.finalCharacterID ?? 0, corporationID: row.finalCorporationID ?? 0,
    allianceID: row.finalAllianceID ?? 0, factionID: row.finalFactionID ?? 0, shipTypeID: row.finalShipTypeID ?? 0,
    weaponTypeID: row.finalWeaponTypeID ?? 0, damage: row.finalDamageDone ?? 0,
    security: row.finalSecurityStatus?.toFixed(1) ?? "0.0", final: true,
  });
  const items = [...doc.querySelectorAll("items i")].map(node => ({
    typeID: number(node, "t"), dropped: number(node, "d"), destroyed: number(node, "x"),
    flag: number(node, "f"), singleton: number(node, "s"), contained: node.parentElement?.localName === "i",
  })).filter(item => item.typeID > 0 && (item.dropped > 0 || item.destroyed > 0));
  return { attackers: attackers.sort((left, right) => right.damage - left.damage), items };
}
