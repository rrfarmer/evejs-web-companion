import assert from "node:assert/strict";
import { test } from "node:test";
import { Data3DTexture, Texture } from "three";
import { ObservatoryEnvironment } from "./observatoryEnvironment.ts";

test("Observatory postprocessing follows the in-range anchor and clears on removal or low quality", async () => {
  const grime = new Texture();
  const lut = new Data3DTexture();
  let requests = 0;
  const environment = new ObservatoryEnvironment(async () => {
    requests++;
    return {
      grime, lut,
      template: {
        anchor: 49106,
        activationRadius: 25_000_000,
        distanceField: { minDistance: 40_000, maxDistance: 1_200_000, timeAdjustmentSecondsIn: 2, timeAdjustmentSecondsOut: 2 },
        postProcess: {
          ranges: { bloom: [0.2, 1] },
          bloom: { luminanceThreshold: 0.6, luminanceScale: 0.6, grimePath: "", grimeWeight: 40 },
          lut: { path: "", influence: 0.75 },
        },
      },
    };
  });
  const origin = { x: 2e12, y: -5e10, z: -7e11 };
  const eye = { x: 0, y: 0, z: 100_000 };
  const anchor = { itemID: 30, typeID: 49106, position: { ...origin, z: origin.z - 100_000 } };
  const sample = (entities = [anchor], seconds = 1, enabled = true) => environment.sample(entities, origin, eye, seconds, enabled);

  assert.equal(sample([{ ...anchor, typeID: 77388 }]), null);
  assert.equal(requests, 0);
  assert.equal(sample(), null);
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(sample()!.lutInfluence, 0.375);
  assert.deepEqual(sample(), { luminanceThreshold: 0.6, luminanceScale: 0.6, brightness: 1, grime, grimeWeight: 40, lut, lutInfluence: 0.75 });

  const distantEye = { ...eye, x: 1_500_000 };
  assert.equal(environment.sample([anchor], origin, distantEye, 1, true)!.lutInfluence, 0.375);
  assert.equal(environment.sample([anchor], origin, distantEye, 1, true)!.lutInfluence, 0);
  assert.equal(environment.sample([anchor], origin, { ...eye, x: 25_000_000 }, 1, true), null);

  assert.equal(sample([], 1), null);
  assert.equal(sample()!.lutInfluence, 0.375);
  assert.equal(sample([anchor], 1, false), null);
  assert.equal(sample()!.lutInfluence, 0.375);
  const cameraAt300km = { ...eye, x: 300_000 };
  const middle = environment.sample([anchor], origin, cameraAt300km, 2, true);
  // Installed EveDistanceField.DistanceCurve evaluated by GetScalarAt(300000).
  assert.ok(Math.abs(middle!.lutInfluence / 0.75 - 0.7758620977) < 1e-7);
  assert.equal(requests, 1);
});
