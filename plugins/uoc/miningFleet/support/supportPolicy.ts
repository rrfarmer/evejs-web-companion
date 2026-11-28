export type SupportLossPolicy = "PAUSE" | "CONTINUE_UNSUPPORTED" | "STOP";
export type SupportPolicy = {
  readonly maintainBursts: boolean;
  readonly useIndustrialCore: boolean;
  readonly coreRequirement: "continueWithoutCore" | "requireCore";
  readonly enableCompression: boolean;
  readonly selfMining: boolean;
  readonly tractor: boolean;
  readonly collection: "TRACTOR_ONLY" | "TRACTOR_AND_COLLECT";
  readonly compressCollectedOre: boolean;
  readonly supportLoss: SupportLossPolicy;
};
export type SupportObservation = {
  readonly state: "READY" | "DEGRADED" | "RECOVERY" | "BLOCKED";
  readonly core: "active" | "inactive" | "unknown";
  readonly reason: string | null;
  readonly fresh: boolean;
};
export type SupportDecision = {
  readonly mode: "NORMAL" | "PAUSE" | "FALLBACK" | "STOP";
  readonly reason: string | null;
  readonly lostSinceMs: number | null;
  readonly permitNewMining: boolean;
  readonly requestParkingStop: boolean;
};
/** Policy only: existing native controllers still own all qualification, physical effects and mutation fences. */
export function decideSupportPolicy(
  policy: SupportPolicy | null,
  observation: SupportObservation | null,
  lostSinceMs: number | null,
  nowMs: number,
): SupportDecision {
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    !(
      lostSinceMs === null ||
      (Number.isFinite(lostSinceMs) && lostSinceMs >= 0 && lostSinceMs <= nowMs)
    )
  )
    throw Error("Support recovery clock is invalid.");
  if (!policy)
    return {
      mode: "NORMAL",
      reason: null,
      lostSinceMs: null,
      permitNewMining: true,
      requestParkingStop: false,
    };
  if (
    !["PAUSE", "CONTINUE_UNSUPPORTED", "STOP"].includes(policy.supportLoss) ||
    !["continueWithoutCore", "requireCore"].includes(policy.coreRequirement) ||
    !["TRACTOR_ONLY", "TRACTOR_AND_COLLECT"].includes(policy.collection) ||
    [
      policy.maintainBursts,
      policy.useIndustrialCore,
      policy.enableCompression,
      policy.selfMining,
      policy.tractor,
      policy.compressCollectedOre,
    ].some((v) => typeof v !== "boolean")
  )
    throw Error("Support policy is invalid.");
  if (
    observation &&
    (!["READY", "DEGRADED", "RECOVERY", "BLOCKED"].includes(observation.state) ||
      !["active", "inactive", "unknown"].includes(observation.core) ||
      typeof observation.fresh !== "boolean" ||
      !(observation.reason === null || typeof observation.reason === "string"))
  )
    throw Error("Support observation is invalid.");
  if (policy.coreRequirement === "requireCore" && !policy.useIndustrialCore)
    throw Error("Required Core must be enabled.");
  if (policy.collection === "TRACTOR_AND_COLLECT" && !policy.tractor)
    throw Error("Collection requires tractor custody.");
  if (
    policy.compressCollectedOre &&
    (!policy.enableCompression || policy.collection !== "TRACTOR_AND_COLLECT")
  )
    throw Error("Collected compression requires collection and compression service.");
  const usable =
    !!observation &&
    observation.fresh === true &&
    ["READY", "DEGRADED"].includes(observation.state) &&
    (policy.coreRequirement !== "requireCore" || observation.core === "active");
  if (usable)
    return {
      mode: "NORMAL",
      reason: observation!.state === "DEGRADED" ? observation!.reason : null,
      lostSinceMs: null,
      permitNewMining: true,
      requestParkingStop: false,
    };
  const since = lostSinceMs ?? nowMs,
    reason = observation?.fresh
      ? observation.reason || "support-not-ready"
      : "support-observation-unavailable";
  if (nowMs - since < 30000)
    return {
      mode: "PAUSE",
      reason: `RECOVERY: ${reason}`,
      lostSinceMs: since,
      permitNewMining: false,
      requestParkingStop: false,
    };
  const mode = policy.supportLoss === "CONTINUE_UNSUPPORTED" ? "FALLBACK" : policy.supportLoss;
  return {
    mode,
    reason,
    lostSinceMs: since,
    permitNewMining: mode === "FALLBACK",
    requestParkingStop: mode === "STOP",
  };
}

export function missingCommandEquipment(
  policy: SupportPolicy | undefined,
  command:
    | {
        moduleID?: number;
        bursts?: readonly unknown[];
        core?: unknown;
        compressor?: unknown;
        tractor?: unknown;
      }
    | undefined,
): string[] {
  if (!policy) return [];
  const missing: string[] = [];
  if (policy.maintainBursts && !command?.moduleID && !command?.bursts?.length)
    missing.push("Mining Foreman Burst");
  if (policy.useIndustrialCore && !command?.core) missing.push("Industrial Core");
  if (policy.enableCompression && !command?.compressor) missing.push("compressor");
  if (policy.tractor && !command?.tractor) missing.push("tractor");
  return missing;
}
