import test from "node:test";
import assert from "node:assert/strict";
import { createFleetCombatAuthority, decodeFleetCombatSetup } from "./fleetAuthority.ts";
const setup = {
  operationID: "op",
  operationRunID: "generation",
  missionOwnerID: 1,
  agentID: 10,
  missionCount: 1 as const,
  members: [
    { characterID: 1, shipID: 11 },
    { characterID: 2, shipID: 12 },
  ],
};
const identity = {
  agentID: 10,
  missionID: 2504,
  titleID: 1,
  acceptedKey: "mission",
  contentID: 2504,
  dungeonID: 875,
  destinationSystemID: 300,
  locationNumber: 0,
  instanceID: 40,
  roomID: 1,
};
const anchor = { x: 1, y: 2, z: 3 };
test("optional loss retires only its exact authority; required loss and Mission Owner loss fence the operation", () => {
  let lost = false;
  const optional = {
    ...setup,
    members: [
      { characterID: 1, shipID: 11, required: false },
      { characterID: 2, shipID: 12, required: false },
    ],
  };
  assert.deepEqual(decodeFleetCombatSetup(optional), optional);
  assert.equal(
    decodeFleetCombatSetup({
      ...optional,
      members: [{ ...optional.members[0], required: "yes" }, optional.members[1]],
    }),
    null,
  );
  const a = createFleetCombatAuthority(optional);
  a.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  a.register(
    2,
    "optional",
    2,
    () => {
      if (lost) throw Error("session disappeared");
    },
    async () => {},
  );
  a.publish(1, "owner", 1, identity, anchor);
  lost = true;
  a.all();
  assert.deepEqual(
    a.activeMembers().map((m) => m.characterID),
    [1],
  );
  assert.equal(a.isStopping(), false);
  assert.equal(a.everyoneArrived(), true);
  a.publish(1, "owner", 1, identity, anchor);
  assert.throws(() => a.read(2, "optional", 2), /retired/);
  assert.equal(a.retire(1, "owner Stop"), "STOP_OPERATION");
  assert.equal(a.isStopping(), true);
  const b = createFleetCombatAuthority(setup);
  b.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  b.register(
    2,
    "required",
    2,
    () => {},
    async () => {},
  );
  assert.equal(b.retire(2, "required loss"), "STOP_OPERATION");
  assert.equal(b.isStopping(), true);
});
test("setup requires exact distinct held pilots and mission owner", () => {
  assert.deepEqual(decodeFleetCombatSetup(setup), setup);
  assert.equal(decodeFleetCombatSetup({ ...setup, missionOwnerID: 9 }), null);
  assert.equal(
    decodeFleetCombatSetup({ ...setup, members: [setup.members[0], setup.members[0]] }),
    null,
  );
  assert.equal(decodeFleetCombatSetup({ ...setup, extra: true }), null);
});
test("a different fleet anchor has a fresh arrival fence without becoming mission owner", () => {
  let now = 100;
  const x = { ...setup, anchorID: 2 };
  assert.deepEqual(decodeFleetCombatSetup(x), x);
  assert.equal(decodeFleetCombatSetup({ ...x, anchorID: 9 }), null);
  const a = createFleetCombatAuthority(x, () => now);
  a.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  a.register(
    2,
    "anchor",
    2,
    () => {},
    async () => {},
  );
  assert.throws(() => a.publish(2, "anchor", 2, identity, anchor), /Primary/);
  a.publish(1, "owner", 1, identity, anchor);
  const room = a.read(2, "anchor", 2);
  assert.equal(a.memberArrived(2), false);
  a.arrived(2, "anchor", 2, room.serial);
  assert.equal(a.memberArrived(2), true);
  now += 15001;
  assert.equal(a.memberArrived(2), false);
});
test("exact owner generation publishes a fresh room; stale callbacks cannot act", () => {
  let now = 100;
  const a = createFleetCombatAuthority(setup, () => now);
  const leave = a.register(
    1,
    "owner",
    3,
    () => {},
    async () => {},
  );
  a.register(
    2,
    "assistant",
    4,
    () => {},
    async () => {},
  );
  assert.throws(() => a.publish(2, "assistant", 4, identity, anchor), /Primary/);
  a.publish(1, "owner", 3, identity, anchor);
  const r = a.read(2, "assistant", 4);
  assert.deepEqual(r.room.identity, identity);
  assert.throws(() => a.publish(1, "owner", 3, { ...identity, roomID: 2 }, anchor), /settle/);
  now += 15001;
  assert.throws(() => a.assert(2, "assistant", 4, r.serial), /changed/);
  leave();
  assert.throws(() => a.read(2, "assistant", 4), /retired/);
});
test("settlement fence retires old room before waiting for all members; failure blocks transition", async () => {
  const a = createFleetCombatAuthority(setup);
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  a.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  a.register(
    2,
    "assistant",
    2,
    () => {},
    async () => wait,
  );
  a.publish(1, "owner", 1, identity, anchor);
  const old = a.read(2, "assistant", 2);
  const p = a.settleRoom(1, "owner", 1);
  assert.throws(() => a.assert(2, "assistant", 2, old.serial), /changed/);
  release();
  await p;
  a.publish(1, "owner", 1, { ...identity, roomID: 2 }, anchor);
  assert.equal(a.read(2, "assistant", 2).room.identity.roomID, 2);
  const b = createFleetCombatAuthority(setup);
  b.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  b.register(
    2,
    "assistant",
    2,
    () => {},
    async () => {
      throw Error("unresolved drone");
    },
  );
  b.publish(1, "owner", 1, identity, anchor);
  await assert.rejects(b.settleRoom(1, "owner", 1), /unresolved drone/);
  assert.throws(() => b.read(2, "assistant", 2), /retired/);
});

test("owner selects one shared hostile primary and retirement never claims a kill", () => {
  const a = createFleetCombatAuthority(setup);
  a.register(
    1,
    "owner",
    1,
    () => {},
    async () => {},
  );
  a.register(
    2,
    "assistant",
    2,
    () => {},
    async () => {},
  );
  a.publish(1, "owner", 1, identity, anchor);
  assert.throws(() => a.selectTarget(2, "assistant", 2, [70, 71]), /Primary/);
  assert.equal(a.selectTarget(1, "owner", 1, [70, 71]), 70);
  const first = a.target(2, "assistant", 2);
  a.assertTarget(2, "assistant", 2, 70, first.generation);
  assert.throws(() => a.assertTarget(2, "assistant", 2, 71, first.generation), /changed/);
  assert.equal(a.selectTarget(1, "owner", 1, [71]), 71);
  assert.throws(() => a.assertTarget(2, "assistant", 2, 70, first.generation), /changed/);
  const second = a.target(2, "assistant", 2);
  assert.notEqual(second.generation, first.generation);
  a.assertTarget(2, "assistant", 2, 71, second.generation);
  assert.equal(a.selectTarget(1, "owner", 1, []), null);
  assert.throws(() => a.assertTarget(2, "assistant", 2, 71, second.generation), /changed/);
});

test("fleet setup accepts a selected parking policy without changing legacy canonical setup", () => {
  const parking = { mode: "selected", kind: "structure", destinationID: 600, systemID: 300 },
    x = { ...setup, parking };
  assert.deepEqual(decodeFleetCombatSetup(x), x);
  assert.equal(decodeFleetCombatSetup({ ...x, parking: { ...parking, destinationID: 0 } }), null);
  assert.deepEqual(decodeFleetCombatSetup(setup), setup);
});

test("fleet setup supports exactly one automatic owner agent policy", () => {
  const { agentID: _, ...base } = setup,
    agent = { mode: "auto", maxJumps: 8, corporationID: null },
    x = { ...base, agent };
  assert.deepEqual(decodeFleetCombatSetup(x), x);
  assert.equal(decodeFleetCombatSetup({ ...x, agentID: 4 }), null);
  assert.equal(decodeFleetCombatSetup({ ...x, agent: { ...agent, maxJumps: -1 } }), null);
});
