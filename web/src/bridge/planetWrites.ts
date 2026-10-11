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
// A RESTART OF AN EXTRACTOR is one change there, and one here (bridge/extractorRestart.ts): the planet asked what
// the programme will yield, the extractor's routes taken off, the programme installed and the routes made anew.
// What is here is the change itself, and the routes of an extractor made anew by themselves, which mends a colony
// an earlier restart left short.
//
// The server changes the colony that the session's own character has on the planet the object is for, and no
// other (planetMgrService.Handle_UserUpdateNetwork). Either transport carries the call. THE ROUTE STILL STANDS
// (src/server.js); nothing of the page's asks it now.
//
// COMMODITIES LAUNCHED, on the same object (clientPlanet.LaunchCommodities, 394 to 424). The client refuses for
// itself a launch while the colony is being edited, of nothing, with no colony, from a pin that is no command
// centre, from one not yet ready, and of what the pin does not hold. Then:
//
//   lastLaunchTime = self.remoteHandler.UserLaunchCommodities(commandPinID, commoditiesToLaunch)
//
// the commodities a dict of quantities by type. It takes the time for the pin's own, runs its simulation to it and
// takes the commodities off its pin. In no Tranquility recording: its form is from the client's own code. The
// page's asker (a script bot's launch block) picks a command centre that holds something and is out of its
// minute, and reads the colony again afterwards. Until 2026-10-10 it went by a route too
// (POST /api/bridge/planet/commodities/launch), which stands.

import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

const CREATE_ROUTE = 6;
const REMOVE_ROUTE = 7;
/** The first of a new route's temporary ID (clientColony.GetTemporaryRouteID: (2, n)). */
const TEMPORARY_ROUTE = 2;

/** A route to be made: the pins it passes, the commodity, and how much of it a cycle. */
export interface NewRoute {
  readonly path: readonly number[];
  readonly typeID: number;
  readonly quantity: number;
}

/** A planet is a whole number above nought: refused in the route's words where it is not. */
function requirePlanet(planetID: number): void {
  if (!Number.isSafeInteger(planetID) || planetID <= 0) {
    throw new Error("A positive planetID is required.");
  }
}

/**
 * One change of a colony's network, on the planet's own object: the commands as the client serializes them, each
 * a command's number and its arguments. With no commands nothing is asked. Fails as the call fails.
 */
export async function changeColonyNetwork(act: Ask, planetID: number, changes: readonly JsonValue[]): Promise<void> {
  requirePlanet(planetID);
  // clientPlanet.RestartExtractors (865): with nothing in the stream, nothing is submitted.
  if (changes.length === 0) {
    return;
  }
  await act("planetMgr", "UserUpdateNetwork", [changes], null, planetID);
}

/**
 * An extractor's routes removed and made anew in ONE change, so that the colony is never left with the extractor
 * unrouted between two. The removals first, then the new routes, each with a temporary ID of the client's kind;
 * the server gives each its own. Fails as the call fails.
 */
export async function rerouteExtractorRoutes(act: Ask, planetID: number, removeRouteIDs: readonly number[], create: readonly NewRoute[]): Promise<void> {
  await changeColonyNetwork(act, planetID, [
    ...removeRouteIDs.map((routeID): JsonValue => [REMOVE_ROUTE, [routeID]]),
    ...create.map((route, index): JsonValue => [CREATE_ROUTE, [[TEMPORARY_ROUTE, index + 1], [...route.path], route.typeID, route.quantity]]),
  ]);
}

/**
 * What a colony's command centre holds, launched into orbit. Fails as the call fails, and before it where nothing
 * was chosen, which the client refuses itself (clientPlanet.LaunchCommodities, 397).
 *
 * ⚠ ONLY A COMMAND CENTRE CAN LAUNCH, AND NOT TWICE IN A MINUTE. The server refuses any other pin, and a centre
 * inside its minute, in its own words. It debits export tax from the wallet and leaves a container in space
 * beside the planet: a costly write that others can see, which a caller has a reason for.
 */
export async function launchCommodities(act: Ask, planetID: number, commandPinID: number, commodities: Readonly<Record<number, number>>): Promise<void> {
  requirePlanet(planetID);
  if (!Number.isSafeInteger(commandPinID) || commandPinID <= 0) {
    throw new Error("A command centre's pin is required.");
  }
  if (Object.keys(commodities).length === 0) {
    throw new Error("Nothing was chosen to launch.");
  }
  await act("planetMgr", "UserLaunchCommodities", [commandPinID, { ...commodities }], null, planetID);
}
