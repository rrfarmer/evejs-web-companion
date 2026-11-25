import test from "node:test";
import assert from "node:assert/strict";
import { createCivilianCheckpointRun } from "./checkpoint.ts";
test("held exact pilot reads original pending without native mutation and closes storage", async () => {
  let closed = 0;
  const reports: any[] = [];
  const run = createCivilianCheckpointRun(() => ({
    read(file, key) {
      if (file === "missions.sqlite")
        return {
          version: 1,
          characterID: 3,
          completed: false,
          pending: { kind: "complete" },
          history: [],
        };
      return {
        version: 1,
        records: {
          "1:3": {
            accountID: 1,
            characterID: 3,
            runID: "old",
            done: false,
            mission: { agentID: 4, missionKey: "key" },
            pending: { intent: { kind: "load" } },
          },
        },
      };
    },
    close() {
      closed++;
    },
  }));
  await run.start({
    characterID: 3,
    held: { characterID: 3 },
    resumed: false,
    report: (x: any) => reports.push(x),
  } as any);
  assert.equal(reports[0].readout.mining.pending, "complete");
  assert.equal(reports[0].readout.distribution.pending, "load");
  assert.equal(reports[0].readout.nativeReconciled, false);
  assert.equal(closed, 1);
});
test("foreign or malformed journal cannot be exposed as this pilot", async () => {
  const run = createCivilianCheckpointRun(() => ({
    read(file) {
      return file === "missions.sqlite"
        ? { version: 1, characterID: 4, completed: false, pending: null }
        : null;
    },
    close() {},
  }));
  await assert.rejects(
    async () =>
      await run.start({
        characterID: 3,
        held: { characterID: 3 },
        resumed: false,
        report() {
          throw Error("unexpected");
        },
      } as any),
    /unreadable/,
  );
  await assert.rejects(
    async () =>
      await run.start({ characterID: 3, held: { characterID: 4 }, resumed: false } as any),
    /owner/,
  );
});
