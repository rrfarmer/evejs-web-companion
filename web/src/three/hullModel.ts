// A type's model as the play page draws it: the hull tools/client-extract pulled from the client (asked of the dev
// server by typeID, extracted on first ask), its own textures, and its LODs switched by distance. The material is a
// first approximation of the client's quadv5 ship shader; faction colours (MaterialMap / PaintMaskMap) come with the
// SOF reader.

import * as THREE from "three";
import { addDecals, type SofDecalSet } from "./hullDecals.ts";
import { hullChildren, type SofHullChild } from "./hullChildren.ts";
import { hullFx,type SofSpriteSet, type SofPlaneSet, type SofSpotlightSet, type SofHazeSet } from "./hullFx.ts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds } from "./ddsTexture.ts";
import { logDepth } from "./logDepth";
import { distortionMaterial, DISTORTION_LAYER } from "./distortion.ts";

export interface SofMaterial { name: string; diffuse: number[] | null; dust: number[] | null; fresnel: number[] | null; gloss: number | null }
export interface SofArea { kind: string; name: string; index: number; areaType: string; shader: string | null; textures: Record<string, string | null>; params: Record<string, number[] | null>; materials: (SofMaterial | null)[]; glowColor?: number[] | null; heatGlowColor?: number[] | null }
export interface SofBooster { glowColor: number[] | null; glowScale: number | null; haloColor: number[] | null; haloScaleX: number | null; haloScaleY: number | null; shape0Color: number[] | null; shape1Color: number[] | null }
export interface SofHull {
  hull: string; faction: string | null; race?: string | null; booster?: SofBooster | null; areas: SofArea[]; colorSet: Record<string, number[]> | null; boosters: { transform: number[] | null }[];
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
 * is a noise-animated shape from an atlas (EveBoosterSet2); this is a first likeness: two crossed additive planes
 * fading along the flame, and a glow at the nozzle. Each flame's length is set by the ship's speed (setThrust).
 */
function buildBoosters(sof: SofHull): THREE.Group | null {
  const b = sof.booster;
  if (!b || !sof.boosters.length) return null;
  const hdr = (c: number[] | null | undefined, d: number[]) => { const v = c ?? d; const m = Math.max(v[0]!, v[1]!, v[2]!, 1e-6); return new THREE.Color(v[0]! / m, v[1]! / m, v[2]! / m); };
  const flameColour = hdr(b.shape0Color, [1, 0.6, 0.3]);
  const coreColour = hdr(b.shape1Color, [1, 0.8, 0.5]);
  const group = new THREE.Group();
  group.name = "boosters";
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
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpot(), color: flameColour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(Math.max(w, h) * 2.4);
    nozzle.add(glow);
    group.add(nozzle);
  }
  return group;
}

/** Engines burn as the ship goes: the flames' length follows speed, as a share of the ship's top speed. */
export function setThrust(model: THREE.Object3D, share: number): void {
  // the heat glow's booster intensity (sofHullMaterial)
  model.userData.thrust = Math.max(0, Math.min(1, share));
  const boosters = model.getObjectByName("boosters");
  if (!boosters) return;
  const k = 0.15 + 0.85 * Math.max(0, Math.min(1, share));
  for (const nozzle of boosters.children) {
    const flame = nozzle.getObjectByName("flame");
    if (flame) flame.scale.set(1, 1, k);
  }
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
export const HULL_TEXTURE_ROLES: Record<string, string> = { AlbedoMap: "albedo", NormalMap: "normal", RoughnessMap: "roughness", MaterialMap: "materialMap", GlowMap: "glow", DirtMap: "dirt", PaintMaskMap: "paintMask", SailsDetailMap: "sailsDetail", HeatGlowNoiseMap: "heatNoise", Detail1Map: "detail1", Detail2Map: "detail2", Detail3Map: "detail3", AlphaThresholdMap: "alphaThreshold", Layer1Map: "layer1", Layer2Map: "layer2", LayerMaskMap: "layerMask", DistortionMap: "distortion", OilFilmLookupMap: "oilFilm" };

/**
 * A hull area drawn with fx/fxv5.fx or fx/fxdirectionalv5.fx (their record 0, fxres.py; the same pixel stage):
 * Layer1Map at uv x Layer1Transform.xy + .zw + Layer1Scroll.xy x time + .zw, times the ship's activation strength
 * (1), times Layer2Map likewise, times LayerMaskMap at the uv, times BaseColor; the colour times the fresnel (as
 * ubershader.fx's), alpha as it is. fxdirectionalv5's uv is the mesh's position in EVE's space, scaled by the world
 * transform's axis lengths, dotted with DirectionU and DirectionV (each times its .w). fxv5 blends ONE/ONE itself;
 * fxdirectionalv5 sets nothing: its batch's preset (additive ONE/ONE, transparent alpha). Culling: neither sets one,
 * so the batch's (additive none, transparent CW: FrontSide). Defaults from the files: FresnelFactors (1, 1, 0, 0),
 * transforms and scrolls (1, 1, 0, 0), BaseColor 1, DirectionU (1, 0, 0, 1), DirectionV (0, 1, 0, 1).
 */
function fxHullMaterial(area: SofArea, maps: Record<string, THREE.Texture | undefined>): THREE.ShaderMaterial {
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
    fragmentShader: `uniform vec4 fresnel; uniform vec4 base; uniform vec4 t1; uniform vec4 t2; uniform vec4 s1; uniform vec4 s2; uniform float time;
      uniform sampler2D layer1; uniform sampler2D layer2; uniform sampler2D layerMask;
      varying vec2 vUv; varying vec3 vN; varying vec3 vFromEye;
      void main() {
        float f = pow( 1.0 - clamp( dot( normalize( -vFromEye ), normalize( vN ) ) - fresnel.z, 0.0, 1.0 ), fresnel.x );
        f = fresnel.y < 0.0 ? ( 1.0 - min( f, 1.0 ) ) * -fresnel.y : f * fresnel.y;
        vec4 c = texture2D( layer1, vUv * t1.xy + t1.zw + s1.xy * time + s1.zw )
          * texture2D( layer2, vUv * t2.xy + t2.zw + s2.xy * time + s2.zw )
          * texture2D( layerMask, vUv ) * base;
        gl_FragColor = vec4( c.rgb * f, c.a );
      }`,
    transparent: true, depthWrite: false,
    side: area.kind === "additive" ? THREE.DoubleSide : THREE.FrontSide,
    ...(additive
      ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }
      : { blending: THREE.NormalBlending }),
  });
  logDepth(mat);
  return mat;
}

/** The engines' share of full thrust a hull model shows (setThrust), for its heat glow; 0 unset (a station). */
function thrustOf(o: THREE.Object3D): number {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (typeof p.userData.thrust === "number") return p.userData.thrust as number;
  return 0;
}
const heatClock = { get value() { return performance.now() / 1000; } };

export function sofHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: SofArea): THREE.MeshStandardMaterial {
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
  const uniforms = {
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
    Object.assign(shader.uniforms, uniforms, heat ? heatUniforms : {});
    // inserted beside the chunk names first; the base then writes the chunks out and fixes the channels in them
    shader.fragmentShader = `uniform vec3 mtlDiffuse[4]; uniform vec3 mtlFresnel[4]; uniform float mtlGloss[4]; uniform sampler2D materialMap; uniform sampler2D sailsDetailMap; uniform vec3 sailsDetailData; uniform sampler2D paintMask; uniform vec4 generalData; uniform sampler2D detail1; uniform sampler2D detail2; uniform sampler2D detail3; uniform vec4 detailData[3]; uniform vec3 detailAlbedo; uniform vec3 detailFresnel; uniform vec4 detailSelector; uniform vec3 wreckColor; uniform vec4 wreckFactors; uniform float wreckTime; uniform sampler2D alphaThreshold; uniform vec4 envTiling; uniform vec4 envDetail; uniform vec4 envMtl1; uniform vec4 envMtl2; uniform vec3 envAlbedo1; uniform vec3 envAlbedo2; uniform vec3 envFresnel1; uniform vec3 envFresnel2; uniform sampler2D oilFilm;${wreck ? " varying float vWreckV;" : ""}${env ? " varying vec2 vEnvUv;" : ""}
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
        vec3 mtlTint = mtlDiffuse[0] * mtlW.x + mtlDiffuse[1] * mtlW.y + mtlDiffuse[2] * mtlW.z + mtlDiffuse[3] * mtlW.w;
        float mtlGl = mtlGloss[0] * mtlW.x + mtlGloss[1] * mtlW.y + mtlGloss[2] * mtlW.z + mtlGloss[3] * mtlW.w;
        vec3 mtlFr = mtlFresnel[0] * mtlW.x + mtlFresnel[1] * mtlW.y + mtlFresnel[2] * mtlW.z + mtlFresnel[3] * mtlW.w;
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
        material.specularColorBlended = mtlFr;`);
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
  m.customProgramCacheKey = () => `sofHull5${sails ? "s" : ""}${heat ? "h" : ""}${maps.paintMask ? "p" : ""}${detail ? "d" : ""}${wreck ? "w" : ""}${glass ? "g" : ""}${env ? "e" : ""}${oil ? "o" : ""}`;
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
        : /^quad\//i.test(shader) ? sofHullMaterial({ ...maps, ...areaMaps.get(area) }, area)
        : null;
      if (!m) return null;
      materials.set(key, m);
    }
    return materials.get(key)!;
  };
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  for (const mesh of meshes) {
    const mat = mesh.material as THREE.Material;
    const index = typeof mat.userData?.index === "number" ? (mat.userData.index as number) : null;
    const areas = sof?.areas.filter((a) => a.index === index) ?? [];
    if (!areas.length) {
      const key = `legacy:${mat.name}`;
      if (!materials.has(key)) materials.set(key, eveHullMaterial(maps, mat.name));
      mesh.material = materials.get(key)!;
      continue;
    }
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
  lod.userData = { typeID, radius: size, hull: info.hull ?? null, anchor: sof?.anchor ?? null, maxCameraDistance: sof?.maxCameraDistance ?? null, lights: sof?.lights ?? [], boundingSphere: (sof as { boundingSphere?: number[] | null } | null)?.boundingSphere ?? null };
  const boosters = sof ? buildBoosters(sof) : null;
  // the hull's sprite lights and plane cards (hullFx.ts)
  const fx = sof ? await hullFx(sof as { spriteSets?: SofSpriteSet[]; planeSets?: SofPlaneSet[]; spotlightSets?: SofSpotlightSet[]; hazeSets?: SofHazeSet[] }).catch(() => null) : null;
  // the hull's children (hullChildren.ts): the static part of their graph
  const children = sof ? await hullChildren((sof as { children?: SofHullChild[] }).children).catch((e) => { console.warn("hull children", e); return null; }) : null;
  if (!boosters && !fx && !children) return lod;
  // The engines and lights belong to the hull, not to one LOD: a holder carries them all.
  const holder = new THREE.Group();
  holder.add(lod);
  if (boosters) holder.add(boosters);
  if (fx) holder.add(fx);
  if (children) holder.add(children);
  holder.userData = lod.userData;
  return holder;
}
