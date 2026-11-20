// Open a ship's hold from Fitting or Personal Assets. Inventory shows the requested hull with that hold unfolded.
//
// Watched by the workspace, which opens the inventory, and by the inventory panel, which takes the hold asked for (as
// it mounts, and while it is open). The workspace watches the request counter, as the market details' request is
// watched (marketDetails.ts).

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

/** The holds the readouts open, by the bays' keys. */
export type ShipHoldKey = "cargo" | "drone" | "fighter";

interface ShipHoldRequest {
  readonly key: ShipHoldKey;
  readonly shipID: number | null;
}

export interface ShipHoldTarget {
  /** How many times a hold has been asked for. */
  readonly requests: ReadableSignal<number>;
  ask(key: ShipHoldKey, shipID?: number): void;
  /** The hold asked for and not yet taken by the inventory panel, which takes it; null where there is none. */
  take(): ShipHoldRequest | null;
}

export function createShipHoldTarget(): ShipHoldTarget {
  const requests = createSignal(0);
  let pending: ShipHoldRequest | null = null;
  return {
    requests: readonlySignal(requests),
    ask(key, shipID) {
      pending = { key, shipID: shipID ?? null };
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

export const shipHoldTarget: ShipHoldTarget = createShipHoldTarget();

/** Without a ship ID, uses the active hull as the Fitting readouts do. */
export function openShipHold(key: ShipHoldKey, shipID?: number): void {
  shipHoldTarget.ask(key, shipID);
}
