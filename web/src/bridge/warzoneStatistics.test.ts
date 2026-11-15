import assert from "node:assert/strict";
import test from "node:test";
import { warzoneStatistics } from "./warzoneStatistics.ts";
import type { JsonValue } from "./wire.ts";

const dict = (...entries: [string | number, JsonValue][]): JsonValue => ({ type: "dict", entries } as JsonValue);
const info = (militia: number, top: number, total: number, systems: number): JsonValue => ({ type: "object", name: "util.KeyVal", args: dict(
  ["militiaMembersCount", militia], ["topMemberCount", top], ["totalMembersCount", total], ["systemsCount", systems],
) });
const factions = dict([500001, info(1, 2, 3, 1)], [500004, info(4, 6, 8, 1)]);
const comparison = [dict([1, dict(["vpTotal", 700])], [2, dict(["vpTotal", 1050])], [32, dict(["vpTotal", 1400])]),
  dict([1, dict(["vpTotal", 3500])], [2, dict(["vpTotal", 2800])], [32, dict(["vpTotal", 2100])])];

test("native statistics choose the correct inventory group and corporation pilot counts", () => {
  const own = dict(["vpTotal", 350]);
  const personal = warzoneStatistics("personal", own, comparison, null, 500001, null);
  assert.deepEqual(personal.headers, ["You", "Top", "All"]);
  assert.deepEqual(personal.rows.at(-1), { metric: "vpTotal", values: [350, 700, 3500] });
  const corporation = warzoneStatistics("corp", own, comparison, factions, 500001, null);
  assert.deepEqual(corporation.headers, ["Your", "Top", "All"]);
  assert.deepEqual(corporation.rows[0], { metric: "pilots", values: [1, 6, 11] });
  assert.deepEqual(corporation.rows.at(-1), { metric: "vpTotal", values: [350, 1050, 2800] });
  assert.deepEqual(warzoneStatistics("corp", own, comparison, factions, 500001, 12).rows[0]?.values, [12, 6, 11]);
  assert.deepEqual(warzoneStatistics("alliance", own, comparison, null, 500001, null).rows.at(-1)?.values, [350, 1400, 2100]);
});

test("militia statistics honor the faction header and refuse a missing native reply", () => {
  const own = dict(["header", { type: "list", items: [500004, 500001] }], ["data", dict(["vpY", dict([500001, 350])])]);
  const report = warzoneStatistics("militia", own, null, factions, 500004, null);
  assert.deepEqual(report.headers, [500004, 500001]);
  assert.deepEqual(report.rows[0]?.values, [8, 3]);
  assert.deepEqual(report.rows.find(row => row.metric === "vpY")?.values, [0, 350]);
  assert.throws(() => warzoneStatistics("militia", null, null, null, null, null));
});
