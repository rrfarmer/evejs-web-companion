// What a pilot's companion is doing, as its windows read it: a plugin state on the pilot's
// store (store.pluginState), so it clears as the pilot goes offline.

import type { ClientStore } from "../../../web/src/plugin-api/flying.ts";
import type { WritableSignal } from "../../../web/src/plugin-api/index.ts";
import type {
  CompanionAbandonmentRecord,
  CompanionOrderAuthority,
  CompanionStandingOrders,
  FleetCompanionRunState,
} from "./fleetCompanionLoop.ts";

export interface FleetCompanionState {
  readonly status: FleetCompanionRunState;
  /** Where in the ladder it is ("In warp", "Standing by"). */
  readonly phase: string | null;
  /** What it last did. */
  readonly action: string | null;
  /** WHY it did that: always present while running. */
  readonly why: string | null;
  readonly inFleet: boolean | null;
  /** Which authority the last decision came from, for the readout. */
  readonly followingOrderFrom: CompanionOrderAuthority | null;
  readonly lastOrderHeard: string | null;
  /** `targets called|all`. Null until the loop has reported. */
  readonly targetMode: "called" | "all" | null;
  /** What a run keeps across a restart. Null until the loop has reported. */
  readonly standingOrders: CompanionStandingOrders | null;
  readonly canTag: boolean | null;
  /**
   * What was missing or unusable about this pilot's fit when it started. Advisory, and
   * measured once at start: nothing here ever refused a start.
   */
  readonly fitWarnings: readonly string[];
  /**
   * Non-null while the abandonment protocol is running. It is here so a run can keep it:
   * without the clock, a restart hands the companion a fresh thirty minutes.
   */
  readonly abandonment: CompanionAbandonmentRecord | null;
  readonly startedAt: number | null;
  readonly startError: string | null;
  readonly failureReason: string | null;
  /** The run paused itself rather than being paused by the operator. */
  readonly selfPaused: boolean;
}

export const INITIAL_FLEET_COMPANION: FleetCompanionState = Object.freeze({
  status: "idle" as FleetCompanionRunState,
  phase: null,
  action: null,
  why: null,
  inFleet: null,
  followingOrderFrom: null,
  lastOrderHeard: null,
  targetMode: null,
  standingOrders: null,
  canTag: null,
  fitWarnings: Object.freeze([]) as readonly string[],
  abandonment: null,
  startedAt: null,
  startError: null,
  failureReason: null,
  selfPaused: false,
});

/** This pilot's companion state. */
export function companionState(store: ClientStore): WritableSignal<FleetCompanionState> {
  return store.pluginState<FleetCompanionState>("plugin:fleet-companion", INITIAL_FLEET_COMPANION);
}

export type CompanionEvent =
  | { readonly type: "companion/started"; readonly startedAt: number; readonly fitWarnings: readonly string[] }
  | {
      readonly type: "companion/progress";
      readonly status: FleetCompanionRunState;
      readonly phase: string | null;
      readonly action: string | null;
      readonly why: string | null;
      readonly inFleet: boolean | null;
      readonly followingOrderFrom: CompanionOrderAuthority | null;
      readonly lastOrderHeard: string | null;
      readonly targetMode: "called" | "all";
      readonly standingOrders: CompanionStandingOrders;
      readonly canTag: boolean | null;
      readonly abandonment: CompanionAbandonmentRecord | null;
      readonly failureReason: string | null;
      readonly selfPaused: boolean;
    }
  | { readonly type: "companion/start-error"; readonly message: string | null }
  | { readonly type: "companion/cleared" };

export function applyCompanionEvent(store: ClientStore, event: CompanionEvent): void {
  const state = companionState(store);
  switch (event.type) {
    case "companion/started":
      state.set({ ...INITIAL_FLEET_COMPANION, status: "running", startedAt: event.startedAt, fitWarnings: event.fitWarnings });
      return;
    case "companion/progress": {
      const { type: _type, ...progress } = event;
      state.set({ ...state.get(), ...progress });
      return;
    }
    case "companion/start-error":
      state.set({ ...state.get(), status: "idle", startError: event.message });
      return;
    case "companion/cleared":
      state.set(INITIAL_FLEET_COMPANION);
      return;
  }
}
