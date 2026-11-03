// What you hold, merged (R108 slice 5): every unit keeps its place, colony stock
// stays apart from hangar stock, and the sources say what each part rests on.

import test from "node:test";
import assert from "node:assert/strict";

import type { Colony, ColonyPin } from "../store/types.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { PiCommodity, PiRecipeBook, PiTier } from "./piRecipes.ts";
import {
  holdingsFromReadings,
  piHoldingsFromCorpReads,
  stockByTier,
  stockLines,
  stockSources,
  stockSummary,
} from "./piStock.ts";
import type { CorpStockRead } from "./stockHoldings.ts";

const PILOT = 90000001;
const OTHER_PILOT = 90000002;
const CORP = 98000001;
const WATER = 3645;
const AQUEOUS = 2268;
const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

function commodity(typeID: number, typeName: string, tier: PiTier): [number, PiCommodity] {
  return [typeID, { typeID, typeName, tier }];
}

const BOOK: PiRecipeBook = {
  schematics: [],
  bySchematicID: new Map(),
  byOutputTypeID: new Map(),
  commodities: new Map([commodity(WATER, "Water", 1), commodity(AQUEOUS, "Aqueous Liquids", 0)]),
  readable: true,
};

function pin(pinID: number, kind: ColonyPin["kind"], contents: ColonyPin["contents"]): ColonyPin {
  return {
    pinID, typeID: 0, typeName: "", kind, contents, usedM3: null, capacityM3: null, schematicID: null,
    schematicName: null, hasReceivedInputs: null, receivedInputsLastCycle: null, lastRunAtMs: null,
    lastLaunchAtMs: null, program: null,
  };
}

const COLONY: Colony = {
  planetID: 40000002, planetName: "Alpha III", solarSystemID: 30000001, solarSystemName: "Alpha",
  planetTypeID: 2016, planetTypeName: "Planet (Lava)", commandCenterLevel: 4, lastSimulatedAtMs: null,
  pins: [
    pin(1, "storage", [{ typeID: WATER, typeName: "Water", quantity: 100 }]),
    pin(2, "storage", [{ typeID: WATER, typeName: "Water", quantity: 50 }]),
    pin(3, "launchpad", [{ typeID: WATER, typeName: "Water", quantity: 900 }]),
    pin(4, "factory", [{ typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 3000 }]),
  ],
  linkCount: 0, links: [], routes: [],
};

function reading(characterID: number, fields: Partial<PilotColonyReading> = {}): PilotColonyReading {
  return {
    characterID,
    readAtMs: NOW - 2 * MINUTE,
    report: { colonies: [COLONY], coloniesReadable: true, clockOffsetMs: 0 },
    stock: [
      { typeID: WATER, typeName: "Water", quantity: 400, locationID: 60000004, locationName: "Alpha VI - Moon 2", holder: "hangar", holderName: null },
      { typeID: AQUEOUS, typeName: "Aqueous Liquids", quantity: 5000, locationID: 60000004, locationName: "Alpha VI - Moon 2", holder: "ship", holderName: "Hauler One" },
    ],
    corporationID: CORP,
    ...fields,
  };
}

const NAMES = new Map([[PILOT, "Pilot One"], [OTHER_PILOT, "Pilot Two"]]);

const CORP_READ: CorpStockRead = {
  corporationID: CORP,
  corporationName: "Example Corp",
  state: "read",
  viaCharacterID: PILOT,
  viaBot: false,
  readAtMs: NOW - 3 * MINUTE,
  items: [{ typeID: WATER, quantity: 600, locationID: 60000004, locationName: "Alpha VI - Moon 2", division: 3 }],
  refusals: [],
};

test("every holding is said with its place: colony structure, hangar, ship's cargo, corp division", () => {
  const holdings = [
    ...holdingsFromReadings(new Map([[PILOT, reading(PILOT)]]), NAMES),
    ...piHoldingsFromCorpReads([CORP_READ], BOOK),
  ];
  assert.deepEqual(
    holdings.map((holding) => [holding.source, holding.placeWords, holding.ownerWords, holding.quantity]),
    [
      // Two storage units on one planet are one line: the player cannot tell them apart.
      ["colony", "Alpha III storage", "Pilot One", 150],
      ["colony", "Alpha III launchpad", "Pilot One", 900],
      // Held, and said to be a factory's input — the planner leaves it out.
      ["colony", "Alpha III factory input", "Pilot One", 3000],
      ["hangar", "Alpha VI - Moon 2 hangar", "Pilot One", 400],
      ["hangar", "Alpha VI - Moon 2, in Hauler One's cargo", "Pilot One", 5000],
      ["corp", "Alpha VI - Moon 2 office, division 3", "Example Corp", 600],
    ],
  );
});

test("a line per commodity keeps colony, hangar and corp apart, and sums them", () => {
  const holdings = [
    ...holdingsFromReadings(new Map([[PILOT, reading(PILOT)]]), NAMES),
    ...piHoldingsFromCorpReads([CORP_READ], BOOK),
  ];
  const lines = stockLines(holdings, BOOK);
  const water = lines.find((line) => line.typeID === WATER)!;
  assert.equal(water.inColonies, 1050);
  assert.equal(water.inHangars, 400);
  assert.equal(water.inCorp, 600);
  assert.equal(water.total, 2050);
  assert.deepEqual(water.holdings.map((holding) => holding.source), ["colony", "colony", "hangar", "corp"]);
  assert.deepEqual(stockByTier(lines).map((group) => group.label), ["Raw", "P1 - basic"]);
  assert.deepEqual(stockSummary(lines), { kinds: 2, inColonies: 4050, inHangars: 5400, inCorp: 600 });
});

test("a corp that could not be read adds nothing, and the sources say why", () => {
  const unreachable: CorpStockRead = { ...CORP_READ, state: "unreachable", corporationName: null, viaCharacterID: null, readAtMs: null, items: [] };
  assert.deepEqual(piHoldingsFromCorpReads([unreachable], BOOK), []);
  const lines = stockSources({
    members: [PILOT],
    readings: new Map([[PILOT, reading(PILOT)]]),
    names: NAMES,
    corpReads: [unreachable],
    browserNowMs: NOW,
  });
  assert.deepEqual(lines, [
    { words: "Colonies and personal hangars - 1 pilot, oldest read 2 minutes ago", warn: false },
    { words: "Corp hangars of Pilot One's corporation - not read: none of its pilots is online in this tab or flown by a server bot. Bring one online and Refresh.", warn: true },
  ]);
});

test("the sources name the pilot a corp was read through, and who was refused first", () => {
  const lines = stockSources({
    members: [PILOT],
    readings: new Map([[PILOT, reading(PILOT)]]),
    names: NAMES,
    corpReads: [{ ...CORP_READ, viaCharacterID: OTHER_PILOT, refusals: [{ characterID: PILOT, reason: "no hangar access" }] }],
    browserNowMs: NOW,
  });
  assert.equal(lines[1]!.words, "Example Corp hangars - read through Pilot Two 3 minutes ago (Pilot One refused: no hangar access)");
});

test("a corp read through a server bot says so", () => {
  const lines = stockSources({
    members: [PILOT],
    readings: new Map([[PILOT, reading(PILOT)]]),
    names: NAMES,
    corpReads: [{ ...CORP_READ, viaCharacterID: OTHER_PILOT, viaBot: true }],
    browserNowMs: NOW,
  });
  assert.equal(lines[1]!.words, "Example Corp hangars - read through Pilot Two (server bot) 3 minutes ago");
});

test("⚠ a reading stored before stock was sent is 'not read yet', never 'holds nothing'", () => {
  const lines = stockSources({
    members: [PILOT, OTHER_PILOT],
    readings: new Map([[PILOT, reading(PILOT, { stock: null })]]),
    names: NAMES,
    corpReads: [],
    browserNowMs: NOW,
  });
  assert.deepEqual(lines.map((line) => line.words), [
    "Personal hangars of Pilot One not read yet. Refresh reads them.",
    "Pilot Two not read, so nothing they hold is counted.",
  ]);
});
