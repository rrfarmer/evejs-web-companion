import test from "node:test";
import assert from "node:assert/strict";
import { decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import { claimedSiteRocks, type NativeSite } from "./siteDiscovery.ts";
const site: NativeSite = {
  scannerKey: 55,
  instanceID: 89,
  label: "ore-site",
  archetypeID: 27,
  observedAt: 1,
  target: {
    kind: "ORE_ANOMALY",
    systemID: 300,
    name: "ore-site",
    siteID: 55,
    instanceID: 89,
    position: { x: 1000, y: 0, z: 0 },
  },
};
const rock = {
  itemID: 33,
  typeID: 1228,
  categoryID: 25,
  beltID: null,
  position: { x: 2000, y: 0, z: 0 },
  radius: 100,
};
const scene = (
  entities: any[],
  ship: any = { itemID: 11, characterID: 1, position: { x: 1000, y: 0, z: 0 }, radius: 10 },
) =>
  decodeSpaceSnapshot({
    stateValid: true,
    inSpace: true,
    shipID: 11,
    solarSystemID: 300,
    sampledAtMs: 10,
    ship,
    entities,
  } as any);
test("exact ore site yields only nearby unassociated asteroid scene entries", () => {
  const rows = claimedSiteRocks(
    scene([
      rock,
      { ...rock, itemID: 34, position: { x: 200000, y: 0, z: 0 } },
      { ...rock, itemID: 35, beltID: 99 },
    ]),
    site,
    [site],
    11,
    1,
  );
  assert.deepEqual(
    rows.map((r) => r.itemID),
    [33],
  );
});
test("replacement, another nearby site or belt, and wrong ship prevent source association", () => {
  assert.throws(
    () =>
      claimedSiteRocks(
        scene([rock]),
        site,
        [{ ...site, instanceID: 90, target: { ...site.target, instanceID: 90 } }],
        11,
        1,
      ),
    /replaced/,
  );
  assert.throws(
    () =>
      claimedSiteRocks(
        scene([rock]),
        site,
        [site, { ...site, scannerKey: 56, target: { ...site.target, siteID: 56 } }],
        11,
        1,
      ),
    /overlaps/,
  );
  assert.throws(
    () =>
      claimedSiteRocks(
        scene([rock, { itemID: 99, groupID: 9, position: { x: 1000, y: 0, z: 0 }, radius: 10 }]),
        site,
        [site],
        11,
        1,
      ),
    /overlaps/,
  );
  assert.throws(
    () =>
      claimedSiteRocks(
        scene([rock], {
          itemID: 11,
          characterID: 2,
          position: { x: 1000, y: 0, z: 0 },
          radius: 10,
        }),
        site,
        [site],
        11,
        1,
      ),
    /grid/,
  );
});

test("classified source change blocks new mining authority even on the same physical grid", () => {
  const chosen: NativeSite = {
    ...site,
    scannerKey: 5800000300001,
    sourceDungeonID: 1456,
    siteFamily: "ORE",
    target: { ...site.target, siteID: 5800000300001 },
  };
  assert.deepEqual(
    claimedSiteRocks(scene([rock]), chosen, [chosen], 11, 1).map((r) => r.itemID),
    [33],
  );
  assert.throws(
    () => claimedSiteRocks(scene([rock]), chosen, [{ ...chosen, sourceDungeonID: 1413 }], 11, 1),
    /replaced/,
  );
});
test("generated F5 ice associates only exact child IDs despite its nearby native belt", () => {
  const anchor = 5400027810000,
    ice: NativeSite = {
      scannerKey: anchor,
      instanceID: 3535,
      label: "ice",
      archetypeID: 28,
      observedAt: 10,
      siteFamily: "ICE",
      sourceDungeonID: 5497,
      target: {
        kind: "ICE",
        systemID: 30002781,
        name: "ice",
        siteID: anchor,
        instanceID: 3535,
        position: { x: 0, y: 0, z: 0 },
      },
    };
  const sc = (rows: any[]) =>
      decodeSpaceSnapshot({
        stateValid: true,
        inSpace: true,
        shipID: 11,
        solarSystemID: 30002781,
        sampledAtMs: 10,
        ship: { itemID: 11, characterID: 1, position: { x: 1, y: 0, z: 0 }, radius: 10 },
        entities: rows,
      } as any),
    belt = { itemID: 40009129, groupID: 9, position: { x: 120000, y: 0, z: 0 }, radius: 25000 },
    child = { ...rock, itemID: anchor + 1, position: { x: 2000, y: 0, z: 0 } },
    foreign = { ...child, itemID: anchor + 101 },
    parented = { ...child, itemID: anchor + 2, beltID: 40009129 };
  assert.deepEqual(
    claimedSiteRocks(sc([belt, child, foreign, parented]), ice, [ice], 11, 1).map((r) => r.itemID),
    [anchor + 1],
  );
  assert.throws(
    () =>
      claimedSiteRocks(
        sc([belt, child]),
        ice,
        [
          ice,
          { ...ice, scannerKey: anchor + 100, target: { ...ice.target, siteID: anchor + 100 } },
        ],
        11,
        1,
      ),
    /overlaps/,
  );
  for (const other of [
    { ...ice, siteFamily: undefined, sourceDungeonID: undefined },
    { ...ice, scannerKey: anchor + 1, target: { ...ice.target, siteID: anchor + 1 } },
  ] as NativeSite[])
    assert.throws(() => claimedSiteRocks(sc([belt, child]), other, [other], 11, 1), /overlaps/);
  assert.throws(
    () => claimedSiteRocks(sc([belt, child]), ice, [{ ...ice, sourceDungeonID: 5498 }], 11, 1),
    /replaced/,
  );
});
