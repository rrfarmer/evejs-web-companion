"use strict";

// The public gateway, spoken as the retail client speaks it: the client's eve_public requests (skill plans and the
// rest it sends there rather than over machoNet) go as protobuf messages on one gRPC stream, Requests/Send, over
// HTTP/2 (publicGateway/grpc/requestBroker.py, its native CqrsBroker). Each request is an eve_public.Request whose
// payload is the request message packed in a google.protobuf.Any; each answer an eve_public.Response matched to it by
// its correlation_uuid, its status_code 200 when it went well (requestsMessenger._check_response_status).
//
// One connection per pilot, as each client has its own (and its own application_instance_uuid), shut when the pilot
// has asked nothing for a while. The envelope is RequestBroker.new_eve_public_request's: issued now, a new
// correlation_uuid, the client's external_origin ('eve-desktop-client/{build} {codename}'), the application instance,
// and the authoritative context: the tenant (lower case, '.' as '_'), the account as the authenticated user, and for a
// character request (send_character_request) the character as the active identity.
//
// The notices come on a second stream of the same connection, Notices/Consume (publicGateway/grpc/noticeConsumer.py,
// its native NoticeConsumer), each an eve_public.Notice: the notice message packed in a google.protobuf.Any, and the
// target group it is for. What the native consumer writes on that stream is not in the client's Python; EveJS's
// gateway (publicGatewayLocal.js handleNoticesConsumeStream) reads an eve_public.Request on it for whose stream it is,
// as it also learns from the requests on the same connection, so one is written there with the pilot's context. While
// a pilot's notices are read its connection stays open, and a stream that is lost is opened again after a moment.
// Which notices are the pilot's is the client's own test (NoticeConsumer._validate_target_group_against_session):
// noticeTargetMatches below.
//
// The messages are the client's own, from its generated eveProto modules (eveProtoSchema.json; see
// scripts/eve-proto-schema.js).

const crypto = require("crypto");
const http2 = require("http2");
const { createSchema } = require("./protoCodec");
const { RETAIL_CLIENT } = require("./session");

const SEND_PATH = "/eve_public.gateway.Requests/Send";
const CONSUME_PATH = "/eve_public.gateway.Notices/Consume";
const ACHIEVEMENT_DEFINITIONS_PATH = "/elysian-eve/achievements/latest.achv";
const TYPE_URL_PREFIX = "type.googleapis.com/";
/** stackless_response_router DEFAULT_TIMEOUT_SECONDS: a request with no timeout of its own waits this long. */
const DEFAULT_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 5 * 60_000;
/** How long a notice stream that was lost is left before it is opened again. */
const CONSUME_RETRY_MS = 5_000;
const STATUS_OK = 200;

let defaultSchema = null;
function eveProtoSchema() {
  if (!defaultSchema) defaultSchema = createSchema(require("./eveProtoSchema.json"));
  return defaultSchema;
}

/** EVEJS_PUBLIC_GATEWAY_URL, else the game host's EveJS public gateway (its port 26003, TLS). */
function publicGatewayUrl(env = process.env, gameHost = "127.0.0.1") {
  const said = String(env.EVEJS_PUBLIC_GATEWAY_URL || "").trim();
  return said || `https://${gameHost}:26003`;
}

function frame(message) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function frameReader(onMessage) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) break;
      if (pending[0] !== 0) throw new Error("The gateway sent a compressed message, which nothing asked for.");
      const message = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      onMessage(message);
    }
  };
}

function timestamp(ms) {
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

function gatewayError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** The message type an Any holds: its type_url's last part. */
function anyTypeName(any) {
  return any && any.type_url ? String(any.type_url).slice(String(any.type_url).lastIndexOf("/") + 1) : null;
}

/**
 * NoticeConsumer._validate_target_group_against_session (with get_target_group_and_id): whether a notice's target group
 * is the pilot's. The application instance is the connection's own, the solar system, user, character, corporation and
 * alliance the session's (solarsystemid2, userid, charid, corpid, allianceid); a bubble instance is anyone's; with no
 * group (None against None) it is the pilot's too.
 *   targetGroup   the notice's target_group as decoded (bytes as base64), or null
 *   pilot         { applicationInstance (base64), solarSystemID, userID, characterID, corporationID, allianceID }
 */
function noticeTargetMatches(targetGroup, pilot) {
  const group = targetGroup && typeof targetGroup === "object" ? targetGroup : {};
  const same = (said, held) => held !== null && held !== undefined && Number(said) === Number(held);
  if (group.application_instance_uuid !== undefined) return String(group.application_instance_uuid) === String(pilot.applicationInstance);
  if (group.solar_system !== undefined) return same(group.solar_system, pilot.solarSystemID);
  if (group.user !== undefined) return same(group.user, pilot.userID);
  if (group.character !== undefined) return same(group.character, pilot.characterID);
  if (group.corporation !== undefined) return same(group.corporation, pilot.corporationID);
  if (group.alliance !== undefined) return same(group.alliance, pilot.allianceID);
  return true;
}

/**
 * A public gateway client for the BFF's pilots.
 *   request(pilot, typeName, payload) -> {statusCode, statusMessage, typeName, payload}
 *   consume(pilot, onNotice) -> stop()
 * pilot is {userID, characterID}; with no characterID it is a user request (send_user_request: no active identity).
 * payload, the answer's, is the decoded message where the schema knows its type, else null. onNotice gets each notice
 * as {typeName, payload, targetGroup, applicationInstance}: the payload decoded where the schema knows its type (else
 * null), the target group as decoded, and the connection's own application instance (base64) to test it against.
 */
function createPublicGateway({
  url = publicGatewayUrl(),
  tenant = "tranquility",
  origin = `eve-desktop-client/${RETAIL_CLIENT.build} ${RETAIL_CLIENT.codename}`,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleCloseMs = IDLE_CLOSE_MS,
  consumeRetryMs = CONSUME_RETRY_MS,
  schema = eveProtoSchema(),
  connect = (target) => http2.connect(target, { rejectUnauthorized: false }),
  now = () => Date.now(),
} = {}) {
  const sanitizedTenant = String(tenant).replace(/\./g, "_").toLowerCase();
  const lines = new Map();

  function closeLine(key, error) {
    const line = lines.get(key);
    if (!line) return;
    lines.delete(key);
    clearTimeout(line.idle);
    for (const waiting of line.waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error || gatewayError("GATEWAY_CLOSED", "The public gateway connection closed before it answered."));
    }
    line.waiting.clear();
    try { line.stream.close(); } catch {}
    try { line.session.close(); } catch {}
  }

  function lineFor(key) {
    const open = lines.get(key);
    if (open) return open;
    const session = connect(url);
    const stream = session.request({
      ":method": "POST",
      ":path": SEND_PATH,
      "content-type": "application/grpc+proto",
      te: "trailers",
      "grpc-accept-encoding": "identity",
    });
    const line = { session, stream, waiting: new Map(), idle: null, consumers: 0, applicationInstance: crypto.randomUUID() };
    const read = frameReader((message) => {
      let response;
      try {
        response = schema.decode("eve_public.Response", message);
      } catch (error) {
        closeLine(key, gatewayError("GATEWAY_UNREADABLE", `The gateway's answer could not be read: ${error.message}`));
        return;
      }
      const waiting = line.waiting.get(response.correlation_uuid || "");
      if (!waiting) return;
      line.waiting.delete(response.correlation_uuid);
      clearTimeout(waiting.timer);
      waiting.resolve(response);
    });
    stream.on("data", (chunk) => {
      try { read(chunk); } catch (error) { closeLine(key, gatewayError("GATEWAY_UNREADABLE", error.message)); }
    });
    const lost = (error) => closeLine(key, error ? gatewayError("GATEWAY_UNREACHABLE", `The public gateway at ${url}: ${error.message}`) : undefined);
    stream.on("error", lost);
    stream.on("close", () => lost());
    session.on("error", lost);
    session.on("close", () => lost());
    lines.set(key, line);
    return line;
  }

  /** Kept open while it is asked things, and for as long as its notices are read. */
  function touch(key, line) {
    clearTimeout(line.idle);
    line.idle = setTimeout(() => {
      if (line.consumers > 0) {
        touch(key, line);
        return;
      }
      closeLine(key);
    }, idleCloseMs);
    if (line.idle.unref) line.idle.unref();
  }

  function pilotOf(pilot) {
    const userID = Number(pilot && pilot.userID);
    const characterID = pilot && pilot.characterID !== undefined && pilot.characterID !== null ? Number(pilot.characterID) : null;
    if (!Number.isInteger(userID) || userID <= 0) throw gatewayError("GATEWAY_NO_USER", "A gateway request is made for an account.");
    return { userID, characterID, key: characterID === null ? `user:${userID}` : `character:${characterID}` };
  }

  /** RequestBroker.new_eve_public_request's envelope, its payload the message given (none on a notice stream). */
  function envelope(line, { userID, characterID }, correlation, payload) {
    const authoritativeContext = {
      tenant: sanitizedTenant,
      authenticated_user: { sequential: userID },
      ...(characterID === null ? { no_active_identity: true } : { identity: { character: { sequential: characterID } } }),
    };
    return schema.encode("eve_public.Request", {
      issued: timestamp(now()),
      correlation_uuid: correlation,
      ...(payload ? { payload } : {}),
      external_origin: origin,
      application_instance_uuid: Buffer.from(line.applicationInstance.replace(/-/g, ""), "hex"),
      authoritative_context: authoritativeContext,
    });
  }

  function newCorrelation() {
    const correlation = crypto.randomBytes(16);
    correlation[6] = (correlation[6] & 0x0f) | 0x40;
    correlation[8] = (correlation[8] & 0x3f) | 0x80;
    return correlation;
  }

  async function request(pilot, typeName, payload = {}) {
    if (!schema.hasMessage(typeName)) throw gatewayError("GATEWAY_UNKNOWN_REQUEST", `No message ${typeName} in the client's schema.`);
    const who = pilotOf(pilot);
    const line = lineFor(who.key);
    touch(who.key, line);
    const correlation = newCorrelation();
    const message = envelope(line, who, correlation, { type_url: `${TYPE_URL_PREFIX}${typeName}`, value: schema.encode(typeName, payload) });
    const response = await new Promise((resolve, reject) => {
      const id = correlation.toString("base64");
      const timer = setTimeout(() => {
        line.waiting.delete(id);
        reject(gatewayError("GATEWAY_TIMEOUT", `The public gateway did not answer ${typeName} in ${timeoutMs} ms.`));
      }, timeoutMs);
      line.waiting.set(id, { resolve, reject, timer });
      line.stream.write(frame(message), (error) => {
        if (!error) return;
        line.waiting.delete(id);
        clearTimeout(timer);
        reject(gatewayError("GATEWAY_UNREACHABLE", `The public gateway at ${url}: ${error.message}`));
      });
    });
    const any = response.payload || null;
    const answerType = anyTypeName(any);
    return {
      statusCode: Number(response.status_code || 0),
      statusMessage: response.status_message || "",
      typeName: answerType,
      payload: answerType && schema.hasMessage(answerType) ? schema.decode(answerType, Buffer.from(any.value || "", "base64")) : null,
    };
  }

  function consume(pilot, onNotice) {
    const who = pilotOf(pilot);
    let stopped = false;
    let current = null;
    let retry = null;

    function release() {
      if (!current) return;
      const { line, stream } = current;
      current = null;
      line.consumers = Math.max(0, line.consumers - 1);
      try { stream.close(); } catch {}
    }

    function open() {
      retry = null;
      if (stopped) return;
      let line;
      try {
        line = lineFor(who.key);
      } catch {
        retry = setTimeout(open, consumeRetryMs);
        if (retry.unref) retry.unref();
        return;
      }
      line.consumers += 1;
      touch(who.key, line);
      const stream = line.session.request({
        ":method": "POST",
        ":path": CONSUME_PATH,
        "content-type": "application/grpc+proto",
        te: "trailers",
        "grpc-accept-encoding": "identity",
      });
      const mine = { line, stream };
      current = mine;
      const read = frameReader((message) => {
        let notice;
        try {
          notice = schema.decode("eve_public.Notice", message);
        } catch {
          return;
        }
        const any = notice.payload || null;
        const typeName = anyTypeName(any);
        let payload = null;
        if (typeName && schema.hasMessage(typeName)) {
          try { payload = schema.decode(typeName, Buffer.from(any.value || "", "base64")); } catch { payload = null; }
        }
        try {
          onNotice({
            typeName,
            payload,
            targetGroup: notice.target_group || null,
            applicationInstance: Buffer.from(line.applicationInstance.replace(/-/g, ""), "hex").toString("base64"),
          });
        } catch {
          // The listener's own failure is its own.
        }
      });
      stream.on("data", (chunk) => {
        try { read(chunk); } catch { try { stream.close(); } catch {} }
      });
      const lost = () => {
        if (current !== mine) return;
        release();
        if (stopped) return;
        retry = setTimeout(open, consumeRetryMs);
        if (retry.unref) retry.unref();
      };
      stream.on("error", lost);
      stream.on("close", lost);
      stream.write(frame(envelope(line, who, newCorrelation(), null)), () => {});
    }

    open();
    return function stop() {
      stopped = true;
      clearTimeout(retry);
      release();
    };
  }

  // The checkpoint advertises the public CDN hostname, which can differ
  // from the name the BFF uses on the Docker network. Read the same resource
  // over the configured EveJS connection; never follow arbitrary URLs.
  function achievementDefinitions(pilot) {
    const who = pilotOf(pilot);
    const line = lineFor(who.key);
    touch(who.key, line);
    return new Promise((resolve, reject) => {
      const stream = line.session.request({ ":method": "GET", ":path": ACHIEVEMENT_DEFINITIONS_PATH });
      const chunks = [];
      let size = 0;
      const limit = 4 * 1024 * 1024;
      const fail = (code, message) => {
        reject(gatewayError(code, message));
        stream.close();
      };
      let status;
      stream.on("response", (headers) => {
        status = headers[":status"];
        if (status !== 200) fail("GATEWAY_ASSET_STATUS", `EveJS's achievement CDN answered ${status}.`);
      });
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) fail("GATEWAY_ASSET_TOO_LARGE", "EveJS's achievement definitions exceed 4 MiB.");
        else chunks.push(chunk);
      });
      stream.on("end", () => {
        if (status === 200 && size <= limit) resolve(Buffer.concat(chunks, size));
        else fail("GATEWAY_ASSET_STATUS", "EveJS did not return the achievement definitions.");
      });
      stream.setTimeout(timeoutMs, () => fail("GATEWAY_TIMEOUT", "EveJS's achievement CDN timed out."));
      stream.on("error", (error) => reject(gatewayError("GATEWAY_UNREACHABLE", error.message)));
      stream.on("close", () => reject(gatewayError("GATEWAY_CLOSED", "EveJS closed the achievement CDN response.")));
      stream.end();
    });
  }

  function close() {
    for (const key of [...lines.keys()]) closeLine(key);
  }

  return { request, consume, achievementDefinitions, close, STATUS_OK };
}

module.exports = { STATUS_OK, createPublicGateway, eveProtoSchema, noticeTargetMatches, publicGatewayUrl };
