import type { ApiOptions } from "../app/api.ts";

/** A view lease on the held cockpit, never a provisioning operation owner. */
export interface CockpitProvisioningContext {
  characterID: number | null;
  corporationID: number | null;
  shipID: number | null;
  stationID: number | null;
  structureID: number | null;
  docked: boolean;
  transitioning: boolean;
  transitionEpoch: number | null;
  options: ApiOptions;
}

export function createCockpitProvisioningLifecycle(read: () => CockpitProvisioningContext) {
  const keys = (context: CockpitProvisioningContext) => {
    const authority = JSON.stringify([context.characterID, context.corporationID,
      "token" in context.options, context.options.token]);
    return { authority, world: JSON.stringify([authority, context.shipID, context.stationID,
      context.structureID, context.docked, context.transitioning, context.transitionEpoch]) };
  };
  let current = keys(read()), generation = 0, authorityGeneration = 0, mounted = true;
  function observe(): boolean {
    const next = keys(read());
    if (next.world === current.world) return false;
    if (next.authority !== current.authority) authorityGeneration++;
    current = next; generation++;
    return true;
  }
  return {
    observe,
    dispose() { mounted = false; generation++; authorityGeneration++; },
    capture() {
      observe();
      const context = read(), captured = keys(context);
      const version = generation, authorityVersion = authorityGeneration;
      // Copy options because the flow updates its token in place on login/logout.
      const options = { ...context.options, priority: "user" as const };
      return {
        options,
        isCurrent: () => mounted && version === generation && captured.world === keys(read()).world,
        isHeld: () => mounted && authorityVersion === authorityGeneration && captured.authority === keys(read()).authority,
        assertCurrent() {
          if (!this.isCurrent()) throw new Error("Pilot, session, ship or location changed. Refresh and Review again.");
        },
        assertHeld() {
          if (!this.isHeld()) throw new Error("The held pilot session changed. Refresh and Review again.");
        },
      };
    },
  };
}

export type CockpitProvisioningLease = ReturnType<ReturnType<typeof createCockpitProvisioningLifecycle>["capture"]>;
