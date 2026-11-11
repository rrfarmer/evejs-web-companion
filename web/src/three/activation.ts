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

/** The clip spheres of the space object an object is part of (hullModel.ts setClipSphere), or null. */
export function clipOf(o: THREE.Object3D): number[] | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.clip !== undefined) return p.userData.clip as number[] | null;
  return null;
}

/**
 * The hull material clipped by its space object's clip spheres (quadv5's SOC_ENABLED permutation, fxres.py
 * SPACE_OBJECT_CLIPPING=SOC_ENABLED: the vertex's model-space position, EVE's, in TEXCOORD5; the pixel discarded where
 * sign(r^2) |p - c|^2 - r^2 < 0 for either sphere - inside one of positive radius, outside one of negative, nothing at
 * nought), its uniforms set for each draw from the drawn object's (clipOf). A standard material's own uniforms are
 * uploaded only as the draw's material changes: a clipping object draws with its own copies (hullModel.ts).
 */
export function followClip<M extends THREE.Material>(material: M): M {
  const data = { value: new THREE.Vector4() }, second = { value: 0 };
  const shaderMaterial = (material as unknown as THREE.ShaderMaterial).isShaderMaterial === true;
  if (shaderMaterial) Object.assign((material as unknown as THREE.ShaderMaterial).uniforms, { clipData: data, clipRadius2Sq: second });
  material.userData.followsClip = true;
  const compile = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.clipData = data;
    shader.uniforms.clipRadius2Sq = second;
    const main = /void\s+main\s*\(\s*\)\s*\{/;
    shader.vertexShader = `varying vec3 vClipP;\n${shader.vertexShader.replace(main, (m) => `${m}\n  vClipP = vec3( position.x, position.y, -position.z );`)}`;
    shader.fragmentShader = `uniform vec4 clipData; uniform float clipRadius2Sq; varying vec3 vClipP;\n${shader.fragmentShader.replace(main, (m) => `${m}
  { vec3 clipD = vClipP - clipData.xyz; float clipQ = dot( clipD, clipD );
    if ( sign( clipData.w ) * clipQ - clipData.w < 0.0 || sign( clipRadius2Sq ) * clipQ - clipRadius2Sq < 0.0 ) discard; }`)}`;
  };
  const before = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    const c = clipOf(object);
    const v = data.value;
    const x = c?.[0] ?? 0, y = c?.[1] ?? 0, z = c?.[2] ?? 0, w = c?.[3] ?? 0, w2 = c?.[4] ?? 0;
    if (v.x !== x || v.y !== y || v.z !== z || v.w !== w || second.value !== w2) {
      v.set(x, y, z, w);
      second.value = w2;
      if (shaderMaterial) (material as unknown as THREE.ShaderMaterial).uniformsNeedUpdate = true;
    }
  };
  return material;
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
