"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isBridgeWritePair, isPageWritePair, objectOfPageCall } = require("../src/bridgeCallPolicy");
const { GAME_PORT_ONLY_CALLS, madeOnMoniker, retailForm } = require("../src/gamePort/retailCalls");

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
