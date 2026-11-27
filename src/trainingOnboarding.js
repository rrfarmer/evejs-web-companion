"use strict";
const { randomUUID } = require("node:crypto");
const { trainingError } = require("./pilotTrainingRead");
const { readCorporationRow } = require("../web/src/bridge/corporationRow.ts");

// EveJS 0.12.9 server/src/services/corporation/corporationRuntimeState.js:
// FULL_GRANTABLE_ROLE_MASK = FULL_ADMIN_ROLE_MASK & ~CORP_ROLE_DIRECTOR;
// FULL_LOCATIONAL_ROLE_MASK covers deliveries/hangar/container query and take.
// Strings preserve the full 64-bit service payload. No CEO/Director promotion.
const ORDINARY = "9222811354509877120", LOCATION = "558552041119758";
const RIGHTS = { roles: ORDINARY, grantableRoles: ORDINARY,
  rolesAtHQ: LOCATION, grantableRolesAtHQ: LOCATION, rolesAtBase: LOCATION,
  grantableRolesAtBase: LOCATION, rolesAtOther: LOCATION, grantableRolesAtOther: LOCATION };
function scalar(value) { return value && typeof value === "object" && "value" in value ? value.value : value; }
function row(value) {
  const fields = readCorporationRow(value);
  if (fields === null) throw trainingError("CORPORATION_STATE_UNKNOWN");
  return fields;
}
function applications(value, corporationID, characterID) {
  if (value?.type !== "dict" || !Array.isArray(value.entries)) throw trainingError("APPLICATION_STATE_UNKNOWN");
  const list = value.entries.find(([id]) => Number(scalar(id)) === corporationID)?.[1];
  if (!list) return [];
  if (list.type !== "list" || !Array.isArray(list.items)) throw trainingError("APPLICATION_STATE_UNKNOWN");
  return list.items.map(row).filter((r) => Number(r.characterID) === characterID && Number(r.corporationID) === corporationID);
}
function createTrainingOnboarding({ store, gateway, sessions, now = Date.now }) {
  const reviews = new Map();
  const call = async (actor, method, args = []) => (await gateway.callMethod("corpRegistry", method, args, null,
    { userid: actor.userid, characterID: actor.characterID, corpid: actor.corporationID, corporationID: actor.corporationID }, actor.bridgeSessionID)).result;
  async function owned(account, id) {
    const char = (await store.listCharactersForAccount(account.accountID)).find((c) => c.characterID === id && c.accountID === account.accountID);
    if (!char) throw trainingError("CHARACTER_NOT_FOUND", "Account does not own pilot.", 404);
    return char;
  }
  async function inspect(context, config, authority) {
    if (config.enabled !== true) throw trainingError("ONBOARDING_DISABLED");
    if (!Number.isSafeInteger(config.corporationID) || config.corporationID <= 0 ||
      !["NONE", "FULL_ACCESS_EXCEPT_CEO"].includes(config.rights)) throw trainingError("ONBOARDING_UNCONFIGURED");
    if (!authority || authority.characterID === config.characterID) throw trainingError("DEDICATED_AUTHORITY_REQUIRED");
    const trainee = await owned(context.account, config.characterID);
    const source = row(await call({ userid: context.account.accountID, characterID: trainee.characterID, corporationID: trainee.corporationID }, "GetCorporation"));
    if (Number(source.corporationID) !== trainee.corporationID || !Number.isSafeInteger(Number(source.ceoID)) || Number(source.ceoID) <= 0) throw trainingError("CORPORATION_STATE_UNKNOWN");
    if (Number(source.ceoID) === trainee.characterID) throw trainingError("CEO_AUTHORITY_NOT_ALLOWED");
    const officer = await owned(authority.account, authority.characterID);
    if (officer.corporationID !== config.corporationID) throw trainingError("CORPORATION_MISMATCH");
    const actor = { userid: authority.account.accountID, characterID: authority.characterID, corporationID: config.corporationID };
    const corp = row(await call(actor, "GetCorporation"));
    const ceoID = Number(corp.ceoID);
    if (!Number.isSafeInteger(ceoID) || ceoID <= 0 || Number(corp.corporationID) !== config.corporationID) throw trainingError("CORPORATION_STATE_UNKNOWN");
    if ([authority.characterID, config.characterID].includes(ceoID)) throw trainingError("CEO_AUTHORITY_NOT_ALLOWED", "Configure a dedicated non-CEO Director. Pilot Training never acquires the CEO.");
    const member = row(await call(actor, "GetMember", [authority.characterID]));
    if (Number(member.characterID) !== authority.characterID || Number(member.corporationID) !== config.corporationID ||
      !/^\d+$/.test(String(member.roles)) || !(BigInt(member.roles) & 1n)) throw trainingError("DIRECTOR_AUTHORITY_REQUIRED");
    if (trainee.corporationID === config.corporationID) {
      const target = row(await call(actor, "GetMember", [config.characterID]));
      if (Number(target.characterID) !== config.characterID || Number(target.corporationID) !== config.corporationID ||
        !/^\d+$/.test(String(target.roles)) || BigInt(target.roles) & 1n || Number(target.blockRoles) !== 0) throw trainingError("MEMBER_ROLES_PROTECTED");
    }
    return { corporationID: config.corporationID, corporationName: corp.corporationName || `Corporation ${config.corporationID}`,
      ceoID, previousCorporationID: trainee.corporationID, characterID: config.characterID, authorityID: authority.characterID, rights: config.rights };
  }
  async function review(context, request, authority) {
    const facts = await inspect(context, request, authority);
    for (const ref of [{ account: context.account, characterID: request.characterID }, authority]) {
      if ((await sessions.status(ref.account, ref.characterID)).owner !== "OFF") throw trainingError("PILOT_BUSY");
    }
    const reviewID = randomUUID(), expiresAt = now() + 180000;
    for (const [id, r] of reviews) if (r.expiresAt <= now()) reviews.delete(id);
    while (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
    reviews.set(reviewID, { facts, config: { enabled: true, corporationID: request.corporationID, rights: request.rights, characterID: request.characterID },
      accountID: context.account.accountID, sessionID: context.sessionID, authorityAccountID: authority.account.accountID,
      authoritySessionID: authority.sessionID, expiresAt });
    return { ...facts, reviewID, expiresAt, roleMasks: request.rights === "FULL_ACCESS_EXCEPT_CEO" ? RIGHTS : null };
  }
  async function apply(context, request, authority) {
    if (request.confirm !== true) throw trainingError("CONFIRMATION_REQUIRED");
    const r = reviews.get(request.reviewID);
    if (!r || r.accountID !== context.account.accountID || r.sessionID !== context.sessionID || r.expiresAt <= now() ||
      !authority || authority.account.accountID !== r.authorityAccountID || authority.sessionID !== r.authoritySessionID || authority.characterID !== r.facts.authorityID) throw trainingError("REVIEW_REQUIRED");
    reviews.delete(request.reviewID);
    const facts = await inspect(context, r.config, authority);
    if (JSON.stringify(facts) !== JSON.stringify(r.facts)) throw trainingError("ONBOARDING_CHANGED");
    const steps = [];
    let result;
    try {
      result = await sessions.withSessions([{ account: context.account, characterID: r.config.characterID }, authority], async ([trainee, officer]) => {
        trainee.corporationID = facts.previousCorporationID; officer.corporationID = facts.corporationID;
        try {
          const checkAuthority = async () => {
            const current = await inspect(context, r.config, authority);
            if (current.ceoID !== facts.ceoID) throw trainingError("CORPORATION_CHANGED");
          };
          await checkAuthority();
          if (facts.previousCorporationID !== facts.corporationID) {
            const pending = applications(await call(trainee, "GetMyApplications"), facts.corporationID, trainee.characterID)
              .filter((a) => [0, 6, 8].includes(Number(a.status)));
            if (pending.length > 1) throw trainingError("APPLICATION_REVIEW_REQUIRED");
            let app = pending[0];
            if (!app) {
              const id = Number(scalar(await call(trainee, "InsertApplication", [facts.corporationID, "Pilot Training onboarding"])));
              app = applications(await call(trainee, "GetMyApplications"), facts.corporationID, trainee.characterID).find((a) => Number(a.applicationID) === id);
              if (!app || Number(app.status) !== 0) throw trainingError("APPLICATION_UNVERIFIED");
              steps.push("APPLICATION_VERIFIED");
            }
            if (Number(app.status) === 0) {
              await checkAuthority();
              await call(officer, "UpdateApplicationOffer", [Number(app.applicationID), trainee.characterID, facts.corporationID, app.applicationText || "", 6, "Pilot Training onboarding"]);
              const offered = applications(await call(trainee, "GetMyApplications"), facts.corporationID, trainee.characterID).find((a) => Number(a.applicationID) === Number(app.applicationID));
              if (Number(offered?.status) !== 6) throw trainingError("OFFER_UNVERIFIED");
              steps.push("OFFER_VERIFIED");
            }
            await checkAuthority();
            await call(trainee, "UpdateApplicationOffer", [Number(app.applicationID), trainee.characterID, facts.corporationID, app.applicationText || "", 2, "Pilot Training onboarding"]);
            if ((await owned(context.account, trainee.characterID)).corporationID !== facts.corporationID) throw trainingError("MEMBERSHIP_UNVERIFIED");
            steps.push("MEMBERSHIP_VERIFIED");
          }
          await checkAuthority();
          if (r.config.rights === "FULL_ACCESS_EXCEPT_CEO") {
            await call(officer, "UpdateMember", [trainee.characterID, null, null, null, ORDINARY, ORDINARY, LOCATION, LOCATION, LOCATION, LOCATION, LOCATION, LOCATION, null, null, null]);
            const member = row(await call(officer, "GetMember", [trainee.characterID]));
            if (Number(member.characterID) !== trainee.characterID || Number(member.corporationID) !== facts.corporationID ||
                Object.entries(RIGHTS).some(([key, mask]) => String(member[key]) !== mask)) throw trainingError("RIGHTS_UNVERIFIED");
            steps.push("ORDINARY_RIGHTS_VERIFIED");
          }
          const corp = row(await call(officer, "GetCorporation"));
          if (Number(corp.ceoID) !== facts.ceoID) throw trainingError("CEO_STATE_CHANGED");
          return { status: "ONBOARDING_VERIFIED", verified: true, ceoID: facts.ceoID, corporationID: facts.corporationID, steps };
        } catch (error) {
          let corporationID = null;
          try { corporationID = (await owned(context.account, trainee.characterID)).corporationID; } catch { /* unknown remains unknown */ }
          return { status: "ONBOARDING_INCOMPLETE", verified: false, code: error.code || "ONBOARDING_UNVERIFIED", corporationID, steps,
            message: "Stopped. Completed membership/role changes are retained; no retry or rollback. Reread before another review." };
        }
      });
    } catch (error) { return { status: "ONBOARDING_INCOMPLETE", verified: false, code: error.code, steps, cleanup: error.cleanup || [] }; }
    return { ...result.value, cleanup: result.cleanup, verified: result.value.verified && result.cleanup.every((c) => c.released) };
  }
  return { review, apply };
}
module.exports = { createTrainingOnboarding, RIGHTS, row, applications };
