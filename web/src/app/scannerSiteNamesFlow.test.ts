// flow.scannerSiteNames: the Scanner window's anomaly names, read as the
// site-warp blocks read them (issue 186). The client's words first; a message
// they have no text for is asked of the server's own site packs
// (/api/site-names), once.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function harness(
  clientMessages: Record<string, string | null>,
  packNames: Record<string, string | null>,
  { clientAvailable = true, packsAvailable = true } = {},
) {
  const requests: Recorded[] = [];
  const fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ path, body });
    let answer: unknown;
    if (path === "/api/words") {
      const ids = Array.isArray(body.messageIDs) ? body.messageIDs as number[] : [];
      answer = {
        ok: true,
        available: clientAvailable,
        words: {},
        messages: Object.fromEntries(ids.map((id) => [String(id), clientAvailable ? clientMessages[String(id)] ?? null : null])),
        dialogs: {},
      };
    } else if (path === "/api/site-names") {
      const ids = Array.isArray(body.messageIDs) ? body.messageIDs as number[] : [];
      answer = {
        ok: true,
        available: packsAvailable,
        names: Object.fromEntries(ids.map((id) => [String(id), packsAvailable ? packNames[String(id)] ?? null : null])),
      };
    } else {
      throw new Error(`unexpected ${path}`);
    }
    return { ok: true, status: 200, async json() { return answer; } };
  }) as unknown as typeof globalThis.fetch;
  const flow = createAppFlow(createClientStore(), { fetch });
  return { flow, requests };
}

test("an install with no client names its anomalies from the server's site packs", async () => {
  const { flow, requests } = harness({}, { "1001": "Sansha Den", "1002": "Drone Cluster" }, { clientAvailable: false });

  const names = await flow.scannerSiteNames([1001, 1002, 1003, 1001]);

  assert.equal(names.get(1001), "Sansha Den");
  assert.equal(names.get(1002), "Drone Cluster");
  assert.equal(names.get(1003), null, "a message no pack names is read, and nameless");
  const asked = requests.filter((r) => r.path === "/api/site-names");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]?.body.messageIDs, [1001, 1002, 1003]);
});

test("the client's words win, and the server is asked only for what they do not name, once", async () => {
  const { flow, requests } = harness({ "1001": "Sansha Den" }, { "1001": "Wrong", "1002": "Drone Cluster" });

  const first = await flow.scannerSiteNames([1001, 1002]);
  assert.equal(first.get(1001), "Sansha Den");
  assert.equal(first.get(1002), "Drone Cluster");
  const again = await flow.scannerSiteNames([1001, 1002]);
  assert.equal(again.get(1002), "Drone Cluster");

  const asked = requests.filter((r) => r.path === "/api/site-names");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]?.body.messageIDs, [1002]);
});

test("a window asking while another ask is on its way waits for it, and the server is asked once", async () => {
  const { flow, requests } = harness({}, { "1001": "Sansha Den" }, { clientAvailable: false });

  const [first, second] = await Promise.all([flow.scannerSiteNames([1001]), flow.scannerSiteNames([1001])]);

  assert.equal(first.get(1001), "Sansha Den");
  assert.equal(second.get(1001), "Sansha Den");
  assert.equal(requests.filter((r) => r.path === "/api/site-names").length, 1);
});

test("with no pack to read, a name is not called nameless: it is left unread", async () => {
  const { flow } = harness({}, {}, { clientAvailable: false, packsAvailable: false });

  const names = await flow.scannerSiteNames([1001]);

  assert.equal(names.has(1001), false);
});
