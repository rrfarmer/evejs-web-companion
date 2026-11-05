// R109 slice 4: reading a plan's stock across accounts, with nobody selected.

import test from "node:test";
import assert from "node:assert/strict";

import { readIndustryStock, type IndustryStockDeps } from "./industryStockRead.ts";
import type { CorpStockRead } from "../bridge/stockHoldings.ts";
import type { JsonValue } from "../bridge/wire.ts";

const PILOT_A = 90000001;
const PILOT_B = 90000002;
const PILOT_C = 90000003;
const CORP = 98000001;

function fakeDeps(options: { refuse?: readonly string[]; answer?: (ids: readonly number[]) => JsonValue } = {}) {
  const log: string[] = [];
  const corpAsks: { corps: readonly number[]; kept: boolean[] }[] = [];
  const botsSeen: string[] = [];
  const deps: IndustryStockDeps = {
    async signIn(accountName) {
      log.push(`in:${accountName}`);
      if (options.refuse?.includes(accountName)) throw new Error("refused");
      return `token-${accountName}`;
    },
    async signOut(token) {
      log.push(`out:${token}`);
    },
    async loadRosterStock(characterIDs, typeIDs, token) {
      log.push(`ask:${token}:${characterIDs.join(",")}:${typeIDs.join(",")}`);
      if (options.answer) return options.answer(characterIDs);
      return {
        ok: true,
        serverNowMs: 1_800_000_000_000,
        pilots: characterIDs.map((characterID) => ({
          characterID,
          corporationID: CORP,
          readAtMs: 1_800_000_000_000,
          stock: [{ typeID: 34, quantity: 10, locationName: "Alpha", holder: "hangar" }],
        })),
      } as unknown as JsonValue;
    },
    async readCorpStock(corporationIDs, _online, bots, keep) {
      corpAsks.push({ corps: corporationIDs, kept: [keep({ typeID: 34 }), keep({ typeID: 99 })] });
      botsSeen.push(...bots.map((bot) => `${bot.characterID}:${bot.corporationID}:${bot.accountName}`));
      const read: CorpStockRead = {
        corporationID: CORP,
        corporationName: "Example Corp",
        state: "read",
        viaCharacterID: PILOT_A,
        viaBot: false,
        readAtMs: 1_800_000_000_000,
        items: [{ typeID: 34, quantity: 500, locationID: 60000004, locationName: "Alpha", division: 1 }],
        refusals: [],
      };
      return [read];
    },
    now: () => 1_800_000_000_000,
  };
  return { deps, log, corpAsks, botsSeen };
}

const PILOTS = [
  { characterID: PILOT_A, characterName: "Pilot A", accountName: "first" },
  { characterID: PILOT_B, characterName: "Pilot B", accountName: "first" },
  { characterID: PILOT_C, characterName: "Pilot C", accountName: "second" },
];

test("one sign-in per account, asked about all its pilots, signed out after; then the corp", async () => {
  const { deps, log, corpAsks } = fakeDeps();
  const stock = await readIndustryStock({ pilots: PILOTS, typeIDs: [34, 34, 35], online: [], botCharacterIDs: new Set() }, deps);
  assert.deepEqual(log, [
    "in:first",
    `ask:token-first:${PILOT_A},${PILOT_B}:34,35`,
    "out:token-first",
    "in:second",
    `ask:token-second:${PILOT_C}:34,35`,
    "out:token-second",
  ]);
  // The corp is the one the pilots' snapshots named, read for the plan's types only.
  assert.deepEqual(corpAsks, [{ corps: [CORP], kept: [true, false] }]);
  assert.deepEqual(stock.pilots.map((pilot) => pilot.state), ["read", "read", "read"]);
  assert.deepEqual(
    stock.holdings.map((entry) => [entry.source, entry.quantity, entry.ownerWords]),
    [
      ["hangar", 10, "Pilot A"],
      ["hangar", 10, "Pilot B"],
      ["hangar", 10, "Pilot C"],
      ["corp", 500, "Example Corp"],
    ],
  );
});

test("an account that will not sign in, and a pilot the answer left out, say so per pilot", async () => {
  const { deps } = fakeDeps({
    refuse: ["second"],
    answer: () => ({ ok: true, serverNowMs: 1, pilots: [{ characterID: PILOT_A, readAtMs: 1, stock: [] }] }) as unknown as JsonValue,
  });
  const stock = await readIndustryStock({ pilots: PILOTS, typeIDs: [34], online: [], botCharacterIDs: new Set() }, deps);
  assert.deepEqual(
    stock.pilots.map((pilot) => [pilot.characterID, pilot.state]),
    [[PILOT_A, "read"], [PILOT_B, "unanswered"], [PILOT_C, "no-sign-in"]],
  );
});

test("a plan with no types asks nobody", async () => {
  const { deps, log, corpAsks } = fakeDeps();
  const stock = await readIndustryStock({ pilots: PILOTS, typeIDs: [], online: [], botCharacterIDs: new Set() }, deps);
  assert.deepEqual(log, []);
  assert.deepEqual(corpAsks, []);
  assert.deepEqual(stock.holdings, []);
});

test("a pilot a server bot flies becomes a corp reader, with the corp its own read named", async () => {
  const { deps, botsSeen } = fakeDeps();
  await readIndustryStock({ pilots: PILOTS, typeIDs: [34], online: [], botCharacterIDs: new Set([PILOT_C]) }, deps);
  assert.deepEqual(botsSeen, [`${PILOT_C}:${CORP}:second`]);
});
