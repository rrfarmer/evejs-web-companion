import assert from "node:assert/strict";
import test from "node:test";
import { colonyLinkBudget, linkBudgetError, linkEndpoints, linkUsage, planPlanetLinkEdits } from "./planetLinks.ts";
import { decodeColonyReport } from "./planets.ts";

const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077, radius: 1000000, commandCenterLevel: 1,
  pins: [
    { pinID: 1, kind: "command", typeID: 2524, latitude: Math.PI / 2, longitude: 0 },
    { pinID: 2, kind: "storage", typeID: 2541, latitude: Math.PI / 2, longitude: 0.101 },
    { pinID: 3, kind: "factory", typeID: 2473, latitude: Math.PI / 2, longitude: 0.201 },
    { pinID: 4, kind: "storage", typeID: 2541, latitude: Math.PI / 2, longitude: 0.301 },
  ],
  links: [{ endpoint1: 2, endpoint2: 3, level: 0 }],
  routes: [{ routeID: 17, path: [3, 2], commodityTypeID: 3645, commodityQuantity: 20 }],
}] }, 0).colonies[0]!;
const facts = {
  2280: { attributes: [[49, 15], [15, 10], [1634, 0.2], [1633, 0.1], [1635, 1], [1636, 2], [1631, 1250]] as const },
  2473: { attributes: [[49, 200], [15, 800]] as const },
  2541: { attributes: [[49, 500], [15, 700]] as const },
};

test("a level change doubles bandwidth and applies separate native CPU and power curves", () => {
  const [a, b] = colony.pins.filter(pin => pin.pinID === 1 || pin.pinID === 2);
  const costs = linkUsage(colony.radius, a!, b!, 1, facts)!;
  assert.ok(Math.abs(costs.km - 101) < 0.00001);
  assert.deepEqual({ cpu: costs.cpu, power: costs.power, bandwidth: costs.bandwidth }, { cpu: 56, power: 51, bandwidth: 2500 });
  assert.deepEqual(colonyLinkBudget({ ...colony, links: [] }, facts), {
    cpu: 1200, power: 2200, cpuSupply: 7057, powerSupply: 9000,
  });
  const proposed = { ...linkEndpoints(4, 2), level: 0 };
  assert.match(linkBudgetError({ ...colony, radius: 1e9 }, proposed, facts), /insufficient CPU/);
  const littlePower = { ...facts, 2473: { attributes: [[49, 200], [15, 7589]] as const } };
  assert.match(linkBudgetError(colony, proposed, littlePower), /insufficient power/);
});

test("link edits serialize for the planet's command stream and remove only routes crossing that pair", () => {
  const { commands, colony: draft } = planPlanetLinkEdits(colony, [
    { ...linkEndpoints(4, 3), previousLevel: null, level: 0, removedRoutes: [] },
    { ...linkEndpoints(3, 4), previousLevel: 0, level: 1, removedRoutes: [] },
    { ...linkEndpoints(3, 2), previousLevel: 0, level: null, removedRoutes: colony.routes },
  ], facts);
  assert.deepEqual(commands, [[3, [3, 4, 0]], [5, [3, 4, 1]], [4, [2, 3]]]);
  assert.deepEqual(draft.links, [{ endpoint1: 3, endpoint2: 4, level: 1 }]);
  assert.deepEqual(draft.routes, []);
  assert.equal(colony.routes.length, 1);
});

test("a stale edit cannot overwrite another upgrade or implicitly remove an unreviewed route", () => {
  const endpoints = linkEndpoints(2, 3);
  assert.throws(() => planPlanetLinkEdits(colony, [
    { ...endpoints, previousLevel: 1, level: 2, removedRoutes: [] },
  ], facts), /link changed/);
  assert.throws(() => planPlanetLinkEdits(colony, [
    { ...endpoints, previousLevel: 0, level: null, removedRoutes: [] },
  ], facts), /routes through this link changed/);
  assert.throws(() => planPlanetLinkEdits(colony, [
    { ...endpoints, previousLevel: 0, level: 11, removedRoutes: [] },
  ], facts), /upgrade level is unavailable/);
});
