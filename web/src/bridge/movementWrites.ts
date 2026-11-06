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
// The page aligns to things, and to bookmarks from a bookmark's menu in the Locations window (AlignToBookmark,
// 2804: the bookmark by name, and no thing). What the client keeps of an align for itself (StoreAlignTarget, for
// the HUD's words) the BFF keeps for a pilot on the game port (pilots.js, afterMovementCall).
//
// ⚠ AND NOTHING IS CANCELLED HERE EITHER. After the call the client forgets its own navigation in the system
// (autoPilot.CancelSystemNavigation, autopilot.py 494: a destination in the system it was flying to by steps of
// its own). The page's travel autopilot is not stopped by an align, as it was not when the route made it; the
// overview holds its own movement buttons while an order it began is still running, and no more than that.

// SENT AFTER A THING: THE APPROACH AND KEEP AT RANGE. One call for both, and for the autopilot's approach:
//
//   bp.CmdFollowBall(targetID, range)
//
// movementFunctions.ShipApproach (302) sends const.approachRange, fifty metres; _Ship_KeepAtRange (229) the
// distance the pilot chose, no nearer than that; the autopilot (autopilot.py 451 to 454) opens the throttle,
// park.CmdSetSpeedFraction(1.0), and then follows with a range of 0.0. None is sent for the pilot's own ship
// (_IsInvalidMovementTarget). It answers nothing. Tranquility's recordings have 168 follows: 138 at 50, 22 at
// 5000 and 6 at 7500, each a whole number, and the autopilot's twice, its range a float of nought; and ten
// throttles, every fraction a float. The game port sends the same forms (retailCalls.js).
//
// The server flies the session's own ship (beyonceService.Handle_CmdFollowBall): it trusts nothing of the caller
// but the thing and the range, does nothing for a session with no ship in space, and refuses the same follow
// sent again within a second (ThrottleGeneric, which the page has words for).
//
// ⚠ TWO THINGS THE CLIENT DOES HERE ARE THE BFF'S, NOT THE PAGE'S (src/server.js, followCall). The client's menu
// sends nothing where the ship already follows that thing at that range (_IsAlreadyFollowingBallAtRange): it
// goes by its own ballpark, and a game-port pilot's ballpark is the BFF's, so the BFF holds the order back and
// answers it as taken. And through the gateway the BFF opens the throttle before the menu's follow, as its
// routes always did there. Neither is done for the autopilot's.
//
// What the routes did until 2026-10-11 the page does: a default range, keep at range's floor, a range that is a
// distance of a million metres at most, and the refusal of a pilot that is not in space.
//
// SET TO ORBIT A THING. movementFunctions.Orbit (243) and _Ship_Orbit (260), the only place the client makes the
// call:
//
//   bp.CmdOrbit(targetID, followRange)
//
// The range is made float(range) under ten metres and int(range) from there, before the call. Nothing is sent
// for the pilot's own ship, nor where the ship already orbits that thing at that range. It answers nothing.
// Tranquility's 79 recordings are of whole numbers (1000, 5000, 7500, 10000), none under ten metres. The server
// flies the session's own ship, and refuses the same orbit sent again within a second (ThrottleGeneric).
//
// The hold-back and the gateway's throttle are the BFF's here too (followCall), for an orbit of nought as for
// any other. The route rounded a range of ten metres or more to the nearest whole number; the page cuts it, as
// int() does.
//
// STOPPED. eveCommands.CmdStopShip (1097 to 1110), and menusvc.Activate (2432) for a double click on the pilot's
// own capsule:
//
//   bp.CmdStop()
//
// With nothing. The command does nothing unless the pilot is in a ship in space. Tranquility's 24 recordings have
// it so, on the ballpark's bound object. It answers nothing. The server stops the session's own ship
// (beyonceService.Handle_CmdStop), tells a ship stopped in warp that it is in warp (OnRemoteMessage, ShipInWarp),
// and refuses a second stop within a second (ThrottleGeneric). The route held nothing back and opened no
// throttle: nor does the BFF for the page's call.
//
// ⚠ WHAT THE CLIENT DOES OF ITS AUTOPILOT AROUND A STOP IS THE CALLER'S HERE. The command forgets the autopilot's
// navigation in the system before the call and switches the autopilot off after it. The page's panel gives its
// autopilot up before it asks (flow.stopShip); a script bot's and a
// support ship's stop is one step of a program that carries on, and gives nothing up.
//
// TURNED TOWARD A PLACE. scanSvc.AlignToPosition (459 to 465), a probe result's Align To (GetAlignToMenu, 704 to
// 707, in an accurate result's menu):
//
//   directionalVector = geo2.Vec3SubtractD(position, myPosition)
//   rbp.CmdGotoDirection(directionalVector[0], directionalVector[1], directionalVector[2])
//
// the place less the ship's own ball's position, on the ballpark's object. It answers nothing. Tranquility has the
// call in six recordings, three floats and nothing else (the double click in space's, of length one). The server
// (beyonceService.Handle_CmdGotoDirection) turns the session's own ship toward the direction. The page's "own
// position" is its space read's of the ship, as the results' distances are.
//
// SENT INTO WARP, TO A SCAN RESULT. menusvc._WarpXToScanResult (1418 to 1428), which the scanner's list calls with
// no range (scannerListEntries.py 276). With a park, the sensor suite is asked for the site that goes by the
// result's label among its anomalies and its structures (sensorSuiteService.py 799), and the warp is
//
//   michelle.CmdWarpToStuff('item', siteID, minRange=None, fleet=False)     where it has one
//   michelle.CmdWarpToStuff('scan', label, minRange=None, fleet=False)      where it has none
//
// on the ballpark's object (michelle.py 737). It answers nothing. Two of Tranquility's recordings have the item's
// form, with fleet=False beside the range; none has a warp by a label. The probe results' menu makes the same warp
// with a range (menusvc.SolarsystemScanMenu, 1403 to 1407: Warp To at the pilot's own warp distance, Warp to Within
// at one of the seven, GetWarpOptions 1369 to 1381 and WarpToMenu 2254 to 2270), the range a float.
//
// The server (beyonceService.Handle_CmdWarpToStuff) flies the session's own ship in the session's own system: an
// item is a thing of the session's scene, a site the server seeded is given its contents on the way, and a label
// is looked up among that system's sites. A warp that comes to nothing is refused with a user's error; a ship
// already in warp is told so, and answered nothing. Either transport carries the call, asked of beyonce by its
// name; the game port makes it on the ballpark's object.
//
// ⚠ THE PAGE'S SENSOR SUITE IS ITS LAST READ OF THE SCANNER. A client's suite keeps the sites it was told of, for
// the system it is in. The page keeps what a bot's look last read (scanMgr.GetFullState, bridge/scanFullState.ts)
// and the system that read was of; where it has none for the system the pilot is in now, the scanner is read
// before the warp. A site whose number is no whole number the page can send goes by its label.
//
// ⚠ AND NO AUTOPILOT IS CANCELLED HERE, as for the other orders. What the client keeps of the warp's destination
// for itself (space.WarpDestination, the result's label) the BFF keeps as the thing warped to, for a pilot on the
// game port (pilots.js, afterMovementCall).
//
// SENT INTO WARP, TO A BOOKMARK. movementFunctions.WarpToBookmark (410 to 421), with a park:
//
//   michelle.CmdWarpToStuff('bookmark', bookmarkID, minRange=warpRange, fleet=fleet)
//
// The bookmark's menu gives the range as a float of the pilot's own warp distance, nought by default (menusvc.py
// 1481 to 1483), and the fleet's word False. It answers nothing. No recording has one. The server looks the
// bookmark up among the session's own character's (beyonceService.js, resolveBookmarkAnyStore), refuses one
// that is not there (BookmarkNotAvailable), and flies the session's own ship to the thing the bookmark is of, or
// to its point.
//
// The page says fleet=False, and the range the pilot chose from a bookmark's menu in the Locations window (Warp to
// Within: the pilot's own warp distance, or one of the menu's seven), or nought for the script bots. Its JSON has
// one kind of number: on the game port the range is made the client's float where the call is sent
// (retailCalls.js, warping), as a follow's nought is.
//
// ⚠ A MISSION'S BOOKMARK IS NOT WARPED TO SO BY A CLIENT. One that has an agent and a location's number is asked
// of the agent (GetAgentMoniker(agentID).WarpToLocation, 416), and never of the ballpark. The page's mission
// block asks the agent so too, since 2026-10-11 (warpToMissionLocation, below), and reads no folder of bookmarks.
//
// SENT TO A BOOKMARK: APPROACH LOCATION. movementFunctions.ApproachLocation (397 to 407), with a park:
//
//   sm.GetService('menu').StoreAlignTarget(alignTargetID=None, aligningToBookmark=False)
//   bp.CmdGotoBookmark(bookmark.bookmarkID)
//
// The bookmark's number alone, on the ballpark's object. It answers nothing. No recording has one. The server
// (beyonceService.Handle_CmdGotoBookmark) looks the bookmark up among the session's own character's, refuses one
// that is not there (BookmarkNotAvailable), and flies the session's own ship after the thing the bookmark is of
// where its scene holds it, else to its point. What the client forgets of an align the BFF forgets for a pilot on
// the game port (pilots.js, afterMovementCall). An agent's bookmark is the agent's to go to (GotoLocation, 402):
// the Locations window lists none.
//
// SENT INTO WARP, TO A LAUNCH. journal.py 452 to 453, the journal's "warp to" on a launch in the pilot's system
// that is farther off than a warp's least distance (433 to 440):
//
//   sm.GetService('michelle').CmdWarpToStuff('launch', launchID)
//
// and nothing else. It answers nothing. The server looks the launch up among the session's own character's
// (planetRuntimeStore.getLaunch), and flies the ship to its container, or to its point where that fails.
//
// ⚠ A PAGE'S WARP IS HELD TO THESE FORMS BY THE BFF (src/server.js, notAClientsWarp). The server's handler would
// fly the ship to a point a caller gave; no client gives one.
//
// SENT INTO WARP, TO A THING. movementFunctions.WarpToItem (437 to 452), the menu's "warp to" and its "warp to
// within": nothing for the pilot's own ship (438), and with a park
//
//   michelle.CmdWarpToStuff('item', itemID, minRange=warpRange)
//
// The range is the pilot's own warp distance where none is said, a whole number and nought by default; the menu's
// list offers seven (GetWarpToRanges, 334 to 343), from nought to a hundred kilometres. It answers nothing.
// Tranquility's recordings have it with a whole nought. The server flies the session's own ship to a thing of its
// scene, to stop that far short of it.
//
// ⚠ WHERE THE SENSOR SUITE HAS A BRACKET FOR THE THING, THE CLIENT MAKES THE BRACKET'S OWN WARP IN THIS ONE'S PLACE
// (443 to 446): a scan result's, or a bookmark's. The page makes this one for every thing.
//
// SENT INTO WARP, AS THE AUTOPILOT WARPS. autopilot.AP_WarpToDestID (465):
//
//   sm.GetService('michelle').GetRemotePark().CmdWarpToStuffAutopilot(destinationID)
//
// The thing alone. Tranquility has it recorded so. The server's handler takes one number of the caller, flies the
// session's own ship to that thing of its scene, and stops it ten kilometres short: the autopilot's warp of the
// client is not one to nought.
//
// ⚠ THE PAGE'S OWN AUTOPILOTS DO NOT MAKE THE AUTOPILOT'S CALL. Its travel autopilot, its mining bot and its script
// bots warp by the menu's call at a range of nought (nav/autopilotLoop.ts says why: the ten kilometres). The flight
// panel's warp, when it says no range, makes the autopilot's.
//
// SENT INTO WARP, TO A FLEET MEMBER. menusvc.WarpToMember (2748), from the fleet's menu:
//
//   michelle.CmdWarpToStuff('char', charID, minRange=warpRange)
//
// and no word of a fleet's. The menu gives the range as a float of the pilot's own warp distance, nought by
// default (712). One recording has it, with a float's nought. The server (beyonceService.js,
// resolveFleetMemberWarpTarget) looks the pilot up in the session's own fleet and flies the ship to that member's
// ship, on this grid or off it; it refuses one who is in no fleet of the session's, is not online, or is in
// another system. The page says a range of nought; on the game port it is made the client's float where the call
// is sent.
//
// SENT INTO WARP, TO A MISSION'S MARKED SPOT. movementFunctions.WarpToBookmark (410 to 421): a bookmark that has an
// agent and a location's number is not the ballpark's to warp to, but the agent's (414 to 416):
//
//   GetAgentMoniker(agentID).WarpToLocation(locationType, locationNumber, warpRange, fleet, referringAgentID,
//                                           GetFormationSettings())
//
// on the agent's own object. Such bookmarks are the journal's (bookmarkSvc.GetAgentBookmarks, 121 to 136, from
// agentMgr.GetMyJournalDetails: each mission's seventh). Tranquility has the call recorded 23 times, each
// ('dungeon', 0, nought, False, None, {formationType: 0, formationSpacing: 1000, formationSize: 10000}); the range
// a whole nought in 12 and a float's in 11. The settings are the pilot's own for a fleet's warp, sent whether
// the warp is a fleet's or not: those three are what a pilot who has chosen none has (evefleet/client/util.py
// 11 to 34; the client's own compiled constants, asked of its own Python: the decompiled tables are wrong).
//
// The server (agentMgrService.Handle_WarpToLocation) reads the type, the range and the other agent. It finds the
// session's own character's mission with that agent, gives a deadspace mission's site its contents, and flies the
// session's own ship there. It answers nothing whether it warped or not.
//
// The page says the client's six: the spot's type and number as the journal has them, a whole nought, False, no
// other agent, and the three settings of a pilot who has chosen none.

import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";
import type { MissionSpot } from "../store/types.ts";

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
  /** The player structure the pilot is docked in, where the read says one; a station's dock says none. */
  readonly structureID?: number | null;
}

/** A site as the page's read of the scanner has it: its own number, and the label a scan result of it goes by. */
export interface SiteKnown {
  readonly siteID: number | string | null;
  readonly targetID: string | null;
}

/** The sites the client's sensor suite looks among for a scan result's own: the anomalies, then the structures. */
export interface SitesKnown {
  readonly anomalies: readonly SiteKnown[];
  readonly structures: readonly SiteKnown[];
}

/** Sites as they were read, and the system the read was of. */
export interface SitesReadIn extends SitesKnown {
  readonly solarSystemID: number | null;
}

const isAnID = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

/** The distances the client's menu offers a warp at (movementFunctions.GetWarpToRanges), in metres. */
export const WARP_RANGES_M: readonly number[] = Object.freeze([0, 10000, 20000, 30000, 50000, 70000, 100000]);

/** const.approachRange: how far short of a thing the client's own approach stops, in metres. */
export const APPROACH_RANGE_M = 50;
/** The range a thing is kept at where none is said, in metres. */
export const KEEP_AT_RANGE_DEFAULT_M = 1000;
/** The range a thing is orbited at where none is said, in metres. */
export const ORBIT_DEFAULT_M = 1000;
/** The farthest a follow's range goes, in metres. */
const MAX_FOLLOW_RANGE_M = 1_000_000;
/** Whether this is a distance a follow can be told: a number of metres, not below nought and not beyond the farthest. */
const isARange = (range: number): boolean => range >= 0 && range <= MAX_FOLLOW_RANGE_M;

/**
 * What the client's menu looks to before it orders the ship about a thing: that there is a thing, that the pilot
 * is in space, and that the thing is not the pilot's own ship. Fails where the client sends nothing.
 */
async function aThingToOrderAbout(flightNow: () => Promise<FlightNow>, targetID: number, itself: string): Promise<void> {
  if (!isAnID(targetID)) {
    throw new Error("That target could not be identified.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  if (now.shipID === targetID) {
    throw new Error(itself);
  }
}

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
 * Turns the pilot's ship toward a place, as a probe result's Align To does: the place less the ship's own position.
 * Fails as the call fails, and before it where either is no position or the pilot is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER A SHIP TURNED.
 */
export async function alignToPosition(
  act: Ask,
  flightNow: () => Promise<FlightNow>,
  place: readonly [number, number, number],
  shipPosition: readonly [number, number, number],
): Promise<void> {
  if (![...place, ...shipPosition].every(Number.isFinite)) {
    throw new Error("Unknown place or ship position.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  await act("beyonce", "CmdGotoDirection", [place[0] - shipPosition[0], place[1] - shipPosition[1], place[2] - shipPosition[2]]);
}

/**
 * Aligns the pilot's ship to a thing in space. Fails as the call fails, and before it where the client sends
 * nothing: for what is no thing, for a pilot that is not in space, and for the pilot's own ship.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER A SHIP ALIGNED. The server answers nothing whether it turned the
 * ship or not: it does not for a ship in warp or docking, nor for a thing that is not in the pilot's system.
 */
export async function alignTo(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number): Promise<void> {
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot align to itself.");
  await act("beyonce", "CmdAlignTo", [], { dstID: targetID, bookmarkID: null });
}

/**
 * Sends the pilot's ship to a thing, to stop `range` metres short of it: the client's own fifty where none is
 * said. A range of nought is the autopilot's approach, which opens the throttle first. Fails as a call fails, and
 * before any where the range is no distance or the client sends nothing.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN OR HELD BACK, NEVER AN ARRIVAL. The BFF answers the same for a follow
 * the ship was already flying, which it does not send again.
 */
export async function approach(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number, range: number | null = null): Promise<void> {
  const stopAt = range ?? APPROACH_RANGE_M;
  if (!isARange(stopAt)) {
    throw new Error("The approach range must be a distance in metres.");
  }
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot approach itself.");
  if (stopAt === 0) {
    await act("beyonce", "CmdSetSpeedFraction", [1]);
  }
  await act("beyonce", "CmdFollowBall", [targetID, stopAt]);
}

/**
 * Has the pilot's ship keep `range` metres from a thing: a thousand where none is said, and never nearer than
 * the client's approach stops. Fails as the call fails, and before it where the range is no distance or the
 * client sends nothing.
 */
export async function keepAtRange(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number, range: number | null = null): Promise<void> {
  const held = range ?? KEEP_AT_RANGE_DEFAULT_M;
  if (!isARange(held)) {
    throw new Error("The range to hold must be a distance in metres.");
  }
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot keep at range of itself.");
  await act("beyonce", "CmdFollowBall", [targetID, Math.max(APPROACH_RANGE_M, held)]);
}

/**
 * Has the pilot's ship orbit a thing at `range` metres: a thousand where none is said. From ten metres the range
 * goes as a whole number, cut as the client cuts it; under that it goes as it is. Fails as the call fails, and
 * before it where the range is no distance or the client sends nothing.
 */
export async function orbit(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number, range: number | null = null): Promise<void> {
  const around = range ?? ORBIT_DEFAULT_M;
  if (!isARange(around)) {
    throw new Error("The orbit range must be a distance in metres.");
  }
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot orbit itself.");
  await act("beyonce", "CmdOrbit", [targetID, around < 10 ? around : Math.trunc(around)]);
}

/**
 * Stops the pilot's ship. Fails as the call fails, and before it for a pilot that is not in space, where the
 * client's command does nothing.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER A SHIP AT REST. A ship takes its time to stop, and one in warp
 * does not stop at all.
 */
export async function stopShip(act: Ask, flightNow: () => Promise<FlightNow>): Promise<void> {
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  await act("beyonce", "CmdStop", []);
}

/**
 * Warps the pilot's ship to a scan result, as the client's scanner does: to the site's own number as an item where
 * the result is of an anomaly or a structure the page has read, and by the result's label where it is not. `kept`
 * is the page's last read of the scanner; where it is of another system than the pilot is in now, or of none, the
 * sites are read first. Fails as a call fails, and before any for no label and for a pilot that is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL. A ship already in warp is answered the same.
 */
export async function warpToScanResult(act: Ask, flightNow: () => Promise<FlightNow>, kept: SitesReadIn | null, readSites: () => Promise<SitesKnown>, label: string, minRange: number | null = null): Promise<void> {
  if (label === "") {
    throw new Error("A scan-site label is required.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  const sites = kept !== null && kept.solarSystemID !== null && kept.solarSystemID === now.solarSystemID ? kept : await readSites();
  const siteID = [...sites.anomalies, ...sites.structures].find((each) => each.targetID === label)?.siteID;
  if (minRange !== null && !(Number.isFinite(minRange) && minRange >= 0)) {
    throw new Error("A warp's range is a distance of nought or more.");
  }
  await act("beyonce", "CmdWarpToStuff", isAnID(siteID) ? ["item", siteID] : ["scan", label], { minRange, fleet: false });
}

/** What a warp to a place of the pilot's own looks to before it is asked: that the place has a number, and that the pilot is in space. */
async function aPlaceToWarpTo(flightNow: () => Promise<FlightNow>, id: number, none: string): Promise<void> {
  if (!isAnID(id)) {
    throw new Error(none);
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
}

/**
 * Warps the pilot's ship to one of its bookmarks, as the bookmark's menu does: by the bookmark's number, to stop
 * `range` metres short of it (nought where none is said, one of the seven the menu offers), and the fleet's word
 * False. Fails as the call fails, and before it where the range is none of those, for what is no bookmark's number
 * and for a pilot that is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function warpToBookmark(act: Ask, flightNow: () => Promise<FlightNow>, bookmarkID: number, range = 0): Promise<void> {
  if (!WARP_RANGES_M.includes(range)) {
    throw new Error("The warp range must be one of the offered distances.");
  }
  await aPlaceToWarpTo(flightNow, bookmarkID, "A bookmark is required.");
  await act("beyonce", "CmdWarpToStuff", ["bookmark", bookmarkID], { minRange: range, fleet: false });
}

/**
 * Sends the pilot's ship to one of its bookmarks, as the bookmark's Approach Location does: by the bookmark's number
 * alone. Fails as the call fails, and before it for what is no bookmark's number and for a pilot that is not in
 * space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function approachBookmark(act: Ask, flightNow: () => Promise<FlightNow>, bookmarkID: number): Promise<void> {
  await aPlaceToWarpTo(flightNow, bookmarkID, "A bookmark is required.");
  await act("beyonce", "CmdGotoBookmark", [bookmarkID]);
}

/**
 * Aligns the pilot's ship to one of its bookmarks, as the bookmark's Align to does: the bookmark by name and no
 * thing. Fails as the call fails, and before it for what is no bookmark's number and for a pilot that is not in
 * space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER A SHIP ALIGNED.
 */
export async function alignToBookmark(act: Ask, flightNow: () => Promise<FlightNow>, bookmarkID: number): Promise<void> {
  await aPlaceToWarpTo(flightNow, bookmarkID, "A bookmark is required.");
  await act("beyonce", "CmdAlignTo", [], { dstID: null, bookmarkID });
}

/**
 * Warps the pilot's ship to one of its launches, as the journal does: by the launch's own number (not its
 * container's, which is on no grid the pilot is on), with nothing else. Fails as the call fails, and before it for
 * what is no launch's number and for a pilot that is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function warpToLaunch(act: Ask, flightNow: () => Promise<FlightNow>, launchID: number): Promise<void> {
  await aPlaceToWarpTo(flightNow, launchID, "A launch is required.");
  await act("beyonce", "CmdWarpToStuff", ["launch", launchID]);
}

/**
 * Warps the pilot's ship to a thing in space, as the client's menu does: to stop `range` metres short of it, one
 * of the seven distances the menu offers. Fails as the call fails, and before it where the range is none of
 * those, or the client sends nothing: for what is no thing, for a pilot that is not in space, and for the pilot's
 * own ship.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function warpToItem(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number, range: number): Promise<void> {
  if (!WARP_RANGES_M.includes(range)) {
    throw new Error("The warp range must be one of the offered distances.");
  }
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot warp to itself.");
  await act("beyonce", "CmdWarpToStuff", ["item", targetID], { minRange: range });
}

/**
 * Warps the pilot's ship to a thing as the client's autopilot does: by the autopilot's own call, with the thing
 * alone. The server stops the ship ten kilometres short. Fails as the call fails, and before it for what is no
 * thing, for a pilot that is not in space, and for the pilot's own ship.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function autopilotWarp(act: Ask, flightNow: () => Promise<FlightNow>, targetID: number): Promise<void> {
  await aThingToOrderAbout(flightNow, targetID, "A ship cannot warp to itself.");
  await act("beyonce", "CmdWarpToStuffAutopilot", [targetID]);
}

/**
 * Warps the pilot's ship to a member of its fleet, as the fleet's menu does: by the member's own number (a pilot's,
 * not a ship's), at the range chosen (Warp to Member at the pilot's default, its submenu at one of the seven: menusvc.py
 * FleetMenu; nought where none is said) and nothing else; the transport sends the range as the float the client's
 * menu makes it. Fails as the call fails, and before it where the range is none of those, for what is no pilot's
 * number and for a pilot that is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL. The member need not be on this grid.
 */
export async function warpToFleetMember(act: Ask, flightNow: () => Promise<FlightNow>, characterID: number, range = 0): Promise<void> {
  if (!WARP_RANGES_M.includes(range)) {
    throw new Error("The warp range must be one of the offered distances.");
  }
  await aPlaceToWarpTo(flightNow, characterID, "A fleet member is required.");
  await act("beyonce", "CmdWarpToStuff", ["char", characterID], { minRange: range });
}

/**
 * Warps the pilot's fleet, wing or squad to a member of it, as the fleet's menu does for a commander
 * (menusvc.WarpFleetToMember, 2753 to 2760: michelle.CmdWarpToStuff('char', charID, minRange=warpRange, fleet=True),
 * to which michelle adds the pilot's formation, SetFleetFormationSettings 755 to 760): the member's number, the range
 * chosen, fleet=True, and the formation a pilot has who has chosen none. Warp Fleet, Warp Wing and Warp Squad to
 * Member are the one call: which of the fleet goes with the pilot is the server's, by the pilot's command. Fails as
 * Warp to Member fails.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function warpFleetToMember(act: Ask, flightNow: () => Promise<FlightNow>, characterID: number, range = 0): Promise<void> {
  if (!WARP_RANGES_M.includes(range)) {
    throw new Error("The warp range must be one of the offered distances.");
  }
  await aPlaceToWarpTo(flightNow, characterID, "A fleet member is required.");
  await act("beyonce", "CmdWarpToStuff", ["char", characterID], { minRange: range, fleet: true, fleetFormationSettings: { ...FORMATION_OF_NO_CHOICE } });
}

/** A fleet member's cyno as fleetSvc keeps it (OnFleetJumpBeaconModuleChange): its system, the beacon and its type. */
export interface MemberBeacon {
  readonly solarSystemID: number;
  readonly beaconID: number;
  readonly typeID: number | null;
}

/**
 * Jumps the pilot's ship to a fleet member's cyno, as the fleet menu's Jump To does (menusvc.JumpToMember, 2643 to 2650;
 * cynoTravelSvc.JumpToFleetModuleBeacon, 30 to 37: bp.CmdJumpToFleetModuleBeacon(charID, beaconID, solarsystemID), a
 * change of session), `group` the Conduit Jump To that takes the fleet's members in range along
 * (GroupJumpToFleetModuleBeacon, 97 to 104), and Bridge To (BridgeToFleetModuleBeacon, 57 to 63:
 * bp.CmdBridgeToFleetModuleBeacon, the same three, no change of session) where `bridge`. Fails as the call fails,
 * and before it for a member that is no character's number, a beacon the page has none of, and a ship not in space.
 *
 * ⚠ A JUMP'S CALL COMING BACK IS THE SESSION IN THE BEACON'S SYSTEM: the BFF answers once the ship is usable there.
 */
export async function toMemberBeacon(act: Ask, flightNow: () => Promise<FlightNow>, characterID: number, beacon: MemberBeacon | null, how: "jump" | "group" | "bridge"): Promise<void> {
  await aPlaceToWarpTo(flightNow, characterID, "A fleet member is required.");
  if (beacon === null || !isAnID(beacon.beaconID) || !isAnID(beacon.solarSystemID)) {
    throw new Error("That member has no cyno lit.");
  }
  const method = how === "jump" ? "CmdJumpToFleetModuleBeacon" : how === "group" ? "CmdGroupJumpToFleetModuleBeacon" : "CmdBridgeToFleetModuleBeacon";
  await act("beyonce", method, [characterID, beacon.beaconID, beacon.solarSystemID]);
}

/** The fleet formation a pilot has who has chosen none: a point, the first spacing and the first size (evefleet: POINT, FLEET_FORMATION_SPACING[0], FLEET_FORMATION_SIZE[0]). */
const FORMATION_OF_NO_CHOICE = Object.freeze({ formationType: 0, formationSpacing: 1000, formationSize: 10000 });

/**
 * Warps the pilot's ship to a mission's marked spot, as the client's menu does: by asking the spot's agent, on
 * that agent's own object, with the spot's type and number as the journal has them, the range chosen (nought where
 * none is), no fleet's word, the other agent the bookmark names or none, and a fleet's formation settings as a pilot
 * has them who has chosen none. The range goes as a float where the warp is the bookmark's menu's (menusvc 1481 to
 * 1483: float(defaultWarpDist), and WarpToMenu's float(ranges[i])), and as a whole number else, as the surroundings'
 * and bookmarkUtil's entries send their nought (listSurroundingsBtn 336, bookmarkUtil 38); Tranquility's recordings
 * have both. Fails as the call fails, and before it for what is no spot of a mission's and for a pilot that is not in
 * space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN OR NOT, AND NEVER AN ARRIVAL. The server answers nothing either way.
 */
export async function warpToMissionLocation(act: Ask, flightNow: () => Promise<FlightNow>, spot: Pick<MissionSpot, "agentID" | "locationType" | "locationNumber" | "referringAgentID">, range = 0, fromBookmarkMenu = false): Promise<void> {
  if (!isAnID(spot.agentID) || spot.locationType === "" || !Number.isSafeInteger(spot.locationNumber)) {
    throw new Error("That is no spot of a mission's.");
  }
  if (!WARP_RANGES_M.includes(range)) {
    throw new Error("The warp range must be one of the offered distances.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  const warpRange: JsonValue = fromBookmarkMenu ? { type: "real", value: range } : range;
  await act("agentMgr", "WarpToLocation", [spot.locationType, spot.locationNumber, warpRange, false, spot.referringAgentID ?? null, { ...FORMATION_OF_NO_CHOICE }], undefined, spot.agentID);
}

/**
 * Sends the pilot's ship to a mission's marked spot, as Approach Location does for a mission's bookmark
 * (movementFunctions.ApproachLocation, 397 to 407): GetAgentMoniker(agentID).GotoLocation(locationType,
 * locationNumber, referringAgentID), on the agent's own object, with the other agent the bookmark names or none. Fails
 * as the call fails, and
 * before it for what is no spot of a mission's and for a pilot that is not in space.
 *
 * ⚠ THE CALL COMING BACK IS AN ORDER TAKEN, NEVER AN ARRIVAL.
 */
export async function approachMissionLocation(act: Ask, flightNow: () => Promise<FlightNow>, spot: Pick<MissionSpot, "agentID" | "locationType" | "locationNumber" | "referringAgentID">): Promise<void> {
  if (!isAnID(spot.agentID) || spot.locationType === "" || !Number.isSafeInteger(spot.locationNumber)) {
    throw new Error("That is no spot of a mission's.");
  }
  const now = await flightNow();
  if (!now.inSpace) {
    throw new Error("The ship is not in space; undock first.");
  }
  await act("agentMgr", "GotoLocation", [spot.locationType, spot.locationNumber, spot.referringAgentID ?? null], undefined, spot.agentID);
}
