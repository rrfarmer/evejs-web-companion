// R109 slice 4: stock against a plan, as pure functions.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ageWords,
  decodeRosterStock,
  heldByType,
  holdingsByType,
  multibuyText,
  planStanding,
  staleWords,
} from "./industryStock.ts";
import { decodeRecipeClosure } from "./industryRecipes.ts";
import { resolveIndustryChain } from "./industryChain.ts";
import type { Holding } from "./stockHoldings.ts";
import type { JsonValue } from "./wire.ts";

const PILOT = 90000001;
const STATION = 60000004;

function holding(overrides: Partial<Holding>): Holding {
  return {
    typeID: 34,
    typeName: null,
    quantity: 100,
    source: "hangar",
    placeWords: "Alpha I - Moon 1 - Station hangar",
    ownerWords: "Pilot One",
    planetID: null,
    readAtMs: 1_800_000_000_000,
    clockOffsetMs: 0,
    ...overrides,
  };
}

test("a stock answer becomes one holding per stack, each with its owner, place and clock", () => {
  const { pilots, holdings } = decodeRosterStock({
    ok: true,
    serverNowMs: 1_800_000_005_000,
    pilots: [{
      characterID: PILOT,
      corporationID: 98000001,
      readAtMs: 1_800_000_004_000,
      stock: [
        { typeID: 34, typeName: "Tritanium", quantity: 500, locationID: STATION, locationName: "Alpha I - Moon 1 - Station", holder: "hangar" },
        { typeID: 35, quantity: 20, locationID: STATION, locationName: "Alpha I - Moon 1 - Station", holder: "ship", holderName: "Hauler One" },
        { typeID: 0, quantity: 5 },
      ],
    }],
  } as unknown as JsonValue, 1_800_000_000_000, new Map([[PILOT, "Pilot One"]]));
  assert.deepEqual(pilots.map(({ characterID, corporationID, readAtMs }) => ({ characterID, corporationID, readAtMs })), [
    { characterID: PILOT, corporationID: 98000001, readAtMs: 1_800_000_004_000 },
  ]);
  // Every stack is kept with where it sits, for where a job can start.
  assert.deepEqual(pilots[0]?.stock.map((stack) => [stack.typeID, stack.locationID, stack.holder]), [
    [34, STATION, "hangar"],
    [35, STATION, "ship"],
  ]);
  assert.deepEqual(holdings.map((entry) => [entry.typeID, entry.quantity, entry.placeWords, entry.ownerWords, entry.clockOffsetMs]), [
    [34, 500, "Alpha I - Moon 1 - Station hangar", "Pilot One", 5000],
    [35, 20, "Alpha I - Moon 1 - Station, in Hauler One's cargo", "Pilot One", 5000],
  ]);
});

test("held per type adds every place up, personal and corp alike", () => {
  const held = heldByType([
    holding({ quantity: 100 }),
    holding({ quantity: 50, source: "corp", ownerWords: "Example Corp" }),
    holding({ typeID: 35, quantity: 7 }),
    holding({ typeID: 36, quantity: 9, inFactory: true }),
  ]);
  assert.deepEqual([...held], [[34, 150], [35, 7]]);
});

test("holdings by type keep every place, personal before corp", () => {
  const byType = holdingsByType([
    holding({ quantity: 50, source: "corp", ownerWords: "Example Corp" }),
    holding({ quantity: 100 }),
  ]);
  assert.deepEqual(byType.get(34)?.map((entry) => entry.source), ["hangar", "corp"]);
});

test("reads close together are one moment; far apart, the oldest is named", () => {
  const now = 1_800_000_600_000;
  assert.equal(staleWords([holding({}), holding({ readAtMs: 1_800_000_060_000 })], now), null);
  assert.equal(
    staleWords([holding({}), holding({ readAtMs: 1_800_000_300_000 })], now),
    "Read at different times - the oldest is 10 minutes old.",
  );
  // A read on a skewed server clock is put back on the browser's first.
  assert.equal(staleWords([holding({}), holding({ readAtMs: 1_800_000_300_000, clockOffsetMs: 300_000 })], now), null);
});

test("ageWords stays plain", () => {
  assert.equal(ageWords(20_000), "under a minute");
  assert.equal(ageWords(60_000), "1 minute");
  assert.equal(ageWords(3 * 3_600_000), "3 hours");
  assert.equal(ageWords(72 * 3_600_000), "3 days");
});

// A two-level plan: Widget <- 10 Tritanium + 2 Gizmo; Gizmo is bought.
const BOOK = decodeRecipeClosure({
  recipes: [{
    productTypeID: 101, activity: "manufacturing", blueprintTypeID: 1101, blueprintName: "Widget Blueprint",
    quantityPerRun: 1, materials: [{ typeID: 34, quantity: 10 }, { typeID: 102, quantity: 2 }], inventedFrom: [],
  }],
  types: { 101: { name: "Widget" }, 34: { name: "Tritanium" } },
} as unknown as JsonValue);

test("multibuy: one 'Name quantity' line per short item; an unnamed one is counted, not pasted", () => {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 101, runs: 3, held: new Map([[34, 10]]) });
  assert.ok(chain);
  const lines = [...chain.lines.values()].filter((line) => line.obtain === "buy");
  assert.deepEqual(multibuyText(lines), { text: "Tritanium 20", unnamed: 1 });
});

test("standing: covered when nothing to buy is short, else how many are, toned by share", () => {
  const covered = resolveIndustryChain({ book: BOOK, productTypeID: 101, runs: 1, held: new Map([[34, 10], [102, 2]]) });
  assert.ok(covered);
  assert.deepEqual(planStanding(covered), { missing: 0, buys: 2, share: 1, tone: "ok", words: "covered" });
  const half = resolveIndustryChain({ book: BOOK, productTypeID: 101, runs: 1, held: new Map([[34, 10]]) });
  assert.ok(half);
  assert.equal(planStanding(half).tone, "act");
  assert.equal(planStanding(half).words, "1 missing");
  const none = resolveIndustryChain({ book: BOOK, productTypeID: 101, runs: 1 });
  assert.ok(none);
  assert.equal(planStanding(none).tone, "bad");
});
