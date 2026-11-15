import assert from "node:assert/strict";
import test from "node:test";
import { jumpBridgeZone, readJumpBridgeCharge, rechargedJumpBridgeGJ } from "./jumpBridgePanel.ts";

test("24.02 authorized bridge charge is decoded without treating a redaction as zero", () => {
  const klass = { type: "token", value: "jumpbridge.common.jump_bridge_authorized_info.JumpBridgeAuthorizedInfo" };
  assert.equal(readJumpBridgeCharge(null), null);
  assert.deepEqual(readJumpBridgeCharge({ type: "objectex1", header: [klass, [true, { type: "real", value: 0 }]] }),
    { validShipType: true, chargeGJ: 0 });
  assert.deepEqual(readJumpBridgeCharge({ type: "objectex1", header: [klass, [false, 60000.5]] }),
    { validShipType: false, chargeGJ: 60000.5 });
  assert.throws(() => readJumpBridgeCharge({ type: "objectex1", header: [klass, [true, null]] }), /unreadable charge/);
});

test("Ansiblex distance zones include their upper bounds", () => {
  assert.deepEqual([0, 5, 5.01, 10, 10.01, 15, 15.01, 20, 20.01].map(jumpBridgeZone), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
});

test("the bridge charge rebuilds on the client curve after the sample", () => {
  assert.equal(rechargedJumpBridgeGJ(125, 500, 5000, 0), 125);
  assert.equal(rechargedJumpBridgeGJ(125, 500, 5000, -1), 125);
  const expected = 500 * (1 - 0.5 / Math.E) ** 2;
  assert.ok(Math.abs(rechargedJumpBridgeGJ(125, 500, 5000, 1000) - expected) < 1e-9);
  assert.equal(rechargedJumpBridgeGJ(500, 500, 5000, 50), 500);
});
