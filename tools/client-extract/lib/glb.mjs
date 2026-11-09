// Minimal glTF 2.0 binary (.glb) writer for meshes from mesh.mjs.
//
// EVE's model space is left-handed (y up, z forward); glTF is right-handed. The writer mirrors z
// (positions, normals, tangents), flips tangent handedness, and reverses triangle winding, so the
// model is the right way round in any glTF viewer. Anything placed by Destiny coordinates needs the
// same z mirror (see docs/threejs-play-plan.md).

const FLOAT = 5126, UINT16 = 5123, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

export function writeGlb({ name, lods, extras = {} }) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [];

  function addView(typed, target) {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, ...(target ? { target } : {}) });
    byteLength += bytes.length;
    return bufferViews.length - 1;
  }
  function addAccessor(typed, componentType, type, count, target, withBounds = false) {
    const acc = { bufferView: addView(typed, target), componentType, count, type };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) {
        const v = typed[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      Object.assign(acc, { min, max });
    }
    accessors.push(acc);
    return accessors.length - 1;
  }

  // One material per mesh area: its name, and its index, which is the SOF hull area's (EveSOFDataHullArea.index).
  const materials = [], materialIndex = new Map();
  const materialFor = (areaName, index) => {
    const key = `${index}|${areaName}`;
    if (!materialIndex.has(key)) {
      materials.push({ name: areaName, extras: { area: areaName, index } });
      materialIndex.set(key, materials.length - 1);
    }
    return materialIndex.get(key);
  };

  const meshes = [], nodes = [];
  for (const [lodIndex, m] of lods.entries()) {
    const n = m.vertexCount;
    const pos = new Float32Array(m.position);
    for (let i = 0; i < n; i++) pos[i * 3 + 2] = -pos[i * 3 + 2];
    const attributes = { POSITION: addAccessor(pos, FLOAT, "VEC3", n, ARRAY_BUFFER, true) };
    if (m.normal) {
      const nor = new Float32Array(m.normal);
      for (let i = 0; i < n; i++) nor[i * 3 + 2] = -nor[i * 3 + 2];
      attributes.NORMAL = addAccessor(nor, FLOAT, "VEC3", n, ARRAY_BUFFER);
    }
    if (m.tangent) {
      const tan = new Float32Array(m.tangent);
      for (let i = 0; i < n; i++) { tan[i * 4 + 2] = -tan[i * 4 + 2]; tan[i * 4 + 3] = -tan[i * 4 + 3]; }
      attributes.TANGENT = addAccessor(tan, FLOAT, "VEC4", n, ARRAY_BUFFER);
    }
    if (m.uv0) attributes.TEXCOORD_0 = addAccessor(m.uv0, FLOAT, "VEC2", n, ARRAY_BUFFER);
    if (m.uv1) attributes.TEXCOORD_1 = addAccessor(m.uv1, FLOAT, "VEC2", n, ARRAY_BUFFER);

    const primitives = m.groups.filter((g) => g.count > 0).map((g) => {
      const tri = m.indices.subarray(g.first * 3, (g.first + g.count) * 3);
      const big = n > 0xffff;
      const idx = big ? new Uint32Array(tri.length) : new Uint16Array(tri.length);
      for (let t = 0; t < tri.length; t += 3) { idx[t] = tri[t]; idx[t + 1] = tri[t + 2]; idx[t + 2] = tri[t + 1]; }
      const area = m.materials[g.material] ?? `area${g.material}`;
      return { attributes, indices: addAccessor(idx, big ? UINT32 : UINT16, "SCALAR", idx.length, ELEMENT_ARRAY_BUFFER), material: materialFor(area, g.material) };
    });
    meshes.push({ name: m.name, primitives, extras: { lod: lodIndex, maxScreenSize: m.extended?.maxScreenSize ?? null } });
    nodes.push({ name: m.name, mesh: meshes.length - 1, extras: { lod: lodIndex } });
  }

  const json = {
    asset: { version: "2.0", generator: "evejs-web-poc client-extract" },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, children: nodes.map((_, i) => i + 1), extras }, ...nodes],
    meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength }],
  };

  const bin = new Uint8Array(byteLength);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([Buffer.from(bin), Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
}
