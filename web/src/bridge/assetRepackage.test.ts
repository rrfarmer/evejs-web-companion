import assert from "node:assert/strict";
import test from "node:test";
import { insuredAssetShips } from "./assetRepackage.ts";
import type { JsonValue } from "./wire.ts";

const list = (...items: JsonValue[]): JsonValue => ({ type: "list", items });
const contract = (shipID: JsonValue): JsonValue => ({
  type: "object",
  name: "util.KeyVal",
  args: { type: "dict", entries: [["shipID", shipID]] },
});

test("repackaging reads exact insured ship identities from the native contract list", async () => {
  const calls: unknown[] = [];
  const first = 9988400008551;
  const second = 9988400008552;
  const ships = await insuredAssetShips(async (...call) => {
    calls.push(call);
    return list(contract(first), contract({ type: "long", value: String(second) }));
  });
  assert.deepEqual(calls, [["insuranceSvc", "GetContracts", []]]);
  assert.deepEqual([...ships], [first, second]);
  assert.deepEqual([...(await insuredAssetShips(async () => list()))], []);
});

test("repackaging distinguishes unreadable insurance contracts from an empty insurance list", async () => {
  await assert.rejects(insuredAssetShips(async () => null), /could not be read/);
  await assert.rejects(insuredAssetShips(async () => list(contract(null))), /could not be read/);
});
