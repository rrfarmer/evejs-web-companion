import assert from "node:assert/strict";
import test from "node:test";
import {
  constructionError, draftInstallation, installationRemoval, placementError, planPlanetLayout,
  type InstallationType, type PlanetLayoutEdit,
} from "./planetConstruction.ts";
import { colonyLinkBudget, linkEndpoints } from "./planetLinks.ts";
import { commandCenterLevelName } from "./commandCenterUpgrade.ts";
import { decodeColonyReport } from "./planets.ts";
import { routeEditCommands } from "./planetWrites.ts";

const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077, radius: 2060000, commandCenterLevel: 2,
  pins: [
    { pinID: 1, typeID: 2524, kind: "command", latitude: 1.1, longitude: 2 },
    { pinID: 2, typeID: 2473, kind: "factory", latitude: 1.2, longitude: 2 },
    { pinID: 3, typeID: 2541, kind: "storage", latitude: 1.2, longitude: 2.1 },
  ],
  links: [{ endpoint1: 2, endpoint2: 3, level: 1 }],
  routes: [{ routeID: 9, path: [2, 3], commodityTypeID: 3645, commodityQuantity: 20 }],
}] }, 0).colonies[0]!;
const storage: InstallationType = {
  typeID: 2541, typeName: "Barren Storage Facility", kind: "storage", groupID: 1029,
  price: 250000, cpu: 500, power: 700, area: 0, capacity: 12000, missingSkills: [],
};
const facts = {
  2280: { attributes: [[49, 15], [15, 10], [1634, 0.2], [1633, 0.1]] as const },
  2473: { attributes: [[49, 200], [15, 800]] as const },
  2541: { attributes: [[49, 500], [15, 700]] as const },
};
const quote = { wallet: 500000, options: [storage] };
const point = { latitude: 1.3, longitude: 2.3 };
const build: PlanetLayoutEdit = { kind: "build", pin: draftInstallation(-1, storage, point), price: storage.price };

test("installation spacing applies to the draft globe and construction uses the accumulated ISK cost", () => {
  assert.match(placementError(colony, { latitude: 1.206, longitude: 2 }), /too close/);
  assert.equal(placementError(colony, { latitude: 1.214, longitude: 2 }), "");
  assert.match(placementError(colony, { latitude: 1.214, longitude: -1 }), /surface/);
  assert.match(constructionError(colony, storage, facts, 250000, 499999), /insufficient ISK/);
  assert.match(constructionError(colony, { ...storage, missingSkills: ["Remote Sensing 1"] }, facts, 0, 500000), /Remote Sensing 1/);
  assert.match(constructionError(colony, { ...storage, power: 13000 }, facts, 0, 500000), /insufficient power/);
  assert.throws(() => planPlanetLayout(colony, [
    build, { ...build, pin: draftInstallation(-2, storage, point) },
  ], facts, quote), /too close/);
  assert.throws(() => planPlanetLayout(colony, [build], facts, { ...quote, options: [{ ...storage, price: 250001 }] }), /quote changed/);
});

test("one native stream creates a temporary installation before a link or route refers to it", () => {
  const planned = planPlanetLayout(colony, [build, { kind: "link", link: {
    ...linkEndpoints(-1, 2), previousLevel: null, level: 0, removedRoutes: [],
  } }], facts, quote);
  assert.deepEqual(planned.commands, [[1, [[1, 1], 2541, 1.3, 2.3]], [3, [[1, 1], 2, 0]]]);
  assert.deepEqual(routeEditCommands([], [{ path: [2, -1], typeID: 3645, quantity: 5 }]), [[6, [[2, 1], [2, [1, 1]], 3645, 5]]]);
  assert.equal(planned.colony.pins.at(-1)?.capacityM3, 12000);
});

test("decommission removes the reviewed links and affected routes and catches changed routes", () => {
  const pin = colony.pins.find(pin => pin.pinID === 3)!;
  const edit: PlanetLayoutEdit = { kind: "remove", removal: installationRemoval(colony, pin) };
  const planned = planPlanetLayout(colony, [edit], {});
  assert.deepEqual(planned.commands, [[4, [2, 3]], [2, [3]]]);
  assert.deepEqual(planned.colony.pins.map(pin => pin.pinID).sort((a, b) => a - b), [1, 2]);
  assert.equal(planned.colony.links.length, 0);
  assert.equal(planned.colony.routes.length, 0);
  const changed = { ...colony, routes: [{ ...colony.routes[0]!, commodityQuantity: 100 }] };
  assert.throws(() => planPlanetLayout(changed, [edit], {}), /route changed/);
  const changedLink = { ...colony, links: [{ ...colony.links[0]!, level: 2 }] };
  assert.throws(() => planPlanetLayout(changedLink, [edit], {}), /links or routes changed/);
});

test("one command centre upgrade changes the projected power and CPU and charges from the saved level", () => {
  assert.equal(commandCenterLevelName(5), "VI");
  const upgrade: PlanetLayoutEdit = { kind: "upgrade", upgrade: { pinID: 1, previousLevel: 2, level: 4 } };
  const quote = { skillLevel: 4, wallet: 2700000 };
  const plan = planPlanetLayout(colony, [upgrade], facts, undefined, quote);
  assert.deepEqual(plan.commands, [[9, [1, 4]]]);
  assert.equal(plan.colony.commandCenterLevel, 4);
  assert.equal(colonyLinkBudget(plan.colony, facts)?.cpuSupply, 21315);
  assert.equal(colonyLinkBudget(plan.colony, facts)?.powerSupply, 17000);
  assert.throws(() => planPlanetLayout(colony, [upgrade], facts, undefined, { ...quote, wallet: 2699999 }), /insufficient ISK/);
  assert.throws(() => planPlanetLayout(colony, [upgrade], facts, undefined, { ...quote, skillLevel: 3 }), /does not allow/);
  assert.throws(() => planPlanetLayout({ ...colony, commandCenterLevel: 3 }, [upgrade], facts, undefined, quote), /command centre changed/);
});

test("the upgraded budget applies to later installations and Submit includes the combined cost", () => {
  const upgrade: PlanetLayoutEdit = { kind: "upgrade", upgrade: { pinID: 1, previousLevel: 2, level: 4 } };
  const heavy = { ...storage, power: 13000 };
  const buildAfterUpgrade: PlanetLayoutEdit = { ...build, pin: draftInstallation(-1, heavy, point) };
  const quote = { wallet: 2950000, options: [heavy] };
  assert.throws(() => planPlanetLayout(colony, [buildAfterUpgrade], facts, quote), /insufficient power/);
  const submitted = planPlanetLayout(colony, [upgrade, buildAfterUpgrade], facts, quote, { skillLevel: 4, wallet: quote.wallet });
  assert.deepEqual(submitted.commands, [[9, [1, 4]], [1, [[1, 1], 2541, 1.3, 2.3]]]);
  assert.throws(() => planPlanetLayout(colony, [upgrade, buildAfterUpgrade], facts, { ...quote, wallet: 2949999 },
    { skillLevel: 4, wallet: 2949999 }), /insufficient ISK/);
});
