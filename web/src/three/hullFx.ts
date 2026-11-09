// A hull's lights and planes as the Space Object Factory lays them out (the extractor's SOF build: spriteSets and
// planeSets, in EVE's model space, mirrored in z here as the model is): the blinking sprite lights a ship or a hangar
// carries (EveSOFDataHullSpriteSet: each light's place, size between minScale and maxScale, blink rate and phase,
// colour), and the plane cards of force fields, holograms and haze (EveSOFDataHullPlaneSet: each plane placed, rotated
// and scaled, two scrolling texture layers under a mask, in its own colour times its faction group's). Our own drawing
// of them: additive glows and planes; the client's own shaders for these are not ported.

import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";

export interface SofSpriteSet {
  name: string | null;
  items: { position: number[]; blinkRate: number; blinkPhase: number; minScale: number; maxScale: number; intensity: number; color: number[] | null }[];
}
export interface SofPlaneSet {
  name: string | null; layer1: string | null; layer2: string | null; mask: string | null;
  items: {
    position: number[]; rotation: number[]; scaling: number[]; color: number[] | null; groupColor: number[] | null; intensity: number;
    layer1Transform: number[]; layer1Scroll: number[]; layer2Transform: number[]; layer2Scroll: number[];
  }[];
}

export interface SofSpotlightSet {
  name: string | null; cone: string | null; glow: string | null; zOffset: number;
  items: { transform: number[] | null; coneIntensity: number; coneColor: number[] | null }[];
}

/** The time the effects run by, in seconds; one clock for every hull. */
const clock = { value: 0 };
function tick(): void { clock.value = performance.now() / 1000; }

let glow: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  return glow;
}

/**
 * The sprite lights as points, each growing from its minScale to its maxScale and back as it blinks
 * (blinkRate cycles a second, at its blinkPhase), sized in metres.
 */
function spritePoints(sets: readonly SofSpriteSet[]): THREE.Points | null {
  const items = sets.flatMap((s) => s.items);
  if (!items.length) return null;
  const n = items.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), blink = new Float32Array(n * 4);
  items.forEach((it, i) => {
    pos.set([it.position[0] ?? 0, it.position[1] ?? 0, -(it.position[2] ?? 0)], i * 3);
    const c = it.color ?? [1, 1, 1, 1];
    const k = it.intensity ?? 1;
    col.set([(c[0] ?? 1) * k, (c[1] ?? 1) * k, (c[2] ?? 1) * k], i * 3);
    blink.set([it.blinkRate, it.blinkPhase, it.minScale, it.maxScale], i * 4);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("colour", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("blink", new THREE.BufferAttribute(blink, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: clock, map: { value: glowTexture() }, scale: { value: 1 } },
    vertexShader: `attribute vec3 colour; attribute vec4 blink; uniform float time; uniform float scale; varying vec3 vColour; varying float vLit;
      void main() {
        float b = blink.x > 0.0 ? 0.5 + 0.5 * sin(6.2831853 * (time * blink.x + blink.y)) : 1.0;
        float size = mix(blink.z, blink.w, b);
        vColour = colour; vLit = 0.35 + 0.65 * b;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D map; varying vec3 vColour; varying float vLit;
      void main() { float a = texture2D(map, gl_PointCoord).r; gl_FragColor = vec4(vColour * a * vLit * 2.0, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.name = "spriteSets";
  points.frustumCulled = false;
  // pixels per metre at one metre: the viewport's height over the view's height there (on the material, which a
  // cloned model shares: Object3D.clone does not carry an object's own onBeforeRender)
  mat.onBeforeRender = (renderer, _scene, camera) => {
    tick();
    const cam = camera as THREE.PerspectiveCamera;
    const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    mat.uniforms.scale!.value = cam.isPerspectiveCamera ? h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) : 1;
  };
  return points;
}

const textures = new Map<string, Promise<THREE.Texture | null>>();
function tex(url: string | null): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  if (!textures.has(url)) {
    textures.set(url, loadDds(url).then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t as THREE.Texture; }).catch(() => null));
  }
  return textures.get(url)!;
}

/** The plane cards: a unit quad each, placed, its layers scrolled by their own speeds, added over what is behind. */
async function planeMeshes(sets: readonly SofPlaneSet[]): Promise<THREE.Group | null> {
  if (!sets.some((s) => s.items.length)) return null;
  const group = new THREE.Group();
  group.name = "planeSets";
  const quad = new THREE.PlaneGeometry(2, 2);
  for (const set of sets) {
    const [l1, l2, mask] = await Promise.all([tex(set.layer1), tex(set.layer2), tex(set.mask)]);
    for (const it of set.items) {
      const c = it.color ?? [1, 1, 1, 1], g = it.groupColor ?? [1, 1, 1, 1];
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          time: clock,
          colour: { value: new THREE.Vector3((c[0] ?? 1) * (g[0] ?? 1), (c[1] ?? 1) * (g[1] ?? 1), (c[2] ?? 1) * (g[2] ?? 1)).multiplyScalar(it.intensity ?? 1) },
          layer1: { value: l1 }, layer2: { value: l2 }, mask: { value: mask },
          has: { value: new THREE.Vector3(l1 ? 1 : 0, l2 ? 1 : 0, mask ? 1 : 0) },
          t1: { value: new THREE.Vector4(...(it.layer1Transform as [number, number, number, number])) },
          s1: { value: new THREE.Vector4(...(it.layer1Scroll as [number, number, number, number])) },
          t2: { value: new THREE.Vector4(...(it.layer2Transform as [number, number, number, number])) },
          s2: { value: new THREE.Vector4(...(it.layer2Scroll as [number, number, number, number])) },
        },
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `uniform float time; uniform vec3 colour; uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D mask;
          uniform vec3 has; uniform vec4 t1; uniform vec4 s1; uniform vec4 t2; uniform vec4 s2; varying vec2 vUv;
          void main() {
            vec2 uv1 = vUv * t1.xy + t1.zw + s1.xy * time;
            vec2 uv2 = vUv * t2.xy + t2.zw + s2.xy * time;
            float a = has.x > 0.5 ? texture2D(layer1, uv1).r : 1.0;
            float b = has.y > 0.5 ? texture2D(layer2, uv2).r : 1.0;
            float m = has.z > 0.5 ? texture2D(mask, vUv).r : 1.0;
            gl_FragColor = vec4(colour * a * b * m, 1.0);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.position.set(it.position[0] ?? 0, it.position[1] ?? 0, -(it.position[2] ?? 0));
      // a rotation in EVE's space, mirrored in z
      const r = it.rotation;
      mesh.quaternion.set(-(r[0] ?? 0), -(r[1] ?? 0), r[2] ?? 0, r[3] ?? 1);
      mesh.scale.set(it.scaling[0] ?? 1, it.scaling[1] ?? 1, it.scaling[2] ?? 1);
      mesh.frustumCulled = false;
      mat.onBeforeRender = tick;
      group.add(mesh);
    }
  }
  return group;
}

/**
 * The light cones (spotlightconepool.fx, its vertex shader disassembled): each cone four quads through its axis, a
 * quarter turn apart, every corner at an angle of the quad's (or half a turn on) on the unit circle and at z 0 or 1
 * (plus the set's zOffset), placed by the item's transform; the cone texture across the quad (u across, v down the
 * axis), in the cone colour times its intensity, and each quad the brighter the more squarely it faces the eye. The
 * corner table is the engine's, not the effect's: taken as the four corners of the unit square.
 */
async function spotlightCones(sets: readonly SofSpotlightSet[]): Promise<THREE.Group | null> {
  const lit = sets.filter((s) => s.items.some((it) => it.transform && it.coneIntensity > 0));
  if (!lit.length) return null;
  const group = new THREE.Group();
  group.name = "spotlightSets";
  const mirror = new THREE.Matrix4().makeScale(1, 1, -1);
  const CORNERS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const set of lit) {
    const map = await tex(set.cone);
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], index: number[] = [];
    for (const it of set.items) {
      if (!it.transform || it.coneIntensity <= 0) continue;
      const m = new THREE.Matrix4().fromArray(it.transform).premultiply(mirror);
      const c = it.coneColor ?? [1, 1, 1, 1];
      const k = it.coneIntensity * (c[3] ?? 1);
      for (let q = 0; q < 4; q++) {
        const a = (q * Math.PI) / 4;
        const n = new THREE.Vector3(Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2), 0).transformDirection(m);
        const base = pos.length / 3;
        for (const [tx, ty] of CORNERS) {
          const t = Math.PI * tx + a;
          const p = new THREE.Vector3(Math.cos(t), Math.sin(t), set.zOffset + ty).applyMatrix4(m);
          pos.push(p.x, p.y, p.z);
          nor.push(n.x, n.y, n.z);
          uv.push(tx, 1 - ty);
          col.push((c[0] ?? 1) * k, (c[1] ?? 1) * k, (c[2] ?? 1) * k);
        }
        index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("colour", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(index);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, hasMap: { value: map ? 1 : 0 } },
      vertexShader: `attribute vec3 colour; varying vec3 vColour; varying vec2 vUv; varying float vFacing;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec3 n = normalize(mat3(modelMatrix) * normal);
          vFacing = abs(dot(n, normalize(cameraPosition - world.xyz)));
          vColour = colour; vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `uniform sampler2D map; uniform float hasMap; varying vec3 vColour; varying vec2 vUv; varying float vFacing;
        void main() { vec3 t = hasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(1.0); gl_FragColor = vec4(t * vColour * vFacing, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

/** A hull's sprite lights, plane cards and light cones as one group, or null where it has none. */
export async function hullFx(sof: { spriteSets?: SofSpriteSet[]; planeSets?: SofPlaneSet[]; spotlightSets?: SofSpotlightSet[] }): Promise<THREE.Group | null> {
  const points = spritePoints(sof.spriteSets ?? []);
  const planes = await planeMeshes(sof.planeSets ?? []);
  const cones = await spotlightCones(sof.spotlightSets ?? []);
  if (!points && !planes && !cones) return null;
  const group = new THREE.Group();
  group.name = "hullFx";
  if (points) group.add(points);
  if (planes) group.add(planes);
  if (cones) group.add(cones);
  return group;
}
