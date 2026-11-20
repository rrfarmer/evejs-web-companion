import type { Colony, ColonyPin, ColonyPinKind } from "../store/types.ts";
import { applyPlanetLinkEdit, colonyBudgetError, colonyLinkBudget, planPlanetLinkEdits, type LinkEdit, type PlanetLinkFacts } from "./planetLinks.ts";
import { angularDistance, linkKey, validateRouteRemovals } from "./planetRouting.ts";
import { commandCenterUpgradeCommand, commandCenterUpgradeCost, commandCenterUpgradeError, type CommandCenterUpgrade,
  type CommandCenterUpgradeQuote } from "./commandCenterUpgrade.ts";
import { planetPinRef } from "./planetWrites.ts";
import type { JsonValue } from "./wire.ts";

export const INSTALLATION_GROUPS = [
  { id: 1063, name: "Extractor Control Units", kind: "extractor-control" },
  { id: 1028, name: "Processors", kind: "factory" },
  { id: 1029, name: "Storage Facilities", kind: "storage" },
  { id: 1030, name: "Launchpads", kind: "launchpad" },
] as const satisfies readonly { id: number; name: string; kind: ColonyPinKind }[];

// myPinManager.DistanceToOtherPinsOK compares the angular distance on the unit globe.
export const MIN_INSTALLATION_SPACING = 0.012;
export type SurfaceCoordinates = { readonly latitude: number; readonly longitude: number };

export interface InstallationType {
  readonly typeID: number;
  readonly typeName: string;
  readonly groupID: number;
  readonly kind: ColonyPinKind;
  readonly price: number;
  readonly cpu: number;
  readonly power: number;
  readonly area: number;
  readonly capacity: number | null;
  readonly missingSkills: readonly string[];
}

export interface ConstructionQuote {
  readonly options: readonly InstallationType[];
  readonly wallet: number;
}

export type Removal = ReturnType<typeof installationRemoval>;
export type PlanetLayoutEdit =
  | { readonly kind: "build"; readonly pin: ColonyPin & SurfaceCoordinates; readonly price: number }
  | { readonly kind: "remove"; readonly removal: Removal }
  | { readonly kind: "upgrade"; readonly upgrade: CommandCenterUpgrade }
  | { readonly kind: "link"; readonly link: LinkEdit };

export function installationRemoval(colony: Colony, pin: ColonyPin) {
  return {
    pinID: pin.pinID, typeID: pin.typeID, latitude: pin.latitude, longitude: pin.longitude,
    links: colony.links.filter(link => link.endpoint1 === pin.pinID || link.endpoint2 === pin.pinID),
    routes: colony.routes.filter(route => route.path.includes(pin.pinID)),
  };
}

export function draftInstallation(pinID: number, type: InstallationType, point: SurfaceCoordinates): ColonyPin & SurfaceCoordinates {
  return { pinID, typeID: type.typeID, typeName: type.typeName, kind: type.kind, ...point,
    contents: [], usedM3: type.capacity === null ? null : 0, capacityM3: type.capacity,
    schematicID: null, schematicName: null, hasReceivedInputs: null, receivedInputsLastCycle: null,
    active: false, lastRunAtMs: null, lastLaunchAtMs: null, program: null };
}

export function placementError(colony: Colony, point: SurfaceCoordinates): string {
  if (!Number.isFinite(point.latitude) || point.latitude < 0 || point.latitude > Math.PI
    || !Number.isFinite(point.longitude) || point.longitude < 0 || point.longitude >= Math.PI * 2) {
    return "Choose a point on the planet surface.";
  }
  return colony.pins.some(pin => angularDistance(pin, point) < MIN_INSTALLATION_SPACING)
    ? "This installation is too close to another installation." : "";
}

export function constructionError(colony: Colony, option: InstallationType, facts: PlanetLinkFacts, cost: number, wallet: number): string {
  if (option.missingSkills.length) return `Required skills: ${option.missingSkills.join(", ")}.`;
  if (cost + option.price > wallet) return "There is insufficient ISK for the pending construction.";
  return colonyBudgetError(colonyLinkBudget(colony, facts), option);
}

export function applyPlanetLayoutEdit(colony: Colony, edit: PlanetLayoutEdit): Colony {
  if (edit.kind === "link") return applyPlanetLinkEdit(colony, edit.link);
  if (edit.kind === "build") return { ...colony, pins: [...colony.pins, edit.pin] };
  if (edit.kind === "upgrade") return { ...colony, commandCenterLevel: edit.upgrade.level };
  const id = edit.removal.pinID;
  const links = colony.links.filter(link => link.endpoint1 !== id && link.endpoint2 !== id);
  return { ...colony, pins: colony.pins.filter(pin => pin.pinID !== id), links, linkCount: links.length,
    routes: colony.routes.filter(route => !route.path.includes(id)) };
}

function savedLinkLevels(links: Removal["links"]): string {
  return links.filter(link => link.endpoint1 > 0 && link.endpoint2 > 0)
    .map(link => `${linkKey(link.endpoint1, link.endpoint2)}:${link.level}`).sort().join("+");
}

export function planPlanetLayout(colony: Colony, edits: readonly PlanetLayoutEdit[], facts: PlanetLinkFacts,
  quote?: ConstructionQuote, upgradeQuote?: CommandCenterUpgradeQuote) {
  const commands: JsonValue[] = [];
  let cost = 0;
  for (const edit of edits) {
    if (edit.kind === "link") {
      const plan = planPlanetLinkEdits(colony, [edit.link], facts);
      colony = plan.colony;
      commands.push(...plan.commands);
      continue;
    }
    if (edit.kind === "upgrade") {
      const { pinID, previousLevel, level } = edit.upgrade;
      if (colony.commandCenterLevel !== previousLevel || !colony.pins.some(pin => pin.pinID === pinID && pin.kind === "command")) {
        throw new Error("The command centre changed. Review its current level before upgrading.");
      }
      if (!upgradeQuote) throw new Error("The command centre upgrade quote is unavailable.");
      const error = commandCenterUpgradeError(previousLevel, level, upgradeQuote, cost);
      if (error) throw new Error(error);
      cost += commandCenterUpgradeCost(previousLevel, level);
      commands.push(commandCenterUpgradeCommand(pinID, level));
      colony = applyPlanetLayoutEdit(colony, edit);
      continue;
    }
    if (edit.kind === "build") {
      const { pin, price } = edit;
      const option = quote?.options.find(option => option.typeID === pin.typeID);
      if (!quote || !option || option.price !== price) throw new Error("The construction quote changed. Review the installation again.");
      if (!Number.isSafeInteger(pin.pinID) || pin.pinID >= 0 || colony.pins.some(item => item.pinID === pin.pinID)) {
        throw new Error("The draft installation ID is invalid.");
      }
      const error = constructionError(colony, option, facts, cost, quote.wallet) || placementError(colony, pin);
      if (error) throw new Error(error);
      cost += price;
      commands.push([1, [planetPinRef(pin.pinID), pin.typeID, pin.latitude, pin.longitude]]);
    } else {
      const old = edit.removal;
      const pin = colony.pins.find(pin => pin.pinID === old.pinID);
      if (!pin || pin.kind === "command" || pin.typeID !== old.typeID || pin.latitude !== old.latitude || pin.longitude !== old.longitude) {
        throw new Error("The installation changed. Review it before decommissioning.");
      }
      const current = installationRemoval(colony, pin);
      if (savedLinkLevels(current.links) !== savedLinkLevels(old.links) || current.routes.length !== old.routes.length) {
        throw new Error("The installation's links or routes changed. Review it before decommissioning.");
      }
      validateRouteRemovals({ ...colony, routes: current.routes }, old.routes);
      for (const link of current.links) commands.push([4, [planetPinRef(link.endpoint1), planetPinRef(link.endpoint2)]]);
      commands.push([2, [old.pinID]]);
    }
    colony = applyPlanetLayoutEdit(colony, edit);
  }
  return { colony, commands };
}
