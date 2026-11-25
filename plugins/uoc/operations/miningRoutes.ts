import type {
  BackendPilotObservation,
  UocBackendRequest as BackendRequest,
} from "../shared/backendScope.ts";
import { preparationEvidence } from "./miningEvidence.ts";
import {
  retainedMiningRecovery,
  dispatchFinish,
  acceptFinish,
  type UnverifiedMiningStop,
} from "./miningRecovery.ts";
import { pendingMiningReadiness } from "./miningReadiness.ts";
import type { OperationRecord, StopFreightMode } from "../miningFleet/operation.ts";
import type { FleetSetup } from "../miningFleet/runtime.ts";
import { retainedStopUnload } from "../miningFleet/finishParking.ts";
import type { ArchivedDelivery, FleetRunResult } from "../miningFleet/operationStore.ts";
import {
  miningFreightTelemetry,
  miningSupportTelemetry,
  miningMemberFreightTelemetry,
} from "./miningTelemetry.ts";
import { assertMiningReview } from "./miningReview.ts";
import { createFleetLaunchJournal, type FleetLaunchReceipt } from "./miningLaunchJournal.ts";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  pluginDataDir,
  type BackendRoute,
  type PluginRunCheck,
} from "../../../web/src/plugin-api/backend.ts";
import { MAX_SHIFT_MINUTES } from "../miningFleet/shiftTiming.ts";
import {
  createMiningDefinitionStore,
  definitionHash,
  type SavedDefinition,
  type SyncDocument,
} from "./miningStore.ts";

type DefinitionStorage = {
  document(name: string): SyncDocument;
  documentNames(prefix: string): string[];
  transaction<T>(action: () => T): T;
  deleteDocuments(names: readonly string[], prefixes: readonly string[]): void;
};
const require = createRequire(import.meta.url),
  { createDocumentStore } = require("../documentStore.cjs") as {
    createDocumentStore: (file: string) => DefinitionStorage;
  };
let db: ReturnType<typeof createDocumentStore> | null = null;
const defaultStorage = () =>
  (db ??= createDocumentStore(path.join(pluginDataDir(), "mining-definitions.sqlite")));
const obj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 160;
const error = (e: unknown) => (e instanceof Error ? e.message : String(e));

export { currentExecutorGaps } from "./miningCapabilities.ts";
import { currentExecutorGaps } from "./miningCapabilities.ts";
export type MiningRoutesDeps = {
  deliveryReceiptIndex?: (operationID: string) => readonly { runID: string; containerID: number }[];
  deliveryReceipt?: (
    operationID: string,
    runID: string,
    containerID: number,
  ) => ArchivedDelivery | null;
  completedFleetResult?: (operationID: string, runID?: string) => FleetRunResult | null;
  resetDepletedBelt?: (key: string) => boolean;
  requestStop?: (
    input: { operationID: string; operationRunID: string },
    mode: StopFreightMode,
    receipt?: import("./miningLaunchJournal.ts").FleetLaunchReceipt,
  ) => { mode: StopFreightMode | undefined; live: boolean };
  document: (key: string) => SyncDocument;
  getWorldScope?: (request: BackendRequest) => string | null;
  isOperationActive?: (operationID: string) => boolean;
  authorizeFinish?: (receipt: import("./miningLaunchJournal.ts").FleetLaunchReceipt) => void;
  finalizeRetainedStop?: (
    input: { operationID: string; operationRunID: string },
    observations?: readonly BackendPilotObservation[],
  ) => Promise<boolean>;
  canFinish?: (operationID: string, operationRunID: string, characterID?: number) => boolean;
  checkSetup?: (setup: unknown) => PluginRunCheck | Promise<PluginRunCheck>;
  markTargetSafe?: (key: string) => boolean;
  targetSnapshot?: () => Readonly<
    Record<
      string,
      {
        target: { kind: string; systemID: number; name: string };
        state: string;
        claim: { operationID: string } | null;
      }
    >
  >;
  operationSnapshot?: (operationID: string, runID: string) => unknown;
  hostedRunPolicy?: unknown;
  finishSnapshot?: (id: string, run: string, characterID: number) => any;
  preparationSnapshot?: (world: string, id: string, run: string, characterID: number) => unknown;
  telemetrySnapshot?: (operationID: string, runID: string) => any;
  retainedSetup?: (operationID: string, runID: string) => unknown;
  supportSnapshot?: (operationID: string, runID: string) => unknown;
  memberSnapshot?: (operationID: string, runID: string) => unknown;
  relocate?: (intent: {
    operationID: string;
    operationRunID: string;
    claimKey: string;
    claimGeneration: number;
  }) => Promise<boolean>;
};
/** Routes never borrow a GamePort session; the browser obtains per-member native inspection through normal host APIs. */
type MiningLifecycle = {
  discardGeneration(operationID: string, runID: string, preserveExecution?: boolean): boolean;
  discardPreparation?: (worldID: string, operationID: string, runID: string) => void;
};

export function findMiningLaunchJournal(
  storage: Pick<DefinitionStorage, "documentNames" | "document">,
  operationID: string,
  runID: string,
) {
  for (const key of storage.documentNames("mining-launch:")) {
    const doc = storage.document(key),
      raw = doc.read() as FleetLaunchReceipt | null;
    if (raw?.operationID === operationID && raw.operationRunID === runID)
      return createFleetLaunchJournal(doc);
  }
  return null;
}

export function createMiningOperationRoutes(
  deps: MiningRoutesDeps,
  storage?: Pick<DefinitionStorage, "transaction" | "deleteDocuments" | "documentNames">,
  lifecycle?: MiningLifecycle,
): Record<string, BackendRoute> {
  const launching = new Map<string, number>();
  function isLaunching(key: string) {
    const expires = launching.get(key);
    if (expires === undefined) return false;
    if (Date.now() < expires) return true;
    launching.delete(key);
    return false;
  }
  const scope = (req: BackendRequest) => {
    const world = deps.getWorldScope?.(req);
    if (!text(world)) throw Error("The current world scope is unavailable.");
    return JSON.stringify([world]);
  };
  const legacyScopePrefix = (identity: string) => identity.slice(0, -1) + ",";
  function store(identity: string) {
    const name = `mining-definitions:${identity}`,
      document = deps.document(name),
      current = createMiningDefinitionStore(document);
    if (storage) {
      const legacy = storage.documentNames("mining-definitions:" + legacyScopePrefix(identity));
      if (legacy.length)
        storage.transaction(() => {
          const merged = new Map<string, { definition: SavedDefinition; source: string }>();
          for (const source of [name, ...legacy]) {
            let definitions: SavedDefinition[];
            try {
              definitions = createMiningDefinitionStore(deps.document(source)).list();
            } catch (cause) {
              throw Error(`Cannot import MCC definitions from ${source}. ${error(cause)}`);
            }
            for (const definition of definitions) {
              const previous = merged.get(definition.operationID);
              if (previous && !isDeepStrictEqual(previous.definition, definition))
                throw Error(
                  `Conflicting MCC operation ${definition.operationID} in ${previous.source} and ${source}.`,
                );
              if (!previous) merged.set(definition.operationID, { definition, source });
            }
          }
          document.write({
            version: 1,
            definitions: [...merged.values()].map((row) => row.definition),
          });
          storage.deleteDocuments(legacy, []);
        });
    }
    return current;
  }
  const launchKey = (identity: string, id: string) =>
    `mining-launch:${JSON.stringify([identity, id])}`;
  const journalFor = (identity: string, id: string) =>
    createFleetLaunchJournal(deps.document(launchKey(identity, id)));
  const launchScope = (identity: string, id: string, runID: string) =>
    JSON.stringify([identity, id, runID]);
  const unverifiedStopKey = (identity: string, id: string) =>
    `mining-last-unverified-stop:${JSON.stringify([identity, id])}`;
  function launchIdentity(identity: string, id: string) {
    if (!storage) return identity;
    // A launch key encodes the definition scope as a string inside its own JSON array.
    const prefix = "mining-launch:" + JSON.stringify([legacyScopePrefix(identity)]).slice(0, -2);
    const legacy = storage.documentNames(prefix).flatMap((name) => {
      const [original, operationID] = JSON.parse(name.slice("mining-launch:".length));
      return operationID === id && deps.document(name).read() !== null ? [original as string] : [];
    });
    if (
      legacy.length > 1 ||
      (legacy.length && deps.document(launchKey(identity, id)).read() !== null)
    )
      throw Error(`Conflicting MCC launch journals for operation ${id}.`);
    return legacy[0] ?? identity;
  }
  function retire(
    identity: string,
    receipt: FleetLaunchReceipt,
    original: string,
    preserveExecution = false,
    unverified?: UnverifiedMiningStop,
  ) {
    if (
      !lifecycle ||
      !storage ||
      !lifecycle.discardGeneration(receipt.operationID, receipt.operationRunID, preserveExecution)
    )
      return false;
    const { operationID: id, operationRunID: runID } = receipt,
      key = launchScope(original, id, runID);
    if (!preserveExecution) lifecycle.discardPreparation?.(JSON.parse(identity)[0], id, runID);
    storage.transaction(() => {
      if (unverified) {
        deps.document(`mining-launch-history:${key}`).write(receipt);
        deps.document(unverifiedStopKey(identity, id)).write(unverified);
      }
      storage.deleteDocuments(
        preserveExecution
          ? [launchKey(original, id)]
          : [
              launchKey(original, id),
              `mining-launch-setup:${key}`,
              `mining-finish:${key}`,
              `mining-launch-history:${key}`,
            ],
        [],
      );
    });
    launching.delete(launchScope(identity, id, runID));
    return true;
  }
  function canCloseOfflineStop(identity: string, physical: ReturnType<typeof physicalState>) {
    const { receipt, snapshot, state } = physical;
    return (
      !!lifecycle &&
      !!receipt &&
      deps.isOperationActive?.(receipt.operationID) === false &&
      !isLaunching(launchScope(identity, receipt.operationID, receipt.operationRunID)) &&
      (state === "PARKING_FAILED" || state === "WAITING_FOR_HOST") &&
      snapshot?.stopRequested === true &&
      (snapshot.stopFreight === "RETURN_HOME" || snapshot.stopFreight === "COLLECT_FREIGHT") &&
      receipt.members.some((member) => member.status !== "PREPARED") &&
      Array.isArray(snapshot.manifests) &&
      Array.isArray(snapshot.settled) &&
      Array.isArray(snapshot.parked)
    );
  }
  function observeLifecycle(req: BackendRequest) {
    const identity = scope(req),
      body = req.body;
    if (!obj(body) || !Array.isArray(body.generations))
      throw Error("Exact operation generations are required.");
    const observations = req.pilotObservations;
    const now = Date.now();
    for (const expected of body.generations) {
      if (!obj(expected) || !text(expected.operationID) || !text(expected.operationRunID)) continue;
      const definition = store(identity).get(expected.operationID);
      if (!definition) continue;
      const original = launchIdentity(identity, expected.operationID);
      const receipt = journalFor(original, expected.operationID).read();
      if (
        !receipt ||
        receipt.operationRunID !== expected.operationRunID ||
        deps.isOperationActive?.(receipt.operationID) !== false ||
        isLaunching(launchScope(identity, receipt.operationID, receipt.operationRunID))
      )
        continue;
      const started = receipt.members.filter((member) => member.status !== "PREPARED");
      const physical = physicalState(identity, expected.operationID);
      const snapshot = physical.snapshot;
      if (expected.closeOfflineStop === true) {
        if (!snapshot || !canCloseOfflineStop(identity, physical)) continue;
        const offline = observations
          ? started.every((member) =>
              observations.some(
                (p) =>
                  p.characterID === member.characterID &&
                  p.accountName.toLowerCase() === member.accountName.toLowerCase() &&
                  p.owner === "OFF" &&
                  p.online === false &&
                  Number.isFinite(p.observedAt) &&
                  p.observedAt <= now &&
                  now - p.observedAt <= 15_000,
              ),
            )
          : expected.endStopped === true;
        if (!offline) continue;
        // Release the run without completing its parking or freight journals.
        retire(identity, receipt, original, true, {
          operationRunID: receipt.operationRunID,
          closedAt: now,
          unconfirmedDeliveries: snapshot.manifests.filter(
            (manifest: OperationRecord["manifests"][number]) => !manifest.delivered,
          ).length,
          unverifiedPilots: started
            .filter(
              (member) =>
                !snapshot.settled.includes(member.characterID) ||
                (!snapshot.parked.includes(member.characterID) &&
                  !snapshot.stayed?.includes(member.characterID)),
            )
            .map((member) => member.characterID),
        });
        continue;
      }
      const orphanStop =
        physical.state === "WAITING_FOR_HOST" &&
        snapshot?.state === "ACTIVE" &&
        snapshot.stopRequested === true;
      const parkingMode = definition.policies?.parking.mode;
      // A lost hosted owner proves release, not arrival or unload at the chosen dock.
      if (
        (parkingMode === "RETURN_HOME_DOCK" || parkingMode === "RETURN_HOME_UNLOAD_DOCK") &&
        snapshot?.stopRequested === true &&
        physical.state !== "STOPPED" &&
        !(orphanStop && snapshot.offlineStopRequested === true)
      )
        continue;
      const released = observations
        ? started.every((member) =>
            observations.some(
              (p) =>
                p.characterID === member.characterID &&
                p.accountName.toLowerCase() === member.accountName.toLowerCase() &&
                (orphanStop
                  ? p.owner === "OFF" && p.online === false
                  : ["OFF", "BROWSER", "FACTORY", "RECOVERY", "OTHER_SESSION"].includes(p.owner)) &&
                Number.isFinite(p.observedAt) &&
                p.observedAt <= now &&
                now - p.observedAt <= 15_000,
            ),
          )
        : physical.state === "STOPPED";
      // On stock Farmer the page reads native ownership per account. This is the
      // operator's logical Stop of an inactive run, not proof of cargo delivery or
      // physical parking. Keep all execution facts when ending it this way.
      const endStopped =
        !observations &&
        expected.endStopped === true &&
        obj(snapshot) &&
        snapshot.stopRequested === true;
      if (!released && !endStopped) continue;
      const unfinished =
        (physical.state !== "STOPPED" &&
          (started.length > 0 || (obj(snapshot) && snapshot.state !== "READY"))) ||
        (obj(snapshot) &&
          (!!snapshot.relocation || Object.keys(snapshot.haulClaims ?? {}).length > 0));
      retire(identity, receipt, original, unfinished);
    }
    return { body: payload(identity) };
  }
  const physicalState = (identity: string, id: string) => {
    const receipt = journalFor(launchIdentity(identity, id), id).read(),
      active = deps.isOperationActive?.(id);
    if (!receipt)
      return { receipt: null, snapshot: null, state: active === false ? "DRAFT" : "UNKNOWN" };
    if (receipt.members.every((m) => m.status === "PREPARED") && active === false) {
      const inFlight = lifecycle && isLaunching(launchScope(identity, id, receipt.operationRunID));
      return { receipt, snapshot: null, state: inFlight ? "ASSEMBLING" : "DRAFT" };
    }
    const raw = deps.operationSnapshot?.(id, receipt.operationRunID),
      unknown = lifecycle ? "WAITING_FOR_HOST" : "UNKNOWN";
    if (
      !obj(raw) ||
      raw.operationID !== id ||
      raw.runID !== receipt.operationRunID ||
      !Array.isArray(raw.members) ||
      raw.members.length !== receipt.members.length ||
      receipt.members.some(
        (m) => !raw.members.some((x: any) => x.characterID === m.characterID && x.role === m.role),
      ) ||
      !["READY", "ACTIVE", "DRAINING", "SETTLING", "PARKING", "STOPPED"].includes(raw.state)
    )
      return {
        receipt,
        snapshot: null,
        state:
          lifecycle && (active || isLaunching(launchScope(identity, id, receipt.operationRunID)))
            ? "ASSEMBLING"
            : unknown,
      };
    if (raw.state !== "STOPPED" && !active) {
      const telemetry = raw.stopRequested && deps.telemetrySnapshot?.(id, receipt.operationRunID);
      const lostDuringStop =
        Array.isArray(telemetry?.members) &&
        telemetry.members.some(
          (m: any) =>
            m.phase === "Stop needs attention" &&
            m.active === false &&
            !raw.parked?.includes(m.characterID),
        );
      return { receipt, snapshot: raw, state: lostDuringStop ? "PARKING_FAILED" : unknown };
    }
    if (
      raw.state === "STOPPED" &&
      (!Array.isArray(raw.settled) ||
        !Array.isArray(raw.parked) ||
        raw.settled.length + (raw.neverStarted?.length ?? 0) !== raw.members.length ||
        new Set([...(raw.parked ?? []), ...(raw.stayed ?? []), ...(raw.neverStarted ?? [])])
          .size !== raw.members.length ||
        raw.members.some((m: any) =>
          raw.neverStarted?.includes(m.characterID)
            ? receipt.members.find((r) => r.characterID === m.characterID)?.status !== "PREPARED"
            : !raw.settled.includes(m.characterID) ||
              ![...raw.parked, ...(raw.stayed ?? [])].includes(m.characterID),
        ) ||
        raw.claim !== null ||
        !Array.isArray(raw.manifests) ||
        raw.manifests.some((x: any) => x.delivered !== true) ||
        !obj(raw.jetcanIntents) ||
        Object.keys(raw.jetcanIntents).length)
    )
      return { receipt, snapshot: null, state: unknown };
    return {
      receipt,
      snapshot: raw,
      state:
        raw.state === "READY"
          ? "ASSEMBLING"
          : raw.state === "DRAINING" || raw.state === "SETTLING"
            ? "STOPPING"
            : raw.state,
    };
  };
  const assertLaunchAvailable = (identity: string, id: string) => {
    if (!deps.isOperationActive) throw Error("Live operation ownership is unavailable.");
    if (deps.isOperationActive(id))
      throw Error("Stop the active operation before launching another generation.");
    const state = physicalState(identity, id);
    if (state.receipt && state.state !== "STOPPED" && state.state !== "DRAFT")
      throw Error(
        "Previous fleet custody is unresolved; reconcile it before launching another generation.",
      );
  };
  const stopUnload = (receipt: FleetLaunchReceipt | null, snapshot: OperationRecord | null) => {
    if (!snapshot?.stopRequested || !receipt) return null;
    const setup = deps.retainedSetup?.(receipt.operationID, receipt.operationRunID) as
      FleetSetup | null | undefined;
    return retainedStopUnload(snapshot, setup ?? null);
  };
  const payload = (identity: string) => ({
    ok: true,
    operations: store(identity)
      .list()
      .map((definition) => {
        const physical = physicalState(identity, definition.operationID),
          snapshot = physical.snapshot,
          claim = snapshot?.claim,
          board = deps.targetSnapshot?.() ?? {},
          entry = claim && board[claim.key];
        const lastRun = deps.completedFleetResult?.(definition.operationID) ?? null;
        const savedStop =
          physical.state === "DRAFT"
            ? (deps
                .document(unverifiedStopKey(identity, definition.operationID))
                .read() as UnverifiedMiningStop | null)
            : null;
        const unverifiedStop =
          savedStop && savedStop.closedAt > (lastRun?.observedAt ?? 0) ? savedStop : null;
        const pendingUnload = lifecycle
          ? stopUnload(physical.receipt, snapshot as OperationRecord | null)
          : null;
        const target =
          entry && claim
            ? {
                targetKey: claim.key,
                claimGeneration: claim.generation,
                targetType: entry.target.kind,
                systemID: entry.target.systemID,
                systemName: null,
                targetName: entry.target.name,
                state: physical.state === "UNKNOWN" ? "RETAINED_UNKNOWN" : entry.state,
                claimedByOperationID: entry.claim?.operationID ?? null,
              }
            : null;
        const telemetry = physical.receipt
          ? deps.telemetrySnapshot?.(definition.operationID, physical.receipt.operationRunID)
          : null;
        const memberReads: any =
          telemetry?.members ??
          (physical.receipt
            ? deps.memberSnapshot?.(definition.operationID, physical.receipt.operationRunID)
            : null);
        const runRoster =
          physical.state !== "DRAFT"
            ? physical.receipt?.members.map((member) => {
                const saved = definition.members.find(
                  (m) =>
                    m.characterID === member.characterID && m.accountName === member.accountName,
                );
                return {
                  characterID: member.characterID,
                  characterName: saved?.characterName ?? member.accountName,
                  accountName: member.accountName,
                  role: member.role,
                  routineMode: "STANDARD",
                  automationID: "",
                };
              })
            : undefined;
        let finishedAt: number | null = null;
        const support = physical.receipt
          ? deps.supportSnapshot?.(definition.operationID, physical.receipt.operationRunID)
          : null;
        const members = (runRoster ?? definition.members).map((m) => {
          const receipt = physical.receipt?.members.find((x) => x.characterID === m.characterID),
            native = snapshot?.members?.find((x: any) => x.characterID === m.characterID),
            read = Array.isArray(memberReads)
              ? memberReads.find(
                  (x: any) =>
                    x.characterID === m.characterID &&
                    x.shipID === native?.shipID &&
                    x.botID === receipt?.botID,
                )
              : null;
          const finish = physical.receipt
              ? deps.finishSnapshot?.(
                  definition.operationID,
                  physical.receipt.operationRunID,
                  m.characterID,
                )
              : null,
            finishValid =
              finish?.version === 1 &&
              finish.operationID === definition.operationID &&
              finish.runID === physical.receipt?.operationRunID &&
              finish.characterID === m.characterID &&
              finish.shipID === native?.shipID &&
              Number.isFinite(finish.observedAt) &&
              typeof finish.report?.phase === "string";
          if (finishValid && finish.report.readout?.groupCompleted === true)
            finishedAt = Math.max(finishedAt ?? 0, finish.observedAt);
          const remaining = finishValid ? finish.report.readout?.pendingUnloadUnits : undefined;
          const prep =
            native && physical.receipt
              ? preparationEvidence(
                  deps.preparationSnapshot?.(
                    JSON.parse(identity)[0],
                    definition.operationID,
                    physical.receipt.operationRunID,
                    m.characterID,
                  ),
                  {
                    world: JSON.parse(identity)[0],
                    operationID: definition.operationID,
                    operationRunID: physical.receipt.operationRunID,
                    characterID: m.characterID,
                    shipID: native.shipID,
                    role: m.role,
                  },
                )
              : null;
          return {
            ...m,
            offlineParking: snapshot?.offlineParking?.[String(m.characterID)],
            ...(prep ? { preparation: prep } : {}),
            ...(Number.isSafeInteger(remaining) && remaining >= 0
              ? { pendingUnloadUnits: remaining }
              : {}),
            oreLogisticsWork: miningMemberFreightTelemetry(
              read?.freight,
              snapshot,
              m.characterID,
              definition.oreLogistics,
              support,
            ),
            runtimeState: physical.state === "DRAFT" ? "DRAFT" : "UNKNOWN",
            phase: finishValid
              ? "Last FINISH: " + finish.report.phase
              : (read?.phase ??
                (receipt?.refusal
                  ? "Hosted Start refused"
                  : receipt?.status === "DISPATCHED"
                    ? "Checking hosted Start"
                    : null)),
            reason: finishValid
              ? (finish.report.why ?? finish.report.phase)
              : (read?.reason ??
                receipt?.refusal ??
                (receipt?.status === "DISPATCHED"
                  ? "The original hosted Start is unconfirmed. It will not be sent again without reconciliation."
                  : null)),
            lastHostReason: finishValid
              ? "Last native FINISH at " +
                new Date(finish.observedAt).toISOString() +
                ": " +
                (finish.report.why ?? finish.report.phase)
              : (read?.reason ?? receipt?.refusal ?? null),
            botID: receipt?.botID ?? null,
            parkingState: snapshot?.parked?.includes(m.characterID)
              ? "DOCK_VERIFIED"
              : snapshot?.stayed?.includes(m.characterID)
                ? "SETTLED_IN_PLACE"
                : snapshot?.settled?.includes(m.characterID)
                  ? "SETTLED"
                  : "UNVERIFIED",
          };
        });
        const rendezvous =
          snapshot?.relocation && target
            ? {
                kind: snapshot.haulMode === "SELF_UNLOAD" ? "SELF_UNLOAD" : "MINER_CLEARANCE",
                target,
                required: snapshot.members.map((m: any) => m.characterID),
                ready: snapshot.settled ?? [],
              }
            : null;
        const freight = miningFreightTelemetry(snapshot, board);
        if (Array.isArray(telemetry?.history))
          freight.history.push(
            ...telemetry.history.filter(
              (h: any) =>
                h?.kind === "TARGET_SELECTION" &&
                Number.isFinite(Date.parse(h.at)) &&
                h.target?.claimedByOperationID === definition.operationID,
            ),
          );
        freight.history.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
        return {
          definition,
          runtime: {
            observedAt: new Date().toISOString(),
            extensionSupported: false,
            ...(physical.receipt?.shiftEndsAt !== undefined
              ? { shiftEndsAt: new Date(physical.receipt.shiftEndsAt).toISOString() }
              : {}),
            lastRun,
            ...(unverifiedStop ? { unverifiedStop } : {}),
            ...(canCloseOfflineStop(identity, physical) ? { canCloseOfflineStop: true } : {}),
            supportStatus: miningSupportTelemetry(support),
            operationID: definition.operationID,
            operationRunID: physical.receipt?.operationRunID ?? null,
            state:
              (physical.state === "ACTIVE" || physical.state === "ASSEMBLING") &&
              (snapshot?.stopRequested || telemetry?.stopRequested)
                ? "STOPPING"
                : physical.state,
            statusReason:
              physical.state === "PARKING_FAILED"
                ? "Required Stop work remains unfinished. See the affected pilots for the last verified cargo and reason."
                : physical.state === "WAITING_FOR_HOST"
                  ? "Checking whether Farmer still owns pilots for this run."
                  : physical.state === "UNKNOWN"
                    ? "Retained native custody has no verified current controller. Stop surviving owners or explicitly reconcile docked retained members."
                    : (telemetry?.operationWarning ?? null),
            stopFreight: snapshot?.stopFreight ?? null,
            ...(pendingUnload?.characterIDs.length ? { stopUnload: pendingUnload } : {}),
            recoveryRequired: physical.state === "UNKNOWN" && !!physical.receipt,
            relocation: snapshot?.relocation ?? null,
            currentTarget: target,
            members,
            preparation: members.some((m) => m.preparation)
              ? {
                  historical: true,
                  state: members.some((m) => !m.preparation)
                    ? "PENDING"
                    : members.some((m) => m.preparation?.state === "DEGRADED")
                      ? "DEGRADED"
                      : "VERIFIED",
                  members: members.flatMap((m) => (m.preparation ? [m.preparation] : [])),
                }
              : undefined,
            ...freight,
            rendezvous,
            startedAt: Number.isFinite(telemetry?.startedAt)
              ? new Date(telemetry.startedAt).toISOString()
              : null,
            stoppedAt:
              physical.state === "STOPPED" && Number.isFinite(telemetry?.stoppedAt)
                ? new Date(telemetry.stoppedAt).toISOString()
                : physical.state === "STOPPED" && finishedAt !== null
                  ? new Date(finishedAt).toISOString()
                  : null,
            stopFailures: [],
          },
        };
      }),
    targetBoard: deps.targetSnapshot
      ? Object.entries(deps.targetSnapshot()).map(([targetKey, e]) => ({
          targetKey,
          targetType: e.target.kind,
          systemID: e.target.systemID,
          systemName: null,
          targetName: e.target.name,
          state: e.state,
          claimedByOperationID: e.claim?.operationID ?? null,
        }))
      : [],
    targetBoardAvailable: !!deps.targetSnapshot,
    capabilities: {
      ...(deps.hostedRunPolicy ? { hostedRunPolicy: deps.hostedRunPolicy } : {}),
      targetClasses: {
        BELT: {
          executable: true,
          note: "Requires fresh native member inspection and individually approved hosted runs.",
        },
        ORE_ANOMALY: {
          executable: true,
          note: "Requires fresh native member inspection and individually approved hosted runs.",
        },
        ICE: {
          executable: true,
          note: "Requires fresh native member inspection and individually approved hosted runs.",
        },
        GAS: { executable: false, note: "Gas is not supported." },
      },
      reach: {
        CURRENT_SYSTEM: {
          executable: true,
          note: "Current-system operations require fresh native inspection.",
        },
        CURRENT_AND_ADJACENT: {
          executable: true,
          note: "Preserves WC74 anchor-only discovery. Dynamic neighbouring-system discovery remains deferred.",
        },
      },
      defender: {
        executable: true,
        note: "Uses verified combat equipment or compatible fitted remote repairs at the operation target.",
      },
      operationOwnedContainers: { executable: true, note: "Requires an active native fleet." },
    },
  });
  const wrap =
    (fn: BackendRoute): BackendRoute =>
    async (req) => {
      try {
        return await fn(req);
      } catch (e) {
        return {
          status: 400,
          body: { ok: false, error: "MINING_OPERATION_REFUSED", message: error(e) },
        };
      }
    };
  const list: BackendRoute = wrap((req) => ({ body: payload(scope(req)) }));
  const readDeliveryReceipts: BackendRoute = wrap((req) => {
    const id = req.params.operationID ?? "",
      identity = scope(req);
    if (!store(identity).get(id))
      return { status: 404, body: { ok: false, error: "MINING_OPERATION_NOT_FOUND" } };
    const { runID, containerID } = req.query;
    if (runID !== undefined && (!text(runID) || runID.length > 120))
      throw Error("An exact run ID is required to read delivery data.");
    if (runID === undefined && containerID === undefined)
      return {
        body: {
          ok: true,
          receipts: deps.deliveryReceiptIndex?.(id) ?? [],
          lastRun: deps.completedFleetResult?.(id) ?? null,
        },
      };
    if (text(runID) && containerID === undefined) {
      const result = deps.completedFleetResult?.(id, runID);
      if (result) return { body: { ok: true, result } };
    }
    const container = Number(containerID);
    if (
      !text(runID) ||
      !/^\d+$/.test(containerID ?? "") ||
      !Number.isSafeInteger(container) ||
      container <= 0
    )
      throw Error("A run ID and container ID are required to read a delivery receipt.");
    const delivery = deps.deliveryReceipt?.(id, runID, container);
    return delivery
      ? { body: { ok: true, ...delivery } }
      : { status: 404, body: { ok: false, error: "DELIVERY_RECEIPT_NOT_FOUND" } };
  });
  const markSafe: BackendRoute = wrap((req) => {
    const identity = scope(req),
      body = req.body;
    if (!obj(body) || !text(body.targetKey) || !deps.markTargetSafe?.(body.targetKey))
      throw Error("This target is no longer marked dangerous.");
    return { body: payload(identity) };
  });
  const resetDepleted: BackendRoute = wrap((req) => {
    const identity = scope(req),
      body = req.body;
    if (!obj(body) || !text(body.targetKey) || !deps.resetDepletedBelt?.(body.targetKey))
      throw Error("Reset requires an unclaimed belt marked DEPLETED and safe.");
    return { body: payload(identity) };
  });
  const save: BackendRoute = wrap((req) => {
    const identity = scope(req);
    const saved = store(identity).save(req.body);
    return { body: { ...payload(identity), savedOperationID: saved.operationID } };
  });
  const remove: BackendRoute = wrap((req) => {
    const id = req.params.operationID ?? "",
      v = req.body;
    if (!text(id) || !obj(v) || !Number.isSafeInteger(v.revision))
      throw Error("An operation identity and reviewed revision are required.");
    const identity = scope(req),
      definitions = store(identity);
    const removeSaved = () => {
      if (!definitions.remove(id, v.revision)) return false;
      const original = launchIdentity(identity, id),
        receipt = journalFor(original, id).read();
      if (
        deps.isOperationActive?.(id) === false &&
        (!receipt || !isLaunching(launchScope(identity, id, receipt.operationRunID)))
      ) {
        const runKeys = JSON.stringify([original, id]).slice(0, -1) + ",";
        storage?.deleteDocuments(
          [launchKey(original, id), unverifiedStopKey(identity, id)],
          ["mining-launch-setup:", "mining-launch-history:", "mining-finish:"].map(
            (prefix) => prefix + runKeys,
          ),
        );
      }
      return true;
    };
    if (!(storage?.transaction(removeSaved) ?? removeSaved()))
      return { status: 404, body: { ok: false, error: "MINING_OPERATION_NOT_FOUND" } };
    return { body: payload(identity) };
  });
  const plan: BackendRoute = wrap(async (req) => {
    const d = store(scope(req)).get(req.params.operationID ?? "");
    if (!d) return { status: 404, body: { ok: false, error: "MINING_OPERATION_NOT_FOUND" } };
    const warnings = currentExecutorGaps(d),
      body = obj(req.body) ? req.body : null;
    if (body?.revision !== undefined && body.revision !== d.revision)
      throw Error("Operation changed since review; request a fresh plan.");
    if (d.area.reach === "CURRENT_AND_ADJACENT")
      warnings.push(
        "As in WC74, target discovery is restricted to the selected anchor; neighbouring-system discovery is deferred.",
      );
    let checked: PluginRunCheck | null = null;
    if (body?.setup !== undefined) {
      if (body.revision !== d.revision) throw Error("Operation changed since review.");
      assertMiningReview(d, body.setup);
      if (!deps.checkSetup) throw Error("Fleet setup validation is unavailable.");
      checked = await deps.checkSetup(body.setup);
      if (!checked.ok) warnings.push(checked.refusal);
    } else warnings.push("Start verifies pilot readiness in each hosted session before departure.");
    const candidateSupported = !!checked?.ok && currentExecutorGaps(d).length === 0;
    warnings.push("Bot Host checks an individual grant for each pilot.");
    const hash = createHash("sha256")
      .update(JSON.stringify([definitionHash(d), checked?.ok ? checked.setup : null]))
      .digest("hex");
    return {
      body: {
        ok: true,
        planHash: hash,
        revision: d.revision,
        candidateSupported,
        warnings,
        members: d.members.map((m) => ({
          characterID: m.characterID,
          routineMode: m.routineMode ?? "STANDARD",
          pluginRun: `mcc-${m.role.toLowerCase()}`,
        })),
        preparation: pendingMiningReadiness(
          d,
          warnings.join(" "),
          currentExecutorGaps(d).length > 0,
        ),
        executorReady: false,
      },
    };
  });
  const journal = (req: BackendRequest) => {
    const identity = scope(req),
      id = req.params.operationID ?? "";
    if (!text(id) || !store(identity).get(id)) throw Error("Saved operation is unavailable.");
    const original = launchIdentity(identity, id);
    return { launch: journalFor(original, id), original };
  };
  const begin: BackendRoute = wrap(async (req) => {
    const body = req.body;
    if (
      !obj(body) ||
      !obj(body.setup) ||
      !Array.isArray(body.members) ||
      typeof body.planHash !== "string" ||
      !Number.isSafeInteger(body.revision)
    )
      throw Error("Exact reviewed launch intent is required.");
    const duration = body.durationMinutes;
    if (
      duration !== undefined &&
      (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_SHIFT_MINUTES)
    )
      throw Error("The shift duration is outside the hosted runtime policy.");
    const review = await plan({ ...req, body: { revision: body.revision, setup: body.setup } }),
      result = review.body as any;
    if (
      (review.status && review.status !== 200) ||
      result?.candidateSupported !== true ||
      result.planHash !== body.planHash
    )
      throw Error("Saved fleet review no longer matches or the executor cannot represent it.");
    const identity = scope(req),
      id = req.params.operationID ?? "",
      d = store(identity).get(id);
    if (!d || d.revision !== body.revision)
      throw Error("The saved operation was deleted or changed during review.");
    if (
      !text(body.setup.operationRunID) ||
      body.members.length !== d.members.length ||
      d.members.some(
        (m) =>
          !body.members.some(
            (x: any) =>
              x.characterID === m.characterID &&
              x.accountName === m.accountName &&
              x.role === m.role &&
              x.kind === `mcc-${m.role.toLowerCase()}` &&
              Array.isArray(x.beforeIDs),
          ),
      )
    )
      throw Error("Launch members differ from the saved roster.");

    const originalIdentity = launchIdentity(identity, id);
    const runID = body.setup.operationRunID,
      retained = journalFor(originalIdentity, id).read();
    if (lifecycle) {
      if (deps.isOperationActive?.(id) !== false)
        throw Error("Stop the active operation before launching another generation.");
      if (retained) {
        if (retained.operationRunID === runID) throw Error("This fleet launch already exists.");
        if (
          isLaunching(launchScope(identity, id, retained.operationRunID)) ||
          retained.members.some((m) => m.status !== "PREPARED") ||
          !retire(identity, retained, originalIdentity)
        )
          throw Error("Waiting for the previous fleet's hosted owners to finish.");
      }
    } else {
      assertLaunchAvailable(identity, id);
      if (retained && retained.operationRunID !== runID) {
        const archive = deps.document(
          `mining-launch-history:${launchScope(originalIdentity, id, retained.operationRunID)}`,
        );
        const old = archive.read();
        if (old !== null && JSON.stringify(old) !== JSON.stringify(retained))
          throw Error("The earlier launch archive differs; reconciliation is required.");
        if (old === null) archive.write(retained);
        deps.document(launchKey(originalIdentity, id)).write(null);
      }
    }
    const shiftEndsAt = duration === undefined ? undefined : Date.now() + duration * 60_000;
    const setupHash = createHash("sha256").update(JSON.stringify(body.setup)).digest("hex");
    const setupDoc = deps.document(`mining-launch-setup:${JSON.stringify([identity, id, runID])}`),
      original = setupDoc.read();
    if (original !== null && JSON.stringify(original) !== JSON.stringify(body.setup))
      throw Error("The original generation setup is immutable.");
    const open = () => {
      if (original === null) setupDoc.write(body.setup);
      return journalFor(identity, id).begin({
        operationID: id,
        operationRunID: runID,
        revision: body.revision,
        planHash: body.planHash,
        setupHash,
        ...(shiftEndsAt === undefined ? {} : { shiftEndsAt }),
        members: body.members.map((m: any) => ({
          characterID: m.characterID,
          accountName: m.accountName,
          role: m.role,
          kind: m.kind,
          beforeIDs: m.beforeIDs,
          ...(typeof m.refusal === "string" && m.refusal.trim()
            ? { refusal: m.refusal.trim().slice(0, 200) }
            : {}),
        })),
      });
    };
    const receipt = storage?.transaction(open) ?? open();
    // The host claim may not exist yet while the browser is dispatching Start.
    if (lifecycle) launching.set(launchScope(identity, id, runID), Date.now() + 120_000);
    return { body: { ok: true, receipt } };
  });
  const finishLaunch: BackendRoute = wrap((req) => {
    const v = req.body;
    if (!obj(v) || !text(v.operationRunID)) throw Error("The launch generation is required.");
    launching.delete(launchScope(scope(req), req.params.operationID ?? "", v.operationRunID));
    return { body: { ok: true } };
  });
  const dispatch: BackendRoute = wrap((req) => {
    const v = req.body;
    if (!obj(v) || !Number.isSafeInteger(v.characterID))
      throw Error("Exact launch member is required.");
    const { launch, original } = journal(req),
      retained = launch.read();
    if (retained) {
      const snapshot = deps.operationSnapshot?.(retained.operationID, retained.operationRunID);
      if (
        ((lifecycle || v.operationRunID !== undefined) &&
          v.operationRunID !== retained.operationRunID) ||
        (obj(snapshot) && snapshot.stopRequested)
      )
        throw Error("This fleet launch changed or is stopping.");
      if (
        !lifecycle &&
        (
          deps
            .document(
              `mining-finish:${launchScope(original, retained.operationID, retained.operationRunID)}`,
            )
            .read() as any
        )?.attempts?.length
      )
        throw Error("Retained FINISH owns this generation; original Start cannot continue.");
    }
    return { body: { ok: true, receipt: launch.dispatch(v.characterID) } };
  });
  const refuse: BackendRoute = wrap((req) => {
    const v = req.body;
    if (!obj(v) || !Number.isSafeInteger(v.characterID) || !text(v.operationRunID))
      throw Error("Exact hosted refusal is required.");
    return {
      body: {
        ok: true,
        receipt: journal(req).launch.refuse(v.operationRunID, v.characterID, {
          code: v.code,
          status: v.status,
          message: v.message,
        }),
      },
    };
  });
  const accept: BackendRoute = wrap((req) => {
    const v = req.body;
    if (!obj(v) || !Number.isSafeInteger(v.characterID) || !text(v.botID))
      throw Error("Exact hosted run receipt is required.");
    const { launch } = journal(req),
      retained = launch.read();
    if (
      (lifecycle || v.operationRunID !== undefined) &&
      v.operationRunID !== retained?.operationRunID
    )
      throw Error("The original fleet launch changed.");
    return { body: { ok: true, receipt: launch.accept(v.characterID, v.botID) } };
  });
  const relocate: BackendRoute = wrap(async (req) => {
    const identity = scope(req),
      id = req.params.operationID ?? "",
      definition = store(identity).get(id),
      body = req.body;
    if (
      !definition ||
      !obj(body) ||
      !text(body.operationRunID) ||
      !text(body.claimKey) ||
      !Number.isSafeInteger(body.claimGeneration)
    )
      throw Error("An exact current target and operation run are required.");
    const physical = physicalState(identity, id),
      claim = physical.snapshot?.claim;
    if (
      physical.state !== "ACTIVE" ||
      physical.receipt?.operationRunID !== body.operationRunID ||
      claim?.key !== body.claimKey ||
      claim.generation !== body.claimGeneration
    )
      throw Error("The operation target changed or its current custody is unavailable.");
    if (!deps.relocate) throw Error("Native next-target selection is unavailable.");
    const accepted = await deps.relocate({
      operationID: id,
      operationRunID: body.operationRunID,
      claimKey: body.claimKey,
      claimGeneration: body.claimGeneration,
    });
    if (!accepted) throw Error("Relocation was not admitted for this exact target generation.");
    return { status: 202, body: { ...payload(identity), relocation: "REQUESTED" } };
  });
  const recoveryContext = (req: BackendRequest) => {
    const identity = scope(req),
      id = req.params.operationID ?? "",
      { launch, original } = journal(req),
      receipt = launch.read();
    if (!receipt) throw Error("No retained launch exists for this saved operation.");
    const key = launchScope(original, id, receipt.operationRunID);
    const saved = deps.document(`mining-launch-setup:${key}`).read();
    const document = deps.document(`mining-finish:${key}`);
    const snapshot = physicalState(identity, id).snapshot;
    const completedMembers = receipt.members
      .filter(
        (m) =>
          snapshot?.settled?.includes(m.characterID) &&
          (snapshot?.parked?.includes(m.characterID) || snapshot?.stayed?.includes(m.characterID)),
      )
      .map((m) => m.characterID);
    const setup = deps.retainedSetup?.(id, receipt.operationRunID) as FleetSetup | null | undefined;
    const pendingUnload = retainedStopUnload(snapshot as OperationRecord | null, setup ?? null);
    if (lifecycle && !pendingUnload) throw Error("This Stop has no retained home unload to retry.");
    const observeOfflineParking =
      !lifecycle &&
      setup?.parking?.mode !== "RETURN_HOME_UNLOAD_DOCK" &&
      snapshot?.stopFreight === "RETURN_HOME" &&
      snapshot?.state !== "STOPPED" &&
      snapshot?.state !== "READY" &&
      !snapshot?.relocation;
    return {
      receipt,
      document,
      review: {
        ...retainedMiningRecovery(receipt, saved, setup, document),
        completedMembers,
        observeOfflineParking,
        ...(lifecycle && pendingUnload ? { stopUnload: pendingUnload } : {}),
      },
    };
  };
  const recovery: BackendRoute = wrap((req) => ({
    body: { ok: true, recovery: recoveryContext(req).review },
  }));
  const finishDispatch: BackendRoute = wrap((req) => {
    const { receipt, review, document } = recoveryContext(req),
      v = req.body;
    if (
      !obj(v) ||
      v.recoveryHash !== review.recoveryHash ||
      (lifecycle && !review.stopUnload?.characterIDs.includes(v.characterID)) ||
      (deps.canFinish
        ? !deps.canFinish(review.operationID, review.operationRunID, v.characterID)
        : deps.isOperationActive?.(review.operationID) !== false)
    )
      throw Error("Stop existing controllers before acquiring retained FINISH authority.");
    dispatchFinish(review, document, v.characterID, v.beforeIDs, v.retry);
    deps.authorizeFinish?.(receipt);
    return { body: { ok: true, recovery: recoveryContext(req).review } };
  });
  const finishAccept: BackendRoute = wrap((req) => {
    const { receipt, review, document } = recoveryContext(req),
      v = req.body;
    if (!obj(v) || v.recoveryHash !== review.recoveryHash)
      throw Error("Retained recovery identity changed.");
    acceptFinish(review, document, v.characterID, v.botID, v.dispatchedAt);
    return { body: { ok: true, recovery: recoveryContext(req).review } };
  });
  const finishFinalize: BackendRoute = wrap(async (req: BackendRequest) => {
    const { receipt, review } = recoveryContext(req),
      v = req.body;
    if (
      !obj(v) ||
      v.recoveryHash !== review.recoveryHash ||
      !deps.finalizeRetainedStop ||
      deps.isOperationActive?.(review.operationID) !== false
    )
      throw Error("Retained Stop still needs member settlement or release.");
    if (
      review.observeOfflineParking
        ? !req.pilotObservations
        : review.members.some(
            (m) => m.status !== "PREPARED" && !review.completedMembers.includes(m.characterID),
          )
    )
      throw Error(
        "Retained Stop needs current account-owned dock and offline observations or existing settlement records.",
      );
    deps.authorizeFinish?.(receipt);
    if (
      !(await deps.finalizeRetainedStop(
        { operationID: review.operationID, operationRunID: review.operationRunID },
        review.observeOfflineParking ? req.pilotObservations : undefined,
      ))
    )
      throw Error(
        "All member parking proofs are retained. The original target or freight still needs reconciliation.",
      );
    return { body: { ok: true, state: "STOPPED" } };
  });
  const stop: BackendRoute = wrap((req) => {
    const body = req.body;
    if (
      !obj(body) ||
      !text(body.operationRunID) ||
      (body.mode !== "RETURN_HOME" && body.mode !== "COLLECT_FREIGHT") ||
      !deps.requestStop
    )
      throw Error("The exact operation generation and Stop choice are required.");
    const receipt = journal(req).launch.read(),
      id = req.params.operationID!;
    if (!receipt && lifecycle && deps.isOperationActive?.(id) === false) {
      const previous = deps.operationSnapshot?.(id, body.operationRunID);
      if (
        obj(previous) &&
        previous.operationID === id &&
        previous.runID === body.operationRunID &&
        previous.stopRequested === true &&
        (previous.stopFreight === "RETURN_HOME" || previous.stopFreight === "COLLECT_FREIGHT")
      )
        return { status: 202, body: { ok: true, mode: previous.stopFreight, live: false } };
    }
    if (!receipt || receipt.operationRunID !== body.operationRunID)
      throw Error("The exact operation generation and Stop choice are required.");
    if (!lifecycle && !deps.isOperationActive?.(receipt.operationID))
      deps.authorizeFinish?.(receipt);
    const result = deps.requestStop(
      { operationID: receipt.operationID, operationRunID: receipt.operationRunID },
      body.mode,
      receipt,
    );
    if (lifecycle && !result.live) {
      const snapshot = deps.operationSnapshot?.(
        id,
        receipt.operationRunID,
      ) as OperationRecord | null;
      const pendingUnload = stopUnload(receipt, snapshot);
      if (pendingUnload)
        return {
          status: 202,
          body: { ok: true, mode: "RETURN_HOME", live: false, finishAtHome: true },
        };
    }
    return {
      status: 202,
      body: { ok: true, ...result, ...(lifecycle ? { mode: result.mode ?? body.mode } : {}) },
    };
  });
  const readJournal: BackendRoute = wrap((req) => ({
    body: { ok: true, receipt: journal(req).launch.read() },
  }));
  const routes = {
    "POST /mining-targets/mark-safe": markSafe,
    "POST /mining-targets/reset-depleted": resetDepleted,
    "POST /mining-operations/:operationID/stop": stop,
    "POST /mining-operations/:operationID/relocate": relocate,
    "GET /mining-operations": list,
    "POST /mining-operations": save,
    "GET /mining-operations/:operationID/delivery-receipts": readDeliveryReceipts,
    "POST /mining-operations/:operationID/delete": remove,
    "GET /mining-operations/:operationID/launch-plan": plan,
    "POST /mining-operations/:operationID/launch-plan": plan,
    "POST /mining-operations/:operationID/launch/begin": begin,
    "POST /mining-operations/:operationID/launch/dispatch": dispatch,
    "POST /mining-operations/:operationID/launch/accept": accept,
    "POST /mining-operations/:operationID/launch/refuse": refuse,
    "GET /mining-operations/:operationID/launch": readJournal,
  };
  const oldRoutes = {
    "GET /mining-operations/:operationID/recovery": recovery,
    "POST /mining-operations/:operationID/recovery/finalize": finishFinalize,
    "POST /mining-operations/:operationID/recovery/dispatch": finishDispatch,
    "POST /mining-operations/:operationID/recovery/accept": finishAccept,
  };
  return lifecycle
    ? {
        ...routes,
        "POST /mining-operations/observe": wrap(observeLifecycle),
        "POST /mining-operations/:operationID/launch/end": finishLaunch,
        ...(deps.authorizeFinish ? oldRoutes : {}),
      }
    : { ...routes, ...oldRoutes };
}
export const miningOperationRoutes = createMiningOperationRoutes(
  { document: (name) => defaultStorage().document(name) },
  {
    documentNames: (prefix) => defaultStorage().documentNames(prefix),
    transaction: (action) => defaultStorage().transaction(action),
    deleteDocuments: (names, prefixes) => defaultStorage().deleteDocuments(names, prefixes),
  },
);
