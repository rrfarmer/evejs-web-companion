import { acceptsMinedFreight, haulerInventoryFlags } from "../shared/freightHolds.ts";
import type { Manifest } from "./operation.ts";
import { pickupHoldMatches, pickupItems, type NativeHaulSourceProof } from "./nativeHauler.ts";

type Item = {
  itemID: number;
  typeID: number;
  quantity: number;
  ownerID?: number;
  locationID?: number;
  flagID?: number;
};
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const point = (p: any) => !!p && [p.x, p.y, p.z].every(Number.isFinite);
const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function itemMap(rows: readonly Item[]) {
  if (!Array.isArray(rows)) return null;
  const result = new Map<number, Item>();
  for (const r of rows) {
    if (
      !r ||
      !positive(r.itemID) ||
      !positive(r.typeID) ||
      !positive(r.quantity) ||
      result.has(r.itemID)
    )
      return null;
    result.set(r.itemID, r);
  }
  return result;
}
const sameItems = (a: Map<number, Item>, b: Map<number, Item>) =>
  a.size === b.size &&
  [...a].every(([id, r]) => {
    const s = b.get(id);
    return s?.typeID === r.typeID && s.quantity === r.quantity;
  });
function typeTotals(rows: readonly Item[]) {
  const result = new Map<number, number>();
  for (const r of rows) {
    const n = (result.get(r.typeID) ?? 0) + r.quantity;
    if (!Number.isSafeInteger(n)) return null;
    result.set(r.typeID, n);
  }
  return result;
}
const sameTotals = (a: Map<number, number>, b: Map<number, number>) =>
  a.size === b.size && [...a].every(([id, n]) => b.get(id) === n);

/** Source consumption can be proved by full physical item relocation without inventing an empty-container read. */
export function provesHaulSource(
  manifest: Manifest,
  haulerID: number,
  shipID: number,
  proof: NativeHaulSourceProof,
  completedAt: number,
): boolean {
  const original = itemMap(manifest.items);
  if (!original || !positive(haulerID) || !positive(shipID) || !proof) return false;
  const ownHold = (rows: readonly Item[]) =>
    !!itemMap(rows) &&
    rows.every(
      (r) =>
        r.ownerID === haulerID &&
        r.locationID === shipID &&
        haulerInventoryFlags.includes(r.flagID!),
    );
  const eligibleFlag = (flag: number | undefined) =>
    acceptsMinedFreight(flag, manifest.targetKey.startsWith("ICE:") ? "ice" : "ore");
  const eligible = (r: Item) => eligibleFlag(r.flagID);
  const sourceRows = (rows: readonly Item[]) =>
    !!itemMap(rows) &&
    rows.every((r) => r.ownerID === manifest.characterID && r.locationID === manifest.containerID);
  if (proof.kind === "relocated-manifest-items") {
    const actual = itemMap(proof.items);
    return (
      !!actual &&
      ownHold(proof.items) &&
      proof.items.every(eligible) &&
      sameItems(original, actual) &&
      Number.isFinite(proof.observedAt) &&
      proof.observedAt >= manifest.observedAt &&
      proof.observedAt <= completedAt
    );
  }
  if (proof.kind !== "native-batches" || !Array.isArray(proof.batches) || !proof.batches.length)
    return false;
  let remaining = original;
  for (const b of proof.batches) {
    if (!b || typeof b !== "object") return false;
    const before = itemMap(b.sourceBefore);
    if (
      !before ||
      !sourceRows(b.sourceBefore) ||
      !sameItems(remaining, before) ||
      !positive(b.quantity)
    )
      return false;
    if (b.items) {
      if (
        !positive(b.flagID) ||
        !ownHold(b.shipBefore) ||
        !ownHold(b.shipAfter) ||
        !eligibleFlag(b.flagID) ||
        !pickupHoldMatches(b, b.flagID)
      )
        return false;
    } else {
      const row = before.get(b.itemID);
      if (
        !row ||
        row.typeID !== b.typeID ||
        b.quantity > row.quantity ||
        !ownHold(b.shipBefore) ||
        !ownHold(b.shipAfter) ||
        b.shipAfter.some(
          (r: Item) =>
            r.typeID === b.typeID &&
            !eligible(r) &&
            !b.shipBefore.some(
              (s: Item) =>
                s.itemID === r.itemID &&
                s.typeID === r.typeID &&
                s.flagID === r.flagID &&
                s.quantity === r.quantity,
            ),
        )
      )
        return false;
      const expectedShip = typeTotals(b.shipBefore),
        actualShip = typeTotals(b.shipAfter);
      if (!expectedShip || !actualShip) return false;
      const total = (expectedShip.get(b.typeID) ?? 0) + b.quantity;
      if (!Number.isSafeInteger(total)) return false;
      expectedShip.set(b.typeID, total);
      if (!sameTotals(expectedShip, actualShip)) return false;
    }
    remaining = new Map(before);
    const items = pickupItems(b),
      ids = new Set<number>();
    if (!items.length) return false;
    for (const item of items) {
      if (!item || !positive(item.quantity) || ids.has(item.itemID)) return false;
      const row = remaining.get(item.itemID);
      if (!row || row.typeID !== item.typeID || row.quantity < item.quantity) return false;
      ids.add(item.itemID);
      if (row.quantity === item.quantity) remaining.delete(row.itemID);
      else remaining.set(row.itemID, { ...row, quantity: row.quantity - item.quantity });
    }
    if (b.sourceAfter !== null) {
      const after = itemMap(b.sourceAfter);
      if (
        !after ||
        !sourceRows(b.sourceAfter) ||
        !sameItems(remaining, after) ||
        b.canAbsence !== null
      )
        return false;
    } else {
      const a = b.canAbsence;
      if (
        remaining.size ||
        !a ||
        a.kind !== "can-absent" ||
        a.containerID !== manifest.containerID ||
        a.systemID !== manifest.systemID ||
        a.shipID !== shipID ||
        a.canOwnerID !== manifest.characterID ||
        a.canKind !== "container" ||
        !point(a.transferCan?.position) ||
        !point(a.transferShip?.position) ||
        !point(a.postShip?.position) ||
        ![a.transferCan.radius, a.transferShip.radius, a.postShip.radius].every(
          (n) => Number.isFinite(n) && n >= 0,
        ) ||
        !Number.isFinite(a.transferSampledAt) ||
        !Number.isFinite(a.postSampledAt) ||
        a.postSampledAt <= a.transferSampledAt ||
        distance(a.transferShip.position, a.transferCan.position) -
          a.transferShip.radius -
          a.transferCan.radius >
          2000 ||
        distance(a.postShip.position, a.transferCan.position) -
          a.postShip.radius -
          a.transferCan.radius >
          2000
      )
        return false;
    }
  }
  return remaining.size === 0;
}
