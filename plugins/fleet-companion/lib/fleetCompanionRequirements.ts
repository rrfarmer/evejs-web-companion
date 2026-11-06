// WHAT A FLEET COMPANION NEEDS BEFORE IT CAN START.
//
// ⚠ THIS USED TO LIVE IN nav/botRegistry.ts, AND MOVING IT IS THE POINT. The
// companion was built as the third instance of the mining/mission bot pattern,
// so it inherited that file, that catalogue and that library — and a fleet
// readout ended up inside a bot manager, where it never belonged. A companion
// is not a bot: it picks no work of its own, it has nothing to save or share,
// and it is set up and watched across every pilot at once rather than against
// one ship. `BotID` is the bot catalogue now, and the companion is not in it.
//
// WHAT IT STILL SHARES, and should: the requirement MACHINERY. The three-answer
// verdict (met / not-met / cannot-tell), the blocking-vs-advisory distinction,
// `evaluateRequirements` and the rule that a read which failed is not a read
// that said no are general, already tested, and would only rot if forked. So
// this module declares the companion's rows against that machinery and imports
// it from where it lives.
//
// ⚠ FRESHNESS IS STILL THE CALLER'S JOB. These are pure functions over injected
// reads: the window evaluates them against the store as a live advisory
// checklist, and `companionFlow.ts` evaluates THE SAME objects against reads taken
// immediately before the first call. Only the second evaluation decides
// anything.

import { fromNullableBoolean, type BotRequirement } from "../../../web/src/plugin-api/flying.ts";

/**
 * What a companion's start needs to know about the world.
 *
 * ⚠ IN A FLEET IS BLOCKING, and it is the one requirement the ladder genuinely
 * cannot resolve for itself. Every companion behaviour — broadcasts, target
 * tags, repping a fleet-mate, yielding to a fleet warp — is addressed to the
 * fleet, and the roster is where the pilot learns who its fleet-mates even are.
 * A companion started outside a fleet is not a bot that will get going shortly;
 * it is a bot with nothing to obey.
 */
export interface FleetCompanionReads {
  /** True when this pilot is in a fleet. Null when the roster did not read. */
  readonly inFleet: boolean | null;
  /** True when the ship is docked. Null when the flight status did not read. */
  readonly docked: boolean | null;
}

const COMPANION_NEEDS_A_FLEET = "Join a fleet first — a companion takes its orders from one.";
const COMPANION_FLEET_UNREADABLE =
  "Your fleet could not be read, so there is no way to tell who it would be following.";

export const FLEET_COMPANION_REQUIREMENTS: readonly BotRequirement<FleetCompanionReads>[] =
  Object.freeze([
    {
      id: "in-fleet",
      title: "You are in a fleet",
      severity: "blocking",
      source: "ship",
      check: (reads) => fromNullableBoolean(reads.inFleet),
      unmet: COMPANION_NEEDS_A_FLEET,
      cannotTell: COMPANION_FLEET_UNREADABLE,
    },
    {
      // ADVISORY: undocking is the companion's own first move when the fleet
      // asks for anything, so refusing a docked start would refuse a start that
      // works.
      id: "docked",
      title: "Your ship is out in space",
      severity: "advisory",
      source: "ship",
      check: (reads) =>
        reads.docked === null ? "cannot-tell" : reads.docked ? "not-met" : "met",
      unmet: "It will undock when the fleet gives it something to do.",
      cannotTell: "Whether your ship is docked could not be read.",
    },
  ]);
