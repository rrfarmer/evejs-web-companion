"use strict";

// What the pilot's ship has locked, and what has it locked, as the retail
// client's target service keeps them (eve/client/script/parklife/targetMgr.py).
//
// The client asks the server for neither while it flies. It asks once, on
// undocking or on logging in in space (ProcessSessionChange 495, which starts
// godma's RefreshTargets, godma.py 2360):
//
//   GetDogmaLM().GetTargets()     each answered scattered as OnTarget('add', id)
//   GetDogmaLM().GetTargeters()   each answered scattered as OnTarget('otheradd', id)
//
// and from then on keeps both right from what the server tells it:
//
//   OnTarget(what, targetID, reason)                       (586)
//       'add'        the ship has it locked       (targetsByID)
//       'lost'       it has not any more
//       'clear'      it has none locked
//       'otheradd'   that one has the ship locked (targetedBy)
//       'otherlost'  it has not any more
//   OnTargets([(time, what, targetID, reason), ...])       (580)
//       each as an OnTarget, without its time
//   OnMultiEvent([((name, ...), time), ...])               (godma.py 206)
//       those named OnTarget, as OnTargets
//
// Two things it does without being told:
//
//   AddTarget(targetID) answering (flag, targets) with a flag that is not set:
//       the lock is made already, and it adds the target itself (_LockTarget 1366)
//   a ball going from the ballpark (DoBallRemove 564): no target any more
//
// Docked, or with its ballpark let go, it has none of either (CleanUp 504,
// DoBallsRemove 543).
//
// Each list is kept as the server would answer it: a list of item IDs, each as
// it came off the wire. A list is unknown until it has been answered or
// emptied, and what the server says of one that is unknown is not kept: there
// is nothing to work it into.
//
// And as the client's (2026-10-16):
//
//   a target named before its ball has come is held until the ball does
//       (OnTargetAdded 600 to 616: pendingTargets; DoBallsAdded_ 533 to 539), and
//       so is one in the server's answer to GetTargets, which the client takes as
//       OnTarget('add') each. One that is lost or let go while held is dropped.
//       A ship that has the pilot's locked is one at once, ball or none
//       (OnTargetByOther 1162: AddTargetedBy, whatever pendingTargeters holds).
//   a whole new state (michelle SetState: DoBallClear, CleanUp 504): nothing
//       locked, and locked by nothing; what is held stays held, for its ball.
//
// A ship that blew up goes at once: OnTargetLost with 'Exploding' plays the
// target's leaving and lets it go in the same breath (ClearDeadTarget, finally
// ClearTarget, 1146 to 1160).

const TARGETS = "targets";
const TARGETERS = "targeters";

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);
/** An item's ID as a key, whichever way it came off the wire. Null for what is no ID. */
function keyOf(value) {
  const id = value && typeof value === "object" && !Buffer.isBuffer(value) ? value.value : value;
  if (typeof id === "bigint") return id > 0n ? String(id) : null;
  const number = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? String(number) : null;
}

/**
 * `hasBall(id)` answers whether the pilot's ballpark has that item's ball now: a target named without one is held
 * until it comes. With none given every ball is taken as there.
 */
function createPilotTargets({ hasBall = () => true } = {}) {
  /** Each list by its name: a Map of key to the ID as it came, in the order they came; null while it is unknown. */
  const kept = { [TARGETS]: null, [TARGETERS]: null };
  /** targetMgr.pendingTargets: the targets named whose balls have not come, by key. */
  const pending = new Map();
  /** Counts everything that could have changed a list, so that an answer asked for before it is not kept after it. */
  let changes = 0;

  const add = (which, id) => {
    const key = keyOf(id);
    // Kept as it came off the wire, a number or a long. One named by the BFF may come as its JSON, and is kept as the number it is.
    if (kept[which] && key !== null) kept[which].set(key, typeof id === "number" || typeof id === "bigint" ? id : Number(key));
  };
  const drop = (which, id) => {
    const key = keyOf(id);
    if (kept[which] && key !== null) kept[which].delete(key);
  };

  /** targetMgr.OnTargetAdded: a target, or held until its ball comes. */
  const added = (id) => {
    const key = keyOf(id);
    if (key === null) return;
    if (hasBall(id)) {
      pending.delete(key);
      add(TARGETS, id);
    } else {
      pending.set(key, id);
    }
  };

  /** targetMgr.OnTarget. */
  function onTarget(what, id) {
    changes += 1;
    if (what === "add") added(id);
    else if (what === "lost") {
      const key = keyOf(id);
      if (key !== null) pending.delete(key);
      drop(TARGETS, id);
    }
    else if (what === "clear") kept[TARGETS] &&= new Map();
    else if (what === "otheradd") add(TARGETERS, id);
    else if (what === "otherlost") drop(TARGETERS, id);
  }

  /**
   * godma.OnMultiEvent (206): events of every kind, each paired with its moment and taken a moment at a time. The
   * target service hears those that are OnTarget (OnMultiEvent_ hands them on as OnTargets). The server sends a lock's
   * every notice this way: alone, as a plain notification, or riding a destiny update (its dogma messages). True when
   * one of them was the target service's.
   */
  function multiEvent(events) {
    const moment = (pair) => (typeof pair[1] === "bigint" ? pair[1] : typeof pair[1] === "number" ? BigInt(Math.trunc(pair[1])) : 0n);
    const told = items(events).map(items).filter((pair) => pair.length >= 2 && text(items(pair[0])[0]) === "OnTarget");
    told.sort((a, b) => {
      const [x, y] = [moment(a), moment(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const [event] of told) {
      const each = items(event);
      onTarget(text(each[1]), each[2]);
    }
    return told.length > 0;
  }

  return {
    /** A notification from the session. True when it was the target service's. */
    feed(notification) {
      if (!Array.isArray(notification.args)) return false;
      if (notification.method === "OnTarget") {
        onTarget(text(notification.args[0]), notification.args[1]);
        return true;
      }
      if (notification.method === "OnTargets") {
        for (const each of items(notification.args[0]).map(items)) onTarget(text(each[1]), each[2]);
        return true;
      }
      if (notification.method === "OnMultiEvent") return multiEvent(notification.args[0]);
      return false;
    },
    multiEvent,
    /** A list as the server would answer it now: { type: "list", items }. Undefined while it is unknown. */
    read(which) {
      return kept[which] ? { type: "list", items: [...kept[which].values()] } : undefined;
    },
    /** What to hand `keep` with the answer of a list that is about to be asked for. */
    asking: () => changes,
    /** The server's answer for a list, asked for at `asked`. Not kept if anything has changed since: it may be from before the change. */
    keep(which, answer, asked) {
      if (asked !== changes || !answer || !Array.isArray(answer.items)) return false;
      kept[which] = new Map();
      // GetTargets' answer is scattered as OnTarget('add') each (godma RefreshTargets): one with no ball is held.
      for (const id of answer.items) {
        if (which === TARGETS) added(id);
        else add(which, id);
      }
      return true;
    },
    /** AddTarget answered that the lock is made: the client adds the target itself (_LockTarget, as OnTargetAdded). */
    added(id) {
      changes += 1;
      added(id);
    },
    /** Balls come into the ballpark: a target held for one of them is a target now (DoBallsAdded_). */
    ballsAdded(ids) {
      if (pending.size === 0) return;
      changes += 1;
      for (const id of ids) {
        const key = keyOf(id);
        if (key === null || !pending.has(key)) continue;
        const named = pending.get(key);
        pending.delete(key);
        add(TARGETS, named);
      }
    },
    /** A whole new state (DoBallClear, CleanUp): nothing locked and locked by nothing; what is held stays held. */
    ballClear() {
      changes += 1;
      if (kept[TARGETS]) kept[TARGETS] = new Map();
      if (kept[TARGETERS]) kept[TARGETERS] = new Map();
    },
    /** Balls gone from the ballpark, by their IDs: none of them is a target any more. */
    ballsRemoved(ids) {
      changes += 1;
      for (const id of ids) {
        const key = keyOf(id);
        if (key !== null) pending.delete(key);
        drop(TARGETS, id);
      }
    },
    /** Docked, or the ballpark let go: nothing locked, and locked by nothing. */
    emptied() {
      changes += 1;
      kept[TARGETS] = new Map();
      kept[TARGETERS] = new Map();
      // DoBallsRemove with the ballpark released: what was held goes too (555).
      pending.clear();
    },
    /** Neither list is known any more: each is asked for when it is next wanted. */
    forget() {
      changes += 1;
      kept[TARGETS] = null;
      kept[TARGETERS] = null;
      pending.clear();
    },
  };
}

module.exports = { createPilotTargets, TARGETS, TARGETERS };
