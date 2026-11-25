import test from "node:test";
import assert from "node:assert/strict";
test("only a fresh exact-room observation may retire a disappeared target", async () => {
  const { confirmAbsentTarget } = await import("./targetAbsence.ts");
  const id = { acceptedKey: "mission", dungeonID: 875, instanceID: 2366, roomID: 5 };
  const base = {
    identity: id,
    mission: { acceptedKey: "mission", status: "accepted" },
    dungeon: { dungeonID: 875, instanceID: 2366, roomID: 5 },
    flight: { inSpace: true, shipID: 3 },
    scene: {
      stateValid: true,
      inSpace: true,
      shipID: 3,
      ship: { itemID: 3, geometryAvailable: true, position: { x: 0, y: 0, z: 0 } },
      entities: [{ itemID: 8, kind: "drone", ownerID: 2, controllerID: 3 }],
    },
    anchor: { x: 0, y: 0, z: 0 },
    ownerID: 2,
    ids: [8],
    target: 42,
  };
  assert.equal(confirmAbsentTarget(base), true);
  assert.equal(
    confirmAbsentTarget({ ...base, scene: { ...base.scene, stateValid: undefined } }),
    true,
  );
  assert.equal(
    confirmAbsentTarget({
      ...base,
      scene: { ...base.scene, entities: [...base.scene.entities, { itemID: 42, kind: "ship" }] },
    }),
    false,
  );
  assert.throws(() =>
    confirmAbsentTarget({ ...base, dungeon: { ...base.dungeon, instanceID: 99 } }),
  );
  assert.throws(() =>
    confirmAbsentTarget({ ...base, scene: { ...base.scene, stateValid: false } }),
  );
  assert.throws(() =>
    confirmAbsentTarget({ ...base, mission: { acceptedKey: "other", status: "accepted" } }),
  );
  assert.throws(() => confirmAbsentTarget({ ...base, anchor: { ...base.anchor, x: NaN } }));
  assert.throws(() => confirmAbsentTarget({ ...base, ids: [8, 8] }));
});
