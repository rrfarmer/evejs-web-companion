// R103 Phase-4 client wrapper for one of the bound-beyonce writes: jumpThroughFleet
// (CmdJumpThroughFleet). The route is requireWriteConfirmation-gated at the
// BFF, so the point of these tests is the body the wrapper sends — confirm
// missing means a 400 CONFIRMATION_REQUIRED in the real server — plus that the
// uniform ack decodes through bridge/boundBeyonceWrites.ts unchanged.
//
// The other, the fleet's target tag (CmdFleetTagTarget), the page makes itself
// since 2026-10-10: its tests are beside bridge/fleetWrites.ts.

import test from "node:test";
import assert from "node:assert/strict";

import { jumpThroughFleet } from "./api.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(reply: (path: string, method: string, body: unknown) => Response) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    return reply(path, method, body);
  }) as unknown as typeof fetch;
  return { fetch: fake, requests };
}

test("jumpThroughFleet posts otherCharID/otherShipID/beaconID/solarSystemID + confirm:true", async () => {
  const { fetch, requests } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000143 }, notifications: [] }),
  );

  await jumpThroughFleet(90000001, 2002, 3003, 30000143, { fetch, token: "t" });

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.path, /\/api\/bridge\/flight\/jump-through-fleet$/);
  assert.equal(requests[0]!.method, "POST");
  assert.deepEqual(requests[0]!.body, {
    otherCharID: 90000001,
    otherShipID: 2002,
    beaconID: 3003,
    solarSystemID: 30000143,
    confirm: true,
  });
});

test("jumpThroughFleet decodes the uniform ack", async () => {
  const { fetch } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000143 }, notifications: [] }),
  );

  const ack = await jumpThroughFleet(90000001, 2002, 3003, 30000143, { fetch, token: "t" });

  assert.deepEqual(ack, {
    ok: true,
    applied: true,
    result: null,
    flight: { solarSystemID: 30000143 },
  });
});
