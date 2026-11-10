// A hull's children (EveSOFDataHull.children, read by tools/client-extract/lib/children.mjs): the static part of the
// client's EveChild* graph, in EVE's model space, mirrored in z here as the model is. Drawn so far: the containers'
// transforms and the quads (EveChildQuad with flarequad.fx / flarequadsoft.fx). Meshes, line sets, particle systems,
// lights, curve sets and state machines are later stages.

import * as THREE from "three";
import { logDepth } from "./logDepth.ts";

export interface SofChildQuad {
  k: "quad";
  name: string | null;
  m: number[];
  color: number[];
  brightness: number;
  minScreenSize: number;
  effect: string | null;
}
export interface SofChildContainer {
  k: "container";
  name: string | null;
  m: number[] | null;
  modifiers: string[];
  objects: SofChildNode[];
}
export type SofChildNode = SofChildQuad | SofChildContainer;
export interface SofHullChild {
  res: string;
  root: SofChildNode | null;
  skipped: Record<string, number | string>;
}

/** The average length of a matrix's three axes (flarequad's vertex stage: its world matrix's scale, a third of each). */
function meanScale(m: THREE.Matrix4): number {
  const e = m.elements;
  return (Math.hypot(e[0]!, e[1]!, e[2]!) + Math.hypot(e[4]!, e[5]!, e[6]!) + Math.hypot(e[8]!, e[9]!, e[10]!)) / 3;
}

/**
 * The quads as flarequad.fx draws them (its sm_hi vertex and pixel stages disassembled, client 3396210), one instance
 * each: the quad's middle (its translation) through its parents' transforms and the eye's; its corners (+-0.5) along
 * the quad's own x and y axes (its rotation and scaling), times the mean scale of its parents' world transform, laid
 * on in the eye's space (a billboard turned and shaped by the quad's own transform); its colour colour x brightness,
 * times (asin(c) / (pi/2))^2 for c the cosine of its angle off the eye's axis (dimmer toward the screen's edge). The
 * pixel: (1 / (d + 0.001) - 0.999001) x 1.001 for d the distance from the middle (1 at the edge), added. The client's
 * pixel stage also takes a screen-space occlusion array by depth (its t0), not drawn here; flarequadsoft.fx is drawn
 * as flarequad.fx. A quad under minScreenSize pixels across is not drawn.
 */
function quadMesh(quads: { centre: THREE.Vector3; ax: THREE.Vector3; ay: THREE.Vector3; colour: number[]; min: number }[]): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const n = quads.length;
  const centre = new Float32Array(n * 3), ax = new Float32Array(n * 3), ay = new Float32Array(n * 3), colour = new Float32Array(n * 4), min = new Float32Array(n);
  quads.forEach((q, i) => {
    q.centre.toArray(centre, i * 3); q.ax.toArray(ax, i * 3); q.ay.toArray(ay, i * 3);
    colour.set(q.colour.slice(0, 4), i * 4); min[i] = q.min;
  });
  geo.setAttribute("iCentre", new THREE.InstancedBufferAttribute(centre, 3));
  geo.setAttribute("iAxisX", new THREE.InstancedBufferAttribute(ax, 3));
  geo.setAttribute("iAxisY", new THREE.InstancedBufferAttribute(ay, 3));
  geo.setAttribute("iColour", new THREE.InstancedBufferAttribute(colour, 4));
  geo.setAttribute("iMin", new THREE.InstancedBufferAttribute(min, 1));
  geo.instanceCount = n;
  const viewHeight = { value: 1080 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { viewHeight },
    vertexShader: `attribute vec3 iCentre; attribute vec3 iAxisX; attribute vec3 iAxisY; attribute vec4 iColour; attribute float iMin;
      uniform float viewHeight; varying vec2 vUv; varying vec4 vColour;
      void main() {
        vUv = uv;
        float s = (length(modelMatrix[0].xyz) + length(modelMatrix[1].xyz) + length(modelMatrix[2].xyz)) / 3.0;
        vec4 mv = modelViewMatrix * vec4(iCentre, 1.0);
        vec3 ax = iAxisX * s, ay = iAxisY * s;
        float c = clamp(-normalize(mv.xyz).z, 0.0, 1.0);
        float f = asin(c) * 0.63662;
        vColour = iColour * f * f;
        // the quad's size on the screen, in pixels, against its minScreenSize
        float px = min(length(ax), length(ay)) * projectionMatrix[1][1] * 0.5 * viewHeight / max(-mv.z, 1e-6);
        if (px < iMin) vColour = vec4(0.0);
        mv.xyz += ax * position.x + ay * position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying vec2 vUv; varying vec4 vColour;
      void main() {
        float d = min(length((vUv - 0.5) * 2.0), 1.0);
        float k = (1.0 / (d + 0.001) - 0.999001) * 1.001;
        gl_FragColor = k * vColour;
      }`,
    // both sides: the corners are laid on in the eye's space, which the mirror in z does not turn, while three.js
    // takes the mirrored model's front faces as clockwise (every quad was culled)
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  logDepth(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "child-quads";
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  const size = new THREE.Vector2();
  mesh.onBeforeRender = (renderer) => { viewHeight.value = renderer.getDrawingBufferSize(size).y; };
  return mesh;
}

/**
 * The hull's children as drawn so far, under one group mirrored in z (EVE's model space to ours), or null where
 * nothing of them is drawn.
 */
export function hullChildren(children: SofHullChild[] | undefined): THREE.Object3D | null {
  const quads: Parameters<typeof quadMesh>[0] = [];
  const walk = (node: SofChildNode, parent: THREE.Matrix4) => {
    if (node.k === "container") {
      const world = node.m ? parent.clone().multiply(new THREE.Matrix4().fromArray(node.m)) : parent;
      for (const o of node.objects) walk(o, world);
      return;
    }
    if (node.k !== "quad") return;
    const local = new THREE.Matrix4().fromArray(node.m);
    const s = meanScale(parent);
    const e = local.elements;
    const b = node.brightness;
    quads.push({
      centre: new THREE.Vector3(e[12], e[13], e[14]).applyMatrix4(parent),
      ax: new THREE.Vector3(e[0], e[1], e[2]).multiplyScalar(s),
      ay: new THREE.Vector3(e[4], e[5], e[6]).multiplyScalar(s),
      colour: [(node.color[0] ?? 1) * b, (node.color[1] ?? 1) * b, (node.color[2] ?? 1) * b, (node.color[3] ?? 1) * b],
      min: node.minScreenSize,
    });
  };
  for (const child of children ?? []) if (child.root) walk(child.root, new THREE.Matrix4());
  if (!quads.length) return null;
  const group = new THREE.Group();
  group.name = "hull-children";
  group.scale.set(1, 1, -1);
  group.add(quadMesh(quads));
  return group;
}
