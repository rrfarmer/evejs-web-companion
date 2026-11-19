import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeMiningLedger, filterMiningLedger, ledgerDateRange, ledgerFilterOf, miningLedgerDaily, miningLedgerTotals,
  type MiningLedgerFacts,
} from "./miningLedger.ts";

const midnight = Date.UTC(2026, 10, 19);
const filetime = (ms: number) => ({ type: "long", value: String(BigInt(ms) * 10000n + 116444736000000000n) });
const record = (fields: Record<string, unknown>) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries: Object.entries(fields) } });

test("personal ledger rows retain native FILETIME, zero yield, and residue", () => {
  const row = record({ eventDate: filetime(midnight + 1234), solarsystemID: 30000144, typeID: 1228, quantity: 0, quantityWasted: 7 });
  assert.deepEqual(decodeMiningLedger({ type: "list", items: [row] }), [
    { atMs: midnight + 1234, systemID: 30000144, typeID: 1228, quantity: 0, wasted: 7 },
  ]);
  assert.deepEqual(decodeMiningLedger({ type: "list", items: [] }), []);
  assert.throws(() => decodeMiningLedger(null), /unexpected list/);
  assert.throws(() => decodeMiningLedger([record({ quantity: 42 })]), /incomplete entry/);
});

test("the ledger filters inclusive UTC days and retains native ore group and moon family priorities", () => {
  const scordite: MiningLedgerFacts = { groupID: 462, baseTypeID: null, metaLevel: 1, volume: 0.15, price: 12 };
  const moon: MiningLedgerFacts = { groupID: 1884, baseTypeID: 45490, metaLevel: 2, volume: 10, price: 100 };
  const facts = new Map([[1228, scordite], [45493, moon]]);
  const common = { systemID: 30000144, wasted: 3 };
  const rows = [
    { ...common, typeID: 1228, quantity: 30, atMs: midnight },
    { ...common, typeID: 45493, quantity: 2, atMs: midnight + 86_399_999 },
    { ...common, typeID: 1228, quantity: 200, atMs: midnight + 86_400_000 },
  ];
  const day = "2026-11-19";
  assert.deepEqual(ledgerDateRange(midnight), { first: "2026-08-21", from: "2026-10-20", to: day });
  assert.equal(ledgerFilterOf(45493, moon), "type:45490");
  assert.deepEqual(filterMiningLedger(rows, facts, day, day, new Set(["group:462"])), [rows[0]]);
  assert.deepEqual(filterMiningLedger(rows, facts, day, day, new Set(["type:45490"])), [rows[1]]);
  const retained = filterMiningLedger(rows, facts, day, day, new Set());
  assert.deepEqual(miningLedgerDaily(retained, facts, "2026-11-18", day, "volume"), [
    { date: "2026-11-18", quantity: 0, parts: [] }, { date: day, quantity: 24.5, parts: [] },
  ]);
  assert.deepEqual(miningLedgerDaily(retained, facts, day, day, "volume", new Set([1228, 45493])), [
    { date: day, quantity: 24.5, parts: [[1228, 4.5], [45493, 20]] },
  ]);
  assert.deepEqual(miningLedgerTotals(retained, facts, "value"), [
    { typeID: 1228, quantity: 360 }, { typeID: 45493, quantity: 200 },
  ]);
});
