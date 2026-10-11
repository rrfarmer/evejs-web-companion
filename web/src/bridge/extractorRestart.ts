// An extractor restarted as the client restarts one (the plan's Phase 6b).
//
// WHAT THE CLIENT DOES (clientPlanet.py). RestartExtractors (851 to 872) installs the programme again on every
// extractor control unit that has one and is not running, with the unit's own radius, and submits the lot as one
// change. InstallProgram (514 to 596), for each:
//
//   qtyToDistribute, cycleTime, numCycles = self.remoteHandler.GetProgramResultInfo(pinID, typeID, pin.heads, headRadius)
//   qtyToRoute = pin.GetMaxOutput(qtyToDistribute, cycleTime)
//
// then, of the routes that leave the unit: one of another commodity is taken off; one that ends at a store or a
// consumer is remembered and taken off; any other is left. The programme is installed. And the routes are made
// anew for what the programme will now yield at the most:
//
//   to consumers first, each what it had, the last of them what is left if that is less;
//   then to the stores, each its share of what is left as it shared before, the rounding carried on.
//
// All of it is ONE UserUpdateNetwork. Recorded on Tranquility so: the planet answered (1897, 9000000000L, 8), and
// 114 ms later the change was [(7, ..), (7, ..), (13, (pinID, 2267, 0.0101)), (6, ((2, 1), .., 2267, 3000)),
// (6, ((2, 2), .., 2267, 414.0))]: 3414 is the whole of 1.8 times 1897.
//
// Until 2026-10-10 the page installed the programme alone, read the colony, and made the routes anew in a second
// change (bridge/colonyRoutes.ts, extractorReroute, which still mends a colony left short by an earlier restart).
//
// WHERE THIS IS NOT THE CLIENT'S.
//
//   A unit with no heads. The client installs "no programme" on it. Here it is not restarted, and said so.
//   A link too narrow for a store's share. The client makes the route for what the link can still carry
//     (FindRoutableQuantityOfResource). The page is not told a link's use, and asks for the share: the server
//     refuses the change if it does not fit.
//   The colony. The client plans from its planet's own colony, kept since the planet was opened. The page plans
//     from the BFF's reading of it.
//   A quantity that is what was left is a float from a client (414.0 above) and a whole number from here.
//
// The planet's read asks nothing of anyone's colony but the session's own (planetMgrService
// .Handle_GetProgramResultInfo): an estimate from the planet's own resources for heads the caller places.

import type { Ask } from "./ask.ts";
import { isStorage } from "./colonyRoutes.ts";
import { changeColonyNetwork } from "./planetWrites.ts";
import { unwrapLong, type JsonValue } from "./wire.ts";
import type { Colony } from "../store/types.ts";

const CREATE_ROUTE = 6;
const REMOVE_ROUTE = 7;
const INSTALL_PROGRAM = 13;
const TEMPORARY_ROUTE = 2;
/** const.SEC: a second, in the hundred-nanosecond ticks a cycle's length is told in. */
const TICKS_A_SECOND = 10_000_000;
/** The length of the cycle a yield is stated for (EcuPin.GetMaxOutput divides by it). */
const BASE_CYCLE_SECONDS = 900;

/**
 * EcuPin.GetMaxOutput (297): int(scalar * baseOutput) * cycleTime / const.SEC / 900.0, the scalar one more than
 * the unit's noise. The most one cycle can yield, which is what the unit's routes are made for.
 */
export function maxOutputOf(noiseFactor: number, quantity: number, cycleTicks: number): number {
  return Math.trunc((1 + noiseFactor) * quantity) * cycleTicks / TICKS_A_SECOND / BASE_CYCLE_SECONDS;
}

/** What the planet says a programme will yield: a cycle's quantity, a cycle's length in ticks, and the count of cycles. */
export interface ProgramYield {
  readonly quantity: number;
  readonly cycleTicks: number;
  readonly cycles: number;
}

const aCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** GetProgramResultInfo's answer, (qtyToDistribute, cycleTime, numCycles), or null where it is none. The length is a long. */
export function decodeProgramResult(value: JsonValue): ProgramYield | null {
  const items = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { readonly items?: unknown }).items)
      ? (value as { readonly items: readonly JsonValue[] }).items
      : null;
  if (items === null || items.length !== 3) {
    return null;
  }
  const [quantity, length, cycles] = items;
  const ticks = unwrapLong(length);
  if (!aCount(quantity) || !aCount(cycles) || ticks === null || ticks < 0n) {
    return null;
  }
  return { quantity, cycleTicks: Number(ticks), cycles };
}

/** Python's round for a float: a half goes away from nought. */
const rounded = (value: number): number => Math.sign(value) * Math.round(Math.abs(value));

/**
 * The one change that installs `typeID` again on the unit `pinID` and makes its routes anew for `toRoute` a cycle,
 * as clientPlanet.InstallProgram builds it: the removals, the programme, the new routes.
 */
export function planExtractorRestart(colony: Colony, pinID: number, typeID: number, headRadius: number, toRoute: number): JsonValue[] {
  const pinByID = new Map(colony.pins.map((pin) => [pin.pinID, pin]));
  const own = colony.routes.filter((route) => route.path[0] === pinID).sort((left, right) => left.routeID - right.routeID);
  const removals: JsonValue[] = [];
  const toConsumers: { readonly path: readonly number[]; readonly had: number }[] = [];
  const toStores: { readonly path: readonly number[]; readonly had: number }[] = [];
  for (const route of own) {
    if (route.commodityTypeID !== typeID) {
      removals.push([REMOVE_ROUTE, [route.routeID]]);
      continue;
    }
    const end = pinByID.get(route.path[route.path.length - 1] ?? 0);
    const store = isStorage(end);
    if (end === undefined || (!store && end.kind !== "factory")) {
      continue;
    }
    (store ? toStores : toConsumers).push({ path: route.path, had: route.commodityQuantity });
    removals.push([REMOVE_ROUTE, [route.routeID]]);
  }

  const creations: JsonValue[] = [];
  const create = (path: readonly number[], quantity: number): void => {
    creations.push([CREATE_ROUTE, [[TEMPORARY_ROUTE, creations.length + 1], [...path], typeID, quantity]]);
  };
  let left = toRoute;
  for (const route of toConsumers) {
    if (left <= 0) break;
    const quantity = left < route.had ? left : route.had;
    create(route.path, quantity);
    left -= quantity;
  }
  const forStores = left;
  const storesHad = toStores.reduce((total, route) => total + route.had, 0);
  if (storesHad > 0) {
    let carried = 0;
    for (const route of toStores) {
      if (left <= 0) break;
      const share = (route.had / storesHad) * forStores;
      let quantity = rounded(share);
      carried += share - quantity;
      quantity += rounded(carried);
      carried -= rounded(carried);
      // (The client's CreateRoute refuses a route of nothing, and InstallProgram goes on without it.)
      if (quantity > 0) create(route.path, quantity);
      left -= quantity;
    }
  }
  return [...removals, [INSTALL_PROGRAM, [pinID, typeID, headRadius]], ...creations];
}

/**
 * Restarts one extractor control unit of a colony: asks the planet what the programme will yield, and makes the
 * one change. `ask` reads and `act` writes, each on the planet's own object. Fails as either call fails, and
 * before anything is asked where the unit, its heads or its noise are not known.
 */
export async function restartExtractor(ask: Ask, act: Ask, colony: Colony, pinID: number, typeID: number, headRadius: number): Promise<void> {
  const unit = colony.pins.find((pin) => pin.pinID === pinID);
  if (unit === undefined || unit.kind !== "extractor-control") {
    throw new Error("That pin is no extractor control unit of the colony's.");
  }
  const heads = unit.program?.heads ?? null;
  const noiseFactor = unit.program?.noiseFactor ?? null;
  if (heads === null || heads.length === 0) {
    throw new Error("The extractor's heads are not known, or it has none: its programme cannot be asked for.");
  }
  if (noiseFactor === null) {
    throw new Error("The extractor's noise is not known: what its routes should carry cannot be worked out.");
  }
  const answer = await ask("planetMgr", "GetProgramResultInfo", [pinID, typeID, heads.map((head) => [...head]), headRadius], null, colony.planetID);
  const result = decodeProgramResult(answer);
  if (result === null) {
    throw new Error("The planet's answer was no yield.");
  }
  const toRoute = maxOutputOf(noiseFactor, result.quantity, result.cycleTicks);
  await changeColonyNetwork(act, colony.planetID, planExtractorRestart(colony, pinID, typeID, headRadius, toRoute));
}
