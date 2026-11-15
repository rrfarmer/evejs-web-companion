"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// A small Black object using the 3698585 reflection's persistent SHAREDSTRING
// field. The member after it proves the reader stays aligned.
function controllerFile(groupIndex = 2) {
  const strings = ["EveSOFDataHullController", "visibilityGroup", "primary", "path", "res:/controller.red"];
  const stringData = Buffer.from(strings.join("\0") + "\0", "utf8");
  const table = Buffer.alloc(6);
  table.writeUInt32LE(2 + stringData.length, 0);
  table.writeUInt16LE(strings.length, 4);
  const wide = Buffer.alloc(6);
  wide.writeUInt32LE(2, 0);
  const magic = Buffer.alloc(8);
  magic.writeUInt32LE(0xb1acf11e, 0);
  magic.writeUInt32LE(1, 4);
  const object = Buffer.alloc(18);
  object.writeInt32LE(1, 0);
  object.writeUInt32LE(10, 4);
  object.writeUInt16LE(0, 8);
  object.writeUInt16LE(1, 10);
  object.writeUInt16LE(groupIndex, 12);
  object.writeUInt16LE(3, 14);
  object.writeUInt16LE(4, 16);
  return Buffer.concat([magic, table, stringData, wide, object]);
}

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
