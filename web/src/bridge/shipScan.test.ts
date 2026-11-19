import assert from "node:assert/strict";
import test from "node:test";
import { decodeShipScan, groupShipScanHardware } from "./scannerResults.ts";

test("ship scans read fractional GJ, wrapped hardware and legacy row objects", () => {
  const scan = decodeShipScan([
    { type: "long", value: "9988400004455" },
    { type: "real", value: 74.125 },
    200,
    { type: "list", items: [
      [2048, 2],
      { type: "packedrow", fields: { typeID: 31716, stacksize: 1 } },
      [202, 40],
      [35, 1, 2],
      [34, 0],
    ] },
  ]);
  assert.deepEqual(scan, {
    targetID: 9988400004455, capacitorCharge: 74.125, capacitorCapacity: 200,
    rows: [{ typeID: 2048, quantity: 2 }, { typeID: 31716, quantity: 1 }, { typeID: 202, quantity: 40 }],
  });
  assert.deepEqual(decodeShipScan([19, 0, 0, []]), { targetID: 19, capacitorCharge: 0, capacitorCapacity: 0, rows: [] });
  assert.equal(decodeShipScan([19, 0, null, []]), null);
  assert.equal(decodeShipScan([19, 0, 200, null]), null);
});

test("ship scan groups preserve slot order, count duplicate fittings and list each charge type once", () => {
  const rows = [
    { typeID: 202, quantity: 20 }, { typeID: 31716, quantity: 1 }, { typeID: 2048, quantity: 1 },
    { typeID: 202, quantity: 20 }, { typeID: 2048, quantity: 2 }, { typeID: 35, quantity: 1 },
  ];
  assert.deepEqual(groupShipScanHardware(rows, {
    2048: { categoryID: 7, effects: [17, 12] },
    31716: { categoryID: 7, effects: [2663] },
    202: { categoryID: 8, effects: [12] },
  }), [
    { name: "High slots", rows: [{ typeID: 2048, quantity: 3 }] },
    { name: "Rig slots", rows: [{ typeID: 31716, quantity: 1 }] },
    { name: "Charges", rows: [{ typeID: 202, quantity: null }] },
    { name: "Other", rows: [{ typeID: 35, quantity: 1 }] },
  ]);
});
