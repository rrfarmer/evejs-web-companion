import { skipWhileBusy } from "./skipWhileBusy.ts";

/** Each visible period owns its reads and timers, including a return from the back/forward cache. */
export function whilePageVisible(start: (signal: AbortSignal) => void | (() => void)): () => void {
  const page = globalThis.document,
    tab = globalThis.window;
  let controller: AbortController | undefined, cleanup: void | (() => void);
  let away = false;
  function hide() {
    controller?.abort();
    controller = undefined;
    cleanup?.();
    cleanup = undefined;
  }
  function update() {
    if (away || page?.hidden) hide();
    else if (!controller) {
      controller = new AbortController();
      cleanup = start(controller.signal);
    }
  }
  function leave() {
    away = true;
    hide();
  }
  function comeBack() {
    away = false;
    update();
  }
  page?.addEventListener("visibilitychange", update);
  tab?.addEventListener("pagehide", leave);
  tab?.addEventListener("pageshow", comeBack);
  update();
  return () => {
    page?.removeEventListener("visibilitychange", update);
    tab?.removeEventListener("pagehide", leave);
    tab?.removeEventListener("pageshow", comeBack);
    hide();
  };
}

export function pollWhileVisible(
  ms: number,
  read: (signal: AbortSignal, initial: boolean) => Promise<void>,
) {
  return whilePageVisible((signal) => {
    let initial = true;
    const poll = skipWhileBusy(() => {
      const first = initial;
      initial = false;
      return read(signal, first);
    });
    void poll();
    const timer = setInterval(() => void poll(), ms);
    return () => clearInterval(timer);
  });
}
