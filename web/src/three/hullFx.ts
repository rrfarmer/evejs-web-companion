// A hull's lights and planes as the Space Object Factory lays them out (the extractor's SOF build: spriteSets and
// planeSets, in EVE's model space, mirrored in z here as the model is): the blinking sprite lights a ship or a hangar
// carries (EveSOFDataHullSpriteSet: each light's place, size between minScale and maxScale, blink rate and phase,
// colour), and the plane cards of force fields, holograms and haze (EveSOFDataHullPlaneSet: each plane placed, rotated
// and scaled, two scrolling texture layers under a mask, in its faction group's colour where the faction gives one,
// else its own). The maths is the client's, from its disassembled blinkinglightspool and planeglow shaders.

import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";

export interface SofSpriteSet {
  name: string | null;
  items: { position: number[]; blinkRate: number; blinkPhase: number; minScale: number; maxScale: number; intensity: number; falloff?: number; color: number[] | null }[];
}
export interface SofPlaneSet {
  name: string | null; layer1: string | null; layer2: string | null; mask: string | null;
  items: {
    position: number[]; rotation: number[]; scaling: number[]; color: number[] | null; groupColor: number[] | null; intensity: number;
    layer1Transform: number[]; layer1Scroll: number[]; layer2Transform: number[]; layer2Scroll: number[];
    blinkMode?: number; blinkRate?: number; blinkPhase?: number;
  }[];
}

/**
 * The client's blink (blinkinglightspool and planeglow vertex shaders): over a cycle of 1/rate seconds, at the item's
 * phase, it rises from 0 to 1 over the first rate x 0.05 of the cycle and falls back to 0 by rate x 0.2, then stays
 * out; a rate under 0.002 rises over the whole cycle. GLSL, of the cycle's fraction p and the rate.
 */
const FLASH_GLSL = `float flash(float p, float rate) {
  float rise = rate < 0.002 ? 1.0 : rate * 0.05;
  float end = rate * 0.2;
  if (p < rise) return p / rise;
  if (p < end) return 1.0 - (p - rise) / (end - rise);
  return 0.0;
}`;

export interface SofSpotlightSet {
  name: string | null; cone: string | null; glow: string | null; zOffset: number;
  items: {
    transform: number[] | null; coneIntensity: number; coneColor: number[] | null;
    spriteIntensity: number; flareIntensity: number; spriteScale: number[]; spriteColor: number[] | null; flareColor: number[] | null;
  }[];
}

export interface SofHazeSet {
  name: string | null; hazeType: number;
  items: {
    position: number[]; rotation: number[]; scaling: number[]; color: number[] | null;
    hazeBrightness: number; hazeFalloff: number; sourceBrightness: number; sourceSize: number; saturation: number;
  }[];
}

/** The time the effects run by, in seconds; one clock for every hull. */
const clock = { value: 0 };
function tick(): void { clock.value = performance.now() / 1000; }

/**
 * The sprite lights as points (blinkinglightspool.fx): each blinks (flash), its size from minScale to maxScale with the
 * blink, in metres, times its distance from the eye to the power of its falloff; its colour times its intensity times
 * one plus the blink; its spot the shader's own profile (4.5 (1.1 / (1 + 10 d) - 0.1)^1.5 of the distance d from its
 * middle, nothing past its edge).
 */
function spritePoints(sets: readonly SofSpriteSet[]): THREE.Points | null {
  const items = sets.flatMap((s) => s.items);
  if (!items.length) return null;
  const n = items.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), blink = new Float32Array(n * 4), falloff = new Float32Array(n);
  items.forEach((it, i) => {
    falloff[i] = it.falloff ?? 0;
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
  geo.setAttribute("falloff", new THREE.BufferAttribute(falloff, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: clock, scale: { value: 1 } },
    vertexShader: `attribute vec3 colour; attribute vec4 blink; attribute float falloff; uniform float time; uniform float scale; varying vec3 vColour;
      ${FLASH_GLSL}
      void main() {
        float b = flash(fract(time * blink.x + blink.y), blink.x);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float z = max(abs(mv.z), 1.0);
        float size = mix(blink.z, blink.w, b) * pow(z, falloff);
        vColour = colour * (b + 1.0);
        gl_PointSize = size * scale / z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying vec3 vColour;
      void main() {
        float d = length((gl_PointCoord - 0.5) * 2.0);
        float a = d < 1.0 ? 4.5 * pow(max(1.1 / (1.0 + 10.0 * d) - 0.1, 0.0), 1.5) : 0.0;
        gl_FragColor = vec4(vColour * a, 1.0);
      }`,
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

/**
 * The plane cards (planeglow.fx): a quad each, placed, rotated and scaled; each layer's coordinates its transform's
 * scale and offset plus its scroll's speed times the time plus its scroll's offset; layer 1 times layer 2 times the
 * mask, in its colour times its blink (mode 0 steady, 1 the flash, 2 a rising and 3 a falling saw, 4 a sine), added
 * over what is behind. The corner table (PlaneCornerOffset) is the engine's, not the effect file's: taken as the unit
 * square about the middle, the scaling its whole size.
 */
async function planeMeshes(sets: readonly SofPlaneSet[]): Promise<THREE.Group | null> {
  if (!sets.some((s) => s.items.length)) return null;
  const group = new THREE.Group();
  group.name = "planeSets";
  const quad = new THREE.PlaneGeometry(1, 1);
  for (const set of sets) {
    const [l1, l2, mask] = await Promise.all([tex(set.layer1), tex(set.layer2), tex(set.mask)]);
    for (const it of set.items) {
      // EveSOF.SetupPlaneSets: the faction group's colour, where it has one, in place of the plane's own
      const c = it.groupColor ?? it.color ?? [1, 1, 1, 1];
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          time: clock,
          colour: { value: new THREE.Vector3(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1).multiplyScalar((c[3] ?? 1) * (it.intensity ?? 1)) },
          blinking: { value: new THREE.Vector3(it.blinkMode ?? 0, it.blinkRate ?? 0, it.blinkPhase ?? 0) },
          layer1: { value: l1 }, layer2: { value: l2 }, mask: { value: mask },
          has: { value: new THREE.Vector3(l1 ? 1 : 0, l2 ? 1 : 0, mask ? 1 : 0) },
          t1: { value: new THREE.Vector4(...(it.layer1Transform as [number, number, number, number])) },
          s1: { value: new THREE.Vector4(...(it.layer1Scroll as [number, number, number, number])) },
          t2: { value: new THREE.Vector4(...(it.layer2Transform as [number, number, number, number])) },
          s2: { value: new THREE.Vector4(...(it.layer2Scroll as [number, number, number, number])) },
        },
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: `uniform float time; uniform vec3 colour; uniform vec3 blinking; uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D mask;
          uniform vec3 has; uniform vec4 t1; uniform vec4 s1; uniform vec4 t2; uniform vec4 s2; varying vec2 vUv;
          ${FLASH_GLSL}
          float blink() {
            float mode = abs(blinking.x), rate = blinking.y, phase = blinking.z;
            if (mode < 0.5) return 1.0;
            if (mode < 1.5) return flash(fract(time * rate + phase), rate);
            if (mode < 2.5) return fract((phase + time) * rate);
            if (mode < 3.5) return 1.0 - fract((phase + time) * rate);
            if (mode < 4.5) return (sin(fract(rate * time) * 6.2831853 + phase * 6.2831853) + 1.0) * 0.5;
            return 1.0;
          }
          void main() {
            vec2 uv1 = vUv * t1.xy + t1.zw + s1.xy * time + s1.zw;
            vec2 uv2 = vUv * t2.xy + t2.zw + s2.xy * time + s2.zw;
            vec3 a = has.x > 0.5 ? texture2D(layer1, uv1).rgb : vec3(1.0);
            vec3 b = has.y > 0.5 ? texture2D(layer2, uv2).rgb : vec3(1.0);
            vec3 m = has.z > 0.5 ? texture2D(mask, vUv).rgb : vec3(1.0);
            gl_FragColor = vec4(colour * blink() * a * b * m, 1.0);
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

/**
 * The light's glow and flare (spotlightglowpool.fx, disassembled): two billboards at the item's place, the glow
 * spriteScale.x square in the sprite colour and the flare spriteScale.y by .z in the flare colour, each times its
 * intensity, both the glow texture; each grows with how squarely the light's own z axis faces the eye (the glow never
 * below 0.15 of its size, the flare from nothing). The corner table is the engine's again: the unit square's, less a
 * half.
 */
async function spotlightGlows(sets: readonly SofSpotlightSet[]): Promise<THREE.Group | null> {
  const lit = sets.filter((s) => s.items.some((it) => it.transform && (it.spriteIntensity > 0 || it.flareIntensity > 0)));
  if (!lit.length) return null;
  const group = new THREE.Group();
  group.name = "spotlightGlows";
  const mirror = new THREE.Matrix4().makeScale(1, 1, -1);
  const CORNERS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const set of lit) {
    const map = await tex(set.glow);
    const centre: number[] = [], axis: number[] = [], corner: number[] = [], size: number[] = [], col: number[] = [], least: number[] = [], index: number[] = [];
    for (const it of set.items) {
      if (!it.transform) continue;
      const m = new THREE.Matrix4().fromArray(it.transform).premultiply(mirror);
      const at = new THREE.Vector3().setFromMatrixPosition(m);
      const z = new THREE.Vector3(0, 0, 1).transformDirection(m);
      const sc = it.spriteScale ?? [1, 1, 1];
      const quads: [number[] | null, number, number, number, number][] = [
        [it.spriteColor, it.spriteIntensity, sc[0] ?? 1, sc[0] ?? 1, 0.15],
        [it.flareColor, it.flareIntensity, sc[1] ?? 1, sc[2] ?? 1, 0],
      ];
      for (const [c0, k, w, h, low] of quads) {
        if (!(k > 0) || !(w > 0) || !(h > 0)) continue;
        const c = c0 ?? [1, 1, 1, 1];
        const base = centre.length / 3;
        for (const [cx, cy] of CORNERS) {
          centre.push(at.x, at.y, at.z);
          axis.push(z.x, z.y, z.z);
          corner.push(cx, cy);
          size.push(w, h);
          col.push((c[0] ?? 1) * k * (c[3] ?? 1), (c[1] ?? 1) * k * (c[3] ?? 1), (c[2] ?? 1) * k * (c[3] ?? 1));
          least.push(low);
        }
        index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    if (!index.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(centre, 3));
    geo.setAttribute("axis", new THREE.Float32BufferAttribute(axis, 3));
    geo.setAttribute("corner", new THREE.Float32BufferAttribute(corner, 2));
    geo.setAttribute("size", new THREE.Float32BufferAttribute(size, 2));
    geo.setAttribute("colour", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("least", new THREE.Float32BufferAttribute(least, 1));
    geo.setIndex(index);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, hasMap: { value: map ? 1 : 0 } },
      vertexShader: `attribute vec3 axis; attribute vec2 corner; attribute vec2 size; attribute vec3 colour; attribute float least;
        varying vec3 vColour; varying vec2 vUv;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec3 z = normalize(mat3(modelMatrix) * axis);
          float f = clamp(max(least, dot(normalize(cameraPosition - world.xyz), z)), 0.0, 1.0);
          vec4 mv = viewMatrix * world;
          mv.xy += f * (corner - 0.5) * size;
          vColour = colour; vUv = vec2(corner.x, 1.0 - corner.y);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D map; uniform float hasMap; varying vec3 vColour; varying vec2 vUv;
        void main() { vec3 t = hasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(1.0); gl_FragColor = vec4(t * vColour, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group.children.length ? group : null;
}

/** A hull's sprite lights, plane cards and light cones as one group, or null where it has none. */
/**
 * The haze volumes (hazespherical.fx, its shaders disassembled): each item a sphere of diameter 1 in its own space,
 * scaled into an ellipsoid, placed and turned. For each pixel the eye's ray through it: the haze is the length of the
 * ray's chord through the sphere to the power of the falloff, and the source a glow at the middle,
 * sourceBrightness * saturate(1 - 2 d / sourceSize)^(falloff / 3) for the ray's nearest distance d from the middle;
 * their sum, at most 1, times the colour, added to the frame. The colour is the faction's colour of the item's
 * colorType desaturated by its saturation, times its hazeBrightness (the runtime item's colour; how the factory
 * makes it is not in the shaders). Drawn from the inside faces so the eye can be within one (a hangar's are
 * kilometres wide). The client also dims the haze by a cascaded map of the scene (its third texture); not here.
 */
function hazeMeshes(sets: readonly SofHazeSet[]): THREE.Group | null {
  const items = sets.flatMap((s) => s.items);
  if (!items.length) return null;
  const group = new THREE.Group();
  group.name = "hazeSets";
  const sphere = new THREE.SphereGeometry(0.5, 24, 16);
  for (const it of items) {
    const c = it.color ?? [1, 1, 1, 1];
    const grey = 0.299 * (c[0] ?? 1) + 0.587 * (c[1] ?? 1) + 0.114 * (c[2] ?? 1);
    const colour = new THREE.Vector3(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1).lerp(new THREE.Vector3(grey, grey, grey), 1 - it.saturation).multiplyScalar(it.hazeBrightness);
    const mat = new THREE.ShaderMaterial({
      uniforms: { colour: { value: colour }, data: { value: new THREE.Vector3(it.hazeFalloff, it.sourceSize, it.sourceBrightness) } },
      vertexShader: `varying vec3 vObj; varying vec3 vEye;
        void main() {
          vObj = position;
          vEye = ( inverse( modelMatrix ) * vec4( cameraPosition, 1.0 ) ).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `uniform vec3 colour; uniform vec3 data; varying vec3 vObj; varying vec3 vEye;
        void main() {
          vec3 o = vEye;
          vec3 d = normalize( vObj - o );
          float b = dot( o, d );
          float disc = b * b - dot( o, o ) + 0.25;
          if ( disc < 0.0 ) discard;
          float chord = 2.0 * sqrt( disc );
          float near = length( o - b * d );
          float source = pow( clamp( 1.0 - near / ( 0.5 * data.y ), 0.0, 1.0 ), data.x / 3.0 );
          float haze = min( data.z * source + pow( chord, data.x ), 1.0 );
          gl_FragColor = vec4( clamp( haze * colour, 0.0, 1.0 ), 1.0 );
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    });
    const mesh = new THREE.Mesh(sphere, mat);
    mesh.position.set(it.position[0] ?? 0, it.position[1] ?? 0, -(it.position[2] ?? 0));
    // a rotation in EVE's space, mirrored in z (as the plane sets')
    const r = it.rotation;
    mesh.quaternion.set(-(r[0] ?? 0), -(r[1] ?? 0), r[2] ?? 0, r[3] ?? 1);
    mesh.scale.set(it.scaling[0] ?? 1, it.scaling[1] ?? 1, it.scaling[2] ?? 1);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

export async function hullFx(sof: { spriteSets?: SofSpriteSet[]; planeSets?: SofPlaneSet[]; spotlightSets?: SofSpotlightSet[]; hazeSets?: SofHazeSet[] }): Promise<THREE.Group | null> {
  const points = spritePoints(sof.spriteSets ?? []);
  const planes = await planeMeshes(sof.planeSets ?? []);
  const cones = await spotlightCones(sof.spotlightSets ?? []);
  const glows = await spotlightGlows(sof.spotlightSets ?? []);
  const haze = hazeMeshes(sof.hazeSets ?? []);
  if (!points && !planes && !cones && !glows && !haze) return null;
  const group = new THREE.Group();
  group.name = "hullFx";
  if (points) group.add(points);
  if (planes) group.add(planes);
  if (cones) group.add(cones);
  if (glows) group.add(glows);
  if (haze) group.add(haze);
  return group;
}
