import assert from "node:assert/strict";
import test from "node:test";
import { quoteCustomsTransfer, transferAtCustomsOffice, type CustomsOfficeRead } from "./customsWrites.ts";
import { decodeColonyReport } from "./planets.ts";
import { moveItems } from "./inventoryWrites.ts";

const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077, pins: [{
    pinID: 21, typeID: 2544, kind: "launchpad", capacityM3: 10000, usedM3: 9999,
    contents: [{ typeID: 3645, quantity: 50 }],
  }],
}] }, 0).colonies[0]!;

const office: CustomsOfficeRead = {
  planetName: "Jita I", officeID: 20, pads: colony.pins, taxRate: .1,
  capacity: { used: 34998, capacity: 35000 },
  rows: [{ itemID: 22, typeID: 2268, quantity: 400, categoryID: 42, groupID: 1031, flagID: 4, singleton: false }],
  volumes: { 2268: .005, 3645: .19 },
  facts: {
    2544: { groupID: 1030, categoryID: 41, effects: [], requiredSkills: [], attributes: [[1638, .5], [1639, 1]] },
    2268: { groupID: 1031, categoryID: 42, effects: [], requiredSkills: [], attributes: [[1640, 5]] },
    3645: { groupID: 1042, categoryID: 43, effects: [], requiredSkills: [], attributes: [[1640, 400]] },
  },
};

test("customs quote uses the launchpad coefficients and commodity multipliers in each direction", () => {
  assert.deepEqual(quoteCustomsTransfer(office, { pinID: 21, imports: { 22: 200 }, exports: { 3645: 10 } }), {
    importTax: 50, exportTax: 400, landedVolume: 1, liftedVolume: 1.9,
  });
});

test("customs quote checks stack identity, whole quantities, both destinations and the office's permission", () => {
  assert.throws(() => quoteCustomsTransfer(office, { pinID: 21, imports: { 2268: 10 }, exports: {} }), /available stack/);
  assert.throws(() => quoteCustomsTransfer(office, { pinID: 21, imports: {}, exports: { 3645: 1.1 } }), /whole quantity/);
  assert.throws(() => quoteCustomsTransfer(office, { pinID: 21, imports: { 22: 201 }, exports: {} }), /launchpad.*free space/);
  assert.throws(() => quoteCustomsTransfer(office, { pinID: 21, imports: {}, exports: { 3645: 11 } }), /customs office.*free space/);
  assert.throws(() => quoteCustomsTransfer({ ...office, taxRate: null }, { pinID: 21, imports: { 22: 1 }, exports: {} }), /no tax rate/);
});

test("customs settlement binds the office inventory and passes the native rate unchanged", async () => {
  const args: unknown[] = [];
  const tax = { type: "real", value: .1 };
  await transferAtCustomsOffice(async (...call) => { args.push(...call); return null; }, 20,
    { pinID: 21, imports: { 22: 100 }, exports: { 3645: 2 } }, tax);
  assert.deepEqual(args, ["invbroker", "ImportExportWithPlanet", [21, { 22: 100 }, { 3645: 2 }, tax], null, 20]);
});

test("ship deposits use customs hangar custody for both single and bulk moves", async () => {
  const calls: unknown[][] = [];
  const act = async (...call: unknown[]) => { calls.push(call); return null; };
  const row = { itemID: 22, quantity: 100, singleton: false };
  await moveItems(act, 20, { kind: "container", customsOffice: true }, 25, [row], 45);
  await moveItems(act, 20, { kind: "container", customsOffice: true }, 25, [row, { ...row, itemID: 23 }], null);
  await moveItems(act, 24, { kind: "container" }, 25, [row], 45);
  assert.deepEqual(calls, [
    ["invbroker", "Add", [22, 25], { qty: 45 }, 20],
    ["invbroker", "MultiAdd", [[22, 23], 25], { flag: 4 }, 20],
    ["invbroker", "Add", [22, 25], { qty: 45, flag: null }, 24],
  ]);
});
