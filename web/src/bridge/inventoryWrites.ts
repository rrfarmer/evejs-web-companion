// An inventory's own writes made by the page itself (the plan's Phase 6b), on an inventory's own object: after a
// module's fitting (bridge/fitModule.ts) and a customs office's transfer (bridge/customsWrites.ts), the
// inventory's own.
//
// A STACK DROPPED ON A STACK. Until 2026-10-13 it was a route of the BFF's (POST /api/bridge/inventory/merge), which
// listed the place, sent MultiMerge on the place's binding and listed it again for its verdict. The client:
//
//   the drop       item.py, an item's OnDropData (958 to 1078): each stack of the same type dropped on this one is
//                  (its itemID, this one's itemID, its whole stack, or a number asked with shift held), and the
//                  source is where the dropped stacks lie (`sourceID = node.rec.locationID`, 1004)
//   the window's   invControllers.MultiMerge (327 to 335): the target's container's own controller hands
//                  [(source, destination, qty), ...] and the source on to its inventory
//   the call       invCache's container's MultiMerge (1100 to 1124): self.moniker.MultiMerge(ops, sourceContainerID)
//                  on the inventory the target is in: the hangar's for a stack in the hangar
//                  (invCache.GetInventory(const.containerHangar)), a thing's own for one in a ship or a container
//                  Ordinary numeric calls pass through cachedInventoryMoves: source locks gate acquisition,
//                  any acquired source permits the original complete operation list, and the wrapper returns None.
//
// Recorded on Tranquility once ("Unknown Events Level 2"): in the hangar's container, MultiMerge([(source, target,
// 3822)], 60001717), a list of one tuple and the station the dropped stack lay in.
//
// WHAT THE SERVER TAKES FROM THE CALLER (invBrokerService.Handle_MultiMerge, read 2026-10-13): the stacks named and
// the source; in a hangar it moves nothing of a stack that is not the session's own character's, and a ship's or a
// container's inventory is held to whose it is. It answers nothing whether it merged or not: the page reads the
// place again for its verdict.

//
// ITEMS TRASHED. Until 2026-10-13 a route (POST /api/bridge/inventory/trash), which listed the place, sent TrashItems
// on the inventory manager and listed the place again. The client (invItemFunctions.TrashInvItems, 602 to 626): the
// items must lie in one place, the pilot is asked, each must be of a type that may be trashed, and then
//
//   errors = invCache.GetInventoryMgr().TrashItems(itemsToTrash, locationID)
//
// on the inventory manager of where the session is (eveMoniker.GetInventoryMgr, 122 to 131: the solar system's
// where the session has one, else the station's), not on any inventory's own object. `locationID` is the station or
// structure the first item lies in directly, the office's station for a corporation's item, and otherwise the
// place the item lies in, a ship or a container (invCache.GetStationIDOfItem, 660 to 691). Each error answered is
// shown, and nothing else is done.
//
// WHAT THE SERVER TAKES FROM THE CALLER (invBroker/trash.js, Handle_TrashItems and _isInventoryItemTrashable, read
// 2026-10-13): the session's own character's items, or a director's corporation items in the office here; never
// the ship the pilot is in, a fitted module or anything in space; all of one owner. It answers None, or a list of
// refusals (CannotTrashItem) where it destroys nothing.

import type { Ask } from "./ask.ts";
import type { InventoryState } from "../store/types.ts";
import type { JsonValue } from "./wire.ts";

/** `of`, for the hangar of where the pilot is docked: invCache.GetInventory(const.containerHangar). */
const THE_HANGAR = "hangar";

const whole = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Merges one stack into another of its type, in the inventory the target lies in (the hangar's, or a thing's own by
 * its number), the source lying in `sourceLocationID`: the whole of it, as a drop without shift sends.
 */
export async function mergeStacks(
  act: Ask,
  inventory: number | typeof THE_HANGAR,
  sourceLocationID: number,
  sourceItemID: number,
  destinationItemID: number,
  quantity: number,
): Promise<void> {
  if (!whole(sourceItemID) || !whole(destinationItemID) || sourceItemID === destinationItemID) {
    throw new Error("Two different stacks are required to merge.");
  }
  if (!whole(quantity)) throw new Error("A stack's whole quantity is required to merge it.");
  if (!whole(sourceLocationID)) throw new Error("Where that stack lies is not known.");
  await act("invbroker", "MultiMerge", [[[sourceItemID, destinationItemID, quantity]], sourceLocationID], null, inventory);
}

// THINGS MOVED BY THE PILOT. The route (POST /api/bridge/inventory/transfer) keeps the bots' moves, which carry the
// BFF's own word (a container's claim between bots, a haul's contract, the place a run expects): the pilot's own
// moves in the Inventory & Ship window, between the hangar, the ship's hold, its bays and a container, are the
// client's calls since 2026-10-14, on the inventory the things go to, the window's own container (invControllers.py):
//
//   one thing     _AddItem (229 to 262) and its __AddItem (195 to 226): the whole stack, or a number asked with
//                 shift held, from where it lies, Add(itemID, sourceLocationID, qty=quantity, flag=self.locationFlag)
//   many things   AddItems (489 to 562): sorted by volume times stack, smallest first, from where the first lies,
//                 MultiAdd(itemIDs, sourceLocation, flag=self.locationFlag), or flag=const.flagNone where the
//                 container has no flag of its own
//                 Ordinary move callers pass this through cachedInventoryMoves: invCache1027-1063 filters locks
//                 and traverses a new acquired-minus-charges set AFTER this controller's volume sort.
//
// The window's flags: the hangar's flagHangar (StationItems, 1138), the ship's hold flagCargo (ShipCargo, 605), a bay
// its own (BAY_FLAGS, below), and a container none (BaseInvContainer, 60): one thing into a container goes with
// flag=None, many with flagNone. A bay is a flag on the ship's own inventory, and what lies in it lies in the ship.

/**
 * A ship's bays by the page's key, each with the flag its window adds with (invControllers.py, ShipDroneBay to
 * ShipExpeditionHold, 669 to 776, and the ship maintenance bay's and the fleet hangar's), the values the client's own,
 * read from its compiled inventorycommon/const.py on 2026-10-14: flagDroneBay 87, flagShipHangar 90, the specialized
 * holds 133 to 149, flagQuafeBay 154, flagFleetHangar 155, flagFighterBay 158, flagCorpseBay 174, flagBoosterBay 176,
 * flagSubsystemBay 177, flagSpecializedIceHold 181, flagSpecialAsteroidHold 182, flagMobileDepotHold 183,
 * flagColonyResourcesHold 185, flagExpeditionHold 188. (Until 2026-10-14 only the BFF held them, and the page named
 * a bay by its key alone.)
 */
export const BAY_FLAGS: Readonly<Record<string, number>> = Object.freeze({
  cargo: 5, drone: 87, shipMaintenance: 90, fuel: 133, ore: 134, gas: 135, mineral: 136, salvage: 137, ship: 138,
  smallShip: 139, mediumShip: 140, largeShip: 141, industrialShip: 142, ammo: 143, commandCenter: 148,
  planetary: 149, quafe: 154, fleet: 155, fighter: 158, corpse: 174, booster: 176, subsystem: 177, ice: 181,
  asteroid: 182, mobileDepot: 183, colony: 185, expedition: 188,
});

/** The places the pilot's own move is made between. */
export type MovePlace =
  | { readonly kind: "hangar" }
  | { readonly kind: "cargo" }
  | { readonly kind: "container"; readonly customsOffice?: boolean }
  | { readonly kind: "shipBay"; readonly bay: string }
  | { readonly kind: "corp"; readonly division: number };

/**
 * A corporation hangar's division's flag: flagCorpSAG1 to flagCorpSAG7, 115 to 121 (inventorycommon/const.py 151 to
 * 157; corpFlagByDivision, 238 to 246, where the client counts its divisions from nought and the page from one).
 * The window adds with it (invControllers.BaseCorpContainer.SetDivisionID, 848 to 850: self.locationFlag =
 * corpFlagByDivision.get(divisionID)).
 */
export function corpDivisionFlag(division: number): number {
  if (!Number.isSafeInteger(division) || division < 1 || division > 7) throw new Error("That is no division of a corporation's hangar.");
  return 114 + division;
}

/**
 * The corporation's office where the pilot is docked, as the client's office manager finds it
 * (officeManager.GetCorpOfficeAtLocation, 99 to 111: the office of GetMyCorporationsOffices() whose stationID is
 * where the session is docked). Its officeID is the inventory the corporation's hangar is (invControllers.py:
 * StationCorpHangar's itemID the office's, 949 to 952; BaseCorpContainer._GetInvCacheContainer,
 * invCache.GetInventoryFromId(that itemID), 856 to 860), and the place its things lie in (BaseCorpContainer.IsItemHere,
 * 867 to 868: item.locationID == self.itemID). Null where the corporation has no office there.
 */
export async function officeAt(ask: Ask, dockedAt: number): Promise<number | null> {
  const answer = await ask("officeManager", "GetMyCorporationsOffices", []);
  const list = answer !== null && typeof answer === "object" && !Array.isArray(answer) && Array.isArray((answer as { list?: unknown }).list)
    ? (answer as { list: JsonValue[] }).list
    : [];
  const number = (value: unknown): number => (typeof value === "number" ? value
    : value !== null && typeof value === "object" && "value" in (value as object) ? Number((value as { value: unknown }).value) : NaN);
  for (const row of list) {
    const fields = row !== null && typeof row === "object" && !Array.isArray(row) ? (row as { fields?: Record<string, unknown> }).fields : undefined;
    if (fields && number(fields.stationID) === dockedAt && whole(number(fields.officeID))) return number(fields.officeID);
  }
  return null;
}

/** The flag a place's window adds with: flagHangar, flagCargo, a bay's own, a division's own, and none for a container. */
export function moveFlagOf(place: MovePlace): number | null {
  if (place.kind === "hangar") return 4;
  if (place.kind === "cargo") return 5;
  if (place.kind === "container") return place.customsOffice ? 4 : null;
  if (place.kind === "corp") return corpDivisionFlag(place.division);
  const flag = BAY_FLAGS[place.bay];
  if (flag === undefined) throw new Error("That bay is not one the page knows.");
  return flag;
}

/** A thing moved, as the panel's row has it. */
export interface MovedRow {
  readonly itemID: number;
  readonly quantity: number;
  readonly singleton: boolean;
  readonly volume?: number | null;
}

/**
 * Moves things into a place's own inventory (the hangar's, or a thing's own by its number), from where they lie: one
 * thing with its whole stack or `qty` of it, many together in the client's order.
 */
export async function moveItems(
  act: Ask,
  inventory: number | typeof THE_HANGAR,
  place: MovePlace,
  sourceLocationID: number,
  rows: readonly MovedRow[],
  qty: number | null,
): Promise<void> {
  if (rows.length === 0 || !rows.every((row) => whole(row.itemID))) throw new Error("At least one item is required.");
  if (!whole(sourceLocationID)) throw new Error("Where those items lie is not known.");
  if (rows.length === 1) {
    const [row] = rows as [MovedRow];
    const quantity = qty ?? (row.singleton ? 1 : row.quantity);
    if (!whole(quantity)) throw new Error("A whole quantity is required.");
    // importExportUI.MoveFromInventory leaves the flag unset so the office uses its hangar.
    await act("invbroker", "Add", [row.itemID, sourceLocationID],
      place.kind === "container" && place.customsOffice ? { qty: quantity } : { qty: quantity, flag: moveFlagOf(place) }, inventory);
    return;
  }
  if (qty !== null) throw new Error("A quantity can only be given when moving a single stack.");
  const size = (row: MovedRow) => (row.volume ?? 0) * (row.singleton ? 1 : row.quantity);
  const ordered = [...rows].sort((a, b) => size(a) - size(b)).map((row) => row.itemID);
  await act("invbroker", "MultiAdd", [ordered, sourceLocationID], { flag: moveFlagOf(place) ?? 0 }, inventory);
}

// STACK ALL. Until 2026-10-14 a route (POST /api/bridge/inventory/stack) sent StackAll(flag) on the hangar's or the
// ship's binding. The client's window's Stack All (invControllers.StackAll, 382 to 388) asks its container's own
// inventory, StackAll(self.locationFlag): the hangar's with flagHangar, the ship's with flagCargo; and invCache's
// container acquires shared locks while scanning its own List (cachedInventoryMoves, original compiled
// invCache.py1065-1098). Only eligible duplicate types with an acquired lock reach the remote. The server merges
// per type, owner and flag, each merge by custody's own check with the session's character as the actor
// (invBrokerService.Handle_StackAll, 11955 on).

/** inventorycommon/const.py flagHangar and flagCargo. Other ship bays use their controller's own flag. */
const STACK_FLAGS = { hangar: 4, cargo: 5 } as const;

export type StackPlace = keyof typeof STACK_FLAGS
  | { readonly kind: "shipBay"; readonly bay: string }
  | { readonly kind: "corp"; readonly division: number }
  | { readonly kind: "container"; readonly itemID: number };

/**
 * Supported StationContainer scope: assembled ordinary cargo containers (group12) and station containers
 * (17366/17367/17368), directly in the docked pilot's hangar or active cargo. StationContainer.oneWay1559-1574
 * is falsey for these personally owned rows; the raw inventory password proxy stays below the writer guards.
 * Corporate/nested/space containers need their own controller handling before exposure.
 */
export function ordinaryContainerStackPlace(inventory: InventoryState, characterID: number | null): Extract<StackPlace, { kind: "container" }> | null {
  const open = inventory.container;
  if (!open || open.error || characterID === null) return null;
  const row = [...inventory.hangar.rows, ...inventory.cargo.rows].find(row => row.itemID === open.itemID);
  if (!row || (row.groupID !== 12 && ![17366, 17367, 17368].includes(row.typeID)) || !row.singleton || row.ownerID !== characterID) return null;
  const dockedAt = inventory.structureID ?? inventory.stationID;
  if (dockedAt === null) return null;
  const atHangar = row.locationID === dockedAt && row.flagID === 4;
  const atCargo = row.locationID === inventory.activeShipID && row.flagID === 5;
  return atHangar || atCargo ? { kind: "container", itemID: open.itemID } : null;
}

/** BaseInvContainer.StackAll382-393: a bay/division passes its flag; an unflagged StationContainer calls StackAll(). */
export async function stackAll(act: Ask, inventory: number | typeof THE_HANGAR, place: StackPlace): Promise<void> {
  const flag = typeof place === "string" ? STACK_FLAGS[place] : moveFlagOf(place);
  await act("invbroker", "StackAll", typeof place !== "string" && place.kind === "container" ? [] : [flag], null, inventory);
}

/** The refusals TrashItems answered, as the wire spelled the list; none for an answer of None. */
function refusalsOf(answer: JsonValue): readonly string[] {
  const items = Array.isArray(answer)
    ? answer
    : answer !== null && typeof answer === "object" && Array.isArray((answer as { items?: unknown }).items)
      ? ((answer as { items: JsonValue[] }).items)
      : [];
  return items.map((each) => (typeof each === "string" ? each : JSON.stringify(each)));
}

/**
 * The refusals TrashItems answered, each the name of a dialog the client puts up (invItemFunctions.TrashInvItems:
 * `for e in errors: prompt_player_fsd_dialog(e)`).
 */
export class TrashRefusedError extends Error {
  readonly dialogs: readonly string[];

  constructor(dialogs: readonly string[]) {
    super(`The server would not destroy those items (${dialogs.join(", ")}).`);
    this.dialogs = dialogs;
  }
}

/**
 * Destroys items that lie in one place, on the inventory manager of where the pilot is, naming the place as the
 * client names it (`locationID`). Fails where the server answers refusals, with the server's own words.
 */
/**
 * Names an item, on the inventory manager of where the pilot is (menuFunctions.SetName: SetLabel(itemID, name), its
 * line breaks made spaces). The server tells the name back as the item's row of cfg.evelocations. Fails as the call
 * fails.
 */
export async function setLabel(act: Ask, itemID: number, name: string): Promise<void> {
  if (!whole(itemID)) throw new Error("Which item that is is not known.");
  await act("invbroker", "SetLabel", [itemID, name.replace(/\n/g, " ")]);
}

/**
 * Assembles a packaged container, on the inventory manager of where the pilot is, as the client's Assemble Container
 * and a double click on the container do (menusvc.AssembleContainer, 3561 to 3564: AssembleCargoContainer(itemID,
 * None, 0.0); item.py 838 and 839): no name, and a real zero. Fails as the call fails.
 */
export async function assembleCargoContainer(act: Ask, itemID: number): Promise<void> {
  if (!whole(itemID)) throw new Error("Which item that is is not known.");
  await act("invbroker", "AssembleCargoContainer", [itemID, null, { type: "real", value: 0 }]);
}

export async function trashItems(act: Ask, itemIDs: readonly number[], locationID: number): Promise<void> {
  if (itemIDs.length === 0 || !itemIDs.every(whole)) throw new Error("At least one item is required.");
  if (!whole(locationID)) throw new Error("Where those items lie is not known.");
  const refusals = refusalsOf(await act("invbroker", "TrashItems", [[...itemIDs], locationID]));
  if (refusals.length > 0) throw new TrashRefusedError(refusals);
}
