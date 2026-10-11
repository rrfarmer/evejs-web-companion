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
//
// ALIGNED TO A THING. menusvc._AlignTo (2778 to 2793), the only place the client makes the call:
//
//   bp.CmdAlignTo(dstID=targetID, bookmarkID=bookmarkID)
//
// Nothing goes by position. Of the two by name one is an ID and the other None: a thing, or a bookmark. With no
// park, which is a pilot that is docked, the client sends nothing; and AlignTo (2770) sends nothing for the
// pilot's own ship. It answers nothing. Both of Tranquility's recordings have it so, on the ballpark's bound
// object, the thing a long. (Against this server a client holds a station's or a celestial's ID as the server
// sent it, a whole number within 32 bits, and sends that back: so does the game port.)
//
// The server aligns the session's own ship in the session's own system (beyonceService.Handle_CmdAlignTo): it
// trusts nothing of the caller but the thing, does nothing for a session with no ship in space, and refuses
// nothing. Either transport carries it, asked of beyonce by its name; the game port makes it on the ballpark's
// object.
//
// The page aligns to things only: it has no align to a bookmark. What the client keeps of an align for itself
// (StoreAlignTarget, for the HUD's words) the BFF keeps for a pilot on the game port (pilots.js,
// afterMovementCall). The client cancels its autopilot's navigation after the call; the page's flight panel does
// not order a ship beside its autopilot at all.

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

/**
 * Aligns the pilot's ship to a thing in space. Fails as the call fails, and before it where the client sends
 * nothing: for what is no thing, for a pilot that is not in space, and for the pilot's own ship.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER A SHIP ALIGNED. The server answers nothing whether it turned the
 * ship or not: it does not for a ship in warp or docking, nor for a thing that is not in the pilot's system.
 */
export async function alignTo(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number): Promise<void> {
  if (!isAnID(targetID)) {
    throw new Error("That target could not be identified.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  if (now.shipID === targetID) {
    throw new Error("A ship cannot align to itself.");
  }
  await act("beyonce", "CmdAlignTo", [], { dstID: targetID, bookmarkID: null });
}
