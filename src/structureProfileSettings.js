"use strict";

function isStructureProfileSettingsList(value) {
  if (value?.type !== "list" || !Array.isArray(value.items)) return false;
  const seen = new Set();
  return value.items.every(row => {
    if (row?.type !== "tuple" || !Array.isArray(row.items) || row.items.length !== 3) return false;
    const [settingID, settingValue, groupID] = row.items;
    if (!Number.isSafeInteger(settingID) || settingID <= 0 || !Number.isSafeInteger(groupID) || groupID < 0
        || !(Number.isFinite(settingValue) || typeof settingValue === "boolean" || typeof settingValue === "string")) return false;
    const key = `${settingID}:${groupID}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { isStructureProfileSettingsList };
