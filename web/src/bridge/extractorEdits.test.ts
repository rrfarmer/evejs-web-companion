import assert from "node:assert/strict";
import test from "node:test";
import { extractorBasis, planExtractorEdits, type ExtractorEdit } from "./extractorEdits.ts";
import { decodeColonyReport } from "./planets.ts";
import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

const planetID = 40009077, pinID = 29, resourceID = 2267;
const firstHead = [0, 1.2, 2.04];
const secondHead = [1, 1.1, 2.06];
const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID, resources: [{ typeID: resourceID, typeName: "Base Metals", quality: 53 }],
  pins: [{ pinID, typeID: 2848, kind: "extractor-control", active: true, latitude: 1.18, longitude: 2.04,
    extractor: { heads: [firstHead, secondHead], headRadius: .01, areaOfInfluence: .3, noiseFactor: .8 },
    program: { resourceTypeID: resourceID, installedAtMs: 10000, expiresAtMs: 3610000, headRadius: .01 },
  }, { pinID: 42, typeID: 2541, kind: "storage" }],
  routes: [{ routeID: 19, path: [pinID, 42], commodityTypeID: resourceID, commodityQuantity: 100 }],
}] }, 0).colonies[0]!;

const draft: ExtractorEdit = {
  pinID, basis: extractorBasis(colony.pins[0]!), stopped: true,
  heads: [[0, 1.3, 2.04], [5, 1.22, 2.04]], radius: .0181, resourceID,
};

test("stop, head changes, reinstall and resized output routes share one ordered command stream", async () => {
  const calls: JsonValue[] = [];
  const ask: Ask = async (service, method, args, kwargs, of) => {
    calls.push([service, method, args, kwargs ?? null, of ?? null]);
    return [676, 36_000_000_000, 68];
  };
  assert.deepEqual(await planExtractorEdits(ask, colony, [draft]), [
    [13, [pinID, null, .01]],
    [11, [pinID, 1]],
    [12, [pinID, 0, 1.3, 2.04]],
    [10, [pinID, 5, 1.22, 2.04]],
    [7, [19]],
    [13, [pinID, resourceID, .0181]],
    [6, [[2, 1], [pinID, 42], resourceID, 4864]],
  ]);
  assert.deepEqual(calls, [["planetMgr", "GetProgramResultInfo", [pinID, resourceID, draft.heads, .0181], null, planetID]]);
});

test("head-only edits can clear every slot of an idle unit without asking for a yield", async () => {
  const idle = { ...colony.pins[0]!, active: false, program: null };
  const current = { ...colony, pins: [idle, ...colony.pins.slice(1)] };
  const unexpected: Ask = async () => { throw new Error("Unexpected forecast read"); };
  assert.deepEqual(await planExtractorEdits(unexpected, current, [{
    pinID, basis: extractorBasis(idle), stopped: false, heads: [], radius: .01,
  }]), [[11, [pinID, 0]], [11, [pinID, 1]]]);
  await assert.rejects(planExtractorEdits(unexpected, current, [draft]), /extractor changed/);
});

test("a permanent stop removes the unit's obsolete output route in the same submit", async () => {
  const unexpected: Ask = async () => { throw new Error("Unexpected forecast read"); };
  assert.deepEqual(await planExtractorEdits(unexpected, colony, [{
    ...draft, resourceID: null, radius: .01, heads: [[0, 1.2, 2.04], [1, 1.1, 2.06]],
  }]), [[7, [19]], [13, [pinID, null, .01]]]);
});
