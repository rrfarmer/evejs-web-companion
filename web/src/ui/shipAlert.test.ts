import assert from "node:assert/strict";
import test from "node:test";
import { activeAlertLevel, capacitorAlerting, capacitorChanged, damageStateChanged, initialShipAlertState, HULL, SHIELD } from "./shipAlert.ts";

test("classic HUD has no alert on session reset; recent hull damage outranks outer layers", () => {
  const fresh = initialShipAlertState();
  assert.equal(capacitorAlerting(fresh, 10), false);
  assert.equal(activeAlertLevel(fresh, 10, {}), null);

  const hit = damageStateChanged(fresh, [0.05, 0.1, 0.3], 100, {});
  assert.equal(activeAlertLevel(hit, 2099, {}), HULL);
  assert.equal(activeAlertLevel(hit, 2100, {}), null);

  const repaired = damageStateChanged(hit, [0.05, 1, 0.5], 150, {});
  assert.equal(activeAlertLevel(repaired, 151, {}), SHIELD);
  assert.equal(activeAlertLevel(repaired, 151, { shield: { enabled: false, threshold: null } }), null);
});

test("a low capacitor alerts on drain and recovery doesn't restart it", () => {
  const drained = capacitorChanged(initialShipAlertState(), 0.2, 100, {});
  assert.equal(capacitorAlerting(drained, 101), true);
  const recovered = capacitorChanged(drained, 0.25, 1_000, {});
  assert.equal(capacitorAlerting(recovered, 2_100), false);
});
