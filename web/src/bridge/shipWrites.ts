// The pilot's own ship left, by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 it was one route of the BFF (POST /api/bridge/ship/leave), which checked that the page had said
// `confirm`, made one call, and answered once the pilot was in another ship.
//
// THE CALL, as the client makes it, docked:
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
