// Contracts of a type asked for from outside the contracts window (menusvc's Find in Contracts: contracts.FindRelated,
// contracts.py 131 to 135, which opens the window on its Contract Search tab, idx 2, and searches; OpenSearchTab 833
// to 838).
//
// Watched as the market's details are (marketDetails.ts): by the workspace, which opens the contracts window, and by
// the window, which takes the type (as it mounts, and while it is open) and searches.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface ContractsSearchTarget {
  /** How many times a search has been asked for. */
  readonly requests: ReadableSignal<number>;
  ask(typeID: number | null): void;
  /** A pending search may have no type filter. */
  take(): { readonly typeID: number | null } | null;
}

export function createContractsSearchTarget(): ContractsSearchTarget {
  const requests = createSignal(0);
  let pending: { readonly typeID: number | null } | null = null;
  return {
    requests: readonlySignal(requests),
    ask(typeID) {
      pending = { typeID };
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

export const contractsSearchTarget: ContractsSearchTarget = createContractsSearchTarget();

/** contracts.FindRelated(typeID, None, None, None, None, None): the contracts window searching the type. */
export function findInContracts(typeID: number | null): void {
  contractsSearchTarget.ask(typeID);
}
