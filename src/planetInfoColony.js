"use strict";

// A pilot's colonies as the retail client reads them, made into what the BFF's
// colony projection reads.
//
// The client asks planetMgr.GetPlanetsForChar() for the planets it has colonies
// on (planetSvc.py 65), and each planet's own object for GetPlanetInfo()
// (clientPlanet.py 83) and, where it shows what a planet carries, for
// GetPlanetResourceInfo() (clientPlanet.py 644). The BFF's projection
// (server.js projectColony) was written against the server's stored colony
// row, which the web gateway's snapshot hands out. The answers of the client's
// calls carry the same facts under nearly the same names: a pin's `id` is the
// row's `pinID`, and a time is a long where the row has its digits as text.
//
// Everything here reads the game port's answers in the form the BFF hands them
// on in (src/gamePort/bridgeJson.js).

/** A wire value as plain data: a KeyVal and a dict as objects, a list and a tuple as arrays, a long as its digits, a real as its number. */
function plain(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== "object") return value;
  switch (value.type) {
    case "long": return String(value.value);
    case "real": return Number(value.value);
    case "list":
    case "tuple": return Array.isArray(value.items) ? value.items.map(plain) : [];
    case "dict": return Object.fromEntries((Array.isArray(value.entries) ? value.entries : []).map(([key, entry]) => [String(plain(key)), plain(entry)]));
    case "object": return value.name === "util.KeyVal" ? plain(value.args) : null;
    default: return null;
  }
}

/** The rows of a CRowset as the game port hands one on, each by its columns' names; null where it is no rowset. */
function rowsetRows(rowset) {
  if (!rowset || typeof rowset !== "object" || !Array.isArray(rowset.list)) return null;
  return rowset.list
    .filter((row) => row && Array.isArray(row.columns) && Array.isArray(row.values))
    .map((row) => Object.fromEntries(row.columns.map((column, at) => [String(column[0]), plain(row.values[at])])));
}

/** The planets GetPlanetsForChar answered, by their IDs; null where the answer is no rowset. */
function planetIDsOf(rowset) {
  const rows = rowsetRows(rowset);
  return rows === null ? null : rows.map((row) => Number(row.planetID) || 0).filter((planetID) => planetID > 0);
}

/**
 * GetPlanetInfo's answer as the stored colony row has it. Null where the answer
 * has no colony of the pilot's in it: a planet's own facts come back alone
 * then, with no pins.
 */
function colonyRowOf(planetInfo) {
  const info = plain(planetInfo);
  if (!info || typeof info !== "object" || Array.isArray(info) || !Array.isArray(info.pins)) return null;
  return {
    planetID: info.planetID,
    solarSystemID: info.solarSystemID,
    planetTypeID: info.planetTypeID,
    ...(Number.isFinite(info.radius) && info.radius > 0 ? { radius: info.radius } : {}),
    ownerID: info.ownerID,
    level: info.level,
    currentSimTime: info.currentSimTime,
    // A pin's own ID is `id` on the wire. The rest are the row's names.
    pins: info.pins.filter((pin) => pin && typeof pin === "object").map((pin) => ({ ...pin, pinID: pin.id })),
    links: Array.isArray(info.links) ? info.links : [],
    routes: Array.isArray(info.routes) ? info.routes : [],
  };
}

/**
 * GetPlanetResourceInfo's answer, a dict of each resource's quality by its
 * type, as the stored record of a planet's resources has it. Null where the
 * answer is no dict.
 */
function resourceRecordOf(resourceInfo) {
  if (!resourceInfo || typeof resourceInfo !== "object" || resourceInfo.type !== "dict" || !Array.isArray(resourceInfo.entries)) return null;
  const pairs = resourceInfo.entries.map(([typeID, quality]) => [Number(plain(typeID)) || 0, plain(quality)]).filter(([typeID]) => typeID > 0);
  return {
    resourceTypeIDs: pairs.map(([typeID]) => typeID),
    qualitiesByTypeID: Object.fromEntries(pairs.map(([typeID, quality]) => [String(typeID), quality])),
  };
}

module.exports = { colonyRowOf, planetIDsOf, plain, resourceRecordOf, rowsetRows };
