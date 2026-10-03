"use strict";
// Phase 5 planning/evidence only. Reservations and persistence belong to the
// existing replenishment engine and its credential-free operation journal.
const { hash, fail, inspectContract, matchFittings } = require("./provisioningContracts");
const { randomUUID } = require("node:crypto");
const positive = n => Number.isSafeInteger(n) && n > 0;
const slot = flag => flag >= 11 && flag <= 34;
const quantity = (rows, type, flag = null, packaged = false) => rows.filter(r => r.typeID === type &&
  (flag === null || r.flagID === flag) && (!packaged || !r.singleton)).reduce((n, r) => n + r.quantity, 0);
const equal = (a, b) => hash(a) === hash(b);

function shipPlan(read, data, operation = null) {
  const contract = read.contract, status = inspectContract(contract, read.observation, data);
  const unsupported = [], shortages = [];
  if (Number(data.getType(contract.shipTypeID)?.groupID) !== 25 || data.getType(contract.shipTypeID)?.published === false)
    unsupported.push("Only ordinary published T1 frigates are supported initially.");
  if (!["hangar", "corp"].includes(read.source.pin.descriptor?.kind)) unsupported.push("Provision Ship requires a personal hangar or exact corporation division.");
  for (const [flag, typeID] of contract.structural) if (!slot(flag) || Number(data.getType(typeID)?.categoryID) !== 7)
    unsupported.push(`Unsupported fitting slot/type ${flag}/${typeID}: rigs and subsystems are deferred.`);
  for (const [flag, typeID] of contract.operational) if (!(flag === 87 && Number(data.getType(typeID)?.categoryID) === 18) && flag !== 5)
    unsupported.push(`Unsupported carried equipment bay ${flag}/${typeID}.`);
  for (const supply of contract.supplies) if (supply.mode !== "CARRIED_SPARES" || !supply.eligibleFlags.includes(5))
    unsupported.push(`Supply ${supply.typeID} requires an unqualified loaded/specialized-bay policy.`);
  const alreadySatisfied = !operation && status.equipment === "VERIFIED";
  const hull = read.source.rows.find(r => r.typeID === contract.shipTypeID && !r.singleton);
  const requirements = contract.equipment.map(([flag, typeID, required]) => ({ key: `${flag}:${typeID}`, flag, typeID,
    name: data.getTypeName(typeID), quantity: required, kind: contract.structural.some(([f, t]) => f === flag && t === typeID) ? "FITTED" : "LOADED" }));
  if (!alreadySatisfied && !operation?.manifest.packagedItemID && !operation?.manifest.targetHullID && !hull) shortages.push("A packaged target hull is unavailable at the selected source.");
  const needs = new Map();
  for (const r of requirements) {
    const present = operation?.manifest.targetHullID ? quantity(read.target.rows, r.typeID, r.flag) : 0;
    needs.set(r.typeID, (needs.get(r.typeID) || 0) + Math.max(0, r.quantity - present));
  }
  for (const [typeID, needed] of needs) {
    const available = quantity(read.source.rows, typeID, null, true);
    if (!alreadySatisfied && available < needed)
      shortages.push(`Required equipment ${data.getTypeName(typeID)}: need ${needed}, packaged source has ${available}. Singleton equipment sources are not qualified.`);
  }
  return { mode: alreadySatisfied ? "ALREADY_SATISFIED" : operation ? "CONTINUE" : "NEW_HULL",
    operationID: operation?.key || null, targetHullTypeID: contract.shipTypeID, targetHullName: data.getTypeName(contract.shipTypeID),
    targetHullID: operation?.manifest.targetHullID || null, hullQuantity: alreadySatisfied ? 0 : 1,
    hullSourceItemID: operation?.manifest.packagedItemID || hull?.itemID || null, requirements,
    supplies: contract.supplies, optionalSavedCargo: contract.unrelated, destructiveActions: [], unsupported, shortages,
    steps: alreadySatisfied ? [] : ["Acquire one local packaged hull", "Assemble and prove singleton identity", "Board exact hull",
      "Fit exact module slots", "Load required carried equipment", "Replenish cargo deficits", "Fresh authoritative Review"],
    canApply: read.observation.complete && read.context.recoveryReady !== false &&
      (alreadySatisfied || (!unsupported.length && !shortages.length && read.source.access.take === true)) };
}

function proveShipAction(action, after, verifyMovement) {
  const before = action.before, move = action.move;
  if (after.context.accountID !== before.context.accountID || after.context.characterID !== before.context.characterID ||
      after.context.corporationID !== before.context.corporationID || after.context.locationID !== before.context.locationID) return null;
  const unchanged = (old, current) => equal(old, current);
  if (action.kind === "WITHDRAW_HULL") {
    if (verifyMovement({ source: before.source.rows, destination: before.hangar },
      { source: after.source.rows, destination: after.hangar }, move) !== "VERIFIED") return null;
    const candidates = after.hangar.filter(r => r.typeID === move.typeID && !r.singleton &&
      r.quantity - (before.hangar.find(old => old.itemID === r.itemID)?.quantity || 0) === 1);
    return candidates.length === 1 && candidates[0].ownerID === before.context.characterID && candidates[0].flagID === 4 &&
      candidates[0].locationID === before.context.locationID &&
      unchanged(before.source.rows.filter(r => r.typeID !== move.typeID), after.source.rows.filter(r => r.typeID !== move.typeID)) &&
      unchanged(before.hangar.filter(r => r.typeID !== move.typeID), after.hangar.filter(r => r.typeID !== move.typeID)) ?
      { packagedItemID: candidates[0].itemID, location: candidates[0].locationID } : null;
  }
  if (action.kind === "ASSEMBLE_HULL") {
    const old = before.hangar.find(r => r.itemID === move.itemID && r.typeID === move.typeID && !r.singleton);
    const rest = after.hangar.find(r => r.itemID === move.itemID && !r.singleton);
    const candidates = after.hangar.filter(r => r.typeID === move.typeID && r.singleton &&
      !before.hangar.some(old => old.itemID === r.itemID && old.singleton));
    if (!old || old.quantity - (rest?.quantity || 0) !== 1 || candidates.length !== 1 ||
        quantity(before.hangar, move.typeID, null, true) - quantity(after.hangar, move.typeID, null, true) !== 1 ||
        quantity(after.hangar, move.typeID) !== quantity(before.hangar, move.typeID) ||
        before.hangar.some(r => r.itemID !== move.itemID && !after.hangar.some(n => equal(n, r)))) return null;
    const hull = candidates[0];
    return hull.ownerID === before.context.characterID && hull.locationID === before.context.locationID && hull.flagID === 4 &&
      hull.quantity === 1 ? { targetHullID: hull.itemID, location: hull.locationID } : null;
  }
  if (action.kind === "BOARD_HULL") return after.context.shipID === move.itemID &&
    after.context.shipTypeID === move.typeID && after.context.locationID === before.context.locationID ? { boardedShipID: move.itemID } : null;
  if (["FIT_ITEM", "LOAD_ITEM", "SUPPLY"].includes(action.kind)) {
    const current = after.target.rows;
    if (verifyMovement({ source: before.source.rows, destination: before.target.rows },
      { source: after.source.rows, destination: current }, move) !== "VERIFIED") return null;
    if (quantity(current, move.typeID, move.flag) - quantity(before.target.rows, move.typeID, move.flag) !== move.quantity ||
        !unchanged(before.target.rows.filter(r => !(r.typeID === move.typeID && r.flagID === move.flag)),
          current.filter(r => !(r.typeID === move.typeID && r.flagID === move.flag))) ||
        !unchanged(before.source.rows.filter(r => r.typeID !== move.typeID), after.source.rows.filter(r => r.typeID !== move.typeID))) return null;
    return { itemIDs: current.filter(r => r.typeID === move.typeID && r.flagID === move.flag).map(r => r.itemID),
      location: move.shipID, flag: move.flag, quantity: quantity(current, move.typeID, move.flag) };
  }
  return null;
}

function validShipRecord(row, verifyMovement, data) {
  if (!Array.isArray(row.actions) || !Array.isArray(row.contract?.equipment) || !Array.isArray(row.contract?.supplies)) return false;
  const snapshots = snapshot => snapshot && Array.isArray(snapshot.hangar) && Array.isArray(snapshot.source?.rows) &&
    Array.isArray(snapshot.target?.rows) && snapshot.context?.accountID === row.accountID && snapshot.context?.characterID === row.characterID &&
    snapshot.context.locationID === row.context.locationID &&
    [snapshot.hangar, snapshot.source.rows, snapshot.target.rows].every(rows => rows.every(r => positive(r.typeID) && positive(r.quantity) &&
      (positive(r.itemID) || r.loaded === true) && positive(r.ownerID) && positive(r.locationID) && Number.isSafeInteger(r.flagID)));
  const aHull = row.actions?.find(a => a.kind === "ASSEMBLE_HULL" && a.state === "VERIFIED");
  const aBoard = row.actions?.find(a => a.kind === "BOARD_HULL" && a.state === "VERIFIED");
  const aWithdraw = row.actions?.find(a => a.kind === "WITHDRAW_HULL" && a.state === "VERIFIED");
  const exact = row.result?.alreadySatisfied === true;
  if (new Set(row.actions.map(a => a.invocationID)).size !== row.actions.length) return false;
  return row.kind === "SHIP_PROVISION" && row.manifest?.version === 1 && positive(row.manifest.originalShipID) &&
    row.manifest.originalShipID === row.context.shipID &&
    row.manifest.hullTypeID === row.contract.shipTypeID && Array.isArray(row.manifest.requirements) && Array.isArray(row.actions) &&
    equal(row.manifest.requirements.map(r => [r.flag, r.typeID, r.quantity]), row.contract.equipment) &&
    equal(row.contract.definitionFingerprint, hash(row.contract.definition)) &&
    equal(row.contract.equipmentFingerprint, hash([row.contract.shipTypeID, row.contract.equipment])) &&
    equal(row.contract.supplyPolicyFingerprint, hash(row.contract.supplies.map(({ name, ...policy }) => policy))) &&
    row.input?.fittingID === row.contract.definition.fittingID && row.input?.providerCharacterID === row.contract.definition.characterID &&
    equal(row.input?.source, row.sourcePin.descriptor) &&
    (row.manifest.targetHullID || null) === (exact ? row.context.shipID : aHull?.proof?.targetHullID || null) &&
    (row.manifest.boardedShipID || null) === (exact ? row.context.shipID : aBoard?.proof?.boardedShipID || null) &&
    (!aWithdraw || row.manifest.packagedItemID === aWithdraw.proof?.packagedItemID) &&
    ["PREPARED", "PENDING", "BLOCKED", "READY", "COMPLETE", "REFUSED"].includes(row.state) && snapshots(row.expected) &&
    row.actions.every((a, index) => ["WITHDRAW_HULL", "ASSEMBLE_HULL", "BOARD_HULL", "FIT_ITEM", "LOAD_ITEM", "SUPPLY"].includes(a.kind) &&
      a.sequence === index + 1 && typeof a.invocationID === "string" && a.invocationID.length > 0 && positive(a.move?.itemID) && positive(a.move?.typeID) && positive(a.move?.quantity) &&
      ["PENDING", "VERIFIED", "AMBIGUOUS"].includes(a.state) && snapshots(a.before) &&
      equal(a.before.contract, row.contract) && equal(a.before.source.pin, row.sourcePin) && equal(a.before.source.access, row.access) &&
      (a.state === "VERIFIED" || index === row.actions.length - 1) &&
      (a.state !== "VERIFIED" || (snapshots(a.after) && a.proof && equal(a.proof, proveShipAction(a, a.after, verifyMovement))))) &&
    (!["READY", "COMPLETE", "REFUSED"].includes(row.state) || row.actions.every(a => a.state === "VERIFIED")) &&
    (row.state !== "COMPLETE" || (row.result?.equipment === "VERIFIED" && row.manifest.boardedShipID === row.manifest.targetHullID &&
      row.expected.context.shipID === row.manifest.targetHullID &&
      inspectContract(row.contract, exact ? row.expected.observation : row.expected.target, data).equipment === "VERIFIED"));
}

module.exports = { shipPlan, proveShipAction, validShipRecord, quantity, equal };

// The existing engine supplies the SAME journal, reservations and readonly
// Review cache. These steps never create a second transaction/ownership store.
function createShipOperations({ journal, reviews, reserve, release, assertWritable, unresolved, data, now, verifyMovement }) {
  const snapshot = read => ({ context: read.context, contract: read.contract, observation: read.observation,
    source: { pin: read.source.pin, access: read.source.access, rows: read.source.rows }, hangar: read.hangar, target: read.target });
  const result = row => ({ operationID: row.key, state: row.state, result: row.result || null, manifest: row.manifest, reason: row.reason || null });
  function owned(row, context) {
    if (!row || row.kind !== "SHIP_PROVISION" || row.accountID !== context.accountID || row.characterID !== context.characterID) fail("OPERATION_NOT_OWNED");
    if (context.locationID !== row.context.locationID || context.corporationID !== row.context.corporationID) fail("RECONCILIATION_SCOPE_CHANGED");
  }
  function scope(row, read) {
    owned(row, read.context);
    if (!equal(read.contract, row.contract) || !equal(read.source.pin, row.sourcePin) || !equal(read.source.access, row.access) ||
        read.context.recoveryReady === false || !read.observation.complete || !read.target.complete) fail("REVIEW_REQUIRED");
  }
  function save(row) { const { key, ...record } = row; journal.put(key, record); }
  function advance(row, action, after, proof) {
    action.after = snapshot(after); action.proof = proof; action.state = "VERIFIED";
    if (action.kind === "WITHDRAW_HULL") { row.manifest.packagedItemID = proof.packagedItemID; row.manifest.hull.state = "ACQUIRED"; }
    if (action.kind === "ASSEMBLE_HULL") { row.manifest.targetHullID = proof.targetHullID; row.manifest.hull.state = "ASSEMBLED"; }
    if (action.kind === "BOARD_HULL") { row.manifest.boardedShipID = proof.boardedShipID; row.manifest.hull.state = "BOARDED"; }
    row.manifest.hull.currentLocation = after.context.locationID;
    row.expected = snapshot(after); row.state = "PREPARED"; row.reason = null;
    for (const r of row.manifest.requirements) {
      const present = quantity(after.target.rows, r.typeID, r.flag);
      r.state = present >= r.quantity ? r.kind : "NEEDED";
      r.currentQuantity = present; r.currentLocation = row.manifest.targetHullID || null;
      r.itemIDs = after.target.rows.filter(i => i.typeID === r.typeID && i.flagID === r.flag).map(i => i.itemID);
      if (r.key === action.requirementKey) {
        r.history ||= []; r.history.push({ sequence: action.sequence, state: r.state, sourceItemID: action.move.itemID,
          acquiredQuantity: action.move.quantity, currentLocation: action.move.shipID, resultingItemIDs: r.itemIDs });
      }
    }
    save(row);
  }
  async function reviewShip(adapter, input, operationID = null) {
    let row = operationID ? journal.get(operationID) : null;
    if (operationID) { owned(row, await adapter.context()); row.key = operationID; if (!equal(row.input, input)) fail("REVIEW_REQUIRED"); }
    const read = await adapter.readShip(input, row?.manifest.targetHullID, row?.sourcePin);
    const plan = shipPlan(read, data, row);
    if (row) { scope(row, read); if (row.state !== "READY" || !equal(snapshot(read), row.expected)) {
      plan.canApply = false; plan.unsupported.push("Reconcile pending custody and changed world state before requesting continuation."); } }
    if (unresolved(read.context.characterID).some(r => r.key !== operationID)) { plan.canApply = false; plan.unsupported.push("This pilot has unresolved custody."); }
    const pin = snapshot(read), reviewID = randomUUID(), expiresAt = now() + 300_000;
    for (const [key, value] of reviews) if (value.expiresAt < now()) reviews.delete(key);
    reviews.set(reviewID, { kind: "SHIP_PROVISION", input, pin, operationID, plan, expiresAt });
    return { reviewID, reviewHash: hash(pin), expiresAt, contract: read.contract, context: read.context, plan,
      status: inspectContract(read.contract, read.observation, data), source: pin.source, canApply: plan.canApply };
  }
  async function reconcileShip(adapter, id) {
    const row = journal.get(id); owned(row, await adapter.context()); row.key = id;
    const lease = reserve(row.characterID, id, true);
    try {
      const pending = row.actions.find(a => a.state !== "VERIFIED");
      const read = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
      // Selection after WC restart supplies a new generation. Reconciliation
      // can observe it, but never dispatches and never authorizes continuation.
      if (pending) {
        const proof = proveShipAction(pending, read, verifyMovement);
        if (!proof) { pending.after = snapshot(read); pending.state = "AMBIGUOUS"; row.state = "BLOCKED"; row.reason = "OUTCOME_AMBIGUOUS"; save(row); return result(row); }
        advance(row, pending, read, proof);
      } else {
        const expected = { ...row.expected, context: { ...row.expected.context, sessionGeneration: read.context.sessionGeneration, recoveryReady: read.context.recoveryReady } };
        if (!equal(snapshot(read), expected)) fail("RECONCILIATION_STATE_CHANGED");
      }
      // Re-read the newly proven hull's inventory; assembly's first snapshot
      // intentionally observed no target because its identity was unknown.
      const current = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
      scope(row, current);
      if (pending?.kind === "ASSEMBLE_HULL" && current.target.rows.length) fail("ASSEMBLED_HULL_NOT_EMPTY");
      const expectedShip = row.manifest.boardedShipID || row.manifest.originalShipID;
      if (current.context.shipID !== expectedShip) fail("PROVISIONING_SHIP_CHANGED");
      row.expected = snapshot(current);
      if (row.state !== "COMPLETE" && row.state !== "REFUSED") row.state = "READY";
      save(row); return result(row);
    } catch (error) {
      if (!["COMPLETE", "REFUSED"].includes(row.state)) { row.state = "BLOCKED"; row.reason = String(error.code || "READ_FAILED"); save(row); }
      throw error;
    } finally { release(row.characterID, lease); }
  }
  async function applyShip(adapter, { reviewID, reviewHash }) {
    const context = await adapter.context(), prior = journal.get(reviewID);
    if (prior) {
      owned(prior, context); if (prior.reviewHash !== reviewHash) fail("REVIEW_REQUIRED"); prior.key = reviewID;
      if (prior.state === "COMPLETE") {
        const fresh = await adapter.readShip(prior.input, prior.manifest.targetHullID, prior.sourcePin); scope(prior, fresh);
        if (fresh.context.shipID !== prior.manifest.targetHullID) fail("COMPLETED_SHIP_CHANGED");
        const status = inspectContract(prior.contract, fresh.target, data);
        if (status.equipment !== "VERIFIED") fail("COMPLETED_EQUIPMENT_CHANGED");
        return { ...result(prior), result: { ...prior.result, ...status } };
      }
      return result(prior);
    }
    const accepted = reviews.get(reviewID);
    if (accepted?.kind !== "SHIP_PROVISION" || accepted.expiresAt < now() || hash(accepted.pin) !== reviewHash || !accepted.plan.canApply) fail("REVIEW_REQUIRED");
    const id = accepted.operationID || reviewID, lease = reserve(context.characterID, id, !!accepted.operationID);
    let row;
    try {
      assertWritable(context.characterID, lease);
      let read = await adapter.readShip(accepted.input, accepted.pin.target.shipID, accepted.pin.source.pin);
      if (!equal(snapshot(read), accepted.pin)) fail("REVIEW_REQUIRED");
      if (accepted.operationID) {
        row = journal.get(id); owned(row, context); row.key = id; scope(row, read);
        if (row.state !== "READY" || !equal(snapshot(read), row.expected)) fail("REVIEW_REQUIRED");
      } else {
        row = { key: id, kind: "SHIP_PROVISION", accountID: context.accountID, characterID: context.characterID,
          context, reviewHash, input: accepted.input, contract: read.contract, sourcePin: read.source.pin, access: read.source.access,
          state: "PREPARED", createdAt: now(), moves: [], actions: [], expected: snapshot(read),
          manifest: { version: 1, originalShipID: context.shipID, hullTypeID: read.contract.shipTypeID,
            targetHullID: null, packagedItemID: null,
            hull: { state: "NEEDED", quantity: 1, sourceStackID: accepted.plan.hullSourceItemID, currentLocation: read.source.pin.locationID },
            requirements: accepted.plan.requirements.map(r => ({ ...r, state: "NEEDED", history: [] })) } };
        if (accepted.plan.mode === "ALREADY_SATISFIED") {
          row.manifest.targetHullID = context.shipID; row.manifest.boardedShipID = context.shipID;
          row.manifest.hull = { state: "VERIFIED", quantity: 0, currentLocation: context.locationID };
          row.manifest.requirements.forEach(r => { r.state = "VERIFIED"; r.currentQuantity = quantity(read.observation.rows, r.typeID, r.flag); r.currentLocation = context.shipID;
            r.itemIDs = read.observation.rows.filter(i => i.typeID === r.typeID && i.flagID === r.flag).map(i => i.itemID); });
          row.state = "COMPLETE"; row.result = { ...inspectContract(row.contract, read.observation, data), alreadySatisfied: true };
          row.expected = snapshot(read); save(row); return result(row);
        }
        if (read.source.pin.descriptor.kind === "hangar") {
          row.manifest.packagedItemID = accepted.plan.hullSourceItemID;
          row.manifest.hull.state = "ACQUIRED";
          row.manifest.allocation = { itemID: accepted.plan.hullSourceItemID, quantity: 1, locationID: context.locationID,
            before: read.source.rows.find(r => r.itemID === accepted.plan.hullSourceItemID) };
        }
        save(row);
      }
      for (let count = 0; count < 128; count++) {
        assertWritable(row.characterID, lease);
        read = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
        scope(row, read);
        if (!equal(snapshot(read), row.expected)) fail("PROVISIONING_STATE_CHANGED");
        let kind, move, requirementKey = null;
        const base = { typeID: row.manifest.hullTypeID, quantity: 1, shipID: row.manifest.targetHullID || context.shipID };
        if (!row.manifest.packagedItemID && !row.manifest.targetHullID) {
          const source = read.source.rows.find(r => r.typeID === base.typeID && !r.singleton);
          if (!source) fail("SOURCE_CHANGED");
          kind = "WITHDRAW_HULL"; move = { ...base, itemID: source.itemID, sourceLocationID: source.locationID, destination: { kind: "hangar" }, flag: 4 };
        } else if (!row.manifest.targetHullID) {
          kind = "ASSEMBLE_HULL"; move = { ...base, itemID: row.manifest.packagedItemID };
        } else if (!row.manifest.boardedShipID) {
          kind = "BOARD_HULL"; move = { ...base, itemID: row.manifest.targetHullID };
        } else {
          if (read.context.shipID !== row.manifest.targetHullID) fail("PROVISIONING_SHIP_CHANGED");
          // New hull only. Extra/conflicting equipment is never removed.
          const wanted = new Set(row.contract.equipment.map(([f, t]) => `${f}:${t}`));
          if (read.target.rows.some(r => ((slot(r.flagID) && Number(data.getType(r.typeID)?.categoryID) !== 8) || [87, 158].includes(r.flagID)) &&
              !wanted.has(`${r.flagID}:${r.typeID}`))) fail("DESTRUCTIVE_FIT_UNSUPPORTED");
          const needed = row.manifest.requirements.find(r => quantity(read.target.rows, r.typeID, r.flag) !== r.quantity);
          if (needed) {
            requirementKey = needed.key;
            const present = quantity(read.target.rows, needed.typeID, needed.flag);
            if (present > needed.quantity || (needed.kind === "FITTED" && read.target.rows.some(r => r.flagID === needed.flag))) fail("DESTRUCTIVE_FIT_UNSUPPORTED");
            const source = read.source.rows.find(r => r.typeID === needed.typeID && !r.singleton);
            if (!source) fail("EQUIPMENT_SOURCE_SHORTAGE");
            kind = needed.kind === "FITTED" ? "FIT_ITEM" : "LOAD_ITEM";
            move = { itemID: source.itemID, typeID: needed.typeID, quantity: Math.min(source.quantity, needed.quantity - present),
              sourceLocationID: source.locationID, shipID: row.manifest.targetHullID, flag: needed.flag,
              destination: needed.flag === 87 ? { kind: "shipBay", bay: "drone" } : { kind: "cargo" } };
          } else {
            const status = inspectContract(row.contract, read.target, data);
            move = await adapter.plan(status.targets.map(t => ({ ...t, eligibleFlags: [5] })), read);
            if (move) { kind = "SUPPLY"; move.flag = 5; }
            else {
              if (status.equipment !== "VERIFIED") fail("FINAL_EQUIPMENT_NOT_VERIFIED");
              row.state = "COMPLETE"; row.result = { ...status, matches: matchFittings(read.contracts, read.target, data) };
              row.manifest.hull.state = "VERIFIED";
              row.manifest.requirements.forEach(r => { r.state = "VERIFIED"; }); save(row); return result(row);
            }
          }
        }
        if (!positive(move.itemID) || !positive(move.quantity)) fail("INVALID_TRANSFER");
        const stable = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
        if (!equal(snapshot(stable), row.expected)) fail("PROVISIONING_STATE_CHANGED");
        const action = { kind, move, requirementKey, sequence: row.actions.length + 1, invocationID: randomUUID(), issuedAt: now(), state: "PENDING", before: snapshot(stable) };
        row.actions.push(action); row.state = "PENDING"; save(row); // fsync/rename BEFORE dispatch.
        try { await adapter.dispatchShip(action, stable, lease); } catch (error) { action.error = String(error.code || "DISPATCH_FAILED"); }
        const after = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
        scope(row, after);
        if (after.context.sessionGeneration !== stable.context.sessionGeneration ||
            after.context.shipID !== (kind === "BOARD_HULL" ? move.itemID : stable.context.shipID)) fail("PROVISIONING_GENERATION_CHANGED");
        const proof = proveShipAction(action, after, verifyMovement);
        if (!proof) { action.after = snapshot(after); action.state = "AMBIGUOUS"; row.state = "BLOCKED"; row.reason = "OUTCOME_AMBIGUOUS"; save(row); return result(row); }
        advance(row, action, after, proof);
        if (kind === "ASSEMBLE_HULL") {
          const assembled = await adapter.readShip(row.input, row.manifest.targetHullID, row.sourcePin);
          if (!assembled.target.complete || assembled.target.rows.length) fail("ASSEMBLED_HULL_NOT_EMPTY");
          row.expected = snapshot(assembled); save(row);
        }
      }
      fail("PROVISIONING_LIMIT");
    } catch (error) {
      if (row) { row.state = row.actions.length ? "BLOCKED" : "REFUSED"; row.reason = String(error.code || "READ_FAILED"); save(row); }
      throw error;
    } finally { release(context.characterID, lease); }
  }
  return { reviewShip, applyShip, reconcileShip };
}
module.exports.createShipOperations = createShipOperations;
