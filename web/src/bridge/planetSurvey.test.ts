import assert from "node:assert/strict";
import test from "node:test";
import { chartPlanetSurvey, PLANET_SURVEY_SAMPLES, planetSurveyBands, planetResourceQuality } from "./planetSurvey.ts";

function field(coefficients: readonly number[]) {
  const numBands = Math.sqrt(coefficients.length);
  const bytes = new Uint8Array(coefficients.length * 4);
  const view = new DataView(bytes.buffer);
  coefficients.forEach((value, index) => view.setFloat32(4 * index, value, true));
  return { numBands, data: [...bytes], proximity: 4 };
}

test("owned colony surveys derive the band count and gauge from native limits", () => {
  assert.equal(planetSurveyBands(0, 0), 15);
  assert.equal(planetSurveyBands(4, 2), 23);
  assert.equal(planetSurveyBands(5, 5), 30);
  assert.equal(planetResourceQuality(0), 0);
  assert.equal(planetResourceQuality(1.21 * 255 / 4), .5);
  assert.equal(planetResourceQuality(255), 1);
});

test("the survey chart uses little-endian real harmonics and the planet sphere's north and east axes", () => {
  const size = PLANET_SURVEY_SAMPLES;
  const polar = chartPlanetSurvey(field([400, 0, 180, 0]));
  assert.equal(polar.length, size ** 2);
  assert.equal(polar[0], Math.round((400 / Math.sqrt(4 * Math.PI) + 180 * Math.sqrt(3 / (4 * Math.PI))) / 1.21));
  assert.equal(polar[(size - 1) * size], 0);
  const azimuth = chartPlanetSurvey(field([400, -200, 0, 0]));
  const equator = Math.floor(size / 2) * size;
  assert.ok(azimuth[equator + Math.round(size / 4)]! > azimuth[equator + Math.round(size * .75)]!);
  assert.equal(azimuth[equator], azimuth[equator + size - 1]);
});

test("flat and invalid surveys do not yield artificial hotspots", () => {
  assert.ok(chartPlanetSurvey(field([500])).every(value => value === 0));
  assert.throws(() => chartPlanetSurvey({ ...field([0]), data: [0, 0, 0] }), /complete resource distribution/);
  assert.throws(() => chartPlanetSurvey(field([NaN])), /invalid resource distribution/);
});
