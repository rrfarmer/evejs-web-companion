import assert from "node:assert/strict";
import test from "node:test";
import { expeditedTimeWords, quoteExpeditedTransfer } from "./expeditedTransfer.ts";
import { decodeRecipeBook } from "./piRecipes.ts";
import { decodeColonyReport } from "./planets.ts";

const data = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077, routes: [{ routeID: 3, path: [2, 3], commodityTypeID: 3645, commodityQuantity: 20 }],
  pins: [
    { pinID: 1, kind: "storage", typeID: 2541, usedM3: 220, capacityM3: 12000,
      contents: [{ typeID: 3645, quantity: 1000 }, { typeID: 2267, quantity: 2000 }, { typeID: 2268, quantity: 4000 }] },
    { pinID: 2, kind: "factory", typeID: 2473, schematicID: 121, contents: [{ typeID: 2268, quantity: 900 }] },
    { pinID: 3, kind: "storage", typeID: 2541, usedM3: 11870, capacityM3: 12000 },
  ],
  links: [{ endpoint1: 1, endpoint2: 2, level: 1 }, { endpoint1: 2, endpoint2: 3, level: 0 }],
}] }, 0).colonies[0]!;
const recipes = decodeRecipeBook({ schematics: [{
  schematicID: 121, name: "Water", cycleTimeSeconds: 1800, factoryTypeIDs: [2473],
  inputs: [{ typeID: 2268, quantity: 3000 }], output: { typeID: 3645, quantity: 20 },
}] });
const facts = { baseLinkBandwidth: 1250, commodityVolumes: { 3645: .19, 2267: .005, 2268: .005 } };

test("mixed cargo uses destination room and the full capacity of the smallest link", () => {
  const quote = quoteExpeditedTransfer(data, recipes, facts, [1, 2, 3], { 3645: 600, 2267: 500 });
  assert.equal(quote.error, "");
  assert.equal(quote.volume, 116.5);
  assert.equal(quote.bandwidth, 1250);
  assert.equal(quote.limits.get(3645), 671);
  assert.equal(quote.cooldownMs, 335520);
  assert.equal(expeditedTimeWords(quote.cooldownMs), "5m 36s");
  assert.match(quoteExpeditedTransfer(data, recipes, facts, [1, 2, 3], { 3645: 700 }).error, /destination capacity/);
  assert.match(quoteExpeditedTransfer(data, recipes, facts, [1, 3], { 3645: 5 }).error, /link.*missing/);
});

test("a processor accepts its unfilled recipe buffer and has a five-minute transfer minimum", () => {
  const quote = quoteExpeditedTransfer(data, recipes, facts, [1, 2], { 2268: 2100 });
  assert.equal(quote.error, "");
  assert.equal(quote.limits.get(2268), 2100);
  assert.equal(quote.limits.get(2267), 0);
  assert.equal(quote.cooldownMs, 300000);
  assert.match(quoteExpeditedTransfer(data, recipes, facts, [1, 2], { 2268: 2101 }).error, /destination capacity/);
});
