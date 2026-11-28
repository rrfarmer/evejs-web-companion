import test from "node:test";
import assert from "node:assert/strict";
import { createAnomalyClaim } from "./claim.ts";
const site = {
  systemID: 3,
  instanceID: 5,
  dungeonID: 5579,
  scannerKey: 7,
  label: "A",
  position: { x: 0, y: 0, z: 0 },
  observedAt: 1,
};
test("exact anomaly claim persists and only parked original owner releases it", () => {
  let value: unknown = null;
  const doc = {
    read: () => value,
    write: (v: unknown) => {
      value = structuredClone(v);
    },
  };
  const first = createAnomalyClaim(doc, site, "op", "run");
  assert.throws(() => createAnomalyClaim(doc, site, "other", "run"), /already claimed/);
  assert.throws(() => first.release({ state: "COMBAT", settledAndParked: false }), /not settled/);
  createAnomalyClaim(doc, site, "op", "run").assertCurrent();
  first.release({ state: "STOPPED", settledAndParked: true });
  first.release({ state: "STOPPED", settledAndParked: true });
  assert.throws(() => first.assertCurrent(), /changed/);
  assert.throws(() => createAnomalyClaim(doc, site, "op", "run"), /terminal/);
  createAnomalyClaim(doc, site, "other", "new").assertCurrent();
});
