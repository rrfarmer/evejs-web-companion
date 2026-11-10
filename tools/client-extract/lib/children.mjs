// A hull's children (EveSOFDataHull.children: EveSOFDataHullChild { redFilePath, groupIndex }), as the client's EveSOF
// loads each one's object file (the .red, shipped as .black) and hangs it under the ship: a graph of EveChild*
// objects (containers, quads, meshes, line sets, particle systems, lights), curve sets, controllers and state
// machines. This reads the part drawn so far, the static one:
//
// - EveChildContainer: its transform (useSRT, the client's default: translation, rotation, scaling), display, its
//   displayFilter (trinity.DisplayModifierChooser: Low 0, Low_and_Medium 1, Medium 2, Medium_and_High 3, High 4,
//   None_ 5, the default; kept at high quality: 3, 4, 5), its objects and transform modifiers;
// - EveChildQuad: transform, color, brightness, minScreenSize and its effect (flarequad.fx, flarequadsoft.fx).
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
      modifiers: (o.transformModifiers ?? []).map((t) => t.type),
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
