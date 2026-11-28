import assert from "node:assert/strict";
import test from "node:test";
import { clearNativeQueue, currentTrainingRequirements, queueIdentity, trainingQueueProof, trainingSheetFromProof } from "./queue.ts";

const active = { characterID: 7, skills: [{ typeID: 10, level: 1 }],
  queue: { active: true, maxEntries: 50, entries: [{ typeID: 10, toLevel: 2 }] } };
const cleared = { ...active, queue: { ...active.queue, active: false, entries: [] } };

test("a lost clear response uses native readback without a second save", async () => {
  let writes = 0;
  const after = await clearNativeQueue(queueIdentity(active.queue), async () => writes ? cleared : active, async () => {
    writes++;
    throw Error("Response lost");
  });
  assert.equal(writes, 1);
  assert.deepEqual(trainingSheetFromProof(trainingQueueProof(after), 7), cleared);
  assert.equal(trainingSheetFromProof(trainingQueueProof(after), 8), null);
});

test("clear removes obsolete training and queued levels from plan requirements", () => {
  const plan = [{typeID:10,level:2,currentLevel:1,bookMissing:false}];
  assert.equal(currentTrainingRequirements(plan,active)[0]?.reviewState,"TRAINING");
  assert.deepEqual(currentTrainingRequirements(plan,cleared),[{...plan[0],queuedLevel:0,reviewState:"MISSING"}]);
});

test("a changed queue is not cleared and an unverified save is not replayed", async () => {
  let writes = 0;
  const save = async () => { writes++; throw Error("Response lost"); };
  const changed = { ...active, queue: { ...active.queue, active: false } };
  await assert.rejects(clearNativeQueue(queueIdentity(active.queue), async () => changed, save), /queue changed/);
  assert.equal(writes, 0);
  await assert.rejects(clearNativeQueue(queueIdentity(active.queue), async () => active, save), /Response lost/);
  assert.equal(writes, 1);
});
