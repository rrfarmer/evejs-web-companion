import { distanceMeters, surfaceDistanceMeters } from "../space/overview.ts";
import { SCAN_RANGE_M } from "../nav/surveyScan.ts";
import type { MiningExtraction, SpaceSnapshot, SurveyResult } from "../store/types.ts";
import { readDictEntry, readKeyVal, unwrapLong } from "./wire.ts";

export const INTEGRATED_MINING_SCANNER = 5978;
export const MINING_SCANNER_UPGRADE = 5979;

export function miningSurveyDepletion(
  method: "OnOreMined" | "OnOreMinedByOther",
  args: readonly unknown[],
  atMs: number,
): { itemID: number; quantity: number; extraction: MiningExtraction | null } | null {
  const integer = (value: unknown) => Number(unwrapLong(value) ?? NaN);
  const field = (key: string) => readDictEntry(args[0], key) ?? readKeyVal(args[0], key);
  const ownCycle = method === "OnOreMined";
  const itemID = integer(ownCycle ? field("itemID") : args[0]);
  const yieldAmount = integer(ownCycle ? field("quantity_removed") : args[1]);
  // The native survey subtracts yield and residue. Critical bonus is credited to the hold.
  const residue = ownCycle ? integer(field("amountWasted") ?? 0) : 0;
  const bonus = ownCycle ? integer(field("amountCritBonus") ?? 0) : 0;
  const criticalQuantity = Number.isSafeInteger(bonus) && bonus > 0 ? bonus : 0;
  const quantity = yieldAmount + residue;
  if (!Number.isSafeInteger(itemID) || itemID <= 0 ||
      !Number.isSafeInteger(yieldAmount) || yieldAmount < 0 ||
      !Number.isSafeInteger(residue) || residue < 0 ||
      !Number.isSafeInteger(quantity) || (!quantity && !criticalQuantity)) return null;
  const extraction = ownCycle ? { atMs, yieldQuantity: yieldAmount, residueQuantity: residue, criticalQuantity } : null;
  return { itemID, quantity, extraction };
}

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

const units = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const isk = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

// A selected harvestable shows estimated value after either scan. A lock gives the exact quantity.
/** eveFormat.RoundISK: an ISK amount to the precision the client shows it at. */
export function roundIsk(v: number): number {
  const at = v < 10 ? 2 : v < 100 ? 1 : v < 1e3 ? 0 : v < 1e4 ? -1 : v < 1e5 ? -2 : v < 1e6 ? -3 : v < 1e7 ? -4 : v < 1e8 ? -5 : -6;
  const f = 10 ** at;
  return Math.round(v * f) / f;
}
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** FmtISKAndRound(price, False): the ISK rounded as the client rounds it, whole, with " ISK". */
export function iskAndRound(price: number): string {
  return `${whole.format(Math.round(roundIsk(price)))} ISK`;
}
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ExpandedBracketAsteroid's lines (read through gridcheck): Value as mining_util.get_volume_est_price_formatted
 * (UI/Shared/EstimatedPricePerSquareMeter of FmtISKAndRound(price, False): '53 ISK / m³'), Total Value FmtISK of the
 * unit price times the quantity ('5,280.00 ISK'), Quantity UI/Shared/NumberOfUnits for a locked rock ('1,234 Units'), else
 * UI/Mining/EstNumberOfUnits of it rounded to hundreds (under 1,000) or thousands ('Approx. 1,000 Units').
 */
export function miningBracketReadout(
  scan: SurveyResult,
  locked: boolean,
  pricePerM3: number | null,
  unitVolume: number | null,
): string[] {
  const details = [pricePerM3 !== null && pricePerM3 > 0 ? `Value ${whole.format(Math.round(roundIsk(pricePerM3)))} ISK / m³` : "Value Unknown"];
  const quantity = scan.remainingQuantity;
  if (quantity === null || quantity <= 0) return details;
  if (pricePerM3 !== null && pricePerM3 > 0 && unitVolume !== null && unitVolume > 0) {
    details.push(`Total Value ${cents.format(pricePerM3 * unitVolume * quantity)} ISK`);
  }
  const step = quantity < 1_000 ? 100 : 1_000;
  const amount = locked ? `${whole.format(quantity)} Units` : `Approx. ${whole.format(Math.round(quantity / step) * step)} Units`;
  details.push(`Quantity ${amount}`);
  return details;
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
