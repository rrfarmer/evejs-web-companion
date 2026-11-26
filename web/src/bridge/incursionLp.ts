import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readKeyVal, unwrapLong } from "./wire.ts";

export const INCURSION_LP = {
  stored: 312, paid: 313, lost: 314, disqualified: 315, direct: 471,
} as const;

export interface IncursionLpRow {
  date: bigint;
  dateMs: number;
  tale: number;
  system: number;
  reward: number;
  event: number;
  message: string;
  encounter: string;
  players: number;
  reason: number;
  detail: number;
  stored: number;
  paid: number;
}

export function decodeIncursionLp(value: unknown): IncursionLpRow[] {
  if (!isListValue(value)) throw new Error("Invalid Incursion Loyalty Point Log");
  return value.items.map(item => {
    const field = (key: string) => readKeyVal(item, key);
    const number = (key: string) => Number(unwrapLong(field(key)) ?? 0n);
    const date = unwrapLong(field("date"));
    const dateMs = filetimeToUnixMs(date);
    if (date === null || dateMs === null || Number.isNaN(new Date(dateMs).getTime())) {
      throw new Error("Invalid Incursion Loyalty Point Log date");
    }
    const message = field("rewardMessageKey");
    const messageID = unwrapLong(message);
    const rawEncounter = field("dungeonName");
    const encounter = rawEncounter && typeof rawEncounter === "object" && "type" in rawEncounter &&
      rawEncounter.type === "wstring" && "value" in rawEncounter ? rawEncounter.value : rawEncounter;
    return {
      date, dateMs, tale: number("taleID"), system: number("solarSystemID"), reward: number("rewardID"),
      event: number("eventTypeID"), players: number("numberOfPlayers"), reason: number("disqualifierType"),
      detail: number("disqualifierData"), stored: number("lpAmountAddedToPool"), paid: number("lpAmountPayedOut"),
      message: typeof message === "string" ? message : messageID === null ? "" : `#${messageID}`,
      encounter: typeof encounter === "string" ? encounter : "",
    };
  });
}
