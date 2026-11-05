import test from "node:test";
import assert from "node:assert/strict";
import { readBotDivisionNames } from "../lib/piHaulNames.ts";
import { loadBotCorpDivisionNames } from "../../../web/src/app/api.ts";
import { getSessionToken, setSessionToken, setSessionTokenStorage } from "../../../web/src/app/sessionToken.ts";

test("bot name reads authenticate as each pilot's account without replacing the tab token", async () => {
  const originalFetch = globalThis.fetch;
  setSessionTokenStorage(null);
  setSessionToken("tab-session");
  const calls: { path: string; auth: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://test.invalid");
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname, auth });
    if (url.pathname === "/api/login") {
      const body = JSON.parse(String(init?.body));
      assert.equal(auth, null);
      return Response.json({ ok: true, accountID: 1, username: body.username, sessionToken: `token-${body.username}` });
    }
    if (url.pathname === "/api/logout") return Response.json({ ok: true });
    assert.equal(url.pathname, "/api/bots/corp-division-names");
    const id = Number(url.searchParams.get("characterID"));
    const expected = id === 1 || id === 2 ? "Bearer token-alpha" : "Bearer token-beta";
    if (auth !== expected || id === 2) return Response.json({ ok: false, error: "NO_BOT_SESSION", message: "No bot of this account is flying this pilot." }, { status: 409 });
    return Response.json({ ok: true, corporationID: 98000000 + id, divisions: [{ division: 3, name: id === 1 ? "Industry" : "Materials" }] });
  };
  try {
    // The PR-head caller used the tab/default account; the account-gated API
    // refuses that same reachable request for a bot of another account.
    await assert.rejects(() => loadBotCorpDivisionNames(1), /No bot of this account/);
    calls.length = 0;
    const reads = await readBotDivisionNames([
      { characterID: 1, accountName: "alpha" },
      { characterID: 2, accountName: "alpha" },
      { characterID: 3, accountName: "beta" },
    ]);
    assert.deepEqual(reads.map((read) => read.characterID), [1, 3]);
    assert.equal(reads[0]?.divisions[0]?.name, "Industry");
    assert.equal(reads[1]?.divisions[0]?.name, "Materials");
    assert.deepEqual(calls.map((call) => call.auth), [null, "Bearer token-alpha", "Bearer token-alpha", "Bearer token-alpha", null, "Bearer token-beta", "Bearer token-beta"]);
    assert.equal(getSessionToken(), "tab-session");
  } finally {
    globalThis.fetch = originalFetch;
    setSessionToken(null);
  }
});

test("failed sign-ins and bot reads do not prevent later accounts, and signed-in tokens are released", async () => {
  const signedOut: string[] = [];
  const reads = await readBotDivisionNames([
    { characterID: 1, accountName: "unavailable" },
    { characterID: 2, accountName: "lost-bot" },
    { characterID: 3, accountName: "available" },
  ], {
    async signIn(accountName) {
      if (accountName === "unavailable") throw new Error("refused");
      return accountName;
    },
    async signOut(token) { signedOut.push(token); },
    async read(characterID) {
      if (characterID === 2) throw new Error("bot ended");
      return { corporationID: 98000001, divisions: [{ division: 1, name: "Industry" }] };
    },
  });
  assert.deepEqual(reads.map((read) => read.characterID), [3]);
  assert.deepEqual(signedOut, ["lost-bot", "available"]);
});
