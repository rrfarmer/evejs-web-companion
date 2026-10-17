// The flight recorder's browser-side buffer (flow.ts's botLogSink), kept pure so
// its two promises can be tested.
//
// 1. NEVER AN UNBOUNDED QUEUE. The total never exceeds `maxLines`; past it the
//    OLDEST line goes. A recorder that cannot reach the BFF must not grow until
//    the tab dies, and must never be a reason a bot stops.
// 2. A FAILED FLUSH GETS EXACTLY ONE RETRY. The batch goes back to the FRONT of
//    the buffer, marked. If it fails a second time it is dropped for good — the
//    marker is what stops a dead BFF turning the buffer into a retry loop. Lines
//    written meanwhile queue behind it, and the cap still applies to the whole.
//
// A `take` never hands out more than `maxBatch` lines: the BFF route accepts at
// most 500 per call and silently ignores the rest.

export interface BotLogBuffer<T> {
  /** Append a line. Drops the oldest once the buffer is past its cap. */
  push(line: T): void;
  /** Remove and return up to `maxBatch` of the oldest lines. */
  take(): BotLogBatch<T>;
  /**
   * A flush failed: put the batch back at the front. Lines already retried once
   * are dropped instead; the rest are marked so a second failure drops them.
   */
  requeue(batch: BotLogBatch<T>): void;
  readonly size: number;
}

export interface BotLogBatch<T> {
  readonly lines: readonly T[];
  /** @internal parallel to `lines`: true when that line has been retried. */
  readonly retried: readonly boolean[];
}

export const BOT_LOG_MAX_BUFFER = 1000;
export const BOT_LOG_MAX_BATCH = 500;

export function createBotLogBuffer<T>(
  maxLines: number = BOT_LOG_MAX_BUFFER,
  maxBatch: number = BOT_LOG_MAX_BATCH,
): BotLogBuffer<T> {
  let items: { line: T; retried: boolean }[] = [];

  function enforceCap(): void {
    if (items.length > maxLines) {
      items = items.slice(items.length - maxLines);
    }
  }

  return {
    push(line) {
      items.push({ line, retried: false });
      enforceCap();
    },
    take() {
      const taken = items.slice(0, maxBatch);
      items = items.slice(taken.length);
      return {
        lines: taken.map((item) => item.line),
        retried: taken.map((item) => item.retried),
      };
    },
    requeue(batch) {
      const back: { line: T; retried: boolean }[] = [];
      batch.lines.forEach((line, index) => {
        if (!batch.retried[index]) {
          back.push({ line, retried: true });
        }
      });
      items = [...back, ...items];
      enforceCap();
    },
    get size() {
      return items.length;
    },
  };
}
