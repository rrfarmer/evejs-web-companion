"use strict";

// A bank is evidence only when this requested slave is explicitly in it.
function moduleActive(ids, itemID, banks) {
  if (!Array.isArray(ids)) return null;
  if (ids.includes(itemID)) return true;
  if (banks && typeof banks === "object") {
    for (const [master, slaves] of Object.entries(banks)) {
      if (Array.isArray(slaves) && slaves.map(Number).includes(itemID)) {
        return ids.includes(Number(master));
      }
    }
    return false;
  }
  return ids.length === 0 ? false : null;
}

module.exports = { moduleActive };
