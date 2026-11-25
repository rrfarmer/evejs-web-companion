import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import { decodeFlightStatus, getFlightStatus } from "../../../../web/src/plugin-api/flying.ts";
import { readNativeShipHolds, type NativeInventoryRow } from "../../shared/nativeInventory.ts";
import { createRawTypeFacts } from "../typeFacts.ts";
import type { SynchronousStore } from "../targetBoard.ts";
import type { CompressionFacilityProof } from "./compressionFacility.ts";

type Item = { itemID: number; typeID: number; quantity: number; flagID: number };
type Pending = {
  item: Item;
  facility: CompressionFacilityProof;
  before: readonly NativeInventoryRow[];
  rawUnitVolumeM3: number;
  compressedUnitVolumeM3: number;
  issuedAt: number;
  acknowledged: boolean;
  response: unknown | null;
  error: string | null;
};
export type CompressionReceipt = {
  item: Item;
  output: { itemID: number; typeID: number; quantity: number; flagID: number };
  facility: CompressionFacilityProof;
  before: readonly NativeInventoryRow[];
  after: readonly NativeInventoryRow[];
  rawUnitVolumeM3: number;
  compressedUnitVolumeM3: number;
  issuedAt: number;
  observedAt: number;
  acknowledged: boolean;
  response: unknown | null;
};
type State = {
  version: 1;
  identity: string;
  pending: Pending | null;
  receipts: CompressionReceipt[];
  notDispatched?: {
    pending: Pending;
    outcome: "STOP_BEFORE_DISPATCH";
    recordedAt: number;
    reason: string;
  }[];
};
const id = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const clone = <T>(x: T): T => structuredClone(x);
const same = (a: NativeInventoryRow, b: NativeInventoryRow) =>
  a.itemID === b.itemID &&
  a.typeID === b.typeID &&
  a.quantity === b.quantity &&
  a.ownerID === b.ownerID &&
  a.locationID === b.locationID &&
  a.flagID === b.flagID &&
  a.categoryID === b.categoryID;
/** Miner-owned single-stack native compression. Pending mutations are never repeated. */
export function createCompressionController(config: {
  operationID: string;
  runID: string;
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
  session: PilotSession;
  shipID: number;
  systemID: number;
  reconcileSystemID?: number;
  document: SynchronousStore;
  facility: (sourceTypeID: number) => Promise<CompressionFacilityProof>;
  current: () => void;
  beforeDispatch?: () => void;
}) {
  const { run, session, current, shipID, document } = config;
  if (
    !config.operationID ||
    !config.runID ||
    !id(run.characterID) ||
    !id(shipID) ||
    !id(config.systemID)
  )
    throw Error("Compression custody identity is invalid.");
  const identity = JSON.stringify([
    config.operationID,
    config.runID,
    run.characterID,
    shipID,
    config.systemID,
  ]);
  const validPending = (p: Pending) => {
    if (
      !p ||
      !p.item ||
      ![p.item.itemID, p.item.typeID, p.item.quantity].every(id) ||
      ![5, 134, 181, 182].includes(p.item.flagID) ||
      !p.facility ||
      p.facility.operationID !== config.operationID ||
      p.facility.runID !== config.runID ||
      p.facility.minerCharacterID !== run.characterID ||
      p.facility.minerShipID !== shipID ||
      p.facility.systemID !== config.systemID ||
      p.facility.sourceTypeID !== p.item.typeID ||
      !id(p.facility.compressedTypeID) ||
      p.facility.compressedTypeID === p.item.typeID ||
      !id(p.facility.commanderShipID) ||
      !id(p.facility.claimGeneration) ||
      typeof p.facility.claimKey !== "string" ||
      !p.facility.claimKey ||
      !Number.isSafeInteger(p.issuedAt) ||
      p.issuedAt <= 0 ||
      typeof p.acknowledged !== "boolean" ||
      !(p.error === null || typeof p.error === "string") ||
      !(p.rawUnitVolumeM3 > 0) ||
      !(p.compressedUnitVolumeM3 > 0) ||
      !Array.isArray(p.before) ||
      new Set(p.before.map((r) => r?.itemID)).size !== p.before.length ||
      p.before.some(
        (r) =>
          !r ||
          ![r.itemID, r.typeID, r.quantity].every(id) ||
          r.ownerID !== run.characterID ||
          r.locationID !== shipID ||
          ![5, 134, 135, 181, 182].includes(r.flagID),
      )
    )
      return false;
    return p.before.some(
      (r) =>
        r.itemID === p.item.itemID &&
        r.typeID === p.item.typeID &&
        r.quantity === p.item.quantity &&
        r.flagID === p.item.flagID,
    );
  };
  const raw = document.read() as State | null;
  let state: State;
  if (raw === null) state = { version: 1, identity, pending: null, receipts: [] };
  else if (
    !raw ||
    raw.version !== 1 ||
    raw.identity !== identity ||
    !Array.isArray(raw.receipts) ||
    raw.receipts.some(
      (r) =>
        !r ||
        !r.item ||
        !id(r.item.itemID) ||
        !r.output ||
        r.output.itemID !== r.item.itemID ||
        !id(r.output.typeID) ||
        r.output.quantity !== r.item.quantity ||
        !Number.isFinite(r.observedAt),
    ) ||
    !(raw.pending === null || validPending(raw.pending))
  )
    throw Error("Compression journal requires reconciliation.");
  else state = clone(raw);
  const save = (next: State) => {
    current();
    document.write(clone(next));
    state = clone(next);
  };
  const flight = async () => {
    current();
    const f = decodeFlightStatus(
      (
        await getFlightStatus({
          ...session.flow.requestOptions(),
          baseUrl: run.baseUrl,
          fetch: run.fetch,
        })
      ).flight,
    );
    current();
    if (
      f.shipID !== shipID ||
      f.solarSystemID !== (config.reconcileSystemID ?? config.systemID) ||
      f.docked === f.inSpace ||
      (f.transition && f.transition.phase !== "ready") ||
      (f.docked && !(f.stationID ?? f.structureID))
    )
      throw Error("Compression held flight is uncertain.");
    return f;
  };
  const holds = async () => {
    const a = await flight(),
      rows = await readNativeShipHolds(session, current, run.characterID, shipID),
      b = await flight();
    if (
      a.inSpace !== b.inSpace ||
      a.docked !== b.docked ||
      a.stationID !== b.stationID ||
      a.structureID !== b.structureID
    )
      throw Error("Compression flight changed during inventory read.");
    return rows;
  };
  const facts = createRawTypeFacts(run, current);
  const reconcile = async () => {
    current();
    const p = state.pending;
    if (!p) return null;
    if (
      !p.item ||
      !id(p.item.itemID) ||
      !id(p.item.typeID) ||
      !id(p.item.quantity) ||
      !p.facility ||
      !id(p.facility.compressedTypeID) ||
      !Array.isArray(p.before)
    )
      throw Error("Compression journal requires reconciliation.");
    const after = await holds();
    current();
    const original = p.before.find((r) => r.itemID === p.item.itemID),
      output = after.find((r) => r.itemID === p.item.itemID),
      unchanged = p.before.filter((r) => r.itemID !== p.item.itemID);
    if (
      !original ||
      original.typeID !== p.item.typeID ||
      original.quantity !== p.item.quantity ||
      original.flagID !== p.item.flagID ||
      original.ownerID !== run.characterID ||
      original.locationID !== shipID ||
      !output ||
      output.typeID !== p.facility.compressedTypeID ||
      output.quantity !== p.item.quantity ||
      output.ownerID !== run.characterID ||
      output.locationID !== shipID ||
      output.flagID !== p.item.flagID ||
      after.length !== p.before.length ||
      unchanged.some((r) => !after.some((x) => same(r, x)))
    )
      return null;
    const receipt: CompressionReceipt = {
      item: clone(p.item),
      output: {
        itemID: output.itemID,
        typeID: output.typeID,
        quantity: output.quantity,
        flagID: output.flagID,
      },
      facility: clone(p.facility),
      before: clone(p.before),
      after: clone(after),
      rawUnitVolumeM3: p.rawUnitVolumeM3,
      compressedUnitVolumeM3: p.compressedUnitVolumeM3,
      issuedAt: p.issuedAt,
      observedAt: Date.now(),
      acknowledged: p.acknowledged,
      response: clone(p.response),
    };
    save({ ...state, pending: null, receipts: [...state.receipts, receipt] });
    return receipt;
  };
  let busy = false;
  return {
    snapshot: () => clone(state),
    async reconcile() {
      if (busy) throw Error("Compression action is already in progress.");
      busy = true;
      try {
        return await reconcile();
      } finally {
        busy = false;
      }
    },
    async compress(itemID: number) {
      if (config.reconcileSystemID !== undefined)
        throw Error("Read-only retained reconciliation cannot dispatch compression.");
      if (busy) throw Error("Compression action is already in progress.");
      busy = true;
      try {
        current();
        if (state.pending) throw Error("Prior compression outcome is unresolved; no replay.");
        if (!id(itemID)) throw Error("Compression item identity is invalid.");
        const before = await holds();
        current();
        const row = before.find((x) => x.itemID === itemID);
        if (
          !row ||
          row.ownerID !== run.characterID ||
          row.locationID !== shipID ||
          ![5, 134, 181, 182].includes(row.flagID)
        )
          throw Error("Exact own compression stack is unavailable.");
        const checkProof = (p: CompressionFacilityProof) => {
          if (
            !p ||
            p.operationID !== config.operationID ||
            p.runID !== config.runID ||
            p.minerCharacterID !== run.characterID ||
            p.minerShipID !== shipID ||
            p.systemID !== config.systemID ||
            p.sourceTypeID !== row.typeID ||
            !id(p.commanderCharacterID) ||
            !id(p.commanderShipID) ||
            !id(p.coreModuleID) ||
            !id(p.compressorModuleID) ||
            !id(p.compressorEffectID) ||
            !id(p.systemID) ||
            !id(p.claimGeneration) ||
            typeof p.claimKey !== "string" ||
            !p.claimKey ||
            !id(p.compressedTypeID) ||
            p.compressedTypeID === row.typeID ||
            !Number.isFinite(p.observedAt) ||
            p.observedAt > Date.now() + 5000 ||
            Date.now() - p.observedAt > 60000 ||
            !Number.isFinite(p.sceneSampledAt) ||
            !Number.isFinite(p.rangeMeters) ||
            !Number.isFinite(p.surfaceDistanceMeters) ||
            p.rangeMeters <= 0 ||
            p.surfaceDistanceMeters < 0 ||
            p.surfaceDistanceMeters > p.rangeMeters ||
            !Array.isArray(p.facilityTypeListIDs) ||
            !p.facilityTypeListIDs.length ||
            !Array.isArray(p.matchingTypeListIDs) ||
            p.matchingTypeListIDs.length !== p.facilityTypeListIDs.length ||
            p.facilityTypeListIDs.some((x) => !id(x) || !p.matchingTypeListIDs.includes(x))
          )
            throw Error("Compression facility proof is invalid.");
        };
        const first = await config.facility(row.typeID);
        current();
        checkProof(first);
        const typeFacts = await facts([row.typeID, first.compressedTypeID]);
        current();
        const source = typeFacts[row.typeID],
          output = typeFacts[first.compressedTypeID];
        if (
          !source ||
          source.freightKind !== "RAW" ||
          !["ore", "ice"].includes(source.resourceFamily ?? "") ||
          !output ||
          output.categoryID !== 25 ||
          output.freightKind !== "COMPRESSED" ||
          !(source.unitVolumeM3 > 0) ||
          !(output.unitVolumeM3 > 0)
        )
          throw Error("Native raw or compressed type facts are unavailable.");
        const facility = await config.facility(row.typeID);
        current();
        checkProof(facility);
        if (
          facility.commanderCharacterID !== first.commanderCharacterID ||
          facility.systemID !== first.systemID ||
          facility.operationID !== config.operationID ||
          facility.runID !== config.runID ||
          facility.minerCharacterID !== run.characterID ||
          facility.minerShipID !== shipID ||
          facility.claimKey !== first.claimKey ||
          facility.claimGeneration !== first.claimGeneration ||
          facility.commanderShipID !== first.commanderShipID ||
          facility.compressedTypeID !== first.compressedTypeID
        )
          throw Error("Compression facility identity changed.");
        const item = {
          itemID: row.itemID,
          typeID: row.typeID,
          quantity: row.quantity,
          flagID: row.flagID,
        };
        config.beforeDispatch?.();
        const pending: Pending = {
          item,
          facility: clone(facility),
          before: clone(before),
          rawUnitVolumeM3: source.unitVolumeM3,
          compressedUnitVolumeM3: output.unitVolumeM3,
          issuedAt: Date.now(),
          acknowledged: false,
          response: null,
          error: null,
        };
        save({ ...state, pending });
        current();
        try {
          config.beforeDispatch?.();
        } catch (error) {
          current();
          save({
            ...state,
            pending: null,
            notDispatched: [
              ...(state.notDispatched ?? []),
              {
                pending: clone(pending),
                outcome: "STOP_BEFORE_DISPATCH",
                recordedAt: Date.now(),
                reason: error instanceof Error ? error.message : String(error),
              },
            ],
          });
          throw error;
        }
        current();
        try {
          const response = await session.flow.flying.bridgeDo(
            "inSpaceCompressionMgr",
            "CompressItemInSpace",
            [item.itemID, facility.commanderShipID],
          );
          current();
          save({
            ...state,
            pending: { ...pending, acknowledged: true, response: response ?? null },
          });
        } catch (error) {
          current();
          save({
            ...state,
            pending: { ...pending, error: error instanceof Error ? error.message : String(error) },
          });
        }
        return await reconcile();
      } finally {
        busy = false;
      }
    },
  };
}
