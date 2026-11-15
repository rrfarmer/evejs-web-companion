import assert from "node:assert/strict";
import { test } from "node:test";
import { AIR_FACTION, raceShipTree, shipTreeGraph, type ShipTreeCatalogue, type ShipTreeHull } from "./shipTree.ts";

const icon = { holoIcon: null, nameID: null, descriptionID: null, rigSize: 1 };
const hull = (typeID: number, factionID: number, shipGroupID: number, academy = false): ShipTreeHull =>
  ({ ...icon, typeID, factionID, shipGroupID, academy });
const data: ShipTreeCatalogue = { classes: {}, capsule: icon, ships: [
  hull(200, 500003, 8, true), hull(601, 500003, 8), hull(100, 500003, 8, true),
  hull(500, 500001, 8, true), hull(700, 500014, 41, true), hull(701, 500014, 2108),
  hull(900, 500010, 16), hull(901, 500010, 32),
] };

test("AIR uses the native empire and ORE branches, narrow column offsets and Academy-only hulls", () => {
  const graph = shipTreeGraph(data, AIR_FACTION, true);
  const branches = graph.nodes.filter(node => node.kind === "group");
  assert.deepEqual(branches.map(node => [node.factionID, Math.round(node.x), node.chrome, node.columns]), [
    [500003, 175, true, 1], [500001, 320, false, 1], [500004, 419, false, 1],
    [500002, 518, false, 1], [500014, 723, true, 1],
  ]);
  assert.deepEqual(branches[0]?.ships.map(ship => ship.typeID), [100, 200]);
  assert.deepEqual(branches[4]?.ships.map(ship => ship.typeID), [700]);
  assert.deepEqual(graph.edges, [{ from: 0, to: 1 }, { from: 4, to: 5 }]);
});

test("a regular tree appends Academy hulls only when Academy is visible", () => {
  const id = raceShipTree(4);
  const ships = (visible: boolean) => shipTreeGraph(data, id, visible).nodes.find(node => node.groupID === 8)?.ships;
  assert.deepEqual(ships(false)?.map(ship => ship.typeID), [601]);
  assert.deepEqual(ships(true)?.map(ship => ship.typeID), [601, 100, 200]);
  assert.ok(shipTreeGraph(data, 500014, true).nodes.some(node => node.groupID === 2108 && node.ships[0]?.typeID === 701));
});

test("pirate trees place only their inhabited groups and connect both parent factions", () => {
  const graph = shipTreeGraph(data, 500010, true);
  assert.deepEqual(graph.nodes.filter(node => node.kind === "group").map(node => node.groupID), [16, 32]);
  assert.deepEqual(graph.nodes.filter(node => node.kind === "faction").map(node => [node.groupID, node.factionID]),
    [[16, 500001], [16, 500004], [32, 500001], [32, 500004]]);
});
