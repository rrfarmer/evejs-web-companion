// NOTICES (goal R80) — the things worth interrupting a player for, and the log
// that keeps them.
//
// Plenty already HAPPENS in this client that a pilot would want to know about
// without staring at the panel it happened in: a pirate lands on the belt, the
// hold fills, a bot stops, the server refuses something. Until now each of those
// was reported only inside its own panel, so anything that happened in a window
// you had closed happened silently.
//
// ---------------------------------------------------------------------------
// TWO SURFACES, ONE LIST
//
// A toast is the transient half and the log is the permanent half, and they are
// the SAME notices — a toast is simply a recent one that has not been dismissed.
// Keeping one list is what stops the log from missing something the toast
// showed, which is the failure that makes a notification log worthless.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT A NOTICE MUST NEVER BE
//
//   • A poll result restated every second. Everything here is deduplicated by a
//     caller-supplied key within a window, because the sources are polling loops
//     — a hostile that is still on the grid a second later is not a new arrival,
//     and a toast stack that re-announced it would be unreadable within seconds.
//   • Colour alone. Every notice carries a `kind` AND a text `title`; the
//     styling is reinforcement.
//   • Unbounded. The log is capped, because a mining session runs for hours.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { playCue } from "./sound.ts";

/** How loud a notice is. Always paired with words — never the only signal. */
export type NoticeKind = "info" | "good" | "warn" | "danger";

export interface Notice {
  /** Monotonic id, used as a list key and to dismiss. Never rendered. */
  readonly id: number;
  readonly kind: NoticeKind;
  readonly title: string;
  /** Optional second line. */
  readonly detail: string | null;
  /** When it happened, in browser-clock milliseconds. */
  readonly atMs: number;
  /**
   * The dedupe key. Two notices with the same key inside `DEDUPE_MS` are the
   * same event being re-observed by a polling loop, not two events.
   */
  readonly key: string;
  /** What a click on it does, where it takes one (a notification's popup); none where it does not. */
  readonly action?: (() => void) | null;
}

/** A notice a caller is asking to raise. */
export interface NoticeInput {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly detail?: string | null;
  /** Defaults to the title, which is right for most one-off messages. */
  readonly key?: string;
  /** What a click on it does, where it takes one. */
  readonly action?: (() => void) | null;
  /** The notice's sender (a mail's), for the notification feed's portrait. */
  readonly senderID?: number | null;
}

/**
 * How long a repeat of the same key is treated as the same event.
 *
 * Sized against the SOURCES, not against taste: the space snapshot polls about
 * once a second and the bot loops tick on a similar beat, so anything under a
 * couple of seconds would still let a standing condition ("a pirate is here")
 * re-announce itself. Thirty seconds is long enough to cover a stable condition
 * and short enough that a genuinely repeated event — a second volley, a second
 * rat — is still reported.
 */
export const DEDUPE_MS = 30_000;

/** How long a toast stays on screen before it retires into the log. */
export const TOAST_MS = 7_000;

/** How many notices the log keeps. A mining session runs for hours. */
export const LOG_CAP = 200;

/**
 * Is this notice still a toast at `nowMs`?
 *
 * Pure and caller-driven so the component owns WHEN to ask (a timer it can stop
 * when the tab is hidden) and this owns the rule.
 */
export function isToastLive(notice: Notice, nowMs: number): boolean {
  return nowMs - notice.atMs < TOAST_MS;
}

/**
 * Should this input be dropped as a repeat?
 *
 * ⚠ IT COMPARES AGAINST THE MOST RECENT MATCHING KEY, NOT THE WHOLE LOG. A key
 * seen an hour ago must be allowed through again — otherwise the second time a
 * pirate ever arrives is silent, forever.
 */
export function isDuplicate(
  existing: readonly Notice[],
  key: string,
  nowMs: number,
): boolean {
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const notice = existing[index];
    if (notice && notice.key === key) {
      return nowMs - notice.atMs < DEDUPE_MS;
    }
  }
  return false;
}

export interface NoticeBoard {
  /** Every notice kept, oldest first. */
  readonly notices: ReadableSignal<readonly Notice[]>;
  /** Raise one. Returns the notice, or null when it was a repeat. */
  post(input: NoticeInput, nowMs?: number): Notice | null;
  /** Retire one from the toast stack (it stays in the log). */
  dismiss(id: number): void;
  /** Clear the log. */
  clear(): void;
  /** The ids the player has dismissed, so the toast stack can skip them. */
  readonly dismissed: ReadableSignal<ReadonlySet<number>>;
}

export function createNoticeBoard(): NoticeBoard {
  const notices = createSignal<readonly Notice[]>([]);
  const dismissed = createSignal<ReadonlySet<number>>(new Set());
  let nextID = 1;

  return {
    notices: readonlySignal(notices),
    dismissed: readonlySignal(dismissed),
    post: (input: NoticeInput, nowMs: number = Date.now()): Notice | null => {
      const key = input.key ?? input.title;
      const current = notices.get();
      if (isDuplicate(current, key, nowMs)) {
        return null;
      }
      const notice: Notice = {
        id: nextID,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        atMs: nowMs,
        key,
        action: input.action ?? null,
      };
      nextID += 1;
      const next = [...current, notice];
      // Trim from the FRONT: the log is a tail of what just happened, and the
      // oldest entry is the one nobody is looking for.
      notices.set(next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next);
      return notice;
    },
    dismiss: (id: number): void => {
      const next = new Set(dismissed.get());
      next.add(id);
      dismissed.set(next);
    },
    clear: (): void => {
      notices.set([]);
      dismissed.set(new Set());
    },
  };
}

/** The app's one notice board. */
export const noticeBoard: NoticeBoard = createNoticeBoard();

/**
 * Raise a notice on the shared board, and sound it.
 *
 * ⚠ THE CUE HANGS OFF `notify`, NOT OFF EACH CALLER. Every source that wants to
 * be heard already has to raise a notice to be SEEN, so tying the two together
 * means a new source gets both for free and the two can never disagree about
 * what was worth reporting. It also means the dedupe protects the audio: a
 * polling loop that re-observes a standing condition cannot machine-gun a tone.
 *
 * `playCue` is a no-op unless the player has switched sound on (R81), so this
 * costs nothing for everyone else.
 */
export function notify(input: NoticeInput): Notice | null {
  const posted = noticeBoard.post(input);
  if (posted !== null) {
    playCue(posted.kind === "danger" ? "alert" : "notice");
  }
  return posted;
}

/**
 * The notices that should be on screen right now, newest first.
 *
 * Pure, so the stack's contents are a thing a test can read rather than
 * something you have to wait seven seconds to observe.
 */
export function visibleToasts(
  notices: readonly Notice[],
  dismissed: ReadonlySet<number>,
  nowMs: number,
  cap = 4,
): readonly Notice[] {
  const live: Notice[] = [];
  for (let index = notices.length - 1; index >= 0 && live.length < cap; index -= 1) {
    const notice = notices[index];
    if (!notice || dismissed.has(notice.id) || !isToastLive(notice, nowMs)) {
      continue;
    }
    live.push(notice);
  }
  return live;
}
