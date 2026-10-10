// A colony's network changed by the page itself, on the planet's own object.

import test from "node:test";
import assert from "node:assert/strict";

import { restartExtractorProgram, rerouteExtractorRoutes } from "./planetWrites.ts";

const PLANET = 40176368;
const [ECU, STORE, FACTORY] = [1054656331535, 1054656331531, 1054656331540];

/** An asker that says what it was asked, with everything it was handed. */
function harness() {
  const asked: unknown[][] = [];
  const act = async (...call: unknown[]) => { asked.push(call); return null; };
  return { asked, act };
}

test("an extractor's programme is installed again by one change on the planet's own object", async () => {
  const { asked, act } = harness();

  await restartExtractorProgram(act, PLANET, ECU, 2267, 0.0101);

  // commandStream.py 226: (COMMAND_INSTALLPROGRAM, (pinID, typeID, headRadius)); the planet is what the object is for.
  assert.deepEqual(asked, [["planetMgr", "UserUpdateNetwork", [[[13, [ECU, 2267, 0.0101]]]], null, PLANET]]);
});

test("an extractor's routes are removed and made anew in ONE change: the removals first, each new route with a temporary ID of the client's kind", async () => {
  const { asked, act } = harness();

  await rerouteExtractorRoutes(act, PLANET, [1620230403, 1620204024], [
    { path: [ECU, STORE], typeID: 2267, quantity: 3000 },
    { path: [ECU, STORE, FACTORY], typeID: 2267, quantity: 414.5 },
  ]);

  // (7, (routeID,)) and (6, (routeID, path, typeID, quantity)); a new route's ID is (2, n), counted from one
  // (clientColony.GetTemporaryRouteID).
  assert.deepEqual(asked, [["planetMgr", "UserUpdateNetwork", [[
    [7, [1620230403]], [7, [1620204024]],
    [6, [[2, 1], [ECU, STORE], 2267, 3000]],
    [6, [[2, 2], [ECU, STORE, FACTORY], 2267, 414.5]],
  ]], null, PLANET]]);
});

test("routes only removed, and routes only made, are each one change", async () => {
  const removed = harness();
  await rerouteExtractorRoutes(removed.act, PLANET, [5], []);
  assert.deepEqual(removed.asked, [["planetMgr", "UserUpdateNetwork", [[[7, [5]]]], null, PLANET]]);

  const made = harness();
  await rerouteExtractorRoutes(made.act, PLANET, [], [{ path: [ECU, STORE], typeID: 2267, quantity: 1 }]);
  assert.deepEqual(made.asked, [["planetMgr", "UserUpdateNetwork", [[[6, [[2, 1], [ECU, STORE], 2267, 1]]]], null, PLANET]]);
});

test("with nothing to remove and nothing to make, nothing is asked: the client submits no empty change", async () => {
  const { asked, act } = harness();

  await rerouteExtractorRoutes(act, PLANET, [], []);

  assert.deepEqual(asked, []);
});

test("what is no planet is refused before anything is asked, in the route's words", async () => {
  for (const planetID of [0, -1, 1.5, Number.NaN]) {
    const { asked, act } = harness();
    await assert.rejects(restartExtractorProgram(act, planetID, ECU, 2267, 0.0101), /A positive planetID is required\./, String(planetID));
    await assert.rejects(rerouteExtractorRoutes(act, planetID, [5], []), /A positive planetID is required\./, String(planetID));
    assert.deepEqual(asked, []);
  }
});

test("the call's refusal is the caller's, as it came", async () => {
  const act = async () => { throw new Error("Cannot install a program with a completely bonkers radius"); };

  await assert.rejects(restartExtractorProgram(act, PLANET, ECU, 2267, 5), /completely bonkers radius/);
});

test("the caller's own lists are not what is sent: a path changed afterwards changes nothing sent", async () => {
  const { asked, act } = harness();
  const path = [ECU, STORE];

  await rerouteExtractorRoutes(act, PLANET, [], [{ path, typeID: 2267, quantity: 1 }]);
  path.push(FACTORY);

  assert.deepEqual((asked[0]![2] as unknown[][][][])[0]![0]![1]![1], [ECU, STORE]);
});
