import type { BackendPilotObservation } from "../shared/backendScope.ts";
import { recoverCollectedConversion } from "./finishConversion.ts";
import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession, type PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  decodeFlightStatus,
  getFlightStatus,
} from "../../../web/src/plugin-api/flying.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import {
  createOperation,
  haulOwner,
  hasHaulWork,
  type Member,
  type Manifest,
  type DeliveryEvidence,
  type OfflineParking,
} from "./operation.ts";
import type { FleetOperationStore } from "./operationStore.ts";
import { UnconfirmedHaulerUnload } from "./dockedRawDeposit.ts";
import { HAULER_OWN_DEPOSIT_PREFIX, createNativeHauler } from "./nativeHauler.ts";
import { createRawMembers } from "./memberLoops.ts";
import { fleetHaulDocumentKey, type FleetSetup } from "./runtime.ts";
import { settleFleetMember } from "./settle.ts";
import { iceCycleTiming, observedOreCycleSettled } from "./miningCycle.ts";
import { validSavedSiteClassification } from "./siteSelection.ts";
import { targetKey } from "./targetBoard.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { readNativeShipHolds, type NativeInventoryRow } from "./nativeInventory.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { depositOwnShipRaw, type OwnShipRawSource } from "./dockedRawDeposit.ts";
import { createNativeSelfUnload, readSelfUnloadTotals } from "./selfUnload.ts";
import { createCompressionController } from "./support/compressionController.ts";
import { sameJsonValue } from "../shared/value.ts";
import { createHash } from "node:crypto";
import { finishParking, retainedStopUnload, stopParkingSetup } from "./finishParking.ts";
import { parkAtOperationHome } from "./operationParking.ts";
import { transientNativeRead } from "../shared/progressDeadline.ts";
import type { FleetLaunchReceipt } from "../operations/miningLaunchJournal.ts";
import { registerRun, runOwner } from "../runControl.ts";
import type { Claim, SynchronousStore, createTargetBoard } from "./targetBoard.ts";

type Board = ReturnType<typeof createTargetBoard> & { resumeDraining(claim: Claim): Claim | null };
export interface FleetFinishDependencies {
  document(name: string): SynchronousStore;
  operationStore(operationID: string, runID: string): FleetOperationStore;
  cycleDocument(characterID: number, scope: Input): SynchronousStore;
  board: Board;
  decodeSetup(value: unknown): FleetSetup | null;
  assertNoLiveGroup(operationID: string, operationRunID: string): void | Promise<void>;
  dockedUnloadsOnly?: boolean;
  owner?: typeof runOwner;
  register?: typeof registerRun;
  retryDelay?: number;
  deliveryPark?: typeof parkAtOperationHome;
  depositOwnedRaw?: typeof depositOwnShipRaw;
  recoverSelfUnload?: (
    run: PluginRunContext,
    session: PilotSession,
    setup: FleetSetup,
    member: Member,
    current: () => void,
  ) => Promise<{ rawRemaining: readonly unknown[]; observedAt: number }>;
  park?: typeof finishParking;
  readHolds?: (
    session: PilotSession,
    current: () => void,
    characterID: number,
    shipID: number,
  ) => Promise<readonly NativeInventoryRow[]>;
  rawFacts?: (
    run: PluginRunContext,
    current: () => void,
    ids: readonly number[],
  ) => Promise<
    Readonly<
      Record<
        number,
        {
          categoryID: number;
          freightKind: "RAW" | "COMPRESSED" | null;
          unitVolumeM3: number;
          resourceFamily?: "ore" | "ice" | null;
        }
      >
    >
  >;
  attach?: typeof createPilotSession;
  settle?: typeof settleFleetMember;
  quiescence?: (
    run: PluginRunContext,
    session: PilotSession,
    member: Member,
    current: () => void,
  ) => Promise<void | InactiveProof>;
  recoverHaul?: (
    run: PluginRunContext,
    session: PilotSession,
    setup: FleetSetup,
    member: Member,
    manifest: Manifest,
    generation: number,
    current: () => void,
    document: SynchronousStore,
  ) => Promise<DeliveryEvidence>;
}
type InactiveProof = {
  source: "native-fitted-modules";
  characterID: number;
  shipID: number;
  observedAt: number;
  modules: { moduleID: number; typeID: number; flagID: number }[];
};
type Input = { operationID: string; operationRunID: string };
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const obj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function inputOf(v: unknown): Input | null {
  return obj(v) &&
    Object.keys(v).sort().join(",") === "operationID,operationRunID" &&
    typeof v.operationID === "string" &&
    !!v.operationID.trim() &&
    v.operationID.length <= 120 &&
    typeof v.operationRunID === "string" &&
    !!v.operationRunID.trim() &&
    v.operationRunID.length <= 120
    ? { operationID: v.operationID, operationRunID: v.operationRunID }
    : null;
}
const identityOf = (setup: FleetSetup, member: Member) => [
  setup.operationID,
  setup.operationRunID,
  member.characterID,
  member.shipID,
  setup.systemID,
  setup.site ? setup.site.target : setup.beltID,
];
function readCycle(
  document: SynchronousStore,
  setup: FleetSetup,
  member: Member,
  allowPending = false,
) {
  const raw = document.read();
  if (
    !obj(raw) ||
    raw.version !== 1 ||
    typeof raw.identity !== "string" ||
    typeof raw.closed !== "boolean" ||
    !(raw.pending === null || obj(raw.pending)) ||
    (!allowPending && raw.pending !== null)
  )
    throw Error("Mining cycle is missing or pending; reconciliation is required.");
  let parts: unknown;
  try {
    parts = JSON.parse(raw.identity);
  } catch {
    throw Error("Mining cycle identity is malformed.");
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 7 ||
    JSON.stringify(parts.slice(0, 6)) !== JSON.stringify(identityOf(setup, member)) ||
    typeof parts[6] !== "string" ||
    !parts[6]
  )
    throw Error("Mining cycle belongs to another owner or operation.");
  return { record: raw, oldBotID: parts[6] as string };
}
function closeCycle(
  document: SynchronousStore,
  setup: FleetSetup,
  member: Member,
  finishBotID: string,
) {
  const { record } = readCycle(document, setup, member);
  if (record.closed) return;
  document.write({
    ...record,
    closed: true,
    recoveredClose: { source: "native-finish", finishBotID, closedAt: Date.now() },
  });
}
async function nativeQuiescence(
  run: PluginRunContext,
  session: PilotSession,
  member: Member,
  current: () => void,
  attemptedShutdowns?: Set<number>,
) {
  const options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  current();
  const fit = await loadFitting(options);
  current();
  if (fit.activeShipID !== member.shipID || Object.values(fit.errors).some((x) => x !== null))
    throw Error("Native fitted modules are unavailable.");
  const raw = fit.slots as { type?: unknown; items?: unknown[] } | null;
  if (!raw || raw.type !== "list" || !Array.isArray(raw.items))
    throw Error("Native fitted module list is unreadable.");
  const ids: number[] = [];
  for (const value of raw.items) {
    const item = value as any,
      row = item?.type === "packedrow" ? item.fields : item;
    if (!row || ![7, 8].includes(Number(row.categoryID)))
      throw Error("Fitted item category is unknown.");
    if (Number(row.categoryID) === 7) {
      if (!positive(row.itemID) || ids.includes(row.itemID))
        throw Error("Fitted module identity is unknown.");
      ids.push(row.itemID);
    }
  }
  const slots = buildSlots(fit.slots, fit.shipInfo, fit.online),
    modules = slots.flatMap((s) => (s.module ? [s.module.itemID] : []));
  if (ids.length !== modules.length || ids.some((id) => !modules.includes(id)))
    throw Error("Fitted module projection is incomplete.");
  const checked: InactiveProof["modules"] = [];
  for (const slot of slots) {
    if (!slot.module) continue;
    const flagID = slotFlagOf(slot.family, slot.index);
    if (!flagID) throw Error("Fitted module flag is unavailable.");
    const { itemID: moduleID, typeID } = slot.module,
      identity = { moduleID, typeID, ownerID: run.characterID, shipID: member.shipID, flagID };
    const effects = async () => {
      current();
      const raw = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [moduleID]);
      current();
      return decodeModuleObservation(raw, identity).effects.filter(
        (effect) => effect.effectID !== 16,
      );
    };
    let active = await effects(),
      refusal = "";
    if (active.length === 1 && attemptedShutdowns && !attemptedShutdowns.has(moduleID)) {
      const flight = decodeFlightStatus((await getFlightStatus(options)).flight);
      current();
      if (
        !flight.inSpace ||
        flight.docked ||
        flight.shipID !== member.shipID ||
        (flight.transition && flight.transition.phase !== "ready")
      )
        throw Error("The original ship's flight changed before module shutdown.");
      attemptedShutdowns.add(moduleID);
      try {
        await session.flow.flying.switchModuleOff(moduleID, { typeID });
      } catch (error) {
        current();
        refusal = " Shutdown response: " + (error instanceof Error ? error.message : String(error));
      }
      active = await effects();
    }
    if (active.length)
      throw Object.assign(
        Error(
          `A fitted module remains active. Module ${moduleID}, effects ${active.map((e) => e.effectID).join(", ")}.` +
            refusal,
        ),
        { code: attemptedShutdowns?.has(moduleID) ? "MCC_MODULE_SHUTDOWN_PENDING" : undefined },
      );
    checked.push({ moduleID, typeID, flagID });
  }
  return {
    source: "native-fitted-modules" as const,
    characterID: run.characterID,
    shipID: member.shipID,
    observedAt: Date.now(),
    modules: checked,
  };
}

/** Resolve the exact previously selected site or belt from existing receipts. */
export function readRetainedFleetTarget(
  approved: FleetSetup,
  raw: Record<string, any>,
  input: Input,
  unstarted: boolean,
  {
    document,
    decodeSetup,
    cycleDocument,
  }: Pick<FleetFinishDependencies, "document" | "decodeSetup" | "cycleDocument">,
): FleetSetup {
  let setup = approved;
  const initial = document(
    `mining-fleet-initial-target:${JSON.stringify([input.operationID, input.operationRunID])}`,
  ).read();
  if (initial !== null) {
    const next = obj(initial) ? decodeSetup(initial.next) : null,
      base = (v: FleetSetup) => {
        const { site, siteSearch, beltID, beltName, ...rest } = v;
        return rest;
      };
    if (
      !obj(initial) ||
      initial.version !== 1 ||
      initial.operationID !== input.operationID ||
      initial.runID !== input.operationRunID ||
      initial.approvedSignature !== JSON.stringify(approved) ||
      !next ||
      !sameJsonValue(base(approved), base(next))
    )
      throw Error("Initial native locality selection differs from the original grant.");
    setup = next;
  }
  const currentClaim = raw.claim ?? raw.relocation?.oldClaim;
  const last = raw.relocationHistory?.at(-1);
  if (last) {
    const retained = document(
        `mining-fleet-relocation:${JSON.stringify([input.operationID, input.operationRunID])}`,
      ).read(),
      next = obj(retained) ? decodeSetup(retained.next) : null;
    const base = (v: FleetSetup) => {
      const { site, siteSearch, beltID, beltName, ...rest } = v;
      return rest;
    };
    if (
      !obj(retained) ||
      retained.version !== 1 ||
      retained.operationID !== input.operationID ||
      retained.runID !== input.operationRunID ||
      !next ||
      !sameJsonValue(base(approved), base(next)) ||
      last.newClaim?.key !== currentClaim?.key ||
      last.newClaim?.generation !== currentClaim?.generation ||
      !sameJsonValue(
        next.site?.target ?? { kind: "BELT", systemID: next.systemID, name: next.beltName },
        last.next,
      ) ||
      retained.oldClaim?.key !== last.oldClaim?.key ||
      retained.oldClaim?.generation !== last.oldClaim?.generation
    )
      throw Error("Retained relocation setup does not prove the current target generation.");
    setup = next;
  }
  if (setup.siteSearch && !unstarted) {
    const lead = approved.members.find((m) => m.role === "MINER");
    if (!lead) throw Error("Retained search leader is missing.");
    const search = document(
      `mining-fleet-site-search:${JSON.stringify([input.operationID, input.operationRunID, lead.characterID, lead.shipID])}`,
    ).read();
    if (
      !obj(search) ||
      search.version !== 1 ||
      search.pending !== null ||
      typeof search.identity !== "string" ||
      !obj(search.site)
    )
      throw Error("Retained site search is unresolved.");
    let parts: unknown;
    try {
      parts = JSON.parse(search.identity);
    } catch {
      throw Error("Retained search identity is malformed.");
    }
    const site = search.site as any,
      leaderCycle = cycleDocument(lead.characterID, input).read();
    let leaderIdentity: unknown;
    try {
      leaderIdentity = JSON.parse((leaderCycle as any)?.identity);
    } catch {
      throw Error("Retained leader identity is malformed.");
    }
    // The saved search and the mining cycle can have different hosted owners after a WC restart.
    if (
      !Array.isArray(parts) ||
      parts.length !== 6 ||
      typeof parts[0] !== "string" ||
      !parts[0] ||
      parts[1] !== lead.characterID ||
      parts[2] !== lead.shipID ||
      parts[3] !== approved.systemID ||
      !Number.isSafeInteger(parts[4]) ||
      parts[4] < 0 ||
      parts[5] !== setup.siteSearch.family ||
      site.siteFamily !== setup.siteSearch.family ||
      !site.target ||
      site.target.systemID !== approved.systemID ||
      site.target.siteID !== site.scannerKey ||
      site.target.instanceID !== site.instanceID ||
      !positive(site.scannerKey) ||
      !positive(site.instanceID) ||
      !validSavedSiteClassification(site) ||
      !Array.isArray(leaderIdentity) ||
      leaderIdentity.length !== 7 ||
      typeof leaderIdentity[6] !== "string" ||
      !leaderIdentity[6] ||
      JSON.stringify(leaderIdentity.slice(0, 6)) !==
        JSON.stringify(identityOf({ ...approved, site }, lead))
    )
      throw Error("Retained site search identity is uncertain.");
    setup = { ...approved, site };
  }

  if (
    setup.siteSearch &&
    !unstarted &&
    (!setup.site || (currentClaim && currentClaim.key !== targetKey(setup.site.target)))
  )
    throw Error("Retained target does not match the resolved site.");
  return setup;
}

/** Reconcile one retained generation, then use its original Parking policy. */
export function createFleetFinishRun(deps: FleetFinishDependencies): BackendRun & {
  ownsOperation(operationID: string): boolean;
  finalize(input: Input, observations?: readonly BackendPilotObservation[]): Promise<boolean>;
  discardReleased(input: Input): boolean;
  resumeHeld(run: PluginRunContext, input: Input): ReturnType<BackendRun["start"]>;
  requestStop(
    input: Input,
    mode: import("./operation.ts").StopFreightMode,
  ): import("./operation.ts").StopFreightMode | undefined;
} {
  const authorities = new Map<
    string,
    {
      setup: FleetSetup;
      op: ReturnType<typeof createOperation>;
      launch: FleetLaunchReceipt | null;
      unstarted: boolean;
      busy: Set<number>;
      draining: boolean;
      lost: boolean;
      timer: ReturnType<typeof setInterval> | null;
    }
  >();
  function authority(input: Input) {
    const key = JSON.stringify([input.operationID, input.operationRunID]);
    const cached = authorities.get(key);
    if (cached) return cached;
    const index = deps.document(`mining-fleet-index:${input.operationID}`).read();
    if (!obj(index) || index.runID !== input.operationRunID || typeof index.signature !== "string")
      throw Error("Retained operation index is unavailable.");
    let value: unknown;
    try {
      value = JSON.parse(index.signature);
    } catch {
      throw Error("Retained operation setup is malformed.");
    }
    const approved = deps.decodeSetup(value);
    if (
      !approved ||
      approved.operationID !== input.operationID ||
      approved.operationRunID !== input.operationRunID ||
      JSON.stringify(approved) !== index.signature
    )
      throw Error("Retained operation setup does not match its index.");
    const doc = deps.operationStore(input.operationID, input.operationRunID),
      raw = doc.read();
    if (
      !obj(raw) ||
      raw.operationID !== input.operationID ||
      raw.runID !== input.operationRunID ||
      !obj(raw.jetcanIntents)
    )
      throw Error("Retained operation custody is unreadable.");
    const launch = deps
      .document(
        `mining-fleet-finish-authority:${JSON.stringify([input.operationID, input.operationRunID])}`,
      )
      .read() as FleetLaunchReceipt | null;
    if (
      launch !== null &&
      (launch.version !== 1 ||
        launch.operationID !== input.operationID ||
        launch.operationRunID !== input.operationRunID ||
        !Array.isArray(launch.members) ||
        launch.members.length !== approved.members.length ||
        approved.members.some(
          (m) => !launch.members.some((r) => r.characterID === m.characterID && r.role === m.role),
        ))
    )
      throw Error("Original launch authority is inconsistent.");
    const unstarted =
      raw.stoppedBeforeWork === true ||
      raw.unstartedFinish !== undefined ||
      (raw.state === "READY" && !raw.claim && !raw.relocation && !raw.relocationHistory?.length);
    if (unstarted && !launch)
      throw Error("Incomplete assembly requires its account-scoped original launch receipt.");
    if (
      unstarted &&
      Object.values(deps.board.snapshot()).some(
        (e) =>
          ((e.claim?.operationID === input.operationID && e.claim.runID === input.operationRunID) ||
            (e.quarantinedClaim?.operationID === input.operationID &&
              e.quarantinedClaim.runID === input.operationRunID)) &&
          e.state !== "RESERVED",
      )
    )
      throw Error("Incomplete assembly conflicts with a productive or quarantined native claim.");
    if (
      !raw.claim &&
      !unstarted &&
      !raw.relocation &&
      !["SETTLING", "PARKING", "STOPPED"].includes(raw.state)
    )
      throw Error("Retained target authority is unavailable.");
    const setup = readRetainedFleetTarget(approved, raw, input, unstarted, deps);
    const op = createOperation(doc, deps.board, {
      operationID: setup.operationID,
      runID: setup.operationRunID,
      systemID: setup.systemID,
      destinationID: setup.destinationID,
      ...(setup.delivery ? { delivery: setup.delivery } : {}),
      members: setup.members,
      ...(setup.haulMode ? { haulMode: setup.haulMode } : {}),
      ...(setup.parking?.mode === "STAY_IN_PLACE" ? { stopMode: "STAY_IN_PLACE" as const } : {}),
      ...(setup.supportPolicy && setup.members.find((m) => m.role === "COMMAND")
        ? {
            commandCapabilities: {
              characterID: setup.members.find((m) => m.role === "COMMAND")!.characterID,
              selfMining: setup.supportPolicy.selfMining,
              tractor: setup.supportPolicy.tractor,
              collect: setup.supportPolicy.collection === "TRACTOR_AND_COLLECT",
            },
          }
        : {}),
    });
    const result = {
      setup,
      op,
      launch,
      unstarted,
      busy: new Set<number>(),
      draining: false,
      lost: false,
      timer: null as ReturnType<typeof setInterval> | null,
    };
    authorities.set(key, result);
    return result;
  }
  return {
    requestStop(input, mode) {
      const group = authority(input);
      group.op.noteStopRequest(mode);
      if (!group.busy.size && !group.timer)
        authorities.delete(JSON.stringify([input.operationID, input.operationRunID]));
      return group.op.snapshot().stopFreight;
    },
    async finalize(input, observations?: readonly BackendPilotObservation[]) {
      await deps.assertNoLiveGroup(input.operationID, input.operationRunID);
      const key = JSON.stringify([input.operationID, input.operationRunID]),
        group = authority(input);
      if (group.busy.size) return false;
      try {
        let snapshot = group.op.snapshot();
        if (observations && snapshot.state !== "STOPPED") {
          if (
            snapshot.stopFreight !== "RETURN_HOME" ||
            !snapshot.stopRequested ||
            snapshot.relocation ||
            !group.launch
          )
            throw Error(
              "The retained generation has no Return Home intent to finalize from offline docks.",
            );
          if (Object.keys(snapshot.jetcanIntents).length || hasHaulWork(snapshot))
            throw Error("A retained freight mutation still needs reconciliation before Finalize.");
          const { setup } = group,
            parking = stopParkingSetup(setup, snapshot.stopFreight).parking;
          if (parking?.mode === "RETURN_HOME_UNLOAD_DOCK")
            throw Error("Offline docking cannot confirm the required unload.");
          const planned =
            parking && parking.mode !== "STAY_IN_PLACE"
              ? parking
              : {
                  destinationID: setup.destinationID,
                  kind: setup.delivery?.kind ?? "station",
                  systemID: setup.delivery?.systemID ?? setup.systemID,
                };
          const proofs: OfflineParking[] = [];
          for (const member of snapshot.members) {
            const launched = group.launch.members.find(
              (m) => m.characterID === member.characterID,
            )!;
            if (launched.status === "PREPARED") continue;
            const proof = observations.find(
              (p) =>
                p.characterID === member.characterID &&
                p.accountName.toLowerCase() === launched.accountName.toLowerCase(),
            );
            if (!proof || proof.owner !== "OFF" || proof.online !== false)
              throw Error(launched.accountName + " has no verified offline release.");
            const dock = proof.dock,
              locationID = dock?.stationID ?? dock?.structureID;
            if (
              !dock ||
              !positive(dock.shipID) ||
              !positive(dock.systemID) ||
              !positive(locationID) ||
              positive(dock.stationID) === positive(dock.structureID)
            )
              throw Error(launched.accountName + " has no verified current dock.");
            const scope = [
              setup.operationID,
              setup.operationRunID,
              member.characterID,
              member.shipID,
            ];
            const suffix = JSON.stringify(scope);
            const inventoryDocs = [
              "mining-fleet-parking-unload:",
              "mining-fleet-finish-parking-unload:",
              "mining-fleet-finish-deposit:",
              HAULER_OWN_DEPOSIT_PREFIX,
            ].map((prefix) => deps.document(prefix + suffix).read());
            const trip = deps.document("mining-fleet-self-unload:" + suffix).read() as {
              pending?: { ordinal: number };
            } | null;
            if (trip?.pending)
              inventoryDocs.push(
                deps
                  .document(
                    "mining-fleet-self-unload-trip:" +
                      JSON.stringify([...scope, trip.pending.ordinal]),
                  )
                  .read(),
              );
            if (
              setup.oreLogistics?.remoteCompression &&
              (member.role === "MINER" ||
                (member.role === "COMMAND" && setup.supportPolicy?.selfMining))
            ) {
              const cycle = deps.cycleDocument(member.characterID, setup);
              const botID =
                cycle.read() === null
                  ? launched.botID
                  : readCycle(cycle, setup, member, true).oldBotID;
              if (botID)
                inventoryDocs.push(
                  deps
                    .document(
                      "mining-fleet-compression:" +
                        JSON.stringify([
                          setup.operationID,
                          setup.operationRunID,
                          botID,
                          member.characterID,
                          member.shipID,
                        ]),
                    )
                    .read(),
                );
            }
            if (inventoryDocs.some((doc) => doc !== null && (!obj(doc) || doc.pending !== null)))
              throw Error(launched.accountName + " has an unresolved inventory mutation.");
            const kind = positive(dock.stationID) ? "station" : "structure";
            proofs.push({
              characterID: member.characterID,
              shipID: dock.shipID,
              locationID,
              systemID: dock.systemID,
              kind,
              atPlannedDock:
                locationID === planned.destinationID &&
                dock.systemID === planned.systemID &&
                kind === planned.kind,
              observedAt: proof.observedAt,
            });
          }
          group.op.recordNeverStarted(
            group.launch.members.filter((m) => m.status === "PREPARED").map((m) => m.characterID),
          );
          if (!group.op.recordOfflineParking(proofs))
            throw Error("The current native parking observations do not cover the retained fleet.");
          snapshot = group.op.snapshot();
        }
        const done = new Set([
          ...snapshot.parked,
          ...(snapshot.stayed ?? []),
          ...(snapshot.neverStarted ?? []),
        ]);
        if (
          !snapshot.members.every((m) => done.has(m.characterID)) ||
          snapshot.relocation ||
          Object.keys(snapshot.jetcanIntents).length ||
          hasHaulWork(snapshot)
        )
          return false;
        if (snapshot.state === "ACTIVE" && snapshot.stopRequested) group.op.requestStop();
        return group.op.completeStop();
      } finally {
        if (group.timer) clearInterval(group.timer);
        authorities.delete(key);
      }
    },
    ownsOperation(operationID) {
      return [...authorities.values()].some(
        (g) =>
          g.setup.operationID === operationID &&
          (g.busy.size > 0 || g.op.snapshot().state !== "STOPPED"),
      );
    },
    discardReleased(input) {
      const key = JSON.stringify([input.operationID, input.operationRunID]),
        group = authorities.get(key);
      if (group?.busy.size) return false;
      if (group?.timer) clearInterval(group.timer);
      authorities.delete(key);
      return true;
    },
    check(value) {
      const input = inputOf(value);
      return input
        ? {
            ok: true,
            setup: input as unknown as JsonValue,
            name: "Finish retained mining fleet",
            policy: {
              riskClasses: ["inventory", "fleet"],
              restartSafe: true,
              sessionReconnect: true,
            },
          }
        : { ok: false, refusal: "Choose the exact retained operation and run." };
    },
    start(run) {
      const input = inputOf(run.setup);
      if (!input) throw Error("Finish actor is invalid.");
      return start(run, input);
    },
    resumeHeld(run, input) {
      if (!run.resumed) throw Error("The host has not resumed this held pilot.");
      return start(run, input);
    },
  };
  async function start(run: PluginRunContext, input: Input) {
    if (!positive(run.characterID) || run.held.characterID !== run.characterID)
      throw Error("Finish actor is invalid.");
    await deps.assertNoLiveGroup(input.operationID, input.operationRunID);
    const group = authority(input),
      { setup, op } = group,
      member = setup.members.find((m) => m.characterID === run.characterID);
    const launched = group.launch?.members.find((m) => m.characterID === run.characterID);
    if (launched?.status === "PREPARED")
      throw Error(
        "This pilot was never dispatched by the original launch; no FINISH login is authorized.",
      );
    if (
      !member ||
      group.busy.has(run.characterID) ||
      run.held.character.characterID !== run.characterID ||
      (member.role !== "COMMAND" &&
        member.role !== "DEFENDER" &&
        setup.delivery?.corporationID !== null &&
        run.held.character.corporationID !== setup.corporationID)
    )
      throw Error("Finish pilot, corporation, or active ownership is invalid.");
    const dockedOnly = deps.dockedUnloadsOnly === true && inputOf(run.setup) !== null;
    const initial = op.snapshot();
    const dockedUnload = dockedOnly ? retainedStopUnload(initial, setup) : null;
    if (
      dockedOnly &&
      (!launched ||
        !dockedUnload ||
        (!dockedUnload.characterIDs.includes(member.characterID) &&
          !initial.parked.includes(member.characterID)))
    )
      throw Error("Only the original pilot with a retained home unload can use Retry Stop.");
    const producer =
      member.role === "MINER" ||
      (member.role === "COMMAND" && setup.supportPolicy?.selfMining === true);
    const attemptedShutdowns = new Set<number>();
    group.busy.add(run.characterID);
    let active = true,
      ended = false,
      session: PilotSession | null = null,
      generation: number | null = null,
      lastFlight = "";
    const current = () => {
      if (!active) throw Error("Fleet finish stopped.");
      if (group.lost) throw Error("Retained target ownership was lost.");
      if (
        session &&
        (session.flow.flying.sessionGeneration() !== generation ||
          session.flow.flying.isSessionClosing() ||
          session.store.station.get().online?.characterID !== run.characterID)
      )
        throw Error("Held pilot session changed.");
    };
    const publish: PluginRunContext["report"] = (value) => {
      try {
        deps
          .document(
            `mining-fleet-finish-status:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID])}`,
          )
          .write({
            version: 1,
            operationID: setup.operationID,
            runID: setup.operationRunID,
            characterID: member.characterID,
            shipID: member.shipID,
            botID: run.botID,
            observedAt: Date.now(),
            report: value,
          });
      } catch {
        /* Display metadata does not change native custody. */
      }
      run.report(value);
    };
    let unregister: () => void = () => {},
      pendingUnloadUnits: number | undefined;
    const work = async () => {
      await deps.assertNoLiveGroup(input.operationID, input.operationRunID);
      current();
      const botsResponse = await run.fetch(new URL("/api/bots", run.baseUrl)),
        botsBody = await botsResponse.json();
      current();
      if (!botsResponse.ok || botsBody?.ok !== true || !Array.isArray(botsBody.bots))
        throw Error("Current hosted pilot lease is unreadable.");
      const own = botsBody.bots.filter((b: any) => b.characterID === run.characterID && !b.endedAt);
      if (
        own.length !== 1 ||
        own[0].botID !== run.botID ||
        !["starting", "running", "paused"].includes(own[0].status)
      )
        throw Error("Current exclusive hosted pilot lease is not verified.");
      op.noteStopRequest();
      const alreadySettled = op.snapshot().settled.includes(member.characterID);
      if (producer && !group.unstarted && !alreadySettled) {
        const old = readCycle(
            deps.cycleDocument(member.characterID, setup),
            setup,
            member,
            true,
          ).oldBotID,
          prior = botsBody.bots.filter(
            (b: any) => b.botID === old && (!run.resumed || b.botID !== run.botID),
          );
        const started = Date.parse(own[0].startedAt);
        // Terminal roster history is intentionally not persisted by BotHost. A missing
        // row is not a success receipt; the current exclusive lease and native
        // identity/inactivity/gain proofs below authorize read-only reconciliation.
        if (
          prior.length > 1 ||
          prior.some((b: any) => {
            const ended = Date.parse(b.endedAt);
            return (
              b.characterID !== member.characterID ||
              !["stopped", "error", "idle"].includes(b.status) ||
              !Number.isFinite(ended) ||
              !Number.isFinite(started) ||
              ended > started
            );
          })
        )
          throw Error("Prior mining owner is not terminal before the current lease.");
      }
      if (!session) {
        session = await (deps.attach ?? createPilotSession)(run);
        generation = session.flow.flying.sessionGeneration();
      }
      current();
      const operational = { ...run, report: publish, setup: setup as unknown as JsonValue },
        options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
      const heldSession = session;
      const flightNow = async () => {
        const flight = decodeFlightStatus((await getFlightStatus(options)).flight);
        current();
        if (
          flight.shipID !== member.shipID ||
          flight.inSpace === flight.docked ||
          !positive(flight.solarSystemID)
        )
          throw Error("Pilot flight identity is not stable in its original ship.");
        lastFlight = `Ship ${flight.shipID} ${flight.docked ? `docked at ${flight.stationID ?? flight.structureID}` : `in space, system ${flight.solarSystemID}`}.`;
        return flight;
      };
      let flight = await flightNow();
      if (dockedUnload) {
        const { parking } = dockedUnload;
        if (
          !flight.docked ||
          flight.solarSystemID !== parking.systemID ||
          (parking.kind === "station" ? flight.stationID : flight.structureID) !==
            parking.destinationID
        )
          throw Error(
            "The original ship must be docked at its configured home to finish unloading.",
          );
        if (!op.snapshot().parked.includes(member.characterID)) {
          const result = await (deps.park ?? finishParking)(
            operational,
            heldSession,
            setup,
            member.shipID,
            current,
            deps.document,
            {
              dockedOnly: true,
              onUnloadRemaining: (freight) => {
                pendingUnloadUnits = freight.units;
              },
            },
          );
          current();
          if (
            result.kind !== "dock" ||
            !op.parkMember(member.characterID, { ...result.proof, runID: setup.operationRunID })
          )
            throw Error("The completed home unload could not be recorded.");
        }
        ended = true;
        unregister();
        heldSession.flow.setLivePush(false);
        group.busy.delete(run.characterID);
        publish({
          status: "stopped",
          phase: "Docked; retained freight settled",
          readout: {
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
            characterID: member.characterID,
            shipID: member.shipID,
            groupCompleted: op.snapshot().state === "STOPPED",
          },
        });
        return;
      }
      const delivery = {
        mode: "RETURN_HOME_DOCK" as const,
        destinationID: setup.destinationID,
        kind: setup.delivery?.kind ?? "station",
        systemID: setup.delivery?.systemID ?? setup.systemID,
      };
      const atOriginalDelivery = () =>
        flight.docked &&
        (delivery.kind === "station" ? flight.stationID : flight.structureID) ===
          delivery.destinationID &&
        flight.solarSystemID === delivery.systemID &&
        (!flight.transition || flight.transition.phase === "ready");
      const reportProgress = (phase: string, why: string) =>
        publish({ status: "paused", phase, why: lastFlight + " " + why });
      const original = op.snapshot();
      const ownFreight = {
        operationID: setup.operationID,
        runID: setup.operationRunID,
        document: deps.document(
          HAULER_OWN_DEPOSIT_PREFIX +
            JSON.stringify([
              setup.operationID,
              setup.operationRunID,
              member.characterID,
              member.shipID,
            ]),
        ),
      };
      const pendingOwnDeposit =
        member.role === "HAULER" &&
        !!(ownFreight.document.read() as { pending?: unknown } | null)?.pending;
      const parkingSetup = stopParkingSetup(setup, original.stopFreight, member.role);
      const tripDoc = deps.document(
        `mining-fleet-self-unload:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
      );
      const depositDoc = deps.document(
        `mining-fleet-finish-deposit:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
      );
      const finishSelfUnload =
        !original.stopFreight || !!(tripDoc.read() as { pending?: unknown } | null)?.pending;
      const finishDeposit = !original.stopFreight || depositDoc.read() !== null;
      if (
        original.parked.includes(member.characterID) ||
        original.stayed?.includes(member.characterID)
      ) {
        if (
          (flight.transition && flight.transition.phase !== "ready") ||
          !(
            (flight.docked && positive(flight.stationID ?? flight.structureID)) ||
            (original.stayed?.includes(member.characterID) &&
              flight.shipMode?.toUpperCase() === "STOP")
          )
        )
          throw Error(
            "Previous settlement is retained, but current physical Parking is not verified.",
          );
        ended = true;
        unregister();
        heldSession.flow.setLivePush(false);
        group.busy.delete(run.characterID);
        publish({
          status: "stopped",
          phase: flight.docked
            ? "Docked; retained freight settled"
            : "Settled in place; retained freight settled",
          why: lastFlight,
          readout: {
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
            characterID: member.characterID,
            shipID: member.shipID,
            groupCompleted: original.state === "STOPPED",
          },
        });
        return;
      }
      const checkModules = () =>
        deps.quiescence
          ? deps.quiescence(operational, heldSession, member, current)
          : nativeQuiescence(
              operational,
              heldSession,
              member,
              current,
              flight.inSpace ? attemptedShutdowns : undefined,
            );
      const settlementOptions = {
        report: (why: string) => reportProgress("Recalling drones", why),
        verifyRetainedModules: async () => {
          await checkModules();
        },
      };
      const quiescent = await (deps.settle ?? settleFleetMember)(
        operational,
        heldSession,
        current,
        settlementOptions,
      );
      if (
        !alreadySettled &&
        !group.unstarted &&
        original.jetcanIntents[String(member.characterID)]?.dispatched
      ) {
        const reason =
          "Original Jettison was dispatched. Exact container and source-hold proof is required; no deposit or replay.";
        if (!quiescent.modulesInactive || !quiescent.dronesSafe) throw Error(reason);
        // Keep the unknown cargo receipt. Docking the same controlled hull is
        // independent of the missing container, and carries no inventory write.
        if (!flight.docked) {
          if (parkingSetup.parking?.mode === "STAY_IN_PLACE") throw Error(reason);
          const result = await (deps.park ?? finishParking)(
            operational,
            heldSession,
            parkingSetup,
            member.shipID,
            current,
            deps.document,
            { preserveCargo: true },
          );
          current();
          flight = await flightNow();
          if (
            result.kind !== "dock" ||
            !flight.docked ||
            (flight.stationID ?? flight.structureID) !== result.proof.locationID
          )
            throw Error(reason);
        }
        ended = true;
        unregister();
        heldSession.flow.setLivePush(false);
        group.busy.delete(run.characterID);
        publish({
          status: "error",
          phase: "Docked; recovery pending",
          why: lastFlight + " " + reason,
        });
        return;
      }
      let atDelivery = atOriginalDelivery();
      if (
        original.stopFreight === "RETURN_HOME" &&
        member.role === "HAULER" &&
        (pendingOwnDeposit || hasHaulWork(original, member.characterID, true))
      ) {
        const native = createNativeHauler(operational, heldSession, {
          shipID: member.shipID,
          corporationID: setup.corporationID,
          division: setup.division,
          ...(setup.delivery ? { delivery: setup.delivery } : {}),
          current,
          ownFreight,
          tripDocument: (m, generation) =>
            deps.document(
              fleetHaulDocumentKey(
                setup.operationID,
                setup.operationRunID,
                m.containerID,
                generation,
                member.characterID,
                member.shipID,
              ),
            ),
        });
        await createRawMembers(op).hauler(member.characterID, native);
        current();
      }
      if (pendingOwnDeposit && original.stopFreight !== "RETURN_HOME" && !atDelivery)
        throw Error("Original Hauler deposit requires readback at the delivery dock; no replay.");
      if (flight.inSpace && !alreadySettled && !group.unstarted) {
        const cycle = producer
          ? readCycle(deps.cycleDocument(member.characterID, setup), setup, member, true).record
          : null;
        const ownFreight = hasHaulWork(op.snapshot(), member.characterID);
        const rows = producer
          ? await (deps.readHolds ?? readNativeShipHolds)(
              heldSession,
              current,
              member.characterID,
              member.shipID,
            )
          : [];
        const facts = rows.length
          ? await (
              deps.rawFacts ??
              ((r: PluginRunContext, c: () => void, ids: readonly number[]) =>
                createRawTypeFacts(r, c)(ids))
            )(operational, current, [...new Set(rows.map((r) => r.typeID))])
          : {};
        current();
        if (
          rows.some(
            (r) =>
              r.ownerID !== member.characterID ||
              r.locationID !== member.shipID ||
              !facts[r.typeID] ||
              (r.categoryID !== null && r.categoryID !== facts[r.typeID]!.categoryID),
          )
        )
          throw Error("Held cargo identity could not be verified for recovery.");
        if (
          cycle?.pending ||
          ownFreight ||
          (finishDeposit && rows.some((r) => facts[r.typeID]?.categoryID === 25)) ||
          !!(tripDoc.read() as { pending?: unknown } | null)?.pending
        ) {
          if (deps.deliveryPark)
            await deps.deliveryPark(operational, heldSession, delivery, reportProgress, current, {
              expectedShipID: member.shipID,
            });
          else
            await finishParking(
              {
                ...operational,
                report: (r) => reportProgress(r.phase ?? "Parking at delivery", r.why ?? ""),
              },
              heldSession,
              { ...setup, parking: delivery },
              member.shipID,
              current,
              deps.document,
              { preserveCargo: true, forDelivery: true },
            );
          flight = await flightNow();
          atDelivery = atOriginalDelivery();
          if (!atDelivery) throw Error("Original delivery dock could not be verified.");
        }
      }
      const inactive = await (deps.quiescence ?? nativeQuiescence)(
        operational,
        heldSession,
        member,
        current,
      );
      current();
      const parkSettled = async () => {
        const parking = await (deps.park ?? finishParking)(
          operational,
          heldSession,
          parkingSetup,
          member.shipID,
          current,
          deps.document,
        );
        current();
        flight = await flightNow();
        const final = await (deps.settle ?? settleFleetMember)(
          operational,
          heldSession,
          current,
          settlementOptions,
        );
        await (deps.quiescence ?? nativeQuiescence)(operational, heldSession, member, current);
        current();
        if (!final.modulesInactive || !final.dronesSafe)
          throw Error("Final Parking settlement remains unresolved.");
        const accepted =
          parking.kind === "stay"
            ? op.stayMember(member.characterID, { ...parking.proof, runID: setup.operationRunID })
            : op.parkMember(member.characterID, { ...parking.proof, runID: setup.operationRunID });
        if (!accepted) throw Error("Operation Parking proof remains blocked.");
        const groupCompleted = op.snapshot().state === "STOPPED";
        if (groupCompleted && group.timer) {
          clearInterval(group.timer);
          group.timer = null;
        }
        ended = true;
        unregister();
        heldSession.flow.setLivePush(false);
        group.busy.delete(run.characterID);
        publish({
          status: "stopped",
          phase:
            parking.kind === "stay"
              ? "Settled in place; retained freight settled"
              : "Docked; retained freight settled",
          readout: {
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
            characterID: member.characterID,
            shipID: member.shipID,
            groupCompleted,
          },
        });
      };
      if (alreadySettled) {
        // Runtime committed the hold and module settlement before Parking.
        // Resume only the Parking policy and its original unload journal.
        const snapshot = op.snapshot();
        if (
          snapshot.jetcanIntents[String(member.characterID)] ||
          hasHaulWork(snapshot, member.characterID)
        )
          throw Error(
            "Stored settlement conflicts with an original cargo intent. Reconcile the exact receipt before Parking.",
          );
        const cycleDoc = deps.cycleDocument(member.characterID, setup);
        if (producer && !group.unstarted && cycleDoc.read() !== null)
          closeCycle(cycleDoc, setup, member, run.botID);
        await parkSettled();
        return;
      }
      if (producer && !group.unstarted) {
        const cycleDoc = deps.cycleDocument(member.characterID, setup),
          { record, oldBotID } = readCycle(cycleDoc, setup, member, true),
          pending = record.pending;
        if (pending && !atDelivery)
          throw Error(
            (flight.inSpace ? "Pilot is still in space. " : "") +
              "Pending " +
              pending.kind +
              " requires the original delivery dock for read-only reconciliation. Dock there and run FINISH again.",
          );
        if (pending?.kind === "mining-cycle") {
          const family = setup.site?.target.kind === "ICE" ? "ice" : "ore";
          const d = pending.details,
            active = pending.activeProof,
            claim = op.snapshot().claim;
          let scope: unknown;
          try {
            scope = JSON.parse(d?.scope);
          } catch {
            throw Error("Pending mining cycle scope is malformed.");
          }
          if (
            record.closed ||
            pending.ownerRunID !== oldBotID ||
            !positive(pending.issuedAt) ||
            !obj(d) ||
            ![d.moduleID, d.typeID, d.flagID, d.targetID, d.oreTypeID].every(positive) ||
            !Number.isSafeInteger(d.before) ||
            d.before < 0 ||
            !obj(active) ||
            active.moduleID !== d.moduleID ||
            active.typeID !== d.typeID ||
            active.ownerID !== member.characterID ||
            active.shipID !== member.shipID ||
            active.flagID !== d.flagID ||
            !Array.isArray(scope) ||
            scope.length !== 5 ||
            scope[0] !== record.identity ||
            !claim ||
            scope[1] !== claim.key ||
            scope[2] !== claim.generation ||
            scope[3] !== d.targetID ||
            scope[4] !== d.oreTypeID ||
            !obj(pending.originalLock) ||
            pending.originalLock.ownerRunID !== oldBotID ||
            pending.originalLock.details?.targetID !== d.targetID ||
            pending.originalLock.details?.scope !== d.scope ||
            !obj(pending.attempt) ||
            pending.attempt.characterID !== member.characterID ||
            pending.attempt.shipID !== member.shipID ||
            pending.attempt.moduleID !== d.moduleID ||
            pending.attempt.targetID !== d.targetID ||
            pending.attempt.mission !== d.scope ||
            !inactive ||
            inactive.source !== "native-fitted-modules" ||
            inactive.characterID !== member.characterID ||
            inactive.shipID !== member.shipID ||
            inactive.modules.filter(
              (m) => m.moduleID === d.moduleID && m.typeID === d.typeID && m.flagID === d.flagID,
            ).length !== 1 ||
            Date.now() - inactive.observedAt > 15000
          )
            throw Error("Pending mining cycle identity or inactivity is uncertain.");
          current();
          const observed = decodeModuleObservation(
            await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [d.moduleID]),
            {
              moduleID: d.moduleID,
              typeID: d.typeID,
              ownerID: member.characterID,
              shipID: member.shipID,
              flagID: d.flagID,
            },
          );
          current();
          const rows = await (deps.readHolds ?? readNativeShipHolds)(
            session,
            current,
            member.characterID,
            member.shipID,
          );
          current();
          if (
            rows.some(
              (r) =>
                r.ownerID !== member.characterID ||
                r.locationID !== member.shipID ||
                ![5, 134, 181, 182].includes(r.flagID) ||
                !positive(r.itemID) ||
                !positive(r.typeID) ||
                !Number.isSafeInteger(r.quantity) ||
                r.quantity < 0,
            )
          )
            throw Error("Pending mining hold identity is uncertain.");
          const resourceFacts = await (
            deps.rawFacts ??
            ((r: PluginRunContext, c: () => void, ids: readonly number[]) =>
              createRawTypeFacts(r, c)(ids))
          )(operational, current, [d.oreTypeID]);
          current();
          const fact = resourceFacts[d.oreTypeID];
          if (
            !fact ||
            fact.categoryID !== 25 ||
            fact.freightKind !== "RAW" ||
            fact.resourceFamily !== family ||
            !Number.isFinite(fact.unitVolumeM3) ||
            fact.unitVolumeM3 <= 0 ||
            rows.some(
              (r) => r.typeID === d.oreTypeID && r.categoryID !== null && r.categoryID !== 25,
            )
          )
            throw Error("Pending mining yield type does not match the native resource family.");
          const after = rows
              .filter((r) => r.typeID === d.oreTypeID)
              .reduce((n, r) => n + r.quantity, 0),
            gain = after - d.before;
          const timing =
            family === "ice" ? iceCycleTiming(active as any, observed, d.targetID, gain) : null;
          if (
            family === "ice"
              ? !timing
              : !observedOreCycleSettled(active as any, observed, d.targetID, gain)
          )
            throw Error("Pending mining cycle native effect or current cargo is uncertain.");
          const dock = decodeFlightStatus((await getFlightStatus(options)).flight);
          current();
          if (
            !dock.docked ||
            dock.inSpace ||
            (dock.stationID ?? dock.structureID) !== setup.destinationID ||
            (setup.delivery &&
              (setup.delivery.kind === "station"
                ? dock.stationID !== setup.destinationID
                : dock.structureID !== setup.destinationID)) ||
            dock.shipID !== member.shipID ||
            dock.solarSystemID !== (setup.delivery?.systemID ?? setup.systemID) ||
            (dock.transition && dock.transition.phase !== "ready") ||
            Date.now() - inactive.observedAt > 15000
          )
            throw Error("Fresh native dock identity is unavailable.");
          const latest = readCycle(cycleDoc, setup, member, true).record;
          if (JSON.stringify(latest) !== JSON.stringify(record))
            throw Error("Pending mining journal changed during observation.");
          current();
          cycleDoc.write({
            ...record,
            pending: null,
            lastCycle: {
              ...pending,
              activeObserved: true,
              gain,
              observedAt: Date.now(),
              ...(timing ? { iceTiming: timing } : {}),
              reconciledReadOnly: true,
              recovery: { oldBotID, finishBotID: run.botID, dock, afterQuantity: after },
            },
          });
        } else if (pending !== null) {
          let scope: unknown;
          try {
            scope = JSON.parse(pending.details?.scope);
          } catch {
            throw Error("Pending target lock scope is malformed.");
          }
          const claim = op.snapshot().claim;
          if (
            record.closed ||
            record.nextOrdinal !== 1 ||
            record.lastCycle != null ||
            record.lastActivationRefusal != null ||
            pending.kind !== "target-lock" ||
            pending.ownerRunID !== oldBotID ||
            !positive(pending.issuedAt) ||
            !positive(pending.details?.targetID) ||
            !Array.isArray(scope) ||
            scope.length !== 5 ||
            scope[0] !== record.identity ||
            !claim ||
            scope[1] !== claim.key ||
            scope[2] !== claim.generation ||
            scope[3] !== pending.details.targetID ||
            !positive(scope[4]) ||
            (record.retiredLocks !== undefined && !Array.isArray(record.retiredLocks))
          )
            throw Error("Pending mining action requires reconciliation.");
          if (
            !inactive ||
            inactive.source !== "native-fitted-modules" ||
            inactive.characterID !== member.characterID ||
            inactive.shipID !== member.shipID ||
            !Number.isFinite(inactive.observedAt) ||
            inactive.observedAt > Date.now() ||
            Date.now() - inactive.observedAt > 15000 ||
            !Array.isArray(inactive.modules) ||
            !inactive.modules.length ||
            inactive.modules.some(
              (m) => !positive(m.moduleID) || !positive(m.typeID) || !positive(m.flagID),
            )
          )
            throw Error("Fresh native module inactivity proof is unavailable.");
          const targetsResponse = await run.fetch(new URL("/api/bridge/targets", run.baseUrl)),
            targets = await targetsResponse.json();
          current();
          if (
            !targetsResponse.ok ||
            targets?.ok !== true ||
            !Array.isArray(targets.targetIDs) ||
            targets.targetIDs.length !== 0
          )
            throw Error("Native target lock state is not confirmed empty.");
          const dock = decodeFlightStatus((await getFlightStatus(options)).flight);
          current();
          if (
            !dock.docked ||
            dock.inSpace ||
            (dock.stationID ?? dock.structureID) !== setup.destinationID ||
            (setup.delivery &&
              (setup.delivery.kind === "station"
                ? dock.stationID !== setup.destinationID
                : dock.structureID !== setup.destinationID)) ||
            dock.shipID !== member.shipID ||
            dock.solarSystemID !== (setup.delivery?.systemID ?? setup.systemID) ||
            (dock.transition && dock.transition.phase !== "ready") ||
            Date.now() - inactive.observedAt > 15000
          )
            throw Error("Fresh native dock identity is unavailable.");
          const latest = readCycle(cycleDoc, setup, member, true).record;
          if (JSON.stringify(latest) !== JSON.stringify(record))
            throw Error("Pending mining journal changed during observation.");
          current();
          cycleDoc.write({
            ...record,
            pending: null,
            retiredLocks: [
              ...(record.retiredLocks ?? []),
              {
                intent: pending,
                outcome: "RETIRED_AFTER_CONFIRMED_DOCK",
                originalOutcome: "UNKNOWN",
                oldBotID,
                finishBotID: run.botID,
                nativeEvidence: { dock, inactive, targetIDs: [], observedAt: Date.now() },
              },
            ],
          });
        }
      }
      if (producer && !group.unstarted && setup.oreLogistics?.remoteCompression) {
        const old = readCycle(
            deps.cycleDocument(member.characterID, setup),
            setup,
            member,
          ).oldBotID,
          doc = deps.document(
            `mining-fleet-compression:${JSON.stringify([setup.operationID, setup.operationRunID, old, member.characterID, member.shipID])}`,
          );
        if (doc.read() !== null) {
          const controller = createCompressionController({
            operationID: setup.operationID,
            runID: setup.operationRunID,
            run: operational,
            session,
            shipID: member.shipID,
            systemID: setup.systemID,
            reconcileSystemID: flight.solarSystemID!,
            document: doc,
            current,
            beforeDispatch: () => {
              throw Error("FINISH cannot dispatch compression.");
            },
            facility: async () => {
              throw Error("FINISH cannot acquire a new compression facility.");
            },
          });
          if (controller.snapshot().pending && !(await controller.reconcile()))
            throw Error("Original compression outcome remains unknown; no deposit or replay.");
        }
      }
      if (!group.unstarted && !atDelivery) {
        if (hasHaulWork(op.snapshot(), member.characterID))
          throw Error(
            "Retained freight must be reconciled at the original delivery destination before Parking.",
          );
        if (producer) {
          const rows = await (deps.readHolds ?? readNativeShipHolds)(
              session,
              current,
              member.characterID,
              member.shipID,
            ),
            facts = rows.length
              ? await (
                  deps.rawFacts ??
                  ((r: PluginRunContext, c: () => void, ids: readonly number[]) =>
                    createRawTypeFacts(r, c)(ids))
                )(operational, current, [...new Set(rows.map((r) => r.typeID))])
              : {};
          current();
          if (
            rows.some(
              (r) =>
                r.ownerID !== member.characterID ||
                r.locationID !== member.shipID ||
                !facts[r.typeID] ||
                (r.categoryID !== null && r.categoryID !== facts[r.typeID]!.categoryID) ||
                (finishDeposit && facts[r.typeID]!.categoryID === 25),
            )
          )
            throw Error("Native resource holds are not verified for retained FINISH.");
          const deposit = depositDoc.read();
          if (
            deposit !== null &&
            (!obj(deposit) ||
              deposit.pending !== null ||
              !obj(deposit.receipt) ||
              deposit.receipt.source?.operationID !== setup.operationID ||
              deposit.receipt.source?.runID !== setup.operationRunID ||
              deposit.receipt.source?.characterID !== member.characterID ||
              deposit.receipt.source?.shipID !== member.shipID)
          )
            throw Error(
              "Original deposit receipt is unresolved at another dock; no inventory replay.",
            );
          const trip = tripDoc.read();
          if (trip !== null) {
            if (!obj(trip) || trip.pending !== null)
              throw Error(
                "Original self-unload trip is unresolved; native arrival alone cannot clear it.",
              );
            readSelfUnloadTotals(
              trip,
              JSON.stringify([
                setup.operationID,
                setup.operationRunID,
                member.characterID,
                member.shipID,
              ]),
            );
          }
        }
      }
      if (group.unstarted) {
        const neverStarted = group
            .launch!.members.filter((m) => m.status === "PREPARED")
            .map((m) => m.characterID),
          hash = createHash("sha256")
            .update(
              JSON.stringify([
                setup.operationID,
                setup.operationRunID,
                group.launch!.setupHash,
                neverStarted,
              ]),
            )
            .digest("hex");
        if (op.snapshot().unstartedFinish && op.snapshot().unstartedFinish!.receiptHash !== hash)
          throw Error("Original no-dispatch proof changed.");
        for (const entry of Object.values(deps.board.snapshot()))
          if (
            entry.claim?.operationID === setup.operationID &&
            entry.claim.runID === setup.operationRunID
          ) {
            const fresh = deps.board.read(entry.claim.key);
            if (
              fresh &&
              (fresh.state !== "RESERVED" ||
                !fresh.claim ||
                fresh.claim.generation !== entry.claim.generation ||
                !deps.board.releaseReserved(fresh.claim))
            )
              throw Error("Original nonproductive reservation cannot be released.");
          }
        if (
          !op.snapshot().stoppedBeforeWork &&
          !op.snapshot().unstartedFinish &&
          !op.beginUnstartedFinish(neverStarted, hash, {
            source: "native-retained-finish",
            characterID: member.characterID,
            runID: setup.operationRunID,
            shipID: member.shipID,
            ...quiescent,
          })
        )
          throw Error("Incomplete assembly is not proved nonproductive.");
      }
      if (op.snapshot().relocation && !op.cancelRelocation())
        throw Error("Pending relocation cannot be canceled without losing its original claim.");
      const intent = op.snapshot().jetcanIntents[String(member.characterID)];
      if (intent?.dispatched)
        throw Error(
          "Original Jettison was dispatched. Exact container and source-hold proof is required; no deposit or replay.",
        );
      if (intent && !op.cancelPreparedJetcan(member.characterID, intent.generation))
        throw Error("Original undispatched Jettison could not be canceled.");
      if (!group.draining) {
        const { claim, stopFreight } = op.snapshot();
        if (
          claim &&
          !deps.board.resumeDraining(claim) &&
          !(
            stopFreight === "RETURN_HOME" &&
            claim.key.startsWith("BELT:") &&
            !deps.board.retains(claim)
          )
        )
          throw Error("Retained target ownership cannot be resumed.");
        if (
          !op.beginRetainedFinish(member.characterID, {
            source: "native-retained-finish",
            runID: setup.operationRunID,
            shipID: member.shipID,
            ...quiescent,
          })
        )
          throw Error("Operation cannot enter retained-freight settlement.");
        group.draining = true;
        group.timer = setInterval(() => {
          try {
            if (op.snapshot().state === "STOPPED") {
              if (group.timer) clearInterval(group.timer);
              group.timer = null;
              return;
            }
            if (op.snapshot().claim && !op.heartbeat()) group.lost = true;
          } catch {
            group.lost = true;
          }
        }, 8000);
        group.timer.unref?.();
      }
      const receiptDoc = deps.document(
        `mining-fleet-finish:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
      );
      let receipt = receiptDoc.read();
      if (receipt !== null && !obj(receipt)) throw Error("Finish receipt is malformed.");
      if (
        !group.unstarted &&
        atDelivery &&
        (member.role === "HAULER" ||
          (member.role === "COMMAND" && setup.supportPolicy?.collection === "TRACTOR_AND_COLLECT"))
      ) {
        const haulReceiptDoc = producer
          ? deps.document(
              `mining-fleet-finish-haul:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
            )
          : receiptDoc;
        let receipt = haulReceiptDoc.read();
        const dockedOnly = {
          ...session,
          flow: new Proxy(session.flow, {
            get(target, key, receiver) {
              if (key === "startRoute")
                return async () => {
                  throw Error("Finish never starts a route.");
                };
              return Reflect.get(target, key, receiver);
            },
          }),
        } as PilotSession;
        const snapshot = op.snapshot();
        const pending = snapshot.manifests.filter(
          (m) => !m.delivered && haulOwner(snapshot, m)?.characterID === member.characterID,
        );
        const tripDocument = (m: Manifest, generation: number) =>
          deps.document(
            fleetHaulDocumentKey(
              setup.operationID,
              setup.operationRunID,
              m.containerID,
              generation,
              member.characterID,
              member.shipID,
            ),
          );
        const batched =
          member.role === "HAULER" &&
          !deps.recoverHaul &&
          pending.some((m) => {
            const saved = tripDocument(m, haulOwner(snapshot, m)!.generation).read() as {
              events?: { kind: string; after?: { batch?: unknown } }[];
              pending?: { kind: string; before?: { scene?: unknown } };
            } | null;
            return (
              saved?.events?.some((e) => e.kind === "pickup" && e.after?.batch) ||
              saved?.pending?.before?.scene
            );
          });
        const detachedReturnHome =
          member.role === "HAULER" &&
          snapshot.stopFreight === "RETURN_HOME" &&
          snapshot.claim?.key.startsWith("BELT:") &&
          !deps.board.retains(snapshot.claim);
        if (
          batched ||
          pendingOwnDeposit ||
          (detachedReturnHome && pending.length && !deps.recoverHaul)
        ) {
          // This actor is already verified docked at the original delivery location.
          // Settle known cargo with the same trip receipts without resuming pickup.
          const native = createNativeHauler(operational, dockedOnly, {
            shipID: member.shipID,
            corporationID: setup.corporationID,
            division: setup.division,
            ...(setup.delivery ? { delivery: setup.delivery } : {}),
            current,
            tripDocument,
            ownFreight,
            stopBeforePickup: () => true,
          });
          await createRawMembers(op).hauler(member.characterID, native);
          current();
        } else if (pending.length) {
          if (pending.length > 1)
            throw Error(
              "Multiple original haul claims of this pilot require separate reconciliation.",
            );
          const m = pending[0]!,
            claim = haulOwner(op.snapshot(), m);
          if (!claim || claim.characterID !== member.characterID || claim.dispatched !== true)
            throw Error("Retained haul claim is not a dispatched claim of this pilot.");
          const doc = deps.document(
            fleetHaulDocumentKey(
              setup.operationID,
              setup.operationRunID,
              m.containerID,
              claim.generation,
              member.characterID,
              member.shipID,
            ),
          );
          let proof: DeliveryEvidence;
          if (
            obj(receipt) &&
            receipt.version === 1 &&
            receipt.role === member.role &&
            receipt.characterID === member.characterID &&
            receipt.shipID === member.shipID &&
            receipt.proof
          )
            proof = receipt.proof as DeliveryEvidence;
          else {
            if (receipt !== null) throw Error("Finish haul receipt differs.");
            proof = deps.recoverHaul
              ? await deps.recoverHaul(
                  operational,
                  dockedOnly,
                  setup,
                  member,
                  m,
                  claim.generation,
                  current,
                  doc,
                )
              : await createNativeHauler(operational, dockedOnly, {
                  shipID: member.shipID,
                  corporationID: setup.corporationID,
                  division: setup.division,
                  ...(setup.delivery ? { delivery: setup.delivery } : {}),
                  current,
                  tripDocument: () => doc,
                  ...(member.role === "COMMAND" && setup.supportPolicy?.compressCollectedOre
                    ? {
                        recoverConversion: (item, manifest, generation) => {
                          const old =
                            group.launch?.members.find((m) => m.characterID === member.characterID)
                              ?.botID ??
                            (producer
                              ? readCycle(
                                  deps.cycleDocument(member.characterID, setup),
                                  setup,
                                  member,
                                ).oldBotID
                              : null);
                          if (!old)
                            throw Error(
                              "Original collection bot ID is unavailable; transformed cargo remains fenced.",
                            );
                          return recoverCollectedConversion(
                            operational,
                            session!,
                            setup,
                            member,
                            old,
                            item,
                            manifest,
                            generation,
                            current,
                            deps.document,
                          );
                        },
                      }
                    : {}),
                }).recoverHeldAndDeliver(m, claim.generation, setup.destinationID);
            current();
            receipt = {
              version: 1,
              role: member.role,
              characterID: member.characterID,
              shipID: member.shipID,
              proof,
            };
            haulReceiptDoc.write(receipt);
          }
          if (!op.markDelivered(member.characterID, proof))
            throw Error("Retained delivery proof could not be settled.");
        }
      } else if (
        !group.unstarted &&
        !producer &&
        member.role !== "HAULER" &&
        member.role !== "COMMAND" &&
        member.role !== "DEFENDER"
      )
        throw Error("Unsupported retained fleet role.");
      if (!group.unstarted && !atDelivery && producer) {
        const empty = {
          runID: setup.operationRunID,
          shipID: member.shipID,
          rawRemaining: [],
          observedAt: Date.now(),
        };
        if (
          setup.haulMode === "SELF_UNLOAD" &&
          !op.recordSelfUnloadFinal(member.characterID, { source: "native-self-unload", ...empty })
        )
          throw Error("Final self-unload hold proof is unavailable.");
        if (
          member.role === "COMMAND" &&
          !op.recordCommandMiningFinal(member.characterID, {
            source: "native-command-mining-final",
            ...empty,
          })
        )
          throw Error("Final COMMAND hold proof is unavailable.");
        closeCycle(deps.cycleDocument(member.characterID, setup), setup, member, run.botID);
      }
      if (
        !group.unstarted &&
        atDelivery &&
        setup.haulMode === "SELF_UNLOAD" &&
        producer &&
        finishSelfUnload
      ) {
        // Reuse the exact original trip/deposit journals. Native arrival is already
        // required above, and this proxy prohibits a recovery route or docking order.
        const dockedOnly = {
          ...session,
          flow: new Proxy(session.flow, {
            get(target, key, receiver) {
              if (key === "startRoute")
                return async () => {
                  throw Error("FINISH never starts a route.");
                };
              if (key === "flying")
                return new Proxy(target.flying, {
                  get(f, k, r) {
                    if (k === "dockStep")
                      return async () => {
                        throw Error("FINISH never sends a docking order.");
                      };
                    return Reflect.get(f, k, r);
                  },
                });
              return Reflect.get(target, key, receiver);
            },
          }),
        } as PilotSession;
        const proof = deps.recoverSelfUnload
          ? await deps.recoverSelfUnload(operational, dockedOnly, setup, member, current)
          : await createNativeSelfUnload(operational, dockedOnly, {
              operationID: setup.operationID,
              runID: setup.operationRunID,
              shipID: member.shipID,
              resourceFamily: setup.site?.target.kind === "ICE" ? "ice" : "ore",
              allowCompressed: setup.oreLogistics?.remoteCompression === true,
              destinationID: setup.destinationID,
              corporationID: setup.corporationID,
              division: setup.division,
              ...(setup.delivery ? { delivery: setup.delivery } : {}),
              current,
              settle: async () => {
                const p = await (deps.settle ?? settleFleetMember)(operational, session!, current);
                if (!p.modulesInactive || !p.dronesSafe)
                  throw Error("Self-unload settlement remains unknown.");
              },
              store: deps.document(
                `mining-fleet-self-unload:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
              ),
              tripDocument: (ordinal) =>
                deps.document(
                  `mining-fleet-self-unload-trip:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID, ordinal])}`,
                ),
            }).trip();
        current();
        if (
          !op.recordSelfUnloadFinal(member.characterID, {
            source: "native-self-unload",
            runID: setup.operationRunID,
            shipID: member.shipID,
            ...proof,
          })
        )
          throw Error("Original self-unload trip or empty-hold proof remains unresolved.");
        if (
          member.role === "COMMAND" &&
          !op.recordCommandMiningFinal(member.characterID, {
            source: "native-command-mining-final",
            runID: setup.operationRunID,
            shipID: member.shipID,
            ...proof,
          })
        )
          throw Error("COMMAND final hold proof remains unresolved.");
        closeCycle(deps.cycleDocument(member.characterID, setup), setup, member, run.botID);
      } else if (producer && !group.unstarted && atDelivery && finishDeposit) {
        const readHolds = deps.readHolds ?? readNativeShipHolds,
          rawFacts =
            deps.rawFacts ??
            ((r: PluginRunContext, c: () => void, ids: readonly number[]) =>
              createRawTypeFacts(r, c)(ids));
        const classify = async () => {
          const rows = await readHolds(session!, current, member.characterID, member.shipID);
          current();
          const facts = rows.length
            ? await rawFacts(operational, current, [...new Set(rows.map((r) => r.typeID))])
            : {};
          current();
          return rows.filter((r) => {
            const fact = facts[r.typeID];
            if (
              !fact ||
              !positive(fact.categoryID) ||
              (r.categoryID !== null && r.categoryID !== fact.categoryID)
            )
              throw Error("Owned hold type is unreadable.");
            if (fact.categoryID !== 25) return false;
            if (
              !(
                fact.freightKind === "RAW" ||
                (setup.oreLogistics?.remoteCompression && fact.freightKind === "COMPRESSED")
              ) ||
              !Number.isFinite(fact.unitVolumeM3) ||
              fact.unitVolumeM3 <= 0 ||
              (setup.site?.target.kind === "ICE"
                ? fact.resourceFamily !== "ice"
                : fact.resourceFamily != null && fact.resourceFamily !== "ore") ||
              !(
                r.flagID === 5 ||
                r.flagID === 134 ||
                (r.flagID === 181 && fact.resourceFamily === "ice")
              )
            )
              throw Error("Owned specialty freight is not verified for the target.");
            return true;
          });
        };
        if (receipt === null) {
          const present = await classify(),
            saved = depositDoc.read();
          let source: OwnShipRawSource = {
            kind: setup.oreLogistics?.remoteCompression ? "own-ship-freight" : "own-ship-raw",
            operationID: setup.operationID,
            runID: setup.operationRunID,
            characterID: member.characterID,
            shipID: member.shipID,
            items: present.map((i) => ({
              itemID: i.itemID,
              typeID: i.typeID,
              quantity: i.quantity,
            })),
          };
          if (saved !== null) {
            if (!obj(saved) || typeof saved.identity !== "string")
              throw Error("Raw deposit journal is malformed.");
            let old: unknown;
            try {
              old = JSON.parse(saved.identity);
            } catch {
              throw Error("Raw deposit identity is malformed.");
            }
            if (
              !Array.isArray(old) ||
              old.length !== (setup.delivery ? 6 : 5) ||
              (setup.delivery && JSON.stringify(old[5]) !== JSON.stringify(setup.delivery)) ||
              !obj(old[0]) ||
              !["own-ship-raw", "own-ship-freight"].includes(old[0].kind) ||
              old[0].operationID !== setup.operationID ||
              old[0].runID !== setup.operationRunID ||
              old[0].characterID !== member.characterID ||
              old[0].shipID !== member.shipID ||
              old[1] !== setup.destinationID ||
              old[2] !== (setup.corporationID ?? null) ||
              old[3] !== (setup.division ?? null) ||
              !Array.isArray(old[0].items) ||
              !old[0].items.length
            )
              throw Error("Raw deposit journal belongs to another source.");
            source = old[0] as OwnShipRawSource;
          }
          const deposit = source.items.length
            ? await (deps.depositOwnedRaw ?? depositOwnShipRaw)(operational, session, {
                source,
                ...(source.kind === "own-ship-freight" ? { freightKind: "ANY" as const } : {}),
                destinationID: setup.destinationID,
                corporationID: setup.corporationID,
                division: setup.division,
                ...(setup.delivery ? { delivery: setup.delivery } : {}),
                current,
                document: depositDoc,
              })
            : null;
          current();
          if (
            deposit &&
            (JSON.stringify(deposit.source) !== JSON.stringify(source) ||
              deposit.destinationID !== setup.destinationID ||
              deposit.corporationID !== (setup.corporationID ?? null) ||
              deposit.division !== (setup.division ?? null) ||
              JSON.stringify(deposit.delivery ?? null) !== JSON.stringify(setup.delivery ?? null) ||
              !positive(deposit.officeID) ||
              !Number.isFinite(deposit.completedAt) ||
              !Array.isArray(deposit.batches) ||
              deposit.batches.length !== source.items.length ||
              source.items.some(
                (i) =>
                  deposit.batches.filter(
                    (b) =>
                      b?.item?.itemID === i.itemID &&
                      b.item.typeID === i.typeID &&
                      b.item.quantity === i.quantity,
                  ).length !== 1,
              ))
          )
            throw Error("Native raw deposit receipt is incomplete.");
          if ((await classify()).length)
            throw Error("Native raw ore remains in the ship after deposit.");
          receipt = {
            version: 1,
            role: member.role,
            characterID: member.characterID,
            shipID: member.shipID,
            deposit,
            rawHoldEmptyAt: Date.now(),
          };
          receiptDoc.write(receipt);
        }
        if (
          !obj(receipt) ||
          receipt.version !== 1 ||
          receipt.role !== member.role ||
          receipt.characterID !== member.characterID ||
          receipt.shipID !== member.shipID ||
          !Number.isFinite(receipt.rawHoldEmptyAt) ||
          receipt.rawHoldEmptyAt > Date.now() ||
          (await classify()).length
        )
          throw Error("Finish receipt or fresh raw-hold proof differs.");
        if (receipt.deposit === null) {
          if (depositDoc.read() !== null)
            throw Error("Empty-hold proof conflicts with an existing deposit journal.");
        } else {
          const d = receipt.deposit;
          if (
            !obj(d) ||
            !obj(d.source) ||
            !["own-ship-raw", "own-ship-freight"].includes(d.source.kind) ||
            d.source.operationID !== setup.operationID ||
            d.source.runID !== setup.operationRunID ||
            d.source.characterID !== member.characterID ||
            d.source.shipID !== member.shipID ||
            d.destinationID !== setup.destinationID ||
            d.corporationID !== (setup.corporationID ?? null) ||
            d.division !== (setup.division ?? null) ||
            JSON.stringify(d.delivery ?? null) !== JSON.stringify(setup.delivery ?? null) ||
            !positive(d.officeID) ||
            !Array.isArray(d.source.items) ||
            !d.source.items.length ||
            !Array.isArray(d.batches) ||
            d.batches.length !== d.source.items.length ||
            !Number.isFinite(d.completedAt) ||
            d.completedAt > Date.now()
          )
            throw Error("Native deposit receipt is malformed.");
        }
        closeCycle(deps.cycleDocument(member.characterID, setup), setup, member, run.botID);
        if (
          member.role === "COMMAND" &&
          !op.recordCommandMiningFinal(member.characterID, {
            source: "native-command-mining-final",
            runID: setup.operationRunID,
            shipID: member.shipID,
            rawRemaining: [],
            observedAt: Date.now(),
          })
        )
          throw Error("COMMAND final hold proof remains unresolved.");
      }
      if (
        producer &&
        !group.unstarted &&
        original.stopFreight &&
        !finishDeposit &&
        !finishSelfUnload &&
        deps.cycleDocument(member.characterID, setup).read() !== null
      )
        closeCycle(deps.cycleDocument(member.characterID, setup), setup, member, run.botID);
      const settled = await (deps.settle ?? settleFleetMember)(
        operational,
        session,
        current,
        settlementOptions,
      );
      await (deps.quiescence ?? nativeQuiescence)(operational, session, member, current);
      current();
      if (
        quiescent.modulesInactive !== true ||
        quiescent.dronesSafe !== true ||
        settled.modulesInactive !== true ||
        settled.dronesSafe !== true
      )
        throw Error("Physical settlement is unavailable.");
      if (
        !op.snapshot().settled.includes(member.characterID) &&
        !op.settleMember(member.characterID, {
          source: "native-settlement",
          runID: setup.operationRunID,
          shipID: member.shipID,
          ...settled,
        })
      )
        throw Error("Operation settlement remains blocked.");
      await parkSettled();
    };
    let pendingUnload: UnconfirmedHaulerUnload | undefined;
    let running: Promise<void> | null = null,
      retryRequested = false,
      retries = 0,
      timer: ReturnType<typeof setTimeout> | null = null;
    const clearRetry = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const attempt = () => {
      if (!active || ended) return;
      if (running) {
        retryRequested = true;
        return;
      }
      pendingUnload = undefined;
      running = work()
        .catch((error) => {
          if (!active || ended) return;
          if (error instanceof UnconfirmedHaulerUnload) pendingUnload = error;
          const why = [lastFlight, error instanceof Error ? error.message : String(error)]
            .filter(Boolean)
            .join(" ");
          if (
            !retryRequested &&
            (transientNativeRead(error) ||
              (error as { code?: string })?.code === "MCC_MODULE_SHUTDOWN_PENDING") &&
            retries < 3
          ) {
            publish({
              status: "paused",
              phase: "Retrying retained Parking",
              why: why + " The current owner will recheck native state.",
            });
            timer = setTimeout(
              () => {
                timer = null;
                attempt();
              },
              (deps.retryDelay ?? 3000) * ++retries,
            );
            timer.unref?.();
          } else
            publish({
              status: "paused",
              phase: "Fleet finish blocked",
              why,
              ...(pendingUnloadUnits === undefined ? {} : { readout: { pendingUnloadUnits } }),
            });
        })
        .finally(() => {
          running = null;
          if (retryRequested && !ended) {
            retryRequested = false;
            attempt();
          }
        });
    };
    const retry = () => {
      clearRetry();
      retries = 0;
      attempt();
    };
    try {
      const owner = await (deps.owner ?? runOwner)(run);
      current();
      if (dockedUnload && owner.toLowerCase() !== launched?.accountName.toLowerCase())
        throw Error("The retained Stop belongs to another pilot account.");
      unregister = (deps.register ?? registerRun)(
        run,
        owner,
        retry,
        run.resumed && !inputOf(run.setup) ? "mcc-resumed-stop" : "mcc-finish",
        () => {
          const pending = pendingUnload;
          if (!pending || !active || ended || running) return;
          return async () => {
            running = pending.checkAndRelease();
            try {
              await running;
              current();
              pendingUnload = undefined;
              retryRequested = true;
            } finally {
              running = null;
              if (retryRequested && active && !ended) {
                retryRequested = false;
                retry();
              }
            }
          };
        },
      );
    } catch (error) {
      group.busy.delete(run.characterID);
      throw error;
    }
    attempt();
    return {
      async stop() {
        active = false;
        clearRetry();
        if (running) await running;
        unregister();
        session?.flow.setLivePush(false);
        group.busy.delete(run.characterID);
        if (!group.busy.size) {
          if (group.timer) clearInterval(group.timer);
          group.timer = null;
          const key = JSON.stringify([input.operationID, input.operationRunID]);
          if (authorities.get(key) === group) authorities.delete(key);
        }
      },
    };
  }
}
