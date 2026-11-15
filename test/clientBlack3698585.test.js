"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function blackFile(strings, object) {
  const stringData = Buffer.from(strings.join("\0") + "\0", "utf8");
  const table = Buffer.alloc(6);
  table.writeUInt32LE(2 + stringData.length, 0);
  table.writeUInt16LE(strings.length, 4);
  const wide = Buffer.alloc(6);
  wide.writeUInt32LE(2, 0);
  const magic = Buffer.alloc(8);
  magic.writeUInt32LE(0xb1acf11e, 0);
  magic.writeUInt32LE(1, 4);
  return Buffer.concat([magic, table, stringData, wide, object]);
}

// A small Black object using the 3698585 reflection's persistent SHAREDSTRING
// field. The member after it proves the reader stays aligned.
function controllerFile(groupIndex = 2) {
  const strings = ["EveSOFDataHullController", "visibilityGroup", "primary", "path", "res:/controller.red"];
  const object = Buffer.alloc(18);
  object.writeInt32LE(1, 0);
  object.writeUInt32LE(10, 4);
  object.writeUInt16LE(0, 8);
  object.writeUInt16LE(1, 10);
  object.writeUInt16LE(groupIndex, 12);
  object.writeUInt16LE(3, 14);
  object.writeUInt16LE(4, 16);
  return blackFile(strings, object);
}

function locatorFile(stride) {
  const strings = ["EveLocatorSets", "locators", "name", "steam"];
  const rows = [[232, -77, -419, 0, 1, 0, 0, 1, 1, 1, 2], [360, -81, -289, 1, 0, 0, 0, 2, 2, 2, 3]];
  const object = Buffer.alloc(22 + rows.length * stride);
  object.writeInt32LE(1, 0);
  object.writeUInt32LE(object.length - 8, 4);
  object.writeUInt16LE(1, 10);
  object.writeInt32LE(rows.length, 12);
  object.writeUInt16LE(stride, 16);
  for (const [index, row] of rows.entries()) {
    const start = 18 + index * stride;
    row.slice(0, 10).forEach((value, field) => object.writeFloatLE(value, start + 4 * field));
    object.writeInt32LE(row[10], start + 40);
  }
  object.writeUInt16LE(2, object.length - 4);
  object.writeUInt16LE(3, object.length - 2);
  return blackFile(strings, object);
}

test("legacy and 24.02 locator rows decode without shifting the next row or member", async () => {
  const { readBlack } = await import("../tools/client-extract/lib/black.mjs");
  const expected = [
    [[232, -77, -419], [0, 1, 0, 0], [1, 1, 1], 2],
    [[360, -81, -289], [1, 0, 0, 0], [2, 2, 2], 3],
  ];
  for (const stride of [44, 48]) {
    const set = readBlack(locatorFile(stride));
    assert.equal(set.name, "steam");
    assert.deepEqual(set.locators.items, expected);
  }
  assert.throws(() => readBlack(locatorFile(52)), /structure stride 52 in file, expected 44 or 48/);
});

test("3698585 controller visibility group is decoded without shifting the next member", async () => {
  const { readBlack } = await import("../tools/client-extract/lib/black.mjs");
  assert.deepEqual(readBlack(controllerFile()), {
    type: "EveSOFDataHullController", visibilityGroup: "primary", path: "res:/controller.red",
  });
  assert.throws(() => readBlack(controllerFile(999)), /invalid string index/);
});

test("standalone hull controllers respect faction visibility groups", async () => {
  const { hullControllerEntries } = await import("../tools/client-extract/lib/children.mjs");
  const controllers = [
    { path: "common" },
    { path: "empty", visibilityGroup: "" },
    { path: "academy", visibilityGroup: "academy_air" },
    { path: "winter", visibilityGroup: "winter_2026" },
    { path: "placement", visibilityGroup: "academy_air", buildFilter: 2 },
  ];
  const faction = { visibilityGroupSet: { visibilityGroups: [{ str: "primary" }, { str: "academy_air" }] } };
  assert.deepEqual(hullControllerEntries({ controllers }, faction).map((c) => c.path), ["common", "empty", "academy"]);
  assert.deepEqual(hullControllerEntries({ controllers }, null).map((c) => c.path), ["empty"]);
});
