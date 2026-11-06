import { createBotLogBuffer } from "./botLogBuffer.ts";

/** The flight recorder never has more than one delivery, including its retry, in flight. */
export function createBotLogWriter<T extends { readonly kind: string }>(
  send: (lines: readonly T[], batchID: string) => Promise<void>,
  options: { readonly schedule?: (callback: () => void) => () => void } = {},
): { write(line: T): void; flush(): Promise<void>; drain(): Promise<void> } {
  const buffer = createBotLogBuffer<T>();
  const schedule = options.schedule ?? ((callback: () => void) => {
    const timer = setTimeout(callback, 3000);
    return () => clearTimeout(timer);
  });
  let cancelScheduled: (() => void) | null = null;
  let delivery: Promise<void> | null = null;
  // LAN HTTP pages may have no randomUUID; delivery ids are bookkeeping, not
  // credentials. A per-writer random prefix and monotonic counter suffice there.
  const writerID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let batchSequence = 0;

  function scheduleFlush(): void {
    if (cancelScheduled !== null) return;
    cancelScheduled = schedule(() => {
      cancelScheduled = null;
      void flush();
    });
  }

  function flush(): Promise<void> {
    // A newer start cannot overtake the previous run's failed delivery. Keeping
    // the retry here also preserves the exact batch and its idempotency key.
    if (delivery !== null) return delivery;
    cancelScheduled?.();
    cancelScheduled = null;
    if (buffer.size === 0) return Promise.resolve();
    const batch = buffer.take();
    const batchID = globalThis.crypto?.randomUUID?.() ?? `${writerID}-${++batchSequence}`;
    delivery = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await send(batch.lines, batchID);
          break;
        } catch {
          // One retry, then drop this bounded batch. A failed recorder must
          // never block a bot or turn an unreachable BFF into an endless loop.
        }
      }
    })().finally(() => {
      delivery = null;
      if (buffer.size > 0) scheduleFlush();
    });
    return delivery;
  }

  return {
    write(line) {
      buffer.push(line);
      if (line.kind === "start" || line.kind === "end") void flush();
      else scheduleFlush();
    },
    flush,
    // `flush` waits only for the delivery in flight, leaving what was written since for the timer. A run that is
    // ending has no later: every batch is either delivered or dropped after its retry, so this always finishes.
    async drain() {
      while (delivery !== null || buffer.size > 0) await flush();
    },
  };
}
