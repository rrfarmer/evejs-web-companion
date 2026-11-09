// Planets, moons and suns: a likeness of what the client draws from their object files (EvePlanet / EveSun and
// their procedural, compiled effects: SimpleMoon.fx, EarthlikePlanet.fx, GasGiant.fx, sunsurface.fx ...), made from
// the textures and constant parameters those files name (/client-assets/celestial/<typeID>, lib/celestial.mjs):
// the surface texture, tinted by the colour ramps where the file has them, lit by the sun, with a rim of light at
// the edge; a sun glows in its colour ramp's colour.

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

export async function celestialModel(typeID: number, kind: string, radius: number): Promise<THREE.Object3D | null> {
  const c = await celestialOf(typeID);
  if (!c) return null;
  if (kind === "sun") return sunModel(c, radius);
  const surfaceName = SURFACE.find((n) => c.textures[n] && !/black\.dds$/.test(c.textures[n]!));
  const surface = surfaceName ? await loadDds(c.textures[surfaceName]!).catch(() => null) : null;
  if (surface) surface.colorSpace = THREE.SRGBColorSpace;
  const tiling = c.params.DetailsTiling?.[0] ?? 1;
  if (surface && tiling > 1) surface.repeat.set(tiling, tiling);
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
