// The play page's own ballpark, fed live by the BFF (GET /api/play/destiny) and stepped by the pilot's sim
// clock, as the retail client's michelle steps its park. Every frame: step the park to the clock
// (Park.onTick) and draw each ball where the client would (Ballpark.drawn, ClientBall::InterpolatedPosition).
// The code is the BFF's own (virtual:destiny), so the BFF's park and this one agree tick for tick.

import { Park, Ballpark, marshalDecode, readFeedItem, applyToPark, type Ball, type FeedItem } from "virtual:destiny";

export interface FeedHello { simTime: number; solarSystemID: number | null; shipID: number | null; characterID: number; timeAdjusted?: number; reset?: boolean }

export class LivePark {
  park = this.wire(new Park({ ballpark: new Ballpark() }));
  /** Who hears the park's special effects (michelle.OnSpecialFX: weapons fire, warping, repairs...), each its arguments. */
  readonly fxListeners = new Set<(args: readonly unknown[]) => void>();
  readonly failures: string[] = [];
  hello: FeedHello | null = null;
  items = 0;
  /** How many times the park has been made anew (a new system, docking, undocking). */
  resets = 0;
  status: "connecting" | "live" | "ended" | "error" = "connecting";
  private source: EventSource | null = null;
  /** The pilot's sim clock less performance.now(), from the BFF's latest reading. */
  private offset: number | null = null;
  private lastSim = -Infinity;
  private readonly listeners = new Set<() => void>();

  /** Listen to `url` (the feed route with the session token in its query, as EventSource cannot send headers). */
  connect(url: string): void {
    this.close();
    const source = new EventSource(url);
    this.source = source;
    source.addEventListener("hello", (e) => {
      this.hello = JSON.parse((e as MessageEvent).data) as FeedHello;
      // The pilot's ballpark let go or made anew (docked, undocked, a new system): michelle.UpdateBallpark releases the
      // old park and makes a new one, which the new system's SetState fills.
      if (this.hello.reset) {
        this.park = this.wire(new Park({ ballpark: new Ballpark() }));
        this.items = 0;
        this.resets++;
      }
      this.setClock(this.hello.simTime);
      // Joining in flight: the BFF's park has been moved by every sim-clock rebase so far, and this one, which
      // heard none of them, is moved as much before its first update (Park.timeAdjusted).
      if (this.items === 0 && this.hello.timeAdjusted) this.park.adjustTimes(this.hello.timeAdjusted);
      this.status = "live";
      this.changed();
    });
    source.addEventListener("clock", (e) => this.setClock((JSON.parse((e as MessageEvent).data) as { simTime: number }).simTime));
    source.addEventListener("destiny", (e) => {
      const item = JSON.parse((e as MessageEvent).data) as FeedItem;
      this.setClock(item.atMs);
      this.apply(item);
    });
    source.addEventListener("ended", () => { this.status = "ended"; this.changed(); source.close(); });
    source.onerror = () => { if (this.status !== "ended") { this.status = "error"; this.changed(); } };
  }

  /** A park whose special effects go to the listeners (Park.onEvent, as the BFF's own park hands them on). */
  private wire(park: Park): Park {
    (park as unknown as { onEvent: (name: string, args: readonly unknown[]) => void }).onEvent = (name, args) => {
      if (name !== "OnSpecialFX") return;
      for (const fn of this.fxListeners) { try { fn(args); } catch { /* a listener's failure is its own */ } }
    };
    return park;
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** One feed item into the park, as michelle hands it a notification. */
  apply(item: FeedItem): void {
    const { method, args } = readFeedItem(item, marshalDecode);
    // Step to the moment the item arrived before applying it, as the BFF's park had stepped when it got it.
    this.park.onTick(this.simNow());
    applyToPark(this.park, method, args, (name, fn) => {
      try { fn(); } catch (e) { this.failures.push(`${name}: ${(e as Error).message}`); }
    });
    this.items++;
  }

  private setClock(simTime: number): void {
    const offset = simTime - performance.now();
    // Readings arrive late by the trip from the BFF; keep the latest, never letting the clock run back.
    this.offset = this.offset === null ? offset : Math.max(this.offset - 50, Math.min(this.offset + 1000, offset));
  }

  /** The pilot's sim clock now, in milliseconds; never earlier than a reading already used. */
  simNow(): number {
    if (this.offset === null) return 0;
    this.lastSim = Math.max(this.lastSim, performance.now() + this.offset);
    return this.lastSim;
  }

  /** Step the park to the clock; call once per frame. */
  frame(): number {
    if (this.offset === null) return 0;
    return this.park.onTick(this.simNow());
  }

  /** Where the client draws a ball now, and how fast it is going (EVE's own left-handed space). */
  drawn(ball: Ball): { p: { x: number; y: number; z: number }; v: { x: number; y: number; z: number } } {
    return (this.park.ballpark as unknown as { drawn(b: Ball, t: number): { p: { x: number; y: number; z: number }; v: { x: number; y: number; z: number } } }).drawn(ball, this.simNow());
  }

  balls(): IterableIterator<Ball> {
    return this.park.ballpark.balls.values();
  }
}
