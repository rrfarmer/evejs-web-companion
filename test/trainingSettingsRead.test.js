"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readTrainingSettingsContext } = require("../src/trainingSettingsRead");
const wire = (fields) => ({ type: "object", args: { entries: Object.entries(fields) } });
function fixture({ ceo = 5, roles = "1", mismatch = false, changed = false, foreign = false, corporationWire = wire } = {}) {
  let reads = 0; const calls = [];
  const account = { accountID: 17, username: "HaulerAccount" };
  const store = { async listCharactersForAccount(id) { assert.equal(id, 17); reads++; return [{ accountID: foreign ? 18 : 17, characterID: 22, characterName: "BHauler1", corporationID: changed && reads > 1 ? 99 : 98 }]; } };
  const gateway = { async callMethod(service, method, args, kwargs, session, bridge) {
    calls.push(method); assert.equal(service, "corpRegistry"); assert.equal(session.userid, 17); assert.equal(session.corpid, 98); assert.equal(bridge, undefined);
    const result = method === "GetCorporation"
      ? corporationWire({ corporationID: mismatch ? 99 : 98, corporationName: "Marked By Luck", ceoID: ceo, walletDivision1: "Training funds" })
      : wire({ corporationID: 98, characterID: 22, roles });
    return { result };
  } };
  return { account, store, gateway, calls };
}
test("settings names and wallet division labels come from owned corporation reads without selecting", async () => {
  const f = fixture(), result = await readTrainingSettingsContext(f);
  assert.deepEqual(result.corporations, [{ corporationID: 98, name: "Marked By Luck", divisions: [{ accountKey: 1000, name: "Training funds" }] }]);
  assert.deepEqual(result.authorities, [{ characterID: 22, name: "BHauler1", corporationID: 98, eligible: true }]);
  assert.deepEqual(f.calls, ["GetCorporation", "GetMember"]);
});
test("settings decode the 24.02 corporation Row and refuse incomplete cells", async () => {
  const corporationWire = (fields, truncated = false) => {
    const cells = Object.values(fields).map(value => typeof value === "string" ? { type: "wstring", value } : value);
    if (truncated) cells.pop();
    return { type: "objectex2", header: [
      [{ type: "token", value: "carbon.common.script.sys.row.Row" }],
      [{ type: "list", items: Object.keys(fields) }, { type: "list", items: cells }],
    ], list: [], dict: [] };
  };
  const result = await readTrainingSettingsContext(fixture({ corporationWire }));
  assert.deepEqual(result.corporations, [{ corporationID: 98, name: "Marked By Luck", divisions: [{ accountKey: 1000, name: "Training funds" }] }]);
  assert.equal(result.authorities[0].eligible, true);
  const incomplete = fixture({ corporationWire: fields => corporationWire(fields, true) });
  await assert.rejects(readTrainingSettingsContext(incomplete), { code: "CORPORATION_STATE_UNKNOWN" });
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

test("settings and station search routes require account auth and use bounded NPC-name search", async (t) => {
  const { once } = require("node:events"), { createApp } = require("../src/server");
  const f = fixture(), searches = [];
  const app = createApp({
    webAuth: { verifySessionToken: (token) => token === "test" ? { username: f.account.username, accountID: 17, sessionID: "settings-only" } : null },
    eveStore: { ...f.store, async getAccount(name) { return name === f.account.username ? f.account : null; } },
    eveGatewayClient: f.gateway,
    staticData: {
      findMapLocations(options) {
        searches.push(options);
        return { matches: [{ id: 60010825, name: "4C-B7X V - Moon 7 - Chemal Tech Factory", kind: "station" }], capped: false };
      },
      getStation(id) { return id === 60010825 ? { stationName: "4C-B7X V - Moon 7 - Chemal Tech Factory", solarSystemID: 30004504 } : null; },
    }, errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/pilot-training`, headers = { authorization: "Bearer test" };
  for (const path of ["settings-context", "homes?q=4C-B7X"]) assert.equal((await fetch(`${base}/${path}`)).status, 401);
  assert.deepEqual(f.calls, []); assert.deepEqual(searches, []);
  const context = await (await fetch(`${base}/settings-context`, { headers })).json();
  assert.equal(context.corporations[0].name, "Marked By Luck"); assert.equal(context.authorities[0].eligible, true);
  const found = await (await fetch(`${base}/homes?q=4C-B7X&kind=structure&limit=99999`, { headers })).json();
  assert.deepEqual(searches, [{ q: "4C-B7X", kind: "station", limit: 25 }]);
  const home = await (await fetch(`${base}/home?locationID=${found.matches[0].id}`, { headers })).json();
  assert.equal(home.home.locationID, 60010825); assert.equal(home.home.kind, "NPC_STATION");
  assert.equal(home.home.name, found.matches[0].name); assert.equal(home.home.systemID, 30004504);
  assert.deepEqual(f.calls, ["GetCorporation", "GetMember"]);
});
