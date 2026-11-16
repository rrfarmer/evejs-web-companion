import assert from "node:assert/strict";
import { test } from "node:test";
import { Data3DTexture, Texture } from "three";
import { ObservatoryEnvironment } from "./observatoryEnvironment.ts";

test("Observatory postprocessing follows the in-range anchor and clears on removal or low quality", async () => {
  const grime = new Texture();
  const lut = new Data3DTexture();
  const fog = {
    color: [0.4745, 0.5882, 0.3333, 0] as const,
    colorInfluence: 0.25, nebulaInfluence: 0.75, backgroundOcclusion: 1.15, brightnessAdjustmentAmount: 0.55,
    blendDistance0: 0, blendDistance1: 14_000, blendDistance2: 50_000,
    blendBias0: 0.97, blendBias1: 0.9, blendBias2: 0.333,
    blendAmount0: 0.1, blendAmount1: 0.24, blendAmount2: 0.36, blendPower2: 0.15,
    areaScale: [7, 7] as const,
  };
  let requests = 0;
  const environment = new ObservatoryEnvironment(async () => {
    requests++;
    return {
      grime, lut,
      template: {
        anchor: 49106,
        activationRadius: 25_000_000,
        distanceField: { dimensions: [1_000_000, 1_000_000, 1_000_000], minDistance: 40_000, maxDistance: 1_200_000, timeAdjustmentSecondsIn: 2, timeAdjustmentSecondsOut: 2 },
        postProcess: {
          ranges: { bloom: [0.2, 1], fog: [0, 1] },
          fog,
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
  const distantEye = { ...eye, x: 1_500_000 };
  assert.equal(environment.sample([anchor], origin, distantEye, 0.1, true)!.lutInfluence, 0);
  // 3698585, 100 ms fixed simulation steps from outside to the field center.
  let sampleNear = sample([anchor], 0.1)!;
  assert.ok(Math.abs(sampleNear.lutInfluence / 0.75 - 0.05172413588) < 1e-7);
  sampleNear = sample([anchor], 0.1)!;
  assert.ok(Math.abs(sampleNear.lutInfluence / 0.75 - 0.10086208582) < 1e-7);
  assert.ok(Math.abs(sampleNear.fog.intensity - 0.104) < 1e-12);
  assert.equal(sampleNear.fog.amount, sampleNear.fog.influence);
  assert.deepEqual(sampleNear.fog.center, { x: 0, y: 0, z: 100_000 });
  assert.equal(sampleNear.fog.settings, fog);
  const settled = sample([anchor], 2)!;
  assert.equal(settled.lutInfluence, 0.75);
  assert.equal(settled.grimeWeight, 40);
  assert.equal(settled.fog.intensity, 1);

  const retreat = environment.sample([anchor], origin, distantEye, 1, true)!;
  assert.ok(Math.abs(retreat.lutInfluence / 0.75 - 0.51724135876) < 1e-7);
  assert.equal(environment.sample([anchor], origin, distantEye, 2, true)!.lutInfluence, 0);
  assert.equal(environment.sample([anchor], origin, { ...eye, x: 25_000_000 }, 1, true), null);

  assert.equal(sample([], 1), null);
  assert.equal(sample([anchor], 0.1)!.fog.intensity < 0.02, true);
  assert.equal(sample([anchor], 1, false), null);
  assert.equal(sample([anchor], 0.1)!.fog.intensity < 0.02, true);
  const cameraAt300km = { ...eye, x: 300_000 };
  const middle = environment.sample([anchor], origin, cameraAt300km, 2, true);
  // Installed EveDistanceField.DistanceCurve evaluated by GetScalarAt(300000).
  assert.ok(Math.abs(middle!.lutInfluence / 0.75 - 0.7758620977) < 1e-7);
  assert.equal(requests, 1);
});
