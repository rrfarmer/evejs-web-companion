// A colony's network changed by the page itself (the plan's Phase 6b).
//
// Until 2026-10-10 it was one route of the BFF (POST /api/bridge/planet/network/update), which checked that the
// page had said `confirm` and that the planet was one, bound the planet's object, and made one call on it.
//
// THE CALL, as the client makes it (clientPlanet._SubmitChanges, 171 to 180):
//
//   serializedChanges = self.changes.Serialize()
//   updatedColony = self.remoteHandler.UserUpdateNetwork(serializedChanges)
//
// remoteHandler is eveMoniker.GetPlanet(planetID): the planet manager's object for that planet, which the
// client's planet keeps. So the call is ON AN OBJECT, and the page's asking says which planet (`of`,
// bridge/ask.ts). Serialize (commandStream.py 185 to 232) answers a list of (the command's number, its arguments
// as a tuple):
//
//    6  CREATEROUTE     (routeID, path, typeID, quantity)   a new route's ID is (2, n), counted from one
//                                                           (clientColony.GetTemporaryRouteID); the path a
//                                                           list of pins
//    7  REMOVEROUTE     (routeID,)
//   13  INSTALLPROGRAM  (pinID, typeID, headRadius)
//
// and ten more that nothing of the page's sends. It answers the colony as it now is, which the client's planet
// takes for its own (_PrimeColony). The page's askers read the colony again instead.
//
// Recorded on Tranquility in five sessions.
//
// ⚠ A RESTART THERE IS ONE CALL, AND HERE IT IS TWO. The client's InstallProgram asks the planet what the
// programme will yield (GetProgramResultInfo), takes the extractor's routes off, installs the programme and makes
// the routes anew for the new yield, and RestartExtractors submits the lot at once: recorded as
// [(7, ..), (7, ..), (13, ..), (6, ..), (6, ..)]. The page's upkeep installs the programme, reads the colony, and
// makes the routes anew in a second change. Each change is one a client can send; the pair is not what it sends.
//
// The server changes the colony that the session's own character has on the planet the object is for, and no
// other (planetMgrService.Handle_UserUpdateNetwork). Either transport carries the call. THE ROUTE STILL STANDS
// (src/server.js); nothing of the page's asks it now.

import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

const CREATE_ROUTE = 6;
const REMOVE_ROUTE = 7;
const INSTALL_PROGRAM = 13;
/** The first of a new route's temporary ID (clientColony.GetTemporaryRouteID: (2, n)). */
const TEMPORARY_ROUTE = 2;

/** A route to be made: the pins it passes, the commodity, and how much of it a cycle. */
export interface NewRoute {
  readonly path: readonly number[];
  readonly typeID: number;
  readonly quantity: number;
}

/** One change of a colony's network, on the planet's own object. With no commands nothing is asked. */
async function changeNetwork(act: Ask, planetID: number, changes: readonly JsonValue[]): Promise<void> {
  if (!Number.isSafeInteger(planetID) || planetID <= 0) {
    throw new Error("A positive planetID is required.");
  }
  // clientPlanet.RestartExtractors (865): with nothing in the stream, nothing is submitted.
  if (changes.length === 0) {
    return;
  }
  await act("planetMgr", "UserUpdateNetwork", [changes], null, planetID);
}

/**
 * An extractor's programme installed again. Fails as the call fails.
 *
 * ⚠ THE RADIUS IS THE PIN'S OWN, SENT BACK. It is not "how wide": it is what sets how long the programme runs,
 * and the server refuses anything that is not a real number inside the drill area's bounds ("Cannot install a
 * program with a completely bonkers radius"). The client reinstalls with the extractor's own radius too, held to
 * those bounds (clientPlanet.RestartExtractors, 862).
 */
export async function restartExtractorProgram(act: Ask, planetID: number, pinID: number, resourceTypeID: number, headRadius: number): Promise<void> {
  await changeNetwork(act, planetID, [[INSTALL_PROGRAM, [pinID, resourceTypeID, headRadius]]]);
}

/**
 * An extractor's routes removed and made anew in ONE change, so that the colony is never left with the extractor
 * unrouted between two. The removals first, then the new routes, each with a temporary ID of the client's kind;
 * the server gives each its own. Fails as the call fails.
 */
export async function rerouteExtractorRoutes(act: Ask, planetID: number, removeRouteIDs: readonly number[], create: readonly NewRoute[]): Promise<void> {
  await changeNetwork(act, planetID, [
    ...removeRouteIDs.map((routeID): JsonValue => [REMOVE_ROUTE, [routeID]]),
    ...create.map((route, index): JsonValue => [CREATE_ROUTE, [[TEMPORARY_ROUTE, index + 1], [...route.path], route.typeID, route.quantity]]),
  ]);
}
