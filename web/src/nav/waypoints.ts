// The client's waypoints, as its star map keeps them (starMapSvc.py SetWaypoint, SetWaypoints, GetWaypoints,
// ClearWaypoints, RemoveWaypointIfFirst and the first lines of UpdateRoute, 2301 to 2448):
//
//   a list of places kept for the character (the char UI setting autopilot_waypoints), the destination its last, the
//   route going through them in order. Set Destination is SetWaypoint with the others cleared; Add Waypoint puts one
//   at the end; Remove Waypoint takes one out (ClearWaypoints(locationID)); Clear All Waypoints takes them all.
//
//   SetWaypoint refuses a place that is no destination (the Command message with UI/Map/StarMap/CantSetWaypoint), a
//   place already on the list (WaypointAlreadySet), and the pilot's own constellation or region
//   (WaypointAlreadyInConstellation, WaypointAlreadyInRegion).
//
//   Whenever the pilot's place changes (UpdateRoute, from the autopilot's OnSessionChanged), a first waypoint that is
//   where the pilot is now (its structure, station, system, constellation or region) is taken off, and the autopilot,
//   where it is on, is switched off: "waypoint reached", where the route panel's Disable Autopilot at Each Waypoint is
//   ticked, as it is until the pilot unticks it (app/autopilotStopAtEachWaypoint.ts); unticked, it flies on.
//
// The page keeps the list in this browser, for the character, as the client keeps it in its own settings.

/** The client's notify messages for a waypoint it would not set. */
export type WaypointRefusal = "CantSetWaypoint" | "WaypointAlreadySet" | "WaypointAlreadyInConstellation" | "WaypointAlreadyInRegion";

/** Where the pilot is: the client's session's structureid, stationid, solarsystemid2, constellationid and regionid. */
export interface PilotPlace {
  readonly structureID: number | null;
  readonly stationID: number | null;
  readonly solarSystemID: number | null;
  readonly constellationID?: number | null;
  readonly regionID?: number | null;
}

/** idCheckers.IsPlayerItem (69 to 70): minPlayerItem (inventorycommon/const.py 83) and up, the number a structure has. */
export function isPlayerItemID(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 100_000_000;
}

/**
 * _IsDestinationValid (2301 to 2318), as far as the page can tell: a station or a solar system of known space by the
 * number, and a structure where the structure directory knows it (`knownStructure`: its GetStructureInfo answered,
 * structureDirectory.py 33 to 39). (The client also refuses a deprecated station and a Triglavian system from outside
 * Pochven, which want facts read first: destinationValid, below.)
 */
export function isWaypointPlace(id: number, knownStructure = false): boolean {
  if (!Number.isSafeInteger(id)) return false;
  if (knownStructure && isPlayerItemID(id)) return true;
  return (id >= 60_000_000 && id < 64_000_000) || (id >= 30_000_000 && id < 31_000_000);
}

/** idCheckers.IsDeprecatedStation (452 to 460): the outposts' and the conquerable stations' types (inventorycommon/const.py). */
const DEPRECATED_STATION_TYPES: ReadonlySet<number> = new Set([21642, 21644, 21645, 21646, 12242, 12294, 12295]);

export function isDeprecatedStationType(typeID: number): boolean {
  return DEPRECATED_STATION_TYPES.has(typeID);
}

/** What _IsDestinationValid reads of the place and of the map, as the page could read it. */
export interface DestinationFacts {
  /**
   * The place as a station of the map: its system and its type; null where the map has no such station; "unread"
   * where the map could not be asked (then nothing is refused for it).
   */
  readonly station: { readonly solarSystemID: number; readonly stationTypeID: number | null } | null | "unread";
  /** Whether the structure directory knows the place. */
  readonly knownStructure: boolean;
  /** Whether a system is the Triglavian Collective's; null where the map could not be read (none taken for one). */
  readonly isTriglavian: ((systemID: number) => boolean) | null;
  /** The pilot's system (session.solarsystemid2). */
  readonly currentSystemID: number | null;
}

/**
 * _IsDestinationValid (starMapSvc.py 2301 to 2318). (Its first test, systemExclusions.IsValidDestination, lets every
 * place through while its bypass is on, as it is from the start.) A station of the map: no deprecated station, none in
 * a Triglavian system from outside them, and one in the pilot's system or known space. Anything else: no Triglavian
 * system from outside them; a solar system of known space; else a structure the directory knows.
 */
export function destinationValid(id: number, facts: DestinationFacts): boolean {
  const triglavian = (systemID: number | null): boolean => systemID !== null && facts.isTriglavian !== null && facts.isTriglavian(systemID);
  const isKnownSpaceSystem = (systemID: number): boolean => systemID >= 30_000_000 && systemID <= 30_999_999;
  if (facts.station === "unread") return true;
  if (facts.station !== null) {
    if (facts.station.stationTypeID !== null && isDeprecatedStationType(facts.station.stationTypeID)) return false;
    const systemID = facts.station.solarSystemID;
    if (triglavian(systemID) && !triglavian(facts.currentSystemID)) return false;
    return systemID === facts.currentSystemID || isKnownSpaceSystem(systemID);
  }
  if (triglavian(id) && !triglavian(facts.currentSystemID)) return false;
  if (isKnownSpaceSystem(id)) return true;
  return facts.knownStructure;
}

/** The name kind a waypoint is named by: a structure's, a station's or a solar system's. */
export function waypointNameKind(id: number): "structure" | "station" | "system" {
  return isPlayerItemID(id) ? "structure" : id >= 60_000_000 ? "station" : "system";
}

/** SetWaypoint (2327 to 2349): the list with the place put on it, or the client's refusal. */
export function withWaypoint(
  waypoints: readonly number[],
  destinationID: number,
  how: { readonly clearOthers?: boolean; readonly first?: boolean },
  here: PilotPlace,
  valid: boolean = isWaypointPlace(destinationID),
): { readonly waypoints: readonly number[] } | { readonly refused: WaypointRefusal } {
  if (!valid) return { refused: "CantSetWaypoint" };
  const list = how.clearOthers === true ? [] : [...waypoints];
  if (list.includes(destinationID)) return { refused: "WaypointAlreadySet" };
  if (here.constellationID != null && destinationID === here.constellationID) return { refused: "WaypointAlreadyInConstellation" };
  if (here.regionID != null && destinationID === here.regionID) return { refused: "WaypointAlreadyInRegion" };
  if (how.first === true) list.unshift(destinationID);
  else list.push(destinationID);
  return { waypoints: list };
}

/** ClearWaypoints (2379 to 2405): one place taken off, where it is on the list, or every one. */
export function withoutWaypoint(waypoints: readonly number[], locationID: number | null): readonly number[] {
  if (locationID === null) return [];
  return waypoints.includes(locationID) ? waypoints.filter((id) => id !== locationID) : waypoints;
}

/**
 * UpdateRoute (2441 to 2448): the list with its first place taken off where the pilot is there now; null where the
 * first place is not where the pilot is.
 */
export function afterArriving(waypoints: readonly number[], here: PilotPlace): readonly number[] | null {
  if (waypoints.length === 0) return null;
  const places = [here.structureID, here.stationID, here.solarSystemID, here.constellationID ?? null, here.regionID ?? null];
  return places.some((place) => place !== null && place === waypoints[0]) ? waypoints.slice(1) : null;
}

/** A place's route entries as a menu offers them. */
export interface RouteEntries {
  readonly setDestination: boolean;
  readonly addWaypoint: boolean;
  readonly removeWaypoint: boolean;
}

/**
 * The celestial menu's route entries (menusvc.py _CelestialMenu, 2003 to 2008, by celestialCheckers.py), which a
 * place's Location menu is in the windows that list places (the market's orders, entries.py GetMenu, 111 to 123):
 * Set Destination where the place can be a waypoint, is not the system the pilot is in and is not the route's last
 * waypoint (OfferSetDestination, 1354 to 1362); Add Waypoint where it can be one and is not one (OfferAddWaypoint,
 * 440 to 445), else Remove Waypoint where it is one.
 */
export function celestialRouteEntries(placeID: number, canBeWaypoint: boolean, currentSystemID: number | null, waypoints: readonly number[]): RouteEntries {
  const isWaypoint = waypoints.includes(placeID);
  return {
    setDestination: canBeWaypoint && placeID !== currentSystemID && waypoints.at(-1) !== placeID,
    addWaypoint: canBeWaypoint && !isWaypoint,
    removeWaypoint: !(canBeWaypoint && !isWaypoint) && isWaypoint,
  };
}

/**
 * The route window's drag and drop (autopilotSettings.py ChangeWaypointSorting, 71 to 97): the waypoint at `index`
 * taken out and put back where the waypoint let go on stood, which is before it; last where it was let go on no
 * waypoint (`orderID` -1). Null for an index that is no waypoint's, where the client changes nothing.
 */
export function movedWaypoint(waypoints: readonly number[], index: number, orderID: number): readonly number[] | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= waypoints.length) return null;
  const rest = [...waypoints];
  const [moved] = rest.splice(index, 1);
  let at = index < orderID ? orderID - 1 : orderID;
  if (at === -1) at = rest.length;
  rest.splice(Math.max(0, Math.min(at, rest.length)), 0, moved!);
  return rest;
}

const KEPT = "evejs.autopilot_waypoints.";

/**
 * The character's waypoints as this browser keeps them; none where nothing is kept, or it cannot be read. A structure
 * kept is taken as it was set. (The client asks its directory again for each on every GetWaypoints, 2370 to 2376, and
 * drops the whole list where one is gone; the page does not ask again.)
 */
export function readWaypoints(characterID: number): readonly number[] {
  try {
    const raw = globalThis.localStorage?.getItem(`${KEPT}${characterID}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number" && (isWaypointPlace(id) || isPlayerItemID(id))) : [];
  } catch {
    return [];
  }
}

/** The character's waypoints kept in this browser (SetCharUiSetting('autopilot_waypoints', ...)). */
export function keepWaypoints(characterID: number, waypoints: readonly number[]): void {
  try {
    globalThis.localStorage?.setItem(`${KEPT}${characterID}`, JSON.stringify(waypoints));
  } catch {
    // Not kept: the list holds for this page's life.
  }
}
