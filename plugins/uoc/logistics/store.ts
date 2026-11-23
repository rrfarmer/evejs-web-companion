import { randomUUID } from "node:crypto";
import type { BackendRequest, BackendRoute } from "../../../web/src/plugin-api/backend.ts";
import { worldForRequest } from "../shared/backendScope.ts";
import { active, counts, positive, readCarrier, readConfig, sameOffice,
  type Bay, type Carrier, type Execution, type Freight, type FreightBlock, type Load, type Office, type Operation, type Stack, type Stock,
  type Unshipped } from "./model.ts";

export type Document = { read(): unknown; write(v: unknown): void };
export type Leg = "pickup" | "delivery";
export type TransferProof = { sourceID: number; sourceStack: number; sourceTotal: number; targetRows: Stack[]; targetTotal?: number };
export type Pending = { leg: Leg; line: Load; proof: TransferProof; quantity?: number };
export type Trip = {
  operationID: string; executionID: string; characterID: number; shipID: number;
  cargo: Load[]; pending: Pending | null; issue: string | null; delivered: boolean;
};
export type Phase = "Idle" | "Checking destination" | "To source" | "Loading" | "To destination" | "Unloading" | "Attention";
export type Snapshot = { shipTypeID: number | null; corporationID: number | null; operationID: string | null; phase: Phase; detail: string | null };
export type FleetRow = Carrier & {
  hosted: Snapshot | null;
  trip: { operationID: string; cargo: Freight[]; checking: Freight | null; issue: string | null } | null;
};
export type DistributionView = { ok: true; roster: FleetRow[]; operations: Operation[] };

type State = { roster: Carrier[]; operations: Operation[]; trips: Trip[] };
type SourceCheck = {
  runID: string;
  specialized: readonly Bay[];
  failed: ReadonlyMap<number, { stock: Stock; kind: "oversized" | "refused" }>;
};
type Driver = {
  botID: string; shipID: number | null; snapshot: Snapshot;
  inventory?: { corporationID: number; office: Office };
  pickup?: { operationID: string; lines: readonly Load[] };
  sourceCheck?: SourceCheck;
};
type StockObservation = { at: number; quantities: Record<number, number> };
type World = { state: State; drivers: Map<number, Driver>; stock: Map<string, StockObservation> };
const waiting: Snapshot = { shipTypeID: null, corporationID: null, operationID: null, phase: "Idle", detail: null };
const at = (corporationID: number, office: Office) => JSON.stringify([corporationID, office.destinationID, office.division]);

/** Import current work once. The previous document remains in SQLite, including its historical records. */
function importPrevious(raw: unknown): State {
  const state: State = { roster: [], operations: [], trips: [] };
  if (raw === null || raw === undefined) return state;
  type PreviousOperation = Omit<Operation, "config" | "execution"> & {
    config: Omit<Operation["config"], "source"> & { sources: Office[] };
    execution: Omit<Execution, "trips"> | null;
  };
  type PreviousClaim = {
    operationID: string; executionID: string; source: Office; carrier: Carrier; shipID: number;
    endedAt: number | null; issue: string | null;
    lines: (Load & { state: string; cargoID?: number })[];
    pending: { index: number; stage: Leg; proof: Omit<TransferProof, "targetRows"> & { targetRows: Omit<Stack, "typeID">[] } } | null;
  };
  const previous = raw as { roster: Record<string, Carrier[]>; operations: PreviousOperation[]; claims: PreviousClaim[] };
  state.roster = [...new Map(Object.values(previous.roster).flat().map(row => [row.characterID, readCarrier(row)])).values()];

  for (const old of previous.operations) {
    const { sources, ...config } = old.config;
    for (const [index, source] of sources.entries()) {
      const id = index ? old.id + "-source-" + (index + 1) : old.id;
      const claims = previous.claims.filter(row =>
        row.operationID === old.id && row.executionID === old.execution?.id && sameOffice(row.source, source));
      const execution = old.execution && { id: old.execution.id, state: old.execution.state,
        delivered: index ? {} : old.execution.delivered,
        trips: claims.filter(row => row.endedAt !== null && row.lines.some(line => line.state === "DELIVERED")).length };
      const name = index ? config.name + " · source " + (index + 1) : config.name;
      const operation = { id, config: readConfig({ ...config, source, name }), execution };
      state.operations.push(operation);
      if (!execution) continue;

      for (const claim of claims.filter(row => row.endedAt === null)) {
        const cargo = claim.lines.flatMap(line => line.state === "LOADED" && positive(line.cargoID)
          ? [{ itemID: line.cargoID, typeID: line.typeID, quantity: line.quantity, bay: line.bay, singleton: line.singleton }] : []);
        const oldPending = claim.pending, line = oldPending && claim.lines[oldPending.index];
        const pending = oldPending && line ? {
          leg: oldPending.stage,
          line: { itemID: oldPending.proof.sourceID, typeID: line.typeID, quantity: line.quantity, bay: line.bay, singleton: line.singleton },
          proof: { ...oldPending.proof, targetRows: oldPending.proof.targetRows.map(row => ({ ...row, typeID: line.typeID })) },
        } : null;
        if (!cargo.length && !pending) continue;
        state.trips.push({ operationID: id, executionID: execution.id, characterID: claim.carrier.characterID,
          shipID: claim.shipID, cargo, pending, issue: claim.issue,
          delivered: claim.lines.some(line => line.state === "DELIVERED") });
      }

      // A multi-source run is now a set of independent saved routes. Finish cargo already on board.
      if (active(operation) && sources.length > 1) execution.state = "STOPPING";
      finish(state, operation);
    }
  }
  return state;
}

function finish(state: State, operation: Operation) {
  const run = operation.execution;
  if (!run || state.trips.some(trip => trip.operationID === operation.id)) return;
  if (run.state === "STOPPING") run.state = "STOPPED";
  else if (run.state === "RUNNING" && operation.config.mode === "MANUAL") {
    if (operation.config.allItems) {
      if (run.sourceFinished) run.state = run.unshipped?.length ? "INCOMPLETE" : "COMPLETED";
    } else if (operation.config.items.every(item => (run.delivered[item.typeID] ?? 0) >= item.quantity)) run.state = "COMPLETED";
  }
}

export function createDistributionStore(document: (world: string) => Document, previous?: (world: string) => Document) {
  const worlds = new Map<string, World>();
  function load(world: string) {
    let value = worlds.get(world);
    if (!value) {
      const state = document(world).read() as State | null;
      value = { state: state ?? importPrevious(previous?.(world).read()), drivers: new Map(), stock: new Map() };
      worlds.set(world, value);
    }
    return value;
  }
  function update<T>(world: string, change: (state: State) => T) {
    const entry = load(world), next = structuredClone(entry.state), result = change(next);
    document(world).write(next);
    entry.state = next;
    return result;
  }

  const roster = (world: string) => load(world).state.roster;
  const operation = (world: string, id: string) => load(world).state.operations.find(row => row.id === id);
  const trip = (world: string, characterID: number) => load(world).state.trips.find(row => row.characterID === characterID);
  const running = (world: string) => load(world).state.operations.filter(row => row.execution?.state === "RUNNING" && !row.execution.sourceFinished);
  const isRunning = (world: string, op: Operation) => {
    const run = operation(world, op.id)?.execution;
    return run?.state === "RUNNING" && run.id === op.execution?.id && !run.sourceFinished;
  };

  function attach(world: string, characterID: number, botID: string) {
    const drivers = load(world).drivers;
    if (drivers.has(characterID)) throw Error("This pilot already has a Distribution driver.");
    drivers.set(characterID, { botID, shipID: null, snapshot: { ...waiting } });
  }
  function release(world: string, characterID: number, botID: string) {
    const drivers = load(world).drivers;
    if (drivers.get(characterID)?.botID === botID) drivers.delete(characterID);
  }
  function publish(world: string, id: number, shipID: number | null, snapshot: Snapshot) {
    const driver = load(world).drivers.get(id)!;
    if (driver.shipID !== shipID) delete driver.sourceCheck;
    driver.shipID = shipID;
    driver.snapshot = snapshot;
  }

  function enterOffice(world: string, id: number, corporationID: number, office: Office) {
    const drivers = load(world).drivers;
    // Two transfers of the same stock can make the game's before/after totals ambiguous.
    // Only the worker currently reading and moving items at this division occupies it.
    if ([...drivers].some(([key, driver]) => key !== id && driver.inventory?.corporationID === corporationID &&
        sameOffice(driver.inventory.office, office))) return false;
    drivers.get(id)!.inventory = { corporationID, office };
    return true;
  }
  const leaveOffice = (world: string, id: number) => { delete load(world).drivers.get(id)!.inventory; };
  const plan = (world: string, id: number, operationID: string, lines: readonly Load[]) => {
    const driver = load(world).drivers.get(id)!;
    if (lines.length) driver.pickup = { operationID, lines };
    else delete driver.pickup;
  };
  function coverage(world: string, op: Operation) {
    const entry = load(world);
    const matches = (id: string) => {
      if (op.config.mode !== "SUPPLY") return id === op.id;
      const config = operation(world, id)?.config;
      return !!config && config.corporationID === op.config.corporationID && sameOffice(config.destination, op.config.destination);
    };
    const loaded = entry.state.trips.filter(row => matches(row.operationID))
      .flatMap(row => row.pending?.leg === "pickup" ? [...row.cargo, row.pending.line] : row.cargo);
    const planned = [...entry.drivers.values()].flatMap(driver =>
      driver.pickup && matches(driver.pickup.operationID) ? driver.pickup.lines : []);
    return counts([...loaded, ...planned]);
  }
  function unresolvedSourceItems(world: string, op: Operation) {
    const reserved = load(world).state.trips.flatMap(row => {
      const pending = row.pending, config = operation(world, row.operationID)?.config;
      return pending?.leg === "pickup" && config && config.corporationID === op.config.corporationID &&
        sameOffice(config.source, op.config.source) ? [pending.line.itemID] : [];
    });
    return new Set(reserved);
  }
  const observeStock = (world: string, corporationID: number, office: Office, items: readonly Freight[], observedAt: number) =>
    load(world).stock.set(at(corporationID, office), { at: observedAt, quantities: counts(items) });
  const stock = (world: string, corporationID: number, office: Office) => load(world).stock.get(at(corporationID, office));

  function eligibleCarriers(entry: World, corporationID: number | null) {
    return entry.state.roster.filter(row => {
      const corporation = entry.drivers.get(row.characterID)?.snapshot.corporationID ?? row.corporationID;
      return corporation === undefined || corporation === corporationID;
    });
  }
  function peerSpecializedBays(world: string, characterID: number, op: Operation): Bay[] {
    const entry = load(world);
    return eligibleCarriers(entry, op.config.corporationID).flatMap(row => {
      if (row.characterID === characterID) return [];
      const check = entry.drivers.get(row.characterID)?.sourceCheck;
      return check && check.runID === op.execution?.id ? check.specialized : [];
    });
  }

  function reviewSource(world: string, characterID: number, op: Operation, rows: readonly Stock[],
                        blocked: readonly FreightBlock[], bays?: readonly Bay[]): Unshipped[] {
    const current = operation(world, op.id), run = current?.execution;
    if (!current?.config.allItems || !run || run.id !== op.execution?.id || !active(current) || run.sourceFinished) return [];
    const remaining = new Map(rows.map(row => [row.itemID, row]));
    const present = new Map(blocked.filter(item => remaining.has(item.itemID)).map(item => [item.itemID, item]));
    const entry = load(world), driver = entry.drivers.get(characterID)!;
    const previous = driver.sourceCheck;
    const failed = new Map<number, { stock: Stock; kind: "oversized" | "refused" }>();
    for (const item of present.values()) {
      if (item.kind === "oversized" || item.kind === "refused")
        failed.set(item.itemID, { stock: remaining.get(item.itemID)!, kind: item.kind });
    }
    driver.sourceCheck = { runID: run.id, failed,
      specialized: bays?.filter(bay => bay.key !== "cargo") ?? (previous?.runID === run.id ? previous.specialized : []) };

    const checks = eligibleCarriers(entry, current.config.corporationID).map(row => entry.drivers.get(row.characterID)?.sourceCheck);
    const issues = new Map<string, Unshipped>();
    let unfit = 0;
    for (const item of present.values()) {
      if (item.kind === "space") continue;
      const row = remaining.get(item.itemID)!;
      let problem = item.reason, permanent = true;
      if (item.kind === "oversized" || item.kind === "refused") {
        // A small hauler's check cannot rule out a fit in another ship.
        const outcomes = checks.map(check => {
          const observation = check?.runID === run.id ? check.failed.get(row.itemID) : undefined;
          if (!observation) return null;
          const seen = observation.stock;
          if (seen.typeID !== row.typeID || seen.singleton !== row.singleton ||
              seen.groupID !== row.groupID || seen.categoryID !== row.categoryID ||
              observation.kind === "refused" && seen.quantity !== row.quantity) return null;
          return observation.kind;
        });
        if (!outcomes.length || outcomes.includes(null)) continue;
        permanent = outcomes.every(outcome => outcome === "oversized");
        problem = permanent ? "One unit does not fit in any compatible hold in the eligible fleet." :
          "The game refused this stack on the haulers that could fit it.";
      }
      if (permanent) unfit++;
      const key = item.typeID + ":" + problem, prior = issues.get(key);
      issues.set(key, { typeID: item.typeID, reason: problem, quantity: (prior?.quantity ?? 0) + row.quantity });
    }

    const finished = current.config.mode === "MANUAL" && run.state === "RUNNING" && unfit === rows.length;
    const unshipped = [...issues.values()].sort((a, b) => a.typeID - b.typeID || a.reason.localeCompare(b.reason));
    if (!finished && JSON.stringify(unshipped) === JSON.stringify(run.unshipped ?? [])) return unshipped;
    update(world, state => {
      const operation = state.operations.find(row => row.id === op.id)!;
      operation.execution!.unshipped = unshipped;
      if (finished) operation.execution!.sourceFinished = true;
      finish(state, operation);
    });
    return unshipped;
  }

  function begin(world: string, characterID: number, shipID: number, op: Operation, pending: Pending) {
    return update(world, state => {
      const current = state.operations.find(row => row.id === op.id);
      if (!current?.execution || current.execution.id !== op.execution?.id || !active(current) ||
          pending.leg === "pickup" && (current.execution.state !== "RUNNING" || current.execution.sourceFinished)) return false;
      let row = state.trips.find(item => item.characterID === characterID);
      if (!row) {
        row = { operationID: op.id, executionID: current.execution.id, characterID, shipID, cargo: [], pending: null, issue: null, delivered: false };
        state.trips.push(row);
      }
      if (row.operationID !== op.id || row.executionID !== current.execution.id || row.shipID !== shipID || row.pending)
        throw Error("The pilot has unfinished freight.");
      row.pending = pending;
      row.issue = null;
      return true;
    });
  }
  type Observation = { quantity: number; itemID: number };
  function settle(world: string, id: number, observed: Observation | null) {
    let delta: { corporationID: number; office: Office; typeID: number; quantity: number } | undefined;
    update(world, state => {
      const row = state.trips.find(item => item.characterID === id), pending = row?.pending;
      const op = state.operations.find(item => item.id === row?.operationID);
      if (!row || !op?.execution || !positive(op.config.corporationID) || op.execution.id !== row.executionID || !pending)
        throw Error("The current transfer is unavailable.");
      if (observed) {
        const { leg, line } = pending, { quantity, itemID } = observed;
        if (!positive(quantity) || quantity > line.quantity) throw Error("The observed quantity does not match this transfer.");
        if (leg === "pickup") {
          const added = row.cargo.find(item => item.itemID === itemID && item.bay === line.bay);
          if (added) added.quantity += quantity;
          else row.cargo.push({ ...line, quantity, itemID });
        } else {
          const item = row.cargo.find(item => item.itemID === line.itemID && item.bay === line.bay);
          if (!item || item.quantity < quantity) throw Error("The delivered quantity exceeds the freight on board.");
          item.quantity -= quantity;
          row.cargo = row.cargo.filter(item => item.quantity > 0);
          op.execution.delivered[line.typeID] = (op.execution.delivered[line.typeID] ?? 0) + quantity;
          if (op.execution.deliveredVolumeM3 !== undefined) {
            if (line.unitVolumeM3 === undefined) delete op.execution.deliveredVolumeM3;
            else op.execution.deliveredVolumeM3 += quantity * line.unitVolumeM3;
          }
          row.delivered = true;
        }
        delta = { corporationID: op.config.corporationID, office: leg === "pickup" ? op.config.source : op.config.destination,
          typeID: line.typeID, quantity: leg === "pickup" ? -quantity : quantity };
      }
      row.pending = null;
      row.issue = null;
      if (!row.cargo.length) {
        state.trips = state.trips.filter(item => item !== row);
        if (row.delivered) op.execution.trips++;
      }
      finish(state, op);
    });
    if (delta) {
      const previous = load(world).stock.get(at(delta.corporationID, delta.office));
      if (previous) previous.quantities[delta.typeID] = Math.max(0, (previous.quantities[delta.typeID] ?? 0) + delta.quantity);
    }
  }
  const confirmPickup = (world: string, id: number, quantity: number) => update(world, state => {
    const pending = state.trips.find(item => item.characterID === id)?.pending;
    if (pending?.leg !== "pickup") throw Error("The pickup is unavailable.");
    pending.quantity = quantity;
  });
  function reportIssue(world: string, id: number, reason: string) {
    const current = trip(world, id);
    if (current && current.issue !== reason)
      update(world, state => { state.trips.find(row => row.characterID === id)!.issue = reason; });
  }

  function view(world: string): DistributionView {
    const entry = load(world);
    return { ok: true, operations: entry.state.operations,
      roster: roster(world).map(carrier => {
        const row = trip(world, carrier.characterID);
        return { ...carrier, hosted: entry.drivers.get(carrier.characterID)?.snapshot ?? null,
          trip: row ? { operationID: row.operationID, cargo: Object.entries(counts(row.cargo))
            .map(([id, quantity]) => ({ typeID: Number(id), quantity })),
            checking: row.pending && { typeID: row.pending.line.typeID, quantity: row.pending.quantity ?? row.pending.line.quantity },
            issue: row.issue } : null };
      }) };
  }
  const route = (change: (req: BackendRequest, world: string) => void): BackendRoute => req => {
    try {
      const world = worldForRequest(req);
      if (!world || !req.account.username) throw Error("WC account or world is unavailable.");
      change(req, world);
      return { body: view(world) };
    } catch (error) {
      return { status: 409, body: { ok: false, error: "DISTRIBUTION_REFUSED", message: error instanceof Error ? error.message : String(error) } };
    }
  };

  const routes = {
    "GET /logistics": route(() => {}),
    "POST /logistics/roster": route((req, world) => {
      const carrier = readCarrier(req.body);
      update(world, state => {
        const previous = state.roster.find(row => row.characterID === carrier.characterID);
        if (previous && previous.account !== carrier.account) throw Error("The pilot is registered under a different WC account.");
        state.roster = [...state.roster.filter(row => row !== previous), carrier];
      });
    }),
    "POST /logistics/roster/remove": route((req, world) => {
      const id = (req.body as { characterID?: unknown } | null)?.characterID;
      if (!positive(id) || load(world).drivers.has(id) || trip(world, id))
        throw Error("Disconnect the hauler and finish any freight on board before removing it.");
      update(world, state => {
        state.roster = state.roster.filter(row => row.characterID !== id);
      });
    }),
    "POST /logistics/save": route((req, world) => {
      const body = req.body as { id?: string; config?: unknown } | null, config = readConfig(body?.config);
      update(world, state => {
        const existing = state.operations.find(row => row.id === body?.id);
        if (body?.id && (!existing || active(existing))) throw Error("Stop this operation before changing its route or freight.");
        if (existing) existing.config = config;
        else state.operations.push({ id: randomUUID(), config, execution: null });
      });
    }),
    "POST /logistics/:id/start": route((req, world) => update(world, state => {
      const op = state.operations.find(row => row.id === req.params.id);
      if (!op || active(op) || state.trips.some(row => row.operationID === op.id)) throw Error("This operation still has active work.");
      const fleet = state.roster;
      if (!fleet.length) throw Error("Add a hauler to Fleet first.");
      const corporations = new Set(fleet.map(row => row.corporationID).filter(positive));
      if (op.config.corporationID === null) {
        if (corporations.size !== 1) throw Error("Choose the corporation whose source and destination divisions will be used.");
        op.config.corporationID = [...corporations][0]!;
      }
      if (fleet.every(row => positive(row.corporationID) && row.corporationID !== op.config.corporationID))
        throw Error("The fleet has no hauler from this corporation.");
      op.execution = { id: randomUUID(), state: "RUNNING", delivered: {}, trips: 0, deliveredVolumeM3: 0 };
    })),
    "POST /logistics/:id/stop": route((req, world) => update(world, state => {
      const op = state.operations.find(row => row.id === req.params.id);
      const executionID = (req.body as { executionID?: unknown } | null)?.executionID;
      if (!op?.execution || op.execution.id !== executionID) throw Error("This operation has changed. Refresh its status.");
      if (op.execution.state === "RUNNING") op.execution.state = "STOPPING";
      finish(state, op);
    })),
  } satisfies Record<string, BackendRoute>;

  return { routes, view, roster, operation, trip, running, isRunning, attach, release, publish,
    enterOffice, leaveOffice, plan, coverage, unresolvedSourceItems, observeStock, stock, peerSpecializedBays, reviewSource, begin, settle, confirmPickup, reportIssue };
}

export type DistributionStore = ReturnType<typeof createDistributionStore>;
