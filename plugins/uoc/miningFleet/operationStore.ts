import type { DeliveryEvidence, Manifest, OperationRecord } from "./operation.ts";
import type { SelfUnloadTotals } from "./selfUnload.ts";
import type { SynchronousStore } from "./targetBoard.ts";
import type { NativeDeliveryBatch } from "./nativeHauler.ts";
import { movedWholeStacks } from "./dockedRawDeposit.ts";

export interface FleetOperationDocuments {
  document(name: string): SynchronousStore;
  documentNames(prefix: string): string[];
  transaction<T>(action: () => T): T;
  deleteDocuments(names: readonly string[], prefixes: readonly string[]): void;
}

export type ArchivedDelivery = { manifest: Manifest; receipt: DeliveryEvidence };
export type LegacyOperation = OperationRecord & { deliveryReceipts?: readonly DeliveryEvidence[] };

const operationPrefix = "mining-fleet-operation:";
const receiptPrefix = "mining-delivery-receipt:";
const resultPrefix = "mining-run-result:";
const haulPrefix = "mining-fleet-haul:";
const keyPrefix = (prefix: string, scope: readonly string[]) => prefix + JSON.stringify(scope).slice(0, -1) + ",";

export type FleetRunResult = {
  runID: string;
  observedAt: number | null;
  deliveredContainers: number;
  deliveredUnits: number;
  deliveredVolumeM3: number | null;
  unitsByType: Record<string, number>;
  trips: number | null;
};

export function finishedFleetExecution(record: OperationRecord) {
  return record.state === "STOPPED" && record.claim === null && !record.relocation &&
    Array.isArray(record.members) && Array.isArray(record.settled) && Array.isArray(record.parked) &&
    record.members.every(member => record.neverStarted?.includes(member.characterID) ||
      record.settled.includes(member.characterID) &&
      (record.parked.includes(member.characterID) || record.stayed?.includes(member.characterID))) &&
    Array.isArray(record.manifests) && record.manifests.every(manifest => manifest.delivered === true) &&
    !!record.haulClaims && !Object.keys(record.haulClaims).length &&
    !!record.jetcanIntents && !Object.keys(record.jetcanIntents).length;
}

export function unusedFleetExecution(record: OperationRecord) {
  return record.state === "READY" && Array.isArray(record.manifests) && !record.manifests.length &&
    record.haulClaims && !Object.keys(record.haulClaims).length &&
    record.jetcanIntents && !Object.keys(record.jetcanIntents).length && !record.relocation;
}

export function savedFleetExecution(storage: FleetOperationDocuments, operationID: string, runID: string) {
  const value = storage.document(operationPrefix + JSON.stringify([operationID, runID])).read() as LegacyOperation | null;
  if (value && (value.version !== 1 || value.operationID !== operationID || value.runID !== runID))
    throw Error("Fleet execution identity changed.");
  return value;
}

export function fleetOperationStore(storage: FleetOperationDocuments, operationID: string, runID: string) {
  const document = storage.document(operationPrefix + JSON.stringify([operationID, runID]));
  const receiptDocument = (containerID: number) =>
    storage.document(receiptPrefix + JSON.stringify([operationID, runID, containerID]));

  function read(): OperationRecord | null {
    const saved = document.read() as LegacyOperation | null;
    if (saved?.deliveryReceipts === undefined) return saved;

    const { deliveryReceipts, ...record } = saved;
    if (record.version !== 1 || record.operationID !== operationID || record.runID !== runID ||
        !Array.isArray(record.manifests) || !Array.isArray(record.members) || !Array.isArray(deliveryReceipts))
      throw Error("Delivery receipts require reconciliation.");

    const delivered = new Set(record.manifests.filter(m => m?.delivered === true).map(m => m.containerID));
    const haulerShips = new Set(record.members.filter(m => m && (m.role === "HAULER" ||
      m.role === "COMMAND" && record.commandCapabilities?.collect === true && m.characterID === record.commandCapabilities.characterID))
      .map(m => m.shipID));
    const receipts = new Map<number, DeliveryEvidence>();
    for (const receipt of deliveryReceipts) {
      if (!receipt || receipt.source !== "native-transfer" || receipt.operationID !== operationID ||
          receipt.runID !== runID || receipt.destinationID !== record.destinationID ||
          !Number.isFinite(receipt.observedAt) || !haulerShips.has(receipt.shipID) ||
          !Number.isSafeInteger(receipt.containerID) || receipt.containerID <= 0 ||
          !delivered.has(receipt.containerID) || receipts.has(receipt.containerID))
        throw Error("Delivery receipts require reconciliation.");
      receipts.set(receipt.containerID, receipt);
    }

    const manifests = record.manifests.map(manifest => {
      const receipt = receipts.get(manifest?.containerID);
      return receipt ? { ...manifest, deliveredAt: receipt.observedAt } : manifest;
    });
    const migrated = { ...record, manifests };
    storage.transaction(() => {
      for (const manifest of manifests) {
        const receipt = receipts.get(manifest?.containerID);
        if (receipt) receiptDocument(manifest.containerID).write({ manifest, receipt } satisfies ArchivedDelivery);
      }
      document.write(migrated);
    });
    return migrated;
  }

  function recordDelivery(record: OperationRecord, entry: ArchivedDelivery) {
    storage.transaction(() => {
      receiptDocument(entry.receipt.containerID).write(entry);
      document.write(record);
    });
  }

  function readDelivery(containerID: number): ArchivedDelivery | null {
    const proof = receiptDocument(containerID);
    const saved = proof.read() as ArchivedDelivery | null;
    if (saved) return saved;
    // An old retained run might not have been opened since upgrading.
    if (!read()?.manifests?.some(m => m.containerID === containerID && m.deliveredAt !== undefined)) return null;
    return proof.read() as ArchivedDelivery | null;
  }

  return { read, write: document.write, recordDelivery, readDelivery };
}

export type FleetOperationStore = ReturnType<typeof fleetOperationStore>;

export function deliveryReceiptIndex(storage: FleetOperationDocuments, operationID: string) {
  for (const name of storage.documentNames(keyPrefix(operationPrefix, [operationID]))) {
    const [, runID] = JSON.parse(name.slice(operationPrefix.length)) as [string, string];
    fleetOperationStore(storage, operationID, runID).read();
  }
  return storage.documentNames(keyPrefix(receiptPrefix, [operationID])).map(name => {
    const [, runID, containerID] = JSON.parse(name.slice(receiptPrefix.length)) as [string, string, number];
    return { runID, containerID };
  });
}

export function retiredFleetRuns(storage: FleetOperationDocuments, operationID: string) {
  const runs = [operationPrefix, receiptPrefix].flatMap(prefix =>
    storage.documentNames(keyPrefix(prefix, [operationID])).map(name => {
      const [, runID] = JSON.parse(name.slice(prefix.length)) as [string, string];
      return runID;
    }));
  return new Set(runs);
}

export function fleetRunResult(storage: FleetOperationDocuments, operationID: string, runID?: string) {
  return storage.document(resultPrefix + JSON.stringify(runID === undefined ? [operationID] : [operationID, runID]))
    .read() as FleetRunResult | null;
}

/** Read on an explicit run query or at retirement, outside the working snapshot. */
export function summarizeFleetRun(storage: FleetOperationDocuments, operationID: string, runID: string,
  record: LegacyOperation | null, observedAt: number | null, selfUnloads: readonly SelfUnloadTotals[] = []) {
  const prefix = keyPrefix(receiptPrefix, [operationID, runID]);
  const names = storage.documentNames(prefix);
  if (record === null && !names.length) return null;

  const manifests = new Map<number, Manifest>();
  for (const manifest of record?.manifests ?? []) if (manifest.delivered) manifests.set(manifest.containerID, manifest);
  const accounted = new Set<number>(), visits = new Set<string>();
  const countedMoves = new Set<string>();
  const freightAdjustment = new Map<number, number>();
  const addFreight = (typeID: number, quantity: number) =>
    freightAdjustment.set(typeID, (freightAdjustment.get(typeID) ?? 0) + quantity);
  let lastDelivery: number | null = null, unknownTrips = false;
  function addBatch(shipID: number, batch: NativeDeliveryBatch, includedInManifest: boolean) {
    const tripID = typeof batch.tripID === "string" && batch.tripID ? batch.tripID : undefined;
    if (batch.items !== undefined && tripID) {
      const moved = movedWholeStacks(batch.sourceBefore, batch.sourceAfter, batch.destinationBefore, batch.destinationAfter, "recorded");
      if (!moved) throw Error("Whole-stack delivery requires reconciliation.");
      if (!moved.length) return;
      // Each can can reference a share of the same physical MultiAdd.
      const key = JSON.stringify([shipID, tripID, moved.map(row => row.itemID).sort((a, b) => a - b)]);
      if (!countedMoves.has(key)) {
        countedMoves.add(key);
        for (const row of moved) addFreight(row.typeID, row.quantity);
      }
      if (includedInManifest) for (const item of batch.items) addFreight(item.typeID, -item.quantity);
    } else if (!includedInManifest) {
      if (batch.items !== undefined) return;
      addFreight(batch.item.typeID, batch.item.quantity);
    }
    if (tripID) visits.add(tripID);
    else unknownTrips = true;
  }
  const addReceipt = (receipt: DeliveryEvidence) => {
    if (receipt.source !== "native-transfer" || receipt.operationID !== operationID ||
        receipt.runID !== runID || !manifests.has(receipt.containerID) || !Number.isFinite(receipt.observedAt))
      throw Error("Delivery receipt identity requires reconciliation.");
    if (accounted.has(receipt.containerID)) return;
    accounted.add(receipt.containerID);
    lastDelivery = Math.max(lastDelivery ?? 0, receipt.observedAt);
    if (!receipt.deliveryBatches?.length) unknownTrips = true;
    for (const batch of receipt.deliveryBatches ?? []) addBatch(receipt.shipID, batch, true);
  };
  for (const receipt of record?.deliveryReceipts ?? []) addReceipt(receipt);
  for (const name of names) {
    const entry = storage.document(name).read() as ArchivedDelivery | null;
    if (!entry?.manifest?.delivered || entry.manifest.operationID !== operationID ||
        entry.manifest.runID !== runID || entry.receipt?.containerID !== entry.manifest.containerID)
      throw Error("Archived delivery identity requires reconciliation.");
    if (!manifests.has(entry.manifest.containerID)) manifests.set(entry.manifest.containerID, entry.manifest);
    addReceipt(entry.receipt);
  }
  // A dock can finish before the last part of a can is collected. Count
  // settled dock transfers even while that can's trip journal is still open.
  for (const name of storage.documentNames(keyPrefix(haulPrefix, [operationID, runID]))) {
    const [, , containerID, , , shipID] = JSON.parse(name.slice(haulPrefix.length)) as [string, string, number, number, number, number];
    const journal = storage.document(name).read() as {
      events?: readonly { kind: string; before: NativeDeliveryBatch; after?: Partial<NativeDeliveryBatch> }[];
    } | null;
    for (const event of journal?.events ?? []) {
      if (event.kind !== "delivery" || !event.after?.sourceAfter || !event.after.destinationAfter) continue;
      const batch = { ...event.before, ...event.after };
      // The archived can receipt omits a dock batch with no share for that can.
      if (accounted.has(containerID) && batch.items?.length !== 0) continue;
      addBatch(shipID, batch, manifests.has(containerID));
    }
  }

  const unitsByType: Record<string, number> = {};
  const volumeByType = new Map<number, number>();
  let deliveredVolumeM3: number | null = 0, deliveredUnits = 0, selfUnloadTrips = 0;
  for (const manifest of record?.manifests ?? [])
    for (const item of manifest.items) volumeByType.set(item.typeID, item.unitVolumeM3);
  for (const { volumeM3, items } of manifests.values()) {
    if (!Number.isFinite(volumeM3) || volumeM3 < 0 || !Array.isArray(items))
      throw Error("Delivered freight totals require reconciliation.");
    deliveredVolumeM3 += volumeM3;
    for (const { typeID, quantity, unitVolumeM3 } of items) {
      unitsByType[typeID] = (unitsByType[typeID] ?? 0) + quantity;
      deliveredUnits += quantity;
      volumeByType.set(typeID, unitVolumeM3);
    }
  }
  for (const [typeID, quantity] of freightAdjustment) {
    if (!quantity) continue;
    const unitVolumeM3 = volumeByType.get(typeID);
    deliveredVolumeM3 = deliveredVolumeM3 === null || unitVolumeM3 === undefined
      ? null : deliveredVolumeM3 + quantity * unitVolumeM3;
    unitsByType[typeID] = (unitsByType[typeID] ?? 0) + quantity;
    deliveredUnits += quantity;
  }
  for (const totals of selfUnloads) {
    selfUnloadTrips += totals.trips;
    deliveredVolumeM3 = deliveredVolumeM3 === null || totals.volumeM3 === null ? null : deliveredVolumeM3 + totals.volumeM3;
    for (const [typeID, quantity] of Object.entries(totals.unitsByType)) {
      unitsByType[typeID] = (unitsByType[typeID] ?? 0) + quantity;
      deliveredUnits += quantity;
    }
  }
  return {
    runID, observedAt: observedAt ?? lastDelivery, deliveredContainers: manifests.size,
    deliveredUnits, deliveredVolumeM3, unitsByType,
    trips: unknownTrips || accounted.size < manifests.size ? null : visits.size + selfUnloadTrips,
  } satisfies FleetRunResult;
}

/** Called within execution retirement. Reduce old proofs one at a time. */
export function retainFleetRunResult(storage: FleetOperationDocuments, operationID: string, runID: string,
  record: LegacyOperation | null, observedAt: number | null, selfUnloads: readonly SelfUnloadTotals[] = []) {
  const prefix = keyPrefix(receiptPrefix, [operationID, runID]);
  if (fleetRunResult(storage, operationID, runID)) {
    storage.deleteDocuments([], [prefix]);
    return;
  }
  const result = summarizeFleetRun(storage, operationID, runID, record, observedAt, selfUnloads);
  if (!result) return;
  storage.document(resultPrefix + JSON.stringify([operationID, runID])).write(result);
  const latest = fleetRunResult(storage, operationID);
  if (!latest || (result.observedAt ?? -Infinity) >= (latest.observedAt ?? -Infinity))
    storage.document(resultPrefix + JSON.stringify([operationID])).write(result);
  storage.deleteDocuments([], [prefix]);
}
