// The hosted flow consumes the same BFF SSE channel as a browser. HTTP drains
// cannot replace it: several bound reads intentionally return only their data,
// and an invitation has no later roster read that can reconstruct its payload.
//
// Here and not under src/ because a plugin's process runs flows too, and may read
// only the web sources.

import type { EventSourceLike } from "./api.ts";

interface HostedEventSourceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly retryMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: never) => void;
}

export function createHostedEventSource(url: string, {
  fetch: read = globalThis.fetch,
  retryMs = 3000,
  setTimeout: schedule = setTimeout,
  clearTimeout: unschedule = clearTimeout as unknown as (timer: never) => void,
}: HostedEventSourceOptions = {}): EventSourceLike {
  let closed = false;
  let retry: unknown = null;
  let controller: AbortController | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const source: EventSourceLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close() {
      closed = true;
      if (retry !== null) { unschedule(retry as never); retry = null; }
      controller?.abort();
      void activeReader?.cancel().catch(() => {});
    },
  };
  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    try {
      const response = await read(url, { headers: { accept: "text/event-stream" },
        signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("Hosted event channel unavailable");
      }
      if (closed) { await response.body.cancel(); return; }
      source.onopen?.();
      if (closed) { await response.body.cancel(); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      activeReader = reader;
      let pending = "";
      let data: string[] = [];
      let dataSize = 0;
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error("Hosted event frame too large");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0 && !closed) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            if (line === "") {
              if (data.length) source.onmessage?.({ data: data.join("\n") });
              data = [];
              dataSize = 0;
            } else if (line.startsWith("data:")) {
              const value = line.slice(5).replace(/^ /, "");
              data.push(value);
              dataSize += value.length + 6;
              if (dataSize > 1024 * 1024) throw new Error("Hosted event frame too large");
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (activeReader === reader) activeReader = null;
      }
    } catch { /* Details may contain the token-bearing URL; never log it. */ }
    if (!closed) {
      source.onerror?.();
      retry = schedule(() => { retry = null; void connect(); }, retryMs);
      (retry as { unref?: () => void } | null)?.unref?.();
    }
  }
  void connect();
  return source;
}
