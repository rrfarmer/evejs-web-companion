import test from "node:test";
import assert from "node:assert/strict";
import { checkedInventory, readNativeShipHolds } from "./nativeInventory.ts";
const row = {
  itemID: 1,
  typeID: 2,
  ownerID: 3,
  locationID: 4,
  flagID: 5,
  quantity: 6,
  categoryID: 25,
};
test("native list rejects malformed and duplicate rows rather than losing evidence", () => {
  assert.deepEqual(
    checkedInventory({ type: "list", items: [{ type: "packedrow", fields: row }] }),
    [row],
  );
  assert.throws(() => checkedInventory({ type: "list", items: [row, row] }));
  assert.throws(() => checkedInventory({ type: "list", items: [{ ...row, quantity: 0 }] }));
  assert.throws(() => checkedInventory({}));
});
test("hold reader invalidates the exact ship once, asks each flag, and rejects mismatched ownership", async () => {
  const calls: unknown[] = [];
  const invalidations: unknown[] = [];
  const session: any = {
    flow: {
      flying: {
        bridgeDo: async (...args: unknown[]) => {
          invalidations.push(args);
        },
        bridgeAsk: async (...args: unknown[]) => {
          calls.push(args);
          return { type: "list", items: args[3] && (args[3] as any).flag === 5 ? [row] : [] };
        },
      },
    },
  };
  assert.deepEqual(await readNativeShipHolds(session, () => {}, 3, 4), [row]);
  assert.equal(calls.length, 5);
  assert.deepEqual(invalidations, [["invCache", "InvalidateLocationCache", [4]]]);
  await assert.rejects(
    readNativeShipHolds(session, () => {}, 9, 4),
    /identity/,
  );
});
