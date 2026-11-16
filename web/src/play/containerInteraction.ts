import { MIN_WARP_DISTANCE } from "../bridge/probeResults.ts";

export const OPEN_CARGO_LABEL = "UI/Commands/OpenCargo";
export const OPEN_CARGO_ICON = "res:/UI/Texture/icons/44_32_35.png";

const MISSION_CONTAINER_GROUP = 952;

// Installed spacecomponentsbytype 3698585, itemTrader types among container groups.
const containerTraders = new Set([34498, 34499, 34500, 34501, 34502, 36903, 36904, 36905, 36906, 36907, 40542]);

interface CargoTarget {
  readonly kind: string;
  readonly groupID: number | null;
  readonly typeID: number | null;
}

function isContainer(target: CargoTarget): boolean {
  return target.kind === "container" || target.kind === "wreck";
}

/** selectedItemConst declares the button. OfferOpenCargo determines if it is enabled. */
export function selectedCargo(target: CargoTarget, warping: boolean): "hidden" | "disabled" | "enabled" {
  if (!isContainer(target)) return "hidden";
  return warping || (target.typeID !== null && containerTraders.has(target.typeID)) ? "disabled" : "enabled";
}

/** menusvc.Activate checks surface distance before opening the cargo of a non-mission container. */
export function activateCargoTarget(target: CargoTarget, distance: number): "open" | "approach" | "align" {
  if (!isContainer(target)) return "approach";
  if (distance >= MIN_WARP_DISTANCE) return "align";
  return target.groupID === MISSION_CONTAINER_GROUP ? "approach" : "open";
}
