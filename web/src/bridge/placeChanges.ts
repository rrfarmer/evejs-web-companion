// The pilot's changes of place that the page makes itself: the session going from a station into space, and on.
//
// UNDOCKED. The station's undock (ui/station/base.py, _DoUndockAttempt, 488 to 521):
//
//   onlineModules = clientDogmaIM.GetDogmaLocation().GetOnlineModules(shipID)
//   sm.GetService('sessionMgr').PerformSessionChange('undock', shipsvc.Undock, shipID, ignoreContraband,
//                                                    onlineModules=onlineModules)
//
// shipsvc is gameui.GetShipAccess(), the ship's object for the station; the ship is the session's own, the one the
// undocking service hands over (undockingSvc.py 121 to 135). First with ignoreContraband False: a ship carrying
// what the local law forbids is refused with ShipContrabandWarningUndock, the pilot is asked (OK / Cancel), and on
// OK the undock is made again with it True (506 to 511). The client's session manager makes the call only when no
// other session change is under way and the last one's timer has run, and the session is another one after it.
//
// THE SESSION CHANGE IS KEPT BY THE BFF, as the client's session manager keeps it: the change claimed, the call
// made, and the answer given once the ship is usable in space (src/server.js, the generic call's place changes;
// bridgeCallPolicy.js, PAGE_PLACE_CHANGE_CALLS). A refusal for contraband comes back as CONTRABAND_WARNING, in the
// words of the client's own dialog where the BFF has them.
//
// UNDOCKED FROM A PLAYER STRUCTURE (since 2026-10-14; until then the station's ship.Undock, which this server takes
// from a structure too). The client's structure docking service (structureDocking.py, Undock 26 to 51) asks
//
//   sm.GetService('sessionMgr').PerformSessionChange('undock', TryUndockOnServer, doIgnoreContraband=...)
//   ... sm.RemoteSvc('structureDocking').Undock(session.structureid, shipID, ignoreContraband=doIgnoreContraband)
//
// the structure's own service, by its name, with the structure the session is docked in and the ship (None where the
// ship is the structure, a pilot controlling it); ignoreContraband a keyword, false first and true once the pilot
// has said to go on, as at a station (37 to 45). No online modules are named. The same keeping as the station's.
//
// THE ONLINE MODULES ARE NOT THE PAGE'S TO NAME: godma's list is the client's, and the game port names it
// (src/gamePort/retailCalls.js, undocking). The page sends none, as its route sent none; the server leaves the
// modules as they are where none are named (shipService._syncRequestedOnlineModulesForUndock).
//
// DOCKED AT A STATION. The menu's dock (menusvc.DockStation, 2991 to 2997, through GetCloseAndTryCommand, which flies
// the ship close first) and the flight's dock-or-jump (movementFunctions.DockOrJumpOrActivateGate, 346 on, for a
// thing of the station group) both come to movementFunctions.RealDock (503 to 518):
//
//   sm.GetService('sessionMgr').PerformSessionChange('dock', bp.CmdDock, itemID, session.shipid)
//
// bp the ballpark's own object. The same keeping as the undock's, the BFF's; but a dock the server takes and does
// not carry out (the ship not yet close enough, still landing from a warp) answers nothing all the same, so the BFF
// waits only a short while for the ship to be docked, and answers either way: the page reads the flight after, and
// the autopilot docks again where the ship is still in space.
//
// ⚠ A STRUCTURE IS DOCKED AT ANOTHER WAY: structureDocking.Dock(structureID, session.shipid), asked of the service
// by its name once the ship is close (structureDocking.py 64 to 80): dockAtStructure, below.

//
// THROUGH A STARGATE. The menu's jump (menusvc.StargateJump, 3025 on, flying the ship close first) comes to the gate
// jump service (stargate/client/gateJumpSvc.py, JumpThroughGate, 98 to 127):
//
//   self.sessionMgr.PerformSessionChange(..., remoteBallpark.CmdStargateJump, stargateID, beaconID, session.shipid)
//
// beaconID the gate's own far gate, off its slim item (jumps[0].toCelestialID: movementFunctions.DockOrJumpOrActivateGate,
// 360 to 366); the autopilot's the same (autopilot.py 358). The page names the far gate where its caller knows it, and
// none (nought) where it does not, a fleet's broadcast naming only the gate: the game port names the slim item's then,
// as the client does, and the server works it out from the gate itself (src/gamePort/retailCalls.js). The same
// keeping as the undock's, the BFF's, which binds the park again in the new system before it answers.

/** idCheckers.IsStation (eve/common/script/sys/idCheckers.py 29 to 30): minStation to maxStation, inventorycommon/const.py 59 and 62. */
export function isStation(itemID: number): boolean {
  return Number.isSafeInteger(itemID) && itemID >= 60_000_000 && itemID <= 63_999_999;
}

import type { Ask } from "./ask.ts";
import type { FlightNow } from "./movementWrites.ts";

/** appConst.maxWormholeEnterDistance, in metres. */
export const WORMHOLE_ENTRY_RANGE_M = 5_000;
export const ENTER_WORMHOLE_LABEL = "UI/Inflight/EnterWormhole";

/**
 * Undocks the pilot's ship from where it is docked: from a station by the ship's Undock, from a player structure by
 * the structure's own (the flight read naming the structure). `ignoreContraband` is the client's: false first, true
 * once the pilot has said to go on. Fails as the call fails, and before it for a ship already in space or none known.
 *
 * ⚠ THE CALL COMING BACK IS THE SESSION IN SPACE: the BFF answers once the change is ready.
 */
export async function undock(act: Ask, flightNow: () => Promise<FlightNow>, ignoreContraband: boolean): Promise<void> {
  const now = await flightNow();
  if (now.inSpace) throw new Error("The ship is already in space.");
  if (now.shipID === null) throw new Error("There is no ship to undock in.");
  const structureID = now.structureID ?? null;
  if (structureID !== null) {
    await act("structureDocking", "Undock", [structureID, now.shipID === structureID ? null : now.shipID], { ignoreContraband });
    return;
  }
  await act("ship", "Undock", [now.shipID, ignoreContraband], { onlineModules: [] });
}

/**
 * Docks the pilot's ship at a station. Fails as the call fails, and before it for what is no station, and for a
 * ship not in space or none known.
 *
 * ⚠ THE CALL COMING BACK IS NOT ALWAYS A DOCK: the BFF answers a dock the server took and did not carry out once its
 * short wait is over, and the flight read after says which it was.
 */
export async function dock(act: Ask, flightNow: () => Promise<FlightNow>, stationID: number): Promise<void> {
  if (!isStation(stationID)) throw new Error("That is no station.");
  const now = await flightNow();
  if (!now.inSpace) throw new Error("The ship is not in space; undock first.");
  if (now.shipID === null) throw new Error("There is no ship to dock.");
  await act("beyonce", "CmdDock", [stationID, now.shipID]);
}

// DOCKED AT A PLAYER STRUCTURE (since 2026-10-14; until then by the dock route, POST /api/bridge/flight/dock, as the
// park's CmdDock). The client's structure docking service (structureDocking.py, Dock 64 to 80) flies the ship to
// within 2,500 m first (autoPilot.NavigateSystemTo(structureID, 2500, RequestDocking)) and then asks
//
//   sm.RemoteSvc('structureDocking').Dock(structureID, session.shipid)
//
// the structure's own service, by its name, not the park. The page asks it where the ship is: this server answers a
// ship still too far with DockingApproach, having set it approaching (structureDockingService.Handle_Dock), and the
// autopilot approaches and asks again on that refusal (nav/autopilotLoop.ts, isDockingApproach), as it does for a
// station. The same keeping as a station's dock, the BFF's.

/**
 * Docks the pilot's ship at a player structure. Fails as the call fails, and before it for a station (docked at by
 * the park's dock) or what is no structure's number, and for a ship not in space or none known.
 */
export async function dockAtStructure(act: Ask, flightNow: () => Promise<FlightNow>, structureID: number): Promise<void> {
  if (isStation(structureID)) throw new Error("A station is docked at by the ballpark's dock.");
  if (!Number.isSafeInteger(structureID) || structureID <= 0) throw new Error("That structure could not be identified.");
  const now = await flightNow();
  if (!now.inSpace) throw new Error("The ship is not in space; undock first.");
  if (now.shipID === null) throw new Error("There is no ship to dock.");
  await act("structureDocking", "Dock", [structureID, now.shipID]);
}

/**
 * Jumps the pilot's ship through a stargate, its far gate named where it is known (nought where not). Fails as the
 * call fails, and before it for what is no gate's number, and for a ship not in space or none known.
 *
 * ⚠ THE CALL COMING BACK IS THE SESSION IN THE NEXT SYSTEM: the BFF answers once the ship is usable there.
 */
export async function jump(act: Ask, flightNow: () => Promise<FlightNow>, fromGateID: number, toGateID = 0): Promise<void> {
  if (!Number.isSafeInteger(fromGateID) || fromGateID <= 0) throw new Error("That gate could not be identified.");
  const now = await flightNow();
  if (!now.inSpace) throw new Error("The ship is not in space; undock first.");
  if (now.shipID === null) throw new Error("There is no ship to jump.");
  const farGate = Number.isSafeInteger(toGateID) && toGateID > 0 ? toGateID : 0;
  await act("beyonce", "CmdStargateJump", [fromGateID, farGate, now.shipID]);
}

/** Once in range, send the local wormhole endpoint through the session-change barrier. */
export async function enterWormhole(act: Ask, flightNow: () => Promise<FlightNow>, endpointID: number): Promise<void> {
  if (!Number.isSafeInteger(endpointID) || endpointID <= 0) throw new Error("That wormhole could not be identified.");
  const now = await flightNow();
  if (!now.inSpace) throw new Error("The ship is not in space; undock first.");
  await act("wormholeMgr", "WormholeJump", [endpointID]);
}

/**
 * Jumps the pilot's ship through an Ansiblex jump gate, as the client's autopilot and its menu jump one (autopilot.py
 * 349; menusvc.py ReallyJumpThroughStructureJumpBridge, 2106): structureJumpBridgeMgr's
 * CmdJumpThroughStructureStargate with the Ansiblex, by the service's name, through a session change. Fails as the
 * call fails, and before it for what is no structure's number, and for a ship not in space.
 *
 * ⚠ THE CALL COMING BACK IS THE SESSION IN THE PAIR'S SYSTEM: the BFF answers once the ship is usable there.
 */
export async function jumpThroughJumpGate(act: Ask, flightNow: () => Promise<FlightNow>, structureID: number): Promise<void> {
  if (!Number.isSafeInteger(structureID) || structureID <= 0) throw new Error("That jump gate could not be identified.");
  const now = await flightNow();
  if (!now.inSpace) throw new Error("The ship is not in space; undock first.");
  await act("structureJumpBridgeMgr", "CmdJumpThroughStructureStargate", [structureID]);
}
