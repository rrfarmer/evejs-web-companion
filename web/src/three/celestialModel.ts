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

export async function celestialModel(typeID: number, kind: string, radius: number, item: CelestialItem | null = null): Promise<THREE.Object3D | null> {
  const c = (item?.celestial ? await celestialAt(item.celestial) : null) ?? await celestialOf(typeID);
  if (!c) return null;
  if (kind === "sun") return sunModel(c, radius);
  if (item?.NormalHeight1 && isGasGiant(c)) return gasGiantModel(c, item.NormalHeight1, radius);
  if (item?.NormalHeight1 && c.params.FillTint && c.textures.FillTexture) return rockyModel(c, item.NormalHeight1, radius);
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

/** A gas giant: its own colour map (NormalHeight1, an equirectangular gasgiantNN_d.dds) as its surface. */
async function gasGiantModel(c: Celestial, colourMap: string, radius: number): Promise<THREE.Object3D> {
  const surface = await texture(colourMap, true);
  const mat = new THREE.MeshStandardMaterial({ map: surface, color: surface ? 0xffffff : 0x9a8f7a, roughness: 0.95, metalness: 0, envMapIntensity: PLANET_AMBIENT });
  // The preset's Saturation (gasgiant.fx, 4.7 for Jita IV) is not used: a lerp from the luminance by it is far too
  // strong, so the shader means something else by it; its compiled effect is to be read before it is.
  withRim(mat, col(c.params.AtmosphereColor ?? c.params.CapColor, [0.55, 0.6, 0.7]));
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), mat);
  m.name = "celestial";
  return m;
}

/**
 * A rocky planet whose preset gives tints: its height (NormalHeight1) shades from FillTint in the lows to
 * mountainTint on the heights, the preset's detail texture (FillTexture, tiled by DetailFactors.x) gives the grain,
 * and its clouds (CloudsTexture, a mask) lie over it in CloudsColor where that is not black.
 */
async function rockyModel(c: Celestial, heightMap: string, radius: number): Promise<THREE.Object3D> {
  const [height, detail, clouds] = await Promise.all([
    texture(heightMap),
    texture(c.textures.FillTexture!),
    c.textures.CloudsTexture && (c.params.CloudsColor?.slice(0, 3).some((x) => x > 0.01) ?? false) ? texture(c.textures.CloudsTexture) : Promise.resolve(null),
  ]);
  const tiling = c.params.DetailFactors?.[0] ?? 4;
  for (const t of [detail, clouds]) if (t && t.wrapS !== THREE.RepeatWrapping) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
  const mat = new THREE.MeshStandardMaterial({ map: height, color: 0xffffff, roughness: 0.92, metalness: 0, envMapIntensity: PLANET_AMBIENT });
  const uniforms = {
    fillTint: { value: col(c.params.FillTint, [0.5, 0.45, 0.4]) },
    mountainTint: { value: col(c.params.mountainTint, [0.6, 0.58, 0.55]) },
    cloudsColour: { value: col(c.params.CloudsColor, [0, 0, 0]) },
    detailMap: { value: detail }, cloudsMap: { value: clouds }, tiling: { value: tiling },
  };
  withRim(mat, col(c.params.AtmosphereColor, [0.45, 0.6, 0.85]), (fs) => `uniform vec3 fillTint; uniform vec3 mountainTint; uniform vec3 cloudsColour; uniform sampler2D detailMap; uniform sampler2D cloudsMap; uniform float tiling;
${fs}`.replace("#include <map_fragment>", `#include <map_fragment>
        float h = clamp( diffuseColor.r, 0.0, 1.0 );
        float grain = ${detail ? "texture2D( detailMap, vMapUv * tiling ).r" : "0.5"};
        vec3 ground = mix( fillTint, mountainTint, smoothstep( 0.35, 0.8, h ) ) * ( 0.55 + 0.9 * grain );
        ${clouds ? "ground = mix( ground, cloudsColour, clamp( texture2D( cloudsMap, vMapUv * vec2( 2.0, 1.0 ) ).r, 0.0, 1.0 ) * 0.8 );" : ""}
        diffuseColor.rgb = ground;`), uniforms);
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
