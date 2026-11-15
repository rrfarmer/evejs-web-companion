// The Bot Builder's flow with nobody in the client (builderFlow.ts): what it
// asks the server, as whom, and what it answers without asking.

import test from "node:test";
import assert from "node:assert/strict";
import type { ApiOptions } from "../app/api.ts";
import type { AppFlow } from "../app/flow.ts";
import { createPilotlessBuilderFlow, NO_PILOT_FOR_CORP_OFFICES, type BuilderFlow } from "./builderFlow.ts";

interface Seen {
  readonly url: string;
  readonly auth: string | null;
}

/** Account options whose fetch records every call and answers `body`. */
function accountOptions(body: unknown, seen: Seen[]): () => Promise<ApiOptions> {
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), auth: headers.get("authorization") });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return async () => ({ fetch: fetchStub, token: "account-pass-token" });
}

test("a pilot's flow is already a BuilderFlow, so the desktop builder is unchanged", () => {
  // Compile-time: if this stops type-checking, the Builder no longer accepts
  // the flow every pilot's desktop hands it.
  const accepts = (flow: AppFlow): BuilderFlow => flow;
  assert.equal(typeof accepts, "function");
});

test("library calls ride the account sign-in", async () => {
  const seen: Seen[] = [];
  const options = accountOptions({}, seen);
  const flow = createPilotlessBuilderFlow(options);
  assert.equal((await flow.requestOptions()).token, "account-pass-token");
});

test("the station search asks as the account, and counts no jumps from nowhere", async () => {
  const seen: Seen[] = [];
  const match = { kind: "station", id: 60000001, name: "A station", solarSystemID: 30000001, solarSystemName: "A system" };
  const flow = createPilotlessBuilderFlow(accountOptions({ ok: true, matches: [match] }, seen));
  const results = await flow.searchDestinations("a sta", "station");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.url, /\/api\/map\/find\?/);
  assert.equal(seen[0]!.auth, "Bearer account-pass-token");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.name, "A station");
  assert.equal(results[0]!.jumps, null);
});

test("a dockable search asks for stations, and no structures nobody could dock at", async () => {
  const seen: Seen[] = [];
  const flow = createPilotlessBuilderFlow(accountOptions({ ok: true, matches: [] }, seen));
  await flow.searchDestinations("a sta", "dockable");
  assert.equal(seen.length, 1, "a structure read was made with no pilot to ask about");
  assert.match(seen[0]!.url, /\/api\/map\/find\?.*kind=station/);
});

test("a one-letter search is not sent at all, same as a pilot's", async () => {
  const seen: Seen[] = [];
  const flow = createPilotlessBuilderFlow(accountOptions({ ok: true, matches: [] }, seen));
  assert.deepEqual(await flow.searchDestinations(" a "), []);
  assert.equal(seen.length, 0);
});

test("ore families are static data, read as the account", async () => {
  const seen: Seen[] = [];
  const families = [{ groupID: 1, name: "An ore" }];
  const flow = createPilotlessBuilderFlow(accountOptions({ ok: true, families }, seen));
  assert.deepEqual(await flow.listOreFamilies(), families);
  assert.match(seen[0]!.url, /\/api\/ore\/families$/);
});

test("a character's fittings and bookmarks are empty, and nothing is asked for them", async () => {
  const seen: Seen[] = [];
  const flow = createPilotlessBuilderFlow(accountOptions({}, seen));
  assert.deepEqual(await flow.listSavedFittings(), []);
  assert.deepEqual(await flow.listBookmarks(), []);
  assert.equal(seen.length, 0);
});

test("corp offices are 'could not check', never 'no offices'", async () => {
  // An empty answer with no error would tell the player their corporation has
  // no hangars, which nobody checked.
  const flow = createPilotlessBuilderFlow(accountOptions({}, []));
  const result = await flow.loadCorpOffices();
  assert.deepEqual(result.divisions, []);
  assert.equal(result.error, NO_PILOT_FOR_CORP_OFFICES);
});

test("the agent finder's corporations are static data, read as the account", async () => {
  // The finder's corporation list needs no pilot: with none in the client the
  // step could otherwise only ever search every corporation.
  const seen: Seen[] = [];
  const flow = createPilotlessBuilderFlow(accountOptions({ ok: true, agents: [] }, seen));
  const result = await flow.loadAgentCorporations("courier");
  assert.equal(result.error, null);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((call) => /\/api\/agents\/find\?/.test(call.url) && call.auth === "Bearer account-pass-token"));
});

test("no account to sign in is said in the corporation picker, not a bare failure", async () => {
  const flow = createPilotlessBuilderFlow(async () => {
    throw new Error("No account this browser knows could be signed in.");
  });
  const result = await flow.loadAgentCorporations("encounter");
  assert.deepEqual(result.corporations, []);
  assert.match(result.error ?? "", /No account/);
});

test("no account to sign in is an error the caller sees, not an empty library", async () => {
  const flow = createPilotlessBuilderFlow(async () => {
    throw new Error("No account this browser knows could be signed in.");
  });
  await assert.rejects(async () => flow.requestOptions(), /No account/);
});
