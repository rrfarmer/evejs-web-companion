// R108 slice 3: reading the PI roster's colonies — one throwaway sign-in per
// account, never a character select.
//
// What is checked, and why each matters:
//
//   1. NOTHING IS SELECTED. The read signs an account in on a token of its own,
//      asks the roster route, and signs out. The deps below have no way to
//      select a character at all, which is the point: a select claims a hull,
//      and a tab-run bot elsewhere would lose its ship without a word.
//
//   2. EVERY TOKEN IS SIGNED OUT, including when the read fails.
//
//   3. ONE ACCOUNT AT A TIME, the hangar refresh's reason: a dozen sign-ins at
//      once fill the browser's connection pool ahead of the player's clicks.
//
//   4. EACH PILOT GETS ITS OWN OUTCOME, so the board can word each one.

import test from "node:test";
import assert from "node:assert/strict";

import { readPiRoster, type PiReadDeps } from "../lib/piRosterRead.ts";
import type { JsonValue } from "../../../web/src/bridge/wire.ts";

const A1 = 90000001;
const A2 = 90000002;
const B1 = 90000011;
const C1 = 90000021;
const ORPHAN = 90000031;

const KNOWN = [
  { characterID: A1, accountName: "alpha" },
  { characterID: A2, accountName: "alpha" },
  { characterID: B1, accountName: "bravo" },
  { characterID: C1, accountName: "charlie" },
];

interface Log {
  events: string[];
  inFlight: number;
  maxInFlight: number;
}

function deps(
  options: {
    refuseSignIn?: string[];
    failLoadFor?: string[];
    leaveOut?: number[];
    failRecipes?: boolean;
  } = {},
): PiReadDeps & { log: Log } {
  const log: Log = { events: [], inFlight: 0, maxInFlight: 0 };
  return {
    log,
    async signIn(accountName) {
      log.inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.refuseSignIn?.includes(accountName)) {
        log.inFlight -= 1;
        log.events.push(`refused:${accountName}`);
        throw new Error("sign-in refused");
      }
      log.events.push(`signIn:${accountName}`);
      return `token-${accountName}`;
    },
    async signOut(token) {
      log.inFlight -= 1;
      log.events.push(`signOut:${token}`);
    },
    async loadRosterPlanets(characterIDs, token) {
      log.events.push(`load:${token}:${characterIDs.join(",")}`);
      if (options.failLoadFor?.some((name) => token === `token-${name}`)) {
        throw new Error("gateway timed out");
      }
      return {
        ok: true,
        serverNowMs: 1000,
        pilots: characterIDs
          .filter((id) => !options.leaveOut?.includes(id))
          .map((characterID) => ({ characterID, readAtMs: 900, coloniesReadable: true, colonies: [] })),
      } as JsonValue;
    },
    now: () => 2000,
    async loadRecipes(token) {
      log.events.push(`recipes:${token}`);
      if (options.failRecipes) throw new Error("no table");
      return { schematics: [] } as JsonValue;
    },
  };
}

test("the recipe table is read once, on the first account that signs in", async () => {
  const d = deps({ refuseSignIn: ["alpha"] });
  const tables: JsonValue[] = [];
  await readPiRoster([A1, B1, C1], KNOWN, d, undefined, { onRecipes: (raw) => tables.push(raw) });
  assert.deepEqual(d.log.events.filter((event) => event.startsWith("recipes:")), ["recipes:token-bravo"]);
  assert.equal(tables.length, 1);
  // Read inside the sign-in, before its token is signed out.
  const events = d.log.events;
  assert.ok(events.indexOf("recipes:token-bravo") < events.indexOf("signOut:token-bravo"));
});

test("the recipe table is optional: not asked for, not read; failing, not fatal", async () => {
  const quiet = deps();
  await readPiRoster([A1], KNOWN, quiet);
  assert.equal(quiet.log.events.some((event) => event.startsWith("recipes:")), false);

  const failing = deps({ failRecipes: true });
  let delivered = 0;
  const results = await readPiRoster([A1], KNOWN, failing, undefined, { onRecipes: () => (delivered += 1) });
  assert.equal(delivered, 0);
  assert.deepEqual([...results[0]!.attempts], [[A1, "read"]]);
});

test("each account is signed in once, asked once, and signed out", async () => {
  const d = deps();
  const results = await readPiRoster([A1, B1, A2], KNOWN, d);
  assert.deepEqual(d.log.events, [
    "signIn:alpha",
    "load:token-alpha:90000001,90000002",
    "signOut:token-alpha",
    "signIn:bravo",
    "load:token-bravo:90000011",
    "signOut:token-bravo",
  ]);
  assert.deepEqual(results.map((result) => result.accountName), ["alpha", "bravo"]);
  assert.equal(results[0]!.answers.length, 1);
  assert.equal(results[0]!.answers[0]!.browserNowMs, 2000);
  assert.deepEqual([...results[0]!.attempts], [[A1, "read"], [A2, "read"]]);
});

test("⚠ one account at a time, never two sign-ins in flight", async () => {
  const d = deps();
  await readPiRoster([A1, B1, C1], KNOWN, d);
  assert.equal(d.log.maxInFlight, 1);
});

test("a pilot the answer left out is unanswered; the rest are read", async () => {
  const results = await readPiRoster([A1, A2], KNOWN, deps({ leaveOut: [A2] }));
  assert.deepEqual([...results[0]!.attempts], [[A1, "read"], [A2, "unanswered"]]);
});

test("⚠ a refused sign-in fails that account's pilots only, and the next account is still read", async () => {
  const d = deps({ refuseSignIn: ["alpha"] });
  const results = await readPiRoster([A1, A2, B1], KNOWN, d);
  assert.deepEqual([...results[0]!.attempts], [[A1, "failed"], [A2, "failed"]]);
  assert.deepEqual(results[0]!.answers, []);
  assert.deepEqual([...results[1]!.attempts], [[B1, "read"]]);
  // Nothing was signed in for alpha, so nothing is signed out for it.
  assert.equal(d.log.events.includes("signOut:token-alpha"), false);
});

test("⚠ a failed read still signs its token out", async () => {
  const d = deps({ failLoadFor: ["bravo"] });
  const results = await readPiRoster([B1], KNOWN, d);
  assert.deepEqual([...results[0]!.attempts], [[B1, "failed"]]);
  assert.deepEqual(d.log.events.slice(-1), ["signOut:token-bravo"]);
});

test("a pilot the hangar does not know has no account to read with", async () => {
  const d = deps();
  const results = await readPiRoster([ORPHAN, B1], KNOWN, d);
  const orphan = results.find((result) => result.accountName === null)!;
  assert.deepEqual([...orphan.attempts], [[ORPHAN, "no-account"]]);
  assert.equal(d.log.events.some((event) => event.includes(String(ORPHAN))), false);
});

test("more pilots on one account than one ask carries are asked in chunks, on one sign-in", async () => {
  const many = Array.from({ length: 14 }, (_, index) => 90000100 + index);
  const known = many.map((characterID) => ({ characterID, accountName: "big" }));
  const d = deps();
  const results = await readPiRoster(many, known, d);
  assert.deepEqual(
    d.log.events.map((event) => event.split(":")[0]),
    ["signIn", "load", "load", "signOut"],
  );
  assert.equal(results[0]!.answers.length, 2);
  assert.equal([...results[0]!.attempts.values()].every((attempt) => attempt === "read"), true);
});

test("each account is reported as it finishes, so the board can repaint early", async () => {
  const seen: string[] = [];
  await readPiRoster([A1, B1], KNOWN, deps(), (result) => {
    seen.push(String(result.accountName));
  });
  assert.deepEqual(seen, ["alpha", "bravo"]);
});

test("an empty roster reads nothing and signs nobody in", async () => {
  const d = deps();
  assert.deepEqual(await readPiRoster([], KNOWN, d), []);
  assert.deepEqual(d.log.events, []);
});
