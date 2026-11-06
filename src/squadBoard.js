"use strict";

// Shared, in-process SQUAD BOARD: the one thing a fleet's bots need to say to
// each other while they are shooting — which ship is the primary.
//
// WHY THIS EXISTS. Every combat block picks its own target from its own grid
// read (nav/targetPriority.ts ranks it, distance breaks the tie), and each
// pilot is its own browser tab or its own server-bot session. Two pilots on one
// grid therefore converge on the hostile each ranks first FOR ITSELF, which is
// routinely two different ships: three bots each take a third of the damage off
// a rat that dies to none of them. Nothing in the game read tells a client what
// a fleet-mate is shooting — a snapshot row carries position, health, owner and
// type, never a target — so the pilots have to say it themselves.
//
// SHARED, NOT PERSISTED, AND NOT A GAME WRITE. This is BFF-local bookkeeping,
// exactly like src/beltMemory.js: no gateway call in either direction, nothing
// the game validates, nothing that survives a restart. It coordinates clients;
// it does not touch the world.
//
// ⚠ THE IN-GAME EQUIVALENT NOW EXISTS, AND THIS BOARD IS THE FALLBACK.
// This comment used to say a fleet broadcast or a target tag was "a separate,
// later job: the write side is plumbed but nothing in the client can READ a
// tag back yet". Both halves are now read: web/src/bridge/fleetBroadcasts.ts
// decodes OnFleetBroadcast and the OnFleetStateChange target tags. So a
// following pilot's precedence is in-game tag first, then a Target broadcast,
// then THIS board, then its own ladder — because a real fleet mechanism is
// visible to every pilot in the fleet including the humans, and this board is
// visible only to bots on one BFF.
//
// It is not obsolete and should not be deleted. It is the answer when nobody
// is broadcasting or tagging at all, which is most of the time in a fleet of
// bots with no human FC driving it.
//
// ⚠ THE 30s TTL BELOW IS DUPLICATED, NOT SHARED, AND SOMEBODY SHOULD DECIDE
// WHICH IT OUGHT TO BE. `DEFAULT_TTL_MS` here and `FLEET_BROADCAST_TTL_MS` in
// web/src/bridge/fleetBroadcasts.ts are two constants holding 30000 in two
// languages, for the same reason (a call goes stale in seconds), with nothing
// that fails if one of them changes.
//
// That is the shape of a bug this project has already been bitten by once --
// see PLUGIN_RUN_GRANT_REV in web/src/bots/runPolicy.ts, which
// was a bare 1 copied into src/botHost.js until the copies were collapsed into
// one home. The consequence here is milder than that one was: a drift would
// mean a follower treats a board call and a fleet broadcast as lapsing at
// different moments, which reads as a bot obeying one order source and
// ignoring the other for a few seconds -- confusing, not wrong.
//
// It is left duplicated for now because this module is loaded at BFF start and
// pulling a TypeScript constant in here means a type-stripped dynamic import
// (the mechanism botHost.js uses), which is real machinery for one number.
// Recorded rather than silently accepted.
//
// ONE CALL PER FLEET, LAST CALL WINS. There is no queue and no arbitration: the
// FC is whoever spoke most recently, which is what "primary" means over voice
// too. A fleet with two bots both calling is a fleet whose owner asked for
// that.
//
// ⚠ A CALL GOES STALE FAST — SECONDS, NOT HOURS. A belt stays mined out long
// enough for an hour's memory to be useful; a primary stops being one the
// moment it dies, warps off, or the fight ends, and a bot that kept obeying a
// stale call would sit pointing its guns at a wreck instead of re-picking. So
// the ttl here is deliberately short and the entry simply expires — a follower
// then falls back to its own ladder, which is a working bot, not a stopped one.
//
// KEYED BY FLEET, AS AN EXACT DECIMAL STRING. A fleet id is a game id and can
// be larger than 2^53 (a live one already reads 654500010000), so it is never
// coerced through Number here — the caller hands in whatever exact string the
// BFF resolved from the fleet's own GetInitState, and this file only ever
// compares it. Keying by fleet is also the whole access rule: a session can
// only read or write the board of the fleet the SERVER resolved for it, so one
// operator's fleets cannot see each other's calls, let alone another account's.
//
// PURE. No I/O, no timers of its own — `now` is injected so tests control the
// clock exactly, the same shape as src/beltMemory.js and src/accountCache.js.

/**
 * How long a called primary stands before it is treated as stale. Two ticks of
 * the bot runner's ~2s cadence would be too tight (one slow read and a
 * follower loses the call mid-fight); a minute would be far too long (the whole
 * engagement is usually over). Thirty seconds is "this fight", and a caller
 * that is still shooting re-calls long before it lapses.
 */
const DEFAULT_TTL_MS = 30 * 1000;

function exactFleetKey(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim()) && value.trim() !== "0") {
    return value.trim();
  }
  return "";
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]     How long a call stands before it lapses.
 * @param {() => number} [options.now] Clock injection, for tests.
 */
function createSquadBoard(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;

  // fleetKey -> { targetID, calledByCharacterID, expiresAtMs }
  const fleets = new Map();

  /**
   * Call a primary for `fleetID`. `targetID` is the entity id of the ship on
   * the caller's grid; `calledByCharacterID` is who called it, so a follower's
   * readout can say whose call it is obeying rather than a bare number.
   *
   * Returns the stored call, or null when the fleet or the target did not look
   * like ids — a bad call is dropped rather than stored, because a board entry
   * nobody can match to a ship on grid is indistinguishable from no call at all
   * and would only take the place of a good one.
   */
  function call(fleetID, targetID, calledByCharacterID) {
    const key = exactFleetKey(fleetID);
    const target = Number(targetID);
    if (!key || !Number.isSafeInteger(target) || target <= 0) {
      return null;
    }
    const caller = Number(calledByCharacterID);
    const entry = {
      targetID: target,
      calledByCharacterID: Number.isSafeInteger(caller) && caller > 0 ? caller : null,
      expiresAtMs: now() + ttlMs,
    };
    fleets.set(key, entry);
    return { targetID: entry.targetID, calledByCharacterID: entry.calledByCharacterID };
  }

  /**
   * Drop the fleet's call — the fight is over, or the caller has stopped. Safe
   * to send when there is nothing to clear; answers whether there was.
   */
  function clear(fleetID) {
    const key = exactFleetKey(fleetID);
    return key ? fleets.delete(key) : false;
  }

  /**
   * The fleet's standing call, or null when there is none. A lapsed entry is
   * dropped as part of this read and never returned: "nobody has called
   * anything" is the honest answer once a call has gone stale, and it is the
   * answer that puts a follower back on its own ladder.
   */
  function primary(fleetID) {
    const key = exactFleetKey(fleetID);
    if (!key) {
      return null;
    }
    const entry = fleets.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs <= now()) {
      fleets.delete(key);
      return null;
    }
    return { targetID: entry.targetID, calledByCharacterID: entry.calledByCharacterID };
  }

  return { call, clear, primary };
}

module.exports = { createSquadBoard, DEFAULT_TTL_MS };
