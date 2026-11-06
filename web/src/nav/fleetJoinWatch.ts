// GETTING ONE PILOT INTO THE FLEET YOU NAMED, AND WAITING AS LONG AS IT TAKES.
//
// A fleet-following plugin's window is a roster you build: you name the op's fleet
// once, add pilots to it, and each added pilot has to get itself into that
// fleet before it can be flown by one. This module is the decider for that —
// pure, one pilot, one tick — and the window is the driver that performs what
// it asks for and feeds it back what the server said.
//
// ⚠ IT IS THE `join-advertised-fleet` BLOCK'S PROTOCOL, DELIBERATELY, AND IT IS
// NOT THAT BLOCK. The round trip is the one docs/join-advertised-fleet-handoff.md
// paid an afternoon to learn: an APPLY DOES NOT JOIN YOU. On an open advert the
// server mints an invite addressed to the applicant and notifies it; membership
// happens only when the client calls AcceptInvite. The first version of the
// block wrote the apply and waited for membership, and hung forever on a
// healthy fleet. So: apply -> read the server's own answer -> accept -> confirm.
//
// ⚠ WHAT IS GENUINELY DIFFERENT FROM THE BLOCK, AND IS THE POINT OF THIS FILE.
// A block is one step of a script that has somewhere else to be, so an empty
// fleet finder is `done` there: nothing is advertised, carry on. This watch is
// the opposite promise — "add the pilot now, it joins when the fleet exists" —
// so an advert that is not there yet is a WAIT, not an answer, and the wait has
// no bound. The player ends it by removing the pilot.
//
// ⚠ AND IT NEVER STOPS A RUN. Every verdict here is about whether this pilot
// may JOIN; none of them reaches a pilot that is already flying. A fleet
// whose advert is closed after the pilot is in it must not read as a problem —
// see the `appliedTo` arm of the in-fleet rung, which is there for exactly that.

import { pickAdvertisedFleet, type FleetAdRow, type FleetApplication } from "./scriptConditions.ts";

/**
 * How many times one watch will accept an invite that never lands before it
 * gives up on this advert and goes back to looking.
 *
 * ⚠ IT GOES BACK TO WATCHING RATHER THAN STOPPING, because the likeliest reason
 * a minted invite does not produce membership is `advertJoinLimit` — the fleet
 * filled up between the listing and the accept. That is a temporary fact about
 * a fleet, and this window's whole promise is to keep waiting for temporary
 * facts to change. A stop here would need the player to notice and re-add.
 */
export const FLEET_JOIN_ACCEPT_ATTEMPTS = 3;

/**
 * One fleet-finder read, as the driver gets it back from a pilot's own flow.
 *
 * ⚠ THE TWO NULLS MEAN DIFFERENT THINGS AND MUST STAY APART. `ads: null` is a
 * read that FAILED; `ads: []` is a read that succeeded and found nobody
 * advertising. A watcher waits on the first and may act on the second, so
 * collapsing them would either strand a pilot or make a transport blip look
 * like an empty fleet finder.
 */
export interface FleetFinderRead {
  readonly ads: readonly FleetAdRow[] | null;
  /** The name of the fleet this pilot is IN, when that fleet is advertised. */
  readonly ownFleetName: string | null;
}

/** What the driver has learned about this pilot since the last tick. */
export interface FleetJoinReads {
  /** The fleet name the player typed into the window, as typed. */
  readonly wantedName: string;
  /**
   * True when this pilot is in a fleet. `null` when the bound read has not
   * answered — never an answer in its own right, and never flattened to `false`.
   */
  readonly inFleet: boolean | null;
  /** The id of the fleet it is in, from the last authoritative read. */
  readonly currentFleetID: number | null;
  /**
   * The NAME of the fleet this pilot is in, from GetMyFleetFinderAdvert, or
   * null when that fleet is not advertised.
   *
   * ⚠ THIS IS WHAT LETS A ROSTER TELL ONE FLEET FROM ANOTHER. `inFleet` is a
   * boolean: on its own it cannot say whether the pilot is in the op you named
   * or in something else entirely, and starting a bot on the second is
   * handing an unattended ship to strangers. Verified against the runtime:
   * `getMyFleetFinderAdvert` resolves the fleet from the SESSION CHARACTER, not
   * from being its boss, so any member of an advertised fleet reads its advert.
   */
  readonly currentFleetName: string | null;
  /**
   * The fleet-finder listing. `null` means the read failed or has not happened;
   * an EMPTY list is a real answer — nobody is advertising.
   */
  readonly ads: readonly FleetAdRow[] | null;
  /**
   * What the last apply answered, carried back by the driver because only the
   * caller of a write ever sees its result.
   */
  readonly application: FleetApplication | null;
  /**
   * True while this pilot's bot is standing down for want of a
   * supervisor — and true still, once it has, until a human puts it back.
   *
   * ⚠ IT IS A LATCH, NOT THE LIVE FLAG, and the driver owns the latching. The
   * abandonment ENDS by releasing the ship, which would leave a pilot that is
   * out of the fleet and not flying — exactly the state this watch exists to
   * fix — and it would rejoin, be alone again, and stand down again half an
   * hour later, for ever. A bot that has stood down once waits for a
   * person.
   *
   * ⚠ WITHOUT THIS THE TWO SYSTEMS FIGHT. A plugin's supervision rule
   * docks a pilot that finds itself in a fleet with no human in it, LEAVES the
   * fleet, and waits half an hour for an invite from somebody who was in it. A
   * watch that saw "not in the fleet" and rejoined would undo that on the next
   * tick, and the pair would loop join -> abandon -> join for as long as the
   * advert stood. So the abandonment wins, and this watch holds.
   */
  readonly standingDown: boolean;
}

/** What one pilot's watch remembers between ticks. */
export interface FleetJoinMemory {
  /** The fleet this watch applied to, or null when it has not applied. */
  readonly appliedTo: number | null;
  /** How many accepts have been sent for `appliedTo` without landing. */
  readonly acceptAttempts: number;
}

export const EMPTY_JOIN_MEMORY: FleetJoinMemory = Object.freeze({
  appliedTo: null,
  acceptAttempts: 0,
});

/** What the driver should do about this pilot now. */
export type FleetJoinAction =
  | { readonly kind: "wait" }
  | { readonly kind: "apply"; readonly fleetID: number }
  | { readonly kind: "accept"; readonly fleetID: number };

/**
 * Where this pilot stands.
 *
 * `in` is the only state a bot may be started from; `blocked` is a state
 * only the player can clear (by renaming the fleet, taking the pilot out of the
 * one it is in, or removing the row).
 */
export type FleetJoinState = "in" | "watching" | "joining" | "standing-down" | "blocked";

export interface FleetJoinVerdict {
  readonly state: FleetJoinState;
  /** The row's own sentence. Never a raw state word, never an error code. */
  readonly words: string;
  readonly action: FleetJoinAction;
  readonly memory: FleetJoinMemory;
}

const WAIT: FleetJoinAction = Object.freeze({ kind: "wait" });

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function verdict(
  state: FleetJoinState,
  words: string,
  action: FleetJoinAction,
  memory: FleetJoinMemory,
): FleetJoinVerdict {
  return { state, words, action, memory };
}

/**
 * One tick of one pilot's watch.
 *
 * The rungs are in the order they are, and the order is the whole design:
 * nothing is decided while the pilot is standing down, nothing is decided on an
 * unread fleet, being IN a fleet is settled before any advert is looked at, and
 * an application already in flight is answered before a new one is started.
 */
export function decideFleetJoin(reads: FleetJoinReads, memory: FleetJoinMemory): FleetJoinVerdict {
  const wanted = reads.wantedName.trim();

  // 0. Nothing to look for. Said as an instruction rather than a complaint:
  //    the field that fixes it is directly above the row.
  if (wanted.length === 0) {
    return verdict(
      "blocked",
      "Name the fleet above, as it appears in the fleet finder.",
      WAIT,
      EMPTY_JOIN_MEMORY,
    );
  }

  // 1. The abandonment protocol owns this pilot. It has already left the fleet
  //    on purpose; rejoining it here is the loop described in `standingDown`.
  //    The application is forgotten with it — whatever it applied to, it is not
  //    in that fleet any more and a stale id would be accepted against nothing.
  if (reads.standingDown) {
    return verdict(
      "standing-down",
      "Stood down: nobody in the fleet was supervising it. It will not rejoin by itself — press Start when you are back.",
      WAIT,
      EMPTY_JOIN_MEMORY,
    );
  }

  // 2. An unread fleet is not an empty one. Wait for a clean read rather than
  //    guessing either way — R9a's rule, and the reason `inFleet` is nullable.
  if (reads.inFleet === null) {
    return verdict("watching", "Checking which fleet this pilot is in.", WAIT, memory);
  }

  if (reads.inFleet === true) {
    // ⚠ THE NAME IS ASKED FIRST, AND BEATS "WE PUT IT THERE". An earlier draft
    // checked `appliedTo` first and printed the TYPED name against it, which
    // was found lying in the first live run: retype the op's fleet while a
    // pilot is already flying in the old one and its row read `In "Nightshift"`
    // about a pilot sitting in "Test". A watch may only ever name a fleet the
    // server named back.
    if (reads.currentFleetName !== null) {
      if (sameName(reads.currentFleetName, wanted)) {
        return verdict("in", `In "${reads.currentFleetName.trim()}".`, WAIT, memory);
      }
      return verdict(
        "blocked",
        `Already in "${reads.currentFleetName.trim()}", not "${wanted}". Take it out of that fleet, or remove it here.`,
        WAIT,
        EMPTY_JOIN_MEMORY,
      );
    }
    // In a fleet that is not advertised, so nothing can name it. This watch put
    // it there and says so without claiming WHICH fleet: a boss who closes the
    // advert once everyone is in must not turn a flying pilot's row into a
    // problem, and must not get it a name it cannot prove either.
    if (memory.appliedTo !== null && reads.currentFleetID === memory.appliedTo) {
      return verdict("in", "In the fleet it joined, which is no longer advertised.", WAIT, memory);
    }
    // ⚠ AND AN UNNAMEABLE FLEET IT DID NOT JOIN IS NOT TREATED AS THE TARGET.
    // The cost of guessing right is one saved click; the cost of guessing wrong
    // is an unattended ship taking orders from a fleet the player never picked.
    return verdict(
      "blocked",
      `Already in a fleet, and that fleet is not advertised, so it cannot be told from "${wanted}". Advertise it, or take this pilot out of it.`,
      WAIT,
      EMPTY_JOIN_MEMORY,
    );
  }

  // 4. Not in a fleet, and this watch has already applied to one.
  if (memory.appliedTo !== null) {
    const applied = memory.appliedTo;
    // ⚠ THE ANSWER IS TRUSTED ONLY WHEN IT NAMES THE FLEET THIS WATCH APPLIED
    // TO. The driver keeps the last application per pilot and it outlives a
    // lap, so without the id check a previous advert's answer would be read as
    // this one's.
    const answered =
      reads.application !== null && reads.application.fleetID === applied ? reads.application : null;
    if (answered === null) {
      // Still in flight. A throw is not seen here: the driver clears
      // `appliedTo` when the call fails, which returns this pilot to rung 5.
      return verdict("joining", `Applying to join "${wanted}".`, WAIT, memory);
    }
    if (answered.outcome === "needs-approval") {
      // No invite was minted and none is coming — only the boss can act. There
      // is nothing to wait for, and `appliedTo` is KEPT so the next tick does
      // not apply again into the same wall.
      return verdict(
        "blocked",
        `"${wanted}" approves its own members, so this pilot cannot join it by itself.`,
        WAIT,
        memory,
      );
    }
    if (memory.acceptAttempts >= FLEET_JOIN_ACCEPT_ATTEMPTS) {
      return verdict(
        "watching",
        `Could not get into "${wanted}" — it may be full. Waiting for it to come back.`,
        WAIT,
        EMPTY_JOIN_MEMORY,
      );
    }
    // "invited", and "unknown" too: an unexpected answer is treated as an
    // invite because that is the common half, and a wasted accept costs one
    // swallowed call where a refused one strands a pilot with an invite
    // waiting for it.
    return verdict("joining", `Accepting the invitation to "${wanted}".`, {
      kind: "accept",
      fleetID: applied,
    }, { appliedTo: applied, acceptAttempts: memory.acceptAttempts + 1 });
  }

  // 5. Not in a fleet, nothing applied for: look.
  if (reads.ads === null) {
    return verdict("watching", "Reading the fleet finder.", WAIT, memory);
  }
  const match = pickAdvertisedFleet(reads.ads, wanted.toLowerCase());
  if (match === null) {
    // ⚠ A WAIT, NOT AN ANSWER — the one place this differs from the script
    // block, and the reason the module exists. See the header.
    return verdict(
      "watching",
      `No fleet called "${wanted}" is advertised yet. Waiting for it.`,
      WAIT,
      memory,
    );
  }
  return verdict("joining", `Applying to join "${match.fleetName}".`, {
    kind: "apply",
    fleetID: match.fleetID,
  }, { appliedTo: match.fleetID, acceptAttempts: 0 });
}
