import type { FleetDelivery } from "./delivery.ts";
import { targetKey, type Claim, type Target, type createTargetBoard } from "./targetBoard.ts";
import type { ArchivedDelivery, FleetOperationStore } from "./operationStore.ts";
import { provesHaulSource } from "./haulEvidence.ts";
import type { NativeHaulSourceProof, NativeDeliveryBatch } from "./nativeHauler.ts";
import { confirmedDepositItem, movedWholeStacks } from "./dockedRawDeposit.ts";
import type { RawHoldObservation } from "./memberLoops.ts";
type Board = ReturnType<typeof createTargetBoard>;
export type Role = "MINER" | "HAULER" | "COMMAND" | "DEFENDER";
export interface Member {
  readonly characterID: number;
  readonly shipID: number;
  readonly role: Role;
}
export interface TractorBinding {
  readonly moduleID: number;
  readonly typeID: number;
  readonly botID: string;
  readonly sessionGeneration: number;
}
export interface CommandCapabilities {
  readonly characterID: number;
  readonly selfMining: boolean;
  readonly tractor: boolean;
  readonly collect: boolean;
}
export type FreightKind = "RAW" | "COMPRESSED";
export interface ManifestItem {
  readonly itemID: number;
  readonly typeID: number;
  readonly quantity: number;
  readonly freightKind: FreightKind;
  readonly unitVolumeM3: number;
}
export interface JetcanSource {
  readonly source: "checked-ship-holds";
  readonly characterID: number;
  readonly shipID: number;
  readonly systemID: number;
  readonly targetKey: string;
  readonly claimGeneration: number;
  readonly observedAt: number;
  readonly items: readonly {
    itemID: number;
    typeID: number;
    quantity: number;
    ownerID: number;
    locationID: number;
    flagID: number;
  }[];
}
export interface JetcanProof {
  readonly source: "native-jetcan";
  readonly operationID: string;
  readonly runID: string;
  readonly targetKey: string;
  readonly claimGeneration: number;
  readonly characterID: number;
  readonly shipID: number;
  readonly systemID: number;
  readonly containerID: number;
  readonly intentGeneration: number;
  readonly observedAt: number;
  readonly items: readonly ManifestItem[];
  readonly capacityM3: number;
}
export type GridJetcan = {
  readonly containerID: number;
  readonly ownerID: number;
  readonly observedAt: number;
  readonly capacityM3: number;
  readonly items: readonly ManifestItem[];
};
export type Manifest = (
  | JetcanProof
  | (Omit<JetcanProof, "source" | "shipID" | "intentGeneration"> & {
      readonly source: "observed-jetcan";
      readonly shipID: null;
      readonly intentGeneration: null;
    })
) & {
  readonly category: FreightKind;
  readonly volumeM3: number;
  readonly delivered: boolean;
  readonly deliveredAt?: number;
  /** The source is closed. Keep the existing trip journal reachable until its carried freight is settled. */
  readonly closedPickup?: { readonly characterID: number; readonly generation: number };
};
export type DeliveryEvidence = {
  source: "native-transfer";
  operationID: string;
  runID: string;
  containerID: number;
  claimGeneration: number;
  shipID: number;
  destinationID: number;
  destinationBefore: readonly { typeID: number; quantity: number }[];
  destinationAfter: readonly { typeID: number; quantity: number }[];
  deliveryBatches?: readonly NativeDeliveryBatch[];
  observedAt: number;
} & (
  | { sourceAfter: readonly { typeID: number; quantity: number }[]; sourceProof?: never }
  | { sourceProof: NativeHaulSourceProof; sourceAfter?: never }
);
export type OfflineParking = {
  characterID: number;
  shipID: number;
  locationID: number;
  systemID: number;
  kind: "station" | "structure";
  atPlannedDock: boolean;
  observedAt: number;
};
export interface OperationRecord {
  readonly version: 1;
  readonly operationID: string;
  readonly runID: string;
  readonly systemID: number;
  readonly destinationID: number;
  readonly members: readonly Member[];
  readonly commandCapabilities?: CommandCapabilities;
  readonly commandMiningFinal?: {
    readonly characterID: number;
    readonly shipID: number;
    readonly observedAt: number;
  };
  readonly haulMode?: "SELF_UNLOAD";
  readonly selfUnloadFinal?: Readonly<
    Record<string, { characterID: number; shipID: number; observedAt: number }>
  >;
  readonly state: "READY" | "ACTIVE" | "DRAINING" | "SETTLING" | "PARKING" | "STOPPED";
  readonly claim: Claim | null;
  readonly relocationHistory?: readonly {
    oldClaim: Claim;
    oldBeltID?: number;
    freightScanPending?: true;
    next: Target;
    newClaim: Claim;
    movingCharacterIDs?: readonly number[];
    proofs: readonly {
      characterID: number;
      shipID: number;
      source: "native-flight";
      systemID: number;
      inSpace: boolean;
      docked: boolean;
      observedAt: number;
    }[];
    completedAt: number;
  }[];
  readonly relocatedKeys?: readonly string[];
  readonly relocation?: {
    readonly next: Target;
    readonly oldBeltID?: number;
    readonly freightScanPending?: true;
    readonly movingCharacterIDs?: readonly number[];
    readonly phase: "PREPARING" | "DRAINING" | "RELEASING" | "RESERVING";
    readonly oldClaim: Claim;
    readonly proofs?: readonly {
      characterID: number;
      shipID: number;
      source: "native-flight";
      systemID: number;
      inSpace: boolean;
      docked: boolean;
      observedAt: number;
    }[];
  };
  readonly manifests: readonly Manifest[];
  readonly haulGeneration: number;
  readonly jetcanGeneration: number;
  readonly jetcanIntents: Readonly<
    Record<
      string,
      {
        readonly generation: number;
        readonly category: FreightKind;
        readonly items: readonly ManifestItem[];
        readonly capacityM3: number;
        readonly dispatched: boolean;
        readonly before?: RawHoldObservation;
      }
    >
  >;
  readonly jetcanCooldowns?: Readonly<
    Record<
      string,
      {
        readonly generation: number;
        readonly refusedAt: number;
        readonly retryAt: number;
        readonly outcome: "NATIVE_COOLDOWN";
      }
    >
  >;
  readonly jetcanRefusals?: readonly {
    readonly characterID: number;
    readonly generation: number;
    readonly refusedAt: number;
    readonly outcome: "NATIVE_COOLDOWN";
  }[];
  readonly haulClaims: Readonly<
    Record<
      string,
      {
        readonly characterID: number;
        readonly generation: number;
        readonly dispatched: boolean;
        readonly purpose?: "haul" | "tractor";
        readonly issuedAt?: number;
        readonly tractorBinding?: TractorBinding;
      }
    >
  >;
  readonly settled: readonly number[];
  readonly settledAt: Readonly<Record<string, number>>;
  readonly parked: readonly number[];
  readonly stopRequested?: true;
  readonly stopFreight?: StopFreightMode;
  readonly offlineStopRequested?: true;
  readonly stoppedBeforeWork?: true;
  readonly unstartedFinish?: { receiptHash: string };
  readonly neverStarted?: readonly number[];
  readonly stayed?: readonly number[];
  readonly stopMode?: "STAY_IN_PLACE";
  readonly offlineParking?: Readonly<Record<string, OfflineParking>>;
}
export type StopFreightMode = "RETURN_HOME" | "COLLECT_FREIGHT";
type HaulOwnership = OperationRecord["haulClaims"][string];
export function haulOwner(
  record: Pick<OperationRecord, "haulClaims">,
  manifest: Manifest,
): HaulOwnership | undefined {
  return (
    record.haulClaims[String(manifest.containerID)] ??
    (manifest.closedPickup && { ...manifest.closedPickup, dispatched: true })
  );
}
export function hasHaulWork(
  record: Pick<OperationRecord, "haulClaims" | "manifests">,
  characterID?: number,
  dispatched = false,
) {
  return (
    Object.values(record.haulClaims).some(
      (c) =>
        (characterID === undefined || c.characterID === characterID) &&
        (!dispatched || c.dispatched),
    ) ||
    record.manifests.some(
      (m) =>
        m.closedPickup !== undefined &&
        (characterID === undefined || m.closedPickup.characterID === characterID),
    )
  );
}
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const clone = <T>(v: T): T => structuredClone(v);
const sameTractorBinding = (a: TractorBinding | undefined, b: TractorBinding | undefined) =>
  !!a &&
  !!b &&
  a.moduleID === b.moduleID &&
  a.typeID === b.typeID &&
  a.botID === b.botID &&
  a.sessionGeneration === b.sessionGeneration;
const nativeFiletime = (v: unknown) =>
  typeof v === "string" &&
  /^\d+$/.test(v) &&
  BigInt(v) > 116444736000000000n &&
  BigInt(v) <= 9223372036854775807n;
function roster(members: readonly Member[], haulMode?: "SELF_UNLOAD") {
  if (
    !Array.isArray(members) ||
    members.length < (haulMode === "SELF_UNLOAD" ? 1 : 2) ||
    members.some(
      (m) =>
        !m ||
        !valid(m.characterID) ||
        !valid(m.shipID) ||
        !["MINER", "HAULER", "COMMAND", "DEFENDER"].includes(m.role),
    ) ||
    new Set(members.map((m) => m.characterID)).size !== members.length ||
    new Set(members.map((m) => m.shipID)).size !== members.length ||
    !members.some((m) => m.role === "MINER") ||
    (haulMode === "SELF_UNLOAD"
      ? members.some((m) => m.role !== "MINER" && m.role !== "DEFENDER" && m.role !== "COMMAND")
      : !members.some((m) => m.role === "HAULER")) ||
    members.filter((m) => m.role === "COMMAND").length > 1
  )
    throw new Error("Roster is invalid for the selected hauling policy.");
}
function relocationMembers(
  members: readonly Member[],
  relocation: { oldBeltID?: number; movingCharacterIDs?: readonly number[] },
) {
  const eligible = relocation.oldBeltID ? members.filter((m) => m.role !== "HAULER") : members;
  const ids = relocation.movingCharacterIDs;
  if (!ids) return eligible;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !eligible.some((m) => m.characterID === id)) ||
    !eligible.some((m) => m.role === "MINER" && ids.includes(m.characterID))
  )
    throw Error("Relocation roster is invalid.");
  return eligible.filter((m) => ids.includes(m.characterID));
}
/** Persistent operation authority; run/ship and target claim fence every assignment. */
export function createOperation(
  store: FleetOperationStore,
  board: Board,
  definition: {
    operationID: string;
    runID: string;
    systemID: number;
    destinationID: number;
    delivery?: FleetDelivery;
    members: readonly Member[];
    commandCapabilities?: CommandCapabilities;
    haulMode?: "SELF_UNLOAD";
    stopMode?: "STAY_IN_PLACE";
  },
  now: () => number = Date.now,
) {
  roster(definition.members, definition.haulMode);
  const caps = definition.commandCapabilities ? clone(definition.commandCapabilities) : undefined;
  if (
    caps &&
    (Object.keys(caps).sort().join(",") !== "characterID,collect,selfMining,tractor" ||
      !valid(caps.characterID) ||
      ![caps.selfMining, caps.tractor, caps.collect].every((x) => typeof x === "boolean") ||
      (caps.collect && !caps.tractor) ||
      !definition.members.some((m) => m.role === "COMMAND" && m.characterID === caps.characterID))
  )
    throw Error("Command capabilities are invalid.");
  const producer = (m: Member | undefined | null) =>
    !!m &&
    (m.role === "MINER" ||
      (m.role === "COMMAND" && m.characterID === caps?.characterID && caps.selfMining));
  const hauler = (m: Member | undefined | null) =>
    !!m &&
    (m.role === "HAULER" ||
      (m.role === "COMMAND" && m.characterID === caps?.characterID && caps.collect));
  const tractor = (m: Member | undefined | null) =>
    !!m && m.role === "COMMAND" && m.characterID === caps?.characterID && caps.tractor;
  if (
    !definition.operationID ||
    !definition.runID ||
    !valid(definition.systemID) ||
    !valid(definition.destinationID)
  )
    throw new Error("Invalid mining operation identity.");
  const saved = store.read();
  let state: OperationRecord;
  if (saved === null) {
    state = {
      version: 1,
      ...clone(definition),
      state: "READY",
      claim: null,
      manifests: [],
      haulGeneration: 0,
      haulClaims: {},
      jetcanGeneration: 0,
      jetcanIntents: {},
      settled: [],
      settledAt: {},
      parked: [],
    };
    store.write(clone(state));
  } else {
    const row = saved as OperationRecord;
    if (
      !row ||
      row.version !== 1 ||
      row.operationID !== definition.operationID ||
      row.runID !== definition.runID ||
      row.systemID !== definition.systemID ||
      row.destinationID !== definition.destinationID ||
      JSON.stringify((row as OperationRecord & { delivery?: FleetDelivery }).delivery ?? null) !==
        JSON.stringify(definition.delivery ?? null) ||
      row.haulMode !== definition.haulMode ||
      row.stopMode !== definition.stopMode ||
      JSON.stringify(row.commandCapabilities ?? null) !==
        JSON.stringify(definition.commandCapabilities ?? null) ||
      JSON.stringify(row.members) !== JSON.stringify(definition.members) ||
      !["READY", "ACTIVE", "DRAINING", "SETTLING", "PARKING", "STOPPED"].includes(row.state) ||
      !Array.isArray(row.manifests) ||
      !Number.isSafeInteger(row.jetcanGeneration) ||
      row.jetcanGeneration < 0 ||
      !row.jetcanIntents ||
      typeof row.jetcanIntents !== "object" ||
      Array.isArray(row.jetcanIntents) ||
      !Number.isSafeInteger(row.haulGeneration) ||
      row.haulGeneration < 0 ||
      !row.haulClaims ||
      typeof row.haulClaims !== "object" ||
      Array.isArray(row.haulClaims) ||
      !Array.isArray(row.settled) ||
      !row.settledAt ||
      typeof row.settledAt !== "object" ||
      Array.isArray(row.settledAt) ||
      !Array.isArray(row.parked)
    )
      throw new Error("Operation custody requires reconciliation.");
    if (
      new Set(row.manifests.map((m) => m.containerID)).size !== row.manifests.length ||
      row.manifests.some(
        (m) =>
          !m ||
          m.operationID !== row.operationID ||
          m.runID !== row.runID ||
          !valid(m.containerID) ||
          (m.source === "observed-jetcan"
            ? m.shipID !== null || m.intentGeneration !== null || !valid(m.characterID)
            : m.source !== "native-jetcan") ||
          !["RAW", "COMPRESSED"].includes(m.category) ||
          typeof m.delivered !== "boolean" ||
          (m.deliveredAt !== undefined && (!m.delivered || !Number.isFinite(m.deliveredAt))) ||
          (m.closedPickup !== undefined &&
            (!m.closedPickup ||
              m.delivered ||
              !!row.haulClaims[String(m.containerID)] ||
              !valid(m.closedPickup.generation) ||
              m.closedPickup.generation > row.haulGeneration ||
              !row.members.some(
                (p) => p.characterID === m.closedPickup!.characterID && p.role === "HAULER",
              ))) ||
          !Array.isArray(m.items) ||
          !m.items.length ||
          m.items.some(
            (i: ManifestItem) =>
              !valid(i.itemID) ||
              !valid(i.typeID) ||
              !valid(i.quantity) ||
              i.freightKind !== m.category ||
              !Number.isFinite(i.unitVolumeM3) ||
              i.unitVolumeM3 <= 0,
          ),
      ) ||
      Object.entries(row.haulClaims).some(
        ([key, c]) =>
          !valid(Number(key)) ||
          !c ||
          !valid(c.characterID) ||
          !valid(c.generation) ||
          c.generation > row.haulGeneration ||
          typeof c.dispatched !== "boolean" ||
          ![undefined, "haul", "tractor"].includes(c.purpose) ||
          (c.purpose === "tractor"
            ? !tractor(row.members.find((m) => m.characterID === c.characterID)) ||
              !valid(c.issuedAt) ||
              c.dispatched ||
              !c.tractorBinding ||
              !valid(c.tractorBinding.moduleID) ||
              !valid(c.tractorBinding.typeID) ||
              typeof c.tractorBinding.botID !== "string" ||
              !c.tractorBinding.botID ||
              !Number.isSafeInteger(c.tractorBinding.sessionGeneration) ||
              c.tractorBinding.sessionGeneration < 0
            : !hauler(row.members.find((m) => m.characterID === c.characterID))) ||
          !row.manifests.some((m) => m.containerID === Number(key) && !m.delivered),
      ) ||
      (row.jetcanCooldowns !== undefined &&
        (!row.jetcanCooldowns ||
          typeof row.jetcanCooldowns !== "object" ||
          Array.isArray(row.jetcanCooldowns) ||
          Object.entries(row.jetcanCooldowns).some(
            ([key, x]) =>
              !producer(row.members.find((m) => m.characterID === Number(key))) ||
              !x ||
              x.outcome !== "NATIVE_COOLDOWN" ||
              !valid(x.generation) ||
              x.generation > row.jetcanGeneration ||
              !Number.isFinite(x.refusedAt) ||
              x.retryAt !== x.refusedAt + 180_000,
          ))) ||
      (row.jetcanRefusals !== undefined &&
        (!Array.isArray(row.jetcanRefusals) ||
          row.jetcanRefusals.some(
            (x) =>
              !x ||
              !producer(row.members.find((m) => m.characterID === x.characterID)) ||
              x.outcome !== "NATIVE_COOLDOWN" ||
              !valid(x.generation) ||
              x.generation > row.jetcanGeneration ||
              !Number.isFinite(x.refusedAt),
          ))) ||
      Object.entries(row.jetcanIntents).some(
        ([key, i]) =>
          !valid(Number(key)) ||
          !i ||
          !valid(i.generation) ||
          i.generation > row.jetcanGeneration ||
          typeof i.dispatched !== "boolean" ||
          !["RAW", "COMPRESSED"].includes(i.category) ||
          !Array.isArray(i.items) ||
          !i.items.length ||
          !Number.isFinite(i.capacityM3) ||
          i.capacityM3 <= 0 ||
          !producer(row.members.find((m) => m.characterID === Number(key))) ||
          (i.before !== undefined &&
            (!i.before ||
              i.before.source?.source !== "checked-ship-holds" ||
              i.before.source.characterID !== Number(key) ||
              i.before.source.shipID !==
                row.members.find((m) => m.characterID === Number(key))?.shipID ||
              i.before.source.targetKey !== row.claim?.key ||
              i.before.source.claimGeneration !== row.claim?.generation ||
              i.before.source.systemID !== row.systemID ||
              !Number.isFinite(i.before.source.observedAt) ||
              !Array.isArray(i.before.source.items) ||
              JSON.stringify(i.before.items) !== JSON.stringify(i.items) ||
              i.before.capacityM3 !== i.capacityM3 ||
              !i.before.facts ||
              !Number.isFinite(i.before.sceneSampledAt) ||
              !Array.isArray(i.before.existingContainerIDs) ||
              i.before.existingContainerIDs.some((id) => !valid(id)) ||
              new Set(i.before.existingContainerIDs).size !==
                i.before.existingContainerIDs.length)),
      ) ||
      (row.stayed !== undefined &&
        (!Array.isArray(row.stayed) ||
          new Set(row.stayed).size !== row.stayed.length ||
          row.stayed.some((id) => !row.settled.includes(id) || row.parked.includes(id)) ||
          row.stopMode !== "STAY_IN_PLACE")) ||
      new Set(row.settled).size !== row.settled.length ||
      new Set(row.parked).size !== row.parked.length ||
      row.settled.some((id) => !Number.isFinite(row.settledAt[String(id)])) ||
      row.parked.some((id) => !row.settled.includes(id)) ||
      row.settled.some((id) => !row.members.some((m) => m.characterID === id)) ||
      row.parked.some((id) => !row.members.some((m) => m.characterID === id))
    )
      throw new Error("Operation evidence is malformed; reconciliation is required.");
    if (row.stopRequested !== undefined && row.stopRequested !== true)
      throw Error("Stop request evidence is invalid.");
    if (
      row.stopFreight !== undefined &&
      (!row.stopRequested || !["RETURN_HOME", "COLLECT_FREIGHT"].includes(row.stopFreight))
    )
      throw Error("Stop freight choice is invalid.");
    if (
      row.offlineStopRequested !== undefined &&
      (row.offlineStopRequested !== true || !row.stopRequested || !row.stopFreight)
    )
      throw Error("Offline Stop request evidence is invalid.");
    if (
      row.commandMiningFinal !== undefined &&
      (!caps?.selfMining ||
        row.commandMiningFinal.characterID !== caps.characterID ||
        !row.members.some(
          (m) =>
            m.role === "COMMAND" &&
            m.characterID === caps.characterID &&
            m.shipID === row.commandMiningFinal!.shipID,
        ) ||
        !Number.isFinite(row.commandMiningFinal.observedAt) ||
        !(
          ["DRAINING", "SETTLING", "PARKING", "STOPPED"].includes(row.state) ||
          (row.state === "ACTIVE" && row.stopRequested)
        ))
    )
      throw Error("Command final hold evidence requires reconciliation.");
    if (
      row.relocationHistory !== undefined &&
      (!Array.isArray(row.relocationHistory) ||
        row.relocationHistory.length > 128 ||
        row.relocationHistory.some(
          (h) =>
            !h ||
            !h.oldClaim ||
            !h.newClaim ||
            (h.oldBeltID !== undefined && !valid(h.oldBeltID)) ||
            h.oldClaim.operationID !== row.operationID ||
            h.newClaim.operationID !== row.operationID ||
            h.oldClaim.runID !== row.runID ||
            h.newClaim.runID !== row.runID ||
            h.newClaim.key !== targetKey(h.next) ||
            !Array.isArray(h.proofs) ||
            h.proofs.length !== relocationMembers(row.members, h).length ||
            new Set(h.proofs.map((p: { characterID: number }) => p?.characterID)).size !==
              h.proofs.length ||
            h.proofs.some(
              (p: { characterID: number; shipID: number }) =>
                !relocationMembers(row.members, h).some(
                  (m) => m.characterID === p?.characterID && m.shipID === p.shipID,
                ),
            ) ||
            !Number.isFinite(h.completedAt),
        ))
    )
      throw Error("Relocation history requires reconciliation.");
    if (
      row.relocatedKeys !== undefined &&
      (!Array.isArray(row.relocatedKeys) ||
        row.relocatedKeys.some((k) => typeof k !== "string" || !k) ||
        new Set(row.relocatedKeys).size !== row.relocatedKeys.length)
    )
      throw Error("Relocated target history requires reconciliation.");
    if (
      row.relocation !== undefined &&
      (!row.relocation ||
        !relocationMembers(row.members, row.relocation).length ||
        (row.relocation.oldBeltID !== undefined && !valid(row.relocation.oldBeltID)) ||
        !["PREPARING", "DRAINING", "RELEASING", "RESERVING"].includes(row.relocation.phase) ||
        !row.relocation.oldClaim ||
        row.relocation.oldClaim.operationID !== row.operationID ||
        row.relocation.oldClaim.runID !== row.runID ||
        targetKey(row.relocation.next) === row.relocation.oldClaim.key ||
        row.relocation.next.systemID !== row.systemID ||
        (["RELEASING", "RESERVING"].includes(row.relocation.phase) &&
          (!Array.isArray(row.relocation.proofs) ||
            row.relocation.proofs.length !==
              relocationMembers(row.members, row.relocation).length ||
            new Set(row.relocation.proofs.map((p) => p?.characterID)).size !==
              row.relocation.proofs.length ||
            row.relocation.proofs.some(
              (p) =>
                !p ||
                p.source !== "native-flight" ||
                !relocationMembers(row.members, row.relocation!).some(
                  (m) => m.characterID === p.characterID && m.shipID === p.shipID,
                ) ||
                !valid(p.systemID) ||
                typeof p.inSpace !== "boolean" ||
                typeof p.docked !== "boolean" ||
                p.inSpace === p.docked ||
                !Number.isFinite(p.observedAt),
            ))) ||
        (row.relocation.phase !== "RESERVING" &&
          (!row.claim ||
            row.claim.key !== row.relocation.oldClaim.key ||
            row.claim.generation !== row.relocation.oldClaim.generation)))
    )
      throw Error("Relocation custody requires reconciliation.");
    if (
      row.haulMode === "SELF_UNLOAD" &&
      (row.manifests.length ||
        Object.keys(row.jetcanIntents).length ||
        Object.keys(row.haulClaims).length)
    )
      throw Error("Self-unload cannot own jetcan freight.");
    if (
      row.selfUnloadFinal !== undefined &&
      (!row.selfUnloadFinal ||
        typeof row.selfUnloadFinal !== "object" ||
        Array.isArray(row.selfUnloadFinal) ||
        Object.entries(row.selfUnloadFinal).some(
          ([id, p]) =>
            row.haulMode !== "SELF_UNLOAD" ||
            !p ||
            p.characterID !== Number(id) ||
            !row.members.some(
              (m) =>
                m.characterID === p.characterID &&
                m.shipID === p.shipID &&
                (m.role === "MINER" || (m.role === "COMMAND" && caps?.selfMining)),
            ) ||
            !Number.isFinite(p.observedAt),
        ))
    )
      throw Error("Self-unload final evidence requires reconciliation.");
    if (
      row.stoppedBeforeWork !== undefined &&
      (row.stoppedBeforeWork !== true ||
        row.claim ||
        row.manifests.length ||
        row.jetcanGeneration ||
        row.haulGeneration ||
        row.relocation ||
        row.relocationHistory?.length ||
        !["SETTLING", "PARKING", "STOPPED"].includes(row.state))
    )
      throw Error("Startup Stop evidence requires reconciliation.");
    if (row.unstartedFinish !== undefined && !Array.isArray(row.neverStarted))
      throw Error("Unstarted recovery receipt is incomplete.");
    if (
      row.neverStarted !== undefined &&
      (!Array.isArray(row.neverStarted) ||
        new Set(row.neverStarted).size !== row.neverStarted.length ||
        row.neverStarted.some(
          (id) =>
            !row.members.some((m) => m.characterID === id) ||
            row.settled.includes(id) ||
            row.parked.includes(id) ||
            row.stayed?.includes(id) ||
            !!row.jetcanIntents[String(id)] ||
            hasHaulWork(row, id) ||
            row.manifests.some((m) => m.characterID === id),
        ) ||
        (row.unstartedFinish
          ? typeof row.unstartedFinish.receiptHash !== "string" ||
            row.claim ||
            row.manifests.length ||
            Object.keys(row.jetcanIntents).length ||
            Object.keys(row.haulClaims).length ||
            row.relocation ||
            row.relocationHistory?.length ||
            !["SETTLING", "PARKING", "STOPPED"].includes(row.state)
          : row.stopRequested !== true || !row.stopFreight))
    )
      throw Error("Unstarted recovery proof requires reconciliation.");
    state = clone(row);
  }
  const commit = (next: OperationRecord, delivery?: ArchivedDelivery) => {
    const saved = clone(next);
    if (delivery) store.recordDelivery(saved, delivery);
    else store.write(saved);
    state = saved;
  };
  const requiredCount = () => state.members.length - (state.neverStarted?.length ?? 0);
  const member = (characterID: number) =>
    state.members.find((m) => m.characterID === characterID) ?? null;
  const authority = () => {
    const c = state.claim;
    if (!c) return null;
    const entry = board.read(c.key);
    return entry?.claim &&
      entry.claim.operationID === state.operationID &&
      entry.claim.runID === state.runID &&
      entry.claim.generation === c.generation
      ? entry
      : null;
  };
  const sameClaim = (a: Claim | null | undefined, b: Claim) =>
    a?.key === b.key &&
    a.generation === b.generation &&
    a.operationID === b.operationID &&
    a.runID === b.runID;
  const movingMembers = () =>
    state.relocation
      ? relocationMembers(state.members, state.relocation).filter(
          (m) => !state.parked.includes(m.characterID),
        )
      : state.members;
  // A belt change clears its own settlement proofs. A member already docked
  // and released from the generation does not move with the mining group.
  const keepDocked = () => ({
    settled: state.parked,
    settledAt: Object.fromEntries(
      state.parked.map((id) => [String(id), state.settledAt[String(id)]!]),
    ),
  });
  function haulTarget(manifest: Manifest) {
    const current =
      state.claim?.key === manifest.targetKey &&
      state.claim.generation === manifest.claimGeneration;
    const tail = state.relocationHistory?.find(
      (h) =>
        h.oldBeltID &&
        h.oldClaim.key === manifest.targetKey &&
        h.oldClaim.generation === manifest.claimGeneration,
    );
    if (!current && !tail) return null;
    if (!tail && !["ACTIVE", "DRAINING"].includes(state.state) && !state.relocation?.oldBeltID)
      return null;
    const row = board.read(manifest.targetKey),
      claim = row?.claim;
    if (
      !row ||
      !claim ||
      claim.operationID !== state.operationID ||
      claim.runID !== state.runID ||
      claim.generation !== manifest.claimGeneration ||
      row.target.systemID !== manifest.systemID ||
      !((row.state === "ACTIVE" && current) || row.state === "DRAINING")
    )
      return null;
    return { target: row.target, claim, oldBeltID: tail?.oldBeltID };
  }
  function updateFreightTails(restore = false) {
    for (const history of state.relocationHistory ?? []) {
      if (!history.oldBeltID) continue;
      const old = history.oldClaim,
        row = board.read(old.key);
      const pending =
        (history.freightScanPending && state.stopFreight !== "RETURN_HOME") ||
        state.manifests.some(
          (m) => !m.delivered && m.targetKey === old.key && m.claimGeneration === old.generation,
        );
      if (
        row?.state === "DEPLETED" ||
        (detachedBelt(old) && (state.stopFreight === "RETURN_HOME" || !pending))
      )
        continue;
      if ((restore || row?.state === "QUARANTINED") && !board.resumeDraining(old)) return false;
      if (pending ? !board.heartbeat(old) : !board.finish(old, undefined, true)) return false;
    }
    return true;
  }
  function freightTailToScan() {
    if (state.stopFreight === "RETURN_HOME" || state.state === "STOPPED") return null;
    for (const history of state.relocationHistory ?? []) {
      if (!history.oldBeltID || !history.freightScanPending) continue;
      const row = board.read(history.oldClaim.key);
      if (row?.state === "DRAINING" && row.claim && sameClaim(row.claim, history.oldClaim))
        return { target: row.target, claim: row.claim };
    }
    return null;
  }
  function finishFreightTailScan(characterID: number, claim: Claim) {
    if (
      !sameClaim(freightTailToScan()?.claim, claim) ||
      !canDiscoverGridFreight(characterID, claim, true)
    )
      return false;
    const relocationHistory = state.relocationHistory?.map((history) =>
      sameClaim(history.oldClaim, claim) ? { ...history, freightScanPending: undefined } : history,
    );
    commit({ ...state, relocationHistory });
    return true;
  }
  const contains = (id: number) => state.manifests.some((m) => m.containerID === id);
  function reserve(characterID: number, target: Target) {
    if (
      state.state !== "READY" ||
      state.stopRequested ||
      member(characterID)?.role !== "MINER" ||
      target.systemID !== state.systemID ||
      state.claim
    )
      return null;
    const claim = board.reserve(state.operationID, state.runID, target);
    if (!claim) return null;
    try {
      commit({ ...state, claim });
    } catch (error) {
      board.releaseReserved(claim);
      throw error;
    }
    return clone(claim);
  }
  function activate(characterID: number) {
    if (
      state.state !== "READY" ||
      state.stopRequested ||
      member(characterID)?.role !== "MINER" ||
      !state.claim ||
      !authority()
    )
      return false;
    // Persist the operation first; a failed board transition leaves no productive assignment.
    if (!board.activate(state.claim)) return false;
    commit({ ...state, state: "ACTIVE" });
    return true;
  }
  function assignment(characterID: number) {
    const m = member(characterID);
    if (!m) return null;
    const target = authority(),
      available = !state.settled.includes(characterID);
    const productive =
      available && state.state === "ACTIVE" && !!target && target.state === "ACTIVE";
    const draining =
      available &&
      (hauler(m) || tractor(m)) &&
      ((state.state === "DRAINING" && !!target) ||
        (state.relocation?.oldBeltID !== undefined && !!target) ||
        state.manifests.some(
          (x) => !x.delivered && x.targetKey !== state.claim?.key && !!haulTarget(x),
        ));
    return {
      operationID: state.operationID,
      runID: state.runID,
      member: clone(m),
      state: state.state,
      targetGranted: productive,
      productiveReady: false as const,
      deliverOnly: draining,
      claim: productive || draining ? clone(state.claim) : null,
      target: (productive || draining) && target ? clone(target.target) : null,
      manifests:
        (productive || draining) && (producer(m) || hauler(m) || tractor(m))
          ? clone(
              state.manifests.filter((x) => {
                const owner = state.stopFreight === "RETURN_HOME" ? haulOwner(state, x) : undefined;
                return (
                  !x.delivered &&
                  (state.stopFreight !== "RETURN_HOME" ||
                    (owner?.dispatched && owner.characterID === characterID))
                );
              }),
            )
          : [],
    };
  }
  function resumeActive() {
    if (state.state !== "ACTIVE" || state.stopRequested || state.relocation || !state.claim)
      return false;
    const claim = board.resumeActive(state.claim);
    if (!claim || !updateFreightTails(true)) return false;
    // A crashed pass no longer owns an unissued pickup. Keep its manifest for
    // live grid selection, and keep issued transfers and tractor proofs intact.
    const haulClaims = Object.fromEntries(
      Object.entries(state.haulClaims).filter(([, c]) => c.dispatched || c.purpose === "tractor"),
    );
    commit({ ...state, claim, haulClaims });
    return true;
  }
  function heartbeat() {
    if (
      !updateFreightTails() ||
      !state.claim ||
      !["READY", "ACTIVE", "DRAINING", "SETTLING", "PARKING"].includes(state.state)
    )
      return false;
    if (state.stopFreight === "RETURN_HOME" && detachedBelt(state.claim)) return true;
    const claim = board.heartbeat(state.claim);
    if (!claim) return false;
    commit({ ...state, claim });
    return true;
  }
  function detachedBelt(claim: Claim) {
    return claim.key.startsWith("BELT:") && !board.retains(claim);
  }
  function minerMayJettison(claim: Claim) {
    return (
      state.state === "ACTIVE" &&
      !state.stopRequested &&
      !state.relocation &&
      state.claim?.key === claim.key &&
      state.claim.generation === claim.generation &&
      authority()?.state === "ACTIVE"
    );
  }
  function jettisonStopped(characterID: number) {
    return (
      state.stopFreight === "RETURN_HOME" ||
      (state.stopFreight === "COLLECT_FREIGHT" && member(characterID)?.role === "MINER")
    );
  }
  function prepareJetcan(
    characterID: number,
    items: readonly ManifestItem[],
    capacityM3: number,
    facts: Readonly<
      Record<
        number,
        {
          readonly categoryID: number;
          readonly freightKind: FreightKind;
          readonly unitVolumeM3: number;
        }
      >
    >,
    source: JetcanSource,
    scene?: Pick<RawHoldObservation, "existingContainerIDs" | "sceneSampledAt" | "miningContinues">,
  ) {
    const m = member(characterID),
      target = authority();
    if (
      jettisonStopped(characterID) ||
      state.haulMode === "SELF_UNLOAD" ||
      state.state !== "ACTIVE" ||
      !state.claim ||
      !target ||
      target.state !== "ACTIVE" ||
      !m ||
      !producer(m) ||
      state.settled.includes(characterID) ||
      state.jetcanIntents[String(characterID)] ||
      !Array.isArray(items) ||
      !items.length ||
      !Number.isFinite(capacityM3) ||
      capacityM3 <= 0 ||
      source?.source !== "checked-ship-holds" ||
      source.characterID !== characterID ||
      source.shipID !== m.shipID ||
      source.systemID !== state.systemID ||
      source.targetKey !== state.claim.key ||
      source.claimGeneration !== state.claim.generation ||
      !Number.isFinite(source.observedAt) ||
      source.observedAt > now() ||
      now() - source.observedAt > 15_000 ||
      !Array.isArray(source.items) ||
      new Set(source.items.map((i) => i.itemID)).size !== source.items.length ||
      !items.every((i) =>
        source.items.some(
          (row) =>
            row.itemID === i.itemID &&
            row.typeID === i.typeID &&
            row.quantity === i.quantity &&
            row.ownerID === characterID &&
            row.locationID === m.shipID &&
            [5, 134, 135, 181, 182].includes(row.flagID),
        ),
      )
    )
      return null;
    const category = items[0]!.freightKind;
    if (category !== "RAW" && category !== "COMPRESSED") return null;
    const seen = new Set<number>();
    let volume = 0;
    for (const item of items) {
      const fact = facts[item.typeID];
      if (
        !valid(item.itemID) ||
        seen.has(item.itemID) ||
        !valid(item.typeID) ||
        !valid(item.quantity) ||
        item.freightKind !== category ||
        !fact ||
        fact.categoryID !== 25 ||
        fact.freightKind !== category ||
        !Number.isFinite(fact.unitVolumeM3) ||
        fact.unitVolumeM3 <= 0 ||
        item.unitVolumeM3 !== fact.unitVolumeM3
      )
        return null;
      seen.add(item.itemID);
      volume += item.quantity * fact.unitVolumeM3;
    }
    if (
      !Number.isFinite(volume) ||
      volume <= 0 ||
      volume > capacityM3 + 1e-9 ||
      state.jetcanGeneration === Number.MAX_SAFE_INTEGER
    )
      return null;
    if (
      scene &&
      (!Number.isFinite(scene.sceneSampledAt) ||
        !Array.isArray(scene.existingContainerIDs) ||
        scene.existingContainerIDs.some((id) => !valid(id)) ||
        new Set(scene.existingContainerIDs).size !== scene.existingContainerIDs.length)
    )
      return null;
    const before = scene
      ? clone({
          source,
          items,
          facts,
          capacityM3,
          existingContainerIDs: scene.existingContainerIDs,
          sceneSampledAt: scene.sceneSampledAt,
          ...(m.role === "MINER" && target.target.kind === "BELT" && scene.miningContinues === true
            ? { miningContinues: true as const }
            : {}),
        })
      : undefined;
    const intent = {
      generation: state.jetcanGeneration + 1,
      category,
      items: clone(items),
      capacityM3,
      dispatched: false,
      ...(before ? { before } : {}),
    };
    commit({
      ...state,
      jetcanGeneration: intent.generation,
      jetcanIntents: { ...state.jetcanIntents, [String(characterID)]: intent },
    });
    return clone(intent);
  }
  function cancelPreparedJetcan(characterID: number, generation: number) {
    const intent = state.jetcanIntents[String(characterID)];
    if (!intent || intent.generation !== generation || intent.dispatched) return false;
    const jetcanIntents = { ...state.jetcanIntents };
    delete jetcanIntents[String(characterID)];
    commit({
      ...state,
      jetcanIntents,
      state:
        state.state === "DRAINING" &&
        Object.keys(jetcanIntents).length === 0 &&
        state.manifests.every((m) => m.delivered)
          ? "SETTLING"
          : state.state,
    });
    return true;
  }
  function refuseJetcanCooldown(characterID: number, generation: number) {
    const key = String(characterID),
      intent = state.jetcanIntents[key],
      at = now();
    if (!intent || !intent.dispatched || intent.generation !== generation || !Number.isFinite(at))
      return false;
    const jetcanIntents = { ...state.jetcanIntents };
    delete jetcanIntents[key];
    commit({
      ...state,
      jetcanIntents,
      jetcanRefusals: [
        ...(state.jetcanRefusals ?? []),
        { characterID, generation, refusedAt: at, outcome: "NATIVE_COOLDOWN" },
      ],
      jetcanCooldowns: {
        ...state.jetcanCooldowns,
        [key]: { generation, refusedAt: at, retryAt: at + 180_000, outcome: "NATIVE_COOLDOWN" },
      },
    });
    return true;
  }
  function jetcanCooldownRemaining(characterID: number) {
    const x = state.jetcanCooldowns?.[String(characterID)];
    return x ? Math.max(0, x.retryAt - now()) : 0;
  }
  function dispatchJetcan(characterID: number, generation: number) {
    const intent = state.jetcanIntents[String(characterID)];
    if (
      jettisonStopped(characterID) ||
      state.state !== "ACTIVE" ||
      !authority() ||
      !intent ||
      intent.generation !== generation ||
      intent.dispatched
    )
      return false;
    commit({
      ...state,
      jetcanIntents: {
        ...state.jetcanIntents,
        [String(characterID)]: { ...intent, dispatched: true },
      },
    });
    return true;
  }
  function registerJetcan(
    proof: JetcanProof,
    facts: Readonly<
      Record<
        number,
        {
          readonly categoryID: number;
          readonly freightKind: FreightKind;
          readonly unitVolumeM3: number;
        }
      >
    >,
  ) {
    const m = member(proof.characterID),
      c = state.claim,
      target = authority(),
      intent = state.jetcanIntents[String(proof.characterID)];
    if (
      !["ACTIVE", "DRAINING"].includes(state.state) ||
      !c ||
      !target ||
      !intent ||
      !intent.dispatched ||
      intent.generation !== proof.intentGeneration ||
      !m ||
      !producer(m) ||
      m.shipID !== proof.shipID ||
      proof.source !== "native-jetcan" ||
      proof.operationID !== state.operationID ||
      proof.runID !== state.runID ||
      proof.targetKey !== c.key ||
      proof.claimGeneration !== c.generation ||
      proof.systemID !== state.systemID ||
      !valid(proof.containerID) ||
      contains(proof.containerID) ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15_000 ||
      proof.capacityM3 !== intent.capacityM3 ||
      !Array.isArray(proof.items) ||
      !proof.items.length
    )
      return false;
    const totals = (items: readonly ManifestItem[]) => {
      const map = new Map<number, number>(),
        seen = new Set<number>();
      let volume = 0;
      for (const item of items) {
        const fact = facts[item.typeID];
        if (
          !valid(item.itemID) ||
          seen.has(item.itemID) ||
          !valid(item.typeID) ||
          !valid(item.quantity) ||
          item.freightKind !== intent.category ||
          !fact ||
          fact.categoryID !== 25 ||
          fact.freightKind !== intent.category ||
          !Number.isFinite(fact.unitVolumeM3) ||
          fact.unitVolumeM3 <= 0 ||
          fact.unitVolumeM3 !== item.unitVolumeM3
        )
          return null;
        seen.add(item.itemID);
        const sum = (map.get(item.typeID) ?? 0) + item.quantity;
        if (!Number.isSafeInteger(sum)) return null;
        map.set(item.typeID, sum);
        volume += item.quantity * fact.unitVolumeM3;
      }
      return { map, volume };
    };
    const before = totals(intent.items),
      after = totals(proof.items);
    if (
      !before ||
      !after ||
      !Number.isFinite(after.volume) ||
      after.volume > intent.capacityM3 + 1e-9
    )
      return false;
    if (intent.before?.miningContinues && intent.category === "RAW") {
      if (
        proof.items.length !== intent.items.length ||
        intent.items.some(
          (item) =>
            !proof.items.some(
              (row) =>
                row.itemID === item.itemID &&
                row.typeID === item.typeID &&
                row.quantity >= item.quantity,
            ),
        )
      )
        return false;
    } else if (
      before.map.size !== after.map.size ||
      [...before.map].some(([id, q]) => after.map.get(id) !== q)
    )
      return false;
    const jetcanIntents = { ...state.jetcanIntents };
    delete jetcanIntents[String(proof.characterID)];
    commit({
      ...state,
      jetcanIntents,
      manifests:
        state.stopFreight === "RETURN_HOME"
          ? state.manifests
          : [
              ...state.manifests,
              {
                ...clone(proof),
                category: intent.category,
                volumeM3: after.volume,
                delivered: false,
              },
            ],
    });
    return true;
  }
  /** Adopt observed cargo without inventing a miner, ship or Jettison intent. */
  function canDiscoverGridFreight(characterID: number, claim: Claim, final: boolean) {
    if (
      state.stopFreight === "RETURN_HOME" ||
      state.haulMode === "SELF_UNLOAD" ||
      member(characterID)?.role !== "HAULER" ||
      state.settled.includes(characterID)
    )
      return false;
    if (final && sameClaim(freightTailToScan()?.claim, claim)) return true;
    const c = state.claim;
    if (!sameClaim(c, claim)) return false;
    const boardState = authority()?.state;
    if (
      final &&
      state.stopFreight === "COLLECT_FREIGHT" &&
      ["DRAINING", "SETTLING"].includes(state.state) &&
      boardState === "DRAINING"
    )
      return true;
    const closing = state.stopFreight === "COLLECT_FREIGHT" || !!state.relocation;
    return (
      state.state === "ACTIVE" &&
      boardState === "ACTIVE" &&
      (final ? closing : !state.stopRequested && !state.relocation)
    );
  }
  function registerGridJetcan(characterID: number, claim: Claim, can: GridJetcan, final = false) {
    const { capacityM3 } = can;
    const nowMs = now();
    const known = contains(can.containerID);
    if (
      !canDiscoverGridFreight(characterID, claim, final) ||
      !valid(can.containerID) ||
      !valid(can.ownerID) ||
      known ||
      (sameClaim(state.claim, claim) && state.jetcanIntents[String(can.ownerID)]?.dispatched) ||
      !Number.isFinite(can.observedAt) ||
      can.observedAt > nowMs ||
      nowMs - can.observedAt > 15000 ||
      !Number.isFinite(capacityM3) ||
      capacityM3 <= 0 ||
      !can.items.length ||
      new Set(can.items.map((i) => i.itemID)).size !== can.items.length
    )
      return false;
    const category = can.items[0]!.freightKind;
    const volumeM3 = can.items.reduce((sum, i) => sum + i.quantity * i.unitVolumeM3, 0);
    if (
      !["RAW", "COMPRESSED"].includes(category) ||
      can.items.some(
        (i) =>
          i.freightKind !== category ||
          !valid(i.itemID) ||
          !valid(i.typeID) ||
          !valid(i.quantity) ||
          !Number.isFinite(i.unitVolumeM3) ||
          i.unitVolumeM3 <= 0,
      ) ||
      !Number.isFinite(volumeM3) ||
      volumeM3 <= 0 ||
      volumeM3 > capacityM3 + 1e-9
    )
      return false;
    const manifest: Manifest = {
      source: "observed-jetcan",
      operationID: state.operationID,
      runID: state.runID,
      targetKey: claim.key,
      claimGeneration: claim.generation,
      characterID: can.ownerID,
      shipID: null,
      systemID: state.systemID,
      containerID: can.containerID,
      intentGeneration: null,
      observedAt: can.observedAt,
      items: can.items,
      capacityM3,
      category,
      volumeM3,
      delivered: false,
    };
    commit({
      ...state,
      manifests: [...state.manifests, manifest],
      state:
        state.state === "SETTLING" && state.stopFreight === "COLLECT_FREIGHT"
          ? "DRAINING"
          : state.state,
    });
    return true;
  }
  function claimContainer(
    characterID: number,
    containerID: number,
    purpose: "haul" | "tractor" = "haul",
    binding?: TractorBinding,
    batching = false,
  ) {
    const m = member(characterID),
      manifest = state.manifests.find((x) => x.containerID === containerID);
    if (
      !m ||
      state.settled.includes(characterID) ||
      !(purpose === "haul" ? hauler(m) : purpose === "tractor" && tractor(m)) ||
      !manifest ||
      manifest.delivered ||
      manifest.closedPickup ||
      !haulTarget(manifest) ||
      (manifest.source === "observed-jetcan" && m.role !== "HAULER") ||
      (purpose === "tractor" && manifest.targetKey !== state.claim?.key)
    )
      return null;
    if (
      purpose === "tractor" &&
      (!binding ||
        !valid(binding.moduleID) ||
        !valid(binding.typeID) ||
        typeof binding.botID !== "string" ||
        !binding.botID ||
        !Number.isSafeInteger(binding.sessionGeneration) ||
        binding.sessionGeneration < 0 ||
        !valid(now()))
    )
      return null;
    const existing = state.haulClaims[String(containerID)];
    if (existing)
      return existing.characterID === characterID &&
        (existing.purpose ?? "haul") === purpose &&
        (purpose !== "tractor" || sameTractorBinding(existing.tractorBinding, binding))
        ? clone(existing)
        : null;
    if (
      state.stopFreight === "RETURN_HOME" ||
      Object.values(state.haulClaims).some(
        (claim) =>
          claim.characterID === characterID &&
          (!batching ||
            m.role !== "HAULER" ||
            purpose !== "haul" ||
            !claim.dispatched ||
            claim.purpose === "tractor"),
      )
    )
      return null;
    if (state.haulGeneration === Number.MAX_SAFE_INTEGER)
      throw new Error("Haul claim sequence exhausted.");
    const claim = {
      characterID,
      generation: state.haulGeneration + 1,
      dispatched: false,
      ...(purpose === "tractor"
        ? { purpose: "tractor" as const, issuedAt: now(), tractorBinding: clone(binding!) }
        : purpose === "haul" && m.role === "COMMAND"
          ? { purpose: "haul" as const }
          : {}),
    };
    commit({
      ...state,
      haulGeneration: claim.generation,
      haulClaims: { ...state.haulClaims, [String(containerID)]: claim },
    });
    return clone(claim);
  }
  /** Service custody can be relinquished only after the exact claimed tractor is natively inactive. */
  function releaseTractor(
    characterID: number,
    containerID: number,
    generation: number,
    evidence: unknown,
  ) {
    const m = member(characterID),
      claim = state.haulClaims[String(containerID)],
      e = evidence as any,
      i = e?.identity,
      q = e?.qualification,
      o = e?.ownInactive ?? e?.inactive,
      module = o?.module;
    if (
      !tractor(m) ||
      !m ||
      !claim ||
      claim.purpose !== "tractor" ||
      claim.characterID !== characterID ||
      claim.generation !== generation ||
      !authority() ||
      !state.claim ||
      !e ||
      e.version !== 1 ||
      i?.operationID !== state.operationID ||
      i.runID !== state.runID ||
      i.characterID !== characterID ||
      i.shipID !== m.shipID ||
      i.canID !== containerID ||
      i.systemID !== state.systemID ||
      i.claimGeneration !== generation ||
      i.targetGeneration !== state.claim.generation ||
      !valid(i.moduleID) ||
      !valid(i.typeID) ||
      !valid(i.flagID) ||
      i.moduleID !== claim.tractorBinding?.moduleID ||
      i.typeID !== claim.tractorBinding?.typeID ||
      i.botID !== claim.tractorBinding?.botID ||
      i.sessionGeneration !== claim.tractorBinding?.sessionGeneration ||
      q?.typeID !== i.typeID ||
      q.effectName !== "tractorBeamCan" ||
      !valid(q.effectID) ||
      !o ||
      !Number.isFinite(o.at) ||
      !Number.isFinite(claim.issuedAt) ||
      o.at < claim.issuedAt! ||
      o.at > now() ||
      now() - o.at > 90000 ||
      module?.moduleID !== i.moduleID ||
      module.typeID !== i.typeID ||
      module.ownerID !== characterID ||
      module.shipID !== m.shipID ||
      module.flagID !== i.flagID ||
      !Array.isArray(module.effects) ||
      module.effects.some((x: any) => !x || !valid(x.effectID) || x.effectID === q.effectID) ||
      !Array.isArray(module.activeTargets) ||
      module.activeTargets.length !== 0 ||
      !nativeFiletime(module.timeFiletime) ||
      !nativeFiletime(module.wallclockFiletime) ||
      (e.active &&
        (!e.activation ||
          !Number.isFinite(e.active.at) ||
          e.active.at < e.activation.issuedAt ||
          e.active.at > o.at ||
          e.active.module?.moduleID !== i.moduleID ||
          e.active.module?.typeID !== i.typeID ||
          e.active.module?.ownerID !== characterID ||
          e.active.module?.shipID !== m.shipID ||
          e.active.module?.flagID !== i.flagID ||
          !Array.isArray(e.active.module?.activeTargets) ||
          e.active.module.activeTargets.length !== 1 ||
          e.active.module.activeTargets[0]?.effectID !== q.effectID ||
          e.active.module.activeTargets[0]?.targetID !== containerID)) ||
      (e.ownActive &&
        (!e.activation ||
          !Number.isFinite(e.ownActive.at) ||
          e.ownActive.at < e.activation.issuedAt ||
          e.ownActive.at > o.at ||
          e.ownActive.module?.moduleID !== i.moduleID ||
          e.ownActive.module?.typeID !== i.typeID ||
          e.ownActive.module?.ownerID !== characterID ||
          e.ownActive.module?.shipID !== m.shipID ||
          e.ownActive.module?.flagID !== i.flagID ||
          !Array.isArray(e.ownActive.module?.effects) ||
          !e.ownActive.module.effects.some((x: any) => x?.effectID === q.effectID))) ||
      (e.activation &&
        (!valid(e.activation.issuedAt) ||
          typeof e.activation.acknowledged !== "boolean" ||
          (!e.activation.acknowledged && !e.active && !e.ownActive) ||
          o.at < e.activation.issuedAt)) ||
      (e.deactivation &&
        (!valid(e.deactivation.issuedAt) ||
          typeof e.deactivation.acknowledged !== "boolean" ||
          o.at < e.deactivation.issuedAt))
    )
      return false;
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[String(containerID)];
    commit({ ...state, haulClaims });
    return true;
  }
  function cancelUndispatchedHaul(characterID: number, containerID: number, generation: number) {
    const claim = state.haulClaims[String(containerID)];
    if (
      !claim ||
      claim.characterID !== characterID ||
      claim.generation !== generation ||
      claim.dispatched ||
      claim.purpose === "tractor"
    )
      return false;
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[String(containerID)];
    commit({ ...state, haulClaims });
    return true;
  }
  function dispatchHaul(characterID: number, containerID: number, generation: number) {
    const claim = state.haulClaims[String(containerID)];
    const manifest = state.manifests.find((m) => m.containerID === containerID);
    if (
      state.stopFreight === "RETURN_HOME" ||
      !claim ||
      claim.purpose === "tractor" ||
      claim.characterID !== characterID ||
      claim.generation !== generation ||
      claim.dispatched ||
      !manifest ||
      !haulTarget(manifest)
    )
      return false;
    commit({
      ...state,
      haulClaims: { ...state.haulClaims, [String(containerID)]: { ...claim, dispatched: true } },
    });
    return true;
  }
  function closePickup(characterID: number, containerID: number, generation: number) {
    const key = String(containerID),
      claim = state.haulClaims[key];
    const manifest = state.manifests.find((m) => m.containerID === containerID && !m.delivered);
    if (
      !manifest ||
      !claim?.dispatched ||
      claim.purpose === "tractor" ||
      claim.characterID !== characterID ||
      claim.generation !== generation ||
      member(characterID)?.role !== "HAULER"
    )
      return false;
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[key];
    const manifests = state.manifests.map((m) =>
      m === manifest ? { ...m, closedPickup: { characterID, generation } } : m,
    );
    commit({ ...state, manifests, haulClaims });
    return true;
  }
  function forgetMissingContainer(
    characterID: number,
    containerID: number,
    generation: number,
    verifiedRemainder = false,
  ) {
    const key = String(containerID),
      manifest = state.manifests.find((m) => m.containerID === containerID);
    const scope = manifest && haulTarget(manifest),
      claim = manifest && haulOwner(state, manifest);
    if (
      !scope ||
      (!verifiedRemainder &&
        ((state.stopFreight !== "COLLECT_FREIGHT" &&
          !scope.oldBeltID &&
          !state.relocation?.oldBeltID) ||
          claim?.dispatched)) ||
      !claim ||
      claim.purpose === "tractor" ||
      claim.characterID !== characterID ||
      claim.generation !== generation
    )
      return false;
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[key];
    commit({
      ...state,
      haulClaims,
      manifests: state.manifests.filter((m) => m.containerID !== containerID),
    });
    return true;
  }
  function stopRemainingHaul(characterID: number, containerID: number, generation: number) {
    const key = String(containerID),
      manifest = state.manifests.find((m) => m.containerID === containerID),
      claim = manifest && haulOwner(state, manifest);
    if (
      !state.stopRequested ||
      !claim?.dispatched ||
      claim.characterID !== characterID ||
      claim.generation !== generation
    )
      return false;
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[key];
    commit({
      ...state,
      haulClaims,
      manifests: state.manifests.filter((m) => m.containerID !== containerID),
    });
    return true;
  }
  function markDelivered(characterID: number, evidence: DeliveryEvidence) {
    const m = member(characterID),
      manifest = state.manifests.find((x) => x.containerID === evidence.containerID),
      claim = manifest && haulOwner(state, manifest);
    if (
      !m ||
      !hauler(m) ||
      !manifest ||
      !haulTarget(manifest) ||
      manifest.delivered ||
      !claim ||
      claim.purpose === "tractor" ||
      claim.characterID !== characterID ||
      claim.generation !== evidence.claimGeneration ||
      !claim.dispatched ||
      evidence.shipID !== m.shipID ||
      evidence.source !== "native-transfer" ||
      evidence.operationID !== state.operationID ||
      evidence.runID !== state.runID ||
      evidence.destinationID !== state.destinationID ||
      !Number.isFinite(evidence.observedAt) ||
      evidence.observedAt > now() ||
      now() - evidence.observedAt > 15_000
    )
      return false;
    const totals = (rows: readonly { typeID: number; quantity: number }[]) => {
      if (!Array.isArray(rows)) return null;
      const map = new Map<number, number>();
      for (const row of rows) {
        if (!row || !valid(row.typeID) || !Number.isSafeInteger(row.quantity) || row.quantity <= 0)
          return null;
        const total = (map.get(row.typeID) ?? 0) + row.quantity;
        if (!Number.isSafeInteger(total)) return null;
        map.set(row.typeID, total);
      }
      return map;
    };
    const source = evidence.sourceProof === undefined ? totals(evidence.sourceAfter) : null,
      before = totals(evidence.destinationBefore),
      after = totals(evidence.destinationAfter);
    if (
      (evidence.sourceProof === undefined
        ? !source || source.size !== 0
        : !provesHaulSource(
            manifest,
            characterID,
            evidence.shipID,
            evidence.sourceProof,
            evidence.observedAt,
          )) ||
      !before ||
      !after
    )
      return false;
    const expected = new Map<number, number>();
    for (const item of manifest.items) {
      const total = (expected.get(item.typeID) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(total)) return false;
      expected.set(item.typeID, total);
    }
    if (Object.hasOwn(evidence, "deliveryBatches")) {
      const rawBatches = evidence.deliveryBatches;
      if (!Array.isArray(rawBatches) || !rawBatches.length) return false;
      const batches = rawBatches as readonly NativeDeliveryBatch[];
      const consumed = new Set<string>(),
        delivered = new Map<number, number>();
      let destinationScope: string | null = null;
      for (const b of batches) {
        if (
          !b ||
          !b.item ||
          !valid(b.item.itemID) ||
          !valid(b.item.typeID) ||
          !valid(b.item.quantity) ||
          !Array.isArray(b.sourceBefore) ||
          !Array.isArray(b.sourceAfter) ||
          !Array.isArray(b.destinationBefore) ||
          !Array.isArray(b.destinationAfter)
        )
          return false;
        if (b.conversion) {
          const c = b.conversion,
            f = c.facility;
          if (
            manifest.category !== "RAW" ||
            evidence.sourceProof?.kind !== "native-batches" ||
            !c.item ||
            !c.output ||
            !f ||
            c.item.itemID !== b.item.itemID ||
            c.output.itemID !== c.item.itemID ||
            c.output.typeID !== b.item.typeID ||
            c.output.typeID === c.item.typeID ||
            c.output.quantity !== c.item.quantity ||
            c.output.quantity !== b.item.quantity ||
            c.output.flagID !== c.item.flagID ||
            f.operationID !== state.operationID ||
            f.runID !== state.runID ||
            f.claimKey !== manifest.targetKey ||
            f.claimGeneration !== manifest.claimGeneration ||
            f.commanderCharacterID !== characterID ||
            f.commanderShipID !== m.shipID ||
            f.minerCharacterID !== characterID ||
            f.minerShipID !== m.shipID ||
            f.sourceTypeID !== c.item.typeID ||
            f.compressedTypeID !== c.output.typeID ||
            f.systemID !== state.systemID ||
            !valid(f.coreModuleID) ||
            !valid(f.compressorModuleID) ||
            f.coreModuleID === f.compressorModuleID ||
            !valid(f.compressorEffectID) ||
            !Array.isArray(f.facilityTypeListIDs) ||
            !f.facilityTypeListIDs.length ||
            new Set(f.facilityTypeListIDs).size !== f.facilityTypeListIDs.length ||
            f.facilityTypeListIDs.some((n) => !valid(n)) ||
            !Array.isArray(f.matchingTypeListIDs) ||
            f.matchingTypeListIDs.length !== f.facilityTypeListIDs.length ||
            new Set(f.matchingTypeListIDs).size !== f.matchingTypeListIDs.length ||
            f.matchingTypeListIDs.some((n) => !f.facilityTypeListIDs.includes(n)) ||
            !Number.isFinite(f.rangeMeters) ||
            f.rangeMeters <= 0 ||
            !Number.isFinite(f.surfaceDistanceMeters) ||
            f.surfaceDistanceMeters < 0 ||
            f.surfaceDistanceMeters > f.rangeMeters ||
            !Number.isFinite(f.observedAt) ||
            f.observedAt > c.issuedAt ||
            c.issuedAt - f.observedAt > 60000 ||
            !Number.isFinite(c.rawUnitVolumeM3) ||
            c.rawUnitVolumeM3 <= 0 ||
            !Number.isFinite(c.compressedUnitVolumeM3) ||
            c.compressedUnitVolumeM3 <= 0 ||
            !Number.isFinite(c.issuedAt) ||
            !Number.isFinite(c.observedAt) ||
            c.issuedAt > c.observedAt ||
            c.observedAt > evidence.observedAt ||
            !Array.isArray(c.before) ||
            !Array.isArray(c.after) ||
            c.before.length !== c.after.length ||
            !evidence.sourceProof.batches.some((p) =>
              p.shipAfter.some(
                (r) =>
                  r.itemID === c.item.itemID &&
                  r.typeID === c.item.typeID &&
                  r.quantity === c.item.quantity &&
                  r.ownerID === characterID &&
                  r.locationID === m.shipID &&
                  r.flagID === c.item.flagID,
              ),
            )
          )
            return false;
          const raw = c.before.find((r) => r.itemID === c.item.itemID),
            output = c.after.find((r) => r.itemID === c.item.itemID);
          if (
            !raw ||
            !output ||
            raw.typeID !== c.item.typeID ||
            raw.quantity !== c.item.quantity ||
            output.typeID !== c.output.typeID ||
            output.quantity !== c.output.quantity ||
            raw.ownerID !== characterID ||
            output.ownerID !== characterID ||
            raw.locationID !== m.shipID ||
            output.locationID !== m.shipID ||
            raw.flagID !== c.item.flagID ||
            output.flagID !== c.output.flagID ||
            c.before.some(
              (r) =>
                r.itemID !== c.item.itemID &&
                !c.after.some(
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
          const left = (expected.get(c.item.typeID) ?? 0) - c.item.quantity;
          if (left < 0) return false;
          if (left) expected.set(c.item.typeID, left);
          else expected.delete(c.item.typeID);
          const converted = (expected.get(c.output.typeID) ?? 0) + c.output.quantity;
          if (!Number.isSafeInteger(converted)) return false;
          expected.set(c.output.typeID, converted);
        }
        const validSource = (rows: NativeDeliveryBatch["sourceBefore"]) =>
          new Set(rows.map((r) => r.itemID)).size === rows.length &&
          rows.every(
            (r) =>
              r &&
              valid(r.itemID) &&
              valid(r.typeID) &&
              valid(r.quantity) &&
              r.ownerID === characterID &&
              r.locationID === m.shipID &&
              [5, 134, 135, 181, 182].includes(r.flagID),
          );
        if (!validSource(b.sourceBefore) || !validSource(b.sourceAfter)) return false;
        const row = b.sourceBefore.find((r) => r.itemID === b.item.itemID);
        if (!row || row.typeID !== b.item.typeID || row.quantity < b.item.quantity) return false;
        const all = [...b.destinationBefore, ...b.destinationAfter];
        if (
          !all.length ||
          new Set(b.destinationBefore.map((r) => r?.itemID)).size !== b.destinationBefore.length ||
          new Set(b.destinationAfter.map((r) => r?.itemID)).size !== b.destinationAfter.length ||
          all.some(
            (r) =>
              !r ||
              !valid(r.itemID) ||
              !valid(r.typeID) ||
              !valid(r.quantity) ||
              !valid(r.ownerID) ||
              !valid(r.locationID) ||
              !Number.isInteger(r.flagID) ||
              (definition.delivery?.corporationID === null
                ? r.flagID !== 4 ||
                  r.ownerID !== characterID ||
                  r.locationID !== definition.destinationID
                : r.flagID < 115 ||
                  r.flagID > 121 ||
                  (!!definition.delivery &&
                    (r.ownerID !== definition.delivery.corporationID ||
                      r.flagID !== 114 + definition.delivery.division!))),
          )
        )
          return false;
        for (const r of all) {
          const scope = JSON.stringify([r.ownerID, r.locationID, r.flagID]);
          if (destinationScope === null) destinationScope = scope;
          else if (destinationScope !== scope) return false;
        }
        if (b.items !== undefined) {
          if (
            b.conversion ||
            definition.delivery?.corporationID === null ||
            !Array.isArray(b.items) ||
            !b.items.length
          )
            return false;
          const [first] = b.items;
          if (
            !first ||
            first.itemID !== b.item.itemID ||
            first.typeID !== b.item.typeID ||
            first.quantity !== b.item.quantity
          )
            return false;
          const moved = movedWholeStacks(
            b.sourceBefore,
            b.sourceAfter,
            b.destinationBefore,
            b.destinationAfter,
          );
          if (!moved) return false;
          for (const item of b.items) {
            const stack = moved.find((r) => r.itemID === item?.itemID),
              key = JSON.stringify([item?.itemID]);
            if (
              !stack ||
              stack.typeID !== item.typeID ||
              !valid(item.quantity) ||
              item.quantity > stack.quantity ||
              consumed.has(key)
            )
              return false;
            consumed.add(key);
            const quantity = (delivered.get(item.typeID) ?? 0) + item.quantity;
            if (!Number.isSafeInteger(quantity)) return false;
            delivered.set(item.typeID, quantity);
          }
          continue;
        }
        if (
          !confirmedDepositItem(
            b.item,
            b.sourceBefore,
            b.sourceAfter,
            b.destinationBefore,
            b.destinationAfter,
          )
        )
          return false;
        const d0 = totals(b.destinationBefore);
        if (!d0) return false;
        const evidenceKey = JSON.stringify([
          b.item.itemID,
          row.quantity,
          b.item.quantity,
          d0.get(b.item.typeID) ?? 0,
        ]);
        if (consumed.has(evidenceKey)) return false;
        consumed.add(evidenceKey);
        const sum = (delivered.get(b.item.typeID) ?? 0) + b.item.quantity;
        if (!Number.isSafeInteger(sum)) return false;
        delivered.set(b.item.typeID, sum);
      }
      if (
        delivered.size !== expected.size ||
        [...expected].some(([id, q]) => delivered.get(id) !== q)
      )
        return false;
      const first = totals(batches[0]!.destinationBefore)!,
        last = totals(batches[batches.length - 1]!.destinationAfter)!;
      if (
        first.size !== before.size ||
        last.size !== after.size ||
        [...first].some(([id, q]) => before.get(id) !== q) ||
        [...last].some(([id, q]) => after.get(id) !== q)
      )
        return false;
    } else if (
      definition.delivery?.corporationID === null ||
      [...expected].some(
        ([typeID, quantity]) => (after.get(typeID) ?? 0) !== (before.get(typeID) ?? 0) + quantity,
      )
    )
      return false;
    const { closedPickup, ...cargoManifest } = manifest;
    const delivered = { ...cargoManifest, delivered: true, deliveredAt: evidence.observedAt };
    const manifests = state.manifests.map((x) =>
      x.containerID === manifest.containerID ? delivered : x,
    );
    const haulClaims = { ...state.haulClaims };
    delete haulClaims[String(evidence.containerID)];
    commit(
      {
        ...state,
        manifests,
        haulClaims,
        state:
          state.state === "DRAINING" &&
          manifests.every((x) => x.delivered) &&
          Object.keys(state.jetcanIntents).length === 0
            ? "SETTLING"
            : state.state,
      },
      { manifest: delivered, receipt: evidence },
    );
    return true;
  }
  function prepareRelocation(
    characterID: number,
    expected: Claim,
    next: Target,
    oldBeltID?: number,
    movingCharacterIDs?: readonly number[],
  ) {
    if (
      state.state !== "ACTIVE" ||
      member(characterID)?.role !== "MINER" ||
      state.relocation ||
      !state.claim ||
      !authority() ||
      state.claim.key !== expected.key ||
      state.claim.generation !== expected.generation ||
      expected.operationID !== state.operationID ||
      expected.runID !== state.runID ||
      next.systemID !== state.systemID
    )
      return false;
    const key = targetKey(next);
    if (
      key === state.claim.key ||
      !board.availableForRelocation(key, state.relocatedKeys?.includes(key) === true)
    )
      return false;
    const relocation = {
      phase: "PREPARING" as const,
      oldClaim: clone(state.claim),
      next: clone(next),
      ...(oldBeltID ? { oldBeltID } : {}),
      ...(movingCharacterIDs ? { movingCharacterIDs } : {}),
    };
    const moving = relocationMembers(state.members, relocation).filter(
      (m) => !state.parked.includes(m.characterID),
    );
    if (
      !moving.some((m) => m.role === "MINER") ||
      Object.keys(state.jetcanIntents).some(
        (id) => !moving.some((m) => m.characterID === Number(id)),
      ) ||
      Object.values(state.haulClaims).some(
        (c) => c.purpose === "tractor" && !moving.some((m) => m.characterID === c.characterID),
      )
    )
      return false;
    commit({ ...state, relocation });
    return true;
  }
  function cancelRelocation() {
    const r = state.relocation;
    if (!r) return true;
    if (r.phase === "PREPARING" || r.phase === "DRAINING") {
      const interruptedBeltMove = r.oldBeltID && r.phase === "DRAINING" && state.stopRequested;
      const pending =
        state.manifests.some((m) => !m.delivered) ||
        Object.keys(state.jetcanIntents).length > 0 ||
        (r.freightScanPending && state.stopFreight === "COLLECT_FREIGHT");
      commit({
        ...state,
        relocation: undefined,
        state: interruptedBeltMove ? (pending ? "DRAINING" : "SETTLING") : state.state,
      });
      return true;
    }
    if (r.phase === "RESERVING") {
      const next = board.read(targetKey(r.next));
      if (next?.state === "QUARANTINED") return false;
      if (
        next?.claim?.operationID === state.operationID &&
        next.claim.runID === state.runID &&
        (next.state !== "RESERVED" || !board.releaseReserved(next.claim))
      )
        return false;
      commit({ ...state, claim: null, relocation: undefined });
      return true;
    }
    if (r.phase === "RELEASING") {
      const old = board.read(r.oldClaim.key);
      if (
        old &&
        (!old.claim ||
          old.claim.operationID !== state.operationID ||
          old.claim.runID !== state.runID ||
          old.claim.generation !== r.oldClaim.generation)
      )
        return false;
      commit({ ...state, claim: old ? r.oldClaim : null, relocation: undefined });
      return true;
    }
    return false;
  }
  function drainRelocation(scanOldBelt = false) {
    const relocation = state.relocation;
    if (
      relocation?.phase !== "PREPARING" ||
      state.state !== "ACTIVE" ||
      !state.claim ||
      !board.drain(state.claim)
    )
      return false;
    commit({
      ...state,
      relocation: {
        ...relocation,
        phase: "DRAINING",
        ...(relocation.oldBeltID && scanOldBelt ? { freightScanPending: true as const } : {}),
      },
      state:
        !relocation.oldBeltID &&
        (state.manifests.some((m) => !m.delivered) || Object.keys(state.jetcanIntents).length)
          ? "DRAINING"
          : "SETTLING",
    });
    return true;
  }
  function relocateAfterSettlement(
    proofs: readonly {
      characterID: number;
      shipID: number;
      source: "native-flight";
      systemID: number;
      inSpace: boolean;
      docked: boolean;
      observedAt: number;
    }[],
  ) {
    let r = state.relocation;
    const moving = movingMembers();
    if (
      !r ||
      state.state !== "PARKING" ||
      moving.some((m) => !state.settled.includes(m.characterID)) ||
      Object.keys(state.jetcanIntents).length ||
      (!r.oldBeltID &&
        (state.manifests.some((m) => !m.delivered) || Object.keys(state.haulClaims).length))
    )
      return false;
    if (r.phase === "DRAINING") {
      if (
        !moving.some((m) => m.role === "MINER") ||
        !Array.isArray(proofs) ||
        proofs.length !== moving.length ||
        new Set(proofs.map((p) => p.characterID)).size !== proofs.length ||
        proofs.some(
          (p) =>
            !moving.some((m) => m.characterID === p.characterID && m.shipID === p.shipID) ||
            p.source !== "native-flight" ||
            !valid(p.systemID) ||
            typeof p.inSpace !== "boolean" ||
            typeof p.docked !== "boolean" ||
            p.inSpace === p.docked ||
            !Number.isFinite(p.observedAt) ||
            p.observedAt > now() ||
            now() - p.observedAt > 15000 ||
            p.observedAt < (state.settledAt[String(p.characterID)] ?? Infinity),
        )
      )
        return false;
      if (moving.length !== relocationMembers(state.members, r).length)
        r = { ...r, movingCharacterIDs: moving.map((m) => m.characterID) };
      if (r.oldBeltID) {
        const next = board.reserve(state.operationID, state.runID, r.next);
        if (!next) return false;
        try {
          commit({
            ...state,
            state: "READY",
            claim: next,
            relocation: undefined,
            relocatedKeys: [...new Set([...(state.relocatedKeys ?? []), r.oldClaim.key])],
            relocationHistory: [
              ...(state.relocationHistory ?? []),
              {
                oldClaim: r.oldClaim,
                oldBeltID: r.oldBeltID,
                ...(r.freightScanPending ? { freightScanPending: true as const } : {}),
                movingCharacterIDs: r.movingCharacterIDs,
                next: r.next,
                newClaim: next,
                proofs: clone(proofs),
                completedAt: now(),
              },
            ].slice(-128),
            ...keepDocked(),
            stayed: undefined,
            selfUnloadFinal: undefined,
            commandMiningFinal: undefined,
          });
        } catch (error) {
          board.releaseReserved(next);
          throw error;
        }
        return true;
      }
      commit({ ...state, relocation: { ...r, phase: "RELEASING", proofs: clone(proofs) } });
      r = state.relocation!;
    }
    if (r.phase === "RELEASING") {
      const old = board.read(r.oldClaim.key);
      if (
        old &&
        (!old.claim ||
          old.claim.operationID !== state.operationID ||
          old.claim.runID !== state.runID ||
          old.claim.generation !== r.oldClaim.generation ||
          !board.releaseDrained(r.oldClaim, {
            allMembersSettledInPlace: true,
            freightSettled: true,
          }))
      )
        return false;
      commit({ ...state, claim: null, relocation: { ...r, phase: "RESERVING" } });
      r = state.relocation!;
    }
    if (r.phase !== "RESERVING") return false;
    const next = board.reserve(state.operationID, state.runID, r.next);
    if (!next) return false;
    commit({
      ...state,
      state: "READY",
      claim: next,
      relocation: undefined,
      relocatedKeys: [...new Set([...(state.relocatedKeys ?? []), r.oldClaim.key])],
      relocationHistory: [
        ...(state.relocationHistory ?? []),
        {
          oldClaim: clone(r.oldClaim),
          next: clone(r.next),
          newClaim: clone(next),
          movingCharacterIDs: r.movingCharacterIDs,
          proofs: clone(r.proofs!),
          completedAt: now(),
        },
      ].slice(-128),
      ...keepDocked(),
      stayed: undefined,
      selfUnloadFinal: undefined,
      commandMiningFinal: undefined,
    });
    return true;
  }
  function recordSelfUnloadFinal(
    characterID: number,
    proof: {
      source: "native-self-unload";
      runID: string;
      shipID: number;
      rawRemaining: readonly unknown[];
      observedAt: number;
    },
  ) {
    const m = member(characterID);
    if (
      state.haulMode !== "SELF_UNLOAD" ||
      !["READY", "ACTIVE", "DRAINING", "SETTLING"].includes(state.state) ||
      !m ||
      !producer(m) ||
      proof.source !== "native-self-unload" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      !Array.isArray(proof.rawRemaining) ||
      proof.rawRemaining.length !== 0 ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15000
    )
      return false;
    commit({
      ...state,
      selfUnloadFinal: {
        ...state.selfUnloadFinal,
        [String(characterID)]: { characterID, shipID: m.shipID, observedAt: proof.observedAt },
      },
    });
    return true;
  }
  /** FINISH has independently excluded the productive group and holds this exact
   * held actor. Stop productive assignments before reconciling original trips.
   * Each producer must still prove its own empty hold before it can settle. */
  function beginRetainedFinish(
    characterID: number,
    proof: {
      source: "native-retained-finish";
      runID: string;
      shipID: number;
      modulesInactive: boolean;
      dronesSafe: boolean;
      observedAt: number;
    },
  ) {
    const m = member(characterID);
    if (
      !m ||
      proof.source !== "native-retained-finish" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      !proof.modulesInactive ||
      !proof.dronesSafe ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15000 ||
      !["ACTIVE", "DRAINING", "SETTLING", "PARKING"].includes(state.state)
    )
      return false;
    if (!updateFreightTails(true)) return false;
    if (state.state === "ACTIVE") {
      if (
        !state.claim ||
        (!(state.stopFreight === "RETURN_HOME" && detachedBelt(state.claim)) &&
          !board.drain(state.claim))
      )
        return false;
      commit({ ...state, state: "DRAINING" });
    }
    return true;
  }
  function beginUnstartedFinish(
    neverStarted: readonly number[],
    receiptHash: string,
    proof: {
      source: "native-retained-finish";
      characterID: number;
      runID: string;
      shipID: number;
      modulesInactive: boolean;
      dronesSafe: boolean;
      observedAt: number;
    },
  ) {
    const m = member(proof.characterID);
    if (
      state.state !== "READY" ||
      state.claim ||
      state.relocation ||
      state.relocationHistory?.length ||
      state.manifests.length ||
      Object.keys(state.jetcanIntents).length ||
      Object.keys(state.haulClaims).length ||
      state.settled.length ||
      state.parked.length ||
      !m ||
      proof.source !== "native-retained-finish" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      proof.modulesInactive !== true ||
      proof.dronesSafe !== true ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15000 ||
      !receiptHash ||
      new Set(neverStarted).size !== neverStarted.length ||
      neverStarted.some((id) => !member(id)) ||
      neverStarted.includes(m.characterID) ||
      neverStarted.length >= state.members.length
    )
      return false;
    commit({
      ...state,
      state: "SETTLING",
      neverStarted: [...neverStarted],
      unstartedFinish: { receiptHash },
    });
    return true;
  }
  function noteStopRequest(mode?: StopFreightMode, abandonCollection = false) {
    const switching =
      abandonCollection && mode === "RETURN_HOME" && state.stopFreight === "COLLECT_FREIGHT";
    if (
      state.state === "STOPPED" ||
      (state.stopRequested && (!mode || state.stopFreight) && !switching)
    )
      return;
    if (mode !== "RETURN_HOME") {
      const jetcanIntents =
        mode === "COLLECT_FREIGHT"
          ? Object.fromEntries(
              Object.entries(state.jetcanIntents).filter(
                ([id, intent]) => intent.dispatched || member(Number(id))?.role !== "MINER",
              ),
            )
          : state.jetcanIntents;
      commit({
        ...state,
        stopRequested: true,
        ...(mode ? { stopFreight: mode } : {}),
        jetcanIntents,
      });
      return;
    }
    // The old dispatches still own their original receipts. Unissued work can end here.
    const haulClaims = Object.fromEntries(
      Object.entries(state.haulClaims).filter(([, c]) => c.dispatched || c.purpose === "tractor"),
    );
    const jetcanIntents = Object.fromEntries(
      Object.entries(state.jetcanIntents).filter(([, i]) => i.dispatched),
    );
    commit({
      ...state,
      stopRequested: true,
      stopFreight: mode,
      haulClaims,
      jetcanIntents,
      manifests: state.manifests.filter(
        (m) => m.delivered || m.closedPickup || haulClaims[String(m.containerID)],
      ),
    });
  }
  function resumeStopping() {
    if (!state.stopRequested || !state.stopFreight || state.relocation || !updateFreightTails(true))
      return false;
    if (!state.claim) return state.state === "SETTLING" || state.state === "PARKING";
    const finalFreight = state.state === "ACTIVE" && state.stopFreight === "COLLECT_FREIGHT";
    const active = finalFreight ? board.resumeActive(state.claim) : null;
    const claim = active ?? board.resumeDraining(state.claim);
    if (!claim) return state.stopFreight === "RETURN_HOME" && detachedBelt(state.claim);
    commit({ ...state, claim, state: finalFreight && !active ? "DRAINING" : state.state });
    return true;
  }
  function recordNeverStarted(ids: readonly number[]) {
    if (!state.stopRequested || !state.stopFreight || state.state === "STOPPED" || !ids.length)
      return;
    const safe = ids.filter(
      (id) =>
        member(id) &&
        !state.settled.includes(id) &&
        !state.jetcanIntents[String(id)] &&
        !hasHaulWork(state, id) &&
        !state.manifests.some((m) => m.characterID === id),
    );
    const neverStarted = [...new Set([...(state.neverStarted ?? []), ...safe])];
    if (neverStarted.length !== (state.neverStarted?.length ?? 0))
      commit({ ...state, neverStarted });
  }
  function requestStop() {
    if (state.state === "STOPPED") return;
    if (
      !state.stopFreight &&
      state.haulMode === "SELF_UNLOAD" &&
      state.state === "ACTIVE" &&
      state.members.some((m) => producer(m) && !state.selfUnloadFinal?.[String(m.characterID)])
    )
      throw Error("Final raw hold evidence is incomplete.");
    if (["DRAINING", "SETTLING", "PARKING"].includes(state.state)) return;
    if (state.state === "ACTIVE" && state.claim && !board.drain(state.claim)) {
      // Settling the pilots and their outstanding actions is independent of target authority.
      commit({ ...state, state: "SETTLING" });
      return;
    }
    if (state.state === "READY" && state.claim) {
      if (!board.releaseReserved(state.claim) && board.retains(state.claim))
        throw new Error("The starting belt reservation could not be released.");
      commit({ ...state, claim: null });
    }
    const stoppedBeforeWork =
      state.state === "READY" &&
      !state.relocation &&
      !state.relocationHistory?.length &&
      !state.manifests.length &&
      !state.jetcanGeneration &&
      !state.haulGeneration;
    commit({
      ...state,
      ...(stoppedBeforeWork ? { stoppedBeforeWork: true } : {}),
      state:
        state.manifests.some((m) => !m.delivered) || Object.keys(state.jetcanIntents).length > 0
          ? "DRAINING"
          : "SETTLING",
    });
  }
  /** Read after productive work has stopped; this is not a delivery or a synthetic yield. */
  function recordCommandMiningFinal(
    characterID: number,
    proof: {
      source: "native-command-mining-final";
      runID: string;
      shipID: number;
      rawRemaining: readonly unknown[];
      observedAt: number;
    },
  ) {
    const m = member(characterID);
    if (
      !caps?.selfMining ||
      caps.characterID !== characterID ||
      !m ||
      m.role !== "COMMAND" ||
      !(
        ["DRAINING", "SETTLING"].includes(state.state) ||
        (state.state === "ACTIVE" && state.stopRequested)
      ) ||
      state.jetcanIntents[String(characterID)] ||
      proof.source !== "native-command-mining-final" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      !Array.isArray(proof.rawRemaining) ||
      proof.rawRemaining.length !== 0 ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 90000
    )
      return false;
    commit({
      ...state,
      commandMiningFinal: { characterID, shipID: m.shipID, observedAt: proof.observedAt },
    });
    return true;
  }
  function settleMember(
    characterID: number,
    proof: {
      source: "native-settlement";
      runID: string;
      shipID: number;
      modulesInactive: boolean;
      dronesSafe: boolean;
      observedAt: number;
    },
  ) {
    const m = member(characterID);
    if (
      state.neverStarted?.includes(characterID) ||
      !(
        ["DRAINING", "SETTLING"].includes(state.state) ||
        (state.state === "ACTIVE" && state.stopRequested && !state.relocation)
      ) ||
      !m ||
      (state.relocation && !movingMembers().some((x) => x.characterID === characterID)) ||
      state.jetcanIntents[String(characterID)] ||
      hasHaulWork(state, characterID) ||
      (!state.stopFreight &&
        !state.stoppedBeforeWork &&
        !state.unstartedFinish &&
        state.haulMode === "SELF_UNLOAD" &&
        producer(m) &&
        !state.selfUnloadFinal?.[String(characterID)]) ||
      (!state.stopFreight &&
        !state.stoppedBeforeWork &&
        !state.unstartedFinish &&
        m.role === "COMMAND" &&
        caps?.selfMining &&
        !state.commandMiningFinal) ||
      (!state.stopRequested &&
        !state.relocation?.oldBeltID &&
        hauler(m) &&
        state.manifests.some(
          (x) =>
            !x.delivered &&
            (!haulOwner(state, x) || haulOwner(state, x)?.characterID === characterID),
        )) ||
      proof.source !== "native-settlement" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      proof.modulesInactive !== true ||
      proof.dronesSafe !== true ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15_000
    )
      return false;
    const settled = [...new Set([...state.settled, characterID])];
    commit({
      ...state,
      settled,
      settledAt: { ...state.settledAt, [String(characterID)]: proof.observedAt },
      state: state.state !== "ACTIVE" && readyToPark(settled) ? "PARKING" : state.state,
    });
    return true;
  }
  function readyToPark(settled: readonly number[]) {
    const done = state.relocation
      ? movingMembers().every((m) => settled.includes(m.characterID))
      : settled.length === requiredCount();
    return (
      done &&
      (!!state.relocation?.oldBeltID || state.manifests.every((x) => x.delivered)) &&
      Object.keys(state.jetcanIntents).length === 0
    );
  }
  function parkMember(
    characterID: number,
    proof: {
      source: "native-flight" | "native-capsule-dock";
      runID: string;
      shipID: number;
      locationID: number;
      docked: boolean;
      observedAt: number;
    },
    emergency = false,
  ) {
    const m = member(characterID),
      capsule = proof.source === "native-capsule-dock";
    const emergencyDock =
      emergency &&
      !!m &&
      !state.neverStarted?.includes(characterID) &&
      !state.jetcanIntents[String(characterID)] &&
      !hasHaulWork(state, characterID);
    const eligible = capsule
      ? (emergencyDock ||
          (state.stopRequested && state.stopFreight !== undefined && !state.relocation)) &&
        !state.neverStarted?.includes(characterID) &&
        valid(proof.shipID) &&
        proof.locationID === state.destinationID
      : proof.source === "native-flight" &&
        (emergencyDock || state.settled.includes(characterID)) &&
        proof.shipID === m?.shipID;
    const parking =
      emergencyDock ||
      ["DRAINING", "SETTLING", "PARKING"].includes(state.state) ||
      (state.state === "ACTIVE" && state.stopRequested && !state.relocation);
    if (
      !parking ||
      state.state === "STOPPED" ||
      !m ||
      !eligible ||
      proof.runID !== state.runID ||
      !valid(proof.locationID) ||
      proof.docked !== true ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15_000 ||
      proof.observedAt <
        (state.settledAt[String(characterID)] ?? (capsule || emergencyDock ? 0 : Infinity))
    )
      return false;
    const parked = [...new Set([...state.parked, characterID])];
    const settlement =
      (capsule || emergencyDock) && !state.settled.includes(characterID)
        ? {
            settled: [...state.settled, characterID],
            settledAt: { ...state.settledAt, [String(characterID)]: proof.observedAt },
          }
        : {};
    commit({
      ...state,
      ...settlement,
      parked,
      ...(state.stayed ? { stayed: state.stayed.filter((id) => id !== characterID) } : {}),
      state:
        emergencyDock &&
        state.state === "SETTLING" &&
        state.relocation &&
        readyToPark(settlement.settled ?? state.settled)
          ? "PARKING"
          : state.state,
    });
    completeStop();
    return true;
  }
  function stayMember(
    characterID: number,
    proof: {
      source: "native-flight";
      runID: string;
      shipID: number;
      systemID: number;
      inSpace: boolean;
      docked: boolean;
      observedAt: number;
    },
  ) {
    const m = member(characterID);
    if (
      state.stopMode !== "STAY_IN_PLACE" ||
      !(
        ["DRAINING", "SETTLING", "PARKING"].includes(state.state) ||
        (state.state === "ACTIVE" && state.stopRequested && !state.relocation)
      ) ||
      !m ||
      !state.settled.includes(characterID) ||
      proof.source !== "native-flight" ||
      proof.runID !== state.runID ||
      proof.shipID !== m.shipID ||
      !valid(proof.systemID) ||
      typeof proof.inSpace !== "boolean" ||
      typeof proof.docked !== "boolean" ||
      proof.inSpace === proof.docked ||
      !Number.isFinite(proof.observedAt) ||
      proof.observedAt > now() ||
      now() - proof.observedAt > 15000 ||
      proof.observedAt < (state.settledAt[String(characterID)] ?? Infinity)
    )
      return false;
    const stayed = [...new Set([...(state.stayed ?? []), characterID])];
    commit({ ...state, stayed, parked: state.parked.filter((id) => id !== characterID) });
    completeStop();
    return true;
  }
  function recordOfflineParking(proofs: readonly OfflineParking[]) {
    if (
      !state.stopRequested ||
      state.stopFreight !== "RETURN_HOME" ||
      !["ACTIVE", "DRAINING", "SETTLING", "PARKING"].includes(state.state) ||
      state.relocation ||
      Object.keys(state.jetcanIntents).length ||
      hasHaulWork(state) ||
      proofs.length !== requiredCount() ||
      new Set(proofs.map((p) => p.characterID)).size !== proofs.length ||
      proofs.some(
        (p) =>
          !member(p.characterID) ||
          state.neverStarted?.includes(p.characterID) ||
          ![p.shipID, p.locationID, p.systemID].every(valid) ||
          !Number.isFinite(p.observedAt) ||
          p.observedAt > now() ||
          now() - p.observedAt > 15_000,
      )
    )
      return false;
    const ids = proofs.map((p) => p.characterID);
    const settledAt = { ...state.settledAt };
    for (const p of proofs) settledAt[String(p.characterID)] ??= p.observedAt;
    commit({
      ...state,
      settled: ids,
      settledAt,
      parked: ids,
      stayed: undefined,
      offlineParking: Object.fromEntries(proofs.map((p) => [String(p.characterID), p])),
    });
    return true;
  }
  // Parking evidence is committed before target release, so a stale target
  // cannot erase physical progress. A retained matching quarantine is the
  // same claim; an absent row after drainage needs no second release.
  function completeStop() {
    if (state.state === "STOPPED") return true;
    if (
      !["DRAINING", "SETTLING", "PARKING"].includes(state.state) ||
      state.relocation ||
      state.settled.length !== requiredCount() ||
      new Set([...state.parked, ...(state.stayed ?? [])]).size !== requiredCount() ||
      (!state.stopRequested && state.manifests.some((m) => !m.delivered)) ||
      Object.keys(state.jetcanIntents).length ||
      hasHaulWork(state)
    )
      return false;
    for (const history of state.relocationHistory ?? [])
      if (history.oldBeltID) {
        const old = history.oldClaim,
          row = board.read(old.key);
        if (row?.state === "DEPLETED" || detachedBelt(old)) continue;
        if (
          (row?.state === "QUARANTINED" && !board.resumeDraining(old)) ||
          !board.finish(old, undefined, true)
        )
          return false;
      }
    const claim = state.claim;
    if (claim) {
      let row = board.read(claim.key);
      if (row?.state === "QUARANTINED" && board.resumeDraining(claim)) row = board.read(claim.key);
      if (
        row &&
        !detachedBelt(claim) &&
        (row.state !== "DRAINING" ||
          !(row.depletion
            ? board.finish(claim, undefined, true)
            : board.releaseDrained(claim, { allMembersParked: true, freightSettled: true })))
      )
        return false;
    }
    commit({
      ...state,
      claim: null,
      state: "STOPPED",
      manifests: state.manifests.filter((m) => m.delivered),
    });
    return true;
  }
  return {
    noteStopRequest,
    recordNeverStarted,
    completeStop,
    resumeActive,
    resumeStopping,
    haulTarget,
    movingMembers,
    snapshot: () => clone(state),
    reserve,
    activate,
    assignment,
    heartbeat,
    prepareRelocation,
    cancelRelocation,
    drainRelocation,
    relocateAfterSettlement,
    recordSelfUnloadFinal,
    beginUnstartedFinish,
    beginRetainedFinish,
    recordCommandMiningFinal,
    minerMayJettison,
    prepareJetcan,
    cancelPreparedJetcan,
    refuseJetcanCooldown,
    jetcanCooldownRemaining,
    jettisonStopped,
    dispatchJetcan,
    registerJetcan,
    canDiscoverGridFreight,
    registerGridJetcan,
    freightTailToScan,
    finishFreightTailScan,
    claimContainer,
    releaseTractor,
    cancelUndispatchedHaul,
    dispatchHaul,
    closePickup,
    forgetMissingContainer,
    stopRemainingHaul,
    markDelivered,
    requestStop,
    settleMember,
    parkMember,
    stayMember,
    recordOfflineParking,
  };
}
