import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ESS_FILTERS, ESS_REGION, essBeacon, essDetails, essSettings, essSystems, filterEssSystems, type AgencyEssFilters } from "./agencyEss.ts";
import { DISTANCE } from "./agencyAgents.ts";

const dict = (fields: Record<string, unknown>) => ({ type: "dict", entries: Object.entries(fields) });
const id = 30004759;
const adjacent = 30004758;
const far = 30003626;
const openBank = { solarSystemID: id, output: 1.25, main: 28_450_000, reserve: 76_230_000, unlocked: true };
const otherBank = { solarSystemID: adjacent, output: 1.5, main: 0, reserve: 0, unlocked: false };

test("the ESS Agency decodes numeric dictionary keys, wire amounts, and closed and open banks", () => {
  const wire = { type: "dict", entries: [
    [id, dict({ currentOutput: { type: "real", value: 1.25 }, mainValue: { type: "long", value: "28450000" }, reserveValue: 76_230_000, vaultOpen: true })],
    [adjacent, dict({ currentOutput: 1.5, mainValue: 0, reserveValue: 0, vaultOpen: 0 })],
    [far, dict({ currentOutput: 1.5, vaultOpen: false })],
  ] };
  assert.deepEqual(essSystems(wire), [openBank, otherBank]);
  assert.deepEqual(essSystems(dict({})), []);
  assert.throws(() => essSystems(null));
});

test("selected-system ESS details, settings and the local entrance retain wire units and identities", () => {
  assert.deepEqual(essDetails(dict({ autopaymentWindowState: 1, activeLinks: 0, totalPulses: 15, reserveTimeWindowState: 2, reserveTimeChosen: 900 })),
    { autopayment: 1, links: 0, pulses: 15, payout: 2, chosenSeconds: 900 });
  assert.equal(essDetails(dict({ autopaymentWindowState: 5 })), null);
  assert.deepEqual(essSettings(dict({
    minOutput: 1, maxOutput: 2, earlyPayoutThresholdFactor: 2 / 3, latePayoutThresholdFactor: 1 / 3, reserveBankTimeAccessFactor: 3,
    bountiesCut: 0.4, autopaymentIntervalSeconds: 9900, bufferTimeSeconds: 360, mainBankPayRatio: 0.975,
    reserveBankMaxPayout: 15_000_000, timeIntervalSeconds: 86400,
  })), {
    outputFloor: 100, outputCeiling: 200, earlyPayout: 2 / 3, latePayout: 1 / 3, reserveAccess: 3,
    bountiesCut: 0.4, autopaySeconds: 9900, bufferSeconds: 360, mainPayRatio: 0.975, reserveMax: 15_000_000, outputIntervalSeconds: 86400,
  });
  assert.equal(essBeacon(dict({ essID: 8440000030004759, beaconID: { type: "long", value: "8450000030004759" } })), 8450000030004759);
  assert.equal(essBeacon(dict({ essID: 8440000030004759 })), null);
});

test("ESS filters apply inclusive bounds, route distance and region or constellation before the cap", () => {
  const locations = new Map([
    [id, { regionID: 10000060, constellationID: 20000623, security: -0.2 }],
    [adjacent, { regionID: 10000060, constellationID: 20000624, security: -0.3 }],
    [far, { regionID: 10000046, constellationID: 20000530, security: -0.4 }],
  ]);
  const systems = [openBank, otherBank, { ...otherBank, solarSystemID: far }];
  const routes = new Map([[adjacent, 2], [far, 11]]);
  const match = (filter: Partial<AgencyEssFilters>, here = id) =>
    filterEssSystems(systems, { ...DEFAULT_ESS_FILTERS, ...filter }, here, routes, locations).map((row) => row.solarSystemID);

  assert.deepEqual(match({ distance: DISTANCE.currentSystem }), [id]);
  assert.deepEqual(match({ distance: DISTANCE.two }), [id, adjacent]);
  assert.deepEqual(match({ distance: ESS_REGION, regionID: 10000060 }), [id, adjacent]);
  assert.deepEqual(match({ distance: ESS_REGION, regionID: 10000060, constellationID: 20000624 }), [adjacent]);
  assert.deepEqual(match({ outputEnabled: true, minOutput: 125, maxOutput: 125 }), [id]);
  assert.deepEqual(match({ unlocked: true, mainEnabled: true, mainMinimum: 28_450_000, reserveEnabled: true, reserveMinimum: 76_230_000 }), [id]);
  assert.deepEqual(match({ reserveEnabled: true, reserveMinimum: 76_230_001 }), []);
  assert.deepEqual(match({}, 31000001), []);
  assert.deepEqual(match({}, 32000001), []);
  const before = Array.from({ length: 40 }, (_, i) => ({ ...otherBank, solarSystemID: adjacent + i }));
  assert.equal(filterEssSystems(before, DEFAULT_ESS_FILTERS, id, routes, locations).length, 32);
  assert.equal(filterEssSystems([...before, openBank], { ...DEFAULT_ESS_FILTERS, unlocked: true }, id, routes, locations)[0]?.solarSystemID, id);
});
