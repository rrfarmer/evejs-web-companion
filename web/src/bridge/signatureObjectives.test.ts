import test from "node:test";
import assert from "node:assert/strict";
import { decodeObjectiveChain, ObjectiveChain } from "./abyssObjectives.ts";
import type { SpaceEntity } from "../store/types.ts";

test("the authored container objective follows slim state and the hacking pilot", () => {
  const data = decodeObjectiveChain({
    found: true,
    chainID: 102,
    chain: { objectives: [{ key: "hack", objectiveType: 81, startActive: 1, showCompleted: 1 }] },
    objectiveTypes: { 81: { title: "UI/Objectives/Titles/HackContainers", tasks: [{ key: "hack", taskType: 55, startActive: 1, showCompleted: 1 }] } },
    taskTypes: { 55: {} },
    typeLists: {},
  });
  assert.ok(data);
  const pilot = 140000001;
  const chain = new ObjectiveChain(data, {}, pilot);
  const item = (itemID: number, hackingSecurityState?: number, ownerID: number | null = null) =>
    ({ itemID, typeID: 76186, isSelf: false, hackingSecurityState, ownerID } as SpaceEntity);
  const can = item(101, 0), sealed = item(102, 3), unrelated = item(103);
  chain.start([can, sealed, unrelated]);
  const completion = () => chain.view()[0]?.rows.map(({ itemID, completed }) => [itemID, completed]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 1, pilot), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 2, pilot + 1), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, false], [102, false]]);
  chain.observe([item(101, 2, pilot), sealed, unrelated]);
  assert.deepEqual(completion(), [[101, true], [102, false]]);
  chain.observe([item(101, 2, pilot), unrelated]);
  assert.deepEqual(completion(), [[101, true]]);
  assert.equal(chain.view()[0]?.completed, true);
});
