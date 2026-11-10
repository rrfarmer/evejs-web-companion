// A hull's children (EveSOFDataHull.children: EveSOFDataHullChild { redFilePath, groupIndex }), as the client's EveSOF
// loads each one's object file (the .red, shipped as .black) and hangs it under the ship: a graph of EveChild*
// objects (containers, quads, meshes, line sets, particle systems, lights), curve sets, controllers and state
// machines. This reads the part drawn so far, the static one:
//
// - EveChildContainer: its transform (useSRT, the client's default: translation, rotation, scaling), display, its
//   displayFilter (trinity.DisplayModifierChooser: Low 0, Low_and_Medium 1, Medium 2, Medium_and_High 3, High 4,
//   None_ 5, the default; kept at high quality: 3, 4, 5), its objects and transform modifiers;
// - EveChildQuad: transform, color, brightness, minScreenSize and its effect (flarequad.fx, flarequadsoft.fx);
// - EveChildMesh on a Tr2InstancedMesh drawn with traffic.fx (a station's traffic): its transform, the instance
//   geometry's file, the effect's constants and its textures (PositionMap, TexMap); the instances themselves are
//   read by the caller (readTrafficInstances), the reader being asynchronous;
// - EveChildMesh on a Tr2Mesh: its transform, geometry file (the caller extracts it), mesh index and the areas drawn
//   with ubershader.fx or fx3dv5.fx (kind, index, count, the effect's options, constants and textures); its other
//   areas counted.
//
// The rest is counted, not read (meshes, line sets, particle systems, point lights, curve sets, state machines).
// A child with a groupIndex is built for some factions or skins only; those are left out (a child without one is
// built for every faction).

import { readBlack } from "./black.mjs";

const HIGH_QUALITY = new Set([3, 4, 5]);

const srt = (o) => {
  const t = o.translation ?? [0, 0, 0], r = o.rotation ?? [0, 0, 0, 1], s = o.scaling ?? [1, 1, 1];
  // the column-major matrix of T x R x S, as THREE.Matrix4.compose makes it
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
};
const identity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
/** An effect's constants by name: its constParameters (name, value rows) and its Tr2Vector4Parameter / Tr2FloatParameter list. */
function effectParams(fx) {
  const out = {};
  for (const row of fx?.constParameters?.items ?? []) if (Array.isArray(row) && typeof row[0] === "string") out[row[0]] = row[1];
  for (const p of fx?.parameters ?? []) if (p?.name) out[p.name] = p.value ?? null;
  return out;
}
const effectTextures = (fx) => Object.fromEntries((fx?.resources ?? []).filter((r) => r?.name && r.resourcePath).map((r) => [r.name, String(r.resourcePath).toLowerCase()]));
/** An EveChildModifierSRT's own transform (its translation, rotation and scaling; the defaults where unsaid), or null. */
const srtOf = (mods) => {
  const m = (mods ?? []).find((t) => t?.type === "EveChildModifierSRT");
  return m ? { translation: m.translation ?? [0, 0, 0], rotation: m.rotation ?? [0, 0, 0, 1], scaling: m.scaling ?? [1, 1, 1] } : null;
};
const effectName = (fx) => (fx?.effectFilePath ? String(fx.effectFilePath).split("/").pop().replace(/\.fx$/i, "").toLowerCase() : null);

/** One EveChild* object as the page draws it, or null where nothing of it is drawn; `skipped` counts the rest by type. */
function readNode(o, skipped) {
  if (!o || typeof o !== "object") return null;
  if (o.display === false) return null;
  if (o.type === "EveChildQuad") {
    return {
      k: "quad", name: o.name ?? null, m: srt(o), color: o.color ?? [1, 1, 1, 1], brightness: o.brightness ?? 1,
      minScreenSize: o.minScreenSize ?? 0, effect: effectName(o.effect),
    };
  }
  if (o.type === "EveChildMesh" && o.mesh?.type === "Tr2InstancedMesh") {
    const area = [...(o.mesh.additiveAreas ?? []), ...(o.mesh.transparentAreas ?? []), ...(o.mesh.opaqueAreas ?? [])][0];
    if (effectName(area?.effect) === "traffic" && o.mesh.instanceGeometryResPath) {
      return {
        k: "traffic", name: o.name ?? null, m: srt(o), instances: String(o.mesh.instanceGeometryResPath).toLowerCase(),
        params: effectParams(area.effect), textures: effectTextures(area.effect),
      };
    }
  }
  if (o.type === "EveChildMesh" && o.mesh?.type === "Tr2Mesh" && o.mesh.geometryResPath) {
    const areas = [];
    for (const [list, kind] of [["opaqueAreas", "opaque"], ["transparentAreas", "transparent"], ["additiveAreas", "additive"]]) {
      for (const a of o.mesh[list] ?? []) {
        const fx = effectName(a.effect);
        if (fx !== "ubershader" && fx !== "fx3dv5") { skipped[`area:${fx}`] = (skipped[`area:${fx}`] ?? 0) + 1; continue; }
        areas.push({
          kind, name: a.name ?? null, index: a.index ?? 0, count: a.count ?? 1, effect: fx,
          options: Object.fromEntries((a.effect.options?.items ?? []).filter((r) => Array.isArray(r))),
          params: effectParams(a.effect), textures: effectTextures(a.effect),
        });
      }
    }
    if (!areas.length) return null;
    return {
      k: "mesh", name: o.name ?? null, m: srt(o), geometry: String(o.mesh.geometryResPath).toLowerCase(),
      meshIndex: o.mesh.meshIndex ?? 0, minScreenSize: o.minScreenSize ?? 0, areas,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
    };
  }
  if (o.type === "EveChildContainer") {
    if (!HIGH_QUALITY.has(o.displayFilter ?? 5)) return null;
    const objects = (o.objects ?? []).map((c) => readNode(c, skipped)).filter(Boolean);
    for (const l of o.lights ?? []) skipped[l.type] = (skipped[l.type] ?? 0) + 1;
    if (o.curveSets?.length) skipped.TriCurveSet = (skipped.TriCurveSet ?? 0) + o.curveSets.length;
    if (o.controllers?.length) skipped.Tr2Controller = (skipped.Tr2Controller ?? 0) + o.controllers.length;
    if (!objects.length) return null;
    const m = srt(o);
    return {
      k: "container", name: o.name ?? null, m: identity(m) ? null : m,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
      objects,
    };
  }
  skipped[o.type ?? "?"] = (skipped[o.type ?? "?"] ?? 0) + 1;
  return null;
}

/**
 * The hull's children built for every faction (no groupIndex), each { res, root, skipped }: the object file, its
 * drawn graph (readNode), and what of it is not drawn yet, by type. A file the client does not ship is left out.
 */
export function readHullChildren(rf, sofHull) {
  const out = [];
  for (const child of sofHull?.children ?? []) {
    if (child.groupIndex !== undefined && child.groupIndex !== null) continue;
    const res = String(child.redFilePath ?? "").toLowerCase().replace(/\.red$/, ".black");
    if (!res || !rf.has(res)) continue;
    const skipped = {};
    let root = null;
    try {
      root = readNode(readBlack(rf.read(res), res), skipped);
    } catch (e) {
      skipped.unread = String(e.message ?? e);
    }
    out.push({ res, root, skipped });
  }
  return out;
}

/**
 * A traffic mesh's instances (its instance geometry: Position xyzw, TextureCoordinates0 xyzw; traffic.fx's POSITION8
 * and TEXCOORD8): one row of eight numbers each - the offset (x, y, z) and the path (w); the size, the speed (its sign
 * the way along the path), the colour's mix and the phase.
 */
export async function readTrafficInstances(rf, res) {
  const { readGranny } = await import("./granny.mjs");
  const g = await readGranny(rf.read(res), res);
  const cols = g.root?.Meshes?.[0]?.PrimaryVertexData?.Vertices?.columns ?? {};
  const a = cols.Position, b = cols.TextureCoordinates0;
  if (!a || !b || a.width !== 4 || b.width !== 4) throw new Error(`${res}: not a traffic instance buffer`);
  const n = a.data.length / 4;
  const out = new Array(n * 8);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 8 + j] = Math.round(a.data[i * 4 + j] * 1e4) / 1e4;
      out[i * 8 + 4 + j] = Math.round(b.data[i * 4 + j] * 1e4) / 1e4;
    }
  }
  return out;
}
