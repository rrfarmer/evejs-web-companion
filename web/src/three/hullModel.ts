// A type's model as the play page draws it: the hull tools/client-extract pulled from the client (asked of the dev
// server by typeID, extracted on first ask), its own textures, and its LODs switched by distance. The material is a
// first approximation of the client's quadv5 ship shader; faction colours (MaterialMap / PaintMaskMap) come with the
// SOF reader.

import { boosterGlows, setBoosterIntensity, setGlowGain, volumetricBoosters, type BoosterVolumetricData } from "./boosterVolumetric.ts";
import * as THREE from "three";
import { addDecals, type SofDecalSet } from "./hullDecals.ts";
import { hullChildren, type SofChildNode, type SofHullChild } from "./hullChildren.ts";
import type { SofController } from "./controllers.ts";
import { setGpuParticleAssets } from "./gpuParticles.ts";
import { followActivation, followClip } from "./activation.ts";
import type { SofOverlay } from "./hullOverlay.ts";
import { followDynamicLights } from "./dynamicLights.ts";
import { impactAnchor, type SofImpact } from "./impactOverlay.ts";
import { hullFx,type SofSpriteSet, type SofPlaneSet, type SofSpotlightSet, type SofHazeSet } from "./hullFx.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";
import { logDepth } from "./logDepth";
import { distortionMaterial, DISTORTION_LAYER } from "./distortion.ts";

export interface SofMaterial { name: string; diffuse: number[] | null; dust: number[] | null; fresnel: number[] | null; gloss: number | null }
export interface SofArea { kind: string; name: string; index: number; areaType: string; shader: string | null; textures: Record<string, string | null>; params: Record<string, number[] | null>; materials: (SofMaterial | null)[]; glowColor?: number[] | null; heatGlowColor?: number[] | null }
/** A hull's default pattern layer (sof.mjs): its mask texture, projection and the materials it pulls toward. */
export interface SofPatternLayer { texture: string | null; projectionU: number; projectionV: number; source: number; targets: number[]; position: number[]; scaling: number[]; rotation: number[]; mirrored: boolean }
export interface SofPattern { layers: SofPatternLayer[]; pmtl1: SofMaterial | null }
/** A pattern layer as a material draws it: its loaded mask with the hull's PMtl1. */
export interface HullPattern { layer: SofPatternLayer; mask: THREE.Texture; pmtl1: SofMaterial | null }
export interface SofBooster { glowColor: number[] | null; glowScale: number | null; haloColor: number[] | null; haloScaleX: number | null; haloScaleY: number | null; shape0Color: number[] | null; shape1Color: number[] | null; symHaloScale?: number | null; warpGlowColor?: number[] | null; warpHaloColor?: number[] | null; volumetric?: BoosterVolumetricData | null }
export interface SofHull {
  hull: string; faction: string | null; race?: string | null; booster?: SofBooster | null; pattern?: SofPattern | null; areas: SofArea[]; colorSet: Record<string, number[]> | null; boosters: { transform: number[] | null; atlasIndex0?: number; atlasIndex1?: number }[];
  /** The hull's "anchorpoint" locator, in EVE's model space (a hangar's: where its ship floats). */
  anchor?: number[] | null;
  /** Its "maxCameraDistance" locator, in EVE's model space (a hangar's farthest camera, by its length). */
  maxCameraDistance?: number[] | null;
  /** Its point lights (EveSOFDataHullLightSet items), in EVE's model space. */
  lights?: { position: number[]; radius: number | null; innerRadius: number | null; brightness: number; color: number[] | null }[];
}

/** A soft round spot, for engine glows. */
let glowTexture: THREE.Texture | null = null;
function glowSpot(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

/**
 * The hull's engines, at the SOF booster locators (EveSOFDataHullBooster items; a row-major transform whose rows 0 and
 * 1 are the flame's width and height and row 2 its length, pointing aft, and whose last row is the nozzle), coloured
 * from the race's booster data (shape colours for the flame, glowColor * glowScale for the glow). The client's flame
 * is a noise-animated shape from an atlas (EveBoosterSet2: boosterVolumetric.ts, where the race's data and textures are
 * there - `flames`); else a first likeness: two crossed additive planes fading along the flame. A glow at the nozzle
 * either way. Each flame's length and strength are set by the ship's speed (setThrust).
 */
function buildBoosters(sof: SofHull, flames: THREE.Mesh | null = null, glows: THREE.Mesh | null = null): THREE.Group | null {
  const b = sof.booster;
  if (!b || !sof.boosters.length) return null;
  const hdr = (c: number[] | null | undefined, d: number[]) => { const v = c ?? d; const m = Math.max(v[0]!, v[1]!, v[2]!, 1e-6); return new THREE.Color(v[0]! / m, v[1]! / m, v[2]! / m); };
  const flameColour = hdr(b.shape0Color, [1, 0.6, 0.3]);
  const coreColour = hdr(b.shape1Color, [1, 0.8, 0.5]);
  const group = new THREE.Group();
  group.name = "boosters";
  // EveBoosterSet2::Add: the set's bounding sphere grown over each booster's position (BoundingSphereUpdate, from
  // (0, 0, 0, 0): the points only, not their size); PadBoosterBoundingSphere: its centre moved back half its radius
  // along z, its radius doubled - kept in the group's frame (EVE's z mirrored) for the LOD test (boosterLod)
  const sphere = [0, 0, 0, 0];
  for (const item of sof.boosters) {
    const t = item.transform;
    if (!t || t.length < 16) continue;
    const d = [t[12]! - sphere[0]!, t[13]! - sphere[1]!, t[14]! - sphere[2]!];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (len <= sphere[3]!) continue;
    const k = 0.5 * (1 - sphere[3]! / len);
    sphere[0]! += k * d[0]!; sphere[1]! += k * d[1]!; sphere[2]! += k * d[2]!;
    sphere[3] = 0.5 * (sphere[3]! + len);
  }
  group.userData.boosterSphere = { x: sphere[0], y: sphere[1], z: -(sphere[2]! - 0.5 * sphere[3]!), r: 2 * sphere[3]! };
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { colour: { value: flameColour }, core: { value: coreColour } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 colour; uniform vec3 core; varying vec2 vUv;
      void main() {
        // clamped: multisampling evaluates the uv a little outside the plane, and pow() of a negative is NaN
        float across = clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0);
        float along = clamp(1.0 - vUv.y, 0.0, 1.0);
        float a = pow(across, 0.9) * pow(along, 1.4);
        vec3 c = mix(colour, core, pow(across, 6.0) * along);
        gl_FragColor = vec4(c * a * 1.4, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  logDepth(flameMat);
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.translate(0, 0.5, 0); // from the nozzle (v = 0) out along the flame
  plane.rotateX(Math.PI / 2); // along +z: aft, once mirrored
  for (const item of sof.boosters) {
    const t = item.transform;
    if (!t || t.length < 16) continue;
    const w = Math.hypot(t[0]!, t[1]!, t[2]!), h = Math.hypot(t[4]!, t[5]!, t[6]!), len = Math.hypot(t[8]!, t[9]!, t[10]!);
    const nozzle = new THREE.Group();
    nozzle.position.set(t[12]!, t[13]!, -t[14]!);
    if (!flames) {
      const flame = new THREE.Group();
      flame.name = "flame";
      // the flame spans -1..1 across the locator's width and height rows, and 0..1 along its length row
      for (const [sx, sy, rot] of [[2 * w, len, 0], [2 * h, len, Math.PI / 2]] as const) {
        const m = new THREE.Mesh(plane, flameMat);
        m.scale.set(sx, 1, sy);
        m.rotation.z = rot;
        flame.add(m);
      }
      nozzle.add(flame);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpot(), color: flameColour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(Math.max(w, h) * 2.4);
    // (the client's glow sprites where they are built: boosterGlows)
    if (!glows) nozzle.add(glow);
    group.add(nozzle);
  }
  if (flames) {
    // the flames in EVE's space (their boxes placed by the SOF transforms as they are)
    const eve = new THREE.Group();
    eve.scale.set(1, 1, -1);
    eve.add(flames);
    if (glows) eve.add(glows);
    group.add(eve);
  }
  return group;
}

/**
 * A controller variable set on a space object (EveSpaceObject2::SetControllerVariable: kept, and handed to every
 * controller of the object and its children, each taking it where it has a variable of that name; a controller started
 * later is handed the kept ones). The client's: IsWarping (ship.py EnterWarp / ExitWarp, and on load in warp).
 */
export function setControllerVariable(model: THREE.Object3D, name: string, value: number): void {
  const vars = (model.userData.controllerVars ??= {}) as Record<string, number>;
  if (vars[name] === value) return;
  vars[name] = value;
  model.userData.controllerVarsVersion = ((model.userData.controllerVarsVersion as number | undefined) ?? 0) + 1;
}

/**
 * A ship's activation strength (EveSpaceObject2: Shipdata.y and the ActivationStrength controller variable; the damage
 * overlay's flicker, impactOverlay.ts): its hull glow's strength (quadv5's GeneralGlowColor x activation x
 * GlowMap^2.4: three's emissive intensity, so the ship's glowing materials are its own copies once it is not 1 - each
 * sharing its program), its children's fx attributes (hullChildren.ts) and the controllers' variable.
 */
export function setActivationStrength(model: THREE.Object3D, impact: number): void {
  model.userData.impactActivation = impact;
  applyActivation(model);
}

/**
 * The space object's own activationStrength (EveSpaceObject2.activationStrength, set by its controllers - structure.red,
 * buildable.red and the like): EveMobile / EveStation2::PrepareShaderData multiply the impact overlay's by it.
 */
export function setOwnerActivation(model: THREE.Object3D, value: number): void {
  model.userData.ownerActivation = value;
  applyActivation(model);
}

function applyActivation(model: THREE.Object3D): void {
  const value = ((model.userData.impactActivation as number | undefined) ?? 1) * ((model.userData.ownerActivation as number | undefined) ?? 1);
  if (model.userData.activation === value) return;
  model.userData.activation = value;
  setControllerVariable(model, "ActivationStrength", value);
  if (value === 1 && !model.userData.ownGlow) return;
  model.userData.ownGlow = true;
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!mesh.isMesh || !mat || Array.isArray(mat) || !mat.isMeshStandardMaterial || !mat.emissiveMap) return;
    if (mesh.userData.glowBase === undefined) mesh.userData.glowBase = ownMaterial(mesh).emissiveIntensity;
    (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = (mesh.userData.glowBase as number) * value;
  });
}

/**
 * The mesh's own copy of its (standard) material, made once: what clone leaves - the shader changes and the per-draw
 * hook - shared, so the program is the same one. three uploads a standard material's own uniforms only when the draw's
 * material changes, so an object whose per-draw values differ from its type's other copies draws with its own.
 */
function ownMaterial(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  if (mesh.userData.ownMaterial) return mat;
  const own = mat.clone();
  own.onBeforeCompile = mat.onBeforeCompile;
  own.customProgramCacheKey = mat.customProgramCacheKey;
  own.onBeforeRender = mat.onBeforeRender;
  own.userData = mat.userData;
  mesh.material = own;
  mesh.userData.ownMaterial = true;
  return own;
}

/** The dirt level of the space object an object is part of (setDirtLevel); EVE_SPACEOBJECT_DIRT_LEVEL_DEFAULT 0. */
function dirtOf(o: THREE.Object3D): number {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (typeof p.userData.dirtLevel === "number") return p.userData.dirtLevel as number;
  return 0;
}
/** The hull material's dirt level set for each draw from the drawn object's (a dirty object draws with its own copies). */
function followDirt(material: THREE.Material, uniform: { value: number }): void {
  material.userData.followsDust = true;
  const before = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
    before.call(this, renderer, scene, camera, geometry, object, group);
    uniform.value = dirtOf(object);
  };
}

/**
 * A space object's dirt level (EveSpaceObject2.dirtLevel, shipData.z: the hull's dust layer). The client's for a ship:
 * gfxutils.CalcDirtLevelFromAge of its slim item's dirtTime, 0.7 - 1 / (weeks^0.65 + 1 / 2.7). Its dusty materials
 * become its own copies where it is not the default 0.
 */
export function setDirtLevel(object: THREE.Object3D, level: number): void {
  if (object.userData.dirtLevel === level) return;
  object.userData.dirtLevel = level;
  if (level === 0) return;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | undefined;
    if (mesh.isMesh && mat && !Array.isArray(mat) && mat.userData.followsDust) ownMaterial(mesh);
  });
}

/** CalcDirtLevelFromAge (evegraphics/utils.py): a FILETIME (100 ns since 1601) to the dirt level. */
export function dirtLevelFromTime(fileTime: bigint | number): number {
  const ms = Number((BigInt(Date.now()) + 11644473600000n) * 10000n - BigInt(fileTime)) / 10000;
  const weeks = Math.max(ms, 0) / 604800000;
  return 0.7 - 1 / (Math.pow(weeks, 0.65) + 1 / 2.7);
}

/**
 * The space object's clip spheres (EveSpaceObject2::PrepareShaderData), from its clipSphereFactor / -2 and clip sphere
 * centre (userData, hullChildren.ts; the centre 0 until a ResetClipSphereCenter) and the hull's bounding sphere (EVE's
 * model space, modelScale 1): R' = R + |c|, inside = min(1, |c| / R'), radius = factor x R' x (1 + inside), each kept
 * as its signed square; the centre c + the bounding sphere's centre. userData.clip [cx, cy, cz, r1Sq, r2Sq] (null while
 * neither factor is set: SOC_DISABLED), read per draw by the hull's materials (activation.ts followClip); its standard
 * materials become its own copies the first time it clips.
 */
export function setClipSphere(object: THREE.Object3D, model: THREE.Object3D): void {
  const f1 = (object.userData.clipSphereFactor as number | undefined) ?? 0, f2 = (object.userData.clipSphereFactor2 as number | undefined) ?? 0;
  if (f1 === 0 && f2 === 0) { object.userData.clip = null; return; }
  const bs = (model.userData.boundingSphere as number[] | null | undefined) ?? [0, 0, 0, (model.userData.radius as number | undefined) ?? 0];
  const c = (object.userData.clipSphereCenter as number[] | undefined) ?? [0, 0, 0];
  const offset = Math.hypot(c[0]!, c[1]!, c[2]!);
  const r = (bs[3] ?? 0) + offset;
  const inside = r > 0 ? Math.min(1, offset / r) : 0;
  const sq = (f: number) => { const d = f * r * (1 + inside); return Math.sign(d) * d * d; };
  object.userData.clip = [c[0]! + (bs[0] ?? 0), c[1]! + (bs[1] ?? 0), c[2]! + (bs[2] ?? 0), sq(f1), sq(f2)];
  if (object.userData.ownClip) return;
  object.userData.ownClip = true;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | undefined;
    if (mesh.isMesh && mat && !Array.isArray(mat) && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial && mat.userData.followsClip) ownMaterial(mesh);
  });
}

/**
 * A controller event sent to a space object (EveSpaceObject2::HandleControllerEvent: to every controller of it and its
 * children; the server's OnClientControllerEvent, as spaceObject.SetControllerVariableFromEvent hands it on). The
 * running controllers take each once; one started later takes none sent before it.
 */
export function sendControllerEvent(model: THREE.Object3D, name: string): void {
  const seq = ((model.userData.controllerEventSeq as number | undefined) ?? 0) + 1;
  const events = ((model.userData.controllerEvents ??= []) as { seq: number; name: string }[]);
  events.push({ seq, name });
  if (events.length > 32) events.splice(0, events.length - 32);
  model.userData.controllerEventSeq = seq;
}

/** The ship's speed and top speed (m/s), for its children's controllers (ShipSpeed(), ShipMaxSpeed()). */
export function setShipSpeed(model: THREE.Object3D, speed: number, maxSpeed: number): void {
  model.userData.shipSpeed = speed;
  model.userData.shipMaxSpeed = maxSpeed;
}

/**
 * Engines burn as the ship goes: the flames' length follows speed, as a share of the ship's top speed. With the
 * volumetric flames, their intensity as EveBoosterSet2Renderable::CalculateIntensity has it each update: the
 * acceleration (`accel`, three's world, m/s^2) along the ship's z x max(0.3, speed / top speed), clamped to 0..1 and
 * eased (x 0.2 + the last x 0.8); then the last value x 0.8 + (0.8 x speed / top speed + 0.2 x that) x 0.2, at most 2.
 * (The client starts from nought; here the first call starts at its steady value.)
 */
export function setThrust(model: THREE.Object3D, share: number, accel: THREE.Vector3 | null = null): void {
  // the heat glow's booster intensity (sofHullMaterial)
  model.userData.thrust = Math.max(0, Math.min(1, share));
  const boosters = model.getObjectByName("boosters");
  if (!boosters) return;
  const k = 0.15 + 0.85 * Math.max(0, Math.min(1, share));
  for (const nozzle of boosters.children) {
    const flame = nozzle.getObjectByName("flame");
    if (flame) flame.scale.set(1, 1, k);
  }
  // the volumetric flames: EveBoosterSet2Renderable::CalculateIntensity at a steady speed - 0.8 x speed / top speed
  // (its acceleration share, 0.2 x the thrust along the ship, not known here)
  const flames = boosters.getObjectByName("booster-volumetric");
  const warping = (model.userData.controllerVars as Record<string, number> | undefined)?.IsWarping ? 1 : 0;
  if (!flames) return;
  const ud = model.userData;
  const ratio = Math.max(0, share);
  let acc = 0;
  if (accel && flames.parent) {
    // the ship's z (its EVE axis: the flames' group, through its mirror) in the world
    const z = new THREE.Vector3(0, 0, 1).transformDirection(flames.parent.matrixWorld);
    acc = Math.min(1, Math.max(0, accel.dot(z) * Math.max(0.3, ratio)));
  }
  acc = acc * 0.2 + ((ud.boosterLastAcc as number | undefined) ?? 0) * 0.8;
  ud.boosterLastAcc = acc;
  const last = (ud.boosterLastValue as number | undefined) ?? 0.8 * ratio;
  // (alwaysOn - ship.py FitBoosters(alwaysOn=True), a drone's: m_alwaysOnIntensity, 1)
  const value = ud.boostersAlwaysOn ? 1 : Math.min(2, last * 0.8 + (0.8 * ratio + 0.2 * acc) * 0.2);
  ud.boosterLastValue = value;
  setBoosterIntensity(flames, value, warping);
  const glows = boosters.getObjectByName("booster-glows");
  if (glows) setGlowGain(glows, value, warping);
}

export interface TypeModelInfo {
  typeID: number;
  model: string | null;
  sof?: string | null;
  textures?: Record<string, Record<string, string>>;
  hull?: string | null;
  faction?: string | null;
  race?: string | null;
  error?: string;
}

/**
 * A hull area as the client's quadv5 ship shader colours it (graphics/effect.dx11/.../v5/quad/quadv5.sm_hi, its
 * forward pass disassembled, client 3396210), on three's standard material:
 * - the MaterialMap (one channel) weighs the faction's four materials for the area (EveSOF areaTypes material1..4):
 *   w_i = saturate(1.031915 - |m - i/3| * 3.191489);
 * - d = PaintMaskMap.r x GeneralData.x (the area's, else (1, 0, 0, 0); no PaintMaskMap, nought) pulls the three
 *   below toward a bare surface: the tint toward white, the specular toward (0.038384, 0.039352, 0.039165), the gloss
 *   toward 0.4;
 * - the base colour is the albedo times the weighed DiffuseColor (linear, no other factor);
 * - the specular colour at normal incidence is the weighed FresnelColor itself: a specular workflow, not a metal one;
 * - the roughness is 1 - RoughnessMap.r * the weighed Gloss (the map is read as a gloss), squared for the lobe as
 *   three squares it;
 * - the normal: NormalMap.xy + 0.002, x 2 - 1, on the tangent frame with z 1 (T x + B y + N, normalised);
 * - quaddetailv5 (its record 0, fxres.py) adds three tiled detail maps: Detail1..3Map at uv x DetailNData.x +
 *   DetailNData.zw (+ 0.002 on x and y), their alphas x DetailNData.y summed and saturated, times s = DetailSelector .
 *   the material weights: a; the tint and the specular pulled toward DetailAlbedoColor and DetailFresnelColor by a
 *   (before the bare surface's pull); the normals' sum (each x 2 - 1) x s added to the normal map's before the frame;
 * - quadheatdetailv5 (its record 0) is quadheatv5's heat glow with that detail layer, its third detail Detail2Map read
 *   again at SecondaryDetail2Data's tiling and offset, weighed by Detail3Data.y;
 * - quadwreckv5 (its record 0), a wreck: the glow times a flicker - GlowMap.r at the uv stepped to fifteenths and
 *   pushed outward along it by WreckFactors.w x time, ^1.2 = g; sat(-z) (1 - z g) + z g for z WreckFactors.z - and the
 *   whole lit colour then burnt toward WreckColor x a, a AlphaThresholdMap (sRGB) at uv x WreckFactors.x: mixed by
 *   sat(a.r + the vertex colour's red)^WreckFactors.y;
 * - quadglassv5 in a transparent area (its SOT_TRANSPARENT record 16: two passes, back faces then front, the
 *   transparent batch's alpha blend): no albedo and no diffuse light - the sun's specular and the environment's
 *   reflection on the weighed FresnelColor and gloss (no bare-surface pull), plus an unlit tint, the weighed
 *   DiffuseColor x P x (1 - 0.75 |N . V|) for P = PaintMaskMap.r, plus the glow; that sRGB-encoded as c, written
 *   mix(c / (1.01 - P), c, the first material's weight) at alpha 1 - P.
 * The pattern layers are not drawn yet.
 */
/** The hull shaders' texture parameters by the role sofHullMaterial takes them in. */
export const HULL_TEXTURE_ROLES: Record<string, string> = { AlbedoMap: "albedo", NormalMap: "normal", RoughnessMap: "roughness", MaterialMap: "materialMap", GlowMap: "glow", DirtMap: "dirt", DustNoiseMap: "dustNoise", PaintMaskMap: "paintMask", SailsDetailMap: "sailsDetail", HeatGlowNoiseMap: "heatNoise", Detail1Map: "detail1", Detail2Map: "detail2", Detail3Map: "detail3", AlphaThresholdMap: "alphaThreshold", Layer1Map: "layer1", Layer2Map: "layer2", LayerMaskMap: "layerMask", DistortionMap: "distortion", OilFilmLookupMap: "oilFilm" };

/**
 * A hull area drawn with fx/fxv5.fx or fx/fxdirectionalv5.fx (their record 0, fxres.py; the same pixel stage):
 * Layer1Map at uv x Layer1Transform.xy + .zw + Layer1Scroll.xy x time + .zw, times the ship's activation strength
 * (activation.ts: its damage flicker), times Layer2Map likewise, times LayerMaskMap at the uv, times BaseColor; the colour times the fresnel (as
 * ubershader.fx's), alpha as it is. fxdirectionalv5's uv is the mesh's position in EVE's space, scaled by the world
 * transform's axis lengths, dotted with DirectionU and DirectionV (each times its .w). fxv5 blends ONE/ONE itself;
 * fxdirectionalv5 sets nothing: its batch's preset (additive ONE/ONE, transparent alpha). Culling: neither sets one,
 * so the batch's (additive none, transparent CW: FrontSide). Defaults from the files: FresnelFactors (1, 1, 0, 0),
 * transforms and scrolls (1, 1, 0, 0), BaseColor 1, DirectionU (1, 0, 0, 1), DirectionV (0, 1, 0, 1).
 */
export function fxHullMaterial(area: SofArea, maps: Record<string, THREE.Texture | undefined>): THREE.ShaderMaterial {
  const directional = /fxdirectionalv5/i.test(area.shader ?? "");
  const p = area.params;
  const v4 = (a: number[] | null | undefined, d: number[]) => new THREE.Vector4(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2], a?.[3] ?? d[3]);
  for (const t of [maps.layer1, maps.layer2, maps.layerMask]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const additive = !directional || area.kind === "additive";
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      fresnel: { value: v4(p.FresnelFactors, [1, 1, 0, 0]) }, base: { value: v4(p.BaseColor, [1, 1, 1, 1]) },
      t1: { value: v4(p.Layer1Transform, [1, 1, 0, 0]) }, t2: { value: v4(p.Layer2Transform, [1, 1, 0, 0]) },
      s1: { value: v4(p.Layer1Scroll, [1, 1, 0, 0]) }, s2: { value: v4(p.Layer2Scroll, [1, 1, 0, 0]) },
      dirU: { value: v4(p.DirectionU, [1, 0, 0, 1]) }, dirV: { value: v4(p.DirectionV, [0, 1, 0, 1]) },
      time: heatClock,
      layer1: { value: maps.layer1 ?? null }, layer2: { value: maps.layer2 ?? null }, layerMask: { value: maps.layerMask ?? null },
    },
    vertexShader: `uniform vec4 dirU; uniform vec4 dirV; varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        ${directional ? `vec3 sc = vec3( length( modelMatrix[0].xyz ), length( modelMatrix[1].xyz ), length( modelMatrix[2].xyz ) );
        vec3 pe = vec3( position.x, position.y, -position.z ) * sc;
        vUv = vec2( dot( dirU.xyz, pe ) * dirU.w, dot( dirV.xyz, pe ) * dirV.w );` : "vUv = uv;"}
        vN = mat3( modelMatrix ) * normal;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vFromEye = ( vec4( mv.xyz, 0.0 ) * viewMatrix ).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec4 fresnel; uniform vec4 base; uniform vec4 t1; uniform vec4 t2; uniform vec4 s1; uniform vec4 s2; uniform float time; uniform float activation;
      uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D layerMask;
      varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        float f = pow( 1.0 - clamp( dot( normalize( -vFromEye ), normalize( vN ) ) - fresnel.z, 0.0, 1.0 ), fresnel.x );
        f = fresnel.y < 0.0 ? ( 1.0 - min( f, 1.0 ) ) * -fresnel.y : f * fresnel.y;
        vec4 c = texture2D( layer1, vUv * t1.xy + t1.zw + s1.xy * time + s1.zw )
          * texture2D( layer2, vUv * t2.xy + t2.zw + s2.xy * time + s2.zw )
          * texture2D( layerMask, vUv ) * base * activation;
        gl_FragColor = vec4( c.rgb * f, c.a );
      }`,
    transparent: true, depthWrite: false,
    side: area.kind === "additive" ? THREE.DoubleSide : THREE.FrontSide,
    ...(additive
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  logDepth(mat);
  return followClip(followActivation(mat));
}

/** The engines' share of full thrust a hull model shows (setThrust), for its heat glow; 0 unset (a station). */
function thrustOf(o: THREE.Object3D): number {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (typeof p.userData.thrust === "number") return p.userData.thrust as number;
  return 0;
}
const heatClock = { get value() { return performance.now() / 1000; } };

export function sofHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: SofArea, pattern: HullPattern | null = null): THREE.MeshStandardMaterial {
  // the glow (quadv5.sm_hi): GeneralGlowColor x the ship's activation strength (1) x GlowMap.r^2.4, added
  const m = eveHullMaterial(maps, area.name, true, { color: area.glowColor ?? [1, 1, 1], power: 2.4 });
  m.metalness = 0;
  // quadsailsv5's sails weave; quadglassv5 draws both faces (its normal turned for the back one).
  const sails = /sails/i.test(area.shader ?? "") && !!maps.sailsDetail;
  if (/glass/i.test(area.shader ?? "")) m.side = THREE.DoubleSide;
  if (maps.sailsDetail) { maps.sailsDetail.wrapS = maps.sailsDetail.wrapT = THREE.RepeatWrapping; maps.sailsDetail.needsUpdate = true; }
  const mats = [0, 1, 2, 3].map((i) => area.materials[i] ?? null);
  const v3 = (a: number[] | null | undefined, d: number) => new THREE.Vector3(a?.[0] ?? d, a?.[1] ?? d, a?.[2] ?? d);
  // quadheatv5.sm_hi (record 0, disassembled; fxres.py): no GeneralGlowColor; its glow is the heat glow: H the
  // weighed Mtl1..4HeatGlowData (default (1, 0, 0, 0)); HeatGlowNoiseMap read at (uv + H.y x time) x H.z (.xy) and at
  // (uv - H.y x time) x H.z (.zx), multiplied, - 0.5: an offset; w = sat(1 + H.x x (sat((thrust - 0.005) x 66.67) - 1))
  // for thrust the ship's booster intensity (EveShip2's shipData.x; a station's 0); GlowMap read at uv + H.w x w x the
  // offset, ^2.4, x the activation strength (1) x w x GeneralHeatGlowColor. (H.x 1: a glow that burns only under
  // thrust.)
  const heat = /quadheat(detail)?v5/i.test(area.shader ?? "") && !!maps.glow;
  const heatDetail = /quadheatdetailv5/i.test(area.shader ?? "");
  const glass = /quadglassv5/i.test(area.shader ?? "") && area.kind === "transparent";
  // (its albedo stays bound for the uv the material map is read at; the tint of nought takes it out of the light)
  if (glass) { m.transparent = true; m.depthWrite = false; }
  const wreck = /quadwreckv5/i.test(area.shader ?? "") && !!maps.alphaThreshold;
  if (wreck) {
    maps.alphaThreshold!.colorSpace = THREE.SRGBColorSpace;
    maps.alphaThreshold!.wrapS = maps.alphaThreshold!.wrapT = THREE.RepeatWrapping;
    maps.alphaThreshold!.needsUpdate = true;
  }
  const v4 = (a: number[] | null | undefined, d: number[]) => new THREE.Vector4(a?.[0] ?? d[0], a?.[1] ?? d[1], a?.[2] ?? d[2], a?.[3] ?? d[3]);
  // quadenvironmentv5 (its record 0, fxres.py): every map but MaterialMap read at uv x GeneralTiling.y, MaterialMap at
  // uv x GeneralTiling.x; no PaintMaskMap (no bare surface); two tiled details, Detail1Map at uv x DetailData.x and
  // Detail2Map at uv x DetailData.y, each weighed by w = DetailNMaterial . the material weights: its normal (x 2 - 1)
  // x w added to the normal map's, and the tint and the specular pulled toward DetailNAlbedoColor and
  // DetailNFresnelColor by its alpha x sat(w), the first then the second.
  const env = /quadenvironmentv5/i.test(area.shader ?? "") && !!(maps.detail1 && maps.detail2);
  if (env) for (const t of [maps.detail1, maps.detail2]) { t!.wrapS = t!.wrapT = THREE.RepeatWrapping; t!.needsUpdate = true; }
  // quadoilv5 (its record 0): quadv5 with an oil film added to the lit colour: OilFilmLookupMap (sRGB, wrapping) at
  // (0.7 (n.x + n.y) + 3 / c, 0.5), its mip level 1 / c, for n the normal map's x and y (+ 0.002, x 2 - 1) and c =
  // clamp(N . V, 0.001, 1); times 0.02 (2 - sqrt c), sat(R . L x 0.5 + 0.5)^16 (R the eye's reflection about N, L the
  // way to the sun), RoughnessMap.r and the sun's shadow. (The client turns R by the environment map's rotation
  // first and has a shadow map: neither here.)
  const oil = /quadoilv5/i.test(area.shader ?? "") && !!maps.oilFilm && !!maps.normal && !!maps.roughness;
  if (oil) { maps.oilFilm!.colorSpace = THREE.SRGBColorSpace; maps.oilFilm!.wrapS = maps.oilFilm!.wrapT = THREE.RepeatWrapping; maps.oilFilm!.needsUpdate = true; }
  // the pattern layer (quadv5's SOPPT_ENABLED permutation, record 4, fxres.py; EveCustomMask::FillPerObjectData): the
  // mesh's position in EVE's model space (x made |x| where the projection is mirrored) through the inverse of the
  // projection's scaling, rotation and translation; its y and z, + 1, / 2, the uv PatternMask1Map's red is read at
  // (clamped to [0, 1] on an axis of the clamp type; nought off it on a border one). That x the layer's target
  // weights pulls each of the four materials' diffuse colour, fresnel colour and gloss toward the source material's
  // (Mtl1..4, or PMtl1: the hull's pattern material) before they are weighed.
  const patternUniforms = (() => {
    if (!pattern) return null;
    const l = pattern.layer;
    const wrapOf = (mode: number) => (mode === 0 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping);
    pattern.mask.wrapS = wrapOf(l.projectionU); pattern.mask.wrapT = wrapOf(l.projectionV); pattern.mask.needsUpdate = true;
    const src = l.source < 4 ? mats[l.source] ?? null : l.source === 4 ? pattern.pmtl1 : null;
    const pick = (k: string, fromMat: number[] | null | undefined, d: number) => v3((l.source === 4 ? area.params[`PMtl1${k}`] : null) ?? fromMat, d);
    return {
      patMask: { value: pattern.mask },
      patPos: { value: new THREE.Vector3(...(l.position as [number, number, number])) },
      patScale: { value: new THREE.Vector3(...(l.scaling as [number, number, number])) },
      patRot: { value: new THREE.Vector4(...(l.rotation as [number, number, number, number])) },
      patMirror: { value: l.mirrored ? 1 : 0 },
      patModes: { value: new THREE.Vector2(l.projectionU, l.projectionV) },
      patTargets: { value: new THREE.Vector4(...(l.targets as [number, number, number, number])) },
      // a source the hull's data leaves unsaid reads the shader's defaults (1, 1, 0.4)
      patDiffuse: { value: pick("DiffuseColor", src?.diffuse, 1) },
      patFresnel: { value: pick("FresnelColor", src?.fresnel, 1) },
      patGloss: { value: (l.source === 4 ? area.params.PMtl1Gloss?.[0] : null) ?? src?.gloss ?? 0.4 },
    };
  })();
  const heatUniforms = {
    heatData: { value: [1, 2, 3, 4].map((i) => v4(area.params[`Mtl${i}HeatGlowData`], [1, 0, 0, 0])) },
    heatColor: { value: v3(area.heatGlowColor ?? null, 1) },
    heatNoise: { value: maps.heatNoise ?? null },
    heatTime: heatClock,
    thrust: { value: 0 },
  };
  if (heat) {
    if (maps.heatNoise) { maps.heatNoise.wrapS = maps.heatNoise.wrapT = THREE.RepeatWrapping; maps.heatNoise.needsUpdate = true; }
    m.onBeforeRender = (_r, _s, _c, _g, object) => {
      const t = thrustOf(object);
      // (uploaded with the material, once a frame where it is first drawn: a model's clones, one type's ships, share it)
      heatUniforms.thrust.value = t;
    };
  }
  // the dust layer (quadv5.sm_depth, the client's high quality; fxres.py): a second lighting of the surface with the
  // dust's material - albedo x the weighed Mtl1..4DustDiffuseColor x (n.x + 0.5), specular (0.019, 0.017, 0.014) x
  // (n.y + 0.5), roughness 1 - 0.4 x RoughnessMap.r x (n.z + 0.5) - for n DustNoiseMap at uv x 20; the two mixed as
  // clean x (1 - x)^3 + dust x x, x = sat(DirtMap.r x (n.w + 0.5) / (1 - dirtLevel)) (shipData.z: the space object's
  // dirtLevel, 0 unless set - a ship's from its age, setDirtLevel)
  const dust = !!(maps.dirt && maps.dustNoise) && !/glass/i.test(area.shader ?? "");
  if (dust) { maps.dustNoise!.wrapS = maps.dustNoise!.wrapT = THREE.RepeatWrapping; maps.dustNoise!.needsUpdate = true; }
  const dirtLevel = { value: 0 };
  const uniforms = {
    mtlDust: { value: mats.map((x) => v3(x?.dust, 1)) }, dirtMap: { value: maps.dirt ?? null }, dustNoise: { value: maps.dustNoise ?? null }, dirtLevel,
    mtlDiffuse: { value: mats.map((x) => v3(x?.diffuse, 0.05)) },
    mtlFresnel: { value: mats.map((x) => v3(x?.fresnel, 0.04)) },
    mtlGloss: { value: mats.map((x) => x?.gloss ?? 0.4) },
    materialMap: { value: maps.materialMap ?? null },
    sailsDetailMap: { value: maps.sailsDetail ?? null },
    sailsDetailData: { value: v3(area.params.SailsDetailData, 0) },
    paintMask: { value: maps.paintMask ?? null },
    generalData: { value: v4(area.params.GeneralData, [1, 0, 0, 0]) },
    detail1: { value: maps.detail1 ?? null }, detail2: { value: maps.detail2 ?? null }, detail3: { value: (heatDetail ? maps.detail2 : maps.detail3) ?? null },
    // quadheatdetailv5 (its record 0) reads its third detail from Detail2Map again, at SecondaryDetail2Data's tiling
    // and offset, weighed by Detail3Data.y
    detailData: { value: heatDetail
      ? [v4(area.params.Detail1Data, [1, 1, 0, 0]), v4(area.params.Detail2Data, [1, 1, 0, 0]),
        (() => { const s2 = v4(area.params.SecondaryDetail2Data, [1, 1, 0, 0]); return new THREE.Vector4(s2.x, v4(area.params.Detail3Data, [1, 1, 0, 0]).y, s2.z, s2.w); })()]
      : [1, 2, 3].map((i) => v4(area.params[`Detail${i}Data`], [1, 1, 0, 0])) },
    detailAlbedo: { value: v3(area.params.DetailAlbedoColor, 0) },
    detailFresnel: { value: v3(area.params.DetailFresnelColor, 0) },
    detailSelector: { value: v4(area.params.DetailSelector, [1, 1, 1, 1]) },
    wreckColor: { value: v3(area.params.WreckColor, 0) },
    wreckFactors: { value: v4(area.params.WreckFactors, [1, 1, 0, 0]) },
    wreckTime: heatClock,
    alphaThreshold: { value: maps.alphaThreshold ?? null },
    envTiling: { value: v4(area.params.GeneralTiling, [1, 1, 0, 0]) },
    envDetail: { value: v4(area.params.DetailData, [1, 1, 1, 1]) },
    envMtl1: { value: v4(area.params.Detail1Material, [0, 0, 0, 0]) }, envMtl2: { value: v4(area.params.Detail2Material, [0, 0, 0, 0]) },
    envAlbedo1: { value: v3(area.params.Detail1AlbedoColor, 0) }, envAlbedo2: { value: v3(area.params.Detail2AlbedoColor, 0) },
    envFresnel1: { value: v3(area.params.Detail1FresnelColor, 0) }, envFresnel2: { value: v3(area.params.Detail2FresnelColor, 0) },
    oilFilm: { value: maps.oilFilm ?? null },
  };
  // the detail maps tile (the shader reads every texture through its wrapping sampler)
  const detail = (/quaddetailv5/i.test(area.shader ?? "") && !!(maps.detail1 && maps.detail2 && maps.detail3)) || (heatDetail && !!(maps.detail1 && maps.detail2));
  if (detail) for (const t of [maps.detail1, maps.detail2, maps.detail3]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, uniforms, heat ? heatUniforms : {}, patternUniforms ?? {});
    // inserted beside the chunk names first; the base then writes the chunks out and fixes the channels in them
    shader.fragmentShader = `${dust ? "#define HULL_DUST\nuniform vec3 mtlDust[4]; uniform sampler2D dirtMap; uniform sampler2D dustNoise; uniform float dirtLevel;\n" : ""}uniform vec3 mtlDiffuse[4]; uniform vec3 mtlFresnel[4]; uniform float mtlGloss[4]; uniform sampler2D materialMap; uniform sampler2D sailsDetailMap; uniform vec3 sailsDetailData; uniform sampler2D paintMask; uniform vec4 generalData; uniform sampler2D detail1; uniform sampler2D detail2; uniform sampler2D detail3; uniform vec4 detailData[3]; uniform vec3 detailAlbedo; uniform vec3 detailFresnel; uniform vec4 detailSelector; uniform vec3 wreckColor; uniform vec4 wreckFactors; uniform float wreckTime; uniform sampler2D alphaThreshold; uniform vec4 envTiling; uniform vec4 envDetail; uniform vec4 envMtl1; uniform vec4 envMtl2; uniform vec3 envAlbedo1; uniform vec3 envAlbedo2; uniform vec3 envFresnel1; uniform vec3 envFresnel2; uniform sampler2D oilFilm;${wreck ? " varying float vWreckV;" : ""}${patternUniforms ? " uniform sampler2D patMask; uniform vec2 patModes; uniform vec4 patTargets; uniform vec3 patDiffuse; uniform vec3 patFresnel; uniform float patGloss; varying vec2 vPatUv;" : ""}${env ? " varying vec2 vEnvUv;" : ""}
${shader.fragmentShader}`
      .replace("#include <map_fragment>", `#include <map_fragment>
        float mtlSel = texture2D( materialMap, ${env ? "vEnvUv * envTiling.x" : "vMapUv"} ).r;
        ${sails ? `// quadsailsv5: where the map picks the first material, the sail's weave (SailsDetailMap, tiled by
        // SailsDetailData.x and turned by .y radians) picks among the four instead.
        float sailW = clamp( 1.031915 - abs( mtlSel * 3.191489 ), 0.0, 1.0 );
        vec2 sailUv = vMapUv * sailsDetailData.x;
        float sc = cos( sailsDetailData.y ), ss = sin( sailsDetailData.y );
        sailUv = vec2( sc * sailUv.x - ss * sailUv.y, ss * sailUv.x + sc * sailUv.y );
        mtlSel = mix( mtlSel, texture2D( sailsDetailMap, sailUv ).r, sailW );` : ""}
        vec4 mtlW = clamp( 1.031915 - abs( vec4( mtlSel ) - vec4( 0.0, 0.333333, 0.666667, 1.0 ) ) * 3.191489, 0.0, 1.0 );
        ${patternUniforms ? `vec2 patUv = vPatUv;
        if ( patModes.x == 1.0 ) patUv.x = clamp( patUv.x, 0.0, 1.0 );
        if ( patModes.y == 1.0 ) patUv.y = clamp( patUv.y, 0.0, 1.0 );
        bool patOff = ( patModes.x == 2.0 && ( patUv.x < 0.0 || patUv.x > 1.0 ) ) || ( patModes.y == 2.0 && ( patUv.y < 0.0 || patUv.y > 1.0 ) );
        vec4 patT = ( patOff ? 0.0 : texture2D( patMask, patUv ).r ) * patTargets;
        vec3 patD0 = mix( mtlDiffuse[0], patDiffuse, patT.x ), patD1 = mix( mtlDiffuse[1], patDiffuse, patT.y ), patD2 = mix( mtlDiffuse[2], patDiffuse, patT.z ), patD3 = mix( mtlDiffuse[3], patDiffuse, patT.w );
        vec3 patF0 = mix( mtlFresnel[0], patFresnel, patT.x ), patF1 = mix( mtlFresnel[1], patFresnel, patT.y ), patF2 = mix( mtlFresnel[2], patFresnel, patT.z ), patF3 = mix( mtlFresnel[3], patFresnel, patT.w );
        vec4 patG = mix( vec4( mtlGloss[0], mtlGloss[1], mtlGloss[2], mtlGloss[3] ), vec4( patGloss ), patT );
        vec3 mtlTint = patD0 * mtlW.x + patD1 * mtlW.y + patD2 * mtlW.z + patD3 * mtlW.w;
        float mtlGl = dot( patG, mtlW );
        vec3 mtlFr = patF0 * mtlW.x + patF1 * mtlW.y + patF2 * mtlW.z + patF3 * mtlW.w;` : `vec3 mtlTint = mtlDiffuse[0] * mtlW.x + mtlDiffuse[1] * mtlW.y + mtlDiffuse[2] * mtlW.z + mtlDiffuse[3] * mtlW.w;
        float mtlGl = mtlGloss[0] * mtlW.x + mtlGloss[1] * mtlW.y + mtlGloss[2] * mtlW.z + mtlGloss[3] * mtlW.w;
        vec3 mtlFr = mtlFresnel[0] * mtlW.x + mtlFresnel[1] * mtlW.y + mtlFresnel[2] * mtlW.z + mtlFresnel[3] * mtlW.w;`}
        ${detail ? `vec4 det1 = texture2D( detail1, vMapUv * detailData[0].x + detailData[0].zw ) + vec4( 0.002, 0.002, 0.0, 0.0 );
        vec4 det2 = texture2D( detail2, vMapUv * detailData[1].x + detailData[1].zw ) + vec4( 0.002, 0.002, 0.0, 0.0 );
        vec4 det3 = texture2D( detail3, vMapUv * detailData[2].x + detailData[2].zw ) + vec4( 0.002, 0.002, 0.0, 0.0 );
        float detSel = dot( detailSelector, mtlW );
        float detA = clamp( det1.w * detailData[0].y + det2.w * detailData[1].y + det3.w * detailData[2].y, 0.0, 1.0 ) * detSel;
        vec3 detN = ( det1.xyz * 2.0 - 1.0 + det2.xyz * 2.0 - 1.0 + det3.xyz * 2.0 - 1.0 ) * detSel;
        mtlTint = mix( mtlTint, detailAlbedo, detA );
        mtlFr = mix( mtlFr, detailFresnel, detA );` : ""}
        ${env ? `vec4 envD1 = texture2D( detail1, vEnvUv * envDetail.x );
        vec4 envD2 = texture2D( detail2, vEnvUv * envDetail.y );
        float envW1 = dot( envMtl1, mtlW ), envW2 = dot( envMtl2, mtlW );
        vec3 envN = ( envD1.xyz * 2.0 - 1.0 ) * envW1 + ( envD2.xyz * 2.0 - 1.0 ) * envW2;
        float envA1 = envD1.w * clamp( envW1, 0.0, 1.0 ), envA2 = envD2.w * clamp( envW2, 0.0, 1.0 );
        mtlFr = mix( mix( mtlFr, envFresnel1, envA1 ), envFresnel2, envA2 );
        mtlTint = mix( mix( mtlTint, envAlbedo1, envA1 ), envAlbedo2, envA2 );` : ""}
        ${glass ? `float glassP = ${maps.paintMask ? "texture2D( paintMask, vMapUv ).r" : "0.0"};
        vec3 glassTint = mtlTint * glassP;
        mtlTint = vec3( 0.0 );
        float bareD = 0.0;` : maps.paintMask && !env ? "float bareD = texture2D( paintMask, vMapUv ).r * generalData.x;" : "float bareD = 0.0;"}
        mtlTint = mix( mtlTint, vec3( 1.0 ), bareD );
        mtlFr = mix( mtlFr, vec3( 0.038384, 0.039352, 0.039165 ), bareD );
        diffuseColor.rgb *= mtlTint;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = clamp( 1.0 - mix( roughnessFactor * mtlGl, 0.4, bareD ), 0.0, 1.0 );`)
      .replace("#include <opaque_fragment>", glass ? `outgoingLight += glassTint * ( 1.0 - 0.75 * abs( dot( normal, normalize( vViewPosition ) ) ) );
        vec3 glassC = mix( outgoingLight * 12.92, 1.055 * pow( max( outgoingLight, 0.0 ), vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), outgoingLight ) );
        outgoingLight = mix( glassC / ( 1.01 - glassP ), glassC, mtlW.x );
        diffuseColor.a = 1.0 - glassP;
        #include <opaque_fragment>` : wreck ? `vec3 wreckA = texture2D( alphaThreshold, vMapUv * wreckFactors.x ).rgb;
        outgoingLight = mix( wreckColor * wreckA, outgoingLight, pow( clamp( wreckA.r + vWreckV, 0.0, 1.0 ), wreckFactors.y ) );
        #include <opaque_fragment>` : oil ? `float oilC = clamp( dot( normal, normalize( vViewPosition ) ), 0.001, 1.0 );
        vec2 oilN = ( texture2D( normalMap, vNormalMapUv ).xy + 0.002 ) * 2.0 - 1.0;
        float oilS = 0.0;
        #if NUM_DIR_LIGHTS > 0
        oilS = pow( clamp( dot( reflect( -normalize( vViewPosition ), normal ), directionalLights[ 0 ].direction ) * 0.5 + 0.5, 0.0, 1.0 ), 16.0 );
        #endif
        outgoingLight += textureLod( oilFilm, vec2( ( oilN.x + oilN.y ) * 0.7 + 3.0 / oilC, 0.5 ), 1.0 / oilC ).rgb
          * ( 2.0 - sqrt( oilC ) ) * 0.02 * oilS * texture2D( roughnessMap, vRoughnessMapUv ).r;
        #include <opaque_fragment>` : "#include <opaque_fragment>")
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        material.specularColor = mtlFr;
        material.specularColorBlended = mtlFr;`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        #ifdef HULL_DUST
        {
          vec4 dustN = texture2D( dustNoise, vMapUv * 20.0 ) + 0.5;
          float dustX = clamp( texture2D( dirtMap, vMapUv ).x * dustN.w / ( 1.0 - dirtLevel ), 0.0, 1.0 );
          if ( dustX > 0.0 ) {
            PhysicalMaterial dustM = material;
            vec3 dustAlbedo = vec3( 1.0 );
            #ifdef USE_MAP
            dustAlbedo = texture2D( map, vMapUv ).rgb;
            #endif
            float dustRough = 1.0;
            #ifdef USE_ROUGHNESSMAP
            dustRough = texture2D( roughnessMap, vRoughnessMapUv ).r;
            #endif
            dustM.diffuseColor = dustAlbedo * ( mtlDust[ 0 ] * mtlW.x + mtlDust[ 1 ] * mtlW.y + mtlDust[ 2 ] * mtlW.z + mtlDust[ 3 ] * mtlW.w ) * dustN.x;
            dustM.specularColor = vec3( 0.019, 0.017, 0.014 ) * dustN.y;
            dustM.specularColorBlended = dustM.specularColor;
            dustM.roughness = max( clamp( 1.0 - 0.4 * dustRough * dustN.z, 0.0, 1.0 ), 0.0525 );
            ReflectedLight cleanLight = reflectedLight;
            ReflectedLight dustLight;
            {
              PhysicalMaterial material = dustM;
              ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
              #include <lights_fragment_begin>
              #ifdef DYN_LIGHTS
              DYN_LIGHTS_LOOP
              #endif
              #include <lights_fragment_maps>
              #include <lights_fragment_end>
              dustLight = reflectedLight;
            }
            float dustC = pow( 1.0 - dustX, 3.0 );
            reflectedLight.directDiffuse = cleanLight.directDiffuse * dustC + dustLight.directDiffuse * dustX;
            reflectedLight.directSpecular = cleanLight.directSpecular * dustC + dustLight.directSpecular * dustX;
            reflectedLight.indirectDiffuse = cleanLight.indirectDiffuse * dustC + dustLight.indirectDiffuse * dustX;
            reflectedLight.indirectSpecular = cleanLight.indirectSpecular * dustC + dustLight.indirectSpecular * dustX;
          }
        }
        #endif`);
    if (patternUniforms) {
      shader.vertexShader = `uniform vec3 patPos; uniform vec3 patScale; uniform vec4 patRot; uniform float patMirror; varying vec2 vPatUv;
${shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
  {
    vec3 patP = vec3( position.x, position.y, -position.z );
    if ( patMirror > 0.5 ) patP.x = abs( patP.x );
    patP -= patPos;
    vec3 patQ = -patRot.xyz;
    vec3 patC = 2.0 * cross( patQ, patP );
    patP += patRot.w * patC + cross( patQ, patC );
    vPatUv = ( patP.yz / patScale.yz + 1.0 ) * 0.5;
  }`)}`;
    }
    if (env) {
      shader.vertexShader = `uniform vec4 envTiling; varying vec2 vEnvUv;
${shader.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
  vEnvUv = uv;
  #ifdef USE_MAP
  vMapUv *= envTiling.y;
  #endif
  #ifdef USE_NORMALMAP
  vNormalMapUv *= envTiling.y;
  #endif
  #ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv *= envTiling.y;
  #endif
  #ifdef USE_EMISSIVEMAP
  vEmissiveMapUv *= envTiling.y;
  #endif`)}`;
    }
    if (wreck) {
      shader.vertexShader = `attribute vec4 color; varying float vWreckV;
${shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vWreckV = color.x;")}`;
    }
    base.call(m, shader, renderer);
    if (wreck) shader.fragmentShader = change(shader.fragmentShader, "totalEmissiveRadiance *= vec3( pow( emissiveColor.r, 2.4 ) );", `vec2 wreckQ = floor( vEmissiveMapUv * 15.0 ) * 0.066667;
        float wreckL = length( wreckQ );
        float wreckG = pow( texture2D( emissiveMap, wreckQ + ( wreckL > 0.0 ? wreckQ / wreckL : vec2( 0.0 ) ) * wreckFactors.w * wreckTime ).r, 1.2 );
        totalEmissiveRadiance *= vec3( ( clamp( -wreckFactors.z, 0.0, 1.0 ) * ( 1.0 - wreckFactors.z * wreckG ) + wreckFactors.z * wreckG ) * pow( emissiveColor.r, 2.4 ) );`);
    // the details' normals join the normal map's, in its tangent space and its green's sense
    if (detail) shader.fragmentShader = change(shader.fragmentShader, "mapN.z = 1.0; // quadv5: T x + B y + N, normalised (no z rebuilt from x and y)",
      "mapN.z = 1.0; mapN += vec3( detN.x, -detN.y, detN.z );");
    if (env) shader.fragmentShader = change(shader.fragmentShader, "mapN.z = 1.0; // quadv5: T x + B y + N, normalised (no z rebuilt from x and y)",
      "mapN.z = 1.0; mapN += vec3( envN.x, -envN.y, envN.z );");
    if (heat) {
      shader.fragmentShader = `uniform vec4 heatData[4]; uniform vec3 heatColor; uniform sampler2D heatNoise; uniform float heatTime; uniform float thrust;
${change(change(shader.fragmentShader, "vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );", `vec4 heatH = heatData[0] * mtlW.x + heatData[1] * mtlW.y + heatData[2] * mtlW.z + heatData[3] * mtlW.w;
        vec2 heatN = texture2D( heatNoise, ( vEmissiveMapUv + heatH.y * heatTime ) * heatH.z ).xy * texture2D( heatNoise, ( vEmissiveMapUv - heatH.y * heatTime ) * heatH.z ).zx - 0.5;
        float heatW = clamp( 1.0 + heatH.x * ( clamp( ( thrust - 0.005 ) * 66.666672, 0.0, 1.0 ) - 1.0 ), 0.0, 1.0 );
        vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv + heatH.w * heatW * heatN );`),
        "totalEmissiveRadiance *= vec3( pow( emissiveColor.r, 2.4 ) );", "totalEmissiveRadiance = heatColor * heatW * pow( emissiveColor.r, 2.4 );")}`;
    }
  };
  followClip(m);
  followDynamicLights(m);
  if (dust) followDirt(m, dirtLevel);
  m.customProgramCacheKey = () => `sofHull5cl${dust ? "u" : ""}${sails ? "s" : ""}${heat ? "h" : ""}${maps.paintMask ? "p" : ""}${detail ? "d" : ""}${wreck ? "w" : ""}${glass ? "g" : ""}${env ? "e" : ""}${oil ? "o" : ""}${patternUniforms ? "t" : ""}`;
  return m;
}

/** three's #include chunks written out, so the lines inside them can be changed (onBeforeCompile sees them unexpanded). */
function resolveIncludes(src: string): string {
  return src.replace(/^[ 	]*#include +<([\w.]+)>/gm, (_m, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
    if (chunk === undefined) throw new Error(`no shader chunk ${name}`);
    return resolveIncludes(chunk);
  });
}

/** A shader change that must find its line: one that finds nothing says so, rather than leaving the shader as it was. */
function change(src: string, from: string, to: string): string {
  if (!src.includes(from)) console.warn(`hull shader: "${from.slice(0, 60)}" not found; three's shader chunks have changed`);
  return src.replace(from, to);
}

/** The client's channel layout on three's standard material: BC5 normal (z rebuilt), BC4 roughness and glow (red). */
export function eveHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: string, flipGreen = true, glow: { color: number[]; power: number } | null = null): THREE.MeshStandardMaterial {
  const isBooster = /exhaust|booster/i.test(area);
  const m = new THREE.MeshStandardMaterial({
    map: maps.albedo ?? null,
    color: maps.albedo ? 0xffffff : 0x8c9297,
    normalMap: maps.normal ?? null,
    roughnessMap: maps.roughness ?? null,
    roughness: maps.roughness ? 1 : 0.55,
    metalness: 0.6,
    emissiveMap: maps.glow ?? null,
    // without the SOF's glow colour (an older model): a guessed colour, kept as it was
    emissive: maps.glow ? (glow ? new THREE.Color(glow.color[0] ?? 1, glow.color[1] ?? 1, glow.color[2] ?? 1) : new THREE.Color(isBooster ? 0xffa060 : 0x9fd8ff)) : new THREE.Color(0x000000),
    emissiveIntensity: glow ? 1 : isBooster ? 4 : 2,
  });
  m.onBeforeCompile = (shader) => {
    let fs = resolveIncludes(shader.fragmentShader);
    if (maps.normal) {
      fs = change(fs, "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec3 mapN; mapN.xy = ( texture2D( normalMap, vNormalMapUv ).xy + 0.002 ) * 2.0 - 1.0;
         ${flipGreen ? "mapN.y = -mapN.y;" : ""}
         mapN.z = 1.0; // quadv5: T x + B y + N, normalised (no z rebuilt from x and y)`);
    }
    if (maps.roughness) fs = change(fs, "roughnessFactor *= texelRoughness.g;", "roughnessFactor *= texelRoughness.r;");
    if (maps.glow) fs = change(fs, "totalEmissiveRadiance *= emissiveColor.rgb;", glow ? `totalEmissiveRadiance *= vec3( pow( emissiveColor.r, ${glow.power.toFixed(1)} ) );` : "totalEmissiveRadiance *= emissiveColor.rrr;");
    shader.fragmentShader = fs;
  };
  return m;
}

const loader = new GLTFLoader();
const byType = new Map<number, Promise<THREE.Object3D | null>>();

/** A fresh instance of a type's model (shared geometry and textures), or null when it has none. */
export async function typeModel(typeID: number): Promise<THREE.Object3D | null> {
  if (!byType.has(typeID)) byType.set(typeID, loadType(typeID));
  const proto = await byType.get(typeID)!;
  return proto ? proto.clone(true) : null;
}

/** A fresh instance of a SOF graphic's model that is no type's (a station hangar), or null when it has none. */
export async function graphicModel(graphicID: number): Promise<THREE.Object3D | null> {
  if (!byGraphic.has(graphicID)) byGraphic.set(graphicID, fetch(`/client-assets/graphic/${graphicID}`).then((r) => r.json()).then((info: TypeModelInfo) => loadModel(info, null)));
  const proto = await byGraphic.get(graphicID)!;
  return proto ? proto.clone(true) : null;
}
const byGraphic = new Map<number, Promise<THREE.Object3D | null>>();

async function loadType(typeID: number): Promise<THREE.Object3D | null> {
  const info = (await (await fetch(`/client-assets/type/${typeID}`)).json()) as TypeModelInfo;
  return loadModel(info, typeID);
}

async function loadModel(info: TypeModelInfo, typeID: number | null): Promise<THREE.Object3D | null> {
  if (!info.model) return null;
  const gltf = await loader.loadAsync(info.model);
  const dir = info.model.slice(0, info.model.lastIndexOf("/") + 1);
  const maps: Record<string, THREE.Texture | undefined> = {};
  await Promise.all(Object.entries(info.textures ?? {}).map(async ([role, variants]) => {
    const file = variants.full ?? variants.mediumdetail ?? variants.lowdetail;
    if (!file) return;
    try { maps[role] = await loadDds(dir + file); } catch { /* a texture this GPU cannot take: drawn without it */ }
  }));
  if (maps.albedo) maps.albedo.colorSpace = THREE.SRGBColorSpace;
  // The Space Object Factory's build of this hull for the type's faction, where there is one: each mesh area takes the
  // SOF area of its index (EveSOFDataHullArea.index), with that area's own textures and the faction's materials.
  const sof = info.sof ? ((await (await fetch(info.sof)).json()) as SofHull) : null;
  const ROLE = HULL_TEXTURE_ROLES;
  const areaMaps = new Map<SofArea, Record<string, THREE.Texture | undefined>>();
  const texCache = new Map<string, Promise<THREE.Texture | undefined>>();
  const tex = (url: string) => {
    if (!texCache.has(url)) texCache.set(url, loadDds(url).then((t) => t as THREE.Texture).catch(() => undefined));
    return texCache.get(url)!;
  };
  for (const area of sof?.areas ?? []) {
    const am: Record<string, THREE.Texture | undefined> = {};
    await Promise.all(Object.entries(area.textures).map(async ([name, url]) => { const role = ROLE[name]; if (role && url) am[role] = await tex(url); }));
    if (am.albedo) am.albedo.colorSpace = THREE.SRGBColorSpace;
    areaMaps.set(area, am);
  }
  // the hull's default pattern (one layer), its mask loaded once
  const patternLayer = sof?.pattern?.layers[0] ?? null;
  const patternMask = patternLayer?.texture ? await tex(patternLayer.texture) : undefined;
  const pattern: HullPattern | null = patternLayer && patternMask ? { layer: patternLayer, mask: patternMask, pmtl1: sof?.pattern?.pmtl1 ?? null } : null;
  const materials = new Map<string, THREE.Material>();
  // each SOF area over a part of the mesh draws it (EveSOF fills each list's areas; a part may be in more than one:
  // the first takes the mesh, the others a copy of it beside it); a distortion area's draw is on the distortion layer
  // alone (distortion.ts); a part no area names keeps the older guess
  const materialOf = (area: SofArea): THREE.Material | null => {
    const key = `sof:${area.kind}:${area.index}:${area.name}`;
    if (!materials.has(key)) {
      const shader = area.shader ?? "";
      const m = area.kind === "distortion" ? (/^fx\/fxdistortionv5/i.test(shader) ? distortionMaterial(area.params, areaMaps.get(area) ?? {}) : null)
        : /^fx\/fx(directional)?v5/i.test(shader) ? fxHullMaterial(area, areaMaps.get(area) ?? {})
        : /^quad\//i.test(shader) ? sofHullMaterial({ ...maps, ...areaMaps.get(area) }, area, pattern)
        : null;
      if (!m) return null;
      materials.set(key, m);
    }
    return materials.get(key)!;
  };
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  for (const mesh of meshes) {
    // the hull casts and takes the sun's shadow (spaceView.ts fitSunShadow)
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mat = mesh.material as THREE.Material;
    const index = typeof mat.userData?.index === "number" ? (mat.userData.index as number) : null;
    const areas = sof?.areas.filter((a) => a.index === index) ?? [];
    if (!areas.length) {
      const key = `legacy:${mat.name}`;
      if (!materials.has(key)) materials.set(key, eveHullMaterial(maps, mat.name));
      mesh.material = materials.get(key)!;
      continue;
    }
    // the kinds of the SOF areas over this part (an overlay's passes pick their areas by them, hullOverlay.ts)
    mesh.userData.areaKinds = areas.map((a) => a.kind);
    const drawn = areas.map(materialOf).filter((m): m is THREE.Material => !!m);
    if (!drawn.length) { mesh.visible = false; continue; }
    mesh.material = drawn[0]!;
    if (drawn[0]!.userData.distortion) mesh.layers.set(DISTORTION_LAYER);
    for (const m of drawn.slice(1)) {
      const copy = new THREE.Mesh(mesh.geometry, m);
      copy.name = `${mesh.name}:${(m as THREE.Material).type}`;
      copy.position.copy(mesh.position); copy.quaternion.copy(mesh.quaternion); copy.scale.copy(mesh.scale);
      if (m.userData.distortion) copy.layers.set(DISTORTION_LAYER);
      mesh.parent?.add(copy);
    }
  }
  // The file's LODs, finest first, switched by distance in units of the model's size.
  const lodNodes = gltf.scene.children[0]?.children ?? [];
  const size = new THREE.Box3().setFromObject(lodNodes[0] ?? gltf.scene).getBoundingSphere(new THREE.Sphere()).radius || 50;
  const lod = new THREE.LOD();
  lodNodes.slice().forEach((node, i) => lod.addLevel(node, i === 0 ? 0 : size * 12 * 2 ** (i - 1)));
  // the hull's decals, on each LOD (hullDecals.ts)
  const decalSets = (sof as { decalSets?: SofDecalSet[] } | null)?.decalSets;
  // (the LOD's levels: lodNodes is the file's live children list, which addLevel has emptied)
  if (decalSets?.length) await addDecals(lod.levels.map((l) => l.object), decalSets).catch((e) => console.warn("hull decals", e));
  lod.userData = { typeID, radius: size, hull: info.hull ?? null, anchor: sof?.anchor ?? null, maxCameraDistance: sof?.maxCameraDistance ?? null, lights: sof?.lights ?? [], boundingSphere: (sof as { boundingSphere?: number[] | null } | null)?.boundingSphere ?? null,
    shapeEllipsoid: (sof as { shapeEllipsoid?: { center: number[]; radius: number[] } | null } | null)?.shapeEllipsoid ?? null,
    // its turret locators and Primary area's faction materials (turretModel.ts: where and how its fitted turrets are drawn)
    turretLocators: (sof as { turretLocators?: unknown[] } | null)?.turretLocators ?? [],
    turretPrimary: (() => { const a = sof?.areas.find((x) => x.areaType === "Primary"); return a ? { materials: a.materials, glowColor: a.glowColor ?? null } : null; })(),
    faction: info.faction ?? null };
  const flames = sof ? await volumetricBoosters(sof.boosters, sof.booster?.volumetric).catch((e) => { console.warn("booster flames", e); return null; }) : null;
  const glows = flames && sof?.booster ? await boosterGlows(sof.boosters, sof.booster, sof.booster.volumetric).catch((e) => { console.warn("booster glows", e); return null; }) : null;
  const boosters = sof ? buildBoosters(sof, flames, glows) : null;
  // the hull's sprite lights and plane cards (hullFx.ts)
  const fx = sof ? await hullFx(sof as { spriteSets?: SofSpriteSet[]; planeSets?: SofPlaneSet[]; spotlightSets?: SofSpotlightSet[]; hazeSets?: SofHazeSet[] }).catch(() => null) : null;
  // the hull's children (hullChildren.ts): the static part of their graph
  // the scene GPU particle system's atlas and turbulence volume, where this build names them
  setGpuParticleAssets((sof as { gpuParticles?: { atlas?: string | null; noise?: string | null } } | null)?.gpuParticles);
  const children = sof ? await hullChildren((sof as { children?: SofHullChild[] }).children, (sof as { childEffects?: Record<string, SofChildNode | null> }).childEffects ?? {}, (sof as { hullControllers?: SofController[] }).hullControllers ?? [], (sof as { locatorSets?: Record<string, number[][]> }).locatorSets ?? {}, (sof as { overlays?: Record<string, SofOverlay | null> }).overlays ?? {}).catch((e) => { console.warn("hull children", e); return null; }) : null;
  // the hull's damage impacts (impactOverlay.ts), sized by its bounding sphere
  const impactSof = (sof as { impact?: SofImpact } | null)?.impact ?? null;
  const impact = impactSof ? impactAnchor(impactSof, (sof as { boundingSphere?: number[] | null } | null)?.boundingSphere?.[3] ?? size) : null;
  // the hull's locator sets (a child effect added to the ship from outside - the hangar VFX's drones - reads them)
  lod.userData.locatorSets = (sof as { locatorSets?: Record<string, number[][]> } | null)?.locatorSets ?? {};
  if (!boosters && !fx && !children && !impact) return lod;
  // The engines and lights belong to the hull, not to one LOD: a holder carries them all.
  const holder = new THREE.Group();
  holder.add(lod);
  if (impact) holder.add(impact);
  if (boosters) holder.add(boosters);
  if (fx) holder.add(fx);
  if (children) holder.add(children);
  holder.userData = lod.userData;
  return holder;
}
