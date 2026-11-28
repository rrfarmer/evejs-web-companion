import type { SynchronousStore } from "./targetBoard.ts";
import type { BurstObservation, OwnBurstObservation } from "./support/controller.ts";

export interface ProofMinerIdentity {
  readonly characterID: number;
  readonly shipID: number;
  readonly botID: string;
  readonly sessionGeneration: number;
}
export interface MiningProofQuote extends ProofMinerIdentity {
  readonly moduleID: number;
  readonly typeID: number;
  readonly family: "ore" | "ice";
  readonly cycleMs: number;
  readonly timeFiletime: string;
  readonly sceneSampledAtMs: number;
  readonly observedAt: number;
}
export interface CommandProofScope {
  readonly operationID: string;
  readonly runID: string;
  readonly commanderCharacterID: number;
  readonly commanderShipID: number;
  readonly commanderBotID: string;
  readonly commanderGeneration: number;
  readonly moduleID: number;
  readonly typeID: number;
  readonly claimKey: string;
  readonly claimGeneration: number;
  readonly miners: readonly ProofMinerIdentity[];
}
export interface CommandProofSample {
  readonly commander: BurstObservation;
  readonly miners: readonly (MiningProofQuote | null)[];
}
export interface CommandActivationReceipt {
  readonly intent: {
    readonly kind: "activate";
    readonly issuedAt: number;
    readonly acknowledged: boolean;
  };
  readonly after: OwnBurstObservation;
  readonly observedAt: number;
}
export interface CommandProofRow {
  readonly scope: CommandProofScope;
  readonly before: CommandProofSample;
  readonly after: CommandProofSample | null;
  readonly activation: CommandActivationReceipt | null;
  readonly status: "UNCONFIRMED" | "BENEFIT_OBSERVED";
  readonly recipientsConfirmed: readonly number[];
  readonly preparedAt: number;
  readonly closedAt: number | null;
  readonly priorActivationIDs: readonly number[];
  readonly inactiveObservedAt: number | null;
}
interface State {
  version: 1;
  identity: string;
  pending: CommandProofRow | null;
  history: CommandProofRow[];
}
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const clone = <T>(x: T): T => structuredClone(x);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const validMiner = (m: ProofMinerIdentity) =>
  !!m &&
  id(m.characterID) &&
  id(m.shipID) &&
  typeof m.botID === "string" &&
  !!m.botID &&
  Number.isSafeInteger(m.sessionGeneration) &&
  m.sessionGeneration >= 0;
function validScope(s: CommandProofScope) {
  return (
    !!s &&
    typeof s.operationID === "string" &&
    !!s.operationID &&
    typeof s.runID === "string" &&
    !!s.runID &&
    id(s.commanderCharacterID) &&
    id(s.commanderShipID) &&
    typeof s.commanderBotID === "string" &&
    !!s.commanderBotID &&
    Number.isSafeInteger(s.commanderGeneration) &&
    s.commanderGeneration >= 0 &&
    id(s.moduleID) &&
    id(s.typeID) &&
    typeof s.claimKey === "string" &&
    !!s.claimKey &&
    id(s.claimGeneration) &&
    Array.isArray(s.miners) &&
    s.miners.length > 0 &&
    s.miners.every(validMiner) &&
    new Set(s.miners.map((m) => m.characterID)).size === s.miners.length &&
    new Set(s.miners.map((m) => m.shipID)).size === s.miners.length &&
    !s.miners.some(
      (m) => m.characterID === s.commanderCharacterID || m.shipID === s.commanderShipID,
    )
  );
}
function validQuote(q: MiningProofQuote, who: ProofMinerIdentity, now: number) {
  return (
    validMiner(q) &&
    q.characterID === who.characterID &&
    q.shipID === who.shipID &&
    q.botID === who.botID &&
    q.sessionGeneration === who.sessionGeneration &&
    id(q.moduleID) &&
    id(q.typeID) &&
    ["ore", "ice"].includes(q.family) &&
    Number.isFinite(q.cycleMs) &&
    q.cycleMs > 0 &&
    typeof q.timeFiletime === "string" &&
    /^\d+$/.test(q.timeFiletime) &&
    Number.isFinite(q.sceneSampledAtMs) &&
    q.sceneSampledAtMs > 0 &&
    Number.isFinite(q.observedAt) &&
    q.observedAt > 0 &&
    q.observedAt <= now
  );
}
function validSample(sample: CommandProofSample, s: CommandProofScope, now: number) {
  const c = sample?.commander;
  if (
    !c ||
    c.characterID !== s.commanderCharacterID ||
    c.shipID !== s.commanderShipID ||
    c.moduleID !== s.moduleID ||
    c.typeID !== s.typeID ||
    !id(c.flagID) ||
    !id(c.effectID) ||
    !id(c.chargeTypeID) ||
    !(c.chargeItemID === null || id(c.chargeItemID)) ||
    !Number.isSafeInteger(c.chargeQuantity) ||
    c.chargeQuantity < 0 ||
    !Number.isFinite(c.cycleMs) ||
    c.cycleMs <= 0 ||
    !Number.isFinite(c.rangeMeters) ||
    c.rangeMeters <= 0 ||
    typeof c.online !== "boolean" ||
    typeof c.active !== "boolean" ||
    !Number.isFinite(c.observedAt) ||
    c.observedAt <= 0 ||
    c.observedAt > now ||
    !Array.isArray(c.recipients) ||
    c.recipients.length !== s.miners.length ||
    c.recipients.some(
      (r) =>
        !s.miners.some((m) => m.characterID === r.characterID && m.shipID === r.shipID) ||
        typeof r.inFleet !== "boolean" ||
        !Number.isFinite(r.distanceMeters) ||
        r.distanceMeters < 0 ||
        !Array.isArray(r.buffs) ||
        r.buffs.some(
          (b: { collectionID: number; value: number; expiresMs: number | null }) =>
            !id(b.collectionID) ||
            !Number.isFinite(b.value) ||
            !(b.expiresMs === null || Number.isFinite(b.expiresMs)),
        ),
    ) ||
    new Set(c.recipients.map((r) => r.characterID)).size !== s.miners.length ||
    !Array.isArray(c.effectCollections) ||
    c.effectCollections.some((x) => !id(x)) ||
    new Set(c.effectCollections).size !== c.effectCollections.length ||
    !Array.isArray(sample.miners) ||
    sample.miners.length !== s.miners.length
  )
    return false;
  return sample.miners.every((q, i) => q === null || validQuote(q, s.miners[i]!, now));
}
function validPair(before: CommandProofSample, after: CommandProofSample) {
  return (
    after.commander.observedAt >= before.commander.observedAt &&
    after.commander.effectID === before.commander.effectID &&
    after.commander.flagID === before.commander.flagID &&
    after.commander.chargeTypeID === before.commander.chargeTypeID &&
    equal(after.commander.effectCollections, before.commander.effectCollections) &&
    !after.miners.some(
      (q, i) =>
        q !== null &&
        before.miners[i] !== null &&
        (q.moduleID !== before.miners[i]!.moduleID ||
          q.typeID !== before.miners[i]!.typeID ||
          q.family !== before.miners[i]!.family ||
          q.observedAt < before.miners[i]!.observedAt ||
          q.sceneSampledAtMs < before.miners[i]!.sceneSampledAtMs ||
          BigInt(q.timeFiletime) < BigInt(before.miners[i]!.timeFiletime)),
    )
  );
}
function recent(sample: CommandProofSample, now: number) {
  return (
    now - sample.commander.observedAt <= 15000 &&
    sample.miners.every((q) => q === null || now - q.observedAt <= 15000)
  );
}
function benefitRecipients(
  before: BurstObservation,
  after: BurstObservation,
  activation: CommandActivationReceipt | null,
) {
  if (!activation || after.observedAt < activation.after.observedAt) return [];
  return after.recipients
    .filter(
      (r) =>
        r.inFleet &&
        r.distanceMeters <= after.rangeMeters &&
        r.buffs.some(
          (b) =>
            after.effectCollections.includes(b.collectionID) &&
            Number.isFinite(b.value) &&
            b.expiresMs !== null &&
            b.expiresMs > after.observedAt &&
            !before.recipients
              .find((x) => x.characterID === r.characterID && x.shipID === r.shipID)
              ?.buffs.some(
                (old) =>
                  old.collectionID === b.collectionID &&
                  old.value === b.value &&
                  old.expiresMs === b.expiresMs,
              ),
        ),
    )
    .map((r) => r.characterID);
}
function validReceipt(
  r: CommandActivationReceipt,
  s: CommandProofScope,
  preparedAt: number,
  now: number,
) {
  return (
    !!r &&
    r.intent?.kind === "activate" &&
    Number.isSafeInteger(r.intent.issuedAt) &&
    r.intent.issuedAt >= preparedAt &&
    typeof r.intent.acknowledged === "boolean" &&
    r.after?.characterID === s.commanderCharacterID &&
    r.after.shipID === s.commanderShipID &&
    r.after.moduleID === s.moduleID &&
    r.after.typeID === s.typeID &&
    r.after.active === true &&
    Number.isFinite(r.after.observedAt) &&
    r.after.observedAt >= r.intent.issuedAt &&
    Number.isFinite(r.observedAt) &&
    r.observedAt >= r.after.observedAt &&
    r.observedAt <= now
  );
}
/** Synchronous durable evidence only; native mutation fencing remains with the burst controller. */
export function createCommandProof(
  store: SynchronousStore,
  identity: string,
  now: () => number = Date.now,
) {
  if (!identity || !store || typeof store.read !== "function" || typeof store.write !== "function")
    throw Error("Command proof storage is invalid.");
  const raw = store.read() as State | null;
  const validRow = (r: CommandProofRow) => {
    if (
      !r ||
      !validScope(r.scope) ||
      JSON.stringify([
        r.scope.operationID,
        r.scope.runID,
        r.scope.commanderCharacterID,
        r.scope.commanderShipID,
        r.scope.moduleID,
        r.scope.typeID,
      ]) !== identity ||
      !Number.isFinite(r.preparedAt) ||
      r.preparedAt <= 0 ||
      !Array.isArray(r.priorActivationIDs) ||
      r.priorActivationIDs.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      new Set(r.priorActivationIDs).size !== r.priorActivationIDs.length ||
      !(
        r.inactiveObservedAt === null ||
        (Number.isFinite(r.inactiveObservedAt) && r.inactiveObservedAt >= r.preparedAt)
      ) ||
      !validSample(r.before, r.scope, now()) ||
      !(
        r.after === null ||
        (validSample(r.after, r.scope, now()) && validPair(r.before, r.after))
      ) ||
      !(
        r.activation === null ||
        (validReceipt(r.activation, r.scope, r.preparedAt, now()) &&
          r.activation.after.effectID === r.before.commander.effectID &&
          r.activation.after.flagID === r.before.commander.flagID &&
          !r.priorActivationIDs.includes(r.activation.intent.issuedAt))
      ) ||
      !["UNCONFIRMED", "BENEFIT_OBSERVED"].includes(r.status) ||
      !Array.isArray(r.recipientsConfirmed) ||
      !r.recipientsConfirmed.every(id) ||
      !(r.closedAt === null || (Number.isFinite(r.closedAt) && r.closedAt >= r.preparedAt))
    )
      return false;
    const confirmed = r.after
      ? benefitRecipients(r.before.commander, r.after.commander, r.activation).filter((x) =>
          r.scope.miners.some((m) => m.characterID === x),
        )
      : [];
    const status =
      confirmed.length === r.scope.miners.length &&
      r.after?.miners.every(Boolean) &&
      r.before.miners.every(Boolean)
        ? "BENEFIT_OBSERVED"
        : "UNCONFIRMED";
    return equal(confirmed, r.recipientsConfirmed) && r.status === status;
  };
  if (
    raw !== null &&
    (!raw ||
      raw.version !== 1 ||
      raw.identity !== identity ||
      !Array.isArray(raw.history) ||
      raw.history.length > 128 ||
      raw.history.some((r) => !validRow(r) || r.closedAt === null) ||
      !(raw.pending === null || (validRow(raw.pending) && raw.pending.closedAt === null)))
  )
    throw Error("Command proof journal is unreadable.");
  let state: State = raw ? clone(raw) : { version: 1, identity, pending: null, history: [] };
  const save = (next: State) => {
    store.write(clone(next));
    state = clone(next);
  };
  function prepare(
    scope: CommandProofScope,
    before: CommandProofSample,
    priorActivationIDs: readonly number[] = [],
  ) {
    const at = now();
    if (state.pending) throw Error("Previous command proof is unresolved; no new activation.");
    if (
      !validScope(scope) ||
      JSON.stringify([
        scope.operationID,
        scope.runID,
        scope.commanderCharacterID,
        scope.commanderShipID,
        scope.moduleID,
        scope.typeID,
      ]) !== identity ||
      !validSample(before, scope, at) ||
      !recent(before, at) ||
      before.commander.active ||
      !Array.isArray(priorActivationIDs) ||
      priorActivationIDs.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
      new Set(priorActivationIDs).size !== priorActivationIDs.length
    )
      throw Error("Before-burst proof scope or observations are invalid.");
    save({
      ...state,
      pending: {
        scope: clone(scope),
        before: clone(before),
        after: null,
        activation: null,
        status: "UNCONFIRMED",
        recipientsConfirmed: [],
        preparedAt: at,
        closedAt: null,
        priorActivationIDs: [...priorActivationIDs],
        inactiveObservedAt: null,
      },
    });
  }
  function update(
    scope: CommandProofScope,
    after: CommandProofSample,
    activation: CommandActivationReceipt | null,
  ) {
    const at = now(),
      p = state.pending;
    if (
      !p ||
      !equal(scope, p.scope) ||
      !validSample(after, scope, at) ||
      !recent(after, at) ||
      !validPair(p.before, after) ||
      (activation !== null &&
        (!validReceipt(activation, scope, p.preparedAt, at) ||
          activation.after.effectID !== p.before.commander.effectID ||
          activation.after.flagID !== p.before.commander.flagID ||
          p.priorActivationIDs.includes(activation.intent.issuedAt)))
    )
      throw Error("Command proof scope or after-observation changed.");
    const confirmed = benefitRecipients(p.before.commander, after.commander, activation).filter(
      (id) => scope.miners.some((m) => m.characterID === id),
    );
    const bothQuotes = after.miners.every(Boolean) && p.before.miners.every(Boolean);
    save({
      ...state,
      pending: {
        ...p,
        after: clone(after),
        activation: activation ? clone(activation) : null,
        inactiveObservedAt:
          activation && !after.commander.active
            ? (p.inactiveObservedAt ?? after.commander.observedAt)
            : p.inactiveObservedAt,
        status:
          confirmed.length === scope.miners.length && bothQuotes
            ? "BENEFIT_OBSERVED"
            : "UNCONFIRMED",
        recipientsConfirmed: confirmed,
      },
    });
  }
  function close(
    scope: CommandProofScope,
    controller: {
      pending: unknown | null;
      history: readonly {
        intent: { kind: string; issuedAt: number };
        after?: unknown;
        observedAt?: number;
      }[];
    },
  ) {
    const p = state.pending,
      at = now();
    if (!p || !equal(scope, p.scope)) throw Error("Command proof scope changed.");
    if (
      !controller ||
      controller.pending !== null ||
      !Array.isArray(controller.history) ||
      !p.after
    )
      throw Error("Command mutation remains unresolved; proof cannot close.");
    const actions = controller.history.filter(
      (h) => h?.intent?.kind === "activate" && h.intent.issuedAt >= p.preparedAt,
    );
    if (p.activation) {
      if (!actions.some((h) => equal(h, p.activation)))
        throw Error("The exact native activation receipt is unavailable.");
    } else if (actions.length || p.after.commander.active)
      throw Error("Activation remains unconfirmed; proof cannot close.");
    if (p.status !== "BENEFIT_OBSERVED" && p.after.commander.active)
      throw Error("Deferred recipient observation is still pending.");
    const closed = { ...p, closedAt: at };
    save({ ...state, pending: null, history: [...state.history, closed].slice(-128) });
  }
  return { snapshot: () => clone(state), prepare, update, close };
}
