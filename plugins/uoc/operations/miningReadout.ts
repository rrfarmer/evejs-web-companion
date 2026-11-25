import type { FleetLaunchReceipt } from "./miningLaunchJournal.ts";
import type { FinishAttempt } from "./miningRecovery.ts";
import type { OfflineParking } from "../miningFleet/operation.ts";
export type RunOwner = {
  botID: string;
  characterID: number;
  operationID: string;
  operationRunID: string;
  purpose?: string | null;
};
export type HostedRow = {
  botID: string;
  characterID: number;
  kind: string;
  plugin?: { pluginID: string; run: string; readout?: unknown } | null;
  status: string;
  phase: string | null;
  why: string | null;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string | null;
  maxRuntimeMinutes?: number;
  resumedAt?: string | null;
};
type AccountRead = {
  owners: readonly RunOwner[];
  bots: readonly HostedRow[];
  offline?: boolean;
  online?: boolean;
  dockedForUnload?: boolean;
};
type PhysicalMember = {
  characterID: number;
  parkingState?: string | null;
  phase?: string | null;
  reason?: string | null;
  offlineParking?: OfflineParking;
};
const date = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** Exact current owners, native group settlement and independent offline release have different jobs. */
export function projectFleetRun(
  receipt: FleetLaunchReceipt,
  reads: ReadonlyMap<number, AccountRead | null>,
  attempts: readonly FinishAttempt[] = [],
  physicalState?: string,
  physicalMembers: readonly PhysicalMember[] = [],
) {
  let active = false,
    unresolved = false;
  const starts: number[] = [],
    ends: number[] = [];
  const members = receipt.members.map((m) => {
    const read = reads.get(m.characterID),
      unknown = (reason: string, botID = m.botID, phase: string | null = null) => {
        unresolved = true;
        return {
          characterID: m.characterID,
          runtimeState: "UNKNOWN",
          botID,
          hosted: false,
          phase,
          reason,
        };
      };
    if (m.status === "PREPARED")
      return {
        characterID: m.characterID,
        runtimeState: "NOT_STARTED",
        botID: null,
        hosted: false,
        phase: m.refusal ? "Hosted Start refused" : null,
        reason: m.refusal ?? "No Start was dispatched.",
      };
    if (!read) return unknown("Current account run state is unreadable.");
    const preparations = read.bots
      .filter(
        (b) =>
          b.characterID === m.characterID &&
          b.kind === "plugin" &&
          b.plugin?.pluginID === "uoc" &&
          b.plugin.run === "mcc-prepare" &&
          b.endedAt &&
          b.phase === "Mining member prepared",
      )
      .map((b) => b.plugin?.readout as any)
      .filter(
        (v) =>
          v?.characterID === m.characterID &&
          v.operationID === receipt.operationID &&
          v.operationRunID === receipt.operationRunID &&
          ["VERIFIED", "DEGRADED"].includes(v.state),
      )
      .sort((a, b) => b.observedAt - a.observedAt);
    const p = preparations[0],
      source = p?.source?.pin?.descriptor,
      preparation = p
        ? {
            ...p,
            role: m.role,
            sourceLabel:
              source?.kind === "corp"
                ? "Corporate division " + source.division
                : source?.kind === "hangar"
                  ? "Personal local hangar"
                  : "Supply source unverified",
          }
        : undefined;
    const original = read.bots.filter(
      (b) =>
        b.botID === m.botID &&
        b.characterID === m.characterID &&
        b.kind === "plugin" &&
        b.plugin?.pluginID === "uoc" &&
        b.plugin.run === m.kind,
    );
    for (const b of original) {
      const start = date(b.startedAt),
        end = date(b.endedAt);
      if (start !== null) starts.push(start);
      if (end !== null) ends.push(end);
    }
    const physical = physicalMembers.find((x) => x.characterID === m.characterID);
    const currentOwner =
      read.owners.some((o) => o.characterID === m.characterID) ||
      read.bots.some((b) => b.characterID === m.characterID && !b.endedAt);
    const docked = physical?.parkingState === "DOCK_VERIFIED",
      stayed = physical?.parkingState === "SETTLED_IN_PLACE";
    if ((docked || stayed || physicalState === "STOPPED") && read.offline === true && !currentOwner)
      return {
        characterID: m.characterID,
        runtimeState: "STOPPED",
        botID: m.botID,
        hosted: false,
        phase:
          physical?.offlineParking && !physical.offlineParking.atPlannedDock
            ? "Docked at " +
              physical.offlineParking.locationID +
              ", away from planned home. Offline release verified."
            : docked
              ? "Docking and offline release verified"
              : stayed
                ? "In-place settlement and offline release verified"
                : "Native settlement and offline release verified",
        reason: null,
        parkingState: "RELEASED",
        ...(preparation ? { preparation } : {}),
      };
    if (read.dockedForUnload && read.offline === true && !currentOwner) {
      const failure =
        physical?.phase === "Last FINISH: Fleet finish blocked" ? physical.reason : null;
      return {
        ...unknown(
          failure ?? "Verify the remaining cargo and finish unloading with Retry Stop.",
          null,
          "Docked at home · Unloading incomplete",
        ),
        dockedForUnload: true,
      };
    }
    const unresolvedOwner = (
      id: string | null,
      phase: string | null = null,
      why: string | null = null,
    ) => {
      const next =
        read.offline === true && !currentOwner
          ? "Pilot is offline."
          : read.online === true || currentOwner
            ? "Pilot is still online or has another current owner. The hosted operation is checked independently."
            : "No current hosted pilot status was confirmed.";
      const reason = physical?.reason ?? why;
      const detail = reason ? "Last report: " + reason + " " : "";
      return unknown(detail + next, id, physical?.phase ?? phase);
    };
    const attempt = attempts.find((a) => a.characterID === m.characterID);
    const retryOwners = read.owners.filter(
      (o) =>
        o.purpose === "mcc-finish" &&
        o.characterID === m.characterID &&
        o.operationID === receipt.operationID &&
        o.operationRunID === receipt.operationRunID,
    );
    if (retryOwners.length > 1) return unknown("Current FINISH owner is ambiguous.");
    const finish = !!attempt || !!retryOwners.length;
    const expected = retryOwners[0]?.botID ?? (attempt ? attempt.botID : m.botID);
    const owners = read.owners.filter(
      (o) =>
        o.characterID === m.characterID &&
        o.operationID === receipt.operationID &&
        o.operationRunID === receipt.operationRunID &&
        (expected ? o.botID === expected : !(attempt?.beforeIDs ?? m.beforeIDs).includes(o.botID)),
    );
    if (owners.length > 1) return unknown("Current run identity is ambiguous.");
    const id = expected ?? owners[0]?.botID ?? null,
      kind = finish ? "mcc-finish" : m.kind;
    const rows = read.bots.filter(
      (b) =>
        b.botID === id &&
        b.characterID === m.characterID &&
        b.kind === "plugin" &&
        b.plugin?.pluginID === "uoc" &&
        b.plugin.run === kind,
    );
    if (rows.length !== 1) return unresolvedOwner(id);
    const bot = rows[0]!;
    if (!bot.endedAt) {
      if (owners.length !== 1 || owners[0]!.botID !== bot.botID)
        return unresolvedOwner(bot.botID, bot.phase);
      active = true;
      const start = date(bot.startedAt);
      if (start !== null) starts.push(start);
      return {
        characterID: m.characterID,
        runtimeState: bot.status,
        botID: bot.botID,
        hosted: true,
        phase: bot.phase,
        reason: bot.why,
        parkingState: finish ? "RECONCILING" : undefined,
        expiresAt: bot.expiresAt,
        hostStartedAt: bot.startedAt,
        hostResumedAt: bot.resumedAt ?? null,
        maxRuntimeMinutes:
          Number.isSafeInteger(bot.maxRuntimeMinutes) && bot.maxRuntimeMinutes! > 0
            ? bot.maxRuntimeMinutes
            : null,
        lastHostReason: bot.why,
        ...(preparation ? { preparation } : {}),
      };
    }
    // Native STOPPED plus OFF is required in the real adapter. The legacy optional argument supports source consumers.
    if (
      physicalState !== undefined ||
      attempt ||
      m.status !== "ACCEPTED" ||
      bot.status !== "stopped" ||
      !["Docked", "Settled in place"].includes(bot.phase ?? "")
    )
      return unresolvedOwner(bot.botID, bot.phase, bot.why);
    return {
      characterID: m.characterID,
      runtimeState: "STOPPED",
      botID: bot.botID,
      hosted: false,
      phase: bot.phase,
      reason: bot.why,
      ...(preparation ? { preparation } : {}),
    };
  });
  const completed =
    members.length > 0 &&
    members.every(
      (m) =>
        m.runtimeState === "STOPPED" ||
        (physicalState === "STOPPED" && m.runtimeState === "NOT_STARTED"),
    );
  const preparationMembers = members.flatMap((m) =>
    "preparation" in m && m.preparation ? [m.preparation] : [],
  );
  return {
    state: completed ? "STOPPED" : active ? "RUNNING" : "UNKNOWN",
    recoveryRequired: unresolved,
    members,
    startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    stoppedAt: completed && ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    preparation: preparationMembers.length
      ? {
          state: preparationMembers.some((p) => p.state === "DEGRADED")
            ? ("DEGRADED" as const)
            : ("VERIFIED" as const),
          members: preparationMembers,
        }
      : undefined,
    stopFailures: members
      .filter(
        (m) =>
          !("dockedForUnload" in m && m.dockedForUnload) &&
          (m.runtimeState === "UNKNOWN" ||
            m.phase === "Stop needs attention" ||
            m.phase === "Fleet finish blocked"),
      )
      .map((m) => ({
        characterID: m.characterID,
        message: m.reason ?? "Native recovery remains unresolved.",
      })),
  };
}
