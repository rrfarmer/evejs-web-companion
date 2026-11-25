// WC74 web/src/app/miningOperationRunView.ts @ 213da333; imports adapted for UOC plugin.
import type { MiningOperationRuntime } from "../adapters/mining.ts";
import type { HostedRunPolicy } from "./hostedRunPolicy.ts";

const millis = (value?: string | null): number | null => {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : null;
};
const NO_EXTENSION = ["DRAFT", "ASSEMBLING", "STOPPING", "STOPPED", "PARKING", "PARKING_FAILED"];

/** Stored control-plane projection only. No browser clock, persistence or I/O.
 * All configured members are required in v1, including logistics. */
export function miningOperationRunView(
  runtime: MiningOperationRuntime,
  policy: HostedRunPolicy | null,
  parking: boolean,
) {
  const now = millis(runtime.observedAt);
  const hosted = runtime.members.filter((member) => member.hosted);
  const dated = hosted.filter((member) => millis(member.expiresAt) !== null);
  const expires = dated.length
    ? Math.min(...dated.map((member) => millis(member.expiresAt)!))
    : null;
  const latest = dated.length
    ? Math.max(...dated.map((member) => millis(member.expiresAt)!))
    : null;
  // Sequential acquisition can stagger otherwise identical grants slightly.
  // Never round the warning deadline; only suppress noise below five minutes.
  const grantMismatch = expires !== null && latest !== null && latest - expires >= 5 * 60_000;
  const remainingMs = expires !== null && now !== null ? Math.max(0, expires - now) : null;
  const groups = [...new Set(dated.map((member) => member.expiresAt!))].sort().map((expiresAt) => ({
    expiresAt,
    names: dated
      .filter((member) => member.expiresAt === expiresAt)
      .map((member) => member.characterName),
  }));
  const running = hosted.filter(
    (member) =>
      member.runtimeState === "running" && now !== null && (millis(member.expiresAt) ?? 0) > now,
  );
  const canExtend = runtime.extensionSupported !== false && !NO_EXTENSION.includes(runtime.state);
  const choices = canExtend
    ? (policy?.durationChoices ?? []).flatMap((minutes) => {
        const count = running.filter(
          (member) =>
            member.maxRuntimeMinutes != null &&
            member.maxRuntimeMinutes + minutes <= policy!.maxRuntimeMinutes,
        ).length;
        return count ? [{ minutes, count }] : [];
      })
    : [];
  const maximumReached =
    canExtend &&
    !!policy &&
    running.length > 0 &&
    running.every(
      (member) =>
        member.maxRuntimeMinutes != null && member.maxRuntimeMinutes >= policy.maxRuntimeMinutes,
    );
  // Warning window: 10% of the earliest grant, bounded to 5–30 minutes.
  const grantMinutes = dated
    .filter((member) => millis(member.expiresAt) === expires)
    .map((member) => member.maxRuntimeMinutes ?? 0);
  const soonMs = Math.min(30, Math.max(5, Math.min(...grantMinutes) * 0.1)) * 60_000;
  const warnings: string[] = [];
  if (runtime.extensionSupported === false && hosted.length)
    warnings.push(
      "The current WC host does not support extending these credentials in place. The configured run limit remains in force.",
    );
  const failed = runtime.members.filter((member) =>
    ["FAILED", "error"].includes(member.runtimeState),
  ).length;
  if (failed)
    warnings.push(`${failed} failed member(s); see member grants / recovery for details.`);
  if (hosted.length && hosted.length !== runtime.members.length)
    warnings.push(
      `${runtime.members.length - hosted.length} member(s) not hosted. See member grants / recovery for unavailable or fresh-start members.`,
    );
  if (hosted.some((member) => member.hostResumedAt) && !runtime.recoveryRequired)
    warnings.push("Recovered hosted member present; see member grants / recovery.");
  const capped = policy
    ? running.filter(
        (member) =>
          member.maxRuntimeMinutes != null && member.maxRuntimeMinutes >= policy.maxRuntimeMinutes,
      ).length
    : 0;
  if (capped && capped < running.length)
    warnings.push(`${capped} hosted member(s) at maximum runtime; extension can only be partial.`);
  if (dated.length !== hosted.length || (hosted.length && now === null))
    warnings.push("Hosted timing is incomplete; earliest expiry may be unknown.");
  if (remainingMs !== null && remainingMs <= soonMs) {
    warnings.push(
      remainingMs === 0
        ? "Hosted grant deadline reached; cleanup/status confirmation may still be pending."
        : "Grant expires soon.",
    );
    if (parking)
      warnings.push(
        "Parking must complete before the hosted grant expires. Remaining time does not guarantee arrival; no travel-time estimate is available.",
      );
  }
  return {
    hosted,
    groups,
    grantMismatch,
    latestExpiresAt: latest === null ? null : new Date(latest).toISOString(),
    remainingMs,
    expiresAt: expires === null ? null : new Date(expires).toISOString(),
    choices,
    maximumReached,
    canExtend,
    warnings,
  };
}

export function operationMemberRecovery(
  member: MiningOperationRuntime["members"][number],
  recovery: boolean,
  observedAt?: string,
): string {
  if (member.hosted) {
    if ((millis(member.expiresAt) ?? Infinity) <= (millis(observedAt) ?? -Infinity))
      return "Grant expired — hosted cleanup/status pending";
    if (member.parkingState === "RECONCILING")
      return "Retained FINISH owner — settlement and Parking";
    if (recovery)
      return "Recovered hosted member — waiting for a trusted target; scoped Stop required";
    return member.hostResumedAt ? "Recovered hosted member" : "Hosted member";
  }
  if (recovery && member.runtimeState === "DRAFT")
    return "DRAFT — requires fresh Start after recovered operation cleanup";
  if (member.runtimeState === "FAILED")
    return "Unavailable — not extended or automatically restarted";
  return member.runtimeState === "DRAFT" ? "DRAFT — not hosted" : "Not hosted";
}

export function operationTime(value?: string | null): string {
  return millis(value) === null
    ? "Unknown"
    : new Date(value!).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function operationRemaining(ms: number | null): string {
  if (ms === null) return "Unknown";
  if (ms > 0 && ms < 60_000) return "Less than 1 minute";
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
