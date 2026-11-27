import { combatReportDetails, type CombatLogReport, type CombatReportItem } from "./combatLog.ts";

const groups = [
  { name: "HighPowerSlots", fallback: "High Power Slots", first: 27, last: 34 },
  { name: "MediumPowerSlots", fallback: "Medium Power Slots", first: 19, last: 26 },
  { name: "LowPowerSlots", fallback: "Low Power Slots", first: 11, last: 18 },
  { name: "RigSlots", fallback: "Rig Slots", first: 92, last: 99 },
  { name: "SubSystemSlots", fallback: "Subsystem Slots", first: 125, last: 132 },
  { name: "DeedSlot", fallback: "Deed Slot", first: 180, last: 180 },
  { name: "DroneBay", fallback: "Drone Bay", first: 87, last: 87 },
  { name: "CargoBay", fallback: "Cargo Bay", first: 5, last: 5 },
  { name: "Implants", fallback: "Implants", first: 89, last: 89 },
] as const;
const other = { name: "Other", fallback: "Other" } as const;

export const KILL_REPORT_PATH = "UI/Corporations/Wars/Killmails/";
export const KILL_REPORT_BREAKDOWN_WORDS = [
  ...groups.map(group => KILL_REPORT_PATH + group.name),
  ...["InvolvedParties", "TotalDamage", "FinalBlow", "TopDamage", "DamageDone", "FittingAndContent",
    "TotalWorth", "PendInsurance", "LPPaidOut", "BountyPaidOut", "KilledOnBehalf"].map(key => KILL_REPORT_PATH + key),
  "UI/Corporations/Assets/NoItemsFound", "UI/Common/Unknown", "UI/LPStore/AmountLP",
];

export interface CombatReportItemLine {
  readonly item: CombatReportItem;
  readonly result: "destroyed" | "dropped";
  readonly quantity: number;
  readonly depth: number;
}

function itemLines(items: readonly CombatReportItem[], depth = 0): CombatReportItemLine[] {
  return items.flatMap(item => (["destroyed", "dropped"] as const).flatMap(result => {
    const quantity = item[result];
    return quantity > 0 ? [{ item, result, quantity, depth }, ...itemLines(item.contents, depth + 1)] : [];
  }));
}

function mergeFittedStacks(items: readonly CombatReportItem[]): CombatReportItem[] {
  const byType = new Map<number, CombatReportItem>();
  for (const item of items) {
    const first = byType.get(item.typeID);
    byType.set(item.typeID, first ? { ...first, destroyed: first.destroyed + item.destroyed, dropped: first.dropped + item.dropped } : item);
  }
  return [...byType.values()];
}

export type CombatReportAttacker = ReturnType<typeof combatReportDetails>["attackers"][number];

export function combatReportBreakdown(report: CombatLogReport) {
  const { attackers, itemRoots } = combatReportDetails(report);
  const final: CombatReportAttacker | null = report.finalCharacterID || report.finalCorporationID || report.finalShipTypeID ? {
    final: true, characterID: report.finalCharacterID ?? 0, corporationID: report.finalCorporationID ?? 0,
    allianceID: report.finalAllianceID ?? 0, factionID: report.finalFactionID ?? 0, shipTypeID: report.finalShipTypeID ?? 0,
    weaponTypeID: report.finalWeaponTypeID ?? 0, damage: report.finalDamageDone ?? 0, security: String(report.finalSecurityStatus ?? 0),
  } : null;
  const top = attackers[0] ?? null;
  const others = attackers.slice(1).filter(attacker => !attacker.final);
  const parties = Number(final !== null) + Number(top !== null && (final === null ||
    Boolean(top.characterID && top.characterID !== final.characterID))) + others.length;
  const lists = new Map<string, CombatReportItem[]>();
  for (const item of itemRoots) {
    const key = groups.find(group => item.flag >= group.first && item.flag <= group.last)?.name ?? other.name;
    const list = lists.get(key);
    if (list) list.push(item); else lists.set(key, [item]);
  }
  const sections = [...groups, other].flatMap((group, index) => {
    const list = lists.get(group.name);
    if (!list) return [];
    const lines = itemLines(index < 6 ? mergeFittedStacks(list) : list);
    return lines.length ? [{ name: group.name, fallback: group.fallback, lines }] : [];
  });
  return { final, top, others, parties, sections };
}
