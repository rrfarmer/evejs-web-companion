import { isTransportTransient } from "./refusals.ts";
import type { JsonValue } from "./wire.ts";

type Evidence = Record<string, JsonValue>;
interface ObservationDeps {
  read: (shipID: number) => Promise<Evidence>;
  current: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Extend only authoritative pending OFF; never dispatch another mutation.
 * The last read is made at the deadline itself, so the verdict is never an older reading than the wait allows.
 */
export async function observeDeferredShutdown(initial: Evidence, itemID: number, deps: ObservationDeps): Promise<Evidence> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const remaining = initial.remainingMs, shipID = initial.shipID;
  if (initial.itemID !== itemID || initial.stopped !== false ||
      typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0 || remaining > 305_000 ||
      typeof shipID !== "number" || !Number.isSafeInteger(shipID) || shipID <= 0) return initial;
  const deadline = now() + remaining;
  let result = initial;
  for (;;) {
    deps.current();
    await sleep(Math.max(0, Math.min(1000, deadline - now())));
    deps.current();
    let fresh: Evidence;
    try {
      fresh = await deps.read(shipID);
    } catch (reason) {
      // A gateway timing out says nothing of the module, and a frozen server is what this wait outlasts.
      if (!isTransportTransient(reason)) throw reason;
      deps.current();
      if (now() >= deadline) return result;
      continue;
    }
    deps.current();
    if (fresh.itemID !== itemID || fresh.shipID !== shipID) return { ...fresh, stopped: null };
    result = fresh;
    if (fresh.stopped !== false || now() >= deadline) return fresh;
  }
}
