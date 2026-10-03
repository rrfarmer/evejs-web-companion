"use strict";
const { hash, fail } = require("./provisioningContracts");
const rows = value => value.map(r => [r.itemID, r.typeID, r.ownerID, r.locationID, r.flagID, r.quantity, !!r.singleton])
  .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function intent(detail) {
  const p = detail.pilot, c = detail.selected, s = detail.candidateSource;
  if (!c || p.quality !== "COMPLETE" || !p.observation.complete || p.dockState !== "DOCKED" || s.quality !== "COMPLETE" || s.query !== "ALLOWED")
    fail("REVIEW_REQUIRED");
  return { accountID: p.accountID, characterID: p.characterID, corporationID: p.corporationID,
    locationID: p.locationID, shipID: p.shipID, shipTypeID: p.shipTypeID,
    definition: c.definition, definitionFingerprint: c.definitionFingerprint,
    equipmentFingerprint: c.equipmentFingerprint, supplyPolicyFingerprint: c.supplyPolicyFingerprint,
    observed: rows(p.observation.rows), source: { kind: s.kind, corporationID: s.corporationID, division: s.division,
      officeID: s.officeID, contentsLocationID: s.contentsLocationID, dockedLocationID: s.dockedLocationID, flag: s.flag,
      stock: rows(s.rows) }, suppliesPolicy: "NEW_HULL_ONLY" };
}
function assertSelected(pin, read) {
  const c = read.context, s = read.source;
  if (!read.observation.complete || !read.target.complete || c.recoveryReady === false ||
      ["accountID","characterID","corporationID","locationID","shipID","shipTypeID"].some(k => c[k] !== pin[k]) ||
      read.contract.definitionFingerprint !== pin.definitionFingerprint || read.contract.equipmentFingerprint !== pin.equipmentFingerprint ||
      read.contract.supplyPolicyFingerprint !== pin.supplyPolicyFingerprint || hash(rows(read.observation.rows)) !== hash(pin.observed)) fail("REVIEW_STALE");
  const source = pin.source, descriptor = s.pin.descriptor;
  if (descriptor.kind !== source.kind || (source.kind === "corp" && (descriptor.corporationID !== source.corporationID || descriptor.division !== source.division || s.pin.office !== `corpOffice:${source.officeID}`)) ||
      s.pin.ownerID !== (source.kind === "corp" ? source.corporationID : pin.characterID) || s.pin.locationID !== source.contentsLocationID ||
      s.pin.flag !== source.flag || s.pin.dockedLocationID !== source.dockedLocationID || hash(rows(s.rows)) !== hash(source.stock)) fail("SOURCE_CHANGED");
  if (s.access.query !== true) fail("SOURCE_QUERY_DENIED");
  if (s.access.take !== true) fail(s.access.take === false ? "SOURCE_TAKE_DENIED" : "SOURCE_TAKE_UNKNOWN");
}

module.exports = { intent, assertSelected };
