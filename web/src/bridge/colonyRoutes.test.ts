// An extractor's routes against its program's maximum cycle, and the retail
// re-size that settles them.
//
// The case these exist for: a program restarted through the companion yields
// a bigger maximum, the emulator never grows routes to fit, and the game marks
// the colony as needing attention while every factory on it is running.

import test from "node:test";
import assert from "node:assert/strict";

import { extractorReroute, extractorShortfall, factoryInputTypeIDs, isRoutedInto, routedFrom } from "./colonyRoutes.ts";
import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";

function pin(overrides: Partial<ColonyPin> & Pick<ColonyPin, "pinID" | "kind">): ColonyPin {
  return {
    typeID: 0,
    typeName: "",
    contents: [],
    usedM3: null,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: null,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

const PLASMA = 2308;

function ecu(pinID: number, maxOutputPerCycle: number | null): ColonyPin {
  return pin({
    pinID,
    kind: "extractor-control",
    typeName: "Storm Extractor Control Unit",
    program: {
      resourceTypeID: PLASMA,
      resourceTypeName: "Suspended Plasma",
      cycleTimeSeconds: 7200,
      quantityPerCycle: 2473,
      installedAtMs: 1,
      expiresAtMs: 2,
      headCount: 10,
      maxOutputPerCycle,
    },
  });
}

function route(routeID: number, path: number[], quantity: number, typeID = PLASMA): ColonyRoute {
  return { routeID, path, commodityTypeID: typeID, commodityTypeName: null, commodityQuantity: quantity };
}

function colony(pins: ColonyPin[], routes: ColonyRoute[]): Colony {
  return {
    planetID: 40000002,
    planetName: "Tanoo I",
    solarSystemID: 30000001,
    solarSystemName: "Tanoo",
    planetTypeID: 2017,
    planetTypeName: null,
    commandCenterLevel: 4,
    lastSimulatedAtMs: null,
    pins,
    linkCount: 0,
    links: [],
    routes,
  };
}

const STORAGE = pin({ pinID: 42, kind: "storage" });
const LAUNCHPAD = pin({ pinID: 43, kind: "launchpad" });
const FACTORY = pin({ pinID: 44, kind: "factory", schematicID: 122 });

test("routes sized for the old program leave the extractor short", () => {
  // The live shape: max 35,608 a cycle, one route to storage carrying 35,288.
  const c = colony([ecu(40, 35608), STORAGE], [route(1, [40, 42], 35288)]);
  assert.equal(routedFrom(c, 40, PLASMA), 35288);
  assert.deepEqual(extractorShortfall(c, c.pins[0]!), { typeID: PLASMA, maxOutput: 35608, routed: 35288 });
});

test("a settled extractor, or one whose maximum is unknown, raises nothing", () => {
  assert.equal(extractorShortfall(colony([ecu(40, 35608), STORAGE], [route(1, [40, 42], 35608)]), ecu(40, 35608)), null);
  const unknown = colony([ecu(40, null), STORAGE], [route(1, [40, 42], 10)]);
  assert.equal(extractorShortfall(unknown, unknown.pins[0]!), null);
  assert.equal(extractorReroute(unknown, 40), null);
});

test("the reroute removes the storage route and recreates it at the full maximum", () => {
  const c = colony([ecu(40, 35608), STORAGE], [route(1, [40, 42], 35288)]);
  assert.deepEqual(extractorReroute(c, 40), {
    planetID: 40000002,
    pinID: 40,
    removeRouteIDs: [1],
    create: [{ path: [40, 42], typeID: PLASMA, quantity: 35608 }],
  });
});

test("factory routes keep their amounts; storage shares what is left in proportion", () => {
  // 1,000 go straight to a factory; 9,000 are left for two stores that carried
  // 3,000 and 1,000 before - so 6,750 and 2,250, as the retail client splits it.
  const c = colony(
    [ecu(40, 10000), STORAGE, LAUNCHPAD, FACTORY],
    [route(3, [40, 44], 1000), route(1, [40, 42], 3000), route(2, [40, 43], 1000)],
  );
  const plan = extractorReroute(c, 40);
  assert.deepEqual(plan?.removeRouteIDs, [1, 2]);
  assert.deepEqual(plan?.create.map((r) => [r.path, r.quantity]), [[[40, 42], 6750], [[40, 43], 2250]]);
  const total = plan!.create.reduce((sum, r) => sum + r.quantity, 0);
  assert.equal(total + 1000, 10000);
});

test("rounding never loses or invents a unit", () => {
  const c = colony(
    [ecu(40, 10001), STORAGE, LAUNCHPAD, pin({ pinID: 45, kind: "storage" })],
    [route(1, [40, 42], 1), route(2, [40, 43], 1), route(4, [40, 45], 1)],
  );
  const plan = extractorReroute(c, 40)!;
  assert.equal(plan.create.reduce((sum, r) => sum + r.quantity, 0), 10001);
});

test("an extractor that only feeds factories is left as the player built it", () => {
  const c = colony([ecu(40, 10000), FACTORY], [route(3, [40, 44], 3000)]);
  assert.notEqual(extractorShortfall(c, c.pins[0]!), null);
  assert.equal(extractorReroute(c, 40), null);
});

test("a route of another commodity is neither counted nor touched", () => {
  const c = colony([ecu(40, 100), STORAGE], [route(1, [40, 42], 100), route(2, [40, 42], 5, 9999)]);
  assert.equal(extractorShortfall(c, c.pins[0]!), null);
  assert.equal(isRoutedInto(c, 42, 9999), true);
  assert.equal(isRoutedInto(c, 42, 1), false);
});

test("a factory's inputs are the types routed into it, wherever the route starts", () => {
  const OXYGEN = 3683;
  const built = colony([STORAGE, LAUNCHPAD, FACTORY], [
    route(1, [43, 44], 3000), // imported onto the launchpad, fed to the factory
    route(2, [43, 42, 44], 40, OXYGEN), // through storage on the way
    route(3, [44, 43], 20, 9828), // the factory's output, back onto the launchpad
    route(4, [43, 42], 500, 2393), // stocked, never fed
  ]);
  assert.deepEqual(factoryInputTypeIDs(built), [PLASMA, OXYGEN]);
  assert.deepEqual(factoryInputTypeIDs(colony([LAUNCHPAD, FACTORY], [])), []);
});
