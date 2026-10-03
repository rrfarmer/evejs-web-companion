import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
import { slotFlagOf, type ChargeFitment } from "../bridge/fitting.ts";
import type { FittingSlot } from "../store/types.ts";
import type { CombatAmmo, CombatWeapons } from "./combatWeapons.ts";

/** Turrets/launchers cycle through speed (51); tank modules use duration (73). */
export function weaponHasCycle(dogma: BoundDogmaAllInfo | null, itemID: number): boolean {
  const entry = dogma?.ships.find(row => Number(row.itemID) === itemID);
  return entry?.attributes.some(row => [51, 73].includes(row.attributeID) && typeof row.value === "number" && row.value > 0) === true;
}

/** Only fresh, ship-scoped effective attributes authorize weapon reach. */
export function combatFit(shipID: number, slots: readonly FittingSlot[],
  weaponIDs: readonly number[], fits: Readonly<Record<number, ChargeFitment>>,
  dogma: BoundDogmaAllInfo | null, cargo: readonly CombatAmmo[] | null): CombatWeapons {
  const scoped = dogma !== null && Number(dogma.activeShipID) === shipID ? dogma : null;
  const attr = (id: number, entry: DogmaItemInfo | undefined) => {
    const value = entry?.attributes.find(row => row.attributeID === id)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return { shipID, cargo, weapons: slots.flatMap(slot => {
    const module = slot.module;
    if (!module?.online || !weaponIDs.includes(module.itemID)) return [];
    const info = scoped?.ships.find(row => Number(row.itemID) === module.itemID &&
      row.typeID === module.typeID && Number(row.locationID) === shipID &&
      row.flagID === slotFlagOf(slot.family, slot.index));
    const charge = scoped?.ships.find(row => row.sublocation?.[0] === shipID &&
      row.sublocation[1] === slotFlagOf(slot.family, slot.index) && row.typeID === module.charge?.typeID);
    const optimal = attr(54, info), falloff = attr(158, info), tracking = attr(160, info);
    const velocity = attr(37, charge), flightMS = attr(281, charge);
    const turret = tracking !== null && tracking > 0;
    const reachM = charge != null && turret && optimal !== null && optimal > 0 && falloff !== null && falloff >= 0
      ? optimal + falloff : info != null && !turret && velocity !== null && velocity > 0 && flightMS !== null && flightMS > 0
      ? velocity * flightMS / 1000 : null;
    return [{ itemID: module.itemID, typeID: module.typeID,
      chargeTypeID: module.charge?.typeID ?? null, chargeQuantity: module.charge?.quantity ?? 0,
      acceptedGroups: fits[module.typeID]?.groups ?? null, chargeSize: fits[module.typeID]?.size ?? null,
      reachM, tracking }];
  }) };
}
