import type { Colony, ColonyLink, ColonyPin, ColonyRoute } from "../store/types.ts";
import { angularDistance, validateRouteRemovals } from "./planetRouting.ts";
import type { JsonValue } from "./wire.ts";

export const PLANET_LINK_TYPE_ID = 2280;
export const MAX_LINK_LEVEL = 10;

// planetCommon.COMMAND_CENTER_LEVELS, indexed by the colony's upgrade level.
const CPU_OUTPUT = [1675, 7057, 12136, 17215, 21315, 25415];
const POWER_OUTPUT = [6000, 9000, 12000, 15000, 17000, 19000];

type Coordinates = Pick<ColonyPin, "latitude" | "longitude">;
type Endpoints = Pick<ColonyLink, "endpoint1" | "endpoint2">;
type Attributes = readonly (readonly [number, number | null])[];
export type PlanetLinkFacts = Readonly<Record<number, { readonly attributes: Attributes } | null | undefined>>;

export interface LinkEdit extends Endpoints {
  readonly previousLevel: number | null;
  readonly level: number | null;
  readonly removedRoutes: readonly ColonyRoute[];
}

export function linkEndpoints(a: number, b: number): Endpoints {
  return { endpoint1: Math.min(a, b), endpoint2: Math.max(a, b) };
}

export function pathUsesLink(path: readonly number[], { endpoint1, endpoint2 }: Endpoints): boolean {
  return path.some((pin, index) => (pin === endpoint1 && path[index + 1] === endpoint2)
    || (pin === endpoint2 && path[index + 1] === endpoint1));
}

export function linkInColony(colony: Colony, { endpoint1, endpoint2 }: Endpoints): ColonyLink | undefined {
  return colony.links.find(link => pathUsesLink([endpoint1, endpoint2], link));
}

const attribute = (attributes: Attributes, id: number): number => attributes.find(([key]) => key === id)?.[1] ?? 0;

export function linkUsage(radius: number | undefined, a: Coordinates, b: Coordinates, level: number, facts: PlanetLinkFacts) {
  const attributes = facts[PLANET_LINK_TYPE_ID]?.attributes;
  const angle = angularDistance(a, b);
  if (!attributes || !radius || !Number.isFinite(angle)) return null;
  const km = angle * radius / 1000;
  return {
    km,
    cpu: Math.trunc(attribute(attributes, 49)) + Math.ceil(attribute(attributes, 1634) * km * (level + 1) ** attribute(attributes, 1635)),
    power: Math.trunc(attribute(attributes, 15)) + Math.ceil(attribute(attributes, 1633) * km * (level + 1) ** attribute(attributes, 1636)),
    bandwidth: attribute(attributes, 1631) * 2 ** level,
  };
}

export function colonyLinkBudget(colony: Colony, facts: PlanetLinkFacts) {
  const cpuSupply = CPU_OUTPUT[colony.commandCenterLevel];
  const powerSupply = POWER_OUTPUT[colony.commandCenterLevel];
  if (cpuSupply === undefined || powerSupply === undefined || !colony.pins.some(pin => pin.kind === "command")) return null;
  let cpu = 0, power = 0;
  const pins = new Map(colony.pins.map(pin => [pin.pinID, pin]));
  for (const pin of colony.pins) {
    if (pin.kind === "command") continue;
    const attributes = facts[pin.typeID]?.attributes;
    if (!attributes) return null;
    const heads = pin.extractor?.heads?.length ?? pin.program?.heads?.length ?? 0;
    cpu += Math.trunc(attribute(attributes, 49)) + heads * attribute(attributes, 1690);
    power += Math.trunc(attribute(attributes, 15)) + heads * attribute(attributes, 1691);
  }
  for (const link of colony.links) {
    const a = pins.get(link.endpoint1), b = pins.get(link.endpoint2);
    const usage = a && b && linkUsage(colony.radius, a, b, link.level, facts);
    if (!usage) return null;
    cpu += usage.cpu;
    power += usage.power;
  }
  return { cpu, power, cpuSupply, powerSupply };
}

export function linkBudgetError(colony: Colony, link: ColonyLink, facts: PlanetLinkFacts): string {
  const a = colony.pins.find(pin => pin.pinID === link.endpoint1);
  const b = colony.pins.find(pin => pin.pinID === link.endpoint2);
  if (!a || !b || a === b) return "Choose two different installations.";
  const existing = linkInColony(colony, link);
  const current = existing && linkUsage(colony.radius, a, b, existing.level, facts);
  const target = linkUsage(colony.radius, a, b, link.level, facts);
  const budget = colonyLinkBudget(colony, facts);
  if (!target || !budget) return "Colony CPU and power data is unavailable.";
  if (budget.cpu + target.cpu - (current?.cpu ?? 0) > budget.cpuSupply) return "The colony has insufficient CPU.";
  if (budget.power + target.power - (current?.power ?? 0) > budget.powerSupply) return "The colony has insufficient power.";
  return "";
}

/** Link removal also removes every route using that adjacent pair, in either direction. */
export function applyPlanetLinkEdit(colony: Colony, edit: LinkEdit): Colony {
  const links = colony.links.filter(link => !pathUsesLink([edit.endpoint1, edit.endpoint2], link));
  if (edit.level !== null) links.push({ endpoint1: edit.endpoint1, endpoint2: edit.endpoint2, level: edit.level });
  const routes = edit.level === null ? colony.routes.filter(route => !pathUsesLink(route.path, edit)) : colony.routes;
  return { ...colony, links, routes, linkCount: links.length };
}

export function planPlanetLinkEdits(colony: Colony, edits: readonly LinkEdit[], facts: PlanetLinkFacts) {
  const commands: JsonValue[] = [];
  for (const edit of edits) {
    const { endpoint1, endpoint2, level, previousLevel } = edit;
    if ((linkInColony(colony, edit)?.level ?? null) !== previousLevel) {
      throw new Error("A link changed. Cancel the colony edits and review the current links.");
    }
    if (level === null) {
      const routes = colony.routes.filter(route => pathUsesLink(route.path, edit));
      if (routes.length !== edit.removedRoutes.length) {
        throw new Error("The routes through this link changed. Review the link before removing it.");
      }
      validateRouteRemovals({ ...colony, routes }, edit.removedRoutes);
      commands.push([4, [endpoint1, endpoint2]]);
    } else {
      if (!Number.isInteger(level) || level > MAX_LINK_LEVEL || (previousLevel === null ? level !== 0 : level <= previousLevel)) {
        throw new Error("This link upgrade level is unavailable.");
      }
      const error = linkBudgetError(colony, { endpoint1, endpoint2, level }, facts);
      if (error) throw new Error(error);
      commands.push([previousLevel === null ? 3 : 5, [endpoint1, endpoint2, level]]);
    }
    colony = applyPlanetLinkEdit(colony, edit);
  }
  return { colony, commands };
}
