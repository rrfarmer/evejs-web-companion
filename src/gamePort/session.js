"use strict";

// ── A game-port session: the connection the retail client holds ─────────────
//
// One of these is one login on the eve.js game port (26000), kept open, doing
// on the wire what the retail client (build 3396210) does. It is written from
// the client's own source and checked against what a real server sends back:
//
//   handshake   carbon/common/script/net/GPS.py            Authenticate
//   after login carbon/common/script/net/machoNet.py       ConnectToServer
//               carbon/client/script/remote/connectionService.py
//                                                          Connect, PingLoop,
//                                                          ClockSyncDaemon
//   calls       ServiceCallGPCS.py, ObjectCallGPCS.py, moniker.py
//   packets     machoNetPacket.py, machoNetAddress.py, machoNetTransport.py
//
// docs/game-port-client-reference.md lists every point where this matches the
// client, and the ones that still need a recording of the real client to settle.
//
// ⚠ IT TAKES A FRAME TRANSPORT AND NEVER IMPORTS node:net. `transport` is
// anything with send(payload), close() and the onFrame / onClose hooks, so the
// same session can run over a TCP socket in Node (./tcp.js) or, later, over a
// relay from a browser.
//
// ⚠ ONE CHARACTER, ONE CONNECTION. Selecting a character here evicts any other
// session holding it, and closing this connection logs the character off. In
// space that is an emergency-warp logoff.

const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { marshalDecode, getDecodedNumberKind } = require("../gameProtocol/marshal");
const { remoteObjectReference } = require("./objectReference");
const { attributePythonType } = require("./clientDogmaArithmetic");
const { encodeClient, long } = require("./clientMarshal");
const {
  TYPE, anyAddress, buildPacket, clientAddress, dictGet, integer, nodeAddress, parsePacket, text, unwrapSubstream,
} = require("./packets");
const { caseFold, cryptoHash, passwordHash, randomBytes } = require("./placebo");
const { keywordOrder, monikerKeywordOrder, orderEntries } = require("./py27");
const { wireToBridgeJson } = require("./bridgeJson");

// Blue unmarshalling keeps integer and float objects distinct, even for 40.0
// and 0.0. Preserve that provenance on decoded containers for raw consumers;
// public values remain primitives and bridge JSON keeps its existing shape.
const GAME_PORT_DECODE_OPTIONS = Object.freeze({ preserveNumberKinds: true });
const decodeGamePort = buffer => marshalDecode(buffer, GAME_PORT_DECODE_OPTIONS);

/** What the client says it is. From the client's start.ini and GPS.py. */
const RETAIL_CLIENT = Object.freeze({
  handshakeSecret: 170472,
  machoVersion: 496,
  version: 24.01,
  build: 3396210,
  codename: "V24.01",
  region: "ccp",
});

/** boot.GetValue('handShakePaddingLength', 64): the client challenge's length. */
const HANDSHAKE_PADDING_LENGTH = 64;
/** prefs machoNet.minimumBytesToCompress. */
const COMPRESSION_THRESHOLD = 200;
/** globalConfig MAX_CONNECTION_IDLE_TIME_SECONDS_DEFAULT. */
const MAX_IDLE_SECONDS_DEFAULT = 60;
/** connectionService MAX_SYNC_TIME_IN_MINUTES. */
const CLOCK_SYNC_INTERVAL_MS = 3 * 60 * 1000;
const CLOCK_SYNC_ITERATIONS = 5;
const CALL_TIMEOUT_MS = 60_000;
/** The longest delay a timer here takes: past it, one fires at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** FILETIME ticks (100ns) between 1601 and 1970. */
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
/** objectCaching.__versionchecktimes__: how long an answer is good for, by what the server calls the time, in 100 ns. */
const [SECOND, MINUTE, HOUR, DAY] = [10_000_000n, 600_000_000n, 36_000_000_000n, 864_000_000_000n];
const VERSION_CHECK_TIMES = new Map([
  ["year", 360n * DAY], ["6 months", 180n * DAY], ["3 months", 90n * DAY], ["month", 30n * DAY], ["week", 7n * DAY], ["day", DAY],
  ["12 hours", 12n * HOUR], ["6 hours", 6n * HOUR], ["3 hours", 3n * HOUR], ["2 hours", 2n * HOUR], ["1 hour", HOUR],
  ["30 minutes", 30n * MINUTE], ["15 minutes", 15n * MINUTE], ["5 minutes", 5n * MINUTE], ["1 minute", MINUTE],
  ["30 seconds", 30n * SECOND], ["15 seconds", 15n * SECOND], ["5 seconds", 5n * SECOND], ["1 second", SECOND],
]);

/**
 * What the retail client prints when it runs the function the server sends at
 * login, keyed by the SHA-256 of that function's source.
 *
 * The server sends Python and the client runs it and returns its output. We are
 * not a Python interpreter, so we answer with what the real client is recorded
 * answering for that exact source (eve.js _local/logs/tidi_probe.*.log). A
 * function we have never seen gets an empty answer and `unknownHandshakeFunction`
 * is set, rather than a guess.
 */
const KNOWN_HANDSHAKE_FUNCTIONS = new Map([
  [
    // eve.js handshake.js buildTidiSignedFunc, as sent by eve.js 7603a2966. The
    // retail client's answer to it, 75 bytes, logged on 2026-10-06.
    "86b3a18871f7e5091b1796b8b30655643424679928207124bf6274d243015e3e",
    ["TIDI_HANDLER:OK", "PORTRAIT_UPLOAD_HANDLER:OK", "SKILL_EXTRACTOR_ACCESS_TOKEN:OK", ""].join("\n"),
  ],
]);

const dict = (entries) => ({ type: "dict", entries });
/**
 * What makes a call the same call as another (machobase.ThrottledCall's key): whom it is asked of, the method, and
 * str(args) and str(kwargs). str() tells an int from a long and a str from a unicode, and so does this; a dict's
 * order is its own affair, so the keywords are taken by name.
 */
function callKey(target, method, args, written) {
  const keywords = [...written].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([target, method, args, keywords], (name, value) => (typeof value === "bigint" ? { long: String(value) } : value));
}
/** A bind's parameters as a name for the address: a number however it is held, or the numbers of a tuple. */
const addressKey = (value) => (Array.isArray(value) ? `(${value.map(addressKey).join(",")})` : String(value?.type === "long" ? value.value : value));
/**
 * The call a bind carries, as the client's Moniker hands it over: (method, args, keywords), the keywords a dict of
 * their own in the order moniker.py leaves them in, and never None.
 */
function carriedCall([method, args, kwargs]) {
  const written = new Map(kwargs && kwargs.type === "dict" ? kwargs.entries : Object.entries(kwargs ?? {}));
  return [method, args ?? [], dict(monikerKeywordOrder([...written.keys()]).map((name) => [name, written.get(name)]))];
}
/** A Python unicode object, as opposed to a byte string. */
const unicode = (value) => ({ type: "wstring", value });
const bytes = (buffer) => ({ type: "bytes", value: buffer });

class GamePortError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** The best one-line reading of an exception payload the server raised. */
function describeError(payload) {
  const seen = [];
  const walk = (value, depth) => {
    if (depth > 6 || seen.length > 8 || value === null || value === undefined) return;
    const asText = text(value);
    if (asText !== null) {
      if (asText.length > 0 && asText.length < 120) seen.push(asText);
      return;
    }
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
    else if (typeof value === "object") {
      if (value.type === "object") {
        walk(value.name, depth + 1);
        walk(value.args, depth + 1);
      } else if (value.type === "dict") {
        value.entries.forEach(([key, entry]) => {
          walk(key, depth + 1);
          walk(entry, depth + 1);
        });
      } else if (value.type === "substream" || value.type === "substruct") walk(value.value, depth + 1);
      else if (value.type === "list") value.items.forEach((entry) => walk(entry, depth + 1));
    }
  };
  walk(payload, 0);
  return seen.length > 0 ? seen.join(" / ") : "no reason given";
}

/**
 * A GPSTransportClosed sent where a frame's value should be, or null. The server
 * sends one to say why it is about to hang up; the client's unmarshaller raises
 * it. It is an object with constructor arguments (reason, reasonCode, reasonArgs).
 */
function readTransportClosed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) return null;
  const header = Array.isArray(value.header) ? value.header : null;
  const name = text(header ? header[0] : value.name);
  if (!name || !/GPSTransportClosed$/.test(name)) return null;
  const args = header ? header[1] : value.args;
  const at = (index) => (Array.isArray(args) ? text(args[index]) : null);
  return { reason: at(0) ?? "Disconnected", reasonCode: at(1) };
}

/**
 * A pickle as a packet carries one: a substream, or a byte string that is
 * itself a marshal stream. (The server sends call answers the first way and
 * notifications the second.)
 */
function unpickle(value) {
  const inner = unwrapSubstream(value);
  if (Buffer.isBuffer(inner) && inner.length > 0 && inner[0] === 0x7e) return decodeGamePort(inner);
  return inner;
}

/**
 * Why the server refused a call, from the exception an ErrorResponse carries.
 *
 * The payload is (pickle,), and the pickle is the exception: for a game refusal
 * a UserError, whose constructor arguments are (msg, dict). `reason` is put
 * together exactly as the web gateway puts its CALL_REFUSED message together
 * (evejsWebGatewayRuntime.js readWrappedUserErrorRefusal), so a refusal reads
 * the same on either transport: the handler's own sentence when it gave one
 * (`info`, or CustomNotify's `notify`), the names in a structured `errors` list
 * when it gave that, and otherwise the bare message key.
 */
function readRefusal(payload) {
  const exception = wireToBridgeJson(unpickle(Array.isArray(payload) ? payload[0] : payload));
  const header = exception && Array.isArray(exception.header) ? exception.header : null;
  const className = header && header[0] && typeof header[0].value === "string" ? header[0].value : null;
  if (!className) return null;
  const args = Array.isArray(header[1]) ? header[1] : [];
  const key = typeof args[0] === "string" ? args[0] : "";
  const entries = args[1] && Array.isArray(args[1].entries) ? args[1].entries : [];
  const prose = entries.find((entry) => Array.isArray(entry) && (entry[0] === "info" || entry[0] === "notify") && entry[1]);
  let reason = key;
  if (prose) {
    reason = String(prose[1]);
  } else {
    const errors = entries.find((entry) => Array.isArray(entry) && entry[0] === "errors" && entry[1]);
    const names = [];
    for (const item of errors && Array.isArray(errors[1].items) ? errors[1].items : []) {
      // Each is (KeyVal{value, name}, args).
      const keyVal = Array.isArray(item) ? item[0] : item && Array.isArray(item.items) ? item.items[0] : null;
      const entriesOf = keyVal && keyVal.args && Array.isArray(keyVal.args.entries) ? keyVal.args.entries : [];
      const named = entriesOf.find((entry) => Array.isArray(entry) && entry[0] === "name" && entry[1]);
      if (named && !names.includes(String(named[1])) && names.length < 8) names.push(String(named[1]));
    }
    if (names.length > 0) reason = `${key}: ${names.join(", ")}`;
  }
  return { className, key, values: args[1] ?? null, reason };
}

/** The state of a decoded object of the class whose dotted name ends `suffix`, or null. */
function stateOfClass(value, suffix) {
  if (!value || typeof value !== "object" || value.type !== "object" || !Array.isArray(value.args)) return null;
  const name = text(value.name);
  return name && name.endsWith(suffix) ? value.args : null;
}

/**
 * A value with each whole number spelt one way, so that 5, 5n and the BFF's own {type: "long", value: "5"} make
 * one key: to the client's cache they are one number, whichever a call or a name was given.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  const long = value && typeof value === "object" && value.type === "long" && /^-?\d+$/.test(String(value.value)) ? BigInt(value.value) : value;
  return typeof long === "bigint" && long >= BigInt(Number.MIN_SAFE_INTEGER) && long <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(long) : long;
}

/** A tuple's or a list's items, however the codec spells it; none for anything else. */
const itemsOfSequence = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);

/** A value as a string that is the same for equal values: a cache key. */
function keyOf(value) {
  return JSON.stringify(value, (key, entry) => {
    if (typeof entry === "bigint") return `${entry}n`;
    if (entry && entry.type === "Buffer" && Array.isArray(entry.data)) return Buffer.from(entry.data).toString("latin1");
    return entry;
  });
}

/**
 * A notification, read the way the client's layers peel it:
 *   ObjectCallGPCS   body is (flag, pickle)
 *   ServiceCallGPCS  the pickle is (1, method, args[, kwargs]) for a service's
 *                    own notification, or (0, payload) for a broadcast
 *   BroadcastStuff   a broadcast's method is the address's broadcastID, and its
 *                    payload is (1, args)
 */
function readNotification(packet) {
  const outer = packet.body[0];
  const inner = Array.isArray(outer) ? unpickle(outer[1]) : null;
  const notification = {
    method: packet.destination.broadcastID ?? null,
    idtype: packet.destination.idtype ?? null,
    narrowcast: packet.destination.narrowcast ?? null,
    service: packet.destination.service ?? null,
    args: null,
    kwargs: null,
    packet,
  };
  if (!Array.isArray(inner)) return notification;
  if (inner[0]) {
    notification.method = text(inner[1]) ?? notification.method;
    notification.args = inner[2] ?? null;
    notification.kwargs = inner[3] ?? null;
  } else {
    const payload = inner[1];
    notification.args = Array.isArray(payload) && payload.length === 2 && payload[0] === 1 ? payload[1] : payload;
  }
  return notification;
}

class GamePortSession {
  constructor({
    transport,
    client = RETAIL_CLIENT,
    languageID = "EN",
    handshakeFunctions = KNOWN_HANDSHAKE_FUNCTIONS,
    onLoginProgram = null,
    journeyID = crypto.randomUUID(),
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout },
    callTimeoutMs = CALL_TIMEOUT_MS,
    provisionalWaitLimitMs = Infinity,
    clientCalls = null,
    onSent = null,
  } = {}) {
    if (!transport) throw new TypeError("A game-port session needs a transport.");
    this.transport = transport;
    this.client = client;
    this.languageID = languageID;
    this.onLoginProgram = onLoginProgram;
    this.handshakeFunctions = handshakeFunctions;
    this.journeyID = journeyID;
    this.now = now;
    this.timers = timers;
    this.callTimeoutMs = callTimeoutMs;
    /**
     * The longest a call waits once the server has said its answer will be late.
     * The client waits as long as the server says, which for a question put to
     * the player is a day; whoever is waiting on us may not have a day.
     */
    this.provisionalWaitLimitMs = provisionalWaitLimitMs;
    /**
     * The client's own services, for the calls the server makes to it:
     * fn({service, method, args, kwargs}) gives what the method returns, now or
     * as a promise. Undefined means nobody here answers that call.
     */
    this.clientCalls = clientCalls;
    /**
     * Told of each call as it goes on the wire: fn(service, method, {carried}), where `service` is the one a bound
     * object was bound for (null where that is not known) and `carried` is true for the call a bind carried. A call
     * shared with one already out, or answered from the object cache, is not sent and is not told.
     */
    this.onSent = onSent;

    this.closed = false;
    this.closeReason = null;
    this.loggedIn = false;
    this.handshakeInbox = [];
    this.handshakeWaiters = [];
    this.pending = new Map();
    this.nextCallID = 1;
    /** machoNet's address cache: "service:bindParams" -> the node that address was said to live on. */
    this.nodeOfAddress = new Map();
    this.nodeOfAddressRecords = new Map();
    /** The calls that are out now, by what makes each the call it is (callKey), each with the answer awaited. */
    this.callsOut = new Map();
    /** The service each bound object was bound for, by its "N=node:id": what a call on it is counted under (onSent). */
    this.objectServices = new Map();
    /** moniker.py Bind: persistent identity (service, bindParams), independent of the current N=node:id. */
    this.objectCacheIdentities = new Map();
    /** Cached objects fetched so far, by object ID: {stamp, checksum, value}. */
    this.cachedObjects = new Map();
    /** objectCaching.methodCallCachingDetails: what the server said of a method's answers, by "service.method": {versionCheck, sessionInfo}. */
    this.methodCallDetails = new Map();
    /** objectCaching.cachedMethodCalls: an answer by service, method, the session's value it is kept by, and arguments: {result, stamp, checksum}. */
    this.cachedMethodCalls = new Map();
    /** objectCaching.runid: when this run began, as the client reckons time. Set when it is first wanted. */
    this.runStarted = null;

    /** What the server told us at login (GPS.py's `response`). */
    this.loginResponse = null;
    this.userID = null;
    this.clientID = null;
    this.proxyNodeID = null;
    this.serviceInfo = null;
    this.logonQueuePosition = null;
    this.unknownHandshakeFunction = null;
    /** What was answered to the server's login function: what the retail client prints on running it, or "" for one never seen. */
    this.handshakeAnswer = null;
    /** The session attributes, kept current from session-change packets. */
    this.attributes = {};
    // Last wire values, distinct from a full native CoreSession and its
    // ComputeNotifySets/default/dependent-attribute policy. Capture scalar
    // provenance before copying values out of their decoded parent slots.
    this.sessionAttributeRecords = new Map();
    this.sessionAttributeRevision = 0;
    // Admission to ConnectToServer after the separate status/QC exchange.
    // This is an ingress revision, not machoNet's native clientSessionID.
    this.connectAttemptRevision = 0;
    /** Server clock minus ours, in milliseconds, from the last clock sync. */
    this.clockOffsetMs = 0;
    this.lastSentAt = this.now();
    this.counters = { sent: 0, received: 0, compressedSent: 0, compressedReceived: 0, unknownPackets: 0 };

    this.listeners = { notification: new Set(), sessionChange: new Set(), sessionAttributes: new Set(), connectAttempt: new Set(), close: new Set(), packet: new Set(), clientCall: new Set() };
    this.backgroundTimers = new Set();

    transport.onFrame = (payload) => this._onFrame(payload);
    // The connection went away without our closing it: the server dropped us
    // (a takeover of the character does exactly this, with no notice) or the
    // network did.
    transport.onClose = (error) => this._onClosed(new GamePortError("CONNECTION_LOST", (error && error.message) || "The game connection closed.", error ?? null));
  }

  // ── listening ──────────────────────────────────────────────────────────────

  /** fn({method, idtype, narrowcast, service, args, kwargs, packet}) for every notification. */
  onNotification(listener) { return this._listen("notification", listener); }
  /** fn(changes, attributes): changes is {name: [old, new]}. */
  onSessionChange(listener) { return this._listen("sessionChange", listener); }
  /** Typed raw attribute ingress, including the login snapshot; before public change listeners. */
  onSessionAttributeUpdate(listener) { return this._listen("sessionAttributes", listener); }
  /** Synchronous native-owner ingress before actual login authentication. */
  onConnectAttempt(listener) { return this._listen("connectAttempt", listener); }
  readSessionAttribute(name) {
    return this.sessionAttributeRecords.get(name) ?? Object.freeze({ present: false });
  }
  sessionLifecycle() {
    return Object.freeze({ closed: this.closed, loggedIn: this.loggedIn, revision: this.sessionAttributeRevision, connectAttemptRevision: this.connectAttemptRevision });
  }
  _captureSessionAttribute(name, container, slot, source) {
    const record = Object.freeze({
      present: true, value: container[slot], kind: getDecodedNumberKind(container, slot),
      source, revision: this.sessionAttributeRevision,
      ...(source === "change" ? { old: Object.freeze({ value: container[0], kind: getDecodedNumberKind(container, 0) }) } : {}),
    });
    this.sessionAttributeRecords.set(name, record);
    return Object.freeze([name, record]);
  }
  /** fn(error) once, when the connection is gone. The character is logged off. */
  onClose(listener) { return this._listen("close", listener); }
  /** fn(packet, direction) for every packet, "in" or "out". For recording. */
  onPacket(listener) { return this._listen("packet", listener); }
  /**
   * fn({service, method, args, kwargs, answered, answer, error}) once for every
   * call the server made to this client, after it was answered or left alone.
   */
  onClientCall(listener) { return this._listen("clientCall", listener); }

  _listen(kind, listener) {
    this.listeners[kind].add(listener);
    return () => this.listeners[kind].delete(listener);
  }

  _emit(kind, ...args) {
    for (const listener of [...this.listeners[kind]]) {
      try {
        listener(...args);
      } catch {
        // A listener's failure is its own; it must not take the connection down.
      }
    }
  }

  // ── login: GPS.py Authenticate, then machoNet.ConnectToServer ──────────────

  /**
   * Log in as `userName`, the way the client's login screen does.
   *
   * `password` is whatever was typed. eve.js does not check it, but the client
   * still hashes it and sends the hash, so we do too.
   */
  async login(userName, password = "") {
    // The login screen asks where it stands in the queue before the player has
    // typed anything, then logs in on the same connection.
    await this._exchangeVersions();
    this._writeRaw([null, "QC"]);
    this.logonQueuePosition = integer(await this._readRaw());

    // machoNet.ConnectToServer1565: increment the client-local epoch after
    // GetServerStatus/QC, before Authenticate's second exchange/VK. Its native
    // owner performs the actual Python increment. Critical ingress failures
    // must propagate, unlike optional diagnostic/event listeners in _emit.
    const attempt = Object.freeze({ revision: ++this.connectAttemptRevision });
    for (const listener of [...this.listeners.connectAttempt]) listener(attempt);

    await this._exchangeVersions();
    // The name comes from the login screen's edit box, so it is a unicode
    // object here and in the credentials below; everything else is a byte string.
    this._writeRaw([null, "VK", cryptoHash(unicode(caseFold(userName)))]);
    // (publicKeyVersion, cryptoContext.Initialize()): Placebo has no keys.
    this._writeRaw(["placebo", dict([])]);
    await this._readRaw(); // "OK CC"; the client reads it and does not look.

    const clientChallenge = randomBytes(HANDSHAKE_PADDING_LENGTH);
    const credentials = (passwordField, hashField) => dict(orderEntries([
      ["macho_version", this.client.machoVersion],
      ["boot_version", this.client.version],
      ["boot_build", this.client.build],
      ["boot_codename", this.client.codename],
      ["boot_region", this.client.region],
      ["user_name", unicode(userName)],
      ["user_password", passwordField],
      ["user_password_hash", hashField],
      ["user_languageid", this.languageID],
      ["user_affiliateid", 0],
      ["user_sso_token", null],
    ], { presized: 11 }));
    this._writeRaw([clientChallenge, credentials(null, bytes(passwordHash(userName, password)))]);
    const passwordVersion = await this._readRaw();
    if (passwordVersion === 1) {
      this._writeRaw([clientChallenge, credentials(password, null)]);
    } else if (passwordVersion !== 2) {
      throw this._fail(new GamePortError("LOGIN_REFUSED", `The game server refused the login: ${describeError(passwordVersion)}`, passwordVersion));
    }

    const handshake = await this._readRaw();
    if (!Array.isArray(handshake) || handshake.length < 4) {
      throw this._fail(new GamePortError("LOGIN_REFUSED", `The game server refused the login: ${describeError(handshake)}`, handshake));
    }
    const [serverChallenge, signedFunction, , response] = handshake;
    if (text(dictGet(response, "challenge_responsehash")) !== cryptoHash(clientChallenge)) {
      throw this._fail(new GamePortError("BAD_SERVER_SIGNATURE", "Server response signature incorrect, the server's crypto hash wasn't correct"));
    }
    const queued = integer(dictGet(response, "user_logonqueueposition")) ?? 0;
    if (queued >= 2) {
      this.logonQueuePosition = queued;
      throw this._fail(new GamePortError("LOGON_QUEUE", `The game server put this login at position ${queued} in its queue.`));
    }
    this._writeRaw([cryptoHash(text(serverChallenge) ?? ""), this._runHandshakeFunction(signedFunction), null]);

    const acknowledgement = await this._readRaw();
    if (!acknowledgement || acknowledgement.type !== "dict") {
      throw this._fail(new GamePortError("LOGIN_REFUSED", "Server didn't ACK our Challenge-Response", acknowledgement));
    }
    this.loginResponse = dict([...response.entries, ...acknowledgement.entries]);
    const sessionInit = dictGet(this.loginResponse, "session_init");
    this.userID = integer(dictGet(sessionInit, "userid"));
    this.clientID = integer(dictGet(this.loginResponse, "user_clientid"));
    this.proxyNodeID = integer(dictGet(this.loginResponse, "proxy_nodeid"));
    if (this.userID === null || this.proxyNodeID === null) {
      throw this._fail(new GamePortError("LOGIN_REFUSED", "The game server's login answer carried no session."));
    }
    const loginRecords = [];
    if (sessionInit && sessionInit.type === "dict") {
      this.sessionAttributeRevision++;
      for (const entry of sessionInit.entries) {
        const key = text(entry[0]);
        loginRecords.push(this._captureSessionAttribute(key, entry, 1, "login"));
        this.attributes[key] = entry[1];
      }
    }

    // From here every frame is a packet.
    this.loggedIn = true;
    this._emit("sessionAttributes", Object.freeze({ source: "login", revision: this.sessionAttributeRevision, records: Object.freeze(loginRecords) }));
    for (const value of this.handshakeInbox.splice(0)) this._dispatch(value);

    // machoNet.ConnectToServer's first call, then connectionService.Connect.
    this.serviceInfo = await this.proxyCall("machoNet", "GetServiceInfo");
    await this.synchronizeClock();
    this._startClockSyncDaemon();
    this._startPingLoop();
    return this.loginResponse;
  }

  async _exchangeVersions() {
    const server = await this._readRaw();
    if (!Array.isArray(server) || server.length < 6) {
      throw this._fail(new GamePortError("INCOMPATIBLE_PROTOCOL", "The game server did not open with a version exchange."));
    }
    // The checks GPS.py makes, in its order. A mismatch closes the connection.
    const [, machoVersion, , version, build, project] = server;
    const [codename, region = ""] = String(text(project) ?? "").split("@");
    const refuse = (code, what) => this._fail(new GamePortError(code, `Incompatible ${what}: the server is ${text(project)} ${version} build ${build}, protocol ${machoVersion}.`));
    if (region !== this.client.region) throw refuse("HANDSHAKE_INCOMPATIBLEREGION", "region");
    if (codename !== this.client.codename) throw refuse("HANDSHAKE_INCOMPATIBLERELEASE", "release");
    if (version !== this.client.version) throw refuse("HANDSHAKE_INCOMPATIBLEVERSION", "version");
    if (machoVersion !== this.client.machoVersion) throw refuse("HANDSHAKE_INCOMPATIBLEPROTOCOL", "protocol");
    if (this.client.build < build) throw refuse("HANDSHAKE_INCOMPATIBLEBUILD", "build");
    this.serverVersion = { machoVersion, userCount: integer(server[2]), version, build, codename, region };
    // (secret, macho.version, 0, boot.version, boot.build, codename@region)
    this._writeRaw([
      this.client.handshakeSecret, this.client.machoVersion, 0, this.client.version, this.client.build,
      `${this.client.codename}@${this.client.region}`,
    ]);
  }

  /** What the client's stdout held after running the server's login function. */
  _runHandshakeFunction(signedFunction) {
    const marshaled = Array.isArray(signedFunction) ? signedFunction[0] : signedFunction;
    const source = Buffer.isBuffer(marshaled) ? marshaled : Buffer.from(String(text(marshaled) ?? ""), "latin1");
    const digest = crypto.createHash("sha256").update(source).digest("hex");
    const nativeDigest = this.onLoginProgram?.(source, digest);
    const known = this.handshakeFunctions.get(digest) ?? this.handshakeFunctions.get(nativeDigest);
    if (known === undefined) {
      this.unknownHandshakeFunction = digest;
      this.handshakeAnswer = "";
      return "";
    }
    this.handshakeAnswer = known;
    return known;
  }

  // ── calls: ServiceCallGPCS, ObjectCallGPCS, moniker ────────────────────────

  /** sm.RemoteSvc(service).method(*args, **kwargs) */
  call(service, method, args = [], kwargs = null, beforeDispatch = undefined, signal = undefined) {
    return this._serviceCall(anyAddress(service), service, method, args, kwargs, beforeDispatch, signal);
  }

  /** sm.ProxySvc(service).method(*args, **kwargs): addressed to our proxy node. */
  proxyCall(service, method, args = [], kwargs = null) {
    return this._serviceCall(nodeAddress(this.proxyNodeID, service), service, method, args, kwargs);
  }

  /**
   * A call of a service's method, as ServiceCallGPCS makes one (RemoteServiceCallWithoutTheStars): the object
   * cache is asked first. An answer held and still good is the answer, and nothing is sent. One held that is due
   * a check is asked for with the version held, machoVersion=[stamp, checksum]; the server answers with a new
   * answer, which is kept in its place, or with CacheOK, and then the copy held is the answer and is good from
   * now (UpdateVersionCheckPeriod). With nothing held the version is 1.
   */
  _serviceCall(destination, service, method, args, kwargs, beforeDispatch = undefined, signal = undefined) {
    return this._cachedCall({ destination, boundObject: null, service, method, args, kwargs, beforeDispatch, signal }, service);
  }

  /** ServiceCallGPCS and ObjectCallGPCS both consult objectCaching, keyed by the persistent object or service. */
  async _cachedCall(spec, identity) {
    if (spec.signal?.aborted) throw new GamePortError("CALL_RETIRED", "The calling tasklet has retired.");
    const { method, args } = spec;
    const said = this.methodCallDetails.get(`${identity}.${method}`);
    const kept = said ? this.cachedMethodCalls.get(this._methodCallKey(identity, method, args, said)) : undefined;
    if (kept && !this._shouldVersionCheck(said, kept)) return kept.result;
    const machoVersion = kept ? { type: "list", items: [kept.stamp, kept.checksum] } : 1;
    try {
      return await this._call({ ...spec, machoVersion });
    } catch (error) {
      const className = error && error.refusal ? error.refusal.className : null;
      if (!kept || typeof className !== "string" || !className.endsWith("objectCaching.CacheOK")) throw error;
      kept.stamp = this._filetimeNow();
      return kept.result;
    }
  }

  /**
   * machoNet.SetNodeOfAddress: an address is known to live on a node without asking. A Moniker that arrives
   * naming its node says so (moniker.py __setstate__).
   */
  setNodeOfAddress(service, bindParams, nodeID) {
    const address = `${service}:${addressKey(bindParams)}`;
    this.nodeOfAddress.set(address, nodeID);
    this.nodeOfAddressRecords.delete(address);
  }

  /**
   * Bind a service's object, as a Moniker does (moniker.py Bind): find the node
   * the address lives on, which is asked of any node once (MachoResolveObject)
   * and remembered as machoNet's address cache remembers it, then bind there
   * (MachoBindObject). `call` is the call that made the Moniker bind,
   * [method, args, keywords], and rides along: the client sends
   * MachoBindObject(bindParams, (method, args, keywords)) and gets the object
   * and the call's answer together. Also retains the actual decoded reference
   * receipt, including its typed refID and optional public attributes.
   */
  async bind(service, bindParams, call = null, beforeBind = undefined) {
    const address = `${service}:${addressKey(bindParams)}`;
    let nodeID = this.nodeOfAddress.get(address) ?? null;
    if (nodeID === null) {
      // Asked once however many are waiting, as any call is (_call).
      nodeID = integer(await this.call(service, "MachoResolveObject", [bindParams]));
      if (nodeID === null) throw new GamePortError("RESOLVE_FAILED", `${service} could not say where its object lives.`);
      this.nodeOfAddress.set(address, nodeID);
    }
    const nodeRecord = this.nodeOfAddressRecords.get(address);
    beforeBind?.(nodeRecord);
    const bindNode = nodeRecord?.kind
      ? attributePythonType(nodeRecord) === "long" ? long(nodeRecord.value) : nodeRecord.value : nodeID;
    const reply = await this._call({
      destination: nodeAddress(bindNode, service), boundObject: null, service, method: "MachoBindObject", args: [bindParams, call === null ? null : carriedCall(call)], kwargs: null,
      carried: call === null ? null : call[0],
    });
    const head = Array.isArray(reply) ? reply[0] : null;
    const reference = remoteObjectReference(head);
    const pair = unwrapSubstream(head && typeof head === "object" && head.type === "substruct" ? head.value : head);
    const objectID = reference?.objectID ?? (Array.isArray(pair) ? text(pair[0]) : text(pair));
    if (!objectID || !objectID.startsWith("N=")) {
      throw new GamePortError("BIND_FAILED", `${service} did not return a bound object.`, reply);
    }
    this.objectServices.set(objectID, service);
    this.objectCacheIdentities.set(objectID, this._cacheIdentity([service, bindParams]));
    return { objectID, nodeID, nodeRecord, reference, result: Array.isArray(reply) ? reply[1] : null };
  }

  /**
   * An object another call answered with (invCache's inventories, a fleet made, the scan manager), known from now
   * as the service's that answered it, so that what is sent on it is counted under that service. Answers the
   * object's "N=node:id".
   */
  objectIsOf(objectID, service) {
    if (objectID && service) this.objectServices.set(objectID, service);
    return objectID;
  }

  /** Inventory holders pass their own receipt capability, not a per-N alias.
   * Other not-yet-native services still use their actual N= string. */
  callBound(remote, method, args = [], kwargs = null) {
    const objectID = typeof remote === "string" ? remote : remote?.objectID;
    if (typeof objectID !== "string" || !objectID.startsWith("N=")) throw new TypeError("An actual bound object is required.");
    const dispatch = typeof remote === "string" ? undefined : remote.dispatch();
    // ObjectCallGPCS: MachoAddress(nodeID=long(nid)), read out of the object's ID.
    const prepareDestination = dispatch?.prepareDestination;
    let destination = null;
    if (!prepareDestination) {
      const nodeID = String(objectID).slice(2).split(":")[0];
      if (!nodeID.trim()) throw new TypeError("The remote object has no node ID.");
      destination = nodeAddress(long(BigInt(nodeID)));
    }
    const cacheIdentity = dispatch && Object.hasOwn(dispatch, "cacheIdentity")
      ? this._cacheIdentity(dispatch.cacheIdentity) : this.objectCacheIdentities.get(objectID) ?? objectID;
    return this._cachedCall({ destination, prepareDestination, cacheIdentity, boundObject: objectID, service: null, method, args, kwargs }, cacheIdentity);
  }

  /** ObjectCallGPCS blocking=-1, MachoTransport.Write even-command source.
   * Notification only: no call number, reply waiter or throttling.
   */
  releaseRemoteObjects(destination, released, minus) {
    if (this.closed || !this.loggedIn) return false;
    const identity = "ClientHasReleasedTheseObjects", method = identity, args = [];
    const said = this.methodCallDetails.get(`${identity}.${method}`);
    const kept = said ? this.cachedMethodCalls.get(this._methodCallKey(identity, method, args, said)) : undefined;
    if (kept && !this._shouldVersionCheck(said, kept)) return false;
    const machoVersion = kept ? { type: "list", items: [kept.stamp, kept.checksum] } : 1;
    const packet = buildPacket(TYPE.NOTIFICATION, {
      source: nodeAddress(null), destination, userID: this.userID,
      body: [[1, { type: "substream", value: [released, method, args, dict([["machoVersion", machoVersion]])] }]],
      oob: dict([["OID-", minus]]), journeyID: this.journeyID,
    });
    try { this._writePacket(packet); }
    catch (error) { if (this.closed) return false; throw error; }
    return true;
  }

  /**
   * A call, made as the client makes every call: one at a time of any one thing (machobase.ThrottledCall, from
   * ServiceCallGPCS 697 and ObjectCallGPCS 616). The same call made again while it is out is not sent: it waits
   * for the one that is out and takes its answer ("Sharing result for call ... for 1 waiting threads", in the
   * client's log). A call that failed is no answer: the first of those waiting asks for itself, and the rest
   * wait for that.
   */
  async _call(spec) {
    const written = new Map(spec.kwargs && spec.kwargs.type === "dict" ? spec.kwargs.entries : Object.entries(spec.kwargs ?? {}));
    const key = callKey(spec.boundObject ?? spec.service, spec.method, spec.args, written);
    for (;;) {
      const out = this.callsOut.get(key);
      if (!out) break;
      const shared = await this._callerWait(out.then((answer) => ({ answer }), () => null), spec.signal);
      if (shared) return shared.answer;
    }
    const asking = this._makeCall(spec, written);
    this.callsOut.set(key, asking);
    try {
      return await asking;
    } finally {
      if (this.callsOut.get(key) === asking) this.callsOut.delete(key);
    }
  }

  /** A killed throttler waiter must not kill the tasklet whose result it shares. */
  _callerWait(work, signal) {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(new GamePortError("CALL_RETIRED", "The calling tasklet has retired."));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new GamePortError("CALL_RETIRED", "The calling tasklet has retired."));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(
        value => { signal.removeEventListener("abort", abort); resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }

  /** The call itself: numbered, wrapped and sent, and its answer awaited. */
  _makeCall({ destination, prepareDestination, cacheIdentity, boundObject, service, method, args, machoVersion = 1, carried = null, beforeDispatch, signal }, written) {
    if (!this.loggedIn || this.closed) {
      return Promise.reject(new GamePortError("NOT_CONNECTED", "The game connection is not logged in."));
    }
    // A top-level corporation write can wait behind an identical outstanding
    // call. Recheck its original session at the actual send, including retries.
    beforeDispatch?.();
    if (signal?.aborted) return Promise.reject(new GamePortError("CALL_RETIRED", "The calling tasklet has retired."));
    const callID = this.nextCallID;
    this.nextCallID += 1;
    // Every call's keywords carry machoVersion, 1 unless a cached answer says
    // otherwise (_serviceCall), and go out in the order the client's own dict would hold them:
    // a service's method and a bound object's method build that dict differently.
    written.set("machoVersion", machoVersion);
    const names = [...written.keys()].filter((name) => name !== "machoVersion");
    const keywords = dict(keywordOrder(names, { via: boundObject === null ? "function" : "object" }).map((name) => [name, written.get(name)]));
    // ObjectCallGPCS: (0, pickle((1, method, args, kw))) for a service,
    // (1, pickle((objectID, method, args, kw))) for a bound object.
    const body = boundObject === null
      ? [0, { type: "substream", value: [1, method, args, keywords] }]
      : [1, { type: "substream", value: [boundObject, method, args, keywords] }];
    const packet = buildPacket(TYPE.CALL_REQ, {
      // machoNet._BlockingCall: MachoAddress(clientID=0, callID=callID). The
      // counter starts life as 1L, so the call ID is a long however small.
      source: clientAddress(0, long(callID)),
      destination,
      userID: this.userID,
      body: [body],
      journeyID: this.journeyID,
    });
    let abort;
    const answered = new Promise((resolve, reject) => {
      const waiter = { label: `${service ?? boundObject}.${method}`, resolve, reject, timer: undefined };
      if (boundObject === null && method === "MachoResolveObject" && args.length === 1) waiter.resolveAddress = `${service}:${addressKey(args[0])}`;
      this.pending.set(callID, waiter);
      this._waitFor(callID, waiter, this.callTimeoutMs);
      if (signal) {
        abort = () => {
          if (this.pending.get(callID) !== waiter) return;
          this.pending.delete(callID); this.timers.clearTimeout(waiter.timer);
          reject(new GamePortError("CALL_RETIRED", "The calling tasklet has retired."));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
      }
      try {
        if (prepareDestination) packet.args[2] = prepareDestination();
        this._writePacket(packet);
      } catch (error) {
        this.timers.clearTimeout(waiter.timer);
        this.pending.delete(callID);
        reject(error);
        return;
      }
      this._sent(service ?? this.objectServices.get(boundObject) ?? null, method, carried);
    });
    return answered.then((result) => {
      if (signal?.aborted) throw new GamePortError("CALL_RETIRED", "The calling tasklet has retired.");
      return this._answered({ boundObject, service, method, args, cacheIdentity }, result);
    }).finally(() => { if (abort) signal.removeEventListener("abort", abort); });
  }

  /** A call on the wire, told to whoever counts them (onSent), and the call a bind carried after it. Their counting is never the call's failure. */
  _sent(service, method, carried) {
    if (typeof this.onSent !== "function") return;
    try {
      this.onSent(service, method, { carried: false });
      if (typeof carried === "string") this.onSent(service, carried, { carried: true });
    } catch {
      // A count missed is a count missed; the call is out.
    }
  }

  /** What a call answers its caller: the result opened and cached under its service or persistent object identity. */
  async _answered({ boundObject, service, method, args, cacheIdentity }, value) {
    const state = stateOfClass(value, "objectCaching.CachedMethodCallResult");
    const result = await this._unwrapCachedResult(value);
    if (state) this._cacheMethodCall(boundObject === null ? service : cacheIdentity ?? this.objectCacheIdentities.get(boundObject) ?? boundObject, method, args, state, result);
    return result;
  }

  /** Give a call this long, from now, to be answered. */
  _waitFor(callID, waiter, milliseconds) {
    if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
    waiter.timer = this.timers.setTimeout(() => {
      this.pending.delete(callID);
      waiter.reject(new GamePortError("CALL_TIMEOUT", `${waiter.label} got no answer from the game server.`));
    }, milliseconds);
  }

  // ── cached answers: objectCaching ──────────────────────────────────────────

  /**
   * What the caller of a remote call gets when the server answers with a
   * CachedMethodCallResult, which is the answer itself and not the wrapper
   * (ServiceCallGPCS: `ret = ret.GetResult()`). Its state is
   * (details, result, version), and `result` is one of two things:
   *
   *   a marshal string      the answer, inline
   *   a util.CachedObject   a reference; the object is fetched from
   *                         objectCaching on first use
   *
   * Anything else is returned as it came.
   */
  async _unwrapCachedResult(value) {
    const state = stateOfClass(value, "objectCaching.CachedMethodCallResult");
    if (!state) return value;
    const reference = stateOfClass(state[1], "cachedObject.CachedObject");
    return reference ? this.fetchCachedObject(state[1]) : unpickle(state[1]);
  }

  /** The client's clock now, as it reckons time: 100 ns since 1601. */
  _filetimeNow() {
    return BigInt(Math.trunc(this.serverNow())) * 10000n + FILETIME_EPOCH_OFFSET;
  }

  /** A moniker's persistent tuple, or an ordinary service/object name, as a stable cache identity. */
  _cacheIdentity(value) {
    return Array.isArray(value) ? `moniker:${text(value[0])}:${addressKey(value[1])}` : text(value);
  }

  /** What an answer of a service's method is kept as: the service, the method, the session's value the server said to keep it by, and the arguments. */
  _methodCallKey(service, method, args, details) {
    const by = details.sessionInfo === null ? [] : [this.attributes[details.sessionInfo] ?? null];
    return keyOf(canonical([service, method, ...by, ...(Array.isArray(args) ? args : [])]));
  }

  /**
   * objectCaching.CacheMethodCall: a service's method answered with a CachedMethodCallResult, whose state is
   * (details, result, version). What the server says of the method's answers the first time is what holds for
   * the run. The answer is kept unless the details say it is not to be (a version check of None).
   */
  _cacheMethodCall(service, method, args, [details, held, version], result) {
    const pair = `${service}.${method}`;
    if (!this.methodCallDetails.has(pair)) {
      const entries = new Map((details && Array.isArray(details.entries) ? details.entries : []).map(([name, entry]) => [text(name), entry]));
      // A version check may be one word, or three: the client's, the proxy's and the server's.
      const check = entries.has("versionCheck") ? entries.get("versionCheck") : "run";
      const own = Array.isArray(check) ? check[0] : check;
      this.methodCallDetails.set(pair, { versionCheck: own === null ? null : text(own) ?? integer(own), sessionInfo: text(entries.get("sessionInfo")) ?? null });
    }
    const said = this.methodCallDetails.get(pair);
    if (said.versionCheck === null) return;
    // CachedMethodCallResult.GetVersion: a result that is a reference to a cached object has that object's
    // version, and its own is None; one held inline has its own. A version is (when, checksum).
    const reference = stateOfClass(held, "cachedObject.CachedObject");
    const [when, checksum] = itemsOfSequence(reference ? reference[2] : version);
    // With no version to check it by, there is nothing the client could send for it: not kept.
    if (integer(when) === null || checksum === undefined || checksum === null) return;
    this.runStarted ??= this._filetimeNow();
    // The checksum is sent back as it came; "when" is moved on by a check that says the copy is good.
    this.cachedMethodCalls.set(this._methodCallKey(service, method, args, said), { result, stamp: BigInt(integer(when)), checksum });
  }

  /**
   * objectCaching.__ShouldVersionCheck: whether an answer kept is to be checked with the server before it is
   * used again. Never, always, not within the run it was got in, or once it is older than the server said it
   * is good for; the two that end at midnight end at the first UTC midnight after the run began.
   */
  _shouldVersionCheck({ versionCheck }, { stamp }) {
    if (versionCheck === "never" || versionCheck === "run") return false;
    if (versionCheck === "always") return true;
    const now = this._filetimeNow();
    let maxAge;
    if (versionCheck === "utcmidnight" || versionCheck === "utcmidnight_or_3hours") {
      this.runStarted ??= now;
      const untilMidnight = (this.runStarted / DAY + 1n) * DAY - now;
      maxAge = versionCheck === "utcmidnight" || untilMidnight < 3n * HOUR ? untilMidnight : 3n * HOUR;
    } else if (typeof versionCheck === "number") {
      maxAge = BigInt(versionCheck);
    } else if (VERSION_CHECK_TIMES.has(versionCheck)) {
      maxAge = VERSION_CHECK_TIMES.get(versionCheck);
    } else {
      return true; // a time the client has no word for: it would not use the answer
    }
    return maxAge <= now - stamp;
  }

  /**
   * objectCaching.PerformCachedMethodCall: what the object cache answers a call of a service's method with,
   * without asking the server ("returning a cached result", in the client's log). {result} for an answer kept
   * and still good; null for a method the server has not marked as cached, an answer not kept, and one that is
   * due a check with the server.
   *
   * This is the cache's own word, for whoever wants to know whether a call would be sent. A call itself goes
   * through _serviceCall, which makes the check with the server where one is due.
   */
  cachedMethodCall(service, method, args = []) {
    const said = this.methodCallDetails.get(`${service}.${method}`);
    if (!said || said.versionCheck === null) return null;
    const kept = this.cachedMethodCalls.get(this._methodCallKey(service, method, args, said));
    return kept && !this._shouldVersionCheck(said, kept) ? { result: kept.result } : null;
  }

  /**
   * objectCaching.InvalidateCachedMethodCalls: each of [service, method, args] is forgotten, so that it is asked
   * for when next wanted. The server calls this on the client when it knows an answer has changed, and the
   * client's own code calls it too (cachedCallsNamed.js). What the server said of the method's answers stands.
   */
  invalidateCachedMethodCalls(calls) {
    for (const [service, method, args] of calls) {
      const identity = this._cacheIdentity(service);
      const said = this.methodCallDetails.get(`${identity}.${text(method)}`);
      if (said) this.cachedMethodCalls.delete(this._methodCallKey(identity, text(method), itemsOfSequence(args), said));
    }
  }

  /**
   * The object a util.CachedObject refers to. Its state is
   * (objectID, nodeID, objectVersion[, shared]); `shared` is left out when true.
   *
   * objectCaching.GetCachableObject: a shared object is asked for through our
   * proxy node, any other from the node that holds it. The answer is an
   * objectCaching.CachedObject, state (version, object, nodeID, shared, pickle,
   * compressed, objectID), whose pickle is zlib when `compressed` is set.
   *
   * Like the client, we keep what we fetched. A version is (timestamp,
   * checksum), and the client asks again only when the checksum differs AND
   * what it holds is older (objectCaching.__OlderVersion). The timestamp alone
   * changing, which it does on every answer, is not a new version.
   */
  async fetchCachedObject(reference) {
    const state = stateOfClass(reference, "cachedObject.CachedObject");
    if (!state) throw new GamePortError("NOT_A_CACHED_OBJECT", "That value is not a cached object reference.");
    const [objectID, nodeID, objectVersion, sharedField] = state;
    const shared = state.length < 4 ? 1 : sharedField;
    const key = keyOf(objectID);
    const [stamp, checksum] = Array.isArray(objectVersion) ? objectVersion.map((part) => BigInt(integer(part) ?? 0)) : [0n, 0n];
    const kept = this.cachedObjects.get(key);
    if (kept && !(kept.checksum !== checksum && kept.stamp < stamp)) return kept.value;

    const remote = await this._call({
      destination: nodeAddress(shared ? this.proxyNodeID : integer(nodeID), "objectCaching"),
      boundObject: null,
      service: "objectCaching",
      method: "GetCachableObject",
      args: [shared, objectID, objectVersion, nodeID],
      kwargs: null,
    });
    const container = stateOfClass(remote, "objectCaching.CachedObject");
    if (!container) throw new GamePortError("BAD_CACHED_OBJECT", "objectCaching did not answer with a cached object.", remote);
    const [, object, , , pickle, compressed] = container;
    let value = object;
    if (value === null || value === undefined) {
      if (!Buffer.isBuffer(pickle)) throw new GamePortError("BAD_CACHED_OBJECT", "Getting cached object contents, but both the object and the pickle are none");
      value = decodeGamePort(compressed ? zlib.inflateSync(pickle) : pickle);
    }
    this.cachedObjects.set(key, { stamp, checksum, value });
    return value;
  }

  // ── clock and keep-alive: connectionService ────────────────────────────────

  /** SynchronizeClock: up to five GetTime calls, stopping after three good ones. */
  async synchronizeClock(iterations = CLOCK_SYNC_ITERATIONS) {
    let good = 0;
    let lastElapsed = null;
    for (let index = 0; index < iterations; index += 1) {
      const started = this.now();
      const serverTime = integer(await this.proxyCall("machoNet", "GetTime"));
      const elapsed = this.now() - started;
      if (serverTime === null) continue;
      if (lastElapsed === null || (elapsed < lastElapsed && elapsed < 1000)) {
        const serverMs = Number((BigInt(serverTime) - FILETIME_EPOCH_OFFSET) / 10000n) + elapsed / 2;
        this.clockOffsetMs = serverMs - this.now();
        lastElapsed = elapsed;
        good += 1;
      }
      if (good >= 3) break;
    }
    return this.clockOffsetMs;
  }

  /** The server's clock, as far as the last sync could tell. */
  serverNow() {
    return this.now() + this.clockOffsetMs;
  }

  _startClockSyncDaemon() {
    this._every(CLOCK_SYNC_INTERVAL_MS, () => this.synchronizeClock(CLOCK_SYNC_ITERATIONS));
  }

  /** PingLoop: pingService.Ping() once the connection has been idle a minute. */
  _startPingLoop() {
    const configured = integer(dictGet(dictGet(this.loginResponse, "config_vals"), "maxConnectionIdleTimeSeconds"));
    const maxIdleMs = (configured ?? MAX_IDLE_SECONDS_DEFAULT) * 1000;
    if (maxIdleMs <= 0) return;
    const tick = () => {
      if (this.closed) return;
      const idle = this.now() - this.lastSentAt;
      let wait = maxIdleMs - idle;
      if (idle >= maxIdleMs) {
        this.proxyCall("pingService", "Ping").catch(() => {});
        wait = maxIdleMs;
      }
      this._later(wait, tick);
    };
    this._later(maxIdleMs, tick);
  }

  _later(delayMs, action) {
    const timer = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(timer);
      action();
    }, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    this.backgroundTimers.add(timer);
  }

  _every(intervalMs, action) {
    const tick = () => {
      if (this.closed) return;
      Promise.resolve().then(action).catch(() => {}).finally(() => this._later(intervalMs, tick));
    };
    this._later(intervalMs, tick);
  }

  // ── closing ────────────────────────────────────────────────────────────────

  /** Close the connection. The server logs the character off. */
  close() {
    this._onClosed(new GamePortError("CONNECTION_CLOSED", "The game connection closed."));
  }

  _fail(error) {
    this._onClosed(error);
    return error;
  }

  _onClosed(error) {
    if (this.closed) return;
    this.closed = true;
    this.sessionAttributeRevision++;
    this.closeReason = error;
    for (const timer of this.backgroundTimers) this.timers.clearTimeout(timer);
    this.backgroundTimers.clear();
    for (const waiter of this.handshakeWaiters.splice(0)) waiter.reject(error);
    for (const [, waiter] of this.pending) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.handshakeInbox = [];
    try {
      this.transport.close();
    } catch {
      // Already gone.
    }
    this._emit("close", error);
  }

  // ── frames ─────────────────────────────────────────────────────────────────

  _onFrame(payload) {
    if (this.closed) return;
    this.counters.received += 1;
    let data = payload;
    // machoNetTransport.Read: anything not starting '~' or '}' is zlib.
    if (data.length > 0 && data[0] !== 0x7e && data[0] !== 0x7d) {
      try {
        data = zlib.inflateSync(data);
        this.counters.compressedReceived += 1;
      } catch (error) {
        this._onClosed(new GamePortError("BAD_FRAME", `Decompression Failure: ${error.message}`));
        return;
      }
    }
    let value;
    try {
      value = decodeGamePort(data);
    } catch (error) {
      this._onClosed(new GamePortError("BAD_FRAME", `The game server sent a frame that does not decode: ${error.message}`));
      return;
    }
    const closedBy = readTransportClosed(value);
    if (closedBy) {
      this._onClosed(new GamePortError("TRANSPORT_CLOSED", `The game server closed the connection: ${closedBy.reasonCode ?? closedBy.reason}`, closedBy));
      return;
    }
    if (!this.loggedIn) {
      const waiter = this.handshakeWaiters.shift();
      if (waiter) waiter.resolve(value);
      else this.handshakeInbox.push(value);
      return;
    }
    this._dispatch(value);
  }

  _readRaw() {
    if (this.handshakeInbox.length > 0) return Promise.resolve(this.handshakeInbox.shift());
    if (this.closed) return Promise.reject(this.closeReason);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => { this.timers.clearTimeout(timer); resolve(value); },
        reject: (error) => { this.timers.clearTimeout(timer); reject(error); },
      };
      const timer = this.timers.setTimeout(() => {
        const index = this.handshakeWaiters.indexOf(waiter);
        if (index >= 0) this.handshakeWaiters.splice(index, 1);
        waiter.reject(new GamePortError("HANDSHAKE_TIMEOUT", "The game server stopped answering the handshake."));
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeWaiters.push(waiter);
    });
  }

  _writeRaw(value) {
    this._send(encodeClient(value));
  }

  _writePacket(packet) {
    this._emit("packet", parsePacket(packet), "out");
    let pickle = encodeClient(packet);
    // machoNetTransport.Write: compress a packet over the threshold, and keep
    // the compressed form only when it is smaller by more than five percent.
    if (pickle.length > COMPRESSION_THRESHOLD) {
      const compressed = zlib.deflateSync(pickle, { level: 1 });
      if (compressed.length <= pickle.length && (pickle.length - compressed.length) * 100 / pickle.length > 5) {
        pickle = compressed;
        this.counters.compressedSent += 1;
      }
    }
    this._send(pickle);
  }

  _send(payload) {
    if (this.closed) throw this.closeReason;
    this.counters.sent += 1;
    this.lastSentAt = this.now();
    this.transport.send(payload);
  }

  // ── packets from the server: machoNet's transport reader ───────────────────

  _dispatch(value) {
    const packet = parsePacket(value);
    if (!packet || packet.className === null) {
      this.counters.unknownPackets += 1;
      this._emit("packet", packet ?? { command: null, raw: value }, "in");
      return;
    }
    this._emit("packet", packet, "in");
    switch (packet.command) {
      case TYPE.CALL_RSP:
      case TYPE.ERROR_RESPONSE:
        this._settleCall(packet);
        return;
      case TYPE.PING_RSP:
        this._settleCall(packet);
        return;
      case TYPE.CALL_REQ:
        this._answerCall(value, packet);
        return;
      case TYPE.NOTIFICATION:
        this._emit("notification", readNotification(packet));
        return;
      case TYPE.SESSION_CHANGE:
        this._applySessionChange(packet.body[1]);
        return;
      case TYPE.SESSION_INITIAL_STATE:
        this._applyInitialState(packet.body[2]);
        return;
      case TYPE.PING_REQ: {
        // Add our turnaround time and send the times straight back.
        const stamp = { type: "long", value: BigInt(Math.round(this.serverNow())) * 10000n + FILETIME_EPOCH_OFFSET };
        const times = packet.body[0] && packet.body[0].type === "list" ? [...packet.body[0].items] : [];
        times.push([stamp, stamp, "client::turnaround"]);
        this._writePacket(buildPacket(TYPE.PING_RSP, {
          source: value.args[2],
          destination: value.args[1],
          userID: packet.userID,
          body: [{ type: "list", items: times }],
          journeyID: this.journeyID,
        }));
        return;
      }
      case TYPE.TRANSPORT_CLOSED:
        this._onClosed(new GamePortError("TRANSPORT_CLOSED", "Session terminated due to remote transport closed notification"));
        return;
      default:
        this.counters.unknownPackets += 1;
    }
  }

  _settleCall(packet) {
    const callID = packet.destination.callID;
    const waiter = callID === null || callID === undefined ? undefined : this.pending.get(Number(callID));
    if (!waiter) return;
    // machoNet._BlockingCall: an answer carrying `provisional` is not the
    // answer. It is (seconds, event, args): the caller goes on waiting, for that
    // long from now, and the event is raised in the client meanwhile. A server
    // sends one before it asks the player something (SendProvisionalResponse).
    const provisional = packet.command === TYPE.CALL_RSP ? dictGet(packet.oob, "provisional") : undefined;
    if (Array.isArray(provisional)) {
      const seconds = Number(integer(provisional[0]) ?? NaN);
      const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : this.callTimeoutMs;
      this._waitFor(Number(callID), waiter, Math.min(asked, this.provisionalWaitLimitMs, LONGEST_TIMER_MS));
      const event = text(provisional[1]);
      if (event !== null) {
        this._emit("notification", {
          method: event, idtype: null, narrowcast: null, service: null, args: provisional[2] ?? [], kwargs: null, packet, provisional: true,
        });
      }
      return;
    }
    this.pending.delete(Number(callID));
    this.timers.clearTimeout(waiter.timer);
    if (packet.command === TYPE.ERROR_RESPONSE) {
      // (originalCommand, code, payload)
      const detail = packet.body[2];
      const refusal = readRefusal(detail);
      const error = new GamePortError("GAME_CALL_REFUSED", `${waiter.label} was refused by the server: ${refusal?.reason || describeError(detail)}`, detail);
      // What the server refused with: {className, key, values, reason}.
      error.refusal = refusal;
      waiter.reject(error);
      return;
    }
    const source = packet.body[0], value = unwrapSubstream(source);
    if (waiter.resolveAddress) {
      // Preserve the actual primitive and its source numeric class before
      // unwrapping discards the substream parent. Shared callers see this same
      // address-cache record; no extra Resolve RPC or per-number interning.
      const kind = source?.type === "substream" ? getDecodedNumberKind(source, "value") : getDecodedNumberKind(packet.body, 0);
      this.nodeOfAddressRecords.set(waiter.resolveAddress, Object.freeze({ value, kind, source }));
    }
    waiter.resolve(value);
  }

  /**
   * A call the server makes to this client: a method of one of the client's
   * own services, by name (ServiceCallGPCS.CallUp, on the client's side of it).
   * The body is what we send for a call of ours, (0, pickle((1, method, args,
   * kw))), and the answer is what the server sends for one: the return value,
   * pickled, back where the call came from (machoNetPacket.Response swaps the
   * two addresses, so the server's call ID comes back as the destination's).
   *
   * A call nobody here answers is left unanswered and reported. The client
   * would answer it with the exception it raised; nothing is waiting on that
   * but the server's own patience.
   */
  _answerCall(raw, packet) {
    const head = packet.body[0];
    const inner = Array.isArray(head) && !head[0] ? unwrapSubstream(head[1]) : null;
    const call = {
      service: packet.destination.service ?? null,
      method: Array.isArray(inner) ? text(inner[1]) : null,
      args: Array.isArray(inner) ? inner[2] ?? [] : [],
      kwargs: Array.isArray(inner) ? inner[3] ?? null : null,
      // How long the server says it will wait for the answer (the packet's machoTimeout), when it says.
      timeoutSeconds: integer(dictGet(packet.oob, "machoTimeout")) ?? null,
    };
    // objectCaching's own two are the session's to act on, whoever answers the call: the cache is here.
    if (call.service === "objectCaching" && call.method === "InvalidateCachedMethodCall") {
      const [service, method, ...args] = itemsOfSequence(call.args);
      this.invalidateCachedMethodCalls([[service, method, args]]);
    } else if (call.service === "objectCaching" && call.method === "InvalidateCachedMethodCalls") {
      this.invalidateCachedMethodCalls(itemsOfSequence(itemsOfSequence(call.args)[0]).map(itemsOfSequence));
    }
    const report = (outcome) => this._emit("clientCall", { ...call, answered: false, answer: undefined, error: null, ...outcome });
    if (call.service === null || call.method === null || typeof this.clientCalls !== "function") {
      report({});
      return;
    }
    Promise.resolve()
      .then(() => this.clientCalls(call))
      .then((answer) => {
        if (answer === undefined) {
          report({});
          return;
        }
        this._writePacket(buildPacket(TYPE.CALL_RSP, {
          source: raw.args[2],
          destination: raw.args[1],
          userID: packet.userID,
          body: [{ type: "substream", value: answer }],
          journeyID: this.journeyID,
        }));
        report({ answered: true, answer });
      })
      .catch((error) => report({ error }));
  }

  /** change is (clueless, {attribute: (old, new)}). */
  _applySessionChange(change) {
    const changes = Array.isArray(change) ? change[1] : null;
    if (!changes || changes.type !== "dict") return;
    const applied = {};
    const records = [];
    this.sessionAttributeRevision++;
    for (const [name, pair] of changes.entries) {
      const key = text(name);
      if (key === null || !Array.isArray(pair)) continue;
      applied[key] = [pair[0], pair[1]];
      records.push(this._captureSessionAttribute(key, pair, 1, "change"));
      this.attributes[key] = pair[1];
    }
    this._emit("sessionAttributes", Object.freeze({ source: "change", revision: this.sessionAttributeRevision, records: Object.freeze(records) }));
    this._emit("sessionChange", applied, this.attributes);
  }

  _applyInitialState(initialState) {
    if (!initialState || initialState.type !== "dict") return;
    const applied = {};
    const records = [];
    this.sessionAttributeRevision++;
    for (const entry of initialState.entries) {
      const key = text(entry[0]), value = entry[1];
      if (key === null) continue;
      applied[key] = [this.attributes[key] ?? null, value];
      records.push(this._captureSessionAttribute(key, entry, 1, "initial"));
      this.attributes[key] = value;
    }
    this._emit("sessionAttributes", Object.freeze({ source: "initial", revision: this.sessionAttributeRevision, records: Object.freeze(records) }));
    this._emit("sessionChange", applied, this.attributes);
  }
}

module.exports = {
  CLOCK_SYNC_INTERVAL_MS, COMPRESSION_THRESHOLD, GamePortError, GamePortSession, KNOWN_HANDSHAKE_FUNCTIONS,
  MAX_IDLE_SECONDS_DEFAULT, RETAIL_CLIENT, describeError, readNotification,
};
