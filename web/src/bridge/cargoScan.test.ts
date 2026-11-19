import assert from "node:assert/strict";
import test from "node:test";
import { decodeCargoScan } from "./scannerResults.ts";

test("cargo scans decode game-port lists and keep blueprint copy quantities signed", () => {
  assert.deepEqual(decodeCargoScan([
    { type: "long", value: "9988400005200" },
    { type: "list", items: [[34, 15], { type: "list", items: [681, -2] }, [681, -1]] },
  ]), {
    targetID: 9988400005200,
    rows: [{ typeID: 34, quantity: 15 }, { typeID: 681, quantity: -2 }, { typeID: 681, quantity: -1 }],
  });
});

test("an empty cargo result is still a result, while a missing list is ignored", () => {
  assert.deepEqual(decodeCargoScan([19, []]), { targetID: 19, rows: [] });
  assert.equal(decodeCargoScan([19, null]), null);
  assert.equal(decodeCargoScan([{ type: "long", value: "9007199254740993" }, []]), null);
});

test("an invalid item tuple does not corrupt other cargo rows", () => {
  assert.deepEqual(decodeCargoScan([19, [[34, null], [0, 1], [35, 2, 5], [36, 7]]]), {
    targetID: 19, rows: [{ typeID: 36, quantity: 7 }],
  });
});
