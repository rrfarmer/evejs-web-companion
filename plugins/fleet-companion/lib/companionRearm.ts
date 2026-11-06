// The `rearm` order's docked half: which saved fitting says what this ship
// carries, how much of it is missing, where in the station the rest is, and
// what the pilot says about it afterwards.
//
// Pure: the flow reads the library, the fit, the hold, the drone bay and the
// hangars, hands them here, and makes the moves and the call these answers name.
//
// ⚠ THE SAVED FITTING IS THE LOADOUT, BECAUSE IT IS THE CLIENT'S. A retail
// fitting lists the charges in the cargo (flagCargo) and the drones in the bay
// (flagDroneBay) beside the modules, and the fitting window's Fit Ship already
// tops a ship up to it: `shipfitting/fitting.py` 16-58 subtracts what the hold
// and the bay hold of each type, and `fittingSvc.LoadFitting` 554-627 names the
// hangar stacks of what is still wanted and calls `FitFitting`. The server does
// the same subtraction (`_fitFittingQuantityItemsToShipBay`: requested less what
// the bay already holds), so the parts here carry the fitting's own quantities
// and the server fills only the difference. Nothing new is configured: a pilot
// rearms to the fitting it was saved as.
//
// ⚠ WHICH FITTING IS READ OFF THE SHIP, NEVER ASKED. The hull's type narrows the
// library and the modules decide among what is left: the fitting whose slots
// hold what this ship has fitted, slot for slot. A fitting that lists no charges
// and no drones has nothing to rearm with and is passed over.
//
// ⚠ THE CORPORATION'S HANGAR COUNTS, AND THE PILOT'S OWN COMES FIRST. The game
// fits only from the personal hangar (`LoadFitting` lists
// `containerHangar`/`flagHangar` alone), so what that hangar lacks is moved into
// it from the corporation's divisions first, lowest division first, and only as
// much as is missing. A division the pilot may not take from refuses the move
// and the shortfall is said, never hidden.

import { isSlotFlag } from "../../../web/src/plugin-api/flying.ts";

/** inventorycommon/const.py flagCargo and flagDroneBay. */
export const FLAG_CARGO = 5;
export const FLAG_DRONE_BAY = 87;

/** What a fitting needs to be told apart and rearmed from. */
export interface RearmFitting {
  readonly fittingID: number;
  readonly name: string;
  readonly shipTypeID: number;
  readonly modules: readonly { readonly typeID: number; readonly flagID: number; readonly quantity: number }[];
}

/** A stack somewhere: a hangar row, a hold row or a drone bay stack. */
export interface RearmStack {
  readonly itemID: number;
  readonly typeID: number;
  /** A recovered drone is a singleton with quantity -1; it counts as one. */
  readonly quantity: number;
  readonly singleton?: boolean;
}

/** One corporation hangar division's rows, as the corp hangar read gives them. */
export interface RearmDivision {
  readonly division: number;
  readonly rows: readonly RearmStack[];
}

function units(stack: RearmStack): number {
  return stack.singleton === true || stack.quantity < 1 ? 1 : stack.quantity;
}

export function sumOfType(stacks: readonly RearmStack[], typeID: number): number {
  return stacks.filter((stack) => stack.typeID === typeID).reduce((sum, stack) => sum + units(stack), 0);
}

/** The fitting's charges and drones, by type: what a rearmed ship carries. */
export function rearmLoadout(fitting: RearmFitting): { readonly charges: Map<number, number>; readonly drones: Map<number, number> } {
  const charges = new Map<number, number>();
  const drones = new Map<number, number>();
  for (const module of fitting.modules) {
    if (module.typeID <= 0 || module.quantity <= 0) continue;
    const into = module.flagID === FLAG_CARGO ? charges : module.flagID === FLAG_DRONE_BAY ? drones : null;
    if (into !== null) into.set(module.typeID, (into.get(module.typeID) ?? 0) + module.quantity);
  }
  return { charges, drones };
}

export type RearmFittingChoice =
  | { readonly fitting: RearmFitting; readonly exact: boolean }
  | { readonly fitting: null; readonly reason: string };

/**
 * The saved fitting this ship rearms to, or why there is none.
 *
 * Among the fittings for this hull that carry charges or drones, the one whose
 * slots match the most of what is fitted; `exact` when every slot matches both
 * ways. A tie keeps the library's order, which puts the pilot's own first.
 */
export function pickRearmFitting(
  library: readonly RearmFitting[],
  shipTypeID: number,
  fitted: readonly { readonly flagID: number; readonly typeID: number }[],
): RearmFittingChoice {
  const forHull = library.filter((fitting) => fitting.shipTypeID === shipTypeID);
  if (forHull.length === 0) {
    return { fitting: null, reason: "There is no saved fitting for this ship." };
  }
  const stocked = forHull.filter((fitting) => {
    const loadout = rearmLoadout(fitting);
    return loadout.charges.size > 0 || loadout.drones.size > 0;
  });
  if (stocked.length === 0) {
    return { fitting: null, reason: "No saved fitting for this ship lists any ammo or drones." };
  }
  const fittedSlots = fitted.filter((module) => isSlotFlag(module.flagID));
  let best: { fitting: RearmFitting; score: number; exact: boolean } | null = null;
  for (const fitting of stocked) {
    const slots = new Map<number, number>();
    for (const module of fitting.modules) {
      if (isSlotFlag(module.flagID) && module.typeID > 0 && !slots.has(module.flagID)) slots.set(module.flagID, module.typeID);
    }
    const score = fittedSlots.filter((module) => slots.get(module.flagID) === module.typeID).length;
    const exact = score === slots.size && score === fittedSlots.length;
    if (best === null || score > best.score) best = { fitting, score, exact };
  }
  // `stocked` is not empty, so `best` is set.
  return { fitting: best!.fitting, exact: best!.exact };
}

/** One type the fitting wants aboard, against what is aboard. */
export interface RearmNeed {
  readonly flagID: typeof FLAG_CARGO | typeof FLAG_DRONE_BAY;
  readonly typeID: number;
  readonly wanted: number;
  readonly aboard: number;
  /** What is still to come: never below nothing. */
  readonly missing: number;
}

/** What the ship lacks of its fitting's charges (in the hold) and drones (in the bay). */
export function rearmNeeds(
  fitting: RearmFitting,
  cargo: readonly RearmStack[],
  droneBay: readonly RearmStack[],
): RearmNeed[] {
  const loadout = rearmLoadout(fitting);
  const needs: RearmNeed[] = [];
  for (const [typeID, wanted] of loadout.charges) {
    const aboard = sumOfType(cargo, typeID);
    needs.push({ flagID: FLAG_CARGO, typeID, wanted, aboard, missing: Math.max(0, wanted - aboard) });
  }
  for (const [typeID, wanted] of loadout.drones) {
    const aboard = sumOfType(droneBay, typeID);
    needs.push({ flagID: FLAG_DRONE_BAY, typeID, wanted, aboard, missing: Math.max(0, wanted - aboard) });
  }
  return needs;
}

/** One move out of a corporation division into the pilot's hangar. */
export interface RearmCorpMove {
  readonly itemID: number;
  readonly typeID: number;
  readonly division: number;
  readonly quantity: number;
  /** The whole stack goes; a part of one is moved with a quantity. */
  readonly wholeStack: boolean;
}

/**
 * The corporation stacks to bring into the hangar so the hangar holds what the
 * ship is missing: only the difference, lowest division first, and within a
 * division the largest stack first so as few stacks as possible are split.
 */
export function planCorpFetch(
  needs: readonly RearmNeed[],
  hangar: readonly RearmStack[],
  divisions: readonly RearmDivision[],
): RearmCorpMove[] {
  const missingByType = new Map<number, number>();
  for (const need of needs) {
    if (need.missing > 0) missingByType.set(need.typeID, (missingByType.get(need.typeID) ?? 0) + need.missing);
  }
  const moves: RearmCorpMove[] = [];
  const ordered = [...divisions].sort((a, b) => a.division - b.division);
  for (const [typeID, missing] of missingByType) {
    let fetch = missing - sumOfType(hangar, typeID);
    for (const division of ordered) {
      if (fetch <= 0) break;
      const stacks = division.rows.filter((row) => row.typeID === typeID).sort((a, b) => units(b) - units(a));
      for (const stack of stacks) {
        if (fetch <= 0) break;
        const has = units(stack);
        const take = Math.min(has, fetch);
        moves.push({ itemID: stack.itemID, typeID, division: division.division, quantity: take, wholeStack: take === has });
        fetch -= take;
      }
    }
  }
  return moves;
}

/** The parts of the client's `FitFitting` call that put charges and drones aboard. */
export interface RearmFitParts {
  /** Type -> the fitting's whole quantity; the server subtracts what is aboard. */
  readonly chargesByType: Readonly<Record<number, number>>;
  readonly dronesByType: Readonly<Record<number, number>>;
  /** Type -> the hangar stacks of it, as the client names them. */
  readonly itemsByType: Readonly<Record<number, readonly number[]>>;
}

/**
 * The `FitFitting` parts for the types still missing, from the hangar as it
 * stands now. Null when nothing is missing or the hangar has none of it.
 */
export function rearmFitParts(fitting: RearmFitting, needs: readonly RearmNeed[], hangar: readonly RearmStack[]): RearmFitParts | null {
  const loadout = rearmLoadout(fitting);
  const chargesByType: Record<number, number> = {};
  const dronesByType: Record<number, number> = {};
  const itemsByType: Record<number, number[]> = {};
  for (const need of needs) {
    if (need.missing <= 0) continue;
    const stacks = hangar.filter((row) => row.typeID === need.typeID).map((row) => row.itemID);
    if (stacks.length === 0) continue;
    itemsByType[need.typeID] = stacks;
    if (need.flagID === FLAG_CARGO) chargesByType[need.typeID] = loadout.charges.get(need.typeID) ?? need.wanted;
    else dronesByType[need.typeID] = loadout.drones.get(need.typeID) ?? need.wanted;
  }
  return Object.keys(itemsByType).length === 0 ? null : { chargesByType, dronesByType, itemsByType };
}

/** The most types one chat line names before it says how many more. */
const MAX_TYPES_NAMED = 6;

function listOf(parts: readonly string[]): string {
  if (parts.length <= MAX_TYPES_NAMED) return parts.join(", ");
  return `${parts.slice(0, MAX_TYPES_NAMED).join(", ")} and ${parts.length - MAX_TYPES_NAMED} more`;
}

/**
 * What the pilot says once it has rearmed: what came aboard and from where, and
 * what is still short. `before` and `after` are the needs read either side of
 * the moves; `moved` are the corporation moves that went through; `stocked` is
 * how much of a type the pilot's hangar and the corp's divisions held before.
 */
export function rearmReport(
  fitting: RearmFitting,
  before: readonly RearmNeed[],
  after: readonly RearmNeed[],
  moved: readonly RearmCorpMove[],
  nameOf: (typeID: number) => string | null,
  stocked: (typeID: number) => number,
): string[] {
  const name = (typeID: number): string => nameOf(typeID) ?? "an unnamed item";
  const label = fitting.name.trim() === "" ? "its saved fitting" : fitting.name.trim();
  const added: string[] = [];
  for (const need of after) {
    const was = before.find((b) => b.flagID === need.flagID && b.typeID === need.typeID)?.aboard ?? need.aboard;
    const came = need.aboard - was;
    if (came <= 0) continue;
    const fromCorp = new Map<number, number>();
    for (const move of moved) {
      if (move.typeID === need.typeID) fromCorp.set(move.division, (fromCorp.get(move.division) ?? 0) + move.quantity);
    }
    const corp = [...fromCorp].sort((a, b) => a[0] - b[0]).map(([division, quantity]) => `${quantity} from corp division ${division}`);
    added.push(`${came} ${name(need.typeID)}${corp.length > 0 ? ` (${corp.join(", ")})` : ""}`);
  }
  // Short for want of stock, or short with the stock there: the second is a hold
  // or a bay with no room left (or a move the server refused), and saying "not
  // in the hangar" over goods that are would send the commander looking for the
  // wrong thing.
  const unstocked: string[] = [];
  const unloaded: string[] = [];
  for (const need of after) {
    if (need.missing <= 0) continue;
    const was = before.find((b) => b.flagID === need.flagID && b.typeID === need.typeID)?.missing ?? need.missing;
    (stocked(need.typeID) >= was ? unloaded : unstocked).push(`${need.missing} ${name(need.typeID)}`);
  }
  const lines: string[] = [];
  if (added.length > 0) lines.push(`Rearmed to ${label}: ${listOf(added)}.`);
  else if (unstocked.length === 0 && unloaded.length === 0) lines.push(`Already rearmed to ${label}.`);
  if (unstocked.length > 0) lines.push(`Still short: ${listOf(unstocked)}. Not enough in my hangar or the corp hangar here.`);
  if (unloaded.length > 0) lines.push(`Could not load ${listOf(unloaded)}: no room aboard, or the move was refused.`);
  return lines;
}
