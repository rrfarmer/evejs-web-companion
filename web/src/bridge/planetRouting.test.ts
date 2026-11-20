import assert from "node:assert/strict";
import test from "node:test";
import { decodeRecipeBook } from "./piRecipes.ts";
import { decodeColonyReport } from "./planets.ts";
import { appendPlanetWaypoint, planetProduct, quotePlanetRoute, validateNewRoutes, validateRouteRemovals } from "./planetRouting.ts";

const recipes = decodeRecipeBook({ schematics: [{
  schematicID: 121, name: "Water", cycleTimeSeconds: 1800, factoryTypeIDs: [2473],
  output: { typeID: 3645, typeName: "Water", quantity: 100 }, inputs: [{ typeID: 2268, quantity: 3000 }],
}] });
const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077,
  pins: [
    { pinID: 1, kind: "factory", typeID: 2473, schematicID: 121, latitude: 1.1, longitude: 0.1 },
    { pinID: 2, kind: "storage", typeID: 2541, latitude: 1.1, longitude: 0.21 },
    { pinID: 3, kind: "storage", typeID: 2541, latitude: 1.1, longitude: 0.3 },
    { pinID: 4, kind: "storage", typeID: 2541, latitude: 1.1, longitude: 0.4 },
    { pinID: 5, kind: "storage", typeID: 2541, latitude: 1.2, longitude: 0.4 },
    { pinID: 6, kind: "storage", typeID: 2541, latitude: 1.7, longitude: 0.14 },
  ],
  links: [{ endpoint1: 1, endpoint2: 2, level: 0 }, { endpoint1: 2, endpoint2: 3, level: 1 },
    { endpoint1: 3, endpoint2: 4, level: 0 }, { endpoint1: 1, endpoint2: 6, level: 0 },
    { endpoint1: 6, endpoint2: 4, level: 0 }],
  routes: [{ routeID: 10, path: [1, 2, 3], commodityTypeID: 3645, commodityQuantity: 8 }],
}] }, 0).colonies[0]!;
const facts = { baseLinkBandwidth: 50, commodityVolumes: { 3645: .5 } };

test("route waypoints use angular distance and truncate on a selected pin already in the path", () => {
  assert.deepEqual(appendPlanetWaypoint(colony, [1], 4), [1, 2, 3, 4]);
  assert.deepEqual(appendPlanetWaypoint(colony, [1, 2, 3, 4], 2), [1, 2]);
  assert.equal(appendPlanetWaypoint(colony, [1], 5), null);
});

test("the busiest segment at its own link level limits a route", () => {
  assert.equal(planetProduct(colony, colony.pins[0]!, recipes)?.available, 92);
  const result = quotePlanetRoute(colony, recipes, facts, [1, 2, 3, 4], 3645);
  assert.deepEqual(result, { error: "", max: 42, freeBandwidth: 42, perUnit: 1, cycle: 1800 });
  assert.match(quotePlanetRoute(colony, recipes, facts, [1, 3], 3645).error, /link .* missing/);
});

test("pending route removals free capacity and pending creations reserve it before Submit", () => {
  const empty = validateRouteRemovals(colony, colony.routes);
  assert.equal(quotePlanetRoute(empty, recipes, facts, [1, 2, 3, 4], 3645).max, 50);
  const newRoute = { path: [1, 2, 3, 4], typeID: 3645, quantity: 30 };
  assert.throws(() => validateNewRoutes(empty, recipes, facts, [newRoute, newRoute]), /quantity exceeds/);
  assert.throws(() => validateRouteRemovals(colony, [{ ...colony.routes[0]!, commodityQuantity: 9 }]), /route changed/);
});
