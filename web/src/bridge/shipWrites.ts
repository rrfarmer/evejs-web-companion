// The pilot's own ship left, and a corvette boarded, by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 each was one route of the BFF (POST /api/bridge/ship/leave, POST /api/bridge/ship/board-corvette),
// which checked that the page had said `confirm`, made one call, and answered once the pilot was in another ship.
//
// A CORVETTE, as the client boards one (station.CreateNewbieShip, base.py 597 to 613), from the lobby's corvette
// button and no other place:
//
//   locationID = session.stationid or session.structureid   none: refused by the client itself
//   the ship is godma's own item (GetShipItem)              none: refused by the client itself
//   IsNewbieShip(its group)                                 aboard a corvette: refused by the client itself, and
//                                                           the button is out of use (corvetteButton.py)
//   not IsCapsule(its group)                                the pilot is asked, and anything but yes ends it
//   sm.RemoteSvc('dogmaIM').CreateNewbieShip(shipID, locationID)   by the service's name. In no recording.
//
// The route sent the call with no arguments. The server reads the two only to log them: it puts the session's own
// character in a corvette where the session is docked, and refuses in space and aboard one.
//
// A SHIP LEFT, as the client leaves one, docked:
//
//   station.TryLeaveShip (base.py 236 to 251)   only for the ship the pilot is in (dogmaLocation
//                                               .GetCurrentShipID()), and not while one is being left: the item
//                                               locked, sm.GetService('gameui').GetShipAccess().LeaveShip(shipid),
//                                               the item unlocked. From the item's menu, and before a clone jump.
//   structureDocking.LeaveShip (92 to 96)       in a structure: the same call, which answers the capsule, and then
//                                               dogmaLocation.MakeShipActive(capsuleID).
//
// In space the client's menu ejects (ship.Eject), which is another call and has its own route. LeaveShip is in no
// Tranquility recording.
//
// WHAT THE SERVER DOES WITH THE SHIP NAMED: nothing. It puts the session's own character in a capsule where the
// session is docked, making one there if there is none (shipService._leaveShip). The ship left stays in the hangar.
//
// ⚠ THE CALL ANSWERS ONCE THE PILOT IS IN THE CAPSULE. A client's session changes ship when the server says so,
// and it holds its next session change back for a time. The BFF keeps its own word for the pilot's ship, and for
// this call it watches the swap as its route did (src/server.js, dispatchShipSwapWrite): the answer comes when the
// pilot's flight says another ship, and a swap asked for while one is under way is refused in the BFF's words.
//
// NOT DONE: the structure's second step. Docked in a structure, the client makes the capsule active itself after
// the call. The route did not, and nor does this; no pilot docked in a structure has been tried.

import type { Ask } from "./ask.ts";
import type { FlightNow } from "./movementWrites.ts";
import { isListValue, unwrapLong, type JsonValue } from "./wire.ts";

/** A corvette's group (idCheckers.IsNewbieShip: groupCorvette). */
export const GROUP_CORVETTE = 237;

/** What the page knows of the ship the pilot is in, for a swap of it. A part that is not known is null. */
export interface PilotsShip {
  readonly shipID: number | null;
  /** The station or structure the pilot is docked in: session.stationid or session.structureid. */
  readonly dockedAt: number | null;
  /** The hull's group, as godma's own item of the ship has it. */
  readonly groupID: number | null;
  readonly isCapsule: boolean | null;
}

const known = (id: number | null): id is number => id !== null && Number.isSafeInteger(id) && id > 0;

/**
 * Boards a corvette where the pilot is docked, as the client's lobby does: the pilot is in it when this is
 * answered. `sure` asks the pilot, and is asked unless the pilot is known to be in a capsule; on a no nothing is
 * asked of the server and this answers false. Fails as the call fails, and before it where the client refuses by
 * itself: not docked, the ship not known, already aboard a corvette.
 */
export async function boardCorvette(act: Ask, ship: PilotsShip, sure: () => boolean | Promise<boolean>): Promise<boolean> {
  if (!known(ship.dockedAt)) {
    throw new Error("You must be docked to board a corvette.");
  }
  if (!known(ship.shipID)) {
    throw new Error("Which ship this is is not known yet.");
  }
  if (ship.groupID === GROUP_CORVETTE) {
    throw new Error("You are already aboard a corvette.");
  }
  if (ship.isCapsule !== true && !(await sure())) {
    return false;
  }
  await act("dogmaIM", "CreateNewbieShip", [ship.shipID, ship.dockedAt]);
  return true;
}

// A SHIP BOARDED, as the client boards one (menuFunctions.Board, 190 to 209), from a ship's menu in the hangar or
// in space:
//
//   sm.StartService('sessionMgr').PerformSessionChange('board', ship.Board, itemID, session.shipid or session.stationid)
//
// ship the ship's object for where the pilot is (gameui.GetShipAccess()); the second argument the ship left, or the
// station where the pilot is in none. Before it the client asks for the skills the ship's type needs and, where
// any is missing, says which and boards nothing (prompt_missing_skill_requirements); so does the page since
// 2026-10-16 (app/flow.ts boardShip, bridge/missingSkills.ts). Recorded on Tranquility in space as (shipID, the ship
// left), the bind carrying it (src/gamePort/retailCalls.js).
//
// THE SESSION CHANGE IS KEPT BY THE BFF, as a swap of the pilot's ship held to the ship boarded (src/server.js, the
// generic call's swaps; bridgeCallPolicy.js, PAGE_SHIP_SWAP_CALLS): answered once the pilot is in it. Until
// 2026-10-14 the call was a route's (POST /api/bridge/ship/board), which named the BFF's word for the ship left.

/**
 * Boards the ship `shipID`: the pilot is in it when this is answered. `leaving` is the ship the pilot is in, or
 * where it is docked where it is in none. Fails as the call fails, and before it where the ship to board is not known.
 */
export async function boardShip(act: Ask, shipID: number, leaving: number | null): Promise<void> {
  if (!known(shipID)) {
    throw new Error("Which ship that is is not known yet.");
  }
  await act("ship", "Board", [shipID, known(leaving) ? leaving : null]);
}

// A PACKAGED SHIP ASSEMBLED, as the client assembles one (invItemFunctions.AssembleShip, 164 to 210), from a packaged
// ship's menu in the hangar (Assemble Ship; Board Ship assembles it first, AssembleAndBoardShip, 213 to 240):
//
//   the name asked first, for one ship, unless the pilot said not to (prompt_rename_ship; settings.user.suppress
//   'suppress.ShipNameChangeOnAssemble'): the name given, or None on Later
//   sm.StartService('gameui').GetShipAccess().AssembleShip(itemIDs, name=name, subSystems=subSystems)
//   the answer the ships assembled, by their IDs; the default skin put on each (not done here)
//
// A modular ship's subsystems are asked first, and none is assembled in space (CantAssembleModularShipInSpace): the
// page does not offer one. In no recording.

/**
 * Assembles a packaged ship in the hangar: on the ship's object, the ship as a list of one, the name given or none.
 * Answers the ship assembled (another item than the one named, where it came off a stack), or null where the server
 * named none. Fails as the call fails, and before it where the ship is not known.
 */
export async function assembleShip(act: Ask, shipID: number, name: string | null): Promise<number | null> {
  if (!known(shipID)) {
    throw new Error("Which ship that is is not known yet.");
  }
  const answered = await act("ship", "AssembleShip", [[shipID]], { name, subSystems: null });
  const first = isListValue(answered) ? answered.items[0] : Array.isArray(answered) ? answered[0] : answered;
  const id = unwrapLong(first);
  return id !== null && id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : null;
}

/**
 * Leaves the ship the pilot is in, docked: the pilot is in its capsule when this is answered. Fails as the call
 * fails, and before it where the ship is not known.
 */
/**
 * The pilot ejected from the ship it flies in space (menuFunctions.Eject, 177 to 187): after ConfirmEject, the session
 * change 'eject' with gameui.GetShipAccess().Eject() - the pilot in a capsule beside the ship from then on.
 */
export async function ejectFromShip(act: Ask): Promise<void> {
  await act("ship", "Eject", []);
}

/** menuFunctions.SelfDestructShip (556 to 575): after its confirmation, the session change 'selfdestruct' with
 *  GetShipAccess().SelfDestruct(shipID) - the ship's countdown begun (its slim item's selfDestructTime). */
export async function selfDestructShip(act: Ask, shipID: number): Promise<void> {
  await act("ship", "SelfDestruct", [shipID]);
}

/** menuFunctions.AbortSelfDestructShip (547 to 553): after ConfirmAbortSelfDestruct, GetShipAccess().AbortSelfDestruct(shipID). */
export async function abortSelfDestructShip(act: Ask, shipID: number): Promise<void> {
  await act("ship", "AbortSelfDestruct", [shipID]);
}

export async function leaveShip(act: Ask, shipID: number): Promise<void> {
  if (!Number.isSafeInteger(shipID) || shipID <= 0) {
    throw new Error("Which ship this is is not known yet.");
  }
  await act("ship", "LeaveShip", [shipID]);
}

// A JETTISON, as the client makes one (invItemFunctions.Jettison, 56 to 73), from an item's menu where the item is
// offered (itemCheckers.OfferJettison 401, IsJettisonable 1230: the pilot in a ship in space; the item no ship, no
// player's container and nothing with a cargo bay of its own; in a hold a jettison takes, the cargo, the mining
// holds and the other specialised ones, inventorycommon/const.py 257):
//
//   the pilot asked (ConfirmJettison), and anything but yes ends it
//   sm.StartService('gameui').GetShipAccess().Jettison(itemIDs)   on the ship's Moniker for the solar system
//                                                                 (eveMoniker.GetShipAccess 42), the items' IDs as
//                                                                 one list, each once (itemsByID.keys())
//   answered (jettisonedToCanIDs, jettisonItemList): what went into a can, and what was launched as itself
//   an item asked for and in neither: UserError NotAllItemsWereJettisoned, naming the types that stayed
//
// The server (shipService.Handle_Jettison) answers the two lists, the first empty where it refused, and refuses one
// inside its cooldown with ShpJettisonPending. Tranquility's recording: ([itemID],) answered ([itemID], []).
//
// Until 2026-10-14 the call was a route's (POST /api/bridge/ship/jettison), which the page asked and read nothing of
// the answer; the route keeps a hosted bot's of a Mining Operation (its can found and given to the operation) and a
// hosted miner's custody, which are the bot host's to keep.

/** What a jettison answered, as the client reads it. */
export interface JettisonOutcome {
  /** jettisonedToCanIDs: into a can. */
  readonly toCan: readonly number[];
  /** jettisonItemList: launched as itself. */
  readonly launched: readonly number[];
  /** Asked for and in neither list: what the client names in NotAllItemsWereJettisoned. */
  readonly stayed: readonly number[];
}

function idsOf(value: JsonValue | undefined): number[] {
  const items: readonly JsonValue[] = isListValue(value) ? value.items : Array.isArray(value) ? value : [];
  return items.map((each) => Number(unwrapLong(each) ?? Number.NaN)).filter((id) => known(id));
}

/**
 * Jettisons the items, as the client's menu does once the pilot has said yes. Refused before the call where nothing
 * is named, and for a pilot not in space, where the client offers no jettison.
 */
export async function jettison(
  act: Ask,
  flightNow: () => Promise<FlightNow>,
  itemIDs: readonly number[],
): Promise<JettisonOutcome> {
  const ids = [...new Set(itemIDs)].filter((id) => known(id));
  if (ids.length === 0) {
    throw new Error("Nothing is chosen to jettison.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("A jettison is made in space; undock first.");
  }
  const answer = await act("ship", "Jettison", [ids]);
  const [toCan, launched] = Array.isArray(answer) ? [idsOf(answer[0]), idsOf(answer[1])] : [[], []];
  const handled = new Set([...toCan, ...launched]);
  return { toCan, launched, stayed: ids.filter((id) => !handled.has(id)) };
}
