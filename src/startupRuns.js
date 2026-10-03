"use strict";
const crypto = require("node:crypto");
const { createOperationJournal } = require("./operationJournal");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const natural = value => Number.isSafeInteger(value) && value >= 0;
const preparationReady = value => ["VERIFIED", "DEGRADED"].includes(value?.state);
function credentialFree(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(credentialFree);
  return object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.entries(value).every(([key, entry]) =>
    !/password|secret|token|authorization|cookie|credential|bridgeSessionID|webSessionID/i.test(key) && credentialFree(entry));
}
function validatePreparation(value) {
  if (!object(value) || typeof value.operationID !== "string" || !value.operationID ||
      typeof value.operationRunID !== "string" || !value.operationRunID || !object(value.intent) || !credentialFree(value) ||
      !["PENDING", "PREPARING", "VERIFIED", "DEGRADED", "BLOCKED", "RECOVERY_REQUIRED"].includes(value.state) ||
      !natural(value.invocation) || typeof value.mainEntered !== "boolean" ||
      (value.mainEntered && !preparationReady(value)) || (preparationReady(value) && !object(value.evidence))) invalid();
}
function invalid() { throw new Error("Startup checkpoint is invalid; preserve its evidence and review the run."); }
function validateBase(row) {
  if (!positive(row.accountID) || !positive(row.characterID) || typeof row.scriptHash !== "string" || !row.scriptHash ||
      !positive(row.scriptRev) || typeof row.ended !== "boolean" || !object(row.blocks) ||
      (row.mainEntered !== undefined && typeof row.mainEntered !== "boolean") ||
      (row.branchChoices !== undefined && !object(row.branchChoices)) ||
      (row.startingLocation !== null && !positive(row.startingLocation)) ||
      (row.startingShipID !== undefined && !positive(row.startingShipID))) invalid();
  if (row.preparation !== undefined) validatePreparation(row.preparation);
  for (const block of Object.values(row.blocks)) {
    if (!object(block) || !["NEEDED", "PENDING", "COMPLETE", "BLOCKED"].includes(block.state)) invalid();
    if (block.deadline !== undefined && !natural(block.deadline)) invalid();
    if (["PENDING", "BLOCKED"].includes(block.state) && (!natural(block.invocation) || !object(block.action) ||
        typeof block.action.kind !== "string" || !natural(block.issuedAt))) invalid();
    if (block.state === "COMPLETE" && !object(block.evidence) && !natural(block.deadline)) invalid();
  }
}
function validateCursor(row, program, prefixLength) {
  const memory = row.runnerMemory;
  if (!memory) { if (row.mainEntered) invalid(); return; }
  if (!object(memory) || !object(memory.position) || !object(memory.board) || !object(memory.macroMem) ||
      !natural(memory.loopPass) || !natural(memory.stepTicks) || !natural(memory.cannotTellStreak) ||
      (memory.latched !== null && (!object(memory.latched) || typeof memory.latched.reason !== "string"))) invalid();
  const p = memory.position, node = program[p.node];
  if (p.kind !== "done") {
    if (!natural(p.node) || !node) invalid();
    if (p.kind === "step" && !["macro", "sub-bot"].includes(node.kind)) invalid();
    else if (["branch", "branch-enter"].includes(p.kind)) {
      if (node.kind !== "branch") invalid();
      if (p.kind === "branch" && (!["then", "else"].includes(p.side) || !natural(p.body) || !node[p.side][p.body])) invalid();
    } else if (p.kind.startsWith("loop")) {
      if (node.kind !== "loop" || !natural(p.body) || !node.body[p.body]) invalid();
      if (p.kind !== "loop" && node.body[p.body].kind !== "branch") invalid();
      if (p.kind === "loop-branch" && (!["then", "else"].includes(p.side) || !natural(p.inner) || !node.body[p.body][p.side][p.inner])) invalid();
      if (!["loop", "loop-branch", "loop-branch-enter"].includes(p.kind)) invalid();
    } else if (p.kind !== "step") invalid();
  }
  const entered = p.kind === "done" || p.node >= prefixLength;
  if (!!row.mainEntered !== entered) invalid();
  if (entered && row.preparation && !preparationReady(row.preparation)) invalid();
  const complete = step => row.blocks[step.id]?.state === "COMPLETE";
  for (let i = 0; i < Math.min(p.kind === "done" ? prefixLength : p.node, prefixLength); i++) {
    const prior = program[i];
    if (prior.kind === "macro" && !complete(prior)) invalid();
    if (prior.kind === "branch") {
      const side = row.branchChoices?.[prior.id];
      if (!["then", "else"].includes(side) || !prior[side].every(complete)) invalid();
    }
    if (prior.kind === "sub-bot") invalid(); // No hosted sub-bot reconciliation adapter.
  }
  if (p.kind === "branch" && (!node[p.side].slice(0, p.body).every(complete) || row.branchChoices?.[node.id] !== p.side)) invalid();
  if (entered && Object.values(row.blocks).some(block => ["PENDING", "BLOCKED"].includes(block.state))) invalid();
}

function createStartupRuns({ filePath = null, now = Date.now } = {}) {
  const journal = createOperationJournal({ filePath });
  for (const row of journal.list()) validateBase(row);
  function open({ logicalRunID = null, accountID, characterID, scriptHash, scriptRev, steps, prefixLength, program = [...steps,
    { kind: "loop", body: [{ kind: "macro" }] }], adapters }) {
    const id = logicalRunID || crypto.randomUUID();
    let row = journal.get(id);
    if (logicalRunID && !row) throw new Error("Startup run evidence is missing; a new run cannot replace it.");
    if (row && (row.accountID !== accountID || row.characterID !== characterID || row.scriptHash !== scriptHash ||
        row.scriptRev !== scriptRev || row.ended)) throw new Error("Startup run identity changed.");
    if (!row && journal.list().some(run => run.accountID === accountID && run.characterID === characterID &&
        Object.values(run.blocks || {}).some(block => ["PENDING", "BLOCKED"].includes(block.state))))
      throw new Error("An earlier startup run has unresolved mutation evidence.");
    if (!row) row = journal.put(id, { accountID, characterID, scriptHash, scriptRev, ended: false,
      startingLocation: null, blocks: {}, branchChoices: {}, createdAt: now() });
    validateBase(row);
    if (Object.keys(row.blocks).some(key => !steps.some(step => step.id === key))) invalid();
    validateCursor(row, program, prefixLength);
    const restored = new Set(Object.entries(row.blocks).filter(([, b]) => b.state === "PENDING" || b.state === "BLOCKED").map(([key]) => key));
    const pendingReads = new Map();
    function save() {
      const preparation = journal.get(id)?.preparation;
      row = journal.put(id, { ...row, ...(preparation ? { preparation } : {}) });
    }
    const blockAt = key => Object.hasOwn(row.blocks, key) ? row.blocks[key] : undefined;
    const setBlock = (key, value) => { row.blocks = { ...row.blocks, [key]: value }; };
    const currentStep = step => {
      if (!steps.some(s => s.id === step.id && JSON.stringify(s) === JSON.stringify(step))) throw new Error("Startup block changed.");
      return blockAt(step.id);
    };
    return {
      logicalRunID: id,
      restoreMemory: () => row.runnerMemory ? { ...row.runnerMemory, macroMem: {} } : null,
      async checkpoint(memory) {
        if (row.mainEntered) return;
        const preparation = journal.get(id)?.preparation;
        if (preparation && !preparationReady(preparation)) throw new Error("Operation preparation must complete before MAIN.");
        const p = memory.position;
        row.branchChoices ||= {};
        if (p.kind === "branch") row.branchChoices = { ...row.branchChoices, [program[p.node].id]: p.side };
        for (const node of program.slice(0, Math.min(p.kind === "done" ? prefixLength : p.node, prefixLength))) {
          if (node.kind === "branch" && !Object.hasOwn(row.branchChoices, node.id)) {
            const side = ["then", "else"].find(side => node[side].every(step => row.blocks[step.id]?.state === "COMPLETE"));
            if (!side) invalid();
            row.branchChoices = { ...row.branchChoices, [node.id]: side };
          }
        }
        row.runnerMemory = memory;
        row.mainEntered = memory.position.kind === "done" || memory.position.node >= prefixLength;
        validateCursor(row, program, prefixLength);
        save();
      },
      async observe(step, obs) {
        const block = currentStep(step);
        if (block?.state === "COMPLETE") return "COMPLETE";
        if (!positive(obs.flightStatus?.shipID)) return "BLOCKED";
        if (row.startingShipID === undefined) { row.startingShipID = obs.flightStatus.shipID; save(); }
        if (row.startingShipID !== obs.flightStatus.shipID) return "BLOCKED";
        if (row.startingLocation === null && obs.flightStatus?.docked === true) {
          row.startingLocation = obs.flightStatus.stationID || obs.flightStatus.structureID || null; save();
        }
        const proven = await adapters.postcondition(step, obs, row.startingLocation);
        if (proven === true) {
          setBlock(step.id, { ...block, state: "COMPLETE", evidence: { observedAt: now(), shipID: obs.flightStatus.shipID,
            stationID: obs.flightStatus.stationID, structureID: obs.flightStatus.structureID, docked: obs.flightStatus.docked } });
          save(); return "COMPLETE";
        }
        if (step.macro === "wait" && !step.until) {
          // A pure wait has no world write. Persist its wall-clock deadline.
          const seconds = step.args.seconds?.kind === "count" ? step.args.seconds.value : 10;
          if (!Number.isFinite(seconds) || seconds < 0) return "BLOCKED";
          const deadline = block?.deadline ?? now() + seconds * 1000;
          setBlock(step.id, { state: now() >= deadline ? "COMPLETE" : "NEEDED", deadline });
          save(); return row.blocks[step.id].state;
        }
        if (block?.state === "PENDING" || block?.state === "BLOCKED") {
          const reads = (pendingReads.get(step.id) || 0) + 1; pendingReads.set(step.id, reads);
          if (restored.has(step.id) || reads >= 12) {
            setBlock(step.id, { ...block, state: "BLOCKED", reason: "Startup outcome is unproven; reconcile before MAIN." }); save();
            return "BLOCKED";
          }
          return "PENDING";
        }
        return proven === false ? "NEEDED" : "BLOCKED";
      },
      async beforeIssue(step, action, invocation) {
        const preparation = journal.get(id)?.preparation;
        if (preparation && !preparationReady(preparation)) throw new Error("Operation preparation is not ready.");
        const block = currentStep(step);
        if (block && ["PENDING", "BLOCKED", "COMPLETE"].includes(block.state)) throw new Error("Startup dispatch is already fenced.");
        if (!adapters.actionSupported(step, action)) throw new Error("This startup action has no reconciliation adapter.");
        setBlock(step.id, { state: "PENDING", invocation, action, issuedAt: now() }); save();
      },
      end() { row.ended = true; save(); },
      snapshot: () => journal.get(id),
    };
  }
  function openPreparation({ logicalRunID, accountID, characterID, scriptHash, scriptRev,
    operationID, operationRunID, intent, resumed = false, assertCurrent = () => {} }) {
    if (typeof logicalRunID !== "string" || !logicalRunID || typeof operationID !== "string" || !operationID ||
        typeof operationRunID !== "string" || !operationRunID || !object(intent) || !credentialFree(intent)) invalid();
    let row = journal.get(logicalRunID);
    if (resumed && !row?.preparation) throw new Error("Operation preparation checkpoint is missing; preserve the original run.");
    if (row && (row.accountID !== accountID || row.characterID !== characterID || row.scriptHash !== scriptHash ||
        row.scriptRev !== scriptRev || row.ended)) throw new Error("Startup run identity changed.");
    if (!row) {
      if (journal.list().some(run => run.characterID === characterID && !run.ended && run.preparation &&
          ["PREPARING", "RECOVERY_REQUIRED"].includes(run.preparation.state)))
        throw new Error("An earlier operation preparation still owns mutation custody.");
      row = { accountID, characterID, scriptHash, scriptRev, ended: false, startingLocation: null,
        blocks: {}, branchChoices: {}, createdAt: now() };
    }
    const prior = row.preparation;
    if (prior && (prior.operationID !== operationID || prior.operationRunID !== operationRunID ||
        JSON.stringify(prior.intent) !== JSON.stringify(intent))) throw new Error("Operation preparation intent changed.");
    row.preparation ||= { operationID, operationRunID, intent: structuredClone(intent), state: "PENDING",
      invocation: 0, mainEntered: false };
    validateBase(row); journal.put(logicalRunID, row);
    function current() {
      assertCurrent();
      const fresh = journal.get(logicalRunID);
      if (!fresh || fresh.ended || fresh.preparation.operationRunID !== operationRunID) throw new Error("Operation preparation run ended.");
      return fresh;
    }
    function save(preparation) {
      const fresh = current(); validatePreparation(preparation);
      journal.put(logicalRunID, { ...fresh, preparation });
      return structuredClone(preparation);
    }
    return {
      logicalRunID,
      snapshot: () => structuredClone(journal.get(logicalRunID)?.preparation),
      begin(evidence = {}) {
        const prior = current().preparation;
        if (preparationReady(prior)) throw new Error("Completed preparation cannot be issued again in this run.");
        if (["PREPARING", "RECOVERY_REQUIRED"].includes(prior.state)) throw new Error("Pending preparation requires reconciliation before another issue.");
        const next = save({ ...prior, state: "PREPARING", invocation: prior.invocation + 1,
          evidence: { ...prior.evidence, ...evidence }, issuedAt: now() });
        return next.invocation;
      },
      recover(evidence = {}) {
        const prior = current().preparation;
        if (prior.mainEntered || preparationReady(prior) || !prior.invocation ||
            !["BLOCKED", "PREPARING", "RECOVERY_REQUIRED"].includes(prior.state) || !object(evidence))
          throw new Error("Only an issued preparation may enter read-only recovery before MAIN.");
        return save({ ...prior, state: "RECOVERY_REQUIRED", evidence: { ...prior.evidence, ...evidence } });
      },
      update(evidence) {
        const prior = current().preparation;
        if (!["PREPARING", "RECOVERY_REQUIRED"].includes(prior.state) || !object(evidence))
          throw new Error("Only pending preparation custody may receive additional evidence.");
        return save({ ...prior, evidence: { ...prior.evidence, ...evidence } });
      },
      complete(result) {
        if (!preparationReady(result)) throw new Error("Preparation requires verified readiness evidence.");
        const prior = current().preparation;
        return save({ ...prior, ...result, operationID, operationRunID, intent: prior.intent,
          invocation: prior.invocation, mainEntered: prior.mainEntered,
          evidence: { ...prior.evidence, ...result.evidence }, completedAt: now() });
      },
      block(result = {}) {
        const prior = current().preparation;
        if (prior.mainEntered) throw new Error("Completed preparation cannot be blocked by a stale startup response.");
        return save({ ...prior, ...result, operationID, operationRunID, intent: prior.intent,
          invocation: prior.invocation, mainEntered: false,
          state: result.state === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : "BLOCKED" });
      },
      enterMain() {
        const prior = current().preparation;
        if (!preparationReady(prior)) throw new Error("Operation preparation must complete before MAIN.");
        return save({ ...prior, mainEntered: true });
      },
      end() {
        const fresh = journal.get(logicalRunID);
        if (fresh) journal.put(logicalRunID, { ...fresh, ended: true });
      },
    };
  }
  return { open, openPreparation, get: id => journal.get(id) };
}
module.exports = { createStartupRuns, credentialFree, preparationReady };
