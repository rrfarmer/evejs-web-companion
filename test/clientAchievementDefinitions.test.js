"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readAchievementDefinitions } = require("../src/clientData/achievementDefinitions");

// Small synthetic ACHV layout. The two root fields point to separate tables;
// the career root has a milestone vector and the challenge root has none.
function catalogue() {
  const b = Buffer.alloc(257);
  b.writeUInt32LE(16, 0);
  b.write("ACHV", 4);
  function table(vtable, object, fields, size) {
    b.writeUInt16LE(4 + fields.length * 2, vtable);
    b.writeUInt16LE(size, vtable + 2);
    fields.forEach((value, i) => b.writeUInt16LE(value, vtable + 4 + i * 2));
    b.writeInt32LE(object - vtable, object);
  }
  function string(ref, target, value) {
    b.writeUInt32LE(target - ref, ref);
    b.writeUInt32LE(Buffer.byteLength(value), target);
    b.write(value, target + 4);
  }
  table(8, 16, [4, 8], 12);
  b.writeUInt32LE(28, 20);
  b.writeUInt32LE(52, 24);
  table(32, 48, [4, 8, 0, 0, 12], 16);
  table(68, 76, [4, 8], 12);
  string(52, 132, "00000000-0000-0000-0000-000000000001");
  string(80, 174, "00000000-0000-0000-0000-000000000002");
  b.writeUInt32LE(110, 56);
  b.writeUInt32LE(120, 84);
  b.writeUInt32LE(32, 60);
  b.writeUInt32LE(1, 92);
  b.writeUInt32LE(20, 96);
  table(108, 116, [4, 8], 12);
  string(120, 216, "00000000-0000-0000-0000-000000000003");
  b.writeUInt32LE(750, 124);
  return b;
}

test("the 24.02 achievement catalogue preserves category identities and milestone targets", () => {
  const result = readAchievementDefinitions(catalogue());
  assert.deepEqual(Object.keys(result.roots), ["career", "challenges"]);
  const [career, challenges] = result.categories;
  assert.equal(career.id, result.roots.career);
  assert.equal(career.name, 110);
  assert.deepEqual(career.milestones, [{ id: "00000000-0000-0000-0000-000000000003", target: 750, rewards: [] }]);
  assert.equal(challenges.id, result.roots.challenges);
  assert.equal(challenges.name, 120);
  assert.deepEqual(result.achievements, []);
});

test("the decoder rejects a truncated catalogue and a vector larger than its buffer", () => {
  const b = catalogue();
  assert.throws(() => readAchievementDefinitions(b.subarray(0, 160)), /Invalid achievement definitions/);
  b.writeUInt32LE(0xffffffff, 92);
  assert.throws(() => readAchievementDefinitions(b), /Invalid achievement definitions/);
});
