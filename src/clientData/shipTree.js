"use strict";

// evetypes.GetTypeIDsByListID: expand categories, groups, then explicit types.
// Each pass applies that layer's exclusions before the next can add rows back.
function expandClientTypeList(list, types, groups) {
  const ordered = types["#order"] || [];
  const idsOf = value => Array.isArray(value) ? value.map(Number) : [];
  const groupOf = typeID => Number(types[typeID]);
  const select = (ids, valueOf) => {
    const wanted = new Set(idsOf(ids));
    return wanted.size === 0 ? [] : ordered.filter(id => wanted.has(valueOf(id)));
  };
  const minus = (ids, unwanted) => {
    const excluded = new Set(idsOf(unwanted));
    return [...new Set(ids)].filter(id => !excluded.has(id));
  };
  const categoryOf = typeID => Number(groups[groupOf(typeID)]?.categoryID);
  const categories = minus(select(list.includedCategoryIDs, categoryOf), select(list.excludedCategoryIDs, categoryOf));
  const grouped = minus([...categories, ...select(list.includedGroupIDs, groupOf)], select(list.excludedGroupIDs, groupOf));
  return minus([...grouped, ...idsOf(list.includedTypeIDs)], list.excludedTypeIDs);
}

// ShipTree._InitShipTypeIDDict: Academy hulls are kept apart, even when the type is published.
function shipTreeTypeIndex({ academyList, typeGroups, groups, typeShipGroups, typeFactions, typePublished }) {
  const academy = new Set(expandClientTypeList(academyList, typeGroups, groups));
  const rows = [];
  for (const typeID of typeGroups["#order"] || []) {
    const group = groups[typeGroups[typeID]];
    const factionID = Number(typeFactions[typeID]);
    const shipGroupID = Number(typeShipGroups[typeID]);
    if (Number(group?.categoryID) !== 6 || !factionID || !shipGroupID) continue;
    const isAcademy = academy.has(typeID);
    if (isAcademy || (Number(group.published) && Number(typePublished[typeID]))) {
      rows.push({ typeID, factionID, shipGroupID, academy: isAcademy });
    }
  }
  return rows;
}

module.exports = { expandClientTypeList, shipTreeTypeIndex };
