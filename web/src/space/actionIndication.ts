// What the ship is doing, as the retail client's HUD says it.
//
// The client's HUD carries a line about the ship's own manoeuvre, a header
// and a line beneath, made from the pilot's own ball and nothing else
// (eve/client/script/parklife/spaceMgr.py, GetHeaderAndSubtextForActionIndication):
//
//   mode ORBIT, following something    "orbiting", and whom, and at what range
//   mode FOLLOW, following something   the range it was told to keep decides:
//                                        50 m (the approach range) or none: "approaching", and whom
//                                        anything else: "keeping at range", whom, and the range
//
// The range is the one in the ORDER (the ball's followRange), worded by FmtDist
// with no decimals. It is not how far away the thing is now.
//
//   mode GOTO (GetBallApproachType)    by how far the point it is flying to is:
//                                        under 1 km: nothing
//                                        up to 10,000 km: "approaching a point in space"
//                                        farther: "aligning to a point in space", until its
//                                        course is within 0.26 radians of the point; then nothing
//
//   mode WARP (IndicateWarp)           "establishing warp vector" while the ship lines up,
//                                      "warp drive active" once the warp proper begins; beneath,
//                                      where to (the thing the pilot asked to warp to, when the
//                                      server's warp is aimed at it) and how far off it still is
//
//   mode GOTO, after an align          "aligning", and what to: the client remembers what the
//   (menusvc.StoreAlignTarget)         pilot last aligned to and names it for as long as the ship
//                                      flies that course, however near or lined up it is
//
// And one that is not the ball's: for two seconds after the pilot orders a
// stop the HUD says "ship stopping" over whatever else it would say
// (eveCommands.CmdStopShip, a passing indication).
//
// And the bar the client fills while the ship lines up for a warp, under the header (spaceMgr._GetWarpProgress).
// Whenever the range or the point is not known, the caller keeps its own words.

import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import { fmtDist, type DistanceSay } from "./overview.ts";
import type { SpaceSnapshot, SpaceVector } from "../store/types.ts";

/** appConst.approachRange: the range an approach is ordered at. */
export const APPROACH_RANGE = 50;

/** appConst.maxApproachDistance: a point farther than this is aligned to, not approached. */
export const MAX_APPROACH_DISTANCE = 10_000_000;
/** spaceMgr.GetBallApproachType: a point nearer than this is not spoken of. */
export const CLOSE_DISTANCE = 1_000;
/** spaceMgr.DEGREES_15, as it is written there: a course within this of the point is lined up. */
export const ALIGNED_ANGLE = 0.26;

export type FollowKind = "orbit" | "approach" | "keepAtRange";
export type PointKind = "approachPoint" | "alignPoint";
export type ActionKind = FollowKind | PointKind;

export interface ActionIndication {
  readonly kind: FollowKind;
  /** The range in the order, in metres. */
  readonly range: number;
}

export interface PointIndication {
  readonly kind: PointKind;
}

/** After an align: what the pilot aligned to, a thing or a bookmark. */
export interface AlignIndication {
  readonly kind: "alignTo";
  /** The thing, or null for a bookmark. */
  readonly targetID: number | null;
  readonly bookmark: boolean;
}

/** The client's labels for the line beneath "aligning", after an align. */
export const ALIGN_LABELS = {
  /** {targetName} */
  location: "UI/Inflight/Messages/AligningToLocationSubText",
  bookmark: "UI/Inflight/Messages/AligningToBookmarkSubText",
  unknown: "UI/Inflight/Messages/AligningUnknownSubText",
} as const;

/** The client's label for the two seconds after a stop is ordered, and how long that is. */
export const SHIP_STOPPING_LABEL = "UI/Inflight/Messages/ShipStoppingHeader";
export const SHIP_STOPPING_MS = 2_000;

/** "Ship stopping", in the client's words when the page holds them. */
export function shipStoppingText(templates: Readonly<Record<string, string | null | undefined>>): string {
  const template = templates[SHIP_STOPPING_LABEL];
  return typeof template === "string" ? plainText(template).trim() : "Stopping the ship";
}

export type WarpKind = "warpPreparing" | "warpActive";

export interface WarpIndication {
  readonly kind: WarpKind;
  /** The thing the pilot asked to warp to, when the warp is aimed at it and it is in view; else null. */
  readonly destinationID: number | null;
  /** What a warp to a bookmark is named by, the memo's title, where the HUD names it so; else null. */
  readonly destinationName: string | null;
  /** How far the ship is from that thing or the bookmark's, or failing them from the point the warp is aimed at. */
  readonly distance: number;
  /** Whether that is to a known place (actualDestinationPosition): the client's line then has no bubble's words. */
  readonly measured: boolean;
}

/** The client's labels for a warp: the two headers, and what the line beneath is put together from. */
export const WARP_LABELS = {
  warpPreparing: "UI/Inflight/Messages/WarpDrivePreparing",
  warpActive: "UI/Inflight/Messages/WarpDriveActive",
  /** {destinationName} */
  destination: "UI/Inflight/Messages/WarpDestination",
  /** {warpDestination} {distance}: the destination's line and the distance's. */
  withDistance: "UI/Inflight/Messages/WarpIndicatorWithDistance",
  /** The same, for a warp that is not aimed at a thing the client can name. */
  withDistanceAndBubble: "UI/Inflight/Messages/WarpIndicatorWithDistanceAndBubble",
  /** {distToItem} */
  distance: "UI/Inflight/ActiveItem/SelectedItemDistance",
} as const;

/** The client's labels: a header with no parameters, and the line beneath it. */
export const INDICATION_LABELS: Readonly<Record<ActionKind, { readonly header: string; readonly sub: string }>> = {
  orbit: { header: "UI/Inflight/Messages/OrbitingHeader", sub: "UI/Inflight/Messages/OrbitingSubText" },
  approach: { header: "UI/Inflight/Messages/ApproachingHeader", sub: "UI/Inflight/Messages/ApproachingSubText" },
  keepAtRange: { header: "UI/Inflight/Messages/KeepingAtRangeHeader", sub: "UI/Inflight/Messages/KeepingAtRangeSubText" },
  approachPoint: { header: "UI/Inflight/Messages/ApproachingHeader", sub: "UI/Inflight/Messages/ApproachingPointSubText" },
  alignPoint: { header: "UI/Inflight/Messages/AligningHeader", sub: "UI/Inflight/Messages/AligningToPointSubText" },
};

/** Every label above, once each, to ask the BFF for. */
export const INDICATION_WORD_LABELS: readonly string[] = [
  ...new Set([
    ...Object.values(INDICATION_LABELS).flatMap(({ header, sub }) => [header, sub]),
    ...Object.values(WARP_LABELS),
    ...Object.values(ALIGN_LABELS),
    SHIP_STOPPING_LABEL,
    "UI/Inflight/CapsuleEjected", "UI/Inflight/SafeLogoff", "UI/Inflight/EjectFromShip", "UI/Inflight/BoardShip", "UI/Inflight/SelfDestructShipOrPod", "UI/Inflight/AbortSelfDestruct", "UI/Inflight/ActivateAutopilot", "UI/Inflight/ResetCamera", "UI/Commands/ReconnectToLostDrones", "UI/Inflight/SetAsCameraInterest",
    // the moon radial's second level (spaceView openRadial, secondaryGroupActions[groupMoon])
    "UI/Inflight/WarpToMoonMiningPoint", "UI/Inflight/MoonMiningPoint",
    // the own ship radial default-distance slices (GetOrbitOption / GetKeepAtRangeOption / GetWarpToOption, isMyShip)
    "UI/Inflight/SetDefaultOrbitDistanceShort", "UI/Inflight/SetDefaultKeepAtRangeDistanceShort", "UI/Inflight/SetDefaultWarpWithinDistanceShort",
    // Selected Item disabled-button reasons (baseCheckers IsYourShip, celestialCheckers AlreadyLookingAtItem)
    "UI/Menusvc/MenuHints/IsYourShip", "UI/Menusvc/MenuHints/AlreadyLookingAtItem", "UI/Menusvc/MenuHints/NotInApproachRange", "UI/Menusvc/MenuHints/NotInOrbitRange", "UI/Menusvc/MenuHints/NotInWarpRange", "UI/Moonmining/MoonHasNoMiningPoint",
    // the own ship's open-hold entries (spaceView OPEN_HOLD_ENTRIES)
    "UI/Commands/OpenCargoHold", "UI/Commands/OpenDroneBay", "UI/Commands/OpenFighterBay", "UI/Commands/OpenShipMaintenanceBay", "UI/Commands/OpenFleetHangar", "UI/Commands/OpenFuelBay", "UI/Commands/OpenGeneralMiningHold", "UI/Commands/OpenGasHold", "UI/Commands/OpenMineralHold", "UI/Commands/OpenSalvageHold", "UI/Commands/OpenShipHold", "UI/Commands/OpenSmallShipHold", "UI/Commands/OpenMediumShipHold", "UI/Commands/OpenLargeShipHold", "UI/Commands/OpenIndustrialShipHold", "UI/Commands/OpenAmmoHold", "UI/Commands/OpenCommandCenterHold", "UI/PI/Common/OpenPlanetaryCommoditiesHold", "UI/Commands/OpenQuafeBay", "UI/Commands/OpenCorpseBay", "UI/Commands/OpenBoosterBay", "UI/Commands/OpenSubsystemBay", "UI/Commands/OpenMobileDepotHold", "UI/Commands/OpenInfrastructureHold", "UI/Commands/OpenExpeditionHold",
    // the location banner on arriving out of warp (play/locationBanner.ts)
    "UI/Mining/DepletionStatusFormatted", "UI/Mining/DepletionStatusLargelyUntouched", "UI/Mining/DepletionStatusPartiallyMined",
    "UI/Mining/DepletionStatusHeavilyMined", "UI/Mining/DepletionStatusFullyDepleted", "UI/PI/PlanetType/Barren", "UI/PI/PlanetType/Storm",
    "UI/PI/PlanetType/Temperate", "UI/PI/PlanetType/Ice", "UI/PI/PlanetType/Gas", "UI/PI/PlanetType/Plasma", "UI/PI/PlanetType/Oceanic",
    "UI/PI/PlanetType/Lava", "UI/PI/PlanetType/Shattered", "UI/PI/PlanetType/Scorched",
    // the Selected Item window's hint with nothing selected (SelectedItemWnd.SetNoContentHint)
    "UI/Inflight/ActiveItem/NoObjectSelected",
  ]),
];

/**
 * What a ship that was aligned to something is doing: aligning to it, for as
 * long as the snapshot says it flies that course. Null otherwise.
 */
export function alignIndication(snapshot: SpaceSnapshot | null | undefined): AlignIndication | null {
  const ship = snapshot?.ship ?? null;
  const target = ship?.alignTarget ?? null;
  if (!ship || !target || (ship.mode ?? "").trim().toUpperCase() !== "GOTO") {
    return null;
  }
  return { kind: "alignTo", targetID: target.bookmark ? null : target.itemID, bookmark: target.bookmark };
}

/**
 * The line beneath "aligning" after an align. To a thing the caller can name,
 * the client's line is the name alone, so it is given with the header before
 * it; to a bookmark, or to something the caller cannot name, the client's line
 * says the whole of it.
 */
export function alignText(indication: AlignIndication, targetName: string | null, templates: Readonly<Record<string, string | null | undefined>>): string {
  const worded = (label: string, args: Record<string, string>, own: string): string => {
    const template = templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })).trim() : own;
  };
  if (indication.bookmark) {
    return worded(ALIGN_LABELS.bookmark, {}, "Turning towards a saved location");
  }
  if (targetName === null) {
    return worded(ALIGN_LABELS.unknown, {}, "Turning towards somewhere out of sight");
  }
  return `${indicationHeader("alignTo", templates)} ${worded(ALIGN_LABELS.location, { targetName }, targetName)}`;
}

/**
 * What a ship in warp, or lining up for one, is doing (spaceMgr.IndicateWarp);
 * null when it is not in warp, or the server has not said where the warp is aimed.
 */
export function warpIndication(snapshot: SpaceSnapshot | null | undefined): WarpIndication | null {
  const ship = snapshot?.ship ?? null;
  const warp = ship?.warp ?? null;
  if (!snapshot || !ship || !warp || (ship.mode ?? "").trim().toUpperCase() !== "WARP" || !warp.point) {
    return null;
  }
  const aim = warpAim(snapshot, warp);
  const distance = Math.hypot(aim.to.x - ship.position.x, aim.to.y - ship.position.y, aim.to.z - ship.position.z);
  return {
    kind: warp.preparing ? "warpPreparing" : "warpActive",
    destinationID: aim.thingID,
    destinationName: warp.destinationName ?? null,
    distance,
    measured: aim.measured,
  };
}

/**
 * Where a warp's way and distance are measured to (IndicateWarp, _GetWarpProgress): the place the transport says
 * (the thing, or a bookmark's thing or place), else the thing the warp is aimed at where it is in view, else the
 * warp's own point. `measured` where it is one of the first two.
 */
function warpAim(snapshot: SpaceSnapshot, warp: NonNullable<NonNullable<SpaceSnapshot["ship"]>["warp"]>): { readonly to: SpaceVector; readonly thingID: number | null; readonly measured: boolean } {
  const thing = warp.destinationID === null ? null : (snapshot.entities.find((entity) => entity.itemID === warp.destinationID) ?? null);
  if (warp.actualPoint) return { to: warp.actualPoint, thingID: thing ? thing.itemID : null, measured: true };
  if (thing) return { to: thing.position, thingID: thing.itemID, measured: true };
  return { to: warp.point as SpaceVector, thingID: null, measured: false };
}

/** MAX_ALIGN_TICKS: after so many ticks of lining up the warp begins anyway (Ball::IsAlignedForWarp). */
export const MAX_ALIGN_TICKS = 180;

/**
 * How full the client's bar under "establishing warp vector" is (spaceMgr._GetWarpProgress, set by IndicateWarp
 * while the ball's effect stamp is below zero): the speed as a share of three quarters of the top speed, and the
 * course's lining up with the way to the warp's destination ((cosine + 1) / 1.99, or nothing under a hundredth of
 * the top speed), the lesser of the two cubed; or the share of the 180 ticks the ship has spent lining up, where that
 * is more. Between 0 and 1 (the HUD's controller holds it there); the bar is not drawn at 0. Null when the ship is
 * not lining up for a warp, or what it is made of is not known. The client's vectors are geo2's; here they are
 * doubles.
 */
export function warpProgress(snapshot: SpaceSnapshot | null | undefined): number | null {
  const ship = snapshot?.ship ?? null;
  const warp = ship?.warp ?? null;
  if (!snapshot || !ship || !warp || !warp.preparing || !warp.point || typeof warp.effectStamp !== "number") return null;
  const max = ship.maxVelocity;
  if (typeof max !== "number" || !(max > 0)) return null;
  const v = ship.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(speed)) return null;
  const speedFraction = Math.min(1.0, speed / max);
  const speedProgress = Math.min(speedFraction / 0.75, 1.0);
  // The way to the place the warp is measured to, else to the warp's own point.
  const to = warpAim(snapshot, warp).to;
  const way = { x: to.x - ship.position.x, y: to.y - ship.position.y, z: to.z - ship.position.z };
  const wayLength = Math.hypot(way.x, way.y, way.z);
  const dotProduct = speedFraction > 0.01 && wayLength > 0
    ? (v.x * way.x + v.y * way.y + v.z * way.z) / (speed * wayLength)
    : -1.0;
  const angleProgress = (dotProduct + 1.0) / 1.99;
  const autoWarpProgress = Math.min(-warp.effectStamp / MAX_ALIGN_TICKS, 1.0);
  const overall = Math.max(Math.min(speedProgress, angleProgress) ** 3, autoWarpProgress);
  return Math.min(1.0, Math.max(0, overall));
}

/**
 * What a ship flying to a point is doing, by how far the point is and whether
 * its course is on it (spaceMgr.GetBallApproachType); null when the client
 * says nothing, or the ship is not flying to a point, or the point is not known.
 */
export function pointIndication(
  mode: string | null | undefined,
  position: SpaceVector | null | undefined,
  velocity: SpaceVector | null | undefined,
  gotoPoint: SpaceVector | null | undefined,
): PointIndication | null {
  if ((mode ?? "").trim().toUpperCase() !== "GOTO" || !position || !gotoPoint) {
    return null;
  }
  const to = { x: gotoPoint.x - position.x, y: gotoPoint.y - position.y, z: gotoPoint.z - position.z };
  const distance = Math.hypot(to.x, to.y, to.z);
  if (!Number.isFinite(distance) || distance < CLOSE_DISTANCE) {
    return null;
  }
  if (distance <= MAX_APPROACH_DISTANCE) {
    return { kind: "approachPoint" };
  }
  // The angle between where it is heading and where the point is. A ship that is not moving heads nowhere,
  // which counts as a right angle off.
  const speed = velocity ? Math.hypot(velocity.x, velocity.y, velocity.z) : 0;
  const dot = velocity && speed > 0 ? (velocity.x * to.x + velocity.y * to.y + velocity.z * to.z) / (speed * distance) : 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  return angle < ALIGNED_ANGLE ? null : { kind: "alignPoint" };
}

/**
 * What the ship is doing to the thing it follows, or null when the client's
 * rule has nothing to say: it follows nothing, its mode is neither of the two,
 * or the range is not known.
 */
export function actionIndication(mode: string | null | undefined, followID: number | null | undefined, followRange: number | null | undefined): ActionIndication | null {
  if (followID === null || followID === undefined || followID === 0) {
    return null;
  }
  if (typeof followRange !== "number" || !Number.isFinite(followRange)) {
    return null;
  }
  const key = (mode ?? "").trim().toUpperCase();
  if (key === "ORBIT") {
    return { kind: "orbit", range: followRange };
  }
  if (key === "FOLLOW") {
    return { kind: followRange === APPROACH_RANGE || followRange === 0 ? "approach" : "keepAtRange", range: followRange };
  }
  return null;
}

/**
 * The ball the snapshot's own ship approaches, as IsApproachingBall reads the
 * ship's ball (movementFunctions.py 184 to 189): its mode is FOLLOW and this is
 * what it follows, at any range. Null where it follows nothing so.
 */
export function approachedBallID(snapshot: SpaceSnapshot | null | undefined): number | null {
  const ship = snapshot?.ship ?? null;
  if (!snapshot || !ship || (ship.mode ?? "").trim().toUpperCase() !== "FOLLOW") {
    return null;
  }
  const followID = snapshot.entities.find((entity) => entity.itemID === ship.itemID)?.targetEntityID ?? null;
  return followID === null || followID === 0 ? null : followID;
}

/**
 * The indication for the snapshot's own ship: what it is doing to the thing it
 * follows (and whom: its mode and the range in its order from the ship, whom
 * from the ship's own row), or failing that what it is doing about the point
 * it is flying to.
 */
export function shipIndication(
  snapshot: SpaceSnapshot | null | undefined,
): (ActionIndication & { readonly followID: number }) | PointIndication | WarpIndication | AlignIndication | null {
  const ship = snapshot?.ship ?? null;
  if (!snapshot || !ship) {
    return null;
  }
  const warp = warpIndication(snapshot);
  if (warp !== null) {
    return warp;
  }
  const followID = snapshot.entities.find((entity) => entity.itemID === ship.itemID)?.targetEntityID ?? null;
  const indication = actionIndication(ship.mode, followID, ship.followRange);
  if (indication !== null && followID !== null) {
    return { ...indication, followID };
  }
  // After an align the client says "aligning" however near the point or lined up the ship is.
  return alignIndication(snapshot) ?? pointIndication(ship.mode, ship.position, ship.velocity, ship.gotoPoint);
}

/** This page's own words, for when the client's are not to hand. */
const OWN_HEADER: Readonly<Record<ActionKind | WarpKind | "alignTo", string>> = {
  alignTo: "Aligning",
  orbit: "Orbiting",
  approach: "Approaching",
  keepAtRange: "Holding range on",
  approachPoint: "Approaching",
  alignPoint: "Aligning",
  warpPreparing: "Lining up for warp",
  warpActive: "In warp",
};

/**
 * The line beneath the header for a warp: where to, and how far off it still
 * is. In the client's words when the page holds all four of the labels it is
 * put together from, the page's own otherwise. Where the client breaks the
 * line, the parts are set apart by " · ". `destinationName` is what the
 * caller calls the thing the warp is aimed at (or the bookmark's memo title the
 * indication carries), or null when it names none. The distance's words are the
 * bubble's where the warp is measured to no known place.
 */
export function warpText(
  indication: WarpIndication,
  destinationName: string | null,
  templates: Readonly<Record<string, string | null | undefined>>,
  say?: DistanceSay,
): string {
  const named = destinationName !== null;
  const far = fmtDist(indication.distance, 2, say);
  const [destination, withDistance, withBubble, distance] = [WARP_LABELS.destination, WARP_LABELS.withDistance, WARP_LABELS.withDistanceAndBubble, WARP_LABELS.distance].map((label) => templates[label]);
  if (typeof destination !== "string" || typeof withDistance !== "string" || typeof withBubble !== "string" || typeof distance !== "string") {
    const parts = [named ? `To ${destinationName}` : null, indication.distance > 0 ? `${far} to go` : null];
    return parts.filter((part) => part !== null).join(" · ");
  }
  const none = { nameOf: () => "" };
  const where = named ? `${formatTemplate(destination, { destinationName }, none)}<br>` : "";
  const text = indication.distance > 0
    ? formatTemplate(indication.measured ? withDistance : withBubble, { warpDestination: where, distance: formatTemplate(distance, { distToItem: far }, none) }, none)
    : where;
  return plainText(text).split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join(" · ");
}
const OWN_POINT: Readonly<Record<PointKind, string>> = { approachPoint: "Heading for a point in space", alignPoint: "Turning towards a point in space" };

/**
 * The line beneath the header for a ship flying to a point. The client's says
 * the whole of it ("approaching a point in space"), so where there is room for
 * one line this is the one.
 */
export function pointText(kind: PointKind, templates: Readonly<Record<string, string | null | undefined>>): string {
  const template = templates[INDICATION_LABELS[kind].sub];
  return typeof template === "string" ? plainText(template).trim() : OWN_POINT[kind];
}

export interface IndicationText {
  readonly header: string;
  readonly sub: string;
}

/** The header alone, for where there is room for a word and no more. */
export function indicationHeader(kind: ActionKind | WarpKind | "alignTo", templates: Readonly<Record<string, string | null | undefined>>): string {
  const label = kind === "warpPreparing" || kind === "warpActive" ? WARP_LABELS[kind] : INDICATION_LABELS[kind === "alignTo" ? "alignPoint" : kind].header;
  const template = templates[label];
  return typeof template === "string" ? plainText(template).trim() : OWN_HEADER[kind];
}

/**
 * The header and the line beneath it, in the client's own words when the page
 * holds them. `targetName` is what the caller calls the thing followed.
 */
export function indicationText(
  indication: ActionIndication,
  targetName: string,
  templates: Readonly<Record<string, string | null | undefined>>,
  say?: DistanceSay,
): IndicationText {
  const labels = INDICATION_LABELS[indication.kind];
  const rangeText = fmtDist(indication.range, 0, say);
  const worded = (label: string, own: string): string => {
    const template = templates[label];
    if (typeof template !== "string") {
      return own;
    }
    return plainText(formatTemplate(template, { targetName, rangeText }, { nameOf: () => "" })).trim();
  };
  return {
    header: worded(labels.header, OWN_HEADER[indication.kind]),
    sub: worded(labels.sub, indication.kind === "approach" ? targetName : `${targetName}, at ${rangeText}`),
  };
}
