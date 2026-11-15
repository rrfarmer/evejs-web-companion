import { isListValue, readDictEntry, readDictPairs, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";

export const WARZONE_STAT_ROWS = {
  pilots: "Pilots",
  killsY: "Stats/KillsYesterday",
  killsLW: "Stats/KillsLastWeek",
  killsTotal: "Stats/KillsTotal",
  vpY: "Stats/VictoryPointsYesterday",
  vpLW: "Stats/VictoryPointsLastWeek",
  vpTotal: "Stats/VictoryPointsTotal",
  systems: "Stats/SystemsControlled",
} as const;
export type WarzoneMetric = keyof typeof WARZONE_STAT_ROWS;
export type WarzoneStatisticsScope = "personal" | "corp" | "alliance" | "militia";
export interface WarzoneStatistics {
  readonly headers: readonly (string | number)[];
  readonly rows: readonly { metric: WarzoneMetric; values: readonly number[] }[];
}

const periods = ["killsY", "killsLW", "killsTotal", "vpY", "vpLW", "vpTotal"] as const;
const groups = { personal: 1, corp: 2, alliance: 32 } as const;
const numeric = (value: JsonValue | undefined): number => Number(unwrapLong(value) ?? 0n);
const dictNumber = (value: JsonValue | undefined, id: number) => readDictPairs(value).find(([key]) => Number(key) === id)?.[1];

export function warzoneStatistics(scope: WarzoneStatisticsScope, own: JsonValue, comparison: JsonValue,
  factionInfo: JsonValue, factionID: number | null, corporationMembers: number | null): WarzoneStatistics {
  const count = (row: JsonValue | undefined, key: string) => numeric(readKeyVal(row, key));
  if (scope === "militia") {
    const header = readDictEntry(own, "header");
    const headers = (isListValue(header) ? header.items : Array.isArray(header) ? header : []).filter((id): id is number => typeof id === "number");
    if (!headers.length) throw new Error("Militia statistics are unavailable.");
    const data = readDictEntry(own, "data");
    return { headers, rows: [
      { metric: "pilots", values: headers.map(id => count(dictNumber(factionInfo, id), "totalMembersCount")) },
      ...periods.map(metric => ({ metric, values: headers.map(id => numeric(dictNumber(readDictEntry(data, metric), id))) })),
      { metric: "systems", values: headers.map(id => count(dictNumber(factionInfo, id), "systemsCount")) },
    ] };
  }
  if (own === null || !Array.isArray(comparison) || comparison.length !== 2) throw new Error("Factional warfare statistics are unavailable.");
  const group = groups[scope];
  const top = dictNumber(comparison[0], group), all = dictNumber(comparison[1], group);
  const rows: WarzoneStatistics["rows"][number][] = periods.map(metric => ({ metric, values: [own, top, all].map(value => numeric(readDictEntry(value, metric))) }));
  if (scope === "corp") {
    const info = readDictPairs(factionInfo).map(([, row]) => row);
    rows.unshift({ metric: "pilots", values: [
      corporationMembers ?? count(dictNumber(factionInfo, factionID ?? 0), "militiaMembersCount"),
      Math.max(0, ...info.map(row => count(row, "topMemberCount"))),
      info.reduce<number>((total, row) => total + count(row, "totalMembersCount"), 0),
    ] });
  }
  return { headers: [scope === "personal" ? "You" : "Your", "Top", "All"], rows };
}
