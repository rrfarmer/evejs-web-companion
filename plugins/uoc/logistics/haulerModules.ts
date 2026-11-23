import { decidePropulsionModule, isHostile, REPAIR_CAP_FLOOR, scrammedByWarpScrambler,
  type decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";

type Grid = ReturnType<typeof decodeSpaceSnapshot>;
type Order = { itemID: number; on: boolean; effect: string | null };

export function closingToDockOrGate(grid: Grid): boolean {
  const ship = grid.ship;
  if (!ship?.geometryAvailable || ship.mode?.toUpperCase() !== "FOLLOW") return false;
  const targetID = grid.entities.find(row => row.itemID === ship.itemID)?.targetEntityID;
  const target = grid.entities.find(row => row.itemID === targetID);
  if (!target?.geometryAvailable || !["station", "structure", "stargate"].includes(target.kind ?? "")) return false;
  const a = ship.position, b = target.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - ship.radius - target.radius > Math.max(2500, ship.followRange ?? 0) + 5000;
}

/** Optional work on existing Hauler grid observations. Freight and navigation never await it. */
export function createHaulerModules(session: PilotSession, characterID: number) {
  const { flying } = session.flow;
  let working: Promise<void> | undefined, fittedShip: number | null = null, nextFitAt = 0;
  let lastSample: number | null = null;
  const pending = new Map<number, { on: boolean; retryAt: number }>();
  let latest: { grid: Grid; burn: boolean | null; receivedAt: number; current: () => void } | undefined;

  function observe(grid: Grid, burn: boolean | null, current: () => void) {
    if (!grid.inSpace || grid.stateValid === false || !grid.shipID || grid.ship?.itemID !== grid.shipID ||
        grid.ship.characterID !== null && grid.ship.characterID !== characterID || !grid.ship.activeModuleIDs ||
        grid.sampledAtMs === null || grid.ship.warp || grid.ship.mode?.toUpperCase() === "WARP") { latest = undefined; return; }
    const receivedAt = latest?.grid.shipID === grid.shipID && latest.grid.sampledAtMs === grid.sampledAtMs ? latest.receivedAt : performance.now();
    latest = { grid, burn, current, receivedAt };
    working ??= service().catch(() => {}).finally(() => { working = undefined; });
  }

  async function service() {
    const first = latest!;
    const shipID = first.grid.shipID!;
    first.current();
    if (flying.isSessionClosing() || session.store.station.get().online?.characterID !== characterID) return;
    if (fittedShip !== shipID || session.store.fitting.get().activeShipID !== shipID) {
      if (Date.now() < nextFitAt) return;
      nextFitAt = Date.now() + 5000;
      if (!await flying.readFit() || session.store.fitting.get().activeShipID !== shipID) return;
      fittedShip = shipID;
      pending.clear();
      lastSample = null;
    }
    const sample = latest;
    if (!sample) return;
    const { grid, burn, current } = sample, ship = grid.ship!;
    if (grid.shipID !== shipID || grid.sampledAtMs === lastSample || performance.now() - sample.receivedAt > 3000) return;
    current();
    if (flying.isSessionClosing() || session.store.station.get().online?.characterID !== characterID) return;
    lastSample = grid.sampledAtMs;
    const fit = flying.resolveDefenseModuleIDs(), active = new Set(ship.activeModuleIDs);
    const cap = ship.capacitorRatio, orders: Order[] = [];
    const threatened = grid.entities.some(row => row.kind === "ship" && row.hullRatio !== 0 && isHostile(row) &&
      (row.targetEntityID === shipID || session.store.targeting.get().lockedByIDs?.includes(row.itemID)));
    const plan = (itemID: number, on: boolean, effect: string | null = null) => {
      const previous = pending.get(itemID);
      if (previous && (active.has(itemID) === previous.on || Date.now() >= previous.retryAt)) pending.delete(itemID);
      if (active.has(itemID) !== on && (!pending.has(itemID) || pending.get(itemID)?.on !== on)) orders.push({ itemID, on, effect });
    };

    const repair = (ids: readonly number[], ratio: number | null, threshold: number) => {
      for (const id of ids) {
        if (cap !== null && cap < REPAIR_CAP_FLOOR || ratio !== null && ratio >= threshold) plan(id, false);
        else if (cap !== null && ratio !== null &&
          (!fit.ancillary.includes(id) || session.store.fitting.get().slots.some(slot => slot.module?.itemID === id && (slot.module.charge?.quantity ?? 0) > 0))) plan(id, true);
      }
    };
    repair(fit.shield, ship.shieldRatio, .9);
    repair(fit.armor, ship.armorRatio, .9);
    repair(fit.hull, ship.hullRatio, .99);
    if (cap !== null) for (const id of fit.hardeners) plan(id, threatened && cap >= REPAIR_CAP_FLOOR);
    if (burn !== null && cap !== null) {
      const propulsion = decidePropulsionModule({ modules: fit.propulsion.filter(module => module.kind !== null),
        activeModuleIDs: active, capacitorRatio: cap, scrammed: scrammedByWarpScrambler(session.store.space.get().jams, Date.now()),
        wantBurn: burn, capFloor: .3 });
      if (propulsion.kind !== "none") plan(propulsion.module.itemID, propulsion.kind === "light",
        propulsion.module.kind === "afterburner" ? "moduleBonusAfterburner" : "moduleBonusMicrowarpdrive");
    }

    await Promise.allSettled(orders.map(async ({ itemID, on, effect }) => {
      current();
      const order = { on, retryAt: Infinity };
      pending.set(itemID, order);
      try {
        if (on) await flying.bridgeDo("dogmaIM", "Activate", [itemID, "", null, -1]);
        else await flying.bridgeDo("dogmaIM", "Deactivate", [itemID, effect]);
        order.retryAt = Date.now() + 5000;
      } catch (error) {
        const refusal = error as { code?: string; status?: number } | null;
        if (refusal?.code === "CALL_REFUSED" && refusal.status === 409) order.retryAt = Date.now() + 5000;
      }
    }));
  }

  return observe;
}
