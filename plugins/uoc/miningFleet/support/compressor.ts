import type { SynchronousStore } from "../targetBoard.ts";
import type { ModuleObservation } from "../../shared/moduleObservation.ts";
export type CompressorIdentity = {
  operationID: string;
  runID: string;
  botID: string;
  sessionGeneration: number;
  characterID: number;
  shipID: number;
  moduleID: number;
  typeID: number;
  effectID: number;
};
export type CompressorObservation = {
  identity: CompressorIdentity;
  module: ModuleObservation;
  observedAt: number;
};
type Mutation = {
  issuedAt: number;
  acknowledged: boolean;
  error: string | null;
  before: CompressorObservation;
  notDispatched?: true;
};
/** Only the local pre-dispatch gate may construct this outcome. */
export class CompressorNotDispatched extends Error {}
type Cycle = {
  activation: Mutation | null;
  active: CompressorObservation | null;
  shutdown: Mutation | null;
  inactive: CompressorObservation | null;
};
type State = {
  version: 1;
  identity: CompressorIdentity;
  current: Cycle | null;
  history: Cycle[];
  lastInactive: CompressorObservation | null;
};
const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0,
  clone = <T>(x: T): T => structuredClone(x);
/** A single durable compressor intent; unknown activation and shutdown are never replayed. */
export function createCompressorController(config: {
  identity: CompressorIdentity;
  document: SynchronousStore;
  current: () => void;
  observe: () => Promise<CompressorObservation>;
  coreReady: () => Promise<boolean>;
  activate: () => Promise<unknown>;
  deactivate: () => Promise<unknown>;
  now?: () => number;
}) {
  const { identity, document, current } = config,
    now = config.now ?? Date.now,
    key = JSON.stringify(identity);
  if (
    !identity.operationID ||
    !identity.runID ||
    !identity.botID ||
    !Number.isSafeInteger(identity.sessionGeneration) ||
    identity.sessionGeneration < 0 ||
    ![
      identity.characterID,
      identity.shipID,
      identity.moduleID,
      identity.typeID,
      identity.effectID,
    ].every(positive)
  )
    throw Error("Compressor identity is invalid.");
  const validObs = (o: CompressorObservation) => {
    if (
      !o ||
      JSON.stringify(o.identity) !== key ||
      !Number.isFinite(o.observedAt) ||
      !o.module ||
      o.module.moduleID !== identity.moduleID ||
      o.module.typeID !== identity.typeID ||
      o.module.ownerID !== identity.characterID ||
      o.module.shipID !== identity.shipID ||
      !positive(o.module.flagID) ||
      typeof o.module.online !== "boolean" ||
      !Array.isArray(o.module.effects) ||
      !/^\d+$/.test(o.module.timeFiletime)
    )
      return false;
    const effects = o.module.effects.filter((e) => e.effectID === identity.effectID);
    return (
      effects.length <= 1 &&
      effects.every(
        (e) =>
          /^\d+$/.test(e.startFiletime) &&
          BigInt(e.startFiletime) <= BigInt(o.module.timeFiletime) &&
          Number.isFinite(e.durationMs) &&
          e.durationMs > 0,
      )
    );
  };
  const active = (o: CompressorObservation) =>
      o.module.effects.some((e) => e.effectID === identity.effectID),
    validMutation = (m: Mutation | null) =>
      m === null ||
      (!!m &&
        positive(m.issuedAt) &&
        typeof m.acknowledged === "boolean" &&
        (m.error === null || typeof m.error === "string") &&
        (m.notDispatched === undefined || (m.notDispatched === true && !m.acknowledged)) &&
        validObs(m.before)),
    validCycle = (v: Cycle) =>
      !!v &&
      validMutation(v.activation) &&
      validMutation(v.shutdown) &&
      (v.active === null || (validObs(v.active) && active(v.active))) &&
      (v.inactive === null || (validObs(v.inactive) && !active(v.inactive))) &&
      (!v.activation || !active(v.activation.before)) &&
      (!v.shutdown || active(v.shutdown.before)) &&
      (!v.inactive || !!v.active || !v.activation || v.activation.notDispatched === true);
  const stored = document.read() as State | null;
  let state: State;
  if (stored === null)
    state = {
      version: 1,
      identity: clone(identity),
      current: null,
      history: [],
      lastInactive: null,
    };
  else if (
    !stored ||
    stored.version !== 1 ||
    JSON.stringify(stored.identity) !== key ||
    !Array.isArray(stored.history) ||
    stored.history.some((v) => !validCycle(v) || !v.inactive) ||
    !(stored.current === null || validCycle(stored.current)) ||
    !(
      stored.lastInactive === null ||
      (validObs(stored.lastInactive) && !active(stored.lastInactive))
    )
  )
    throw Error("Compressor journal requires reconciliation.");
  else state = clone(stored);
  const save = (v: State) => {
    current();
    document.write(clone(v));
    state = clone(v);
  };
  const observe = async () => {
    current();
    const o = await config.observe();
    current();
    if (!validObs(o) || !o.module.online || o.observedAt > now() || now() - o.observedAt >= 60000)
      throw Error("Native compressor observation is unavailable.");
    return o;
  };
  async function reconcileInternal() {
    const cycle = state.current;
    if (!cycle) return clone(state);
    const o = await observe(),
      next = clone(state),
      v = next.current!;
    if (v.activation && !v.active && active(o) && o.observedAt >= v.activation.issuedAt) {
      const e = o.module.effects.find((e) => e.effectID === identity.effectID)!;
      if (BigInt(e.startFiletime) >= BigInt(v.activation.before.module.timeFiletime))
        v.active = clone(o);
    }
    if (
      v.active &&
      !v.inactive &&
      !active(o) &&
      o.observedAt >= (v.shutdown?.issuedAt ?? v.active.observedAt)
    ) {
      v.inactive = clone(o);
      next.lastInactive = clone(o);
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) save(next);
    return clone(state);
  }
  async function activateInternal() {
    await reconcileInternal();
    const prior = state.current;
    if (prior && (!prior.inactive || (!prior.active && !prior.activation?.notDispatched)))
      throw Error("Prior compressor outcome is unresolved; no replay.");
    const o = await observe();
    if (active(o) || !(await config.coreReady()))
      throw Error("Active native Core and inactive compressor are required.");
    current();
    const action: Mutation = {
        issuedAt: now(),
        acknowledged: false,
        error: null,
        before: clone(o),
      },
      cycle: Cycle = { activation: action, active: null, shutdown: null, inactive: null };
    save({
      ...state,
      history: prior ? [...state.history, prior] : state.history,
      current: cycle,
      lastInactive: null,
    });
    current();
    try {
      await config.activate();
      current();
      const next = clone(state);
      next.current!.activation!.acknowledged = true;
      save(next);
    } catch (error) {
      current();
      const next = clone(state);
      next.current!.activation!.error = error instanceof Error ? error.message : String(error);
      if (error instanceof CompressorNotDispatched) next.current!.activation!.notDispatched = true;
      save(next);
    }
    return clone(state);
  }
  async function settleInternal() {
    await reconcileInternal();
    const cycle = state.current;
    if (cycle?.activation && !cycle.active && !cycle.activation.notDispatched)
      throw Error("Compressor activation remains unresolved; no replay.");
    if (cycle?.inactive || cycle?.shutdown) return clone(state);
    const o = await observe();
    if (!active(o)) {
      const next = clone(state);
      next.lastInactive = clone(o);
      if (next.current) next.current.inactive = clone(o);
      save(next);
      return clone(state);
    }
    const next = clone(state),
      owned = next.current ?? {
        activation: null,
        active: clone(o),
        shutdown: null,
        inactive: null,
      };
    owned.shutdown = { issuedAt: now(), acknowledged: false, error: null, before: clone(o) };
    next.current = owned;
    save(next);
    current();
    try {
      await config.deactivate();
      current();
      const result = clone(state);
      result.current!.shutdown!.acknowledged = true;
      save(result);
    } catch (error) {
      current();
      const result = clone(state);
      result.current!.shutdown!.error = error instanceof Error ? error.message : String(error);
      save(result);
    }
    return clone(state);
  }
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>) => {
    const p = tail.then(f);
    tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  };
  return {
    snapshot: () => clone(state),
    observe,
    activate: () => serial(activateInternal),
    settle: () => serial(settleInternal),
    reconcile: () => serial(reconcileInternal),
  };
}
