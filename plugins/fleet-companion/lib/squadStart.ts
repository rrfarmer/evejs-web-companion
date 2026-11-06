// Bringing a whole squad's companions online, on the SERVER.
//
// ⚠ IT STARTS A BOT FOR A PILOT NOBODY IS FLYING, and that is what makes it
// different from every start control in a pilot row. Those read their character
// out of a live tab's own station slice, so they can only ever act on a pilot
// already signed in here. The bot host does not need that at all -- it mints
// its own session token and selects the character itself -- and a squad start
// depends on it: the point is to bring six pilots online without opening six
// tabs. (The Bot Manager's group launcher starts a SAVED bot the same way; see
// startRun.ts.)
//
// ⚠ THE SEQUENCING AND THE ONE-REFUSAL RULE LIVE IN `groupStart.ts` NOW, not
// here. Neither is about companions -- "start one at a time" is about the
// browser's connection pool and "a refusal is a fact about that pilot" is about
// pilots -- and a second caller needed both. What is left in this file is the
// part that IS about companions: that each pilot flies its own `CompanionSetup`.
//
// PURE ORCHESTRATION. No fetch, no store, no component. The caller passes in
// what to start and how to start one; this decides the order, what happens when
// one refuses, and what the player is told.

import { groupStartFinished, groupStartSummary, startForGroup, type GroupStartEntry, type GroupStartState } from "../../../web/src/plugin-api/index.ts";
import type { CompanionSetup } from "./fleetCompanionLoop.ts";

/**
 * Where one pilot in the squad has got to.
 *
 * ⚠ ALIASES, NOT COPIES. A squad start is one kind of group start, so its rows
 * are group-start rows; giving them a parallel shape would let the two drift
 * and would make the Hangar's progress list untypeable by the shared runner.
 */
export type SquadStartState = GroupStartState;
export type SquadStartEntry = GroupStartEntry;

export interface SquadStartDeps {
  /**
   * Start one companion on the host. Rejects with the server's refusal; this
   * module turns that into a sentence and carries on.
   */
  startCompanion(characterID: number, setup: CompanionSetup): Promise<void>;
}

/** One pilot to start, and the setup it flies with. */
export interface SquadStartTarget {
  readonly characterID: number;
  readonly setup: CompanionSetup;
}

/**
 * What the operator should be told BEFORE anything is started.
 *
 * ⚠ ADVISORY, ALL OF IT. Nothing in this module refuses to start a squad --
 * the operator's rule for fit warnings holds here too: say what is wrong and
 * let a human fix it or fly anyway. The one thing that is not a warning is an
 * EMPTY roster, because there is then nothing to start at all.
 *
 * ⚠ BOTH WARNINGS THIS FUNCTION USED TO PRINT ARE GONE, FOR TWO DIFFERENT
 * REASONS, NEITHER OF WHICH IS "NOBODY NEEDS TO KNOW ANY MORE".
 *
 * - The one-tagger warning went because there is no longer a setting to warn
 *   about. Tagging is not a per-pilot toggle now; every pilot tags when it
 *   personally tackles something, and the server -- not this screen -- is the
 *   real gate: only a fleet creator, leader, wing commander or squad commander
 *   may write a tag (`obs.canTag`), so a companion that is a plain member tags
 *   nothing no matter how many of them a squad has. And even between two
 *   commanders, the rung only ever considers a ship that is TACKLING THIS
 *   PILOT, and skips one already carrying a letter -- so two companions can
 *   collide only if the same ship tackled both of them in the same tick,
 *   before either letter was visible to the other. See
 *   docs/fleet-companion-simplification.md, "Tagging".
 * - The fit-mixture warning went because the mixture it described cannot
 *   happen any more. It used to flag a squad where some pilots read their own
 *   fit and some flew a hand-picked module list; there is no longer a
 *   hand-picked list to fly instead -- every companion always reads its own
 *   fit at start -- so there is nothing left for two pilots to disagree about.
 *
 * Nothing has replaced them. If a real advisory turns up again, it belongs
 * here; until then this returns no warnings at all.
 */
export function squadStartWarnings(targets: readonly SquadStartTarget[]): readonly string[] {
  void targets;
  return [];
}

/**
 * Start every configured pilot in the squad, ONE AT A TIME.
 *
 * The sequencing and the never-strand-the-rest rule are `startForGroup`'s --
 * see its doc for why a browser's connection pool decides the first and a
 * CHARACTER_IN_USE refusal decides the second. What this wrapper adds is the
 * pairing of each pilot with ITS OWN setup.
 *
 * ⚠ THE GRANT IS BUILT PER PILOT, BY THE CALLER, FROM THAT PILOT'S OWN SETUP,
 * and that is why the targets carry a setup each rather than the squad carrying
 * one. Every companion now reads its own fit unconditionally, so `combat` is an
 * unconditional risk class for all of them -- the fit has not been read yet at
 * grant time and may hold anything. What still varies pilot to pilot is the
 * rest of the setup: one that pays for repairs earns `financial` and one that
 * does not, does not. Reusing one grant across the squad would hand some pilot
 * a grant that does not describe it, and the host re-derives and compares.
 * (A group start of a SAVED bot is the opposite case -- one script, so one
 * grant for the whole group -- which is why that path does not come through
 * here.)
 */
export function startCompanionSquad(
  deps: SquadStartDeps,
  targets: readonly SquadStartTarget[],
  onProgress?: (entries: readonly SquadStartEntry[]) => void,
): Promise<readonly SquadStartEntry[]> {
  const setups = new Map(targets.map((target) => [target.characterID, target.setup]));
  return startForGroup(
    targets.map((target) => target.characterID),
    async (characterID) => {
      const setup = setups.get(characterID);
      // Unreachable: the ids come from `targets` two lines up. Stated rather
      // than asserted so a future caller that builds the map differently gets a
      // refusal it can read instead of `undefined` on the wire.
      if (setup === undefined) throw new Error("That pilot has no companion setup.");
      await deps.startCompanion(characterID, setup);
    },
    onProgress,
  );
}

/** Every pilot has reached a final state. */
export function squadStartFinished(entries: readonly SquadStartEntry[]): boolean {
  return groupStartFinished(entries);
}

/**
 * How the run went, in one line, once it is over.
 *
 * The empty case is the one sentence a squad start owns: a squad with no
 * configured pilot is not "nothing to do", it is "nobody here is set up yet",
 * which names the thing the player has to go and do.
 */
export function squadStartSummary(entries: readonly SquadStartEntry[]): string {
  return groupStartSummary(entries, "No pilot in this squad is set up to fly a companion yet.");
}
