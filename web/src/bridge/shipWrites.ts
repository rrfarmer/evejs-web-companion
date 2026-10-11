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

/**
 * Leaves the ship the pilot is in, docked: the pilot is in its capsule when this is answered. Fails as the call
 * fails, and before it where the ship is not known.
 */
export async function leaveShip(act: Ask, shipID: number): Promise<void> {
  if (!Number.isSafeInteger(shipID) || shipID <= 0) {
    throw new Error("Which ship this is is not known yet.");
  }
  await act("ship", "LeaveShip", [shipID]);
}
