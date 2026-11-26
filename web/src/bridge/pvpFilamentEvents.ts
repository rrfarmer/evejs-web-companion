import { isListValue, readDictEntry, readDictPairs, readKeyVal, readPlainJsonField, unwrapLong } from "./wire.ts";

export interface PvPEvent {
  matchTypeID: number;
  scheduleID: number;
  filamentTypeID: number;
  nameID: number;
  descriptionID: number;
  rulesID: number;
  restrictionsID: number;
  rewardsHintID: number;
  start: Date | null;
  end: Date | null;
  qa: boolean;
  rewards: { typeID: number; amount: number }[];
}

export function eventInteger(value: unknown): number {
  const numeric = unwrapLong(value);
  return numeric !== null && numeric >= 0 && numeric <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(numeric) : 0;
}

export function eventDate(value: unknown): Date | null {
  const header = readPlainJsonField(value, "header");
  if (!Array.isArray(header) || readPlainJsonField(header[0], "value") !== "datetime.date") return null;
  const args = header[1];
  if (!Array.isArray(args)) return null;
  const bytes = readPlainJsonField(args[0], "value") ?? args[0];
  const data = Array.isArray(bytes) ? bytes : readPlainJsonField(bytes, "data");
  if (!Array.isArray(data) || data.length !== 4 ||
      !data.every(part => typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 255)) return null;
  const [high, low, month, day] = data as unknown as [number, number, number, number];
  const year = high * 256 + low;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function pvpEventOf(value: unknown): PvPEvent | null {
  const field = (key: string) => readKeyVal(value, key) ?? readDictEntry(value, key);
  const number = (key: string) => eventInteger(field(key));
  const matchTypeID = number("matchTypeID"), scheduleID = number("scheduleID"), filamentTypeID = number("filamentTypeID");
  if (!matchTypeID || !scheduleID || !filamentTypeID) return null;
  const rewards = field("rewards");
  return {
    matchTypeID, scheduleID, filamentTypeID,
    nameID: number("eventNameID"), descriptionID: number("eventDescriptionID"), rulesID: number("rulesHintID"),
    restrictionsID: number("shipRestrictionsHintID"), rewardsHintID: number("rewardsHintID"),
    start: eventDate(field("startDate")), end: eventDate(field("endDate")), qa: number("QA") !== 0 || field("QA") === true,
    rewards: isListValue(rewards) ? rewards.items.flatMap(row => {
      const typeID = eventInteger(readKeyVal(row, "typeID") ?? readDictEntry(row, "typeID"));
      const amount = eventInteger(readKeyVal(row, "amount") ?? readDictEntry(row, "amount"));
      return typeID && amount ? [{ typeID, amount }] : [];
    }) : [],
  };
}

export function activePvpEvents(value: unknown): PvPEvent[] {
  return readDictPairs(value).flatMap(([, entry]) => {
    const event = pvpEventOf(entry);
    return event && !event.qa ? [event] : [];
  }).sort((a, b) => (a.start?.getTime() ?? Infinity) - (b.start?.getTime() ?? Infinity));
}
