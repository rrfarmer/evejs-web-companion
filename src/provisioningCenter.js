"use strict";
const { readAccountCorpFittings } = require("./pilotTrainingFittings");
const { buildContract, inspectContract, matchFittings, hash, fail } = require("./provisioningContracts");
const positive = n => Number.isSafeInteger(n) && n > 0;
const unknown = () => ({ equipment: "UNKNOWN", supplies: "UNKNOWN", targets: [] });
const unread = status => ({ ...unknown(), targets: status.targets.map(t => ({ ...t, current: null, deficit: null, state: "UNKNOWN" })) });
function queryID(value, fallback = null, zero = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail("INVALID_REVIEW_SELECTOR");
  const n = Number(value);
  if (!positive(n) && !(zero && n === 0)) fail("INVALID_REVIEW_SELECTOR");
  return n;
}

// Strictly the explicit runtime projection; raw /snapshot never enters here.
function validateProjection(value, accountID) {
  if (value?.version !== 1 || value.accountID !== accountID || !["COMPLETE","PARTIAL","UNAVAILABLE"].includes(value.quality) ||
      !Array.isArray(value.pilots) || typeof value.completeRoster !== "boolean") fail("PROJECTION_UNAVAILABLE");
  const seen = new Set();
  for (const p of value.pilots) {
    if (!positive(p.characterID) || p.accountID !== accountID || seen.has(p.characterID) || !["COMPLETE","PARTIAL"].includes(p.quality) ||
        !Array.isArray(p.reasons) || !/^[a-f0-9]{64}$/.test(p.revision || "") ||
        !Array.isArray(p.observation?.rows) || typeof p.observation.complete !== "boolean") fail("PROJECTION_INVALID");
    seen.add(p.characterID);
    if (p.observation.complete && (p.quality !== "COMPLETE" || value.evidence?.stable !== true ||
        value.evidence.boundary !== "SYNCHRONOUS_WORLD_CACHE_DOUBLE_READ" || !/^[a-f0-9]{64}$/.test(value.evidence.digest) ||
        !positive(p.shipID) || !positive(p.shipTypeID) || p.observation.shipTypeID !== p.shipTypeID ||
        p.observation.rows.some(r => !positive(r.itemID) || !positive(r.typeID) || !positive(r.quantity) || r.ownerID !== p.characterID ||
          r.locationID !== p.shipID || !Number.isSafeInteger(r.flagID)))) fail("PROJECTION_INVALID");
  }
  return value;
}
function registerProvisioningCenter({ app, requireAuth, gateway, data, operations, heldSessions, botHost, engine }) {
  const projection = async (accountID, characterID = null, source = { kind: "hangar" }) =>
    validateProjection(await gateway.getProvisioningObservation(accountID, characterID, source), accountID);
  const store = { async listCharactersForAccount(accountID) {
    const p = await projection(accountID);
    if (!p.completeRoster || p.pilots.some(r => !positive(r.corporationID))) fail("PROVIDER_IDENTITY_UNKNOWN");
    return p.pilots.map(r => ({ accountID, characterID: r.characterID, corporationID: r.corporationID, characterName: r.name }));
  } };
  const ownership = p => {
    if (engine.unresolved(p.characterID).length) return { ...p.control, state: "RECOVERY", owner: "CUSTODY" };
    if (botHost.claimedBy(p.characterID) !== null) return { ...p.control, state: "BUSY", owner: "HOSTED_BOT" };
    if ([...heldSessions.values()].some(h => h.characterID === p.characterID)) return { ...p.control, state: "BUSY", owner: "WC_BROWSER" };
    if (operations.has(p.characterID)) return { ...p.control, state: "BUSY", owner: "WC_OPERATION" };
    return p.control || { state: "UNKNOWN", owner: "UNKNOWN", online: null };
  };
  const named = rows => rows.map(r => ({ ...r, name: data.getTypeName(r.typeID) || "Unknown type",
    kind: r.flagID >= 92 && r.flagID <= 99 ? "Rig" : r.flagID >= 125 && r.flagID <= 132 ? "Subsystem" :
      Number(data.getType(r.typeID)?.categoryID) === 8 && r.flagID >= 11 && r.flagID <= 34 ? "Loaded charge/script/crystal" :
      r.flagID >= 11 && r.flagID <= 34 ? "Module" : r.flagID === 87 ? "Drone" : r.flagID === 158 ? "Fighter" : "Carried / inventory" }));
  function markDrift(p) {
    p.quality = "PARTIAL"; p.reasons.push("READ_DRIFT"); p.observation.complete = false;
    p.control = { state: "UNKNOWN", owner: "UNKNOWN", online: null };
    p.source.quality = "PARTIAL"; p.source.reasons.push("READ_DRIFT");
  }
  async function library(accountID, characterID, supplyPolicy = {}) {
    const value = await readAccountCorpFittings({ store, gateway, accountID, characterID, data });
    const contracts = [], invalid = [];
    for (const fit of value.fittings || []) {
      try { contracts.push(buildContract(fit, { scope: "CORPORATION", accountID, characterID, corporationID: value.corporationID }, data, supplyPolicy)); }
      catch { invalid.push({ fittingID: fit.fittingID, reason: "INVALID_FIT" }); }
    }
    return { status: value.status, corporationID: value.corporationID || null, providerCharacterID: characterID, contracts, invalid };
  }
  function classify(pilot, definitions, fittingID = null) {
    const contracts = definitions.contracts;
    const matches = definitions.status === "READY" ? matchFittings(contracts, pilot.observation, data) : { state: "UNKNOWN", alternatives: [] };
    // Only an explicit selection or a UNIQUE exact match can choose a policy.
    const selected = fittingID ? contracts.find(c => c.definition.fittingID === fittingID) :
      matches.state === "MATCH" ? contracts.find(c => c.definition.fittingID === matches.alternatives[0].definition.fittingID) : null;
    return { matches, selected, status: selected ? inspectContract(selected,pilot.observation,data) :
      { ...unknown(), equipment: matches.state === "AMBIGUOUS" ? "VERIFIED" : matches.state === "MODIFIED" ? "REVIEW" : "UNKNOWN" } };
  }
  async function roster(accountID, providerCharacterID = null) {
    const first = await projection(accountID), libraries = new Map();
    if (providerCharacterID && !first.pilots.some(p => p.characterID === providerCharacterID)) fail("PROVIDER_NOT_OWNED");
    const rows = [];
    for (const p of first.pilots) {
      const provider = providerCharacterID || p.characterID;
      if (!libraries.has(provider)) libraries.set(provider, await library(accountID,provider));
      const definitions = libraries.get(provider), review = classify(p,definitions);
      rows.push({ ...p, hullName: p.shipTypeID ? data.getTypeName(p.shipTypeID) : null, locationName: p.stationID ? data.getStationName(p.stationID) : p.systemID ? data.getSolarSystemName(p.systemID) : null,
        control: ownership(p), status: review.status, matches: review.matches, definitionStatus: definitions.status });
    }
    const final = await projection(accountID);
    for (const row of rows) if (row.revision !== final.pilots.find(p => p.characterID === row.characterID)?.revision) {
      markDrift(row); row.status = unread(row.status); row.matches = { state: "UNKNOWN", alternatives: [] };
    }
    for (const row of rows) row.control = ownership(row);
    return { quality: first.quality === "UNAVAILABLE" ? "UNAVAILABLE" : !first.completeRoster || !final.completeRoster || first.quality !== "COMPLETE" || final.quality !== "COMPLETE" || rows.some(p => p.quality !== "COMPLETE") ? "PARTIAL" : "COMPLETE",
      completeRoster: first.completeRoster && final.completeRoster, reasons: first.reasons, evidence: first.evidence, pilots: rows,
      providers: first.pilots.map(p => ({ characterID: p.characterID, name: p.name, corporationID: p.corporationID })) };
  }
  app.get("/api/ship-provisioning/roster", requireAuth, async (req,res,next) => {
    try { res.json({ ok: true, ...await roster(req.account.accountID, queryID(req.query.providerCharacterID)) }); }
    catch (e) { next(e); }
  });
  async function readReview(accountID, input) {
      const { characterID, providerCharacterID, fittingID, source } = input;
      const first = await projection(accountID,characterID,source), pilot = first.pilots.find(p => p.characterID === characterID);
      if (!pilot) fail("PILOT_UNAVAILABLE");
      const definitions = await library(accountID,providerCharacterID,input.supplyPolicy), review = classify(pilot,definitions,fittingID || null);
      const final = await projection(accountID,characterID,source);
      if (pilot.revision !== final.pilots.find(p => p.characterID === characterID)?.revision) { markDrift(pilot); review.status = unread(review.status); review.matches = { state: "UNKNOWN", alternatives: [] }; }
      if (fittingID && !review.selected) fail("FITTING_UNAVAILABLE");
      return { pilot: { ...pilot, control: ownership(pilot), hullName: pilot.shipTypeID ? data.getTypeName(pilot.shipTypeID) : null }, evidence: first.evidence,
        definitions, ...review, equipment: named(pilot.observation.rows), requirements: review.selected ? named(review.selected.equipment.map(([flagID,typeID,quantity]) => ({flagID,typeID,quantity}))) : [],
        candidateSource: { ...pilot.source, rows: named(pilot.source.rows), revalidateOnApply: true },
        readOnly: true };
  }
  app.get("/api/ship-provisioning/review", requireAuth, async (req,res,next) => {
    try {
      const characterID = queryID(req.query.characterID), providerCharacterID = queryID(req.query.providerCharacterID,characterID), fittingID = queryID(req.query.fittingID,0,true);
      if (!positive(characterID) || !positive(providerCharacterID)) fail("INVALID_PILOT");
      const sourceKind = req.query.sourceKind ?? "hangar";
      if (!["hangar","corp"].includes(sourceKind)) fail("SOURCE_UNSUPPORTED");
      const source = sourceKind === "corp" ? { kind: "corp", corporationID: queryID(req.query.corporationID), division: queryID(req.query.division) } : { kind: "hangar" };
      const input = { characterID, providerCharacterID, fittingID, source }, detail = await readReview(req.account.accountID, input);
      res.json({ ok: true, ...detail });
    } catch (e) { next(e); }
  });
  return { roster, readReview };
}
module.exports = { registerProvisioningCenter, validateProjection };
