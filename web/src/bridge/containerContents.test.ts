import assert from "node:assert/strict";
import test from "node:test";
import { containerFlagLabel, isAssetContentsContainer, readContainerContents } from "./containerContents.ts";
import type { JsonValue } from "./wire.ts";

const container = 9988400008551;
const station = 60003754;
const list = (items: readonly JsonValue[]) => ({ type: "list", items } as const);
const header = list(["itemID", "typeID", "locationID", "flagID", "quantity", "stacksize", "singleton", "groupID", "categoryID"]);
const rowset = (...lines: JsonValue[]): JsonValue => ({
  type: "object", name: "eve.common.script.sys.rowset.Rowset",
  args: { type: "dict", entries: [["header", header], ["lines", list(lines)]] },
});

test("remote View Contents sends the exact item and its station, hides the pilot and keeps fitted and cargo IDs", async () => {
  const calls: unknown[] = [];
  const answer = rowset([1, 602, container, 57, -1, 1, 1, 25, 6],
    [2, 2046, container, 11, -1, 1, 1, 60, 7], list([3, 34, container, 5, 30, 30, 0, 18, 4]));
  const rows = await readContainerContents(async (...call) => { calls.push(call); return answer; }, container, station);
  assert.deepEqual(calls, [["invbroker", "GetContainerContents", [container, station]]]);
  assert.deepEqual(rows.map(row => [row.itemID, row.flagID, row.quantity]), [[2, 11, 1], [3, 5, 30]]);
});

test("an empty rowset is distinct from a missing or mismatched listing", async () => {
  assert.deepEqual(await readContainerContents(async () => rowset(), container, station), []);
  await assert.rejects(readContainerContents(async () => null, container, station), /did not return/);
  await assert.rejects(readContainerContents(async () => rowset([3, 34, station, 5, 30, 30, 0, 18, 4]), container, station), /incomplete/);
});

test("the installed container and bay rules distinguish ships, capsules, cans and normal stock", () => {
  assert.equal(isAssetContentsContainer(6, 25), true);
  assert.equal(isAssetContentsContainer(6, 29), false);
  assert.equal(isAssetContentsContainer(2, 12), true);
  assert.equal(isAssetContentsContainer(4, 18), false);
  assert.equal(containerFlagLabel(11)?.[1], "Low Slot");
  assert.equal(containerFlagLabel(5)?.[1], "Cargo Hold");
  assert.equal(containerFlagLabel(95), undefined);
  assert.equal(containerFlagLabel(129), undefined);
});
