import type { Colony, ColonyLink, ColonyPin, ColonyRoute } from "../store/types.ts";
import { angularDistance, validateRouteRemovals } from "./planetRouting.ts";
import { COMMAND_CENTER_LEVELS } from "./commandCenterUpgrade.ts";
import { planetPinRef } from "./planetWrites.ts";
import type { JsonValue } from "./wire.ts";

export const PLANET_LINK_TYPE_ID = 2280;
export const MAX_LINK_LEVEL = 10;

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

export const planetAttribute = (attributes: Attributes, id: number): number => attributes.find(([key]) => key === id)?.[1] ?? 0;

export function pinUsage(typeID: number, heads: number, facts: PlanetLinkFacts) {
  const attributes = facts[typeID]?.attributes;
  return attributes ? {
    cpu: Math.trunc(planetAttribute(attributes, 49)) + heads * planetAttribute(attributes, 1690),
    power: Math.trunc(planetAttribute(attributes, 15)) + heads * planetAttribute(attributes, 1691),
  } : null;
}

export function linkUsage(radius: number | undefined, a: Coordinates, b: Coordinates, level: number, facts: PlanetLinkFacts) {
  const attributes = facts[PLANET_LINK_TYPE_ID]?.attributes;
  const angle = angularDistance(a, b);
  if (!attributes || !radius || !Number.isFinite(angle)) return null;
  const km = angle * radius / 1000;
  return {
    km,
    cpu: Math.trunc(planetAttribute(attributes, 49)) + Math.ceil(planetAttribute(attributes, 1634) * km * (level + 1) ** planetAttribute(attributes, 1635)),
    power: Math.trunc(planetAttribute(attributes, 15)) + Math.ceil(planetAttribute(attributes, 1633) * km * (level + 1) ** planetAttribute(attributes, 1636)),
    bandwidth: planetAttribute(attributes, 1631) * 2 ** level,
  };
}

export function colonyLinkBudget(colony: Colony, facts: PlanetLinkFacts) {
  const output = COMMAND_CENTER_LEVELS[colony.commandCenterLevel];
  if (!output || !colony.pins.some(pin => pin.kind === "command")) return null;
  let cpu = 0, power = 0;
  const pins = new Map(colony.pins.map(pin => [pin.pinID, pin]));
  for (const pin of colony.pins) {
    if (pin.kind === "command") continue;
    const heads = pin.extractor?.heads?.length ?? pin.program?.heads?.length ?? 0;
    const usage = pinUsage(pin.typeID, heads, facts);
    if (!usage) return null;
    cpu += usage.cpu;
    power += usage.power;
  }
  for (const link of colony.links) {
    const a = pins.get(link.endpoint1), b = pins.get(link.endpoint2);
    const usage = a && b && linkUsage(colony.radius, a, b, link.level, facts);
    if (!usage) return null;
    cpu += usage.cpu;
    power += usage.power;
  }
  return { cpu, power, cpuSupply: output.cpu, powerSupply: output.power };
}

export function linkBudgetError(colony: Colony, link: ColonyLink, facts: PlanetLinkFacts): string {
  const a = colony.pins.find(pin => pin.pinID === link.endpoint1);
  const b = colony.pins.find(pin => pin.pinID === link.endpoint2);
  if (!a || !b || a === b) return "Choose two different installations.";
  const existing = linkInColony(colony, link);
  const current = existing && linkUsage(colony.radius, a, b, existing.level, facts);
  const target = linkUsage(colony.radius, a, b, link.level, facts);
  const budget = colonyLinkBudget(colony, facts);
  return colonyBudgetError(budget, target && { cpu: target.cpu - (current?.cpu ?? 0), power: target.power - (current?.power ?? 0) });
}

export function colonyBudgetError(budget: ReturnType<typeof colonyLinkBudget>, delta: { cpu: number; power: number } | null): string {
  if (!delta || !budget) return "Colony CPU and power data is unavailable.";
  if (budget.cpu + delta.cpu > budget.cpuSupply) return "The colony has insufficient CPU.";
  if (budget.power + delta.power > budget.powerSupply) return "The colony has insufficient power.";
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
      commands.push([4, [planetPinRef(endpoint1), planetPinRef(endpoint2)]]);
    } else {
      if (!Number.isInteger(level) || level > MAX_LINK_LEVEL || (previousLevel === null ? level !== 0 : level <= previousLevel)) {
        throw new Error("This link upgrade level is unavailable.");
      }
      const error = linkBudgetError(colony, { endpoint1, endpoint2, level }, facts);
      if (error) throw new Error(error);
      commands.push([previousLevel === null ? 3 : 5, [planetPinRef(endpoint1), planetPinRef(endpoint2), level]]);
    }
    colony = applyPlanetLinkEdit(colony, edit);
  }
  return { colony, commands };
}
