import { observeLocality, rankLocality, type LocalityRead } from "./locality.ts";
import { confirmFleetWipe, readShipLoss } from "./fleetWipe.ts";
import { quoteHullRepair, repairQuotedHull } from "../compat/flying.ts";
import { createFleetTelemetry, readFleetTelemetry, type FleetTelemetry } from "./telemetry.ts";
import { createPilotTiming, mccTimingEnabled, timed, type MccTiming } from "./timing.ts";
import type { FreightStatus } from "./freightPolicy.ts";
import { createCompressionController } from "./support/compressionController.ts";
import { createCompressionFacilityObserver } from "./support/compressionFacility.ts";
import {
  createNativeTravelAssist,
  TravelAssistPending,
  type MiningTravelAssist,
} from "./travelAssist.ts";
import { observeBurstCharge } from "./support/burstCharge.ts";
import { createNativeTractor } from "./support/nativeTractor.ts";
import { hasFleetHangar, UnconfirmedHaulerUnload } from "./dockedRawDeposit.ts";
import { haulerInventoryFlags } from "../shared/freightHolds.ts";
import { readNativeShipHolds } from "../shared/nativeInventory.ts";
import {
  decideSupportPolicy,
  missingCommandEquipment,
  type SupportPolicy,
  type SupportObservation,
} from "./support/supportPolicy.ts";
import { decideCoreService } from "./support/corePolicy.ts";
import { createBurstGroup, type BurstModule, type BurstUnit } from "./support/burstGroup.ts";
import { decodeFleetDelivery, type FleetDelivery } from "./delivery.ts";
import { createMiningDefender, DefenderStopBeforeAction, prepareHeldDefender } from "./defender.ts";
import { decodeMiningResourcePolicy, type MiningResourcePolicy } from "./resourcePolicy.ts";
import { ensureMiningAnchor } from "./anchorTravel.ts";
import {
  findMiningRallyPoint,
  reachMiningRallyPoint,
  type MiningRallyPoint,
} from "./rallyPoint.ts";
import {
  decodeOperationParking,
  observeSettledInPlace,
  parkAtOperationHome,
  type OperationParkingPolicy,
} from "./operationParking.ts";
import { uocStore } from "../backendStores.ts";
import { createHash } from "node:crypto";
import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession, type PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  authoritativeFleetMemberCharacterIDs,
  decodeFleetCenter,
  decodeFlightStatus,
  getFlightStatus,
  loadBoundFleet,
  leaveFleet,
} from "../../../web/src/plugin-api/flying.ts";
import { runOwner, runExpiry, registerRun, operationHasController } from "../runControl.ts";
import type { createFleetLaunchJournal } from "../operations/miningLaunchJournal.ts";
import type { FleetStartupPreparation } from "../operations/miningBind.ts";
import {
  decodeMiningPreparation,
  prepareHeldMiningMember,
} from "../operations/miningPreparationHost.ts";
import { readMiningOfficeAccess, requireMiningOfficeQuery } from "./corporateOffice.ts";
import { assertFleetDroneDeparture, recallFleetDrones } from "./droneRecall.ts";
import type { FleetSettlementOptions } from "./settle.ts";
import { parkNearest, parkWithPolicy } from "../shared/parking.ts";
import {
  createTargetBoard,
  targetKey,
  type Claim,
  type SynchronousStore,
  type Target,
} from "./targetBoard.ts";
import {
  createOperation,
  haulOwner,
  hasHaulWork,
  type OperationRecord,
  type Member,
  type Manifest,
  type StopFreightMode,
} from "./operation.ts";
import {
  createRawMembers,
  FreightGridUnavailable,
  GlobalLootClaimHeld,
  HaulStoppedBeforePickup,
  type RawMinerNative,
  type RawHaulerNative,
} from "./memberLoops.ts";
import { createNativeMiner, createNativeMiningNavigation } from "./nativeMember.ts";
import { createNativeBurst } from "./support/native.ts";
import { createNativeIndustrialCore } from "./support/nativeCore.ts";
import { createNativeCompressor } from "./support/nativeCompressor.ts";
import type { IndustrialCoreRead } from "./support/industrialObservation.ts";
import type { ModuleObservation } from "../shared/moduleObservation.ts";
import { readMiningReadiness } from "./nativeBelt.ts";
import { type BurstObservation } from "./support/controller.ts";
import {
  createCommandProof,
  type CommandProofScope,
  type CommandProofSample,
  type MiningProofQuote,
  type CommandActivationReceipt,
} from "./commandProof.ts";
import { HAULER_OWN_DEPOSIT_PREFIX, createNativeHauler } from "./nativeHauler.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { readDictPairs, readKeyVal, unwrapLong, type JsonValue } from "../shared/wire.ts";
import { fundHullRepair, refusedRepairCharge } from "./repairFunding.ts";
import {
  createFleetAssembly,
  SharedFleetConflict,
  type FleetAssemblyObservation,
  type FleetAssemblyPeer,
  type FleetMoveAuthorization,
} from "./fleetAssembly.ts";
import {
  fleetReadFailed,
  FleetObservationUnavailable,
  FleetShipChanged,
  FleetStopBeforeDispatch,
} from "./stopSignal.ts";
import { createNativeSelfUnload } from "./selfUnload.ts";
import { discardMiningCycles, miningCycleDocument } from "./miningCycle.ts";
import { deleteFleetExecution } from "./executionDocuments.ts";
import {
  deliveryReceiptIndex,
  finishedFleetExecution,
  fleetOperationStore,
  fleetRunResult,
  retainFleetRunResult,
  retiredFleetRuns,
  savedFleetExecution,
  summarizeFleetRun,
  unusedFleetExecution,
  type FleetOperationDocuments,
  type FleetOperationStore,
} from "./operationStore.ts";
import { createFleetFinishRun, readRetainedFleetTarget } from "./finish.ts";
import { finishParking, stopParkingSetup } from "./finishParking.ts";
import type { ParkingFreightRemaining } from "./parkingUnload.ts";
import { MINING_STOP_WINDOW_MINUTES } from "./shiftTiming.ts";
import { readAfterTimeout, transientNativeRead } from "../shared/progressDeadline.ts";
import { createSiteDiscovery, type NativeSite } from "./siteDiscovery.ts";
import { validSavedSiteClassification } from "./siteSelection.ts";
import { resolveMiningSite } from "./siteSearch.ts";
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function hullValue(value: JsonValue | undefined): number | null {
  const wrapped = value as { type?: unknown; value?: JsonValue } | null | undefined;
  if (wrapped?.type === "real" || wrapped?.type === "long") value = wrapped.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

export function readHullRatio(raw: JsonValue, shipID: number): number | null {
  const id = BigInt(shipID);
  const hull = readDictPairs(raw).find(([key]) => unwrapLong(key) === id)?.[1];
  const max = hullValue(readKeyVal(hull, "hullMax")),
    ratio = hullValue(readKeyVal(hull, "hullRatio"));
  return max !== null && max > 0 && ratio !== null && ratio >= 0 && ratio <= 1 ? ratio : null;
}
/** Match the board's reservation rules without adopting unresolved or drained targets. */
export function searchTargetAvailable(
  board: ReturnType<typeof createTargetBoard>,
  target: Target,
  operationID: string,
  runID: string,
  now: number = Date.now(),
): boolean {
  const key = targetKey(target);
  if (board.isDangerous(key)) return false;
  const entry = board.read(key);
  if (!entry || entry.state === "AVAILABLE") return true;
  return (
    (entry.state === "RESERVED" || entry.state === "ACTIVE") &&
    !!entry.claim &&
    entry.claim.expiresAt > now &&
    entry.claim.operationID === operationID &&
    entry.claim.runID === runID
  );
}
/** Bounded diagnostic only: selection precedes and does not imply a haul claim. */
/** Stable physical custody key; a new hosted bot does not create a new haul history. */
export function fleetHaulDocumentKey(
  operationID: string,
  operationRunID: string,
  containerID: number,
  generation: number,
  characterID: number,
  shipID: number,
) {
  if (
    !operationID ||
    !operationRunID ||
    ![containerID, generation, characterID, shipID].every(valid)
  )
    throw Error("Haul journal identity is invalid.");
  return `mining-fleet-haul:${JSON.stringify([operationID, operationRunID, containerID, generation, characterID, shipID])}`;
}
/** One immutable deadline for a retained deactivate, following stock cycle + freeze allowance. */
export function commandStopDeadline(
  snapshot: ReturnType<ReturnType<typeof createNativeBurst>["snapshot"]>,
  baseline?: BurstObservation | null,
): number | null {
  const pending = snapshot.pending;
  if (!pending || pending.kind !== "deactivate" || !Number.isFinite(pending.issuedAt)) return null;
  const previous = [...snapshot.history].reverse().find((h) => h.intent.kind === "activate"),
    recorded = (previous?.intent.before as Partial<BurstObservation> | undefined)?.cycleMs;
  const candidate =
    typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0
      ? recorded
      : baseline?.cycleMs;
  const cycle =
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.ceil(candidate)
      : 10000;
  return pending.issuedAt + Math.min(305000, cycle + 30000);
}
/** A returned ACK or an inactive reading alone cannot retire an unseen activation. */
export async function confirmIndustrialCoreInactive(
  core: Pick<ReturnType<typeof createNativeIndustrialCore>, "settle" | "reconcile" | "observe">,
  current: () => void,
  forStop = false,
) {
  await core.settle();
  current();
  const state = await core.reconcile();
  current();
  const observed = await core.observe();
  current();
  if (forStop) {
    if (observed.availability !== "available")
      throw Error("Industrial Core observation unavailable: " + observed.reason);
    if (observed.core.active) {
      const shutdown = state.current?.shutdown ?? state.standaloneShutdown;
      checkShutdownCycle(
        "Industrial Core",
        observed.core.effect,
        observed.core.timeFiletime,
        shutdown?.kind === "dispatch" ? shutdown.before.core.effect?.startFiletime : undefined,
      );
      return false;
    }
    if (state.current && !state.current.activation.effect && !state.current.activation.refusal)
      throw Error(
        "Industrial Core is inactive. Its original activation and fuel outcome remain unverified.",
      );
    if (!state.lastInactive || observed.effectObservedAt < state.lastInactive.effectObservedAt)
      throw Error("Industrial Core inactivity does not match its retained shutdown receipt.");
  }
  if (state.current && !state.current.activation.effect && !state.current.activation.refusal)
    return false;
  return (
    !!state.lastInactive &&
    observed.availability === "available" &&
    !observed.core.active &&
    observed.effectObservedAt >= state.lastInactive.effectObservedAt
  );
}
function checkShutdownCycle(
  label: string,
  effect: { startFiletime: string; durationMs: number } | null | undefined,
  timeFiletime: string,
  originalStart?: string,
) {
  if (
    !effect ||
    !/^\d+$/.test(timeFiletime) ||
    !/^\d+$/.test(effect.startFiletime) ||
    !Number.isFinite(effect.durationMs) ||
    effect.durationMs <= 0
  )
    throw Error(
      label + " is active but its native cycle is unreadable. Verify the module and retry Stop.",
    );
  const elapsed = BigInt(timeFiletime) - BigInt(effect.startFiletime);
  if (
    (originalStart && effect.startFiletime !== originalStart) ||
    elapsed < 0n ||
    elapsed > BigInt(Math.ceil(effect.durationMs * 10000))
  )
    throw Error(
      label +
        " is still active outside the observed native cycle. Verify the module and retry Stop.",
    );
}
/** Native ready-flight proof already rejects warp; Core does not require zero velocity. */
export function coreReadyForActivation(readiness: { ready: boolean }): boolean {
  return readiness.ready === true;
}
/** Fresh, held-ship evidence used before a self-mining commander may settle. */
export async function confirmCommandFinalHold(
  run: PluginRunContext,
  session: PilotSession,
  shipID: number,
  current: () => void,
) {
  current();
  const options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch },
    before = decodeFlightStatus((await getFlightStatus(options)).flight);
  current();
  if (
    before.shipID !== shipID ||
    !valid(before.solarSystemID) ||
    before.docked === before.inSpace ||
    (before.transition && before.transition.phase !== "ready")
  )
    throw Error("Command final hold flight identity is uncertain.");
  const fleetHangar = await hasFleetHangar(shipID, options);
  current();
  const rows = await readNativeShipHolds(
    session, current, run.characterID, shipID, fleetHangar ? haulerInventoryFlags : undefined,
  ),
    facts = rows.length
      ? await createRawTypeFacts(run, current)([...new Set(rows.map((r) => r.typeID))])
      : {};
  current();
  const after = decodeFlightStatus((await getFlightStatus(options)).flight);
  current();
  if (
    after.shipID !== shipID ||
    after.solarSystemID !== before.solarSystemID ||
    after.docked !== before.docked ||
    after.inSpace !== before.inSpace ||
    after.stationID !== before.stationID ||
    after.structureID !== before.structureID ||
    (after.transition && after.transition.phase !== "ready")
  )
    throw Error("Command final hold flight identity changed.");
  if (
    rows.some(
      (r) =>
        !facts[r.typeID] ||
        (r.categoryID !== null && r.categoryID !== facts[r.typeID]!.categoryID) ||
        facts[r.typeID]!.categoryID === 25,
    )
  )
    throw Error("Command final resource hold is not confirmed empty.");
  return {
    source: "native-command-mining-final" as const,
    shipID,
    rawRemaining: [] as readonly unknown[],
    observedAt: Date.now(),
  };
}
export interface FleetSetup {
  readonly startupPreparation?: FleetStartupPreparation;
  readonly operationID: string;
  readonly operationRunID: string;
  readonly systemID: number;
  readonly destinationID: number;
  readonly corporationID?: number;
  readonly division?: number;
  readonly delivery?: FleetDelivery;
  readonly beltID?: number;
  readonly beltName?: string;
  readonly beltCandidates?: readonly { beltID: number; beltName: string }[];
  readonly site?: NativeSite;
  readonly siteSearch?: { readonly family: "ORE" | "MOON" | "ICE" };
  readonly canCapacityM3: number;
  readonly resourcePolicy?: MiningResourcePolicy;
  readonly travelAssist?: "AUTO" | "DISABLED";
  readonly oreLogistics?: {
    readonly version: 1;
    readonly remoteCompression: boolean;
    readonly compressedJettisonFraction: number;
  };
  readonly supportPolicy?: SupportPolicy;
  readonly parking?: OperationParkingPolicy;
  readonly members: readonly Member[];
  readonly haulMode?: "SELF_UNLOAD";
  readonly fleetPolicy?: "EXISTING_ONLY" | "MANAGED";
  readonly fleetMoves?: readonly FleetMoveAuthorization[];
  readonly command?: {
    readonly moduleID?: number;
    readonly typeID?: number;
    readonly bursts?: readonly BurstModule[];
    readonly core?: { readonly moduleID: number; readonly typeID: number };
    readonly compressor?: { readonly moduleID: number; readonly typeID: number };
    readonly tractor?: { readonly moduleID: number; readonly typeID: number };
  };
}
export type CommandSupportView = {
  commander: { run: PluginRunContext; session: PilotSession; shipID: number; current: () => void };
  observeSupport: () => Promise<{
    core: IndustrialCoreRead;
    compressor: ModuleObservation;
    compressorEffectID: number;
    observedAt: number;
  }>;
};
export interface MiningCycle {
  droneIDs?(): readonly number[];
  getFreightStatus?(): FreightStatus | null;
  tick: RawMinerNative["mineCycle"];
  stop(): Promise<void>;
  release?(): Promise<void>;
  quote?(): Promise<MiningProofQuote>;
}
export interface FleetRuntimeDependencies {
  createCycle: (
    run: PluginRunContext,
    session: PilotSession,
    current: () => void,
    stopRequested: () => boolean,
    options?: {
      authority: () => { state: string; target: Target; claim: Claim | null } | null;
      commandSupport?: () => CommandSupportView | null;
      compressionDocument?: SynchronousStore;
      movementAdmission?: () => Promise<void>;
      movementArrived?: () => boolean;
      reportDrones?: (phase: string, why: string) => void;
      travelAssist?: MiningTravelAssist;
      timing?: MccTiming;
    },
  ) => Promise<MiningCycle>;
  /** Reads/recalls drones and settles modules, then returns native-confirmed proof. */
  settle: (
    run: PluginRunContext,
    session: PilotSession,
    current: () => void,
    droneOptions?: FleetSettlementOptions,
  ) => Promise<{ modulesInactive: true; dronesSafe: true; observedAt: number }>;
  storage?: FleetOperationDocuments;
  cycleDocument?: typeof miningCycleDocument;
  discardExecution?: (operationID: string, runID: string) => void;
  launchJournal?: (
    operationID: string,
    runID: string,
  ) => ReturnType<typeof createFleetLaunchJournal> | null;
  dockedUnloadsOnly?: boolean;
  attach?: typeof createPilotSession;
  park?: typeof parkNearest;
  searchSite?: typeof resolveMiningSite;
  anchor?: typeof ensureMiningAnchor;
  createDefender?: typeof createMiningDefender;
  prepareMember?: typeof prepareHeldMiningMember;
  createTractor?: typeof createNativeTractor;
  observeBurstCharge?: typeof observeBurstCharge;
}
function setupOf(value: unknown): FleetSetup | null {
  const x = value as FleetSetup;
  if (
    x?.beltCandidates !== undefined &&
    (!Array.isArray(x.beltCandidates) ||
      x.beltCandidates.length > 500 ||
      x.beltCandidates.some(
        (b) => !valid(b.beltID) || typeof b.beltName !== "string" || !b.beltName.trim(),
      ) ||
      new Set(x.beltCandidates.map((b) => b.beltID)).size !== x.beltCandidates.length ||
      new Set(x.beltCandidates.map((b) => b.beltName)).size !== x.beltCandidates.length)
  )
    return null;
  if (x?.supportPolicy !== undefined) {
    try {
      decideSupportPolicy(x.supportPolicy, null, null, Date.now());
    } catch {
      return null;
    }
    const p = x.supportPolicy;
    if (
      Object.keys(p).sort().join(",") !==
      "collection,compressCollectedOre,coreRequirement,enableCompression,maintainBursts,selfMining,supportLoss,tractor,useIndustrialCore"
    )
      return null;
    if (
      !x.command ||
      (x.command.tractor && !p.tractor) ||
      (x.command.core && !p.useIndustrialCore) ||
      (x.command.compressor && !p.enableCompression) ||
      ((x.command.moduleID || x.command.bursts?.length) && !p.maintainBursts)
    )
      return null;
  }
  if (
    !x ||
    typeof x !== "object" ||
    typeof x.operationID !== "string" ||
    !x.operationID.trim() ||
    x.operationID.length > 120 ||
    typeof x.operationRunID !== "string" ||
    !x.operationRunID.trim() ||
    x.operationRunID.length > 120 ||
    ![x.systemID, x.destinationID].every(valid) ||
    (x.delivery !== undefined &&
      (!decodeFleetDelivery(x.delivery) || x.delivery.destinationID !== x.destinationID)) ||
    (!(x.delivery?.corporationID === null)
      ? !valid(x.corporationID) ||
        !valid(x.division) ||
        x.division > 7 ||
        (!!x.delivery &&
          (x.delivery.corporationID !== x.corporationID || x.delivery.division !== x.division))
      : x.corporationID !== undefined || x.division !== undefined) ||
    !Number.isFinite(x.canCapacityM3) ||
    x.canCapacityM3 <= 0 ||
    !Array.isArray(x.members) ||
    (x.haulMode !== undefined && x.haulMode !== "SELF_UNLOAD") ||
    (x.fleetPolicy !== undefined && !["EXISTING_ONLY", "MANAGED"].includes(x.fleetPolicy)) ||
    (x.fleetPolicy === "EXISTING_ONLY" && !!x.fleetMoves?.length) ||
    (x.parking !== undefined && !decodeOperationParking(x.parking)) ||
    (x.travelAssist !== undefined && !["AUTO", "DISABLED"].includes(x.travelAssist)) ||
    (x.oreLogistics !== undefined &&
      (!x.oreLogistics ||
        Object.keys(x.oreLogistics).sort().join(",") !==
          "compressedJettisonFraction,remoteCompression,version" ||
        x.oreLogistics.version !== 1 ||
        typeof x.oreLogistics.remoteCompression !== "boolean" ||
        !Number.isFinite(x.oreLogistics.compressedJettisonFraction) ||
        x.oreLogistics.compressedJettisonFraction <= 0 ||
        x.oreLogistics.compressedJettisonFraction > 1)) ||
    (x.resourcePolicy !== undefined && !decodeMiningResourcePolicy(x.resourcePolicy)) ||
    (x.siteSearch !== undefined
      ? !x.siteSearch ||
        x.site !== undefined ||
        x.beltID !== undefined ||
        x.beltName !== undefined ||
        !x.siteSearch ||
        !["ORE", "MOON", "ICE"].includes(x.siteSearch.family)
      : x.site
        ? x.beltID !== undefined ||
          x.beltName !== undefined ||
          !(
            (x.site.archetypeID === 27 && x.site.target?.kind === "ORE_ANOMALY") ||
            (x.site.archetypeID === 28 && x.site.target?.kind === "ICE")
          ) ||
          !valid(x.site.scannerKey) ||
          !valid(x.site.instanceID) ||
          typeof x.site.label !== "string" ||
          !x.site.label.trim() ||
          !Number.isFinite(x.site.observedAt) ||
          !x.site.target ||
          x.site.target.systemID !== x.systemID ||
          x.site.target.siteID !== x.site.scannerKey ||
          x.site.target.instanceID !== x.site.instanceID ||
          x.site.target.name !== x.site.label ||
          !x.site.target.position ||
          ![x.site.target.position.x, x.site.target.position.y, x.site.target.position.z].every(
            Number.isFinite,
          ) ||
          !validSavedSiteClassification(x.site)
        : !valid(x.beltID) || typeof x.beltName !== "string" || !x.beltName.trim()) ||
    x.members.some(
      (m) =>
        !m ||
        !valid(m.characterID) ||
        !valid(m.shipID) ||
        !["MINER", "HAULER", "COMMAND", "DEFENDER"].includes(m.role),
    ) ||
    x.members.filter((m) => m.role === "MINER").length < 1 ||
    (x.haulMode === "SELF_UNLOAD"
      ? x.members.some(
          (m) => m.role !== "MINER" && m.role !== "DEFENDER" && m.role !== "COMMAND",
        ) || x.members.filter((m) => m.role === "COMMAND").length !== (x.command ? 1 : 0)
      : x.members.length !==
          x.members.filter((m) => m.role === "MINER").length +
            x.members.filter((m) => m.role === "HAULER").length +
            x.members.filter((m) => m.role === "DEFENDER").length +
            (x.command ? 1 : 0) ||
        x.members.filter((m) => m.role === "HAULER").length < 1 ||
        x.members.filter((m) => m.role === "COMMAND").length !== (x.command ? 1 : 0)) ||
    new Set(x.members.map((m) => m.characterID)).size !== x.members.length ||
    new Set(x.members.map((m) => m.shipID)).size !== x.members.length ||
    (x.command !== undefined &&
      (!x.command ||
        Object.keys(x.command).some(
          (k) => !["moduleID", "typeID", "bursts", "core", "compressor", "tractor"].includes(k),
        ) ||
        ((x.command.moduleID !== undefined || x.command.typeID !== undefined) &&
          (!valid(x.command.moduleID) || !valid(x.command.typeID))) ||
        (x.command.bursts !== undefined &&
          (!Array.isArray(x.command.bursts) ||
            !x.command.bursts.length ||
            x.command.moduleID !== undefined ||
            x.command.bursts.some(
              (b) =>
                !b ||
                Object.keys(b).sort().join(",") !== "moduleID,typeID" ||
                !valid(b.moduleID) ||
                !valid(b.typeID),
            ))) ||
        (!x.supportPolicy &&
          ![
            x.command.moduleID,
            x.command.bursts?.[0]?.moduleID,
            x.command.core?.moduleID,
            x.command.compressor?.moduleID,
            x.command.tractor?.moduleID,
          ].some(valid)) ||
        [x.command.core, x.command.compressor, x.command.tractor].some(
          (m) =>
            m !== undefined &&
            (!m ||
              Object.keys(m).sort().join(",") !== "moduleID,typeID" ||
              !valid(m.moduleID) ||
              !valid(m.typeID)),
        ) ||
        (!!x.command.compressor && !x.command.core) ||
        new Set(
          [
            x.command.moduleID,
            ...(x.command.bursts ?? []).map((b) => b.moduleID),
            x.command.core?.moduleID,
            x.command.compressor?.moduleID,
            x.command.tractor?.moduleID,
          ].filter(valid),
        ).size !==
          [
            x.command.moduleID,
            ...(x.command.bursts ?? []).map((b) => b.moduleID),
            x.command.core?.moduleID,
            x.command.compressor?.moduleID,
            x.command.tractor?.moduleID,
          ].filter(valid).length)) ||
    (x.fleetMoves !== undefined &&
      (!Array.isArray(x.fleetMoves) ||
        x.fleetMoves.some(
          (m) =>
            !m ||
            ![m.characterID, m.shipID, m.fromFleetID].every(valid) ||
            !x.members.some((p) => p.characterID === m.characterID && p.shipID === m.shipID),
        ) ||
        new Set(x.fleetMoves.map((m) => m.characterID)).size !== x.fleetMoves.length))
  )
    return null;
  const startup = x.startupPreparation;
  if (
    startup !== undefined &&
    (!Array.isArray(startup) ||
      new Set(startup.map((r) => r?.characterID)).size !== startup.length ||
      startup.some(
        (r) =>
          !r ||
          !x.members.some((m) => m.characterID === r.characterID) ||
          !r.preparation?.fittingID ||
          !decodeMiningPreparation({
            operationID: x.operationID,
            operationRunID: x.operationRunID,
            role: "MINER",
            preparation: r.preparation,
          }),
      ))
  )
    return null;
  return {
    ...(startup !== undefined ? { startupPreparation: structuredClone(startup) } : {}),
    ...(x.beltCandidates ? { beltCandidates: structuredClone(x.beltCandidates) } : {}),
    operationID: x.operationID,
    operationRunID: x.operationRunID,
    systemID: x.systemID,
    destinationID: x.destinationID,
    ...(x.corporationID === undefined ? {} : { corporationID: x.corporationID }),
    ...(x.division === undefined ? {} : { division: x.division }),
    ...(x.delivery ? { delivery: decodeFleetDelivery(x.delivery)! } : {}),
    ...(x.siteSearch
      ? { siteSearch: { family: x.siteSearch.family } }
      : x.site
        ? { site: structuredClone(x.site) }
        : { beltID: x.beltID!, beltName: x.beltName! }),
    canCapacityM3: x.canCapacityM3,
    ...(x.resourcePolicy ? { resourcePolicy: decodeMiningResourcePolicy(x.resourcePolicy)! } : {}),
    ...(x.travelAssist ? { travelAssist: x.travelAssist } : {}),
    ...(x.oreLogistics
      ? {
          oreLogistics: {
            version: 1 as const,
            remoteCompression: x.oreLogistics.remoteCompression,
            compressedJettisonFraction: x.oreLogistics.compressedJettisonFraction,
          },
        }
      : {}),
    ...(x.supportPolicy ? { supportPolicy: structuredClone(x.supportPolicy) } : {}),
    ...(x.parking ? { parking: decodeOperationParking(x.parking)! } : {}),
    ...(x.haulMode === "SELF_UNLOAD" ? { haulMode: "SELF_UNLOAD" as const } : {}),
    ...(x.command
      ? {
          command: {
            ...(valid(x.command.moduleID) && valid(x.command.typeID)
              ? { moduleID: x.command.moduleID, typeID: x.command.typeID }
              : {}),
            ...(x.command.bursts
              ? {
                  bursts: x.command.bursts.map((b) => ({ moduleID: b.moduleID, typeID: b.typeID })),
                }
              : {}),
            ...(x.command.core
              ? { core: { moduleID: x.command.core.moduleID, typeID: x.command.core.typeID } }
              : {}),
            ...(x.command.compressor
              ? {
                  compressor: {
                    moduleID: x.command.compressor.moduleID,
                    typeID: x.command.compressor.typeID,
                  },
                }
              : {}),
            ...(x.command.tractor
              ? {
                  tractor: {
                    moduleID: x.command.tractor.moduleID,
                    typeID: x.command.tractor.typeID,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(x.fleetPolicy ? { fleetPolicy: x.fleetPolicy } : {}),
    ...(x.fleetMoves?.length
      ? {
          fleetMoves: x.fleetMoves.map((m) => ({
            characterID: m.characterID,
            shipID: m.shipID,
            fromFleetID: m.fromFleetID,
          })),
        }
      : {}),
    members: x.members.map((m) => ({ characterID: m.characterID, shipID: m.shipID, role: m.role })),
  };
}
class CommandMovementPending extends Error {}
type ResumedLaunch = {
  journal: ReturnType<typeof createFleetLaunchJournal>;
  previousBotID: string;
  accountName: string;
};
type Entry = {
  parkingFreight?: ParkingFreightRemaining;
  startupPrepared?: boolean;
  preparationPending?: boolean;
  timing?: MccTiming;
  deployedAt?: number;
  lastShip?: { shipTypeID: number; at: number } | null;
  lossChecked?: boolean;
  startupManaged?: boolean;
  anchorReady?: boolean;
  leftStartupDock?: boolean;
  escortGeneration?: number;
  targetSetup?: FleetSetup;
  fleetRead?: FleetAssemblyObservation | null;
  fleetIssue?: string;
  fleetWarning?: string;
  fleetReading?: boolean;
  fleetReadAt?: number;
  reconnecting?: boolean;
  work?: Promise<void>;
  retryAt?: number;
  stopRetries?: number;
  observationFailures?: number;
  dockedForDroneStop?: boolean;
  droneWarning?: string;
  emergency?: boolean;
  hullRetreat?: "nearest" | "delivery";
  hullReadAt?: number;
  hullReading?: boolean;
  repairDispatched?: boolean;
  coreObservation?: unknown;
  compressorObservation?: unknown;
  telemetry?: { phase: string; reason: string; reportedAt: number };
  travel?: ReturnType<typeof createNativeTravelAssist>;
  burstEmpty?: Set<number>;
  movementSuspended?: boolean;
  collectCanID?: number;
  commandHauler?: RawHaulerNative;
  tractorTurn?: boolean;
  tractorWork?: {
    manifest: Manifest;
    generation: number;
    released?: boolean;
    moved?: boolean;
    controller: Awaited<ReturnType<typeof createNativeTractor>> | null;
  };
  commandMineTurn?: boolean;
  commandGroup?: ReturnType<typeof createBurstGroup>;
  defenderPreparation?: ReturnType<typeof prepareHeldDefender>;
  defender?: ReturnType<typeof createMiningDefender>;
  defenderSettled?: boolean;
  run: PluginRunContext;
  session: PilotSession;
  member: Member;
  cycle: MiningCycle | null;
  native: RawMinerNative | RawHaulerNative;
  selfUnload: ReturnType<typeof createNativeSelfUnload> | null;
  command?: ReturnType<typeof createNativeBurst> | null;
  commandProof?: ReturnType<typeof createCommandProof>;
  commandSettled?: boolean;
  commandBaseline?: BurstObservation | null;
  core?: ReturnType<typeof createNativeIndustrialCore> | null;
  compressor?: Awaited<ReturnType<typeof createNativeCompressor>> | null;
  commandArrival?: { key: string; generation: number } | null;
  generation?: number;
  navigation?: ReturnType<typeof createNativeMiningNavigation>;
  active: boolean;
  busy: boolean;
  failed: string | null;
  pendingUnload?: UnconfirmedHaulerUnload;
  flushed: boolean;
  miningSettled?: boolean;
  unregister: () => void;
  expiry: number;
  lease: {
    itemID: number;
    systemID: number;
    confirmedAt: number;
    lost: boolean;
    timer: ReturnType<typeof setInterval>;
  } | null;
};
type Group = ReturnType<typeof makeGroup>;
const groups = new Map<string, Group>();
let boardAuthority: {
  provider: FleetRuntimeDependencies["storage"];
  board: ReturnType<typeof createTargetBoard>;
} | null = null;
function makeGroup(
  setup: FleetSetup,
  deps: FleetRuntimeDependencies,
  document: (name: string) => SynchronousStore,
  board: ReturnType<typeof createTargetBoard>,
  store: FleetOperationStore,
  restored?: FleetSetup,
  shiftEndsAt?: number,
) {
  const commandMember = setup.members.find((m) => m.role === "COMMAND"),
    commandCapabilities =
      setup.supportPolicy && commandMember
        ? {
            characterID: commandMember.characterID,
            selfMining: setup.supportPolicy.selfMining,
            tractor: setup.supportPolicy.tractor,
            collect: setup.supportPolicy.collection === "TRACTOR_AND_COLLECT",
          }
        : undefined;
  const op = createOperation(store, board, {
    operationID: setup.operationID,
    runID: setup.operationRunID,
    systemID: setup.systemID,
    destinationID: setup.destinationID,
    ...(setup.delivery ? { delivery: setup.delivery } : {}),
    members: setup.members,
    ...(commandCapabilities ? { commandCapabilities } : {}),
    ...(setup.parking?.mode === "STAY_IN_PLACE" ? { stopMode: "STAY_IN_PLACE" as const } : {}),
    ...(setup.haulMode ? { haulMode: setup.haulMode } : {}),
  });
  const startingState = op.snapshot();
  const restoredStop =
    !!restored && !!startingState.stopFreight && startingState.stopRequested === true;
  let restoringFleet = !!restored && !restoredStop && startingState.state === "ACTIVE";
  if (
    restoredStop
      ? !op.resumeStopping()
      : restoringFleet
        ? !op.resumeActive()
        : startingState.state !== "READY" || startingState.stopRequested
  )
    throw Error("The original fleet target or Stop intent requires reconciliation.");
  const signature = JSON.stringify(setup),
    entries = new Map<number, Entry>(),
    attaching = new Set<number>(),
    loops = createRawMembers(op);
  const pendingReads = new Set<Promise<void>>();
  function track(promise: Promise<void>) {
    pendingReads.add(promise);
    const done = () => pendingReads.delete(promise);
    void promise.then(done, done);
  }
  const logTiming = mccTimingEnabled();
  let supportSample: { observation: SupportObservation; observedAt: number } | null = null,
    supportLostSince: number | null = null;
  let selectionEvidence: unknown = null,
    pendingSelectionEvidence: unknown = null;
  let effectiveSetup = restored ?? setup,
    relocating = false;
  const relocationProofs = new Map<
      number,
      {
        characterID: number;
        shipID: number;
        source: "native-flight";
        systemID: number;
        inSpace: boolean;
        docked: boolean;
        observedAt: number;
      }
    >(),
    relocationDoc = document(
      `mining-fleet-relocation:${JSON.stringify([setup.operationID, setup.operationRunID])}`,
    );
  let resolvedSite = effectiveSetup.site,
    target: Target | null = resolvedSite
      ? resolvedSite.target
      : effectiveSetup.siteSearch
        ? null
        : { kind: "BELT", systemID: setup.systemID, name: effectiveSetup.beltName! };
  let stopping = restoredStop,
    deadlineStop = false,
    starting = false,
    startupStop = false,
    searchUnsafe = false,
    searchReason: string | null = null,
    closed = false,
    fleetCheck = false,
    fleetReadWarning: string | null = null,
    assembly: ReturnType<typeof createFleetAssembly> | null = null;
  const collectStop = () =>
    stopping && !deadlineStop && op.snapshot().stopFreight === "COLLECT_FREIGHT";
  const minerDelivers = (e: Entry, mode = op.snapshot().stopFreight) =>
    e.member.role === "MINER" && mode === "COLLECT_FREIGHT";
  function parkingForStop(e: Entry, mode = op.snapshot().stopFreight) {
    // Only a deadline in Stay in place falls back to a safe dock.
    if (deadlineStop && setup.parking?.mode === "STAY_IN_PLACE" && !minerDelivers(e, mode))
      return null;
    const selected = stopParkingSetup(setup, mode, e.member.role);
    return selected.parking ? selected : null;
  }
  const producers = setup.members.filter(
    (m) => m.role === "MINER" || (m.role === "COMMAND" && setup.supportPolicy?.selfMining),
  );
  const collectionHaulers = () =>
    [...entries.values()].filter(
      (e) =>
        e.member.role === "HAULER" &&
        e.active &&
        !e.failed &&
        !e.emergency &&
        !op.snapshot().settled.includes(e.member.characterID),
    );
  const freightScanner = (e: Entry) => {
    const native = e.native as RawHaulerNative | undefined;
    return !!native?.waitAtBelt && !!native.observeGridJetcans;
  };
  let finalFreightScanned: Claim | null = null;
  const producerFinishing = () =>
    producers.some((m) => {
      const e = entries.get(m.characterID);
      return !!e?.active && !e.flushed && !e.failed && !e.emergency;
    });
  const coveringDeparture = (e: Entry) => {
    if (!stopping || relocating || !e.defender || !producerFinishing()) return false;
    const current = op.snapshot();
    return (
      current.state === "ACTIVE" &&
      current.stopFreight === "RETURN_HOME" &&
      !!current.claim &&
      e.escortGeneration === current.claim.generation
    );
  };
  function pendingForHauler(characterID: number, snapshot = op.snapshot()) {
    return snapshot.manifests.some((m) => {
      const owner = haulOwner(snapshot, m);
      return (
        !m.delivered &&
        (!owner || (owner.purpose !== "tractor" && owner.characterID === characterID))
      );
    });
  }
  const missingSupport = missingCommandEquipment(setup.supportPolicy, setup.command);
  const missingSupportReason = missingSupport.length
    ? "Online support equipment unavailable: " + missingSupport.join(", ") + "."
    : null;
  const parkingFreightNote = (e: Entry) =>
    e.parkingFreight
      ? `Last verified aboard: ${e.parkingFreight.units} ore units (${Math.round(e.parkingFreight.volumeM3 * 100) / 100} m³).`
      : "";
  const report = (
    e: Entry,
    phase: string,
    why: string,
    status: "running" | "paused" = "running",
  ) => {
    if (!e.active) return;
    if (e.member.role === "COMMAND" && missingSupportReason) {
      if (phase === "Command support ready" || phase === "Command observed") {
        phase = "Command support degraded";
        why = missingSupportReason;
      } else why = [why, missingSupportReason].join(" ");
    }
    for (const warning of [e.droneWarning, e.fleetWarning, e.defender?.warning()]) {
      if (warning && !why.includes(warning)) why += " " + warning;
    }
    e.telemetry = { phase, reason: why, reportedAt: Date.now() };
    e.run.report({ status, phase, why });
  };
  const post = async (e: Entry, url: string, body: unknown) => {
    const response = await e.run.fetch(new URL(url, e.run.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data?.ok !== true)
      throw Object.assign(Error(`Global loot custody failed: ${url}`), {
        code: data?.error,
        status: response.status,
      });
    return data;
  };
  async function claim(e: Entry, manifest: Pick<Manifest, "containerID" | "systemID">) {
    const body = { runID: e.run.botID, system: manifest.systemID, itemID: manifest.containerID };
    const first = await post(e, "/api/bots/loot-memory/claim", body).catch((error) => {
      if (error?.code === "CLAIM_SCOPE_UNKNOWN")
        throw new FleetObservationUnavailable(
          "Container claim location is temporarily unavailable.",
          { cause: error },
        );
      return fleetReadFailed(error);
    });
    if (first.claimed !== true)
      throw new GlobalLootClaimHeld(
        "Another bot holds the container claim. Trying again when it becomes available.",
      );
    guardHeld(e);
    if (e.lease) clearInterval(e.lease.timer);
    const lease = {
      itemID: manifest.containerID,
      systemID: manifest.systemID,
      confirmedAt: Date.now(),
      lost: false,
      timer: null as unknown as ReturnType<typeof setInterval>,
    };
    lease.timer = setInterval(() => {
      void post(e, "/api/bots/loot-memory/claim", { ...body, renewOnly: true })
        .then((r) => {
          if (r.claimed !== true) lease.lost = true;
          else lease.confirmedAt = Date.now();
        })
        .catch((error) => {
          // A loaded trip can leave the source system. Pickup reclaims on the grid.
          if (error?.code !== "CLAIM_SCOPE_UNKNOWN" || e.tractorWork) lease.lost = true;
        });
    }, 30000);
    lease.timer.unref?.();
    e.lease = lease;
  }
  async function releaseHaulLease(e: Entry, itemID: number) {
    const lease = e.lease;
    if (lease?.itemID !== itemID) return;
    clearInterval(lease.timer);
    e.lease = null;
    try {
      await post(e, "/api/bots/loot-memory/release", { runID: e.run.botID });
    } catch {
      /* WC expires a stale lease without changing the game inventory. */
    }
  }
  async function pickup(e: Entry, manifest: Manifest) {
    // The caller has read back an empty can. Its expired pickup lease cannot
    // invalidate that observation or the ore already aboard.
    try {
      await post(e, "/api/bots/loot-memory", {
        system: manifest.systemID,
        itemID: manifest.containerID,
      });
    } finally {
      await releaseHaulLease(e, manifest.containerID);
    }
  }
  async function compressCollected(
    e: Entry,
    item: { itemID: number; typeID: number; quantity: number; flagID: number },
    manifest: Manifest,
    generation: number,
    recoveryOnly = false,
  ) {
    const current = () => {
      guard(e);
      const c = op.snapshot().haulClaims[String(manifest.containerID)];
      if (
        !c ||
        c.characterID !== e.member.characterID ||
        c.generation !== generation ||
        !c.dispatched ||
        c.purpose === "tractor"
      )
        throw Error("Collected compression haul custody changed.");
    };
    const support = commandSupport(),
      facility = async (typeID: number) => {
        const active = commandSupport();
        if (!active) throw Error("Collected compression support is unavailable.");
        return createCompressionFacilityObserver({
          operationID: setup.operationID,
          runID: setup.operationRunID,
          systemID: setup.systemID,
          commander: active.commander,
          miner: { run: e.run, session: e.session, shipID: e.member.shipID, current },
          claim: () => op.snapshot().claim,
          observeSupport: active.observeSupport,
        })(typeID);
      };
    const compressionDoc = document(
      `mining-fleet-collection-compression:${JSON.stringify([setup.operationID, setup.operationRunID, e.run.botID, e.member.characterID, e.member.shipID, manifest.containerID, generation, item.itemID])}`,
    );
    if (recoveryOnly && compressionDoc.read() === null) return null;
    const controller = createCompressionController({
      operationID: setup.operationID,
      runID: setup.operationRunID,
      run: e.run,
      session: e.session,
      shipID: e.member.shipID,
      systemID: setup.systemID,
      document: compressionDoc,
      current,
      beforeDispatch: () => {
        current();
        if (stopping || relocating) throw new FleetStopBeforeDispatch();
      },
      facility,
    });
    if (controller.snapshot().pending) {
      const reconciled = await controller.reconcile();
      if (!reconciled) throw Error("Collected compression outcome remains unknown; no replay.");
      return reconciled;
    }
    const prior = controller.snapshot().receipts.find((r) => r.item.itemID === item.itemID);
    if (prior) return prior;
    if (recoveryOnly || !support || stopping || relocating) return null;
    try {
      const result = await controller.compress(item.itemID);
      if (!result && controller.snapshot().pending)
        throw Error("Collected compression outcome remains unknown; no replay.");
      return result;
    } catch (error) {
      current();
      if (error instanceof FleetStopBeforeDispatch || controller.snapshot().pending) throw error;
      return null;
    }
  }
  const guardHeld = (e: Entry) => {
    const online = e.session.store.station.get().online;
    if (
      closed ||
      !e.active ||
      e.session.flow.flying.isSessionClosing() ||
      (e.generation !== undefined && e.session.flow.flying.sessionGeneration() !== e.generation) ||
      online?.characterID !== e.run.characterID
    )
      throw Error("Held pilot or session changed.");
  };
  const guard = (e: Entry) => {
    guardHeld(e);
    const role = e.member.role,
      online = e.session.store.station.get().online;
    const usesDelivery =
      role === "HAULER" ||
      (role === "COMMAND" && setup.supportPolicy?.collection === "TRACTOR_AND_COLLECT") ||
      (setup.haulMode === "SELF_UNLOAD" &&
        (role === "MINER" || (role === "COMMAND" && setup.supportPolicy?.selfMining)));
    if (
      usesDelivery &&
      setup.delivery?.corporationID !== null &&
      online?.corporationID !== setup.corporationID
    )
      throw Error("Held corporation changed.");
  };
  function ensureCommand(e: Entry) {
    if (e.command) return e.command;
    if (e.member.role !== "COMMAND" || !setup.command)
      throw Error("Command capability is not configured.");
    if (!valid(setup.command.moduleID) || !valid(setup.command.typeID)) return null;
    const miners = setup.members
      .filter((m) => m.role === "MINER")
      .map((m) => entries.get(m.characterID));
    if (miners.some((m) => !m)) return null;
    const held = (x: Entry) => ({
      run: x.run,
      session: x.session,
      shipID: x.member.shipID,
      current: () => guard(x),
    });
    e.command = createNativeBurst({
      operationID: setup.operationID,
      runID: setup.operationRunID,
      commander: held(e),
      recipients: miners.map((m) => ({
        ...held(m!),
        current: () => {
          guard(m!);
          if (stopping || relocating) throw new FleetStopBeforeDispatch();
        },
      })),
      moduleID: setup.command.moduleID,
      typeID: setup.command.typeID,
      document: document(
        `mining-fleet-command:${JSON.stringify([setup.operationID, setup.operationRunID, e.member.characterID, e.member.shipID, setup.command.moduleID, setup.command.typeID])}`,
      ),
    });
    return e.command;
  }
  function ensureCore(e: Entry) {
    if (!setup.command?.core) return null;
    if (e.core) return e.core;
    if (e.member.role !== "COMMAND" || !Number.isSafeInteger(e.generation) || e.generation! < 0)
      throw Error("Core held-session identity is unavailable.");
    const core = setup.command.core;
    e.core = createNativeIndustrialCore({
      operationID: setup.operationID,
      runID: setup.operationRunID,
      run: e.run,
      session: e.session,
      shipID: e.member.shipID,
      moduleID: core.moduleID,
      typeID: core.typeID,
      sessionGeneration: e.generation!,
      document: document(
        `mining-fleet-core:${JSON.stringify([setup.operationID, setup.operationRunID, e.run.botID, e.member.characterID, e.member.shipID, core.moduleID, core.typeID])}`,
      ),
      current: () => guard(e),
    });
    return e.core;
  }
  async function coreInactive(e: Entry, forStop = false) {
    const core = ensureCore(e);
    return core ? confirmIndustrialCoreInactive(core, () => guard(e), forStop) : true;
  }
  async function coreProductive(e: Entry) {
    const core = ensureCore(e);
    if (!core) return true;
    const state = await core.reconcile();
    guard(e);
    if (state.current) {
      if (state.current.activation.refusal)
        throw Error("Industrial Core activation was refused; inspect fuel and fitting.");
      if (!state.current.activation.effect || state.current.fuel.status !== "VERIFIED") {
        report(
          e,
          "Core awaiting evidence",
          "Checking the original Core effect and fuel debit without another activation.",
          "paused",
        );
        return false;
      }
      if (!state.current.shutdown?.inactive) {
        const observed = await core.observe();
        guard(e);
        e.coreObservation = observed;
        if (observed.availability !== "available")
          throw Error("Core effect observation is unavailable.");
        if (observed.core.active) {
          if (supportSample?.observation.state === "DEGRADED") supportSample = null;
          return true;
        }
        await core.settle();
        guard(e);
        return false;
      }
    }
    {
      const observed = await core.observe();
      guard(e);
      e.coreObservation = observed;
      const verdict = decideCoreService(
        {
          enabled: true,
          requirement: setup.supportPolicy?.coreRequirement ?? "continueWithoutCore",
        },
        observed,
      );
      if (verdict.state === "DEGRADED") {
        supportSample = {
          observation: { state: "DEGRADED", core: "inactive", reason: verdict.reason, fresh: true },
          observedAt: Date.now(),
        };
        report(
          e,
          "Core unavailable",
          verdict.reason ?? "Native Core unavailable; independent capabilities continue.",
          "running",
        );
        return true;
      }
      if (verdict.state === "WAIT" || verdict.state === "REQUIRED_UNAVAILABLE") {
        supportSample = {
          observation: {
            state: "RECOVERY",
            core: verdict.state === "WAIT" ? "unknown" : "inactive",
            reason: verdict.reason,
            fresh: true,
          },
          observedAt: Date.now(),
        };
        report(e, "Core unavailable", verdict.reason ?? "Native Core unavailable.", "paused");
        return false;
      }
    }
    const options = {
        ...e.session.flow.requestOptions(),
        baseUrl: e.run.baseUrl,
        fetch: e.run.fetch,
      },
      flight = decodeFlightStatus((await getFlightStatus(options)).flight);
    guard(e);
    if (
      !flight.inSpace ||
      flight.shipID !== e.member.shipID ||
      flight.solarSystemID !== setup.systemID
    )
      throw Error("Core flight scope is unavailable.");
    const ready = await readMiningReadiness(e.run, e.session, e.member.shipID, setup.systemID, () =>
      guard(e),
    );
    guard(e);
    if (!coreReadyForActivation(ready))
      throw Error("Core activation waits for a ready ship on the mining grid.");
    if (stopping || e.emergency) return false;
    if (setup.command?.compressor && !(await compressorInactive(e))) {
      report(
        e,
        "Waiting for compressor shutdown",
        "Checking native compressor settlement before Core restart.",
        "paused",
      );
      return false;
    }
    if (e.emergency) return false;
    await core.activate();
    guard(e);
    report(
      e,
      "Core awaiting evidence",
      "Checking the original Core effect and fuel debit.",
      "paused",
    );
    return false;
  }
  async function ensureCompressor(e: Entry) {
    if (!setup.command?.compressor) return null;
    if (e.compressor) return e.compressor;
    if (e.member.role !== "COMMAND" || !Number.isSafeInteger(e.generation) || e.generation! < 0)
      throw Error("Compressor held-session identity is unavailable.");
    const selected = setup.command.compressor;
    e.compressor = await createNativeCompressor({
      operationID: setup.operationID,
      runID: setup.operationRunID,
      run: e.run,
      session: e.session,
      shipID: e.member.shipID,
      moduleID: selected.moduleID,
      typeID: selected.typeID,
      sessionGeneration: e.generation!,
      document: document(
        `mining-fleet-compressor:${JSON.stringify([setup.operationID, setup.operationRunID, e.run.botID, e.member.characterID, e.member.shipID, selected.moduleID, selected.typeID])}`,
      ),
      current: () => guard(e),
      beforeActivate: () => {
        guard(e);
        if (stopping || relocating || e.emergency) throw new FleetStopBeforeDispatch();
      },
      coreReady: async () => {
        const core = ensureCore(e);
        if (!core || stopping) return false;
        const state = await core.reconcile(),
          observed = await core.observe();
        guard(e);
        e.coreObservation = observed;
        return (
          !!state.current?.activation.effect &&
          state.current.fuel.status === "VERIFIED" &&
          observed.availability === "available" &&
          observed.core.active
        );
      },
    });
    guard(e);
    return e.compressor;
  }
  async function compressorInactive(e: Entry, forStop = false) {
    const compressor = await ensureCompressor(e);
    if (!compressor) return true;
    await compressor.settle();
    guard(e);
    const state = await compressor.reconcile(),
      observed = await compressor.observe();
    guard(e);
    e.compressorObservation = observed;
    if (
      state.current?.activation &&
      !state.current.active &&
      !state.current.activation.notDispatched
    )
      return false;
    const effect = observed.module.effects.find((x) => x.effectID === compressor.effectID);
    if (forStop && effect)
      checkShutdownCycle(
        "Compressor",
        effect,
        observed.module.timeFiletime,
        state.current?.shutdown?.before.module.effects.find(
          (x) => x.effectID === compressor.effectID,
        )?.startFiletime,
      );
    if (
      forStop &&
      !effect &&
      (!state.lastInactive || observed.observedAt < state.lastInactive.observedAt)
    )
      throw Error("Compressor inactivity does not match its retained shutdown receipt.");
    return !!state.lastInactive && !effect && observed.observedAt >= state.lastInactive.observedAt;
  }
  async function compressorProductive(e: Entry) {
    if (
      (setup.supportPolicy?.coreRequirement ?? "continueWithoutCore") === "continueWithoutCore" &&
      supportSample?.observation.state === "DEGRADED"
    ) {
      if (!(await compressorInactive(e))) return false;
      return true;
    }
    const compressor = await ensureCompressor(e);
    if (!compressor) return true;
    const state = await compressor.reconcile();
    guard(e);
    if (state.current && !state.current.active) {
      report(
        e,
        "Compressor awaiting evidence",
        "Checking the original native compressor activation without another order.",
        "paused",
      );
      return false;
    }
    if (state.current?.active && !state.current.inactive) {
      const observed = await compressor.observe();
      guard(e);
      e.compressorObservation = observed;
      if (observed.module.effects.some((x) => x.effectID === compressor.effectID)) return true;
      await compressor.settle();
      guard(e);
      return false;
    }
    if (stopping || e.emergency) return false;
    await compressor.activate();
    guard(e);
    report(e, "Compressor awaiting evidence", "Checking the native compressor effect.", "paused");
    return false;
  }
  function commandSupport(): CommandSupportView | null {
    if (stopping || relocating || !setup.command?.core || !setup.command.compressor) return null;
    const e = [...entries.values()].find((x) => x.member.role === "COMMAND"),
      assignment = e && op.assignment(e.member.characterID);
    if (
      !e ||
      !e.active ||
      e.failed ||
      e.emergency ||
      !e.core ||
      !e.compressor ||
      !assignment?.targetGranted ||
      !assignment.claim ||
      e.commandArrival?.key !== assignment.claim.key ||
      e.commandArrival.generation !== assignment.claim.generation
    )
      return null;
    const coreState = e.core.snapshot(),
      compressorState = e.compressor.snapshot();
    if (
      !coreState.current?.activation.effect ||
      coreState.current.fuel.status !== "VERIFIED" ||
      !compressorState.current?.active ||
      compressorState.current.inactive
    )
      return null;
    const original = assignment.claim;
    const current = () => {
      guard(e);
      const a = op.assignment(e.member.characterID);
      if (
        stopping ||
        relocating ||
        e.emergency ||
        !a?.targetGranted ||
        a.claim?.key !== original.key ||
        a.claim.generation !== original.generation
      )
        throw Error("Compression command authority changed.");
    };
    return {
      commander: { run: e.run, session: e.session, shipID: e.member.shipID, current },
      observeSupport: async () => {
        current();
        const core = await e.core!.observe(),
          compressor = await e.compressor!.observe();
        current();
        e.coreObservation = core;
        e.compressorObservation = compressor;
        if (
          core.availability !== "available" ||
          !core.core.active ||
          !compressor.module.effects.some((x) => x.effectID === e.compressor!.effectID)
        )
          throw Error("Native compression support is inactive or unknown.");
        return {
          core,
          compressor: compressor.module,
          compressorEffectID: e.compressor!.effectID,
          observedAt: compressor.observedAt,
        };
      },
    };
  }
  function commandProofFor(e: Entry) {
    if (!setup.command || !valid(setup.command.moduleID) || !valid(setup.command.typeID))
      throw Error("Command proof scope is unavailable.");
    const parts = [
        setup.operationID,
        setup.operationRunID,
        e.member.characterID,
        e.member.shipID,
        setup.command.moduleID,
        setup.command.typeID,
      ],
      identity = JSON.stringify(parts);
    return (e.commandProof ??= createCommandProof(
      document(`mining-fleet-command-proof:${identity}`),
      identity,
    ));
  }
  async function commandProofSample(
    e: Entry,
    observation: BurstObservation,
    claim: Claim,
    module: BurstModule = { moduleID: setup.command!.moduleID!, typeID: setup.command!.typeID! },
  ): Promise<{ scope: CommandProofScope; sample: CommandProofSample }> {
    guard(e);
    if (
      !setup.command ||
      !valid(module.moduleID) ||
      !valid(module.typeID) ||
      !Number.isSafeInteger(e.generation) ||
      e.generation! < 0
    )
      throw Error("Command proof session generation is unavailable.");
    const miners = setup.members
      .filter((m) => m.role === "MINER")
      .map((member) => {
        const entry = entries.get(member.characterID);
        if (
          !entry ||
          !entry.active ||
          !Number.isSafeInteger(entry.generation) ||
          entry.generation! < 0
        )
          throw Error("A held miner generation is unavailable.");
        guard(entry);
        return {
          entry,
          identity: {
            characterID: member.characterID,
            shipID: member.shipID,
            botID: entry.run.botID,
            sessionGeneration: entry.generation!,
          },
        };
      });
    const quotes: (MiningProofQuote | null)[] = [];
    for (const { entry, identity } of miners) {
      let quote: MiningProofQuote | null = null;
      if (entry.cycle?.quote) {
        try {
          quote = await entry.cycle.quote();
        } catch {
          guard(entry);
        }
      }
      guard(entry);
      if (
        quote &&
        (quote.characterID !== identity.characterID ||
          quote.shipID !== identity.shipID ||
          quote.botID !== identity.botID ||
          quote.sessionGeneration !== identity.sessionGeneration ||
          quote.family !== (resolvedSite?.target.kind === "ICE" ? "ice" : "ore"))
      )
        throw Error("Miner quote generation or identity changed.");
      quotes.push(quote);
    }
    guard(e);
    const current = op.assignment(e.member.characterID);
    if (
      !current?.targetGranted ||
      current.claim?.generation !== claim.generation ||
      current.claim.key !== claim.key
    )
      throw Error("Command proof claim changed.");
    return {
      scope: {
        operationID: setup.operationID,
        runID: setup.operationRunID,
        commanderCharacterID: e.member.characterID,
        commanderShipID: e.member.shipID,
        commanderBotID: e.run.botID,
        commanderGeneration: e.generation!,
        moduleID: module.moduleID,
        typeID: module.typeID,
        claimKey: claim.key,
        claimGeneration: claim.generation,
        miners: miners.map((m) => m.identity),
      },
      sample: { commander: observation, miners: quotes },
    };
  }

  function ensureBurstGroup(e: Entry) {
    if (e.commandGroup) return e.commandGroup;
    const modules = setup.command?.bursts;
    if (!modules) return null;
    const miners = setup.members
      .filter((m) => m.role === "MINER")
      .map((m) => entries.get(m.characterID));
    if (miners.some((m) => !m)) return null;
    const held = (x: Entry) => ({
      run: x.run,
      session: x.session,
      shipID: x.member.shipID,
      current: () => guard(x),
    });
    e.commandGroup = createBurstGroup({
      modules,
      current: () => guard(e),
      create(module) {
        const parts = [
            setup.operationID,
            setup.operationRunID,
            e.member.characterID,
            e.member.shipID,
            module.moduleID,
            module.typeID,
          ],
          identity = JSON.stringify(parts);
        const command = createNativeBurst({
          operationID: setup.operationID,
          runID: setup.operationRunID,
          commander: held(e),
          recipients: miners.map((m) => ({
            ...held(m!),
            current: () => {
              guard(m!);
              if (stopping || relocating) throw new FleetStopBeforeDispatch();
            },
          })),
          ...module,
          document: document(`mining-fleet-command:${identity}`),
        });
        return {
          ...module,
          command,
          proof: createCommandProof(document(`mining-fleet-command-proof:${identity}`), identity),
        };
      },
      tick: async (unit, beforeAction) => {
        const { command, proof } = unit,
          assignment = op.assignment(e.member.characterID);
        if (!assignment?.targetGranted || !assignment.claim)
          throw Error("Command target authority changed.");
        const claim = assignment.claim;
        if (!command.snapshot().pending && !proof.snapshot().pending) {
          const charge = await (deps.observeBurstCharge ?? observeBurstCharge)({
            run: e.run,
            session: e.session,
            shipID: e.member.shipID,
            moduleID: unit.moduleID,
            typeID: unit.typeID,
            current: () => guard(e),
          });
          guard(e);
          if (charge.state === "EMPTY") {
            (e.burstEmpty ??= new Set()).add(unit.moduleID);
            return;
          }
          e.burstEmpty?.delete(unit.moduleID);
        }
        let observation = await command.observe();
        if (stopping) return;
        if (
          !observation.active &&
          observation.chargeQuantity === 0 &&
          !e.commandProof?.snapshot().pending
        ) {
          supportSample = {
            observation: {
              state: "DEGRADED",
              core:
                supportSample?.observation.core ?? (setup.command?.core ? "active" : "inactive"),
              reason: "Burst charge is depleted; independent capabilities continue.",
              fresh: true,
            },
            observedAt: Date.now(),
          };
          report(
            e,
            "Command support degraded",
            "Burst charge is depleted; independent capabilities continue.",
          );
          return observation;
        }
        if (observation.active && supportSample?.observation.state !== "DEGRADED")
          supportSample = {
            observation: {
              state: "READY",
              core: setup.command?.core ? "active" : "inactive",
              reason: null,
              fresh: true,
            },
            observedAt: Date.now(),
          };
        const pending = proof.snapshot().pending;
        if (pending) {
          if (command.snapshot().pending?.kind === "activate") {
            await command.reconcile();
            observation = await command.observe();
          }
          const captured = await commandProofSample(e, observation, claim, unit),
            controller = command.snapshot();
          if (JSON.stringify(captured.scope) !== JSON.stringify(pending.scope))
            throw Error("Command proof scope changed.");
          const activation = [...controller.history]
            .reverse()
            .find(
              (h) =>
                h.intent.kind === "activate" &&
                h.after.active &&
                h.intent.issuedAt >= pending.preparedAt &&
                !pending.priorActivationIDs.includes(h.intent.issuedAt),
            ) as CommandActivationReceipt | undefined;
          proof.update(captured.scope, captured.sample, activation ?? null);
          const updated = proof.snapshot().pending!;
          if (
            !controller.pending &&
            (updated.status === "BENEFIT_OBSERVED" ||
              (!activation && !observation.active) ||
              (activation &&
                !observation.active &&
                updated.inactiveObservedAt !== null &&
                Date.now() - updated.inactiveObservedAt >= 15000))
          )
            proof.close(captured.scope, controller);
          return observation;
        }
        if (observation.active || observation.chargeQuantity === 0) return observation;
        const controllerBefore = command.snapshot();
        if (controllerBefore.pending)
          throw Error("A native command mutation remains unresolved; no replay.");
        const captured = await commandProofSample(e, observation, claim, unit);
        beforeAction();
        if (stopping || relocating || e.emergency) throw new FleetStopBeforeDispatch();
        const previous = [
          ...new Set(
            controllerBefore.history
              .filter((h) => h.intent.kind === "activate")
              .slice(-128)
              .map((h) => h.intent.issuedAt),
          ),
        ];
        proof.prepare(captured.scope, captured.sample, previous);
        beforeAction();
        if (stopping || relocating || e.emergency) throw new FleetStopBeforeDispatch();
        await command.activate();
        const after = await command.observe(),
          postSample = await commandProofSample(e, after, claim, unit),
          controller = command.snapshot(),
          row = proof.snapshot().pending!,
          activation = [...controller.history]
            .reverse()
            .find(
              (h) =>
                h.intent.kind === "activate" &&
                h.after.active &&
                h.intent.issuedAt >= row.preparedAt &&
                !row.priorActivationIDs.includes(h.intent.issuedAt),
            ) as CommandActivationReceipt | undefined;
        proof.update(postSample.scope, postSample.sample, activation ?? null);
        if (proof.snapshot().pending?.status === "BENEFIT_OBSERVED" && !controller.pending)
          proof.close(postSample.scope, controller);
        return after;
      },
    });
    return e.commandGroup;
  }

  async function tractorService(e: Entry, retire = false) {
    const selected = setup.command?.tractor;
    if (!selected || !setup.supportPolicy?.tractor) return;
    let work = e.tractorWork;
    if (!work) {
      if (retire || stopping) return;
      if (e.lease) throw Error("A previous global loot claim remains unresolved.");
      const snapshot = op.snapshot(),
        haulers = setup.members.filter((m) => m.role === "HAULER");
      if (!haulers.length || haulers.some((m) => !hasHaulWork(snapshot, m.characterID))) return;
      const manifest = snapshot.manifests.find(
        (m) => !m.delivered && m.targetKey === snapshot.claim?.key && !haulOwner(snapshot, m),
      );
      if (!manifest || !snapshot.claim || !Number.isSafeInteger(e.generation)) return;
      await claim(e, manifest);
      guard(e);
      const taken = op.claimContainer(e.member.characterID, manifest.containerID, "tractor", {
        ...selected,
        botID: e.run.botID,
        sessionGeneration: e.generation!,
      });
      if (!taken) {
        await post(e, "/api/bots/loot-memory/release", { runID: e.run.botID });
        const leased = e.lease as Entry["lease"];
        if (leased) clearInterval(leased.timer);
        e.lease = null;
        return;
      }
      work = { manifest, generation: taken.generation, controller: null };
      e.tractorWork = work;
    }
    if (e.lease?.lost) {
      guardHeld(e);
      if (!work.controller)
        throw Error("Lost tractor lease needs retained own-module reconciliation.");
      await work.controller.stopOwn();
      guardHeld(e);
      if (
        !op.releaseTractor(
          e.member.characterID,
          work.manifest.containerID,
          work.generation,
          work.controller.snapshot(),
        )
      )
        throw Error("Own tractor effect remains unresolved after lease loss.");
      clearInterval(e.lease.timer);
      e.lease = null;
      e.tractorWork = undefined;
      return;
    }
    if (work.released) {
      const completed = work;
      await post(e, "/api/bots/loot-memory/release", { runID: e.run.botID });
      if (e.lease) clearInterval(e.lease.timer);
      e.lease = null;
      e.tractorWork = undefined;
      if (completed.moved && !stopping && setup.supportPolicy?.collection === "TRACTOR_AND_COLLECT")
        e.collectCanID = completed.manifest.containerID;
      return;
    }
    const currentWork = work;
    const claimCurrent = () => {
      guard(e);
      const snapshot = op.snapshot(),
        c = snapshot.haulClaims[String(currentWork.manifest.containerID)],
        lease = e.lease,
        authority = snapshot.claim ? board.read(snapshot.claim.key) : null;
      if (
        !snapshot.claim ||
        !authority?.claim ||
        authority.claim.operationID !== snapshot.operationID ||
        authority.claim.runID !== snapshot.runID ||
        authority.claim.generation !== snapshot.claim.generation ||
        snapshot.claim.key !== currentWork.manifest.targetKey ||
        snapshot.claim.generation !== currentWork.manifest.claimGeneration ||
        !c ||
        c.purpose !== "tractor" ||
        c.characterID !== e.member.characterID ||
        c.generation !== currentWork.generation ||
        !lease ||
        lease.lost ||
        lease.itemID !== currentWork.manifest.containerID
      )
        throw Error("Tractor claim or global lease changed.");
    };
    if (!work.controller) {
      const target = op.snapshot().claim;
      if (!target) throw Error("Tractor target authority is unavailable.");
      work.controller = await (deps.createTractor ?? createNativeTractor)({
        run: e.run,
        session: e.session,
        shipID: e.member.shipID,
        ...selected,
        manifest: work.manifest,
        claimGeneration: work.generation,
        targetGeneration: target.generation,
        document: document(
          `mining-fleet-tractor:${JSON.stringify([setup.operationID, setup.operationRunID, e.run.botID, e.member.characterID, e.member.shipID, work.manifest.containerID, work.generation])}`,
        ),
        current: () => guardHeld(e),
        claimCurrent,
        beforeAction: () => {
          claimCurrent();
          if (stopping || relocating || e.emergency) throw new FleetStopBeforeDispatch();
        },
      });
    }
    if (retire || stopping) {
      await work.controller.stop();
      claimCurrent();
      if (
        !op.releaseTractor(
          e.member.characterID,
          work.manifest.containerID,
          work.generation,
          work.controller.snapshot(),
        )
      )
        throw Error("Tractor inactive evidence remains unresolved.");
      work.released = true;
      await tractorService(e, true);
      return;
    }
    const observed = await work.controller.advance();
    guard(e);
    if (observed.movement) {
      work.moved = true;
      await tractorService(e, true);
    }
  }
  const soloSelfUnload =
    setup.fleetPolicy !== "EXISTING_ONLY" &&
    setup.haulMode === "SELF_UNLOAD" &&
    setup.members.length === 1;
  const initialBeltAssembly =
    setup.beltID !== undefined &&
    setup.members.length > 1 &&
    !startingState.relocationHistory?.length;
  const approvedFleetMembers = new Set(setup.members.map((m) => m.characterID));
  const admitted = (e: Entry) => {
    if (!e.startupManaged) return true;
    if (e.fleetIssue) return false;
    if (soloSelfUnload) return true;
    const fleetID = assembly?.snapshot().fleetID;
    return (
      !!fleetID &&
      e.fleetRead?.state === "ready" &&
      e.fleetRead.fleetID === fleetID &&
      e.fleetRead.memberIDs.includes(e.member.characterID) &&
      e.fleetRead.memberIDs.every((id) => approvedFleetMembers.has(id))
    );
  };
  function reportFleetMembership(e: Entry, phase: string, reason: string) {
    const issue =
      e.fleetRead?.state === "not-in-fleet" ? assembly?.admissionIssue(e.member.characterID) : null;
    if (issue || e.anchorReady)
      report(e, issue ? "Fleet admission needs attention" : phase, issue ?? reason, "paused");
  }
  async function readFleetRoster(
    e: Entry,
    options: Parameters<typeof loadBoundFleet>[0],
  ): Promise<FleetAssemblyObservation> {
    const bound = await loadBoundFleet(options, true);
    guardHeld(e);
    const fleet = decodeFleetCenter(bound);
    if (fleet.availability === "not-in-fleet") return { state: "not-in-fleet" };
    const memberIDs = authoritativeFleetMemberCharacterIDs(fleet),
      fleetID = Number(fleet.fleet.initState.value.fleetID);
    if (
      fleet.availability !== "ready" ||
      !memberIDs?.includes(e.member.characterID) ||
      fleet.fleet.initState.value.members.length !== memberIDs.length ||
      !valid(fleetID)
    )
      throw new FleetObservationUnavailable("Native fleet roster is temporarily unreadable.");
    const fleetCreatorJob = 2; // Native fleet member job bit for the fleet boss.
    const bosses = fleet.fleet.initState.value.members.filter(
      (m) => (m.job & fleetCreatorJob) !== 0,
    );
    return {
      state: "ready",
      fleetID,
      memberIDs,
      bossID: bosses.length === 1 ? Number(bosses[0]!.charID) : null,
    };
  }
  async function readFleetPeer(e: Entry): Promise<FleetAssemblyObservation> {
    guardHeld(e);
    const options = {
      ...e.session.flow.requestOptions(),
      baseUrl: e.run.baseUrl,
      fetch: e.run.fetch,
    };
    const startedAt = Date.now();
    const recentlyObserved =
      admitted(e) && e.lastShip && startedAt >= e.lastShip.at && startedAt - e.lastShip.at < 5000;
    const [fleet, flight] = await Promise.all([
      readFleetRoster(e, options),
      recentlyObserved ? null : getFlightStatus(options),
    ]);
    guardHeld(e);
    if (flight) {
      const f = decodeFlightStatus(flight.flight);
      rememberShip(e, f, startedAt);
      if (!valid(f.shipID))
        throw new FleetObservationUnavailable("Native active ship is temporarily unreadable.");
      if (f.shipID !== e.member.shipID)
        throw new FleetShipChanged(
          "Native ship changed from " + e.member.shipID + " to " + f.shipID + ".",
          f.shipIsCapsule === true,
        );
    }
    return fleet;
  }
  function observeFleet(e: Entry, verifiedPeers?: readonly Entry[]) {
    if (
      !e.active ||
      e.emergency ||
      e.reconnecting ||
      e.fleetReading ||
      (e.fleetReadAt ?? 0) > Date.now()
    )
      return;
    const fleetID = verifiedPeers ? assembly?.snapshot().fleetID : null;
    const read = async () => {
      guardHeld(e);
      return verifiedPeers
        ? readFleetRoster(e, {
            ...e.session.flow.requestOptions(),
            baseUrl: e.run.baseUrl,
            fetch: e.run.fetch,
          })
        : readFleetPeer(e);
    };
    e.fleetReading = true;
    track(
      read()
        .then((row) => {
          if (!e.active || e.emergency || stopping) return;
          // The current fleet's roster applies to its already admitted members.
          // Joining or rejoining still requires an observation from the pilot's own session.
          if (
            verifiedPeers &&
            !relocating &&
            row.state === "ready" &&
            row.fleetID === fleetID &&
            fleetID === assembly?.snapshot().fleetID
          ) {
            for (const peer of verifiedPeers) {
              if (
                peer === e ||
                !peer.active ||
                peer.emergency ||
                peer.reconnecting ||
                peer.fleetReading ||
                entries.get(peer.member.characterID) !== peer ||
                !admitted(peer)
              )
                continue;
              const stillMember = row.memberIDs.includes(peer.member.characterID);
              peer.fleetRead = stillMember ? row : null;
              peer.fleetReadAt = stillMember ? Date.now() : 0;
            }
          }
          e.fleetRead = row;
          e.fleetIssue = undefined;
          e.fleetWarning = undefined;
          if (!e.failed && !admitted(e))
            reportFleetMembership(
              e,
              "Waiting for native fleet",
              row.state === "not-in-fleet"
                ? "This pilot has not joined the operation fleet."
                : "Checking this pilot's membership in the approved native fleet.",
            );
        })
        .catch((error) => {
          if (!e.active || e.emergency || stopping) return;
          if (requestEmergencyRetreat(e, error)) return;
          if (error instanceof FleetShipChanged) {
            e.fleetRead = null;
            e.fleetIssue = error.message;
            report(e, "Pilot ship changed", error.message, "paused");
          } else {
            e.fleetWarning = "Native fleet read: " + message(error);
            if (!e.failed && !admitted(e) && e.anchorReady)
              report(e, "Checking native fleet", e.fleetWarning, "paused");
          }
        })
        .finally(() => {
          e.fleetReading = false;
          e.fleetReadAt = Date.now() + (admitted(e) ? 8000 : 1500);
        }),
    );
  }
  const dockAfterDroneTimeout = () =>
    stopping &&
    !relocating &&
    (stopParkingSetup(setup, op.snapshot().stopFreight).parking?.mode !== "STAY_IN_PLACE" ||
      deadlineStop);
  const settleMember = async (e: Entry, current = () => guard(e)) => {
    if (e.preparationPending) await prepareMemberEquipment(e, current, true);
    await e.travel?.settleForStop();
    current();
    return deps.settle(e.run, e.session, current, {
      expectedDrones: [
        ...new Set([...(e.cycle?.droneIDs?.() ?? []), ...(e.defender?.droneIDs?.() ?? [])]),
      ],
      report: (why) => {
        if (why.startsWith("Drones not recovered") || why.startsWith("Drone return did not finish"))
          e.droneWarning = why;
        report(e, "Recalling drones", why, "paused");
      },
      parkAfterRecallFailure: dockAfterDroneTimeout()
        ? async () => {
            const parking = parkingForStop(e)?.parking;
            if (parking && parking.mode !== "STAY_IN_PLACE")
              await parkAtOperationHome(
                e.run,
                e.session,
                parking,
                (phase, why) => report(e, phase, why),
                current,
              );
            else
              await (deps.park ?? parkNearest)(
                e.run,
                e.session,
                (phase, why) => report(e, phase, why),
                current,
              );
            e.dockedForDroneStop = true;
          }
        : undefined,
    });
  };
  async function recallBeforeDeparture(e: Entry) {
    const current = () => guard(e);
    const result = await recallFleetDrones(e.run, e.session, e.member.shipID, current, {
      pendingLaunch: e.cycle?.droneIDs?.(),
      onProgress: (why) => report(e, "Recalling drones", why, "paused"),
    });
    const warning = assertFleetDroneDeparture(result);
    if (warning) {
      e.droneWarning = warning;
      report(e, "Drones not recovered", warning);
    }
  }
  async function commandMovementAdmission(e: Entry) {
    if (e.member.role !== "COMMAND" || (!setup.command?.core && !setup.supportPolicy?.tractor))
      return;
    guard(e);
    if (stopping || relocating) throw new FleetStopBeforeDispatch();
    e.movementSuspended = true;
    e.commandMineTurn = true;
    supportSample = {
      observation: {
        state: "RECOVERY",
        core: "unknown",
        reason: "Command support is settling before movement.",
        fresh: true,
      },
      observedAt: Date.now(),
    };
    try {
      if (e.tractorWork) await tractorService(e, true);
      if (!(await compressorInactive(e)) || !(await coreInactive(e)))
        throw new CommandMovementPending("Waiting for native support inactivity.");
    } catch (error) {
      guard(e);
      if (error instanceof FleetStopBeforeDispatch) throw error;
      throw new CommandMovementPending(message(error));
    }
    guard(e);
    if (stopping || relocating) throw new FleetStopBeforeDispatch();
  }
  const compressionDocument = (e: Entry, botID = e.run.botID) =>
    document(
      `mining-fleet-compression:${JSON.stringify([setup.operationID, setup.operationRunID, botID, e.member.characterID, e.member.shipID])}`,
    );
  async function initializeSearchMember(e: Entry) {
    const { member, session } = e;
    const current = () => {
      guard(e);
      if (e.emergency) throw new FleetStopBeforeDispatch();
    };
    const effectiveRun = {
      ...e.run,
      setup: JSON.parse(
        JSON.stringify(
          resolvedSite
            ? { ...effectiveSetup, siteSearch: undefined, site: resolvedSite }
            : effectiveSetup,
        ),
      ) as PluginRunContext["setup"],
    };
    if (
      (member.role === "MINER" || (member.role === "COMMAND" && setup.supportPolicy?.selfMining)) &&
      !e.cycle
    ) {
      const movementAdmission =
          member.role === "COMMAND" && (setup.command?.core || setup.supportPolicy?.tractor)
            ? () => commandMovementAdmission(e)
            : undefined,
        cycle = await deps.createCycle(
          effectiveRun,
          session,
          current,
          () => stopping || relocating || !!e.emergency,
          {
            timing: e.timing,
            authority: () => board.read(targetKey(target!)),
            commandSupport,
            reportDrones: (phase, why) => report(e, phase, why),
            travelAssist: e.travel,
            compressionDocument: setup.oreLogistics?.remoteCompression
              ? compressionDocument(e)
              : undefined,
            movementAdmission,
            movementArrived:
              member.role === "COMMAND"
                ? () => {
                    guard(e);
                    if (!e.movementSuspended) return false;
                    e.movementSuspended = false;
                    e.commandMineTurn = false;
                    return true;
                  }
                : undefined,
          },
        );
      guard(e);
      e.cycle = cycle;
      e.native = createNativeMiner(effectiveRun, session, {
        shipID: member.shipID,
        beltID: effectiveSetup.beltID,
        site: resolvedSite,
        timing: e.timing,
        observeFlight: (f, at) => rememberShip(e, f, at),
        movementAdmission,
        beforeDeparture: cycle.droneIDs
          ? async () => {
              await recallBeforeDeparture(e);
              if (stopping || relocating) throw new FleetStopBeforeDispatch();
            }
          : undefined,
        travelAssist: e.travel,
        authority: () => board.read(targetKey(target!)),
        document,
        capacityM3: setup.canCapacityM3,
        oreLogistics: setup.oreLogistics,
        current,
        typeFacts: createRawTypeFacts(effectiveRun, current),
        mineCycle: (t, c, jettisonReady, arrival, jettison) =>
          cycle.tick(t, c, jettisonReady, member.role === "MINER" ? arrival : undefined, jettison),
      });
    }
    if (member.role === "COMMAND" && !e.navigation)
      e.navigation = createNativeMiningNavigation(effectiveRun, session, {
        shipID: member.shipID,
        beltID: effectiveSetup.beltID,
        site: resolvedSite,
        travelAssist: e.travel,
        authority: () => board.read(targetKey(target!)),
        document,
        current,
      });
    e.targetSetup = effectiveSetup;
  }
  async function initializeSelectedTarget(e: Entry) {
    if (e.targetSetup === effectiveSetup) return;
    await e.cycle?.release?.();
    e.cycle = null;
    e.navigation = undefined;
    guard(e);
    await initializeSearchMember(e);
  }

  function observeMemberLocality(e: Entry): Promise<LocalityRead> {
    return observeLocality(
      {
        run: e.run,
        session: e.session,
        shipID: e.member.shipID,
        role: e.member.role,
        current: () => guard(e),
      },
      setup.systemID,
      board,
    );
  }
  function beltSelection(
    fallback: readonly { beltID: number; beltName: string }[],
    reads: readonly LocalityRead[],
    exclude?: string,
  ) {
    const native = reads.find((r) => r.belts.length)?.belts ?? [],
      rows = native.length ? native : fallback.map((b) => ({ ...b, position: null }));
    const counts = new Map<string, number>();
    for (const b of rows) counts.set(b.beltName, (counts.get(b.beltName) ?? 0) + 1);
    const visited = op.snapshot().relocatedKeys ?? [];
    const candidates = rows
      .filter((b) => counts.get(b.beltName) === 1)
      .map((b) => ({
        ...b,
        target: { kind: "BELT" as const, systemID: setup.systemID, name: b.beltName },
      }))
      .filter((b) => {
        const key = targetKey(b.target);
        if (exclude === undefined)
          return searchTargetAvailable(board, b.target, setup.operationID, setup.operationRunID);
        return key !== exclude && board.availableForRelocation(key, visited.includes(key));
      });
    return rankLocality(candidates, reads);
  }
  async function prepareRelocation(input: {
    operationID: string;
    operationRunID: string;
    claimKey: string;
    claimGeneration: number;
  }): Promise<{ beltID: number; beltName: string } | { site: NativeSite } | null> {
    if (
      stopping ||
      relocating ||
      input.operationID !== setup.operationID ||
      input.operationRunID !== setup.operationRunID
    )
      return null;
    const before = op.snapshot(),
      claim = before.claim,
      entry = [...entries.values()].find(
        (e) => e.member.role === "MINER" && e.active && !e.failed && !e.emergency,
      );
    if (
      before.state !== "ACTIVE" ||
      !claim ||
      claim.key !== input.claimKey ||
      claim.generation !== input.claimGeneration ||
      !entry ||
      !entry.active
    )
      return null;
    const unchanged = () => {
      guard(entry);
      const state = op.snapshot(),
        authority = board.read(claim.key);
      if (
        stopping ||
        relocating ||
        state.state !== "ACTIVE" ||
        !state.claim ||
        state.claim.key !== claim.key ||
        state.claim.generation !== claim.generation ||
        !authority?.claim ||
        authority.claim.operationID !== setup.operationID ||
        authority.claim.runID !== setup.operationRunID ||
        authority.claim.generation !== claim.generation
      )
        throw Error("Relocation owner or claim changed during discovery.");
    };
    unchanged();
    if (target?.kind !== "BELT") {
      const family = resolvedSite?.siteFamily ?? (target?.kind === "ICE" ? "ICE" : null);
      if (!family || family === "UNKNOWN") return null;
      const sites = await createSiteDiscovery(entry.run, entry.session, {
        shipID: entry.member.shipID,
        systemID: setup.systemID,
        current: unchanged,
      }).read();
      unchanged();
      const eligibleSites = sites.filter(
        (x) =>
          x.siteFamily === family &&
          validSavedSiteClassification(x) &&
          x.target.systemID === setup.systemID &&
          targetKey(x.target) !== claim.key &&
          !before.relocatedKeys?.includes(targetKey(x.target)) &&
          !board.read(targetKey(x.target)) &&
          !board.isDangerous(targetKey(x.target)),
      );
      const decision = rankLocality(
        eligibleSites.map((site) => ({
          site,
          target: site.target,
          position: site.target.position,
        })),
        [await observeMemberLocality(entry)],
      );
      unchanged();
      pendingSelectionEvidence = decision.evidence;
      const site = decision.ranked[0]?.candidate.site;
      return site ? { site } : null;
    }
    const read = async (path: string, body?: unknown) => {
      unchanged();
      const response = await entry.run.fetch(
          new URL(path, entry.run.baseUrl),
          body === undefined
            ? undefined
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              },
        ),
        data = await response.json();
      unchanged();
      if (!response.ok || data?.ok !== true) throw Error("Relocation map is unavailable.");
      return data;
    };
    const map = await read(`/api/client-data/system-objects/${setup.systemID}`);
    if (map.available !== true || !Array.isArray(map.objects))
      throw Error("Relocation belt map is unavailable.");
    const ids = map.objects
      .filter((x: any) => x?.groupID === 9 && valid(x.itemID))
      .map((x: any) => x.itemID as number)
      .sort((a: number, b: number) => a - b);
    if (new Set(ids).size !== ids.length) throw Error("Relocation belt map is ambiguous.");
    const namedBelts: { beltID: number; beltName: string }[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50),
        named = await read("/api/names", {
          items: chunk.map((id: number) => ({ kind: "evelocation", id })),
        });
      if (!named.names || typeof named.names !== "object" || named.capped === true)
        throw Error("Relocation belt names are unavailable.");
      for (const id of chunk) {
        const name = named.names[`evelocation:${id}`];
        if (typeof name === "string" && name.trim())
          namedBelts.push({ beltID: id, beltName: name.trim() });
      }
    }
    const decision = beltSelection(namedBelts, [await observeMemberLocality(entry)], claim.key);
    unchanged();
    pendingSelectionEvidence = decision.evidence;
    const selected = decision.ranked[0]?.candidate;
    return selected ? { beltID: selected.beltID, beltName: selected.beltName } : null;
  }
  function requestRelocation(
    input: {
      operationID: string;
      operationRunID: string;
      claimKey: string;
      claimGeneration: number;
      next: { beltID: number; beltName: string } | { site: NativeSite };
    },
    oldBeltID?: number,
  ) {
    if (
      stopping ||
      relocating ||
      input.operationID !== setup.operationID ||
      input.operationRunID !== setup.operationRunID
    )
      return false;
    const current = op.snapshot().claim;
    if (!current || current.key !== input.claimKey || current.generation !== input.claimGeneration)
      return false;
    const {
      beltID: _belt,
      beltName: _name,
      site: _site,
      siteSearch: _search,
      ...base
    } = effectiveSetup;
    const candidate = setupOf({ ...base, ...input.next });
    if (!candidate) return false;
    const next = candidate.site?.target ?? {
      kind: "BELT" as const,
      systemID: candidate.systemID,
      name: candidate.beltName!,
    };
    relocationDoc.write({
      version: 1,
      operationID: setup.operationID,
      runID: setup.operationRunID,
      oldClaim: current,
      next: candidate,
      decision:
        (pendingSelectionEvidence as any)?.selected === targetKey(next)
          ? pendingSelectionEvidence
          : { source: "explicit-reviewed-relocation", selected: targetKey(next) },
    });
    const moving =
      oldBeltID && !restored
        ? setup.members
            .filter((m) => {
              const e = entries.get(m.characterID);
              return (
                m.role !== "HAULER" &&
                !!e &&
                !e.emergency &&
                (!e.startupManaged || e.leftStartupDock)
              );
            })
            .map((m) => m.characterID)
        : undefined;
    if (
      !op.prepareRelocation(
        setup.members.find((m) => m.role === "MINER")!.characterID,
        current,
        next,
        oldBeltID,
        moving,
      )
    )
      return false;
    relocating = true;
    const snapshot = op.snapshot();
    for (const e of entries.values()) {
      // Belt relocation leaves the Hauler's original freight obligations in place.
      if (moving && e.member.role === "HAULER" && hasHaulWork(snapshot, e.member.characterID, true))
        continue;
      e.failed = null;
    }
    return true;
  }
  let selectingNext = false,
    nextBeltReadAt = 0,
    nextBeltReason = "Three valid native grids show no remaining asteroids.";
  async function beltDepleted(entry: Entry, claim: Claim) {
    if (stopping || relocating || target?.kind !== "BELT" || !effectiveSetup.beltID) return;
    report(entry, "Belt depleted", nextBeltReason, "paused");
    if (selectingNext || Date.now() < nextBeltReadAt) return;
    if (
      !board.noteDepletion(claim, {
        source: "checked-empty-grid",
        key: claim.key,
        observedAt: Date.now(),
      })
    )
      return;
    selectingNext = true;
    const scope = {
      operationID: setup.operationID,
      operationRunID: setup.operationRunID,
      claimKey: claim.key,
      claimGeneration: claim.generation,
    };
    try {
      const next = await prepareRelocation(scope);
      if (stopping || relocating) return;
      if (next && requestRelocation({ ...scope, next }, effectiveSetup.beltID)) return;
      nextBeltReason = "No eligible replacement belt is currently available.";
      report(entry, "Belt depleted", nextBeltReason, "paused");
    } catch (error) {
      if (!stopping && !relocating) {
        nextBeltReason = "Replacement belt observation failed: " + message(error);
        report(entry, "Belt depleted", nextBeltReason, "paused");
      }
    } finally {
      selectingNext = false;
      nextBeltReadAt = Date.now() + 10000;
    }
  }
  const anchorPending = new Set<Entry>(),
    departed = new Set<Entry>(),
    startupDocks = new Map<Entry, number>();
  const atRally = new WeakSet<Entry>(),
    atInitialBelt = new WeakMap<Entry, number>();
  let rallyPoint: Promise<MiningRallyPoint> | null = null;
  const startupReady = (e: Entry) =>
    e.active &&
    !e.failed &&
    !e.emergency &&
    !e.reconnecting &&
    e.startupPrepared !== false &&
    e.anchorReady &&
    admitted(e);
  const anchorDocument = (e: Entry) =>
    document(
      "mining-fleet-anchor:" +
        JSON.stringify([
          setup.operationID,
          setup.operationRunID,
          e.run.botID,
          e.member.characterID,
          e.member.shipID,
        ]),
    );
  async function prepareMemberEquipment(e: Entry, current: () => void, settling = false) {
    const preparation = setup.startupPreparation?.find(
      (row) => row.characterID === e.member.characterID,
    )?.preparation;
    if (!preparation) return;
    const result = await (deps.prepareMember ?? prepareHeldMiningMember)(
      e.run,
      {
        operationID: setup.operationID,
        operationRunID: setup.operationRunID,
        role: e.member.role,
        preparation,
      },
      { shipID: e.member.shipID, current, stopRequested: () => settling || stopping },
    );
    e.preparationPending = result.status === "paused";
    current();
    if (result.status !== "stopped" && !(stopping && result.status === "error"))
      throw Error(result.why ?? "The pilot's equipment and supplies could not be prepared.");
  }
  function stageMemberPreparation(e: Entry) {
    launch(e, async () => {
      const { run, member, session } = e,
        current = () => guard(e);
      const destinations: { locationID: number; corporationID: number; division: number }[] = [];
      const support = setup.supportPolicy,
        delivery = setup.delivery,
        parking = setup.parking;
      const delivers =
        setup.haulMode === "SELF_UNLOAD"
          ? member.role === "MINER" || (member.role === "COMMAND" && support?.selfMining)
          : member.role === "HAULER" ||
            (member.role === "COMMAND" && support?.collection === "TRACTOR_AND_COLLECT");
      if (delivers && delivery?.corporationID != null && delivery.division != null)
        destinations.push({
          locationID: delivery.destinationID,
          corporationID: delivery.corporationID,
          division: delivery.division,
        });
      if (
        member.role !== "DEFENDER" &&
        parking?.mode === "RETURN_HOME_UNLOAD_DOCK" &&
        parking.corporationID != null &&
        parking.division != null
      )
        destinations.push({
          locationID: parking.destinationID,
          corporationID: parking.corporationID,
          division: parking.division,
        });
      if (
        destinations.length ||
        setup.startupPreparation?.some((row) => row.characterID === member.characterID)
      )
        report(
          e,
          "Checking pilot readiness",
          "Verifying equipment, supplies and corporate hangar access on this hosted pilot.",
          "paused",
        );
      current();
      if (destinations.length) {
        const corporationID = session.store.station.get().online?.corporationID;
        if (!valid(corporationID)) throw Error("The held pilot's corporation is unverified.");
        const read = async (path: string) => {
          const response = await run.fetch(new URL(path, run.baseUrl));
          const result = await response.json();
          current();
          if (!response.ok || result?.ok === false)
            throw Error(result?.message ?? "Corporate office access is unavailable.");
          return result;
        };
        const office = await readMiningOfficeAccess(
          { characterID: member.characterID, corporationID },
          [...new Set(destinations.map((d) => d.locationID))],
          read,
          (method, args = []) => session.flow.flying.bridgeAsk("corpRegistry", method, [...args]),
        );
        current();
        for (const d of destinations)
          requireMiningOfficeQuery(office(d.locationID), d.corporationID, d.division);
      }
      if (stopping) return;
      await prepareMemberEquipment(e, current);
      e.startupPrepared = true;
      if (!stopping) e.defenderPreparation?.refresh();
    });
  }
  function stageAnchor(e: Entry) {
    if (e.anchorReady || stopping || e.fleetIssue) return;
    if (!soloSelfUnload && setup.fleetPolicy !== "EXISTING_ONLY") {
      const fleet = assembly?.snapshot();
      const creator =
        fleet?.pending?.kind === "create"
          ? fleet.pending.characterID
          : (fleet?.leaderID ?? setup.members.find((m) => m.role === "MINER")!.characterID);
      if (fleet?.fleetID == null && creator === e.member.characterID) return;
    }
    launch(e, async () => {
      const travelDoc = anchorDocument(e);
      try {
        guard(e);
        const options = {
          ...e.session.flow.requestOptions(),
          baseUrl: e.run.baseUrl,
          fetch: e.run.fetch,
        };
        const startedAt = Date.now(),
          f = decodeFlightStatus((await getFlightStatus(options)).flight);
        guard(e);
        if (f.shipID !== e.member.shipID || !valid(f.solarSystemID) || f.docked === f.inSpace)
          throw Error("Anchor travel pilot identity is unavailable.");
        rememberShip(e, f, startedAt);
        if (stopping) return;
        const dock = f.stationID ?? f.structureID;
        if (f.docked && valid(dock) && !departed.has(e)) startupDocks.set(e, dock);
        if (
          f.solarSystemID !== setup.systemID ||
          (travelDoc.read() as { pending?: unknown } | null)?.pending ||
          (f.transition && f.transition.phase !== "ready") ||
          f.shipMode?.toUpperCase() === "WARP"
        ) {
          anchorPending.add(e);
          report(
            e,
            "Traveling to mining system",
            "Following the native route to the saved anchor.",
          );
          const result = await (deps.anchor ?? ensureMiningAnchor)(e.run, e.session, {
            shipID: e.member.shipID,
            systemID: setup.systemID,
            current: () => guard(e),
            stopRequested: () => stopping,
            document: travelDoc,
            beforeDeparture: () => recallBeforeDeparture(e),
          });
          if (
            (
              travelDoc.read() as { history?: readonly { outcome: string }[] } | null
            )?.history?.some((h) => h.outcome !== "not-dispatched")
          )
            departed.add(e);
          anchorPending.delete(e);
          if (result === "stopped" || stopping) return;
        }
        e.anchorReady = true;
        report(
          e,
          "At mining system",
          initialBeltAssembly && op.snapshot().state === "READY"
            ? "Waiting for the fleet to assemble."
            : admitted(e)
              ? "Ready for the operation's selected grid."
              : "Waiting for this pilot's native fleet membership.",
          "paused",
        );
      } catch (error) {
        let pending = anchorPending.has(e);
        try {
          pending = !!(travelDoc.read() as { pending?: unknown } | null)?.pending;
        } catch {
          /* Preserve the original route fence. */
        }
        if (!pending) anchorPending.delete(e);
        if (!stopping) {
          e.retryAt = Date.now() + 3000;
          report(
            e,
            pending ? "Checking original anchor route" : "Retrying anchor observation",
            message(error),
            "paused",
          );
        }
      }
    });
  }
  function stageRally(e: Entry) {
    if (!e.anchorReady || atRally.has(e)) return;
    launch(e, async () => {
      const current = () => {
        guard(e);
        if (stopping) throw new FleetStopBeforeDispatch();
      };
      current();
      const flight = await readStopFlight(e);
      current();
      if (
        flight.shipID !== e.member.shipID ||
        flight.solarSystemID !== setup.systemID ||
        flight.docked === flight.inSpace
      )
        throw new FleetObservationUnavailable(
          "The pilot's arrival in the mining system is unverified.",
        );
      if (!rallyPoint) {
        const home = setup.parking?.mode === "STAY_IN_PLACE" ? undefined : setup.parking;
        const saved = [home, setup.delivery?.kind === "station" ? setup.delivery : undefined].find(
          (dock) => dock?.systemID === setup.systemID,
        );
        const stationID = flight.docked ? flight.stationID : null;
        if (saved)
          rallyPoint = Promise.resolve({
            kind: saved.kind,
            destinationID: saved.destinationID,
            systemID: setup.systemID,
          });
        else if (stationID)
          rallyPoint = Promise.resolve({
            kind: "station",
            destinationID: stationID,
            systemID: setup.systemID,
          });
        else
          rallyPoint = findMiningRallyPoint(e.run, setup.systemID, () => {
            if (stopping) throw new FleetStopBeforeDispatch();
          }).catch((error) => {
            rallyPoint = null;
            throw error;
          });
      }
      const point = await rallyPoint;
      current();
      report(
        e,
        "Heading to fleet rally",
        point.kind === "sun"
          ? "Flying to the mining system's sun before departure."
          : "Docking at the fleet's rally station.",
        "paused",
      );
      await reachMiningRallyPoint(e.run, e.session, point, e.member.shipID, flight, current, () =>
        recallBeforeDeparture(e),
      );
      current();
      atRally.add(e);
      report(
        e,
        "At fleet rally",
        "Waiting for all selected pilots to arrive before departing for the belt.",
        "paused",
      );
    });
  }
  function ensureAssembly() {
    if (!assembly) {
      const ordered = [
        ...setup.members.filter((m) => m.role === "MINER"),
        ...setup.members.filter((m) => m.role !== "MINER"),
      ];
      const peers: FleetAssemblyPeer[] = ordered.map((m) => {
        const held = () => {
          const e = entries.get(m.characterID);
          if (!e || stopping || e.emergency)
            throw Error("Fleet assembly pilot is unavailable or stopping.");
          guardHeld(e);
          return e;
        };
        const refresh = (e: Entry) => {
          e.fleetReadAt = 0;
        };
        return {
          characterID: m.characterID,
          shipID: m.shipID,
          get botID() {
            return entries.get(m.characterID)?.run.botID ?? "";
          },
          current() {
            held();
          },
          read: () => readFleetPeer(held()),
          invitation() {
            return held().session.store.fleet.get().pendingInvite;
          },
          async create() {
            const e = held();
            try {
              await e.session.flow.flying.bridgeDo("fleetObjectHandler", "CreateFleet", []);
            } finally {
              refresh(e);
            }
            held();
          },
          async invite(characterID, fleetID) {
            const e = held();
            try {
              await e.session.flow.flying.bridgeDo(
                "fleetObjectHandler",
                "Invite",
                [characterID, null, null, null],
                null,
                fleetID,
              );
            } finally {
              refresh(e);
            }
            held();
          },
          async accept(fleetID) {
            const e = held();
            try {
              await e.session.flow.flying.bridgeDo(
                "fleetObjectHandler",
                "AcceptInvite",
                [],
                null,
                fleetID,
              );
            } finally {
              refresh(e);
            }
            held();
          },
          async leave() {
            const e = held();
            try {
              await leaveFleet(e.session.flow.flying.bridgeDo);
            } finally {
              refresh(e);
            }
            held();
          },
        };
      });
      assembly = createFleetAssembly(
        document(
          `mining-fleet-assembly:${JSON.stringify([setup.operationID, setup.operationRunID])}`,
        ),
        setup.operationID,
        setup.operationRunID,
        peers,
        Date.now,
        setup.fleetMoves,
        () => restoringFleet,
        {
          existingOnly: setup.fleetPolicy === "EXISTING_ONLY",
          canCreate(peer) {
            const entry = entries.get(peer.characterID);
            return !!entry?.active && !entry.busy;
          },
          preferred: (peer) =>
            setup.members.some((m) => m.characterID === peer.characterID && m.role === "DEFENDER"),
          read(peer) {
            const e = entries.get(peer.characterID);
            return e?.active && !e.emergency && !e.reconnecting && !e.fleetIssue
              ? (e.fleetRead ?? null)
              : null;
          },
        },
      );
    }
    return assembly;
  }
  function advanceAssembly() {
    if (
      soloSelfUnload ||
      fleetCheck ||
      stopping ||
      ![...entries.values()].some((e) => e.startupManaged)
    )
      return;
    fleetCheck = true;
    track(
      Promise.resolve()
        .then(() => ensureAssembly().step())
        .then(() => {
          if (closed || stopping) return;
          fleetReadWarning = null;
          const a = assembly!.snapshot();
          const { parked } = op.snapshot();
          if (
            setup.members.every((m) => {
              const e = entries.get(m.characterID);
              return parked.includes(m.characterID) || (e?.active && admitted(e));
            })
          )
            restoringFleet = false;
          for (const pending of [...(a.deferred ?? []), ...(a.pending ? [a.pending] : [])]) {
            const e = entries.get(pending.characterID);
            if (e?.active && !e.emergency && !admitted(e) && !e.fleetIssue)
              reportFleetMembership(
                e,
                "Forming fleet",
                "Awaiting native " + pending.kind + " confirmation for this pilot.",
              );
          }
        })
        .catch((error) => {
          if (closed || stopping) return;
          fleetReadWarning = message(error);
          if (error instanceof SharedFleetConflict) requestStop();
        })
        .finally(() => {
          fleetCheck = false;
        }),
    );
  }
  async function bootstrap(assembleBeforeDeparture: boolean) {
    if (starting || stopping || op.snapshot().state !== "READY") return;
    const ready = [...entries.values()].filter(startupReady);
    if (
      assembleBeforeDeparture &&
      (ready.length !== setup.members.length || ready.some((e) => !atRally.has(e)))
    )
      return;
    const miner = ready.find((e) => e.member.role === "MINER");
    const scout =
      miner ?? (setup.siteSearch ? undefined : ready.find((e) => e.member.role === "DEFENDER"));
    if (!scout) return;
    starting = true;
    try {
      const lead = setup.members.find((m) => m.role === "MINER")!;
      const observe = () => observeMemberLocality(scout);
      if (setup.siteSearch && !resolvedSite) {
        const e = scout;
        searchPilot = e.member.characterID;
        departed.add(e);
        report(e, "Searching for a site", "Undocking and reading the native scanner.", "paused");
        searchUnsafe = true;
        const searchDoc = document(
          `mining-fleet-site-search:${JSON.stringify([setup.operationID, setup.operationRunID, e.member.characterID, e.member.shipID])}`,
        );
        let result: Awaited<ReturnType<typeof resolveMiningSite>>;
        try {
          result = await (deps.searchSite ?? resolveMiningSite)(e.run, e.session, {
            shipID: e.member.shipID,
            systemID: setup.systemID,
            family: setup.siteSearch.family,
            current: () => guard(e),
            stopRequested: () => stopping,
            document: searchDoc,
            available: (site) =>
              searchTargetAvailable(board, site.target, setup.operationID, setup.operationRunID),
            select: async (sites) => {
              const decision = rankLocality(
                sites.map((site) => ({
                  site,
                  target: site.target,
                  position: site.target.position,
                })),
                [await observe()],
              );
              selectionEvidence = decision.evidence;
              return decision.ranked[0]!.candidate.site;
            },
          });
        } catch (error) {
          const saved = searchDoc.read() as { pending?: unknown } | null;
          if (saved === null || saved.pending === null) searchUnsafe = false;
          throw error;
        }
        if (closed) return;
        searchUnsafe = false;
        if ("kind" in result) {
          searchReason =
            result.kind === "STOPPED"
              ? "Site search stopped before mining."
              : "No eligible site was observed before the search deadline.";
          if (!stopping) requestStop();
          return;
        }
        resolvedSite = result;
        target = result.target;
        if (stopping) return;
        effectiveSetup = { ...effectiveSetup, site: resolvedSite, siteSearch: undefined };
      }
      if (target?.kind === "BELT") {
        const decision = beltSelection(
          setup.beltCandidates ?? [{ beltID: setup.beltID!, beltName: setup.beltName! }],
          [await timed(scout.timing, "belt-locality-read", observe)],
        );
        if (closed || stopping) return;
        const selected = decision.ranked[0]?.candidate;
        if (!selected) throw Error("No unclaimed native belt is available.");
        if (
          selected.beltID === effectiveSetup.beltID &&
          selected.beltName !== effectiveSetup.beltName
        )
          throw Error("Native belt name changed since inspection; request a fresh Review.");
        selectionEvidence = decision.evidence;
        const next = setupOf({
          ...effectiveSetup,
          beltID: selected.beltID,
          beltName: selected.beltName,
        });
        if (!next) throw Error("Native belt selection is invalid.");
        document(
          `mining-fleet-initial-target:${JSON.stringify([setup.operationID, setup.operationRunID])}`,
        ).write({
          version: 1,
          operationID: setup.operationID,
          runID: setup.operationRunID,
          approvedSignature: signature,
          next,
          decision: selectionEvidence,
        });
        if (next.beltID !== effectiveSetup.beltID) {
          effectiveSetup = next;
          target = selected.target;
        }
      }
      if (
        stopping ||
        !scout.active ||
        !admitted(scout) ||
        (assembleBeforeDeparture && !ready.every(startupReady))
      )
        return;
      const claim = target && op.reserve(lead.characterID, target);
      if (!target || !claim || (!assembleBeforeDeparture && !op.activate(lead.characterID)))
        throw Error("Mining target claim could not be acquired.");
      telemetry.target(
        target,
        claim,
        selectionEvidence ?? { source: "retained-target-selection", site: resolvedSite ?? null },
      );
      persistTelemetry();
      scout.timing?.note("target-selected", {
        beltID: effectiveSetup.beltID,
        claimGeneration: claim.generation,
      });
    } catch (error) {
      if (!stopping) report(scout, "Target selection waiting", message(error), "paused");
    } finally {
      starting = false;
    }
  }
  function departForInitialBelt(claim: Claim) {
    const belt = target,
      beltID = effectiveSetup.beltID;
    if (belt?.kind !== "BELT" || !beltID) throw Error("The reserved starting belt is unavailable.");
    const pilots = [...entries.values()].filter(startupReady);
    if (pilots.length !== setup.members.length) return;
    const everyoneArrived = pilots.every((e) => atInitialBelt.has(e)),
      now = Date.now();
    const arrivalVerified = (e: Entry) => {
      const observedAt = atInitialBelt.get(e);
      return (
        observedAt !== undefined &&
        (!everyoneArrived || e.member.role !== "DEFENDER" || now - observedAt <= 15_000)
      );
    };
    // The normal per-pilot turns issue these warps together. Arrival is confirmed
    // by the same flight and belt-grid checks used for productive navigation.
    for (const e of pilots)
      if (!arrivalVerified(e))
        launch(e, async () => {
          const current = () => {
            guard(e);
            if (stopping) throw new FleetStopBeforeDispatch();
            const reserved = board.read(claim.key);
            if (
              reserved?.state !== "RESERVED" ||
              reserved.claim?.generation !== claim.generation ||
              reserved.claim.runID !== claim.runID ||
              reserved.claim.operationID !== claim.operationID
            )
              throw Error("The reservation for the fleet's starting belt changed.");
            if (!admitted(e))
              throw new FleetObservationUnavailable(
                "The pilot's native fleet membership is unverified.",
              );
          };
          current();
          e.leftStartupDock = true;
          departed.add(e);
          if (!atInitialBelt.has(e))
            report(
              e,
              "Warping to starting belt",
              "Flying with the assembled fleet to " + belt.name + ".",
              "paused",
            );
          const navigation = createNativeMiningNavigation(e.run, e.session, {
            shipID: e.member.shipID,
            beltID,
            current,
            timing: e.timing,
            observeFlight: (f, at) => rememberShip(e, f, at),
          });
          await navigation.navigate(belt, claim);
          current();
          atInitialBelt.set(e, Date.now());
          report(
            e,
            "At starting belt",
            "Belt arrival verified. Waiting for the rest of the fleet.",
            "paused",
          );
        });
    if (!everyoneArrived || pilots.some((e) => !arrivalVerified(e))) return;
    // In READY, no member can obtain a productive assignment. Only verified
    // arrivals, including every assigned Defender, release the starting belt.
    const leader = setup.members.find((m) => m.role === "MINER")!;
    if (!op.activate(leader.characterID)) throw Error("The starting belt could not be activated.");
    for (const e of pilots) if (e.member.role === "DEFENDER") e.escortGeneration = claim.generation;
    persistTelemetry();
  }
  function reconcileStoppedAnchors() {
    for (const e of anchorPending)
      launch(e, async () => {
        report(
          e,
          "Checking original anchor route",
          "Reading the held pilot's flight before Parking.",
          "paused",
        );
        const result = await (deps.anchor ?? ensureMiningAnchor)(e.run, e.session, {
          shipID: e.member.shipID,
          systemID: setup.systemID,
          current: () => guard(e),
          stopRequested: () => true,
          document: anchorDocument(e),
        });
        if (result !== "stopped" && result !== "arrived")
          throw Error("The original anchor route is still unresolved.");
        anchorPending.delete(e);
      });
  }
  function requestStop(mode?: StopFreightMode, fleetWipe = false) {
    const first = !stopping;
    op.noteStopRequest(
      mode ?? (op.snapshot().stopRequested ? undefined : "RETURN_HOME"),
      fleetWipe || deadlineStop,
    );
    stopping = true;
    if ((first && op.snapshot().state === "ACTIVE") || fleetWipe)
      for (const e of entries.values())
        if (!fleetWipe || e.active)
          report(
            e,
            "Stopping",
            fleetWipe
              ? "Fleet loss threshold reached. Returning home."
              : deadlineStop
                ? "The shift is nearing its end. Settling existing work before returning home."
                : "Finishing existing work before parking.",
            "paused",
          );
    if (first && op.snapshot().state === "READY") {
      startupStop = true;
      for (const e of entries.values())
        report(
          e,
          "Stopping startup",
          departed.has(e) ? "Settling the original departure." : "Stopping before departure.",
          "paused",
        );
    }
    for (const e of entries.values())
      if (e.active) {
        e.failed = null;
        e.retryAt = 0;
        e.stopRetries = 0;
      }
    persistTelemetry();
    return op.snapshot().stopFreight;
  }
  async function dockedAtStartup(e: Entry) {
    if (!startupStop && (!e.startupManaged || e.leftStartupDock)) return null;
    guard(e);
    const { flight } = await getFlightStatus({
      ...e.session.flow.requestOptions(),
      baseUrl: e.run.baseUrl,
      fetch: e.run.fetch,
    });
    guard(e);
    const f = decodeFlightStatus(flight),
      destinationID = f.stationID ?? f.structureID;
    if (
      f.shipID !== e.member.shipID ||
      !f.docked ||
      f.inSpace ||
      (f.transition && f.transition.phase !== "ready") ||
      !valid(destinationID) ||
      !valid(f.solarSystemID) ||
      (departed.has(e) && startupDocks.get(e) !== destinationID)
    )
      return null;
    report(e, "Docked", "Still docked at the startup location; no parking route is needed.");
    return {
      destinationID,
      kind: f.structureID ? ("structure" as const) : ("station" as const),
      systemID: f.solarSystemID,
    };
  }
  const finishMemberParking = (e: Entry, parkingSetup: FleetSetup) =>
    finishParking(
      {
        ...e.run,
        report: (r) =>
          report(
            e,
            r.phase ?? "Parking",
            r.why ?? "",
            r.status === "running" ? "running" : "paused",
          ),
      },
      e.session,
      parkingSetup,
      e.member.shipID,
      () => guard(e),
      document,
      {
        onUnloadRemaining: (freight) => {
          e.parkingFreight = freight;
          report(e, "Unloading at home", parkingFreightNote(e), "paused");
        },
      },
    );
  async function readStopFlight(e: Entry) {
    guardHeld(e);
    const options = {
      ...e.session.flow.requestOptions(),
      baseUrl: e.run.baseUrl,
      fetch: e.run.fetch,
    };
    const startedAt = Date.now(),
      flight = decodeFlightStatus((await getFlightStatus(options).catch(fleetReadFailed)).flight);
    guardHeld(e);
    rememberShip(e, flight, startedAt);
    return flight;
  }
  function rememberShip(
    e: Entry,
    flight: ReturnType<typeof decodeFlightStatus>,
    startedAt: number,
  ) {
    if (!valid(flight.shipID) || flight.shipIsCapsule === true) return;
    if (flight.shipID !== e.member.shipID || flight.docked) {
      e.lastShip = null;
      return;
    }
    if (flight.inSpace && valid(flight.shipTypeID)) {
      e.deployedAt ??= startedAt;
      if (!e.lastShip || e.lastShip.at <= startedAt)
        e.lastShip = { shipTypeID: flight.shipTypeID, at: startedAt };
    }
  }
  function applyFleetWipe(sample: FleetTelemetry) {
    const snapshot = op.snapshot();
    const wipe = confirmFleetWipe(snapshot, sample, sample.shipLosses ?? [], target);
    if (!wipe) return;
    board.markDangerous(wipe);
    if (snapshot.claim?.key === targetKey(wipe.target) && snapshot.stopFreight !== "RETURN_HOME")
      requestStop("RETURN_HOME", true);
  }
  async function recordCapsuleLoss(e: Entry) {
    if (e.lossChecked || !e.lastShip || !op.snapshot().claim) return;
    e.lossChecked = true;
    const { shipTypeID, at } = e.lastShip,
      capsuleSeenAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        guardHeld(e);
        const raw = await e.session.flow.flying.bridgeAsk(
          "charMgr",
          "GetRecentShipKillsAndLosses",
          [25, null],
          undefined,
          undefined,
          { signal: AbortSignal.timeout(2_000) },
        );
        guardHeld(e);
        const loss = readShipLoss(raw, { ...e.member, shipTypeID }, at, capsuleSeenAt);
        if (loss) {
          telemetry.recordLoss(loss);
          const sample = telemetrySnapshot();
          telemetry.persist(sample);
          applyFleetWipe(sample);
          return;
        }
      } catch (error) {
        if (
          !e.active ||
          e.session.flow.flying.isSessionClosing() ||
          (error as { code?: string } | null)?.code === "SESSION_REQUEST_RETIRED"
        )
          return;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function stopCapsuleID(e: Entry, flight: ReturnType<typeof decodeFlightStatus>) {
    if (flight.shipIsCapsule !== true) {
      if (
        flight.shipIsCapsule === null &&
        valid(flight.shipID) &&
        flight.shipID !== e.member.shipID
      )
        throw new FleetObservationUnavailable(
          "Waiting for native confirmation of the current ship type.",
        );
      return null;
    }
    if (
      !valid(flight.shipID) ||
      !valid(flight.solarSystemID) ||
      flight.inSpace === flight.docked ||
      (flight.docked && !valid(flight.stationID ?? flight.structureID))
    )
      throw new FleetObservationUnavailable(
        "The capsule's current native location is unavailable.",
      );
    return flight.shipID;
  }
  function requestEmergencyRetreat(e: Entry, error: unknown) {
    if (e.emergency || !(error instanceof FleetShipChanged && error.capsule)) return false;
    beginEmergency(e, "The original ship was lost. Parking the current capsule.");
    return true;
  }
  function beginEmergency(e: Entry, why: string) {
    e.emergency = true;
    e.failed = null;
    e.retryAt = 0;
    if (e.member.role === "COMMAND")
      supportSample = {
        observation: { state: "RECOVERY", core: "unknown", reason: why, fresh: true },
        observedAt: Date.now(),
      };
    report(e, "Emergency retreat", why, "paused");
  }
  async function readHull(e: Entry) {
    guardHeld(e);
    const raw = await e.session.flow.flying
      .bridgeAsk("dogmaIM", "GetLayerDamageValuesByItems", [[e.member.shipID]])
      .catch(fleetReadFailed);
    guardHeld(e);
    return readHullRatio(raw, e.member.shipID);
  }
  function observeHull(e: Entry) {
    if (!e.active || e.emergency || e.hullReading || (e.hullReadAt ?? 0) > Date.now()) return;
    e.hullReading = true;
    e.hullReadAt = Date.now() + 5000;
    const sample = async () => {
      if (soloSelfUnload && stopCapsuleID(e, await readStopFlight(e)) !== null) {
        if (!stopping && !e.emergency)
          beginEmergency(e, "The original ship was lost. Parking the current capsule.");
        return null;
      }
      return readHull(e);
    };
    track(
      sample()
        .then(async (ratio) => {
          if (stopping || !e.active || e.emergency) return;
          if (ratio === null) {
            if (
              e.failed &&
              stopCapsuleID(e, await readStopFlight(e)) !== null &&
              !stopping &&
              !e.emergency
            )
              beginEmergency(e, "The original ship was lost. Parking the current capsule.");
            return;
          }
          if (ratio >= 0.95) return;
          e.hullRetreat = ratio < 0.6 ? "delivery" : "nearest";
          beginEmergency(
            e,
            "Hull integrity is " +
              (ratio * 100).toFixed(1) +
              "%. " +
              (e.hullRetreat === "delivery"
                ? "Withdrawing to the delivery station for repair."
                : "Withdrawing to the nearest dock for repair."),
          );
        })
        .catch(() => {
          /* Unavailable hull data is no evidence of damage. Recheck on the next observation. */
        })
        .finally(() => {
          e.hullReading = false;
        }),
    );
  }
  function endParkedRun(e: Entry, phase: string, why: string) {
    report(e, phase, why);
    e.unregister();
    e.active = false;
    e.session.flow.setLivePush(false);
    e.run.report({ status: "stopped", phase, why });
    persistTelemetry();
  }
  function finishEmergencyDock(
    e: Entry,
    proof: Parameters<typeof op.parkMember>[1],
    reason?: string,
  ) {
    guardHeld(e);
    const snapshot = op.snapshot(),
      id = e.member.characterID;
    const pending =
      snapshot.jetcanIntents[String(id)] ||
      hasHaulWork(snapshot, id) ||
      e.selfUnload?.snapshot()?.pending ||
      (setup.oreLogistics?.remoteCompression &&
        (compressionDocument(e).read() as { pending?: unknown } | null)?.pending);
    if (!pending && !op.parkMember(id, proof, true))
      throw Error("Native emergency docking could not be verified.");
    endParkedRun(
      e,
      pending
        ? "Emergency dock; freight recovery pending"
        : reason
          ? "Parked after hull retreat"
          : "Emergency dock",
      [
        "Emergency docking at " + proof.locationID + " was verified.",
        reason,
        pending
          ? "The original inventory action remains unresolved."
          : "Any cargo and unrecovered drones remain for review.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  async function parkCapsule(e: Entry, shipID: number, emergency = false) {
    const current = () => guardHeld(e);
    const lossCheck = recordCapsuleLoss(e);
    const capsuleSetup: FleetSetup = {
      ...setup,
      parking: {
        mode: "RETURN_HOME_DOCK",
        destinationID: setup.destinationID,
        kind: setup.delivery?.kind ?? "station",
        systemID: setup.delivery?.systemID ?? setup.systemID,
      },
    };
    const parked = await finishParking(
      { ...e.run, report: (r) => report(e, r.phase ?? "Parking capsule", r.why ?? "", "paused") },
      e.session,
      capsuleSetup,
      shipID,
      current,
      document,
    ).finally(() => lossCheck);
    current();
    if (parked.kind !== "dock") throw Error("Native capsule docking could not be verified.");
    const proof = {
      ...parked.proof,
      source: "native-capsule-dock" as const,
      runID: setup.operationRunID,
    };
    if (emergency) {
      finishEmergencyDock(e, proof);
      return;
    }
    if (!op.parkMember(e.member.characterID, proof))
      throw Error("Native capsule docking could not be verified.");
    endParkedRun(e, "Docked", "Capsule docking at the delivery destination was verified.");
  }
  async function parkStopCapsule(e: Entry) {
    const snapshot = op.snapshot();
    if (
      !snapshot.stopFreight ||
      snapshot.relocation ||
      snapshot.parked.includes(e.member.characterID) ||
      !["ACTIVE", "DRAINING", "SETTLING", "PARKING"].includes(snapshot.state)
    )
      return false;
    const shipID = stopCapsuleID(e, await readStopFlight(e));
    if (shipID === null) return false;
    await parkCapsule(e, shipID);
    return true;
  }
  const deliveryDock = {
    mode: "RETURN_HOME_DOCK",
    destinationID: setup.destinationID,
    kind: setup.delivery?.kind ?? "station",
    systemID: setup.delivery?.systemID ?? setup.systemID,
  } as const;
  async function repairHull(e: Entry, dock: Awaited<ReturnType<typeof readStopFlight>>) {
    const { bridgeAsk, bridgeDo } = e.session.flow.flying;
    const shipID = e.member.shipID;
    const before = await readHull(e);
    if (stopping) return false;
    if (before === null) throw Error("Native hull integrity is unavailable at the repair dock.");
    if (before >= 0.95) return true;
    if (e.repairDispatched)
      throw Error(
        "The original repair payment could not be verified. Check the ship at the repair dock.",
      );
    if (e.hullRetreat === "nearest" && before < 0.6) {
      e.hullRetreat = "delivery";
      return false;
    }
    const part = await quoteHullRepair(bridgeAsk, shipID);
    const verifyDock = async () => {
      const current = await readStopFlight(e);
      if (stopping) throw new FleetStopBeforeDispatch();
      if (
        current.shipID !== shipID ||
        !current.docked ||
        current.inSpace ||
        current.solarSystemID !== dock.solarSystemID ||
        current.stationID !== dock.stationID ||
        current.structureID !== dock.structureID ||
        (current.transition && current.transition.phase !== "ready")
      )
        throw Error("The held ship or repair dock changed.");
      return current;
    };
    if (stopping) return false;
    if (!part) throw Error("The repair shop returned no quote for the damaged hull.");
    const repair = async () => {
      const current = await verifyDock();
      let refusal: unknown;
      try {
        await repairQuotedHull(
          (...args) => {
            guardHeld(e);
            if (stopping) throw new FleetStopBeforeDispatch();
            e.repairDispatched = true;
            return bridgeDo(...args);
          },
          shipID,
          part.cost,
          current,
        );
      } catch (error) {
        refusal = error;
      }
      // Verify physical repair even when the payment reply was lost.
      const after = await readAfterTimeout(() => readHull(e));
      if (after !== null && after >= 0.95) return true;
      if (refusal) throw refusal;
      throw Error("The repair shop did not confirm restored hull integrity.");
    };
    try {
      return await repair();
    } catch (error) {
      const amount = refusedRepairCharge(error);
      if (amount === null) throw error;
      // Only a definite personal-wallet refusal authorizes the fallback.
      const corporationID = e.session.store.station.get().online?.corporationID;
      if (!valid(corporationID))
        throw Error("The repair pilot's corporation wallet is unavailable.", { cause: error });
      await fundHullRepair({
        bridgeAsk,
        bridgeDo,
        characterID: e.run.characterID,
        corporationID,
        amount,
        verifyDock,
        beforeWrite() {
          guardHeld(e);
          if (stopping) throw new FleetStopBeforeDispatch();
        },
      });
      return repair();
    }
  }
  async function parkEmergency(e: Entry) {
    const before = await readStopFlight(e),
      capsule = stopCapsuleID(e, before);
    if (stopping && e.hullRetreat) return;
    const shipID = e.member.shipID;
    if (capsule === null && before.shipID !== shipID)
      throw Error("Emergency retreat needs the held native ship or its current capsule.");
    for (const [id, haul] of Object.entries(op.snapshot().haulClaims)) {
      if (
        haul.characterID !== e.member.characterID ||
        !op.cancelUndispatchedHaul(e.member.characterID, Number(id), haul.generation)
      )
        continue;
      if (e.lease?.itemID === Number(id)) {
        clearInterval(e.lease.timer);
        e.lease = null;
        void post(e, "/api/bots/loot-memory/release", { runID: e.run.botID }).catch(() => {});
      }
    }
    if (capsule !== null) return parkCapsule(e, capsule, true);
    const current = () => guardHeld(e);
    const progress = (phase: string, why: string) => report(e, phase, why);
    const claim = op.snapshot().claim;
    const useDeliveryDock = e.hullRetreat === "delivery";
    let destination;
    try {
      if (
        e.member.role === "DEFENDER" &&
        before.inSpace &&
        before.shipMode?.toUpperCase() === "FOLLOW"
      ) {
        await e.session.flow.stopShip().catch(() => current());
        if (stopping && e.hullRetreat) return;
      }
      if (e.member.role === "COMMAND" && before.inSpace) {
        if (e.tractorWork) await tractorService(e, true);
        if (
          (setup.command?.compressor && !(await compressorInactive(e))) ||
          (setup.command?.core && !(await coreInactive(e)))
        )
          return;
        if (stopping) return;
      }
      destination = useDeliveryDock
        ? await parkAtOperationHome(e.run, e.session, deliveryDock, progress, current, {
            expectedShipID: shipID,
          })
        : deps.park
          ? await deps.park(e.run, e.session, progress, current)
          : await parkWithPolicy(
              e.run,
              e.session,
              progress,
              current,
              { mode: "nearest" },
              { expectedShipID: shipID },
            );
    } catch (error) {
      // The original ship can be destroyed while following the emergency route.
      const flight = await readStopFlight(e).catch(() => {
        guardHeld(e);
        throw error;
      });
      const currentCapsule = stopCapsuleID(e, flight);
      if (currentCapsule !== null) return parkCapsule(e, currentCapsule, true);
      throw error;
    }
    const dock = await readStopFlight(e),
      currentCapsule = stopCapsuleID(e, dock);
    if (currentCapsule !== null) return parkCapsule(e, currentCapsule, true);
    if (
      dock.shipID !== shipID ||
      !dock.docked ||
      dock.inSpace ||
      dock.solarSystemID !== destination.systemID ||
      (destination.kind === "station" ? dock.stationID : dock.structureID) !==
        destination.destinationID ||
      (dock.transition && dock.transition.phase !== "ready")
    )
      throw new FleetObservationUnavailable("Emergency docking is not yet verified.");
    if (stopping && e.hullRetreat) return;
    const proof = {
      source: "native-flight" as const,
      runID: setup.operationRunID,
      shipID: dock.shipID,
      locationID: destination.destinationID,
      docked: true,
      observedAt: Date.now(),
    };
    if (!e.hullRetreat) return finishEmergencyDock(e, proof);
    report(
      e,
      "Repairing hull",
      "Checking the current hull at dock " + destination.destinationID + ".",
      "paused",
    );
    try {
      if (!(await repairHull(e, dock))) return;
    } catch (error) {
      if (stopping) return;
      const fresh = await readStopFlight(e);
      if (stopping) return;
      if (
        fresh.shipID !== dock.shipID ||
        !fresh.docked ||
        fresh.inSpace ||
        fresh.solarSystemID !== dock.solarSystemID ||
        fresh.stationID !== dock.stationID ||
        fresh.structureID !== dock.structureID ||
        (fresh.transition && fresh.transition.phase !== "ready")
      )
        throw error;
      return finishEmergencyDock(
        e,
        { ...proof, observedAt: Date.now() },
        "Hull repair unavailable. " + message(error),
      );
    }
    if (stopping) return;
    e.hullRetreat = undefined;
    e.emergency = false;
    e.repairDispatched = false;
    e.anchorReady = dock.solarSystemID === setup.systemID;
    e.movementSuspended = false;
    e.commandMineTurn = false;
    e.commandArrival = undefined;
    e.escortGeneration = undefined;
    e.hullReadAt = Date.now() + 5000;
    if (op.snapshot().claim?.generation !== claim?.generation) e.defender = undefined;
    report(e, "Hull integrity verified", "Returning to the current operation target.");
  }
  let searchPilot = setup.members.find((m) => m.role === "MINER")!.characterID;
  const startupBlocked = (e: Entry) =>
    anchorPending.has(e) || (searchUnsafe && e.member.characterID === searchPilot);
  function reconcileStoppedSearch() {
    if (starting) return;
    const e = entries.get(searchPilot),
      search = setup.siteSearch;
    if (!e || !search || !searchUnsafe) return;
    launch(e, async () => {
      report(
        e,
        "Checking original site search",
        "Verifying the search pilot's current native state before Parking.",
        "paused",
      );
      const result = await (deps.searchSite ?? resolveMiningSite)(e.run, e.session, {
        shipID: e.member.shipID,
        systemID: setup.systemID,
        family: search.family,
        current: () => guard(e),
        stopRequested: () => true,
        document: document(
          `mining-fleet-site-search:${JSON.stringify([setup.operationID, setup.operationRunID, e.member.characterID, e.member.shipID])}`,
        ),
      });
      guard(e);
      if (!("kind" in result) || result.kind !== "STOPPED")
        throw Error("The original site search is still unresolved.");
      searchUnsafe = false;
      searchReason = "Site search stopped before mining.";
    });
  }
  function pendingUnloadCheck(e: Entry) {
    const pending = e.pendingUnload;
    if (!pending || !e.active || e.busy || !e.failed) return;
    return async () => {
      e.busy = true;
      e.work = pending.checkAndRelease();
      try {
        await e.work;
        guard(e);
        e.pendingUnload = undefined;
        e.failed = null;
        e.retryAt = 0;
      } finally {
        e.work = undefined;
        e.busy = false;
      }
    };
  }
  function launch(e: Entry, work: () => Promise<void>) {
    if (e.busy || !e.active || e.failed || (e.retryAt ?? 0) > Date.now()) return;
    e.busy = true;
    e.pendingUnload = undefined;
    e.timing?.beginPass();
    const runWork = async () => {
      if (stopping && !e.emergency && !startupBlocked(e) && (await parkStopCapsule(e))) return;
      await work();
    };
    e.work = runWork()
      .then(() => {
        e.observationFailures = 0;
      })
      .catch((error) => {
        if (!e.active) return;
        if (!stopping && requestEmergencyRetreat(e, error)) return;
        if (
          (stopping || relocating || e.emergency) &&
          (error instanceof FleetStopBeforeDispatch ||
            (e.member.role === "DEFENDER" && error instanceof DefenderStopBeforeAction))
        )
          return;
        if (stopping && error instanceof HaulStoppedBeforePickup) return;
        if (!stopping && error instanceof FleetObservationUnavailable) {
          try {
            if (e.emergency) guardHeld(e);
            else guard(e);
          } catch (ownerError) {
            error = ownerError;
          }
          if (error instanceof FleetObservationUnavailable) {
            const failures = Math.min((e.observationFailures ?? 0) + 1, 5);
            const seconds = Math.min(30, 3 * 2 ** (failures - 1));
            e.observationFailures = failures;
            e.retryAt = Date.now() + seconds * 1000;
            report(
              e,
              failures >= 3 ? "Native observation unavailable" : "Retrying native observation",
              message(error) + " Rechecking the same pilot in " + seconds + " seconds.",
              "paused",
            );
            return;
          }
        }
        if (
          ((!stopping || collectStop()) && error instanceof FreightGridUnavailable) ||
          (collectStop() && error instanceof FleetObservationUnavailable)
        ) {
          e.retryAt = Date.now() + 5000;
          report(e, "Waiting for native evidence", error.message, "paused");
          return;
        }
        if (error instanceof TravelAssistPending) {
          e.retryAt = Date.now() + 5000;
          report(e, "Settling Travel Assist", error.message, "paused");
          return;
        }
        const action = e.telemetry?.phase;
        if (
          stopping &&
          (transientNativeRead(error) ||
            error instanceof FleetObservationUnavailable ||
            ["JETCAN_OBSERVATION_PENDING", "MCC_MODULE_SHUTDOWN_PENDING"].includes(
              String((error as { code?: unknown } | null)?.code),
            )) &&
          (e.stopRetries ?? 0) < 3
        ) {
          e.stopRetries = (e.stopRetries ?? 0) + 1;
          e.retryAt = Date.now() + e.stopRetries * 3000;
          report(
            e,
            "Retrying Stop",
            [action, message(error), "Rechecking the original held pilot."]
              .filter(Boolean)
              .join(" "),
            "paused",
          );
          return;
        }
        if (error instanceof UnconfirmedHaulerUnload) e.pendingUnload = error;
        e.failed = message(error);
        const detail = stopping
          ? [
              action && action !== "Stop needs attention" ? action + ":" : null,
              e.failed,
              parkingFreightNote(e),
            ]
              .filter(Boolean)
              .join(" ")
          : e.failed;
        report(
          e,
          e.emergency
            ? "Emergency retreat needs attention"
            : stopping
              ? "Stop needs attention"
              : "Needs attention",
          detail,
          "paused",
        );
      })
      .finally(() => {
        e.timing?.endPass();
        e.busy = false;
        e.work = undefined;
      });
  }
  function supportSnapshot() {
    const e = [...entries.values()].find((x) => x.member.role === "COMMAND");
    if (!e) return null;
    const read = (f: () => unknown) => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    return {
      characterID: e.member.characterID,
      shipID: e.member.shipID,
      botID: e.run.botID,
      sessionGeneration: e.generation ?? null,
      active: e.active,
      movementSuspended: e.movementSuspended ?? false,
      emptyBurstModules: e.burstEmpty?.size ?? 0,
      coreObservation: e.coreObservation ?? null,
      compressorObservation: e.compressorObservation ?? null,
      observedSupport: supportSample ? structuredClone(supportSample) : null,
      bursts: e.commandGroup
        ? e.commandGroup
            .units()
            .map((u) => ({
              moduleID: u.moduleID,
              typeID: u.typeID,
              controller: read(() => u.command.snapshot()),
              proof: read(() => u.proof.snapshot()),
            }))
        : e.command && setup.command?.moduleID
          ? [
              {
                moduleID: setup.command.moduleID,
                typeID: setup.command.typeID,
                controller: read(() => e.command!.snapshot()),
                proof: e.commandProof ? read(() => e.commandProof!.snapshot()) : null,
              },
            ]
          : [],
      core: e.core ? read(() => e.core!.snapshot()) : null,
      compressor: e.compressor ? read(() => e.compressor!.snapshot()) : null,
      tractor: e.tractorWork?.controller ? read(() => e.tractorWork!.controller!.snapshot()) : null,
      tractorContainerID: e.tractorWork?.manifest.containerID ?? null,
      collectionContainerID: e.collectCanID ?? null,
    };
  }
  const telemetryDoc = document(
    `mining-fleet-telemetry:${JSON.stringify([setup.operationID, setup.operationRunID])}`,
  );
  const retainedTelemetry = restored
    ? readFleetTelemetry(telemetryDoc, setup.operationID, setup.operationRunID)
    : null;
  const telemetry = createFleetTelemetry(telemetryDoc, setup.operationID, setup.operationRunID);
  function telemetrySnapshot(stopped = false) {
    return {
      ...telemetry.sample(
        [...entries.values()].map((e) => ({
          characterID: e.member.characterID,
          shipID: e.member.shipID,
          deployedAt: e.deployedAt,
          lastShip: e.lastShip,
          role: e.member.role,
          botID: e.run.botID,
          active: e.active,
          phase: e.telemetry?.phase ?? null,
          reason: e.telemetry?.reason ?? e.failed,
          reportedAt: e.telemetry?.reportedAt ?? null,
          freight:
            e.cycle?.getFreightStatus?.() ??
            e.commandHauler?.getFreightStatus?.() ??
            (e.native as RawHaulerNative)?.getFreightStatus?.() ??
            null,
        })),
        stopped,
      ),
      stopRequested: stopping,
      operationWarning:
        fleetReadWarning ??
        (!stopping &&
        [...entries.values()].some((e) => e.member.role === "DEFENDER") &&
        [...entries.values()]
          .filter((e) => e.member.role === "DEFENDER")
          .every((e) => !e.active || !!e.failed)
          ? "Defender coverage unavailable. Review each Defender's reason."
          : null),
    };
  }
  function persistTelemetry(stopped = false) {
    if (closed) return;
    try {
      telemetry.persist(telemetrySnapshot(stopped));
    } catch {
      /* No native authority depends on display metadata. */
    }
  }
  function persistSupportSnapshot() {
    if (closed) return;
    try {
      const value = supportSnapshot();
      if (value)
        document(
          `mining-fleet-support-telemetry:${JSON.stringify([setup.operationID, setup.operationRunID])}`,
        ).write({ version: 1, operationID: setup.operationID, runID: setup.operationRunID, value });
    } catch {
      /* Readout is optional and must not affect custody. */
    }
  }
  async function tick() {
    if (closed) return;
    if (!stopping || collectStop()) {
      const hostedExpiry = Math.min(
        ...[...entries.values()]
          .filter((e) => !e.emergency && (e.active || e.reconnecting))
          .map((e) => e.expiry),
      );
      const end = Math.min(shiftEndsAt ?? Infinity, hostedExpiry);
      const lead =
        shiftEndsAt === undefined ? 180_000 : stopping ? 0 : MINING_STOP_WINDOW_MINUTES * 60_000;
      if (Date.now() >= end - lead) {
        deadlineStop = true;
        requestStop("RETURN_HOME");
      }
    }
    if (!stopping && !relocating) {
      const { state, claim: reserved } = op.snapshot();
      const assembleBeforeDeparture =
        state === "READY" &&
        initialBeltAssembly &&
        [...entries.values()].some((e) => e.startupManaged);
      const gathering = assembleBeforeDeparture && !reserved;
      if (state === "READY" || state === "ACTIVE") {
        const verified =
          state === "ACTIVE" && !soloSelfUnload
            ? [...entries.values()].filter(
                (e) =>
                  e.startupManaged && e.active && !e.emergency && !e.reconnecting && admitted(e),
              )
            : [];
        const observer =
          verified.find((e) => e.fleetReading) ??
          verified.find((e) => !e.fleetWarning) ??
          verified[0];
        if (observer) observeFleet(observer, verified);
        const verifiedSet = new Set(verified);
        for (const e of entries.values()) {
          if (state === "ACTIVE") observeHull(e);
          if (!e.startupManaged || e.emergency) continue;
          if (e.startupPrepared === false) {
            stageMemberPreparation(e);
            continue;
          }
          if (!soloSelfUnload && !verifiedSet.has(e)) observeFleet(e);
          stageAnchor(e);
          if (gathering) stageRally(e);
        }
        advanceAssembly();
      }
      if (state === "READY") {
        if (assembleBeforeDeparture && reserved) departForInitialBelt(reserved);
        else track(bootstrap(assembleBeforeDeparture));
        return;
      }
    }
    if (stopping && relocating) {
      if (!op.cancelRelocation())
        throw Error("Relocation release requires reconciliation before Stop.");
      relocating = false;
    }
    if (relocating && !stopping && starting) return;
    if (stopping) {
      reconcileStoppedAnchors();
      reconcileStoppedSearch();
    }
    if (
      stopping &&
      op.snapshot().state === "READY" &&
      setup.members.some(
        (m) => !entries.has(m.characterID) && !op.snapshot().neverStarted?.includes(m.characterID),
      )
    ) {
      for (const e of entries.values())
        if (!startupBlocked(e))
          launch(e, async () => {
            report(
              e,
              "Stopping startup",
              "Confirming native module and drone settlement.",
              "paused",
            );
            const proof = await settleMember(e);
            guard(e);
            if (
              proof.modulesInactive !== true ||
              proof.dronesSafe !== true ||
              !Number.isFinite(proof.observedAt) ||
              proof.observedAt > Date.now() ||
              Date.now() - proof.observedAt > 15000
            )
              throw Error("Native settlement could not be verified.");
            const parkingSetup = parkingForStop(e);
            if (parkingSetup) await finishMemberParking(e, parkingSetup);
            else if (!(await dockedAtStartup(e)))
              await (deps.park ?? parkNearest)(
                e.run,
                e.session,
                (p, w) => report(e, p, w),
                () => guard(e),
              );
            guard(e);
            await e.cycle?.release?.();
            guard(e);
            report(
              e,
              "Docked",
              "Pilot docked before the fleet formed; remaining launch receipts are retained.",
            );
            e.unregister();
            e.active = false;
            e.session.flow.setLivePush(false);
            e.run.report({
              status: "stopped",
              phase: "Docked",
              why: "Pilot docked before the fleet formed. Fleet launch remains incomplete.",
            });
            persistTelemetry();
          });
      return;
    }
    for (const e of entries.values())
      if (e.emergency) {
        if (stopping && e.active && e.hullRetreat && !e.busy) {
          e.hullRetreat = undefined;
          e.emergency = false;
          e.failed = null;
          e.retryAt = 0;
        } else launch(e, () => parkEmergency(e));
      }
    const moving = (e: Entry) =>
      !relocating ||
      stopping ||
      op.movingMembers().some((m) => m.characterID === e.member.characterID);
    if (stopping || relocating) {
      const defenders = [...entries.values()].filter(
        (e) =>
          e.member.role === "DEFENDER" &&
          !e.emergency &&
          !e.defenderSettled &&
          moving(e) &&
          !coveringDeparture(e),
      );
      for (const e of defenders) {
        if (!e.active) {
          report(
            e,
            "Defender custody unresolved",
            "The defender is unavailable before physical settlement.",
            "paused",
          );
          continue;
        }
        if (stopping && startupBlocked(e)) continue;
        launch(e, async () => {
          report(
            e,
            "Settling defender",
            "Stopping weapons and recalling controlled drones.",
            "paused",
          );
          if (e.defender) await e.defender.stop(dockAfterDroneTimeout());
          const proof = await settleMember(e);
          guard(e);
          if (
            proof.modulesInactive !== true ||
            proof.dronesSafe !== true ||
            !Number.isFinite(proof.observedAt) ||
            proof.observedAt > Date.now() ||
            Date.now() - proof.observedAt > 15000
          )
            throw Error("Defender physical settlement is uncertain.");
          e.defenderSettled = true;
          report(e, "Defender settled", "Owned modules and drones are settled.");
        });
      }
      // Relocation still needs the full roster. Stop can park other verified owners independently.
      if (relocating && !stopping && defenders.length) return;
    }
    // Own effects gate this ship and the freight it still owns. Relocation
    // still requires the whole roster; independent parking during Stop does not.
    const commander = [...entries.values()].find((e) => e.member.role === "COMMAND");
    if (
      (stopping || relocating) &&
      commander?.active &&
      !commander.emergency &&
      moving(commander) &&
      !commander.commandSettled &&
      !startupBlocked(commander)
    ) {
      launch(commander, async () => {
        report(
          commander,
          "Settling COMMAND",
          "Checking the selected ship's native effects.",
          "paused",
        );
        if (commander.tractorWork) {
          report(
            commander,
            "Settling tractor",
            "Checking the original tractor effect and freight claim.",
            "paused",
          );
          await tractorService(commander, true);
        }
        if (setup.command?.compressor) {
          report(
            commander,
            "Settling compressor",
            "Checking the original native compressor effect.",
            "paused",
          );
          if (!(await compressorInactive(commander, stopping))) return;
        }
        if (setup.command?.core) {
          report(
            commander,
            "Settling Industrial Core",
            "Checking the original Core effect and fuel receipt.",
            "paused",
          );
          if (!(await coreInactive(commander, stopping))) return;
        }
        if (
          !effectiveSetup.siteSearch ||
          resolvedSite ||
          commander.command ||
          commander.commandGroup
        ) {
          const group = ensureBurstGroup(commander);
          if (setup.command?.bursts && !group)
            throw Error("The selected burst modules could not be initialized for shutdown.");
          if (group) {
            const result = await group.stop();
            if (!result.complete) {
              const waiting = result.modules.filter((m) => m.state !== "inactive");
              const reason = waiting
                .map((m) => "Module " + m.moduleID + ": " + m.reason)
                .join("; ");
              const units = group
                .units()
                .filter((u) => waiting.some((m) => m.moduleID === u.moduleID));
              if (
                units.length !== waiting.length ||
                units.some((u) => {
                  const deadline = commandStopDeadline(u.command.snapshot());
                  return deadline === null || Date.now() >= deadline;
                })
              )
                throw Error(reason);
              report(commander, "Waiting for command shutdown", reason, "paused");
              return;
            }
          }
          const command = ensureCommand(commander);
          if (setup.command?.moduleID && !command)
            throw Error("The selected burst module could not be initialized for shutdown.");
          if (command) {
            try {
              await command.settle();
            } catch (error) {
              const deadline = commandStopDeadline(command.snapshot(), commander.commandBaseline);
              if (deadline === null || Date.now() >= deadline) throw error;
              report(
                commander,
                "Waiting for command shutdown",
                "Module " +
                  setup.command?.moduleID +
                  ": the original burst deactivation still awaits native effect confirmation.",
                "paused",
              );
              return;
            }
          }
        } else if (!(await dockedAtStartup(commander))) {
          throw Error("The command pilot's startup dock is unverified.");
        }
        const proof = await settleMember(commander);
        guard(commander);
        if (
          proof.modulesInactive !== true ||
          proof.dronesSafe !== true ||
          !Number.isFinite(proof.observedAt) ||
          proof.observedAt > Date.now() ||
          Date.now() - proof.observedAt > 15000
        )
          throw Error("Command module settlement is uncertain.");
        commander.commandSettled = true;
        report(commander, "Command settled", "The command pilot's own modules are inactive.");
      });
    }
    if (relocating && !stopping && commander && moving(commander) && !commander.commandSettled)
      return;
    if (
      stopping &&
      op.snapshot().state === "READY" &&
      (startupStop || setup.haulMode !== "SELF_UNLOAD" || !target)
    )
      op.requestStop();
    if (
      (stopping || relocating) &&
      (op.snapshot().state === "ACTIVE" ||
        (setup.haulMode === "SELF_UNLOAD" && op.snapshot().state === "READY" && !starting))
    ) {
      for (const e of entries.values()) {
        if (
          !moving(e) ||
          !producers.some((m) => m.characterID === e.member.characterID) ||
          e.flushed ||
          e.emergency ||
          (e.member.role === "COMMAND" && !e.commandSettled) ||
          (stopping && startupBlocked(e))
        )
          continue;
        launch(e, async () => {
          const snapshot = op.snapshot(),
            explicitStop = stopping && !!snapshot.stopFreight;
          const oldJettison =
            snapshot.jetcanIntents[String(e.member.characterID)]?.dispatched === true;
          const delivers = minerDelivers(e, snapshot.stopFreight);
          guard(e);
          if (!e.miningSettled)
            report(
              e,
              collectStop() && !delivers ? "Final freight" : "Settling mining",
              "Finishing the current mining cycle and recovering drones.",
              "paused",
            );
          if (e.selfUnload && (!explicitStop || e.selfUnload.snapshot()?.pending)) {
            const final = await e.selfUnload.trip();
            guard(e);
            if (
              !op.recordSelfUnloadFinal(e.member.characterID, {
                source: "native-self-unload",
                runID: setup.operationRunID,
                shipID: e.member.shipID,
                rawRemaining: final.rawRemaining,
                observedAt: final.observedAt,
              })
            )
              throw Error("Final self-unload evidence is uncertain.");
          } else {
            if (!e.miningSettled) {
              await e.cycle?.stop();
              guard(e);
              if (!delivers && (e.cycle?.droneIDs || collectStop())) await settleMember(e);
              guard(e);
              e.miningSettled = true;
            }
            if (!explicitStop && e.dockedForDroneStop)
              await confirmCommandFinalHold(e.run, e.session, e.member.shipID, () => guard(e));
            const depletedRelocation = !!snapshot.relocation?.oldBeltID;
            let publish =
              e.member.role === "COMMAND" &&
              (collectStop() || depletedRelocation) &&
              collectionHaulers().length > 0 &&
              !e.selfUnload &&
              !e.dockedForDroneStop;
            if (publish) {
              const flight = decodeFlightStatus(
                (
                  await getFlightStatus({
                    ...e.session.flow.requestOptions(),
                    baseUrl: e.run.baseUrl,
                    fetch: e.run.fetch,
                  })
                ).flight,
              );
              guard(e);
              if (flight.shipID !== e.member.shipID || flight.inSpace === flight.docked)
                throw Error("Mining ship location is unreadable.");
              publish = flight.inSpace && flight.solarSystemID === setup.systemID;
            }
            if (
              oldJettison ||
              publish ||
              (e.member.role === "COMMAND" &&
                !explicitStop &&
                !depletedRelocation &&
                !e.selfUnload &&
                !e.dockedForDroneStop)
            ) {
              const admission =
                explicitStop || depletedRelocation
                  ? async (items: readonly import("./operation.ts").ManifestItem[]) => {
                      let unavailable: FleetObservationUnavailable | undefined;
                      for (const hauler of collectionHaulers()) {
                        try {
                          if (
                            (await (hauler.native as RawHaulerNative).canCarryFreight?.(items)) &&
                            (collectStop() ||
                              (!stopping && !!op.snapshot().relocation?.oldBeltID)) &&
                            collectionHaulers().includes(hauler)
                          )
                            return true;
                        } catch (error) {
                          if (!(error instanceof FleetObservationUnavailable)) throw error;
                          unavailable ??= error;
                        }
                      }
                      if (unavailable) throw unavailable;
                      return false;
                    }
                  : collectionHaulers().length > 0;
              let result;
              try {
                result = await loops.flush(
                  e.member.characterID,
                  e.native as RawMinerNative,
                  admission,
                );
              } catch (error) {
                guard(e);
                if (
                  error instanceof FleetObservationUnavailable ||
                  (!explicitStop && !depletedRelocation) ||
                  op.snapshot().jetcanIntents[String(e.member.characterID)]?.dispatched
                )
                  throw error;
                e.flushed = true;
                report(
                  e,
                  "Keeping ore aboard",
                  "Final freight could not be prepared. Continuing to Parking. " + message(error),
                );
                return;
              }
              if (result === "waiting") {
                report(e, "Draining", "Waiting for the native jettison cooldown.");
                return;
              }
              if (result === "published" && !delivers) {
                report(e, "Draining", "A verified can was published; checking remaining hold.");
                return;
              }
              if (result !== "empty" && result !== "published")
                throw Error("Final raw hold did not settle.");
            }
          }
          e.flushed = true;
          report(e, "Mining settled", "Ready for configured Parking.");
        });
      }
      const finishing =
        relocating && !stopping
          ? op
              .movingMembers()
              .some(
                (m) =>
                  producers.some((p) => p.characterID === m.characterID) &&
                  !entries.get(m.characterID)?.flushed,
              )
          : producerFinishing();
      const collecting = collectStop();
      // No Miner is still running a Jettison once its final mining turn has retired.
      if (
        !finishing &&
        ![...entries.values()].some(
          (e) =>
            e.busy &&
            (!collecting || !e.flushed) &&
            producers.some((m) => m.characterID === e.member.characterID),
        )
      ) {
        const snapshot = op.snapshot(),
          claim = snapshot.claim;
        const drainingBelt = relocating && !stopping && target?.kind === "BELT";
        const scanner =
          claim && collecting
            ? collectionHaulers().find(
                (e) =>
                  freightScanner(e) && op.canDiscoverGridFreight(e.member.characterID, claim, true),
              )
            : undefined;
        if (
          scanner &&
          claim &&
          (finalFreightScanned?.generation !== claim.generation ||
            finalFreightScanned.key !== claim.key)
        ) {
          launch(scanner, async () => {
            report(
              scanner,
              "Final freight",
              "Scanning the assigned grid for remaining containers.",
            );
            await loops.scanFinalFreight(
              scanner.member.characterID,
              scanner.native as RawHaulerNative,
            );
            finalFreightScanned = claim;
          });
        } else if (relocating && !stopping) {
          // The mining group can leave once its own actions settle. Haulers scan
          // and collect under the old belt claim while the next belt opens.
          if (!op.drainRelocation(drainingBelt && collectionHaulers().some(freightScanner)))
            throw Error("Relocation target drain is unresolved.");
        } else op.requestStop();
      }
    }
    const snapshot = op.snapshot(),
      state = snapshot.state;
    const oldSite = op.freightTailToScan();
    const lateCollectScan =
      collectStop() &&
      ["DRAINING", "SETTLING"].includes(state) &&
      !producerFinishing() &&
      target &&
      snapshot.claim &&
      finalFreightScanned?.generation !== snapshot.claim.generation
        ? { target, claim: snapshot.claim }
        : null;
    const scanSite = oldSite ?? lateCollectScan;
    const scanner = scanSite
      ? collectionHaulers().find(
          (e) =>
            freightScanner(e) &&
            op.canDiscoverGridFreight(e.member.characterID, scanSite.claim, true) &&
            !hasHaulWork(snapshot, e.member.characterID, true) &&
            !(e.native as RawHaulerNative).hasUnfinishedOwnFreight?.(),
        )
      : undefined;
    for (const e of entries.values()) {
      if (e.emergency) continue;
      if (stopping && startupBlocked(e)) continue;
      if (relocating && !stopping && e.member.role !== "HAULER" && !moving(e)) continue;
      if (!stopping && !relocating && e.startupManaged && (!e.anchorReady || !admitted(e))) {
        const reason = e.anchorReady ? "native-fleet-membership" : "mining-system-arrival";
        e.timing?.change("pilot-start-wait", reason, { reason });
        continue;
      }
      if (scanSite && e === scanner) {
        launch(e, async () => {
          report(e, "Final freight", "Scanning the assigned grid for remaining containers.");
          await loops.scanFinalFreight(e.member.characterID, e.native as RawHaulerNative, scanSite);
          if (oldSite) op.finishFreightTailScan(e.member.characterID, scanSite.claim);
          else finalFreightScanned = scanSite.claim;
        });
        continue;
      }
      if (e.member.role === "COMMAND" && (e.collectCanID || e.tractorWork || e.lease))
        e.commandMineTurn = false;
      if (
        state === "ACTIVE" &&
        !stopping &&
        !relocating &&
        (e.member.role === "MINER" ||
          (e.member.role === "COMMAND" && setup.supportPolicy?.selfMining && e.commandMineTurn))
      )
        launch(e, async () => {
          if (e.startupManaged) {
            await initializeSelectedTarget(e);
            if (stopping || relocating || !admitted(e)) return;
            e.leftStartupDock = true;
          }
          if (e.member.role === "COMMAND") e.commandMineTurn = false;
          if (setup.supportPolicy && e.member.role === "MINER") {
            const sample =
                setup.supportPolicy.coreRequirement === "requireCore" && !setup.command?.core
                  ? {
                      state: "BLOCKED" as const,
                      core: "inactive" as const,
                      reason: missingSupportReason,
                      fresh: true,
                    }
                  : supportSample && {
                      ...supportSample.observation,
                      fresh: Date.now() - supportSample.observedAt <= 15000,
                    },
              decision = decideSupportPolicy(
                setup.supportPolicy,
                sample,
                supportLostSince,
                Date.now(),
              );
            supportLostSince = decision.lostSinceMs;
            if (decision.requestParkingStop && !stopping) requestStop();
            if (!decision.permitNewMining) {
              report(
                e,
                "Waiting for support",
                decision.reason ?? "Support evidence is unavailable.",
                "paused",
              );
              return;
            }
          }
          report(
            e,
            "Mining",
            target?.kind === "BELT"
              ? "Mining the assigned belt."
              : target?.kind === "ICE"
                ? "Mining the assigned ice anomaly."
                : resolvedSite?.siteFamily === "MOON"
                  ? "Mining the assigned moon ore anomaly."
                  : "Mining the assigned ore anomaly.",
          );
          if (!e.selfUnload) {
            try {
              const result = await loops.miner(e.member.characterID, e.native as RawMinerNative);
              if (result === "depleted") {
                const claim = op.snapshot().claim;
                if (claim) await beltDepleted(e, claim);
              }
              if (e.member.role === "COMMAND" && e.movementSuspended) {
                if (result === "yield" || result === "published") e.movementSuspended = false;
                else e.commandMineTurn = true;
              }
            } catch (error) {
              if (error instanceof CommandMovementPending) {
                e.commandMineTurn = true;
                report(e, "Waiting for Core shutdown", message(error), "paused");
                return;
              }
              throw error;
            }
            return;
          }
          const a = op.assignment(e.member.characterID);
          if (!a?.targetGranted || !a.target || !a.claim) return;
          const miner = e.native as RawMinerNative;
          if (e.selfUnload.snapshot()?.pending) {
            report(e, "Self-unloading", "Continuing the original delivery trip.");
            await e.selfUnload.trip();
            return;
          }
          let arrival: Parameters<RawMinerNative["mineCycle"]>[3];
          await miner.navigate(a.target, a.claim, (observed) => {
            arrival = observed;
          });
          guard(e);
          const fresh = op.assignment(e.member.characterID);
          if (
            !fresh?.targetGranted ||
            fresh.claim?.generation !== a.claim.generation ||
            fresh.claim.key !== a.claim.key
          )
            return;
          const result = await miner.mineCycle(a.target, a.claim, undefined, arrival);
          if (result === "depleted") {
            await beltDepleted(e, a.claim);
            return;
          }
          if (result === "hold-full") {
            report(e, "Self-unloading", "Delivering the verified raw hold.");
            const r = await e.selfUnload.trip();
            if (!r.deposited) throw Error("The hold is full without verified raw ore.");
          }
        });
      if (
        state === "ACTIVE" &&
        e.member.role === "DEFENDER" &&
        (!stopping || coveringDeparture(e)) &&
        !relocating &&
        !e.defenderSettled
      )
        launch(e, async () => {
          const assignment = op.assignment(e.member.characterID);
          if (!assignment?.targetGranted || !assignment.claim || !assignment.target) return;
          const { claim, target } = assignment;
          if (!e.defender) {
            e.defender = (deps.createDefender ?? createMiningDefender)({
              run: e.run,
              session: e.session,
              shipID: e.member.shipID,
              target,
              claim,
              beltID: effectiveSetup.beltID,
              site: resolvedSite,
              document,
              authority: () => board.read(targetKey(target)),
              current: () => guard(e),
              stopRequested: () =>
                relocating || (stopping && !coveringDeparture(e)) || !!e.emergency,
              protectedShips: setup.members.filter((m) => m.role === "MINER").map((m) => m.shipID),
              preparation: e.defenderPreparation,
              threatJams: () =>
                [...entries.values()]
                  .filter((peer) => peer.active && !peer.emergency && peer.member.role === "MINER")
                  .flatMap((peer) => peer.session.store.space?.get().jams ?? []),
              fleetFocus: () =>
                [...entries.values()].flatMap((peer) => {
                  const id =
                    peer !== e &&
                    peer.active &&
                    !peer.failed &&
                    !peer.emergency &&
                    peer.escortGeneration === claim.generation
                      ? peer.defender?.focus()
                      : null;
                  return id ? [id] : [];
                }),
              timing: e.timing,
              observeFlight: (f, at) => rememberShip(e, f, at),
              repairMembers: setup.members,
              escortEligible: (member) => !entries.get(member.characterID)?.failed,
              repairEligible(member) {
                const peer = entries.get(member.characterID);
                return (
                  !!peer?.active &&
                  !peer.emergency &&
                  !peer.reconnecting &&
                  peer.member.shipID === member.shipID
                );
              },
            });
          }
          if (e.escortGeneration !== claim.generation) {
            e.leftStartupDock = true;
            await e.defender.navigate();
            guard(e);
            e.escortGeneration = claim.generation;
            e.timing?.note("escort-arrived", { claimGeneration: claim.generation });
          }
          let result;
          try {
            result = await e.defender.tick();
            guard(e);
          } catch (error) {
            if (!stopping || error instanceof DefenderStopBeforeAction) throw error;
            guard(e);
            // An unavailable escort read still owes the normal Defender shutdown.
            e.escortGeneration = undefined;
            report(e, "Settling defender", message(error), "paused");
            return;
          }
          const repair = e.defender.repairStatus();
          if (result === "responding")
            report(
              e,
              "Responding to threat",
              ["Native weapon or drone engagement confirmed.", repair].filter(Boolean).join(" "),
            );
          else if (result === "approaching")
            report(e, "Approaching hostile", "Closing into native lock and combat range.");
          else if (result === "checking-grid")
            report(
              e,
              "Checking escort grid",
              "Confirming whether the last hostile has left the grid.",
            );
          else if (result === "regrouping")
            report(e, "Returning to fleet", "Approaching the selected Miner.");
          else if (result === "regroup-wait")
            report(
              e,
              "Waiting to regroup",
              "Waiting for a usable approach to an active Miner on this grid.",
              "paused",
            );
          else if (result === "combat-wait")
            report(e, "Waiting to engage", "Checking native weapon, drone and target progress.");
          else if (result === "waiting-lock")
            report(e, "Acquiring hostile target", "Waiting for native target lock.");
          else if (result === "deploying")
            report(e, "Combat drones deployed", "Waiting for the next verified combat order.");
          else if (result === "repairing")
            report(e, "Repairing fleet member", repair ?? "Native remote repair cycle observed.");
          else if (result === "repair-wait")
            report(
              e,
              "Preparing fleet repair",
              repair ?? "Checking repair range and native locks.",
            );
          else if (result === "logistics-watch")
            report(
              e,
              "Logistics on watch",
              "Monitoring assigned fleet members for damage to the fitted repair layers.",
            );
          else report(e, "Defender on watch", "No qualified native hostile is visible.");
        });
      if (
        state === "ACTIVE" &&
        !stopping &&
        !relocating &&
        e.member.role === "COMMAND" &&
        !e.busy
      ) {
        if (!e.commandMineTurn && !e.movementSuspended) {
          if (setup.supportPolicy?.selfMining) e.commandMineTurn = true;
          launch(e, async () => {
            try {
              if (e.startupManaged) {
                await initializeSelectedTarget(e);
                if (stopping || relocating || !admitted(e)) return;
                e.leftStartupDock = true;
              }
              const assignment = op.assignment(e.member.characterID);
              if (!assignment?.targetGranted || !assignment.target || !assignment.claim) return;
              if (e.collectCanID && e.commandHauler) {
                const wanted = e.collectCanID,
                  owner = op.snapshot().haulClaims[String(wanted)];
                if (owner && owner.characterID !== e.member.characterID) {
                  e.collectCanID = undefined;
                  return;
                }
                try {
                  const result = await loops.hauler(
                    e.member.characterID,
                    e.commandHauler,
                    async (_id, rows) =>
                      rows.some((m) => m.containerID === wanted) ? wanted : null,
                  );
                  if (
                    result === "delivered" ||
                    !op.snapshot().manifests.some((m) => m.containerID === wanted && !m.delivered)
                  )
                    e.collectCanID = undefined;
                } finally {
                  const lease = e.lease;
                  if (lease && !op.snapshot().haulClaims[String(lease.itemID)]?.dispatched) {
                    await post(e, "/api/bots/loot-memory/release", { runID: e.run.botID });
                    clearInterval(lease.timer);
                    e.lease = null;
                  }
                }
                return;
              }
              if (setup.command?.tractor && (e.tractorWork || e.tractorTurn)) {
                e.tractorTurn = false;
                await tractorService(e);
                return;
              }
              if (setup.command?.tractor) e.tractorTurn = true;
              const command = ensureCommand(e);
              if (!e.navigation || (setup.command?.moduleID && !command))
                throw Error("Waiting for both held mining pilots.");
              const sameArrival =
                e.commandArrival?.key === assignment.claim.key &&
                e.commandArrival.generation === assignment.claim.generation;
              if (!setup.command?.core || !sameArrival) {
                if (!(await compressorInactive(e))) {
                  report(
                    e,
                    "Waiting for compressor shutdown",
                    "Checking native compressor settlement before travel.",
                    "paused",
                  );
                  return;
                }
                if (!(await coreInactive(e))) {
                  report(
                    e,
                    "Waiting for Core shutdown",
                    "Checking native Core settlement before travel.",
                    "paused",
                  );
                  return;
                }
                await e.navigation.navigate(assignment.target, assignment.claim);
                guard(e);
                e.commandArrival = {
                  key: assignment.claim.key,
                  generation: assignment.claim.generation,
                };
              }
              if (!(await coreProductive(e))) return;
              if (!(await compressorProductive(e))) return;
              guard(e);
              if (setup.supportPolicy && !setup.supportPolicy.maintainBursts) {
                if (supportSample?.observation.state !== "DEGRADED")
                  supportSample = {
                    observation: {
                      state: "READY",
                      core: setup.command?.core ? "active" : "inactive",
                      reason: null,
                      fresh: true,
                    },
                    observedAt: Date.now(),
                  };
                report(e, "Command support ready", "Selected support effects are confirmed.");
                return;
              }
              if (setup.command?.bursts) {
                const group = ensureBurstGroup(e);
                if (!group) throw Error("Waiting for held mining pilots.");
                const result = await group.tick();
                guard(e);
                const reads = result.modules.flatMap((m) => (m.observation ? [m.observation] : []));
                const active = reads.filter((r) => r?.active).length,
                  depleted =
                    result.modules.length > 0 &&
                    result.modules.every(
                      (m) =>
                        e.burstEmpty?.has(m.moduleID) ||
                        reads.some((r) => r?.moduleID === m.moduleID),
                    ) &&
                    (!!e.burstEmpty?.size || reads.some((r) => r?.chargeQuantity === 0)),
                  allActive =
                    result.complete &&
                    result.modules.length > 0 &&
                    active === result.modules.length,
                  degraded = supportSample?.observation.state === "DEGRADED",
                  reasons = result.modules
                    .filter((m) => m.state === "waiting")
                    .map((m) => m.reason)
                    .filter(Boolean);
                supportSample = {
                  observation: {
                    state: allActive
                      ? degraded
                        ? "DEGRADED"
                        : "READY"
                      : active || depleted
                        ? "DEGRADED"
                        : "RECOVERY",
                    core:
                      supportSample?.observation.core ??
                      (setup.command?.core ? "active" : "inactive"),
                    reason:
                      reasons.join("; ") ||
                      (allActive
                        ? degraded
                          ? (supportSample?.observation.reason ?? null)
                          : null
                        : "Some selected Burst effects are not active."),
                    fresh: true,
                  },
                  observedAt: Math.min(Date.now(), ...reads.map((r) => r.observedAt)),
                };
                report(
                  e,
                  allActive ? "Command observed" : "Command support degraded",
                  reasons.join("; ") ||
                    (depleted
                      ? "A Burst has no charge; independent capabilities continue."
                      : "Checking the native effects of all selected Burst modules."),
                  active || depleted ? "running" : "paused",
                );
                return;
              }
              if (!command) {
                const degraded = supportSample?.observation.state === "DEGRADED";
                report(
                  e,
                  degraded ? "Command support degraded" : "Command support ready",
                  degraded
                    ? (supportSample?.observation.reason ??
                        "Core is unavailable; independent capabilities continue.")
                    : setup.command?.compressor
                      ? "Industrial Core and compressor effects are confirmed."
                      : setup.command?.core
                        ? "Industrial Core effect and fuel are confirmed."
                        : "Selected tractor is standing by.",
                  "running",
                );
                return;
              }
              if (
                setup.command?.moduleID &&
                setup.command.typeID &&
                !command.snapshot().pending &&
                !e.commandProof?.snapshot().pending
              ) {
                const charge = await (deps.observeBurstCharge ?? observeBurstCharge)({
                  run: e.run,
                  session: e.session,
                  shipID: e.member.shipID,
                  moduleID: setup.command.moduleID,
                  typeID: setup.command.typeID,
                  current: () => guard(e),
                });
                guard(e);
                if (charge.state === "EMPTY") {
                  supportSample = {
                    observation: {
                      state: "DEGRADED",
                      core:
                        supportSample?.observation.core ??
                        (setup.command.core ? "active" : "inactive"),
                      reason: "Burst charge is empty; independent capabilities continue.",
                      fresh: true,
                    },
                    observedAt: Date.now(),
                  };
                  report(
                    e,
                    "Command support degraded",
                    "Burst charge is empty; independent capabilities continue.",
                  );
                  return;
                }
              }
              const coreNote = setup.command?.core
                ? " Industrial Core effect and fuel verified."
                : "";
              const fresh = op.assignment(e.member.characterID);
              if (
                !fresh?.targetGranted ||
                fresh.claim?.generation !== assignment.claim.generation ||
                fresh.claim.key !== assignment.claim.key
              )
                throw Error("Command target authority changed.");
              let observation = await command.observe();
              if (stopping) return;
              if (
                !observation.active &&
                observation.chargeQuantity === 0 &&
                !e.commandProof?.snapshot().pending
              ) {
                supportSample = {
                  observation: {
                    state: "DEGRADED",
                    core:
                      supportSample?.observation.core ??
                      (setup.command?.core ? "active" : "inactive"),
                    reason: "Burst charge is depleted; independent capabilities continue.",
                    fresh: true,
                  },
                  observedAt: Date.now(),
                };
                report(
                  e,
                  "Command support degraded",
                  "Burst charge is depleted; independent capabilities continue.",
                );
                return;
              }
              if (observation.active && supportSample?.observation.state !== "DEGRADED")
                supportSample = {
                  observation: {
                    state: "READY",
                    core: setup.command?.core ? "active" : "inactive",
                    reason: null,
                    fresh: true,
                  },
                  observedAt: Date.now(),
                };
              const proof = commandProofFor(e),
                pending = proof.snapshot().pending;
              if (pending) {
                if (command.snapshot().pending?.kind === "activate") await command.reconcile();
                observation = await command.observe();
                const captured = await commandProofSample(e, observation, assignment.claim),
                  controller = command.snapshot();
                if (JSON.stringify(captured.scope) !== JSON.stringify(pending.scope))
                  throw Error("Command proof scope changed.");
                const activation = [...controller.history]
                  .reverse()
                  .find(
                    (h) =>
                      h.intent.kind === "activate" &&
                      h.after.active &&
                      h.intent.issuedAt >= pending.preparedAt &&
                      !pending.priorActivationIDs.includes(h.intent.issuedAt),
                  ) as CommandActivationReceipt | undefined;
                proof.update(captured.scope, captured.sample, activation ?? null);
                const updated = proof.snapshot().pending!;
                if (
                  !controller.pending &&
                  (updated.status === "BENEFIT_OBSERVED" ||
                    (!activation && !observation.active) ||
                    (activation &&
                      !observation.active &&
                      updated.inactiveObservedAt !== null &&
                      Date.now() - updated.inactiveObservedAt >= 15000))
                )
                  proof.close(captured.scope, controller);
                report(
                  e,
                  updated.status === "BENEFIT_OBSERVED"
                    ? "Command observed"
                    : "Command effect observed",
                  (updated.status === "BENEFIT_OBSERVED"
                    ? "Native recipient benefit observed for all selected miners."
                    : "Recipient benefit has not been confirmed.") + coreNote,
                  updated.status === "BENEFIT_OBSERVED" ? "running" : "paused",
                );
                return;
              }
              if (observation.active) {
                const last = proof.snapshot().history.at(-1);
                report(
                  e,
                  last?.status === "BENEFIT_OBSERVED"
                    ? "Command observed"
                    : "Command effect observed",
                  (last?.status === "BENEFIT_OBSERVED"
                    ? "Native recipient benefit observed for all selected miners."
                    : "Recipient benefit has not been confirmed.") + coreNote,
                  last?.status === "BENEFIT_OBSERVED" ? "running" : "paused",
                );
                return;
              }
              const controllerBefore = command.snapshot();
              if (controllerBefore.pending)
                throw Error("A native command mutation remains unresolved; no replay.");
              const captured = await commandProofSample(e, observation, assignment.claim);
              if (stopping || e.emergency) return;
              const previous = [
                ...new Set(
                  controllerBefore.history
                    .filter((h) => h.intent.kind === "activate")
                    .slice(-128)
                    .map((h) => h.intent.issuedAt),
                ),
              ];
              proof.prepare(captured.scope, captured.sample, previous);
              e.commandBaseline = observation;
              await command.activate();
              const after = await command.observe(),
                postSample = await commandProofSample(e, after, assignment.claim),
                controller = command.snapshot(),
                row = proof.snapshot().pending!,
                activation = [...controller.history]
                  .reverse()
                  .find(
                    (h) =>
                      h.intent.kind === "activate" &&
                      h.after.active &&
                      h.intent.issuedAt >= row.preparedAt &&
                      !row.priorActivationIDs.includes(h.intent.issuedAt),
                  ) as CommandActivationReceipt | undefined;
              proof.update(postSample.scope, postSample.sample, activation ?? null);
              const updated = proof.snapshot().pending!;
              if (updated.status === "BENEFIT_OBSERVED" && !controller.pending)
                proof.close(postSample.scope, controller);
              report(
                e,
                updated.status === "BENEFIT_OBSERVED"
                  ? "Command observed"
                  : "Command effect observed",
                (updated.status === "BENEFIT_OBSERVED"
                  ? "Native recipient benefit observed for all selected miners."
                  : "Recipient benefit has not been confirmed.") + coreNote,
                updated.status === "BENEFIT_OBSERVED" ? "running" : "paused",
              );
            } catch (error) {
              if (e.emergency || stopping) return;
              if (setup.supportPolicy)
                supportSample = {
                  observation: {
                    state: "RECOVERY",
                    core: "unknown",
                    reason: message(error),
                    fresh: true,
                  },
                  observedAt: Date.now(),
                };
              report(e, "Command not ready", message(error), "paused");
            }
          });
        }
      }
      const hauler = e.member.role === "HAULER" ? (e.native as RawHaulerNative) : null;
      const returnHome = snapshot.stopFreight === "RETURN_HOME";
      const dispatchedHaul =
        hasHaulWork(snapshot, e.member.characterID, true) ||
        (returnHome ? hauler?.hasPendingOwnFreight?.() : hauler?.hasUnfinishedOwnFreight?.()) ===
          true;
      if (
        state === "DRAINING" &&
        e.member.role === "COMMAND" &&
        e.collectCanID &&
        e.commandHauler &&
        (!stopping || dispatchedHaul)
      )
        launch(e, async () => {
          const wanted = e.collectCanID!,
            claim = op.snapshot().haulClaims[String(wanted)];
          if (!claim || claim.characterID !== e.member.characterID) {
            e.collectCanID = undefined;
            return;
          }
          const result = await loops.hauler(
            e.member.characterID,
            e.commandHauler!,
            async (_id, rows) => (rows.some((m) => m.containerID === wanted) ? wanted : null),
          );
          if (result === "delivered") e.collectCanID = undefined;
        });
      const pendingFreight = snapshot.manifests.some((m) => !m.delivered);
      const freightForThisHauler =
        e.member.role === "HAULER" && pendingForHauler(e.member.characterID, snapshot);
      const haulingWhileRelocating =
        state === "READY" &&
        freightForThisHauler &&
        op.assignment(e.member.characterID)?.deliverOnly;
      const haulWork =
        dispatchedHaul ||
        (!returnHome &&
          (state === "ACTIVE" ||
            state === "DRAINING" ||
            snapshot.relocation?.oldBeltID !== undefined ||
            haulingWhileRelocating) &&
          (!stopping || (collectStop() && freightForThisHauler)));
      if (
        haulWork &&
        e.member.role === "HAULER" &&
        !snapshot.settled.includes(e.member.characterID)
      )
        launch(e, async () => {
          if (pendingFreight && !returnHome) e.leftStartupDock = true;
          if (returnHome)
            report(
              e,
              "Settling prior transfers",
              "Checking for an unresolved transfer before parking.",
              "paused",
            );
          else if (pendingFreight)
            report(e, "Freight service", "Checking published freight at the saved pickup site.");
          try {
            const finalFreightReady =
              collectStop() &&
              finalFreightScanned?.key === snapshot.claim?.key &&
              finalFreightScanned?.generation === snapshot.claim?.generation;
            const result = await loops.hauler(
              e.member.characterID,
              e.native as RawHaulerNative,
              undefined,
              finalFreightReady,
            );
            const latest = op.snapshot();
            if (
              latest.stopFreight === "RETURN_HOME" ||
              (latest.stopRequested && (result === "idle" || result === "on-grid"))
            )
              return;
            if (result === "on-grid")
              report(
                e,
                "Waiting for freight",
                "At the active pickup site. Looking for available containers.",
              );
            if (result === "idle")
              report(e, "Waiting for freight", "No unassigned freight is ready for this hauler.");
            if (result === "waiting")
              report(
                e,
                "Waiting for freight",
                "Verified ore remains aboard. Waiting for more freight from this site.",
              );
            if (result === "missing")
              report(
                e,
                "Freight service",
                "The can is absent from the verified grid. Checking remaining freight.",
              );
            if (result === "delivered")
              report(e, "Freight delivered", "Source and destination inventory verified.");
          } catch (error) {
            if ((!stopping || collectStop()) && transientNativeRead(error))
              throw new FreightGridUnavailable(
                "Waiting to recheck the original freight movement.",
                { cause: error },
              );
            throw error;
          } finally {
            const lease = e.lease,
              latest = op.snapshot();
            if (lease && !latest.haulClaims[String(lease.itemID)]?.dispatched)
              await releaseHaulLease(e, lease.itemID);
          }
        });
      const producer = producers.some((m) => m.characterID === e.member.characterID);
      const waitingToCollect =
        e.member.role === "HAULER" &&
        collectStop() &&
        (producerFinishing() || freightForThisHauler);
      const waitingToRelocate =
        relocating &&
        !stopping &&
        !snapshot.relocation?.oldBeltID &&
        (e.member.role === "HAULER" ||
          (e.member.role === "COMMAND" &&
            setup.supportPolicy?.collection === "TRACTOR_AND_COLLECT")) &&
        pendingFreight;
      if (
        (state === "SETTLING" || (stopping && (state === "ACTIVE" || state === "DRAINING"))) &&
        !snapshot.settled.includes(e.member.characterID) &&
        (!snapshot.relocation?.oldBeltID || e.member.role !== "HAULER") &&
        (!producer || state !== "ACTIVE" || e.flushed) &&
        (e.member.role !== "DEFENDER" || e.defenderSettled) &&
        (e.member.role !== "COMMAND" || e.commandSettled) &&
        !dispatchedHaul &&
        !waitingToCollect &&
        !waitingToRelocate
      ) {
        launch(e, async () => {
          report(
            e,
            "Settling pilot",
            "Checking native modules, drones and freight before parking.",
            "paused",
          );
          if (producer && !e.flushed) {
            await e.cycle?.stop();
            guard(e);
          }
          if (
            !snapshot.stopFreight &&
            !startupStop &&
            e.member.role === "COMMAND" &&
            setup.supportPolicy?.selfMining &&
            !op.snapshot().commandMiningFinal
          ) {
            const final = await confirmCommandFinalHold(e.run, e.session, e.member.shipID, () =>
              guard(e),
            );
            guard(e);
            if (
              !op.recordCommandMiningFinal(e.member.characterID, {
                ...final,
                runID: setup.operationRunID,
              })
            )
              throw Error("Command final hold evidence is uncertain.");
          }
          const proof = await settleMember(e);
          guard(e);
          if (
            !op.settleMember(e.member.characterID, {
              source: "native-settlement",
              runID: setup.operationRunID,
              shipID: e.member.shipID,
              ...proof,
            })
          )
            throw Error("Native settlement could not be verified.");
        });
      }
      if (state !== "PARKING" && (!stopping || state === "STOPPED")) continue;
      const settled = op.snapshot(),
        parked = settled.parked.includes(e.member.characterID),
        stayed = settled.stayed?.includes(e.member.characterID) === true;
      if (stopping && (parked || (stayed && !deadlineStop)) && e.active)
        launch(e, async () => {
          await e.cycle?.release?.();
          guard(e);
          report(
            e,
            parked ? "Docked" : "Settled in place",
            "This pilot has settled. Releasing the session while the remaining fleet stops.",
          );
          e.unregister();
          e.active = false;
          e.session.flow.setLivePush(false);
          e.run.report({
            status: "stopped",
            phase: parked ? "Docked" : "Settled in place",
            why: [
              "This pilot is settled. Fleet Stop remains pending for other members.",
              e.droneWarning,
            ]
              .filter(Boolean)
              .join(" "),
          });
          persistTelemetry();
        });
      if (
        (state === "PARKING" || settled.settled.includes(e.member.characterID)) &&
        !relocating &&
        !parked &&
        (!stayed || deadlineStop)
      )
        launch(e, async () => {
          const current = () => guard(e),
            parkingSetup = parkingForStop(e, settled.stopFreight);
          if (parkingSetup) {
            const parked = await finishMemberParking(e, parkingSetup);
            if (parked.kind === "stay") {
              if (
                !op.stayMember(e.member.characterID, {
                  ...parked.proof,
                  runID: setup.operationRunID,
                })
              )
                throw Error("In-place physical settlement could not be verified.");
              report(e, "Settled in place", "Native flight and owned modules are settled.");
            } else if (
              !op.parkMember(e.member.characterID, { ...parked.proof, runID: setup.operationRunID })
            )
              throw Error("Native docking could not be verified.");
            return;
          }
          const destination =
            (await dockedAtStartup(e)) ??
            (await (deps.park ?? parkNearest)(
              e.run,
              e.session,
              (p, w) => report(e, p, w),
              current,
            ));
          current();
          if (
            !op.parkMember(e.member.characterID, {
              source: "native-flight",
              runID: setup.operationRunID,
              shipID: e.member.shipID,
              locationID: destination.destinationID,
              docked: true,
              observedAt: Date.now(),
            })
          )
            throw Error("Native docking could not be verified.");
        });
    }
    if (relocating && !stopping && op.snapshot().state === "PARKING") {
      const moving = op.movingMembers(),
        ids = new Set(moving.map((m) => m.characterID));
      for (const id of relocationProofs.keys()) if (!ids.has(id)) relocationProofs.delete(id);
      for (const e of entries.values())
        if (
          !e.emergency &&
          ids.has(e.member.characterID) &&
          !relocationProofs.has(e.member.characterID)
        )
          launch(e, async () => {
            const proof = await observeSettledInPlace(
              e.run,
              e.session,
              e.member.shipID,
              () => guard(e),
              document(
                `mining-fleet-relocation-settle:${JSON.stringify([setup.operationID, setup.operationRunID, e.run.botID, e.member.characterID, e.member.shipID])}`,
              ),
              { operationID: setup.operationID, runID: setup.operationRunID },
            );
            guard(e);
            relocationProofs.set(e.member.characterID, {
              ...proof,
              characterID: e.member.characterID,
            });
          });
      if (
        relocationProofs.size === moving.length &&
        ![...entries.values()].some((e) => ids.has(e.member.characterID) && e.busy)
      ) {
        const values = [...relocationProofs.values()];
        if (values.some((p) => Date.now() - p.observedAt > 15000)) {
          relocationProofs.clear();
          return;
        }
        const saved = relocationDoc.read() as { next?: FleetSetup; decision?: unknown } | null,
          r = op.snapshot().relocation;
        if (!saved?.next || !r) throw Error("Relocation destination evidence is unavailable.");
        for (const e of entries.values())
          if (e.active && !e.emergency && e.cycle) {
            await e.cycle.release?.();
            e.cycle = null;
          }
        if (closed || stopping) return;
        if (!op.relocateAfterSettlement(values)) {
          for (const e of entries.values())
            report(
              e,
              "Relocation waiting",
              "The next target is not available; old custody stays fenced.",
              "paused",
            );
          return;
        }
        effectiveSetup = saved.next;
        selectionEvidence = saved.decision ?? { source: "retained-relocation-selection" };
        resolvedSite = effectiveSetup.site;
        target = resolvedSite?.target ?? {
          kind: "BELT",
          systemID: setup.systemID,
          name: effectiveSetup.beltName!,
        };
        for (const e of entries.values()) {
          if (!e.active || e.emergency) continue;
          e.flushed = false;
          e.miningSettled = false;
          e.defenderSettled = false;
          e.defender = undefined;
          e.commandSettled = false;
          e.command = null;
          e.commandGroup = undefined;
          e.commandProof = undefined;
          e.commandBaseline = null;
          e.commandArrival = undefined;
          e.navigation = undefined;
          e.movementSuspended = false;
          e.commandMineTurn = false;
          if (!e.startupManaged) await initializeSearchMember(e);
        }
        relocationProofs.clear();
        nextBeltReadAt = 0;
        nextBeltReason = "Three valid native grids show no remaining asteroids.";
        relocating = false;
        if (stopping) {
          op.requestStop();
          return;
        }
        const leader = setup.members.find((m) => m.role === "MINER")!;
        if (!op.activate(leader.characterID))
          throw Error("Relocation target activation requires reconciliation.");
        telemetry.target(target, op.snapshot().claim, {
          ...((selectionEvidence as object) ?? {}),
          source: "native-relocation",
          previous: r.oldClaim,
        });
        persistTelemetry();
        for (const e of entries.values())
          if (e.active && !e.failed)
            report(e, "Relocated", "The new native target claim is active.");
      }
    }
    if (closed) return;
    if (stopping) op.completeStop();
    if (op.snapshot().state === "STOPPED") {
      if ([...entries.values()].some((e) => e.active && e.busy)) return;
      persistSupportSnapshot();
      persistTelemetry(true);
      for (const e of entries.values()) if (e.active && e.cycle?.release) await e.cycle.release();
      if (closed) return; // Shutdown can close the group while a release is pending.
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const e of entries.values())
        if (e.active) {
          e.unregister();
          e.run.report({
            status: "stopped",
            phase: op.snapshot().stayed?.includes(e.member.characterID)
              ? "Settled in place"
              : "Docked",
            why: [searchReason ?? "All fleet members completed native Parking.", e.droneWarning]
              .filter(Boolean)
              .join(" "),
          });
          e.active = false;
          e.session.flow.setLivePush(false);
        }
      groups.delete(setup.operationID);
    }
  }
  if (retainedTelemetry?.shipLosses?.length) applyFleetWipe(retainedTelemetry);
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (closed || tickInFlight) return;
    tickInFlight = true;
    track(
      tick()
        .catch((error) => {
          for (const e of entries.values()) report(e, "Needs attention", message(error), "paused");
        })
        .finally(() => {
          tickInFlight = false;
        }),
    );
  }, 1500);
  timer.unref?.();
  const heartbeat = setInterval(() => {
    persistSupportSnapshot();
    persistTelemetry();
    try {
      if (
        op.snapshot().claim &&
        [...entries.values()].some((e) => e.active || e.reconnecting) &&
        !op.heartbeat()
      )
        throw Error("Target lease was lost.");
    } catch (error) {
      if (!stopping) requestStop();
      for (const e of entries.values()) report(e, "Claim uncertain", message(error), "paused");
    }
  }, 8000);
  heartbeat.unref?.();
  function closeGroup() {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const entry of entries.values()) if (entry.lease) clearInterval(entry.lease.timer);
    if (groups.get(setup.operationID)?.op === op) groups.delete(setup.operationID);
  }
  function retireGroup() {
    if (
      starting ||
      fleetCheck ||
      attaching.size ||
      [...entries.values()].some((e) => e.active || e.busy)
    )
      return false;
    closeGroup();
    return true;
  }
  return {
    signature,
    op,
    entries,
    hasTargetOwner: () =>
      attaching.size > 0 || [...entries.values()].some((e) => e.active || e.reconnecting),
    commandSupport,
    telemetrySnapshot,
    memberSnapshot() {
      return [...entries.values()].map((e) => ({
        characterID: e.member.characterID,
        shipID: e.member.shipID,
        role: e.member.role,
        botID: e.run.botID,
        active: e.active,
        freight:
          e.cycle?.getFreightStatus?.() ??
          e.commandHauler?.getFreightStatus?.() ??
          (e.native as RawHaulerNative)?.getFreightStatus?.() ??
          null,
      }));
    },
    supportSnapshot,
    prepareRelocation,
    requestRelocation,
    requestStop,
    recordNeverStarted(ids: readonly number[]) {
      op.recordNeverStarted(ids.filter((id) => !entries.has(id) && !attaching.has(id)));
    },
    async shutdown() {
      closeGroup();
      for (const e of entries.values()) {
        e.active = false;
        e.unregister();
        e.session.flow.setLivePush(false);
      }
      await Promise.allSettled([...pendingReads, ...[...entries.values()].map((e) => e.work)]);
    },
    retireGroup,
    retireStoppedGroup: () => stopping && retireGroup(),
    async add(run: PluginRunContext, member: Member, resumedLaunch?: ResumedLaunch) {
      const prior = entries.get(member.characterID),
        state = op.snapshot();
      const previousBotID = resumedLaunch?.previousBotID,
        replacing = !!previousBotID && previousBotID !== run.botID;
      const replacesPrior =
        prior &&
        !prior.active &&
        run.resumed &&
        (replacing
          ? prior.run.botID === previousBotID
          : prior.reconnecting && prior.run.botID === run.botID);
      if (
        closed ||
        attaching.has(member.characterID) ||
        (prior && !replacesPrior) ||
        (!run.resumed && (!["READY", "ACTIVE"].includes(state.state) || stopping))
      )
        throw Error("Fleet member or operation generation is already active.");
      attaching.add(member.characterID);
      const timing =
        member.role === "HAULER" && !logTiming
          ? undefined
          : createPilotTiming(
              {
                operationID: setup.operationID,
                operationRunID: setup.operationRunID,
                characterID: member.characterID,
                shipID: member.shipID,
                role: member.role,
              },
              undefined,
              logTiming,
            );
      const pilotRun = timing ? { ...run, fetch: timing.wrapFetch(run.fetch) } : run;
      const [attached, metadata] = await Promise.allSettled([
        Promise.resolve().then(() => (deps.attach ?? createPilotSession)(pilotRun)),
        Promise.all([runOwner(run), runExpiry(run, !!resumedLaunch)]),
      ]);
      if (attached.status === "rejected") {
        attaching.delete(member.characterID);
        throw attached.reason;
      }
      const session = attached.value;
      let e: Entry | null = null;
      try {
        if (metadata.status === "rejected") throw metadata.reason;
        const [owner, expiry] = metadata.value;
        if (resumedLaunch && owner.toLowerCase() !== resumedLaunch.accountName.toLowerCase())
          throw Error("The resumed hosted account differs from the accepted fleet member.");
        const generation = session.flow.flying.sessionGeneration();
        const current = () => {
          if (!e || session.flow.flying.sessionGeneration() !== generation)
            throw Error("Pilot session generation changed.");
          guard(e);
          if (e.emergency) throw new FleetStopBeforeDispatch();
        };
        e = {
          run,
          session,
          member,
          timing,
          startupManaged: true,
          cycle: null,
          native: null as unknown as RawMinerNative,
          selfUnload: null,
          generation,
          active: true,
          busy: false,
          failed: null,
          flushed: false,
          unregister: () => {},
          expiry,
          lease: null,
        };
        if (setup.travelAssist === "AUTO")
          e.travel = createNativeTravelAssist(run, session, {
            operationID: setup.operationID,
            runID: setup.operationRunID,
            shipID: member.shipID,
            systemID: setup.systemID,
            timing: e.timing,
            document: document(
              `mining-fleet-travel-assist:${JSON.stringify([setup.operationID, setup.operationRunID, run.botID, member.characterID, member.shipID])}`,
            ),
            current: () => {
              if (
                !e ||
                !e.active ||
                session.flow.flying.sessionGeneration() !== generation ||
                session.flow.flying.isSessionClosing() ||
                session.store.station.get().online?.characterID !== run.characterID
              )
                throw Error("Travel assist held owner changed.");
            },
            enabled: () => !stopping && !relocating && !e?.emergency,
            beforeAction: () => {
              current();
              const a = op.assignment(member.characterID);
              if (stopping || relocating || !a?.claim || (!a.targetGranted && !a.deliverOnly))
                throw new FleetStopBeforeDispatch();
            },
          });
        e.startupPrepared =
          setup.startupPreparation === undefined ||
          prior?.startupPrepared === true ||
          (run.resumed && (state.state !== "READY" || !!state.claim));
        if (!run.resumed && setup.startupPreparation !== undefined) {
          const flight = await readStopFlight(e);
          guard(e);
          if (
            flight.shipID !== member.shipID ||
            flight.shipIsCapsule === true ||
            !valid(flight.solarSystemID) ||
            flight.docked === flight.inSpace
          )
            throw Error(
              "The active ship or location does not match the Start plan. Verify this pilot's current ship.",
            );
        }
        let resumedCapsule = false;
        if (run.resumed) {
          if (prior?.work) await prior.work;
          const observed = retainedTelemetry?.members.find(
            (m) =>
              m.characterID === member.characterID &&
              m.shipID === member.shipID &&
              m.botID === (previousBotID ?? run.botID),
          );
          e.lastShip = prior ? prior.lastShip : observed?.lastShip;
          e.deployedAt = prior?.deployedAt ?? observed?.deployedAt;
          e.lossChecked = prior?.lossChecked;
          const flight = await readStopFlight(e);
          resumedCapsule =
            (!stopping || op.snapshot().stopFreight !== undefined) &&
            stopCapsuleID(e, flight) !== null;
          e.hullRetreat = prior?.hullRetreat;
          e.repairDispatched = prior?.repairDispatched;
          e.emergency =
            prior?.emergency ||
            (!stopping && (resumedCapsule || op.snapshot().parked.includes(member.characterID)));
          if (replacing || (!resumedCapsule && !e.emergency)) {
            guard(e);
            if (
              flight.shipID !== member.shipID ||
              flight.shipIsCapsule === true ||
              flight.docked === flight.inSpace ||
              !valid(flight.solarSystemID)
            )
              throw Error(
                "The original ship or its current location could not be verified after reconnect.",
              );
          }
        }
        if (
          replacing &&
          setup.oreLogistics?.remoteCompression &&
          producers.some((m) => m.characterID === member.characterID)
        ) {
          const next = compressionDocument(e),
            retained = compressionDocument(e, previousBotID).read();
          if (retained !== null && next.read() === null) next.write(retained);
        }
        if (op.snapshot().settled.includes(member.characterID)) {
          e.flushed = true;
          e.commandSettled = true;
          e.defenderSettled = true;
        } else if (!resumedCapsule && !e.emergency && (!setup.siteSearch || resolvedSite))
          await initializeSearchMember(e);
        if (
          (member.role === "MINER" ||
            (member.role === "COMMAND" && setup.supportPolicy?.selfMining)) &&
          setup.haulMode === "SELF_UNLOAD"
        ) {
          const memberEntry = e;
          e.selfUnload = createNativeSelfUnload(run, session, {
            operationID: setup.operationID,
            runID: setup.operationRunID,
            shipID: member.shipID,
            allowCompressed: setup.oreLogistics?.remoteCompression === true,
            resourceFamily:
              setup.site?.target.kind === "ICE" || setup.siteSearch?.family === "ICE"
                ? "ice"
                : "ore",
            destinationID: setup.destinationID,
            corporationID: setup.corporationID,
            division: setup.division,
            ...(setup.delivery ? { delivery: setup.delivery } : {}),
            current,
            settle: async () => {
              if (!memberEntry.cycle) throw Error("Mining cycle is unavailable for settlement.");
              await memberEntry.cycle.stop();
              current();
              const proof = await settleMember(memberEntry, current);
              if (
                proof.modulesInactive !== true ||
                proof.dronesSafe !== true ||
                !Number.isFinite(proof.observedAt) ||
                proof.observedAt > Date.now() ||
                Date.now() - proof.observedAt > 15000
              )
                throw Error("Native settlement could not be verified.");
            },
            store: document(
              `mining-fleet-self-unload:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID])}`,
            ),
            tripDocument: (ordinal) =>
              document(
                `mining-fleet-self-unload-trip:${JSON.stringify([setup.operationID, setup.operationRunID, member.characterID, member.shipID, ordinal])}`,
              ),
          });
        }
        const commandCollects =
          member.role === "COMMAND" &&
          setup.command?.tractor &&
          setup.supportPolicy?.collection === "TRACTOR_AND_COLLECT";
        if (member.role === "HAULER" || commandCollects) {
          const ownerEntry = e;
          const native = createNativeHauler(run, session, {
            shipID: member.shipID,
            corporationID: setup.corporationID,
            division: setup.division,
            ...(setup.delivery ? { delivery: setup.delivery } : {}),
            travelAssist: e.travel,
            localDefense: member.role === "HAULER",
            timing: e.timing,
            current,
            observeFlight: (f, at) => rememberShip(ownerEntry, f, at),
            gridLootFleet: () =>
              ownerEntry.fleetRead?.state === "ready"
                ? {
                    fleetID: ownerEntry.fleetRead.fleetID,
                    memberIDs: ownerEntry.fleetRead.memberIDs,
                  }
                : {},
            async navigateToTarget(target, claim, checkActiveBelt) {
              checkActiveBelt?.();
              if (checkActiveBelt) ownerEntry.leftStartupDock = true;
              const old = op
                .snapshot()
                .relocationHistory?.find(
                  (h) => h.oldClaim.key === claim.key && h.oldClaim.generation === claim.generation,
                );
              const navigation = createNativeMiningNavigation(run, session, {
                shipID: member.shipID,
                beltID: old?.oldBeltID ?? effectiveSetup.beltID,
                site: old?.oldBeltID ? undefined : resolvedSite,
                allowDraining: true,
                authority: () => board.read(claim.key),
                document,
                current: () => {
                  current();
                  checkActiveBelt?.();
                  if (member.role === "HAULER" && op.snapshot().stopFreight === "RETURN_HOME")
                    throw new HaulStoppedBeforePickup();
                },
                travelAssist: ownerEntry.travel,
                timing: ownerEntry.timing,
              });
              await navigation.navigate(target, claim);
            },
            async claimPickup(manifest) {
              if (stopping && !collectStop()) throw new FleetStopBeforeDispatch();
              await claim(ownerEntry, manifest);
            },
            stopBeforePickup: () => stopping && !collectStop(),
            returnHome: () =>
              member.role === "HAULER" && op.snapshot().stopFreight === "RETURN_HOME",
            afterPickup: (manifest) => pickup(ownerEntry, manifest),
            pickupClaimCurrent(manifest) {
              const lease = ownerEntry.lease;
              return (
                !!lease &&
                !lease.lost &&
                lease.itemID === manifest.containerID &&
                lease.systemID === manifest.systemID &&
                Date.now() - lease.confirmedAt < 60_000
              );
            },
            releasePickup: (manifest) => releaseHaulLease(ownerEntry, manifest.containerID),
            ...(commandCollects && setup.supportPolicy?.compressCollectedOre
              ? {
                  convertFreight: (item, manifest, generation) =>
                    compressCollected(ownerEntry, item, manifest, generation),
                  recoverConversion: (item, manifest, generation) =>
                    compressCollected(ownerEntry, item, manifest, generation, true),
                }
              : {}),
            ...(member.role === "HAULER"
              ? {
                  ownFreight: {
                    operationID: setup.operationID,
                    runID: setup.operationRunID,
                    document: document(
                      HAULER_OWN_DEPOSIT_PREFIX +
                        JSON.stringify([
                          setup.operationID,
                          setup.operationRunID,
                          run.characterID,
                          member.shipID,
                        ]),
                    ),
                  },
                }
              : {}),
            tripDocument: (manifest, generation) =>
              document(
                fleetHaulDocumentKey(
                  setup.operationID,
                  setup.operationRunID,
                  manifest.containerID,
                  generation,
                  run.characterID,
                  member.shipID,
                ),
              ),
          });
          if (member.role === "HAULER") e.native = native;
          else e.commandHauler = native;
        }
        if (!run.resumed && (stopping || !["READY", "ACTIVE"].includes(op.snapshot().state)))
          throw Error("Fleet generation changed during attachment.");
        if (prior) {
          if (anchorPending.delete(prior)) anchorPending.add(e);
          if (departed.delete(prior)) departed.add(e);
          const dock = startupDocks.get(prior);
          startupDocks.delete(prior);
          if (dock !== undefined) startupDocks.set(e, dock);
          e.leftStartupDock = prior.leftStartupDock;
          const command = commandMember && entries.get(commandMember.characterID);
          if (member.role === "MINER" && command) {
            command.command = null;
            command.commandGroup = undefined;
          }
        }
        if (run.resumed && !stopping && op.snapshot().state === "ACTIVE") {
          restoringFleet = true;
          if (
            (member.role === "HAULER" && hasHaulWork(op.snapshot(), member.characterID, true)) ||
            e.selfUnload?.snapshot()?.pending
          )
            e.anchorReady = true;
        }
        if (member.role === "DEFENDER" && !deps.createDefender && !stopping && !e.emergency) {
          const entry = e;
          e.defenderPreparation = prepareHeldDefender(pilotRun, session, member.shipID, () =>
            guardHeld(entry),
          );
          if (e.startupPrepared) e.defenderPreparation.refresh();
        }
        if (closed) throw Error("The mining backend has stopped.");
        e.unregister = registerRun(run, owner, requestStop, undefined, () => pendingUnloadCheck(e!));
        try {
          resumedLaunch?.journal.rebind(
            setup.operationRunID,
            member.characterID,
            resumedLaunch.previousBotID,
            run.botID,
          );
        } catch (error) {
          e.unregister();
          throw error;
        }
        entries.set(member.characterID, e);
        attaching.delete(member.characterID);
        e.timing?.note("hosted-attached", { resumed: run.resumed });
        report(
          e,
          run.resumed ? "GamePort restored" : "Waiting for fleet",
          resumedCapsule
            ? "Current capsule verified. Continuing parking."
            : run.resumed
              ? "Ship and flight verified. Continuing the original operation."
              : "Checking this pilot's native route and fleet membership.",
          "paused",
        );
        const entry = e;
        return {
          stop(reason?: "reconnect") {
            if (reason === "reconnect") entry.reconnecting = true;
            if (
              reason !== "reconnect" &&
              entry.active &&
              op.snapshot().state !== "STOPPED" &&
              !op.snapshot().parked.includes(member.characterID) &&
              !op.snapshot().stayed?.includes(member.characterID)
            ) {
              const expired = stopping && Date.now() >= entry.expiry;
              const reason = expired
                ? "The hosted grant expired before the configured Stop was confirmed."
                : "The hosted pilot ended before physical settlement.";
              entry.telemetry = {
                phase: stopping ? "Stop needs attention" : "Owner ended",
                reason: [reason, entry.failed, parkingFreightNote(entry)].filter(Boolean).join(" "),
                reportedAt: Date.now(),
              };
            }
            entry.active = false;
            // The retired loop cannot dispatch again, including when the host replaces it on reconnect.
            try {
              if (!closed && entries.get(member.characterID) === entry) {
                for (const [id, haul] of Object.entries(op.snapshot().haulClaims))
                  if (haul.characterID === member.characterID)
                    op.cancelUndispatchedHaul(member.characterID, Number(id), haul.generation);
              }
            } finally {
              entry.unregister();
              if (entry.lease) clearInterval(entry.lease.timer);
              session.flow.setLivePush(false);
              if (!closed) persistTelemetry();
            }
          },
        };
      } catch (error) {
        if (e) e.active = false;
        attaching.delete(member.characterID);
        session.flow.setLivePush(false);
        throw error;
      }
    },
  };
}
/** Freight evidence stays with its generation after a belt lease expires. */
export function canReleaseExpiredTarget(claim: Claim, record: OperationRecord | null): boolean {
  if (
    record?.version !== 1 ||
    record.operationID !== claim.operationID ||
    record.runID !== claim.runID
  )
    return false;
  const exact = (c: Claim | null | undefined) =>
    c?.key === claim.key &&
    c.generation === claim.generation &&
    c.operationID === claim.operationID &&
    c.runID === claim.runID;
  if (claim.key.startsWith("BELT:"))
    return exact(record.claim) || record.relocationHistory?.some((h) => exact(h.oldClaim)) === true;
  if (
    !exact(record.claim) ||
    !["SETTLING", "PARKING", "STOPPED"].includes(record.state) ||
    record.relocation
  )
    return false;
  return (
    Array.isArray(record.members) &&
    record.members.length > 0 &&
    record.members.every(
      (m) =>
        record.neverStarted?.includes(m.characterID) ||
        (record.settled?.includes(m.characterID) &&
          (record.parked?.includes(m.characterID) || record.stayed?.includes(m.characterID))),
    ) &&
    Array.isArray(record.manifests) &&
    record.manifests.every((m) => m.delivered) &&
    !!record.jetcanIntents &&
    !Object.keys(record.jetcanIntents).length &&
    !!record.haulClaims &&
    !Object.keys(record.haulClaims).length
  );
}
/** Exactly one same-process authority per operation; durable documents survive process loss. */
export function createMiningFleetRuntime(deps: FleetRuntimeDependencies) {
  if (!deps?.createCycle || !deps?.settle)
    throw Error("Native mining cycle and settlement adapters are required.");
  if (boardAuthority && boardAuthority.provider !== deps.storage)
    throw Error("Mining fleet storage provider changed in this process.");
  const storage = deps.storage ?? uocStore("mining-fleet.sqlite");
  const document = storage.document;
  const operationStore = (operationID: string, runID: string) =>
    fleetOperationStore(storage, operationID, runID);
  if (!boardAuthority) {
    const board = createTargetBoard(
      document("mining-fleet-targets"),
      () => Date.now(),
      30_000,
      (claim) => {
        const group = groups.get(claim.operationID);
        if (
          operationHasController(claim.operationID, claim.runID) ||
          (group?.op.snapshot().runID === claim.runID && group.hasTargetOwner())
        )
          return false;
        const record = operationStore(claim.operationID, claim.runID).read();
        return canReleaseExpiredTarget(claim, record);
      },
    );
    boardAuthority = { provider: deps.storage, board };
  }
  const board = boardAuthority.board;
  let disposed = false;
  const cycleDocument = deps.cycleDocument ?? miningCycleDocument;
  const finish = createFleetFinishRun({
    document,
    operationStore,
    board,
    decodeSetup: setupOf,
    attach: deps.attach,
    settle: deps.settle,
    cycleDocument,
    dockedUnloadsOnly: deps.dockedUnloadsOnly,
    assertNoLiveGroup(operationID) {
      const group = groups.get(operationID);
      if (group && !group.retireStoppedGroup())
        throw Error("A current mining fleet still owns this operation.");
    },
  });
  const checkedOldRuns = new Set<string>();
  function completedFleetResult(operationID: string, runID?: string) {
    if (!checkedOldRuns.has(operationID)) {
      const indexed = document(`mining-fleet-index:${operationID}`).read() as {
        runID?: string;
      } | null;
      for (const oldRun of retiredFleetRuns(storage, operationID)) {
        try {
          if (
            indexed?.runID === oldRun ||
            operationHasController(operationID, oldRun) ||
            deps.launchJournal?.(operationID, oldRun)
          )
            continue;
          const previous = savedFleetExecution(storage, operationID, oldRun);
          if (!previous)
            storage.transaction(() =>
              retainFleetRunResult(storage, operationID, oldRun, null, null),
            );
          else if (finishedFleetExecution(previous))
            deleteFleetExecution(storage, operationID, oldRun);
        } catch (error) {
          console.warn(
            `[MCC] Retained delivery evidence for ${operationID}/${oldRun}: ${message(error)}`,
          );
        }
      }
      checkedOldRuns.add(operationID);
    }
    const retained = fleetRunResult(storage, operationID, runID);
    if (retained || runID === undefined) return retained;
    const active = savedFleetExecution(storage, operationID, runID);
    return active ? summarizeFleetRun(storage, operationID, runID, active, null) : null;
  }
  function discardGeneration(operationID: string, runID: string, preserveExecution = false) {
    if (
      operationHasController(operationID, runID) ||
      !finish.discardReleased({ operationID, operationRunID: runID })
    )
      return false;
    const group = groups.get(operationID);
    if (group?.op.snapshot().runID === runID && !group.retireGroup()) return false;
    const record = savedFleetExecution(storage, operationID, runID);
    // Keep independent danger marks, including the acknowledgement of a historical wipe.
    board.releaseGeneration(operationID, runID);
    if (
      preserveExecution ||
      (record && !unusedFleetExecution(record) && !finishedFleetExecution(record))
    ) {
      const index = document(`mining-fleet-index:${operationID}`);
      if ((index.read() as { runID?: string } | null)?.runID === runID) index.write(null);
    } else if (deps.discardExecution) deps.discardExecution(operationID, runID);
    else {
      deleteFleetExecution(storage, operationID, runID);
      if (!deps.storage) discardMiningCycles(operationID, runID);
    }
    return true;
  }
  function getOrCreate(setup: FleetSetup, resumed = false) {
    if (disposed || boardAuthority?.board !== board) throw Error("The mining backend has stopped.");
    const normalized = setupOf(setup);
    if (!normalized) throw Error("Invalid raw fleet setup.");
    if (finish.ownsOperation(normalized.operationID))
      throw Error("Retained freight settlement owns this operation.");
    const existing = groups.get(normalized.operationID);
    if (existing) {
      if (existing.signature !== JSON.stringify(normalized))
        throw Error("Another fleet generation already owns this operation.");
      return existing;
    }
    const index = document(`mining-fleet-index:${normalized.operationID}`),
      saved = index.read() as { runID?: unknown; signature?: unknown } | null;
    if (
      saved !== null &&
      (typeof saved !== "object" || typeof saved.runID !== "string" || !saved.runID)
    )
      throw Error("Fleet generation index needs reconciliation.");
    if (
      saved &&
      saved.runID === normalized.operationRunID &&
      saved.signature !== JSON.stringify(normalized)
    )
      throw Error("Fleet setup for this generation changed; reconciliation is required.");
    if (saved && typeof saved.runID === "string" && saved.runID !== normalized.operationRunID) {
      const previous = operationStore(normalized.operationID, saved.runID).read();
      if (!previous || previous.state !== "STOPPED")
        throw Error("An unfinished fleet generation owns this operation.");
    }
    if (!saved || saved.runID !== normalized.operationRunID)
      index.write({ runID: normalized.operationRunID, signature: JSON.stringify(normalized) });
    const store = operationStore(normalized.operationID, normalized.operationRunID);
    const raw = resumed ? store.read() : null;
    const restored =
      raw &&
      (raw.state === "ACTIVE" ||
        (raw.state === "READY" &&
          raw.claim &&
          !raw.relocationHistory?.length &&
          normalized.beltID !== undefined) ||
        (raw.stopRequested &&
          raw.stopFreight &&
          ["DRAINING", "SETTLING", "PARKING"].includes(raw.state)))
        ? readRetainedFleetTarget(normalized, raw, setup, false, {
            document,
            decodeSetup: setupOf,
            cycleDocument,
          })
        : undefined;
    if (restored && raw!.claim) {
      const target = restored.site?.target ?? {
        kind: "BELT" as const,
        systemID: restored.systemID,
        name: restored.beltName!,
      };
      if (raw!.claim?.key !== targetKey(target))
        throw Error("The retained productive target differs from its original claim.");
    }
    const shiftEndsAt = deps
      .launchJournal?.(normalized.operationID, normalized.operationRunID)
      ?.read()?.shiftEndsAt;
    const group = makeGroup(normalized, deps, document, board, store, restored, shiftEndsAt);
    groups.set(normalized.operationID, group);
    return group;
  }
  // Bot Host resumes the saved grant and setup. A WC restart gives it a new
  // botID, while a plugin child reconnect can retain the current one.
  const run = (role: "MINER" | "HAULER" | "COMMAND" | "DEFENDER"): BackendRun => ({
    check(value) {
      const setup = setupOf(value);
      return setup
        ? {
            ok: true,
            setup: setup as any,
            name: `Raw fleet ${role.toLowerCase()}`,
            policy: {
              riskClasses:
                role === "DEFENDER" || role === "MINER"
                  ? ["inventory", "fleet", "combat", "financial"]
                  : ["inventory", "fleet", "financial"],
              restartSafe: true,
            },
          }
        : {
            ok: false,
            refusal:
              "Select miners, a delivery policy, a target and an exact corporation destination.",
          };
    },
    async start(ctx) {
      const setup = setupOf(ctx.setup),
        member = setup?.members.find((m) => m.characterID === ctx.characterID && m.role === role);
      if (!setup || !member || ctx.held.characterID !== ctx.characterID)
        throw Error("Fleet member custody or generation is invalid; reconciliation is required.");
      let resumedLaunch: ResumedLaunch | undefined;
      if (deps.launchJournal) {
        const journal = deps.launchJournal(setup.operationID, setup.operationRunID);
        const receipt = journal?.read(),
          original = receipt?.members.find(
            (m) => m.characterID === ctx.characterID && m.role === role,
          );
        const ended = () =>
          Error("This fleet launch has ended or changed. Start from its saved configuration.");
        if (!journal || !original || original.status === "PREPARED") throw ended();
        if (
          setup.startupPreparation !== undefined &&
          receipt?.setupHash !== createHash("sha256").update(JSON.stringify(setup)).digest("hex")
        )
          throw ended();
        if (ctx.resumed) {
          const index = document(`mining-fleet-index:${setup.operationID}`).read() as {
            runID?: string;
            signature?: string;
          } | null;
          if (
            index?.runID !== setup.operationRunID ||
            index.signature !== JSON.stringify(setup) ||
            original.status !== "ACCEPTED" ||
            !original.botID
          )
            throw ended();
          resumedLaunch = {
            journal,
            previousBotID: original.botID,
            accountName: original.accountName,
          };
        }
      }
      if (ctx.resumed && !groups.has(setup.operationID)) {
        const retained = operationStore(setup.operationID, setup.operationRunID).read();
        const canResumeStop =
          retained?.stopRequested &&
          retained.stopFreight &&
          !retained.stoppedBeforeWork &&
          !retained.relocation &&
          !finish.ownsOperation(setup.operationID) &&
          ["ACTIVE", "DRAINING", "SETTLING", "PARKING"].includes(retained.state ?? "");
        if (
          !canResumeStop &&
          (!retained ||
            retained.stopRequested ||
            retained.relocation ||
            !["READY", "ACTIVE"].includes(retained.state ?? ""))
        ) {
          if (resumedLaunch && resumedLaunch.previousBotID !== ctx.botID)
            throw Error(
              "The original fleet state requires reconciliation before resuming this hosted pilot.",
            );
          return finish.resumeHeld(ctx, {
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
          });
        }
      }
      return getOrCreate(setup, ctx.resumed).add(ctx, member, resumedLaunch);
    },
  });
  function requestOperationStop(
    input: { operationID: string; operationRunID: string },
    mode: StopFreightMode,
    receipt?: import("../operations/miningLaunchJournal.ts").FleetLaunchReceipt,
  ) {
    const group = groups.get(input.operationID);
    if (group) {
      if (group.op.snapshot().runID !== input.operationRunID)
        throw Error("The active fleet generation changed.");
      const selected = group.requestStop(mode);
      if (
        receipt?.operationID === input.operationID &&
        receipt.operationRunID === input.operationRunID
      )
        group.recordNeverStarted(
          receipt.members.filter((m) => m.status === "PREPARED").map((m) => m.characterID),
        );
      return {
        mode: selected,
        live: [...group.entries.values()].some((e) => e.active || e.reconnecting),
      };
    }
    if (deps.launchJournal) {
      const { operationID, operationRunID } = input;
      const index = document(`mining-fleet-index:${operationID}`).read() as {
        runID?: string;
      } | null;
      if (
        receipt?.operationID !== operationID ||
        receipt.operationRunID !== operationRunID ||
        index?.runID !== operationRunID ||
        operationHasController(operationID)
      )
        return { mode: undefined, live: false };
      const retained = operationStore(operationID, operationRunID),
        snapshot = retained.read();
      if (
        snapshot?.version !== 1 ||
        snapshot.operationID !== operationID ||
        snapshot.runID !== operationRunID ||
        snapshot.state !== "ACTIVE"
      )
        return { mode: undefined, live: false };
      const selected = snapshot.stopFreight ?? mode;
      // Record the operator's intent. The existing offline check retires the
      // generation; no physical settlement or freight cleanup took place here.
      if (!snapshot.offlineStopRequested)
        retained.write({
          ...snapshot,
          stopRequested: true,
          stopFreight: selected,
          offlineStopRequested: true,
        });
      return { mode: selected, live: false };
    }
    return { mode: finish.requestStop(input, mode), live: false };
  }
  function targetSnapshot() {
    const entries = board.snapshot();
    return {
      ...entries,
      ...Object.fromEntries(
        board.dangerousTargets().map((target) => {
          const key = targetKey(target);
          return [key, { target, claim: entries[key]?.claim ?? null, state: "DANGEROUS" }];
        }),
      ),
    };
  }
  return {
    async shutdown() {
      if (disposed || boardAuthority?.board !== board) return;
      disposed = true;
      await Promise.all([...groups.values()].map((group) => group.shutdown()));
      if (boardAuthority?.board === board) boardAuthority = null;
    },
    resetDepletedBelt: board.resetDepletedBelt,
    operationSnapshot(operationID: string, runID: string) {
      if (!operationID || !runID) return null;
      const row = operationStore(operationID, runID).read();
      return row?.operationID === operationID && row.runID === runID ? row : null;
    },
    deliveryReceiptIndex: (operationID: string) => deliveryReceiptIndex(storage, operationID),
    deliveryReceipt: (operationID: string, runID: string, containerID: number) =>
      operationStore(operationID, runID).readDelivery(containerID),
    completedFleetResult,
    getOrCreate,
    requestOperationStop,
    discardGeneration,
    finalizeRetainedStop: finish.finalize,
    finishSnapshot: (id: string, run: string, characterID: number) =>
      document(`mining-fleet-finish-status:${JSON.stringify([id, run, characterID])}`).read(),
    authorizeFinish: (
      receipt: import("../operations/miningLaunchJournal.ts").FleetLaunchReceipt,
    ) => {
      const index = document(`mining-fleet-index:${receipt.operationID}`).read() as {
        runID?: string;
      } | null;
      if (index?.runID !== receipt.operationRunID)
        throw Error("The retained native launch generation changed.");
      document(
        `mining-fleet-finish-authority:${JSON.stringify([receipt.operationID, receipt.operationRunID])}`,
      ).write(receipt);
    },
    telemetrySnapshot: (operationID: string, runID: string) => {
      const group = groups.get(operationID);
      return group && group.op.snapshot().runID === runID
        ? group.telemetrySnapshot()
        : readFleetTelemetry(
            document(`mining-fleet-telemetry:${JSON.stringify([operationID, runID])}`),
            operationID,
            runID,
          );
    },
    retainedSetup: (operationID: string, runID: string) => {
      const index = document(`mining-fleet-index:${operationID}`).read() as {
        runID?: string;
        signature?: string;
      } | null;
      if (index?.runID !== runID || typeof index.signature !== "string") return null;
      try {
        const value = JSON.parse(index.signature),
          setup = setupOf(value);
        return setup && setup.operationID === operationID && setup.operationRunID === runID
          ? setup
          : null;
      } catch {
        return null;
      }
    },
    memberSnapshot: (operationID: string, runID: string) => {
      const group = groups.get(operationID);
      return group && group.op.snapshot().runID === runID ? group.memberSnapshot() : null;
    },
    supportSnapshot: (operationID: string, runID: string) => {
      const group = groups.get(operationID);
      if (group && group.op.snapshot().runID === runID) return group.supportSnapshot();
      try {
        const row = document(
          `mining-fleet-support-telemetry:${JSON.stringify([operationID, runID])}`,
        ).read() as {
          version?: unknown;
          operationID?: unknown;
          runID?: unknown;
          value?: ReturnType<Group["supportSnapshot"]>;
        } | null;
        if (
          row?.version !== 1 ||
          row.operationID !== operationID ||
          row.runID !== runID ||
          !row.value
        )
          return null;
        const value = structuredClone(row.value);
        return {
          ...value,
          active: false,
          ...(value.observedSupport
            ? {
                observedSupport: {
                  ...value.observedSupport,
                  observation: { ...value.observedSupport.observation, fresh: false },
                },
              }
            : {}),
        };
      } catch {
        return null;
      }
    },
    prepareRelocation: async (input: Parameters<Group["prepareRelocation"]>[0]) =>
      await (groups.get(input.operationID)?.prepareRelocation(input) ?? Promise.resolve(null)),
    requestRelocation: (input: Parameters<Group["requestRelocation"]>[0]) =>
      groups.get(input.operationID)?.requestRelocation(input) ?? false,
    markTargetSafe: board.markSafe,
    targetSnapshot,
    runs: {
      MINER: run("MINER"),
      HAULER: run("HAULER"),
      COMMAND: run("COMMAND"),
      DEFENDER: run("DEFENDER"),
      FINISH: finish,
    },
  };
}
