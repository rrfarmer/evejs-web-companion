import test from "node:test";
import assert from "node:assert/strict";
import { equipmentState, readEquipmentSource, equipmentSourceKey } from "./equipment.ts";
import type { MinerStage } from "./types.ts";
const stage = { skillQualification: "READY", equipment: { observedAt: 100, validUntil: 200, status: { equipment: "VERIFIED", supplies: "LOW" } } } as MinerStage;
test("fresh LOW supplies are independent of Equipment VERIFIED and Duty Ready", () => {
  assert.deepEqual(equipmentState(stage, 150), { equipment: "VERIFIED", supplies: "LOW", duty: "DUTY READY", fresh: true });
  assert.equal(equipmentState({ ...stage, skillQualification: "NOT_READY" }, 150).duty, "NOT DUTY READY");
});
test("expired, missing or future equipment evidence cannot leave a green Duty Ready badge", () => {
  for (const at of [99, 200, 201]) assert.deepEqual(equipmentState(stage, at), { equipment: "UNKNOWN", supplies: "UNKNOWN", duty: "NOT DUTY READY", fresh: false });
  assert.equal(equipmentState(undefined, 150).duty, "NOT DUTY READY");
});
test("equipment source storage is separate, exact and refuses invalid corporation state", () => {
  const storage = { getItem: (_key: string) => '{"kind":"corp","corporationID":20,"division":7}', setItem() {} };
  assert.equal(equipmentSourceKey("A", 11), "pilot-training:equipment-source:v1:A:11");
  assert.deepEqual(readEquipmentSource(storage, "A", 11), { kind: "corp", corporationID: 20, division: 7 });
  assert.throws(() => readEquipmentSource({ ...storage, getItem: () => '{"kind":"corp","division":1}' }, "A", 11));
});
