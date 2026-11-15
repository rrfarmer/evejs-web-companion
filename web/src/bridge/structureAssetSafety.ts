import { isListValue, readDictEntry, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";

export interface SafetyDestination {
  readonly itemID: number;
  readonly typeID: number;
  readonly solarSystemID: number;
  readonly name: string;
}

export interface SafetyWrap {
  readonly assetWrapID: number;
  readonly wrapName: string;
  readonly solarSystemID: number;
  readonly ejectTime: bigint;
  readonly daysUntilCanDeliver: number;
  readonly daysUntilAutoMove: number;
  readonly defaultDestination: SafetyDestination;
  readonly structureTypeID: number;
}

const field = (row: JsonValue, name: string): JsonValue => readKeyVal(row, name) ?? readDictEntry(row, name) ?? null;
const integer = (row: JsonValue, name: string): number => {
  const value = Number(unwrapLong(field(row, name)) ?? NaN);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Asset Safety returned an invalid ${name}.`);
  return value;
};
const string = (row: JsonValue, name: string): string => {
  const value = field(row, name);
  const text = value && typeof value === "object" && "value" in value ? value.value : value;
  return typeof text === "string" ? text : "";
};
const rows = (answer: JsonValue): readonly JsonValue[] => {
  if (isListValue(answer)) return answer.items;
  if (Array.isArray(answer)) return answer;
  throw new Error("Asset Safety did not return a list.");
};

export function readSafetyDestination(row: JsonValue): SafetyDestination {
  return { itemID: integer(row, "itemID"), typeID: integer(row, "typeID"), solarSystemID: integer(row, "solarSystemID"), name: string(row, "itemName") };
}

/** AssetSafetyDeliverWindow.ReloadContent takes a flat list in 24.02. */
export function readSafetyTargets(answer: JsonValue): SafetyDestination[] {
  return rows(answer).map(readSafetyDestination);
}

/** AssetSafetyEntry.ApplyAttributes reads 24.02's renamed timers and default destination. */
export function readSafetyWraps(answer: JsonValue): SafetyWrap[] {
  return rows(answer).map((row) => {
    const ejectTime = unwrapLong(field(row, "ejectTime"));
    if (ejectTime === null || ejectTime <= 0n) throw new Error("Asset Safety returned an invalid eject time.");
    return {
      assetWrapID: integer(row, "assetWrapID"), wrapName: string(row, "wrapName"), solarSystemID: integer(row, "solarSystemID"), ejectTime,
      daysUntilCanDeliver: integer(row, "daysUntilCanDeliver"), daysUntilAutoMove: integer(row, "daysUntilAutoMove"),
      defaultDestination: readSafetyDestination(field(row, "defaultDestinationInfo")), structureTypeID: integer(row, "structureTypeID"),
    };
  });
}

export const INSURGENCY_FOB_TYPES: readonly number[] = [78260, 79172];
export const ZARZAKH_SYSTEM_ID = 30100000;
