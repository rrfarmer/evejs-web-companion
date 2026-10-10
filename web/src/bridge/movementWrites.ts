// The ship's own movement orders that the page makes itself.
//
// SENT TO A POINT. movementFunctions._Ship_GoToPoint (320 to 324):
//
//   sm.GetService('autoPilot').CancelSystemNavigation()
//   bp.CmdGotoPoint(*position)
//
// bp is michelle.GetRemotePark(), the ballpark's own object, and the position's three are floats: the positional
// control's drag (positionalControl.py 199 to 213) adds where the pilot dragged to, to the ballpark's own position
// of the ship. It answers nothing. A pilot controlling a structure sends nothing (IsControllingStructure).
//
// In no Tranquility recording (CmdGotoDirection, the double click in space, is in six). The server flies the
// session's own ship (beyonceService.Handle_CmdGotoPoint): it trusts nothing of the caller but the point. Either
// transport carries it, asked of beyonce by its name; the game port makes it on the ballpark's object, with each
// of the three a float.
//
// ⚠ THE PAGE'S POINT IS A MEASURED ONE, AND THE CLIENT'S IS NOT. A client's point is where its pilot dragged to
// a moment ago. The page's askers (a mining support ship's positioning, a script bot's fleet-mine block) work a
// point out from a reading of the scene, and a point is another place in another system and nothing to another
// ship. So the order is held to the ship and the system the point was measured in, by the page's own read of the
// pilot's flight just before: what the route did with the BFF's read until 2026-10-10. On the game port that
// read is of what the BFF holds of the session, and asks the server nothing.
//
// ⚠ AND NO AUTOPILOT IS CANCELLED HERE. The client's is its own, in the same process. The page's askers are bots
// that hold the ship's movement for themselves, and refuse to run beside another controller.

import type { Ask } from "./ask.ts";

/** A point in a solar system, in metres. */
export interface MovementPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The ship and the system a point was measured in. */
export interface MeasuredIn {
  readonly shipID: number;
  readonly solarSystemID: number;
}

/** The pilot's flight now: in space or not, and in which ship and system where that is known. */
export interface FlightNow {
  readonly inSpace: boolean;
  readonly shipID: number | null;
  readonly solarSystemID: number | null;
}

const isAnID = (id: number): boolean => Number.isSafeInteger(id) && id > 0;

/**
 * Sends the pilot's ship toward a point. Fails as the call fails, and before it where the point is no point, the
 * pilot is not in space, or its ship or system is not the one the point was measured in.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL. A caller sees the ship move in a later reading.
 */
export async function goToPoint(act: Ask, flightNow: () => Promise<FlightNow>, point: MovementPoint, measured: MeasuredIn): Promise<void> {
  if (![point.x, point.y, point.z].every(Number.isFinite) || !isAnID(measured.shipID) || !isAnID(measured.solarSystemID)) {
    throw new Error("Unknown movement geometry or scope.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  if (now.shipID !== measured.shipID) {
    throw new Error("The observed movement ship changed.");
  }
  if (now.solarSystemID !== measured.solarSystemID) {
    throw new Error("The measured movement system changed.");
  }
  await act("beyonce", "CmdGotoPoint", [point.x, point.y, point.z]);
}
