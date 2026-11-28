import type { FleetDelivery } from "./delivery.ts";
import { decodeFlightStatus, getFlightStatus } from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readNativeShipHolds } from "./nativeInventory.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { readMiningReadiness } from "./nativeBelt.ts";
import { parkWithPolicy } from "../shared/parking.ts";
import { progressDeadline, travelFacts } from "../shared/progressDeadline.ts";
import {
  depositOwnShipRaw,
  type OwnShipRawSource,
  type RawDepositReceipt,
} from "./dockedRawDeposit.ts";
import type { SynchronousStore } from "./targetBoard.ts";
import { fleetReadFailed, FleetObservationUnavailable } from "./stopSignal.ts";
const valid = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type RawItem = { itemID: number; typeID: number; quantity: number; unitVolumeM3?: number };
type Trip = {
  ordinal: number;
  items: RawItem[];
  movement: {
    destinationID: number;
    routeIssuedAt: number | null;
    dockIssuedAt: number | null;
    arrivedAt: number | null;
  };
};
export type SelfUnloadTotals = {
  trips: number;
  unitsByType: Record<string, number>;
  volumeM3: number | null;
};
type State = {
  version: 1;
  identity: string;
  nextOrdinal: number;
  pending: Trip | null;
  totals: SelfUnloadTotals;
};
type LegacyState = Omit<State, "totals"> & {
  receipts: { ordinal: number; receipt: RawDepositReceipt }[];
};
const validItems = (v: unknown): v is RawItem[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x) =>
      x &&
      valid(x.itemID) &&
      valid(x.typeID) &&
      valid(x.quantity) &&
      (x.unitVolumeM3 === undefined || (Number.isFinite(x.unitVolumeM3) && x.unitVolumeM3 > 0)),
  ) &&
  new Set(v.map((x) => x.itemID)).size === v.length;
const emptyTotals = (): SelfUnloadTotals => ({ trips: 0, unitsByType: {}, volumeM3: 0 });
function addTrip(totals: SelfUnloadTotals, items: readonly RawItem[]): SelfUnloadTotals {
  const unitsByType = { ...totals.unitsByType };
  let volumeM3 = totals.volumeM3;
  for (const item of items) {
    unitsByType[item.typeID] = (unitsByType[item.typeID] ?? 0) + item.quantity;
    volumeM3 =
      volumeM3 === null || item.unitVolumeM3 === undefined
        ? null
        : volumeM3 + item.quantity * item.unitVolumeM3;
  }
  return { trips: totals.trips + 1, unitsByType, volumeM3 };
}
export function readSelfUnloadTotals(
  raw: unknown,
  identity: string,
  sourceKind?: OwnShipRawSource["kind"],
): SelfUnloadTotals {
  const state = raw as State | LegacyState;
  if (
    !state ||
    state.version !== 1 ||
    state.identity !== identity ||
    !valid(state.nextOrdinal) ||
    !(
      state.pending === null ||
      (state.pending?.ordinal === state.nextOrdinal - 1 && valid(state.pending.ordinal))
    )
  )
    throw Error("Self-unload trip evidence requires reconciliation.");
  const count = state.nextOrdinal - 1 - (state.pending ? 1 : 0);
  if ("totals" in state) {
    const t = state.totals;
    if (
      !t ||
      t.trips !== count ||
      !t.unitsByType ||
      typeof t.unitsByType !== "object" ||
      Array.isArray(t.unitsByType) ||
      Object.entries(t.unitsByType).some(
        ([type, quantity]) => !valid(Number(type)) || !valid(quantity),
      ) ||
      !(t.volumeM3 === null || (Number.isFinite(t.volumeM3) && t.volumeM3 >= 0))
    )
      throw Error("Self-unload totals require reconciliation.");
    return t;
  }
  if (!Array.isArray(state.receipts) || state.receipts.length !== count)
    throw Error("Self-unload trip evidence requires reconciliation.");
  const ordinals = new Set<number>();
  let totals = emptyTotals();
  for (const entry of state.receipts) {
    const receipt = entry?.receipt,
      source = receipt?.source;
    if (
      !source ||
      !valid(entry.ordinal) ||
      entry.ordinal > count ||
      ordinals.has(entry.ordinal) ||
      (sourceKind
        ? source.kind !== sourceKind
        : source.kind !== "own-ship-raw" && source.kind !== "own-ship-freight") ||
      JSON.stringify([source.operationID, source.runID, source.characterID, source.shipID]) !==
        identity ||
      !validItems(source.items) ||
      !Number.isFinite(receipt.completedAt) ||
      !Array.isArray(receipt.batches)
    )
      throw Error("Self-unload trip evidence requires reconciliation.");
    ordinals.add(entry.ordinal);
    totals = addTrip(totals, source.items);
  }
  return totals;
}
export function createSelfUnload(config: {
  operationID: string;
  runID: string;
  characterID: number;
  shipID: number;
  destinationID: number;
  current: () => void;
  store: SynchronousStore;
  sourceKind?: "own-ship-raw" | "own-ship-freight";
  readRaw: () => Promise<RawItem[]>;
  settle: () => Promise<void>;
  travel: (
    movement: Trip["movement"],
    beforeRoute: () => void,
    beforeDock: () => void,
    refusedRoute: () => void,
  ) => Promise<void>;
  deposit: (source: OwnShipRawSource, ordinal: number) => Promise<RawDepositReceipt>;
}) {
  const { operationID, runID, characterID, shipID, destinationID, current, store } = config;
  if (!operationID || !runID || !valid(characterID) || !valid(shipID) || !valid(destinationID))
    throw Error("Self-unload identity is invalid.");
  const identity = JSON.stringify([operationID, runID, characterID, shipID]),
    saved = store.read() as State | LegacyState | null;
  let state: State = { version: 1, identity, nextOrdinal: 1, pending: null, totals: emptyTotals() };
  if (saved !== null) {
    const totals = readSelfUnloadTotals(saved, identity, config.sourceKind ?? "own-ship-raw");
    const { pending } = saved;
    if (
      pending &&
      (!validItems(pending.items) ||
        pending.movement?.destinationID !== destinationID ||
        ![
          pending.movement.routeIssuedAt,
          pending.movement.dockIssuedAt,
          pending.movement.arrivedAt,
        ].every((t) => t === null || valid(t)) ||
        (pending.movement.dockIssuedAt && !pending.movement.routeIssuedAt))
    )
      throw Error("Self-unload trip requires reconciliation.");
    state = { version: 1, identity, nextOrdinal: saved.nextOrdinal, pending, totals };
    if ("receipts" in saved) {
      current();
      store.write(state);
    }
  }
  const save = (next: State) => {
    current();
    store.write(next);
    state = next;
  };
  let activeTrip: Promise<{
    deposited: boolean;
    rawRemaining: RawItem[];
    observedAt: number;
  }> | null = null;
  async function performTrip() {
    current();
    await config.settle();
    current();
    let pending = state!.pending;
    if (!pending) {
      const items = await config.readRaw();
      current();
      if (!items.length)
        return { deposited: false, rawRemaining: [] as RawItem[], observedAt: Date.now() };
      if (!validItems(items)) throw Error("Self-unload raw stack identity is invalid.");
      pending = {
        ordinal: state!.nextOrdinal,
        items: structuredClone(items),
        movement: { destinationID, routeIssuedAt: null, dockIssuedAt: null, arrivedAt: null },
      };
      save({ ...state!, nextOrdinal: pending.ordinal + 1, pending });
    }
    const mark = (field: "routeIssuedAt" | "dockIssuedAt") => {
      current();
      const p = state!.pending;
      if (!p || p.ordinal !== pending!.ordinal || p.movement[field] !== null)
        throw Error("Self-unload movement intent is unresolved; no replay.");
      save({ ...state!, pending: { ...p, movement: { ...p.movement, [field]: Date.now() } } });
    };
    const refusedRoute = () => {
      current();
      const p = state!.pending;
      if (
        !p ||
        p.ordinal !== pending!.ordinal ||
        p.movement.routeIssuedAt === null ||
        p.movement.dockIssuedAt !== null
      )
        throw Error("Self-unload route intent changed.");
      save({ ...state!, pending: { ...p, movement: { ...p.movement, routeIssuedAt: null } } });
    };
    await config.travel(
      state!.pending!.movement,
      () => mark("routeIssuedAt"),
      () => mark("dockIssuedAt"),
      refusedRoute,
    );
    current();
    if (!state!.pending!.movement.arrivedAt) {
      const p = state!.pending!;
      save({ ...state!, pending: { ...p, movement: { ...p.movement, arrivedAt: Date.now() } } });
    }
    const source: OwnShipRawSource = {
      kind: config.sourceKind ?? "own-ship-raw",
      operationID,
      runID,
      characterID,
      shipID,
      items: pending.items.map(({ itemID, typeID, quantity }) => ({ itemID, typeID, quantity })),
    };
    const receipt = await config.deposit(source, pending.ordinal);
    current();
    if (JSON.stringify(receipt.source) !== JSON.stringify(source))
      throw Error("Self-unload deposit identity changed.");
    const remaining = await config.readRaw();
    current();
    if (remaining.length)
      throw Error("Self-unload raw hold is not empty; reconciliation is required.");
    save({ ...state, pending: null, totals: addTrip(state.totals, pending.items) });
    return { deposited: true, rawRemaining: remaining, observedAt: Date.now() };
  }
  function trip() {
    if (activeTrip) return activeTrip;
    const task = performTrip();
    activeTrip = task;
    void task
      .finally(() => {
        if (activeTrip === task) activeTrip = null;
      })
      .catch(() => {});
    return task;
  }
  return { trip, snapshot: () => structuredClone(state) };
}
/** Compose the existing native hold reader, guarded route and shared exact corporation deposit. */
export function createNativeSelfUnload(
  run: PluginRunContext,
  session: PilotSession,
  config: {
    operationID: string;
    runID: string;
    shipID: number;
    resourceFamily?: "ore" | "ice";
    allowCompressed?: boolean;
    destinationID: number;
    corporationID?: number;
    division?: number;
    delivery?: FleetDelivery;
    current: () => void;
    settle: () => Promise<void>;
    store: SynchronousStore;
    tripDocument: (ordinal: number) => SynchronousStore;
  },
) {
  const { current, shipID } = config,
    resourceFamily = config.resourceFamily ?? "ore",
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch },
    f = session.flow.flying;
  const guard = () => {
    current();
    const online = session.store.station.get().online;
    if (
      online?.characterID !== run.characterID ||
      (config.delivery?.corporationID !== null && online.corporationID !== config.corporationID)
    )
      throw Error("Self-unload pilot or corporation changed.");
  };
  const flightScope = async () => {
    guard();
    const raw = (await getFlightStatus(options).catch(fleetReadFailed)).flight as any,
      s = decodeFlightStatus(raw);
    guard();
    if (
      s.shipID !== shipID ||
      !valid(s.solarSystemID) ||
      (!s.inSpace && !s.docked) ||
      (s.inSpace && s.docked) ||
      !raw?.transition ||
      typeof raw.transition !== "object" ||
      Array.isArray(raw.transition) ||
      !["requested", "accepted", "session-changing", "ready", "failed"].includes(
        raw.transition.phase,
      )
    )
      throw Error("Self-unload flight identity or transition is uncertain.");
    return s;
  };
  const readRaw = async () => {
    const before = await flightScope(),
      rows = await readNativeShipHolds(session, guard, run.characterID, shipID),
      facts = await createRawTypeFacts(run, guard)([...new Set(rows.map((r) => r.typeID))]);
    guard();
    const after = await flightScope();
    if (
      before.inSpace !== after.inSpace ||
      before.docked !== after.docked ||
      before.solarSystemID !== after.solarSystemID ||
      before.stationID !== after.stationID ||
      before.structureID !== after.structureID
    )
      throw Error("Self-unload inventory scope changed.");
    return rows.flatMap((r) => {
      const fact = facts[r.typeID];
      if (
        !fact ||
        !valid(fact.categoryID) ||
        (r.categoryID !== null && r.categoryID !== fact.categoryID)
      )
        throw Error("Held item type is uncertain.");
      if (fact.categoryID !== 25) return [];
      if (
        !(
          fact.freightKind === "RAW" ||
          (config.allowCompressed && fact.freightKind === "COMPRESSED")
        ) ||
        fact.resourceFamily !== resourceFamily ||
        !Number.isFinite(fact.unitVolumeM3) ||
        fact.unitVolumeM3 <= 0 ||
        !(
          r.flagID === 5 ||
          r.flagID === 134 ||
          (r.flagID === 181 && resourceFamily === "ice") ||
          (r.flagID === 182 && resourceFamily === "ore")
        )
      )
        throw Error("Only verified raw resources in a compatible hold can self-unload.");
      return [
        {
          itemID: r.itemID,
          typeID: r.typeID,
          quantity: r.quantity,
          unitVolumeM3: fact.unitVolumeM3,
        },
      ];
    });
  };
  let ownedRoute = false;
  const travel = async (
    movement: Trip["movement"],
    beforeRoute: () => void,
    beforeDock: () => void,
    refusedRoute: () => void,
  ) => {
    guard();
    let status = await flightScope();
    const transitionReady = () =>
      !!status.transition &&
      status.transition.phase === "ready" &&
      status.transition.sessionStable &&
      status.transition.locationReady &&
      status.transition.sceneReady &&
      status.transition.egoReady &&
      status.transition.shipReady &&
      status.transition.boundContextReady;
    const atDestination = () =>
      status.docked &&
      (status.stationID ?? status.structureID) === config.destinationID &&
      transitionReady();
    if (atDestination()) {
      ownedRoute = false;
      return;
    }
    if (movement.destinationID !== config.destinationID)
      throw Error("Self-unload destination changed.");
    if (movement.routeIssuedAt === null) {
      if (status.inSpace) {
        const ready = await readMiningReadiness(run, session, shipID, status.solarSystemID!, guard);
        if (!ready.ready)
          throw new FleetObservationUnavailable(
            "Self-unload movement cannot start while warp or transition is unresolved.",
          );
      } else if (!transitionReady())
        throw new FleetObservationUnavailable("Self-unload docked transition is uncertain.");
      beforeRoute();
      guard();
      const route = await session.flow.startRoute(config.destinationID);
      guard();
      if (!route.started) {
        refusedRoute();
        fleetReadFailed(
          new Error(`Self-unload route refused: ${route.reason}`, { cause: route.cause }),
        );
      }
      ownedRoute = true;
    } else if (!ownedRoute) {
      const delivery = config.delivery;
      if (!run.resumed || !delivery)
        throw Error("Self-unload movement outcome is unknown; no route replay.");
      await parkWithPolicy(
        run,
        session,
        () => {},
        guard,
        {
          mode: "selected",
          kind: delivery.kind,
          destinationID: delivery.destinationID,
          systemID: delivery.systemID,
        },
        {
          expectedShipID: shipID,
          observeDockOnly: movement.dockIssuedAt !== null,
          beforeDock: beforeDock,
        },
      );
      return;
    }
    const progressing = progressDeadline(180000);
    let dockIssued = movement.dockIssuedAt !== null,
      lastPosition: unknown;
    while (true) {
      guard();
      status = await flightScope();
      if (atDestination()) {
        ownedRoute = false;
        return;
      }
      const p = f.autopilotProgress();
      if (!p || ["error", "paused", "aborted"].includes(p.status))
        throw Error("Self-unload movement outcome is unknown; no route replay.");
      const scene = status.inSpace ? session.store.space?.get().snapshot : null;
      if (
        scene?.inSpace &&
        scene.stateValid !== false &&
        scene.solarSystemID === status.solarSystemID &&
        scene.ship?.itemID === shipID &&
        scene.ship.geometryAvailable
      )
        lastPosition = scene.ship.position;
      if (!progressing(travelFacts(status, p, lastPosition)))
        throw Error("Self-unload movement made no observable progress; no route replay.");
      if (p.status === "arrived" && !dockIssued) {
        beforeDock();
        dockIssued = true;
        guard();
        await f.dockStep(config.destinationID);
        guard();
      }
      await wait(1000);
    }
  };
  return createSelfUnload({
    ...(config.allowCompressed ? { sourceKind: "own-ship-freight" as const } : {}),
    operationID: config.operationID,
    runID: config.runID,
    characterID: run.characterID,
    shipID,
    destinationID: config.destinationID,
    current: guard,
    store: config.store,
    settle: config.settle,
    readRaw,
    travel,
    deposit: (source, ordinal) =>
      depositOwnShipRaw(run, session, {
        source,
        ...(config.allowCompressed ? { freightKind: "ANY" as const } : {}),
        destinationID: config.destinationID,
        ...(config.corporationID === undefined ? {} : { corporationID: config.corporationID }),
        ...(config.division === undefined ? {} : { division: config.division }),
        ...(config.delivery ? { delivery: config.delivery } : {}),
        current: guard,
        document: config.tripDocument(ordinal),
      }),
  });
}
