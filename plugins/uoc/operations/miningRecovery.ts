import { createHash } from "node:crypto";
import { sameJsonValue } from "../shared/value.ts";
import type { FleetLaunchReceipt } from "./miningLaunchJournal.ts";
import type { SyncDocument } from "./miningStore.ts";
import type { retainedStopUnload } from "../miningFleet/finishParking.ts";

export type FinishAttempt = {
  characterID: number;
  accountName: string;
  beforeIDs: string[];
  dispatchedAt: number;
  botID: string | null;
};
export type StopUnload = NonNullable<ReturnType<typeof retainedStopUnload>>;
export type UnverifiedMiningStop = {
  operationRunID: string;
  closedAt: number;
  unconfirmedDeliveries: number;
  unverifiedPilots: readonly number[];
};
export type MiningRecovery = {
  operationID: string;
  operationRunID: string;
  setupHash: string;
  recoveryHash: string;
  members: FleetLaunchReceipt["members"];
  attempts: FinishAttempt[];
  completedMembers?: readonly number[];
  observeOfflineParking?: boolean;
  stopUnload?: StopUnload;
};
export const setupHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Retained authority is pinned to the original launch, never the editor's current intent. */
export function retainedMiningRecovery(
  receipt: FleetLaunchReceipt,
  savedSetup: unknown,
  nativeSetup: unknown,
  document: SyncDocument,
): MiningRecovery {
  const setup = savedSetup ?? nativeSetup;
  if (
    !setup ||
    setupHash(setup) !== receipt.setupHash ||
    !nativeSetup ||
    !sameJsonValue(setup, nativeSetup)
  )
    throw Error(
      "The original launch setup cannot be verified against the retained native generation. No recovery login is allowed.",
    );
  const raw = document.read() as {
    version: number;
    setupHash: string;
    attempts: FinishAttempt[];
    priorAttempts?: FinishAttempt[];
  } | null;
  if (
    raw !== null &&
    (raw.version !== 1 ||
      raw.setupHash !== receipt.setupHash ||
      !Array.isArray(raw.attempts) ||
      new Set(raw.attempts.map((x) => x.characterID)).size !== raw.attempts.length ||
      raw.attempts.some(
        (a) =>
          !receipt.members.some(
            (m) => m.characterID === a.characterID && m.accountName === a.accountName,
          ) ||
          !Array.isArray(a.beforeIDs) ||
          a.beforeIDs.some((id) => typeof id !== "string") ||
          !Number.isFinite(a.dispatchedAt) ||
          !(a.botID === null || (typeof a.botID === "string" && a.botID.length > 0)),
      ))
  )
    throw Error("The retained FINISH dispatch journal requires reconciliation.");
  return {
    operationID: receipt.operationID,
    operationRunID: receipt.operationRunID,
    setupHash: receipt.setupHash,
    recoveryHash: setupHash([
      receipt.operationID,
      receipt.operationRunID,
      receipt.setupHash,
      receipt.members,
    ]),
    members: receipt.members,
    attempts: raw?.attempts ?? [],
  };
}

export function dispatchFinish(
  review: MiningRecovery,
  document: SyncDocument,
  characterID: number,
  beforeIDs: unknown,
  retry?: unknown,
): FinishAttempt {
  const member = review.members.find((m) => m.characterID === characterID),
    prior = review.attempts.find((a) => a.characterID === characterID);
  const reference = retry as { dispatchedAt?: unknown; botID?: unknown } | null | undefined;
  if (
    !member ||
    member.status === "PREPARED" ||
    review.completedMembers?.includes(characterID) ||
    (prior
      ? !reference ||
        reference.dispatchedAt !== prior.dispatchedAt ||
        reference.botID !== prior.botID
      : reference != null) ||
    !Array.isArray(beforeIDs) ||
    beforeIDs.some((x) => typeof x !== "string" || !x) ||
    new Set(beforeIDs).size !== beforeIDs.length
  )
    throw Error(
      "FINISH dispatch differs from the retained attempt, or the original member authority is unavailable.",
    );
  const saved = document.read() as { priorAttempts?: FinishAttempt[] } | null;
  const attempt = {
    characterID,
    accountName: member.accountName,
    beforeIDs,
    dispatchedAt: Math.max(Date.now(), (prior?.dispatchedAt ?? 0) + 1),
    botID: null,
  };
  document.write({
    version: 1,
    setupHash: review.setupHash,
    attempts: [...review.attempts.filter((a) => a.characterID !== characterID), attempt],
    ...(prior || saved?.priorAttempts
      ? { priorAttempts: [...(saved?.priorAttempts ?? []), ...(prior ? [prior] : [])] }
      : {}),
  });
  return attempt;
}

export function acceptFinish(
  review: MiningRecovery,
  document: SyncDocument,
  characterID: number,
  botID: unknown,
  dispatchedAt?: unknown,
) {
  const attempt = review.attempts.find((a) => a.characterID === characterID);
  const saved = document.read() as { priorAttempts?: FinishAttempt[] } | null;
  if (
    !attempt ||
    attempt.botID !== null ||
    typeof botID !== "string" ||
    !botID ||
    attempt.beforeIDs.includes(botID) ||
    ((dispatchedAt !== undefined ||
      saved?.priorAttempts?.some((a) => a.characterID === characterID)) &&
      dispatchedAt !== attempt.dispatchedAt) ||
    review.attempts.some((a) => a.botID === botID) ||
    saved?.priorAttempts?.some((a) => a.botID === botID)
  )
    throw Error("FINISH receipt does not match its original dispatch.");
  document.write({
    version: 1,
    setupHash: review.setupHash,
    attempts: review.attempts.map((a) => (a === attempt ? { ...a, botID } : a)),
    ...(saved?.priorAttempts ? { priorAttempts: saved.priorAttempts } : {}),
  });
}
