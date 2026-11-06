"use strict";

// Shared, in-process LOOT MEMORY: which wrecks and cans on a grid have already
// been emptied, so the next pilot does not fly to them.
//
// WHY THIS EXISTS. A wreck's contents cannot be read from across the grid. The
// server gates `invbroker` on 2,500 m (invBrokerService's
// MAX_CARGO_CONTAINER_TRANSFER_DISTANCE_METERS), and the one field that DOES
// say "there is nothing in this" — the slim item's `isEmpty`, which is why the
// retail client can draw an empty wreck differently — rides `DoDestinyUpdate`,
// the single notification the web gateway suppresses. So a bot learns a
// wreck is empty by FLYING TO IT, and that is the whole cost this module
// exists to stop paying more than once.
//
// Paying it once is unavoidable. Paying it once PER PILOT is not: every
// bot keeps its own record of what it emptied, so in a fleet of four the
// second, third and fourth
// pilot each fly the same wreck the first one already drained. Reported into
// here, the first pilot's trip answers the question for all of them — and for
// the hand-flown client too, because the overview's own loot verb goes through
// the same `lootIntoShip`.
//
// SHARED, NOT PERSISTED, AND NOT A GAME WRITE. BFF-local bookkeeping, exactly
// like src/beltMemory.js and src/squadBoard.js: no gateway call in either
// direction, nothing the game validates, nothing that survives a restart.
//
// ⚠ "EMPTIED" IS A FACT ABOUT THE CAN, NEVER ABOUT THE SHIP THAT LOOKED. Only
// two outcomes may be reported here: the can held nothing, or everything in it
// was taken. "It did not all fit in my hold" is a fact about THAT hull and must
// stay in that pilot's own ledger — a barge with a full ore hold would
// otherwise tell a hauler with room to skip a full can.
//
// ⚠ A CAN THAT SOMEBODY REFILLS IS THE ONE WAY A MARK CAN GO WRONG. A wreck is
// only ever emptied, but a jettisoned container can be topped up again, and a
// pilot reading this would skip it until the mark expires. That is the same
// behaviour each pilot's own loot ledger has always had within a run — this
// only widens it to the fleet — and the TTL below is what bounds it.
//
// PURE. No I/O, no timers of its own — `now` is injected so tests control the
// clock exactly, the same shape as src/beltMemory.js.

// Two hours: a wreck despawns well inside that, so an id is forgotten long
// after it stopped naming anything real, never before.
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
// A bound on one system's list, so a session left running all night in a busy
// belt cannot grow this without limit. Oldest marks go first; losing one costs
// a single wasted approach, which is exactly what the memory was saving.
const DEFAULT_MAX_PER_SYSTEM = 4000;
const CONTAINER_LEASE_MS = 5 * 60 * 1000;

function normalizeID(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]         How long a mark stays valid.
 * @param {number} [options.maxPerSystem]  How many ids one system may hold.
 * @param {() => number} [options.now]     Clock injection, for tests.
 */
function createLootMemory(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxPerSystem =
    Number.isFinite(options.maxPerSystem) && options.maxPerSystem > 0
      ? Math.trunc(options.maxPerSystem)
      : DEFAULT_MAX_PER_SYSTEM;
  const now = typeof options.now === "function" ? options.now : Date.now;

  // systemID -> Map<itemID, expiresAtMs>. Insertion order is the age order a
  // Map already keeps, which is what makes the cap above cost nothing.
  const systems = new Map();
  // One active servicing run per physical container. An issued inventory move
  // pins the lease through normal stop/session cleanup; uncertainty is bounded
  // by the same five-minute lease rather than advertised as a free target.
  const claims = new Map();
  const claimKey = (systemID, itemID) => `${systemID}:${itemID}`;
  function pruneClaims() {
    const cutoff = now();
    for (const [key, claim] of claims) {
      if (claim.expiresAt <= cutoff) claims.delete(key);
    }
  }
  function releaseClaims(sessionID, runID) {
    pruneClaims();
    for (const [key, claim] of claims) {
      if (claim.sessionID !== sessionID || (runID !== undefined && claim.runID !== runID)) continue;
      if (claim.inFlight > 0 || claim.ambiguous) claim.pendingRelease = true;
      else claims.delete(key);
    }
  }
  function claimContainer(sessionID, runID, systemID, itemID, renewOnly = false) {
    const system = normalizeID(systemID), item = normalizeID(itemID);
    if (!sessionID || !runID || !system || !item) throw new Error("Invalid container claim");
    pruneClaims();
    const key = claimKey(system, item);
    const current = claims.get(key);
    const owned = current?.sessionID === sessionID && current?.runID === runID;
    if ((current && !owned) || (renewOnly && !owned) || current?.pendingRelease || current?.ambiguous) return false;
    if (owned) {
      // Never rewrite the record: an in-flight pin or ambiguous outcome is
      // evidence that a later release must respect.
      current.expiresAt = now() + CONTAINER_LEASE_MS;
      return true;
    }
    // A run can service one target at a time. An earlier issued move is not
    // surrendered just because the browser changed its selected target.
    releaseClaims(sessionID, runID);
    claims.set(key, {
      sessionID, runID, expiresAt: now() + CONTAINER_LEASE_MS,
      inFlight: 0, ambiguous: false, pendingRelease: false,
    });
    return true;
  }
  function claimedItemIDs(systemID, sessionID, runID) {
    const system = normalizeID(systemID);
    if (!system) return null;
    pruneClaims();
    return [...claims.entries()]
      .filter(([key, claim]) => key.startsWith(`${system}:`) &&
        !(claim.sessionID === sessionID && claim.runID === runID))
      .map(([key]) => Number(key.slice(key.indexOf(":") + 1)));
  }
  function beginTransfer(sessionID, runID, systemID, itemID) {
    pruneClaims();
    const claim = claims.get(claimKey(systemID, itemID));
    if (!claim || claim.sessionID !== sessionID || claim.runID !== runID || claim.pendingRelease) return false;
    claim.inFlight += 1;
    claim.expiresAt = now() + CONTAINER_LEASE_MS;
    return true;
  }
  function endTransfer(sessionID, runID, systemID, itemID, settled) {
    const key = claimKey(systemID, itemID);
    const claim = claims.get(key);
    if (!claim || claim.sessionID !== sessionID || claim.runID !== runID) return;
    claim.inFlight = Math.max(0, claim.inFlight - 1);
    if (!settled) claim.ambiguous = true;
    if (claim.pendingRelease && claim.inFlight === 0 && !claim.ambiguous) claims.delete(key);
  }

  function prune(itemMap) {
    const cutoff = now();
    for (const [itemID, expiresAtMs] of itemMap) {
      if (expiresAtMs <= cutoff) {
        itemMap.delete(itemID);
      }
    }
  }

  /**
   * Record that `itemID` in `systemID` was found with nothing left in it.
   * A repeat mark refreshes the expiry and moves the id to the young end.
   */
  function markEmptied(systemID, itemID) {
    const system = normalizeID(systemID);
    const item = normalizeID(itemID);
    if (!system || !item) {
      return;
    }
    let itemMap = systems.get(system);
    if (!itemMap) {
      itemMap = new Map();
      systems.set(system, itemMap);
    } else {
      prune(itemMap);
    }
    // Delete before set so a re-mark lands at the END of the insertion order —
    // without it the cap would evict an id that was just confirmed.
    itemMap.delete(item);
    itemMap.set(item, now() + ttlMs);
    while (itemMap.size > maxPerSystem) {
      const oldest = itemMap.keys().next();
      if (oldest.done) {
        break;
      }
      itemMap.delete(oldest.value);
    }
  }

  /** Every id in `systemID` still known to be emptied. Never null. */
  function emptiedItemIDs(systemID) {
    const system = normalizeID(systemID);
    if (!system) {
      return [];
    }
    const itemMap = systems.get(system);
    if (!itemMap) {
      return [];
    }
    prune(itemMap);
    if (itemMap.size === 0) {
      systems.delete(system);
      return [];
    }
    return [...itemMap.keys()];
  }

  return { markEmptied, emptiedItemIDs, claimContainer, claimedItemIDs, releaseClaims, beginTransfer, endTransfer };
}

module.exports = { createLootMemory, CONTAINER_LEASE_MS };
