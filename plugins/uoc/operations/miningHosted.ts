import { currentExecutorGaps } from "./miningCapabilities.ts";
import { inspectedMiningReadiness, pendingMiningReadiness } from "./miningReadiness.ts";
import type { MiningOperationLaunchPlan } from "../restored/app/apiTypes.ts";
import { sameJsonValue } from "../shared/value.ts";
import type { SavedDefinition } from "./miningStore.ts";
import {
  bindFleetDefinition,
  fleetStartupPreparation,
  type FleetInspection,
  type VerifiedParking,
} from "./miningBind.ts";
import type { FleetDelivery } from "../miningFleet/delivery.ts";
import type { FleetSetup } from "../miningFleet/runtime.ts";
import { confirmedFleetStartFailure, type FleetLaunchReceipt } from "./miningLaunchJournal.ts";
import { MAX_SHIFT_MINUTES, MINING_STOP_WINDOW_MINUTES } from "../miningFleet/shiftTiming.ts";
import { sharedPlayerCorporation } from "../restored/mining/miningSetup.ts";
export type FleetKind = "mcc-miner" | "mcc-hauler" | "mcc-command" | "mcc-defender";
export type CheckedFleetMember = {
  characterID: number;
  accountName: string;
  role: "MINER" | "HAULER" | "COMMAND" | "DEFENDER";
  kind: FleetKind;
  policy: unknown;
};
export type ReviewedFleet = {
  definition: SavedDefinition;
  setup: FleetSetup;
  planHash: string;
  members: CheckedFleetMember[];
  inspectionBotIDs: readonly string[];
  inspectionObservedAt: readonly number[];
  inspections: readonly FleetInspection[];
  launchPlan: MiningOperationLaunchPlan;
};
export type FleetLaunchCatalogue = Pick<FleetInspection, "belts" | "canCapacityM3">;
export interface FleetHostServices {
  readDefinition(id: string): Promise<SavedDefinition>;
  inspect(
    member: SavedDefinition["members"][number],
    definition: SavedDefinition,
    operationRunID: string,
  ): Promise<{ botID: string; readout: FleetInspection }>;
  planMember?(
    member: SavedDefinition["members"][number],
    definition: SavedDefinition,
    operationRunID: string,
    catalogue: FleetLaunchCatalogue,
  ): Promise<FleetInspection>;
  catalogue?(definition: SavedDefinition, operationRunID: string): Promise<FleetLaunchCatalogue>;
  board(): Promise<{
    available: boolean;
    targets: readonly { targetKey: string; state: string }[];
  }>;
  delivery?(d: SavedDefinition): Promise<FleetDelivery>;
  parking(d: SavedDefinition): Promise<VerifiedParking | undefined>;
  confirmMoves(
    moves: readonly { characterID: number; shipID: number; fromFleetID: number }[],
    members: SavedDefinition["members"],
  ): Promise<boolean>;
  check(
    member: SavedDefinition["members"][number],
    kind: FleetKind,
    setup: FleetSetup,
  ): Promise<{ setup: unknown; policy: unknown }>;
  review(
    d: SavedDefinition,
    setup: FleetSetup,
  ): Promise<{ planHash: string; candidateSupported: boolean }>;
  before(member: CheckedFleetMember): Promise<readonly string[]>;
  journal(
    operationID: string,
    command: "begin" | "dispatch" | "accept" | "refuse" | "read",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<FleetLaunchReceipt | null>;
  start(
    member: CheckedFleetMember,
    setup: FleetSetup,
    minutes: number,
  ): Promise<{ botID: string; characterID: number; kind: string }>;
  current(
    member: CheckedFleetMember,
    signal?: AbortSignal,
  ): Promise<
    readonly {
      botID: string;
      characterID: number;
      operationID: string;
      operationRunID: string;
      purpose?: string | null;
    }[]
  >;
  stop(member: CheckedFleetMember, botID: string): Promise<void>;
  isSettled?(
    operationID: string,
    operationRunID: string,
    characterID: number,
    botID: string | null,
  ): Promise<boolean>;
  finishLaunch?(operationID: string, operationRunID: string): Promise<void>;
}
const kind = (role: string): FleetKind =>
  role === "MINER"
    ? "mcc-miner"
    : role === "HAULER"
      ? "mcc-hauler"
      : role === "DEFENDER"
        ? "mcc-defender"
        : "mcc-command";
function sameDefinition(a: SavedDefinition, b: SavedDefinition) {
  return (
    a.operationID === b.operationID &&
    a.revision === b.revision &&
    JSON.stringify(a) === JSON.stringify(b)
  );
}
// Browser Start uses the shared HTTP lanes. Keep one lane for Stop and owner reads.
const FLEET_CONNECT_LIMIT = 3;
async function connectMembers<T, R>(members: readonly T[], work: (member: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FLEET_CONNECT_LIMIT, members.length) }, async () => {
      for (let i = next++; i < members.length; i = next++) {
        try {
          results[i] = { status: "fulfilled", value: await work(members[i]!) };
        } catch (reason) {
          results[i] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}
// Start can already own the pilot while the HTTP result is still pending.
// One scoped owner read can settle that Start without issuing it again.
const START_OWNER_READ_MS = 10_000;
async function startBotID(
  reply: Promise<string>,
  readOwner: (signal: AbortSignal) => Promise<string | null>,
): Promise<string> {
  let pendingRead: Promise<string | null> | undefined;
  const observe = () =>
    (pendingRead ??= readOwner(AbortSignal.timeout(START_OWNER_READ_MS))
      .catch(() => null)
      .finally(() => {
        pendingRead = undefined;
      }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owner = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => resolve(observe()), START_OWNER_READ_MS);
  });
  try {
    const first = await Promise.race([reply, owner]);
    return first ?? (await reply);
  } catch (error) {
    if (confirmedFleetStartFailure(error)) throw error;
    const observed = await observe();
    if (observed) return observed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
/** Performs actual held-pilot inspection and each host's check before returning a review. */
export function createMiningFleetHost(s: FleetHostServices) {
  async function prepare(
    id: string,
    operationRunID: string,
    forStart = false,
  ): Promise<ReviewedFleet> {
    const definition = await s.readDefinition(id);
    const gaps = currentExecutorGaps(definition);
    if (gaps.length) throw Error(gaps.join(" "));
    if (
      new Set(definition.members.map((m) => m.accountName.toLowerCase())).size !==
      definition.members.length
    )
      throw Error("Choose a distinct authorized account for each fleet member.");
    const catalogue = forStart ? await s.catalogue?.(definition, operationRunID) : undefined;
    if (forStart && (!catalogue || !s.planMember))
      throw Error("The account-only fleet plan is unavailable.");
    const reads = await connectMembers(definition.members, async (m) =>
      catalogue
        ? { botID: null, readout: await s.planMember!(m, definition, operationRunID, catalogue) }
        : s.inspect(m, definition, operationRunID),
    );
    const ids = new Set<string>();
    const observations = reads.map((result, index) => {
      const m = definition.members[index]!;
      if (result.status === "rejected")
        throw Error(
          (m.characterName || m.accountName) +
            ": " +
            (result.reason instanceof Error ? result.reason.message : String(result.reason)),
        );
      const { botID, readout } = result.value;
      if (readout.characterID !== m.characterID || (!catalogue && (!botID || ids.has(botID))))
        throw Error("Fleet pilot identity is ambiguous.");
      if (botID) ids.add(botID);
      return readout;
    });
    const firstMiner = definition.members.find((m) => m.role === "MINER");
    if (!firstMiner) throw Error("The operation has no mining leader.");
    const leader = observations.find((x) => x.characterID === firstMiner.characterID)!;
    let beltID: number | undefined;
    if (definition.area.targetClasses[0] === "BELT") {
      const board = await s.board();
      if (!board.available)
        throw Error("The current target board is unavailable; no free belt is inferred.");
      const occupied = new Set(
        board.targets.filter((t) => t.state !== "AVAILABLE").map((t) => t.targetKey),
      );
      const candidates = leader.belts
        .filter(
          (b) =>
            Number.isSafeInteger(b.itemID) &&
            b.itemID > 0 &&
            typeof b.name === "string" &&
            b.name.trim() &&
            !occupied.has(`BELT:${definition.area.anchorSystemID}:${b.name.trim()}`),
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.itemID - b.itemID);
      if (!candidates.length) throw Error("No currently unclaimed inspected belt is available.");
      beltID = candidates[0]!.itemID;
    }
    const [parking, delivery] = await Promise.all([
        s.parking(definition),
        s.delivery?.(definition),
      ]),
      candidate = bindFleetDefinition(definition, observations, {
        operationRunID,
        beltID,
        parking,
        delivery,
        deferFleetObservation: forStart,
      });
    if (
      candidate.requiredMoves.length &&
      !(await s.confirmMoves(candidate.requiredMoves, definition.members))
    )
      throw Error("The named selected-pilot fleet moves were not approved.");
    const supplySource = definition.preparation?.source;
    const supplyCorporation =
      supplySource?.kind === "corp" && supplySource.corporationID === undefined
        ? sharedPlayerCorporation(
            definition.members
              .filter((member) => member.preparation?.fittingID)
              .map(
                (member) =>
                  observations.find((row) => row.characterID === member.characterID)
                    ?.corporationID ?? null,
              ),
          )
        : null;
    const startup = {
      ...candidate.setup,
      startupPreparation: fleetStartupPreparation(definition, supplyCorporation ?? undefined),
    };
    const checks = new Map<FleetKind, ReturnType<FleetHostServices["check"]>>();
    const members = await Promise.all(
      definition.members.map(async (m): Promise<CheckedFleetMember> => {
        if (
          m.role !== "MINER" &&
          m.role !== "HAULER" &&
          m.role !== "COMMAND" &&
          m.role !== "DEFENDER"
        )
          throw Error("The saved role is not connected.");
        const k = kind(m.role);
        let check = checks.get(k);
        if (!check) {
          check = s.check(m, k, startup);
          checks.set(k, check);
        }
        const checked = await check;
        if (!sameJsonValue(checked.setup, startup) || !checked.policy)
          throw Error("The checked fleet setup differs from the reviewed setup.");
        return {
          characterID: m.characterID,
          accountName: m.accountName,
          role: m.role,
          kind: k,
          policy: checked.policy,
        };
      }),
    );
    const setup = (await checks.get(members[0]!.kind)!).setup as FleetSetup;
    const server = await s.review(definition, setup);
    if (!server.candidateSupported || !server.planHash)
      throw Error("The saved operation cannot be represented by the current fleet executor.");
    const waiting =
      "Pilot identity, equipment and supplies are checked in each pilot's Bot Host session before fleet departure.";
    return {
      definition,
      setup,
      planHash: server.planHash,
      members,
      inspectionBotIDs: [...ids],
      inspectionObservedAt: observations.map((x) => x.observedAt),
      inspections: observations,
      launchPlan: {
        planHash: server.planHash,
        members: members.map((m) => ({
          characterID: m.characterID,
          routineMode: "STANDARD",
          pluginRun: m.kind,
        })),
        preparation: forStart
          ? pendingMiningReadiness(definition, waiting)
          : inspectedMiningReadiness(definition, observations, setup),
        warnings: [waiting],
      },
    };
  }
  /** A failed/unknown dispatched Start is deliberately retained and never replayed. */
  async function start(
    review: ReviewedFleet,
    minutes: number,
    cancel?: AbortSignal,
    maxRuntimeMinutes = MAX_SHIFT_MINUTES,
  ) {
    if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > maxRuntimeMinutes)
      throw Error("A valid reviewed runtime is required.");
    const existing = await s.journal(review.definition.operationID, "read");
    const retained = existing?.operationRunID === review.setup.operationRunID ? existing : null;
    const now = Date.now();
    if (
      review.inspectionObservedAt.length !== review.members.length ||
      review.inspectionObservedAt.some((t) => !Number.isFinite(t) || t > now || now - t > 1800000)
    )
      throw Error("Fleet inspections are stale; review them again before Start.");
    if (!sameDefinition(review.definition, await s.readDefinition(review.definition.operationID)))
      throw Error("The saved operation changed after review.");
    const grantMinutes = Math.min(minutes + MINING_STOP_WINDOW_MINUTES, maxRuntimeMinutes);
    if (cancel?.aborted) return null;
    const { setup, planHash } = review,
      failures = new Map<number, string>();
    const checked = await connectMembers(review.members, async (m) => {
      const prior = retained?.members.find((row) => row.characterID === m.characterID);
      let beforeIDs = prior?.beforeIDs ?? [];
      if (!prior || prior.status === "PREPARED")
        try {
          const currentIDs = await s.before(m);
          beforeIDs = prior?.beforeIDs ?? currentIDs;
        } catch (error) {
          failures.set(m.characterID, error instanceof Error ? error.message : String(error));
        }
      return {
        characterID: m.characterID,
        accountName: m.accountName,
        role: m.role,
        kind: m.kind,
        beforeIDs,
        ...(failures.has(m.characterID)
          ? { refusal: (failures.get(m.characterID) || "Hosted preflight failed.").slice(0, 200) }
          : {}),
      };
    });
    const members = checked.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    if (cancel?.aborted) return null;
    if (
      retained &&
      (retained.planHash !== planHash || retained.revision !== review.definition.revision)
    )
      throw Error("The original fleet review changed; the retained Start cannot be retried.");
    const launch =
      retained ??
      (await s.journal(review.definition.operationID, "begin", {
        revision: review.definition.revision,
        planHash,
        setup,
        members,
        durationMinutes: minutes,
      }));
    if (!launch || launch.operationRunID !== setup.operationRunID)
      throw Error("The exact fleet launch receipt is unavailable.");
    const accepted = new Map<CheckedFleetMember, string>(),
      stopRequests = new Map<CheckedFleetMember, Promise<string | null>>();
    const stopAccepted = () => {
      for (const [member, botID] of accepted)
        if (!stopRequests.has(member))
          stopRequests.set(
            member,
            s.stop(member, botID).then(
              () => null,
              (error) => (error instanceof Error ? error.message : String(error)),
            ),
          );
    };
    cancel?.addEventListener("abort", stopAccepted, { once: true });
    try {
      const results = await connectMembers(review.members, async (m) => {
        if (cancel?.aborted) return;
        const id = launch.operationID,
          operationRunID = launch.operationRunID,
          characterID = m.characterID;
        const row = launch.members.find((p) => p.characterID === characterID);
        if (!row) throw Error("The pilot is missing from the retained launch.");
        const matchingOwner = async (signal?: AbortSignal) => {
          const owners = (await s.current(m, signal)).filter(
            (x) =>
              x.characterID === characterID &&
              x.operationID === id &&
              x.operationRunID === operationRunID &&
              !x.purpose &&
              !row.beforeIDs.includes(x.botID),
          );
          return owners.length === 1 ? owners[0]!.botID || null : null;
        };
        const accept = async (botID: string) => {
          accepted.set(m, botID);
          if (cancel?.aborted) stopAccepted();
          // A lost journal response must release the launch slot. The recorded dispatch is still never replayed.
          await s.journal(
            id,
            "accept",
            { characterID, operationRunID, botID },
            AbortSignal.timeout(15_000),
          );
        };
        const preflight = failures.get(characterID);
        if (preflight) throw Error(preflight);
        if (row.status === "ACCEPTED") {
          accepted.set(m, row.botID!);
          if (cancel?.aborted) stopAccepted();
          return;
        }
        if (row.status === "DISPATCHED") {
          const botID = await matchingOwner();
          if (!botID)
            throw Error("The previous fleet Start remains unconfirmed; no new Start was sent.");
          return accept(botID);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (cancel?.aborted) return;
          await s.journal(id, "dispatch", { characterID, operationRunID });
          let botID: string;
          try {
            const reply = s.start(m, setup, grantMinutes).then((result) => {
              if (!result.botID || result.characterID !== characterID || result.kind !== m.kind)
                throw Error("Hosted Start receipt is ambiguous; its dispatch remains retained.");
              return result.botID;
            });
            botID = await startBotID(reply, matchingOwner);
          } catch (error) {
            if (!confirmedFleetStartFailure(error)) throw error;
            const evidence = error as { code: string; status: number; message?: string };
            await s.journal(id, "refuse", {
              characterID,
              operationRunID,
              code: evidence.code,
              status: evidence.status,
              message: evidence.message ?? evidence.code,
            });
            if (attempt || !["BOT_GRANT_STALE", "BOT_GRANT_EXPIRED"].includes(evidence.code))
              throw error;
            continue;
          }
          return accept(botID);
        }
      });
      const issues = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              (review.definition.members[index]?.characterName ||
                review.members[index]!.accountName) +
                ": " +
                (result.reason instanceof Error ? result.reason.message : String(result.reason)),
            ]
          : [],
      );
      if (cancel?.aborted) {
        for (const issue of await Promise.all(stopRequests.values())) if (issue) issues.push(issue);
      }
      if (issues.length) throw Error(issues.join(" "));
    } finally {
      cancel?.removeEventListener("abort", stopAccepted);
      // An interrupted request can leave the launch open only until its dispatch window expires.
      await s.finishLaunch?.(launch.operationID, launch.operationRunID).catch(() => {});
    }
    return s.journal(review.definition.operationID, "read");
  }
  async function stop(
    operationID: string,
    onRequested?: (characterID: number) => void,
    expectedRunID?: string,
  ) {
    const receipt = await s.journal(operationID, "read");
    if (!receipt && expectedRunID) return null;
    if (!receipt || receipt.operationID !== operationID)
      throw Error("No exact fleet launch receipt is available.");
    if (expectedRunID && receipt.operationRunID !== expectedRunID)
      throw Error("The selected fleet generation changed.");
    const outcomes = await Promise.all(
      receipt.members.map(async (m) => {
        if (m.status === "PREPARED") return null;
        // Stop belongs to the launch roster. The editor may already describe a future fleet.
        const checked: CheckedFleetMember = {
          characterID: m.characterID,
          accountName: m.accountName,
          role: m.role,
          kind: m.kind,
          policy: null,
        };
        try {
          const rows = await s.current(checked);
          const scoped = rows.filter(
            (x) =>
              x.characterID === m.characterID &&
              x.operationID === operationID &&
              x.operationRunID === receipt.operationRunID,
          );
          const matches = scoped.filter(
            (x) =>
              x.purpose !== "mcc-finish" &&
              (m.botID ? x.botID === m.botID : !m.beforeIDs.includes(x.botID)),
          );
          // FINISH already holds this pilot for the same retained generation. Retry
          // it in place without adopting its ID as the original Start receipt.
          if (
            m.status === "ACCEPTED" &&
            matches.length === 0 &&
            scoped.length === 1 &&
            scoped[0]!.purpose === "mcc-finish"
          ) {
            await s.stop(checked, scoped[0]!.botID);
            onRequested?.(m.characterID);
            return null;
          }
          if (
            matches.length === 0 &&
            (await s.isSettled?.(operationID, receipt.operationRunID, m.characterID, m.botID))
          )
            return null;
          if (matches.length !== 1)
            throw Error("The current hosted controller for this pilot is unavailable.");
          const botID = matches[0]!.botID;
          if (m.status === "DISPATCHED")
            await s.journal(operationID, "accept", {
              characterID: m.characterID,
              operationRunID: receipt.operationRunID,
              botID,
            });
          await s.stop(checked, botID);
          onRequested?.(m.characterID);
          return null;
        } catch (error) {
          return (
            "Pilot " +
            m.characterID +
            ": " +
            (error instanceof Error ? error.message : String(error))
          );
        }
      }),
    );
    const issues = outcomes.filter(Boolean);
    if (issues.length) throw Error(issues.join(" "));
    return receipt;
  }
  return { prepare, start, stop };
}
