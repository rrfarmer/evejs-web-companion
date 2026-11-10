// A hull's decals as the Space Object Factory lays them (EveSOFDataHullDecalSet, the extractor's SOF build): each a
// box (position, rotation, scaling, in EVE's model space) through which some of the hull's own triangles - one index
// list per LOD, in the hull mesh's vertex order - are textured: the decal's UV is the vertex's place in the box, x and
// y from -1..1 to 0..1 (the decal shaders' vertex stage: two rows of the box's inverse). Drawn here:
// - glow decals (usage 5; decalglowv5.fx, disassembled, client 3396210): the transparency map's red times
//   DecalIntensityData.x, squared, is the decal's strength; the glow map is read where DecalTextureScaling moves it
//   (along each axis with a scaling: the fraction of time * scaling + DecalTextureOffset, the whole decal at once;
//   turned by scaling.z * time about the middle), its red squared to the power 1.2; DecalGlowColor times that times
//   the strength, added to the frame. The shader also multiplies by two per-object constants; taken as 1, the space
//   object's activationStrength (1.0 by default, and what the client's Python leaves a ship at outside cloaking and
//   scan holograms) and ccpwgl's Shipdata.y (1);
// - glow cylindrical decals (usage 4; decalglowcylindricv5.fx): the same glow wrapped round the box's z axis - u
//   the angle about it, (atan2(y, x) + pi) / 2 pi times DecalTextureScaling.w, v the place along it - the strength
//   the transparency times the intensity, not squared;
// - standard decals (usage 0; decalv5.fx): lit as the client lights them (standardMaterial).
// - cylindrical decals (usage 3; decalcylindricv5.fx): as the standard ones, their UV wrapped round the box's z axis
//   as the glow cylindrical decals' is.
// - logo decals (usage 6): standard decals in the faction's logo for their logoType (the extractor's SOF build gives
//   them the faction logo set's textures; a faction without that logo has no such decal, as EveSOF::SetupDecalSets).
// Not drawn: kill counters (they count the ship's displayKillCounterValue, 0 by default, so the client draws none
// either) and holes (wrecks).

import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";

export interface SofDecal {
  name: string | null; usage: number; meshIndex: number;
  position: number[]; rotation: number[]; scaling: number[];
  textures: Record<string, string | null>; parameters: Record<string, number[] | null>;
  glowColor: number[] | null; indexBuffers: number[][];
}
export interface SofDecalSet { name: string | null; items: SofDecal[] }

const USAGE_STANDARD = 0;
const USAGE_GLOW = 5;
const USAGE_GLOW_CYLINDRICAL = 4;
const USAGE_CYLINDRICAL = 3;
const USAGE_LOGO = 6;

const clock = { value: 0 };

const textures = new Map<string, Promise<THREE.Texture | null>>();
function texture(url: string | null | undefined, srgb = false): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const key = `${url}|${srgb}`;
  if (!textures.has(key)) {
    textures.set(key, loadDds(url).then((t) => {
      const tex = t as THREE.Texture;
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }).catch(() => null));
  }
  return textures.get(key)!;
}

/**
 * The decal's geometry on one LOD: the LOD's vertices (with the hull's own UV, which the hull's normal map is read
 * by), the decal's triangles (wound as the hull's) and the vertex's place in the box (attribute `decal`, -1..1 across
 * it), from which the shaders work out the decal's UV per pixel.
 */
function decalGeometry(source: THREE.BufferGeometry, indices: readonly number[], inverse: THREE.Matrix4): THREE.BufferGeometry | null {
  const position = source.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || indices.length < 3) return null;
  const n = position.count;
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "tangent", "uv"]) {
    const a = source.getAttribute(name);
    if (a) geometry.setAttribute(name, a);
  }
  const local = new Float32Array(n * 3);
  const p = new THREE.Vector3();
  const flipped = new Uint32Array(indices.length - (indices.length % 3));
  for (let t = 0; t < flipped.length; t += 3) {
    flipped[t] = indices[t]!; flipped[t + 1] = indices[t + 2]!; flipped[t + 2] = indices[t + 1]!;
  }
  for (const i of flipped) {
    if (i >= n) return null; // not this mesh's vertices
    // our vertices are mirrored in z; the box is in EVE's space
    p.set(position.getX(i), position.getY(i), -position.getZ(i)).applyMatrix4(inverse);
    local[i * 3] = p.x; local[i * 3 + 1] = p.y; local[i * 3 + 2] = p.z;
  }
  geometry.setAttribute("decal", new THREE.BufferAttribute(local, 3));
  geometry.setIndex(new THREE.BufferAttribute(flipped, 1));
  geometry.boundingSphere = source.boundingSphere;
  geometry.boundingBox = source.boundingBox;
  return geometry;
}

function vec4(v: number[] | null | undefined, d = 0): THREE.Vector4 {
  return new THREE.Vector4(v?.[0] ?? d, v?.[1] ?? d, v?.[2] ?? d, v?.[3] ?? d);
}

async function glowMaterial(d: SofDecal, cylindrical: boolean): Promise<THREE.Material | null> {
  const [transparency, glow] = await Promise.all([texture(d.textures["DecalTransparencyMap"]), texture(d.textures["DecalGlowMap"])]);
  if (!glow) return null;
  // the glow map repeats as it scrolls; the transparency map ends at the box (the triangles reach past it)
  glow.wrapS = glow.wrapT = THREE.RepeatWrapping; glow.needsUpdate = true;
  const c = d.glowColor ?? [1, 1, 1, 1];
  const material = new THREE.ShaderMaterial({
    uniforms: {
      transparency: { value: transparency }, glow: { value: glow }, hasTransparency: { value: transparency ? 1 : 0 },
      colour: { value: new THREE.Vector3(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1) },
      intensity: { value: d.parameters["DecalIntensityData"]?.[0] ?? 1 },
      scaling: { value: vec4(d.parameters["DecalTextureScaling"]) }, offset: { value: vec4(d.parameters["DecalTextureOffset"]) },
      time: clock,
    },
    vertexShader: `attribute vec3 decal; varying vec3 vDecal;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vDecal = decal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform sampler2D transparency, glow; uniform float hasTransparency, intensity, time; uniform vec3 colour; uniform vec4 scaling, offset; varying vec3 vDecal;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        ${cylindrical
          ? `vec2 vUv = vec2( ( atan( vDecal.y, vDecal.x ) + 3.141593 ) * scaling.w * 0.159155, vDecal.z * 0.5 + 0.5 );
        float strength = ( hasTransparency > 0.5 ? texture2D( transparency, vUv ).r : 1.0 ) * intensity;`
          : `vec2 vUv = vDecal.xy * 0.5 + 0.5;
        // the decal ends at its box (the triangles reach past it)
        if ( any( lessThan( vUv, vec2( 0.0 ) ) ) || any( greaterThan( vUv, vec2( 1.0 ) ) ) ) discard;
        float strength = ( hasTransparency > 0.5 ? texture2D( transparency, vUv ).r : 1.0 ) * intensity;
        strength *= strength;`}
        vec2 moved = vUv + sign( scaling.xy ) * ( fract( time * scaling.xy + offset.xy ) - vUv );
        float a = scaling.z * time;
        vec2 q = moved - 0.5;
        vec2 turned = vec2( cos( a ) * q.x - sin( a ) * q.y, sin( a ) * q.x + cos( a ) * q.y ) + 0.5;
        float g = texture2D( glow, turned ).r;
        g = pow( g * g, 1.2 );
        gl_FragColor = vec4( max( colour * g * strength, 0.0 ), 1.0 );
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  if (cylindrical && transparency) { transparency.wrapS = THREE.RepeatWrapping; transparency.needsUpdate = true; }
  return material;
}

/**
 * A standard or cylindrical decal lit as decalv5.fx lights it (its pixel stage disassembled): the hull's own normal
 * (the hull's normal map at the hull's UV, in the hull's tangent frame) tilted by the decal's normal map - its two
 * channels angles, 0.5 - the value, in radians - about the decal box's x and y axes; the albedo map the diffuse
 * colour, the fresnel map the specular colour at normal incidence (a specular workflow, as the hull's), 1 - the
 * roughness map the roughness; the transparency map's red its cover. Which channel turns about which axis, and their
 * signs, are read from the shader's order (y about the first axis); not checked against the client's picture.
 */
async function standardMaterial(d: SofDecal, hullMaterial: THREE.Material | null, cylindrical: boolean, axes: [THREE.Vector3, THREE.Vector3]): Promise<THREE.Material | null> {
  const [albedo, roughness, transparency, fresnel, tilt] = await Promise.all([
    texture(d.textures["DecalAlbedoMap"], true), texture(d.textures["DecalRoughnessMap"]), texture(d.textures["DecalTransparencyMap"]),
    texture(d.textures["DecalFresnelMap"]), texture(d.textures["DecalNormalMap"]),
  ]);
  if (!albedo || !transparency) return null;
  if (cylindrical) for (const t of [albedo, roughness, transparency, fresnel, tilt]) if (t) { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; }
  const base = hullMaterial as THREE.MeshStandardMaterial | null;
  const hullNormal = base?.normalMap ?? null;
  const m = new THREE.MeshStandardMaterial({
    map: albedo, roughnessMap: roughness, roughness: roughness ? 1 : 0.6, metalness: 0,
    normalMap: hullNormal, alphaMap: transparency, transparent: true, depthWrite: false,
    envMapIntensity: base?.envMapIntensity ?? 1,
  });
  const repeat = d.parameters["DecalTextureScaling"]?.[3] ?? 1;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      decalRepeat: { value: repeat }, decalFresnel: { value: fresnel }, decalTilt: { value: tilt },
      decalAxisA: { value: axes[0] }, decalAxisB: { value: axes[1] },
    });
    shader.vertexShader = "attribute vec3 decal;\nvarying vec3 vDecal;\nuniform vec3 decalAxisA, decalAxisB;\nvarying vec3 vAxisA, vAxisB;\n" + shader.vertexShader
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vDecal = decal;\n  vAxisA = normalize( normalMatrix * decalAxisA );\n  vAxisB = normalize( normalMatrix * decalAxisB );");
    // the decal's UV from the vertex's place in the box, per pixel: planar (x, y), or cylindrical about z
    // (decalcylindricv5: u the angle times DecalTextureScaling.w / 2 pi, v along z)
    const uv = cylindrical
      ? "vec2 decalUv = vec2( ( atan( vDecal.y, vDecal.x ) + 3.141593 ) * decalRepeat * 0.159155, vDecal.z * 0.5 + 0.5 );"
      : "vec2 decalUv = vDecal.xy * 0.5 + 0.5;\n  if ( any( lessThan( decalUv, vec2( 0.0 ) ) ) || any( greaterThan( decalUv, vec2( 1.0 ) ) ) ) discard;";
    const turn = "vec3 decalTurn( vec3 v, vec3 k, float a ) { return v * cos( a ) + cross( k, v ) * sin( a ) + k * dot( k, v ) * ( 1.0 - cos( a ) ); }";
    shader.fragmentShader = `varying vec3 vDecal; varying vec3 vAxisA, vAxisB;\nuniform float decalRepeat; uniform sampler2D decalFresnel, decalTilt;\n${turn}\n` + shader.fragmentShader
      .replace("void main() {", `void main() {\n  ${uv}`)
      .replace("#include <map_fragment>", "diffuseColor *= texture2D( map, decalUv );")
      .replace("#include <alphamap_fragment>", "diffuseColor.a *= texture2D( alphaMap, decalUv ).r;")
      .replace("#include <roughnessmap_fragment>", roughness
        ? "float roughnessFactor = roughness; roughnessFactor *= 1.0 - texture2D( roughnessMap, decalUv ).r;"
        : "float roughnessFactor = roughness;")
      .replace("#include <normal_fragment_maps>", `${hullNormal ? `
        // the hull's normal map as the hull reads it (BC5: x and y, z rebuilt, green flipped)
        vec3 mapN; mapN.xy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0; mapN.y = -mapN.y;
        mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );` : ""}
        ${tilt ? `vec2 decalAngles = 0.5 - texture2D( decalTilt, decalUv ).xy;
        normal = normalize( decalTurn( decalTurn( normal, vAxisA, decalAngles.y ), vAxisB, decalAngles.x ) );` : ""}`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        ${fresnel ? "material.specularColor = texture2D( decalFresnel, decalUv ).rgb; material.specularColorBlended = material.specularColor;" : ""}`);
  };
  m.customProgramCacheKey = () => `decal${roughness ? "r" : ""}${cylindrical ? "c" : ""}${hullNormal ? "n" : ""}${tilt ? "t" : ""}${fresnel ? "f" : ""}`;
  return m;
}

/** The decals added to each LOD node of a hull (each node's own index list), the glow ones animated. */
export async function addDecals(lodNodes: readonly THREE.Object3D[], sets: readonly SofDecalSet[]): Promise<number> {
  let added = 0;
  const items = sets.flatMap((s) => s.items).filter((d) => d.meshIndex === 0 && [USAGE_STANDARD, USAGE_CYLINDRICAL, USAGE_GLOW, USAGE_GLOW_CYLINDRICAL, USAGE_LOGO].includes(d.usage));
  for (const d of items) {
    const box = new THREE.Matrix4().compose(
      new THREE.Vector3(d.position[0] ?? 0, d.position[1] ?? 0, d.position[2] ?? 0),
      new THREE.Quaternion(d.rotation[0] ?? 0, d.rotation[1] ?? 0, d.rotation[2] ?? 0, d.rotation[3] ?? 1),
      new THREE.Vector3(d.scaling[0] ?? 1, d.scaling[1] ?? 1, d.scaling[2] ?? 1),
    );
    const inverse = box.clone().invert();
    // the box's x and y axes, turned as the box is, mirrored in z as our vertices are (the decal's normal tilts about them)
    const turnQ = new THREE.Quaternion(d.rotation[0] ?? 0, d.rotation[1] ?? 0, d.rotation[2] ?? 0, d.rotation[3] ?? 1);
    const axes: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)].map((a) => {
      a.applyQuaternion(turnQ); a.z = -a.z; return a;
    }) as [THREE.Vector3, THREE.Vector3];
    for (const [lod, node] of lodNodes.entries()) {
      const indices = d.indexBuffers[lod];
      if (!indices?.length) continue;
      let source: THREE.Mesh | null = null;
      node.traverse((o) => { if (!source && (o as THREE.Mesh).isMesh) source = o as THREE.Mesh; });
      if (!source) continue;
      const hull = source as THREE.Mesh;
      const geometry = decalGeometry(hull.geometry, indices, inverse);
      if (!geometry) continue;
      const material = d.usage === USAGE_STANDARD || d.usage === USAGE_CYLINDRICAL || d.usage === USAGE_LOGO
        ? await standardMaterial(d, hull.material as THREE.Material, d.usage === USAGE_CYLINDRICAL, axes)
        : await glowMaterial(d, d.usage === USAGE_GLOW_CYLINDRICAL);
      if (!material) continue;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `decal:${d.name ?? ""}`;
      mesh.renderOrder = 2;
      mesh.onBeforeRender = () => { clock.value = performance.now() / 1000; };
      // the decal sits where the hull mesh does inside the node
      mesh.position.copy(hull.position); mesh.quaternion.copy(hull.quaternion); mesh.scale.copy(hull.scale);
      (hull.parent ?? node).add(mesh);
      added++;
    }
  }
  return added;
}
