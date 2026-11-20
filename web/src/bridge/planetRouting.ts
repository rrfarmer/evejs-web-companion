import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";
import { isStorage, routedFrom } from "./colonyRoutes.ts";
import type { NewRoute } from "./planetWrites.ts";
import { commodityName, type PiRecipeBook } from "./piRecipes.ts";

const MAX_ROUTE_PINS = 7; // planetCommon.MAX_WAYPOINTS plus origin and destination.

export interface PlanetRouteFacts {
  readonly baseLinkBandwidth: number;
  readonly commodityVolumes: Readonly<Record<number, number | null>>;
}

export interface RouteEdits {
  readonly create: readonly NewRoute[];
  readonly remove: readonly ColonyRoute[];
}

export const linkKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const legs = (path: readonly number[]) => path.slice(1).map((id, index) => linkKey(path[index]!, id));

/** planetCommon.ItemIDToPinDesignator uses five digits from least to most significant. */
export function pinDesignator(id: number): string {
  if (id < 0) return `Pending ${-id}`;
  const alphabet = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const radix = alphabet.length - 1;
  const letters = Array.from({ length: 5 }, (_, place) => alphabet[Math.floor(id / radix ** place) % radix]);
  return letters.slice(0, 2).join("") + "-" + letters.slice(2).join("");
}

export function angularDistance(a: Pick<ColonyPin, "latitude" | "longitude">, b: Pick<ColonyPin, "latitude" | "longitude">): number {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return Infinity;
  const dot = Math.cos(a.latitude) * Math.cos(b.latitude)
    + Math.sin(a.latitude) * Math.sin(b.latitude) * Math.cos(a.longitude - b.longitude);
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** ClientColony.FindShortestPath uses point-to-point angular distance, without a bandwidth weight. */
export function appendPlanetWaypoint(colony: Colony, path: readonly number[], destination: number): number[] | null {
  const previous = path.indexOf(destination);
  if (previous >= 0) return path.slice(0, previous + 1);
  const start = path.at(-1);
  const pins = new Map(colony.pins.map(pin => [pin.pinID, pin]));
  if (start === undefined || !pins.has(start) || !pins.has(destination)) return null;
  const pending = new Map<number, { length: number; suffix: number[] }>([[start, { length: 0, suffix: [] }]]);
  const visited = new Set(path.slice(0, -1));
  while (pending.size) {
    const [id, best] = [...pending].reduce((a, b) => a[1].length <= b[1].length ? a : b);
    if (id === destination) return [...path, ...best.suffix];
    pending.delete(id);
    visited.add(id);
    for (const { endpoint1, endpoint2 } of colony.links) {
      const other = endpoint1 === id ? endpoint2 : endpoint2 === id ? endpoint1 : null;
      if (other === null || visited.has(other) || !pins.has(other)) continue;
      const length = best.length + angularDistance(pins.get(id)!, pins.get(other)!);
      if (length < (pending.get(other)?.length ?? Infinity)) pending.set(other, { length, suffix: [...best.suffix, other] });
    }
  }
  return null;
}

function recipeAt(pin: ColonyPin, recipes: PiRecipeBook) {
  return pin.kind === "factory" && pin.schematicID !== null ? recipes.bySchematicID.get(pin.schematicID) : undefined;
}

export function planetProduct(colony: Colony, pin: ColonyPin, recipes: PiRecipeBook) {
  const program = pin.program;
  const output = pin.kind === "extractor-control" && program && program.resourceTypeID > 0
    ? { typeID: program.resourceTypeID, typeName: program.resourceTypeName, quantity: program.maxOutputPerCycle ?? 0 }
    : recipeAt(pin, recipes)?.output;
  if (!output) return null;
  const routed = routedFrom(colony, pin.pinID, output.typeID);
  return {
    ...output,
    name: output.typeName ?? commodityName(recipes, output.typeID) ?? "Commodity",
    routed,
    available: Math.max(0, Math.floor(output.quantity - routed)),
  };
}

function cycleSeconds(pin: ColonyPin, recipes: PiRecipeBook): number | null {
  return pin.program?.cycleTimeSeconds || recipeAt(pin, recipes)?.cycleTimeSeconds || null;
}

function volumeRate(typeID: number, from: ColonyPin, to: ColonyPin, recipes: PiRecipeBook, facts: PlanetRouteFacts): number | null {
  const volume = facts.commodityVolumes[typeID];
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) return null;
  const seconds = cycleSeconds(isStorage(from) ? to : from, recipes);
  return seconds ? volume * 3600 / seconds : null;
}

export function routeBandwidth(colony: Colony, route: ColonyRoute, recipes: PiRecipeBook, facts: PlanetRouteFacts): number | null {
  const from = colony.pins.find(pin => pin.pinID === route.path[0]);
  const to = colony.pins.find(pin => pin.pinID === route.path.at(-1));
  const rate = from && to ? volumeRate(route.commodityTypeID, from, to, recipes, facts) : null;
  return rate === null ? null : rate * route.commodityQuantity;
}

export function quotePlanetRoute(colony: Colony, recipes: PiRecipeBook, facts: PlanetRouteFacts, path: readonly number[], typeID: number) {
  const problem = (error: string) => ({ error, max: 0, perUnit: 0, freeBandwidth: 0, cycle: 0 });
  if (path.length < 2) return problem("Select a destination on the planet.");
  if (path.length > MAX_ROUTE_PINS) return problem("A route can have up to five waypoints.");
  if (new Set(path).size !== path.length) return problem("A route cannot visit an installation twice.");
  const pins = new Map(colony.pins.map(pin => [pin.pinID, pin]));
  const from = pins.get(path[0]!), to = pins.get(path.at(-1)!);
  if (!from || !to) return problem("An installation on this route is unavailable.");
  const suppliesFromStorage = isStorage(from);
  const product = planetProduct(colony, from, recipes);
  if (!suppliesFromStorage && product?.typeID !== typeID) return problem("The source commodity is unavailable.");
  const input = recipeAt(to, recipes)?.inputs.find(ingredient => ingredient.typeID === typeID);
  if (suppliesFromStorage && !input) return problem(to.kind === "factory"
    ? "This processor cannot use the commodity." : "Recurring storage routes must feed a processor.");
  if (!input && !isStorage(to)) return problem("This destination cannot accept the commodity.");
  const cycle = cycleSeconds(suppliesFromStorage ? to : from, recipes);
  const perUnit = volumeRate(typeID, from, to, recipes, facts);
  if (!cycle || perUnit === null) return problem("The commodity volume or cycle time is unavailable.");
  const free = new Map(colony.links.map(link => [linkKey(link.endpoint1, link.endpoint2), facts.baseLinkBandwidth * 2 ** link.level]));
  const selectedLegs = legs(path);
  if (selectedLegs.some(key => !free.has(key))) return problem("A link on this route is missing.");
  const usedLegs = new Set(selectedLegs);
  for (const route of colony.routes) {
    const shared = legs(route.path).filter(key => usedLegs.has(key));
    if (!shared.length) continue;
    const bandwidth = routeBandwidth(colony, route, recipes, facts);
    if (bandwidth === null) return problem("The bandwidth of an existing route is unavailable.");
    for (const key of shared) free.set(key, free.get(key)! - bandwidth);
  }
  const freeBandwidth = Math.max(0, Math.min(...selectedLegs.map(key => free.get(key)!)));
  // A recurring storage route reserves an input batch even if the store has only part of one.
  const available = suppliesFromStorage ? Infinity : product?.available ?? 0;
  const max = Math.max(0, Math.min(available, input?.quantity ?? Infinity, Math.floor((freeBandwidth + 1e-9) / perUnit)));
  const error = max > 0 ? "" : available === 0 ? "All production is already routed." : "There is no capacity on this route.";
  return { error, max, perUnit, freeBandwidth, cycle };
}

export function previewPlanetRoute(colony: Colony, draft: NewRoute, index: number, recipes: PiRecipeBook): ColonyRoute {
  const source = colony.pins.find(pin => pin.pinID === draft.path[0]);
  const product = source && planetProduct(colony, source, recipes);
  const stock = source?.contents.find(item => item.typeID === draft.typeID);
  return { routeID: -index - 1, path: draft.path, commodityTypeID: draft.typeID,
    commodityTypeName: product?.name ?? stock?.typeName ?? commodityName(recipes, draft.typeID), commodityQuantity: draft.quantity };
}

export function validateRouteRemovals(colony: Colony, remove: readonly ColonyRoute[]): Colony {
  const removedIDs = new Set(remove.map(route => route.routeID));
  if (removedIDs.size !== remove.length || remove.some(expected => {
    const fresh = colony.routes.find(route => route.routeID === expected.routeID);
    return !fresh || fresh.commodityQuantity !== expected.commodityQuantity || fresh.commodityTypeID !== expected.commodityTypeID
      || fresh.path.join(",") !== expected.path.join(",");
  })) throw new Error("A route changed. Cancel the colony edits and review the current routes.");
  return { ...colony, routes: colony.routes.filter(route => !removedIDs.has(route.routeID)) };
}

export function validateNewRoutes(colony: Colony, recipes: PiRecipeBook, facts: PlanetRouteFacts, create: readonly NewRoute[]): void {
  let view = colony;
  for (const [index, route] of create.entries()) {
    const quote = quotePlanetRoute(view, recipes, facts, route.path, route.typeID);
    if (quote.error || !Number.isSafeInteger(route.quantity) || route.quantity < 1 || route.quantity > quote.max) {
      throw new Error(quote.error || "The route quantity exceeds the available output or link bandwidth.");
    }
    view = { ...view, routes: [...view.routes, previewPlanetRoute(view, route, index, recipes)] };
  }
}
