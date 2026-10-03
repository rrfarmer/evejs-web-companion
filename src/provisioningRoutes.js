"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { readAccountCorpFittings } = require("./pilotTrainingFittings");
const { row: serviceRow } = require("./trainingOnboarding");
const { hash, fail, inventoryRows, buildContract } = require("./provisioningContracts");
const containerGroups = new Set([12, 340, 448, 649]); // EveJS itemStore's cargo-container groups.

// Keep browser additions (including credentials) out of the durable contract.
function reviewInput(value) {
  const positive = id => Number.isSafeInteger(id) && id > 0;
  if (!positive(value?.providerCharacterID) || !positive(value?.corporationID) || !positive(value?.fittingID))
    fail("INVALID_DEFINITION_SOURCE");
  const source = value.source;
  let descriptor;
  if (source?.kind === "hangar") descriptor = { kind: "hangar" };
  else if (source?.kind === "corp" && positive(source.corporationID) && Number.isSafeInteger(source.division) && source.division >= 1 && source.division <= 7)
    descriptor = { kind: "corp", corporationID: source.corporationID, division: source.division };
  else if (source?.kind === "container" && positive(source.itemID)) descriptor = { kind: "container", itemID: source.itemID };
  else fail("INVALID_SOURCE");
  return { providerCharacterID: value.providerCharacterID, corporationID: value.corporationID,
    fittingID: value.fittingID, source: descriptor };
}

// These role bits match EveJS industryConstants, not browser permissions.
function corporationAccess(member, corporation, locationID, division) {
  if (!Number.isSafeInteger(division) || division < 1 || division > 7) fail("INVALID_DIVISION");
  // GetMember exposes direct role masks. Assigned titles require a separate
  // effective-role projection; never manufacture that authority from a list.
  if (!/^\d+$/.test(String(member.titleMask)) || BigInt(member.titleMask) !== 0n) fail("CORPORATION_ACCESS_UNKNOWN");
  const mask = (value, allowed) => {
    if (!/^\d+$/.test(String(value))) fail("CORPORATION_ACCESS_UNKNOWN");
    const parsed = BigInt(value);
    if ((parsed & ~allowed) !== 0n) fail("CORPORATION_ACCESS_UNKNOWN");
    return parsed;
  };
  const adminMask = 9222811354509877121n, localMask = 558552041119758n;
  const all = mask(member.roles, adminMask);
  const local = locationID === Number(corporation.stationID) ? mask(member.rolesAtHQ, localMask) :
    locationID === Number(member.baseID) ? mask(member.rolesAtBase, localMask) : mask(member.rolesAtOther, localMask);
  const director = (all & 1n) === 1n;
  return { query: director || ((all | local) & (1048576n << BigInt(division - 1))) !== 0n,
    take: director || ((all | local) & (8192n << BigInt(division - 1))) !== 0n,
    authorityFingerprint: hash([member, corporation.stationID]) };
}

function registerProvisioningRoutes(d) {
  const { app, requireAuth, requireHeld, engine, store, gateway, data, flight, currentHeld, inventoryLocation,
    resolvePlace, boundCall, cargoBindSpec, slots, shipBays, capacity, heldCall, mutationFence, pendingRecovery } = d;
  const routerPromise = import(pathToFileURL(path.resolve(__dirname, "../web/src/bridge/bayRouting.ts")).href);
  routerPromise.catch(() => {});
  const strictList = async (held, sessionID, place) => {
    const result = await boundCall(held, sessionID, place.spec, "List", place.flag === 0 ? [] : [place.flag], null);
    return inventoryRows(result.result).sort((a, b) => a.identity.localeCompare(b.identity));
  };
  function adapter(req, held) {
    const sessionID = req.webSessionID;
    const listedLocations = new Map();
    async function context() {
      currentHeld(held, sessionID);
      const current = (await flight(held, sessionID)).flight;
      if (held.transition && held.transition.phase !== "ready") fail("PROVISIONING_CONTEXT_UNAVAILABLE");
      if (current.docked !== true || !current.shipID || current.shipID !== held.activeShipID ||
          !current.shipTypeID || !inventoryLocation(held)) fail("PROVISIONING_CONTEXT_UNAVAILABLE");
      if (held.structureID) fail("PROVISIONING_STATION_ONLY", "Initial replenishment supports docked NPC stations; structure qualification is pending.");
      const pilot = (await store.listCharactersForAccount(req.account.accountID)).find(c => c.characterID === held.characterID);
      if (!pilot || pilot.accountID !== req.account.accountID || pilot.corporationID !== held.corporationID) fail("PILOT_AUTHORITY_CHANGED");
      return { accountID: Number(req.account.accountID), characterID: held.characterID, corporationID: held.corporationID,
        shipID: current.shipID, shipTypeID: current.shipTypeID, locationID: inventoryLocation(held),
        recoveryReady: !pendingRecovery(held),
        sessionGeneration: hash([held.bridgeSessionID, held.botClaimSecret || null]) };
    }
    async function library(input) {
      if (!Number.isSafeInteger(input.providerCharacterID) || !Number.isSafeInteger(input.corporationID)) fail("INVALID_DEFINITION_SOURCE");
      const result = await readAccountCorpFittings({ store, gateway, data, accountID: Number(req.account.accountID), characterID: input.providerCharacterID });
      if (result.status !== "READY" || result.corporationID !== input.corporationID) fail("FITTING_SOURCE_CHANGED");
      const provider = { scope: "CORPORATION", accountID: Number(req.account.accountID), characterID: input.providerCharacterID,
        corporationID: result.corporationID };
      const contracts = [];
      for (const fit of result.fittings.filter(f => !f.invalid)) {
        try { contracts.push(buildContract(fit, provider, data, input.supplyPolicy)); }
        catch (error) { if (fit.fittingID === input.fittingID) throw error; }
      }
      const contract = contracts.find(c => c.definition.fittingID === input.fittingID);
      if (!contract) fail("INVALID_FIT");
      return { contract, contracts };
    }
    async function source(input, scope, recoveryPin = null) {
      const descriptor = input.source;
      if (!descriptor || !["hangar", "corp", "container"].includes(descriptor.kind)) fail("INVALID_SOURCE");
      const place = await resolvePlace(held, sessionID, descriptor);
      let access = { query: true, take: true }, ownerID = held.characterID;
      if (descriptor.kind === "corp") {
        if (descriptor.corporationID !== scope.corporationID) fail("CORPORATION_SOURCE_CHANGED");
        ownerID = scope.corporationID;
        const member = serviceRow((await heldCall(held, sessionID, "corpRegistry", "GetMember", [held.characterID], null)).result);
        const corp = serviceRow((await heldCall(held, sessionID, "corpRegistry", "GetCorporation", [], null)).result);
        if (Number(member.characterID) !== held.characterID || Number(member.corporationID) !== ownerID ||
            Number(corp.corporationID) !== ownerID) fail("CORPORATION_ACCESS_UNKNOWN");
        access = corporationAccess(member, corp, scope.locationID, descriptor.division);
        if (!access.query) fail("CORPORATION_QUERY_DENIED");
      }
      if (descriptor.kind === "container") {
        const hangar = await resolvePlace(held, sessionID, { kind: "hangar" });
        const cargo = await resolvePlace(held, sessionID, { kind: "cargo" });
        const roots = [...await strictList(held, sessionID, hangar), ...await strictList(held, sessionID, cargo)];
        if (!roots.some(r => r.itemID === descriptor.itemID && r.ownerID === ownerID && r.singleton &&
            containerGroups.has(Number(data.getType(r.typeID)?.groupID)) && [scope.locationID, scope.shipID].includes(r.locationID)))
          fail("CONTAINER_NOT_LOCAL_OWNED");
      }
      const rows = await strictList(held, sessionID, place);
      if (rows.some(r => r.ownerID !== ownerID || r.flagID !== place.flag || r.loaded)) fail("SOURCE_IDENTITY_UNKNOWN");
      const locations = [...new Set(rows.map(r => r.locationID))];
      if (locations.length > 1 || (place.locationID && locations.some(id => id !== place.locationID))) fail("SOURCE_LOCATION_CHANGED");
      const sourceKey = hash([descriptor, place.spec.key, scope.locationID]);
      if (recoveryPin && hash(recoveryPin.descriptor) === hash(descriptor) && recoveryPin.dockedLocationID === scope.locationID &&
          recoveryPin.office === (descriptor.kind === "corp" ? place.spec.key : null) && recoveryPin.ownerID === ownerID && recoveryPin.flag === place.flag)
        listedLocations.set(sourceKey, recoveryPin.locationID);
      if (locations[0]) listedLocations.set(sourceKey, locations[0]);
      return { rows, access, place, pin: { descriptor, ownerID, locationID: place.locationID || locations[0] || listedLocations.get(sourceKey) || null,
        flag: place.flag, office: descriptor.kind === "corp" ? place.spec.key : null, dockedLocationID: scope.locationID } };
    }
    async function observation(scope) {
      try {
        const flags = [...new Set([...slots(), 5, 87, 158, 133, 143])];
        const listed = await boundCall(held, sessionID, cargoBindSpec(held, scope.shipID), "ListByFlags", [flags], null);
        const rows = inventoryRows(listed.result).sort((a, b) => a.identity.localeCompare(b.identity));
        if (rows.some(r => r.locationID !== scope.shipID || r.ownerID !== scope.characterID || !data.getType(r.typeID))) fail("OBSERVATION_INCOMPLETE");
        return { complete: true, shipTypeID: scope.shipTypeID, rows };
      } catch (error) {
        if (["SESSION_NOT_FOUND", "NO_LIVE_SESSION", "HOSTED_GENERATION_CHANGED"].includes(error.code)) throw error;
        return { complete: false, shipTypeID: scope.shipTypeID, rows: null, reason: String(error.code || "READ_FAILED") };
      }
    }
    async function read(input, sourcePin = null) {
      const scope = await context(), definitions = await library(input);
      const observed = await observation(scope), origin = await source(input, scope, sourcePin);
      if (hash(await context()) !== hash(scope)) fail("PROVISIONING_CONTEXT_CHANGED");
      return { context: scope, ...definitions, observation: observed, source: origin };
    }
    async function readMovement(move, sourcePin) {
      const scope = await context();
      if (scope.shipID !== move.shipID || scope.locationID !== sourcePin.dockedLocationID) fail("RECONCILIATION_SCOPE_CHANGED");
      const from = await resolvePlace(held, sessionID, sourcePin.descriptor);
      if (from.flag !== sourcePin.flag || (sourcePin.office && from.spec.key !== sourcePin.office)) fail("SOURCE_AUTHORITY_CHANGED");
      const to = await resolvePlace(held, sessionID, move.destination);
      const origin = await strictList(held, sessionID, from), destination = await strictList(held, sessionID, to);
      if (origin.some(r => r.ownerID !== sourcePin.ownerID || r.locationID !== sourcePin.locationID || r.flagID !== sourcePin.flag) ||
          destination.some(r => r.ownerID !== scope.characterID || r.locationID !== scope.shipID || r.flagID !== to.flag)) fail("TRANSFER_SCOPE_CHANGED");
      return { source: origin, destination };
    }
    async function plan(targets, current) {
      const { planLootTransfers } = await routerPromise;
      for (const target of targets.filter(t => t.deficit > 0)) {
        const rows = current.source.rows.filter(r => r.typeID === target.typeID && !r.singleton);
        if (!rows.length) continue;
        const type = data.getType(target.typeID), volume = Number(type?.volume);
        if (!Number.isFinite(volume) || volume <= 0) fail("SUPPLY_VOLUME_UNKNOWN");
        const keys = target.eligibleFlags.map(flag => flag === 5 ? { key: "cargo", label: "Cargo hold", flag: 5 } :
          shipBays().find(bay => bay.flag === flag)).filter(Boolean);
        const bays = [];
        for (const bay of keys) {
          const raw = await boundCall(held, sessionID, cargoBindSpec(held, current.context.shipID), "GetCapacity", [bay.flag], null);
          const cap = capacity(raw.result);
          if (!cap || !Number.isFinite(cap.capacity) || !Number.isFinite(cap.used)) fail("BAY_CAPACITY_UNKNOWN");
          bays.push({ key: bay.key, label: bay.label, present: cap.capacity > 0, capacity: cap, items: [], error: null });
        }
        const selected = rows[0], quantity = Math.min(target.deficit, selected.quantity);
        const candidate = { ...selected, quantity, volume, groupID: Number(type.groupID), categoryID: Number(type.categoryID) };
        const preferences = [{ bays: Number(type.groupID) === 423 ? ["fuel", "cargo"] : ["ammo", "cargo"], groupIDs: [Number(type.groupID)] }];
        const routed = planLootTransfers([candidate], bays, key => {
          const bay = bays.find(b => b.key === (key || "cargo"));
          return bay?.present ? Math.max(0, bay.capacity.capacity - bay.capacity.used) : 0;
        }, preferences);
        const first = routed[0];
        if (!first) continue;
        return { itemID: selected.itemID, typeID: target.typeID, quantity: first.qty ?? quantity,
          sourceLocationID: selected.locationID, shipID: current.context.shipID,
          destination: first.bay && first.bay !== "cargo" ? { kind: "shipBay", bay: first.bay } : { kind: "cargo" } };
      }
      return null;
    }
    return { context, read, plan, readMovement,
      async validateMove(move, current, lease) {
        if (pendingRecovery(held)) fail("PROVISIONING_CONTEXT_UNAVAILABLE");
        engine.assertWritable(held.characterID, lease);
        if (hash(await context()) !== hash(current.context) || move.sourceLocationID !== current.source.pin.locationID ||
            move.shipID !== current.context.shipID || !Number.isSafeInteger(move.quantity) || move.quantity <= 0) fail("TRANSFER_SCOPE_CHANGED");
      },
      async dispatch(move, current, lease) {
        if (hash(await context()) !== hash(current.context)) fail("PROVISIONING_CONTEXT_CHANGED");
        const definition = current.contract.definition;
        const freshLibrary = await library({ providerCharacterID: definition.characterID, corporationID: definition.corporationID,
          fittingID: definition.fittingID });
        if (freshLibrary.contract.definitionFingerprint !== current.contract.definitionFingerprint) fail("REVIEW_REQUIRED");
        const from = await source({ source: current.source.pin.descriptor }, current.context);
        if (hash(from.pin) !== hash(current.source.pin) || from.access.take !== true ||
            hash(from.access) !== hash(current.source.access)) fail("SOURCE_AUTHORITY_CHANGED");
        const selected = from.rows.find(r => r.itemID === move.itemID && r.typeID === move.typeID && r.quantity >= move.quantity);
        if (!selected || selected.locationID !== move.sourceLocationID) fail("SOURCE_CHANGED");
        const to = await resolvePlace(held, sessionID, move.destination);
        const spec = { ...to.spec, expectedDockedLocationID: current.context.locationID, expectedShipID: move.shipID };
        return mutationFence.withLease(lease, () => boundCall(held, sessionID, spec, "Add",
          [move.itemID, move.sourceLocationID], { flag: to.flag, qty: move.quantity }));
      } };
  }
  const endpoint = action => async (req, res, next) => {
    const held = requireHeld(req, res); if (!held) return;
    try { res.json({ ok: true, ...await action(req, held) }); } catch (error) { next(error); }
  };
  app.get("/api/bridge/provisioning/options", requireAuth, endpoint(async (req, held) => {
    const scope = await adapter(req, held).context();
    const characters = await store.listCharactersForAccount(req.account.accountID);
    const providerCharacterID = Number(req.query.providerCharacterID) || held.characterID;
    const library = await readAccountCorpFittings({ store, gateway, data, accountID: Number(req.account.accountID), characterID: providerCharacterID });
    const containers = [];
    for (const kind of ["hangar", "cargo"]) {
      try {
        const place = await resolvePlace(held, req.webSessionID, { kind });
        const rows = await strictList(held, req.webSessionID, place);
        for (const row of rows) if (row.ownerID === scope.characterID && row.locationID === place.locationID && row.singleton &&
            containerGroups.has(Number(data.getType(row.typeID)?.groupID))) containers.push({ itemID: row.itemID,
          name: data.getTypeName(row.typeID), location: kind === "hangar" ? "Personal hangar" : "Ship cargo" });
      } catch { /* An unreadable location contributes no selectable authority. Review always rechecks. */ }
    }
    if (hash(await adapter(req, held).context()) !== hash(scope)) fail("PROVISIONING_CONTEXT_CHANGED");
    return { providers: characters.filter(c => c.accountID === req.account.accountID).map(c => ({ characterID: c.characterID,
      corporationID: c.corporationID, name: c.characterName })), corporationID: held.corporationID,
      providerCharacterID, definitionCorporationID: library.corporationID || null,
      definitionStatus: library.status,
      fittings: library.status === "READY" ? library.fittings.map(f => ({ fittingID: f.fittingID, name: f.name || "Invalid fitting", invalid: !!f.invalid })) : [], containers,
      pending: engine.unresolved(held.characterID).map(row => ({ operationID: row.key, state: row.state })) };
  }));
  app.post("/api/bridge/provisioning/review", requireAuth, endpoint((req, held) => engine.review(adapter(req, held), reviewInput(req.body))));
  app.post("/api/bridge/provisioning/replenish", requireAuth, endpoint((req, held) => {
    if (req.body.confirm !== true) fail("CONFIRMATION_REQUIRED");
    return engine.apply(adapter(req, held), req.body);
  }));
  app.post("/api/bridge/provisioning/reconcile", requireAuth, endpoint((req, held) => engine.reconcile(adapter(req, held), req.body.operationID)));
}
module.exports = { registerProvisioningRoutes, corporationAccess };
