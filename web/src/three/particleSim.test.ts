import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT, ParticleEmitter, ParticleSim, elementKey } from "./particleSim.ts";

test("a child emitter carries fractional rate and inherits the parent particle's movement", () => {
  const sim = new ParticleSim({
    type: "Tr2ParticleSystem",
    maxParticleCount: 4,
    elements: [{ elementType: ELEMENT.POSITION }, { elementType: ELEMENT.VELOCITY }],
  });
  const emitter = new ParticleEmitter({
    type: "Tr2DynamicEmitter",
    rate: 4,
    generators: [{
      type: "Tr2SphereShapeAttributeGenerator",
      position: [1, 2, 3],
      parentVelocityFactor: 0.5,
    }],
  }, sim);
  emitter.spawn(0.125, [10, 20, 30], [2, 4, 6]);
  assert.equal(sim.alive, 0);
  emitter.spawn(0.125, [11, 22, 33], [4, 6, 8]);
  assert.equal(sim.alive, 1);
  const position = sim.arrays.get(elementKey({ elementType: ELEMENT.POSITION }));
  const velocity = sim.arrays.get(elementKey({ elementType: ELEMENT.VELOCITY }));
  assert.deepEqual(Array.from(position!.subarray(0, 3)), [12, 24, 36]);
  assert.deepEqual(Array.from(velocity!.subarray(0, 3)), [2, 3, 4]);
});
