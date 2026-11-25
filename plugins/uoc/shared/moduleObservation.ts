import { readKeyVal, readRowField, isKeyValValue, unwrapReal, type JsonValue } from "./wire.ts";
import { exactInt } from "./dogma.ts";

export interface ModuleIdentity {
  moduleID: number;
  typeID: number;
  ownerID: number;
  shipID: number;
  flagID: number;
}
export interface ModuleEffect {
  effectID: number;
  targetID: number | null;
  startFiletime: string;
  durationMs: number;
  repeat: number;
}
export interface ModuleObservation extends ModuleIdentity {
  timeFiletime: string;
  wallclockFiletime: string;
  online: boolean;
  effects: readonly ModuleEffect[];
  activeTargets: readonly ModuleEffect[];
  attributes: Readonly<Record<number, number>> | null;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const filetime = (value: JsonValue | undefined): string | null => {
  // A bare unsafe JS number has already lost information; never round it.
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { readonly [key: string]: JsonValue })
      : null;
  if (obj?.type === "long" && typeof obj.value === "number" && !Number.isSafeInteger(obj.value))
    return null;
  const s = exactInt(value);
  if (s === null || !/^\d+$/.test(s)) return null;
  const n = BigInt(s);
  return n > 116444736000000000n && n <= 9223372036854775807n ? n.toString() : null;
};
/** Decode one native dogmaIM.ItemGetInfo result. Throws on any incomplete or contradictory snapshot. */
export function decodeModuleObservation(raw: unknown, expected: ModuleIdentity): ModuleObservation {
  const fail = (): never => {
    throw new Error("Native module snapshot is incomplete or does not match the held module.");
  };
  if (
    ![expected.moduleID, expected.typeID, expected.ownerID, expected.shipID, expected.flagID].every(
      positive,
    ) ||
    !isKeyValValue(raw)
  )
    return fail();
  const entries = raw.args.entries;
  if (
    entries.some((e) => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") ||
    new Set(entries.map((e) => e[0])).size !== entries.length
  )
    return fail();
  const item = readKeyVal(raw, "invItem");
  if (
    readKeyVal(raw, "itemID") !== expected.moduleID ||
    readRowField(item, "itemID") !== expected.moduleID ||
    readRowField(item, "typeID") !== expected.typeID ||
    readRowField(item, "ownerID") !== expected.ownerID ||
    readRowField(item, "locationID") !== expected.shipID ||
    readRowField(item, "flagID") !== expected.flagID
  )
    return fail();
  const timeFiletime = filetime(readKeyVal(raw, "time")),
    wallclockFiletime = filetime(readKeyVal(raw, "wallclockTime"));
  const candidate = readKeyVal(raw, "activeEffects");
  const map =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as { readonly [key: string]: JsonValue })
      : null;
  if (
    !timeFiletime ||
    !wallclockFiletime ||
    !map ||
    map.type !== "dict" ||
    !Array.isArray(map.entries)
  )
    return fail();
  const effects: ModuleEffect[] = [],
    seen = new Set<number>();
  for (const entry of map.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || !positive(entry[0]) || seen.has(entry[0]))
      return fail();
    const effectID = entry[0],
      tuple = entry[1];
    seen.add(effectID);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 10 ||
      tuple[0] !== expected.moduleID ||
      tuple[1] !== expected.ownerID ||
      tuple[2] !== expected.shipID ||
      !(tuple[3] === null || positive(tuple[3])) ||
      !Array.isArray(tuple[5]) ||
      tuple[6] !== effectID
    )
      return fail();
    const startFiletime = filetime(tuple[7]);
    const durationMs = tuple[8],
      repeat = tuple[9];
    if (
      !startFiletime ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < -1 ||
      typeof repeat !== "number" ||
      !Number.isSafeInteger(repeat) ||
      repeat < -1
    )
      return fail();
    effects.push({
      effectID,
      targetID: tuple[3] as number | null,
      startFiletime,
      durationMs,
      repeat,
    });
  }
  const value = readKeyVal(raw, "attributes"),
    nativeAttributes =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { readonly [key: string]: JsonValue })
        : null;
  let attributes: Record<number, number> | null = null;
  if (nativeAttributes?.type === "dict" && Array.isArray(nativeAttributes.entries)) {
    attributes = {};
    const ids = new Set<number>();
    for (const pair of nativeAttributes.entries) {
      if (!Array.isArray(pair) || pair.length !== 2 || !positive(pair[0]) || ids.has(pair[0])) {
        attributes = null;
        break;
      }
      ids.add(pair[0]);
      const value = unwrapReal(pair[1]);
      if (value !== null && Number.isFinite(value)) attributes[pair[0]] = value;
    }
  }
  return {
    ...expected,
    timeFiletime,
    wallclockFiletime,
    online: seen.has(16),
    effects,
    activeTargets: effects.filter((e) => e.effectID !== 16 && e.targetID !== null),
    attributes,
  };
}
