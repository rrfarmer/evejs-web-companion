// The repair shop asked by the page itself.

import test from "node:test";
import assert from "node:assert/strict";

import { quoteRepairs, repairItemsAtShop, repairQuoted } from "./repairShop.ts";
import type { RepairQuoteRow } from "./repairQuotes.ts";

const IN_A_STATION = { stationID: 60003760, structureID: null };
const IN_A_STRUCTURE = { stationID: null, structureID: 1030000000001 };
const IN_SPACE = { stationID: null, structureID: null };

/** A part as the shop lists one: damage, and what a unit of it costs to repair. */
const part = (itemID: number, damage: number, unit: number) => ({ type: "packedrow", fields: { itemID, damage, costToRepairOneUnitOfDamage: unit, maxHealth: 1000 } });
/** The shop's answer: a hull with damage and a damaged module under it, and a module with none. */
const THE_SHOPS_QUOTE = { type: "dict", entries: [[9001, { type: "list", items: [part(9001, 9.2, 12.5), part(5001, 1, 250.5)] }], [5002, { type: "list", items: [] }]] };
/** The same as the page has it: ceil(9.2) * 12.5 for the hull, and 250.5 for the module. */
const QUOTED: readonly RepairQuoteRow[] = [{
  itemID: 9001,
  repairItemIDs: [9001, 5001],
  damagedParts: 2,
  parts: [
    { itemID: 9001, typeID: null, damage: 9.2, maxHealth: 1000, cost: 125 },
    { itemID: 5001, typeID: null, damage: 1, maxHealth: 1000, cost: 250.5 },
  ],
  cost: 375.5,
}];

/** A stand-in asker: answers the shop's quote to a quote and nothing to anything else, and says what was asked. */
function harness(quote: unknown = THE_SHOPS_QUOTE, refusal: Error | null = null) {
  const asked: unknown[][] = [];
  const ask = async (...call: unknown[]) => { asked.push(call); if (refusal) throw refusal; return (call[1] === "GetRepairQuotes" ? quote : null) as never; };
  return { asked, ask };
}

test("a quote is asked of the repair shop by one call: the items as they were named, and only the damaged come back", async () => {
  const { asked, ask } = harness();

  const quotes = await quoteRepairs(ask, [9001, 5001, 5002]);

  // repair.GetRepairQuotes (base_repairshop.py 63): GetRemoteRepairMgr().GetRepairQuotes(itemIDs).
  assert.deepEqual(asked, [["repairSvc", "GetRepairQuotes", [[9001, 5001, 5002]]]]);
  assert.deepEqual(quotes, QUOTED);
});

test("with nothing named there is nothing to quote, and the shop is not asked", async () => {
  const { asked, ask } = harness();

  // DisplayRepairQuote (218 to 220): with no items it returns.
  assert.deepEqual(await quoteRepairs(ask, []), []);
  assert.deepEqual(asked, []);
});

test("in a station the repair is one call: the damaged parts' own IDs, and the quote's whole cost for the payment", async () => {
  const { asked, ask } = harness();

  await repairQuoted(ask, QUOTED, IN_A_STATION);

  // repair.RepairItems (65 to 67): RepairItemsInStation(itemIDs, payment); the payment is the window's amount
  // (300 to 303), each part's ceil(damage) times its unit cost, added.
  assert.deepEqual(asked, [["repairSvc", "RepairItemsInStation", [[9001, 5001], 375.5]]]);
});

test("in a structure the repair is the structure's own call, with the parts and no payment", async () => {
  const { asked, ask } = harness();

  await repairQuoted(ask, QUOTED, IN_A_STRUCTURE);

  // repair.RepairItems (68 and 69): RepairItemsInStructure(itemIDs).
  assert.deepEqual(asked, [["repairSvc", "RepairItemsInStructure", [[9001, 5001]]]]);
  // And a quote with a part of no price is repaired there all the same: nothing is paid.
  const unpriced = [{ ...QUOTED[0]!, cost: null }];
  const again = harness();
  await repairQuoted(again.ask, unpriced, IN_A_STRUCTURE);
  assert.deepEqual(again.asked, [["repairSvc", "RepairItemsInStructure", [[9001, 5001]]]]);
});

test("a session with a station is a station's, as the client takes it first", async () => {
  const { asked, ask } = harness();

  await repairQuoted(ask, QUOTED, { stationID: 60003760, structureID: 1030000000001 });

  assert.equal(asked[0]![1], "RepairItemsInStation");
});

test("nothing is asked where there is nothing to repair, nowhere to repair it, or no price to pay", async () => {
  // Nothing damaged: the client's window has no rows to repair.
  const nothing = harness();
  await repairQuoted(nothing.ask, [], IN_A_STATION);
  assert.deepEqual(nothing.asked, []);
  // GetRemoteRepairMgr raises with neither a station nor a structure (56).
  const flying = harness();
  await assert.rejects(repairQuoted(flying.ask, QUOTED, IN_SPACE), /You must be docked to use the repair shop\./);
  assert.deepEqual(flying.asked, []);
  // A price nobody quoted is not paid: the client's amount is always a number it worked out.
  const unpriced = harness();
  await assert.rejects(repairQuoted(unpriced.ask, [{ ...QUOTED[0]!, cost: null }], IN_A_STATION), /The repair shop did not say what that costs, so nothing was paid\./);
  assert.deepEqual(unpriced.asked, []);
});

test("items named with no quote in hand are quoted first, and repaired at that quote", async () => {
  const { asked, ask } = harness();

  await repairItemsAtShop(ask, ask, [9001, 5001], IN_A_STATION);

  assert.deepEqual(asked, [
    ["repairSvc", "GetRepairQuotes", [[9001, 5001]]],
    ["repairSvc", "RepairItemsInStation", [[9001, 5001], 375.5]],
  ]);
  // The quote is a read and the repair a write: each goes by its own asker.
  const reads: unknown[][] = [];
  const writes: unknown[][] = [];
  await repairItemsAtShop(async (...call) => { reads.push(call); return THE_SHOPS_QUOTE as never; }, async (...call) => { writes.push(call); return null as never; }, [9001], IN_A_STATION);
  assert.deepEqual([reads.map((call) => call[1]), writes.map((call) => call[1])], [["GetRepairQuotes"], ["RepairItemsInStation"]]);
});

test("items the shop finds nothing wrong with are quoted and not repaired", async () => {
  const { asked, ask } = harness({ type: "dict", entries: [[9001, { type: "list", items: [] }]] });

  await repairItemsAtShop(ask, ask, [9001], IN_A_STATION);

  assert.deepEqual(asked.map((call) => call[1]), ["GetRepairQuotes"]);
});

test("the shop's refusal is the caller's, as it came", async () => {
  const refused = new Error("Modules must be repaired in full.");
  await assert.rejects(quoteRepairs(harness(null, refused).ask, [9001]), /Modules must be repaired in full\./);
  await assert.rejects(repairQuoted(harness(null, refused).ask, QUOTED, IN_A_STATION), /Modules must be repaired in full\./);
});
