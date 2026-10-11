// An extractor restarted as the client restarts one: the planet asked what the programme will yield, then ONE
// change of the colony, the extractor's routes taken off, the programme installed and the routes made anew.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeProgramResult, maxOutputOf, planExtractorRestart, restartExtractor } from "./extractorRestart.ts";
import { decodeColonyReport } from "./planets.ts";
import type { JsonValue } from "./wire.ts";

const PLANET = 40176368;
const [ECU, PAD, STORE, DEPOT, FACTORY, PLANT, OTHER, UNIT] = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008];
const [METALS, WATER] = [2267, 2268];
const HEADS = [[0, 1.225, 1.225], [5, 1, 1.45]];

/** A colony as the page reads one, of the unit, the things a route can end at, and these routes. */
function colonyOf(routes: JsonValue[], unit: Record<string, JsonValue> = {}) {
  const pin = (pinID: number, kind: string) => ({ pinID, typeID: 1, kind, contents: [] });
  return decodeColonyReport({ serverNowMs: 0, coloniesReadable: true, colonies: [{
    planetID: PLANET,
    pins: [
      { pinID: ECU, typeID: 2848, kind: "extractor-control", contents: [], program: { resourceTypeID: METALS, cycleTimeSeconds: 900, quantityPerCycle: 471, headCount: 2, headRadius: 0.01, heads: HEADS, noiseFactor: 0.8, ...unit } },
      pin(PAD, "launchpad"), pin(STORE, "storage"), pin(DEPOT, "command"), pin(FACTORY, "factory"), pin(PLANT, "factory"), pin(OTHER, "other"), pin(UNIT, "extractor-control"),
    ],
    links: [],
    routes,
  }] } as JsonValue, 0).colonies[0]!;
}
const route = (routeID: number, to: number, quantity: number, typeID = METALS, via: number[] = []): JsonValue =>
  ({ routeID, path: [ECU, ...via, to], commodityTypeID: typeID, commodityQuantity: quantity });
const removed = (routeID: number) => [7, [routeID]];
const installed = [13, [ECU, METALS, 0.01]];
const made = (n: number, to: number, quantity: number, via: number[] = []) => [6, [[2, n], [ECU, ...via, to], METALS, quantity]];
const plan = (routes: JsonValue[], toRoute: number) => planExtractorRestart(colonyOf(routes), ECU, METALS, 0.01, toRoute);

// --- what the planet answers -------------------------------------------------

test("the most a cycle can yield is the client's sum: the whole of (1 + noise) times the yield, for the cycle's length against 900 s", () => {
  // EcuPin.GetMaxOutput (297): int(scalar * baseOutput) * cycleTime / const.SEC / 900.0. Recorded: (1897, 9000000000,
  // 8) was followed by routes of 3000 and 414.
  assert.equal(maxOutputOf(0.8, 1897, 9_000_000_000), 3414);
  assert.equal(maxOutputOf(0.8, 477, 9_000_000_000), 858);
  // Half an hour is two of them, and the whole is taken before the cycle's length is.
  assert.equal(maxOutputOf(0.8, 1204, 18_000_000_000), 4334);
  assert.equal(maxOutputOf(0, 10, 4_500_000_000), 5);
  // One a cycle is the whole of 1.8, which is 1: two in half an hour (not the whole of 3.6), and a half in 450 s
  // (not the whole of 0.9). The client's answer is a float.
  assert.equal(maxOutputOf(0.8, 1, 18_000_000_000), 2);
  assert.equal(maxOutputOf(0.8, 1, 4_500_000_000), 0.5);
});

test("the planet's answer is what a cycle yields, a cycle's length and the count of cycles; the length a long or a plain number", () => {
  assert.deepEqual(decodeProgramResult([1897, 9000000000, 8]), { quantity: 1897, cycleTicks: 9000000000, cycles: 8 });
  assert.deepEqual(decodeProgramResult([1897, { type: "long", value: "9000000000" }, 8]), { quantity: 1897, cycleTicks: 9000000000, cycles: 8 });
  assert.deepEqual(decodeProgramResult({ type: "tuple", items: [0, 0, 0] }), { quantity: 0, cycleTicks: 0, cycles: 0 });
  // (Through the web gateway a long may come as its digits alone.)
  assert.deepEqual(decodeProgramResult([1897, "9000000000", 8]), { quantity: 1897, cycleTicks: 9000000000, cycles: 8 });
  for (const answer of [null, "no", [], [1897, 9000000000], [1897, 9000000000, 8, 1], [1897, "nine", 8], [1897, 0.5, 8], ["1897", 9000000000, 8], [1897, 9000000000, null], [-1, 9000000000, 8], [1897, -9, 8], [1897, 9000000000, -1]] as JsonValue[]) {
    assert.equal(decodeProgramResult(answer), null, JSON.stringify(answer));
  }
});

// --- the one change -----------------------------------------------------------

test("with no routes the change is the programme alone", () => {
  assert.deepEqual(plan([], 3414), [installed]);
});

test("the recorded restart: two routes to factories taken off, the programme, and the two made anew, the second with what is left", () => {
  // [(7, ..), (7, ..), (13, ..), (6, ((2, 1), .., 2267, 3000)), (6, ((2, 2), .., 2267, 414.0))].
  assert.deepEqual(plan([route(11, FACTORY, 3000), route(12, PLANT, 500)], 3414), [removed(11), removed(12), installed, made(1, FACTORY, 3000), made(2, PLANT, 414)]);
});

test("factories are routed first, each what it had; what is left is shared among the stores as they shared before", () => {
  // 1000 to route: 200 to the factory; of the 800 left, three parts in four to the store that had 300 of 400.
  assert.deepEqual(plan([route(1, STORE, 300), route(2, FACTORY, 200), route(3, PAD, 100)], 1000),
    [removed(1), removed(2), removed(3), installed, made(1, FACTORY, 200), made(2, STORE, 600), made(3, PAD, 200)]);
});

test("a command centre is a store, and the rounding is carried from one store to the next", () => {
  // A third of 100 each: 33, then 34 with the two thirds carried, then 33.
  assert.deepEqual(plan([route(1, STORE, 1), route(2, PAD, 1), route(3, DEPOT, 1)], 100),
    [removed(1), removed(2), removed(3), installed, made(1, STORE, 33), made(2, PAD, 34), made(3, DEPOT, 33)]);
});

test("a half is rounded away from nought, above it and below, as Python rounds", () => {
  // 2.5 each: the first is 3, which carries half a unit too many; that half is rounded to a whole one and taken
  // back, leaving 2; the second is 3. JavaScript's own rounding takes nothing back, and makes them 3 and 2.
  assert.deepEqual(plan([route(1, STORE, 1), route(2, PAD, 1)], 5), [removed(1), removed(2), installed, made(1, STORE, 2), made(2, PAD, 3)]);
});

test("a store whose share rounds to nothing gets no route, and the next gets the whole", () => {
  // A thousandth of 100 is no unit: the client's CreateRoute refuses a route of nothing and InstallProgram goes on.
  assert.deepEqual(plan([route(1, STORE, 1), route(2, PAD, 1000)], 100), [removed(1), removed(2), installed, made(1, PAD, 100)]);
});

test("the plan's lists are its own: a path in it is not the colony's", () => {
  const colony = colonyOf([route(1, STORE, 100)]);
  const changes = planExtractorRestart(colony, ECU, METALS, 0.01, 500) as unknown[][][][];
  assert.deepEqual(changes[2]![1]![1], [ECU, STORE]);
  assert.notEqual(changes[2]![1]![1], colony.routes[0]!.path);
});

test("a yield no greater than the factories took leaves the later ones and the stores with no route", () => {
  assert.deepEqual(plan([route(1, FACTORY, 300), route(2, PLANT, 300), route(3, STORE, 50)], 300), [removed(1), removed(2), removed(3), installed, made(1, FACTORY, 300)]);
  assert.deepEqual(plan([route(1, FACTORY, 300), route(2, STORE, 50)], 120), [removed(1), removed(2), installed, made(1, FACTORY, 120)]);
});

test("a route of another commodity is taken off and not made anew", () => {
  assert.deepEqual(plan([route(1, STORE, 100, WATER), route(2, STORE, 100)], 500), [removed(1), removed(2), installed, made(1, STORE, 500)]);
});

test("a route that ends at neither a store nor a factory is left as it is", () => {
  assert.deepEqual(plan([route(1, OTHER, 100), route(2, STORE, 100)], 500), [removed(2), installed, made(1, STORE, 500)]);
  assert.deepEqual(plan([route(1, OTHER, 100), route(2, 99999, 100)], 500), [installed]);
  // Another extractor control unit is neither.
  assert.deepEqual(plan([route(1, UNIT, 100), route(2, STORE, 100)], 500), [removed(2), installed, made(1, STORE, 500)]);
});

test("only the unit's own routes are touched, in the order of their IDs, and a route's path is kept whole", () => {
  const others: JsonValue = { routeID: 5, path: [STORE, FACTORY], commodityTypeID: METALS, commodityQuantity: 40 };
  assert.deepEqual(plan([route(9, STORE, 100, METALS, [PAD]), others, route(4, PAD, 100)], 300),
    [removed(4), removed(9), installed, made(1, PAD, 150), made(2, STORE, 150, [PAD])]);
});

test("two routes to one store that had nothing between them are not shared: nothing is made for them", () => {
  assert.deepEqual(plan([route(1, STORE, 0), route(2, PAD, 0)], 500), [removed(1), removed(2), installed]);
});

// --- the restart ---------------------------------------------------------------

/** Askers that say what was asked, in order; the planet answers the yield with `answer`. */
function harness(answer: JsonValue | Error = [477, 9000000000, 4], refusal: Error | null = null) {
  const did: unknown[][] = [];
  const ask = async (...call: unknown[]) => { did.push(["read", ...call]); if (answer instanceof Error) throw answer; return answer; };
  const act = async (...call: unknown[]) => { did.push(["write", ...call]); if (refusal) throw refusal; return null; };
  return { did, ask, act };
}

test("the planet is asked what the programme will yield, with the unit's own heads, and then the colony is changed once", async () => {
  const { did, ask, act } = harness();

  await restartExtractor(ask, act, colonyOf([route(20, PAD, 471)]), ECU, METALS, 0.01);

  assert.deepEqual(did, [
    // clientPlanet.InstallProgram: GetProgramResultInfo(pinID, typeID, pin.heads, headRadius), on the planet's object.
    ["read", "planetMgr", "GetProgramResultInfo", [ECU, METALS, HEADS, 0.01], null, PLANET],
    // 477 a cycle is 858 at the most: the route is made anew for that, in the same change as the programme.
    ["write", "planetMgr", "UserUpdateNetwork", [[removed(20), installed, made(1, PAD, 858)]], null, PLANET],
  ]);
});

test("heads that are not known, or none, or a noise that is not known, stop it before anything is asked", async () => {
  for (const unit of [{ heads: null }, { heads: [] }, { noiseFactor: null }] as Record<string, JsonValue>[]) {
    const { did, ask, act } = harness();
    await assert.rejects(restartExtractor(ask, act, colonyOf([route(20, PAD, 471)], unit), ECU, METALS, 0.01), /heads|noise/, JSON.stringify(unit));
    assert.deepEqual(did, []);
  }
});

test("a pin that is not there, or is no extractor control unit, stops it before anything is asked", async () => {
  for (const pinID of [424242, PAD]) {
    const { did, ask, act } = harness();
    await assert.rejects(restartExtractor(ask, act, colonyOf([]), pinID, METALS, 0.01), /no extractor/);
    assert.deepEqual(did, []);
  }
});

test("an answer that is no yield changes nothing", async () => {
  const { did, ask, act } = harness("no");

  await assert.rejects(restartExtractor(ask, act, colonyOf([route(20, PAD, 471)]), ECU, METALS, 0.01), /yield/);
  assert.equal(did.length, 1);
});

test("the planet's refusal changes nothing, and the change's refusal is the caller's", async () => {
  const refusing = harness(new Error("CannotManagePlanetWithoutCommandCenter"));
  await assert.rejects(restartExtractor(refusing.ask, refusing.act, colonyOf([]), ECU, METALS, 0.01), /CannotManagePlanetWithoutCommandCenter/);
  assert.equal(refusing.did.length, 1);

  const refused = harness([477, 9000000000, 4], new Error("CantInstallProgramNeedsCooldown"));
  await assert.rejects(restartExtractor(refused.ask, refused.act, colonyOf([]), ECU, METALS, 0.01), /CantInstallProgramNeedsCooldown/);
  assert.equal(refused.did.length, 2);
});

test("the heads sent are a copy: the colony's own are not handed out", async () => {
  const { did, ask, act } = harness();
  const colony = colonyOf([]);

  await restartExtractor(ask, act, colony, ECU, METALS, 0.01);

  const sent = (did[0]![3] as unknown[])[2];
  assert.notEqual(sent, colony.pins.find((pin) => pin.pinID === ECU)!.program!.heads);
  assert.deepEqual(sent, HEADS);
});
