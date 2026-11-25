import {
  decodeFlightStatus,
  getFlightStatus,
  moveItems,
  officeAt,
} from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  checkedInventory,
  corpDivisionFlag,
  readNativeShipHolds,
  type NativeInventoryRow,
} from "../shared/nativeInventory.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { decodeFleetDelivery, type FleetDelivery } from "./delivery.ts";
import type { HaulDocument } from "./haulJournal.ts";
import { bridgeCallQueueTimeout, transientNativeRead } from "../shared/progressDeadline.ts";
import { FleetObservationUnavailable, fleetReadFailed } from "./stopSignal.ts";
import { readMiningOfficeAccess, requireMiningOfficeQuery } from "./corporateOffice.ts";
type Run = Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
type DepositItem = { itemID: number; typeID: number; quantity: number };
export type OwnShipRawSource = {
  kind: "own-ship-raw" | "own-ship-freight";
  operationID: string;
  runID: string;
  characterID: number;
  shipID: number;
  items: readonly DepositItem[];
};
export type RawDepositReceipt = {
  source: OwnShipRawSource;
  destinationID: number;
  corporationID: number | null;
  division: number | null;
  officeID: number;
  delivery?: FleetDelivery;
  completedAt: number;
  batches: readonly {
    item: DepositItem;
    items?: readonly DepositItem[];
    sourceBefore: readonly NativeInventoryRow[];
    sourceAfter: readonly NativeInventoryRow[];
    destinationBefore: readonly NativeInventoryRow[];
    destinationAfter: readonly NativeInventoryRow[];
    acknowledged: boolean;
  }[];
};
type DepositConfig = {
  source: OwnShipRawSource;
  freightKind?: "RAW" | "COMPRESSED" | "ANY";
  destinationID: number;
  corporationID?: number;
  division?: number;
  delivery?: FleetDelivery;
  current: () => void;
  document: HaulDocument;
  wholeStacks?: boolean;
  reconcileParking?: boolean;
};
type Batch = RawDepositReceipt["batches"][number];
type Pending = Omit<Batch, "sourceAfter" | "destinationAfter">;
type DeliveryBefore = {
  item: Pending["item"];
  items?: readonly Pending["item"][];
  requestedIDs?: readonly number[];
  sourceBefore: readonly NativeInventoryRow[];
  destinationBefore: readonly NativeInventoryRow[];
  officeID: number;
  flag: number;
};
type Journal = {
  version: 1;
  identity: string;
  officeID: number;
  pending: Pending | null;
  batches: Batch[];
  receipt: (Omit<RawDepositReceipt, "batches"> & { batches?: RawDepositReceipt["batches"] }) | null;
};
type DepositFence = {
  begin(kind: "delivery", before: unknown): void;
  acknowledge(): void;
  refuseDelivery(): void;
  settle(after: unknown): void;
};
// Farmer indexes an NPC station hangar by containerHangar.
const STATION_HANGAR_CACHE_KEY = 10004;
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const totals = (rows: readonly { typeID: number; quantity: number }[]) => {
  const map = new Map<number, number>();
  for (const r of rows) {
    if (!positive(r.typeID) || !positive(r.quantity)) throw Error("Invalid inventory quantity.");
    const n = (map.get(r.typeID) ?? 0) + r.quantity;
    if (!Number.isSafeInteger(n)) throw Error("Inventory quantity overflow.");
    map.set(r.typeID, n);
  }
  return map;
};
const destinationQueues = new Map<string, Promise<void>>();
async function serializeDestination<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = destinationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  destinationQueues.set(key, next);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (destinationQueues.get(key) === next) destinationQueues.delete(key);
  }
}
// Completed receipts from earlier versions were sealed against totals for the entire division.
function matchesRecordedTotals(
  before: readonly NativeInventoryRow[],
  moved: readonly DepositItem[],
  after: readonly NativeInventoryRow[],
) {
  const expected = totals([...before, ...moved]),
    actual = totals(after);
  return (
    expected.size === actual.size &&
    [...expected].every(([typeID, quantity]) => actual.get(typeID) === quantity)
  );
}
/** A merge can grow stock of this type. A disappearing or shrinking destination
 * stack means another movement of the same type cannot be separated from ours. */
function receivedQuantity(
  typeID: number,
  quantity: number,
  before: readonly NativeInventoryRow[],
  after: readonly NativeInventoryRow[],
  incoming?: ReadonlyMap<number, number>,
) {
  const prior = before.filter((r) => r.typeID === typeID),
    next = after.filter((r) => r.typeID === typeID);
  const priorQuantity = new Map(prior.map((r) => [r.itemID, r.quantity])),
    byID = new Map(next.map((r) => [r.itemID, r]));
  if (prior.some((r) => (byID.get(r.itemID)?.quantity ?? 0) < r.quantity)) return false;
  // Credit identifiable source rows first. A remaining merge needs one observable receiving stack.
  const receivers = next.filter(
    (r) => r.quantity > (priorQuantity.get(r.itemID) ?? incoming?.get(r.itemID) ?? 0),
  );
  if (receivers.length > 1) return false;
  return (totals(next).get(typeID) ?? 0) - (totals(prior).get(typeID) ?? 0) === quantity;
}
/** Read-only exact delta check; an unchanged or ambiguous snapshot never licenses replay. */
export function confirmedDepositItem(
  item: Pending["item"],
  beforeShip: readonly NativeInventoryRow[],
  afterShip: readonly NativeInventoryRow[],
  beforeCorp: readonly NativeInventoryRow[],
  afterCorp: readonly NativeInventoryRow[],
  receipt?: "recorded",
) {
  const selected = beforeShip.find((r) => r.itemID === item.itemID);
  if (!selected || selected.typeID !== item.typeID || selected.quantity < item.quantity)
    return false;
  const expected = beforeShip.flatMap((r) =>
    r.itemID !== item.itemID
      ? [r]
      : r.quantity === item.quantity
        ? []
        : [{ ...r, quantity: r.quantity - item.quantity }],
  );
  if (
    afterShip.length !== expected.length ||
    !expected.every((r) =>
      afterShip.some(
        (a) =>
          a.itemID === r.itemID &&
          a.typeID === r.typeID &&
          a.quantity === r.quantity &&
          a.ownerID === r.ownerID &&
          a.locationID === r.locationID &&
          a.flagID === r.flagID,
      ),
    )
  )
    return false;
  if (receipt === "recorded" && matchesRecordedTotals(beforeCorp, [item], afterCorp)) return true;
  if (beforeCorp.some((r) => r.itemID === item.itemID)) return false;
  const stored = afterCorp.find((r) => r.itemID === item.itemID);
  if (
    stored &&
    (selected.quantity !== item.quantity ||
      stored.typeID !== item.typeID ||
      stored.quantity < item.quantity)
  )
    return false;
  if (
    selected.quantity === item.quantity &&
    observedParkingStacks([selected], [], beforeCorp, afterCorp, [item.itemID])?.length === 1
  )
    return true;
  return receivedQuantity(item.typeID, item.quantity, beforeCorp, afterCorp);
}
/** Match actual whole stacks removed from the ship against the change in the division. */
export function movedWholeStacks(
  beforeShip: readonly NativeInventoryRow[],
  afterShip: readonly NativeInventoryRow[],
  beforeCorp: readonly NativeInventoryRow[],
  afterCorp: readonly NativeInventoryRow[],
  receipt?: "recorded",
) {
  const original = new Map(beforeShip.map((r) => [r.itemID, r])),
    remaining = new Set(afterShip.map((r) => r.itemID));
  if (
    afterShip.some((r) => {
      const prior = original.get(r.itemID);
      return (
        !prior ||
        r.typeID !== prior.typeID ||
        r.quantity !== prior.quantity ||
        r.ownerID !== prior.ownerID ||
        r.locationID !== prior.locationID ||
        r.flagID !== prior.flagID
      );
    })
  )
    return null;
  const moved = beforeShip.filter((r) => !remaining.has(r.itemID));
  if (receipt === "recorded" && matchesRecordedTotals(beforeCorp, moved, afterCorp)) return moved;
  if (
    beforeCorp.some((r) => original.has(r.itemID)) ||
    afterCorp.some((r) => remaining.has(r.itemID))
  )
    return null;
  if (
    observedParkingStacks(
      moved,
      [],
      beforeCorp,
      afterCorp,
      moved.map((r) => r.itemID),
    )?.length === moved.length
  )
    return moved;
  for (const [typeID, quantity] of totals(moved)) {
    const rows = moved.filter((r) => r.typeID === typeID),
      ids = rows.map((r) => r.itemID);
    if (observedParkingStacks(rows, [], beforeCorp, afterCorp, ids)?.length === rows.length)
      continue;
    const incoming = new Map(rows.map((r) => [r.itemID, r.quantity]));
    if (
      afterCorp.some(
        (r) =>
          incoming.has(r.itemID) && (r.typeID !== typeID || r.quantity < incoming.get(r.itemID)!),
      ) ||
      !receivedQuantity(typeID, quantity, beforeCorp, afterCorp, incoming)
    )
      return null;
  }
  return moved;
}
/** A whole stack is still at its original source, or is the same Item ID in the verified division. */
function observedParkingStacks(
  beforeShip: readonly NativeInventoryRow[],
  afterShip: readonly NativeInventoryRow[],
  beforeCorp: readonly NativeInventoryRow[],
  afterCorp: readonly NativeInventoryRow[],
  requestedIDs: readonly number[],
) {
  const requested = new Set(requestedIDs),
    alreadyInDestination = new Set(beforeCorp.map((row) => row.itemID));
  const source = new Map(afterShip.map((row) => [row.itemID, row])),
    destination = new Map(afterCorp.map((row) => [row.itemID, row]));
  const before = beforeShip.filter((row) => requested.has(row.itemID)),
    moved: NativeInventoryRow[] = [];
  if (before.length !== requested.size) return null;
  for (const row of before) {
    const held = source.get(row.itemID),
      stored = destination.get(row.itemID);
    if (alreadyInDestination.has(row.itemID)) return null;
    if (
      held &&
      !stored &&
      held.typeID === row.typeID &&
      held.quantity === row.quantity &&
      held.flagID === row.flagID &&
      held.ownerID === row.ownerID &&
      held.locationID === row.locationID
    )
      continue;
    if (!held && stored?.typeID === row.typeID && stored.quantity === row.quantity) moved.push(row);
    else return null;
  }
  return moved;
}
function definiteSingleRefusal(error: unknown) {
  const refusal = error as { code?: string; status?: number; refusal?: { key?: string } } | null;
  return (
    bridgeCallQueueTimeout(error) ||
    (refusal?.status === 409 &&
      ((refusal.code === "CALL_REFUSED" && !!refusal.refusal?.key) ||
        refusal.code === "INVENTORY_SHIP_CHANGED" ||
        refusal.code === "INVENTORY_LOCATION_CHANGED" ||
        refusal.code === "STRUCTURE_SERVICE_UNAVAILABLE"))
  );
}
export async function readDepositInventory<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof FleetObservationUnavailable) && !transientNativeRead(error)) throw error;
    return read();
  }
}
const batchItems = (b: Pending) => b.items ?? [b.item];
export async function createDockedRawDepositIO(
  run: Run,
  session: PilotSession,
  config: {
    characterID: number;
    shipID: number;
    destinationID: number;
    corporationID?: number;
    division?: number;
    delivery?: FleetDelivery;
    freightKind?: "RAW" | "COMPRESSED" | "ANY";
    current: () => void;
    reconcileParking?: boolean;
  },
) {
  const { characterID, shipID, destinationID, current } = config;
  const delivery = config.delivery === undefined ? null : decodeFleetDelivery(config.delivery);
  const corporationID = delivery ? delivery.corporationID : config.corporationID,
    division = delivery ? delivery.division : config.division,
    personal = !!delivery && corporationID === null;
  if (
    characterID !== run.characterID ||
    !positive(shipID) ||
    !positive(destinationID) ||
    (config.delivery !== undefined &&
      (!delivery ||
        delivery.destinationID !== destinationID ||
        (personal && (config.corporationID !== undefined || config.division !== undefined)) ||
        (!personal && (config.corporationID !== corporationID || config.division !== division)))) ||
    (!personal && (!positive(corporationID) || !positive(division) || division > 7))
  )
    throw Error("Raw deposit scope is invalid.");
  const f = session.flow.flying,
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  const guard = () => {
    current();
    const online = session.store.station.get().online;
    if (
      online?.characterID !== characterID ||
      (!personal && online.corporationID !== corporationID)
    )
      throw Error("Held pilot or corporation changed.");
  };
  const flight = async () => {
    guard();
    const x = decodeFlightStatus((await getFlightStatus(options).catch(fleetReadFailed)).flight);
    guard();
    if (
      !x.docked ||
      x.inSpace ||
      (x.stationID ?? x.structureID) !== destinationID ||
      x.shipID !== shipID ||
      (delivery &&
        (x.solarSystemID !== delivery.systemID ||
          (delivery.kind === "station"
            ? x.stationID !== destinationID
            : x.structureID !== destinationID)))
    )
      throw Error("Exact docked pilot and ship are required.");
    if (x.transition && x.transition.phase !== "ready")
      throw new FleetObservationUnavailable("The delivery dock is still settling.");
  };
  const cargo = async () => {
    await flight();
    const rows = await readNativeShipHolds(session, guard, characterID, shipID);
    await flight();
    return rows;
  };
  await flight();
  let officeID = destinationID;
  if (!personal) {
    const readOffice = await readMiningOfficeAccess(
      { characterID, corporationID: corporationID! },
      [destinationID],
      async (path) => {
        const response = await run.fetch(new URL(path, run.baseUrl)),
          body = await response.json();
        guard();
        if (!response.ok || body?.ok !== true)
          throw Object.assign(Error(body?.message ?? "Corporate office list is unreadable."), {
            code: body?.error,
            status: response.status,
          });
        return body;
      },
      (method, args) => f.bridgeAsk("corpRegistry", method, args ?? []),
    ).catch(fleetReadFailed);
    requireMiningOfficeQuery(readOffice(destinationID), corporationID!, division!);
    const actualOffice = await officeAt(f.bridgeAsk, destinationID).catch(fleetReadFailed);
    await flight();
    if (!positive(actualOffice))
      throw Error("Corporation office is unavailable at the selected dock.");
    officeID = actualOffice;
  }
  const flag = personal ? 4 : corpDivisionFlag(division!),
    destinationOwner = personal ? characterID : corporationID!;
  const inventory = personal ? "hangar" : officeID;
  const place = personal
    ? { kind: "hangar" as const }
    : { kind: "corp" as const, division: division! };
  const cacheKey = personal && delivery.kind === "station" ? STATION_HANGAR_CACHE_KEY : officeID;
  const withDestination = <T>(action: () => Promise<T>) =>
    serializeDestination(
      JSON.stringify([run.baseUrl, destinationOwner, officeID, flag]),
      async () => {
        guard();
        return action();
      },
    );
  const corp = async () => {
    await flight();
    await f.bridgeDo("invCache", "InvalidateLocationCache", [cacheKey]);
    guard();
    const rows = checkedInventory(await f.bridgeAsk("invbroker", "List", [], { flag }, inventory));
    guard();
    if (
      rows.some(
        (r) => r.ownerID !== destinationOwner || r.locationID !== officeID || r.flagID !== flag,
      )
    )
      throw Error("Corporation inventory identity is uncertain.");
    await flight();
    return rows;
  };
  const verify = async (items: readonly { typeID: number }[]) => {
    const facts = await createRawTypeFacts(run, guard)(items.map((i) => i.typeID));
    for (const i of items) {
      const v = facts[i.typeID];
      if (
        !v ||
        v.categoryID !== 25 ||
        !(config.freightKind === "ANY"
          ? v.freightKind === "RAW" || v.freightKind === "COMPRESSED"
          : v.freightKind === (config.freightKind ?? "RAW")) ||
        !Number.isFinite(v.unitVolumeM3) ||
        v.unitVolumeM3 <= 0
      )
        throw Error("Only verified selected freight can be deposited.");
    }
    return facts;
  };
  const observeSingle = async (
    item: DepositItem,
    sourceBefore: readonly NativeInventoryRow[],
    destinationBefore: readonly NativeInventoryRow[],
  ) => {
    const read = config.reconcileParking
      ? readDepositInventory
      : <T>(observe: () => Promise<T>) => observe();
    const sourceAfter = await read(cargo),
      destinationAfter = await read(corp);
    const exact = config.reconcileParking
      ? observedParkingStacks(sourceBefore, sourceAfter, destinationBefore, destinationAfter, [
          item.itemID,
        ])
      : null;
    const moved =
      exact?.length === 1 ||
      confirmedDepositItem(item, sourceBefore, sourceAfter, destinationBefore, destinationAfter);
    return { sourceAfter, destinationAfter, moved, unchanged: exact?.length === 0 };
  };
  const deposit = async (
    item: { itemID: number; typeID: number; quantity: number },
    fence: DepositFence,
    allowPartial = false,
  ) =>
    withDestination(async () => {
      const facts = await verify([item]);
      const sourceBefore = await cargo(),
        row = sourceBefore.find((r) => r.itemID === item.itemID);
      if (
        !row ||
        row.typeID !== item.typeID ||
        !positive(item.quantity) ||
        (allowPartial ? row.quantity < item.quantity : row.quantity !== item.quantity) ||
        !(
          row.flagID === 5 ||
          (row.flagID === 134 &&
            ["ore", "ice"].includes(facts[item.typeID]?.resourceFamily ?? "")) ||
          (row.flagID === 181 && facts[item.typeID]?.resourceFamily === "ice") ||
          (row.flagID === 182 && facts[item.typeID]?.resourceFamily === "ore")
        )
      )
        throw Error("Exact raw source stack is not available.");
      const destinationBefore = await corp();
      fence.begin("delivery", { item, sourceBefore, destinationBefore, officeID, flag });
      guard();
      let writeFailed = false;
      try {
        await moveItems(
          f.bridgeDo,
          inventory,
          place,
          shipID,
          [{ ...row, singleton: false }],
          row.quantity === item.quantity ? null : item.quantity,
        );
      } catch (error) {
        guard();
        // Only a definite refusal of this single Add can retire the existing intent without a readback.
        if (definiteSingleRefusal(error)) {
          fence.refuseDelivery();
          throw error;
        }
        if (!config.reconcileParking) throw error;
        writeFailed = true;
      }
      guard();
      if (!writeFailed) fence.acknowledge();
      const { sourceAfter, destinationAfter, moved, unchanged } = await observeSingle(
        item,
        sourceBefore,
        destinationBefore,
      );
      if (unchanged)
        throw new FleetObservationUnavailable(
          "The stack is still in the ship's hold. Rechecking the pending unload.",
        );
      if (!moved) throw Error("Raw deposit outcome remains unknown; no replay.");
      fence.settle({ sourceAfter, destinationAfter });
      return { item, sourceBefore, sourceAfter, destinationBefore, destinationAfter };
    });
  const observeWhole = async (
    sourceBefore: readonly NativeInventoryRow[],
    destinationBefore: readonly NativeInventoryRow[],
    requestedIDs: readonly number[],
  ) => {
    // The shared division can change while the ship's holds are read one by one.
    const destinationAfter = await readDepositInventory(corp);
    const sourceAfter = await readDepositInventory(cargo);
    const exact = config.reconcileParking
      ? observedParkingStacks(
          sourceBefore,
          sourceAfter,
          destinationBefore,
          destinationAfter,
          requestedIDs,
        )
      : null;
    const moved =
        exact ?? movedWholeStacks(sourceBefore, sourceAfter, destinationBefore, destinationAfter),
      requested = new Set(requestedIDs);
    if (!moved || moved.some((r) => !requested.has(r.itemID)))
      throw Error("Raw deposit outcome remains unknown; no replay.");
    return { sourceAfter, destinationAfter, movedIDs: new Set(moved.map((r) => r.itemID)) };
  };
  const depositWhole = async (
    rows: readonly NativeInventoryRow[],
    sourceBefore: readonly NativeInventoryRow[],
    destinationBefore: readonly NativeInventoryRow[],
    notDispatched?: () => void,
  ) => {
    if (personal) throw Error("Whole-stack delivery requires a corporation division.");
    guard();
    let writeError: unknown;
    try {
      await moveItems(
        f.bridgeDo,
        officeID,
        { kind: "corp", division: division! },
        shipID,
        rows.map((r) => ({ ...r, singleton: false })),
        null,
      );
    } catch (error) {
      guard();
      if (notDispatched && bridgeCallQueueTimeout(error)) {
        notDispatched();
        throw new FleetObservationUnavailable(
          "Unload did not enter the transport. Rechecking the docked hold.",
          { cause: error },
        );
      }
      writeError = error;
    }
    const after = await observeWhole(
      sourceBefore,
      destinationBefore,
      rows.map((r) => r.itemID),
    );
    if (!after.movedIDs.size) {
      if (config.reconcileParking && !definiteSingleRefusal(writeError))
        throw new FleetObservationUnavailable(
          "The stacks are still in the ship's hold. Rechecking the pending unload.",
          { cause: writeError },
        );
      throw writeError ?? Error("Corporation unload made no inventory progress.");
    }
    return { ...after, acknowledged: !writeError };
  };
  const reconcileDelivery = async (before: DeliveryBefore) =>
    withDestination(async () => {
      if (before.officeID !== officeID || before.flag !== flag)
        throw Error("Original deposit destination changed; no replay.");
      if (before.items && before.requestedIDs) {
        const { movedIDs, ...after } = await observeWhole(
          before.sourceBefore,
          before.destinationBefore,
          before.requestedIDs,
        );
        if (!movedIDs.size && !config.reconcileParking)
          throw Error("Raw deposit outcome remains unknown; no replay.");
        return { ...after, items: before.items.filter((r) => movedIDs.has(r.itemID)) };
      }
      const { sourceAfter, destinationAfter, moved, unchanged } = await observeSingle(
        before.item,
        before.sourceBefore,
        before.destinationBefore,
      );
      if (!moved && !unchanged) throw Error("Raw deposit outcome remains unknown; no replay.");
      return { sourceAfter, destinationAfter, ...(unchanged ? { items: [] } : {}) };
    });
  return {
    guard,
    flight,
    cargo,
    corp,
    verify,
    deposit,
    depositWhole,
    reconcileDelivery,
    withDestination,
    officeID,
    flag,
    destinationOwner,
  };
}
/** Deposit only the exact original raw stacks while the same held pilot is docked. */
export async function depositOwnShipRaw(
  run: Run,
  session: PilotSession,
  config: DepositConfig,
): Promise<RawDepositReceipt> {
  const { source, destinationID, current, document } = config;
  const delivery = config.delivery === undefined ? null : decodeFleetDelivery(config.delivery),
    corporationID = delivery ? delivery.corporationID : (config.corporationID ?? null),
    division = delivery ? delivery.division : (config.division ?? null),
    personal = !!delivery && corporationID === null;
  if (
    !document ||
    typeof document.read !== "function" ||
    typeof document.write !== "function" ||
    !(
      source?.kind === "own-ship-raw" ||
      (source?.kind === "own-ship-freight" && config.freightKind === "ANY")
    ) ||
    typeof source.operationID !== "string" ||
    !source.operationID.trim() ||
    typeof source.runID !== "string" ||
    !source.runID.trim() ||
    source.characterID !== run.characterID ||
    !positive(source.shipID) ||
    !positive(destinationID) ||
    (config.delivery !== undefined &&
      (!delivery ||
        delivery.destinationID !== destinationID ||
        (personal && (config.corporationID !== undefined || config.division !== undefined)) ||
        (!personal && (config.corporationID !== corporationID || config.division !== division)))) ||
    (!personal && (!positive(corporationID) || !positive(division) || division > 7)) ||
    !Array.isArray(source.items) ||
    !source.items.length ||
    source.items.some((i) => !positive(i.itemID) || !positive(i.typeID) || !positive(i.quantity)) ||
    new Set(source.items.map((i) => i.itemID)).size !== source.items.length
  )
    throw Error("Raw deposit scope is invalid.");
  const io = await createDockedRawDepositIO(run, session, {
    characterID: source.characterID,
    shipID: source.shipID,
    destinationID,
    ...(corporationID === null ? {} : { corporationID }),
    ...(division === null ? {} : { division }),
    ...(delivery ? { delivery } : {}),
    ...(config.freightKind ? { freightKind: config.freightKind } : {}),
    reconcileParking: config.reconcileParking,
    current,
  });
  const { guard, cargo, corp, officeID, flag, destinationOwner } = io;
  const sourceFacts = await io.verify(source.items);
  const identity = JSON.stringify(
      delivery
        ? [source, destinationID, corporationID, division, officeID, delivery]
        : [source, destinationID, corporationID, division, officeID],
    ),
    raw = document.read();
  let state: Journal;
  if (raw === null)
    state = { version: 1, identity, officeID, pending: null, batches: [], receipt: null };
  else {
    const x = raw as Journal;
    if (
      !x ||
      x.version !== 1 ||
      x.identity !== identity ||
      x.officeID !== officeID ||
      !Array.isArray(x.batches) ||
      !(x.pending === null || (x.pending && typeof x.pending === "object")) ||
      !(x.receipt === null || (x.receipt && typeof x.receipt === "object"))
    )
      throw Error("Raw deposit journal requires reconciliation.");
    state = structuredClone(x);
  }
  const rowsValid = (
    rows: unknown,
    ownerID: number,
    locationID: number,
    flags: readonly number[],
  ) =>
    Array.isArray(rows) &&
    new Set(rows.map((r: any) => r?.itemID)).size === rows.length &&
    rows.every(
      (r: any) =>
        r &&
        positive(r.itemID) &&
        positive(r.typeID) &&
        positive(r.quantity) &&
        r.ownerID === ownerID &&
        r.locationID === locationID &&
        flags.includes(r.flagID),
    );
  const sourceRow = (rows: readonly NativeInventoryRow[], item: DepositItem) =>
    rows.find(
      (r) =>
        r.itemID === item.itemID &&
        r.typeID === item.typeID &&
        r.quantity === item.quantity &&
        (r.flagID === 5 ||
          r.flagID === 134 ||
          (r.flagID === 181 && sourceFacts[r.typeID]?.resourceFamily === "ice") ||
          (r.flagID === 182 && sourceFacts[r.typeID]?.resourceFamily === "ore")),
    );
  const checkBefore = (b: Pending) => {
    if (
      !b ||
      typeof b !== "object" ||
      typeof b.acknowledged !== "boolean" ||
      !b.item ||
      (b.items !== undefined &&
        (personal ||
          !Array.isArray(b.items) ||
          !b.items.length ||
          JSON.stringify(b.item) !== JSON.stringify(b.items[0])))
    )
      return false;
    const items = batchItems(b);
    return (
      new Set(items.map((i) => i?.itemID)).size === items.length &&
      rowsValid(b.sourceBefore, source.characterID, source.shipID, [5, 134, 135, 181, 182]) &&
      rowsValid(b.destinationBefore, destinationOwner, officeID, [flag]) &&
      items.every(
        (item) =>
          item &&
          source.items.some(
            (i) =>
              i.itemID === item.itemID && i.typeID === item.typeID && i.quantity === item.quantity,
          ) &&
          sourceRow(b.sourceBefore, item),
      )
    );
  };
  const checkBatch = (b: Batch) => {
    try {
      if (
        !checkBefore(b) ||
        !rowsValid(b.sourceAfter, source.characterID, source.shipID, [5, 134, 135, 181, 182]) ||
        !rowsValid(b.destinationAfter, destinationOwner, officeID, [flag])
      )
        return false;
      if (config.reconcileParking) {
        const ids = batchItems(b).map((i) => i.itemID);
        const exact = observedParkingStacks(
          b.sourceBefore,
          b.sourceAfter,
          b.destinationBefore,
          b.destinationAfter,
          ids,
        );
        if (exact?.length === ids.length) return true;
      }
      if (!b.items)
        return confirmedDepositItem(
          b.item,
          b.sourceBefore,
          b.sourceAfter,
          b.destinationBefore,
          b.destinationAfter,
          "recorded",
        );
      const moved = movedWholeStacks(
        b.sourceBefore,
        b.sourceAfter,
        b.destinationBefore,
        b.destinationAfter,
        "recorded",
      );
      return (
        !!moved &&
        moved.length === b.items.length &&
        b.items.every((i) => moved.some((r) => r.itemID === i.itemID))
      );
    } catch {
      return false;
    }
  };
  if (state.batches.some((b) => !checkBatch(b)))
    throw Error("Raw deposit journal requires reconciliation.");
  const batchIDs = state.batches.flatMap((b) => batchItems(b).map((i) => i.itemID));
  if (
    new Set(batchIDs).size !== batchIDs.length ||
    (state.pending &&
      (!checkBefore(state.pending) ||
        batchItems(state.pending).some((i) => batchIDs.includes(i.itemID))))
  )
    throw Error("Raw deposit journal requires reconciliation.");
  if (
    state.receipt &&
    (state.pending !== null ||
      batchIDs.length !== source.items.length ||
      JSON.stringify(state.receipt.source) !== JSON.stringify(source) ||
      state.receipt.destinationID !== destinationID ||
      state.receipt.corporationID !== corporationID ||
      state.receipt.division !== division ||
      state.receipt.officeID !== officeID ||
      JSON.stringify(state.receipt.delivery ?? null) !== JSON.stringify(delivery) ||
      !Number.isFinite(state.receipt.completedAt) ||
      state.receipt.completedAt <= 0 ||
      state.receipt.completedAt > Date.now() ||
      (state.receipt.batches !== undefined &&
        JSON.stringify(state.receipt.batches) !== JSON.stringify(state.batches)))
  )
    throw Error("Raw deposit receipt requires reconciliation.");
  const save = (next: Journal) => {
    guard();
    document.write(next);
    state = next;
  };
  if (state.receipt) {
    const remaining = await cargo();
    if (source.items.some((i) => remaining.some((r) => r.itemID === i.itemID)))
      throw Error("Completed deposit source has reappeared.");
    const { batches, ...receipt } = state.receipt;
    if (batches !== undefined) save({ ...state, receipt });
    return structuredClone({ ...receipt, batches: state.batches });
  }
  const settle = (
    pending: Pending,
    after: Pick<Batch, "sourceAfter" | "destinationAfter" | "items">,
  ) => {
    const items = after.items;
    const batches =
      items && !items.length
        ? state.batches
        : [...state.batches, { ...pending, ...after, item: items?.[0] ?? pending.item }];
    save({ ...state, pending: null, batches });
  };
  const retained = state.pending;
  if (retained)
    settle(
      retained,
      await io.reconcileDelivery({
        ...retained,
        officeID,
        flag,
        ...(retained.items ? { requestedIDs: retained.items.map((i) => i.itemID) } : {}),
      }),
    );
  const remainingItems = () =>
    source.items.filter(
      (i) => !state.batches.some((b) => batchItems(b).some((x) => x.itemID === i.itemID)),
    );
  if (!personal && config.wholeStacks && remainingItems().length > 1)
    await io.withDestination(async () => {
      let sourceBefore = await readDepositInventory(cargo),
        destinationBefore = await readDepositInventory(corp);
      for (let items = remainingItems(); items.length; items = remainingItems()) {
        const rows = items.map((i) => sourceRow(sourceBefore, i)).filter((r) => r !== undefined);
        if (rows.length !== items.length) throw Error("Exact raw source stack is not available.");
        const pending = {
          item: items[0]!,
          items,
          sourceBefore,
          destinationBefore,
          acknowledged: false,
        };
        current();
        save({ ...state, pending });
        const { movedIDs, sourceAfter, destinationAfter, acknowledged } = await io.depositWhole(
          rows,
          sourceBefore,
          destinationBefore,
        );
        settle(
          { ...pending, acknowledged },
          { items: items.filter((i) => movedIDs.has(i.itemID)), sourceAfter, destinationAfter },
        );
        sourceBefore = sourceAfter;
        destinationBefore = destinationAfter;
      }
    });
  for (const item of remainingItems()) {
    const batch = await io.deposit(item, {
      begin(_kind, before) {
        const x = before as {
          sourceBefore: NativeInventoryRow[];
          destinationBefore: NativeInventoryRow[];
        };
        save({
          ...state,
          pending: {
            item,
            sourceBefore: x.sourceBefore,
            destinationBefore: x.destinationBefore,
            acknowledged: false,
          },
        });
      },
      acknowledge() {
        if (!state.pending) throw Error("Raw deposit intent is missing.");
        save({ ...state, pending: { ...state.pending, acknowledged: true } });
      },
      refuseDelivery() {
        if (!state.pending || state.pending.acknowledged) throw Error("No refused deposit intent.");
        save({ ...state, pending: null });
      },
      settle(after) {
        if (!state.pending || (!state.pending.acknowledged && !config.reconcileParking))
          throw Error("Raw deposit acknowledgement is missing.");
        const x = after as {
          sourceAfter: NativeInventoryRow[];
          destinationAfter: NativeInventoryRow[];
        };
        settle(state.pending, x);
      },
    });
    if (!batch) throw Error("Raw deposit batch is unavailable.");
  }
  const final = await cargo();
  if (source.items.some((i) => final.some((r) => r.itemID === i.itemID)) || remainingItems().length)
    throw Error("Raw deposit completion is uncertain.");
  const receipt = {
    source,
    destinationID,
    corporationID,
    division,
    officeID,
    ...(delivery ? { delivery } : {}),
    completedAt: Date.now(),
  };
  save({ ...state, receipt });
  return structuredClone({ ...receipt, batches: state.batches });
}
