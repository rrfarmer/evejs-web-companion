// Starting ONE thing on EVERY pilot of a group, one pilot at a time.
//
// ⚠ THIS IS `squadStart.ts`'S CORE, LIFTED OUT SO A SECOND CALLER CANNOT FORK
// IT. A squad start on the Pilot Hangar had the only copy of two
// rules that are not about any one kind of bot -- start sequentially, and never
// let one refusal strand the rest -- and the Bot Manager's group launcher needs
// exactly those rules for a SAVED BOT. Copying them would have left two
// implementations of "what happens when pilot three is already flying", which
// is precisely the drift this codebase extracts to avoid (see startRun.ts's own
// header for the same argument about the approval path).
//
// PURE ORCHESTRATION. No fetch, no store, no component, no clock. The caller
// passes in who to start and how to start one; this decides the order, what
// happens when one refuses, and what the player is told.

/** Where one pilot in the group has got to. */
export type GroupStartState = "queued" | "starting" | "started" | "refused";

export interface GroupStartEntry {
  readonly characterID: number;
  readonly state: GroupStartState;
  /** Why it refused, in the server's own words. Only set on `refused`. */
  readonly sentence?: string;
}

/**
 * Start every pilot in the group, ONE AT A TIME.
 *
 * ⚠ SEQUENTIAL, AND NOT BECAUSE IT IS SIMPLER. `App.svelte`'s `bringOnline`
 * already argues this for signing pilots in and the argument carries: a browser
 * allows about six connections per origin, so six simultaneous starts fill that
 * pool with starts and the seventh request of any kind queues behind them. Each
 * pilot also LANDS separately this way, which is what makes a progress readout
 * honest -- a row flips because that pilot is actually flying, not because a
 * timer fired.
 *
 * ⚠ ONE REFUSAL MUST NOT STRAND THE REST OF A GROUP. A pilot already flown by a
 * bot, or by a tab, refuses with CHARACTER_IN_USE / BOT_ALREADY_RUNNING; that
 * is a fact about that pilot, not about the operation. It is recorded and the
 * next pilot is tried.
 *
 * `startOne` rejects with whatever the server said; this module turns that into
 * a sentence and carries on. It never throws.
 */
export async function startForGroup(
  characterIDs: readonly number[],
  startOne: (characterID: number) => Promise<void>,
  onProgress?: (entries: readonly GroupStartEntry[]) => void,
): Promise<readonly GroupStartEntry[]> {
  const entries: GroupStartEntry[] = characterIDs.map((characterID) => ({
    characterID,
    state: "queued" as const,
  }));
  const report = (): void => onProgress?.(entries.map((entry) => ({ ...entry })));
  report();

  for (let index = 0; index < characterIDs.length; index++) {
    const characterID = characterIDs[index]!;
    entries[index] = { characterID, state: "starting" };
    report();
    try {
      await startOne(characterID);
      entries[index] = { characterID, state: "started" };
    } catch (cause) {
      // The server's own sentence, unwrapped. There is no code-to-words layer
      // on the client for these and there should not be a second one here:
      // CHARACTER_IN_USE already says "A web session is flying this character."
      entries[index] = {
        characterID,
        state: "refused",
        sentence:
          cause instanceof Error && cause.message
            ? cause.message
            : "That pilot could not be started.",
      };
    }
    report();
  }
  return entries;
}

/** Every pilot has reached a final state. */
export function groupStartFinished(entries: readonly GroupStartEntry[]): boolean {
  return entries.every((entry) => entry.state === "started" || entry.state === "refused");
}

/**
 * How the run went, in one line, once it is over.
 *
 * ⚠ THE EMPTY CASE IS THE CALLER'S WORDS, NOT THIS MODULE'S. "Nobody was
 * started" means something different per caller -- for a start that needs a
 * setup per pilot it is "no pilot here is set up to fly one", for a saved bot on a group it is "every
 * pilot is already flying something" -- and a generic sentence would be wrong
 * in both places. Everything after the empty case is the same arithmetic
 * whatever was started, which is why it lives here at all.
 */
export function groupStartSummary(
  entries: readonly GroupStartEntry[],
  emptyWords: string,
): string {
  const started = entries.filter((entry) => entry.state === "started").length;
  const refused = entries.filter((entry) => entry.state === "refused").length;
  if (entries.length === 0) {
    return emptyWords;
  }
  if (refused === 0) {
    return started === 1 ? "One pilot is flying." : `${started} pilots are flying.`;
  }
  if (started === 0) {
    return refused === 1 ? "That pilot could not start." : `None of the ${refused} could start.`;
  }
  return `${started} flying, ${refused} could not start.`;
}
