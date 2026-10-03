"use strict";
const { createOperationJournal } = require("./operationJournal");
const { hash, fail, inspectContract, matchFittings } = require("./provisioningContracts");
const sum = (rows, typeID) => rows.filter(row => row.typeID === typeID).reduce((n, row) => n + row.quantity, 0);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validRows = rows => Array.isArray(rows) && rows.every(row => positive(row.itemID) && positive(row.typeID) && positive(row.quantity));

function verifyMovement(before, after, move) {
  const old = before.source.find(row => row.itemID === move.itemID);
  const current = after.source.find(row => row.itemID === move.itemID);
  if (!old || old.typeID !== move.typeID || (current && current.typeID !== move.typeID)) return "AMBIGUOUS";
  const selected = old.quantity - (current?.quantity || 0);
  const source = sum(before.source, move.typeID) - sum(after.source, move.typeID);
  const destination = sum(after.destination, move.typeID) - sum(before.destination, move.typeID);
  // Never prove acquisition by deleting someone else's pre-existing cargo.
  const otherTypes = new Set(before.destination.filter(r => r.typeID !== move.typeID).map(r => r.typeID));
  if ([...otherTypes].some(type => sum(before.destination, type) !== sum(after.destination, type))) return "AMBIGUOUS";
  return selected === move.quantity && source === move.quantity && destination === move.quantity ? "VERIFIED" : "AMBIGUOUS";
}

function createReplenishment({ filePath = null, operations, data, now = Date.now }) {
  const journal = createOperationJournal({ filePath });
  for (const row of journal.list()) {
    if (!positive(row.accountID) || !positive(row.characterID) || !row.context ||
        row.context.accountID !== row.accountID || row.context.characterID !== row.characterID || !positive(row.context.shipID) ||
        !positive(row.context.locationID) || !digest(row.reviewHash) || !digest(row.contract?.definitionFingerprint) || !row.sourcePin ||
        !Array.isArray(row.moves) || !["PREPARED", "PENDING", "BLOCKED", "COMPLETE", "REFUSED", "RECONCILED"].includes(row.state) ||
        row.moves.some(move => !positive(move.itemID) || !positive(move.typeID) || !positive(move.quantity) ||
          move.shipID !== row.context.shipID || !positive(move.sequence) || !["PENDING", "VERIFIED", "AMBIGUOUS"].includes(move.state) ||
          !validRows(move.before?.source) || !validRows(move.before?.destination) ||
          (move.state === "VERIFIED" && (!validRows(move.after?.source) || !validRows(move.after?.destination) ||
            verifyMovement(move.before, move.after, move) !== "VERIFIED"))) ||
        (["COMPLETE", "RECONCILED", "PREPARED", "REFUSED"].includes(row.state) && row.moves.some(move => move.state !== "VERIFIED")))
      fail("CUSTODY_JOURNAL_INVALID");
  }
  const reviews = new Map();
  const unresolved = pilot => journal.list().filter(row => row.characterID === pilot && ["PENDING", "BLOCKED"].includes(row.state));
  function assertWritable(pilot, lease = null) {
    const active = operations.get(pilot);
    if (lease && active !== lease) fail("REPLENISHMENT_GENERATION_CHANGED");
    if ((active?.kind === "replenishment" && active !== lease) || unresolved(pilot).some(row => row.key !== lease?.id))
      fail("REPLENISHMENT_CUSTODY", "This pilot has active or unresolved replenishment custody. Reconcile it first.");
    if (active?.kind === "bridge-write" && active !== lease) fail("CHARACTER_IN_USE");
  }
  function enterWrite(pilot, lease = null) {
    assertWritable(pilot, lease);
    // Existing Factory/session lifecycle reservations already cover their
    // writes. The replenishment capability owns its entire Apply sequence.
    if (operations.has(pilot)) return () => {};
    const reservation = { kind: "bridge-write" };
    operations.set(pilot, reservation);
    return () => { if (operations.get(pilot) === reservation) operations.delete(pilot); };
  }
  function assertSelectable(pilot) {
    const active = operations.get(pilot);
    if (active?.kind === "replenishment") fail("REPLENISHMENT_CUSTODY");
    if (active?.kind === "bridge-write") fail("CHARACTER_IN_USE");
  }
  function reserve(pilot, id, reconciling = false) {
    if (operations.has(pilot)) fail("CHARACTER_IN_USE");
    if (!reconciling && unresolved(pilot).length) fail("REPLENISHMENT_CUSTODY");
    const lease = { kind: "replenishment", id };
    operations.set(pilot, lease); return lease;
  }
  function release(pilot, lease) { if (operations.get(pilot) === lease) operations.delete(pilot); }
  async function review(adapter, input) {
    const read = await adapter.read(input);
    const status = inspectContract(read.contract, read.observation, data);
    const matches = matchFittings(read.contracts, read.observation, data);
    const pin = { context: read.context, definition: read.contract.definitionFingerprint,
      equipment: read.contract.equipmentFingerprint, policy: read.contract.supplyPolicyFingerprint,
      observed: hash(read.observation), source: read.source.pin, stock: hash(read.source.rows), access: read.source.access };
    const reviewID = require("node:crypto").randomUUID();
    const record = { input, pin, read, expiresAt: now() + 5 * 60_000 };
    reviews.set(reviewID, record);
    for (const [key, value] of reviews) if (value.expiresAt < now()) reviews.delete(key);
    const pending = unresolved(read.context.characterID).map(row => ({ operationID: row.key, state: row.state }));
    return { reviewID, reviewHash: hash(pin), contract: read.contract, context: read.context, status, matches,
      source: { pin: read.source.pin, access: read.source.access,
        available: status.targets.map(target => ({ typeID: target.typeID, quantity: sum(read.source.rows, target.typeID) })) },
      pending, canApply: status.equipment !== "UNKNOWN" && status.supplies !== "UNKNOWN" && read.context.recoveryReady !== false &&
        read.observation.complete && read.source.access.take === true && !pending.length,
      expiresAt: record.expiresAt };
  }
  async function apply(adapter, { reviewID, reviewHash }) {
    const context = await adapter.context();
    const existing = journal.get(reviewID);
    if (existing) {
      if (existing.accountID !== context.accountID || existing.characterID !== context.characterID) fail("OPERATION_NOT_OWNED");
      if (existing.reviewHash !== reviewHash) fail("REVIEW_REQUIRED");
      return { operationID: reviewID, state: existing.state, result: existing.result || null };
    }
    const accepted = reviews.get(reviewID);
    if (!accepted || accepted.expiresAt < now() || hash(accepted.pin) !== reviewHash ||
        hash(context) !== hash(accepted.read.context)) fail("REVIEW_REQUIRED");
    const lease = reserve(context.characterID, reviewID);
    let row;
    try {
      const fresh = await adapter.read(accepted.input);
      const freshPin = { context: fresh.context, definition: fresh.contract.definitionFingerprint,
        equipment: fresh.contract.equipmentFingerprint, policy: fresh.contract.supplyPolicyFingerprint,
        observed: hash(fresh.observation), source: fresh.source.pin, stock: hash(fresh.source.rows), access: fresh.source.access };
      if (hash(freshPin) !== reviewHash || !fresh.observation.complete || fresh.context.recoveryReady === false ||
          ![true, false].includes(fresh.source.access.take)) fail("REVIEW_REQUIRED");
      row = { accountID: context.accountID, characterID: context.characterID, context, reviewHash,
        input: accepted.input, contract: fresh.contract, sourcePin: fresh.source.pin, access: fresh.source.access,
        state: "PREPARED", moves: [], createdAt: now() };
      // A stable, authoritative denial is custody evidence too. The catch
      // persists REFUSED before returning; it must never resemble completion.
      if (fresh.source.access.take === false) fail("SOURCE_TAKE_DENIED", "The selected source does not authorize Take. No transfer was dispatched.");
      journal.put(reviewID, row);
      for (let count = 0; count < 128; count++) {
        const current = await adapter.read(accepted.input);
        if (hash(current.context) !== hash(context) || current.contract.definitionFingerprint !== row.contract.definitionFingerprint ||
            hash(current.source.pin) !== hash(row.sourcePin) || hash(current.source.access) !== hash(row.access) ||
            !current.observation.complete || current.source.access.take !== true) fail("REVIEW_REQUIRED");
        const status = inspectContract(row.contract, current.observation, data);
        const move = await adapter.plan(status.targets, current);
        if (!move) {
          row.state = "COMPLETE"; row.result = { ...status, matches: matchFittings(current.contracts, current.observation, data) };
          journal.put(reviewID, row); return { operationID: reviewID, state: row.state, result: row.result };
        }
        if (!positive(move.itemID) || !positive(move.typeID) || !positive(move.quantity) || move.shipID !== context.shipID)
          fail("INVALID_TRANSFER");
        await adapter.validateMove(move, current, lease);
        const before = await adapter.readMovement(move, row.sourcePin);
        const selected = before.source.find(r => r.itemID === move.itemID);
        if (!selected || selected.typeID !== move.typeID || move.quantity > selected.quantity) fail("SOURCE_CHANGED");
        const target = status.targets.find(t => t.typeID === move.typeID);
        if (!target || move.quantity > target.deficit) fail("INVALID_DEFICIT");
        const stable = await adapter.read(accepted.input);
        if (hash(stable.context) !== hash(context) || hash(stable.observation) !== hash(current.observation) ||
            hash(stable.source.rows) !== hash(current.source.rows) || hash(stable.source.pin) !== hash(row.sourcePin) || hash(stable.source.access) !== hash(row.access) ||
            stable.contract.definitionFingerprint !== row.contract.definitionFingerprint) fail("REVIEW_REQUIRED");
        const invocation = { ...move, before, state: "PENDING", sequence: row.moves.length + 1, issuedAt: now() };
        row.moves.push(invocation); row.state = "PENDING";
        journal.put(reviewID, row); // Durable fence BEFORE gateway dispatch.
        let error = null;
        try { await adapter.dispatch(move, current, lease); } catch (caught) { error = caught; }
        const after = await adapter.readMovement(move, row.sourcePin);
        invocation.after = after;
        invocation.state = verifyMovement(before, after, move);
        if (error) invocation.error = String(error.code || "DISPATCH_FAILED");
        if (invocation.state !== "VERIFIED") {
          row.state = "BLOCKED"; journal.put(reviewID, row);
          return { operationID: reviewID, state: row.state, result: null };
        }
        row.state = "PREPARED"; journal.put(reviewID, row);
      }
      fail("REPLENISHMENT_LIMIT");
    } catch (error) {
      if (row) {
        row.state = row.moves.some(move => move.state === "PENDING" || move.state === "AMBIGUOUS") ? "BLOCKED" : "REFUSED";
        row.reason = String(error.code || "READ_FAILED"); journal.put(reviewID, row);
      }
      throw error;
    } finally { release(context.characterID, lease); }
  }
  async function reconcile(adapter, id) {
    const context = await adapter.context();
    const row = journal.get(id);
    if (!row || row.accountID !== context.accountID || row.characterID !== context.characterID) fail("OPERATION_NOT_OWNED");
    const lease = reserve(context.characterID, id, true);
    try {
      // A new held generation may read evidence, but never automatically resend.
      if (context.shipID !== row.context.shipID || context.locationID !== row.context.locationID ||
          context.corporationID !== row.context.corporationID) fail("RECONCILIATION_SCOPE_CHANGED");
      for (const move of row.moves.filter(m => m.state !== "VERIFIED")) {
        move.after = await adapter.readMovement(move, row.sourcePin);
        move.state = verifyMovement(move.before, move.after, move);
      }
      row.state = row.moves.every(m => m.state === "VERIFIED") ? "RECONCILED" : "BLOCKED";
      journal.put(id, row); return { operationID: id, state: row.state, result: row.result || null };
    } finally { release(context.characterID, lease); }
  }
  return { review, apply, reconcile, assertWritable, assertSelectable, enterWrite, unresolved, journal };
}
module.exports = { createReplenishment, verifyMovement };
