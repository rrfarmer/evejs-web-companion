// Planets, moons and suns: a likeness of what the client draws from their object files (EvePlanet / EveSun and
// their procedural, compiled effects: SimpleMoon.fx, EarthlikePlanet.fx, GasGiant.fx, sunsurface.fx ...), made from
// the textures and constant parameters those files name (/client-assets/celestial/<typeID>, lib/celestial.mjs):
// the surface texture, tinted by the colour ramps where the file has them, lit by the sun, with a rim of light at
// the edge; a sun glows in its colour ramp's colour.
//
// A planet or moon is drawn from its own shader preset, as the client loads it (planet.py LoadPlanet: the preset's
// object file, with the planet's height maps set on its effects as NormalHeight1 and NormalHeight2), where the system's
// celestials are known (/client-assets/celestials/<solarSystemID>.json); its type's graphic otherwise. A gas giant's
// NormalHeight1 is its colour map (gasgiantNN_d.dds); a rocky planet's is its height, which shades its tints.

import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";

interface Celestial { type: string; effects: string[]; textures: Record<string, string | null>; params: Record<string, number[]> }

const byType = new Map<number, Promise<Celestial | null>>();
function celestialOf(typeID: number): Promise<Celestial | null> {
  if (!byType.has(typeID)) byType.set(typeID, fetch(`/client-assets/celestial/${typeID}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.textures ? (j as Celestial) : null)).catch(() => null));
  return byType.get(typeID)!;
}

const col = (v: number[] | undefined, d: [number, number, number]) => new THREE.Color(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);

/** The surface texture a planet type's shader starts from, in the order the client's planet effects name them. */
const SURFACE = ["FillTexture", "DetailTexture", "DistortionMap", "DiffuseMap", "HeightMap1", "NoiseMap"];

/** A planet or moon's own build: its preset's object file and its height maps (extract.mjs --system-celestials). */
export interface CelestialItem { typeID?: number | null; kind?: string; celestial: string | null; NormalHeight1: string | null; NormalHeight2: string | null }

const bySystem = new Map<number, Promise<Record<string, CelestialItem>>>();
/** A system's planets and moons, each with its own preset and height maps; none where they cannot be read. */
export function systemCelestials(solarSystemID: number): Promise<Record<string, CelestialItem>> {
  if (!bySystem.has(solarSystemID)) {
    bySystem.set(solarSystemID, fetch(`/client-assets/celestials/${solarSystemID}.json`).then((r) => (r.ok ? r.json() : null)).then((j) => (j?.items ?? {}) as Record<string, CelestialItem>).catch(() => ({})));
  }
  return bySystem.get(solarSystemID)!;
}

const byFile = new Map<string, Promise<Celestial | null>>();
function celestialAt(url: string): Promise<Celestial | null> {
  if (!byFile.has(url)) byFile.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.textures ? (j as Celestial) : null)).catch(() => null));
  return byFile.get(url)!;
}

/** One texture per file, shared by every body that uses it (a system's moons share a few height maps). */
const textures = new Map<string, Promise<THREE.Texture | null>>();
function texture(url: string, colour = false): Promise<THREE.Texture | null> {
  if (!textures.has(url)) {
    textures.set(url, loadDds(url).then((t) => { if (colour) t.colorSpace = THREE.SRGBColorSpace; return t as THREE.Texture; }).catch(() => null));
  }
  return textures.get(url)!;
}

/** How much of the nebula's light a planet takes: the sun lights planets; the nebula's ambient is faint on them. */
const PLANET_AMBIENT = 0.25;

const isGasGiant = (c: Celestial) => c.effects.some((e) => /\/gasgiant\.fx$/i.test(e));

/**
 * A planet, moon or sun as the client draws it: its surface (celestialSurface), and over a planet whose preset has
 * the earthlikeclouds effect, the cloud shell (cloudShell).
 */
export async function celestialModel(typeID: number, kind: string, radius: number, item: CelestialItem | null = null, itemID: number | null = null): Promise<THREE.Object3D | null> {
  const surface = await celestialSurface(typeID, kind, radius, item, itemID);
  if (!surface || kind === "sun") return surface;
  const c = (item?.celestial ? await celestialAt(item.celestial) : null) ?? await celestialOf(typeID);
  if (!c) return surface;
  const shells: THREE.Object3D[] = [];
  if (c.effects.some((e) => /\/earthlikeclouds\.fx$/i.test(e)) && c.textures.CloudsTexture) {
    const clouds = await cloudShell(c, radius).catch(() => null);
    if (clouds) shells.push(clouds);
  }
  if (c.effects.some((e) => /\/atmosphere\.fx$/i.test(e)) && c.params.AtmosphereFactors && c.params.ScatteringFactors) shells.push(atmosphereShell(c, radius));
  if (!shells.length) return surface;
  const group = new THREE.Group();
  group.name = "celestial";
  surface.name = "surface";
  group.add(surface, ...shells);
  return group;
}

/**
 * The atmosphere (atmosphere.fx, its sm_hi shaders): O'Neil's sky seen from space (GPU Gems 2, "Accurate Atmospheric
 * Scattering"), as the client's vertex shader does it: an outer sphere of AtmosphereFactors.x times the planet's
 * radius, scale depth 0.25, two samples along the eye's ray through it, the scale function
 * 0.25 exp(-0.00287 + x(0.459 + x(3.83 + x(-6.80 + x 5.25)))); Rayleigh 1/wavelength^4 (wavelengthsMicroMeters, read in
 * reverse, z y x) x Kr x ESun and Mie Km x ESun (ScatteringFactors x, y, z), both times AtmosphereFactors.y x
 * AtmosphereColor; its pixel shader's Mie phase with g = -0.995; the sum clamped to 1, a gamma colour taken to linear,
 * added over what is behind. The client draws it on a disc turned to the eye; here per pixel on the outer sphere, in
 * units of the planet's radius.
 */
function atmosphereShell(c: Celestial, radius: number): THREE.Object3D {
  const af = c.params.AtmosphereFactors ?? [1.015, 0.05, 0, 0];
  const sf = c.params.ScatteringFactors ?? [0.005, 0.002, 20, 0];
  const wl = c.params.wavelengthsMicroMeters ?? [0.475, 0.57, 0.65, 1];
  const ac = c.params.AtmosphereColor ?? [1, 1, 1, 1];
  const outer = Math.max(1.0001, af[0] ?? 1.015);
  const kr = sf[0] ?? 0.005, km = sf[1] ?? 0.002, eSun = sf[2] ?? 20;
  const scale = 1 / (outer - 1);
  const sunDir = new THREE.Vector3(1, 0.5, 0.5).normalize();
  const uniforms = {
    camL: { value: new THREE.Vector3(0, 0, 10) }, centre: { value: new THREE.Vector3() }, unit: { value: radius },
    sunDir: { value: sunDir },
    invW: { value: new THREE.Vector3(1 / (wl[2] ?? 0.65) ** 4, 1 / (wl[1] ?? 0.57) ** 4, 1 / (wl[0] ?? 0.475) ** 4) },
    outerR: { value: outer }, krESun: { value: kr * eSun }, kmESun: { value: km * eSun }, kr4PI: { value: kr * 4 * Math.PI }, km4PI: { value: km * 4 * Math.PI },
    scaleF: { value: scale }, scaleOverDepth: { value: scale / 0.25 },
    tint: { value: new THREE.Vector3(ac[0] ?? 1, ac[1] ?? 1, ac[2] ?? 1).multiplyScalar(af[1] ?? 0.05) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `uniform vec3 centre; uniform float unit; varying vec3 vL;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vL = (w.xyz - centre) / unit; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 camL; uniform vec3 sunDir; uniform vec3 invW; uniform float outerR; uniform float krESun; uniform float kmESun;
      uniform float kr4PI; uniform float km4PI; uniform float scaleF; uniform float scaleOverDepth; uniform vec3 tint; varying vec3 vL;
      float sc(float c) { float x = 1.0 - c; return 0.25 * exp(-0.00287 + x * (0.459 + x * (3.83 + x * (-6.80 + x * 5.25)))); }
      void main() {
        vec3 ray = vL - camL; float far = length(ray); ray /= far;
        float camH = length(camL);
        float B = 2.0 * dot(camL, ray), C = camH * camH - outerR * outerR;
        float near = 0.5 * (-B - sqrt(max(0.0, B * B - 4.0 * C)));
        vec3 start = camL + ray * near; far -= near;
        float startOffset = exp(-4.0) * sc(dot(ray, start) / outerR);
        float sampleLength = far * 0.5; float scaled = sampleLength * scaleF;
        vec3 step = ray * sampleLength; vec3 q = start + step * 0.5; vec3 front = vec3(0.0);
        for (int i = 0; i < 2; i++) {
          float h = length(q); float depth = exp(scaleOverDepth * (1.0 - h));
          float scatter = startOffset + depth * (sc(dot(sunDir, q) / h) - sc(dot(ray, q) / h));
          front += exp(-scatter * (invW * kr4PI + km4PI)) * depth * scaled;
          q += step;
        }
        vec3 rayleigh = front * invW * krESun * tint, mie = front * kmESun * tint;
        float cosA = dot(sunDir, -ray);
        float phase = 0.005004 * (1.0 + cosA * cosA) / pow(1.990025 + 1.99 * cosA, 1.5);
        vec3 c = min(rayleigh + phase * mie, vec3(1.0));
        c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const centre = new THREE.Vector3(), camW = new THREE.Vector3();
  let lightOf: THREE.DirectionalLight | null = null;
  mat.onBeforeRender = (_r, scene, camera, _g, object) => {
    object.matrixWorld.decompose(centre, new THREE.Quaternion(), camW);
    const unit = radius * Math.max(camW.x, camW.y, camW.z);
    centre.setFromMatrixPosition(object.matrixWorld);
    uniforms.centre.value.copy(centre);
    uniforms.unit.value = unit;
    camW.setFromMatrixPosition(camera.matrixWorld);
    uniforms.camL.value.copy(camW).sub(centre).divideScalar(unit);
    if (!lightOf || !lightOf.parent) {
      lightOf = null;
      scene.traverse((o) => { if (!lightOf && (o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).intensity > 0) lightOf = o as THREE.DirectionalLight; });
    }
    if (lightOf) sunDir.copy(lightOf.position).sub(lightOf.target.position).normalize();
  };
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius * outer, 96, 64), mat);
  m.name = "atmosphere";
  m.renderOrder = 2;
  return m;
}

/**
 * The cloud shell (earthlikeclouds.fx, its sm_hi pixel shader; Time c2.x, CloudsColor c3, CloudsFactors c4): a sphere
 * just over the surface, its cover pow(cloud, CloudsFactors.z) (CloudsTexture tiled by CloudsFactors.w, turning once
 * an hour), its colour cover x (GroundScattering1 + ambient) x CloudsColor x CloudsFactors.y plus GroundScattering2,
 * laid over the surface with the cover as its alpha. The polar cloud cap's projection is not ported.
 */
async function cloudShell(c: Celestial, radius: number): Promise<THREE.Object3D | null> {
  const [clouds, s1, s2] = await Promise.all([
    texture(c.textures.CloudsTexture!),
    c.textures.GroundScattering1 ? texture(c.textures.GroundScattering1) : Promise.resolve(null),
    c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
  ]);
  if (!clouds) return null;
  if (clouds.wrapS !== THREE.RepeatWrapping) { clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping; clouds.needsUpdate = true; }
  const f = c.params.CloudsFactors ?? [0.5, 1, 1, 1];
  const k = c.params.CloudsColor ?? [1, 1, 1, 1];
  const mat = scatterMaterial(s1, s2, {
    clouds: { value: clouds }, hasScatter: { value: s1 ? 1 : 0 },
    cloudColour: { value: new THREE.Vector3(k[0] ?? 1, k[1] ?? 1, k[2] ?? 1) },
    cloudF: { value: new THREE.Vector4(f[0] ?? 0.5, f[1] ?? 1, f[2] ?? 1, f[3] ?? 1) },
  }, `uniform sampler2D clouds; uniform float hasScatter; uniform vec3 cloudColour; uniform vec4 cloudF;`, `
        float cover = pow(abs(texture2D(clouds, vUv * cloudF.w * vec2(2.0, 1.0) + vec2(fract(time * 0.000278), 0.0)).r), cloudF.z);
        vec3 light = hasScatter > 0.5 ? lit : vec3(max(NL, 0.0)) + ambient;
        g = cover * light * cloudColour * cloudF.y + (hasScatter > 0.5 ? S2 : vec3(0.0));
        alpha = cover;`, true);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.004, 96, 64), mat);
  m.name = "clouds";
  m.renderOrder = 1;
  return m;
}

async function celestialSurface(typeID: number, kind: string, radius: number, item: CelestialItem | null = null, itemID: number | null = null): Promise<THREE.Object3D | null> {
  const c = (item?.celestial ? await celestialAt(item.celestial) : null) ?? await celestialOf(typeID);
  if (!c) return null;
  if (kind === "sun") return sunModel(c, radius);
  if (item?.NormalHeight1 && isGasGiant(c)) return gasGiantModel(c, item.NormalHeight1, radius, itemID);
  if (item?.NormalHeight1 && c.params.FillTint && c.textures.FillTexture) return rockyModel(c, item.NormalHeight1, item.NormalHeight2, radius, itemID);
  if (item?.NormalHeight1 && c.params.LavaColor1 && c.textures.FillTexture) return lavaModel(c, item.NormalHeight1, item.NormalHeight2, radius, itemID);
  if (item?.NormalHeight1 && c.params.IceFactors && c.textures.FillTexture) return iceModel(c, item.NormalHeight1, item.NormalHeight2, radius, itemID);
  if (item?.NormalHeight1 && c.params.Ramp1 && c.params.RampBias && c.textures.DetailTexture) return moonModel(c, item.NormalHeight1, item.NormalHeight2, radius, itemID);
  if (item?.NormalHeight1 && c.params.WaterColor && !c.params.FillTint && c.textures.GroundScattering1) return oceanModel(c, item.NormalHeight1, item.NormalHeight2, radius, itemID);
  if (c.params.PlanetColor && c.params.MagmaFactors && c.textures.GroundScattering1) return thunderModel(c, radius);
  const surfaceName = SURFACE.find((n) => c.textures[n] && !/black\.dds$/.test(c.textures[n]!));
  const shared = surfaceName ? await texture(c.textures[surfaceName]!, true) : null;
  const tiling = c.params.DetailsTiling?.[0] ?? 1;
  // a tiled surface is a copy of its own (the shared texture keeps its repeat of one)
  const surface = shared && tiling > 1 ? shared.clone() : shared;
  if (surface && tiling > 1) { surface.repeat.set(tiling, tiling); surface.wrapS = surface.wrapT = THREE.RepeatWrapping; }
  const rampHi = col(c.params.Ramp1, [1, 1, 1]), rampLo = col(c.params.Ramp3 ?? c.params.Ramp2, [0.2, 0.2, 0.2]);
  const hasRamp = !!c.params.Ramp1;
  const rim = col(c.params.MoonFresnelColor ?? c.params.AtmosphereColor ?? c.params.FresnelColor, [0.45, 0.6, 0.85]);
  const mat = new THREE.MeshStandardMaterial({ map: surface ?? null, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rampHi = { value: rampHi };
    shader.uniforms.rampLo = { value: rampLo };
    shader.uniforms.rimColour = { value: rim };
    shader.fragmentShader = `uniform vec3 rampHi; uniform vec3 rampLo; uniform vec3 rimColour;\n${shader.fragmentShader}`
      .replace("#include <map_fragment>", `#include <map_fragment>
        ${hasRamp ? "diffuseColor.rgb = mix( rampLo, rampHi, clamp( diffuseColor.r * 1.2, 0.0, 1.0 ) );" : ""}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float rimF = pow( 1.0 - clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ), 4.0 );
        totalEmissiveRadiance += rimColour * rimF * 0.6;`);
  };
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/** The rim of light at a planet's edge, in its atmosphere's colour. */
function withRim(mat: THREE.MeshStandardMaterial, rim: THREE.Color, more: (fs: string) => string = (fs) => fs, uniforms: Record<string, { value: unknown }> = {}): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { rimColour: { value: rim } });
    shader.fragmentShader = more(`uniform vec3 rimColour;
${shader.fragmentShader}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float rimF = pow( 1.0 - clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ), 4.0 );
        totalEmissiveRadiance += rimColour * rimF * 0.6;`);
  };
}

/**
 * A gas giant as gasgiant.fx draws it (graphics/effect.dx11/managed/space/planet/gasgiant.sm_hi, its pixel shader
 * disassembled and its constants named from the effect file's own table: Random c0.x, Time c0.y, WindFactors c1,
 * DistoFactors c2, FuzzyEdges c3.x, BandingSpeed c3.y, Saturation c3.z, ringColor1..3 c4..c6, CapColor c7):
 * - NormalHeight1 (the planet's own gasgiantNN_d.dds) is not a picture: its G, R and B weigh ringColor2, ringColor3
 *   and ringColor1, and its alpha scales the sum;
 * - that colour is saturated about its luminance (0.299, 0.587, 0.184) by NormalHeight1.R x Saturation;
 * - towards the poles it becomes CapColor, by 1 - PolesMaskMap;
 * - both samples are moved by Random x (0.01, 0.1), Random being the planet's itemID % 100 (planet.py
 *   SetEffectParameters);
 * - the result is a gamma-space colour, taken to linear before it is lit.
 * The wind's distortion and the bands' drift over time (WindFactors, DistoFactors, BandingSpeed, the noise map) are
 * not drawn: a still planet.
 */
async function gasGiantModel(c: Celestial, bandMap: string, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [bands, poles] = await Promise.all([
    texture(bandMap),
    c.textures.PolesMaskMap ? texture(c.textures.PolesMaskMap) : Promise.resolve(null),
  ]);
  if (bands && bands.wrapS !== THREE.RepeatWrapping) { bands.wrapS = bands.wrapT = THREE.RepeatWrapping; bands.needsUpdate = true; }
  const v3 = (v: number[] | undefined) => new THREE.Vector3(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0);
  // gasgiant.fx's lighting (its pixel shader's end): the colour x (its wrapped diffuse (1 - (1 - saturate(N.L))^2) x
  // (N.L + 1) / 2 x the rings' shadow + the ambient); no ground scattering. The rings' shadow is not ported.
  const mat = scatterMaterial(null, null, {
    bands: { value: bands },
    ring1: { value: v3(c.params.ringColor1) }, ring2: { value: v3(c.params.ringColor2) }, ring3: { value: v3(c.params.ringColor3) },
    capColour: { value: v3(c.params.CapColor) },
    saturation: { value: c.params.Saturation?.[0] ?? 1 },
    shift: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(itemID === null ? 0 : itemID % 100) },
    polesMap: { value: poles }, hasPoles: { value: poles ? 1 : 0 },
  }, `uniform sampler2D bands; uniform vec3 ring1; uniform vec3 ring2; uniform vec3 ring3; uniform vec3 capColour; uniform float saturation; uniform vec2 shift;
      uniform sampler2D polesMap; uniform float hasPoles;`, `
        vec4 band = texture2D(bands, vUv + shift);
        vec3 colour = band.g * ring2 + band.r * ring3 + band.b * ring1;
        vec3 banded = colour * band.a;
        float lum = dot(banded, vec3(0.299, 0.587, 0.184));
        vec3 albedo = lum + band.r * saturation * (banded - lum);
        float cap = hasPoles > 0.5 ? 1.0 - texture2D(polesMap, vUv).r : 0.0;
        albedo = max(mix(albedo, capColour, cap), vec3(0.0));
        float wrapped = (1.0 - pow(1.0 - clamp(NL, 0.0, 1.0), 2.0)) * (NL + 1.0) * 0.5;
        g = albedo * (wrapped + ambient);`);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A rocky planet as earthlikeplanet.fx and sandstormplanet.fx colour it (their sm_hi pixel shaders disassembled, the
 * constants named by the effect files' own tables: DetailFactors c0, MiscFactors c1, Random c2.x, then WaterColor,
 * shallowWaterColor, SharpnessFactors, FillTint, VegetationTint, EquatorTint, mountainTint, CoverageFactors...):
 * - the land's height is NormalHeight1 (at uv x (2, 1) moved by Random x (0.01, 0.1)) times NormalHeight2 (at
 *   uv x (3, 1.5) moved by Random x (0.1, 0.01), plus one), less MiscFactors.x, times four, clamped; plus the
 *   detail's third channel x DetailFactors.y x 0.01;
 * - the colour is FillTexture's four channels (tiled by DetailFactors.x) weighing four tints in turn: FillTint;
 *   VegetationTint where low (CoverageFactors.y above the sea, SharpnessFactors.x sharp); EquatorTint above
 *   1 - (CoverageFactors.z + .x) (SharpnessFactors.y); mountainTint above 1 - CoverageFactors.z (SharpnessFactors.z);
 * - where the height is under MiscFactors.x it is sea (where the preset has WaterColor): WaterColor, towards
 *   shallowWaterColor near the shore (within SharpnessFactors.w);
 * - lit as each shader ends (scatterMaterial; S1' = GroundScattering1 + ambient): earthlikeplanet.fx gives the land
 *   albedo x (S1' / 2 + N.L) x S1' plus a rim N.L x (1 - N.V)^8, its seas (WaterColor towards shallowWaterColor, plus
 *   saturate(2 N.L) x (1 - N.V)^3) x S1' with a glint pow(N.R, 10) x 0.3, and the clouds' tint towards
 *   CloudsFactors.x x GroundScattering2 (the white clouds are the cloud shell); sandstormplanet.fx gives the land
 *   albedo x (S1' / 2 + N.L) plus the rim, both cloud layers (the tint, then CloudsColor x CloudsFactors.y x S1'),
 *   and GroundScattering2 added; the colour in gamma space, taken to linear.
 * Not drawn: the slope's share (the shader takes it from the heights' gradient; flat here), the bumped normal, the
 * polar cloud cap, the earthlike planets' city lights on the night side.
 */
async function rockyModel(c: Celestial, heightMap1: string, heightMap2: string | null, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [h1, h2, detail, s1, s2, clouds, cap] = await Promise.all([
    texture(heightMap1),
    heightMap2 ? texture(heightMap2) : Promise.resolve(null),
    texture(c.textures.FillTexture!),
    c.textures.GroundScattering1 ? texture(c.textures.GroundScattering1) : Promise.resolve(null),
    c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
    c.textures.CloudsTexture ? texture(c.textures.CloudsTexture) : Promise.resolve(null),
    c.textures.CloudCapTexture ? texture(c.textures.CloudCapTexture) : Promise.resolve(null),
  ]);
  for (const t of [h1, h2, detail, clouds]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const random = itemID === null ? 0 : itemID % 100;
  const hasWater = !!c.params.WaterColor;
  // sandstormplanet.fx ends its lighting otherwise than earthlikeplanet.fx (both disassembled; see the doc above)
  const sandstorm = c.effects.some((e) => /\/sandstormplanet\.fx$/i.test(e));
  const mat = scatterMaterial(s1, s2, {
    h1: { value: h1 }, heightMap2: { value: h2 ?? h1 }, detailMap: { value: detail },
    clouds: { value: clouds }, hasClouds: { value: clouds && c.params.CloudsFactors ? 1 : 0 }, hasScatter: { value: s1 ? 1 : 0 },
    detailF: { value: v4(c.params.DetailFactors, [4, 0, 0, 0]) }, miscF: { value: v4(c.params.MiscFactors, [0, 0, 0, 0]) },
    sharpF: { value: v4(c.params.SharpnessFactors, [4, 4, 4, 0]) }, coverF: { value: v4(c.params.CoverageFactors, [0.5, 0.2, 0.05, 0]) },
    fillTint: { value: v3(c.params.FillTint, [0.5, 0.45, 0.4]) }, vegTint: { value: v3(c.params.VegetationTint, [0.4, 0.35, 0.25]) },
    eqTint: { value: v3(c.params.EquatorTint, [0.5, 0.45, 0.35]) }, mountTint: { value: v3(c.params.mountainTint, [0.6, 0.58, 0.55]) },
    water: { value: v3(c.params.WaterColor, [0.05, 0.07, 0.08]) }, shallow: { value: v3(c.params.shallowWaterColor, [0.07, 0.15, 0.15]) },
    cloudColour: { value: v3(c.params.CloudsColor, [1, 1, 1]) }, cloudF: { value: v4(c.params.CloudsFactors, [0, 0, 1, 1]) },
    shiftA: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(random) }, shiftB: { value: new THREE.Vector2(0.1, 0.01).multiplyScalar(random) },
  }, `uniform sampler2D h1; uniform sampler2D heightMap2; uniform sampler2D detailMap; uniform sampler2D clouds; uniform float hasClouds; uniform float hasScatter;
      uniform vec4 detailF; uniform vec4 miscF; uniform vec4 sharpF; uniform vec4 coverF;
      uniform vec3 fillTint; uniform vec3 vegTint; uniform vec3 eqTint; uniform vec3 mountTint; uniform vec3 water; uniform vec3 shallow;
      uniform vec3 cloudColour; uniform vec4 cloudF; uniform vec2 shiftA; uniform vec2 shiftB;`, `
        float a = texture2D(h1, vUv * vec2(2.0, 1.0) + shiftA).r;
        float b = texture2D(heightMap2, vUv * vec2(3.0, 1.5) + shiftB + 1.0).r;
        vec4 d = ${detail ? "texture2D(detailMap, vUv * vec2(2.0, 1.0) * detailF.x)" : "vec4(0.5)"};
        float h = clamp((a * b - miscF.x) * 4.0, 0.0, 1.0) + d.z * detailF.y * 0.01;
        vec3 land = d.x * fillTint;
        land = mix(land, d.y * vegTint, clamp(sharpF.x * (coverF.y - (h - miscF.x)), 0.0, 1.0));
        land = mix(land, d.z * eqTint, clamp((h - (1.0 - (coverF.z + coverF.x))) * sharpF.y, 0.0, 1.0));
        land = mix(land, d.w * mountTint, clamp(sharpF.z * (h - (1.0 - coverF.z)), 0.0, 1.0));
        land = max(land, vec3(0.0));
        vec3 S1a = hasScatter > 0.5 ? lit : vec3(1.0) + ambient;
        float nl = clamp(NL, 0.0, 1.0);
        float edge = 1.0 - clamp(NV, 0.0, 1.0);
        float rim = nl * pow(edge, 8.0);
        ${sandstorm
          // sandstorm: albedo x (S1' / 2 + N.L) + the rim; two cloud layers; GroundScattering2 added
          ? `g = land * (S1a * 0.5 + nl) + rim;
        if (hasClouds > 0.5) {
          vec2 cuv = vUv * cloudF.w * vec2(2.0, 1.0) + vec2(fract(time * 0.000278), 0.0);
          float c1 = pow(abs(texture2D(clouds, cuv - L.xy * 0.0035).r), cloudF.z);
          g = mix(g, cloudF.x * S2, c1);
          float c2 = pow(abs(texture2D(clouds, cuv).r), cloudF.z);
          g = mix(g, cloudColour * cloudF.y * S1a, c2);
        }
        g += S2;`
          // earthlike: albedo x (S1' / 2 + N.L) x S1' + the rim; its seas lit apart with their own rim and glint; the
          // clouds' scattering tint (its white clouds are the cloud shell)
          : `g = land * (S1a * 0.5 + nl) * S1a + rim;
        ${hasWater ? `float sea = clamp((h - miscF.x) * -1000.0, 0.0, 1.0);
        vec3 w = mix(water, shallow, clamp((h + sharpF.w - miscF.x) * 50.0, 0.0, 1.0) * 0.8) + clamp(2.0 * NL, 0.0, 1.0) * pow(edge, 3.0);
        vec3 wl = w * S1a + pow(clamp(dot(L, reflect(-V, N)), 0.0, 1.0), 10.0) * 0.3;
        g = mix(g, wl, sea);` : ""}
        if (hasClouds > 0.5) {
          vec2 cuv = vUv * cloudF.w * vec2(2.0, 1.0) + vec2(fract(time * 0.000278), 0.0) - L.xy * 0.0035;
          g = mix(g, cloudF.x * S2, pow(abs(texture2D(clouds, cuv).r), cloudF.z));
        }`}`);
  void cap;
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A planet lit as the client's planet shaders light it (ocean, thunderstorm, ice: their pixel shaders' common end),
 * not by three's lights: a colour in gamma space times GroundScattering1 plus the ambient, plus GroundScattering2,
 * the two looked up at (N.L x 0.5 + 0.5, N.V), then taken to linear. The sun's direction is the scene's first
 * directional light's, read as the planet is drawn. `surface` is GLSL that sets `vec3 g` (the colour, gamma) and may
 * set `vec3 extra` (added after the scattering), with N, L, V, NL, NV, S1, S2, lit, vUv and time in scope.
 */
const SCATTER_AMBIENT = new THREE.Vector3(0.02, 0.02, 0.025);
function scatterMaterial(s1: THREE.Texture | null, s2: THREE.Texture | null, uniforms: Record<string, { value: unknown }>, head: string, surface: string, alpha = false): THREE.ShaderMaterial {
  for (const t of [s1, s2]) if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; }
  const sunDir = new THREE.Vector3(1, 0.5, 0.5).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, scatter1: { value: s1 }, scatter2: { value: s2 }, sunDir: { value: sunDir }, ambient: { value: SCATTER_AMBIENT }, time: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D scatter1; uniform sampler2D scatter2; uniform vec3 sunDir; uniform vec3 ambient; uniform float time;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      ${head}
      void main() {
        vec3 N = normalize(vN), L = normalize(sunDir), V = normalize(cameraPosition - vW);
        float NL = dot(N, L), NV = dot(N, V);
        vec2 su = vec2(NL * 0.5 + 0.5, clamp(NV, 0.0, 1.0));
        vec3 S1 = texture2D(scatter1, su).rgb, S2 = texture2D(scatter2, su).rgb;
        vec3 lit = S1 + ambient;
        vec3 g = vec3(0.5); vec3 extra = vec3(0.0); float alpha = 1.0;
        ${surface}
        vec3 c = max(g, vec3(0.0));
        c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
        gl_FragColor = vec4(c, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    // a shell (the clouds) goes over what is under it as the client blends it: its colour already carries its cover
    ...(alpha ? { transparent: true, depthWrite: false, premultipliedAlpha: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor } : {}),
  });
  let lightOf: THREE.DirectionalLight | null = null;
  mat.onBeforeRender = (_r, scene) => {
    (mat.uniforms.time as { value: number }).value = performance.now() / 1000;
    if (!lightOf || !lightOf.parent) {
      lightOf = null;
      scene.traverse((o) => { if (!lightOf && (o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).intensity > 0) lightOf = o as THREE.DirectionalLight; });
    }
    if (lightOf) sunDir.copy(lightOf.position).sub(lightOf.target.position).normalize();
  };
  return mat;
}

/**
 * An ocean planet as oceanplanet.fx colours it (its sm_hi pixel shader; Random c2.x, Time c2.y, WaterColor c3,
 * shallowWaterColor c4, CloudsColor c5, CloudsFactors c6): the sea WaterColor + shallowWaterColor x NormalHeight1 x
 * NormalHeight2 (moved by Random) away from the poles (PolesGradient), lit by the ground scattering with a rim at
 * the edge (1 - N.V)^3 x saturate(2 N.L); clouds (CloudsTexture, tiled by CloudsFactors.w, turning once an hour) at
 * pow(cloud, CloudsFactors.z), the first toward CloudsFactors.x x GroundScattering2, the second toward CloudsColor x
 * CloudsFactors.y lit; the sun's glint pow(N.R, 10) x 0.3. The cloud cap's polar projection is not ported.
 */
async function oceanModel(c: Celestial, heightMap1: string, heightMap2: string | null, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [h1, h2, poles, clouds, s1, s2] = await Promise.all([
    texture(heightMap1), heightMap2 ? texture(heightMap2) : Promise.resolve(null),
    c.textures.PolesGradient ? texture(c.textures.PolesGradient) : Promise.resolve(null),
    c.textures.CloudsTexture ? texture(c.textures.CloudsTexture) : Promise.resolve(null),
    texture(c.textures.GroundScattering1!), c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
  ]);
  for (const t of [h1, h2, clouds]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const random = itemID === null ? 0 : itemID % 100;
  const mat = scatterMaterial(s1, s2, {
    h1: { value: h1 }, h2: { value: h2 ?? h1 }, poles: { value: poles }, clouds: { value: clouds },
    hasPoles: { value: poles ? 1 : 0 }, hasClouds: { value: clouds ? 1 : 0 },
    water: { value: v3(c.params.WaterColor, [0.02, 0.05, 0.1]) }, shallow: { value: v3(c.params.shallowWaterColor, [0.05, 0.15, 0.2]) },
    cloudColour: { value: v3(c.params.CloudsColor, [0.8, 0.8, 0.8]) }, cloudF: { value: v4(c.params.CloudsFactors, [0.5, 1, 1, 1]) },
    shiftA: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(random) }, shiftB: { value: new THREE.Vector2(0.1, 0.01).multiplyScalar(random) },
  }, `uniform sampler2D h1; uniform sampler2D h2; uniform sampler2D poles; uniform sampler2D clouds; uniform float hasPoles; uniform float hasClouds;
      uniform vec3 water; uniform vec3 shallow; uniform vec3 cloudColour; uniform vec4 cloudF; uniform vec2 shiftA; uniform vec2 shiftB;`, `
        float p = hasPoles > 0.5 ? texture2D(poles, vUv).r : 1.0;
        float q = 1.0 - clamp(2.0 * pow(1.0 - p, 3.0), 0.0, 1.0);
        float h = texture2D(h1, vUv * vec2(2.0, 1.0) + shiftA).r * texture2D(h2, vUv * vec2(3.0, 1.5) + shiftB + 1.0).r;
        vec3 base = water + shallow * h * q;
        float rim = pow(1.0 - clamp(NV, 0.0, 1.0), 3.0) * clamp(2.0 * NL, 0.0, 1.0);
        g = base * lit + rim;
        if (hasClouds > 0.5) {
          vec2 scroll = vec2(fract(time * 0.000278), 0.0);
          vec2 cuv = vUv * cloudF.w * vec2(2.0, 1.0) + scroll;
          float c1 = pow(abs(texture2D(clouds, cuv - L.xy * 0.0035).r), cloudF.z);
          g = mix(g, cloudF.x * S2, c1);
          float c2 = pow(abs(texture2D(clouds, cuv).r), cloudF.z);
          g = mix(g, cloudColour * cloudF.y * lit, c2);
        }
        g += pow(clamp(dot(L, reflect(-V, N)), 0.0, 1.0), 10.0) * 0.3 + S2;`);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A storm planet as thunderstormplanet.fx colours it (its sm_hi pixel shader; Time c2.x, PlanetColor c3, MagmaFactors
 * c4, MagmaFactors2 c5, CloudsColor c6, CloudsFactors c7, LightningColor c8, Lightningfactors c9): PlanetColor lit by
 * the ground scattering, under clouds (CloudsTexture tiled by CloudsFactors.w, turning once an hour) at
 * pow(cloud, CloudsFactors.z) + 0.01 toward CloudsColor x CloudsFactors.y lit with a faint rim, plus
 * GroundScattering2. The shader's swirl (its coordinates moved by a 3D noise volume, MagmaFactors) and its lightning
 * flashes are not ported.
 */
async function thunderModel(c: Celestial, radius: number): Promise<THREE.Object3D> {
  const [clouds, s1, s2] = await Promise.all([
    c.textures.CloudsTexture ? texture(c.textures.CloudsTexture) : Promise.resolve(null),
    texture(c.textures.GroundScattering1!), c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
  ]);
  if (clouds && clouds.wrapS !== THREE.RepeatWrapping) { clouds.wrapS = clouds.wrapT = THREE.RepeatWrapping; clouds.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const mat = scatterMaterial(s1, s2, {
    clouds: { value: clouds }, hasClouds: { value: clouds ? 1 : 0 },
    planet: { value: v3(c.params.PlanetColor, [0.2, 0.23, 0.23]) },
    cloudColour: { value: v3(c.params.CloudsColor, [0.01, 0.01, 0.01]) }, cloudF: { value: v4(c.params.CloudsFactors, [0.1, 1, 0.11, 1]) },
  }, `uniform sampler2D clouds; uniform float hasClouds; uniform vec3 planet; uniform vec3 cloudColour; uniform vec4 cloudF;`, `
        vec3 ground = planet * lit;
        float rim = pow(1.0 - clamp(NV, 0.0, 1.0), 3.0);
        float cl = hasClouds > 0.5 ? texture2D(clouds, vUv * cloudF.w * vec2(2.0, 1.0) + vec2(fract(time * 0.000278), 0.0)).r : 0.0;
        float k = pow(abs(cl), cloudF.z) + 0.01;
        g = mix(ground, cloudColour * cloudF.y * lit + rim * 0.04, clamp(k, 0.0, 1.0)) + S2;`);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A moon as SimpleMoon.fx colours it (its sm_hi pixel shader; constants by the effect file's table: FresnelFactors c0,
 * MiscFactors c2, Random c3, DetailsFactors c4, DetailsTiling c5.x, RampBias c5.y, Ramp1-3 c6-c8, DetailMaskColor c9,
 * MoonFresnelColor c10):
 * - the height is the lower of NormalHeight1 and NormalHeight2 (moved by Random as the planets' are);
 * - the detail texture (tiled by DetailsTiling) shades it: a = x x DF.x, b = y x DF.y, the shade mix(a, z x DF.z, h);
 * - t = h / RampBias ramps Ramp3 to Ramp2 by saturate(t), on to Ramp1 by saturate(t - 1); the colour is the ramp times
 *   the shade, mixed toward DetailMaskColor by b, in gamma space taken to linear;
 * - the rim is MoonFresnelColor; the shader's pole blend, its wrap lighting and its reflection-cube fresnel are not
 *   ported.
 */
async function moonModel(c: Celestial, heightMap1: string, heightMap2: string | null, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [h1, h2, detail] = await Promise.all([
    texture(heightMap1),
    heightMap2 ? texture(heightMap2) : Promise.resolve(null),
    texture(c.textures.DetailTexture!),
  ]);
  for (const t of [h1, h2, detail]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const random = itemID === null ? 0 : itemID % 100;
  const mat = new THREE.MeshStandardMaterial({ map: h1, color: 0xffffff, roughness: 0.95, metalness: 0, envMapIntensity: PLANET_AMBIENT });
  const uniforms = {
    heightMap2: { value: h2 ?? h1 }, detailMap: { value: detail },
    detailF: { value: v4(c.params.DetailsFactors, [2, 1.8, 1, 0]) }, tiling: { value: c.params.DetailsTiling?.[0] ?? 2 },
    rampBias: { value: c.params.RampBias?.[0] ?? 0.32 },
    ramp1: { value: v3(c.params.Ramp1, [0.82, 0.85, 0.86]) }, ramp2: { value: v3(c.params.Ramp2, [0.7, 0.7, 0.74]) },
    ramp3: { value: v3(c.params.Ramp3, [0.18, 0.18, 0.18]) }, maskColour: { value: v3(c.params.DetailMaskColor, [1, 1, 1]) },
    shiftA: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(random) }, shiftB: { value: new THREE.Vector2(0.1, 0.01).multiplyScalar(random) },
  };
  withRim(mat, col(c.params.MoonFresnelColor, [0.58, 0.62, 0.79]), (fs) => `uniform sampler2D heightMap2; uniform sampler2D detailMap; uniform vec4 detailF; uniform float tiling; uniform float rampBias;
uniform vec3 ramp1; uniform vec3 ramp2; uniform vec3 ramp3; uniform vec3 maskColour; uniform vec2 shiftA; uniform vec2 shiftB;
${fs}`.replace("#include <map_fragment>", `
        float a = texture2D( map, vMapUv * vec2( 2.0, 1.0 ) + shiftA ).r;
        float b = texture2D( heightMap2, vMapUv * vec2( 3.0, 1.5 ) + shiftB + 1.0 ).r;
        float h = min( a, b );
        vec3 det = texture2D( detailMap, vMapUv * vec2( 2.0, 1.0 ) * tiling ).xyz;
        float da = det.x * detailF.x, db = det.y * detailF.y;
        float shade = mix( da, det.z * detailF.z, h );
        float t = h / rampBias;
        vec3 ramp = mix( mix( ramp3, ramp2, clamp( t, 0.0, 1.0 ) ), ramp1, clamp( t - 1.0, 0.0, 1.0 ) );
        vec3 g = max( mix( ramp * shade, maskColour, clamp( db, 0.0, 1.0 ) ), vec3( 0.0 ) );
        diffuseColor.rgb = mix( g / 12.92, pow( ( g + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, g ) );`), uniforms);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * An ice planet as iceplanet.fx colours it (its sm_hi pixel shader; constants by the effect file's table: MiscFactors
 * c1, Random c2, IceFactors c3, IceDetail c4, IceSpecular c5, IceRampColorLow c6, Middle c7, High c8):
 * - the height is NormalHeight1 x NormalHeight2 (moved by Random, as the rocky planets'), plus the ice detail:
 *   2 x IceDetail.x x (sqrt(fill(uv x IceDetail.y) x fill(uv x IceDetail.z)) - 0.5), the fill's first channel;
 * - t = saturate((h - (F.x - D.x)) / ((F.y + D.x) - (F.x - D.x))) / F.z ramps Low to Middle by saturate(t) and on to
 *   High by saturate(t - 1), times the ColorizeMap, a colour in gamma space taken to linear;
 * - lit as the shader lights it (scatterMaterial): its own wrapped diffuse (1 - (1 - saturate(N.L))^2) x (N.L + 1) / 2
 *   plus the ambient, a Blinn shine (IceSpecular: strength, power, fading out as the height rises from .w to .z)
 *   tinted by GroundScattering1, and GroundScattering2 added; the shader's pole blend of a second projection and its
 *   bump of the normal by the height maps are not ported.
 */
async function iceModel(c: Celestial, heightMap1: string, heightMap2: string | null, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [h1, h2, detail, colorize, s1, s2] = await Promise.all([
    texture(heightMap1),
    heightMap2 ? texture(heightMap2) : Promise.resolve(null),
    texture(c.textures.FillTexture!),
    c.textures.ColorizeMap ? texture(c.textures.ColorizeMap) : Promise.resolve(null),
    c.textures.GroundScattering1 ? texture(c.textures.GroundScattering1) : Promise.resolve(null),
    c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
  ]);
  for (const t of [h1, h2, detail]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const random = itemID === null ? 0 : itemID % 100;
  const mat = scatterMaterial(s1, s2, {
    h1: { value: h1 }, h2: { value: h2 ?? h1 }, detailMap: { value: detail }, colorizeMap: { value: colorize }, hasColorize: { value: colorize ? 1 : 0 },
    hasScatter: { value: s1 ? 1 : 0 },
    iceF: { value: v4(c.params.IceFactors, [-0.27, 1.53, 0.43, 1]) }, iceD: { value: v4(c.params.IceDetail, [0.8, 4, 2, 1]) },
    iceS: { value: v4(c.params.IceSpecular, [0.6, 12, 0.3, 0.1]) },
    low: { value: v3(c.params.IceRampColorLow, [0.1, 0.16, 0.2]) }, middle: { value: v3(c.params.IceRampColorMiddle, [0.94, 0.94, 0.94]) },
    high: { value: v3(c.params.IceRampColorHigh, [1, 1, 1]) },
    shiftA: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(random) }, shiftB: { value: new THREE.Vector2(0.1, 0.01).multiplyScalar(random) },
  }, `uniform sampler2D h1; uniform sampler2D h2; uniform sampler2D detailMap; uniform sampler2D colorizeMap; uniform float hasColorize; uniform float hasScatter;
      uniform vec4 iceF; uniform vec4 iceD; uniform vec4 iceS; uniform vec3 low; uniform vec3 middle; uniform vec3 high; uniform vec2 shiftA; uniform vec2 shiftB;`, `
        float a = texture2D(h1, vUv * vec2(2.0, 1.0) + shiftA).r;
        float b = texture2D(h2, vUv * vec2(3.0, 1.5) + shiftB + 1.0).r;
        float d1 = texture2D(detailMap, vUv * vec2(2.0, 1.0) * iceD.y).r;
        float d2 = texture2D(detailMap, vUv * vec2(2.0, 1.0) * iceD.z).r;
        float h = a * b + 2.0 * iceD.x * (sqrt(max(d1 * d2, 0.0)) - 0.5);
        float lo = iceF.x - iceD.x, hi = iceF.y + iceD.x;
        float t = clamp((h - lo) / (hi - lo), 0.0, 1.0) / iceF.z;
        vec3 albedo = mix(mix(low, middle, clamp(t, 0.0, 1.0)), high, clamp(t - 1.0, 0.0, 1.0));
        if (hasColorize > 0.5) albedo *= texture2D(colorizeMap, vUv).rgb;
        // its own wrapped diffuse, not the scattering: (1 - (1 - saturate(N.L))^2) x (N.L + 1) / 2, plus the ambient
        float wrapped = (1.0 - pow(1.0 - clamp(NL, 0.0, 1.0), 2.0)) * (NL + 1.0) * 0.5;
        // the shine: Blinn to the power IceSpecular.y, x IceSpecular.x, fading out as the height rises from .w to .z,
        // tinted by GroundScattering1
        float m = clamp((h - iceS.w) / (iceS.z - iceS.w), 0.0, 1.0);
        float shine = iceS.x * (1.0 - m * m * (3.0 - 2.0 * m)) * pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), iceS.y);
        g = albedo * (wrapped + ambient) + (hasScatter > 0.5 ? S1 : vec3(1.0)) * shine + S2;`);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A lava planet as lavaplanet.fx colours it (its sm_hi pixel shader, the constants named by the effect file's table:
 * LavaColor1 c3, LavaColor2 c4, Low c5, Mid c6, High c7, LavaSpecular c8, Parameters1 c9, Parameters2 c10,
 * AnimationFactors c11):
 * - the height (NormalHeight1 x NormalHeight2, moved by Random) plus Parameters1.x, as t = (h x P1.y - P1.z) / P1.w,
 *   shades the rock from Low to Mid to High, with the detail texture's second channel added;
 * - lava fills the lows: (1 - saturate((h x P1.y + 0.65) / 2)) x P2.x + saturate(1 - h x P1.y), clamped;
 * - it glows (2 x w) x LavaColor2 + (6 x w)^2 x LavaColor1 x noise, w the detail's fourth channel x DetailFactors.y;
 *   the shader's animated 3D noise (Lava3DNoiseMap, AnimationFactors) is held at its middle here;
 * - the rock is a gamma-space colour, taken to linear; the glow goes on as light of its own.
 */
async function lavaModel(c: Celestial, heightMap1: string, heightMap2: string | null, radius: number, itemID: number | null): Promise<THREE.Object3D> {
  const [h1, h2, detail, s1, s2] = await Promise.all([
    texture(heightMap1),
    heightMap2 ? texture(heightMap2) : Promise.resolve(null),
    texture(c.textures.FillTexture!),
    c.textures.GroundScattering1 ? texture(c.textures.GroundScattering1) : Promise.resolve(null),
    c.textures.GroundScattering2 ? texture(c.textures.GroundScattering2) : Promise.resolve(null),
  ]);
  for (const t of [h1, h2, detail]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const v4 = (v: number[] | undefined, d: number[]) => new THREE.Vector4(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2], v?.[3] ?? d[3]);
  const v3 = (v: number[] | undefined, d: number[]) => new THREE.Vector3(v?.[0] ?? d[0], v?.[1] ?? d[1], v?.[2] ?? d[2]);
  const random = itemID === null ? 0 : itemID % 100;
  const anim = v4(c.params.AnimationFactors, [0.6, 4, 0.8, 25]);
  const uniforms = {
    h1: { value: h1 }, heightMap2: { value: h2 ?? h1 }, detailMap: { value: detail }, hasScatter: { value: s1 ? 1 : 0 },
    lavaSpec: { value: v4(c.params.LavaSpecular, [0.6, 12, 0.3, 0.1]) },
    detailF: { value: v4(c.params.DetailFactors, [4, 0.3, 0, 0]) },
    p1: { value: v4(c.params.Parameters1, [0.1, 10, 1.4, 0.04]) }, p2: { value: v4(c.params.Parameters2, [2.5, 0, 0, 0]) },
    lava1: { value: v3(c.params.LavaColor1, [50, 20, 3.5]) }, lava2: { value: v3(c.params.LavaColor2, [24, 2.4, 0]) },
    low: { value: v3(c.params.Low, [0, 0, 0]) }, mid: { value: v3(c.params.Mid, [0.03, 0.025, 0.02]) }, high: { value: v3(c.params.High, [0.05, 0.05, 0.04]) },
    noise: { value: Math.pow(0.5, anim.z) * anim.w / 25 },
    shiftA: { value: new THREE.Vector2(0.01, 0.1).multiplyScalar(random) }, shiftB: { value: new THREE.Vector2(0.1, 0.01).multiplyScalar(random) },
  };
  const mat = scatterMaterial(s1, s2, uniforms, `uniform sampler2D h1; uniform sampler2D heightMap2; uniform sampler2D detailMap; uniform float hasScatter; uniform vec4 lavaSpec;
      uniform vec4 detailF; uniform vec4 p1; uniform vec4 p2;
      uniform vec3 lava1; uniform vec3 lava2; uniform vec3 low; uniform vec3 mid; uniform vec3 high; uniform float noise; uniform vec2 shiftA; uniform vec2 shiftB;`, `
        float h = texture2D(h1, vUv * vec2(2.0, 1.0) + shiftA).r * texture2D(heightMap2, vUv * vec2(3.0, 1.5) + shiftB + 1.0).r;
        vec4 d = ${detail ? "texture2D(detailMap, vUv * vec2(2.0, 1.0) * detailF.x)" : "vec4(0.5)"};
        float hp = h + p1.x;
        float t = (hp * p1.y - p1.z) / p1.w;
        vec3 rock = max(mix(mix(low, mid, clamp(t, 0.0, 1.0)), high, clamp(t - 1.0, 0.0, 1.0)) + d.y, vec3(0.0));
        float lava = clamp((1.0 - clamp((hp * p1.y + 0.65) * 0.5, 0.0, 1.0)) * p2.x + clamp(1.0 - hp * p1.y, 0.0, 1.0), 0.0, 1.0);
        float w = d.w * detailF.y;
        vec3 glow = (2.0 * w * lava2 + (6.0 * w) * (6.0 * w) * lava1 * noise) * lava;
        // the rock in the ambient only away from the lava, lit by GroundScattering1 as saturate((N.L - 5 lava) x rock);
        // the glow, GroundScattering2 and the shine (LavaSpecular: strength, power, a height band) added
        float nl = clamp(NL, 0.0, 1.0);
        vec3 S1c = hasScatter > 0.5 ? S1 : vec3(1.0);
        vec3 rockLit = rock * ambient * max(1.0 - 5.0 * lava, 0.0) + S1c * clamp((nl - 5.0 * lava) * rock, 0.0, 1.0);
        float band = clamp(h / max(0.1 * (lavaSpec.z - lavaSpec.w), 1e-4), 0.0, 1.0);
        float shine = lavaSpec.x * (1.0 - band * band * (3.0 - 2.0 * band)) * pow(clamp(dot(N, normalize(L + V)), 0.0, 1.0), max(lavaSpec.y, 1.0));
        g = glow + rockLit + S2 + shine * S1c;`);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/** A sun: its surface glowing in its colour ramp's middle colour, and a wide glow about it. */
async function sunModel(c: Celestial, radius: number): Promise<THREE.Object3D> {
  let colour = new THREE.Color(1, 0.9, 0.7);
  const rampUrl = c.textures.ColorRampMap;
  if (rampUrl) {
    try {
      const ramp = await loadDds(rampUrl) as unknown as THREE.DataTexture;
      const d = ramp.image?.data as Uint8Array | undefined;
      if (d && ramp.image.width) { const i = Math.floor(ramp.image.width * 0.6) * 4; colour = new THREE.Color(d[i]! / 255, d[i + 1]! / 255, d[i + 2]! / 255); }
    } catch { /* the default colour */ }
  }
  const group = new THREE.Group();
  group.name = "celestial";
  group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), new THREE.MeshBasicMaterial({ color: colour.clone().multiplyScalar(1.6) })));
  const c2 = document.createElement("canvas");
  c2.width = c2.height = 128;
  const g = c2.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.2, "rgba(255,255,255,0.5)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c2), color: colour, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(radius * 9);
  group.add(glow);
  return group;
}
