"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isBridgeWritePair, isPageWritePair, objectOfPageCall, ORGANIZATION_ENLISTMENT_METHODS } = require("../src/bridgeCallPolicy");
const { GAME_PORT_ONLY_CALLS, madeOnMoniker, retailForm } = require("../src/gamePort/retailCalls");
const { namedAfterCall, namedOnNotice } = require("../src/gamePort/cachedCallsNamed");

test("personal militia writes require the pilot's confirmation and leave the native calls unchanged", () => {
  for (const [service, method, args] of [
    ["facWarMgr", "JoinFactionAsCharacter", [500001]],
    ["fwCharacterEnlistmentMgr", "CreateMyDirectEnlistment", [500001]],
    ["fwCharacterEnlistmentMgr", "RemoveMyDirectEnlistment", []],
    ["corpRegistry", "KickOutMember", [140000001]],
  ]) {
    assert.equal(isBridgeWritePair(service, method), true);
    assert.equal(isPageWritePair(service, method), true);
    assert.ok(GAME_PORT_ONLY_CALLS.includes(`${service}.${method}`));
    assert.deepEqual(retailForm(service, method, args, null).args, args);
  }
  assert.equal(objectOfPageCall("corpRegistry", "KickOutMember"), "corporationExpected");
  assert.equal(madeOnMoniker("corpRegistry", "KickOutMember"), true);
  assert.equal(madeOnMoniker("corpRegistry", "CanBeKickedOut"), true);
  assert.equal(isBridgeWritePair("fwCharacterEnlistmentMgr", "GetMyEnlistment"), false);
});

test("organization writes and server updates forget the native militia status cache", () => {
  const reads = [["facWarMgr", "GetCorpFactionalWarStatus", []], ["facWarMgr", "GetCorporationWarFactionID", [98000000]]];
  for (const method of ORGANIZATION_ENLISTMENT_METHODS) {
    assert.equal(isBridgeWritePair("facWarMgr", method), true);
    assert.equal(isPageWritePair("facWarMgr", method), true);
    assert.ok(GAME_PORT_ONLY_CALLS.includes(`facWarMgr.${method}`));
    assert.deepEqual(retailForm("facWarMgr", method, [500001], null).args, [500001]);
    assert.deepEqual(namedAfterCall("facWarMgr", method, [500001], { corpid: 98000000 }), reads);
  }
  assert.deepEqual(namedOnNotice("OnEnlistmentStateUpdated", [], { corpid: 98000000 }), reads);
});
