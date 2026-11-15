export type CameraTaskEvent = "orbit" | "zoomIn" | "zoomOut";

/** CameraAchievementEventTracker accumulates the shortest yaw change while the left button is held. */
export class CameraTaskGestures {
  private orbit: { yaw: number; total: number } | null = null;
  private readonly record: (event: CameraTaskEvent) => void;

  constructor(record: (event: CameraTaskEvent) => void) {
    this.record = record;
  }

  beginOrbit(yaw: number): void {
    this.orbit = { yaw, total: 0 };
  }

  moveOrbit(yaw: number): void {
    if (!this.orbit || !Number.isFinite(yaw)) return;
    const delta = yaw - this.orbit.yaw;
    this.orbit.yaw = yaw;
    this.orbit.total += Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
    if (this.orbit.total > Math.PI / 4) {
      this.orbit = null;
      this.record("orbit");
    }
  }

  endOrbit(): void {
    this.orbit = null;
  }

  zoom(delta: number): void {
    if (Number.isFinite(delta) && delta !== 0) this.record(delta < 0 ? "zoomIn" : "zoomOut");
  }
}

/** The native mouse handlers deliver their events after one second. Keep each pilot's queue independent. */
export function createCameraTaskReporter(send: (events: readonly CameraTaskEvent[]) => Promise<readonly CameraTaskEvent[]>) {
  function newQueue() {
    return {
      events: [] as CameraTaskEvent[],
      pending: null as ReadonlySet<CameraTaskEvent> | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      sending: false,
    };
  }
  let queue = newQueue();

  function schedule(active: typeof queue): void {
    if (active.timer !== null || active.sending || active.events.length === 0) return;
    active.timer = setTimeout(() => {
      active.timer = null;
      const events = active.events.splice(0).filter(event => active.pending?.has(event) ?? true);
      if (events.length === 0) return;
      active.sending = true;
      void send(events).then(pending => { active.pending = new Set(pending); }, () => {}).finally(() => {
        active.sending = false;
        if (active === queue) schedule(active);
      });
    }, 1000);
  }

  return {
    record(event: CameraTaskEvent) {
      if (queue.pending && !queue.pending.has(event)) return;
      queue.events.push(event);
      schedule(queue);
    },
    reset() {
      if (queue.timer !== null) clearTimeout(queue.timer);
      queue = newQueue();
    },
  };
}
