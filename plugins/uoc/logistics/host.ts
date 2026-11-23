import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { parkWithPolicy } from "../shared/parking.ts";
import { heldServiceScope } from "../shared/serviceScope.ts";
import { closingToDockOrGate, createHaulerModules } from "./haulerModules.ts";
import { candidateBays, canFitUnit, counts, freightBays, freightVolume, loadFor, minimumFill, needs, positive,
  type FreightBlock, type Load, type Office, type Operation, type Stack } from "./model.ts";
import { addedToBay, createDistributionNative, observedTransfer, proofBefore, type DistributionNative } from "./native.ts";
import type { DistributionStore, Pending, Phase, Trip } from "./store.ts";

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const subtract = <T extends Stack>(rows: readonly T[], itemID: number, quantity: number) => rows.flatMap(row =>
  row.itemID !== itemID ? [row] : row.quantity > quantity ? [{ ...row, quantity: row.quantity - quantity }] : []);
const dockName = (office: Office) => office.name ?? "the selected dock";
class StoppedPickup extends Error {}

type WorkerContext = {
  store: DistributionStore; world: string; characterID: number; io: DistributionNative;
  travel: (office: Office, shipID: number, guard: () => void) => Promise<void>;
  current: () => void; report: (phase: Phase, detail: string | null) => void; now?: () => number;
};

export function createDistributionWorker(ctx: WorkerContext) {
  const { store, world, characterID, io, travel, current } = ctx, now = ctx.now ?? Date.now;
  const waitingSince = new Map<string, number>(), retryAt = new Map<string, number>();
  let lastOperation = "", operationID: string | null = null, attention = false, retryTripAt = 0;
  let lastFlight: Awaited<ReturnType<DistributionNative["flight"]>> | undefined, flightAt = 0;

  function show(phase: Phase, detail: string | null = null) {
    attention = phase === "Attention";
    store.publish(world, characterID, lastFlight?.shipID ?? null,
      { shipTypeID: lastFlight?.shipTypeID ?? null, corporationID: lastFlight?.corporationID ?? null,
      operationID, phase, detail });
    ctx.report(phase, detail);
  }
  function running(op: Operation) {
    current();
    if (!store.isRunning(world, op)) throw new StoppedPickup();
  }
  async function inDivision<T>(corp: number, office: Office, action: () => Promise<T>) {
    if (!store.enterOffice(world, characterID, corp, office)) return undefined;
    try { return await action(); }
    finally { store.leaveOffice(world, characterID); }
  }
  function bayRows(holds: Awaited<ReturnType<DistributionNative["bays"]>>, bay: string) {
    const rows = holds.rows[bay];
    if (!rows) throw Error("The required hold in the assigned ship could not be read.");
    return rows;
  }

  async function observeDestination(op: Operation, shipID: number, corp: number) {
    const office = op.config.destination;
    const seen = store.stock(world, corp, office);
    if (seen && now() - seen.at < 60_000) return true;
    show("Checking destination", "Checking stock at " + dockName(office) + ".");
    if (lastFlight?.locationID !== office.destinationID) {
      const read = await inDivision(corp, office, async () => {
        const stock = await io.remote(office, corp).catch(() => null);
        if (stock === null) return false;
        store.observeStock(world, corp, office, stock, now());
        return true;
      });
      if (read === undefined) return false;
      if (read) return true;
      // A hauling pilot can have local Query access without remote Corporation Assets access.
      await travel(office, shipID, () => running(op));
    }
    return await inDivision(corp, office, async () => {
      const stock = await io.local(office, corp, shipID, false);
      store.observeStock(world, corp, office, stock, now());
      return true;
    }) ?? false;
  }

  async function reconcile(op: Operation, shipID: number, corp: number, pending: Pending) {
    const pickup = pending.leg === "pickup", office = pickup ? op.config.source : op.config.destination;
    const [stock, holds] = await Promise.all([io.local(office, corp, shipID, false), io.bays(shipID, [pending.line.bay])]);
    const cargo = bayRows(holds, pending.line.bay);
    const qty = pending.proof.sourceStack - ((pickup ? stock : cargo).find(row => row.itemID === pending.line.itemID)?.quantity ?? 0);
    const owned = pickup ? addedToBay(pending.proof, cargo, pending.line, pending.quantity ?? qty) : null;
    const observed = !pickup ? observedDelivery(pending, cargo, stock) :
      pending.quantity ? owned : observedTransfer(pending.proof, stock, cargo, pending.line);
    if (!observed) throw Error("The " + pending.leg + " could not be confirmed from both inventories. The transfer was kept for recheck.");
    store.settle(world, characterID, observed);
    store.observeStock(world, corp, office, stock, now());
    return { quantity: observed.quantity, cargo, stock };
  }

  async function pickup(op: Operation, shipID: number, corp: number) {
    const config = op.config, office = config.source, key = op.execution!.id;
    if (config.mode === "SUPPLY") {
      if (!await observeDestination(op, shipID, corp)) {
        show("Idle", "Waiting to read the destination division.");
        return;
      }
      const target = store.stock(world, corp, config.destination)!.quantities, reserved = store.coverage(world, op);
      if (config.items.every(item => (target[item.typeID] ?? 0) + (reserved[item.typeID] ?? 0) >= item.quantity)) {
        show("Idle", "Destination stock is at target or already on its way.");
        return;
      }
    }

    show("To source", "Travelling to " + dockName(office) + ".");
    await travel(office, shipID, () => running(op));
    const loaded = await inDivision(corp, office, async () => {
      running(op);
      show("Loading", "Checking available freight and hold space.");
      let stock = await io.local(office, corp, shipID, true);
      store.observeStock(world, corp, office, stock, now());
      const selected = config.allItems ? stock : stock.filter(row => config.items.some(item => item.typeID === row.typeID));
      if (!selected.length) {
        waitingSince.delete(key);
        if (config.allItems) store.reviewSource(world, characterID, op, stock, []);
        show("Idle", config.allItems ? "The source division is empty." : "Waiting for selected stock at the source.");
        return false;
      }

      const [holds, volumes] = await Promise.all([io.bays(shipID, freightBays(selected)), io.volumes(selected)]);
      running(op);
      const excluded = store.unresolvedSourceItems(world, op);
      const arrived = store.operation(world, op.id)?.execution?.delivered ?? {};
      const destination = config.mode === "SUPPLY" ? store.stock(world, corp, config.destination)!.quantities : arrived;
      const wanted = needs(config, selected.filter(row => !excluded.has(row.itemID)), destination, store.coverage(world, op));
      if (!wanted.length) {
        waitingSince.delete(key);
        if (config.allItems) store.reviewSource(world, characterID, op, stock, []);
        show("Idle", "No freight is due for pickup.");
        return false;
      }
      const alternatives = config.allItems ? store.peerSpecializedBays(world, characterID, op) : [];
      const { lines, fill, blocked } = loadFor(wanted, holds.volumes, volumes, holds.unreadable, alternatives);
      const issues = new Map<number, FreightBlock>(blocked.map(row => [row.itemID, row]));
      const unshipped = config.allItems ? store.reviewSource(world, characterID, op, stock, blocked, holds.volumes) : [];
      if (!lines.length) {
        if (!config.allItems) throw Error("The available freight does not fit in a readable, compatible hold.");
        waitingSince.delete(key);
        if (unshipped.length) show("Attention", unshipped[0]!.reason);
        else show("Idle", "No freight fits this hauler's available holds right now.");
        return false;
      }
      const clock = now(), since = waitingSince.get(key) ?? clock;
      waitingSince.set(key, since);
      if (fill + 1e-7 < minimumFill(config, since, clock)) {
        retryAt.set(key, Math.min(clock + 10_000, since + config.waitMinutes * 60_000));
        show("Idle", "Waiting for a fuller load or the configured departure time.");
        return false;
      }

      store.plan(world, characterID, op.id, lines);
      const refusedBays = new Map<number, Set<string>>();
      try {
        for (const [index, line] of lines.entries()) {
          running(op);
          if (refusedBays.get(line.itemID)?.has(line.bay)) {
            store.plan(world, characterID, op.id, lines.slice(index + 1));
            continue;
          }
          const source = stock.find(row => row.itemID === line.itemID && row.typeID === line.typeID);
          if (!source || source.quantity < line.quantity) break;
          const pending: Pending = { leg: "pickup", line, proof: proofBefore(source, stock, bayRows(holds, line.bay)) };
          if (!store.begin(world, characterID, shipID, op, pending)) throw new StoppedPickup();
          store.plan(world, characterID, op.id, lines.slice(index + 1));
          const result = await io.move({ leg: "pickup", office, line, source, shipID, corporationID: corp });
          if (result.kind === "refused") {
            store.settle(world, characterID, null);
            if (config.allItems && result.unchanged) {
              const refused = refusedBays.get(line.itemID) ?? new Set<string>();
              refused.add(line.bay);
              refusedBays.set(line.itemID, refused);
              // Reuse the load planner for any compatible space left after the
              // other planned stacks. Each bay is tried at most once per stack.
              const later = lines.slice(index + 1);
              const spare = holds.volumes.filter(bay => !refused.has(bay.key)).map(bay => ({
                ...bay,
                used: bay.used + later.filter(row => row.bay === bay.key)
                  .reduce((volume, row) => volume + row.quantity * (row.unitVolumeM3 ?? 0), 0),
              }));
              lines.push(...loadFor([{ stock: source, available: line.quantity }], spare, volumes).lines);
              store.plan(world, characterID, op.id, lines.slice(index + 1));
              continue;
            }
            // Deliver any freight we already loaded on this trip.
            if (store.trip(world, characterID)?.cargo.length) break;
            throw Error("Pickup was refused. " + result.reason);
          }
          let quantity: number;
          if (result.kind === "confirmed") {
            store.confirmPickup(world, characterID, result.quantity);
            const cargo = bayRows(await io.bays(shipID, [line.bay]), line.bay);
            const observed = addedToBay(pending.proof, cargo, line, result.quantity);
            if (!observed) throw Error("Pickup succeeded, but the new stack in the ship's hold could not be identified.");
            store.settle(world, characterID, observed);
            holds.rows[line.bay] = cargo;
            stock = subtract(stock, source.itemID, observed.quantity);
            quantity = observed.quantity;
          } else {
            const observed = await reconcile(op, shipID, corp, pending).catch(error => {
              throw Error(result.reason + " " + reason(error));
            });
            holds.rows[line.bay] = observed.cargo;
            stock = observed.stock;
            quantity = observed.quantity;
          }
          holds.volumes.find(bay => bay.key === line.bay)!.used += quantity * (line.unitVolumeM3 ?? 0);
          if (quantity !== line.quantity) break;
        }
      } finally {
        store.plan(world, characterID, op.id, []);
      }
      if (config.allItems) {
        for (const row of stock) {
          const refused = refusedBays.get(row.itemID), m3 = freightVolume(row, volumes);
          if (!refused || m3 == null) continue;
          const keys = candidateBays(row);
          // A refusal is specific to one hold. A full or unreadable alternative
          // may still take this stack on a later pickup.
          if (keys.some(key => holds.unreadable.includes(key)) ||
              holds.volumes.some(bay => keys.includes(bay.key) && !refused.has(bay.key) && canFitUnit(bay.capacity, m3))) continue;
          issues.set(row.itemID, { ...row, kind: "refused", reason: "The game refused pickup without moving this stack." });
        }
        // Verify the remaining stock while the last hauler is still at A.
        // A failed read does not prevent delivery of the confirmed cargo.
        const onlyUnfit = stock.every(row => {
          const kind = issues.get(row.itemID)?.kind;
          return kind === "oversized" || kind === "volume" || kind === "unsupported";
        });
        const observed = config.mode === "MANUAL" && onlyUnfit && store.isRunning(world, op)
          ? await io.local(office, corp, shipID, false).catch(() => null) : stock;
        const unshipped = observed ? store.reviewSource(world, characterID, op, observed, [...issues.values()]) : [];
        if (unshipped.length && !store.trip(world, characterID)?.cargo.length)
          show("Attention", "Items left in the source division need a different hold or cannot be loaded.");
      }
      waitingSince.delete(key);
      return true;
    });
    if (loaded === undefined) show("Idle", "Another hauler is using the source division.");
  }

  async function deliver(op: Operation, trip: Trip, corp: number) {
    const office = op.config.destination, shipID = trip.shipID;
    show("To destination", "Delivering freight to " + dockName(office) + ".");
    await travel(office, shipID, current);
    const unloaded = await inDivision(corp, office, async () => {
      show("Unloading", "Checking the destination division.");
      const [target, holds] = await Promise.all([
        io.local(office, corp, shipID, false), io.bays(shipID, [...new Set(trip.cargo.map(row => row.bay))]),
      ]);
      const received = counts(target);
      store.observeStock(world, corp, office, target, now());
      let refusedFreight = false;
      for (const line of trip.cargo) {
        current();
        const cargo = bayRows(holds, line.bay), source = cargo.find(row => row.itemID === line.itemID && row.typeID === line.typeID);
        if (!source || source.quantity < line.quantity) throw Error("The loaded freight is missing from the assigned hold.");
        const pending: Pending = { leg: "delivery", line, proof: { ...proofBefore(source, cargo, []), targetTotal: received[line.typeID] ?? 0 } };
        if (!store.begin(world, characterID, shipID, op, pending)) throw Error("The active delivery changed.");
        const result = await io.move({ leg: "delivery", office, line, source, shipID, corporationID: corp });
        if (result.kind === "refused") {
          store.settle(world, characterID, null);
          if (op.config.allItems && result.unchanged) {
            refusedFreight = true;
            continue;
          }
          throw Error("Unloading was refused. " + result.reason);
        }
        if (result.kind === "confirmed" && (!line.singleton || result.keptID)) {
          store.settle(world, characterID, { itemID: line.itemID, quantity: result.quantity });
          holds.rows[line.bay] = subtract(cargo, source.itemID, result.quantity);
          received[line.typeID] = (received[line.typeID] ?? 0) + result.quantity;
          if (result.quantity !== line.quantity) break;
        } else {
          await reconcile(op, shipID, corp, pending);
          // The pending transfer was resolved from fresh stock. Continue with that inventory on the next pass.
          break;
        }
      }
      if (refusedFreight) throw Error("The destination refused some items. The remaining freight is still on board.");
      return true;
    });
    if (unloaded === undefined) show("To destination", "Another hauler is using the destination division.");
    else if (!store.trip(world, characterID)) {
      operationID = null;
      show("Idle", "Delivery confirmed. Ready for another trip.");
    }
  }

  async function step() {
    try {
      const saved = store.trip(world, characterID);
      if (saved && now() < retryTripAt) return;
      const ops = store.running(world);
      // Idle workers keep basic ship information current without reading the inventory.
      if (saved || ops.length || !lastFlight || now() >= flightAt) {
        lastFlight = await io.flight();
        flightAt = now() + 15_000;
      }
      const { shipID, corporationID } = lastFlight;
      const eligible = ops.filter(op => op.config.corporationID === corporationID);
      const keys = new Set(eligible.map(op => op.execution!.id));
      for (const key of retryAt.keys()) if (!keys.has(key)) retryAt.delete(key);
      for (const key of waitingSince.keys()) if (!keys.has(key)) waitingSince.delete(key);
      const start = eligible.findIndex(op => op.id === lastOperation) + 1;
      const candidate = [...eligible.slice(start), ...eligible.slice(0, start)]
        .find(op => now() >= (retryAt.get(op.execution!.id) ?? 0));
      const op = saved ? store.operation(world, saved.operationID) : candidate;
      if (!op) {
        if (saved) throw Error("The operation for the freight on board is unavailable.");
        if (!eligible.length || !attention && !operationID) { operationID = null; show("Idle"); }
        return;
      }
      operationID = op.id;
      if (op.config.corporationID !== corporationID || saved && saved.shipID !== shipID)
        throw Error("The original ship and corporation are required to finish the freight on board.");

      if (saved?.pending) {
        const pending = saved.pending, office = pending.leg === "pickup" ? op.config.source : op.config.destination;
        if (lastFlight.locationID !== office.destinationID)
          throw Error("The previous transfer can only be checked at " + dockName(office) + ".");
        if (!await inDivision(corporationID, office, () => reconcile(op, shipID, corporationID, pending))) return;
      } else if (!saved) {
        lastOperation = op.id;
        try {
          await pickup(op, shipID, corporationID).catch(error => { if (!(error instanceof StoppedPickup)) throw error; });
        } finally {
          const key = op.execution!.id;
          if (!store.trip(world, characterID) && (retryAt.get(key) ?? 0) <= now()) retryAt.set(key, now() + 20_000);
        }
      }
      const loaded = store.trip(world, characterID);
      if (loaded?.cargo.length && !loaded.pending) await deliver(op, loaded, corporationID);
      else if (!loaded && (saved?.pending || !store.isRunning(world, op))) { operationID = null; show("Idle"); }
    } catch (error) {
      const detail = reason(error);
      store.reportIssue(world, characterID, detail);
      if (store.trip(world, characterID)) retryTripAt = now() + 15_000;
      show("Attention", detail);
    }
  }

  return { step };
}

function observedDelivery(pending: Pending, cargo: readonly Stack[], stock: readonly Stack[]) {
  const { line, proof } = pending;
  const source = cargo.find(row => row.itemID === line.itemID);
  const amount = proof.sourceStack - (source?.quantity ?? 0);
  const previous = proof.targetTotal ?? counts(proof.targetRows)[line.typeID] ?? 0;
  if (!positive(amount) || amount > line.quantity || source && source.typeID !== line.typeID ||
      (counts(cargo)[line.typeID] ?? 0) !== proof.sourceTotal - amount ||
      (counts(stock)[line.typeID] ?? 0) !== previous + amount ||
      line.singleton && !stock.some(row => row.itemID === line.itemID && row.typeID === line.typeID)) return null;
  return { itemID: line.itemID, quantity: amount };
}

export function createDistributionDriver(store: DistributionStore): BackendRun {
  return {
    check(value) {
      const setup = value as { characterID?: unknown; workspace?: unknown } | null;
      if (!positive(setup?.characterID))
        return { ok: false, refusal: "Choose a registered WC pilot for the transport fleet." };
      const workspace = typeof setup.workspace === "string" ? setup.workspace.toLowerCase() : undefined;
      return { ok: true, setup: { characterID: setup.characterID, ...(workspace ? { workspace } : {}) },
        name: "Distribution carrier", policy: { riskClasses: ["inventory"], restartSafe: true } };
    },
    async start(run: PluginRunContext) {
      const setup = run.setup as { characterID: number };
      const { worldID, owner, characterID } = await heldServiceScope(run);
      if (setup.characterID !== characterID ||
          !store.roster(worldID).some(row => row.characterID === characterID && row.account === owner))
        throw Error("The held pilot is not registered in this transport fleet.");
      store.attach(worldID, characterID, run.botID);
      let session;
      try { session = await createPilotSession(run); }
      catch (error) { store.release(worldID, characterID, run.botID); throw error; }

      let stopped = false, wake: (() => void) | undefined;
      const current = () => {
        if (stopped || session.store.station.get().online?.characterID !== characterID || session.flow.flying.isSessionClosing())
          throw Error("Bot Host no longer holds this hauler.");
      };
      const modules = createHaulerModules(session, characterID);
      const worker = createDistributionWorker({ store, world: worldID, characterID, current,
        io: createDistributionNative(run, session, current),
        report: (phase, detail) => run.report({ status: "running", phase, why: detail }),
        travel: async (office, shipID, guard) => {
          let travelling = true;
          try {
            await parkWithPolicy(run, session, () => {}, guard,
              { mode: "selected", kind: office.kind, destinationID: office.destinationID, systemID: office.systemID }, {
                expectedShipID: shipID,
                observeTravel: grid => modules(grid, closingToDockOrGate(grid), () => {
                  current();
                  guard();
                  if (!travelling) throw Error("The hauling leg has ended.");
                }),
              });
          } finally { travelling = false; }
        },
      });
      const work = (async () => {
        while (!stopped) {
          await worker.step();
          if (stopped) break;
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 3_000);
            wake = () => { clearTimeout(timer); resolve(); };
          });
          wake = undefined;
        }
      })().finally(() => {
        store.release(worldID, characterID, run.botID);
        session.flow.setLivePush(false);
        session.flow.flying.abortAutopilot();
      });
      return { async stop() { stopped = true; wake?.(); await work; } };
    },
  };
}
