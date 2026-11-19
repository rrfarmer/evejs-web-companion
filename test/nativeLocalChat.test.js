"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { NativeLocalChat } = require("../src/gamePort/localChat");

const JITA = 30000142;
const WORMHOLE = 31002586;
const OWN = 140000001;
const OTHER = 140000002;
const reference = sequential => ({ sequential });
const named = type => `eve_public.chat.local.api.${type}`;
const member = id => ({ character: reference(id), corporation: reference(1000010) });
const place = (solarSystemID, fields) => ({ ...fields, solar_system: reference(String(solarSystemID)) });

test("native Local keeps a destination membership notice and rejects a read of the system just left", async (t) => {
  let completeRead;
  const chat = new NativeLocalChat({ characterID: OWN,
    request: () => new Promise(resolve => { completeRead = resolve; }), changed: () => {},
  });
  t.after(() => chat.close());
  chat.move(JITA);
  const stale = chat.read({ assertCurrent() {} });
  chat.notice(named("MembershipListNotice"), place(WORMHOLE, { members: [] }));
  chat.move(WORMHOLE);
  completeRead({ statusCode: 200, payload: place(JITA, { members: [member(OWN), member(OTHER)] }) });
  const result = await stale;
  assert.equal(result.loaded, true);
  assert.equal(result.roomName, `wormhole_${WORMHOLE}`);
  assert.deepEqual(result.roster, []);
});

test("native Local displays gateway speech for a silent listener, expires speakers and posts through the gateway", async (t) => {
  let now = 10;
  const calls = [], views = [];
  const chat = new NativeLocalChat({ characterID: OWN, now: () => now, changed: view => views.push(view),
    request: async (type, payload) => { calls.push([type, payload]); return { statusCode: 200 }; },
  });
  t.after(() => chat.close());
  chat.move(WORMHOLE);
  chat.notice(named("MembershipListNotice"), place(WORMHOLE, { members: [] }));
  chat.notice(named("MessageBroadcastNotice"), place(JITA, { author: reference(OTHER), message: "wrong system" }));
  chat.notice(named("MessageBroadcastNotice"), place(WORMHOLE, { author: reference(OTHER), message: "hello" }));
  assert.deepEqual(views.at(-1).roster.map(row => row.characterID), [OTHER]);
  assert.deepEqual(views.at(-1).messages.map(line => line.message), ["hello"]);
  assert.equal((await chat.send("reply", { assertCurrent() {} })).sent, true);
  assert.deepEqual(calls, [[named("BroadcastMessageRequest"), { message: "reply" }]]);
  assert.deepEqual(chat.snapshot().messages.map(line => line.message), ["hello"]);
  now += 900_000;
  assert.deepEqual(chat.snapshot().roster, []);
  chat.move(JITA);
  assert.deepEqual(chat.snapshot().messages, []);
});
