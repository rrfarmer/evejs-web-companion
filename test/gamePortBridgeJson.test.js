"use strict";

// The game port's answers, mapped for the browser's decoders, and then READ BY
// the browser's own readers.
//
// The values come from the recording of a real server
// (test/fixtures/gamePortFrames.json), replayed through the session. The
// readers are web/src/bridge/wire.ts itself, the module every bridge decoder
// reads through. If those readers can read what src/gamePort/bridgeJson.js
// produces, a decoder built on them can.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const wire = require("../web/src/bridge/wire.ts");
const { marshalDecodeExact } = require("../src/gameProtocol/marshal");
const { GamePortSession } = require("../src/gamePort/session");
const { longKeptToBridgeJson, notificationToBridgeJson, sessionChangeToBridgeJson, wireToBridgeJson } = require("../src/gamePort/bridgeJson");
const { converse, recordingSessionOptions: captureOptions } = require("../scripts/capture-game-frames");
const fixture = require("./fixtures/gamePortFrames.json");
// This recording was made on 3396210. New captures use the current default profile.
const recordingSessionOptions = () => ({ ...captureOptions(), client: {
  handshakeSecret: 170472, machoVersion: 496, version: 24.01,
  build: 3396210, codename: "V24.01", region: "ccp",
} });

const serverFrames = fixture.frames.filter((frame) => frame.from === "server").map((frame) => ({ ...frame, bytes: Buffer.from(frame.hex, "hex") }));

/** The recorded conversation, replayed: what each call answered, and what was pushed. */
async function replayed(context) {
  const transport = { sent: [], onClose: null, close() {} };
  let next = 0;
  let handler = null;
  const flush = () => {
    while (handler && next < serverFrames.length && serverFrames[next].afterClientFrames <= transport.sent.length) {
      next += 1;
      handler(serverFrames[next - 1].bytes);
    }
  };
  Object.defineProperty(transport, "onFrame", { get: () => handler, set: (value) => { handler = value; setImmediate(flush); } });
  transport.send = (payload) => { transport.sent.push(payload); setImmediate(flush); };
  const session = new GamePortSession({ transport, ...recordingSessionOptions() });
  context.after(() => session.close());
  const notifications = [];
  const sessionChanges = [];
  session.onNotification((notification) => notifications.push(notification));
  session.onSessionChange((changes) => sessionChanges.push(changes));
  const results = await converse(session, { accountName: fixture.accountName, characterID: fixture.characterID, settleMs: 0 });
  return { results, notifications, sessionChanges };
}

/** JSON and back: what the value will be once it has crossed to the browser. */
const crossed = (value) => JSON.parse(JSON.stringify(value));

test("every answer in the recording maps to plain JSON, with nothing left unmapped", { timeout: 10_000 }, async (context) => {
  const { results } = await replayed(context);
  for (const [name, value] of Object.entries(results)) {
    if (name === "broker" || name === "refusal") continue;
    const mapped = wireToBridgeJson(value);
    const text = JSON.stringify(mapped);
    assert.equal(typeof text, "string", name);
    assert.deepEqual(crossed(mapped), mapped, `${name}: survives JSON unchanged`);
    assert.ok(!text.includes('"unmapped"'), `${name}: every codec form has a mapping`);
  }
});

test("a list of KeyVals reads through the browser's readKeyVal", { timeout: 10_000 }, async (context) => {
  const { results } = await replayed(context);
  const keyMap = crossed(wireToBridgeJson(results.keyMap));
  assert.ok(wire.isListValue(keyMap));
  const rows = keyMap.items.map((row) => ({ key: wire.readKeyVal(row, "key"), keyName: wire.readKeyVal(row, "keyName") }));
  assert.ok(rows.length > 0 && rows.every((row) => wire.isKeyValValue(keyMap.items[0])));
  // account.GetKeyMap: the wallet's keys. 1000 is cash on every server.
  assert.deepEqual(rows.find((row) => row.key === 1000), { key: 1000, keyName: "cash" });
});

test("packed rows read through the browser's readPackedRow and readRowField, by either form", { timeout: 10_000 }, async (context) => {
  const { results } = await replayed(context);
  const items = crossed(wireToBridgeJson(results.hangarItems));
  assert.ok(wire.isListValue(items) && items.items.length > 0);
  for (const row of items.items) {
    assert.ok(wire.isPackedRowValue(row));
    const itemID = wire.readRowField(row, "itemID");
    const typeID = wire.readPackedRow(row, "typeID");
    assert.ok(wire.unwrapLong(itemID) > 0n, "an item ID the long reader accepts");
    assert.ok(Number.isInteger(typeID) && typeID > 0);
    assert.equal(wire.readRowField(row, "ownerID"), fixture.characterID);
    // The server builds a row either with named fields or with positional
    // values; the reader takes whichever it finds. Ours carries both, alike.
    const { fields, ...positional } = row;
    const { values, ...named } = row;
    assert.equal(wire.readPackedRow(positional, "itemID"), itemID, "by position");
    assert.equal(wire.readPackedRow(named, "itemID"), itemID, "by name");
    assert.equal(wire.readPackedRow(row, "noSuchColumn"), undefined);
    void fields;
    void values;
  }
});

test("a cached answer the browser could never open arrives as its rows", { timeout: 10_000 }, async (context) => {
  const { results } = await replayed(context);
  // corporationSvc.GetAllCorpMedals: through the gateway the browser gets a
  // reference into the object cache and reads nothing. Here it gets the object.
  const [medals, graphics] = crossed(wireToBridgeJson(results.medals));
  for (const rowset of [medals, graphics]) {
    assert.equal(rowset.type, "object");
    assert.match(rowset.name, /Rowset$/);
    assert.ok(Array.isArray(wire.readRowsetRows(rowset)), "a rowset the browser's reader accepts");
  }
});

test("what the server pushes maps to the gateway's notification shape", { timeout: 10_000 }, async (context) => {
  const { notifications, sessionChanges } = await replayed(context);
  const skills = notificationToBridgeJson(notifications.find((notification) => notification.method === "OnServerSkillsChanged"));
  assert.deepEqual({ kind: skills.kind, service: skills.service, method: skills.method, idType: skills.idType, kwargs: skills.kwargs }, {
    kind: "client", service: null, method: "OnServerSkillsChanged", idType: "charid", kwargs: null,
  });
  assert.ok(Array.isArray(skills.args));
  assert.deepEqual(crossed(skills), skills);

  const select = sessionChanges.find((changes) => "charid" in changes);
  const change = sessionChangeToBridgeJson(select);
  assert.deepEqual({ kind: change.kind, method: change.method }, { kind: "sessionchange", method: "OnSessionChanged" });
  assert.deepEqual(change.args[0].charid, [null, fixture.characterID]);
  assert.ok(Number(change.args[0].stationid[1]) > 0);
});

test("bytes that are text become a string, and bytes that are not stay bytes", () => {
  assert.equal(wireToBridgeJson(Buffer.from("CrpAccessDenied")), "CrpAccessDenied");
  assert.equal(wireToBridgeJson(Buffer.from("Jita IV - Moon 4 – café", "utf8")), "Jita IV - Moon 4 – café");
  assert.equal(wireToBridgeJson(Buffer.alloc(0)), "");
  assert.equal(wireToBridgeJson(Buffer.from("two\nlines\tand a tab")), "two\nlines\tand a tab");
  // A date's four state bytes, a hash, a NUL: binary, in the gateway's spelling.
  assert.deepEqual(wireToBridgeJson(Buffer.from([7, 228, 6, 30])), { type: "Buffer", data: [7, 228, 6, 30] });
  assert.deepEqual(wireToBridgeJson(Buffer.from([0xff, 0xfe])), { type: "Buffer", data: [255, 254] });
  assert.deepEqual(wireToBridgeJson(Buffer.from([65, 0, 66])), { type: "Buffer", data: [65, 0, 66] });
});

test("an integer a number holds exactly becomes a number; a larger one a long the reader accepts", () => {
  assert.equal(wireToBridgeJson(9988400103291n), 9988400103291, "an item ID: the gateway prints a number");
  assert.equal(wireToBridgeJson(-5n), -5);
  assert.equal(wireToBridgeJson(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  const filetime = wireToBridgeJson(134358883852740000n);
  assert.deepEqual(filetime, { type: "long", value: "134358883852740000" });
  assert.equal(wire.unwrapLong(filetime), 134358883852740000n);
  assert.equal(wire.unwrapLong(wireToBridgeJson(9988400103291n)), 9988400103291n);
  assert.equal(wire.unwrapReal(wireToBridgeJson(1939882211.6)), 1939882211.6);
});

test("an answer the client hands back as it got it keeps its long for the page, however small", () => {
  // officeManager.py 114 to 117: cost = GetPriceQuote(corpid), then RentOffice(cost). Tranquility answered the
  // long 100113 and was sent that long back.
  assert.deepEqual(longKeptToBridgeJson(100113n), { type: "long", value: "100113" });
  assert.deepEqual(longKeptToBridgeJson(0n), { type: "long", value: "0" });
  // The same long as any other answer is a number, as an item's ID is.
  assert.equal(wireToBridgeJson(100113n), 100113);
  // The page's reader takes either.
  assert.equal(wire.unwrapLong(longKeptToBridgeJson(100113n)), 100113n);
  // What is no long is as any answer is: a whole number that came as an int stays a number.
  assert.equal(longKeptToBridgeJson(100113), 100113);
  assert.equal(longKeptToBridgeJson(null), null);
  assert.equal(longKeptToBridgeJson(undefined), null);
  // The answer itself, not what an answer holds.
  assert.deepEqual(longKeptToBridgeJson([5n]), [5]);
});

test("the containers keep their gateway spellings", () => {
  assert.deepEqual(wireToBridgeJson([1, Buffer.from("a"), null]), [1, "a", null]);
  assert.deepEqual(wireToBridgeJson({ type: "list", items: [1n] }), { type: "list", items: [1] });
  assert.deepEqual(
    wireToBridgeJson({ type: "dict", entries: [[Buffer.from("key"), true], [34, Buffer.from("v")]] }),
    { type: "dict", entries: [["key", true], [34, "v"]] },
  );
  assert.deepEqual(
    wireToBridgeJson({ type: "object", name: Buffer.from("util.KeyVal"), args: { type: "dict", entries: [] } }),
    { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [] } },
  );
  assert.deepEqual(wireToBridgeJson({ type: "token", value: "util.Row" }), { type: "token", value: "util.Row" });
  assert.deepEqual(wireToBridgeJson({ type: "wstring", value: "Farmer" }), { type: "wstring", value: "Farmer" });
  assert.deepEqual(wireToBridgeJson({ type: "somethingNew", value: 1 }), { type: "unmapped", codecType: "somethingNew" });
  assert.equal(wireToBridgeJson(undefined), null);
  assert.equal(wireToBridgeJson(Number.NaN), null);
});

test("every recorded server frame maps without a form left over", () => {
  for (const [index, frame] of serverFrames.entries()) {
    const bytes = frame.bytes[0] === 0x7e ? frame.bytes : zlib.inflateSync(frame.bytes);
    const text = JSON.stringify(wireToBridgeJson(marshalDecodeExact(bytes)));
    assert.ok(!text.includes('"unmapped"'), `server frame ${index} (${frame.during})`);
  }
});


test("24.02 Row from the EveJS encoder reads through browser row readers", () => {
  // server/src/services/_shared/serviceHelpers.buildRow + server's marshalEncode:
  // buildRow(["ownerID", "ownerName"], [98000001, "Example"]).
  // These bytes were emitted by the 3698585 branch's encoder, not this codec.
  const bytes = Buffer.from("7e00000000232c250220636172626f6e2e636f6d6d6f6e2e7363726970742e7379732e726f772e526f772c1502113f1140150204815cd70513074578616d706c652d2d", "hex");
  const row = crossed(wireToBridgeJson(marshalDecodeExact(bytes)));
  assert.equal(row.name, "util.Row");
  assert.deepEqual(row.args.entries, [["header", { type: "list", items: ["ownerID", "ownerName"] }], ["line", { type: "list", items: [98000001, "Example"] }]]);
  const nested = crossed(wireToBridgeJson({ type: "list", items: [marshalDecodeExact(bytes)] }));
  const { decodeCorpEveOwners } = require("../web/src/bridge/corpMembers.ts");
  assert.deepEqual(decodeCorpEveOwners(nested), [{ ownerID: 98000001, ownerName: "Example", typeID: null, gender: null, ownerNameID: null }]);
  const malformed = marshalDecodeExact(bytes);
  malformed.header[1][1].items.pop();
  assert.equal(wireToBridgeJson(malformed).type, "objectex2", "invalid lengths remain visible, not a fabricated row");
});
