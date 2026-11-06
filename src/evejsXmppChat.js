"use strict";

// Retail chat rooms over XMPP — the transport the retail client itself uses.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// R7 chat used to be two gateway routes (`POST /_evejs-web/v1/chat/read` and
// `/chat/send`) backed by `gatewayServices/webChatGatewayService.js`. EveJS
// v0.12.8 deleted all three, and in the same drop marked every browser-backed
// session as having LEFT Local:
//
//     // Browser-backed sessions still participate in ordinary online, station,
//     // and space authority, but the companion no longer participates in Local
//     // or Corp chat.
//     session._localChatDeparted = true;      // evejsWebGatewayRuntime.js
//
// So the BFF's chat reads began 404ing every two seconds, `chatMessages` was
// permanently empty, and every chat-ordered bot behaviour (`follow`,
// `stop`, `target`, `salvage`, `loot`, `destination`) went silently dead.
//
// The chat itself did not go anywhere. `chatHub.js` says where it lives:
// "Local/corp/fleet chat runs over XMPP MUC (member roster + messages) and the
// protobuf local-chat gateway". The XMPP stub server
// (`services/chat/xmppStubServer.js`) is untouched, listens on 5222, and is the
// same door the game client comes through. This module is a small XMPP client
// that walks through it as the held session's own character.
//
// ⚠ THAT CHOICE IS THE POINT, NOT AN IMPLEMENTATION DETAIL. Restoring the
// deleted routes as a fork patch would work until the next vendor drop deletes
// them again — which is exactly what just happened. Speaking the protocol the
// retail client speaks depends on nothing this project can be denied.
//
// ─── THE FOUR FACTS THIS MODULE IS BUILT ON ─────────────────────────────────
//
// All four are the stub's own behaviour, read from its source and confirmed
// against a live server's `logs/xmpp-stub.log`:
//
//   1. SASL PLAIN is accepted WITHOUT CHECKING THE PASSWORD, and the JID's local
//      part IS the identity: `findSessionForClient` parses it as a character id
//      and looks up that character's live session (`xmppStubServer.js:546`).
//      ⚠ THEREFORE THIS MODULE MUST ONLY EVER CONNECT AS THE CHARACTER THE
//      HELD SESSION ALREADY OWNS. The caller passes that id; it must never come
//      from anything a browser sent. There is no credential to get wrong here,
//      which is precisely why the identity must be got right.
//
//   2. `local`, `corp` and `fleet` are ACCEPTED AS ROOM ALIASES and resolved
//      server-side from the session (`normalizeRoomJid`, `:389`). So this module
//      never computes a room name: it addresses `local@conference.<domain>` and
//      the server answers with the real room, which is what keeps wormhole,
//      Triglavian and no-local systems right without copying `channelRules.js`.
//
//   3. A MUC nick IS the sender's character id, filled in server-side from the
//      session (`handleGroupMessage`, `:2876`). That is the unspoofable key the
//      bot's chat-order gate needs — the same property the old backlog
//      read had, over a different transport.
//
//   4. Joining un-does the v0.12.8 departure by itself: the join path calls
//      `chatRuntime.joinLocalLsc(session)`, whose first act is
//      `markSessionLocalDeparted(session, false)` (`chatRuntime.js:1498`). The
//      companion is back in Local because it joined Local, not because anything
//      was patched.
//
// ⚠ AND THAT IS VISIBLE IN THE WORLD. A joined companion appears in other
// players' Local member list and its presence is broadcast to the room, exactly
// like any other pilot in the system. That is the honest state of affairs — the
// ship IS there — but it is a change other people can see, not an internal one.
//
// ─── WHAT THIS MODULE DOES NOT DO ───────────────────────────────────────────
//
// No reconnect storm, no queue, no offline buffer. A session that cannot reach
// the chat server reports that to its caller and the caller fails the read, so
// "chat is unreadable" stays distinguishable from "nobody said anything" — the
// distinction the 404s destroyed for two silent weeks.

const net = require("net");
const tls = require("tls");
const { withoutCategoryC } = require("./gamePort/py27");
const { PythonIntKeys } = require("./gamePort/pythonIntKeys");
const { isSpam, normalizeForSpam } = require("./gamePort/chatSpam");

class XmppChatError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "XmppChatError";
    this.code = options.code || "CHAT_TRANSPORT_ERROR";
    this.statusCode = options.statusCode || 502;
  }
}

const DEFAULT_XMPP_PORT = 5222;
const DEFAULT_XMPP_DOMAIN = "localhost";
// The resource the retail client binds is `eveclient`. This one is deliberately
// different: nothing keys on it, and a transcript that says which connection is
// the companion is worth more than a perfect impersonation.
const XMPP_RESOURCE = "evejs-web-companion";
// A pilot on the game port logs in as the retail client's chat service does (see
// `loginDetails`), and binds what that binds: `self.xmppConnection.Connect(
// self.myName, 'eveclient')` (xmppchatclient/xmppchatsvc.py 257).
const RETAIL_XMPP_RESOURCE = "eveclient";
// `_JoinSystemChannels` asks again every five seconds while the server names no
// channel (xmppchatsvc.py 347 to 352). The floor between two askings here.
const RESYNC_RETRY_MS = 5000;
// A channel's category is its name up to the first underscore
// (chatutil.GetChannelCategory, chatutil/__init__.py 257 to 258), and these
// categories are all Local to the client: one window, whichever the system has
// (xmppchatsvc.py 359 to 360; chatutil/const.py 14 to 22).
const LOCAL_CATEGORIES = new Set(["local", "nolocal", "wormhole", "nullsec", "triglavian"]);
// Local with nothing joined: for this category the client makes the window and
// sends no presence (xmppchatsvc.py 1050 to 1054).
const SUPPRESSED_LOCAL_CATEGORY = "nolocal";
// SESSION_CHANGE_CATEGORIES (xmppchatsvc.py 35 to 45): the values of the
// session a channel hangs on, each with its channel's category, in the client's
// own order. Here a category is also the word a page reads the channel by.
const SESSION_CHANGE_CATEGORIES = [
  ["solarsystemid2", "local"],
  ["allianceid", "alliance"],
  ["corpid", "corp"],
  ["fleetid", "fleet"],
  ["warfactionid", "faction"],
];
const SESSION_CHANNELS = new Set(SESSION_CHANGE_CATEGORIES.map(([, channel]) => channel));
// chatutil.TruncateVeryLongText (chatutil/__init__.py 11, 302 to 305): a line
// longer than this is cut five short of it and ends ' ...'.
const MAX_TEXT_LEN_SAFEGUARD = 2048;
const CONNECT_TIMEOUT_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 4000;
// How long a join is given to come back with its self-presence before a read
// gives up waiting and answers with whatever it has. A join is a round trip to
// a process on the same bridge network; this is generous.
const JOIN_TIMEOUT_MS = 2500;
const PING_INTERVAL_MS = 30_000;
// Per room. Local is chatty and the readers only ever want the tail: the Chat
// panel renders the last page and a bot filters by freshness.
const MAX_BUFFERED_MESSAGES = 200;
// A failed connect is not retried on the very next tick. A bot reads
// chat every two seconds, and a chat server that is down should cost one
// connect attempt every few seconds, not thirty.
const RECONNECT_COOLDOWN_MS = 5000;
// Corp rooms deliver backlog on join (Local does not — `handleJoinPresence`
// skips history for local rooms, matching retail, where Local has no history).
const CORP_HISTORY_SECONDS = 900;

function trimmedEnv(name) {
  return String(process.env[name] || "").trim();
}

/**
 * The chat server's host.
 *
 * Defaults to the gateway's own host because they are the same process: the
 * gateway URL is how this BFF is already told where EveJS lives (a container
 * DNS name under Docker, a loopback address natively), and the XMPP listener is
 * a second port on it. `EVEJS_XMPP_HOST` overrides for the split case.
 */
function xmppHost() {
  const explicit = trimmedEnv("EVEJS_XMPP_HOST");
  if (explicit) {
    return explicit;
  }
  const gatewayUrl = trimmedEnv("EVEJS_GATEWAY_URL");
  if (gatewayUrl) {
    try {
      return new URL(gatewayUrl).hostname || "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }
  return "127.0.0.1";
}

function xmppPort() {
  const configured = Number(trimmedEnv("EVEJS_XMPP_PORT"));
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_XMPP_PORT;
}

/**
 * The XMPP domain and the conference (MUC) domain.
 *
 * ⚠ THESE MUST MATCH THE SERVER'S `config/server.json` `xmpp` BLOCK, because
 * the stub compares conference JIDs against its own configured domain
 * (`isXmppConferenceJid`). The defaults here are that file's defaults
 * (`xmppDomain: "localhost"`, and an empty `xmppConferenceDomain` meaning
 * `conference.<xmppDomain>`), so a stock server needs no configuration at all.
 */
function xmppDomain() {
  return trimmedEnv("EVEJS_XMPP_DOMAIN") || DEFAULT_XMPP_DOMAIN;
}

function xmppConferenceDomain() {
  return trimmedEnv("EVEJS_XMPP_CONFERENCE_DOMAIN") || `conference.${xmppDomain()}`;
}

/**
 * Open the socket the chat edge is actually listening on.
 *
 * ⚠ IT IS TLS, AND NOT STARTTLS. `edge/chat/chatEdgeProcess.worker.js` builds
 * the listener with `tls.createServer({...readXmppTlsCredentials(), minVersion:
 * "TLSv1"})` and the boot log calls it `tls://<host>:<port>`, so the very first
 * byte on the wire is a ClientHello — a plaintext stream header gets the
 * connection dropped with nothing sent back and nothing written to
 * `logs/xmpp-stub.log`, because the edge never hands the socket to the stub at
 * all. (That is exactly how this was found: a plaintext probe against the live
 * server closed silently while the game client's own traffic kept flowing.)
 *
 * ⚠ THE CERTIFICATE IS NOT VERIFIED, DELIBERATELY. It is the server's own
 * locally generated credential (`edge/chat/xmppTlsCredentials.js`) for a
 * listener reached over loopback or the compose bridge, and there is no CA in
 * this picture to check it against — the retail client accepts the same
 * credential. `EVEJS_XMPP_TLS_REJECT_UNAUTHORIZED=1` turns verification on for a
 * deployment that has put a real certificate there.
 *
 * `EVEJS_XMPP_TLS=0` drops to a plain TCP socket. That exists for the tests
 * (whose fake stub would otherwise need a certificate fixture to maintain) and
 * for a server old enough to predate the TLS edge; the framing above it is
 * identical either way.
 */
function connectChatSocket(host, port, onReady, domain = xmppDomain()) {
  if (trimmedEnv("EVEJS_XMPP_TLS") === "0") {
    return net.createConnection({ host, port }, onReady);
  }
  return tls.connect(
    {
      host,
      port,
      servername: domain,
      rejectUnauthorized: trimmedEnv("EVEJS_XMPP_TLS_REJECT_UNAUTHORIZED") === "1",
    },
    onReady,
  );
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The host to dial for a pilot logged in the retail client's way, given the
 * address the game server named for its chat server.
 *
 * The retail client dials that address as it stands. This BFF may reach the
 * server by another road than a client beside it does — from inside a
 * container the server's "localhost" is the container — so an address that
 * says "this machine" means the machine the server is on, which is the host
 * this BFF already reaches it by (`xmppHost`). `EVEJS_XMPP_HOST` overrides
 * either way, as it always has.
 */
function dialHostFor(address) {
  const explicit = trimmedEnv("EVEJS_XMPP_HOST");
  if (explicit) {
    return explicit;
  }
  const named = String(address || "").trim();
  if (!named || LOOPBACK_NAMES.has(named.toLowerCase())) {
    return xmppHost();
  }
  return named;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(xml, name) {
  const match = new RegExp(`\\b${name}=['"]([^'"]*)['"]`, "i").exec(xml);
  return match ? decodeXml(match[1]) : "";
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The next complete stanza in `buffer`, or null.
 *
 * ⚠ DELIBERATELY THE SAME SHAPE AS THE SERVER'S OWN SPLITTER
 * (`extractNextReadyStanza`): earliest match wins, and everything before it is
 * dropped. Both ends of this connection are generated by hand rather than by an
 * XML library, so tolerating a frame nobody can parse — by skipping it — beats
 * stalling the stream on it.
 *
 * ⚠ SELF-CLOSING IS TESTED ON THE OPENING TAG ALONE. The server's presence
 * frames carry `<item ... />` children, so a pattern that accepted the first
 * `/>` it found would cut a presence in half and lose its MUC payload.
 */
function nextStanza(buffer) {
  let best = null;
  for (const name of ["message", "presence", "iq", "success", "failure"]) {
    const open = new RegExp(`<${name}\\b[^>]*>`, "i").exec(buffer);
    if (!open) {
      continue;
    }
    const selfClosing = open[0].endsWith("/>");
    let xml = null;
    if (selfClosing) {
      xml = open[0];
    } else {
      const close = buffer.indexOf(`</${name}>`, open.index + open[0].length);
      if (close === -1) {
        continue;
      }
      xml = buffer.slice(open.index, close + name.length + 3);
    }
    if (!best || open.index < best.index) {
      best = { index: open.index, xml };
    }
  }
  return best;
}

/**
 * One character's chat connection: the socket, the rooms it has joined, and the
 * tail of what was said in them.
 *
 * One of these belongs to one held bridge session and lives as long as it does.
 * It is opened lazily — a session nobody reads chat for never connects, and so
 * never appears in Local.
 */
class XmppChatSession {
  constructor(options = {}) {
    this.characterID = positiveInt(options.characterID);
    if (!this.characterID) {
      throw new XmppChatError("A chat session needs the held character id.", {
        code: "CHAT_NO_CHARACTER",
        statusCode: 500,
      });
    }
    this.log = typeof options.log === "function" ? options.log : () => {};
    // What the game server is asked as the retail client's chat service asks
    // it at its login: `{ connection(), secret(), channels() }`, each a call
    // made through the pilot's own game-port session. Null for a pilot on the
    // gateway, which has no such session to ask: see `loginDetails`.
    this.login = options.login && typeof options.login === "object" ? options.login : null;
    this.domain = xmppDomain();
    this.conferenceDomain = xmppConferenceDomain();
    this.resource = XMPP_RESOURCE;
    this.systemChannelsAskedAtMs = 0;
    this.systemChannelsWork = null;
    // The retail client's own stanzas (see `retailStanzas`): the JID the
    // server bound this connection to, and the count its request ids run on.
    this.boundJid = null;
    this.requestCounter = 0;
    // Whether this connection's system channels have had their login's two
    // joins, and the second joins still waiting for the server's answer.
    this.systemChannelsJoinedOnce = false;
    this.joinEchoes = new Map();
    // The session's channels this connection has been in, by category and the
    // value of the session each hung on ("local:30000142" -> the room's JID):
    // what a change of the session leaves (`onSessionChanged`). And the rooms
    // left at a change, which a late presence from one must not bring back.
    this.sessionRooms = new Map();
    this.leftRooms = new Set();
    // What the game server answered the chat's login (`loginDetails`), kept.
    this.loginAsked = null;
    // The client's windows' own check of a quiet channel (`watchChannel`): how
    // long a channel may be quiet, when each channel last had anything in it,
    // and each channel's waiting check.
    this.idleSeconds = 180;
    this.activityAtMs = new Map();
    this.idleChecks = new Map();
    // The lines that came in, kept one after another once each has passed
    // the spam check (`onMessage`).
    this.linesWork = Promise.resolve();
    this.stopHearingSession =
      this.login && typeof this.login.onSessionChange === "function"
        ? this.login.onSessionChange((changes) => this.onSessionChanged(changes))
        : null;
    this.socket = null;
    this.buffer = "";
    this.ready = false;
    this.readyPromise = null;
    this.closed = false;
    this.lastConnectFailureAtMs = 0;
    this.lastConnectError = null;
    this.pingTimer = null;
    this.stanzaCounter = 0;
    // channel -> { roomJid, roomName, joinedAtMs, joinedFor, pending }
    this.rooms = new Map();
    // roomName -> Map(characterID -> { name, corporationID, allianceID })
    this.rosters = new Map();
    this.memberOrder = new Map();
    // roomName -> [{ characterID, characterName, message, createdAtMs }]
    this.messages = new Map();
    this.invitations = new Map();
    this.declines = [];
    this.controlCounter = 0;
    this.infoRequests = new Map();
  }

  nextID(prefix) {
    this.stanzaCounter += 1;
    return `${prefix}-${this.stanzaCounter}`;
  }

  jid() {
    return `${this.characterID}@${this.domain}/${this.resource}`;
  }

  /**
   * The stanzas a pilot on the game port sends, each as the retail client's
   * XMPP handler writes it (xmpp/xmpphandler.py), attribute for attribute and
   * in its order, so that the chat server reads from this connection what it
   * reads from a client's. The line numbers are that file's.
   *
   * A pilot on the gateway sends this module's own stanzas, as it always has:
   * each writer below asks `this.login` which.
   */
  retailStanzas() {
    // connect (41 to 49): the name is `<charID>@<hostname>`, and is the JID
    // until the bind answers one.
    const username = `${this.characterID}@${this.domain}`;
    // Read at each use: the bind's answer changes it between two requests of
    // one login (handle_bind, 75 to 85).
    const jid = () => this.boundJid || username;
    const nick = this.characterID;
    // get_request_id (320 to 323): 'id1', 'id2' and on, from one at each
    // connection, and one count for requests, joins, leaves and lines alike.
    const requestID = () => {
      this.requestCounter += 1;
      return `id${this.requestCounter}`;
    };
    // issue_request (283 to 294). With no `to`, the client's own text has a
    // space before the closing bracket.
    const request = (type, payload) => `<iq id='${requestID()}' type='${type}' from='${escapeXml(jid())}' >${payload}</iq>`;
    return {
      // start_stream (51 to 58).
      stream: () =>
        `<?xml version='1.0'?><stream:stream to='${escapeXml(this.domain)}' version='1.0' ` +
        "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>",
      // bind (70 to 73).
      bind: () =>
        request(
          "set",
          `<bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>${escapeXml(this.resource)}</resource></bind>`,
        ),
      // start_session (87 to 90).
      session: () => request("set", "<session xmlns='urn:ietf:params:xml:ns:xmpp-session'/>"),
      // send_initial_presence (97 to 101).
      firstPresence: () => "<presence><show/></presence>",
      // join_room (296 to 310): password first, then optional history. System
      // rooms use neither; an invited player room may carry a password. Quiet
      // windows request history on reconnect (xmppchatwindow.py 1360).
      join: (roomJid, historySeconds = 0, password = "") => {
        const id = requestID();
        const history = historySeconds > 0 ? `<history seconds='${Math.trunc(historySeconds)}'/>` : "";
        const safePassword = withoutCategoryC(String(password)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const secret = password ? `<password>${safePassword}</password>` : "";
        return {
          id,
          xml:
            `<presence from='${escapeXml(jid())}' id='${id}' to='${escapeXml(roomJid)}/${nick}'>` +
            `<x xmlns='http://jabber.org/protocol/muc'>${secret}${history}</x></presence>`,
        };
      },
      // leave_room (312 to 318).
      leave: (roomJid) =>
        `<presence from='${escapeXml(jid())}' id='${requestID()}' to='${escapeXml(roomJid)}/${nick}' type='unavailable'/>`,
      // groupchat (110 to 116), with the line as sanitize_text leaves it (118
      // to 120): the characters of the control categories taken out, and the
      // three that xml.sax.saxutils.escape replaces replaced.
      line: (roomJid, text) => {
        const id = requestID();
        const body = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return {
          id,
          xml:
            `<message from='${escapeXml(username)}' to='${escapeXml(roomJid)}' type='groupchat' xml:lang='en' id='${id}'>` +
            `<body>${body}</body></message>`,
        };
      },
      // xmppConnection.py 297-306: mediated control stanzas use the bare JID.
      invite: (roomJid, target, reason) =>
        `<message from='${escapeXml(username)}' to='${escapeXml(roomJid)}'><x xmlns='http://jabber.org/protocol/muc#user'><invite to='${target}@${escapeXml(this.domain)}'><reason>${escapeXml(reason)}</reason></invite></x></message>`,
      decline: (roomJid, target, reason) =>
        `<message from='${escapeXml(username)}' to='${escapeXml(roomJid)}'><x xmlns='http://jabber.org/protocol/muc#user'><decline to='${target}@${escapeXml(this.domain)}'><reason>${escapeXml(reason)}</reason></decline></x></message>`,
      // GetDisplayName: private room target, player conference target + node.
      // xmpphandler.issue_request (283-294) owns the shared request counter.
      roomInfo: (roomName) => {
        const id = requestID();
        const player = roomName.startsWith("player_");
        const target = player ? this.conferenceDomain : `${roomName}@${this.conferenceDomain}`;
        const query = player
          ? `<query xmlns='http://jabber.org/protocol/disco#info' node='${escapeXml(roomName)}'/>`
          : "<query xmlns='http://jabber.org/protocol/disco#info'/>";
        return { id, xml: `<iq id='${id}' type='get' from='${escapeXml(jid())}' to='${escapeXml(target)}'>${query}</iq>` };
      },
      // _handle_ping (168 to 175): the server's ping answered, its `to` for
      // this answer's `from` and its `from` for the `to`.
      pong: (id, to, from) => `<iq id='${escapeXml(id)}' type='result' from='${escapeXml(to)}' to='${escapeXml(from)}'/>`,
    };
  }

  aliasJid(channel) {
    return `${channel}@${this.conferenceDomain}/${this.characterID}`;
  }

  /**
   * Where to connect, on what domain, and with what secret.
   *
   * A pilot on the gateway comes in as this module always has: the host and
   * the domain from this BFF's own environment, no secret, a resource of its
   * own, and rooms by the stub's aliases.
   *
   * A pilot on the game port logs in as the retail client's chat service does
   * (xmppchatclient/xmppchatsvc.py 247 to 325): the chat's hostname and the
   * server's address are asked of the game server, every JID is built on that
   * hostname (1190 to 1195; xmpp/xmpphandler.py 55), the resource is
   * `eveclient` (257), and the secret is asked once the socket is up
   * (xmpp/xmppConnection.py 423). The stanzas themselves are still this
   * module's: they are set beside the client's in a later step.
   */
  async loginDetails() {
    const port = xmppPort();
    if (!this.login) {
      this.domain = xmppDomain();
      this.conferenceDomain = xmppConferenceDomain();
      this.resource = XMPP_RESOURCE;
      return { host: xmppHost(), port, domain: this.domain, secret: async () => "" };
    }
    // Asked once, and kept as long as this chat session lasts: the client's
    // connection object keeps its hostname and its address from the login on,
    // and a reconnect goes to the same (xmpp/xmppConnection.py 426 to 448;
    // `_CreateConnection` is the login's alone, xmppchatsvc.py 247 to 248).
    let asked = this.loginAsked;
    if (!asked) {
      try {
        asked = await this.login.connection();
      } catch (error) {
        throw new XmppChatError(
          `The game server could not be asked for the chat's login: ${error.message}`,
          { code: "CHAT_LOGIN_UNAVAILABLE" },
        );
      }
    }
    const hostname = String((asked && asked.hostname) || "").trim();
    if (!hostname) {
      throw new XmppChatError("The game server named no chat hostname.", {
        code: "CHAT_LOGIN_UNAVAILABLE",
      });
    }
    this.loginAsked = asked;
    // GetMaxChatChannelIdleTime: the global config's, 180 where it has none
    // and 0 where it is not a number (globalConfig/getFunctions.py 88 to 89).
    this.idleSeconds = Number.isFinite(asked.idleSeconds) ? Number(asked.idleSeconds) : 180;
    this.domain = hostname;
    // GetFullRoomName: '{0}@conference.{1}'.format(channelName, self.hostname).
    this.conferenceDomain = `conference.${hostname}`;
    this.resource = RETAIL_XMPP_RESOURCE;
    return {
      host: dialHostFor(asked.address),
      port,
      domain: hostname,
      secret: () => this.login.secret(),
    };
  }

  write(xml) {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    this.socket.write(xml);
    return true;
  }

  /**
   * Connect, authenticate, bind, and come up ready — or reject.
   *
   * Concurrent callers share one attempt: a bot's tick and the Chat
   * panel's poll can land in the same millisecond, and two half-open
   * handshakes as the same character would leave a ghost in the room list.
   */
  ensureReady() {
    if (this.closed) {
      return Promise.reject(
        new XmppChatError("This chat session has been released.", {
          code: "CHAT_SESSION_CLOSED",
          statusCode: 409,
        }),
      );
    }
    if (this.ready) {
      return Promise.resolve(this);
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    const sinceFailureMs = Date.now() - this.lastConnectFailureAtMs;
    if (this.lastConnectFailureAtMs > 0 && sinceFailureMs < RECONNECT_COOLDOWN_MS) {
      // ⚠ THE LAST ERROR, NOT A NEW GENERIC ONE. A caller that is told "chat is
      // not reachable" every two seconds should be told WHY the one attempt
      // that ran actually failed.
      return Promise.reject(
        this.lastConnectError ||
          new XmppChatError("The chat server is not reachable.", {
            code: "CHAT_TRANSPORT_UNAVAILABLE",
          }),
      );
    }
    this.readyPromise = this.handshake()
      .then((session) => {
        this.readyPromise = null;
        this.lastConnectFailureAtMs = 0;
        this.lastConnectError = null;
        return session;
      })
      .catch((error) => {
        this.readyPromise = null;
        this.lastConnectFailureAtMs = Date.now();
        this.lastConnectError = error;
        this.teardownSocket();
        throw error;
      });
    return this.readyPromise;
  }

  async handshake() {
    return this.handshakeWith(await this.loginDetails());
  }

  handshakeWith({ host, port, domain, secret }) {
    // A new connection is a new handler to the client: no JID bound yet, and
    // its request ids from one again.
    this.boundJid = null;
    this.requestCounter = 0;
    this.systemChannelsJoinedOnce = false;
    this.joinEchoes.clear();
    const retail = this.login ? this.retailStanzas() : null;
    const streamHeader = () =>
      (retail
        ? retail.stream()
        : `<?xml version='1.0'?><stream:stream to='${escapeXml(domain)}' ` +
          "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
    return new Promise((resolve, reject) => {
      let stage = "connect";
      let settled = false;
      let password = "";
      // ⚠ THE READY CALLBACK, NOT A `connect` LISTENER. On a TLS socket the
      // stream is not usable until `secureConnect`, and `connect` fires before
      // the handshake — a stream header written there goes out before the
      // cipher is up. Both connectors take this callback and fire it on their
      // own ready event, which is the one line that keeps the plain and TLS
      // paths identical above the socket.
      // The secret is read once the socket is up and before the stream is
      // opened, as the client's connection reads its password. A pilot on the
      // gateway has none to read.
      const socket = connectChatSocket(host, port, () => {
        stage = "secret";
        Promise.resolve()
          .then(secret)
          .then(
            (word) => {
              if (settled) {
                return;
              }
              password = String(word ?? "");
              stage = "stream";
              this.write(streamHeader());
            },
            (error) => {
              fail(
                "CHAT_LOGIN_UNAVAILABLE",
                `The game server could not be asked for the chat's secret: ${error.message}`,
              );
            },
          );
      }, domain);
      this.socket = socket;
      this.buffer = "";
      socket.setKeepAlive(true, 15_000);
      socket.setEncoding("utf8");

      const fail = (code, message) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new XmppChatError(message, { code }));
      };

      const timer = setTimeout(() => {
        fail(
          "CHAT_TRANSPORT_TIMEOUT",
          `The chat server at ${host}:${port} did not finish the handshake (stage ${stage}).`,
        );
      }, CONNECT_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS);

      // ⚠ ONLY THE CURRENT SOCKET MAY TEAR THIS SESSION DOWN. A dropped socket
      // emits `error` AND then `close`, and a reconnect can have happened in
      // between — a second, late event from the dead socket would otherwise
      // clear `ready` and the room list belonging to the live one, leaving a
      // session that is connected and joined but believes it is neither.
      const goneIfCurrent = () => {
        if (this.socket === socket) {
          this.onSocketGone();
        }
      };
      socket.on("error", (error) => {
        fail(
          "CHAT_TRANSPORT_UNAVAILABLE",
          `The chat server at ${host}:${port} is not reachable: ${error.message}`,
        );
        goneIfCurrent();
      });
      socket.on("close", () => {
        fail(
          "CHAT_TRANSPORT_UNAVAILABLE",
          `The chat server at ${host}:${port} closed the connection during the handshake.`,
        );
        goneIfCurrent();
      });

      socket.on("data", (chunk) => {
        this.buffer += chunk;
        if (settled) {
          this.drain();
          return;
        }
        // ⚠ ONE HANDSHAKE STEP PER REPLY, NEVER PIPELINED. The stub clears its
        // own read buffer at each stage (`client.buffer = ""`), so a client that
        // sent the next step before the previous reply arrived would have that
        // step thrown away and hang.
        if (stage === "stream" && this.buffer.includes("</stream:features>")) {
          if (!/PLAIN/i.test(this.buffer)) {
            fail("CHAT_TRANSPORT_REFUSED", "The chat server did not offer SASL PLAIN.");
            return;
          }
          this.buffer = "";
          stage = "auth";
          // ⚠ AN EMPTY PASSWORD FOR A PILOT ON THE GATEWAY, ON PURPOSE.
          // `parsePlainAuth` reads the authorization identity and ignores the
          // secret entirely — the JID's local part is the whole of the
          // identity. Sending a made-up secret would imply a check that does
          // not exist; the real protection is that `characterID` comes from the
          // held session and from nowhere else. A pilot on the game port sends
          // what the retail client sends: the token the game server gave it,
          // or the word the client falls back on (`loginDetails`).
          const payload = Buffer.from(
            `\u0000${this.characterID}\u0000${password}`,
            "utf8",
          ).toString("base64");
          this.write(
            `<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${payload}</auth>`,
          );
          return;
        }
        if (stage === "auth" && this.buffer.includes("<success")) {
          this.buffer = "";
          stage = "stream2";
          this.write(streamHeader());
          return;
        }
        if (stage === "auth" && this.buffer.includes("<failure")) {
          fail("CHAT_TRANSPORT_REFUSED", "The chat server refused the SASL exchange.");
          return;
        }
        if (stage === "stream2" && this.buffer.includes("</stream:features>")) {
          this.buffer = "";
          stage = "bind";
          this.write(
            retail
              ? retail.bind()
              : `<iq type='set' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>` +
                `<resource>${escapeXml(this.resource)}</resource></bind></iq>`,
          );
          return;
        }
        if (stage === "bind" && this.buffer.includes("</bind>")) {
          // handle_bind (75 to 85): the JID the server bound is the client's
          // from here on.
          const bound = /<jid>([^<]*)<\/jid>/i.exec(this.buffer);
          this.boundJid = bound ? decodeXml(bound[1]) : null;
          this.buffer = "";
          stage = "session";
          this.write(
            retail
              ? retail.session()
              : "<iq type='set' id='sess'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>",
          );
          return;
        }
        if (retail && stage === "session" && /<iq[^>]*type=['"]result['"]/i.test(this.buffer)) {
          // handle_session (92 to 95): the first presence goes out, and the
          // client holds itself logged in at the next thing the server sends
          // (handle_response_state_not_ready, 242 to 245). The stub answers
          // that presence with one of its own.
          this.buffer = "";
          stage = "presence";
          this.write(retail.firstPresence());
          return;
        }
        const loggedIn = retail
          ? stage === "presence" && this.buffer.length > 0
          : stage === "session" && /<iq[^>]*type=['"]result['"]/i.test(this.buffer);
        if (loggedIn) {
          // A pilot on the gateway drops the session's answer; what a pilot on
          // the game port was just sent is a stanza like any other, and is
          // read as one once this connection is ready.
          if (!retail) {
            this.buffer = "";
          }
          stage = "ready";
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          // The client sends no ping of its own: it answers the server's
          // (`drain`). A pilot on the gateway keeps this module's.
          if (!retail) {
            this.startPing();
          }
          this.log(
            `[chat] connected to ${host}:${port} as character ${this.characterID}`,
          );
          resolve(this);
          if (retail) {
            this.drain();
          }
        }
      });
    });
  }

  startPing() {
    this.stopPing();
    // `handleReadyIq` answers `urn:xmpp:ping` with a result, so this is a real
    // round trip rather than a write into a socket that may already be dead.
    this.pingTimer = setInterval(() => {
      this.write(
        `<iq type='get' id='${this.nextID("ping")}' to='${escapeXml(this.domain)}'>` +
          "<ping xmlns='urn:xmpp:ping'/></iq>",
      );
    }, PING_INTERVAL_MS);
    if (typeof this.pingTimer.unref === "function") {
      this.pingTimer.unref();
    }
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  onSocketGone() {
    this.rejectRoomInfoRequests();
    // A connection that was up and is lost is made again no sooner than five
    // seconds on, for a pilot logged in the retail client's way: the client
    // waits that long before it connects again (xmpp/xmppConnection.py 450 to
    // 465), and as long again after each try that fails (426 to 448).
    if (this.login && this.ready && !this.closed) {
      this.lastConnectFailureAtMs = Date.now();
      this.lastConnectError = new XmppChatError("The chat connection was lost.", {
        code: "CHAT_TRANSPORT_UNAVAILABLE",
      });
    }
    this.ready = false;
    this.stopPing();
    this.stopWatchingChannels();
    // ⚠ THE ROOMS GO WITH THE SOCKET. MUC membership is per connection, so a
    // reconnect has to join again — remembering a room jid across a dropped
    // socket would leave a session that believes it is listening to a room the
    // server has already forgotten it left.
    for (const room of this.rooms.values()) {
      if (!room.pending) {
        continue;
      }
      const pending = room.pending;
      room.pending = null;
      pending.reject(
        new XmppChatError("The chat connection dropped before the join completed.", {
          code: "CHAT_TRANSPORT_UNAVAILABLE",
        }),
      );
    }
    this.rooms.clear();
    this.sessionRooms.clear();
    this.leftRooms.clear();
    this.systemChannelsAskedAtMs = 0;
  }

  teardownSocket() {
    this.rejectRoomInfoRequests();
    this.stopPing();
    this.stopWatchingChannels();
    this.ready = false;
    this.rooms.clear();
    this.sessionRooms.clear();
    this.leftRooms.clear();
    this.systemChannelsAskedAtMs = 0;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  drain() {
    while (true) {
      const stanza = nextStanza(this.buffer);
      if (!stanza) {
        break;
      }
      this.buffer = this.buffer.slice(stanza.index + stanza.xml.length);
      const xml = stanza.xml;
      if (/^<presence\b/i.test(xml)) {
        this.onPresence(xml);
      } else if (/^<message\b/i.test(xml)) {
        this.onMessage(xml);
      } else if (/^<iq\b[^>]*\btype=['"](?:result|error)['"]/i.test(xml)) {
        this.takeRoomInfo(xml);
      } else if (this.login && /^<iq\b[^>]*\btype=['"]get['"]/i.test(xml) && /<ping\b/i.test(xml)) {
        // process_single_queue_item (148 to 166): an iq of type get whose
        // child is a ping is answered, as the client answers it.
        this.write(this.retailStanzas().pong(attr(xml, "id"), attr(xml, "to"), attr(xml, "from")));
      }
      // Other IQ results (bind/session/ping) have no pending room-info reader.
    }
  }

  /**
   * A room occupant arrived, left, or was announced when we joined.
   *
   * The MUC nick is the character id (fact 3), and `<eve_user_data info=...>`
   * carries the same `[charID, name, typeID, gender, ownerNameID]` tuple the
   * retail client reads names from — so the roster this builds is the server's
   * own answer, not a guess assembled from message senders.
   */
  onPresence(xml) {
    const from = attr(xml, "from");
    const slash = from.indexOf("/");
    if (slash === -1) {
      return;
    }
    const roomJid = from.slice(0, slash);
    const nick = from.slice(slash + 1);
    const characterID = positiveInt(nick);
    const roomName = roomJid.split("@")[0];
    if (!roomName) {
      return;
    }
    // Our own join answer names the room the server RESOLVED our alias to.
    // That is the only way this client ever learns a real room name.
    this.resolveJoin(attr(xml, "id"), roomJid, roomName);
    if (!characterID) {
      return;
    }
    if (this.login) {
      // A character come into a channel or gone from it is the window's
      // activity (xmppchatclient/xmppchatwindow.py 485 to 488, 570 to 571).
      this.activityAtMs.set(this.channelOf(roomName), Date.now());
      if (!/\btype=['"](unavailable|leave)['"]/i.test(xml)) {
        this.takeSessionChannel(roomJid, roomName, characterID);
      }
    }
    if (!this.rosters.has(roomName)) {
      this.rosters.set(roomName, new Map());
      this.memberOrder.set(roomName, new PythonIntKeys());
    }
    const roster = this.rosters.get(roomName);
    const heldRoom = this.rooms.get(this.channelOf(roomName));
    if (roomName.startsWith("private_") && heldRoom?.seenMembers) heldRoom.seenMembers.add(characterID);
    if (/\btype=['"](?:unavailable|leave)['"]/i.test(xml)) {
      roster.delete(characterID);
      this.memberOrder.get(roomName)?.delete(characterID);
      return;
    }
    let name = "";
    const info = attr(xml, "info");
    if (info) {
      try {
        const parsed = JSON.parse(info);
        if (Array.isArray(parsed) && typeof parsed[1] === "string") {
          name = parsed[1];
        }
      } catch {
        // A name we cannot read is not a reason to drop an occupant; the id is
        // the part every caller keys on.
      }
    }
    this.memberOrder.get(roomName)?.set(characterID);
    roster.set(characterID, {
      name: name || `Character ${characterID}`,
      corporationID: positiveInt(attr(xml, "corpid")) || null,
      allianceID: positiveInt(attr(xml, "allianceid")) || null,
    });
  }

  /**
   * Somebody spoke.
   *
   * ⚠ THE ARRIVAL TIME IS THE TIMESTAMP, AND IT IS HONEST. The stub sends no
   * `<delay>`, so there is no server clock on the wire to read. Live delivery is
   * immediate, which makes arrival time accurate to the millisecond for every
   * line said while this session was listening — and a bot's freshness
   * window is the only consumer that cares.
   *
   * Local has no join history at all (`handleJoinPresence` delivers backlog only
   * for non-local rooms, matching retail), so for the channel the chat orders
   * live on there is no older-than-we-know case to mis-stamp. A corp room does
   * replay its backlog on join, and those lines land stamped with the join
   * instant — which is why a bot reads Local and not Corp.
   */
  onMessage(xml) {
    const from = attr(xml, "from");
    if (this.login && (this.takeDecline(from, xml) || this.takeInvite(from, xml))) {
      return;
    }
    const slash = from.indexOf("/");
    if (slash === -1) {
      return;
    }
    const roomJid = from.slice(0, slash);
    const nick = from.slice(slash + 1);
    const roomName = roomJid.split("@")[0];
    const bodyMatch = /<body>([\s\S]*?)<\/body>/i.exec(xml);
    if (!roomName || !bodyMatch) {
      return;
    }
    const body = decodeXml(bodyMatch[1]);
    let characterID = positiveInt(nick);
    let text = body;
    if (!characterID && nick === "admin") {
      // The room's own voice: MOTD, join notices, refusals. It arrives as a
      // JSON admin command rather than as prose.
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        return;
      }
      if (!payload || payload.cmd !== "speak") {
        return;
      }
      characterID = positiveInt(payload.charid) || 1;
      text = String(payload.messageText || "");
    }
    if (!text || !characterID) {
      // ⚠ NO SPEAKER, NO MESSAGE. Every line the stub sends carries either a
      // character id or the `admin` voice as its nick, so this cannot happen
      // against a server behaving as read — and if it ever does, an entry
      // attributed to "Character 0" would be this client inventing a speaker
      // for a line whose sender it could not read. The order gate keys on that
      // id; it must never be filled in with a guess.
      return;
    }
    const roster = this.rosters.get(roomName);
    const known = roster ? roster.get(characterID) : null;
    const entry = {
      characterID,
      characterName: known ? known.name : `Character ${characterID}`,
      message: text,
      createdAtMs: Date.now(),
    };
    if (!this.login) {
      this.keepLine(roomName, entry);
      return;
    }
    // A line put out in a window is its activity, and then the window drops
    // it where it is spam, whoever said it (xmppchatwindow.py 353 to 359).
    // The lines are kept in the order they came, each once what is banned in
    // chat is known: the first line waits on the game server's answer, as the
    // client's window waits on it.
    this.activityAtMs.set(this.channelOf(roomName), Date.now());
    this.linesWork = this.linesWork
      .then(() => this.taboosKnown())
      .then((taboos) => {
        if (!isSpam(text, taboos)) {
          this.keepLine(roomName, entry);
        }
      })
      .catch(() => {});
  }

  /** Keep a line at the tail of its room's, and no more of them than the tail is long. */
  keepLine(roomName, entry) {
    if (!this.messages.has(roomName)) {
      this.messages.set(roomName, []);
    }
    const log = this.messages.get(roomName);
    log.push(entry);
    if (log.length > MAX_BUFFERED_MESSAGES) {
      log.splice(0, log.length - MAX_BUFFERED_MESSAGES);
    }
  }

  /**
   * What is banned in chat, each domain as the spam check spells it
   * (chatutil.spam.GetTaboos, chatutil/spam.py 21 to 24). The game server is
   * asked through the pilot's game-port session, which keeps the answer as
   * long as the client's memo does; a server that cannot be asked bans
   * nothing, as the client's sites service has no list where its asking
   * fails (carbonui/control/browser/sites.py 410 to 412).
   */
  taboosKnown() {
    if (!this.login || typeof this.login.taboos !== "function") {
      return Promise.resolve([]);
    }
    return Promise.resolve()
      .then(() => this.login.taboos())
      .then(
        (banned) => (Array.isArray(banned) ? banned : []).map((domain) => normalizeForSpam(domain)),
        () => [],
      );
  }

  /**
   * Match a self-presence to the join that asked for it, BY STANZA ID.
   *
   * ⚠ THE ID IS THE ONLY HONEST CORRELATION. `handleJoinPresence` echoes the
   * join presence's own `id` back on the self-presence it answers with, while
   * every other presence it sends carries a server-minted id. Correlating on
   * anything else — "the first pending join", or the room name's prefix —
   * guesses, and guesses wrong the moment Local and Corp are joined together:
   * an alias resolves to a room name this client deliberately cannot predict,
   * so there is nothing about `local_30000142` that says which join it answers
   * except the id it came back with.
   */
  resolveJoin(stanzaID, roomJid, roomName) {
    if (!stanzaID) {
      return;
    }
    const echoed = this.joinEchoes.get(stanzaID);
    if (echoed) {
      this.joinEchoes.delete(stanzaID);
      echoed();
      return;
    }
    for (const [channel, room] of this.rooms.entries()) {
      if (!room.pending || room.pending.joinID !== stanzaID) {
        continue;
      }
      room.roomJid = roomJid;
      room.roomName = roomName;
      room.joinedAtMs = Date.now();
      // ⚠ THE SYSTEM THIS ROOM IS FOR COMES BACK FROM THE SERVER, not from what
      // the caller thought it was when it asked. A join issued before the held
      // session knew its system would otherwise latch `joinedFor: 0` and the
      // move check below could never fire again.
      if (channel === "local") {
        room.joinedFor = positiveInt(roomName.split("_").pop());
      }
      const pending = room.pending;
      room.pending = null;
      this.rooms.set(channel, room);
      this.rememberSessionRoom(channel, roomName, roomJid);
      this.watchChannel(channel);
      pending.resolve(room);
      return;
    }
  }

  /**
   * Make sure this session is in `channel`'s room, and that it is the RIGHT
   * room.
   *
   * ⚠ `solarSystemID` IS A CHANGE DETECTOR, NEVER A ROOM NAME. The server
   * resolves `local@conference` from the session itself, which is what keeps
   * wormhole/Triglavian/no-local systems correct without this file knowing the
   * first thing about them. But retail's own auto-move
   * (`chatHub.moveLocalSession`) rides on `sendSessionChange`, which is a
   * capture stub for a browser-backed session and never fires — so a bot
   * that jumps would sit in its old system's Local for ever unless something
   * noticed. The held session's tracked system id is that something: when it
   * changes, leave and re-join, and the server picks the new room.
   */
  async ensureChannel(channel, context = {}) {
    await this.ensureReady();
    const solarSystemID = positiveInt(context.solarSystemID);
    if (this.login) {
      if (!SESSION_CHANNELS.has(channel) && !this.rooms.has(channel)) {
        throw new XmppChatError("This chat room is not joined.", { code: "CHAT_NO_CHANNEL", statusCode: 409 });
      }
      return this.ensureSystemChannel(channel, solarSystemID);
    }
    const existing = this.rooms.get(channel) || null;
    if (existing && !existing.pending) {
      const moved =
        channel === "local" &&
        solarSystemID > 0 &&
        existing.joinedFor > 0 &&
        existing.joinedFor !== solarSystemID;
      if (!moved) {
        return existing;
      }
      this.leaveRoom(existing);
    }
    if (existing && existing.pending) {
      return existing.pending.promise;
    }
    return this.joinChannel(channel, solarSystemID);
  }

  /**
   * The room of one of the session's own channels, for a pilot logged in the
   * retail client's way.
   *
   * The client does not work out which rooms it is to be in: logged in, it asks
   * the game server (`XmppChatMgr.ResyncSystemChannelAccess()`,
   * xmppchatsvc.py 345 to 368) and joins each channel that names, by the
   * channel's own name. So here: the names are asked for through the pilot's
   * game-port session, each is joined as named, and `channel` is answered with
   * the room of its category.
   *
   * A move is not noticed here. The client leaves a session channel at the
   * session's own change and takes the new one from what the server sends
   * (`onSessionChanged`, `takeSessionChannel`, `takeInvite`), and so does this.
   * A channel with no room is asked for again of the server, no sooner than
   * five seconds after the last asking or the last change of the session: the
   * time the server has to send the new room before this asks.
   */
  async ensureSystemChannel(channel, solarSystemID) {
    const existing = this.rooms.get(channel) || null;
    if (existing && existing.pending) {
      return existing.pending.promise;
    }
    if (existing) {
      return existing;
    }
    await this.joinSystemChannels(solarSystemID);
    const room = this.rooms.get(channel) || null;
    if (!room) {
      throw new XmppChatError(`The game server named no ${channel} channel for this pilot.`, {
        code: "CHAT_NO_CHANNEL",
      });
    }
    return room.pending ? room.pending.promise : room;
  }

  /**
   * A chat window's own check of its connection
   * (`_CheckConnectionStatus`, xmppchatclient/xmppchatwindow.py 1344 to 1364),
   * for the channel a window would show: every so often (the global config's
   * idle time and up to three seconds more, a new wait each time) a channel
   * that has had nothing in it for longer than that wait is joined again,
   * asking the history of the time it was quiet less two seconds. An idle time
   * of nought is no check. A channel's first watch starts as it gets a room;
   * one check waits at a time for a channel.
   *
   * On this server a pilot's own presence comes to each of its rooms every
   * thirty seconds, which is activity, and the check finds nothing quiet.
   */
  watchChannel(channel) {
    if (!this.login || this.closed || this.idleChecks.has(channel)) {
      return;
    }
    if (!this.activityAtMs.has(channel)) {
      this.activityAtMs.set(channel, Date.now());
    }
    if (!(this.idleSeconds > 0)) {
      return;
    }
    const waitSeconds = this.idleSeconds + Math.random() * 3;
    const check = setTimeout(() => {
      this.idleChecks.delete(channel);
      const room = this.rooms.get(channel) || null;
      if (!this.ready || this.closed || !room) {
        return;
      }
      const quietSeconds = (Date.now() - (this.activityAtMs.get(channel) || 0)) / 1000;
      if (quietSeconds > waitSeconds && room.roomJid && !room.pending) {
        this.write(this.retailStanzas().join(room.roomJid, quietSeconds - 2).xml);
      }
      this.watchChannel(channel);
    }, waitSeconds * 1000);
    if (typeof check.unref === "function") {
      check.unref();
    }
    this.idleChecks.set(channel, check);
  }

  stopWatchingChannels() {
    for (const check of this.idleChecks.values()) {
      clearTimeout(check);
    }
    this.idleChecks.clear();
    this.activityAtMs.clear();
  }

  /** GetWindowNameForGroup (xmppchatsvc.py 895-907), confirmed in the original pyc. */
  channelOf(roomName) {
    const category = String(roomName).split("_")[0];
    if (["private", "player", "bot", "system"].includes(category)) return String(roomName);
    return LOCAL_CATEGORIES.has(category) ? "local" : category;
  }

  /** Keep which room a session channel was, by the session's value it hung on. */
  rememberSessionRoom(channel, roomName, roomJid) {
    if (!this.login || !SESSION_CHANNELS.has(channel)) {
      return;
    }
    const hungOn = positiveInt(String(roomName).split("_").pop());
    if (hungOn) {
      this.sessionRooms.set(`${channel}:${hungOn}`, roomJid);
      this.leftRooms.delete(roomJid);
    }
  }

  /**
   * XmppChat.OnSessionChanged (xmppchatsvc.py 149 to 164): for each of the
   * session's values a channel hangs on, in the client's order, where the
   * value changed from something, the channel of the old value is left. The
   * client names that channel from the old value; here it is the room this
   * connection was in for that value, and `<category>_<old>` where it was in
   * none (the client sends its leave whether or not it had joined, 1154 to
   * 1162).
   *
   * Nothing is joined here. The new channel comes from the server: an invite
   * from `admin` (`takeInvite`), or the new room's own presences
   * (`takeSessionChannel`), which is what this server sends.
   */
  onSessionChanged(changes) {
    if (this.closed || !this.ready || !changes) {
      return;
    }
    for (const [sessionValue, channel] of SESSION_CHANGE_CATEGORIES) {
      const change = changes[sessionValue];
      const old = Array.isArray(change) ? positiveInt(change[0]) : 0;
      if (!old) {
        continue;
      }
      const roomJid =
        this.sessionRooms.get(`${channel}:${old}`) || `${channel}_${old}@${this.conferenceDomain}`;
      this.sessionRooms.delete(`${channel}:${old}`);
      this.leftRooms.add(roomJid);
      this.write(this.retailStanzas().leave(roomJid));
      const room = this.rooms.get(channel) || null;
      if (room && !room.pending && (room.roomJid === roomJid || room.roomJid === null)) {
        this.rooms.delete(channel);
        this.messages.delete(room.roomName);
        this.rosters.delete(room.roomName);
        this.memberOrder.delete(room.roomName);
      }
      // Coming back to what was left is a new channel again.
      const now = Array.isArray(change) ? positiveInt(change[1]) : 0;
      if (now) {
        for (const left of [...this.leftRooms]) {
          if (this.channelOf(left.split("@")[0]) === channel && left.split("@")[0].endsWith(`_${now}`)) {
            this.leftRooms.delete(left);
          }
        }
      }
    }
    // The server has until five seconds from now to send the new rooms before
    // a reader's asking has the channels asked for again.
    this.systemChannelsAskedAtMs = Date.now();
  }

  /**
   * A presence from a session channel's room that is not the room kept for its
   * category: that room is the category's from here on.
   *
   * The client's own rule: a presence in a channel has the window of the
   * channel's category made or found and set to that channel
   * (`_HandleXmppPresence`, xmppchatsvc.py 632 to 687, and
   * `GetOrCreateGroupChatWindow`, 853 to 881), so a Local window shows
   * whichever Local the server last sent a presence of. In the wormhole,
   * nullsec and Triglavian kinds the client passes over its own presence (652
   * to 654). A room left at a change of the session is not taken back by a
   * presence that was already on its way.
   */
  takeSessionChannel(roomJid, roomName, characterID) {
    const category = String(roomName).split("_")[0];
    const channel = this.channelOf(roomName);
    if (!SESSION_CHANNELS.has(channel) || this.leftRooms.has(roomJid)) {
      return;
    }
    if (characterID === this.characterID && ["wormhole", "nullsec", "triglavian"].includes(category)) {
      return;
    }
    const kept = this.rooms.get(channel) || null;
    if (kept && (kept.pending || kept.roomJid === roomJid)) {
      return;
    }
    this.rooms.set(channel, {
      channel,
      roomJid,
      roomName,
      alias: `${roomJid}/${this.characterID}`,
      joinedAtMs: Date.now(),
      joinedFor: channel === "local" ? positiveInt(roomName.split("_").pop()) : 0,
      pending: null,
    });
    this.rememberSessionRoom(channel, roomName, roomJid);
    this.watchChannel(channel);
  }

  /**
   * An invite to a channel: from `admin`, the channel is joined
   * (`_HandleInvite`, xmppchatsvc.py 550 to 559; the sender is the invite's
   * `from` up to its `@`, chatutil/__init__.py 56 to 64). An invite from
   * anybody else is retained for the page's native acceptance decision.
   * Answers whether the message was an invite.
   */
  takeInvite(from, xml) {
    if (!/<x\b[^>]*xmlns=['"]http:\/\/jabber\.org\/protocol\/muc#user['"]/i.test(xml)) {
      return false;
    }
    const invite = /<invite\b[^>]*>/i.exec(xml);
    if (!invite) {
      return false;
    }
    const sender = attr(invite[0], "from").split("@")[0];
    const roomName = from.split("@")[0];
    if (sender === "admin" && roomName) {
      const channel = this.channelOf(roomName);
      const kept = this.rooms.get(channel) || null;
      if (!(kept && (kept.pending || kept.roomName === roomName))) {
        this.leftRooms.delete(`${roomName}@${this.conferenceDomain}`);
        this.joinChannel(channel, 0, roomName).catch(() => {});
      }
    } else {
      const senderCharacterID = positiveInt(sender);
      if (senderCharacterID && roomName) {
        const key = `${roomName}:${senderCharacterID}`;
        const reason = /<reason>([\s\S]*?)<\/reason>/i.exec(xml);
        const password = /<password>([\s\S]*?)<\/password>/i.exec(xml);
        this.invitations.set(key, {
          id: this.invitations.get(key)?.id || String(++this.controlCounter),
          roomName, senderCharacterID,
          reason: reason ? decodeXml(reason[1]) : "",
          password: password ? decodeXml(password[1]) : "",
        });
      }
    }
    return true;
  }

  /**
   * Ask the game server which system channels this pilot is to be in, and join
   * each one not already joined.
   *
   * One asking at a time, and no sooner than five seconds after the last: the
   * client's own wait between two askings that named nothing.
   */
  joinSystemChannels(solarSystemID) {
    if (this.systemChannelsWork) {
      return this.systemChannelsWork;
    }
    if (
      this.systemChannelsAskedAtMs > 0 &&
      Date.now() - this.systemChannelsAskedAtMs < RESYNC_RETRY_MS
    ) {
      return Promise.resolve();
    }
    this.systemChannelsAskedAtMs = Date.now();
    this.systemChannelsWork = Promise.resolve()
      .then(() => this.login.channels())
      .then(
        async (names) => {
          // _JoinSystemChannels (xmppchatsvc.py 355 to 356): each channel named
          // is joined in turn, the next once the one before has answered.
          const joined = [];
          for (const name of Array.isArray(names) ? names : []) {
            const category = String(name).split("_")[0];
            const channel = this.channelOf(name);
            const had = this.rooms.get(channel) || null;
            if (had && (had.pending || had.roomName === name)) {
              continue;
            }
            if (had) {
              this.leaveRoom(had);
            }
            if (category === SUPPRESSED_LOCAL_CATEGORY) {
              this.rooms.set(channel, {
                channel,
                roomJid: null,
                roomName: name,
                alias: null,
                joinedAtMs: Date.now(),
                joinedFor: positiveInt(String(name).split("_").pop()),
                pending: null,
              });
              continue;
            }
            // The join's own failure is its reader's to hear, when the room is
            // found missing; it stops no other channel's join.
            // eslint-disable-next-line no-await-in-loop
            const room = await this.joinChannel(channel, solarSystemID, name).catch(() => null);
            if (room && room.roomJid) {
              joined.push(room.roomJid);
            }
          }
          // And then the same channels are joined once more, by a thread of
          // their own that nothing waits on (363: `_JoinChannels` started with
          // the list the loop has just been through). A retail client's login
          // on this server shows each channel's presence twice. Only at the
          // login: what the client does at a move is a later step.
          if (!this.systemChannelsJoinedOnce) {
            this.systemChannelsJoinedOnce = true;
            this.joinAgain(joined).catch(() => {});
          }
        },
        (error) => {
          throw new XmppChatError(
            `The game server could not be asked for this pilot's chat channels: ${error.message}`,
            { code: "CHAT_LOGIN_UNAVAILABLE" },
          );
        },
      )
      .finally(() => {
        this.systemChannelsWork = null;
      });
    return this.systemChannelsWork;
  }

  /**
   * The login's second join of each system channel: the join's presence again,
   * each once the one before has been answered or has waited its time out.
   * The rooms are joined already and nothing here changes what is kept of
   * them; the server's answers are read as any presence is.
   */
  async joinAgain(roomJids) {
    for (const roomJid of roomJids) {
      if (!this.ready || this.closed) {
        return;
      }
      const again = this.retailStanzas().join(roomJid);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.joinEchoes.delete(again.id);
          resolve();
        }, JOIN_TIMEOUT_MS);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
        this.joinEchoes.set(again.id, () => {
          clearTimeout(timer);
          resolve();
        });
        this.write(again.xml);
      });
    }
  }

  /**
   * Join a room and wait for the server's answer to the join.
   *
   * `roomName` is what the presence is addressed to: the stub's alias for a
   * pilot on the gateway (the channel's own word), the channel's real name for
   * a pilot logged in the retail client's way.
   */
  joinChannel(channel, solarSystemID, roomName = channel, context = {}) {
    this.assertChatCurrent(context);
    let resolve = null;
    let reject = null;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const retail = this.login
      ? this.retailStanzas().join(`${roomName}@${this.conferenceDomain}`, 0, context.password)
      : null;
    const joinID = retail ? retail.id : this.nextID("join");
    const room = {
      channel,
      roomJid: null,
      roomName: null,
      alias: this.aliasJid(roomName),
      joinedAtMs: 0,
      joinedFor: solarSystemID,
      pending: { promise, resolve, reject, joinID },
      seenMembers: new Set(),
    };
    this.rooms.set(channel, room);
    const history =
      channel === "local"
        ? ""
        : `<history seconds='${CORP_HISTORY_SECONDS}'/>`;
    this.write(
      retail
        ? retail.xml
        : `<presence id='${escapeXml(joinID)}' to='${escapeXml(room.alias)}'>` +
          `<x xmlns='http://jabber.org/protocol/muc'>${history}</x></presence>`,
    );
    const timer = setTimeout(() => {
      if (room.pending) {
        const pending = room.pending;
        room.pending = null;
        this.rooms.delete(channel);
        pending.reject(
          new XmppChatError(`The chat server did not answer the ${channel} join.`, {
            code: "CHAT_JOIN_TIMEOUT",
          }),
        );
      }
    }, JOIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return promise.finally(() => clearTimeout(timer));
  }

  leaveRoom(room) {
    if (!room) {
      return;
    }
    // A Local nothing was joined for (the suppressed kind, which has no
    // address) is forgotten with nothing sent: there is no room to leave.
    const neverJoined = room.alias === null;
    const address = room.roomJid || (!neverJoined && room.alias?.split("/")[0]);
    if (address) {
      this.write(
        this.login
          ? this.retailStanzas().leave(address)
          : `<presence type='unavailable' to='${escapeXml(address)}/${this.characterID}'/>`,
      );
    }
    if (room.pending) {
      room.pending.reject(new XmppChatError("This chat room was left.", { code: "CHAT_ROOM_LEFT", statusCode: 409 }));
      room.pending = null;
    }
    clearTimeout(this.idleChecks.get(room.channel));
    this.idleChecks.delete(room.channel);
    this.activityAtMs.delete(room.channel);
    this.rooms.delete(room.channel);
    // The tail of what was said in a system this pilot has left is not this
    // pilot's chat any more.
    this.messages.delete(room.roomName);
    this.rosters.delete(room.roomName);
    this.memberOrder.delete(room.roomName);
  }

  /**
   * The channel as the browser's decoder expects it: roster, message tail, and
   * the room the server resolved.
   */
  snapshot(channel, limit) {
    const room = this.rooms.get(channel) || null;
    const roomName = room && room.roomName ? room.roomName : null;
    const roster = roomName ? this.rosters.get(roomName) || new Map() : new Map();
    const log = roomName ? this.messages.get(roomName) || [] : [];
    const capped = Math.max(1, Math.min(Number(limit) || 50, MAX_BUFFERED_MESSAGES));
    // The room name carries the id the room is FOR — `local_<solarSystemID>`,
    // `corp_<corporationID>` — so this is read back from the server's answer
    // rather than echoed from what we asked for.
    const suffix = roomName ? positiveInt(roomName.split("_").pop()) : 0;
    return {
      channel,
      roomName,
      seenMembers: [...(room?.seenMembers || [])],
      solarSystemID: channel === "local" ? suffix || null : null,
      corporationID: channel === "corp" ? suffix || null : null,
      roster: (this.memberOrder.get(roomName)?.keys() || [...roster.keys()]).filter(id => roster.has(id)).map(characterID => { const member = roster.get(characterID); return ({
        characterID,
        name: member.name,
        corporationID: member.corporationID,
        allianceID: member.allianceID,
        solarSystemID: channel === "local" ? suffix || null : null,
      }); }),
      messages: log.slice(-capped),
    };
  }

  /** Recheck the captured pilot at the actual stanza dispatch, after every await. */
  assertChatCurrent(context = {}) {
    if (this.closed || !this.ready || !this.socket || this.socket.destroyed) {
      throw new XmppChatError("This chat session is no longer connected.", {
        code: this.closed ? "CHAT_SESSION_CLOSED" : "CHAT_TRANSPORT_UNAVAILABLE",
        statusCode: 409,
      });
    }
    context.assertCurrent?.();
  }

  /** Native GetDisplayName uses disco#info before deciding a private/player caption. */
  async roomInfo(roomName, context = {}) {
    if (typeof roomName !== "string" || !/^(private|player)_[a-z0-9_-]+$/.test(roomName)) {
      throw new XmppChatError("A private or player room name is required.", { code: "INVALID_CHANNEL", statusCode: 400 });
    }
    await this.ensureReady();
    this.assertChatCurrent(context);
    const request = this.retailStanzas().roomInfo(roomName);
    const response = await new Promise((resolve, reject) => {
      // xmppConnection.IssueRequest (203-234) waits thirty seconds.
      const timer = setTimeout(() => {
        this.infoRequests.delete(request.id);
        reject(new XmppChatError("The chat server did not answer the room information request.", { code: "CHAT_INFO_TIMEOUT", statusCode: 504 }));
      }, 30_000);
      timer.unref?.();
      this.infoRequests.set(request.id, { resolve, reject, timer });
      this.write(request.xml);
    });
    this.assertChatCurrent(context);
    const identity = /<identity\b[^>]*>/i.exec(response);
    const field = /<field\b[^>]*\bvar=['"]muc#roominfo_occupants['"][^>]*>([\s\S]*?)<\/field>/i.exec(response);
    const value = field && /<value>([\s\S]*?)<\/value>/i.exec(field[1]);
    const written = value ? decodeXml(value[1]).trim() : "";
    const occupants = /^[+-]?\d+$/.test(written) ? Number(written) : 0;
    return {
      roomName,
      result: attr(response.match(/^<iq\b[^>]*>/i)?.[0] || "", "type") === "result",
      name: identity ? attr(identity[0], "name") || null : null,
      occupants: Number.isFinite(occupants) ? occupants : 0,
    };
  }

  takeRoomInfo(xml) {
    const id = attr(xml.match(/^<iq\b[^>]*>/i)?.[0] || "", "id");
    const pending = this.infoRequests.get(id);
    if (!pending) return;
    this.infoRequests.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(xml);
  }

  rejectRoomInfoRequests() {
    const error = new XmppChatError("This chat connection ended before its room information arrived.", {
      code: this.closed ? "CHAT_SESSION_CLOSED" : "CHAT_TRANSPORT_UNAVAILABLE", statusCode: 409,
    });
    for (const pending of this.infoRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.infoRequests.clear();
  }


  /** Native JoinChannel (1013-1059): join the returned room, not a category alias. */
  async joinRoom(roomName, context = {}) {
    if (typeof roomName !== "string" || !/^[a-z0-9]+_[a-z0-9_-]+$/.test(roomName)) {
      throw new XmppChatError("A full chat room name is required.", {
        code: "INVALID_CHANNEL", statusCode: 400,
      });
    }
    await this.ensureReady();
    this.assertChatCurrent(context);
    const channel = this.channelOf(roomName);
    const existing = this.rooms.get(channel);
    if (existing?.pending) {
      const room = await existing.pending.promise;
      this.assertChatCurrent(context);
      if (room.roomName === roomName) return this.snapshot(channel, context.limit);
    }
    // Native JoinChannel also sends a presence for an already joined room.
    if (existing && existing.roomName !== roomName) this.leaveRoom(existing);
    await this.joinChannel(channel, 0, roomName, context);
    this.assertChatCurrent(context);
    return this.snapshot(channel, context.limit);
  }

  /** The room windows and optional control messages, retained until the page handles them. */
  async overview(context = {}) {
    await this.ensureReady();
    this.assertChatCurrent(context);
    return {
      channels: [...this.rooms.keys()].filter(channel => !!this.rooms.get(channel)?.roomName)
        .map(channel => this.snapshot(channel, context.limit)),
      invitations: [...this.invitations.values()],
      declines: this.declines.slice(),
    };
  }

  leave(channel, context = {}) {
    this.assertChatCurrent(context);
    const room = this.rooms.get(channel);
    if (room) this.leaveRoom(room);
    return { channel, left: !!room };
  }

  /** xmppConnection.Invite (297-300); the page decides when the first-send invite is due. */
  async invite(channel, targetCharacterID, reason = "", context = {}) {
    const room = await this.ensureChannel(channel, context);
    this.assertChatCurrent(context);
    const target = positiveInt(targetCharacterID);
    if (!target || target === this.characterID) {
      throw new XmppChatError("A different player character is required.", {
        code: "CHAT_INVALID_TARGET", statusCode: 400,
      });
    }
    if (!["private", "player"].includes(room.roomName?.split("_")[0])) {
      throw new XmppChatError("This room does not allow player invitations.", {
        code: "CHAT_INVITE_UNAVAILABLE", statusCode: 409,
      });
    }
    this.write(this.retailStanzas().invite(room.roomJid, target, String(reason)));
    return { channel, roomName: room.roomName, invited: true };
  }

  /** xmppConnection.RejectInvite (303-306), before joining the offered room. */
  async rejectInvitation(id, reason, context = {}) {
    if (!["rejected", "blocked", "rejected_and_blocked"].includes(reason)) {
      throw new XmppChatError("An invitation rejection reason is required.", {
        code: "CHAT_INVALID_DECLINE", statusCode: 400,
      });
    }
    await this.ensureReady();
    this.assertChatCurrent(context);
    const invitation = [...this.invitations.values()].find(item => item.id === id);
    if (!invitation) return { declined: false };
    this.write(this.retailStanzas().decline(
      `${invitation.roomName}@${this.conferenceDomain}`, invitation.senderCharacterID, reason));
    this.forgetInvitation(id, context);
    return { declined: true };
  }

  /** Accept/ignore decisions belong to the page; acknowledging sends nothing. */
  forgetInvitation(id, context = {}) {
    this.assertChatCurrent(context);
    for (const [key, invitation] of this.invitations) {
      if (invitation.id === id) return this.invitations.delete(key);
    }
    return false;
  }

  takeDecline(from, xml) {
    if (!/<x\b[^>]*xmlns=['"]http:\/\/jabber\.org\/protocol\/muc#user['"]/i.test(xml)) return false;
    const decline = /<decline\b[^>]*>/i.exec(xml);
    if (!decline) return false;
    const senderCharacterID = positiveInt(attr(decline[0], "from").split("@")[0]);
    const roomName = from.split("@")[0];
    if (senderCharacterID && roomName) {
      const reason = /<reason>([\s\S]*?)<\/reason>/i.exec(xml);
      this.declines.push({
        id: String(++this.controlCounter), roomName, senderCharacterID,
        reason: reason ? decodeXml(reason[1]) : "",
      });
      if (this.declines.length > MAX_BUFFERED_MESSAGES) this.declines.shift();
    }
    return true;
  }


  async read(channel, context = {}) {
    await this.ensureChannel(channel, context);
    this.assertChatCurrent(context);
    return this.snapshot(channel, context.limit);
  }

  async prepare(channel, message, context = {}) {
    await this.ensureChannel(channel, context);
    const typed = String(message || "").trim();
    const spam = this.login && typed && isSpam(typed, await this.taboosKnown());
    this.assertChatCurrent(context);
    if (spam) throw new XmppChatError("The line has in it a site that is banned in chat, and was not sent.", { code: "CHAT_LINE_REFUSED", statusCode: 409 });
    if (!typed) throw new XmppChatError("A chat message cannot be empty.", { code: "CHAT_EMPTY_MESSAGE", statusCode: 400 });
    return { channel, sendable: true };
  }

  async send(channel, message, context = {}) {
    const room = await this.ensureChannel(channel, context);
    const typed = String(message || "").trim();
    // The client's window sends no line it takes for spam, and says nothing
    // of it (`_Send`, xmppchatwindow.py 952 to 956). Here the sender is told.
    if (this.login && typed && isSpam(typed, await this.taboosKnown())) {
      throw new XmppChatError("The line has in it a site that is banned in chat, and was not sent.", {
        code: "CHAT_LINE_REFUSED",
        statusCode: 409,
      });
    }
    // What the client's chat service and its XMPP handler make of a line
    // before it goes out (xmppchatsvc.py 342: TruncateVeryLongText; xmpphandler
    // 118 to 120: the characters of the control categories taken out). A pilot
    // on the gateway sends the line as it was typed, as it always has.
    const text = this.login
      ? withoutCategoryC(
        typed.length > MAX_TEXT_LEN_SAFEGUARD ? `${typed.slice(0, MAX_TEXT_LEN_SAFEGUARD - 5)} ...` : typed,
      )
      : typed;
    if (!text) {
      throw new XmppChatError("A chat message cannot be empty.", {
        code: "CHAT_EMPTY_MESSAGE",
        statusCode: 400,
      });
    }
    if (!room.roomJid && !room.alias) {
      throw new XmppChatError(`There is no ${channel} room to speak in here.`, {
        code: "CHAT_NO_CHANNEL",
        statusCode: 409,
      });
    }
    this.assertChatCurrent(context);
    this.write(
      this.login
        ? this.retailStanzas().line(room.roomJid || room.alias.split("/")[0], text).xml
        : `<message type='groupchat' id='${this.nextID("msg")}' ` +
          `to='${escapeXml(room.roomJid || room.alias)}'><body>${escapeXml(text)}</body></message>`,
    );
    // ⚠ PROVISIONAL, AND SAID SO BY BEING BUILT HERE. The server echoes the
    // real line back to every occupant including us, and that echo — not this
    // object — is what lands in the buffer a later read returns. This is the
    // acknowledgement that the write went out, nothing more.
    return {
      channel,
      roomName: room.roomName,
      sent: true,
      entry: {
        characterID: this.characterID,
        characterName:
          (this.rosters.get(room.roomName) || new Map()).get(this.characterID)?.name ||
          `Character ${this.characterID}`,
        message: text,
        createdAtMs: Date.now(),
      },
    };
  }

  close() {
    this.closed = true;
    this.rejectRoomInfoRequests();
    for (const room of this.rooms.values()) {
      if (room.pending) {
        room.pending.reject(new XmppChatError("This chat session has been released.", { code: "CHAT_SESSION_CLOSED", statusCode: 409 }));
        room.pending = null;
      }
    }
    this.invitations.clear();
    this.declines.length = 0;
    if (this.stopHearingSession) {
      this.stopHearingSession();
      this.stopHearingSession = null;
    }
    // Politeness, not bookkeeping: the server drops us from every room on the
    // socket's own close (`removeClientFromRooms`), so this only spares it the
    // half-open reap and makes the transcript read like a client leaving.
    //
    // A pilot logged in the retail client's way leaves as that client does at
    // a logoff: its session's channels left first, each in the order the
    // client's session categories are in (xmppchatsvc.py 35 to 45, 153 to 162:
    // the system's, the alliance's, the corporation's, the fleet's, the
    // faction's), and then the stream closed (OnSessionReset, 170 to 171).
    if (this.login && this.ready) {
      const leaves = [];
      for (const [, channel] of SESSION_CHANGE_CATEGORIES) {
        const room = this.rooms.get(channel) || null;
        if (room && room.roomJid) {
          leaves.push(this.retailStanzas().leave(room.roomJid));
        }
      }
      // ⚠ THE SOCKET IS ENDED BEHIND THESE, NOT DESTROYED. Several writes
      // followed at once by a destroy lost all but the first (seen in the
      // stub's log: the first leave arrived, the second and the stream's close
      // did not). `end` lets what was written go out; the reap is for a server
      // that never closes its own side.
      const socket = this.socket;
      this.socket = null;
      if (socket && !socket.destroyed) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        const reap = setTimeout(() => socket.destroy(), 2000);
        if (typeof reap.unref === "function") {
          reap.unref();
        }
        socket.on("close", () => clearTimeout(reap));
        for (const leave of leaves) {
          socket.write(leave);
        }
        socket.end("</stream:stream>");
      }
    } else {
      this.write("</stream:stream>");
    }
    this.teardownSocket();
    this.messages.clear();
    this.rosters.clear();
    this.memberOrder.clear();
  }
}

function createXmppChatSession(options) {
  return new XmppChatSession(options);
}

module.exports = {
  createXmppChatSession,
  XmppChatSession,
  XmppChatError,
  // Exported for the tests, which stand up a fake stub server on an ephemeral
  // port and need to address it the way the real one is addressed.
  xmppHost,
  xmppPort,
  xmppDomain,
  xmppConferenceDomain,
};
