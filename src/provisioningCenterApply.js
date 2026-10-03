"use strict";
const { randomUUID } = require("node:crypto");
const { createOperationJournal } = require("./operationJournal");
const { hash, fail } = require("./provisioningContracts");
const { shipPlan } = require("./shipProvisioning");
const terminal = new Set(["COMPLETE", "ALREADY_SATISFIED", "REFUSED"]);
const states = new Set([...terminal, "PREPARED", "ACQUIRING_CONTROL", "REVALIDATING", "PROVISIONING", "VERIFYING", "RELEASING", "BLOCKED"]);
const positive = n => Number.isSafeInteger(n) && n > 0;
const { intent, assertSelected, rows } = require("./provisioningIntent");

// Invocation evidence, not a second pilot ownership registry. Runtime/Factory
// owns sessions; characterOperations owns reservations; Phase 5 owns mutations.
// Opaque session handles remain only in memory. Restart recovery observes and
// blocks until offline release is proven; it never selects or sends a mutation.
function createProvisioningCenterApply({ sessions, gateway, engine, operations, data, readReview, selectedAdapter,
  attach, detach, filePath = null, fault = null, now = Date.now }) {
  const journal = createOperationJournal({ filePath }), reviews = new Map(), inFlight = new Set(), interruptions = new WeakSet();
  for (const r of journal.list()) {
    if (r.kind !== "CENTER_APPLY" || !positive(r.accountID) || !positive(r.characterID) || !states.has(r.state) ||
        !r.pin || r.pin.accountID !== r.accountID || r.pin.characterID !== r.characterID || hash(r.pin) !== r.reviewHash ||
        !r.input || r.release?.state === undefined || Object.hasOwn(r, "bridgeSessionID")) fail("CENTER_CONTROL_JOURNAL_INVALID");
    if (!terminal.has(r.state) && r.release.state !== "VERIFIED_OFFLINE" && !operations.has(r.characterID))
      operations.set(r.characterID, { kind: "temporary-provisioning-recovery", id: r.key });
  }
  const pending = pilot => journal.list().filter(r => r.characterID === pilot && !terminal.has(r.state))
    .map(r => ({ ...r, active: inFlight.has(r.key) }));
  function save(row, state = row.state) { row.state = state; row.updatedAt = now(); const { key, ...record } = row; journal.put(key, record); }
  function publicResult(r) { return { operationID: r.key, state: r.state, reason: r.reason || null, control: r.control || null,
    revalidation: r.revalidation || null, provisioning: r.provisioning || null, release: r.release, finalReview: r.finalReview || null }; }
  async function boundary(name, row) {
    if (!fault) return;
    try { await fault(name, publicResult(row)); } catch (e) { interruptions.add(e); throw e; }
  }
  function prepare(detail, input, { revalidate = null } = {}) {
    const reasons = [], p = detail.pilot, s = detail.candidateSource;
    let pin = null, plan = null;
    try {
      pin = intent(detail);
      plan = shipPlan({ contract: detail.selected, observation: p.observation, context: { ...pin, recoveryReady: true },
        source: { rows: s.rows, access: { take: true }, pin: { descriptor: input.source } }, target: { complete: true, rows: [] } }, data);
      if (plan.mode !== "ALREADY_SATISFIED") reasons.push(...plan.unsupported, ...plan.shortages);
      if (!plan.canApply) reasons.push("Unsupported or incomplete provisioning plan.");
    } catch (e) { reasons.push(e.code || "REVIEW_REQUIRED"); }
    if (p.control.state !== "FREE") reasons.push(`Pilot control is ${p.control.state}; FREE observation still requires free-only acquisition.`);
    if (pending(p.characterID).length || engine.unresolved(p.characterID).length) reasons.push("RECOVERY_REQUIRED");
    const reviewID = randomUUID(), reviewHash = pin ? hash(pin) : null, expiresAt = now() + 300000;
    const canApply = !!pin && !!plan?.canApply && !reasons.length;
    if (canApply) reviews.set(reviewID, { input, pin, reviewHash, expiresAt, revalidate, evidence: { revision: p.revision, quality: p.quality, sourceRevision: hash(s), read: detail.evidence } });
    for (const [key, r] of reviews) if (r.expiresAt < now()) reviews.delete(key);
    return { reviewID, reviewHash, expiresAt, canApply, reasons, plan, authority: "FREE_ONLY_ACQUISITION_AND_FRESH_REVALIDATION_REQUIRED", suppliesPolicy: "NEW_HULL_ONLY" };
  }
  async function apply(account, request, consumer = null) {
    if (request?.confirm !== true || typeof request.reviewID !== "string" || typeof request.reviewHash !== "string") fail("CONFIRMATION_REQUIRED");
    const key = request.reviewID, prior = journal.get(key);
    if (prior) {
      if (prior.accountID !== account.accountID || prior.reviewHash !== request.reviewHash || (consumer && prior.input.consumer !== consumer)) fail("OPERATION_NOT_OWNED");
      return publicResult({ key, ...prior }); // Historical invocation: never reacquire/replay.
    }
    const accepted = reviews.get(key);
    if (!accepted || accepted.pin.accountID !== account.accountID || accepted.reviewHash !== request.reviewHash || accepted.expiresAt < now() ||
        (consumer && accepted.input.consumer !== consumer)) fail("REVIEW_REQUIRED");
    if (pending(accepted.pin.characterID).length || engine.unresolved(accepted.pin.characterID).length) fail("RECOVERY_REQUIRED");
    const row = { key, kind: "CENTER_APPLY", accountID: account.accountID, characterID: accepted.pin.characterID,
      input: accepted.input, pin: accepted.pin, reviewHash: accepted.reviewHash, observation: accepted.evidence,
      state: "PREPARED", createdAt: now(), release: { state: "NOT_ACQUIRED" } };
    save(row); reviews.delete(key); inFlight.add(key);
    let binding = null;
    try {
      const outcome = await sessions.withSessions([{ account, characterID: row.characterID }], async ([lease]) => {
        binding = attach(account, row.characterID, lease.selected, key);
        const generation = row.control.generation;
        const base = selectedAdapter(binding.req, binding.held);
        let planning = true;
        const guard = async action => {
          if (hash([binding.held.bridgeSessionID, null]) !== generation) fail("PROVISIONING_GENERATION_CHANGED");
          const value = await action();
          if (hash([binding.held.bridgeSessionID, null]) !== generation ||
              (value?.context && value.context.sessionGeneration !== generation) || (value?.sessionGeneration && value.sessionGeneration !== generation)) fail("PROVISIONING_GENERATION_CHANGED");
          if (planning && value?.source) assertSelected(row.pin, value);
          if (value?.contract && value.contract.definitionFingerprint !== row.pin.definitionFingerprint) fail("REVIEW_STALE");
          return value;
        };
        const adapter = { ...base, context: () => guard(() => base.context()),
          readShip: (...args) => guard(() => base.readShip(...args)) };
        let freshOffline;
        try { freshOffline = await readReview(account.accountID, row.input); }
        catch (e) { if (["FITTING_UNAVAILABLE", "FITTING_SOURCE_CHANGED", "INVALID_FIT", "PROVIDER_NOT_OWNED"].includes(e.code)) fail("REVIEW_STALE"); throw e; }
        if (hash(intent(freshOffline)) !== row.reviewHash) fail("REVIEW_STALE");
        const fresh = await adapter.readShip(row.input);
        assertSelected(row.pin, fresh);
        // A consumer may impose an additional read-only policy (e.g. Training
        // skills). It cannot replace acquisition, the shared barrier or engine.
        // The callback is memory-only; restart recovery never repeats Apply.
        await accepted.revalidate?.(account, freshOffline);
        row.revalidation = { state: "VERIFIED", at: now(), generation, context: fresh.context, source: { pin: fresh.source.pin, access: fresh.source.access, stock: rows(fresh.source.rows) },
          definitionFingerprint: fresh.contract.definitionFingerprint, observed: rows(fresh.observation.rows) };
        save(row, "REVALIDATING");
        await boundary("REVALIDATED", row);
        return engine.withTemporaryControl(lease.reservation, async () => {
          const reviewed = await engine.reviewShip(adapter, row.input);
          if (!reviewed.canApply) fail("REVIEW_REQUIRED");
          row.provisioning = { operationID: reviewed.reviewID, reviewHash: reviewed.reviewHash, state: "PENDING", mode: reviewed.plan.mode };
          save(row, "PROVISIONING");
          await boundary("BEFORE_ENGINE", row);
          planning = false; // The accepted engine now pins every resulting mutation state.
          const result = await engine.applyShip(adapter, { reviewID: reviewed.reviewID, reviewHash: reviewed.reviewHash });
          row.provisioning = { ...row.provisioning, ...result }; save(row, "VERIFYING");
          if (result.state !== "COMPLETE") fail("PROVISIONING_RECOVERY_REQUIRED");
          const final = await engine.reviewShip(adapter, row.input);
          if (final.status.equipment !== "VERIFIED" || final.context.sessionGeneration !== generation ||
              final.contract.definitionFingerprint !== row.pin.definitionFingerprint) fail("FINAL_EQUIPMENT_NOT_VERIFIED");
          row.finalReview = { context: final.context, status: final.status, contract: final.contract, at: now() };
          row.completion = result.result?.alreadySatisfied ? "ALREADY_SATISFIED" : "COMPLETE";
          save(row, "VERIFYING");
          await boundary("VERIFIED", row);
          return result;
        });
      }, { purpose: "PROVISIONING", operationID: key, lifecycle: {
        async acquiring() { row.control = { state: "ACQUISITION_PENDING", generation: null, invocationID: randomUUID() }; save(row, "ACQUIRING_CONTROL"); },
        async acquired(lease) { row.control = { ...row.control, state: "ACQUIRED", generation: hash([lease.bridgeSessionID, null]),
          accountID: account.accountID, characterID: row.characterID, acquiredAt: now() }; row.release = { state: "REQUIRED" }; save(row, "REVALIDATING"); await boundary("ACQUIRED", row); },
        async releasing() { row.release = { state: "PENDING", invocationID: randomUUID(), at: now() }; save(row, "RELEASING"); await boundary("RELEASE_PENDING", row); },
        async released(lease, released) { row.release = { ...row.release, state: !lease.attempted ? "NOT_ACQUIRED" : released ? "VERIFIED_OFFLINE" : "UNKNOWN", checkedAt: now() }; save(row, released ? row.state : "BLOCKED"); },
        interrupted: e => interruptions.has(e),
      } });
      if (outcome.cleanup.some(r => !r.released) || row.release.state !== "VERIFIED_OFFLINE") { row.reason = "RELEASE_UNPROVEN"; save(row, "BLOCKED"); }
      else save(row, row.completion || "REFUSED");
    } catch (e) {
      row.reason = String(e.code || "APPLY_FAILED");
      if (interruptions.has(e) || row.release.state === "UNKNOWN" || engine.unresolved(row.characterID).length ||
          (row.control?.state === "ACQUIRED" && row.release.state !== "VERIFIED_OFFLINE")) save(row, "BLOCKED");
      else save(row, "REFUSED");
    } finally {
      inFlight.delete(key);
      if (binding) detach(binding);
      if (!terminal.has(row.state) && row.release.state !== "VERIFIED_OFFLINE" && !operations.has(row.characterID))
        operations.set(row.characterID, { kind: "temporary-provisioning-recovery", id: key });
    }
    return publicResult(row);
  }
  async function recover(account, operationID) {
    const row = journal.get(operationID);
    if (!row || row.accountID !== account.accountID) fail("OPERATION_NOT_OWNED"); row.key = operationID;
    if (inFlight.has(operationID)) fail("APPLY_IN_PROGRESS");
    if (terminal.has(row.state)) return publicResult(row);
    const s = await gateway.getCharacterStatus(account.accountID, row.characterID);
    if (s?.characterID !== row.characterID || s.online !== false || s.controlState !== "offline") {
      row.reason = "CONTROL_RELEASE_UNPROVEN"; save(row, "BLOCKED"); return publicResult(row);
    }
    row.release = { ...row.release, state: "VERIFIED_OFFLINE", checkedAt: now(), evidence: "AUTHORITATIVE_CHARACTER_STATUS" };
    const active = operations.get(row.characterID);
    if (["temporary-provisioning", "temporary-provisioning-recovery"].includes(active?.kind) && active.id === operationID) operations.delete(row.characterID);
    await sessions.status(account, row.characterID);
    if (engine.unresolved(row.characterID).length) { row.reason = "PROVISIONING_RECOVERY_REQUIRED"; save(row, "BLOCKED"); }
    else { row.reason = row.completion ? null : "INTERRUPTED_REVIEW_REQUIRED"; save(row, row.completion || "REFUSED");
    }
    return publicResult(row);
  }
  function status(account, operationID) {
    const row = journal.get(operationID);
    if (!row || row.accountID !== account.accountID) fail("OPERATION_NOT_OWNED");
    return publicResult({ key: operationID, ...row });
  }
  return { prepare, apply, recover, status, pending, journal };
}
module.exports = { createProvisioningCenterApply, intent, assertSelected };
