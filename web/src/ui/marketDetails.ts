// A type's market details asked for from outside the market window (marketutils.ShowMarketDetails: the regional
// market window opened on that type), as the client's skill windows ask for the Skill Injector's.
//
// Watched by the workspace, which opens the market window, and by the market window, which takes the type asked
// for (as it mounts, and while it is open) and reads its market. The workspace watches the request counter, not the
// type, as Show Info's request is watched (showInfo.ts): asking twice for the same type must still bring the window
// back to the front.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface MarketDetailsTarget {
  /** The type last asked for, or null before any. */
  readonly typeID: ReadableSignal<number | null>;
  /** How many times the market details have been asked for. */
  readonly requests: ReadableSignal<number>;
  ask(typeID: number, buy?: boolean): void;
  /** The type asked for and not yet taken by the market window, which takes it; null where there is none. */
  take(): { readonly typeID: number; readonly buy: boolean } | null;
}

export function createMarketDetailsTarget(): MarketDetailsTarget {
  const typeID = createSignal<number | null>(null);
  const requests = createSignal(0);
  let pending: ReturnType<MarketDetailsTarget["take"]> = null;
  return {
    typeID: readonlySignal(typeID),
    requests: readonlySignal(requests),
    ask(next, buy = false) {
      pending = { typeID: next, buy };
      typeID.set(next);
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

export const marketDetailsTarget: MarketDetailsTarget = createMarketDetailsTarget();

/** marketutils.ShowMarketDetails(typeID): the market window opened on the type. */
export function showMarketDetails(typeID: number): void {
  marketDetailsTarget.ask(typeID);
}

/** menusvc.QuickBuy opens a one-unit buy draft. */
export function buyMarketType(typeID: number): void {
  marketDetailsTarget.ask(typeID, true);
}
