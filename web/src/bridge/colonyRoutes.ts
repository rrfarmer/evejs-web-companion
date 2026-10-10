// What a colony's routes carry, and how an extractor's routes are re-sized.
//
// ---------------------------------------------------------------------------
// THE GAME'S RULE, NOT OURS.
//
// The retail client calls an extractor settled only when the routes leaving
// it reserve its whole maximum cycle (colonyData.IsSomeProductUnrouted:
// routed < GetMaxOutput). Installing a program changes that maximum, and the
// retail client re-sizes the routes in the same edit (clientPlanet.
// InstallProgram): factory routes keep their former amounts, and whatever is
// left is shared among the storage routes in proportion to what each carried
// before. The emulator only ever TRIMS routes to a smaller program
// (repairEcuSourceRoutes); it never grows them. So a restart through the
// companion, which sends the install alone, leaves routes sized for the old
// program and the game shows the colony as needing attention.
//
// extractorReroute is that retail policy as a plan: which routes to remove
// and what to create in their place. It is sent after the restart has landed,
// because only then is the new maximum a number the server has stated.
//
// NOTHING HERE SIMULATES A COLONY. The maximum is the BFF's (the same
// arithmetic as the client's GetMaxOutput, on the server's own numbers).

import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";

/** Pins the retail client treats as storage (BasePin.IsStorage). */
function isStorage(pin: ColonyPin | undefined): boolean {
  return pin !== undefined && (pin.kind === "storage" || pin.kind === "launchpad" || pin.kind === "command");
}

function source(route: ColonyRoute): number | undefined {
  return route.path[0];
}

function destination(route: ColonyRoute): number | undefined {
  return route.path[route.path.length - 1];
}

/** How much of `typeID` the routes leaving `pinID` reserve each cycle. */
export function routedFrom(colony: Colony, pinID: number, typeID: number): number {
  return colony.routes
    .filter((route) => source(route) === pinID && route.commodityTypeID === typeID)
    .reduce((total, route) => total + route.commodityQuantity, 0);
}

/** Whether any route brings `typeID` into `pinID`. */
export function isRoutedInto(colony: Colony, pinID: number, typeID: number): boolean {
  return colony.routes.some((route) =>
    destination(route) === pinID && source(route) !== pinID && route.commodityTypeID === typeID);
}

/**
 * The commodities the colony's own factories are fed: every type a route
 * delivers into a factory. A launchpad holding one of these is holding a
 * factory's input, not a product, so a haul leaves it on the planet. That is
 * what lets a colony with no extractors keep its imports on the launchpad
 * beside what it makes from them.
 *
 * Mirrored by factoryInputTypeIDs in src/piCustomsExport.js, for the hop the
 * Haul button makes before the run starts.
 */
export function factoryInputTypeIDs(
  colony: Pick<Colony, "routes"> & { readonly pins: readonly Pick<ColonyPin, "pinID" | "kind">[] },
): readonly number[] {
  const factories = new Set(colony.pins.filter((pin) => pin.kind === "factory").map((pin) => pin.pinID));
  const inputs = new Set<number>();
  for (const route of colony.routes) {
    const into = destination(route);
    if (into !== undefined && factories.has(into) && route.commodityTypeID > 0) {
      inputs.add(route.commodityTypeID);
    }
  }
  return [...inputs].sort((left, right) => left - right);
}

export interface ExtractorShortfall {
  readonly typeID: number;
  readonly maxOutput: number;
  readonly routed: number;
}

/**
 * An extractor whose routes reserve less than its maximum cycle — what the
 * game flags. Null when it is settled, or when the maximum is unknown (an
 * unknown raises nothing).
 */
export function extractorShortfall(colony: Colony, pin: ColonyPin): ExtractorShortfall | null {
  const program = pin.program;
  const maxOutput = program?.maxOutputPerCycle ?? null;
  if (pin.kind !== "extractor-control" || program === null || maxOutput === null || program.resourceTypeID <= 0) {
    return null;
  }
  const routed = routedFrom(colony, pin.pinID, program.resourceTypeID);
  return routed < maxOutput ? { typeID: program.resourceTypeID, maxOutput, routed } : null;
}

export interface RouteToCreate {
  readonly path: readonly number[];
  readonly typeID: number;
  readonly quantity: number;
}

export interface ExtractorReroute {
  readonly planetID: number;
  readonly pinID: number;
  readonly removeRouteIDs: readonly number[];
  readonly create: readonly RouteToCreate[];
}

/**
 * The retail re-size for one extractor's storage routes, or null when there is
 * nothing to grow: it is settled, its maximum is unknown, or it has no route
 * to storage to grow (a colony that only feeds factories straight from the
 * extractor is left as the player built it).
 *
 * Factory routes are left exactly as they are. The retail client removes and
 * recreates them at their former amounts, which changes nothing; leaving them
 * alone is the same colony with fewer commands.
 */
export function extractorReroute(colony: Colony, pinID: number): ExtractorReroute | null {
  const pin = colony.pins.find((candidate) => candidate.pinID === pinID);
  if (pin === undefined) return null;
  const shortfall = extractorShortfall(colony, pin);
  if (shortfall === null) return null;
  const pinByID = new Map(colony.pins.map((candidate) => [candidate.pinID, candidate]));
  const own = colony.routes
    .filter((route) => source(route) === pinID && route.commodityTypeID === shortfall.typeID)
    .sort((left, right) => left.routeID - right.routeID);
  const toStorage = own.filter((route) => isStorage(pinByID.get(destination(route) ?? 0)));
  if (toStorage.length === 0) return null;
  const toFactories = own
    .filter((route) => !toStorage.includes(route))
    .reduce((total, route) => total + route.commodityQuantity, 0);
  const storageTotalLeft = shortfall.maxOutput - toFactories;
  const formerToStorage = toStorage.reduce((total, route) => total + route.commodityQuantity, 0);
  if (storageTotalLeft <= formerToStorage || formerToStorage <= 0) return null;

  // clientPlanet.InstallProgram's split, rounding remainder carried forward.
  const create: RouteToCreate[] = [];
  let left = storageTotalLeft;
  let remainder = 0;
  for (const route of toStorage) {
    if (left <= 0) break;
    const share = (route.commodityQuantity / formerToStorage) * storageTotalLeft;
    let amount = Math.round(share);
    remainder += share - amount;
    amount += Math.round(remainder);
    remainder -= Math.round(remainder);
    amount = Math.min(amount, left);
    if (amount <= 0) continue;
    create.push({ path: [...route.path], typeID: shortfall.typeID, quantity: amount });
    left -= amount;
  }
  if (create.length === 0) return null;
  return {
    planetID: colony.planetID,
    pinID,
    removeRouteIDs: toStorage.map((route) => route.routeID),
    create,
  };
}
