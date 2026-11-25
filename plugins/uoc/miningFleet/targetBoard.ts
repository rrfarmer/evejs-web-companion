/** One backend process owns this authority; storage commits synchronously before grants are returned. */
export type BeltTarget = {
  readonly kind: "BELT";
  readonly systemID: number;
  readonly name: string;
};
export type Target =
  | BeltTarget
  | {
      readonly kind: "ORE_ANOMALY" | "ICE";
      readonly systemID: number;
      readonly name: string;
      readonly siteID: number;
      readonly instanceID: number | null;
      readonly position: { readonly x: number; readonly y: number; readonly z: number };
    };
export interface Claim {
  readonly key: string;
  readonly operationID: string;
  readonly runID: string;
  readonly generation: number;
  readonly expiresAt: number;
}
type State = "AVAILABLE" | "RESERVED" | "ACTIVE" | "DRAINING" | "DEPLETED" | "QUARANTINED";
type EmptyGrid = { source: "checked-empty-grid"; key: string; observedAt: number };
interface Entry {
  target: Target;
  state: State;
  claim: Claim | null;
  quarantinedClaim?: Claim;
  depletion: unknown | null;
}
interface TargetDanger {
  readonly target: Target;
  readonly operationID: string;
  readonly runID: string;
  readonly lostAt: number;
  readonly cleared?: true;
}
type StoredDanger = TargetDanger | (Omit<TargetDanger, "target"> & { readonly belt: BeltTarget });
interface Board {
  version: 1;
  generation: number;
  entries: Record<string, Entry>;
  danger?: Record<string, StoredDanger>;
}
export interface SynchronousStore {
  read(): unknown | null;
  write(value: unknown): void;
}
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const clone = <T>(v: T): T => structuredClone(v);
export function targetKey(target: Target): string {
  if (!target || !id(target.systemID) || typeof target.name !== "string" || !target.name.trim())
    throw new Error("Invalid mining target.");
  if (target.kind === "BELT") return `BELT:${target.systemID}:${target.name.trim()}`;
  if (
    (target.kind !== "ORE_ANOMALY" && target.kind !== "ICE") ||
    !id(target.siteID) ||
    (target.instanceID !== null && !id(target.instanceID)) ||
    !target.position ||
    ![target.position.x, target.position.y, target.position.z].every(Number.isFinite)
  )
    throw new Error("Site identity or position is unknown.");
  return `${target.kind}:${target.systemID}:site:${target.siteID}:instance:${target.instanceID ?? target.siteID}`;
}
const equal = (a: Claim | null, b: Claim) =>
  !!a &&
  a.key === b.key &&
  a.operationID === b.operationID &&
  a.runID === b.runID &&
  a.generation === b.generation;
export function createTargetBoard(
  store: SynchronousStore,
  now: () => number = Date.now,
  leaseMs = 30_000,
  releaseExpired: (claim: Claim) => boolean = () => false,
) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid claim lease.");
  const existing = store.read();
  let state: Board;
  if (existing === null) state = { version: 1, generation: 0, entries: {} };
  else {
    const x = existing as Board;
    if (
      !x ||
      x.version !== 1 ||
      !Number.isSafeInteger(x.generation) ||
      x.generation < 0 ||
      !x.entries ||
      typeof x.entries !== "object" ||
      Array.isArray(x.entries)
    )
      throw new Error("Invalid target board.");
    for (const [key, e] of Object.entries(x.entries)) {
      if (
        !e ||
        targetKey(e.target) !== key ||
        !["AVAILABLE", "RESERVED", "ACTIVE", "DRAINING", "DEPLETED", "QUARANTINED"].includes(
          e.state,
        ) ||
        (e.claim !== null &&
          (!e.claim ||
            e.claim.key !== key ||
            !e.claim.operationID ||
            !e.claim.runID ||
            !id(e.claim.generation) ||
            !Number.isFinite(e.claim.expiresAt)))
      )
        throw new Error("Invalid target claim record.");
      if (
        e.state === "AVAILABLE" &&
        (e.target.kind !== "BELT" || e.claim !== null || e.depletion !== null)
      )
        throw Error("Invalid restored belt record.");
      if (
        e.quarantinedClaim !== undefined &&
        (e.state !== "QUARANTINED" ||
          e.claim !== null ||
          e.quarantinedClaim.key !== key ||
          !e.quarantinedClaim.operationID ||
          !e.quarantinedClaim.runID ||
          !id(e.quarantinedClaim.generation) ||
          e.quarantinedClaim.generation > x.generation)
      )
        throw Error("Quarantined owner proof is invalid.");
    }
    state = clone(x);
  }
  function commit(next: Board) {
    store.write(clone(next));
    state = next;
  }
  function markDangerous(evidence: Omit<TargetDanger, "cleared">): boolean {
    const key = targetKey(evidence.target),
      previous = state.danger?.[key];
    if (
      !evidence.operationID ||
      !evidence.runID ||
      !id(evidence.lostAt) ||
      evidence.lostAt > now() ||
      (previous?.lostAt ?? 0) >= evidence.lostAt
    )
      return false;
    commit({ ...state, danger: { ...state.danger, [key]: clone(evidence) } });
    return true;
  }
  function isDangerous(key: string): boolean {
    const mark = state.danger?.[key];
    return !!mark && !mark.cleared;
  }
  function markSafe(key: string): boolean {
    if (!isDangerous(key)) return false;
    commit({
      ...state,
      danger: { ...state.danger, [key]: { ...state.danger![key]!, cleared: true } },
    });
    return true;
  }
  function dangerousTargets() {
    return clone(
      Object.values(state.danger ?? {})
        .filter((mark) => !mark.cleared)
        .map((mark) => ("target" in mark ? mark.target : mark.belt)),
    );
  }
  function current(key: string) {
    const original = state.entries[key];
    if (!original) return null;
    const expired = original.claim ?? original.quarantinedClaim;
    if (expired && expired.expiresAt <= now()) {
      const clear =
        original.state === "RESERVED" || (original.depletion === null && releaseExpired(expired));
      if (original.state === "QUARANTINED" && !clear) return original;
      const next = clone(state),
        entry = next.entries[key]!;
      if (clear) delete next.entries[key];
      else {
        entry.quarantinedClaim = clone(expired);
        entry.state = "QUARANTINED";
        entry.claim = null;
      }
      commit(next);
      return next.entries[key] ?? null;
    }
    return original;
  }
  function retains(claim: Claim): boolean {
    const row = state.entries[claim.key];
    return !!row && equal(row.claim ?? row.quarantinedClaim ?? null, claim);
  }
  function read(key: string) {
    const v = current(key);
    return v ? clone(v) : null;
  }
  // A visited belt is eligible again only after a positive native observation.
  function availableForRelocation(key: string, visited: boolean) {
    const entry = current(key);
    return !isDangerous(key) && (entry?.state === "AVAILABLE" || (!entry && !visited));
  }
  function reopenDepletedBelt(key: string) {
    const entry = state.entries[key];
    if (
      entry?.target.kind !== "BELT" ||
      entry.state !== "DEPLETED" ||
      entry.claim !== null ||
      entry.quarantinedClaim
    )
      return false;
    commit({
      ...state,
      entries: { ...state.entries, [key]: { ...entry, state: "AVAILABLE", depletion: null } },
    });
    return true;
  }
  function resetDepletedBelt(key: string) {
    return !isDangerous(key) && reopenDepletedBelt(key);
  }
  function observeRestoredBelt(target: BeltTarget, observedAt: number) {
    const key = targetKey(target),
      empty = state.entries[key]?.depletion as EmptyGrid | null | undefined,
      at = now();
    if (
      empty?.source !== "checked-empty-grid" ||
      empty.key !== key ||
      !Number.isFinite(empty.observedAt) ||
      !Number.isFinite(observedAt) ||
      observedAt <= empty.observedAt ||
      observedAt > at ||
      at - observedAt > 15000
    )
      return false;
    return reopenDepletedBelt(key);
  }
  function reserve(operationID: string, runID: string, target: Target): Claim | null {
    if (!operationID || !runID) throw new Error("Invalid operation authority.");
    const key = targetKey(target),
      old = current(key);
    if (isDangerous(key)) return null;
    if (old && old.state !== "AVAILABLE") {
      if (old.claim?.operationID === operationID && old.claim.runID === runID)
        return clone(old.claim);
      return null;
    }
    if (state.generation === Number.MAX_SAFE_INTEGER) throw new Error("Claim sequence exhausted.");
    const generation = state.generation + 1,
      claim = { key, operationID, runID, generation, expiresAt: now() + leaseMs };
    if (!Number.isFinite(claim.expiresAt)) throw new Error("Invalid claim clock.");
    const next = clone(state);
    next.generation = generation;
    next.entries[key] = { target: clone(target), state: "RESERVED", claim, depletion: null };
    commit(next);
    return clone(claim);
  }
  function mutate(claim: Claim, fn: (e: Entry, next: Board) => void): boolean {
    const existing = current(claim.key);
    if (!existing || !equal(existing.claim, claim)) return false;
    const next = clone(state),
      e = next.entries[claim.key]!;
    fn(e, next);
    commit(next);
    return true;
  }
  function heartbeat(claim: Claim): Claim | null {
    let renewed: Claim | null = null;
    if (
      !mutate(claim, (e) => {
        e.claim = { ...e.claim!, expiresAt: now() + leaseMs };
        renewed = clone(e.claim);
      })
    )
      return null;
    return renewed;
  }
  /** Renew a crashed runtime's exact ACTIVE lease. A different generation cannot take this path. */
  function resumeActive(claim: Claim): Claim | null {
    const old = state.entries[claim.key];
    if (
      !old ||
      !(
        (old.state === "ACTIVE" && equal(old.claim, claim)) ||
        (old.state === "QUARANTINED" && equal(old.quarantinedClaim ?? null, claim))
      )
    )
      return null;
    const next = clone(state),
      entry = next.entries[claim.key]!;
    entry.state = "ACTIVE";
    entry.claim = { ...claim, expiresAt: now() + leaseMs };
    delete entry.quarantinedClaim;
    commit(next);
    return clone(entry.claim);
  }
  /** Restore only an unchanged retained owner for freight settlement, never productive mining. */
  function resumeDraining(claim: Claim): Claim | null {
    const old = state.entries[claim.key];
    if (
      !old ||
      !(
        (equal(old.claim, claim) && ["ACTIVE", "DRAINING"].includes(old.state)) ||
        (old.state === "QUARANTINED" && equal(old.quarantinedClaim ?? null, claim))
      )
    )
      return null;
    const next = clone(state),
      entry = next.entries[claim.key]!;
    entry.state = "DRAINING";
    entry.claim = { ...claim, expiresAt: now() + leaseMs };
    delete entry.quarantinedClaim;
    commit(next);
    return clone(entry.claim);
  }
  function activate(claim: Claim): boolean {
    return mutate(claim, (e) => {
      if (e.state !== "RESERVED" && e.state !== "ACTIVE")
        throw new Error("Target is not activeable.");
      e.state = "ACTIVE";
    });
  }
  function drain(claim: Claim): boolean {
    return mutate(claim, (e) => {
      if (e.state !== "ACTIVE" && e.state !== "DRAINING")
        throw new Error("Only an active target can drain.");
      e.state = "DRAINING";
    });
  }
  const provesEmpty = (claim: Claim, evidence: unknown): evidence is EmptyGrid => {
    const e = evidence as EmptyGrid | null;
    return (
      e?.source === "checked-empty-grid" &&
      e.key === claim.key &&
      Number.isFinite(e.observedAt) &&
      e.observedAt <= now()
    );
  };
  function noteDepletion(claim: Claim, evidence: EmptyGrid): boolean {
    if (!provesEmpty(claim, evidence) || now() - evidence.observedAt > 15000) return false;
    return mutate(claim, (e) => {
      if (e.state !== "ACTIVE") throw Error("Target is not active.");
      e.depletion = clone(evidence);
    });
  }
  function finish(claim: Claim, evidence: EmptyGrid | undefined, freightSettled: boolean): boolean {
    const proof = evidence ?? current(claim.key)?.depletion;
    if (
      !freightSettled ||
      !provesEmpty(claim, proof) ||
      (evidence && now() - proof.observedAt > 15000)
    )
      return false;
    return mutate(claim, (e) => {
      if (e.state !== "DRAINING") throw new Error("Target is not draining.");
      e.state = "DEPLETED";
      e.claim = null;
      e.depletion = clone(proof);
    });
  }
  function releaseDrained(
    claim: Claim,
    proof: {
      allMembersParked?: boolean;
      allMembersSettledInPlace?: boolean;
      freightSettled: boolean;
    },
  ): boolean {
    if (
      (proof.allMembersParked === true) === (proof.allMembersSettledInPlace === true) ||
      proof.freightSettled !== true
    )
      return false;
    return mutate(claim, (e, next) => {
      if (e.state !== "DRAINING") throw new Error("Target is not drained.");
      delete next.entries[claim.key];
    });
  }
  function releaseReserved(claim: Claim): boolean {
    return mutate(claim, (e, next) => {
      if (e.state !== "RESERVED") throw new Error("Active target requires reconciliation.");
      delete next.entries[claim.key];
    });
  }
  function releaseGeneration(operationID: string, runID: string) {
    const owned = Object.keys(state.entries).filter((key) => {
      const entry = state.entries[key]!,
        claim = entry.claim ?? entry.quarantinedClaim;
      return claim?.operationID === operationID && claim.runID === runID;
    });
    if (!owned.length) return;
    const next = clone(state);
    for (const key of owned) {
      const entry = next.entries[key]!,
        claim = entry.claim ?? entry.quarantinedClaim!;
      if (provesEmpty(claim, entry.depletion))
        next.entries[key] = {
          target: entry.target,
          state: "DEPLETED",
          claim: null,
          depletion: entry.depletion,
        };
      else delete next.entries[key];
    }
    commit(next);
  }
  return {
    read,
    retains,
    markDangerous,
    markSafe,
    resetDepletedBelt,
    isDangerous,
    dangerousTargets,
    snapshot: () => {
      for (const key of Object.keys(state.entries)) current(key);
      return clone(state.entries);
    },
    observeRestoredBelt,
    availableForRelocation,
    reserve,
    heartbeat,
    resumeActive,
    resumeDraining,
    activate,
    drain,
    noteDepletion,
    finish,
    releaseDrained,
    releaseReserved,
    releaseGeneration,
  };
}
