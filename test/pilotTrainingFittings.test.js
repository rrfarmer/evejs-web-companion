"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fittingFingerprint, decodeCorpFittingsStrict, readAccountCorpFittings,
} = require("../src/pilotTrainingFittings");

const CORP = 98000001;
const ACCOUNT = 4;
const PILOT = 90000001;
const DATE = "134285151537020000";
const ITEMS = [[483, 27, 2], [2464, 87, 2], [31370, 92, 1], [89, 5, 100]];
const data = {
  getType(id) { return Number.isSafeInteger(id) && id > 0 && id !== 999 ? { typeID: id } : null; },
  getSkillType(id) { return Number.isSafeInteger(id) && id > 0 ? { typeID: id, name: `Skill ${id}` } : null; },
  getTypeDogma(id) { return { attributes: id === 32880 ? { 182: 11, 277: 1 } : id === 483 ? { 182: 12, 277: 2 } : id === 2464 ? { 182: 13, 277: 1 } : {} }; },
};

function row({ id = 7, owner = CORP, hull = 32880, items = ITEMS, name = "Start Venture", date = DATE } = {}) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["fittingID", id], ["ownerID", owner], ["shipTypeID", hull], ["name", name],
    ["savedDate", { type: "long", value: date }],
    ["fitData", { type: "list", items: items.map((tuple) => ({ type: "tuple", items: tuple })) }],
  ] } };
}
function library(value = row()) {
  return { type: "object", name: { type: "rawstr", value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
    args: [{}, { type: "substream", value: { type: "dict", entries: [[7, value]] } }] };
}
test("strict read preserves hull, slot/rig/charge/drone flags and quantities", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  assert.equal(fit.shipTypeID, 32880);
  assert.deepEqual(fit.items, ITEMS.map(([typeID, flagID, quantity]) => ({ typeID, flagID, quantity })));
  assert.equal(fit.fittingID, 7);
});

test("strict read gives the same fit when the game port spells it: bare tuples, no cache envelope", () => {
  // What the web gateway prints as {type:"tuple", items} a decoded marshal
  // stream gives as an array, and the game-port session has already opened the
  // cached answer. The fit, and so its fingerprint, must not depend on which.
  const [viaGateway] = decodeCorpFittingsStrict(library(), CORP, data);
  const bareRow = row();
  bareRow.args.entries.find(([key]) => key === "fitData")[1] = { type: "list", items: ITEMS.map((tuple) => [...tuple]) };
  const [viaGamePort] = decodeCorpFittingsStrict({ type: "dict", entries: [[7, bareRow]] }, CORP, data);
  assert.equal(viaGamePort.invalid, undefined);
  assert.deepEqual(viaGamePort, viaGateway);
});

test("malformed tuple, unknown type, invalid flag and quantity never yield a partial manifest", () => {
  for (const items of [
    [[483, 27]], [[999, 27, 1]], [[483, 42, 1]], [[483, 27, 0]],
  ]) {
    const [fit] = decodeCorpFittingsStrict(library(row({ items })), CORP, data);
    assert.equal(fit.invalid, true);
    assert.equal(fit.items, undefined);
  }
});

test("wrong owner denies access to the corporation fitting library", () => {
  assert.throws(() => decodeCorpFittingsStrict(library(row({ owner: 99 })), CORP, data), /owner differs/);
});

test("tuple order does not change the fitting fingerprint", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  assert.equal(fittingFingerprint(32880, [...fit.items].reverse()), fit.fingerprint);
});

test("changing cargo changes the fitting fingerprint", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  const withoutCargo = fit.items.filter(item => item.flagID !== 5);
  assert.notEqual(fittingFingerprint(fit.shipTypeID, withoutCargo), fit.fingerprint);
});

test("session-free corporation read verifies ownership and never selects pilot", async () => {
  const calls = [];
  const store = { async listCharactersForAccount(accountID) {
    calls.push(["owner", accountID]);
    return accountID === ACCOUNT ? [{ accountID, characterID: PILOT, corporationID: CORP }] : [];
  } };
  const gateway = { async callMethod(service, method, args, kwargs, session, bridgeSessionID) {
    calls.push([service, method, args, session, bridgeSessionID]);
    return { result: library() };
  } };
  const denied = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: 2, data });
  assert.equal(denied.status, "NOT_OWNED");
  assert.equal(calls.length, 1);
  const result = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data });
  assert.equal(result.status, "READY");
  assert.equal(result.fittings[0].fittingID, 7);
  assert.deepEqual(calls[2].slice(0, 3), ["corpFittingMgr", "GetFittings", []]);
  assert.equal(calls[2][3].corpid, CORP);
  assert.equal(calls[2][4], undefined);
});

test("corporation change or denied service read fails closed", async () => {
  let reads = 0;
  const store = { async listCharactersForAccount() { return [{ accountID: ACCOUNT, characterID: PILOT, corporationID: reads++ ? 99 : CORP }]; } };
  const gateway = { async callMethod() { return { result: library() }; } };
  assert.equal((await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data })).status, "CORP_UNAVAILABLE");
  const denied = { async callMethod() { throw new Error("OWNER_SCOPE_DENIED"); } };
  assert.equal((await readAccountCorpFittings({ store: { async listCharactersForAccount() { return [{ accountID: ACCOUNT, characterID: PILOT, corporationID: CORP }]; } },
    gateway: denied, accountID: ACCOUNT, characterID: PILOT, data })).status, "CORP_UNAVAILABLE");
});

test("a provider who is logged in is asked on its own session, for its own corporation", async () => {
  const store = { async listCharactersForAccount(accountID) { return [{ accountID, characterID: PILOT, corporationID: CORP }]; } };
  const gateway = { async callMethod() { throw new Error("The gateway must not be asked for a pilot who is logged in."); } };
  const asked = [];
  const result = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data,
    ask: async (corporationID) => { asked.push(corporationID); return { result: library() }; } });
  assert.equal(result.status, "READY");
  assert.equal(result.fittings[0].fittingID, 7);
  assert.deepEqual(asked, [CORP]);

  // A character the account does not own is not asked for at all.
  const other = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: 2, data,
    ask: async () => { throw new Error("not asked"); } });
  assert.equal(other.status, "NOT_OWNED");
});

test("the pilot's session going is the caller's to hear of; any other refusal is an unavailable library", async () => {
  const store = { async listCharactersForAccount(accountID) { return [{ accountID, characterID: PILOT, corporationID: CORP }]; } };
  const read = (ask, gateway = {}) => readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data, ask });
  const failing = (code) => async () => { throw Object.assign(new Error(code), { code }); };
  for (const code of ["SESSION_NOT_FOUND", "NO_LIVE_SESSION", "HOSTED_GENERATION_CHANGED"]) {
    await assert.rejects(read(failing(code)), { code });
  }
  assert.equal((await read(failing("CALL_REFUSED"))).status, "CORP_UNAVAILABLE");
  assert.equal((await read(async () => { throw new Error("no code"); })).status, "CORP_UNAVAILABLE");
  assert.equal((await read(async () => { throw null; })).status, "CORP_UNAVAILABLE");
  // With nobody logged in, the gateway failing the same way is still only an unavailable library.
  assert.equal((await read(null, { callMethod: failing("SESSION_NOT_FOUND") })).status, "CORP_UNAVAILABLE");
});
