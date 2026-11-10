// The space view draws with a logarithmic depth buffer (the camera spans a metre to light years). three.js's own
// materials write that depth; a ShaderMaterial writes it only when its shaders carry the log-depth chunks. One that
// does not writes plain z / w, which at planet range sits at 1 within a float's step: the far plane cuts its
// triangles at random (a planet's limb drawn as a saw), and it is tested against log depths it does not share.

import * as THREE from "three";

const VS_PARS = `#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
varying float vFragDepth; varying float vIsPerspective;
#endif
`;
const VS_BODY = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
vFragDepth = 1.0 + gl_Position.w; vIsPerspective = projectionMatrix[ 2 ][ 3 ] == - 1.0 ? 1.0 : 0.0;
#endif
`;

/**
 * A ShaderMaterial given the log-depth chunks (as three.js's own logdepthbuf_* ones): the vertex stage's after the
 * last statement of its main (the shader's last brace), the fragment stage's first in its main. Both are inert where
 * the renderer has no logarithmic depth buffer (the hangar).
 */
export function logDepth<M extends THREE.ShaderMaterial>(mat: M): M {
  const vs = mat.vertexShader;
  const end = vs.lastIndexOf("}");
  if (end < 0 || vs.includes("vFragDepth")) return mat;
  mat.vertexShader = VS_PARS + vs.slice(0, end) + VS_BODY + vs.slice(end);
  const fs = mat.fragmentShader;
  const main = /void\s+main\s*\(\s*\)\s*\{/.exec(fs);
  if (!main) throw new Error("logDepth: no main in the fragment shader");
  const at = main.index + main[0].length;
  mat.fragmentShader = `#include <logdepthbuf_pars_fragment>\n${fs.slice(0, at)}\n#include <logdepthbuf_fragment>\n${fs.slice(at)}`;
  return mat;
}
