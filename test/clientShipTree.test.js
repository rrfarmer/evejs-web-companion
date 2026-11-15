"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { expandClientTypeList, shipTreeTypeIndex } = require("../src/clientData/shipTree");
const { createClientTextures } = require("../src/clientData/clientTextures");

test("ship tree membership keeps Academy hulls separate and applies publication only to regular ships", () => {
  const typeGroups = { 1: 10, 2: 10, 3: 10, 4: 11, 5: 12, 6: 11, 7: 10, "#order": [1, 2, 3, 4, 5, 6, 7] };
  const groups = { 10: { categoryID: 6, published: true }, 11: { categoryID: 6, published: false }, 12: { categoryID: 7, published: true } };
  const academyList = { includedGroupIDs: [11], includedTypeIDs: [2, 5], excludedTypeIDs: [4] };
  const typeShipGroups = { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 8 };
  const typeFactions = { 1: 500001, 2: 500001, 3: 500001, 4: 500001, 5: 500001, 6: 500003, 7: 500003 };
  const typePublished = { 1: true, 2: true, 3: false, 4: true, 5: true, 6: false, 7: true };
  assert.deepEqual(expandClientTypeList(academyList, typeGroups, groups), [6, 2, 5]);
  assert.deepEqual(shipTreeTypeIndex({ academyList, typeGroups, groups, typeShipGroups, typeFactions, typePublished }), [
    { typeID: 1, factionID: 500001, shipGroupID: 8, academy: false },
    { typeID: 2, factionID: 500001, shipGroupID: 8, academy: true },
    { typeID: 6, factionID: 500003, shipGroupID: 8, academy: true },
  ]);
});

test("the Ship Tree permits indexed hologram assets with the native basename", () => {
  const textures = createClientTextures({ clientRoot: "/test-install", readFile: () => [
    "res:/dx9/model/ship/caldari/cf4/icons/cf4_isis.png,aa/texture",
    "res:/dx9/model/ship/caldari/cf4/icons/cf4_other.png,aa/other",
  ].join("\n") });
  assert.match(textures.fileFor("res:/dx9/model/ship/caldari/cf4/icons/cf4_isis.png"), /aa[/\\]texture$/);
  assert.equal(textures.fileFor("res:/dx9/model/ship/caldari/cf4/icons/cf4_other.png"), null);
});
