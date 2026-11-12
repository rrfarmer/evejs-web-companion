// The radial fitting layout's geometry (goal R21) — pure maths, no DOM.
//
// A real fitting window puts the SHIP in the middle and its slots on ARCS
// around it, so the eye learns one shape and reads any ship with it. This
// module turns "the server says this hull has N high slots" into "here is
// where each of those N sockets sits", and nothing else.
//
// Two rules make the layout readable across a fleet of different hulls:
//
//   1. A family's arc NEVER MOVES. High slots are always the top arc, mid
//      always the right, low always the left, rigs always the bottom. A
//      player who learns where their guns live keeps that muscle memory on
//      every hull, which is the entire point of a radial window over a table.
//   2. Sockets are spaced at a FIXED step until the arc runs out, then they
//      compress to fit. A 2-slot arc therefore looks like the first two
//      sockets of an 8-slot arc rather than two sockets flung to the horizon.
//
// The counts are the SERVER's. Nothing here knows or assumes 8/8/8 — a count
// of zero draws no arc at all, and a Rifter (4/3/3) and a Drake (8/6/5) both
// come out correct because the count is the only input.

import type { SlotFamily } from "../store/types.ts";

/** Where a family's sockets sit: which ring, and the arc's centre + width. */
export interface FamilyArc {
  /** Arc centre in degrees, 0 = twelve o'clock, growing CLOCKWISE. */
  readonly centreDegrees: number;
  /** The widest the arc may open before sockets start to compress. */
  readonly spanDegrees: number;
  /** Distance from the ship, as a fraction of the layout's radius. */
  readonly radiusFraction: number;
}

/**
 * The fixed arcs. High on top, mid right, low left, rigs beneath the ship, and
 * subsystems on an inner ring at the top (only strategic cruisers have them, so
 * they never collide with anything on a hull that does not).
 *
 * The three outer arcs are 100° wide with 20° of clear air between them. That
 * gap is deliberately WIDER than the spacing inside an arc: if it were not, the
 * last low socket and the first high socket would crowd closer than two
 * neighbours in the same family, and the three families would stop reading as
 * three families.
 */
export const FAMILY_ARCS: Readonly<Record<SlotFamily, FamilyArc>> = {
  high: { centreDegrees: 0, spanDegrees: 100, radiusFraction: 1 },
  mid: { centreDegrees: 120, spanDegrees: 100, radiusFraction: 1 },
  low: { centreDegrees: 240, spanDegrees: 100, radiusFraction: 1 },
  rig: { centreDegrees: 180, spanDegrees: 100, radiusFraction: 0.58 },
  subsystem: { centreDegrees: 0, spanDegrees: 100, radiusFraction: 0.58 },
};

/**
 * The gap between adjacent sockets on the OUTER ring while the arc has room to
 * spare. Chosen so that a full eight-socket arc exactly fills its 100° span
 * (100 / 7 ≈ 14.29), which makes "full" the natural maximum rather than an
 * arbitrary cut-off.
 */
export const PREFERRED_STEP_DEGREES = 100 / 7;

/**
 * The preferred step for a given ring, in degrees.
 *
 * The inner ring has a smaller circumference, so holding the ANGLE constant
 * would push its sockets closer together in actual pixels and overlap them.
 * Scaling the angle by 1/radiusFraction holds the ARC LENGTH constant instead,
 * which is what the eye — and the 40px touch target — actually cares about.
 * Both rings therefore end up with identical spacing on screen.
 */
export function stepDegreesFor(arc: FamilyArc): number {
  return PREFERRED_STEP_DEGREES / arc.radiusFraction;
}

/**
 * How far the outer ring sits from the centre, as a percentage of the layout
 * box. 42% leaves room for a socket's own half-width (a 52px socket reaches
 * 26px past its centre) inside a box that is only 100% wide, while still
 * giving the arcs enough circumference to keep eight sockets from touching.
 */
export const OUTER_RADIUS_PERCENT = 42;

/** One socket's placement, in the layout's own coordinate space. */
export interface SocketPlacement {
  readonly family: SlotFamily;
  readonly index: number;
  /** Angle from twelve o'clock, clockwise, in degrees. */
  readonly angleDegrees: number;
  /** Centre, as a PERCENTAGE of the layout box (0-100), so CSS can place it. */
  readonly xPercent: number;
  readonly yPercent: number;
}

/**
 * Spread `count` sockets across an arc: fixed `PREFERRED_STEP_DEGREES` apart
 * while they fit, compressed evenly into `spanDegrees` once they do not, and
 * always centred on the arc's own centre.
 *
 * A count of 1 sits exactly on the centre; a count of 0 produces nothing.
 */
export function arcAngles(arc: FamilyArc, count: number): readonly number[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const whole = Math.trunc(count);
  if (whole === 1) {
    return [arc.centreDegrees];
  }
  const step = Math.min(stepDegreesFor(arc), arc.spanDegrees / (whole - 1));
  const start = arc.centreDegrees - (step * (whole - 1)) / 2;
  const angles: number[] = [];
  for (let index = 0; index < whole; index += 1) {
    angles.push(start + step * index);
  }
  return angles;
}

/**
 * Place a family's sockets. `radiusPercent` is how far the outer ring sits
 * from the centre of the layout box, in percent — the inner ring scales off it
 * by the family's `radiusFraction`.
 */
export function placeFamily(
  family: SlotFamily,
  count: number,
  radiusPercent: number,
): readonly SocketPlacement[] {
  const arc = FAMILY_ARCS[family];
  const radius = radiusPercent * arc.radiusFraction;
  return arcAngles(arc, count).map((angleDegrees, index) => {
    const radians = (angleDegrees * Math.PI) / 180;
    return {
      family,
      index,
      angleDegrees,
      // 0° points UP, so it is (sin, -cos) and not the usual (cos, sin).
      xPercent: 50 + radius * Math.sin(radians),
      yPercent: 50 - radius * Math.cos(radians),
    };
  });
}

/**
 * Lay out a whole fit. `slotCounts` is what the SERVER reported per family —
 * a family missing from the map, or reported as 0, simply gets no sockets.
 */
export function layoutSockets(
  slotCounts: Partial<Record<SlotFamily, number>>,
  radiusPercent = OUTER_RADIUS_PERCENT,
): readonly SocketPlacement[] {
  const placements: SocketPlacement[] = [];
  for (const family of Object.keys(FAMILY_ARCS) as SlotFamily[]) {
    placements.push(...placeFamily(family, slotCounts[family] ?? 0, radiusPercent));
  }
  return placements;
}

// ---- The client's own ring (the play page's fitting window) -------------------------------------------------
//
// eve/client/script/ui/shared/fitting/fittingController.py SLOTGROUP_LAYOUT_ARCS and slotAdder.py SlotAdder: each
// group's flags (fittingScreen GetSlotsByGroups: every flag of the group, the hull's own and those it lacks) spread
// from the group's start angle by arcLength / number of flags, at radius 239 of the 640-wide base (GetBaseShapeSize,
// before GetScaleFactor), each slot 44 x 54 and turned by -angle (carbonui's turn, anticlockwise: clockwise by the
// angle on the screen); angle 0 at twelve o'clock (GetPositionNumbers: cos / sin of angle - 90).

/** SLOTGROUP_LAYOUT_ARCS: [start, length] in degrees, by ShipFittingController.SLOTGROUPS' index (0 high, 1 mid, 2 low,
 * 3 subsystem, 4 rig). */
export const CLIENT_SLOT_ARCS: Readonly<Record<SlotFamily, readonly [number, number]>> = {
  high: [-35, 82], mid: [54, 82], low: [143, 82], subsystem: [233, 51], rig: [287, 31],
};
/** How many flags each group holds (inventorycommon hiSlotFlags 8, medSlotFlags 8, loSlotFlags 8, rigSlotFlags 3, subsystemSlotFlags 4). */
export const CLIENT_GROUP_FLAGS: Readonly<Record<SlotFamily, number>> = { high: 8, mid: 8, low: 8, rig: 3, subsystem: 4 };
/** The base's size and the slots' radius and size in it (SlotAdder at scale 1). */
export const CLIENT_BASE = 640, CLIENT_SLOT_RADIUS = 239, CLIENT_SLOT_WIDTH = 44, CLIENT_SLOT_HEIGHT = 54;

/** Where the client puts a group's index-th flag: its centre (in the 640 base, from the top left) and its angle. */
export function clientSlotPlacement(family: SlotFamily, index: number): { x: number; y: number; angleDegrees: number } {
  const [start, length] = CLIENT_SLOT_ARCS[family];
  const angleDegrees = start + (length / CLIENT_GROUP_FLAGS[family]) * index;
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return { x: CLIENT_SLOT_RADIUS * Math.cos(radians) + CLIENT_BASE / 2, y: CLIENT_SLOT_RADIUS * Math.sin(radians) + CLIENT_BASE / 2, angleDegrees };
}

/** Count the slots of each family present in a decoded fit. */
export function countByFamily(
  slots: readonly { readonly family: SlotFamily }[],
): Record<SlotFamily, number> {
  const counts: Record<SlotFamily, number> = {
    high: 0,
    mid: 0,
    low: 0,
    rig: 0,
    subsystem: 0,
  };
  for (const slot of slots) {
    counts[slot.family] += 1;
  }
  return counts;
}
