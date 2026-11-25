"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readTrainingSettingsContext } = require("../src/trainingSettingsRead");
const wire = (fields) => ({ type: "object", args: { entries: Object.entries(fields) } });
function fixture({ ceo = 5, roles = "1", mismatch = false, changed = false, foreign = false } = {}) {
  let reads = 0; const calls = [];
  const account = { accountID: 17, username: "HaulerAccount" };
  const store = { async listCharactersForAccount(id) { assert.equal(id, 17); reads++; return [{ accountID: foreign ? 18 : 17, characterID: 22, characterName: "BHauler1", corporationID: changed && reads > 1 ? 99 : 98 }]; } };
  const gateway = { async callMethod(service, method, args, kwargs, session, bridge) {
    calls.push(method); assert.equal(service, "corpRegistry"); assert.equal(session.userid, 17); assert.equal(session.corpid, 98); assert.equal(bridge, undefined);
    return { result: wire(method === "GetCorporation" ? { corporationID: mismatch ? 99 : 98, corporationName: "Marked By Luck", ceoID: ceo, walletDivision1: "Training funds" }
      : { corporationID: 98, characterID: 22, roles }) };
  } };
  return { account, store, gateway, calls };
}
test("settings names and wallet division labels come from owned corporation reads without selecting", async () => {
  const f = fixture(), result = await readTrainingSettingsContext(f);
  assert.deepEqual(result.corporations, [{ corporationID: 98, name: "Marked By Luck", divisions: [{ accountKey: 1000, name: "Training funds" }] }]);
  assert.deepEqual(result.authorities, [{ characterID: 22, name: "BHauler1", corporationID: 98, eligible: true }]);
  assert.deepEqual(f.calls, ["GetCorporation", "GetMember"]);
});
test("CEO, ordinary and unreadable-role members are never offered as onboarding authority", async () => {
  for (const options of [{ ceo: 22 }, { roles: "0" }, { roles: null }, { roles: "invalid" }]) {
    const result = await readTrainingSettingsContext(fixture(options));
    assert.equal(result.authorities[0].eligible, false);
  }
});
test("wrong account, mismatched corporation and changed membership fail closed", async () => {
  for (const options of [{ foreign: true }, { mismatch: true }, { changed: true }]) await assert.rejects(readTrainingSettingsContext(fixture(options)));
});

test("an unreadable corporation record preserves the shared decoder error", async () => {
  const f = fixture();
  f.gateway.callMethod = async () => ({ result: {} });
  await assert.rejects(readTrainingSettingsContext(f), { code: "CORPORATION_STATE_UNKNOWN", statusCode: 409 });
});

test("settings context requires account authentication", async (t) => {
  const { once } = require("node:events"), { createApp } = require("../src/server");
  const f = fixture();
  const app = createApp({
    webAuth: { verifySessionToken: (token) => token === "test" ? { username: f.account.username, accountID: 17, sessionID: "settings-only" } : null },
    eveStore: { ...f.store, async getAccount(name) { return name === f.account.username ? f.account : null; } },
    eveGatewayClient: f.gateway,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/pilot-training`, headers = { authorization: "Bearer test" };
  assert.equal((await fetch(base + "/settings-context")).status, 401);
  assert.deepEqual(f.calls, []);
  const context = await (await fetch(`${base}/settings-context`, { headers })).json();
  assert.equal(context.corporations[0].name, "Marked By Luck"); assert.equal(context.authorities[0].eligible, true);
  assert.deepEqual(f.calls, ["GetCorporation", "GetMember"]);
});
