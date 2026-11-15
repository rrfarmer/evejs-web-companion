// The radial layout's geometry (goal R21).
//
// The property that matters most: the arcs are computed from the SERVER's slot
// counts. A hull with 4/3/3 and a hull with 8/6/5 must both come out right from
// the same code, and nothing may hardcode 8/8/8.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FAMILY_ARCS,
  PREFERRED_STEP_DEGREES,
  academySlotPlacement,
  arcAngles,
  countByFamily,
  layoutSockets,
  placeFamily,
} from "./fittingGeometry.ts";
import type { SlotFamily } from "../store/types.ts";

test("a family with no slots draws no sockets", () => {
  assert.deepEqual(arcAngles(FAMILY_ARCS.high, 0), []);
  assert.deepEqual(arcAngles(FAMILY_ARCS.rig, -1), []);
  assert.deepEqual(placeFamily("subsystem", 0, 36), []);
});

test("a single slot sits exactly on its arc's centre", () => {
  assert.deepEqual(arcAngles(FAMILY_ARCS.mid, 1), [FAMILY_ARCS.mid.centreDegrees]);
});

test("sockets are evenly spaced and centred on the arc", () => {
  for (const count of [2, 3, 4, 5, 6, 7, 8]) {
    const angles = arcAngles(FAMILY_ARCS.high, count);
    assert.equal(angles.length, count, `${count} slots should give ${count} angles`);

    // Even spacing: every gap identical.
    const gaps = angles.slice(1).map((angle, i) => angle - angles[i]!);
    for (const gap of gaps) {
      assert.ok(Math.abs(gap - gaps[0]!) < 1e-9, "gaps must all be equal");
    }
    // Centred: the mean angle is the arc's centre.
    const mean = angles.reduce((sum, a) => sum + a, 0) / angles.length;
    assert.ok(Math.abs(mean - FAMILY_ARCS.high.centreDegrees) < 1e-9);
  }
});

test("spacing is the preferred step until the arc is full, then compresses", () => {
  // Two slots: room to spare, so exactly one preferred step apart.
  const two = arcAngles(FAMILY_ARCS.high, 2);
  assert.ok(Math.abs(two[1]! - two[0]! - PREFERRED_STEP_DEGREES) < 1e-9);

  // Eight slots: the arc is exactly full at the preferred step.
  const eight = arcAngles(FAMILY_ARCS.high, 8);
  assert.ok(Math.abs(eight[1]! - eight[0]! - PREFERRED_STEP_DEGREES) < 1e-9);
  assert.ok(
    Math.abs(eight[7]! - eight[0]! - FAMILY_ARCS.high.spanDegrees) < 1e-9,
    "eight sockets should exactly fill the span",
  );

  // Nine slots: past full, so they compress to stay inside the span.
  const nine = arcAngles(FAMILY_ARCS.high, 9);
  const nineStep = nine[1]! - nine[0]!;
  assert.ok(nineStep < PREFERRED_STEP_DEGREES, "a ninth socket must compress the arc");
  assert.ok(
    Math.abs(nine[8]! - nine[0]! - FAMILY_ARCS.high.spanDegrees) < 1e-9,
    "a compressed arc still fits exactly inside its span",
  );
});

test("no arc ever spills outside its own span", () => {
  for (const family of Object.keys(FAMILY_ARCS) as SlotFamily[]) {
    const arc = FAMILY_ARCS[family];
    for (let count = 1; count <= 8; count += 1) {
      for (const angle of arcAngles(arc, count)) {
        const offset = Math.abs(angle - arc.centreDegrees);
        assert.ok(
          offset <= arc.spanDegrees / 2 + 1e-9,
          `${family} x${count}: ${angle}° escapes its ${arc.spanDegrees}° span`,
        );
      }
    }
  }
});

test("the families sit where a fitting window expects them", () => {
  // 0° is twelve o'clock and angles grow clockwise, so a single socket of each
  // family lands above / right / left / below the ship.
  const at = (family: SlotFamily) => placeFamily(family, 1, 36)[0]!;

  const high = at("high");
  assert.ok(high.yPercent < 50 - 1, "high slots sit above the ship");
  assert.ok(Math.abs(high.xPercent - 50) < 1e-9, "a lone high slot is centred");

  assert.ok(at("mid").xPercent > 50, "mid slots sit to the right");
  assert.ok(at("low").xPercent < 50, "low slots sit to the left");
  assert.ok(at("rig").yPercent > 50, "rigs sit below the ship");
});

test("rigs and subsystems sit on an inner ring, closer than the outer arcs", () => {
  const distance = (p: { xPercent: number; yPercent: number }) =>
    Math.hypot(p.xPercent - 50, p.yPercent - 50);

  const outer = distance(placeFamily("high", 1, 36)[0]!);
  const rig = distance(placeFamily("rig", 1, 36)[0]!);
  const subsystem = distance(placeFamily("subsystem", 1, 36)[0]!);

  assert.ok(rig < outer, "rigs are on the inner ring");
  assert.ok(subsystem < outer, "subsystems are on the inner ring");
  assert.ok(Math.abs(outer - 36) < 1e-9, "the outer ring is the given radius");
});

test("every socket stays inside the layout box", () => {
  const counts: Record<SlotFamily, number> = {
    high: 8,
    mid: 8,
    low: 8,
    rig: 3,
    subsystem: 5,
  };
  for (const socket of layoutSockets(counts, 40)) {
    assert.ok(socket.xPercent >= 0 && socket.xPercent <= 100, "x stays on the board");
    assert.ok(socket.yPercent >= 0 && socket.yPercent <= 100, "y stays on the board");
  }
});

// --- the counts come from the server, never from a constant -----------------

test("the layout is driven entirely by the reported slot counts", () => {
  // A Rifter: 4 high / 3 mid / 3 low / 3 rig, no subsystems.
  const rifter = layoutSockets({ high: 4, mid: 3, low: 3, rig: 3 });
  assert.equal(rifter.filter((s) => s.family === "high").length, 4);
  assert.equal(rifter.filter((s) => s.family === "mid").length, 3);
  assert.equal(rifter.filter((s) => s.family === "low").length, 3);
  assert.equal(rifter.filter((s) => s.family === "rig").length, 3);
  assert.equal(rifter.filter((s) => s.family === "subsystem").length, 0);
  assert.equal(rifter.length, 13);

  // A Drake: 8 / 6 / 5 / 3. Same code, a completely different ring.
  const drake = layoutSockets({ high: 8, mid: 6, low: 5, rig: 3 });
  assert.equal(drake.filter((s) => s.family === "high").length, 8);
  assert.equal(drake.filter((s) => s.family === "mid").length, 6);
  assert.equal(drake.filter((s) => s.family === "low").length, 5);
  assert.equal(drake.length, 22);

  // A Tengu: subsystems present, and they get drawn.
  const tengu = layoutSockets({ high: 6, mid: 5, low: 4, rig: 3, subsystem: 5 });
  assert.equal(tengu.filter((s) => s.family === "subsystem").length, 5);

  // An unfitted pod-like hull with nothing at all draws nothing.
  assert.deepEqual(layoutSockets({}), []);
});

test("the arcs differ between two hulls with different counts", () => {
  const rifterHigh = layoutSockets({ high: 4 }).map((s) => s.angleDegrees);
  const drakeHigh = layoutSockets({ high: 8 }).map((s) => s.angleDegrees);
  assert.notDeepEqual(rifterHigh, drakeHigh);
  assert.equal(rifterHigh.length, 4);
  assert.equal(drakeHigh.length, 8);
});

// --- R8: real pixel measurements at both ends of the responsive range -------
//
// `.fit-ring` is a square that is `width: 100%` between `min-width: 26rem`
// (416px) and `max-width: 34rem` (544px). Sockets are 2.5rem (40px) at or
// below the 640px breakpoint and 3.25rem (52px) above it, and are centred on
// their point by translate(-50%,-50%) — so each reaches half its width either
// side. These two cases are the whole responsive range.

/** The widest shape any hull could take — worse than anything real. */
const WORST_CASE = { high: 8, mid: 8, low: 8, rig: 3, subsystem: 5 } as const;

const RESPONSIVE_CASES = [
  { label: "narrow (26rem ring, 40px sockets)", ring: 416, socket: 40 },
  { label: "wide (34rem ring, 52px sockets)", ring: 544, socket: 52 },
];

test("no socket escapes the ring's box at either end of the range", () => {
  for (const { label, ring, socket: size } of RESPONSIVE_CASES) {
    const half = size / 2;
    const sockets = layoutSockets(WORST_CASE);
    assert.ok(sockets.length > 0);
    for (const socket of sockets) {
      const centreX = (socket.xPercent / 100) * ring;
      const centreY = (socket.yPercent / 100) * ring;
      assert.ok(
        centreX - half >= 0 && centreX + half <= ring,
        `${label}: ${socket.family} ${socket.index + 1} spills horizontally to ` +
          `${(centreX + half).toFixed(1)}px of ${ring}px`,
      );
      assert.ok(
        centreY - half >= 0 && centreY + half <= ring,
        `${label}: ${socket.family} ${socket.index + 1} spills vertically`,
      );
    }
  }
});

test("no two sockets overlap, at either end of the range", () => {
  // A socket sitting on top of another socket hides a fitted module behind
  // another fitted module — the worst failure this layout could have.
  for (const { label, ring, socket: size } of RESPONSIVE_CASES) {
    const sockets = layoutSockets(WORST_CASE);
    for (let i = 0; i < sockets.length; i += 1) {
      for (let j = i + 1; j < sockets.length; j += 1) {
        const a = sockets[i]!;
        const b = sockets[j]!;
        const gap = Math.hypot(
          ((a.xPercent - b.xPercent) / 100) * ring,
          ((a.yPercent - b.yPercent) / 100) * ring,
        );
        assert.ok(
          gap >= size,
          `${label}: ${a.family}${a.index + 1} and ${b.family}${b.index + 1} are ` +
            `${gap.toFixed(1)}px apart but sockets are ${size}px wide`,
        );
      }
    }
  }
});

test("the gap BETWEEN two families is wider than the gap within one", () => {
  // Otherwise the three arcs stop reading as three arcs.
  const sockets = layoutSockets({ high: 8, mid: 8, low: 8 });
  const high = sockets.filter((s) => s.family === "high").map((s) => s.angleDegrees);
  const low = sockets.filter((s) => s.family === "low").map((s) => s.angleDegrees);

  const withinArc = high[1]! - high[0]!;
  // The last low socket (~295°) to the first high socket (~305°, i.e. -55°).
  const betweenArcs = high[0]! + 360 - low[low.length - 1]!;
  assert.ok(
    betweenArcs > withinArc,
    `families are ${betweenArcs.toFixed(2)}° apart but neighbours are ${withinArc.toFixed(2)}°`,
  );
});

test("countByFamily counts a decoded fit's slots", () => {
  const slots = [
    { family: "high" as const },
    { family: "high" as const },
    { family: "mid" as const },
    { family: "rig" as const },
  ];
  assert.deepEqual(countByFamily(slots), { high: 2, mid: 1, low: 0, rig: 1, subsystem: 0 });
});

test("the socket order within a family matches slot order", () => {
  const sockets = placeFamily("high", 5, 36);
  assert.deepEqual(
    sockets.map((s) => s.index),
    [0, 1, 2, 3, 4],
  );
  // Slot 1 is the leftmost of the top arc and they run clockwise from there.
  for (let i = 1; i < sockets.length; i += 1) {
    assert.ok(sockets[i]!.angleDegrees > sockets[i - 1]!.angleDegrees);
  }
});

test("Academy sockets use the installed slot arcs with the larger radius and four-pixel spacing", () => {
  const secondHigh = academySlotPlacement("high", 1);
  assert.ok(Math.abs(secondHigh.angleDegrees - (-35 + 82 / 8 + 180 * 4 / (252 * Math.PI))) < 1e-9);
  assert.ok(Math.abs(Math.hypot(secondHigh.x - 320, secondHigh.y - 320) - 252) < 1e-9);
  assert.equal(academySlotPlacement("rig", 0).angleDegrees, 287);
});
