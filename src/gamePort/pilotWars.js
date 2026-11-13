"use strict";

/**
 * A pilot's wars, kept as the retail client's war service keeps them
 * (eve/client/script/ui/services/wars/war_cso.py).
 *
 * The service keeps the wars it was told of by their IDs (warsByWarID), and for each owner it asked about, when
 * it asked and which wars answered (warsByOwnerID). An owner's wars are good for twelve hours (GetWars, 98 to
 * 106): after that, or when the asker forces it, what was kept of the owner is let go and the server is asked.
 * What it answers is that owner's from then on, and wars that no owner kept names any more are let go
 * (PopulateCacheAndCleanupWars, 108 to 121).
 *
 * The server's OnWarChanged(war, ownerIDs, change) is worked into what is kept, and nothing is asked (82 to 96,
 * by evewar/util.py HandleWarChange, 183 to 202): where the change says the war's ID is gone, the war of the old
 * ID is taken out; otherwise the war is the war of its ID from then on, and is among the wars of each of its
 * owners that is kept.
 *
 * Everything is kept as it came off the wire, so what is read back is in the form the server answers GetWars in:
 * a dict of each war by its ID. A war's ID is read from the war itself (war.warID), as the client reads it. An
 * answer with a war this cannot read an ID from is not kept, and a notice it cannot read changes nothing, as a
 * notice the client's handler fails on changes nothing there.
 */

/** GetWars (100): an owner's wars are asked for again once they are more than twelve hours old. */
const GOOD_FOR_MS = 12 * 60 * 60 * 1000;

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const isDict = (value) => Boolean(value && value.type === "dict" && Array.isArray(value.entries));
const isKeyVal = (value) => Boolean(value && value.type === "object" && isDict(value.args));
/** A util.KeyVal's field, by name: undefined where it has none. */
const field = (keyVal, name) => {
  const entry = isKeyVal(keyVal) ? keyVal.args.entries.find(([key]) => text(key) === name) : undefined;
  return entry ? entry[1] : undefined;
};
/** An ID off the wire as one text for its number, however it was sent; null for what is no ID. */
const keyOf = (value) => (typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : null);
/** What a tuple or a list off the wire holds; null for anything else. */
// A list, a tuple, or a set - as the server sends OnWarChanged's owners (corporationNotifications.notifyWarChanged:
// buildPythonSet, an objectex1 of __builtin__.set over a one-tuple of its list; structureDirectory.py reads them as a set).
const membersOf = (value) => {
  if (value && value.type === "objectex1" && Array.isArray(value.header) && value.header[0] && value.header[0].value === "__builtin__.set") {
    value = Array.isArray(value.header[1]) ? value.header[1][0] : null;
  }
  return Array.isArray(value) ? value : value && value.type === "list" && Array.isArray(value.items) ? value.items : null;
};

function createPilotWars() {
  /** warsByWarID: each war by its ID's text, as { id, war }: the ID as the war has it, and the war as it came. */
  const byWarID = new Map();
  /** warsByOwnerID: for each owner asked about, when it was asked and the IDs of the wars that answered. */
  const byOwner = new Map();

  return {
    /**
     * GetWars(ownerID, forceRefresh), up to its asking (98 to 106): the owner's wars as they are kept, each by its
     * ID, in the form the server answers in. Undefined where none are kept of the owner, where they are more than
     * twelve hours old, or where the asker forces it: what was kept of the owner is let go then, and is to be
     * asked for.
     */
    kept(ownerID, nowMs, forceRefresh = false) {
      const key = keyOf(ownerID);
      const had = key === null ? undefined : byOwner.get(key);
      if (!had) return undefined;
      if (forceRefresh || nowMs - had.at > GOOD_FOR_MS) {
        byOwner.delete(key);
        return undefined;
      }
      return { type: "dict", entries: [...had.warIDs].filter((id) => byWarID.has(id)).map((id) => [byWarID.get(id).id, byWarID.get(id).war]) };
    },
    /**
     * PopulateCacheAndCleanupWars (108 to 121): what the server answered of an owner's wars is that owner's from
     * now, and wars no owner kept names any more are let go. Answers whether it was kept: false for an answer in
     * a form this does not read, which changes nothing.
     */
    keep(ownerID, answer, nowMs) {
      const key = keyOf(ownerID);
      if (key === null || !isDict(answer)) return false;
      const wars = answer.entries.map((entry) => ({ id: field(entry[1], "warID"), war: entry[1] }));
      if (wars.some(({ id }) => keyOf(id) === null)) return false;
      for (const each of wars) byWarID.set(keyOf(each.id), each);
      byOwner.set(key, { at: nowMs, warIDs: new Set(wars.map(({ id }) => keyOf(id))) });
      const named = new Set();
      for (const { warIDs } of byOwner.values()) for (const id of warIDs) named.add(id);
      for (const id of [...byWarID.keys()]) if (!named.has(id)) byWarID.delete(id);
      return true;
    },
    /**
     * OnWarChanged(war, ownerIDs, change), as HandleWarChange works it in (evewar/util.py 183 to 202). `args` are
     * the notice's own. A notice of other than three, or one this cannot read, changes nothing.
     */
    changed(args) {
      if (!Array.isArray(args) || args.length !== 3) return;
      const [war, ownerIDs, change] = args;
      if (!isDict(change)) return;
      // change.get('warID'): (the old ID, the new one), where the war's ID is among what changed.
      const idChange = (change.entries.find(([key]) => text(key) === "warID") ?? [])[1];
      const pair = idChange === undefined || idChange === null ? [] : membersOf(idChange);
      if (pair === null || (pair.length !== 0 && pair.length !== 2)) return;
      if (pair.length === 2 && pair[1] === null) {
        const old = keyOf(pair[0]);
        if (old !== null) byWarID.delete(old);
        return;
      }
      const id = field(war, "warID");
      const key = keyOf(id);
      if (key === null) return;
      byWarID.set(key, { id, war });
      for (const ownerID of membersOf(ownerIDs) ?? []) {
        const had = byOwner.get(keyOf(ownerID));
        if (had) had.warIDs.add(key);
      }
    },
    /** warsByOwnerID.pop(ownerID, None) (OnSessionChanged, 75 to 77): what is kept of an owner's wars is let go. */
    forget(ownerID) {
      const key = keyOf(ownerID);
      if (key !== null) byOwner.delete(key);
    },
  };
}

module.exports = { GOOD_FOR_MS, createPilotWars };
