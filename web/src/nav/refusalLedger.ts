// What the server has been turning down, and how long it has been saying no.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// A bot answered 227 consecutive NotEnoughCargoSpace refusals over TWELVE HOURS
// and reported "Taking what's inside." throughout. The refusals existed only in
// the BFF's log, because `scriptRunner.ts` caught every non-session error and
// dropped it with a comment — no counter, no store event, no status change, and
// the same settle window as a success, so it retried at full speed forever.
//
// Nothing here fixes a refusal. This is the thing that NOTICES one, and that
// turns out to be the whole difference between a bot that is wrong for a minute
// and a bot that is wrong overnight.
//
// ── WHY IT LIVES ON THE RUN, NOT ON THE STEP ────────────────────────────────
//
// Macros already count their own attempts (`MAX_BLOCK_ATTEMPTS`), and those
// counters do not hold: `scriptDecide.ts` drops a step's memory whenever the
// step is left, so a `forever` loop hands the same failing target a fresh
// budget on every lap. That is exactly why the log shows repeating bursts of
// five rather than one burst and then silence. A ledger owned by the RUNNER
// outlives the step, so its bound is the one that actually binds.
//
// ── THE RULE IT KEEPS ───────────────────────────────────────────────────────
//
// Wording goes through `describeRefusal`, which R31 makes the ONLY place a
// refusal becomes language. Nothing here writes a sentence of its own and
// nothing here shows a code to a player.

import { describeRefusal } from "../bridge/refusals.ts";

/**
 * What kind of "no" this was.
 *
 * ⚠ `gone` AND `unreachable` ARRIVE AS THE SAME SERVER CODE, and telling them
 * apart matters more than it looks. eve.js's `Handle_GetInventoryFromId` throws
 * `FakeItemNotFound` both when an itemID matches no inventory target at all AND
 * when its own scene/range check fails — so a can that merely drifted out of
 * range between the snapshot tick and the bind call is reported exactly like one
 * that despawned. Retiring a target on the bare code would abandon every can the
 * ship drifted away from, which on a jetcan hauling loop is most of them.
 *
 * The caller separates them with something it already holds: if the target is
 * still in this tick's snapshot it is `unreachable` (close the distance); if it
 * has left the snapshot too, it is `gone`.
 */
export type RefusalKind = "refused" | "unreachable" | "gone" | "no-room" | "no-funds";

/**
 * The marker a caller puts in front of a "nothing I am carrying will fit"
 * failure. A sentinel rather than a phrase match, so the wording stays free to
 * change; `describeRefusal` looks past the prefix and shows the sentence.
 */
export const NO_ROOM_CODE = "NO_ROOM_ABOARD";

/**
 * Is this that failure, asked of the thrown error rather than of a wire string?
 *
 * ⚠ THE MARKER IS IN THE MESSAGE, WHICH IS RIGHT FOR A LEDGER AND WRONG FOR A
 * PERSON. `classifyRefusal` reads raw text, so the sentinel has to travel in it
 * — but `panelErrorWords` has no code table for an error this client minted
 * itself and falls through to `error.message`, which would put NO_ROOM_ABOARD on
 * screen verbatim in the one place R9a matters most. A surface that reports to a
 * player asks here and writes its own sentence instead.
 */
export function isNoRoomAboard(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause ?? "");
  return text.includes(NO_ROOM_CODE);
}

export interface RefusalRecord {
  /** stepPath + action kind + target, so one failing can does not mask another. */
  readonly key: string;
  /** Actual addressed target when known; metadata does not split the streak key. */
  readonly targetID?: number;
  /** Consecutive failures. Reset by the first success on the same key. */
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  /** Player language, from `describeRefusal`. Never a code. */
  readonly words: string;
  readonly kind: RefusalKind;
}

/**
 * Consecutive failures on ONE key before the run stops rather than keeps asking.
 *
 * Deliberately larger than a macro's own `MAX_BLOCK_ATTEMPTS` (5): that one
 * bounds a single visit to a block and is right to be twitchy, because giving up
 * on one can and trying the next is cheap. This one ends the RUN, so it should
 * only fire when a thing has been refused past any reasonable doubt. With the
 * backoff below, ten of these take a couple of minutes — minutes, not twelve
 * hours, which was the entire problem.
 */
export const MAX_CONSECUTIVE_REFUSALS = 10;

/**
 * How much more patience an unreachable target gets than a refusing one, before
 * even it is set aside. Generous, because closing distance genuinely takes ticks
 * and giving up early on a can the ship is simply flying towards would be worse
 * than waiting.
 */
const UNREACHABLE_PATIENCE = 4;

/** Base settle, matching the runner's own SETTLE_TICKS. */
const BASE_SETTLE_TICKS = 2;
/** Ceiling on the backoff, in ticks (~2s each), so a run never sleeps forever. */
const MAX_SETTLE_TICKS = 30;

/**
 * How long to wait after the Nth consecutive failure on a key.
 *
 * Linear rather than geometric, and capped. The point is not to be clever: it is
 * that retrying a hold that has no room, at full speed, 227 times, is pure noise
 * against the server — while a bot that has hit one bad can should still be
 * responsive when the player comes back to it.
 */
export function settleTicksForRefusals(count: number): number {
  if (!(count > 0)) {
    return BASE_SETTLE_TICKS;
  }
  return Math.min(BASE_SETTLE_TICKS + count * 2, MAX_SETTLE_TICKS);
}

/**
 * The step id a call with NO step is booked under.
 *
 * Exported because a decider can BORROW a block for such a call — the trip home
 * the runner latches itself is the case — and the block reads the ledger by the
 * id of the step it is handed. Handing it this one is how it finds its own
 * records.
 */
export const NO_STEP_ID = "-";

/**
 * The identity of a failure. A target id is part of it on purpose: one jetcan
 * that will not give up its contents must not spend the budget that belongs to
 * the next one, and must not be masked by it either.
 */
export function refusalKey(
  stepPath: string | null,
  actionKind: string,
  targetID: number | null,
): string {
  return `${stepPath ?? NO_STEP_ID}:${actionKind}:${targetID ?? "-"}`;
}

/** Classify a raw wire refusal. `stillOnGrid` is only consulted for a bind miss. */
export function classifyRefusal(raw: string, stillOnGrid: boolean | null): RefusalKind {
  const text = String(raw ?? "");
  // ⚠ A PROPERTY OF THE SHIP, NOT OF THE THING BEING ADDRESSED. Nothing about
  // the next container will be different: the hold that had no room for this one
  // has no room for that one either. Kept apart from an ordinary refusal so a
  // block can stop asking rather than prove it once per target — which is
  // exactly what it did, at five attempts and a growing backoff EACH, and which
  // reads as a bot that has hung.
  if (text.includes(NO_ROOM_CODE)) {
    return "no-room";
  }
  // A PROPERTY OF THE WALLET, the same way: the next launchpad's tax is paid
  // from the same balance that just could not pay this one.
  if (/NotEnoughMoney/.test(text)) {
    return "no-funds";
  }
  if (!/FakeItemNotFound/i.test(text)) {
    return "refused";
  }
  // The object could not be bound. Still on the grid this tick means it exists
  // and we are simply too far away or off its scene; absent from the grid too
  // means it has genuinely stopped existing. An UNREADABLE grid (null) is not
  // evidence of either, and "we could not look" must never retire a target —
  // so it reads as the recoverable one.
  return stillOnGrid === false ? "gone" : "unreachable";
}

export interface RefusalLedger {
  /** Record one failure and return the running record for its key. */
  note(key: string, raw: string, at: number, stillOnGrid: boolean | null, targetID?: number): RefusalRecord;
  /** A success on this key: the streak is over. */
  clear(key: string): void;
  /**
   * Something moved, so a hold that had no room may have room now. Forgets every
   * `refused` streak — and ONLY those.
   *
   * ⚠ WITHOUT THIS, SETTING A CAN ASIDE IS PERMANENT. A can is set aside because
   * it kept refusing, and it kept refusing because the hold was full; once the
   * hold is emptied nothing would ever try that can again, because the only
   * thing that clears a streak is a success on the same key and the block has
   * stopped issuing one. A hauler would set aside every can on the belt over a
   * few laps and then quietly find nothing to do.
   *
   * `gone` and `unreachable` survive on purpose: emptying a hold does not bring
   * back a despawned container, and does not close a distance.
   */
  forgetRefused(capacityRecovered?: boolean): void;
  /** Consecutive failures on this key, 0 when it is not failing. */
  consecutive(key: string): number;
  /** Everything currently failing, worst first — what a readout shows. */
  records(): readonly RefusalRecord[];
}

/**
 * A run's ledger. Mutable and closure-owned, the same shape as
 * `createCapabilityCache` — the runner owns exactly one and drops it when the
 * run ends, which is what makes "per run" true without any explicit lifetime.
 */
export function createRefusalLedger(): RefusalLedger {
  const byKey = new Map<string, RefusalRecord>();
  return {
    note(key, raw, at, stillOnGrid, targetID) {
      const previous = byKey.get(key) ?? null;
      const record: RefusalRecord = {
        key,
        ...(targetID === undefined ? {} : { targetID }),
        count: (previous?.count ?? 0) + 1,
        firstAt: previous?.firstAt ?? at,
        lastAt: at,
        words: describeRefusal(raw).text,
        kind: classifyRefusal(raw, stillOnGrid),
      };
      byKey.set(key, record);
      return record;
    },
    clear(key) {
      byKey.delete(key);
    },
    forgetRefused(capacityRecovered = false) {
      for (const [key, record] of byKey) {
        if (record.kind === "refused" || (capacityRecovered && record.kind === "no-room")) {
          byKey.delete(key);
        }
      }
    },
    consecutive(key) {
      return byKey.get(key)?.count ?? 0;
    },
    records() {
      return [...byKey.values()].sort((left, right) => right.count - left.count);
    },
  };
}

// ── The read side: what a PLAYER is shown ───────────────────────────────────

/**
 * How long after its last refusal a line stays on a running bot's readout.
 *
 * Longer than the longest backoff (MAX_SETTLE_TICKS, about a minute), so
 * something still being refused never blinks off between two attempts.
 */
export const REFUSAL_LINE_SHOWN_MS = 2 * 60_000;

export interface RefusalLine {
  readonly words: string;
  /** Refusals in these words, across every target that drew them. */
  readonly count: number;
}

/**
 * The ledger as lines to read: one per sentence, most refused first.
 *
 * ⚠ A RECORD OUTLIVES ITS LINE ON PURPOSE. A target that was set aside is never
 * asked again, so nothing ever clears its record, and the ledger has to keep it
 * for `shouldSetAside` to go on working. So age is applied here, to what is
 * shown, and never to the ledger itself.
 *
 * `now` is null when nothing is being asked any more (a paused or stopped run):
 * the lines then stay, because they are why it stopped.
 */
export function refusalLines(records: readonly RefusalRecord[], now: number | null): readonly RefusalLine[] {
  const countByWords = new Map<string, number>();
  for (const record of records) {
    if (now !== null && now - record.lastAt > REFUSAL_LINE_SHOWN_MS) {
      continue;
    }
    countByWords.set(record.words, (countByWords.get(record.words) ?? 0) + record.count);
  }
  return [...countByWords]
    .map(([words, count]) => ({ words, count }))
    .sort((left, right) => right.count - left.count);
}

// ── The read side: what a DECIDER asks ──────────────────────────────────────

/** The record for one target, or null when it is not currently failing. */
export function refusalFor(
  records: readonly RefusalRecord[] | null | undefined,
  stepID: string | null,
  actionKind: string,
  targetID: number | null,
): RefusalRecord | null {
  if (!records) {
    return null;
  }
  const key = refusalKey(stepID, actionKind, targetID);
  return records.find((record) => record.key === key) ?? null;
}

/** Older observations omit target metadata and retain their existing handling. */
export function refusalTargets(
  record: { readonly targetID?: number } | null | undefined,
  targetID: number,
): boolean {
  return record?.targetID === undefined || record.targetID === targetID;
}

/**
 * Should a block stop offering this target?
 *
 * ⚠ THIS REPLACES A PER-STEP `tries` COUNTER, AND THAT IS THE WHOLE POINT.
 * A macro's own bookkeeping lives in step memory, which `scriptDecide` drops
 * every time the step is left — so on a `forever` loop the same stubborn can
 * got a fresh five-attempt budget every lap, which is exactly why the original
 * log shows repeating bursts of five rather than one burst and then silence.
 * The ledger is owned by the RUN, so a bound expressed against it actually
 * binds.
 *
 * `gone` is set aside at once: there is nothing there to try. `unreachable` is
 * NEVER set aside — the object exists and the answer is to close the distance,
 * not to give up on it.
 */
export function shouldSetAside(
  records: readonly RefusalRecord[] | null | undefined,
  stepID: string | null,
  actionKind: string,
  targetID: number | null,
  limit: number,
): boolean {
  const record = refusalFor(records, stepID, actionKind, targetID);
  if (record === null) {
    return false;
  }
  if (record.kind === "gone") {
    return true;
  }
  if (record.kind === "unreachable") {
    // Never retired on the ordinary bound: the object exists and the answer is
    // to close the distance. But not forever either — a target that cannot be
    // reached after many tries is one this ship is never going to reach, and
    // approaching it for the rest of the run is its own kind of stuck.
    return record.count >= limit * UNREACHABLE_PATIENCE;
  }
  return record.count >= limit;
}

/** True when the last attempt on this target failed to reach it. */
export function isUnreachable(
  records: readonly RefusalRecord[] | null | undefined,
  stepID: string | null,
  actionKind: string,
  targetID: number | null,
): boolean {
  return refusalFor(records, stepID, actionKind, targetID)?.kind === "unreachable";
}

/**
 * Has this step been told there is nowhere aboard to put what it is finding?
 *
 * Asked per STEP rather than per target, because that is the scope of the fact.
 */
export function shipHasNoRoom(
  records: readonly RefusalRecord[] | null | undefined,
  stepID: string | null,
  actionKind: string,
): boolean {
  if (!records) {
    return false;
  }
  const prefix = `${stepID ?? NO_STEP_ID}:${actionKind}:`;
  return records.some((record) => record.kind === "no-room" && record.key.startsWith(prefix));
}

/** Whether this step's `actionKind` was refused because the wallet could not pay. */
export function pilotCannotPay(
  records: readonly RefusalRecord[] | null | undefined,
  stepID: string | null,
  actionKind: string,
): boolean {
  if (!records) {
    return false;
  }
  const prefix = `${stepID ?? NO_STEP_ID}:${actionKind}:`;
  return records.some((record) => record.kind === "no-funds" && record.key.startsWith(prefix));
}
