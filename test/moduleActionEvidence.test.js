"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { moduleActive } = require("../src/moduleActionEvidence");
test("a different module starting is never proof of requested activation", () => {
  assert.equal(moduleActive([9], 8, null), null);
  assert.equal(moduleActive([9], 8, {}), false);
});
test("exact requested ID or authoritative bank membership proves activity", () => {
  assert.equal(moduleActive([8], 8, null), true);
  assert.equal(moduleActive([9], 8, { 9: [8] }), true);
  assert.equal(moduleActive([], 8, { 9: [8] }), false);
  assert.equal(moduleActive(null, 8, {}), null);
});
