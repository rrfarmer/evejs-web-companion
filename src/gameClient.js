"use strict";

// ── The game client: one short visit to the game port ───────────────────────
//
// A GamePortSession (src/gamePort/session.js) over TCP, with the small API the
// docked hops were written against: log in, make a few calls, close. Everything
// about HOW it talks - the handshake, the addressing, the keep-alive - is the
// session's, and the session does what the retail client does. This file only
// opens the socket and adapts the shapes.
//
// It exists for actions the web gateway does not carry and the retail client
// performs over this connection. It has no caller since the customs-office hop
// was dropped (a launchpad goes up on the pilot's own session now), and is kept for the next.
//
// ⚠ ONE CHARACTER, ONE CONNECTION. The server lets a character be in game on
// one session only (charService SelectCharacterID, loginTakeoverEnabled): a
// character selected here EVICTS the gateway's bridge session for it, and the
// gateway selecting it again evicts this one. Eviction runs the normal logoff,
// which in space is an emergency-warp logoff - so this client is only ever used
// for a DOCKED pilot, for a few seconds, and closed straight after.
//
// ⚠ NO REAL CREDENTIALS, BY DESIGN. eve.js does not check the password hash
// (devSkipPasswordValidation). The session still sends one, as the retail
// client does; with no password given it is the hash of an empty password.

const { GamePortSession, describeError } = require("./gamePort/session");
const { DEFAULT_GAME_PORT, connectTcp, gameEndpoint } = require("./gamePort/tcp");

function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && (value.type === "wstring" || value.type === "token")) return value.value;
  return null;
}

function dictValue(dict, key) {
  if (!dict || dict.type !== "dict" || !Array.isArray(dict.entries)) return undefined;
  for (const [k, v] of dict.entries) {
    if (text(k) === key) return v;
  }
  return undefined;
}

function numberOf(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && value.type === "long") return Number(value.value);
  return null;
}

class GameClient {
  constructor({ host, port = DEFAULT_GAME_PORT, connect = connectTcp, sessionOptions = {} } = {}) {
    this.host = host;
    this.port = port;
    this.connect = connect;
    this.sessionOptions = sessionOptions;
    this.transport = null;
    this.session = null;
    this.closed = false;
  }

  /** Connect and log in as `userName`, as the retail client's login screen does. */
  async login(userName, password = "") {
    this.transport = await this.connect({ host: this.host, port: this.port });
    if (this.closed) {
      this.transport.close();
      throw new Error("The game connection closed.");
    }
    this.session = new GamePortSession({ transport: this.transport, ...this.sessionOptions });
    await this.session.login(userName, password);
  }

  /** Call `service.method(args, kwargs)` and return its result. */
  async call(service, method, args = [], kwargs = null) {
    return this._session().call(service, method, args, kwargs);
  }

  /** Call `method` on a bound object, by the "N=..." id `bind` returned. */
  async callBound(objectID, method, args = [], kwargs = null) {
    return this._session().callBound(objectID, method, args, kwargs);
  }

  /** Bind `service`'s object for `bindParams` and return its "N=..." id. */
  async bind(service, bindParams) {
    return (await this._session().bind(service, bindParams)).objectID;
  }

  /** Close the connection. The server logs the character off. */
  close() {
    this.closed = true;
    if (this.session) this.session.close();
    else if (this.transport) this.transport.close();
  }

  _session() {
    if (!this.session || this.closed) throw new Error("The game connection is not logged in.");
    return this.session;
  }
}

module.exports = { GameClient, gameEndpoint, describeError, dictValue, text, numberOf };
