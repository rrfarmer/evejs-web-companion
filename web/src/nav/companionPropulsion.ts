// What the fleet companion's prop mod may do while hostiles are on the grid.
//
// `decidePropulsion` (fleetCompanionLoop.ts) owns WHEN to burn; `propulsion.ts`
// owns which module and the scram / floor rules, and is shared with the
// drone-boat block. This file owns the one thing neither does: the choice of
// KIND against what the rats shoot with. Pure -- the caller reads the grid.

import type { CompanionLadderMemory, FleetCompanionObservation } from "./fleetCompanionLoop.ts";
import type { PropulsionModule } from "./propulsion.ts";
import type { PropsBecause } from "./companionTrace.ts";
import { isHostile } from "../space/overview.ts";

/** The readout words, plain ASCII. */
export const MWD_STAYS_OFF_WHY = "Hostiles on grid: the microwarpdrive stays off (it blooms the signature).";
export const MISSILE_ORBIT_WHY = "Missile rats here: keeping the afterburner on while orbiting.";

/** What `decidePropulsion` read to answer "burn?", before any module is picked. */
export interface PropsWanting {
  /** The chat override: `props on` / `props off`, null when nobody said either. */
  readonly held: boolean | null;
  /** `flight auto` with rung 8's own order standing: the burner is rung 8's. */
  readonly ownHold: boolean;
  /** `closingOnTheHold`. */
  readonly closing: boolean;
  /** `orbitingAgainstMissiles`. */
  readonly missileOrbit: boolean;
  /** `isUnderWay`. */
  readonly travel: boolean;
}

/**
 * The ONE cause of the burn decision (companionTrace.ts `PropsBecause`).
 *
 * ⚠ THE SAME PRECEDENCE AS `wantBurn`, SO THE CODE CANNOT DISAGREE WITH THE
 * DECISION: the chat override first; then, while rung 8's order stands, closing
 * or the missile orbit and NOTHING else (travel is not asked); otherwise closing
 * or travel. Closing and the missile orbit both true records "closing" -- it is
 * the one that would light the burner on its own -- and the readout says both.
 */
export function propsBecause(wanting: PropsWanting): PropsBecause {
  if (wanting.held === true) return "held-on";
  if (wanting.held === false) return "held-off";
  if (wanting.closing) return "closing";
  if (wanting.ownHold) return wanting.missileOrbit ? "missile-orbit" : "none";
  return wanting.travel ? "travel" : "none";
}

/** Whether `because` wants the burner lit. */
export function propsWanted(because: PropsBecause): boolean {
  return because !== "none" && because !== "held-off";
}

/** The readout for lighting the prop mod. Plain ASCII. */
export function propsLightWhy(because: PropsBecause, missileOrbit: boolean): string {
  switch (because) {
    case "held-on":
      return "A commander said props on in chat. Lighting the prop mod.";
    case "closing":
      return missileOrbit
        ? "Closing in on the target, and missile rats are here. Lighting the prop mod."
        : "Closing in on the target. Lighting the prop mod.";
    case "missile-orbit":
      return MISSILE_ORBIT_WHY;
    default:
      return "Travelling. Lighting the prop mod.";
  }
}

/**
 * Why nothing wants the burner, for the stop sentence. "Not travelling" was the
 * sentence for all four once; a pilot in position on a rat is not "not
 * travelling any more", it has arrived.
 */
export type PropsStopCause = "held-off" | "on-station" | "formation" | "not-travelling";

/** The readout for standing the prop mod down. Plain ASCII. */
export function propsStopWhy(cause: PropsStopCause): string {
  switch (cause) {
    case "held-off":
      return "A commander said props off in chat. Standing the prop mod down.";
    case "on-station":
      return "In position on the target. Standing the prop mod down.";
    case "formation":
      return "Holding formation with hostiles on grid. Standing the prop mod down.";
    case "not-travelling":
      return "Not travelling any more. Standing the prop mod down.";
  }
}

/**
 * Whether any hostile on this grid is KNOWN to shoot missiles.
 *
 * ⚠ KNOWN, NOT PRESUMED. A hostile whose type facts were never read, or whose
 * `missile` is null, is not a missile rat here: an unreadable grid gets the
 * conservative table row (afterburner only while closing), never the orbit
 * burn, because that burn costs capacitor for a benefit only missile rats give.
 */
export function missileRatsOnGrid(obs: FleetCompanionObservation): boolean {
  if (obs.hostileOnGrid !== true) {
    return false;
  }
  const facts = obs.ratCombatByTypeID ?? null;
  if (facts === null) {
    return false;
  }
  for (const entity of obs.snapshot?.entities ?? []) {
    if (!isHostile(entity)) continue;
    const typeID = entity.typeID ?? null;
    if (typeID !== null && facts[typeID]?.missile === true) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the burn is wanted for the orbit itself: `flight auto`, the
 * positioning rung's order standing, and a missile rat on grid. Missile damage
 * falls with the target's speed, with no floor, so an orbit flown at speed is
 * part of the defence.
 */
export function orbitingAgainstMissiles(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): boolean {
  return memory.flightMode === "auto" && memory.combatPosition.hold !== null && missileRatsOnGrid(obs);
}

export interface GridProps {
  /** What to hand `decidePropulsionModule`. */
  readonly modules: readonly PropulsionModule[];
  /** A running module the policy above no longer sees and must be stood down; null when none. */
  readonly standDown: PropulsionModule | null;
}

/**
 * The prop mods the companion may use right now.
 *
 * ⚠ ONLY AN AFTERBURNER MAY BE LIT WITH HOSTILES ON GRID. A microwarpdrive
 * blooms the signature radius, which NPC missiles read with no floor and NPC
 * turrets mostly shrug off; an afterburner does not bloom. A `kind` of null
 * (the SDE read did not arrive) is treated as the microwarpdrive, the same
 * fail-safe `propulsion.ts` uses for a scram. Nothing here changes
 * `propulsion.ts`: the list handed to it is narrowed, and a disallowed module
 * that is already cycling is reported as `standDown` because the policy cannot
 * stop what it was not shown.
 *
 * ⚠ `hostileOnGrid` IS THREE-STATE AND ONLY `true` RESTRICTS. False and null
 * leave the rack exactly as it was.
 *
 * ⚠ A COMMANDER'S `props on` / `props off` BEATS THIS. `propsHeld` non-null
 * returns the whole rack: `props on` means the commander chose to burn, even a
 * microwarpdrive, and `props off` already stops whatever is lit.
 */
export function propsOnThisGrid(
  fitted: readonly PropulsionModule[],
  activeModuleIDs: ReadonlySet<number>,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): GridProps {
  if (obs.hostileOnGrid !== true || memory.propsHeld !== null) {
    return { modules: fitted, standDown: null };
  }
  return {
    modules: fitted.filter((module) => module.kind === "afterburner"),
    standDown: fitted.find((module) => module.kind !== "afterburner" && activeModuleIDs.has(module.itemID)) ?? null,
  };
}
