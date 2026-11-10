// Granny meshes -> plain arrays, ready for glTF.
//
// EVE ship vertices are Position (3 x Real32), Tangent (4 x NormalUInt8) and TextureCoordinates0
// (2 x Real16), sometimes with more texture coordinate sets, colours, or bones. A NormalUInt8 x 4
// "Tangent" with no Normal is CCP's packed tangent frame in its legacy form: four angles, remapped
// to 0..1. Decoded exactly as CCP's own cmf::UnpackTangentsLegacy (carbonengine mesh,
// src/cmf/tangents.cpp); the normal is the cross product of bitangent and tangent.

import { MEMBER } from "./granny.mjs";

const TAU = Math.PI * 2;

function normalized(type, v) {
  switch (type) {
    case MEMBER.NormalUInt8: return v / 255;
    case MEMBER.NormalUInt16: return v / 65535;
    case MEMBER.BinormalInt8: return Math.max(v / 127, -1);
    case MEMBER.BinormalInt16: return Math.max(v / 32767, -1);
    default: return v;
  }
}

/** cmf::UnpackTangentsLegacy, t in 0..1. Returns [normal, tangent, bitangent]. */
export function unpackTangentsLegacy(t0, t1, t2, t3) {
  const a0 = t0 * TAU - Math.PI, a1 = t1 * TAU - Math.PI, a2 = t2 * TAU - Math.PI, a3 = t3 * TAU - Math.PI;
  const s0x = Math.sin(a0), s0y = Math.cos(a0), s0z = Math.sin(a1), s0w = Math.cos(a1);
  const s1x = Math.sin(a2), s1y = Math.cos(a2), s1z = Math.sin(a3), s1w = Math.cos(a3);
  const T = [s0y * Math.abs(s0z), s0x * Math.abs(s0z), s0w];
  const B = [s1y * Math.abs(s1z), s1x * Math.abs(s1z), s1w];
  let N = [B[1] * T[2] - B[2] * T[1], B[2] * T[0] - B[0] * T[2], B[0] * T[1] - B[1] * T[0]];
  if (a3 > 0 && a1 > 0) N = [-N[0], -N[1], -N[2]];
  return [N, T, B];
}

/**
 * One Granny mesh as flat arrays: position, normal, tangent (xyz + handedness), uv0, uv1, indices,
 * and the triangle groups (one per material area).
 */
export function meshArrays(mesh) {
  const v = mesh.PrimaryVertexData?.Vertices;
  if (!v?.columns) throw new Error(`mesh ${mesh.Name}: no vertex columns`);
  const n = v.count;
  const col = v.columns;
  const get = (name) => col[name] ?? null;

  const pos = get("Position");
  if (!pos || pos.width !== 3) throw new Error(`mesh ${mesh.Name}: no 3-wide Position`);
  const position = Float32Array.from(pos.data);

  let normal = null, tangent = null;
  const packed = get("Tangent");
  const plainNormal = get("Normal");
  // a plain Normal column may be 3 or 4 wide (PlanetSphere's is 4 half floats): its xyz at its own stride
  const xyz = (c) => Float32Array.from({ length: n * 3 }, (_, j) => normalized(c.type, c.data[Math.floor(j / 3) * c.width + (j % 3)]));
  if (plainNormal) normal = xyz(plainNormal);
  const plainTangent = plainNormal && packed && packed.width >= 3 ? packed : null;
  const plainBinormal = get("Binormal");
  if (plainTangent) {
    // a plain tangent beside it (with a binormal): glTF's xyz + handedness
    const T = xyz(plainTangent), B = plainBinormal && plainBinormal.width >= 3 ? xyz(plainBinormal) : null;
    tangent = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const N = [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]], t = [T[i * 3], T[i * 3 + 1], T[i * 3 + 2]];
      const c = [N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]];
      const w = B && c[0] * B[i * 3] + c[1] * B[i * 3 + 1] + c[2] * B[i * 3 + 2] < 0 ? -1 : 1;
      tangent.set([t[0], t[1], t[2], w], i * 4);
    }
  }
  if (packed && packed.width === 4 && !plainNormal) {
    normal = new Float32Array(n * 3);
    tangent = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const t = [0, 1, 2, 3].map((k) => normalized(packed.type, packed.data[i * 4 + k]));
      const [N, T, B] = unpackTangentsLegacy(...t);
      const nl = Math.hypot(...N) || 1;
      normal.set([N[0] / nl, N[1] / nl, N[2] / nl], i * 3);
      // glTF handedness: bitangent = cross(normal, tangent.xyz) * w
      const c = [N[1] * T[2] - N[2] * T[1], N[2] * T[0] - N[0] * T[2], N[0] * T[1] - N[1] * T[0]];
      const w = c[0] * B[0] + c[1] * B[1] + c[2] * B[2] < 0 ? -1 : 1;
      tangent.set([T[0], T[1], T[2], w], i * 4);
    }
  }

  const uvOf = (name) => {
    const c = get(name);
    return c && c.width >= 2 ? Float32Array.from({ length: n * 2 }, (_, j) => c.data[(j >> 1) * c.width + (j & 1)]) : null;
  };

  const topo = mesh.PrimaryTopology;
  let indices;
  const i32 = topo.Indices?.columns && Object.values(topo.Indices.columns)[0];
  const i16 = topo.Indices16?.columns && Object.values(topo.Indices16.columns)[0];
  if (i32 && i32.data.length) indices = Uint32Array.from(i32.data, (x) => x >>> 0);
  else if (i16) indices = Uint32Array.from(i16.data, (x) => x & 0xffff);
  else throw new Error(`mesh ${mesh.Name}: no indices`);

  const g = topo.Groups?.columns;
  const groups = g ? Array.from({ length: topo.Groups.count }, (_, i) => ({
    material: g.MaterialIndex.data[i], first: g.TriFirst.data[i], count: g.TriCount.data[i],
  })) : [{ material: 0, first: 0, count: indices.length / 3 }];

  return {
    name: mesh.Name,
    vertexCount: n,
    position, normal, tangent,
    uv0: uvOf("TextureCoordinates0"), uv1: uvOf("TextureCoordinates1"),
    // the vertex colour (DiffuseColor0, 4 wide: a wreck's burn mask in its red, quadwreckv5's COLOR0), where it has one
    color0: (() => {
      const c = get("DiffuseColor0");
      return c && c.width === 4 ? Float32Array.from({ length: n * 4 }, (_, j) => normalized(c.type, c.data[j])) : null;
    })(),
    indices, groups,
    components: Object.fromEntries(Object.entries(col).map(([k, c]) => [k, `${c.width}x type ${c.type}`])),
    materials: (mesh.MaterialBindings ?? []).map((b) => b?.Material?.Name ?? null),
    extended: mesh.ExtendedData ?? null,
  };
}
