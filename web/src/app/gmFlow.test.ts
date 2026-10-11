// The operator's console: a GM's command sent by the page's own call, and what it could have changed read again.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A stand-in BFF that answers the console's call as told, and everything else with a bare ok. */
function standIn(answer: { status: number; body: unknown }) {
  const requests: Recorded[] = [];
  const fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method: (init && init.method) || "GET", body });
    const outcome = path === "/api/bridge/call" && body.service === "slash" ? answer : { status: 200, body: { ok: true } };
    return { ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, async json() { return outcome.body; } };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
const said = (result: unknown) => ({ status: 200, body: { ok: true, service: "slash", method: "SlashCmd", result, notifications: [] } });
/** sm.RemoteSvc('slash').SlashCmd(line), as a pilot's write the page means. */
const theCommand = (line: string) => ({ service: "slash", method: "SlashCmd", args: [line], kwargs: null, pilot: true, confirm: true });

test("the console's command goes by the page's own call, its reply comes back as the world said it, and the panels are read again", async () => {
  const { fetch, requests } = standIn(said("Gave 1 x Tritanium."));
  const flow = createAppFlow(createClientStore(), { fetch });

  assert.equal(await flow.runGmCommand("  /giveitem 34 1 "), "Gave 1 x Tritanium.");

  assert.deepEqual(requests.filter((r) => r.path === "/api/bridge/call" && r.body.service === "slash").map((r) => r.body), [theCommand("/giveitem 34 1")]);
  assert.equal(requests.some((r) => r.path === "/api/bridge/gm/slash"), false, "the route is not asked");
  // The call first; then what a command could have changed: the hangar among it.
  assert.deepEqual(requests[0], { path: "/api/bridge/call", method: "POST", body: theCommand("/giveitem 34 1") });
  assert.equal(requests.slice(1).some((r) => r.path === "/api/bridge/inventory" && r.method === "GET"), true);
});

test("a reply that is no text is none, and the panels are still read again", async () => {
  const { fetch, requests } = standIn(said(null));
  const flow = createAppFlow(createClientStore(), { fetch });

  assert.equal(await flow.runGmCommand("/heal"), "");
  assert.equal(requests.some((r) => r.path === "/api/bridge/inventory"), true);
});

test("what is no command asks the server nothing at all", async () => {
  const { fetch, requests } = standIn(said("never"));
  const flow = createAppFlow(createClientStore(), { fetch });

  await assert.rejects(flow.runGmCommand("giveitem 34 1"), /A GM command starts with \//);
  await assert.rejects(flow.runGmCommand("   "), /A command is required\./);
  assert.deepEqual(requests, []);
});

test("a command the server refuses outright says so in the server's words, and nothing is read again for it", async () => {
  const { fetch, requests } = standIn({ status: 409, body: { ok: false, error: "CALL_REFUSED", message: "Commands: ['/help', '/heal']" } });
  const flow = createAppFlow(createClientStore(), { fetch });

  await assert.rejects(flow.runGmCommand("/"), /Commands: \['\/help', '\/heal'\]/);
  assert.deepEqual(requests.map((r) => r.path), ["/api/bridge/call"]);
});
