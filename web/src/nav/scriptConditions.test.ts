// A4a — the tri-state reads and interrupt resolution. These pin the two things
// the critiques hammered on: cannot-tell never passes, and a pirate with an
// unreadable ship never gets worked past.

import test from "node:test";
import assert from "node:assert/strict";

import { conditionAllowedAt, type Condition, type InterruptRow } from "../bots/botScript.ts";
import {
  MAX_CANNOT_TELL_STREAK,
  bumpCannotTellStreak,
  cannotTellStreakExhausted,
  evaluateCondition,
  releaseSpentAlerts,
  resolveInterrupt,
  type ScriptObservation,
} from "./scriptConditions.ts";

// A fully-readable, calm observation; tests override one field at a time.
function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true,
    docked: false,
    inWarp: false,
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    health: 1,
    oreHoldFraction: 0,
    holdEmpty: true,
    hostileOnGrid: false,
    dronesOut: false,
    ...over,
  };
}

const floor: InterruptRow = {
  id: "i0",
  when: { kind: "health-below", fraction: 0.5 },
  respond: "dock-and-pause",
};

test("a below-threshold read is met, above is not-met, unreadable is cannot-tell", () => {
  const c: Condition = { kind: "shield-below", fraction: 0.3 };
  assert.equal(evaluateCondition(c, obs({ shieldRatio: 0.2 })), "met");
  assert.equal(evaluateCondition(c, obs({ shieldRatio: 0.5 })), "not-met");
  assert.equal(evaluateCondition(c, obs({ shieldRatio: null })), "cannot-tell");
});

test("ore-hold-at-least reads the fill fraction the other way round", () => {
  const c: Condition = { kind: "ore-hold-at-least", fraction: 0.9 };
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: 0.95 })), "met");
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: 0.5 })), "not-met");
  assert.equal(evaluateCondition(c, obs({ oreHoldFraction: null })), "cannot-tell");
});

test("wallet thresholds read an absolute ISK balance, unread never fires", () => {
  const below: Condition = { kind: "wallet-below", isk: 100_000_000 };
  assert.equal(evaluateCondition(below, obs({ walletBalance: 50_000_000 })), "met");
  assert.equal(evaluateCondition(below, obs({ walletBalance: 150_000_000 })), "not-met");
  assert.equal(evaluateCondition(below, obs({ walletBalance: null })), "cannot-tell");
  // Absent entirely (a bot that does not read the wallet) is unreadable, not zero.
  assert.equal(evaluateCondition(below, obs()), "cannot-tell");

  const above: Condition = { kind: "wallet-above", isk: 100_000_000 };
  assert.equal(evaluateCondition(above, obs({ walletBalance: 150_000_000 })), "met");
  assert.equal(evaluateCondition(above, obs({ walletBalance: 100_000_000 })), "not-met"); // strict >
  assert.equal(evaluateCondition(above, obs({ walletBalance: null })), "cannot-tell");
});

test("boolean conditions are tri-state too", () => {
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: true })), "met");
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: false })), "not-met");
  assert.equal(evaluateCondition({ kind: "hold-empty" }, obs({ holdEmpty: null })), "cannot-tell");
  assert.equal(evaluateCondition({ kind: "hostile-on-grid" }, obs({ hostileOnGrid: true })), "met");
  assert.equal(evaluateCondition({ kind: "hostile-on-grid" }, obs({ hostileOnGrid: null })), "cannot-tell");
});

test("health-below watches the lowest layer, shield-below watches the shield", () => {
  // Shield full, hull low: shield-below is not-met, health-below (lowest) is met.
  const worn = obs({ shieldRatio: 1, armorRatio: 1, hullRatio: 0.1, health: 0.1 });
  assert.equal(evaluateCondition({ kind: "shield-below", fraction: 0.5 }, worn), "not-met");
  assert.equal(evaluateCondition({ kind: "health-below", fraction: 0.5 }, worn), "met");
});

test("the first met interrupt fires, in order", () => {
  const shields: InterruptRow = { id: "i1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([floor, shields], obs({ shieldRatio: 0.2 }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.id, "i1");
});

test("a cannot-tell condition does not fire, and the scan continues past it", () => {
  // floor's health is unreadable (cannot-tell, does not fire); the shields row
  // after it IS met and fires.
  const shields: InterruptRow = { id: "i1", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([floor, shields], obs({ health: null, shieldRatio: 0.2 }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.id, "i1");
});

test("an unreadable health-below row does not fire", () => {
  const res = resolveInterrupt([floor], obs({ health: null }));
  assert.equal(res.kind, "none");
});

test("nothing wrong: no interrupt fires", () => {
  const res = resolveInterrupt([floor], obs());
  assert.equal(res.kind, "none");
});

test("a pirate with unreadable health pauses immediately when nothing else handles it", () => {
  const res = resolveInterrupt([floor], obs({ hostileOnGrid: true, health: null }));
  assert.equal(res.kind, "safety-override");
  assert.ok(res.kind === "safety-override");
  assert.match(res.reason, /pirate/i);
});

test("a player's drone response fires before the acute pause can", () => {
  // The player chose to launch drones on a pirate; even with health unreadable,
  // that fires first and defends the ship rather than pausing helpless.
  const drones: InterruptRow = { id: "i2", when: { kind: "hostile-on-grid" }, respond: "launch-drones" };
  const res = resolveInterrupt([floor, drones], obs({ hostileOnGrid: true, health: null }));
  assert.equal(res.kind, "fire");
  assert.ok(res.kind === "fire");
  assert.equal(res.row.respond, "launch-drones");
});

test("a pirate present with READABLE health does not trigger the acute pause", () => {
  const res = resolveInterrupt([floor], obs({ hostileOnGrid: true, health: 1 }));
  assert.equal(res.kind, "none");
});

test("the cannot-tell streak counts up while blind and resets when it reads again", () => {
  let streak = 0;
  for (let i = 0; i < MAX_CANNOT_TELL_STREAK; i += 1) {
    streak = bumpCannotTellStreak(streak, true);
  }
  assert.equal(streak, MAX_CANNOT_TELL_STREAK);
  assert.ok(cannotTellStreakExhausted(streak));

  streak = bumpCannotTellStreak(streak, false);
  assert.equal(streak, 0);
  assert.equal(cannotTellStreakExhausted(streak), false);
});

// ── The four awareness conditions (2026-07-25) ───────────────────────────────

test("cargo-full: the ORDINARY hold, tri-state, and unreadable never fires", () => {
  const full = { kind: "cargo-full", fraction: 0.9 } as const;
  assert.equal(evaluateCondition(full, obs({ cargoFraction: 0.95 })), "met");
  assert.equal(evaluateCondition(full, obs({ cargoFraction: 0.5 })), "not-met");
  assert.equal(evaluateCondition(full, obs({ cargoFraction: null })), "cannot-tell");
  // It is NOT the ore hold: a full ore hold says nothing about the cargo hold.
  assert.equal(evaluateCondition(full, obs({ oreHoldFraction: 1, cargoFraction: 0 })), "not-met");
});

test("targeted-by-player: tri-state over the lock reading", () => {
  const locked = { kind: "targeted-by-player" } as const;
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: true })), "met");
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: false })), "not-met");
  assert.equal(evaluateCondition(locked, obs({ targetedByPlayer: null })), "cannot-tell");
});

test("drone-health-below: no drones out reads cannot-tell, never healthy", () => {
  const hurt = { kind: "drone-health-below", fraction: 0.5 } as const;
  assert.equal(evaluateCondition(hurt, obs({ lowestDroneHealth: 0.2 })), "met");
  assert.equal(evaluateCondition(hurt, obs({ lowestDroneHealth: 0.9 })), "not-met");
  assert.equal(
    evaluateCondition(hurt, obs({ lowestDroneHealth: null })),
    "cannot-tell",
    "nothing to judge is not a verdict",
  );
});

test("the new grid/awareness conditions are interrupt-only (the belt-empty guard)", () => {
  for (const kind of ["targeted-by-player", "drone-health-below"] as const) {
    assert.equal(conditionAllowedAt(kind, "until"), false, `${kind} must not be a stop-when`);
    assert.equal(conditionAllowedAt(kind, "interrupt"), true, `${kind} must be usable as a watch`);
  }
  // cargo-full is an OWN-SHIP reading, so it is legal in both places.
  assert.equal(conditionAllowedAt("cargo-full", "until"), true);
  assert.equal(conditionAllowedAt("cargo-full", "interrupt"), true);
});

// ── The alert ladder's two helpers (spent rows) ──────────────────────────────

test("resolveInterrupt: a SPENT alert row is skipped so the row under it can fire", () => {
  const alertRow: InterruptRow = { id: "a", when: { kind: "shield-below", fraction: 0.6 }, respond: "alert" };
  const dockRow: InterruptRow = { id: "d", when: { kind: "shield-below", fraction: 0.6 }, respond: "dock-and-pause" };
  const hurt = obs({ shieldRatio: 0.3 });
  const fresh = resolveInterrupt([alertRow, dockRow], hurt, []);
  assert.equal(fresh.kind === "fire" && fresh.row.id, "a");
  const spent = resolveInterrupt([alertRow, dockRow], hurt, ["a"]);
  assert.equal(spent.kind === "fire" && spent.row.id, "d", "the spent alert must step aside");
});

test("resolveInterrupt: only ALERT rows are ever skipped — a real response keeps winning", () => {
  const dockRow: InterruptRow = { id: "d", when: { kind: "shield-below", fraction: 0.6 }, respond: "dock-and-pause" };
  const res = resolveInterrupt([dockRow], obs({ shieldRatio: 0.3 }), ["d"]);
  assert.equal(res.kind === "fire" && res.row.id, "d");
});

// ── The drone-boat observation fields (docs/drone-boat-block-spec.md §8) ─────
//
// Nothing in `scriptMacros.ts` reads these yet — the block arrives in a later
// parcel — so what there is to pin here is the CONTRACT and the INERTNESS, and
// both are worth pinning precisely because nothing else can catch them going
// wrong. A field renamed or retyped breaks the block that has not been written;
// a field that quietly changed a verdict would break every bot that has.

/** A drone boat mid-fight, with every one of the seven reads answered. */
function droneBoatObs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return obs({
    hostileOnGrid: true,
    droneControlRangeM: 27_500,
    maxTargetRangeM: 37_000,
    threatByTypeID: {
      // The pair from nav/ratThreat.ts's header: same family, same size, and
      // only the dogma separates the one that will hold the ship on the field.
      1001: { scram: true, scramRangeM: 20_000, web: true, ewar: false, ecm: false },
      1002: { scram: false, scramRangeM: null, web: false, ewar: false, ecm: false },
    },
    jammingSourceIDs: [900_100, 900_101],
    myDrones: [
      { itemID: 700_001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
      { itemID: 700_002, shieldRatio: 0.1, armorRatio: null, hullRatio: null },
    ],
    unloadedWeaponIDs: [800_001],
    propulsionModules: [{ itemID: 800_500, typeID: 12_056, kind: "microwarpdrive" }],
    scrammed: true,
    ...over,
  });
}

test("the drone-boat reads are all optional: an observation without one of them is legal", () => {
  // The type is built in two places and the pure tests build it by hand, so the
  // minimal observation above must stay constructible — this test compiles or
  // it does not, and that is the assertion.
  const bare = obs();
  assert.equal(bare.droneControlRangeM, undefined);
  assert.equal(bare.threatByTypeID, undefined);
  assert.equal(bare.jammingSourceIDs, undefined);
  assert.equal(bare.myDrones, undefined);
  assert.equal(bare.unloadedWeaponIDs, undefined);
  assert.equal(bare.propulsionModules, undefined);
  assert.equal(bare.scrammed, undefined);
});

test("the drone-boat reads decide NOTHING yet — every verdict is what it was without them", () => {
  // ⚠ THE POINT OF THIS TEST. Adding fields to the observation must not move a
  // single existing verdict; a decider that started reading one of these
  // without being asked would show up here and nowhere else.
  const calm = { hostileOnGrid: false, health: 1, shieldRatio: 1 } as const;
  assert.equal(resolveInterrupt([floor], droneBoatObs(calm)).kind, "none");
  assert.equal(resolveInterrupt([floor], obs(calm)).kind, "none");
  // The acute rule is unchanged too: a pirate plus unreadable health still
  // pauses, however much the drone boat can say about the rest of the grid.
  const blind = resolveInterrupt([floor], droneBoatObs({ health: null }));
  assert.equal(blind.kind, "safety-override");
  // And a readable ship next to the same pirate still does not pause.
  assert.equal(resolveInterrupt([floor], droneBoatObs({ health: 1 })).kind, "none");
  // The drone-health watch keeps reading `lowestDroneHealth` and NOT `myDrones`:
  // the per-drone list carries a drone at 0.1 and the fold is deliberately not
  // set here, so a watch that had started folding it itself would fire.
  const hurt = { kind: "drone-health-below", fraction: 0.5 } as const;
  assert.equal(evaluateCondition(hurt, droneBoatObs({ health: 1 })), "cannot-tell");
});

test("a type missing from threatByTypeID is ABSENT, not a harmless rat", () => {
  // The permanent per-type cache in flow.ts leaves a failed fetch UNCACHED, so
  // "not told" has to arrive as a missing key. It must never be filled with
  // UNKNOWN_THREAT, which reads as a rat that was looked at and found safe.
  const threats = droneBoatObs().threatByTypeID;
  assert.ok(threats !== null && threats !== undefined);
  assert.equal(threats[9999], undefined, "an unfetched type is absent, never a verdict");
  assert.equal(threats[1001]?.scram, true);
  assert.equal(threats[1002]?.scram, false, "a read that says 'no scram' IS a verdict");
});

test("the two leashes are separate fields and neither stands in for the other", () => {
  // ⚠ THE MISTAKE THIS PINS was made once already (see nav/kiteBand.ts): the
  // drone leash is usually unreadable and the lock leash usually is not, so a
  // collapse of the two is invisible except on a fit that reports both.
  const both = droneBoatObs();
  assert.equal(both.droneControlRangeM, 27_500);
  assert.equal(both.maxTargetRangeM, 37_000);
  // The ordinary case: control range unknown, lock range fine. Unknown must
  // arrive as null and never as 0 — a 0 would say "the drones answer nowhere".
  const usual = droneBoatObs({ droneControlRangeM: null });
  assert.equal(usual.droneControlRangeM, null);
  assert.notEqual(usual.droneControlRangeM, 0);
  assert.equal(usual.maxTargetRangeM, 37_000, "the lock leash must not have moved");
});

test("scrammed is three-state and the jam list is every jam, not just tackle", () => {
  assert.equal(droneBoatObs().scrammed, true);
  assert.equal(droneBoatObs({ scrammed: false }).scrammed, false, "read, and clear");
  assert.equal(droneBoatObs({ scrammed: null }).scrammed, null, "nobody looked");
  // An array, matching lockedTargetIDs — the consumer builds its own Set.
  assert.ok(Array.isArray(droneBoatObs().jammingSourceIDs));
  assert.deepEqual(droneBoatObs({ jammingSourceIDs: [] }).jammingSourceIDs, [], "a real 'nothing on us'");
});

test("tackled reads the SCRAM, tri-state, and never fires on an unreadable jam fold", () => {
  const held: Condition = { kind: "tackled" };
  assert.equal(evaluateCondition(held, obs({ scrammed: true })), "met");
  assert.equal(evaluateCondition(held, obs({ scrammed: false })), "not-met", "read, and clear");
  assert.equal(evaluateCondition(held, obs({ scrammed: null })), "cannot-tell");
  // Absent entirely (an observation nobody filled) is unreadable, never "loose".
  assert.equal(evaluateCondition(held, obs()), "cannot-tell");
});

test("tackled does NOT fire on a web, a damp or any other jam", () => {
  // ⚠ THE WHOLE REASON IT READS `scrammed` AND NOT `jammingSourceIDs`. That list
  // is every hostile cycle landing on this ship — a webbing frigate names itself
  // on it, and a webbed ship can still warp. A watch called "cannot warp out"
  // that fired on a web is a watch a player deletes after the second false
  // alarm, taking the row that would have saved the ship with it.
  const held: Condition = { kind: "tackled" };
  const webbed = obs({ hostileOnGrid: true, jammingSourceIDs: [900_100, 900_101], scrammed: false });
  assert.equal(evaluateCondition(held, webbed), "not-met");
  // And the narrow read still fires on its own, with no jam list at all.
  assert.equal(evaluateCondition(held, obs({ scrammed: true })), "met");
});

test("a tackled watch fires before a health floor that would try to warp home", () => {
  // The 2026-09-14 loss, as a ladder: the armour row fired on time and asked for
  // a warp the scram refused. Ordered above it, the tackle row wins the tick and
  // answers with something a held ship can actually do.
  const tackle: InterruptRow = { id: "t", when: { kind: "tackled" }, respond: "fight-back" };
  const armor: InterruptRow = { id: "a", when: { kind: "armor-below", fraction: 0.25 }, respond: "dock-and-repair" };
  const pinned = obs({ hostileOnGrid: true, scrammed: true, armorRatio: 0.2, health: 0.2 });
  const fired = resolveInterrupt([tackle, armor], pinned);
  assert.equal(fired.kind, "fire");
  assert.equal(fired.kind === "fire" ? fired.row.id : null, "t");
  // Loose again, the armour row is exactly the row it always was.
  const loose = resolveInterrupt([tackle, armor], obs({ scrammed: false, armorRatio: 0.2, health: 0.2 }));
  assert.equal(loose.kind === "fire" ? loose.row.id : null, "a");
});

test("releaseSpentAlerts: released when the check passes, kept while it holds or is blind", () => {
  const alertRow: InterruptRow = { id: "a", when: { kind: "shield-below", fraction: 0.6 }, respond: "alert" };
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: 1 }), ["a"]), [], "recovered - re-arm");
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: 0.3 }), ["a"]), ["a"], "still hurt - stay spent");
  assert.deepEqual(releaseSpentAlerts([alertRow], obs({ shieldRatio: null }), ["a"]), ["a"], "blind - stay spent");
  assert.deepEqual(releaseSpentAlerts([], obs({}), ["gone"]), [], "a deleted row is forgotten");
});
