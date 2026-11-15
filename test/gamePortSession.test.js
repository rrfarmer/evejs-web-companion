"use strict";

// The game-port session against a conversation with a REAL eve.js server.
//
// test/fixtures/gamePortFrames.json is a recording (scripts/capture-game-frames.js)
// of one whole docked session in both directions: the queue check, the login,
// a character select, an inventory bind and a keep-alive. The server's half is
// what a real server wrote. The client's half is what this session wrote, and
// the real server accepted every frame of it.
//
// Three kinds of test, in this order:
//   1. the recording itself decodes
//   2. the session, replayed against the server's half, sends its half again
//      byte for byte and ends in the same state
//   3. each frame of the client's half says what the retail client says there
//      (docs/game-port-client-reference.md is the list being checked)
// and then behaviour a recording cannot trigger, with frames built here.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { marshalDecode, marshalDecodeExact, marshalEncode } = require("../src/gameProtocol/marshal");
const { GamePortSession, GamePortError, RETAIL_CLIENT } = require("../src/gamePort/session");
const { TYPE, buildPacket, clientAddress, nodeAddress, parsePacket, text, dictGet } = require("../src/gamePort/packets");
const { caseFold, cryptoHash, passwordHash } = require("../src/gamePort/placebo");
const { monikerKeywordOrder } = require("../src/gamePort/py27");
const { retailForm } = require("../src/gamePort/retailCalls");
const { converse, recordingSessionOptions: captureOptions } = require("../scripts/capture-game-frames");
const fixture = require("./fixtures/gamePortFrames.json");
// This recording was made on 3396210. New captures use the current default profile.
const recordingSessionOptions = () => ({ ...captureOptions(), client: {
  handshakeSecret: 170472, machoVersion: 496, version: 24.01,
  build: 3396210, codename: "V24.01", region: "ccp",
} });
const oracle = require("./fixtures/py27Oracle.json");

const frames = fixture.frames.map((frame) => ({ ...frame, bytes: Buffer.from(frame.hex, "hex") }));
const serverFrames = frames.filter((frame) => frame.from === "server");
const clientFrames = frames.filter((frame) => frame.from === "client");
/** How many client frames the login takes: everything up to and including the clock sync. */
const LOGIN_CLIENT_FRAMES = clientFrames.filter((frame) => frame.during === "login").length;

const inflated = (bytes) => (bytes[0] === 0x7e ? bytes : zlib.inflateSync(bytes));
const decoded = (frame) => marshalDecodeExact(inflated(frame.bytes));
const settle = () => new Promise((resolve) => setImmediate(resolve));

// The stock encoder writes an integer beyond 32 bits as an int64, and the stock
// decoder reads an int64 back as a BigInt even when the server had sent the
// same value in the variable-length form that reads as a number. Same integer.
function integersByValue(value) {
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : value;
  if (Array.isArray(value)) return value.map(integersByValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, integersByValue(entry)]));
  }
  return value;
}

/**
 * A transport that plays the recording's server half: each frame once the
 * session has sent as many frames as the real client had when it arrived.
 * `limit` stops the replay after that many client frames, so a test can take
 * over from a known point.
 */
function replayTransport({ limit = Infinity, rewrite = (frame) => frame.bytes } = {}) {
  const transport = { sent: [], closed: false, onClose: null };
  let next = 0;
  let handler = null;
  const flush = () => {
    while (handler && next < serverFrames.length && serverFrames[next].afterClientFrames <= Math.min(transport.sent.length, limit)) {
      const frame = serverFrames[next];
      next += 1;
      handler(rewrite(frame, next - 1));
    }
  };
  Object.defineProperty(transport, "onFrame", {
    get: () => handler,
    set: (value) => {
      handler = value;
      setImmediate(flush);
    },
  });
  transport.send = (payload) => {
    transport.sent.push(Buffer.from(payload));
    setImmediate(flush);
  };
  transport.close = () => { transport.closed = true; };
  /** Hand the session a frame the recording does not hold. */
  transport.deliver = (payload) => handler(payload);
  return transport;
}

/** setTimeout by hand: time moves only when a test says so. */
function manualTime() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout: (action, delay) => {
        sequence += 1;
        pending.set(sequence, { at: now + delay, action });
        return sequence;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    pending,
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].action();
        await settle();
        await settle();
      }
      now = target;
    },
  };
}

/** A session that has just finished the recorded login, and its transport. */
async function loggedIn(context, options = {}) {
  const transport = replayTransport({ limit: LOGIN_CLIENT_FRAMES, ...options.replay });
  const session = new GamePortSession({ transport, ...recordingSessionOptions(), ...options.session });
  context.after(() => session.close());
  await session.login(fixture.accountName, "");
  return { session, transport };
}

/** The last call the session sent, read back off the wire. */
function lastCall(transport) {
  const packet = parsePacket(marshalDecodeExact(inflated(transport.sent.at(-1))));
  const [flag, pickle] = packet.body[0];
  const [target, method, args, kwargs] = pickle.value;
  return { packet, flag, target: text(target) ?? target, method: text(method), args, kwargs };
}

const callResponse = (callID, result) => marshalEncode(buildPacket(TYPE.CALL_RSP, {
  source: nodeAddress(65450, "test"),
  destination: clientAddress(2065450, callID),
  userID: 2,
  body: [{ type: "substream", value: result }],
}));

test("the current client profile matches 3698585 start.ini and GPS.py", () => {
  assert.deepEqual(RETAIL_CLIENT, {
    handshakeSecret: 170472, machoVersion: 496, version: 24.02,
    build: 3698585, codename: "V24.02", region: "ccp",
  });
});

// ── 1. the recording ─────────────────────────────────────────────────────────

test("the recording is one whole docked session", () => {
  assert.equal(typeof fixture.accountName, "string");
  assert.ok(Number.isSafeInteger(fixture.characterID), "it selected a character");
  assert.ok(serverFrames.length >= 20 && clientFrames.length >= 15);
  for (const step of ["login", "charUnboundMgr.SelectCharacterID", "invbroker bind", "GetInventory", "account.GetKeyMap", "corporationSvc.GetAllCorpMedals", "pingService.Ping"]) {
    assert.ok(frames.some((frame) => frame.during === step), step);
  }
});

test("every frame a real server sent decodes with no bytes left over", () => {
  for (const [index, frame] of serverFrames.entries()) {
    assert.doesNotThrow(() => decoded(frame), `server frame ${index} (${frame.during})`);
  }
});

test("a real frame cut short is refused, not half-read", () => {
  for (const [index, frame] of serverFrames.entries()) {
    const bytes = inflated(frame.bytes);
    assert.throws(() => marshalDecodeExact(bytes.subarray(0, bytes.length - 1)), `server frame ${index} (${frame.during})`);
  }
});

test("a real frame survives decode, encode, decode", () => {
  for (const [index, frame] of serverFrames.entries()) {
    const value = decoded(frame);
    const again = marshalDecodeExact(marshalEncode(value));
    assert.deepEqual(integersByValue(again), integersByValue(value), `server frame ${index} (${frame.during})`);
  }
});

// ── 2. the session, replayed ─────────────────────────────────────────────────

test("replayed against the real server's half, the session sends its own half again byte for byte", { timeout: 10_000 }, async (context) => {
  const transport = replayTransport();
  const session = new GamePortSession({ transport, ...recordingSessionOptions() });
  context.after(() => session.close());
  const notifications = [];
  const sessionChanges = [];
  session.onNotification((notification) => notifications.push(notification));
  session.onSessionChange((changes) => sessionChanges.push(Object.keys(changes)));

  const results = await converse(session, { accountName: fixture.accountName, characterID: fixture.characterID, settleMs: 0 });
  await settle();

  assert.equal(transport.sent.length, clientFrames.length, "the same number of frames");
  for (const [index, frame] of clientFrames.entries()) {
    assert.equal(transport.sent[index].toString("hex"), frame.hex, `client frame ${index} (${frame.during})`);
  }

  // What the login told us.
  assert.equal(session.logonQueuePosition, 0);
  assert.ok(Number.isSafeInteger(session.userID) && session.userID > 0);
  assert.ok(Number.isSafeInteger(session.proxyNodeID) && session.proxyNodeID > 0);
  assert.equal(session.unknownHandshakeFunction, null, "the server's login function is one we can answer");
  // And what was answered is kept: it says what the function did to the client that ran it (pilotClock.js).
  assert.equal(session.handshakeAnswer, "TIDI_HANDLER:OK\nPORTRAIT_UPLOAD_HANDLER:OK\nSKILL_EXTRACTOR_ACCESS_TOKEN:OK\n");
  assert.equal(session.serviceInfo.type, "dict");
  assert.ok(session.serviceInfo.entries.length > 100, "GetServiceInfo names the server's services");

  // What the calls answered.
  assert.ok(Array.isArray(results.selection) && results.selection.length === 4, "character selection's four parts");
  assert.match(results.broker.objectID, /^N=\d+:\d+$/);
  assert.equal(results.broker.nodeID, session.proxyNodeID);
  assert.equal(results.hangar.type, "substruct", "GetInventory answers a bound inventory");
  assert.ok(results.hangarItems.items.length > 0, "the hangar is not empty in the recording");
  assert.ok(results.hangarItems.items.every((row) => row.type === "packedrow"), "its contents are packed rows");

  // A refusal carries the server's own reason, the one the gateway reports too.
  assert.equal(results.refusal.code, "GAME_CALL_REFUSED");
  assert.deepEqual(
    { className: results.refusal.refusal.className, key: results.refusal.refusal.key, reason: results.refusal.refusal.reason },
    { className: "eveexceptions.UserError", key: "CrpAccessDenied", reason: "CrpAccessDenied" },
  );
  assert.match(results.refusal.message, /corpRegistry\.GetApplications was refused by the server: CrpAccessDenied/);

  // Cached answers come back as the answer, not as the wrapper around it.
  // GetKeyMap's is carried inline. GetAllCorpMedals' is a reference: the session
  // fetched it from objectCaching the first time and reused it the second.
  assert.equal(results.keyMap.type, "list", "an inline cached answer, unwrapped");
  assert.ok(results.keyMap.items.length > 0);
  assert.ok(Array.isArray(results.medals) && results.medals.length === 2, "a fetched cached answer: the medals and their graphics");
  assert.equal(results.medalsAgain, results.medals, "the second answer is the object already held");
  assert.equal(session.cachedObjects.size, 1);

  // What the server pushed: the session change of a character select, and its
  // notification. Both arrive on their own, between calls.
  assert.equal(Number(session.attributes.charid), fixture.characterID);
  assert.ok(Number(session.attributes.stationid) > 0 && Number(session.attributes.solarsystemid2) > 0);
  assert.ok(sessionChanges.some((names) => names.includes("charid") && names.includes("stationid")));
  const skills = notifications.find((notification) => notification.method === "OnServerSkillsChanged");
  assert.ok(skills, "OnServerSkillsChanged was read");
  assert.equal(skills.idtype, "charid");
  assert.ok(Array.isArray(skills.args), "a broadcast's arguments are a tuple");

  assert.equal(session.counters.unknownPackets, 0, "every packet the server sent was understood");
  assert.equal(session.pending.size, 0);
});

// ── 3. the client's half, frame by frame ─────────────────────────────────────

test("the queue check and the version reply are the retail client's", () => {
  const [versionReply, queueCheck, secondVersionReply] = clientFrames.map(decoded);
  // (secret, macho.version, 0, boot.version, boot.build, codename@region)
  for (const reply of [versionReply, secondVersionReply]) {
    assert.deepEqual(reply.slice(0, 5), [170472, 496, 0, 24.01, 3396210]);
    assert.equal(text(reply[5]), "V24.01@ccp");
    assert.equal(reply.length, 6);
  }
  assert.equal(queueCheck[0], null);
  assert.equal(text(queueCheck[1]), "QC");
});

test("the login frames carry Placebo's values and the client's dict order", () => {
  const [, , , vipKey, cryptoRequest, login, challengeResponse] = clientFrames.map(decoded);
  assert.equal(text(vipKey[1]), "VK");
  // The name is typed into an edit box, so the client hashes a unicode object.
  // Hashing the same letters as a byte string gives a different number.
  const unicodeName = { type: "wstring", value: caseFold(fixture.accountName) };
  assert.equal(text(vipKey[2]), cryptoHash(unicodeName));
  assert.notEqual(cryptoHash(unicodeName), cryptoHash(caseFold(fixture.accountName)));
  assert.equal(text(cryptoRequest[0]), "placebo");
  assert.deepEqual(cryptoRequest[1], { type: "dict", entries: [] });

  const [challenge, credentials] = login;
  assert.equal(text(challenge), "\u0000".repeat(64));
  // The order the client's own interpreter gives this dict literal.
  const order = oracle.dicts[0].literal.map((tagged) => tagged.slice(2));
  assert.deepEqual(credentials.entries.map(([key]) => text(key)), order);
  const field = (name) => dictGet(credentials, name);
  assert.deepEqual(field("user_name"), { type: "wstring", value: fixture.accountName }, "a unicode object, not a byte string");
  assert.equal(field("user_password"), null);
  assert.deepEqual(Buffer.from(text(field("user_password_hash")), "latin1"), passwordHash(fixture.accountName, ""));
  assert.equal(text(field("user_languageid")), "EN");
  assert.equal(field("user_affiliateid"), 0);
  assert.equal(field("user_sso_token"), null);
  assert.deepEqual([field("macho_version"), field("boot_version"), field("boot_build")], [496, 24.01, 3396210]);
  assert.deepEqual([text(field("boot_codename")), text(field("boot_region"))], ["V24.01", "ccp"]);

  // (CryptoHash(serverChallenge), what the login function printed, its result)
  assert.equal(text(challengeResponse[0]), "44596");
  assert.equal(text(challengeResponse[1]), "TIDI_HANDLER:OK\nPORTRAIT_UPLOAD_HANDLER:OK\nSKILL_EXTRACTOR_ACCESS_TOKEN:OK\n");
  assert.equal(text(challengeResponse[1]).length, 75, "the length eve.js logged for the retail client");
  assert.equal(challengeResponse[2], null);
});

test("every call is addressed, numbered and wrapped as the retail client does it", () => {
  const calls = clientFrames.slice(7).map((frame) => {
    const value = decoded(frame);
    const packet = parsePacket(value);
    const [flag, pickle] = packet.body[0];
    const [target, method, args, kwargs] = pickle.value;
    return { state: value.args, packet, flag, target: text(target) ?? target, method: text(method), args, kwargs };
  });
  const proxyNode = 65450;

  for (const [index, call] of calls.entries()) {
    const label = `call ${index + 1} ${call.method}`;
    assert.equal(call.packet.command, TYPE.CALL_REQ, label);
    assert.equal(call.state.length, 14, `${label}: a packet's state is fourteen fields`);
    // machoNet._BlockingCall: MachoAddress(clientID=0, callID=callID), counted from 1.
    assert.deepEqual(call.packet.source, { kind: "client", clientID: 0, callID: index + 1, service: null }, label);
    assert.equal(call.packet.oob, null, label);
    assert.equal(call.state[6], null, `${label}: no contextKey`);
    assert.equal(text(call.state[7]), recordingSessionOptions().journeyID, `${label}: journeyID`);
    assert.deepEqual(call.state.slice(8), [null, null, null, null, null, null], `${label}: no trace context`);
    // Every call's keywords carry machoVersion.
    assert.deepEqual(call.kwargs.entries.map(([key, value]) => [text(key), value]), [["machoVersion", 1]], label);
  }

  const summary = calls.map((call) => [call.method, call.packet.destination.kind, call.packet.destination.service, call.flag]);
  assert.deepEqual(summary, [
    // machoNet.ConnectToServer's first call, to our proxy node.
    ["GetServiceInfo", "node", "machoNet", 0],
    // connectionService.SynchronizeClock, through sm.ProxySvc.
    ...Array(5).fill(["GetTime", "node", "machoNet", 0]),
    // sm.RemoteSvc: to any node.
    ["GetCharacterSelectionData", "any", "charUnboundMgr", 0],
    ["SelectCharacterID", "any", "charUnboundMgr", 0],
    // A Moniker: resolve on any node, then bind on the node it names.
    ["MachoResolveObject", "any", "invbroker", 0],
    ["MachoBindObject", "node", "invbroker", 0],
    // A bound object's call: to its node, no service, flag 1, the object's ID first.
    ["GetInventory", "node", null, 1],
    ["List", "node", null, 1],
    ["GetApplications", "any", "corpRegistry", 0],
    ["GetKeyMap", "any", "account", 0],
    // A cached answer that is a reference: the client fetches it from
    // objectCaching through its proxy node, once. The conversation asks for the
    // medals a second time, and that asking is not here: the server said the
    // answer is good for an hour, and the object cache answered it.
    ["GetAllCorpMedals", "any", "corporationSvc", 0],
    ["GetCachableObject", "node", "objectCaching", 0],
    ["Ping", "node", "pingService", 0],
  ]);
  const fetch = calls.find((call) => call.method === "GetCachableObject");
  // (shared, objectID, objectVersion, nodeID)
  assert.equal(fetch.args.length, 4);
  assert.equal(fetch.args[0], 1, "a shared object");
  assert.equal(fetch.args[3], proxyNode);
  for (const call of calls.filter((entry) => entry.packet.destination.kind === "node")) {
    assert.equal(call.packet.destination.nodeID, proxyNode, call.method);
  }
  // On the wire, the things the client holds as Python longs are longs (0x2f),
  // which the decoded packets above cannot show: the call ID, and a bound
  // object's node ID. Each call's source address is the 4-tuple
  // (2, 0, callID, None): 14 04 | 06 02 | 08 | 2f 01 <id> | 01.
  const sent = clientFrames.slice(7).map((frame) => inflated(frame.bytes).toString("hex"));
  for (const [index, hex] of sent.entries()) {
    const callID = (index + 1).toString(16).padStart(2, "0");
    assert.ok(hex.includes(`14040602082f01${callID}01`), `call ${index + 1}: its call ID is a long`);
  }
  // A bound call's destination is (1, long(nodeID), None, None): 14 04 | 09 |
  // 2f 03 aa ff 00 | 01 | 01. As a long, 65450 needs a third byte for its sign.
  assert.ok(sent[10].includes("1404092f03aaff000101"), "a bound object's node ID is a long");
  // A proxy service's is (1, proxyNodeID, service, None), with the int the login gave us.
  assert.ok(sent[0].includes("14040904aaff0000"), "the proxy node ID stays an int");

  const [resolve, bind, bound] = calls.slice(8, 11);
  assert.equal(resolve.target, 1, "a service call's first field is 1");
  assert.equal(resolve.args.length, 1, "MachoResolveObject takes the bind parameters alone");
  assert.deepEqual(bind.args[0], resolve.args[0], "and MachoBindObject is given the same ones");
  assert.equal(bind.args[1], null, "with no call to carry along");
  assert.match(bound.target, /^N=65450:\d+$/);
});

// ── behaviour a recording cannot trigger ─────────────────────────────────────

test("a login the server answers with the wrong challenge hash is abandoned", { timeout: 5000 }, async () => {
  const transport = replayTransport({
    rewrite: (frame) => {
      const value = decoded(frame);
      if (!Array.isArray(value) || value.length !== 4 || !dictGet(value[3], "challenge_responsehash")) return frame.bytes;
      const response = { type: "dict", entries: value[3].entries.map(([key, entry]) => (text(key) === "challenge_responsehash" ? [key, "12345"] : [key, entry])) };
      return marshalEncode([value[0], value[1], value[2], response]);
    },
  });
  const session = new GamePortSession({ transport, ...recordingSessionOptions() });
  await assert.rejects(session.login(fixture.accountName, ""), (error) => error instanceof GamePortError && error.code === "BAD_SERVER_SIGNATURE");
  assert.equal(transport.closed, true);
  assert.equal(session.closed, true);
});

test("a server of another build, release or region is refused before anything is sent to it", { timeout: 5000 }, async () => {
  for (const [change, code] of [
    [(tuple) => { tuple[4] = 3396211; }, "HANDSHAKE_INCOMPATIBLEBUILD"],
    [(tuple) => { tuple[3] = 24.02; }, "HANDSHAKE_INCOMPATIBLEVERSION"],
    [(tuple) => { tuple[1] = 497; }, "HANDSHAKE_INCOMPATIBLEPROTOCOL"],
    [(tuple) => { tuple[5] = "V24.01@elsewhere"; }, "HANDSHAKE_INCOMPATIBLEREGION"],
    [(tuple) => { tuple[5] = "V25.00@ccp"; }, "HANDSHAKE_INCOMPATIBLERELEASE"],
  ]) {
    const transport = replayTransport({
      rewrite: (frame, index) => {
        if (index !== 0) return frame.bytes;
        const tuple = [...decoded(frame)];
        change(tuple);
        return marshalEncode(tuple);
      },
    });
    const session = new GamePortSession({ transport, ...recordingSessionOptions() });
    await assert.rejects(session.login(fixture.accountName, ""), (error) => error.code === code, code);
    assert.equal(transport.sent.length, 0, `${code}: nothing was sent`);
    assert.equal(transport.closed, true);
  }
});

test("a login function nobody has recorded an answer for gets an empty answer, and says so", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context, { session: { handshakeFunctions: new Map() } });
  assert.match(session.unknownHandshakeFunction, /^[0-9a-f]{64}$/);
  assert.equal(session.handshakeAnswer, "");
  const challengeResponse = marshalDecodeExact(transport.sent[6]);
  assert.equal(text(challengeResponse[0]), "44596");
  assert.equal(text(challengeResponse[1]) ?? "", "");
});

test("a server ping is answered with its times and our turnaround", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const before = transport.sent.length;
  const stamp = { type: "long", value: 134358883852740000n };
  transport.deliver(marshalEncode(buildPacket(TYPE.PING_REQ, {
    source: nodeAddress(65450, null, 77),
    destination: clientAddress(2065450),
    userID: 2,
    body: [{ type: "list", items: [[stamp, stamp, "proxy::start"]] }],
  })));
  assert.equal(transport.sent.length, before + 1);
  const reply = parsePacket(marshalDecodeExact(inflated(transport.sent.at(-1))));
  assert.equal(reply.command, TYPE.PING_RSP);
  // The reply goes back where the request came from.
  assert.deepEqual(reply.destination, { kind: "node", nodeID: 65450, service: null, callID: 77 });
  assert.equal(reply.source.kind, "client");
  const times = reply.body[0].items;
  assert.deepEqual(times.map((entry) => text(entry[2])), ["proxy::start", "client::turnaround"]);
  assert.equal(session.counters.unknownPackets, 0);
});

test("a compressed frame from the server is read like any other", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const answer = session.call("config", "Anything");
  const { packet } = lastCall(transport);
  transport.deliver(zlib.deflateSync(callResponse(packet.source.callID, ["compressed", 42])));
  const result = await answer;
  assert.equal(text(result[0]), "compressed");
  assert.equal(session.counters.compressedReceived, 1);
});

test("a refusal rejects its own call with the server's words, and no other", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const first = session.call("config", "First");
  const firstID = lastCall(transport).packet.source.callID;
  const second = session.call("config", "Second");
  const secondID = lastCall(transport).packet.source.callID;
  assert.equal(secondID, firstID + 1);
  transport.deliver(marshalEncode(buildPacket(TYPE.ERROR_RESPONSE, {
    source: nodeAddress(65450, "config"),
    destination: clientAddress(2065450, secondID),
    userID: 2,
    body: [TYPE.CALL_REQ, 2, [{ type: "substream", value: "TaxChanged" }]],
  })));
  await assert.rejects(second, (error) => error.code === "GAME_CALL_REFUSED" && /config\.Second .*TaxChanged/.test(error.message));
  transport.deliver(callResponse(firstID, "fine"));
  assert.equal(text(await first), "fine");
  assert.equal(session.pending.size, 0);
});

test("a call's keywords go out in the client's order, which differs between a service and a bound object", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  // A case the client's own interpreter orders differently on its two call paths.
  const sample = oracle.keywords.find(({ written, viaFunction, viaObject }) => written.length <= 3 && viaFunction.join() !== viaObject[0].join());
  assert.ok(sample, "the oracle holds such a case");
  const kwargs = Object.fromEntries(sample.written.map((name, index) => [name, index + 10]));
  const sentKeywords = () => lastCall(transport).kwargs.entries.map(([name, value]) => [text(name), value]);
  const expected = (order) => order.map((name) => [name, name === "machoVersion" ? 1 : kwargs[name]]);

  session.call("config", "WithKeywords", [], kwargs).catch(() => {});
  assert.deepEqual(sentKeywords(), expected(sample.viaFunction), "a service's method is a plain function");
  session.callBound("N=65450:9", "WithKeywords", [], kwargs).catch(() => {});
  assert.deepEqual(sentKeywords(), expected(sample.viaObject[0]), "a bound object's method is an object with __call__");
  session.proxyCall("machoNet", "WithKeywords", [], { type: "dict", entries: Object.entries(kwargs) }).catch(() => {});
  assert.deepEqual(sentKeywords(), expected(sample.viaFunction), "keywords given as a dict are treated the same");
});

test("a cached object is fetched again only when its checksum changed and ours is older", { timeout: 5000 }, async (context) => {
  // The recorded answer to GetAllCorpMedals: a CachedMethodCallResult holding a
  // reference whose version is (timestamp, checksum).
  const recorded = serverFrames.filter((frame) => frame.during === "corporationSvc.GetAllCorpMedals").map(decoded);
  const [referenceAnswer, objectAnswer] = recorded;
  const reference = referenceAnswer.args[4][0].value;
  const [stamp, checksum] = reference.args[1].args[2];
  const withVersion = (callID, newStamp, newChecksum) => {
    const cachedObject = { ...reference.args[1], args: [reference.args[1].args[0], reference.args[1].args[1], [newStamp, newChecksum]] };
    return callResponse(callID, { ...reference, args: [reference.args[0], cachedObject, reference.args[2]] });
  };
  const fetched = (callID) => callResponse(callID, objectAnswer.args[4][0].value);
  const later = BigInt(stamp) + 600_000_000n;
  const earlier = BigInt(stamp) - 600_000_000n;

  const { session, transport } = await loggedIn(context);
  const ask = async (answerStamp, answerChecksum) => {
    // The method's own answer is kept by the object cache too (below); forgotten here, so that each asking is sent.
    session.invalidateCachedMethodCalls([["corporationSvc", "GetAllCorpMedals", [1000035]]]);
    const before = transport.sent.length;
    const answer = session.call("corporationSvc", "GetAllCorpMedals", [1000035]);
    transport.deliver(withVersion(lastCall(transport).packet.source.callID, answerStamp, answerChecksum));
    await settle();
    const asked = lastCall(transport);
    const fetchedAgain = asked.method === "GetCachableObject";
    if (fetchedAgain) transport.deliver(fetched(asked.packet.source.callID));
    await answer;
    return { fetchedAgain, sent: transport.sent.length - before };
  };

  assert.deepEqual(await ask(stamp, checksum), { fetchedAgain: true, sent: 2 }, "nothing held yet");
  assert.deepEqual(await ask(later, checksum), { fetchedAgain: false, sent: 1 }, "a new timestamp alone is not a new version");
  assert.deepEqual(await ask(earlier, Number(checksum) + 1), { fetchedAgain: false, sent: 1 }, "a different checksum that is OLDER than ours is not fetched");
  assert.deepEqual(await ask(later, Number(checksum) + 1), { fetchedAgain: true, sent: 2 }, "a different checksum that is newer is");
});

test("closing rejects every unanswered call and stops the background work", { timeout: 5000 }, async (context) => {
  const time = manualTime();
  const { session, transport } = await loggedIn(context, { session: { now: time.now, timers: time.timers } });
  assert.ok(time.pending.size >= 2, "the clock sync and the keep-alive are scheduled");
  const unanswered = session.call("config", "Never");
  let told = null;
  session.onClose((error) => { told = error; });
  session.close();
  await assert.rejects(unanswered, (error) => error.code === "CONNECTION_CLOSED");
  assert.equal(told.code, "CONNECTION_CLOSED");
  assert.equal(transport.closed, true);
  assert.equal(time.pending.size, 0, "no timer outlives the session");
  await assert.rejects(session.call("config", "After"), (error) => error.code === "NOT_CONNECTED");
});

test("a lost connection is reported once, with the reason", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const reasons = [];
  session.onClose((error) => reasons.push(error.message));
  const unanswered = session.call("config", "Never");
  transport.onClose(new Error("read ECONNRESET"));
  transport.onClose(new Error("again"));
  // LOST, not CLOSED: we did not ask for this. A takeover of the character looks
  // exactly like it; eve.js drops the old connection without a word (seen live).
  await assert.rejects(unanswered, (error) => error.code === "CONNECTION_LOST" && /ECONNRESET/.test(error.message));
  assert.deepEqual(reasons, ["read ECONNRESET"]);
  assert.equal(session.closeReason.code, "CONNECTION_LOST");
});

// The shape eve.js gives the notice (handshake.js buildGPSTransportClosedPayload).
const transportClosed = (reason, reasonCode) => marshalEncode({
  type: "objectex1",
  header: [{ type: "token", value: "carbon.common.script.net.GPSExceptions.GPSTransportClosed" }, [reason, reasonCode, { type: "dict", entries: [] }]],
  list: [],
  dict: [],
});

test("the server saying why it is hanging up ends the session with its reason", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const unanswered = session.call("config", "Never");
  transport.deliver(transportClosed("The cluster is shutting down", "CLUSTER_SHUTDOWN"));
  await assert.rejects(unanswered, (error) => error.code === "TRANSPORT_CLOSED" && /CLUSTER_SHUTDOWN/.test(error.message));
  assert.equal(session.closed, true);
  assert.equal(session.closeReason.detail.reason, "The cluster is shutting down");
  assert.equal(session.counters.unknownPackets, 0, "it was understood, not skipped");
});

test("a login the server refuses with a reason fails with that reason", { timeout: 5000 }, async () => {
  // In place of the password-version frame, as eve.js answers a refused login.
  const transport = replayTransport({
    rewrite: (frame) => (decoded(frame) === 2 ? transportClosed("LoginAuthFailed", "ACCOUNTBANNED") : frame.bytes),
  });
  const session = new GamePortSession({ transport, ...recordingSessionOptions() });
  await assert.rejects(session.login(fixture.accountName, ""), (error) => error.code === "TRANSPORT_CLOSED" && /ACCOUNTBANNED/.test(error.message));
  assert.equal(transport.closed, true);
});

test("after a minute with nothing sent, the session pings; activity puts it off", { timeout: 5000 }, async (context) => {
  const time = manualTime();
  const { session, transport } = await loggedIn(context, { session: { now: time.now, timers: time.timers } });
  const sentAfterLogin = transport.sent.length;

  await time.advance(59_000);
  assert.equal(transport.sent.length, sentAfterLogin, "not yet");
  await time.advance(1_000);
  assert.equal(transport.sent.length, sentAfterLogin + 1, "one keep-alive at sixty seconds");
  const ping = lastCall(transport);
  assert.deepEqual([ping.method, ping.packet.destination.kind, ping.packet.destination.service], ["Ping", "node", "pingService"]);
  transport.deliver(callResponse(ping.packet.source.callID, null));

  // A call at +30s is activity: the next ping is sixty seconds after THAT.
  await time.advance(30_000);
  const call = session.call("config", "Busy");
  transport.deliver(callResponse(lastCall(transport).packet.source.callID, null));
  await call;
  const sentAfterCall = transport.sent.length;
  await time.advance(59_000);
  assert.equal(transport.sent.length, sentAfterCall, "the earlier deadline no longer applies");
  await time.advance(1_000);
  assert.equal(lastCall(transport).method, "Ping");
  assert.equal(transport.sent.length, sentAfterCall + 1);
});

test("the clock sync stops after three readings that each beat the last", { timeout: 5000 }, async (context) => {
  // Each GetTime takes 30, 20, then 10 of our clock's units: three improving
  // readings, so the client's loop ends there instead of running all five.
  const durations = [30, 20, 10, 5, 1];
  let clock = 0;
  let step = 0;
  const { session, transport } = await loggedIn(context);
  session.now = () => clock;
  const before = transport.sent.length;
  const syncing = session.synchronizeClock();
  for (let answered = 0; answered < 3; answered += 1) {
    await settle();
    clock += durations[step];
    step += 1;
    transport.deliver(callResponse(lastCall(transport).packet.source.callID, { type: "long", value: 134358883852740000n }));
  }
  await syncing;
  assert.equal(transport.sent.length - before, 3);
  assert.equal(lastCall(transport).method, "GetTime");
});

// ── calls the server makes to the client ─────────────────────────────────────
//
// eve.js builds one in clientSession.sendClientCallRequest, and reads the answer in consumeClientCallResponse: the
// node's call ID off the answer's destination, and the return value out of a one-item body holding a pickle. The
// frames here are built the way that function builds them.

const SERVER_CALL_ID = 610001;
const serverCall = (service, method, args = [], kwargs = { type: "dict", entries: [["machoVersion", 1]] }, head = 0) => marshalEncode(buildPacket(TYPE.CALL_REQ, {
  source: nodeAddress(65450, null, SERVER_CALL_ID),
  destination: clientAddress(2065450, null, service),
  userID: 9001,
  body: [[head, { type: "substream", value: [head ? "C=0:1" : 1, method, args, kwargs] }]],
  oob: { type: "dict", entries: [["machoTimeout", 86400]] },
}));
const lastPacket = (transport) => parsePacket(marshalDecodeExact(inflated(transport.sent.at(-1))));

test("a call the server makes to the client is answered where it came from, with what the client's service returns", { timeout: 5000 }, async (context) => {
  const asked = [];
  const seen = [];
  const { session, transport } = await loggedIn(context, {
    session: { clientCalls: (call) => { asked.push(call); return true; } },
  });
  session.onClientCall((call) => seen.push(call));
  const before = transport.sent.length;
  transport.deliver(serverCall("agents", "YesNo", [["UI/Agents/StandardMission/QuitMissionTitle", { type: "dict", entries: [] }], "Sure?", 3008416, 4802, "AgtQuitMission"]));
  await settle();
  await settle();

  // What the service was asked: its name off the address, the method and its arguments out of the pickle.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].service, "agents");
  assert.equal(asked[0].method, "YesNo");
  assert.equal(asked[0].args.length, 5);
  assert.equal(asked[0].args[2], 3008416);
  assert.equal(text(asked[0].args[4]), "AgtQuitMission");
  assert.equal(dictGet(asked[0].kwargs, "machoVersion"), 1);
  // How long the server says it will wait, off the packet.
  assert.equal(asked[0].timeoutSeconds, 86400);

  // One packet back: a call response, the two addresses swapped, so the server's call ID is the destination's.
  assert.equal(transport.sent.length, before + 1);
  const reply = lastPacket(transport);
  assert.equal(reply.command, TYPE.CALL_RSP);
  assert.deepEqual(reply.destination, { kind: "node", nodeID: 65450, service: null, callID: SERVER_CALL_ID });
  assert.deepEqual(reply.source, { kind: "client", clientID: 2065450, callID: null, service: "agents" });
  // The user the call named, which need not be the one this session logged in as.
  assert.equal(reply.userID, 9001);
  // The body is one item, the return value pickled: what consumeClientCallResponse unwraps.
  assert.equal(reply.body.length, 1);
  assert.equal(reply.body[0].type, "substream");
  assert.equal(reply.body[0].value, true);

  assert.deepEqual(seen.map((call) => [call.service, call.method, call.answered, call.answer, call.error]), [["agents", "YesNo", true, true, null]]);
  assert.equal(session.counters.unknownPackets, 0);
});

test("a service that answers later is answered for when it does, and None is an answer", { timeout: 5000 }, async (context) => {
  let release;
  const { transport } = await loggedIn(context, {
    session: { clientCalls: () => new Promise((resolve) => { release = () => resolve(null); }) },
  });
  const before = transport.sent.length;
  transport.deliver(serverCall("objectCaching", "InvalidateCachedMethodCall", ["charFittingMgr", "GetFittings", 140000002]));
  await settle();
  assert.equal(transport.sent.length, before, "nothing is sent until the service has answered");
  release();
  await settle();
  await settle();
  assert.equal(transport.sent.length, before + 1);
  const reply = lastPacket(transport);
  assert.equal(reply.command, TYPE.CALL_RSP);
  assert.equal(reply.destination.callID, SERVER_CALL_ID);
  assert.equal(reply.body[0].value, null);
});

test("a call nobody here answers is left unanswered and said so", { timeout: 5000 }, async (context) => {
  const seen = [];
  const cases = [
    // No services at all.
    [{}, serverCall("agents", "YesNo", [])],
    // A service that has no answer to this method.
    [{ clientCalls: () => undefined }, serverCall("agents", "SingleChoiceBox", [])],
    // A service that fails.
    [{ clientCalls: () => { throw new Error("no window to show it in"); } }, serverCall("agents", "YesNo", [])],
    // A call on an object the client is meant to hold, and this one holds none.
    [{ clientCalls: () => true }, serverCall("agents", "Anything", [], undefined, 1)],
  ];
  for (const [options, frame] of cases) {
    const { session, transport } = await loggedIn(context, { session: options });
    session.onClientCall((call) => seen.push(call));
    const before = transport.sent.length;
    transport.deliver(frame);
    await settle();
    await settle();
    assert.equal(transport.sent.length, before, "nothing goes back");
    assert.equal(session.counters.unknownPackets, 0);
  }
  assert.deepEqual(seen.map((call) => [call.method, call.answered, call.error && call.error.message]), [
    ["YesNo", false, null],
    ["SingleChoiceBox", false, null],
    ["YesNo", false, "no window to show it in"],
    [null, false, null],
  ]);
});

test("an answer marked provisional is not the answer: the call waits on, for as long as the server says", { timeout: 5000 }, async (context) => {
  const time = manualTime();
  const { session, transport } = await loggedIn(context, { session: { now: time.now, timers: time.timers, callTimeoutMs: 60_000 } });
  const events = [];
  session.onNotification((notification) => events.push(notification));
  let settled = null;
  const answer = session.callBound("N=65450:7", "DoAction", [383]).then((value) => { settled = ["answered", value]; }, (error) => { settled = ["failed", error.code]; });
  const callID = lastCall(transport).packet.source.callID;
  const provisional = marshalEncode(buildPacket(TYPE.CALL_RSP, {
    source: nodeAddress(65450, "agentMgr"),
    destination: clientAddress(2065450, callID),
    userID: 2,
    body: [[]],
    oob: { type: "dict", entries: [["provisional", [86400, "OnAgentProvisionalResponse", []]]] },
  }));

  await time.advance(50_000);
  transport.deliver(provisional);
  await settle();
  assert.equal(settled, null, "the call is still waiting");
  assert.equal(session.pending.has(Number(callID)), true);
  // The event the server named is raised in the client, as machoNet scatters it.
  assert.deepEqual(events.map((event) => [event.method, event.args, event.provisional]), [["OnAgentProvisionalResponse", [], true]]);

  // Past the first minute, where the call would have given up, and on for hours.
  await time.advance(6 * 3600 * 1000);
  assert.equal(settled, null);
  transport.deliver(callResponse(callID, ["the conversation", 1]));
  await answer;
  assert.equal(settled[0], "answered");
  assert.equal(text(settled[1][0]), "the conversation");
  assert.equal(session.pending.has(Number(callID)), false);
});

test("a provisional answer's wait runs from when it came, ends in a timeout, and can be capped", { timeout: 5000 }, async (context) => {
  const provisionalFor = (callID, seconds) => marshalEncode(buildPacket(TYPE.CALL_RSP, {
    source: nodeAddress(65450, "agentMgr"),
    destination: clientAddress(2065450, callID),
    userID: 2,
    body: [[]],
    oob: { type: "dict", entries: [["provisional", [seconds, "OnAgentProvisionalResponse", []]]] },
  }));
  for (const [limit, seconds, stillWaitingAt, goneAt] of [
    // As the client: the server's 300 seconds, counted from the provisional answer and not from the call.
    [undefined, 300, 299_000, 300_000],
    // Capped: whoever is waiting on us has two minutes.
    [120_000, 86400, 119_000, 120_000],
    // A provisional answer with no time in it leaves the call the minute it began with, from now.
    [undefined, null, 59_000, 60_000],
  ]) {
    const time = manualTime();
    const { session, transport } = await loggedIn(context, {
      session: { now: time.now, timers: time.timers, callTimeoutMs: 60_000, ...(limit === undefined ? {} : { provisionalWaitLimitMs: limit }) },
    });
    let failure = null;
    session.call("agentMgr", "Anything").catch((error) => { failure = error.code; });
    const callID = lastCall(transport).packet.source.callID;
    await time.advance(30_000);
    transport.deliver(provisionalFor(callID, seconds));
    await time.advance(stillWaitingAt);
    assert.equal(failure, null, `still waiting ${stillWaitingAt} ms after a provisional answer of ${seconds} s`);
    await time.advance(goneAt - stillWaitingAt);
    await settle();
    assert.equal(failure, "CALL_TIMEOUT");
    assert.equal(session.pending.has(Number(callID)), false);
  }
});

// ── a Moniker's bind ─────────────────────────────────────────────────────────
//
// moniker.py: a Moniker that is not bound finds the node its address lives on (machoNet's address cache, or
// MachoResolveObject, whose answer goes into that cache) and binds there, carrying the call that made it bind:
// MachoBindObject(bindParams, (method, args, keywords)). Recorded on Tranquility at login, eleven binds, ten of
// them carrying a call; and in this server's own log of a retail client, one MachoResolveObject of crimewatch
// and four binds after it.

/** What a bind is answered with: the bound object, and the answer to the call it carried. */
const boundAs = (objectID, result = null) => [{ type: "substruct", value: { type: "substream", value: [Buffer.from(objectID), 134359051855730000n] } }, result];
/** Answer the last call the session sent. */
async function answerLast(transport, result) {
  await settle();
  transport.deliver(callResponse(lastCall(transport).packet.source.callID, result));
  await settle();
}
const sentTo = (transport) => { const call = lastCall(transport); return [call.method, call.packet.destination.kind, call.packet.destination.service]; };

test("the node an address lives on is asked for once: another bind of that address goes straight to the node", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const first = session.bind("crimewatch", [60000004, 15]);
  await settle();
  assert.deepEqual(sentTo(transport), ["MachoResolveObject", "any", "crimewatch"]);
  await answerLast(transport, 65450);
  assert.deepEqual(sentTo(transport), ["MachoBindObject", "node", "crimewatch"]);
  await answerLast(transport, boundAs("N=65450:71"));
  assert.deepEqual([(await first).objectID, (await first).nodeID], ["N=65450:71", 65450]);

  // The same address again, its station written as a long this time: one packet, the bind, to the node that was named.
  const before = transport.sent.length;
  const second = session.bind("crimewatch", [60000004n, 15]);
  await settle();
  assert.equal(transport.sent.length, before + 1);
  assert.deepEqual([...sentTo(transport), lastCall(transport).packet.destination.nodeID], ["MachoBindObject", "node", "crimewatch", 65450]);
  await answerLast(transport, boundAs("N=65450:72"));
  assert.equal((await second).objectID, "N=65450:72");

  // Another service at the same place, the same service somewhere else or by another group of the same number, and
  // addresses that are one number each: every one is asked for.
  for (const [service, params] of [["ship", [60000004, 15]], ["crimewatch", [30002780, 5]], ["crimewatch", [60000004, 5]], ["skillHandler", 140000002], ["skillHandler", 140000003]]) {
    const bind = session.bind(service, params);
    await settle();
    assert.deepEqual(sentTo(transport), ["MachoResolveObject", "any", service], service);
    await answerLast(transport, 65450);
    await answerLast(transport, boundAs("N=65450:80"));
    await bind;
  }
  // An address no node would own up to is not remembered as living anywhere: it is asked for again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lost = assert.rejects(session.bind("ship", [60000099, 15]), (error) => error.code === "RESOLVE_FAILED");
    await settle();
    assert.equal(lastCall(transport).method, "MachoResolveObject");
    await answerLast(transport, null);
    await lost;
  }
});

test("two binds of one address at once ask where it lives once, and each then binds", { timeout: 5000 }, async (context) => {
  // The client's machoNet shares one answer among the same call made twice at once ("Sharing result for call ...
  // for 2 waiting threads", in a recording of its login): invCache's two managers are one address.
  const { session, transport } = await loggedIn(context);
  const before = transport.sent.length;
  const [station, location] = [session.bind("invbroker", [60000004, 15], ["GetInventory", [10004, null], null]), session.bind("invbroker", [60000004, 15], ["GetInventoryFromId", [9001, 0], null])];
  await settle();
  assert.equal(transport.sent.length, before + 1);
  assert.equal(lastCall(transport).method, "MachoResolveObject");
  await answerLast(transport, 65450);
  // Both binds are on the wire now, each with its own call; they are answered in the order they were sent.
  const sent = transport.sent.slice(before + 1).map((bytes) => { const [, pickle] = parsePacket(marshalDecodeExact(inflated(bytes))).body[0]; return [text(pickle.value[1]), text(pickle.value[2][1][0])]; });
  assert.deepEqual(sent, [["MachoBindObject", "GetInventory"], ["MachoBindObject", "GetInventoryFromId"]]);
  const ids = transport.sent.slice(before + 1).map((bytes) => parsePacket(marshalDecodeExact(inflated(bytes))).source.callID);
  transport.deliver(callResponse(ids[0], boundAs("N=65450:14")));
  transport.deliver(callResponse(ids[1], boundAs("N=65450:15")));
  assert.deepEqual([(await station).objectID, (await location).objectID], ["N=65450:14", "N=65450:15"]);
  // A resolve that fails fails both, and the next bind asks again.
  const [one, two] = [session.bind("ship", [60000099, 15]), session.bind("ship", [60000099, 15])].map((bind) => assert.rejects(bind, (error) => error.code === "RESOLVE_FAILED"));
  await answerLast(transport, null);
  await Promise.all([one, two]);
  const asked = transport.sent.length;
  const again = assert.rejects(session.bind("ship", [60000099, 15]), (error) => error.code === "RESOLVE_FAILED");
  await settle();
  assert.deepEqual([transport.sent.length, lastCall(transport).method], [asked + 1, "MachoResolveObject"]);
  await answerLast(transport, null);
  await again;
});

test("a moniker that names its node is bound there without asking where it lives", { timeout: 5000 }, async (context) => {
  // moniker.py __setstate__: a Moniker that arrives with a node puts it in machoNet's address cache. Recorded on
  // Tranquility: the skill handler's moniker named its node, and its bind was not preceded by a MachoResolveObject.
  const { session, transport } = await loggedIn(context);
  session.setNodeOfAddress("skillMgr2", 2124510715n, 65451);
  const before = transport.sent.length;
  const bind = session.bind("skillMgr2", 2124510715, ["GetBoosters", [], null]);
  await settle();
  assert.equal(transport.sent.length, before + 1);
  assert.deepEqual([...sentTo(transport), lastCall(transport).packet.destination.nodeID], ["MachoBindObject", "node", "skillMgr2", 65451]);
  await answerLast(transport, boundAs("N=65451:9"));
  assert.equal((await bind).nodeID, 65451);
  // An address that is a tuple is known the same way.
  session.setNodeOfAddress("ship", [60000004, 15], 65452);
  const docked = session.bind("ship", [60000004n, 15], null);
  await settle();
  assert.deepEqual([...sentTo(transport), lastCall(transport).packet.destination.nodeID], ["MachoBindObject", "node", "ship", 65452]);
  await answerLast(transport, boundAs("N=65452:3"));
  await docked;
  // Only that address: the same service for another character is asked about.
  const other = session.bind("skillMgr2", 2124510716, null);
  await settle();
  assert.equal(lastCall(transport).method, "MachoResolveObject");
  await answerLast(transport, 65450);
  await answerLast(transport, boundAs("N=65450:10"));
  await other;
});

test("a call given to a bind rides along with it: (method, arguments, keywords) after the bind's own parameters", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const carried = async (service, params, call, answer) => {
    const bind = session.bind(service, params, call);
    await answerLast(transport, 65450);
    const sent = lastCall(transport);
    await answerLast(transport, answer);
    return { sent, bound: await bind };
  };
  // As recorded: MachoBindObject(charID, ('GetBoosters', (), {})), and machoVersion on the bind's own keywords alone.
  const boosters = await carried("skillHandler", 140000002, ["GetBoosters", [], null], boundAs("N=65450:5", "the call's own answer"));
  assert.equal(boosters.sent.method, "MachoBindObject");
  assert.deepEqual(boosters.sent.kwargs.entries.map(([key, value]) => [text(key), value]), [["machoVersion", 1]]);
  const [params, call] = boosters.sent.args;
  assert.deepEqual([params, call.length, text(call[0]), call[1], call[2]], [140000002, 3, "GetBoosters", [], { type: "dict", entries: [] }]);
  assert.deepEqual([boosters.bound.objectID, text(boosters.bound.result)], ["N=65450:5", "the call's own answer"]);

  // Its arguments are a tuple of their own, and its keywords go in the order the client's Python gives them, without the
  // two the client keeps to itself.
  const written = ["passive", "machoTimeout", "flag", "qty", "locationID", "ownerID", "itemID", "typeID", "force", "name"];
  const keywords = Object.fromEntries(written.map((name, index) => [name, index]));
  const many = await carried("invbroker", [60000004, 15], ["GetInventoryFromId", [9988400091900n, 1], keywords], boundAs("N=65450:6"));
  const [, withKeywords] = many.sent.args;
  assert.deepEqual([text(withKeywords[0]), withKeywords[1]], ["GetInventoryFromId", [9988400091900, 1]]);
  assert.deepEqual(withKeywords[2].entries.map(([key]) => text(key)), monikerKeywordOrder(written));
  assert.deepEqual(new Map(withKeywords[2].entries.map(([key, value]) => [text(key), value])).get("locationID"), 4);
  assert.equal(withKeywords[2].entries.length, written.length - 1);
  // Keywords given as a dict's entries are the same thing.
  const asEntries = await carried("ship", [60000004, 15], ["Undock", [9001, false], { type: "dict", entries: [["onlineModules", { type: "dict", entries: [[19, 9002]] }]] }], boundAs("N=65450:7"));
  assert.deepEqual(asEntries.sent.args[1][2], { type: "dict", entries: [[Buffer.from("onlineModules"), { type: "dict", entries: [[19, 9002]] }]] });

  // With no call the bind carries None, as a Moniker bound for its own sake does.
  const bare = await carried("corpRegistry", 98000000, null, boundAs("N=65450:8"));
  assert.deepEqual(bare.sent.args, [98000000, null]);
});

// ── one call at a time of any one thing ──────────────────────────────────────
//
// machobase.ThrottledCall, which every call of the client's goes through (ServiceCallGPCS 697, ObjectCallGPCS 616):
// the same call made again while it is out (the same service or object, method, str(args) and str(kwargs)) is not
// sent. It waits for the one that is out and takes its answer. A recording of a pilot joining a fleet has it:
// "Sharing result for call ('N=...', 'GetInitState', '()', '{}') ... for 1 waiting threads".
// These cases keep the owning caller alive. Native TaskletExit unwinds
// ThrottledCall's TempLock without a result (machobase.py94-111); an explicitly
// scoped owner or scalar aggression read also retires its pending call and
// throttler entry (base_corporation.GetAggressionSettings256-261;
// machoNet._BlockingCall3592-3660 removes its pending channels in finally).

/** Every call the session has sent since `from`, as [target, method, callID]. */
const callsSince = (transport, from) => transport.sent.slice(from).map((bytes) => {
  const packet = parsePacket(marshalDecodeExact(inflated(bytes)));
  const [, pickle] = packet.body[0];
  return [packet.destination.service ?? text(pickle.value[0]), text(pickle.value[1]), packet.source.callID];
});

test("the same call made again while it is out is not sent again: it waits, and takes the answer", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const before = transport.sent.length;
  const three = [1, 2, 3].map(() => session.call("account", "GetCashBalance", [false]));
  // The first is on the wire at once, as every call is; the other two are not sent.
  assert.equal(transport.sent.length, before + 1);
  await settle();
  assert.deepEqual(callsSince(transport, before).map(([service, method]) => [service, method]), [["account", "GetCashBalance"]]);
  await answerLast(transport, 1500.5);
  assert.deepEqual(await Promise.all(three), [1500.5, 1500.5, 1500.5]);
  assert.deepEqual([transport.sent.length, session.pending.size], [before + 1, 0]);
  // Once it is answered it is not out: the same call made now is made.
  const again = session.call("account", "GetCashBalance", [false]);
  assert.equal(transport.sent.length, before + 2);
  await answerLast(transport, 7);
  assert.equal(await again, 7);
  // The call numbers went up by the calls sent, not by the calls made.
  const [[, , firstID], [, , secondID]] = callsSince(transport, before);
  assert.equal(secondID, firstID + 1);
  // Another call's answer leaves this one out still.
  const slow = session.call("config", "Slow", []);
  const slowID = lastCall(transport).packet.source.callID;
  const quick = session.call("config", "Quick", []);
  await answerLast(transport, "quick");
  assert.equal(text(await quick), "quick");
  const sent = transport.sent.length;
  const slowAgain = session.call("config", "Slow", []);
  await settle();
  assert.equal(transport.sent.length, sent);
  transport.deliver(callResponse(slowID, "slow"));
  assert.deepEqual([text(await slow), text(await slowAgain)], ["slow", "slow"]);
});

test("a call that differs in anything is another call, and is sent while the first is out", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const out = () => transport.sent.length;
  const start = out();
  const made = [];
  const make = (call) => { made.push(call().catch(() => {})); return out(); };
  assert.equal(make(() => session.call("account", "GetCashBalance", [false])), start + 1);
  // Another service, another method, another argument, one more argument, a keyword, another value for it.
  for (const [index, other] of [
    () => session.call("account2", "GetCashBalance", [false]),
    () => session.call("account", "GetCashBalance2", [false]),
    () => session.call("account", "GetCashBalance", [true]),
    () => session.call("account", "GetCashBalance", [false, null]),
    () => session.call("account", "GetCashBalance", [false], { accountKey: 1000 }),
    () => session.call("account", "GetCashBalance", [false], { accountKey: 1001 }),
    () => session.call("account", "GetCashBalance", [false], { walletKey: 1000 }),
    // As str() would have it: an int is not a long, a str is not a unicode, 0 is not False or None.
    () => session.call("account", "GetCashBalance", [0]),
    () => session.call("account", "GetCashBalance", [0n]),
    () => session.call("account", "GetCashBalance", [null]),
    () => session.call("account", "GetCashBalance", ["0"]),
    () => session.call("account", "GetCashBalance", [Buffer.from("0")]),
    () => session.call("account", "GetCashBalance", [[false]]),
    () => session.call("account", "GetCashBalance", [{ type: "list", items: [false] }]),
    // A bound object's is its own, and each object's is its own.
    () => session.callBound("N=65450:9", "GetCashBalance", [false]),
    () => session.callBound("N=65450:10", "GetCashBalance", [false]),
  ].entries()) assert.equal(make(other), start + 2 + index, `call ${index} is sent`);
  const sent = out();
  // Each of those again, the same: none is sent. Keywords are the same whatever order they were written in,
  // and however they were handed over.
  for (const same of [
    () => session.call("account", "GetCashBalance", [false]),
    () => session.call("account", "GetCashBalance", [false], null),
    () => session.call("account", "GetCashBalance", [false], {}),
    () => session.call("account", "GetCashBalance", [0n]),
    () => session.call("account", "GetCashBalance", [Buffer.from("0")]),
    () => session.call("account", "GetCashBalance", [false], { type: "dict", entries: [["accountKey", 1000]] }),
    () => session.callBound("N=65450:9", "GetCashBalance", [false]),
    // sm.ProxySvc's is the same service's call by another road: the key is the service's name.
    () => session.proxyCall("account", "GetCashBalance", [false]),
  ]) assert.equal(make(same), sent);
  const both = { first: 1, second: 2 };
  assert.equal(make(() => session.call("config", "Both", [], both)), sent + 1);
  assert.equal(make(() => session.call("config", "Both", [], { second: 2, first: 1 })), sent + 1);
  session.close();
  await Promise.all(made);
});

test("a call that failed is no answer to share: the first of those waiting asks for itself, and the rest wait for that", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const before = transport.sent.length;
  const [one, two, three] = [1, 2, 3].map(() => session.call("config", "Fragile", [7]));
  const firstID = lastCall(transport).packet.source.callID;
  const refused = assert.rejects(one, (error) => error.code === "GAME_CALL_REFUSED");
  transport.deliver(marshalEncode(buildPacket(TYPE.ERROR_RESPONSE, {
    source: nodeAddress(65450, "config"),
    destination: clientAddress(2065450, firstID),
    userID: 2,
    body: [TYPE.CALL_REQ, 2, [{ type: "substream", value: "TaxChanged" }]],
  })));
  await refused;
  await settle();
  // One more call is out, the second caller's own; the third waits for it.
  assert.deepEqual(callsSince(transport, before).map(([service, method]) => `${service}.${method}`), ["config.Fragile", "config.Fragile"]);
  await answerLast(transport, "fine");
  assert.deepEqual([text(await two), text(await three), transport.sent.length], ["fine", "fine", before + 2]);
});

test("two binds of one address at once, carrying the same call, are one bind, and both hold its object", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const before = transport.sent.length;
  const binds = [1, 2].map(() => session.bind("fleetObjectHandler", 654500010000n, ["GetInitState", [], null]));
  await settle();
  await answerLast(transport, 65450);
  await answerLast(transport, boundAs("N=65450:31", "the state"));
  const [first, second] = await Promise.all(binds);
  assert.deepEqual([first.objectID, second.objectID, text(first.result), text(second.result)], ["N=65450:31", "N=65450:31", "the state", "the state"]);
  assert.deepEqual(callsSince(transport, before).map(([, method]) => method), ["MachoResolveObject", "MachoBindObject"]);
});

// ── cached method calls: objectCaching ───────────────────────────────────────
//
// A service's method the server answers with a CachedMethodCallResult is kept by the client's object cache, by
// the service, the method and the arguments, for as long as the answer's own details say (objectCaching.py). A
// Tranquility recording has "returning a cached result" in the client's log wherever the cache answered.

const FILETIME_EPOCH = 116444736000000000n;
const CACHED_RESULT = Buffer.from("carbon.common.script.net.objectCaching.CachedMethodCallResult");
/** For details that say nothing of a version check at all. */
const NO_WORD = Symbol("no word of a version check");
/** A CachedMethodCallResult as the server sends one: what it says of the method's answers, the answer inline, and its version. */
const cachedResult = (value, { versionCheck = "run", sessionInfo = null, stamp = 0n } = {}) => ({
  type: "object",
  name: CACHED_RESULT,
  args: [
    { type: "dict", entries: [...(versionCheck === NO_WORD ? [] : [[Buffer.from("versionCheck"), typeof versionCheck === "string" ? Buffer.from(versionCheck) : versionCheck]]), ...(sessionInfo === null ? [] : [[Buffer.from("sessionInfo"), Buffer.from(sessionInfo)]])] },
    marshalEncode(value),
    [stamp, 7],
  ],
});
/** A session whose clock a test moves, and a way to ask it something and answer what it sends. */
async function cachingSession(context) {
  const clock = { ms: 1_000_000 };
  const { session, transport } = await loggedIn(context, { session: { now: () => clock.ms } });
  const stampNow = () => BigInt(Math.trunc(session.serverNow())) * 10000n + FILETIME_EPOCH;
  /** Ask, and if a call went out answer it with `answer`. Says what came back, and whether the server was asked. */
  const ask = async (how, service, method, args, answer) => {
    const before = transport.sent.length;
    const asking = how === "bound" ? session.callBound("N=65450:9", method, args) : session[how](service, method, args);
    await settle();
    const sent = transport.sent.length - before;
    // An answer may be a whole packet's bytes, made from the call's own number: an ErrorResponse, say.
    if (sent > 0) transport.deliver(typeof answer === "function" ? answer(lastCall(transport).packet.source.callID) : callResponse(lastCall(transport).packet.source.callID, answer));
    return [await asking, sent];
  };
  return { session, transport, clock, stampNow, ask };
}

test("a service's method the server marks as cached is asked for once in a run, by its arguments, and whatever asks again is answered from that", { timeout: 5000 }, async (context) => {
  const { session, ask } = await cachingSession(context);
  assert.equal(session.cachedMethodCall("beyonce", "GetFormations", []), null, "nothing is kept before it is asked");
  assert.deepEqual(await ask("call", "beyonce", "GetFormations", [], cachedResult([1, 2])), [[1, 2], 1]);
  assert.deepEqual(await ask("call", "beyonce", "GetFormations", [], cachedResult([3, 4])), [[1, 2], 0]);
  assert.deepEqual(session.cachedMethodCall("beyonce", "GetFormations", []), { result: [1, 2] });
  // Other arguments, another method and another service are each their own.
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(5)), [5, 1]);
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [60000004], cachedResult(6)), [6, 1]);
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(7)), [5, 0]);
  assert.deepEqual(await ask("call", "stationSvc", "GetStations", [60003760], cachedResult(8)), [8, 1]);
  assert.deepEqual(await ask("call", "map", "GetStation", [60003760], cachedResult(9)), [9, 1]);
  // A whole number is the same argument however it is spelt.
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [60003760n], cachedResult(10)), [5, 0]);
  // Asked of the proxy's node, it is the same service's method.
  assert.deepEqual(await ask("proxyCall", "beyonce", "GetFormations", [], cachedResult([3, 4])), [[1, 2], 0]);
  // An answer that is no CachedMethodCallResult is not kept. ObjectCallGPCS 390-451 caches a bound object's marked answer too.
  assert.deepEqual([await ask("call", "account", "GetCashBalance", [], 11), await ask("call", "account", "GetCashBalance", [], 12)], [[11, 1], [12, 1]]);
  assert.deepEqual([await ask("bound", null, "List", [], cachedResult(13)), await ask("bound", null, "List", [], cachedResult(14))], [[13, 1], [13, 0]]);
});

test("a moniker keeps its cached answer across rebinds, separately for each corporation, and forgets a named invalidation", { timeout: 5000 }, async (context) => {
  // moniker.py 143: persistantObjectID=(serviceName, bindParams); ObjectCallGPCS 390-451 uses it for caching.
  const { session, transport } = await cachingSession(context);
  async function bind(corporationID, objectID) {
    const binding = session.bind("corpRegistry", corporationID);
    await settle();
    if (lastCall(transport).method === "MachoResolveObject") await answerLast(transport, 65450);
    await answerLast(transport, boundAs(objectID));
    await binding;
  }
  async function tracking(objectID, answer) {
    const before = transport.sent.length;
    const asking = session.callBound(objectID, "GetMemberTrackingInfo", []);
    await settle();
    const sent = transport.sent.length - before;
    if (sent) await answerLast(transport, cachedResult(answer));
    return [await asking, sent];
  }
  await bind(98000001, "N=65450:31");
  assert.deepEqual(await tracking("N=65450:31", 1), [1, 1]);
  await bind(98000001, "N=65450:32");
  assert.deepEqual(await tracking("N=65450:32", 2), [1, 0]);
  await bind(98000002, "N=65450:33");
  assert.deepEqual(await tracking("N=65450:33", 3), [3, 1]);
  session.invalidateCachedMethodCalls([[["corpRegistry", 98000001], "GetMemberTrackingInfo", []]]);
  assert.deepEqual(await tracking("N=65450:32", 4), [4, 1]);
});

test("how long a cached answer is good for is what the server said of the method the first time: never, always, the run, or a time", { timeout: 5000 }, async (context) => {
  const { clock, stampNow, ask } = await cachingSession(context);
  const twice = async (method, details, answers = [1, 2]) => [await ask("call", "svc", method, [], cachedResult(answers[0], details())), await ask("call", "svc", method, [], cachedResult(answers[1], details()))];
  assert.deepEqual(await twice("Never", () => ({ versionCheck: "never" })), [[1, 1], [1, 0]]);
  assert.deepEqual(await twice("Run", () => ({ versionCheck: "run" })), [[1, 1], [1, 0]]);
  assert.deepEqual(await twice("NoWord", () => ({ versionCheck: NO_WORD })), [[1, 1], [1, 0]], "no word of it is 'run'");
  assert.deepEqual(await twice("Always", () => ({ versionCheck: "always" })), [[1, 1], [2, 1]]);
  assert.deepEqual(await twice("NotAtAll", () => ({ versionCheck: null })), [[1, 1], [2, 1]], "a version check of None is not kept");
  assert.deepEqual(await twice("Unheard", () => ({ versionCheck: "a fortnight" })), [[1, 1], [2, 1]], "a time the client has no word for is not used");
  // The client's word of three: its own, the proxy's and the server's.
  assert.deepEqual(await twice("Three", () => ({ versionCheck: [Buffer.from("run"), null, null] })), [[1, 1], [1, 0]]);

  // A time: good for that long from the answer's own stamp.
  const timed = () => ({ versionCheck: "5 minutes", stamp: stampNow() });
  assert.deepEqual(await ask("call", "svc", "Timed", [], cachedResult(1, timed())), [1, 1]);
  clock.ms += 4 * 60 * 1000 + 59 * 1000;
  assert.deepEqual(await ask("call", "svc", "Timed", [], cachedResult(2, timed())), [1, 0]);
  clock.ms += 1000;
  assert.deepEqual(await ask("call", "svc", "Timed", [], cachedResult(3, timed())), [3, 1], "five minutes old: asked again, and the new answer kept");
  clock.ms += 60 * 1000;
  assert.deepEqual(await ask("call", "svc", "Timed", [], cachedResult(4, timed())), [3, 0]);
  // A number of 100 ns is a time too.
  assert.deepEqual(await ask("call", "svc", "Counted", [], cachedResult(1, { versionCheck: 20_000_000, stamp: stampNow() })), [1, 1]);
  clock.ms += 1999;
  assert.deepEqual(await ask("call", "svc", "Counted", [], cachedResult(2, { versionCheck: 20_000_000, stamp: stampNow() })), [1, 0]);
  clock.ms += 1;
  assert.deepEqual(await ask("call", "svc", "Counted", [], cachedResult(2, { versionCheck: 20_000_000, stamp: stampNow() })), [2, 1]);
  // What the server said the first time holds: a later answer that says otherwise does not change it.
  assert.deepEqual(await ask("call", "svc", "Always", [], cachedResult(5, { versionCheck: "never" })), [5, 1]);
  assert.deepEqual(await ask("call", "svc", "Always", [], cachedResult(6, { versionCheck: "never" })), [6, 1]);
});

test("an answer good until midnight is good until the first UTC midnight after the run began, or for three hours if that is sooner", { timeout: 5000 }, async (context) => {
  const { session, clock, stampNow, ask } = await cachingSession(context);
  const DAY_MS = 86_400_000;
  // The run begins nine hours before a midnight, by the session's own reckoning of the server's clock.
  clock.ms += (DAY_MS - (Math.trunc(session.serverNow()) % DAY_MS)) - 9 * 3_600_000;
  const midnight = () => ({ versionCheck: "utcmidnight", stamp: stampNow() });
  const sooner = () => ({ versionCheck: "utcmidnight_or_3hours", stamp: stampNow() });
  assert.deepEqual([await ask("call", "svc", "Midnight", [], cachedResult(1, midnight())), await ask("call", "svc", "Sooner", [], cachedResult(1, sooner()))], [[1, 1], [1, 1]]);
  // Two hours on: both good. (Good for nine hours less its age, and for three hours.)
  clock.ms += 2 * 3_600_000;
  assert.deepEqual([await ask("call", "svc", "Midnight", [], cachedResult(2, midnight())), await ask("call", "svc", "Sooner", [], cachedResult(2, sooner()))], [[1, 0], [1, 0]]);
  // Three hours old: the one that ends sooner is asked again; the other is good for as long as is left to midnight, which is six hours.
  clock.ms += 3_600_000;
  assert.deepEqual([await ask("call", "svc", "Midnight", [], cachedResult(3, midnight())), await ask("call", "svc", "Sooner", [], cachedResult(3, sooner()))], [[1, 0], [3, 1]]);
  // Four and a half hours old with four and a half to go: as old as there is left, and asked again.
  clock.ms += 1.5 * 3_600_000;
  assert.deepEqual(await ask("call", "svc", "Midnight", [], cachedResult(4, midnight())), [4, 1]);
  // With less than three hours to midnight, the one that ends sooner ends at midnight too: got with two hours to go, it is good for one.
  clock.ms += 2.5 * 3_600_000;
  assert.deepEqual(await ask("call", "svc", "Late", [], cachedResult(1, sooner())), [1, 1]);
  clock.ms += 59 * 60_000;
  assert.deepEqual(await ask("call", "svc", "Late", [], cachedResult(2, sooner())), [1, 0]);
  clock.ms += 60_000;
  assert.deepEqual(await ask("call", "svc", "Late", [], cachedResult(3, sooner())), [3, 1]);
});

test("an answer the server says to keep by something of the session's is kept by its value, and is another's when that changes", { timeout: 5000 }, async (context) => {
  const { session, ask } = await cachingSession(context);
  session.attributes.corpid = 98000000;
  const byCorporation = (value) => cachedResult(value, { sessionInfo: "corpid" });
  assert.deepEqual(await ask("call", "corpmgr", "GetAssetInventory", [4], byCorporation(1)), [1, 1]);
  assert.deepEqual(await ask("call", "corpmgr", "GetAssetInventory", [4], byCorporation(2)), [1, 0]);
  session.attributes.corpid = 98000001;
  assert.deepEqual(await ask("call", "corpmgr", "GetAssetInventory", [4], byCorporation(3)), [3, 1]);
  session.attributes.corpid = 98000000;
  assert.deepEqual(await ask("call", "corpmgr", "GetAssetInventory", [4], byCorporation(4)), [1, 0], "back in the first, its answer is still held");
});

test("the server's word that a cached answer has changed forgets that one; what it said of the method's answers stands", { timeout: 5000 }, async (context) => {
  const { session, transport, ask } = await cachingSession(context);
  const prime = async () => [await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(1)), await ask("call", "stationSvc", "GetStation", [60000004], cachedResult(2)), await ask("call", "beyonce", "GetFormations", [], cachedResult(3))];
  await prime();
  // objectCaching.InvalidateCachedMethodCall(service, method, *args), called on the client by the server.
  transport.deliver(serverCall("objectCaching", "InvalidateCachedMethodCall", [Buffer.from("stationSvc"), Buffer.from("GetStation"), 60003760]));
  await settle();
  assert.deepEqual([await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(4)), await ask("call", "stationSvc", "GetStation", [60000004], cachedResult(5)), await ask("call", "beyonce", "GetFormations", [], cachedResult(6))], [[4, 1], [2, 0], [3, 0]]);
  // InvalidateCachedMethodCalls([(service, method, args), ...]).
  transport.deliver(serverCall("objectCaching", "InvalidateCachedMethodCalls", [{ type: "list", items: [[Buffer.from("stationSvc"), Buffer.from("GetStation"), [60000004]], [Buffer.from("beyonce"), Buffer.from("GetFormations"), []], [Buffer.from("never"), Buffer.from("Heard"), []]] }]));
  await settle();
  assert.deepEqual([await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(7)), await ask("call", "stationSvc", "GetStation", [60000004], cachedResult(8)), await ask("call", "beyonce", "GetFormations", [], cachedResult(9))], [[4, 0], [8, 1], [9, 1]]);
  // By hand, as the client's own code names one: by the same three. Whole numbers are one however they are spelt, and so is text.
  session.invalidateCachedMethodCalls([["beyonce", "GetFormations", []]]);
  assert.deepEqual(await ask("call", "beyonce", "GetFormations", [], cachedResult(10)), [10, 1]);
  // What the server first said of a method's answers outlives the forgetting: one it said to check always is not kept because a later answer says never.
  await ask("call", "svc", "Checked", [], cachedResult(1, { versionCheck: "always" }));
  session.invalidateCachedMethodCalls([[Buffer.from("svc"), "Checked", []], ["stationSvc", Buffer.from("GetStation"), [60003760n]]]);
  // A long spelt as the BFF's own JSON spells one is the same number too, in a call and in a name.
  assert.deepEqual([await ask("call", "stationSvc", "GetStation", [{ type: "long", value: "60000004" }], cachedResult(20)), await ask("call", "stationSvc", "GetStation", [60000004], cachedResult(21))], [[8, 0], [8, 0]]);
  session.invalidateCachedMethodCalls([["stationSvc", "GetStation", [{ type: "long", value: "60000004" }]]]);
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [60000004n], cachedResult(22)), [22, 1]);
  await ask("call", "stationSvc", "GetStation", [{ type: "long", value: "9007199254740993" }], cachedResult(23));
  assert.deepEqual(await ask("call", "stationSvc", "GetStation", [9007199254740993n], cachedResult(24)), [23, 0], "and one past what a number holds exactly");
  assert.deepEqual([await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(11)), await ask("call", "stationSvc", "GetStation", [60003760], cachedResult(12))], [[11, 1], [11, 0]], "asked again, and kept again as the server first said");
  assert.deepEqual([await ask("call", "svc", "Checked", [], cachedResult(2, { versionCheck: "never" })), await ask("call", "svc", "Checked", [], cachedResult(3, { versionCheck: "never" }))], [[2, 1], [3, 1]]);
});

// A sale's items (the registry's marketProxy.PlaceMultiSellOrder): what the transport hands the session is put on the
// wire by the real marshal here, and read back. As the BFF's route gave them, a plain object each, they could not
// be put on the wire at all.

test("a sale's items, shaped as the client's, go to the wire: a list of util.KeyVal, the fields of each in its own order", { timeout: 5000 }, async (context) => {
  const { session, transport } = await loggedIn(context);
  const routes = [[{ itemID: 9988400109051, typeID: 34, stationID: 60003760, price: 987654.32, quantity: 1 }], false, 1, null];
  // As it came, there is no putting it on the wire.
  await assert.rejects(session.proxyCall("marketProxy", "PlaceMultiSellOrder", routes), /Cannot marshal value/);
  const form = retailForm("marketProxy", "PlaceMultiSellOrder", routes, null, {});
  session.proxyCall("marketProxy", "PlaceMultiSellOrder", form.args).catch(() => {});
  await settle();
  const sent = lastCall(transport);
  assert.equal(sent.method, "PlaceMultiSellOrder");
  const [items, useCorp, duration, fee] = sent.args;
  assert.deepEqual([useCorp, duration, fee], [false, 1, null]);
  assert.equal(items.type, "list");
  const [item] = items.items;
  assert.equal(text(item.name), "util.KeyVal");
  assert.deepEqual(item.args.entries.map(([name, value]) => [text(name), typeof value === "bigint" ? Number(value) : value]),
    [["itemID", 9988400109051], ["typeID", 34], ["price", 987654.32], ["stationID", 60003760], ["officeID", null], ["quantity", 1]]);
});

// The check with the server (ServiceCallGPCS.RemoteServiceCallWithoutTheStars): an answer held that is due a check
// is asked for with the version held, machoVersion=[stamp, checksum], where a call with nothing held says 1. The
// server answers with a new answer, or with the exception objectCaching.CacheOK: the copy held is good, and is
// good from then (UpdateVersionCheckPeriod). Recorded on Tranquility: GetCharStandings sent with
// {'machoVersion': [134275735884561765L, 1]}, and ErrorResponses to shipKillCounter's.

/** The server's "your copy is good", as this server builds it (machoErrors.js buildCacheOkPayload). */
const refusedWith = (className, args) => (callID) => marshalEncode(buildPacket(TYPE.ERROR_RESPONSE, {
  source: nodeAddress(65450, "svc"),
  destination: clientAddress(2065450, callID),
  userID: 2,
  body: [TYPE.CALL_REQ, 2, [{ type: "substream", value: { type: "objectex1", header: [{ type: "token", value: className }, args], list: [], dict: [] } }]],
}));
const cacheOK = refusedWith("carbon.common.script.net.objectCaching.CacheOK", ["CacheOK"]);
/** The machoVersion the last call went out with. */
const versionSent = (transport) => lastCall(transport).kwargs.entries.find(([name]) => text(name) === "machoVersion")[1];

test("an answer due a check is asked for with the version held; told the copy is good, the session uses it and counts it good from then", { timeout: 5000 }, async (context) => {
  const { session, transport, clock, stampNow, ask } = await cachingSession(context);
  const got = stampNow();
  assert.deepEqual(await ask("call", "svc", "Timed", [4], cachedResult(1, { versionCheck: "5 minutes", stamp: got })), [1, 1]);
  assert.equal(versionSent(transport), 1, "with nothing held, the version is 1");
  clock.ms += 5 * 60_000;
  // Due a check: sent with what is held, and the copy is good.
  assert.deepEqual(await ask("call", "svc", "Timed", [4], cacheOK), [1, 1]);
  assert.deepEqual(versionSent(transport), { type: "list", items: [got, 7] });
  const renewed = stampNow();
  // Good from the check, not from when it was first got: nothing asked until five minutes after that.
  clock.ms += 4 * 60_000 + 59_000;
  assert.deepEqual(await ask("call", "svc", "Timed", [4], cachedResult(9)), [1, 0]);
  clock.ms += 1000;
  // The next check carries the stamp of the last, and this time the server has a new answer: that one is held now.
  const newer = stampNow();
  assert.deepEqual(await ask("call", "svc", "Timed", [4], cachedResult(2, { versionCheck: "5 minutes", stamp: newer })), [2, 1]);
  assert.deepEqual(versionSent(transport), { type: "list", items: [renewed, 7] });
  assert.deepEqual([await ask("call", "svc", "Timed", [4], cachedResult(9)), session.cachedMethodCall("svc", "Timed", [4])], [[2, 0], { result: 2 }]);
});

test("an answer the server says to check always is asked for each time with its version, and is the same answer while the server says so", { timeout: 5000 }, async (context) => {
  const { session, transport, ask } = await cachingSession(context);
  assert.deepEqual(await ask("proxyCall", "svc", "Always", [], cachedResult(1, { versionCheck: "always", stamp: 500n })), [1, 1]);
  assert.equal(session.cachedMethodCall("svc", "Always", []), null, "held, and due a check: the cache alone does not answer");
  assert.deepEqual([await ask("proxyCall", "svc", "Always", [], cacheOK), versionSent(transport).items[1]], [[1, 1], 7]);
  assert.deepEqual(await ask("proxyCall", "svc", "Always", [], cacheOK), [1, 1]);
  assert.deepEqual(await ask("proxyCall", "svc", "Always", [], cachedResult(2, { versionCheck: "always", stamp: 900n })), [2, 1]);
  assert.deepEqual(await ask("proxyCall", "svc", "Always", [], cacheOK), [2, 1]);
});

test("a check the server refuses for another reason is refused, and what is held is still held; CacheOK with nothing held is a refusal too", { timeout: 5000 }, async (context) => {
  const { session, ask } = await cachingSession(context);
  assert.deepEqual(await ask("call", "svc", "Always", [], cachedResult(1, { versionCheck: "always" })), [1, 1]);
  await assert.rejects(ask("call", "svc", "Always", [], refusedWith("eveexceptions.UserError", ["NotNow", { type: "dict", entries: [] }])), (error) => error.code === "GAME_CALL_REFUSED" && error.refusal.key === "NotNow");
  assert.deepEqual(await ask("call", "svc", "Always", [], cacheOK), [1, 1], "the copy is still there for the next check");
  // A method with nothing held: the server's CacheOK is no answer to anything.
  await assert.rejects(ask("call", "svc", "Never", [], cacheOK), (error) => error.code === "GAME_CALL_REFUSED");
  assert.equal(session.cachedMethodCall("svc", "Never", []), null);
});

// CachedMethodCallResult.GetVersion: a result that is a reference to a cached object has that object's version,
// and none of its own. This server answers GetAllCorpMedals so, and the recording has its bytes. (The first
// build of the check read the result's own version, which is None there, and sent [0, None] straight away: a
// made-up answer with a version of its own had passed every test.)

test("a cached answer that is a reference is kept by the version of the object it refers to, and that is the version a check carries", { timeout: 5000 }, async (context) => {
  const [referenceAnswer, objectAnswer] = serverFrames.filter((frame) => frame.during === "corporationSvc.GetAllCorpMedals").map(decoded);
  const reference = referenceAnswer.args[4][0].value;
  assert.equal(reference.args[2], null, "the recorded result has no version of its own");
  const [stamp, checksum] = reference.args[1].args[2];
  const corporation = reference.args[1].args[0][2][2];
  const { session, transport, clock, ask } = await cachingSession(context);
  // The session's clock, at the moment the server stamped the object.
  clock.ms += Number((BigInt(stamp) - FILETIME_EPOCH) / 10000n) - Math.trunc(session.serverNow());
  const asking = session.call("corporationSvc", "GetAllCorpMedals", [corporation]);
  await settle();
  transport.deliver(callResponse(lastCall(transport).packet.source.callID, reference));
  await settle();
  assert.equal(lastCall(transport).method, "GetCachableObject");
  transport.deliver(callResponse(lastCall(transport).packet.source.callID, objectAnswer.args[4][0].value));
  const medals = await asking;
  assert.deepEqual(session.cachedMethodCall("corporationSvc", "GetAllCorpMedals", [corporation]), { result: medals });
  // Good for the hour the server said, from the object's own stamp.
  clock.ms += 59 * 60_000 + 59_000;
  assert.deepEqual(await ask("call", "corporationSvc", "GetAllCorpMedals", [corporation], cacheOK), [medals, 0]);
  clock.ms += 1000;
  assert.deepEqual(await ask("call", "corporationSvc", "GetAllCorpMedals", [corporation], cacheOK), [medals, 1]);
  assert.deepEqual(versionSent(transport), { type: "list", items: [BigInt(stamp), checksum] });
});

test("an answer with no version to check it by is not kept", { timeout: 5000 }, async (context) => {
  const { session, ask } = await cachingSession(context);
  const unversioned = (value) => { const made = cachedResult(value); return { ...made, args: [made.args[0], made.args[1], null] }; };
  assert.deepEqual([await ask("call", "svc", "Unversioned", [], unversioned(1)), await ask("call", "svc", "Unversioned", [], unversioned(2))], [[1, 1], [2, 1]]);
  assert.equal(session.cachedMethodCall("svc", "Unversioned", []), null);
  // Nor one whose version does not say when, or has no checksum.
  const undated = (value) => { const made = cachedResult(value); return { ...made, args: [made.args[0], made.args[1], [null, 7]] }; };
  assert.deepEqual([await ask("call", "svc", "Undated", [], undated(1)), await ask("call", "svc", "Undated", [], undated(2))], [[1, 1], [2, 1]]);
  const half = (value) => { const made = cachedResult(value); return { ...made, args: [made.args[0], made.args[1], [5n, null]] }; };
  assert.deepEqual([await ask("call", "svc", "Half", [], half(1)), await ask("call", "svc", "Half", [], half(2))], [[1, 1], [2, 1]]);
});
