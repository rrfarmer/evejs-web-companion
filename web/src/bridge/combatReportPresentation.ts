import { formatTemplate, plainText } from "./clientWords.ts";
import { combatReportDetails, type CombatLogReport } from "./combatLog.ts";
import { shownSecurity } from "./systemSecurity.ts";
import type { JsonValue } from "./wire.ts";
import { resolvedName, type NameRef, type NamesState, type WordsState } from "../store/names.ts";

const mailPath = "UI/Util/CommonUtils/";
const mailLabels = ["KillMail", "KillMailHeaderWithShip", "KillMailHeaderWithStructure",
  "KillMailPlayerAttacker", "KillMailPlayerAttackerWithFinalBlow", "KillMailMPCAttackerWithFinalBlow",
  "KillMailNPCAttacker", "KillMailDroppedItems", "KillMailDestroyedItems", "KillMailLostItem",
  "KillMAilLostStack", "KillMailLostStackBPC", "KillMailLostItemBPC", "KillMailItemLocation", "InContainer"];
const itemLocations = {
  cargo: "UI/Generic/Cargo", drone: "UI/Common/DroneBay", implant: "UI/Common/Implant", other: "UI/Common/Other",
};

export const COMBAT_REPORT_WORDS = [
  "UI/Common/Unknown", "UI/Common/None", ...mailLabels.map(key => mailPath + key), ...Object.values(itemLocations),
];

export function combatReportNameRefs(reports: readonly CombatLogReport[]): NameRef[] {
  const refs: NameRef[] = [];
  const add = (kind: NameRef["kind"], ...ids: (number | null)[]) => {
    for (const id of ids) if (id) refs.push({ kind, id });
  };
  for (const row of reports) {
    add("owner", row.victimCharacterID, row.victimCorporationID, row.victimAllianceID, row.victimFactionID,
      row.finalCharacterID, row.finalCorporationID, row.finalAllianceID);
    add("type", row.victimShipTypeID, row.finalShipTypeID, row.finalWeaponTypeID);
    add("system", row.solarSystemID);
    add("evelocation", row.moonID);
    const { attackers, items } = combatReportDetails(row);
    for (const each of attackers) {
      add("owner", each.characterID, each.corporationID, each.allianceID, each.factionID);
      add("type", each.shipTypeID, each.weaponTypeID);
    }
    add("type", ...items.map(item => item.typeID));
  }

  return refs;
}

export function combatReportDate(row: CombatLogReport): string {
  return row.killTime === null ? "" : plainText(formatTemplate(
    "{[datetime]datetime, time=long}", { datetime: String(row.killTime) }, { nameOf: () => "" }));
}

export function combatReportText(row: CombatLogReport, names: NamesState, words: WordsState["templates"]): string {
  const name = (kind: NameRef["kind"], id: number | null) => id ? resolvedName(names.resolved, kind, id, "") : "";
  const owner = (id: number | null) => name("owner", id);
  const type = (id: number | null) => name("type", id);
  const word = (label: string, fallback: string) => plainText(words[label] || fallback);
  const unknown = word("UI/Common/Unknown", "Unknown");
  const attacker = (row: ReturnType<typeof combatReportDetails>["attackers"][number]) =>
    owner(row.characterID) || type(row.shipTypeID) || owner(row.corporationID) || unknown;
  const mail = (label: string, fallback: string, values: Record<string, JsonValue>) =>
    formatTemplate(words[mailPath + label] || fallback, values, { nameOf: name });
  const { attackers, items } = combatReportDetails(row);
  const sec = row.solarSystemID ? names.systemSecurity[row.solarSystemID] ?? null : null;
  const header = mail(row.victimCharacterID ? "KillMailHeaderWithShip" : "KillMailHeaderWithStructure",
    (row.victimCharacterID ? "Victim: {[character]victim.name}<br>" : "") +
    "Corp: {corporation}<br>Alliance: {alliance}<br>Faction: {faction}<br>Destroyed: {[item]target.name}<br>" +
    "System: {[location]system.name}<br>Security: {security}<br>Moon: {moon}<br>Damage Taken: {damage}<br>", {
      victim: row.victimCharacterID, corporation: owner(row.victimCorporationID) || unknown,
      alliance: owner(row.victimAllianceID) || unknown, faction: owner(row.victimFactionID) || unknown,
      target: row.victimShipTypeID, system: row.solarSystemID, security: sec === null ? null : shownSecurity(sec),
      moon: name("evelocation", row.moonID) || unknown, damage: row.damageTaken ?? 0,
    });
  const none = word("UI/Common/None", "None");
  const parties = attackers.map(each => mail(each.characterID
    ? each.final ? "KillMailPlayerAttackerWithFinalBlow" : "KillMailPlayerAttacker"
    : each.final ? "KillMailMPCAttackerWithFinalBlow" : "KillMailNPCAttacker",
    `Name: {attacker}${each.final ? " (laid the final blow)" : ""}<br>Corp: {corporation}<br>Ship: {ship}<br>Weapon: {weapon}<br>Damage Done: {damage}<br><br>`, {
      attacker: attacker(each), security: each.security, corporation: owner(each.corporationID) || unknown,
      alliance: owner(each.allianceID) || none, faction: owner(each.factionID) || none,
      ship: type(each.shipTypeID) || unknown, weapon: type(each.weaponTypeID) || unknown,
      owner: owner(each.corporationID) || unknown, damage: each.damage,
    })).join("");
  const itemText = (kind: "dropped" | "destroyed") => {
    const listing = items.filter(item => item[kind] > 0).map(item => {
      const location = item.contained ? mail("InContainer", "In Container", {}) :
        item.flag === 5 ? word(itemLocations.cargo, "Cargo") : item.flag === 87 ? word(itemLocations.drone, "Drone Bay")
        : item.flag === 89 ? word(itemLocations.implant, "Implant") :
          item.flag >= 11 && item.flag <= 34 || item.flag >= 92 && item.flag <= 99 ? "" : word(itemLocations.other, "Other");
      const itemLocation = location ? mail("KillMailItemLocation", " ({itemLocation})", { itemLocation: location }) : "";
      const quantity = item[kind];
      const label = item.singleton === 2 ? quantity > 1 ? "KillMailLostStackBPC" : "KillMailLostItemBPC"
        : quantity > 1 ? "KillMAilLostStack" : "KillMailLostItem";
      return (item.contained ? "<t>" : "") + mail(label, "{[item]item.name}, Qty: {quantity}{itemLocation}<br>",
        { item: item.typeID, quantity, itemLocation });
    }).join("");
    if (!listing) return "";
    return kind === "dropped" ? mail("KillMailDroppedItems", "Dropped items:<br>{droppedItems}", { droppedItems: listing })
      : mail("KillMailDestroyedItems", "Destroyed items:<br>{destroyedItems}", { destroyedItems: listing });
  };
  return mail("KillMail", "{timestamp}<br><br>{header}<br>Involved parties:<br><br>{attackers}{destroyedItems}{droppedItems}", {
    timestamp: combatReportDate(row), header, attackers: parties, destroyedItems: itemText("destroyed"), droppedItems: itemText("dropped"),
  }).replace(/[\r\n]/g, "").split(/<br\s*\/?>/i).map(line => plainText(line.replace(/<t>/gi, "   "))).join("\r\n");
}
