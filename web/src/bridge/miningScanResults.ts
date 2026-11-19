import { distanceMeters, surfaceDistanceMeters } from "../space/overview.ts";
import { SCAN_RANGE_M } from "../nav/surveyScan.ts";
import type { SpaceSnapshot, SurveyResult } from "../store/types.ts";

export const INTEGRATED_MINING_SCANNER = 5978;
export const MINING_SCANNER_UPGRADE = 5979;

export function miningScanInWarp(snapshot: SpaceSnapshot | null): boolean {
  const ship = snapshot?.ship;
  return ship?.mode === "WARP" || Boolean(ship?.warp && !ship.warp.preparing);
}

// Build 3698585's basic scan uses the distance to the far edge of the rock.
export function basicMiningScan(snapshot: SpaceSnapshot): SurveyResult[] {
  const ship = snapshot.ship;
  if (!snapshot.inSpace || !ship || ship.geometryAvailable === false) return [];
  return snapshot.entities.flatMap(entity => {
    const typeID = entity.miningYieldTypeID ?? entity.typeID;
    if (entity.geometryAvailable === false || typeID === null ||
        !(entity.miningYieldTypeID || entity.categoryID === 25 || entity.miningResourceFamily)) return [];
    const farEdge = distanceMeters(ship.position, entity.position) + entity.radius;
    return farEdge <= SCAN_RANGE_M ? [{ itemID: entity.itemID, yieldTypeID: typeID, remainingQuantity: null }] : [];
  });
}

export interface MiningScanTypeFacts {
  readonly groupID: number | null;
  readonly unitVolume: number | null;
  readonly unitPrice: number | null;
}

export function miningScanRows(
  survey: readonly SurveyResult[], snapshot: SpaceSnapshot | null,
  facts: ReadonlyMap<number, MiningScanTypeFacts>,
) {
  const ship = snapshot?.ship;
  if (!snapshot?.inSpace || !ship) return [];
  const entities = new Map(snapshot.entities.map(entity => [entity.itemID, entity]));
  return survey.flatMap(scan => {
    const entity = entities.get(scan.itemID);
    const typeID = scan.yieldTypeID ?? entity?.miningYieldTypeID ?? entity?.typeID;
    if (!entity || !typeID) return [];
    const info = facts.get(typeID);
    const quantity = scan.remainingQuantity;
    return [{
      itemID: scan.itemID, typeID, quantity,
      groupID: info?.groupID ?? entity.groupID,
      pricePerM3: entity.oreValuePerM3,
      volume: quantity === null || info?.unitVolume == null ? null : quantity * info.unitVolume,
      value: quantity === null || info?.unitPrice == null ? null : quantity * info.unitPrice,
      distance: ship.geometryAvailable === false || entity.geometryAvailable === false ? NaN
        : surfaceDistanceMeters(ship.position, ship.radius, entity.position, entity.radius),
    }];
  });
}
