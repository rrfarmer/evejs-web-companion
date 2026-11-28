// WC74 web/src/app/controlPlanePoll.ts @ 213da333; imports adapted for UOC plugin.
/** Read-only reconnect boundary. Auth loss retains the last projection, pauses
 * polling, and requires the ordinary login UI. No bot/session mutation API. */
type Timer = number | ReturnType<typeof setTimeout>;
export function createControlPlanePoll<T>(deps: {
  read(): Promise<T>;
  received(value: T): void;
  failed(error: unknown, authLost: boolean): void;
  schedule?(fn: () => void, ms: number): Timer;
  cancel?(timer: Timer): void;
}) {
  let timer: Timer | null = null;
  let suspended = false,
    disposed = false,
    busy = false,
    failures = 0,
    revision = 0;
  const cancel = () => {
    if (timer !== null) (deps.cancel ?? clearTimeout)(timer);
    timer = null;
  };
  async function refresh(): Promise<void> {
    if (disposed || suspended || busy) return;
    cancel();
    busy = true;
    const started = revision;
    try {
      const value = await deps.read();
      if (!disposed && started === revision) {
        failures = 0;
        deps.received(value);
      }
    } catch (error) {
      if (disposed || started !== revision) return;
      suspended = (error as { status?: number })?.status === 401;
      failures++;
      deps.failed(error, suspended);
    } finally {
      busy = false;
      if (!disposed && !suspended)
        timer = (deps.schedule ?? setTimeout)(
          () => void refresh(),
          started !== revision ? 0 : Math.min(30_000, 3000 * 2 ** Math.min(failures, 4)),
        );
    }
  }
  return {
    refresh,
    invalidate() {
      revision++;
    },
    reconnect() {
      if (disposed) return;
      suspended = false;
      failures = 0;
      return refresh();
    },
    stop() {
      disposed = true;
      cancel();
    },
  };
}
