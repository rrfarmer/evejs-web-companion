"use strict";
// Observation only. Injected readers run in the existing world owner; no owner
// service imports, session creation, writes, repair, or lazy authority bootstrap.
const { createHash } = require("node:crypto");
const id = n => Number.isSafeInteger(n) && n > 0;
const object = v => v && typeof v === "object" && !Array.isArray(v);
const digest = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const reject = code => { throw Object.assign(new Error(code), { code, statusCode: 403 }); };
const fitting = f => [[11,34],[92,99],[125,132],[164,171]].some(([a,b]) => f >= a && f <= b);

function createProvisioningObservation({ read, control, processRole, now = Date.now, limit = 100000 }) {
  const root = table => {
    const result = read(table, "/");
    if (result?.success !== true || !object(result.data)) throw new Error(`ROOT_UNREADABLE:${table}`);
    return structuredClone(result.data);
  };
  const mask = value => /^\d+$/.test(String(value)) ? BigInt(value) : null;
  function project(accountID, characterID = null, source = { kind: "hangar" }) {
    if (!id(accountID) || (characterID !== null && !id(characterID))) reject("PROJECTION_REQUEST_INVALID");
    if (!["hangar", "corp"].includes(source.kind)) reject("SOURCE_UNSUPPORTED");
    if (source.kind === "corp" && (!id(source.corporationID) || !Number.isInteger(source.division) || source.division < 1 || source.division > 7)) reject("SOURCE_INVALID");
    const startedAt = now(), reasons = [];
    let accounts, characters;
    try { accounts = root("accounts"); characters = root("characters"); }
    catch (error) { return { version: 1, accountID, quality: "UNAVAILABLE", reasons: [error.message], pilots: [], completeRoster: false }; }
    if (!Object.values(accounts).some(a => object(a) && Number(a.id ?? a.accountID) === accountID && a.banned !== true)) reject("ACCOUNT_NOT_OWNED");
    const owned = Object.entries(characters).filter(([,c]) => object(c) && Number(c.accountId ?? c.accountID ?? c.userid) === accountID);
    if (characterID !== null && !owned.some(([key]) => Number(key) === characterID)) reject("CHARACTER_NOT_OWNED");
    let items = null, corporations = null, corpRuntime = null;
    try { items = root("items"); } catch (e) { reasons.push(e.message); }
    if (source.kind === "corp") {
      try { corporations = root("corporations"); corpRuntime = root("corporationRuntime"); }
      catch (e) { reasons.push(e.message); }
    }
    const roots = { accounts, characters, items, corporations, corpRuntime };
    let stable = processRole === "world";
    if (!stable) reasons.push("WORLD_OWNER_REQUIRED");
    // Synchronous same-turn observation from world-owned cache. Double read
    // detects broken readers/drift; this is NOT a durable inventory revision.
    try {
      const again = { accounts: root("accounts"), characters: root("characters"), items: items && root("items"),
        corporations: corporations && root("corporations"), corpRuntime: corpRuntime && root("corporationRuntime") };
      if (digest(roots) !== digest(again)) { stable = false; reasons.push("READ_DRIFT"); }
    } catch (e) { stable = false; reasons.push(e.message); }
    const all = items ? Object.entries(items).filter(([key]) => /^\d+$/.test(key)) : [];
    if (all.length > limit) { stable = false; reasons.push("ITEM_ROOT_LIMIT"); }
    const itemRow = (key, r) => {
      if (!object(r) || Number(key) !== r.itemID || ![r.itemID,r.typeID,r.ownerID,r.locationID].every(id) ||
          !Number.isSafeInteger(r.flagID) || r.flagID < 0 || ![0,1,2].includes(r.singleton) ||
          (r.singleton === 0 && (!id(r.stacksize ?? r.quantity)))) return null;
      return { itemID: r.itemID, identity: String(r.itemID), typeID: r.typeID, ownerID: r.ownerID, locationID: r.locationID,
        flagID: r.flagID, quantity: r.singleton ? 1 : r.stacksize ?? r.quantity, singleton: r.singleton !== 0, loaded: false };
    };
    if (all.some(([key,r]) => !itemRow(key,r))) reasons.push("ITEM_ROOT_MALFORMED");
    const pilots = owned.filter(([key]) => characterID === null || Number(key) === characterID).map(([key,c]) => {
      const why = [...reasons], pilotID = Number(key);
      if (source.kind === "corp" && source.corporationID !== c.corporationID) reject("CORPORATION_SCOPE_REJECTED");
      const identityOK = id(pilotID) && (!c.characterID || c.characterID === pilotID) && typeof c.characterName === "string" && c.characterName.length > 0 && id(c.corporationID);
      if (!identityOK) why.push("CHARACTER_MALFORMED");
      const shipID = Number(c.shipID), rawHull = items?.[shipID], hull = itemRow(String(shipID), rawHull);
      const stationID = Number(c.stationID) || null, structureID = Number(c.structureID) || null, systemID = Number(c.solarSystemID) || null;
      const locationID = stationID || structureID || systemID;
      const shipOK = hull && hull.ownerID === pilotID && rawHull.singleton === 1 && hull.quantity === 1 &&
        hull.locationID === locationID && (!c.shipTypeID || c.shipTypeID === hull.typeID);
      if (!hull) why.push("CURRENT_SHIP_UNREADABLE");
      else if (!shipOK) why.push("SHIP_IDENTITY_MISMATCH");
      const direct = [], descendants = [], queue = shipOK ? [shipID] : [], visited = new Set();
      while (queue.length) {
        const parent = queue.shift();
        if (visited.has(parent) || visited.size >= limit) { why.push("CHILD_TRAVERSAL_INCOMPLETE"); break; }
        visited.add(parent);
        for (const [k,r] of all.filter(([,r]) => object(r) && r.locationID === parent)) {
          const row = itemRow(k,r);
          if (!row || row.ownerID !== pilotID) { why.push("CHILD_ITEM_UNREADABLE"); continue; }
          descendants.push(row); queue.push(row.itemID);
          if (parent === shipID) direct.push(row);
        }
      }
      let state = { state: "UNKNOWN", owner: "UNKNOWN", online: null };
      try {
        const s = control(pilotID);
        if (s.characterID !== pilotID || typeof s.online !== "boolean" || !["offline","browser_pilot","retail_client"].includes(s.controlState)) throw new Error();
        state = { state: s.online ? "BUSY" : "FREE", owner: s.controlState, online: s.online };
      } catch { why.push("CONTROL_UNREADABLE"); }
      const complete = Boolean(stable && identityOK && shipOK && items !== null && !why.some(r => /CHILD|ITEM_ROOT|READ_DRIFT|ROOT_UNREADABLE:items/.test(r)));
      const sourceResult = { kind: source.kind, quality: "UNAVAILABLE", query: "UNKNOWN", take: "UNKNOWN / REVALIDATE ON APPLY", rows: [], reasons: [],
        corporationID: source.kind === "corp" ? source.corporationID : null, division: source.kind === "corp" ? source.division : null,
        officeID: null, contentsLocationID: null, dockedLocationID: stationID, flag: source.kind === "corp" ? 114 + source.division : 4 };
      if (stationID && items && stable && identityOK && !reasons.includes("ITEM_ROOT_MALFORMED")) {
        let sourceLocation = stationID, ownerID = pilotID, permitted = true;
        if (source.kind === "corp") {
          if (source.corporationID !== c.corporationID) reject("CORPORATION_SCOPE_REJECTED");
          ownerID = source.corporationID;
          const corp = corporations?.records?.[ownerID], runtime = corpRuntime?.corporations?.[ownerID], member = runtime?.members?.[pilotID];
          const roles = mask(member?.roles), local = mask(stationID === corp?.stationID ? member?.rolesAtHQ : stationID === member?.baseID ? member?.rolesAtBase : member?.rolesAtOther);
          const title = mask(member?.titleMask);
          const offices = Object.values(runtime?.offices || {}).filter(o => o.stationID === stationID && o.corporationID === ownerID && o.impounded === false);
          if (!corp || roles === null || local === null || title !== 0n) { permitted = false; sourceResult.reasons.push("CORPORATION_ACCESS_UNKNOWN"); }
          else { permitted = (roles & 1n) !== 0n || ((roles | local) & (1048576n << BigInt(source.division - 1))) !== 0n; sourceResult.query = permitted ? "ALLOWED" : "DENIED"; }
          if (offices.length !== 1 || !id(offices[0].officeID)) { permitted = false; sourceResult.reasons.push("OFFICE_UNKNOWN"); }
          else {
            sourceResult.officeID = offices[0].officeID;
            // EveJS division custody uses officeID, not officeFolderID.
            sourceLocation = offices[0].officeID;
          }
        } else sourceResult.query = "ALLOWED";
        if (permitted) {
          const candidates = all.filter(([,r]) => object(r) && r.ownerID === ownerID && r.locationID === sourceLocation && r.flagID === sourceResult.flag);
          const rows = candidates.map(([k,r]) => itemRow(k,r));
          sourceResult.contentsLocationID = sourceLocation;
          sourceResult.quality = rows.every(Boolean) ? "COMPLETE" : "PARTIAL";
          sourceResult.rows = rows.filter(Boolean);
        }
      }
      const name = shipOK && typeof rawHull.itemName === "string" ? rawHull.itemName : shipOK && typeof rawHull.name === "string" ? rawHull.name : null;
      return { characterID: pilotID, accountID, name: identityOK ? c.characterName : "Unknown pilot", corporationID: identityOK ? c.corporationID : null,
        locationID, stationID, structureID, systemID, dockState: shipOK ? stationID ? "DOCKED" : structureID ? "STRUCTURE" : "SPACE" : "UNKNOWN",
        shipID: shipOK ? shipID : null, shipTypeID: shipOK ? hull.typeID : null, shipName: name, control: state,
        quality: complete ? "COMPLETE" : "PARTIAL", reasons: [...new Set(why)], observation: { complete, shipTypeID: shipOK ? hull.typeID : null, rows: direct },
        contents: descendants, structural: direct.filter(r => fitting(r.flagID)), carried: direct.filter(r => !fitting(r.flagID)), source: sourceResult };
    });
    for (const p of pilots) p.revision = digest(p);
    return { version: 1, accountID, quality: stable && items && !reasons.length && pilots.every(p => p.quality === "COMPLETE") ? "COMPLETE" : "PARTIAL", completeRoster: Object.entries(characters).every(([key,c]) => id(Number(key)) && object(c) && id(Number(c.accountId ?? c.accountID ?? c.userid)) && typeof c.characterName === "string"),
      reasons, pilots, evidence: { boundary: "SYNCHRONOUS_WORLD_CACHE_DOUBLE_READ", stable, digest: digest(roots), startedAt, completedAt: now(),
        atomicGameplayTransaction: false, durableRevision: false, unsupported: ["Nested container supplies excluded", "World-cache observation is not a future Apply capability"] } };
  }
  return { project };
}
module.exports = { createProvisioningObservation };
