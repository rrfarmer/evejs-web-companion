/** A durable attempt belongs to the one original AddTarget and exact mission resource. */
export type MiningLockIdentity = Readonly<{
  characterID: number;
  shipID: number;
  moduleID: number;
  targetID: number;
  mission: string;
  lockOrdinal: number;
  lockIssuedAt: number;
}>;
export type MiningActivationAttempt = Readonly<
  MiningLockIdentity & { ordinal: number; issuedAt: number }
>;
export type MiningActivationRefusal = Readonly<
  MiningActivationAttempt & { outcome: "TARGET_NOT_LOCKED"; observedAt: number }
>;
export type MiningActivationDeps<T> = {
  current(): void;
  savePending(attempt: MiningActivationAttempt): void | Promise<void>;
  saveRefusal(refusal: MiningActivationRefusal): void | Promise<void>;
  native(moduleID: number, opts: { targetID: number; repeat: 0 }): Promise<T>;
  wait(ms: number): Promise<void>;
  now?(): number;
  confirmLock?(): Promise<boolean>;
  /** Initial next attempt ordinal from durable parent state. */
  nextOrdinal: number;
};
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const message = "That target is not locked.";
/** Native AddTarget maps TARGET_NOT_FOUND to this definite pre-lock refusal. */
export function targetGoneRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as any;
  return (
    e.code === "CALL_REFUSED" && e.status === 409 && e.refusal?.key === "TargetingAttemptCancelled"
  );
}
/** Only this exact native CustomNotify establishes that Activate was refused before mining effects. */
export function targetNotLockedRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as any,
    v = e.refusal?.values;
  if (
    e.code !== "CALL_REFUSED" ||
    e.status !== 409 ||
    e.message !== message ||
    e.refusal?.key !== "CustomNotify" ||
    v?.type !== "dict" ||
    !Array.isArray(v.entries)
  )
    return false;
  const notices = v.entries.filter(
    (entry: unknown) => Array.isArray(entry) && entry[0] === "notify",
  );
  return notices.length === 1 && notices[0][1] === message;
}
/**
 * The result is only a native acknowledgement, never proof of yield or module state.
 * Every attempt must be independently recorded before it is sent; a transport or
 * post-ACK read error stays pending. No AddTarget is issued here.
 */
export async function activateDuringOriginalLock<T>(
  identity: MiningLockIdentity,
  deps: MiningActivationDeps<T>,
): Promise<{ attempt: MiningActivationAttempt; result: T }> {
  if (
    ![
      identity.characterID,
      identity.shipID,
      identity.moduleID,
      identity.targetID,
      identity.lockOrdinal,
      deps.nextOrdinal,
    ].every(positive) ||
    typeof identity.mission !== "string" ||
    !identity.mission ||
    !Number.isSafeInteger(identity.lockIssuedAt) ||
    identity.lockIssuedAt < 0
  )
    throw Error("Mining activation identity is incomplete.");
  const own = Object.freeze({ ...identity }),
    now = deps.now ?? Date.now,
    deadline = own.lockIssuedAt + 200_000,
    interval = 2000;
  if (!Number.isSafeInteger(deadline)) throw Error("Mining lock deadline is invalid.");
  // Also bound the number of attempts if a supplied test clock or wait does not advance.
  for (let offset = 0; offset <= 100; offset++) {
    deps.current();
    const issuedAt = now();
    if (!Number.isFinite(issuedAt) || (issuedAt >= deadline && !(await deps.confirmLock?.())))
      throw Error("Original native target lock was not confirmed within its bounded window.");
    const ordinal = deps.nextOrdinal + offset;
    if (!positive(ordinal)) throw Error("Mining activation ordinal is invalid.");
    const attempt = Object.freeze({ ...own, ordinal, issuedAt });
    await deps.savePending(attempt);
    deps.current();
    let result: T;
    try {
      result = await deps.native(own.moduleID, { targetID: own.targetID, repeat: 0 });
    } catch (error) {
      if (!targetNotLockedRefusal(error)) throw error;
      deps.current();
      await deps.saveRefusal(
        Object.freeze({ ...attempt, outcome: "TARGET_NOT_LOCKED", observedAt: now() }),
      );
      deps.current();
      const remaining = deadline - now();
      if (remaining <= 0 && (await deps.confirmLock?.())) continue;
      if (remaining <= 0)
        throw Error("Original native target lock was not confirmed within its bounded window.");
      await deps.wait(Math.min(interval, remaining));
      deps.current();
      continue;
    }
    deps.current();
    return { attempt, result };
  }
  throw Error("Original native target lock was not confirmed within its bounded window.");
}
