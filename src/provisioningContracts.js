"use strict";
const crypto = require("node:crypto");
const { fittingFingerprint } = require("./pilotTrainingFittings");
const slot = flag => [[11, 34], [92, 99], [125, 132], [164, 171]].some(([lo, hi]) => flag >= lo && flag <= hi);
const positive = n => Number.isSafeInteger(n) && n > 0;
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function fail(code, message = code) { throw Object.assign(new Error(message), { code, statusCode: 409 }); }
function number(value) { return Number(value?.type === "long" ? value.value : value); }

// Strict only for the new engine. Legacy tolerant panel decoders stay unchanged.
function inventoryRows(value) {
  if (value?.type === "objectex1" && Array.isArray(value.header)) value = value.header[1]?.[0];
  else if (value?.type === "object" && Array.isArray(value.args)) value = value.args[0];
  if (value?.type !== "list" || !Array.isArray(value.items)) fail("OBSERVATION_INCOMPLETE");
  const seen = new Set();
  const rows = value.items.map(item => {
    const fields = item?.type === "packedrow" ? item.fields : item;
    if (!fields || typeof fields !== "object") fail("OBSERVATION_INCOMPLETE");
    const typeID = number(fields.typeID), flagID = number(fields.flagID), locationID = number(fields.locationID);
    const singleton = number(fields.singleton) === 1;
    const quantity = singleton ? 1 : number(fields.stacksize ?? fields.quantity);
    const rawID = fields.itemID;
    const itemID = number(rawID);
    const tuple = rawID?.type === "tuple" ? rawID.items : Array.isArray(rawID) ? rawID : null;
    const loaded = tuple !== null;
    const key = loaded ? JSON.stringify(tuple) : String(itemID);
    if (!positive(typeID) || !Number.isSafeInteger(flagID) || flagID < 0 || !positive(locationID) ||
        !positive(quantity) || (!loaded && !positive(itemID)) || seen.has(key)) fail("OBSERVATION_INCOMPLETE");
    if (loaded && (!Array.isArray(tuple) || tuple.length !== 3 || number(tuple[0]) !== locationID ||
        number(tuple[1]) !== flagID || number(tuple[2]) !== typeID)) fail("OBSERVATION_INCOMPLETE");
    seen.add(key);
    return { itemID: loaded ? null : itemID, identity: key, typeID, flagID, locationID, quantity, singleton,
      ownerID: number(fields.ownerID), loaded };
  });
  if (rows.some(row => row.loaded && rows.some(other => other !== row && other.locationID === row.locationID &&
      other.flagID === row.flagID && other.typeID === row.typeID))) fail("OBSERVATION_INCOMPLETE");
  return rows;
}
function tuples(rows) {
  const aggregated = new Map();
  for (const row of rows) {
    const key = `${row.flagID}:${row.typeID}`;
    aggregated.set(key, (aggregated.get(key) || 0) + row.quantity);
  }
  return [...aggregated].map(([key, qty]) => [...key.split(":").map(Number), qty])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
function buildContract(fit, provider, data, policy = {}) {
  if (fit?.invalid || !positive(fit?.fittingID) || !positive(fit.ownerID) || !positive(fit.shipTypeID) ||
      !Array.isArray(fit.items) || !fit.items.length || typeof fit.savedDate !== "string" || !/^\d+$/.test(fit.savedDate) ||
      provider.scope !== "CORPORATION" || provider.corporationID !== fit.ownerID ||
      !positive(provider.accountID) || !positive(provider.characterID) || Number(data.getType(fit.shipTypeID)?.categoryID) !== 6)
    fail("INVALID_FIT");
  const equipment = [], targets = new Map(), unrelated = [], occupied = new Set();
  for (const item of fit.items) {
    const type = data.getType(item.typeID);
    if (!type || !positive(item.quantity) || !positive(item.flagID) || !(slot(item.flagID) || [5, 87, 158].includes(item.flagID))) fail("INVALID_FIT");
    if (slot(item.flagID) && Number(type.categoryID) !== 8) {
      if (![7, 32].includes(Number(type.categoryID)) || item.quantity !== 1 || occupied.has(item.flagID)) fail("INVALID_FIT");
      occupied.add(item.flagID); equipment.push(item); continue;
    }
    if ([87, 158].includes(item.flagID)) {
      if (Number(type.categoryID) !== (item.flagID === 87 ? 18 : 87)) fail("INVALID_FIT");
      equipment.push(item); continue;
    }
    if (Number(type.categoryID) === 8 || (item.flagID === 5 && Number(type.groupID) === 423)) {
      const mode = slot(item.flagID) ? "TOTAL_ABOARD" : "CARRIED_SPARES";
      const eligibleFlags = Number(type.groupID) === 423 ? [5, 133] : [5, 143];
      const key = String(item.typeID);
      const old = targets.get(key);
      targets.set(key, { typeID: item.typeID, name: data.getTypeName(item.typeID), target: (old?.target || 0) + item.quantity,
        mode: old?.mode === "TOTAL_ABOARD" || mode === "TOTAL_ABOARD" ? "TOTAL_ABOARD" : "CARRIED_SPARES", eligibleFlags, required: false });
    } else unrelated.push(item);
  }
  for (const item of policy.requiredCarried || []) {
    if (!data.getType(item.typeID) || !positive(item.quantity) || ![5, 87, 158].includes(item.flagID)) fail("INVALID_EQUIPMENT_POLICY");
    if (equipment.some(row => row.typeID === item.typeID && row.flagID === item.flagID)) fail("EQUIPMENT_POLICY_OVERLAP");
    equipment.push({ typeID: item.typeID, flagID: item.flagID, quantity: item.quantity });
  }
  for (const target of policy.supplies || []) {
    const type = data.getType(target.typeID);
    if (!type || !positive(target.target) || !["TOTAL_ABOARD", "CARRIED_SPARES"].includes(target.mode) ||
        !Array.isArray(target.eligibleFlags) || !target.eligibleFlags.length ||
        target.eligibleFlags.some(flag => ![5, 133, 143].includes(flag) || (flag === 133 && Number(type.groupID) !== 423) ||
          (flag === 143 && Number(type.categoryID) !== 8)) ||
        equipment.some(item => item.typeID === target.typeID && target.eligibleFlags.includes(item.flagID))) fail("INVALID_SUPPLY_POLICY");
    for (const [key, value] of targets) if (value.typeID === target.typeID) targets.delete(key);
    targets.set(`${target.typeID}:${target.mode}`, { typeID: target.typeID, name: data.getTypeName(target.typeID), target: target.target,
      mode: target.mode, eligibleFlags: [...new Set(target.eligibleFlags)].sort((a, b) => a - b), required: target.required === true });
  }
  const supplies = [...targets.values()].sort((a, b) => a.typeID - b.typeID || a.mode.localeCompare(b.mode));
  if (new Set(supplies.map(s => s.typeID)).size !== supplies.length) fail("SUPPLY_POLICY_OVERLAP");
  const fingerprint = fittingFingerprint(fit.shipTypeID, fit.items);
  if (fit.fingerprint !== fingerprint) fail("INVALID_FIT");
  const definition = { ...provider, fittingID: fit.fittingID, savedDate: fit.savedDate, fingerprint,
    fullFingerprint: hash([fit.ownerID, fit.shipTypeID, fit.name, fit.savedDate, fingerprint]) };
  return { name: fit.name, shipTypeID: fit.shipTypeID, definition, equipment: tuples(equipment),
    structural: tuples(equipment.filter(item => slot(item.flagID))), operational: tuples(equipment.filter(item => !slot(item.flagID))), supplies, unrelated,
    equipmentFingerprint: hash([fit.shipTypeID, tuples(equipment)]),
    supplyPolicyFingerprint: hash(supplies.map(({ name, ...policy }) => policy)),
    definitionFingerprint: hash(definition) };
}
function inspectContract(contract, observation, data) {
  if (!observation?.complete || !positive(observation.shipTypeID) || Number(data.getType(observation.shipTypeID)?.categoryID) !== 6 || !Array.isArray(observation.rows) ||
      observation.rows.some(row => !positive(row.typeID) || !positive(row.quantity) || !Number.isSafeInteger(row.flagID) ||
        row.flagID < 0 || !data.getType(row.typeID)))
    return { equipment: "UNKNOWN", supplies: "UNKNOWN", targets: contract.supplies.map(s => ({ ...s, current: null, deficit: null, state: "UNKNOWN" })) };
  const relevant = observation.rows.filter(row => (slot(row.flagID) && Number(data.getType(row.typeID)?.categoryID) !== 8) ||
    [87, 158].includes(row.flagID) || contract.operational.some(([flag, type]) => row.flagID === flag && row.typeID === type));
  const actual = hash([observation.shipTypeID, tuples(relevant)]);
  const targets = contract.supplies.map(s => {
    const current = observation.rows.filter(row => row.typeID === s.typeID &&
      (s.eligibleFlags.includes(row.flagID) || (s.mode === "TOTAL_ABOARD" && slot(row.flagID) && Number(data.getType(row.typeID)?.categoryID) === 8)))
      .reduce((sum, row) => sum + row.quantity, 0);
    return { ...s, current, deficit: Math.max(0, s.target - current), state: current >= s.target ? "FULL" : current === 0 ? "MISSING" : "LOW" };
  });
  return { equipment: actual === contract.equipmentFingerprint ? "VERIFIED" : "MODIFIED", actualEquipmentFingerprint: actual,
    supplies: targets.every(t => t.state === "FULL") ? "FULL" : targets.every(t => t.state === "MISSING") ? "MISSING" : "LOW", targets };
}
function matchFittings(contracts, observation, data) {
  if (!observation?.complete || (contracts.length && inspectContract(contracts[0], observation, data).equipment === "UNKNOWN"))
    return { state: "UNKNOWN", alternatives: [] };
  const alternatives = contracts.filter(c => inspectContract(c, observation, data).equipment === "VERIFIED")
    .map(c => ({ name: c.name, definition: c.definition }));
  return { state: alternatives.length === 1 ? "MATCH" : alternatives.length > 1 ? "AMBIGUOUS" : "MODIFIED", alternatives };
}
module.exports = { hash, fail, inventoryRows, buildContract, inspectContract, matchFittings, tuples };
