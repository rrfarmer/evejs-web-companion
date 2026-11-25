"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactorySessions } = require("../src/factorySessions");

test("ownership follows the account roster, Bot Host, cockpit and game status without taking a session", async () => {
  const account = { accountID: 1 };
  const heldSessions = new Map();
  let claim = null;
  let state = { characterID: 9, online: false, controlState: "offline" };
  let reads = 0;
  const sessions = createFactorySessions({
    store: { listCharactersForAccount: async id => id === account.accountID ? [{ characterID: 9 }] : [] },
    gateway: { async getCharacterStatus(id, pilot) {
      assert.deepEqual([id, pilot], [1, 9]);
      reads++;
      return state;
    } },
    heldSessions,
    botHost: { claimedBy: () => claim },
  });

  await assert.rejects(sessions.status({ accountID: 2 }, 9), { code: "CHARACTER_NOT_FOUND" });
  assert.equal(reads, 0);
  assert.deepEqual(await sessions.status(account, 9), { characterID: 9, online: false, owner: "OFF" });
  state = { ...state, online: true, controlState: "retail_client" };
  assert.equal((await sessions.status(account, 9)).owner, "OTHER_SESSION");
  heldSessions.set("web", { characterID: 9 });
  assert.equal((await sessions.status(account, 9)).owner, "BROWSER");
  claim = "hosted-pilot";
  assert.equal((await sessions.status(account, 9)).owner, "BOT");
  state = { ...state, characterID: 10 };
  await assert.rejects(sessions.status(account, 9), { code: "CHARACTER_CONTROL_UNAVAILABLE" });
});
