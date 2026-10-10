// Browser-side TS callMethod client (goal R1b).
//
// Mirrors the retail call tuple (service, method, args, kwargs) and drives it
// through the R1 BFF proxy route POST /api/bridge/call
// (docs/bridge-wire-contract.md). The BFF requires the signed web login
// session — since R42 the tab's own `Authorization: Bearer` token, with the
// same-origin cookie as the migration fallback — and pins the bridge session
// identity to the logged-in account.

import { sessionAuthHeaders, tokenAuthHeaders } from "../app/sessionToken.ts";
import { pageCarries, pageFetch } from "../app/pageFetch.ts";
import {
  TransportQueueError,
  bridgeLane,
  type RequestPriority,
} from "../app/transport.ts";
import type {
  BridgeCallRequestBody,
  BridgeCallSuccessBody,
  BridgeErrorCode,
  BridgeNotification,
  CallArgs,
  CallKwargs,
  JsonValue,
  SessionFields,
} from "./wire.ts";

export interface BridgeCallOutcome<TResult = JsonValue> {
  readonly service: string;
  readonly method: string;
  readonly result: TResult;
  readonly notifications: readonly BridgeNotification[];
  /** The server's clock when this was answered, in milliseconds, where the answer said (wire.ts); else null. */
  readonly serverNowMs: number | null;
}

export interface CallMethodOptions {
  /** Safe language preferences only; identity and gameplay state are server-held. */
  readonly session?: SessionFields;
  /** Base URL prefix; default "" (same-origin against the BFF). */
  readonly baseUrl?: string;
  /** Injectable fetch for tests; default globalThis.fetch. */
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  /**
   * R107 multibox — this call's OWN session token. Same contract as
   * `ApiOptions.token` in app/api.ts: when the KEY is present the call is
   * per-session (Bearer with exactly this token, or no header when null, never
   * the global fallback); when absent it rides the per-tab global as before.
   * Character-scoped bridge helpers (bridge/stationPanel.ts,
   * bridge/characterSelection.ts) forward the flow's call options here, so this
   * route must honor it or a background pilot's station reads would run as
   * whoever last wrote the shared cookie.
   */
  readonly token?: string | null;
  /** R92 — lane priority; defaults to "read". See app/transport.ts. */
  readonly priority?: RequestPriority;
  readonly captureRequestGuard?: () => () => void;
  /** The call is a pilot's (wire.ts, BridgeCallRequestBody.pilot): with no pilot held it is refused as NO_LIVE_SESSION. */
  readonly pilot?: boolean;
  /** The call is a write the page means (wire.ts, BridgeCallRequestBody.confirm). */
  readonly confirm?: boolean;
  /** What the object this call is made on is for (wire.ts, BridgeCallRequestBody.of). */
  readonly of?: JsonValue;
}

/** Client-side (non-server) failure codes, alongside the wire's BridgeErrorCode set. */
export type BridgeClientErrorCode = "BRIDGE_NETWORK_ERROR" | "BRIDGE_BAD_RESPONSE" | "SESSION_REQUEST_RETIRED"
  | "CANCELLED_LOGIN_RELEASE_UNVERIFIED";

export class BridgeCallError extends Error {
  override readonly name = "BridgeCallError";
  readonly code: BridgeErrorCode | BridgeClientErrorCode;
  /** HTTP status of the response; 0 when the request never completed. */
  readonly status: number;
  /**
   * R92 — for a TRANSPORT failure, what the client's request lane looked like
   * when it happened, in plain language (app/transport.ts).
   *
   * ⚠ SEPARATE FROM `message` BECAUSE THE AUDIENCES ARE DIFFERENT. The message
   * names the route and the underlying abort, which belongs in a console and
   * not in a player's face; this sentence is written to be read by whoever is
   * filing the report, and it is the half that says whether the server ignored
   * the request or the request never got a connection to be sent on.
   */
  readonly diagnosis: string | null;
  /** Exact unpublished login credential retained for a failed cancellation cleanup. */
  readonly cancelledSessionToken: string | null;

  constructor(
    code: BridgeErrorCode | BridgeClientErrorCode,
    message: string,
    status: number,
    diagnosis: string | null = null,
    cancelledSessionToken: string | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.diagnosis = diagnosis;
    this.cancelledSessionToken = cancelledSessionToken;
  }
}

function isSuccessBody(data: unknown): data is BridgeCallSuccessBody<JsonValue> {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { ok?: unknown }).ok === true &&
    typeof (data as { service?: unknown }).service === "string" &&
    typeof (data as { method?: unknown }).method === "string"
  );
}

/**
 * Invoke a whitelisted EveJS service method through the bridge:
 * browser -> POST /api/bridge/call -> gateway /_evejs-web/v1/call ->
 * serviceManager.lookup(service).callMethod(method, args, session, kwargs).
 *
 * Resolves with the handler result plus captured notifications; rejects with
 * BridgeCallError carrying the wire error code (CALL_NOT_ALLOWED, ...) or a
 * client-side code (BRIDGE_NETWORK_ERROR / BRIDGE_BAD_RESPONSE).
 */
export async function callMethod<TResult = JsonValue>(
  service: string,
  method: string,
  args: CallArgs = [],
  kwargs: CallKwargs = null,
  options: CallMethodOptions = {},
): Promise<BridgeCallOutcome<TResult>> {
  // Over HTTP, or on the tab's socket where the page is set to (app/pageFetch.ts). A fetch handed in is used as it is.
  const doFetch = options.fetch ?? pageFetch();
  const assertCurrent = options.captureRequestGuard?.();
  const authHeaders = "token" in options ? tokenAuthHeaders(options.token) : sessionAuthHeaders();
  const credentials = "token" in options ? "omit" : "same-origin";
  const body: BridgeCallRequestBody = {
    service,
    method,
    args,
    kwargs,
    ...(options.session ? { session: options.session } : {}),
    ...(options.pilot === true ? { pilot: true as const } : {}),
    ...(options.confirm === true ? { confirm: true as const } : {}),
    ...(options.of !== undefined ? { of: options.of } : {}),
  };

  let response: Response;
  try {
    // R92 — the SECOND fetch site in the client shares the one request lane, or
    // the cap would only bound half of what the tab does. See app/transport.ts.
    const url = `${options.baseUrl ?? ""}/api/bridge/call`;
    const request: RequestInit = {
      method: "POST",
      // R42/R107 — explicit sessions omit shared cookies. This route is
      // the second fetch site in the client (api.ts's requestJson is the other),
      // so it needs the header too or character selection and the station panel
      // would silently run as whoever last wrote the cookie. Per-session (token
      // key present) uses this flow's token; otherwise the per-tab global.
      headers: {
        ...authHeaders,
        "content-type": "application/json",
      },
      credentials,
      body: JSON.stringify(body),
    };
    response = await bridgeLane.run(options.priority ?? "read", "/api/bridge/call", () => {
      assertCurrent?.();
      return doFetch(url, {
        ...request,
        // The same 65 s browser-side deadline as api.ts requestJson (see the
        // note there): a half-dead socket must abort into BRIDGE_NETWORK_ERROR
        // rather than freeze the awaiting loop forever. A caller's own signal
        // still wins.
        signal: options.signal ?? AbortSignal.timeout(65_000),
      });
      // A call that goes on the tab's open socket holds none of the browser's connections, and so no lane.
    }, { carried: options.fetch === undefined && pageCarries(url, request) });
  } catch (cause) {
    assertCurrent?.();
    if (cause instanceof BridgeCallError && cause.code === "SESSION_REQUEST_RETIRED") throw cause;
    const diagnosis =
      cause instanceof TransportQueueError ? cause.diagnosis.verdict : bridgeLane.diagnose().verdict;
    throw new BridgeCallError(
      "BRIDGE_NETWORK_ERROR",
      cause instanceof TransportQueueError
        ? cause.message
        : `Bridge call ${service}.${method} could not reach the BFF: ${
            cause instanceof Error ? cause.message : String(cause)
          } — ${diagnosis}`,
      0,
      diagnosis,
    );
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    assertCurrent?.();
    throw new BridgeCallError(
      "BRIDGE_BAD_RESPONSE",
      `Bridge call ${service}.${method} returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  assertCurrent?.();
  if (typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === false) {
    const errorBody = data as { error?: unknown; message?: unknown };
    throw new BridgeCallError(
      typeof errorBody.error === "string" ? errorBody.error : "BRIDGE_BAD_RESPONSE",
      typeof errorBody.message === "string"
        ? errorBody.message
        : `Bridge call ${service}.${method} failed (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (!response.ok || !isSuccessBody(data)) {
    throw new BridgeCallError(
      "BRIDGE_BAD_RESPONSE",
      `Bridge call ${service}.${method} returned an unexpected envelope (HTTP ${response.status}).`,
      response.status,
    );
  }

  return {
    service: data.service,
    method: data.method,
    result: (data.result === undefined ? null : data.result) as TResult,
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    // (A number that came as JSON is a finite one.)
    serverNowMs: typeof data.serverNowMs === "number" ? data.serverNowMs : null,
  };
}
