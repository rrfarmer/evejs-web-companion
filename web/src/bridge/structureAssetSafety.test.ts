import assert from "node:assert/strict";
import test from "node:test";
import { readSafetyTargets, readSafetyWraps } from "./structureAssetSafety.ts";
import type { JsonValue } from "./wire.ts";

const row = (entries: [string, JsonValue][]): JsonValue => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
const zarzakh = row([["itemID", 60015187], ["typeID", 78334], ["solarSystemID", 30100000], ["itemName", "The Fulcrum"]]);
const jita = row([["itemID", 60003760], ["typeID", 1932], ["solarSystemID", 30000142], ["itemName", "Jita Trade Hub"]]);

test("reads a 24.02 wrap's timers, source type and separate default system", () => {
  const ejectTime = "134128601000000000";
  const values: [string, JsonValue][] = [
    ["assetWrapID", 100_000_000_001], ["wrapName", "FOB Asset Safety"], ["solarSystemID", 30000142],
    ["ejectTime", { type: "long", value: ejectTime }], ["daysUntilCanDeliver", 5], ["daysUntilAutoMove", 20],
    ["structureTypeID", 78260], ["defaultDestinationInfo", zarzakh],
  ];
  const [wrap] = readSafetyWraps({ type: "list", items: [row(values)] });
  assert.equal(wrap?.ejectTime, BigInt(ejectTime));
  assert.equal(wrap?.structureTypeID, 78260);
  assert.equal(wrap?.solarSystemID, 30000142);
  assert.equal(wrap?.defaultDestination.solarSystemID, 30100000);
  assert.equal(wrap?.daysUntilCanDeliver, 5);
  assert.equal(wrap?.daysUntilAutoMove, 20);
  assert.throws(() => readSafetyWraps([row(values.filter(([key]) => key !== "daysUntilCanDeliver"))]), /invalid daysUntilCanDeliver/);
});

test("reads each selectable destination's own system from a flat list", () => {
  assert.deepEqual(readSafetyTargets({ type: "list", items: [jita, zarzakh] }).map(t => [t.itemID, t.solarSystemID]), [
    [60003760, 30000142], [60015187, 30100000],
  ]);
  assert.deepEqual(readSafetyTargets({ type: "list", items: [] }), []);
  assert.throws(() => readSafetyTargets([[jita], zarzakh]), /invalid itemID/);
});
