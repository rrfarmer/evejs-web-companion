// A ship's activation strength (EveSpaceObject2's Shipdata.y: 1, less while its hull damage flickers its lights,
// impactOverlay.ts) for the shaders that read it per object - the decals' glow, the fx hull layers, the haze - whose
// materials one type's ships share (a model is drawn as clones of one). Each draw takes the value of the ship it is
// part of (the nearest ancestor's userData.activation, hullModel.ts setActivationStrength; 1 where none is set) and
// uploads it when it differs from the last draw's (ShaderMaterial.uniformsNeedUpdate: three uploads a material's
// uniforms again only when it changes material otherwise).

import * as THREE from "three";

/** The activation strength of the ship an object is part of; 1 where none is set. */
export function activationOf(o: THREE.Object3D): number {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (typeof p.userData.activation === "number") return p.userData.activation as number;
  return 1;
}

/**
 * A ship's booster gain (Shipdata.x: EveShip2's booster glow intensity, its engines' share of thrust here, hullModel.ts
 * setThrust; an object that is no ship keeps EveSpaceObject2's 1).
 */
export function boosterGainOf(o: THREE.Object3D): number {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (typeof p.userData.thrust === "number") return p.userData.thrust as number;
  return 1;
}

/**
 * The material given an `activation` uniform (and, with withBoosterGain, a `boosterGain` one), set for each draw from
 * the drawn object's ship (its own hook kept).
 */
export function followActivation<M extends THREE.ShaderMaterial>(material: M, withBoosterGain = false): M {
  const uniform = { value: 1 }, gain = { value: 1 };
  material.uniforms.activation = uniform;
  if (withBoosterGain) material.uniforms.boosterGain = gain;
  const before = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    const a = activationOf(object);
    if (a !== uniform.value) { uniform.value = a; material.uniformsNeedUpdate = true; }
    if (withBoosterGain) { const g = boosterGainOf(object); if (g !== gain.value) { gain.value = g; material.uniformsNeedUpdate = true; } }
  };
  return material;
}
