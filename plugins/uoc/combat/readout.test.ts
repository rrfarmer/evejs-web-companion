import test from "node:test";
import assert from "node:assert/strict";
import { securityReadout } from "./readout.ts";
test("large durable diagnostics cannot obscure exact completion receipts", () => {
  const state = {
    runID: "run",
    completed: [1, 2].map((n) => ({
      identity: { acceptedKey: `key-${n}`, missionID: n, dungeonID: n + 10, instanceID: n + 20 },
      commandID: `cmd-${n}`,
      reward: { confirmedIsk: "10.00" },
    })),
  } as never;
  const diagnostics = {
    runID: "run",
    events: Array.from({ length: 64 }, (_, n) => ({
      kind: "sample",
      at: n,
      data: {
        target: n + 1,
        npc: {
          itemID: n + 1,
          shield: 1,
          armor: 1,
          hull: 1,
          position: { x: 1200000000000, y: -160000000000, z: -2000000000000 },
        },
        drones: Array.from({ length: 5 }, (_, i) => ({
          itemID: 9123400000100 + i,
          ownerID: 141100100,
          controllerID: 9123400000101,
          targetID: n + 1,
          activity: "chasing",
          position: { x: 1200000000000, y: -160000000000, z: -2000000000000 },
          distanceToShip: 19000,
          distanceToTarget: 30000,
        })),
      },
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) > 53000);
  const readout = securityReadout(state, diagnostics);
  assert.equal(readout.completedCount, 2);
  assert.deepEqual(readout.latestReceipt, { missionKey: "key-2", commandID: "cmd-2" });
  assert.equal("completions" in readout, false);
  assert.ok(Buffer.byteLength(JSON.stringify(readout)) < 16384);
  assert.equal(readout.diagnostics.eventCount, 64);
});
test("readout refuses another run generation", () => {
  assert.throws(
    () => securityReadout({ runID: "old", completed: [] } as never, { runID: "new", events: [] }),
    /journal/,
  );
});
