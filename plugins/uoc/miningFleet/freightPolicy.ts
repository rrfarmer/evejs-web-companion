import { acceptsMinedFreight, freightHoldFlags } from "../shared/freightHolds.ts";
import type { ManifestItem, FreightKind } from "./operation.ts";
import type { NativeInventoryRow } from "./nativeInventory.ts";

export const RAW_JETTISON_THRESHOLD = 0.9;
export const COMPRESSED_JETTISON_THRESHOLD = 0.5;
export type FreightFact = {
  categoryID: number;
  freightKind: FreightKind | null;
  unitVolumeM3: number;
  resourceFamily: "ore" | "ice" | null;
};
export type HoldCapacity = {
  key: string;
  present: boolean;
  capacity: { capacity: number; used: number };
  error?: unknown;
};
export type FreightSummary = {
  flagID: number;
  capacityM3: number;
  usedM3: number;
  rawM3: number;
  compressedM3: number;
  raw: ManifestItem[];
  compressed: ManifestItem[];
};
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** Native volumes and effective bay capacities; categories never share a numerator. */
export function summarizeFreight(
  rows: readonly Pick<
    NativeInventoryRow,
    "itemID" | "typeID" | "quantity" | "categoryID" | "flagID"
  >[],
  holds: readonly HoldCapacity[],
  facts: Readonly<Record<number, FreightFact>>,
  family: "ore" | "ice",
): FreightSummary[] {
  const seen = new Set<number>();
  if (
    rows.some(
      (r) =>
        !positive(r.itemID) ||
        seen.has(r.itemID) ||
        !seen.add(r.itemID) ||
        !positive(r.typeID) ||
        !positive(r.quantity),
    )
  )
    throw Error("Freight item identity is ambiguous.");
  const out: FreightSummary[] = [];
  for (const h of holds) {
    const flag = freightHoldFlags[h.key];
    if (!flag || !acceptsMinedFreight(flag, family)) continue;
    if (
      typeof h.present !== "boolean" ||
      h.error != null ||
      !h.capacity ||
      !Number.isFinite(h.capacity.capacity) ||
      !Number.isFinite(h.capacity.used) ||
      h.capacity.capacity < 0 ||
      h.capacity.used < 0 ||
      h.capacity.used > h.capacity.capacity
    )
      throw Error("Effective freight hold capacity is unknown.");
    if (!h.present) {
      if (rows.some((r) => r.flagID === flag)) throw Error("Absent bay contains physical items.");
      continue;
    }
    if (h.capacity.capacity <= 0) throw Error("Present freight bay has no usable capacity.");
    if (out.some((x) => x.flagID === flag)) throw Error("Freight bay is duplicated.");
    const summary: FreightSummary = {
      flagID: flag,
      capacityM3: h.capacity.capacity,
      usedM3: h.capacity.used,
      rawM3: 0,
      compressedM3: 0,
      raw: [],
      compressed: [],
    };
    for (const row of rows.filter((r) => r.flagID === flag)) {
      const f = facts[row.typeID];
      if (
        !f ||
        !positive(f.categoryID) ||
        (row.categoryID !== null && row.categoryID !== f.categoryID)
      )
        throw Error("Freight type metadata is unknown.");
      if (f.categoryID !== 25) continue;
      if (
        !f.freightKind ||
        f.resourceFamily !== family ||
        !Number.isFinite(f.unitVolumeM3) ||
        f.unitVolumeM3 <= 0
      )
        continue;
      const item: ManifestItem = {
          itemID: row.itemID,
          typeID: row.typeID,
          quantity: row.quantity,
          freightKind: f.freightKind,
          unitVolumeM3: f.unitVolumeM3,
        },
        volume = item.quantity * item.unitVolumeM3;
      if (!Number.isFinite(volume) || volume <= 0) throw Error("Freight volume is invalid.");
      if (f.freightKind === "RAW") {
        summary.raw.push(item);
        summary.rawM3 += volume;
      } else {
        summary.compressed.push(item);
        summary.compressedM3 += volume;
      }
    }
    if (summary.rawM3 + summary.compressedM3 > summary.usedM3 + 1e-6)
      throw Error("Native used volume contradicts the exact freight stacks.");
    out.push(summary);
  }
  return out;
}
/** Selects one category and whole stacks only; the native mutation layer handles any required split. */
export function selectFreight(
  summaries: readonly FreightSummary[],
  config: {
    flush: boolean;
    compressedThreshold?: number;
    rawThreshold?: number;
    canCapacityM3: number;
    includeCompressed?: boolean;
  },
): {
  category: FreightKind;
  items: ManifestItem[];
  volumeM3: number;
  oversize: ManifestItem[];
} | null {
  const compressed = config.compressedThreshold ?? COMPRESSED_JETTISON_THRESHOLD,
    raw = config.rawThreshold ?? RAW_JETTISON_THRESHOLD;
  if (
    ![compressed, raw].every((x) => Number.isFinite(x) && x > 0 && x <= 1) ||
    !Number.isFinite(config.canCapacityM3) ||
    config.canCapacityM3 <= 0
  )
    throw Error("Freight thresholds or can capacity are invalid.");
  const candidates: { category: FreightKind; items: ManifestItem[] }[] =
    config.includeCompressed === false
      ? []
      : summaries.flatMap((h) =>
          h.compressed.length &&
          (config.flush || h.compressedM3 + 1e-9 >= h.capacityM3 * compressed)
            ? [{ category: "COMPRESSED" as const, items: h.compressed }]
            : [],
        );
  candidates.push(
    ...summaries.flatMap((h) =>
      h.raw.length &&
      (config.flush ||
        h.rawM3 + 1e-9 >= h.capacityM3 * raw ||
        h.usedM3 + 1e-9 >= h.capacityM3 * raw)
        ? [{ category: "RAW" as const, items: h.raw }]
        : [],
    ),
  );
  const chosen = candidates[0];
  if (!chosen) return null;
  const items: ManifestItem[] = [],
    oversize: ManifestItem[] = [];
  let volumeM3 = 0;
  for (const item of chosen.items) {
    const volume = item.quantity * item.unitVolumeM3;
    if (volume > config.canCapacityM3 + 1e-9) {
      oversize.push(item);
      continue;
    }
    if (volumeM3 + volume <= config.canCapacityM3 + 1e-9) {
      items.push(item);
      volumeM3 += volume;
    }
  }
  return { category: chosen.category, items, volumeM3, oversize };
}

export type FreightStatus = {
  source: "native-ship-holds";
  observedAt: number;
  primaryHoldFlagID: number | null;
  holds: readonly {
    flagID: number;
    capacityM3: number;
    usedM3: number;
    rawM3: number;
    compressedM3: number;
    rawQuantity: number;
    compressedQuantity: number;
  }[];
  pendingCompression: boolean | null;
  facility: {
    fleetID?: number;
    minerSessionGeneration?: number;
    commanderSessionGeneration?: number;
    sourceTypeID?: number;
    compressedTypeID?: number;
    commanderCharacterID: number;
    commanderShipID: number;
    rangeMeters: number;
    surfaceDistanceMeters: number;
    observedAt: number;
    sceneSampledAt: number;
    systemID: number;
    claimKey: string;
    claimGeneration: number;
    coreModuleID: number;
    compressorModuleID: number;
    compressorEffectID: number;
    facilityTypeListIDs: readonly number[];
    matchingTypeListIDs: readonly number[];
  } | null;
};
