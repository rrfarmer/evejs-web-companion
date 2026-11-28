"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const gatewayClient = require("../src/eveGatewayClient");

test("gateway adapter uses flat character-status and exact offline command payload once", async (t) => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const calls = []; const command = { type: "offline.skill_queue.save", commandID: "review-command", controllerID: "test-controller",
    expectedStateVersion: "epoch.1", payload: { entries: [{ typeID: 3386, toLevel: 1 }], activate: true } };
  global.fetch = async (input, init) => {
    calls.push([String(input), init]);
    return Response.json({ source: "evejs-web-gateway", apiVersion: 1, ok: true,
      characterID: 7, online: false, controlState: "offline", stateVersion: "epoch.1" });
  };
  const status = await gatewayClient.getCharacterStatus(4, 7);
  assert.equal(status.stateVersion, "epoch.1"); assert.equal(status.control, undefined);
  await gatewayClient.saveOfflineSkillQueue(4, 7, command);
  assert.match(calls[0][0], /\/character-status\?accountID=4&characterID=7$/);
  assert.match(calls[1][0], /\/skill-queue$/); assert.equal(calls[1][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1][1].body), { accountID: 4, characterID: 7, command }); assert.equal(calls.length, 2);
});
