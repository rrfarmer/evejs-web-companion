import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import type { AgentGridState } from "./behaviorAgents.ts";
import { ChildAnimator, HULL_OWNER } from "./childAnimation.ts";

test("two clones can play different authored ranges of the same construction grid", () => {
  const animator = new ChildAnimator();
  const id = 7;
  animator.curveSets([{
    name: "Capacity_CS", scale: 1, playOnLoad: false,
    ranges: [{ name: "Empty", start: 0, end: 0, looped: false }, { name: "Full", start: 1, end: 1, looped: false }],
    curves: [{ type: "Tr2CurveScalar", keys: [[0, 0, 0, 0], [1, 1, 0, 0]] }],
    bindings: [{ source: 0, sourceCurve: null, sourceAttribute: "currentValue", destination: id,
      destinationType: "SpawnDrones", destinationAttribute: "gridFullnessFactor", scale: 1, offset: [0] }],
  }]);
  const template = new THREE.Object3D();
  template.userData.agentGrid = {
    grid: { id, info: [2, 1, 1, 3], spacing: [0, 0, 0], fullness: 0 }, regenerate: false,
  } satisfies AgentGridState;
  const full = template.clone(), empty = template.clone();
  const frame = (clone: THREE.Object3D) => animator.step(new Map([[id, [clone]]]), { visibility: 0 }, clone);
  animator.play(HULL_OWNER, "Capacity_CS", "Full", full);
  animator.play(HULL_OWNER, "Capacity_CS", "Empty", empty);
  frame(full);
  frame(empty);
  assert.equal(full.userData.agentGrid.grid.fullness, 1);
  assert.equal(empty.userData.agentGrid.grid.fullness, 0);
  assert.equal(template.userData.agentGrid.grid.fullness, 0);
  assert.equal(full.userData.agentGrid.regenerate, false, "the curve binding does not trigger the controller's regeneration action");
});

test("a controller variable drives every placement of a smart light source in its clone", () => {
  const animator = new ChildAnimator();
  animator.curveSets([{
    name: "Play_Start", scale: 1,
    curves: [{ id: 2, type: "Tr2CurveScalarExpression", expression: "input1 * input2", input2: 2 }],
    bindings: [
      { source: null, sourceCurve: null, sourceVariable: 1, sourceAttribute: "value", destination: 2,
        destinationType: "Tr2CurveScalarExpression", destinationAttribute: "input1", scale: 1, offset: [0] },
      { source: 0, sourceCurve: null, sourceAttribute: "currentValue", destination: 3,
        destinationType: "EveSmartLightPointLight", destinationAttribute: "brightness", scale: 3, offset: [0] },
    ],
  }]);
  const instance = (value: number) => {
    const owner = new THREE.Object3D();
    const source = new THREE.Object3D();
    source.userData.getVariable = () => value;
    const lights = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()];
    for (const light of lights) light.userData.lightRecord = { brightness: 0 };
    const objects = new Map([[1, [source]], [3, lights]]);
    animator.step(objects, { visibility: 0 }, owner);
    return { tick: () => animator.step(objects, { visibility: 0 }, owner), lights };
  };
  const charging = instance(0.5);
  const idle = instance(0);
  charging.tick();
  assert.deepEqual(charging.lights.map(light => light.userData.lightRecord.brightness), [3, 3, 3]);
  assert.deepEqual(idle.lights.map(light => light.userData.lightRecord.brightness), [0, 0, 0]);
});
