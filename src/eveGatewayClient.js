"use strict";

const { WebSocket } = require("ws");
const { createXmppChatSession } = require("./evejsXmppChat");

const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:26002/_evejs-web/v1";
const DEFAULT_TIMEOUT_MS = 1500;
const GATEWAY_SOURCE = "evejs-web-gateway";
const GATEWAY_API_VERSION = 1;

class EveGatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "EveGatewayError";
    this.code = options.code || "EVE_GATEWAY_ERROR";
    this.statusCode = options.statusCode || 502;
  }
}

function getGatewayBaseUrl() {
  const configured = String(
    process.env.EVEJS_GATEWAY_URL || DEFAULT_GATEWAY_BASE_URL,
  ).trim();
  let url;
  try {
    url = new URL(configured);
  } catch (error) {
    throw new EveGatewayError(
      "EVEJS_GATEWAY_URL must be an absolute v1 gateway URL.",
      { code: "EVE_GATEWAY_CONFIGURATION", statusCode: 500 },
    );
  }

  const gatewayPath = url.pathname.replace(/\/+$/, "");
  const valid =
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    gatewayPath === "/_evejs-web/v1";
  if (!valid) {
    throw new EveGatewayError(
      "EVEJS_GATEWAY_URL must target the /_evejs-web/v1 gateway namespace.",
      { code: "EVE_GATEWAY_CONFIGURATION", statusCode: 500 },
    );
  }

  url.pathname = gatewayPath;
  return url.toString().replace(/\/$/, "");
}

function getGatewayToken() {
  return String(process.env.EVEJS_WEB_GATEWAY_TOKEN || "").trim();
}

function assertGatewayEnvelope(data, statusCode) {
  if (!data || data.source !== GATEWAY_SOURCE) {
    throw new EveGatewayError("EveJS gateway endpoint is not available.", {
      code: "EVE_GATEWAY_NOT_AVAILABLE",
      statusCode: statusCode || 502,
    });
  }
  if (Number(data.apiVersion) !== GATEWAY_API_VERSION) {
    throw new EveGatewayError("EveJS gateway response version is not supported.", {
      code: "EVE_GATEWAY_UNSUPPORTED",
      statusCode: statusCode || 502,
    });
  }
}

function gatewayRequestError(error) {
  if (error instanceof EveGatewayError) {
    return error;
  }
  const code = error.name === "AbortError"
    ? "EVE_GATEWAY_TIMEOUT"
    : "EVE_GATEWAY_UNREACHABLE";
  return new EveGatewayError(
    code === "EVE_GATEWAY_TIMEOUT"
      ? "EveJS gateway timed out."
      : "EveJS gateway is unreachable.",
    { code },
  );
}

async function postSerializedJson(path, serializedPayload, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    "content-type": "application/json",
  };
  const token = getGatewayToken();
  if (token) {
    headers["x-evejs-web-token"] = token;
  }

  try {
    const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
      method: "POST",
      headers,
      body: serializedPayload,
      signal: controller.signal,
    });
    const contentType = String(response.headers.get("content-type") || "");
    const data = contentType.includes("application/json")
      ? await response.json()
      : null;

    assertGatewayEnvelope(data, response.status);
    if (data.ok === false) {
      throw new EveGatewayError(data.message || "EveJS gateway request failed.", {
        code: data.error || "EVE_GATEWAY_REQUEST_FAILED",
        statusCode: response.status || 502,
      });
    }
    if (!response.ok || data.ok !== true) {
      throw new EveGatewayError(data.message || "EveJS gateway request failed.", {
        code: data.error || "EVE_GATEWAY_REQUEST_FAILED",
        statusCode: response.status || 502,
      });
    }

    return data;
  } catch (error) {
    throw gatewayRequestError(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(path, payload, options = {}) {
  return postSerializedJson(path, JSON.stringify(payload), options);
}

async function getJson(path, query = {}, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {};
  const token = getGatewayToken();
  if (token) {
    headers["x-evejs-web-token"] = token;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";

  try {
    const response = await fetch(`${getGatewayBaseUrl()}${path}${suffix}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const contentType = String(response.headers.get("content-type") || "");
    const data = contentType.includes("application/json")
      ? await response.json()
      : null;

    assertGatewayEnvelope(data, response.status);
    if (data.ok === false) {
      throw new EveGatewayError(data.message || "EveJS gateway request failed.", {
        code: data.error || "EVE_GATEWAY_REQUEST_FAILED",
        statusCode: response.status || 502,
      });
    }
    if (!response.ok || data.ok !== true) {
      throw new EveGatewayError(data.message || "EveJS gateway request failed.", {
        code: data.error || "EVE_GATEWAY_REQUEST_FAILED",
        statusCode: response.status || 502,
      });
    }

    return data;
  } catch (error) {
    throw gatewayRequestError(error);
  } finally {
    clearTimeout(timeout);
  }
}

// Every v1 route except /health is an IPC-forwarded owner call since the edge
// split, and eve.js puts its OWN deadline on those: 15 s
// (server/src/edge/gateway/gatewayEdgeRuntime.js, requestTimeoutMs). Our budget
// must sit ABOVE that deadline, or we abort first and the only thing the caller
// ever sees is "EveJS gateway timed out." — an AbortError with no response
// body, so the server's real verdict (EDGE_OWNER_REQUEST_TIMEOUT, naming the
// call that stalled) is thrown away. Losing that race is what made owner stalls
// undiagnosable; the earlier 1.5 s -> 5 s bump treated the symptom and stayed
// under the deadline. Keep this greater than the server's requestTimeoutMs, and
// change the two together.
const OWNER_CALL_TIMEOUT_MS = 18_000;

// /health is answered on the edge itself (buildGatewayHealth reads the runtime
// context synchronously — no owner hop), so it keeps the short budget on
// purpose. That is what makes it a useful probe: when health answers fast and
// owner calls are timing out, the gateway is up and the OWNER is the stalled
// part. Left at the budget it already had — tightening it further would only
// add a way for a busy edge process to fail a probe that used to pass.
const HEALTH_TIMEOUT_MS = 5_000;

async function getGatewayHealth() {
  const health = await getJson("/health", {}, { timeoutMs: HEALTH_TIMEOUT_MS });
  const hasStableShape =
    health.capabilities &&
    typeof health.capabilities === "object" &&
    health.runtime &&
    typeof health.runtime === "object" &&
    health.runtime.dependencies &&
    typeof health.runtime.dependencies === "object" &&
    health.runtime.characterEvents &&
    typeof health.runtime.characterEvents === "object" &&
    health.runtime.characterEvents.dependencies &&
    typeof health.runtime.characterEvents.dependencies === "object";
  if (!hasStableShape) {
    throw new EveGatewayError("EveJS gateway health response is not supported.", {
      code: "EVE_GATEWAY_UNSUPPORTED",
    });
  }
  return health;
}

function normalizeGatewayHealth(health) {
  const runtimeReady = health.runtime.ready === true;
  const dependencies = Object.fromEntries(
    Object.entries(health.runtime.dependencies)
      .map(([name, ready]) => [name, ready === true]),
  );
  const characterEventDependencies = Object.fromEntries(
    Object.entries(health.runtime.characterEvents.dependencies)
      .map(([name, ready]) => [name, ready === true]),
  );
  const characterEventsReady =
    health.capabilities.characterEvents === true &&
    health.runtime.characterEvents.ready === true &&
    Object.values(characterEventDependencies).every(Boolean);
  return {
    available: true,
    ready: runtimeReady && characterEventsReady,
    capabilities: { ...health.capabilities },
    runtime: {
      ready: runtimeReady,
      dependencies,
      characterEvents: {
        ready: characterEventsReady,
        dependencies: characterEventDependencies,
      },
    },
  };
}

async function getStatus() {
  const [status, health] = await Promise.all([
    getJson("/status", {}, { timeoutMs: OWNER_CALL_TIMEOUT_MS }),
    getGatewayHealth(),
  ]);
  return {
    ...status,
    ...normalizeGatewayHealth(health),
  };
}

async function getAccount(username) {
  const result = await getJson("/account", {
    username: String(username || "").trim(),
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return result.account || null;
}

/**
 * Web account auto-create (goal R2): POST /_evejs-web/v1/account/create.
 * The gateway is the authority — it enforces devAutoCreateAccounts (refusing
 * with ACCOUNT_CREATE_DISABLED when the flag is off) and answers an existing
 * username's account with `created: false`, so two racing logins cannot
 * double-create.
 */
async function createAccount(username) {
  const result = await postJson("/account/create", {
    username: String(username || "").trim(),
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    account: result.account || null,
    created: result.created === true,
  };
}

async function listCharacters(accountID) {
  const result = await getJson("/characters", {
    accountID: Number(accountID) || 0,
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return Array.isArray(result.characters) ? result.characters : [];
}

async function getSnapshot(accountID, characterID) {
  const result = await getJson("/snapshot", {
    accountID: Number(accountID) || 0,
    characterID: Number(characterID) || 0,
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return result.snapshot || null;
}

/**
 * The skill sheet + training queue (goal R28): GET /_evejs-web/v1/skills.
 *
 * A v1 READ, not a bridge call — it needs no held session, because reading what
 * a character knows is not an act of piloting. Everything arrives resolved:
 * names, group names, the SP threshold for all five levels of every skill, and
 * the queue's instants as epoch milliseconds against `serverNowMs` sampled in
 * the SAME read. The browser therefore never converts a FILETIME and never
 * re-derives the SP curve.
 */
async function getSkills(accountID, characterID) {
  const result = await getJson("/skills", {
    accountID: Number(accountID) || 0,
    characterID: Number(characterID) || 0,
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return result.skills || null;
}

// Offline status/queue and the dedicated, free-pilot Factory authority. These
// are deliberately separate from the generic bridge-call allowlist.
async function getCharacterStatus(accountID, characterID) {
  return getJson("/character-status", { accountID, characterID }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
}

async function saveOfflineSkillQueue(accountID, characterID, command) {
  return postJson("/skill-queue", { accountID, characterID, command }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
}

async function selectFactoryCharacter(accountID, characterID) {
  const data = await postJson("/factory/session", { args: [characterID, null, true], session: { userid: accountID } }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return data.outcome;
}

async function quoteFactorySkills(request) {
  return (await postJson("/factory/quote", request, { timeoutMs: OWNER_CALL_TIMEOUT_MS })).outcome;
}

async function acquireFactorySkills(request) {
  return (await postJson("/factory/acquire", request, { timeoutMs: OWNER_CALL_TIMEOUT_MS })).outcome;
}

// Bridge reads can be heavy on a cold gateway: map.GetStationInfo marshals the
// whole station table and lazily loads a multi-MB world store on first touch,
// and GetCharacterSelectionData computes per-character skill totals. They ride
// the same owner hop as the plain reads, so they share OWNER_CALL_TIMEOUT_MS —
// on a dev emulator a correct slow answer beats a spurious timeout.

/**
 * Invoke a whitelisted EveJS service method through the bridge route
 * (POST /_evejs-web/v1/call). Mirrors the retail call tuple
 * (service, method, args, kwargs); `sessionFields` are the JSON scalars the
 * gateway materializes into the browser-backed session (`userid` required).
 * See docs/bridge-wire-contract.md for the full wire contract.
 */
async function callMethod(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined) {
  const body = {
    service: String(service || ""),
    method: String(method || ""),
    args: Array.isArray(args) ? args : [],
    kwargs: kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)
      ? kwargs
      : null,
    session: sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)
      ? sessionFields
      : {},
  };
  // Optional persistent-session handle (goal R2): when the BFF holds a
  // bridgeSessionID for this web session, the call runs on the stored live
  // session instead of a per-call one. The handle never reaches browser JS.
  if (typeof bridgeSessionID === "string" && bridgeSessionID) {
    body.bridgeSessionID = bridgeSessionID;
  }
  const data = await postJson("/call", body, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    service: data.service,
    method: data.method,
    result: data.result === undefined ? null : data.result,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

// SelectCharacterID does real work (apply character, guest broadcast, possible
// space restore) — the slowest owner call we make, and the one most likely to
// be the thing a stalled login is queued behind.

/**
 * Mint a persistent browser-backed session on the gateway and bring a
 * character online on it: POST /_evejs-web/v1/session/select dispatches the
 * retail tuple charUnboundMgr.SelectCharacterID(charID, secondChoiceID,
 * skipTutorial) on the minted session. Returns the opaque bridgeSessionID
 * (held server-side only — it must never reach browser JS) plus the session
 * echo (characterID, stationID, ...). See docs/bridge-wire-contract.md.
 */
async function selectCharacter(args = [], kwargs = null, sessionFields = {}) {
  const data = await postJson("/session/select", {
    args: Array.isArray(args) ? args : [],
    kwargs: kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)
      ? kwargs
      : null,
    session: sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)
      ? sessionFields
      : {},
  }, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    bridgeSessionID: String(data.bridgeSessionID || ""),
    service: data.service,
    method: data.method,
    result: data.result === undefined ? null : data.result,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    session: data.session && typeof data.session === "object" ? data.session : {},
  };
}

/**
 * Release a persistent browser-backed session: POST
 * /_evejs-web/v1/session/release runs the same disconnect path a retail
 * socket close runs (character offline, control released). Unknown or expired
 * sessions surface as SESSION_NOT_FOUND (404) — the TTL already disconnected
 * them.
 */
async function releaseBridgeSession(bridgeSessionID, sessionFields = undefined) {
  const body = { bridgeSessionID: String(bridgeSessionID || "") };
  if (sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)) {
    body.session = sessionFields;
  }
  // Release runs the full retail disconnect (character offline, space unload,
  // guest broadcast) — real work, same generous budget as select. On the old
  // 1.5 s default a logout under any concurrent traffic minted a false
  // "EveJS gateway timed out." while leaving the character online until TTL.
  const data = await postJson("/session/release", body, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    released: data.released === true,
    offline: data.offline === true,
    characterID: data.characterID === undefined ? null : data.characterID,
  };
}

/**
 * Flight status (goal R5a) — a read-only snapshot of the held persistent
 * session's current location + ship movement state, plus the drained
 * notification backlog. POST /_evejs-web/v1/session/flight-status. The browser
 * polls this manually between movement steps (push streaming is still G6). See
 * docs/bridge-wire-contract.md.
 */
async function readFlightStatus(bridgeSessionID, sessionFields = {}) {
  const body = { bridgeSessionID: String(bridgeSessionID || "") };
  if (sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)) {
    body.session = sessionFields;
  }
  const data = await postJson("/session/flight-status", body, {
    timeoutMs: OWNER_CALL_TIMEOUT_MS,
  });
  return {
    flight: data.flight && typeof data.flight === "object" ? data.flight : {},
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Authoritative scanner state for product-level browser actions. EveJS chooses
 * the current ship launcher and current-system probe geometry; neither is
 * accepted from browser input on the safe companion routes.
 */
async function readScannerState(bridgeSessionID, sessionFields = {}) {
  const body = { bridgeSessionID: String(bridgeSessionID || "") };
  if (sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)) {
    body.session = sessionFields;
  }
  const data = await postJson("/session/scanner-state", body, {
    timeoutMs: OWNER_CALL_TIMEOUT_MS,
  });
  return {
    scanner: data.scanner && typeof data.scanner === "object" ? data.scanner : {},
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Space snapshot (goal R11) — a read-only projection of what the held session
 * can see in space right now: the visible entities (identity + position +
 * velocity + health fractions) and the active ship's shield/armor/hull/
 * capacitor. POST /_evejs-web/v1/space/snapshot. The browser polls this ~1s
 * while in space with the overview open — the same cadence the retail client
 * re-renders its own overview at — and computes distance/sorting/filtering
 * itself from the projected positions. See docs/bridge-wire-contract.md.
 */
async function readSpaceSnapshot(bridgeSessionID, sessionFields = {}) {
  const body = { bridgeSessionID: String(bridgeSessionID || "") };
  if (sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)) {
    body.session = sessionFields;
  }
  const data = await postJson("/space/snapshot", body, {
    timeoutMs: OWNER_CALL_TIMEOUT_MS,
  });
  return {
    space: data.space && typeof data.space === "object" ? data.space : {},
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Bound-object bridge (goal R3) — step 1. Dispatch an allowlisted bind method
 * (invbroker.GetInventory/GetInventoryFromId/MachoBindObject,
 * ship.MachoBindObject) on the persistent session; the gateway registers the
 * bound OID and returns an opaque boundHandle. The handle is held BFF-side and
 * must never reach browser JS (same rule as bridgeSessionID). See
 * docs/bridge-wire-contract.md.
 */
async function bindObject(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined) {
  const body = {
    service: String(service || ""),
    method: String(method || ""),
    args: Array.isArray(args) ? args : [],
    kwargs: kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)
      ? kwargs
      : null,
    session: sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)
      ? sessionFields
      : {},
  };
  if (typeof bridgeSessionID === "string" && bridgeSessionID) {
    body.bridgeSessionID = bridgeSessionID;
  }
  const data = await postJson("/bound/bind", body, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    boundHandle: String(data.boundHandle || ""),
    service: data.service,
    method: data.method,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * Bound-object bridge (goal R3) — step 2. Dispatch an allowlisted bound method
 * (List/Add/GetCapacity/StackAll/MultiMerge/Board) on a held handle. Deny by
 * default and session confinement are enforced by the gateway.
 */
async function callBoundMethod(service, method, args = [], kwargs = null, sessionFields = {}, bridgeSessionID = undefined, boundHandle = undefined) {
  const body = {
    service: String(service || ""),
    method: String(method || ""),
    args: Array.isArray(args) ? args : [],
    kwargs: kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)
      ? kwargs
      : null,
    session: sessionFields && typeof sessionFields === "object" && !Array.isArray(sessionFields)
      ? sessionFields
      : {},
    boundHandle: String(boundHandle || ""),
  };
  if (typeof bridgeSessionID === "string" && bridgeSessionID) {
    body.bridgeSessionID = bridgeSessionID;
  }
  const data = await postJson("/bound/call", body, { timeoutMs: OWNER_CALL_TIMEOUT_MS });
  return {
    service: data.service,
    method: data.method,
    result: data.result === undefined ? null : data.result,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
  };
}

/**
 * The chat connection this BFF speaks Local and Corp on (goal R7, revised
 * 2026-09-12).
 *
 * ⚠ THIS REPLACES `readChat`/`sendChat`, WHICH WERE DELETED RATHER THAN LEFT TO
 * ROT. They posted to `/_evejs-web/v1/chat/read|send`, and EveJS v0.12.8 removed
 * those routes, `runtime.readChat`/`sendChat` and the whole
 * `webChatGatewayService` behind them — so every call answered 404 on a
 * two-second tick while the failure was swallowed upstream. Keeping a helper
 * whose only possible outcome is a 404 would just leave the next reader a trap.
 *
 * ⚠ IT LIVES ON THE GATEWAY CLIENT BECAUSE IT IS THE SAME SERVER, a second port
 * on the same process (`tls://<host>:5222`, the chat edge). That placement is
 * also what keeps chat OUT of every test that injects a fake gateway: an app
 * built with a client that has no `createChatSession` simply has no chat, so
 * nothing but the chat tests themselves ever opens a socket to a real server.
 */
function createChatSession(options) {
  return createXmppChatSession(options);
}

// --- R10 live event channel (gateway push) ---------------------------------
// The one non-request surface the BFF holds: a WebSocket on the gateway's
// bridge-session event path. It carries the session's notification captures and
// its chat live, so the browser stops depending on polls for liveness. The BFF
// holds at most ONE of these per held bridge session and republishes it to the
// browser as SSE (see /api/bridge/events in server.js) — the bridgeSessionID
// never leaves the server, exactly as on the request routes.

const SESSION_EVENTS_PATH = "/session-events";

function getGatewayWebSocketUrl(query) {
  const url = new URL(`${getGatewayBaseUrl()}${SESSION_EVENTS_PATH}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Open the gateway push stream for a held bridge session.
 *
 * `cursor` ({epoch, sequence}) resumes a prior connection: the gateway replays
 * exactly the frames missed while disconnected, or — when the cursor is too old
 * or from a previous gateway process — sends a snapshot frame saying so, which
 * the consumer answers with a re-read. Returns a handle with `close()`.
 *
 * Delivery is best effort by design. The request routes still drain
 * notifications onto every response, so a stream that never opens (or drops)
 * costs liveness, never correctness.
 */
const DEFAULT_STREAM_PING_INTERVAL_MS = 30_000;

function openSessionEventStream(options = {}) {
  const {
    bridgeSessionID,
    userid,
    cursor = null,
    onFrame,
    onOpen,
    onClose,
    pingIntervalMs = DEFAULT_STREAM_PING_INTERVAL_MS,
  } = options;
  const query = {
    userid: Number(userid) || 0,
    bridgeSessionID: String(bridgeSessionID || ""),
  };
  if (cursor && cursor.epoch && Number.isSafeInteger(Number(cursor.sequence))) {
    query.epoch = String(cursor.epoch);
    query.sequence = String(Number(cursor.sequence));
  }
  const headers = {};
  const token = getGatewayToken();
  if (token) {
    headers["x-evejs-web-token"] = token;
  }

  let socket;
  try {
    socket = new WebSocket(getGatewayWebSocketUrl(query), { headers });
  } catch (error) {
    // A configuration failure is not recoverable by retrying; report it as a
    // close so the caller degrades to polling instead of hanging. Deferred,
    // never synchronous: the caller must be holding the returned handle when
    // the close fires, or it can store a dead handle over the null the close
    // handler just wrote and wedge the channel with no retry.
    queueMicrotask(() => {
      if (typeof onClose === "function") {
        onClose({ code: 0, reason: error.message || "stream unavailable" });
      }
    });
    return { close() {} };
  }

  let closed = false;
  let refusalStatus = 0;

  // Half-open detection. The gateway pings us and `ws` answers automatically,
  // but nothing on this side would ever notice a silently dead TCP connection
  // (sleeping host, NAT reap): `close` never fires on a half-open socket, the
  // retry loop never starts, and the browser trusts a dead channel. So ping
  // the gateway ourselves and terminate if a whole interval passes silent —
  // termination fires the normal close path, which retries.
  let pongAlive = true;
  let pingTimer = null;

  function stopPingWatchdog() {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPingWatchdog() {
    if (!(pingIntervalMs > 0) || pingTimer !== null) {
      return;
    }
    pingTimer = setInterval(() => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        stopPingWatchdog();
        return;
      }
      if (!pongAlive) {
        stopPingWatchdog();
        try {
          socket.terminate();
        } catch {
          // finish() below still reports the drop.
        }
        finish(0, "ping timeout");
        return;
      }
      pongAlive = false;
      try {
        socket.ping();
      } catch {
        // The socket is going down; its close event owns the report.
      }
    }, pingIntervalMs);
    if (typeof pingTimer.unref === "function") {
      pingTimer.unref();
    }
  }

  socket.on("pong", () => {
    pongAlive = true;
  });
  socket.on("open", () => {
    startPingWatchdog();
    if (typeof onOpen === "function") {
      onOpen();
    }
  });
  socket.on("message", (data) => {
    if (closed || typeof onFrame !== "function") {
      return;
    }
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return; // A malformed frame is dropped, never thrown at the caller.
    }
    if (frame && typeof frame === "object" && frame.source === GATEWAY_SOURCE) {
      onFrame(frame);
    }
  });
  // A refused upgrade (401/404/503) never opens and never closes on its own.
  socket.on("unexpected-response", (request, response) => {
    refusalStatus = Number(response.statusCode) || 0;
    response.resume();
    request.destroy();
    finish(refusalStatus, `gateway refused the event stream (HTTP ${refusalStatus})`);
  });
  socket.on("error", (error) => {
    finish(refusalStatus, error && error.message ? error.message : "stream error");
  });
  socket.on("close", (code, reason) => {
    finish(Number(code) || 0, String(reason || ""));
  });

  function finish(code, reason) {
    if (closed) {
      return;
    }
    closed = true;
    stopPingWatchdog();
    if (typeof onClose === "function") {
      onClose({ code, reason, refusalStatus });
    }
  }

  return {
    get refusalStatus() {
      return refusalStatus;
    },
    close() {
      closed = true;
      stopPingWatchdog();
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      } catch {
        try {
          socket.terminate();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

module.exports = {
  async getProvisioningObservation(accountID, characterID = null, source = { kind: "hangar" }) {
    const result = await getJson("/provisioning-observation", { accountID, characterID, sourceKind: source.kind,
      corporationID: source.corporationID, division: source.division }, { timeoutMs: 5000 });
    return result.projection;
  },
  EveGatewayError,
  openSessionEventStream,
  // Bridge surface (the live path): the retail call tuple, bound objects, the
  // persistent session, flight status, and chat.
  callMethod,
  bindObject,
  callBoundMethod,
  selectCharacter,
  releaseBridgeSession,
  readFlightStatus,
  readScannerState,
  readSpaceSnapshot,
  createChatSession,
  // The four v1 reads the auth/health surface still needs (goal R9b): account
  // lookup + the character list for login, the one-row snapshot the
  // /api/bridge/select ownership check reads, and gateway status for
  // /api/health. Every other v1 read helper went with the legacy routes.
  getAccount,
  createAccount,
  listCharacters,
  getSnapshot,
  getStatus,
  getGatewayHealth,
  // R28: the skill sheet + queue, resolved server-side (see getSkills above).
  getSkills,
  getCharacterStatus,
  saveOfflineSkillQueue,
  selectFactoryCharacter,
  quoteFactorySkills,
  acquireFactorySkills,
};
