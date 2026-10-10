// Unit tests for the browser-side TS callMethod client (goal R1b), with a
// stubbed fetch. The wire shapes mirror docs/bridge-wire-contract.md.

import test from "node:test";
import assert from "node:assert/strict";

import { BridgeCallError, callMethod } from "./callMethod.ts";
import type { JsonValue } from "./wire.ts";

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, JsonValue>;
}

function stubFetch(
  respond: (recorded: RecordedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded: RecordedRequest = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "null")) as Record<string, JsonValue>,
    };
    requests.push(recorded);
    return respond(recorded);
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("callMethod POSTs the retail call tuple to /api/bridge/call with same-origin credentials", async () => {
  const { fetch, requests } = stubFetch(() =>
    jsonResponse({
      ok: true,
      service: "map",
      method: "GetStationInfo",
      result: null,
      notifications: [],
    }),
  );

  await callMethod("map", "GetStationInfo", [60000004], { verbose: true }, { fetch });

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.url, "/api/bridge/call");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.credentials, "same-origin");
  assert.deepEqual(request.body, {
    service: "map",
    method: "GetStationInfo",
    args: [60000004],
    kwargs: { verbose: true },
  });
});

test("args default to [] and kwargs to null; safe language preferences ride along", async () => {
  const { fetch, requests } = stubFetch(() =>
    jsonResponse({
      ok: true,
      service: "charUnboundMgr",
      method: "GetCharacterSelectionData",
      result: null,
      notifications: [],
    }),
  );

  await callMethod("charUnboundMgr", "GetCharacterSelectionData", undefined, undefined, {
    fetch,
    session: { languageID: "EN" },
  });

  assert.deepEqual(requests[0]?.body, {
    service: "charUnboundMgr",
    method: "GetCharacterSelectionData",
    args: [],
    kwargs: null,
    session: { languageID: "EN" },
  });
});

test("a success envelope resolves to the typed outcome with notifications", async () => {
  const notifications = [
    { service: "onSomething", method: "OnEvent", args: [1], kwargs: null },
  ];
  const { fetch } = stubFetch(() =>
    jsonResponse({
      ok: true,
      service: "charUnboundMgr",
      method: "GetCharacterSelectionData",
      result: [1, 2, 3, 4],
      notifications,
    }),
  );

  const outcome = await callMethod<readonly number[]>(
    "charUnboundMgr",
    "GetCharacterSelectionData",
    [],
    null,
    { fetch },
  );
  assert.equal(outcome.service, "charUnboundMgr");
  assert.equal(outcome.method, "GetCharacterSelectionData");
  assert.deepEqual(outcome.result, [1, 2, 3, 4]);
  assert.deepEqual(outcome.notifications, notifications);
});

test("a wire error envelope rejects with its code, status, and message", async () => {
  const { fetch } = stubFetch(() =>
    jsonResponse(
      {
        ok: false,
        error: "CALL_NOT_ALLOWED",
        message: "The (service, method) pair is not allowlisted.",
      },
      403,
    ),
  );

  await assert.rejects(
    callMethod("charUnboundMgr", "DeleteCharacter", [91], null, { fetch }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeCallError);
      assert.equal(error.code, "CALL_NOT_ALLOWED");
      assert.equal(error.status, 403);
      assert.match(error.message, /not allowlisted/);
      return true;
    },
  );
});

test("an unauthenticated BFF response surfaces AUTH_REQUIRED", async () => {
  const { fetch } = stubFetch(() =>
    jsonResponse({ ok: false, error: "AUTH_REQUIRED", message: "Sign in first." }, 401),
  );
  await assert.rejects(
    callMethod("map", "GetStationInfo", [], null, { fetch }),
    (error: unknown) =>
      error instanceof BridgeCallError &&
      error.code === "AUTH_REQUIRED" &&
      error.status === 401,
  );
});

test("a network failure rejects with BRIDGE_NETWORK_ERROR and status 0", async () => {
  const failingFetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;

  await assert.rejects(
    callMethod("map", "GetStationInfo", [], null, { fetch: failingFetch }),
    (error: unknown) =>
      error instanceof BridgeCallError &&
      error.code === "BRIDGE_NETWORK_ERROR" &&
      error.status === 0,
  );
});

test("non-JSON and malformed envelopes reject with BRIDGE_BAD_RESPONSE", async () => {
  const { fetch: htmlFetch } = stubFetch(
    () => new Response("<html>gateway exploded</html>", { status: 502 }),
  );
  await assert.rejects(
    callMethod("map", "GetStationInfo", [], null, { fetch: htmlFetch }),
    (error: unknown) =>
      error instanceof BridgeCallError &&
      error.code === "BRIDGE_BAD_RESPONSE" &&
      error.status === 502,
  );

  const { fetch: weirdFetch } = stubFetch(() => jsonResponse({ unexpected: true }));
  await assert.rejects(
    callMethod("map", "GetStationInfo", [], null, { fetch: weirdFetch }),
    (error: unknown) =>
      error instanceof BridgeCallError && error.code === "BRIDGE_BAD_RESPONSE",
  );
});

test("a call made for a pilot says it is one, and no other call does", async () => {
  const { fetch, requests } = stubFetch(() => jsonResponse({ ok: true, service: "account", method: "GetCashBalance", result: 42, notifications: [] }));
  await callMethod("account", "GetCashBalance", [0], null, { fetch, pilot: true });
  await callMethod("account", "GetCashBalance", [0], null, { fetch, pilot: false });
  await callMethod("account", "GetCashBalance", [0], null, { fetch });
  assert.deepEqual(requests.map((request) => request.body), [
    { service: "account", method: "GetCashBalance", args: [0], kwargs: null, pilot: true },
    { service: "account", method: "GetCashBalance", args: [0], kwargs: null },
    { service: "account", method: "GetCashBalance", args: [0], kwargs: null },
  ]);
});

test("an answer that says the server's clock has it handed on, and one that does not, or says what is no time, has none", async () => {
  const answering = (more: Record<string, unknown>) => stubFetch(() => jsonResponse({ ok: true, service: "skillHandler", method: "GetSkills", result: null, notifications: [], ...more })).fetch;
  assert.equal((await callMethod("skillHandler", "GetSkills", [], null, { fetch: answering({ serverNowMs: 1_791_636_526_391 }) })).serverNowMs, 1_791_636_526_391);
  for (const more of [{}, { serverNowMs: null }, { serverNowMs: "1791636526391" }, { serverNowMs: [1_791_636_526_391] }]) {
    assert.equal((await callMethod("skillHandler", "GetSkills", [], null, { fetch: answering(more) })).serverNowMs, null, JSON.stringify(more));
  }
});

test("a write the page means says so, and no other call does", async () => {
  const { fetch, requests } = stubFetch(() => jsonResponse({ ok: true, service: "skillHandler", method: "AbortTraining", result: null, notifications: [] }));
  await callMethod("skillHandler", "AbortTraining", [], null, { fetch, pilot: true, confirm: true });
  await callMethod("skillHandler", "AbortTraining", [], null, { fetch, pilot: true, confirm: false });
  await callMethod("skillHandler", "AbortTraining", [], null, { fetch, pilot: true });
  assert.deepEqual(requests.map((request) => request.body), [
    { service: "skillHandler", method: "AbortTraining", args: [], kwargs: null, pilot: true, confirm: true },
    { service: "skillHandler", method: "AbortTraining", args: [], kwargs: null, pilot: true },
    { service: "skillHandler", method: "AbortTraining", args: [], kwargs: null, pilot: true },
  ]);
});

test("a call on a service's own object says what the object is for, and no other call does", async () => {
  const { fetch, requests } = stubFetch(() => jsonResponse({ ok: true, service: "planetMgr", method: "UserUpdateNetwork", result: null, notifications: [] }));
  await callMethod("planetMgr", "UserUpdateNetwork", [[]], null, { fetch, pilot: true, confirm: true, of: 40176368 });
  await callMethod("planetMgr", "UserUpdateNetwork", [[]], null, { fetch, pilot: true, confirm: true });
  await callMethod("planetMgr", "UserUpdateNetwork", [[]], null, { fetch, pilot: true, confirm: true, of: undefined });
  assert.deepEqual(requests.map((request) => request.body), [
    { service: "planetMgr", method: "UserUpdateNetwork", args: [[]], kwargs: null, pilot: true, confirm: true, of: 40176368 },
    { service: "planetMgr", method: "UserUpdateNetwork", args: [[]], kwargs: null, pilot: true, confirm: true },
    { service: "planetMgr", method: "UserUpdateNetwork", args: [[]], kwargs: null, pilot: true, confirm: true },
  ]);
});
